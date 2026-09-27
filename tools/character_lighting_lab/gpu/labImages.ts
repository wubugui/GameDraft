/**
 * 角色照明实验室 · 纯工具视图的逐像素图（CPU；打进实验室的包，命名空间 `labImages`）。
 *
 * 这些画面游戏里没有对应效果（HDR 恢复辐射 / 增益热力 / EV 分带 / 标定深度的背景视图，底部三张 HDR 缩略图），
 * 迁到 RHI 时不再为它们写着色器：像素在 CPU 上逐个算好、交给引擎当普通贴图画（或直接进 2D 画布），**没有第二份 shader**。
 * 式子逐行照搬迁移前 `viewer/app.js` 里的 BG_FS / THUMB_FS / HDR_RECOVER（那是实验室自己的算子，不是游戏的），
 * 采样照 GL `LINEAR` + `CLAMP_TO_EDGE` 在像素中心双线性取（与旧着色器取样位置相同），深度视图照 `texelFetch` 逐 work 像素取。
 */

export const LUMA_R = 0.2126;
export const LUMA_G = 0.7152;
export const LUMA_B = 0.0722;

/** sRGB → 线性（逐通道，0..1） */
export function srgb2lin(c: number): number {
  return c >= 0.04045 ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92;
}

/** 线性 → sRGB（逐通道；负数先钳 0） */
export function lin2srgb(c: number): number {
  c = Math.max(c, 0);
  return c >= 0.0031308 ? 1.055 * Math.pow(c, 1 / 2.4) - 0.055 : c * 12.92;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

const RAMP: readonly (readonly number[])[] = [[0.06, 0.06, 0.24], [0.16, 0.35, 0.78], [0.12, 0.78, 0.82], [0.9, 0.86, 0.16], [0.86, 0.16, 0.12]];
const HEAT: readonly (readonly number[])[] = [[0.03, 0.03, 0.08], [0.5, 0.06, 0.5], [0.95, 0.35, 0.05], [1, 0.95, 0.6]];

/** 蓝 → 青 → 黄 → 红 色带（旧 BG_FS::ramp；GLSL 的 int(t) 截断 + 末段钳在 3） */
export function ramp(t: number, out: number[] = [0, 0, 0]): number[] {
  t = clamp01(t) * 4;
  const i = Math.min(3, Math.floor(t));
  const f = t - Math.floor(t);
  const a = RAMP[i], b = RAMP[i + 1];
  // GLSL: t==4 时 i=4、落到"其余"分支（mix(s3,s4,f) 且 f=0）= s3 —— 与 i=3,f=1 的 s4 不同；照旧着色器
  if (t >= 4) { out[0] = RAMP[3][0]; out[1] = RAMP[3][1]; out[2] = RAMP[3][2]; return out; }
  for (let c = 0; c < 3; c++) out[c] = a[c] + (b[c] - a[c]) * f;
  return out;
}

/** 黑 → 紫 → 橙 → 米色热力（旧 THUMB_FS::heat） */
export function heat(t: number, out: number[] = [0, 0, 0]): number[] {
  t = clamp01(t) * 3;
  const i = Math.floor(t);
  const f = t - i;
  if (i >= 3) { out[0] = HEAT[2][0]; out[1] = HEAT[2][1]; out[2] = HEAT[2][2]; return out; }
  const a = HEAT[i], b = HEAT[i + 1];
  for (let c = 0; c < 3; c++) out[c] = a[c] + (b[c] - a[c]) * f;
  return out;
}

/** 亮度分层：按 1EV 一带上色 + 层界黑线，显示区间 [-8, 6] EV，≥6 洋红 = 撞顶（旧 BG_FS::zone） */
export function zone(ev: number, out: number[] = [0, 0, 0]): number[] {
  const b = Math.max(-8, Math.min(6, ev));
  ramp((b + 8) / 14, out);
  if (ev >= 6) { out[0] = 1; out[1] = 0.15; out[2] = 0.9; }
  const f = b - Math.floor(b);
  const edge = 1 - smoothstep(0, 0.1, Math.min(f, 1 - f));
  const k = 1 + (0.12 - 1) * edge;
  out[0] *= k; out[1] *= k; out[2] *= k;
  return out;
}

export interface HdrParams {
  /** 0 emitter 门 / 1 逆 Reinhard / 2 全局 gamma / 3 亮度扩展 */
  method: number;
  /** HDR 最大 EV（滑条实时值） */
  maxGain: number;
  /** 方法参数 */
  pa: number;
}

/** LDR→HDR 恢复（旧 HDR_RECOVER::hdrRad）；base 是线性 rgb，g01 = gain 场 */
export function hdrRad(base: readonly number[], g01: number, p: HdrParams, out: number[] = [0, 0, 0]): number[] {
  const L = Math.max(base[0] * LUMA_R + base[1] * LUMA_G + base[2] * LUMA_B, 1e-5);
  const m = p.method;
  if (m < 0.5) {
    const k = Math.pow(2, g01 * p.maxGain);
    for (let c = 0; c < 3; c++) out[c] = base[c] * k;
  } else if (m < 1.5) {
    const k = clamp01(Math.min(Math.max(p.pa, 0), 0.985));
    const d = Math.max(1 - k * L, 0.015);
    for (let c = 0; c < 3; c++) out[c] = base[c] / d;
  } else if (m < 2.5) {
    const g = 1 + (0.34 - 1) * clamp01(p.pa);
    const k = Math.pow(2, p.maxGain * 0.12);
    for (let c = 0; c < 3; c++) out[c] = Math.pow(Math.max(base[c], 0), g) * k;
  } else {
    const lo = Math.max(0, Math.min(0.9, p.pa));
    const e = smoothstep(lo, Math.min(lo + 0.35, 1), L);
    const k = 1 + (Math.pow(2, p.maxGain) - 1) * e;
    for (let c = 0; c < 3; c++) out[c] = base[c] * k;
  }
  return out;
}

/** 一张 RGBA8 图（自上而下） */
export interface Rgba {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

/** GL LINEAR + CLAMP_TO_EDGE：在目标像素中心 (x+.5, y+.5)/(W, H) 处双线性取源图的一个通道（0..1） */
function bilinearSampler(src: Rgba, W: number, H: number) {
  const sw = src.width, sh = src.height, d = src.data;
  const kx = sw / W, ky = sh / H;
  return (x: number, y: number, ch: number): number => {
    let fx = (x + 0.5) * kx - 0.5;
    let fy = (y + 0.5) * ky - 0.5;
    fx = Math.max(0, Math.min(sw - 1, fx));
    fy = Math.max(0, Math.min(sh - 1, fy));
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1);
    const tx = fx - x0, ty = fy - y0;
    const a = d[(y0 * sw + x0) * 4 + ch], b = d[(y0 * sw + x1) * 4 + ch];
    const e = d[(y1 * sw + x0) * 4 + ch], f = d[(y1 * sw + x1) * 4 + ch];
    return ((a * (1 - tx) + b * tx) * (1 - ty) + (e * (1 - tx) + f * tx) * ty) / 255;
  };
}

/** 背景视图：1 HDR 恢复辐射 / 2 HDR 增益热力 / 3 标定深度 / 4 亮度分层；0 = 原画 × 预览亮度 */
export type BgViewMode = 0 | 1 | 2 | 3 | 4;

export interface BgViewInput extends HdrParams {
  mode: BgViewMode;
  /** 输出尺寸（画布逻辑像素；标定深度视图忽略它、按 depth 的 work 尺寸出图） */
  width: number;
  height: number;
  bg: Rgba;
  gain: Rgba;
  /** 标定深度（work 分辨率 float，行优先） */
  depth?: { data: Float32Array; w: number; h: number } | null;
  /** 预览亮度（线性倍率） */
  pgain: number;
}

/** 旧 BG_FS 逐像素（不含编辑叠加层：那是另一张不预乘的精灵，叠在它上面）。返回 RGBA8 与尺寸。 */
export function bgViewPixels(inp: BgViewInput): Rgba {
  const out3 = [0, 0, 0], base = [0, 0, 0], rad = [0, 0, 0], col = [0, 0, 0];
  const put = (o: Uint8ClampedArray, i: number, r: number, g: number, b: number) => {
    o[i] = Math.round(clamp01(r) * 255); o[i + 1] = Math.round(clamp01(g) * 255); o[i + 2] = Math.round(clamp01(b) * 255); o[i + 3] = 255;
  };
  if (inp.mode === 3) {
    const d = inp.depth;
    if (!d) return { width: 1, height: 1, data: new Uint8ClampedArray([0, 0, 0, 255]) };
    const o = new Uint8ClampedArray(d.w * d.h * 4);
    for (let i = 0; i < d.w * d.h; i++) {
      const v = d.data[i] * 0.35;
      ramp(v - Math.floor(v), col);
      put(o, i * 4, lin2srgb(srgb2lin(col[0]) * inp.pgain), lin2srgb(srgb2lin(col[1]) * inp.pgain), lin2srgb(srgb2lin(col[2]) * inp.pgain));
    }
    return { width: d.w, height: d.h, data: o };
  }
  const W = Math.max(1, Math.round(inp.width)), H = Math.max(1, Math.round(inp.height));
  const bgAt = bilinearSampler(inp.bg, W, H);
  const gainAt = bilinearSampler(inp.gain, W, H);
  const o = new Uint8ClampedArray(W * H * 4);
  const exact = inp.bg.width === W && inp.bg.height === H;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (exact) { col[0] = inp.bg.data[i] / 255; col[1] = inp.bg.data[i + 1] / 255; col[2] = inp.bg.data[i + 2] / 255; } else {
        col[0] = bgAt(x, y, 0); col[1] = bgAt(x, y, 1); col[2] = bgAt(x, y, 2);
      }
      if (inp.mode === 1 || inp.mode === 4 || inp.mode === 2) {
        for (let c = 0; c < 3; c++) base[c] = srgb2lin(col[c]);
        hdrRad(base, gainAt(x, y, 0), inp, rad);
      }
      if (inp.mode === 1) {
        put(o, i, lin2srgb(rad[0] * inp.pgain), lin2srgb(rad[1] * inp.pgain), lin2srgb(rad[2] * inp.pgain));
        continue;
      }
      if (inp.mode === 4) {
        const ev = Math.log2(Math.max(rad[0] * LUMA_R + rad[1] * LUMA_G + rad[2] * LUMA_B, 1e-6));
        zone(ev, out3);
        put(o, i, lin2srgb(out3[0]), lin2srgb(out3[1]), lin2srgb(out3[2]));
        continue;
      }
      if (inp.mode === 2) {
        const lb = Math.max(base[0] * LUMA_R + base[1] * LUMA_G + base[2] * LUMA_B, 1e-5);
        const lr = Math.max(rad[0] * LUMA_R + rad[1] * LUMA_G + rad[2] * LUMA_B, 1e-5);
        const g = clamp01(Math.log2(lr / lb) / Math.max(inp.maxGain, 1e-3));
        ramp(g, out3);
        const k = smoothstep(0.02, 0.25, g);
        for (let c = 0; c < 3; c++) col[c] = col[c] + (out3[c] - col[c]) * k;
      }
      put(o, i, lin2srgb(srgb2lin(col[0]) * inp.pgain), lin2srgb(srgb2lin(col[1]) * inp.pgain), lin2srgb(srgb2lin(col[2]) * inp.pgain));
    }
  }
  return { width: W, height: H, data: o };
}

export interface ThumbInput extends HdrParams {
  width: number;
  height: number;
  bg: Rgba;
  gain: Rgba;
  /** SAM3 语义 mask（没有 = 旧场景 / 未开语义门控：光源图退回 HDR 提升量热力） */
  mask: Rgba | null;
}

/**
 * 底部三张常驻缩略图（旧 THUMB_FS + 旧 refreshThumbs 的 CPU 辉光）：0 = HDR 场景（Reinhard + 超出量扩散成暖光晕）、
 * 1 = 光源分割（emit = rad × 语义 mask，log 压缩热力）、2 = 当前方法的逐像素提升 EV / 最大 EV。
 */
export function thumbPixels(inp: ThumbInput): [Rgba, Rgba, Rgba] {
  const W = Math.max(1, Math.round(inp.width)), H = Math.max(1, Math.round(inp.height));
  const bgAt = bilinearSampler(inp.bg, W, H);
  const gainAt = bilinearSampler(inp.gain, W, H);
  const maskAt = inp.mask ? bilinearSampler(inp.mask, W, H) : null;
  const imgs = [0, 1, 2].map(() => new Uint8ClampedArray(W * H * 4));
  const base = [0, 0, 0], rad = [0, 0, 0], h3 = [0, 0, 0];
  const q = (v: number) => Math.round(clamp01(v) * 255);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) base[c] = srgb2lin(bgAt(x, y, c));
      hdrRad(base, gainAt(x, y, 0), inp, rad);
      // 0：Reinhard 全动态范围；alpha = HDR 超出量（随 HDR 最大 EV 缩放，给辉光用）
      const o0 = imgs[0];
      for (let c = 0; c < 3; c++) o0[i + c] = q(lin2srgb(rad[c] / (rad[c] + 1)));
      const excess = (Math.max(rad[0] - 1, 0) + Math.max(rad[1] - 1, 0) + Math.max(rad[2] - 1, 0)) * 0.333;
      o0[i + 3] = q(Math.log(1 + excess) * 0.28);
      // 1：光源分割
      const m = maskAt ? maskAt(x, y, 0) : 0;
      let e = 0;
      for (let c = 0; c < 3; c++) {
        const emit = maskAt ? rad[c] * m : Math.max(rad[c] - base[c], 0);
        e += emit * (c === 0 ? LUMA_R : c === 1 ? LUMA_G : LUMA_B);
      }
      heat(Math.log2(1 + e * 4) * 0.5, h3);
      const o1 = imgs[1];
      o1[i] = q(h3[0]); o1[i + 1] = q(h3[1]); o1[i + 2] = q(h3[2]); o1[i + 3] = 255;
      // 2：提升场
      const lb = base[0] * LUMA_R + base[1] * LUMA_G + base[2] * LUMA_B;
      const lr = rad[0] * LUMA_R + rad[1] * LUMA_G + rad[2] * LUMA_B;
      const lift = Math.log2(Math.max(lr, 1e-5) / Math.max(lb, 1e-5));
      heat(clamp01(lift / Math.max(inp.maxGain, 1e-3)), h3);
      const o2 = imgs[2];
      o2[i] = q(h3[0]); o2[i + 1] = q(h3[1]); o2[i + 2] = q(h3[2]); o2[i + 3] = 255;
    }
  }
  // HDR 图加辉光：提升集中在极少数灯芯像素，把超出量（alpha）两趟分离盒糊扩散成暖光晕（旧 refreshThumbs 原样）
  const img = imgs[0];
  const N = W * H, br = new Float32Array(N), tmp = new Float32Array(N);
  for (let i = 0; i < N; i++) br[i] = img[i * 4 + 3] / 255;
  const R = 4;
  const blur = (s: Float32Array, d: Float32Array) => {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let a = 0, c = 0;
      for (let k = -R; k <= R; k++) { const xx = x + k; if (xx >= 0 && xx < W) { a += s[y * W + xx]; c++; } }
      d[y * W + x] = a / c;
    }
    for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) {
      let a = 0, c = 0;
      for (let k = -R; k <= R; k++) { const yy = y + k; if (yy >= 0 && yy < H) { a += d[yy * W + x]; c++; } }
      s[y * W + x] = a / c;
    }
  };
  blur(br, tmp); blur(br, tmp);
  for (let i = 0; i < N; i++) {
    const g = Math.min(1, br[i] * 6) * 230;
    img[i * 4] = Math.min(255, img[i * 4] + g);
    img[i * 4 + 1] = Math.min(255, img[i * 4 + 1] + g * 0.85);
    img[i * 4 + 2] = Math.min(255, img[i * 4 + 2] + g * 0.55);
    img[i * 4 + 3] = 255;
  }
  return imgs.map((data) => ({ width: W, height: H, data })) as [Rgba, Rgba, Rgba];
}

// ─────────────────────────────────────────────────────────── 3D 视图的几何（CPU）

/**
 * 实验室重建网格（`mesh_verts.bin`：每顶点 16 字节 = xyz f32 + rgb u8 + 分层 tag u8）按层拆成三份贴图网格
 * （顶点 = xyz + uv 交错 5 float，3D 调试件 `createMesh({vertices, indices})` 原样吃）：
 * uv = 世界 → q（Mᵀ）→ 画面（cx + q.x·ppu, cy − q.y·ppu）/ work，钳在 [0, 1]——旧 MESH_FS 在片元里逐像素算的就是它，
 * q 与 uv 对世界坐标都是线性的，逐顶点算再插值与逐像素算相同（只有出画那一圈的钳位是逐顶点近似）。
 * 三角形按**第一个顶点**的 tag 归层（0 可见壳 / 1 补全层 / 2 地面延拓）；三个顶点 tag 不一致的三角形计数返回。
 */
export function meshLayers(verts: ArrayBuffer, idx: ArrayBuffer, M: number[][],
  cal: { ppu: number; cx: number; cy: number }, work: { w: number; h: number }):
  { layers: { vertices: Float32Array; indices: Uint32Array }[]; mixed: number } {
  const f32 = new Float32Array(verts);
  const u8 = new Uint8Array(verts);
  const n = Math.floor(verts.byteLength / 16);
  const v5 = new Float32Array(n * 5);
  const tag = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const X = f32[i * 4], Y = f32[i * 4 + 1], Z = f32[i * 4 + 2];
    const qx = M[0][0] * X + M[1][0] * Y + M[2][0] * Z;
    const qy = M[0][1] * X + M[1][1] * Y + M[2][1] * Z;
    v5[i * 5] = X; v5[i * 5 + 1] = Y; v5[i * 5 + 2] = Z;
    v5[i * 5 + 3] = clamp01((cal.cx + qx * cal.ppu) / work.w);
    v5[i * 5 + 4] = clamp01((cal.cy - qy * cal.ppu) / work.h);
    tag[i] = u8[i * 16 + 15];
  }
  const ind = new Uint32Array(idx);
  const per: number[][] = [[], [], []];
  let mixed = 0;
  for (let t = 0; t + 2 < ind.length; t += 3) {
    const a = ind[t], b = ind[t + 1], c = ind[t + 2];
    const k = tag[a];
    if (tag[b] !== k || tag[c] !== k) mixed++;
    if (k < 3) per[k].push(a, b, c);
  }
  return { layers: per.map((p) => ({ vertices: v5, indices: Uint32Array.from(p) })), mixed };
}

/** 地面延拓层的贴图：旧 MESH_FS 的 `mix(c, (.2,.5,.3), .30)`（sRGB 空间），逐像素预先调好 */
export function tintGround(src: Rgba): Rgba {
  const o = new Uint8ClampedArray(src.data.length);
  const g = [0.2, 0.5, 0.3];
  for (let i = 0; i < o.length; i += 4) {
    for (let c = 0; c < 3; c++) o[i + c] = Math.round(clamp01(src.data[i + c] / 255 * 0.7 + g[c] * 0.3) * 255);
    o[i + 3] = 255;
  }
  return { width: src.width, height: src.height, data: o };
}

/**
 * 旧 P3_FS / MESH_FS 的预览亮度：`pow(pow(c, 2.2) × g, 1/2.2)` = `c × g^(1/2.2)`（c ≥ 0）——sRGB 空间里是一个乘法，
 * 所以 3D 调试件的「贴图 × 颜色」倍率就能表达（帧缓冲同样钳在 1）。
 */
export function previewTint(gain: number): number {
  return Math.pow(Math.max(gain, 0), 1 / 2.2);
}

/** 经纬球（给全景贴图）：半径 r、以 (0,0,0) 为心，uv 与旧 PANO_FS / ⑥面板同一套经纬展开（u 绕竖轴、u=.5 朝 −z，v 从 +y 到 −y） */
export function latLongSphere(r: number, cols = 64, rows = 32): { vertices: Float32Array; indices: Uint32Array } {
  const v: number[] = [];
  for (let j = 0; j <= rows; j++) {
    const vv = j / rows, th = Math.PI * vv, st = Math.sin(th);
    for (let i = 0; i <= cols; i++) {
      const uu = i / cols, psi = 2 * Math.PI * (uu - 0.5);
      v.push(r * st * Math.sin(psi), r * Math.cos(th), -r * st * Math.cos(psi), uu, vv);
    }
  }
  const ind: number[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = j * (cols + 1) + i, b = a + 1, c = a + cols + 1, d = c + 1;
      ind.push(a, c, b, b, c, d);
    }
  }
  return { vertices: Float32Array.from(v), indices: Uint32Array.from(ind) };
}
