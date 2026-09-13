/**
 * 粒子区域的软边界：把作者画的多边形烘成一张低分辨率的**权重网格**（框内深处 1、边带里平滑降到框线上的 0、
 * 框外 0），粒子每子步双线性查一次。
 *
 * 为什么是网格不是逐粒子算多边形距离：跑马梁那一圈 83 个顶点，几百张纸每子步 × 83 条边是白花的；
 * 网格一个实例只烘一次，查表是常数时间，而且双线性插值让权重在格子之间连续（不会出现一条台阶线）。
 *
 * 纯函数、零 Pixi、零挂钟。坐标一律是画面坐标（场景 wu），与 `VfxInstanceDef.area` 同一套。
 */
import type { VfxConfineDef } from '../../data/types';

/** 边带宽缺省（画面 wu） */
export const CONFINE_FEATHER_DEFAULT = 120;
/** 网格一格的上下限（画面 wu）与单边格数上限 */
const CELL_MIN = 4;
const CELL_MAX = 48;
const GRID_MAX = 256;

export interface ConfineField {
  poly: [number, number][];
  feather: number;
  /** 离地高度上限（真实 wu）；null = 不限 */
  ceiling: number | null;
  /** 高度方向的过渡带宽（真实 wu） */
  ceilingBand: number;
  /** 网格原点（画面坐标）、格宽、格数（节点数 = 格数 + 1） */
  ox: number; oy: number; cell: number; gw: number; gh: number;
  /** 节点权重，行优先，(gw+1) × (gh+1) */
  w: Float32Array;
}

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function smoothstep01(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

export function pointInPolygon(poly: readonly (readonly [number, number])[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 点到多边形边界的最短距离（画面 wu） */
export function distanceToPolygonEdge(poly: readonly (readonly [number, number])[], x: number, y: number): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const ax = poly[j][0], ay = poly[j][1], bx = poly[i][0], by = poly[i][1];
    const ex = bx - ax, ey = by - ay;
    const l2 = ex * ex + ey * ey;
    let t = l2 > 0 ? ((x - ax) * ex + (y - ay) * ey) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = x - (ax + ex * t), dy = y - (ay + ey * t);
    const d = dx * dx + dy * dy;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/** 解析几何意义上的权重（不经网格）：测试与网格烘焙共用这一份定义 */
export function exactConfineWeight(poly: readonly (readonly [number, number])[], feather: number, x: number, y: number): number {
  if (!pointInPolygon(poly, x, y)) return 0;
  if (!(feather > 0)) return 1;
  return smoothstep01(distanceToPolygonEdge(poly, x, y) / feather);
}

function toPoly(area: unknown): [number, number][] | null {
  if (!Array.isArray(area)) return null;
  const poly: [number, number][] = [];
  for (const p of area) {
    if (Array.isArray(p) && finite(p[0]) && finite(p[1])) poly.push([p[0], p[1]]);
  }
  return poly.length >= 3 ? poly : null;
}

/**
 * 烘网格。范围区域取 `def.area`（与发射区域分开配），没写就用发射区域 `emitArea`；
 * 两块都凑不出 3 个有限点 ⇒ null（= 不限定）。
 *
 * ⚠ 框线上的节点权重是 0、框外一格以内的查询会被双线性插值带到一点点正值——
 * 所以"出界"判据要用一个小阈值（见 `CONFINE_EXIT_WEIGHT`），不能拿 `=== 0` 判。
 */
export function buildConfineField(
  emitArea: readonly (readonly number[])[] | null | undefined,
  def: VfxConfineDef | null | undefined,
): ConfineField | null {
  if (!def) return null;
  const poly = toPoly(def.area) ?? toPoly(emitArea);
  if (!poly) return null;
  const feather = finite(def.feather) ? Math.max(0, def.feather) : CONFINE_FEATHER_DEFAULT;
  const ceiling = finite(def.ceiling) && def.ceiling > 0 ? def.ceiling : null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of poly) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const span = Math.max(maxX - minX, maxY - minY, 1);
  // 边带里至少 4 格才插得出平滑的坡；但整张网格单边不超过 GRID_MAX 格
  let cell = Math.min(CELL_MAX, Math.max(CELL_MIN, feather > 0 ? feather / 4 : CELL_MIN));
  cell = Math.max(cell, span / GRID_MAX);
  const gw = Math.max(1, Math.ceil((maxX - minX) / cell));
  const gh = Math.max(1, Math.ceil((maxY - minY) / cell));
  const w = new Float32Array((gw + 1) * (gh + 1));
  for (let j = 0; j <= gh; j++) {
    const y = minY + j * cell;
    for (let i = 0; i <= gw; i++) {
      w[j * (gw + 1) + i] = exactConfineWeight(poly, feather, minX + i * cell, y);
    }
  }
  return {
    poly, feather, ceiling,
    ceilingBand: ceiling === null ? 0 : Math.min(Math.max(feather, 1), ceiling * 0.5),
    ox: minX, oy: minY, cell, gw, gh, w,
  };
}

/** 画面点的水平权重（双线性；网格外 0） */
export function confineWeightAt(f: ConfineField, sx: number, sy: number): number {
  const fx = (sx - f.ox) / f.cell, fy = (sy - f.oy) / f.cell;
  if (!(fx >= 0 && fy >= 0 && fx <= f.gw && fy <= f.gh)) return 0;
  const i = Math.min(f.gw - 1, Math.floor(fx)), j = Math.min(f.gh - 1, Math.floor(fy));
  const tx = fx - i, ty = fy - j;
  const row = f.gw + 1;
  const a = f.w[j * row + i], b = f.w[j * row + i + 1];
  const c = f.w[(j + 1) * row + i], d = f.w[(j + 1) * row + i + 1];
  return (a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * ty;
}

/** 高度权重：离地真实高度 `hReal` 在上限以下的过渡带里从 1 降到 0；不限高 ⇒ 恒 1 */
export function confineHeightWeight(f: ConfineField, hReal: number): number {
  if (f.ceiling === null) return 1;
  return 1 - smoothstep01((hReal - (f.ceiling - f.ceilingBand)) / f.ceilingBand);
}

/**
 * 权重网格在 `level` 处的等值线（marching squares），画面坐标线段 `[x1, y1, x2, y2, …]`。
 *
 * ⚠ 别拿它画"边带内沿"（level ≈ 1）：smoothstep 在 1 附近是平的，网格插值误差（≈ 格宽²·6/(8·边带²)，
 * 缺省 0.047）比到 1 的余量还大，画出来是一圈坑坑洼洼的噪声（2026-09-13 跑马梁实测）。
 * 按离框线的距离画走 {@link confineDistanceContour}。
 */
export function confineContour(f: ConfineField, level: number): number[] {
  return marchingSquares(f, f.w, level);
}

/**
 * 框内离框线 `distance`（画面 wu）的那一圈等值线。距离场是分段线性的，双线性插值几乎不失真——
 * F2 叠加层用它画边带内沿（`distance = feather`，从这往外风开始弱、纸开始稀）与边带中线。
 */
export function confineDistanceContour(f: ConfineField, distance: number): number[] {
  const row = f.gw + 1;
  const sd = new Float32Array(row * (f.gh + 1));
  for (let j = 0; j <= f.gh; j++) {
    for (let i = 0; i <= f.gw; i++) {
      const x = f.ox + i * f.cell, y = f.oy + j * f.cell;
      const d = distanceToPolygonEdge(f.poly, x, y);
      sd[j * row + i] = pointInPolygon(f.poly, x, y) ? d : -d;
    }
  }
  return marchingSquares(f, sd, distance);
}

function marchingSquares(f: ConfineField, W: ArrayLike<number>, level: number): number[] {
  const out: number[] = [];
  const row = f.gw + 1;
  const lerp = (x0: number, y0: number, v0: number, x1: number, y1: number, v1: number): [number, number] => {
    const t = v1 === v0 ? 0.5 : (level - v0) / (v1 - v0);
    return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
  };
  for (let j = 0; j < f.gh; j++) {
    for (let i = 0; i < f.gw; i++) {
      const a = W[j * row + i], b = W[j * row + i + 1], c = W[(j + 1) * row + i + 1], d = W[(j + 1) * row + i];
      const code = (a >= level ? 1 : 0) | (b >= level ? 2 : 0) | (c >= level ? 4 : 0) | (d >= level ? 8 : 0);
      if (code === 0 || code === 15) continue;
      const x0 = f.ox + i * f.cell, y0 = f.oy + j * f.cell, x1 = x0 + f.cell, y1 = y0 + f.cell;
      const top = () => lerp(x0, y0, a, x1, y0, b);
      const right = () => lerp(x1, y0, b, x1, y1, c);
      const bottom = () => lerp(x0, y1, d, x1, y1, c);
      const left = () => lerp(x0, y0, a, x0, y1, d);
      const seg = (p: [number, number], q: [number, number]) => { out.push(p[0], p[1], q[0], q[1]); };
      switch (code) {
        case 1: case 14: seg(left(), top()); break;
        case 2: case 13: seg(top(), right()); break;
        case 3: case 12: seg(left(), right()); break;
        case 4: case 11: seg(right(), bottom()); break;
        case 6: case 9: seg(top(), bottom()); break;
        case 7: case 8: seg(left(), bottom()); break;
        case 5: case 10: {
          // 鞍点：按格心均值定连法
          const mid = (a + b + c + d) / 4 >= level;
          if ((code === 5) === mid) { seg(left(), bottom()); seg(top(), right()); } else { seg(left(), top()); seg(right(), bottom()); }
          break;
        }
      }
    }
  }
  return out;
}

/** 权重低于它 = 已经压在框线上 / 出了框（双线性会把框外一格以内带到一点点正值） */
export const CONFINE_EXIT_WEIGHT = 0.02;
/** 越过框线的粒子多久淡完（秒） */
export const CONFINE_EXIT_FADE_S = 0.4;
/** 边带里躺着的粒子淡出用时（秒） */
export const CONFINE_SETTLE_FADE_S = 1.5;
/** 权重 0 处躺着的粒子平均躺多久开始淡出（秒）；权重 w 处按 (1−w) 折 */
export const CONFINE_SETTLE_MEAN_S = 4;
/** 从区域深处补回的粒子淡入用时（秒）——半空里凭空冒出一张满不透明的纸，就是一种硬边 */
export const CONFINE_FADE_IN_S = 0.6;
