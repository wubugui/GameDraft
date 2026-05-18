import type {
  ActionDef,
  AuthoringCatalogDef,
  CompositionElementDef,
  ElementKind,
  NarrativeCompositionDef,
  NarrativeEndpointDef,
  NarrativeGraphsFileDef,
  NarrativeGraphDef,
  NarrativeStateNodeDef,
  NarrativeTransitionDef,
  RuntimeSignalRequestDef,
  ValidationIssueDef,
} from './types';

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

export const defaultFile: NarrativeGraphsFileDef = { schemaVersion: 2, compositions: [] };

export const emptyCatalog: AuthoringCatalogDef = {
  dialogueGraphIds: [],
  scenarioIds: [],
  questIds: [],
  sceneEntityRefs: [],
  zoneRefs: [],
  minigameIds: [],
  cutsceneIds: [],
  graphIds: [],
  actionTypes: [],
  actionParamSchemas: {},
  actionPersistence: {},
};

export function normalizeFile(data: NarrativeGraphsFileDef | unknown): NarrativeGraphsFileDef {
  const next = data && typeof data === 'object'
    ? structuredClone(data as NarrativeGraphsFileDef)
    : structuredClone(defaultFile);
  next.schemaVersion = 2;
  next.compositions ??= [];
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
  return next;
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
    transition.from = normalizeEndpoint(transition.from);
    transition.to = normalizeEndpoint(transition.to);
    transition.signal = String(transition.signal ?? '').trim();
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
  if (graphRef === 'main') return comp.mainGraph.id;
  const el = getElementByGraphRef(comp, graphRef);
  return el?.graph?.id || el?.label || graphRef;
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

export function createTransition(graph: NarrativeGraphDef, from: NarrativeEndpointDef, to: NarrativeEndpointDef): NarrativeTransitionDef {
  const id = uniqueId('t', graph.transitions.map((t) => t.id));
  const transition = { id, from, to, signal: '', priority: 0 };
  graph.transitions.push(transition);
  return transition;
}

export function createComposition(data: NarrativeGraphsFileDef): NarrativeCompositionDef {
  const comps = data.compositions ??= [];
  const id = uniqueId('composition', comps.map((c) => c.id));
  const graphId = uniqueId('flow', comps.map((c) => c.mainGraph.id));
  const comp: NarrativeCompositionDef = {
    id,
    label: id,
    mainGraph: {
      id: graphId,
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

export function createElement(comp: NarrativeCompositionDef, kind: ElementKind): CompositionElementDef {
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
          id: uniqueId(graphPrefix, [comp.mainGraph.id, ...elements.map((e) => e.graph?.id ?? '')]),
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
          id: uniqueId(graphPrefix, [comp.mainGraph.id, ...elements.map((e) => e.graph?.id ?? '')]),
          ownerType,
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
  updateLifecycleSignalRefs(data, graph.id, oldId, newId);
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

function updateLifecycleSignalRefs(data: NarrativeGraphsFileDef, graphId: string, oldState: string, newState: string): void {
  const replacements = new Map([
    [`stateEntered:${graphId}:${oldState}`, `stateEntered:${graphId}:${newState}`],
    [`stateExited:${graphId}:${oldState}`, `stateExited:${graphId}:${newState}`],
  ]);
  for (const { graph } of compileGraphs(data)) {
    for (const transition of graph.transitions ?? []) {
      const next = replacements.get(transition.signal);
      if (next) transition.signal = next;
    }
  }
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
      transition.from = replaceEndpointGraph(transition.from, oldGraphId, newGraphId);
      transition.to = replaceEndpointGraph(transition.to, oldGraphId, newGraphId);
      transition.signal = replaceLifecycleSignalGraph(transition.signal, oldGraphId, newGraphId);
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

function replaceLifecycleSignalGraph(signal: string, oldGraphId: string, newGraphId: string): string {
  const lifecycle = parseLifecycleSignalKey(signal);
  if (!lifecycle || lifecycle.graphId !== oldGraphId) return signal;
  return lifecycle.kind === 'stateEntered'
    ? stateEnteredKey(newGraphId, lifecycle.stateId)
    : stateExitedKey(newGraphId, lifecycle.stateId);
}

function replaceNarrativeConditionGraph(obj: Record<string, unknown>, oldGraphId: string, newGraphId: string): void {
  if (obj.narrative === oldGraphId) obj.narrative = newGraphId;
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

export function collectKnownSignals(data: NarrativeGraphsFileDef): string[] {
  const signals = new Set<string>();
  for (const { graph } of compileGraphs(data)) {
    for (const t of graph.transitions ?? []) {
      if (t.signal) signals.add(t.signal);
    }
  }
  for (const comp of data.compositions ?? []) {
    for (const el of comp.elements ?? []) {
      for (const sig of stringList(el.meta?.emits)) signals.add(sig);
    }
  }
  return [...signals].sort((a, b) => a.localeCompare(b));
}

export function signalRequestToKey(signal: RuntimeSignalRequestDef): string {
  const sourceType = String(signal.sourceType ?? '').trim();
  const sourceId = String(signal.sourceId ?? '').trim();
  const sig = String(signal.signal ?? '').trim();
  return sourceType && sourceId && sig ? `external:${encodeKeyPart(sourceType)}:${encodeKeyPart(sourceId)}:${encodeKeyPart(sig)}` : '';
}

export function parseExternalSignalKey(key: string): RuntimeSignalRequestDef {
  const parts = key.split(':');
  if (parts.length >= 4 && parts[0] === 'external') {
    return {
      sourceType: decodeKeyPart(parts[1] ?? ''),
      sourceId: decodeKeyPart(parts[2] ?? ''),
      signal: decodeKeyPart(parts.slice(3).join(':')),
    };
  }
  return { sourceType: 'system', sourceId: 'editor', signal: key };
}

function encodeKeyPart(raw: unknown): string {
  return encodeURIComponent(String(raw ?? '').trim());
}

function decodeKeyPart(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function normalizeTriggerKey(key: string): string {
  const raw = String(key ?? '').trim();
  if (raw.startsWith('external:')) return signalRequestToKey(parseExternalSignalKey(raw));
  const lifecycle = parseLifecycleSignalKey(raw);
  if (!lifecycle) return raw;
  return lifecycle.kind === 'stateEntered'
    ? stateEnteredKey(lifecycle.graphId, lifecycle.stateId)
    : stateExitedKey(lifecycle.graphId, lifecycle.stateId);
}

function triggerKeysEqual(a: string, b: string): boolean {
  return normalizeTriggerKey(a) === normalizeTriggerKey(b);
}

function stateEnteredKey(graphId: string, stateId: string): string {
  return `stateEntered:${encodeKeyPart(graphId)}:${encodeKeyPart(stateId)}`;
}

function stateExitedKey(graphId: string, stateId: string): string {
  return `stateExited:${encodeKeyPart(graphId)}:${encodeKeyPart(stateId)}`;
}

function parseLifecycleSignalKey(key: string): null | { kind: 'stateEntered' | 'stateExited'; graphId: string; stateId: string } {
  const parts = String(key ?? '').split(':');
  const kind = parts[0];
  if ((kind !== 'stateEntered' && kind !== 'stateExited') || parts.length < 3) return null;
  return { kind, graphId: decodeKeyPart(parts[1] ?? ''), stateId: decodeKeyPart(parts.slice(2).join(':')) };
}

export function simulateSignalImpact(dataRaw: NarrativeGraphsFileDef, triggerKey: string): SimulationResult {
  const data = normalizeFile(dataRaw);
  const graphs = compileGraphs(data).map((g) => g.graph);
  const graphMap = new Map(graphs.map((graph) => [graph.id, graph]));
  const activeStates = Object.fromEntries(graphs.map((graph) => [graph.id, graph.initialState]));
  const queue = [triggerKey].filter(Boolean);
  const recentTransitions: SimulationTransitionRecord[] = [];
  const log: string[] = [];
  let loopGuardTripped = false;

  for (let steps = 0; queue.length > 0; steps += 1) {
    if (steps > 128) {
      loopGuardTripped = true;
      log.push('loop guard tripped at 128 queued triggers');
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
          const from = resolveEndpoint(transition.from, graph.id);
          return from.graphId === graph.id &&
            from.stateId === active &&
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
      const from = resolveEndpoint(selected.from, graph.id);
      const to = resolveEndpoint(selected.to, graph.id);
      const targetGraph = graphMap.get(to.graphId);
      if (!targetGraph?.states[to.stateId]) continue;
      const previousTargetState = activeStates[to.graphId] ?? targetGraph.initialState;
      activeStates[to.graphId] = to.stateId;
      recentTransitions.push({
        graphId: to.graphId,
        transitionId: selected.id,
        from: endpointLabel(from),
        to: endpointLabel(to),
        triggerKey: key,
      });
      log.push(`${to.graphId}: ${previousTargetState} -> ${to.stateId} via ${graph.id}.${selected.id}`);
      queue.push(`stateExited:${to.graphId}:${previousTargetState}`);
      queue.push(`stateEntered:${to.graphId}:${to.stateId}`);
      migrated += 1;
    }
    if (migrated === 0) log.push(`no transition matched ${key}`);
  }
  return { activeStates, recentTransitions, log, queued: queue, loopGuardTripped };
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
  const data = normalizeFile(dataRaw);
  const issues: ValidationIssueDef[] = [];
  const compIds = new Set<string>();
  const graphIds = new Set<string>();
  const graphIndex = buildGraphIndex(data);
  for (const [compIndex, comp] of (data.compositions ?? []).entries()) {
    const compPath = `compositions[${compIndex}]`;
    addDuplicateIssue(issues, compIds, comp.id, `${compPath}.id`, 'composition id');
    validateGraph(comp.mainGraph, `${compPath}.mainGraph`, issues, graphIds, graphIndex);
    for (const [elIndex, el] of (comp.elements ?? []).entries()) {
      const path = `${compPath}.elements[${elIndex}]`;
      if (!el.id?.trim()) addIssue(issues, 'error', 'element.id.empty', `${path}: element id is required`, path);
      validateIdDelimiter(el.id, `${path}.id`, 'element.id.delimiter', issues, el.id);
      if (el.kind === 'wrapperGraph') {
        if (!el.ownerId?.trim()) addIssue(issues, 'warning', 'wrapper.unbound', `${el.id}: wrapper has no ownerId binding`, path, el.id);
        if (el.ownerType && !validWrapperOwnerTypes.has(el.ownerType)) {
          addIssue(issues, 'warning', 'wrapper.ownerType.unsupported', `${el.id}: wrapper ownerType is not runtime-backed: ${el.ownerType}`, `${path}.ownerType`, el.id);
        }
        if (!el.graph) addIssue(issues, 'error', 'wrapper.graph.missing', `${el.id}: wrapperGraph requires an inner graph`, path, el.id);
      }
      if (el.kind === 'scenarioSubgraph' && !(el.refId || el.ownerId || '').trim()) {
        addIssue(issues, 'warning', 'scenario.id.empty', `${el.id}: scenarioId is empty`, path, el.id);
      }
      if (el.kind !== 'wrapperGraph' && el.kind !== 'scenarioSubgraph' && !el.refId?.trim()) {
        addIssue(issues, 'warning', 'blackbox.ref.empty', `${el.id}: blackbox refId is empty`, path, el.id);
      }
      if ((el.kind === 'wrapperGraph' || el.kind === 'scenarioSubgraph') && el.graph) {
        validateGraph(el.graph, `${path}.graph`, issues, graphIds, graphIndex, el.kind);
      }
      for (const key of ['emits', 'reads', 'commands'] as const) {
        const raw = el.meta?.[key];
        if (raw !== undefined && !Array.isArray(raw)) {
          addIssue(issues, 'warning', `element.meta.${key}.shape`, `${el.id}: meta.${key} should be a string array`, `${path}.meta.${key}`, el.id);
        }
      }
      for (const graphId of stringList(el.meta?.reads)) {
        if (!graphIndex.graphs.has(graphId)) {
          addIssue(issues, 'warning', 'projection.read.dangling', `${el.id}: reads unknown narrative graph ${graphId}`, `${path}.meta.reads`, el.id);
        }
      }
      for (const command of stringList(el.meta?.commands)) {
        const { graphId, stateId } = parseStateCommandRef(command);
        const target = graphIndex.graphs.get(graphId);
        if (!target || (stateId && !target.states?.[stateId])) {
          addIssue(issues, 'warning', 'projection.command.dangling', `${el.id}: commands unknown narrative state ${command}`, `${path}.meta.commands`, el.id);
        }
      }
    }
  }
  validateStateCommandTargets(data, graphIndex, issues);
  return issues;
}

export function blockingValidationErrors(issues: ValidationIssueDef[]): ValidationIssueDef[] {
  return issues.filter((issue) => issue.severity === 'error');
}

function validateGraph(
  graph: NarrativeGraphDef,
  path: string,
  issues: ValidationIssueDef[],
  graphIds: Set<string>,
  graphIndex: GraphIndex,
  elementKind?: ElementKind,
): void {
  addDuplicateIssue(issues, graphIds, graph.id, `${path}.id`, 'graph id');
  validateIdDelimiter(graph.id, `${path}.id`, 'graph.id.delimiter', issues, graph.id);
  if (!graph.initialState || !graph.states?.[graph.initialState]) {
    addIssue(issues, 'error', 'graph.initialState.invalid', `${graph.id}: initialState does not exist`, `${path}.initialState`, graph.id);
  }
  if (elementKind === 'scenarioSubgraph' || graph.ownerType === 'scenario') {
    if (!graph.entryState || !graph.states?.[graph.entryState]) {
      addIssue(issues, 'error', 'scenario.entryState.invalid', `${graph.id}: scenario entryState must point to an existing state`, `${path}.entryState`, graph.id);
    }
    if (!graph.exitStates?.length) {
      addIssue(issues, 'error', 'scenario.exitStates.empty', `${graph.id}: scenario requires at least one exitState`, `${path}.exitStates`, graph.id);
    }
    for (const [idx, sid] of (graph.exitStates ?? []).entries()) {
      if (!graph.states?.[sid]) {
        addIssue(issues, 'error', 'scenario.exitState.invalid', `${graph.id}: scenario exitState does not exist: ${sid}`, `${path}.exitStates[${idx}]`, graph.id);
      }
    }
  }
  for (const [sid, state] of Object.entries(graph.states ?? {})) {
    if (!state.id?.trim()) addIssue(issues, 'error', 'state.id.empty', `${graph.id}.${sid}: state id is empty`, `${path}.states.${sid}`, sid);
    validateIdDelimiter(sid, `${path}.states.${sid}`, 'state.id.delimiter', issues, sid);
    if (state.id && state.id !== sid) {
      addIssue(issues, 'warning', 'state.id.key.mismatch', `${graph.id}.${sid}: state.id differs from record key`, `${path}.states.${sid}.id`, sid);
    }
    if (sid === graph.initialState && (state.onEnterActions?.length ?? 0) > 0) {
      addIssue(issues, 'error', 'initialState.onEnterActions.unsupported', `${graph.id}.${sid}: initialState onEnterActions will not run at registration/load time`, `${path}.states.${sid}.onEnterActions`, sid);
    }
    validateActions(state.onEnterActions, `${path}.states.${sid}.onEnterActions`, issues, `${graph.id}.${sid}`);
    validateActions(state.onExitActions, `${path}.states.${sid}.onExitActions`, issues, `${graph.id}.${sid}`);
  }
  const transitionIds = new Set<string>();
  for (const [idx, t] of (graph.transitions ?? []).entries()) {
    const tPath = `${path}.transitions[${idx}]`;
    addDuplicateIssue(issues, transitionIds, t.id, `${tPath}.id`, 'transition id', graph.id);
    validateIdDelimiter(t.id, `${tPath}.id`, 'transition.id.delimiter', issues, t.id);
    const from = resolveEndpoint(t.from, graph.id);
    const to = resolveEndpoint(t.to, graph.id);
    const fromGraph = graphIndex.graphs.get(from.graphId);
    const toGraph = graphIndex.graphs.get(to.graphId);
    if (!fromGraph?.states?.[from.stateId]) addIssue(issues, 'error', 'transition.from.missing', `${graph.id}.${t.id}: from state is missing`, `${tPath}.from`, t.id);
    if (!toGraph?.states?.[to.stateId]) addIssue(issues, 'error', 'transition.to.missing', `${graph.id}.${t.id}: to state is missing`, `${tPath}.to`, t.id);
    if (from.graphId !== graph.id) {
      addIssue(issues, 'error', 'transition.owner.mismatch', `${graph.id}.${t.id}: transition must be stored on its from graph (${from.graphId})`, tPath, t.id);
    }
    validateCrossGraphBoundary(graphIndex, graph.id, t, from, to, tPath, issues);
    validateLifecycleSignalScope(graph.id, t, tPath, issues);
    if (!t.signal?.trim()) addIssue(issues, 'error', 'transition.signal.empty', `${graph.id}.${t.id}: signal is required`, `${tPath}.signal`, t.id);
    validateConditions(t.conditions, `${tPath}.conditions`, issues, `${graph.id}.${t.id}`);
  }
}

const validWrapperOwnerTypes = new Set(['npc', 'hotspot', 'zone', 'quest', 'dialogue', 'minigame', 'cutscene', 'scenario', 'system']);

interface ResolvedEndpoint {
  graphId: string;
  stateId: string;
}

interface GraphIndex {
  graphs: Map<string, NarrativeGraphDef>;
  elementKindByGraph: Map<string, ElementKind>;
}

function buildGraphIndex(data: NarrativeGraphsFileDef): GraphIndex {
  const graphs = new Map<string, NarrativeGraphDef>();
  const elementKindByGraph = new Map<string, ElementKind>();
  for (const comp of data.compositions ?? []) {
    if (comp.mainGraph?.id) graphs.set(comp.mainGraph.id, comp.mainGraph);
    for (const el of comp.elements ?? []) {
      if (el.graph?.id) {
        graphs.set(el.graph.id, el.graph);
        elementKindByGraph.set(el.graph.id, el.kind);
      }
    }
  }
  return { graphs, elementKindByGraph };
}

function validateCrossGraphBoundary(
  graphIndex: GraphIndex,
  ownerGraphId: string,
  transition: NarrativeTransitionDef,
  from: ResolvedEndpoint,
  to: ResolvedEndpoint,
  path: string,
  issues: ValidationIssueDef[],
): void {
  if (from.graphId === to.graphId) return;
  const fromKind = graphIndex.elementKindByGraph.get(from.graphId);
  const toKind = graphIndex.elementKindByGraph.get(to.graphId);
  if (fromKind === 'wrapperGraph' || toKind === 'wrapperGraph') {
    addIssue(issues, 'error', 'transition.wrapper.crossGraph', `${ownerGraphId}.${transition.id}: wrapper graph cannot be connected directly across graph boundary`, path, transition.id);
    return;
  }
  const fromGraph = graphIndex.graphs.get(from.graphId);
  const toGraph = graphIndex.graphs.get(to.graphId);
  if ((toKind === 'scenarioSubgraph' || toGraph?.ownerType === 'scenario') && to.stateId !== toGraph?.entryState) {
    addIssue(issues, 'error', 'scenario.boundary.entry', `${ownerGraphId}.${transition.id}: external edges may only enter scenario ${to.graphId} through entryState`, `${path}.to`, transition.id);
  }
  if ((fromKind === 'scenarioSubgraph' || fromGraph?.ownerType === 'scenario') && !(fromGraph?.exitStates ?? []).includes(from.stateId)) {
    addIssue(issues, 'error', 'scenario.boundary.exit', `${ownerGraphId}.${transition.id}: external edges may only leave scenario ${from.graphId} from exitStates`, `${path}.from`, transition.id);
  }
}

function validateLifecycleSignalScope(ownerGraphId: string, transition: NarrativeTransitionDef, path: string, issues: ValidationIssueDef[]): void {
  const lifecycle = parseLifecycleSignalKey(transition.signal);
  if (lifecycle?.graphId === ownerGraphId) {
    addIssue(
      issues,
      'error',
      'lifecycle.sameGraph.unsupported',
      `${ownerGraphId}.${transition.id}: lifecycle signals are cross-graph notifications; use onEnterActions/onExitActions for local hooks`,
      `${path}.signal`,
      transition.id,
    );
  }
}

function validateStateCommandTargets(data: NarrativeGraphsFileDef, graphIndex: GraphIndex, issues: ValidationIssueDef[]): void {
  for (const { graph } of compileGraphs(data)) {
    for (const [sid, state] of Object.entries(graph.states ?? {})) {
      for (const [listName, actions] of Object.entries({ onEnterActions: state.onEnterActions, onExitActions: state.onExitActions })) {
        for (const [idx, action] of (actions ?? []).entries()) {
          if (action?.type !== 'setNarrativeState') continue;
          const params = action.params ?? {};
          const graphId = String(params.graphId ?? '').trim();
          const stateId = String(params.stateId ?? '').trim();
          const targetGraph = graphIndex.graphs.get(graphId);
          if (!targetGraph?.states?.[stateId]) {
            addIssue(issues, 'error', 'stateCommand.target.missing', `${graph.id}.${sid}: setNarrativeState target does not exist: ${graphId}.${stateId}`, `${graph.id}.${sid}.${listName}[${idx}]`, `${graph.id}.${sid}`);
            continue;
          }
          const targetKind = graphIndex.elementKindByGraph.get(graphId);
          if ((targetKind === 'scenarioSubgraph' || targetGraph.ownerType === 'scenario') && stateId !== targetGraph.entryState && !(targetGraph.exitStates ?? []).includes(stateId)) {
            addIssue(issues, 'error', 'stateCommand.scenario.internal', `${graph.id}.${sid}: setNarrativeState targets an internal scenario state: ${graphId}.${stateId}`, `${graph.id}.${sid}.${listName}[${idx}]`, `${graph.id}.${sid}`);
          }
        }
      }
    }
  }
}

function validateActions(actions: unknown, path: string, issues: ValidationIssueDef[], owner: string): void {
  if (actions === undefined) return;
  if (!Array.isArray(actions)) {
    addIssue(issues, 'error', 'actions.shape', `${owner}: actions must be an array`, path, owner);
    return;
  }
  actions.forEach((action, idx) => {
    if (!action || typeof action !== 'object' || Array.isArray(action) || !String(action.type ?? '').trim()) {
      addIssue(issues, 'error', 'action.shape', `${owner}: action ${idx + 1} is missing type`, `${path}[${idx}]`, owner);
      return;
    }
    validateActionDef(action, `${path}[${idx}]`, issues, owner);
  });
}

function validateConditions(conditions: unknown, path: string, issues: ValidationIssueDef[], owner: string): void {
  if (conditions === undefined) return;
  if (!Array.isArray(conditions)) {
    addIssue(issues, 'error', 'conditions.shape', `${owner}: conditions should be an array`, path, owner);
    return;
  }
  conditions.forEach((expr, idx) => {
    if (!isConditionShape(expr)) {
      addIssue(issues, 'error', 'condition.shape', `${owner}: condition ${idx + 1} has an unknown shape`, `${path}[${idx}]`, owner);
    }
  });
}

function isConditionShape(expr: unknown): boolean {
  if (!expr || typeof expr !== 'object' || Array.isArray(expr)) return false;
  const x = expr as Record<string, unknown>;
  if (Array.isArray(x.all)) return x.all.every(isConditionShape);
  if (Array.isArray(x.any)) return x.any.every(isConditionShape);
  if (x.not !== undefined) return isConditionShape(x.not);
  if (typeof x.narrative === 'string') return typeof x.state === 'string' && x.state.trim().length > 0;
  if (typeof x.flag === 'string') return true;
  if (typeof x.quest === 'string') return typeof x.questStatus === 'string' || typeof x.status === 'string';
  if (typeof x.scenario === 'string') return typeof x.phase === 'string' && typeof x.status === 'string';
  if (typeof x.scenarioLine === 'string') return typeof x.lineStatus === 'string';
  return false;
}

const knownActionParamSchemas: Record<string, string[]> = {
  setFlag: ['key', 'value'],
  appendFlag: ['key', 'text'],
  showNotification: ['text', 'type'],
  emitNarrativeSignal: ['sourceType', 'sourceId', 'signal'],
  setNarrativeState: ['graphId', 'stateId'],
  setScenarioPhase: ['scenarioId', 'phase', 'status'],
  startScenario: ['scenarioId'],
  activateScenario: ['scenarioId'],
  completeScenario: ['scenarioId'],
  revealDocument: ['documentId'],
  runActions: ['actions'],
  chooseAction: ['options'],
  randomBranch: ['probability'],
  enableRuleOffers: ['slots'],
  addDelayedEvent: ['actions'],
  disableRuleOffers: [],
  giveItem: ['id'],
  removeItem: ['id'],
  giveCurrency: ['amount'],
  removeCurrency: ['amount'],
  giveRule: ['id'],
  grantRuleLayer: ['ruleId', 'layer'],
  giveFragment: ['id'],
  updateQuest: ['id'],
  startEncounter: ['id'],
  playBgm: ['id'],
  stopBgm: [],
  playSfx: ['id'],
  endDay: [],
  addArchiveEntry: ['type', 'id'],
  startCutscene: ['id'],
  startWaterMinigame: ['id'],
  startSugarWheelMinigame: ['id'],
  startPaperCraftMinigame: ['id'],
  sugarWheelShowSpeech: ['target', 'text'],
  sugarWheelDismissSpeech: ['target'],
  sugarWheelDismissAllSpeech: [],
  sugarWheelResetPointer: ['angleDeg'],
  debugAlertActionParams: [],
  showEmote: ['target', 'emote'],
  showSpeechBubble: ['target', 'text'],
  playNpcAnimation: ['target', 'state'],
  setEntityEnabled: ['target', 'enabled'],
  openShop: ['shopId'],
  pickup: ['itemId'],
  switchScene: ['targetScene'],
  changeScene: ['targetScene'],
  shopPurchase: ['itemId', 'price'],
  inventoryDiscard: ['itemId'],
  setPlayerAvatar: [],
  resetPlayerAvatar: [],
  setSceneDepthFloorOffset: ['floor_offset'],
  resetSceneDepthFloorOffset: [],
  setCameraZoom: ['zoom'],
  restoreSceneCameraZoom: [],
  fadingZoom: ['zoom'],
  fadingRestoreSceneCameraZoom: [],
  stopNpcPatrol: ['npcId'],
  persistNpcDisablePatrol: ['npcId'],
  persistNpcEnablePatrol: ['npcId'],
  persistNpcEntityEnabled: ['npcId', 'enabled'],
  persistHotspotEnabled: ['sceneId', 'hotspotId', 'enabled'],
  setZoneEnabled: ['sceneId', 'zoneId', 'enabled'],
  persistZoneEnabled: ['sceneId', 'zoneId', 'enabled'],
  setSceneEntityPosition: ['sceneId', 'entityKind', 'entityId', 'x', 'y'],
  persistNpcAt: ['npcId', 'sceneId', 'x', 'y'],
  persistNpcAnimState: ['target', 'state'],
  persistPlayNpcAnimation: ['target', 'state'],
  fadeWorldToBlack: [],
  fadeWorldFromBlack: [],
  showOverlayImage: ['id', 'imagePath'],
  setHotspotDisplayImage: ['sceneId', 'hotspotId', 'image'],
  setEntityField: ['sceneId', 'entityKind', 'entityId', 'fieldName', 'value'],
  hideOverlayImage: ['id'],
  blendOverlayImage: ['id', 'fromImagePath', 'toImagePath'],
  startDialogueGraph: ['graphId'],
  waitClickContinue: [],
  playScriptedDialogue: ['lines'],
  waitMs: ['ms'],
  moveEntityTo: ['target', 'x', 'y'],
  faceEntity: ['target'],
  cutsceneSpawnActor: ['id', 'name', 'x', 'y'],
  cutsceneRemoveActor: ['id'],
  showEmoteAndWait: ['target', 'emote'],
  showSpeechBubbleAndWait: ['target', 'text'],
};

function validateActionDef(action: ActionDef, path: string, issues: ValidationIssueDef[], owner: string): void {
  const type = String(action.type ?? '').trim();
  const params = action.params && typeof action.params === 'object' && !Array.isArray(action.params)
    ? action.params as Record<string, unknown>
    : {};
  const required = knownActionParamSchemas[type];
  if (!required) {
    addIssue(issues, 'error', 'action.type.unknown', `${owner}: unknown action type ${type}`, `${path}.type`, owner);
    return;
  }
  for (const name of required) {
    if (params[name] === undefined || params[name] === null || String(params[name]).trim() === '') {
      addIssue(issues, 'error', 'action.param.missing', `${owner}: ${type} missing params.${name}`, `${path}.params.${name}`, owner);
    }
  }
  if (type === 'runActions' || type === 'addDelayedEvent') {
    validateActions(params.actions, `${path}.params.actions`, issues, owner);
  } else if (type === 'enableRuleOffers') {
    if (params.slots !== undefined && !Array.isArray(params.slots)) {
      addIssue(issues, 'error', 'action.container.shape', `${owner}: enableRuleOffers params.slots must be an array`, `${path}.params.slots`, owner);
    }
    (Array.isArray(params.slots) ? params.slots : []).forEach((slot, idx) => {
      if (slot && typeof slot === 'object' && !Array.isArray(slot)) {
        validateActions((slot as Record<string, unknown>).resultActions, `${path}.params.slots[${idx}].resultActions`, issues, owner);
      }
    });
  } else if (type === 'chooseAction') {
    if (params.options !== undefined && !Array.isArray(params.options)) {
      addIssue(issues, 'error', 'action.container.shape', `${owner}: chooseAction params.options must be an array`, `${path}.params.options`, owner);
    }
    (Array.isArray(params.options) ? params.options : []).forEach((option, idx) => {
      if (option && typeof option === 'object' && !Array.isArray(option)) {
        validateActions((option as Record<string, unknown>).actions, `${path}.params.options[${idx}].actions`, issues, owner);
      }
    });
  } else if (type === 'randomBranch') {
    if (params.aboveActions !== undefined) validateActions(params.aboveActions, `${path}.params.aboveActions`, issues, owner);
    if (params.belowActions !== undefined) validateActions(params.belowActions, `${path}.params.belowActions`, issues, owner);
  }
}

function addDuplicateIssue(
  issues: ValidationIssueDef[],
  seen: Set<string>,
  id: string | undefined,
  path: string,
  label: string,
  itemId?: string,
): void {
  const clean = String(id ?? '').trim();
  if (!clean) {
    addIssue(issues, 'error', `${label}.empty`, `${label} is required`, path, itemId);
    return;
  }
  if (seen.has(clean)) {
    addIssue(issues, 'error', `${label}.duplicate`, `duplicate ${label}: ${clean}`, path, itemId ?? clean);
  }
  seen.add(clean);
}

function addIssue(
  issues: ValidationIssueDef[],
  severity: 'error' | 'warning',
  code: string,
  message: string,
  path?: string,
  itemId?: string,
): void {
  issues.push({ severity, code, message, path, itemId });
}

function validateIdDelimiter(value: string | undefined, path: string, code: string, issues: ValidationIssueDef[], itemId?: string): void {
  const id = String(value ?? '');
  if (/[:|]/.test(id)) {
    addIssue(issues, 'error', code, `${id}: id cannot contain ":" or "|"`, path, itemId);
  }
}

export function normalizeEndpoint(endpoint: NarrativeEndpointDef | unknown): NarrativeEndpointDef {
  if (endpoint && typeof endpoint === 'object' && !Array.isArray(endpoint)) {
    const raw = endpoint as Record<string, unknown>;
    const graphId = String(raw.graphId ?? '').trim();
    const stateId = String(raw.stateId ?? '').trim();
    if (graphId && stateId) return { graphId, stateId };
  }
  return String(endpoint ?? '').trim();
}

export function resolveEndpoint(endpoint: NarrativeEndpointDef, ownerGraphId: string): ResolvedEndpoint {
  if (typeof endpoint === 'string') return { graphId: ownerGraphId, stateId: endpoint };
  return { graphId: String(endpoint.graphId ?? '').trim(), stateId: String(endpoint.stateId ?? '').trim() };
}

export function endpointLabel(endpoint: NarrativeEndpointDef | ResolvedEndpoint, ownerGraphId?: string): string {
  const resolved = 'stateId' in endpoint && 'graphId' in endpoint && typeof endpoint !== 'string'
    ? endpoint as ResolvedEndpoint
    : resolveEndpoint(endpoint as NarrativeEndpointDef, ownerGraphId ?? '');
  return `${resolved.graphId}.${resolved.stateId}`;
}

export function endpointInputValue(endpoint: NarrativeEndpointDef, ownerGraphId: string): string {
  const resolved = resolveEndpoint(endpoint, ownerGraphId);
  return resolved.graphId === ownerGraphId ? resolved.stateId : endpointLabel(resolved);
}

export function parseEndpointInput(value: string, ownerGraphId: string, graphIds: string[]): NarrativeEndpointDef {
  const raw = String(value ?? '').trim();
  const match = /^([^.\s]+)\.(.+)$/.exec(raw);
  if (match && graphIds.includes(match[1])) {
    return match[1] === ownerGraphId ? match[2] : { graphId: match[1], stateId: match[2] };
  }
  return raw;
}

function replaceEndpointState(
  endpoint: NarrativeEndpointDef,
  ownerGraphId: string,
  targetGraphId: string,
  oldState: string,
  newState: string,
): NarrativeEndpointDef {
  const resolved = resolveEndpoint(endpoint, ownerGraphId);
  if (resolved.graphId !== targetGraphId || resolved.stateId !== oldState) return endpoint;
  if (typeof endpoint === 'string') return newState;
  return { ...endpoint, stateId: newState };
}

function replaceEndpointGraph(endpoint: NarrativeEndpointDef, oldGraphId: string, newGraphId: string): NarrativeEndpointDef {
  if (typeof endpoint === 'string') return endpoint;
  if (endpoint.graphId !== oldGraphId) return endpoint;
  return { ...endpoint, graphId: newGraphId };
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

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((x) => String(x ?? '').trim()).filter(Boolean);
}

function parseStateCommandRef(raw: string): { graphId: string; stateId: string } {
  const value = String(raw ?? '').trim();
  const dot = /^([^.]+)\.(.+)$/.exec(value);
  if (dot) return { graphId: dot[1], stateId: dot[2] };
  const colon = /^([^:]+):(.+)$/.exec(value);
  if (colon) return { graphId: colon[1], stateId: colon[2] };
  return { graphId: value, stateId: '' };
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

function cleanId(value: string): string {
  return value.trim().replace(/\s+/g, '_');
}
