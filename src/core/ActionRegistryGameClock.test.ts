import { describe, expect, it } from 'vitest';
import { ActionExecutor } from './ActionExecutor';
import { EventBus } from './EventBus';
import { FlagStore } from './FlagStore';
import { registerActionHandlers, type ActionRegistryDeps } from './ActionRegistry';
import { GameClock } from '../systems/gameClock';

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
