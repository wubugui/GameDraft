import { describe, expect, it } from 'vitest';
import { resolveActiveGraphView } from './activeGraphView';
import { legacyNodeIdForEndpoint, resolveCanvasEndpoint } from './endpointResolution';
import type { NarrativeCompositionDef } from '../types';

const comp: NarrativeCompositionDef = {
  id: 'c',
  mainGraph: {
    id: 'flow',
    ownerType: 'flow',
    initialState: 'a',
    states: { a: { id: 'a' }, b: { id: 'b' } },
    transitions: [],
  },
  elements: [
    {
      id: 'wrap',
      kind: 'wrapperGraph',
      graph: {
        id: 'npc',
        ownerType: 'npc',
        initialState: 's1',
        states: { s1: { id: 's1' }, s2: { id: 's2' } },
        transitions: [],
      },
    },
  ],
};

describe('endpointResolution', () => {
  it('legacy and resolveCanvasEndpoint match on composition main view', () => {
    const view = resolveActiveGraphView(comp, 'main')!;
    const ctx = { view, expandedElementIds: [] as string[] };
    const cases: Array<[string, string]> = [
      ['a', 'flow'],
      ['s1', 'npc'],
    ];
    for (const [stateId, ownerGraphId] of cases) {
      const endpoint = stateId;
      expect(resolveCanvasEndpoint(endpoint, ownerGraphId, ctx)).toBe(
        legacyNodeIdForEndpoint(endpoint, ownerGraphId, comp, []),
      );
    }
  });

  it('legacy and resolveCanvasEndpoint match when subgraph expanded', () => {
    const view = resolveActiveGraphView(comp, 'main')!;
    const expanded = ['wrap'];
    const ctx = { view, expandedElementIds: expanded };
    expect(resolveCanvasEndpoint('s1', 'npc', ctx)).toBe(
      legacyNodeIdForEndpoint('s1', 'npc', comp, expanded),
    );
  });

  it('exclusive view maps active graph endpoints to state nodes', () => {
    const view = resolveActiveGraphView(comp, 'element:wrap')!;
    const ctx = { view, expandedElementIds: [] as string[] };
    expect(resolveCanvasEndpoint('s1', 'npc', ctx)).toBe('state:s1');
    expect(resolveCanvasEndpoint('s2', 'npc', ctx)).toBe('state:s2');
  });
});
