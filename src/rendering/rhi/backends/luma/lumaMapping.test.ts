import { describe, expect, it } from 'vitest';
import { Buffer as LumaBuffer, Texture as LumaTexture } from '@luma.gl/core';
import { RhiBlend, RhiBufferUsage, RhiTextureUsage } from '../../types';
import type { RhiShader } from '../../RhiDevice';
import {
  stripRowPadding,
  toLumaBufferLayout,
  toLumaBufferUsage,
  toLumaPipelineParameters,
  toLumaSamplerProps,
  toLumaTextureUsage,
} from './lumaMapping';

describe('lumaMapping', () => {
  it('用途位逐位映射到 luma 的常量(不是自家位值原样透传)', () => {
    expect(toLumaBufferUsage(RhiBufferUsage.VERTEX | RhiBufferUsage.COPY_DST)).toBe(LumaBuffer.VERTEX | LumaBuffer.COPY_DST);
    expect(toLumaBufferUsage(RhiBufferUsage.STORAGE | RhiBufferUsage.COPY_SRC)).toBe(LumaBuffer.STORAGE | LumaBuffer.COPY_SRC);
    expect(toLumaBufferUsage(RhiBufferUsage.INDEX | RhiBufferUsage.UNIFORM | RhiBufferUsage.INDIRECT))
      .toBe(LumaBuffer.INDEX | LumaBuffer.UNIFORM | LumaBuffer.INDIRECT);
    expect(toLumaTextureUsage(RhiTextureUsage.SAMPLED | RhiTextureUsage.RENDER_TARGET)).toBe(LumaTexture.SAMPLE | LumaTexture.RENDER);
    expect(toLumaTextureUsage(RhiTextureUsage.STORAGE | RhiTextureUsage.COPY_SRC | RhiTextureUsage.COPY_DST))
      .toBe(LumaTexture.STORAGE | LumaTexture.COPY_SRC | LumaTexture.COPY_DST);
  });

  it('去行填充:纹理回读的行跨度按 256 字节对齐', () => {
    // 3×2 的 rgba8,每行真实 12 字节,填充到 16
    const src = new Uint8Array(32);
    for (let i = 0; i < 12; i++) {
      src[i] = i + 1;
      src[16 + i] = 101 + i;
    }
    const out = stripRowPadding(src, 3, 2, 4, 16);
    expect(out.length).toBe(24);
    expect(Array.from(out.subarray(0, 12))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(out[12]).toBe(101);
    // 无填充时原样(拷贝)
    const tight = stripRowPadding(out, 3, 2, 4, 12);
    expect(Array.from(tight)).toEqual(Array.from(out));
    expect(tight).not.toBe(out);
  });

  it('顶点布局与管线状态', () => {
    const layout = toLumaBufferLayout([
      { name: 'quad', stride: 16, attributes: [{ name: 'aPos', format: 'float32x2', offset: 0 }, { name: 'aUv', format: 'float32x2', offset: 8 }] },
      { name: 'inst', stride: 16, stepMode: 'instance', attributes: [{ name: 'aOffset', format: 'float32x4', offset: 0 }] },
    ]);
    expect(layout[0]).toEqual({
      name: 'quad', byteStride: 16, stepMode: 'vertex',
      attributes: [{ attribute: 'aPos', format: 'float32x2', byteOffset: 0 }, { attribute: 'aUv', format: 'float32x2', byteOffset: 8 }],
    });
    expect(layout[1].stepMode).toBe('instance');

    const shader = {} as RhiShader;
    const opaque = toLumaPipelineParameters({ label: 'p', shader, colorFormats: ['rgba8unorm'] });
    expect(opaque.blend).toBe(false);
    expect(opaque.cullMode).toBe('none');
    expect(opaque.depthFormat).toBeUndefined();

    const add = toLumaPipelineParameters({ label: 'p', shader, colorFormats: ['rgba16float'], blend: RhiBlend.additive, depthFormat: 'depth24plus' });
    expect(add).toMatchObject({
      blend: true, blendColorSrcFactor: 'one', blendColorDstFactor: 'one', blendColorOperation: 'add',
      depthFormat: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less-equal',
    });
  });

  it('采样器缺省 clamp + 线性;给了 compare 就是比较采样器', () => {
    expect(toLumaSamplerProps({})).toMatchObject({ addressModeU: 'clamp-to-edge', magFilter: 'linear', mipmapFilter: 'none' });
    expect(toLumaSamplerProps({ compare: 'less' })).toMatchObject({ type: 'comparison-sampler', compare: 'less' });
  });

  it('W 寻址 / LOD 夹取 / 各向异性给了就转发,没给不写(R2-3)', () => {
    expect(toLumaSamplerProps({ addressModeW: 'repeat', lodMinClamp: 1, lodMaxClamp: 3, maxAnisotropy: 8 })).toMatchObject({
      addressModeW: 'repeat', lodMinClamp: 1, lodMaxClamp: 3, maxAnisotropy: 8,
    });
    const plain = toLumaSamplerProps({});
    for (const k of ['addressModeW', 'lodMinClamp', 'lodMaxClamp', 'maxAnisotropy']) expect(k in plain).toBe(false);
  });
});
