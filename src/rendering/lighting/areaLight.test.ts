import { describe, expect, it } from 'vitest';

import CORE from './lightingCore.glsl?raw';

/**
 * 面光的**朝向语义** —— Lambert 多边形辐照度的符号契约。
 *
 * ## 这条是怎么暴露的
 *
 * 制作人 2026-08-21 要在空地场景上看四种灯型,面光那张是废片:地面上一点光斑都没有,
 * 整张图里面光可见的部分只有灯体辉光。而且 `twoSided` 开关两种结果**逐位相同**。
 *
 * ## 根因
 *
 * `lcAreaLight` 传给 `lcRectIrradiance` 的四个顶点绕向是
 * `(c−U−V, c+U−V, c+U+V, c−U+V)`,而这个绕向与 `cross(halfU, halfV)` 定的正面
 * **反着**。Lambert 多边形式对绕向敏感:于是它在**正面**算出负值、被 `max(0)` 吃成 0,
 * 在**背面**反而算出正值。净效果不是"面光不亮",而是**面光照亮了错误的一侧**。
 *
 * 实测(面板在 (950,357,0),半轴 150×100,地面法线 (0,1,0)):
 * - 面板**朝下**、地在正下方(该亮):单面判据 dot(n,−d)=+350 通过,E = **−0.1328** ⇒ 0
 * - 面板**朝上**、地在正下方(该黑):单面判据 −350 拒绝,E 却 = **+0.1328**
 *
 * 两者恰好互换。下面这份是那套数学的 JS 镜像,四种情形逐个锁住。
 */

type V3 = [number, number, number];

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1e-9;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/**
 * `areaAxes` 的镜像:由法线 + 半宽半高 + **绕法线的自转**推出两条半轴。
 *
 * ⚠ 这份镜像与 GLSL 必须逐字同构。前两步造的只是**参考基**(从法线算出来的),
 *   第三步的平面内旋转才是作者能表达"哪边是宽"的地方 —— 少了它,
 *   一扇斜着的窗根本摆不出来。
 */
function areaAxes(n0: V3, hw: number, hh: number, rollRad = 0): { hU: V3; hV: V3; n: V3 } {
  const n = norm(n0);
  const up: V3 = Math.abs(n[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0];
  const u0 = norm(cross(up, n));
  const v0 = cross(n, u0);
  const c = Math.cos(rollRad);
  const s = Math.sin(rollRad);
  const u = add(mul(u0, c), mul(v0, s));
  const v = add(mul(v0, c), mul(u0, -s));
  return { hU: mul(u, hw), hV: mul(v, hh), n };
}

/** `lcRectIrradiance` 的镜像。返回**带符号**值。 */
function rectIrradiance(P: V3, N: V3, vs: [V3, V3, V3, V3]): number {
  const ps = vs.map((v) => norm(sub(v, P)));
  let sum = 0;
  for (const [a, b] of [[0, 1], [1, 2], [2, 3], [3, 0]] as const) {
    const ax = cross(ps[a], ps[b]);
    const ln = Math.hypot(ax[0], ax[1], ax[2]);
    if (ln > 1e-6) {
      sum += Math.acos(Math.max(-1, Math.min(1, dot(ps[a], ps[b]))))
        * dot(mul(ax, 1 / ln), N);
    }
  }
  return sum * (0.5 / Math.PI);
}

/** 现行(已修)的绕向:从正面看逆时针。 */
function irradiance(center: V3, orient: V3, hw: number, hh: number,
                    P: V3, N: V3, twoSided = false): number {
  const { hU, hV, n } = areaAxes(orient, hw, hh);
  const d = sub(center, P);
  if (!twoSided && dot(n, mul(d, -1)) <= 0) return 0;
  const E = rectIrradiance(P, N, [
    sub(sub(center, hU), hV),
    add(sub(center, hU), hV),
    add(add(center, hU), hV),
    sub(add(center, hU), hV),
  ]);
  return twoSided ? Math.abs(E) : Math.max(E, 0);
}

const CENTER: V3 = [950, 357, 0];
const HW = 150;
const HH = 100;
const GROUND_UP: V3 = [0, 1, 0];
const BELOW: V3 = [951, 7, -1];
const IN_FRONT: V3 = [950, 7, -400];
const BEHIND: V3 = [950, 7, 400];

describe('面光照亮的必须是它朝向的那一侧', () => {
  it('朝下的面板照亮正下方的地', () => {
    expect(irradiance(CENTER, [0, -1, 0], HW, HH, BELOW, GROUND_UP))
      .toBeGreaterThan(0.1);
  });

  it('朝上的面板**不**照亮正下方的地（背对着它）', () => {
    // 这条曾经是反的:朝上的面板给出 +0.1328，朝下的给出 0
    expect(irradiance(CENTER, [0, 1, 0], HW, HH, BELOW, GROUND_UP)).toBe(0);
  });

  it('朝前的面板照亮正前方，不照亮正后方', () => {
    expect(irradiance(CENTER, [0, 0, -1], HW, HH, IN_FRONT, GROUND_UP))
      .toBeGreaterThan(0.02);
    expect(irradiance(CENTER, [0, 0, -1], HW, HH, BEHIND, GROUND_UP)).toBe(0);
  });
});

describe('双面光两侧都亮', () => {
  it('朝前的双面板，前后都有贡献且量级相当', () => {
    const f = irradiance(CENTER, [0, 0, -1], HW, HH, IN_FRONT, GROUND_UP, true);
    const b = irradiance(CENTER, [0, 0, -1], HW, HH, BEHIND, GROUND_UP, true);
    expect(f).toBeGreaterThan(0.02);
    expect(b).toBeGreaterThan(0.02);
    expect(Math.abs(f - b) / f).toBeLessThan(0.1);
  });

  it('单面时背面恒为 0——双面不是"随便多给点"，是把被裁掉那一侧还回来', () => {
    expect(irradiance(CENTER, [0, 0, -1], HW, HH, BEHIND, GROUND_UP, false)).toBe(0);
  });
});

describe('机械契约：GLSL 与这份镜像不许分家', () => {
  it('顶点绕向是「从正面看逆时针」', () => {
    // 只看四个顶点表达式的**顺序**，不锁缩进/换行（文件是 CRLF，锁死会假红）
    const order = [...CORE.matchAll(/center ([+-]) halfU ([+-]) halfV/g)]
      .map((m) => `${m[1]}${m[2]}`);
    expect(order.length).toBeGreaterThanOrEqual(4);
    // 正确绕向：−− → −+ → ++ → +−（从正面看逆时针）
    expect(order.slice(0, 4)).toEqual(['--', '-+', '++', '+-']);
    // 防回退：旧的反绕向是 −− → +− → ++ → −+，那个绕向会让面光照亮错误的一侧
    expect(order.slice(0, 4)).not.toEqual(['--', '+-', '++', '-+']);
  });

  it('lcRectIrradiance 返回带符号值，钳位在 lcAreaLight 里', () => {
    expect(CORE).toContain('return sum * (0.5 / LC_PI);');
    expect(CORE).not.toContain('return max(sum * (0.5 / LC_PI), 0.0);');
    expect(CORE).toContain('E = twoSided ? abs(E) : max(E, 0.0);');
  });
});
