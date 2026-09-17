import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../core/EventBus';
import { AssetManager } from '../../core/AssetManager';
import type { GameContext, SceneData } from '../../data/types';
import { VfxSystem } from './VfxSystem';
import { createPlanarVfxSpace } from './vfxSpace';

/**
 * 临时实例（手持挂件的火苗 / 一次性的熄灭烟）**必须收干净**：点一次灭一次不能在 `instances` 里留一份。
 * 真跑（2026-09-16 火把养成验证）观察到点灭一轮 `instances` 稳定 +2、之后再不掉，这里把两条路各钉一个。
 */

/** 一直发的火苗：软停（切状态 / 卸下）之后在飞的老化完就该收 */
const FLAME = {
  id: 'flame',
  emitters: [{
    id: 'core',
    appearance: { image: '/img/x.png', sizeWu: 3, alphaOverLife: [[0, 1], [1, 0]], blend: 'add', lit: false },
    spawn: { max: 40, rate: 60, shape: { kind: 'sphere', radius: 1 }, speed: [0, 1] },
    life: { seconds: [0.2, 0.3] },
  }],
};
/** 一次性的烟：发射器有 duration，放完就该自己收 */
const SMOKE = {
  id: 'smoke',
  emitters: [
    {
      id: 'puff',
      appearance: { image: '/img/x.png', sizeWu: 6, alphaOverLife: [[0, 1], [1, 0]], blend: 'add', lit: false },
      spawn: { max: 8, burst: 4, shape: { kind: 'sphere', radius: 1 }, speed: [0, 2] },
      life: { seconds: [0.3, 0.5] },
    },
    {
      id: 'wisp',
      appearance: { image: '/img/x.png', sizeWu: 4, alphaOverLife: [[0, 1], [1, 0]], blend: 'add', lit: false },
      spawn: { max: 20, rate: 30, duration: 0.5, shape: { kind: 'sphere', radius: 1 }, speed: [0, 3] },
      life: { seconds: [0.4, 0.8] },
    },
  ],
};

function harness() {
  const logs: string[] = [];
  const disk: Record<string, unknown> = { 'vfx/flame.json': FLAME, 'vfx/smoke.json': SMOKE, 'vfx_placements.json': { scenes: {} } };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo) => {
    const url = String(input);
    const hit = Object.keys(disk).find((k) => url.endsWith(k));
    if (!hit) return { ok: false, status: 404, json: async () => null } as unknown as Response;
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(disk[hit])) } as unknown as Response;
  }));
  const sys = new VfxSystem({
    assetManager: new AssetManager(),
    getSceneData: () => ({ id: 'x' } as unknown as SceneData),
    buildSpace: () => createPlanarVfxSpace(),
    getPlayerContact: () => null,
    getAppearancePhase: () => '',
    getActiveLights: () => [],
    conditionContext: () => ({}) as never,
    hasFieldGeometry: () => false,
    playSfxAt: () => {},
    log: (m: string) => { logs.push(m); },
  });
  const eventBus = new EventBus();
  sys.init({ eventBus } as unknown as GameContext);
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };
  const count = () => (sys as unknown as { instances: Map<string, unknown> }).instances.size;
  /** 有几个实例**真的建出了模拟**（不加这一条，测试可能只是在测"建不出来也会被收掉"） */
  const simmed = () => [...(sys as unknown as { instances: Map<string, { sim: unknown }> }).instances.values()]
    .filter((v) => v.sim !== null).length;
  const run = (seconds: number) => { for (let i = 0; i < Math.round(seconds * 60); i++) sys.update(1 / 60); };
  /** 场景就绪：VfxSystem 的 space 是 scene:ready 建的，不发这一下 update 整段早退 */
  const enter = async () => { eventBus.emit('scene:ready'); await flush(); };
  return { sys, flush, count, simmed, run, enter, logs };
}

describe('临时实例收尸：点一次灭一次不留账', () => {
  it('软停的火苗：在飞的老化完就收，点灭十轮不涨', async () => {
    const h = harness();
    await h.enter();
    for (let i = 0; i < 10; i++) {
      const id = h.sys.playVfx({ effect: 'flame', followWorld: [0, 0, 0] })!;
      await h.flush();
      h.run(0.3);
      expect(h.count()).toBe(1);
      expect(h.simmed()).toBe(1);
      h.sys.stopVfxSoft(id);
      h.run(1.5);
      expect(h.count()).toBe(0);
    }
  });

  it('一次性的烟：放完自己收（没人来停），十轮不涨', async () => {
    const h = harness();
    await h.enter();
    for (let i = 0; i < 10; i++) {
      h.sys.playVfx({ effect: 'smoke', followWorld: [0, 0, 0], oneShot: true });
      await h.flush();
      h.run(0.2);
      expect(h.count()).toBe(1);
      expect(h.simmed()).toBe(1);
      h.run(3);
      expect(h.count()).toBe(0);
    }
  });

  it('还没装完就被停掉的（火把点着当帧又熄了）：不留残壳', async () => {
    const h = harness();
    await h.enter();
    const a = h.sys.playVfx({ effect: 'flame', followWorld: [0, 0, 0] })!;
    h.sys.stopVfxSoft(a);                 // 效果 JSON 还在路上
    await h.flush();
    h.run(1);
    expect(h.count()).toBe(0);
    const b = h.sys.playVfx({ effect: 'smoke', followWorld: [0, 0, 0], oneShot: true })!;
    h.sys.stopVfx(b);
    await h.flush();
    h.run(1);
    expect(h.count()).toBe(0);
  });
});
