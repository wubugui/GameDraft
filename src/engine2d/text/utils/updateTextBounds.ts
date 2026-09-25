/**
 * 文字四边形的本地包围盒(= 纹理 orig 按锚点摆放,再扣掉 padding)。
 * 移植自 PixiJS v8.17(MIT)`scene/text/utils/updateTextBounds.mjs`。
 */
import type { ObservablePoint } from '../../math/ObservablePoint';
import type { Texture } from '../../textures/Texture';
import { updateQuadBounds, type QuadBounds } from '../../sprite/Sprite';
import type { TextStyle } from '../TextStyle';

export interface TextBatchableLike {
  texture: Texture;
  bounds?: QuadBounds;
}

export function updateTextBounds(
  batchableSprite: TextBatchableLike,
  text: { _style: TextStyle; _anchor: ObservablePoint },
): void {
  const { texture } = batchableSprite;
  const bounds = batchableSprite.bounds!;
  const padding = text._style._getFinalPadding();
  updateQuadBounds(bounds, text._anchor, texture);
  const paddingOffset = text._anchor._x * padding * 2;
  const paddingOffsetY = text._anchor._y * padding * 2;
  bounds.minX -= padding - paddingOffset;
  bounds.minY -= padding - paddingOffsetY;
  bounds.maxX -= padding - paddingOffset;
  bounds.maxY -= padding - paddingOffsetY;
}
