/**
 * 填充 / 描边样式类型。移植自 PixiJS v8.17(MIT):scene/graphics/shared/FillTypes。
 */
import type { ColorSource } from '../color/Color';
import type { Matrix } from '../math/Matrix';
import type { Texture } from '../textures/Texture';
import type { LineCap, LineJoin } from './const';
import type { FillGradient } from './fill/FillGradient';
import type { FillPattern } from './fill/FillPattern';

/** 纹理坐标空间:local = 按每个形状自身包围盒归一化;global = 按图形局部坐标(像素) */
export type TextureSpace = 'local' | 'global';

export interface FillStyle {
  color?: ColorSource;
  alpha?: number;
  texture?: Texture | null;
  matrix?: Matrix | null;
  fill?: FillPattern | FillGradient | null;
  textureSpace?: TextureSpace;
}

export interface StrokeAttributes {
  width?: number;
  alignment?: number;
  cap?: LineCap;
  join?: LineJoin;
  miterLimit?: number;
  pixelLine?: boolean;
}

export interface StrokeStyle extends FillStyle, StrokeAttributes {}

export type FillInput = ColorSource | FillGradient | FillPattern | FillStyle | Texture;
export type StrokeInput = ColorSource | FillGradient | FillPattern | StrokeStyle;

/** 解析后的填充样式(color = 0xRRGGBB) */
export type ConvertedFillStyle = Omit<Required<FillStyle>, 'color'> & { color: number };
/** 解析后的描边样式 */
export type ConvertedStrokeStyle = ConvertedFillStyle & Required<StrokeAttributes>;

export type FillStyleInputs =
  | ColorSource
  | FillGradient
  | FillPattern
  | FillStyle
  | ConvertedFillStyle
  | StrokeStyle
  | ConvertedStrokeStyle;
