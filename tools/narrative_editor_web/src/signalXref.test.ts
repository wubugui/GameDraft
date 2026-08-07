import { describe, expect, it } from 'vitest';
import {
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
  signalFocusIdOf,
  splitEmitters,
  worstSeverity,
} from './signalXref';
import type {
  SignalXrefCardDef,
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
    stateReads: [],
    diagnostics: [],
    sourceGraphId: '',
    sourceStateId: '',
    sourceStateLabel: '',
    emitterCount: emitters.filter((e) => e.channel !== 'upstream').length,
    listenerCount: listeners.length,
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
    containerKind: 'quest',
    containerId: 'q_1',
    kindLabel: '任务',
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
