import { describe, it, expect } from 'vitest';
import * as P from 'pixi.js';
import * as E from '../../../../src/engine2d';

const pick = (f: any) => ({
  padding: f.padding, resolution: f.resolution, antialias: f.antialias, blendMode: f.blendMode,
  clipToViewport: f.clipToViewport, blendRequired: f.blendRequired, enabled: f.enabled,
  cr: f.compatibleRenderers & 2,
});
const blurPick = (f: any) => ({ ...pick(f), x: pick(f.blurXFilter), y: pick(f.blurYFilter),
  sx: f.strengthX, sy: f.strengthY, q: f.quality, lx: f.blurXFilter.legacy, px: f.blurXFilter.passes,
  kx: f.blurXFilter.gpuProgram?.vertex?.source?.length });

describe('filter api parity', () => {
  const blurArgs: any[] = [
    [{ strength: 1, quality: 2, kernelSize: 9, legacy: true, resolution: 'inherit' }],
    [{ strength: 0, quality: 3 }],
    [{ strength: 5, quality: 3 }],
    [{ strength: 2.5, quality: 2 }],
    [],
    [{ strength: 3, antialias: true, padding: 7 }],
  ];
  for (const a of blurArgs) {
    it('blur ' + JSON.stringify(a), () => {
      const p = new (P.BlurFilter as any)(...a);
      const e = new (E.BlurFilter as any)(...a);
      const pp = blurPick(p); const ee = blurPick(e);
      delete (pp as any).kx; delete (ee as any).kx;
      expect(ee).toEqual(pp);
      p.strength = 7.3; e.strength = 7.3; expect(blurPick(e).padding).toEqual(blurPick(p).padding);
      p.repeatEdgePixels = true; e.repeatEdgePixels = true; expect(e.padding).toEqual(p.padding);
    });
  }
  it('alpha / colormatrix / from', () => {
    expect(pick(new E.AlphaFilter({ alpha: 1 }))).toEqual(pick(new P.AlphaFilter({ alpha: 1 })));
    expect(pick(new E.ColorMatrixFilter())).toEqual(pick(new P.ColorMatrixFilter()));
    const opts = { compatibleRenderers: 3, resources: {}, resolution: 'inherit', antialias: 'off', clipToViewport: false, padding: 24 } as any;
    expect(pick(new E.Filter(opts))).toEqual(pick(new P.Filter(opts)));
  });
});
