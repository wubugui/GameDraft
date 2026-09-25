import { describe, expect, it, vi } from 'vitest';

// 只把两个渲染对象换成空壳（Shader.from 在无 DOM 的测试环境要 document），其余全走真实的 SwayBackground.update
vi.mock('../engine2d', async (importOriginal) => {
  const real = await importOriginal<typeof import('../engine2d')>();
  return { ...real, Shader: { from: () => ({ resources: {} }) }, Mesh: class extends real.Container {} };
});

import { Texture } from '../engine2d';
import { SwayBackground, swayPivot, type BackgroundSwayInput, type SwayInstanceDef } from './backgroundSway';
import { resolveSceneWind, SWAY_WAVE_SIZE_DEFAULT } from '../utils/sceneWind';

type Probe = { insts: { def: SwayInstanceDef; v0: number; v1: number }[]; p0: Float32Array; pos: Float32Array };

const build = (inst: SwayInstanceDef): { sb: SwayBackground; S: Probe } => {
  const inp = {
    urls: [], plateTex: Texture.WHITE, matteTex: Texture.WHITE, idsTex: Texture.WHITE,
    meta: { version: 3, margin: 400, instances: [inst] },       // 补带放宽：这里只看节奏，不看封顶
    sceneSize: [800, 800], paintSize: [800, 800],
    jx: [1, 0], jy: [0, -0.707], jz: [0, -0.707],
    sceneToWorldXZ: null, scaleAt: null, ids: null, matte: null, rigid: null, litPlate: null,
  } as unknown as BackgroundSwayInput;
  const sb = new SwayBackground(Texture.WHITE, inp);
  return { sb, S: sb as unknown as Probe };
};

/** 同一株上两个相距很远的顶点，x 位移时间序列的相关系数（1 = 完全同步） */
const correlation = (inst: SwayInstanceDef, waveSize?: number): number => {
  const { sb, S } = build(inst);
  const w = resolveSceneWind({
    direction: [-1, 0, 0], speed: 400, gust: { amount: 0.8, period: 7 },
    turbulence: { intensity: 0.35, scale: 140 }, roughness: 1, ...(waveSize ? { waveSize } : {}),
  })!;
  const rt = S.insts[0];
  // 挑同一高度（离网格顶最近的一排）上最左与最右的两个顶点：自由度相同，差别只来自节奏
  let yTop = Infinity;
  for (let v = rt.v0; v < rt.v1; v++) yTop = Math.min(yTop, S.p0[v * 2 + 1]);
  let a = -1, b = -1;
  for (let v = rt.v0; v < rt.v1; v++) {
    if (Math.abs(S.p0[v * 2 + 1] - yTop) > 1e-3) continue;
    if (a < 0 || S.p0[v * 2] < S.p0[a * 2]) a = v;
    if (b < 0 || S.p0[v * 2] > S.p0[b * 2]) b = v;
  }
  const xa: number[] = [], xb: number[] = [];
  for (let i = 1; i <= 120 * 60; i++) {
    sb.update(w, i / 60);
    if (i < 600) continue;
    xa.push(S.pos[a * 2] - S.p0[a * 2]);
    xb.push(S.pos[b * 2] - S.p0[b * 2]);
  }
  const mean = (s: number[]) => s.reduce((p, q) => p + q, 0) / s.length;
  const ma = mean(xa), mb = mean(xb);
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < xa.length; i++) {
    sab += (xa[i] - ma) * (xb[i] - mb); saa += (xa[i] - ma) ** 2; sbb += (xb[i] - mb) ** 2;
  }
  return sab / Math.sqrt(saa * sbb);
};

/**
 * 🔴 大植物不许被扭成波浪（制作人 2026-09-13："有一些植物看着很大，就应该整体一起扭，而不是植物都被扭成波浪了"）。
 *
 * 同一株上每个点按自己的位置取风的节奏，节奏在空间上有个相关长度（`wind.waveSize`，缺省 20 wu）；
 * 植物比半个波长大，就一截往左一截往右。调大波浪尺寸 / 标"整体摆"两条路都要能让整株同步。
 */
describe('草木的波浪尺寸与整体摆（真实 SwayBackground.update）', () => {
  // 一片 600 wu 宽的"大植物"（场，自由度全 1）
  const big: SwayInstanceDef = { id: 1, kind: 'field', root: [400, 700], height: 85, persp: 1, reach: 600, bbox: [100, 100, 700, 700] };

  it('缺省波浪尺寸下，相距 600 wu 的两点各动各的（这就是"扭成波浪"）', () => {
    expect(SWAY_WAVE_SIZE_DEFAULT).toBe(20);
    expect(correlation(big)).toBeLessThan(0.9);
  });

  it('波浪尺寸调到比植物大得多，整株基本同步', () => {
    expect(correlation(big, 6000)).toBeGreaterThan(0.98);
  });

  it('🔴 标了"整体摆"，不管波浪尺寸多小，整株完全同一个节奏', () => {
    expect(correlation({ ...big, coherent: true }, 40)).toBeGreaterThan(0.999);
  });
});

/**
 * 🔴 刚体绕作者点的锚点转（制作人 2026-09-13："刚体要可以我自己定锚点，不然有的你就是乱在旋转"）。
 */
describe('刚体锚点', () => {
  it('支点取离这一点最近的锚点；没点锚点就是自动分割的根', () => {
    const d = { root: [0, 0] as [number, number], anchors: [[100, 100], [300, 100]] as [number, number][] };
    expect(swayPivot(d, 120, 50)).toEqual([100, 100]);
    expect(swayPivot(d, 290, 20)).toEqual([300, 100]);
    expect(swayPivot({ root: [5, 6] }, 999, 999)).toEqual([5, 6]);
  });

  it('🔴 整株刚转时，锚点那里钉住不动、离锚点远的地方在转（原先绕的是自动算出来的根）', () => {
    const plant: SwayInstanceDef = {
      id: 1, kind: 'plant', root: [400, 700], height: 300, persp: 1, reach: 600,
      bbox: [300, 100, 500, 700], anchors: [[400, 400]],
    };
    const { sb, S } = build(plant);
    const w = resolveSceneWind({ direction: [-1, 0, 0], speed: 900, gust: { amount: 0.8, period: 7 } })!;
    for (let i = 1; i <= 600; i++) sb.update(w, i / 60);
    const rt = S.insts[0];
    let nearAnchor = -1, far = -1;
    for (let v = rt.v0; v < rt.v1; v++) {
      const d = Math.hypot(S.p0[v * 2] - 400, S.p0[v * 2 + 1] - 400);
      if (nearAnchor < 0 || d < Math.hypot(S.p0[nearAnchor * 2] - 400, S.p0[nearAnchor * 2 + 1] - 400)) nearAnchor = v;
      if (far < 0 || S.p0[v * 2 + 1] < S.p0[far * 2 + 1]) far = v;
    }
    const disp = (v: number) => Math.hypot(S.pos[v * 2] - S.p0[v * 2], S.pos[v * 2 + 1] - S.p0[v * 2 + 1]);
    const d0 = Math.hypot(S.p0[nearAnchor * 2] - 400, S.p0[nearAnchor * 2 + 1] - 400);
    // 离锚点最近的顶点位移只与它到锚点的距离成比例；最远处（梢）要明显大得多
    expect(disp(far)).toBeGreaterThan(1);
    // 若仍绕根（y=700）转，锚点处离支点 300、梢离支点 600，比值约 0.5；绕锚点转时比值只剩 d0/300 量级
    expect(disp(nearAnchor)).toBeLessThan(disp(far) * Math.max(d0, 1) / 150);
  });
});
