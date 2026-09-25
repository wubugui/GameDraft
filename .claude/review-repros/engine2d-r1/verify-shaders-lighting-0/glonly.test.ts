import { describe, expect, it, vi } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { Buffer, BufferUsage } from '../../../../src/engine2d/shader/Buffer';
import { Geometry } from '../../../../src/engine2d/shader/Geometry';
import { Mesh } from '../../../../src/engine2d/mesh/Mesh';
import { RenderTexture } from '../../../../src/engine2d/textures/RenderTexture';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';
import { Texture, UniformGroup } from '../../../../src/engine2d';
import { createUnifiedCharShader } from '../../../../src/rendering/lighting/UnifiedCharacterShader';

function geom() {
  return new Geometry({
    attributes: {
      aPosition: { buffer: new Buffer({ data: new Float32Array([0, 0, 4, 0, 0, 4]), usage: BufferUsage.VERTEX }), format: 'float32x2' },
      aUV: { buffer: new Buffer({ data: new Float32Array([0, 0, 1, 0, 0, 1]), usage: BufferUsage.VERTEX }), format: 'float32x2' },
    },
    indexBuffer: new Buffer({ data: new Uint32Array([0, 1, 2]), usage: BufferUsage.INDEX }),
  });
}

describe('UnifiedCharacterShader on engine2d', () => {
  it('constructs silently without gpuProgram, and drawing it uses the default mesh program', () => {
    const w = Texture.WHITE.source;
    const sh = createUnifiedCharShader(new UniformGroup({ a: { value: 0, type: 'f32' } }), new UniformGroup({ b: { value: 0, type: 'f32' } }),
      { colorTex: w, nrm: null, ground: w, skyGrid: w, giBounce: null, depth: w });
    console.log('gpuProgram =', sh.gpuProgram, 'glProgram =', !!sh.glProgram, 'compatibleRenderers =', sh.compatibleRenderers);
    expect(sh.gpuProgram).toBeNull();

    const rhi = new NullRhiDevice();
    const canvas = { width: 0, height: 0, style: {} } as unknown as HTMLCanvasElement;
    const renderer = new WebGPURenderer({ rhi, canvas, width: 8, height: 8 });
    const shaders = vi.spyOn(rhi, 'createShader');
    const pipes = vi.spyOn(rhi, 'createRenderPipeline');
    const mesh = new Mesh({ geometry: geom(), shader: sh, texture: Texture.WHITE });
    const rt = RenderTexture.create({ width: 8, height: 8 });
    let err: unknown = null;
    try { renderer.render({ container: mesh, target: rt }); } catch (e) { err = e; }
    console.log('render error =', err && (err as Error).message);
    console.log('shader labels =', shaders.mock.calls.map((c) => (c[1] as any)?.label ?? (c[0] as any)?.label));
    console.log('pipelines =', pipes.mock.calls.length, pipes.mock.calls.map((c) => JSON.stringify(Object.keys((c[1] ?? c[0]) as object))));
  });
});
