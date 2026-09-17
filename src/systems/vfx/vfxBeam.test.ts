/**
 * 光柱（体积光）的纯函数与模拟生命周期：
 * - 形状闸门（与 Python `vfx_beam.py` 同判据，那边的 parity 测试读本文件同一批用例的 JSON 金标）；
 * - 3D 棱台：片元求交用的半空间 ⇔ 局部坐标判"在不在里面"逐点一致（矩形 / 正多边形 × 张角 × 转角）；
 * - 视线取样段：按半空间闭式求出的 [qa, qb] 与沿视线逐点暴力判定一致（GLSL `bmEval3d` 同一算法）；
 * - 体积采样（尘埃出生）点都在里面；2D 光带同理；
 * - 亮度起伏确定性 / 取值范围；画面 ↔ 世界仿射可逆；
 * - 模拟：淡入淡出、stop 后淡完才算放完、光柱体积出生、锚点挪了帧跟着走、坏引用构造即抛；
 * - uniform 打包：3D 仿射 / 半空间、2D 深度面、全暗不画。
 */
import { describe, expect, it } from 'vitest';

import type { VfxBeamDef, VfxEffectDef } from '../../data/types';
import { createBeamUniformValues, packBeamUniforms } from '../../rendering/vfx/vfxBeamGlsl';
import type { Vec3 } from '../../utils/sceneSpace';
import {
  beam2dLocal, beam3dLocal, beamDefErrors, beamPulseFactor, convexHull2d, resolveBeam2dFrame, resolveBeam3dFrame,
  sampleBeam2dPoint, sampleBeam3dPoint, sceneQAffine, type VfxBeam3dFrame, type VfxBeamLocal,
} from './vfxBeam';
import { VfxRng } from './vfxRandom';
import { VfxInstanceSim, type VfxStepContext } from './vfxSim';
import { createPlanarVfxSpace, type VfxSpace } from './vfxSpace';

const rect3d = (over: Partial<VfxBeamDef> = {}): VfxBeamDef => ({
  id: 'window', mode: '3d',
  shape3d: { from: [0, 300, 0], to: [180, 0, 60], section: { kind: 'rect', width: 120, height: 40 }, spreadDeg: [12, 4], rollDeg: 17 },
  color: [1, 0.9, 0.7], intensity: 1.2,
  ...over,
});

const poly3d = (sides = 6): VfxBeamDef => ({
  id: 'hole', mode: '3d',
  shape3d: { to: [-40, -400, 90], section: { kind: 'polygon', sides, radius: 35 }, spreadDeg: [20, 0], rollDeg: -33 },
  color: [0.8, 0.9, 1], intensity: 2,
});

const band2d = (over: Partial<VfxBeamDef> = {}): VfxBeamDef => ({
  id: 'band', mode: '2d',
  shape2d: { from: [0, -200], to: [60, 0], width: [40, 160], occludeByDepth: true },
  color: [1, 1, 1], intensity: 1,
  ...over,
});

const loc = (): VfxBeamLocal => ({ t01: 0, u: 0, v: 0, edge: 0 });

function insideByPlanes(f: VfxBeam3dFrame, p: Vec3): boolean {
  for (let i = 0; i < f.planeCount; i++) {
    const o = i * 4;
    if (f.planes[o] * p[0] + f.planes[o + 1] * p[1] + f.planes[o + 2] * p[2] + f.planes[o + 3] > 1e-3) return false;
  }
  return true;
}

describe('光柱形状闸门', () => {
  it('合法的 3D 矩形 / 正多边形 / 2D 光带都过', () => {
    expect(beamDefErrors(rect3d())).toEqual([]);
    expect(beamDefErrors(poly3d(3))).toEqual([]);
    expect(beamDefErrors(poly3d(8))).toEqual([]);
    expect(beamDefErrors(band2d())).toEqual([]);
    expect(beamDefErrors(rect3d({
      colorEnd: [1, 0.5, 0], alongCurve: [[0, 0], [0.2, 1], [1, 0.4]], edgeSoftness: 0.2, thickness: 0.5,
      contactSoftWu: 30, blend: 'screen', sort: 'foreground', fadeIn: 1, fadeOut: 0,
      noise: { strength: 0.4, scaleWu: 180, velocity: [10, 20, 0] },
      cookie: { image: '/resources/runtime/images/vfx/lattice.png', strength: 0.8, scale: [2, 1], offset: [0.1, 0], rotationDeg: 5 },
      pulse: { kind: 'breathe', hz: 0.2, amount: 0.3 },
    }))).toEqual([]);
  });

  it('逐项拦：缺形状 / 边数越界 / 颜色越界 / 曲线不递增 / 图案缺图 / 起止重合', () => {
    expect(beamDefErrors({ ...rect3d(), shape3d: undefined }).join()).toContain('缺少 shape3d');
    expect(beamDefErrors(poly3d(9)).join()).toContain('sides');
    expect(beamDefErrors(poly3d(2)).join()).toContain('sides');
    expect(beamDefErrors(rect3d({ color: [1.2, 0, 0] })).join()).toContain('color');
    expect(beamDefErrors(rect3d({ alongCurve: [[0.5, 1], [0.2, 1]] })).join()).toContain('alongCurve');
    expect(beamDefErrors(rect3d({ cookie: { image: '' } })).join()).toContain('cookie.image');
    expect(beamDefErrors(rect3d({ shape3d: { to: [0, 0, 0], section: { kind: 'rect', width: 1, height: 1 } } })).join()).toContain('重合');
    expect(beamDefErrors(band2d({ shape2d: { to: [50, 0], width: [0, 0] } })).join()).toContain('width');
    expect(beamDefErrors(rect3d({ intensity: 30 })).join()).toContain('intensity');
    expect(beamDefErrors({ ...rect3d(), mode: 'volumetric' }).join()).toContain('mode');
  });
});

describe('3D 棱台几何', () => {
  const anchor: Vec3 = [500, 20, -300];
  const cases: [string, VfxBeamDef][] = [['矩形', rect3d()], ['三边', poly3d(3)], ['六边', poly3d(6)], ['八边', poly3d(8)]];

  it.each(cases)('%s：半空间判定与局部坐标判定逐点一致', (_n, def) => {
    const f = resolveBeam3dFrame(def.shape3d!, anchor)!;
    expect(f).not.toBeNull();
    const rng = new VfxRng(1234);
    const l = loc();
    let inside = 0;
    // 在光柱轴的包围盒附近撒点（体内体外都要有）
    const cx = f.origin[0] + f.axis[0] * f.length / 2, cy = f.origin[1] + f.axis[1] * f.length / 2;
    const cz = f.origin[2] + f.axis[2] * f.length / 2;
    const half = f.length / 2 + 80;
    for (let k = 0; k < 8000; k++) {
      const p: Vec3 = [
        cx + (rng.next() * 2 - 1) * half * 0.5,
        cy + (rng.next() * 2 - 1) * half,
        cz + (rng.next() * 2 - 1) * half * 0.5,
      ];
      const a = beam3dLocal(f, p[0], p[1], p[2], l);
      const b = insideByPlanes(f, p);
      // 边界上两边允许差一个极小容差
      if (Math.abs(l.edge) > 1e-3 && l.t01 > 1e-3 && l.t01 < 1 - 1e-3) expect(a).toBe(b);
      if (a) inside++;
    }
    expect(inside).toBeGreaterThan(20);
  });

  it.each(cases)('%s：截面顶点落在两端面上、边上（edge ≈ 0）', (_n, def) => {
    const f = resolveBeam3dFrame(def.shape3d!, anchor)!;
    const l = loc();
    for (let k = 0; k < f.corners.length / 3; k++) {
      const p = [f.corners[k * 3], f.corners[k * 3 + 1], f.corners[k * 3 + 2]] as Vec3;
      beam3dLocal(f, p[0], p[1], p[2], l);
      expect(Math.abs(l.edge)).toBeLessThan(1e-3);
      expect(Math.min(Math.abs(l.t01), Math.abs(l.t01 - 1))).toBeLessThan(1e-4);
    }
  });

  it('轴从起点指向终点、长度与截面基正交归一', () => {
    const f = resolveBeam3dFrame(rect3d().shape3d!, anchor)!;
    expect(f.length).toBeCloseTo(Math.hypot(180, -300, 60), 6);
    const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    expect(dot(f.axis, f.right)).toBeCloseTo(0, 6);
    expect(dot(f.axis, f.up)).toBeCloseTo(0, 6);
    expect(dot(f.right, f.up)).toBeCloseTo(0, 6);
    expect(Math.hypot(...f.right)).toBeCloseTo(1, 6);
    // 竖直光柱不退化
    const v = resolveBeam3dFrame({ to: [0, -300, 0], section: { kind: 'rect', width: 50, height: 50 } }, [0, 0, 0])!;
    expect(Math.hypot(...v.right)).toBeCloseTo(1, 6);
  });

  it('视线取样段：半空间闭式求交 == 沿视线逐点暴力判定（GLSL bmEval3d 同一算法）', () => {
    const space = createPlanarVfxSpace();
    const aff = sceneQAffine(space)!;
    for (const [, def] of cases) {
      const f = resolveBeam3dFrame(def.shape3d!, [0, 0, -800])!;
      const inv = aff.inv;
      const l = loc();
      let hits = 0;
      const rng = new VfxRng(99);
      for (let k = 0; k < 300; k++) {
        // 在光柱画面包络附近随机取画面点
        const c = Math.floor(rng.next() * (f.corners.length / 3));
        const w: Vec3 = [f.corners[c * 3], f.corners[c * 3 + 1], f.corners[c * 3 + 2]];
        const s = { x: 0, y: 0 };
        space.toScene(w, s);
        const sx = s.x + (rng.next() * 2 - 1) * 60, sy = s.y + (rng.next() * 2 - 1) * 60;
        const P0: Vec3 = [inv[0] * sx + inv[1] * sy + inv[3], inv[4] * sx + inv[5] * sy + inv[7], inv[8] * sx + inv[9] * sy + inv[11]];
        const d: Vec3 = [inv[2], inv[6], inv[10]];
        let qa = -1e20, qb = 1e20, empty = false;
        for (let i = 0; i < f.planeCount; i++) {
          const o = i * 4;
          const num = f.planes[o] * P0[0] + f.planes[o + 1] * P0[1] + f.planes[o + 2] * P0[2] + f.planes[o + 3];
          const den = f.planes[o] * d[0] + f.planes[o + 1] * d[1] + f.planes[o + 2] * d[2];
          if (Math.abs(den) < 1e-12) { if (num > 0) empty = true; continue; }
          const q = -num / den;
          if (den > 0) qb = Math.min(qb, q); else qa = Math.max(qa, q);
        }
        if (qb <= qa) empty = true;
        // 暴力：沿 q 扫一段
        let bruteA = Infinity, bruteB = -Infinity;
        for (let q = -3000; q <= 3000; q += 2) {
          const P: Vec3 = [P0[0] + d[0] * q, P0[1] + d[1] * q, P0[2] + d[2] * q];
          if (beam3dLocal(f, P[0], P[1], P[2], l)) { bruteA = Math.min(bruteA, q); bruteB = Math.max(bruteB, q); }
        }
        if (empty) {
          expect(bruteB - bruteA).toBeLessThan(6);
        } else if (qb - qa > 8) {
          hits++;
          expect(Math.abs(bruteA - qa)).toBeLessThan(3);
          expect(Math.abs(bruteB - qb)).toBeLessThan(3);
          // 取样段中点一定在体内
          const qm = 0.5 * (qa + qb);
          expect(beam3dLocal(f, P0[0] + d[0] * qm, P0[1] + d[1] * qm, P0[2] + d[2] * qm, l)).toBe(true);
        }
      }
      expect(hits).toBeGreaterThan(20);
    }
  });

  it('体积采样的点都在光柱里，且覆盖沿长度给定的那一段', () => {
    for (const [, def] of cases) {
      const f = resolveBeam3dFrame(def.shape3d!, anchor)!;
      const rng = new VfxRng(5);
      const out: Vec3 = [0, 0, 0];
      const l = loc();
      let tMin = 1, tMax = 0;
      for (let k = 0; k < 500; k++) {
        expect(sampleBeam3dPoint(f, () => rng.next(), [0.25, 0.75], out)).toBe(true);
        expect(beam3dLocal(f, out[0], out[1], out[2], l)).toBe(true);
        tMin = Math.min(tMin, l.t01); tMax = Math.max(tMax, l.t01);
      }
      expect(tMin).toBeGreaterThanOrEqual(0.25 - 1e-6);
      expect(tMax).toBeLessThanOrEqual(0.75 + 1e-6);
      expect(tMax - tMin).toBeGreaterThan(0.4);
    }
  });
});

describe('2D 光带', () => {
  it('局部坐标、采样、四角', () => {
    const f = resolveBeam2dFrame(band2d().shape2d!, { x: 300, y: 400 })!;
    expect(f.length).toBeCloseTo(Math.hypot(60, 200), 6);
    const l = loc();
    expect(beam2dLocal(f, 300, 200, l)).toBe(true);       // 起点中心
    expect(l.t01).toBeCloseTo(0, 6);
    expect(beam2dLocal(f, 360, 400, l)).toBe(true);       // 终点中心
    expect(l.t01).toBeCloseTo(1, 6);
    expect(beam2dLocal(f, 300 + f.nx * 30, 200 + f.ny * 30, l)).toBe(false); // 起点半宽只有 20
    const rng = new VfxRng(3);
    const p = { x: 0, y: 0 };
    for (let k = 0; k < 300; k++) {
      expect(sampleBeam2dPoint(f, () => rng.next(), [0, 1], p)).toBe(true);
      expect(beam2dLocal(f, p.x, p.y, l)).toBe(true);
    }
    for (let k = 0; k < 4; k++) {
      beam2dLocal(f, f.corners[k * 2], f.corners[k * 2 + 1], l);
      expect(Math.abs(l.edge)).toBeLessThan(1e-6);
    }
  });
});

describe('亮度起伏 / 仿射 / 凸包', () => {
  it('起伏确定、取值在 [1−amount, 1]；没配恒 1', () => {
    expect(beamPulseFactor(undefined, 3, 0.2)).toBe(1);
    for (const kind of ['flicker', 'breathe'] as const) {
      const p = { kind, hz: 3, amount: 0.4 };
      let lo = 1, hi = 0;
      for (let t = 0; t < 5; t += 0.013) {
        const v = beamPulseFactor(p, t, 0.37);
        expect(v).toBe(beamPulseFactor(p, t, 0.37));
        lo = Math.min(lo, v); hi = Math.max(hi, v);
      }
      expect(lo).toBeGreaterThanOrEqual(0.6 - 1e-9);
      expect(hi).toBeLessThanOrEqual(1 + 1e-9);
      expect(hi - lo).toBeGreaterThan(0.1);
    }
  });

  it('画面 ↔ (画面, q.z) 仿射可逆（planar 空间）', () => {
    const space = createPlanarVfxSpace(1.7);
    const a = sceneQAffine(space)!;
    const w: Vec3 = [123, 45, -678];
    const s = { x: 0, y: 0 };
    const q: Vec3 = [0, 0, 0];
    space.toScene(w, s); space.toQ(w, q);
    const inv = a.inv;
    const back = [0, 1, 2].map((r) => inv[r * 4] * s.x + inv[r * 4 + 1] * s.y + inv[r * 4 + 2] * q[2] + inv[r * 4 + 3]);
    expect(back[0]).toBeCloseTo(w[0], 6); expect(back[1]).toBeCloseTo(w[1], 6); expect(back[2]).toBeCloseTo(w[2], 6);
  });

  it('凸包只留外圈', () => {
    const pts = new Float32Array([0, 0, 10, 0, 10, 10, 0, 10, 5, 5, 2, 8]);
    const out = new Float32Array(32);
    expect(convexHull2d(pts, 6, out)).toBe(4);
  });
});

function ctx(time = 0): VfxStepContext {
  return { fields: [], contacts: [], player: null, time, wind: null, windTime: time, fires: [] };
}

function beamEffect(beams: VfxBeamDef[], dust = true): VfxEffectDef {
  return {
    id: 'shaft',
    emitters: dust ? [{
      id: 'dust',
      appearance: { image: '/x.png', sizeWu: 4, lit: false, blend: 'add', beamLit: { beam: beams[0].id } },
      spawn: { max: 60, burst: 60, shape: { kind: 'beam', beam: beams[0].id } },
      life: { seconds: [100, 100] },
    }] : [],
    beams,
  };
}

describe('模拟里的光柱', () => {
  const space: VfxSpace = createPlanarVfxSpace();

  it('淡入 → 保持 → stop 淡出；淡完之前不算放完', () => {
    const sim = new VfxInstanceSim('s', beamEffect([rect3d({ fadeIn: 0.5, fadeOut: 0.25 })], false), [0, 0, 0], 1, space);
    const b = sim.beams[0];
    expect(b.fade).toBe(0);
    expect(sim.state).toBe('active');
    sim.step(0.1, ctx());
    expect(b.fade).toBeCloseTo(0.2, 6);
    for (let i = 0; i < 10; i++) sim.step(0.1, ctx());
    expect(b.fade).toBe(1);
    sim.stop();
    expect(sim.state).toBe('inactive');
    sim.step(0.1, ctx());
    expect(b.fade).toBeCloseTo(0.6, 6);
    expect(sim.finished).toBe(false);
    expect(sim.beamsDark).toBe(false);
    sim.step(0.1, ctx()); sim.step(0.1, ctx());
    expect(b.fade).toBe(0);
    expect(sim.beamsDark).toBe(true);
    expect(sim.finished).toBe(true);
    sim.start();
    expect(sim.state).toBe('active');
  });

  it('fadeIn = 0 当拍到位', () => {
    const sim = new VfxInstanceSim('s', beamEffect([rect3d({ fadeIn: 0 })], false), [0, 0, 0], 1, space);
    sim.step(1 / 60, ctx());
    expect(sim.beams[0].fade).toBe(1);
  });

  it('尘埃「光柱体积」出生：3D 与 2D 光带里都落在光柱内；模拟确定', () => {
    for (const def of [rect3d(), poly3d(5), band2d()]) {
      const a = new VfxInstanceSim('a', beamEffect([def]), [200, 0, -500], 9, space);
      const b = new VfxInstanceSim('b', beamEffect([def]), [200, 0, -500], 9, space);
      a.step(1 / 60, ctx()); b.step(1 / 60, ctx());
      const e = a.emitters[0];
      expect(e.p.liveCount).toBeGreaterThan(30);
      const beam = a.beamFrame(a.beams[0]);
      const l = loc();
      const s = { x: 0, y: 0 };
      for (let i = 0; i < e.p.cap; i++) {
        if (!e.p.alive[i]) continue;
        expect(b.emitters[0].p.x[i]).toBe(e.p.x[i]);
        if (beam.frame3d) {
          expect(beam3dLocal(beam.frame3d, e.p.x[i], e.p.y[i], e.p.z[i], l)).toBe(true);
        } else {
          space.toScene([e.p.x[i], e.p.y[i], e.p.z[i]], s);
          expect(beam2dLocal(beam.frame2d!, s.x, s.y, l)).toBe(true);
        }
      }
    }
  });

  it('锚点挪了光柱帧跟着走；没挪不重算', () => {
    const sim = new VfxInstanceSim('s', beamEffect([rect3d()], false), [0, 0, 0], 1, space);
    const b = sim.beamFrame(sim.beams[0]);
    const f0 = b.frame3d!;
    expect(sim.beamFrame(b).frame3d).toBe(f0);
    sim.moveAnchor([100, 0, 50]);
    const f1 = sim.beamFrame(b).frame3d!;
    expect(f1).not.toBe(f0);
    expect(f1.origin[0] - f0.origin[0]).toBeCloseTo(100, 6);
    expect(f1.origin[2] - f0.origin[2]).toBeCloseTo(50, 6);
  });

  it('坏引用 / 坏光柱构造即抛', () => {
    const bad = beamEffect([rect3d()]);
    (bad.emitters[0].spawn.shape as { beam: string }).beam = 'nope';
    expect(() => new VfxInstanceSim('s', bad, [0, 0, 0], 1, space)).toThrow(/光柱「nope」不存在/);
    const bad2 = beamEffect([rect3d()]);
    bad2.emitters[0].appearance.beamLit = { beam: 'nope' };
    expect(() => new VfxInstanceSim('s', bad2, [0, 0, 0], 1, space)).toThrow(/被光柱照亮/);
    expect(() => new VfxInstanceSim('s', beamEffect([rect3d(), rect3d()], false), [0, 0, 0], 1, space)).toThrow(/重复/);
    expect(() => new VfxInstanceSim('s', beamEffect([poly3d(12)], false), [0, 0, 0], 1, space)).toThrow(/sides/);
  });
});

describe('光柱 uniform 打包', () => {
  const space = createPlanarVfxSpace();
  const env = (hasDepth = true) => ({
    affine: sceneQAffine(space), wuPerQ: space.wuPerQ, time: 2.5, hasDepth,
    uprightQz: (fx: number, fy: number, sx: number, sy: number) => {
      const w = space.uprightWorldAtScene!(fx, fy, sx, sy);
      const q: Vec3 = [0, 0, 0];
      space.toQ(w, q);
      return q[2];
    },
  });

  it('3D：仿射逆矩阵、半空间、截面、全暗不画', () => {
    const sim = new VfxInstanceSim('s', beamEffect([rect3d({ fadeIn: 0, blend: 'normal', alongCurve: [[0, 0], [1, 2]] })], false), [0, 0, 0], 1, space);
    sim.step(1 / 60, ctx());
    const b = sim.beamFrame(sim.beams[0]);
    const v = createBeamUniformValues();
    expect(packBeamUniforms(b, 0.5, env(), v)).toBe(true);
    expect(v.uBeamMode).toBe(0);
    expect(v.uBeamPlaneCount).toBe(6);
    expect(Array.from(v.uBeamPlanes.subarray(0, 24))).toEqual(Array.from(b.frame3d!.planes));
    expect(v.uBeamGain).toBeCloseTo(1.2 * 0.5, 6);
    expect(v.uBeamBlend).toBe(2);
    expect(v.uBeamAlongCount).toBe(2);
    expect(v.uBeamS2W0[3]).toBeCloseTo(sceneQAffine(space)!.inv[3], 6);
    b.fade = 0;
    expect(packBeamUniforms(b, 1, env(), v)).toBe(false);
  });

  it('2D：深度面 qz = a·sx + b·sy + c 与直立面逐点一致；没深度就关', () => {
    const sim = new VfxInstanceSim('s', beamEffect([band2d({ fadeIn: 0 })], false), [300, 0, -600], 1, space);
    sim.step(1 / 60, ctx());
    const b = sim.beamFrame(sim.beams[0]);
    const v = createBeamUniformValues();
    const e = env();
    expect(packBeamUniforms(b, 1, e, v)).toBe(true);
    expect(v.uBeamMode).toBe(1);
    expect(v.uBeamPlaneQ[3]).toBe(1);
    for (const [sx, sy] of [[300, 300], [350, 120], [10, 50]]) {
      const qz = v.uBeamPlaneQ[0] * sx + v.uBeamPlaneQ[1] * sy + v.uBeamPlaneQ[2];
      expect(qz).toBeCloseTo(e.uprightQz(b.foot.x, b.foot.y, sx, sy), 3);
    }
    expect(packBeamUniforms(b, 1, env(false), v)).toBe(true);
    expect(v.uBeamPlaneQ[3]).toBe(0);
  });
});
