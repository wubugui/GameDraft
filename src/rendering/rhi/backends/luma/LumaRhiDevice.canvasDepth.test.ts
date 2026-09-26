/**
 * 画布深度附件按格式各一张、由 RHI 持有(R4-1):
 * luma 的 WebGPUCanvasContext 只有一个深度槽,`_createDepthStencilAttachment` 见格式不同就把旧的销毁重建。
 * 同一帧里先后用两种深度格式的画布目标,后一种会销毁前一个 pass 还引用着的深度纹理,提交时整帧校验失败。
 * RhiFrame.swapchainWithDepth 的约定是「设备持有,尺寸随画布变」,NullRhiDevice 也是每个格式一张:
 * 这里验证 luma 后端照同一约定——深度纹理自己按格式建、按画布尺寸重建、设备恢复 / 销毁时放掉,不再碰 luma 的深度槽。
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Device } from '@luma.gl/core';
import { createFakeLuma, type FakeLuma } from '../testing/fakeLumaDevice';
import { LumaRhiDevice } from './LumaRhiDevice';
import { NullRhiDevice } from '../null/NullRhiDevice';

const dist = dirname(createRequire(import.meta.url).resolve('@luma.gl/webgpu'));
const { WebGPUCanvasContext } = (await import(pathToFileURL(join(dist, 'adapter/webgpu-canvas-context.js')).href)) as {
  WebGPUCanvasContext: { prototype: { _createDepthStencilAttachment(fmt: string): unknown } };
};

/**
 * 假 luma 设备,但画布上下文取帧缓冲时跑 luma **真的** `_createDepthStencilAttachment`(只有一个深度槽);
 * 设备建的纹理记下销毁;画布尺寸可改(模拟 resize)
 */
function setup(fake: FakeLuma = createFakeLuma()) {
  const destroyed = new Set<string>();
  const size = { w: 16, h: 16 };
  let n = 0;
  const lumaCtx = {
    id: 'canvas',
    get drawingBufferWidth() {
      return size.w;
    },
    get drawingBufferHeight() {
      return size.h;
    },
    depthStencilAttachment: null as null | { view: { handle: { view: string } } },
    device: {
      createTexture: (p: { format: string; width: number; height: number }) => {
        const id = `luma深度槽#${n++}(${p.format})`;
        return { id, format: p.format, width: p.width, height: p.height, view: { handle: { view: id } }, destroy: () => destroyed.add(id) };
      },
    },
  };
  // luma 配置画布(创建 / 每次 resize)时按 preferredDepthFormat 先建好深度槽
  const configure = () => WebGPUCanvasContext.prototype._createDepthStencilAttachment.call(lumaCtx, 'depth24plus');
  configure();
  const ctx = fake.canvasContext as unknown as Record<string, unknown>;
  Object.defineProperty(ctx, 'depthStencilAttachment', {
    get: () => lumaCtx.depthStencilAttachment,
    set: (v) => (lumaCtx.depthStencilAttachment = v),
    configurable: true,
  });
  ctx.getCurrentFramebuffer = (opts?: { depthStencilFormat?: string | false }) => {
    if (opts?.depthStencilFormat) WebGPUCanvasContext.prototype._createDepthStencilAttachment.call(lumaCtx, opts.depthStencilFormat);
    return {
      width: size.w,
      height: size.h,
      colorAttachments: [{ handle: { view: 'canvas' } }],
      depthStencilAttachment: opts?.depthStencilFormat ? lumaCtx.depthStencilAttachment!.view : null,
    };
  };
  ctx.getDrawingBufferSize = () => [size.w, size.h];
  const device = fake.device as { createTexture: (p: { id: string; width: number; height: number; format: string }) => { destroy(): void } };
  const created: { id: string; width: number; height: number; format: string }[] = [];
  const createTexture = device.createTexture;
  device.createTexture = (p) => {
    const t = createTexture(p);
    created.push({ id: p.id, width: p.width, height: p.height, format: p.format });
    t.destroy = () => destroyed.add(p.id);
    return t;
  };
  return { fake, destroyed, size, created, lumaCtx, configure };
}

function passDepthViews(fake: FakeLuma): [string, string | null][] {
  return fake.log.filter((c) => c[0] === 'pass.begin').map((c) => [c[1] as string, (c[3] as { view: string } | null)?.view ?? null]);
}

describe('画布深度附件按格式各一张、由 RHI 持有(R4-1)', () => {
  it('同一帧两种深度格式交替:各自一张深度纹理,提交前谁都没被销毁', () => {
    const { fake, destroyed } = setup();
    const dev = new LumaRhiDevice(fake.device as Device);
    const diags: string[] = [];
    dev.onDiagnostic((e) => diags.push(e.message));
    for (let frame = 0; frame < 2; frame++) {
      expect(dev.runFrame((f) => {
        const a = f.swapchainWithDepth('depth24plus');
        const b = f.swapchainWithDepth('depth24plus-stencil8');
        expect(a.depthFormat).toBe('depth24plus');
        expect(b.depthFormat).toBe('depth24plus-stencil8');
        f.commands.beginRenderPass({ label: 'A', target: a }).end();
        f.commands.beginRenderPass({ label: 'B', target: b }).end();
        f.commands.beginRenderPass({ label: 'A2', target: a }).end();
      })).toBe(true);
    }
    expect(diags).toEqual([]);
    const views = passDepthViews(fake);
    expect(views).toHaveLength(6);
    const [a, b, a2] = views.map((v) => v[1]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
    expect(a2).toBe(a);
    // 第二帧沿用同两张(尺寸没变不重建)
    expect(views.slice(3).map((v) => v[1])).toEqual([a, b, a]);
    // pass 引用过的深度纹理一张都没被销毁
    for (const [, v] of views) expect(destroyed.has(v!)).toBe(false);
  });

  it('深度纹理按画布尺寸建;画布尺寸变了下次取时重建、旧的放掉', () => {
    const { fake, destroyed, size, created } = setup();
    const dev = new LumaRhiDevice(fake.device as Device);
    const frame = () => dev.runFrame((f) => {
      f.commands.beginRenderPass({ label: 'D', target: f.swapchainWithDepth('depth24plus-stencil8') }).end();
    });
    expect(frame()).toBe(true);
    const first = passDepthViews(fake)[0][1]!;
    expect(created.find((c) => c.id === first)).toMatchObject({ width: 16, height: 16, format: 'depth24plus-stencil8' });

    size.w = 32;
    size.h = 24;
    dev.resizeSwapchain(32, 24);
    expect(frame()).toBe(true);
    const views = passDepthViews(fake);
    const latest = created.filter((c) => c.id === views[1][1]);
    expect(latest[latest.length - 1]).toMatchObject({ width: 32, height: 24, format: 'depth24plus-stencil8' });
    expect(created.filter((c) => c.format === 'depth24plus-stencil8')).toHaveLength(2);
    expect(destroyed.size).toBeGreaterThan(0);
    expect([...destroyed].every((id) => id === first || id.startsWith('luma深度槽'))).toBe(true);
  });

  it('设备销毁时放掉画布深度纹理', () => {
    const { fake, destroyed, created } = setup();
    const dev = new LumaRhiDevice(fake.device as Device);
    dev.runFrame((f) => {
      f.commands.beginRenderPass({ label: 'D', target: f.swapchainWithDepth('depth24plus') }).end();
    });
    const id = created.find((c) => c.format === 'depth24plus')!.id;
    expect(destroyed.has(id)).toBe(false);
    dev.destroy();
    expect(destroyed.has(id)).toBe(true);
  });

  it('设备丢失恢复后:旧设备上的画布深度纹理放掉,新设备上按格式重建', async () => {
    const first = setup();
    let second: ReturnType<typeof setup> | null = null;
    const dev = new LumaRhiDevice(first.fake.device as Device, {
      recreateDevice: async () => {
        second = setup();
        return second.fake.device as Device;
      },
      restoreRetryDelaysMs: [0],
    });
    dev.runFrame((f) => {
      f.commands.beginRenderPass({ label: 'D', target: f.swapchainWithDepth('depth24plus') }).end();
    });
    const oldId = first.created.find((c) => c.format === 'depth24plus')!.id;
    first.fake.lose();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    expect(second).not.toBeNull();
    expect(first.destroyed.has(oldId)).toBe(true);
    expect(dev.runFrame((f) => {
      f.commands.beginRenderPass({ label: 'D2', target: f.swapchainWithDepth('depth24plus') }).end();
    })).toBe(true);
    const s = second!;
    expect(s.created.filter((c) => c.format === 'depth24plus')).toHaveLength(1);
    expect(passDepthViews(s.fake)[0][1]).toBe(s.created.find((c) => c.format === 'depth24plus')!.id);
  });

  it('luma 画布上下文自己的深度槽用不上:取画布帧缓冲后放掉,resize 重配后再建的也放掉(不多占一张画布深度)', () => {
    const { fake, destroyed, size, lumaCtx, configure } = setup();
    const slot0 = (lumaCtx.depthStencilAttachment as unknown as { id: string }).id;
    const dev = new LumaRhiDevice(fake.device as Device);
    expect(dev.runFrame((f) => {
      f.commands.beginRenderPass({ label: 'D', target: f.swapchainWithDepth('depth24plus-stencil8') }).end();
    })).toBe(true);
    expect(lumaCtx.depthStencilAttachment).toBeNull();
    expect(destroyed.has(slot0)).toBe(true);

    // resize:luma 重配画布又建一张 depth24plus;下一帧取帧缓冲后同样放掉
    size.w = 32;
    size.h = 24;
    configure();
    const slot1 = (lumaCtx.depthStencilAttachment as unknown as { id: string }).id;
    dev.resizeSwapchain(32, 24);
    expect(dev.runFrame((f) => {
      f.commands.beginRenderPass({ label: 'C', target: f.swapchain }).end();
    })).toBe(true);
    expect(lumaCtx.depthStencilAttachment).toBeNull();
    expect(destroyed.has(slot1)).toBe(true);
  });

  it('空后端同一序列:每个格式一张独立的深度纹理(两端约定一致)', () => {
    const dev = new NullRhiDevice();
    expect(dev.runFrame((f) => {
      const a = f.swapchainWithDepth('depth24plus');
      const b = f.swapchainWithDepth('depth24plus-stencil8');
      f.commands.beginRenderPass({ label: 'A', target: a }).end();
      f.commands.beginRenderPass({ label: 'B', target: b }).end();
      f.commands.beginRenderPass({ label: 'A2', target: a }).end();
      expect(a).not.toBe(b);
      expect(a.depthFormat).toBe('depth24plus');
      expect(b.depthFormat).toBe('depth24plus-stencil8');
    })).toBe(true);
  });
});
