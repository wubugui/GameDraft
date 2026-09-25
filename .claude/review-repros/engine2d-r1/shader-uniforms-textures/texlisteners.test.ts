import { describe, expect, it } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Sprite } from '../../../../src/engine2d/sprite/Sprite';
import { Texture } from '../../../../src/engine2d/textures/Texture';
import { RenderTexture } from '../../../../src/engine2d/textures/RenderTexture';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';

describe('GpuTextures listeners on resize', () => {
  it('accumulate', () => {
    const rhi = new NullRhiDevice();
    const canvas = { width: 0, height: 0, style: {} } as unknown as HTMLCanvasElement;
    const renderer = new WebGPURenderer({ rhi, canvas, width: 8, height: 8 });
    const rt = RenderTexture.create({ width: 8, height: 8 });
    const root = new Container(); root.addChild(new Sprite(Texture.WHITE));
    const counts: number[] = [];
    for (let i = 0; i < 5; i++) {
      rt.resize(8 + i, 8 + i);
      renderer.render({ container: root, target: rt });
      counts.push(rt.source.listenerCount('unload'), rt.source.listenerCount('destroy'));
    }
    console.log('unload/destroy listener counts', counts.join(','));
    renderer.destroy();
  });
});
