/**
 * 行走面深度场（实验室 `walk_depth` → `lighting/ground_d.png`）。
 *
 * 这是伪世界重建里**条件数最好**的一层：地面在标定时被显式拉平，非地面结构的高度轴
 * 反而未标定（还叠了 relief 增益）。因此凡是需要「实体站在哪个深度」的地方——角色/热点
 * 的遮挡脚点、投影阴影的落地面、碰撞格反投影——都以本场为准，不再用 `floor_depth_A/B`
 * 那条全图最小二乘直线（该直线在多层街巷场景可偏出 200+ 行地面）。
 *
 * 单位与 `depth_map` 解码出的 sceneDepth 完全一致（同为实验室 q 空间深度，越小越近）。
 */
export interface GroundDepthField {
  /** work 分辨率的深度值（行优先） */
  data: Float32Array;
  w: number;
  h: number;
}

/**
 * 双线性采样：入参为 work 像素坐标（可越界，内部钳制到场内）。
 * 场是平滑的地面高度场，work-res（通常 512×N）足够，无需原生分辨率。
 */
export function sampleGroundField(
  data: Float32Array,
  w: number,
  h: number,
  px: number,
  py: number,
): number {
  const xi = Math.max(0, Math.min(w - 1.001, px));
  const yi = Math.max(0, Math.min(h - 1.001, py));
  const x0 = Math.floor(xi), y0 = Math.floor(yi);
  const fx = xi - x0, fy = yi - y0;
  const i00 = y0 * w + x0;
  const i10 = i00 + 1;
  const i01 = i00 + w;
  return data[i00] * (1 - fx) * (1 - fy) + data[i10] * fx * (1 - fy)
    + data[i01] * (1 - fx) * fy + data[i01 + 1] * fx * fy;
}

/** 世界坐标直采（场景世界宽高 → work 像素）。 */
export function sampleGroundFieldWorld(
  field: GroundDepthField,
  sceneWorldW: number,
  sceneWorldH: number,
  worldX: number,
  worldY: number,
): number {
  return sampleGroundField(
    field.data, field.w, field.h,
    (worldX / Math.max(sceneWorldW, 1e-6)) * field.w,
    (worldY / Math.max(sceneWorldH, 1e-6)) * field.h,
  );
}
