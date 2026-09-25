/**
 * 设备丢失后自动恢复(D6):master 的 Pixi WebGL 在 webglcontextlost 里 preventDefault 让浏览器恢复上下文,
 * webglcontextrestored 时跑 runners.contextChange,各系统丢掉旧 GL 对象、下次用时按 CPU 源重建重传,游戏接着跑。
 * WebGPU 没有「恢复」这回事:丢了的 GPUDevice 永远不能再用,只能在同一画布上重新要适配器 / 设备。
 * 这里在假 luma 设备上验证 RHI 的对应行为:
 * - 丢失(不是自己 destroy 引起的)→ 诊断「图形设备丢失」→ 拆旧画布上下文 → 按同一套参数重建设备 → 诊断「已恢复」→ onRestored
 * - 旧设备上建的资源全部作废(再用当场报 destroyed-resource),作用域照常可建新资源;帧照常提交到新设备
 * - 反复丢失各自恢复;重建期间 destroy / 重建失败重试 / 回读期间丢失都有交代
 */
import { describe, expect, it } from 'vitest';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import type { Device } from '@luma.gl/core';
import { RhiBufferUsage, RhiError, RhiTextureUsage } from '../../types';
import { createFakeLuma, type FakeLuma } from '../testing/fakeLumaDevice';
import { LumaRhiDevice } from './LumaRhiDevice';

const PLAIN_WGSL = /* wgsl */ `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> { return vec4<f32>(f32(i), 0.0, 0.0, 1.0); }
@fragment fn fs() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }
`;

/** 让挂起的 Promise 链(丢失 → 重建 → 恢复)跑完 */
async function flush(ms = 0): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, ms));
}

function setup(opts: { failRecreate?: number } = {}) {
  const fakes: FakeLuma[] = [createFakeLuma()];
  let failures = opts.failRecreate ?? 0;
  const order: string[] = [];
  const recreateDevice = async (): Promise<Device> => {
    order.push(`recreate(旧画布上下文已拆=${fakes[fakes.length - 1].canvasContext.destroyed})`);
    // 真设备要等适配器 / 设备请求,不会在同一轮微任务里建好
    await new Promise((r) => setTimeout(r, 0));
    if (failures > 0) {
      failures--;
      throw new Error('requestAdapter 返回 null(测试注入)');
    }
    const f = createFakeLuma();
    fakes.push(f);
    return f.device as Device;
  };
  const dev = new LumaRhiDevice(fakes[0].device as Device, { recreateDevice, restoreRetryDelaysMs: [0, 1, 1] });
  const diags: { severity: string; code: string; message: string }[] = [];
  dev.onDiagnostic((e, severity) => diags.push({ severity, code: e.code, message: e.message }));
  let restored = 0;
  dev.onRestored(() => {
    restored++;
  });
  return { fakes, dev, diags, order, restoredCount: () => restored };
}

function drawFrame(dev: LumaRhiDevice): boolean {
  const shader = dev.rootScope.createShader({ label: 'p', wgsl: PLAIN_WGSL });
  const p = dev.rootScope.createRenderPipeline({ label: 'p', shader, colorFormats: ['bgra8unorm'] });
  return dev.runFrame((f) => {
    const pass = f.commands.beginRenderPass({ label: 'main', target: f.swapchain, colorOps: [{ load: 'clear', clearValue: [0, 0, 0, 1] }] });
    pass.setPipeline(p);
    pass.draw(3);
    pass.end();
  });
}

describe('设备丢失后在同一画布上重建设备(D6,对照 Pixi GlContextSystem 的 contextlost / contextrestored)', () => {
  it('丢失 → 诊断 → 重建 → 已恢复 → onRestored;之后的帧提交到新设备', async () => {
    const { fakes, dev, diags, order, restoredCount } = setup();
    expect(drawFrame(dev)).toBe(true);

    fakes[0].lose('GPU process crashed');
    expect(await dev.lost).toBe('GPU process crashed');
    expect(dev.isLost).toBe(true);
    expect(diags.some((d) => d.severity === 'error' && d.message.includes('图形设备丢失:GPU process crashed'))).toBe(true);
    // 恢复之前的帧照旧作废(同 WebGL 上下文丢失期间画不出东西)
    expect(dev.runFrame(() => {})).toBe(false);

    await flush();
    // 旧画布上下文先拆(同一块画布的 GPUCanvasContext 只有一个,后拆会把新配置 unconfigure 掉),再建新设备
    expect(order).toEqual(['recreate(旧画布上下文已拆=true)']);
    expect(fakes).toHaveLength(2);
    expect(fakes[0].log.some((c) => c[0] === 'luma.destroy')).toBe(true);
    expect(dev.isLost).toBe(false);
    expect(restoredCount()).toBe(1);
    expect(diags.some((d) => d.message.includes('图形设备已恢复'))).toBe(true);

    const before = fakes[1].log.length;
    expect(drawFrame(dev)).toBe(true);
    const after = fakes[1].log.slice(before);
    expect(after.some((c) => c[0] === 'draw')).toBe(true);
    expect(after.some((c) => c[0] === 'submit')).toBe(true);
    dev.destroy();
  });

  it('旧设备上的资源全部作废(再用当场报 destroyed-resource),作用域保留、照常建新资源', async () => {
    const { fakes, dev } = setup();
    const scope = dev.createScope('场景');
    const tex = scope.createTexture({ label: 'tex', width: 4, height: 4, format: 'rgba8unorm', usage: RhiTextureUsage.SAMPLED | RhiTextureUsage.COPY_DST });
    const child = scope.createChild('子');
    const buf = child.createBuffer({ label: 'buf', size: 16, usage: 0 });
    fakes[0].lose();
    await flush();
    expect(tex.destroyed).toBe(true);
    expect(buf.destroyed).toBe(true);
    expect(scope.destroyed).toBe(false);
    expect(child.destroyed).toBe(false);
    expect(() => dev.writeTexture(tex, new Uint8Array(64))).toThrow(RhiError);
    const fresh = scope.createTexture({ label: 'tex2', width: 4, height: 4, format: 'rgba8unorm', usage: RhiTextureUsage.SAMPLED | RhiTextureUsage.COPY_DST });
    expect(fresh.destroyed).toBe(false);
    dev.writeTexture(fresh, new Uint8Array(64));
    expect(fakes[1].log.some((c) => c[0] === 'writeData' && c[1] === 'tex2')).toBe(true);
    dev.destroy();
  });

  it('画布尺寸按最近一次 resizeSwapchain 补给新设备的画布上下文', async () => {
    const { fakes, dev } = setup();
    dev.resizeSwapchain(320, 200);
    fakes[0].lose();
    // 丢失期间改尺寸(旧上下文已拆):记下来,恢复时给新上下文
    dev.resizeSwapchain(640, 360);
    await flush();
    expect(fakes[1].log.filter((c) => c[0] === 'setDrawingBufferSize')).toEqual([['setDrawingBufferSize', 640, 360]]);
    dev.destroy();
  });

  it('反复丢失:每次都重建;迟到的旧设备丢失信号不影响新设备', async () => {
    const { fakes, dev, restoredCount } = setup();
    fakes[0].lose();
    await flush();
    fakes[1].lose();
    await flush();
    expect(fakes).toHaveLength(3);
    expect(restoredCount()).toBe(2);
    expect(dev.isLost).toBe(false);
    // 旧设备的丢失信号再来一次(已被替换):什么都不做
    fakes[0].lose();
    await flush();
    expect(fakes).toHaveLength(3);
    expect(drawFrame(dev)).toBe(true);
    dev.destroy();
  });

  it('自己 destroy 引起的丢失不重建;重建途中 destroy:新设备随即销毁,不通知恢复', async () => {
    const a = setup();
    a.dev.destroy();
    await flush();
    expect(a.order).toEqual([]);
    expect(a.restoredCount()).toBe(0);

    const b = setup();
    b.fakes[0].lose();
    await b.dev.lost;
    b.dev.destroy();
    await flush();
    expect(b.fakes).toHaveLength(2);
    expect(b.fakes[1].log.some((c) => c[0] === 'luma.destroy')).toBe(true);
    expect(b.restoredCount()).toBe(0);
    expect(b.dev.runFrame(() => {})).toBe(false);
  });

  it('重建失败按间隔重试,成功后照常恢复;重试用尽报错并停下', async () => {
    const ok = setup({ failRecreate: 2 });
    ok.fakes[0].lose();
    await flush(2);
    expect(ok.order).toHaveLength(3);
    expect(ok.restoredCount()).toBe(1);
    expect(ok.dev.isLost).toBe(false);
    ok.dev.destroy();

    const bad = setup({ failRecreate: 99 });
    bad.fakes[0].lose();
    await flush(2);
    expect(bad.order).toHaveLength(3);
    expect(bad.restoredCount()).toBe(0);
    expect(bad.dev.isLost).toBe(true);
    expect(bad.diags.some((d) => d.severity === 'error' && d.message.includes('图形设备恢复失败'))).toBe(true);
    bad.dev.destroy();
  });

  it('回读途中设备丢失:回读 reject(RhiError),不会永远挂着', async () => {
    const { fakes, dev } = setup();
    const tex = dev.rootScope.createTexture({ label: 'rb', width: 2, height: 2, format: 'rgba8unorm', usage: RhiTextureUsage.COPY_SRC });
    // 假设备上回读的暂存缓冲永远不完成(真 GPU 进程崩了时 mapAsync 可能迟迟不回)
    const lumaTex = (tex as unknown as { handle: Record<string, unknown> }).handle;
    lumaTex.computeMemoryLayout = () => ({ byteLength: 16, bytesPerPixel: 4, bytesPerRow: 8 });
    lumaTex.readBuffer = () => {};
    const device = fakes[0].device as { createBuffer: (p: unknown) => Record<string, unknown> };
    const createBuffer = device.createBuffer;
    device.createBuffer = (p) => ({ ...createBuffer(p), readAsync: () => new Promise(() => {}) });
    const pending = dev.readTexture(tex).then(() => null, (e: unknown) => e);
    fakes[0].lose('TDR');
    const err = await pending;
    expect(err).toBeInstanceOf(RhiError);
    expect((err as RhiError).message).toContain('设备丢失');
    await flush();
    // 恢复后旧纹理已作废,回读当场报
    await expect(dev.readTexture(tex)).rejects.toThrow(RhiError);
    dev.destroy();
  });

  it('正常完成的回读不被设备扣住:结果交给调用方后即可回收(与丢失赛跑不能挂在跨整个设备寿命的 Promise 上)', async () => {
    // 手动触发完整 GC:v8 标志运行中打开后,新上下文里才拿得到 gc()
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    // 工程的 lib 不含 es2021.weakref,运行时(Node)有,这里按最小类型取
    type WeakRefOf<T> = { deref(): T | undefined };
    const WeakRefCtor = (globalThis as unknown as { WeakRef: new <T extends object>(target: T) => WeakRefOf<T> }).WeakRef;
    const { fakes, dev } = setup();
    const buf = dev.rootScope.createBuffer({ label: 'rb', size: 1 << 20, usage: RhiBufferUsage.COPY_SRC });
    // 回读放在单独的函数里跑完,测试自己的帧里不留结果的引用
    const readMany = async (): Promise<WeakRefOf<Uint8Array>[]> => {
      const out: WeakRefOf<Uint8Array>[] = [];
      for (let i = 0; i < 8; i++) {
        const data = await dev.readBuffer(buf);
        expect(data.byteLength).toBe(1 << 20);
        out.push(new WeakRefCtor(data));
      }
      return out;
    };
    const refs = await readMany();
    // WeakRef 在创建它的那一轮任务里保活目标,换一轮再收
    await new Promise((r) => setTimeout(r, 0));
    gc();
    expect(refs.filter((r) => r.deref() !== undefined)).toHaveLength(0);
    // 回收之后赛跑照旧:再丢失时挂着的回读仍会 reject
    const handle = (buf as unknown as { handle: Record<string, unknown> }).handle;
    handle.readAsync = () => new Promise(() => {});
    const pending = dev.readBuffer(buf).then(() => null, (e: unknown) => e);
    fakes[0].lose('TDR');
    expect(await pending).toBeInstanceOf(RhiError);
    dev.destroy();
  });
});
