import { describe, expect, it } from 'vitest';

import {
  applyCompositionLayout,
  applyGraphLayout,
  computeCompositionLayout,
  computeGraphLayout,
} from './autoLayout';
import type { NarrativeCompositionDef, NarrativeGraphDef } from '../types';

function cyclicGraph(): NarrativeGraphDef {
  return {
    id: 'flow',
    ownerType: 'flow',
    initialState: 'a',
    states: {
      a: { id: 'a', label: 'A', meta: { editor: { x: 999, y: 999 }, note: 'keep-me' } },
      b: { id: 'b', label: 'B', description: '保留我', onEnterActions: [{ type: 'noop' }] },
      c: { id: 'c', label: 'C' },
    },
    transitions: [
      { id: 't1', from: 'a', to: 'b', signal: 'go' },
      { id: 't2', from: 'b', to: 'c', signal: 'next' },
      { id: 't3', from: 'c', to: 'a', signal: 'loop' }, // 环
      { id: 't4', from: 'b', to: 'b', signal: 'self' }, // 自环
    ],
  };
}

function composition(): NarrativeCompositionDef {
  return {
    id: 'comp',
    mainGraph: cyclicGraph(),
    elements: [
      { id: 'el_wrap', kind: 'wrapperGraph', ownerType: 'npc', ownerId: 'scene:npc', x: 111, y: 222,
        meta: { emits: ['go'] },
        graph: { id: 'wg', ownerType: 'npc', initialState: 's0', states: { s0: { id: 's0' }, s1: { id: 's1' } }, transitions: [{ id: 'w1', from: 's0', to: 's1', signal: 'x' }] } },
      { id: 'el_dlg', kind: 'dialogueBlackbox', refId: 'dlg_1', x: 5, y: 5, meta: { reads: ['loop'] } },
      { id: 'el_orphan', kind: 'zoneBlackbox', refId: 'z_1' }, // 无关系元素
    ],
  };
}

/** 剥掉所有位置字段（meta.editor + element x/y），用于「只改坐标」不变量断言。 */
function stripPositions(comp: NarrativeCompositionDef): unknown {
  const clone = structuredClone(comp) as NarrativeCompositionDef;
  const stripGraph = (g: NarrativeGraphDef) => {
    for (const st of Object.values(g.states ?? {})) {
      if (st.meta && 'editor' in st.meta) delete (st.meta as Record<string, unknown>).editor;
      // 写坐标本就会给原本无 meta 的状态补出 meta.editor；剥掉 editor 后若 meta 空了，
      // 说明它的存在纯粹是为了承载坐标 —— 一并剥掉，才能只比较「非坐标数据」。
      if (st.meta && Object.keys(st.meta).length === 0) delete (st as unknown as Record<string, unknown>).meta;
    }
  };
  stripGraph(clone.mainGraph);
  for (const el of clone.elements ?? []) {
    delete (el as unknown as Record<string, unknown>).x;
    delete (el as unknown as Record<string, unknown>).y;
    if (el.graph) stripGraph(el.graph);
  }
  return clone;
}

describe('computeGraphLayout', () => {
  it('positions every state, distinctly, on a cyclic + self-looping graph', async () => {
    const graph = cyclicGraph();
    const pos = await computeGraphLayout(graph);
    expect([...pos.keys()].sort()).toEqual(['a', 'b', 'c']);
    const coords = [...pos.values()].map((p) => `${p.x},${p.y}`);
    expect(new Set(coords).size).toBe(3); // 无重叠
  });

  it('is deterministic (same input → same positions)', async () => {
    const a = await computeGraphLayout(cyclicGraph());
    const b = await computeGraphLayout(cyclicGraph());
    expect(JSON.stringify([...a])).toEqual(JSON.stringify([...b]));
  });
});

describe('applyGraphLayout writes only positions', () => {
  it('writes meta.editor.x/y and preserves every other state field', async () => {
    const graph = cyclicGraph();
    const pos = await computeGraphLayout(graph);
    applyGraphLayout(graph, pos);
    // 位置已写入
    expect(graph.states.a.meta?.editor).toMatchObject({ x: pos.get('a')!.x, y: pos.get('a')!.y });
    // 其它字段分毫未动
    expect(graph.states.a.label).toBe('A');
    expect((graph.states.a.meta as Record<string, unknown>).note).toBe('keep-me'); // 同级 meta 键保留
    expect(graph.states.b.description).toBe('保留我');
    expect(graph.states.b.onEnterActions).toEqual([{ type: 'noop' }]);
    expect(graph.transitions).toHaveLength(4);
  });
});

describe('composition layout only touches positions', () => {
  it('positions states + elements and leaves all other data byte-identical', async () => {
    const comp = composition();
    const before = stripPositions(comp);
    const plan = await computeCompositionLayout(comp, ['el_wrap']);
    applyCompositionLayout(comp, plan);

    // 主图状态、元素、展开子图内部状态都拿到坐标
    expect(comp.mainGraph.states.a.meta?.editor).toBeTruthy();
    expect(typeof comp.elements![0].x).toBe('number');
    expect(comp.elements![0].graph!.states.s0.meta?.editor).toBeTruthy();

    // 关键不变量：除坐标外，一切数据（id/label/transitions/signal/refId/meta 其它键）完全不变
    const after = stripPositions(comp);
    expect(after).toEqual(before);
  });
});
