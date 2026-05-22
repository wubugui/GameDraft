import { MarkerType } from '@xyflow/react';
import type { CanvasMode } from '../types/canvas';
import type {
  CanvasEdge,
  CanvasNode,
  ProjectionEdgeDef,
  ProjectionResult,
} from '../types';
import type { GraphExclusiveView } from './activeGraphView';
import { projectionEndpointLabel } from './canvasIds';
import { elementParentId } from './subgraphGroupLayout';
import { visibleProjectionEdgesForComposition } from './buildCompositionOverlay';

function showProjection(canvasMode: CanvasMode): boolean {
  return canvasMode === 'wiring' || canvasMode === 'debug';
}

function edgeColor(kind: string): string {
  if (kind === 'transition') return '#d9a441';
  if (kind === 'trigger') return '#45a8e5';
  if (kind === 'read') return '#79b65d';
  if (kind === 'stateCommand') return '#d94d4d';
  return '#d782d9';
}

function projectionTouchesGraph(edge: ProjectionEdgeDef, graphId: string, elementNodeId: string): boolean {
  const anchorPrefix = `transition-anchor:${encodeURIComponent(graphId)}:`;
  const rawAnchorPrefix = `transition-anchor:${graphId}:`;
  const endpoints = [edge.source, edge.target].filter(Boolean);
  for (const endpoint of endpoints) {
    if (endpoint === elementNodeId) return true;
    if (endpoint.startsWith(anchorPrefix) || endpoint.startsWith(rawAnchorPrefix)) return true;
    if (endpoint === `graph:${graphId}`) return true;
    if (endpoint === `state:${graphId}` || endpoint.includes(`.${graphId}.`)) return true;
  }
  return false;
}

function resolveExclusiveProjectionEndpoint(
  endpoint: string,
  view: GraphExclusiveView,
): string {
  if (endpoint.startsWith('transition-anchor:')) {
    const parsed = endpoint.match(/^transition-anchor:([^:]+):(.+)$/);
    if (parsed && decodeURIComponent(parsed[1]!) === view.activeGraphId) return endpoint;
  }
  if (endpoint === elementParentId(view.element.id)) return endpoint;
  if (endpoint.startsWith('state:')) {
    const stateId = endpoint.slice('state:'.length);
    if (view.graph.states[stateId]) return view.scope.stateNodeId(stateId);
  }
  if (endpoint.startsWith('element:')) return endpoint;
  if (endpoint.startsWith('graph:')) return endpoint;
  if (endpoint.startsWith('projection-anchor:')) return endpoint;
  if (endpoint.startsWith('external:')) return endpoint;
  return endpoint.startsWith('projection-anchor:') ? endpoint : `projection-anchor:${endpoint.replace(/^projection-anchor:/, '')}`;
}

export function mergeGraphLayerWithExclusiveProjection(
  graphNodes: CanvasNode[],
  graphEdges: CanvasEdge[],
  view: GraphExclusiveView,
  projection: ProjectionResult,
  canvasMode: CanvasMode,
  showTrigger: boolean,
  showRead: boolean,
  showCommand: boolean,
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  if (!showProjection(canvasMode)) {
    return { nodes: graphNodes, edges: graphEdges };
  }

  const elementNodeId = elementParentId(view.element.id);
  const scopedEdges = visibleProjectionEdgesForComposition(
    view.comp, projection, showTrigger, showRead, showCommand,
  ).filter((edge) => projectionTouchesGraph(edge, view.activeGraphId, elementNodeId));

  const projectionCanvasEdges: CanvasEdge[] = scopedEdges.map((edge) => ({
    id: `projection:${edge.id}`,
    source: resolveExclusiveProjectionEndpoint(edge.source, view),
    target: resolveExclusiveProjectionEndpoint(edge.target, view),
    type: 'projection',
    label: edge.label,
    selectable: true,
    deletable: false,
    interactionWidth: 12,
    zIndex: 0,
    markerEnd: { type: MarkerType.ArrowClosed, color: edgeColor(edge.kind) },
    data: { edgeKind: edge.kind, label: edge.label, detail: edge.detail ?? edge.id },
  })).filter((e) => e.source && e.target);

  const knownIds = new Set(graphNodes.map((node) => node.id));
  const anchors: CanvasNode[] = [];
  for (const edge of scopedEdges) {
    for (const rawEndpoint of [edge.source, edge.target]) {
      if (!rawEndpoint) continue;
      const endpoint = resolveExclusiveProjectionEndpoint(rawEndpoint, view);
      if (knownIds.has(endpoint)) continue;
      if (endpoint.startsWith('transition-anchor:')) continue;
      knownIds.add(endpoint);
      const index = anchors.length;
      anchors.push({
        id: endpoint,
        type: 'projectionAnchor',
        position: { x: 760 + (index % 2) * 210, y: 120 + Math.floor(index / 2) * 96 },
        draggable: false,
        deletable: false,
        data: {
          label: projectionEndpointLabel(endpoint),
          subtitle: '投影端点',
          kind: 'projectionAnchor',
          detail: endpoint,
        },
      });
    }
  }

  return {
    nodes: [...graphNodes, ...anchors],
    edges: [...graphEdges, ...projectionCanvasEdges],
  };
}
