import { describe, expect, it, vi } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Sprite } from '../../../../src/engine2d/sprite/Sprite';
import { Texture } from '../../../../src/engine2d/textures/Texture';
import { ImageSource } from '../../../../src/engine2d/textures/TextureSource';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';

function run(resource: object) {
  const rhi = new NullRhiDevice();
  const canvas = { width: 8, height: 8, style: {} } as unknown as HTMLCanvasElement;
  const renderer = new WebGPURenderer({ rhi, canvas, width: 8, height: 8 });
  const up = vi.spyOn(rhi, 'uploadImage');
  const src = new ImageSource({ resource: resource as never });
  const root = new Container();
  root.addChild(new Sprite(new Texture({ source: src })));
  renderer.render({ container: root });
  const r = { pw: src.pixelWidth, ph: src.pixelHeight, uploads: up.mock.calls.length };
  renderer.destroy();
  return r;
}

describe('video upload', () => {
  it('image-like control uploads', () => {
    const r = run({ width: 16, height: 16, naturalWidth: 16, naturalHeight: 16 });
    console.log('image', r);
    expect(r.uploads).toBe(1);
  });
  it('video element (width attr 0, videoWidth 16) never uploads', () => {
    const r = run({ width: 0, height: 0, videoWidth: 16, videoHeight: 16 });
    console.log('video', r);
    expect(r.pw).toBe(16);
    expect(r.uploads).toBe(0); // divergence: Pixi would copyExternalImageToTexture / texImage2D
  });
});
