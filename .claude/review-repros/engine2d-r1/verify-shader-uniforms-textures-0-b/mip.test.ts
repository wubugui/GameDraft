import { describe, expect, it, vi } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import type { RhiTextureDesc } from '../../../../src/rendering/rhi';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Sprite } from '../../../../src/engine2d/sprite/Sprite';
import { Texture } from '../../../../src/engine2d/textures/Texture';
import { Rectangle } from '../../../../src/engine2d';
import { TextureSource } from '../../../../src/engine2d/textures/TextureSource';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';
import { TextureSource as PixiTS } from 'pixi.js';

describe('HUD flame sheet mips', () => {
  it('branch: autoGenerateMipmaps after load -> texture created with 1 level', () => {
    const rhi = new NullRhiDevice();
    const canvas = { width: 64, height: 64, style: {} } as unknown as HTMLCanvasElement;
    const renderer = new WebGPURenderer({ rhi, canvas, width: 64, height: 64 });
    const createTexture = vi.spyOn(rhi, 'createTexture');
    const src = new TextureSource({ resource: new Uint8Array(588 * 612 * 4), width: 588, height: 612, label: 'flame' } as any);
    (src as any).uploadMethodId = 'buffer';
    src.autoGenerateMipmaps = true;
    src.scaleMode = 'linear';
    src.update();
    const frame = new Texture({ source: src, frame: new Rectangle(0, 0, 49, 102) });
    const sp = new Sprite(frame); sp.scale.set(0.25);
    const root = new Container(); root.addChild(sp);
    renderer.render({ container: root });
    const descs = createTexture.mock.calls.map((c) => c[1] as RhiTextureDesc).filter((d) => d.label === 'flame');
    console.log('branch descs', descs.map((d) => ({ w: d.width, h: d.height, mip: d.mipLevels })), 'mipLevelCount', src.mipLevelCount);
    console.log('log mip-ish', rhi.log.filter((l) => /mip/i.test(l)));
    // pixi: fresh source defaults
    const p = new PixiTS({ resource: new Uint8Array(4), width: 1, height: 1 } as any);
    console.log('pixi default mipLevelCount', p.mipLevelCount, 'auto', p.autoGenerateMipmaps);
    expect(descs[0].mipLevels ?? 1).toBe(1);
    renderer.destroy();
  });
});
