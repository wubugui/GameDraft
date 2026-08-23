import { describe, expect, it } from 'vitest';

import CORE3 from './shadeCore3.glsl?raw';
import CHAR_SHADER from './UnifiedCharacterShader.ts?raw';
import SCENE_PASS from './SceneLightingPass.ts?raw';
import { evalSh, shBasis, skyIrradianceSh } from './skySh';

/**
 * 天穹遮蔽的**表示契约** —— 场景与角色必须是同一个量、进同一个函数。
 *
 * ## 被否掉的上一版（2026-08-23 上午）
 *
 * 每像素存 4 个纬向通道（y⁰/y¹/y²/y⁴）的传输，角色网格再为同一件事存 4 个
 * SH-L1 通道。**同一个量两种参数化**，于是必然分家 —— 实测无遮挡时：
 *
 * | N·up | y⁰ | y¹ | y² | y⁴ |
 * |---|---|---|---|---|
 * | 0.707（角色典型法线） | ±0.0% | +10.2% | +13.1% | +14.5% |
 * | 0（竖直面） | +1.2% | +36.2% | +61.6% | +101.4% |
 *
 * 而且那个阶梯本身是多余的：它把**天空**烤进了载荷，方位向变化还表达不了。
 *
 * ## 现在（与 UE `SkyLighting.usf` 同一套）
 *
 * - **遮蔽**逐点存：bent 方向 + 余弦加权可见度 `V`。场景侧法线烘焙期已知，
 *   存精确值；角色侧法线运行时才有，存 y⁰ 传输的 SH-L1，当场
 *   `V = (a₀+a₁·N) / cap₀(N)`、`Bdir = normalize(a₁)`。
 * - **天空**是一份全局 SH-L2，逐帧在 CPU 上算（`skySh.ts`），不进载荷。
 * - 合成只有一处：`E = sc3SkyShIrradiance(normalize(mix(Bdir, N, w))) · V`，
 *   `w = 1−(1−V)²`。无遮挡 ⇒ `V=1` ⇒ `w=1` ⇒ `n=N` ⇒ **构造性精确**。
 */

/** 无遮挡时 `L(ω) ∝ (ω·up)₊^p` 的传输真值。数值积分，**独立于被测代码**。 */
function capExact(cosBeta: number, p: number): number {
  const M = 20000;
  const s = Math.sqrt(Math.max(1 - cosBeta * cosBeta, 0));
  let num = 0;
  let den = 0;
  for (let i = 0; i < M; i += 1) {
    const y = (i + 0.5) / M;
    const a = cosBeta * y;
    const b = s * Math.sqrt(Math.max(1 - y * y, 0));
    // ∫₀^2π max(a + b·cosφ, 0) dφ 的闭式
    let I: number;
    if (b < 1e-12) I = a > 0 ? 2 * Math.PI * a : 0;
    else {
      const phi = Math.acos(Math.min(Math.max(-a / b, -1), 1));
      I = 2 * (a * phi + b * Math.sin(phi));
    }
    num += I * y ** p;
    den += 2 * Math.PI * y * y ** p;
  }
  return num / den;
}

const shFor = (profile: number): number[] => {
  const packed = skyIrradianceSh({ intensity: 1, profile } as never);
  return Array.from({ length: 9 }, (_, k) => packed[k * 4]);
};

const at = (coeffs: number[], cosBeta: number): number =>
  evalSh(coeffs, 0, cosBeta, Math.sqrt(Math.max(1 - cosBeta * cosBeta, 0)));

describe('天空 SH-L2 · 与解析真值的差距', () => {
  it('标定：无遮挡朝上面恰好拿到 intensity（作者面语义不变）', () => {
    for (const profile of [0, 1, 2, 4]) {
      expect(at(shFor(profile), 1)).toBeCloseTo(1, 6);
    }
    const packed = skyIrradianceSh({ intensity: 2.5, profile: 1 } as never);
    const coeffs = Array.from({ length: 9 }, (_, k) => packed[k * 4]);
    expect(at(coeffs, 1)).toBeCloseTo(2.5, 5);
  });

  it('profile 0 与 2 是**精确**的（cap₀ 线性、cap₂ 二次，L2 装得下）', () => {
    for (const profile of [0, 2]) {
      const c = shFor(profile);
      for (const cb of [1, 0.85, 0.707, 0.5, 0.25, 0, -0.3, -0.7]) {
        expect(Math.abs(at(c, cb) - capExact(cb, profile))).toBeLessThan(2e-3);
      }
    }
  });

  it('profile 1 / 4 的 L2 截断误差有据可查（≤0.009 / ≤0.017）', () => {
    // 窄瓣 L2 装不全。这不是可以调好的参数，是 L2 的能力上限；要更准只能升 L3。
    const worst: Record<number, number> = { 1: 0, 4: 0 };
    for (const profile of [1, 4]) {
      const c = shFor(profile);
      for (const cb of [1, 0.85, 0.707, 0.5, 0.25, 0, -0.3, -0.7]) {
        worst[profile] = Math.max(worst[profile], Math.abs(at(c, cb) - capExact(cb, profile)));
      }
    }
    expect(worst[1]).toBeLessThan(0.009);
    expect(worst[4]).toBeLessThan(0.017);
    // 对照：被否掉的那版在角色典型法线处就差 0.10（y⁴，绝对值）
    expect(worst[4]).toBeLessThan(0.1);
  });

  it('朝下的面几乎看不到天（L2 装不下地平线那道硬边）', () => {
    // profile 0/2 是精确的（残差 2e-5，且为负 ⇒ 被 max(·,0) 吃掉）；
    // profile 1 残差 −0.008 也被钳成 0；profile 4 会漏 **+0.014** 的天光到朝下面。
    // 这是 L2 的硬边振铃，不是可以调好的参数 —— 钉住防它悄悄变大。
    expect(at(shFor(0), -1)).toBeCloseTo(0, 4);
    expect(at(shFor(2), -1)).toBeCloseTo(0, 4);
    expect(at(shFor(1), -1)).toBeCloseTo(0, 4);
    expect(at(shFor(4), -1)).toBeLessThan(0.02);
  });

  it('cap₀(N) = (1+N·up)/2 —— 角色侧把传输换算成可见度用的那条闭式', () => {
    for (const cb of [1, 0.8, 0.6, 0.4, 0.2, 0, -0.4, -0.8, -1]) {
      expect(Math.abs((1 + cb) / 2 - capExact(cb, 0))).toBeLessThan(2e-3);
    }
  });

  it('基函数与着色器逐行同式（改一边这里就红）', () => {
    const b = shBasis(0.3, -0.5, 0.81);
    expect(b).toHaveLength(9);
    for (const [i, expr] of [
      [0, '0.2820948'], [1, '0.4886025 * y'], [2, '0.4886025 * z'], [3, '0.4886025 * x'],
      [4, '1.0925484 * x * y'], [5, '1.0925484 * y * z'],
      [6, '0.3153916 * (3.0 * z * z - 1.0)'], [7, '1.0925484 * x * z'],
      [8, '0.5462742 * (x * x - y * y)'],
    ] as [number, string][]) {
      expect(CORE3, `第 ${i} 项`).toContain(expr);
    }
  });
});

describe('shadeCore3.glsl · 结构契约', () => {
  const src = CORE3 as string;
  /** 只扫代码行 —— 文档注释里必须能写"那套已经没了"，扫全文会自己咬自己。 */
  const code = src.replace(/^[ \t]*(\/\/|\*|\/\*).*$/gm, '');

  it('4 通道纬向阶梯已经彻底没了', () => {
    expect(code).not.toContain('sc3SkyTransfer');
    expect(code).not.toContain('uSkyProfile');
    expect(code).not.toMatch(/vec4\s+T\b/);
  });

  it('遮蔽与天空在运行时才相乘，且只有这一处', () => {
    expect(src).toContain('vec3 sc3SkyIrradiance(vec3 bentDir, float vis, vec3 N)');
    expect(src).toContain('float w = 1.0 - (1.0 - v) * (1.0 - v);');
    expect(src).toContain('return sc3SkyShIrradiance(n) * v;');
    // 两条路径调的是同一个函数、同样的实参形状
    expect(SCENE_PASS).toContain('sc3SkyIrradiance(bentDir, skyVis, n)');
    expect(CHAR_SHADER).toContain('sc3SkyIrradiance(bentDir, skyVis, n)');
  });

  it('天空 SH 声明在核心里 ⇒ 两条路径谁也漏不掉', () => {
    expect(src).toContain('uniform vec4 uSkySh[9];');
    expect(SCENE_PASS).toContain("uSkySh: { value: new Float32Array(9 * 4)");
    expect(CHAR_SHADER).toContain("uSkySh: { value: new Float32Array(9 * 4)");
  });

  it('角色侧由 y⁰ 传输换算可见度，用的就是 cap₀ 闭式', () => {
    expect(CHAR_SHADER).toContain('t0 / max((1.0 + N.y) * 0.5, 1.0 / 255.0)');
    expect(CHAR_SHADER).toContain('bentDir = normalize(sky.yzw');
  });

  it('4 号视图 = 可见度，5 号 = bent 方向', () => {
    expect(src).toContain('if (mode == SC3_DEBUG_SKY_OCC)      return vec3(clamp(skyVis, 0.0, 1.0));');
    expect(src).toContain('if (mode == SC3_DEBUG_SKY_BENT)     return bentDir * 0.5 + 0.5;');
  });

  it('SH-L1 解包与烘焙侧的 RGBA8 打包互逆', () => {
    // 烘焙（bake_sky_sh_grid）：R = a₀ ∈ [0,1]，GBA = a₁·½+½（a₁ ∈ [−1,1]）。
    expect(src).toContain('float a0 = sh.r;');
    expect(src).toContain('vec3  a1 = (sh.gba - vec3(0.5)) * 2.0;');
  });

  it('没有 hemi / aoStrength / ratioMax 这三个 v2 旋钮', () => {
    expect(code).not.toMatch(/\bhemi\b/i);
    expect(code).not.toMatch(/aoStrength/i);
    expect(code).not.toMatch(/ratioMax/i);
  });

  it('调试编号是两条路径共用的一套', () => {
    for (const name of ['BASE', 'NORMAL', 'SKY_OCC', 'SKY_BENT', 'TOTAL_E', 'GI', 'SPECULAR']) {
      expect(src).toContain(`#define SC3_DEBUG_${name}`);
    }
  });
});
