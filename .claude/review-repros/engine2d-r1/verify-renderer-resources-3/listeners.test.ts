import { describe, expect, it } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Sprite } from '../../../../src/engine2d/sprite/Sprite';
import { Texture } from '../../../../src/engine2d/textures/Texture';
import { TextureSource } from '../../../../src/engine2d/textures/TextureSource';
import { RenderTexture } from '../../../../src/engine2d/textures/RenderTexture';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';

function setup() {
  const rhi = new NullRhiDevice();
  const canvas = { width: 8, height: 8, style: {} } as unknown as HTMLCanvasElement;
  const renderer = new WebGPURenderer({ rhi, canvas, width: 8, height: 8 });
  return { rhi, renderer };
}
const scene = () => { const c = new Container(); c.addChild(new Sprite(Texture.WHITE)); return c; };

describe('listener growth', () => {
  it('RenderTexture resize cycles', () => {
    const { renderer } = setup();
    const rt = RenderTexture.create({ width: 8, height: 8 });
    const base = [rt.source.listenerCount('unload'), rt.source.listenerCount('destroy')];
    for (let i = 0; i < 10; i++) {
      rt.resize(8 + i + 1, 8);
      renderer.render({ container: scene(), target: rt });
    }
    const after = [rt.source.listenerCount('unload'), rt.source.listenerCount('destroy')];
    console.log('RT resize: base', base, 'after 10 resize+render', after);
    renderer.destroy();
  });
  it('sampled texture unload+reuse cycles', () => {
    const { renderer } = setup();
    const src = new TextureSource({ resource: new Uint8Array(16), width: 2, height: 2 } as any);
    const tex = new Texture({ source: src });
    for (let i = 0; i < 10; i++) {
      const c = new Container(); c.addChild(new Sprite(tex));
      renderer.render({ container: c });
      src.unload();
    }
    console.log('unload cycles: unload', src.listenerCount('unload'), 'destroy', src.listenerCount('destroy'));
    // idle rendering does not add
    const c = new Container(); c.addChild(new Sprite(tex));
    for (let i = 0; i < 10; i++) renderer.render({ container: c });
    console.log('after 10 idle frames: unload', src.listenerCount('unload'), 'destroy', src.listenerCount('destroy'));
    src.destroy();
    console.log('after destroy: unload', src.listenerCount('unload'), 'destroy', src.listenerCount('destroy'));
    renderer.destroy();
  });
});
