import { describe, it } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { Container, Sprite, Texture, RenderTexture, WebGPURenderer } from '../../../../src/engine2d';
describe('invisible root render', () => {
  it('clears?', () => {
    const rhi = new NullRhiDevice();
    const canvas = { width: 8, height: 8, style: {} } as unknown as HTMLCanvasElement;
    const renderer = new WebGPURenderer({ rhi, canvas, width: 8, height: 8 } as any);
    const rt = RenderTexture.create({ width: 8, height: 8 }); rt.source.label = 'rt';
    const root = new Container(); root.addChild(new Sprite(Texture.WHITE));
    renderer.render({ container: root, target: rt, clear: true });
    const n1 = rhi.log.length;
    root.visible = false;
    renderer.render({ container: root, target: rt, clear: true, clearColor: [1, 0, 0, 1] });
    console.log('log after visible render', rhi.log.slice(n1 - 3, n1).join(' || '));
    console.log('new entries after invisible render:', rhi.log.slice(n1));
  });
});
