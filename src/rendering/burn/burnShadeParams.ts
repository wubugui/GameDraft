/**
 * 燃烧着色参数（`burnShade.glsl` 的 uniform 值）从可燃物资产怎么来。纯函数、零 Pixi：
 * 游戏（`BurnSystem` → 两道燃烧滤镜）与燃烧工作台的预览调的是同一个，别在别处另拼。
 */
import type { ResolvedBurnable } from '../../data/burnables';
import { kelvinToLinearRgb } from '../lighting/kelvin';

/** 着色参数（每可燃物一份，材质与自发光两道滤镜共用） */
export interface BurnShadeParams {
  gridW: number;
  gridH: number;
  now: number;
  timeStep: number;
  flameSeconds: number;
  emberSeconds: number;
  scorchSeconds: number;
  ashFadeSeconds: number;
  edgeNoise: number;
  scorchColor: readonly [number, number, number];
  charColor: readonly [number, number, number];
  ashColor: readonly [number, number, number];
  ashAlpha: number;
  /** 线性发光色 × 强度 */
  glow: readonly [number, number, number];
  emberGlow: readonly [number, number, number];
}

/** 色温 → 线性色，按最大分量归一再乘强度（火线 / 余烬的自发光） */
function glowOf(kelvin: number, strength: number): [number, number, number] {
  const lin = kelvinToLinearRgb(kelvin);
  const m = Math.max(lin[0], lin[1], lin[2], 1e-6);
  return [lin[0] / m * strength, lin[1] / m * strength, lin[2] / m * strength];
}

/** `clock` = 模拟的 `shaderClock(key)`（此刻 + 纹理时间步） */
export function burnShadeParamsOf(
  b: ResolvedBurnable, grid: { nx: number; ny: number }, clock: { now: number; timeStep: number },
): BurnShadeParams {
  const look = b.look;
  return {
    gridW: grid.nx,
    gridH: grid.ny,
    now: clock.now,
    timeStep: clock.timeStep,
    flameSeconds: b.flameSeconds,
    emberSeconds: b.emberSeconds,
    scorchSeconds: look.scorchSeconds,
    ashFadeSeconds: look.ashFadeSeconds,
    edgeNoise: look.edgeNoise,
    scorchColor: look.scorchColor,
    charColor: look.charColor,
    ashColor: look.ashColor,
    ashAlpha: look.ashAlpha,
    glow: glowOf(look.glowKelvin, look.glowStrength),
    emberGlow: glowOf(look.emberKelvin, look.emberStrength),
  };
}
