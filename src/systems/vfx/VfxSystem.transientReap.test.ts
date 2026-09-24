import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../core/EventBus';
import { AssetManager } from '../../core/AssetManager';
import type { GameContext, SceneData } from '../../data/types';
import { VfxSystem } from './VfxSystem';
import { createPlanarVfxSpace } from './vfxSpace';
import type { VfxInstanceSim } from './vfxSim';

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

function harness(viewAnchor?: { x: number; y: number }) {
  const logs: string[] = [];
  const disk: Record<string, unknown> = {
    'vfx/flame.json': FLAME, 'vfx/smoke.json': SMOKE,
    'vfx/eternal.json': { ...FLAME, id: 'eternal', emitters: [{ ...FLAME.emitters[0], life: undefined }] },
    'vfx_placements.json': { scenes: {} },
  };
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
    getViewAnchor: viewAnchor ? () => viewAnchor : undefined,
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
  const simOf = (id: string) => (sys as unknown as { instances: Map<string, { sim: VfxInstanceSim }> }).instances.get(id)?.sim;
  return { sys, flush, count, simmed, run, enter, logs, eventBus, simOf };
}

describe('临时实例收尸：点一次灭一次不留账', () => {
  it('显式淡出维持永生粒子模拟至截止，正常归位不截断；普通软停仍立即清永生粒子', async () => {
    const h = harness();
    await h.enter();
    const id = h.sys.playVfx({ effect: 'eternal', followWorld: [0, 0, 0], handle: 'weather' })!;
    await h.flush();
    h.run(0.1);
    const sim = h.simOf(id)!;
    expect(sim.liveCount).toBeGreaterThan(0);
    h.sys.stopVfx(id, { fadeMs: 200 });
    const live = sim.liveCount;
    h.run(0.1);
    expect(sim.liveCount).toBeGreaterThan(live);
    h.sys.stopVfxSoft(id);
    expect(sim.emitters[0].active).toBe(true);
    expect(h.count()).toBe(1);
    h.run(0.15);
    expect(h.count()).toBe(0);
    expect(h.sys.resolveHandle('weather')).toBeNull();
    const old = h.sys.playVfx({ effect: 'eternal', followWorld: [0, 0, 0] })!;
    await h.flush();
    h.run(0.1);
    h.sys.stopVfxSoft(old);
    expect(h.simOf(old)!.liveCount).toBe(0);
    h.sys.update(0);
    expect(h.count()).toBe(0);
  });

  it('命名临时实例替换保留唯一 ID，旧账本与仅别名停止不会误伤新实例或场景 ID', async () => {
    const h = harness();
    await h.enter();
    const a = h.sys.playVfx({ effect: 'flame', followWorld: [0, 0, 0], handle: 'weather' })!;
    const b = h.sys.playVfx({ effect: 'flame', followWorld: [0, 0, 0], handle: 'weather' })!;
    expect(b).not.toBe(a);
    expect(h.sys.resolveHandle('weather')).toBe(b);
    h.sys.stopVfx(a);
    h.sys.stopVfx(b, { handle: true }); // real ID is not a named handle
    await h.flush();
    h.run(0.1);
    expect(h.count()).toBe(1);
    expect(h.simOf(b)).toBeDefined();
    h.sys.stopVfx('weather', { handle: true });
    expect(h.sys.resolveHandle('weather')).toBeNull();
    expect(h.count()).toBe(0);
    h.sys.playVfx({ effect: 'smoke', followWorld: [0, 0, 0], handle: 'weather', oneShot: true });
    await h.flush();
    h.run(3);
    expect(h.sys.resolveHandle('weather')).toBeNull();
    h.sys.playVfx({ effect: 'flame', followWorld: [0, 0, 0], handle: 'weather' });
    h.eventBus.emit('scene:beforeUnload');
    expect(h.sys.resolveHandle('weather')).toBeNull();
  });

  it('退场维持原模拟，暂停不推进 alpha，短淡出收掉长寿粒子与别名', async () => {
    const h = harness();
    await h.enter();
    const id = h.sys.playVfx({ effect: 'smoke', followWorld: [0, 0, 0], handle: 'weather' })!;
    await h.flush();
    h.run(0.1);
    const sim = h.simOf(id)!;
    const ages = Array.from(sim.emitters[0].p.age);
    let renderedAlpha = 1;
    let renderedIds: string[] = [];
    const renderer = { beamStats: { visible: 0 }, render: vi.fn((sims: VfxInstanceSim[], _s: unknown, _h: unknown, _b: unknown, alphas: Map<string, number>) => {
      renderedIds = sims.map(s => s.id);
      renderedAlpha = alphas.get(id) ?? 1;
    }) };
    (h.sys as unknown as { renderer: unknown }).renderer = renderer;
    h.sys.stopVfx('weather', { handle: true, fadeMs: 100 });
    h.sys.update(0);
    expect(renderedAlpha).toBe(1);
    expect(Array.from(sim.emitters[0].p.age)).toEqual(ages);
    h.sys.update(0.05);
    expect(renderedAlpha).toBeCloseTo(0.5);
    expect(sim.liveCount).toBeGreaterThan(0);
    h.sys.update(0.05);
    expect(h.count()).toBe(0);
    expect(h.sys.resolveHandle('weather')).toBeNull();
    expect(renderedIds).not.toContain(id);
  });

  it('天气发射原点跟随镜头，旧粒子留在世界，暂停不挪，播完及离场照常回收', async () => {
    const view = { x: 100, y: 200 };
    const h = harness(view);
    await h.enter();
    const id = h.sys.playVfx({ effect: 'smoke', anchor: { x: 1, y: 2, h: 30 }, followCamera: true, oneShot: true })!;
    await h.flush();
    h.run(0.1);
    const sim = h.simOf(id)!;
    expect(sim).toBeDefined();
    expect(sim.anchorWorld).toEqual(h.sys.currentSpace!.anchorToWorld({ ...view, h: 30 }));
    const emitter = sim.emitters[0];
    expect(sim.liveCount).toBeGreaterThan(0);
    // Even an authored full-follow effect must not become glued to the camera.
    emitter.def.motion = { ...emitter.def.motion, followAnchor: 'full' };
    const oldX = Array.from(emitter.p.x);
    view.x += 800;
    const oldAnchor = [...sim.anchorWorld];
    h.sys.update(0);
    expect(sim.anchorWorld).toEqual(oldAnchor);
    h.sys.update(0.000001); // below fixed-step threshold: only anchor movement, no physics step
    expect(sim.anchorWorld).toEqual(h.sys.currentSpace!.anchorToWorld({ ...view, h: 30 }));
    expect(Array.from(emitter.p.x)).toEqual(oldX);
    h.run(3);
    expect(h.count()).toBe(0);
    h.sys.playVfx({ effect: 'flame', anchor: { x: 1, y: 2 }, followCamera: true });
    await h.flush();
    expect(h.count()).toBe(1);
    h.eventBus.emit('scene:beforeUnload');
    expect(h.count()).toBe(0);
  });

  it('未指定镜头跟随以及未注入镜头的调用保持静态锚点', async () => {
    for (const view of [undefined, { x: 100, y: 200 }]) {
      const h = harness(view);
      await h.enter();
      const anchor = { x: 1, y: 2, h: 30 };
      const id = h.sys.playVfx({ effect: 'smoke', anchor, followCamera: !view, oneShot: true })!;
      await h.flush();
      h.run(0.1);
      expect(h.simOf(id)!.anchorWorld).toEqual(h.sys.currentSpace!.anchorToWorld(anchor));
      h.sys.destroy();
    }
  });

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
