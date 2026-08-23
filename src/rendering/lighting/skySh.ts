import type { SkyLightDef } from '../../data/types';

import { resolveLightColor } from './kelvin';

/**
 * 天空 → **辐照度 SH-L2**（9 个系数，打成 `vec4[9]` 喂 `uSkySh`）。
 *
 * ## 为什么天空不再逐像素预投影
 *
 * 上一版把天空烤进载荷：每像素存 4 个纬向通道（y⁰/y¹/y²/y⁴）的传输，运行时按
 * `profile` 在阶梯上插值。三个毛病：
 *
 * 1. **4 倍存储**，而且角色网格要为同一件事再存 4 个 SH-L1 通道（16 字节/格点）；
 * 2. 场景（精确求积）与角色（SH-L1）落在**两个不同的参数化**上 —— 实测角色典型
 *    法线处差 10%–15%、竖直面差一倍。同一个量存两份，必然分家；
 * 3. 天空只能是那 4 个纬向剖面的线性组合，**方位向变化表达不了**（日头那侧更亮）。
 *
 * 现在按 UE `SkyLighting.usf` 那套分开：**遮蔽**逐点存（bent 方向 + 可见度），
 * **天空**是一份全局 SH，运行时才相乘。换天空不用重烘。
 *
 * ## 标定
 *
 * 归一到「**无遮挡朝上面 = intensity · color**」——与旧的「无遮挡水平面 = 1」
 * 逐字同一个约定，所以作者面的 `sky.intensity` 语义一个字没变，场景 JSON 不用动。
 *
 * ## profile
 *
 * 天空辐亮度 `L(ω) ∝ (ω·up)₊^profile`，`profile` 现在是**连续**的 0..4
 * （旧的是 4 档 y⁰/y¹/y²/y⁴ 之间线性插值传输，等价但更糙）。
 * 0 = 均匀阴天，1 = 余弦天穹，2/4 越来越集中于天顶。
 *
 * ⚠ L2 截断对**很窄的瓣**表达不全 —— `profile = 4` 时无遮挡传输与解析真值的
 *   最大偏差实测 0.028（见 `skySh.test.ts` 钉住的表）。profile ≤ 2 时 ≤0.011。
 *   这不是可以调好的参数，是 L2 的能力上限；要更准只能升到 L3。
 */

/** 卷积系数 Â_l（Ramamoorthi & Hanrahan）。并进系数里 ⇒ 着色器只做朴素 SH 求值。 */
const A_HAT = [Math.PI, (2 * Math.PI) / 3, Math.PI / 4] as const;

/** 标准实球谐基，顺序与 `sc3SkyShIrradiance` 逐行对应。 */
export function shBasis(x: number, y: number, z: number): number[] {
  return [
    0.2820948,
    0.4886025 * y,
    0.4886025 * z,
    0.4886025 * x,
    1.0925484 * x * y,
    1.0925484 * y * z,
    0.3153916 * (3 * z * z - 1),
    1.0925484 * x * z,
    0.5462742 * (x * x - y * y),
  ];
}

const L_OF_INDEX = [0, 1, 1, 1, 2, 2, 2, 2, 2] as const;

/** 求积密度。只在光照参数变脏时跑一次，不进每帧路径。 */
const N_ELEV = 128;      // 全球面（下半球要装地面反弹），密度与旧的上半球 64 一致
const N_AZIM = 128;

/**
 * 把任意球面剖面 `L(ω)` 投影成 9 个**辐照度** SH 系数（Â_l 已乘进去）。
 *
 * ⚠ 积的是**整个球面**。旧版只积上半球，因为那时天空只有上半球；
 * 现在下半球装地面反弹，而 `groundGain = 0` 时下半球恒为 0 ⇒ 结果与旧版逐位相同。
 */
function projectSh(radiance: (x: number, y: number, z: number) => number): number[] {
  const c = new Array<number>(9).fill(0);
  // dΩ = dφ·dμ。在 μ = ω·up 上均匀取样即吸收了立体角权重。
  for (let i = 0; i < N_ELEV; i += 1) {
    const mu = -1 + (2 * (i + 0.5)) / N_ELEV;
    const horiz = Math.sqrt(Math.max(1 - mu * mu, 0));
    for (let j = 0; j < N_AZIM; j += 1) {
      const a = (2 * Math.PI * (j + 0.5)) / N_AZIM;
      const x = horiz * Math.sin(a);
      const z = horiz * Math.cos(a);
      const rad = radiance(x, mu, z);
      if (rad === 0) continue;
      const b = shBasis(x, mu, z);
      for (let k = 0; k < 9; k += 1) c[k] += rad * b[k];
    }
  }
  const dOmega = (2 / N_ELEV) * ((2 * Math.PI) / N_AZIM);
  for (let k = 0; k < 9; k += 1) c[k] *= dOmega * A_HAT[L_OF_INDEX[k]];
  return c;
}

/**
 * 天顶剖面 `L(ω) = (ω·up)₊^profile`，归一到 `E(up) = 1`。
 *
 * 这一支是**所有其余分量的标定基准**：地平圈 / 日侧辉光 / 地面反弹的 gain
 * 都以它为 1 来度量，所以三个 gain 全为 0 时结果与旧版逐位相同、作者面语义不变。
 */
const shapeCache = new Map<number, number[]>();

function normalizedShape(profile: number): number[] {
  const key = Math.round(profile * 1000) / 1000;
  const hit = shapeCache.get(key);
  if (hit) return hit;
  const c = projectSh((_x, y) => (y > 0 ? y ** key : 0));
  const up = shBasis(0, 1, 0);
  let eUp = 0;
  for (let k = 0; k < 9; k += 1) eUp += c[k] * up[k];
  const inv = eUp > 1e-9 ? 1 / eUp : 0;
  const out = c.map((v) => v * inv);
  shapeCache.set(key, out);
  return out;
}

/** 求值（CPU 侧镜像，`sc3SkyShIrradiance` 的同式）。测试与标定用。 */
export function evalSh(coeffs: number[], x: number, y: number, z: number): number {
  const b = shBasis(x, y, z);
  let e = 0;
  for (let k = 0; k < 9; k += 1) e += coeffs[k] * b[k];
  return Math.max(e, 0);
}

// ---------------------------------------------------------------- 程序性天空
/**
 * ## 为什么不要真大气模型
 *
 * 我们**从来不渲染天空本身** —— 画面被原画铺满，天在画外。天空只以一份
 * SH-L2 存在，而 L2 能被看见的只有三样：
 *
 * | 阶 | 装的是什么 | 画面上表现为 |
 * |---|---|---|
 * | l=0（1 个数） | 天空总亮度 | 整体明暗 |
 * | l=1（3 个数） | 天光的**净方向** | 明暗往哪边偏 —— **时刻感的本体** |
 * | l=2（5 个数） | 一点点形状 | 天顶/地平的软对比 |
 *
 * 黄昏之所以读起来是黄昏，就是 l=1 被拉向西边、拉低到地平线，并且变暖。
 * Hosek-Wilkie 那种模型的价值在于把**天空的样子**算对，而那部分信息在
 * 投影到 L2 的那一步就全丢了。所以这里要的不是物理，是**能直接操纵 l=0/l=1
 * 的、每个旋钮都看得见的剖面**。
 *
 * ## 剖面
 *
 * ```
 * 上半球 μ = ω·up ≥ 0:
 *     L(ω) = 天顶色·μ^profile                          ← 归一到 E(up)=1，旧行为
 *          + 地平色·horizonGain·(1−μ)^horizonSharp     ← 地平线那一圈
 *          + 辉光色·glowGain·max(ω·s, 0)^glowTight     ← 太阳那一侧（s = 太阳方向）
 * 下半球 μ < 0:
 *     L(ω) = 地面色·groundGain                          ← 地面反弹，朝下的面不再死黑
 * ```
 *
 * 四个分量各自带颜色，gain 全部以「天顶剖面 = 1」为标度。
 * **三个 gain 全为 0 时逐位回到旧行为**，28 个场景一个字不用改。
 *
 * ## 每个旋钮管什么（给美术的话术）
 *
 * - `horizonGain / horizonSharp`：地平线那圈有多亮、多窄。抬 gain 会把 l=1 压低
 *   （光更多从侧面来），阴天把 sharp 调小让它糊开。
 * - `glowGain / glowTight`：**黄昏的灵魂**。它把 l=1 拉向太阳方位，
 *   一侧暖亮、一侧冷暗 —— 这是除太阳本身之外最主要的时刻线索，
 *   而旧的纯纬向剖面**在数学上做不出来**（绕 up 旋转对称）。
 * - `groundGain`：朝下的面（下巴、屋檐内侧、裙摆）从地面收到多少反弹。
 *   0 = 死黑（旧行为），雪地/沙地要往上给。
 */
export interface ProceduralSkyDef {
  horizonColor?: [number, number, number];
  horizonKelvin?: number;
  /** 地平圈亮度，以天顶剖面为 1。缺省 0 = 旧行为。 */
  horizonGain?: number;
  /** 地平圈的窄度。1 = 从地平到天顶线性衰减；越大越贴着地平线。 */
  horizonSharp?: number;

  glowColor?: [number, number, number];
  glowKelvin?: number;
  /** 日侧辉光亮度，以天顶剖面为 1。缺省 0。 */
  glowGain?: number;
  /** 辉光的集中度。1 = 半个天空；8 = 只有太阳附近一小片。 */
  glowTight?: number;

  groundColor?: [number, number, number];
  groundKelvin?: number;
  /** 下半球（地面反弹）亮度，以天顶剖面为 1。缺省 0 = 朝下的面拿不到天光。 */
  groundGain?: number;
}

type SkyDef = SkyLightDef & Partial<ProceduralSkyDef>;

/** 三个 gain 全 0（或都没填）⇒ 走旧路，逐位不变。 */
function isPlainSky(sky: SkyDef): boolean {
  return !((sky.horizonGain ?? 0) > 0 || (sky.glowGain ?? 0) > 0 || (sky.groundGain ?? 0) > 0);
}

/**
 * 给 `uSkySh` 用的 9×vec4。RGB = 系数，A 补 0（只为对齐，着色器只读 .rgb）。
 *
 * ⚠ 用 vec4 而不是 vec3 数组：std140 里 `vec3[N]` 每个元素仍按 16 字节对齐，
 *   按 12 字节填会整体错位，而且**不报错**——只是天空整个歪掉。
 *
 * `sunDir` 只给日侧辉光用（指向太阳的单位向量，世界系）。不填则辉光整项跳过。
 */
export function skyIrradianceSh(sky: SkyDef, sunDir?: readonly number[]): Float32Array {
  const profile = Math.max(0, Math.min(4, sky.profile ?? 0));
  const shape = normalizedShape(profile);
  const rgb = resolveLightColor(sky.color, sky.kelvin);
  const gain = sky.intensity;
  const out = new Float32Array(9 * 4);

  // 快路：旧行为，逐位与改造前相同
  if (isPlainSky(sky)) {
    for (let k = 0; k < 9; k += 1) {
      out[k * 4 + 0] = shape[k] * rgb[0] * gain;
      out[k * 4 + 1] = shape[k] * rgb[1] * gain;
      out[k * 4 + 2] = shape[k] * rgb[2] * gain;
    }
    return out;
  }

  // 天顶剖面的归一因子 —— 其余分量都以它为标度，`E(up)=1` 的语义因此保住
  const up = shBasis(0, 1, 0);
  let base = 0;
  for (let k = 0; k < 9; k += 1) base += shape[k] * up[k];
  const norm = base > 1e-9 ? 1 / base : 0;

  const add = (coeffs: number[], color: readonly number[], g: number): void => {
    if (g === 0) return;
    for (let k = 0; k < 9; k += 1) {
      const v = coeffs[k] * norm * g * gain;
      out[k * 4 + 0] += v * color[0];
      out[k * 4 + 1] += v * color[1];
      out[k * 4 + 2] += v * color[2];
    }
  };

  // 天顶剖面（已归一，所以这里 g = 1；再乘一次 norm 会重复，故直接铺）
  for (let k = 0; k < 9; k += 1) {
    out[k * 4 + 0] = shape[k] * rgb[0] * gain;
    out[k * 4 + 1] = shape[k] * rgb[1] * gain;
    out[k * 4 + 2] = shape[k] * rgb[2] * gain;
  }

  const hGain = sky.horizonGain ?? 0;
  if (hGain > 0) {
    const sharp = Math.max(0.25, sky.horizonSharp ?? 3);
    add(projectSh((_x, y) => (y > 0 ? (1 - y) ** sharp : 0)),
        resolveLightColor(sky.horizonColor, sky.horizonKelvin), hGain);
  }

  const gGain = sky.glowGain ?? 0;
  if (gGain > 0 && sunDir) {
    const [sx, sy, sz] = [sunDir[0], sunDir[1], sunDir[2]];
    const len = Math.hypot(sx, sy, sz) || 1;
    const ux = sx / len, uy = sy / len, uz = sz / len;
    const tight = Math.max(0.25, sky.glowTight ?? 4);
    add(projectSh((x, y, z) => {
      if (y <= 0) return 0;
      const d = x * ux + y * uy + z * uz;
      return d > 0 ? d ** tight : 0;
    }), resolveLightColor(sky.glowColor, sky.glowKelvin), gGain);
  }

  const grGain = sky.groundGain ?? 0;
  if (grGain > 0) {
    add(projectSh((_x, y) => (y < 0 ? 1 : 0)),
        resolveLightColor(sky.groundColor, sky.groundKelvin), grGain);
  }

  return out;
}
