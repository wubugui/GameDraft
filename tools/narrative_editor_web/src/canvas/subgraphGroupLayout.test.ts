import { describe, expect, it } from 'vitest';
import {
  computeSubgraphGroupBounds,
  elementParentId,
  expandParentsForPositionChanges,
  resizeSubgraphParents,
  resolveProjectionCanvasEndpoint,
  SUBGRAPH_CHILD_ORIGIN,
} from './subgraphGroupLayout';
import type { CanvasNode } from '../types';
import type { NarrativeCompositionDef } from '../types';

const comp: NarrativeCompositionDef = {
  id: 'c',
  mainGraph: { id: 'main', ownerType: 'flow', initialState: 'a', states: { a: { id: 'a' } }, transitions: [] },
  elements: [
    {
      id: 'wrap',
      kind: 'wrapperGraph',
      graph: {
        id: 'inner',
        ownerType: 'npc',
        initialState: 's1',
        states: {
          s1: { id: 's1', meta: { editor: { x: 0, y: 0 } } },
          s2: { id: 's2', meta: { editor: { x: 200, y: 40 } } },
        },
        transitions: [{ id: 't1', from: 's1', to: 's2', signal: 'sig' }],
      },
    },
  ],
};

describe('subgraphGroupLayout', () => {
  it('maps collapsed inner transition anchor to element node', () => {
    const endpoint = 'transition-anchor:inner:t1';
    expect(resolveProjectionCanvasEndpoint(endpoint, comp, [])).toBe(elementParentId('wrap'));
  });

  it('keeps inner transition anchor when subgraph expanded', () => {
    const endpoint = 'transition-anchor:inner:t1';
    expect(resolveProjectionCanvasEndpoint(endpoint, comp, ['wrap'])).toBe(endpoint);
  });

  it('computes group bounds from child states', () => {
    const bounds = computeSubgraphGroupBounds(comp.elements![0].graph!);
    expect(bounds.width).toBeGreaterThanOrEqual(280);
    expect(bounds.height).toBeGreaterThanOrEqual(200);
  });

  it('uses legacy inline-compatible child origin', () => {
    expect(SUBGRAPH_CHILD_ORIGIN).toEqual({ x: 24, y: 150 });
  });

  it('expandParentsForPositionChanges grows parent before child position is clamped', () => {
    const nodes: CanvasNode[] = [
      {
        id: 'element:wrap',
        type: 'subgraphGroup',
        position: { x: 0, y: 0 },
        style: { width: 280, height: 200 },
        data: { label: 'wrap', subtitle: '', kind: 'wrapperGraph' },
      },
      {
        id: 'subgraph:wrap:state:s1',
        type: 'state',
        parentId: 'element:wrap',
        position: { x: 24, y: 150 },
        data: { label: 's1', subtitle: '', kind: 'state' },
      },
    ];
    const expanded = expandParentsForPositionChanges(nodes, [
      {
        id: 'subgraph:wrap:state:s1',
        type: 'position',
        position: { x: 400, y: 350 },
      },
    ]);
    const parent = expanded.find((n) => n.id === 'element:wrap');
    expect(parent?.style?.width).toBeGreaterThan(280);
    expect(parent?.style?.height).toBeGreaterThan(200);
  });

  it('resizeSubgraphParents expands parent to fit dragged children', () => {
    const nodes: CanvasNode[] = [
      {
        id: 'element:wrap',
        type: 'subgraphGroup',
        position: { x: 0, y: 0 },
        style: { width: 280, height: 200 },
        data: { label: 'wrap', subtitle: '', kind: 'wrapperGraph' },
      },
      {
        id: 'subgraph:wrap:state:s1',
        type: 'state',
        parentId: 'element:wrap',
        position: { x: SUBGRAPH_CHILD_ORIGIN.x, y: SUBGRAPH_CHILD_ORIGIN.y },
        data: { label: 's1', subtitle: '', kind: 'state' },
      },
      {
        id: 'subgraph:wrap:state:s2',
        type: 'state',
        parentId: 'element:wrap',
        position: { x: 400, y: 300 },
        data: { label: 's2', subtitle: '', kind: 'state' },
      },
    ];
    const resized = resizeSubgraphParents(nodes);
    const parent = resized.find((n) => n.id === 'element:wrap');
    expect(parent?.style?.width).toBeGreaterThan(400);
    expect(parent?.style?.height).toBeGreaterThan(300);
  });
});
