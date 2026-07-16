import { describe, expect, it } from 'vitest';
import type { CanvasEdge, CanvasNode } from '../types';
import {
  applyEditorGroupDisplay,
  buildGroupFrameNodes,
  computeGroupMembership,
  groupFrameNodeId,
  newGroupId,
  normalizeCanvasGroupsFile,
  parseGroupFrameNodeId,
  reconcileGroupFrameNodes,
  setGroupsForCanvas,
  type CanvasGroupDef,
} from './editorGroups';

function stateNode(id: string, x: number, y: number, extra?: Partial<CanvasNode>): CanvasNode {
  return {
    id,
    type: 'state',
    position: { x, y },
    measured: { width: 200, height: 80 },
    data: { label: id, subtitle: '', kind: 'state' },
    ...extra,
  } as CanvasNode;
}

function group(frame: { x: number; y: number; width: number; height: number }, extra?: Partial<CanvasGroupDef>): CanvasGroupDef {
  return { name: '分组', color: '#4a6fa8', frame, ...extra };
}

describe('normalizeCanvasGroupsFile', () => {
  it('tolerates garbage and prunes empty levels', () => {
    expect(normalizeCanvasGroupsFile(null)).toEqual({ schemaVersion: 1, canvases: {} });
    expect(normalizeCanvasGroupsFile({ canvases: { comp: { main: {} }, '': { main: { g: group({ x: 0, y: 0, width: 100, height: 100 }) } } } }))
      .toEqual({ schemaVersion: 1, canvases: {} });
  });

  it('clamps frame size, fixes bad color and empty name', () => {
    const out = normalizeCanvasGroupsFile({
      canvases: { comp: { main: { g1: { name: '  ', color: 'red', frame: { x: 1.6, y: 2, width: 10, height: -5 } } } } },
    });
    const g = out.canvases.comp.main.g1;
    expect(g.name).toBe('分组');
    expect(g.color).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(g.frame).toEqual({ x: 2, y: 2, width: 80, height: 80 });
  });

  it('keeps collapsed only when true', () => {
    const out = normalizeCanvasGroupsFile({
      canvases: { comp: { main: {
        a: { ...group({ x: 0, y: 0, width: 100, height: 100 }), collapsed: true },
        b: { ...group({ x: 0, y: 0, width: 100, height: 100 }), collapsed: false },
      } } },
    });
    expect(out.canvases.comp.main.a.collapsed).toBe(true);
    expect('collapsed' in out.canvases.comp.main.b).toBe(false);
  });
});

describe('setGroupsForCanvas', () => {
  it('writes and prunes per-canvas groups immutably', () => {
    const base = normalizeCanvasGroupsFile(null);
    const g = { g_1: group({ x: 0, y: 0, width: 200, height: 200 }) };
    const withGroups = setGroupsForCanvas(base, 'comp', 'main', g);
    expect(withGroups.canvases.comp.main.g_1).toBeTruthy();
    expect(base.canvases).toEqual({});
    const cleared = setGroupsForCanvas(withGroups, 'comp', 'main', {});
    expect(cleared.canvases).toEqual({});
  });
});

describe('newGroupId', () => {
  it('skips taken ids', () => {
    expect(newGroupId({})).toBe('g_1');
    expect(newGroupId({ g_1: group({ x: 0, y: 0, width: 100, height: 100 }) })).toBe('g_2');
  });
});

describe('computeGroupMembership', () => {
  const groups = {
    big: group({ x: 0, y: 0, width: 1000, height: 1000 }),
    small: group({ x: 100, y: 100, width: 300, height: 300 }),
  };

  it('assigns by node center, overlapping frames prefer smallest area', () => {
    const inSmall = stateNode('s1', 150, 150); // 中心 (250,190) 在两框内
    const inBigOnly = stateNode('s2', 500, 500);
    const outside = stateNode('s3', 2000, 2000);
    const m = computeGroupMembership([inSmall, inBigOnly, outside], groups);
    expect(m.get('s1')).toBe('small');
    expect(m.get('s2')).toBe('big');
    expect(m.has('s3')).toBe(false);
  });

  it('excludes anchors, frames and parented children', () => {
    const anchor = stateNode('a', 150, 150, { data: { label: 'a', subtitle: '', kind: 'transitionAnchor' } } as Partial<CanvasNode>);
    const child = stateNode('c', 150, 150, { parentId: 'subgraph:x' });
    const frame = buildGroupFrameNodes(groups)[0];
    const m = computeGroupMembership([anchor, child, frame], groups);
    expect(m.size).toBe(0);
  });
});

describe('reconcileGroupFrameNodes', () => {
  it('adds, updates and removes frame nodes while keeping other nodes', () => {
    const s = stateNode('s1', 0, 0);
    const groups = { g_1: group({ x: 10, y: 20, width: 300, height: 200 }) };
    let nodes = reconcileGroupFrameNodes([s], groups);
    expect(nodes.map((n) => n.id)).toEqual(['s1', groupFrameNodeId('g_1')]);

    const moved = { g_1: group({ x: 99, y: 99, width: 300, height: 200 }, { name: '改名' }) };
    nodes = reconcileGroupFrameNodes(nodes, moved);
    const frame = nodes.find((n) => n.id === groupFrameNodeId('g_1'))!;
    expect(frame.position).toEqual({ x: 99, y: 99 });
    expect(frame.data.label).toBe('改名');

    nodes = reconcileGroupFrameNodes(nodes, {});
    expect(nodes.map((n) => n.id)).toEqual(['s1']);
  });
});

describe('applyEditorGroupDisplay', () => {
  const groups = {
    g_1: group({ x: 0, y: 0, width: 400, height: 400 }, { collapsed: true }),
    g_2: group({ x: 1000, y: 0, width: 400, height: 400 }),
  };
  const member1 = stateNode('m1', 50, 50);
  const member2 = stateNode('m2', 150, 150);
  const inOpenGroup = stateNode('o1', 1050, 50);
  const outside = stateNode('x1', 3000, 3000);
  const frames = buildGroupFrameNodes(groups);
  const allNodes = [member1, member2, inOpenGroup, outside, ...frames];
  const edges: CanvasEdge[] = [
    { id: 'e-internal', source: 'm1', target: 'm2', data: { edgeKind: 'transition' } },
    { id: 'e-out', source: 'm2', target: 'x1', data: { edgeKind: 'transition' } },
    { id: 'e-in', source: 'o1', target: 'm1', data: { edgeKind: 'trigger' } },
    { id: 'e-free', source: 'o1', target: 'x1', data: { edgeKind: 'read' } },
  ] as CanvasEdge[];

  it('hides collapsed members and internal edges, repoints boundary edges to the frame', () => {
    const out = applyEditorGroupDisplay(allNodes, edges, groups);
    const byId = new Map(out.nodes.map((n) => [n.id, n]));
    expect(byId.get('m1')!.hidden).toBe(true);
    expect(byId.get('m2')!.hidden).toBe(true);
    expect(byId.get('o1')!.hidden).toBeUndefined();
    expect(byId.get('x1')!.hidden).toBeUndefined();

    const edgeById = new Map(out.edges.map((e) => [e.id, e]));
    expect(edgeById.get('e-internal')!.hidden).toBe(true);
    expect(edgeById.get('e-out')!.source).toBe(groupFrameNodeId('g_1'));
    expect(edgeById.get('e-out')!.target).toBe('x1');
    expect(edgeById.get('e-in')!.target).toBe(groupFrameNodeId('g_1'));
    expect(edgeById.get('e-free')).toEqual(edges[3]);
  });

  it('marks member counts and compacts collapsed frame', () => {
    const out = applyEditorGroupDisplay(allNodes, edges, groups);
    const collapsed = out.nodes.find((n) => n.id === groupFrameNodeId('g_1'))!;
    const open = out.nodes.find((n) => n.id === groupFrameNodeId('g_2'))!;
    expect(collapsed.data.groupMemberCount).toBe(2);
    expect(collapsed.data.groupCollapsed).toBe(true);
    expect(Number(collapsed.style?.width)).toBeLessThan(400);
    expect(open.data.groupMemberCount).toBe(1);
    expect(open.data.groupCollapsed).toBe(false);
    expect(open.style?.width).toBe(400);
  });

  it('is a no-op without groups', () => {
    const out = applyEditorGroupDisplay([member1], edges, {});
    expect(out.nodes[0]).toBe(member1);
    expect(out.edges).toBe(edges);
  });
});

describe('id helpers', () => {
  it('round-trips frame node ids', () => {
    expect(parseGroupFrameNodeId(groupFrameNodeId('g_9'))).toBe('g_9');
    expect(parseGroupFrameNodeId('state:s1')).toBeNull();
  });
});
