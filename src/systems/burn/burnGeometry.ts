/**
 * 可燃物实例的几何：图内 uv ↔ 场景坐标 ↔ M-world。纯函数，零 Pixi，工作台打包同一份。
 *
 * ## 实例在画面上怎么摆：一个仿射（{@link BurnFrame}）
 *
 * 模板的图不论挂在哪种宿主上，画面上都是一张被平移 / 缩放 / 旋转 / 镜像过的矩形，所以统一成
 * `scene = o + u·du + v·dv`。宿主各自给出这三个向量：
 *
 * - **场景实体**（热点 / NPC / 演出生成的对象，{@link burnPlacementFrame}）：容器在实体 `(x, y)`，缩放 `s = 实例 scale × 透视系数`，
 *   旋转 `rotation`；图的锚点 `(ax, ay)`（缺省底中），宽高 = 模板真实尺寸（wu），朝左左右镜像：
 *   ```
 *   local = ((u − ax) · W · flip, (v − ay) · H)        flip = 朝左 ? −1 : 1
 *   scene = (x, y) + R(rotation) · (s · local)
 *   ```
 * - **挂在手上的挂件**（`SpriteEntity` 摆挂件那一套变换）：由组装层量出图上三个角的场景位置，{@link burnFrameFromCorners}。
 *
 * ## 格点的世界位置（铁律 0：一律 M-world、wu）
 *
 * - `upright`（立着）：过**脚点**的直立面，画面点对准——与宿主的深度遮挡模型（直立 quad 立在脚点深度）同一个面；
 *   挂件的脚点是拿着它的人的脚点；
 * - `ground`（平躺）：画面点正下方的地面。
 *
 * 映射**不直接逐格算**：取 9×9 个图内网格点算世界位置（外加离地高度），格心按双线性插值。
 * 这 9×9 份数据进存档（场景里有东西烧着时）——离场 / 读档之后不需要那个场景的几何也能确定性推导蔓延。
 */
import { entityAnchorOf, entityRotationRadOf, entityScaleOf } from '../../utils/entityTransform';
import type { Vec3 } from '../../utils/sceneSpace';

/** 实例图在画面上的摆放（场景 wu）：`scene = o + u·du + v·dv`，立面脚点 `foot` */
export interface BurnFrame {
  ox: number;
  oy: number;
  ux: number;
  uy: number;
  vx: number;
  vy: number;
  /** 立着的格点世界位置按过这一点的直立面算（场景实体 = 接地点；挂件 = 拿着它的人的接地点） */
  footX: number;
  footY: number;
}

/** 场景实体上的一个实例怎么摆 */
export interface BurnPlacement {
  /** 实体坐标（锚点所在） */
  x: number;
  y: number;
  /** 图的宽高（wu，未乘缩放）——模板真实尺寸换算来的 */
  width: number;
  height: number;
  /** 实例 scale × 透视系数 */
  scale: number;
  /** 旋转（弧度，绕锚点） */
  rotation: number;
  /** 朝左（左右镜像） */
  flipX: boolean;
  /** 图上的锚点（缺省底中 0.5 / 1） */
  anchorX?: number;
  anchorY?: number;
  /** 接地点（缺省 = 锚点 (x, y)；锚点不在底中时由调用方给） */
  footX?: number;
  footY?: number;
}

export function burnPlacementFrame(p: BurnPlacement): BurnFrame {
  const ax = p.anchorX ?? 0.5;
  const ay = p.anchorY ?? 1;
  const flip = p.flipX ? -1 : 1;
  const c = Math.cos(p.rotation);
  const s = Math.sin(p.rotation);
  // local(u, v) = ((u − ax)·W·flip, (v − ay)·H) · scale
  const lux = p.width * flip * p.scale; // ∂local.x/∂u
  const lvy = p.height * p.scale;       // ∂local.y/∂v
  const l0x = -ax * lux;
  const l0y = -ay * lvy;
  return {
    ox: p.x + l0x * c - l0y * s,
    oy: p.y + l0x * s + l0y * c,
    ux: lux * c,
    uy: lux * s,
    vx: -lvy * s,
    vy: lvy * c,
    footX: p.footX ?? p.x,
    footY: p.footY ?? p.y,
  };
}

/**
 * 场景实体定义 → 实例摆放（游戏离场重建、燃烧工作台"用在哪"的场景视图、主编辑器同口径）。
 * `size` = 模板真实尺寸换算的 wu；`depthScale` = 此刻的透视系数（热点只有 `perspectiveScaleEnabled` 才吃，由调用方判）；
 * 锚点取实体的 `anchor`（缺省底中），接地点按锚点反推（与 `entityTransform.anchorContactOffset` 同口径）。
 */
export function burnEntityPlacement(
  def: { x: number; y: number; scale?: number; rotation?: number; anchor?: { x?: number; y?: number } | null },
  size: { width: number; height: number },
  opts: { depthScale: number; flipX: boolean },
): BurnPlacement {
  const a = entityAnchorOf(def);
  const scale = entityScaleOf(def) * (opts.depthScale > 0 && Number.isFinite(opts.depthScale) ? opts.depthScale : 1);
  const rotation = entityRotationRadOf(def);
  const flip = opts.flipX ? -1 : 1;
  const lx = (0.5 - a.x) * size.width * scale * flip;
  const ly = (1 - a.y) * size.height * scale;
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  return {
    x: def.x, y: def.y, width: size.width, height: size.height, scale, rotation, flipX: opts.flipX,
    anchorX: a.x, anchorY: a.y,
    footX: def.x + lx * c - ly * s,
    footY: def.y + lx * s + ly * c,
  };
}

/** 由图上三个角的场景位置（左上 (0,0)、右上 (1,0)、左下 (0,1)）建摆放（挂件：组装层按挂件变换量出来） */
export function burnFrameFromCorners(
  topLeft: { x: number; y: number }, topRight: { x: number; y: number }, bottomLeft: { x: number; y: number },
  foot: { x: number; y: number },
): BurnFrame {
  return {
    ox: topLeft.x, oy: topLeft.y,
    ux: topRight.x - topLeft.x, uy: topRight.y - topLeft.y,
    vx: bottomLeft.x - topLeft.x, vy: bottomLeft.y - topLeft.y,
    footX: foot.x, footY: foot.y,
  };
}

/** 世界映射网格的边长（点数） */
export const BURN_WORLD_GRID = 9;

/**
 * 世界映射：`BURN_WORLD_GRID²` 个点，每点 4 个数 `[x, y, z, 离地高度]`（wu），行优先（v 向下）。
 * 离地高度给场景风的对数廓线用（`sampleSceneWind` 的 hReal）。
 */
export interface BurnWorldGrid {
  g: number;
  pts: Float64Array;
}

/** 世界映射需要的空间能力（粒子空间 `VfxSpace` 恰好提供；工作台用同一份打包的实现） */
export interface BurnSpaceLike {
  groundWorldAtScene(sceneX: number, sceneY: number): Vec3;
  /** 过脚点直立面上对准画面点的世界点（正式的 field / planar 空间都有；没有时退到地面点） */
  uprightWorldAtScene?(footX: number, footY: number, sceneX: number, sceneY: number): Vec3;
  groundY(x: number, z: number): number;
}

export function burnUvToScene(f: BurnFrame, u: number, v: number): { x: number; y: number } {
  return { x: f.ox + u * f.ux + v * f.vx, y: f.oy + u * f.uy + v * f.vy };
}

export function burnSceneToUv(f: BurnFrame, sx: number, sy: number): { u: number; v: number } {
  const a = burnSceneToUvAffine(f);
  return { u: a[0] * sx + a[1] * sy + a[4], v: a[2] * sx + a[3] * sy + a[5] };
}

/**
 * 世界 → 图 uv 的 2×3 仿射（给着色器：先把片元的场景坐标算出来，再乘它得到 uv）。
 * 返回 `[a, b, c, d, tx, ty]`：`u = a·sx + b·sy + tx`，`v = c·sx + d·sy + ty`。退化（面积 0）⇒ 全 0。
 */
export function burnSceneToUvAffine(f: BurnFrame): [number, number, number, number, number, number] {
  const det = f.ux * f.vy - f.vx * f.uy;
  if (!(Math.abs(det) > 1e-12)) return [0, 0, 0, 0, 0, 0];
  const a = f.vy / det;
  const b = -f.vx / det;
  const c = -f.uy / det;
  const d = f.ux / det;
  return [a, b, c, d, -(a * f.ox + b * f.oy), -(c * f.ox + d * f.oy)];
}

/** 画面上两个方向的边长（wu）：图宽 / 图高（含缩放） */
export function burnFrameExtent(f: BurnFrame): { width: number; height: number } {
  return { width: Math.hypot(f.ux, f.uy), height: Math.hypot(f.vx, f.vy) };
}

/** 按摆法算 9×9 世界映射 */
export function buildBurnWorldGrid(
  f: BurnFrame,
  orientation: 'upright' | 'ground',
  space: BurnSpaceLike,
): BurnWorldGrid {
  const g = BURN_WORLD_GRID;
  const pts = new Float64Array(g * g * 4);
  for (let j = 0; j < g; j++) {
    for (let i = 0; i < g; i++) {
      const u = i / (g - 1);
      const v = j / (g - 1);
      const sp = burnUvToScene(f, u, v);
      const w = orientation === 'ground' || !space.uprightWorldAtScene
        ? space.groundWorldAtScene(sp.x, sp.y)
        : space.uprightWorldAtScene(f.footX, f.footY, sp.x, sp.y);
      const o = (j * g + i) * 4;
      pts[o] = w[0];
      pts[o + 1] = w[1];
      pts[o + 2] = w[2];
      pts[o + 3] = Math.max(0, w[1] - space.groundY(w[0], w[2]));
    }
  }
  return { g, pts };
}

/** 图内 (u, v) 的世界点与离地高度（双线性），写进 out[0..3] */
export function burnWorldAt(grid: BurnWorldGrid, u: number, v: number, out: Float64Array | number[]): void {
  const g = grid.g;
  const fx = Math.min(g - 1, Math.max(0, u * (g - 1)));
  const fy = Math.min(g - 1, Math.max(0, v * (g - 1)));
  const i0 = Math.min(g - 2, Math.floor(fx));
  const j0 = Math.min(g - 2, Math.floor(fy));
  const tx = fx - i0;
  const ty = fy - j0;
  const p = grid.pts;
  const o00 = (j0 * g + i0) * 4;
  const o10 = o00 + 4;
  const o01 = o00 + g * 4;
  const o11 = o01 + 4;
  for (let k = 0; k < 4; k++) {
    const a = p[o00 + k] + (p[o10 + k] - p[o00 + k]) * tx;
    const b = p[o01 + k] + (p[o11 + k] - p[o01 + k]) * tx;
    out[k] = a + (b - a) * ty;
  }
}

/** 两份世界映射逐点差不超过 `eps`（wu）：实例没挪（挪了才记"挪位"事件） */
export function burnWorldGridsClose(a: BurnWorldGrid, b: BurnWorldGrid, eps: number): boolean {
  if (a.g !== b.g || a.pts.length !== b.pts.length) return false;
  for (let i = 0; i < a.pts.length; i++) {
    if (!(Math.abs(a.pts[i] - b.pts[i]) <= eps)) return false;
  }
  return true;
}

/** 世界映射网格压成存档用的数组（逐位保留：Float64 → 数组，JSON 往返无损） */
export function burnWorldGridToJson(grid: BurnWorldGrid): number[] {
  return Array.from(grid.pts);
}

export function burnWorldGridFromJson(raw: unknown): BurnWorldGrid | null {
  if (!Array.isArray(raw)) return null;
  const g = BURN_WORLD_GRID;
  if (raw.length !== g * g * 4) return null;
  const pts = new Float64Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const n = raw[i];
    if (typeof n !== 'number' || !Number.isFinite(n)) return null;
    pts[i] = n;
  }
  return { g, pts };
}
