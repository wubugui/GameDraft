import { describe, expect, it } from 'vitest';
import {
  CONTACT_AO_DIR_CONE_DEG_DEFAULT,
  CONTACT_AO_DIR_LENGTH_DEFAULT,
  CONTACT_AO_DIR_SOURCE_DEFAULT,
  CONTACT_AO_DIRECTIONAL_DEFAULT,
  CONTACT_AO_DIR_STRENGTH_DEFAULT,
  CONTACT_AO_FADE_IN_MS_DEFAULT,
  CONTACT_AO_FADE_OUT_MS_DEFAULT,
  CONTACT_AO_SPREAD_DEFAULT,
  coneKFromDeg,
  resolveContactAo,
  resolveContactAoDirection,
} from './contactAo';

const SCENE = { contact: 0.75, contactSize: 1.2 };

describe('resolveContactAo：作者面 → 着色参数（制作人 2026-09-24 定的作者面）', () => {
  it('什么都没写：开、方向 AO 也开、明暗 / 大小跟随场景、其余取缺省', () => {
    expect(resolveContactAo(undefined, SCENE)).toEqual({
      enabled: true,
      fadeInMs: CONTACT_AO_FADE_IN_MS_DEFAULT,
      fadeOutMs: CONTACT_AO_FADE_OUT_MS_DEFAULT,
      directional: true,
      dirSource: CONTACT_AO_DIR_SOURCE_DEFAULT,
      darkness: 0.75,
      size: 1.2,
      spread: CONTACT_AO_SPREAD_DEFAULT,
      dirStrength: CONTACT_AO_DIR_STRENGTH_DEFAULT,
      dirLength: CONTACT_AO_DIR_LENGTH_DEFAULT,
      coneK: coneKFromDeg(CONTACT_AO_DIR_CONE_DEG_DEFAULT),
    });
  });

  it('方向来源缺省「最近的灯」，写了就用写的，不认识的值当没写', () => {
    expect(CONTACT_AO_DIR_SOURCE_DEFAULT).toBe('lighting');
    expect(resolveContactAo({ dirSource: 'binding' }, SCENE).dirSource).toBe('binding');
    expect(resolveContactAo({ dirSource: 'scene' }, SCENE).dirSource).toBe('scene');
    expect(resolveContactAo({ dirSource: 'bogus' as never }, SCENE).dirSource).toBe('lighting');
  });

  it('方向 AO 缺省开（制作人 2026-09-24：所有 NPC 默认都开，包括主角），显式 false 才关', () => {
    expect(CONTACT_AO_DIRECTIONAL_DEFAULT).toBe(true);
    expect(resolveContactAo({}, SCENE).directional).toBe(true);
    expect(resolveContactAo({ directional: false }, SCENE).directional).toBe(false);
    expect(resolveContactAo({ directional: 'no' as never }, SCENE).directional).toBe(true);
  });

  it('实体写了明暗 / 大小就用实体的，不跟场景', () => {
    const r = resolveContactAo({ darkness: 0.4, size: 2 }, SCENE);
    expect(r.darkness).toBe(0.4);
    expect(r.size).toBe(2);
  });

  it('越界钳住、非数字当没写', () => {
    const r = resolveContactAo({ darkness: 3, size: -1, dirStrength: Number.NaN }, SCENE);
    expect(r.darkness).toBe(1);
    expect(r.size).toBe(0);
    expect(r.dirStrength).toBe(CONTACT_AO_DIR_STRENGTH_DEFAULT);
  });

  it('动画渐变时长接受立即切换与小数，越界钳住，无效值用默认', () => {
    expect(resolveContactAo({ fadeInMs: 0, fadeOutMs: 123.45 }, SCENE)).toMatchObject({
      fadeInMs: 0, fadeOutMs: 123.45,
    });
    expect(resolveContactAo({ fadeInMs: -1, fadeOutMs: 6000 }, SCENE)).toMatchObject({
      fadeInMs: 0, fadeOutMs: 5000,
    });
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, '250', false]) {
      expect(resolveContactAo({ fadeInMs: invalid as number, fadeOutMs: invalid as number }, SCENE)).toMatchObject({
        fadeInMs: 1000, fadeOutMs: 1000,
      });
    }
  });
});

describe('coneKFromDeg：半影锥角越大越软（k 越小）', () => {
  it('单调', () => {
    expect(coneKFromDeg(10)).toBeGreaterThan(coneKFromDeg(32));
    expect(coneKFromDeg(32)).toBeGreaterThan(coneKFromDeg(60));
  });
  it('32° ≈ 0.8（上一版手调的 k）', () => {
    expect(coneKFromDeg(32)).toBeCloseTo(0.8, 2);
  });
});

describe('AO 方向两层覆盖', () => {
  const manual = { mode: 'manual' as const, azimuthDeg: 120, elevationDeg: 5 };
  it('未设置的角色继承场景；没有场景设置时自动', () => {
    expect(resolveContactAoDirection({ size: 2 }, manual)).toEqual({ source: 'manual', azimuthDeg: 120, elevationDeg: 5 });
    expect(resolveContactAoDirection(undefined)).toEqual({ source: 'lighting' });
  });
  it('角色自动可覆盖场景手动，角色手动可覆盖场景自动', () => {
    expect(resolveContactAoDirection({ direction: { mode: 'auto' } }, manual)).toEqual({ source: 'lighting' });
    expect(resolveContactAoDirection({ direction: manual }, { mode: 'auto' })).toEqual({ source: 'manual', azimuthDeg: 120, elevationDeg: 5 });
  });
  it('旧显式方向保持覆盖，新的 direction 优先于旧字段', () => {
    for (const source of ['lighting', 'binding', 'scene'] as const) {
      expect(resolveContactAoDirection({ dirSource: source }, manual)).toEqual({ source });
      expect(resolveContactAoDirection({ dirSource: source, direction: { mode: 'auto' } }, manual)).toEqual({ source: 'lighting' });
    }
  });
  it('手动参数缺省、无效数值与两端角度都有稳定回落', () => {
    expect(resolveContactAoDirection({ direction: { mode: 'manual' } })).toEqual({ source: 'manual', azimuthDeg: 0, elevationDeg: 45 });
    expect(resolveContactAoDirection({ direction: { mode: 'manual', azimuthDeg: Number.NaN, elevationDeg: 90 } })).toEqual({ source: 'manual', azimuthDeg: 0, elevationDeg: 90 });
  });
});
