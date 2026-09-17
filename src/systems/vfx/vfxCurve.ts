/**
 * 粒子 / 光柱共用的关键点曲线采样（纯函数，零 Pixi——粒子工作台打包进页面也用它）。
 * 口径：超出两端取端点；空 / 不写 = 恒 1（颜色 = 恒白）；相邻关键点之间线性插值。
 */
import type { VfxColorCurve, VfxCurve } from '../../data/types';

export function sampleCurve(c: VfxCurve | undefined, t: number): number {
  if (!c || c.length === 0) return 1;
  if (t <= c[0][0]) return c[0][1];
  for (let i = 1; i < c.length; i++) {
    if (t <= c[i][0]) {
      const [t0, v0] = c[i - 1];
      const [t1, v1] = c[i];
      const k = t1 > t0 ? (t - t0) / (t1 - t0) : 1;
      return v0 + (v1 - v0) * k;
    }
  }
  return c[c.length - 1][1];
}

/**
 * 颜色曲线采样（`tintOverLife`），逐通道与 {@link sampleCurve} 同一口径：超出两端取端点、空 / 不写 = 恒白。
 * 结果写进 `out`（每粒子每帧调，不分配）。
 */
export function sampleColorCurve(c: VfxColorCurve | undefined, t: number, out: [number, number, number]): [number, number, number] {
  if (!c || c.length === 0) { out[0] = 1; out[1] = 1; out[2] = 1; return out; }
  if (t <= c[0][0]) { out[0] = c[0][1]; out[1] = c[0][2]; out[2] = c[0][3]; return out; }
  for (let i = 1; i < c.length; i++) {
    if (t <= c[i][0]) {
      const a = c[i - 1];
      const b = c[i];
      const k = b[0] > a[0] ? (t - a[0]) / (b[0] - a[0]) : 1;
      out[0] = a[1] + (b[1] - a[1]) * k;
      out[1] = a[2] + (b[2] - a[2]) * k;
      out[2] = a[3] + (b[3] - a[3]) * k;
      return out;
    }
  }
  const z = c[c.length - 1];
  out[0] = z[1]; out[1] = z[2]; out[2] = z[3];
  return out;
}
