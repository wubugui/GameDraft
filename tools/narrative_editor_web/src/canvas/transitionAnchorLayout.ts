import { type Node } from '@xyflow/react';
import { parseTransitionAnchorId } from '../anchorCodec';
import type { CanvasEdge, CanvasNode, NarrativeGraphDef, NarrativeStateNodeDef } from '../types';
import { stateEditorPosition } from '../editorModel';
import {
  chooseRouteSides,
  computeEdgeRoutes,
  nodeTypeHasFourWayPorts,
  routedLabelPoint,
  type EdgeRoute,
  type RoutingNodeRect,
} from './edgeRouting';

/** Matches `.node { min-width: 150px }` used by state nodes. */
export const STATE_NODE_LAYOUT_WIDTH = 150;

/** Typical rendered height for state title + subtitle (padding included). */
export const STATE_NODE_LAYOUT_HEIGHT = 58;

export const ELEMENT_NODE_LAYOUT_WIDTH = 150;
export const ELEMENT_NODE_LAYOUT_HEIGHT = 72;

export const TRANSITION_ANCHOR_SIZE = 24;

export function stateIndexInGraph(graph: NarrativeGraphDef, stateId: string): number {
  const keys = Object.keys(graph.states ?? {});
  const index = keys.indexOf(stateId);
  return index >= 0 ? index : 0;
}

export function stateCanvasPosition(
  graph: NarrativeGraphDef,
  stateId: string,
  graphBase: { x: number; y: number },
): { x: number; y: number } | null {
  const state = graph.states?.[stateId];
  if (!state) return null;
  const pos = stateEditorPosition(state, stateIndexInGraph(graph, stateId));
  return { x: graphBase.x + pos.x, y: graphBase.y + pos.y };
}

/** Absolute canvas position (sums parent chain). */
export function flowAbsolutePosition(
  node: Pick<CanvasNode, 'position' | 'parentId'>,
  nodeById: Map<string, CanvasNode>,
): { x: number; y: number } {
  let x = node.position.x;
  let y = node.position.y;
  let parentId = node.parentId;
  while (parentId) {
    const parent = nodeById.get(parentId);
    if (!parent) break;
    x += parent.position.x;
    y += parent.position.y;
    parentId = parent.parentId;
  }
  return { x, y };
}

/** Position relative to a parent group (for child nodes with extent:parent). */
export function flowPositionInParent(
  node: Pick<CanvasNode, 'position' | 'parentId'>,
  parentId: string,
  nodeById: Map<string, CanvasNode>,
): { x: number; y: number } | null {
  const abs = flowAbsolutePosition(node, nodeById);
  const parent = nodeById.get(parentId);
  if (!parent) return null;
  const parentAbs = flowAbsolutePosition(parent, nodeById);
  return { x: abs.x - parentAbs.x, y: abs.y - parentAbs.y };
}

export function nodeLayoutSize(node: Pick<CanvasNode, 'type' | 'measured' | 'width' | 'height' | 'style'>): {
  width: number;
  height: number;
} {
  if (node.type === 'transitionAnchor') {
    return { width: TRANSITION_ANCHOR_SIZE, height: TRANSITION_ANCHOR_SIZE };
  }
  // 框类节点的尺寸以 style 为准：折叠瞬间 style 已改成紧凑尺寸，而 measured 还留着展开时的
  // 旧值（要等下一次 dimensions 变更才追上）。读 measured 会让边接在 200 宽的框上、
  // 触发点却按 467 宽算，差出几十像素。
  if (node.type === 'subgraphGroup' || node.type === 'editorGroupFrame' || node.type === 'wrapperGroupFrame') {
    return {
      width: Number(node.style?.width ?? node.measured?.width ?? node.width ?? 280),
      height: Number(node.style?.height ?? node.measured?.height ?? node.height ?? 200),
    };
  }
  if (node.type && node.type !== 'state' && node.type !== 'graphAnchor' && node.type !== 'projectionAnchor') {
    return {
      width: Number(node.measured?.width ?? node.width ?? ELEMENT_NODE_LAYOUT_WIDTH),
      height: Number(node.measured?.height ?? node.height ?? ELEMENT_NODE_LAYOUT_HEIGHT),
    };
  }
  return {
    width: Number(node.measured?.width ?? node.width ?? STATE_NODE_LAYOUT_WIDTH),
    height: Number(node.measured?.height ?? node.height ?? STATE_NODE_LAYOUT_HEIGHT),
  };
}

/** 节点在画布绝对坐标下的矩形 + 是否四向端口（路由几何的唯一输入）。 */
export function routingRectOfNode(
  node: CanvasNode,
  nodeById: Map<string, CanvasNode>,
): RoutingNodeRect {
  const abs = flowAbsolutePosition(node, nodeById);
  const size = nodeLayoutSize(node);
  return {
    x: abs.x,
    y: abs.y,
    width: size.width,
    height: size.height,
    fourWay: nodeTypeHasFourWayPorts(node.type),
  };
}

/** 供画布 display 层与吸附共用的矩形索引（同一份几何 → 边与触发点永远对得上）。 */
export function buildRoutingRects(nodes: readonly Node[]): Map<string, RoutingNodeRect> {
  const nodeById = new Map(nodes.map((node) => [node.id, node as CanvasNode]));
  const out = new Map<string, RoutingNodeRect>();
  for (const node of nodeById.values()) {
    out.set(node.id, routingRectOfNode(node, nodeById));
  }
  return out;
}

function anchorTopLeftForRects(
  source: RoutingNodeRect,
  target: RoutingNodeRect,
  route?: EdgeRoute,
): { x: number; y: number } {
  const resolved: EdgeRoute = route ?? {
    ...chooseRouteSides(source, target, false),
    offset: 0,
    selfLoop: false,
  };
  const point = routedLabelPoint(source, target, resolved);
  const half = TRANSITION_ANCHOR_SIZE / 2;
  return { x: point.x - half, y: point.y - half };
}

/**
 * Top-left for a 24px anchor so its center sits on the same label point as its transition edge.
 * 路由（进出侧 + 平行错开量）与边渲染共用 canvas/edgeRouting，缺省按几何选侧、零错开。
 */
export function transitionAnchorPositionOnEdge(
  from: { x: number; y: number },
  to: { x: number; y: number },
  fromWidth = STATE_NODE_LAYOUT_WIDTH,
  fromHeight = STATE_NODE_LAYOUT_HEIGHT,
  toWidth = STATE_NODE_LAYOUT_WIDTH,
  toHeight = STATE_NODE_LAYOUT_HEIGHT,
  route?: EdgeRoute,
): { x: number; y: number } {
  return anchorTopLeftForRects(
    { x: from.x, y: from.y, width: fromWidth, height: fromHeight, fourWay: true },
    { x: to.x, y: to.y, width: toWidth, height: toHeight, fourWay: true },
    route,
  );
}

/** Compute anchor top-left from resolved source/target canvas nodes (mixed parent coords OK). */
export function transitionAnchorPositionFromNodes(
  source: CanvasNode,
  target: CanvasNode,
  nodeById: Map<string, CanvasNode>,
  anchorParentId?: string,
  route?: EdgeRoute,
): { x: number; y: number } {
  const absTopLeft = anchorTopLeftForRects(
    routingRectOfNode(source, nodeById),
    routingRectOfNode(target, nodeById),
    route,
  );
  if (!anchorParentId) return absTopLeft;
  const parent = nodeById.get(anchorParentId);
  if (!parent) return absTopLeft;
  const parentAbs = flowAbsolutePosition(parent, nodeById);
  return {
    x: absTopLeft.x - parentAbs.x,
    y: absTopLeft.y - parentAbs.y,
  };
}

export function measuredStateNodeSize(
  state: NarrativeStateNodeDef | undefined,
): { width: number; height: number } {
  const editor = (state?.meta?.editor ?? {}) as { width?: number; height?: number };
  return {
    width: Number(editor.width ?? STATE_NODE_LAYOUT_WIDTH),
    height: Number(editor.height ?? STATE_NODE_LAYOUT_HEIGHT),
  };
}

/** transition 边按 `graphId.transitionId` 建索引（触发点 id 里带的就是这一对）。 */
function transitionEdgeIndex(edges: readonly CanvasEdge[]): Map<string, CanvasEdge> {
  const out = new Map<string, CanvasEdge>();
  for (const edge of edges) {
    if (edge.data?.edgeKind !== 'transition') continue;
    const detail = edge.data?.detail;
    if (typeof detail === 'string' && detail && !out.has(detail)) out.set(detail, edge);
  }
  return out;
}

/**
 * 触发点重定位的公共核：吃一份「节点 + 边」，把每个触发点摆到它那条边的实际曲线中点上。
 * 两个调用面喂的是**不同的两份**：
 * - `snapTransitionAnchorsToEdges` 喂模型态（写回节点 state，参与子图框尺寸计算）；
 * - `alignTransitionAnchorsToDisplayEdges` 喂折叠变换后的 display 态（只影响这一帧的呈现）。
 */
function relocateAnchors(
  nodes: readonly Node[],
  edges: readonly CanvasEdge[],
  hideWhenEdgeGone: boolean,
): CanvasNode[] | null {
  const nodeById = new Map(nodes.map((node) => [node.id, node as CanvasNode]));
  // 与画布渲染同源的路由：触发点必须吸附到**实际画出来的那条曲线**上，
  // 否则平行边一错开、回连边一换侧，触发点就浮在半空。
  const rects = buildRoutingRects(nodes);
  const routes = computeEdgeRoutes(edges, (id) => rects.get(id) ?? null);
  const edgeByDetail = transitionEdgeIndex(edges);
  let changed = false;
  const next = nodes.map((node) => {
    if (node.type !== 'transitionAnchor') return node as CanvasNode;
    const parsed = parseTransitionAnchorId(node.id);
    if (!parsed) return node as CanvasNode;
    const edge = edgeByDetail.get(`${parsed.graphId}.${parsed.transitionId}`);
    if (!edge || edge.hidden) {
      // 边被折叠组吃掉（两端同在一个折叠组内）→ 触发点跟着藏，别留一颗孤零零的点
      if (!hideWhenEdgeGone || node.hidden) return node as CanvasNode;
      changed = true;
      return { ...(node as CanvasNode), hidden: true };
    }
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source?.position || !target?.position) return node as CanvasNode;
    const position = transitionAnchorPositionFromNodes(
      source,
      target,
      nodeById,
      (node as CanvasNode).parentId,
      routes.get(edge.id),
    );
    if (
      Math.abs(position.x - node.position.x) < 0.5
      && Math.abs(position.y - node.position.y) < 0.5
    ) {
      return node as CanvasNode;
    }
    changed = true;
    return { ...(node as CanvasNode), position };
  });
  return changed ? next : null;
}

/** Re-align transition anchors after React Flow measures node bounds or nodes move. */
export function snapTransitionAnchorsToEdges(nodes: Node[], edges: CanvasEdge[]): CanvasNode[] | null {
  return relocateAnchors(nodes, edges, false);
}

/**
 * display 层收尾：分组折叠会把跨组边**改接到分组框**、把组内边整条隐藏，而触发点位置是按
 * 原始端点算的——不跟着重算就会飘在半空 / 留下没有边的孤点。只作用于 display 拷贝，
 * 模型态的触发点位置（参与子图框尺寸）不动。
 */
export function alignTransitionAnchorsToDisplayEdges(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
): CanvasNode[] {
  return relocateAnchors(nodes, edges, true) ?? nodes;
}

export function shouldSnapTransitionAnchors(changes: { type: string; id?: string }[]): boolean {
  return changes.some((change) => {
    if (change.type !== 'dimensions' && change.type !== 'position') return false;
    const id = change.id ?? '';
    return id.startsWith('state:')
      || id.startsWith('subgraph:')
      || id.startsWith('element:');
  });
}
