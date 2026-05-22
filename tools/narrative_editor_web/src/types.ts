import type { Edge, Node } from '@xyflow/react';

export type ElementKind =
  | 'wrapperGraph'
  | 'scenarioSubgraph'
  | 'dialogueBlackbox'
  | 'zoneBlackbox'
  | 'minigameBlackbox'
  | 'cutsceneBlackbox';

export interface ActionDef {
  type: string;
  params?: Record<string, unknown>;
}

export interface ElementMetaDef {
  emits?: string[];
  reads?: string[];
  commands?: string[];
  [key: string]: unknown;
}

export interface NarrativeStateNodeDef {
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
export type NarrativeEndpointDef = string;

export interface NarrativeTransitionDef {
  id: string;
  from: NarrativeEndpointDef;
  to: NarrativeEndpointDef;
  signal: string;
  conditions?: unknown[];
  priority?: number;
}

export interface NarrativeGraphDef {
  id: string;
  ownerType: string;
  ownerId?: string;
  initialState: string;
  entryState?: string;
  exitStates?: string[];
  projectFlags?: boolean;
  states: Record<string, NarrativeStateNodeDef>;
  transitions: NarrativeTransitionDef[];
}

export interface CompositionElementDef {
  id: string;
  kind: ElementKind;
  label?: string;
  ownerType?: string;
  ownerId?: string;
  refId?: string;
  graph?: NarrativeGraphDef;
  x?: number;
  y?: number;
  meta?: ElementMetaDef;
}

export interface NarrativeCompositionDef {
  id: string;
  label?: string;
  description?: string;
  mainGraph: NarrativeGraphDef;
  elements?: CompositionElementDef[];
}

export interface NarrativeAuthorSignalDef {
  id: string;
  label?: string;
  notes?: string;
}

export type SignalCatalogKind = 'author' | 'derived' | 'draft';

export interface SignalCatalogEntryDef {
  id: string;
  kind: SignalCatalogKind;
  label?: string;
  notes?: string;
  graphId?: string;
  stateId?: string;
  listeners: number;
  emitters: number;
  editable: boolean;
}

export interface SignalListenerRefDef {
  compositionId: string;
  graphId: string;
  transitionId: string;
  from: string;
  to: string;
}

export interface SignalEmitterRefDef {
  kind: string;
  refId: string;
  detail: string;
}

export interface NarrativeGraphsFileDef {
  schemaVersion?: number;
  signals?: NarrativeAuthorSignalDef[];
  compositions?: NarrativeCompositionDef[];
}

export interface ProjectionEdgeDef {
  id: string;
  kind: 'trigger' | 'read' | 'stateCommand';
  source: string;
  target: string;
  label?: string;
  detail?: string;
  compositionId?: string;
  graphId?: string;
  transitionId?: string;
  readonly?: boolean;
}

export interface ProjectionResult {
  schemaVersion?: number;
  triggerEdges: ProjectionEdgeDef[];
  readEdges: ProjectionEdgeDef[];
  stateCommandEdges?: ProjectionEdgeDef[];
  warnings?: ProjectionWarningDef[];
}

export interface ProjectionWarningDef {
  severity: 'warning';
  code: string;
  message: string;
  compositionId?: string;
  detail?: string;
}

export type ValidationTargetDef =
  | { kind: 'composition'; compositionId: string; field?: string }
  | { kind: 'graph'; compositionId: string; graphId: string; elementId?: string; field?: string }
  | { kind: 'element'; compositionId: string; elementId: string; field?: string }
  | { kind: 'state'; compositionId: string; graphId: string; stateId: string; elementId?: string; field?: string }
  | { kind: 'transition'; compositionId: string; graphId: string; transitionId: string; elementId?: string; field?: string }
  | { kind: 'signal'; signalId: string; field?: string };

export interface ValidationIssueDef {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  path?: string;
  itemId?: string;
  target?: ValidationTargetDef;
}

export interface AuthoringCatalogDef {
  dialogueGraphIds: string[];
  scenarioIds: string[];
  questIds: string[];
  sceneEntityRefs: string[];
  zoneRefs: string[];
  minigameIds: string[];
  cutsceneIds: string[];
  graphIds: string[];
  actionTypes: string[];
  actionParamSchemas: Record<string, Array<[string, string]>>;
  actionPersistence: Record<string, 'save' | 'memory' | string>;
}

export interface RuntimeSignalRequestDef {
  sourceType: string;
  sourceId: string;
  signal: string;
}

export interface RuntimeDebugSnapshotDef {
  ok: boolean;
  reason?: string;
  snapshot?: unknown;
}

export type CanvasNode = Node<{
  label: string;
  subtitle: string;
  kind: 'state' | ElementKind | 'graphAnchor' | 'projectionAnchor' | 'transitionAnchor';
  detail?: string;
  boundary?: 'entry' | 'exit' | 'entryExit';
  active?: boolean;
}>;

export type CanvasEdge = Edge<{
  label?: string;
  edgeKind: 'transition' | 'trigger' | 'read' | 'stateCommand';
  detail?: string;
}>;
