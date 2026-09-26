/**
 * Game 揭幕闸等管线(awaitPipelinesForReveal)与 master 的 GlProgramWarmup.whenReady 同口径(R4-7):
 * 超时放行并记一条日志;编完不记;等待中游戏拆掉(渲染器销毁)立刻放行、不记。用真渲染器 + 空后端。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NullRhiDevice } from './rhi/backends/null/NullRhiDevice';
import { WebGPURenderer } from '../engine2d/gpu/WebGPURenderer';
import { GpuProgram } from '../engine2d/shader/GpuProgram';
import { Geometry } from '../engine2d/shader/Geometry';
import { Buffer, BufferUsage } from '../engine2d/shader/Buffer';
import { awaitPipelinesForReveal } from './pipelineRevealGate';

const WGSL = /* wgsl */ `
struct GlobalUniforms { uProjectionMatrix: mat3x3<f32>, uWorldTransformMatrix: mat3x3<f32>, uWorldColorAlpha: vec4<f32>, uResolution: vec2<f32> }
@group(0) @binding(0) var<uniform> globalUniforms: GlobalUniforms;
@vertex fn mainVertex(@location(0) aPosition: vec2<f32>) -> @builtin(position) vec4<f32> {
  return vec4<f32>((globalUniforms.uProjectionMatrix * vec3<f32>(aPosition, 1.0)).xy, 0.0, 1.0);
}
@fragment fn mainFragment() -> @location(0) vec4<f32> { return globalUniforms.uWorldColorAlpha; }
`;

function setup(pending: boolean) {
  const rhi = new NullRhiDevice({ pendingPipeline: (label) => pending && label.includes('reveal-gate-prog') });
  const canvas = { width: 0, height: 0, style: {} } as unknown as HTMLCanvasElement;
  const renderer = new WebGPURenderer({ rhi, canvas, width: 8, height: 8 });
  const program = new GpuProgram({ name: 'reveal-gate-prog', vertex: { source: WGSL, entryPoint: 'mainVertex' }, fragment: { source: WGSL, entryPoint: 'mainFragment' } });
  const geometry = new Geometry({
    attributes: { aPosition: { buffer: new Buffer({ data: new Float32Array([0, 0, 4, 0, 0, 4]), usage: BufferUsage.VERTEX }), format: 'float32x2' } },
    indexBuffer: new Buffer({ data: new Uint32Array([0, 1, 2]), usage: BufferUsage.INDEX }),
  });
  renderer.prewarmPipelines([{ program, geometry, blendModes: ['normal'] }]);
  return { rhi, renderer };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('揭幕闸等管线(R4-7)', () => {
  it('超时:放行 false,记一条带限时的日志(master:「N 个 shader 在 X ms 内没编完,先放行」)', async () => {
    const { renderer } = setup(true);
    vi.useFakeTimers();
    const logs: string[] = [];
    const p = awaitPipelinesForReveal(renderer, 15000, (m) => logs.push(m), () => false);
    await vi.advanceTimersByTimeAsync(15000);
    expect(await p).toBe(false);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('15000 ms');
    expect(logs[0]).toContain('没编完');
    expect(vi.getTimerCount()).toBe(0);
    renderer.destroy();
  });

  it('全部编完:true,不记日志', async () => {
    const { renderer } = setup(false);
    const logs: string[] = [];
    expect(await awaitPipelinesForReveal(renderer, 15000, (m) => logs.push(m), () => false)).toBe(true);
    expect(logs).toEqual([]);
    renderer.destroy();
  });

  it('等待中游戏拆掉(渲染器销毁):立刻放行、不记日志、不等到限时', async () => {
    const { renderer } = setup(true);
    vi.useFakeTimers();
    let tornDown = false;
    const logs: string[] = [];
    let settled: boolean | null = null;
    void awaitPipelinesForReveal(renderer, 15000, (m) => logs.push(m), () => tornDown).then((v) => { settled = v; });
    await Promise.resolve();
    tornDown = true;
    renderer.destroy();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    expect(logs).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
