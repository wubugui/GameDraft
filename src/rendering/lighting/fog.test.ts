import { describe, expect, it } from 'vitest';

import LIGHTING_CORE from './lightingCore.glsl?raw';

/**
 * 高度雾的解析解。
 *
 * 用像素取证验这个不干净：背景自身的明暗随画面内容剧烈起伏（同一条街上黑墙 0.006、
 * 亮石板 0.235，差 40 倍），把「雾把它拉动了多少」当作光学深度的代理会被内容主导。
 * 所以这里直接锁公式本身，再用一条机械契约保证 GLSL 那份没被改走。
 *
 * ## 为什么有闭式解
 *
 * 相机是**正交**的 ⇒ 视线方向恒定 ⇒ 沿视线积分 σ(y) = σ₀·exp(−(y−baseY)/H)
 * 只是一个指数的定积分，不需要 ray march：
 *
 * ```
 * od = σ₀ · dist · (exp(−(yCam−baseY)/H) − exp(−(ySurf−baseY)/H)) · H / (ySurf − yCam)
 * ```
 *
 * `ySurf ≈ yCam` 时上式是 0/0，退化成 `σ₀ · exp(−(yCam−baseY)/H) · dist`（等高度雾）。
 */

/** `lcOpticalDepth` 的 JS 镜像。改这里必须同步改 GLSL，反之亦然（见文末契约测试）。 */
function opticalDepth(
  dist: number, yCam: number, ySurf: number,
  sigma0: number, scaleH: number, baseY: number,
): number {
  const H = Math.max(scaleH, 1e-4);
  const a = Math.exp(-(yCam - baseY) / H);
  const b = Math.exp(-(ySurf - baseY) / H);
  const dy = ySurf - yCam;
  if (Math.abs(dy) < 1e-5) return sigma0 * a * dist;
  return sigma0 * dist * ((a - b) * H) / dy;
}

const transmittance = (od: number): number => Math.exp(-Math.max(od, 0));

describe('高度雾 · 随距离', () => {
  it('光学深度随视距**单调增**（远处必须比近处雾）', () => {
    let prev = -1;
    for (const dist of [0, 0.5, 1, 2, 4, 8]) {
      const od = opticalDepth(dist, 0.3, 0.3, 1.5, 2, 0);
      expect(od).toBeGreaterThan(prev);
      prev = od;
    }
  });

  it('等高度时退化成 σ·dist（Beer–Lambert 本体）', () => {
    // baseY = yCam = ySurf ⇒ exp 项为 1
    expect(opticalDepth(3, 0, 0, 0.4, 2, 0)).toBeCloseTo(1.2, 9);
  });

  it('σ=0 时完全无雾（透射率恒 1）', () => {
    expect(transmittance(opticalDepth(100, 0, 5, 0, 2, 0))).toBe(1);
  });

  it('dist=0 时无雾（贴着相机的东西不该被雾化）', () => {
    expect(opticalDepth(0, 0, 3, 5, 2, 0)).toBe(0);
  });
});

describe('高度雾 · 随高度', () => {
  it('雾层之上比雾层之内薄（这才叫"高度雾"）', () => {
    const low = opticalDepth(4, 0, 0, 1, 2, 0);      // 贴地
    const high = opticalDepth(4, 6, 6, 1, 2, 0);     // 高出 3 个尺度高
    expect(high).toBeLessThan(low * 0.1);
  });

  it('baseY 抬高整层雾，同一高度处变浓', () => {
    const atBase0 = opticalDepth(4, 3, 3, 1, 2, 0);
    const atBase3 = opticalDepth(4, 3, 3, 1, 2, 3);
    expect(atBase3).toBeGreaterThan(atBase0);
  });

  it('尺度高度越大衰减越慢（高处也还有雾）', () => {
    const thin = opticalDepth(4, 5, 5, 1, 1, 0);
    const thick = opticalDepth(4, 5, 5, 1, 8, 0);
    expect(thick).toBeGreaterThan(thin);
  });

  it('跨高度走的是真积分，不是端点梯形近似', () => {
    // 从 y=0 走到 y=4，H=2：闭式解 = σ·dist·H·(1−e⁻²)/4 = 1.729
    const closed = opticalDepth(4, 0, 4, 1, 2, 0);
    const atLow = opticalDepth(4, 0, 0, 1, 2, 0);     // 4.000
    const atHigh = opticalDepth(4, 4, 4, 1, 2, 0);    // 0.541
    expect(closed).toBeLessThan(atLow);
    expect(closed).toBeGreaterThan(atHigh);
    // ⚠ exp 衰减是**凸**函数 ⇒ 端点梯形法系统性**高估**积分。
    //   若哪天有人把闭式解"简化"成端点平均，这条会当场红。
    expect(closed).toBeLessThan((atLow + atHigh) / 2);
    expect(closed).toBeCloseTo(2 * (1 - Math.exp(-2)), 9);
  });

  it('0/0 那一支与闭式支在分支边界上连续（不许跳）', () => {
    // GLSL 在 |dy| < 1e-5 处换支。两侧必须接得上，否则贴着相机平面的
    // 那一圈像素会出现一条看不出来源的亮/暗环。
    const degenerate = opticalDepth(3, 1, 1 + 9e-6, 0.7, 2, 0);
    const closedForm = opticalDepth(3, 1, 1 + 1.1e-5, 0.7, 2, 0);
    // 退化支的一阶截断误差是 σ·dist·a·dy/(2H)，在分支阈值上 ≈ 3e-6，肉眼不可见。
    // 判据取 1e-4：真断裂（某一支漏乘 dist 或 H）会差好几个数量级，跑不掉。
    expect(Math.abs(closedForm - degenerate)).toBeLessThan(1e-4);
  });
});

describe('机械契约：GLSL 与这份 JS 镜像不许分家', () => {
  it('lcOpticalDepth 的函数体逐项对得上（改一边不改另一边当场红）', () => {
    const m = /float lcOpticalDepth\([\s\S]*?\n\}/.exec(LIGHTING_CORE);
    expect(m, '找不到 lcOpticalDepth —— 被改名或删了？').not.toBeNull();
    const body = m![0];
    // 逐条锁住构成闭式解的那几项。这些表达式在 GLSL 里是**逐字**存在的；
    // 任何一项被"顺手简化"掉都会改变数值，而画面上只表现为"雾好像不太对"。
    for (const frag of [
      'float H = max(scaleH, 1e-4);',
      'float a = exp(-(yCam - baseY) / H);',
      'float b = exp(-(ySurf - baseY) / H);',
      'float dy = ySurf - yCam;',
      'if (abs(dy) < 1e-5) return sigma0 * a * dist;',
      'return sigma0 * dist * (a - b) * H / dy;',
    ]) {
      expect(body, `GLSL 里缺这一项：${frag}`).toContain(frag);
    }
  });

  it('lcApplyFog 是 T 混合而不是加法叠加（加法会让雾把画面加亮到爆）', () => {
    expect(LIGHTING_CORE).toContain('float T = exp(-max(opticalDepth, 0.0));');
    expect(LIGHTING_CORE).toContain('return lin * T + scatterColor * (1.0 - T);');
  });
});
