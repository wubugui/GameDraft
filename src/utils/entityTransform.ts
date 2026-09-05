/**
 * 实体实例级 transform（quad 级真变换）的统一数学口径。
 *
 * 语义（设计稿：artifact/Design/场景编辑器Unity对齐-调研与影响半径-2026-07-17.md B1）：
 * - `scale`（等比，缺省 1）与 `rotation`（度，缺省 0）绕**锚点** (x, y) 施加；
 * - 锚点世界坐标不变——凡从实体「范围（extent）」派生的空间量（碰撞多边形、
 *   交互半径、阴影尺寸、气泡头顶、深度接地线、遮挡多边形）一律经本模块换算，
 *   运行时改字段后下一帧求值即正确；
 * - 编辑器画布必须与本口径一致（防"预览撒谎"）。
 *
 * **锚点本身可配**（2026-09-03 制作人拍板，见 {@link entityAnchorOf}）：缺省底中（脚底），
 * 于是本模块里所有名字带 `AroundFoot` 的函数**照旧成立**——它们要的"脚点"现在是
 * **接地点**（{@link anchorContactOffset} 派生），缺省锚点时接地点恒等于锚点，
 * 全部既有调用逐位不变。
 */

export interface EntityInstanceTransformSource {
  scale?: number;
  rotation?: number;
}

// ————————————————————————— 锚点（anchor）—————————————————————————
//
// 锚点 = 「实体的 (x, y) 指的是精灵身上的哪一点」，在精灵世界包围盒内归一化
// （x 0=左 1=右、y 0=顶 1=底）。它同时是实例 scale/rotation 的**支点**。
//
// 🔴 缺省 (0.5, 1) = 底中 = 脚底。这个缺省不是随便挑的：它就是 2026-09-03 之前
//    `SpriteEntity` 构造函数里写死的 `anchor.set(0.5, 1)`，所以"不写 anchor 键"
//    与"显式写 {0.5,1}"与"改造之前"三者必须**逐位相同**（安全性质，有测试钉死）。

/** 缺省锚点 X：图元横向中点。 */
export const DEFAULT_ENTITY_ANCHOR_X = 0.5;
/** 缺省锚点 Y：图元底边（脚底）。 */
export const DEFAULT_ENTITY_ANCHOR_Y = 1;

export interface EntityAnchorSource {
  anchor?: { x?: number; y?: number } | null;
}

export interface ResolvedEntityAnchor {
  x: number;
  y: number;
}

function clampAnchorComponent(raw: unknown, fallback: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  return Math.min(1, Math.max(0, raw));
}

/**
 * 解析实体锚点：非数值 / 非有限 / 缺失的分量各自回落缺省，其余夹到 [0,1]。
 * 只写一半（如 `{y: 0.5}`）是合法的。
 */
export function entityAnchorOf(
  def: EntityAnchorSource | null | undefined,
): ResolvedEntityAnchor {
  const a = def?.anchor;
  if (!a || typeof a !== 'object') {
    return { x: DEFAULT_ENTITY_ANCHOR_X, y: DEFAULT_ENTITY_ANCHOR_Y };
  }
  return {
    x: clampAnchorComponent(a.x, DEFAULT_ENTITY_ANCHOR_X),
    y: clampAnchorComponent(a.y, DEFAULT_ENTITY_ANCHOR_Y),
  };
}

/** 是不是缺省锚点（底中）。为真时全部锚点派生量恒为 0，走与改造前逐位相同的路径。 */
export function isDefaultEntityAnchor(anchorX: number, anchorY: number): boolean {
  return anchorX === DEFAULT_ENTITY_ANCHOR_X && anchorY === DEFAULT_ENTITY_ANCHOR_Y;
}

/**
 * 锚点 → **接地点**的局部偏移（未旋转、未镜像）。
 *
 * 接地点 = 精灵世界包围盒的**底边中点**，也就是锚点可配之前 `(x, y)` 的那个含义。
 * `effW`/`effH` 传**有效尺寸**（已含实例 scale 与透视系数，与 `getWorldSize()` 同口径），
 * 本函数只做归一化换算、不再乘任何东西（避免双重缩放）。
 *
 * 缺省锚点时恒返回 `(0, 0)`。
 */
export function anchorContactOffset(
  anchorX: number,
  anchorY: number,
  effW: number,
  effH: number,
): { x: number; y: number } {
  return {
    x: (DEFAULT_ENTITY_ANCHOR_X - anchorX) * effW,
    y: (DEFAULT_ENTITY_ANCHOR_Y - anchorY) * effH,
  };
}

/**
 * 只旋转、不缩放的局部向量变换。
 *
 * 与 {@link transformLocalVector} 的分工：那个吃 def 并**先乘实例 scale**，
 * 用于「还没乘过 scale 的 authored 量」；本函数用于「已经是有效尺寸派生出来的量」
 * （如 {@link anchorContactOffset} 的结果），再乘一次 scale 就是双重缩放。
 */
export function rotateLocalVector(
  lx: number,
  ly: number,
  rotationRad: number,
): { x: number; y: number } {
  if (rotationRad === 0) return { x: lx, y: ly };
  const c = Math.cos(rotationRad);
  const n = Math.sin(rotationRad);
  return { x: lx * c - ly * n, y: lx * n + ly * c };
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

/**
 * 变换后 quad 的接地线（底边最大世界 y）：深度排序键。无旋转时 = 传进来的那个 y。
 *
 * ⚠ `anchorY` 传的是**接地点** y（= 实体 y + {@link anchorContactOffset} 旋转后的 y 分量），
 * 不是实体锚点 y。理由：相对接地点，quad 恒是「底中锚、宽 effW、高 effH」——
 * 与锚点配到哪里无关，所以本函数不需要认识锚点。缺省锚点时两者相等，
 * 既有调用一字不改仍然正确。
 */
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

/**
 * 变换后**内容框**顶部相对锚点的局部 y（负值）：气泡头顶锚的精确口径。
 *
 * 与 {@link quadTopLocalYAroundFoot} 的差别在于内容框不是贴着脚点的整块 quad——它是格子内
 * 上下都内缩的一块（底边离脚点 `effBottomGap`，见 SpriteEntity.getContentBoxLocal），
 * 旋转后顶点集不同，不能拿 quad 那套算。尺寸/间距传**有效值**（已含实例 scale），
 * 本函数只做旋转。无旋转时 = -(effBottomGap + effContentH)。
 */
export function contentTopLocalYAroundFoot(
  effContentW: number,
  effContentH: number,
  effBottomGap: number,
  rotationRad: number,
): number {
  const topY = -(effBottomGap + effContentH);
  if (rotationRad === 0) return topY;
  const bottomY = -effBottomGap;
  const c = Math.cos(rotationRad);
  const n = Math.sin(rotationRad);
  const hw = effContentW / 2;
  let minY = Infinity;
  for (const [lx, ly] of [
    [-hw, bottomY],
    [hw, bottomY],
    [hw, topY],
    [-hw, topY],
  ] as const) {
    const y = lx * n + ly * c;
    if (y < minY) minY = y;
  }
  return minY;
}
