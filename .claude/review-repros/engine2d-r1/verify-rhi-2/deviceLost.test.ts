import { describe, it, expect, vi } from 'vitest';
import { LumaRhiDevice } from '../../../../src/rendering/rhi/backends/luma/LumaRhiDevice';
import { GlContextSystem } from 'pixi.js';

function fakeLuma() {
  let resolveLost!: (v: { reason: string; message: string }) => void;
  const lost = new Promise<{ reason: string; message: string }>((r) => { resolveLost = r; });
  const ctx = {
    getCurrentFramebuffer: () => ({}),
    getDrawingBufferSize: () => [16, 16],
    setDrawingBufferSize: () => {},
  };
  const luma: any = {
    limits: { maxTextureDimension2D: 8192, maxColorAttachments: 8, maxComputeWorkgroupSizeX: 256, maxComputeWorkgroupSizeY: 256, maxComputeWorkgroupSizeZ: 64, maxComputeInvocationsPerWorkgroup: 256 },
    isTextureFormatFilterable: () => true,
    info: { vendor: 'fake', renderer: 'fake' },
    preferredColorFormat: 'bgra8unorm',
    getDefaultCanvasContext: () => ctx,
    lost,
    createCommandEncoder: () => ({ finish: () => ({}), destroy() {} }),
    submit: () => {},
  };
  return { luma, resolveLost };
}

describe('device loss: engine2d RHI vs Pixi WebGL', () => {
  it('branch: after device.lost, every runFrame/submit returns false forever, record never runs', async () => {
    const { luma, resolveLost } = fakeLuma();
    const rhi = new LumaRhiDevice(luma);
    const diags: string[] = [];
    rhi.onDiagnostic?.((d: any) => diags.push(String(d?.error?.message ?? d?.message ?? d)));
    resolveLost({ reason: 'unknown', message: 'GPU process crashed' });
    await rhi.lost;
    expect(rhi.isLost).toBe(true);
    let recorded = 0;
    const results: boolean[] = [];
    for (let i = 0; i < 100; i++) {
      results.push(rhi.runFrame(() => { recorded++; }));
      results.push(rhi.submit('x', () => { recorded++; }));
    }
    expect(results.every((r) => r === false)).toBe(true);
    expect(recorded).toBe(0);
    // no way to get back: isLost is getter-only, no restore/recreate API on the device
    const proto = Object.getOwnPropertyNames(LumaRhiDevice.prototype);
    console.log('LumaRhiDevice methods:', proto.filter((n) => /restor|recreat|reset|lost/i.test(n)));
    console.log('diagnostics:', diags);
  });

  it('pixi: webglcontextlost is preventDefault-ed (allows restore) and restore emits contextChange', () => {
    (globalThis as any).WebGLRenderingContext ??= class {};
    const listeners: Record<string, (e: any) => void> = {};
    const emitted: unknown[] = [];
    const gl: any = { isContextLost: () => false, getExtension: () => null, getSupportedExtensions: () => [] };
    const renderer: any = {
      view: { canvas: { addEventListener: (n: string, f: any) => { listeners[n] = f; } } },
      runners: { contextChange: { emit: (g: unknown) => emitted.push(g) } },
    };
    const sys: any = new (GlContextSystem as any)(renderer);
    sys.getExtensions = () => { sys.extensions = {}; };
    sys.validateContext = () => {};
    sys.initFromContext(gl);
    expect(emitted.length).toBe(1);
    const ev = { preventDefault: vi.fn() };
    listeners.webglcontextlost(ev);
    expect(ev.preventDefault).toHaveBeenCalled();
    listeners.webglcontextrestored({});
    expect(emitted.length).toBe(2); // contextChange -> GlTextureSystem etc. drop & re-upload
  });
});
