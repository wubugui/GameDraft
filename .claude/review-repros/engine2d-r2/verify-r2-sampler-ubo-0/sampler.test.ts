import { describe, expect, it, vi } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { GpuTextures } from '../../../../src/engine2d/gpu/GpuTextures';
import { TextureStyle } from '../../../../src/engine2d/textures/TextureStyle';
import { TextureStyle as PixiTextureStyle } from 'pixi.js';

describe('GpuTextures.sampler drops anisotropy / lod clamps', () => {
  it('forwards only U/V/filters/compare', () => {
    const rhi = new NullRhiDevice();
    const scope = (rhi as any).createScope ? (rhi as any).createScope('t') : (rhi as any);
    const spy = vi.spyOn(rhi, 'createSampler');
    const gt = new GpuTextures(rhi as any, { createSampler: (d: any) => rhi.createSampler(scope, d) } as any, { now: 0 });
    const plain = new TextureStyle({ scaleMode: 'linear', mipmapFilter: 'linear' });
    const aniso = new TextureStyle({ scaleMode: 'linear', mipmapFilter: 'linear', maxAnisotropy: 8, lodMinClamp: 0, lodMaxClamp: 0, addressModeW: 'repeat' });
    const s1 = gt.sampler(plain);
    const s2 = gt.sampler(aniso);
    expect(s1).not.toBe(s2); // separate cache entries
    const descs = spy.mock.calls.map((c) => { const { label, ...rest } = c[1] as any; return rest; });
    console.log('plain key', plain._key, '\naniso key', aniso._key);
    console.log('descs', JSON.stringify(descs));
    // Pixi WebGPU hands the whole style (with maxAnisotropy etc.) to device.createSampler
    const p = new PixiTextureStyle({ scaleMode: 'linear', mipmapFilter: 'linear', maxAnisotropy: 8, lodMaxClamp: 0 } as any);
    console.log('pixi style fields', (p as any).maxAnisotropy, (p as any).lodMaxClamp);
    expect(descs[0]).toEqual(descs[1]); // divergence: identical GPU sampler descs
    expect('maxAnisotropy' in descs[1]).toBe(false);
    expect('lodMaxClamp' in descs[1]).toBe(false);
  });
});
