/**
 * 现画的雷（形状）：确定性、往上续算与一次算完逐点相同、分叉不钻到地下、同一个效果种子在不同落点劈出不同的雷、
 * 灯沿雷身摆的折线（主干从地面接到灯高、份额加起来是 1）。
 */
import { describe, expect, it } from 'vitest';
import type { VfxBoltDef } from '../../data/types';
import { boltInstanceSeed, boltLightPolylines, createBolt, extendBolt, type BoltGeometry } from './vfxBolt';

const SKY: VfxBoltDef = {
  id: 'sky', kind: 'sky', seed: 7,
  sky: {
    tiltDeg: [0, 10], bendDeg: 10, bendLenWu: 700, stepWu: [160, 320], kinkDeg: [4, 12], zigzag: 0.6, roughness: 0.3, detailWu: 3,
    branchPerKWu: 28, branchFromWu: 150, branchMinWu: 15, branchMaxWu: 1600, branchAngleDeg: [25, 70], branchIntensity: [0.3, 0.65],
    branchWidth: 0.4, forkPerKWu: 10, forkDepth: 2, lowBoostGain: 1.15, lowBoostWu: 150, cloudWu: 30000,
  },
};
const SURF: VfxBoltDef = {
  id: 'ground', kind: 'surface', seed: 8,
  surface: { count: [14, 22], lenWu: [12, 85], kinkDeg: [10, 35], roughness: 0.25, detailWu: 2, forkPerKWu: 20, intensity: [0.3, 0.8] },
};

/** 主干的点到 `h` 高为止（续算的每一截首尾相接：接缝处前一截的末点 = 后一截的起点，只记一次） */
function trunk(g: BoltGeometry, h: number): string[] {
  const out: string[] = [];
  for (const L of g.lines) {
    if (L.depth !== 0) continue;
    for (let i = L.start; i < L.start + L.count; i++) {
      if (g.y[i] > h) return out;
      const k = `${g.x[i].toFixed(6)},${g.y[i].toFixed(6)},${g.level[i]}`;
      if (out[out.length - 1] !== k) out.push(k);
    }
  }
  return out;
}
/** 分叉（depth ≥ 1 的线）的起点与长度：比较两份几何长出的是不是同一批分叉 */
function branches(g: BoltGeometry, h: number): string[] {
  return g.lines.filter((L) => L.depth >= 1 && g.y[L.start] <= h)
    .map((L) => `${L.depth}:${g.x[L.start].toFixed(6)},${g.y[L.start].toFixed(6)}:${L.len.toFixed(6)}`).sort();
}

describe('现画的雷 · 形状', () => {
  it('同一个定义 + 同一个实例种子 = 同一道雷；换种子就换一道', () => {
    const a = createBolt(SKY, 11), b = createBolt(SKY, 11), c = createBolt(SKY, 12);
    extendBolt(a, 2000); extendBolt(b, 2000); extendBolt(c, 2000);
    expect(trunk(a, 2000)).toEqual(trunk(b, 2000));
    expect(a.x.length).toBe(b.x.length);
    expect(trunk(a, 2000)).not.toEqual(trunk(c, 2000));
  });

  it('往上分几次续算 == 一次算到那么高：主干逐点相同、长出同一批分叉（画雷那份与摆灯那份是同一道雷）', () => {
    const once = createBolt(SKY, 5);
    extendBolt(once, 3000);
    const steps = createBolt(SKY, 5);
    for (const h of [200, 700, 1500, 3000]) extendBolt(steps, h);
    expect(trunk(steps, 2500)).toEqual(trunk(once, 2500));
    expect(branches(steps, 2500)).toEqual(branches(once, 2500));
    expect(branches(once, 2500).length).toBeGreaterThan(3);
    expect(steps.builtTo).toBeGreaterThanOrEqual(3000);
  });

  it('主干从落点（原点）起；分叉往下往外长，但不钻到地面以下', () => {
    const g = createBolt(SKY, 3);
    extendBolt(g, 4000);
    const L0 = g.lines.find((L) => L.depth === 0)!;
    expect(g.x[L0.start]).toBeCloseTo(0, 6);
    expect(g.y[L0.start]).toBeCloseTo(0, 6);
    expect(g.lines.some((L) => L.depth >= 1)).toBe(true);
    for (let i = 0; i < g.y.length; i++) expect(g.y[i]).toBeGreaterThanOrEqual(-1e-6);
  });

  it('同一个效果种子（雷符写死 0）在不同落点劈出不同的雷：实例种子混入落点', () => {
    const s1 = boltInstanceSeed(0, [100, 0, 200]);
    const s2 = boltInstanceSeed(0, [140, 0, 200]);
    expect(s1).not.toBe(s2);
    expect(boltInstanceSeed(0, [100, 0, 200])).toBe(s1);
    const g1 = createBolt(SKY, s1), g2 = createBolt(SKY, s2);
    extendBolt(g1, 800); extendBolt(g2, 800);
    expect(trunk(g1, 800)).not.toEqual(trunk(g2, 800));
  });

  it('贴地电弧一次算完、从落点往外爬', () => {
    const g = createBolt(SURF, 9);
    expect(g.builtTo).toBe(Infinity);
    // 每根电弧从落点起（第一级线），再分叉挂在它们身上
    const roots = g.lines.filter((L) => Math.hypot(g.x[L.start], g.y[L.start]) < 1e-6);
    expect(roots.length).toBeGreaterThanOrEqual(14);
    expect(roots.length).toBeLessThanOrEqual(22);
    expect(roots.every((L) => L.depth === 1)).toBe(true);
  });
});

describe('现画的雷 · 灯沿雷身摆', () => {
  it('主干折线从地面接到灯高、首尾相接、份额和为 1；最长的几根分叉另外挂灯', () => {
    const g = createBolt(SKY, 21);
    const segs = boltLightPolylines(g, 2400, 8, 2);
    const main = segs.slice(0, segs.length - 2);
    expect(main.length).toBeGreaterThanOrEqual(1);
    expect(main.length).toBeLessThanOrEqual(8);
    expect(main[0].y0).toBeCloseTo(0, 6);
    expect(main[main.length - 1].y1).toBeCloseTo(2400, 4);
    for (let i = 1; i < main.length; i++) {
      expect(main[i].x0).toBeCloseTo(main[i - 1].x1, 9);
      expect(main[i].y0).toBeCloseTo(main[i - 1].y1, 9);
    }
    expect(main.reduce((a, s) => a + s.share, 0)).toBeCloseTo(1, 9);
    expect(segs.length).toBe(main.length + 2);
  });

  it('贴地电弧 / 灯高 0：不摆线光', () => {
    expect(boltLightPolylines(createBolt(SURF, 1), 2400, 8, 2)).toEqual([]);
    expect(boltLightPolylines(createBolt(SKY, 1), 0, 8, 2)).toEqual([]);
  });
});
