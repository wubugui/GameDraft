import { resolveEndpoint } from '../editorModel';
import type {
  CompositionElementDef,
  NarrativeCompositionDef,
  NarrativeEndpointDef,
  NarrativeGraphDef,
} from '../types';
import type { ActiveGraphView } from './activeGraphView';
import { inlineSubgraphStateId, parseInlineSubgraphId } from './canvasIds';
import { elementParentId } from './subgraphGroupLayout';

export type EndpointResolutionContext = {
  view: ActiveGraphView;
  expandedElementIds: string[];
};

/** Legacy behavior preserved for compositionMain regression tests. */
export function legacyNodeIdForEndpoint(
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

export function resolveCanvasEndpoint(
  endpoint: NarrativeEndpointDef,
  ownerGraphId: string,
  ctx: EndpointResolutionContext,
): string {
  const { view, expandedElementIds } = ctx;
  const resolved = resolveEndpoint(endpoint, ownerGraphId);
  const comp = view.comp;

  if (resolved.graphId === view.activeGraphId) {
    return view.scope.stateNodeId(resolved.stateId);
  }

  if (view.kind === 'graphExclusive') {
    const element = comp.elements?.find((el) => el.graph?.id === resolved.graphId);
    if (!element) return `projection-anchor:${resolved.graphId}.${resolved.stateId}`;
    if (element.id === view.element.id) {
      return view.scope.stateNodeId(resolved.stateId);
    }
    return elementParentId(element.id);
  }

  return legacyNodeIdForEndpoint(endpoint, ownerGraphId, comp, expandedElementIds);
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

export function stateEndpointFromNodeIdForView(
  nodeId: string,
  view: ActiveGraphView,
): null | { graphId: string; stateId: string; elementId?: string } {
  const parsed = view.scope.parseStateNode(nodeId);
  if (parsed) {
    return {
      graphId: view.activeGraphId,
      stateId: parsed.stateId,
      elementId: view.kind === 'graphExclusive' ? view.element.id : undefined,
    };
  }
  if (view.kind === 'compositionMain') {
    return stateEndpointFromNodeId(nodeId, view.comp, view.graph);
  }
  return null;
}

export function findElementByGraphId(
  comp: NarrativeCompositionDef,
  graphId: string,
): CompositionElementDef | undefined {
  return comp.elements?.find((el) => el.graph?.id === graphId);
}
