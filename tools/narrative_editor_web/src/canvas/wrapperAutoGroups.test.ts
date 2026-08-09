import { describe, expect, it } from 'vitest';
import {
  applyWrapperGroupDisplay,
  computeWrapperGroups,
  countIssuesByElement,
  graphShapeFingerprint,
  graphTopologyFingerprint,
  MIN_GROUP_MEMBERS,
  resolveOwnerScene,
  wrapperGroupNodeId,
  parseWrapperGroupNodeId,
} from './wrapperAutoGroups';
import { emptyCatalog } from '../editorModel';
import type {
  AuthoringCatalogDef,
  CanvasEdge,
  CanvasNode,
  NarrativeCompositionDef,
  NarrativeGraphDef,
  ValidationIssueDef,
} from '../types';

/** 一张两态 wrapper 图：`<id>_closed --sig--> <id>_opened`（模板盖章出来的典型形状）。 */
function boxGraph(id: string, signal = 'box_open'): NarrativeGraphDef {
  return {
    id: `wrap_${id}`,
    ownerType: 'hotspot',
    ownerId: id,
    initialState: `${id}_closed`,
    states: {
      [`${id}_closed`]: { id: `${id}_closed` },
      [`${id}_opened`]: { id: `${id}_opened` },
    },
    transitions: [{ id: 't_1', from: `${id}_closed`, to: `${id}_opened`, signal }],
  };
}

function boxElement(id: string, x: number, y: number, signal?: string) {
  return {
    id: `el_${id}`,
    kind: 'wrapperGraph' as const,
    ownerType: 'hotspot',
    ownerId: id,
    x,
    y,
    graph: boxGraph(id, signal),
  };
}

function comp(elements: NarrativeCompositionDef['elements']): NarrativeCompositionDef {
  return {
    id: 'comp',
    mainGraph: {
      id: 'flow', ownerType: 'flow', initialState: 'a',
      states: { a: { id: 'a' } }, transitions: [],
    },
    elements,
  };
}

function elementNode(elementId: string, x: number, y: number): CanvasNode {
  return {
    id: `element:${elementId}`,
    type: 'wrapperGraph',
    position: { x, y },
    data: { label: elementId, subtitle: '', kind: 'wrapperGraph' },
  };
}

const catalogWithScenes: AuthoringCatalogDef = {
  ...emptyCatalog,
  referenceEntries: [
    { kind: 'scene', id: 'yizhuang', qualifiedId: 'yizhuang', label: '义庄' },
    { kind: 'hotspot', id: 'box_a', qualifiedId: 'yizhuang:box_a', label: '箱子甲' },
    { kind: 'hotspot', id: 'box_b', qualifiedId: 'yizhuang:box_b', label: '箱子乙' },
    { kind: 'hotspot', id: 'box_c', qualifiedId: 'matou:box_c', label: '箱子丙' },
  ],
};

describe('graphShapeFingerprint / graphTopologyFingerprint', () => {
  it('id 不同、形状相同的盖章产物指纹相等', () => {
    expect(graphShapeFingerprint(boxGraph('box_a'))).toBe(graphShapeFingerprint(boxGraph('box_b')));
    expect(graphTopologyFingerprint(boxGraph('box_a'))).toBe(graphTopologyFingerprint(boxGraph('box_b')));
  });

  it('完整指纹认信号名（严），拓扑指纹不认（松）', () => {
    const a = boxGraph('box_a', 'box_open');
    const b = boxGraph('box_b', 'crate_open');
    // 聚合告警要严：换了信号名就不是"同一个问题"了
    expect(graphShapeFingerprint(a)).not.toBe(graphShapeFingerprint(b));
    // 视觉分组要松：换个信号名它在画布上仍是同一款
    expect(graphTopologyFingerprint(a)).toBe(graphTopologyFingerprint(b));
  });

  it('多一个状态就不是同一款', () => {
    const wide = boxGraph('box_a');
    wide.states.box_a_broken = { id: 'box_a_broken' };
    expect(graphTopologyFingerprint(wide)).not.toBe(graphTopologyFingerprint(boxGraph('box_b')));
  });

  it('转移在数组里的先后顺序不影响指纹（同构判定不该被数组序左右）', () => {
    const a = boxGraph('box_a');
    a.states.box_a_broken = { id: 'box_a_broken' };
    a.transitions = [
      { id: 't_1', from: 'box_a_closed', to: 'box_a_opened', signal: 'box_open' },
      { id: 't_2', from: 'box_a_opened', to: 'box_a_broken', signal: 'box_open' },
    ];
    const b = boxGraph('box_b');
    b.states.box_b_broken = { id: 'box_b_broken' };
    b.transitions = [
      { id: 't_2', from: 'box_b_opened', to: 'box_b_broken', signal: 'box_open' },
      { id: 't_1', from: 'box_b_closed', to: 'box_b_opened', signal: 'box_open' },
    ];
    expect(graphShapeFingerprint(a)).toBe(graphShapeFingerprint(b));
  });
});

describe('resolveOwnerScene', () => {
  it('裸实体 id 靠目录 qualifiedId 反查场景', () => {
    expect(resolveOwnerScene(boxElement('box_a', 0, 0), catalogWithScenes)).toBe('yizhuang');
    expect(resolveOwnerScene(boxElement('box_c', 0, 0), catalogWithScenes)).toBe('matou');
  });

  it('ownerId 自带 `场景:实体` 时直接取前缀；scene owner 就是场景本身', () => {
    expect(resolveOwnerScene(
      { id: 'e', kind: 'wrapperGraph', ownerType: 'npc', ownerId: 'dock:npc_1' }, emptyCatalog,
    )).toBe('dock');
    expect(resolveOwnerScene(
      { id: 'e', kind: 'wrapperGraph', ownerType: 'scene', ownerId: 'yizhuang' }, emptyCatalog,
    )).toBe('yizhuang');
  });

  it('目录里查不到就如实返回空，绝不猜一个场景（纯 web 调试态 / 实体已删）', () => {
    expect(resolveOwnerScene(boxElement('box_a', 0, 0), emptyCatalog)).toBe('');
    expect(resolveOwnerScene(
      { id: 'e', kind: 'wrapperGraph', ownerType: 'flow', ownerId: '寻狗_码头选择线' }, catalogWithScenes,
    )).toBe('');
  });
});

describe('computeWrapperGroups', () => {
  it('按 owner 场景分组，场景名带中文名', () => {
    const groups = computeWrapperGroups(
      comp([boxElement('box_a', 0, 0), boxElement('box_b', 240, 0), boxElement('box_c', 480, 0)]),
      'scene',
      catalogWithScenes,
    );
    // box_c 在别的场景、只有 1 个成员，不成组
    expect(groups.map((g) => g.key)).toEqual(['scene:yizhuang']);
    expect(groups[0]!.label).toBe('义庄（yizhuang）');
    expect(groups[0]!.elementIds).toEqual(['el_box_a', 'el_box_b']);
  });

  it('按同款模板分组：拓扑一致的收成一组，多一态的自成一类', () => {
    const odd = boxElement('box_x', 720, 0);
    odd.graph.states.box_x_broken = { id: 'box_x_broken' };
    const groups = computeWrapperGroups(
      comp([boxElement('box_a', 0, 0), boxElement('box_b', 240, 0), boxElement('box_c', 480, 0), odd]),
      'shape',
      emptyCatalog,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]!.elementIds).toEqual(['el_box_a', 'el_box_b', 'el_box_c']);
    expect(groups[0]!.label).toContain('2 态');
  });

  it(`成员少于 ${MIN_GROUP_MEMBERS} 个不成组（一张图包一层壳只是多一层壳）`, () => {
    expect(computeWrapperGroups(comp([boxElement('box_a', 0, 0)]), 'shape', emptyCatalog)).toEqual([]);
  });

  it('off 口径永不分组；黑盒 / 无图元素不参与', () => {
    const withBlackbox = comp([
      boxElement('box_a', 0, 0),
      boxElement('box_b', 240, 0),
      { id: 'dlg', kind: 'dialogueBlackbox', refId: 'g1' },
      { id: 'dlg2', kind: 'dialogueBlackbox', refId: 'g2' },
    ]);
    expect(computeWrapperGroups(withBlackbox, 'off', emptyCatalog)).toEqual([]);
    const groups = computeWrapperGroups(withBlackbox, 'shape', emptyCatalog);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.elementIds).toEqual(['el_box_a', 'el_box_b']);
  });
});

describe('applyWrapperGroupDisplay', () => {
  const groups = [{ key: 'shape:x', label: '箱子同款', detail: '2 态', elementIds: ['el_a', 'el_b'] }];
  const nodes = (): CanvasNode[] => [
    elementNode('el_a', 0, 0),
    elementNode('el_b', 300, 0),
    {
      id: 'state:flow:a', type: 'state', position: { x: 0, y: 400 },
      data: { label: 'a', subtitle: '', kind: 'state' },
    },
  ];
  const edges = (): CanvasEdge[] => [
    { id: 'e1', source: 'element:el_a', target: 'element:el_b', data: { edgeKind: 'trigger' } },
    { id: 'e2', source: 'state:flow:a', target: 'element:el_a', data: { edgeKind: 'trigger' } },
    { id: 'e3', source: 'state:flow:a', target: 'state:flow:a', data: { edgeKind: 'transition' } },
  ];

  it('默认折叠（展开集为空）：成员藏起来、组内边藏起来、跨组边改接到组节点', () => {
    const out = applyWrapperGroupDisplay({
      nodes: nodes(), edges: edges(), groups, expandedKeys: new Set(),
    });
    const byId = new Map(out.nodes.map((n) => [n.id, n]));
    expect(byId.get('element:el_a')?.hidden).toBe(true);
    expect(byId.get('element:el_b')?.hidden).toBe(true);
    expect(byId.get('state:flow:a')?.hidden).toBeUndefined();

    const frame = byId.get(wrapperGroupNodeId('shape:x'))!;
    expect(frame).toBeTruthy();
    expect(frame.data.groupCollapsed).toBe(true);
    expect(frame.data.groupMemberCount).toBe(2);

    const edgeById = new Map(out.edges.map((e) => [e.id, e]));
    expect(edgeById.get('e1')?.hidden).toBe(true); // 两端同组 → 组内边
    expect(edgeById.get('e2')?.target).toBe(wrapperGroupNodeId('shape:x'));
    expect(edgeById.get('e3')?.source).toBe('state:flow:a'); // 与组无关的边原样
  });

  it('展开：成员照常可见，只留一个垫底的框（zIndex 为负，不挡成员）', () => {
    const out = applyWrapperGroupDisplay({
      nodes: nodes(), edges: edges(), groups, expandedKeys: new Set(['shape:x']),
    });
    const byId = new Map(out.nodes.map((n) => [n.id, n]));
    expect(byId.get('element:el_a')?.hidden).toBeUndefined();
    const frame = byId.get(wrapperGroupNodeId('shape:x'))!;
    expect(frame.data.groupCollapsed).toBe(false);
    expect(Number(frame.zIndex)).toBeLessThan(0);
    // 展开态不改接任何边
    expect(out.edges.map((e) => e.target)).toEqual(edges().map((e) => e.target));
  });

  it('折叠框是非四向端口节点：类型必须是 wrapperGroupFrame（写 handle id 会 error008 让边整条消失）', () => {
    const out = applyWrapperGroupDisplay({
      nodes: nodes(), edges: edges(), groups, expandedKeys: new Set(),
    });
    const frame = out.nodes.find((n) => n.id === wrapperGroupNodeId('shape:x'))!;
    expect(frame.type).toBe('wrapperGroupFrame');
    expect(parseWrapperGroupNodeId(frame.id)).toBe('shape:x');
  });

  it('折叠态带上组内校验问题数（折叠不许把问题藏起来）', () => {
    const out = applyWrapperGroupDisplay({
      nodes: nodes(),
      edges: edges(),
      groups,
      expandedKeys: new Set(),
      issueCountByElementId: new Map([['el_a', 3], ['el_b', 1]]),
    });
    const frame = out.nodes.find((n) => n.id === wrapperGroupNodeId('shape:x'))!;
    expect(frame.data.groupIssueCount).toBe(4);
  });

  it('没有分组时原样返回（引用都不换，避免整画布无谓重渲染）', () => {
    const inNodes = nodes();
    const inEdges = edges();
    const out = applyWrapperGroupDisplay({
      nodes: inNodes, edges: inEdges, groups: [], expandedKeys: new Set(),
    });
    expect(out.nodes).toBe(inNodes);
    expect(out.edges).toBe(inEdges);
  });

  it('折叠成员的内嵌子节点跟着藏，指向它的边也改接到组节点', () => {
    const withChild: CanvasNode[] = [
      ...nodes(),
      {
        id: 'inline:el_a:s1', type: 'state', parentId: 'element:el_a',
        position: { x: 10, y: 10 }, data: { label: 's1', subtitle: '', kind: 'state' },
      },
    ];
    const withChildEdge: CanvasEdge[] = [
      ...edges(),
      { id: 'e4', source: 'state:flow:a', target: 'inline:el_a:s1', data: { edgeKind: 'trigger' } },
    ];
    const out = applyWrapperGroupDisplay({
      nodes: withChild, edges: withChildEdge, groups, expandedKeys: new Set(),
    });
    expect(out.nodes.find((n) => n.id === 'inline:el_a:s1')?.hidden).toBe(true);
    expect(out.edges.find((e) => e.id === 'e4')?.target).toBe(wrapperGroupNodeId('shape:x'));
  });
});

describe('countIssuesByElement', () => {
  const composition = comp([boxElement('box_a', 0, 0), boxElement('box_b', 240, 0)]);

  it('target 带 elementId 的直接归位；只带 graphId 的按图反查', () => {
    const issues: ValidationIssueDef[] = [
      {
        severity: 'error', code: 'x', message: '',
        target: { kind: 'graph', compositionId: 'comp', graphId: 'wrap_box_a', elementId: 'el_box_a' },
      },
      {
        severity: 'warning', code: 'y', message: '',
        target: { kind: 'transition', compositionId: 'comp', graphId: 'wrap_box_b', transitionId: 't_1' },
      },
    ];
    expect([...countIssuesByElement(composition, issues)]).toEqual([['el_box_a', 1], ['el_box_b', 1]]);
  });

  it('别的编排 / 信号级问题不进本编排的计数', () => {
    const issues: ValidationIssueDef[] = [
      { severity: 'error', code: 'x', message: '', target: { kind: 'signal', signalId: 's' } },
      {
        severity: 'error', code: 'y', message: '',
        target: { kind: 'graph', compositionId: 'other', graphId: 'wrap_box_a' },
      },
      { severity: 'error', code: 'z', message: '' },
    ];
    expect(countIssuesByElement(composition, issues).size).toBe(0);
  });
});
