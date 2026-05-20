import { getBezierPath, Position, type Node } from '@xyflow/react';
import { parseTransitionAnchorId } from '../anchorCodec';
import type { CanvasEdge, CanvasNode, NarrativeGraphDef, NarrativeStateNodeDef } from '../types';
import { stateEditorPosition } from '../editorModel';

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
  if (node.type === 'subgraphGroup') {
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

/**
 * Top-left for a 24px anchor so its center sits on the same bezier label point as migration edges.
 * Handle geometry matches state nodes: source Right, target Left, vertical midline.
 */
export function transitionAnchorPositionOnEdge(
  from: { x: number; y: number },
  to: { x: number; y: number },
  fromWidth = STATE_NODE_LAYOUT_WIDTH,
  fromHeight = STATE_NODE_LAYOUT_HEIGHT,
  toWidth = STATE_NODE_LAYOUT_WIDTH,
  toHeight = STATE_NODE_LAYOUT_HEIGHT,
): { x: number; y: number } {
  const sourceX = from.x + fromWidth;
  const sourceY = from.y + fromHeight / 2;
  const targetX = to.x;
  const targetY = to.y + toHeight / 2;
  const [, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition: Position.Right,
    targetX,
    targetY,
    targetPosition: Position.Left,
  });
  const half = TRANSITION_ANCHOR_SIZE / 2;
  return { x: labelX - half, y: labelY - half };
}

/** Compute anchor top-left from resolved source/target canvas nodes (mixed parent coords OK). */
export function transitionAnchorPositionFromNodes(
  source: CanvasNode,
  target: CanvasNode,
  nodeById: Map<string, CanvasNode>,
  anchorParentId?: string,
): { x: number; y: number } {
  const fromAbs = flowAbsolutePosition(source, nodeById);
  const toAbs = flowAbsolutePosition(target, nodeById);
  const fromSize = nodeLayoutSize(source);
  const toSize = nodeLayoutSize(target);
  const absTopLeft = transitionAnchorPositionOnEdge(
    fromAbs,
    toAbs,
    fromSize.width,
    fromSize.height,
    toSize.width,
    toSize.height,
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

/** Re-align transition anchors after React Flow measures node bounds or nodes move. */
export function snapTransitionAnchorsToEdges(nodes: Node[], edges: CanvasEdge[]): CanvasNode[] | null {
  const nodeById = new Map(nodes.map((node) => [node.id, node as CanvasNode]));
  let changed = false;
  const next = nodes.map((node) => {
    if (node.type !== 'transitionAnchor') return node as CanvasNode;
    const parsed = parseTransitionAnchorId(node.id);
    if (!parsed) return node as CanvasNode;
    const detail = `${parsed.graphId}.${parsed.transitionId}`;
    const edge = edges.find((item) => item.data?.edgeKind === 'transition' && item.data?.detail === detail);
    if (!edge) return node as CanvasNode;
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source?.position || !target?.position) return node as CanvasNode;
    const position = transitionAnchorPositionFromNodes(
      source,
      target,
      nodeById,
      (node as CanvasNode).parentId,
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

export function shouldSnapTransitionAnchors(changes: { type: string; id?: string }[]): boolean {
  return changes.some((change) => {
    if (change.type !== 'dimensions' && change.type !== 'position') return false;
    const id = change.id ?? '';
    return id.startsWith('state:')
      || id.startsWith('subgraph:')
      || id.startsWith('element:');
  });
}
