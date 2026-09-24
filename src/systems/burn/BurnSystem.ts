/**
 * 燃烧系统（2026-09-16）：可燃物**实例**的燃烧状态、存读档、离场照推、条件叶、叙事信号，以及表现
 * （燃烧着色、火苗粒子、火光、火焰段、纸钱引燃可燃物）。
 *
 * 玩法口径 `docs/玩法功能需求清单.md` A3.8；机制 agent_docs [[burn-system]]。模拟本体在 `burnSim.ts`（纯函数、确定性）。
 *
 * ## 可燃物是模板，宿主引用它 = 实例化一次
 * 模板（`assets/data/burnables/<id>.json`）是一份完整的表现（图 / 真实尺寸 / 握点 / 燃料 / 着火点 / 烧法 / 粒子 / 火光），和场景无关。
 * 宿主身上写 `burnable: {template, …}`：
 * - **场景实例**（热点 / NPC / 演出生成留下的对象）：key = 实体 id，每个场景一份记录 + 一份模拟。
 *   宿主挪了 = 一条"挪位"外部事件（世界映射表里追加一份）；演出生成 / 收掉 = "出现" / "收掉"事件——所以会动的东西照样逐位重放、离场照推。
 * - **手上的挂件**（HeldPropSystem 挂着的、预设开了可燃）：key = 「人|挂点」，跟着人跨场景走、没法重放，
 *   单独一份模拟（每帧按挂件此刻的摆放更新世界位置）、存快照；收起来 = 熄灭 + 记进"包里那根"。
 *   手上的可燃挂件**不会**自己碰着场景里的可燃物、也不被它们碰着（与火把同一条规矩，只走按 E 的表演）；会引燃纸钱。
 *
 * ## 三层
 * - **记录**（进档）：场景记录——每个实例的外部事件日志、指纹、世界映射表；纸钱烧没了哪几张；风钟映射。手上 / 包里——快照。
 * - **模拟**（不进档）：由记录重放出来。**离场之后留在内存里继续推**（事件驱动，便宜），条件叶与信号始终是当前的。
 * - **表现**（当前场景 + 手上的）：`BurnRenderer`（热点挂滤镜 / NPC 与挂件换纹理）、粒子临时实例、火光、火焰段。
 *
 * ## 推不出来 ⇒ 烧完
 * 指纹（模板清洗后 + 燃料网格）变了而有过去、场景风变了而有外部事件、有过去的实例连模板都装不到了、离场重建时缺世界映射而火还在走
 * ⇒ 推不出来。可燃物之间互相引燃，所以**整场有过去的一起收束**：此刻烧着 / 灭了 / 烧完的切"烧完"，此刻没点的清成干净。
 * 宿主挪了位置、演出生成 / 收掉**不再**算推不出来（它们是事件）。
 *
 * ## 日志只增不删
 * 复原也不截断：复原之前那一段点着过别的可燃物，重放别人要用到。
 */
import type { Container } from 'pixi.js';
import {
  burnableWorldSize,
  resolveBurnable,
  resolveBurnableHost,
  type BurnableHostDef,
  type BurnState,
  type ResolvedBurnable,
  BURN_DEFAULTS,
  BURN_WU_PER_CM,
  BURN_WU_PER_M,
} from '../../data/burnables';
import type { ConditionExpr, GameContext, IGameSystem, LightDef, SceneData, VfxFireSegment } from '../../data/types';
import { burnableJsonUrl } from '../../core/projectPaths';
import type { EventBus } from '../../core/EventBus';
import type { BurnRenderer, BurnRenderHost } from '../../rendering/burn/BurnRenderer';
import { burnShadeParamsOf } from '../../rendering/burn/burnShadeParams';
import { resolveSceneWind, sampleSceneWind, type SceneWindParams } from '../../utils/sceneWind';
import { evaluateConditionExpr, type ConditionEvalContext } from '../graphDialogue/evaluateGraphCondition';
import type { VfxBurningPlateReport } from '../vfx/VfxSystem';
import {
  buildBurnWorldGrid,
  burnSceneToUvAffine,
  burnUvToScene,
  burnWorldAt,
  burnWorldGridFromJson,
  burnWorldGridToJson,
  burnWorldGridsClose,
  type BurnFrame,
  type BurnSpaceLike,
  type BurnWorldGrid,
} from './burnGeometry';
import { burnFuelCenterUv, burnIgniteAim } from './burnAim';
import { BurnLightRig, type BurnLightSource } from './burnLights';
import {
  BURN_SAVE_VERSION,
  burnHash,
  burnHeldKey,
  emptySceneRecordData,
  heldRecordFromJson,
  heldRecordToJson,
  sceneRecordFromJson,
  sceneRecordToJson,
  windTimeFromVisits,
  type BurnHeldRecord,
  type BurnItemRecord,
  type BurnSaveJson,
  type BurnSceneRecordData,
} from './burnPersistence';
import {
  BurnSceneSim,
  buildBurnGrid,
  createBurnCellQuery,
  type BurnCellQuery,
  type BurnExternalEvent,
  type BurnGrid,
  type BurnImageData,
  type BurnItemInput,
  type BurnSceneEnv,
} from './burnSim';

/** 当前场景里一个开了可燃的实体（活的；Game 从 SceneManager 取） */
export interface BurnEntityHost {
  readonly id: string;
  readonly kind: 'hotspot' | 'npc';
  /** 宿主身上的 `burnable` 块（原样；本系统清洗） */
  readonly burnable: unknown;
  /**
   * 模板图此刻在画面上的摆放（`size` = 模板真实尺寸换算的 wu）；实体还没摆好 ⇒ null。
   * 热点按定义算（`burnEntityPlacement`，与燃烧工作台同口径）；NPC 量它本体精灵（含轨迹叠加的旋转 / 缩放）。
   */
  frame(size: { width: number; height: number }): BurnFrame | null;
  /** 在场可见、可交互（被条件 / 会话隐藏时 false：玩家点不了、引不了火；模拟照跑） */
  readonly active: boolean;
  readonly render: BurnRenderHost;
  /** 实体层节点（火苗粒子钉在它身前排序） */
  readonly container: Container;
}

/** 某人手上一件开了可燃的挂件（活的） */
export interface BurnHeldHost {
  readonly target: string;
  readonly socket: string;
  readonly prop: string;
  readonly burnable: unknown;
  /** 挂件图此刻在画面上的摆放（三个角 + 拿着它的人的接地点）；这一帧没标挂点 / 图没到 ⇒ null */
  frame(): BurnFrame | null;
  readonly render: BurnRenderHost;
  readonly container: Container;
}

/** 某场景里开了可燃的实体（定义层：离场重建、问别的场景的条件叶） */
export interface BurnSceneEntityInfo {
  id: string;
  burnable: unknown;
}

/** 燃烧系统用到的粒子系统能力（Game 注入，系统之间不互持实例） */
export interface BurnVfxPort {
  playVfx(opts: { effect: string; followWorld: [number, number, number]; seed?: number }): string | null;
  stopVfxSoft(id: string): void;
  moveInstanceAnchor(id: string, world: [number, number, number]): boolean;
  setInstanceSpawnPoints(id: string, pts: Float32Array, count: number): void;
  setInstanceRateScale(id: string, k: number): void;
  setInstanceSortHost(id: string, host: (() => { node: Container; front: boolean } | null) | null): void;
  setFireSources(owner: string, segments: readonly VfxFireSegment[]): void;
  burningPlates(): VfxBurningPlateReport[];
  burningPlateSlots(): { instanceId: string; emitterIndex: number; slots: number[] }[];
}

export interface BurnSystemDeps {
  loadJson: <T>(url: string) => Promise<T>;
  dropJson: (url: string) => void;
  /** 读一张图的 RGBA（燃料 = alpha；涂层 data URL 也走它）。读不到 = null */
  loadImageData: (url: string) => Promise<BurnImageData | null>;
  getSceneData: () => SceneData | null;
  /** 装别的场景的数据（读档后后台重建离场中还在烧的场景 / 问别的场景的条件叶） */
  loadSceneData: (sceneId: string) => Promise<SceneData | null>;
  /** 某场景里开了可燃的实体（场景 JSON 的热点 / NPC + 这个场景记着的演出生成留下的对象） */
  sceneBurnables: (sceneId: string, scene: SceneData) => BurnSceneEntityInfo[];
  /** 当前场景此刻在场、开了可燃的实体 */
  liveEntities: () => readonly BurnEntityHost[];
  /** 此刻挂着的、开了可燃的挂件（所有人） */
  liveHeld: () => readonly BurnHeldHost[];
  /** 当前场景的粒子空间（格点世界位置、火光要真 3D 场） */
  getSpace: () => (BurnSpaceLike & { kind: 'field' | 'planar' }) | null;
  /** 场景几何定了没有（真 3D 场到了，或这个场景本来就没有几何可等） */
  isSpaceFinal: () => boolean;
  /** 场景风的钟（`SceneWindState.time`） */
  windClock: () => number;
  conditionContext: () => ConditionEvalContext;
  vfx: BurnVfxPort;
  setDynamicLights: (lights: LightDef[]) => void;
  /** 发叙事信号（走 `emitNarrativeSignal` 动作；owner = 场景实体 id / 拿着挂件的人） */
  emitSignal: (signal: string, ownerId: string) => void;
  log: (msg: string) => void;
}

/** 建好的一个场景实例（模板 + 燃料网格 + 指纹）；`host` = null 是"幽灵"（宿主不在了、为了重放别人留着） */
interface ItemBuild {
  key: string;
  host: BurnableHostDef | null;
  burnable: ResolvedBurnable;
  grid: BurnGrid;
  fp: string;
}

interface SceneRecord extends BurnSceneRecordData {
  sceneId: string;
  sim: BurnSceneSim | null;
  /** 模拟由哪一批指纹建出来（key → 指纹）；进场时与这一次的比对决定能不能接着用 */
  simFps: Map<string, string>;
  builds: Map<string, ItemBuild>;
  /** 这一次激活时的记录状态（首次就绪时静默重放到"现在"，再与它比出离开期间推导出的变化） */
  pendingSync: Map<string, BurnState> | null;
  /** 活场景：这一次进场（或重建）之后，在场实体的世界映射都补过了 */
  worldsFilled: boolean;
  /** 活场景：开始等世界映射的燃烧钟（等太久就不等了，见 `WORLD_FILL_TIMEOUT_S`） */
  fillSince: number;
}

/** 手上一件可燃挂件 */
interface HeldInstance {
  key: string;
  target: string;
  socket: string;
  prop: string;
  host: BurnableHostDef;
  burnable: ResolvedBurnable;
  grid: BurnGrid;
  fp: string;
  sim: BurnSceneSim;
  state: BurnState;
  liveGrid: BurnWorldGrid | null;
  hostRef: BurnHeldHost | null;
}

/** 一个实例在这一帧怎么画（场景的 / 手上的统一走一条表现路径） */
interface PresentItem {
  vkey: string;
  key: string;
  sim: BurnSceneSim;
  b: ResolvedBurnable;
  grid: BurnGrid;
  render: BurnRenderHost | null;
  container: Container | null;
  frame: BurnFrame | null;
  liveGrid: BurnWorldGrid | null;
  ownsFireToPlates: boolean;
}

const QUERY_POINTS_MAX = 128;
/** 纸钱点着可燃物：同一个可燃物两次外部点火事件至少隔这么久（燃着的纸贴着它时每帧都在碰） */
const PLATE_CONTACT_COOLDOWN_S = 0.25;
/** 可燃物火线聚成火焰段：每块多少格 */
const FIRE_BLOCK = 4;
/** 宿主挪了多少才算挪（wu，世界映射逐点比） */
const MOVE_EPS_WU = 0.5;
/** 挪位事件最密多久一条（秒）：一路走着的 NPC 不至于每帧一条 */
const MOVE_MIN_INTERVAL_S = 0.1;
/** 进场后等在场实体摆好（算世界映射）最多等多久（秒）：宿主一直给不出摆放就不等了，免得整场卡住 */
const WORLD_FILL_TIMEOUT_S = 2;

export class BurnSystem implements IGameSystem {
  private eventBus: EventBus | null = null;
  private renderer: BurnRenderer | null = null;
  private clock = 0;
  private readonly scenes = new Map<string, SceneRecord>();
  private readonly burnableCache = new Map<string, Promise<ResolvedBurnable | null>>();
  private readonly imageCache = new Map<string, Promise<BurnImageData | null>>();
  /** DEV 燃烧工作台联动：模板工作态覆盖 */
  private readonly previewBurnables = new Map<string, ResolvedBurnable>();
  /** 各场景开了可燃的实体（定义层缓存：条件叶问别的场景时用） */
  private readonly sceneInfos = new Map<string, BurnSceneEntityInfo[]>();
  private readonly sceneInfoLoading = new Set<string>();
  /** 当前场景 */
  private liveSceneId: string | null = null;
  private liveSig = '';
  private liveRebuilding = false;
  private readonly liveGrids = new Map<string, BurnWorldGrid>();
  private readonly placementSigs = new Map<string, string>();
  private readonly lastMoveAt = new Map<string, number>();
  private lastSpace: object | null = null;
  /** 当前场景 / 手上：粒子临时实例（表现 key → 槽位 → 粒子实例 id） */
  private readonly liveParticles = new Map<string, Map<number, string>>();
  private readonly plateFires = new Map<string, string>();
  private readonly plateContactAt = new Map<string, number>();
  private readonly lightRig = new BurnLightRig();
  private lightsPushedNonEmpty = false;
  /** 手上的 / 挂件换下来暂存的（切场景重挂接着烧）/ 包里的 */
  private readonly held = new Map<string, HeldInstance>();
  private readonly heldLoading = new Map<string, string>();
  private readonly heldQueue = new Map<string, ((inst: HeldInstance) => void)[]>();
  private readonly limbo = new Map<string, BurnHeldRecord>();
  private readonly pocket = new Map<string, BurnHeldRecord>();
  /** 换时间线 / 换场景：在途异步作废 */
  private epoch = 0;
  /** 换时间线（读档 / 销毁）：离场场景的后台重建与手上挂件的装载作废——**不随**进出场景变 */
  private timeline = 0;
  /** 当前场景正在建（scene:ready 之后、资产与图到齐之前）：期间来的动作排队 */
  private activating: { sceneId: string; epoch: number; queue: ((rec: SceneRecord) => void)[] } | null = null;
  private restoring = false;
  private readonly query: BurnCellQuery = createBurnCellQuery();
  private readonly pointBuf = new Float32Array(QUERY_POINTS_MAX * 4);
  private readonly windTmp = [0, 0, 0];
  private readonly onSceneReady: () => void;
  private readonly onSceneUnload: () => void;
  private readonly onRestoring: () => void;
  private stats = { items: 0, held: 0, burning: 0, lights: 0, particles: 0, simMs: 0 };

  constructor(private readonly deps: BurnSystemDeps) {
    this.onSceneReady = () => { void this.activateLiveScene(); };
    this.onSceneUnload = () => this.leaveLiveScene();
    this.onRestoring = () => { this.restoring = true; this.epoch++; this.timeline++; };
  }

  setRenderer(r: BurnRenderer | null): void {
    this.renderer?.clear();
    this.renderer = r;
  }

  init(ctx: GameContext): void {
    this.eventBus = ctx.eventBus;
    ctx.eventBus.on('scene:ready', this.onSceneReady);
    ctx.eventBus.on('scene:beforeUnload', this.onSceneUnload);
    ctx.eventBus.on('save:restoring', this.onRestoring);
  }

  destroy(): void {
    this.epoch++;
    this.timeline++;
    this.leaveLiveScene();
    for (const inst of [...this.held.values()]) this.disposeHeldVisual(inst);
    const eb = this.eventBus;
    if (eb) {
      eb.off('scene:ready', this.onSceneReady);
      eb.off('scene:beforeUnload', this.onSceneUnload);
      eb.off('save:restoring', this.onRestoring);
    }
    this.eventBus = null;
    this.renderer?.clear();
    this.renderer = null;
    this.scenes.clear();
    this.held.clear();
    this.heldLoading.clear();
    this.heldQueue.clear();
    this.limbo.clear();
    this.pocket.clear();
    this.burnableCache.clear();
    this.imageCache.clear();
    this.previewBurnables.clear();
    this.sceneInfos.clear();
  }

  // ================================================================ 模板

  /** 清洗后的模板（缓存；工作台工作态覆盖优先）。读不到 / 读不懂 ⇒ null */
  loadTemplate(id: string): Promise<ResolvedBurnable | null> {
    const pv = this.previewBurnables.get(id);
    if (pv) return Promise.resolve(pv);
    let p = this.burnableCache.get(id);
    if (!p) {
      p = this.deps.loadJson<unknown>(burnableJsonUrl(id))
        .then((raw) => {
          const b = resolveBurnable(raw, id);
          if (!b) this.deps.log(`burn: 可燃物模板「${id}」读不懂（缺 image / 真实尺寸？），当作不存在`);
          return b;
        })
        .catch((e) => { this.deps.log(`burn: 可燃物模板「${id}」装不到：${String(e)}`); return null; });
      this.burnableCache.set(id, p);
    }
    return p;
  }

  private loadImage(url: string): Promise<BurnImageData | null> {
    let p = this.imageCache.get(url);
    if (!p) {
      p = this.deps.loadImageData(url).catch(() => null);
      this.imageCache.set(url, p);
    }
    return p;
  }

  /** 模板 → 燃料网格 + 指纹（模板读不到 / 图读不出来 ⇒ null） */
  private async buildTemplate(id: string): Promise<{ burnable: ResolvedBurnable; grid: BurnGrid; fp: string } | null> {
    const b = await this.loadTemplate(id);
    if (!b) return null;
    const [img, mask, order] = await Promise.all([
      this.loadImage(b.image),
      b.maskData ? this.loadImage(b.maskData) : Promise.resolve(null),
      b.orderData ? this.loadImage(b.orderData) : Promise.resolve(null),
    ]);
    if (!img) { this.deps.log(`burn: 可燃物模板「${b.id}」的图读不出来：${b.image}`); return null; }
    const grid = buildBurnGrid(b, img, mask, order);
    let fuelSum = 0;
    for (let i = 0; i < grid.fuel.length; i++) fuelSum += Math.round(grid.fuel[i] * 255);
    // 「雷劈能点着」不进指纹：它只决定以后雷来了点不点，不改这件东西怎么烧——开关它不该让存档里的记录作废
    const { lightningIgnites: _lightning, ...core } = b;
    const fp = burnHash(JSON.stringify({ b: core, g: [grid.nx, grid.ny, fuelSum] }));
    return { burnable: b, grid, fp };
  }

  /**
   * 建这个场景的实例：在场的宿主（`infos`）+ 记录里有过去、宿主却不在了的（幽灵：重放别人要用）。
   * 模板读不到的在场宿主跳过并说一句；幽灵建不出来的不建（对账时它有过去 ⇒ 整场收束）。
   */
  private async buildItems(rec: SceneRecord, infos: readonly { id: string; host: BurnableHostDef }[]): Promise<ItemBuild[]> {
    const out: ItemBuild[] = [];
    const want = new Map(infos.map((x) => [x.id, x.host]));
    const keys = new Set<string>([...want.keys()]);
    for (const [key, it] of rec.items) {
      if (!want.has(key) && itemHasPast(it)) keys.add(key);
    }
    await Promise.all([...keys].map(async (key) => {
      const host = want.get(key) ?? null;
      const templateId = host ? host.template : rec.items.get(key)!.burnable;
      const built = await this.buildTemplate(templateId);
      if (!built) {
        if (host) this.deps.log(`burn: ${rec.sceneId}/${key} 引用的可燃物模板「${templateId}」建不出来，这个实体不可燃`);
        return;
      }
      out.push({ key, host, ...built });
    }));
    out.sort((a, c) => (a.key < c.key ? -1 : 1));
    return out;
  }

  /** 场景定义层的可燃实体（清洗过、去掉坏块） */
  private infosOf(sceneId: string, scene: SceneData): { id: string; host: BurnableHostDef }[] {
    const raw = this.deps.sceneBurnables(sceneId, scene);
    this.sceneInfos.set(sceneId, raw);
    return cleanInfos(raw);
  }

  // ================================================================ 场景记录与模拟

  private recordOf(sceneId: string): SceneRecord {
    let rec = this.scenes.get(sceneId);
    if (!rec) {
      rec = {
        ...emptySceneRecordData(), sceneId, sim: null, simFps: new Map(), builds: new Map(), pendingSync: null,
        worldsFilled: false, fillSince: 0,
      };
      this.scenes.set(sceneId, rec);
    }
    return rec;
  }

  private windParamsOf(scene: SceneData): SceneWindParams | null {
    return resolveSceneWind(scene.wind);
  }

  /**
   * 对账 + 建模拟：拿这一次建出来的实例与记录比指纹，推不出来的切烧完；宿主在不在与日志里最后的出现 / 收掉对齐；
   * 新实例按宿主的 `initial` 起火；然后按记录重放。
   *
   * `mode`：`activate` 进场（新实例不记"出现"）/ `spawn` 在场时宿主变了（新实例记"出现"）/ `offscreen` 离场重建（读档后后台）。
   */
  private reconcile(rec: SceneRecord, scene: SceneData, builds: ItemBuild[], mode: 'activate' | 'spawn' | 'offscreen'): void {
    const windFp = burnHash(JSON.stringify(scene.wind ?? null));
    const windChanged = rec.windFp !== '' && rec.windFp !== windFp;
    rec.windFp = windFp;
    const derived: [string, BurnState, BurnState][] = [];
    const want = new Map(builds.map((b) => [b.key, b]));
    const t = this.clock;
    let appended = false;
    const breaks = (it: BurnItemRecord, fpSame: boolean): boolean => {
      if (fpSame && !(windChanged && it.events.length > 0)) return false;
      return itemHasPast(it);
    };
    let broken = false;
    // 记录里有、这一次建不出来的：没过去 ⇒ 丢；有过去 ⇒ 别的可燃物的过去也推不出来了
    for (const [key, it] of [...rec.items]) {
      if (want.has(key)) continue;
      if (itemHasPast(it)) broken = true;
      rec.items.delete(key);
    }
    for (const b of builds) {
      let cur = rec.items.get(b.key);
      if (!cur) {
        if (!b.host) continue;
        cur = { burnable: b.burnable.id, fp: b.fp, state: 'unburnt', base: 'fresh', events: [], worlds: [] };
        rec.items.set(b.key, cur);
        if (mode === 'spawn') { insertEvent(cur.events, { t, k: 'appear' }); appended = true; }
        if (b.host.initial === 'burning') { insertEvent(cur.events, initialIgniteEvent(b.burnable, t)); appended = true; }
        continue;
      }
      const fpSame = cur.fp === b.fp && cur.burnable === b.burnable.id;
      if (breaks(cur, fpSame)) broken = true;
      if (!fpSame) { cur.fp = b.fp; cur.burnable = b.burnable.id; }
      const loggedPresent = lastPresence(cur.events) !== 'vanish';
      if (b.host && !loggedPresent) {
        insertEvent(cur.events, { t, k: 'appear' });
        if (b.host.initial === 'burning') insertEvent(cur.events, initialIgniteEvent(b.burnable, t));
        appended = true;
      } else if (!b.host && loggedPresent) {
        insertEvent(cur.events, { t, k: 'vanish' });
        appended = true;
      }
    }
    // 离场重建（读档后）拿不到场景几何：在场的实例缺世界映射、而场景里还有火在走 ⇒ 推不出来
    if (mode === 'offscreen' && !broken && builds.some((b) => b.host && rec.items.get(b.key)?.worlds.length === 0)) {
      for (const it of rec.items.values()) {
        if (it.state === 'burning' || it.events.some((e) => e.t >= this.clock)) { broken = true; break; }
      }
    }
    if (broken) {
      for (const [key, cur] of [...rec.items]) {
        const b = want.get(key);
        if (!b || !b.host) { rec.items.delete(key); continue; }   // 幽灵：没有要重放的了
        if (!itemHasPast(cur)) continue;
        const from = cur.state;
        const w = currentWorldJson(cur);
        cur.worlds = w ? [w] : [];
        cur.events = [];
        if (from === 'unburnt') { cur.base = 'fresh'; continue; }
        cur.base = 'burnt';
        cur.state = 'burnt';
        if (from !== 'burnt') derived.push([key, from, 'burnt']);
      }
    }
    const kept = builds.filter((b) => rec.items.has(b.key));
    const fps = new Map(kept.map((b) => [b.key, b.fp]));
    const reuse = rec.sim && sameMap(fps, rec.simFps) && !broken && !windChanged && !appended;
    rec.builds = new Map(kept.map((b) => [b.key, b]));
    if (!reuse) {
      const inputs: BurnItemInput[] = kept.map((b) => {
        const it = rec.items.get(b.key)!;
        const worlds: BurnWorldGrid[] = [];
        for (const w of it.worlds) { const g = burnWorldGridFromJson(w); if (g) worlds.push(g); }
        return { key: b.key, burnable: b.burnable, grid: b.grid, worlds, events: it.events.slice(), baseBurnt: it.base === 'burnt' };
      });
      let start = this.clock;
      for (const inp of inputs) for (const e of inp.events) if (e.t < start) start = e.t;
      const params = this.windParamsOf(scene);
      rec.sim = new BurnSceneSim(inputs, { wind: params, windTimeAt: (tt) => windTimeFromVisits(rec.visits, tt) }, start);
      rec.simFps = fps;
      rec.pendingSync = new Map([...rec.items].map(([k, it]) => [k, it.state]));
    }
    for (const [key, from, to] of derived) this.announce(rec, key, from, to);
  }

  /** 模拟就绪（世界映射齐了）时的第一次推进：静默重放到"现在"，再与激活前的记录比出期间推导出的变化 */
  private syncSim(rec: SceneRecord): void {
    const sim = rec.sim;
    if (!sim || !sim.ready) return;
    if (rec.pendingSync) {
      const before = rec.pendingSync;
      rec.pendingSync = null;
      sim.setListener(null);
      sim.advanceTo(this.clock);
      for (const key of sim.keys()) {
        const it = rec.items.get(key);
        const now = sim.state(key);
        if (!it || !now) continue;
        const was = before.get(key) ?? it.state;
        it.state = now;
        if (was !== now) this.announce(rec, key, was, now);
      }
      sim.setListener((key, from, to) => {
        const it = rec.items.get(key);
        if (it) it.state = to;
        this.announce(rec, key, from, to);
      });
      return;
    }
    sim.advanceTo(this.clock);
  }

  /** 场景实例状态真变了：发宿主配的信号 + 叫醒条件重评 */
  private announce(rec: SceneRecord, key: string, from: BurnState, to: BurnState): void {
    if (from === to) return;
    const it = rec.items.get(key);
    if (it) it.state = to;
    const sig = rec.builds.get(key)?.host?.signals;
    const signal = to === 'burning' ? sig?.ignited : to === 'burnt' ? sig?.burntOut : to === 'out' ? sig?.extinguished : undefined;
    if (signal) this.deps.emitSignal(signal, key);
    this.eventBus?.emit('burn:changed', { sceneId: rec.sceneId, target: key, from, to });
  }

  // ================================================================ 场景生命周期

  private liveInfos(): { id: string; host: BurnableHostDef }[] {
    return cleanInfos(this.deps.liveEntities().map((h) => ({ id: h.id, burnable: h.burnable })));
  }

  private async activateLiveScene(): Promise<void> {
    const scene = this.deps.getSceneData();
    if (!scene) return;
    this.restoring = false;
    const epoch = ++this.epoch;
    this.liveSceneId = scene.id;
    // 场景 onEnter 紧跟 scene:ready 执行，那时模板 / 图还在路上：这段时间来的动作排队，建好之后按原时刻记
    const queue: ((rec: SceneRecord) => void)[] = this.activating?.sceneId === scene.id ? this.activating.queue : [];
    this.activating = { sceneId: scene.id, epoch, queue };
    this.infosOf(scene.id, scene);
    const infos = this.liveInfos();
    const rec = this.recordOf(scene.id);
    const builds = await this.buildItems(rec, infos);
    if (epoch !== this.epoch) return;
    this.reconcile(rec, scene, builds, 'activate');
    this.liveSig = infoSig(infos);
    rec.worldsFilled = false;
    rec.fillSince = this.clock;
    this.noteVisit(rec, scene, true);
    this.activating = null;
    for (const run of queue) run(rec);
  }

  /** 在场时宿主变了（演出生成 / 收掉 / 换了模板）：收掉的记"收掉"、回来的记"出现"，新面孔重建模拟 */
  private syncLiveEntities(rec: SceneRecord, scene: SceneData): void {
    if (this.liveRebuilding) return;
    const infos = this.liveInfos();
    const sig = infoSig(infos);
    if (sig === this.liveSig) return;
    this.liveSig = sig;
    const want = new Map(infos.map((x) => [x.id, x.host]));
    let needRebuild = false;
    for (const x of infos) {
      const b = rec.builds.get(x.id);
      if (!b || b.burnable.id !== x.host.template) { needRebuild = true; continue; }
      if (!b.host) {
        // 回来了：同模板 ⇒ 记"出现"（+ 初始起火）
        b.host = x.host;
        this.recordEvent(rec, x.id, { t: this.clock, k: 'appear' });
        if (x.host.initial === 'burning') this.recordEvent(rec, x.id, initialIgniteEvent(b.burnable, this.clock));
      } else {
        b.host = x.host;
      }
    }
    for (const b of rec.builds.values()) {
      if (!b.host || want.has(b.key)) continue;
      // 不在了：记"收掉"，留成幽灵
      this.recordEvent(rec, b.key, { t: this.clock, k: 'vanish' });
      b.host = null;
      this.detachVisual(`s:${b.key}`);
    }
    if (!needRebuild) return;
    const epoch = this.epoch;
    this.liveRebuilding = true;
    void this.buildItems(rec, infos).then((builds) => {
      this.liveRebuilding = false;
      if (epoch !== this.epoch || this.liveSceneId !== rec.sceneId) return;
      this.reconcile(rec, scene, builds, 'spawn');
      rec.worldsFilled = false;
      rec.fillSince = this.clock;
      this.liveSig = '';   // 期间可能又变过：下一帧再比一次
    });
  }

  /** 动作落到当前场景的记录上；场景还在建 ⇒ 排队（记下此刻的钟，建好后按这个时刻记） */
  private withLiveRecord(label: string, key: string, run: (rec: SceneRecord, b: ItemBuild, t: number) => boolean): boolean {
    const t = this.clock;
    const act = this.activating;
    if (act && act.epoch === this.epoch && act.sceneId === this.deps.getSceneData()?.id) {
      act.queue.push((rec) => {
        const b = rec.builds.get(key);
        if (!b || !b.host) { this.deps.log(`${label}: 当前场景没有可燃实体「${key}」`); return; }
        run(rec, b, t);
      });
      return true;
    }
    const rec = this.liveRecord();
    const b = rec?.builds.get(key);
    if (!rec || !b || !b.host) { this.deps.log(`${label}: 当前场景没有可燃实体「${key}」`); return false; }
    return run(rec, b, t);
  }

  /** 进场 / 风钟被重置：记一段新的风钟偏移（只在场景有风时有意义） */
  private noteVisit(rec: SceneRecord, scene: SceneData, force: boolean): void {
    if (!scene.wind || !this.windParamsOf(scene)) return;
    const offset = this.clock - this.deps.windClock();
    const last = rec.visits[rec.visits.length - 1];
    if (!force && last && Math.abs(last[1] - offset) < 1e-3) return;
    if (last && last[0] === this.clock) last[1] = offset;
    else rec.visits.push([this.clock, offset]);
  }

  private leaveLiveScene(): void {
    this.epoch++;
    for (const vkey of [...this.liveParticles.keys()]) {
      if (vkey.startsWith('s:')) this.stopParticles(vkey);
    }
    for (const id of this.plateFires.values()) this.deps.vfx.stopVfxSoft(id);
    this.plateFires.clear();
    this.plateContactAt.clear();
    if (this.renderer) for (const k of this.renderer.keys()) if (k.startsWith('s:')) this.renderer.detach(k);
    this.deps.vfx.setFireSources('burn', []);
    if (this.lightsPushedNonEmpty) this.deps.setDynamicLights([]);
    this.lightsPushedNonEmpty = false;
    this.lightRig.reset();
    this.liveSceneId = null;
    this.liveSig = '';
    this.liveRebuilding = false;
    this.liveGrids.clear();
    this.placementSigs.clear();
    this.lastMoveAt.clear();
    this.lastSpace = null;
    this.activating = null;
    this.stats = { items: 0, held: this.held.size, burning: 0, lights: 0, particles: 0, simMs: 0 };
  }

  private liveRecord(): SceneRecord | null {
    return this.liveSceneId ? this.scenes.get(this.liveSceneId) ?? null : null;
  }

  // ================================================================ 每帧

  update(dt: number): void {
    if (!(dt > 0)) return;
    this.clock += dt;
    const t0 = performance.now();
    const scene = this.deps.getSceneData();
    const liveRec = this.liveSceneId && scene && scene.id === this.liveSceneId ? this.scenes.get(this.liveSceneId) ?? null : null;
    if (liveRec && scene && !this.activating) {
      this.noteVisit(liveRec, scene, false);
      this.syncLiveEntities(liveRec, scene);
      this.trackLiveWorlds(liveRec);
      if (!this.restoring) this.plateContacts(liveRec);
    }
    for (const rec of this.scenes.values()) {
      // 当前场景：在场实体的世界映射补齐之前不推（钟照走，齐了按时刻追上）——否则补映射前那几帧火够不着缺映射的可燃物，
      // 读档重放（映射从一开始就在）会点着它，活跑与重放就不一样了
      if (rec === liveRec && !rec.worldsFilled) continue;
      this.syncSim(rec);
    }
    this.stepHeld(scene);
    this.stats.simMs = performance.now() - t0;
    this.present(liveRec, scene, dt);
  }

  /**
   * 在场实体的世界映射：第一次补上；挪了（世界映射逐点差超过 `MOVE_EPS_WU`）⇒ 场景没有任何过去就直接换，
   * 有过去就追加一份并记"挪位"事件（最密 `MOVE_MIN_INTERVAL_S` 一条）。
   */
  private trackLiveWorlds(rec: SceneRecord): void {
    const sim = rec.sim;
    if (!sim || !this.deps.isSpaceFinal()) return;
    const space = this.deps.getSpace();
    if (!space) return;
    if (this.lastSpace !== space) {
      this.lastSpace = space;
      this.placementSigs.clear();
    }
    let filled = true;
    const history = recordHasHistory(rec);
    for (const host of this.deps.liveEntities()) {
      const b = rec.builds.get(host.id);
      const it = rec.items.get(host.id);
      if (!b || !b.host || !it) continue;
      const f = host.frame(burnableWorldSize(b.burnable));
      if (!f) { if (!sim.worldOf(host.id)) filled = false; continue; }
      const sig = frameSig(f);
      let grid = this.liveGrids.get(host.id);
      if (!grid || this.placementSigs.get(host.id) !== sig) {
        grid = buildBurnWorldGrid(f, b.burnable.orientation, space);
        this.liveGrids.set(host.id, grid);
        this.placementSigs.set(host.id, sig);
      }
      // 与**日志里此刻该在的位置**比（最后一条挪位指向的那份），不是模拟推到一半的位置：读档后模拟还没推到挪位那一刻，
      // 拿它比会凭空再记一条挪位
      const table = sim.worldTable(host.id);
      const cur = table.length > 0 ? table[lastMoveIndex(it.events)] ?? table[0] : null;
      if (!cur) {
        sim.setWorld(host.id, grid);
        it.worlds = [burnWorldGridToJson(grid)];
      } else if (!burnWorldGridsClose(cur, grid, MOVE_EPS_WU)) {
        if (!history) {
          sim.rebaseWorld(host.id, grid);
          it.worlds = [burnWorldGridToJson(grid)];
        } else if (this.clock - (this.lastMoveAt.get(host.id) ?? -Infinity) >= MOVE_MIN_INTERVAL_S) {
          const w = sim.addWorld(host.id, grid);
          it.worlds.push(burnWorldGridToJson(grid));
          this.recordEvent(rec, host.id, { t: this.clock, k: 'move', w });
          this.lastMoveAt.set(host.id, this.clock);
        }
      }
    }
    if (filled || this.clock - rec.fillSince > WORLD_FILL_TIMEOUT_S) rec.worldsFilled = true;
  }

  /** 燃着的纸钱碰到场景里的可燃物 ⇒ 记外部点火事件（时刻 = 现在 + 目标引燃时间） */
  private plateContacts(rec: SceneRecord): void {
    const sim = rec.sim;
    if (!sim || !sim.ready) return;
    const groups = this.deps.vfx.burningPlates();
    for (const g of groups) {
      const pts = g.group.points;
      const L = g.group.params.flameLenWu;
      for (let k = 0; k < g.group.count; k++) {
        const o = k * 4;
        const hits = sim.findContacts(pts[o], pts[o + 1], pts[o + 2], 0, 1, 0, L, pts[o + 3]);
        for (const h of hits) {
          const last = this.plateContactAt.get(h.key) ?? -Infinity;
          if (this.clock - last < PLATE_CONTACT_COOLDOWN_S) continue;
          this.plateContactAt.set(h.key, this.clock);
          this.recordEvent(rec, h.key, { t: this.clock + h.delay, k: 'ignite', u: h.u, v: h.v });
        }
      }
    }
  }

  /** 记一条场景实例的外部事件：进记录（存档）+ 进模拟 */
  private recordEvent(rec: SceneRecord, key: string, e: BurnExternalEvent): boolean {
    const it = rec.items.get(key);
    const sim = rec.sim;
    if (!it || !sim || !sim.has(key)) return false;
    const applied = sim.addEvent(key, e);
    if (!applied) return false;
    // 复原也**不截断**日志：它复原之前烧的那一段点着过别的可燃物，重放别人要用到这一段
    insertEvent(it.events, applied);
    return true;
  }

  // ================================================================ 手上的挂件

  private liveEnv(scene: SceneData | null): BurnSceneEnv {
    const rec = scene ? this.scenes.get(scene.id) : undefined;
    const wind = scene ? this.windParamsOf(scene) : null;
    return { wind, windTimeAt: (t) => windTimeFromVisits(rec?.visits ?? [], t) };
  }

  private stepHeld(scene: SceneData | null): void {
    const hosts = this.deps.liveHeld();
    const seen = new Set<string>();
    for (const h of hosts) {
      const hostDef = resolveBurnableHost(h.burnable);
      if (!hostDef) continue;
      const key = burnHeldKey(h.target, h.socket);
      seen.add(key);
      const inst = this.held.get(key);
      if (inst && inst.prop === h.prop && inst.host.template === hostDef.template) {
        inst.hostRef = h;
        inst.host = hostDef;
        continue;
      }
      if (inst) this.parkHeld(inst);
      const token = `${h.prop}|${hostDef.template}`;
      if (this.heldLoading.get(key) !== token) void this.loadHeld(key, h, hostDef, token);
    }
    for (const [key, inst] of [...this.held]) if (!seen.has(key)) this.parkHeld(inst);
    for (const [key, token] of [...this.heldLoading]) if (!seen.has(key)) { this.heldLoading.delete(key); this.heldQueue.delete(key); void token; }
    const env = this.liveEnv(scene);
    const space = this.deps.getSpace();
    const spaceOk = !!space && this.deps.isSpaceFinal();
    for (const inst of this.held.values()) {
      inst.sim.setEnv(env);
      const f = spaceOk ? inst.hostRef?.frame() ?? null : null;
      if (f && space) {
        const grid = buildBurnWorldGrid(f, 'upright', space);
        inst.liveGrid = grid;
        inst.sim.setLiveWorld(inst.key, grid, false);
      }
      if (inst.sim.ready) inst.sim.advanceTo(this.clock);
    }
    this.stats.held = this.held.size;
  }

  /** 挂上一件可燃挂件：接着暂存的（切场景重挂 / 读档）→ 包里那根 → 一根新的（按 `initial` 起火） */
  private async loadHeld(key: string, h: BurnHeldHost, host: BurnableHostDef, token: string): Promise<void> {
    this.heldLoading.set(key, token);
    const timeline = this.timeline;
    const built = await this.buildTemplate(host.template);
    if (this.heldLoading.get(key) !== token || timeline !== this.timeline) return;
    this.heldLoading.delete(key);
    const queue = this.heldQueue.get(key) ?? [];
    this.heldQueue.delete(key);
    if (!built) { this.deps.log(`burn: ${h.target} 的 ${h.socket} 上的「${h.prop}」引用的可燃物模板「${host.template}」建不出来`); return; }
    let rec = this.limbo.get(key);
    if (rec && rec.prop !== h.prop) rec = undefined;
    if (rec) this.limbo.delete(key);
    else {
      rec = this.pocket.get(h.prop);
      if (rec) this.pocket.delete(h.prop);
    }
    const input: BurnItemInput = { key, burnable: built.burnable, grid: built.grid, worlds: [], events: [] };
    let start = this.clock;
    let state: BurnState = 'unburnt';
    if (rec) {
      if (rec.fp === built.fp && rec.burnable === built.burnable.id) {
        input.snapshot = rec.snap;
        input.events = rec.events.slice();
        if (rec.snap) start = rec.snap.t;
        state = rec.state;
      } else if (rec.state !== 'unburnt') {
        // 模板改过、而它烧过：推不出来 ⇒ 烧完
        input.baseBurnt = true;
        state = 'burnt';
      }
    } else if (host.initial === 'burning') {
      input.events.push(initialIgniteEvent(built.burnable, this.clock));
    }
    for (const e of input.events) if (e.t < start) start = e.t;
    const sim = new BurnSceneSim([input], this.liveEnv(this.deps.getSceneData()), start);
    const inst: HeldInstance = {
      key, target: h.target, socket: h.socket, prop: h.prop, host, burnable: built.burnable, grid: built.grid, fp: built.fp,
      sim, state, liveGrid: null, hostRef: h,
    };
    sim.setListener((_k, from, to) => { inst.state = to; this.announceHeld(inst, from, to); });
    this.held.set(key, inst);
    for (const run of queue) run(inst);
  }

  private announceHeld(inst: HeldInstance, from: BurnState, to: BurnState): void {
    if (from === to) return;
    const sig = inst.host.signals;
    const signal = to === 'burning' ? sig?.ignited : to === 'burnt' ? sig?.burntOut : to === 'out' ? sig?.extinguished : undefined;
    if (signal) this.deps.emitSignal(signal, inst.target);
    this.eventBus?.emit('burn:changed', { sceneId: null, target: inst.target, socket: inst.socket, from, to });
  }

  /** 这一件此刻烧成什么样（推到现在再拍） */
  private heldRecordOf(inst: HeldInstance): BurnHeldRecord {
    if (inst.sim.ready) inst.sim.advanceTo(this.clock);
    return {
      prop: inst.prop, burnable: inst.burnable.id, fp: inst.fp,
      state: inst.sim.state(inst.key) ?? inst.state,
      snap: inst.sim.exportSnapshot(inst.key),
      events: inst.sim.pendingEvents(inst.key),
    };
  }

  /** 挂点上换了东西 / 切场景整批卸下：暂存（重挂同一件时接着烧） */
  private parkHeld(inst: HeldInstance): void {
    this.limbo.set(inst.key, this.heldRecordOf(inst));
    this.disposeHeldVisual(inst);
    this.held.delete(inst.key);
  }

  private disposeHeldVisual(inst: HeldInstance): void {
    this.detachVisual(`h:${inst.key}`);
  }

  /**
   * 挂件被**收起来**（`HeldPropSystem.detach`：动作卸下 / 收进包里）：熄灭，记成"包里那根"（烧完的不记：下一根是新的）。
   * 切场景整批卸下不走这里（那条走暂存，重挂接着烧）。
   */
  onHeldRemoved(target: string, socket: string, prop: string): void {
    const key = burnHeldKey(target.trim(), socket.trim());
    const inst = this.held.get(key);
    let rec: BurnHeldRecord | undefined;
    if (inst && inst.prop === prop) {
      const st = inst.sim.state(key);
      if (st === 'burning') inst.sim.addEvent(key, { t: this.clock, k: 'extinguish' });
      rec = this.heldRecordOf(inst);
      this.disposeHeldVisual(inst);
      this.held.delete(key);
    } else {
      rec = this.limbo.get(key);
      if (rec && rec.prop !== prop) rec = undefined;
      if (rec) this.limbo.delete(key);
    }
    this.heldLoading.delete(key);
    this.heldQueue.delete(key);
    if (!rec) return;
    if (rec.state === 'burnt') this.pocket.delete(prop);
    else this.pocket.set(prop, rec);
  }

  private withHeld(label: string, target: string, socket: string, run: (inst: HeldInstance, t: number) => boolean): boolean {
    const key = burnHeldKey(target, socket);
    const t = this.clock;
    const inst = this.held.get(key);
    if (inst) return run(inst, t);
    if (this.heldLoading.has(key)) {
      const q = this.heldQueue.get(key) ?? [];
      q.push((i) => { run(i, t); });
      this.heldQueue.set(key, q);
      return true;
    }
    this.deps.log(`${label}: ${target} 的挂点「${socket}」上没有可燃挂件`);
    return false;
  }

  // ================================================================ 表现

  private present(liveRec: SceneRecord | null, scene: SceneData | null, dt: number): void {
    const renderer = this.renderer;
    const nowMs = performance.now();
    const space = this.deps.getSpace();
    const lightsAllowed = space?.kind === 'field';
    const windParams = scene ? this.windParamsOf(scene) : null;
    const visits = liveRec?.visits ?? [];
    const fires: VfxFireSegment[] = [];
    const lights: BurnLightSource[] = [];
    let burning = 0;
    let particles = 0;
    const items: PresentItem[] = [];
    if (liveRec?.sim && scene) {
      const hosts = new Map(this.deps.liveEntities().map((h) => [h.id, h]));
      for (const b of liveRec.builds.values()) {
        const host = b.host ? hosts.get(b.key) : undefined;
        if (!host || !liveRec.sim.isPresent(b.key)) { this.detachVisual(`s:${b.key}`); continue; }
        items.push({
          vkey: `s:${b.key}`, key: b.key, sim: liveRec.sim, b: b.burnable, grid: b.grid, render: host.render,
          container: host.container, frame: host.frame(burnableWorldSize(b.burnable)), liveGrid: this.liveGrids.get(b.key) ?? null,
          ownsFireToPlates: true,
        });
      }
      this.stats.items = liveRec.builds.size;
    }
    for (const inst of this.held.values()) {
      const h = inst.hostRef;
      items.push({
        vkey: `h:${inst.key}`, key: inst.key, sim: inst.sim, b: inst.burnable, grid: inst.grid, render: h?.render ?? null,
        container: h?.container ?? null, frame: h?.frame() ?? null, liveGrid: inst.liveGrid, ownsFireToPlates: true,
      });
    }
    for (const it of items) {
      const { sim, key, b } = it;
      const state = sim.ready ? sim.state(key) ?? 'unburnt' : 'unburnt';
      if (state === 'burning') burning++;
      // ---- 燃烧着色：烧过（不是没点）才挂
      if (renderer) {
        const want = !!it.render && sim.ready && state !== 'unburnt';
        if (want) {
          if (!renderer.has(it.vkey)) {
            renderer.attach(it.vkey, it.render!, it.grid.nx, it.grid.ny);
            const data = renderer.fieldData(it.vkey);
            if (data) sim.encodeTexture(key, data);
            sim.takeDirty(key);
            renderer.markDirty(it.vkey, nowMs, true);
          } else if (sim.takeDirty(key)) {
            const data = renderer.fieldData(it.vkey);
            if (data) { sim.encodeTexture(key, data); renderer.markDirty(it.vkey, nowMs); }
          }
          renderer.setShade(it.vkey, burnShadeParamsOf(b, it.grid, sim.shaderClock(key)), it.frame ? burnSceneToUvAffine(it.frame) : null);
        } else if (renderer.has(it.vkey)) {
          renderer.detach(it.vkey);
        }
      }
      if (!sim.ready || !sim.worldOf(key)) continue;
      // ---- 火苗粒子
      let slots = this.liveParticles.get(it.vkey);
      b.particles.forEach((slot, j) => {
        const q = sim.query(key, slot.from, this.query);
        const vfxId = slots?.get(j);
        if (q.count === 0 || !it.container) {
          if (vfxId) { this.deps.vfx.setInstanceRateScale(vfxId, 0); this.deps.vfx.stopVfxSoft(vfxId); slots!.delete(j); }
          return;
        }
        const n = this.samplePoints(it, q);
        const centroid = this.centroidOf(it, q);
        let id = vfxId;
        if (!id) {
          id = this.deps.vfx.playVfx({ effect: slot.effect, followWorld: centroid }) ?? undefined;
          if (!id) return;
          if (!slots) { slots = new Map(); this.liveParticles.set(it.vkey, slots); }
          slots.set(j, id);
          const node = it.container;
          this.deps.vfx.setInstanceSortHost(id, () => ({ node, front: true }));
        } else {
          this.deps.vfx.moveInstanceAnchor(id, centroid);
        }
        this.deps.vfx.setInstanceSpawnPoints(id, this.pointBuf, n);
        const vit = b.mode === 'consume' && slot.from === 'flame' ? sim.vitality(key) : 1;
        this.deps.vfx.setInstanceRateScale(id, (q.area / slot.refArea) * vit);
        particles++;
      });
      // ---- 火焰段（点纸钱）与火光：明火那一段
      const flame = sim.query(key, 'flame', this.query);
      if (flame.count === 0) continue;
      if (it.ownsFireToPlates) this.fireSegments(it, flame, fires);
      const L = b.light;
      if (L && lightsAllowed) {
        const c = this.centroidOf(it, flame);
        const areaM2 = flame.area / 10000;
        const vit = b.mode === 'consume' ? sim.vitality(key) : 1;
        let intensity = L.intensityPerM2 * areaM2 * vit;
        if (L.maxIntensity !== undefined) intensity = Math.min(L.maxIntensity, intensity);
        const lenWu = b.flameLengthCm * BURN_WU_PER_CM;
        lights.push({
          id: it.vkey,
          pos: [c[0], c[1] + lenWu / 2, c[2]],
          intensity,
          kelvin: L.color ? undefined : (L.kelvin ?? 1700),
          color: L.color,
          range: L.range ?? BURN_DEFAULTS.lightRange,
          softeningRadius: L.softeningRadius ?? BURN_DEFAULTS.lightSoftening,
          castShadow: L.castShadow === true,
          diameterM: Math.max(0.01, Math.sqrt((4 * areaM2) / Math.PI)),
          puffAmp: L.puffAmp ?? BURN_DEFAULTS.lightPuffAmp,
          airMps: this.airAt(windParams, visits, c[0], c[2]),
        });
      }
    }
    // 不再画的表现（实例没了）收掉
    const live = new Set(items.map((x) => x.vkey));
    for (const vkey of [...this.liveParticles.keys()]) if (!live.has(vkey)) this.stopParticles(vkey);
    if (renderer) for (const k of renderer.keys()) if (!live.has(k)) renderer.detach(k);
    // ---- 燃着的纸钱：火苗粒子 + 火光
    if (liveRec) this.presentPlates(lights, lightsAllowed, windParams, visits);
    this.deps.vfx.setFireSources('burn', fires);
    // ---- 火光推送（限速）
    const pushed = this.lightRig.step(dt, lights);
    if (pushed) {
      if (pushed.length > 0 || this.lightsPushedNonEmpty) this.deps.setDynamicLights(pushed);
      this.lightsPushedNonEmpty = pushed.length > 0;
      this.stats.lights = pushed.length;
    }
    // 燃烧着色的相机 uniform / 图像空间渲染由组装层在相机定稿之后推（`BurnRenderer.update`），这里推会差一帧、镜头一动烧痕就滑
    this.stats.burning = burning;
    this.stats.particles = particles;
  }

  private stopParticles(vkey: string): void {
    const slots = this.liveParticles.get(vkey);
    if (!slots) return;
    for (const id of slots.values()) { this.deps.vfx.setInstanceRateScale(id, 0); this.deps.vfx.stopVfxSoft(id); }
    this.liveParticles.delete(vkey);
  }

  private detachVisual(vkey: string): void {
    this.stopParticles(vkey);
    if (this.renderer?.has(vkey)) this.renderer.detach(vkey);
  }

  /** 第 c 格格心此刻的世界点（宿主此刻的位置：会动的实例表现跟手，不等挪位事件）+ 半对角线 */
  private cellWorld(it: PresentItem, c: number, out: number[]): boolean {
    if (!it.sim.cellWorld(it.key, c, out)) return false;
    if (it.liveGrid) {
      const uv = it.sim.cellUv(it.key, c);
      if (uv) {
        const tmp = [0, 0, 0, 0];
        burnWorldAt(it.liveGrid, uv.u, uv.v, tmp);
        out[0] = tmp[0]; out[1] = tmp[1]; out[2] = tmp[2];
      }
    }
    return true;
  }

  private centroidOf(it: PresentItem, q: BurnCellQuery): [number, number, number] {
    if (!it.liveGrid) return [q.cx, q.cy, q.cz];
    const tmp = [0, 0, 0, 0];
    let x = 0, y = 0, z = 0, n = 0;
    const step = Math.max(1, Math.ceil(q.count / QUERY_POINTS_MAX));
    for (let k = 0; k < q.count; k += step) {
      if (!this.cellWorld(it, q.cells[k], tmp)) continue;
      x += tmp[0]; y += tmp[1]; z += tmp[2]; n++;
    }
    return n > 0 ? [x / n, y / n, z / n] : [q.cx, q.cy, q.cz];
  }

  /** 从一批格里均匀抽至多 QUERY_POINTS_MAX 个出生点（按格序步进，确定性） */
  private samplePoints(it: PresentItem, q: BurnCellQuery): number {
    const step = Math.max(1, Math.ceil(q.count / QUERY_POINTS_MAX));
    const tmp = [0, 0, 0, 0];
    let n = 0;
    for (let k = 0; k < q.count && n < QUERY_POINTS_MAX; k += step) {
      if (!this.cellWorld(it, q.cells[k], tmp)) continue;
      const o = n * 4;
      this.pointBuf[o] = tmp[0]; this.pointBuf[o + 1] = tmp[1]; this.pointBuf[o + 2] = tmp[2]; this.pointBuf[o + 3] = tmp[3];
      n++;
    }
    return n;
  }

  /** 明火格按 4×4 块聚成火焰段 */
  private fireSegments(it: PresentItem, q: BurnCellQuery, out: VfxFireSegment[]): void {
    const nx = it.grid.nx;
    const blocks = new Map<number, { n: number; x: number; y: number; z: number; c: number; r: number }>();
    const tmp = [0, 0, 0, 0];
    for (let k = 0; k < q.count; k++) {
      const c = q.cells[k];
      if (!this.cellWorld(it, c, tmp)) continue;
      const i = c % nx;
      const j = (c - i) / nx;
      const bk = Math.floor(j / FIRE_BLOCK) * 65536 + Math.floor(i / FIRE_BLOCK);
      let e = blocks.get(bk);
      if (!e) { e = { n: 0, x: 0, y: 0, z: 0, c, r: 0 }; blocks.set(bk, e); }
      e.n++; e.x += tmp[0]; e.y += tmp[1]; e.z += tmp[2];
      e.r = Math.max(e.r, tmp[3]);
    }
    const axis = [0, 1, 0];
    // 可燃物有纵深（立着的 ≈ 宽）：火焰段的粗细加上它，与模拟里可燃物之间的接触同一口径
    const depth = it.sim.halfDepthOf(it.key);
    for (const e of blocks.values()) {
      const len = it.sim.flameAxisAt(it.key, e.c, axis);
      out.push({
        x: e.x / e.n, y: e.y / e.n, z: e.z / e.n,
        ax: axis[0], ay: axis[1], az: axis[2], len,
        r: e.r * Math.min(FIRE_BLOCK, Math.sqrt(e.n)) + depth,
      });
    }
  }

  private airAt(p: SceneWindParams | null, visits: readonly [number, number][], x: number, z: number): number {
    if (!p) return 0;
    sampleSceneWind(p, windTimeFromVisits(visits, this.clock), x, z, BURN_WU_PER_M, this.windTmp);
    return Math.hypot(this.windTmp[0], this.windTmp[2]) / BURN_WU_PER_M;
  }

  /** 燃着的纸钱：模板的火苗粒子（发射率 × 燃着的面积 / 参考面积）+ 模板的火光（每平方米强度 × 燃着的面积） */
  private presentPlates(
    lights: BurnLightSource[], lightsAllowed: boolean, windParams: SceneWindParams | null, visits: readonly [number, number][],
  ): void {
    const groups = this.deps.vfx.burningPlates();
    const seen = new Set<string>();
    for (const g of groups) {
      const P = g.group.params;
      const gid = `${g.instanceId}#${g.group.emitterIndex}`;
      let cx = 0, cy = 0, cz = 0;
      const pts = g.group.points;
      for (let k = 0; k < g.group.count; k++) { cx += pts[k * 4]; cy += pts[k * 4 + 1]; cz += pts[k * 4 + 2]; }
      const n = Math.max(1, g.group.count);
      cx /= n; cy /= n; cz /= n;
      const areaCm2 = g.group.count * g.group.plateAreaCm2;
      P.fire.forEach((slot, j) => {
        const fk = `${gid}#${j}`;
        seen.add(fk);
        let id = this.plateFires.get(fk);
        if (!id) {
          id = this.deps.vfx.playVfx({ effect: slot.effect, followWorld: [cx, cy, cz] }) ?? undefined;
          if (!id) return;
          this.plateFires.set(fk, id);
        } else {
          this.deps.vfx.moveInstanceAnchor(id, [cx, cy, cz]);
        }
        const count = Math.min(QUERY_POINTS_MAX, g.group.count);
        this.pointBuf.set(pts.subarray(0, count * 4));
        this.deps.vfx.setInstanceSpawnPoints(id, this.pointBuf, count);
        this.deps.vfx.setInstanceRateScale(id, areaCm2 / slot.refArea);
      });
      const L = P.light;
      if (lightsAllowed && L) {
        const areaM2 = areaCm2 / 10000;
        let intensity = L.intensityPerM2 * areaM2;
        if (L.maxIntensity !== undefined) intensity = Math.min(L.maxIntensity, intensity);
        lights.push({
          id: `plates_${gid}`,
          pos: [cx, cy + P.flameLenWu / 2, cz],
          intensity,
          kelvin: L.color ? undefined : (L.kelvin ?? 1800),
          color: L.color,
          range: L.range ?? BURN_DEFAULTS.lightRange,
          softeningRadius: L.softeningRadius ?? BURN_DEFAULTS.lightSoftening,
          castShadow: false,
          diameterM: Math.max(0.02, Math.sqrt((4 * areaM2) / Math.PI)),
          puffAmp: L.puffAmp ?? BURN_DEFAULTS.lightPuffAmp,
          airMps: this.airAt(windParams, visits, cx, cz),
        });
      }
    }
    for (const [fk, id] of [...this.plateFires]) {
      if (seen.has(fk)) continue;
      this.deps.vfx.setInstanceRateScale(id, 0);
      this.deps.vfx.stopVfxSoft(id);
      this.plateFires.delete(fk);
    }
  }

  // ================================================================ 对外：条件 / 动作 / 点火表演

  /**
   * 条件叶 `burn`：可燃实例此刻的状态；不是可燃实例 ⇒ null（叶子为假）。
   * `socket` 给了 = 这个人这个挂点上的可燃挂件；否则 = 场景实体（`sceneId` 缺省当前场景）。
   */
  statusOf(target: string, sceneId?: string, socket?: string): BurnState | null {
    const id = target.trim();
    if (socket && socket.trim()) {
      const key = burnHeldKey(id, socket.trim());
      const inst = this.held.get(key);
      if (inst) return inst.sim.ready ? inst.sim.state(key) ?? inst.state : inst.state;
      return this.limbo.get(key)?.state ?? null;
    }
    const sid = sceneId || this.deps.getSceneData()?.id || this.liveSceneId || '';
    if (!sid) return null;
    const rec = this.scenes.get(sid);
    const it = rec?.items.get(id);
    if (rec && it) {
      if (rec.sim?.has(id)) {
        if (!rec.sim.isPresent(id)) return null;
        if (rec.sim.ready && !rec.pendingSync) return rec.sim.state(id) ?? it.state;
      } else if (lastPresence(it.events) === 'vanish') {
        return null;
      }
      return it.state;
    }
    const infos = this.sceneInfos.get(sid);
    if (!infos) {
      this.primeSceneInfo(sid);
      return null;
    }
    const host = cleanInfos(infos).find((x) => x.id === id)?.host;
    if (!host) return null;
    return host.initial === 'burning' ? 'burning' : 'unburnt';
  }

  /** 别的场景的定义层没装过：后台装一次，装好叫醒条件重评 */
  private primeSceneInfo(sceneId: string): void {
    if (this.sceneInfoLoading.has(sceneId)) return;
    this.sceneInfoLoading.add(sceneId);
    void this.deps.loadSceneData(sceneId).then((scene) => {
      this.sceneInfoLoading.delete(sceneId);
      if (!scene) return;
      this.sceneInfos.set(sceneId, this.deps.sceneBurnables(sceneId, scene));
      this.eventBus?.emit('burn:changed', { sceneId, target: '', from: 'unburnt', to: 'unburnt' });
    }).catch(() => { this.sceneInfoLoading.delete(sceneId); });
  }

  /** 动作 `igniteBurnable`：直接点着（point = 着火点 id；缺省有点取第一个、没有整体） */
  igniteBurnable(target: string, socket?: string, pointId?: string): boolean {
    const ev = (b: ResolvedBurnable, t: number): BurnExternalEvent => {
      const pts = b.ignitionPoints;
      let p = pointId ? pts.find((x) => x.id === pointId) : pts[0];
      if (pointId && !p) {
        this.deps.log(`igniteBurnable: 可燃物模板「${b.id}」没有着火点「${pointId}」，按缺省点`);
        p = pts[0];
      }
      return p ? { t, k: 'ignite', u: p.u, v: p.v } : { t, k: 'igniteAll' };
    };
    if (socket) {
      return this.withHeld('igniteBurnable', target, socket, (inst, t) => !!inst.sim.addEvent(inst.key, ev(inst.burnable, t)));
    }
    return this.withLiveRecord('igniteBurnable', target, (rec, b, t) => this.recordEvent(rec, target, ev(b.burnable, t)));
  }

  extinguishBurnable(target: string, socket?: string): boolean {
    if (socket) return this.withHeld('extinguishBurnable', target, socket, (inst, t) => !!inst.sim.addEvent(inst.key, { t, k: 'extinguish' }));
    return this.withLiveRecord('extinguishBurnable', target, (rec, _b, t) => this.recordEvent(rec, target, { t, k: 'extinguish' }));
  }

  resetBurnable(target: string, socket?: string): boolean {
    if (socket) return this.withHeld('resetBurnable', target, socket, (inst, t) => !!inst.sim.addEvent(inst.key, { t, k: 'reset' }));
    return this.withLiveRecord('resetBurnable', target, (rec, _b, t) => this.recordEvent(rec, target, { t, k: 'reset' }));
  }

  /** 玩家点火表演的接触帧：在 (u, v) 点着；`all` = 整体 */
  igniteAt(target: string, at: { u: number; v: number } | 'all'): boolean {
    const rec = this.liveRecord();
    if (!rec?.builds.get(target)?.host) return false;
    const e: BurnExternalEvent = at === 'all'
      ? { t: this.clock, k: 'igniteAll' }
      : { t: this.clock, k: 'ignite', u: at.u, v: at.v };
    return this.recordEvent(rec, target, e);
  }

  /**
   * 雷劈（与画出来的那道雷同一拍）：落点 `at`（M-world wu）竖直往上 `heightWu`、半径 `radiusWu` 这一段胶囊里，
   * 模板开了「雷劈能点着」的可燃物在离雷最近的那一格当场着（不等引燃延迟：雷不是一截慢慢烤的火）。
   * 场景里摆的与手上拿的都算；粒子薄片归粒子系统（`VfxSystem.igniteByLightning`）。
   *
   * 场景里摆的与玩家手点过同一道门：宿主不许玩家点（`playerIgnite: false`，留给脚本点的）、
   * 能点的条件没满足的，雷也不点——雷不能把编排里还没到时候的火提前点掉。返回点着了几件。
   */
  igniteByLightning(at: readonly number[], radiusWu: number, heightWu: number): number {
    if (!(radiusWu > 0) || this.restoring) return 0;
    const h = Math.max(0, heightWu);
    let n = 0;
    const rec = this.liveRecord();
    const sim = rec?.sim;
    if (rec && sim?.ready) {
      let ctx: ConditionEvalContext | null = null;
      for (const hit of sim.findContacts(at[0], at[1], at[2], 0, 1, 0, h, radiusWu)) {
        const b = rec.builds.get(hit.key);
        if (!b?.host || !b.burnable.lightningIgnites || !sim.isPresent(hit.key)) continue;
        if (b.host.playerIgnite === false) continue;
        const conds = b.host.igniteConditions;
        if (conds?.length) {
          const c = ctx ??= this.deps.conditionContext();
          if (!(conds as ConditionExpr[]).every((x) => evaluateConditionExpr(x, c))) continue;
        }
        if (this.recordEvent(rec, hit.key, { t: this.clock, k: 'ignite', u: hit.u, v: hit.v })) n++;
      }
    }
    for (const inst of this.held.values()) {
      if (!inst.burnable.lightningIgnites || !inst.sim.ready) continue;
      const hit = inst.sim.findContacts(at[0], at[1], at[2], 0, 1, 0, h, radiusWu).find((x) => x.key === inst.key);
      if (hit && inst.sim.addEvent(inst.key, { t: this.clock, k: 'ignite', u: hit.u, v: hit.v })) n++;
    }
    return n;
  }

  private liveHost(id: string): BurnEntityHost | null {
    return this.deps.liveEntities().find((h) => h.id === id) ?? null;
  }

  private liveFrameOf(b: ItemBuild, host: BurnEntityHost): BurnFrame | null {
    return host.frame(burnableWorldSize(b.burnable));
  }

  /**
   * 玩家此刻能不能按 E 点它（交互系统每帧问）：宿主允许玩家点、能点的条件满足、没在烧也没烧完、模拟就绪、宿主在场可交互。
   * 手上有没有能点火的火由调用方另判。
   */
  canPlayerIgnite(target: string): boolean {
    const rec = this.liveRecord();
    const b = rec?.builds.get(target);
    if (!rec || !b?.host || !rec.sim?.ready || !rec.sim.isPresent(target)) return false;
    if (b.host.playerIgnite === false) return false;
    const st = rec.sim.state(target);
    if (st === 'burning' || st === 'burnt') return false;
    const host = this.liveHost(target);
    if (!host || !host.active) return false;
    const conds = b.host.igniteConditions;
    if (conds?.length) {
      const ctx = this.deps.conditionContext();
      for (const c of conds as ConditionExpr[]) if (!evaluateConditionExpr(c, ctx)) return false;
    }
    return true;
  }

  /** 点火表演要对准哪一点（场景坐标）与点着时用什么：标了着火点 = 离火头最近的那个；没标 = 燃料重心（整体点） */
  playerIgniteTarget(target: string, tip: { x: number; y: number }): { scene: { x: number; y: number }; target: { u: number; v: number } | 'all' } | null {
    const b = this.liveRecord()?.builds.get(target);
    const host = this.liveHost(target);
    if (!b?.host || !host) return null;
    const frame = this.liveFrameOf(b, host);
    if (!frame) return null;
    const aim = burnIgniteAim(b.burnable, b.grid, frame, tip);
    return { scene: aim.scene, target: aim.target };
  }

  /**
   * 玩家能不能从它身上**引火**（手上的火把灭着 / 可燃挂件没在烧，伸过来点着）：当前场景、模拟就绪、在场、正在烧、此刻有明火格。
   * 不看"玩家能点"与"能点的条件"——引火不点它。
   */
  canRelightFrom(target: string): boolean {
    const rec = this.liveRecord();
    const b = rec?.builds.get(target);
    if (!rec || !b?.host || !rec.sim?.ready || !rec.sim.isPresent(target)) return false;
    if (rec.sim.state(target) !== 'burning') return false;
    const host = this.liveHost(target);
    if (!host || !host.active) return false;
    return rec.sim.query(target, 'flame', this.query).count > 0;
  }

  /** 引火表演要把火头伸到哪（场景坐标）：此刻离火头最近的明火格；没有明火 ⇒ null */
  relightTarget(target: string, tip: { x: number; y: number }): { x: number; y: number } | null {
    const rec = this.liveRecord();
    const b = rec?.builds.get(target);
    const host = this.liveHost(target);
    if (!rec?.sim?.ready || !b?.host || !host) return null;
    const q = rec.sim.query(target, 'flame', this.query);
    if (q.count === 0) return null;
    const frame = this.liveFrameOf(b, host);
    if (!frame) return null;
    const nx = b.grid.nx;
    const ny = b.grid.ny;
    let best: { x: number; y: number } | null = null;
    let bestD = Infinity;
    for (let k = 0; k < q.count; k++) {
      const c = q.cells[k];
      const i = c % nx;
      const p = burnUvToScene(frame, (i + 0.5) / nx, ((c - i) / nx + 0.5) / ny);
      const d = Math.hypot(p.x - tip.x, p.y - tip.y);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  /** 某人手上的可燃挂件（优先右手） */
  private heldOf(target: string, pick: (inst: HeldInstance) => boolean): HeldInstance | null {
    let chosen: HeldInstance | null = null;
    for (const inst of this.held.values()) {
      if (inst.target !== target || !pick(inst)) continue;
      if (!chosen || inst.socket === 'right_hand') chosen = inst;
      if (inst.socket === 'right_hand') break;
    }
    return chosen;
  }

  /**
   * 某人手上**燃着**的可燃挂件当点火的火（点火表演用；火把优先由组装层判）：挂点、火头（此刻明火格的 uv 重心）与火焰长度（厘米）。
   */
  heldIgniterOf(target: string): { socket: string; u: number; v: number; flameLengthCm: number } | null {
    const inst = this.heldOf(target.trim(), (x) => x.sim.ready && x.sim.state(x.key) === 'burning'
      && x.sim.query(x.key, 'flame', this.query).count > 0);
    if (!inst) return null;
    const q = inst.sim.query(inst.key, 'flame', this.query);
    let u = 0, v = 0;
    for (let k = 0; k < q.count; k++) {
      const uv = inst.sim.cellUv(inst.key, q.cells[k])!;
      u += uv.u; v += uv.v;
    }
    return { socket: inst.socket, u: u / q.count, v: v / q.count, flameLengthCm: inst.burnable.flameLengthCm };
  }

  /** 某人手上**没在烧、没烧完**的可燃挂件（能从燃着的东西上引火）：挂点与要伸过去的点（第一个着火点 / 燃料中间） */
  heldRelightTipOf(target: string): { socket: string; u: number; v: number } | null {
    const inst = this.heldOf(target.trim(), (x) => {
      const st = x.sim.ready ? x.sim.state(x.key) : x.state;
      return st === 'unburnt' || st === 'out';
    });
    if (!inst) return null;
    const p = inst.burnable.ignitionPoints[0];
    const c = p ? { u: p.u, v: p.v } : burnFuelCenterUv(inst.grid);
    return { socket: inst.socket, u: c.u, v: c.v };
  }

  /** 从燃着的东西上引火点着玩家手上的可燃挂件（接触帧）。不能引 ⇒ false */
  relightHeld(target: string): boolean {
    const tip = this.heldRelightTipOf(target);
    if (!tip) return false;
    const key = burnHeldKey(target.trim(), tip.socket);
    const inst = this.held.get(key)!;
    const e: BurnExternalEvent = inst.burnable.ignitionPoints.length > 0
      ? { t: this.clock, k: 'ignite', u: tip.u, v: tip.v }
      : { t: this.clock, k: 'igniteAll' };
    return !!inst.sim.addEvent(key, e);
  }

  // ================================================================ 纸钱（粒子）存档

  /** 粒子系统建模拟时问：这个布置实例里哪些纸已经烧没了 */
  burntPlatesOf(instanceId: string): ReadonlyMap<number, readonly number[]> | null {
    const sid = this.deps.getSceneData()?.id;
    const byEmitter = sid ? this.scenes.get(sid)?.plates.get(instanceId) : undefined;
    if (!byEmitter) return null;
    const out = new Map<number, number[]>();
    for (const [e, set] of byEmitter) out.set(e, [...set]);
    return out;
  }

  /** 粒子系统报：这几张纸烧没了（含收掉模拟那一刻还在烧的） */
  onPlatesBurnt(instanceId: string, emitterIndex: number, slots: readonly number[]): void {
    if (this.restoring || slots.length === 0) return;
    const sid = this.deps.getSceneData()?.id;
    if (!sid) return;
    const rec = this.recordOf(sid);
    let byEmitter = rec.plates.get(instanceId);
    if (!byEmitter) { byEmitter = new Map(); rec.plates.set(instanceId, byEmitter); }
    let set = byEmitter.get(emitterIndex);
    if (!set) { set = new Set(); byEmitter.set(emitterIndex, set); }
    for (const s of slots) set.add(s);
  }

  // ================================================================ 存读档

  serialize(): Record<string, unknown> {
    const scenes: BurnSaveJson['scenes'] = {};
    const liveSid = this.deps.getSceneData()?.id;
    const burningPlates = liveSid ? this.deps.vfx.burningPlateSlots() : [];
    for (const [sid, rec] of this.scenes) {
      const liveStates = new Map<string, BurnState>();
      if (rec.sim?.ready && !rec.pendingSync) for (const k of rec.sim.keys()) liveStates.set(k, rec.sim.state(k)!);
      scenes[sid] = sceneRecordToJson(rec, sid === liveSid ? burningPlates : [], liveStates);
    }
    const held: BurnSaveJson['held'] = {};
    for (const [key, rec] of this.limbo) held[key] = heldRecordToJson(rec);
    for (const inst of this.held.values()) held[inst.key] = heldRecordToJson(this.heldRecordOf(inst));
    const pocket: BurnSaveJson['pocket'] = {};
    for (const [prop, rec] of this.pocket) pocket[prop] = heldRecordToJson(rec);
    const out: BurnSaveJson = { v: BURN_SAVE_VERSION, clock: this.clock, scenes, held, pocket };
    return out as unknown as Record<string, unknown>;
  }

  deserialize(data: Record<string, unknown>): void {
    this.epoch++;
    this.timeline++;
    this.leaveLiveScene();
    for (const inst of [...this.held.values()]) this.disposeHeldVisual(inst);
    this.held.clear();
    this.heldLoading.clear();
    this.heldQueue.clear();
    this.limbo.clear();
    this.pocket.clear();
    this.scenes.clear();
    this.restoring = true;
    const raw = data as Partial<BurnSaveJson>;
    this.clock = typeof raw.clock === 'number' && Number.isFinite(raw.clock) ? raw.clock : 0;
    if (raw.v !== undefined && raw.v !== BURN_SAVE_VERSION) {
      this.deps.log(`burn: 存档里的燃烧数据是第 ${String(raw.v)} 版（现在第 ${BURN_SAVE_VERSION} 版，可燃物已改成模板），整桶不认：燃烧状态回到没点`);
      return;
    }
    if (raw.scenes && typeof raw.scenes === 'object') {
      for (const [sid, s] of Object.entries(raw.scenes)) {
        const d = sceneRecordFromJson(s);
        if (!d) continue;
        this.scenes.set(sid, {
          ...d, sceneId: sid, sim: null, simFps: new Map(), builds: new Map(), pendingSync: null, worldsFilled: false, fillSince: 0,
        });
      }
    }
    for (const [key, r] of Object.entries(raw.held ?? {})) {
      const rec = heldRecordFromJson(r);
      if (rec) this.limbo.set(key, rec);
    }
    for (const [prop, r] of Object.entries(raw.pocket ?? {})) {
      const rec = heldRecordFromJson(r);
      if (rec) this.pocket.set(prop, rec);
    }
    // 别的场景里还在烧的：后台重建、照推（当前场景等 scene:ready）
    const timeline = this.timeline;
    for (const rec of this.scenes.values()) {
      if (!this.hasPendingFire(rec)) continue;
      void this.activateOffscreen(rec, timeline);
    }
  }

  /** 读档后后台重建一个离场中还在烧的场景（不渲染）。世界映射缺失 ⇒ 推不出来 ⇒ 在烧的切烧完 */
  private async activateOffscreen(rec: SceneRecord, timeline: number): Promise<void> {
    const scene = await this.deps.loadSceneData(rec.sceneId).catch(() => null);
    if (timeline !== this.timeline || rec.sceneId === this.liveSceneId || !scene) return;
    const builds = await this.buildItems(rec, this.infosOf(rec.sceneId, scene));
    if (timeline !== this.timeline || rec.sceneId === this.liveSceneId) return;
    this.reconcile(rec, scene, builds, 'offscreen');
  }

  /** 这个场景读档后要不要后台照推：有东西在烧，或有还没到时刻的外部事件（纸钱刚碰到、引燃时间还没过） */
  private hasPendingFire(rec: BurnSceneRecordData): boolean {
    for (const it of rec.items.values()) {
      if (it.state === 'burning' || it.events.some((e) => e.t >= this.clock)) return true;
    }
    return false;
  }

  // ================================================================ DEV：燃烧工作台联动 / 调试

  /** 工作态覆盖（`null` 撤销）：可燃物模板。当前场景与手上的按新数据重建（记录照对账） */
  applyPreview(burnables: Record<string, unknown> | null): void {
    this.previewBurnables.clear();
    if (burnables) {
      for (const [id, raw] of Object.entries(burnables)) {
        const b = resolveBurnable(raw, id);
        if (b) this.previewBurnables.set(id, b);
      }
    } else {
      for (const id of [...this.burnableCache.keys()]) this.deps.dropJson(burnableJsonUrl(id));
    }
    this.burnableCache.clear();
    this.imageCache.clear();
    for (const inst of [...this.held.values()]) this.parkHeld(inst);
    if (this.liveSceneId) {
      this.leaveLiveScene();
      void this.activateLiveScene();
    }
  }

  get debugStats(): { items: number; held: number; burning: number; lights: number; particles: number; simMs: number; clock: number } {
    return { ...this.stats, clock: this.clock };
  }

  debugSnapshot(): {
    kind: 'scene' | 'held'; sceneId: string | null; target: string; socket?: string; template: string;
    state: BurnState; events: number; ready: boolean; detail: unknown;
  }[] {
    const out: ReturnType<BurnSystem['debugSnapshot']> = [];
    for (const [sid, rec] of this.scenes) {
      for (const [key, it] of rec.items) {
        const st = this.statusOf(key, sid);
        if (st === null) continue;
        out.push({
          kind: 'scene', sceneId: sid, target: key, template: it.burnable, state: st,
          events: it.events.length, ready: !!rec.sim?.ready, detail: rec.sim?.debugItem(key) ?? null,
        });
      }
    }
    for (const inst of this.held.values()) {
      out.push({
        kind: 'held', sceneId: null, target: inst.target, socket: inst.socket, template: inst.burnable.id,
        state: inst.sim.state(inst.key) ?? inst.state, events: inst.sim.events(inst.key).length, ready: inst.sim.ready,
        detail: inst.sim.debugItem(inst.key),
      });
    }
    return out;
  }

  /** 此刻在场的实例（调试面板 / 工作台状态回传）：当前场景的可燃实体 + 手上的 */
  liveInstances(): { kind: 'scene' | 'held'; target: string; socket?: string; template: string }[] {
    const out: { kind: 'scene' | 'held'; target: string; socket?: string; template: string }[] = [];
    const rec = this.liveRecord();
    if (rec) for (const b of rec.builds.values()) if (b.host) out.push({ kind: 'scene', target: b.key, template: b.burnable.id });
    for (const inst of this.held.values()) out.push({ kind: 'held', target: inst.target, socket: inst.socket, template: inst.burnable.id });
    return out;
  }
}

// ------------------------------------------------------------------ 小工具

function cleanInfos(raw: readonly BurnSceneEntityInfo[]): { id: string; host: BurnableHostDef }[] {
  const out: { id: string; host: BurnableHostDef }[] = [];
  const seen = new Set<string>();
  for (const x of raw) {
    const id = typeof x.id === 'string' ? x.id.trim() : '';
    const host = resolveBurnableHost(x.burnable);
    if (!id || !host || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, host });
  }
  return out;
}

function infoSig(infos: readonly { id: string; host: BurnableHostDef }[]): string {
  return infos.map((x) => `${x.id}${x.host.template}`).sort().join('');
}

function frameSig(f: BurnFrame): string {
  return [f.ox, f.oy, f.ux, f.uy, f.vx, f.vy, f.footX, f.footY].map((n) => Math.round(n * 1000) / 1000).join(',');
}

/** 有没有过去（有事件，或起点就是烧完） */
function itemHasPast(it: BurnItemRecord): boolean {
  return it.events.length > 0 || it.base === 'burnt' || it.state !== 'unburnt';
}

function recordHasHistory(rec: BurnSceneRecordData): boolean {
  for (const it of rec.items.values()) if (it.events.length > 0 || it.base === 'burnt') return true;
  return false;
}

/** 日志里最后一条出现 / 收掉（都没有 = null，视为一直在） */
function lastPresence(events: readonly BurnExternalEvent[]): 'appear' | 'vanish' | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const k = events[i].k;
    if (k === 'appear' || k === 'vanish') return k;
  }
  return null;
}

/** 按时刻保持升序插入（同一时刻后到的排后面） */
function insertEvent(events: BurnExternalEvent[], e: BurnExternalEvent): void {
  let i = events.length;
  while (i > 0 && events[i - 1].t > e.t) i--;
  events.splice(i, 0, e);
}

/** 日志里最后一条挪位指向的世界映射下标（没有 = 0） */
function lastMoveIndex(events: readonly BurnExternalEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.k === 'move') return e.w;
  }
  return 0;
}

/** 此刻用的那份世界映射（日志里最后一条挪位指向的；没有 = 第 0 份） */
function currentWorldJson(it: BurnItemRecord): number[] | null {
  return it.worlds[lastMoveIndex(it.events)] ?? it.worlds[0] ?? null;
}

function initialIgniteEvent(b: ResolvedBurnable, t: number): BurnExternalEvent {
  const p = b.ignitionPoints[0];
  return p ? { t, k: 'ignite', u: p.u, v: p.v } : { t, k: 'igniteAll' };
}

function sameMap(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}
