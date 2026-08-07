import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { ActionExecutor } from './ActionExecutor';
import { EventBus } from './EventBus';
import { FlagStore } from './FlagStore';
import {
  NarrativeStateManager,
  type NarrativeBreakpointHit,
  type NarrativeGraph,
} from './NarrativeStateManager';

/**
 * 断点闸的引擎侧契约。这条链上真正会把游戏搞坏的只有两件事：
 * ① 断住期间 onEnter（也就是演出）必须一步都没跑；
 * ② 断住期间读档/跳拍之后，旧时间线不得再把 onEnter 补上（norms 不变量 4）。
 */

const GRAPH: NarrativeGraph = {
  id: 'g',
  ownerType: 'flow',
  initialState: 'a',
  states: {
    a: { id: 'a' },
    b: { id: 'b', onEnterActions: [{ type: 'testMark', params: { id: 'enter-b' } }] },
    c: { id: 'c' },
  },
  transitions: [
    { id: 't_ab', from: 'a', to: 'b', signal: 'go' },
    { id: 't_bc', from: 'b', to: 'c', signal: 'next' },
  ],
};

function makeWorld() {
  const eventBus = new EventBus();
  const flagStore = new FlagStore(eventBus);
  const actionExecutor = new ActionExecutor(eventBus, flagStore);
  const marks: string[] = [];
  actionExecutor.register('testMark', (p) => { marks.push(String(p.id ?? '')); }, ['id']);
  const narrative = new NarrativeStateManager(eventBus, flagStore, actionExecutor);
  narrative.setConditionEvalContextFactory(() => ({
    flagStore,
    questManager: { getStatus: () => 0 } as never,
    scenarioState: {} as never,
    narrativeState: narrative,
  }));
  narrative.setRuntimeValidationMode('off');
  narrative.registerGraphs([JSON.parse(JSON.stringify(GRAPH))]);
  return { eventBus, narrative, marks };
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('叙事断点闸', () => {
  beforeEach(() => { NarrativeStateManager.breakpointGate = null; });
  afterEach(() => { NarrativeStateManager.breakpointGate = null; });

  it('没挂 gate 时行为与从前一致（onEnter 照跑）', async () => {
    const { narrative, marks } = makeWorld();
    narrative.emitNarrativeSignal({ sourceType: 'debug' as never, sourceId: 'x', signal: 'go' });
    await flush(); await flush();
    expect(narrative.getActiveState('g')).toBe('b');
    expect(marks).toEqual(['enter-b']);
  });

  it('断住时：状态已置位、但 onEnter 演出一步没跑；继续后才跑', async () => {
    const { narrative, marks } = makeWorld();
    let release: (() => void) | null = null;
    const hits: NarrativeBreakpointHit[] = [];
    NarrativeStateManager.breakpointGate = (hit) => {
      hits.push(hit);
      return new Promise<void>((r) => { release = r; });
    };

    narrative.emitNarrativeSignal({ sourceType: 'debug' as never, sourceId: 'x', signal: 'go' });
    await flush(); await flush();

    // 断点现场：状态已经是 b（调试器看得到），演出还没开始
    expect(narrative.getActiveState('g')).toBe('b');
    expect(marks).toEqual([]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ graphId: 'g', stateId: 'b', fromStateId: 'a' });
    expect(hits[0].triggerKey).toContain('go');

    release!();
    await flush(); await flush();
    expect(marks).toEqual(['enter-b']);
  });

  it('gate 抛异常不能卡住叙事（调试通道故障绝不影响推进）', async () => {
    const { narrative, marks } = makeWorld();
    NarrativeStateManager.breakpointGate = () => { throw new Error('调试器炸了'); };
    narrative.emitNarrativeSignal({ sourceType: 'debug' as never, sourceId: 'x', signal: 'go' });
    await flush(); await flush();
    expect(narrative.getActiveState('g')).toBe('b');
    expect(marks).toEqual(['enter-b']);
  });

  it('断住期间读档（代际切换）→ 放行后不补跑旧时间线的 onEnter', async () => {
    const { narrative, marks } = makeWorld();
    let release: (() => void) | null = null;
    let armed = true;
    NarrativeStateManager.breakpointGate = () => {
      if (!armed) return Promise.resolve();
      armed = false;
      return new Promise<void>((r) => { release = r; });
    };

    narrative.emitNarrativeSignal({ sourceType: 'debug' as never, sourceId: 'x', signal: 'go' });
    await flush(); await flush();
    expect(narrative.getActiveState('g')).toBe('b');
    expect(marks).toEqual([]);

    // 断住期间读档：调试器的「回到这个存档点」就是这条路，它会自增代际
    narrative.deserialize({ activeStates: { g: 'a' } } as never);
    release!();
    await flush(); await flush();

    // 关键：b 的演出**不能**在放行后补跑——那是旧时间线（norms 不变量 4）
    expect(narrative.getActiveState('g')).toBe('a');
    expect(marks).toEqual([]);
  });

  it('断住期间从调试器跳拍：b 的演出照跑完再跳（排队语义，不是旧时间线）', async () => {
    const { narrative, marks } = makeWorld();
    let release: (() => void) | null = null;
    let armed = true;
    NarrativeStateManager.breakpointGate = () => {
      if (!armed) return Promise.resolve();
      armed = false;
      return new Promise<void>((r) => { release = r; });
    };
    narrative.emitNarrativeSignal({ sourceType: 'debug' as never, sourceId: 'x', signal: 'go' });
    await flush(); await flush();

    // 跳拍是**入队**的：它排在被断住的这一项后面，所以放行后先跑完 b 再跳到 c。
    // 这与"旧时间线"不同——代际没变，b 这一拍是真发生过的。
    void narrative.debugSetNarrativeState('g', 'c');
    await flush();
    release!();
    await flush(); await flush(); await flush();

    expect(narrative.getActiveState('g')).toBe('c');
    expect(marks).toEqual(['enter-b']);
  });

  it('闸可能被**并发**进入：两条链同时断着时必须都能放行（单槽 resolver 会丢掉前一条）', async () => {
    // 现场还原：A 图的 onEnter 里 await 一个外部 promise（真实对应 waitMs 之类），
    // 这期间 B 图被另一条信号推动 → 第二次进闸。两条链同时挂着。
    const eventBus = new EventBus();
    const flagStore = new FlagStore(eventBus);
    const actionExecutor = new ActionExecutor(eventBus, flagStore);
    let releaseAction: (() => void) | null = null;
    actionExecutor.register('testHold', () => new Promise<void>((r) => { releaseAction = r; }), []);
    const narrative = new NarrativeStateManager(eventBus, flagStore, actionExecutor);
    narrative.setConditionEvalContextFactory(() => ({
      flagStore,
      questManager: { getStatus: () => 0 } as never,
      scenarioState: {} as never,
      narrativeState: narrative,
    }));
    narrative.setRuntimeValidationMode('off');
    narrative.registerGraphs([
      {
        id: 'ga', ownerType: 'flow', initialState: 'a0',
        states: { a0: { id: 'a0' }, a1: { id: 'a1', onEnterActions: [{ type: 'testHold', params: {} }] } },
        transitions: [{ id: 'ta', from: 'a0', to: 'a1', signal: 'goA' }],
      },
      {
        id: 'gb', ownerType: 'flow', initialState: 'b0',
        states: { b0: { id: 'b0' }, b1: { id: 'b1' } },
        transitions: [{ id: 'tb', from: 'b0', to: 'b1', signal: 'goB' }],
      },
    ]);

    // 与修好后的 bridge 同语义：**集合**收集 resolver，一次放行全部
    const gates = new Set<() => void>();
    const seen: string[] = [];
    NarrativeStateManager.breakpointGate = (hit) => {
      seen.push(`${hit.graphId}.${hit.stateId}`);
      return new Promise<void>((r) => { gates.add(r); });
    };

    narrative.emitNarrativeSignal({ sourceType: 'debug' as never, sourceId: 'x', signal: 'goA' });
    await flush(); await flush();
    expect(seen).toEqual(['ga.a1']);

    // 断住 A 的同时推 B（真实对应：断住期间 setTimeout 到点、外层链恢复并广播）
    gates.forEach((g) => g());          // 放行 A 的闸 → onEnter 里的 testHold 挂住
    gates.clear();
    await flush();
    narrative.emitNarrativeSignal({ sourceType: 'debug' as never, sourceId: 'x', signal: 'goB' });
    await flush(); await flush();
    expect(seen).toEqual(['ga.a1', 'gb.b1']);
    expect(gates.size).toBe(1);         // B 那条正断着

    // 一次放行全部 + 放行动作 → 两条链都要收口，不能有谁永远挂着
    gates.forEach((g) => g());
    gates.clear();
    releaseAction!();
    await flush(); await flush(); await flush();
    expect(narrative.getActiveState('ga')).toBe('a1');
    expect(narrative.getActiveState('gb')).toBe('b1');
    expect(narrative.isIdle()).toBe(true);   // 队列真的排空了（单槽丢 resolver 时这里恒假）
  });

  it('gate 只在真进状态时被问一次，不在每条 trace 上问', async () => {
    const { narrative } = makeWorld();
    let calls = 0;
    NarrativeStateManager.breakpointGate = () => { calls++; return Promise.resolve(); };
    narrative.emitNarrativeSignal({ sourceType: 'debug' as never, sourceId: 'x', signal: 'go' });
    await flush(); await flush();
    narrative.emitNarrativeSignal({ sourceType: 'debug' as never, sourceId: 'x', signal: '不存在的信号' });
    await flush(); await flush();
    expect(calls).toBe(1);
  });
});
