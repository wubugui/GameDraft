/**
 * 角色间接光 E(n) 的 **CPU 版**：与 `CharacterShadingFilter` 的 `probeE` / `skyaoAt` 逐行同式
 * （查询沿法线偏置、三线性 + 有效性权重、A7 折叠、八面体接缝环绕、L1 Geomerics / 线性 SH、
 * 无有效 probe 时回落 ambIrr、skyao 除 cap0 再与全白 blend）。
 *
 * 用途：接触 AO 方向部分要与角色身上看到的间接光**同一份**（制作人 2026-09-24：「ao 方向本来就
 * 和间接光强度要一致」）。probe 本身缺朝相机侧的信息（A7 折叠补的），间接光吃的是这份，
 * 影子也吃这份 —— 缺得一致，就不会出现"人被照的方向与影子倒的方向对不上"。
 *
 * ⚠ 改 GLSL 那边任何一步都要改这里（`probeCpuSampler.test.ts` 用手搭载荷钉了逐步口径）。
 * 输出只取亮度（与 shader 的 luma 同系数）：AO 只要"多少光、从哪来"，不要颜色。
 */

/** probe 查表的全部输入。字段与 `CharShadingSceneResources` / frameLit uniform 一一对应。 */
export interface ProbeCpuData {
  /** 当前 mode 的固化图集，(P, nCol, 4) f16 */
  atlas: Uint16Array;
  nCol: number;
  /** 每颗 probe 的有效性（>0 = 有效，≡ GLSL step(.002, valid.r)） */
  valid: Uint8Array;
  pn: readonly [number, number, number];
  wMin: readonly [number, number, number];
  wScale: readonly [number, number, number];
  /** probe 网格的 q→world，**列主序**（GL mat3 布局，lighting.json 的 det=−1 那套） */
  mCol: ArrayLike<number>;
  /** 1 = L1 Geomerics，2 = 线性 SH（L2/L4），其余 = 八面体 */
  mode: number;
  shK: number;
  binOb: number;
  fold: boolean;
  /** 27 = 9 × rgb */
  ambSH: ArrayLike<number>;
  ambStrength: number;
  skyao: {
    /** 按 Z 切片横向平铺的 rgba16f 图集（a0, a1x, a1y, a1z） */
    data: Uint16Array;
    width: number;
    n: readonly [number, number, number];
    tiles: readonly [number, number];
    wMin: readonly [number, number, number];
    wScale: readonly [number, number, number];
    /** q→world，列主序，**depthConfig 的 det=+1**（不是 mCol 那套） */
    mCol: ArrayLike<number>;
  } | null;
  skyaoBlend: number;
}

const LUMA = [0.2126, 0.7152, 0.0722] as const;

/** IEEE half → number（与 GPU 读 RGBA16F 同值）。 */
const F16 = (() => {
  const t = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const s = h & 0x8000 ? -1 : 1;
    const e = (h >> 10) & 31;
    const m = h & 1023;
    t[h] = e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
  }
  return t;
})();

const clamp = (x: number, a: number, b: number): number => Math.max(a, Math.min(b, x));

/** 实球谐基 l ≤ 4，与 GLSL shY 逐行同值同序。 */
function shY(k: number, x: number, y: number, z: number): number {
  switch (k) {
    case 0: return 0.282095;
    case 1: return 0.488603 * y;
    case 2: return 0.488603 * z;
    case 3: return 0.488603 * x;
    case 4: return 1.092548 * x * y;
    case 5: return 1.092548 * y * z;
    case 6: return 0.315392 * (3 * z * z - 1);
    case 7: return 1.092548 * x * z;
    case 8: return 0.546274 * (x * x - y * y);
    default: break;
  }
  const x2 = x * x, y2 = y * y, z2 = z * z;
  switch (k) {
    case 9: return 0.590044 * y * (3 * x2 - y2);
    case 10: return 2.890611 * x * y * z;
    case 11: return 0.457046 * y * (5 * z2 - 1);
    case 12: return 0.373176 * z * (5 * z2 - 3);
    case 13: return 0.457046 * x * (5 * z2 - 1);
    case 14: return 1.445306 * z * (x2 - y2);
    case 15: return 0.590044 * x * (x2 - 3 * y2);
    case 16: return 2.503343 * x * y * (x2 - y2);
    case 17: return 1.770131 * y * z * (3 * x2 - y2);
    case 18: return 0.946175 * x * y * (7 * z2 - 1);
    case 19: return 0.669047 * y * z * (7 * z2 - 3);
    case 20: return 0.105786 * (35 * z2 * z2 - 30 * z2 + 3);
    case 21: return 0.669047 * x * z * (7 * z2 - 3);
    case 22: return 0.473087 * (x2 - y2) * (7 * z2 - 1);
    case 23: return 1.770131 * x * z * (x2 - 3 * y2);
    default: return 0.625836 * (x2 * x2 - 6 * x2 * y2 + y2 * y2);
  }
}

const AMB_A = [3.141593, 2.094395, 2.094395, 2.094395, 0.785398, 0.785398, 0.785398, 0.785398, 0.785398];

/** GLSL ambIrr 的亮度。 */
function ambIrrY(d: ProbeCpuData, x: number, y: number, z: number): number {
  let r = 0, g = 0, b = 0;
  for (let k = 0; k < 9; k++) {
    const s = AMB_A[k] * shY(k, x, y, z);
    r += d.ambSH[k * 3] * s; g += d.ambSH[k * 3 + 1] * s; b += d.ambSH[k * 3 + 2] * s;
  }
  return (LUMA[0] * Math.max(r, 0) + LUMA[1] * Math.max(g, 0) + LUMA[2] * Math.max(b, 0)) * d.ambStrength;
}

/** GLSL octaIdx：八面体接缝环绕。 */
function octaIdx(cx: number, cy: number, ob: number): number {
  if (cx < 0) { cx = 0; cy = ob - 1 - cy; } else if (cx > ob - 1) { cx = ob - 1; cy = ob - 1 - cy; }
  if (cy < 0) { cy = 0; cx = ob - 1 - cx; } else if (cy > ob - 1) { cy = ob - 1; cx = ob - 1 - cx; }
  return cy * ob + cx;
}

const rgbTmp = [0, 0, 0];

/** GLSL probeEvalFlat（含 probeQueryN 折叠）→ rgbTmp。n 为 q 基。 */
function evalFlat(d: ProbeCpuData, flat: number, nx: number, ny: number, nz: number): void {
  if (d.fold && nz < 0) nz = -nz;
  const l = Math.hypot(nx, ny, nz) || 1;
  nx /= l; ny /= l; nz /= l;
  const A = d.atlas, nCol = d.nCol;
  if (d.mode === 1) {
    const base = flat * nCol * 4;
    for (let ch = 0; ch < 3; ch++) {
      const c0 = F16[A[base + ch]], c1 = F16[A[base + 4 + ch]], c2 = F16[A[base + 8 + ch]], c3 = F16[A[base + 12 + ch]];
      const R0 = Math.max(c0 * 0.282095, 1e-12);
      const rx = 0.5 * 0.488603 * c3, ry = 0.5 * 0.488603 * c1, rz = 0.5 * 0.488603 * c2;
      const lenR1 = Math.hypot(rx, ry, rz) + 1e-12;
      const q = clamp(0.5 * (1 + (rx * nx + ry * ny + rz * nz) / lenR1), 0, 1);
      const r = Math.min(lenR1 / R0, 0.9999);
      const p = 1 + 2 * r;
      const a = (1 - r) / (1 + r);
      rgbTmp[ch] = Math.max(R0 * (a + (1 - a) * (p + 1) * q ** p), 0);
    }
    return;
  }
  if (d.mode === 2) {
    let r = 0, g = 0, b = 0;
    for (let k = 0; k < d.shK; k++) {
      const s = shY(k, nx, ny, nz);
      const o = (flat * nCol + k) * 4;
      r += F16[A[o]] * s; g += F16[A[o + 1]] * s; b += F16[A[o + 2]] * s;
    }
    rgbTmp[0] = Math.max(r, 0); rgbTmp[1] = Math.max(g, 0); rgbTmp[2] = Math.max(b, 0);
    return;
  }
  // 八面体（GLSL octaEnc + 双线性 + 接缝环绕）
  const ob = d.binOb;
  const s = Math.abs(nx) + Math.abs(ny) + Math.abs(nz);
  const ex = nx / s, ey = ny / s, ez = nz / s;
  let px = ex, py = ey;
  if (ez < 0) {
    px = (1 - Math.abs(ey)) * (ex >= 0 ? 1 : -1);
    py = (1 - Math.abs(ex)) * (ey >= 0 ? 1 : -1);
  }
  const ux = (px * 0.5 + 0.5) * ob - 0.5, uy = (py * 0.5 + 0.5) * ob - 0.5;
  const x0 = Math.floor(ux), y0 = Math.floor(uy);
  const fx = clamp(ux - x0, 0, 1), fy = clamp(uy - y0, 0, 1);
  const i00 = (flat * nCol + octaIdx(x0, y0, ob)) * 4, i10 = (flat * nCol + octaIdx(x0 + 1, y0, ob)) * 4;
  const i01 = (flat * nCol + octaIdx(x0, y0 + 1, ob)) * 4, i11 = (flat * nCol + octaIdx(x0 + 1, y0 + 1, ob)) * 4;
  for (let ch = 0; ch < 3; ch++) {
    const a = F16[A[i00 + ch]] + (F16[A[i10 + ch]] - F16[A[i00 + ch]]) * fx;
    const b = F16[A[i01 + ch]] + (F16[A[i11 + ch]] - F16[A[i01 + ch]]) * fx;
    rgbTmp[ch] = Math.max(a + (b - a) * fy, 0);
  }
}

/** GLSL probeE 的亮度。q、n 都是 q 基（n 不必归一）。 */
export function probeEY(d: ProbeCpuData, q: readonly number[], nx: number, ny: number, nz: number): number {
  const l = Math.hypot(nx, ny, nz) || 1;
  const bias = 0.525 * Math.min(1 / d.wScale[0], 1 / d.wScale[1], 1 / d.wScale[2]);
  const qx = q[0] + (nx / l) * bias, qy = q[1] + (ny / l) * bias, qz = q[2] + (nz / l) * bias;
  const M = d.mCol;
  const X0 = M[0] * qx + M[3] * qy + M[6] * qz;
  const X1 = M[1] * qx + M[4] * qy + M[7] * qz;
  const X2 = M[2] * qx + M[5] * qy + M[8] * qz;
  const [n0, n1, n2] = d.pn;
  const t0 = clamp((X0 - d.wMin[0]) * d.wScale[0], 0, n0 - 1.001);
  const t1 = clamp((X1 - d.wMin[1]) * d.wScale[1], 0, n1 - 1.001);
  const t2 = clamp((X2 - d.wMin[2]) * d.wScale[2], 0, n2 - 1.001);
  const b0 = Math.floor(t0), b1 = Math.floor(t1), b2 = Math.floor(t2);
  const f0 = t0 - b0, f1 = t1 - b1, f2 = t2 - b2;
  let sum = 0, wsum = 0;
  for (let c = 0; c < 8; c++) {
    const o0 = c & 1, o1 = (c >> 1) & 1, o2 = (c >> 2) & 1;
    const p0 = Math.min(b0 + o0, n0 - 1), p1 = Math.min(b1 + o1, n1 - 1), p2 = Math.min(b2 + o2, n2 - 1);
    let w = (o0 ? f0 : 1 - f0) * (o1 ? f1 : 1 - f1) * (o2 ? f2 : 1 - f2);
    const flat = p0 * (n1 * n2) + p1 * n2 + p2;
    if (!(d.valid[flat] > 0)) w = 0;
    if (w < 1e-5) continue;
    evalFlat(d, flat, nx, ny, nz);
    sum += (LUMA[0] * rgbTmp[0] + LUMA[1] * rgbTmp[1] + LUMA[2] * rgbTmp[2]) * w;
    wsum += w;
  }
  if (wsum < 1e-4) return ambIrrY(d, nx / l, ny / l, nz / l);
  return sum / wsum;
}

/** GLSL skyaoAt：天穹遮蔽 V ∈ [0,1]，无载荷恒 1。q、n 为 q 基。 */
export function skyaoV(d: ProbeCpuData, q: readonly number[], nx: number, ny: number, nz: number): number {
  const S = d.skyao;
  if (!S) return 1;
  const M = S.mCol;
  const X = [
    M[0] * q[0] + M[3] * q[1] + M[6] * q[2],
    M[1] * q[0] + M[4] * q[1] + M[7] * q[2],
    M[2] * q[0] + M[5] * q[1] + M[8] * q[2],
  ];
  const f = [0, 0, 0], lo = [0, 0, 0], hi = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const vp = clamp((X[i] - S.wMin[i]) * S.wScale[i], 0, 1) * (S.n[i] - 1);
    const v0 = Math.floor(vp);
    f[i] = clamp(vp - v0, 0, 1);
    lo[i] = clamp(v0, 0, S.n[i] - 1);
    hi[i] = clamp(v0 + 1, 0, S.n[i] - 1);
  }
  const tap = (x: number, y: number, z: number, c: number): number => {
    const tx = z % S.tiles[0], ty = Math.floor(z / S.tiles[0]);
    return F16[S.data[((ty * S.n[1] + y) * S.width + (tx * S.n[0] + x)) * 4 + c]];
  };
  const m = [0, 0, 0, 0];
  for (let c = 0; c < 4; c++) {
    const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
    const a = lerp(lerp(tap(lo[0], lo[1], lo[2], c), tap(hi[0], lo[1], lo[2], c), f[0]),
      lerp(tap(lo[0], hi[1], lo[2], c), tap(hi[0], hi[1], lo[2], c), f[0]), f[1]);
    const b = lerp(lerp(tap(lo[0], lo[1], hi[2], c), tap(hi[0], lo[1], hi[2], c), f[0]),
      lerp(tap(lo[0], hi[1], hi[2], c), tap(hi[0], hi[1], hi[2], c), f[0]), f[1]);
    m[c] = lerp(a, b, f[2]);
  }
  let wx = M[0] * nx + M[3] * ny + M[6] * nz;
  let wy = M[1] * nx + M[4] * ny + M[7] * nz;
  let wz = M[2] * nx + M[5] * ny + M[8] * nz;
  const l = Math.hypot(wx, wy, wz) || 1;
  wx /= l; wy /= l; wz /= l;
  const cap = Math.max((1 + wy) * 0.5, 1 / 255);
  return clamp((m[0] + m[1] * wx + m[2] * wy + m[3] * wz) / cap, 0, 1);
}

/** 角色间接光在 q 点、q 基法线 n 处的亮度：probeE × mix(1, skyao, blend)，与 CharacterLitSprite 同式。 */
export function indirectEY(d: ProbeCpuData, q: readonly number[], nx: number, ny: number, nz: number): number {
  const e = probeEY(d, q, nx, ny, nz);
  const b = clamp(d.skyaoBlend, 0, 1);
  return b > 0 && d.skyao ? e * (1 + (skyaoV(d, q, nx, ny, nz) - 1) * b) : e;
}
