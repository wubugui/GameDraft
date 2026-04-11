import type { AnimationSetDef } from './types';

/** JSON 中 worldWidth / worldHeight 可只填其一，运行时按单格像素长宽比推导另一维；两者都填则沿用（兼容旧资源）。 */
export type AnimationSetDefInput = Omit<AnimationSetDef, 'worldWidth' | 'worldHeight'> & {
  worldWidth?: number;
  worldHeight?: number;
};

const DEFAULT_WORLD_WIDTH = 100;

/** 单格像素尺寸：JSON 可显式写 cellWidth/cellHeight，否则按纹理与 cols/rows 推导。 */
export function effectiveCellPixelSize(
  input: AnimationSetDefInput,
  texturePixelWidth: number,
  texturePixelHeight: number,
): { cellW: number; cellH: number } {
  const cols = Math.max(1, input.cols);
  const rows = Math.max(1, input.rows);
  let cellW: number;
  let cellH: number;
  if (typeof input.cellWidth === 'number' && input.cellWidth > 0) {
    cellW = input.cellWidth;
  } else {
    cellW = texturePixelWidth / cols;
  }
  if (typeof input.cellHeight === 'number' && input.cellHeight > 0) {
    cellH = input.cellHeight;
  } else {
    cellH = texturePixelHeight / rows;
  }
  return { cellW, cellH };
}

export function resolveAnimationWorldSize(
  input: AnimationSetDefInput,
  texturePixelWidth: number,
  texturePixelHeight: number,
): { worldWidth: number; worldHeight: number } {
  const { cellW: frameW, cellH: frameH } = effectiveCellPixelSize(
    input,
    texturePixelWidth,
    texturePixelHeight,
  );
  const aspectHW = frameH / frameW;

  const wRaw = input.worldWidth;
  const hRaw = input.worldHeight;
  const w = typeof wRaw === 'number' && wRaw > 0 ? wRaw : undefined;
  const h = typeof hRaw === 'number' && hRaw > 0 ? hRaw : undefined;

  if (w !== undefined && h !== undefined) {
    return { worldWidth: w, worldHeight: h };
  }
  if (w !== undefined) {
    return { worldWidth: w, worldHeight: Math.round(w * aspectHW * 1e6) / 1e6 };
  }
  if (h !== undefined) {
    return { worldWidth: Math.round((h / aspectHW) * 1e6) / 1e6, worldHeight: h };
  }
  const worldWidth = DEFAULT_WORLD_WIDTH;
  return { worldWidth, worldHeight: Math.round(worldWidth * aspectHW * 1e6) / 1e6 };
}

export function normalizeAnimationSetDef(
  input: AnimationSetDefInput,
  texturePixelWidth: number,
  texturePixelHeight: number,
): AnimationSetDef {
  const { cellW, cellH } = effectiveCellPixelSize(input, texturePixelWidth, texturePixelHeight);
  const { worldWidth, worldHeight } = resolveAnimationWorldSize(input, texturePixelWidth, texturePixelHeight);
  return {
    ...input,
    worldWidth,
    worldHeight,
    cellWidth: Math.round(cellW * 1e6) / 1e6,
    cellHeight: Math.round(cellH * 1e6) / 1e6,
  };
}
