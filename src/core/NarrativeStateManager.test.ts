import { describe, expect, it, vi } from 'vitest';
import { ActionExecutor } from './ActionExecutor';
import { EventBus } from './EventBus';
import { FlagStore } from './FlagStore';
import { compileNarrativeGraphs, NarrativeStateManager, type NarrativeGraphsFile } from './NarrativeStateManager';
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
  it('normalizes external trigger keys', () => {
    expect(NarrativeStateManager.externalKey({
      sourceType: 'dialogue',
      sourceId: 'dock_board',
      signal: 'board_read_done',
    })).toBe('external:dialogue:dock_board:board_read_done');
    expect(NarrativeStateManager.externalKey({
      sourceType: 'dialogue',
      sourceId: 'scene:entity',
      signal: 'done:again',
    })).toBe('external:dialogue:scene%3Aentity:done%3Aagain');
    expect(NarrativeStateManager.normalizeTriggerKey('external:dialogue:scene%3Aentity:done%3Aagain'))
      .toBe('external:dialogue:scene%3Aentity:done%3Aagain');
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
        { id: 'low', from: 'a', to: 'b', signal: 'external:system:test:go', priority: 0 },
        {
          id: 'high',
          from: 'a',
          to: 'c',
          signal: 'external:system:test:go',
          priority: 5,
          conditions: [{ flag: 'ready', value: true }],
        },
      ],
    }]);
    narrative.emitNarrativeSignal({ sourceType: 'system', sourceId: 'test', signal: 'go' });
    await flush();
    expect(narrative.getActiveState('g')).toBe('c');
  });

  it('runs each graph at most once per trigger and cascades stateEntered triggers', async () => {
    const { narrative } = makeRuntime();
    narrative.registerGraphs([
      {
        id: 'flow',
        ownerType: 'flow',
        initialState: 'initial',
        states: { initial: { id: 'initial' }, done: { id: 'done' } },
        transitions: [{ id: 'finish', from: 'initial', to: 'done', signal: 'external:system:test:done' }],
      },
      {
        id: 'npc',
        ownerType: 'npc',
        initialState: 'before',
        states: { before: { id: 'before' }, after: { id: 'after' } },
        transitions: [{ id: 'after', from: 'before', to: 'after', signal: 'stateEntered:flow:done' }],
      },
    ]);
    await narrative.emitNarrativeSignal({ sourceType: 'system', sourceId: 'test', signal: 'done' });
    expect(narrative.getActiveState('flow')).toBe('done');
    expect(narrative.getActiveState('npc')).toBe('after');
  });

  it('allows lifecycle actions to await queued narrative state commands', async () => {
    const { actionExecutor, flagStore, narrative } = makeRuntime();
    actionExecutor.register('setAuxAndRecord', async () => {
      await narrative.setNarrativeState('aux', 'on');
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
        transitions: [{ id: 'go', from: 'a', to: 'b', signal: 'external:system:test:go' }],
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
      transitions: [{ id: 'go', from: 'a', to: 'b', signal: 'external:system:test:go' }],
    }]);
    narrative.emitNarrativeSignal({ sourceType: 'system', sourceId: 'test', signal: 'go' });
    await flush();
    expect(narrative.getActiveState('g')).toBe('b');
    spy.mockRestore();
  });

  it('serializes, deserializes, and projects active flags', async () => {
    const { flagStore, narrative } = makeRuntime();
    narrative.registerGraphs([{
      id: 'g',
      ownerType: 'flow',
      initialState: 'a',
      projectFlags: true,
      states: { a: { id: 'a' }, b: { id: 'b' } },
      transitions: [{ id: 'go', from: 'a', to: 'b', signal: 'external:system:test:go' }],
    }]);
    narrative.emitNarrativeSignal({ sourceType: 'system', sourceId: 'test', signal: 'go' });
    await flush();
    expect(flagStore.get('narrative.g.b.active')).toBe(true);
    const saved = narrative.serialize();

    const next = makeRuntime().narrative;
    next.registerGraphs([{
      id: 'g',
      ownerType: 'flow',
      initialState: 'a',
      states: { a: { id: 'a' }, b: { id: 'b' } },
      transitions: [],
    }]);
    next.deserialize(saved);
    expect(next.getActiveState('g')).toBe('b');
  });

  it('indexes graphs by owner binding for entity systems', async () => {
    const { narrative } = makeRuntime();
    narrative.registerGraphs([{
      id: 'npc_ringboy',
      ownerType: 'npc',
      ownerId: 'npc_ringboy',
      initialState: 'before_event',
      states: { before_event: { id: 'before_event' }, after_event: { id: 'after_event' } },
      transitions: [{ id: 'go', from: 'before_event', to: 'after_event', signal: 'external:system:test:go' }],
    }]);
    expect(narrative.getGraphIdsByOwner('npc', 'npc_ringboy')).toEqual(['npc_ringboy']);
    expect(narrative.getGraphsByOwner('npc', 'npc_ringboy')[0]?.id).toBe('npc_ringboy');

    narrative.emitNarrativeSignal({ sourceType: 'system', sourceId: 'test', signal: 'go' });
    await flush();
    expect(narrative.getActiveStatesByOwner('npc', 'npc_ringboy')).toEqual({ npc_ringboy: 'after_event' });
  });

  it('supports cross-graph transitions into scenario boundary states', async () => {
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
            signal: 'external:system:test:enter',
          },
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
            signal: 'external:system:test:leave',
          },
        ],
      },
    ]);

    await narrative.emitNarrativeSignal({ sourceType: 'system', sourceId: 'test', signal: 'enter' });
    await flush();
    expect(narrative.getActiveState('flow')).toBe('ready');
    expect(narrative.getActiveState('scenario')).toBe('entry');

    await narrative.setNarrativeState('scenario', 'exit');
    await flush();
    await narrative.emitNarrativeSignal({ sourceType: 'system', sourceId: 'test', signal: 'leave' });
    await flush();
    expect(narrative.getActiveState('scenario')).toBe('exit');
    expect(narrative.getActiveState('flow')).toBe('done');
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
            signal: 'external:system:test:enter',
          },
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
    await narrative.setNarrativeState('scenario', 'middle');
    expect(narrative.getActiveState('scenario')).toBe('inactive');
    const snapshot = narrative.debugSnapshot();
    expect(JSON.stringify(snapshot)).toContain('scenario.boundary');
  });

  it('rejects duplicate graph ids during registration', () => {
    const { narrative } = makeRuntime();
    const graph = {
      id: 'dup',
      ownerType: 'flow' as const,
      initialState: 'a',
      states: { a: { id: 'a' } },
      transitions: [],
    };
    expect(() => narrative.registerGraphs([graph, { ...graph }])).toThrow(/duplicate graph id/);
  });

  it('lets nested state commands await their actual application', async () => {
    const { actionExecutor, narrative } = makeRuntime();
    let observed = '';
    actionExecutor.register('queueSetC', async () => {
      await narrative.setNarrativeState('g', 'c');
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
      transitions: [{ id: 'go', from: 'a', to: 'b', signal: 'external:system:test:go' }],
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

  it('loads the real dock water monkey chain data', async () => {
    const { narrative } = makeRuntime();
    const raw = narrativeGraphsData as unknown as NarrativeGraphsFile;
    const graphs = compileNarrativeGraphs(raw);
    expect(graphs.map((g) => g.id)).toEqual([
      'flow_dock_water_monkey',
      'npc_ringboy',
      'quest_return_ring',
    ]);
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
});
