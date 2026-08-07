import { describe, expect, it } from 'vitest';
import type { CanvasEdge, CanvasNode } from '../types';
import { transitionAnchorId } from '../anchorCodec';
import {
  alignTransitionAnchorsToDisplayEdges,
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

  describe('alignTransitionAnchorsToDisplayEdges', () => {
    const stateNode = (id: string, x: number, y: number): CanvasNode => ({
      id, type: 'state', position: { x, y }, data: { label: id, subtitle: '', kind: 'state' },
    });
    const anchorNode = (transitionId: string, x: number, y: number): CanvasNode => ({
      id: transitionAnchorId('g', transitionId),
      type: 'transitionAnchor',
      position: { x, y },
      data: { label: '', subtitle: '', kind: 'transitionAnchor' },
    });
    const transitionEdge = (id: string, source: string, target: string, hidden = false): CanvasEdge => ({
      id, source, target, hidden, data: { edgeKind: 'transition', detail: `g.${id}` },
    });

    it('边被折叠组改接到分组框后，触发点跟到新曲线上', () => {
      const frame: CanvasNode = {
        id: 'group-frame:grp',
        type: 'editorGroupFrame',
        position: { x: 900, y: 400 },
        style: { width: 160, height: 90 },
        data: { label: 'grp', subtitle: '', kind: 'editorGroupFrame' },
      };
      const nodes = [stateNode('state:a', 100, 200), frame, anchorNode('t_1', 0, 0)];
      const aligned = alignTransitionAnchorsToDisplayEdges(
        nodes,
        [transitionEdge('t_1', 'state:a', 'group-frame:grp')],
      );
      const anchor = aligned.find((n) => n.type === 'transitionAnchor')!;
      // 原位置 (0,0) 是按原始端点算的老值；对齐后必须落在 a → 分组框之间
      expect(anchor.position.x).toBeGreaterThan(200);
      expect(anchor.position.x).toBeLessThan(900);
      expect(anchor.hidden).toBeFalsy();
    });

    it('折叠框按 style 尺寸算，不吃展开时留下的 measured 旧值', () => {
      const collapsedFrame = (measuredStale: boolean): CanvasNode => ({
        id: 'group-frame:grp',
        type: 'editorGroupFrame',
        position: { x: 900, y: 400 },
        style: { width: 200, height: 68 },
        measured: measuredStale ? { width: 467, height: 333 } : { width: 200, height: 68 },
        data: { label: 'grp', subtitle: '', kind: 'editorGroupFrame' },
      });
      const posWith = (frame: CanvasNode) => {
        const nodes = [stateNode('state:a', 100, 200), frame, anchorNode('t_1', 0, 0)];
        const aligned = alignTransitionAnchorsToDisplayEdges(
          nodes,
          [transitionEdge('t_1', 'state:a', 'group-frame:grp')],
        );
        return aligned.find((n) => n.type === 'transitionAnchor')!.position;
      };
      // measured 是否过期都不该改变结果——style 才是折叠后的真实尺寸
      expect(posWith(collapsedFrame(true))).toEqual(posWith(collapsedFrame(false)));
    });

    it('边被整条隐藏（两端同在一个折叠组）→ 触发点跟着藏，不留孤点', () => {
      const nodes = [stateNode('state:a', 0, 0), stateNode('state:b', 400, 0), anchorNode('t_1', 200, 20)];
      const aligned = alignTransitionAnchorsToDisplayEdges(
        nodes,
        [transitionEdge('t_1', 'state:a', 'state:b', true)],
      );
      expect(aligned.find((n) => n.type === 'transitionAnchor')!.hidden).toBe(true);
    });

    it('压根找不到对应边的触发点也藏起来', () => {
      const nodes = [stateNode('state:a', 0, 0), anchorNode('t_gone', 200, 20)];
      expect(alignTransitionAnchorsToDisplayEdges(nodes, [])[1].hidden).toBe(true);
    });

    it('已经对齐时原样返回同一个数组（不制造多余重渲染）', () => {
      const nodes = [stateNode('state:a', 0, 0), stateNode('state:b', 400, 0), anchorNode('t_1', 0, 0)];
      const edges = [transitionEdge('t_1', 'state:a', 'state:b')];
      const aligned = alignTransitionAnchorsToDisplayEdges(nodes, edges);
      expect(aligned).not.toBe(nodes);
      // 第二遍已无位移可做 → 必须返回同一引用，否则每帧都是新数组
      expect(alignTransitionAnchorsToDisplayEdges(aligned, edges)).toBe(aligned);
    });
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
