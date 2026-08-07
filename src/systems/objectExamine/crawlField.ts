/**
 * 检视爬虫导航场：任意静帧 alpha → mask + dIn/dOut + 轮廓入场点 + 体表高度场。
 * 仅作仿真约束（玩家不可见）；渲染一律用 Grok 精灵。
 *
 * 高度场（height）解决的是「虫子把物件当平面爬」：剪影只告诉你边在哪，
 * 不告诉你形体。这里用两项相加还原体表起伏——
 * - **宏观**：`dIn`（离剪影边的内部距离）开方成穹顶。躺姿人形的中轴就是最厚处，
 *   这一项与画面明暗无关，不会被反照率骗。
 * - **微观**：亮度**高通**（细模糊 − 粗模糊）。直接拿亮度当高度会把深色袍子读成凹陷、
 *   苍白皮肤读成鼓包（反照率冒充形体）；减掉大尺度分量后只剩衣褶/沟壑的局部起伏，
 *   对整体色差免疫。
 * 输出归一化到 0..1（地面恒 0），真实落差由 critterSim 侧的 reliefCm 换算。
 */

const GRID_LONG = 192;
const INF = 1e20;
const ALPHA_THRESH = 128;
/** 微观项（亮度高通）在总高度里的权重。 */
const MICRO_WEIGHT = 0.35;
/** 细模糊半径（网格单元）：去噪，保住衣褶。 */
const MICRO_BLUR_CELLS = 1;
/** 粗模糊半径占网格长边的比例：大于衣褶尺度、小于躯干尺度。 */
const MACRO_BLUR_RATIO = 0.08;
/** dIn 归一化参考分位（避开个别极深点把整体压平）。 */
const DIN_REF_PERCENTILE = 0.9;

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
  /** 体表相对高度 0..1（地面恒 0）；真实落差由 reliefCm 换算。 */
  height: Float32Array;
  /** 入场候选（自然图像像素坐标）。 */
  contour: Array<{ x: number; y: number; weight: number }>;
}

/** 体表高度采样（比 sampleCrawlField 轻，只给要走地形的调用方用）。 */
export interface CrawlHeightSample {
  /** 相对高度 0..1。 */
  h: number;
  /** 高度对自然像素的梯度（每像素的高度变化，仍是 0..1 尺度）。 */
  gx: number;
  gy: number;
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

/** 可分离盒模糊（跑两遍≈高斯）；radius 为单元数，0 = 原样返回。 */
function boxBlur(src: Float32Array, w: number, h: number, radius: number): Float32Array {
  if (radius <= 0) return src.slice();
  let cur = src;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let pass = 0; pass < 2; pass++) {
    // 横向
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let sum = 0;
        let n = 0;
        for (let k = -radius; k <= radius; k++) {
          const xx = x + k;
          if (xx < 0 || xx >= w) continue;
          sum += cur[row + xx];
          n++;
        }
        tmp[row + x] = sum / (n || 1);
      }
    }
    // 纵向
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        let sum = 0;
        let n = 0;
        for (let k = -radius; k <= radius; k++) {
          const yy = y + k;
          if (yy < 0 || yy >= h) continue;
          sum += tmp[yy * w + x];
          n++;
        }
        out[y * w + x] = sum / (n || 1);
      }
    }
    cur = out;
  }
  return out;
}

/**
 * 体表高度场：宏观穹顶（dIn）+ 微观衣褶（亮度高通）。
 * 见文件头注释里为什么不能直接拿亮度当高度。
 */
function bakeHeight(
  data: Uint8ClampedArray,
  mask: Uint8Array,
  dIn: Float32Array,
  gw: number,
  gh: number,
): Float32Array {
  const n = gw * gh;
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // Rec.709 亮度；地面像素不参与，避免托底纹理混进体表统计
    lum[i] =
      mask[i] === 1
        ? (0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2]) / 255
        : 0;
  }
  const micro = boxBlur(lum, gw, gh, MICRO_BLUR_CELLS);
  const macroLum = boxBlur(lum, gw, gh, Math.max(2, Math.round(Math.max(gw, gh) * MACRO_BLUR_RATIO)));

  // dIn 参考值取体内分位数
  const bodyDIn: number[] = [];
  for (let i = 0; i < n; i++) if (mask[i] === 1) bodyDIn.push(dIn[i]);
  bodyDIn.sort((a, b) => a - b);
  const dInRef =
    bodyDIn.length > 0
      ? Math.max(1e-3, bodyDIn[Math.min(bodyDIn.length - 1, Math.floor(bodyDIn.length * DIN_REF_PERCENTILE))])
      : 1;

  // 高通项按自身标准差归一，免得强反差贴图把权重吃满
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < n; i++) {
    if (mask[i] !== 1) continue;
    sum += micro[i] - macroLum[i];
    cnt++;
  }
  const mean = cnt > 0 ? sum / cnt : 0;
  let varSum = 0;
  for (let i = 0; i < n; i++) {
    if (mask[i] !== 1) continue;
    const d = micro[i] - macroLum[i] - mean;
    varSum += d * d;
  }
  const std = cnt > 0 ? Math.sqrt(varSum / cnt) : 0;
  const microScale = std > 1e-4 ? 1 / (2 * std) : 0;

  const height = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (mask[i] !== 1) continue;
    const macro = Math.sqrt(Math.min(1, dIn[i] / dInRef));
    const hp = Math.max(-1, Math.min(1, (micro[i] - macroLum[i] - mean) * microScale));
    height[i] = Math.max(0, Math.min(1, macro + MICRO_WEIGHT * hp));
  }
  return height;
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

      const height = bakeHeight(data, mask, dIn, gw, gh);

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

      return { gw, gh, naturalW, naturalH, mask, dIn, dOut, height, contour };
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

/**
 * 采样体表高度与坡向（自然图像像素坐标）。
 *
 * 单独一支而不并进 sampleCrawlField：后者每虫每帧都在调，只有要走地形的
 * 调用方才需要多这几次 bilinear。
 */
export function sampleCrawlHeight(
  field: ObjectExamineCrawlField,
  nx: number,
  ny: number,
): CrawlHeightSample {
  const gx = (nx / field.naturalW) * field.gw;
  const gy = (ny / field.naturalH) * field.gh;
  const eps = 0.75;
  const h = bilinear(field.height, field.gw, field.gh, gx, gy);
  const hl = bilinear(field.height, field.gw, field.gh, gx - eps, gy);
  const hr = bilinear(field.height, field.gw, field.gh, gx + eps, gy);
  const hu = bilinear(field.height, field.gw, field.gh, gx, gy - eps);
  const hd = bilinear(field.height, field.gw, field.gh, gx, gy + eps);
  // 网格单元 → 自然像素：除以每单元的像素跨度
  const pxPerCellX = field.naturalW / field.gw;
  const pxPerCellY = field.naturalH / field.gh;
  return {
    h,
    gx: (hr - hl) / (2 * eps) / pxPerCellX,
    gy: (hd - hu) / (2 * eps) / pxPerCellY,
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
