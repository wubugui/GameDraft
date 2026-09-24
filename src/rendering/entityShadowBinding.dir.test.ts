import { describe, expect, it } from 'vitest';

import type { LightDef } from '../data/types';
import {
  lightDirFromShadowScreenAngle,
  resolveBindingLightDir,
  resolveBoundShadow,
  type ShadowBindingContext,
} from './entityShadowBinding';

/**
 * 胶囊 AO 方向部分「跟阴影绑定」「场景主光」两档的方向（缺省档「按光照」见 contactAoSources.test.ts）。
 * 这里守两件事：屏幕约定 ↔ 世界方向的换算是投屏的**逆**（与投影剪影同一个方向）；只出方向、仰角只钳下限。
 */

const C45 = Math.SQRT1_2;
const M_PITCH45 = [1, 0, 0, 0, C45, -C45, 0, C45, C45];
const MPQ = 880;

function ctx(lights: LightDef[], over: Partial<ShadowBindingContext> = {}): ShadowBindingContext {
  return {
    charWorld: [0, 0, 0], wuPerQUnit: MPQ, mRows: M_PITCH45, lights,
    skyIntensity: 1, charHeightQ: 150 / MPQ, ...over,
  };
}

/** 影子方向（指向光的反方向的水平分量）投到屏幕上的角度，与 entityShadowBinding.shadowScreenAngle 同式。 */
function shadowScreenDegOf(L: readonly number[], m: readonly number[]): number {
  const hx = -L[0], hz = -L[2];
  const qx = m[0] * hx + m[6] * hz;
  const qy = m[1] * hx + m[7] * hz;
  return (Math.atan2(-qy, qx) * 180) / Math.PI;
}

const norm = (v: readonly number[]) => Math.hypot(v[0], v[1], v[2]);
const elevDeg = (v: readonly number[]) => (Math.atan2(v[1], Math.hypot(v[0], v[2])) * 180) / Math.PI;
const angDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

describe('lightDirFromShadowScreenAngle：屏幕约定 → 指向光的世界方向', () => {
  it.each([0, 37, 90, 135, 200, 305])('影子屏幕朝向 %i° 投回屏幕还是它（是投屏的逆）', (deg) => {
    const L = lightDirFromShadowScreenAngle(deg, 45, M_PITCH45)!;
    expect(norm(L)).toBeCloseTo(1, 9);
    expect(angDiff(shadowScreenDegOf(L, M_PITCH45), deg)).toBeLessThan(1e-6);
    expect(elevDeg(L)).toBeCloseTo(45, 6);
  });

  it('仰角只钳下限 25°（与投影剪影同口径）；不封 80° 顶——方向 AO 在正上方就是脚下一团，封顶会让方向过顶时硬翻', () => {
    expect(elevDeg(lightDirFromShadowScreenAngle(90, 5, M_PITCH45)!)).toBeCloseTo(25, 6);
    expect(elevDeg(lightDirFromShadowScreenAngle(90, 89, M_PITCH45)!)).toBeCloseTo(89, 6);
  });

  it('影子朝屏幕正下方（朝镜头）⇒ 光在远离镜头那侧（世界 +Z）', () => {
    const L = lightDirFromShadowScreenAngle(90, 45, M_PITCH45)!;
    expect(L[2]).toBeGreaterThan(0.5);
    expect(Math.abs(L[0])).toBeLessThan(1e-9);
  });
});

describe('resolveBindingLightDir：一条绑定 → 方向', () => {
  it('虚拟灯：与投影剪影同一个屏幕朝向', () => {
    const b = { source: 'virtual' as const, virtual: { azimuthDeg: 60, elevationDeg: 40, darkness: 0.6, softness: 0.5, length: 0 } };
    const L = resolveBindingLightDir(b, ctx([]))!;
    const sol = resolveBoundShadow(b, ctx([]))!;
    expect(angDiff(shadowScreenDegOf(L, M_PITCH45), sol.screenAngleDeg)).toBeLessThan(1e-6);
  });

  it('场景点光：指向灯位（q 里 3,4,0 → 方向 (0.6,0.8,0)），与灯的远近强弱无关', () => {
    const lamp: LightDef = { id: 'lamp', kind: 'point', intensity: 10, pos: [3 * MPQ, 4 * MPQ, 0], range: 50 * MPQ };
    const L = resolveBindingLightDir({ source: 'light:lamp' }, ctx([lamp]))!;
    expect(L[0]).toBeCloseTo(0.6, 9);
    expect(L[1]).toBeCloseTo(0.8, 9);
    expect(L[2]).toBeCloseTo(0, 9);
    const weak = resolveBindingLightDir({ source: 'light:lamp' }, ctx([{ ...lamp, intensity: 1e-6, range: 1 }]))!;
    expect(weak).toEqual(L);
  });

  it('none / 灯查不到 / 灯关着 ⇒ null（只画无方向部分）', () => {
    const lamp: LightDef = { id: 'lamp', kind: 'point', intensity: 10, pos: [MPQ, MPQ, 0] };
    expect(resolveBindingLightDir({ source: 'none' }, ctx([lamp]))).toBeNull();
    expect(resolveBindingLightDir({ source: 'light:nope' }, ctx([lamp]))).toBeNull();
    expect(resolveBindingLightDir({ source: 'light:lamp' }, ctx([{ ...lamp, enabled: false }]))).toBeNull();
  });
});
