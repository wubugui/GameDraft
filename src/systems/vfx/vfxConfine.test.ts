/**
 * 粒子区域（`VfxInstanceDef.confine`）的行为契约：权重网格的几何、纸钱在强风里被限定在框里
 * （软边界：边带里风弱下去、躺着的慢慢淡出、补回从深处淡入）、普通粒子出框淡出、高度上限、
 * 不限定的实例一字不变。空间是合成的平地（无壳），风照抄跑马梁那份。
 */
import { describe, expect, it } from 'vitest';
import type { VfxEffectDef } from '../../data/types';
import type { Vec3 } from '../../utils/sceneSpace';
import { resolveSceneWind } from '../../utils/sceneWind';
import {
  buildConfineField, CONFINE_FEATHER_DEFAULT, confineContour, confineDistanceContour, confineHeightWeight,
  confineWeightAt, distanceToPolygonEdge, exactConfineWeight,
} from './vfxConfine';
import { VfxInstanceSim, type VfxStepContext } from './vfxSim';
import type { VfxSpace } from './vfxSpace';

class FlatSpace implements VfxSpace {
  readonly kind = 'field' as const;
  readonly hasShell = false;
  readonly wuPerQ = 1;
  readonly viewDir: Vec3 = [0, 0, 1];
  groundY(): number { return 0; }
  groundObserved(): boolean { return true; }
  shellContact(): null { return null; }
  shellDepthWu(): number | null { return null; }
  toScene(w: Vec3, out: { x: number; y: number }): void { out.x = w[0]; out.y = -w[2] - w[1]; }
  toQ(w: Vec3, out: Vec3): void { out[0] = w[0]; out[1] = w[1]; out[2] = w[2]; }
  anchorToWorld(a: { x: number; y: number; h?: number }): Vec3 { return [a.x, a.h ?? 0, -a.y]; }
  groundWorldAtScene(x: number, y: number): Vec3 { return [x, 0, -y]; }
  groundNormal(_x: number, _z: number, out: Vec3): Vec3 { out[0] = 0; out[1] = 1; out[2] = 0; return out; }
  metricAt(): number { return 1; }
  surfaceAtScene(x: number, y: number): { p: Vec3; normal: Vec3; kind: 'ground' } {
    return { p: [x, 0, -y], normal: [0, 1, 0], kind: 'ground' };
  }
}

const SQUARE: [number, number][] = [[0, 0], [1000, 0], [1000, 1000], [0, 1000]];

describe('vfxConfine · 权重网格', () => {
  it('没有区域 / 不足三个点 / 没配 confine ⇒ 不限定', () => {
    expect(buildConfineField(null, { feather: 100 })).toBeNull();
    expect(buildConfineField([[0, 0], [1, 1]], { feather: 100 })).toBeNull();
    expect(buildConfineField(SQUARE, null)).toBeNull();
  });

  it('范围区域优先用 confine.area，没写才用发射区域', () => {
    const own: [number, number][] = [[0, 0], [50, 0], [50, 50]];
    expect(buildConfineField(SQUARE, { area: own })!.poly).toEqual(own);
    expect(buildConfineField(SQUARE, {})!.poly).toEqual(SQUARE);
    expect(buildConfineField(null, { area: own })!.poly).toEqual(own);
    expect(buildConfineField(SQUARE, { area: [[0, 0]] as [number, number][] })!.poly).toEqual(SQUARE);
  });

  it('框内深处 1、框线上 0、框外 0，边带里是 smoothstep', () => {
    const f = buildConfineField(SQUARE, { feather: 100 })!;
    expect(confineWeightAt(f, 500, 500)).toBeCloseTo(1, 6);
    expect(confineWeightAt(f, 0, 500)).toBeCloseTo(0, 6);
    expect(confineWeightAt(f, -300, 500)).toBe(0);
    expect(confineWeightAt(f, 5000, 5000)).toBe(0);
    expect(exactConfineWeight(SQUARE, 100, 50, 500)).toBeCloseTo(0.5, 6);
    expect(f.feather).toBe(100);
  });

  it('缺省边带宽', () => {
    expect(buildConfineField(SQUARE, {})!.feather).toBe(CONFINE_FEATHER_DEFAULT);
  });

  it('网格插值与解析值一致，且从框外往里单调不减（没有台阶线）', () => {
    const f = buildConfineField(SQUARE, { feather: 120 })!;
    // 线性插值误差上界 = 格宽² / 8 × max|f''|，smoothstep 的 max|f''| = 6 / feather²
    const bound = (f.cell * f.cell / 8) * (6 / (f.feather * f.feather)) + 1e-6;
    let prev = -1;
    for (let x = -40; x <= 500; x += 3) {
      const w = confineWeightAt(f, x, 431);
      expect(w).toBeGreaterThanOrEqual(prev - 1e-6);
      prev = w;
      expect(Math.abs(w - exactConfineWeight(SQUARE, 120, x, 431))).toBeLessThanOrEqual(bound);
    }
  });

  it('凹多边形：凹口里是框外', () => {
    const U: [number, number][] = [[0, 0], [300, 0], [300, 300], [200, 300], [200, 100], [100, 100], [100, 300], [0, 300]];
    const f = buildConfineField(U, { feather: 20 })!;
    expect(confineWeightAt(f, 150, 250)).toBe(0);
    expect(confineWeightAt(f, 50, 200)).toBeGreaterThan(0.9);
  });

  it('巨大多边形的网格单边不超过 256 格', () => {
    const f = buildConfineField([[0, 0], [1e6, 0], [1e6, 1e6], [0, 1e6]], { feather: 10 })!;
    expect(f.gw).toBeLessThanOrEqual(256);
    expect(f.gh).toBeLessThanOrEqual(256);
  });

  it('权重等值线：smoothstep 0.5 在边带正中', () => {
    const f = buildConfineField(SQUARE, { feather: 100 })!;
    const segs = confineContour(f, 0.5);
    expect(segs.length).toBeGreaterThan(0);
    for (let k = 0; k < segs.length; k += 2) {
      const d = Math.min(segs[k], 1000 - segs[k], segs[k + 1], 1000 - segs[k + 1]);
      expect(Math.abs(d - 50)).toBeLessThan(f.cell);
    }
    expect(confineContour(f, 2)).toEqual([]);
  });

  it('距离等值线：边带内沿那一圈贴着"框线往里一个边带宽"，凹多边形也不起毛', () => {
    const L: [number, number][] = [[0, 0], [1000, 0], [1000, 400], [400, 400], [400, 1000], [0, 1000]];
    const f = buildConfineField(L, { feather: 120 })!;
    const segs = confineDistanceContour(f, 120);
    expect(segs.length).toBeGreaterThan(0);
    for (let k = 0; k < segs.length; k += 2) {
      const x = segs[k], y = segs[k + 1];
      // 线性场的双线性插值：误差远小于一格（权重场在内沿处能差出好几格，见 confineContour 的注释）
      expect(Math.abs(distanceToPolygonEdge(L, x, y) - 120)).toBeLessThan(f.cell * 0.2);
    }
  });

  it('高度上限：上限以下一段过渡带从 1 降到 0；不限高恒 1', () => {
    const f = buildConfineField(SQUARE, { feather: 120, ceiling: 400 })!;
    expect(f.ceilingBand).toBe(120);
    expect(confineHeightWeight(f, 200)).toBe(1);
    expect(confineHeightWeight(f, 340)).toBeCloseTo(0.5, 6);
    expect(confineHeightWeight(f, 400)).toBe(0);
    expect(confineHeightWeight(buildConfineField(SQUARE, { feather: 120 })!, 1e5)).toBe(1);
  });
});

// ------------------------------------------------------------------ 模拟

/** 跑马梁的风（往 −x 吹、强阵风） */
const WIND = resolveSceneWind({
  direction: [-1, 0, -0.25], speed: 400, gust: { amount: 0.8, period: 7 }, veer: 14,
  turbulence: { intensity: 0.35, scale: 140 },
})!;

/** 跑马梁那份纸钱（去掉贴图） */
const PAPER: VfxEffectDef = {
  id: 'paper_money',
  emitters: [{
    id: 'paper',
    appearance: { image: 'x', sizeWu: 16, sizeJitter: [0.75, 1.15] },
    spawn: { max: 400, burst: 400, shape: { kind: 'area', radius: 260 } },
    plate: {
      size: [16, 16], terminalSpeed: 90, edgeDrag: 0.08, pressureOffset: 0.12,
      friction: { static: 0.45, kinetic: 0.35 }, adhere: { pinned: 0.15, onObjects: 1, hold: 120 },
      bend: { stiffness: 1400, freq: 7, damping: 0.25, max: 0.7, rest: 0.35 }, segments: 2, replenish: true,
    },
  }],
};

const AREA: [number, number][] = [[200, 200], [1200, 200], [1200, 900], [200, 900]];
const FEATHER = 120;

function ctxOf(sim: VfxInstanceSim): VfxStepContext {
  return { fields: [], player: null, time: sim.time, wind: WIND, windTime: sim.time };
}

/** 画面点离矩形框外沿多远（框内 0） */
function outside(sx: number, sy: number): number {
  return Math.max(200 - sx, sx - 1200, 200 - sy, sy - 900, 0);
}
/** 离框线往里多远（框外 ≤ 0） */
function inside(sx: number, sy: number): number {
  return Math.min(sx - 200, 1200 - sx, sy - 200, 900 - sy);
}

interface RunStats {
  meanVisibleOutside: number;
  maxVisibleOutsideDist: number;
  minLive: number;
  /** 淡完了、还在等补回（隐身）的平均只数 */
  meanPending: number;
  /** 各带的淡入淡出加权只数 / 面积：[0,40) [40,80) [80,120) [120,∞) */
  density: number[];
  exitStartsPerS: number;
  fadeAlwaysOne: boolean;
  visibleAirborneHeights: number[];
}

function runPaper(confine: { feather?: number; ceiling?: number } | null, seconds = 60, seed = 5): RunStats {
  const sim = new VfxInstanceSim('p', PAPER, [700, 0, -550], seed, new FlatSpace(), 1, { area: AREA, confine });
  const p = sim.emitters[0].p;
  const prevRate = new Float32Array(p.cap);
  const warm = 64 * 10;
  let samples = 0, visOut = 0, maxOut = 0, minLive = Infinity, exits = 0, fadeOne = true, pending = 0;
  const mass = [0, 0, 0, 0];
  const heights: number[] = [];
  for (let k = 0; k < 64 * seconds; k++) {
    sim.step(1 / 64, ctxOf(sim));
    for (let i = 0; i < p.cap; i++) {
      if (p.fade[i] !== 1) fadeOne = false;
      if (k >= warm && prevRate[i] <= 0 && p.fadeRate[i] > 1 / 0.5) exits++;
    }
    prevRate.set(p.fadeRate);
    if (k < warm || k % 8) continue;
    samples++;
    minLive = Math.min(minLive, p.liveCount);
    for (let i = 0; i < p.cap; i++) {
      if (!p.alive[i]) continue;
      if (p.fade[i] === 0 && p.fadeRate[i] > 0) pending++;
      const sx = p.x[i], sy = -p.z[i];
      const d = outside(sx, sy);
      if (d > 0 && p.fade[i] > 0.05) { visOut++; maxOut = Math.max(maxOut, d); }
      const din = inside(sx, sy);
      if (din > 0) mass[din < 40 ? 0 : din < 80 ? 1 : din < 120 ? 2 : 3] += p.fade[i];
      if (p.y[i] > 5 && p.fade[i] > 0.05) heights.push(p.y[i]);
    }
  }
  // 各带面积（1000 × 700 的框逐圈往里缩）
  const rect = (m: number) => Math.max(0, 1000 - 2 * m) * Math.max(0, 700 - 2 * m);
  const areas = [rect(0) - rect(40), rect(40) - rect(80), rect(80) - rect(120), rect(120)];
  return {
    meanVisibleOutside: visOut / samples,
    maxVisibleOutsideDist: maxOut,
    minLive,
    meanPending: pending / samples,
    density: mass.map((m, j) => m / samples / areas[j]),
    exitStartsPerS: exits / (seconds - 10),
    fadeAlwaysOne: fadeOne,
    visibleAirborneHeights: heights.sort((a, b) => a - b),
  };
}

describe('vfxConfine · 纸钱在强风里被限定在框里', () => {
  const free = runPaper(null);
  const held = runPaper({ feather: FEATHER });

  it('对照组：不限定时纸钱确实被吹出框很远（场景本身会把纸推出去，下面的断言才有意义）', () => {
    expect(free.meanVisibleOutside).toBeGreaterThan(PAPER.emitters[0].spawn.max * 0.05);
    expect(free.maxVisibleOutsideDist).toBeGreaterThan(FEATHER * 2);
  });

  it('限定后：框外看得见的纸几乎没有，且都压在框线边上（淡出期间走不出半个边带）', () => {
    expect(held.meanVisibleOutside).toBeLessThan(PAPER.emitters[0].spawn.max * 0.01);
    expect(held.maxVisibleOutsideDist).toBeLessThan(FEATHER / 2);
  });

  it('总数不漏：回收的纸都补回来了，隐身等补回的几乎没有', () => {
    expect(held.minLive).toBe(PAPER.emitters[0].spawn.max);
    expect(held.meanPending).toBeLessThan(PAPER.emitters[0].spawn.max * 0.01);
  });

  it('边带里越往外越稀，没有沿框线堆成一条', () => {
    const [b0, b1, b2, deep] = held.density;
    expect(b0).toBeLessThan(deep);
    expect(b1).toBeLessThan(deep);
    expect(b2).toBeLessThan(deep);
    expect(b0).toBeLessThan(b2);
  });

  it('补回的纸飞不过边带：半空里出框淡出的纸每秒不到一张（从高处补回时实测 9.4 张 / 秒）', () => {
    expect(held.exitStartsPerS).toBeLessThan(1);
  });

  it('不限定的实例一字不变：淡入淡出系数恒 1', () => {
    expect(free.fadeAlwaysOne).toBe(true);
    expect(held.fadeAlwaysOne).toBe(false);
  });

  it('确定性：同种子同一串 dt ⇒ 逐位相同', () => {
    const a = new VfxInstanceSim('p', PAPER, [700, 0, -550], 9, new FlatSpace(), 1, { area: AREA, confine: { feather: FEATHER } });
    const b = new VfxInstanceSim('p', PAPER, [700, 0, -550], 9, new FlatSpace(), 1, { area: AREA, confine: { feather: FEATHER } });
    for (let k = 0; k < 64 * 8; k++) { a.step(1 / 64, ctxOf(a)); b.step(1 / 64, ctxOf(b)); }
    const pa = a.emitters[0].p, pb = b.emitters[0].p;
    expect(Array.from(pa.x)).toEqual(Array.from(pb.x));
    expect(Array.from(pa.fade)).toEqual(Array.from(pb.fade));
  });

  it('高度上限：看得见的纸 99% 都在上限以下', () => {
    const CEIL = 100;
    const capped = runPaper({ feather: FEATHER, ceiling: CEIL }, 40);
    const h = capped.visibleAirborneHeights;
    expect(h.length).toBeGreaterThan(0);
    expect(h[Math.floor(h.length * 0.99)]).toBeLessThanOrEqual(CEIL);
  });
});

describe('vfxConfine · 发射区域与范围区域分开配', () => {
  /** 发射区域：框的上风（+x）那一小条；范围区域：整个大框 */
  const EMIT: [number, number][] = [[900, 300], [1150, 300], [1150, 800], [900, 800]];
  const inEmit = (sx: number, sy: number) => sx >= 900 && sx <= 1150 && sy >= 300 && sy <= 800;

  it('出生只在发射区域里；被风带开后能飞满范围区域，但出不了范围区域', () => {
    const sim = new VfxInstanceSim('p', PAPER, [1000, 0, -550], 5, new FlatSpace(), 1,
      { area: EMIT, confine: { area: AREA, feather: FEATHER } });
    const p = sim.emitters[0].p;
    sim.step(1 / 64, ctxOf(sim));
    let born = 0;
    for (let i = 0; i < p.cap; i++) {
      if (!p.alive[i]) continue;
      born++;
      expect(inEmit(p.x[i], -p.z[i])).toBe(true);
    }
    expect(born).toBeGreaterThan(PAPER.emitters[0].spawn.max * 0.9);

    let samples = 0, visible = 0, beyondEmit = 0, visOut = 0, maxOut = 0;
    for (let k = 0; k < 64 * 60; k++) {
      sim.step(1 / 64, ctxOf(sim));
      if (k < 64 * 10 || k % 8) continue;
      samples++;
      for (let i = 0; i < p.cap; i++) {
        if (!p.alive[i] || p.fade[i] <= 0.05) continue;
        visible++;
        const sx = p.x[i], sy = -p.z[i];
        if (!inEmit(sx, sy)) beyondEmit++;
        const d = outside(sx, sy);
        if (d > 0) { visOut++; maxOut = Math.max(maxOut, d); }
      }
    }
    // 范围区域比发射区域大出来的那一片真的有纸（否则"分开配"等于没配）
    expect(beyondEmit / visible).toBeGreaterThan(0.2);
    expect(visOut / samples).toBeLessThan(PAPER.emitters[0].spawn.max * 0.01);
    expect(maxOut).toBeLessThan(FEATHER / 2);
    expect(p.liveCount).toBe(PAPER.emitters[0].spawn.max);
  });

  it('退化：两块完全不相交也不崩、不漏总数（挑不到落点的隐身等着，不回收）', () => {
    const FAR: [number, number][] = [[3000, 3000], [3200, 3000], [3200, 3200], [3000, 3200]];
    const sim = new VfxInstanceSim('p', PAPER, [700, 0, -550], 5, new FlatSpace(), 1,
      { area: AREA, confine: { area: FAR, feather: FEATHER } });
    const p = sim.emitters[0].p;
    for (let k = 0; k < 64 * 10; k++) sim.step(1 / 64, ctxOf(sim));
    // 出生时一张落点都挑不到（发射区域全在范围区域外），所以一张都没有——不是崩了
    expect(p.liveCount).toBe(0);
    // 只擦边重叠一小角：按权重拒绝采样九成以上挑空。旧写法（挑不到就回收）20 s 内总数漏掉一大截
    const ok = new VfxInstanceSim('p', PAPER, [700, 0, -550], 5, new FlatSpace(), 1,
      { area: AREA, confine: { area: [[120, 120], [380, 120], [380, 380], [120, 380]], feather: FEATHER } });
    const q = ok.emitters[0].p;
    ok.step(1 / 64, ctxOf(ok));
    const born = q.liveCount;
    expect(born).toBeGreaterThan(0);
    for (let k = 0; k < 64 * 20; k++) ok.step(1 / 64, ctxOf(ok));
    expect(q.liveCount).toBe(born);
  });
});

describe('vfxConfine · 普通粒子（烟 / 尘）出框淡出', () => {
  const MOTES: VfxEffectDef = {
    id: 'motes',
    emitters: [{
      id: 'motes',
      appearance: { image: 'x', sizeWu: 6 },
      spawn: { max: 200, rate: 40, shape: { kind: 'sphere', radius: 80 } },
      motion: { drag: 2 },
      life: { seconds: [8, 8] },
    }],
  };

  function run(confine: { feather: number } | null) {
    // 发射器贴着下风边：风会把它们一路往框外带
    const sim = new VfxInstanceSim('m', MOTES, [300, 100, -550], 5, new FlatSpace(), 1, { area: AREA, confine });
    const p = sim.emitters[0].p;
    let maxOut = 0;
    for (let k = 0; k < 64 * 30; k++) {
      sim.step(1 / 64, ctxOf(sim));
      if (k < 64 * 5 || k % 8) continue;
      for (let i = 0; i < p.cap; i++) {
        if (!p.alive[i] || p.fade[i] <= 0.05) continue;
        maxOut = Math.max(maxOut, outside(p.x[i], -p.z[i]));
      }
    }
    return maxOut;
  }

  it('不限定时飘出几千 wu；限定后看得见的不出一个边带宽', () => {
    expect(run(null)).toBeGreaterThan(FEATHER * 4);
    expect(run({ feather: FEATHER })).toBeLessThan(FEATHER);
  });
});
