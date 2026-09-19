import { describe, expect, it } from 'vitest';
import {
  buildCompositionOverview,
  buildGraphOverview,
  chipText,
  dedupeRows,
  describeJump,
  describeRowJump,
  filterRows,
  groupRowsByState,
  kindCounts,
  overviewSummary,
  pusherJump,
  targetJump,
} from './graphOverview';
import type { GraphXrefCardDef, XrefPusherDef, XrefStateReadDef, XrefTargetDef } from './types';

function pusher(over: Partial<XrefPusherDef>): XrefPusherDef {
  return {
    signal: 'sig', channel: 'asset', containerKind: 'scene', containerId: 'scene_a', containerLabel: '甲场景',
    kindLabel: '场景', where: '区域「z1」 · 进入时 第 1 个', context: '', note: '',
    file: 'public/assets/scenes/scene_a.json', pointer: '/zones/0/onEnter/0', anchors: [['zones', 'z1']],
    readonly: false, compositionId: '', elementId: '', graphId: '', stateId: '', transitionId: '', wired: true,
    ownerType: '', ownerId: '', ownerBound: false,
    fromState: 'a', toState: 'b', fromLabel: '甲', toLabel: '乙', trigger: '',
    selfGraph: false, refGraphId: '', refStateId: '', refStateLabel: '',
    subjectKindLabel: '区域', subjectId: 'z1', subjectName: '', sceneId: 'scene_a', sceneLabel: '甲场景', moment: '进入时',
    ...over,
  } as XrefPusherDef;
}

function reader(over: Partial<XrefStateReadDef>): XrefStateReadDef {
  return {
    graphId: 'g', stateId: 'b', subjectKind: 'npc', subjectKindLabel: 'NPC', subjectName: '老汉', subjectId: 'npc_1',
    subjectScene: '甲场景', subjectEffect: '出不出现', subjectDisplay: '老汉', reached: false, negated: false,
    compositionId: '', elementId: '', hostGraphId: '', hostTransitionId: '', containerKind: 'scene', containerId: 'scene_a',
    kindLabel: '场景', where: 'NPC「npc_1」 · 条件 · 第 1 项', file: 'public/assets/scenes/scene_a.json', pointer: '/npcs/0/conditions/0',
    readonly: false, anchors: [['npcs', 'npc_1']],
    ...over,
  };
}

function target(over: Partial<XrefTargetDef>): XrefTargetDef {
  return {
    universe: 'cutscenes', kindLabel: '过场', targetId: 'cs_1', label: '开场', display: '开场', actionType: 'startCutscene', param: 'id',
    sceneId: '', sceneLabel: '', where: '进入时动作 第 1 个', file: 'public/assets/data/cutscenes/index.json', pointer: '',
    anchors: [['cutscenes', 'cs_1']], navKind: '', readonly: false, note: '', refCompositionId: '', refElementId: '', refGraphId: '',
    hostPointer: '/compositions/0/mainGraph/states/b/onEnterActions/0', compositionId: 'comp', elementId: '', graphId: 'g', stateId: 'b',
    ...over,
  };
}

function card(over: Partial<GraphXrefCardDef>): GraphXrefCardDef {
  return {
    graphId: 'g', graphLabel: '一张图', compositionId: 'comp', compositionLabel: '编排', elementId: '', ownerType: 'scene', ownerId: 'scene_a',
    exists: true, stateIds: ['a', 'b', 'c'], stateLabels: { a: '甲', b: '乙', c: '丙' },
    pushers: [], readers: [], targets: [], downstream: [],
    pusherCount: 0, readerCount: 0, targetCount: 0, downstreamCount: 0,
    ...over,
  };
}

describe('buildGraphOverview · 推它的', () => {
  it('同一条转移上同一个区域的进入时 / 停留时并成一行，时刻合写', () => {
    const model = buildGraphOverview(card({
      pushers: [
        pusher({ transitionId: 't1', moment: '进入时' }),
        pusher({ transitionId: 't1', moment: '停留时', where: '区域「z1」 · 停留时 第 1 个' }),
      ],
    }));
    expect(model.push).toHaveLength(1);
    expect(model.push[0]!.kindLabel).toBe('区域');
    expect(model.push[0]!.title).toBe('z1');
    expect(model.push[0]!.detail).toContain('进入时 / 停留时');
    expect(model.push[0]!.subtitle).toContain('让「甲 → 乙」走');
    // 转移小标按转移分桶
    expect(model.chipsByTransition.t1).toHaveLength(1);
  });

  it('本图自推的排最后、不上转移小标，但行还在（不然那条转移看着像没接线）', () => {
    const model = buildGraphOverview(card({
      pushers: [
        pusher({ transitionId: 't2', selfGraph: true, subjectKindLabel: '本图', subjectName: '乙', channel: 'narrativeAction',
          file: 'public/assets/data/narrative_graphs.json', compositionId: 'comp', graphId: 'g', stateId: 'b', moment: '状态动作' }),
        pusher({ transitionId: 't1' }),
      ],
    }));
    expect(model.push.map((r) => r.transitionId)).toEqual(['t1', 't2']);
    expect(model.push[1]!.selfGraph).toBe(true);
    expect(model.push[1]!.jump.kind).toBe('focus');
    expect(model.chipsByTransition.t2).toBeUndefined();
  });

  it('来源是另一张图的状态：跳法是画布定位到那张图那一拍', () => {
    const jump = pusherJump(pusher({ refGraphId: 'other', refStateId: 'done', compositionId: 'comp', elementId: 'el_other', channel: 'broadcast' }));
    expect(jump).toEqual({ kind: 'focus', target: { kind: 'state', compositionId: 'comp', graphId: 'other', stateId: 'done', elementId: 'el_other' } });
  });
});

describe('buildGraphOverview · 它管的 / 它调的', () => {
  it('读状态的行按状态顺序排、挂到那一拍的小标里，抬头是世界里的那个东西', () => {
    const model = buildGraphOverview(card({
      readers: [
        reader({ stateId: 'c', subjectDisplay: '门口', subjectKindLabel: '热点', subjectEffect: '能不能互动' }),
        reader({ stateId: 'a', subjectDisplay: '老汉' }),
      ],
    }));
    expect(model.gate.map((r) => r.title)).toEqual(['老汉', '门口']);
    expect(model.gate[0]!.subtitle).toContain('出不出现');
    expect(model.gate[0]!.subtitle).toContain('看「甲」');
    expect(model.chipsByState.a!.gate).toHaveLength(1);
    expect(model.chipsByState.c!.gate).toHaveLength(1);
    expect(model.chipsByState.b!.gate).toHaveLength(0);
    expect(chipText(model.gate[0]!)).toBe('NPC·老汉');
  });

  it('动作目标：过场走文件锚点、位面走 navigate、另一张图走画布定位、只读资产明说跳不了', () => {
    expect(targetJump(target({})).kind).toBe('reveal');
    expect(targetJump(target({ universe: 'planes', navKind: 'plane', file: '', anchors: [] }))).toEqual({ kind: 'navigate', navKind: 'plane', id: 'cs_1' });
    expect(targetJump(target({ universe: 'narrative_graph_ids', refGraphId: 'g2', refCompositionId: 'comp', refElementId: 'el2', file: '', anchors: [] })))
      .toEqual({ kind: 'focus', target: { kind: 'graph', compositionId: 'comp', graphId: 'g2', elementId: 'el2' } });
    const ro = targetJump(target({ universe: 'vfx_effects', readonly: true, note: '粒子工作台的资产', file: 'public/assets/data/vfx/x.json', anchors: [] }));
    expect(ro).toEqual({ kind: 'none', reason: '粒子工作台的资产' });
  });

  it('场景作用域的目标把场景名带进抬头，位置只留状态之后那截', () => {
    const model = buildGraphOverview(card({
      targets: [target({ universe: 'zones', kindLabel: '区域', targetId: 'z9', display: 'z9', sceneId: 'scene_a', sceneLabel: '甲场景', where: '进入时动作 第 2 个' })],
    }));
    expect(model.call[0]!.title).toBe('甲场景 的 z9');
    expect(model.call[0]!.subtitle).toBe('状态「乙」 · 进入时动作 第 2 个');
    expect(model.chipsByState.b!.call).toHaveLength(1);
  });
});

describe('搜索、摘要、去处描述', () => {
  it('按名字 / 类别 / 场景 / 状态名都能搜到；可按一拍收窄', () => {
    const model = buildGraphOverview(card({
      readers: [reader({ stateId: 'a' }), reader({ stateId: 'b', subjectDisplay: '门口', subjectKindLabel: '热点' })],
    }));
    expect(filterRows(model.gate, '老汉')).toHaveLength(1);
    expect(filterRows(model.gate, '热点')).toHaveLength(1);
    expect(filterRows(model.gate, '甲场景')).toHaveLength(2);
    expect(filterRows(model.gate, '', 'b')).toHaveLength(1);
    expect(filterRows(model.gate, '不存在')).toHaveLength(0);
  });

  it('摘要把自推单独说，数字与组头对得上（验收实测：抬头 6、组头 8 让人以为漏扫）', () => {
    const model = buildGraphOverview(card({
      pushers: [pusher({ transitionId: 't1' }), pusher({ transitionId: 't2', selfGraph: true })],
      readers: [reader({})],
      targets: [target({})],
    }));
    expect(overviewSummary(model)).toBe('推它的 1（另有本图自己发的 1） · 它管的 1 · 它调的 1');
    expect(model.push).toHaveLength(2);
  });

  it('同一个东西同一句关系只留一行（一份档案的两条解锁条件读同一拍）', () => {
    const model = buildGraphOverview(card({
      readers: [
        reader({ stateId: 'a', subjectDisplay: '克拉拉', subjectKindLabel: '档案', subjectEffect: '见闻能不能看到', pointer: '/entries/0/unlockConditions/0' }),
        reader({ stateId: 'a', subjectDisplay: '克拉拉', subjectKindLabel: '档案', subjectEffect: '见闻能不能看到', pointer: '/entries/0/unlockConditions/1' }),
        reader({ stateId: 'b', subjectDisplay: '克拉拉', subjectKindLabel: '档案', subjectEffect: '见闻能不能看到', pointer: '/entries/0/unlockConditions/2' }),
      ],
    }));
    expect(model.gate).toHaveLength(2);
    expect(dedupeRows(model.gate)).toHaveLength(2);
  });

  it('「只看这一拍」把进入这一拍的路也算进来', () => {
    const model = buildGraphOverview(card({
      pushers: [pusher({ transitionId: 't1', fromState: 'a', toState: 'b' }), pusher({ transitionId: 't2', fromState: 'b', toState: 'c', subjectId: 'z2' })],
    }));
    expect(filterRows(model.push, { stateId: 'b' }).map((r) => r.transitionId)).toEqual(['t1', 't2']);
    expect(filterRows(model.push, { stateId: 'c' }).map((r) => r.transitionId)).toEqual(['t2']);
    expect(filterRows(model.push, { kinds: new Set(['热点']) })).toHaveLength(0);
    expect(filterRows(model.push, { kinds: new Set(['区域']) })).toHaveLength(2);
  });

  it('跳转回执先名字后 id，不甩文件路径', () => {
    const model = buildGraphOverview(card({
      targets: [target({ universe: 'dialogue_graphs', kindLabel: '对话图', targetId: '主线_初上跑马梁', display: '跑马梁·纸钱引路', file: 'public/assets/dialogues/graphs/主线_初上跑马梁.json', anchors: [] })],
      readers: [reader({})],
    }));
    expect(describeRowJump(model.call[0]!)).toBe('打开对话图「跑马梁·纸钱引路」（主线_初上跑马梁）');
    expect(describeRowJump(model.gate[0]!)).toBe('打开NPC「老汉」（npc_1）');
  });

  it('整个编排：各图的行合起来、标出长在哪张图、类别计数与分段可用', () => {
    const a = card({ graphId: 'g', graphLabel: '甲图', readers: [reader({ stateId: 'a' })] });
    const b = card({ graphId: 'h', graphLabel: '乙图', stateIds: ['x'], stateLabels: { x: '某拍' },
      targets: [target({ graphId: 'h', stateId: 'x' })] });
    const model = buildCompositionOverview([a, b], '寻狗');
    expect(model.wholeComposition).toBe(true);
    expect(model.graphLabel).toBe('整个编排 · 寻狗');
    expect(model.gate[0]!.detail).toBe('图「甲图」 · 甲场景');
    expect(model.call[0]!.detail).toBe('图「乙图」');
    expect(kindCounts(model).map((k) => `${k.kind}:${k.count}`).sort()).toEqual(['NPC:1', '过场:1']);
    expect(groupRowsByState([...model.gate, ...model.call]).map((g) => g.label)).toEqual(['状态「甲」', '状态「某拍」']);
    expect(filterRows(model.gate, { stateId: 'a', graphId: 'g' })).toHaveLength(1);
    expect(filterRows(model.gate, { stateId: 'a', graphId: 'h' })).toHaveLength(0);
  });

  it('网页开发态说得清去处（不谎报已定位）', () => {
    expect(describeJump({ kind: 'reveal', file: 'public/assets/data/items.json', pointer: '', anchors: [['items', 'i1']] }))
      .toBe('打开 public/assets/data/items.json 里的 「i1」');
    expect(describeJump({ kind: 'navigate', navKind: 'plane', id: 'p' })).toBe('切到「plane」页：p');
    expect(describeJump({ kind: 'none', reason: '没页' })).toBe('没页');
  });
});
