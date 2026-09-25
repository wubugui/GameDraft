/**
 * 运行时生成 / 移除实体（`playTrajectory.spawn`、`spawnRuntimeNpc`）的生命周期钩子。
 *
 * 钉死的是**「同一条实例化管线」这句话本身**：`instantiateNpc` 只做到"进实体层"为止，
 * 逐实体光照 / 深度遮挡 / 透视缩放 / 投影阴影 / 像素密度全挂在 Game 的 `scene:ready` 循环里，
 * 演出中途生成的实体不经过那一趟——2026-09-12 之前这一钩根本不存在，于是轨迹 spawn 出来的
 * 铜钱 `filters` 为空、按贴图原像素画、不被木桶挡，而同一枚铜钱 `keep` 下来重进场景反而正常。
 *
 * 两侧必须成对：生成侧建的阴影 entry 不随实体自毁，移除侧不拆就是地上一坨冻住的鬼影。
 */
import { describe, expect, it, vi } from 'vitest';
import { Container } from '../engine2d';

import { SceneManager } from './SceneManager';
import type { AssetManager } from '../core/AssetManager';
import type { EventBus } from '../core/EventBus';
import type { Renderer } from '../rendering/Renderer';
import type { NpcDef, SceneData } from '../data/types';

function makeManager(): { sm: SceneManager; entityLayer: Container } {
  const entityLayer = new Container();
  const sm = new SceneManager(
    { loadTexture: vi.fn() } as unknown as AssetManager,
    { on: () => undefined, off: () => undefined, emit: () => undefined } as unknown as EventBus,
    { entityLayer } as unknown as Renderer,
  );
  // 进过场景才允许生成（spawnRuntimeNpc 头一句就是 currentScene 判空）
  (sm as unknown as { currentScene: SceneData }).currentScene = {
    id: 'test_scene', worldWidth: 1000, worldHeight: 600,
  } as unknown as SceneData;
  return { sm, entityLayer };
}

const propDef = (over: Partial<NpcDef> = {}): NpcDef => ({
  id: '_traj_1', name: '铜钱', x: 100, y: 200, interactionRange: 0, ...over,
} as NpcDef);

describe('spawnRuntimeNpc / removeRuntimeNpc 的生命周期钩子', () => {
  it('生成：onSpawned 被调一次，且此刻实体已在实体表里（钩子按 id 寻址得到）', async () => {
    const { sm } = makeManager();
    const seen: Array<{ id: string; inTable: boolean }> = [];
    sm.setRuntimeNpcHooks({
      onSpawned: (npc) => seen.push({ id: npc.id, inTable: sm.getNpcById(npc.id) === npc }),
    });

    const npc = await sm.spawnRuntimeNpc(propDef(), { persistent: false });

    expect(npc).not.toBeNull();
    // 钩子那侧（阴影定向重建走 getNpcById、像素密度遍历全表）必须在 push 之后才被调
    expect(seen).toEqual([{ id: '_traj_1', inTable: true }]);
  });

  it('移除：onRemoved 在实体还在表里时调，且与生成侧成对', async () => {
    const { sm } = makeManager();
    const order: string[] = [];
    sm.setRuntimeNpcHooks({
      onSpawned: (npc) => order.push(`spawn:${npc.id}`),
      onRemoved: (id) => order.push(`remove:${id}:${sm.getNpcById(id) ? 'still-there' : 'gone'}`),
    });

    await sm.spawnRuntimeNpc(propDef(), { persistent: false });
    expect(sm.removeRuntimeNpc('_traj_1')).toBe(true);

    expect(order).toEqual(['spawn:_traj_1', 'remove:_traj_1:still-there']);
    expect(sm.getNpcById('_traj_1')).toBeNull();
  });

  it('移除一个不在场景里的 id：不调 onRemoved（没建过的东西不许去拆）', async () => {
    const { sm } = makeManager();
    const onRemoved = vi.fn();
    sm.setRuntimeNpcHooks({ onRemoved });

    expect(sm.removeRuntimeNpc('nobody')).toBe(false);
    expect(onRemoved).not.toHaveBeenCalled();
  });

  it('生成期间切了场景：半成品被销毁、返回 null，onSpawned 一次都不调（孤儿不许挂滤镜/阴影）', async () => {
    const { sm } = makeManager();
    const onSpawned = vi.fn();
    sm.setRuntimeNpcHooks({ onSpawned });
    // 没给世界尺寸 → 走 loadTexture 那条 await；在 await 里把世代推掉 = 场景已经换了
    (sm as unknown as { assetManager: { loadTexture: () => Promise<unknown> } }).assetManager.loadTexture =
      async () => {
        (sm as unknown as { sceneEpoch: number }).sceneEpoch += 1;
        return { width: 14, height: 14 };
      };

    const npc = await sm.spawnRuntimeNpc(
      propDef({ displayImage: { image: '/resources/runtime/images/coin.png', worldWidth: 0, worldHeight: 0 } }),
      { persistent: false },
    );

    expect(npc).toBeNull();
    expect(onSpawned).not.toHaveBeenCalled();
    expect(sm.getNpcById('_traj_1')).toBeNull();
  });

  it('没注入钩子也不炸（装配顺序无关；老测试与工具侧仍能直接用 SceneManager）', async () => {
    const { sm } = makeManager();
    await expect(sm.spawnRuntimeNpc(propDef(), { persistent: false })).resolves.not.toBeNull();
    expect(sm.removeRuntimeNpc('_traj_1')).toBe(true);
  });
});
