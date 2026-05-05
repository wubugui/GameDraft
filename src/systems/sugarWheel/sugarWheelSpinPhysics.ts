import type { SugarWheelInstance, SugarWheelSectorDef } from './types';

export const TAU = Math.PI * 2;

/** 与各格 weight 合成角向势能时的默认强度（rad/s²），与 `SugarWheelMinigameScene` 保持一致。 */
export const DEFAULT_SPIN_WEIGHT_BIAS_STRENGTH_RAD_PER_S2 = 4.2;

/** weight=0 时按这个下限折算高度，避免 -ln(0) 无限大。 */
export const MIN_SPIN_TERRAIN_WEIGHT = 0.05;

/** 默认干摩擦角加速度（rad/s²），与角速度反向，避免轻拨时只靠 k·ω 拖出长尾巴。≤0 可由实例关闭。 */
export const DEFAULT_SPIN_DRY_FRICTION_ACCEL_RAD_PER_SEC2 = 0.34;

/** 低于该角速度时对 weight 扭矩按 |ω|/ref 缩放，末端不再被势能条「顶住」慢悠悠转。（≤0 关闭） */
export const DEFAULT_SPIN_BIAS_CREEP_REF_RAD_PER_SEC = 1.2;

export function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function normalizeAngle(value: number): number {
  return ((value % TAU) + TAU) % TAU;
}

export function degToRad(value: number): number {
  return (value / 180) * Math.PI;
}

export interface SugarWheelSectorLayout {
  readonly n: number;
  readonly step: number;
  readonly left0: number;
}

export function sectorLayoutFromInstance(instance: SugarWheelInstance): SugarWheelSectorLayout {
  const sectors = instance.sectors;
  const n = sectors.length;
  if (n <= 0) return { n: 0, step: TAU, left0: 0 };
  const step = TAU / n;
  const offset = degToRad(finiteOr(instance.sectorAngleOffsetDeg, 0));
  const phase =
    typeof instance.sectorCenterPhase === 'number' && Number.isFinite(instance.sectorCenterPhase)
      ? instance.sectorCenterPhase
      : 0;
  const left0 = offset + phase * step;
  return { n, step, left0 };
}

export function sectorIndexFromWheelGeomAngle(geomMod: number, layout: SugarWheelSectorLayout): number {
  const { n, step, left0 } = layout;
  if (n <= 0) return 0;
  const rel = normalizeAngle(geomMod - left0);
  let idx = Math.floor(rel / step + 1e-9);
  idx = ((idx % n) + n) % n;
  return idx;
}

function sectorWeightOrDefault(sec: SugarWheelSectorDef | undefined): number {
  const w = sec?.weight;
  if (typeof w === 'number' && Number.isFinite(w) && w >= 0) return w;
  return 1;
}

export function spinWeightBiasScale(instance: SugarWheelInstance): number {
  const cfg = instance.spinWeightBiasStrengthRadPerSec2;
  return typeof cfg === 'number' && Number.isFinite(cfg) && cfg > 0
    ? cfg
    : DEFAULT_SPIN_WEIGHT_BIAS_STRENGTH_RAD_PER_S2;
}

/** 与 `{ sinSum, cosSum }`：α_bias = scale·sinSum（与势能关系：−dU/dφ = −scale·Σ h sin ≡ α_bias）；U = scale·cosSum。 */
function weightTerrainHarmonicComponents(
  phi: number,
  instance: SugarWheelInstance,
): { sinSum: number; cosSum: number } {
  const sectors = instance.sectors;
  const layout = sectorLayoutFromInstance(instance);
  const { n, step, left0 } = layout;
  if (n <= 0) return { sinSum: 0, cosSum: 0 };

  let sinSum = 0;
  let cosSum = 0;
  for (let i = 0; i < n; i++) {
    const rawWeight = i < sectors.length ? sectorWeightOrDefault(sectors[i]) : 1;
    const terrainWeight = Math.max(MIN_SPIN_TERRAIN_WEIGHT, rawWeight);
    const height = -Math.log(terrainWeight);
    const ci = left0 + (i + 0.5) * step;
    const d = phi - ci;
    sinSum += height * Math.sin(d);
    cosSum += height * Math.cos(d);
  }
  return { sinSum, cosSum };
}

/** 与各格合成角向标量势能 U(φ)=scale·Σ (−ln w_i)·cos(φ−c_i)；−dU/dφ 与 {@link weightDerivedBiasAccel} 一致。仅用于体感，不作概率刻度。 */
export function weightTerrainPotential(phi: number, instance: SugarWheelInstance): number {
  const scale = spinWeightBiasScale(instance);
  return scale * weightTerrainHarmonicComponents(phi, instance).cosSum;
}

/**
 * weight → 跑道高度场。height_i=-ln(weight_i)：1 为平地，>1 为低谷，<1 为高坡。
 * 用 h(φ)=Σ height_i·cos(φ−c_i) 近似起伏跑道，α_bias=-dh/dφ=Σ height_i·sin(φ−c_i)·scale。
 * 这只表达体感难易，不把 weight 校准为精确中奖率。
 */
export function weightDerivedBiasAccel(phi: number, instance: SugarWheelInstance): number {
  const scale = spinWeightBiasScale(instance);
  return scale * weightTerrainHarmonicComponents(phi, instance).sinSum;
}

export interface SpinStepInput {
  instance: SugarWheelInstance;
  omega: number;
  alpha: number;
  /** 判格几何角 φ（弧度，与指针 rotation 相差 pointerArtOffset） */
  phiGeom: number;
  dt: number;
}

/**
 * 单步转盘角状态：α 衰减、线性阻力、k(ω)、weight 偏置（临界角速下削弱）、干摩擦收尾、θ 欧拉。
 */
export function advanceSugarWheelSpinStep(inp: SpinStepInput): {
  omega: number;
  alpha: number;
  phiGeom: number;
} {
  let { instance, omega, alpha, phiGeom, dt } = inp;
  dt = clamp(dt, 0, 0.05);

  const halfLife = finiteOr(instance.spinAccelHalfLifeSec, 0.42);
  if (halfLife > 1e-5) {
    alpha *= Math.pow(0.5, dt / halfLife);
  } else {
    alpha = 0;
  }

  const k = spinDragEffectiveK(omega, instance);
  let biasAccel = weightDerivedBiasAccel(phiGeom, instance);

  const creepCfg = instance.spinWeightBiasCreepRefRadPerSec;
  let creepRef: number;
  if (creepCfg === undefined || creepCfg === null) {
    creepRef = DEFAULT_SPIN_BIAS_CREEP_REF_RAD_PER_SEC;
  } else if (typeof creepCfg === 'number' && Number.isFinite(creepCfg) && creepCfg > 1e-6) {
    creepRef = creepCfg;
  } else {
    creepRef = NaN;
  }
  if (Number.isFinite(creepRef) && creepRef > 1e-6) {
    const wAbs = Math.abs(omega);
    if (wAbs < creepRef) {
      biasAccel *= clamp(wAbs / creepRef, 0, 1);
    }
  }

  omega += (alpha - k * omega + biasAccel) * dt;

  const dryCfg = instance.spinDryFrictionAccelRadPerSec2;
  let dry =
    typeof dryCfg === 'number' && Number.isFinite(dryCfg)
      ? Math.max(0, dryCfg)
      : DEFAULT_SPIN_DRY_FRICTION_ACCEL_RAD_PER_SEC2;
  if (!(dryCfg === undefined || dryCfg === null) && typeof dryCfg === 'number' && dryCfg <= 0) {
    dry = 0;
  }

  if (dry > 1e-11 && Math.abs(omega) > 1e-24) {
    const sgn = Math.sign(omega);
    const dec = dry * dt;
    if (Math.abs(omega) <= dec) {
      omega = 0;
    } else {
      omega -= sgn * dec;
    }
  }

  phiGeom = normalizeAngle(phiGeom + omega * dt);
  return { omega, alpha, phiGeom };
}

export function spinDragEffectiveK(omega: number, instance: SugarWheelInstance): number {
  const k0 = Math.max(0, finiteOr(instance.spinLinearDragPerSec, 0.58));
  const kFloor = 0.035;
  const thr = finiteOr(instance.spinDragLowSpeedThresholdRadPerSec, 0);
  const boost = Math.max(0, finiteOr(instance.spinDragLowSpeedBoostPerSec, 0));
  if (thr <= 1e-6 || boost <= 1e-6) {
    return Math.max(kFloor, k0);
  }
  const w = Math.abs(omega);
  const rawT = clamp(1 - w / thr, 0, 1);
  const blend = rawT * rawT * rawT * (rawT * (rawT * 6 - 15) + 10);
  return Math.max(kFloor, k0 + boost * blend);
}

export interface SimulateSugarWheelLandingOptions {
  /** 不传则每次试验用 rng() 作为蓄力比例 [0,1) */
  power?: number;
  /** 不传则每次试验用 rng()*2π 作为初始判格角 φ */
  initialPhiRad?: number;
  maxSteps?: number;
}

/**
 * 与运行时 `SugarWheelMinigameScene` 转盘阶段积分同构（Δt≤0.05s 对齐），便于自动化蒙特卡洛。
 * `rng()` 取值范围 [0,1)；未固定 power / initialPhiRad 时为每次抽样。
 */
export function simulateSugarWheelLanding(
  instance: SugarWheelInstance,
  rng: () => number,
  opts: SimulateSugarWheelLandingOptions = {},
): number {
  const layout = sectorLayoutFromInstance(instance);
  if (layout.n <= 0) return 0;

  const phi0 =
    opts.initialPhiRad !== undefined ? normalizeAngle(opts.initialPhiRad) : normalizeAngle(rng() * TAU);
  const power = opts.power !== undefined ? clamp(opts.power, 0, 1) : clamp(rng(), 0, 1);

  const sign = instance.sectorDirection === 'counterclockwise' ? -1 : 1;
  let omega =
    sign *
    lerp(
      finiteOr(instance.spinChargeMinVelocityRadPerSec, 0),
      finiteOr(instance.spinChargeMaxVelocityRadPerSec, 11),
      power,
    );
  let alpha =
    sign *
    lerp(
      finiteOr(instance.spinChargeMinAccelRadPerSec2, 0),
      finiteOr(instance.spinChargeMaxAccelRadPerSec2, 9),
      power,
    );

  let phi = phi0;
  let settleAccum = 0;
  const dt = 0.05;
  const maxSteps = opts.maxSteps ?? 400_000;
  const stopEps = Math.max(1e-3, finiteOr(instance.spinStopSpeedRadPerSec, 0.06));
  const settleNeed = Math.max(0, finiteOr(instance.spinStopSettleSec, 0.085));

  for (let i = 0; i < maxSteps; i++) {
    const out = advanceSugarWheelSpinStep({
      instance,
      omega,
      alpha,
      phiGeom: phi,
      dt,
    });
    omega = out.omega;
    alpha = out.alpha;
    phi = out.phiGeom;

    if (Math.abs(omega) < stopEps) {
      settleAccum += dt;
      if (settleAccum >= settleNeed) {
        return sectorIndexFromWheelGeomAngle(phi, layout);
      }
    } else {
      settleAccum = 0;
    }
  }

  return sectorIndexFromWheelGeomAngle(phi, layout);
}
