import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Device } from '@luma.gl/core';
import { createFakeLuma } from '../../../../src/rendering/rhi/backends/testing/fakeLumaDevice';
import { LumaRhiDevice } from '../../../../src/rendering/rhi/backends/luma/LumaRhiDevice';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';

const dist = dirname(createRequire(import.meta.url).resolve('@luma.gl/webgpu'));
const { WebGPUCanvasContext } = (await import(pathToFileURL(join(dist, 'adapter/webgpu-canvas-context.js')).href)) as {
  WebGPUCanvasContext: { prototype: { _createDepthStencilAttachment(fmt: string): unknown } };
};

describe('canvas depth formats in one frame', () => {
  it('luma backend: 2nd format destroys the 1st format depth texture still referenced by an earlier pass', async () => {
    const fake = createFakeLuma();
    const destroyed = new Set<string>();
    let n = 0;
    // stub `this` for luma's REAL _createDepthStencilAttachment (single depth slot)
    const lumaCtx: any = {
      id: 'canvas',
      drawingBufferWidth: 16,
      drawingBufferHeight: 16,
      depthStencilAttachment: null,
      device: {
        createTexture: (p: { format: string; width: number; height: number }) => {
          const id = `depthTex#${n++}(${p.format})`;
          return { id, format: p.format, width: p.width, height: p.height, view: { handle: { view: id } }, destroy: () => destroyed.add(id) };
        },
      },
    };
    const ctx = fake.canvasContext as any;
    ctx.getCurrentFramebuffer = (opts?: { depthStencilFormat?: string | false }) => {
      if (opts?.depthStencilFormat) WebGPUCanvasContext.prototype._createDepthStencilAttachment.call(lumaCtx, opts.depthStencilFormat);
      return {
        width: 16, height: 16,
        colorAttachments: [{ handle: { view: 'canvas' } }],
        depthStencilAttachment: opts?.depthStencilFormat ? lumaCtx.depthStencilAttachment.view : null,
      };
    };
    const dev = new LumaRhiDevice(fake.device as Device);
    const diags: string[] = [];
    dev.onDiagnostic((e) => diags.push(e.message));
    let ok = false;
    ok = dev.runFrame((f) => {
      const a = f.swapchainWithDepth('depth24plus');
      const b = f.swapchainWithDepth('depth24plus-stencil8');
      f.commands.beginRenderPass({ label: 'A', target: a }).end();
      f.commands.beginRenderPass({ label: 'B', target: b }).end();
      f.commands.beginRenderPass({ label: 'A2', target: a }).end();
    });
    const begins = fake.log.filter((c) => c[0] === 'pass.begin').map((c) => [c[1], (c[3] as any)?.view ?? null]);
    const submitted = fake.log.some((c) => c[0] === 'submit');
    (await import('node:fs')).writeFileSync(__dirname + '/out-luma.json', JSON.stringify({ ok, begins, destroyed: [...destroyed], submitted, diags }, null, 1));
    // pass A and A2 reference depthTex#0, which B's acquisition destroyed before submit
    expect(begins[0][1]).toBe('depthTex#0(depth24plus)');
    expect(begins[2][1]).toBe('depthTex#0(depth24plus)');
    expect(destroyed.has('depthTex#0(depth24plus)')).toBe(true);
    expect(submitted).toBe(true); // on a real GPU: queue.submit validation error "destroyed texture used"
  });

  it('null backend: same sequence, two independent depth textures, nothing destroyed', () => {
    const dev = new NullRhiDevice();
    let depths: unknown[] = [];
    const ok = dev.runFrame((f) => {
      const a = f.swapchainWithDepth('depth24plus');
      const b = f.swapchainWithDepth('depth24plus-stencil8');
      f.commands.beginRenderPass({ label: 'A', target: a }).end();
      f.commands.beginRenderPass({ label: 'B', target: b }).end();
      f.commands.beginRenderPass({ label: 'A2', target: a }).end();
      depths = [(a as any).depth ?? (a as any).depthTexture, (b as any).depth ?? (b as any).depthTexture];
    });
    console.log({ ok, sameDepth: depths[0] === depths[1], destroyed: depths.map((d: any) => d?.destroyed ?? d?._destroyed) });
    expect(ok).toBe(true);
  });
});
