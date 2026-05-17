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
  [key: string]: unknown;
}

export interface NarrativeStateNodeDef {
  id: string;
  label?: string;
  description?: string;
  onEnterActions?: ActionDef[];
  onExitActions?: ActionDef[];
  meta?: Record<string, unknown>;
}

export interface NarrativeEndpointObjectDef {
  graphId: string;
  stateId: string;
}

export type NarrativeEndpointDef = string | NarrativeEndpointObjectDef;

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

export interface NarrativeGraphsFileDef {
  schemaVersion?: number;
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
  triggerEdges: ProjectionEdgeDef[];
  readEdges: ProjectionEdgeDef[];
  stateCommandEdges?: ProjectionEdgeDef[];
}

export interface ValidationIssueDef {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  path?: string;
  itemId?: string;
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
