/**
 * GpuTextures.get 在纹理源 _resourceId 变了(resize)重建 RHI 纹理时,每次都给源再挂一对 destroy / unload 监听,旧的不摘。
 */
import { describe, expect, it } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Sprite } from '../../../../src/engine2d/sprite/Sprite';
import { Texture } from '../../../../src/engine2d/textures/Texture';
import { RenderTexture } from '../../../../src/engine2d/textures/RenderTexture';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';

describe('GpuTextures listener growth', () => {
  it('resizing a RenderTexture N times adds N unload listeners', () => {
    const rhi = new NullRhiDevice();
    const canvas = { width: 8, height: 8, style: {} } as unknown as HTMLCanvasElement;
    const renderer = new WebGPURenderer({ rhi, canvas, width: 8, height: 8 });
    const rt = RenderTexture.create({ width: 8, height: 8 });
    const root = new Container();
    root.addChild(new Sprite(Texture.WHITE));
    const counts: number[] = [];
    for (let i = 0; i < 20; i++) {
      rt.source.resize(8 + i, 8 + i);
      renderer.render({ container: root, target: rt });
      counts.push(rt.source.listenerCount('unload'));
    }
    console.log('unload listeners after each resize+render:', counts.join(','));
    expect(counts[counts.length - 1]).toBeGreaterThan(5);
    renderer.destroy();
  });
});
