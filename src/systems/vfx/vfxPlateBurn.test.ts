/**
 * 可燃薄片（纸钱被引燃）与外部供点发射形状的行为契约。空间是平面近似（没有壳 / 地面恒 0），
 * 纸钱铺在原点周围的圆盘里，一段火焰杵在其中一张纸上。
 */
import { describe, expect, it } from 'vitest';
import { resolveBurnable, type ResolvedBurnable } from '../../data/burnables';
import type { VfxEffectDef, VfxFireSegment } from '../../data/types';
import { plateBurnDir, plateBurnProgress } from './vfxPlateBurn';
import { VfxInstanceSim, type VfxStepContext } from './vfxSim';
import { createPlanarVfxSpace } from './vfxSpace';

const space = createPlanarVfxSpace();

/** 纸钱模板：火线 逆流 2 / 顺流 18 cm/s（片宽 16 wu ≈ 18.2 cm ⇒ 往上烧 ≈ 1 s、往下 / 横着 ≈ 9 s） */
function paperTemplate(over: Record<string, unknown> = {}): ResolvedBurnable {
  const t = resolveBurnable({
    id: 'paper_t', image: '/x.png', widthCm: 18, heightCm: 18, mode: 'spread',
    spread: { speedOpposed: 2, speedConcurrent: 18 }, flameLength: 8, ignitionDelay: 0.2, ...over,
  });
  if (!t) throw new Error('template');
  return t;
}
const templates = new Map([['paper_t', paperTemplate()]]);
const opts = { burnTemplates: templates };

function paperEffect(flammable = true): VfxEffectDef {
  return {
    id: 'paper',
    emitters: [{
      id: 'paper',
      simulation: {
        solver: 'plate', spawnPlacement: 'surface', initialVelocity: 'rest',
        influences: { sceneWind: false, wind: false, airflow: false, stimulus: false },
        recycle: { mode: 'none' },
        surfaceRadius: 300,
      },
      appearance: { sizeWu: 16 },
      spawn: { max: 60, burst: 60, shape: { kind: 'area', radius: 300 } },
      plate: {
        size: [16, 10], terminalSpeed: 90,
        ...(flammable ? { burnable: { template: 'paper_t' } } : {}),
      },
    }],
  } as VfxEffectDef;
}

function ctx(fires: VfxFireSegment[] = []): VfxStepContext {
  return { fields: [], player: null, time: 0, fires };
}

function positions(sim: VfxInstanceSim): string[] {
  const p = sim.emitters[0].p;
  const out: string[] = [];
  for (let i = 0; i < p.cap; i++) out.push(p.alive[i] ? `${i}:${p.x[i].toFixed(4)},${p.z[i].toFixed(4)}` : `${i}:-`);
  return out;
}

describe('可燃薄片', () => {
  it('碰到火焰段够引燃时间就着、烧完永久没了、不补回，且只烧碰到的那几张（加蔓延）', () => {
    const sim = new VfxInstanceSim('i', paperEffect(), [0, 0, 0], 7, space, 1, opts);
    sim.step(1 / 60, ctx());
    const p = sim.emitters[0].p;
    const before = p.liveCount;
    expect(before).toBe(60);
    // 挑一张纸，火焰段从它身上竖直往上
    const k = 5;
    const fire: VfxFireSegment = { x: p.x[k], y: p.y[k] - 2, z: p.z[k], ax: 0, ay: 1, az: 0, len: 10, r: 2 };
    for (let s = 0; s < 30; s++) sim.step(1 / 60, ctx([fire]));   // 0.5 s：受热 0.2 s 后着
    const burn = sim.emitters[0].burn!;
    expect(burn.burnT[k]).toBeGreaterThanOrEqual(0);
    const dur = burn.dur[k];
    expect(dur).toBeGreaterThan(0.5);
    expect(dur).toBeLessThan(10);
    for (let s = 0; s < Math.ceil((dur + 0.5) * 60); s++) sim.step(1 / 60, ctx());   // 烧完
    expect(p.alive[k]).toBe(0);
    expect(burn.burnt[k]).toBe(1);
    const newly = sim.takeNewlyBurnt();
    expect(newly.length).toBe(1);
    expect(newly[0].slots).toContain(k);
    expect(p.liveCount).toBeLessThan(before);
    // 离得远的纸没着
    let far = 0;
    for (let i = 0; i < p.cap; i++) {
      if (!p.alive[i]) continue;
      if (Math.hypot(p.x[i] - fire.x, p.z[i] - fire.z) > 200) { far++; expect(burn.burnt[i]).toBe(0); }
    }
    expect(far).toBeGreaterThan(0);
  });

  it('火线从被火碰到的那一边扫过去；往上扫比往下扫快（模板火线速度 × 朝向）', () => {
    const sim = new VfxInstanceSim('i', paperEffect(), [0, 0, 0], 7, space, 1, opts);
    sim.step(1 / 60, ctx());
    const e = sim.emitters[0];
    const p = e.p;
    const A = e.plate!.arr;
    const burn = e.burn!;
    const k = 9;
    // 把这张纸竖起来：切线朝上
    A.tx[k] = 0; A.ty[k] = 1; A.tz[k] = 0;
    A.nx[k] = 0; A.ny[k] = 0; A.nz[k] = 1;
    // 火从下面（−t 那侧）来 ⇒ 火线从 u=0 往上扫（dir +1），顺流快
    const below: VfxFireSegment = { x: p.x[k], y: p.y[k] - 30, z: p.z[k], ax: 0, ay: 1, az: 0, len: 22, r: 3 };
    for (let s = 0; s < 20 && burn.burnT[k] < 0; s++) sim.step(1 / 60, ctx([below]));
    expect(burn.burnT[k]).toBeGreaterThanOrEqual(0);
    expect(plateBurnDir(burn, k)).toBe(1);
    const upDur = burn.dur[k];
    expect(upDur).toBeCloseTo(16 / 0.88 / 18, 3);
    expect(plateBurnProgress(burn, k)).toBeGreaterThanOrEqual(0);
    // 另一张：火从上面来 ⇒ 往下扫（逆流慢）
    const j = 21;
    A.tx[j] = 0; A.ty[j] = 1; A.tz[j] = 0;
    const above: VfxFireSegment = { x: p.x[j], y: p.y[j] + 6, z: p.z[j], ax: 0, ay: 1, az: 0, len: 10, r: 3 };
    for (let s = 0; s < 20 && burn.burnT[j] < 0; s++) sim.step(1 / 60, ctx([above]));
    expect(burn.burnT[j]).toBeGreaterThanOrEqual(0);
    expect(plateBurnDir(burn, j)).toBe(-1);
    expect(burn.dur[j]).toBeCloseTo(16 / 0.88 / 2, 3);
  });

  it('绑的模板没装 / 是消耗燃烧：不可燃', () => {
    const none = new VfxInstanceSim('i', paperEffect(), [0, 0, 0], 7, space);
    expect(none.emitters[0].burn).toBeNull();
    const consume = new VfxInstanceSim('i', paperEffect(), [0, 0, 0], 7, space, 1,
      { burnTemplates: new Map([['paper_t', paperTemplate({ mode: 'consume' })]]) });
    expect(consume.emitters[0].burn).toBeNull();
  });

  it('不可燃的纸杵着火也不着（不写 burnable 一字不变）', () => {
    const sim = new VfxInstanceSim('i', paperEffect(false), [0, 0, 0], 7, space, 1, opts);
    sim.step(1 / 60, ctx());
    const p = sim.emitters[0].p;
    const fire: VfxFireSegment = { x: p.x[3], y: 0, z: p.z[3], ax: 0, ay: 1, az: 0, len: 10, r: 4 };
    for (let s = 0; s < 300; s++) sim.step(1 / 60, ctx([fire]));
    expect(p.liveCount).toBe(60);
    expect(sim.emitters[0].burn).toBeNull();
  });

  it('恢复烧没了的槽位：那几张不出现，其余纸的铺撒位置逐位不变', () => {
    const a = new VfxInstanceSim('i', paperEffect(), [0, 0, 0], 11, space, 1, opts);
    a.step(1 / 60, ctx());
    const b = new VfxInstanceSim('i', paperEffect(), [0, 0, 0], 11, space, 1, opts);
    b.applyBurntSlots(0, [2, 9]);
    b.step(1 / 60, ctx());
    const pa = positions(a);
    const pb = positions(b);
    for (let i = 0; i < pa.length; i++) {
      if (i === 2 || i === 9) expect(pb[i]).toBe(`${i}:-`);
      else expect(pb[i]).toBe(pa[i]);
    }
    expect(b.emitters[0].p.liveCount).toBe(58);
  });

  it('燃着的纸被报出来（位置 + 半尺寸）并作为火焰段', () => {
    const sim = new VfxInstanceSim('i', paperEffect(), [0, 0, 0], 3, space, 1, opts);
    sim.step(1 / 60, ctx());
    const p = sim.emitters[0].p;
    const fire: VfxFireSegment = { x: p.x[0], y: -2, z: p.z[0], ax: 0, ay: 1, az: 0, len: 10, r: 2 };
    for (let s = 0; s < 30; s++) sim.step(1 / 60, ctx([fire]));
    const groups = sim.burningPlates([]);
    expect(groups.length).toBe(1);
    expect(groups[0].count).toBeGreaterThanOrEqual(1);
    const segs: VfxFireSegment[] = [];
    sim.plateFireSegments(segs);
    expect(segs.length).toBe(groups[0].count);
    expect(sim.burningSlots()[0].slots).toContain(0);
  });
});

describe('外部供点发射形状', () => {
  const eff: VfxEffectDef = {
    id: 'flame',
    emitters: [{
      id: 'f',
      appearance: { sizeWu: 4 },
      spawn: { max: 200, rate: 600, shape: { kind: 'external', jitter: 0 } },
      life: { seconds: [5, 5] },
    }],
  } as VfxEffectDef;

  it('没有点不发；给了点就只在那些点上出生（jitter 0 = 正好在点上）', () => {
    const sim = new VfxInstanceSim('x', eff, [0, 0, 0], 1, space);
    sim.step(0.1, ctx());
    expect(sim.liveCount).toBe(0);
    const pts = new Float32Array([100, 10, -50, 3, -40, 20, 70, 3]);
    sim.setSpawnPoints(pts, 2);
    sim.step(0.1, ctx());
    const p = sim.emitters[0].p;
    expect(p.liveCount).toBeGreaterThan(0);
    for (let i = 0; i < p.cap; i++) {
      if (!p.alive[i]) continue;
      const onA = Math.abs(p.x[i] - 100) < 1e-3 && Math.abs(p.y[i] - 10) < 1e-3;
      const onB = Math.abs(p.x[i] + 40) < 1e-3 && Math.abs(p.y[i] - 20) < 1e-3;
      expect(onA || onB).toBe(true);
    }
  });
});
