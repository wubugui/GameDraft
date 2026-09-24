import { describe, expect, it, vi } from 'vitest';
import { SceneLightingSystem } from './SceneLightingSystem';
import { LitBackground } from '../rendering/lighting/LitBackground';
import { defaultSceneLighting } from '../data/sceneLightingDefault';
import type { LightDef, SceneLightingDef } from '../data/types';

/** Exercise the real display-parameter consumer without allocating a WebGL context. */
function harness() {
  const uniforms = {
    uEv: 0, uTonemap: 0, uWhiteBalance: new Float32Array(3), uContrast: 1,
    uSaturation: 1, uLift: 0, uLiftColor: new Float32Array(3), uFogSigma: 0,
    uFogScaleH: 1, uFogBaseY: 0, uFogColor: new Float32Array(3),
  };
  const displayTarget = { shader: { resources: { litBg: { uniforms } } } } as unknown as LitBackground;
  const display = vi.fn((def: SceneLightingDef) => LitBackground.prototype.applyParams.call(displayTarget, def));
  const pass = { applyParams: vi.fn(), markDirty: vi.fn() };
  const passPlate = { applyParams: vi.fn(), markDirty: vi.fn() };
  const system = new SceneLightingSystem();
  Object.assign(system, { pass, passPlate, litBg: { applyParams: display } });
  return { system, uniforms, display, pass, passPlate };
}

describe('SceneLightingSystem temporary environmental dim reaches the display shader', () => {
  it('dims and restores the real uEv consumer without changing authored display or lights', () => {
    const h = harness();
    const authored = defaultSceneLighting();
    authored.display = { ...authored.display, ev: 1.5, saturation: 0.8, contrast: 1.2, lift: 0.02 };
    const lamp = { id: 'lamp', type: 'point', intensity: 7 } as unknown as LightDef;
    authored.lights = [lamp];
    const original = structuredClone(authored);
    h.system.applyParams(authored);
    h.system.setEnvDim(0.25);
    expect(h.uniforms.uEv).toBeCloseTo(-0.5);
    expect(h.uniforms.uSaturation).toBe(0.8);
    expect(h.uniforms.uContrast).toBe(1.2);
    expect(h.uniforms.uLift).toBe(0.02);
    expect(h.display.mock.lastCall![0].lights).toEqual([lamp]);
    expect(h.pass.applyParams.mock.lastCall![0].display.ev).toBeCloseTo(-0.5);
    expect(h.passPlate.applyParams.mock.lastCall![0].display.ev).toBeCloseTo(-0.5);
    expect(authored).toEqual(original);
    expect(h.system.params).toBe(authored);
    h.system.setEnvDim(1);
    expect(h.uniforms.uEv).toBe(1.5);
    expect(h.display.mock.lastCall![0].display).toEqual(original.display);
  });

  it('parameter refresh and dynamic-light changes preserve the active dim until explicit recovery', () => {
    const h = harness();
    const authored = defaultSceneLighting();
    h.system.applyParams(authored);
    h.system.setEnvDim(0.25);
    const refreshed = { ...authored, display: { ...authored.display, ev: 0.75, saturation: 0.6 } };
    h.system.applyParams(refreshed);
    expect(h.uniforms.uEv).toBeCloseTo(-1.25);
    expect(h.uniforms.uSaturation).toBe(0.6);
    const lightning = { id: 'lightning', type: 'point', intensity: 500 } as unknown as LightDef;
    h.system.setDynamicLights([lightning]);
    expect(h.uniforms.uEv).toBeCloseTo(-1.25);
    expect(h.display.mock.lastCall![0].lights).toEqual([lightning]);
    expect(refreshed.lights).toEqual([]);
    h.system.setEnvDim(0);
    expect(Number.isFinite(h.uniforms.uEv)).toBe(true);
    h.system.setEnvDim(1);
    expect(h.uniforms.uEv).toBe(0.75);
    expect(h.display.mock.lastCall![0].lights).toEqual([lightning]);
  });
});
