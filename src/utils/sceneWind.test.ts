import { describe, expect, it } from 'vitest';
import {
  resolveSceneWind, windGustBasis, windGustClock, windGustFromBasis, windGustMul, windPhase, WIND_GUST_BASIS,
} from './sceneWind';

const W = resolveSceneWind({
  direction: [-1, 0, -0.25], speed: 400, gust: { amount: 0.8, period: 7 }, veer: 14,
  turbulence: { intensity: 0.35, scale: 140 }, roughness: 1,
})!;

describe('sceneWind 阵风批量求值', () => {
  it('和角拆分与 windGustMul(t + off) 同一个值', () => {
    const basis = new Float32Array(WIND_GUST_BASIS);
    const clock = new Float32Array(WIND_GUST_BASIS);
    for (const [x, z] of [[0, 0], [812.5, -340], [-1500, 2200], [37, 91]]) {
      const off = windPhase(W, 0, x, z);
      windGustBasis(W, off, basis, 0);
      for (const t of [0, 0.37, 5.2, 61.9]) {
        windGustClock(W, t, clock);
        expect(windGustFromBasis(W, clock, basis, 0)).toBeCloseTo(windGustMul(W, windPhase(W, t, x, z)), 4);
      }
    }
  });

  it('windPhase 的点相关部分与 t 可分离', () => {
    expect(windPhase(W, 3.5, 120, -80)).toBeCloseTo(3.5 + windPhase(W, 0, 120, -80), 10);
  });
});
