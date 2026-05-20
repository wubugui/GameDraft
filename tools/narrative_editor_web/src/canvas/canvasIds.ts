import type { CompositionElementDef } from '../types';

export function inlineSubgraphStateId(elementId: string, stateId: string): string {
  return `subgraph:${elementId}:state:${stateId}`;
}

export function inlineSubgraphTransitionId(elementId: string, transitionId: string): string {
  return `subgraph:${elementId}:transition:${transitionId}`;
}

export function parseInlineSubgraphId(id: string): null | { elementId: string; kind: 'state' | 'transition'; objectId: string } {
  const match = /^subgraph:([^:]+):(state|transition):(.+)$/.exec(id);
  if (!match) return null;
  return { elementId: match[1], kind: match[2] as 'state' | 'transition', objectId: match[3] };
}

export function prefixInlineSelection(elementId: string, id: string): string {
  if (id.startsWith('state:')) return inlineSubgraphStateId(elementId, id.slice('state:'.length));
  if (id.startsWith('transition:')) return inlineSubgraphTransitionId(elementId, id.slice('transition:'.length));
  return id;
}

export function inlineSubgraphBase(element: CompositionElementDef): { x: number; y: number } {
  return {
    x: Number(element.x ?? 0) + 24,
    y: Number(element.y ?? 0) + 150,
  };
}

export function projectionEndpointLabel(endpoint: string): string {
  if (endpoint.startsWith('graph:')) return endpoint.slice('graph:'.length);
  if (endpoint.startsWith('state:')) return endpoint.slice('state:'.length);
  if (endpoint.startsWith('element:')) return endpoint.slice('element:'.length);
  return endpoint.replace(/^projection-anchor:/, '').replace(/^external:/, '');
}
