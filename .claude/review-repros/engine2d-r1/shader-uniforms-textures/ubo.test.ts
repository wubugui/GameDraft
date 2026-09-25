import { describe, expect, it } from 'vitest';
import { createUboElementsWGSL, createUboSyncFunctionWGSL } from 'pixi.js';
import { Matrix as PixiMatrix } from 'pixi.js';
import { UniformGroup, Matrix } from '../../../../src/engine2d';
import { packUbo } from '../../../../src/engine2d/shader/uboLayout';
import { createFrameLitUniforms, createSceneLitUniforms, createCharLightUniforms } from '../../../../src/rendering/CharacterLitSprite';

function pixiPack(g: UniformGroup): Float32Array {
  const elements = Object.keys(g.uniformStructures).map((k) => g.uniformStructures[k] as any);
  const layout = createUboElementsWGSL(elements);
  const sync = createUboSyncFunctionWGSL(layout.uboElements);
  const data = new Float32Array(layout.size / 4 + 64); // slack for pixi overrun
  const i32 = new Int32Array(data.buffer);
  sync(g.uniforms, data, i32, 0);
  return data.slice(0, layout.size / 4);
}
function ourPack(g: UniformGroup): Float32Array {
  const buf = new ArrayBuffer(g.layout.size + 256);
  const f = new Float32Array(buf);
  packUbo(g.layout, g.uniforms as any, f, new Int32Array(buf), new Uint32Array(buf), 0);
  return f.slice(0, g.layout.size / 4);
}
function cmp(g: UniformGroup, label: string) {
  const a = pixiPack(g); const b = ourPack(g);
  expect(b.length, label).toBe(a.length);
  const ua = new Uint32Array(a.buffer, 0, a.length); const ub = new Uint32Array(b.buffer, 0, b.length);
  const diffs: string[] = [];
  for (let i = 0; i < a.length; i++) if (ua[i] !== ub[i] && !(Number.isNaN(a[i]) && b[i] === 0)) diffs.push(`${i}: pixi=${a[i]} ours=${b[i]}`);
  expect(diffs, label).toEqual([]);
}

describe('ubo packing vs pixi', () => {
  it('synthetic', () => {
    const rnd = (n: number) => Float32Array.from({ length: n }, (_, i) => i * 1.5 + 0.25);
    const g = new UniformGroup({
      a: { value: 3.5, type: 'f32' },
      b: { value: rnd(3), type: 'vec3<f32>' },
      c: { value: 7, type: 'i32' },
      d: { value: rnd(2), type: 'vec2<f32>' },
      e: { value: rnd(9), type: 'mat3x3<f32>' },
      f: { value: rnd(27), type: 'vec3<f32>', size: 9 },
      g: { value: rnd(4 * 48), type: 'vec4<f32>', size: 48 },
      h: { value: rnd(2 * 5), type: 'vec2<f32>', size: 5 },
      i: { value: new Int32Array([1, 2, 3]), type: 'vec3<i32>' },
      j: { value: rnd(4), type: 'mat2x2<f32>' },
      k: { value: rnd(16), type: 'mat4x4<f32>' },
      l: { value: 1.25, type: 'f32' },
    });
    cmp(g, 'synthetic');
  });
  it('matrix objects', () => {
    const m = new Matrix(1, 2, 3, 4, 5, 6);
    const g = new UniformGroup({ m: { value: m, type: 'mat3x3<f32>' }, x: { value: 1, type: 'f32' } });
    const pm = new PixiMatrix(1, 2, 3, 4, 5, 6);
    const gp = new UniformGroup({ m: { value: pm as any, type: 'mat3x3<f32>' }, x: { value: 1, type: 'f32' } });
    const a = pixiPack(gp); const b = ourPack(g);
    expect(Array.from(b)).toEqual(Array.from(a));
  });
  it('game groups', () => {
    cmp(createFrameLitUniforms(), 'frame');
    cmp(createCharLightUniforms(), 'charLights');
  });
});
