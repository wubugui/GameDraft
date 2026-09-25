/**
 * 渲染热路径的性能改动不改变结果(空后端,不需要 GPU):
 * - 录制时绑定表原样交给 RHI:uniform 片段本身就是 { buffer, offset, size },规划完统一填上本次的 uniform 缓冲,
 *   同一个全局 uniform 片段在各 draw 之间是同一个对象(以前每个 draw 另拼一张绑定表、逐个 new 区段对象);
 * - 管线缓存的快路径(程序 × 布局对象 × 状态整数)与按串的慢键逐字段一致:任何一个字段不同都是另一条管线,
 *   不同布局对象同键时共用管线,reset 之后重建。
 */
import { describe, expect, it, vi } from 'vitest';
import { NullRhiDevice } from '../../rendering/rhi/backends/null/NullRhiDevice';
import type { RhiBindings, RhiBuffer, RhiCommandList, RhiRenderPassEncoder } from '../../rendering/rhi';
import { Container } from '../scene/Container';
import { Sprite } from '../sprite/Sprite';
import { Texture } from '../textures/Texture';
import { RenderTexture } from '../textures/RenderTexture';
import { BufferImageSource } from '../textures/TextureSource';
import { AlphaFilter } from '../filters/defaults/alpha/AlphaFilter';
import { GpuProgram } from '../shader/GpuProgram';
import { Pipelines, type PipelineKey, type VertexLayout } from './Pipelines';
import { BATCH_LAYOUT } from './FrameBuilder';
import { WebGPURenderer } from './WebGPURenderer';

/** 截下每次 setBindings 收到的绑定表(包一层 submit 的命令表 / pass 编码器) */
function captureBindings(rhi: NullRhiDevice): RhiBindings[] {
  const seen: RhiBindings[] = [];
  const submit = rhi.submit.bind(rhi);
  vi.spyOn(rhi, 'submit').mockImplementation((label, record) => submit(label, (commands) => {
    const wrapped = Object.create(commands) as RhiCommandList;
    wrapped.beginRenderPass = (desc) => {
      const pass = commands.beginRenderPass(desc);
      const w = Object.create(pass) as RhiRenderPassEncoder;
      w.setBindings = (b) => {
        seen.push(b);
        pass.setBindings(b);
      };
      return w;
    };
    record(wrapped);
  }));
  return seen;
}

describe('录制时绑定表原样交给 RHI(不逐 draw 重拼)', () => {
  it('uniform 片段就是 { buffer: 本次 uniform 缓冲, offset, size };同一全局 uniform 在各 draw 间是同一个对象', () => {
    const rhi = new NullRhiDevice();
    const canvas = { width: 32, height: 32, style: {} } as unknown as HTMLCanvasElement;
    const renderer = new WebGPURenderer({ rhi, canvas, width: 32, height: 32 });
    const seen = captureBindings(rhi);
    const texes = Array.from({ length: 20 }, (_, i) => new Texture({
      source: new BufferImageSource({ resource: new Uint8Array(4 * 4 * 4).fill(i), width: 4, height: 4, format: 'rgba8unorm', label: `t${i}` }),
    }));
    const root = new Container();
    // 20 张纹理 > 每批 16 张:至少两批,共用同一个全局 uniform
    for (const t of texes) root.addChild(new Sprite(t));
    const filtered = new Container();
    filtered.addChild(new Sprite(Texture.WHITE));
    filtered.filters = [new AlphaFilter({ alpha: 0.5 })];
    root.addChild(filtered);
    const rt = RenderTexture.create({ width: 32, height: 32 });
    renderer.render({ container: root, target: rt });

    const batch = seen.filter((b) => 'textureSource1' in b);
    expect(batch.length).toBeGreaterThanOrEqual(2);
    expect(batch[1].globalUniforms).toBe(batch[0].globalUniforms);
    const segments = seen.flatMap((b) => Object.values(b)).filter((v): v is { buffer: RhiBuffer; offset: number; size: number } => typeof v === 'object' && v !== null && 'offset' in v);
    expect(segments.length).toBeGreaterThan(0);
    const uniformBuffer = segments[0].buffer;
    expect(uniformBuffer).toBeTruthy();
    for (const s of segments) {
      expect(s.buffer).toBe(uniformBuffer);
      expect(s.offset % 256).toBe(0);
      expect(s.size).toBeGreaterThan(0);
    }
    // 滤镜的 gfu 也是片段
    expect(seen.some((b) => b.gfu && (b.gfu as { buffer?: unknown }).buffer === uniformBuffer)).toBe(true);
    expect(rhi.lastFrameStats.skippedDraws).toBe(0);
  });
});

describe('管线缓存快路径与慢键一致', () => {
  const program = new GpuProgram({
    name: 'p',
    vertex: { source: '@vertex fn v() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }', entryPoint: 'v' },
    fragment: { source: '@fragment fn f() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }', entryPoint: 'f' },
  });
  const program2 = new GpuProgram({
    name: 'p2',
    vertex: { source: '@vertex fn v() -> @builtin(position) vec4<f32> { return vec4<f32>(1.0); }', entryPoint: 'v' },
    fragment: { source: '@fragment fn f() -> @location(0) vec4<f32> { return vec4<f32>(0.0); }', entryPoint: 'f' },
  });
  const base: PipelineKey = {
    program, layout: BATCH_LAYOUT, topology: 'triangle-list', blend: 'normal', colorFormat: 'bgra8unorm',
    depthFormat: null, stencil: 'disabled', colorMask: 15, sampleCount: 1,
  };

  it('每个字段不同都是另一条管线;相同返回同一条;模板用法只在带深度时参与', () => {
    const rhi = new NullRhiDevice();
    const pipelines = new Pipelines(rhi.rootScope);
    const create = vi.spyOn(rhi, 'createRenderPipeline');
    const a = pipelines.get(base);
    expect(pipelines.get({ ...base })).toBe(a);
    const variants: Partial<PipelineKey>[] = [
      { program: program2 },
      { layout: { ...BATCH_LAYOUT, key: 'other', buffers: BATCH_LAYOUT.buffers.map((b) => ({ ...b, stride: 32 })) } },
      { topology: 'triangle-strip' },
      { blend: 'add' },
      { colorFormat: 'rgba8unorm' },
      { depthFormat: 'depth24plus-stencil8' },
      { depthFormat: 'depth24plus-stencil8', stencil: 'add' },
      { colorMask: 0 },
      { sampleCount: 4 },
    ];
    const got = variants.map((v) => pipelines.get({ ...base, ...v }));
    expect(new Set([a, ...got]).size).toBe(variants.length + 1);
    // 再取一遍全部命中缓存,不再建
    const n = create.mock.calls.length;
    expect(variants.map((v) => pipelines.get({ ...base, ...v }))).toEqual(got);
    expect(pipelines.get(base)).toBe(a);
    expect(create.mock.calls.length).toBe(n);
    // 不带深度时模板用法不参与(同慢键里的 '-')
    expect(pipelines.get({ ...base, stencil: 'inverse' })).toBe(a);
  });

  it('不同布局对象同键共用一条管线;reset 后重建', () => {
    const rhi = new NullRhiDevice();
    const pipelines = new Pipelines(rhi.rootScope);
    const a = pipelines.get(base);
    const sameKey: VertexLayout = { ...BATCH_LAYOUT };
    expect(pipelines.get({ ...base, layout: sameKey })).toBe(a);
    pipelines.reset();
    const b = pipelines.get(base);
    expect(b).not.toBe(a);
    expect(a.destroyed).toBe(true);
    expect(pipelines.get({ ...base, layout: sameKey })).toBe(b);
  });
});
