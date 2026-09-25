/**
 * 按 Pixi v8.17 `Color` 的量化方式读颜色(移植自 PixiJS v8.17(MIT):color/Color 的 `_refreshInt` / `alpha` / `toHexa`)。
 *
 * Pixi 的 Color 把 r/g/b/a 存在 Float32Array 里:alpha 带 float32 舍入(0.3 → 0.30000001192…),
 * 整数色由 float32 分量 ×255 **截断**得到。engine2d 的 Color 用 double + Math.round,多数输入(0xRRGGBB、
 * 整数 rgba 字符串)结果相同,但 alpha 与 [0..1] 浮点数组等输入会差 1 个量化级(例:色标 alpha 0.7 → Pixi 0xb2,
 * double 0xb3)。Graphics 的样式解析与渐变色标只经这里取值,保证与 Pixi 逐数一致;Color 若日后改成 float32 存储,
 * 这里的 fround 是幂等的,结果不变。
 */
import type { Color } from '../../color/Color';

/** Pixi `Color.alpha`(float32,夹到 0..1) */
export function pixiAlpha(color: Color): number {
  return clamp01(Math.fround(color.alpha));
}

/** Pixi `Color.toNumber()`:0xRRGGBB,float32 分量 ×255 截断 */
export function pixiColorNumber(color: Color): number {
  const r = clamp01(Math.fround(color.red));
  const g = clamp01(Math.fround(color.green));
  const b = clamp01(Math.fround(color.blue));
  return ((r * 255) << 16) + ((g * 255) << 8) + ((b * 255) | 0);
}

/** Pixi `Color.toHexa()`:'#rrggbbaa'(alpha 四舍五入) */
export function pixiColorHexa(color: Color): string {
  const hexString = pixiColorNumber(color).toString(16);
  const hex = `#${'000000'.substring(0, 6 - hexString.length) + hexString}`;
  const alphaValue = Math.round(pixiAlpha(color) * 255);
  const alphaString = alphaValue.toString(16);
  return hex + '00'.substring(0, 2 - alphaString.length) + alphaString;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
