/**
 * Graphics 常量与线型。移植自 PixiJS v8.17(MIT):scene/graphics/shared/const。
 */

/** 描边线端 */
export type LineCap = 'butt' | 'round' | 'square';
/** 描边拐角 */
export type LineJoin = 'round' | 'bevel' | 'miter';

/** 首尾点距离小于它视为闭合 */
export const closePointEps = 1e-4;
/** 退化三角形判定阈值 */
export const curveEps = 1e-4;
