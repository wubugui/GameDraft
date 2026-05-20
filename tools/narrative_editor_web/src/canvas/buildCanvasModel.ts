import { MarkerType } from '@xyflow/react';
import { transitionAnchorId } from '../anchorCodec';
import {
  isSubgraphElement,
  resolveEndpoint,
  stateEditorPosition,
  type GraphRef,
} from '../editorModel';
import type { CanvasMode } from '../types/canvas';
import type {
  CanvasEdge,
  CanvasNode,
  CompositionElementDef,
  NarrativeCompositionDef,
  NarrativeEndpointDef,
  NarrativeGraphDef,
  ProjectionEdgeDef,
  ProjectionResult,
} from '../types';
import {
  inlineSubgraphStateId,
  inlineSubgraphTransitionId,
  parseInlineSubgraphId,
  projectionEndpointLabel,
} from './canvasIds';
import {
  computeSubgraphGroupBounds,
  elementParentId,
  resizeSubgraphParents,
  resolveProjectionCanvasEndpoint,
  toParentRelativePosition,
} from './subgraphGroupLayout';
import {
  stateIndexInGraph,
  transitionAnchorPositionFromNodes,
} from './transitionAnchorLayout';

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

function showProjection(canvasMode: CanvasMode): boolean {
  return canvasMode === 'wiring' || canvasMode === 'debug';
}

export function buildCanvasNodes(input: CanvasBuildInput): CanvasNode[] {
  const {
    comp, graph, graphRef, activeStates, canvasMode,
    showTrigger, showRead, showCommand, expandedElementIds,
  } = input;

  const states: CanvasNode[] = Object.entries(graph.states ?? {}).map(([sid, state], index) => ({
    id: `state:${sid}`,
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

  if (graphRef !== 'main') return states;

  const graphAnchor: CanvasNode = {
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
  };

  const elementNodes: CanvasNode[] = [];
  const subgraphChildren: CanvasNode[] = [];

  for (const [index, el] of (comp.elements ?? []).entries()) {
    const parentId = elementParentId(el.id);
    const expanded = expandedElementIds.includes(el.id) && isSubgraphElement(el) && Boolean(el.graph);

    if (expanded && el.graph) {
      const bounds = computeSubgraphGroupBounds(el.graph);
      elementNodes.push({
        id: parentId,
        type: 'subgraphGroup',
        position: { x: Number(el.x ?? 120 + index * 220), y: Number(el.y ?? 40) },
        style: { width: bounds.width, height: bounds.height },
        dragHandle: '.subgraph-group-header',
        zIndex: 10,
        draggable: true,
        deletable: false,
        data: {
          label: el.label || el.id,
          subtitle: elementSubtitle(el),
          kind: el.kind,
          detail: el.graph.id,
          active: Boolean(activeStates[el.graph.id] && activeStates[el.graph.id] !== el.graph.initialState),
        },
      });

      for (const [sid, state] of Object.entries(el.graph.states ?? {})) {
        const stateIndex = stateIndexInGraph(el.graph, sid);
        subgraphChildren.push({
          id: inlineSubgraphStateId(el.id, sid),
          type: 'state',
          parentId,
          extent: 'parent',
          expandParent: true,
          position: toParentRelativePosition(state, stateIndex),
          zIndex: 20,
          deletable: true,
          data: {
            label: state.label || sid,
            subtitle: `${el.label || el.id} / ${sid}`,
            kind: 'state' as const,
            boundary: scenarioBoundaryKind(el.graph, sid),
            detail: el.graph.id,
            active: activeStates[el.graph.id] === sid,
          },
        });
      }
      continue;
    }

    elementNodes.push({
      id: parentId,
      type: el.kind,
      position: { x: Number(el.x ?? 120 + index * 220), y: Number(el.y ?? 40) },
      zIndex: 20,
      deletable: true,
      data: {
        label: el.label || el.id,
        subtitle: elementSubtitle(el),
        kind: el.kind,
        detail: el.refId || el.ownerId || el.graph?.id || '',
        active: Boolean(el.graph && activeStates[el.graph.id] && activeStates[el.graph.id] !== el.graph.initialState),
      },
    });
  }

  const wiring = showProjection(canvasMode);
  const structureWithoutAnchors = [graphAnchor, ...states, ...elementNodes, ...subgraphChildren];
  const transitionAnchors = wiring
    ? buildTransitionAnchorNodes(comp, graph, expandedElementIds, structureWithoutAnchors)
    : [];

  let baseNodes = [...structureWithoutAnchors, ...transitionAnchors];
  baseNodes = resizeSubgraphParents(baseNodes);
  if (!wiring) return baseNodes;

  const knownIds = new Set(baseNodes.map((node) => node.id));
  const anchors: CanvasNode[] = [];
  const visibleExternalEdges = visibleProjectionEdgesForComposition(
    comp, input.projection, showTrigger, showRead, showCommand,
  );
  for (const edge of visibleExternalEdges) {
    for (const rawEndpoint of [edge.source, edge.target]) {
      if (!rawEndpoint) continue;
      const endpoint = resolveProjectionCanvasEndpoint(rawEndpoint, comp, expandedElementIds);
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
  return [...baseNodes, ...anchors];
}

export function buildCanvasEdges(input: CanvasBuildInput): CanvasEdge[] {
  const {
    comp, graph, graphRef, projection, canvasMode,
    showTrigger, showRead, showCommand, expandedElementIds,
  } = input;

  const transitionEdges: CanvasEdge[] = (graph.transitions ?? []).map((t) => ({
    id: `transition:${t.id}`,
    source: nodeIdForEndpoint(t.from, graph.id, comp, expandedElementIds),
    target: nodeIdForEndpoint(t.to, graph.id, comp, expandedElementIds),
    type: 'transition',
    label: t.signal,
    interactionWidth: 24,
    markerEnd: { type: MarkerType.ArrowClosed },
    data: { edgeKind: 'transition', label: t.signal, detail: `${graph.id}.${t.id}` },
  }));

  if (graphRef !== 'main') return transitionEdges;

  const inlineTransitionEdges: CanvasEdge[] = [];
  for (const el of comp.elements ?? []) {
    if (!expandedElementIds.includes(el.id) || !isSubgraphElement(el) || !el.graph) continue;
    for (const t of el.graph.transitions ?? []) {
      inlineTransitionEdges.push({
        id: inlineSubgraphTransitionId(el.id, t.id),
        source: nodeIdForEndpoint(t.from, el.graph.id, comp, expandedElementIds),
        target: nodeIdForEndpoint(t.to, el.graph.id, comp, expandedElementIds),
        type: 'transition',
        label: t.signal,
        interactionWidth: 24,
        markerEnd: { type: MarkerType.ArrowClosed },
        data: { edgeKind: 'transition', label: t.signal, detail: `${el.graph.id}.${t.id}` },
      });
    }
  }

  if (!showProjection(canvasMode)) {
    return [...transitionEdges, ...inlineTransitionEdges];
  }

  const projectionEdges = visibleProjectionEdgesForComposition(
    comp, projection, showTrigger, showRead, showCommand,
  ).map((edge) => toProjectionEdge(edge, edge.kind, comp, expandedElementIds));

  return [...transitionEdges, ...inlineTransitionEdges, ...projectionEdges.filter((e) => e.source && e.target)];
}

function nodeIdForEndpoint(
  endpoint: NarrativeEndpointDef,
  ownerGraphId: string,
  comp: NarrativeCompositionDef,
  expandedElementIds: string[],
): string {
  const resolved = resolveEndpoint(endpoint, ownerGraphId);
  if (resolved.graphId === comp.mainGraph.id) return `state:${resolved.stateId}`;
  const element = comp.elements?.find((el) => el.graph?.id === resolved.graphId);
  if (!element) return `projection-anchor:${resolved.graphId}.${resolved.stateId}`;
  if (expandedElementIds.includes(element.id)) return inlineSubgraphStateId(element.id, resolved.stateId);
  return elementParentId(element.id);
}

function buildTransitionAnchorNodes(
  comp: NarrativeCompositionDef,
  mainGraph: NarrativeGraphDef,
  expandedElementIds: string[],
  canvasNodes: CanvasNode[],
): CanvasNode[] {
  const nodeById = new Map(canvasNodes.map((node) => [node.id, node]));
  const out: CanvasNode[] = [];
  const addGraphAnchors = (
    g: NarrativeGraphDef,
    options?: { parentId?: string },
  ) => {
    const parentId = options?.parentId;
    for (const [index, transition] of (g.transitions ?? []).entries()) {
      const sourceId = nodeIdForEndpoint(transition.from, g.id, comp, expandedElementIds);
      const targetId = nodeIdForEndpoint(transition.to, g.id, comp, expandedElementIds);
      const sourceNode = nodeById.get(sourceId);
      const targetNode = nodeById.get(targetId);
      let position: { x: number; y: number };
      if (sourceNode && targetNode) {
        position = transitionAnchorPositionFromNodes(sourceNode, targetNode, nodeById, parentId);
      } else {
        position = { x: 160 + index * 36, y: 72 + index * 42 };
      }
      const anchor: CanvasNode = {
        id: transitionAnchorId(g.id, transition.id),
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
  };
  addGraphAnchors(mainGraph);
  for (const element of comp.elements ?? []) {
    if (expandedElementIds.includes(element.id) && isSubgraphElement(element) && element.graph) {
      addGraphAnchors(element.graph, { parentId: elementParentId(element.id) });
    }
  }
  return out;
}

function visibleProjectionEdges(
  projection: ProjectionResult,
  showTrigger: boolean,
  showRead: boolean,
  showCommand: boolean,
): ProjectionEdgeDef[] {
  return [
    ...(showTrigger ? projection.triggerEdges : []),
    ...(showRead ? projection.readEdges : []),
    ...(showCommand ? projection.stateCommandEdges ?? [] : []),
  ];
}

function visibleProjectionEdgesForComposition(
  comp: NarrativeCompositionDef,
  projection: ProjectionResult,
  showTrigger: boolean,
  showRead: boolean,
  showCommand: boolean,
): ProjectionEdgeDef[] {
  const scoped = visibleProjectionEdges(projection, showTrigger, showRead, showCommand)
    .filter((edge) => edge.compositionId === comp.id);
  if (scoped.length > 0) return scoped;

  const elementNodeIds = new Set((comp.elements ?? []).map((el) => elementParentId(el.id)));
  const transitionAnchorIds = new Set<string>();
  for (const g of [
    comp.mainGraph,
    ...(comp.elements ?? []).map((el) => el.graph).filter((g): g is NarrativeGraphDef => Boolean(g)),
  ]) {
    for (const transition of g.transitions ?? []) {
      transitionAnchorIds.add(transitionAnchorId(g.id, transition.id));
    }
  }
  return visibleProjectionEdges(projection, showTrigger, showRead, showCommand).filter((edge) => {
    if (edge.compositionId && edge.compositionId !== comp.id) return false;
    if (elementNodeIds.has(edge.source) || elementNodeIds.has(edge.target)) return true;
    if (transitionAnchorIds.has(edge.source) || transitionAnchorIds.has(edge.target)) return true;
    return false;
  });
}

function toProjectionEdge(
  edge: ProjectionEdgeDef,
  kind: 'trigger' | 'read' | 'stateCommand',
  comp: NarrativeCompositionDef,
  expandedElementIds: string[],
): CanvasEdge {
  const color = edgeColor(kind);
  const source = resolveProjectionCanvasEndpoint(edge.source, comp, expandedElementIds);
  const target = resolveProjectionCanvasEndpoint(edge.target, comp, expandedElementIds);
  return {
    id: `projection:${edge.id}`,
    source,
    target,
    type: 'projection',
    label: edge.label,
    selectable: true,
    deletable: false,
    interactionWidth: 12,
    zIndex: 0,
    markerEnd: { type: MarkerType.ArrowClosed, color },
    data: { edgeKind: kind, label: edge.label, detail: edge.detail ?? edge.id },
  };
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

function elementSubtitle(el: CompositionElementDef): string {
  if (el.kind === 'wrapperGraph') return `实体包装 / ${el.ownerType || 'entity'}`;
  if (el.kind === 'scenarioSubgraph') return 'Scenario 子图';
  if (el.kind === 'dialogueBlackbox') return '对话黑盒';
  if (el.kind === 'zoneBlackbox') return '区域黑盒';
  if (el.kind === 'minigameBlackbox') return '小游戏黑盒';
  return '过场黑盒';
}

function edgeColor(kind: string): string {
  if (kind === 'transition') return '#d9a441';
  if (kind === 'trigger') return '#45a8e5';
  if (kind === 'read') return '#79b65d';
  if (kind === 'stateCommand') return '#d94d4d';
  return '#d782d9';
}

export function stateEndpointFromNodeId(
  nodeId: string,
  comp: NarrativeCompositionDef,
  mainGraph: NarrativeGraphDef,
): null | { graphId: string; stateId: string; elementId?: string } {
  if (nodeId.startsWith('state:')) {
    return { graphId: mainGraph.id, stateId: nodeId.slice('state:'.length) };
  }
  const inline = parseInlineSubgraphId(nodeId);
  if (inline?.kind !== 'state') return null;
  const element = comp.elements?.find((el) => el.id === inline.elementId);
  if (!element?.graph) return null;
  return { graphId: element.graph.id, stateId: inline.objectId, elementId: element.id };
}
