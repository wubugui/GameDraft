/**
 * 世界空间粒子 / 群体系统（VfxSystem）——布置（场景 × 时段外观）的生命周期、刺激场总线、资产装载、驱动渲染。
 *
 * 三件正交的东西（见 types.ts 里 VFX 一节）：效果资产（全局，不绑场景不绑时段）、布置
 * （布置库 `assets/data/vfx_placements.json`，按「场景 × 时段外观」各配一份）、刺激场（运行时事件）。
 * 本系统 own 后两者的运行态；模拟数学在 `vfxSim.ts`（纯函数）、画法在 `rendering/vfx/VfxRenderer.ts`。
 *
 * ## 布置取哪一份
 *
 * `deps.getAppearancePhase()`（= `resolveSceneAppearance(scene, 当前时段).phase`，空串 = 基底）——与背景 / 光照
 * 换装同一个判据。**没配就没有、互不继承**：夜里没摆就是没有，不回退到白天那份。时段推进后外观键变了
 * 就按 id 差分换表（没变的实例不动），不等场景重载——两个时段外观等价时换装不重载，但布置可以不同。
 *
 * 表演态：不入档（serialize 恒空桶），切场景整批散掉（`scene:beforeUnload`），读档 = 换时间线 → 同上。
 * 依赖一律构造函数窄回调注入（律 11），不 import 任何系统实例。
 *
 * ## 刺激从哪来
 *
 * 1. 显式动作 `emitVfxField`（物品用途 / 对话 / 热区 / 过场）→ `emitField`；
 * 2. 玩家动静（自动）：跟着玩家脚点走的常驻恐惧场，强度随速度；
 * 3. 场景实体灯：每盏有位置的灯一个常驻恐惧场（`light` 标签），怕不怕由物种档案说；
 * 4. 脚步：组装层在脚步落地回调里 `emitField` 一个 `sfx:footstep` 脉冲。
 *
 * 每个来源都是同一种 `VfxFieldRuntime`，群体按标签查自己的权重——不认识的标签权重 0，等于没发。
 */
import type { Texture } from 'pixi.js';

import type { AssetManager } from '../../core/AssetManager';
import type { EventBus } from '../../core/EventBus';
import type {
  AnimationSetDef,
  ConditionExpr,
  GameContext,
  IGameSystem,
  LightDef,
  SceneData,
  VfxAnchorDef,
  VfxAppearanceDef,
  VfxEffectDef,
  VfxFieldDef,
  VfxFlockState,
  VfxInstanceDef,
  VfxInstanceState,
  VfxPlacementLibrary,
} from '../../data/types';
import { TEXT_URLS, vfxEffectJsonUrl } from '../../core/projectPaths';
import type { VfxRenderer, VfxSpriteSheet } from '../../rendering/vfx/VfxRenderer';
import type { Vec3 } from '../../utils/sceneSpace';
import type { SceneWindParams } from '../../utils/sceneWind';
import { evaluateConditionExpr, type ConditionEvalContext } from '../graphDialogue/evaluateGraphCondition';
import type { ConfineField } from './vfxConfine';
import { hashSeed } from './vfxRandom';
import { VfxMotionAirflow } from './vfxMotionSource';
import { VfxInstanceSim, createFieldRuntime, type VfxFieldRuntime } from './vfxSim';
import type { VfxSpace } from './vfxSpace';

/** 调试面板的一行 */
export interface VfxInstanceDebugRow {
  id: string;
  effect: string;
  state: string;
  live: number;
  eligible: boolean;
  /** 限定了粒子区域才有：边带宽 / 高度上限 + 现场分档只数 */
  confine: {
    feather: number; ceiling: number | null;
    inner: number; band: number; outsideVisible: number; fading: number;
  } | null;
}

/** 玩家动静场：半径 / 满强度对应的速度（wu/s） */
const PLAYER_MOTION_RADIUS_WU = 320;
const PLAYER_MOTION_FULL_SPEED = 420;
/** 玩家动静场挂在脚点上方这么高（胸口） */
const PLAYER_MOTION_HEIGHT_WU = 90;
/** 灯当恐惧源：强度按作者面 intensity 折（2.5 = 编辑器缺省一盏灯 → 强度 1） */
const LIGHT_FIELD_STRENGTH_PER_INTENSITY = 1 / 2.5;
/** 条件重评的兜底周期（秒），事件驱动之外的保险 */
const CONDITION_RECHECK_S = 0.5;
/** 群体循环声的重触发周期（秒）：空间音总线没有 loop，用一次性音按节奏补 */
const LOOP_SFX_PERIOD_S = 2.4;

export interface VfxSystemDeps {
  assetManager: AssetManager;
  /** 当前场景数据 */
  getSceneData: () => SceneData | null;
  /** 建本场景的模拟空间（field / planar）；照明载荷是异步到的，每次场景就绪后调一次、载荷到了再调一次 */
  buildSpace: () => VfxSpace;
  /** 玩家脚点（场景坐标） */
  getPlayerContact: () => { x: number; y: number } | null;
  /**
   * 当前场景此刻用哪套时段外观：`timeVariants` 的键，空串 = 顶层基底；没进场景 null。
   * 布置按它取份（`SceneManager.appearancePhaseFor(当前时段)`）。
   */
  getAppearancePhase: () => string | null;
  /** 当前时段激活的实体灯（有 pos 的） */
  getActiveLights: () => readonly LightDef[];
  conditionContext: () => ConditionEvalContext;
  /**
   * **便宜**地判断"真 3D 场（行走面 + 基 + 标定）现在有没有"。
   *
   * 与 `buildSpace` 分开是因为后者要把行走面反投影成 XZ 高度场（147k 点），不能每帧调。
   * 而照明载荷是**异步到达**的：`scene:ready` 那一刻它常常还没落地，实例只好先建在
   * 平面近似上——planar 没有地面高低、没有墙，蝙蝠在一个没有崖壁的虚空里飞，
   * 而且**一切判据都是空的**（groundY 恒 0、shellContact 恒 null，"没入地""没进壳"全部假成立）。
   * 所以要有一条便宜的自愈检查，见 `update` 里的升级分支。
   */
  hasFieldGeometry: () => boolean;
  /** 空间音：从世界点播一条 sfx */
  playSfxAt: (id: string, at: Vec3) => void;
  log: (msg: string) => void;
  /**
   * 场景风（组装层持有的那一份 + 它的钟；背景摆动读同一份）。没有风的场景返回 null 或 params 为 null。
   * 可不注入（旧调用方 / 测试）＝ 没有风。
   */
  getWind?: () => { params: SceneWindParams | null; time: number } | null;
}

interface InstanceRuntime {
  def: VfxInstanceDef;
  effect: VfxEffectDef | null;
  sim: VfxInstanceSim | null;
  /** 条件 / 时段都过 */
  eligible: boolean;
  /** 被 stopVfx 显式停掉（直到 playVfx） */
  stopped: boolean;
  /** 上次循环声触发时刻 */
  loopAt: number;
  /** 临时实例（`playVfx` 现场生成的，不在布置库里；换布置表时不动它） */
  transient: boolean;
  /**
   * 跟随锚点（世界，wu）：非 null 时**它**才是锚，`def.anchor` 不再参与解算。
   * 由 `moveInstanceAnchor` 逐帧写（手持光源的火焰），见 `systems/heldProp`。
   */
  followWorld: Vec3 | null;
  /** Retry only when the effect changes or the scene space is rebuilt. */
  failedConstruction?: { effect: VfxEffectDef; space: VfxSpace };
  loadRevision?: number;
}

export class VfxSystem implements IGameSystem {
  private eventBus: EventBus | null = null;
  private renderer: VfxRenderer | null = null;
  private readonly instances = new Map<string, InstanceRuntime>();
  private readonly fields: VfxFieldRuntime[] = [];
  private readonly effectCache = new Map<string, Promise<VfxEffectDef | null>>();
  /** 粒子工作台联动（DEV）：各效果最近一次套上的工作态定义（JSON 串）；同样的一份再来不重建实例 */
  private readonly previewEffectJson = new Map<string, string>();
  private readonly sheetCache = new Map<string, Promise<VfxSpriteSheet | null>>();
  private readonly sheets = new Map<string, VfxSpriteSheet>();
  private space: VfxSpace | null = null;
  private generation = 0;
  private time = 0;
  private recheckIn = 0;
  private conditionsDirty = true;
  private playerPrev: { x: number; y: number } | null = null;
  private playerSpeed = 0;
  private playerField: VfxFieldRuntime | null = null;
  private readonly playerAirflow = new VfxMotionAirflow('player:motion');
  private lightFields: VfxFieldRuntime[] = [];
  private lightsKey = '';
  private readonly onSceneReady: () => void;
  private readonly onSceneUnload: () => void;
  private readonly onConditionsMaybeChanged: () => void;
  private enabled = true;
  private lastStats = { instances: 0, live: 0, drawCalls: 0, fields: 0, simMs: 0 };
  /** 布置库（会话内装一次；DEV 下工作台的工作态走 `placementOverrides`，不改这份） */
  private library: Promise<VfxPlacementLibrary | null> | null = null;
  /** 已建的实例表取自哪一份（场景 id + 外观键）；null = 还没建（或正在换场景） */
  private builtPlacement: { sceneId: string; phase: string } | null = null;
  /** 时段推进过：下一拍核一次外观键（变了就换布置表） */
  private placementKeyDirty = false;
  /**
   * 粒子工作台联动（DEV）：工作台推来的**整份工作态布置库**（含未保存改动），非 null 时整份顶替盘上那份。
   * 刻意整份而不是只收"工作台正展开的那一份"：只收一份的话作者切到另一时段，这边就退回会话里
   * 缓存的旧库——哪怕他刚存过盘（`loadJson` 按 URL 缓存），游戏里看到的就不是工作台里那份。
   */
  private libraryOverride: VfxPlacementLibrary | null = null;
  private readonly onPhaseChanged: () => void;

  constructor(private readonly deps: VfxSystemDeps) {
    this.onSceneReady = () => { void this.rebuildScene(); };
    this.onSceneUnload = () => this.clearScene();
    this.onConditionsMaybeChanged = () => { this.conditionsDirty = true; };
    this.onPhaseChanged = () => { this.conditionsDirty = true; this.placementKeyDirty = true; };
  }

  /** 渲染器由组装层建好后注入（渲染层对象；系统层可以依赖渲染层） */
  setRenderer(r: VfxRenderer | null): void {
    this.renderer?.clear();
    this.renderer = r;
  }

  init(ctx: GameContext): void {
    this.eventBus = ctx.eventBus;
    ctx.eventBus.on('scene:ready', this.onSceneReady);
    ctx.eventBus.on('scene:beforeUnload', this.onSceneUnload);
    ctx.eventBus.on('flag:changed', this.onConditionsMaybeChanged);
    ctx.eventBus.on('narrative:stateChanged', this.onConditionsMaybeChanged);
    ctx.eventBus.on('time:phaseChanged', this.onPhaseChanged);
    ctx.eventBus.on('quest:statusChanged', this.onConditionsMaybeChanged);
  }

  serialize(): Record<string, unknown> { return {}; }

  deserialize(_data: Record<string, unknown>): void {
    // 读档 = 换时间线：在途表演整批作废（scene:beforeUnload 也会来一次，这里保险）
    this.clearScene();
  }

  destroy(): void {
    this.clearScene();
    const eb = this.eventBus;
    if (eb) {
      eb.off('scene:ready', this.onSceneReady);
      eb.off('scene:beforeUnload', this.onSceneUnload);
      eb.off('flag:changed', this.onConditionsMaybeChanged);
      eb.off('narrative:stateChanged', this.onConditionsMaybeChanged);
      eb.off('time:phaseChanged', this.onPhaseChanged);
      eb.off('quest:statusChanged', this.onConditionsMaybeChanged);
    }
    this.eventBus = null;
    this.renderer?.clear();
    this.renderer = null;
    this.effectCache.clear();
    this.previewEffectJson.clear();
    this.sheetCache.clear();
    this.library = null;
    this.libraryOverride = null;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.renderer?.clear();
  }

  get isEnabled(): boolean { return this.enabled; }

  // ------------------------------------------------------------------ 场景

  /**
   * 照明载荷（行走面场 / 壳）就绪：空间换成真 3D 版并重建实例。
   *
   * 组装层在载荷回调里调一次；但那个回调**早于** `scene:ready`（载荷在 depthLoader 里就装完了），
   * 那时 `getSceneData()` 还是上一个场景、实例表也是空的，所以这一发常常什么也做不成。
   * 真正兜住的是 `update` 里那条便宜的自愈检查——这里只是让"载荷刚好晚到"的那一路早一拍生效。
   */
  onSpaceMaybeChanged(): void {
    if (!this.space) return;                       // 还没进场景：scene:ready 会建
    if (this.space.kind === 'field') return;       // 已经是真 3D
    if (!this.deps.hasFieldGeometry()) return;     // 载荷还没到
    void this.rebuildScene();
  }

  private clearScene(): void {
    this.generation++;
    for (const inst of this.instances.values()) inst.sim = null;
    this.instances.clear();
    this.fields.length = 0;
    this.playerField = null;
    this.playerAirflow.reset();
    this.lightFields = [];
    this.lightsKey = '';
    this.sheets.clear();
    this.space = null;
    this.playerPrev = null;
    this.playerSpeed = 0;
    this.builtPlacement = null;
    this.placementKeyDirty = false;
    this.renderer?.clear();
  }

  private async rebuildScene(): Promise<void> {
    this.clearScene();
    const gen = this.generation;
    const sd = this.deps.getSceneData();
    if (!sd) return;
    this.space = this.deps.buildSpace();
    const lib = await this.loadLibrary();
    if (gen !== this.generation) return;
    // 布置库是异步到的：等它的这一拍里时段可能已经推进过，取份放在 await 之后
    const phase = this.deps.getAppearancePhase() ?? '';
    this.builtPlacement = { sceneId: sd.id, phase };
    this.placementKeyDirty = false;
    this.applyPlacementRows(this.placementRows(lib, sd.id, phase));
  }

  /**
   * 布置库（会话内装一次）。缺文件 / 读不懂 = 没有任何布置，log 一句——**不**拖垮场景装载。
   * 形状只做最低闸门（根要有 `scenes` 表）；逐条的形状错由校验器与工作台的保存闸门拦。
   */
  private loadLibrary(): Promise<VfxPlacementLibrary | null> {
    if (!this.library) {
      this.library = this.deps.assetManager.loadJson<VfxPlacementLibrary>(TEXT_URLS.vfxPlacements)
        .then((d) => {
          if (d && typeof d === 'object' && d.scenes && typeof d.scenes === 'object') return d;
          this.deps.log('vfx: 布置库 vfx_placements.json 没有 scenes 表，当作没有任何布置');
          return null;
        })
        .catch((e) => { this.deps.log(`vfx: 布置库 vfx_placements.json 装不到（当作没有任何布置）：${String(e)}`); return null; });
    }
    return this.library;
  }

  private previewRows(sceneId: string, phase: string, library = this.libraryOverride): VfxInstanceDef[] | undefined {
    const ent = library?.scenes?.[sceneId];
    const rows = phase ? ent?.variants?.[phase] : ent?.base;
    return Array.isArray(rows) ? rows : undefined;
  }

  /** 工作态只覆盖明确编辑过的份；未发送的场景 / 外观继续读盘，显式 [] 才清空。 */
  private placementRows(lib: VfxPlacementLibrary | null, sceneId: string, phase: string): VfxInstanceDef[] {
    const preview = this.previewRows(sceneId, phase);
    if (preview !== undefined) return preview;
    const ent = lib?.scenes?.[sceneId];
    const rows = phase ? ent?.variants?.[phase] : ent?.base;
    return Array.isArray(rows) ? rows : [];
  }

  /**
   * 把非临时实例换成 `rows`：**按 id 差分**——定义逐字没变的实例原样留着（群不重飞、纸不重铺），
   * 变了的 / 新来的重建，不在表里的删掉。临时实例（手持火把的火焰）不归布置表管，一律不动。
   */
  private applyPlacementRows(rows: readonly VfxInstanceDef[]): void {
    const want = new Map<string, VfxInstanceDef>();
    for (const def of rows) {
      if (!def?.id || !def.effect) continue;
      if (!want.has(def.id)) want.set(def.id, def);
    }
    for (const [id, inst] of [...this.instances]) {
      if (inst.transient) continue;
      const next = want.get(id);
      if (next && JSON.stringify(next) === JSON.stringify(inst.def)) { want.delete(id); continue; }
      inst.sim = null;
      this.instances.delete(id);
    }
    for (const def of want.values()) {
      this.instances.set(def.id, { def, effect: null, sim: null, eligible: false, stopped: def.autoStart === false, loopAt: -Infinity, transient: false, followWorld: null });
    }
    this.conditionsDirty = true;
    // 资产并行装；装完各自建 sim（条件在 update 里评）
    for (const def of want.values()) this.loadInstanceEffect(this.instances.get(def.id)!);
  }

  /** 时段推进后核外观键：变了就换布置表（同场景，不等重载）。 */
  private syncPlacementKey(): void {
    this.placementKeyDirty = false;
    const built = this.builtPlacement;
    const sd = this.deps.getSceneData();
    if (!built || !sd || sd.id !== built.sceneId) return;
    const phase = this.deps.getAppearancePhase() ?? '';
    if (phase === built.phase) return;
    const gen = this.generation;
    void this.loadLibrary().then((lib) => {
      if (gen !== this.generation) return;
      const now = this.deps.getAppearancePhase() ?? '';
      if (!this.builtPlacement || this.builtPlacement.phase === now) return;
      this.builtPlacement = { sceneId: sd.id, phase: now };
      this.applyPlacementRows(this.placementRows(lib, sd.id, now));
    });
  }

  private async loadEffect(id: string): Promise<VfxEffectDef | null> {
    let p = this.effectCache.get(id);
    if (!p) {
      p = this.deps.assetManager.loadJson<VfxEffectDef>(vfxEffectJsonUrl(id))
        .then((d) => (d && typeof d === 'object' && Array.isArray(d.emitters) ? d : null))
        .catch((e) => { this.deps.log(`vfx: 效果「${id}」加载失败：${String(e)}`); return null; });
      this.effectCache.set(id, p);
    }
    return p;
  }

  private loadInstanceEffect(inst: InstanceRuntime): void {
    const gen = this.generation, revision = (inst.loadRevision ?? 0) + 1;
    inst.loadRevision = revision;
    const current = () => gen === this.generation && inst.loadRevision === revision && this.instances.get(inst.def.id) === inst;
    void this.loadEffect(inst.def.effect).then(async effect => {
      if (!current()) return;
      if (!effect) { this.deps.log(`vfx: 实例「${inst.def.id}」的效果「${inst.def.effect}」装不到，跳过`); return; }
      const sheets = await Promise.all(effect.emitters.map(async e => [e.id, await this.loadSheet(e.appearance)] as const));
      if (!current()) return;
      // Publish one coherent effect and sheet set. Earlier preview requests cannot overwrite it.
      for (const key of this.sheets.keys()) if (key.startsWith(`${inst.def.id}/`)) this.sheets.delete(key);
      for (const [id, sheet] of sheets) {
        if (sheet) this.sheets.set(`${inst.def.id}/${id}`, sheet);
        else this.deps.log(`vfx: 发射器「${effect.id}/${id}」的贴图装不到`);
      }
      inst.effect = effect;
      this.conditionsDirty = true;
    }).catch(error => {
      if (current()) this.deps.log(`vfx: 实例「${inst.def.id}」加载失败：${String(error)}`);
    });
  }

  private loadSheet(ap: VfxAppearanceDef): Promise<VfxSpriteSheet | null> {
    const key = `${ap.animFile ?? ''}|${ap.image ?? ''}|${ap.state ?? ''}|${ap.restState ?? ''}`;
    let p = this.sheetCache.get(key);
    if (p) return p;
    p = (async (): Promise<VfxSpriteSheet | null> => {
      const am = this.deps.assetManager;
      if (ap.animFile) {
        const def = await am.loadJson<AnimationSetDef>(ap.animFile);
        if (!def || !def.spritesheet || !def.states) return null;
        const dir = ap.animFile.substring(0, ap.animFile.lastIndexOf('/') + 1);
        const sheetUrl = def.spritesheet.startsWith('/') ? def.spritesheet : dir + def.spritesheet;
        const tex: Texture = await am.loadTexture(sheetUrl);
        const cols = Math.max(1, def.cols | 0), rows = Math.max(1, def.rows | 0);
        const stateName = ap.state && def.states[ap.state] ? ap.state : Object.keys(def.states)[0];
        const st = def.states[stateName];
        if (!st) return null;
        const rect = (idx: number) => {
          const c = idx % cols, r = Math.floor(idx / cols);
          return { u0: c / cols, v0: r / rows, u1: (c + 1) / cols, v1: (r + 1) / rows };
        };
        const frames = (st.frames ?? [0]).map(rect);
        const cw = tex.width / cols, ch = tex.height / rows;
        let restFrame: VfxSpriteSheet['restFrame'];
        if (ap.restState && def.states[ap.restState]?.frames?.length) restFrame = rect(def.states[ap.restState].frames[0]);
        return { texture: tex, frames, aspect: ch / Math.max(cw, 1e-6), frameRate: st.frameRate ?? 8, restFrame };
      }
      if (ap.image) {
        const tex: Texture = await am.loadTexture(ap.image);
        return { texture: tex, frames: [{ u0: 0, v0: 0, u1: 1, v1: 1 }], aspect: tex.height / Math.max(tex.width, 1e-6), frameRate: 0 };
      }
      return null;
    })().catch((e) => { this.deps.log(`vfx: 贴图加载失败：${String(e)}`); return null; });
    this.sheetCache.set(key, p);
    return p;
  }

  // ------------------------------------------------------------------ 条件 / 实例

  private evalEligible(inst: InstanceRuntime): boolean {
    const d = inst.def;
    // 时段不在这里过滤：分时段 = 布置库里不同的那一份（`applyPlacementRows` 换表），实例本身不带时段
    if (d.conditions?.length) {
      const ctx = this.deps.conditionContext();
      for (const c of d.conditions as ConditionExpr[]) if (!evaluateConditionExpr(c, ctx)) return false;
    }
    return true;
  }

  private ensureSim(inst: InstanceRuntime): void {
    if (inst.sim || !inst.effect || !this.space) return;
    if (inst.failedConstruction?.effect === inst.effect && inst.failedConstruction.space === this.space) return;
    try {
      const seed = typeof inst.def.seed === 'number' ? (inst.def.seed >>> 0) : hashSeed(inst.def.id);
      // 跟随锚点已经是世界点；条件刷新或换空间不能把它弹回静态布置位置。
      const anchor = inst.followWorld
        ? ([inst.followWorld[0], inst.followWorld[1], inst.followWorld[2]] as Vec3)
        : this.space.anchorToWorld(inst.def.anchor);
      inst.sim = new VfxInstanceSim(inst.def.id, inst.effect, anchor, seed, this.space, inst.def.countScale ?? 1,
        {
          area: Array.isArray(inst.def.area) ? inst.def.area : null,
          confine: inst.def.confine && typeof inst.def.confine === 'object' ? inst.def.confine : null,
        });
      inst.failedConstruction = undefined;
    } catch (error) {
      inst.failedConstruction = { effect: inst.effect, space: this.space };
      this.deps.log(`vfx: 实例 ${inst.def.id} / 效果 ${inst.effect.id} 无法创建：${String(error)}`);
    }
  }

  private refreshConditions(): void {
    for (const inst of this.instances.values()) {
      const ok = this.evalEligible(inst);
      inst.eligible = ok;
      if (ok && !inst.stopped) this.ensureSim(inst);
      else if (inst.sim) inst.sim = null;
    }
  }

  // ------------------------------------------------------------------ 对外（动作 / 条件 / 调试）

  /** 条件叶 `vfxState`：不在场 → null */
  getInstanceState(id: string): VfxInstanceState | null {
    const inst = this.instances.get(id);
    if (!inst) return null;
    if (!inst.sim) return 'inactive';
    return inst.sim.state;
  }

  /**
   * `playVfx`：按实例 id 开（被 stop 过的重开；条件不满足仍不开），或现场生成一个临时实例
   * （`effect` + `anchor`，不在布置库里，切场景即散）。
   */
  playVfx(opts: {
    instanceId?: string; effect?: string; anchor?: VfxAnchorDef; seed?: number; countScale?: number;
    /** 跟随锚点（世界 wu）：给了就用它当锚，随后由 `moveInstanceAnchor` 逐帧挪 */
    followWorld?: Vec3;
  }): string | null {
    if (opts.instanceId) {
      const inst = this.instances.get(opts.instanceId);
      if (!inst) { this.deps.log(`playVfx: 当前场景没有实例「${opts.instanceId}」`); return null; }
      inst.stopped = false;
      if (inst.sim) inst.sim.start();
      this.conditionsDirty = true;
      return opts.instanceId;
    }
    if (!opts.effect || !(opts.anchor || opts.followWorld)) {
      this.deps.log('playVfx: 需要 instanceId，或 effect + anchor/followWorld');
      return null;
    }
    const id = `__vfx_${opts.effect}_${++this.transientSeq}`;
    const anchor: VfxAnchorDef = opts.anchor ?? { x: 0, y: 0 };
    const def: VfxInstanceDef = { id, effect: opts.effect, anchor, seed: opts.seed, countScale: opts.countScale, autoStart: true };
    const inst: InstanceRuntime = {
      def, effect: null, sim: null, eligible: true, stopped: false, loopAt: -Infinity, transient: true,
      followWorld: opts.followWorld ? [opts.followWorld[0], opts.followWorld[1], opts.followWorld[2]] : null,
    };
    this.instances.set(id, inst);
    this.loadInstanceEffect(inst);
    return id;
  }

  /**
   * 跟随实例：把锚点挪到世界点（手持光源逐帧调）。已发射的粒子留在原地（见 `VfxInstanceSim.moveAnchor`）。
   * 实例不在场（切场景散了 / 还没装完）时安静返回 false —— 调用方据此知道要不要重开。
   */
  moveInstanceAnchor(instanceId: string, world: Vec3): boolean {
    const inst = this.instances.get(instanceId);
    if (!inst) return false;
    inst.followWorld = [world[0], world[1], world[2]];
    inst.sim?.moveAnchor(world);
    return true;
  }

  /** 发射率倍率（火焰输出 `L(t)` 驱动）。实例不在场时忽略。 */
  setInstanceRateScale(instanceId: string, k: number): void {
    this.instances.get(instanceId)?.sim?.setRateScale(k);
  }

  private transientSeq = 0;

  stopVfx(instanceId: string): void {
    const inst = this.instances.get(instanceId);
    if (!inst) return;
    inst.stopped = true;
    this.softStopped.delete(instanceId);
    if (inst.transient) { this.instances.delete(instanceId); return; }
    inst.sim?.stop();
  }

  /**
   * 软停：**不再发射**，在飞的粒子照自己的寿命飞完，空了才删（临时实例）。
   *
   * 火把从"点着"切到"残炭"要的就是这个：火舌停了，空中那几点火星该飞完再灭，
   * `stopVfx` 对临时实例是当场删除（整团凭空消失），演出上是假的。
   */
  stopVfxSoft(instanceId: string): void {
    const inst = this.instances.get(instanceId);
    if (!inst) return;
    inst.stopped = true;
    inst.sim?.stop();
    if (inst.transient) this.softStopped.add(instanceId);
  }

  /** 软停待收的临时实例 id（等在飞的粒子老化完） */
  private softStopped = new Set<string>();

  setVfxState(instanceId: string, state: VfxFlockState): void {
    const inst = this.instances.get(instanceId);
    inst?.sim?.setFlockState(state);
  }

  /** 发一个刺激场（世界点）。`handle` 给常驻场（同名覆盖），不给 = 按 duration 自灭 */
  emitField(def: VfxFieldDef, at: Vec3, handle?: string): void {
    if (handle) {
      const i = this.fields.findIndex((f) => f.handle === handle);
      const f = createFieldRuntime(def, at, handle);
      if (i >= 0) this.fields[i] = f; else this.fields.push(f);
      return;
    }
    this.fields.push(createFieldRuntime(def, at));
  }

  removeField(handle: string): void {
    const i = this.fields.findIndex((f) => f.handle === handle);
    if (i >= 0) this.fields.splice(i, 1);
  }

  /** 画面点 → 世界（动作参数 `at` 解析用；没有空间时 null） */
  sceneToWorld(sceneX: number, sceneY: number, h = 0): Vec3 | null {
    if (!this.space) return null;
    const g = this.space.groundWorldAtScene(sceneX, sceneY);
    return [g[0], g[1] + h, g[2]];
  }

  /**
   * 粒子工作台联动（DEV）：用工作态的效果定义覆盖缓存，并重建所有引用它的实例（锚点不变）。
   * 与上一次套上的逐字相同 ⇒ 不动。`def = null` 撤销覆盖：丢掉 JSON 缓存、当场从盘上重读并重建。
   */
  applyPreviewEffect(effectId: string, def: VfxEffectDef | null): void {
    if (def) {
      // 定义逐字没变就什么都不动：工作台每次发布（拖布置区域顶点、换场景 / 时段外观、3 分钟保活）都会带着
      // 同一份效果再来一遍，原来照样把这个效果的所有实例重建一遍——作者只挪了「纸钱_山顶」的一个顶点，
      // 「纸钱_坡下」也重新铺撒、群重新归巢。换场景不用靠这里重套：覆盖留在 effectCache 里，rebuildScene 自己取到
      const json = JSON.stringify(def);
      if (this.previewEffectJson.get(effectId) === json) return;
      this.previewEffectJson.set(effectId, json);
      this.effectCache.set(effectId, Promise.resolve(def));
    } else {
      this.previewEffectJson.delete(effectId);
      this.effectCache.delete(effectId);
      // 撤销覆盖 = 回到**盘上此刻**那份：AssetManager 的 JSON 桶不丢，loadEffect 拿回的是开局缓存的旧版
      // （作者 Ctrl+S 存了、换去编别的效果，游戏里这个效果就退回改之前的样子，直到刷新页面）
      this.deps.assetManager.dropJson(vfxEffectJsonUrl(effectId));
    }
    for (const inst of this.instances.values()) {
      if (inst.def.effect !== effectId) continue;
      inst.sim = null;
      inst.effect = null;
      this.loadInstanceEffect(inst);
    }
  }

  /**
   * 粒子工作台联动（DEV）：仅覆盖工作台实际编辑的场景 × 外观；当前场景当前外观那一份的实例
   * 按 id 差分重建（没变的实例不动——作者挪一个顶点，别的群不该重飞）。`lib = null` 撤销（回到盘上那份）。
   */
  applyPreviewPlacementLibrary(lib: VfxPlacementLibrary | null): void {
    const next = lib && typeof lib === 'object' && lib.scenes && typeof lib.scenes === 'object' ? lib : null;
    if (JSON.stringify(next) === JSON.stringify(this.libraryOverride)) return;
    // 保存 / 撤销 / 放弃后某份退出预览：重新读取正式资源，不回到游戏会话最初缓存的旧值。
    const dropped = Object.entries(this.libraryOverride?.scenes ?? {}).some(([sid, ent]) =>
      (Array.isArray(ent.base) && this.previewRows(sid, '', next) === undefined)
      || Object.keys(ent.variants ?? {}).some((phase) => this.previewRows(sid, phase, next) === undefined));
    if (dropped) {
      this.deps.assetManager.dropJson(TEXT_URLS.vfxPlacements);
      this.library = null;
    }
    this.libraryOverride = next;
    const built = this.builtPlacement;
    if (!built) return;
    const gen = this.generation;
    void this.loadLibrary().then((disk) => {
      if (gen !== this.generation) return;
      const b = this.builtPlacement;
      if (!b) return;
      this.applyPlacementRows(this.placementRows(disk, b.sceneId, b.phase));
    });
  }

  /** 已建的实例表取自哪一份（工作台回传「游戏此刻用的是哪份布置」）；没进场景 null */
  get currentPlacement(): { sceneId: string; phase: string; preview: boolean } | null {
    const b = this.builtPlacement;
    return b ? { ...b, preview: this.previewRows(b.sceneId, b.phase) !== undefined } : null;
  }

  /** 工作台联动：当前场景里引用某效果的实例 id（回传给工作台画状态用） */
  instancesOfEffect(effectId: string): string[] {
    const out: string[] = [];
    for (const inst of this.instances.values()) if (inst.def.effect === effectId) out.push(inst.def.id);
    return out;
  }

  /** 当前模拟空间（F2 用来分清"真 3D 场"与"平面近似"——后者所有几何判据都空成立）。 */
  get currentSpace(): VfxSpace | null { return this.space; }

  get stats(): { instances: number; live: number; drawCalls: number; fields: number; simMs: number } {
    return this.lastStats;
  }

  /** 调试面板读：每个实例的状态（限定了粒子区域的另带区域统计） */
  debugSnapshot(): VfxInstanceDebugRow[] {
    const out: VfxInstanceDebugRow[] = [];
    for (const inst of this.instances.values()) {
      const cf = inst.sim?.confine ?? null;
      out.push({
        id: inst.def.id, effect: inst.def.effect, state: this.getInstanceState(inst.def.id) ?? 'n/a',
        live: inst.sim?.liveCount ?? 0, eligible: inst.eligible,
        confine: cf ? { feather: cf.feather, ceiling: cf.ceiling, ...inst.sim!.confineStats()! } : null,
      });
    }
    return out;
  }

  /** 在场实例的范围区域（权重场）与发射区域（F2 叠加层画框线、边带内沿、发射区域用） */
  confineFields(): { id: string; field: ConfineField; emit: [number, number][] | null }[] {
    const out: { id: string; field: ConfineField; emit: [number, number][] | null }[] = [];
    for (const inst of this.instances.values()) {
      const cf = inst.sim?.confine;
      // 范围区域没单独画时就是发射区域本身：不再重复画一遍青线
      const separate = Array.isArray(inst.def.area) && Array.isArray(inst.def.confine?.area);
      if (cf) out.push({ id: inst.def.id, field: cf, emit: separate ? inst.def.area! : null });
    }
    return out;
  }

  // ------------------------------------------------------------------ 每帧

  update(dt: number): void {
    if (!this.enabled || !this.space) return;
    // 自愈：进场景时照明载荷往往还没到，实例先建在平面近似上（没有地面高低、没有墙，
    // 所有几何判据都空成立）。载荷一落地就换成真 3D 场重建——判据便宜（只读几个 getter），
    // 真正贵的建高度场只在 kind 真的要变时才发生。
    if (this.space.kind === 'planar' && this.deps.hasFieldGeometry()) {
      void this.rebuildScene();
      return;
    }
    if (this.placementKeyDirty) this.syncPlacementKey();
    this.time += dt;
    this.recheckIn -= dt;
    if (this.conditionsDirty || this.recheckIn <= 0) {
      this.conditionsDirty = false;
      this.recheckIn = CONDITION_RECHECK_S;
      this.refreshConditions();
    }
    // ---- 玩家：脚点世界坐标 + 速度（差分，低通）
    const pc = this.deps.getPlayerContact();
    let player: { world: Vec3; speed: number } | null = null;
    if (pc) {
      if (this.playerPrev && dt > 0) {
        const v = Math.hypot(pc.x - this.playerPrev.x, pc.y - this.playerPrev.y) / dt;
        this.playerSpeed += (v - this.playerSpeed) * Math.min(1, dt * 8);
      }
      this.playerPrev = { x: pc.x, y: pc.y };
      const w = this.space.groundWorldAtScene(pc.x, pc.y);
      player = { world: w, speed: this.playerSpeed };
      // 玩家动静场（常驻、跟随）
      const strength = Math.min(1.5, this.playerSpeed / PLAYER_MOTION_FULL_SPEED);
      const at: Vec3 = [w[0], w[1] + PLAYER_MOTION_HEIGHT_WU, w[2]];
      if (!this.playerField) {
        this.playerField = createFieldRuntime({ kind: 'fear', tag: 'player:motion', radius: PLAYER_MOTION_RADIUS_WU, strength }, at, 'player:motion');
        this.fields.push(this.playerField);
      } else {
        this.playerField.pos[0] = at[0]; this.playerField.pos[1] = at[1]; this.playerField.pos[2] = at[2];
        this.playerField.def = { ...this.playerField.def, strength };
      }
    }
    const air = this.playerAirflow.sample(player?.world ?? null, dt,
      player ? this.space.metricAt(player.world[0], player.world[2]) : 1);
    if (player) { if (!this.fields.includes(air)) this.fields.push(air); }
    else { const i = this.fields.indexOf(air); if (i >= 0) this.fields.splice(i, 1); }
    // ---- 灯当恐惧源（时段一变灯表就变，按 key 重建）
    this.refreshLightFields();
    // ---- 场老化
    for (let i = this.fields.length - 1; i >= 0; i--) {
      const f = this.fields[i];
      if (f.remaining === Infinity) continue;
      f.remaining -= dt;
      if (f.remaining <= 0) this.fields.splice(i, 1);
    }
    // ---- 模拟
    const t0 = performance.now();
    const wind = this.deps.getWind?.() ?? null;
    const ctx = { fields: this.fields, player, time: this.time, wind: wind?.params ?? null, windTime: wind?.time ?? 0 };
    const sims: VfxInstanceSim[] = [];
    let live = 0;
    for (const inst of this.instances.values()) {
      const sim = inst.sim;
      if (!sim) continue;
      sim.step(dt, ctx);
      live += sim.liveCount;
      sims.push(sim);
      this.handleEvents(inst, sim);
    }
    const simMs = performance.now() - t0;
    // ---- 收尸：软停的临时实例等在飞的粒子老化完再删（火舌停了，空中那几点火星该飞完）
    if (this.softStopped.size > 0) {
      for (const id of [...this.softStopped]) {
        const inst = this.instances.get(id);
        if (!inst) { this.softStopped.delete(id); continue; }
        if (!inst.sim || inst.sim.liveCount === 0) {
          this.instances.delete(id);
          this.softStopped.delete(id);
        }
      }
    }
    // ---- 渲染
    if (this.renderer) this.renderer.render(sims, this.sheets);
    this.lastStats = {
      instances: sims.length, live, drawCalls: this.renderer?.drawCallCount ?? 0,
      fields: this.fields.length, simMs,
    };
  }

  private handleEvents(inst: InstanceRuntime, sim: VfxInstanceSim): void {
    for (const ev of sim.events) {
      if (ev.type === 'sound') this.deps.playSfxAt(ev.sfx, ev.at);
      else if (ev.type === 'field') this.emitField(ev.def, ev.at);
      else if (ev.type === 'hit') {
        const e = sim.emitters.find((x) => x.def.id === ev.emitter);
        if (e?.def.sound?.hit) this.deps.playSfxAt(e.def.sound.hit, ev.at);
      }
    }
    // 循环声：飞着的群按节奏重触发一次性音（空间音总线没有 loop）
    for (const e of sim.emitters) {
      const loop = e.def.sound?.loop;
      if (!loop) continue;
      const flying = e.flock ? (e.flock.state !== 'roosting') : e.p.liveCount > 0;
      if (!flying) continue;
      if (this.time - inst.loopAt >= LOOP_SFX_PERIOD_S) {
        inst.loopAt = this.time;
        this.deps.playSfxAt(loop, sim.centroid([0, 0, 0]));
      }
    }
  }

  private refreshLightFields(): void {
    const lights = this.deps.getActiveLights();
    let key = '';
    for (const l of lights) if (l.pos) key += `${l.id}:${l.pos[0]},${l.pos[1]},${l.pos[2]},${l.intensity},${l.range ?? ''};`;
    if (key === this.lightsKey) return;
    this.lightsKey = key;
    for (const f of this.lightFields) {
      const i = this.fields.indexOf(f);
      if (i >= 0) this.fields.splice(i, 1);
    }
    this.lightFields = [];
    for (const l of lights) {
      if (!l.pos || !(l.intensity > 0)) continue;
      const f = createFieldRuntime(
        { kind: 'fear', tag: 'light', radius: l.range ?? 450, strength: Math.min(3, l.intensity * LIGHT_FIELD_STRENGTH_PER_INTENSITY) },
        [l.pos[0], l.pos[1], l.pos[2]], `light:${l.id}`,
      );
      this.lightFields.push(f);
      this.fields.push(f);
    }
  }
}
