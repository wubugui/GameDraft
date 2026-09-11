import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionExecutor } from './ActionExecutor';
import { EventBus } from './EventBus';
import { FlagStore } from './FlagStore';
import { registerActionHandlers, type ActionRegistryDeps } from './ActionRegistry';

/**
 * `playTrajectory` / `stopTrajectory` 两条 action 的 handler 契约。
 *
 * 这两条的失败模式全是**静默**的：缺参只 warn 一句、资产缺失 / 目标解析不到由 Game 侧
 * 以 `'cancelled'` 封口、`wait:false` 忘了 catch 就是一条未捕获拒绝。画面上一律
 * "什么都没发生"，所以每一条容错路径都必须在这里钉住。
 *
 * handler 自己**不装资产、不查场景**：只做参数规范化再交给注入的 `playTrajectory(id, ref, opts)`。
 */

function harness(opts: { playResult?: () => Promise<any> } = {}) {
  const eventBus = new EventBus();
  const flagStore = new FlagStore(eventBus);
  const executor = new ActionExecutor(eventBus, flagStore);

  const playAnimation = vi.fn();
  const actor = { playAnimation } as any;
  const resolveActor = vi.fn((_id: string) => actor);
  const playTrajectory = vi.fn(
    (_id: string, _ref: any, _o: any) =>
      (opts.playResult ? opts.playResult() : Promise.resolve('completed' as const)),
  );
  const stopTrajectory = vi.fn(() => true);

  const deps = {
    resolveActor,
    playTrajectory,
    stopTrajectory,
  } as unknown as ActionRegistryDeps;

  registerActionHandlers(executor, deps);
  return { executor, playTrajectory, stopTrajectory, resolveActor, playAnimation };
}

const run = (executor: ActionExecutor, type: string, params: Record<string, unknown>) =>
  executor.executeAwait({ type, params });

describe('playTrajectory', () => {
  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('最小形态：id + target 原样交给 Game，锚点缺省不给、flipX 缺省 false', async () => {
    const { executor, playTrajectory } = harness();
    await run(executor, 'playTrajectory', { trajectoryId: '轨迹_甲', target: 'npc_张三' });
    expect(playTrajectory).toHaveBeenCalledTimes(1);
    const [id, ref, o] = playTrajectory.mock.calls[0]!;
    expect(id).toBe('轨迹_甲');
    expect(ref).toBe('npc_张三');
    expect(o).toEqual({ anchor: undefined, flipX: false });
  });

  it('trajectoryId 为空/空白：warn 跳过，不调 Game', async () => {
    const { executor, playTrajectory } = harness();
    await run(executor, 'playTrajectory', { target: 'player' });
    await run(executor, 'playTrajectory', { trajectoryId: '   ', target: 'player' });
    expect(playTrajectory).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it('target 必填：缺了 warn 跳过（资产与实体无关，挂谁必须由动作说）', async () => {
    const { executor, playTrajectory } = harness();
    await run(executor, 'playTrajectory', { trajectoryId: '轨迹_甲' });
    await run(executor, 'playTrajectory', { trajectoryId: '轨迹_甲', target: '  ' });
    expect(playTrajectory).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });

  it('anchorX / anchorY 成对给 → 显式锚点；认数字字符串', async () => {
    const { executor, playTrajectory } = harness();
    await run(executor, 'playTrajectory', { trajectoryId: '轨迹_甲', target: 'player', anchorX: 100, anchorY: 200 });
    expect(playTrajectory.mock.calls[0]![2]).toEqual({ anchor: { x: 100, y: 200 }, flipX: false });
    await run(executor, 'playTrajectory', { trajectoryId: '轨迹_甲', target: 'player', anchorX: '1.5', anchorY: '-2' });
    expect(playTrajectory.mock.calls[1]![2]).toEqual({ anchor: { x: 1.5, y: -2 }, flipX: false });
  });

  it('anchorX / anchorY 只给一个或给了非数 → 当没给（目标此刻位置）并告警', async () => {
    const { executor, playTrajectory } = harness();
    await run(executor, 'playTrajectory', { trajectoryId: '轨迹_甲', target: 'player', anchorX: 100 });
    expect(playTrajectory.mock.calls[0]![2]).toEqual({ anchor: undefined, flipX: false });
    expect(console.warn).toHaveBeenCalled();
    await run(executor, 'playTrajectory', { trajectoryId: '轨迹_甲', target: 'player', anchorX: 'abc', anchorY: 3 });
    expect(playTrajectory.mock.calls[1]![2]).toEqual({ anchor: undefined, flipX: false });
  });

  it('flipX 认宽松真值', async () => {
    const { executor, playTrajectory } = harness();
    await run(executor, 'playTrajectory', { trajectoryId: '轨迹_甲', target: 'player', flipX: true });
    expect(playTrajectory.mock.calls[0]![2]).toMatchObject({ flipX: true });
    await run(executor, 'playTrajectory', { trajectoryId: '轨迹_甲', target: 'player', flipX: 'true' });
    expect(playTrajectory.mock.calls[1]![2]).toMatchObject({ flipX: true });
    await run(executor, 'playTrajectory', { trajectoryId: '轨迹_甲', target: 'player', flipX: 'false' });
    expect(playTrajectory.mock.calls[2]![2]).toMatchObject({ flipX: false });
  });

  it('animState：按 target 解析实体先切动画再开播', async () => {
    const { executor, resolveActor, playAnimation, playTrajectory } = harness();
    await run(executor, 'playTrajectory', { trajectoryId: '轨迹_甲', target: 'npc_张三', animState: 'walk' });
    expect(resolveActor).toHaveBeenCalledWith('npc_张三');
    expect(playAnimation).toHaveBeenCalledWith('walk');
    expect(playTrajectory).toHaveBeenCalledTimes(1);
  });

  it('wait 缺省 = 等：轨迹没封口前 handler 不返回', async () => {
    let settle!: (v: string) => void;
    const pending = new Promise<string>((res) => { settle = res; });
    const { executor } = harness({ playResult: () => pending });
    let done = false;
    const p = run(executor, 'playTrajectory', { trajectoryId: '轨迹_甲', target: 'player' }).then(() => { done = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(false);
    settle('completed');
    await p;
    expect(done).toBe(true);
  });

  it('wait:false：立刻返回（不等轨迹），且不悬挂', async () => {
    // 永不 settle 的 Promise：wait:false 若真去 await 它，这条用例会超时
    const { executor, playTrajectory } = harness({ playResult: () => new Promise<string>(() => {}) });
    await expect(
      run(executor, 'playTrajectory', { trajectoryId: '轨迹_甲', target: 'player', wait: false }),
    ).resolves.toBeUndefined();
    expect(playTrajectory).toHaveBeenCalledTimes(1);
  });

  it('wait 认宽松假值（字符串 "false" / 0）', async () => {
    for (const falsy of ['false', 0]) {
      const { executor } = harness({ playResult: () => new Promise<string>(() => {}) });
      await expect(
        run(executor, 'playTrajectory', { trajectoryId: '轨迹_甲', target: 'player', wait: falsy }),
      ).resolves.toBeUndefined();
    }
  });

  it('wait:false 时轨迹 Promise 拒绝也被吞掉（不留未捕获拒绝）', async () => {
    const { executor } = harness({ playResult: () => Promise.reject(new Error('boom')) });
    await expect(
      run(executor, 'playTrajectory', { trajectoryId: '轨迹_甲', target: 'player', wait: false }),
    ).resolves.toBeUndefined();
    // 让那条被 void 掉的 Promise 走完微任务队列，确认没有炸出去
    await new Promise((r) => setTimeout(r, 0));
    expect(console.warn).toHaveBeenCalled();
  });
});

describe('stopTrajectory', () => {
  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('把 target 与两个开关原样交给播放系统', async () => {
    const { executor, stopTrajectory } = harness();
    await run(executor, 'stopTrajectory', { target: 'player', toEnd: true, reset: true });
    expect(stopTrajectory).toHaveBeenCalledWith('player', { toEnd: true, reset: true });
  });

  it('两个开关缺省都是 false（不落终姿、不还原）', async () => {
    const { executor, stopTrajectory } = harness();
    await run(executor, 'stopTrajectory', { target: 'npc_张三' });
    expect(stopTrajectory).toHaveBeenCalledWith('npc_张三', { toEnd: false, reset: false });
  });

  it('target 为空：warn 跳过，不调播放系统', async () => {
    const { executor, stopTrajectory } = harness();
    await run(executor, 'stopTrajectory', {});
    await run(executor, 'stopTrajectory', { target: '  ' });
    expect(stopTrajectory).not.toHaveBeenCalled();
  });

  it('目标身上没轨迹在跑（返回 false）是常态，不告警', async () => {
    const eventBus = new EventBus();
    const executor = new ActionExecutor(eventBus, new FlagStore(eventBus));
    const stopTrajectory = vi.fn(() => false);
    registerActionHandlers(executor, { stopTrajectory } as unknown as ActionRegistryDeps);
    await run(executor, 'stopTrajectory', { target: 'player' });
    expect(stopTrajectory).toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });
});

/**
 * 2026-09-11 制作人重定：播放位置在播放时给（`at` 位置引用：数字 / 实体此刻位置 / 场景曲线插槽），
 * 运动对象可以是播放时临时生成的（`spawn`：图片 / 角色模板，可不在场景里，`keep` 播完留在终点）。
 * handler 只做规范化：`at` 原样交给 Game（那边解析），`spawn` 清成 TrajectorySpawnSpec；老写法 anchorX/anchorY 仍认。
 */
describe('playTrajectory · at / spawn', () => {
  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('at 三种形状原样交给 Game；有 at 时 anchorX/anchorY 不再参与', async () => {
    const { executor, playTrajectory } = harness();
    await run(executor, 'playTrajectory', { trajectoryId: 't', target: 'player', at: { kind: 'entity', id: 'npc_a' }, anchorX: 1, anchorY: 2 });
    await run(executor, 'playTrajectory', { trajectoryId: 't', target: 'player', at: { kind: 'slot', trajectoryId: 'coin_drop', slotId: 'dropper' } });
    await run(executor, 'playTrajectory', { trajectoryId: 't', target: 'player', at: { x: '10', y: 20 } });
    expect(playTrajectory.mock.calls[0]![2]).toMatchObject({ at: { kind: 'entity', id: 'npc_a' }, anchor: undefined });
    expect(playTrajectory.mock.calls[1]![2]).toMatchObject({ at: { kind: 'slot', trajectoryId: 'coin_drop', slotId: 'dropper' } });
    expect(playTrajectory.mock.calls[2]![2]).toMatchObject({ at: { kind: 'point', x: 10, y: 20 } });
  });

  it('at 形状不对：warn，按没给处理（不阻止播放）', async () => {
    const { executor, playTrajectory } = harness();
    await run(executor, 'playTrajectory', { trajectoryId: 't', target: 'player', at: { kind: 'slot' } });
    expect(playTrajectory).toHaveBeenCalledTimes(1);
    expect(playTrajectory.mock.calls[0]![2].at).toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('at 形状不对'));
  });

  it('spawn：图片 / 角色模板两档；有 spawn 时 target 可空；keep 认宽松真值', async () => {
    const { executor, playTrajectory, playAnimation } = harness();
    await run(executor, 'playTrajectory', { trajectoryId: 't', spawn: { kind: 'image', src: '/resources/runtime/images/coin.png', worldWidth: '14', worldHeight: 14, keep: 'true', anchor: { x: 0.5, y: 0.5 } }, animState: 'idle' });
    await run(executor, 'playTrajectory', { trajectoryId: 't', spawn: { kind: 'character', characterId: 'cat', id: 'cat_1', name: '猫' } });
    expect(playTrajectory).toHaveBeenCalledTimes(2);
    expect(playTrajectory.mock.calls[0]![1]).toBe('');
    expect(playTrajectory.mock.calls[0]![2].spawn).toEqual({ kind: 'image', src: '/resources/runtime/images/coin.png', worldWidth: 14, worldHeight: 14, keep: true, anchor: { x: 0.5, y: 0.5 } });
    expect(playTrajectory.mock.calls[0]![2].animState).toBe('idle');
    // animState 留给 Game 在生成之后切，handler 不去解析一个还不存在的实体
    expect(playAnimation).not.toHaveBeenCalled();
    expect(playTrajectory.mock.calls[1]![2].spawn).toEqual({ kind: 'character', characterId: 'cat', id: 'cat_1', name: '猫' });
  });

  it('spawn 形状不对（缺 src / 未知 kind）：warn，且没有 target 时整条跳过', async () => {
    const { executor, playTrajectory } = harness();
    await run(executor, 'playTrajectory', { trajectoryId: 't', spawn: { kind: 'image' } });
    await run(executor, 'playTrajectory', { trajectoryId: 't', spawn: { kind: 'hologram', src: 'x' } });
    expect(playTrajectory).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('spawn 形状不对'));
  });
});

/**
 * 位置动作的 `at`：有它就覆盖 x/y（解析在 Game 侧，handler 只调注入的 resolvePositionRef）；
 * 解析不出来 warn 并按 x/y 走；没写 at 时**不调**解析器（老的测试替身 / 老数据零改动）。
 */
describe('位置动作 · at 覆盖 x/y', () => {
  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  function posHarness(resolved: { x: number; y: number } | null) {
    const eventBus = new EventBus();
    const executor = new ActionExecutor(eventBus, new FlagStore(eventBus));
    const actor = { x: 0, y: 0, playAnimation: vi.fn(), moveTo: vi.fn(() => Promise.resolve()), jumpTo: vi.fn(() => Promise.resolve()) } as any;
    const resolvePositionRef = vi.fn(async (_raw: unknown) => resolved);
    const stopTrajectory = vi.fn(() => false);
    const spawnCutsceneActor = vi.fn();
    const deps = { resolveActor: vi.fn(() => actor), resolvePositionRef, stopTrajectory, spawnCutsceneActor, snapCameraToActorIfFollowed: vi.fn() } as unknown as ActionRegistryDeps;
    registerActionHandlers(executor, deps);
    return { executor, actor, resolvePositionRef, spawnCutsceneActor };
  }

  it('teleportEntityTo：at 解析成功 → 用解析出的位置', async () => {
    const { executor, actor, resolvePositionRef } = posHarness({ x: 123, y: 456 });
    await run(executor, 'teleportEntityTo', { target: 'player', x: 1, y: 2, at: { kind: 'slot', trajectoryId: 'coin_drop', slotId: 'dropper' } });
    expect(resolvePositionRef).toHaveBeenCalledWith({ kind: 'slot', trajectoryId: 'coin_drop', slotId: 'dropper' });
    expect([actor.x, actor.y]).toEqual([123, 456]);
  });

  it('teleportEntityTo：at 解析失败 → warn 并按 x/y 走；没写 at 不调解析器', async () => {
    const { executor, actor, resolvePositionRef } = posHarness(null);
    await run(executor, 'teleportEntityTo', { target: 'player', x: 7, y: 8, at: { kind: 'entity', id: 'ghost' } });
    expect([actor.x, actor.y]).toEqual([7, 8]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('at 解析不出位置'));
    resolvePositionRef.mockClear();
    await run(executor, 'teleportEntityTo', { target: 'player', x: 9, y: 10 });
    expect(resolvePositionRef).not.toHaveBeenCalled();
    expect([actor.x, actor.y]).toEqual([9, 10]);
  });

  it('cutsceneSpawnActor：at 覆盖生成点', async () => {
    const { executor, spawnCutsceneActor } = posHarness({ x: 50, y: 60 });
    await run(executor, 'cutsceneSpawnActor', { id: '_cut_a', name: 'A', x: 1, y: 2, at: { kind: 'entity', id: 'player' } });
    expect(spawnCutsceneActor).toHaveBeenCalledWith('_cut_a', 'A', 50, 60);
  });
});
