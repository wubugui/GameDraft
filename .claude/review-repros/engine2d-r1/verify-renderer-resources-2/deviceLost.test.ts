import { describe, it, expect } from 'vitest';
import { LumaRhiDevice } from '../../../../src/rendering/rhi/backends/luma/LumaRhiDevice';

describe('device loss is permanent in LumaRhiDevice', () => {
  it('after luma.lost resolves, runFrame/submit never record again and nothing recovers', async () => {
    let resolveLost!: (v: { reason: string; message: string }) => void;
    const lost = new Promise<{ reason: string; message: string }>((r) => (resolveLost = r));
    const ctx = { getDrawingBufferSize: () => [16, 16], setDrawingBufferSize() {}, getCurrentFramebuffer() { return {}; } };
    const fakeLuma: any = {
      limits: { maxTextureDimension2D: 8192, maxColorAttachments: 8, maxComputeWorkgroupSizeX: 256, maxComputeWorkgroupSizeY: 256, maxComputeWorkgroupSizeZ: 64, maxComputeInvocationsPerWorkgroup: 256 },
      isTextureFormatFilterable: () => false,
      preferredColorFormat: 'bgra8unorm',
      info: { vendor: 'fake', renderer: 'fake' },
      getDefaultCanvasContext: () => ctx,
      lost,
      createCommandEncoder() { throw new Error('should not be reached after loss'); },
    };
    const dev = new LumaRhiDevice(fakeLuma);
    const diags: string[] = [];
    dev.onDiagnostic?.((d: any) => diags.push(String(d?.message ?? d?.error?.message ?? d)));
    resolveLost({ reason: 'unknown', message: 'GPU process crashed (simulated)' });
    const reason = await dev.lost;
    expect(reason).toContain('simulated');
    expect(dev.isLost).toBe(true);
    let recorded = 0;
    const results: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      results.push(dev.runFrame(() => { recorded++; }));
      results.push(dev.submit('x', () => { recorded++; }));
    }
    // wait some ticks: nothing flips isLost back
    await new Promise((r) => setTimeout(r, 50));
    console.log('results', results, 'recorded', recorded, 'isLost', dev.isLost, 'diags', diags);
    expect(results.every((r) => r === false)).toBe(true);
    expect(recorded).toBe(0);
    expect(dev.isLost).toBe(true);
  });
});
