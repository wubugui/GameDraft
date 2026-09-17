/**
 * 物理闪烁（火把：明火 / 炭火）的规律钉子。数都是从文献关系推出来的，改常量要改这里的出处说明。
 * 正弦闪烁（灯笼）不在这里测——它的数值由灯笼逐 tick 对照锁死。
 */
import { describe, expect, it } from 'vitest';

import {
  FLAME_LENGTH_WIND_EXPONENT,
  FLAME_PUFF_RISE_FRACTION,
  EMBER_TURB_RMS_WIND,
  FLAME_TURB_RMS_STILL,
  FLAME_TURB_RMS_WIND,
  GUTTER_MIN_DUTY,
  GUTTER_REIGNITE_SECONDS,
  GutterProcess,
  PhysicalFlicker,
  gutterDuty,
  emberWindFactor,
  flameTurbulenceCornerHz,
  flameTurbulenceRms,
  flameBuoyantSpeed,
  flamePuffFrequency,
  flamePuffWave,
  flamePuffWeight,
  flameWindFactor,
  flameOutput,
} from './heldPropSignal';

/** 60 Hz 采样序列的主频（朴素 DFT 扫 0.5..20 Hz，0.05 Hz 步长） */
function dominantHz(x: number[], fs: number): number {
  const mean = x.reduce((a, b) => a + b, 0) / x.length;
  let best = 0, bestP = -1;
  for (let f = 0.5; f <= 20; f += 0.05) {
    let re = 0, im = 0;
    for (let i = 0; i < x.length; i++) {
      const a = (2 * Math.PI * f * i) / fs;
      re += (x[i]! - mean) * Math.cos(a);
      im += (x[i]! - mean) * Math.sin(a);
    }
    const p = re * re + im * im;
    if (p > bestP) { bestP = p; best = f; }
  }
  return best;
}

describe('明火"喘"：f = 1.5/√D，慢长快塌的锯齿', () => {
  it('10 cm 火把头 ≈ 4.74 Hz、4 cm ≈ 7.5 Hz；浮力速度 √(gD)', () => {
    expect(flamePuffFrequency(0.1)).toBeCloseTo(1.5 / Math.sqrt(0.1), 12);
    expect(flamePuffFrequency(0.1)).toBeCloseTo(4.743, 3);
    expect(flamePuffFrequency(0.04)).toBeCloseTo(7.5, 12);
    expect(flameBuoyantSpeed(0.1)).toBeCloseTo(Math.sqrt(9.81 * 0.1), 12);
  });

  it('波形：从 −1 慢慢长到 +1（占周期 0.8），再塌回 −1；一个周期均值 0', () => {
    expect(flamePuffWave(0)).toBe(-1);
    expect(flamePuffWave(FLAME_PUFF_RISE_FRACTION)).toBeCloseTo(1, 12);
    expect(flamePuffWave(0.4)).toBeCloseTo(0, 12);
    expect(flamePuffWave(0.9)).toBeCloseTo(0, 12);
    let s = 0;
    const n = 10000;
    for (let i = 0; i < n; i++) s += flamePuffWave(i / n);
    expect(Math.abs(s / n)).toBeLessThan(1e-3);
  });

  it('无风时实跑：主频就是 1.5/√D；均值 ≈ 1；波动 ≈ 喘（锯齿 ±0.1 的均方根 0.058）与弱湍流 0.1 的合成；种子不同不同步、同种子逐位相同', () => {
    const run = (seed: number) => {
      const f = new PhysicalFlicker('flame', 0.1, 0.1, seed);
      const xs: number[] = [];
      for (let i = 0; i < 60 * 60; i++) xs.push(f.step(1 / 60, 0));
      return xs;
    };
    const a = run(1), b = run(2);
    expect(dominantHz(a, 60)).toBeGreaterThan(4.74 * 0.95);
    expect(dominantHz(a, 60)).toBeLessThan(4.74 * 1.05);
    const mean = a.reduce((x, y) => x + y, 0) / a.length;
    const sd = Math.sqrt(a.reduce((x, y) => x + (y - mean) ** 2, 0) / a.length);
    expect(mean).toBeGreaterThan(0.97);
    expect(mean).toBeLessThan(1.03);
    const expectSd = Math.hypot(0.1 / Math.sqrt(3), FLAME_TURB_RMS_STILL);
    expect(sd).toBeGreaterThan(expectSd * 0.75);
    expect(sd).toBeLessThan(expectSd * 1.25);
    expect(a).not.toEqual(b);
    expect(run(1)).toEqual(a);
  });
});

describe('风：喘被压住、火被吹短变暗；炭火被吹亮', () => {
  it('风速压过浮力速度就喘不起来：u = √(gD) 时剩一半，10 m/s 时剩 1% 左右', () => {
    const ub = flameBuoyantSpeed(0.1);
    expect(flamePuffWeight(0, 0.1)).toBe(1);
    expect(flamePuffWeight(ub, 0.1)).toBeCloseTo(0.5, 12);
    expect(flamePuffWeight(10, 0.1)).toBeLessThan(0.011);
  });

  it('火焰长度 ∝ u^−0.21：无风 = 1；10 m/s ≈ 0.62；风越大越暗、单调', () => {
    expect(FLAME_LENGTH_WIND_EXPONENT).toBe(-0.21);
    expect(flameWindFactor(0, 0.1)).toBe(1);
    const ub = flameBuoyantSpeed(0.1);
    expect(flameWindFactor(10, 0.1)).toBeCloseTo(Math.pow(Math.hypot(10, ub) / ub, -0.21), 12);
    expect(flameWindFactor(10, 0.1)).toBeGreaterThan(0.6);
    expect(flameWindFactor(10, 0.1)).toBeLessThan(0.64);
    let prev = 1;
    for (let u = 0.5; u <= 25; u += 0.5) {
      const k = flameWindFactor(u, 0.1);
      expect(k).toBeLessThan(prev);
      prev = k;
    }
  });

  it('炭火：Ranz–Marshall 传质，无风 = 1；风越大越亮', () => {
    expect(emberWindFactor(0, 0.1)).toBe(1);
    expect(emberWindFactor(2, 0.1)).toBeGreaterThan(1);
    expect(emberWindFactor(10, 0.1)).toBeGreaterThan(emberWindFactor(2, 0.1));
  });

  it('湍流：均方根无风 0.1 → 大风 0.25（按 u²/(gD+u²) 过渡）；角频率 max(喘频, 0.2·u/D)', () => {
    expect(flameTurbulenceRms(0, 0.1)).toBe(FLAME_TURB_RMS_STILL);
    expect(flameTurbulenceRms(flameBuoyantSpeed(0.1), 0.1)).toBeCloseTo((FLAME_TURB_RMS_STILL + FLAME_TURB_RMS_WIND) / 2, 12);
    expect(flameTurbulenceRms(30, 0.1)).toBeGreaterThan(FLAME_TURB_RMS_WIND * 0.99);
    expect(flameTurbulenceCornerHz(0, 0.1)).toBeCloseTo(flamePuffFrequency(0.1), 12);
    expect(flameTurbulenceCornerHz(12, 0.1)).toBeCloseTo(24, 12);
  });

  it('大风里实跑：喘被压住但湍流把光打碎——均值跟着风暗、波动 ≈ 0.25 × 均值、快的成分比无风多；护火（气流 ×0.2）亮回来', () => {
    const run = (u: number) => {
      const f = new PhysicalFlicker('flame', 0.1, 0.1, 7);
      return Array.from({ length: 60 * 60 }, () => f.step(1 / 60, u));
    };
    const stats = (xs: number[]) => {
      const m = xs.reduce((s, v) => s + v, 0) / xs.length;
      return { m, cv: Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / xs.length) / m };
    };
    /** 相邻帧差的均方根 / 均值：快的成分越多越大 */
    const jitter = (xs: number[]) => {
      let a = 0;
      for (let i = 1; i < xs.length; i++) a += (xs[i]! - xs[i - 1]!) ** 2;
      const m = xs.reduce((s, v) => s + v, 0) / xs.length;
      return Math.sqrt(a / (xs.length - 1)) / m;
    };
    const windy = run(10), guard = run(2), still = run(0);
    const w = stats(windy), g = stats(guard);
    expect(w.m).toBeGreaterThan(flameWindFactor(10, 0.1) * 0.95);
    expect(w.m).toBeLessThan(flameWindFactor(10, 0.1) * 1.05);
    expect(w.cv).toBeGreaterThan(FLAME_TURB_RMS_WIND * 0.8);
    expect(w.cv).toBeLessThan(FLAME_TURB_RMS_WIND * 1.2);
    expect(g.m).toBeGreaterThan(w.m + 0.15);
    expect(jitter(windy)).toBeGreaterThan(jitter(still) * 1.5);
  });

  it('炭火不喘：无风时每帧一样；有风时均值 ≈ 传质倍率、只有慢而小的明暗（均方根 ≤ 0.1）', () => {
    const calm = new PhysicalFlicker('ember', 0.1, 0.1, 3);
    const xs = Array.from({ length: 120 }, () => calm.step(1 / 60, 0));
    expect(new Set(xs).size).toBe(1);
    expect(xs[0]).toBe(1);
    const windy = new PhysicalFlicker('ember', 0.1, 0.1, 3);
    const ys = Array.from({ length: 60 * 60 }, () => windy.step(1 / 60, 3));
    const m = ys.reduce((s, v) => s + v, 0) / ys.length;
    const cv = Math.sqrt(ys.reduce((s, v) => s + (v - m) ** 2, 0) / ys.length) / m;
    expect(m).toBeGreaterThan(emberWindFactor(3, 0.1) * 0.95);
    expect(m).toBeLessThan(emberWindFactor(3, 0.1) * 1.05);
    expect(cv).toBeLessThan(EMBER_TURB_RMS_WIND * 1.2);
    expect(cv).toBeGreaterThan(0.02);
  });

  it('正弦闪烁（灯笼那条）照旧：纯函数、无状态', () => {
    expect(flameOutput(1.234, 0.1, 0.5, 42)).toBe(flameOutput(1.234, 0.1, 0.5, 42));
  });
});

describe('快被吹灭时的时断时续', () => {
  it('占比：火势 ≥ 0.75 恒燃；以下线性降到 0 时 0.25', () => {
    expect(gutterDuty(1)).toBe(1);
    expect(gutterDuty(0.75)).toBe(1);
    expect(gutterDuty(0)).toBe(GUTTER_MIN_DUTY);
    expect(gutterDuty(0.375)).toBeCloseTo(GUTTER_MIN_DUTY + (1 - GUTTER_MIN_DUTY) * 0.5, 12);
  });

  it('实跑：燃着的时间占比 ≈ 占比；断一次平均 ≈ 重燃时间；占比 1 恒燃；同种子逐位相同', () => {
    const run = (duty: number, seed = 5) => {
      const g = new GutterProcess(seed);
      return Array.from({ length: 60 * 600 }, () => g.step(1 / 60, duty));
    };
    const xs = run(0.5);
    const onFrac = xs.filter(Boolean).length / xs.length;
    expect(onFrac).toBeGreaterThan(0.45);
    expect(onFrac).toBeLessThan(0.55);
    let offRuns = 0, offFrames = 0;
    for (let i = 0; i < xs.length; i++) {
      if (!xs[i]) { offFrames++; if (i === 0 || xs[i - 1]) offRuns++; }
    }
    const meanOff = offFrames / offRuns / 60;
    expect(meanOff).toBeGreaterThan(GUTTER_REIGNITE_SECONDS * 0.8);
    expect(meanOff).toBeLessThan(GUTTER_REIGNITE_SECONDS * 1.4);
    expect(run(1).every(Boolean)).toBe(true);
    expect(run(0.5)).toEqual(xs);
  });
});
