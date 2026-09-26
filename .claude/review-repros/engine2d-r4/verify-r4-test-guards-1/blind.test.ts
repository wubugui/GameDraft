import { describe, expect, it } from 'vitest';
import LC_GLSL from '../../../../src/rendering/lighting/lightingCore.glsl?raw';
import { LC_WGSL } from '../../../../src/rendering/lighting/wgslChunks';
import BR_GLSL from '../../../../src/rendering/breathingShade.glsl?raw';
import BR_WGSL from '../../../../src/rendering/breathingShade.wgsl?raw';

// verbatim copies of the guard helpers (src/rendering/shaderTwins.test.ts:28-47)
const sl = (src: string, tag: string) => { const b = `//__${tag}_BEGIN__`, e = `//__${tag}_END__`; return src.substring(src.indexOf(b) + b.length, src.indexOf(e)); };
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
function fnsGlsl(s: string) { const t = strip(s); const out = new Map<string, string>(); const re = /^\s*(?:float|int|bool|void|vec[234]|ivec[234]|mat[234])\s+(\w+)\s*\(/gm; let m; const idx: Array<[string, number]> = []; while ((m = re.exec(t))) idx.push([m[1], m.index]); idx.forEach(([n, i], k) => out.set(n, t.slice(i, k + 1 < idx.length ? idx[k + 1][1] : t.length))); return out; }
function fnsWgsl(s: string) { const t = strip(s); const out = new Map<string, string>(); const re = /\bfn\s+(\w+)\s*\(/g; let m; const idx: Array<[string, number]> = []; while ((m = re.exec(t))) idx.push([m[1], m.index]); idx.forEach(([n, i], k) => out.set(n, t.slice(i, k + 1 < idx.length ? idx[k + 1][1] : t.length))); return out; }
const nums = (s: string) => [...s.replace(/\b(vec[234]|mat[234]x[234]|array|texture_2d|ptr)<[^>]*>/g, ' ').replace(/(\d)[fu]\b/g, '$1')
  .matchAll(/(?<![\w.])(\d*\.\d+(?:[eE][-+]?\d+)?|\d+\.(?:[eE][-+]?\d+)?|\d+[eE][-+]?\d+)/g)].map((m) => Number(m[1])).filter((x) => x !== 0 && x !== 1).sort((a, b) => a - b);
const guardPasses = (g: string, w: string) => { const G = fnsGlsl(g), W = fnsWgsl(w); for (const [n, b] of G) { if (n === 'lcSpotLight') continue; const wb = W.get(n); if (!wb || nums(b).join() !== nums(wb).join()) return false; } for (const n of W.keys()) if (!G.has(n)) return false; return true; };

const LCG = sl(LC_GLSL, 'LIGHTING_CORE');
function mut(src: string, a: string, b: string) { expect(src.includes(a)).toBe(true); return src.replace(a, b); }

describe('shaderTwins blind spots', () => {
  it('baseline passes', () => { expect(guardPasses(LCG, LC_WGSL)).toBe(true); expect(guardPasses(BR_GLSL, BR_WGSL)).toBe(true); });
  it('sanity: guard catches a float change inside a fn', () => { expect(guardPasses(LCG, mut(LC_WGSL, '(0.5 / LC_PI)', '(0.25 / LC_PI)'))).toBe(false); });
  it('integer loop bound 128->64 invisible', () => { expect(guardPasses(LCG, mut(LC_WGSL, 'i <= 128', 'i <= 64'))).toBe(true); });
  it('breathing 12 iterations -> 4 invisible', () => { expect(guardPasses(BR_GLSL, mut(BR_WGSL, 'i < 12;', 'i < 4;'))).toBe(true); });
  it('top-level LC_PI / LC_LUMA invisible', () => {
    expect(guardPasses(LCG, mut(LC_WGSL, '3.14159265358979323846', '3.0'))).toBe(true);
    expect(guardPasses(LCG, mut(LC_WGSL, '0.2126, 0.7152, 0.0722', '0.299, 0.587, 0.114'))).toBe(true);
  });
  it('light kind codes swap invisible', () => { expect(guardPasses(LCG, mut(mut(LC_WGSL, 'LC_SPOT: i32 = 1', 'LC_SPOT: i32 = 2'), 'LC_AREA: i32 = 2', 'LC_AREA: i32 = 1'))).toBe(true); });
  it('sign flip invisible', () => { expect(guardPasses(LCG, mut(LC_WGSL, '(0.5 / LC_PI)', '(-0.5 / LC_PI)'))).toBe(true); });
  it('sl() with missing marker silently returns garbage', () => { const r = sl('abc//__X_END__', 'NOPE'); expect(typeof r).toBe('string'); });
});
