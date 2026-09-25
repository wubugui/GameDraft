import { describe, expect, it, vi } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { Buffer, BufferUsage } from '../../../../src/engine2d/shader/Buffer';
import { Geometry } from '../../../../src/engine2d/shader/Geometry';
import { GpuProgram } from '../../../../src/engine2d/shader/GpuProgram';
import { Shader } from '../../../../src/engine2d/shader/Shader';
import { Mesh } from '../../../../src/engine2d/mesh/Mesh';
import { RenderTexture } from '../../../../src/engine2d/textures/RenderTexture';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';
import * as PIXI from 'pixi.js';
import { appendFileSync } from 'node:fs';
const log = (...a: any[]) => appendFileSync('.claude/review-repros/engine2d-r1/verify-shader-uniforms-textures-2/out.txt', a.join(' ') + '\n');
// @ts-ignore
import { ensureAttributes } from '../../../../node_modules/pixi.js/lib/rendering/renderers/gl/shader/program/ensureAttributes.mjs';

const WGSL = /* wgsl */ `
struct GlobalUniforms { uProjectionMatrix: mat3x3<f32>, uWorldTransformMatrix: mat3x3<f32>, uWorldColorAlpha: vec4<f32>, uResolution: vec2<f32> }
struct LocalUniforms { uTransformMatrix: mat3x3<f32>, uColor: vec4<f32>, uRound: f32 }
@group(0) @binding(0) var<uniform> globalUniforms: GlobalUniforms;
@group(1) @binding(0) var<uniform> localUniforms: LocalUniforms;
struct VOut { @builtin(position) p: vec4<f32>, @location(0) c: vec4<f32> }
@vertex fn mainVertex(@location(0) aPosition: vec2<f32>, @location(1) aColor: vec4<f32>) -> VOut {
  let m = globalUniforms.uProjectionMatrix * globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix;
  return VOut(vec4<f32>((m * vec3<f32>(aPosition, 1.0)).xy, 0.0, 1.0), aColor);
}
@fragment fn mainFragment(v: VOut) -> @location(0) vec4<f32> { return v.c; }
`;

describe('geometry attribute format default', () => {
  it('engine2d vs Pixi', () => {
    const rhi = new NullRhiDevice();
    const canvas = { width: 0, height: 0, style: {} } as unknown as HTMLCanvasElement;
    const renderer = new WebGPURenderer({ rhi, canvas, width: 8, height: 8 });
    const created = vi.spyOn(rhi, 'createRenderPipeline');
    const program = new GpuProgram({ name: 'fmt', vertex: { source: WGSL, entryPoint: 'mainVertex' }, fragment: { source: WGSL, entryPoint: 'mainFragment' } });
    const geometry = new Geometry({
      attributes: {
        aPosition: new Float32Array([0, 0, 4, 0, 0, 4]),
        aColor: new Float32Array([1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1]),
      },
      indexBuffer: new Uint32Array([0, 1, 2]),
    });
    const mesh = new Mesh({ geometry, shader: new Shader({ gpuProgram: program, resources: {} }) });
    renderer.render({ container: mesh, target: RenderTexture.create({ width: 8, height: 8 }) });
    const vb = (created.mock.calls[0][1] as any).vertexBuffers;
    log('engine2d vertexBuffers', JSON.stringify(vb));

    // Pixi
    const pprog = PIXI.GpuProgram.from({ vertex: { source: WGSL, entryPoint: 'mainVertex' }, fragment: { source: WGSL, entryPoint: 'mainFragment' } });
    const pgeo = new PIXI.Geometry({
      attributes: {
        aPosition: new Float32Array([0, 0, 4, 0, 0, 4]),
        aColor: new Float32Array([1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1]),
      },
      indexBuffer: new Uint32Array([0, 1, 2]),
    });
    ensureAttributes(pgeo, pprog.attributeData);
    const pix = Object.fromEntries(Object.entries(pgeo.attributes).map(([k, a]: any) => [k, { format: a.format, stride: a.stride, offset: a.offset }]));
    log('pixi attributes', JSON.stringify(pix));

    // Also: interleaved buffer where shader uses only a subset
    const inter = new Buffer({ data: new Float32Array(18), usage: BufferUsage.VERTEX });
    const g2 = new Geometry({ attributes: {
      aPosition: { buffer: inter, format: 'float32x2', offset: 0 },
      aUnused: { buffer: inter, format: 'float32x2', offset: 8 },
      aColor: { buffer: inter, format: 'float32x2', offset: 16 },
    }, indexBuffer: new Uint32Array([0, 1, 2]) });
    const layout = (renderer as any).pipelines?.layout ? (renderer as any).pipelines.layout(g2, program) : null;
    log('engine2d interleaved subset layout', JSON.stringify(layout?.buffers));
    const pinter = new PIXI.Buffer({ data: new Float32Array(18), usage: PIXI.BufferUsage.VERTEX });
    const pg2 = new PIXI.Geometry({ attributes: {
      aPosition: { buffer: pinter, format: 'float32x2', offset: 0 },
      aUnused: { buffer: pinter, format: 'float32x2', offset: 8 },
      aColor: { buffer: pinter, format: 'float32x2', offset: 16 },
    }, indexBuffer: new Uint32Array([0, 1, 2]) });
    ensureAttributes(pg2, pprog.attributeData);
    log('pixi interleaved', JSON.stringify(Object.fromEntries(Object.entries(pg2.attributes).map(([k, a]: any) => [k, { format: a.format, stride: a.stride, offset: a.offset }]))));
    expect(vb).toBeTruthy();
  });
});
