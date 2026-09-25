/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Sprite } from '../../../../src/engine2d/sprite/Sprite';
import { Texture } from '../../../../src/engine2d/textures/Texture';
import { RenderTexture } from '../../../../src/engine2d/textures/RenderTexture';
import { ImageSource, BufferImageSource } from '../../../../src/engine2d/textures/TextureSource';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';

describe('upload flags', () => {
  it('premultiply flag per alphaMode; buffer raw', () => {
    const rhi = new NullRhiDevice();
    const canvas = { width: 64, height: 64, style: {} } as unknown as HTMLCanvasElement;
    const renderer = new WebGPURenderer({ rhi, canvas, width: 64, height: 64 });
    const up = vi.spyOn(rhi, 'uploadImage');
    const wt = vi.spyOn(rhi, 'writeTexture');
    const rt = RenderTexture.create({ width: 64, height: 64 });
    const fakeBmp = { width: 8, height: 8 } as any;
    const modes = ['premultiply-alpha-on-upload', 'premultiplied-alpha', 'no-premultiply-alpha'] as const;
    const root = new Container();
    for (const m of modes) root.addChild(new Sprite(new Texture({ source: new ImageSource({ resource: fakeBmp, alphaMode: m }) })));
    const buf = new BufferImageSource({ resource: new Uint16Array(4 * 4 * 4), width: 4, height: 4, format: 'rgba16float', alphaMode: 'no-premultiply-alpha' });
    root.addChild(new Sprite(new Texture({ source: buf })));
    renderer.render({ container: root, target: rt });
    console.log(up.mock.calls.map((c) => JSON.stringify(c[2])), wt.mock.calls.length);
    expect(up.mock.calls.map((c) => (c[2] as any).premultiplyAlpha)).toEqual([true, false, false]);
  });
});
