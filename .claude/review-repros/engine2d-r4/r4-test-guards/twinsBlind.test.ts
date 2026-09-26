/**
 * r4-test-guards: shaderTwins.test.ts 的比较函数对以下单边改动看不见(复制同一套 fnsGlsl / fnsWgsl / nums 逻辑,
 * 在真实孪生源上做单边突变,断言「守门判一致」= 盲区存在)。
 */
import { describe, expect, it } from 'vitest';
import LC_GLSL from '../../../../src/rendering/lighting/lightingCore.glsl?raw';
import BR_GLSL from '../../../../src/rendering/breathingShade.glsl?raw';
import BR_WGSL from '../../../../src/rendering/breathingShade.wgsl?raw';
import { LC_WGSL } from '../../../../src/rendering/lighting/wgslChunks';

const sl = (src: string, tag: string) => { const b = `//__${tag}_BEGIN__`, e = `//__${tag}_END__`; return src.substring(src.indexOf(b) + b.length, src.indexOf(e)); };
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
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

function guardDiffs(g: string, w: string, skip = new Set<string>()): string[] {
  const G = fnsGlsl(g), W = fnsWgsl(w);
  const diffs: string[] = [];
  for (const [n, body] of G) {
    const wb = W.get(n);
    if (!wb) { diffs.push(`WGSL 缺函数 ${n}`); continue; }
    if (skip.has(n)) continue;
    if (nums(body).join(',') !== nums(wb).join(',')) diffs.push(n);
  }
  for (const n of W.keys()) if (!G.has(n) && !skip.has(n)) diffs.push(`GLSL 缺函数 ${n}`);
  return diffs;
}

describe('shaderTwins 守门盲区', () => {
  const LC_G = sl(LC_GLSL, 'LIGHTING_CORE');
  const LC_SKIP = new Set(['lcSpotLight']);

  it('基线:真源两边一致', () => {
    expect(guardDiffs(LC_G, LC_WGSL, LC_SKIP)).toEqual([]);
    expect(guardDiffs(BR_GLSL, BR_WGSL)).toEqual([]);
  });

  it('WGSL 里呼吸位移的迭代次数 12 → 4:守门仍判一致(整数常量不比)', () => {
    const mutated = BR_WGSL.replace(/i < 12;/g, 'i < 4;');
    expect(mutated).not.toBe(BR_WGSL);
    expect(guardDiffs(BR_GLSL, mutated)).toEqual([]);
  });

  it('WGSL 顶层常量 LC_LUMA / LC_PI 改值、灯种码 LC_SPOT 与 LC_AREA 对调:守门仍判一致(首个函数之前的顶层声明不比)', () => {
    let mutated = LC_WGSL.replace('vec3<f32>(0.2126, 0.7152, 0.0722)', 'vec3<f32>(0.299, 0.587, 0.114)');
    mutated = mutated.replace('const LC_PI: f32 = 3.14159265358979323846;', 'const LC_PI: f32 = 3.0;');
    mutated = mutated.replace('const LC_SPOT: i32 = 1;', 'const LC_SPOT: i32 = 2;').replace('const LC_AREA: i32 = 2;', 'const LC_AREA: i32 = 1;');
    expect(mutated).not.toBe(LC_WGSL);
    expect(guardDiffs(LC_G, mutated, LC_SKIP)).toEqual([]);
  });

  it('WGSL 里 128 步行进上限改 64、符号取反:守门仍判一致', () => {
    const mutated = LC_WGSL.replace('i <= 128;', 'i <= 64;');
    expect(mutated).not.toBe(LC_WGSL);
    expect(guardDiffs(LC_G, mutated, LC_SKIP)).toEqual([]);
    // 任一 "* 0.5" 改成 "* -0.5":负号不进比较
    const neg = LC_WGSL.replace('(0.5 / LC_PI)', '(-0.5 / LC_PI)');
    expect(neg).not.toBe(LC_WGSL);
    expect(guardDiffs(LC_G, neg, LC_SKIP)).toEqual([]);
  });
});
