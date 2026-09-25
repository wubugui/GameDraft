import { describe, it, expect } from 'vitest';
import { LumaRhiDevice } from '../../../../src/rendering/rhi/backends/luma/LumaRhiDevice';

function fakeLuma(log: unknown[]) {
  const nativePipeline = { native: 'pipeline-from-failed-shader' };
  return {
    limits: { maxTextureDimension2D: 8192, maxColorAttachments: 8, maxComputeWorkgroupSizeX: 256, maxComputeWorkgroupSizeY: 256, maxComputeWorkgroupSizeZ: 64, maxComputeInvocationsPerWorkgroup: 256 },
    isTextureFormatFilterable: () => true,
    preferredColorFormat: 'bgra8unorm',
    info: { vendor: 'fake', renderer: 'fake' },
    lost: new Promise(() => {}),
    getDefaultCanvasContext: () => ({
      getCurrentFramebuffer: () => ({ colorAttachments: [{ handle: { view: 'canvas' } }], depthStencilAttachment: null }),
      getDrawingBufferSize: () => [4, 4],
    }),
    // WGSL compile error, as a Tint/FXC failure would report
    createShader: (p: any) => ({
      id: p.id,
      asyncCompilationStatus: Promise.resolve('error'),
      getCompilationInfo: async () => [{ type: 'error', lineNum: 1, linePos: 1, message: 'fake compile error' }],
      destroy() {},
    }),
    createRenderPipeline: () => ({ handle: nativePipeline, shaderLayout: { attributes: [], bindings: [] }, linkStatus: 'success', destroy() {} }),
    createVertexArray: () => ({ setBuffer() {}, setIndexBuffer() {}, destroy() {}, getBufferSlot: () => 0 }),
    createCommandEncoder: () => ({
      handle: { beginRenderPass: (d: any) => { log.push(['native.beginRenderPass', d.label]); return {}; } },
      beginRenderPass: () => ({
        setPipeline: (p: any) => log.push(['native.setPipeline', p.handle.native]),
        setBindings: () => log.push(['setBindings']),
        setVertexArray: () => {},
        setParameters: () => {},
        draw: (o: any) => { log.push(['native.draw', o.vertexCount]); return true; },
        end: () => log.push(['pass.end']),
      }),
      finish: () => { log.push(['encoder.finish']); return { cb: 1 }; },
      destroy() {},
    }),
    submit: (cb: unknown) => log.push(['queue.submit', cb]),
  };
}

describe('LumaRhiDevice: draw with a pipeline whose shader failed to compile', () => {
  it('still issues native setPipeline + draw and submits the whole frame', async () => {
    const log: unknown[] = [];
    const diags: string[] = [];
    const dev = new LumaRhiDevice(fakeLuma(log) as any);
    dev.onDiagnostic?.((e: any, sev: string) => diags.push(`${sev}: ${e.message.split('\n')[0]}`));
    const shader = dev.createShader(dev.rootScope, { label: 'lighting', wgsl: '@vertex fn vs() {} @fragment fn fs() {}' } as any);
    const pipe = dev.createRenderPipeline(dev.rootScope, { label: 'lighting', shader, colorFormats: ['bgra8unorm'] } as any);
    let rejected: unknown = null;
    await pipe.ready.catch((e) => { rejected = e; });
    expect(rejected).not.toBeNull();
    expect(pipe.isReady).toBe(false);

    const ok = dev.runFrame((frame) => {
      const pass = frame.commands.beginRenderPass({ label: 'main', target: frame.swapchain, colorOps: [{ load: 'clear', clearValue: [0, 0, 0, 1] }] });
      pass.setPipeline(pipe);
      pass.draw(3);
      pass.end();
    });
    console.log('ready rejected with:', String((rejected as any)?.message).split('\n')[0]);
    console.log('diagnostics:', diags);
    console.log('recorded:', JSON.stringify(log));
    console.log('runFrame ok =', ok, 'stats =', JSON.stringify(dev.lastFrameStats));
    expect(ok).toBe(true);
    expect(log).toContainEqual(['native.setPipeline', 'pipeline-from-failed-shader']);
    expect(log).toContainEqual(['native.draw', 3]);
    expect(log.some((l: any) => l[0] === 'queue.submit')).toBe(true);
    expect(dev.lastFrameStats.draws).toBe(1);
    expect(dev.lastFrameStats.skippedDraws).toBe(0);
  });
});
