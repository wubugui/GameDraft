/**
 * 剪影「贴地那一截」的左右范围 —— 接触阴影的横向形状（见 EntityShadow 的 CONTACT_FRAG）。
 *
 * ## 为什么在 CPU 上、按帧缓存
 *
 * 接触阴影要知道脚（鞋、衣摆、拐杖头）在帧里横向占到哪。这个量对一整个 quad 是同一个值，
 * 放进片元里逐像素扫剪影是把同一件事做几千遍：2026-09-24 试过逐片元横向抽样，窄的鞋、拐杖
 * 被稀疏抽样打成竖条纹（梳齿），加密抽样又每人上百万次取样。所以改成：
 * 第一次用到某一帧时读一次帧底那条像素，算出范围，按 (图集, 帧矩形) 缓存，之后查表。
 * 一帧只读几十行、只读一次；图集像素 Pixi 装载后本来就留着（ImageBitmap）。
 *
 * ## 为什么从「最低的不透明行」往上找，而不是直接取帧底
 *
 * 帧底 ≠ 脚底：103 套图集里有 29 套存在脚离帧底超过 6% 帧高的帧（跳/抬脚帧，
 * 也有整套都悬着的素材）。直接取帧底那一截，这些帧会整个找不到脚、接触阴影凭空消失。
 * 竖直位置仍用实体的接地点（脚点）——那是物理上的着地处；这里只管横向形状。
 */
import type { Texture, TextureSource } from 'pixi.js';

/** 一帧贴地那一截最左 / 最右不透明列，帧内比例 0..1（图集原朝向，未按 facing 镜像）。 */
export interface FootprintExtent {
  lo: number;
  hi: number;
}

/** 不透明判据（alpha 字节）。半透明的发梢、烟雾边不算"贴地"。 */
export const FOOTPRINT_ALPHA_THRESHOLD = 128;

/**
 * 纯函数：在一条 RGBA 像素（帧底部那一条，行从上到下）里找贴地那一截的左右范围。
 *
 * 先自下而上找最低的不透明行 r0，再取 [r0 - bandRows + 1, r0] 这几行里所有不透明列的最左 / 最右。
 * 整条都没有不透明像素 ⇒ null（这一帧底部没有东西挨着地）。
 */
export function scanFootprint(
  rgba: ArrayLike<number>,
  w: number,
  h: number,
  bandRows: number,
  thr = FOOTPRINT_ALPHA_THRESHOLD,
): FootprintExtent | null {
  if (w <= 0 || h <= 0) return null;
  let bottom = -1;
  for (let y = h - 1; y >= 0 && bottom < 0; y--) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (rgba[row + x * 4 + 3] >= thr) { bottom = y; break; }
    }
  }
  if (bottom < 0) return null;
  const top = Math.max(0, bottom - Math.max(1, Math.round(bandRows)) + 1);
  let minX = w;
  let maxX = -1;
  for (let y = top; y <= bottom; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (rgba[row + x * 4 + 3] >= thr) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
  }
  return { lo: minX / w, hi: (maxX + 1) / w };
}

/** 按 facing 镜像：显示朝向与图集相反时，左右范围关于帧中线翻过去。 */
export function mirrorFootprint(fp: FootprintExtent, mirrored: boolean): FootprintExtent {
  return mirrored ? { lo: 1 - fp.hi, hi: 1 - fp.lo } : fp;
}

/** 缓存里的「读不了像素」标记（与 null =「这一帧底部没东西」区分开）。 */
const UNREADABLE = 'unreadable' as const;
type CacheEntry = FootprintExtent | null | typeof UNREADABLE;

const cache = new WeakMap<TextureSource, Map<string, CacheEntry>>();
const warned = new WeakSet<TextureSource>();
/**
 * 没有图像资源的源被问了多少次。图集装好之前精灵先挂一张**空的占位纹理**(没有 resource),
 * 那是正常的过渡态:不缓存、不出声,等真图集换上来再算(2026-09-24 实测:每次冷启动都误报一次)。
 * 但一直没有资源(比如渲染纹理当显示图)就不是过渡了——问够这么多次(约 5 秒)还没有才出声。
 */
const resourceless = new WeakMap<TextureSource, number>();
const RESOURCELESS_WARN_AFTER = 300;
let scratch: CanvasRenderingContext2D | null = null;

function scratchContext(w: number, h: number): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null;
  if (!scratch) {
    const c = document.createElement('canvas');
    scratch = c.getContext('2d', { willReadFrequently: true });
    if (!scratch) return null;
  }
  const c = scratch.canvas;
  if (c.width < w) c.width = w;
  if (c.height < h) c.height = h;
  scratch.clearRect(0, 0, w, h);
  return scratch;
}

/**
 * 取这张纹理当前帧的贴地范围（带缓存）。
 *
 * @param band        贴地那一截的高度，占帧高的比例
 * @param searchFrac  从帧底往上最多找多高去寻"最低的不透明行"，占帧高的比例
 * @returns 范围；`null` = 这一帧底部 searchFrac 内没有东西挨着地（不画接触阴影）；
 *          `undefined` = 读不到像素（资源不是可绘制图像 / 帧旋转过），调用方自行兜底，这里已出声。
 */
export function footprintOf(tex: Texture, band: number, searchFrac: number): FootprintExtent | null | undefined {
  const source = tex.source;
  const fr = tex.frame;
  const key = `${fr.x},${fr.y},${fr.width},${fr.height}`;
  let perSource = cache.get(source);
  if (!perSource) {
    perSource = new Map();
    cache.set(source, perSource);
  }
  const hit = perSource.get(key);
  if (hit !== undefined) return hit === UNREADABLE ? undefined : hit;

  if (source.resource == null) {
    // 占位纹理:过渡态,不缓存;久久等不到资源才出声(见 resourceless)
    const n = (resourceless.get(source) ?? 0) + 1;
    resourceless.set(source, n);
    if (n === RESOURCELESS_WARN_AFTER) warnUnreadable(source, '一直没有图像资源');
    return undefined;
  }

  const entry = readFootprint(tex, band, searchFrac);
  perSource.set(key, entry);
  if (entry === UNREADABLE) warnUnreadable(source, '资源不是可绘制图像或帧旋转过');
  return entry === UNREADABLE ? undefined : entry;
}

function warnUnreadable(source: TextureSource, why: string): void {
  if (warned.has(source)) return;
  warned.add(source);
  console.warn(
    `[接触阴影] 读不到这张图集的像素（${String(source.label || source.uid)}，${why}），`
    + '贴地范围退回整帧宽——这个角色的接触阴影会比脚宽。',
  );
}

function readFootprint(tex: Texture, band: number, searchFrac: number): CacheEntry {
  const source = tex.source;
  const resource = source.resource as unknown;
  if (tex.rotate) return UNREADABLE;
  const drawable = typeof ImageBitmap !== 'undefined' && resource instanceof ImageBitmap
    || typeof HTMLImageElement !== 'undefined' && resource instanceof HTMLImageElement
    || typeof HTMLCanvasElement !== 'undefined' && resource instanceof HTMLCanvasElement
    || typeof OffscreenCanvas !== 'undefined' && resource instanceof OffscreenCanvas;
  if (!drawable) return UNREADABLE;

  // frame 是纹理坐标（点），图像像素要乘分辨率
  const k = source.pixelWidth / Math.max(source.width, 1e-6);
  const fx = Math.round(tex.frame.x * k);
  const fw = Math.max(1, Math.round(tex.frame.width * k));
  const fh = Math.max(1, Math.round(tex.frame.height * k));
  const sh = Math.max(1, Math.min(fh, Math.round(fh * searchFrac)));
  const sy = Math.round(tex.frame.y * k) + fh - sh;
  const ctx = scratchContext(fw, sh);
  if (!ctx) return UNREADABLE;
  try {
    ctx.drawImage(resource as CanvasImageSource, fx, sy, fw, sh, 0, 0, fw, sh);
    const data = ctx.getImageData(0, 0, fw, sh).data;
    return scanFootprint(data, fw, sh, band * fh);
  } catch {
    return UNREADABLE;
  }
}
