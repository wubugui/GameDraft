/**
 * 表面材质（落雷的灯照出的反光用）：全局缺省材质（布置库 `defaultSurface`）+ 表面材质区（`scenes[id].surfaces`）
 * → 场景照明用的**反光遮罩**图。
 *
 * 没画区域的地方一律是全局缺省材质（2026-09-24 制作人：雷是任意地方随机放的，不能靠逐个场景圈区域）：
 * 雷劈在哪都照出反光；区域只标真正不一样的地方（水面、石板地）。
 *
 * 一张覆盖整个场景的小图（uv = 场景坐标 / 世界尺寸，与光照缓存同一套 uv）：
 *   r = 反光多强（0..1），g = 粗糙度（0..1），b = 是不是水面（1 = 水：平面 + 雨纹）。
 * 底色是缺省材质；每块区按自己的羽化宽度模糊边缘，后画的盖在先画的上面（作者把小块画在大块后面就能挖出例外）。
 * 细节起伏 / 水面雨纹的强度是全局两个数，走 uniform，不进这张图。
 *
 * 只有打了 reflect 位的灯（落雷）读它：平时这张图在不在，画面一个像素都不变。
 */
import type { VfxSurfaceDefaultsDef, VfxSurfaceRegionDef } from '../../data/types';

/** 一块区解析后的数（缺省值在这一处） */
export interface ResolvedSurfaceRegion {
  polygon: [number, number][];
  water: boolean;
  reflect: number;
  roughness: number;
  feather: number;
}

/** 全局缺省材质解析后的数 */
export interface ResolvedSurfaceDefaults {
  reflect: number;
  roughness: number;
  /** 细节法线强度（地面 / 湿地） */
  detail: number;
  /** 水面雨纹强度 */
  ripple: number;
}

/**
 * 缺省值（与粒子工作台检视器的占位提示、`tools/editor/shared/vfx_placements.py` 的 SURFACE_DEFAULTS 同值）。
 * 反光强度一律 1：镜面有多亮由菲涅耳（F0）与粗糙度定，`reflect` 只是作者往下压的余量。
 * 粗糙度：随便哪块地（被雨打湿的泥土 / 石头）0.45；石板地、积了水的路面 0.25；水面 0.08。
 */
export const SURFACE_DEFAULTS = {
  ground: { reflect: 1, roughness: 0.45, detail: 1, ripple: 1 },
  water: { reflect: 1, roughness: 0.08 },
  wet: { reflect: 1, roughness: 0.25 },
  featherWu: 24,
} as const;

function clamp01(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : dflt;
}

function clampRange(v: unknown, lo: number, hi: number, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : dflt;
}

/** 全局缺省材质：不写的量取缺省 */
export function resolveSurfaceDefaults(d: VfxSurfaceDefaultsDef | null | undefined): ResolvedSurfaceDefaults {
  const g = SURFACE_DEFAULTS.ground;
  return {
    reflect: clamp01(d?.reflect, g.reflect),
    roughness: clamp01(d?.roughness, g.roughness),
    detail: clampRange(d?.detail, 0, 2, g.detail),
    ripple: clampRange(d?.ripple, 0, 2, g.ripple),
  };
}

/** 形状不对的区（多边形不足三点 / 种类不认得）返回 null，调用方跳过 */
export function resolveSurfaceRegion(r: VfxSurfaceRegionDef): ResolvedSurfaceRegion | null {
  if (!r || (r.kind !== 'water' && r.kind !== 'wet') || !Array.isArray(r.polygon) || r.polygon.length < 3) return null;
  const d = SURFACE_DEFAULTS[r.kind];
  const f = r.feather;
  return {
    polygon: r.polygon,
    water: r.kind === 'water',
    reflect: clamp01(r.reflect, d.reflect),
    roughness: clamp01(r.roughness, d.roughness),
    feather: typeof f === 'number' && Number.isFinite(f) && f >= 0 ? f : SURFACE_DEFAULTS.featherWu,
  };
}

/**
 * 画成一张画布（`w × h` 像素覆盖 `worldW × worldH` 场景 wu），底色 = 全局缺省材质。
 * 没有一块有效区 ⇒ null（整张图都是缺省材质，调用方直接用 uniform，不必要一张图）。只在浏览器里跑（要 2D 画布）。
 */
export function buildSurfaceMaskCanvas(
  regions: readonly VfxSurfaceRegionDef[], worldW: number, worldH: number, w: number, h: number,
  ground: ResolvedSurfaceDefaults = resolveSurfaceDefaults(null),
): HTMLCanvasElement | null {
  const rs = regions.map(resolveSurfaceRegion).filter((r): r is ResolvedSurfaceRegion => !!r);
  if (rs.length === 0 || !(worldW > 0) || !(worldH > 0)) return null;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = `rgb(${Math.round(ground.reflect * 255)},${Math.round(ground.roughness * 255)},0)`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const sx = canvas.width / worldW, sy = canvas.height / worldH;
  for (const r of rs) {
    const blur = r.feather * sx * 0.5;
    ctx.filter = blur > 0.25 ? `blur(${blur.toFixed(2)}px)` : 'none';
    ctx.fillStyle = `rgb(${Math.round(r.reflect * 255)},${Math.round(r.roughness * 255)},${r.water ? 255 : 0})`;
    ctx.beginPath();
    r.polygon.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x * sx, y * sy) : ctx.lineTo(x * sx, y * sy)));
    ctx.closePath();
    ctx.fill();
  }
  ctx.filter = 'none';
  return canvas;
}
