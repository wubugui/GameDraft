import { describe, expect, it } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Sprite } from '../../../../src/engine2d/sprite/Sprite';
import { Texture } from '../../../../src/engine2d/textures/Texture';
import { RenderTexture } from '../../../../src/engine2d/textures/RenderTexture';
import { Matrix } from '../../../../src/engine2d/math/Matrix';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';

describe('render with transform on non-root container', () => {
  it('local transform not applied twice', () => {
    const rhi = new NullRhiDevice();
    const canvas = { width: 64, height: 64, style: {} } as unknown as HTMLCanvasElement;
    const renderer = new WebGPURenderer({ rhi, canvas, width: 64, height: 64 });
    const parent = new Container();
    parent.position.set(100, 100);
    const caster = new Container();
    caster.position.set(10, 10);
    caster.scale.set(2);
    parent.addChild(caster);
    const s = new Sprite(Texture.WHITE);
    s.position.set(3, 3);
    caster.addChild(s);
    const rt = RenderTexture.create({ width: 64, height: 64 });
    const T = new Matrix().translate(5, 7);
    renderer.render({ container: caster, target: rt, clear: false, transform: T });
    const st = (renderer as any).states[0];
    const f32 = new Float32Array(st.batcher.attr, 0, 8);
    // global uniform worldTransform should equal T; vertices = sprite local (3,3)
    const gu = st.builder.guStack?.[0] ?? null;
    const out = { v0: [f32[0], f32[1]], wt: gu && [gu.worldTransformMatrix.a, gu.worldTransformMatrix.tx, gu.worldTransformMatrix.ty] };
    require('fs').writeFileSync('tmp/review/r2-mask-filter-rt/transform.txt', JSON.stringify(out));
    expect(out.v0).toEqual([3, 3]);
  });
});
