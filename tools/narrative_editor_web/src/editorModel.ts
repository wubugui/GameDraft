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

/** 活计运行层模拟状态（对齐运行时 v2 单活模型：实例在 activeStates 表、无 @key） */
export interface SimulationRunLayer {
  /** 全局单激活槽：只有它吃信号/跑 reactive；null=无激活单 */
  activatedArchetype: string | null;
  /** 有实例但未激活（挂起冻结）的活计图 id */
  suspended: string[];
  /** 累计接单次数（graphId → started；reset 不增） */
  started: Record<string, number>;
  /** 累计结算计数（graphId → exitStateId → count），narrativeCount 叶的模拟后端 */
  settled: Record<string, Record<string, number>>;
}

export function emptySimulationRunLayer(): SimulationRunLayer {
  return { activatedArchetype: null, suspended: [], started: {}, settled: {} };
}

export interface SimulationResult {
  activeStates: Record<string, string>;
  runLayer: SimulationRunLayer;
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
  sceneIds: [],
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
  planeIds: [],
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
  return next;
}

// broadcastOnEnter 只由用户在状态面板勾选，normalize 不代写数据（曾有 auto-mark：
// 发现监听 state:<g>:<s> 就静默给源状态标广播——只加不减，监听删除后留下孤儿空播，
// 且用户从未授权这次写入）。监听了未广播状态由校验器报 state.broadcast.missing（error，
// 定位到 states.<id>.broadcastOnEnter），用户自己决定勾不勾。

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
  // 只做无争议归一化：清 id/label/notes 两端空白。空 id / 保留字前缀 / 重复 id 一律**保留**，
  // 交给校验器报 signal.id.empty / signal.id.reserved / signal.id.duplicate（均 error 拦保存）。
  // 旧实现静默删行：既丢用户数据，又让前两个校验码在 web 侧永不可达，还与 Python
  // _normalize_file（保留并报错）分歧（2026-07-17 审查 W-E9 收敛为"保留+校验报"）。
  // 目录/选择器侧对保留字已有独立过滤与创建守卫（signalCatalog），不受影响。
  for (const row of signals) {
    row.id = String(row.id ?? '').trim();
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
  // 不播 label=id（显示名回退到 id；磁盘 182 个状态 0 个 label==id——默认键注入是字节噪音）
  graph.states[id] = {
    id,
    meta: { editor: { x: 120, y: 260 } },
  };
  if (!graph.initialState) graph.initialState = id;
  return id;
}

export function createTransition(graph: NarrativeGraphDef, from: string, to: string, trigger?: 'signal' | 'reactive' | 'reactiveAll' | 'reactiveAny'): NarrativeTransitionDef {
  const id = uniqueId('t', graph.transitions.map((t) => t.id));
  // 不播 priority:0（运行时/排序按 `?? 0` 兜底；磁盘 137 条迁移全部无该键）
  const transition: NarrativeTransitionDef = { id, from, to, signal: DEFAULT_DRAFT_SIGNAL };
  if (trigger && trigger !== 'signal') transition.trigger = trigger;
  graph.transitions.push(transition);
  return transition;
}

export function createComposition(data: NarrativeGraphsFileDef): NarrativeCompositionDef {
  const comps = data.compositions ??= [];
  const id = uniqueId('composition', comps.map((c) => c.id));
  const graphId = uniqueGraphId(data, 'flow');
  // 不播 label==id 类默认键（显示层一律回退 id；避免默认键注入进 JSON）
  const comp: NarrativeCompositionDef = {
    id,
    mainGraph: {
      id: graphId,
      ownerType: 'flow',
      initialState: 'initial',
      states: { initial: { id: 'initial', meta: { editor: { x: 120, y: 160 } } } },
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
    // 状态不播 label==id、wrapper 不播 category:''（默认键注入；显示层回退 id）
    element.graph = kind === 'scenarioSubgraph'
      ? {
          id: data ? uniqueGraphId(data, graphPrefix) : uniqueId(graphPrefix, [comp.mainGraph.id, ...elements.map((e) => e.graph?.id ?? '')]),
          label: element.label,
          ownerType,
          initialState: 'inactive',
          entryState: 'entry',
          exitStates: ['exit'],
          states: {
            inactive: { id: 'inactive', meta: { editor: { x: 60, y: 160 } } },
            entry: { id: 'entry', meta: { editor: { x: 280, y: 120 } } },
            exit: { id: 'exit', meta: { editor: { x: 520, y: 120 } } },
          },
          transitions: [],
        }
      : {
          id: data ? uniqueGraphId(data, graphPrefix) : uniqueId(graphPrefix, [comp.mainGraph.id, ...elements.map((e) => e.graph?.id ?? '')]),
          label: element.label,
          ownerType,
          initialState: 'initial',
          states: { initial: { id: 'initial', meta: { editor: { x: 120, y: 160 } } } },
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

function isRunGraphDef(graph: NarrativeGraphDef): boolean {
  return Boolean(graph.run && typeof graph.run === 'object');
}

function cloneRunLayer(layer: SimulationRunLayer): SimulationRunLayer {
  return {
    activatedArchetype: layer.activatedArchetype,
    suspended: [...layer.suspended],
    started: { ...layer.started },
    settled: Object.fromEntries(Object.entries(layer.settled).map(([g, m]) => [g, { ...m }])),
  };
}

interface SimContext {
  graphs: NarrativeGraphDef[];
  graphMap: Map<string, NarrativeGraphDef>;
  activeStates: Record<string, string>;
  runLayer: SimulationRunLayer;
  queue: string[];
  recentTransitions: SimulationTransitionRecord[];
  log: string[];
  loopGuardTripped: boolean;
}

/** 对齐运行时 listLiveGraphEntries：常驻图恒在场；活计图须有实例且占激活槽（挂起=冻结） */
function simGraphLive(sim: SimContext, graph: NarrativeGraphDef): boolean {
  if (!isRunGraphDef(graph)) return true;
  return sim.activeStates[graph.id] !== undefined && sim.runLayer.activatedArchetype === graph.id;
}

/** 进态收口：写表、广播入队；活计到出口自动结算（计数+删实例+清激活槽），对齐运行时 enterState→settle */
function enterSimState(sim: SimContext, graph: NarrativeGraphDef, to: string): void {
  sim.activeStates[graph.id] = to;
  if (sim.graphMap.get(graph.id)?.states[to]?.broadcastOnEnter === true) {
    sim.queue.push(stateEnteredSignalKey(graph.id, to));
  }
  if (isRunGraphDef(graph) && (graph.exitStates ?? []).includes(to)) {
    const settledByExit = sim.runLayer.settled[graph.id] ?? (sim.runLayer.settled[graph.id] = {});
    settledByExit[to] = (settledByExit[to] ?? 0) + 1;
    delete sim.activeStates[graph.id];
    sim.runLayer.suspended = sim.runLayer.suspended.filter((g) => g !== graph.id);
    if (sim.runLayer.activatedArchetype === graph.id) sim.runLayer.activatedArchetype = null;
    sim.log.push(`${graph.id}: 结算于出口 ${to}（累计 ${settledByExit[to]}），实例回收、激活槽清空`);
  }
}

/** 建模拟上下文：常驻图恒在场（无先前值回退 initialState）；活计图只在实例携带时在场（蛰伏不吃信号） */
function makeSimContext(
  dataRaw: NarrativeGraphsFileDef,
  initialActiveStates?: Record<string, string>,
  runLayerIn?: SimulationRunLayer,
): SimContext {
  const data = normalizeFile(dataRaw);
  const graphs = compileGraphs(data).map((g) => g.graph);
  const graphMap = new Map(graphs.map((graph) => [graph.id, graph]));
  const activeStates: Record<string, string> = {};
  for (const graph of graphs) {
    const carried = initialActiveStates?.[graph.id];
    const valid = carried && graph.states?.[carried] ? carried : undefined;
    if (isRunGraphDef(graph)) {
      if (valid !== undefined) activeStates[graph.id] = valid;
    } else {
      activeStates[graph.id] = valid ?? graph.initialState;
    }
  }
  return {
    graphs, graphMap, activeStates,
    runLayer: cloneRunLayer(runLayerIn ?? emptySimulationRunLayer()),
    queue: [], recentTransitions: [], log: [], loopGuardTripped: false,
  };
}

function simResult(sim: SimContext): SimulationResult {
  return {
    activeStates: sim.activeStates,
    runLayer: sim.runLayer,
    recentTransitions: sim.recentTransitions,
    log: sim.log,
    queued: sim.queue,
    loopGuardTripped: sim.loopGuardTripped,
  };
}

const SIM_MAX_STEPS = 128;

function drainSimQueue(sim: SimContext): void {
  for (let steps = 0; sim.queue.length > 0; steps += 1) {
    if (steps >= SIM_MAX_STEPS) {
      sim.loopGuardTripped = true;
      sim.log.push(`loop guard tripped at ${SIM_MAX_STEPS} queued triggers`);
      sim.queue.length = 0;
      break;
    }
    const key = sim.queue.shift()!;
    let migrated = 0;
    for (const graph of sim.graphs) {
      if (!simGraphLive(sim, graph)) continue;
      const active = sim.activeStates[graph.id] ?? graph.initialState;
      const selected = (graph.transitions ?? [])
        .map((transition, index) => ({ transition, index }))
        .filter(({ transition }) => {
          if (typeof transition.from !== 'string' || typeof transition.to !== 'string') return false;
          return transition.from === active &&
            triggerKeysEqual(transition.signal, key) &&
            conditionsMet(transition.conditions, sim);
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
      if (!sim.graphMap.get(graph.id)?.states[to]) continue;
      const previousState = sim.activeStates[graph.id] ?? graph.initialState;
      sim.recentTransitions.push({
        graphId: graph.id,
        transitionId: selected.id,
        from,
        to,
        triggerKey: key,
      });
      sim.log.push(`${graph.id}: ${previousState} -> ${to} via ${graph.id}.${selected.id}`);
      enterSimState(sim, graph, to);
      migrated += 1;
    }
    if (migrated === 0) sim.log.push(`no transition matched ${key}`);
    runSimReactivePass(sim);
    if (sim.loopGuardTripped) break;
  }
}

/** 每个信号步之后的 reactive 收敛（与主循环共用 liveness / 进态 / 结算语义） */
function runSimReactivePass(sim: SimContext): void {
  let reactiveFired = true;
  let reactiveSteps = 0;
  while (reactiveFired) {
    if (reactiveSteps >= SIM_MAX_STEPS) {
      sim.loopGuardTripped = true;
      sim.log.push(`loop guard tripped at ${SIM_MAX_STEPS} reactive transitions`);
      sim.queue.length = 0;
      break;
    }
    reactiveSteps += 1;
    reactiveFired = false;
    for (const graph of sim.graphs) {
      if (!simGraphLive(sim, graph)) continue;
      const active = sim.activeStates[graph.id] ?? graph.initialState;
      const candidates = (graph.transitions ?? [])
        .filter((t) => {
          if (!t.trigger || t.trigger === 'signal') return false;
          if (typeof t.from !== 'string' || typeof t.to !== 'string') return false;
          return t.from === active && simulateReactiveConditionsMet(t, sim);
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
      if (!sim.graphMap.get(graph.id)?.states[to]) continue;
      const previousState = sim.activeStates[graph.id] ?? graph.initialState;
      sim.recentTransitions.push({
        graphId: graph.id,
        transitionId: selected.id,
        from,
        to,
        triggerKey: '__reactive__',
      });
      sim.log.push(`${graph.id}: ${previousState} -> ${to} via ${graph.id}.${selected.id} [reactive:${selected.trigger}]`);
      enterSimState(sim, graph, to);
      reactiveFired = true;
    }
  }
}

export function simulateSignalImpact(
  dataRaw: NarrativeGraphsFileDef,
  triggerKey: string,
  initialActiveStates?: Record<string, string>,
  runLayerIn?: SimulationRunLayer,
): SimulationResult {
  const sim = makeSimContext(dataRaw, initialActiveStates, runLayerIn);
  sim.queue.push(...[triggerKey].filter(Boolean));
  drainSimQueue(sim);
  return simResult(sim);
}

export type SimulationRunOp = 'start' | 'reset' | 'revert' | 'activate';

/**
 * 活计生命周期模拟（对齐运行时 start/reset/revert/activate 语义）：
 * start=接单（已有实例拒绝；顶替当前激活单——resumable 挂起、否则弃置）；
 * reset=回 initialState（静默）；revert=跳指定态（静默）；
 * activate=切换激活（graphId 空=放下当前单，只清槽/挂起）。
 * 操作后跑一轮 reactive 收敛 + 排空广播（新激活单可能立即满足 reactive 条件）。
 */
export function simulateRunLifecycle(
  dataRaw: NarrativeGraphsFileDef,
  op: SimulationRunOp,
  graphId: string,
  opts?: { activeStates?: Record<string, string>; runLayer?: SimulationRunLayer; stateId?: string },
): SimulationResult {
  const sim = makeSimContext(dataRaw, opts?.activeStates, opts?.runLayer);
  const gid = graphId.trim();
  const graph = gid ? sim.graphMap.get(gid) : undefined;

  const suspendOrDiscardActivated = (): void => {
    const prev = sim.runLayer.activatedArchetype;
    if (!prev) return;
    const prevGraph = sim.graphMap.get(prev);
    if (prevGraph?.run?.resumable === true) {
      if (!sim.runLayer.suspended.includes(prev)) sim.runLayer.suspended.push(prev);
      sim.log.push(`${prev}: 挂起（resumable，进度保留）`);
    } else {
      delete sim.activeStates[prev];
      sim.log.push(`${prev}: 弃置（非 resumable，实例回收）`);
    }
    sim.runLayer.activatedArchetype = null;
  };

  if (op === 'activate' && !gid) {
    suspendOrDiscardActivated();
    sim.log.push('激活槽清空（放下当前单）');
  } else if (!graph || !isRunGraphDef(graph)) {
    sim.log.push(`${op}: ${gid || '(空)'} 不是活计图，忽略`);
  } else if (op === 'start') {
    if (sim.activeStates[gid] !== undefined) {
      sim.log.push(`start: ${gid} 已有实例（重来用 reset、切回用 activate），忽略`);
    } else {
      suspendOrDiscardActivated();
      sim.activeStates[gid] = graph.initialState;
      sim.runLayer.started[gid] = (sim.runLayer.started[gid] ?? 0) + 1;
      sim.runLayer.activatedArchetype = gid;
      sim.log.push(`${gid}: 接单（第 ${sim.runLayer.started[gid]} 单）→ ${graph.initialState}，已激活`);
    }
  } else if (op === 'reset') {
    if (sim.activeStates[gid] === undefined) {
      sim.log.push(`reset: ${gid} 无实例（开新用 start），忽略`);
    } else {
      sim.activeStates[gid] = graph.initialState;
      sim.log.push(`${gid}: 重开 → ${graph.initialState}（静默，不广播）`);
    }
  } else if (op === 'revert') {
    const sid = (opts?.stateId ?? '').trim();
    if (sim.activeStates[gid] === undefined) {
      sim.log.push(`revert: ${gid} 无实例，忽略`);
    } else if (!sid || !graph.states?.[sid]) {
      sim.log.push(`revert: 目标状态 ${sid || '(空)'} 不存在于 ${gid}，忽略`);
    } else {
      sim.activeStates[gid] = sid;
      sim.log.push(`${gid}: 回退 → ${sid}（静默，不广播）`);
    }
  } else if (op === 'activate') {
    if (sim.runLayer.activatedArchetype === gid) {
      sim.log.push(`activate: ${gid} 已是激活单，忽略`);
    } else if (sim.activeStates[gid] === undefined) {
      sim.log.push(`activate: ${gid} 无实例可激活（开新用 start），忽略`);
    } else {
      suspendOrDiscardActivated();
      sim.runLayer.suspended = sim.runLayer.suspended.filter((g) => g !== gid);
      sim.runLayer.activatedArchetype = gid;
      sim.log.push(`${gid}: 切换激活，从 ${sim.activeStates[gid]} 续跑`);
    }
  }

  runSimReactivePass(sim);
  drainSimQueue(sim);
  return simResult(sim);
}

function simulateReactiveConditionsMet(t: NarrativeTransitionDef, sim: SimContext): boolean {
  if (!t.conditions?.length) return false;
  if (t.trigger === 'reactive') {
    return conditionsMet(t.conditions, sim);
  }
  if (t.trigger === 'reactiveAll') {
    return conditionsMet([{ all: t.conditions }], sim);
  }
  if (t.trigger === 'reactiveAny') {
    return conditionsMet([{ any: t.conditions }], sim);
  }
  return false;
}

function conditionsMet(conditions: unknown[] | undefined, sim: SimContext): boolean {
  if (!conditions?.length) return true;
  return conditions.every((expr) => evalCondition(expr, sim));
}

const NARRATIVE_COUNT_OPS: Record<string, (a: number, b: number) => boolean> = {
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
};

function evalCondition(expr: unknown, sim: SimContext): boolean {
  if (!expr || typeof expr !== 'object' || Array.isArray(expr)) return false;
  const x = expr as Record<string, unknown>;
  if (Array.isArray(x.all)) return x.all.every((e) => evalCondition(e, sim));
  if (Array.isArray(x.any)) return x.any.some((e) => evalCondition(e, sim));
  if (x.not && typeof x.not === 'object') return !evalCondition(x.not, sim);
  if (typeof x.narrative === 'string' && typeof x.state === 'string') {
    // 活计图无实例时表里无键 → 恒 false（蛰伏语义），与运行时单活直读一致
    return sim.activeStates[x.narrative] === x.state;
  }
  if (typeof x.narrativeCount === 'string' && typeof x.value === 'number') {
    const settledByExit = sim.runLayer.settled[x.narrativeCount] ?? {};
    const exit = typeof x.exitState === 'string' ? x.exitState.trim() : '';
    const total = exit
      ? settledByExit[exit] ?? 0
      : Object.values(settledByExit).reduce((a, b) => a + b, 0);
    const op = typeof x.op === 'string' && x.op in NARRATIVE_COUNT_OPS ? x.op : '>=';
    return NARRATIVE_COUNT_OPS[op](total, x.value);
  }
  return false;
}

/**
 * 已登记位面 id 目录（authoring catalog 的 planeIds）。App 装载 catalog 后注入；
 * null = 目录未知（如 catalog 加载失败），activePlane 存在性检查跳过（不误报）。
 * 不注入则 TS 权威侧的 state.activePlane.unknown 检查永不触发（Python validate-data 仍兜底）。
 */
let knownPlaneIdsForValidation: ReadonlySet<string> | null = null;

export function setKnownPlaneIdsForValidation(ids: readonly string[] | null): void {
  knownPlaneIdsForValidation = ids
    ? new Set(ids.map((id) => String(id ?? '').trim()).filter(Boolean))
    : null;
}

export function validateNarrativeData(dataRaw: NarrativeGraphsFileDef | unknown): ValidationIssueDef[] {
  return validateNarrativeGraphData(normalizeFile(dataRaw), {
    planeIds: knownPlaneIdsForValidation ?? undefined,
  }) as ValidationIssueDef[];
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
