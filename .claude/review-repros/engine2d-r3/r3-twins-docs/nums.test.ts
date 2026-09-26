import { describe, expect, it } from 'vitest';
import LC_GLSL from '../../../../src/rendering/lighting/lightingCore.glsl?raw';
import WR_GLSL from '../../../../src/rendering/lighting/worldReconstruct.glsl?raw';
import LC_WGSL_SRC from '../../../../src/rendering/lighting/lightingCore.wgsl?raw';
import WR_WGSL_SRC from '../../../../src/rendering/lighting/worldReconstruct.wgsl?raw';
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
import { LC_WGSL, WR_CORE_WGSL, WR_TEX_WGSL, WR_SPRITE_WGSL } from '../../../../src/rendering/lighting/wgslChunks';
import {
  CHAR_LIGHT_COMMON_GLSL, CHAR_LIGHT_COMMON_WGSL, PROBE_SAMPLING_GLSL, PROBE_SAMPLING_WGSL, SKYAO_SAMPLING_GLSL, SKYAO_SAMPLING_WGSL,
} from '../../../../src/rendering/CharacterShadingFilter';
import { ENTITY_SCENE_LIGHTS_GLSL, ENTITY_SCENE_LIGHTS_WGSL } from '../../../../src/rendering/CharacterLitSprite';

const sl = (src: string, tag: string) => { const b = `//__${tag}_BEGIN__`, e = `//__${tag}_END__`; return src.substring(src.indexOf(b) + b.length, src.indexOf(e)); };
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
// split into functions: name -> body text
function fnsGlsl(s: string): Map<string, string> {
  const t = strip(s); const out = new Map<string, string>();
  const re = /^\s*(?:float|int|bool|void|vec[234]|ivec[234]|mat[234])\s+(\w+)\s*\(/gm; let m;
  const idx: Array<[string, number]> = [];
  while ((m = re.exec(t))) idx.push([m[1], m.index]);
  idx.forEach(([n, i], k) => out.set(n, t.slice(i, k + 1 < idx.length ? idx[k + 1][1] : t.length)));
  return out;
}
function fnsWgsl(s: string): Map<string, string> {
  const t = strip(s); const out = new Map<string, string>();
  const re = /\bfn\s+(\w+)\s*\(/g; let m; const idx: Array<[string, number]> = [];
  while ((m = re.exec(t))) idx.push([m[1], m.index]);
  idx.forEach(([n, i], k) => out.set(n, t.slice(i, k + 1 < idx.length ? idx[k + 1][1] : t.length)));
  return out;
}
const nums = (s: string) => [...s.replace(/\b(vec[234]|mat[234]x[234]|array|texture_2d|ptr)<[^>]*>/g, ' ').replace(/(\d)[fu]\b/g, '$1')
  .matchAll(/(?<![\w.])(\d*\.\d+(?:[eE][-+]?\d+)?|\d+\.(?:[eE][-+]?\d+)?|\d+[eE][-+]?\d+)/g)].map((m) => Number(m[1])).filter((x) => x !== 0 && x !== 1).sort((a, b) => a - b);

const PAIRS: Array<[string, string, string]> = [
  ['WR_CORE', sl(WR_GLSL, 'WR_CORE'), WR_CORE_WGSL], ['WR_TEX', sl(WR_GLSL, 'WR_TEX'), WR_TEX_WGSL], ['WR_SPRITE', sl(WR_GLSL, 'WR_SPRITE'), WR_SPRITE_WGSL],
  ['LC', sl(LC_GLSL, 'LIGHTING_CORE'), LC_WGSL], ['CLC', CHAR_LIGHT_COMMON_GLSL, CHAR_LIGHT_COMMON_WGSL],
  ['PROBE', PROBE_SAMPLING_GLSL, PROBE_SAMPLING_WGSL], ['SKYAO', SKYAO_SAMPLING_GLSL, SKYAO_SAMPLING_WGSL],
  ['ESL', ENTITY_SCENE_LIGHTS_GLSL, ENTITY_SCENE_LIGHTS_WGSL],
  ['burn', BURN_GLSL, BURN_WGSL], ['breathing', BR_GLSL, BR_WGSL], ['charShade', CS_GLSL, CS_WGSL],
  ['beam', BEAM_GLSL_CORE, BEAM_WGSL_CORE], ['bolt', BOLT_GLSL_KERNEL, BOLT_WGSL_KERNEL],
];
describe('per-function numeric literals', () => {
  for (const [tag, g, w] of PAIRS) {
    it(tag, () => {
      const G = fnsGlsl(g), W = fnsWgsl(w);
      const diffs: string[] = [];
      for (const [n, body] of G) {
        const wb = W.get(n);
        if (!wb) { diffs.push(`missing ${n}`); continue; }
        const a = nums(body).join(','), b = nums(wb).join(',');
        if (a !== b) diffs.push(`${n}: glsl[${a}] wgsl[${b}]`);
      }
      expect(diffs).toEqual([]);
    });
  }
});
