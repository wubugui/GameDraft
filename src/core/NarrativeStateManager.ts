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

export type NarrativeOwnerType =
  | 'flow'
  | 'npc'
  | 'hotspot'
  | 'zone'
  | 'quest'
  | 'scenario'
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
  ownerType: NarrativeOwnerType;
  ownerId?: string;
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
  private runningActionsDepth = 0;
  private drainStepCount = 0;
  private destroyed = false;
  private recentTransitions: NarrativeTransitionRecord[] = [];
  private recentIssues: NarrativeRuntimeIssue[] = [];
  private validationMode: NarrativeRuntimeValidationMode = this.defaultRuntimeValidationMode();
  private static readonly MAX_DRAIN_STEPS = 128;

  constructor(eventBus: EventBus, flagStore: FlagStore, actionExecutor: ActionExecutor) {
    this.eventBus = eventBus;
    this.flagStore = flagStore;
    this.actionExecutor = actionExecutor;
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
  }

  setRuntimeValidationMode(mode: NarrativeRuntimeValidationMode): void {
    this.validationMode = mode;
  }

  async loadFromAsset(assetManager: AssetManager, path = '/assets/data/narrative_graphs.json'): Promise<void> {
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
    this.ownerIndex.clear();
    this.queue.length = 0;
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
        const message = `NarrativeStateManager: duplicate graph id "${graph.id}"`;
        this.recordIssue({ severity: 'error', code: 'graph.id.duplicate', message, graphId: graph.id });
        throw new Error(message);
      }
      this.graphs.set(graph.id, graph);
      this.activeStates.set(graph.id, graph.initialState);
      this.indexGraphOwner(graph);
      if (graph.projectFlags) {
        const message = `NarrativeStateManager: graph.projectFlags is deprecated and ignored on ${graph.id}`;
        this.recordIssue({ severity: 'warning', code: 'projectFlags.deprecated', message, graphId: graph.id });
        console.warn(message);
      }
    }
    this.recordDuplicateOwnerBindings();
    // Evaluate reactive transitions on initial states
    this.evaluateReactiveTriggers();
    if (this.queue.length > 0 && !this.draining) {
      void this.drainQueue();
    }
  }

  getActiveState(graphId: string): string | undefined {
    return this.activeStates.get(graphId);
  }

  isStateActive(graphId: string, stateId: string): boolean {
    return this.activeStates.get(graphId) === stateId;
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
    if (graphIds.length !== 1) return undefined;
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
    if (!clean) return Promise.resolve();
    if (clean.key === NarrativeStateManager.DEFAULT_DRAFT_SIGNAL) {
      console.warn('NarrativeStateManager: refusing to emit draft signal');
      return Promise.resolve();
    }
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
    console.warn(message);
    return this.enqueue({ kind: 'setState', graphId: gid, stateId: sid });
  }

  /** @deprecated Content must use signals/transitions. Use debugSetNarrativeState for tooling repair only. */
  setNarrativeState(graphId: string, stateId: string): Promise<void> {
    return this.debugSetNarrativeState(graphId, stateId);
  }

  serialize(): object {
    return { activeStates: Object.fromEntries(this.activeStates.entries()) };
  }

  deserialize(data: object): void {
    const raw = data as { activeStates?: Record<string, unknown> };
    this.restoreActiveStates(raw?.activeStates ?? {});
  }

  restoreActiveStates(states: Record<string, unknown>): void {
    for (const [graphId, stateRaw] of Object.entries(states ?? {})) {
      const graph = this.graphs.get(graphId);
      const stateId = String(stateRaw ?? '').trim();
      if (!graph || !stateId || !graph.states[stateId]) continue;
      this.activeStates.set(graphId, stateId);
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.graphs.clear();
    this.activeStates.clear();
    this.queue.length = 0;
  }

  debugSnapshot(): Record<string, unknown> {
    return {
      activeStates: Object.fromEntries(this.activeStates.entries()),
      graphs: [...this.graphs.keys()],
      owners: Object.fromEntries(this.ownerIndex.entries()),
      recentTransitions: this.recentTransitions.slice(-20),
      recentIssues: this.recentIssues.slice(-20),
      queued: this.queue.length,
    };
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
      const message = `NarrativeStateManager: duplicate wrapper owner binding ${key} -> ${graphIds.join(', ')}`;
      this.recordIssue({ severity: 'error', code: 'owner.wrapper.duplicate', message });
      console.warn(message);
    }
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
    if (!this.draining) {
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
    return this.drainPromise ?? queued;
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
    }
  }

  private async drainNestedQueue(): Promise<void> {
    try {
      await this.drainAvailableQueue();
    } catch {
      // The queued item's own promise carries the rejection to the awaiting action.
    }
  }

  private async drainAvailableQueue(): Promise<void> {
    try {
      while (this.queue.length > 0) {
        if (++this.drainStepCount > NarrativeStateManager.MAX_DRAIN_STEPS) {
          const error = new Error('NarrativeStateManager: drain loop guard tripped');
          console.warn(error.message);
          this.rejectQueuedItems(error);
          this.resolveCompletedQueueItems();
          break;
        }
        const item = this.queue.shift()!;
        await this.processQueueItem(item);
        if (this.queue.length === 0) {
          this.resolveCompletedQueueItems();
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
      if (trigger.kind === 'setState') {
        await this.applyStateCommand(trigger.graphId, trigger.stateId);
      } else if (trigger.kind === 'reactive') {
        await this.processReactiveTrigger(trigger.graphId, trigger.transitionId);
      } else {
        await this.processTrigger(NarrativeStateManager.normalizeTriggerKey(trigger.key));
      }
      this.completedQueueItems.push(item);
    } catch (e) {
      item.reject(e);
      throw e;
    }
  }

  private async processTrigger(triggerKey: NarrativeTriggerKey): Promise<void> {
    const migratedGraphs = new Set<string>();
    const graphEntries = [...this.graphs.entries()];
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
    }
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
      const candidates = graph.transitions
        .filter((t) => {
          if (!t.trigger || t.trigger === 'signal') return false;
          if (t.from !== active) return false;
          if (!this.isLocalEndpoint(t.from) || !this.isLocalEndpoint(t.to)) {
            this.recordUnsupportedEndpoint(graphId, t.id);
            return false;
          }
          return this.evaluateReactiveConditions(t);
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
      console.warn(message);
      return;
    }
    if (!this.canRemoteEnterState(graph, stateId)) {
      const message = `NarrativeStateManager: setState target violates scenario boundary ${graphId}.${stateId}`;
      this.recordIssue({ severity: 'error', code: 'scenario.boundary.stateCommand', message, graphId, stateId });
      console.warn(message);
      return;
    }
    const from = this.activeStates.get(graphId) ?? graph.initialState;
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
    this.activeStates.set(graph.id, toStateId);
    this.recentTransitions.push({ graphId: graph.id, transitionId, from: fromStateId, to: toStateId, triggerKey });
    if (this.recentTransitions.length > 50) this.recentTransitions.splice(0, this.recentTransitions.length - 50);
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
      this.runningActionsDepth += 1;
      await this.actionExecutor.executeBatchAwait(actions);
    } catch (e) {
      console.warn(`NarrativeStateManager: lifecycle actions failed at ${label}`, e);
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
