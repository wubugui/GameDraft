import { describe, expect, it } from 'vitest';
import { ActionExecutor } from './ActionExecutor';
import { EventBus } from './EventBus';
import { FlagStore } from './FlagStore';
import { GameState } from '../data/types';
import type { GameStateController } from './GameStateController';

describe('死亡/读档作废旧动作批', () => {
  function loadingRig() {
    const events = new EventBus();
    const state = {
      currentState: GameState.Exploring,
      setState(next: GameState) {
        if (this.currentState !== GameState.Loading) this.currentState = next;
      },
    };
    const actions = new ActionExecutor(events, new FlagStore(events), state as GameStateController);
    const releases: Array<() => void> = [];
    actions.register('pending', () => new Promise<void>(resolve => { releases.push(resolve); }));
    return { actions, state, releases };
  }

  it('动作在加载中结束时保留已结束的owner证据，旧finally不提前归还控制', async () => {
    const { actions, state, releases } = loadingRig();
    const work = actions.executeAwait({ type: 'pending', params: {} });
    const owner = actions.getExploreLockOwner()!;
    expect(state.currentState).toBe(GameState.ActionSequence);
    expect(owner.settled).toBe(false);
    state.currentState = GameState.Loading;
    releases[0]();
    await work;
    expect(state.currentState).toBe(GameState.Loading);
    expect(owner).toEqual({ generation: actions.getGeneration(), settled: true });
    expect(actions.getExploreLockOwner()).toBeNull();
  });

  it('仍运行的动作跨越加载后保留控制，并在真正结束时正常归还', async () => {
    const { actions, state, releases } = loadingRig();
    const work = actions.executeAwait({ type: 'pending', params: {} });
    const owner = actions.getExploreLockOwner()!;
    state.currentState = GameState.Loading;
    await Promise.resolve();
    expect(owner.settled).toBe(false);
    state.currentState = GameState.ActionSequence;
    releases[0]();
    await work;
    expect(state.currentState).toBe(GameState.Exploring);
  });

  it('旧世代晚结束不能抹掉新动作owner或解开新动作的锁', async () => {
    const { actions, state, releases } = loadingRig();
    const old = actions.executeAwait({ type: 'pending', params: {} });
    const oldOwner = actions.getExploreLockOwner()!;
    actions.cancelPending();
    state.currentState = GameState.Exploring;
    const fresh = actions.executeAwait({ type: 'pending', params: {} });
    const freshOwner = actions.getExploreLockOwner()!;
    releases[0]();
    await old;
    expect(oldOwner.settled).toBe(true);
    expect(actions.getExploreLockOwner()).toBe(freshOwner);
    expect(state.currentState).toBe(GameState.ActionSequence);
    releases[1]();
    await fresh;
    expect(state.currentState).toBe(GameState.Exploring);
  });

  it('嵌套动作扣血死亡后，内外层的后续奖励都不再执行', async () => {
    const events = new EventBus();
    const flags = new FlagStore(events);
    const actions = new ActionExecutor(events, flags);
    actions.register('die', () => { actions.cancelPending(); });
    actions.register('nested', () => actions.executeBatchAwait([
      { type: 'die', params: {} }, { type: 'setFlag', params: { key: 'innerReward', value: true } },
    ]));
    await actions.executeBatchAwait([
      { type: 'nested', params: {} }, { type: 'setFlag', params: { key: 'outerReward', value: true } },
    ]);
    expect(flags.get('innerReward')).toBeUndefined();
    expect(flags.get('outerReward')).toBeUndefined();
    await actions.executeBatchAwait([{ type: 'setFlag', params: { key: 'newTimeline', value: true } }]);
    expect(flags.get('newTimeline')).toBe(true);
  });
});
