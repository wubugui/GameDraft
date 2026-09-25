/**
 * LumaRhiDevice 在假 luma 设备上的行为(不需要 GPU):
 * - 建坏的管线只丢它自己的 draw,帧照常提交(master 的 Pixi GL 里坏程序只影响自己的 draw)
 * - bind group 按资源身份缓存,重复的相同 draw 不再新建(Pixi 8 WebGPU BindGroupSystem 同理)
 * - destroy 拆掉画布上下文
 * - 图像上传的 flipY 不支持就当场报,不静默丢
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { Device } from '@luma.gl/core';
import { RhiBufferUsage, RhiError, RhiTextureUsage } from '../../types';
import type { RhiDevice, RhiRenderPipeline } from '../../RhiDevice';
import { createFakeLuma, type FakeLumaOptions } from '../testing/fakeLumaDevice';
import { LumaRhiDevice } from './LumaRhiDevice';

const PLAIN_WGSL = /* wgsl */ `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> { return vec4<f32>(f32(i), 0.0, 0.0, 1.0); }
@fragment fn fs() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }
`;

const BOUND_WGSL = /* wgsl */ `
@group(0) @binding(0) var<uniform> u: vec4<f32>;
@group(0) @binding(1) var uTex: texture_2d<f32>;
@group(0) @binding(2) var uTexSampler: sampler;
@vertex fn vs(@location(0) aPos: vec2<f32>) -> @builtin(position) vec4<f32> { return vec4<f32>(aPos, 0.0, 1.0) + u; }
@fragment fn fs() -> @location(0) vec4<f32> { return textureSample(uTex, uTexSampler, vec2<f32>(0.0)); }
`;

const COMPUTE_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> data: array<f32>;
@compute @workgroup_size(1) fn main() { data[0] = 1.0; }
`;

function setup(options: FakeLumaOptions = {}) {
  const fake = createFakeLuma(options);
  const dev = new LumaRhiDevice(fake.device as Device);
  const diags: { severity: string; code: string; message: string }[] = [];
  dev.onDiagnostic((e, severity) => diags.push({ severity, code: e.code, message: e.message }));
  return { fake, dev, diags };
}

function pipeline(dev: RhiDevice, label: string, wgsl = PLAIN_WGSL): RhiRenderPipeline {
  const shader = dev.rootScope.createShader({ label, wgsl });
  return dev.rootScope.createRenderPipeline({ label, shader, colorFormats: ['bgra8unorm'] });
}

async function settled(p: Promise<unknown>): Promise<unknown> {
  return p.then(() => null, (e: unknown) => e);
}

describe('建坏的管线只丢它自己的 draw(D7)', () => {
  it('着色器编译失败:ready reject,原生层不 setPipeline / draw 它,别的 draw 照画,整帧照常提交', async () => {
    const { fake, dev, diags } = setup({ shaderCompileErrors: ['bad'] });
    const bad = pipeline(dev, 'bad');
    const good = pipeline(dev, 'good');
    expect(await settled(bad.ready)).toBeInstanceOf(RhiError);
    await good.ready;
    expect(bad.isReady).toBe(false);

    const frame = () => dev.runFrame((f) => {
      const pass = f.commands.beginRenderPass({ label: 'main', target: f.swapchain });
      pass.setPipeline(bad);
      pass.setBindings({});
      pass.draw(3);
      pass.setPipeline(good);
      pass.setBindings({});
      pass.draw(6);
      pass.end();
    });
    expect(frame()).toBe(true);
    expect(fake.log.filter((c) => c[0] === 'setPipeline')).toEqual([['setPipeline', { nativePipeline: 'good' }]]);
    expect(fake.log.filter((c) => c[0] === 'draw')).toEqual([['draw', 6, 1, 0, 0]]);
    expect(fake.log.some((c) => c[0] === 'submit')).toBe(true);
    expect(dev.lastFrameStats).toMatchObject({ draws: 1, skippedDraws: 1 });

    // 第二帧:照样只跳过它,告警不重复
    expect(frame()).toBe(true);
    expect(dev.lastFrameStats).toMatchObject({ draws: 1, skippedDraws: 1 });
    expect(diags.filter((d) => d.severity === 'warning' && d.message.includes('「bad」'))).toHaveLength(1);
    expect(diags.filter((d) => d.severity === 'error' && d.message.includes('编译失败'))).toHaveLength(1);
  });

  it.each(['validation', 'internal'] as const)(
    '建管线时原生错误作用域报 %s 错误(luma 关着调试不接):RHI 自己接住,ready reject,draw 跳过',
    async (filter) => {
      const { fake, dev } = setup({ failCreate: { bad: filter } });
      const bad = pipeline(dev, 'bad');
      const e = await settled(bad.ready);
      expect(e).toBeInstanceOf(RhiError);
      expect((e as RhiError).message).toContain('「bad」建坏了');
      expect(fake.log.some((c) => c[0] === 'uncapturedError')).toBe(false);

      expect(dev.runFrame((f) => {
        const pass = f.commands.beginRenderPass({ label: 'main', target: f.swapchain });
        pass.setPipeline(bad);
        pass.draw(3);
        pass.end();
      })).toBe(true);
      expect(fake.log.some((c) => c[0] === 'setPipeline' || c[0] === 'draw')).toBe(false);
      expect(dev.lastFrameStats.skippedDraws).toBe(1);
    },
  );

  it('建着色器模块时报的错也算管线建坏', async () => {
    const { dev } = setup({ failCreate: { bad: 'validation' } });
    // 着色器与管线同名:着色器那一步就报错
    const shader = dev.rootScope.createShader({ label: 'bad', wgsl: PLAIN_WGSL });
    const p = dev.rootScope.createRenderPipeline({ label: 'uses-bad-shader', shader, colorFormats: ['bgra8unorm'] });
    expect(await settled(p.ready)).toBeInstanceOf(RhiError);
  });

  it('建坏的计算管线:dispatch 跳过,不碰原生层,批次照常提交', async () => {
    const { fake, dev } = setup({ failCreate: { badc: 'validation' } });
    const shader = dev.rootScope.createShader({ label: 'cs', wgsl: COMPUTE_WGSL });
    const p = dev.rootScope.createComputePipeline({ label: 'badc', shader });
    expect(await settled(p.ready)).toBeInstanceOf(RhiError);
    const buf = dev.rootScope.createBuffer({ label: 'data', size: 16, usage: RhiBufferUsage.STORAGE });
    expect(dev.submit('cs', (c) => {
      const pass = c.beginComputePass('cs');
      pass.setPipeline(p);
      pass.setBindings({ data: buf });
      pass.dispatch(1);
      pass.end();
    })).toBe(true);
    expect(fake.log.some((c) => c[0] === 'compute.setPipeline' || c[0] === 'dispatch' || c[0] === 'compute.setBindGroup')).toBe(false);
    expect(fake.log.some((c) => c[0] === 'submit')).toBe(true);
  });

  it('正常的管线不受影响:错误作用域平衡、没有误报', async () => {
    const { fake, dev, diags } = setup();
    const good = pipeline(dev, 'good');
    await good.ready;
    expect(good.isReady).toBe(true);
    expect(diags).toEqual([]);
    expect(fake.log.some((c) => c[0] === 'uncapturedError')).toBe(false);
  });
});

describe('bind group 按资源身份缓存(D12)', () => {
  function boundSetup() {
    const s = setup();
    const { dev } = s;
    const p = pipeline(dev, 'bound', BOUND_WGSL);
    // 顶点流
    const shader = dev.rootScope.createShader({ label: 'bound2', wgsl: BOUND_WGSL });
    const withStream = dev.rootScope.createRenderPipeline({
      label: 'bound-stream', shader, colorFormats: ['bgra8unorm'],
      vertexBuffers: [{ name: 'pos', stride: 8, attributes: [{ name: 'aPos', format: 'float32x2', offset: 0 }] }],
    });
    const ubo = dev.rootScope.createBuffer({ label: 'ubo', size: 1024, usage: RhiBufferUsage.UNIFORM | RhiBufferUsage.COPY_DST });
    const vbo = dev.rootScope.createBuffer({ label: 'vbo', size: 64, usage: RhiBufferUsage.VERTEX });
    const tex = dev.rootScope.createTexture({ label: 'tex', width: 4, height: 4, format: 'rgba8unorm', usage: RhiTextureUsage.SAMPLED });
    const nearest = dev.rootScope.createSampler({ label: 'nearest', magFilter: 'nearest', minFilter: 'nearest' });
    return { ...s, p, withStream, ubo, vbo, tex, nearest };
  }

  it('重复的相同 draw(每次新拼的绑定表)只建一次 bind group,之后直接复用', () => {
    const { fake, dev, withStream, ubo, vbo, tex } = boundSetup();
    const draws = 200;
    expect(dev.runFrame((f) => {
      const pass = f.commands.beginRenderPass({ label: 'main', target: f.swapchain });
      for (let i = 0; i < draws; i++) {
        pass.setPipeline(withStream);
        // engine2d 每个 draw 都新拼一张绑定表、新建区段对象
        pass.setBindings({ u: { buffer: ubo, offset: 256, size: 16 }, uTex: tex });
        pass.setVertexBuffer('pos', vbo);
        pass.draw(3);
      }
      pass.end();
    })).toBe(true);
    expect(fake.counts.bindGroups).toBe(1);
    expect(dev.lastFrameStats.draws).toBe(draws);
    // 同一个 bind group 已绑着就不重设(Pixi GpuEncoderSystem 同理)
    expect(fake.log.filter((c) => c[0] === 'setBindGroup')).toHaveLength(1);

    // 下一帧同样的资源:仍然命中
    dev.runFrame((f) => {
      const pass = f.commands.beginRenderPass({ label: 'main', target: f.swapchain });
      pass.setPipeline(withStream);
      pass.setBindings({ u: { buffer: ubo, offset: 256, size: 16 }, uTex: tex });
      pass.setVertexBuffer('pos', vbo);
      pass.draw(3);
      pass.end();
    });
    expect(fake.counts.bindGroups).toBe(1);
  });

  it('键随资源变:区段偏移 / 尺寸、纹理、纹理的采样器、缓冲重建都换新 bind group;回到旧组合命中旧的', () => {
    const { fake, dev, p, ubo, tex, nearest } = boundSetup();
    const tex2 = dev.rootScope.createTexture({ label: 'tex2', width: 4, height: 4, format: 'rgba8unorm', usage: RhiTextureUsage.SAMPLED });
    let ubo2 = ubo;
    const seq: [string, () => Record<string, unknown>][] = [
      ['a', () => ({ u: { buffer: ubo, offset: 0, size: 16 }, uTex: tex })],
      ['offset', () => ({ u: { buffer: ubo, offset: 256, size: 16 }, uTex: tex })],
      ['size', () => ({ u: { buffer: ubo, offset: 256, size: 32 }, uTex: tex })],
      ['tex2', () => ({ u: { buffer: ubo, offset: 256, size: 32 }, uTex: tex2 })],
      ['sampler', () => ({ u: { buffer: ubo, offset: 256, size: 32 }, uTex: tex2, uTexSampler: nearest })],
      ['a-again', () => ({ u: { buffer: ubo, offset: 0, size: 16 }, uTex: tex })],
      ['rebuilt-buffer', () => ({ u: { buffer: ubo2, offset: 0, size: 16 }, uTex: tex })],
    ];
    const created: number[] = [];
    for (const [name, make] of seq) {
      if (name === 'rebuilt-buffer') {
        ubo2.destroy();
        ubo2 = dev.rootScope.createBuffer({ label: 'ubo', size: 1024, usage: RhiBufferUsage.UNIFORM | RhiBufferUsage.COPY_DST });
      }
      const before = fake.counts.bindGroups;
      expect(dev.runFrame((f) => {
        const pass = f.commands.beginRenderPass({ label: 'main', target: f.swapchain });
        pass.setPipeline(p);
        pass.setBindings(make() as never);
        pass.draw(3);
        pass.end();
      })).toBe(true);
      created.push(fake.counts.bindGroups - before);
    }
    expect(created).toEqual([1, 1, 1, 1, 1, 0, 1]);
  });

  it('缓存不放过校验:缺绑定、已销毁的资源照样当场报,这一帧作废', () => {
    const { dev, diags, p, ubo, tex } = boundSetup();
    const draw = (b: Record<string, unknown>) => dev.runFrame((f) => {
      const pass = f.commands.beginRenderPass({ label: 'main', target: f.swapchain });
      pass.setPipeline(p);
      pass.setBindings(b as never);
      pass.draw(3);
      pass.end();
    });
    expect(draw({ u: ubo, uTex: tex })).toBe(true);
    expect(draw({ u: ubo })).toBe(false);
    expect(diags[diags.length - 1]?.message).toContain('uTex');
    tex.destroy();
    expect(draw({ u: ubo, uTex: tex })).toBe(false);
    expect(diags[diags.length - 1]?.code).toBe('destroyed-resource');
  });
});

const TWO_STREAM_WGSL = /* wgsl */ `
@vertex fn vs(@location(0) aPos: vec2<f32>, @location(1) aUV: vec2<f32>) -> @builtin(position) vec4<f32> { return vec4<f32>(aPos + aUV, 0.0, 1.0); }
@fragment fn fs() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }
`;

/** 原生 render pass 上的状态设置 / draw,转成好比对的短串 */
function nativeState(log: readonly unknown[][]): string[] {
  const out: string[] = [];
  for (const c of log) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = c as [string, ...any[]];
    if (a[0] === 'setPipeline') out.push(`pipe:${a[1].nativePipeline}`);
    else if (a[0] === 'setBindGroup') out.push(`bg${a[1]}:#${a[2].bindGroup}`);
    else if (a[0] === 'setVertexBuffer') out.push(`vb${a[1]}:${a[2].buffer}@${a[3]}`);
    else if (a[0] === 'setIndexBuffer') out.push(`ib:${a[1].buffer}:${a[2]}`);
    else if (a[0] === 'draw' || a[0] === 'drawIndexed') out.push(`${a[0]}(${a.slice(1).join(',')})`);
  }
  return out;
}

describe('pass 编码器热路径只下发变了的原生状态(D12,照 Pixi 8 GpuEncoderSystem)', () => {
  function streamSetup() {
    const s = setup();
    const { dev } = s;
    const shader = dev.rootScope.createShader({ label: 'bound', wgsl: BOUND_WGSL });
    const mk = (label: string, cullMode?: 'back') => dev.rootScope.createRenderPipeline({
      label, shader, colorFormats: ['bgra8unorm'], cullMode,
      vertexBuffers: [{ name: 'pos', stride: 8, attributes: [{ name: 'aPos', format: 'float32x2', offset: 0 }] }],
    });
    const ubo = dev.rootScope.createBuffer({ label: 'ubo', size: 1024, usage: RhiBufferUsage.UNIFORM | RhiBufferUsage.COPY_DST });
    const vboA = dev.rootScope.createBuffer({ label: 'vboA', size: 64, usage: RhiBufferUsage.VERTEX });
    const vboB = dev.rootScope.createBuffer({ label: 'vboB', size: 64, usage: RhiBufferUsage.VERTEX });
    const ibo = dev.rootScope.createBuffer({ label: 'ibo', size: 64, usage: RhiBufferUsage.INDEX, indexFormat: 'uint16' });
    const tex = dev.rootScope.createTexture({ label: 'tex', width: 4, height: 4, format: 'rgba8unorm', usage: RhiTextureUsage.SAMPLED });
    return { ...s, p1: mk('p1'), p2: mk('p2', 'back'), ubo, vboA, vboB, ibo, tex };
  }

  it('重复的相同 draw:原生 setPipeline / setBindGroup / setVertexBuffer / setIndexBuffer 各只下发一次,draw 直接走原生', () => {
    const { fake, dev, p1, ubo, vboA, ibo, tex } = streamSetup();
    const draws = 200;
    expect(dev.runFrame((f) => {
      const pass = f.commands.beginRenderPass({ label: 'main', target: f.swapchain });
      for (let i = 0; i < draws; i++) {
        pass.setPipeline(p1);
        pass.setBindings({ u: { buffer: ubo, offset: 0, size: 16 }, uTex: tex });
        pass.setVertexBuffer('pos', vboA);
        pass.setIndexBuffer(ibo);
        pass.drawIndexed(6, 1, 3);
      }
      pass.end();
    })).toBe(true);
    const state = nativeState(fake.log);
    expect(state.filter((c) => !c.startsWith('drawIndexed'))).toEqual(['pipe:p1', 'bg0:#1', 'ib:ibo:uint16', 'vb0:vboA@0']);
    expect(state.filter((c) => c.startsWith('drawIndexed'))).toEqual(new Array(draws).fill('drawIndexed(6,1,3,0,0)'));
    expect(dev.lastFrameStats.draws).toBe(draws);
  });

  it('状态变了才重发;换管线后回来重设 bind group;新 pass 从零开始', () => {
    const { fake, dev, p1, p2, ubo, vboA, vboB, ibo, tex } = streamSetup();
    const b = () => ({ u: { buffer: ubo, offset: 0, size: 16 }, uTex: tex });
    expect(dev.runFrame((f) => {
      for (let n = 0; n < 2; n++) {
        const pass = f.commands.beginRenderPass({ label: `pass${n}`, target: f.swapchain });
        pass.setPipeline(p1); pass.setBindings(b()); pass.setVertexBuffer('pos', vboA); pass.setIndexBuffer(ibo); pass.drawIndexed(3);
        pass.setPipeline(p1); pass.setBindings(b()); pass.setVertexBuffer('pos', vboB); pass.setIndexBuffer(ibo); pass.drawIndexed(3);
        pass.setPipeline(p2); pass.setBindings(b()); pass.setVertexBuffer('pos', vboB); pass.setIndexBuffer(ibo); pass.drawIndexed(3);
        pass.setPipeline(p1); pass.setBindings(b()); pass.setVertexBuffer('pos', vboB); pass.setIndexBuffer(null); pass.draw(3);
        pass.setPipeline(p1); pass.setBindings(b()); pass.setVertexBuffer('pos', vboB); pass.setIndexBuffer(ibo); pass.drawIndexed(3);
        pass.end();
      }
    })).toBe(true);
    const onePass = [
      'pipe:p1', 'bg0:#1', 'ib:ibo:uint16', 'vb0:vboA@0', 'drawIndexed(3,1,0,0,0)',
      'vb0:vboB@0', 'drawIndexed(3,1,0,0,0)',
      'pipe:p2', 'bg0:#2', 'drawIndexed(3,1,0,0,0)',
      'pipe:p1', 'bg0:#1', 'draw(3,1,0,0)',
      'drawIndexed(3,1,0,0,0)',
    ];
    expect(nativeState(fake.log)).toEqual([...onePass, ...onePass]);
  });

  it('缓冲重建(新的原生缓冲)照样重设顶点流', () => {
    const { fake, dev, p1, ubo, tex } = streamSetup();
    let vbo = dev.rootScope.createBuffer({ label: 'v1', size: 64, usage: RhiBufferUsage.VERTEX });
    expect(dev.runFrame((f) => {
      const pass = f.commands.beginRenderPass({ label: 'main', target: f.swapchain });
      pass.setPipeline(p1); pass.setBindings({ u: ubo, uTex: tex }); pass.setVertexBuffer('pos', vbo); pass.draw(3);
      vbo = dev.rootScope.createBuffer({ label: 'v2', size: 64, usage: RhiBufferUsage.VERTEX });
      pass.setPipeline(p1); pass.setBindings({ u: ubo, uTex: tex }); pass.setVertexBuffer('pos', vbo); pass.draw(3);
      pass.end();
    })).toBe(true);
    expect(nativeState(fake.log).filter((c) => c.startsWith('vb'))).toEqual(['vb0:v1@0', 'vb0:v2@0']);
  });

  it('多个顶点流:原生槽位 / 偏移与 luma 自己的 WebGPUVertexArray.bindBeforeRender 一致', () => {
    const { fake, dev } = setup();
    const shader = dev.rootScope.createShader({ label: 'two', wgsl: TWO_STREAM_WGSL });
    // 描述里的流顺序故意与着色器 location 顺序相反
    const p = dev.rootScope.createRenderPipeline({
      label: 'two', shader, colorFormats: ['bgra8unorm'],
      vertexBuffers: [
        { name: 'uv', stride: 8, attributes: [{ name: 'aUV', format: 'float32x2', offset: 0 }] },
        { name: 'pos', stride: 8, attributes: [{ name: 'aPos', format: 'float32x2', offset: 0 }] },
      ],
    });
    const uv = dev.rootScope.createBuffer({ label: 'uvBuf', size: 64, usage: RhiBufferUsage.VERTEX });
    const pos = dev.rootScope.createBuffer({ label: 'posBuf', size: 64, usage: RhiBufferUsage.VERTEX });
    expect(dev.runFrame((f) => {
      const pass = f.commands.beginRenderPass({ label: 'main', target: f.swapchain });
      pass.setPipeline(p);
      pass.setVertexBuffer('uv', uv);
      pass.setVertexBuffer('pos', pos);
      pass.draw(3);
      pass.end();
    })).toBe(true);
    const got = nativeState(fake.log).filter((c) => c.startsWith('vb'));

    // 同一个顶点数组交给 luma 自己绑,作为基准
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const va = (p as unknown as { vertexArray: any }).vertexArray;
    va.setBuffer(va.getBufferSlot('uv'), (uv as unknown as { handle: unknown }).handle);
    va.setBuffer(va.getBufferSlot('pos'), (pos as unknown as { handle: unknown }).handle);
    const ref: unknown[][] = [];
    va.bindBeforeRender({ handle: { setVertexBuffer: (...a: unknown[]) => ref.push(['setVertexBuffer', ...a]), setIndexBuffer() {} } });
    expect(got).toEqual(nativeState(ref));
    expect([...got].sort()).toEqual(['vb0:posBuf@0', 'vb1:uvBuf@0']);
  });
});

describe('destroy 拆掉画布上下文(D13)', () => {
  it('先拆画布上下文(unconfigure、停 Resize / Intersection 观察与 DPR 监听),再销毁设备', () => {
    const { fake, dev } = setup();
    dev.destroy();
    const order = fake.log.map((c) => c[0]).filter((n) => n === 'canvasContext.destroy' || n === 'luma.destroy');
    expect(order).toEqual(['canvasContext.destroy', 'luma.destroy']);
    expect(fake.canvasContext.destroyed).toBe(true);
  });

  it('用 luma 真的 WebGPUCanvasContext:destroy 之后 GPUCanvasContext 已 unconfigure,观察者与 DPR 监听全停', async () => {
    const req = createRequire(import.meta.url);
    const dist = dirname(req.resolve('@luma.gl/webgpu'));
    const { WebGPUCanvasContext } = await import(pathToFileURL(join(dist, 'adapter/webgpu-canvas-context.js')).href);
    const { WebGPUDevice } = await import('@luma.gl/webgpu');

    const log: string[] = [];
    const liveResize = new Set<object>();
    const liveIntersect = new Set<object>();
    const dprListeners = new Set<unknown>();
    class FakeCanvas {
      width = 16; height = 16; clientWidth = 16; clientHeight = 16; id = 'c';
      ctx = { configure: () => log.push('configure'), unconfigure: () => log.push('unconfigure'), getConfiguration: () => null };
      getContext() { return this.ctx; }
      getBoundingClientRect() { return { left: 0, top: 0 }; }
    }
    vi.stubGlobal('HTMLCanvasElement', FakeCanvas);
    vi.stubGlobal('ResizeObserver', class { observe() { liveResize.add(this); } disconnect() { liveResize.delete(this); } });
    vi.stubGlobal('IntersectionObserver', class { observe() { liveIntersect.add(this); } disconnect() { liveIntersect.delete(this); } });
    vi.stubGlobal('matchMedia', () => ({
      addEventListener: (_: string, l: unknown) => dprListeners.add(l),
      removeEventListener: (_: string, l: unknown) => dprListeners.delete(l),
    }));
    vi.stubGlobal('window', globalThis);
    vi.stubGlobal('devicePixelRatio', 1);
    // probe.gl 靠 process.browser 判「在浏览器里」,不是浏览器就不起观察者
    const proc = process as unknown as { browser?: boolean };
    const prevBrowser = proc.browser;
    proc.browser = true;
    try {
      const gpuDevice = Object.create(WebGPUDevice.prototype);
      const fake = createFakeLuma();
      Object.assign(gpuDevice, fake.device as object, {
        id: 'dev',
        preferredDepthFormat: 'depth24plus',
        handle: { destroy: () => log.push('GPUDevice.destroy') },
        commandEncoder: { destroy() {} },
        _defaultSampler: null,
        props: { onResize() {}, onVisibilityChange() {}, onDevicePixelRatioChange() {}, onPositionChange() {} },
      });
      // 用 luma 真的 WebGPUDevice.destroy(它不碰画布上下文——这正是要 RHI 自己拆的原因)
      delete gpuDevice.destroy;
      const ctx = new WebGPUCanvasContext(gpuDevice, null, { canvas: new FakeCanvas(), alphaMode: 'opaque', useDevicePixels: true, autoResize: true });
      gpuDevice.getDefaultCanvasContext = () => ctx;
      await new Promise((r) => setTimeout(r, 5));
      expect([liveResize.size, liveIntersect.size, dprListeners.size]).toEqual([1, 1, 1]);

      const rhi = new LumaRhiDevice(gpuDevice as Device);
      log.length = 0;
      rhi.destroy();
      expect(log).toEqual(['unconfigure', 'GPUDevice.destroy']);
      expect([liveResize.size, liveIntersect.size, dprListeners.size]).toEqual([0, 0, 0]);
    } finally {
      proc.browser = prevBrowser;
      vi.unstubAllGlobals();
    }
  });
});

describe('图像上传不支持 flipY,当场报而不是静默丢掉(D26)', () => {
  const image = {} as ImageBitmap;

  it('uploadImage({ flipY: true }) 报 unsupported,不下发拷贝', () => {
    const { fake, dev } = setup();
    const tex = dev.rootScope.createTexture({ label: 't', width: 4, height: 4, format: 'rgba8unorm', usage: RhiTextureUsage.SAMPLED | RhiTextureUsage.COPY_DST });
    expect(() => dev.uploadImage(tex, image, { flipY: true })).toThrow(expect.objectContaining({ code: 'unsupported' }));
    expect(fake.log.some((c) => c[0] === 'copyExternalImage')).toBe(false);
    // 不翻转的照常上传
    dev.uploadImage(tex, image, { premultiplyAlpha: true });
    expect(fake.log.filter((c) => c[0] === 'copyExternalImage')).toHaveLength(1);
  });

  it('createTexture({ flipY: true, data: 图像 }) 同样报 unsupported', () => {
    const { dev } = setup();
    expect(() => dev.rootScope.createTexture({
      label: 't', width: 4, height: 4, format: 'rgba8unorm', usage: RhiTextureUsage.SAMPLED, data: image, flipY: true,
    })).toThrow(expect.objectContaining({ code: 'unsupported' }));
  });
});
