import { describe, it, expect } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { Container, Sprite, Texture, TextureSource, RenderTexture, WebGPURenderer } from '../../../../src/engine2d';

function setup() {
  const rhi = new NullRhiDevice();
  const canvas = { width: 8, height: 8, style: {} } as unknown as HTMLCanvasElement;
  const renderer = new WebGPURenderer({ rhi, canvas, width: 8, height: 8 } as any);
  return { rhi, renderer };
}
describe('GpuTextures listeners', () => {
  it('unload/reuse cycle', () => {
    const { renderer } = setup();
    const src = new TextureSource({ resource: new Uint8Array(16), width: 2, height: 2, format: 'rgba8unorm' } as any);
    (src as any).uploadMethodId = 'buffer';
    const tex = new Texture({ source: src });
    const root = new Container(); root.addChild(new Sprite(tex));
    const counts: number[] = [];
    for (let i = 0; i < 5; i++) {
      renderer.render({ container: root });
      counts.push(src.listenerCount('unload'), src.listenerCount('destroy'));
      src.unload();
    }
    console.log('unload/destroy listener counts per cycle', counts.join(','));
  });
  it('RT resize cycle', () => {
    const { renderer } = setup();
    const rt = RenderTexture.create({ width: 4, height: 4 });
    const root = new Container(); root.addChild(new Sprite(Texture.WHITE));
    const counts: number[] = [];
    for (let i = 0; i < 5; i++) {
      rt.resize(4 + i, 4 + i);
      renderer.render({ container: root, target: rt });
      counts.push(rt.source.listenerCount('unload'), rt.source.listenerCount('destroy'));
    }
    console.log('RT resize listener counts', counts.join(','));
  });
});
