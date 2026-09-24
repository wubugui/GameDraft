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
  VfxFireSegment,
  VfxFlockState,
  VfxInstanceDef,
  VfxInstanceState,
  VfxPlacementLibrary,
} from '../../data/types';
import { TEXT_URLS, burnableJsonUrl, vfxEffectJsonUrl } from '../../core/projectPaths';
import { resolveBurnable, type ResolvedBurnable } from '../../data/burnables';
import type { VfxRenderer, VfxSortHost, VfxSpriteSheet } from '../../rendering/vfx/VfxRenderer';
import type { Vec3 } from '../../utils/sceneSpace';
import type { SceneWindParams } from '../../utils/sceneWind';
import { evaluateConditionExpr, type ConditionEvalContext } from '../graphDialogue/evaluateGraphCondition';
import type { ConfineField } from './vfxConfine';
import { hashSeed } from './vfxRandom';
import { flockHarassmentRate } from './vfxHarassment';
import { VfxMotionAirflow } from './vfxMotionSource';
import { VfxMotionContact } from './vfxContact';
import {
  VfxInstanceSim, createFieldRuntime, type VfxBurningPlateGroup, type VfxFieldRuntime, type VfxStepContext,
} from './vfxSim';
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
/**
 * 预热按帧分片的预算，工作量单位 = 子步 × `VfxInstanceSim.prewarmStepCost`（发射器数 + 粒子槽位）。
 * 按工作量切、不按毫秒切：不读挂钟，同一串 dt 下第几帧跑完逐位可复现（无头逐帧断言靠它）。
 * 进场景的实例在揭幕闸里（遮罩下）已经跑完，走到这里的是场景中途新建的模拟：条件翻真、换时段外观、
 * `playVfx` 重开、粒子工作台推新定义、载荷晚到整批重建、揭幕闸超时。标定见 agent_docs vfx-system「代价」。
 */
const PREWARM_UNITS_PER_FRAME = 4000;
/** 揭幕闸里每跑这么多就让出一次主线程（遮罩下，加载动画与音频保活也要喘口气） */
const PREWARM_UNITS_PER_REVEAL_SLICE = 40000;

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
  /**
   * 燃烧系统：某个**布置实例**里哪些可燃薄片已经烧没了（发射器序号 → 槽位）。建模拟时恢复（永久没了、不补回）。
   * 不注入 / 返回 null = 一张没烧。临时实例不问。
   */
  burntPlatesOf?: (instanceId: string) => ReadonlyMap<number, readonly number[]> | null;
  /**
   * 可燃薄片烧没了（含模拟被收掉 / 离场那一刻**还在烧**的——它们推不出来，按烧没了算）：交给燃烧系统进存档。
   * 只报布置实例（临时实例切场景即散，没有存档意义）。
   */
  onPlatesBurnt?: (instanceId: string, emitterIndex: number, slots: readonly number[]) => void;
}

/** 一个实例里的一组燃着的薄片（给燃烧系统） */
export interface VfxBurningPlateReport {
  instanceId: string;
  transient: boolean;
  group: VfxBurningPlateGroup;
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
  /**
   * 实例倍率（发射率 / 新生粒子大小 / 吃场景风）：手持火把逐帧推（燃烧强度、闪烁、护火）。
   * 存在实例上，模拟重建时重新套上；没被设过 = undefined（全 1）。
   */
  scales?: { rate: number; size: number; wind: number; distance: number };
  /**
   * 挂在实体身上（手里火把的火苗）：每帧问一次宿主节点与挂件此刻在身前还是身后，渲染据此把整团粒子
   * 钉在宿主同一侧（见 `VfxRenderer` 的 `VfxSortHost`）。返回 null = 宿主这一帧不在，照常逐颗分桶。
   */
  sortHost?: () => VfxSortHost | null;
  /** 一次性（`playVfx({oneShot})`）：放完了（`VfxInstanceSim.finished`）就自己收，不用谁来停 */
  oneShot?: boolean;
  /** 最近一次把它开起来的动作串 id（见 `core/actionRun.ts`）；只转给旁听者，收掉时也报这一串 */
  runId?: number;
  /**
   * 带光柱的模拟被条件翻假时不当场收：先 `stop()` 让光柱按 fadeOut 淡掉，淡完再收（`update` 里判 `beamsDark`）。
   * 没有光柱的效果永远不进这个态（与原来"条件一假当场收"逐位相同）。
   */
  draining?: boolean;
  /** 薄片绑的可燃物模板（装效果时一起装好；建模拟时交给它） */
  burnTemplates?: ReadonlyMap<string, ResolvedBurnable>;
  /** Retry only when the effect changes or the scene space is rebuilt. */
  failedConstruction?: { effect: VfxEffectDef; space: VfxSpace };
  loadRevision?: number;
}

const NO_BURN_TEMPLATES: ReadonlyMap<string, ResolvedBurnable> = new Map();

/**
 * 旁听"世界里冒出 / 收掉了一个效果"。`runId` = 开它的动作串（见 `core/actionRun.ts`）；
 * 代码直接放的（燃烧、手持挂件）没有串，为 null。
 */
export type VfxWorldListener = (
  kind: 'start' | 'stop',
  effectId: string,
  anchor: VfxAnchorDef | null,
  runId: number | null,
) => void;

export class VfxSystem implements IGameSystem {
  private eventBus: EventBus | null = null;
  private renderer: VfxRenderer | null = null;
  private readonly instances = new Map<string, InstanceRuntime>();
  private readonly fields: VfxFieldRuntime[] = [];
  private readonly effectCache = new Map<string, Promise<VfxEffectDef | null>>();
  /** 可燃物模板（薄片绑的；燃烧工作台联动的工作态覆盖在 `burnTemplateOverrides`） */
  private readonly burnTemplateCache = new Map<string, Promise<ResolvedBurnable | null>>();
  private burnTemplateOverrides = new Map<string, ResolvedBurnable>();
  /** 粒子工作台联动（DEV）：各效果最近一次套上的工作态定义（JSON 串）；同样的一份再来不重建实例 */
  private readonly previewEffectJson = new Map<string, string>();
  private readonly sheetCache = new Map<string, Promise<VfxSpriteSheet | null>>();
  private readonly sheets = new Map<string, VfxSpriteSheet>();
  /** 光柱图案遮罩贴图：`<instanceId>/<beamId>`（与 `sheets` 同一个装载 / 清理节拍） */
  private readonly beamTextures = new Map<string, Texture>();
  private readonly beamTextureCache = new Map<string, Promise<Texture | null>>();
  private space: VfxSpace | null = null;
  private generation = 0;
  private time = 0;
  private recheckIn = 0;
  private conditionsDirty = true;
  private playerPrev: { x: number; y: number } | null = null;
  private playerSpeed = 0;
  private playerField: VfxFieldRuntime | null = null;
  private readonly playerAirflow = new VfxMotionAirflow('player:motion');
  private readonly playerContact = new VfxMotionContact();
  private lightFields: VfxFieldRuntime[] = [];
  private lightsKey = '';
  private readonly onSceneReady: () => void;
  private readonly onSceneUnload: () => void;
  private readonly onConditionsMaybeChanged: () => void;
  private enabled = true;
  private lastStats = { instances: 0, live: 0, drawCalls: 0, fields: 0, simMs: 0, beams: 0 };
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
  /** 在途的场景重建（scene:ready / 载荷晚到自愈）；揭幕闸要等它把布置表建出来 */
  private rebuilding: Promise<void> | null = null;
  /** 在途的实例资产装载（效果 JSON / 贴图 / 模板）；揭幕闸等它们落地 */
  private readonly pendingLoads = new Set<Promise<void>>();
  /** 揭幕闸里在途的等待（各带一个定时器）：销毁时逐个撤掉并放行 */
  private readonly revealWaits = new Set<() => void>();

  constructor(private readonly deps: VfxSystemDeps) {
    this.onSceneReady = () => { void this.startRebuild(); };
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
    for (const cancel of [...this.revealWaits]) cancel();
    this.revealWaits.clear();
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
    this.burnTemplateCache.clear();
    this.burnTemplateOverrides.clear();
    this.previewEffectJson.clear();
    this.sheetCache.clear();
    this.beamTextureCache.clear();
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
    void this.startRebuild();
  }

  /**
   * 揭幕闸（`SceneManager.loadScene` 在 scene:ready 之后、撤遮罩之前 await）：在遮罩下把本场景此刻的粒子备齐——
   * 布置表建好、效果与贴图装完、模拟建好、预热跑完。揭幕后第一帧看到的就是"已经在跑"的样子，
   * 也不再有哪一帧同步补跑几百毫秒的预热（茶馆 30 个实例原来挤在揭幕后第一帧，实测 361 ms）。
   *
   * - 只备此刻：条件不满足、被停掉的实例不建（它们之后翻真 / `playVfx` 时走 `update` 的分帧预热）；
   * - 限时：超时就放行揭幕，没跑完的由 `update` 按帧预算接着跑——不把揭幕扣成人质；
   * - 等待中换了场景（世代变了）立刻收手；系统销毁时在途的等待全部放行。永不悬挂。
   */
  async prepareForReveal(timeoutMs: number): Promise<void> {
    if (!this.enabled || !this.space) return;
    const deadline = performance.now() + Math.max(0, timeoutMs);
    // 载荷的几何项在 scene:ready 同一拍里（排在本系统后面的监听里）才落地：在遮罩下先升级成真 3D，
    // 否则揭幕后第一帧自愈重建，已经预热好的模拟整批作废重来
    if (this.space.kind === 'planar' && this.deps.hasFieldGeometry()) void this.startRebuild();
    // 布置库 → 布置表 → 各实例资产：重建完才登记实例装载，所以等到"没有在途的"为止
    for (;;) {
      const inflight: Promise<unknown>[] = [...this.pendingLoads];
      if (this.rebuilding) inflight.push(this.rebuilding);
      if (inflight.length === 0) break;
      if (!(await this.revealWait(Promise.all(inflight), deadline))) { this.revealTimedOut('粒子资产装载'); return; }
    }
    if (!this.enabled || !this.space) return;
    const gen = this.generation;
    this.refreshConditions();
    const ctx = this.prewarmContext();
    for (;;) {
      let budget = PREWARM_UNITS_PER_REVEAL_SLICE;
      let left = 0;
      for (const inst of this.instances.values()) {
        const sim = inst.sim;
        if (!sim || sim.prewarmRemaining <= 0) continue;
        budget -= this.advancePrewarm(sim, ctx, budget, PREWARM_UNITS_PER_REVEAL_SLICE);
        if (sim.prewarmRemaining > 0) left++;
      }
      if (left === 0) return;
      if (performance.now() >= deadline) { this.revealTimedOut(`粒子预热（还剩 ${left} 个实例）`); return; }
      if (!(await this.revealWait(null, deadline))) return;
      if (gen !== this.generation || !this.enabled || !this.space) return;
    }
  }

  /** 预热的上下文：只剩风与外部火焰段（玩家 / 刺激场 / 接触模拟自己剔掉）；时间取系统此刻 */
  private prewarmContext(): VfxStepContext {
    const wind = this.deps.getWind?.() ?? null;
    const fires: VfxFireSegment[] = [];
    for (const segs of this.fireSources.values()) for (const s of segs) fires.push(s);
    return {
      fields: [], contacts: [], player: null, time: this.time,
      wind: wind?.params ?? null, windTime: wind?.time ?? 0, fires,
    };
  }

  /**
   * 按工作量预算推一段预热，返回用掉的单位。一步都放不下时，只要预算还是满的（这一片的第一笔）也推一步——
   * 单步就超预算的大实例不许永远轮不上。
   */
  private advancePrewarm(sim: VfxInstanceSim, ctx: VfxStepContext, budget: number, full: number): number {
    const cost = sim.prewarmStepCost;
    let steps = Math.floor(budget / cost);
    if (steps <= 0 && budget >= full) steps = 1;
    return steps > 0 ? sim.advancePrewarm(ctx, steps) * cost : 0;
  }

  /**
   * 揭幕闸里的一次等待：`p` 落地（`null` = 只让出一轮主线程）或到 `deadline`。
   * true = 等到了；false = 超时 / 系统销毁。定时器登记在 `revealWaits`，销毁时撤掉。
   */
  private revealWait(p: Promise<unknown> | null, deadline: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let open = true;
      const finish = (ok: boolean): void => {
        if (!open) return;
        open = false;
        clearTimeout(timer);
        this.revealWaits.delete(cancel);
        resolve(ok);
      };
      const cancel = (): void => finish(false);
      const timer = setTimeout(p ? cancel : () => finish(true), p ? Math.max(0, deadline - performance.now()) : 0);
      this.revealWaits.add(cancel);
      p?.then(() => finish(true), () => finish(true));
    });
  }

  private revealTimedOut(what: string): void {
    if (!this.eventBus) return;   // 是系统销毁撤掉的等待，不是超时
    this.deps.log(`vfx: 揭幕前${what}没在限时内做完，先揭幕，剩下的按帧接着跑`);
  }

  /**
   * 收掉一个实例的模拟。布置实例里**还在烧**的可燃薄片推不出来（表演态不入档），按烧没了报给燃烧系统；
   * 新烧没的一并报掉。所有丢模拟的地方都走这里，否则切场景 / 条件翻 / 布置改动时正烧着的纸会以新纸的样子回来。
   */
  private retireSim(inst: InstanceRuntime): void {
    const sim = inst.sim;
    inst.sim = null;
    if (!sim || inst.transient || !this.deps.onPlatesBurnt) return;
    for (const r of sim.takeNewlyBurnt()) this.deps.onPlatesBurnt(inst.def.id, r.emitterIndex, r.slots);
    for (const r of sim.burningSlots()) this.deps.onPlatesBurnt(inst.def.id, r.emitterIndex, r.slots);
  }

  private clearScene(): void {
    this.generation++;
    for (const inst of this.instances.values()) this.retireSim(inst);
    this.instances.clear();
    // 实例都没了，等着收的那张单子也要清——否则旧场景的 id 永远留在集合里
    this.softStopped.clear();
    this.fireSources.clear();
    this.fields.length = 0;
    this.playerField = null;
    this.playerAirflow.reset();
    this.playerContact.reset();
    this.lightFields = [];
    this.lightsKey = '';
    this.sheets.clear();
    this.beamTextures.clear();
    this.space = null;
    this.playerPrev = null;
    this.playerSpeed = 0;
    this.builtPlacement = null;
    this.placementKeyDirty = false;
    // 旧场景的装载各自按世代作废；揭幕闸不必再等它们
    this.pendingLoads.clear();
    this.renderer?.clear();
  }

  /** 重建本场景并记住在途的那一次（揭幕闸要等它）。失败出声，不留未处理的拒绝。 */
  private startRebuild(): Promise<void> {
    const p = this.rebuildScene();
    this.rebuilding = p;
    const settle = (): void => { if (this.rebuilding === p) this.rebuilding = null; };
    p.then(settle, (e) => { settle(); this.deps.log(`vfx: 场景粒子重建失败：${String(e)}`); });
    return p;
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
      this.retireSim(inst);
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
    const loading: Promise<void> = this.loadEffect(inst.def.effect).then(async effect => {
      if (!current()) return;
      if (!effect) { this.deps.log(`vfx: 实例「${inst.def.id}」的效果「${inst.def.effect}」装不到，跳过`); return; }
      const sheets = await Promise.all(effect.emitters.map(async e => [e.id, await this.loadSheet(e.appearance)] as const));
      const cookies = await Promise.all((effect.beams ?? []).map(async b =>
        [b.id, b.cookie?.image ? await this.loadBeamTexture(b.cookie.image) : null, b.cookie?.image] as const));
      // 没有薄片绑可燃模板的效果不多等一拍（装载时序与没有可燃之前逐位相同）
      const burnTemplates = effect.emitters.some((em) => em.plate?.burnable?.template)
        ? await this.loadPlateBurnTemplates(effect)
        : NO_BURN_TEMPLATES;
      if (!current()) return;
      inst.burnTemplates = burnTemplates;
      // Publish one coherent effect and sheet set. Earlier preview requests cannot overwrite it.
      for (const key of this.sheets.keys()) if (key.startsWith(`${inst.def.id}/`)) this.sheets.delete(key);
      for (const key of this.beamTextures.keys()) if (key.startsWith(`${inst.def.id}/`)) this.beamTextures.delete(key);
      for (const [id, sheet] of sheets) {
        if (sheet) this.sheets.set(`${inst.def.id}/${id}`, sheet);
        else this.deps.log(`vfx: 发射器「${effect.id}/${id}」的贴图装不到`);
      }
      for (const [id, tex, image] of cookies) {
        if (tex) this.beamTextures.set(`${inst.def.id}/${id}`, tex);
        else if (image) this.deps.log(`vfx: 光柱「${effect.id}/${id}」的图案遮罩「${image}」装不到（先不带图案画）`);
      }
      inst.effect = effect;
      this.conditionsDirty = true;
    }).catch(error => {
      if (current()) this.deps.log(`vfx: 实例「${inst.def.id}」加载失败：${String(error)}`);
    });
    // 上面已兜住一切拒绝：这条只会 resolve
    this.pendingLoads.add(loading);
    void loading.then(() => { this.pendingLoads.delete(loading); });
  }

  /**
   * 效果里薄片绑的可燃物模板（`plate.burnable.template`）一次装齐。装不到 / 是消耗燃烧 ⇒ 这张纸不可燃，出声一次。
   */
  private async loadPlateBurnTemplates(effect: VfxEffectDef): Promise<ReadonlyMap<string, ResolvedBurnable>> {
    const ids = new Set<string>();
    for (const em of effect.emitters) {
      const id = em.plate?.burnable?.template;
      if (typeof id === 'string' && id.trim()) ids.add(id.trim());
    }
    const out = new Map<string, ResolvedBurnable>();
    await Promise.all([...ids].map(async (id) => {
      const t = await this.loadBurnTemplate(id);
      if (!t) { this.deps.log(`vfx: 效果「${effect.id}」的薄片绑的可燃物模板「${id}」装不到，这张纸不可燃`); return; }
      if (t.mode !== 'spread') { this.deps.log(`vfx: 效果「${effect.id}」的薄片绑的「${id}」是消耗燃烧，薄片只能绑面燃烧模板，这张纸不可燃`); return; }
      out.set(id, t);
    }));
    return out;
  }

  private loadBurnTemplate(id: string): Promise<ResolvedBurnable | null> {
    const pv = this.burnTemplateOverrides.get(id);
    if (pv) return Promise.resolve(pv);
    let p = this.burnTemplateCache.get(id);
    if (!p) {
      p = this.deps.assetManager.loadJson<unknown>(burnableJsonUrl(id))
        .then((raw) => resolveBurnable(raw, id))
        .catch(() => null);
      this.burnTemplateCache.set(id, p);
    }
    return p;
  }

  /**
   * 燃烧工作台联动（DEV）：可燃物模板的工作态（id → 原始文档；`null` 撤销、回到盘上那份）。
   * 绑了这些模板的效果的实例整批重建（纸钱按新模板烧）。
   */
  applyPreviewBurnTemplates(raw: Record<string, unknown> | null): void {
    const next = new Map<string, ResolvedBurnable>();
    if (raw) for (const [id, doc] of Object.entries(raw)) { const t = resolveBurnable(doc, id); if (t) next.set(id, t); }
    const changed = new Set<string>([...this.burnTemplateOverrides.keys(), ...next.keys()]);
    if (!raw) {
      for (const id of this.burnTemplateOverrides.keys()) this.deps.assetManager.dropJson(burnableJsonUrl(id));
      this.burnTemplateCache.clear();
    }
    this.burnTemplateOverrides = next;
    if (changed.size === 0) return;
    for (const inst of this.instances.values()) {
      const eff = inst.effect;
      if (!eff || !eff.emitters.some((em) => changed.has(em.plate?.burnable?.template ?? ''))) continue;
      this.retireSim(inst);
      inst.effect = null;
      this.loadInstanceEffect(inst);
    }
  }

  /** 光柱图案遮罩（灰度图）：按路径缓存，装不到 = null（由调用方出声） */
  private loadBeamTexture(image: string): Promise<Texture | null> {
    let p = this.beamTextureCache.get(image);
    if (!p) {
      p = this.deps.assetManager.loadTexture(image).then((t: Texture) => t ?? null)
        .catch((e) => { this.deps.log(`vfx: 光柱图案遮罩「${image}」加载失败：${String(e)}`); return null; });
      this.beamTextureCache.set(image, p);
    }
    return p;
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
          burnTemplates: inst.burnTemplates ?? null,
        });
      // 烧没了的纸永久没了：建模拟时（第一次发射之前）恢复，起播铺撒按原次序抽签后收掉
      if (!inst.transient) {
        const burnt = this.deps.burntPlatesOf?.(inst.def.id);
        if (burnt) for (const [emitterIndex, slots] of burnt) inst.sim.applyBurntSlots(emitterIndex, slots);
      }
      // 实例倍率住在实例上、不住在模拟上：几何载荷晚到时整批重建模拟，倍率不能跟着丢
      if (inst.scales) {
        inst.sim.setRateScale(inst.scales.rate);
        inst.sim.setSizeScale(inst.scales.size);
        inst.sim.setWindScale(inst.scales.wind);
        inst.sim.setDistanceScale(inst.scales.distance);
      }
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
      if (ok && !inst.stopped) {
        // 正在淡出的光柱又被开回来（条件翻回真 / playVfx）：原模拟接着淡入，不重建
        if (inst.draining && inst.sim) { inst.draining = false; inst.sim.start(); }
        else this.ensureSim(inst);
      }
      // 软停的临时实例 `stopped` 也是 true，但它的模拟要留着让在飞的粒子飞完、由收尸那段删——
      // 这里一并清掉的话，任何一次条件重算（另一个实例装完效果就会触发）都让整团当场消失
      // （2026-09-15 真跑抓到：火把切状态，46 颗粒子下一拍 43、再下一拍 0）
      else if (inst.sim && !this.softStopped.has(inst.def.id)) {
        // 带光柱的：先按 fadeOut 淡掉，淡完 update 里再收（光柱不许"啪"一下没了）
        if (!inst.sim.beamsDark) {
          if (!inst.draining) { inst.draining = true; inst.sim.stop(); }
        } else {
          inst.draining = false;
          this.retireSim(inst);
        }
      }
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
    /** 具名演出重播时从同一种子/零时刻重建，不接着上次的随机数与轨迹。 */
    restart?: boolean;
    /** 跟随锚点（世界 wu）：给了就用它当锚，随后由 `moveInstanceAnchor` 逐帧挪 */
    followWorld?: Vec3;
    /** 一次性临时实例：效果放完就自己收（手持挂件上的 `playPropVfx`）。一直发的发射器永远放不完 */
    oneShot?: boolean;
    /** 开它的动作串 id（动作 handler 从执行作用域里取）；只转给旁听者，不影响效果本身 */
    runId?: number;
  }): string | null {
    if (opts.instanceId) {
      const inst = this.instances.get(opts.instanceId);
      if (!inst) { this.deps.log(`playVfx: 当前场景没有实例「${opts.instanceId}」`); return null; }
      if (inst.stopped || opts.restart) {
        inst.runId = opts.runId;
        this.notifyWorldListeners('start', inst.def.effect, inst.def.anchor ?? null, inst.runId);
      }
      inst.stopped = false;
      if (opts.restart) {
        this.retireSim(inst);
        inst.draining = false;
        inst.loopAt = -Infinity;
        this.softStopped.delete(opts.instanceId);
      }
      else if (inst.sim) inst.sim.start();
      this.conditionsDirty = true;
      return opts.instanceId;
    }
    if (!opts.effect || !(opts.anchor || opts.followWorld)) {
      this.deps.log('playVfx: 需要 instanceId，或 effect + anchor/followWorld');
      return null;
    }
    this.notifyWorldListeners('start', opts.effect, opts.anchor ?? null, opts.runId);
    const id = `__vfx_${opts.effect}_${++this.transientSeq}`;
    const anchor: VfxAnchorDef = opts.anchor ?? { x: 0, y: 0 };
    const def: VfxInstanceDef = { id, effect: opts.effect, anchor, seed: opts.seed, countScale: opts.countScale, autoStart: true };
    const inst: InstanceRuntime = {
      def, effect: null, sim: null, eligible: true, stopped: false, loopAt: -Infinity, transient: true,
      followWorld: opts.followWorld ? [opts.followWorld[0], opts.followWorld[1], opts.followWorld[2]] : null,
    };
    if (opts.oneShot) inst.oneShot = true;
    if (opts.runId !== undefined) inst.runId = opts.runId;
    this.instances.set(id, inst);
    this.loadInstanceEffect(inst);
    return id;
  }

  /**
   * 跟随实例：把锚点挪到世界点（手持光源逐帧调）。已发射的粒子留在原地；`carry` = 在飞的一起平移这么多
   * （手持挂件动画带出来的位移，见 `VfxInstanceSim.moveAnchor`）。
   * 实例不在场（切场景散了 / 还没装完）时安静返回 false —— 调用方据此知道要不要重开。
   */
  moveInstanceAnchor(instanceId: string, world: Vec3, carry: Vec3 | null = null): boolean {
    const inst = this.instances.get(instanceId);
    if (!inst) return false;
    inst.followWorld = [world[0], world[1], world[2]];
    inst.sim?.moveAnchor(world, carry);
    return true;
  }

  /** 发射率倍率（手持火把：燃烧强度驱动；0 = 不再发）。实例不在场时忽略。 */
  setInstanceRateScale(instanceId: string, k: number): void {
    const inst = this.instances.get(instanceId);
    if (!inst) return;
    (inst.scales ??= { rate: 1, size: 1, wind: 1, distance: 1 }).rate = k;
    inst.sim?.setRateScale(k);
  }

  /** 新生粒子大小倍率（火把燃烧强度 → 火苗大小）。实例不在场时忽略。 */
  setInstanceSizeScale(instanceId: string, k: number): void {
    const inst = this.instances.get(instanceId);
    if (!inst) return;
    (inst.scales ??= { rate: 1, size: 1, wind: 1, distance: 1 }).size = k;
    inst.sim?.setSizeScale(k);
  }

  /** 最远烧到多远的倍率（火把：燃烧强度与风把火焰缩短）。实例不在场时忽略。 */
  setInstanceDistanceScale(instanceId: string, k: number): void {
    const inst = this.instances.get(instanceId);
    if (!inst) return;
    (inst.scales ??= { rate: 1, size: 1, wind: 1, distance: 1 }).distance = k;
    inst.sim?.setDistanceScale(k);
  }

  /** 吃场景风的倍率（火把护火 = 挡风）。实例不在场时忽略。 */
  setInstanceWindScale(instanceId: string, k: number): void {
    const inst = this.instances.get(instanceId);
    if (!inst) return;
    (inst.scales ??= { rate: 1, size: 1, wind: 1, distance: 1 }).wind = k;
    inst.sim?.setWindScale(k);
  }

  /**
   * 外部供点（燃烧系统逐帧推）：给实例里 `external` 形状的发射器换一批出生点（每点 x, y, z, 半径）。
   * 实例不在场 / 模拟还没建时忽略（下一帧会再推）。
   */
  setInstanceSpawnPoints(instanceId: string, pts: Float32Array, count: number): void {
    this.instances.get(instanceId)?.sim?.setSpawnPoints(pts, count);
  }

  /**
   * 火焰段（按来源整份替换）：`burn` = 燃烧系统的火线簇，`heldProp` = 手上燃着且能点火的火头。
   * 可燃薄片碰到会着；燃着的纸本身由粒子系统每帧自己加进去。空数组 = 这个来源这一帧没有火。
   */
  setFireSources(owner: string, segments: readonly VfxFireSegment[]): void {
    if (segments.length === 0) this.fireSources.delete(owner);
    else this.fireSources.set(owner, segments);
  }

  private readonly fireSources = new Map<string, readonly VfxFireSegment[]>();
  private readonly firesScratch: VfxFireSegment[] = [];
  private readonly burningScratch: VfxBurningPlateGroup[] = [];

  /** 此刻燃着的可燃薄片（逐实例逐发射器一组；给燃烧系统发火苗 / 打火光 / 点可燃物） */
  burningPlates(): VfxBurningPlateReport[] {
    const out: VfxBurningPlateReport[] = [];
    for (const inst of this.instances.values()) {
      // 还在预热的模拟是"过去"，看不见：不给燃烧系统发火苗 / 打火光
      if (!inst.sim || inst.sim.prewarmRemaining > 0) continue;
      for (const group of inst.sim.burningPlates(this.burningScratch)) {
        out.push({ instanceId: inst.def.id, transient: inst.transient, group });
      }
    }
    return out;
  }

  /** 此刻还在烧的布置实例纸片槽位（存档那一刻它们推不出来 ⇒ 按烧没了进档；不改动模拟） */
  burningPlateSlots(): { instanceId: string; emitterIndex: number; slots: number[] }[] {
    const out: { instanceId: string; emitterIndex: number; slots: number[] }[] = [];
    for (const inst of this.instances.values()) {
      if (!inst.sim || inst.transient) continue;
      for (const r of inst.sim.burningSlots()) out.push({ instanceId: inst.def.id, ...r });
    }
    return out;
  }

  /** 把实例钉到宿主身上排序（`null` 解绑）。实例不在场时忽略。 */
  setInstanceSortHost(instanceId: string, host: (() => VfxSortHost | null) | null): void {
    const inst = this.instances.get(instanceId);
    if (!inst) return;
    if (host) inst.sortHost = host;
    else delete inst.sortHost;
  }

  private transientSeq = 0;

  stopVfx(instanceId: string): void {
    const inst = this.instances.get(instanceId);
    if (!inst) return;
    if (!inst.stopped) this.notifyWorldListeners('stop', inst.def.effect, inst.def.anchor ?? null, inst.runId);
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
    if (!inst.stopped) this.notifyWorldListeners('stop', inst.def.effect, inst.def.anchor ?? null, inst.runId);
    inst.stopped = true;
    inst.sim?.stop();
    if (inst.transient) this.softStopped.add(instanceId);
  }

  /** 软停待收的临时实例 id（等在飞的粒子老化完） */
  private softStopped = new Set<string>();

  /**
   * 旁听"世界里冒出 / 收掉了一个效果"（演出与代码直接放的都算，场景布置库自带的常驻效果不算）。
   * 世界脑靠它看见雷、雨、火光……不必逐个技能接线。纯旁听：抛了也吞掉，没人订阅时是一次空集合判断。
   */
  private worldListeners = new Set<VfxWorldListener>();

  addWorldListener(fn: VfxWorldListener): () => void {
    this.worldListeners.add(fn);
    return () => { this.worldListeners.delete(fn); };
  }

  private notifyWorldListeners(
    kind: 'start' | 'stop',
    effectId: string | undefined,
    anchor: VfxAnchorDef | null,
    runId: number | undefined,
  ): void {
    if (this.worldListeners.size === 0 || !effectId) return;
    for (const fn of this.worldListeners) {
      try {
        fn(kind, effectId, anchor, runId ?? null);
      } catch {
        /* 旁听方故障绝不影响粒子系统 */
      }
    }
  }

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
      this.retireSim(inst);
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

  get stats(): { instances: number; live: number; drawCalls: number; fields: number; simMs: number; beams: number } {
    return this.lastStats;
  }

  /**
   * 此刻在场、开着的效果 id（去重）：世界脑拼"世界此刻的样子"用（雨、烟、火光……）。
   * 被条件关掉的、停了的不算。
   */
  runningEffectIds(): string[] {
    const out = new Set<string>();
    for (const inst of this.instances.values()) {
      if (!inst.eligible || inst.stopped || !inst.sim || !inst.def.effect) continue;
      out.add(inst.def.effect);
    }
    return [...out];
  }

  /** 调试面板读：每个实例的状态（限定了粒子区域的另带区域统计） */
  debugSnapshot(): VfxInstanceDebugRow[] {
    const out: VfxInstanceDebugRow[] = [];
    for (const inst of this.instances.values()) {
      const cf = inst.sim?.confine ?? null;
      out.push({
        id: inst.def.id, effect: inst.def.effect,
        state: inst.sim && inst.sim.prewarmRemaining > 0 ? 'prewarming' : this.getInstanceState(inst.def.id) ?? 'n/a',
        live: inst.sim?.liveCount ?? 0, eligible: inst.eligible,
        confine: cf ? { feather: cf.feather, ceiling: cf.ceiling, ...inst.sim!.confineStats()! } : null,
      });
    }
    return out;
  }

  /** 同一种效果/发射器即使被重复布置也只算一次；组装层交给统一伤害系统。 */
  playerHarassment(): { sourceId: string; attackPerSecond: number }[] {
    const pc = this.deps.getPlayerContact();
    if (!this.enabled || !this.space || !pc) return [];
    const player = this.space.groundWorldAtScene(pc.x, pc.y);
    const rates = new Map<string, number>();
    for (const inst of this.instances.values()) {
      if (!inst.eligible || inst.stopped || inst.draining || !inst.sim || inst.sim.prewarmRemaining > 0) continue;
      for (const emitter of inst.sim.emitters) {
        const rate = flockHarassmentRate(emitter, player);
        const sourceId = `vfx:${inst.def.effect}:${emitter.def.id}`;
        if (rate > 0) rates.set(sourceId, Math.max(rate, rates.get(sourceId) ?? 0));
      }
    }
    return [...rates].map(([sourceId, attackPerSecond]) => ({ sourceId, attackPerSecond }));
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
      void this.startRebuild();
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
    const contact = this.playerContact.sample(player?.world ?? null, dt,
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
    // 火焰段：外部来源 + 各实例这一帧开头燃着的纸（一帧的延迟，确定性：按实例表次序收集）
    const fires = this.firesScratch;
    fires.length = 0;
    for (const segs of this.fireSources.values()) for (const s of segs) fires.push(s);
    for (const inst of this.instances.values()) {
      if (inst.sim && inst.sim.prewarmRemaining === 0) inst.sim.plateFireSegments(fires);
    }
    const ctx: VfxStepContext = {
      fields: this.fields, contacts: contact ? [contact] : [], player, time: this.time,
      wind: wind?.params ?? null, windTime: wind?.time ?? 0, fires,
    };
    const sims: VfxInstanceSim[] = [];
    let live = 0;
    const hosts = new Map<string, VfxSortHost>();
    let prewarmBudget = PREWARM_UNITS_PER_FRAME;
    for (const inst of this.instances.values()) {
      const sim = inst.sim;
      if (!sim) continue;
      if (sim.prewarmRemaining > 0) {
        // 还在预热 = 还是"过去"：不画、不正常推进、不出事件。按帧预算推一截；跑完的这一帧照常接上
        // （预算够一帧跑完时，与原来"第一次 step 里一口气补完"逐位相同）
        prewarmBudget -= this.advancePrewarm(sim, ctx, prewarmBudget, PREWARM_UNITS_PER_FRAME);
        if (sim.prewarmRemaining > 0) continue;
      }
      const host = inst.sortHost?.();
      if (host) hosts.set(sim.id, host);
      sim.step(dt, ctx);
      live += sim.liveCount;
      sims.push(sim);
      this.handleEvents(inst, sim);
      if (!inst.transient && this.deps.onPlatesBurnt) {
        for (const r of sim.takeNewlyBurnt()) this.deps.onPlatesBurnt(inst.def.id, r.emitterIndex, r.slots);
      }
    }
    const simMs = performance.now() - t0;
    // ---- 收尸：条件翻假 / 被停后淡出中的光柱，淡完再收模拟（这一帧照样交给渲染，亮度 0 不画）
    for (const inst of this.instances.values()) {
      if (inst.draining && inst.sim?.beamsDark) {
        inst.draining = false;
        this.retireSim(inst);
      }
    }
    // ---- 收尸：一次性临时实例放完就删（手持挂件上播的熄灭烟）
    for (const [id, inst] of this.instances) {
      if (inst.transient && inst.oneShot && inst.sim?.finished) {
        this.instances.delete(id);
        this.softStopped.delete(id);
      }
    }
    /**
     * ---- 收尸（兜底）：**停了、又没有模拟**的临时实例再也做不了任何事（停了的不会再 `ensureSim`），
     * 留在表里就是只涨不掉的记账。软停之后模拟被条件重算收走、还没装出模拟就被停掉（点着当帧又熄）都归它。
     * 2026-09-16 真跑抓到：火把点一次灭一次，`instances` 稳定 +2 再不掉。
     * ⚠ 两种不能碰：还没装完、但没被停的（模拟正在路上）；建不出模拟但没被停的
     *   （粒子工作台把坏效果改好之后还要靠它恢复，见 `VfxSystem.inputs.test.ts`）。
     */
    for (const [id, inst] of this.instances) {
      if (!inst.transient || inst.sim || !inst.stopped) continue;
      this.instances.delete(id);
      this.softStopped.delete(id);
    }
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
    if (this.renderer) this.renderer.render(sims, this.sheets, hosts, this.beamTextures);
    this.lastStats = {
      instances: sims.length, live, drawCalls: this.renderer?.drawCallCount ?? 0,
      fields: this.fields.length, simMs, beams: this.renderer?.beamStats.visible ?? 0,
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
