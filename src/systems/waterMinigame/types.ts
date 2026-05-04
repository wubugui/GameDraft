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
  surface: {
    location: string;
    time: 'morning' | 'day' | 'night';
    weather: 'clear' | 'rain' | 'fog';
  };
  bounds: { width: number; height: number };
  entities: WaterEntityDef[];
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
  /** 拉扯成功后从该局移除（存档 consumer key) */
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
