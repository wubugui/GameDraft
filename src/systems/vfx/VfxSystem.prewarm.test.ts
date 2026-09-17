import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../core/EventBus';
import { AssetManager } from '../../core/AssetManager';
import type { GameContext, SceneData } from '../../data/types';
import { VfxSystem } from './VfxSystem';
import type { VfxInstanceSim } from './vfxSim';
import { createPlanarVfxSpace } from './vfxSpace';

/**
 * 预热不许挤在一帧里（2026-09-16 实测：茶馆 30 个实例的预热挤在揭幕后第一帧，那一帧 361 ms）。
 * - 进场景的：揭幕前闸（遮罩下）`prepareForReveal` 建好模拟并跑完；
 * - 场景中途新建的：`update` 按帧工作量预算分片跑，跑完之前不画、不出事件、不伤人。
 */

/** 雾：预热 4 秒 = 480 子步，一个子步工作量 = 1 个发射器 + 30 个槽位 = 31 */
const HAZE = {
  id: 'haze',
  prewarmSeconds: [4, 4],
  emitters: [{
    id: 'puff',
    appearance: { image: '/img/x.png', sizeWu: 40, alphaOverLife: [[0, 0], [0.5, 1], [1, 0]], lit: false },
    spawn: { max: 30, rate: 5, shape: { kind: 'sphere', radius: 50 }, speed: [0, 5] },
    life: { seconds: [8, 10] },
    motion: { buoyancy: 3 },
  }],
};
/** 单步工作量就超过每帧预算的大实例 */
const HUGE = {
  id: 'huge',
  prewarmSeconds: [0.05, 0.05],
  emitters: [{
    id: 'dust',
    appearance: { image: '/img/x.png', sizeWu: 2, lit: false },
    spawn: { max: 5000, rate: 1, shape: { kind: 'sphere', radius: 5 }, speed: [0, 1] },
    life: { seconds: [5, 6] },
  }],
};
const STEPS = 480;
const COST = 31;
const UNITS_PER_FRAME = 4000;

function harness(opts: { placements: unknown[]; hangEffects?: boolean }) {
  const logs: string[] = [];
  const disk: Record<string, unknown> = {
    'vfx/haze.json': HAZE, 'vfx/huge.json': HUGE,
    'vfx_placements.json': { scenes: { x: { base: opts.placements } } },
  };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo) => {
    const url = String(input);
    if (opts.hangEffects && url.includes('/vfx/')) return new Promise<Response>(() => {});
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
  const rendered: string[][] = [];
  sys.setRenderer({
    render: (sims: readonly VfxInstanceSim[]) => { rendered.push(sims.map((s) => s.id)); },
    clear: () => {},
    drawCallCount: 0,
    beamStats: { visible: 0, views: 0 },
  } as never);
  const eventBus = new EventBus();
  sys.init({ eventBus } as unknown as GameContext);
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };
  const instances = () => (sys as unknown as { instances: Map<string, { sim: VfxInstanceSim | null }> }).instances;
  const sim = (id: string) => instances().get(id)?.sim ?? null;
  const lastRendered = () => rendered[rendered.length - 1];
  return { sys, eventBus, flush, sim, instances, rendered, lastRendered, logs };
}

afterEach(() => { vi.unstubAllGlobals(); });

const place = (id: string, effect = 'haze', extra: Record<string, unknown> = {}) => ({ id, effect, anchor: { x: 100, y: 100 }, ...extra });

describe('粒子预热不挤在一帧里', () => {
  it('揭幕前闸：遮罩下建好模拟、预热跑完；被停掉的不建；揭幕后第一帧直接画、不再补跑', async () => {
    const h = harness({ placements: [place('haze_1'), place('haze_2'), place('parked', 'haze', { autoStart: false })] });
    h.eventBus.emit('scene:ready');              // 不等资产：闸自己等
    await h.sys.prepareForReveal(5000);
    expect(h.sim('haze_1')?.prewarmRemaining).toBe(0);
    expect(h.sim('haze_2')?.prewarmRemaining).toBe(0);
    expect(h.sim('haze_1')!.time).toBeGreaterThan(3.9);
    expect(h.sim('parked')).toBeNull();
    h.sys.update(1 / 60);
    expect(h.rendered).toEqual([['haze_1', 'haze_2']]);
    expect(h.sys.stats.simMs).toBeLessThan(50);
  });

  it('场景中途新建的：按帧预算分片（每帧工作量不超预算），跑完之前不画、调试行显示 prewarming', async () => {
    const h = harness({ placements: [place('haze_1'), place('haze_2')] });
    h.eventBus.emit('scene:ready');
    await h.flush();                              // 不走闸：模拟由 update 建
    h.sys.update(1 / 60);
    const perFrame = Math.floor(UNITS_PER_FRAME / COST);
    expect(h.sim('haze_1')!.prewarmRemaining).toBe(STEPS - perFrame);
    expect(h.sim('haze_2')!.prewarmRemaining).toBe(STEPS);   // 这一帧的预算用完了，轮不上
    expect(h.lastRendered()).toEqual([]);
    expect(h.sys.debugSnapshot().map((r) => r.state)).toEqual(['prewarming', 'prewarming']);
    let frames = 1;
    while ((h.sim('haze_1')!.prewarmRemaining > 0 || h.sim('haze_2')!.prewarmRemaining > 0) && frames < 100) {
      const before = h.sim('haze_1')!.prewarmRemaining + h.sim('haze_2')!.prewarmRemaining;
      h.sys.update(1 / 60);
      frames++;
      const used = (before - h.sim('haze_1')!.prewarmRemaining - h.sim('haze_2')!.prewarmRemaining) * COST;
      expect(used).toBeLessThanOrEqual(UNITS_PER_FRAME);
    }
    expect(frames).toBe(Math.ceil((2 * STEPS) / perFrame));
    expect(h.lastRendered()).toEqual(['haze_1', 'haze_2']);
    expect(h.sys.debugSnapshot().map((r) => r.state)).toEqual(['active', 'active']);
  });

  it('单步工作量就超过每帧预算的大实例：每帧至少推一步，不会永远轮不上', async () => {
    const h = harness({ placements: [place('huge', 'huge')] });
    h.eventBus.emit('scene:ready');
    await h.flush();
    const total = Math.floor(0.05 * 120);
    for (let i = 1; i <= total; i++) {
      h.sys.update(1 / 60);
      expect(h.sim('huge')!.prewarmRemaining).toBe(total - i);
    }
    expect(h.lastRendered()).toEqual(['huge']);
  });

  it('揭幕前闸限时：资产装载卡住就放行揭幕并出声，不悬挂', async () => {
    const h = harness({ placements: [place('haze_1')], hangEffects: true });
    h.eventBus.emit('scene:ready');
    const t0 = performance.now();
    await h.sys.prepareForReveal(40);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(h.logs.some((m) => m.includes('没在限时内做完'))).toBe(true);
  });

  it('揭幕前闸等待中系统销毁 / 场景卸载：立刻放行，不留模拟', async () => {
    const hung = harness({ placements: [place('haze_1')], hangEffects: true });
    hung.eventBus.emit('scene:ready');
    const waiting = hung.sys.prepareForReveal(60_000);
    await hung.flush();
    hung.sys.destroy();
    await expect(waiting).resolves.toBeUndefined();

    const h = harness({ placements: [place('haze_1')] });
    h.eventBus.emit('scene:ready');
    const p = h.sys.prepareForReveal(60_000);
    h.eventBus.emit('scene:beforeUnload');
    await expect(p).resolves.toBeUndefined();
    expect(h.instances().size).toBe(0);
  });
});
