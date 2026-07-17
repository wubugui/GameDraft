/**
 * 实体实例级 transform（quad 级真变换）的统一数学口径。
 *
 * 语义（设计稿：artifact/Design/场景编辑器Unity对齐-调研与影响半径-2026-07-17.md B1）：
 * - `scale`（等比，缺省 1）与 `rotation`（度，缺省 0）绕**脚底锚点** (x, y) 施加；
 * - 锚点世界坐标不变——凡从实体「范围（extent）」派生的空间量（碰撞多边形、
 *   交互半径、阴影尺寸、气泡头顶、深度接地线、遮挡多边形）一律经本模块换算，
 *   运行时改字段后下一帧求值即正确；
 * - 编辑器画布必须与本口径一致（防"预览撒谎"）。
 */

export interface EntityInstanceTransformSource {
  scale?: number;
  rotation?: number;
}

/** 实例等比缩放；非法/缺省回落 1。 */
export function entityScaleOf(def: EntityInstanceTransformSource | null | undefined): number {
  const raw = def?.scale;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return 1;
  return raw;
}

/** 实例旋转（度）；非法/缺省回落 0。 */
export function entityRotationDegOf(def: EntityInstanceTransformSource | null | undefined): number {
  const raw = def?.rotation;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  return raw;
}

export function entityRotationRadOf(def: EntityInstanceTransformSource | null | undefined): number {
  return (entityRotationDegOf(def) * Math.PI) / 180;
}

export function hasInstanceTransform(def: EntityInstanceTransformSource | null | undefined): boolean {
  return entityScaleOf(def) !== 1 || entityRotationDegOf(def) !== 0;
}

/** 把「相对锚点的局部向量」按实例 transform 变换（先缩放后旋转）。 */
export function transformLocalVector(
  lx: number,
  ly: number,
  def: EntityInstanceTransformSource | null | undefined,
): { x: number; y: number } {
  const s = entityScaleOf(def);
  const rad = entityRotationRadOf(def);
  const sx = lx * s;
  const sy = ly * s;
  if (rad === 0) return { x: sx, y: sy };
  const c = Math.cos(rad);
  const n = Math.sin(rad);
  return { x: sx * c - sy * n, y: sx * n + sy * c };
}

/**
 * 底中锚 quad（宽 w、高 h，锚点在底边中点）的变换后 AABB（世界坐标）。
 * w/h 传**有效尺寸**（已含实例 scale）——本函数只做旋转扩展，避免双重缩放。
 */
export function quadAabbAroundFoot(
  anchorX: number,
  anchorY: number,
  effW: number,
  effH: number,
  rotationRad: number,
): { left: number; top: number; width: number; height: number } {
  if (rotationRad === 0) {
    return { left: anchorX - effW / 2, top: anchorY - effH, width: effW, height: effH };
  }
  const c = Math.cos(rotationRad);
  const n = Math.sin(rotationRad);
  const hw = effW / 2;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [lx, ly] of [
    [-hw, 0],
    [hw, 0],
    [hw, -effH],
    [-hw, -effH],
  ] as const) {
    const x = anchorX + lx * c - ly * n;
    const y = anchorY + lx * n + ly * c;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { left: minX, top: minY, width: maxX - minX, height: maxY - minY };
}

/** 变换后 quad 的接地线（底边最大世界 y）：深度排序键。无旋转时 = 锚点 y。 */
export function quadGroundYAroundFoot(
  anchorY: number,
  effW: number,
  effH: number,
  rotationRad: number,
): number {
  if (rotationRad === 0) return anchorY;
  const aabb = quadAabbAroundFoot(0, anchorY, effW, effH, rotationRad);
  return aabb.top + aabb.height;
}

/** 变换后 quad 顶部相对锚点的局部 y（负值）：气泡头顶锚。无旋转时 = -effH。 */
export function quadTopLocalYAroundFoot(
  effW: number,
  effH: number,
  rotationRad: number,
): number {
  if (rotationRad === 0) return -effH;
  const aabb = quadAabbAroundFoot(0, 0, effW, effH, rotationRad);
  return aabb.top;
}
