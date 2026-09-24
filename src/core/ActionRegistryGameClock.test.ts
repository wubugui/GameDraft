import { describe, expect, it, vi } from 'vitest';
import { ActionExecutor } from './ActionExecutor';
import { EventBus } from './EventBus';
import { FlagStore } from './FlagStore';
import { registerActionHandlers, type ActionRegistryDeps } from './ActionRegistry';
import { GameClock } from '../systems/gameClock';
import { PerformanceSession } from '../systems/performanceSession';

/**
 * 演出时间必须吃**游戏时钟**，不是墙钟。
 *
 * 制作人 2026-09-19：「进入 UI 状态弹出菜单，要直接冻结整个游戏的运行」。世界暂停时
 * `Game.tick` 不推时钟，于是 `waitMs` 与天色渐变一并停住；从前走 `setTimeout` 的时候，
 * 玩家翻个背包出来会发现演出已经在背后播完了。
 *
 * 这一条只能在这里钉：真机上要凑"演出跑到一半 + 恰好开面板"才看得见。
 */

function harness() {
  const eventBus = new EventBus();
  const flagStore = new FlagStore(eventBus);
  const executor = new ActionExecutor(eventBus, flagStore);
  const gameClock = new GameClock();
  const dims: number[] = [];
  let envDim = 1;

  const deps = {
    gameClock,
    setEnvDim: (s: number) => { envDim = s; dims.push(s); },
    getEnvDim: () => envDim,
  } as unknown as ActionRegistryDeps;
  registerActionHandlers(executor, deps);
  return { executor, gameClock, dims };
}

const flush = (): Promise<void> => new Promise<void>((r) => { setTimeout(r, 0); });

describe('演出时间走游戏时钟', () => {
  it('脱手音频准备只扫描引用，不等加载、不求条件/随机，已结束会话不重新预备', async () => {
    const eventBus = new EventBus();
    const executor = new ActionExecutor(eventBus, new FlagStore(eventBus));
    const session = new PerformanceSession('cast', [], null);
    const prepareSfx = vi.fn(() => new Promise<void>(() => {}));
    const releaseAudioOwner = vi.fn();
    const evaluateCondition = vi.fn(), randomValue = vi.fn();
    registerActionHandlers(executor, {
      performanceSessions: { start: () => session },
      audioManager: { prepareSfx, releaseAudioOwner },
      evaluateCondition, randomValue,
    } as unknown as ActionRegistryDeps);
    const sound = (id: string) => ({ type: 'playSfx', params: { id } });
    const action = { type: 'runActionsDetached', params: { id: 'cast', actions: [
      { type: 'waitMs', params: { durationMs: 12000 } },
      { type: 'runActionsIf', params: { actions: [sound('crack')], elseActions: [sound('wind')] } },
      { type: 'randomBranch', params: { aboveActions: [sound('rain')], belowActions: [sound('wind')] } },
      { type: 'chooseAction', params: { options: [{ text: 'x', actions: [sound('click')] }] } },
      { type: 'strikeThreat', params: { sfx: 'crack' } },
    ] } };
    await executor.executeAwait(action);
    expect(prepareSfx).toHaveBeenCalledOnce();
    const [refs, owner] = prepareSfx.mock.calls[0] as unknown as [Array<{ id: string; positional: boolean }>, object];
    expect(owner).toBe(session);
    expect(refs).toEqual(expect.arrayContaining([
      { id: 'crack', positional: true }, { id: 'wind', positional: false },
      { id: 'rain', positional: false }, { id: 'click', positional: false },
    ]));
    expect(refs).toHaveLength(4);
    expect(evaluateCondition).not.toHaveBeenCalled();
    expect(randomValue).not.toHaveBeenCalled();
    session.finished = true;
    for (const cleanup of session.ledger.cleanups) cleanup();
    expect(releaseAudioOwner).toHaveBeenCalledWith(session);
    await executor.executeAwait(action);
    expect(prepareSfx).toHaveBeenCalledOnce();
  });

  it('脱手演出开场把后面要放的效果先预备好：落雷池 / 单个效果 / playVfx，分支两边都收，不求条件不掷随机', async () => {
    const eventBus = new EventBus();
    const executor = new ActionExecutor(eventBus, new FlagStore(eventBus));
    const session = new PerformanceSession('cast', [], null);
    const prepare = vi.fn(() => new Promise<void>(() => {}));
    const evaluateCondition = vi.fn(), randomValue = vi.fn();
    registerActionHandlers(executor, {
      performanceSessions: { start: () => session },
      audioManager: { prepareSfx: vi.fn(() => Promise.resolve()), releaseAudioOwner: vi.fn() },
      vfx: { prepare },
      evaluateCondition, randomValue,
    } as unknown as ActionRegistryDeps);
    const action = { type: 'runActionsDetached', params: { id: 'cast', actions: [
      { type: 'playVfx', params: { effect: 'storm_clouds', handle: 'c' } },
      { type: 'waitMs', params: { durationMs: 12000 } },
      { type: 'strikeThreat', params: { effects: 'bolt_a, bolt_b,,bolt_a' } },
      { type: 'runActionsIf', params: { actions: [{ type: 'strikeThreat', params: { effect: 'bolt_c' } }],
        elseActions: [{ type: 'playVfx', params: { effect: 'storm_rain' } }] } },
      { type: 'randomBranch', params: { aboveActions: [{ type: 'strikeThreat', params: { effects: ['bolt_d'] } }], belowActions: [] } },
      { type: 'playVfx', params: { instanceId: 'placed_one' } },
    ] } };
    await executor.executeAwait(action);
    expect(prepare).toHaveBeenCalledOnce();
    const [ids] = prepare.mock.calls[0] as unknown as [string[]];
    expect([...ids].sort()).toEqual(['bolt_a', 'bolt_b', 'bolt_c', 'bolt_d', 'storm_clouds', 'storm_rain']);
    expect(evaluateCondition).not.toHaveBeenCalled();
    expect(randomValue).not.toHaveBeenCalled();
  });

  it('waitMs 在时钟不走的时候一动不动', async () => {
    const { executor, gameClock } = harness();
    let done = false;
    void executor.executeAwait({ type: 'waitMs', params: { durationMs: 500 } } as never)
      .then(() => { done = true; });
    await flush();
    await flush();
    expect(done).toBe(false);          // 墙钟早过了，游戏时钟没推
    gameClock.advance(0.6);
    await flush();
    expect(done).toBe(true);
  });

  it('落雷表现种子与零声部预算原样透传，缺省不注入也不改雷链参数', async () => {
    const eventBus = new EventBus();
    const executor = new ActionExecutor(eventBus, new FlagStore(eventBus));
    const strikeThreat = vi.fn(async (_opts: unknown) => ({ hit: false, threatId: null, x: 0, y: 0 }));
    registerActionHandlers(executor, { strikeThreat } as unknown as ActionRegistryDeps);
    const chain = { seed: 7, strikes: 3, extraChance: 0.45, gapMs: 240, gapJitterMs: 110,
      visualStrikes: 5, visualGapMs: 600, visualGapJitterMs: 250 };
    await executor.executeAwait({ type: 'strikeThreat', params: {
      ...chain, effectSeed: 0, sfxVoices: 0, vfxVoices: 0,
    } });
    expect(strikeThreat).toHaveBeenLastCalledWith(expect.objectContaining({
      ...chain, effectSeed: 0, sfxVoices: 0, vfxVoices: 0,
    }));
    await executor.executeAwait({ type: 'strikeThreat', params: {} });
    const defaults = strikeThreat.mock.calls[1][0] as Record<string, unknown>;
    for (const key of ['effectSeed', 'sfxVoices', 'vfxVoices', 'seed']) expect(defaults).not.toHaveProperty(key);
  });

  it('waitMs 0 / 负数 / 非数值不排队，当场过', async () => {
    const { executor } = harness();
    for (const durationMs of [0, -5, 'x']) {
      let done = false;
      void executor.executeAwait({ type: 'waitMs', params: { durationMs } } as never)
        .then(() => { done = true; });
      await flush();
      expect(done, `durationMs=${String(durationMs)}`).toBe(true);
    }
  });

  it('天色渐变同样按游戏时钟分档：时钟不走就一档都不推', async () => {
    const { executor, gameClock, dims } = harness();
    void executor.executeAwait(
      { type: 'setSceneDim', params: { scale: 0.2, fadeMs: 1200 } } as never,
    );
    await flush();
    const afterFirstStep = dims.length;
    expect(afterFirstStep).toBe(1);    // 第一档是同步落的
    await flush();
    await flush();
    expect(dims.length).toBe(afterFirstStep);   // 时钟没推，第二档不来

    gameClock.advance(1.5);
    await flush();
    expect(dims.length).toBeGreaterThan(afterFirstStep);
  });
});
