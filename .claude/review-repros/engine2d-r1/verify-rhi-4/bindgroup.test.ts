import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { _getDefaultBindGroupFactory } from '@luma.gl/core';

function fakeDevice() {
  const counts = { bindGroups: 0, layouts: 0 };
  const device: any = {
    type: 'webgpu',
    _factories: {},
    _createBindGroupLayoutWebGPU: () => { counts.layouts++; return {}; },
    _createBindGroupWebGPU: () => { counts.bindGroups++; return { id: counts.bindGroups }; },
  };
  return { device, counts };
}

const shaderLayout = {
  attributes: [],
  bindings: [
    { name: 'globals', type: 'uniform', group: 0, location: 0 },
    { name: 'uTexture', type: 'texture', group: 0, location: 1 },
    { name: 'uTextureSampler', type: 'sampler', group: 0, location: 2 },
  ],
};

describe('luma bind group factory without _bindGroupCacheKeys', () => {
  it('creates a new bind group on every setBindings call (same resources)', () => {
    const { device, counts } = fakeDevice();
    const pipeline: any = { id: 'p', shaderLayout };
    const buf = {}; const tex = {}; const smp = {};
    const bindings = { globals: buf, uTexture: tex, uTextureSampler: smp };
    const f = _getDefaultBindGroupFactory(device);
    for (let i = 0; i < 500; i++) f.getBindGroups(pipeline, bindings as any);
    console.log('no keys: bindGroups created =', counts.bindGroups);
    expect(counts.bindGroups).toBe(500);

    const { device: d2, counts: c2 } = fakeDevice();
    const f2 = _getDefaultBindGroupFactory(d2);
    const key = {};
    for (let i = 0; i < 500; i++) f2.getBindGroups(pipeline, bindings as any, { 0: key });
    console.log('with key: bindGroups created =', c2.bindGroups);
    expect(c2.bindGroups).toBe(1);
  });

  it('branch passes no cache keys at both setBindings call sites', () => {
    const src = readFileSync('src/rendering/rhi/backends/luma/LumaRhiDevice.ts', 'utf8');
    expect(src.includes('_bindGroupCacheKeys')).toBe(false);
    const lines = src.split('\n');
    const l749 = lines[748];
    console.log('749:', l749.trim());
    expect(l749).toMatch(/this\.pass\.setBindings\(this\.device\._toLumaBindings\(.*\)\);$/);
  });
});
