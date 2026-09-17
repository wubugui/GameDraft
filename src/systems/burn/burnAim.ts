/**
 * 玩家点火时火头往哪伸（A3.8，制作人定）：
 * - 可燃物定义了着火点 ⇒ 伸到**离火头最近**的那个着火点，燃烧从那里扩散；
 * - 没定义 ⇒ 伸到可燃物**中间**（燃料重心；重心那一格没燃料——环形 / L 形——吸附到最近的有燃料格心），整体一起点燃。
 *
 * 纯函数：游戏（`BurnSystem.playerIgniteTarget`）与燃烧工作台（画站位）用同一份。
 */
import type { ResolvedBurnable } from '../../data/burnables';
import { burnUvToScene, type BurnFrame } from './burnGeometry';
import { BURN_MIN_FUEL, type BurnGrid } from './burnSim';

/** 可燃物"中间"（uv）：燃料重心；重心所在格没燃料 ⇒ 最近的有燃料格心；整张都没燃料 ⇒ 重心 */
export function burnFuelCenterUv(g: BurnGrid): { u: number; v: number } {
  const ci = Math.min(g.nx - 1, Math.max(0, Math.floor(g.centroidU * g.nx)));
  const cj = Math.min(g.ny - 1, Math.max(0, Math.floor(g.centroidV * g.ny)));
  if (g.fuel[cj * g.nx + ci] >= BURN_MIN_FUEL) return { u: g.centroidU, v: g.centroidV };
  let bestC = -1;
  let bestD = Infinity;
  for (let c = 0; c < g.fuel.length; c++) {
    if (g.fuel[c] < BURN_MIN_FUEL) continue;
    const i = c % g.nx;
    const j = (c - i) / g.nx;
    const d = ((i + 0.5) / g.nx - g.centroidU) ** 2 + ((j + 0.5) / g.ny - g.centroidV) ** 2;
    if (d < bestD) { bestD = d; bestC = c; }
  }
  if (bestC < 0) return { u: g.centroidU, v: g.centroidV };
  const i = bestC % g.nx;
  return { u: (i + 0.5) / g.nx, v: ((bestC - i) / g.nx + 0.5) / g.ny };
}

export interface BurnIgniteAim {
  /** 火头要对准的画面点（场景 wu） */
  scene: { x: number; y: number };
  /** 点哪：着火点 uv，或 'all' = 整体 */
  target: { u: number; v: number } | 'all';
  /** 选中的着火点 id（整体 ⇒ null） */
  pointId: string | null;
}

/** 火头在 `tip`（场景 wu）时该对准哪（见文件头）；`tip` 缺省 ⇒ 第一个着火点 */
export function burnIgniteAim(
  burnable: ResolvedBurnable, grid: BurnGrid, frame: BurnFrame, tip?: { x: number; y: number } | null,
): BurnIgniteAim {
  const pts = burnable.ignitionPoints;
  if (pts.length === 0) {
    const c = burnFuelCenterUv(grid);
    return { scene: burnUvToScene(frame, c.u, c.v), target: 'all', pointId: null };
  }
  let best = pts[0];
  if (tip) {
    let bestD = Infinity;
    for (const p of pts) {
      const s = burnUvToScene(frame, p.u, p.v);
      const d = Math.hypot(s.x - tip.x, s.y - tip.y);
      if (d < bestD) { bestD = d; best = p; }
    }
  }
  return { scene: burnUvToScene(frame, best.u, best.v), target: { u: best.u, v: best.v }, pointId: best.id };
}
