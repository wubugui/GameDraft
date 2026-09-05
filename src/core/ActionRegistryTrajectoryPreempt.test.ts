import { describe, expect, it, vi } from 'vitest';
import { ActionExecutor } from './ActionExecutor';
import { registerActionHandlers } from './ActionRegistry';
import type { ActionRegistryDeps } from './ActionRegistry';
import { EventBus } from './EventBus';
import { FlagStore } from './FlagStore';
import type { SceneData } from '../data/types';

/**
 * 「直写坐标类动作必须先停轨迹」的契约。
 *
 * 为什么需要它:轨迹抢占钩子只挂在 `moveTo` / `jumpTo` 两个口上(那是刻意的——
 * `cancelMotion` 一族同时被对话暂停/姿态复位复用,挂上去会误杀)。于是**直接写
 * `actor.x/y` 的那批动作绕开了抢占**:轨迹在跑时瞬移一个实体,下一帧就被轨迹姿态
 * 静默覆写回去,表现为"瞬移动作没生效",且不报任何错、测试也照绿。
 *
 * 这几行 `d.stopTrajectory(...)` 因此不是防御性编程,是这条路径唯一的抢占口。
 */

function harness() {
  const eventBus = new EventBus();
  const flagStore = new FlagStore(eventBus);
  const executor = new ActionExecutor(eventBus, flagStore);

  const stopTrajectory = vi.fn(() => true);
  const actor = { x: 0, y: 0 } as any;
  const npc = { x: 0, y: 0, def: { id: '甲', group: '队伍' } } as any;
  const npcOther = { x: 0, y: 0, def: { id: '乙', group: '别的组' } } as any;

  const sceneManager = {
    currentSceneData: { id: '甲村' } as unknown as SceneData,
    getNpcById: vi.fn(() => npc),
    getCurrentNpcs: vi.fn(() => [npc, npcOther]),
    mergePersistentNpcState: vi.fn(),
    moveCurrentSceneGroupBy: vi.fn(async () => 1),
  };

  const deps = {
    sceneManager,
    resolveActor: vi.fn(() => actor),
    stopTrajectory,
    snapCameraToActorIfFollowed: vi.fn(),
    setSceneEntityField: vi.fn(async () => {}),
  } as unknown as ActionRegistryDeps;

  registerActionHandlers(executor, deps);
  return { executor, stopTrajectory, actor, npc, sceneManager };
}

const run = (executor: ActionExecutor, type: string, params: Record<string, unknown>) =>
  executor.executeAwait({ type, params });

describe('直写坐标类动作会先停掉在跑的轨迹', () => {
  it('teleportEntityTo 停轨迹,且停在写坐标之前', async () => {
    const { executor, stopTrajectory, actor } = harness();
    // 停轨迹必须发生在赋值之前:反过来的话轨迹还会用旧姿态写一次
    stopTrajectory.mockImplementation(() => {
      expect(actor.x).toBe(0);
      return true;
    });
    await run(executor, 'teleportEntityTo', { target: '甲', x: 500, y: 600 });
    expect(stopTrajectory).toHaveBeenCalledWith('甲');
    expect(actor.x).toBe(500);
    expect(actor.y).toBe(600);
  });

  it('persistNpcAt 停轨迹', async () => {
    const { executor, stopTrajectory, npc } = harness();
    await run(executor, 'persistNpcAt', { target: '甲', x: 12, y: 34 });
    expect(stopTrajectory).toHaveBeenCalledWith('甲');
    expect(npc.x).toBe(12);
  });

  it('setSceneEntityPosition 对 npc 停轨迹', async () => {
    const { executor, stopTrajectory } = harness();
    await run(executor, 'setSceneEntityPosition', {
      sceneId: '甲村', entityKind: 'npc', entityId: '甲', x: 1, y: 2,
    });
    expect(stopTrajectory).toHaveBeenCalledWith('甲');
  });

  it('setSceneEntityPosition 对 hotspot 不停(热点根本不是轨迹目标)', async () => {
    const { executor, stopTrajectory } = harness();
    await run(executor, 'setSceneEntityPosition', {
      sceneId: '甲村', entityKind: 'hotspot', entityId: '门', x: 1, y: 2,
    });
    expect(stopTrajectory).not.toHaveBeenCalled();
  });

  it('moveGroupBy 只停本组成员', async () => {
    const { executor, stopTrajectory } = harness();
    await run(executor, 'moveGroupBy', { group: '队伍', dx: 10, dy: 0 });
    expect(stopTrajectory).toHaveBeenCalledWith('甲');
    expect(stopTrajectory).not.toHaveBeenCalledWith('乙');
  });

  it('参数非法时提前返回,不误停轨迹', async () => {
    const { executor, stopTrajectory } = harness();
    await run(executor, 'teleportEntityTo', { target: '甲', x: 'NaN', y: 1 });
    await run(executor, 'persistNpcAt', { target: '', x: 1, y: 1 });
    expect(stopTrajectory).not.toHaveBeenCalled();
  });
});
