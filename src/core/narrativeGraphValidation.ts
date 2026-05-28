export type NarrativeValidationSeverity = 'error' | 'warning';

export interface NarrativeValidationIssue {
  severity: NarrativeValidationSeverity;
  code: string;
  message: string;
  path?: string;
  itemId?: string;
  target?: NarrativeValidationTarget;
}

export type NarrativeValidationTarget =
  | { kind: 'composition'; compositionId: string; field?: string }
  | { kind: 'graph'; compositionId: string; graphId: string; elementId?: string; field?: string }
  | { kind: 'element'; compositionId: string; elementId: string; field?: string }
  | { kind: 'state'; compositionId: string; graphId: string; stateId: string; elementId?: string; field?: string }
  | { kind: 'transition'; compositionId: string; graphId: string; transitionId: string; elementId?: string; field?: string }
  | { kind: 'signal'; signalId: string; field?: string };

type ElementKind =
  | 'wrapperGraph'
  | 'scenarioSubgraph'
  | 'dialogueBlackbox'
  | 'zoneBlackbox'
  | 'minigameBlackbox'
  | 'cutsceneBlackbox';

interface ActionLike {
  type?: unknown;
  params?: unknown;
}

interface NarrativeStateLike {
  id?: string;
  broadcastOnEnter?: boolean;
  onEnterActions?: ActionLike[];
  onExitActions?: ActionLike[];
}

interface NarrativeTransitionLike {
  id?: string;
  from?: unknown;
  to?: unknown;
  signal?: unknown;
  trigger?: unknown;
  conditions?: unknown;
  priority?: unknown;
}

interface NarrativeGraphLike {
  id?: string;
  label?: string;
  ownerType?: string;
  ownerId?: string;
  category?: string;
  initialState?: string;
  entryState?: string;
  exitStates?: unknown;
  projectFlags?: boolean;
  states?: Record<string, NarrativeStateLike>;
  transitions?: NarrativeTransitionLike[];
}

interface CompositionElementLike {
  id?: string;
  kind?: ElementKind | string;
  ownerType?: string;
  ownerId?: string;
  refId?: string;
  graph?: NarrativeGraphLike;
  meta?: Record<string, unknown>;
}

interface NarrativeCompositionLike {
  id?: string;
  mainGraph?: NarrativeGraphLike;
  elements?: CompositionElementLike[];
}

interface NarrativeGraphsFileLike {
  signals?: Array<{ id?: unknown }>;
  compositions?: NarrativeCompositionLike[];
}

interface CompiledGraphRef {
  graph: NarrativeGraphLike;
  compositionId: string;
  elementId?: string;
  elementKind?: ElementKind;
}

type GraphValidationContext = {
  compositionId: string;
  graphId: string;
  elementId?: string;
};

interface GraphIndex {
  graphs: Map<string, NarrativeGraphLike>;
  elementKindByGraph: Map<string, ElementKind>;
  ownersByGraphId: Map<string, GraphValidationContext>;
}

interface ResolvedEndpoint {
  graphId: string;
  stateId: string;
}

export const DEFAULT_NARRATIVE_DRAFT_SIGNAL = '__draft__';
export const DERIVED_NARRATIVE_STATE_SIGNAL_PREFIX = 'state:';

export function narrativeStateEnteredSignalKey(graphId: string, stateId: string): string {
  const g = String(graphId ?? '').trim();
  const s = String(stateId ?? '').trim();
  return `${DERIVED_NARRATIVE_STATE_SIGNAL_PREFIX}${g}:${s}`;
}

export function parseNarrativeDerivedStateSignal(id: string): { graphId: string; stateId: string } | null {
  const raw = String(id ?? '').trim();
  if (!raw.startsWith(DERIVED_NARRATIVE_STATE_SIGNAL_PREFIX)) return null;
  const rest = raw.slice(DERIVED_NARRATIVE_STATE_SIGNAL_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) return null;
  const graphId = rest.slice(0, sep).trim();
  const stateId = rest.slice(sep + 1).trim();
  return graphId && stateId ? { graphId, stateId } : null;
}

export function isNarrativeDerivedStateSignal(id: string): boolean {
  return String(id ?? '').trim().startsWith(DERIVED_NARRATIVE_STATE_SIGNAL_PREFIX);
}

export function isReservedNarrativeAuthorSignalId(id: string): boolean {
  const raw = String(id ?? '').trim();
  return !raw || raw === DEFAULT_NARRATIVE_DRAFT_SIGNAL || isNarrativeDerivedStateSignal(raw);
}

export function narrativeStateBroadcastOnEnter(state: { broadcastOnEnter?: boolean } | null | undefined): boolean {
  return state?.broadcastOnEnter === true;
}

export function validateNarrativeGraphData(dataRaw: unknown): NarrativeValidationIssue[] {
  const data = normalizeValidationFile(dataRaw);
  const issues: NarrativeValidationIssue[] = [];
  const compIds = new Set<string>();
  const graphIds = new Set<string>();
  const graphIndex = buildGraphIndex(data);
  for (const [compIndex, comp] of (data.compositions ?? []).entries()) {
    const compPath = `compositions[${compIndex}]`;
    const compositionId = String(comp.id ?? '').trim();
    const compTarget = compositionId ? compositionTarget(compositionId, 'id') : undefined;
    addDuplicateIssue(issues, compIds, comp.id, `${compPath}.id`, 'composition id', compositionId, compTarget);
    const mainGraphId = String(comp.mainGraph?.id ?? '').trim();
    validateGraph(
      comp.mainGraph ?? {},
      `${compPath}.mainGraph`,
      issues,
      graphIds,
      graphIndex,
      data,
      { compositionId, graphId: mainGraphId },
    );
    for (const [elIndex, el] of (comp.elements ?? []).entries()) {
      const path = `${compPath}.elements[${elIndex}]`;
      const elementId = String(el.id ?? '').trim();
      const elTarget = elementId ? elementTarget(compositionId, elementId) : undefined;
      if (!elementId) addIssue(issues, 'error', 'element.id.empty', `${path}: element id is required`, path, undefined, elTarget);
      validateIdDelimiter(el.id, `${path}.id`, 'element.id.delimiter', issues, el.id, elTarget ? { ...elTarget, field: 'id' } : undefined);
      if (el.kind === 'wrapperGraph') {
        if (!String(el.ownerId ?? '').trim()) addIssue(issues, 'error', 'wrapper.unbound', `${el.id}: wrapper has no ownerId binding`, path, el.id, elTarget);
        if (el.ownerType && !validWrapperOwnerTypes.has(el.ownerType)) {
          addIssue(issues, 'warning', 'wrapper.ownerType.unsupported', `${el.id}: wrapper ownerType is not runtime-backed: ${el.ownerType}`, `${path}.ownerType`, el.id, elTarget ? { ...elTarget, field: 'ownerType' } : undefined);
        }
        if (!el.graph) addIssue(issues, 'error', 'wrapper.graph.missing', `${el.id}: wrapperGraph requires an inner graph`, path, el.id, elTarget);
      }
      if (el.kind === 'scenarioSubgraph' && !String(el.refId || el.ownerId || '').trim()) {
        addIssue(issues, 'warning', 'scenario.id.empty', `${el.id}: scenarioId is empty`, path, el.id, elTarget);
      }
      if (el.kind !== 'wrapperGraph' && el.kind !== 'scenarioSubgraph' && !String(el.refId ?? '').trim()) {
        addIssue(issues, 'warning', 'blackbox.ref.empty', `${el.id}: blackbox refId is empty`, path, el.id, elTarget ? { ...elTarget, field: 'refId' } : undefined);
      }
      if ((el.kind === 'wrapperGraph' || el.kind === 'scenarioSubgraph') && el.graph) {
        validateGraph(
          el.graph,
          `${path}.graph`,
          issues,
          graphIds,
          graphIndex,
          data,
          { compositionId, graphId: String(el.graph.id ?? '').trim(), elementId },
          el.kind,
        );
      }
      for (const key of ['emits', 'reads', 'commands'] as const) {
        const raw = el.meta?.[key];
        if (raw !== undefined && !Array.isArray(raw)) {
          addIssue(issues, 'warning', `element.meta.${key}.shape`, `${el.id}: meta.${key} should be a string array`, `${path}.meta.${key}`, el.id, elTarget ? { ...elTarget, field: `meta.${key}` } : undefined);
        }
      }
      for (const graphId of stringList(el.meta?.reads)) {
        if (!graphIndex.graphs.has(graphId)) {
          addIssue(issues, 'warning', 'projection.read.dangling', `${el.id}: reads unknown narrative graph ${graphId}`, `${path}.meta.reads`, el.id, elTarget ? { ...elTarget, field: 'meta.reads' } : undefined);
        }
      }
      for (const command of stringList(el.meta?.commands)) {
        const { graphId, stateId } = parseStateCommandRef(command);
        const target = graphIndex.graphs.get(graphId);
        if (!target || (stateId && !target.states?.[stateId])) {
          addIssue(issues, 'warning', 'projection.command.dangling', `${el.id}: commands unknown narrative state ${command}`, `${path}.meta.commands`, el.id, elTarget ? { ...elTarget, field: 'meta.commands' } : undefined);
        }
      }
    }
  }
  validateAuthorSignals(data, issues);
  validateOwnerBindings(data, issues);
  validateStateCommandTargets(data, graphIndex, issues);
  validateBroadcastStateSignals(data, issues);
  return issues;
}

export function blockingNarrativeValidationErrors(issues: NarrativeValidationIssue[]): NarrativeValidationIssue[] {
  return issues.filter((issue) => issue.severity === 'error');
}

export function resolveNarrativeEndpoint(endpoint: unknown, ownerGraphId: string): ResolvedEndpoint {
  if (typeof endpoint === 'string') return { graphId: ownerGraphId, stateId: endpoint.trim() };
  return { graphId: ownerGraphId, stateId: '' };
}

export function narrativeEndpointLabel(endpoint: unknown, ownerGraphId: string): string {
  const resolved = resolveNarrativeEndpoint(endpoint, ownerGraphId);
  return `${resolved.graphId}.${resolved.stateId}`;
}

function normalizeValidationFile(dataRaw: unknown): NarrativeGraphsFileLike {
  if (!dataRaw || typeof dataRaw !== 'object') return { signals: [], compositions: [] };
  const data = dataRaw as NarrativeGraphsFileLike;
  return {
    signals: Array.isArray(data.signals) ? data.signals : [],
    compositions: Array.isArray(data.compositions) ? data.compositions : [],
  };
}

function compileGraphs(data: NarrativeGraphsFileLike): CompiledGraphRef[] {
  const out: CompiledGraphRef[] = [];
  for (const comp of data.compositions ?? []) {
    if (isGraph(comp.mainGraph)) out.push({ graph: comp.mainGraph, compositionId: String(comp.id ?? '') });
    for (const el of comp.elements ?? []) {
      if ((el.kind === 'wrapperGraph' || el.kind === 'scenarioSubgraph') && isGraph(el.graph)) {
        out.push({ graph: el.graph, compositionId: String(comp.id ?? ''), elementId: el.id, elementKind: el.kind });
      }
    }
  }
  return out;
}

function isGraph(graph: unknown): graph is NarrativeGraphLike {
  return Boolean(graph && typeof graph === 'object');
}

function buildGraphIndex(data: NarrativeGraphsFileLike): GraphIndex {
  const graphs = new Map<string, NarrativeGraphLike>();
  const elementKindByGraph = new Map<string, ElementKind>();
  const ownersByGraphId = new Map<string, GraphValidationContext>();
  for (const comp of data.compositions ?? []) {
    const compositionId = String(comp.id ?? '').trim();
    if (comp.mainGraph?.id) {
      graphs.set(comp.mainGraph.id, comp.mainGraph);
      ownersByGraphId.set(comp.mainGraph.id, { compositionId, graphId: comp.mainGraph.id });
    }
    for (const el of comp.elements ?? []) {
      if (el.graph?.id) {
        graphs.set(el.graph.id, el.graph);
        ownersByGraphId.set(el.graph.id, {
          compositionId,
          elementId: String(el.id ?? '').trim(),
          graphId: el.graph.id,
        });
        if (isElementKind(el.kind)) elementKindByGraph.set(el.graph.id, el.kind);
      }
    }
  }
  return { graphs, elementKindByGraph, ownersByGraphId };
}

function isElementKind(value: unknown): value is ElementKind {
  return typeof value === 'string' && [
    'wrapperGraph',
    'scenarioSubgraph',
    'dialogueBlackbox',
    'zoneBlackbox',
    'minigameBlackbox',
    'cutsceneBlackbox',
  ].includes(value);
}

function validateGraph(
  graph: NarrativeGraphLike,
  path: string,
  issues: NarrativeValidationIssue[],
  graphIds: Set<string>,
  graphIndex: GraphIndex,
  data: NarrativeGraphsFileLike,
  ctx: GraphValidationContext,
  elementKind?: ElementKind,
): void {
  const graphTarget = graphTargetFromCtx(ctx);
  addDuplicateIssue(issues, graphIds, graph.id, `${path}.id`, 'graph id', graph.id, { ...graphTarget, field: 'id' });
  validateIdDelimiter(graph.id, `${path}.id`, 'graph.id.delimiter', issues, graph.id, { ...graphTarget, field: 'id' });
  if (!graph.initialState || !graph.states?.[graph.initialState]) {
    addIssue(issues, 'error', 'graph.initialState.invalid', `${graph.id}: initialState does not exist`, `${path}.initialState`, graph.id, { ...graphTarget, field: 'initialState' });
  }
  if (graph.projectFlags === true) {
    addIssue(issues, 'error', 'projectFlags.deprecated', `${graph.id}: projectFlags is deprecated; use narrative state reads instead of projected flags`, `${path}.projectFlags`, graph.id, { ...graphTarget, field: 'projectFlags' });
  }
  if (elementKind === 'scenarioSubgraph' || graph.ownerType === 'scenario') {
    if (!graph.entryState || !graph.states?.[graph.entryState]) {
      addIssue(issues, 'error', 'scenario.entryState.invalid', `${graph.id}: scenario entryState must point to an existing state`, `${path}.entryState`, graph.id, { ...graphTarget, field: 'entryState' });
    }
    const exits = Array.isArray(graph.exitStates) ? graph.exitStates.map((x) => String(x ?? '').trim()) : [];
    if (!exits.length) {
      addIssue(issues, 'error', 'scenario.exitStates.empty', `${graph.id}: scenario requires at least one exitState`, `${path}.exitStates`, graph.id, { ...graphTarget, field: 'exitStates' });
    }
    for (const [idx, sid] of exits.entries()) {
      if (!graph.states?.[sid]) {
        addIssue(issues, 'error', 'scenario.exitState.invalid', `${graph.id}: scenario exitState does not exist: ${sid}`, `${path}.exitStates[${idx}]`, graph.id, { ...graphTarget, field: 'exitStates' });
      }
    }
  }
  for (const [sid, state] of Object.entries(graph.states ?? {})) {
    const stateTarget = stateTargetFromCtx(ctx, sid);
    if (!String(state.id ?? '').trim()) addIssue(issues, 'error', 'state.id.empty', `${graph.id}.${sid}: state id is empty`, `${path}.states.${sid}`, sid, { ...stateTarget, field: 'id' });
    validateIdDelimiter(sid, `${path}.states.${sid}`, 'state.id.delimiter', issues, sid, { ...stateTarget, field: 'id' });
    if (state.id && state.id !== sid) {
      addIssue(issues, 'warning', 'state.id.key.mismatch', `${graph.id}.${sid}: state.id differs from record key`, `${path}.states.${sid}.id`, sid, { ...stateTarget, field: 'id' });
    }
    if (sid === graph.initialState && (state.onEnterActions?.length ?? 0) > 0) {
      addIssue(issues, 'error', 'initialState.onEnterActions.unsupported', `${graph.id}.${sid}: initialState onEnterActions will not run at registration/load time`, `${path}.states.${sid}.onEnterActions`, sid, { ...stateTarget, field: 'onEnterActions' });
    }
    validateActions(state.onEnterActions, `${path}.states.${sid}.onEnterActions`, issues, `${graph.id}.${sid}`, { ...stateTarget, field: 'onEnterActions' });
    validateActions(state.onExitActions, `${path}.states.${sid}.onExitActions`, issues, `${graph.id}.${sid}`, { ...stateTarget, field: 'onExitActions' });
  }
  const transitionIds = new Set<string>();
  for (const [idx, t] of (graph.transitions ?? []).entries()) {
    const tPath = `${path}.transitions[${idx}]`;
    const transitionTarget = transitionTargetFromCtx(ctx, String(t.id ?? '').trim());
    addDuplicateIssue(issues, transitionIds, t.id, `${tPath}.id`, 'transition id', graph.id, { ...transitionTarget, field: 'id' });
    validateIdDelimiter(t.id, `${tPath}.id`, 'transition.id.delimiter', issues, t.id, { ...transitionTarget, field: 'id' });
    if (typeof t.from !== 'string' || typeof t.to !== 'string') {
      addIssue(
        issues,
        'error',
        'transition.crossGraphEndpoint.unsupported',
        `${graph.id}.${t.id}: transition endpoints must be graph-local state ids; use signals, broadcasts, or projection metadata for cross-graph relationships`,
        tPath,
        t.id,
        transitionTarget,
      );
      continue;
    }
    const from = resolveNarrativeEndpoint(t.from, graph.id ?? '');
    const to = resolveNarrativeEndpoint(t.to, graph.id ?? '');
    if (!graph.states?.[from.stateId]) addIssue(issues, 'error', 'transition.from.missing', `${graph.id}.${t.id}: from state is missing`, `${tPath}.from`, t.id, { ...transitionTarget, field: 'from' });
    if (!graph.states?.[to.stateId]) addIssue(issues, 'error', 'transition.to.missing', `${graph.id}.${t.id}: to state is missing`, `${tPath}.to`, t.id, { ...transitionTarget, field: 'to' });
    validateTransitionSignal(graph.id ?? '', t, tPath, issues, data, { ...transitionTarget, field: 'signal' });
    validateReactiveTrigger(t, `${tPath}.trigger`, issues, { ...transitionTarget, field: 'trigger' });
    validateConditions(t.conditions, `${tPath}.conditions`, issues, `${graph.id}.${t.id}`, graphIndex, { ...transitionTarget, field: 'conditions' });
  }
}

const validWrapperOwnerTypes = new Set(['npc', 'hotspot', 'zone', 'quest', 'dialogue', 'minigame', 'cutscene', 'scenario', 'system']);

function validateTransitionSignal(
  ownerGraphId: string,
  transition: NarrativeTransitionLike,
  path: string,
  issues: NarrativeValidationIssue[],
  data: NarrativeGraphsFileLike,
  target: NarrativeValidationTarget,
): void {
  const sig = String(transition.signal ?? '').trim() || DEFAULT_NARRATIVE_DRAFT_SIGNAL;
  if (sig.startsWith('external:') || sig.startsWith('stateEntered:')) {
    addIssue(
      issues,
      'error',
      'transition.signal.legacyFormat',
      `${ownerGraphId}.${transition.id}: legacy signal format; re-save or migrate to semantic event id`,
      `${path}.signal`,
      transition.id,
      target,
    );
    return;
  }
  if (sig === DEFAULT_NARRATIVE_DRAFT_SIGNAL) {
    addIssue(
      issues,
      'warning',
      'transition.signal.draft',
      `${ownerGraphId}.${transition.id}: transition still uses draft signal ${DEFAULT_NARRATIVE_DRAFT_SIGNAL}`,
      `${path}.signal`,
      `${ownerGraphId}.${transition.id}`,
      target,
    );
    return;
  }
  const known = new Set((data.signals ?? []).map((s) => String(s.id ?? '').trim()).filter(Boolean));
  for (const { graph } of compileGraphs(data)) {
    for (const [stateId, state] of Object.entries(graph.states ?? {})) {
      if (!narrativeStateBroadcastOnEnter(state)) continue;
      known.add(narrativeStateEnteredSignalKey(graph.id ?? '', stateId));
    }
  }
  if (!known.has(sig)) {
    addIssue(
      issues,
      'warning',
      'transition.signal.unknown',
      `${ownerGraphId}.${transition.id}: signal is not in author catalog or derived state list: ${sig}`,
      `${path}.signal`,
      transition.id,
      target,
    );
  }
}

function validateReactiveTrigger(
  transition: NarrativeTransitionLike,
  path: string,
  issues: NarrativeValidationIssue[],
  target: NarrativeValidationTarget,
): void {
  const trigger = String(transition.trigger ?? 'signal').trim();
  if (!['signal', 'reactive', 'reactiveAll', 'reactiveAny'].includes(trigger)) {
    addIssue(
      issues,
      'error',
      'transition.trigger.invalid',
      `${transition.id}: trigger must be 'signal', 'reactive', 'reactiveAll', or 'reactiveAny', got '${trigger}'`,
      `${path}.trigger`,
      transition.id,
      target,
    );
    return;
  }
  if (trigger === 'reactive' || trigger === 'reactiveAll' || trigger === 'reactiveAny') {
    const conditions = transition.conditions;
    if (!Array.isArray(conditions) || conditions.length === 0) {
      addIssue(
        issues,
        'error',
        'transition.reactive.noConditions',
        `${transition.id}: reactive transition (trigger=${trigger}) requires at least one condition`,
        `${path}.conditions`,
        transition.id,
        target,
      );
    }
    const sig = String(transition.signal ?? '').trim();
    if (sig && sig !== DEFAULT_NARRATIVE_DRAFT_SIGNAL) {
      addIssue(
        issues,
        'warning',
        'transition.reactive.signalIgnored',
        `${transition.id}: reactive transition ignores signal field; signal '${sig}' will never be used`,
        `${path}.signal`,
        transition.id,
        target,
      );
    }
  }
}

function validateStateCommandTargets(data: NarrativeGraphsFileLike, graphIndex: GraphIndex, issues: NarrativeValidationIssue[]): void {
  for (const { graph, compositionId, elementId } of compileGraphs(data)) {
    for (const [sid, state] of Object.entries(graph.states ?? {})) {
      const stateTarget = stateTargetFromCtx({ compositionId, graphId: String(graph.id ?? ''), elementId }, sid);
      for (const [listName, actions] of Object.entries({ onEnterActions: state.onEnterActions, onExitActions: state.onExitActions })) {
        for (const [idx, action] of (actions ?? []).entries()) {
          if (action?.type !== 'setNarrativeState') continue;
          addIssue(
            issues,
            'error',
            'stateCommand.unsafeInContent',
            `${graph.id}.${sid}: setNarrativeState bypasses transition conditions and should only be used for debug/repair`,
            `${graph.id}.${sid}.${listName}[${idx}]`,
            `${graph.id}.${sid}`,
            { ...stateTarget, field: listName },
          );
          const params = action.params && typeof action.params === 'object' && !Array.isArray(action.params)
            ? action.params as Record<string, unknown>
            : {};
          const graphId = String(params.graphId ?? '').trim();
          const stateId = String(params.stateId ?? '').trim();
          const targetGraph = graphIndex.graphs.get(graphId);
          if (!targetGraph?.states?.[stateId]) {
            addIssue(issues, 'error', 'stateCommand.target.missing', `${graph.id}.${sid}: setNarrativeState target does not exist: ${graphId}.${stateId}`, `${graph.id}.${sid}.${listName}[${idx}]`, `${graph.id}.${sid}`, { ...stateTarget, field: listName });
            continue;
          }
          const targetKind = graphIndex.elementKindByGraph.get(graphId);
          const exits = Array.isArray(targetGraph.exitStates) ? targetGraph.exitStates.map((x) => String(x ?? '').trim()) : [];
          if ((targetKind === 'scenarioSubgraph' || targetGraph.ownerType === 'scenario') && stateId !== targetGraph.entryState && !exits.includes(stateId)) {
            addIssue(issues, 'error', 'stateCommand.scenario.internal', `${graph.id}.${sid}: setNarrativeState targets an internal scenario state: ${graphId}.${stateId}`, `${graph.id}.${sid}.${listName}[${idx}]`, `${graph.id}.${sid}`, { ...stateTarget, field: listName });
          }
        }
      }
    }
  }
}

function validateOwnerBindings(data: NarrativeGraphsFileLike, issues: NarrativeValidationIssue[]): void {
  const byOwner = new Map<string, Array<{ graphId: string; category: string }>>();
  for (const { graph, elementKind } of compileGraphs(data)) {
    if (elementKind !== 'wrapperGraph') continue;
    const ownerType = String(graph.ownerType ?? '').trim();
    const ownerId = String(graph.ownerId ?? '').trim();
    const gid = String(graph.id ?? '').trim();
    if (!ownerType || !ownerId || !gid) continue;
    const key = `${ownerType}:${ownerId}`;
    const entries = byOwner.get(key) ?? [];
    entries.push({ graphId: gid, category: String(graph.category ?? '').trim() });
    byOwner.set(key, entries);
  }
  for (const [key, graphs] of byOwner.entries()) {
    if (graphs.length <= 1) continue;
    const graphIds = graphs.map((entry) => entry.graphId);
    addIssue(
      issues,
      'warning',
      'owner.wrapper.multi',
      `${key}: multiple wrapper graphs share the same owner binding (${graphIds.join(', ')})`,
      undefined,
      key,
    );
    const missingCategoryIds = graphs.filter((entry) => !entry.category).map((entry) => entry.graphId);
    if (missingCategoryIds.length > 0) {
      addIssue(
        issues,
        'warning',
        'owner.wrapper.category.missing',
        `${key}: multiple wrappers should set category for clarity (missing on: ${missingCategoryIds.join(', ')})`,
        undefined,
        key,
      );
    }
    const categoryMap = new Map<string, string[]>();
    for (const entry of graphs) {
      if (!entry.category) continue;
      const ids = categoryMap.get(entry.category) ?? [];
      ids.push(entry.graphId);
      categoryMap.set(entry.category, ids);
    }
    for (const [category, ids] of categoryMap.entries()) {
      if (ids.length <= 1) continue;
      addIssue(
        issues,
        'warning',
        'owner.wrapper.category.duplicate',
        `${key}: wrapper category "${category}" is used by multiple wrappers (${ids.join(', ')})`,
        undefined,
        key,
      );
    }
  }
}

function validateBroadcastStateSignals(data: NarrativeGraphsFileLike, issues: NarrativeValidationIssue[]): void {
  const listeners = collectListenerRefs(data);
  const graphById = new Map<string, NarrativeGraphLike>();
  const ownerByGraphId = new Map<string, GraphValidationContext>();
  for (const { graph, compositionId, elementId } of compileGraphs(data)) {
    if (graph.id) graphById.set(graph.id, graph);
    if (graph.id) ownerByGraphId.set(graph.id, { compositionId, elementId, graphId: graph.id });
  }
  for (const [sig, refs] of listeners) {
    const parsed = parseNarrativeDerivedStateSignal(sig);
    if (!parsed) continue;
    const sourceGraph = graphById.get(parsed.graphId);
    const state = sourceGraph?.states?.[parsed.stateId];
    const statePath = `${parsed.graphId}.${parsed.stateId}`;
    if (!state) {
      for (const ref of refs) {
        const owner = ownerByGraphId.get(ref.graphId);
        addIssue(
          issues,
          'error',
          'state.broadcast.sourceMissing',
          `${ref.graphId}.${ref.transitionId}: derived signal ${sig} references missing state`,
          `${ref.graphId}.transitions`,
          ref.transitionId,
          owner ? transitionTargetFromCtx(owner, ref.transitionId) : undefined,
        );
      }
      continue;
    }
    if (!narrativeStateBroadcastOnEnter(state)) {
      for (const ref of refs) {
        const owner = ownerByGraphId.get(ref.graphId);
        addIssue(
          issues,
          'error',
          'state.broadcast.missing',
          `${ref.graphId}.${ref.transitionId}: ${sig} requires ${statePath} to enable broadcastOnEnter`,
          `${parsed.graphId}.states.${parsed.stateId}.broadcastOnEnter`,
          ref.transitionId,
          owner ? transitionTargetFromCtx(owner, ref.transitionId) : undefined,
        );
      }
    }
  }
  for (const { graph, compositionId, elementId } of compileGraphs(data)) {
    for (const [stateId, state] of Object.entries(graph.states ?? {})) {
      if (!narrativeStateBroadcastOnEnter(state)) continue;
      const sig = narrativeStateEnteredSignalKey(graph.id ?? '', stateId);
      if ((listeners.get(sig)?.length ?? 0) === 0) {
        addIssue(
          issues,
          'warning',
          'state.broadcast.unused',
          `${graph.id}.${stateId}: broadcastOnEnter is enabled but no transition listens to ${sig}`,
          `${graph.id}.states.${stateId}.broadcastOnEnter`,
          stateId,
          stateTargetFromCtx({ compositionId, elementId, graphId: String(graph.id ?? '') }, stateId, 'broadcastOnEnter'),
        );
      }
    }
  }
}

function collectListenerRefs(data: NarrativeGraphsFileLike): Map<string, Array<{ graphId: string; transitionId: string }>> {
  const map = new Map<string, Array<{ graphId: string; transitionId: string }>>();
  for (const { graph } of compileGraphs(data)) {
    for (const t of graph.transitions ?? []) {
      const sig = String(t.signal ?? '').trim();
      if (!sig) continue;
      const list = map.get(sig) ?? [];
      list.push({ graphId: graph.id ?? '', transitionId: String(t.id ?? '') });
      map.set(sig, list);
    }
  }
  return map;
}

function validateAuthorSignals(data: NarrativeGraphsFileLike, issues: NarrativeValidationIssue[]): void {
  const seen = new Set<string>();
  for (const [idx, row] of (data.signals ?? []).entries()) {
    const id = String(row.id ?? '').trim();
    const path = `signals[${idx}].id`;
    const target = id ? signalTarget(id, 'id') : undefined;
    if (!id) {
      addIssue(issues, 'error', 'signal.id.empty', 'author signal id is required', path);
      continue;
    }
    if (seen.has(id)) addIssue(issues, 'error', 'signal.id.duplicate', `duplicate author signal id: ${id}`, path, id, target);
    seen.add(id);
    if (isReservedNarrativeAuthorSignalId(id)) {
      addIssue(issues, 'error', 'signal.id.reserved', `author signal id is reserved: ${id}`, path, id, target);
    }
  }
}

function validateActions(actions: unknown, path: string, issues: NarrativeValidationIssue[], owner: string, target?: NarrativeValidationTarget): void {
  if (actions === undefined) return;
  if (!Array.isArray(actions)) {
    addIssue(issues, 'error', 'actions.shape', `${owner}: actions must be an array`, path, owner, target);
    return;
  }
  actions.forEach((action, idx) => {
    if (!action || typeof action !== 'object' || Array.isArray(action) || !String((action as ActionLike).type ?? '').trim()) {
      addIssue(issues, 'error', 'action.shape', `${owner}: action ${idx + 1} is missing type`, `${path}[${idx}]`, owner, target);
      return;
    }
    validateActionDef(action as ActionLike, `${path}[${idx}]`, issues, owner, target);
  });
}

function validateConditions(
  conditions: unknown,
  path: string,
  issues: NarrativeValidationIssue[],
  owner: string,
  graphIndex: GraphIndex,
  target?: NarrativeValidationTarget,
): void {
  if (conditions === undefined) return;
  if (!Array.isArray(conditions)) {
    addIssue(issues, 'error', 'conditions.shape', `${owner}: conditions should be an array`, path, owner, target);
    return;
  }
  conditions.forEach((expr, idx) => {
    validateConditionExpr(expr, `${path}[${idx}]`, issues, owner, graphIndex, target);
  });
}

function validateConditionExpr(
  expr: unknown,
  path: string,
  issues: NarrativeValidationIssue[],
  owner: string,
  graphIndex: GraphIndex,
  target?: NarrativeValidationTarget,
): boolean {
  if (!expr || typeof expr !== 'object' || Array.isArray(expr)) {
    addIssue(issues, 'error', 'condition.shape', `${owner}: condition has an unknown shape`, path, owner, target);
    return false;
  }
  const x = expr as Record<string, unknown>;
  if (Array.isArray(x.all)) return x.all.map((e, i) => validateConditionExpr(e, `${path}.all[${i}]`, issues, owner, graphIndex, target)).every(Boolean);
  if (Array.isArray(x.any)) return x.any.map((e, i) => validateConditionExpr(e, `${path}.any[${i}]`, issues, owner, graphIndex, target)).every(Boolean);
  if (x.not !== undefined) return validateConditionExpr(x.not, `${path}.not`, issues, owner, graphIndex, target);
  if (typeof x.narrative === 'string') {
    const graphId = x.narrative.trim();
    const stateId = typeof x.state === 'string' ? x.state.trim() : '';
    if (!stateId) {
      addIssue(issues, 'error', 'condition.shape', `${owner}: narrative condition requires state`, path, owner, target);
      return false;
    }
    const graph = graphIndex.graphs.get(graphId);
    if (!graph) {
      addIssue(issues, 'error', 'condition.narrative.graphMissing', `${owner}: narrative graph does not exist: ${graphId}`, `${path}.narrative`, owner, target);
      return false;
    }
    if (!graph.states?.[stateId]) {
      addIssue(issues, 'error', 'condition.narrative.stateMissing', `${owner}: narrative state does not exist: ${graphId}.${stateId}`, `${path}.state`, owner, target);
      return false;
    }
    return true;
  }
  if (typeof x.flag === 'string') return true;
  if (typeof x.quest === 'string') return typeof x.questStatus === 'string' || typeof x.status === 'string';
  if (typeof x.scenario === 'string') return typeof x.phase === 'string' && typeof x.status === 'string';
  if (typeof x.scenarioLine === 'string') return typeof x.lineStatus === 'string';
  addIssue(issues, 'error', 'condition.shape', `${owner}: condition has an unknown shape`, path, owner, target);
  return false;
}

const knownActionParamSchemas: Record<string, string[]> = {
  setFlag: ['key', 'value'],
  appendFlag: ['key', 'text'],
  showNotification: ['text', 'type'],
  emitNarrativeSignal: ['signal'],
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
  persistNpcEntityEnabled: ['target', 'enabled'],
  persistHotspotEnabled: ['sceneId', 'hotspotId', 'enabled'],
  setZoneEnabled: ['sceneId', 'zoneId', 'enabled'],
  persistZoneEnabled: ['sceneId', 'zoneId', 'enabled'],
  setSceneEntityPosition: ['sceneId', 'entityKind', 'entityId', 'x', 'y'],
  persistNpcAt: ['target', 'x', 'y'],
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
  waitMs: ['durationMs'],
  moveEntityTo: ['target', 'x', 'y'],
  faceEntity: ['target'],
  cutsceneSpawnActor: ['id', 'name', 'x', 'y'],
  cutsceneRemoveActor: ['id'],
  showEmoteAndWait: ['target', 'emote'],
  showSpeechBubbleAndWait: ['target', 'text'],
};

function validateActionDef(action: ActionLike, path: string, issues: NarrativeValidationIssue[], owner: string, target?: NarrativeValidationTarget): void {
  const type = String(action.type ?? '').trim();
  const params = action.params && typeof action.params === 'object' && !Array.isArray(action.params)
    ? action.params as Record<string, unknown>
    : {};
  const required = knownActionParamSchemas[type];
  if (!required) {
    addIssue(issues, 'error', 'action.type.unknown', `${owner}: unknown action type ${type}`, `${path}.type`, owner, target);
    return;
  }
  for (const name of required) {
    if (params[name] === undefined || params[name] === null || String(params[name]).trim() === '') {
      addIssue(issues, 'error', 'action.param.missing', `${owner}: ${type} missing params.${name}`, `${path}.params.${name}`, owner, target);
    }
  }
  if (type === 'runActions' || type === 'addDelayedEvent') {
    validateActions(params.actions, `${path}.params.actions`, issues, owner, target);
  } else if (type === 'enableRuleOffers') {
    if (params.slots !== undefined && !Array.isArray(params.slots)) {
      addIssue(issues, 'error', 'action.container.shape', `${owner}: enableRuleOffers params.slots must be an array`, `${path}.params.slots`, owner, target);
    }
    (Array.isArray(params.slots) ? params.slots : []).forEach((slot, idx) => {
      if (slot && typeof slot === 'object' && !Array.isArray(slot)) {
        validateActions((slot as Record<string, unknown>).resultActions, `${path}.params.slots[${idx}].resultActions`, issues, owner, target);
      }
    });
  } else if (type === 'chooseAction') {
    if (params.options !== undefined && !Array.isArray(params.options)) {
      addIssue(issues, 'error', 'action.container.shape', `${owner}: chooseAction params.options must be an array`, `${path}.params.options`, owner, target);
    }
    (Array.isArray(params.options) ? params.options : []).forEach((option, idx) => {
      if (option && typeof option === 'object' && !Array.isArray(option)) {
        validateActions((option as Record<string, unknown>).actions, `${path}.params.options[${idx}].actions`, issues, owner, target);
      }
    });
  } else if (type === 'randomBranch') {
    if (params.aboveActions !== undefined) validateActions(params.aboveActions, `${path}.params.aboveActions`, issues, owner, target);
    if (params.belowActions !== undefined) validateActions(params.belowActions, `${path}.params.belowActions`, issues, owner, target);
  }
}

function addDuplicateIssue(
  issues: NarrativeValidationIssue[],
  seen: Set<string>,
  id: string | undefined,
  path: string,
  label: string,
  itemId?: string,
  target?: NarrativeValidationTarget,
): void {
  const clean = String(id ?? '').trim();
  if (!clean) {
    addIssue(issues, 'error', `${label}.empty`, `${label} is required`, path, itemId, target);
    return;
  }
  if (seen.has(clean)) {
    addIssue(issues, 'error', `${label}.duplicate`, `duplicate ${label}: ${clean}`, path, itemId ?? clean, target);
  }
  seen.add(clean);
}

function addIssue(
  issues: NarrativeValidationIssue[],
  severity: NarrativeValidationSeverity,
  code: string,
  message: string,
  path?: string,
  itemId?: string,
  target?: NarrativeValidationTarget,
): void {
  issues.push({ severity, code, message, path, itemId, target });
}

function validateIdDelimiter(
  value: string | undefined,
  path: string,
  code: string,
  issues: NarrativeValidationIssue[],
  itemId?: string,
  target?: NarrativeValidationTarget,
): void {
  const id = String(value ?? '');
  if (/[:|]/.test(id)) {
    addIssue(issues, 'error', code, `${id}: id cannot contain ":" or "|"`, path, itemId, target);
  }
}

function compositionTarget(compositionId: string, field?: string): NarrativeValidationTarget {
  return compactTarget({ kind: 'composition', compositionId, field });
}

function graphTargetFromCtx(ctx: GraphValidationContext, field?: string): NarrativeValidationTarget {
  return compactTarget({
    kind: 'graph',
    compositionId: ctx.compositionId,
    graphId: ctx.graphId,
    elementId: ctx.elementId,
    field,
  });
}

function elementTarget(compositionId: string, elementId: string, field?: string): NarrativeValidationTarget {
  return compactTarget({ kind: 'element', compositionId, elementId, field });
}

function stateTargetFromCtx(ctx: GraphValidationContext, stateId: string, field?: string): NarrativeValidationTarget {
  return compactTarget({
    kind: 'state',
    compositionId: ctx.compositionId,
    graphId: ctx.graphId,
    elementId: ctx.elementId,
    stateId,
    field,
  });
}

function transitionTargetFromCtx(ctx: GraphValidationContext, transitionId: string, field?: string): NarrativeValidationTarget {
  return compactTarget({
    kind: 'transition',
    compositionId: ctx.compositionId,
    graphId: ctx.graphId,
    elementId: ctx.elementId,
    transitionId,
    field,
  });
}

function signalTarget(signalId: string, field?: string): NarrativeValidationTarget {
  return compactTarget({ kind: 'signal', signalId, field });
}

function compactTarget<T extends NarrativeValidationTarget>(target: T): T {
  return Object.fromEntries(Object.entries(target).filter(([, value]) => value !== undefined && value !== '')) as T;
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
  if (dot) return { graphId: dot[1]!, stateId: dot[2]! };
  const colon = /^([^:]+):(.+)$/.exec(value);
  if (colon) return { graphId: colon[1]!, stateId: colon[2]! };
  return { graphId: value, stateId: '' };
}
