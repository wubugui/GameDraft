import { describe, expect, it } from 'vitest';
import { WebGPUCanvasContext } from '../../../../node_modules/@luma.gl/webgpu/dist/adapter/webgpu-canvas-context.js';
import { WebGPUDevice } from '../../../../node_modules/@luma.gl/webgpu/dist/adapter/webgpu-device.js';
import { LumaRhiDevice } from '../../../../src/rendering/rhi/backends/luma/LumaRhiDevice';

describe('LumaRhiDevice.destroy canvas context teardown', () => {
  it('leaves observers running and context configured', async () => {
    const log: string[] = [];
    const g = globalThis as any;
    class FakeCanvas { width = 64; height = 64; clientWidth = 64; clientHeight = 64; id = 'c';
      ctx = { configure: (c: any) => log.push('configure'), unconfigure: () => log.push('unconfigure'), getConfiguration: () => null };
      getContext() { return this.ctx; } getBoundingClientRect() { return { left: 0, top: 0 }; } }
    g.HTMLCanvasElement = FakeCanvas;
    const liveRO = new Set<any>(); const liveIO = new Set<any>(); const mqListeners = new Set<any>();
    g.ResizeObserver = class { constructor(public cb: any) {} observe() { liveRO.add(this); } disconnect() { liveRO.delete(this); } };
    g.IntersectionObserver = class { constructor(public cb: any) {} observe() { liveIO.add(this); } disconnect() { liveIO.delete(this); } };
    g.matchMedia = () => ({ addEventListener: (_: string, l: any) => mqListeners.add(l), removeEventListener: (_: string, l: any) => mqListeners.delete(l) });
    g.window = g; g.devicePixelRatio = 1;
    const prevBrowser = (process as any).browser; (process as any).browser = true;
    const fakeDev: any = Object.create(WebGPUDevice.prototype);
    Object.assign(fakeDev, {
      id: 'dev', preferredColorFormat: 'bgra8unorm', preferredDepthFormat: 'depth24plus',
      handle: { destroy: () => log.push('GPUDevice.destroy') },
      commandEncoder: { destroy() {} }, _defaultSampler: null,
      props: { onResize() {}, onVisibilityChange() {}, onDevicePixelRatioChange() {}, onPositionChange() {} },
      createTexture: (p: any) => ({ ...p, destroy: () => log.push('depth.destroy') }),
      limits: { maxTextureDimension2D: 8192, maxColorAttachments: 8, maxComputeWorkgroupSizeX: 256, maxComputeWorkgroupSizeY: 256, maxComputeWorkgroupSizeZ: 64, maxComputeInvocationsPerWorkgroup: 256 },
      isTextureFormatFilterable: () => false, info: { vendor: 'x', renderer: 'y' }, lost: new Promise(() => {}),
    });
    const canvas = new FakeCanvas();
    const ctx = new WebGPUCanvasContext(fakeDev, null, { canvas, alphaMode: 'opaque', useDevicePixels: true, autoResize: true });
    (process as any).browser = prevBrowser;
    fakeDev.getDefaultCanvasContext = () => ctx;
    await new Promise((r) => setTimeout(r, 5)); // DPR media query armed
    expect(liveRO.size).toBe(1); expect(liveIO.size).toBe(1); expect(mqListeners.size).toBe(1);

    const rhi = new LumaRhiDevice(fakeDev);
    log.length = 0;
    rhi.destroy();
    console.log('after LumaRhiDevice.destroy:', { log: [...log], ro: liveRO.size, io: liveIO.size, mq: mqListeners.size, ctxDestroyed: ctx.destroyed, ctxDevice: !!(ctx as any).device });

    // simulate a resize after destroy -> old context reconfigures GPUCanvasContext with the destroyed device
    log.length = 0;
    const ro = [...liveRO][0];
    ro.cb([{ target: canvas, contentBoxSize: [{ inlineSize: 100, blockSize: 50 }], devicePixelContentBoxSize: [{ inlineSize: 100, blockSize: 50 }] }]);
    (ctx as any)._resizeDrawingBufferIfNeeded?.();
    console.log('resize after destroy ->', log);

    // proposed fix
    ctx.destroy();
    console.log('after ctx.destroy():', { ro: liveRO.size, io: liveIO.size, mq: mqListeners.size });
    expect(liveRO.size + liveIO.size + mqListeners.size).toBe(0);
  });
});
