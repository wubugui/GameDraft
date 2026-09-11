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
  decodeDepthRG16Bytes,
  resampleFloatField,
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
