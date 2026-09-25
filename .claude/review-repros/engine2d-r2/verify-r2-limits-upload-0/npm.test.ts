/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Sprite } from '../../../../src/engine2d/sprite/Sprite';
import { Texture } from '../../../../src/engine2d/textures/Texture';
import { RenderTexture } from '../../../../src/engine2d/textures/RenderTexture';
import { ImageSource } from '../../../../src/engine2d/textures/TextureSource';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';
import { gpuUploadImageResource } from 'pixi.js';
import { ImageSource as PixiImageSource } from 'pixi.js';

describe('no-premultiply-alpha ImageBitmap upload', () => {
  it('branch sends premultipliedAlpha:false to copyExternalImage (same as Pixi WebGPU)', () => {
    const rhi = new NullRhiDevice();
    const canvas = { width: 16, height: 16, style: {} } as unknown as HTMLCanvasElement;
    const renderer = new WebGPURenderer({ rhi, canvas, width: 16, height: 16 });
    const up = vi.spyOn(rhi, 'uploadImage');
    const rt = RenderTexture.create({ width: 16, height: 16 });
    const bmp = { width: 4, height: 4 } as any;
    const root = new Container();
    root.addChild(new Sprite(new Texture({ source: new ImageSource({ resource: bmp, alphaMode: 'no-premultiply-alpha' }) })));
    renderer.render({ container: root, target: rt });
    const branchFlag = (up.mock.calls[0][2] as any).premultiplyAlpha;

    // Pixi WebGPU uploader for the same source
    const calls: any[] = [];
    const gpu = { device: { queue: { copyExternalImageToTexture: (...a: any[]) => calls.push(a) } } };
    const ps = new PixiImageSource({ resource: bmp, alphaMode: 'no-premultiply-alpha' });
    gpuUploadImageResource.upload(ps as any, { width: 4, height: 4 } as any, gpu as any);
    const pixiGpuFlag = calls[0][1].premultipliedAlpha;
    console.log({ branchFlag, pixiGpuFlag });
    expect(branchFlag).toBe(false);
    expect(pixiGpuFlag).toBe(false);
    // Master (Pixi WebGL) instead: pixelStorei(UNPACK_PREMULTIPLY_ALPHA_WEBGL,false) + texImage2D(ImageBitmap);
    // WebGL spec ignores UNPACK_* for ImageBitmap -> texture keeps decode-time premultiplied bytes.
    // copyExternalImageToTexture(premultipliedAlpha:false) converts a premultiplied ImageBitmap to straight alpha.
  });
});
