/**
 * 世界 XZ 地面高度场：把行走面深度场 `ground_d`（画面栅格）反投影成 M-world 的 XZ → Y。
 *
 * 与轨迹工作台 `tools/trajectory_workbench/geometry.py` 的 `SceneGeometry._heightfield /
 * ground_height / ground_normal` 同式（栅格化 + 补洞 + 双线性），两侧由 `vfxGeometry.golden.json`
 * 钉住。群体模拟要问"这只蝙蝠脚下的地面在哪"，画面点 → 地面点那条（`sceneSpace.groundWorldAt`）
 * 回答不了"世界 XZ 处的地面"——一个世界点的画面投影在墙上时采到的是墙那一列的地面深度，
 * 而不是它正下方的地面。
 *
 * 补洞：`geometry.py` 用 `scipy.ndimage.distance_transform_edt` 取最近有值格；这里用多轮
 * 4 邻域扩散取最近格（曼哈顿距离最近而非欧氏最近）。两者在有值区内逐位相同，只在洞里
 * 可能挑到不同的邻格——金标只比有值区与洞的边缘一格之内。
 */
import type { SceneSpaceGeometry } from './sceneSpace';
import { wrQToWorldRow, wrQx, wrQy } from './worldReconstruct';

export interface GroundHeightfield {
  n: number;
  x0: number;
  z0: number;
  dx: number;
  dz: number;
  /** `n×n`，行 = z，列 = x；地面 Y（wu） */
  hf: Float32Array;
  /** 有观测的格（补洞前） */
  observed: Uint8Array;
  bounds: [number, number, number, number];
}

export const GROUND_HEIGHTFIELD_N = 256;

/** 从 `SceneSpaceGeometry`（work 栅格的行走面场 + 标定 + 基）建高度场。 */
export function buildGroundHeightfield(geo: SceneSpaceGeometry, n = GROUND_HEIGHTFIELD_N): GroundHeightfield {
  const { ground, cal, basisRows: r, wuPerQUnit: k } = geo;
  const { w, h, data } = ground;
  const X = new Float64Array(w * h), Y = new Float64Array(w * h), Z = new Float64Array(w * h);
  let xMin = Infinity, xMax = -Infinity, zMin = Infinity, zMax = -Infinity;
  for (let py = 0; py < h; py++) {
    const qy = wrQy(py, cal.ppu, cal.cy);
    for (let px = 0; px < w; px++) {
      const qx = wrQx(px, cal.ppu, cal.cx);
      const qz = data[py * w + px];
      const i = py * w + px;
      X[i] = wrQToWorldRow(r[0], r[1], r[2], qx, qy, qz) * k;
      Y[i] = wrQToWorldRow(r[3], r[4], r[5], qx, qy, qz) * k;
      Z[i] = wrQToWorldRow(r[6], r[7], r[8], qx, qy, qz) * k;
      if (X[i] < xMin) xMin = X[i];
      if (X[i] > xMax) xMax = X[i];
      if (Z[i] < zMin) zMin = Z[i];
      if (Z[i] > zMax) zMax = Z[i];
    }
  }
  const dx = Math.max((xMax - xMin) / (n - 1), 1e-6);
  const dz = Math.max((zMax - zMin) / (n - 1), 1e-6);
  const acc = new Float64Array(n * n);
  const cnt = new Float64Array(n * n);
  for (let i = 0; i < X.length; i++) {
    const ix = Math.max(0, Math.min(n - 1, Math.round((X[i] - xMin) / dx)));
    const iz = Math.max(0, Math.min(n - 1, Math.round((Z[i] - zMin) / dz)));
    acc[iz * n + ix] += Y[i];
    cnt[iz * n + ix] += 1;
  }
  const hf = new Float32Array(n * n);
  const observed = new Uint8Array(n * n);
  let holes = 0;
  for (let i = 0; i < n * n; i++) {
    if (cnt[i] > 0) { hf[i] = acc[i] / cnt[i]; observed[i] = 1; } else { hf[i] = NaN; holes++; }
  }
  if (holes > 0) fillHolesNearest(hf, n, n);
  return { n, x0: xMin, z0: zMin, dx, dz, hf, observed, bounds: [xMin, xMax, zMin, zMax] };
}

/** 多轮 4 邻域扩散补 NaN：每轮把所有"至少有一个已知邻居"的洞填成邻居均值（按已知邻居数平均）。 */
function fillHolesNearest(a: Float32Array, w: number, h: number): void {
  let pending = 0;
  for (let i = 0; i < a.length; i++) if (Number.isNaN(a[i])) pending++;
  const next = new Float32Array(a.length);
  let guard = 0;
  while (pending > 0 && guard++ < w + h) {
    next.set(a);
    let filled = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!Number.isNaN(a[i])) continue;
        let s = 0, c = 0;
        if (x > 0 && !Number.isNaN(a[i - 1])) { s += a[i - 1]; c++; }
        if (x < w - 1 && !Number.isNaN(a[i + 1])) { s += a[i + 1]; c++; }
        if (y > 0 && !Number.isNaN(a[i - w])) { s += a[i - w]; c++; }
        if (y < h - 1 && !Number.isNaN(a[i + w])) { s += a[i + w]; c++; }
        if (c > 0) { next[i] = s / c; filled++; }
      }
    }
    a.set(next);
    pending -= filled;
    if (filled === 0) break;
  }
  // 全空（不可能：至少有一个观测）——兜底填 0
  for (let i = 0; i < a.length; i++) if (Number.isNaN(a[i])) a[i] = 0;
}

function bilinear(a: Float32Array, w: number, h: number, px: number, py: number): number {
  const xi = Math.max(0, Math.min(w - 1.001, px));
  const yi = Math.max(0, Math.min(h - 1.001, py));
  const x0 = Math.floor(xi), y0 = Math.floor(yi);
  const fx = xi - x0, fy = yi - y0;
  const i00 = y0 * w + x0;
  return a[i00] * (1 - fx) * (1 - fy) + a[i00 + 1] * fx * (1 - fy)
    + a[i00 + w] * (1 - fx) * fy + a[i00 + w + 1] * fx * fy;
}

/** 世界 XZ → 地面 Y（wu）。场外钳到边缘。 */
export function groundHeightAt(hf: GroundHeightfield, wx: number, wz: number): number {
  return bilinear(hf.hf, hf.n, hf.n, (wx - hf.x0) / hf.dx, (wz - hf.z0) / hf.dz);
}

/** 地面法线（有限差分，单位向量，+Y 为主）。 */
export function groundNormalAt(hf: GroundHeightfield, wx: number, wz: number, eps = 4): [number, number, number] {
  const gx = (groundHeightAt(hf, wx + eps, wz) - groundHeightAt(hf, wx - eps, wz)) / (2 * eps);
  const gz = (groundHeightAt(hf, wx, wz + eps) - groundHeightAt(hf, wx, wz - eps)) / (2 * eps);
  const nx = -gx, ny = 1, nz = -gz;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

/** 世界 XZ 是否在有观测的地面范围内（不含补洞区）。 */
export function groundObservedAt(hf: GroundHeightfield, wx: number, wz: number): boolean {
  const ix = Math.round((wx - hf.x0) / hf.dx);
  const iz = Math.round((wz - hf.z0) / hf.dz);
  if (ix < 0 || iz < 0 || ix >= hf.n || iz >= hf.n) return false;
  return hf.observed[iz * hf.n + ix] === 1;
}
