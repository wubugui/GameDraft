/**
 * 轨迹资产的**世界空间 → 画面空间**投影（运行时开播时用）。
 *
 * 伪世界相机是**正交**的（q = ((sx−cx)/ppu, (cy−sy)/ppu, d)，没有透视除法），
 * 而 q ↔ M-world 之间只是一个纯旋转 R（`depthConfig.M.R`，det=+1，28/28 场景验过，
 * 见 [[coordinate-spaces]]）。于是一个**相对** 3D 位移 Δw（wu）投到画面平面上是
 *
 *     Δq = Rᵀ·Δw / wuPerQUnit
 *     Δsx = Δq.x · ppu ,  Δsy = −Δq.y · ppu            （native px；翻 Y 就在这里）
 *     Δx  = Δsx / worldToPixelX = Δq.x · ppu / worldToPixelX
 *
 * 而 `wuPerQUnit = worldWidth / (native_w / ppu) = ppu / worldToPixelX`，所以
 *
 *     Δx = (Rᵀ·Δw).x ,   Δy = −(Rᵀ·Δw).y            （都是 wu）
 *
 * **只剩 R**：ppu / cx / cy / wuPerQUnit / 分辨率全部约掉。这就是为什么运行时投影
 * 只需要场景 JSON 里的 `depthConfig.M.R`，不需要任何光照烘焙载荷；也是为什么
 * 同一场景内任何位置播同一条 3D 轨迹，画面上的偏移逐位相同。
 *
 * 前提：像素在两轴上同一把 wu 尺（`worldToPixelX == worldToPixelY`）。本仓 `worldHeight`
 * 由背景长宽比推出，恒成立；不成立的场景在校验器里报。
 *
 * 深度排序锚 `sortY` 取**落点**：物件位置减去离地高度 `(x, y − h, z)` 再投影。
 * 烘焙时的地面高低已经进了 `h`，播放场景的地面高低不再考虑（正交 + 相对偏移的代价，
 * 也是"运行时零求解"的边界）。
 *
 * Python 侧镜像：`tools/trajectory_workbench/projection.py`，跨语言金标
 * `src/utils/trajectoryProjection.golden.json`（两侧必须同数）。
 */
import type { TrajectoryKeyframe, TrajectoryWorldKeyframe } from '../data/types';
import { wrWorldToQComponent, matrixDet3 } from './worldReconstruct';

/** 行主 9 元 R（`depthConfig.M.R` 摊平）。 */
export type BasisRows = ArrayLike<number>;

/** `depthConfig.M.R`（3×3 嵌套数组）→ 行主 9 元；形状不对或 det 不是 +1 返回 null。 */
export function basisRowsFromDepthConfigR(R: unknown): number[] | null {
  if (!Array.isArray(R) || R.length !== 3) return null;
  const rows: number[] = [];
  for (const r of R) {
    if (!Array.isArray(r) || r.length !== 3) return null;
    for (const v of r) {
      if (typeof v !== 'number' || !Number.isFinite(v)) return null;
      rows.push(v);
    }
  }
  if (Math.abs(matrixDet3(rows) - 1) > 1e-3) return null;
  return rows;
}

/** 相对 3D 位移（M-world wu）→ 画面平面相对偏移（场景坐标 wu，Y 向下）。 */
export function projectWorldOffset(
  rRows: BasisRows, dx: number, dy: number, dz: number,
): { x: number; y: number } {
  return {
    x: wrWorldToQComponent(rRows, 0, dx, dy, dz),
    y: -wrWorldToQComponent(rRows, 1, dx, dy, dz),
  };
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * 世界空间帧 → 画面空间帧（都相对锚点）。`rotation` / `scale*` / `alpha` 原样透传，
 * `sortY` 只在与 `y` 不同时写（与烘焙机 `write_keyframe` 的省键规则同口径，
 * 但**不取整**——取整是落盘的事，运行时喂采样器要的是原值）。
 */
export function projectWorldKeyframes(
  frames: readonly TrajectoryWorldKeyframe[] | undefined,
  rRows: BasisRows,
): TrajectoryKeyframe[] {
  if (!Array.isArray(frames)) return [];
  const out: TrajectoryKeyframe[] = [];
  for (const f of frames) {
    if (!f || typeof f !== 'object') continue;
    const wx = num(f.x, 0);
    const wy = num(f.y, 0);
    const wz = num(f.z, 0);
    const h = Math.max(0, num(f.h, 0));
    const pos = projectWorldOffset(rRows, wx, wy, wz);
    const foot = projectWorldOffset(rRows, wx, wy - h, wz);
    const k: TrajectoryKeyframe = { atMs: num(f.atMs, 0), x: pos.x, y: pos.y };
    if (typeof f.rotation === 'number' && Number.isFinite(f.rotation)) k.rotation = f.rotation;
    if (typeof f.scale === 'number' && Number.isFinite(f.scale)) k.scale = f.scale;
    if (typeof f.scaleX === 'number' && Number.isFinite(f.scaleX)) k.scaleX = f.scaleX;
    if (typeof f.scaleY === 'number' && Number.isFinite(f.scaleY)) k.scaleY = f.scaleY;
    if (typeof f.alpha === 'number' && Number.isFinite(f.alpha)) k.alpha = f.alpha;
    if (foot.y !== pos.y) k.sortY = foot.y;
    out.push(k);
  }
  return out;
}

/**
 * 左右翻转一条画面空间轨迹：`x` 取反、叠加旋转取反；`y` / `sortY` / 缩放 / 透明不动。
 * 用于把"往右抛"的资产在朝左的实体上播（`playTrajectory.flipX`）。
 */
export function flipTrajectoryKeyframes(
  frames: readonly TrajectoryKeyframe[],
): TrajectoryKeyframe[] {
  const out: TrajectoryKeyframe[] = [];
  for (const f of frames) {
    if (!f || typeof f !== 'object') continue;
    const k: TrajectoryKeyframe = { ...f, x: -num(f.x, 0) };
    if (typeof f.rotation === 'number' && Number.isFinite(f.rotation)) k.rotation = -f.rotation;
    out.push(k);
  }
  return out;
}
