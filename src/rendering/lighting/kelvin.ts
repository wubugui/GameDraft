/**
 * 色温 → 线性 RGB（6500K 归一为白）。
 *
 * 作者面用色温填光的颜色（比填三个 0..1 直观得多），CPU 侧在装载时转成 RGB 传给
 * shader —— 这样 GLSL 里不必带 log/pow 这类 transcendental。
 *
 * ⚠ **本实现是 `tools/scene_relight/relight.py::kelvin_rgb` 的严格镜像。**
 * 两边必须逐值一致，否则工具里调好的预设进游戏就变色。
 * 由 `kelvin.golden.json`（Python 侧生成）在 `kelvin.test.ts` 里锁死。
 *
 * 近似式来自 Tanner Helland 的经典拟合，再除以 6500K 的结果做归一，
 * 最后按 2.2 幂近似线性化。
 */

/** 拟合的原始输出（gamma 域，未归一）。内部用。 */
function rawKelvin(kelvin: number): [number, number, number] {
  const t = Math.min(Math.max(kelvin, 1000), 40000) / 100;
  let r: number;
  let g: number;
  let b: number;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  const clamp01 = (v: number) => Math.min(Math.max(v / 255, 0), 1);
  // 2.2 幂近似线性化（与 Python 侧同式；刻意不用精确 sRGB EOTF，两边必须一致）
  return [Math.pow(clamp01(r), 2.2), Math.pow(clamp01(g), 2.2), Math.pow(clamp01(b), 2.2)];
}

const WHITE = rawKelvin(6500);

/** 色温（K）→ 线性 RGB，6500K = (1,1,1)。 */
export function kelvinToLinearRgb(kelvin: number): [number, number, number] {
  const v = rawKelvin(kelvin);
  return [v[0] / WHITE[0], v[1] / WHITE[1], v[2] / WHITE[2]];
}

/**
 * 解析一个光的颜色：显式 `color` 优先于 `kelvin`，都没有则白。
 * 与 `LightDef` / `SceneLightingDef` 里"两者都写时 color 赢"的约定一致。
 */
export function resolveLightColor(
  color?: readonly [number, number, number],
  kelvin?: number,
): [number, number, number] {
  if (color) return [color[0], color[1], color[2]];
  if (typeof kelvin === 'number') return kelvinToLinearRgb(kelvin);
  return [1, 1, 1];
}
