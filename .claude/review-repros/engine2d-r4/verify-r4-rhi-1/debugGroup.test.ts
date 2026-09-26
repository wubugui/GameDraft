import { describe, expect, it } from 'vitest';
import type { Device } from '@luma.gl/core';
import { createFakeLuma } from '../../../../src/rendering/rhi/backends/testing/fakeLumaDevice';
import { LumaRhiDevice } from '../../../../src/rendering/rhi/backends/luma/LumaRhiDevice';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import type { RhiDevice } from '../../../../src/rendering/rhi/RhiDevice';

function probe(dev: RhiDevice) {
  const r: Record<string, string> = {};
  dev.runFrame((f) => {
    const pass = f.commands.beginRenderPass({ label: 'main', target: f.swapchain });
    for (const [name, fn] of [
      ['push', () => f.commands.pushDebugGroup('x')],
      ['pop', () => f.commands.popDebugGroup()],
      ['copyBuf', () => f.commands.copyBufferToBuffer(null as never, 0, null as never, 0, 4)],
    ] as const) {
      try { fn(); r[name] = 'accepted'; } catch (e) { r[name] = 'threw: ' + (e as Error).message; }
    }
    pass.end();
  });
  return r;
}

describe('debug group inside open pass', () => {
  it('luma (fake device)', () => {
    const fake = createFakeLuma();
    const r = probe(new LumaRhiDevice(fake.device as Device));
    console.log('LUMA', r);
    expect(r.push).toBe('accepted');
    expect(r.pop).toBe('accepted');
    expect(r.copyBuf).toMatch(/^threw/);
  });
  it('null', () => {
    const r = probe(new NullRhiDevice());
    console.log('NULL', r);
    expect(r.push).toBe('accepted');
    expect(r.copyBuf).toMatch(/^threw/);
  });
});
