/**
 * 光柱在系统层的开关语义：`stopVfx` / 条件翻假 ⇒ 先按 fadeOut 淡掉、淡完才收模拟（不"啪"一下没了）；
 * 淡出途中 `playVfx` 开回来 ⇒ 原模拟接着淡入（不重建）。没有光柱的效果不进这条路（当场收，与原来相同）。
 */
import { describe, expect, it } from 'vitest';

import type { AssetManager } from '../../core/AssetManager';
import { EventBus } from '../../core/EventBus';
import type { GameContext, SceneData, VfxEffectDef, VfxPlacementLibrary } from '../../data/types';
import { VfxSystem } from './VfxSystem';
import { createPlanarVfxSpace } from './vfxSpace';

const BEAM: VfxEffectDef = {
  id: 'shaft',
  emitters: [],
  beams: [{
    id: 'b', mode: '3d', color: [1, 1, 1], intensity: 1, fadeIn: 0.2, fadeOut: 1,
    shape3d: { from: [0, 200, 0], to: [0, 0, 100], section: { kind: 'rect', width: 60, height: 20 } },
  }],
};

const LIB: VfxPlacementLibrary = { scenes: { 屋: { base: [{ id: '窗光', effect: 'shaft', anchor: { x: 100, y: 200 } }] } } };

function harness() {
  const eventBus = new EventBus();
  const assetManager = {
    dropJson: () => true,
    loadJson: async (url: string) => {
      if (url.endsWith('vfx_placements.json')) return JSON.parse(JSON.stringify(LIB));
      if (url.includes('shaft')) return JSON.parse(JSON.stringify(BEAM));
      throw new Error(`no ${url}`);
    },
    loadTexture: async () => { throw new Error('no textures in test'); },
  } as unknown as AssetManager;
  const logs: string[] = [];
  const sys = new VfxSystem({
    assetManager,
    getSceneData: () => ({ id: '屋' } as unknown as SceneData),
    buildSpace: () => createPlanarVfxSpace(),
    getPlayerContact: () => null,
    getAppearancePhase: () => '',
    getActiveLights: () => [],
    conditionContext: () => ({}) as never,
    hasFieldGeometry: () => false,
    playSfxAt: () => {},
    log: (m) => logs.push(m),
  });
  sys.init({ eventBus } as unknown as GameContext);
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  type Rt = { sim: { beams: { fade: number }[] } | null; draining?: boolean };
  const rt = () => (sys as unknown as { instances: Map<string, Rt> }).instances.get('窗光')!;
  return { sys, eventBus, flush, rt, logs };
}

describe('光柱开关（系统层）', () => {
  it('stopVfx：淡出途中模拟还在、状态已是 inactive；淡完才收；途中 playVfx 接着淡入', async () => {
    const h = harness();
    h.eventBus.emit('scene:ready');
    await h.flush();
    h.sys.update(1 / 60);
    for (let i = 0; i < 30; i++) h.sys.update(1 / 60);
    expect(h.rt().sim?.beams[0].fade).toBe(1);
    expect(h.sys.getInstanceState('窗光')).toBe('active');

    h.sys.stopVfx('窗光');
    // 条件重评的兜底周期 0.5 s 内会走到"停了"那一支
    for (let i = 0; i < 36; i++) h.sys.update(1 / 60);
    const sim = h.rt().sim;
    expect(sim).not.toBeNull();
    expect(h.rt().draining).toBe(true);
    expect(sim!.beams[0].fade).toBeGreaterThan(0.2);
    expect(sim!.beams[0].fade).toBeLessThan(0.9);
    expect(h.sys.getInstanceState('窗光')).toBe('inactive');

    // 淡出途中开回来：同一个模拟接着淡入
    h.sys.playVfx({ instanceId: '窗光' });
    for (let i = 0; i < 30; i++) h.sys.update(1 / 60);
    expect(h.rt().sim).toBe(sim);
    expect(h.rt().draining).toBe(false);
    expect(sim!.beams[0].fade).toBe(1);

    // 再停：淡完 1 s 之后模拟收掉
    h.sys.stopVfx('窗光');
    for (let i = 0; i < 120; i++) h.sys.update(1 / 60);
    expect(h.rt().sim).toBeNull();
    expect(h.logs.filter((l) => l.includes('无法创建'))).toEqual([]);
  });
});
