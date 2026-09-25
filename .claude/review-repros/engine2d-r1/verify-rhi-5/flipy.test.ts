import { describe, it, expect } from 'vitest';
import { WebGPUTexture } from '../../../../node_modules/@luma.gl/webgpu/dist/adapter/resources/webgpu-texture.js';

describe('luma WebGPUTexture.copyExternalImage flipY', () => {
  it('drops flipY:true when forwarding to queue.copyExternalImageToTexture', () => {
    const calls: any[] = [];
    const self: any = Object.create(WebGPUTexture.prototype);
    self.handle = { label: 'fake' };
    self.device = {
      info: { gpuType: 'discrete' },
      pushErrorScope() {}, popErrorScope() {},
      handle: { queue: { copyExternalImageToTexture: (...a: any[]) => calls.push(a) } },
    };
    // same as LumaRhiDevice.uploadImage passes
    self._normalizeCopyExternalImageOptions = (o: any) => ({
      sourceX: 0, sourceY: 0, x: 0, y: 0, z: 0, mipLevel: 0, aspect: 'all', colorSpace: 'srgb',
      width: 4, height: 4, depth: 1, ...o,
    });
    const image = { width: 4, height: 4 };
    try { self.copyExternalImage({ image, premultipliedAlpha: false, flipY: true }); } catch (e) { /* popErrorScope etc. */ }
    expect(calls.length).toBe(1);
    console.log('source passed to WebGPU:', JSON.stringify({ ...calls[0][0], source: '<img>' }));
    expect(calls[0][0].flipY).toBe(false); // requested true -> silently false
  });
});
