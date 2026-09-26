/**
 * Repro: an edit to burnShade.glsl (the file the workbench compiles and the docs call the
 * "runtime single source") changes only the GlProgram (dead shell) and never reaches the
 * GpuProgram (WGSL) the game actually draws. The workbench guard (string check for the
 * sliceGlsl call in BurnFilters.ts) keeps passing.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const ROOT = resolve(__dirname, '../../..');
const ORIG_GLSL = readFileSync(resolve(ROOT, 'src/rendering/burn/burnShade.glsl'), 'utf8');
const EDITED_GLSL = ORIG_GLSL.replace('uBurnCharColor * (0.6 + 0.4 * lum)', 'uBurnCharColor * (0.5 + 0.5 * lum)');

async function loadBurn(glsl: string) {
  vi.resetModules();
  vi.doMock('../../../../src/rendering/burn/burnShade.glsl?raw', () => ({ default: glsl }));
  const m = await import('../../../../src/rendering/burn/BurnFilters');
  const field = new m.BurnFieldTexture(8, 8);
  const f = new m.BurnMaterialFilter(field);
  return {
    gl: (f as any).glProgram.fragment as string,
    gpu: (f as any).gpuProgram.fragment.source as string,
  };
}

describe('burnShade.glsl edit reaches the game?', () => {
  it('edit changed the GLSL text', () => {
    expect(EDITED_GLSL).not.toBe(ORIG_GLSL);
  });

  it('GlProgram changes, GpuProgram (what WebGPU draws) does not', async () => {
    const a = await loadBurn(ORIG_GLSL);
    const b = await loadBurn(EDITED_GLSL);
    console.log('gl changed:', a.gl !== b.gl, ' gpu changed:', a.gpu !== b.gpu);
    expect(a.gl).not.toBe(b.gl);        // dead shell picks up the edit
    expect(a.gpu).toBe(b.gpu);          // the WGSL the game renders is unaffected
    expect(b.gpu).toContain('(0.6 + 0.4 * lum)');
  });

  it('workbench guard (test_bundle.py:90) is a pure string check that still passes', () => {
    const filters = readFileSync(resolve(ROOT, 'src/rendering/burn/BurnFilters.ts'), 'utf8');
    expect(filters).toContain("sliceGlsl(BURN_SHADE_SRC, 'BURN_SHADE')");
  });

  it('no node-side pairing test covers burn/breathing/beam/bolt', () => {
    const t = readFileSync(resolve(ROOT, 'src/rendering/lighting/wgslChunks.test.ts'), 'utf8');
    for (const k of ['burnShade', 'breathingShade', 'BEAM_GLSL_CORE', 'BOLT_GLSL_KERNEL']) expect(t).not.toContain(k);
  });
});
