import type { CanvasMode } from '../types/canvas';
import type {
  CanvasEdge,
  CanvasNode,
  ProjectionEdgeDef,
  ProjectionResult,
} from '../types';
import type { GraphExclusiveView } from './activeGraphView';
import { elementParentId } from './subgraphGroupLayout';
import {
  buildProjectionAnchorNode,
  buildProjectionCanvasEdge,
  visibleProjectionEdgesForComposition,
} from './buildCompositionOverlay';

function showProjection(canvasMode: CanvasMode): boolean {
  return canvasMode === 'wiring' || canvasMode === 'debug';
}

function projectionTouchesGraph(edge: ProjectionEdgeDef, graphId: string, elementNodeId: string): boolean {
  const anchorPrefix = `transition-anchor:${encodeURIComponent(graphId)}:`;
  const rawAnchorPrefix = `transition-anchor:${graphId}:`;
  const endpoints = [edge.source, edge.target].filter(Boolean);
  for (const endpoint of endpoints) {
    if (endpoint === elementNodeId) return true;
    if (endpoint.startsWith(anchorPrefix) || endpoint.startsWith(rawAnchorPrefix)) return true;
    if (endpoint === `graph:${graphId}`) return true;
    // 说明：投影端点用 ':' 分隔（state:<stateId> / graph:<gid> / projection-anchor:<gid>.<sid> …），
    // 图 id 从不被 '.' 两侧包裹，故旧的 `.${graphId}.` 子串匹配从不命中真实格式、只会造成
    // 前缀撞车误判（npc 命中 npc_ring）；`state:${graphId}` 同样匹配不到 state:<stateId>。已移除。
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
  // 到此 endpoint 必不以 'projection-anchor:' 开头（上面已 return），故旧三元恒走 else 分支；
  // 直接补前缀，语义等价、去掉误导性的死分支。
  return `projection-anchor:${endpoint}`;
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

  const projectionCanvasEdges: CanvasEdge[] = scopedEdges.map((edge) =>
    buildProjectionCanvasEdge(
      edge,
      edge.kind,
      resolveExclusiveProjectionEndpoint(edge.source, view),
      resolveExclusiveProjectionEndpoint(edge.target, view),
    )).filter((e) => e.source && e.target);

  const knownIds = new Set(graphNodes.map((node) => node.id));
  const anchors: CanvasNode[] = [];
  for (const edge of scopedEdges) {
    for (const rawEndpoint of [edge.source, edge.target]) {
      if (!rawEndpoint) continue;
      const endpoint = resolveExclusiveProjectionEndpoint(rawEndpoint, view);
      if (knownIds.has(endpoint)) continue;
      if (endpoint.startsWith('transition-anchor:')) continue;
      knownIds.add(endpoint);
      anchors.push(buildProjectionAnchorNode(endpoint, anchors.length));
    }
  }

  return {
    nodes: [...graphNodes, ...anchors],
    edges: [...graphEdges, ...projectionCanvasEdges],
  };
}
