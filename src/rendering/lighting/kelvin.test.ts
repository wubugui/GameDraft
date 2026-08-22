import { describe, expect, it } from 'vitest';

import golden from './kelvin.golden.json';
import { kelvinToLinearRgb, resolveLightColor } from './kelvin';

/**
 * 跨语言 parity：TS 侧必须逐值复现 Python 侧的 `kelvin_rgb`。
 * 黄金值由 `tools/scene_relight/relight.py` 生成——工具里调好的预设进游戏不许变色。
 */
describe('kelvinToLinearRgb', () => {
  it('逐值复现 Python 侧黄金值', () => {
    for (const c of golden.cases) {
      const got = kelvinToLinearRgb(c.k);
      for (let i = 0; i < 3; i++) {
        expect(got[i], `${c.k}K 通道${i}`).toBeCloseTo(c.rgb[i], 5);
      }
    }
  });

  it('6500K 归一为白', () => {
    const w = kelvinToLinearRgb(6500);
    expect(w[0]).toBeCloseTo(1, 6);
    expect(w[1]).toBeCloseTo(1, 6);
    expect(w[2]).toBeCloseTo(1, 6);
  });

  it('低色温偏暖、高色温偏冷', () => {
    const warm = kelvinToLinearRgb(2500);
    const cool = kelvinToLinearRgb(12000);
    expect(warm[0]).toBeGreaterThan(warm[2]);
    expect(cool[2]).toBeGreaterThan(cool[0]);
  });

  it('钳到拟合式的有效域，不产生 NaN', () => {
    for (const k of [0, 500, 1000, 40000, 99999]) {
      const v = kelvinToLinearRgb(k);
      expect(v.every((x) => Number.isFinite(x) && x >= 0)).toBe(true);
    }
  });
});

describe('resolveLightColor', () => {
  it('显式 color 赢过 kelvin', () => {
    expect(resolveLightColor([0.1, 0.2, 0.3], 2000)).toEqual([0.1, 0.2, 0.3]);
  });

  it('只有 kelvin 时按色温转', () => {
    expect(resolveLightColor(undefined, 6500)).toEqual(kelvinToLinearRgb(6500));
  });

  it('都没有则白', () => {
    expect(resolveLightColor()).toEqual([1, 1, 1]);
  });
});
