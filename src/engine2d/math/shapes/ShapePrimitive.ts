/**
 * 形状基本接口。移植自 PixiJS v8.17(MIT):maths/shapes/ShapePrimitive + maths/misc/const 的 SHAPE_PRIMITIVE。
 * Graphics 的路径把每个图元存成一个 ShapePrimitive,三角化 / 命中 / 包围盒都按 `type` 分派。
 */
import type { Rectangle } from '../Rectangle';

export type SHAPE_PRIMITIVE = 'polygon' | 'rectangle' | 'circle' | 'ellipse' | 'triangle' | 'roundedRectangle';

export interface ShapePrimitive {
  /** 形状类别(避免 instanceof) */
  readonly type: SHAPE_PRIMITIVE | (string & {});
  /** 点是否在形状内 */
  contains(x: number, y: number): boolean;
  /** 点是否在形状的描边内(alignment:1 = 内描,0.5 = 居中,0 = 外描) */
  strokeContains(x: number, y: number, strokeWidth: number, alignment?: number): boolean;
  clone(): ShapePrimitive;
  copyFrom(source: ShapePrimitive): void;
  copyTo(destination: ShapePrimitive): void;
  /** 外接矩形 */
  getBounds(out?: Rectangle): Rectangle;
  readonly x: number;
  readonly y: number;
}
