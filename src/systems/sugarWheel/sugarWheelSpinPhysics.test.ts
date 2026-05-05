import { describe, expect, it } from 'vitest';
import type { SugarWheelInstance } from './types';
import {
  TAU,
  clamp,
  normalizeAngle,
  simulateSugarWheelLanding,
  weightDerivedBiasAccel,
} from './sugarWheelSpinPhysics';

/** 可重复的 [0,1) 均匀 PRNG */
function mulberry32(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function physicsTemplate12(): Omit<SugarWheelInstance, 'sectors' | 'id' | 'label' | 'wheelImage' | 'pointerImage'> {
  return {
    sectorDirection: 'clockwise',
    sectorAngleOffsetDeg: 0,
    sectorCenterPhase: 0,
    pointerArtOffsetDeg: 0,
    spinLinearDragPerSec: 0.12,
    spinDragLowSpeedThresholdRadPerSec: 2.2,
    spinDragLowSpeedBoostPerSec: 2.0,
    spinChargeMinVelocityRadPerSec: 0,
    spinChargeMaxVelocityRadPerSec: 10.5,
    spinChargeMinAccelRadPerSec2: 0,
    spinChargeMaxAccelRadPerSec2: 8.5,
    spinAccelHalfLifeSec: 0.42,
    spinStopSpeedRadPerSec: 0.06,
    spinStopSettleSec: 0.12,
    spinDryFrictionAccelRadPerSec2: 0,
    spinWeightBiasCreepRefRadPerSec: 0,
  };
}

function makeTwelveWheel(opts: { dragonWeight?: number }): SugarWheelInstance {
  const sectors = Array.from({ length: 12 }, (_, i) => ({
    id: i === 3 ? 'dragon' : `s${i}`,
    label: `${i}`,
    ...(i === 3 && opts.dragonWeight !== undefined ? { weight: opts.dragonWeight } : {}),
  }));

  return {
    id: 'testwheel',
    label: 'test',
    wheelImage: '/assets/x.png',
    pointerImage: '/assets/y.png',
    ...physicsTemplate12(),
    sectors,
  };
}

describe('sugarWheelSpinPhysics（体感：weight 越大越易中该格，不测绝对概率）', () => {
  it('等权时 weight 偏置力矩在圆周上恒为 0（等分格）', () => {
    const inst = makeTwelveWheel({});
    const layout = inst.sectors.length;
    expect(layout).toBe(12);

    for (const phi of [0, 0.1, 1.2, 3.7, 5.9, TAU - 0.01].map((x) => normalizeAngle(x))) {
      expect(Math.abs(weightDerivedBiasAccel(phi, inst))).toBeLessThan(1e-8);
    }
  });

  // 体感契约：不保「小数 = 所写概率」，只保「同款起点下写大比写小更容易停进该格」（相对难易序）。
  it(
    '配对蒙特卡洛：同款初相+蓄力，目标格低 weight 命中率明显低于高 weight',
    () => {
      const target = 3;
      const trials = 20000;

      const lowW = makeTwelveWheel({ dragonWeight: 0.25 });
      const highW = makeTwelveWheel({ dragonWeight: 2.5 });

      let lowHit = 0;
      let highHit = 0;
      const rng = mulberry32(0xbeefcafe);
      const noopRng = (): number => {
        throw new Error('simulateSugarWheelLanding：已固定 φ/蓄力时不应再消费 rng');
      };

      for (let i = 0; i < trials; i++) {
        const phi = normalizeAngle(rng() * TAU);
        const power = clamp(rng(), 0, 1);
        const opts = { initialPhiRad: phi, power };
        if (simulateSugarWheelLanding(lowW, noopRng, opts) === target) lowHit++;
        if (simulateSugarWheelLanding(highW, noopRng, opts) === target) highHit++;
      }

      expect(highHit).toBeGreaterThan(lowHit + 400);
      expect(highHit / trials).toBeGreaterThan(lowHit / trials + 0.015);
    },
    60_000,
  );

  it('simulateSugarWheelLanding 返回合法扇区下标', () => {
    const inst = makeTwelveWheel({ dragonWeight: 0.2 });
    const rng = mulberry32(42);
    for (let i = 0; i < 500; i++) {
      const idx = simulateSugarWheelLanding(inst, rng);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(12);
    }
  });
});
