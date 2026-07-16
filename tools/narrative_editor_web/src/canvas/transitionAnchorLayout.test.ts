import { describe, expect, it } from 'vitest';
import type { CanvasNode } from '../types';
import {
  flowAbsolutePosition,
  stateIndexInGraph,
  transitionAnchorPositionFromNodes,
  transitionAnchorPositionOnEdge,
  TRANSITION_ANCHOR_SIZE,
} from './transitionAnchorLayout';

describe('transitionAnchorLayout', () => {
  it('uses distinct state indices instead of transition index for grid fallback', () => {
    const graph = {
      id: 'g',
      states: {
        a: { id: 'a', label: 'a' },
        b: { id: 'b', label: 'b' },
        c: { id: 'c', label: 'c' },
      },
      transitions: [],
    } as unknown as Parameters<typeof stateIndexInGraph>[0];
    expect(stateIndexInGraph(graph, 'a')).toBe(0);
    expect(stateIndexInGraph(graph, 'c')).toBe(2);
  });

  it('centers anchor on horizontal edge midpoint', () => {
    const from = { x: 100, y: 200 };
    const to = { x: 400, y: 200 };
    const pos = transitionAnchorPositionOnEdge(from, to);
    const centerX = pos.x + TRANSITION_ANCHOR_SIZE / 2;
    const centerY = pos.y + TRANSITION_ANCHOR_SIZE / 2;
    expect(centerX).toBeGreaterThan(from.x + 150);
    expect(centerX).toBeLessThan(to.x);
    expect(centerY).toBeCloseTo(from.y + 58 / 2, 0);
  });

  it('uses separate endpoint heights for diagonal edges', () => {
    const flat = transitionAnchorPositionOnEdge(
      { x: 0, y: 0 },
      { x: 300, y: 0 },
      150,
      58,
      150,
      58,
    );
    const diagonal = transitionAnchorPositionOnEdge(
      { x: 0, y: 0 },
      { x: 300, y: 80 },
      150,
      58,
      150,
      80,
    );
    expect(diagonal.y).not.toBeCloseTo(flat.y, 0);
  });

  it('aligns anchor inside subgraph parent space', () => {
    const parent: CanvasNode = {
      id: 'element:wrap',
      type: 'subgraphGroup',
      position: { x: 500, y: 300 },
      data: { label: 'wrap', subtitle: '', kind: 'wrapperGraph' },
    };
    const source: CanvasNode = {
      id: 'subgraph:wrap:state:a',
      type: 'state',
      parentId: 'element:wrap',
      position: { x: 24, y: 150 },
      data: { label: 'a', subtitle: '', kind: 'state' },
    };
    const target: CanvasNode = {
      id: 'subgraph:wrap:state:b',
      type: 'state',
      parentId: 'element:wrap',
      position: { x: 244, y: 150 },
      data: { label: 'b', subtitle: '', kind: 'state' },
    };
    const nodeById = new Map<string, CanvasNode>([
      [parent.id, parent],
      [source.id, source],
      [target.id, target],
    ]);
    const pos = transitionAnchorPositionFromNodes(source, target, nodeById, 'element:wrap');
    const abs = {
      x: pos.x + flowAbsolutePosition(parent, nodeById).x,
      y: pos.y + flowAbsolutePosition(parent, nodeById).y,
    };
    const mainSpace = transitionAnchorPositionOnEdge(
      flowAbsolutePosition(source, nodeById),
      flowAbsolutePosition(target, nodeById),
    );
    expect(pos.x).toBeGreaterThan(source.position.x);
    expect(pos.x).toBeLessThan(target.position.x);
    expect(abs.x).toBeCloseTo(mainSpace.x, 0);
    expect(abs.y).toBeCloseTo(mainSpace.y, 0);
  });
});
