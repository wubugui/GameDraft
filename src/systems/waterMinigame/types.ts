import type { ActionDef } from '../../data/types';

export type WaterCategory = 'sunken' | 'swimming' | 'floating' | 'grass';
export type PullRhythm = 'stable' | 'burst' | 'spasm' | 'heavy_sink';
export type FailurePolicy = 'escape' | 'snap' | 'bite';

/** 玩法权重：超额捕捞日后隐藏 premium */
export type WaterValueTier = 'normal' | 'premium';

export interface WaterMinigameInstance {
  id: string;
  label: string;
  /** 用于反刷计数；缺省等于 id */
  spotId?: string;
  /** 水底层：先写入水底 MRT，再叠水下物体，最后统一过水面 pass */
  waterBottom?: {
    texture?: string;
    tint?: string;
    /**
     * 水域光学系数（>=0）。背景：`系数 × suv.y`；物体：`系数 × 参数 RT.R`。不写则默认 1。
     */
    depth?: number;
  };
  /** 可选岸边前景。水面只支持两条岸边；不配置则不显示。 */
  shoreForeground?: {
    banks: WaterShoreBankDef[];
  };
  surface: {
    location: string;
    time: 'morning' | 'day' | 'night';
    weather: 'clear' | 'rain' | 'fog';
  };
  bounds: { width: number; height: number };
  entities: WaterEntityDef[];
}

export interface WaterShoreBankDef {
  /** `/assets/...` 或 `assets/...`，建议使用透明 PNG */
  sprite: string;
  /** 岸边贴在哪一侧；同一水域最多配置两条岸边 */
  edge: 'top' | 'bottom' | 'left' | 'right';
  /** 岸边厚度，单位为水域 bounds 像素；横岸为高，竖岸为宽 */
  thickness?: number;
  /** 沿垂直于岸边方向的偏移，单位为水域 bounds 像素；正值向水域内推 */
  inset?: number;
  /** 沿岸方向额外拉宽/拉高，单位为水域 bounds 像素，用于遮住边角 */
  overhang?: number;
  alpha?: number;
}

export interface WaterEntityDef {
  id: string;
  category: WaterCategory;
  /** `/assets/...` 或 `assets/...`，加载失败时用占位图 */
  sprite: string;
  pos: { x: number; y: number };
  /** >=0，浅深标量；可大于 1，用于光学路径（水面 shader）；精灵明暗仍按饱和后的可视深度估算 */
  depth: number;
  motion?: {
    path: 'stationary' | 'drift' | 'patrol' | 'approach' | 'flee';
    speed: number;
    jitter?: number;
  };
  depthOsc?: {
    curve: 'none' | 'sine' | 'approach_surface' | 'random_walk';
    amplitude: number;
    period: number;
  };
  glow?: { enabled: boolean; color: string; daylightHint?: number };
  /**
   * 显示尺寸（贴图最长边缩放目标，bounds 像素）。
   * 缺省按品类默认：grass 70 / sunken 62 / floating 46 / swimming 52。
   * 大型实体（如水猴子影）由数据显式放大，不再由引擎按贴图路径猜测。
   */
  displaySize?: number;
  /** 识别阶段点击命中半径（bounds 像素）。缺省按品类默认：grass 42 / swimming 34 / sunken 38 / floating 30。 */
  hitRadius?: number;
  pull?: {
    zoneSize: number;
    sliderSpeed: number;
    rhythm: PullRhythm;
    failurePolicy: FailurePolicy;
    /** 限时秒；缺省按 rhythm / policy 给默认 */
    timeLimitSec?: number;
  };
  /** 识别阶段悬浮提示（可走 strings key） */
  cue?: string;
  hint?: string;
  valueTier?: WaterValueTier;
  /** 得手后从该局移除并跨局记账（拉扯成功 / floating 捞取 onPick 皆适用）；给奖励的实体应置 true 防无限刷 */
  consumeOnSuccess?: boolean;
  onPick?: ActionDef[];
  onPullSuccess?: ActionDef[];
  onPullFail?: ActionDef[];
}

export interface WaterMinigameIndexEntry {
  id: string;
  label: string;
  file: string;
}
