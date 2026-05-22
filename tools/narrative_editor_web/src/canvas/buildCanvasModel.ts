import {
  type GraphRef,
} from '../editorModel';
import type { CanvasMode } from '../types/canvas';
import type {
  CanvasEdge,
  CanvasNode,
  NarrativeCompositionDef,
  NarrativeGraphDef,
  ProjectionResult,
} from '../types';
import { resolveActiveGraphView } from './activeGraphView';
import { buildCompositionOverlay } from './buildCompositionOverlay';
import { mergeGraphLayerWithExclusiveProjection } from './buildExclusiveProjection';
import { buildExclusiveGraphLayer, buildGraphLayer } from './buildGraphLayer';
import type { EndpointResolutionContext } from './endpointResolution';
export { legacyNodeIdForEndpoint, resolveCanvasEndpoint, stateEndpointFromNodeId, stateEndpointFromNodeIdForView } from './endpointResolution';
export { visibleProjectionEdgesForComposition } from './buildCompositionOverlay';

export type CanvasBuildInput = {
  comp: NarrativeCompositionDef;
  graph: NarrativeGraphDef;
  graphRef: GraphRef;
  activeStates: Record<string, string>;
  projection: ProjectionResult;
  canvasMode: CanvasMode;
  showTrigger: boolean;
  showRead: boolean;
  showCommand: boolean;
  expandedElementIds: string[];
};

export function buildCanvasNodes(input: CanvasBuildInput): CanvasNode[] {
  const view = resolveActiveGraphView(input.comp, input.graphRef);
  if (!view) return [];

  const endpointCtx: EndpointResolutionContext = {
    view,
    expandedElementIds: input.expandedElementIds,
  };

  if (view.kind === 'compositionMain') {
    const graphPart = buildGraphLayer({
      graph: view.graph,
      scope: view.scope,
      activeStates: input.activeStates,
      canvasMode: input.canvasMode,
      endpointCtx,
      includeGraphAnchor: true,
      includeTransitionAnchors: false,
    });
    return buildCompositionOverlay({
      view,
      graphNodes: graphPart.nodes,
      graphEdges: graphPart.edges,
      activeStates: input.activeStates,
      projection: input.projection,
      canvasMode: input.canvasMode,
      showTrigger: input.showTrigger,
      showRead: input.showRead,
      showCommand: input.showCommand,
      expandedElementIds: input.expandedElementIds,
    }).nodes;
  }

  const graphPart = buildExclusiveGraphLayer(
    view,
    input.activeStates,
    input.canvasMode,
    input.expandedElementIds,
  );
  return mergeGraphLayerWithExclusiveProjection(
    graphPart.nodes,
    graphPart.edges,
    view,
    input.projection,
    input.canvasMode,
    input.showTrigger,
    input.showRead,
    input.showCommand,
  ).nodes;
}

export function buildCanvasEdges(input: CanvasBuildInput): CanvasEdge[] {
  const view = resolveActiveGraphView(input.comp, input.graphRef);
  if (!view) return [];

  const endpointCtx: EndpointResolutionContext = {
    view,
    expandedElementIds: input.expandedElementIds,
  };

  if (view.kind === 'compositionMain') {
    const graphPart = buildGraphLayer({
      graph: view.graph,
      scope: view.scope,
      activeStates: input.activeStates,
      canvasMode: input.canvasMode,
      endpointCtx,
      includeGraphAnchor: true,
      includeTransitionAnchors: false,
    });
    return buildCompositionOverlay({
      view,
      graphNodes: graphPart.nodes,
      graphEdges: graphPart.edges,
      activeStates: input.activeStates,
      projection: input.projection,
      canvasMode: input.canvasMode,
      showTrigger: input.showTrigger,
      showRead: input.showRead,
      showCommand: input.showCommand,
      expandedElementIds: input.expandedElementIds,
    }).edges;
  }

  const graphPart = buildExclusiveGraphLayer(
    view,
    input.activeStates,
    input.canvasMode,
    input.expandedElementIds,
  );
  return mergeGraphLayerWithExclusiveProjection(
    graphPart.nodes,
    graphPart.edges,
    view,
    input.projection,
    input.canvasMode,
    input.showTrigger,
    input.showRead,
    input.showCommand,
  ).edges;
}
