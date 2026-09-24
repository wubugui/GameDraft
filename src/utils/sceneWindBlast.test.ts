/**
 * 落雷的冲击风（`WindBlast`）：只进表现（吃场景风的粒子 / 草木摇曳），不改场景风参数、不进 `sampleSceneWind`。
 * 包络 = 极短的起风 → (1−u)² 衰到 0；从中心往外、带一点往上；半径外、太高处没有。
 */
import { describe, expect, it } from 'vitest';
import { addWindBlasts, resolveSceneWind, sampleSceneWind, SceneWindState, windBlastEnvelope } from './sceneWind';

describe('冲击风', () => {
  it('包络：开头几十毫秒升满、之后单调衰到 0，到点恒 0', () => {
    expect(windBlastEnvelope(0, 1)).toBe(0);
    expect(windBlastEnvelope(0.04, 1)).toBeCloseTo(0.96 * 0.96, 6);
    let prev = Infinity;
    for (let t = 0.05; t < 1; t += 0.05) {
      const v = windBlastEnvelope(t, 1);
      expect(v).toBeLessThanOrEqual(prev + 1e-12);
      prev = v;
    }
    expect(windBlastEnvelope(1, 1)).toBe(0);
    expect(windBlastEnvelope(-0.1, 1)).toBe(0);
  });

  it('方向从中心往外、带一点往上；离中心越远越弱，半径外为 0', () => {
    const b = [{ x: 0, z: 0, t0: 0, strength: 1000, radius: 500, duration: 1 }];
    const near = [0, 0, 0], far = [0, 0, 0], out = [0, 0, 0];
    expect(addWindBlasts(b, 0.1, 100, 0, 0, near)).toBeGreaterThan(0);
    addWindBlasts(b, 0.1, 300, 0, 0, far);
    expect(addWindBlasts(b, 0.1, 600, 0, 0, out)).toBe(0);
    expect(near[0]).toBeGreaterThan(0);
    expect(Math.abs(near[2])).toBeLessThan(1e-9);
    expect(near[1]).toBeGreaterThan(0);
    expect(near[1]).toBeLessThan(near[0]);
    expect(far[0]).toBeGreaterThan(0);
    expect(far[0]).toBeLessThan(near[0]);
    expect(out).toEqual([0, 0, 0]);
  });

  it('高处吹不到（离地远过几个人高就没有了）', () => {
    const b = [{ x: 0, z: 0, t0: 0, strength: 1000, radius: 500, duration: 1 }];
    const high = [0, 0, 0];
    expect(addWindBlasts(b, 0.1, 100, 0, 10000, high)).toBe(0);
  });

  it('SceneWindState：落一阵、按自己的钟推进、吹完自动收掉；换场景清空；场景风本身不受影响', () => {
    const def = { direction: [1, 0, 0] as [number, number, number], speed: 100 };
    const w = new SceneWindState();
    w.reset(def);
    const params = resolveSceneWind(def)!;
    const before = [0, 0, 0];
    sampleSceneWind(params, 1, 50, 50, 50, before);
    w.addBlast({ x: 0, z: 0, strength: 800, radius: 400, duration: 0.5 });
    w.addBlast({ x: 0, z: 0, strength: NaN, radius: 400, duration: 0.5 });   // 非法的不收
    expect(w.blasts.length).toBe(1);
    w.advance(0.2);
    expect(w.blasts.length).toBe(1);
    const after = [0, 0, 0];
    sampleSceneWind(params, 1, 50, 50, 50, after);
    expect(after).toEqual(before);
    w.advance(0.5);
    expect(w.blasts.length).toBe(0);
    w.addBlast({ x: 0, z: 0, strength: 800, radius: 400, duration: 5 });
    w.reset(def);
    expect(w.blasts.length).toBe(0);
    expect(w.blastTime).toBe(0);
  });
});
