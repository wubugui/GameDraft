import { describe, expect, it } from 'vitest';
import {
  aggregatePrivateListeners,
  privatePatternHeadline,
  privatePatternTitle,
  canReveal,
  countSummary,
  filterSignals,
  focusTargetOfDeclaration,
  focusTargetOfEmitter,
  hasProblem,
  listenerFocusTarget,
  listenerHeadline,
  listenerSubline,
  emitterHeadline,
  noteWorthShowing,
  refOf,
  revealBlockedReason,
  rowLabel,
  searchHaystack,
  signalDisplayName,
  filterStates,
  readerEffect,
  readerFocusTarget,
  readerHeadline,
  relationFingerprint,
  signalFocusIdOf,
  stateCountSummary,
  stateFocusTarget,
  stateHeadline,
  stateKey,
  splitEmitters,
  worstSeverity,
} from './signalXref';
import type {
  NarrativeGraphsFileDef,
  SignalXrefCardDef,
  StateXrefCardDef,
  XrefEmitterDef,
  XrefListenerDef,
  XrefStateReadDef,
} from './types';

function emitter(over: Partial<XrefEmitterDef> = {}): XrefEmitterDef {
  return {
    signal: 'sig',
    channel: 'dialogue',
    containerKind: 'dialogue',
    containerId: '对话_接活',
    containerLabel: '对话_接活',
    kindLabel: '对话图',
    where: '节点「c_jie」 · 动作 第 1 个',
    context: '“行，这活我接了。”',
    note: '',
    file: 'public/assets/dialogues/graphs/对话_接活.json',
    pointer: '/nodes/c_jie/actions/0',
    anchors: [],
    readonly: false,
    compositionId: '',
    elementId: '',
    graphId: '',
    stateId: '',
    transitionId: '',
    wired: true,
    ...over,
  };
}

function listener(over: Partial<XrefListenerDef> = {}): XrefListenerDef {
  return {
    signal: 'sig',
    compositionId: 'comp_1',
    compositionLabel: '第一单',
    graphId: 'flow_main',
    graphLabel: '主线',
    elementId: '',
    transitionId: 't_accept',
    from: 's_a',
    fromLabel: '找活中',
    to: 's_b',
    toLabel: '已接活',
    conditions: [],
    how: '收到信号「sig」时走',
    runGraph: false,
    priority: 0,
    trigger: '',
    file: 'public/assets/data/narrative_graphs.json',
    pointer: '/compositions/0/mainGraph/transitions/0',
    ...over,
  };
}

function card(over: Partial<SignalXrefCardDef> = {}): SignalXrefCardDef {
  const emitters = over.emitters ?? [emitter()];
  const listeners = over.listeners ?? [listener()];
  return {
    signal: 'sig',
    kind: 'author',
    label: '',
    notes: '',
    registered: true,
    declarations: [],
    reactiveRefs: [],
    stateReads: [],
    diagnostics: [],
    sourceGraphId: '',
    sourceGraphLabel: '',
    sourceStateId: '',
    sourceStateLabel: '',
    emitterCount: emitters.filter((e) => e.channel !== 'upstream').length,
    listenerCount: listeners.length,
    reactiveRefCount: 0,
    declarationCount: 0,
    ...over,
    emitters,
    listeners,
  };
}

function stateRead(over: Partial<XrefStateReadDef> = {}): XrefStateReadDef {
  return {
    graphId: 'flow_main',
    stateId: 's_b',
    compositionId: '',
    elementId: '',
    hostGraphId: '',
    hostTransitionId: '',
    containerKind: 'quest',
    containerId: 'q_1',
    kindLabel: '任务',
    subjectKind: 'quest', subjectKindLabel: '任务', subjectName: '', subjectId: 'q_1',
    subjectScene: '', subjectEffect: '任务算不算数', subjectDisplay: 'q_1',
    reached: false, negated: false,
    where: '完成时 第 1 个',
    file: 'public/assets/data/quests.json',
    pointer: '/0/requires',
    readonly: false,
    anchors: [['', 'q_1']],
    ...over,
  };
}

describe('读状态那一栏也要能定位', () => {
  it('带 anchors 才跳得到具体条目（缺了只能打开页面）', () => {
    expect(refOf(stateRead())).toEqual({
      file: 'public/assets/data/quests.json',
      pointer: '/0/requires',
      anchors: [['', 'q_1']],
    });
  });

  it('只读数据面同样灰掉', () => {
    expect(canReveal(stateRead({ readonly: true }))).toBe(false);
  });
});

describe('发送方与上游因果分堆', () => {
  it('上游因果不混进发射方（否则"有几处发它"就是假数)', () => {
    const c = card({
      emitters: [
        emitter({ channel: 'broadcast', kindLabel: '叙事图' }),
        emitter({ channel: 'upstream', kindLabel: '上游转移' }),
        emitter({ channel: 'upstream', kindLabel: '初始状态' }),
      ],
    });
    const { real, upstream } = splitEmitters(c);
    expect(real).toHaveLength(1);
    expect(upstream).toHaveLength(2);
  });
});

describe('跳不动的行要提前说清楚，别让人白点', () => {
  it('只读数据面（物件检视）不给跳，并说明为什么', () => {
    const ro = emitter({ readonly: true, kindLabel: '物件检视' });
    expect(canReveal(ro)).toBe(false);
    expect(revealBlockedReason(ro)).toContain('只读');
  });

  it('没有文件定位的行也不给跳', () => {
    expect(canReveal(emitter({ file: '' }))).toBe(false);
    expect(revealBlockedReason(emitter({ file: '' }))).toContain('没有文件');
  });

  it('正常的行照跳', () => {
    expect(canReveal(emitter())).toBe(true);
    expect(revealBlockedReason(emitter())).toBe('');
  });
});

describe('留痕来源只在与容器对不上时才显示', () => {
  it('与容器一致 = 噪声，不显示', () => {
    expect(noteWorthShowing(emitter({ note: '留痕来源：dialogue:对话_接活' }))).toBe(false);
  });

  it('与容器对不上 = 线索，必须显示', () => {
    expect(noteWorthShowing(emitter({ note: '留痕来源：dialogue:另一段戏' }))).toBe(true);
  });

  it('没有留痕就不占行', () => {
    expect(noteWorthShowing(emitter({ note: '' }))).toBe(false);
  });
});

describe('筛选', () => {
  const cards = [
    card({ signal: 'a_ok' }),
    card({ signal: 'b_dangling', diagnostics: [{ code: 'noEmitter', severity: 'warning', message: '没人发' }] }),
    card({ signal: 'c_draft', kind: 'draft', diagnostics: [{ code: 'draft', severity: 'info', message: '占位' }] }),
    card({ signal: 'state:g:s', kind: 'derived' }),
    card({ signal: 'e_ghost', kind: 'unknown', diagnostics: [{ code: 'unregistered', severity: 'warning', message: '没登记' }] }),
  ];

  it('「有问题」只收 error/warning，草稿占位不算问题', () => {
    expect(filterSignals(cards, 'problems', '').map((c) => c.signal)).toEqual(['b_dangling', 'e_ghost']);
  });

  it('按种类筛', () => {
    expect(filterSignals(cards, 'derived', '').map((c) => c.signal)).toEqual(['state:g:s']);
    expect(filterSignals(cards, 'unregistered', '').map((c) => c.signal)).toEqual(['e_ghost']);
    expect(filterSignals(cards, 'author', '')).toHaveLength(2);
  });

  it('搜索面覆盖两侧：记不住 id 也能靠"哪段戏"找到', () => {
    const found = filterSignals(cards, 'all', '对话_接活');
    expect(found.length).toBeGreaterThan(0);
    expect(filterSignals(cards, 'all', '主线').length).toBeGreaterThan(0);
    expect(filterSignals(cards, 'all', '压根没有这个词')).toHaveLength(0);
  });

  it('搜索大小写不敏感', () => {
    expect(filterSignals([card({ signal: 'Sig_UPPER' })], 'all', 'sig_upper')).toHaveLength(1);
  });

  it('筛选与搜索是"且"的关系', () => {
    expect(filterSignals(cards, 'problems', 'e_ghost').map((c) => c.signal)).toEqual(['e_ghost']);
    expect(filterSignals(cards, 'problems', 'a_ok')).toHaveLength(0);
  });
});

describe('诊断分级', () => {
  it('error 压过 warning', () => {
    expect(worstSeverity(card({
      diagnostics: [
        { code: 'w', severity: 'warning', message: '' },
        { code: 'e', severity: 'error', message: '' },
      ],
    }))).toBe('error');
  });

  it('没有诊断就是空', () => {
    expect(worstSeverity(card())).toBe('');
    expect(hasProblem(card())).toBe(false);
  });

  it('只有 info 不算问题', () => {
    const c = card({ diagnostics: [{ code: 'draft', severity: 'info', message: '' }] });
    expect(worstSeverity(c)).toBe('info');
    expect(hasProblem(c)).toBe(false);
  });
});

describe('行文案', () => {
  it('发送方一行说清"谁"', () => {
    expect(emitterHeadline(emitter())).toBe('对话图「对话_接活」');
    expect(emitterHeadline(emitter({ kindLabel: '', containerLabel: '', containerId: '' }))).toBe('未知来源');
  });

  it('接收方说的是拍子名不是 id', () => {
    expect(listenerHeadline(listener())).toBe('主线 · 找活中 → 已接活');
  });

  it('条件与优先级进副行', () => {
    const sub = listenerSubline(listener({ priority: 2, conditions: ['「主线」正停在「找活中」'] }));
    expect(sub).toContain('优先级 2');
    expect(sub).toContain('还要满足：');
    expect(listenerSubline(listener())).not.toContain('优先级');
  });

  it('显示名带中文名，没有中文名就只有 id', () => {
    expect(signalDisplayName(card({ label: '接活了' }))).toBe('sig（接活了）');
    expect(signalDisplayName(card({ label: 'sig' }))).toBe('sig');
    expect(signalDisplayName(card())).toBe('sig');
  });

  it('计数摘要只在有声明时才显示声明', () => {
    expect(countSummary(card())).toBe('发 1 · 听 1');
    expect(countSummary(card({ declarationCount: 2 }))).toBe('发 1 · 听 1 · 另有 2 处只是标注');
  });
});

describe('画布定位', () => {
  it('主图转移不带 elementId', () => {
    expect(listenerFocusTarget(listener())).toEqual({
      kind: 'transition', compositionId: 'comp_1', graphId: 'flow_main', transitionId: 't_accept',
    });
  });

  it('子图转移带 elementId（不带就会定位到主图上找不到）', () => {
    expect(listenerFocusTarget(listener({ elementId: 'el_sub' }))).toMatchObject({ elementId: 'el_sub' });
  });

  it('缺编排信息时不给目标，宁可禁用按钮也不跳空', () => {
    expect(listenerFocusTarget(listener({ compositionId: '' }))).toBeNull();
    expect(listenerFocusTarget(listener({ transitionId: '' }))).toBeNull();
  });
});

describe('叙事图内的行走画布定位（文件跳转对转移落不到点）', () => {
  it('上游转移 → 转移目标', () => {
    expect(focusTargetOfEmitter(emitter({
      channel: 'upstream', compositionId: 'comp_1', graphId: 'g', transitionId: 't1',
    }))).toEqual({ kind: 'transition', compositionId: 'comp_1', graphId: 'g', transitionId: 't1' });
  });

  it('广播状态 → 状态目标；子图带 elementId', () => {
    expect(focusTargetOfEmitter(emitter({
      channel: 'broadcast', compositionId: 'comp_1', graphId: 'g', stateId: 's', elementId: 'el',
    }))).toEqual({ kind: 'state', compositionId: 'comp_1', graphId: 'g', stateId: 's', elementId: 'el' });
  });

  it('对话图/场景那类没有画布坐标 → 走文件跳转', () => {
    expect(focusTargetOfEmitter(emitter())).toBeNull();
  });

  it('黑盒声明定位到那个元素（声明就写在它身上）', () => {
    expect(focusTargetOfDeclaration({
      signal: 's', compositionId: 'comp_1', compositionLabel: '', elementId: 'el_1',
      elementLabel: '', elementKind: 'dialogueBlackbox', refId: '', file: '', pointer: '',
    })).toEqual({ kind: 'element', compositionId: 'comp_1', elementId: 'el_1' });
  });
});

describe('列表行文案', () => {
  it('有中文名就一起显示（真有中文名的那几条最难靠 id 认出来）', () => {
    expect(rowLabel(card({ label: '接活了' }))).toBe('sig（接活了）');
    expect(rowLabel(card())).toBe('sig');
  });

  it('声明那一项说人话，不甩一个孤零零的"声明"', () => {
    expect(countSummary(card({ declarationCount: 2 }))).toBe('发 1 · 听 1 · 另有 2 处只是标注');
  });
});

describe('校验面板点信号类问题', () => {
  it('信号目标 → 给出信号 id（以前点了完全没反应）', () => {
    expect(signalFocusIdOf({ target: { kind: 'signal', signalId: 'sig_x' } })).toBe('sig_x');
  });

  it('别的目标一律不接管（还是走原来的画布定位）', () => {
    expect(signalFocusIdOf({ target: { kind: 'transition', signalId: 'sig_x' } })).toBeNull();
    expect(signalFocusIdOf({})).toBeNull();
  });

  it('空 signalId 不接管，免得开出一个空面板', () => {
    expect(signalFocusIdOf({ target: { kind: 'signal', signalId: '  ' } })).toBeNull();
    expect(signalFocusIdOf({ target: { kind: 'signal' } })).toBeNull();
  });
});

describe('搜索面', () => {
  it('包含 id/名字/注释/两侧', () => {
    const hay = searchHaystack(card({ signal: 'sig_x', label: '接活', notes: '婆子家那段' }));
    expect(hay).toContain('sig_x');
    expect(hay).toContain('接活');
    expect(hay).toContain('婆子家那段');
    expect(hay).toContain('对话_接活');
    expect(hay).toContain('主线');
  });
});

describe('审查打回的几条（2026-08-07）', () => {
  it('「有问题」徽章跟着搜索走，不然徽章说 12、点进去只有 2 条', () => {
    const cards = [
      card({ signal: 'a_bad', diagnostics: [{ code: 'noEmitter', severity: 'warning', message: '' }] }),
      card({ signal: 'b_bad', diagnostics: [{ code: 'noEmitter', severity: 'warning', message: '' }] }),
    ];
    expect(filterSignals(cards, 'problems', '').length).toBe(2);
    expect(filterSignals(cards, 'problems', 'a_bad').length).toBe(1);
  });

  it('关系指纹忽略画布坐标：挪节点不该报「关系可能过期」', () => {
    const base = {
      schemaVersion: 2,
      compositions: [{
        id: 'c',
        mainGraph: {
          id: 'g', ownerType: 'flow', initialState: 'a',
          states: { a: { id: 'a', meta: { editor: { x: 0, y: 0 } } } },
          transitions: [],
        },
      }],
    };
    const moved = JSON.parse(JSON.stringify(base));
    moved.compositions[0].mainGraph.states.a.meta.editor = { x: 999, y: 888 };
    expect(relationFingerprint(moved)).toBe(relationFingerprint(base));

    // 但接线一变，指纹必须变（不然过期提示就成了摆设）
    const rewired = JSON.parse(JSON.stringify(base));
    rewired.compositions[0].mainGraph.transitions.push({ id: 't', from: 'a', to: 'a', signal: 'sig' });
    expect(relationFingerprint(rewired)).not.toBe(relationFingerprint(base));
  });

  it('上游因果里没接线的那条要标出来（占位信号运行时拒发）', () => {
    const c = card({
      emitters: [
        emitter({ channel: 'broadcast' }),
        emitter({ channel: 'upstream', wired: false, context: '这条路还没接线（占位信号，运行时不会发）' }),
      ],
    });
    const { upstream } = splitEmitters(c);
    expect(upstream[0].wired).toBe(false);
    expect(upstream[0].context).toContain('还没接线');
  });
});

describe('状态维度：这一拍谁在看着', () => {
  function stateCard(over: Partial<StateXrefCardDef> = {}): StateXrefCardDef {
    return {
      graphId: 'flow_main', stateId: 's_b', graphLabel: '主线', stateLabel: '接了活',
      compositionId: 'comp_1', compositionLabel: '第一单', elementId: '',
      exists: true, isInitial: false, broadcasts: false, runGraph: false, broadcastSignal: '',
      waysIn: [], waysOut: [], emits: [], readers: [], diagnostics: [],
      wayInCount: 0, wayOutCount: 0, readerCount: 0, emitCount: 0,
      ...over,
    };
  }

  it('行文案说的是图名·拍名，不是裸 id', () => {
    expect(stateHeadline(stateCard())).toBe('主线 · 接了活');
    expect(stateKey(stateCard())).toBe('flow_main.s_b');
  });

  it('副行一眼看出牵连多大', () => {
    expect(stateCountSummary(stateCard({ wayInCount: 2, wayOutCount: 1, readerCount: 12 })))
      .toBe('进 2 · 出 1 · 12 处看着');
    expect(stateCountSummary(stateCard({ broadcasts: true }))).toContain('会广播');
  });

  it('筛选：有问题 / 有人看着 / 会广播', () => {
    const cards = [
      stateCard({ stateId: 'ok' }),
      stateCard({ stateId: 'bad', diagnostics: [{ code: 'stateNoWayIn', severity: 'warning', message: '' }] }),
      stateCard({ stateId: 'watched', readerCount: 3 }),
      stateCard({ stateId: 'cast', broadcasts: true }),
    ];
    expect(filterStates(cards, 'problems', '').map((c) => c.stateId)).toEqual(['bad']);
    expect(filterStates(cards, 'watched', '').map((c) => c.stateId)).toEqual(['watched']);
    expect(filterStates(cards, 'broadcast', '').map((c) => c.stateId)).toEqual(['cast']);
    expect(filterStates(cards, 'all', '')).toHaveLength(4);
  });

  it('搜索面覆盖"谁在看着"——记不住拍名也能靠那个任务找到', () => {
    const card = stateCard({ readers: [stateRead({ containerId: 'q_婆子家', kindLabel: '任务' })] });
    expect(filterStates([card], 'all', 'q_婆子家')).toHaveLength(1);
  });

  it('定位这一拍本身：不存在的幽灵拍不给目标（宁可禁用也不跳空）', () => {
    expect(stateFocusTarget(stateCard())).toEqual({
      kind: 'state', compositionId: 'comp_1', graphId: 'flow_main', stateId: 's_b',
    });
    expect(stateFocusTarget(stateCard({ exists: false }))).toBeNull();
    expect(stateFocusTarget(stateCard({ compositionId: '' }))).toBeNull();
  });

  it('读状态那行定位到它**长在哪**，不是它读的那张图', () => {
    const r = stateRead({
      graphId: 'flow_other', stateId: 's_x',      // 被读的
      compositionId: 'comp_1', hostGraphId: 'flow_main', hostTransitionId: 't_c',
    });
    expect(readerFocusTarget(r)).toEqual({
      kind: 'transition', compositionId: 'comp_1', graphId: 'flow_main', transitionId: 't_c',
    });
  });

  it('长在文件里的读状态行不给画布目标（那类走文件跳转）', () => {
    expect(readerFocusTarget(stateRead({ hostGraphId: '' }))).toBeNull();
  });
});

describe('读状态那一行说的是世界里的东西，不是技术路径', () => {
  it('NPC 说成「场景的NPC「名字」」', () => {
    expect(readerHeadline(stateRead({
      subjectKind: 'npc', subjectKindLabel: 'NPC', subjectDisplay: '庄家来人',
      subjectScene: '雾津街头', kindLabel: '场景',
    }))).toBe('雾津街头的NPC「庄家来人」');
  });

  it('没有主体时退回容器（宁可粗一点也不空着）', () => {
    expect(readerHeadline(stateRead({
      subjectKind: '', subjectKindLabel: '', subjectDisplay: '', containerId: 'q_1', kindLabel: '任务',
    }))).toBe('任务「q_1」');
  });

  it('effect 一行讲清「决定它什么」＋要求到过还是正停在', () => {
    expect(readerEffect(stateRead({ subjectEffect: '出不出现', reached: true })))
      .toBe('出不出现 · 要求到过这一拍');
    expect(readerEffect(stateRead({ subjectEffect: '出不出现', reached: false, negated: true })))
      .toBe('出不出现 · 要求正停在这一拍 · 取反');
  });
});

describe('aggregatePrivateListeners（私有信号的「一条模式」）', () => {
  /** N 张同款 wrapper 图 + 各自的 wrapper 元素；状态 id 带实例名，故意各不相同。 */
  function boxFile(count: number): NarrativeGraphsFileDef {
    return {
      schemaVersion: 3,
      signals: [{ id: 'box_open', scope: 'private' }],
      compositions: [{
        id: 'comp_1',
        mainGraph: {
          id: 'flow_main', ownerType: 'flow', initialState: 'a',
          states: { a: { id: 'a' } }, transitions: [],
        },
        elements: Array.from({ length: count }, (_, i) => ({
          id: `el_box_${i}`,
          kind: 'wrapperGraph',
          ownerType: 'hotspot',
          ownerId: `box_${i}`,
          graph: {
            id: `wrap_box_${i}`,
            ownerType: 'hotspot',
            ownerId: `box_${i}`,
            initialState: `box_${i}_closed`,
            states: { [`box_${i}_closed`]: { id: `box_${i}_closed` }, [`box_${i}_opened`]: { id: `box_${i}_opened` } },
            transitions: [{ id: 't_1', from: `box_${i}_closed`, to: `box_${i}_opened`, signal: 'box_open' }],
          },
        })),
      }],
    } as unknown as NarrativeGraphsFileDef;
  }

  function boxListener(i: number, over: Partial<XrefListenerDef> = {}): XrefListenerDef {
    return listener({
      signal: 'box_open',
      graphId: `wrap_box_${i}`,
      graphLabel: `箱子${i}`,
      elementId: `el_box_${i}`,
      transitionId: 't_1',
      from: `box_${i}_closed`,
      to: `box_${i}_opened`,
      fromLabel: `box_${i}_closed`,
      toLabel: `box_${i}_opened`,
      ...over,
    });
  }

  it('100 张同款 wrapper 收成一条模式（状态 id 各不相同也照样合上）', () => {
    const listeners = Array.from({ length: 100 }, (_, i) => boxListener(i));
    const patterns = aggregatePrivateListeners(listeners, boxFile(100));

    expect(patterns).toHaveLength(1);
    expect(patterns[0]!.count).toBe(100);
    expect(patterns[0]!.sample).toBe(listeners[0]); // 代表行是原对象：画布定位仍落到真实转移
    expect(privatePatternHeadline(patterns[0]!)).toContain('所有绑此类 wrapper 的实体（100 张图）');
    expect(privatePatternTitle(patterns[0]!)).toContain('100 张同款 wrapper 图');
  });

  it('同一张图里长得不一样的两跳仍是两条模式（聚合不许把不同的跳合并）', () => {
    const data = boxFile(2);
    const wrap0 = data.compositions![0]!.elements![0]!.graph!;
    wrap0.states.box_0_broken = { id: 'box_0_broken' };
    wrap0.transitions.push({ id: 't_2', from: 'box_0_opened', to: 'box_0_broken', signal: 'box_open' });

    const patterns = aggregatePrivateListeners(
      [boxListener(0), boxListener(0, { transitionId: 't_2', from: 'box_0_opened', to: 'box_0_broken' })],
      data,
    );
    expect(patterns).toHaveLength(2);
  });

  it('条件不同不合并（同一跳但门槛不同，说成一条就把规则说错了）', () => {
    const patterns = aggregatePrivateListeners(
      [boxListener(0), boxListener(1, { conditions: ['有钥匙'] })],
      boxFile(2),
    );
    expect(patterns).toHaveLength(2);
    expect(patterns.map((p) => p.count)).toEqual([1, 1]);
  });

  it('图不在当前文档里（宿主扫描面更宽）时退回按 id 分组，宁可多分也不合错', () => {
    const patterns = aggregatePrivateListeners(
      [boxListener(0), boxListener(1)],
      { schemaVersion: 3, signals: [], compositions: [] } as unknown as NarrativeGraphsFileDef,
    );
    expect(patterns).toHaveLength(2);
  });

  it('只有一张图时抬头说图名，不说「所有绑此类 wrapper 的实体」', () => {
    const patterns = aggregatePrivateListeners([boxListener(0)], boxFile(1));
    expect(patterns).toHaveLength(1);
    expect(privatePatternHeadline(patterns[0]!)).toBe('箱子0 · box_0_closed → box_0_opened');
    expect(privatePatternTitle(patterns[0]!)).toBe(listenerSubline(patterns[0]!.sample));
  });

  it('空监听面返回空数组（没人听的私有信号不该凭空造一条模式）', () => {
    expect(aggregatePrivateListeners([], boxFile(0))).toEqual([]);
  });
});
