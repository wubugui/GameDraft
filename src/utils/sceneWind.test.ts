import { describe, expect, it } from 'vitest';
import {
  resolveSceneWind, windGustBasis, windGustClock, windGustFromBasis, windGustMul, windPhase, WIND_GUST_BASIS, SceneWindState,
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

describe('authored finite scene gust', () => {
  it('uses the same envelope for shared wind and ambient, then restores latest base', async () => {
    const calls: unknown[][] = [];
    const wind = new SceneWindState((...args) => calls.push(args));
    wind.reset({ direction: [1, 0, 0], speed: 100 });
    wind.setOverride({ speedMul: 2 });
    const done = wind.startGust({ speedMultiplier: 4, durationMs: 1000, attackMs: 100, releaseMs: 200, id: 'wind', volume: .8 });
    wind.advance(.05);
    expect(wind.params!.speed).toBe(500);
    expect(calls[calls.length - 1]).toEqual(['wind', .8, .5]);
    wind.advance(.05);
    expect(wind.params!.speed).toBe(800);
    wind.advance(.8);
    expect(wind.params!.speed).toBe(500);
    wind.setOverride({ speedMul: 3 });
    wind.advance(.1);
    await done;
    expect(wind.params!.speed).toBe(300);
    expect(calls[calls.length - 1]).toEqual(['wind', undefined, 0]);
    expect(wind.gustSnapshot).toBeNull();
  });

  it('replacing, resetting, and explicit cancellation resolve waiters without leaking sound', async () => {
    const calls: unknown[][] = [];
    const wind = new SceneWindState((...args) => calls.push(args));
    wind.reset({ direction: [1, 0, 0], speed: 100 });
    const first = wind.startGust({ speedMultiplier: 2, durationMs: 1000, attackMs: 0, id: 'wind' });
    const second = wind.startGust({ speedMultiplier: 3, durationMs: 1000, attackMs: 0 });
    await first;
    expect(calls[calls.length - 1]).toEqual(['wind', undefined, 0]);
    wind.advance(0);
    wind.advance(NaN);
    expect(wind.params!.speed).toBe(300);
    wind.reset({ direction: [1, 0, 0], speed: 50 });
    await second;
    expect(wind.params!.speed).toBe(50);
    const third = wind.startGust({ speedMultiplier: 4, durationMs: 1000, attackMs: 0 });
    wind.clearGust();
    await third;
    expect(wind.params!.speed).toBe(50);
    await wind.startGust({ speedMultiplier: NaN, durationMs: 1000 });
    expect(wind.gustSnapshot).toBeNull();
  });
});
