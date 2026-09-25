/**
 * 纹理填充的 uv 矩阵(顶点 → uv)。移植自 PixiJS v8.17(MIT):scene/graphics/shared/utils/generateTextureFillMatrix。
 * 注意与 Pixi 相同的副作用:非渐变纹理若是 clamp-to-edge,会被改成 repeat。
 */
import { Matrix } from '../../math/Matrix';
import { Rectangle } from '../../math/Rectangle';
import type { ShapePrimitive } from '../../math/shapes/ShapePrimitive';
import { FillGradient } from '../fill/FillGradient';
import type { ConvertedFillStyle, ConvertedStrokeStyle } from '../FillTypes';

const tempTextureMatrix = new Matrix();
const tempRect = new Rectangle();

export function generateTextureMatrix(
  out: Matrix,
  style: ConvertedFillStyle | ConvertedStrokeStyle,
  shape: ShapePrimitive,
  matrix?: Matrix,
): Matrix {
  const textureMatrix = style.matrix ? out.copyFrom(style.matrix).invert() : out.identity();
  if (style.textureSpace === 'local') {
    const bounds = shape.getBounds(tempRect);
    if ((style as ConvertedStrokeStyle).width) {
      bounds.pad((style as ConvertedStrokeStyle).width);
    }
    const { x: tx, y: ty } = bounds;
    const sx = 1 / bounds.width;
    const sy = 1 / bounds.height;
    const mTx = -tx * sx;
    const mTy = -ty * sy;
    const a1 = textureMatrix.a;
    const b1 = textureMatrix.b;
    const c1 = textureMatrix.c;
    const d1 = textureMatrix.d;
    textureMatrix.a *= sx;
    textureMatrix.b *= sx;
    textureMatrix.c *= sy;
    textureMatrix.d *= sy;
    textureMatrix.tx = mTx * a1 + mTy * c1 + textureMatrix.tx;
    textureMatrix.ty = mTx * b1 + mTy * d1 + textureMatrix.ty;
  } else {
    textureMatrix.translate(style.texture!.frame.x, style.texture!.frame.y);
    textureMatrix.scale(1 / style.texture!.source.width, 1 / style.texture!.source.height);
  }
  const sourceStyle = style.texture!.source.style;
  if (!(style.fill instanceof FillGradient) && sourceStyle.addressMode === 'clamp-to-edge') {
    sourceStyle.addressMode = 'repeat';
    sourceStyle.update();
  }
  if (matrix) {
    textureMatrix.append(tempTextureMatrix.copyFrom(matrix).invert());
  }
  return textureMatrix;
}
