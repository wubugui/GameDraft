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
import { Container } from '../scene/Container';
import { Mesh } from '../mesh/Mesh';
import { Shader } from '../shader/Shader';

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
  return { rhi, renderer, program };
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
  it('实际引用的挂起管线编完后必须重画，最后一帧没有跳过draw才就绪', async () => {
    const { rhi, renderer, program } = setup('complete-pending', { pending: true });
    const root = new Container();
    root.addChild(new Mesh({ geometry: makeGeometry(), shader: new Shader({ gpuProgram: program, resources: {} }) }));
    const render = vi.spyOn(renderer, 'render');
    const waiting = renderer.prepareForReveal({ container: root, timeoutMs: 1000 });
    const state = track(waiting);
    await Promise.resolve();
    expect(state.done).toBe(false);
    rhi.settlePendingPipelines();
    const ready = await waiting;
    expect(ready).toMatchObject({ status: 'ready', submitted: true, pending: [], failed: [] });
    expect(render.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(ready.passes).toBe(render.mock.calls.length);
    expect(rhi.lastFrameStats.draws).toBeGreaterThan(0);
    expect(rhi.lastFrameStats.skippedDraws).toBe(0);
    renderer.destroy();
  });

  it('真实提交被RHI拒绝时不得报ready，也不等待GPU完成', async () => {
    const { rhi, renderer } = setup('failed-submit');
    vi.useFakeTimers();
    vi.spyOn(rhi, 'runFrame').mockReturnValue(false);
    const complete = vi.spyOn(rhi, 'waitForSubmittedWork');
    await expect(renderer.prepareForReveal({ container: new Container(), timeoutMs: 1000 })).rejects.toThrow('Complete first frame submission failed');
    expect(complete).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    renderer.destroy();
  });

  it('已提交但遗漏draw的完整帧仍拒绝揭幕', async () => {
    const { rhi, renderer } = setup('skipped-submit');
    vi.useFakeTimers();
    const stats = rhi.lastFrameStats;
    vi.spyOn(rhi, 'lastFrameStats', 'get').mockImplementation(() => ({ ...stats, skippedDraws: 1 }));
    const complete = vi.spyOn(rhi, 'waitForSubmittedWork');
    await expect(renderer.prepareForReveal({ container: new Container(), timeoutMs: 1000 })).rejects.toThrow('Complete first frame contains skipped draws');
    expect(complete).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    renderer.destroy();
  });

  it('GPU提交完成永远不返回也受整个首帧watchdog约束', async () => {
    const { rhi, renderer } = setup('hung-gpu-work');
    vi.useFakeTimers();
    const complete = vi.spyOn(rhi, 'waitForSubmittedWork').mockImplementation(() => new Promise<void>(() => {}));
    const waiting = renderer.prepareForReveal({ container: new Container(), timeoutMs: 100 }).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(complete).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(await waiting).toMatchObject({ name: 'TimeoutError' });
    expect(vi.getTimerCount()).toBe(0);
    renderer.destroy();
  });

  it.each(['destroy', 'restore', 'loss'] as const)('等待GPU提交完成时%s必须封口，不留首帧定时器', async (cause) => {
    const { rhi, renderer } = setup(`gpu-wait-${cause}`);
    vi.useFakeTimers();
    const complete = vi.spyOn(rhi, 'waitForSubmittedWork').mockImplementation(() => new Promise<void>(() => {}));
    const waiting = renderer.prepareForReveal({ container: new Container(), timeoutMs: 60_000 }).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(complete).toHaveBeenCalledTimes(1);
    if (cause === 'destroy') renderer.destroy();
    else {
      const loss = rhi.loseDevice('first frame interrupted', { restore: cause === 'restore' });
      await vi.advanceTimersByTimeAsync(cause === 'loss' ? 50 : 0);
      await loss;
    }
    const error = await waiting;
    if (cause === 'destroy') expect(error).toMatchObject({ name: 'AbortError' });
    else expect(error).toBeInstanceOf(Error);
    expect(vi.getTimerCount()).toBe(0);
    renderer.destroy();
  });

  it.each(['hidden', 'inactive', 'zero-canvas'] as const)('不可绘制的%s目标拒绝揭幕且收齐首帧定时器', async (cause) => {
    const { renderer } = setup(`undrawable-${cause}`);
    const root = new Container();
    if (cause === 'hidden') root.visible = false;
    else if (cause === 'inactive') root.setActive(false);
    else renderer.canvas.width = 0;
    vi.useFakeTimers();
    await expect(renderer.prepareForReveal({ container: root, timeoutMs: 1000 })).rejects.toThrow('Target frame is not drawable');
    expect(vi.getTimerCount()).toBe(0);
    renderer.destroy();
  });

  it('完整首帧只等实际引用的管线，未使用的历史失败不会污染新场景', async () => {
    const { renderer } = setup('unused-bad', { fail: true });
    const root = new Container();
    const result = await renderer.prepareForReveal({ container: root, timeoutMs: 1000 });
    expect(result).toMatchObject({ status: 'ready', submitted: true, pending: [], failed: [] });
    expect(result.passes).toBeGreaterThanOrEqual(2);
    renderer.destroy();
  });

  it('完整首帧实际需要的管线失败会拒绝，不能沿用旧boolean的fail-open结果', async () => {
    const { renderer, program } = setup('required-bad', { fail: true });
    const root = new Container();
    root.addChild(new Mesh({ geometry: makeGeometry(), shader: new Shader({ gpuProgram: program, resources: {} }) }));
    await expect(renderer.prepareForReveal({ container: root, timeoutMs: 1000 })).rejects.toThrow('Required GPU pipelines failed');
    renderer.destroy();
  });

  it('完整首帧等待期间取消立即拒绝并回收计时器', async () => {
    const { renderer, program } = setup('required-pending', { pending: true });
    const root = new Container();
    root.addChild(new Mesh({ geometry: makeGeometry(), shader: new Shader({ gpuProgram: program, resources: {} }) }));
    vi.useFakeTimers();
    const cancel = new AbortController();
    const waiting = renderer.prepareForReveal({ container: root, timeoutMs: 60_000, signal: cancel.signal });
    const rejection = expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    cancel.abort();
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
    renderer.destroy();
  });
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
