/**
 * 管线预建(空后端,不需要 GPU):预建的键必须与真画时逐项相同——预建过的组合真画时不再建新管线;
 * 没预建的混合照常现建;pipelinesReady 等到全部已建管线就绪。
 */
import { describe, expect, it, vi } from 'vitest';
import { NullRhiDevice } from '../../rendering/rhi/backends/null/NullRhiDevice';
import { Buffer, BufferUsage } from '../shader/Buffer';
import { Geometry } from '../shader/Geometry';
import { GpuProgram } from '../shader/GpuProgram';
import { Shader } from '../shader/Shader';
import { Mesh } from '../mesh/Mesh';
import { RenderTexture } from '../textures/RenderTexture';
import { WebGPURenderer } from './WebGPURenderer';

const WGSL = /* wgsl */ `
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

function makeGeometry(): Geometry {
  return new Geometry({
    attributes: { aPosition: { buffer: new Buffer({ data: new Float32Array([0, 0, 4, 0, 0, 4]), usage: BufferUsage.VERTEX }), format: 'float32x2' } },
    indexBuffer: new Buffer({ data: new Uint32Array([0, 1, 2]), usage: BufferUsage.INDEX }),
  });
}

function setup() {
  const rhi = new NullRhiDevice();
  const canvas = { width: 0, height: 0, style: {} } as unknown as HTMLCanvasElement;
  const renderer = new WebGPURenderer({ rhi, canvas, width: 8, height: 8 });
  const created = vi.spyOn(rhi, 'createRenderPipeline');
  const program = new GpuProgram({ name: 'prewarm-test', vertex: { source: WGSL, entryPoint: 'mainVertex' }, fragment: { source: WGSL, entryPoint: 'mainFragment' } });
  return { rhi, renderer, created, program };
}

describe('管线预建', () => {
  it('预建过的组合,真画时命中缓存、不再建管线;没预建的混合照常现建', async () => {
    const { renderer, created, program } = setup();
    // 预建用的几何是另一份对象,只看布局
    renderer.prewarmPipelines([{ program, geometry: makeGeometry(), blendModes: ['add'] }]);
    // 缺省目标格式 = 画布(空后端 bgra8unorm)+ 离屏 bgra8unorm,去重后一种
    expect(created).toHaveBeenCalledTimes(1);
    expect(await renderer.pipelinesReady(1000)).toBe(true);

    const mesh = new Mesh({ geometry: makeGeometry(), shader: new Shader({ gpuProgram: program, resources: {} }) });
    mesh.blendMode = 'add';
    const rt = RenderTexture.create({ width: 8, height: 8 });
    renderer.render({ container: mesh, target: rt });
    expect(created).toHaveBeenCalledTimes(1);

    mesh.blendMode = 'screen';
    renderer.render({ container: mesh, target: rt });
    expect(created).toHaveBeenCalledTimes(2);
    renderer.destroy();
  });

  it('坏程序只告警、不抛(开局预建不许打断启动)', () => {
    const { renderer } = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bad = new GpuProgram({ name: 'bad', vertex: { source: WGSL, entryPoint: 'mainVertex' }, fragment: { source: WGSL, entryPoint: 'mainFragment' } });
    // 几何缺了程序要的属性:布局建不起来
    const empty = new Geometry({ attributes: {} });
    expect(() => renderer.prewarmPipelines([{ program: bad, geometry: empty, blendModes: ['normal'] }])).not.toThrow();
    warn.mockRestore();
    renderer.destroy();
  });
});
