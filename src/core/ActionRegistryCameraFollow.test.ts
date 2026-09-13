import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionExecutor } from './ActionExecutor';
import { EventBus } from './EventBus';
import { FlagStore } from './FlagStore';
import { registerActionHandlers, type ActionRegistryDeps } from './ActionRegistry';

/**
 * `cameraFollowActor` 的两种跟法（2026-09-12）与 `faceEntity` 的 `at`。
 *
 * - `target`：实体 id，老语义（Game 每帧按 id 重解析，实体没了自动解除）；
 * - `at`：位置引用，交给 Game 每帧求值——"曲线此刻播到的点"就走这条。`at` 优先，
 *   形状不对 / 绑定失败（相对曲线、缺插槽…）退回 `target`。
 *
 * handler 自己不求值、不装资产：只做参数规范化再交给注入的能力。失败模式全是静默的（镜头不动），故逐条钉住。
 */

function harness(opts: { bindOk?: boolean; resolved?: { x: number; y: number } | null } = {}) {
  const eventBus = new EventBus();
  const flagStore = new FlagStore(eventBus);
  const executor = new ActionExecutor(eventBus, flagStore);
  const setCameraFollowTarget = vi.fn();
  const setCameraFollowRef = vi.fn(async () => opts.bindOk ?? true);
  const setFacing = vi.fn();
  const actors: Record<string, { x: number; y: number; setFacing: typeof setFacing }> = {
    npc_甲: { x: 100, y: 0, setFacing },
    npc_乙: { x: 40, y: 0, setFacing },
  };
  const resolveActor = vi.fn((id: string) => actors[id] ?? null);
  const resolvePositionRef = vi.fn(async () => (opts.resolved === undefined ? { x: 300, y: 5 } : opts.resolved));
  const deps = {
    setCameraFollowTarget, setCameraFollowRef, resolveActor, resolvePositionRef,
  } as unknown as ActionRegistryDeps;
  registerActionHandlers(executor, deps);
  const run = (type: string, params: Record<string, unknown>) => executor.executeAwait({ type, params });
  return { run, setCameraFollowTarget, setCameraFollowRef, setFacing, resolvePositionRef };
}

const CURRENT = { kind: 'curve', trajectoryId: 'coin_drop_demo', point: 'current' };

describe('cameraFollowActor', () => {
  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('老数据只有 target：照旧按实体跟；smooth 缺省 = 硬锁（snap=true）', async () => {
    const h = harness();
    await h.run('cameraFollowActor', { target: 'npc_验证铜钱' });
    await h.run('cameraFollowActor', { target: 'npc_验证铜钱', smooth: true });
    expect(h.setCameraFollowTarget.mock.calls).toEqual([['npc_验证铜钱', true], ['npc_验证铜钱', false]]);
    expect(h.setCameraFollowRef).not.toHaveBeenCalled();
  });

  it('at：规范化后交给 Game 绑定（曲线此刻播到的点），不再碰 target', async () => {
    const h = harness();
    await h.run('cameraFollowActor', { at: CURRENT, smooth: true });
    expect(h.setCameraFollowRef).toHaveBeenCalledWith(CURRENT, false);
    expect(h.setCameraFollowTarget).not.toHaveBeenCalled();
  });

  it('at 与 target 都给：at 优先；at 绑定失败（相对曲线 / 缺资产）退回 target', async () => {
    const ok = harness();
    await ok.run('cameraFollowActor', { at: CURRENT, target: 'npc_甲' });
    expect(ok.setCameraFollowTarget).not.toHaveBeenCalled();
    const bad = harness({ bindOk: false });
    await bad.run('cameraFollowActor', { at: CURRENT, target: 'npc_甲' });
    expect(bad.setCameraFollowRef).toHaveBeenCalledTimes(1);
    expect(bad.setCameraFollowTarget).toHaveBeenCalledWith('npc_甲', true);
  });

  it('at 形状不对：warn，按没给处理（有 target 就跟 target）', async () => {
    const h = harness();
    await h.run('cameraFollowActor', { at: { kind: '瞎写' }, target: 'npc_甲' });
    expect(h.setCameraFollowRef).not.toHaveBeenCalled();
    expect(h.setCameraFollowTarget).toHaveBeenCalledWith('npc_甲', true);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('at 形状不对'));
  });

  it('两个都没有：warn 跳过，镜头状态一个都不碰', async () => {
    const h = harness();
    await h.run('cameraFollowActor', {});
    await h.run('cameraFollowActor', { target: '  ' });
    expect(h.setCameraFollowRef).not.toHaveBeenCalled();
    expect(h.setCameraFollowTarget).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalled();
  });
});

describe('faceEntity 的 at（朝向一个位置引用所在的一侧）', () => {
  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('at 求得出：朝它转（dx = 点.x − 实体.x），不再看 faceTarget / direction', async () => {
    const h = harness({ resolved: { x: 300, y: 5 } });
    await h.run('faceEntity', { target: 'npc_甲', at: CURRENT, faceTarget: 'npc_乙', direction: 'left' });
    expect(h.resolvePositionRef).toHaveBeenCalledWith(CURRENT);
    expect(h.setFacing).toHaveBeenCalledTimes(1);
    expect(h.setFacing).toHaveBeenCalledWith(200, 5);
  });

  it('at 求不出（播放头还没产生）：退回 faceTarget', async () => {
    const h = harness({ resolved: null });
    await h.run('faceEntity', { target: 'npc_甲', at: CURRENT, faceTarget: 'npc_乙' });
    expect(h.setFacing).toHaveBeenCalledWith(-60, 0);
  });

  it('只有 at 也是合法写法；三者都没有 warn 跳过', async () => {
    const h = harness();
    await h.run('faceEntity', { target: 'npc_甲', at: CURRENT });
    expect(h.setFacing).toHaveBeenCalledTimes(1);
    await h.run('faceEntity', { target: 'npc_甲' });
    expect(h.setFacing).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('至少一个'));
  });
});
