import { parseInlineSubgraphId } from '../canvas/canvasIds';
import {
  getComposition,
  resolveEndpoint,
  type GraphRef,
} from '../editorModel';
import type {
  AuthoringCatalogDef,
  CompositionElementDef,
  NarrativeCompositionDef,
  NarrativeGraphDef,
  NarrativeGraphsFileDef,
  NarrativeTransitionDef,
  ProjectionEdgeDef,
  ProjectionResult,
  RuntimeDebugSnapshotDef,
} from '../types';

export function extractActiveStates(runtimeSnapshot: RuntimeDebugSnapshotDef): Record<string, string> | null {
  if (!runtimeSnapshot.ok || !runtimeSnapshot.snapshot || typeof runtimeSnapshot.snapshot !== 'object') return null;
  const snap = runtimeSnapshot.snapshot as { narrativeState?: { activeStates?: Record<string, string> } };
  return snap.narrativeState?.activeStates ?? null;
}

export function findGraphById(comp: NarrativeCompositionDef | undefined, graphId: string): NarrativeGraphDef | undefined {
  if (!comp) return undefined;
  if (comp.mainGraph.id === graphId) return comp.mainGraph;
  return comp.elements?.find((el) => el.graph?.id === graphId)?.graph;
}

export function removeTransitionsReferencingState(comp: NarrativeCompositionDef, targetGraphId: string, stateId: string): void {
  const graphs = [
    comp.mainGraph,
    ...(comp.elements ?? []).map((el) => el.graph).filter((graph): graph is NarrativeGraphDef => Boolean(graph)),
  ];
  for (const graph of graphs) {
    graph.transitions = (graph.transitions ?? []).filter((transition) => {
      const from = resolveEndpoint(transition.from, graph.id);
      const to = resolveEndpoint(transition.to, graph.id);
      return !(from.graphId === targetGraphId && from.stateId === stateId)
        && !(to.graphId === targetGraphId && to.stateId === stateId);
    });
  }
}

export function findProjectionEdge(projection: ProjectionResult, edgeId: string): ProjectionEdgeDef | undefined {
  return [...projection.triggerEdges, ...projection.readEdges, ...(projection.stateCommandEdges ?? [])]
    .find((edge) => edge.id === edgeId);
}

export function transitionIn(graph: NarrativeGraphDef, transitionId: string): NarrativeTransitionDef {
  const transition = graph.transitions.find((t) => t.id === transitionId);
  if (!transition) throw new Error(`Transition not found: ${transitionId}`);
  return transition;
}

export function updateElement(
  updateData: (updater: (next: NarrativeGraphsFileDef) => void) => void,
  composition: NarrativeCompositionDef | undefined,
  elementId: string,
  updater: (element: CompositionElementDef) => void,
): void {
  updateData((next) => {
    const comp = getComposition(next, composition?.id ?? '');
    const element = comp?.elements?.find((el) => el.id === elementId);
    if (element) updater(element);
  });
}

export function ownerChoicesForGraph(graph: NarrativeGraphDef, catalog: AuthoringCatalogDef): string[] {
  const ownerType = graph.ownerType?.trim();
  if (ownerType === 'quest') return catalog.questIds;
  if (ownerType === 'dialogue') return catalog.dialogueGraphIds;
  if (ownerType === 'minigame') return catalog.minigameIds;
  if (ownerType === 'cutscene') return catalog.cutsceneIds;
  if (ownerType === 'zone') return catalog.zoneRefs;
  if (ownerType === 'scenario') return catalog.scenarioIds;
  if (ownerType === 'flow') return catalog.scenarioIds;
  return catalog.sceneEntityRefs;
}

export function ownerChoicesFor(element: CompositionElementDef, catalog: AuthoringCatalogDef): string[] {
  if (element.kind === 'dialogueBlackbox') return catalog.dialogueGraphIds;
  if (element.kind === 'scenarioSubgraph') return catalog.scenarioIds;
  if (element.kind === 'zoneBlackbox') return catalog.zoneRefs;
  if (element.kind === 'minigameBlackbox') return catalog.minigameIds;
  if (element.kind === 'cutsceneBlackbox') return catalog.cutsceneIds;
  if (element.ownerType === 'quest') return catalog.questIds;
  if (element.ownerType === 'dialogue') return catalog.dialogueGraphIds;
  if (element.ownerType === 'minigame') return catalog.minigameIds;
  if (element.ownerType === 'cutscene') return catalog.cutsceneIds;
  if (element.ownerType === 'zone') return catalog.zoneRefs;
  if (element.ownerType === 'scenario') return catalog.scenarioIds;
  return catalog.sceneEntityRefs;
}

export function navigationForElement(el?: CompositionElementDef): null | { kind: string; id: string } {
  if (!el) return null;
  if (el.kind === 'dialogueBlackbox' && el.refId) return { kind: 'dialogue', id: el.refId };
  if (el.kind === 'scenarioSubgraph' && (el.refId || el.ownerId)) return { kind: 'scenario', id: el.refId || el.ownerId! };
  if (el.kind === 'zoneBlackbox' && el.refId) return { kind: 'sceneEntity', id: el.refId };
  if (el.kind === 'minigameBlackbox' && el.refId) return { kind: 'minigame', id: el.refId };
  if (el.kind === 'cutsceneBlackbox' && el.refId) return { kind: 'cutscene', id: el.refId };
  if (el.kind === 'wrapperGraph' && el.ownerType === 'quest' && el.ownerId) return { kind: 'quest', id: el.ownerId };
  if (el.kind === 'wrapperGraph' && el.ownerId) return { kind: 'sceneEntity', id: el.ownerId };
  return null;
}

export function elementSubtitle(el?: CompositionElementDef): string {
  if (!el) return '';
  if (el.kind === 'wrapperGraph') return `实体包装 / ${el.ownerType || 'entity'}`;
  if (el.kind === 'scenarioSubgraph') return 'Scenario 子图';
  if (el.kind === 'dialogueBlackbox') return '对话黑盒';
  if (el.kind === 'zoneBlackbox') return '区域黑盒';
  if (el.kind === 'minigameBlackbox') return '小游戏黑盒';
  return '过场黑盒';
}

export function isSelectionDeletable(selectedId: string, graphRef: GraphRef): boolean {
  return (
    parseInlineSubgraphId(selectedId) !== null
    || selectedId.startsWith('state:')
    || selectedId.startsWith('transition:')
    || (graphRef === 'main' && selectedId.startsWith('element:'))
  );
}
