import {
  collectKnownSignals,
  collectListenerRefs,
  createAuthorSignal,
  deleteAuthorSignal,
  renameAuthorSignal,
} from './signalCatalog';
import {
  DEFAULT_DRAFT_SIGNAL,
  isDerivedStateSignal,
  isReservedAuthorSignalId,
  NARRATIVE_SCHEMA_VERSION,
  parseDerivedStateSignal,
  stateEnteredSignalKey,
} from './signalConstants';
import { migrateNarrativeSignalsV3 } from './signalMigration';
import {
  blockingNarrativeValidationErrors,
  narrativeEndpointLabel,
  resolveNarrativeEndpoint,
  validateNarrativeGraphData,
} from '@/core/narrativeGraphValidation';
import type {
  AuthoringCatalogDef,
  CompositionElementDef,
  ElementKind,
  NarrativeAuthorSignalDef,
  NarrativeCompositionDef,
  NarrativeEndpointDef,
  NarrativeGraphsFileDef,
  NarrativeGraphDef,
  NarrativeStateNodeDef,
  NarrativeTransitionDef,
  RuntimeSignalRequestDef,
  ValidationIssueDef,
} from './types';

export { collectKnownSignals, createAuthorSignal, deleteAuthorSignal, renameAuthorSignal };
export { buildSignalCatalog, collectListenerRefs } from './signalCatalog';
export { DEFAULT_DRAFT_SIGNAL, stateEnteredSignalKey } from './signalConstants';
export { migrateNarrativeSignalsV3 } from './signalMigration';
/** @deprecated Use stateEnteredSignalKey */
export const graphStateEnteredKey = stateEnteredSignalKey;

export type GraphRef = 'main' | `element:${string}`;

export interface CompiledGraphRef {
  graph: NarrativeGraphDef;
  compositionId: string;
  elementId?: string;
}

export interface SimulationTransitionRecord {
  graphId: string;
  transitionId: string;
  from: string;
  to: string;
  triggerKey: string;
}

export interface SimulationResult {
  activeStates: Record<string, string>;
  recentTransitions: SimulationTransitionRecord[];
  log: string[];
  queued: string[];
  loopGuardTripped: boolean;
}

export const defaultFile: NarrativeGraphsFileDef = { schemaVersion: NARRATIVE_SCHEMA_VERSION, signals: [], compositions: [] };

export const emptyCatalog: AuthoringCatalogDef = {
  dialogueGraphIds: [],
  scenarioIds: [],
  questIds: [],
  sceneEntityRefs: [],
  sceneNpcRefs: [],
  sceneHotspotRefs: [],
  zoneRefs: [],
  minigameIds: [],
  cutsceneIds: [],
  graphIds: [],
  actionTypes: [],
  actionParamSchemas: {},
  actionPersistence: {},
};

export function normalizeFile(data: NarrativeGraphsFileDef | unknown): NarrativeGraphsFileDef {
  let next = data && typeof data === 'object'
    ? structuredClone(data as NarrativeGraphsFileDef)
    : structuredClone(defaultFile);
  if ((next.schemaVersion ?? 0) < NARRATIVE_SCHEMA_VERSION) {
    next = migrateNarrativeSignalsV3(next);
  }
  next.schemaVersion = NARRATIVE_SCHEMA_VERSION;
  next.signals ??= [];
  next.compositions ??= [];
  normalizeAuthorSignals(next.signals);
  for (const comp of next.compositions) {
    comp.elements ??= [];
    comp.mainGraph.states ??= {};
    comp.mainGraph.transitions ??= [];
    normalizeGraph(comp.mainGraph);
    for (const el of comp.elements) {
      if ((el.kind === 'wrapperGraph' || el.kind === 'scenarioSubgraph') && el.graph) {
        normalizeGraph(el.graph);
        if (el.kind === 'scenarioSubgraph') normalizeScenarioGraph(el.graph);
      }
      el.meta ??= {};
      if (!Array.isArray(el.meta.emits)) el.meta.emits = [];
      if (!Array.isArray(el.meta.reads)) el.meta.reads = [];
      if (!Array.isArray(el.meta.commands)) el.meta.commands = [];
    }
  }
  applyDerivedBroadcastAutoMark(next);
  return next;
}

function applyDerivedBroadcastAutoMark(data: NarrativeGraphsFileDef): void {
  const graphById = new Map<string, NarrativeGraphDef>();
  for (const { graph } of compileGraphs(data)) {
    graphById.set(graph.id, graph);
  }
  for (const { graph } of compileGraphs(data)) {
    for (const transition of graph.transitions ?? []) {
      const parsed = parseDerivedStateSignal(String(transition.signal ?? '').trim());
      if (!parsed) continue;
      const sourceGraph = graphById.get(parsed.graphId);
      const state = sourceGraph?.states?.[parsed.stateId];
      if (state) state.broadcastOnEnter = true;
    }
  }
}

export function normalizeProjection<T extends { triggerEdges?: unknown; readEdges?: unknown; stateCommandEdges?: unknown; warnings?: unknown }>(
  raw: T,
) {
  return {
    schemaVersion: Number((raw as { schemaVersion?: unknown }).schemaVersion ?? 1),
    triggerEdges: Array.isArray(raw.triggerEdges) ? raw.triggerEdges : [],
    readEdges: Array.isArray(raw.readEdges) ? raw.readEdges : [],
    stateCommandEdges: Array.isArray(raw.stateCommandEdges) ? raw.stateCommandEdges : [],
    warnings: Array.isArray(raw.warnings) ? raw.warnings : [],
  };
}

function normalizeGraph(graph: NarrativeGraphDef): void {
  graph.states ??= {};
  graph.transitions ??= [];
  graph.exitStates = Array.isArray(graph.exitStates) ? graph.exitStates.map((x) => String(x ?? '').trim()).filter(Boolean) : graph.exitStates;
  for (const [id, state] of Object.entries(graph.states)) {
    state.id = String(state.id || id).trim() || id;
    state.meta ??= {};
  }
  for (const transition of graph.transitions) {
    if (typeof transition.from === 'string') transition.from = transition.from.trim();
    if (typeof transition.to === 'string') transition.to = transition.to.trim();
    const sig = String(transition.signal ?? '').trim();
    transition.signal = sig || DEFAULT_DRAFT_SIGNAL;
    // Normalize trigger: only keep valid reactive values, default to undefined (= 'signal')
    const trigger = transition.trigger;
    if (trigger !== 'reactive' && trigger !== 'reactiveAll' && trigger !== 'reactiveAny') {
      transition.trigger = undefined;
    }
  }
}

function normalizeAuthorSignals(signals: NarrativeAuthorSignalDef[]): void {
  const seen = new Set<string>();
  for (let i = signals.length - 1; i >= 0; i -= 1) {
    const row = signals[i]!;
    row.id = String(row.id ?? '').trim();
    if (!row.id || isReservedAuthorSignalId(row.id) || seen.has(row.id)) {
      signals.splice(i, 1);
      continue;
    }
    seen.add(row.id);
    if (row.label) row.label = String(row.label).trim();
    if (row.notes) row.notes = String(row.notes).trim();
  }
}

function normalizeScenarioGraph(graph: NarrativeGraphDef): void {
  graph.ownerType = 'scenario';
  graph.entryState = String(graph.entryState ?? '').trim() || graph.entryState;
  graph.exitStates = Array.isArray(graph.exitStates) ? graph.exitStates : [];
}

export function getComposition(data: NarrativeGraphsFileDef, compositionId: string): NarrativeCompositionDef | undefined {
  const comps = data.compositions ?? [];
  return comps.find((c) => c.id === compositionId) ?? comps[0];
}

export function graphLabel(comp: NarrativeCompositionDef | undefined, graphRef: GraphRef): string {
  if (!comp) return 'No Graph';
  if (graphRef === 'main') return graphDisplayName(comp.mainGraph);
  const el = getElementByGraphRef(comp, graphRef);
  return el?.graph ? graphDisplayName(el.graph) : el?.label || graphRef;
}

export function graphDisplayName(graph: NarrativeGraphDef | undefined): string {
  if (!graph) return '';
  return String(graph.label ?? '').trim() || graph.id;
}

export function graphReferenceLabel(graph: NarrativeGraphDef | undefined): string {
  if (!graph) return '';
  const name = graphDisplayName(graph);
  return name && name !== graph.id ? `${name} (${graph.id})` : graph.id;
}

export function stateDisplayName(state: NarrativeStateNodeDef | undefined, stateId: string): string {
  if (!state) return stateId;
  return String(state.label ?? '').trim() || stateId;
}

export function stateReferenceLabel(state: NarrativeStateNodeDef | undefined, stateId: string): string {
  const name = stateDisplayName(state, stateId);
  return name && name !== stateId ? `${name} (${stateId})` : stateId;
}

export function getEditableGraph(comp: NarrativeCompositionDef | undefined, graphRef: GraphRef): NarrativeGraphDef | undefined {
  if (!comp) return undefined;
  if (graphRef === 'main') return comp.mainGraph;
  return getElementByGraphRef(comp, graphRef)?.graph;
}

export function getElementByGraphRef(comp: NarrativeCompositionDef | undefined, graphRef: GraphRef): CompositionElementDef | undefined {
  if (!comp || graphRef === 'main') return undefined;
  const id = graphRef.slice('element:'.length);
  return comp.elements?.find((el) => el.id === id);
}

export function getElementByNodeId(comp: NarrativeCompositionDef | undefined, nodeId: string): CompositionElementDef | undefined {
  if (!comp || !nodeId.startsWith('element:')) return undefined;
  return comp.elements?.find((el) => `element:${el.id}` === nodeId);
}

export function isSubgraphElement(el: CompositionElementDef | undefined): boolean {
  return Boolean(el?.graph && (el.kind === 'wrapperGraph' || el.kind === 'scenarioSubgraph'));
}

export function stateEditorPosition(state: NarrativeStateNodeDef, index: number): { x: number; y: number } {
  const editor = (state.meta?.editor ?? {}) as { x?: number; y?: number };
  return { x: Number(editor.x ?? 120 + index * 260), y: Number(editor.y ?? 180) };
}

export function setStateEditorPosition(state: NarrativeStateNodeDef, x: number, y: number): void {
  state.meta ??= {};
  state.meta.editor = {
    ...((state.meta.editor as Record<string, unknown>) ?? {}),
    x: Math.round(x),
    y: Math.round(y),
  };
}

export function createState(graph: NarrativeGraphDef): string {
  const id = uniqueId('state', Object.keys(graph.states ?? {}));
  graph.states[id] = {
    id,
    label: id,
    meta: { editor: { x: 120, y: 260 } },
  };
  if (!graph.initialState) graph.initialState = id;
  return id;
}

export function createTransition(graph: NarrativeGraphDef, from: string, to: string, trigger?: 'signal' | 'reactive' | 'reactiveAll' | 'reactiveAny'): NarrativeTransitionDef {
  const id = uniqueId('t', graph.transitions.map((t) => t.id));
  const transition: NarrativeTransitionDef = { id, from, to, signal: DEFAULT_DRAFT_SIGNAL, priority: 0 };
  if (trigger && trigger !== 'signal') transition.trigger = trigger;
  graph.transitions.push(transition);
  return transition;
}

export function createComposition(data: NarrativeGraphsFileDef): NarrativeCompositionDef {
  const comps = data.compositions ??= [];
  const id = uniqueId('composition', comps.map((c) => c.id));
  const graphId = uniqueGraphId(data, 'flow');
  const comp: NarrativeCompositionDef = {
    id,
    label: id,
    mainGraph: {
      id: graphId,
      label: id,
      ownerType: 'flow',
      initialState: 'initial',
      states: { initial: { id: 'initial', label: 'initial', meta: { editor: { x: 120, y: 160 } } } },
      transitions: [],
    },
    elements: [],
  };
  comps.push(comp);
  return comp;
}

export function createElement(comp: NarrativeCompositionDef, kind: ElementKind, data?: NarrativeGraphsFileDef): CompositionElementDef {
  const elements = comp.elements ??= [];
  const base = kind === 'wrapperGraph' ? 'wrapper' : kind.replace('Blackbox', '').replace('Subgraph', '');
  const id = uniqueId(base, elements.map((e) => e.id));
  const element: CompositionElementDef = {
    id,
    kind,
    label: defaultElementLabel(kind),
    refId: '',
    x: 440,
    y: 60,
    meta: { emits: [], reads: [] },
  };
  if (kind === 'wrapperGraph' || kind === 'scenarioSubgraph') {
    const ownerType = kind === 'scenarioSubgraph' ? 'scenario' : 'npc';
    const graphPrefix = kind === 'scenarioSubgraph' ? 'scenario_graph' : 'wrapper_graph';
    element.ownerType = ownerType;
    element.ownerId = '';
    if (kind === 'scenarioSubgraph') element.refId = '';
    element.x = kind === 'wrapperGraph' ? 320 : 440;
    element.y = kind === 'wrapperGraph' ? 380 : 60;
    element.graph = kind === 'scenarioSubgraph'
      ? {
          id: data ? uniqueGraphId(data, graphPrefix) : uniqueId(graphPrefix, [comp.mainGraph.id, ...elements.map((e) => e.graph?.id ?? '')]),
          label: element.label,
          ownerType,
          initialState: 'inactive',
          entryState: 'entry',
          exitStates: ['exit'],
          states: {
            inactive: { id: 'inactive', label: 'inactive', meta: { editor: { x: 60, y: 160 } } },
            entry: { id: 'entry', label: 'entry', meta: { editor: { x: 280, y: 120 } } },
            exit: { id: 'exit', label: 'exit', meta: { editor: { x: 520, y: 120 } } },
          },
          transitions: [],
        }
      : {
          id: data ? uniqueGraphId(data, graphPrefix) : uniqueId(graphPrefix, [comp.mainGraph.id, ...elements.map((e) => e.graph?.id ?? '')]),
          label: element.label,
          ownerType,
          category: '',
          initialState: 'initial',
          states: { initial: { id: 'initial', label: 'initial', meta: { editor: { x: 120, y: 160 } } } },
          transitions: [],
        };
  }
  elements.push(element);
  return element;
}

function defaultElementLabel(kind: ElementKind): string {
  if (kind === 'wrapperGraph') return 'Wrapper Graph';
  if (kind === 'scenarioSubgraph') return 'Scenario Subgraph';
  if (kind === 'dialogueBlackbox') return 'Dialogue Blackbox';
  if (kind === 'zoneBlackbox') return 'Zone Blackbox';
  if (kind === 'minigameBlackbox') return 'Minigame Blackbox';
  return 'Cutscene Blackbox';
}

export function renameStateInGraph(data: NarrativeGraphsFileDef, graph: NarrativeGraphDef, oldId: string, newIdRaw: string): string {
  const newId = cleanId(newIdRaw || oldId);
  if (!newId || newId === oldId || !graph.states[oldId]) return oldId;
  if (graph.states[newId]) throw new Error(`State id already exists: ${newId}`);
  const state = graph.states[oldId];
  delete graph.states[oldId];
  state.id = newId;
  graph.states[newId] = state;
  if (graph.initialState === oldId) graph.initialState = newId;
  if (graph.entryState === oldId) graph.entryState = newId;
  graph.exitStates = graph.exitStates?.map((sid) => sid === oldId ? newId : sid);
  updateTransitionEndpointRefs(data, graph.id, oldId, newId);
  updateGraphStateSignalRefs(data, graph.id, oldId, newId);
  updateGraphStateConditionRefs(data, graph.id, oldId, newId);
  updateGraphStateCommandRefs(data, graph.id, oldId, newId);
  return newId;
}

export function renameGraph(data: NarrativeGraphsFileDef, graph: NarrativeGraphDef, newIdRaw: string): string {
  const oldId = graph.id;
  const newId = cleanId(newIdRaw || oldId);
  if (!newId || newId === oldId) return oldId;
  if (compileGraphs(data).some(({ graph: g }) => g !== graph && g.id === newId)) {
    throw new Error(`Graph id already exists: ${newId}`);
  }
  graph.id = newId;
  updateGraphIdRefs(data, oldId, newId);
  return newId;
}

export function renameElement(comp: NarrativeCompositionDef, oldId: string, newIdRaw: string): string {
  const newId = cleanId(newIdRaw || oldId);
  if (!newId || newId === oldId) return oldId;
  const elements = comp.elements ?? [];
  if (elements.some((el) => el.id === newId)) throw new Error(`Element id already exists: ${newId}`);
  const el = elements.find((item) => item.id === oldId);
  if (!el) return oldId;
  el.id = newId;
  return newId;
}

export function renameTransition(graph: NarrativeGraphDef, oldId: string, newIdRaw: string): string {
  const newId = cleanId(newIdRaw || oldId);
  if (!newId || newId === oldId) return oldId;
  if (graph.transitions.some((t) => t.id === newId)) throw new Error(`Transition id already exists: ${newId}`);
  const t = graph.transitions.find((item) => item.id === oldId);
  if (!t) return oldId;
  t.id = newId;
  return newId;
}

function updateGraphStateSignalRefs(data: NarrativeGraphsFileDef, graphId: string, oldState: string, newState: string): void {
  const replacements = new Map([
    [stateEnteredSignalKey(graphId, oldState), stateEnteredSignalKey(graphId, newState)],
    [`stateEntered:${graphId}:${oldState}`, stateEnteredSignalKey(graphId, newState)],
  ]);
  for (const { graph } of compileGraphs(data)) {
    for (const transition of graph.transitions ?? []) {
      const next = replacements.get(transition.signal);
      if (next) transition.signal = next;
    }
  }
}

function updateGraphStateConditionRefs(data: NarrativeGraphsFileDef, graphId: string, oldState: string, newState: string): void {
  for (const { graph } of compileGraphs(data)) {
    for (const transition of graph.transitions ?? []) {
      visitUnknown(transition.conditions, (obj) => replaceNarrativeConditionState(obj, graphId, oldState, newState));
    }
    for (const state of Object.values(graph.states ?? {})) {
      for (const actions of [state.onEnterActions, state.onExitActions]) {
        visitUnknown(actions, (obj) => replaceNarrativeConditionState(obj, graphId, oldState, newState));
      }
    }
  }
}

function updateGraphStateCommandRefs(data: NarrativeGraphsFileDef, graphId: string, oldState: string, newState: string): void {
  for (const comp of data.compositions ?? []) {
    for (const el of comp.elements ?? []) {
      if (Array.isArray(el.meta?.commands)) {
        el.meta.commands = el.meta.commands.map((ref) => replaceStateCommandRef(String(ref), graphId, oldState, newState));
      }
    }
  }
  for (const { graph } of compileGraphs(data)) {
    for (const state of Object.values(graph.states ?? {})) {
      for (const actions of [state.onEnterActions, state.onExitActions]) {
        visitUnknown(actions, (obj) => {
          if (obj.type !== 'setNarrativeState' || !obj.params || typeof obj.params !== 'object' || Array.isArray(obj.params)) return;
          const params = obj.params as Record<string, unknown>;
          if (params.graphId === graphId && params.stateId === oldState) params.stateId = newState;
        });
      }
    }
  }
}

function replaceStateCommandRef(ref: string, graphId: string, oldState: string, newState: string): string {
  const value = String(ref ?? '').trim();
  const dot = /^([^.]+)\.(.+)$/.exec(value);
  if (dot && dot[1] === graphId && dot[2] === oldState) return `${graphId}.${newState}`;
  const colon = /^([^:]+):(.+)$/.exec(value);
  if (colon && colon[1] === graphId && colon[2] === oldState) return `${graphId}:${newState}`;
  return ref;
}

function updateGraphIdRefs(data: NarrativeGraphsFileDef, oldGraphId: string, newGraphId: string): void {
  for (const comp of data.compositions ?? []) {
    for (const el of comp.elements ?? []) {
      if (Array.isArray(el.meta?.reads)) {
        el.meta.reads = el.meta.reads.map((id) => id === oldGraphId ? newGraphId : id);
      }
    }
  }
  for (const { graph } of compileGraphs(data)) {
    if (graph.entryState) {
      // no-op; keeps graph traversal in one place for future graph-local refs.
    }
    for (const transition of graph.transitions ?? []) {
      transition.signal = replaceGraphStateSignalGraph(transition.signal, oldGraphId, newGraphId);
      visitUnknown(transition.conditions, (obj) => replaceNarrativeConditionGraph(obj, oldGraphId, newGraphId));
    }
    for (const state of Object.values(graph.states ?? {})) {
      for (const actions of [state.onEnterActions, state.onExitActions]) {
        visitUnknown(actions, (obj) => {
          if (obj.type === 'setNarrativeState' && obj.params && typeof obj.params === 'object' && !Array.isArray(obj.params)) {
            const params = obj.params as Record<string, unknown>;
            if (params.graphId === oldGraphId) params.graphId = newGraphId;
          }
          replaceNarrativeConditionGraph(obj, oldGraphId, newGraphId);
        });
      }
    }
  }
}

function replaceGraphStateSignalGraph(signal: string, oldGraphId: string, newGraphId: string): string {
  const prefix = `state:${oldGraphId}:`;
  if (signal.startsWith(prefix)) {
    return `state:${newGraphId}:${signal.slice(prefix.length)}`;
  }
  return signal;
}

function replaceNarrativeConditionGraph(obj: Record<string, unknown>, oldGraphId: string, newGraphId: string): void {
  if (obj.narrative === oldGraphId) obj.narrative = newGraphId;
}

function replaceNarrativeConditionState(
  obj: Record<string, unknown>,
  graphId: string,
  oldState: string,
  newState: string,
): void {
  if (obj.narrative === graphId && obj.state === oldState) obj.state = newState;
}

function updateTransitionEndpointRefs(data: NarrativeGraphsFileDef, graphId: string, oldState: string, newState: string): void {
  for (const { graph } of compileGraphs(data)) {
    for (const transition of graph.transitions ?? []) {
      transition.from = replaceEndpointState(transition.from, graph.id, graphId, oldState, newState);
      transition.to = replaceEndpointState(transition.to, graph.id, graphId, oldState, newState);
    }
  }
}

export function compileGraphs(data: NarrativeGraphsFileDef): CompiledGraphRef[] {
  const out: CompiledGraphRef[] = [];
  for (const comp of data.compositions ?? []) {
    if (isGraph(comp.mainGraph)) out.push({ graph: comp.mainGraph, compositionId: comp.id });
    for (const el of comp.elements ?? []) {
      if ((el.kind === 'wrapperGraph' || el.kind === 'scenarioSubgraph') && isGraph(el.graph)) {
        out.push({ graph: el.graph, compositionId: comp.id, elementId: el.id });
      }
    }
  }
  return out;
}

function isGraph(value: unknown): value is NarrativeGraphDef {
  const graph = value as NarrativeGraphDef;
  return Boolean(graph && typeof graph.id === 'string' && graph.states && typeof graph.states === 'object');
}

/** Runtime / debug: semantic event id is the trigger key. */
export function signalRequestToKey(signal: RuntimeSignalRequestDef): string {
  return String(signal.signal ?? '').trim();
}

export function parseExternalSignalKey(key: string): RuntimeSignalRequestDef {
  return { sourceType: 'system', sourceId: 'editor', signal: String(key ?? '').trim() };
}

function triggerKeysEqual(a: string, b: string): boolean {
  return String(a ?? '').trim() === String(b ?? '').trim();
}

function parseLegacyExternalSignalKey(key: string): null | { sourceType: string; sourceId: string; signal: string } {
  const parts = key.split(':');
  if (parts.length < 4 || parts[0] !== 'external') return null;
  try {
    return {
      sourceType: decodeURIComponent(parts[1] ?? ''),
      sourceId: decodeURIComponent(parts[2] ?? ''),
      signal: decodeURIComponent(parts.slice(3).join(':')),
    };
  } catch {
    return null;
  }
}

export function simulateSignalImpact(
  dataRaw: NarrativeGraphsFileDef,
  triggerKey: string,
  initialActiveStates?: Record<string, string>,
): SimulationResult {
  const maxSteps = 128;
  const data = normalizeFile(dataRaw);
  const graphs = compileGraphs(data).map((g) => g.graph);
  const graphMap = new Map(graphs.map((graph) => [graph.id, graph]));
  const activeStates = Object.fromEntries(graphs.map((graph) => {
    const active = initialActiveStates?.[graph.id];
    return [graph.id, active && graph.states?.[active] ? active : graph.initialState];
  }));
  const queue = [triggerKey].filter(Boolean);
  const recentTransitions: SimulationTransitionRecord[] = [];
  const log: string[] = [];
  let loopGuardTripped = false;

  for (let steps = 0; queue.length > 0; steps += 1) {
    if (steps >= maxSteps) {
      loopGuardTripped = true;
      log.push(`loop guard tripped at ${maxSteps} queued triggers`);
      queue.length = 0;
      break;
    }
    const key = queue.shift()!;
    let migrated = 0;
    for (const graph of graphs) {
      const active = activeStates[graph.id] ?? graph.initialState;
      const selected = (graph.transitions ?? [])
        .map((transition, index) => ({ transition, index }))
        .filter(({ transition }) => {
          if (typeof transition.from !== 'string' || typeof transition.to !== 'string') return false;
          return transition.from === active &&
            triggerKeysEqual(transition.signal, key) &&
            conditionsMet(transition.conditions, activeStates);
        })
        .sort((a, b) => {
          const pa = a.transition.priority ?? 0;
          const pb = b.transition.priority ?? 0;
          if (pa !== pb) return pb - pa;
          return a.index - b.index;
        })[0]?.transition;
      if (!selected) continue;
      const from = selected.from;
      const to = selected.to;
      if (!graphMap.get(graph.id)?.states[to]) continue;
      const previousState = activeStates[graph.id] ?? graph.initialState;
      activeStates[graph.id] = to;
      recentTransitions.push({
        graphId: graph.id,
        transitionId: selected.id,
        from,
        to,
        triggerKey: key,
      });
      log.push(`${graph.id}: ${previousState} -> ${to} via ${graph.id}.${selected.id}`);
      if (graphMap.get(graph.id)?.states[to]?.broadcastOnEnter === true) {
        queue.push(stateEnteredSignalKey(graph.id, to));
      }
      migrated += 1;
    }
    if (migrated === 0) log.push(`no transition matched ${key}`);

    // Evaluate reactive transitions after each signal step
    let reactiveFired = true;
    let reactiveSteps = 0;
    while (reactiveFired) {
      if (reactiveSteps >= maxSteps) {
        loopGuardTripped = true;
        log.push(`loop guard tripped at ${maxSteps} reactive transitions`);
        queue.length = 0;
        break;
      }
      reactiveSteps += 1;
      reactiveFired = false;
      for (const graph of graphs) {
        const active = activeStates[graph.id] ?? graph.initialState;
        const candidates = (graph.transitions ?? [])
          .filter((t) => {
            if (!t.trigger || t.trigger === 'signal') return false;
            if (typeof t.from !== 'string' || typeof t.to !== 'string') return false;
            return t.from === active && simulateReactiveConditionsMet(t, activeStates);
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
        const from = selected.from as string;
        const to = selected.to as string;
        if (!graphMap.get(graph.id)?.states[to]) continue;
        const previousState = activeStates[graph.id] ?? graph.initialState;
        activeStates[graph.id] = to;
        recentTransitions.push({
          graphId: graph.id,
          transitionId: selected.id,
          from,
          to,
          triggerKey: '__reactive__',
        });
        log.push(`${graph.id}: ${previousState} -> ${to} via ${graph.id}.${selected.id} [reactive:${selected.trigger}]`);
        if (graphMap.get(graph.id)?.states[to]?.broadcastOnEnter === true) {
          queue.push(stateEnteredSignalKey(graph.id, to));
        }
        reactiveFired = true;
        migrated += 1;
      }
    }
  }
  return { activeStates, recentTransitions, log, queued: queue, loopGuardTripped };
}

function simulateReactiveConditionsMet(t: NarrativeTransitionDef, activeStates: Record<string, string>): boolean {
  if (!t.conditions?.length) return false;
  if (t.trigger === 'reactive') {
    return conditionsMet(t.conditions, activeStates);
  }
  if (t.trigger === 'reactiveAll') {
    return conditionsMet([{ all: t.conditions }], activeStates);
  }
  if (t.trigger === 'reactiveAny') {
    return conditionsMet([{ any: t.conditions }], activeStates);
  }
  return false;
}

function conditionsMet(conditions: unknown[] | undefined, activeStates: Record<string, string>): boolean {
  if (!conditions?.length) return true;
  return conditions.every((expr) => evalCondition(expr, activeStates));
}

function evalCondition(expr: unknown, activeStates: Record<string, string>): boolean {
  if (!expr || typeof expr !== 'object' || Array.isArray(expr)) return false;
  const x = expr as Record<string, unknown>;
  if (Array.isArray(x.all)) return x.all.every((e) => evalCondition(e, activeStates));
  if (Array.isArray(x.any)) return x.any.some((e) => evalCondition(e, activeStates));
  if (x.not && typeof x.not === 'object') return !evalCondition(x.not, activeStates);
  if (typeof x.narrative === 'string' && typeof x.state === 'string') {
    return activeStates[x.narrative] === x.state;
  }
  return false;
}

export function validateNarrativeData(dataRaw: NarrativeGraphsFileDef | unknown): ValidationIssueDef[] {
  return validateNarrativeGraphData(normalizeFile(dataRaw)) as ValidationIssueDef[];
}

export function blockingValidationErrors(issues: ValidationIssueDef[]): ValidationIssueDef[] {
  return blockingNarrativeValidationErrors(issues) as ValidationIssueDef[];
}

export function resolveEndpoint(endpoint: unknown, ownerGraphId: string): { graphId: string; stateId: string } {
  return resolveNarrativeEndpoint(endpoint, ownerGraphId);
}

export function endpointLabel(endpoint: unknown, ownerGraphId: string): string {
  return narrativeEndpointLabel(endpoint, ownerGraphId);
}

function replaceEndpointState(
  endpoint: NarrativeEndpointDef,
  ownerGraphId: string,
  targetGraphId: string,
  oldState: string,
  newState: string,
): NarrativeEndpointDef {
  if (typeof endpoint !== 'string') return endpoint;
  const resolved = resolveEndpoint(endpoint, ownerGraphId);
  if (resolved.graphId !== targetGraphId || resolved.stateId !== oldState) return endpoint;
  return newState;
}

function visitUnknown(value: unknown, fn: (obj: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    value.forEach((item) => visitUnknown(item, fn));
    return;
  }
  if (!value || typeof value !== 'object') return;
  const obj = value as Record<string, unknown>;
  fn(obj);
  Object.values(obj).forEach((item) => visitUnknown(item, fn));
}

export function uniqueId(prefix: string, existing: string[]): string {
  const clean = prefix.replace(/[^a-zA-Z0-9_]/g, '_') || 'id';
  let i = 1;
  let id = `${clean}_${i}`;
  const taken = new Set(existing);
  while (taken.has(id)) {
    i += 1;
    id = `${clean}_${i}`;
  }
  return id;
}

export function uniqueGraphId(data: NarrativeGraphsFileDef, prefix: string): string {
  return uniqueId(prefix, compileGraphs(data).map(({ graph }) => graph.id));
}

function cleanId(value: string): string {
  return value.trim().replace(/\s+/g, '_');
}

export function mergeValidationIssues(local: ValidationIssueDef[], remote: ValidationIssueDef[]): ValidationIssueDef[] {
  const seen = new Set<string>();
  const out: ValidationIssueDef[] = [];
  for (const issue of [...local, ...remote]) {
    const key = `${issue.severity}|${issue.code}|${issue.path ?? ''}|${issue.itemId ?? ''}|${stableValidationTargetKey(issue.target)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  return out;
}

function stableValidationTargetKey(target: ValidationIssueDef['target']): string {
  if (!target) return '';
  return Object.keys(target)
    .sort()
    .map((key) => `${key}:${String(target[key as keyof typeof target] ?? '')}`)
    .join('|');
}
