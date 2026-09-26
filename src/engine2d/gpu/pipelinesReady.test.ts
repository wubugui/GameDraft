/**
 * 揭幕闸等管线(`renderer.pipelinesReady` → `Pipelines.whenAllReady`)的限时与销毁放行(空后端,不需要 GPU)。
 * 补回 master 的 glProgramWarmup.test 里守着的几条(R4-7):
 * - 还没编完:限时一到放行(false),不抛;计时器收干净;
 * - 建坏的管线不让它挂住、也不让它 reject;
 * - 等待中销毁:立刻放行(false),不等到限时;销毁之后再等也是立刻 false。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NullRhiDevice } from '../../rendering/rhi/backends/null/NullRhiDevice';
import { Buffer, BufferUsage } from '../shader/Buffer';
import { Geometry } from '../shader/Geometry';
import { GpuProgram } from '../shader/GpuProgram';
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

/** 预建一个名为 `name` 的程序的管线;`opts` 决定它就绪 / 挂着 / 建坏 */
function setup(name: string, opts: { pending?: boolean; fail?: boolean } = {}) {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const rhi = new NullRhiDevice({
    pendingPipeline: (label) => !!opts.pending && label.includes(name),
    failPipeline: (label) => !!opts.fail && label.includes(name),
  });
  const canvas = { width: 0, height: 0, style: {} } as unknown as HTMLCanvasElement;
  const renderer = new WebGPURenderer({ rhi, canvas, width: 8, height: 8 });
  const created = vi.spyOn(rhi, 'createRenderPipeline');
  const program = new GpuProgram({ name, vertex: { source: WGSL, entryPoint: 'mainVertex' }, fragment: { source: WGSL, entryPoint: 'mainFragment' } });
  renderer.prewarmPipelines([{ program, geometry: makeGeometry(), blendModes: ['normal'] }]);
  expect(created.mock.calls.length).toBeGreaterThan(0);
  return { rhi, renderer };
}

/** 记下承诺落定没有(不 await,好在不推进计时器时判断「还挂着」) */
function track<T>(p: Promise<T>) {
  const s: { done: boolean; value?: T; error?: unknown } = { done: false };
  p.then(
    (v) => { s.done = true; s.value = v; },
    (e) => { s.done = true; s.error = e; },
  );
  return s;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('pipelinesReady 揭幕闸(R4-7)', () => {
  it('全部就绪:返回 true,计时器收干净', async () => {
    const { renderer } = setup('ready-prog');
    vi.useFakeTimers();
    expect(await renderer.pipelinesReady(1000)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    renderer.destroy();
  });

  it('还没编完:限时一到放行(false),不抛、计时器收干净;编完后再等返回 true', async () => {
    const { rhi, renderer } = setup('pending-prog', { pending: true });
    vi.useFakeTimers();
    const w = track(renderer.pipelinesReady(30));
    await vi.advanceTimersByTimeAsync(29);
    expect(w.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(w).toEqual({ done: true, value: false });
    expect(vi.getTimerCount()).toBe(0);

    rhi.settlePendingPipelines();
    expect(await renderer.pipelinesReady(1000)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    renderer.destroy();
  });

  it('建坏的管线:不挂住、不 reject(录制时只跳过它自己的 draw),计时器收干净', async () => {
    const { renderer } = setup('bad-prog', { fail: true });
    vi.useFakeTimers();
    const w = track(renderer.pipelinesReady(60_000));
    await vi.advanceTimersByTimeAsync(0);
    expect(w).toEqual({ done: true, value: true });
    expect(vi.getTimerCount()).toBe(0);
    renderer.destroy();
  });

  it('等待中销毁:立刻放行(false),不等到限时、计时器收干净;销毁之后再等也立刻 false', async () => {
    const { renderer } = setup('pending-prog', { pending: true });
    vi.useFakeTimers();
    const w = track(renderer.pipelinesReady(60_000));
    await Promise.resolve();
    renderer.destroy();
    await vi.advanceTimersByTimeAsync(0);
    expect(w).toEqual({ done: true, value: false });
    expect(vi.getTimerCount()).toBe(0);

    const after = track(renderer.pipelinesReady(60_000));
    await vi.advanceTimersByTimeAsync(0);
    expect(after).toEqual({ done: true, value: false });
    expect(vi.getTimerCount()).toBe(0);
  });
});
