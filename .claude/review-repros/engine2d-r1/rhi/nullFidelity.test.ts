/**
 * NullRhiDevice 与 LumaRhiDevice 的校验差异:下列用法 Luma 会当场抛 RhiError(整帧作废),空后端却放行。
 */
import { describe, expect, it } from 'vitest';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { RhiBufferUsage, RhiTextureUsage } from '../../../../src/rendering/rhi';

const WGSL = '@vertex fn vs() -> @builtin(position) vec4f { return vec4f(); } @fragment fn fs() -> @location(0) vec4f { return vec4f(); }';

function setup() {
  const rhi = new NullRhiDevice();
  const errors: string[] = [];
  rhi.onDiagnostic((e) => errors.push(e.message));
  const scope = rhi.createScope('t');
  const shader = scope.createShader({ label: 's', wgsl: WGSL });
  const pipeline = scope.createRenderPipeline({
    label: 'p', shader, colorFormats: ['bgra8unorm'],
    vertexBuffers: [{ name: 'stream0', stride: 8, attributes: [{ name: 'aPosition', format: 'float32x2', offset: 0 }] }],
  });
  return { rhi, errors, scope, pipeline };
}

describe('NullRhiDevice fidelity vs Luma', () => {
  it('drawIndexed with no vertex stream bound and no index buffer: Luma throws (prepareDraw), Null accepts', () => {
    const { rhi, errors, pipeline } = setup();
    const ok = rhi.runFrame((f) => {
      const pass = f.commands.beginRenderPass({ label: 'x', target: f.swapchain });
      pass.setPipeline(pipeline);
      pass.setBindings({});
      pass.drawIndexed(6);
      pass.end();
    });
    expect(ok).toBe(true);
    expect(errors).toEqual([]);
  });

  it('setIndexBuffer with a buffer lacking INDEX usage: Luma throws, Null accepts', () => {
    const { rhi, errors, scope, pipeline } = setup();
    const vb = scope.createBuffer({ label: 'vb', usage: RhiBufferUsage.VERTEX, size: 64 });
    const ok = rhi.runFrame((f) => {
      const pass = f.commands.beginRenderPass({ label: 'x', target: f.swapchain });
      pass.setPipeline(pipeline);
      pass.setVertexBuffer('stream0', vb);
      pass.setIndexBuffer(vb);
      pass.drawIndexed(6);
      pass.end();
    });
    expect(ok).toBe(true);
    expect(errors).toEqual([]);
  });

  it('MSAA texture with mipLevels 2 / oversize texture: Luma throws, Null accepts', () => {
    const { scope } = setup();
    expect(() => scope.createTexture({ label: 'm', width: 4, height: 4, format: 'bgra8unorm', usage: RhiTextureUsage.RENDER_TARGET, sampleCount: 4, mipLevels: 2 })).not.toThrow();
    expect(() => scope.createTexture({ label: 'big', width: 20000, height: 4, format: 'bgra8unorm', usage: RhiTextureUsage.SAMPLED })).not.toThrow();
  });

  it('resolve target without RENDER_TARGET usage: Luma throws, Null accepts', () => {
    const { scope } = setup();
    const ms = scope.createTexture({ label: 'ms', width: 4, height: 4, format: 'bgra8unorm', usage: RhiTextureUsage.RENDER_TARGET, sampleCount: 4 });
    const r = scope.createTexture({ label: 'r', width: 4, height: 4, format: 'bgra8unorm', usage: RhiTextureUsage.SAMPLED });
    expect(() => scope.createRenderTarget({ label: 't', colors: [ms], resolveTargets: [r] })).not.toThrow();
  });
});
