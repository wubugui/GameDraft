import { describe, expect, it } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Sprite } from '../../../../src/engine2d/sprite/Sprite';
import { Texture } from '../../../../src/engine2d/textures/Texture';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';

describe('render target null', () => {
  it('Pixi falls back to the canvas for a falsy target; engine2d throws', () => {
    const rhi = new NullRhiDevice();
    const canvas = { width: 16, height: 16, style: {} } as unknown as HTMLCanvasElement;
    const renderer = new WebGPURenderer({ rhi, canvas, width: 16, height: 16 });
    const root = new Container();
    root.addChild(new Sprite(Texture.WHITE));
    let err: unknown = null;
    try { renderer.render({ container: root, target: null as never }); } catch (e) { err = e; }
    require('fs').writeFileSync('tmp/review/r4-gpu-core/nulltarget.txt', String(err));
    expect(err).not.toBeNull();
    expect(renderer.lastObjectRendered).toBeNull();
  });
});
