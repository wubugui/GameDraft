/**
 * 深度壳（`raw_depth_rg.png`）的 **CPU 侧**场：解码 → 降采样 → 世界法线 → 壳接触查询。
 *
 * ## 为什么要有 CPU 侧的壳
 *
 * 运行时此前只把深度壳当 GPU 纹理用（逐像素遮挡）。世界空间粒子 / 群体模拟要在 M-world
 * 里"撞墙"——蝙蝠不能穿进崖壁——所以要能在 CPU 里问："这个世界点在可见壳前面还是后面、
 * 壳在这里朝哪边"。这份数学与轨迹工作台 `tools/trajectory_workbench/geometry.py` 的
 * `SceneGeometry.shell_contact` / `scene_geometry.Scene.geometry` 同式（那边是烘抛体轨迹时
 * 撞墙用的），两侧由 `vfxGeometry.golden.json` 钉住同一组用例。
 *
 * ## 栅格与标定（别混，见 coordinate-spaces）
 *
 * 壳的像素栅格是**背景原生分辨率**按横向缩放到 `targetW`（缺省 512）的等效栅格，标定
 * `cal = depthConfig.M × s`（`s = targetW / native_w`）——与 `scene_geometry.Scene.geometry(size)`
 * 一致。它**不是**照明载荷的 work 栅格（`meta.cal`）：两者比例逐场景不同（实测 1.95–4.0），
 * 只是恰好在多数场景都是 512 宽。所以本文件的查询一律**走自己的 `cal`**，不借
 * `SceneSpaceGeometry.cal`。
 *
 * 深度图与背景可能不同尺寸（实测 2048×1152 对 2048×1143）：深度图按**归一化 uv** 铺满
 * 背景（GPU 遮挡滤镜也是这么采的），解码时按目标栅格重采样。
 *
 * 单位：`data` 是伪世界 q 深度（与 `ground_d` 同尺）；`penWu` 等长度量已乘 `wuPerQUnit`，是 wu。
 */
import { wrQToWorldRow, wrQx, wrQxToPx, wrQy, wrQyToPx } from './worldReconstruct';

export type Vec3 = [number, number, number];

export interface DepthShellCal {
  ppu: number;
  cx: number;
  cy: number;
}

export interface DepthShellField {
  /** 壳深度（q），行优先，`w×h` */
  data: Float32Array;
  w: number;
  h: number;
  /** 本栅格的标定（native 标定 × 缩放） */
  cal: DepthShellCal;
  /** 每像素世界法线（M-world，单位向量，朝相机一侧），`w×h×3` */
  normal: Float32Array;
  /** 深度范围（诊断用） */
  dMin: number;
  dMax: number;
}

/** 世界点相对壳的关系（`geometry.py shell_contact` 的 TS 版） */
export interface ShellContact {
  /** > 0 = 在壳后面（沿视线的深度差，wu） */
  penWu: number;
  /** 该像素的世界法线 */
  normal: Vec3;
  /** 壳栅格像素坐标 */
  px: number;
  py: number;
  /** 法线朝上（y > 0.6）：这种像素的碰撞交给地面高度场 */
  groundLike: boolean;
}

/** q ↔ M-world 所需的基（与 `SceneSpaceGeometry` 同名字段，可直接传它） */
export interface ShellBasis {
  basisRows: ArrayLike<number>;
  wuPerQUnit: number;
}

export interface DepthMapping {
  invert: boolean;
  scale: number;
  offset: number;
}

/** RG16 字节 → q 深度（与 `scene_geometry.Scene.__init__` 同式）。 */
export function decodeDepthRG16Bytes(r: number, g: number, mapping: DepthMapping): number {
  let t = (r * 256 + g) / 65535;
  if (mapping.invert) t = 1 - t;
  return t * mapping.scale + mapping.offset;
}

/** 双线性采样（越界钳到场内），与 `groundDepthField.sampleGroundField` 同式。 */
export function sampleShellDepth(f: DepthShellField, px: number, py: number): number {
  const { data, w, h } = f;
  const xi = Math.max(0, Math.min(w - 1.001, px));
  const yi = Math.max(0, Math.min(h - 1.001, py));
  const x0 = Math.floor(xi), y0 = Math.floor(yi);
  const fx = xi - x0, fy = yi - y0;
  const i00 = y0 * w + x0;
  return data[i00] * (1 - fx) * (1 - fy) + data[i00 + 1] * fx * (1 - fy)
    + data[i00 + w] * (1 - fx) * fy + data[i00 + w + 1] * fx * fy;
}

/**
 * 把一张 RGBA 字节图（深度 PNG 解码后的 `ImageData.data`）重采样成目标栅格的 q 深度场。
 *
 * `srcW/srcH` 是深度图像素尺寸；目标栅格 `w×h` 按归一化 uv 采样（双线性，采样点在像素中心），
 * 所以深度图与背景尺寸不一致也能对齐——GPU 遮挡滤镜用的就是归一化 uv。
 */
export function resampleDepthBytes(
  rgba: Uint8Array | Uint8ClampedArray,
  srcW: number,
  srcH: number,
  mapping: DepthMapping,
  w: number,
  h: number,
): Float32Array {
  // 先整图解码成 float（一次 mapping），再重采样：mapping 是仿射，先后顺序不影响结果，
  // 但先解码能让重采样只做一种插值。
  const src = new Float32Array(srcW * srcH);
  for (let i = 0; i < src.length; i++) src[i] = decodeDepthRG16Bytes(rgba[i * 4], rgba[i * 4 + 1], mapping);
  return resampleFloatField(src, srcW, srcH, w, h);
}

/**
 * 浮点场重采样到 `w×h`。缩小时按**盒平均**（每个目标像素覆盖的源像素求均值），放大时双线性。
 * 与 PIL `resize(BILINEAR)` 缩小时的抗混叠口径一致（PIL 缩小时的 bilinear 是带支撑扩展的
 * 三角滤波，盒平均是它的近似；金标里容差按此留）。
 */
export function resampleFloatField(src: Float32Array, srcW: number, srcH: number, w: number, h: number): Float32Array {
  if (srcW === w && srcH === h) return src.slice();
  const out = new Float32Array(w * h);
  const sx = srcW / w, sy = srcH / h;
  if (sx >= 1 && sy >= 1) {
    for (let y = 0; y < h; y++) {
      const y0 = y * sy, y1 = (y + 1) * sy;
      const iy0 = Math.floor(y0), iy1 = Math.min(srcH, Math.ceil(y1));
      for (let x = 0; x < w; x++) {
        const x0 = x * sx, x1 = (x + 1) * sx;
        const ix0 = Math.floor(x0), ix1 = Math.min(srcW, Math.ceil(x1));
        let acc = 0, wsum = 0;
        for (let yy = iy0; yy < iy1; yy++) {
          const wy = Math.min(y1, yy + 1) - Math.max(y0, yy);
          if (wy <= 0) continue;
          const row = yy * srcW;
          for (let xx = ix0; xx < ix1; xx++) {
            const wx = Math.min(x1, xx + 1) - Math.max(x0, xx);
            if (wx <= 0) continue;
            acc += src[row + xx] * wx * wy;
            wsum += wx * wy;
          }
        }
        out[y * w + x] = wsum > 0 ? acc / wsum : 0;
      }
    }
    return out;
  }
  for (let y = 0; y < h; y++) {
    const fy = Math.max(0, Math.min(srcH - 1.001, (y + 0.5) * sy - 0.5));
    const iy = Math.floor(fy), ty = fy - iy;
    for (let x = 0; x < w; x++) {
      const fx = Math.max(0, Math.min(srcW - 1.001, (x + 0.5) * sx - 0.5));
      const ix = Math.floor(fx), tx = fx - ix;
      const i00 = iy * srcW + ix;
      out[y * w + x] = src[i00] * (1 - tx) * (1 - ty) + src[i00 + 1] * tx * (1 - ty)
        + src[i00 + srcW] * (1 - tx) * ty + src[i00 + srcW + 1] * tx * ty;
    }
  }
  return out;
}

/**
 * 可分离高斯（scipy `gaussian_filter` 同口径：`truncate=4`，边界 reflect）。
 * 对 `w×h×c` 的交错数组逐通道滤波。
 */
function gaussianBlurInterleaved(a: Float32Array, w: number, h: number, c: number, sigma: number): Float32Array {
  if (!(sigma > 0)) return a.slice();
  const radius = Math.floor(4 * sigma + 0.5);
  const k = new Float64Array(2 * radius + 1);
  let ksum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + radius] = v;
    ksum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= ksum;
  // scipy 'reflect' 模式：(d c b a | a b c d | d c b a)
  const reflect = (i: number, n: number): number => {
    if (n === 1) return 0;
    const period = 2 * n;
    let m = ((i % period) + period) % period;
    if (m >= n) m = period - 1 - m;
    return m;
  };
  const tmp = new Float32Array(a.length);
  // 横向
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let ch = 0; ch < c; ch++) {
        let acc = 0;
        for (let i = -radius; i <= radius; i++) {
          const xs = reflect(x + i, w);
          acc += a[(y * w + xs) * c + ch] * k[i + radius];
        }
        tmp[(y * w + x) * c + ch] = acc;
      }
    }
  }
  const out = new Float32Array(a.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let ch = 0; ch < c; ch++) {
        let acc = 0;
        for (let i = -radius; i <= radius; i++) {
          const ys = reflect(y + i, h);
          acc += tmp[(ys * w + x) * c + ch] * k[i + radius];
        }
        out[(y * w + x) * c + ch] = acc;
      }
    }
  }
  return out;
}

/**
 * 由壳深度算每像素世界法线（`scene_geometry.Scene.geometry` 同式）：
 * `pos = R·q` → 高斯平滑 → `np.gradient`（内部中心差分、边缘单侧）→ `n = cross(dpos/dy, dpos/dx)`
 * → 背向视线（`R·(0,0,1)`）的翻转 → 归一化。`normalSigma` 缺省按 `max(0.8, 0.8·w/640)`。
 */
export function computeShellNormals(
  depth: Float32Array,
  w: number,
  h: number,
  cal: DepthShellCal,
  basisRows: ArrayLike<number>,
  normalSigma?: number,
): Float32Array {
  const r = basisRows;
  const sigma = normalSigma ?? Math.max(0.8, 0.8 * (w / 640));
  const pos = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const qy = wrQy(y, cal.ppu, cal.cy);
    for (let x = 0; x < w; x++) {
      const qx = wrQx(x, cal.ppu, cal.cx);
      const qz = depth[y * w + x];
      const o = (y * w + x) * 3;
      pos[o] = wrQToWorldRow(r[0], r[1], r[2], qx, qy, qz);
      pos[o + 1] = wrQToWorldRow(r[3], r[4], r[5], qx, qy, qz);
      pos[o + 2] = wrQToWorldRow(r[6], r[7], r[8], qx, qy, qz);
    }
  }
  const ps = gaussianBlurInterleaved(pos, w, h, 3, sigma);
  const vx = wrQToWorldRow(r[0], r[1], r[2], 0, 0, 1);
  const vy = wrQToWorldRow(r[3], r[4], r[5], 0, 0, 1);
  const vz = wrQToWorldRow(r[6], r[7], r[8], 0, 0, 1);
  const out = new Float32Array(w * h * 3);
  const dx = [0, 0, 0], dy = [0, 0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // np.gradient：内部 (f[i+1]-f[i-1])/2，边缘 f[1]-f[0] / f[n-1]-f[n-2]
      const xl = x > 0 ? x - 1 : 0, xr = x < w - 1 ? x + 1 : w - 1;
      const yl = y > 0 ? y - 1 : 0, yr = y < h - 1 ? y + 1 : h - 1;
      const kx = (xr - xl) || 1, ky = (yr - yl) || 1;
      for (let ch = 0; ch < 3; ch++) {
        dx[ch] = (ps[(y * w + xr) * 3 + ch] - ps[(y * w + xl) * 3 + ch]) / kx;
        dy[ch] = (ps[(yr * w + x) * 3 + ch] - ps[(yl * w + x) * 3 + ch]) / ky;
      }
      // n = cross(dy, dx)
      let nx = dy[1] * dx[2] - dy[2] * dx[1];
      let ny = dy[2] * dx[0] - dy[0] * dx[2];
      let nz = dy[0] * dx[1] - dy[1] * dx[0];
      if (nx * vx + ny * vy + nz * vz > 0) { nx = -nx; ny = -ny; nz = -nz; }
      const len = Math.max(Math.hypot(nx, ny, nz), 1e-6);
      const o = (y * w + x) * 3;
      out[o] = nx / len; out[o + 1] = ny / len; out[o + 2] = nz / len;
    }
  }
  return out;
}

/** 从已解码的深度场建壳（法线一并算好）。 */
export function buildDepthShellField(
  depth: Float32Array,
  w: number,
  h: number,
  cal: DepthShellCal,
  basisRows: ArrayLike<number>,
  normalSigma?: number,
): DepthShellField {
  let dMin = Infinity, dMax = -Infinity;
  for (let i = 0; i < depth.length; i++) {
    const v = depth[i];
    if (v < dMin) dMin = v;
    if (v > dMax) dMax = v;
  }
  return {
    data: depth, w, h, cal,
    normal: computeShellNormals(depth, w, h, cal, basisRows, normalSigma),
    dMin, dMax,
  };
}

/**
 * 从深度 PNG 的 RGBA 字节建壳：目标栅格宽 `targetW`（缺省 512，与照明载荷/工作台同宽），
 * 高按背景原生长宽比；标定 = native 标定 × `targetW / nativeW`。
 */
export function decodeDepthShellField(
  rgba: Uint8Array | Uint8ClampedArray,
  srcW: number,
  srcH: number,
  nativeW: number,
  nativeH: number,
  mapping: DepthMapping,
  nativeCal: DepthShellCal,
  basisRows: ArrayLike<number>,
  targetW = 512,
): DepthShellField {
  const w = Math.min(targetW, nativeW);
  const h = Math.max(1, Math.round(nativeH * w / nativeW));
  const s = w / nativeW;
  const depth = resampleDepthBytes(rgba, srcW, srcH, mapping, w, h);
  const cal = { ppu: nativeCal.ppu * s, cx: nativeCal.cx * s, cy: nativeCal.cy * s };
  return buildDepthShellField(depth, w, h, cal, basisRows);
}

/** M-world → 壳栅格像素（只要 x/y；z 由调用方另用）。 */
export function shellPxOfWorld(f: DepthShellField, b: ShellBasis, wx: number, wy: number, wz: number): [number, number, number] {
  const r = b.basisRows;
  const k = 1 / Math.max(b.wuPerQUnit, 1e-9);
  const x = wx * k, y = wy * k, z = wz * k;
  // Rᵀ：按列取
  const qx = r[0] * x + r[3] * y + r[6] * z;
  const qy = r[1] * x + r[4] * y + r[7] * z;
  const qz = r[2] * x + r[5] * y + r[8] * z;
  return [wrQxToPx(qx, f.cal.ppu, f.cal.cx), wrQyToPx(qy, f.cal.ppu, f.cal.cy), qz];
}

/** 壳栅格像素 + q 深度 → M-world。 */
export function shellPxToWorld(f: DepthShellField, b: ShellBasis, px: number, py: number, qz: number): Vec3 {
  const r = b.basisRows;
  const k = b.wuPerQUnit;
  const qx = wrQx(px, f.cal.ppu, f.cal.cx);
  const qy = wrQy(py, f.cal.ppu, f.cal.cy);
  return [
    wrQToWorldRow(r[0], r[1], r[2], qx, qy, qz) * k,
    wrQToWorldRow(r[3], r[4], r[5], qx, qy, qz) * k,
    wrQToWorldRow(r[6], r[7], r[8], qx, qy, qz) * k,
  ];
}

/**
 * 世界点是否落在可见深度壳后面（`geometry.py shell_contact` 同式）。出画返回 null。
 * 法线取最近像素（round），深度取双线性。
 */
export function shellContactAt(f: DepthShellField, b: ShellBasis, wx: number, wy: number, wz: number): ShellContact | null {
  const [px, py, qz] = shellPxOfWorld(f, b, wx, wy, wz);
  if (px < 0 || py < 0 || px > f.w - 1 || py > f.h - 1) return null;
  const d = sampleShellDepth(f, px, py);
  const xi = Math.max(0, Math.min(f.w - 1, Math.round(px)));
  const yi = Math.max(0, Math.min(f.h - 1, Math.round(py)));
  const o = (yi * f.w + xi) * 3;
  const n: Vec3 = [f.normal[o], f.normal[o + 1], f.normal[o + 2]];
  return {
    penWu: (qz - d) * b.wuPerQUnit,
    normal: n,
    px, py,
    groundLike: n[1] > 0.6,
  };
}

/** 该世界点视线上的壳深度（wu 尺度的 q.z），出画 null。 */
export function shellDepthWuAt(f: DepthShellField, b: ShellBasis, wx: number, wy: number, wz: number): number | null {
  const [px, py] = shellPxOfWorld(f, b, wx, wy, wz);
  if (px < 0 || py < 0 || px > f.w - 1 || py > f.h - 1) return null;
  return sampleShellDepth(f, px, py) * b.wuPerQUnit;
}

/** 把世界点沿视线推到壳前 `marginWu` 处（画面位置不变，只改深度）。出画原样返回。 */
export function pushInFrontOfShell(f: DepthShellField, b: ShellBasis, w: Vec3, marginWu: number): Vec3 {
  const [px, py] = shellPxOfWorld(f, b, w[0], w[1], w[2]);
  if (px < 0 || py < 0 || px > f.w - 1 || py > f.h - 1) return w;
  const d = sampleShellDepth(f, px, py);
  return shellPxToWorld(f, b, px, py, d - marginWu / b.wuPerQUnit);
}
