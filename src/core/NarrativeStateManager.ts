import type { ActionExecutor } from './ActionExecutor';
import type { AssetManager } from './AssetManager';
import type { EventBus } from './EventBus';
import type { FlagStore } from './FlagStore';
import type { ActionDef, ConditionExpr, GameContext, IGameSystem, NarrativeRunPanelInfo } from '../data/types';
import type { ConditionEvalContext } from '../systems/graphDialogue/evaluateGraphCondition';
import { evaluateConditionExprList } from '../systems/graphDialogue/conditionEvalBridge';
import {
  blockingNarrativeValidationErrors,
  validateNarrativeGraphData,
  DEFAULT_NARRATIVE_DRAFT_SIGNAL,
  DERIVED_NARRATIVE_STATE_SIGNAL_PREFIX,
  type NarrativeValidationIssue,
} from './narrativeGraphValidation';
import { reportDevError } from './devErrorOverlay';
import { TEXT_URLS } from './projectPaths';

export type NarrativeOwnerType =
  | 'flow'
  | 'npc'
  | 'hotspot'
  | 'zone'
  | 'quest'
  | 'scenario'
  | 'scene'
  | 'dialogue'
  | 'minigame'
  | 'cutscene'
  | 'system';

export type NarrativeTriggerKey = string;

export interface NarrativeSignal {
  /** Semantic event id used for transition matching. */
  signal: string;
  sourceType?:
    | 'dialogue'
    | 'zone'
    | 'minigame'
    | 'cutscene'
    | 'quest'
    | 'action'
    | 'entity'
    | 'state'
    | 'system';
  sourceId?: string;
}

export interface NarrativeStateNode {
  id: string;
  label?: string;
  description?: string;
  /** When true, entering this state auto-emits derived signal state:<graphId>:<stateId>. */
  broadcastOnEnter?: boolean;
  /**
   * 位面点名（见 `systems/plane/types.ts`）：该状态激活期间点名的位面 id。
   * 当前所有激活叙事状态中存在点名时激活该位面；无点名时激活 `normal`。
   * 静态图数据、不进存档；由 PlaneReconciler 监听 narrative:stateChanged 派生。
   */
  activePlane?: string;
  onEnterActions?: ActionDef[];
  onExitActions?: ActionDef[];
  meta?: Record<string, unknown>;
}

/**
 * Graph-local state id. Transitions never target another graph directly; cross-graph
 * effects must be modeled with signals, state broadcasts, or projection metadata.
 */
export type NarrativeEndpoint = string;

export interface NarrativeTransition {
  id: string;
  from: NarrativeEndpoint;
  to: NarrativeEndpoint;
  signal: NarrativeTriggerKey;
  /**
   * How this transition is triggered:
   * - 'signal' (default): requires a matching signal + optional conditions
   * - 'reactive': auto-fires when conditions (passed through as-is) are met, no signal needed
   * - 'reactiveAll': auto-fires when ALL flat conditions met (auto-wrapped in {all})
   * - 'reactiveAny': auto-fires when ANY flat condition met (auto-wrapped in {any})
   */
  trigger?: 'signal' | 'reactive' | 'reactiveAll' | 'reactiveAny';
  conditions?: ConditionExpr[];
  priority?: number;
}

/**
 * 活计图声明（设计稿 artifact/Design/叙事运行实例化-技术设计-2026-07-17.md v2）：
 * 声明该图为「可反复运行的活计机器」——每原型至多一个实例（不并发），实例 id 即 graphId。
 * 缺省（不写）= 常驻图：开机自动一份、永不回收，与历史行为逐字节一致。
 */
export interface NarrativeRunDef {
  /** 走到出口结算后可再次开跑（计数 +1）。 */
  repeatable?: boolean;
  /** true=切走时挂起存快照续玩；缺省 false=切走即弃、切回从头。 */
  resumable?: boolean;
}

export interface NarrativeGraph {
  id: string;
  label?: string;
  ownerType: NarrativeOwnerType;
  ownerId?: string;
  /** Author note/category for wrapper usage grouping in tooling. */
  category?: string;
  /** 章节包归属（编译期从 composition.package / element.package 盖章）：**纯组织标签**，
   *  标明这张图属于哪个章节，供导演清单/编辑器/工具分组用。
   *  ⚠不承担任何运行时正确性：图恒吃信号/恒跑 reactive，与其包被标 live 还是 dormant 无关
   *  （包已降级，见 listScannableGraphEntries 注释）。 */
  packageId?: string;
  run?: NarrativeRunDef;
  initialState: string;
  entryState?: string;
  exitStates?: string[];
  states: Record<string, NarrativeStateNode>;
  transitions: NarrativeTransition[];
  projectFlags?: boolean;
}

/** 活计图（有 run 声明）——每原型至多一个实例，弃置/结算时删除条目。 */
export function isRunGraph(graph: Pick<NarrativeGraph, 'run'> | null | undefined): boolean {
  return Boolean(graph?.run);
}

/** 原型累计计数器（随存档持久化；跨轮持久历史的唯一真相）。 */
export interface NarrativeRunCounters {
  started: number;
  reset: number;
  aborted: number;
  /** 按出口状态计的结算次数。 */
  settled: Record<string, number>;
}

export interface NarrativeGraphsFile {
  schemaVersion?: number;
  graphs?: NarrativeGraph[];
  compositions?: NarrativeComposition[];
  migrations?: NarrativeSaveMigrations;
}

/**
 * 旧存档迁移映射（对齐 FlagStore 的 flag_registry.migrations 机制）：改名叙事图/状态后，
 * 在 narrative_graphs.json 顶层声明 旧名→新名，deserialize 先重映射再按现行图校验。
 * 单跳、不追链（a→b、b→c 不会把 a 映到 c）；`states` 的外层键一律用**当前**
 * （图改名之后的新）图 id——图改名先应用，状态改名后应用。
 */
export interface NarrativeSaveMigrations {
  /** 旧图 id → 新图 id */
  graphs?: Record<string, string>;
  /** 图 id（当前名）→ { 旧 state id → 新 state id } */
  states?: Record<string, Record<string, string>>;
}

export type NarrativeCompositionElementKind =
  | 'wrapperGraph'
  | 'scenarioSubgraph'
  | 'dialogueBlackbox'
  | 'zoneBlackbox'
  | 'minigameBlackbox'
  | 'cutsceneBlackbox';

export interface NarrativeCompositionElement {
  id: string;
  kind: NarrativeCompositionElementKind;
  label?: string;
  ownerType?: NarrativeOwnerType | string;
  ownerId?: string;
  refId?: string;
  graph?: NarrativeGraph;
  x?: number;
  y?: number;
  /** 元素级章节包标：本元素图归入此包（无=继承 composition.package）。
   *  主线场景——里程碑 mainGraph 不打标（常驻）、各拍子图元素各打各拍的包。 */
  package?: string;
  meta?: Record<string, unknown>;
}

export interface NarrativeComposition {
  id: string;
  label?: string;
  description?: string;
  /** 章节包标（纯组织标签）：编排整组归入此包，编译时盖到组内每张图的 packageId。
   *  仅供章节分组/工具展示，不 gate 运行时行为（见 packageId / listScannableGraphEntries）。 */
  package?: string;
  mainGraph: NarrativeGraph;
  elements?: NarrativeCompositionElement[];
}

/** stateChanged 的原因维度（系统层消费者按需过滤；缺省 transition）。 */
export type NarrativeStateChangeCause = 'transition' | 'reset' | 'revert' | 'resume' | 'settle' | 'discard';

type QueuedTrigger =
  | { kind: 'external'; key: NarrativeTriggerKey; source?: NarrativeSignal }
  | { kind: 'setState'; graphId: string; stateId: string }
  | { kind: 'reactive'; graphId: string; transitionId: string }
  | { kind: 'runLifecycle'; op: 'start' | 'reset' | 'revert' | 'activate'; graphId: string; stateId?: string }
  | { kind: 'packageLifecycle'; packageId: string; live: boolean };

interface QueuedItem {
  trigger: QueuedTrigger;
  resolve: () => void;
  reject: (reason?: unknown) => void;
}

export interface NarrativeTransitionRecord {
  graphId: string;
  transitionId: string;
  from: string;
  to: string;
  triggerKey: NarrativeTriggerKey;
}

export interface NarrativeRuntimeIssue {
  severity: 'warning' | 'error';
  code: string;
  message: string;
  graphId?: string;
  stateId?: string;
  transitionId?: string;
}

export type NarrativeTraceEventType =
  | 'signal.received'
  | 'signal.ignored'
  | 'signal.broadcast'
  | 'signal.processed'
  | 'trigger.enqueued'
  | 'trigger.start'
  | 'trigger.end'
  | 'transition.applied'
  | 'state.command'
  | 'state.changed'
  | 'reactive.queued'
  | 'run.lifecycle'
  | 'package.lifecycle'
  | 'actions.start'
  | 'actions.end'
  | 'actions.failed'
  | 'issue';

export interface NarrativeTraceEvent {
  seq: number;
  at: number;
  type: NarrativeTraceEventType;
  graphId?: string;
  stateId?: string;
  transitionId?: string;
  triggerKey?: string;
  from?: string;
  to?: string;
  label?: string;
  message?: string;
  payload?: Record<string, unknown>;
}

export type NarrativeRuntimeValidationMode = 'off' | 'warn' | 'throw';

export class NarrativeStateManager implements IGameSystem {
  private eventBus: EventBus;
  private flagStore: FlagStore;
  private actionExecutor: ActionExecutor;
  private conditionCtxFactory: (() => ConditionEvalContext) | null = null;
  private graphs: Map<string, NarrativeGraph> = new Map();
  /**
   * active/reached 两表按 graphId 键控（每原型至多一个实例故 key 即 graphId）：常驻图恒在；
   * 活计图有实例时在、弃置/结算时删除条目。
   */
  private activeStates: Map<string, string> = new Map();
  private ownerIndex: Map<string, string[]> = new Map();
  /** 当前推进的活计图 id（全局单激活槽；只有它参与信号/reactive；随存档持久化）。 */
  private activatedArchetype: string | null = null;
  /** 有实例但非激活（挂起冻结，不推进）的活计图 id 集。 */
  private suspendedRunArchetypes: Set<string> = new Set();
  /** 导演标为"当前活跃章节"的包集合（**纯组织/工具追踪**，随存档持久化，供章节感知 UI/工具查询）。
   *  ⚠已降级：不 gate 任何运行时行为——图恒吃信号，与此集合是否含其包无关。 */
  private livePackages: Set<string> = new Set();
  /** 原型累计计数器（started/reset/aborted/settled-by-exit；随存档持久化）。 */
  private runCounters: Map<string, NarrativeRunCounters> = new Map();
  private queue: QueuedItem[] = [];
  private completedQueueItems: QueuedItem[] = [];
  private draining = false;
  private drainPromise: Promise<void> | null = null;
  /**
   * 嵌套排空互斥：按发起时的 runningActionsDepth 分槽，同一深度任何时刻至多一个排空循环
   * （后来者复用在飞 promise）。不同深度必须允许并存——更深一层的动作可能正 await 一个
   * 排队项，而浅层循环恰好挂起在该动作批上，若合并会互相等待死锁。
   */
  private nestedDrainPromises: Map<number, Promise<void>> = new Map();
  private runningActionsDepth = 0;
  private drainStepCount = 0;
  private destroyed = false;
  /**
   * 时间线代际：deserialize / registerGraphs / destroy 时自增。在飞的迁移（挂起在生命周期
   * 动作 await 上）恢复后比对代际，不一致即放弃剩余写入（置态/广播/事件）——旧时间线
   * 不得污染恢复后的状态（norms 不变量 4）。队列项在代际切换时统一 reject，不静默丢。
   */
  private generation = 0;
  /**
   * 被动 flag:changed → reactive 重评的微任务合批标志。一个 action 批内连 setFlag N 次只排一次
   * 微任务、只跑一轮全量 reactive 扫描（与 ArchiveManager 的 queueMicrotask 合批策略一致）。
   * 仅覆盖被动路径；信号/setState/注入/读档等主动重评仍直接同步 kick，不受此合批影响。
   */
  private reactiveEvalScheduled = false;
  private readonly onFlagChangedListener = () => this.handleFlagChanged();
  private readonly onSaveRestoringListener = () => this.invalidateInFlightTimeline('save restore');
  private recentTransitions: NarrativeTransitionRecord[] = [];
  /** graphId → 到达过的状态集合（含 initialState 与当前状态），随存档持久化 */
  private reachedStates: Map<string, Set<string>> = new Map();
  private recentIssues: NarrativeRuntimeIssue[] = [];
  private saveMigrations: NarrativeSaveMigrations | null = null;
  /** 全部已注册图 signal 型 transition 的监听键缓存（registerGraphs 时失效，懒重建）。 */
  private listenedSignalKeysCache: Set<string> | null = null;
  /** 已上报过的悬垂信号键（同名只进一次错误面/issue，避免重复发射刷屏）。 */
  private reportedUnlistenedSignalKeys: Set<string> = new Set();
  private recentTrace: NarrativeTraceEvent[] = [];
  private traceSeq = 0;
  private primaryOwnerWarningKeys: Set<string> = new Set();
  private validationMode: NarrativeRuntimeValidationMode = this.defaultRuntimeValidationMode();
  private static readonly MAX_DRAIN_STEPS = 128;
  private static readonly MAX_TRACE_EVENTS = 160;

  constructor(eventBus: EventBus, flagStore: FlagStore, actionExecutor: ActionExecutor) {
    this.eventBus = eventBus;
    this.flagStore = flagStore;
    this.actionExecutor = actionExecutor;
    // reactive 迁移的条件几乎全是 flag 叶子：flag 变化时唤醒重评，
    // 否则 reactive 只在队列排空后重评，纯 setFlag 驱动的迁移会"沉睡"到下一个信号才醒。
    this.eventBus.on('flag:changed', this.onFlagChangedListener);
    // 读档统一钩子（与 zone 的 clearActiveZonesForRestore 同一契约层）：旧时间线的
    // 队列/在飞迁移不得写入恢复后的状态；deserialize 自身也会清（覆盖直接调用/测试路径），
    // 挂钩子是为老档缺 narrative 条目、deserialize 不被调用的边角兜底。
    this.eventBus.on('save:restoring', this.onSaveRestoringListener);
  }

  static readonly DEFAULT_DRAFT_SIGNAL = '__draft__';

  /** Cross-graph broadcast when a graph enters a state. */
  static stateEnteredSignalKey(graphId: string, stateId: string): NarrativeTriggerKey {
    const g = String(graphId ?? '').trim();
    const s = String(stateId ?? '').trim();
    return `state:${g}:${s}`;
  }

  /** @deprecated Use {@link stateEnteredSignalKey}. */
  static graphStateEnteredKey(graphId: string, stateId: string): NarrativeTriggerKey {
    return this.stateEnteredSignalKey(graphId, stateId);
  }

  static normalizeTriggerKey(key: NarrativeTriggerKey): NarrativeTriggerKey {
    return String(key ?? '').trim();
  }

  static triggerKeysEqual(a: NarrativeTriggerKey, b: NarrativeTriggerKey): boolean {
    return this.normalizeTriggerKey(a) === this.normalizeTriggerKey(b);
  }

  init(_ctx: GameContext): void {}
  update(_dt: number): void {}

  /**
   * 叙事编排是否空闲：队列无积压、无在飞排空/生命周期动作。
   * SaveManager 的 canSave 依赖它——队列与在飞广播不入档，级联中途的存档
   * 读回后 signal 型迁移无法补发（子图已到末态、主图停在旧里程碑，档即卡死）。
   */
  isIdle(): boolean {
    return !this.draining
      && this.queue.length === 0
      && this.runningActionsDepth === 0
      && this.nestedDrainPromises.size === 0;
  }

  /**
   * 时间线失效：代际自增并 reject 全部积压队列项（旧时间线的信号对恢复后的世界无意义，
   * 静默丢弃会让 await 方永久悬挂——norms 红线）；已处理完仅待落定的项照常 resolve。
   * 在飞迁移恢复后由 enterState / processTrigger 的代际比对放弃剩余写入。
   */
  private invalidateInFlightTimeline(reason: string): void {
    this.generation += 1;
    if (this.queue.length > 0) {
      this.recordTrace('issue', {
        message: `timeline invalidated (${reason}): ${this.queue.length} queued trigger(s) rejected`,
      });
    }
    this.rejectQueuedItems(new Error(`NarrativeStateManager: timeline invalidated (${reason}); stale queued trigger discarded`));
    this.resolveCompletedQueueItems();
  }

  setConditionEvalContextFactory(factory: (() => ConditionEvalContext) | null): void {
    this.conditionCtxFactory = factory;
    // 装配顺序上下文注入可能晚于 loadFromAsset/registerGraphs（Game 目前如此）：
    // 注册期被判 false 的 reactive 迁移在具备求值能力后立即补评一轮。
    if (factory && this.graphs.size > 0) {
      this.kickReactiveEvaluation();
    }
  }

  setRuntimeValidationMode(mode: NarrativeRuntimeValidationMode): void {
    this.validationMode = mode;
  }

  async loadFromAsset(assetManager: AssetManager, path = TEXT_URLS.narrativeGraphs): Promise<void> {
    try {
      const data = await assetManager.loadJson<NarrativeGraphsFile>(path);
      this.validateLoadedData(data, path);
      this.setSaveMigrations(data.migrations);
      this.registerGraphs(compileNarrativeGraphs(data));
    } catch (e) {
      const message = `NarrativeStateManager: narrative_graphs.json not found or invalid: ${String(e)}`;
      this.recordIssue({ severity: 'error', code: 'narrative.load.failed', message });
      if (this.isDevRuntime()) {
        throw e;
      }
      console.warn('NarrativeStateManager: narrative_graphs.json not found or invalid, running empty', e);
      this.setSaveMigrations(null);
      this.registerGraphs([]);
    }
  }

  /**
   * 注入旧存档迁移映射（loadFromAsset 从数据文件自动接线；直接 registerGraphs 的装配方/
   * 测试可手动注入）。传 null/undefined 清空。
   */
  setSaveMigrations(migrations: NarrativeSaveMigrations | null | undefined): void {
    this.saveMigrations = migrations ?? null;
  }

  registerGraphs(graphs: NarrativeGraph[]): void {
    // 换图册=换时间线：积压项 reject（而非旧实现的静默清空——那会让 await 方永久悬挂），
    // 在飞迁移经代际比对放弃剩余写入。
    this.invalidateInFlightTimeline('graphs re-registered');
    this.graphs.clear();
    this.activeStates.clear();
    this.reachedStates.clear();
    this.ownerIndex.clear();
    this.suspendedRunArchetypes.clear();
    this.livePackages.clear();
    this.runCounters.clear();
    this.activatedArchetype = null;
    this.primaryOwnerWarningKeys.clear();
    this.listenedSignalKeysCache = null;
    this.reportedUnlistenedSignalKeys.clear();
    this.recentIssues = this.recentIssues.filter((issue) => issue.code === 'narrative.load.failed');
    for (const graph of graphs) {
      if (!graph || !graph.id || !graph.initialState || !graph.states?.[graph.initialState]) {
        this.recordIssue({
          severity: 'warning',
          code: 'graph.invalid',
          message: 'NarrativeStateManager: skipped invalid graph',
          graphId: graph?.id,
        });
        console.warn('NarrativeStateManager: skipped invalid graph', graph);
        continue;
      }
      if (this.graphs.has(graph.id)) {
        // 与上面「跳过无效图」同一策略：重复 id 无法判定用哪张，保留先注册的、跳过重复的，
        // 记录 error 供 recentIssues/校验暴露，而非在启动时硬崩整套叙事系统。
        // 编辑器保存校验已阻止重复 id；throw 模式的失败早在 validateLoadedData（TS 权威校验，
        // 同样报 graph.id.duplicate）就抛出，这里只做优雅降级，合法数据行为完全不变。
        const message = `NarrativeStateManager: duplicate graph id "${graph.id}" (skipped duplicate, kept first)`;
        this.recordIssue({ severity: 'error', code: 'graph.id.duplicate', message, graphId: graph.id });
        console.warn(message);
        continue;
      }
      this.graphs.set(graph.id, graph);
      if (isRunGraph(graph)) {
        // 活计图：只登记形状，不种实例（实例由 startNarrativeRun 创建）；
        // 不进 owner 索引（@owner/主 wrapper 语义只属常驻图，校验器同口径拦）。
        continue;
      }
      this.activeStates.set(graph.id, graph.initialState);
      this.markStateReached(graph.id, graph.initialState);
      this.indexGraphOwner(graph);
      if (graph.projectFlags) {
        const message = `NarrativeStateManager: graph.projectFlags is deprecated and ignored on ${graph.id}`;
        this.recordIssue({ severity: 'warning', code: 'projectFlags.deprecated', message, graphId: graph.id });
        console.warn(message);
      }
    }
    this.recordDuplicateOwnerBindings();
    // Evaluate reactive transitions on initial states
    this.kickReactiveEvaluation();
  }

  /** 重评全部 reactive 迁移；有命中则启动后台排空（注册后 / 读档后 / flag 变化 / 注入求值上下文时共用）。 */
  private kickReactiveEvaluation(): void {
    if (this.destroyed) return;
    this.evaluateReactiveTriggers();
    if (this.queue.length === 0) return;
    if (!this.draining) {
      this.startDetachedDrain();
    } else if (this.runningActionsDepth > 0) {
      // 与 enqueueGraphStateEntered 同策略：动作执行期入队须嵌套排空，否则外层循环挂起等不到。
      void this.drainNestedQueue();
    }
    // 其余情形：在飞排空循环会在下一轮 while 检查时消费新入队项。
  }

  private handleFlagChanged(): void {
    if (this.destroyed || this.graphs.size === 0) return;
    // 无求值上下文时任何 reactive 条件都判 false（conditionsMet 会告警），直接跳过避免刷屏；
    // 上下文注入时 setConditionEvalContextFactory 会补评。
    if (!this.conditionCtxFactory) return;
    // 合批：不立即全量扫描。一个同步段 / 微任务批内多次 flag:changed（一个 action 批连写 N 个 flag）
    // 只排一个微任务、只跑一轮 reactive 重评。已排则直接返回，不重复排。
    if (this.reactiveEvalScheduled) return;
    this.reactiveEvalScheduled = true;
    queueMicrotask(() => {
      this.reactiveEvalScheduled = false;
      if (this.destroyed || this.graphs.size === 0) return;
      this.kickReactiveEvaluation();
    });
  }

  /** 启动一次无人 await 的后台排空：错误路由到 recordIssue，不产生 unhandled rejection。 */
  private startDetachedDrain(): void {
    if (this.draining || this.queue.length === 0) return;
    const drain = this.drainQueue();
    this.drainPromise = drain.finally(() => {
      this.drainPromise = null;
    });
    this.drainPromise.catch((e) => {
      this.recordIssue({
        severity: 'error',
        code: 'drain.detached.failed',
        message: `NarrativeStateManager: detached drain failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    });
  }

  getActiveState(graphId: string): string | undefined {
    return this.activeStates.get(graphId);
  }

  /**
   * 信号/reactive 扫描的迭代单位：全部常驻图 + 激活的那一张活计图（若有）。
   * 挂起活计图冻结、不参与推进（拍板：非激活活计不会推进也不会失败）。
   */
  /**
   * 参与信号扫描的图：全部常驻图 + 当前激活的活计图（挂起活计冻结不扫）。
   * ⚠章节包（packageId / livePackages）**不在这里 gate**——包已降级为纯组织标签，
   * 所有已注册的图恒吃信号/恒跑 reactive，无论其包被导演标为 live 还是 dormant。
   * （证据：全项目 131 种信号 129 种单图独占、2 种多听均良性，from-state 门已隔离图与图；
   *  且所有图启动即编译进内存，包从不省加载。包的 live/dormant 只是章节归属的组织/工具信息，
   *  不承担任何运行时正确性。切勿在此重新按 livePackages 过滤。）
   * 唯一在此 gate 的是活计实例机（另一套系统）：挂起的活计原型冻结不扫。
   */
  private listScannableGraphEntries(): Array<[string, NarrativeGraph]> {
    const out: Array<[string, NarrativeGraph]> = [];
    for (const [gid, graph] of this.graphs) {
      if (!isRunGraph(graph)) {
        out.push([gid, graph]);
      } else if (gid === this.activatedArchetype && this.activeStates.has(gid)) {
        out.push([gid, graph]);
      }
    }
    return out;
  }

  /** 全部已注册的章节包 id（图上盖章的并集）。 */
  getKnownPackageIds(): string[] {
    const out = new Set<string>();
    for (const graph of this.graphs.values()) {
      if (graph.packageId) out.add(graph.packageId);
    }
    return [...out];
  }

  getLivePackages(): string[] {
    return [...this.livePackages];
  }

  isNarrativePackageLive(packageId: string): boolean {
    return this.livePackages.has(String(packageId ?? '').trim());
  }

  /** 章节包"活跃/非活跃"标记切换（**纯组织追踪**，走队列保时序）。幂等；未知包记 issue 忽略。
   *  ⚠不 gate 运行时行为——仅维护 livePackages 这个组织/工具集合，供章节感知 UI 查询。 */
  setNarrativePackageLive(packageId: string, live: boolean): Promise<void> {
    const pkg = String(packageId ?? '').trim();
    if (!pkg) return Promise.resolve();
    return this.enqueue({ kind: 'packageLifecycle', packageId: pkg, live });
  }

  private applyPackageLifecycle(packageId: string, live: boolean): void {
    if (!this.getKnownPackageIds().includes(packageId)) {
      this.lifecycleIssue(
        'package.unknown',
        `NarrativeStateManager: 章节包 ${packageId} 不存在（没有任何图盖此包标）`,
        packageId,
      );
      return;
    }
    if (live === this.livePackages.has(packageId)) return; // 幂等
    if (live) this.livePackages.add(packageId);
    else this.livePackages.delete(packageId);
    this.recordTrace('package.lifecycle', {
      message: `package ${packageId} 标记为 ${live ? '活跃章节' : '非活跃章节'}（组织追踪，不 gate 行为）`,
    });
    this.eventBus.emit('narrative:packageChanged', { packageId, live });
    // ⚠降级后不再补评 reactive：图恒吃信号，切换活跃标记不改变任何图的可扫描性，无新反应机会。
  }

  /** 有实例（激活或挂起）的活计图 id 列表——诊断/派生用。 */
  getActiveRunArchetypes(): string[] {
    const out: string[] = [];
    for (const [gid, graph] of this.graphs) {
      if (isRunGraph(graph) && this.activeStates.has(gid)) out.push(gid);
    }
    return out;
  }

  /** 常驻图 + 有实例的活计图（含挂起）的激活态快照（PlaneReconciler 全量派生用）。 */
  getActiveInstanceStates(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [gid, active] of this.activeStates.entries()) out[gid] = active;
    return out;
  }

  /** 当前激活（推进中）的活计图 id（全局单槽；null=无激活单）。 */
  getActivatedArchetype(): string | null {
    return this.activatedArchetype;
  }

  /** narrativeCount 条件叶后端：原型累计结算计数（exitStateId 缺省=全部出口合计）。 */
  getSettledRunCount(archetypeId: string, exitStateId?: string): number {
    const counters = this.runCounters.get(String(archetypeId ?? '').trim());
    if (!counters) return 0;
    if (exitStateId !== undefined) {
      const exit = String(exitStateId ?? '').trim();
      return exit ? counters.settled[exit] ?? 0 : 0;
    }
    let total = 0;
    for (const n of Object.values(counters.settled)) total += n;
    return total;
  }

  private countersFor(graphId: string): NarrativeRunCounters {
    let counters = this.runCounters.get(graphId);
    if (!counters) {
      counters = { started: 0, reset: 0, aborted: 0, settled: {} };
      this.runCounters.set(graphId, counters);
    }
    return counters;
  }

  /** 活计运行面板信息（repeatable 任务镜像的只读派生口）；非活计图/图缺失返回 null。 */
  getRunPanelInfo(graphId: string): NarrativeRunPanelInfo | null {
    const gid = String(graphId ?? '').trim();
    const graph = this.graphs.get(gid);
    if (!graph || !isRunGraph(graph)) return null;
    const counters = this.runCounters.get(gid);
    const active = this.activeStates.get(gid);
    const settled: NarrativeRunPanelInfo['settled'] = [];
    for (const [exitId, count] of Object.entries(counters?.settled ?? {})) {
      if (count > 0) settled.push({ exitId, label: graph.states[exitId]?.label || exitId, count });
    }
    return {
      graphId: gid,
      active,
      activeLabel: active !== undefined ? graph.states[active]?.label || active : undefined,
      ordinal: counters?.started ?? 0,
      activated: this.activatedArchetype === gid,
      suspended: this.suspendedRunArchetypes.has(gid),
      settled,
    };
  }

  isStateActive(graphId: string, stateId: string): boolean {
    return this.activeStates.get(graphId) === stateId;
  }

  /**
   * 该图是否「到达过」某状态（含当前状态；initialState 注册即视为到达）。
   * 供线性流程的里程碑门控使用：`{ narrative, state, reached: true }` 条件叶子。
   */
  hasReachedState(graphId: string, stateId: string): boolean {
    const g = String(graphId ?? '').trim();
    const s = String(stateId ?? '').trim();
    if (!g || !s) return false;
    if (this.activeStates.get(g) === s) return true;
    return this.reachedStates.get(g)?.has(s) ?? false;
  }

  private markStateReached(graphId: string, stateId: string): void {
    let set = this.reachedStates.get(graphId);
    if (!set) {
      set = new Set();
      this.reachedStates.set(graphId, set);
    }
    set.add(stateId);
  }

  getGraph(graphId: string): NarrativeGraph | undefined {
    return this.graphs.get(graphId);
  }

  /**
   * 诊断用：判定条件叶子引用的图/状态是否存在于注册数据（区别于「存在但未到达/未激活」）。
   * 图册为空（尚未加载或加载失败）时返回 'unavailable'，调用方应跳过判定，避免装配期误报。
   */
  classifyStateRef(graphId: string, stateId: string): 'ok' | 'missingGraph' | 'missingState' | 'unavailable' {
    if (this.graphs.size === 0) return 'unavailable';
    const graph = this.graphs.get(String(graphId ?? '').trim());
    if (!graph) return 'missingGraph';
    return graph.states[String(stateId ?? '').trim()] ? 'ok' : 'missingState';
  }

  getGraphs(): NarrativeGraph[] {
    return [...this.graphs.values()];
  }

  getGraphIdsByOwner(ownerType: string, ownerId: string): string[] {
    const key = this.ownerKey(ownerType, ownerId);
    return key ? [...(this.ownerIndex.get(key) ?? [])] : [];
  }

  getGraphsByOwner(ownerType: string, ownerId: string): NarrativeGraph[] {
    return this.getGraphIdsByOwner(ownerType, ownerId)
      .map((graphId) => this.graphs.get(graphId))
      .filter((graph): graph is NarrativeGraph => Boolean(graph));
  }

  getActiveStatesByOwner(ownerType: string, ownerId: string): Record<string, string> {
    return Object.fromEntries(
      this.getGraphIdsByOwner(ownerType, ownerId)
        .map((graphId) => [graphId, this.activeStates.get(graphId)])
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
  }

  getPrimaryGraphByOwner(ownerType: string, ownerId: string): NarrativeGraph | undefined {
    const graphIds = this.getGraphIdsByOwner(ownerType, ownerId);
    if (graphIds.length === 0) return undefined;
    if (graphIds.length > 1) {
      this.recordPrimaryOwnerAmbiguous(ownerType, ownerId, graphIds);
      return undefined;
    }
    return this.graphs.get(graphIds[0]!);
  }

  getPrimaryActiveStateByOwner(ownerType: string, ownerId: string): string | undefined {
    const graph = this.getPrimaryGraphByOwner(ownerType, ownerId);
    return graph ? this.activeStates.get(graph.id) : undefined;
  }

  isOwnerStateActive(ownerType: string, ownerId: string, stateId: string): boolean {
    return this.getPrimaryActiveStateByOwner(ownerType, ownerId) === stateId;
  }

  emitNarrativeSignal(signal: NarrativeSignal): Promise<void> {
    const clean = this.normalizeSignal(signal);
    if (!clean) {
      this.recordTrace('signal.ignored', { message: 'invalid signal', payload: { raw: signal as unknown as Record<string, unknown> } });
      return Promise.resolve();
    }
    if (clean.key === NarrativeStateManager.DEFAULT_DRAFT_SIGNAL) {
      console.warn('NarrativeStateManager: refusing to emit draft signal');
      this.recordTrace('signal.ignored', {
        triggerKey: clean.key,
        message: 'refusing to emit draft signal',
        payload: { source: clean.source },
      });
      return Promise.resolve();
    }
    this.recordTrace('signal.received', {
      triggerKey: clean.key,
      payload: { source: clean.source },
    });
    return this.enqueue({ kind: 'external', key: clean.key, source: clean.source });
  }

  enqueueTriggerKey(key: NarrativeTriggerKey): Promise<void> {
    const k = String(key ?? '').trim();
    if (!k) return Promise.resolve();
    return this.enqueue({ kind: 'external', key: k });
  }

  debugSetNarrativeState(graphId: string, stateId: string): Promise<void> {
    const gid = String(graphId ?? '').trim();
    const sid = String(stateId ?? '').trim();
    if (!gid || !sid) return Promise.resolve();
    const message = `NarrativeStateManager: debugSetNarrativeState bypasses transitions and should only be used for debug/repair: ${gid}.${sid}`;
    this.recordIssue({ severity: 'warning', code: 'stateCommand.debugOnly', message, graphId: gid, stateId: sid });
    this.recordTrace('state.command', {
      graphId: gid,
      stateId: sid,
      message: 'debugSetNarrativeState requested',
    });
    console.warn(message);
    return this.enqueue({ kind: 'setState', graphId: gid, stateId: sid });
  }

  /** @deprecated Content must use signals/transitions. Use debugSetNarrativeState for tooling repair only. */
  setNarrativeState(graphId: string, stateId: string): Promise<void> {
    return this.debugSetNarrativeState(graphId, stateId);
  }

  // ------------------------------------------------------------------ //
  // 活计生命周期（start / reset / revert / activate；结算由 exitStates 自动）
  // 每原型至多一个实例（id 即 graphId）；全经队列串行，与信号处理/代际失效/isIdle 同时序。
  // ------------------------------------------------------------------ //

  /** 开一轮新活计并激活（顶替当前激活的，旧的按 resumable 挂起/弃置）。已有实例=警告跳过。 */
  startNarrativeRun(graphId: string): Promise<void> {
    const gid = String(graphId ?? '').trim();
    if (!gid) return Promise.resolve();
    return this.enqueue({ kind: 'runLifecycle', op: 'start', graphId: gid });
  }

  /** 当前实例回 initialState + 清 reached（"从头再来"，静默重基线，不碰激活槽）。 */
  resetNarrativeRun(graphId: string): Promise<void> {
    const gid = String(graphId ?? '').trim();
    if (!gid) return Promise.resolve();
    return this.enqueue({ kind: 'runLifecycle', op: 'reset', graphId: gid });
  }

  /** 当前实例回退到指定状态（静默重基线；改 active 不抹 reached，不碰激活槽）。 */
  revertNarrativeRun(graphId: string, stateId: string): Promise<void> {
    const gid = String(graphId ?? '').trim();
    const sid = String(stateId ?? '').trim();
    if (!gid || !sid) return Promise.resolve();
    return this.enqueue({ kind: 'runLifecycle', op: 'revert', graphId: gid, stateId: sid });
  }

  /** 切换激活到已存在的活计实例（恢复挂起）。传空串清槽；目标无实例=警告（开新用 start）。 */
  activateNarrativeRun(graphId: string): Promise<void> {
    return this.enqueue({ kind: 'runLifecycle', op: 'activate', graphId: String(graphId ?? '').trim() });
  }

  private lifecycleIssue(code: string, message: string, graphId: string): void {
    this.recordIssue({ severity: 'warning', code, message, graphId });
    console.warn(message);
  }

  private async applyRunLifecycle(trigger: Extract<QueuedTrigger, { kind: 'runLifecycle' }>): Promise<void> {
    if (trigger.op === 'start') return this.applyStartRun(trigger.graphId);
    if (trigger.op === 'reset') return this.applyResetRun(trigger.graphId);
    if (trigger.op === 'revert') return this.applyRevertRun(trigger.graphId, trigger.stateId ?? '');
    return this.applyActivateRun(trigger.graphId);
  }

  /** 校验目标是活计图并返回它；否则记 issue 返回 null。 */
  private requireRunGraph(graphId: string, op: string): NarrativeGraph | null {
    const graph = this.graphs.get(graphId);
    if (!graph) {
      this.lifecycleIssue(`run.${op}.graphMissing`, `NarrativeStateManager: ${op}NarrativeRun 目标图不存在: ${graphId}`, graphId);
      return null;
    }
    if (!isRunGraph(graph)) {
      this.lifecycleIssue(`run.${op}.notRunGraph`, `NarrativeStateManager: 图 ${graphId} 未声明 run（不是活计图，常驻图不可 ${op}）`, graphId);
      return null;
    }
    return graph;
  }

  private applyStartRun(graphId: string): void {
    const graph = this.requireRunGraph(graphId, 'start');
    if (!graph) return;
    if (this.activeStates.has(graphId)) {
      this.lifecycleIssue('run.start.exists', `NarrativeStateManager: 活计 ${graphId} 已有实例（重来用 reset、切回用 activate）`, graphId);
      return;
    }
    // 顶替当前激活的（旧的按 resumable 挂起/弃置），再建新实例并激活。
    this.suspendOrDiscardActivated();
    this.activeStates.set(graphId, graph.initialState);
    this.markStateReached(graphId, graph.initialState);
    this.countersFor(graphId).started += 1;
    this.recordTrace('run.lifecycle', { graphId, message: `run started at ${graph.initialState}` });
    this.eventBus.emit('narrative:runStarted', { archetypeId: graphId, ordinal: this.countersFor(graphId).started });
    this.setActivatedArchetype(graphId, 'resume');
  }

  private applyResetRun(graphId: string): void {
    const graph = this.requireRunGraph(graphId, 'reset');
    if (!graph) return;
    if (!this.activeStates.has(graphId)) {
      this.lifecycleIssue('run.reset.missing', `NarrativeStateManager: 活计 ${graphId} 无实例可 reset（开新用 start）`, graphId);
      return;
    }
    // 静默重基线：回 initialState、reached 只剩 initial。不跑 onExit/onEnter、不广播。
    this.activeStates.set(graphId, graph.initialState);
    this.reachedStates.set(graphId, new Set([graph.initialState]));
    this.countersFor(graphId).reset += 1;
    this.recordTrace('run.lifecycle', { graphId, message: `run reset to ${graph.initialState}` });
    this.eventBus.emit('narrative:stateChanged', {
      graphId, from: undefined, to: graph.initialState, cause: 'reset', triggerKey: `reset:${graphId}`,
    });
    this.kickReactiveEvaluation();
  }

  private applyRevertRun(graphId: string, stateId: string): void {
    const graph = this.requireRunGraph(graphId, 'revert');
    if (!graph) return;
    if (!this.activeStates.has(graphId)) {
      this.lifecycleIssue('run.revert.missing', `NarrativeStateManager: 活计 ${graphId} 无实例可 revert`, graphId);
      return;
    }
    if (!graph.states[stateId]) {
      this.lifecycleIssue('run.revert.stateMissing', `NarrativeStateManager: revert 目标状态不存在: ${graphId}.${stateId}`, graphId);
      return;
    }
    // 静默：改 active 到 stateId，reached 保留历史（revert 是跳回节点续玩，不是抹除）。
    const from = this.activeStates.get(graphId);
    this.activeStates.set(graphId, stateId);
    this.markStateReached(graphId, stateId);
    this.recordTrace('run.lifecycle', { graphId, message: `run reverted ${from ?? '?'} -> ${stateId}` });
    this.eventBus.emit('narrative:stateChanged', {
      graphId, from, to: stateId, cause: 'revert', triggerKey: `revert:${graphId}`,
    });
    this.kickReactiveEvaluation();
  }

  private applyActivateRun(graphId: string): void {
    if (!graphId) {
      this.suspendOrDiscardActivated();
      this.setActivatedArchetype(null, 'discard');
      return;
    }
    if (!this.requireRunGraph(graphId, 'activate')) return;
    if (graphId === this.activatedArchetype) return; // 已激活
    if (!this.activeStates.has(graphId)) {
      this.lifecycleIssue('run.activate.missing', `NarrativeStateManager: 活计 ${graphId} 无实例可激活（开新用 start）`, graphId);
      return;
    }
    // 挂起当前激活的，再恢复目标（目标从挂起集移出、继续从当前态推进）。
    this.suspendOrDiscardActivated();
    this.suspendedRunArchetypes.delete(graphId);
    this.setActivatedArchetype(graphId, 'resume');
  }

  /** 切走当前激活活计：resumable 留（进挂起集）、否则弃（删实例 + aborted++）。 */
  private suspendOrDiscardActivated(): void {
    const prev = this.activatedArchetype;
    if (!prev) return;
    const graph = this.graphs.get(prev);
    if (graph?.run?.resumable === true) {
      this.suspendedRunArchetypes.add(prev);
      this.recordTrace('run.lifecycle', { graphId: prev, message: 'run suspended' });
    } else {
      this.discardRunInstance(prev, 'discard');
      this.countersFor(prev).aborted += 1;
    }
  }

  private setActivatedArchetype(graphId: string | null, cause: NarrativeStateChangeCause): void {
    if (this.activatedArchetype === graphId) return;
    const previous = this.activatedArchetype;
    this.activatedArchetype = graphId;
    this.recordTrace('run.lifecycle', {
      graphId: graphId ?? undefined,
      message: `run activated (previous: ${previous ?? 'none'}, cause: ${cause})`,
    });
    this.eventBus.emit('narrative:runActivated', { archetypeId: graphId, previous });
    // 激活切换可能让某个 narrative 叶（读活计当前态）满足新条件，补评一轮。
    this.kickReactiveEvaluation();
  }

  /** 结算（到达 exitStates 时由 enterState 调用）：计数、删实例、清激活槽。 */
  private settleRunInstance(graphId: string, exitStateId: string): void {
    this.countersFor(graphId).settled[exitStateId] = (this.countersFor(graphId).settled[exitStateId] ?? 0) + 1;
    this.discardRunInstance(graphId, 'settle');
    this.recordTrace('run.lifecycle', { graphId, message: `run settled at ${exitStateId}` });
    this.eventBus.emit('narrative:runSettled', { archetypeId: graphId, exitStateId });
    if (this.activatedArchetype === graphId) this.setActivatedArchetype(null, 'settle');
  }

  /**
   * 删除活计实例（active/reached 出表、移出挂起集）；不动计数器与激活槽。
   * 发一条 to 为空的 stateChanged（带 cause）：位面对账器等增量消费者据此清掉该图的
   * 派生（点名位面等）——否则实例停在点名态被删时位面会残留到下一次全量重算。
   */
  private discardRunInstance(graphId: string, cause: NarrativeStateChangeCause): void {
    const from = this.activeStates.get(graphId);
    this.activeStates.delete(graphId);
    this.reachedStates.delete(graphId);
    this.suspendedRunArchetypes.delete(graphId);
    this.recordTrace('run.lifecycle', { graphId, message: `run discarded (${cause})` });
    this.eventBus.emit('narrative:stateChanged', {
      graphId, from, to: '', cause, triggerKey: `${cause}:${graphId}`,
    });
  }

  serialize(): object {
    const singletons: Record<string, string> = {};
    const singletonReached: Record<string, string[]> = {};
    const runs: Record<string, { active: string; reached: string[] }> = {};
    for (const [gid, active] of this.activeStates.entries()) {
      const reached = [...(this.reachedStates.get(gid) ?? [])];
      if (isRunGraph(this.graphs.get(gid))) {
        runs[gid] = { active, reached };   // 活计图（激活或挂起，每原型一条）
      } else {
        singletons[gid] = active;          // 常驻图
        singletonReached[gid] = reached;
      }
    }
    return {
      version: 2,
      // v1 兼容字段照旧携带（仅常驻图）：老读者/工具读 activeStates 仍取到与历史等价的数据。
      activeStates: singletons,
      reachedStates: singletonReached,
      runs,
      counters: Object.fromEntries(
        [...this.runCounters.entries()].map(([gid, c]) => [gid, {
          started: c.started,
          reset: c.reset,
          aborted: c.aborted,
          settled: { ...c.settled },
        }]),
      ),
      activatedArchetype: this.activatedArchetype,
      // 章节包活跃标记集（纯组织追踪）：入档保存导演标过的活跃章节，供章节感知 UI 还原。
      // 不 gate 行为，图状态永存照旧走 activeStates/runs（与此集合无关）。
      livePackages: [...this.livePackages],
    };
  }

  deserialize(data: object): void {
    const raw = data as {
      activeStates?: Record<string, unknown>;
      reachedStates?: Record<string, unknown>;
      runs?: Record<string, unknown>;
      counters?: Record<string, unknown>;
      activatedArchetype?: unknown;
      livePackages?: unknown;
    };
    // 恢复前先失效旧时间线（审查 R2）：积压队列项 reject、在飞迁移放弃剩余写入——
    // 否则旧时间线的广播/信号会打进恢复后的世界（子图回到起点、主图却被幽灵广播推进）。
    // save:restoring 钩子已清过时此处为幂等重清（直接调用 deserialize 的测试/装配路径靠这里）。
    this.invalidateInFlightTimeline('deserialize');
    // 先把全部图复位到「注册后初始态」再按存档恢复：restore 只覆盖存档里有的图、只增量标记
    // reached，不复位会把本会话越过的进度残留进更早的档（reached:true 门控提前打开）。
    // 基线含实例层：无 run、零计数、空激活槽（v1 旧档天然落在此基线=功能出现前的语义）。
    this.resetStatesToRegisteredBaseline();
    this.restoreActiveStates(raw?.activeStates ?? {});
    this.restoreReachedStates(raw?.reachedStates);
    this.restoreRuns(raw?.runs);
    this.restoreRunCounters(raw?.counters);
    this.restoreActivatedArchetype(raw?.activatedArchetype);
    this.restoreLivePackages(raw?.livePackages);
    // 读档后的状态组合可能已满足某些 reactive 迁移条件（读档期间 FlagStore.deserialize
    // 不广播 flag:changed），此处统一补评一轮。
    this.kickReactiveEvaluation();
  }

  /** 与 registerGraphs 注册完成时一致：常驻图=initialState、reached 仅含 initialState；活计层全空。 */
  private resetStatesToRegisteredBaseline(): void {
    this.activeStates.clear();
    this.reachedStates.clear();
    this.suspendedRunArchetypes.clear();
    this.livePackages.clear();
    this.runCounters.clear();
    this.activatedArchetype = null;
    for (const graph of this.graphs.values()) {
      if (isRunGraph(graph)) continue;
      this.activeStates.set(graph.id, graph.initialState);
      this.markStateReached(graph.id, graph.initialState);
    }
  }

  /**
   * 恢复活计实例层（v2；每原型至多一条，恢复即挂起——deserialize 末尾按 activatedArchetype 激活一个）。
   * 图 id 经 migrations 单跳重映射，状态同 restoreActiveStates 口径。
   */
  private restoreRuns(runsRaw: Record<string, unknown> | undefined): void {
    if (!runsRaw || typeof runsRaw !== 'object') return;
    for (const [rawGraphId, entryRaw] of Object.entries(runsRaw)) {
      const graphId = this.migrateSaveGraphId(rawGraphId);
      const graph = this.graphs.get(graphId);
      if (!graph || !isRunGraph(graph)) {
        this.warnDroppedSaveEntry(
          'save.runs.graphMissing',
          `NarrativeStateManager: save references unknown/non-run archetype "${rawGraphId}"${this.migrationSuffix(rawGraphId, graphId)}; dropped its run`,
          graphId,
        );
        continue;
      }
      const entry = entryRaw as { active?: unknown; reached?: unknown } | null;
      const rawStateId = String(entry?.active ?? '').trim();
      const stateId = rawStateId ? this.migrateSaveStateId(graphId, rawStateId) : '';
      if (!stateId || !graph.states[stateId]) {
        this.warnDroppedSaveEntry(
          'save.runs.stateMissing',
          `NarrativeStateManager: run "${graphId}" references unknown state "${rawStateId}"; run dropped`,
          graphId,
          stateId || rawStateId || undefined,
        );
        continue;
      }
      this.activeStates.set(graphId, stateId);
      this.markStateReached(graphId, graph.initialState);
      this.markStateReached(graphId, stateId);
      if (Array.isArray(entry?.reached)) {
        for (const sRaw of entry.reached) {
          const rid = this.migrateSaveStateId(graphId, String(sRaw ?? '').trim());
          if (rid && graph.states[rid]) this.markStateReached(graphId, rid);
        }
      }
      // 恢复即挂起；末尾 restoreActivatedArchetype 会把激活的那个移出挂起集。
      this.suspendedRunArchetypes.add(graphId);
    }
  }

  private restoreRunCounters(countersRaw: Record<string, unknown> | undefined): void {
    if (!countersRaw || typeof countersRaw !== 'object') return;
    for (const [rawGraphId, cRaw] of Object.entries(countersRaw)) {
      const graphId = this.migrateSaveGraphId(rawGraphId);
      const c = cRaw as { started?: unknown; reset?: unknown; aborted?: unknown; settled?: unknown } | null;
      if (!c || typeof c !== 'object') continue;
      const settled: Record<string, number> = {};
      if (c.settled && typeof c.settled === 'object') {
        for (const [exitRaw, n] of Object.entries(c.settled as Record<string, unknown>)) {
          const exit = this.migrateSaveStateId(graphId, String(exitRaw ?? '').trim());
          if (exit && typeof n === 'number' && Number.isFinite(n)) settled[exit] = (settled[exit] ?? 0) + n;
        }
      }
      const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
      this.runCounters.set(graphId, {
        started: num(c.started), reset: num(c.reset), aborted: num(c.aborted), settled,
      });
    }
  }

  private restoreLivePackages(raw: unknown): void {
    this.livePackages.clear();
    if (!Array.isArray(raw)) return; // 旧档无此字段：活跃标记集留空，导演重评（纯组织追踪，不影响行为）
    const known = new Set(this.getKnownPackageIds());
    for (const entry of raw) {
      const pkg = String(entry ?? '').trim();
      if (!pkg) continue;
      if (!known.has(pkg)) {
        this.warnDroppedSaveEntry(
          'save.livePackage.missing',
          `NarrativeStateManager: save livePackages 含未知包 "${pkg}"，丢弃`,
          pkg,
        );
        continue;
      }
      this.livePackages.add(pkg);
    }
  }

  private restoreActivatedArchetype(raw: unknown): void {
    const gid = typeof raw === 'string' ? this.migrateSaveGraphId(raw.trim()) : '';
    if (!gid) return;
    if (!this.activeStates.has(gid) || !isRunGraph(this.graphs.get(gid))) {
      this.warnDroppedSaveEntry(
        'save.activatedArchetype.missing',
        `NarrativeStateManager: save activatedArchetype "${gid}" 无对应活计实例，激活槽置空`,
        gid,
      );
      return;
    }
    this.suspendedRunArchetypes.delete(gid);   // 激活的那个移出挂起集
    this.activatedArchetype = gid;
  }

  restoreActiveStates(states: Record<string, unknown>): void {
    for (const [rawGraphId, stateRaw] of Object.entries(states ?? {})) {
      const graphId = this.migrateSaveGraphId(rawGraphId);
      const rawStateId = String(stateRaw ?? '').trim();
      const stateId = rawStateId ? this.migrateSaveStateId(graphId, rawStateId) : '';
      const graph = this.graphs.get(graphId);
      if (!graph) {
        this.warnDroppedSaveEntry(
          'save.active.graphMissing',
          `NarrativeStateManager: save references unknown narrative graph "${rawGraphId}"${this.migrationSuffix(rawGraphId, graphId)}; dropped active state "${rawStateId}". If the graph was renamed, declare it in narrative_graphs.json migrations.graphs.`,
          graphId,
          stateId || undefined,
        );
        continue;
      }
      if (isRunGraph(graph)) {
        // 旧档写入时该图还是常驻图、现已改声明为活计图：常驻条目不可回灌（会造幽灵实例），
        // 丢弃并点名（内容改声明属破档级变更，本告警即迁移提示；活计实例走 runs 字段恢复）。
        this.warnDroppedSaveEntry(
          'save.active.becameRunGraph',
          `NarrativeStateManager: 图 "${graphId}" 现为活计图，旧档常驻条目已丢弃（active "${rawStateId}"）`,
          graphId,
          stateId || undefined,
        );
        continue;
      }
      if (!stateId || !graph.states[stateId]) {
        this.warnDroppedSaveEntry(
          'save.active.stateMissing',
          `NarrativeStateManager: save references unknown state "${rawStateId}"${this.migrationSuffix(rawStateId, stateId)} in graph "${graphId}"; graph falls back to initialState "${graph.initialState}". If the state was renamed, declare it in narrative_graphs.json migrations.states.`,
          graphId,
          stateId || rawStateId || undefined,
        );
        continue;
      }
      this.activeStates.set(graphId, stateId);
    }
  }

  /** 旧档无 reachedStates 时回填：initialState + 当前 activeState 视为到达过。 */
  private restoreReachedStates(states: Record<string, unknown> | undefined): void {
    if (states && typeof states === 'object') {
      for (const [rawGraphId, listRaw] of Object.entries(states)) {
        if (!Array.isArray(listRaw)) continue;
        const graphId = this.migrateSaveGraphId(rawGraphId);
        const graph = this.graphs.get(graphId);
        if (!graph) {
          const dropped = listRaw.map((s) => String(s ?? '').trim()).filter(Boolean);
          this.warnDroppedSaveEntry(
            'save.reached.graphMissing',
            `NarrativeStateManager: save references unknown narrative graph "${rawGraphId}"${this.migrationSuffix(rawGraphId, graphId)}; dropped reached states [${dropped.join(', ')}] (reached-gates re-lock). If the graph was renamed, declare it in narrative_graphs.json migrations.graphs.`,
            graphId,
          );
          continue;
        }
        if (isRunGraph(graph)) continue; // 同 save.active.becameRunGraph 口径（active 侧已点名；活计走 runs 字段）
        for (const sRaw of listRaw) {
          const rawStateId = String(sRaw ?? '').trim();
          if (!rawStateId) continue;
          const stateId = this.migrateSaveStateId(graphId, rawStateId);
          if (!graph.states[stateId]) {
            this.warnDroppedSaveEntry(
              'save.reached.stateMissing',
              `NarrativeStateManager: save references unknown state "${rawStateId}"${this.migrationSuffix(rawStateId, stateId)} in graph "${graphId}"; dropped from reached states (its reached-gate re-locks). If the state was renamed, declare it in narrative_graphs.json migrations.states.`,
              graphId,
              stateId,
            );
            continue;
          }
          this.markStateReached(graphId, stateId);
        }
      }
    }
    for (const [graphId, stateId] of this.activeStates.entries()) {
      this.markStateReached(graphId, stateId);
      const graph = this.graphs.get(graphId);
      if (graph) this.markStateReached(graphId, graph.initialState);
    }
  }

  /** 单跳重映射存档里的图 id（对齐 FlagStore.migrations 语义：命中即映射、不追链）。 */
  private migrateSaveGraphId(graphId: string): string {
    const mapped = this.saveMigrations?.graphs?.[graphId];
    return typeof mapped === 'string' && mapped.trim() ? mapped.trim() : graphId;
  }

  /** 单跳重映射存档里的状态 id；graphId 须为图改名之后的当前 id。 */
  private migrateSaveStateId(graphId: string, stateId: string): string {
    const mapped = this.saveMigrations?.states?.[graphId]?.[stateId];
    return typeof mapped === 'string' && mapped.trim() ? mapped.trim() : stateId;
  }

  /** 迁移映射生效过时在告警里点出来，方便区分"改名没配映射"和"映射目标配错"。 */
  private migrationSuffix(rawId: string, migratedId: string): string {
    return migratedId && migratedId !== rawId ? ` (migrated to "${migratedId}")` : '';
  }

  /** 存档条目重映射后仍对不上注册图：进 recentIssues 留痕 + console.warn 点名，不再静默丢弃。 */
  private warnDroppedSaveEntry(code: string, message: string, graphId: string, stateId?: string): void {
    this.recordIssue({ severity: 'warning', code, message, graphId, stateId });
    console.warn(message);
  }

  destroy(): void {
    this.destroyed = true;
    this.generation += 1;
    // 清合批标志：已排入的微任务见 destroyed 早退（下句已断监听，不会再有新 flag:changed 入批）。
    this.reactiveEvalScheduled = false;
    this.eventBus.off('flag:changed', this.onFlagChangedListener);
    this.eventBus.off('save:restoring', this.onSaveRestoringListener);
    // 挂起项显式 reject（而非静默丢弃），让 await 中的动作链尽快失败退出；
    // 已处理完仅待落定的项照常 resolve。
    this.rejectQueuedItems(new Error('NarrativeStateManager destroyed'));
    this.resolveCompletedQueueItems();
    this.graphs.clear();
    this.activeStates.clear();
    this.reachedStates.clear();
    this.ownerIndex.clear();
    this.suspendedRunArchetypes.clear();
    this.livePackages.clear();
    this.runCounters.clear();
    this.activatedArchetype = null;
    this.nestedDrainPromises.clear();
    this.saveMigrations = null;
    this.queue.length = 0;
  }

  debugSnapshot(): Record<string, unknown> {
    const ownerIndex = Object.fromEntries(this.ownerIndex.entries());
    const multiWrapperOwners = Object.entries(ownerIndex)
      .filter(([, graphIds]) => Array.isArray(graphIds) && graphIds.length > 1)
      .map(([ownerKey, graphIds]) => ({ ownerKey, graphIds }));
    return {
      activeStates: Object.fromEntries(this.activeStates.entries()),
      graphIds: [...this.graphs.keys()],
      runArchetypes: this.getActiveRunArchetypes(),
      suspendedRuns: [...this.suspendedRunArchetypes],
      runCounters: Object.fromEntries(this.runCounters.entries()),
      activatedArchetype: this.activatedArchetype,
      livePackages: [...this.livePackages],
      knownPackages: this.getKnownPackageIds(),
      ownerIndex,
      multiWrapperOwners,
      // keep legacy fields for older debug consumers
      graphs: [...this.graphs.keys()],
      owners: ownerIndex,
      recentTransitions: this.recentTransitions.slice(-20),
      recentIssues: this.recentIssues.slice(-20),
      recentTrace: this.recentTrace.slice(-80),
      traceLength: this.recentTrace.length,
      queued: this.queue.length,
    };
  }

  clearDebugTrace(): void {
    this.recentTrace = [];
  }

  private ownerKey(ownerType: string, ownerId: string | undefined): string {
    const type = String(ownerType ?? '').trim();
    const id = String(ownerId ?? '').trim();
    return type && id ? `${type}:${id}` : '';
  }

  private indexGraphOwner(graph: NarrativeGraph): void {
    const key = this.ownerKey(graph.ownerType, graph.ownerId);
    if (!key) return;
    const ids = this.ownerIndex.get(key) ?? [];
    if (!ids.includes(graph.id)) ids.push(graph.id);
    this.ownerIndex.set(key, ids);
  }

  private recordDuplicateOwnerBindings(): void {
    for (const [key, graphIds] of this.ownerIndex.entries()) {
      if (graphIds.length <= 1) continue;
      const message = `NarrativeStateManager: owner has multiple wrapper graphs ${key} -> ${graphIds.join(', ')}`;
      this.recordIssue({ severity: 'warning', code: 'owner.wrapper.multi', message });
      console.warn(message);
    }
  }

  private recordPrimaryOwnerAmbiguous(ownerType: string, ownerId: string, graphIds: string[]): void {
    const key = `${ownerType}:${ownerId}`;
    if (this.primaryOwnerWarningKeys.has(key)) return;
    this.primaryOwnerWarningKeys.add(key);
    const message = `NarrativeStateManager: primary owner lookup is ambiguous for ${key}; bound wrapper graphs: ${graphIds.join(', ')}`;
    this.recordIssue({ severity: 'warning', code: 'owner.primary.ambiguous', message });
    console.warn(message);
  }

  private normalizeSignal(signal: NarrativeSignal): { key: NarrativeTriggerKey; source?: NarrativeSignal } | null {
    const sig = String(signal?.signal ?? '').trim();
    if (!sig) {
      console.warn('NarrativeStateManager: invalid signal (missing event id)', signal);
      return null;
    }
    const sourceType = String(signal?.sourceType ?? '').trim() as NarrativeSignal['sourceType'] | undefined;
    const sourceId = String(signal?.sourceId ?? '').trim();
    const source = sourceType && sourceId ? { signal: sig, sourceType, sourceId } : { signal: sig };
    return { key: sig, source };
  }

  private enqueue(trigger: QueuedTrigger): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    const queued = new Promise<void>((resolve, reject) => {
      this.queue.push({ trigger, resolve, reject });
    });
    this.recordTrace('trigger.enqueued', this.tracePatchForTrigger(trigger));
    if (!this.draining) {
      this.consumeDiscardedRejection(queued);
      const drain = this.drainQueue();
      this.drainPromise = drain.finally(() => {
        this.drainPromise = null;
      });
      return this.drainPromise;
    }
    if (this.runningActionsDepth > 0) {
      void this.drainNestedQueue();
      return queued;
    }
    const shared = this.drainPromise;
    if (shared) {
      this.consumeDiscardedRejection(queued);
      return shared;
    }
    return queued;
  }

  /**
   * 返回给调用方的是共享 drain promise 时，排队项自身的 promise 无人持有；
   * 挂 catch 消费其 rejection（错误已由 drain 侧 recordIssue/告警），避免 unhandledrejection 噪音。
   */
  private consumeDiscardedRejection(p: Promise<void>): void {
    p.catch((e) => {
      this.recordTrace('issue', {
        message: `discarded queued trigger rejected: ${e instanceof Error ? e.message : String(e)}`,
      });
    });
  }

  private async drainQueue(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    this.drainStepCount = 0;
    try {
      await this.drainAvailableQueue();
      this.resolveCompletedQueueItems();
    } finally {
      this.resolveCompletedQueueItems();
      this.draining = false;
      // 收尾窗口内（末次队列检查之后、draining 复位之前）入队的项没人处理，补启一轮。
      if (!this.destroyed && this.queue.length > 0) {
        this.startDetachedDrain();
      }
    }
  }

  /**
   * 动作执行期入队的排队项由嵌套排空处理（外层循环此刻挂起在动作批上）。
   * 同一 runningActionsDepth 槽位互斥：并发的第二个进入者等待在飞循环退场后重查队列，
   * 只在仍有积压时才另起循环——确保同一深度任何时刻只有一个排空循环在跑。
   */
  private async drainNestedQueue(): Promise<void> {
    const depth = this.runningActionsDepth;
    for (;;) {
      const inflight = this.nestedDrainPromises.get(depth);
      if (!inflight) break;
      await inflight;
    }
    if (this.destroyed || this.queue.length === 0) return;
    const loop = this.runNestedDrainLoop().finally(() => {
      if (this.nestedDrainPromises.get(depth) === loop) {
        this.nestedDrainPromises.delete(depth);
      }
    });
    this.nestedDrainPromises.set(depth, loop);
    return loop;
  }

  private async runNestedDrainLoop(): Promise<void> {
    try {
      await this.drainAvailableQueue(true);
    } catch {
      // The queued item's own promise carries the rejection to the awaiting action.
    }
  }

  private async drainAvailableQueue(nested = false): Promise<void> {
    try {
      while (this.queue.length > 0) {
        if (++this.drainStepCount > NarrativeStateManager.MAX_DRAIN_STEPS) {
          // 兜底防死循环：几乎总是反应式迁移条件互相触发形成振荡（内容错误）。
          // 记录为可诊断的 error issue（进 recentIssues / debugSnapshot），而非只 console.warn 近乎静默，
          // 便于策划/开发定位"叙事为何停在这里"。清空队列的兜底行为保持不变（fail-loud）。
          const message = 'NarrativeStateManager: drain loop guard tripped '
            + `(exceeded ${NarrativeStateManager.MAX_DRAIN_STEPS} steps; likely oscillating reactive transitions)`;
          const error = new Error(message);
          this.recordIssue({ severity: 'error', code: 'drain.loop.guard', message });
          console.warn(message);
          this.rejectQueuedItems(error);
          this.resolveCompletedQueueItems();
          break;
        }
        const item = this.queue.shift()!;
        await this.processQueueItem(item);
        if (this.queue.length === 0) {
          this.resolveCompletedQueueItems();
          // 嵌套循环只负责把队列清到让上层 await 的项落定为止：清空即退出，
          // 反应式重评一律留给最外层循环——否则嵌套循环因 reactive 追加而继续跑时，
          // 恰好被它解锁的外层循环也会恢复迭代，形成两个并发排空循环（B23）。
          if (nested) break;
          // After the queue is drained, evaluate reactive transitions.
          // If any fire, they push back to the queue, so the loop continues.
          if (!this.destroyed) {
            this.evaluateReactiveTriggers();
          }
        }
      }
    } catch (e) {
      this.rejectQueuedItems(e instanceof Error ? e : new Error(String(e)));
      // 已处理成功、仅待落定的项必须 resolve：嵌套排空的异常路径若把它们留在
      // completedQueueItems，外层动作 await 的 promise 永久悬挂 → 整个排空循环死锁（审查 W1）。
      this.resolveCompletedQueueItems();
      throw e;
    }
  }

  private resolveCompletedQueueItems(): void {
    const items = this.completedQueueItems.splice(0);
    for (const item of items) item.resolve();
  }

  private rejectQueuedItems(error: Error): void {
    const items = this.queue.splice(0);
    for (const item of items) item.reject(error);
  }

  private async processQueueItem(item: QueuedItem): Promise<void> {
    const trigger = item.trigger;
    try {
      this.recordTrace('trigger.start', this.tracePatchForTrigger(trigger));
      if (trigger.kind === 'setState') {
        await this.applyStateCommand(trigger.graphId, trigger.stateId);
      } else if (trigger.kind === 'reactive') {
        await this.processReactiveTrigger(trigger.graphId, trigger.transitionId);
      } else if (trigger.kind === 'runLifecycle') {
        await this.applyRunLifecycle(trigger);
      } else if (trigger.kind === 'packageLifecycle') {
        this.applyPackageLifecycle(trigger.packageId, trigger.live);
      } else {
        await this.processTrigger(NarrativeStateManager.normalizeTriggerKey(trigger.key));
      }
      this.recordTrace('trigger.end', this.tracePatchForTrigger(trigger));
      this.completedQueueItems.push(item);
    } catch (e) {
      this.recordTrace('issue', {
        message: `trigger failed: ${e instanceof Error ? e.message : String(e)}`,
        payload: { trigger },
      });
      item.reject(e);
      throw e;
    }
  }

  private async processTrigger(triggerKey: NarrativeTriggerKey): Promise<void> {
    const gen = this.generation;
    const migratedInstances = new Set<string>();
    // 迭代单位=常驻图 + 激活活计图（挂起活计冻结不扫）。快照迭代：
    // 处理途中被结算/弃置的活计经 getInstanceActive===undefined 与提交前复核自然跳过。
    const instanceEntries = this.listScannableGraphEntries();
    const matchedInstanceIds: string[] = [];
    for (const [instanceId, graph] of instanceEntries) {
      // 逐图 await 之间可能发生读档/换册：本信号属旧时间线，剩余图不再扫。
      if (gen !== this.generation) break;
      if (migratedInstances.has(instanceId)) continue;
      const active = this.getInstanceActive(instanceId, graph);
      if (active === undefined) continue; // 活计实例已在本次扫描途中结算/移除
      const candidates = graph.transitions
        .filter((t) => {
          if (!NarrativeStateManager.triggerKeysEqual(t.signal, triggerKey)) return false;
          if (!this.isLocalEndpoint(t.from) || !this.isLocalEndpoint(t.to)) {
            this.recordUnsupportedEndpoint(instanceId, t.id);
            return false;
          }
          return t.from === active &&
            this.conditionsMet(t.conditions);
        })
        .map((t, index) => ({ t, index }))
        .sort((a, b) => {
          const pa = a.t.priority ?? 0;
          const pb = b.t.priority ?? 0;
          if (pa !== pb) return pb - pa;
          return a.index - b.index;
        });
      const selected = candidates[0]?.t;
      if (!selected) continue;
      await this.applyTransition(graph, instanceId, selected, triggerKey);
      migratedInstances.add(instanceId);
      matchedInstanceIds.push(instanceId);
    }
    if (matchedInstanceIds.length === 0) {
      this.reportUnlistenedSignal(triggerKey);
    }
    this.recordTrace('signal.processed', {
      triggerKey,
      payload: { matchedGraphIds: matchedInstanceIds },
      message: matchedInstanceIds.length ? `matched ${matchedInstanceIds.length} instance(s)` : 'no matching transition',
    });
  }

  /**
   * 图当前激活态：常驻图回退 initialState（历史行为）；活计图实例不存在即 undefined
   * （已结算/已弃置——绝不回退 initialState，否则消亡实例会以出生态复活匹配迁移）。
   */
  private getInstanceActive(graphId: string, graph: NarrativeGraph): string | undefined {
    const active = this.activeStates.get(graphId);
    if (active !== undefined) return active;
    return isRunGraph(graph) ? undefined : graph.initialState;
  }

  private getListenedSignalKeys(): Set<string> {
    if (!this.listenedSignalKeysCache) {
      const keys = new Set<string>();
      for (const graph of this.graphs.values()) {
        for (const t of graph.transitions) {
          if (t.trigger && t.trigger !== 'signal') continue;
          const key = NarrativeStateManager.normalizeTriggerKey(t.signal);
          if (key) keys.add(key);
        }
      }
      this.listenedSignalKeysCache = keys;
    }
    return this.listenedSignalKeysCache;
  }

  /**
   * 信号本次零命中且**静态**无任何图监听 = 悬垂（多为信号改名/删除后遗留的发射端）。
   * 区别于「有监听但 from 状态不在位」的正常重复/迟到发射——那种保持 trace-only 不打扰。
   * dev 顶部错误面点名 + recentIssues 留痕（prod 只留痕），同名只报一次。
   */
  private reportUnlistenedSignal(triggerKey: NarrativeTriggerKey): void {
    const key = NarrativeStateManager.normalizeTriggerKey(triggerKey);
    if (!key || key === DEFAULT_NARRATIVE_DRAFT_SIGNAL) return;
    if (this.graphs.size === 0) return;
    if (this.reportedUnlistenedSignalKeys.has(key)) return;
    if (this.getListenedSignalKeys().has(key)) return;
    this.reportedUnlistenedSignalKeys.add(key);
    const message = `NarrativeStateManager: signal "${key}" has no listening transition in any registered graph (emit is a no-op); likely dangling after rename/delete`;
    this.recordIssue({ severity: 'warning', code: 'signal.unlistened', message });
    reportDevError(
      `叙事信号 "${key}" 没有任何已注册叙事图的 transition 监听，发射不推动任何状态——疑似信号改名/删除后的悬垂发射端`,
      '[narrative]',
    );
  }

  private conditionsMet(conditions: ConditionExpr[] | undefined): boolean {
    if (!conditions?.length) return true;
    let ctx: ConditionEvalContext | undefined;
    try {
      ctx = this.conditionCtxFactory?.();
    } catch (e) {
      // 工厂抛错若放行到排空循环里，会经嵌套排空异常路径把整个循环拖挂（审查 W1）；
      // 按"缺上下文"同口径保守拒绝该守卫迁移。
      const message = `NarrativeStateManager: condition context factory threw; rejecting guarded transition: ${e instanceof Error ? e.message : String(e)}`;
      this.recordIssue({ severity: 'error', code: 'condition.ctxFactory.threw', message });
      console.warn(message, e);
      return false;
    }
    if (!ctx) {
      console.warn('NarrativeStateManager: missing condition context; rejecting guarded transition');
      return false;
    }
    return evaluateConditionExprList(conditions, ctx);
  }

  /**
   * Evaluate all reactive transitions across all graphs.
   * Called after any state change to check if reactive conditions are now met.
   * Pushes matching transitions directly into the queue for processing.
   */
  private evaluateReactiveTriggers(): void {
    for (const [instanceId, graph] of this.listScannableGraphEntries()) {
      const active = this.getInstanceActive(instanceId, graph);
      if (active === undefined) continue;
      // 单遍取最优候选，免去每次扫描的 filter().map().sort() 三次临时数组分配。
      // 仍遍历全部 transition、按原顺序求同一组谓词（含 recordUnsupportedEndpoint 副作用），
      // 与旧「先全量筛选、再按 priority 降序 / 声明序升序排」的选择结果逐字节等价。
      let selected: NarrativeTransition | undefined;
      let selectedPriority = 0;
      for (const t of graph.transitions) {
        if (!t.trigger || t.trigger === 'signal') continue;
        if (t.from !== active) continue;
        if (!this.isLocalEndpoint(t.from) || !this.isLocalEndpoint(t.to)) {
          this.recordUnsupportedEndpoint(instanceId, t.id);
          continue;
        }
        if (!this.evaluateReactiveConditions(t)) continue;
        const priority = t.priority ?? 0;
        // 声明序即遍历序：严格更高优先级才替换，平级保留先出现者。
        if (selected === undefined || priority > selectedPriority) {
          selected = t;
          selectedPriority = priority;
        }
      }
      if (!selected) continue;
      this.recordTrace('reactive.queued', {
        graphId: instanceId,
        transitionId: selected.id,
        triggerKey: '__reactive__',
      });
      this.queue.push({
        trigger: { kind: 'reactive', graphId: graph.id, transitionId: selected.id },
        resolve: () => {},
        reject: () => {},
      });
    }
  }

  /**
   * Evaluate conditions based on trigger mode:
   * - 'reactive':    pass-through, supports complex nested condition trees
   * - 'reactiveAll': auto-wrap flat list in {all: conditions}
   * - 'reactiveAny': auto-wrap flat list in {any: conditions}
   */
  private evaluateReactiveConditions(t: NarrativeTransition): boolean {
    if (!t.conditions?.length) return false;
    if (t.trigger === 'reactive') {
      return this.conditionsMet(t.conditions);
    }
    if (t.trigger === 'reactiveAll') {
      return this.conditionsMet([{ all: t.conditions }]);
    }
    if (t.trigger === 'reactiveAny') {
      return this.conditionsMet([{ any: t.conditions }]);
    }
    return false;
  }

  /** Process a queued reactive trigger by double-checking conditions and applying the transition. */
  private async processReactiveTrigger(graphId: string, transitionId: string): Promise<void> {
    const graph = this.graphs.get(graphId);
    const transition = graph?.transitions.find(t => t.id === transitionId);
    if (graph && transition?.trigger) {
      // 活计图仅在激活时才推进（挂起冻结）；实例不存在（结算/弃置）时 getInstanceActive 为 undefined。
      if (isRunGraph(graph) && graphId !== this.activatedArchetype) return;
      const active = this.getInstanceActive(graphId, graph);
      if (active === undefined || transition.from !== active) return;
      if (this.evaluateReactiveConditions(transition)) {
        await this.applyTransition(graph, graphId, transition, '__reactive__');
      }
    }
  }

  private async applyStateCommand(graphId: string, stateId: string): Promise<void> {
    const graph = this.graphs.get(graphId);
    if (graph && isRunGraph(graph)) {
      // setState/warp 不支持活计图（会凭空造出幽灵实例条目）；进活计走 start+信号，修复走 reset/revert。
      const message = `NarrativeStateManager: setState 不支持活计图 ${graphId}（用 startNarrativeRun+信号，或 reset/revert）`;
      this.recordIssue({ severity: 'warning', code: 'setState.runGraph.unsupported', message, graphId, stateId });
      console.warn(message);
      return;
    }
    if (!graph || !graph.states[stateId]) {
      const message = `NarrativeStateManager: setState target missing ${graphId}.${stateId}`;
      this.recordIssue({ severity: 'warning', code: 'setState.target.missing', message, graphId, stateId });
      this.recordTrace('state.command', { graphId, stateId, message: 'target missing' });
      console.warn(message);
      return;
    }
    if (!this.canRemoteEnterState(graph, stateId)) {
      const message = `NarrativeStateManager: setState target violates scenario boundary ${graphId}.${stateId}`;
      this.recordIssue({ severity: 'error', code: 'scenario.boundary.stateCommand', message, graphId, stateId });
      this.recordTrace('state.command', { graphId, stateId, message: 'scenario boundary rejected' });
      console.warn(message);
      return;
    }
    const from = this.activeStates.get(graphId) ?? graph.initialState;
    this.recordTrace('state.command', { graphId, stateId, from, to: stateId, message: 'applying debug state command' });
    await this.enterState(graph, graphId, from, stateId, `setState:${graphId}:${stateId}`);
  }

  private async applyTransition(
    graph: NarrativeGraph,
    instanceId: string,
    transition: NarrativeTransition,
    triggerKey: NarrativeTriggerKey,
  ): Promise<void> {
    if (!this.isLocalEndpoint(transition.from) || !this.isLocalEndpoint(transition.to)) {
      this.recordUnsupportedEndpoint(instanceId, transition.id);
      return;
    }
    // 提交前复核当前 active（signal 路径与 reactive 路径同一口径）：候选筛选与提交之间
    // 可能有嵌套排空已迁移本实例（如前序图的动作发出的信号），过期迁移直接放弃，防双迁移丢更新。
    // 实例已消亡（结算/弃单）时 getInstanceActive 为 undefined，同样放弃。
    const activeNow = this.getInstanceActive(instanceId, graph);
    if (activeNow === undefined || transition.from !== activeNow) {
      this.recordTrace('signal.ignored', {
        graphId: instanceId,
        transitionId: transition.id,
        triggerKey,
        message: `stale transition: from=${transition.from} but active=${activeNow ?? '<gone>'}`,
      });
      return;
    }
    const fromStateId = transition.from;
    const toStateId = transition.to;
    if (!graph.states[fromStateId]) {
      const message = `NarrativeStateManager: transition source missing ${instanceId}.${fromStateId}`;
      this.recordIssue({ severity: 'warning', code: 'transition.from.missing', message, graphId: instanceId, stateId: fromStateId, transitionId: transition.id });
      console.warn(message);
      return;
    }
    if (!graph.states[toStateId]) {
      const message = `NarrativeStateManager: transition target missing ${instanceId}.${toStateId}`;
      this.recordIssue({ severity: 'warning', code: 'transition.target.missing', message, graphId: instanceId, stateId: toStateId, transitionId: transition.id });
      console.warn(message);
      return;
    }
    await this.enterState(graph, instanceId, fromStateId, toStateId, triggerKey, transition.id);
  }

  private async enterState(
    graph: NarrativeGraph,
    instanceId: string,
    fromStateId: string,
    toStateId: string,
    triggerKey: NarrativeTriggerKey,
    transitionId = '',
  ): Promise<void> {
    const gen = this.generation;
    const runGraph = isRunGraph(graph);
    const fromState = graph.states[fromStateId];
    const toState = graph.states[toStateId];
    await this.runActions(fromState?.onExitActions, `${instanceId}.${fromStateId}.onExit`);
    // onExit 动作 await 期间可能发生读档/换册（代际切换）：旧时间线的迁移不得再写
    // 恢复后的状态（置态/事件/广播全部放弃）。动作自身的副作用无法撤销，属已知边界。
    // 实例还可能在 await 期间被结算/弃单（消亡）——同样放弃。
    if (gen !== this.generation || this.getInstanceActive(instanceId, graph) !== fromStateId) {
      this.recordTrace('signal.ignored', {
        graphId: instanceId,
        transitionId,
        triggerKey,
        message: `stale timeline: state restored or instance changed during ${instanceId}.${fromStateId}.onExit; transition aborted`,
      });
      return;
    }
    this.recordTrace('transition.applied', {
      graphId: instanceId,
      transitionId,
      triggerKey,
      from: fromStateId,
      to: toStateId,
    });
    this.activeStates.set(instanceId, toStateId);
    this.markStateReached(instanceId, toStateId);
    this.recentTransitions.push({ graphId: instanceId, transitionId, from: fromStateId, to: toStateId, triggerKey });
    if (this.recentTransitions.length > 50) this.recentTransitions.splice(0, this.recentTransitions.length - 50);
    this.recordTrace('state.changed', {
      graphId: instanceId,
      transitionId,
      triggerKey,
      from: fromStateId,
      to: toStateId,
    });
    this.eventBus.emit('narrative:stateChanged', {
      graphId: instanceId,
      from: fromStateId,
      to: toStateId,
      triggerKey,
      transitionId,
      cause: 'transition',
    });
    await this.runActions(toState?.onEnterActions, `${instanceId}.${toStateId}.onEnter`);
    // onEnter 动作 await 期间发生读档/换册：本次置态已被恢复流程覆盖，广播属旧时间线，放弃。
    // 实例被并发结算/弃单或状态被顶替（active 复核）同样放弃广播与结算（审查遗留实现注记）。
    if (gen !== this.generation || this.activeStates.get(instanceId) !== toStateId) {
      this.recordTrace('signal.ignored', {
        graphId: instanceId,
        stateId: toStateId,
        triggerKey,
        message: `stale timeline: state restored or instance changed during ${instanceId}.${toStateId}.onEnter; broadcast suppressed`,
      });
      return;
    }
    if (toState?.broadcastOnEnter === true) {
      this.enqueueGraphStateEntered(instanceId, toStateId);
    }
    // 到达出口状态=自动结算（onEnter 已跑完、广播已入队；结算发生在两者之后，
    // 保证交付演出/发钱发物先完成、跨图监听者拿得到广播键字符串）。
    if (runGraph && Array.isArray(graph.exitStates) && graph.exitStates.includes(toStateId)) {
      this.settleRunInstance(instanceId, toStateId);
    }
  }

  /** Queue a re-emit-safe cross-graph broadcast; processed after the current queue item (no await). */
  private enqueueGraphStateEntered(graphId: string, stateId: string): void {
    if (this.destroyed) return;
    const key = NarrativeStateManager.stateEnteredSignalKey(graphId, stateId);
    const source: NarrativeSignal = { signal: key, sourceType: 'state', sourceId: graphId };
    this.recordTrace('signal.broadcast', {
      graphId,
      stateId,
      triggerKey: key,
      payload: { source },
    });
    this.queue.push({ trigger: { kind: 'external', key, source }, resolve: () => {}, reject: () => {} });
    if (this.draining && this.runningActionsDepth > 0) {
      void this.drainNestedQueue();
    }
  }

  private isLocalEndpoint(endpoint: unknown): endpoint is string {
    return typeof endpoint === 'string' && endpoint.trim().length > 0;
  }

  private recordUnsupportedEndpoint(graphId: string, transitionId: string): void {
    const message = `NarrativeStateManager: transition ${graphId}.${transitionId} uses unsupported cross-graph endpoint data`;
    this.recordIssue({ severity: 'error', code: 'transition.crossGraphEndpoint.unsupported', message, graphId, transitionId });
    console.warn(message);
  }

  private async runActions(actions: ActionDef[] | undefined, label: string): Promise<void> {
    if (!actions?.length) return;
    try {
      this.recordTrace('actions.start', {
        label,
        payload: { count: actions.length, types: actions.map((action) => action.type) },
      });
      this.runningActionsDepth += 1;
      await this.actionExecutor.executeBatchAwait(actions);
      this.recordTrace('actions.end', {
        label,
        payload: { count: actions.length },
      });
    } catch (e) {
      console.warn(`NarrativeStateManager: lifecycle actions failed at ${label}`, e);
      this.recordTrace('actions.failed', {
        label,
        message: e instanceof Error ? e.message : String(e),
        payload: { count: actions.length },
      });
    } finally {
      this.runningActionsDepth = Math.max(0, this.runningActionsDepth - 1);
    }
  }

  private isScenarioGraph(graph: NarrativeGraph): boolean {
    return graph.ownerType === 'scenario' || Boolean(graph.entryState || graph.exitStates?.length);
  }

  private canRemoteEnterState(graph: NarrativeGraph, stateId: string): boolean {
    if (!this.isScenarioGraph(graph)) return true;
    return stateId === graph.entryState || Boolean(graph.exitStates?.includes(stateId));
  }

  private canLeaveGraphRemotely(graph: NarrativeGraph, stateId: string): boolean {
    if (!this.isScenarioGraph(graph)) return true;
    return Boolean(graph.exitStates?.includes(stateId));
  }

  private recordIssue(issue: NarrativeRuntimeIssue): void {
    this.recentIssues.push(issue);
    if (this.recentIssues.length > 50) this.recentIssues.splice(0, this.recentIssues.length - 50);
    this.recordTrace('issue', {
      graphId: issue.graphId,
      stateId: issue.stateId,
      transitionId: issue.transitionId,
      message: issue.message,
      payload: { severity: issue.severity, code: issue.code },
    });
  }

  private recordTrace(type: NarrativeTraceEventType, patch: Partial<NarrativeTraceEvent> = {}): void {
    const event: NarrativeTraceEvent = {
      seq: ++this.traceSeq,
      at: Date.now(),
      type,
      ...patch,
    };
    this.recentTrace.push(event);
    if (this.recentTrace.length > NarrativeStateManager.MAX_TRACE_EVENTS) {
      this.recentTrace.splice(0, this.recentTrace.length - NarrativeStateManager.MAX_TRACE_EVENTS);
    }
  }

  private tracePatchForTrigger(trigger: QueuedTrigger): Partial<NarrativeTraceEvent> {
    if (trigger.kind === 'external') {
      return {
        triggerKey: trigger.key,
        payload: { kind: trigger.kind, source: trigger.source },
      };
    }
    if (trigger.kind === 'setState') {
      return {
        graphId: trigger.graphId,
        stateId: trigger.stateId,
        triggerKey: `setState:${trigger.graphId}:${trigger.stateId}`,
        payload: { kind: trigger.kind },
      };
    }
    if (trigger.kind === 'runLifecycle') {
      return {
        graphId: trigger.graphId,
        triggerKey: `run:${trigger.op}`,
        payload: { kind: trigger.kind, op: trigger.op, ...(trigger.stateId ? { stateId: trigger.stateId } : {}) },
      };
    }
    if (trigger.kind === 'packageLifecycle') {
      return {
        triggerKey: `package:${trigger.live ? 'load' : 'unload'}:${trigger.packageId}`,
        payload: { kind: trigger.kind, packageId: trigger.packageId, live: trigger.live },
      };
    }
    return {
      graphId: trigger.graphId,
      transitionId: trigger.transitionId,
      triggerKey: '__reactive__',
      payload: { kind: trigger.kind },
    };
  }

  private isDevRuntime(): boolean {
    const meta = import.meta as unknown as { env?: { DEV?: boolean; MODE?: string } };
    return Boolean(meta.env?.DEV || meta.env?.MODE === 'development');
  }

  private defaultRuntimeValidationMode(): NarrativeRuntimeValidationMode {
    const meta = import.meta as unknown as {
      env?: { DEV?: boolean; MODE?: string; VITE_NARRATIVE_VALIDATE_RUNTIME?: string };
    };
    const raw = String(meta.env?.VITE_NARRATIVE_VALIDATE_RUNTIME ?? '').trim().toLowerCase();
    if (raw === 'off' || raw === '0' || raw === 'false') return 'off';
    if (raw === 'throw' || raw === 'error' || raw === 'strict') return 'throw';
    if (raw === 'warn' || raw === '1' || raw === 'true') return 'warn';
    return Boolean(meta.env?.DEV || meta.env?.MODE === 'development') ? 'warn' : 'off';
  }

  private validateLoadedData(data: NarrativeGraphsFile, path: string): void {
    if (this.validationMode === 'off') return;
    const issues = validateNarrativeGraphData(data);
    if (issues.length === 0) return;
    for (const issue of issues) {
      this.recordValidationIssue(issue);
    }
    const errors = blockingNarrativeValidationErrors(issues);
    const summary = `NarrativeStateManager: ${path} validation found ${errors.length} error(s), ${issues.length - errors.length} warning(s)`;
    if (errors.length > 0 && this.validationMode === 'throw') {
      const preview = errors.slice(0, 5).map((issue) => `${issue.code}: ${issue.message}`).join('; ');
      throw new Error(`${summary}. ${preview}`);
    }
    console.warn(summary, issues);
  }

  private recordValidationIssue(issue: NarrativeValidationIssue): void {
    this.recordIssue({
      severity: issue.severity,
      code: issue.code,
      message: issue.path ? `${issue.message} (${issue.path})` : issue.message,
      graphId: issue.itemId,
    });
  }
}

export function compileNarrativeGraphs(data: NarrativeGraphsFile | null | undefined): NarrativeGraph[] {
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data.compositions)) {
    const out: NarrativeGraph[] = [];
    for (const comp of data.compositions) {
      if (!comp || typeof comp !== 'object') continue;
      // 章节包标（纯组织标签，不 gate 运行时——见 packageId / listScannableGraphEntries）：
      // composition.package 盖整组；element.package 覆盖单元素（主线里程碑图与子图同编排——
      // mainGraph 只随 composition.package，不继承元素包；子图各打各章节的包，仅供分组）。
      const compPkg = typeof comp.package === 'string' && comp.package.trim() ? comp.package.trim() : undefined;
      if (isNarrativeGraph(comp.mainGraph)) {
        if (compPkg) comp.mainGraph.packageId = compPkg;
        out.push(comp.mainGraph);
      }
      const elements = Array.isArray(comp.elements) ? comp.elements : [];
      for (const el of elements) {
        if (!el || typeof el !== 'object') continue;
        if ((el.kind === 'wrapperGraph' || el.kind === 'scenarioSubgraph') && isNarrativeGraph(el.graph)) {
          const elPkg = typeof el.package === 'string' && el.package.trim() ? el.package.trim() : compPkg;
          if (elPkg) el.graph.packageId = elPkg;
          out.push(el.graph);
        }
      }
    }
    return out;
  }
  return Array.isArray(data.graphs) ? data.graphs.filter(isNarrativeGraph) : [];
}

function isNarrativeGraph(x: unknown): x is NarrativeGraph {
  const g = x as NarrativeGraph;
  return Boolean(
    g &&
      typeof g === 'object' &&
      typeof g.id === 'string' &&
      typeof g.initialState === 'string' &&
      g.states &&
      typeof g.states === 'object' &&
      Array.isArray(g.transitions),
  );
}
