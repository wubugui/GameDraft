/**
 * GLSL / WGSL 孪生守门:游戏只画 WGSL,而燃烧 / 呼吸 / 光柱 / 雷电等工作台仍在自己的 WebGL 页里编 GLSL,
 * 两份要一起改。这里逐对比较:函数集合双向一致、每个函数体里的数值常量(去掉 0 / 1)一致。
 * 改了一边忘了另一边 ⇒ 这里红(工作台预览与游戏不再是同一个着色器)。
 * 唯一登记的例外:lcSpotLight 的 smoothstep 在 WGSL 里展开成 t*t*(3-2t)(与 GLSL 等价,见 shaders-lighting 审查记录)。
 */
import { describe, expect, it } from 'vitest';
import LC_GLSL from './lighting/lightingCore.glsl?raw';
import WR_GLSL from './lighting/worldReconstruct.glsl?raw';
import LC_WGSL_SRC from './lighting/lightingCore.wgsl?raw';
import WR_WGSL_SRC from './lighting/worldReconstruct.wgsl?raw';
import BURN_GLSL from './burn/burnShade.glsl?raw';
import BURN_WGSL from './burn/burnShade.wgsl?raw';
import BR_GLSL from './breathingShade.glsl?raw';
import BR_WGSL from './breathingShade.wgsl?raw';
import CS_GLSL from './charShadeCore.glsl?raw';
import CS_WGSL from './charShadeCore.wgsl?raw';
import { BEAM_GLSL_CORE } from './vfx/vfxBeamGlsl';
import { BEAM_WGSL_CORE } from './vfx/vfxBeamWgsl';
import { BOLT_GLSL_KERNEL } from './vfx/vfxBoltGlsl';
import { BOLT_WGSL_KERNEL } from './vfx/vfxBoltWgsl';
import { LC_WGSL, WR_CORE_WGSL, WR_TEX_WGSL, WR_SPRITE_WGSL } from './lighting/wgslChunks';
import {
  CHAR_LIGHT_COMMON_GLSL, CHAR_LIGHT_COMMON_WGSL, PROBE_SAMPLING_GLSL, PROBE_SAMPLING_WGSL, SKYAO_SAMPLING_GLSL, SKYAO_SAMPLING_WGSL,
} from './CharacterShadingFilter';
import { ENTITY_SCENE_LIGHTS_GLSL, ENTITY_SCENE_LIGHTS_WGSL } from './CharacterLitSprite';

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
/** 已核实等价、写法不同的函数:tag → 函数名 */
const KNOWN_EQUIVALENT = new Set(['LC:lcSpotLight']);
/**
 * 只在 WGSL 里有的移植辅助函数:tag → 函数名。bmSmoothstep = GLSL 内建 smoothstep 的展开;
 * bmAlongKey = uBeamAlong 打包成 array<vec4, K/2> 之后按下标取 vec2
 */
const WGSL_ONLY_HELPERS = new Set(['beam:bmSmoothstep', 'beam:bmAlongKey']);

describe('GLSL / WGSL 孪生逐函数一致(函数集合 + 数值常量)', () => {
  for (const [tag, g, w] of PAIRS) {
    it(tag, () => {
      const G = fnsGlsl(g), W = fnsWgsl(w);
      const diffs: string[] = [];
      expect(G.size).toBeGreaterThan(0);
      for (const [n, body] of G) {
        const wb = W.get(n);
        if (!wb) { diffs.push(`WGSL 缺函数 ${n}`); continue; }
        if (KNOWN_EQUIVALENT.has(`${tag}:${n}`)) continue;
        const a = nums(body).join(','), b = nums(wb).join(',');
        if (a !== b) diffs.push(`${n}: glsl[${a}] wgsl[${b}]`);
      }
      for (const n of W.keys()) if (!G.has(n) && !WGSL_ONLY_HELPERS.has(`${tag}:${n}`)) diffs.push(`GLSL 缺函数 ${n}`);
      expect(diffs).toEqual([]);
    });
  }
});
