import { describe, expect, it } from 'vitest';
import type { VfxEffectDef } from '../../data/types';
import { resolveSceneWind } from '../../utils/sceneWind';
import { VFX_SUBSTEP, VfxInstanceSim } from './vfxSim';
import { createPlanarVfxSpace } from './vfxSpace';

const h = 1 / 120;
const ctx = { time: 0, fields: [], player: null };
const effect = (): VfxEffectDef => ({ id: 'timing', emitters: [{
  id: 'smoke', appearance: { image: '/smoke.png', sizeWu: 10 },
  spawn: { max: 256, rate: 4, burst: 2, speed: [1, 4] },
  life: { seconds: [20, 25] }, motion: { buoyancy: 2 },
}] });
const sim = (doc: VfxEffectDef, seed = 931) => new VfxInstanceSim('same-id', doc, [0, 100, 0], seed, createPlanarVfxSpace());
function sample(s: VfxInstanceSim, frames = 600) {
  const births: number[] = []; let live = s.liveCount;
  for (let i = 0; i < frames; i++) {
    s.step(h, { ...ctx, time: i * h });
    if (s.liveCount > live) births.push(i);
    live = s.liveCount;
  }
  const p = s.emitters[0].p;
  return { births, x: [...p.x], y: [...p.y], age: [...p.age], life: [...p.life] };
}

describe('seeded ambient timing', () => {
  it('different seeds stagger warm starts and ongoing emissions; replay stays exact', () => {
    const doc = effect(); doc.prewarmSeconds = [1, 5]; doc.emitters[0].spawn.intervalJitter = 0.4;
    const a = sim(doc), b = sim(doc, 1029);
    a.step(h, ctx); b.step(h, ctx);
    expect(a.time).not.toBe(b.time);
    expect(a.emitters[0].p.age[0]).toBeGreaterThan(0.5);
    expect(a.emitters[0].p.y[0]).toBeGreaterThan(100); // physically simulated, not just a changed age
    const aa = sample(sim(doc)), bb = sample(sim(doc, 1029));
    expect(aa.births).not.toEqual(bb.births);
    expect(aa).toEqual(sample(sim(doc)));
    expect(new Set(aa.births.slice(1).map((n, i) => n - aa.births[i])).size).toBeGreaterThan(2);
  });
  it('disabled fields preserve the previous fixed burst and emission cadence exactly', () => {
    const doc = effect(), explicit = effect();
    explicit.prewarmSeconds = [0, 0]; explicit.emitters[0].spawn.intervalJitter = 0;
    expect(sample(sim(doc))).toEqual(sample(sim(explicit)));
    expect(sample(sim(doc), 120).births).toEqual([0, 30, 60, 90]);
  });
  it('jitter alone changes emission times without requiring a warm start', () => {
    const doc = effect(); doc.emitters[0].spawn.intervalJitter = 0.5;
    const a = sample(sim(doc)), b = sample(sim(doc, 1029));
    expect(a.births[0]).toBe(0); // explicitly authored burst remains immediate
    expect(a.births).not.toEqual(b.births);
    expect(a.births.length).toBeGreaterThan(14);
    expect(a.births.length).toBeLessThan(28);
  });
  it('prewarm only runs once, suppresses historical hit/sound events and respects stop', () => {
    const doc = effect(); doc.prewarmSeconds = [2, 2];
    doc.emitters[0].spawn = { max: 2, burst: 1, speed: [0, 0] };
    doc.emitters[0].motion = { gravity: 865 };
    doc.emitters[0].collision = { ground: 'kill' };
    doc.emitters[0].sound = { hit: 'do-not-replay' };
    const a = sim(doc); a.step(h, ctx);
    expect(a.liveCount).toBe(0); expect(a.events).toEqual([]);
    const t = a.time; a.step(h, ctx); expect(a.time - t).toBeCloseTo(h);
    const stopped = sim(effect()); stopped.stop(); stopped.step(h, ctx); expect(stopped.liveCount).toBe(0);
    const stoppedWarm = sim(doc); stoppedWarm.stop(); stoppedWarm.step(h, ctx); expect(stoppedWarm.liveCount).toBe(0);
  });
  describe('prewarm in slices (VfxSystem 揭幕前 / 按帧预算分片跑)', () => {
    const windy = resolveSceneWind({ direction: [1, 0, 0.3], speed: 180, gust: { amount: 0.8, period: 3 } })!;
    const warmDoc = (): VfxEffectDef => {
      const doc = effect();
      doc.prewarmSeconds = [3, 3];
      doc.emitters[0].motion = { buoyancy: 2, drag: 1.5 };   // drag > 0 ⇒ 被风带着走，风的钟错一拍就对不上
      return doc;
    };
    const at = (t: number) => ({ ...ctx, time: t, wind: windy, windTime: t });
    const snapshot = (s: VfxInstanceSim) => {
      const p = s.emitters[0].p;
      return { time: s.time, live: s.liveCount, x: [...p.x], y: [...p.y], z: [...p.z], vx: [...p.vx], age: [...p.age] };
    };

    it('分几片、每片多少步，与一口气补完逐位相同；之后逐帧推进也相同', () => {
      const whole = sim(warmDoc()), sliced = sim(warmDoc());
      expect(sliced.prewarmRemaining).toBe(Math.floor(3 / VFX_SUBSTEP));
      // 分片之间墙上的钟照样往前走（真跑时每片隔一帧）：时间锚在第一片，结果不受影响
      let t = 0.5, k = 0;
      while (sliced.prewarmRemaining > 0) {
        sliced.advancePrewarm(at(t), 7 + (k++ % 5) * 13);
        t += 1 / 60;
      }
      expect(k).toBeGreaterThan(3);
      expect(sliced.events).toEqual([]);
      whole.step(h, at(0.5));
      sliced.step(h, at(0.5));
      expect(snapshot(sliced)).toEqual(snapshot(whole));
      for (let i = 1; i < 120; i++) {
        whole.step(h, at(0.5 + i * h));
        sliced.step(h, at(0.5 + i * h));
      }
      expect(snapshot(sliced)).toEqual(snapshot(whole));
    });

    it('没跑完不算放完；返回实际步数；工作量 = 发射器数 + 全部槽位', () => {
      const s = sim(warmDoc());
      const total = s.prewarmRemaining;
      expect(s.prewarmStepCost).toBe(1 + 256);
      expect(s.advancePrewarm(at(0), 100)).toBe(100);
      expect(s.prewarmRemaining).toBe(total - 100);
      expect(s.finished).toBe(false);
      expect(s.advancePrewarm(at(0), 0)).toBe(0);
      expect(s.advancePrewarm(at(0), 0.9)).toBe(0);
      expect(s.advancePrewarm(at(0), 1e9)).toBe(total - 100);
      expect(s.prewarmRemaining).toBe(0);
      expect(s.advancePrewarm(at(0), 10)).toBe(0);
      const cold = sim(effect());
      expect(cold.prewarmRemaining).toBe(0);
      expect(cold.advancePrewarm(at(0), 10)).toBe(0);
    });
  });
  it.each([[3, 1], [-1, 2], [0, 16], [0, NaN]])('rejects invalid prewarm range %j', (...warm) => {
    const doc = effect(); doc.prewarmSeconds = warm as [number, number]; expect(() => sim(doc)).toThrow('prewarmSeconds');
  });
  it.each([-0.1, 1, NaN, Infinity])('rejects invalid interval jitter %s', (v) => {
    const doc = effect(); doc.emitters[0].spawn.intervalJitter = v; expect(() => sim(doc)).toThrow('intervalJitter');
  });
});
