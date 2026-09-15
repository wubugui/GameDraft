/** Surface sampling belongs to emission / confinement, independent of the motion solver. */
import type { Vec3 } from '../../utils/sceneSpace';
import { confineWeightAt, pointInPolygon, type ConfineField } from './vfxConfine';
import type { VfxRng } from './vfxRandom';
import type { VfxSpace } from './vfxSpace';

/** 区域（画面多边形）的预解析：包围盒、面积采样表、最低地面 */
export interface PlateArea {
  poly: [number, number][] | null;
  /** 没有多边形时：圆盘 */
  disc: { cx: number; cz: number; y: number; r: number } | null;
  minX: number; minY: number; maxX: number; maxY: number;
  /** 区域内地面的最低世界 Y（丢失判据） */
  floorY: number;
  /** 粒子区域的软边界（实例配了 `confine` 才有）：出生 / 补回按权重挑、风按权重衰减、出界淡出回收 */
  confine: ConfineField | null;
}

const pointInPoly = pointInPolygon;

export function resolvePlateArea(
  space: VfxSpace, origin: Vec3, poly: [number, number][] | null | undefined, radius: number,
  confine: ConfineField | null = null,
): PlateArea {
  if (poly && poly.length >= 3) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of poly) {
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
    // 最低地面：多边形包围盒内粗采样
    let floorY = Infinity;
    for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) {
      const sx = minX + ((maxX - minX) * i) / 8, sy = minY + ((maxY - minY) * j) / 8;
      if (!pointInPoly(poly, sx, sy)) continue;
      floorY = Math.min(floorY, space.groundWorldAtScene(sx, sy)[1]);
    }
    if (!Number.isFinite(floorY)) floorY = origin[1];
    return { poly, disc: null, minX, minY, maxX, maxY, floorY, confine };
  }
  const s = { x: 0, y: 0 };
  space.toScene(origin, s);
  return {
    poly: null,
    disc: { cx: origin[0], cz: origin[2], y: origin[1], r: Math.max(1, radius) },
    minX: s.x - radius, minY: s.y - radius, maxX: s.x + radius, maxY: s.y + radius,
    floorY: origin[1],
    confine: null,
  };
}

/** 一个世界点正下方的地面点，在粒子区域里的水平权重 */
export function footWeight(space: VfxSpace, cf: ConfineField, x: number, z: number): number {
  FOOT[0] = x; FOOT[1] = space.groundY(x, z); FOOT[2] = z;
  space.toScene(FOOT, FOOT_S);
  return confineWeightAt(cf, FOOT_S.x, FOOT_S.y);
}
const FOOT: Vec3 = [0, 0, 0];
const FOOT_S = { x: 0, y: 0 };
/** 限定区域时挑落点多试几次：按权重拒绝采样会多拒掉一大半，挑不到 = 这张纸被回收掉、总数慢慢漏光 */
const CONFINE_PICK_TRIES = 96;

const tmpS = { x: 0, y: 0 };

/** 在区域里挑一个看得见表面的点（最多试 `tries` 次）；挑不到返回 null */
export function pickAreaSurface(
  space: VfxSpace, area: PlateArea, rng: VfxRng, tries = 24,
): { p: Vec3; normal: Vec3; kind: 'ground' | 'object' } | null {
  const cf = area.confine;
  const n = cf ? Math.max(tries, CONFINE_PICK_TRIES) : tries;
  for (let k = 0; k < n; k++) {
    let sx: number, sy: number;
    if (area.poly) {
      sx = rng.range(area.minX, area.maxX);
      sy = rng.range(area.minY, area.maxY);
      if (!pointInPoly(area.poly, sx, sy)) continue;
    } else {
      const d = area.disc!;
      const a = rng.range(0, Math.PI * 2), r = d.r * Math.sqrt(rng.next());
      space.toScene([d.cx + Math.cos(a) * r, d.y, d.cz + Math.sin(a) * r], tmpS);
      sx = tmpS.x; sy = tmpS.y;
    }
    const surf = space.surfaceAtScene(sx, sy);
    if (surf.kind === 'void') continue;
    // 粒子区域：按权重拒绝采样 ⇒ 密度随离边距离平滑变稀（边带里天然少，不靠遮罩）
    if (cf && rng.next() >= footWeight(space, cf, surf.p[0], surf.p[2])) continue;
    return { p: surf.p, normal: surf.normal, kind: surf.kind };
  }
  return null;
}

