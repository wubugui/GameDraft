import { describe, expect, it } from 'vitest';
import BURN_GLSL from '../../../../src/rendering/burn/burnShade.glsl?raw';
import BURN_WGSL from '../../../../src/rendering/burn/burnShade.wgsl?raw';
import BR_GLSL from '../../../../src/rendering/breathingShade.glsl?raw';
import BR_WGSL from '../../../../src/rendering/breathingShade.wgsl?raw';
import CS_GLSL from '../../../../src/rendering/charShadeCore.glsl?raw';
import CS_WGSL from '../../../../src/rendering/charShadeCore.wgsl?raw';
import { BEAM_GLSL_CORE } from '../../../../src/rendering/vfx/vfxBeamGlsl';
import { BEAM_WGSL_CORE } from '../../../../src/rendering/vfx/vfxBeamWgsl';
import { BOLT_GLSL_KERNEL } from '../../../../src/rendering/vfx/vfxBoltGlsl';
import { BOLT_WGSL_KERNEL } from '../../../../src/rendering/vfx/vfxBoltWgsl';

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const glFns = (s: string) => [...strip(s).matchAll(/^\s*(?:float|int|bool|void|vec[234]|mat3)\s+(\w+)\s*\(/gm)].map((m) => m[1]).sort();
const wgFns = (s: string) => [...strip(s).matchAll(/\bfn\s+(\w+)\s*\(/g)].map((m) => m[1]).sort();
const nums = (s: string) => [...strip(s).replace(/\b(vec[234]|f32|i32|array)\b<[^>]*>/g, '').replace(/\d+f\b/g, (m) => m.slice(0, -1)).matchAll(/(?<![\w.])(\d+\.\d*(?:e-?\d+)?|\d+e-?\d+)/g)].map((m) => Number(m[1])).sort((a, b) => a - b);

const pairs: Array<[string, string, string]> = [
  ['burn', BURN_GLSL, BURN_WGSL], ['breathing', BR_GLSL, BR_WGSL], ['charShade', CS_GLSL, CS_WGSL],
  ['beam', BEAM_GLSL_CORE, BEAM_WGSL_CORE], ['bolt', BOLT_GLSL_KERNEL, BOLT_WGSL_KERNEL],
];
describe('twins', () => {
  for (const [n, g, w] of pairs) {
    it(n, () => {
      const extra = n === 'beam' ? ['bmAlongKey', 'bmSmoothstep'] : [];
      expect(wgFns(w).filter((x) => !extra.includes(x))).toEqual(glFns(g));
      console.log(n, 'glsl nums', nums(g).join(','), '\nwgsl nums', nums(w).join(','));
    });
  }
});
