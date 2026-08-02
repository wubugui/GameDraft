/**
 * 检视爬虫导航场：任意静帧 alpha → mask + dIn/dOut + 轮廓入场点。
 * 仅作仿真约束（玩家不可见）；渲染一律用 Grok 精灵。
 */

const GRID_LONG = 192;
const INF = 1e20;
const ALPHA_THRESH = 128;

export interface ObjectExamineCrawlField {
  /** 网格宽高（物件区，无 AO 余量）。 */
  gw: number;
  gh: number;
  naturalW: number;
  naturalH: number;
  /** 1 = 身体，0 = 地面。 */
  mask: Uint8Array;
  /** 网格单元距离。 */
  dIn: Float32Array;
  dOut: Float32Array;
  /** 入场候选（自然图像像素坐标）。 */
  contour: Array<{ x: number; y: number; weight: number }>;
}

export interface CrawlSample {
  onBody: boolean;
  dIn: number;
  dOut: number;
  /** 指向身体内部 / 离开身体（自然像素空间近似）。 */
  gradInX: number;
  gradInY: number;
  gradOutX: number;
  gradOutY: number;
}

function edt1d(
  f: Float64Array,
  d: Float64Array,
  v: Int32Array,
  z: Float64Array,
  n: number,
): void {
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

function edt2d(f: Float64Array, w: number, h: number): Float64Array {
  const out = new Float64Array(w * h);
  const maxN = Math.max(w, h);
  const df = new Float64Array(maxN);
  const vv = new Int32Array(maxN);
  const zz = new Float64Array(maxN + 1);
  const col = new Float64Array(h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) col[y] = f[y * w + x];
    edt1d(col, df, vv, zz, h);
    for (let y = 0; y < h; y++) out[y * w + x] = df[y];
  }
  const row = new Float64Array(w);
  const rowOut = new Float64Array(w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) row[x] = out[y * w + x];
    edt1d(row, rowOut, vv, zz, w);
    for (let x = 0; x < w; x++) out[y * w + x] = rowOut[x];
  }
  return out;
}

function featureField(w: number, h: number, isFeature: (i: number) => boolean): Float64Array {
  const f = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) f[i] = isFeature(i) ? 0 : INF;
  return f;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`image load failed: ${url}`));
    img.src = url;
  });
}

const fieldCache = new Map<string, Promise<ObjectExamineCrawlField | null>>();

/** 烘焙爬虫导航场；按 URL 缓存。失败返回 null。 */
export function bakeObjectExamineCrawlField(
  imageUrl: string,
): Promise<ObjectExamineCrawlField | null> {
  let cached = fieldCache.get(imageUrl);
  if (!cached) {
    cached = (async (): Promise<ObjectExamineCrawlField | null> => {
      const img = await loadImage(imageUrl);
      const naturalW = img.naturalWidth || 1;
      const naturalH = img.naturalHeight || 1;
      const s = GRID_LONG / Math.max(naturalW, naturalH);
      const gw = Math.max(1, Math.round(naturalW * s));
      const gh = Math.max(1, Math.round(naturalH * s));
      const canvas = document.createElement('canvas');
      canvas.width = gw;
      canvas.height = gh;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(img, 0, 0, gw, gh);
      const data = ctx.getImageData(0, 0, gw, gh).data;
      const n = gw * gh;
      const mask = new Uint8Array(n);
      for (let i = 0; i < n; i++) mask[i] = data[i * 4 + 3] > ALPHA_THRESH ? 1 : 0;

      const dOut2 = edt2d(featureField(gw, gh, (i) => mask[i] === 1), gw, gh);
      const dIn2 = edt2d(featureField(gw, gh, (i) => mask[i] === 0), gw, gh);
      const dIn = new Float32Array(n);
      const dOut = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        dIn[i] = Math.sqrt(dIn2[i]);
        dOut[i] = Math.sqrt(dOut2[i]);
      }

      const sx = naturalW / gw;
      const sy = naturalH / gh;
      const contour: ObjectExamineCrawlField['contour'] = [];
      for (let y = 1; y < gh - 1; y++) {
        for (let x = 1; x < gw - 1; x++) {
          const i = y * gw + x;
          if (mask[i] !== 1) continue;
          const edge =
            mask[i - 1] === 0 ||
            mask[i + 1] === 0 ||
            mask[i - gw] === 0 ||
            mask[i + gw] === 0;
          if (!edge) continue;
          // 贴地入场：下半轮廓权重更高
          const ny = y / gh;
          const weight = 0.25 + (ny > 0.45 ? 1.2 * ny : 0.35 * ny);
          contour.push({
            x: (x + 0.5) * sx,
            y: (y + 0.5) * sy,
            weight,
          });
        }
      }
      // 降采样轮廓，避免过密
      if (contour.length > 220) {
        const step = Math.ceil(contour.length / 220);
        const thinned = [];
        for (let i = 0; i < contour.length; i += step) thinned.push(contour[i]);
        contour.length = 0;
        contour.push(...thinned);
      }

      return { gw, gh, naturalW, naturalH, mask, dIn, dOut, contour };
    })().catch((e) => {
      console.warn('objectExamine: crawl field bake failed', imageUrl, e);
      fieldCache.delete(imageUrl);
      return null;
    });
    fieldCache.set(imageUrl, cached);
  }
  return cached;
}

function bilinear(
  field: Float32Array,
  gw: number,
  gh: number,
  gx: number,
  gy: number,
): number {
  const x = Math.max(0, Math.min(gw - 1.001, gx));
  const y = Math.max(0, Math.min(gh - 1.001, gy));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(gw - 1, x0 + 1);
  const y1 = Math.min(gh - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const a = field[y0 * gw + x0];
  const b = field[y0 * gw + x1];
  const c = field[y1 * gw + x0];
  const d = field[y1 * gw + x1];
  return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
}

function maskAt(field: ObjectExamineCrawlField, gx: number, gy: number): boolean {
  const x = Math.max(0, Math.min(field.gw - 1, Math.round(gx)));
  const y = Math.max(0, Math.min(field.gh - 1, Math.round(gy)));
  return field.mask[y * field.gw + x] === 1;
}

/** 在自然图像像素坐标采样。 */
export function sampleCrawlField(
  field: ObjectExamineCrawlField,
  nx: number,
  ny: number,
): CrawlSample {
  const gx = (nx / field.naturalW) * field.gw;
  const gy = (ny / field.naturalH) * field.gh;
  const dIn = bilinear(field.dIn, field.gw, field.gh, gx, gy);
  const dOut = bilinear(field.dOut, field.gw, field.gh, gx, gy);
  const eps = 0.75;
  const dInL = bilinear(field.dIn, field.gw, field.gh, gx - eps, gy);
  const dInR = bilinear(field.dIn, field.gw, field.gh, gx + eps, gy);
  const dInU = bilinear(field.dIn, field.gw, field.gh, gx, gy - eps);
  const dInD = bilinear(field.dIn, field.gw, field.gh, gx, gy + eps);
  const dOutL = bilinear(field.dOut, field.gw, field.gh, gx - eps, gy);
  const dOutR = bilinear(field.dOut, field.gw, field.gh, gx + eps, gy);
  const dOutU = bilinear(field.dOut, field.gw, field.gh, gx, gy - eps);
  const dOutD = bilinear(field.dOut, field.gw, field.gh, gx, gy + eps);
  const sx = field.naturalW / field.gw;
  const sy = field.naturalH / field.gh;
  return {
    onBody: maskAt(field, gx, gy),
    dIn: dIn * sx,
    dOut: dOut * sx,
    gradInX: ((dInR - dInL) / (2 * eps)) * sx,
    gradInY: ((dInD - dInU) / (2 * eps)) * sy,
    gradOutX: ((dOutR - dOutL) / (2 * eps)) * sx,
    gradOutY: ((dOutD - dOutU) / (2 * eps)) * sy,
  };
}

export function pickWeightedContour(
  field: ObjectExamineCrawlField,
  rng: () => number,
): { x: number; y: number } | null {
  const c = field.contour;
  if (!c.length) return null;
  let sum = 0;
  for (const p of c) sum += p.weight;
  let r = rng() * sum;
  for (const p of c) {
    r -= p.weight;
    if (r <= 0) return { x: p.x, y: p.y };
  }
  return c[c.length - 1];
}
