import { describe, expect, it } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { Buffer, BufferUsage } from '../../../../src/engine2d/shader/Buffer';
import { Geometry } from '../../../../src/engine2d/shader/Geometry';
import { GpuProgram } from '../../../../src/engine2d/shader/GpuProgram';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';

const WGSL = `
struct GlobalUniforms { uProjectionMatrix: mat3x3<f32>, uWorldTransformMatrix: mat3x3<f32>, uWorldColorAlpha: vec4<f32>, uResolution: vec2<f32> }
struct LocalUniforms { uTransformMatrix: mat3x3<f32>, uColor: vec4<f32>, uRound: f32 }
@group(0) @binding(0) var<uniform> globalUniforms: GlobalUniforms;
@group(1) @binding(0) var<uniform> localUniforms: LocalUniforms;
@vertex fn mainVertex(@location(0) aPosition: vec2<f32>) -> @builtin(position) vec4<f32> {
  let m = globalUniforms.uProjectionMatrix * globalUniforms.uWorldTransformMatrix * localUniforms.uTransformMatrix;
  return vec4<f32>((m * vec3<f32>(aPosition, 1.0)).xy, 0.0, 1.0);
}
@fragment fn mainFragment() -> @location(0) vec4<f32> { return localUniforms.uColor; }
`;
const geo = () => new Geometry({
  attributes: { aPosition: { buffer: new Buffer({ data: new Float32Array([0, 0, 4, 0, 0, 4]), usage: BufferUsage.VERTEX }), format: 'float32x2' } },
  indexBuffer: new Buffer({ data: new Uint32Array([0, 1, 2]), usage: BufferUsage.INDEX }),
});

function setupPending() {
  const rhi = new NullRhiDevice();
  const orig = rhi.createRenderPipeline.bind(rhi);
  // wrap: never-settling ready (NullRhiDevice has no option for this)
  (rhi as any).createRenderPipeline = (...args: any[]) => {
    const p = (orig as any)(...args);
    Object.defineProperty(p, 'ready', { get: () => new Promise<void>(() => {}) });
    return p;
  };
  (rhi as any).scope && 0;
  const canvas = { width: 0, height: 0, style: {} } as unknown as HTMLCanvasElement;
  const renderer = new WebGPURenderer({ rhi, canvas, width: 8, height: 8 });
  const program = new GpuProgram({ name: 'p', vertex: { source: WGSL, entryPoint: 'mainVertex' }, fragment: { source: WGSL, entryPoint: 'mainFragment' } });
  return { rhi, renderer, program };
}

describe('pipelinesReady guards (verify r4-test-guards-4)', () => {
  it('pending pipeline -> timeout returns false', async () => {
    const { renderer, program } = setupPending();
    renderer.prewarmPipelines([{ program, geometry: geo(), blendModes: ['add'] }]);
    const t0 = Date.now();
    expect(await renderer.pipelinesReady(30)).toBe(false);
    console.log('timeout wait ms', Date.now() - t0);
    renderer.destroy();
  });
  it('destroy mid-wait: master returned false immediately; branch waits for full timeout', async () => {
    const { renderer, program } = setupPending();
    renderer.prewarmPipelines([{ program, geometry: geo(), blendModes: ['add'] }]);
    const t0 = Date.now();
    const waiting = renderer.pipelinesReady(500);
    await Promise.resolve();
    renderer.destroy();
    const r = await waiting;
    const dt = Date.now() - t0;
    console.log('destroy-mid-wait result', r, 'ms', dt);
    expect(r).toBe(false);
  });
});
