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
describe('verify-rhi-7', () => {
  it('draw (non-indexed) with missing stream DOES throw on Null (control)', () => {
    const { rhi, errors, pipeline } = setup();
    const ok = rhi.runFrame((f) => { const p = f.commands.beginRenderPass({ label: 'x', target: f.swapchain }); p.setPipeline(pipeline); p.draw(3); p.end(); });
    expect(ok).toBe(false); expect(errors.length).toBe(1);
  });
  it('drawIndexed missing stream + missing index buffer accepted', () => {
    const { rhi, errors, pipeline } = setup();
    const ok = rhi.runFrame((f) => { const p = f.commands.beginRenderPass({ label: 'x', target: f.swapchain }); p.setPipeline(pipeline); p.drawIndexed(6); p.end(); });
    expect(ok).toBe(true); expect(errors).toEqual([]);
  });
  it('setIndexBuffer on VERTEX-only buffer accepted', () => {
    const { rhi, errors, scope, pipeline } = setup();
    const vb = scope.createBuffer({ label: 'vb', usage: RhiBufferUsage.VERTEX, size: 64 });
    const ok = rhi.runFrame((f) => { const p = f.commands.beginRenderPass({ label: 'x', target: f.swapchain }); p.setPipeline(pipeline); p.setVertexBuffer('stream0', vb); p.setIndexBuffer(vb); p.drawIndexed(6); p.end(); });
    expect(ok).toBe(true); expect(errors).toEqual([]);
  });
  it('texture factory gaps', () => {
    const { scope, rhi } = setup();
    expect(rhi.caps.maxTextureSize).toBe(8192);
    expect(() => scope.createTexture({ label: 'm', width: 4, height: 4, format: 'bgra8unorm', usage: RhiTextureUsage.RENDER_TARGET, sampleCount: 4, mipLevels: 2 })).not.toThrow();
    expect(() => scope.createTexture({ label: 'big', width: 20000, height: 4, format: 'bgra8unorm', usage: RhiTextureUsage.SAMPLED })).not.toThrow();
    const ms = scope.createTexture({ label: 'ms', width: 4, height: 4, format: 'bgra8unorm', usage: RhiTextureUsage.RENDER_TARGET, sampleCount: 4 });
    const r = scope.createTexture({ label: 'r', width: 4, height: 4, format: 'bgra8unorm', usage: RhiTextureUsage.SAMPLED });
    expect(() => scope.createRenderTarget({ label: 't', colors: [ms], resolveTargets: [r] })).not.toThrow();
  });
  it('copyTextureToTexture size/format mismatch accepted', () => {
    const { rhi, errors, scope } = setup();
    const a = scope.createTexture({ label: 'a', width: 8, height: 8, format: 'bgra8unorm', usage: RhiTextureUsage.COPY_SRC });
    const b = scope.createTexture({ label: 'b', width: 2, height: 2, format: 'rgba16float', usage: RhiTextureUsage.COPY_DST });
    const ok = rhi.runFrame((f) => { f.commands.copyTextureToTexture(a, b); });
    expect(ok).toBe(true); expect(errors).toEqual([]);
  });
  it('createBuffer data > size: Null throws a native RangeError (not RhiError) -- claim partially wrong', () => {
    const { scope } = setup();
    let err: unknown;
    try { scope.createBuffer({ label: 'x', usage: RhiBufferUsage.VERTEX, size: 4, data: new Float32Array(4) }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(RangeError);
  });
});
