import { MarkerType } from '@xyflow/react';
import { transitionAnchorId } from '../anchorCodec';
import { stateEditorPosition } from '../editorModel';
import type { CanvasMode } from '../types/canvas';
import type {
  CanvasEdge,
  CanvasNode,
  NarrativeCompositionDef,
  NarrativeGraphDef,
} from '../types';
import type { ActiveGraphView } from './activeGraphView';
import type { CanvasIdScope } from './canvasIdScope';
import { resolveCanvasEndpoint, type EndpointResolutionContext } from './endpointResolution';
import { transitionAnchorPositionFromNodes } from './transitionAnchorLayout';

export type GraphLayerInput = {
  graph: NarrativeGraphDef;
  scope: CanvasIdScope;
  activeStates: Record<string, string>;
  canvasMode: CanvasMode;
  endpointCtx: EndpointResolutionContext;
  includeGraphAnchor?: boolean;
  graphAnchorLabel?: string;
};

function showProjection(canvasMode: CanvasMode): boolean {
  return canvasMode === 'wiring' || canvasMode === 'debug';
}

function scenarioBoundaryKind(graph: NarrativeGraphDef, stateId: string): 'entry' | 'exit' | 'entryExit' | undefined {
  if (graph.ownerType !== 'scenario' && !graph.entryState && !graph.exitStates?.length) return undefined;
  const isEntry = graph.entryState === stateId;
  const isExit = (graph.exitStates ?? []).includes(stateId);
  if (isEntry && isExit) return 'entryExit';
  if (isEntry) return 'entry';
  if (isExit) return 'exit';
  return undefined;
}

export function buildGraphStateNodes(input: GraphLayerInput): CanvasNode[] {
  const { graph, scope, activeStates } = input;
  return Object.entries(graph.states ?? {}).map(([sid, state], index) => ({
    id: scope.stateNodeId(sid),
    type: 'state',
    position: stateEditorPosition(state, index),
    zIndex: 20,
    deletable: true,
    data: {
      label: state.label || sid,
      subtitle: `状态 / ${sid}`,
      kind: 'state' as const,
      boundary: scenarioBoundaryKind(graph, sid),
      active: activeStates[graph.id] === sid,
    },
  }));
}

export function buildGraphTransitionEdges(input: GraphLayerInput): CanvasEdge[] {
  const { graph, scope, endpointCtx } = input;
  return (graph.transitions ?? []).map((t) => {
    const base: CanvasEdge = {
      id: scope.transitionEdgeId(t.id),
      source: resolveCanvasEndpoint(t.from, graph.id, endpointCtx),
      target: resolveCanvasEndpoint(t.to, graph.id, endpointCtx),
      type: 'transition',
      label: t.signal,
      interactionWidth: 24,
      zIndex: 25,
      markerEnd: { type: MarkerType.ArrowClosed },
      data: { edgeKind: 'transition', label: t.signal, detail: `${graph.id}.${t.id}` },
    };
    // Style reactive transitions distinctly
    if (t.trigger === 'reactive') {
      base.style = { stroke: '#9333ea', strokeDasharray: '6 3' };
    } else if (t.trigger === 'reactiveAll') {
      base.style = { stroke: '#16a34a', strokeDasharray: '6 3' };
    } else if (t.trigger === 'reactiveAny') {
      base.style = { stroke: '#ea580c', strokeDasharray: '6 3' };
    }
    return base;
  });
}

export function buildGraphTransitionAnchorNodes(
  graph: NarrativeGraphDef,
  comp: NarrativeCompositionDef,
  expandedElementIds: string[],
  canvasNodes: CanvasNode[],
  options?: { parentId?: string; endpointCtx: EndpointResolutionContext },
): CanvasNode[] {
  const nodeById = new Map(canvasNodes.map((node) => [node.id, node]));
  const out: CanvasNode[] = [];
  const parentId = options?.parentId;
  const endpointCtx = options?.endpointCtx;
  if (!endpointCtx) return out;

  for (const [index, transition] of (graph.transitions ?? []).entries()) {
    const sourceId = resolveCanvasEndpoint(transition.from, graph.id, endpointCtx);
    const targetId = resolveCanvasEndpoint(transition.to, graph.id, endpointCtx);
    const sourceNode = nodeById.get(sourceId);
    const targetNode = nodeById.get(targetId);
    let position: { x: number; y: number };
    if (sourceNode && targetNode) {
      position = transitionAnchorPositionFromNodes(sourceNode, targetNode, nodeById, parentId);
    } else {
      position = { x: 160 + index * 36, y: 72 + index * 42 };
    }
    const anchor: CanvasNode = {
      id: transitionAnchorId(graph.id, transition.id),
      type: 'transitionAnchor',
      position,
      draggable: false,
      deletable: false,
      selectable: true,
      data: {
        label: transition.signal || transition.id,
        subtitle: '触发点',
        kind: 'transitionAnchor',
        detail: transition.signal,
      },
    };
    if (parentId) {
      anchor.parentId = parentId;
      anchor.extent = 'parent';
      anchor.expandParent = true;
      anchor.zIndex = 25;
    } else {
      anchor.zIndex = 20;
    }
    out.push(anchor);
  }
  return out;
}

export function buildGraphLayer(input: GraphLayerInput & { includeTransitionAnchors?: boolean }): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const { graph, activeStates, canvasMode, includeGraphAnchor, includeTransitionAnchors } = input;
  const stateNodes = buildGraphStateNodes(input);
  const nodes: CanvasNode[] = [...stateNodes];

  if (includeGraphAnchor) {
    nodes.unshift({
      id: `graph:${graph.id}`,
      type: 'graphAnchor',
      position: { x: -260, y: -80 },
      zIndex: 20,
      draggable: false,
      deletable: false,
      data: {
        label: graph.label || graph.id,
        subtitle: '主图',
        kind: 'graphAnchor',
        detail: graph.id,
        active: Boolean(activeStates[graph.id]),
      },
    });
  }

  const edges = buildGraphTransitionEdges(input);

  if (includeTransitionAnchors && showProjection(canvasMode)) {
    const anchors = buildGraphTransitionAnchorNodes(
      graph,
      input.endpointCtx.view.comp,
      input.endpointCtx.expandedElementIds,
      nodes,
      { endpointCtx: input.endpointCtx },
    );
    nodes.push(...anchors);
  }

  return { nodes, edges };
}

export function buildExclusiveGraphLayer(
  view: Extract<ActiveGraphView, { kind: 'graphExclusive' }>,
  activeStates: Record<string, string>,
  canvasMode: CanvasMode,
  expandedElementIds: string[],
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const endpointCtx: EndpointResolutionContext = { view, expandedElementIds };
  return buildGraphLayer({
    graph: view.graph,
    scope: view.scope,
    activeStates,
    canvasMode,
    endpointCtx,
    includeGraphAnchor: false,
    includeTransitionAnchors: true,
  });
}
