import type { NodeChange } from '@xyflow/react';
import { parseTransitionAnchorId } from '../anchorCodec';
import { isSubgraphElement, stateEditorPosition } from '../editorModel';
import type {
  CompositionElementDef,
  NarrativeCompositionDef,
  NarrativeGraphDef,
  NarrativeStateNodeDef,
  NarrativeTransitionDef,
  CanvasNode,
} from '../types';
import {
  STATE_NODE_LAYOUT_HEIGHT,
  STATE_NODE_LAYOUT_WIDTH,
  TRANSITION_ANCHOR_SIZE,
} from './transitionAnchorLayout';

/** Matches legacy inlineSubgraphBase offset from element position (24, 150). */
export const SUBGRAPH_CHILD_ORIGIN = { x: 24, y: 150 };

export const SUBGRAPH_GROUP_MIN_WIDTH = 280;
export const SUBGRAPH_GROUP_MIN_HEIGHT = 200;
export const SUBGRAPH_GROUP_PADDING = 24;

export function elementParentId(elementId: string): string {
  return `element:${elementId}`;
}

export function findElementByGraphId(
  comp: NarrativeCompositionDef,
  graphId: string,
): CompositionElementDef | undefined {
  return comp.elements?.find((el) => el.graph?.id === graphId);
}

export function isSubgraphExpanded(elementId: string, expandedElementIds: string[]): boolean {
  return expandedElementIds.includes(elementId);
}

/** Parent-relative position for a state inside an expanded subgraph group. */
export function toParentRelativePosition(
  state: NarrativeStateNodeDef,
  index: number,
): { x: number; y: number } {
  const pos = stateEditorPosition(state, index);
  return {
    x: SUBGRAPH_CHILD_ORIGIN.x + pos.x,
    y: SUBGRAPH_CHILD_ORIGIN.y + pos.y,
  };
}

function childLayoutSize(node: CanvasNode): { width: number; height: number } {
  if (node.type === 'transitionAnchor') {
    return { width: TRANSITION_ANCHOR_SIZE, height: TRANSITION_ANCHOR_SIZE };
  }
  return { width: STATE_NODE_LAYOUT_WIDTH, height: STATE_NODE_LAYOUT_HEIGHT };
}

export function boundsFromChildNodes(children: CanvasNode[]): { width: number; height: number } {
  if (!children.length) {
    return { width: SUBGRAPH_GROUP_MIN_WIDTH, height: SUBGRAPH_GROUP_MIN_HEIGHT };
  }
  let maxRight = SUBGRAPH_CHILD_ORIGIN.x;
  let maxBottom = SUBGRAPH_CHILD_ORIGIN.y;
  for (const child of children) {
    const size = childLayoutSize(child);
    maxRight = Math.max(maxRight, child.position.x + size.width);
    maxBottom = Math.max(maxBottom, child.position.y + size.height);
  }
  return {
    width: Math.max(SUBGRAPH_GROUP_MIN_WIDTH, maxRight + SUBGRAPH_GROUP_PADDING),
    height: Math.max(SUBGRAPH_GROUP_MIN_HEIGHT, maxBottom + SUBGRAPH_GROUP_PADDING),
  };
}

export function computeSubgraphGroupBounds(graph: NarrativeGraphDef): { width: number; height: number } {
  const pseudoChildren: CanvasNode[] = Object.entries(graph.states ?? {}).map(([sid, state], index) => {
    const stateIndex = Object.keys(graph.states ?? {}).indexOf(sid);
    return {
      id: sid,
      type: 'state',
      position: toParentRelativePosition(state, stateIndex >= 0 ? stateIndex : index),
      data: { label: '', subtitle: '', kind: 'state' },
    } as CanvasNode;
  });
  return boundsFromChildNodes(pseudoChildren);
}

function parentStyleSize(parent: CanvasNode): { width: number; height: number } {
  return {
    width: Number(parent.style?.width ?? SUBGRAPH_GROUP_MIN_WIDTH),
    height: Number(parent.style?.height ?? SUBGRAPH_GROUP_MIN_HEIGHT),
  };
}

/**
 * Grow parent groups before RF applies child position so extent:parent does not clamp outward drags.
 */
export function expandParentsForPositionChanges(
  nodes: CanvasNode[],
  changes: NodeChange<CanvasNode>[],
): CanvasNode[] {
  let next = nodes;
  for (const change of changes) {
    if (change.type !== 'position' || !change.position) continue;
    const child = next.find((node) => node.id === change.id);
    if (!child?.parentId) continue;
    const parent = next.find((node) => node.id === child.parentId);
    if (!parent || parent.type !== 'subgraphGroup') continue;

    const children = next
      .filter((node) => node.parentId === parent.id)
      .map((node) => (node.id === change.id ? { ...node, position: change.position } : node));

    const needed = boundsFromChildNodes(children);
    const current = parentStyleSize(parent);
    if (needed.width <= current.width && needed.height <= current.height) continue;

    next = next.map((node) => (
      node.id === parent.id
        ? {
            ...node,
            style: {
              ...node.style,
              width: Math.max(current.width, needed.width),
              height: Math.max(current.height, needed.height),
            },
          }
        : node
    ));
  }
  return next;
}

/** Recompute expanded subgraph group size from live child node positions (may shrink). */
export function resizeSubgraphParents(nodes: CanvasNode[]): CanvasNode[] {
  const parents = nodes.filter((node) => node.type === 'subgraphGroup');
  if (!parents.length) return nodes;

  const sizeByParentId = new Map<string, { width: number; height: number }>();
  for (const parent of parents) {
    const children = nodes.filter((node) => node.parentId === parent.id);
    if (!children.length) continue;
    sizeByParentId.set(parent.id, boundsFromChildNodes(children));
  }

  if (!sizeByParentId.size) return nodes;

  return nodes.map((node) => {
    const size = sizeByParentId.get(node.id);
    if (!size) return node;
    return {
      ...node,
      style: {
        ...node.style,
        width: size.width,
        height: size.height,
      },
    };
  });
}

/** Collapsed subgraphs: map inner transition anchors to the wrapper element node. */
export function resolveProjectionCanvasEndpoint(
  endpoint: string,
  comp: NarrativeCompositionDef,
  expandedElementIds: string[],
): string {
  const parsed = parseTransitionAnchorId(endpoint);
  if (!parsed) return endpoint;
  const element = findElementByGraphId(comp, parsed.graphId);
  if (!element || !isSubgraphElement(element)) return endpoint;
  if (isSubgraphExpanded(element.id, expandedElementIds)) return endpoint;
  return elementParentId(element.id);
}

export function findTransitionByAnchorId(
  comp: NarrativeCompositionDef,
  anchorNodeId: string,
): null | { element: CompositionElementDef; transition: NarrativeTransitionDef } {
  const parsed = parseTransitionAnchorId(anchorNodeId);
  if (!parsed) return null;
  const element = findElementByGraphId(comp, parsed.graphId);
  if (!element?.graph) return null;
  const transition = element.graph.transitions?.find((t) => t.id === parsed.transitionId);
  if (!transition) return null;
  return { element, transition };
}
