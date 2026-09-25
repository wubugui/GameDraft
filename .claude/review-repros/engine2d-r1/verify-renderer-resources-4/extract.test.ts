import { describe, expect, it, vi } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';
import { RenderTexture } from '../../../../src/engine2d/textures/RenderTexture';
import { GlTextureSystem } from 'pixi.js';

// GPU memory content: one pixel, premultiplied: straight (128,128,128,128) -> premult (64,64,64,128); plus opaque + transparent
const GPU = new Uint8Array([64, 64, 64, 128, 200, 100, 50, 255, 0, 0, 0, 0, 10, 20, 30, 40]);

describe('extract parity', () => {
  it('pixels: engine2d vs Pixi WebGL getPixels', async () => {
    const rhi = new NullRhiDevice();
    const canvas = { width: 4, height: 4, style: {} } as unknown as HTMLCanvasElement;
    const renderer = new WebGPURenderer({ rhi, canvas, width: 4, height: 4 });
    vi.spyOn(rhi, 'readTexture').mockImplementation(async () => ({ width: 4, height: 1, format: 'rgba8unorm', data: GPU } as any));
    const rt = RenderTexture.create({ width: 4, height: 1 });
    const e2d = await renderer.extract.pixels(rt as any);

    // Pixi WebGL getPixels with a fake gl that fills the same bytes
    const fakeGl: any = { FRAMEBUFFER: 1, RGBA: 2, UNSIGNED_BYTE: 3, bindFramebuffer() {}, readPixels(_x: number, _y: number, _w: number, _h: number, _f: number, _t: number, out: Uint8Array) { out.set(GPU); } };
    const sys: any = Object.create((GlTextureSystem as any).prototype);
    sys._renderer = { gl: fakeGl, renderTarget: { getRenderTarget: () => ({}), getGpuRenderTarget: () => ({ resolveTargetFramebuffer: {} }) } };
    const pixi = sys.getPixels({ source: { resolution: 1 }, frame: { x: 0, y: 0, width: 4, height: 1 } });
    console.log('engine2d', JSON.stringify(Array.from(e2d.pixels)));
    console.log('pixi-gl ', JSON.stringify(Array.from(pixi.pixels)));
    expect(Array.from(e2d.pixels)).not.toEqual(Array.from(pixi.pixels));
    renderer.destroy();
  });

  it('base64 mime for jpg', async () => {
    const rhi = new NullRhiDevice();
    const canvas = { width: 4, height: 4, style: {} } as unknown as HTMLCanvasElement;
    const renderer = new WebGPURenderer({ rhi, canvas, width: 4, height: 4 });
    vi.spyOn(rhi, 'readTexture').mockImplementation(async () => ({ width: 4, height: 1, format: 'rgba8unorm', data: GPU } as any));
    const calls: unknown[][] = [];
    const fakeCanvas: any = { getContext: () => ({ createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {} }), toDataURL: (...a: unknown[]) => { calls.push(a); return 'data:'; } };
    (globalThis as any).document = { createElement: () => fakeCanvas };
    const rt = RenderTexture.create({ width: 4, height: 1 });
    await renderer.extract.base64({ target: rt as any, format: 'jpg' } as any);
    await renderer.extract.base64({ target: rt as any, format: 'png' } as any);
    console.log('toDataURL calls', JSON.stringify(calls));
    expect(calls[0][0]).toBe('image/jpg');
    renderer.destroy();
  });
});
