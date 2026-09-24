/**
 * 雷自带的灯：落点一盏点光 + 沿雷身的线光 + 天上一记平行光，三种都打反光位（反光只在表面材质区里算，
 * 平行光按铺满天的面光算——见 SceneLightingPass）。线光强度走同一条包络。
 */
import { describe, expect, it } from 'vitest';
import { StrikeLightRig, strikeEnvelope } from './strikeLight';

describe('落雷的灯 · 雷身线光 / 天光 / 反光位', () => {
  const spec = {
    pos: [0, 40, 0] as [number, number, number], intensity: 2, durationMs: 200, kelvin: 11000, reflect: true,
    lines: [
      { from: [0, 0, 0] as [number, number, number], to: [10, 300, 0] as [number, number, number], intensity: 3, range: 5000 },
      { from: [10, 300, 0] as [number, number, number], to: [0, 600, 0] as [number, number, number], intensity: 0, range: 5000 },
    ],
    sky: { intensity: 0.5, elevationDeg: 65, azimuthDeg: 30 },
  };

  it('主闪那一帧：点光 + 强度 > 0 的线光 + 天光，全部带反光位', () => {
    const rig = new StrikeLightRig();
    rig.start(spec);
    const lights = rig.update(0)!;
    expect(lights.map((l) => l.kind)).toEqual(['point', 'line', 'directional']);
    expect(lights.every((l) => l.reflect === true)).toBe(true);
    const line = lights[1];
    expect(line.pos).toEqual([0, 0, 0]);
    expect(line.to).toEqual([10, 300, 0]);
    expect(line.intensity).toBeCloseTo(3 * strikeEnvelope(0), 9);
    const sky = lights[2];
    expect(sky.elevationDeg).toBe(65);
    expect(sky.intensity).toBeCloseTo(0.5, 9);
  });

  it('没要反光位的旧单灯：一盏点光、不带反光位', () => {
    const rig = new StrikeLightRig();
    rig.start({ pos: [0, 240, 0], intensity: 7, durationMs: 210 });
    const lights = rig.update(0)!;
    expect(lights.length).toBe(1);
    expect(lights[0].kind).toBe('point');
    expect(lights[0].reflect).toBeUndefined();
  });

  it('到点收灯：推一次空表，之后恒 null', () => {
    const rig = new StrikeLightRig();
    rig.start(spec);
    rig.update(0);
    expect(rig.update(250)).toEqual([]);
    expect(rig.update(16)).toBeNull();
  });
});
