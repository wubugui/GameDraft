import { MarkerType } from '@xyflow/react';
import { graphDisplayName, isSubgraphElement, stateDisplayName } from '../editorModel';
import type { CanvasMode } from '../types/canvas';
import type {
  CanvasEdge,
  CanvasNode,
  CompositionElementDef,
  NarrativeCompositionDef,
  NarrativeGraphDef,
  ProjectionEdgeDef,
  ProjectionResult,
} from '../types';
import type { CompositionMainView } from './activeGraphView';
import { createInlineSubgraphScope } from './canvasIdScope';
import { inlineSubgraphTransitionId, projectionEndpointLabel } from './canvasIds';
import { resolveCanvasEndpoint, type EndpointResolutionContext } from './endpointResolution';
import {
  buildGraphTransitionAnchorNodes,
  buildGraphTransitionEdges,
} from './buildGraphLayer';
import {
  computeSubgraphGroupBounds,
  elementParentId,
  resizeSubgraphParents,
  resolveProjectionCanvasEndpoint,
  toParentRelativePosition,
} from './subgraphGroupLayout';
import { stateIndexInGraph } from './transitionAnchorLayout';
import { transitionAnchorId } from '../anchorCodec';

export type CompositionOverlayInput = {
  view: CompositionMainView;
  graphNodes: CanvasNode[];
  graphEdges: CanvasEdge[];
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

/**
 * 投影端点浮标节点。合成组合主视图与图独占视图各有一份完全相同的锚点节点构造
 * （仅端点解析方式不同），抽出为单一来源，避免网格/样式在两处漂移。
 */
export function buildProjectionAnchorNode(endpoint: string, index: number): CanvasNode {
  return {
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
  if (el.kind === 'wrapperGraph') {
    const category = el.graph?.category?.trim();
    return category
      ? `实体包装 / ${el.ownerType || 'entity'} / ${category}`
      : `实体包装 / ${el.ownerType || 'entity'}`;
  }
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

export function visibleProjectionEdgesForComposition(
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

/**
 * 由「已解析好的 source/target 端点」构造一条投影 CanvasEdge。
 * 合成主视图（toProjectionEdge）与图独占视图（buildExclusiveProjection）此前各写一份完全相同的
 * 边构造 + edgeColor，抽为单一来源；两者只是端点解析方式不同，解析后交给它统一产出。
 */
export function buildProjectionCanvasEdge(
  edge: ProjectionEdgeDef,
  kind: string,
  source: string,
  target: string,
): CanvasEdge {
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
    markerEnd: { type: MarkerType.ArrowClosed, color: edgeColor(kind) },
    data: { edgeKind: kind, label: edge.label, detail: edge.detail ?? edge.id },
  };
}

function toProjectionEdge(
  edge: ProjectionEdgeDef,
  kind: 'trigger' | 'read' | 'stateCommand',
  comp: NarrativeCompositionDef,
  expandedElementIds: string[],
): CanvasEdge {
  return buildProjectionCanvasEdge(
    edge,
    kind,
    resolveProjectionCanvasEndpoint(edge.source, comp, expandedElementIds),
    resolveProjectionCanvasEndpoint(edge.target, comp, expandedElementIds),
  );
}

function buildElementOverlayNodes(
  comp: NarrativeCompositionDef,
  activeStates: Record<string, string>,
  expandedElementIds: string[],
): { elementNodes: CanvasNode[]; subgraphChildren: CanvasNode[] } {
  const elementNodes: CanvasNode[] = [];
  const subgraphChildren: CanvasNode[] = [];

  for (const [index, el] of (comp.elements ?? []).entries()) {
    const parentId = elementParentId(el.id);
    const expanded = expandedElementIds.includes(el.id) && isSubgraphElement(el) && Boolean(el.graph);
    const elementDisplayName = el.graph ? graphDisplayName(el.graph) : (el.label || el.id);

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
          label: elementDisplayName,
          subtitle: elementSubtitle(el),
          kind: el.kind,
          detail: el.graph.id,
          active: Boolean(activeStates[el.graph.id] && activeStates[el.graph.id] !== el.graph.initialState),
        },
      });

      for (const [sid, state] of Object.entries(el.graph.states ?? {})) {
        const stateIndex = stateIndexInGraph(el.graph, sid);
        subgraphChildren.push({
          id: createInlineSubgraphScope(el.id, el.graph.id).stateNodeId(sid),
          type: 'state',
          parentId,
          extent: 'parent',
          expandParent: true,
          position: toParentRelativePosition(state, stateIndex),
          zIndex: 20,
          deletable: true,
          data: {
            label: stateDisplayName(state, sid),
            subtitle: `${elementDisplayName} / ${sid}`,
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
        label: elementDisplayName,
        subtitle: elementSubtitle(el),
        kind: el.kind,
        detail: el.refId || el.ownerId || el.graph?.id || '',
        active: Boolean(el.graph && activeStates[el.graph.id] && activeStates[el.graph.id] !== el.graph.initialState),
      },
    });
  }

  return { elementNodes, subgraphChildren };
}

export function buildCompositionOverlay(input: CompositionOverlayInput): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const {
    view, graphNodes, graphEdges, activeStates, projection, canvasMode,
    showTrigger, showRead, showCommand, expandedElementIds,
  } = input;
  const comp = view.comp;
  const graph = view.graph;
  const endpointCtx: EndpointResolutionContext = { view, expandedElementIds };

  const { elementNodes, subgraphChildren } = buildElementOverlayNodes(comp, activeStates, expandedElementIds);
  const wiring = showProjection(canvasMode);

  const structureWithoutAnchors = [...graphNodes, ...elementNodes, ...subgraphChildren];
  const transitionAnchors = wiring
    ? [
      ...buildGraphTransitionAnchorNodes(graph, comp, expandedElementIds, structureWithoutAnchors, { endpointCtx }),
      ...buildInlineTransitionAnchors(comp, expandedElementIds, structureWithoutAnchors, endpointCtx),
    ]
    : [];

  let nodes = [...structureWithoutAnchors, ...transitionAnchors];
  nodes = resizeSubgraphParents(nodes);

  const inlineTransitionEdges = buildInlineTransitionEdges(comp, expandedElementIds, endpointCtx);
  let edges = [...graphEdges, ...inlineTransitionEdges];

  if (!wiring) {
    return { nodes, edges };
  }

  const projectionEdges = visibleProjectionEdgesForComposition(
    comp, projection, showTrigger, showRead, showCommand,
  ).map((edge) => toProjectionEdge(edge, edge.kind, comp, expandedElementIds));

  edges = [...edges, ...projectionEdges.filter((e) => e.source && e.target)];

  const knownIds = new Set(nodes.map((node) => node.id));
  const anchors: CanvasNode[] = [];
  const visibleExternalEdges = visibleProjectionEdgesForComposition(
    comp, projection, showTrigger, showRead, showCommand,
  );
  for (const edge of visibleExternalEdges) {
    for (const rawEndpoint of [edge.source, edge.target]) {
      if (!rawEndpoint) continue;
      const endpoint = resolveProjectionCanvasEndpoint(rawEndpoint, comp, expandedElementIds);
      if (knownIds.has(endpoint)) continue;
      if (endpoint.startsWith('transition-anchor:')) continue;
      knownIds.add(endpoint);
      anchors.push(buildProjectionAnchorNode(endpoint, anchors.length));
    }
  }

  return { nodes: [...nodes, ...anchors], edges };
}

function buildInlineTransitionAnchors(
  comp: NarrativeCompositionDef,
  expandedElementIds: string[],
  canvasNodes: CanvasNode[],
  endpointCtx: EndpointResolutionContext,
): CanvasNode[] {
  const out: CanvasNode[] = [];
  for (const element of comp.elements ?? []) {
    if (!expandedElementIds.includes(element.id) || !isSubgraphElement(element) || !element.graph) continue;
    out.push(...buildGraphTransitionAnchorNodes(
      element.graph,
      comp,
      expandedElementIds,
      canvasNodes,
      { parentId: elementParentId(element.id), endpointCtx },
    ));
  }
  return out;
}

function buildInlineTransitionEdges(
  comp: NarrativeCompositionDef,
  expandedElementIds: string[],
  endpointCtx: EndpointResolutionContext,
): CanvasEdge[] {
  const out: CanvasEdge[] = [];
  for (const el of comp.elements ?? []) {
    if (!expandedElementIds.includes(el.id) || !isSubgraphElement(el) || !el.graph) continue;
    for (const t of el.graph.transitions ?? []) {
      out.push({
        id: inlineSubgraphTransitionId(el.id, t.id),
        source: resolveCanvasEndpoint(t.from, el.graph.id, endpointCtx),
        target: resolveCanvasEndpoint(t.to, el.graph.id, endpointCtx),
        type: 'transition',
        label: t.signal,
        interactionWidth: 24,
        markerEnd: { type: MarkerType.ArrowClosed },
        data: { edgeKind: 'transition', label: t.signal, detail: `${el.graph.id}.${t.id}` },
      });
    }
  }
  return out;
}
