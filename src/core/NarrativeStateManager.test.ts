import { describe, expect, it, vi } from 'vitest';
import { ActionExecutor } from './ActionExecutor';
import { EventBus } from './EventBus';
import { FlagStore } from './FlagStore';
import { compileNarrativeGraphs, NarrativeStateManager, type NarrativeGraph, type NarrativeGraphsFile } from './NarrativeStateManager';
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
    expect(narrative.serialize()).toEqual({
      activeStates: { g: 'b' },
      reachedStates: { g: ['a', 'b'] },
    });

    narrative.deserialize({ activeStates: { g: 'a' } });
    expect(narrative.getActiveState('g')).toBe('a');

    narrative.deserialize({ activeStates: { g: 'missing', other: 'x' } });
    expect(narrative.getActiveState('g')).toBe('a');
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
