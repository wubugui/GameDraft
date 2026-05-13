import { BlurFilter } from 'pixi.js';

/** 未配置 game_config.entityPixelDensityMatchBlurScale 时的默认模糊倍率 */
export const DEFAULT_ENTITY_PIXEL_DENSITY_BLUR_SCALE = 0.25;

/** 背景或实体在 X/Y 方向的「源像素 / 世界单位」 */
export type TexelsPerWorld = { x: number; y: number };

/**
 * 过量采样因子：实体相对背景的 texel 密度比（>=1）。
 * k<=1 时不应施加额外低通。
 */
export function computePixelDensityK(
  frameW: number,
  frameH: number,
  worldW: number,
  worldH: number,
  dBg: TexelsPerWorld,
): number {
  if (worldW <= 0 || worldH <= 0 || dBg.x <= 0 || dBg.y <= 0) return 1;
  const dEx = frameW / worldW;
  const dEy = frameH / worldH;
  const kx = dEx / dBg.x;
  const ky = dEy / dBg.y;
  return Math.max(1, kx, ky);
}

/** BlurFilter.strength 上限（基础曲线乘 strengthScale 后再夹取） */
const BLUR_STRENGTH_CAP = 12;

/**
 * 由 k 推导 BlurFilter.strength。
 * @param strengthScale 由 game_config.entityPixelDensityMatchBlurScale 或调试覆盖提供（缺省见 DEFAULT_ENTITY_PIXEL_DENSITY_BLUR_SCALE）。
 */
export function blurStrengthFromPixelDensityK(k: number, strengthScale = 1): number {
  if (k <= 1) return 0;
  const scale = Number.isFinite(strengthScale) && strengthScale > 0 ? strengthScale : 1;
  const excess = k - 1;
  const C = 0.18;
  const strength = C * Math.sqrt(excess) * scale;
  return Math.min(BLUR_STRENGTH_CAP, strength);
}

export function createPixelDensityBlurFilter(initialStrength: number): BlurFilter {
  const s = Math.max(0, initialStrength);
  return new BlurFilter({ strength: s, quality: 3 });
}
