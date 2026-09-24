import { describe, expect, it } from 'vitest';
import { npcShadowFlags, playerShadowFlags } from './entityShadowFlags';

describe('npcShadowFlags：投影与接触 AO 分开（制作人 2026-09-23）', () => {
  it('什么都没写：两样都开', () => {
    expect(npcShadowFlags({})).toEqual({ cast: true, contact: true });
  });

  it('castShadow:false 只关投影，接触 AO 照旧开（送葬队那一排就是这个形状）', () => {
    expect(npcShadowFlags({ castShadow: false })).toEqual({ cast: false, contact: true });
  });

  it('contactAo.enabled:false 只关接触 AO', () => {
    expect(npcShadowFlags({ contactAo: { enabled: false } })).toEqual({ cast: true, contact: false });
  });

  it('两个都关：两样都关', () => {
    expect(npcShadowFlags({ castShadow: false, contactAo: { enabled: false } }))
      .toEqual({ cast: false, contact: false });
  });

  it('contactAo 里只写了别的参数：接触 AO 仍是开的', () => {
    expect(npcShadowFlags({ contactAo: { directional: true, darkness: 0.5 } }))
      .toEqual({ cast: true, contact: true });
  });
});

describe('playerShadowFlags', () => {
  it('缺省：两样都开', () => {
    expect(playerShadowFlags(undefined)).toEqual({ cast: true, contact: true });
  });
  it('playerContactAo.enabled:false 只关接触 AO，投影恒开', () => {
    expect(playerShadowFlags({ enabled: false })).toEqual({ cast: true, contact: false });
  });
});
