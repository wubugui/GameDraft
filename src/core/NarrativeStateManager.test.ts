import { describe, expect, it, vi } from 'vitest';
import { ActionExecutor } from './ActionExecutor';
import { EventBus } from './EventBus';
import { FlagStore } from './FlagStore';
import { compileNarrativeGraphs, NarrativeStateManager, type NarrativeGraph, type NarrativeGraphsFile } from './NarrativeStateManager';
import { validateNarrativeGraphData } from './narrativeGraphValidation';
import narrativeGraphsData from '../../public/assets/data/narrative_graphs.json';

function makeRuntime() {
  const eventBus = new EventBus();
  const flagStore = new FlagStore(eventBus);
  const actionExecutor = new ActionExecutor(eventBus, flagStore);
  const narrative = new NarrativeStateManager(eventBus, flagStore, actionExecutor);
  narrative.setConditionEvalContextFactory(() => ({
    flagStore,
    questManager: { getStatus: () => 0 } as any,
    scenarioState: {} as any,
    narrativeState: narrative,
  }));
  return { eventBus, flagStore, actionExecutor, narrative };
}

function flush(): Promise<void> {
  return new Promise((resolveFlush) => setTimeout(resolveFlush, 0));
}

describe('NarrativeStateManager', () => {
  it('uses semantic event ids and state-enter keys', () => {
    expect(NarrativeStateManager.normalizeTriggerKey('board_read_done')).toBe('board_read_done');
    expect(NarrativeStateManager.stateEnteredSignalKey('flow', 'done')).toBe('state:flow:done');
    expect(NarrativeStateManager.triggerKeysEqual('go', 'go')).toBe(true);
  });

  it('tracks reached states across transitions (initial counts, history persists)', async () => {
    const { narrative } = makeRuntime();
    narrative.registerGraphs([{
      id: 'g',
      ownerType: 'flow',
      initialState: 'a',
      states: { a: { id: 'a' }, b: { id: 'b' }, c: { id: 'c' } },
      transitions: [
        { id: 't1', from: 'a', to: 'b', signal: 'go1' },
        { id: 't2', from: 'b', to: 'c', signal: 'go2' },
      ],
    }]);
    expect(narrative.hasReachedState('g', 'a')).toBe(true);
    expect(narrative.hasReachedState('g', 'b')).toBe(false);
    narrative.emitNarrativeSignal({ sourceType: 'system', sourceId: 't', signal: 'go1' });
    await flush();
    narrative.emitNarrativeSignal({ sourceType: 'system', sourceId: 't', signal: 'go2' });
    await flush();
    expect(narrative.getActiveState('g')).toBe('c');
    // 已离开的状态仍视为「到达过」——线性流程的里程碑门控语义
    expect(narrative.hasReachedState('g', 'a')).toBe(true);
    expect(narrative.hasReachedState('g', 'b')).toBe(true);
    expect(narrative.hasReachedState('g', 'c')).toBe(true);
    expect(narrative.hasReachedState('g', 'nope')).toBe(false);
  });

  it('serializes reached states and backfills legacy saves from activeState', async () => {
    const { narrative } = makeRuntime();
    const graphs = [{
      id: 'g',
      ownerType: 'flow' as const,
      initialState: 'a',
      states: { a: { id: 'a' }, b: { id: 'b' }, c: { id: 'c' } },
      transitions: [
        { id: 't1', from: 'a', to: 'b', signal: 'go1' },
        { id: 't2', from: 'b', to: 'c', signal: 'go2' },
      ],
    }];
    narrative.registerGraphs(graphs);
    narrative.emitNarrativeSignal({ sourceType: 'system', sourceId: 't', signal: 'go1' });
    await flush();
    const saved = JSON.parse(JSON.stringify(narrative.serialize()));

    const fresh = makeRuntime().narrative;
    fresh.registerGraphs(graphs);
    fresh.deserialize(saved);
    expect(fresh.getActiveState('g')).toBe('b');
    expect(fresh.hasReachedState('g', 'a')).toBe(true);
    expect(fresh.hasReachedState('g', 'b')).toBe(true);
    expect(fresh.hasReachedState('g', 'c')).toBe(false);

    // 旧档：只有 activeStates，无 reachedStates —— 回填 initial + 当前态
    const legacy = makeRuntime().narrative;
    legacy.registerGraphs(graphs);
    legacy.deserialize({ activeStates: { g: 'c' } });
    expect(legacy.hasReachedState('g', 'c')).toBe(true);
    expect(legacy.hasReachedState('g', 'a')).toBe(true);
  });

  it('resets live progress before restoring an older save (deserialize does not leak future states)', async () => {
    const graphs: NarrativeGraph[] = [{
      id: 'g',
      ownerType: 'flow' as const,
      initialState: 'a',
      states: { a: { id: 'a' }, b: { id: 'b' }, c: { id: 'c' } },
      transitions: [
        { id: 't1', from: 'a', to: 'b', signal: 'go1' },
        { id: 't2', from: 'b', to: 'c', signal: 'go2' },
      ],
    }, {
      id: 'other',
      ownerType: 'flow' as const,
      initialState: 'x',
      states: { x: { id: 'x' }, y: { id: 'y' } },
      transitions: [{ id: 't', from: 'x', to: 'y', signal: 'go1' }],
    }];
    const { narrative } = makeRuntime();
    narrative.registerGraphs(graphs);
    await narrative.emitNarrativeSignal({ sourceType: 'system', sourceId: 't', signal: 'go1' });
    await flush();
    // 早期存档：g 停在 b，other 尚未进档（模拟旧档缺图）
    const earlySave = JSON.parse(JSON.stringify(narrative.serialize()));
    delete earlySave.activeStates.other;
    delete earlySave.reachedStates.other;

    await narrative.emitNarrativeSignal({ sourceType: 'system', sourceId: 't', signal: 'go2' });
    await flush();
    expect(narrative.getActiveState('g')).toBe('c');
    expect(narrative.getActiveState('other')).toBe('y');

    // 会中读更早的档：本会话越过的 c 不得残留为「到达过」，未入档的图回到 initialState
    narrative.deserialize(earlySave);
    expect(narrative.getActiveState('g')).toBe('b');
    expect(narrative.hasReachedState('g', 'b')).toBe(true);
    expect(narrative.hasReachedState('g', 'c')).toBe(false);
    expect(narrative.getActiveState('other')).toBe('x');
    expect(narrative.hasReachedState('other', 'y')).toBe(false);
    expect(narrative.hasReachedState('other', 'x')).toBe(true);
  });

  it('matches transitions by active state, trigger key, priority, and conditions', async () => {
    const { flagStore, narrative } = makeRuntime();
    flagStore.set('ready', true);
    narrative.registerGraphs([{
      id: 'g',
      ownerType: 'flow',
      initialState: 'a',
      states: { a: { id: 'a' }, b: { id: 'b' }, c: { id: 'c' } },
      transitions: [
        { id: 'low', from: 'a', to: 'b', signal: 'go', priority: 0 },
        {
          id: 'high',
          from: 'a',
          to: 'c',
          signal: 'go',
          priority: 5,
          conditions: [{ flag: 'ready', value: true }],
        },
      ],
    }]);
    narrative.emitNarrativeSignal({ sourceType: 'system', sourceId: 'test', signal: 'go' });
    await flush();
    expect(narrative.getActiveState('g')).toBe('c');
  });

  it('runs each graph at most once per trigger and cascades graph-state broadcasts', async () => {
    const { narrative } = makeRuntime();
    narrative.registerGraphs([
      {
        id: 'flow',
        ownerType: 'flow',
        initialState: 'initial',
        states: { initial: { id: 'initial' }, done: { id: 'done', broadcastOnEnter: true } },
        transitions: [{ id: 'finish', from: 'initial', to: 'done', signal: 'done' }],
      },
      {
        id: 'npc',
        ownerType: 'npc',
        initialState: 'before',
        states: { before: { id: 'before' }, after: { id: 'after' } },
        transitions: [{ id: 'after', from: 'before', to: 'after', signal: 'state:flow:done' }],
      },
    ]);
    await narrative.emitNarrativeSignal({ sourceType: 'system', sourceId: 'test', signal: 'done' });
    expect(narrative.getActiveState('flow')).toBe('done');
    expect(narrative.getActiveState('npc')).toBe('after');
  });

  it('records a structured runtime trace for signals, transitions, actions, and broadcasts', async () => {
    const { actionExecutor, flagStore, narrative } = makeRuntime();
    actionExecutor.register('markTraceAction', () => {
      flagStore.set('trace.action', true);
    }, []);
    narrative.registerGraphs([
      {
        id: 'flow',
        ownerType: 'flow',
        initialState: 'initial',
        states: {
          initial: { id: 'initial' },
          done: {
            id: 'done',
            broadcastOnEnter: true,
            onEnterActions: [{ type: 'markTraceAction', params: {} }],
          },
        },
        transitions: [{ id: 'finish', from: 'initial', to: 'done', signal: 'done' }],
      },
      {
        id: 'npc',
        ownerType: 'npc',
        initialState: 'before',
        states: { before: { id: 'before' }, after: { id: 'after' } },
        transitions: [{ id: 'after', from: 'before', to: 'after', signal: 'state:flow:done' }],
      },
    ]);

    await narrative.emitNarrativeSignal({ sourceType: 'system', sourceId: 'test', signal: 'done' });

    const snapshot = narrative.debugSnapshot() as { recentTrace: Array<{ type: string; graphId?: string; triggerKey?: string }> };
    const types = snapshot.recentTrace.map((event) => event.type);
    expect(types).toContain('signal.received');
    expect(types).toContain('trigger.enqueued');
    expect(types).toContain('transition.applied');
    expect(types).toContain('actions.start');
    expect(types).toContain('actions.end');
    expect(types).toContain('signal.broadcast');
    expect(snapshot.recentTrace.some((event) => event.type === 'transition.applied' && event.graphId === 'npc')).toBe(true);

    narrative.clearDebugTrace();
    const cleared = narrative.debugSnapshot() as { recentTrace: unknown[]; traceLength: number };
    expect(cleared.recentTrace).toEqual([]);
    expect(cleared.traceLength).toBe(0);
  });

  it('does not cascade derived state broadcast when broadcastOnEnter is false', async () => {
    const { narrative } = makeRuntime();
    narrative.registerGraphs([
      {
        id: 'flow',
        ownerType: 'flow',
        initialState: 'initial',
        states: { initial: { id: 'initial' }, done: { id: 'done' } },
        transitions: [{ id: 'finish', from: 'initial', to: 'done', signal: 'done' }],
      },
      {
        id: 'npc',
        ownerType: 'npc',
        initialState: 'before',
        states: { before: { id: 'before' }, after: { id: 'after' } },
        transitions: [{ id: 'after', from: 'before', to: 'after', signal: 'state:flow:done' }],
      },
    ]);
    await narrative.emitNarrativeSignal({ sourceType: 'system', sourceId: 'test', signal: 'done' });
    await flush();
    expect(narrative.getActiveState('flow')).toBe('done');
    expect(narrative.getActiveState('npc')).toBe('before');
  });

  it('does not match draft signal transitions', async () => {
    const { narrative } = makeRuntime();
    narrative.registerGraphs([{
      id: 'g',
      ownerType: 'flow',
      initialState: 'a',
      states: { a: { id: 'a' }, b: { id: 'b' } },
      transitions: [{ id: 't', from: 'a', to: 'b', signal: '__draft__' }],
    }]);
    await narrative.emitNarrativeSignal({ signal: '__draft__' });
    await flush();
    expect(narrative.getActiveState('g')).toBe('a');
  });

  it('allows lifecycle actions to await queued narrative state commands', async () => {
    const { actionExecutor, flagStore, narrative } = makeRuntime();
    actionExecutor.register('setAuxAndRecord', async () => {
      await narrative.debugSetNarrativeState('aux', 'on');
      flagStore.set('aux.afterAwait', narrative.getActiveState('aux') ?? '');
    }, []);
    narrative.registerGraphs([
      {
        id: 'flow',
        ownerType: 'flow',
        initialState: 'a',
        states: {
          a: { id: 'a' },
          b: { id: 'b', onEnterActions: [{ type: 'setAuxAndRecord', params: {} }] },
        },
        transitions: [{ id: 'go', from: 'a', to: 'b', signal: 'go' }],
      },
      {
        id: 'aux',
        ownerType: 'flow',
        initialState: 'off',
        states: { off: { id: 'off' }, on: { id: 'on' } },
        transitions: [],
      },
    ]);

    await narrative.emitNarrativeSignal({ sourceType: 'system', sourceId: 'test', signal: 'go' });

    expect(narrative.getActiveState('flow')).toBe('b');
    expect(narrative.getActiveState('aux')).toBe('on');
    expect(flagStore.get('aux.afterAwait')).toBe('on');
  });

  it('keeps the transition result when lifecycle actions fail', async () => {
    const { actionExecutor, narrative } = makeRuntime();
    actionExecutor.register('boom', () => {
      throw new Error('expected');
    }, []);
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    narrative.registerGraphs([{
      id: 'g',
      ownerType: 'flow',
      initialState: 'a',
      states: {
        a: { id: 'a' },
        b: { id: 'b', onEnterActions: [{ type: 'boom', params: {} }] },
      },
      transitions: [{ id: 'go', from: 'a', to: 'b', signal: 'go' }],
    }]);
    narrative.emitNarrativeSignal({ sourceType: 'system', sourceId: 'test', signal: 'go' });
    await flush();
    expect(narrative.getActiveState('g')).toBe('b');
    spy.mockRestore();
  });

  it('ignores deprecated projectFlags at runtime', async () => {
    const { flagStore, narrative } = makeRuntime();
    narrative.registerGraphs([{
      id: 'g',
      ownerType: 'flow',
      initialState: 'a',
      projectFlags: true,
      states: { a: { id: 'a' }, b: { id: 'b' } },
      transitions: [{ id: 'go', from: 'a', to: 'b', signal: 'go' }],
    }]);
    narrative.emitNarrativeSignal({ sourceType: 'system', sourceId: 'test', signal: 'go' });
    await flush();
    expect(flagStore.get('narrative.g.b.active')).toBeUndefined();
    expect(narrative.getActiveState('g')).toBe('b');
  });

  it('indexes graphs by owner binding for entity systems', async () => {
    const { narrative } = makeRuntime();
    narrative.registerGraphs([{
      id: 'npc_ringboy',
      ownerType: 'npc',
      ownerId: 'npc_ringboy',
      initialState: 'before_event',
      states: { before_event: { id: 'before_event' }, after_event: { id: 'after_event' } },
      transitions: [{ id: 'go', from: 'before_event', to: 'after_event', signal: 'go' }],
    }]);
    expect(narrative.getGraphIdsByOwner('npc', 'npc_ringboy')).toEqual(['npc_ringboy']);
    expect(narrative.getGraphsByOwner('npc', 'npc_ringboy')[0]?.id).toBe('npc_ringboy');
    expect(narrative.getPrimaryGraphByOwner('npc', 'npc_ringboy')?.id).toBe('npc_ringboy');

    narrative.emitNarrativeSignal({ sourceType: 'system', sourceId: 'test', signal: 'go' });
    await flush();
    expect(narrative.getActiveStatesByOwner('npc', 'npc_ringboy')).toEqual({ npc_ringboy: 'after_event' });
    expect(narrative.getPrimaryActiveStateByOwner('npc', 'npc_ringboy')).toBe('after_event');
    expect(narrative.isOwnerStateActive('npc', 'npc_ringboy', 'after_event')).toBe(true);
  });

  it('keeps primary owner lookup undefined when owner has multiple wrappers', () => {
    const { narrative } = makeRuntime();
    narrative.registerGraphs([
      {
        id: 'npc_ringboy_a',
        ownerType: 'npc',
        ownerId: 'npc_ringboy',
        category: '剧情A',
        initialState: 'before_event',
        states: { before_event: { id: 'before_event' } },
        transitions: [],
      },
      {
        id: 'npc_ringboy_b',
        ownerType: 'npc',
        ownerId: 'npc_ringboy',
        category: '剧情B',
        initialState: 'before_event',
        states: { before_event: { id: 'before_event' } },
        transitions: [],
      },
    ]);

    expect(narrative.getGraphIdsByOwner('npc', 'npc_ringboy')).toEqual(['npc_ringboy_a', 'npc_ringboy_b']);
    expect(narrative.getPrimaryGraphByOwner('npc', 'npc_ringboy')).toBeUndefined();
    expect(narrative.getPrimaryActiveStateByOwner('npc', 'npc_ringboy')).toBeUndefined();
    expect(narrative.isOwnerStateActive('npc', 'npc_ringboy', 'before_event')).toBe(false);
    const snapshot = JSON.stringify(narrative.debugSnapshot());
    expect(snapshot).toContain('owner.wrapper.multi');
    expect(snapshot).toContain('owner.primary.ambiguous');
  });

  it('rejects legacy cross-graph transition endpoints at runtime', async () => {
    const { narrative } = makeRuntime();
    narrative.registerGraphs([
      {
        id: 'flow',
        ownerType: 'flow',
        initialState: 'ready',
        states: { ready: { id: 'ready' }, done: { id: 'done' } },
        transitions: [
          {
            id: 'enter_scenario',
            from: 'ready',
            to: { graphId: 'scenario', stateId: 'entry' },
            signal: 'enter',
          } as any,
        ],
      },
      {
        id: 'scenario',
        ownerType: 'scenario',
        ownerId: 'local_scene',
        initialState: 'inactive',
        entryState: 'entry',
        exitStates: ['exit'],
        states: { inactive: { id: 'inactive' }, entry: { id: 'entry' }, exit: { id: 'exit' } },
        transitions: [
          {
            id: 'leave_scenario',
            from: 'exit',
            to: { graphId: 'flow', stateId: 'done' },
            signal: 'leave',
          } as any,
        ],
      },
    ]);

    await narrative.emitNarrativeSignal({ sourceType: 'system', sourceId: 'test', signal: 'enter' });
    await flush();
    expect(narrative.getActiveState('flow')).toBe('ready');
    expect(narrative.getActiveState('scenario')).toBe('inactive');

    await narrative.debugSetNarrativeState('scenario', 'exit');
    await flush();
    await narrative.emitNarrativeSignal({ sourceType: 'system', sourceId: 'test', signal: 'leave' });
    await flush();
    expect(narrative.getActiveState('scenario')).toBe('exit');
    expect(narrative.getActiveState('flow')).toBe('ready');
    expect(JSON.stringify(narrative.debugSnapshot())).toContain('transition.crossGraphEndpoint.unsupported');
  });

  it('rejects runtime scenario boundary violations', async () => {
    const { narrative } = makeRuntime();
    narrative.registerGraphs([
      {
        id: 'flow',
        ownerType: 'flow',
        initialState: 'ready',
        states: { ready: { id: 'ready' } },
        transitions: [
          {
            id: 'bad_enter',
            from: 'ready',
            to: { graphId: 'scenario', stateId: 'middle' },
            signal: 'enter',
          } as any,
        ],
      },
      {
        id: 'scenario',
        ownerType: 'scenario',
        ownerId: 'local_scene',
        initialState: 'inactive',
        entryState: 'entry',
        exitStates: ['exit'],
        states: {
          inactive: { id: 'inactive' },
          entry: { id: 'entry' },
          middle: { id: 'middle' },
          exit: { id: 'exit' },
        },
        transitions: [],
      },
    ]);

    await narrative.emitNarrativeSignal({ sourceType: 'system', sourceId: 'test', signal: 'enter' });
    expect(narrative.getActiveState('scenario')).toBe('inactive');
    await narrative.debugSetNarrativeState('scenario', 'middle');
    expect(narrative.getActiveState('scenario')).toBe('inactive');
    const snapshot = narrative.debugSnapshot();
    expect(JSON.stringify(snapshot)).toContain('transition.crossGraphEndpoint.unsupported');
  });

  it('skips a duplicate graph id gracefully and records an error issue (no hard crash)', () => {
    const { narrative } = makeRuntime();
    const graph = {
      id: 'dup',
      ownerType: 'flow' as const,
      initialState: 'a',
      states: { a: { id: 'a' } },
      transitions: [],
    };
    // 编辑器保存校验已阻止重复 id；运行时遇到重复 id 应优雅降级（保留先注册的、跳过重复、
    // 记录 error 供暴露），而非在启动时 throw 崩掉整套叙事系统。
    expect(() => narrative.registerGraphs([graph, { ...graph }])).not.toThrow();
    expect(narrative.getActiveState('dup')).toBe('a');
    expect(JSON.stringify(narrative.debugSnapshot())).toContain('graph.id.duplicate');
  });

  it('lets nested state commands await their actual application', async () => {
    const { actionExecutor, narrative } = makeRuntime();
    let observed = '';
    actionExecutor.register('queueSetC', async () => {
      await narrative.debugSetNarrativeState('g', 'c');
      observed = narrative.getActiveState('g') ?? '';
    }, []);
    narrative.registerGraphs([{
      id: 'g',
      ownerType: 'flow',
      initialState: 'a',
      states: {
        a: { id: 'a' },
        b: { id: 'b', onEnterActions: [{ type: 'queueSetC', params: {} }] },
        c: { id: 'c' },
      },
      transitions: [{ id: 'go', from: 'a', to: 'b', signal: 'go' }],
    }]);

    await narrative.emitNarrativeSignal({ sourceType: 'system', sourceId: 'test', signal: 'go' });
    expect(observed).toBe('c');
    expect(narrative.getActiveState('g')).toBe('c');
  });

  it('throws on narrative graph load failure in dev/test mode', async () => {
    const { narrative } = makeRuntime();
    await expect(narrative.loadFromAsset({
      loadJson: async () => { throw new Error('bad asset'); },
    } as any)).rejects.toThrow('bad asset');
    expect(JSON.stringify(narrative.debugSnapshot())).toContain('narrative.load.failed');
  });

  it('can run shared validation in throw mode while loading narrative data', async () => {
    const { narrative } = makeRuntime();
    narrative.setRuntimeValidationMode('throw');
    await expect(narrative.loadFromAsset({
      loadJson: async () => ({
        schemaVersion: 3,
        signals: [{ id: 'go' }],
        compositions: [{
          id: 'comp',
          mainGraph: {
            id: 'flow',
            ownerType: 'flow',
            initialState: 'a',
            states: { a: { id: 'a' }, b: { id: 'b' } },
            transitions: [{ id: 'bad', from: 'a', to: 'missing', signal: 'go' }],
          },
          elements: [],
        }],
      }),
    } as any)).rejects.toThrow(/validation found/);
    expect(JSON.stringify(narrative.debugSnapshot())).toContain('transition.to.missing');
  });

  it('can turn runtime narrative validation off', async () => {
    const { narrative } = makeRuntime();
    narrative.setRuntimeValidationMode('off');
    await narrative.loadFromAsset({
      loadJson: async () => ({
        schemaVersion: 3,
        signals: [{ id: 'go' }],
        compositions: [{
          id: 'comp',
          mainGraph: {
            id: 'flow',
            ownerType: 'flow',
            initialState: 'a',
            states: { a: { id: 'a' }, b: { id: 'b' } },
            transitions: [{ id: 'bad', from: 'a', to: 'missing', signal: 'go' }],
          },
          elements: [],
        }],
      }),
    } as any);
    expect(JSON.stringify(narrative.debugSnapshot())).not.toContain('transition.to.missing');
    expect(narrative.getActiveState('flow')).toBe('a');
  });

  it('loads the real dock water monkey chain data', async () => {
    const { narrative } = makeRuntime();
    const raw = narrativeGraphsData as unknown as NarrativeGraphsFile;
    const graphs = compileNarrativeGraphs(raw);
    // 真实数据会随内容迭代增长：只断言验证链所需的图存在（不耦合内容数量）
    expect(graphs.map((g) => g.id)).toEqual(expect.arrayContaining([
      'flow_dock_water_monkey',
      'npc_ringboy',
      'quest_return_ring',
      'flow_xungou_main',
    ]));
    narrative.registerGraphs(graphs);
    narrative.emitNarrativeSignal({ sourceType: 'dialogue', sourceId: 'dock_board', signal: 'board_read_done' });
    await flush();
    narrative.emitNarrativeSignal({ sourceType: 'zone', sourceId: 'waterside', signal: 'entered' });
    await flush();
    narrative.emitNarrativeSignal({ sourceType: 'minigame', sourceId: 'dock_crate_tutorial', signal: 'pull_success' });
    await flush();
    await flush();
    narrative.emitNarrativeSignal({ sourceType: 'dialogue', sourceId: 'rolling_ring_boy', signal: 'ring_taken' });
    await flush();
    await flush();
    expect(narrative.getActiveState('flow_dock_water_monkey')).toBe('crate_minigame_done');
    expect(narrative.getActiveState('npc_ringboy')).toBe('ring_taken');
    expect(narrative.getActiveState('quest_return_ring')).toBe('active');
  });

  it('serializes and deserializes activeStates', async () => {
    const { narrative } = makeRuntime();
    narrative.registerGraphs([{
      id: 'g',
      ownerType: 'flow',
      initialState: 'a',
      states: { a: { id: 'a' }, b: { id: 'b' } },
      transitions: [{ id: 'go', from: 'a', to: 'b', signal: 'go' }],
    }]);
    await narrative.emitNarrativeSignal({ sourceType: 'system', sourceId: 'test', signal: 'go' });
    await flush();
    expect(narrative.getActiveState('g')).toBe('b');
    // v2 存档：v1 兼容字段（activeStates/reachedStates，仅常驻图）照旧携带，另有活计层三字段 + 章节包 live 集。
    expect(narrative.serialize()).toEqual({
      version: 2,
      activeStates: { g: 'b' },
      reachedStates: { g: ['a', 'b'] },
      runs: {},
      counters: {},
      activatedArchetype: null,
      livePackages: [],
    });

    narrative.deserialize({ activeStates: { g: 'a' } });
    expect(narrative.getActiveState('g')).toBe('a');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    narrative.deserialize({ activeStates: { g: 'missing', other: 'x' } });
    expect(narrative.getActiveState('g')).toBe('a');
    warn.mockRestore();
  });

  it('warns by name instead of silently dropping unknown save entries', async () => {
    const { narrative } = makeRuntime();
    narrative.registerGraphs([{
      id: 'g',
      ownerType: 'flow',
      initialState: 'a',
      states: { a: { id: 'a' }, b: { id: 'b' } },
      transitions: [{ id: 'go', from: 'a', to: 'b', signal: 'go' }],
    }]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    narrative.deserialize({
      activeStates: { gone_graph: 'x', g: 'renamed_away' },
      reachedStates: { gone_graph: ['x', 'y'], g: ['a', 'renamed_away'] },
    });
    const messages = warn.mock.calls.map((c) => String(c[0]));
    warn.mockRestore();

    // active：删掉的图 / 改名的状态各点名一次，并说明后果
    expect(messages.some((m) => m.includes('unknown narrative graph "gone_graph"') && m.includes('dropped active state "x"'))).toBe(true);
    expect(messages.some((m) => m.includes('unknown state "renamed_away"') && m.includes('graph "g"') && m.includes('initialState "a"'))).toBe(true);
    // reached：同样点名，说明门控回锁
    expect(messages.some((m) => m.includes('unknown narrative graph "gone_graph"') && m.includes('reached states [x, y]'))).toBe(true);
    expect(messages.some((m) => m.includes('unknown state "renamed_away"') && m.includes('dropped from reached states'))).toBe(true);

    // 留痕进 recentIssues（debugSnapshot 可见）
    const issues = (narrative.debugSnapshot().recentIssues as Array<{ code: string }>).map((i) => i.code);
    expect(issues).toContain('save.active.graphMissing');
    expect(issues).toContain('save.active.stateMissing');
    expect(issues).toContain('save.reached.graphMissing');
    expect(issues).toContain('save.reached.stateMissing');

    // 丢弃后的兜底行为不变：g 回到 initialState，合法的 reached 条目仍恢复
    expect(narrative.getActiveState('g')).toBe('a');
    expect(narrative.hasReachedState('g', 'a')).toBe(true);
    expect(narrative.hasReachedState('g', 'renamed_away')).toBe(false);
  });

  it('remaps renamed graphs and states from old saves via migrations', () => {
    const { narrative } = makeRuntime();
    narrative.registerGraphs([{
      id: 'g2',
      ownerType: 'flow',
      initialState: 'start',
      states: { start: { id: 'start' }, done_v2: { id: 'done_v2' } },
      transitions: [{ id: 'go', from: 'start', to: 'done_v2', signal: 'go' }],
    }]);
    // 图 g1→g2 改名 + 状态 done→done_v2 改名（states 外层键用改名后的新图 id）
    narrative.setSaveMigrations({
      graphs: { g1: 'g2' },
      states: { g2: { done: 'done_v2' } },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    narrative.deserialize({
      activeStates: { g1: 'done' },
      reachedStates: { g1: ['start', 'done'] },
    });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    expect(narrative.getActiveState('g2')).toBe('done_v2');
    expect(narrative.hasReachedState('g2', 'start')).toBe(true);
    expect(narrative.hasReachedState('g2', 'done_v2')).toBe(true);
  });

  it('wires migrations from the data file via loadFromAsset', async () => {
    const { narrative } = makeRuntime();
    const file: NarrativeGraphsFile = {
      schemaVersion: 3,
      migrations: { graphs: { old_flow: 'flow_x' } },
      compositions: [{
        id: 'c',
        mainGraph: {
          id: 'flow_x',
          ownerType: 'flow',
          initialState: 'start',
          states: { start: { id: 'start' }, done: { id: 'done' } },
          transitions: [{ id: 'go', from: 'start', to: 'done', signal: 'go' }],
        },
      }],
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await narrative.loadFromAsset({ loadJson: async () => file } as unknown as import('./AssetManager').AssetManager);
    narrative.deserialize({ activeStates: { old_flow: 'done' } });
    warn.mockRestore();
    expect(narrative.getActiveState('flow_x')).toBe('done');
  });

  it('validator flags dangling or shadowed migration mappings as warnings', () => {
    const issues = validateNarrativeGraphData({
      signals: [],
      compositions: [{
        id: 'c',
        mainGraph: {
          id: 'g',
          ownerType: 'flow',
          initialState: 'a',
          states: { a: { id: 'a' } },
          transitions: [],
        },
      }],
      migrations: {
        graphs: { old: 'nope', g: 'g' },
        states: { g: { gone: 'nope2', a: 'a' }, ghost: { x: 'y' } },
      },
    });
    const codes = issues.map((i) => i.code);
    expect(codes).toContain('migrations.graph.target.missing');
    expect(codes).toContain('migrations.graph.source.stillExists');
    expect(codes).toContain('migrations.state.target.missing');
    expect(codes).toContain('migrations.state.source.stillExists');
    expect(codes).toContain('migrations.states.graph.missing');
    expect(issues.filter((i) => i.code.startsWith('migrations.')).every((i) => i.severity === 'warning')).toBe(true);
  });

  it('restores activeStates on a fresh manager via deserialize', async () => {
    const graph = {
      id: 'g',
      ownerType: 'flow' as const,
      initialState: 'a',
      states: { a: { id: 'a' }, b: { id: 'b' } },
      transitions: [{ id: 'go', from: 'a', to: 'b', signal: 'go' }],
    };
    const first = makeRuntime();
    first.narrative.registerGraphs([graph]);
    await first.narrative.emitNarrativeSignal({ sourceType: 'system', sourceId: 'test', signal: 'go' });
    await flush();
    const payload = first.narrative.serialize();

    const second = makeRuntime();
    second.narrative.registerGraphs([graph]);
    expect(second.narrative.getActiveState('g')).toBe('a');
    second.narrative.deserialize(payload);
    expect(second.narrative.getActiveState('g')).toBe('b');
  });

  it('does not migrate when trigger signal does not match any transition', async () => {
    const { narrative } = makeRuntime();
    narrative.registerGraphs([{
      id: 'g',
      ownerType: 'flow',
      initialState: 'a',
      states: { a: { id: 'a' }, b: { id: 'b' } },
      transitions: [{ id: 'go', from: 'a', to: 'b', signal: 'expected' }],
    }]);
    await narrative.emitNarrativeSignal({ sourceType: 'system', sourceId: 'test', signal: 'wrong' });
    await flush();
    expect(narrative.getActiveState('g')).toBe('a');
  });

  it('does not migrate when every transition.from mismatches active state', async () => {
    const { narrative } = makeRuntime();
    narrative.registerGraphs([{
      id: 'g',
      ownerType: 'flow',
      initialState: 'a',
      states: { a: { id: 'a' }, b: { id: 'b' }, c: { id: 'c' } },
      transitions: [
        { id: 'only_b', from: 'b', to: 'c', signal: 'go' },
        { id: 'only_c', from: 'c', to: 'b', signal: 'go' },
      ],
    }]);
    await narrative.emitNarrativeSignal({ sourceType: 'system', sourceId: 'test', signal: 'go' });
    await flush();
    expect(narrative.getActiveState('g')).toBe('a');
  });

  it('does not migrate when active state does not match transition.from', async () => {
    const { narrative } = makeRuntime();
    narrative.registerGraphs([{
      id: 'g',
      ownerType: 'flow',
      initialState: 'a',
      states: { a: { id: 'a' }, b: { id: 'b' }, c: { id: 'c' } },
      transitions: [
        { id: 'wrong_from', from: 'b', to: 'c', signal: 'go' },
        { id: 'right_from', from: 'a', to: 'b', signal: 'go' },
      ],
    }]);
    await narrative.emitNarrativeSignal({ sourceType: 'system', sourceId: 'test', signal: 'go' });
    await flush();
    expect(narrative.getActiveState('g')).toBe('b');
  });

  it('runs onExit before onEnter during a transition', async () => {
    const { actionExecutor, narrative } = makeRuntime();
    const order: string[] = [];
    actionExecutor.register('markExit', async () => { order.push('exit'); }, []);
    actionExecutor.register('markEnter', async () => { order.push('enter'); }, []);
    narrative.registerGraphs([{
      id: 'g',
      ownerType: 'flow',
      initialState: 'a',
      states: {
        a: { id: 'a', onExitActions: [{ type: 'markExit', params: {} }] },
        b: { id: 'b', onEnterActions: [{ type: 'markEnter', params: {} }] },
      },
      transitions: [{ id: 'go', from: 'a', to: 'b', signal: 'go' }],
    }]);
    await narrative.emitNarrativeSignal({ sourceType: 'system', sourceId: 'test', signal: 'go' });
    await flush();
    expect(order).toEqual(['exit', 'enter']);
  });

  it('reactiveAll fires when all conditions are met, without needing a signal', async () => {
    const { flagStore, narrative } = makeRuntime();
    flagStore.set('quest_a', true);
    flagStore.set('quest_b', true);
    narrative.registerGraphs([{
      id: 'flow',
      ownerType: 'flow',
      initialState: 'waiting',
      states: { waiting: { id: 'waiting' }, done: { id: 'done' } },
      transitions: [{
        id: 'all_done',
        from: 'waiting',
        to: 'done',
        signal: '__draft__',
        trigger: 'reactiveAll',
        conditions: [
          { flag: 'quest_a', value: true },
          { flag: 'quest_b', value: true },
        ],
      }],
    }]);
    // Transition should fire on register since both flags are already true
    await flush();
    expect(narrative.getActiveState('flow')).toBe('done');
  });

  it('reactiveAll does not fire when not all conditions are met', async () => {
    const { flagStore, narrative } = makeRuntime();
    flagStore.set('quest_a', true);
    narrative.registerGraphs([{
      id: 'flow',
      ownerType: 'flow',
      initialState: 'waiting',
      states: { waiting: { id: 'waiting' }, done: { id: 'done' } },
      transitions: [{
        id: 'all_done',
        from: 'waiting',
        to: 'done',
        signal: '__draft__',
        trigger: 'reactiveAll',
        conditions: [
          { flag: 'quest_a', value: true },
          { flag: 'quest_b', value: true },
        ],
      }],
    }]);
    await flush();
    expect(narrative.getActiveState('flow')).toBe('waiting');

    // flag:changed 直接唤醒 reactive 重评，无需再发一个无关信号
    flagStore.set('quest_b', true);
    await flush();
    expect(narrative.getActiveState('flow')).toBe('done');
  });

  it('re-evaluates reactive transitions after deserialize (no extra signal needed)', async () => {
    const graphs = [{
      id: 'g',
      ownerType: 'flow' as const,
      initialState: 'a',
      states: { a: { id: 'a' }, b: { id: 'b' }, c: { id: 'c' } },
      transitions: [
        { id: 'go', from: 'a', to: 'b', signal: 'go' },
        {
          id: 'auto',
          from: 'b',
          to: 'c',
          signal: '__draft__',
          trigger: 'reactiveAll' as const,
          conditions: [{ flag: 'ready', value: true }],
        },
      ],
    }];
    const { flagStore, narrative } = makeRuntime();
    narrative.registerGraphs(graphs);
    // ready 先置真：此刻 active=a，b→c 的 reactive 不该触发
    flagStore.set('ready', true);
    await flush();
    expect(narrative.getActiveState('g')).toBe('a');
    // 读档把图恢复到 b：deserialize 后应立即重评 reactive，b→c 自动补走
    narrative.deserialize({ activeStates: { g: 'b' } });
    await flush();
    expect(narrative.getActiveState('g')).toBe('c');
  });

  it('reactiveAny fires when any condition is met', async () => {
    const { flagStore, narrative } = makeRuntime();
    flagStore.set('quest_a', true);
    narrative.registerGraphs([{
      id: 'flow',
      ownerType: 'flow',
      initialState: 'waiting',
      states: { waiting: { id: 'waiting' }, done: { id: 'done' } },
      transitions: [{
        id: 'any_done',
        from: 'waiting',
        to: 'done',
        signal: '__draft__',
        trigger: 'reactiveAny',
        conditions: [
          { flag: 'quest_a', value: true },
          { flag: 'quest_b', value: true },
        ],
      }],
    }]);
    await flush();
    expect(narrative.getActiveState('flow')).toBe('done');
  });

  it('reactive passes conditions through as-is for complex trees', async () => {
    const { flagStore, narrative } = makeRuntime();
    flagStore.set('a', true);
    flagStore.set('c', true);
    narrative.registerGraphs([{
      id: 'flow',
      ownerType: 'flow',
      initialState: 'waiting',
      states: { waiting: { id: 'waiting' }, done: { id: 'done' } },
      transitions: [{
        id: 'complex',
        from: 'waiting',
        to: 'done',
        signal: '__draft__',
        trigger: 'reactive',
        conditions: [{ all: [
          { flag: 'a', value: true },
          { any: [
            { flag: 'b', value: true },
            { flag: 'c', value: true },
          ]},
        ]}],
      }],
    }]);
    await flush();
    // a=true, c=true → (a AND (b OR c)) = true
    expect(narrative.getActiveState('flow')).toBe('done');
  });

  it('reactive transition respects priority when multiple reactive transitions match', async () => {
    const { flagStore, narrative } = makeRuntime();
    flagStore.set('ready', true);
    narrative.registerGraphs([{
      id: 'g',
      ownerType: 'flow',
      initialState: 'a',
      states: { a: { id: 'a' }, b: { id: 'b' }, c: { id: 'c' } },
      transitions: [
        { id: 'low', from: 'a', to: 'b', signal: '__draft__', trigger: 'reactiveAll', priority: 0,
          conditions: [{ flag: 'ready', value: true }] },
        { id: 'high', from: 'a', to: 'c', signal: '__draft__', trigger: 'reactiveAll', priority: 5,
          conditions: [{ flag: 'ready', value: true }] },
      ],
    }]);
    await flush();
    expect(narrative.getActiveState('g')).toBe('c');
  });

  it('reactive cascade propagates via broadcastOnEnter', async () => {
    const { flagStore, narrative } = makeRuntime();
    flagStore.set('trigger', true);
    narrative.registerGraphs([
      {
        id: 'flow',
        ownerType: 'flow',
        initialState: 'waiting',
        states: { waiting: { id: 'waiting' }, done: { id: 'done', broadcastOnEnter: true } },
        transitions: [{
          id: 'fire',
          from: 'waiting', to: 'done',
          signal: '__draft__', trigger: 'reactiveAll',
          conditions: [{ flag: 'trigger', value: true }],
        }],
      },
      {
        id: 'npc',
        ownerType: 'npc',
        initialState: 'before',
        states: { before: { id: 'before' }, after: { id: 'after' } },
        transitions: [{ id: 'follow', from: 'before', to: 'after', signal: 'state:flow:done' }],
      },
    ]);
    await flush();
    expect(narrative.getActiveState('flow')).toBe('done');
    expect(narrative.getActiveState('npc')).toBe('after');
  });

  it('signal transition still works alongside reactive transitions', async () => {
    const { narrative } = makeRuntime();
    narrative.registerGraphs([{
      id: 'g',
      ownerType: 'flow',
      initialState: 'a',
      states: { a: { id: 'a' }, b: { id: 'b' }, c: { id: 'c' } },
      transitions: [
        { id: 'sig', from: 'a', to: 'b', signal: 'go' },
        { id: 'react', from: 'a', to: 'c', signal: '__draft__', trigger: 'reactiveAll', priority: -1,
          conditions: [{ flag: 'always', value: true }] },
      ],
    }]);
    await narrative.emitNarrativeSignal({ sourceType: 'system', sourceId: 'test', signal: 'go' });
    await flush();
    // Signal transition wins (higher effective priority when triggered)
    expect(narrative.getActiveState('g')).toBe('b');
  });
});

describe('保留前缀信号发射拦截（W5 回归）', () => {
  it('emitNarrativeSignal 动作参数用 state:/__draft__ 保留前缀 = 校验 error', () => {
    const issues = validateNarrativeGraphData({
      schemaVersion: 3,
      signals: [],
      compositions: [{
        id: 'comp',
        mainGraph: {
          id: 'flow',
          ownerType: 'flow',
          initialState: 'a',
          states: {
            a: { id: 'a' },
            b: {
              id: 'b',
              onEnterActions: [
                { type: 'emitNarrativeSignal', params: { signal: 'state:flow:done' } },
                { type: 'emitNarrativeSignal', params: { signal: '__draft__' } },
                { type: 'emitNarrativeSignal', params: { signal: 'legit_signal' } },
              ],
            },
          },
          transitions: [{ id: 't', from: 'a', to: 'b', signal: 'go' }],
        },
        elements: [],
      }],
    });
    const reserved = issues.filter((i) => i.code === 'action.signal.reserved');
    expect(reserved).toHaveLength(2);
    expect(reserved.every((i) => i.severity === 'error')).toBe(true);
  });
});

/**
 * 叙事运行实例化 S1（artifact/Design/叙事运行实例化-技术设计-2026-07-17.md）：
 * 原型/实例分离、生命周期、单激活槽、计数器、存档 v2。
 */
describe('叙事活计运行实例化 S1（单活可重复机器）', () => {
  const JOB: NarrativeGraph = {
    id: 'job',
    ownerType: 'scenario',
    run: { repeatable: true, resumable: true },
    initialState: 'accepted',
    entryState: 'accepted',
    exitStates: ['delivered'],
    states: {
      accepted: { id: 'accepted' },
      doing: { id: 'doing' },
      delivered: { id: 'delivered' },
    },
    transitions: [
      { id: 't1', from: 'accepted', to: 'doing', signal: 'job_start' },
      { id: 't2', from: 'doing', to: 'delivered', signal: 'job_deliver' },
    ],
  };
  const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

  it('常驻图注册不变；活计图注册不种实例，start 建实例并激活', async () => {
    const { narrative } = makeRuntime();
    narrative.registerGraphs([clone(JOB), {
      id: 'solo', ownerType: 'flow', initialState: 'a',
      states: { a: { id: 'a' }, b: { id: 'b' } },
      transitions: [{ id: 't', from: 'a', to: 'b', signal: 'go' }],
    }]);
    expect(narrative.getActiveState('job')).toBeUndefined(); // 活计图无实例
    expect(narrative.getActiveState('solo')).toBe('a');
    await narrative.startNarrativeRun('job');
    await flush();
    expect(narrative.getActiveState('job')).toBe('accepted');
    expect(narrative.getActivatedArchetype()).toBe('job');
    expect(narrative.getActiveRunArchetypes()).toEqual(['job']);
  });

  it('start 守卫：非活计图拒绝、已有实例拒绝', async () => {
    const { narrative } = makeRuntime();
    narrative.registerGraphs([clone(JOB), {
      id: 'solo', ownerType: 'flow', initialState: 'a', states: { a: { id: 'a' } }, transitions: [],
    }]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await narrative.startNarrativeRun('solo');
    expect(narrative.getActiveRunArchetypes()).toEqual([]);
    await narrative.startNarrativeRun('job');
    await narrative.startNarrativeRun('job'); // 已有实例
    warn.mockRestore();
    const codes = (narrative.debugSnapshot().recentIssues as Array<{ code: string }>).map((i) => i.code);
    expect(codes).toContain('run.start.notRunGraph');
    expect(codes).toContain('run.start.exists');
  });

  it('信号只推激活活计；到达出口自动结算（计数+删实例+清激活槽）', async () => {
    const { narrative } = makeRuntime();
    narrative.registerGraphs([clone(JOB)]);
    await narrative.startNarrativeRun('job');
    await narrative.emitNarrativeSignal({ signal: 'job_start' });
    await flush();
    expect(narrative.getActiveState('job')).toBe('doing');
    await narrative.emitNarrativeSignal({ signal: 'job_deliver' });
    await flush();
    expect(narrative.getActiveRunArchetypes()).toEqual([]); // 结算删实例
    expect(narrative.getSettledRunCount('job')).toBe(1);
    expect(narrative.getSettledRunCount('job', 'delivered')).toBe(1);
    expect(narrative.getActivatedArchetype()).toBeNull();
  });

  it('runStarted 事件带单号；getRunPanelInfo 全生命周期派生（S2批2 quest 镜像口）', async () => {
    const { narrative, eventBus } = makeRuntime();
    const graph = clone(JOB);
    (graph.states as Record<string, { id: string; label?: string }>).doing.label = '干着';
    (graph.states as Record<string, { id: string; label?: string }>).delivered.label = '已交付';
    narrative.registerGraphs([graph, {
      id: 'solo', ownerType: 'flow', initialState: 'a', states: { a: { id: 'a' } }, transitions: [],
    }]);
    const started: Array<{ archetypeId: string; ordinal: number }> = [];
    eventBus.on('narrative:runStarted', (p: { archetypeId: string; ordinal: number }) => started.push(p));

    expect(narrative.getRunPanelInfo('solo')).toBeNull();          // 常驻图无面板信息
    expect(narrative.getRunPanelInfo('missing')).toBeNull();
    // 无历史：蛰伏
    expect(narrative.getRunPanelInfo('job')).toMatchObject({ active: undefined, ordinal: 0, activated: false, settled: [] });

    await narrative.startNarrativeRun('job');
    expect(started).toEqual([{ archetypeId: 'job', ordinal: 1 }]);
    await narrative.emitNarrativeSignal({ signal: 'job_start' });
    await flush();
    expect(narrative.getRunPanelInfo('job')).toMatchObject({
      active: 'doing', activeLabel: '干着', ordinal: 1, activated: true, suspended: false,
    });
    await narrative.emitNarrativeSignal({ signal: 'job_deliver' });
    await flush();
    // 结算后：无实例但归档汇总在（label 取出口状态 label）
    expect(narrative.getRunPanelInfo('job')).toMatchObject({
      active: undefined, activated: false,
      settled: [{ exitId: 'delivered', label: '已交付', count: 1 }],
    });
    // 第二单：单号=2；挂起态可见
    await narrative.startNarrativeRun('job');
    expect(started[1]).toEqual({ archetypeId: 'job', ordinal: 2 });
    await narrative.activateNarrativeRun('');
    await flush();
    expect(narrative.getRunPanelInfo('job')).toMatchObject({ active: 'accepted', ordinal: 2, activated: false, suspended: true });
  });

  it('narrative 普通叶直读活计当前态（有实例命中、无实例 false）', async () => {
    const { narrative, flagStore } = makeRuntime();
    narrative.registerGraphs([clone(JOB), {
      id: 'watcher', ownerType: 'flow', initialState: 'w0',
      states: { w0: { id: 'w0' }, w1: { id: 'w1' } },
      transitions: [{ id: 't', from: 'w0', to: 'w1', signal: '__draft__', trigger: 'reactive',
        conditions: [{ narrative: 'job', state: 'doing' } as never] }],
    }]);
    expect(narrative.getActiveState('watcher')).toBe('w0'); // 无活计实例，条件 false
    await narrative.startNarrativeRun('job');
    await narrative.emitNarrativeSignal({ signal: 'job_start' }); // job→doing
    await flush();
    void flagStore;
    expect(narrative.getActiveState('watcher')).toBe('w1'); // 读到活计当前态
  });

  it('reset 从头再来（回 initialState + 清 reached，静默、cause=reset）', async () => {
    const { narrative, eventBus } = makeRuntime();
    narrative.registerGraphs([clone(JOB)]);
    const causes: string[] = [];
    eventBus.on('narrative:stateChanged', (p: { cause?: string }) => causes.push(String(p?.cause)));
    await narrative.startNarrativeRun('job');
    await narrative.emitNarrativeSignal({ signal: 'job_start' });
    await flush();
    expect(narrative.hasReachedState('job', 'doing')).toBe(true);
    await narrative.resetNarrativeRun('job');
    await flush();
    expect(narrative.getActiveState('job')).toBe('accepted');
    expect(narrative.hasReachedState('job', 'doing')).toBe(false); // reached 清空
    expect(causes).toContain('reset');
    const snap = narrative.debugSnapshot() as { runCounters: Record<string, { reset: number }> };
    expect(snap.runCounters['job']!.reset).toBe(1);
  });

  it('revert 回退到指定状态（改 active、保留 reached、cause=revert）', async () => {
    const { narrative } = makeRuntime();
    narrative.registerGraphs([clone(JOB)]);
    await narrative.startNarrativeRun('job');
    await narrative.emitNarrativeSignal({ signal: 'job_start' }); // doing
    await flush();
    await narrative.revertNarrativeRun('job', 'accepted');
    await flush();
    expect(narrative.getActiveState('job')).toBe('accepted');
    expect(narrative.hasReachedState('job', 'doing')).toBe(true); // 历史保留
  });

  it('resumable=true：切走挂起、切回从当前态续；非激活活计冻结不吃信号', async () => {
    const { narrative } = makeRuntime();
    const jobB = clone(JOB); jobB.id = 'job2';
    narrative.registerGraphs([clone(JOB), jobB]);
    await narrative.startNarrativeRun('job');
    await narrative.emitNarrativeSignal({ signal: 'job_start' }); // job→doing
    await flush();
    await narrative.startNarrativeRun('job2'); // 顶替激活；job 挂起在 doing
    expect(narrative.getActivatedArchetype()).toBe('job2');
    expect(narrative.getActiveState('job')).toBe('doing'); // 挂起态保留
    await narrative.emitNarrativeSignal({ signal: 'job_deliver' }); // 只有激活的 job2 在 accepted，不匹配
    await flush();
    expect(narrative.getActiveState('job')).toBe('doing'); // 挂起 job 冻结，未被推进
    await narrative.activateNarrativeRun('job'); // 切回
    await narrative.emitNarrativeSignal({ signal: 'job_deliver' }); // job 从 doing 续
    await flush();
    expect(narrative.getSettledRunCount('job', 'delivered')).toBe(1);
  });

  it('resumable=false：切走即弃（删实例+aborted++），切回需 start 重开', async () => {
    const { narrative } = makeRuntime();
    const once = clone(JOB); once.run = { repeatable: true, resumable: false };
    const jobB = clone(JOB); jobB.id = 'job2';
    narrative.registerGraphs([once, jobB]);
    await narrative.startNarrativeRun('job');
    await narrative.startNarrativeRun('job2'); // 顶替；job 非 resumable → 弃置
    expect(narrative.getActiveState('job')).toBeUndefined();
    const snap = narrative.debugSnapshot() as { runCounters: Record<string, { aborted: number }> };
    expect(snap.runCounters['job']!.aborted).toBe(1);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await narrative.activateNarrativeRun('job'); // 无实例，拒绝
    warn.mockRestore();
    expect(narrative.getActivatedArchetype()).toBe('job2');
  });

  it('narrativeCount 条件叶驱动常驻里程碑（交付→计数→reactive 醒）', async () => {
    const { narrative } = makeRuntime();
    narrative.registerGraphs([clone(JOB), {
      id: 'milestone', ownerType: 'flow', initialState: 'waiting',
      states: { waiting: { id: 'waiting' }, unlocked: { id: 'unlocked' } },
      transitions: [{
        id: 't', from: 'waiting', to: 'unlocked', signal: '__draft__', trigger: 'reactiveAll',
        conditions: [{ narrativeCount: 'job', exitState: 'delivered', op: '>=', value: 1 } as never],
      }],
    }]);
    await narrative.startNarrativeRun('job');
    await narrative.emitNarrativeSignal({ signal: 'job_start' });
    expect(narrative.getActiveState('milestone')).toBe('waiting');
    await narrative.emitNarrativeSignal({ signal: 'job_deliver' });
    await flush();
    await flush();
    expect(narrative.getActiveState('milestone')).toBe('unlocked');
  });

  it('存档 v2 往返：runs/挂起/计数/激活槽全恢复；v1 旧档升格为纯常驻基线', async () => {
    const { narrative } = makeRuntime();
    const jobB = clone(JOB); jobB.id = 'job2';
    narrative.registerGraphs([clone(JOB), jobB]);
    await narrative.startNarrativeRun('job');
    await narrative.emitNarrativeSignal({ signal: 'job_start' }); // job→doing (激活)
    await narrative.startNarrativeRun('job2'); // job 挂起 doing，job2 激活 accepted
    await flush();
    const save = JSON.parse(JSON.stringify(narrative.serialize()));
    const rt2 = makeRuntime();
    rt2.narrative.registerGraphs([clone(JOB), clone(jobB)]);
    rt2.narrative.deserialize(save);
    expect(rt2.narrative.getActiveState('job')).toBe('doing');
    expect(rt2.narrative.getActiveState('job2')).toBe('accepted');
    expect(rt2.narrative.getActivatedArchetype()).toBe('job2');
    expect(rt2.narrative.getActiveRunArchetypes().sort()).toEqual(['job', 'job2']);
    // v1 旧档：升格后活计层空
    const rt3 = makeRuntime();
    rt3.narrative.registerGraphs([clone(JOB)]);
    rt3.narrative.deserialize({ activeStates: {}, reachedStates: {} });
    expect(rt3.narrative.getActiveRunArchetypes()).toEqual([]);
    expect(rt3.narrative.getActivatedArchetype()).toBeNull();
  });

  it('旧档常驻条目撞上已改活计图：丢弃点名，不造幽灵实例', async () => {
    const { narrative } = makeRuntime();
    narrative.registerGraphs([clone(JOB)]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    narrative.deserialize({ activeStates: { job: 'doing' }, reachedStates: { job: ['accepted', 'doing'] } });
    warn.mockRestore();
    expect(narrative.getActiveState('job')).toBeUndefined();
    const codes = (narrative.debugSnapshot().recentIssues as Array<{ code: string }>).map((i) => i.code);
    expect(codes).toContain('save.active.becameRunGraph');
  });

  it('S1 校验防火墙：run 声明/动作目标/narrativeCount/活计广播 warning/id 字符', () => {
    const issues = validateNarrativeGraphData({
      schemaVersion: 3,
      signals: [{ id: 'go' }],
      compositions: [{
        id: 'comp',
        mainGraph: {
          id: 'flow',
          ownerType: 'flow',
          initialState: 'a',
          states: {
            a: { id: 'a' },
            b: {
              id: 'b',
              onEnterActions: [
                { type: 'startNarrativeRun', params: { graphId: 'flow' } },       // 常驻目标 → notRunGraph
                { type: 'startNarrativeRun', params: { graphId: 'nope' } },       // 不存在 → graphMissing
                { type: 'startNarrativeRun', params: { graphId: 'job' } },        // 合法
                { type: 'revertNarrativeRun', params: { graphId: 'job', stateId: 'ghost' } }, // 状态不存在 → stateMissing
              ],
            },
          },
          transitions: [
            { id: 't', from: 'a', to: 'b', signal: 'go' },
            // 常驻图裸听活计图广播 → warning
            { id: 't2', from: 'a', to: 'b', signal: 'state:job:delivered' },
            // narrative 叶指活计图现在合法（单活直读）——不应报 instanced 类 error
            { id: 't3', from: 'a', to: 'b', signal: 'go', conditions: [{ narrative: 'job', state: 'doing' }] },
            { id: 't4', from: 'a', to: 'b', signal: 'go', conditions: [
              { narrativeCount: 'job', exitState: 'delivered', op: '>=', value: 1 },
              { narrativeCount: 'flow', value: 1 },                                // 非活计图 → notRunGraph
              { narrativeCount: 'job', exitState: 'doing', value: 1 },             // 非出口 → exitMissing
            ] },
          ],
        },
        elements: [{
          id: 'el_job',
          kind: 'scenarioSubgraph',
          refId: 'job',
          graph: {
            id: 'job',
            ownerType: 'scenario',
            run: { repeatable: true },
            initialState: 'accepted',
            entryState: 'accepted',
            exitStates: ['delivered'],
            states: { accepted: { id: 'accepted', broadcastOnEnter: false }, doing: { id: 'doing' }, delivered: { id: 'delivered', broadcastOnEnter: true } },
            transitions: [{ id: 't', from: 'accepted', to: 'delivered', signal: 'go' }],
          },
        }, {
          id: 'el_bad',
          kind: 'wrapperGraph',
          ownerType: 'npc',
          ownerId: 'npc_1',
          graph: {
            id: 'bad@id',                                                          // → graph.id.delimiter
            ownerType: 'npc',
            run: { repeatable: 'yes' as never },                                  // → run.repeatable.invalid + run.wrapper.unsupported
            initialState: 'x',
            states: { x: { id: 'x' } },
            transitions: [],
          },
        }],
      }],
    });
    const codes = issues.map((i) => i.code);
    for (const expected of [
      'runAction.notRunGraph', 'runAction.graphMissing', 'runAction.stateMissing',
      'state.broadcast.runSourceListenedByResident',
      'condition.narrativeCount.notRunGraph',
      'condition.narrativeCount.exitMissing',
      'run.repeatable.invalid',
      'run.wrapper.unsupported',
      'graph.id.delimiter',
    ]) {
      expect(codes, expected).toContain(expected);
    }
    // narrative 叶指活计图不再报 instanced 类 error
    expect(codes).not.toContain('condition.narrative.instanced');
  });

  it('活计出口可达性：断链出口报 run.exit.unreachable（结算永不发生），可达不报', () => {
    const mk = (transitions: Array<{ id: string; from: string; to: string; signal: string }>) =>
      validateNarrativeGraphData({
        schemaVersion: 2,
        signals: [{ id: 'a' }, { id: 'b' }],
        compositions: [{
          id: 'c',
          mainGraph: {
            id: 'j', ownerType: 'flow', initialState: 's0', run: { repeatable: true },
            entryState: 's0', exitStates: ['done'],
            states: { s0: { id: 's0' }, mid: { id: 'mid' }, done: { id: 'done' } },
            transitions,
          },
          elements: [],
        }],
      } as unknown as NarrativeGraphsFile);
    const broken = mk([{ id: 't1', from: 's0', to: 'mid', signal: 'a' }]); // done 无入边
    expect(broken.map((i) => i.code)).toContain('run.exit.unreachable');
    const ok = mk([
      { id: 't1', from: 's0', to: 'mid', signal: 'a' },
      { id: 't2', from: 'mid', to: 'done', signal: 'b' },
    ]);
    expect(ok.map((i) => i.code)).not.toContain('run.exit.unreachable');
  });
});

describe('章节包 live/dormant（C1：电影摄制模型——状态永存，live 只管行为）', () => {
  const PKG_GRAPH: NarrativeGraph = {
    id: 'story', ownerType: 'flow', packageId: 'ch1', initialState: 'p0',
    states: { p0: { id: 'p0' }, p1: { id: 'p1', broadcastOnEnter: true }, p2: { id: 'p2' } },
    transitions: [
      { id: 't1', from: 'p0', to: 'p1', signal: 'story_go' },
      { id: 't2', from: 'p1', to: 'p2', signal: 'story_end' },
    ],
  };
  const CORE_GRAPH: NarrativeGraph = {
    id: 'core', ownerType: 'flow', initialState: 'c0',
    states: { c0: { id: 'c0' }, c1: { id: 'c1' } },
    transitions: [{ id: 'ct', from: 'c0', to: 'c1', signal: 'state:story:p1' }],
  };
  const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

  it('compileNarrativeGraphs 把 composition.package 盖章到主图与元素图', () => {
    const graphs = compileNarrativeGraphs({
      schemaVersion: 2,
      compositions: [{
        id: 'c', package: 'ch1',
        mainGraph: clone(PKG_GRAPH),
        elements: [{ id: 'e', kind: 'wrapperGraph', graph: { ...clone(CORE_GRAPH), id: 'sub' } }],
      }],
    } as unknown as NarrativeGraphsFile);
    expect(graphs.map((g) => [g.id, g.packageId])).toEqual([['story', 'ch1'], ['sub', 'ch1']]);
  });

  it('元素级 package（C4 主线拆包）：mainGraph 不打标=常驻，各元素各打各拍的包', () => {
    // 主线现实：里程碑 mainGraph 与子图同编排。element.package 覆盖单元素，mainGraph 不继承 → 常驻脊椎。
    const graphs = compileNarrativeGraphs({
      schemaVersion: 2,
      compositions: [{
        id: 'main',
        mainGraph: { ...clone(CORE_GRAPH), id: 'milestone' },   // 无 composition.package → 常驻
        elements: [
          { id: 'e1', kind: 'wrapperGraph', package: '章节_听书', graph: { ...clone(CORE_GRAPH), id: 'g_tingshu' } },
          { id: 'e2', kind: 'wrapperGraph', package: '章节_背尸', graph: { ...clone(CORE_GRAPH), id: 'g_beishi' } },
          { id: 'e3', kind: 'wrapperGraph', graph: { ...clone(CORE_GRAPH), id: 'g_resident' } }, // 无 package → 常驻
        ],
      }],
    } as unknown as NarrativeGraphsFile);
    expect(graphs.map((g) => [g.id, g.packageId])).toEqual([
      ['milestone', undefined],       // 里程碑常驻
      ['g_tingshu', '章节_听书'],
      ['g_beishi', '章节_背尸'],
      ['g_resident', undefined],      // 未打标子图常驻
    ]);
  });

  it('dormant 包冻结（不吃信号），live 后解冻推进且出口广播可被常驻图听到', async () => {
    const { narrative } = makeRuntime();
    narrative.registerGraphs([clone(PKG_GRAPH), clone(CORE_GRAPH)]);
    // 默认 dormant：状态照常注册可查（永久记录），但不吃信号
    expect(narrative.getActiveState('story')).toBe('p0');
    await narrative.emitNarrativeSignal({ sourceType: 'system', sourceId: 't', signal: 'story_go' });
    await flush();
    expect(narrative.getActiveState('story')).toBe('p0');   // 冻结
    // 开拍：置 live → 吃信号推进，广播照发（core 听 state:story:p1）
    await narrative.setNarrativePackageLive('ch1', true);
    expect(narrative.getLivePackages()).toEqual(['ch1']);
    await narrative.emitNarrativeSignal({ sourceType: 'system', sourceId: 't', signal: 'story_go' });
    await flush();
    expect(narrative.getActiveState('story')).toBe('p1');
    expect(narrative.getActiveState('core')).toBe('c1');
    // 收工：dormant 冻结但状态原地保留、条件可查（hasReachedState 不受 live 影响）
    await narrative.setNarrativePackageLive('ch1', false);
    await narrative.emitNarrativeSignal({ sourceType: 'system', sourceId: 't', signal: 'story_end' });
    await flush();
    expect(narrative.getActiveState('story')).toBe('p1');   // 冻结在 p1
    expect(narrative.hasReachedState('story', 'p1')).toBe(true);
    // 未知包：记 issue 忽略
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await narrative.setNarrativePackageLive('nope', true);
    warn.mockRestore();
    const codes = (narrative.debugSnapshot().recentIssues as Array<{ code: string }>).map((i) => i.code);
    expect(codes).toContain('package.unknown');
  });

  it('livePackages 入档还原；未知包条目丢弃；旧档缺字段=全 dormant', async () => {
    const { narrative } = makeRuntime();
    const graphs = [clone(PKG_GRAPH), clone(CORE_GRAPH)];
    narrative.registerGraphs(graphs);
    await narrative.setNarrativePackageLive('ch1', true);
    await narrative.emitNarrativeSignal({ sourceType: 'system', sourceId: 't', signal: 'story_go' });
    await flush();
    const save = narrative.serialize() as { livePackages: string[] };
    expect(save.livePackages).toEqual(['ch1']);

    const { narrative: fresh } = makeRuntime();
    fresh.registerGraphs(graphs.map(clone));
    fresh.deserialize(save);
    expect(fresh.getLivePackages()).toEqual(['ch1']);
    expect(fresh.getActiveState('story')).toBe('p1');       // 包内状态照旧还原

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { narrative: legacy } = makeRuntime();
    legacy.registerGraphs(graphs.map(clone));
    legacy.deserialize({ ...save, livePackages: ['ch1', 'ghost_pkg'] });
    expect(legacy.getLivePackages()).toEqual(['ch1']);      // 未知包丢弃

    const { narrative: old } = makeRuntime();
    old.registerGraphs(graphs.map(clone));
    old.deserialize({ activeStates: {}, reachedStates: {} });
    warn.mockRestore();
    expect(old.getLivePackages()).toEqual([]);              // 旧档：全 dormant，导演重评
  });
});

/**
 * 2026-07-17 审查修复回归（artifact/Reviews/叙事状态机全面审查-2026-07-17.md R2/R3/W1/W2）：
 * 旧时间线隔离、存档一致性门 isIdle、排空异常不悬挂。
 */
describe('时间线隔离与存档一致性（R2/R3/W1/W2 回归）', () => {
  /** 子图 W（末态广播、onEnter 可控阻塞）+ 主图 M（监听 state:W:w1）。 */
  function makeBroadcastPair() {
    const rt = makeRuntime();
    let unblock!: () => void;
    const gate = new Promise<void>((r) => { unblock = r; });
    rt.actionExecutor.register('block', () => gate, []);
    rt.actionExecutor.register('emitNarrativeSignal', (p: Record<string, unknown>) =>
      rt.narrative.emitNarrativeSignal({ signal: String(p.signal) }), ['signal']);
    rt.narrative.registerGraphs([
      {
        id: 'W', ownerType: 'scenario', initialState: 'w0', entryState: 'w0', exitStates: ['w1'],
        states: {
          w0: { id: 'w0' },
          w1: { id: 'w1', broadcastOnEnter: true, onEnterActions: [{ type: 'block', params: {} }] },
        },
        transitions: [{ id: 't', from: 'w0', to: 'w1', signal: 'S' }],
      },
      {
        id: 'M', ownerType: 'flow', initialState: 'm0',
        states: { m0: { id: 'm0' }, m1: { id: 'm1' } },
        transitions: [{ id: 't', from: 'm0', to: 'm1', signal: 'state:W:w1' }],
      },
    ]);
    return { ...rt, unblock };
  }

  it('R2：在飞排空期间 deserialize，旧时间线广播被抑制，恢复后的世界不被污染', async () => {
    const { narrative, unblock } = makeBroadcastPair();
    const save0 = JSON.parse(JSON.stringify(narrative.serialize())); // W:w0, M:m0
    const p = narrative.emitNarrativeSignal({ signal: 'S' });
    p.catch(() => {}); // 时间线失效会 reject 在飞项，此处消费避免 unhandled
    await flush(); // W 已进 w1，onEnter 卡在 block，广播尚未入队
    expect(narrative.getActiveState('W')).toBe('w1');
    narrative.deserialize(save0); // 玩家读档回到初始档
    unblock(); // 旧时间线动作完成
    await flush();
    await flush();
    // 修复前：M 被旧时间线幽灵广播推到 m1 而 W 还在 w0；修复后两者都保持恢复态。
    expect(narrative.getActiveState('W')).toBe('w0');
    expect(narrative.getActiveState('M')).toBe('m0');
  });

  it('R2：换册（registerGraphs）同样隔离旧时间线且 reject 积压项，不静默悬挂（W2）', async () => {
    const { narrative, unblock } = makeBroadcastPair();
    const p = narrative.emitNarrativeSignal({ signal: 'S' });
    await flush(); // 卡在 W.w1 onEnter
    narrative.registerGraphs([{
      id: 'G2', ownerType: 'flow', initialState: 'a',
      states: { a: { id: 'a' }, b: { id: 'b' } },
      transitions: [{ id: 't', from: 'a', to: 'b', signal: 'state:W:w1' }],
    }]);
    unblock();
    await flush();
    await flush();
    // 旧时间线广播不得推动新图册；在飞项以 reject 落定（不永久悬挂）。
    expect(narrative.getActiveState('G2')).toBe('a');
    await expect(Promise.race([
      p.then(() => 'settled', () => 'settled'),
      flush().then(() => 'pending'),
    ])).resolves.toBe('settled');
  });

  it('R3：级联在飞时 isIdle=false（存档门拒绝半态档），空闲后恢复 true', async () => {
    const { narrative, unblock } = makeBroadcastPair();
    expect(narrative.isIdle()).toBe(true);
    const p = narrative.emitNarrativeSignal({ signal: 'S' });
    await flush(); // 卡在 W.w1 onEnter：子图已到末态、广播未消费——此刻存档即卡死档
    expect(narrative.getActiveState('W')).toBe('w1');
    expect(narrative.isIdle()).toBe(false);
    unblock();
    await p;
    await flush();
    // 级联完成：主图吃到广播、系统回到空闲，此刻的存档才是自洽的。
    expect(narrative.getActiveState('M')).toBe('m1');
    expect(narrative.isIdle()).toBe(true);
  });

  it('W1：条件上下文工厂抛错不拖挂排空循环（守卫迁移保守拒绝，系统保持可用）', async () => {
    const { narrative, actionExecutor } = makeRuntime();
    actionExecutor.register('emitNarrativeSignal', (p: Record<string, unknown>) =>
      narrative.emitNarrativeSignal({ signal: String(p.signal) }), ['signal']);
    narrative.setConditionEvalContextFactory(() => {
      throw new Error('ctx factory boom');
    });
    narrative.registerGraphs([
      {
        // A 吃 S 后在 onEnter 里发 T 并 await —— T 的处理走嵌套排空
        id: 'A', ownerType: 'flow', initialState: 'a0',
        states: {
          a0: { id: 'a0' },
          a1: { id: 'a1', onEnterActions: [{ type: 'emitNarrativeSignal', params: { signal: 'T' } }] },
        },
        transitions: [{ id: 't', from: 'a0', to: 'a1', signal: 'S' }],
      },
      {
        // C 对 T 的迁移带条件：工厂抛错必须被吞成 false，而不是把嵌套排空炸挂
        id: 'C', ownerType: 'flow', initialState: 'c0',
        states: { c0: { id: 'c0' }, c1: { id: 'c1' } },
        transitions: [{ id: 't', from: 'c0', to: 'c1', signal: 'T', conditions: [{ flag: 'x', value: true }] }],
      },
    ]);
    await narrative.emitNarrativeSignal({ signal: 'S' });
    await flush();
    expect(narrative.getActiveState('A')).toBe('a1');
    expect(narrative.getActiveState('C')).toBe('c0'); // 条件保守拒绝
    expect(narrative.isIdle()).toBe(true); // 循环未被拖挂
    const issues = (narrative.debugSnapshot().recentIssues as Array<{ code: string }>);
    expect(issues.some((i) => i.code === 'condition.ctxFactory.threw')).toBe(true);
    // 系统仍然可用：后续无条件信号照常推进
    await narrative.emitNarrativeSignal({ signal: 'T' });
    await flush();
    expect(narrative.getActiveState('C')).toBe('c0'); // 仍有条件仍拒
  });

  it('R2：save:restoring 事件钩子同样触发时间线失效（老档缺 narrative 条目的兜底）', async () => {
    const { narrative, eventBus, unblock } = makeBroadcastPair();
    const p = narrative.emitNarrativeSignal({ signal: 'S' });
    p.catch(() => {});
    await flush(); // 卡在 W.w1 onEnter
    eventBus.emit('save:restoring', {});
    unblock();
    await flush();
    await flush();
    // 广播被抑制：M 不动（W 的置态发生在失效前，属旧时间线残影，由 deserialize 复位——本用例只验钩子对广播的抑制）
    expect(narrative.getActiveState('M')).toBe('m0');
  });
});
