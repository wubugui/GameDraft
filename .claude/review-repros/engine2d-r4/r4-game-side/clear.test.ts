import { describe, expect, it } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Sprite } from '../../../../src/engine2d/sprite/Sprite';
import { Texture } from '../../../../src/engine2d/textures/Texture';
import { RenderTexture } from '../../../../src/engine2d/textures/RenderTexture';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';
import { Matrix } from '../../../../src/engine2d/math/Matrix';

function setup() {
  const rhi = new NullRhiDevice();
  const canvas = { width: 8, height: 8, style: {} } as unknown as HTMLCanvasElement;
  const renderer = new WebGPURenderer({ rhi, canvas, width: 8, height: 8 });
  return { rhi, renderer };
}

describe('contactAo clearMask', () => {
  it('empty container render with clear:true opens a clearing pass', () => {
    const { rhi, renderer } = setup();
    const rt = RenderTexture.create({ width: 8, height: 8 });
    rt.source.label = 'mask';
    const before = rhi.log.length;
    renderer.render({ container: new Container(), target: rt, clear: true, clearColor: [0, 0, 0, 0] });
    console.log(rhi.log.slice(before));
    // then caster render with clear:false and transform
    const caster = new Container();
    caster.addChild(new Sprite(Texture.WHITE));
    caster.visible = true;
    const b2 = rhi.log.length;
    renderer.render({ container: caster, target: rt, clear: false, transform: new Matrix() });
    console.log(rhi.log.slice(b2));
    renderer.destroy();
  });
});
