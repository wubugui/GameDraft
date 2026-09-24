import { describe, expect, it } from 'vitest';
import {
  CONTACT_AO_DIR_CONE_DEG_DEFAULT,
  CONTACT_AO_DIR_LENGTH_DEFAULT,
  CONTACT_AO_DIR_SOURCE_DEFAULT,
  CONTACT_AO_DIRECTIONAL_DEFAULT,
  CONTACT_AO_DIR_STRENGTH_DEFAULT,
  CONTACT_AO_SPREAD_DEFAULT,
  coneKFromDeg,
  resolveContactAo,
} from './contactAo';

const SCENE = { contact: 0.75, contactSize: 1.2 };

describe('resolveContactAo：作者面 → 着色参数（制作人 2026-09-24 定的作者面）', () => {
  it('什么都没写：开、方向 AO 也开、明暗 / 大小跟随场景、其余取缺省', () => {
    expect(resolveContactAo(undefined, SCENE)).toEqual({
      enabled: true,
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
