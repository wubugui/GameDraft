import { describe, expect, it } from 'vitest';

import type { LightDef, SceneLightingDef } from '../data/types';
import {
  clampAoElevation, CONTACT_AO_MIN_ELEVATION_DEG, indirectUpperMoment, lightGroundSources,
  MAX_CONTACT_AO_SOURCES, MIN_CONTACT_AO_SOURCE_SHARE, resolveContactAoSources, type ContactAoSource,
} from './contactAoSources';
import { packLights } from './lighting/lightPacking';
import { indirectEY, type ProbeCpuData } from './lighting/probeCpuSampler';

/**
 * 接触 AO 方向部分缺省档「按光照」（制作人 2026-09-24：「ao 方向本来就和间接光强度要一致」）：
 * 间接光一路 + 每盏灯一路，各投各的影，按各自照到地面的量加权。这里守：
 * 间接光那一路与角色间接光查的是同一个函数、一阶矩推导对；灯的地面照度与 shader 同式；
 * 几路不合成一个方向；离得远 / 照不到的灯份量自然小；只留 K 路时排名交替不跳。
 */

const elevDeg = (v: readonly number[]) => (Math.atan2(v[1], Math.hypot(v[0], v[2])) * 180) / Math.PI;
const IDENT = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function toHalf(v: number): number {
  const f = new Float32Array([v]);
  const u = new Uint32Array(f.buffer)[0];
  if (v === 0) return 0;
  return ((u >>> 16) & 0x8000) | ((((u >>> 23) & 0xff) - 127 + 15) << 10) | ((u >>> 13) & 0x3ff);
}

/** 每颗 probe 同一组线性 SH（L1）系数的小载荷：E(n) = a + b·n，a = c0·Y00，b = Y1·(c3, c1, c2)。 */
function linearProbes(c: [number, number, number, number], over: Partial<ProbeCpuData> = {}): ProbeCpuData {
  const atlas = new Uint16Array(8 * 4 * 4);
  for (let p = 0; p < 8; p++) for (let k = 0; k < 4; k++) for (let ch = 0; ch < 3; ch++) atlas[(p * 4 + k) * 4 + ch] = toHalf(c[k]);
  return {
    atlas, nCol: 4, valid: new Uint8Array(8).fill(255),
    pn: [2, 2, 2], wMin: [-10, -10, -10], wScale: [0.05, 0.05, 0.05], mCol: IDENT,
    mode: 2, shK: 4, binOb: 8, fold: false, ambSH: new Float32Array(27), ambStrength: 1,
    skyao: null, skyaoBlend: 1, ...over,
  };
}

describe('indirectUpperMoment：间接光的上半球来光一阶矩', () => {
  it('E(n) = a + b·n 时恰为 (b_x, a + b_y, b_z)（竖直 = 朝上的照度，水平 = 倾斜变化率）', () => {
    const c: [number, number, number, number] = [4, 0.5, -0.5, 1];
    const a = 0.282095 * c[0];
    const b = [0.488603 * c[3], 0.488603 * c[1], 0.488603 * c[2]];
    const m = indirectUpperMoment(linearProbes(c), [0, 0, 0], IDENT);
    expect(m[0]).toBeCloseTo(b[0], 3);
    expect(m[1]).toBeCloseTo(a + b[1], 3);
    expect(m[2]).toBeCloseTo(b[2], 3);
  });

  it('四面均匀 ⇒ 竖直向上（没有方向倾向）', () => {
    const m = indirectUpperMoment(linearProbes([4, 0, 0, 0]), [0, 0, 0], IDENT);
    expect(Math.abs(m[0])).toBeLessThan(1e-6);
    expect(Math.abs(m[2])).toBeLessThan(1e-6);
    expect(m[1]).toBeGreaterThan(0);
  });

  it('查的就是角色间接光那个函数（含折叠）：竖直分量 = 世界朝上法线过 Rᵀ 后的 indirectEY', () => {
    const C45 = Math.SQRT1_2;
    const rows = [1, 0, 0, 0, C45, -C45, 0, C45, C45];      // 45° 俯角，q→world
    const d = linearProbes([4, 0.5, 1, 0], { fold: true });
    const upQ = [rows[1], rows[4], rows[7]];                 // Rᵀ·(0,1,0)
    const m = indirectUpperMoment(d, [0, 0, 0], rows);
    expect(m[1]).toBeCloseTo(indirectEY(d, [0, 0, 0], upQ[0], upQ[1], upQ[2]), 9);
  });
});

const pack = (lights: LightDef[]) => packLights({ lights } as unknown as SceneLightingDef, 1);
const lumOf = (p: ReturnType<typeof pack>, i: number) => 0.2126 * p.b[i * 4] + 0.7152 * p.b[i * 4 + 1] + 0.0722 * p.b[i * 4 + 2];

describe('lightGroundSources：每盏灯给脚下地面的照度（与 shader 同式）', () => {
  it('点光正上方：I · exp(−h²/range²) / (h² + 软化²)，方向朝上', () => {
    const p = pack([{ id: 'a', kind: 'point', intensity: 1000, pos: [0, 100, 0], range: 1000, softeningRadius: 10 }]);
    const [s] = lightGroundSources(p, [0, 0, 0]);
    expect(s.e).toBeCloseTo(1000 * Math.exp(-1e4 / 1e6) / (1e4 + 100) * lumOf(p, 0), 9);
    expect(s.src.point).toBe(true);
    expect(s.src.footDir).toEqual([0, 1, 0]);
  });

  it('灯比脚还低 / 聚光锥外 / 强度 0 ⇒ 不算', () => {
    const p = pack([
      { id: 'low', kind: 'point', intensity: 1000, pos: [100, -10, 0] },
      { id: 'spot', kind: 'spot', intensity: 1000, pos: [0, 100, 0], dir: [1, 0, 0], innerAngleDeg: 10, outerAngleDeg: 20 },
      { id: 'off', kind: 'point', intensity: 0, pos: [0, 100, 0] },
    ]);
    expect(lightGroundSources(p, [0, 0, 0])).toEqual([]);
  });

  it('平行光：I · max(dir.y, 0)，方向型；仰角低于下限的来向钳到 25°', () => {
    const p = pack([{ id: 'sun', kind: 'directional', intensity: 2, elevationDeg: 10, azimuthDeg: 90 }]);
    const [s] = lightGroundSources(p, [0, 0, 0]);
    expect(s.e).toBeCloseTo(2 * Math.sin((10 * Math.PI) / 180) * lumOf(p, 0), 6);
    expect(s.src.point).toBe(false);
    expect(elevDeg(s.src.footDir)).toBeCloseTo(CONTACT_AO_MIN_ELEVATION_DEG, 6);
  });

  it('面光朝下悬在头顶：正面照到地面，有照度', () => {
    const p = pack([{ id: 'win', kind: 'area', intensity: 5, pos: [0, 200, 0], dir: [0, -1, 0], size: [100, 100], range: 2000 }]);
    const out = lightGroundSources(p, [0, 0, 0]);
    expect(out).toHaveLength(1);
    expect(out[0].e).toBeGreaterThan(0);
  });

  it('离得远，照度自然小：同一盏灯 2 倍射程外的份量不到 1 倍射程处的 1/20', () => {
    const p = pack([{ id: 'a', kind: 'point', intensity: 1000, pos: [0, 100, 0], range: 200 }]);
    const near = lightGroundSources(p, [200, 0, 0])[0].e;
    const far = lightGroundSources(p, [400, 0, 0])[0].e;
    expect(far / near).toBeLessThan(1 / 20);
  });
});

const src = (x: number, y: number, z: number, point = true): Omit<ContactAoSource, 'weight'> =>
  ({ point, x, y, z, footDir: clampAoElevation(point ? [x, y, z] : [x, y, z])! });

describe('resolveContactAoSources：几路各投各的影，按地面照度占比加权', () => {
  it('两盏一样亮的灯在两侧 ⇒ 两路各一半，不合成一个方向', () => {
    const out = resolveContactAoSources(null, 1, [{ e: 2, src: src(-100, 100, 0) }, { e: 2, src: src(100, 100, 0) }], 1);
    expect(out).toHaveLength(2);
    for (const s of out) expect(s.weight).toBeCloseTo(0.5 - MIN_CONTACT_AO_SOURCE_SHARE, 12);
    expect(out.map((s) => Math.sign(s.x)).sort()).toEqual([-1, 1]);
  });

  it('只有间接光 ⇒ 一路方向型、占满份、方向 = 一阶矩归一', () => {
    const [s, ...rest] = resolveContactAoSources([0.3, 1, 0], 2, [], 1);
    expect(rest).toEqual([]);
    expect(s.point).toBe(false);
    expect(s.weight).toBeCloseTo(1 - MIN_CONTACT_AO_SOURCE_SHARE, 12);
    expect(s.x / s.y).toBeCloseTo(0.3, 9);
  });

  it('权重 = 各自地面照度 × 各自倍率 ÷ 总和（间接光的地面照度 = 一阶矩竖直分量）', () => {
    const out = resolveContactAoSources([0, 0.5, 0], 4, [{ e: 1, src: src(0, 100, 50) }], 1);
    const probe = out.find((s) => !s.point)!;
    const lamp = out.find((s) => s.point)!;
    expect(probe.weight).toBeCloseTo(2 / 3 - MIN_CONTACT_AO_SOURCE_SHARE, 9);
    expect(lamp.weight).toBeCloseTo(1 / 3 - MIN_CONTACT_AO_SOURCE_SHARE, 9);
  });

  it(`只留 ${MAX_CONTACT_AO_SOURCES} 路：每路先减去被挤掉那一路，排名交替时进出的那路权重恰为 0`, () => {
    const lights = [5, 4, 3, 2, 1].map((e, i) => ({ e, src: src(i * 10 - 20, 100, 0) }));
    const out = resolveContactAoSources(null, 1, lights, 1);
    expect(out.map((s) => s.weight)).toEqual([4 / 15, 3 / 15, 2 / 15, 1 / 15]);
    const tie = resolveContactAoSources(null, 1, [5, 4, 3, 2, 2].map((e, i) => ({ e, src: src(i, 100, 0) })), 1);
    expect(tie.map((s) => s.weight)).toEqual([3 / 16, 2 / 16, 1 / 16]);
  });

  it('占比低于下限的一路不算，且跨过下限时权重从 0 连续涨起（不撑大片子、不跳）', () => {
    const lamp = (e: number) => ({ e, src: src(100, 100, 0) });
    const shareOf = (e: number) => resolveContactAoSources([0, 1, 0], 1, [lamp(e)], 1).find((s) => s.point)?.weight ?? 0;
    expect(shareOf(0.01)).toBe(0);                                   // 占 1%：不算
    const edge = MIN_CONTACT_AO_SOURCE_SHARE / (1 - MIN_CONTACT_AO_SOURCE_SHARE);   // 恰好占到下限
    expect(shareOf(edge)).toBeCloseTo(0, 12);
    expect(shareOf(edge * 1.001)).toBeGreaterThan(0);
    expect(shareOf(edge * 1.001)).toBeLessThan(1e-4);
  });

  it('一路都没有 ⇒ 空（只画简单 AO）', () => {
    expect(resolveContactAoSources(null, 1, [], 1)).toEqual([]);
    expect(resolveContactAoSources([0, 0, 0], 1, [], 1)).toEqual([]);
  });
});

describe('clampAoElevation：仰角只钳下限', () => {
  it('低于 25° 钳上来，水平朝向不变；正上方原样；正下方无从谈起', () => {
    const v = clampAoElevation([1, 0.1, 0])!;
    expect(elevDeg(v)).toBeCloseTo(CONTACT_AO_MIN_ELEVATION_DEG, 9);
    expect(v[2]).toBe(0);
    expect(clampAoElevation([0, 3, 0])).toEqual([0, 1, 0]);
    expect(elevDeg(clampAoElevation([0.1, 5, 0])!)).toBeGreaterThan(85);
    expect(clampAoElevation([0, -1, 0])).toBeNull();
  });
});
