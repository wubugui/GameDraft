/**
 * 线光（落雷的雷身灯）与反光位的打包：kind 码 4、A = 起点、D.xyz = 终点 − 起点（世界向量）、flags bit2 = reflect；
 * 强度按点光同一套 q 相对口径折（× wuPerQUnit²）。着色器那边按同一格式读（SceneLightingPass / CharacterLitSprite）。
 */
import { describe, expect, it } from 'vitest';
import type { SceneLightingDef } from '../../data/types';
import { LIGHT_FLAG_REFLECT, LIGHT_KIND_CODE, packLights, pointIntensityWu } from './lightPacking';

const MPQ = 880;

function def(lights: SceneLightingDef['lights']): SceneLightingDef {
  return {
    sky: { intensity: 1, hemi: 0.7, color: [1, 1, 1] },
    lights,
    display: { ev: 0, tonemap: 'filmic', whiteKelvin: 6500, contrast: 1, saturation: 1, lift: 0, liftKelvin: 6500 },
  } as SceneLightingDef;
}

describe('打包 · 线光与反光位', () => {
  it('线光：kind 4，起点进 A，D.xyz 是整条线的世界向量，强度与同强度点光同一套折法', () => {
    const p = packLights(def([
      { id: 'l', kind: 'line', pos: [100, 0, 50], to: [130, 400, 50], intensity: 2, range: 5000, kelvin: 11000, reflect: true },
      { id: 'pt', kind: 'point', pos: [0, 40, 0], intensity: 2, range: 5000 },
    ]), MPQ);
    expect(p.count).toBe(2);
    expect(p.a[3]).toBe(LIGHT_KIND_CODE.line);
    expect([p.a[0], p.a[1], p.a[2]]).toEqual([100, 0, 50]);
    expect([p.d[0], p.d[1], p.d[2]]).toEqual([30, 400, 0]);
    expect(p.d[3] & LIGHT_FLAG_REFLECT).toBe(LIGHT_FLAG_REFLECT);
    expect(p.b[3]).toBeCloseTo(p.b[7], 9);
    expect(p.b[7]).toBeCloseTo(pointIntensityWu(2, MPQ), 6);
    expect(p.d[7] & LIGHT_FLAG_REFLECT).toBe(0);
  });

  it('没写反光位 = 不反光（平时的作者灯一律不进镜面项）', () => {
    const p = packLights(def([{ id: 'l', kind: 'line', pos: [0, 0, 0], to: [0, 100, 0], intensity: 1 }]), MPQ);
    expect(p.d[3] & LIGHT_FLAG_REFLECT).toBe(0);
  });
});
