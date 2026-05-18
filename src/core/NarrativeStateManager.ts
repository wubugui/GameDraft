import type { ActionExecutor } from './ActionExecutor';
import type { AssetManager } from './AssetManager';
import type { EventBus } from './EventBus';
import type { FlagStore } from './FlagStore';
import type { ActionDef, ConditionExpr, GameContext, IGameSystem } from '../data/types';
import type { ConditionEvalContext } from '../systems/graphDialogue/evaluateGraphCondition';
import { evaluateConditionExprList } from '../systems/graphDialogue/conditionEvalBridge';

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
  sourceType:
    | 'dialogue'
    | 'zone'
    | 'minigame'
    | 'cutscene'
    | 'quest'
    | 'action'
    | 'entity'
    | 'state'
    | 'system';
  sourceId: string;
  signal: string;
}

export interface NarrativeStateNode {
  id: string;
  label?: string;
  description?: string;
  onEnterActions?: ActionDef[];
  onExitActions?: ActionDef[];
  meta?: Record<string, unknown>;
}

export interface NarrativeEndpointObject {
  graphId: string;
  stateId: string;
}

export type NarrativeEndpoint = string | NarrativeEndpointObject;

export interface NarrativeTransition {
  id: string;
  from: NarrativeEndpoint;
  to: NarrativeEndpoint;
  signal: NarrativeTriggerKey;
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
  | { kind: 'stateEntered'; graphId: string; stateId: string; key: NarrativeTriggerKey }
  | { kind: 'stateExited'; graphId: string; stateId: string; key: NarrativeTriggerKey }
  | { kind: 'setState'; graphId: string; stateId: string };

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
  private static readonly MAX_DRAIN_STEPS = 128;

  constructor(eventBus: EventBus, flagStore: FlagStore, actionExecutor: ActionExecutor) {
    this.eventBus = eventBus;
    this.flagStore = flagStore;
    this.actionExecutor = actionExecutor;
  }

  static externalKey(signal: NarrativeSignal): NarrativeTriggerKey {
    return `external:${this.encodeKeyPart(signal.sourceType)}:${this.encodeKeyPart(signal.sourceId)}:${this.encodeKeyPart(signal.signal)}`;
  }

  static stateEnteredKey(graphId: string, stateId: string): NarrativeTriggerKey {
    return `stateEntered:${this.encodeKeyPart(graphId)}:${this.encodeKeyPart(stateId)}`;
  }

  static stateExitedKey(graphId: string, stateId: string): NarrativeTriggerKey {
    return `stateExited:${this.encodeKeyPart(graphId)}:${this.encodeKeyPart(stateId)}`;
  }

  static normalizeTriggerKey(key: NarrativeTriggerKey): NarrativeTriggerKey {
    const raw = String(key ?? '').trim();
    const external = this.parseExternalKey(raw);
    if (external) return this.externalKey(external);
    const lifecycle = this.parseLifecycleKey(raw);
    if (lifecycle) {
      return lifecycle.kind === 'stateEntered'
        ? this.stateEnteredKey(lifecycle.graphId, lifecycle.stateId)
        : this.stateExitedKey(lifecycle.graphId, lifecycle.stateId);
    }
    return raw;
  }

  private static encodeKeyPart(raw: unknown): string {
    return encodeURIComponent(String(raw ?? '').trim());
  }

  private static decodeKeyPart(raw: string): string {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }

  private static parseExternalKey(key: string): NarrativeSignal | null {
    const parts = key.split(':');
    if (parts.length < 4 || parts[0] !== 'external') return null;
    return {
      sourceType: this.decodeKeyPart(parts[1] ?? '') as NarrativeSignal['sourceType'],
      sourceId: this.decodeKeyPart(parts[2] ?? ''),
      signal: this.decodeKeyPart(parts.slice(3).join(':')),
    };
  }

  private static parseLifecycleKey(key: string): { kind: 'stateEntered' | 'stateExited'; graphId: string; stateId: string } | null {
    const parts = key.split(':');
    const kind = parts[0];
    if ((kind !== 'stateEntered' && kind !== 'stateExited') || parts.length < 3) return null;
    return {
      kind,
      graphId: this.decodeKeyPart(parts[1] ?? ''),
      stateId: this.decodeKeyPart(parts.slice(2).join(':')),
    };
  }

  static triggerKeysEqual(a: NarrativeTriggerKey, b: NarrativeTriggerKey): boolean {
    return this.normalizeTriggerKey(a) === this.normalizeTriggerKey(b);
  }

  init(_ctx: GameContext): void {}
  update(_dt: number): void {}

  setConditionEvalContextFactory(factory: (() => ConditionEvalContext) | null): void {
    this.conditionCtxFactory = factory;
  }

  async loadFromAsset(assetManager: AssetManager, path = '/assets/data/narrative_graphs.json'): Promise<void> {
    try {
      const data = await assetManager.loadJson<NarrativeGraphsFile>(path);
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
      this.projectActiveFlags(graph.id, graph.initialState);
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

  emitNarrativeSignal(signal: NarrativeSignal): Promise<void> {
    const clean = this.normalizeSignal(signal);
    if (!clean) return Promise.resolve();
    return this.enqueue({ kind: 'external', key: NarrativeStateManager.externalKey(clean), source: clean });
  }

  enqueueTriggerKey(key: NarrativeTriggerKey): Promise<void> {
    const k = String(key ?? '').trim();
    if (!k) return Promise.resolve();
    return this.enqueue({ kind: 'external', key: k });
  }

  setNarrativeState(graphId: string, stateId: string): Promise<void> {
    const gid = String(graphId ?? '').trim();
    const sid = String(stateId ?? '').trim();
    if (!gid || !sid) return Promise.resolve();
    return this.enqueue({ kind: 'setState', graphId: gid, stateId: sid });
  }

  serialize(): object {
    return { activeStates: Object.fromEntries(this.activeStates.entries()) };
  }

  deserialize(data: object): void {
    const raw = data as { activeStates?: Record<string, unknown> };
    const states = raw?.activeStates ?? {};
    for (const [graphId, stateRaw] of Object.entries(states)) {
      const graph = this.graphs.get(graphId);
      const stateId = String(stateRaw ?? '').trim();
      if (!graph || !stateId || !graph.states[stateId]) continue;
      this.activeStates.set(graphId, stateId);
      this.projectActiveFlags(graphId, stateId);
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

  private normalizeSignal(signal: NarrativeSignal): NarrativeSignal | null {
    const sourceType = String(signal?.sourceType ?? '').trim() as NarrativeSignal['sourceType'];
    const sourceId = String(signal?.sourceId ?? '').trim();
    const sig = String(signal?.signal ?? '').trim();
    if (!sourceType || !sourceId || !sig) {
      console.warn('NarrativeStateManager: invalid signal', signal);
      return null;
    }
    return { sourceType, sourceId, signal: sig };
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
          const from = this.resolveEndpoint(t.from, graph.id);
          return from.graphId === graphId &&
            from.stateId === active &&
            NarrativeStateManager.triggerKeysEqual(t.signal, triggerKey) &&
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
    const from = this.resolveEndpoint(transition.from, graph.id);
    const to = this.resolveEndpoint(transition.to, graph.id);
    if (from.graphId !== graph.id) {
      const message = `NarrativeStateManager: transition ${graph.id}.${transition.id} is stored on ${graph.id} but starts from ${from.graphId}`;
      this.recordIssue({ severity: 'error', code: 'transition.owner.mismatch', message, graphId: graph.id, transitionId: transition.id });
      console.warn(message);
      return;
    }
    const targetGraph = this.graphs.get(to.graphId);
    if (!targetGraph?.states[to.stateId]) {
      const message = `NarrativeStateManager: transition target missing ${to.graphId}.${to.stateId}`;
      this.recordIssue({ severity: 'warning', code: 'transition.target.missing', message, graphId: to.graphId, stateId: to.stateId, transitionId: transition.id });
      console.warn(message);
      return;
    }
    if (to.graphId === from.graphId) {
      await this.enterState(graph, from.stateId, to.stateId, triggerKey, transition.id);
      return;
    }
    if (!this.canLeaveGraphRemotely(graph, from.stateId)) {
      const message = `NarrativeStateManager: cross-graph transition violates scenario exit boundary ${graph.id}.${transition.id}`;
      this.recordIssue({ severity: 'error', code: 'scenario.boundary.exit', message, graphId: graph.id, stateId: from.stateId, transitionId: transition.id });
      console.warn(message);
      return;
    }
    if (!this.canRemoteEnterState(targetGraph, to.stateId)) {
      const message = `NarrativeStateManager: cross-graph transition violates scenario entry boundary ${targetGraph.id}.${to.stateId}`;
      this.recordIssue({ severity: 'error', code: 'scenario.boundary.entry', message, graphId: targetGraph.id, stateId: to.stateId, transitionId: transition.id });
      console.warn(message);
      return;
    }
    const previousTargetState = this.activeStates.get(targetGraph.id) ?? targetGraph.initialState;
    await this.enterState(targetGraph, previousTargetState, to.stateId, triggerKey, transition.id);
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
    this.enqueueLifecycle('stateExited', graph.id, fromStateId);
    await this.runActions(fromState?.onExitActions, `${graph.id}.${fromStateId}.onExit`);
    this.activeStates.set(graph.id, toStateId);
    this.projectActiveFlags(graph.id, toStateId);
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
    this.enqueueLifecycle('stateEntered', graph.id, toStateId);
  }

  private enqueueLifecycle(kind: 'stateEntered' | 'stateExited', graphId: string, stateId: string): void {
    const key =
      kind === 'stateEntered'
        ? NarrativeStateManager.stateEnteredKey(graphId, stateId)
        : NarrativeStateManager.stateExitedKey(graphId, stateId);
    this.queue.push({ trigger: { kind, graphId, stateId, key }, resolve: () => {}, reject: () => {} });
  }

  private resolveEndpoint(endpoint: NarrativeEndpoint, ownerGraphId: string): { graphId: string; stateId: string } {
    if (typeof endpoint === 'string') {
      return { graphId: ownerGraphId, stateId: endpoint };
    }
    return {
      graphId: String(endpoint?.graphId ?? '').trim(),
      stateId: String(endpoint?.stateId ?? '').trim(),
    };
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

  private projectActiveFlags(graphId: string, activeState: string): void {
    const graph = this.graphs.get(graphId);
    if (!graph?.projectFlags) return;
    for (const stateId of Object.keys(graph.states)) {
      this.flagStore.set(`narrative.${graphId}.${stateId}.active`, stateId === activeState);
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
