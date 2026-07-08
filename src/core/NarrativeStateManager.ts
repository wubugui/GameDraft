import type { ActionExecutor } from './ActionExecutor';
import type { AssetManager } from './AssetManager';
import type { EventBus } from './EventBus';
import type { FlagStore } from './FlagStore';
import type { ActionDef, ConditionExpr, GameContext, IGameSystem } from '../data/types';
import type { ConditionEvalContext } from '../systems/graphDialogue/evaluateGraphCondition';
import { evaluateConditionExprList } from '../systems/graphDialogue/conditionEvalBridge';
import {
  blockingNarrativeValidationErrors,
  validateNarrativeGraphData,
  type NarrativeValidationIssue,
} from './narrativeGraphValidation';
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

export interface NarrativeGraph {
  id: string;
  label?: string;
  ownerType: NarrativeOwnerType;
  ownerId?: string;
  /** Author note/category for wrapper usage grouping in tooling. */
  category?: string;
  initialState: string;
  entryState?: string;
  exitStates?: string[];
  states: Record<string, NarrativeStateNode>;
  transitions: NarrativeTransition[];
  projectFlags?: boolean;
}

export interface NarrativeGraphsFile {
  schemaVersion?: number;
  graphs?: NarrativeGraph[];
  compositions?: NarrativeComposition[];
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
  meta?: Record<string, unknown>;
}

export interface NarrativeComposition {
  id: string;
  label?: string;
  description?: string;
  mainGraph: NarrativeGraph;
  elements?: NarrativeCompositionElement[];
}

type QueuedTrigger =
  | { kind: 'external'; key: NarrativeTriggerKey; source?: NarrativeSignal }
  | { kind: 'setState'; graphId: string; stateId: string }
  | { kind: 'reactive'; graphId: string; transitionId: string };

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
  private activeStates: Map<string, string> = new Map();
  private ownerIndex: Map<string, string[]> = new Map();
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
   * 被动 flag:changed → reactive 重评的微任务合批标志。一个 action 批内连 setFlag N 次只排一次
   * 微任务、只跑一轮全量 reactive 扫描（与 ArchiveManager 的 queueMicrotask 合批策略一致）。
   * 仅覆盖被动路径；信号/setState/注入/读档等主动重评仍直接同步 kick，不受此合批影响。
   */
  private reactiveEvalScheduled = false;
  private readonly onFlagChangedListener = () => this.handleFlagChanged();
  private recentTransitions: NarrativeTransitionRecord[] = [];
  /** graphId → 到达过的状态集合（含 initialState 与当前状态），随存档持久化 */
  private reachedStates: Map<string, Set<string>> = new Map();
  private recentIssues: NarrativeRuntimeIssue[] = [];
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
      this.registerGraphs(compileNarrativeGraphs(data));
    } catch (e) {
      const message = `NarrativeStateManager: narrative_graphs.json not found or invalid: ${String(e)}`;
      this.recordIssue({ severity: 'error', code: 'narrative.load.failed', message });
      if (this.isDevRuntime()) {
        throw e;
      }
      console.warn('NarrativeStateManager: narrative_graphs.json not found or invalid, running empty', e);
      this.registerGraphs([]);
    }
  }

  registerGraphs(graphs: NarrativeGraph[]): void {
    this.graphs.clear();
    this.activeStates.clear();
    this.reachedStates.clear();
    this.ownerIndex.clear();
    this.queue.length = 0;
    this.primaryOwnerWarningKeys.clear();
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

  serialize(): object {
    return {
      activeStates: Object.fromEntries(this.activeStates.entries()),
      reachedStates: Object.fromEntries(
        [...this.reachedStates.entries()].map(([g, set]) => [g, [...set]]),
      ),
    };
  }

  deserialize(data: object): void {
    const raw = data as {
      activeStates?: Record<string, unknown>;
      reachedStates?: Record<string, unknown>;
    };
    // 先把全部图复位到「注册后初始态」再按存档恢复：restore 只覆盖存档里有的图、只增量标记
    // reached，不复位会把本会话越过的进度残留进更早的档（reached:true 门控提前打开）。
    this.resetStatesToRegisteredBaseline();
    this.restoreActiveStates(raw?.activeStates ?? {});
    this.restoreReachedStates(raw?.reachedStates);
    // 读档后的状态组合可能已满足某些 reactive 迁移条件（读档期间 FlagStore.deserialize
    // 不广播 flag:changed），此处统一补评一轮。
    this.kickReactiveEvaluation();
  }

  /** 与 registerGraphs 注册完成时一致：activeStates=initialState，reached 仅含 initialState。 */
  private resetStatesToRegisteredBaseline(): void {
    this.activeStates.clear();
    this.reachedStates.clear();
    for (const graph of this.graphs.values()) {
      this.activeStates.set(graph.id, graph.initialState);
      this.markStateReached(graph.id, graph.initialState);
    }
  }

  restoreActiveStates(states: Record<string, unknown>): void {
    for (const [graphId, stateRaw] of Object.entries(states ?? {})) {
      const graph = this.graphs.get(graphId);
      const stateId = String(stateRaw ?? '').trim();
      if (!graph || !stateId || !graph.states[stateId]) continue;
      this.activeStates.set(graphId, stateId);
    }
  }

  /** 旧档无 reachedStates 时回填：initialState + 当前 activeState 视为到达过。 */
  private restoreReachedStates(states: Record<string, unknown> | undefined): void {
    if (states && typeof states === 'object') {
      for (const [graphId, listRaw] of Object.entries(states)) {
        const graph = this.graphs.get(graphId);
        if (!graph || !Array.isArray(listRaw)) continue;
        for (const sRaw of listRaw) {
          const stateId = String(sRaw ?? '').trim();
          if (stateId && graph.states[stateId]) this.markStateReached(graphId, stateId);
        }
      }
    }
    for (const [graphId, stateId] of this.activeStates.entries()) {
      this.markStateReached(graphId, stateId);
      const graph = this.graphs.get(graphId);
      if (graph) this.markStateReached(graphId, graph.initialState);
    }
  }

  destroy(): void {
    this.destroyed = true;
    // 清合批标志：已排入的微任务见 destroyed 早退（下句已断监听，不会再有新 flag:changed 入批）。
    this.reactiveEvalScheduled = false;
    this.eventBus.off('flag:changed', this.onFlagChangedListener);
    // 挂起项显式 reject（而非静默丢弃），让 await 中的动作链尽快失败退出；
    // 已处理完仅待落定的项照常 resolve。
    this.rejectQueuedItems(new Error('NarrativeStateManager destroyed'));
    this.resolveCompletedQueueItems();
    this.graphs.clear();
    this.activeStates.clear();
    this.reachedStates.clear();
    this.ownerIndex.clear();
    this.nestedDrainPromises.clear();
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
    const migratedGraphs = new Set<string>();
    const graphEntries = [...this.graphs.entries()];
    const matchedGraphIds: string[] = [];
    for (const [graphId, graph] of graphEntries) {
      if (migratedGraphs.has(graphId)) continue;
      const active = this.activeStates.get(graphId) ?? graph.initialState;
      const candidates = graph.transitions
        .filter((t) => {
          if (!NarrativeStateManager.triggerKeysEqual(t.signal, triggerKey)) return false;
          if (!this.isLocalEndpoint(t.from) || !this.isLocalEndpoint(t.to)) {
            this.recordUnsupportedEndpoint(graphId, t.id);
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
      await this.applyTransition(graph, selected, triggerKey);
      migratedGraphs.add(graphId);
      matchedGraphIds.push(graphId);
    }
    this.recordTrace('signal.processed', {
      triggerKey,
      payload: { matchedGraphIds },
      message: matchedGraphIds.length ? `matched ${matchedGraphIds.length} graph(s)` : 'no matching transition',
    });
  }

  private conditionsMet(conditions: ConditionExpr[] | undefined): boolean {
    if (!conditions?.length) return true;
    const ctx = this.conditionCtxFactory?.();
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
    for (const [graphId, graph] of this.graphs) {
      const active = this.activeStates.get(graphId) ?? graph.initialState;
      // 单遍取最优候选，免去每次扫描的 filter().map().sort() 三次临时数组分配。
      // 仍遍历全部 transition、按原顺序求同一组谓词（含 recordUnsupportedEndpoint 副作用），
      // 与旧「先全量筛选、再按 priority 降序 / 声明序升序排」的选择结果逐字节等价。
      let selected: NarrativeTransition | undefined;
      let selectedPriority = 0;
      for (const t of graph.transitions) {
        if (!t.trigger || t.trigger === 'signal') continue;
        if (t.from !== active) continue;
        if (!this.isLocalEndpoint(t.from) || !this.isLocalEndpoint(t.to)) {
          this.recordUnsupportedEndpoint(graphId, t.id);
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
        graphId,
        transitionId: selected.id,
        triggerKey: '__reactive__',
      });
      this.queue.push({
        trigger: { kind: 'reactive', graphId, transitionId: selected.id },
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
      const active = this.activeStates.get(graphId) ?? graph.initialState;
      if (transition.from !== active) return;
      if (this.evaluateReactiveConditions(transition)) {
        await this.applyTransition(graph, transition, '__reactive__');
      }
    }
  }

  private async applyStateCommand(graphId: string, stateId: string): Promise<void> {
    const graph = this.graphs.get(graphId);
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
    await this.enterState(graph, from, stateId, `setState:${graphId}:${stateId}`);
  }

  private async applyTransition(
    graph: NarrativeGraph,
    transition: NarrativeTransition,
    triggerKey: NarrativeTriggerKey,
  ): Promise<void> {
    if (!this.isLocalEndpoint(transition.from) || !this.isLocalEndpoint(transition.to)) {
      this.recordUnsupportedEndpoint(graph.id, transition.id);
      return;
    }
    // 提交前复核当前 active（signal 路径与 reactive 路径同一口径）：候选筛选与提交之间
    // 可能有嵌套排空已迁移本图（如前序图的动作发出的信号），过期迁移直接放弃，防双迁移丢更新。
    const activeNow = this.activeStates.get(graph.id) ?? graph.initialState;
    if (transition.from !== activeNow) {
      this.recordTrace('signal.ignored', {
        graphId: graph.id,
        transitionId: transition.id,
        triggerKey,
        message: `stale transition: from=${transition.from} but active=${activeNow}`,
      });
      return;
    }
    const fromStateId = transition.from;
    const toStateId = transition.to;
    if (!graph.states[fromStateId]) {
      const message = `NarrativeStateManager: transition source missing ${graph.id}.${fromStateId}`;
      this.recordIssue({ severity: 'warning', code: 'transition.from.missing', message, graphId: graph.id, stateId: fromStateId, transitionId: transition.id });
      console.warn(message);
      return;
    }
    if (!graph.states[toStateId]) {
      const message = `NarrativeStateManager: transition target missing ${graph.id}.${toStateId}`;
      this.recordIssue({ severity: 'warning', code: 'transition.target.missing', message, graphId: graph.id, stateId: toStateId, transitionId: transition.id });
      console.warn(message);
      return;
    }
    await this.enterState(graph, fromStateId, toStateId, triggerKey, transition.id);
  }

  private async enterState(
    graph: NarrativeGraph,
    fromStateId: string,
    toStateId: string,
    triggerKey: NarrativeTriggerKey,
    transitionId = '',
  ): Promise<void> {
    const fromState = graph.states[fromStateId];
    const toState = graph.states[toStateId];
    await this.runActions(fromState?.onExitActions, `${graph.id}.${fromStateId}.onExit`);
    this.recordTrace('transition.applied', {
      graphId: graph.id,
      transitionId,
      triggerKey,
      from: fromStateId,
      to: toStateId,
    });
    this.activeStates.set(graph.id, toStateId);
    this.markStateReached(graph.id, toStateId);
    this.recentTransitions.push({ graphId: graph.id, transitionId, from: fromStateId, to: toStateId, triggerKey });
    if (this.recentTransitions.length > 50) this.recentTransitions.splice(0, this.recentTransitions.length - 50);
    this.recordTrace('state.changed', {
      graphId: graph.id,
      transitionId,
      triggerKey,
      from: fromStateId,
      to: toStateId,
    });
    this.eventBus.emit('narrative:stateChanged', {
      graphId: graph.id,
      from: fromStateId,
      to: toStateId,
      triggerKey,
      transitionId,
    });
    await this.runActions(toState?.onEnterActions, `${graph.id}.${toStateId}.onEnter`);
    if (toState?.broadcastOnEnter === true) {
      this.enqueueGraphStateEntered(graph.id, toStateId);
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
      if (isNarrativeGraph(comp.mainGraph)) {
        out.push(comp.mainGraph);
      }
      const elements = Array.isArray(comp.elements) ? comp.elements : [];
      for (const el of elements) {
        if (!el || typeof el !== 'object') continue;
        if ((el.kind === 'wrapperGraph' || el.kind === 'scenarioSubgraph') && isNarrativeGraph(el.graph)) {
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
