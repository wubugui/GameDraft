import { transitionAnchorId } from '../anchorCodec';
import {
  inlineSubgraphStateId,
  inlineSubgraphTransitionId,
  parseInlineSubgraphId,
} from './canvasIds';

export type CanvasIdScopeKind = 'local' | 'inline';

export interface CanvasIdScope {
  kind: CanvasIdScopeKind;
  graphId: string;
  elementId?: string;
  stateNodeId(stateId: string): string;
  transitionEdgeId(transitionId: string): string;
  transitionAnchorNodeId(transitionId: string): string;
  parseStateNode(nodeId: string): null | { stateId: string };
  parseTransitionEdge(edgeId: string): null | { transitionId: string };
}

export function createLocalGraphScope(graphId: string): CanvasIdScope {
  return {
    kind: 'local',
    graphId,
    stateNodeId: (stateId) => `state:${stateId}`,
    transitionEdgeId: (transitionId) => `transition:${transitionId}`,
    transitionAnchorNodeId: (transitionId) => transitionAnchorId(graphId, transitionId),
    parseStateNode: (nodeId) => {
      if (!nodeId.startsWith('state:')) return null;
      return { stateId: nodeId.slice('state:'.length) };
    },
    parseTransitionEdge: (edgeId) => {
      if (!edgeId.startsWith('transition:')) return null;
      return { transitionId: edgeId.slice('transition:'.length) };
    },
  };
}

export function createInlineSubgraphScope(elementId: string, graphId: string): CanvasIdScope {
  return {
    kind: 'inline',
    graphId,
    elementId,
    stateNodeId: (stateId) => inlineSubgraphStateId(elementId, stateId),
    transitionEdgeId: (transitionId) => inlineSubgraphTransitionId(elementId, transitionId),
    transitionAnchorNodeId: (transitionId) => transitionAnchorId(graphId, transitionId),
    parseStateNode: (nodeId) => {
      const parsed = parseInlineSubgraphId(nodeId);
      if (!parsed || parsed.kind !== 'state' || parsed.elementId !== elementId) return null;
      return { stateId: parsed.objectId };
    },
    parseTransitionEdge: (edgeId) => {
      const parsed = parseInlineSubgraphId(edgeId);
      if (!parsed || parsed.kind !== 'transition' || parsed.elementId !== elementId) return null;
      return { transitionId: parsed.objectId };
    },
  };
}
