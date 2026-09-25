import { describe, expect, it, vi } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import type { RhiTextureDesc } from '../../../../src/rendering/rhi';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Sprite } from '../../../../src/engine2d/sprite/Sprite';
import { Texture } from '../../../../src/engine2d/textures/Texture';
import { BufferImageSource } from '../../../../src/engine2d/textures/TextureSource';
import { RenderTexture } from '../../../../src/engine2d/textures/RenderTexture';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';

describe('mipmaps', () => {
  it('autoGenerateMipmaps source gets a single-level texture', () => {
    const rhi = new NullRhiDevice();
    const canvas = { width: 0, height: 0, style: {} } as unknown as HTMLCanvasElement;
    const renderer = new WebGPURenderer({ rhi, canvas, width: 8, height: 8 });
    const createTexture = vi.spyOn(rhi, 'createTexture');
    const src = new BufferImageSource({ resource: new Uint8Array(64 * 64 * 4), width: 64, height: 64, format: 'rgba8unorm', label: 'sheet' });
    src.autoGenerateMipmaps = true;
    src.scaleMode = 'linear';
    src.update();
    const sp = new Sprite(new Texture({ source: src }));
    sp.scale.set(0.25);
    const root = new Container();
    root.addChild(sp);
    renderer.render({ container: root, target: RenderTexture.create({ width: 8, height: 8 }) });
    const descs = createTexture.mock.calls.map((c) => c[1] as RhiTextureDesc).filter((d) => d.label === 'sheet');
    console.log(JSON.stringify(descs));
    expect(descs.length).toBe(1);
    expect(descs[0].mipLevels ?? 1).toBe(1);
    expect(rhi.log.some((l) => /mip/i.test(l))).toBe(false);
    renderer.destroy();
  });
});
