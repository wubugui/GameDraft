import { type TextureSource, BufferImageSource } from 'pixi.js';

/**
 * 运行时法线图集:与实验室 pipeline.stage_character 同数学,从 sprite 图集的
 * alpha 轮廓逐格现算鼓包法线,不需要任何法线贴图资产。
 *
 * 每格算法(逐 cell 独立,与实验室对单帧的处理一致):
 *   mask = alpha > 0.05
 *   dist = 欧氏距离场(EDT, 到最近背景像素)
 *   prof = gaussian(sqrt(dist / max), σ=3) * mask
 *   hpx  = prof * cellW * 0.35            (朝相机鼓包高度,px)
 *   n    = normalize([∂hpx/∂x, -∂hpx/∂y, -6])
 * 编码(RGBA8,与实验室 normal.png 相同):
 *   r=(nx*0.5+0.5)*255  g=(ny*0.5+0.5)*255  b=|nz|*255  a=prof*255
 */

const INF = 1e20;

/** Felzenszwalb 1D 平方距离变换(下包络抛物线法) */
function dt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

/** 2D 欧氏距离场:mask 内像素到最近 mask 外像素的距离(scipy distance_transform_edt 同义) */
function edt2d(mask: Uint8Array, w: number, h: number): Float64Array {
  const f = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) f[i] = mask[i] ? INF : 0;
  const n = Math.max(w, h);
  const col = new Float64Array(n);
  const dcol = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) col[y] = f[y * w + x];
    dt1d(col, h, dcol, v, z);
    for (let y = 0; y < h; y++) f[y * w + x] = dcol[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) col[x] = f[y * w + x];
    dt1d(col, w, dcol, v, z);
    for (let x = 0; x < w; x++) f[y * w + x] = dcol[x];
  }
  for (let i = 0; i < w * h; i++) f[i] = Math.sqrt(f[i]);
  return f;
}

/** scipy gaussian_filter 等价(σ, truncate=4, mode='reflect')的分离卷积 */
function gaussianBlur(src: Float64Array, w: number, h: number, sigma: number): Float64Array {
  const radius = Math.round(4 * sigma);
  const kernel = new Float64Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const g = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = g;
    sum += g;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  const reflect = (i: number, n: number): number => {
    // scipy 'reflect': (d c b a | a b c d)
    while (i < 0 || i >= n) {
      if (i < 0) i = -i - 1;
      if (i >= n) i = 2 * n - 1 - i;
    }
    return i;
  };
  const tmp = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -radius; i <= radius; i++) acc += src[y * w + reflect(x + i, w)] * kernel[i + radius];
      tmp[y * w + x] = acc;
    }
  }
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -radius; i <= radius; i++) acc += tmp[reflect(y + i, h) * w + x] * kernel[i + radius];
      out[y * w + x] = acc;
    }
  }
  return out;
}

/** 对图集一个 cell 现算法线,写入 out(整图 RGBA8)对应区域 */
function bakeCell(
  alpha: Float64Array, aw: number,
  cx0: number, cy0: number, cw: number, ch: number,
  out: Uint8Array,
): void {
  const mask = new Uint8Array(cw * ch);
  let any = false;
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const m = alpha[(cy0 + y) * aw + (cx0 + x)] > 0.05 ? 1 : 0;
      mask[y * cw + x] = m;
      if (m) any = true;
    }
  }
  if (!any) return;
  const dist = edt2d(mask, cw, ch);
  let dmax = 0;
  for (let i = 0; i < dist.length; i++) if (dist[i] > dmax) dmax = dist[i];
  dmax = Math.max(dmax, 1e-6);
  const prof0 = new Float64Array(cw * ch);
  for (let i = 0; i < prof0.length; i++) prof0[i] = Math.sqrt(dist[i] / dmax);
  const blurred = gaussianBlur(prof0, cw, ch, 3.0);
  const prof = new Float64Array(cw * ch);
  for (let i = 0; i < prof.length; i++) prof[i] = blurred[i] * mask[i];
  const hpx = new Float64Array(cw * ch);
  for (let i = 0; i < hpx.length; i++) hpx[i] = prof[i] * cw * 0.35;
  // np.gradient:内部中心差分,边缘单侧差分
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const gx = x === 0 ? hpx[y * cw + 1] - hpx[y * cw]
        : x === cw - 1 ? hpx[y * cw + x] - hpx[y * cw + x - 1]
          : (hpx[y * cw + x + 1] - hpx[y * cw + x - 1]) / 2;
      const gy = y === 0 ? hpx[cw + x] - hpx[x]
        : y === ch - 1 ? hpx[y * cw + x] - hpx[(y - 1) * cw + x]
          : (hpx[(y + 1) * cw + x] - hpx[(y - 1) * cw + x]) / 2;
      const nx = gx, ny = -gy, nz = -6.0;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      const o = ((cy0 + y) * aw + (cx0 + x)) * 4;
      out[o] = Math.round((nx / len * 0.5 + 0.5) * 255);
      out[o + 1] = Math.round((ny / len * 0.5 + 0.5) * 255);
      out[o + 2] = Math.round((-nz / len) * 255);
      out[o + 3] = Math.round(Math.min(Math.max(prof[y * cw + x], 0), 1) * 255);
    }
  }
}

const cache = new Map<number, TextureSource>();

/**
 * 从 sprite 图集纹理源现算整张法线图集(RGBA8),按网格逐 cell 处理。
 * 结果按 TextureSource uid 缓存(同图集共享,含玩家与 NPC)。
 * cols/rows 为动画网格;传 1×1 即整图单帧(静态 sprite)。
 */
export function buildNormalAtlas(source: TextureSource, cols: number, rows: number): TextureSource | null {
  const hit = cache.get(source.uid);
  if (hit) return hit;
  const res = source.resource as CanvasImageSource | undefined;
  const w = source.pixelWidth, h = source.pixelHeight;
  if (!res || !w || !h) return null;
  let data: Uint8ClampedArray;
  try {
    const cv = new OffscreenCanvas(w, h);
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(res, 0, 0);
    data = ctx.getImageData(0, 0, w, h).data;
  } catch {
    return null; // 非图像资源(如 buffer 源)不支持,调用方回退平面法线
  }
  const alpha = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) alpha[i] = data[i * 4 + 3] / 255;
  const out = new Uint8Array(w * h * 4);
  // 空区默认平面法线(b=|nz|=255, 朝相机),避免边界采样读到零向量
  for (let i = 0; i < w * h; i++) {
    out[i * 4] = 128; out[i * 4 + 1] = 128; out[i * 4 + 2] = 255; out[i * 4 + 3] = 0;
  }
  const cw = Math.floor(w / Math.max(cols, 1));
  const ch = Math.floor(h / Math.max(rows, 1));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      bakeCell(alpha, w, c * cw, r * ch, cw, ch, out);
    }
  }
  const tex = new BufferImageSource({
    resource: out, width: w, height: h, format: 'rgba8unorm',
    alphaMode: 'no-premultiply-alpha',
  });
  cache.set(source.uid, tex);
  return tex;
}

/** 场景卸载等时机可调用;当前按 uid 常驻缓存(图集数量有限) */
export function clearNormalAtlasCache(): void {
  for (const tex of cache.values()) tex.destroy();
  cache.clear();
}
