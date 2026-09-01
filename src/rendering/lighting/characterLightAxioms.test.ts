/**
 * 角色受光的**两条公理**（制作人 2026-08-31 点名，原话级需求）：
 *
 *   ① 灯强度越大，角色越亮；强度很大时，旁边的角色应该很亮。
 *   ② 角色离灯越近越亮。
 *
 * 这两条保证不了，别的一切光照数据都没有意义。所以这里**跑真实产品链**——
 * `LightDef → packLights → applyCharLights → charLights 常驻组`，然后**从组里读回**
 * uniform、按 `lightingCore.glsl` 逐式相同的数学算角色收到的照度。取"组里读回的值"
 * 而不是"打包结果"是刻意的：2026-08-31 的 P0 恰恰断在打包之后——`setShadowBasis`
 * 的重放用缺省参数把 `wuPerQUnit`（880）踩成 1，打包数据全对、组里尺度是错的，
 * 角色对每盏带距离的灯都差 880 倍距离。修复前，本文件的公理②在"作者面的距离尺度"
 * 上直接崩（灯从一臂挪到十步远，照度几乎不变——因为真实距离被 880 倍常数支配）。
 *
 * 数学镜像锚定在真实 GLSL 源上（文末锚定测试）：公式漂了这里跟着红。
 */
import { describe, expect, it } from 'vitest';

import CORE_GLSL from './lightingCore.glsl?raw';
import SHADE_CORE from '../charShadeCore.glsl?raw';
import { CharacterLightingSystem } from '../../core/CharacterLightingSystem';
import { MAX_STATIC_LIGHTS, packLights } from './lightPacking';
import type { SceneLightingDef } from '../../data/types';

// ---------------------------------------------------------------- 场景常数
// 雾津街头的真实标定（geometry.json 实测值），不是编的：
// R = 绕 X 轴 45°（det=+1），wuPerQUnit = 880。
const WU_PER_Q = 880;
const C = 0.7071067811865476;
const BASIS = [1, 0, 0, 0, C, -C, 0, C, C];

// 角色胸口的伪世界 q（雾津街头 spawn 实测量级）与**水平**世界法线。
//
// ★ 法线为什么是水平的（制作人 2026-08-31 点破的几何事实）：角色是直立 quad，
//   直立面的面法线只能水平——中性图集法线 (0,0,-1) 贴上 quad 后就是世界 (0,0,-1)。
//   本文件曾错用上仰 45° 的 (0,.707,-.707)（来自 shader 里一段已删除的错注释），
//   照它摆的"贴脸灯"全落在法线背面,量出一堆假零。
const CHEST_Q: [number, number, number] = [0.094, -1.167, -1.2655];
const N_WORLD: [number, number, number] = [0, 0, -1];

function qToWorld(q: readonly number[], wu: number): [number, number, number] {
  const b = BASIS;
  return [
    (b[0] * q[0] + b[1] * q[1] + b[2] * q[2]) * wu,
    (b[3] * q[0] + b[4] * q[1] + b[5] * q[2]) * wu,
    (b[6] * q[0] + b[7] * q[1] + b[8] * q[2]) * wu,
  ];
}

// ------------------------------------------------- lightingCore 的 JS 镜像
/** `lcFalloff`：`exp(-r2/range²) / (r2 + softening)`。 */
function lcFalloff(r2: number, range: number, softening: number): number {
  return Math.exp(-r2 / Math.max(range * range, 1e-6)) / (r2 + softening);
}

/** `lcPointLight` 的照度标量（color 取白 ⇒ 只看亮度）。 */
function lcPoint(P: number[], N: number[], L: number[], I: number,
                 range: number, softening: number): number {
  const v = [L[0] - P[0], L[1] - P[1], L[2] - P[2]];
  const r2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
  const inv = 1 / Math.sqrt(Math.max(r2, 1e-12));
  const ndl = Math.max(N[0] * v[0] * inv + N[1] * v[1] * inv + N[2] * v[2] * inv, 0);
  return I * ndl * lcFalloff(r2, range, softening);
}

// ------------------------------------------- 真实产品链:def → 组 → 读回评估
function makeDef(lights: SceneLightingDef['lights']): SceneLightingDef {
  return {
    sky: { kelvin: 6500, intensity: 0.05, hemi: 0.9 },
    day: { sunIntensity: 0, sunElevationDeg: 50, sunAzimuthDeg: 180 },
    lights,
  } as unknown as SceneLightingDef;
}

/**
 * 把灯喂过真实链（含**事故时序**：灯先到、基后到 → 重放），再从常驻组读回
 * uniform，按 shader 同式算角色胸口收到的照度。
 */
function shaderSideIrradiance(lights: SceneLightingDef['lights']): number {
  const cl = new CharacterLightingSystem();
  const packed = packLights(makeDef(lights), WU_PER_Q);
  cl.applyLights(packed, WU_PER_Q);          // 灯先到（基未注入 → 暂缓）
  cl.setShadowBasis(BASIS);                  // 基后到 → 重放（P0 就断在这一步）
  const u = (cl as unknown as { charLights: { uniforms: Record<string, unknown> } })
    .charLights.uniforms;

  const count = u.uSceneLightCount as number;
  const wu = u.uSMWuPerQUnit as number;      // ★ 从组里读——修复前这里是 1 不是 880
  const A = u.uSceneLightA as Float32Array;
  const B = u.uSceneLightB as Float32Array;
  const Cc = u.uSceneLightC as Float32Array;
  const P = qToWorld(CHEST_Q, wu);           // shader 同式：P = R·q × uSMWuPerQUnit
  let E = 0;
  for (let i = 0; i < count; i++) {
    const o = i * 4;
    if (B[o + 3] <= 0) continue;
    E += lcPoint(P, N_WORLD, [A[o], A[o + 1], A[o + 2]], B[o + 3], Cc[o], Cc[o + 1]);
  }
  return E;
}

/** 在角色**正前方**（沿世界法线）distWu 处放一盏白点光。 */
function lampInFront(distWu: number, intensity: number) {
  const chest = qToWorld(CHEST_Q, WU_PER_Q);
  return {
    id: 't', kind: 'point' as const,
    pos: [chest[0] + N_WORLD[0] * distWu,
          chest[1] + N_WORLD[1] * distWu,
          chest[2] + N_WORLD[2] * distWu] as [number, number, number],
    color: [1, 1, 1] as [number, number, number],
    intensity, range: 2000, softeningRadius: 10, castShadow: false, enabled: true,
  };
}

describe('公理①：灯强度越大，角色越亮', () => {
  it('强度阶梯严格单调，且照度与强度成正比', () => {
    const dist = 60;                          // 一臂之外
    const ladder = [1, 10, 100, 1000].map(
      (I) => shaderSideIrradiance([lampInFront(dist, I)]));
    for (let i = 1; i < ladder.length; i++) {
      expect(ladder[i], `I×10 后照度必须升（第 ${i} 级）`).toBeGreaterThan(ladder[i - 1]);
      // 点光对强度是严格线性的：×10 就是 ×10（容差给浮点）
      expect(ladder[i] / ladder[i - 1]).toBeCloseTo(10, 5);
    }
  });

  it('强度很大时，旁边的角色**必须很亮**（照度盖过夜里的 probe 底光）', () => {
    // 夜里 probe 底光的实测量级 E≈0.02（线性）。一盏强灯在一臂外给出的照度
    // 必须显著超过它——否则"把灯调大"这个最基本的创作动作就是空的。
    const E = shaderSideIrradiance([lampInFront(60, 500)]);
    expect(E).toBeGreaterThan(0.02 * 3);
  });
});

/**
 * 着色输出镜像（charShadeCore：`out = srgb2lin(alb) × E/π × β`）。
 * alb 取角色图集实测中位反射率(0.0381,见 CHARACTER_ALBEDO_REFERENCE),
 * β 取雾津街头落盘的 shading.beta=4.2。
 *
 * ⚠ 4.2 是**硬编码的重复数据**:真值在 DVC 托管的
 *   `runtime/scenes/雾津街头/lighting/{background,background-night}/lighting.json`
 *   (测试不读它——DVC checkout 可能缺文件,读了会把测试跟资产状态锁死)。
 *   重标 beta 时这里要跟着改,否则"过曝阈值 ≈ I=11000"这句只是历史。
 */
function shadedOut(E: number): number {
  return 0.0381 * (E / Math.PI) * Math.pow(2, 4.2);
}

describe('镜像锚定②：charShadeCore.glsl 的着色公式没漂', () => {
  // shadedOut 镜像的是 charShadeCore 的乘链。该文件头自己写着"任何角色着色迭代
  // 只改此文件"——**预期会被改**,所以镜像必须有闸(2026-08-31 审计:原来只锚了
  // lightingCore,这半边完全无锚,改了 charShadeCore 过曝阈值会静默失真)。
  it('albedo/π/β 乘链逐字还在', () => {
    expect(SHADE_CORE).toContain('/ 3.14159265');
    expect(SHADE_CORE).toMatch(/srgb2lin\s*\(/);
    expect(SHADE_CORE).toMatch(/\*\s*beta\b/);
  });
});

describe('公理①续：强度大到一定程度必须过曝成白（clamp 行为）', () => {
  it('贴身强灯的着色输出超过 1（shader 端 clamp 到纯白）', () => {
    // 制作人原话:"灯强度很大的时候,旁边的角色早就应该过曝成一片白"。
    // 输出无上限地随 I 线性涨,唯一的封顶是 shader 末端的 clamp —— 所以
    // 必然存在一个 I 让输出 ≥1。当前尺度体系下贴身(50wu)过曝阈值 ≈ I=11000
    // (中位反照率 0.0381 的暗色美术,想烧白确实要很硬的光)。断言 2 万必白;
    // 阈值若因尺度重构漂了,这条会替人记住新数。
    const E = shaderSideIrradiance([lampInFront(50, 20000)]);
    expect(shadedOut(E)).toBeGreaterThan(1);
    // 且在过曝前是严格线性的(不是被什么东西软压着)
    const half = shaderSideIrradiance([lampInFront(50, 10000)]);
    expect(E / half).toBeCloseTo(2, 5);
  });
});

describe('公理③：灯在法线反方向 ⇒ 完全不受光（制作人点名的几何事实）', () => {
  it('灯放在角色背面（沿 -N 方向）照度恒为 0', () => {
    const chest = qToWorld(CHEST_Q, WU_PER_Q);
    const behind = {
      ...lampInFront(60, 1000),
      pos: [chest[0] - N_WORLD[0] * 60,
            chest[1] - N_WORLD[1] * 60,
            chest[2] - N_WORLD[2] * 60] as [number, number, number],
    };
    expect(shaderSideIrradiance([behind])).toBe(0);
  });

  it('灯在 quad 平面内（正上/正下/正侧）拿零;移到平面靠相机一侧就有光', () => {
    // 水平法线的两个推论,都是摆灯指引:
    // ① 灯与人同深度(在直立 quad 平面内)时 N·L=0——挂在人**正头顶**的灯
    //    照不亮人的正面,这是几何,不是 bug;
    // ② 只要往相机一侧挪一点(z 更负),同一盏灯立刻照亮正面——包括**脚边的火**
    //    (低位不是问题,同平面才是)。
    const chest = qToWorld(CHEST_Q, WU_PER_Q);
    const inPlaneAbove = { ...lampInFront(60, 1000),
      pos: [chest[0], chest[1] + 80, chest[2]] as [number, number, number] };
    expect(shaderSideIrradiance([inPlaneAbove])).toBeLessThan(1e-6);   // 浮点尾巴容差
    const lowButInFront = { ...lampInFront(60, 1000),
      pos: [chest[0], chest[1] - 50, chest[2] - 40] as [number, number, number] };
    expect(shaderSideIrradiance([lowButInFront])).toBeGreaterThan(0);
  });
});

describe('公理②：角色离灯越近越亮', () => {
  it('距离阶梯严格单调（同一盏灯，越近照度越高）', () => {
    const byDist = [400, 200, 100, 50, 25].map(
      (d) => shaderSideIrradiance([lampInFront(d, 100)]));
    for (let i = 1; i < byDist.length; i++) {
      expect(byDist[i], `距离减半照度必须升（第 ${i} 级）`).toBeGreaterThan(byDist[i - 1]);
    }
    // 近场（softening 与 range 截断可忽略处）近似 1/r²：距离减半 ≈ ×4
    expect(byDist[2] / byDist[1]).toBeGreaterThan(3);
    expect(byDist[2] / byDist[1]).toBeLessThan(5);
  });

  it('尺度回归：作者面的"一臂"必须真的是一臂（wuPerQUnit 被踩掉时本条崩）', () => {
    // P0 的形状：组里 wuPerQUnit=1 时角色 P 缩在 q 尺度（±2），作者面 60wu 与
    // 120wu 的灯在角色看来都是"一百多 wu 外"，照度比趋近 1。修复后必须 ≈4。
    const near = shaderSideIrradiance([lampInFront(60, 100)]);
    const far = shaderSideIrradiance([lampInFront(120, 100)]);
    expect(near / far).toBeGreaterThan(3);
    expect(near / far).toBeLessThan(5);
  });
});

describe('数学镜像锚定（公式漂了这里先红，别让镜像装死）', () => {
  it('lcFalloff / lcPointLight 的关键式样仍在 GLSL 源里', () => {
    expect(CORE_GLSL).toContain('cut / (r2 + softening)');
    expect(CORE_GLSL).toContain('exp(-r2 / max(range * range, 1e-6))');
    expect(CORE_GLSL).toContain('intensity * ndl * lcFalloff(r2, range, softening) * vis');
  });

  it('评估链真的有光（防公理测试因摆错灯而空转全绿）', () => {
    expect(shaderSideIrradiance([lampInFront(60, 100)])).toBeGreaterThan(1e-4);
    expect(shaderSideIrradiance([])).toBe(0);
  });

  it(`打包上限外的灯不算数（第 ${MAX_STATIC_LIGHTS + 1} 盏被丢弃）`, () => {
    const many = Array.from({ length: MAX_STATIC_LIGHTS }, () => lampInFront(60, 0.0001));
    const overflow = shaderSideIrradiance([...many, lampInFront(60, 1000)]);
    const baseline = shaderSideIrradiance(many);
    expect(overflow).toBeCloseTo(baseline, 6);
  });
});
