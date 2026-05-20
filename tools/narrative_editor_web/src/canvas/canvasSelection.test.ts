import { describe, expect, it } from 'vitest';
import { applyCanvasSelection } from './canvasSelection';
import type { CanvasEdge, CanvasNode } from '../types';

describe('applyCanvasSelection', () => {
  const nodes: CanvasNode[] = [
    {
      id: 'state:a',
      type: 'state',
      position: { x: 0, y: 0 },
      data: { label: 'a', subtitle: '', kind: 'state' },
    },
    {
      id: 'subgraph:wrap:state:b',
      type: 'state',
      position: { x: 40, y: 80 },
      data: { label: 'b', subtitle: '', kind: 'state' },
    },
  ];

  const edges: CanvasEdge[] = [
    {
      id: 'transition:t1',
      source: 'state:a',
      target: 'state:b',
      data: { edgeKind: 'transition', label: 'sig' },
    },
  ];

  it('marks selected node without changing position', () => {
    const { nodes: outNodes, edges: outEdges } = applyCanvasSelection(nodes, edges, 'state:a');
    expect(outNodes[0].selected).toBe(true);
    expect(outNodes[0].position).toEqual({ x: 0, y: 0 });
    expect(outNodes[1].selected).toBe(false);
    expect(outEdges[0].selected).toBe(false);
  });

  it('marks selected transition edge', () => {
    const { edges: outEdges } = applyCanvasSelection(nodes, edges, 'transition:t1');
    expect(outEdges[0].selected).toBe(true);
  });
});
