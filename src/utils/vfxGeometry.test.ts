/**
 * 世界空间粒子的几何底座 ↔ 轨迹工作台 `geometry.py`（真相源）的跨语言金标。
 *
 * 金标由 scratchpad 的 `gen_vfx_geometry_golden.py` 用 `tools/trajectory_workbench/geometry.py`
 * + `tools/character_lighting_lab/scene_geometry.py` 对崖墓入口生成，内含 work 栅格的 ground_d
 * 与 128 宽的壳深度，所以这里不解 PNG。改 `groundHeightfield.ts` / `depthShellField.ts` 任一侧
 * 的数学，都要重生成金标再看这里红不红。
 */
import { describe, expect, it } from 'vitest';
import golden from './vfxGeometry.golden.json';
import {
  buildDepthShellField,
  decodeDepthShellField,
  decodeDepthRG16Bytes,
  resampleDepthBytes,
  resampleFloatField,
  sampleStrictShellSurface,
  shellContactAt,
  shellDepthWuAt,
  pushInFrontOfShell,
} from './depthShellField';
import { buildGroundHeightfield, groundHeightAt, groundNormalAt, groundObservedAt } from './groundHeightfield';
import type { SceneSpaceGeometry } from './sceneSpace';

interface Golden {
  scene: string;
  geo: {
    work: { w: number; h: number };
    cal: { ppu: number; cx: number; cy: number };
    sceneWorld: { w: number; h: number };
    basisRows: number[];
    wuPerQUnit: number;
  };
  ground: number[];
  heightfield: { n: number; x0: number; z0: number; dx: number; dz: number };
  shell: { w: number; h: number; cal: { ppu: number; cx: number; cy: number }; depth: number[]; normalSigma: number };
  groundCases: { wx: number; wz: number; y: number; normal: number[] }[];
  shellCases: { w: number[]; penWu: number; normal: number[]; px: number; py: number; groundLike: boolean }[];
}

const G = golden as unknown as Golden;

function geo(): SceneSpaceGeometry {
  return {
    work: G.geo.work,
    cal: G.geo.cal,
    sceneWorld: G.geo.sceneWorld,
    basisRows: G.geo.basisRows,
    wuPerQUnit: G.geo.wuPerQUnit,
    ground: { data: Float32Array.from(G.ground), w: G.geo.work.w, h: G.geo.work.h },
  };
}

describe('vfxGeometry · 金标不被掏空', () => {
  it('用例数量', () => {
    expect(G.groundCases.length).toBeGreaterThanOrEqual(30);
    expect(G.shellCases.length).toBeGreaterThanOrEqual(30);
    expect(G.ground.length).toBe(G.geo.work.w * G.geo.work.h);
    expect(G.shell.depth.length).toBe(G.shell.w * G.shell.h);
  });
});

describe('groundHeightfield ↔ geometry.py ground_height', () => {
  const hf = buildGroundHeightfield(geo(), G.heightfield.n);
  it('栅格参数逐位同（同一条栅格化）', () => {
    expect(hf.n).toBe(G.heightfield.n);
    // 金标里的 ground 四舍五入到 1e-6 q，乘 wuPerQUnit 后是 1e-3 wu 量级
    expect(hf.x0).toBeCloseTo(G.heightfield.x0, 2);
    expect(hf.z0).toBeCloseTo(G.heightfield.z0, 2);
    expect(hf.dx).toBeCloseTo(G.heightfield.dx, 4);
    expect(hf.dz).toBeCloseTo(G.heightfield.dz, 4);
  });
  for (const [i, c] of G.groundCases.entries()) {
    it(`地面高度 #${i}`, () => {
      expect(groundObservedAt(hf, c.wx, c.wz)).toBe(true);
      // 有观测格内两侧是同一条栅格化 + 双线性；float32 存储 vs float64 差在 1e-3 wu 量级
      expect(groundHeightAt(hf, c.wx, c.wz)).toBeCloseTo(c.y, 2);
    });
  }
  it('地面法线：九成用例 2° 内，全部 8° 内', () => {
    // 有限差分 eps=4 wu 比格距（约 8 wu）还小，法线实际是采样点所在格的双线性斜率——邻格若是补洞格，
    // EDT 最近（Python）与 4 邻域扩散（TS）填的值不同，斜率就差；高度本身在有观测格内逐位同。
    let within2 = 0;
    for (const c of G.groundCases) {
      const n = groundNormalAt(hf, c.wx, c.wz);
      const dot = n[0] * c.normal[0] + n[1] * c.normal[1] + n[2] * c.normal[2];
      expect(dot).toBeGreaterThan(Math.cos((8.0 * Math.PI) / 180));
      if (dot > Math.cos((2.0 * Math.PI) / 180)) within2++;
    }
    expect(within2 / G.groundCases.length).toBeGreaterThanOrEqual(0.9);
  });
});

describe('depthShellField ↔ scene_geometry.Scene.geometry + shell_contact', () => {
  const g = geo();
  const shell = buildDepthShellField(
    Float32Array.from(G.shell.depth), G.shell.w, G.shell.h, G.shell.cal, g.basisRows, G.shell.normalSigma,
  );
  it('法线整体朝相机一侧、地面像素朝上', () => {
    let up = 0;
    for (let i = 0; i < shell.w * shell.h; i++) if (shell.normal[i * 3 + 1] > 0.6) up++;
    expect(up).toBeGreaterThan(shell.w * shell.h * 0.2);
  });
  for (const [i, c] of G.shellCases.entries()) {
    it(`壳接触 #${i}${c.groundLike ? '(地)' : '(墙)'}`, () => {
      const r = shellContactAt(shell, g, c.w[0], c.w[1], c.w[2]);
      expect(r).not.toBeNull();
      expect(r!.px).toBeCloseTo(c.px, 6);
      expect(r!.py).toBeCloseTo(c.py, 6);
      expect(r!.penWu).toBeCloseTo(c.penWu, 2);
      expect(r!.groundLike).toBe(c.groundLike);
      const dot = r!.normal[0] * c.normal[0] + r!.normal[1] * c.normal[1] + r!.normal[2] * c.normal[2];
      // 高斯核的 reflect 边界与 float32 累积：允许 1° 内
      expect(dot).toBeGreaterThan(Math.cos((1.0 * Math.PI) / 180));
    });
  }
  it('推到壳前 = 深度差恰为 margin', () => {
    const c = G.shellCases[0];
    const p = pushInFrontOfShell(shell, g, [c.w[0], c.w[1], c.w[2]], 10);
    const r = shellContactAt(shell, g, p[0], p[1], p[2]);
    expect(r).not.toBeNull();
    expect(r!.penWu).toBeCloseTo(-10, 3);
    const d = shellDepthWuAt(shell, g, c.w[0], c.w[1], c.w[2]);
    expect(d).not.toBeNull();
  });
});

describe('解码与重采样', () => {
  it('RG16 解码与 ground_d 同式（invert 翻 t）', () => {
    expect(decodeDepthRG16Bytes(0, 0, { invert: false, scale: 2, offset: -1 })).toBeCloseTo(-1, 9);
    expect(decodeDepthRG16Bytes(255, 255, { invert: false, scale: 2, offset: -1 })).toBeCloseTo(1, 9);
    expect(decodeDepthRG16Bytes(255, 255, { invert: true, scale: 2, offset: -1 })).toBeCloseTo(-1, 9);
  });
  it('盒平均缩小：常数场不变、线性场取中值', () => {
    const src = new Float32Array(8 * 4);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 8; x++) src[y * 8 + x] = x;
    const out = resampleFloatField(src, 8, 4, 4, 2);
    expect(out.length).toBe(8);
    expect(out[0]).toBeCloseTo(0.5, 9);
    expect(out[3]).toBeCloseTo(6.5, 9);
  });
});

describe('精确可见壳采样（不影响碰撞壳）', () => {
  const basis = { basisRows: [1, 0, 0, 0, 1, 0, 0, 0, 1], wuPerQUnit: 20 };
  const cal = { ppu: 10, cx: 4, cy: 4 };
  const direct = (value: (x: number, y: number) => number) => {
    const depth = new Float32Array(9 * 9);
    for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) depth[y * 9 + x] = value(x, y);
    return buildDepthShellField(depth, 9, 9, cal, basis.basisRows);
  };
  const rgbaOf = (w: number, h: number, raw: (x: number, y: number) => number) => {
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, v = raw(x, y);
      out[i] = v >> 8; out[i + 1] = v & 255; out[i + 3] = 255;
    }
    return out;
  };

  it('点在未平滑平面上，面积按世界单位缩放，竖直世界面仍可采', () => {
    const f = direct((x, y) => 1 + x * 0.02 + y * 0.01);
    const s = sampleStrictShellSurface(f, basis, 4, 4)!;
    expect(s).not.toBeNull();
    expect(s.p[0]).toBe(0); expect(s.p[1]).toBe(0);
    expect(s.p[2]).toBeCloseTo(22.4, 5);
    expect(s.areaWu2).toBeCloseTo(4 * Math.sqrt(1 + 0.2 ** 2 + 0.1 ** 2), 5);
    expect(Math.hypot(...s.normal)).toBeCloseTo(1, 10);
    expect(s.normal[2]).toBeLessThan(0);
    const larger = sampleStrictShellSurface(f, { ...basis, wuPerQUnit: 40 }, 4, 4)!;
    expect(larger.areaWu2 / s.areaWu2).toBeCloseTo(4, 9);
    const wall = sampleStrictShellSurface(direct(() => 1), basis, 4, 4)!;
    expect(wall.normal[1]).toBeCloseTo(0, 10);
    expect(wall.areaWu2).toBeCloseTo(4, 9);
  });

  it('PNG 取真实源像素中心，深度图与背景不同长宽比也不借另一套标定', () => {
    const srcW = 25, srcH = 31;
    const rgba = rgbaOf(srcW, srcH, (x, y) => 10000 + 31 * x + 53 * y);
    const mapping = { invert: false, scale: 1, offset: 0 };
    const f = decodeDepthShellField(rgba, srcW, srcH, 24, 18, mapping,
      { ppu: 30, cx: 12, cy: 9 }, basis.basisRows, 8);
    const s = sampleStrictShellSurface(f, basis, 3, 2)!;
    expect(s).not.toBeNull();
    const sx = Math.floor(3.5 * srcW / f.w), sy = Math.floor(2.5 * srcH / f.h);
    expect(s.px).toBeCloseTo((sx + 0.5) / srcW * f.w, 6);
    expect(s.py).toBeCloseTo((sy + 0.5) / srcH * f.h, 6);
    expect(s.p[2]).toBeCloseTo((10000 + 31 * sx + 53 * sy) / 65535 * basis.wuPerQUnit, 6);
    expect(f.data).toEqual(resampleDepthBytes(rgba, srcW, srcH, mapping, f.w, f.h));
    const legacy = buildDepthShellField(f.data, f.w, f.h, f.cal, basis.basisRows);
    expect(f.normal).toEqual(legacy.normal);
  });

  it('源图足迹中的细小前景会拒绝采样，不让盒平均制造悬空表面', () => {
    const rgba = rgbaOf(24, 24, (x, y) => x === 9 && y === 10 ? 65535 : 1000);
    const f = decodeDepthShellField(rgba, 24, 24, 24, 24,
      { invert: false, scale: 20, offset: 0 }, { ppu: 30, cx: 12, cy: 12 }, basis.basisRows, 8);
    expect(f.data[3 * f.w + 3]).toBeGreaterThan(f.surfaceSamples!.data[3 * f.w + 3]);
    expect(sampleStrictShellSurface(f, basis, 3, 3)).toBeNull();
    expect(sampleStrictShellSurface(f, basis, 6, 6)).not.toBeNull();
  });

  it('边缘、非法格点、非有限源值和深度断层都不钳制到合法点', () => {
    const f = direct(() => 1);
    for (const [x, y] of [[0, 4], [8, 4], [-1, 4], [4, 9], [4.5, 4], [NaN, 4]]) {
      expect(sampleStrictShellSurface(f, basis, x, y)).toBeNull();
    }
    expect(sampleStrictShellSurface(direct((x) => x < 4 ? 1 : 30), basis, 4, 4)).toBeNull();
    expect(sampleStrictShellSurface(direct((x, y) => x === 4 && y === 4 ? NaN : 1), basis, 4, 4)).toBeNull();
    expect(sampleStrictShellSurface(f, { ...basis, wuPerQUnit: 0 }, 4, 4)).toBeNull();
    expect(sampleStrictShellSurface(f, { ...basis, basisRows: new Array(9).fill(0) }, 4, 4)).toBeNull();
    delete f.surfaceSamples;
    expect(sampleStrictShellSurface(f, basis, 4, 4)).toBeNull();
  });
});
