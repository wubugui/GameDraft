/**
 * 空后端的校验与真后端(LumaRhiDevice,跑在假 luma 设备上)逐条一致:同一段用法在两个后端上
 * 要么都通过、要么报同一类错。空后端放过而真后端拒绝的用法,单测会绿、真机却丢帧(D27)。
 * 另:空后端能模拟建坏的管线(D7)、flipY 与真后端一样当场报(D26)。
 */
import { describe, expect, it } from 'vitest';
import type { Device } from '@luma.gl/core';
import { RhiBufferUsage, RhiError, RhiTextureUsage } from '../../types';
import type { RhiCommandList, RhiDevice, RhiFrame } from '../../RhiDevice';
import { LumaRhiDevice } from '../luma/LumaRhiDevice';
import { createFakeLuma } from '../testing/fakeLumaDevice';
import { NullRhiDevice } from './NullRhiDevice';

const STREAM_WGSL = /* wgsl */ `
@group(0) @binding(0) var<uniform> u: vec4<f32>;
@group(0) @binding(1) var uTex: texture_2d<f32>;
@group(0) @binding(2) var uTexSampler: sampler;
@vertex fn vs(@location(0) aPos: vec2<f32>) -> @builtin(position) vec4<f32> { return vec4<f32>(aPos, 0.0, 1.0) + u; }
@fragment fn fs() -> @location(0) vec4<f32> { return textureSample(uTex, uTexSampler, vec2<f32>(0.0)); }
`;

const PLAIN_WGSL = /* wgsl */ `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> { return vec4<f32>(f32(i), 0.0, 0.0, 1.0); }
@fragment fn fs() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }
`;

const COMPUTE_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> data: array<f32>;
@compute @workgroup_size(1) fn main() { data[0] = 1.0; }
`;

const S = RhiTextureUsage.SAMPLED;
const RT = RhiTextureUsage.RENDER_TARGET;

/** 在设备上跑一段用法:同步抛的错、或帧 / 批次作废时上报的错,都折成错误码;没错就是 'ok' */
function outcome(dev: RhiDevice, run: (dev: RhiDevice, h: Helpers) => void): string {
  let reported: RhiError | null = null;
  const off = dev.onDiagnostic((e, severity) => {
    if (severity === 'error') reported ??= e;
  });
  const h: Helpers = {
    frame: (fn) => {
      if (!dev.runFrame(fn)) throw reported ?? new Error('runFrame 失败却没上报');
    },
    submit: (fn) => {
      if (!dev.submit('批次', fn)) throw reported ?? new Error('submit 失败却没上报');
    },
  };
  try {
    run(dev, h);
    return 'ok';
  } catch (e) {
    return e instanceof RhiError ? e.code : `非 RhiError:${String(e)}`;
  } finally {
    off();
  }
}

interface Helpers {
  frame(fn: (f: RhiFrame) => void): void;
  submit(fn: (c: RhiCommandList) => void): void;
}

function streamPipeline(dev: RhiDevice, label = 'p') {
  const shader = dev.rootScope.createShader({ label, wgsl: STREAM_WGSL });
  return dev.rootScope.createRenderPipeline({
    label, shader, colorFormats: ['bgra8unorm'],
    vertexBuffers: [{ name: 'pos', stride: 8, attributes: [{ name: 'aPos', format: 'float32x2', offset: 0 }] }],
  });
}

function res(dev: RhiDevice) {
  return {
    ubo: dev.rootScope.createBuffer({ label: 'ubo', size: 256, usage: RhiBufferUsage.UNIFORM }),
    vbo: dev.rootScope.createBuffer({ label: 'vbo', size: 64, usage: RhiBufferUsage.VERTEX }),
    ibo: dev.rootScope.createBuffer({ label: 'ibo', size: 64, usage: RhiBufferUsage.INDEX, indexFormat: 'uint32' }),
    tex: dev.rootScope.createTexture({ label: 'tex', width: 8, height: 8, format: 'rgba8unorm', usage: S }),
  };
}

type Case = [name: string, expected: string, run: (dev: RhiDevice, h: Helpers) => void];

const CASES: Case[] = [
  ['合法的完整 draw / drawIndexed', 'ok', (dev, h) => {
    const p = streamPipeline(dev);
    const r = res(dev);
    const s = dev.rootScope.createSampler({ label: 'near', magFilter: 'nearest' });
    h.frame((f) => {
      const pass = f.commands.beginRenderPass({ label: 'x', target: f.swapchain, colorOps: [{ load: 'clear' }] });
      pass.setPipeline(p);
      // 没声明的名字忽略;「纹理名Sampler」配给纹理
      pass.setBindings({ u: { buffer: r.ubo, offset: 0, size: 16 }, uTex: r.tex, uTexSampler: s, unused: r.vbo });
      pass.setVertexBuffer('pos', r.vbo);
      pass.draw(3);
      pass.setIndexBuffer(r.ibo);
      pass.drawIndexed(3);
      pass.end();
    });
  }],
  ['drawIndexed:顶点流没绑、索引也没设', 'invalid-usage', (dev, h) => {
    const p = streamPipeline(dev);
    const r = res(dev);
    h.frame((f) => {
      const pass = f.commands.beginRenderPass({ label: 'x', target: f.swapchain });
      pass.setPipeline(p);
      pass.setBindings({ u: r.ubo, uTex: r.tex });
      pass.drawIndexed(3);
      pass.end();
    });
  }],
  ['drawIndexed:顶点流绑了、索引没设', 'invalid-usage', (dev, h) => {
    const p = streamPipeline(dev);
    const r = res(dev);
    h.frame((f) => {
      const pass = f.commands.beginRenderPass({ label: 'x', target: f.swapchain });
      pass.setPipeline(p);
      pass.setBindings({ u: r.ubo, uTex: r.tex });
      pass.setVertexBuffer('pos', r.vbo);
      pass.drawIndexed(3);
      pass.end();
    });
  }],
  ['setIndexBuffer 给只有 VERTEX 用途的缓冲', 'invalid-usage', (dev, h) => {
    const r = res(dev);
    h.frame((f) => {
      const pass = f.commands.beginRenderPass({ label: 'x', target: f.swapchain });
      pass.setIndexBuffer(r.vbo);
      pass.end();
    });
  }],
  ['着色器有绑定,setPipeline 之后没 setBindings 就 draw', 'invalid-usage', (dev, h) => {
    const p = streamPipeline(dev);
    const r = res(dev);
    h.frame((f) => {
      const pass = f.commands.beginRenderPass({ label: 'x', target: f.swapchain });
      pass.setPipeline(p);
      pass.setVertexBuffer('pos', r.vbo);
      pass.draw(3);
      pass.end();
    });
  }],
  ['着色器要的绑定没给', 'invalid-usage', (dev, h) => {
    const p = streamPipeline(dev);
    const r = res(dev);
    h.frame((f) => {
      const pass = f.commands.beginRenderPass({ label: 'x', target: f.swapchain });
      pass.setPipeline(p);
      pass.setBindings({ u: r.ubo });
      pass.end();
    });
  }],
  ['setPipeline 之前 setBindings', 'invalid-usage', (dev, h) => {
    const r = res(dev);
    h.frame((f) => {
      const pass = f.commands.beginRenderPass({ label: 'x', target: f.swapchain });
      pass.setBindings({ u: r.ubo });
      pass.end();
    });
  }],
  ['draw 时顶点流缓冲已销毁', 'destroyed-resource', (dev, h) => {
    const p = streamPipeline(dev);
    const r = res(dev);
    h.frame((f) => {
      const pass = f.commands.beginRenderPass({ label: 'x', target: f.swapchain });
      pass.setPipeline(p);
      pass.setBindings({ u: r.ubo, uTex: r.tex });
      pass.setVertexBuffer('pos', r.vbo);
      r.vbo.destroy();
      pass.draw(3);
      pass.end();
    });
  }],
  ['别的设备的缓冲当顶点流', 'invalid-usage', (dev, h) => {
    const foreign = new NullRhiDevice().rootScope.createBuffer({ label: 'foreign', size: 64, usage: RhiBufferUsage.VERTEX });
    const alien = dev instanceof NullRhiDevice
      ? new LumaRhiDevice(createFakeLuma().device as Device).rootScope.createBuffer({ label: 'foreign', size: 64, usage: RhiBufferUsage.VERTEX })
      : foreign;
    h.frame((f) => {
      const pass = f.commands.beginRenderPass({ label: 'x', target: f.swapchain });
      pass.setVertexBuffer('pos', alien);
      pass.end();
    });
  }],
  ['多重采样纹理带多级 mip', 'invalid-usage', (dev) => {
    dev.rootScope.createTexture({ label: 'ms', width: 8, height: 8, format: 'rgba8unorm', usage: RT, sampleCount: 4, mipLevels: 2 });
  }],
  ['多重采样纹理带 SAMPLED 用途', 'invalid-usage', (dev) => {
    dev.rootScope.createTexture({ label: 'ms', width: 8, height: 8, format: 'rgba8unorm', usage: RT | S, sampleCount: 4 });
  }],
  ['纹理超过设备上限', 'unsupported', (dev) => {
    dev.rootScope.createTexture({ label: 'huge', width: 20000, height: 4, format: 'rgba8unorm', usage: S });
  }],
  ['resolve 目标没有 RENDER_TARGET 用途', 'invalid-usage', (dev) => {
    const ms = dev.rootScope.createTexture({ label: 'ms', width: 8, height: 8, format: 'rgba8unorm', usage: RT, sampleCount: 4 });
    const resolve = dev.rootScope.createTexture({ label: 'r', width: 8, height: 8, format: 'rgba8unorm', usage: S });
    dev.rootScope.createRenderTarget({ label: 't', colors: [ms], resolveTargets: [resolve] });
  }],
  ['resolve 目标已销毁', 'destroyed-resource', (dev) => {
    const ms = dev.rootScope.createTexture({ label: 'ms', width: 8, height: 8, format: 'rgba8unorm', usage: RT, sampleCount: 4 });
    const resolve = dev.rootScope.createTexture({ label: 'r', width: 8, height: 8, format: 'rgba8unorm', usage: RT | S });
    resolve.destroy();
    dev.rootScope.createRenderTarget({ label: 't', colors: [ms], resolveTargets: [resolve] });
  }],
  ['copyTextureToTexture 尺寸越界', 'invalid-usage', (dev, h) => {
    const a = dev.rootScope.createTexture({ label: 'a', width: 8, height: 8, format: 'rgba8unorm', usage: RhiTextureUsage.COPY_SRC });
    const b = dev.rootScope.createTexture({ label: 'b', width: 2, height: 2, format: 'rgba8unorm', usage: RhiTextureUsage.COPY_DST });
    h.submit((c) => c.copyTextureToTexture(a, b));
  }],
  ['copyTextureToTexture 格式不同', 'invalid-usage', (dev, h) => {
    const a = dev.rootScope.createTexture({ label: 'a', width: 8, height: 8, format: 'rgba8unorm', usage: RhiTextureUsage.COPY_SRC });
    const b = dev.rootScope.createTexture({ label: 'b', width: 8, height: 8, format: 'rgba16float', usage: RhiTextureUsage.COPY_DST });
    h.submit((c) => c.copyTextureToTexture(a, b));
  }],
  ['copyBufferToBuffer 越界', 'invalid-usage', (dev, h) => {
    const a = dev.rootScope.createBuffer({ label: 'a', size: 16, usage: RhiBufferUsage.COPY_SRC });
    const b = dev.rootScope.createBuffer({ label: 'b', size: 16, usage: RhiBufferUsage.COPY_DST });
    h.submit((c) => c.copyBufferToBuffer(a, 8, b, 0, 16));
  }],
  ['createBuffer 初始数据超过大小', 'invalid-usage', (dev) => {
    dev.rootScope.createBuffer({ label: 'b', size: 4, usage: RhiBufferUsage.VERTEX, data: new Uint8Array(8) });
  }],
  ['颜色附件操作比附件多', 'invalid-usage', (dev, h) => {
    h.frame((f) => {
      f.commands.beginRenderPass({ label: 'x', target: f.swapchain, colorOps: [{ load: 'clear' }, { load: 'clear' }] }).end();
    });
  }],
  ['画布后备缓冲拿到 runFrame 之外用', 'invalid-usage', (dev, h) => {
    let swapchain: RhiFrame['swapchain'] | null = null;
    h.frame((f) => {
      swapchain = f.swapchain;
    });
    h.submit((c) => c.beginRenderPass({ label: 'late', target: swapchain! }).end());
  }],
  ['画布多重采样数不是 1 / 4', 'unsupported', (dev, h) => {
    h.frame((f) => {
      f.swapchainMultisampled(2);
    });
  }],
  ['管线颜色附件超过设备上限', 'unsupported', (dev) => {
    const shader = dev.rootScope.createShader({ label: 's', wgsl: PLAIN_WGSL });
    dev.rootScope.createRenderPipeline({ label: 'p', shader, colorFormats: Array(9).fill('rgba8unorm') });
  }],
  ['用已销毁的着色器建管线', 'destroyed-resource', (dev) => {
    const shader = dev.rootScope.createShader({ label: 's', wgsl: PLAIN_WGSL });
    shader.destroy();
    dev.rootScope.createRenderPipeline({ label: 'p', shader, colorFormats: ['bgra8unorm'] });
  }],
  ['显式入口名优先(WGSL 里没有 @vertex 标注也认)', 'ok', (dev) => {
    const shader = dev.rootScope.createShader({ label: 's', wgsl: COMPUTE_WGSL, entryPoints: { vertex: 'main', fragment: 'main' } });
    if (!shader.hasRender) throw new Error('显式入口没被认');
  }],
  ['计算管线有绑定却没 setBindings 就 dispatch', 'invalid-usage', (dev, h) => {
    const shader = dev.rootScope.createShader({ label: 'cs', wgsl: COMPUTE_WGSL });
    const p = dev.rootScope.createComputePipeline({ label: 'cs', shader });
    h.submit((c) => {
      const pass = c.beginComputePass('cs');
      pass.setPipeline(p);
      pass.dispatch(1);
      pass.end();
    });
  }],
  ['计算管线 setPipeline 之前 setBindings', 'invalid-usage', (dev, h) => {
    const data = dev.rootScope.createBuffer({ label: 'data', size: 16, usage: RhiBufferUsage.STORAGE });
    h.submit((c) => {
      const pass = c.beginComputePass('cs');
      pass.setBindings({ data });
      pass.end();
    });
  }],
  ['uploadImage 要 flipY', 'unsupported', (dev) => {
    const t = dev.rootScope.createTexture({ label: 't', width: 4, height: 4, format: 'rgba8unorm', usage: S | RhiTextureUsage.COPY_DST });
    dev.uploadImage(t, {} as ImageBitmap, { flipY: true });
  }],
  ['createTexture 带图像源 + flipY', 'unsupported', (dev) => {
    dev.rootScope.createTexture({ label: 't', width: 4, height: 4, format: 'rgba8unorm', usage: S, data: {} as ImageBitmap, flipY: true });
  }],
  ['录制中写本批已引用的缓冲', 'invalid-usage', (dev, h) => {
    const p = streamPipeline(dev);
    const r = res(dev);
    h.frame((f) => {
      const pass = f.commands.beginRenderPass({ label: 'x', target: f.swapchain });
      pass.setPipeline(p);
      pass.setBindings({ u: r.ubo, uTex: r.tex });
      dev.writeBuffer(r.ubo, new Uint8Array(4));
      pass.end();
    });
  }],
];

describe('空后端与真后端校验一致(D27)', () => {
  it.each(CASES)('%s → %s', (_name, expected, run) => {
    const nullDev = new NullRhiDevice();
    const lumaDev = new LumaRhiDevice(createFakeLuma({ maxTextureSize: 8192 }).device as Device);
    const luma = outcome(lumaDev, run);
    const nul = outcome(nullDev, run);
    expect({ luma, null: nul }).toEqual({ luma: expected, null: expected });
  });

  it('图像源建纹理时补的用途位一致(拷贝目标 + 渲染附件)', () => {
    const make = (dev: RhiDevice) =>
      dev.rootScope.createTexture({ label: 't', width: 4, height: 4, format: 'rgba8unorm', usage: S, data: {} as ImageBitmap }).usage;
    const luma = make(new LumaRhiDevice(createFakeLuma().device as Device));
    expect(make(new NullRhiDevice())).toBe(luma);
    expect(luma).toBe(S | RhiTextureUsage.COPY_DST | RT);
  });

  it('销毁后 runFrame / submit 都不再录制', () => {
    for (const dev of [new NullRhiDevice(), new LumaRhiDevice(createFakeLuma().device as Device)] as RhiDevice[]) {
      dev.destroy();
      expect(dev.runFrame(() => {})).toBe(false);
      expect(dev.submit('x', () => {})).toBe(false);
    }
  });
});

describe('空后端模拟建坏的管线(D7)', () => {
  it('failPipeline 命中的管线:ready reject;它的 draw 跳过并计数、告警一次,帧里其余 draw 照画、照常提交', async () => {
    const dev = new NullRhiDevice({ failPipeline: (label) => label === 'bad' });
    const diags: { severity: string; message: string }[] = [];
    dev.onDiagnostic((e, severity) => diags.push({ severity, message: e.message }));
    const shader = dev.rootScope.createShader({ label: 's', wgsl: PLAIN_WGSL });
    const bad = dev.rootScope.createRenderPipeline({ label: 'bad', shader, colorFormats: ['bgra8unorm'] });
    const good = dev.rootScope.createRenderPipeline({ label: 'good', shader, colorFormats: ['bgra8unorm'] });
    await expect(bad.ready).rejects.toBeInstanceOf(RhiError);
    expect(bad.isReady).toBe(false);
    await good.ready;

    for (let i = 0; i < 2; i++) {
      expect(dev.runFrame((f) => {
        const pass = f.commands.beginRenderPass({ label: 'main', target: f.swapchain });
        pass.setPipeline(bad);
        pass.setBindings({});
        pass.draw(3);
        pass.setPipeline(good);
        pass.draw(6);
        pass.end();
      })).toBe(true);
      expect(dev.lastFrameStats).toMatchObject({ draws: 1, skippedDraws: 1 });
    }
    expect(dev.log.filter((l) => l.startsWith('draw '))).toEqual(['draw good 6', 'draw good 6']);
    expect(diags.filter((d) => d.severity === 'warning')).toHaveLength(1);
    expect(diags.filter((d) => d.severity === 'error')).toHaveLength(1);
  });
});

describe('空后端模拟设备丢失与恢复(D6,与真后端同一套可见行为)', () => {
  it('loseDevice:诊断「丢失」→ 恢复前帧作废 → 旧资源作废、作用域保留 → 诊断「已恢复」→ onRestored → 帧照常', async () => {
    const dev = new NullRhiDevice();
    const diags: { severity: string; message: string }[] = [];
    dev.onDiagnostic((e, severity) => diags.push({ severity, message: e.message }));
    let restored = 0;
    dev.onRestored(() => restored++);
    const scope = dev.createScope('场景');
    const tex = scope.createTexture({ label: 't', width: 4, height: 4, format: 'rgba8unorm', usage: S });
    const lost = dev.lost;

    const done = dev.loseDevice('测试');
    expect(dev.isLost).toBe(true);
    expect(await lost).toBe('测试');
    expect(dev.runFrame(() => {})).toBe(false);
    expect(dev.submit('x', () => {})).toBe(false);
    await done;

    expect(dev.isLost).toBe(false);
    expect(restored).toBe(1);
    expect(tex.destroyed).toBe(true);
    expect(scope.destroyed).toBe(false);
    expect(scope.createTexture({ label: 't2', width: 4, height: 4, format: 'rgba8unorm', usage: S }).destroyed).toBe(false);
    expect(dev.lost).not.toBe(lost);
    expect(diags.map((d) => [d.severity, /图形设备(丢失|已恢复)/.exec(d.message)?.[0]])).toEqual([['error', '图形设备丢失'], ['warning', '图形设备已恢复']]);
    expect(dev.runFrame((f) => f.commands.beginRenderPass({ label: 'x', target: f.swapchain }).end())).toBe(true);
  });

  it('restore: false 停在丢失状态;丢失后、恢复前 destroy 就不再恢复', async () => {
    const dev = new NullRhiDevice();
    let restored = 0;
    dev.onRestored(() => restored++);
    await dev.loseDevice('停住', { restore: false });
    expect(dev.isLost).toBe(true);
    expect(dev.runFrame(() => {})).toBe(false);

    const dev2 = new NullRhiDevice();
    dev2.onRestored(() => restored++);
    const p = dev2.loseDevice();
    dev2.destroy();
    await p;
    expect(restored).toBe(0);
  });
});
