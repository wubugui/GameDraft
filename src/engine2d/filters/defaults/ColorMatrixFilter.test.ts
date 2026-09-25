/**
 * ColorMatrixFilter 与 Pixi 8.17 对照:每个预设方法(单独调用 / multiply 叠乘 / 长链)产出的 20 元矩阵逐元素相同,
 * uniform 声明(名 / 类型 / 个数)与 Pixi 相同。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ColorMatrixFilter as PixiColorMatrixFilter, DOMAdapter, type ColorSource as PixiColorSource } from 'pixi.js';
import { ColorMatrixFilter, type ColorMatrix } from './color-matrix/ColorMatrixFilter';

// Pixi 构造 GlProgram 时要探一次片元精度(建一张测试画布);node 里没有 document,给一张拿不到上下文的假画布
const adapter0 = DOMAdapter.get();
beforeAll(() => {
  DOMAdapter.set({ ...adapter0, createCanvas: () => ({ getContext: () => null }) as never });
});
afterAll(() => {
  DOMAdapter.set(adapter0);
});

type AnyFilter = Record<string, (...args: unknown[]) => void> & { matrix: ArrayLike<number>; alpha: number };

/** 同一串调用分别作用在两边,返回两边的矩阵 */
function runBoth(calls: Array<[string, ...unknown[]]>): { ours: number[]; pixi: number[] } {
  const ours = new ColorMatrixFilter() as unknown as AnyFilter;
  const pixi = new PixiColorMatrixFilter() as unknown as AnyFilter;
  for (const [name, ...args] of calls) {
    ours[name](...args);
    pixi[name](...args);
  }
  return { ours: Array.from(ours.matrix), pixi: Array.from(pixi.matrix) };
}

const SINGLE_CALLS: Array<[string, ...unknown[]]> = [
  ['brightness', 0.5, false],
  ['brightness', 1.7, false],
  ['tint', 0xff8040],
  ['tint', '#336699', false],
  ['greyscale', 0.3, false],
  ['grayscale', 0.8, false],
  ['blackAndWhite', false],
  ['hue', 0, false],
  ['hue', 45, false],
  ['hue', -130.5, false],
  ['contrast', 0, false],
  ['contrast', 0.6, false],
  ['contrast', -0.4, false],
  ['saturate'],
  ['saturate', 0.7, false],
  ['saturate', -0.3, false],
  ['desaturate'],
  ['negative', false],
  ['sepia', false],
  ['technicolor', false],
  ['polaroid', false],
  ['toBGR', false],
  ['kodachrome', false],
  ['browni', false],
  ['vintage', false],
  ['colorTone', 0, 0, 0, 0, false],
  ['colorTone', 0.5, 0.3, 0x8080ff, 0x102030, false],
  ['night', 0, false],
  ['night', 0.35, false],
  ['predator', 1, false],
  ['predator', 0.25, false],
  ['lsd', false],
  ['reset'],
];

describe('ColorMatrixFilter 与 Pixi 对照', () => {
  it('初始矩阵 / alpha / uniform 声明相同', () => {
    const ours = new ColorMatrixFilter();
    const pixi = new PixiColorMatrixFilter();
    expect(Array.from(ours.matrix)).toEqual(Array.from(pixi.matrix));
    expect(ours.alpha).toBe(pixi.alpha);
    const decl = (s: Record<string, { type: string; size?: number }>) =>
      Object.entries(s).map(([k, v]) => [k, v.type, v.size ?? 1]);
    expect(decl(ours.resources.colorMatrixUniforms.uniformStructures)).toEqual(
      decl((pixi.resources.colorMatrixUniforms as { uniformStructures: Record<string, { type: string; size?: number }> }).uniformStructures),
    );
    // Pixi 的 resources 是 Proxy(Object.keys 为空),只能按名取
    expect(Object.keys(ours.resources)).toEqual(['colorMatrixUniforms']);
    expect(pixi.resources.colorMatrixUniforms).toBeTruthy();
  });

  for (const call of SINGLE_CALLS) {
    it(`单独调用 ${call[0]}(${call.slice(1).map((a) => JSON.stringify(a)).join(', ')})`, () => {
      const { ours, pixi } = runBoth([call]);
      expect(ours).toHaveLength(20);
      expect(ours).toEqual(pixi);
    });
  }

  it('每个方法在非单位矩阵上 multiply=true 叠乘', () => {
    for (const [name, ...args] of SINGLE_CALLS) {
      if (name === 'reset' || name === 'desaturate') continue;
      // 最后一个 multiply 参数改成 true(tint / saturate 的 multiply 是可选参数,补上)
      const mArgs = [...args];
      const arity: Record<string, number> = { tint: 2, saturate: 2, colorTone: 5 };
      const n = arity[name] ?? (mArgs.length || 1);
      while (mArgs.length < n) mArgs.push(undefined);
      mArgs[n - 1] = true;
      const { ours, pixi } = runBoth([['hue', 33, false], [name, ...mArgs]]);
      expect(ours, name).toEqual(pixi);
    }
  });

  it('长链叠乘', () => {
    const { ours, pixi } = runBoth([
      ['sepia', false],
      ['brightness', 0.8, true],
      ['contrast', 0.3, true],
      ['hue', 170, true],
      ['saturate', 0.4, true],
      ['tint', 0x44ccff, true],
      ['predator', 0.1, true],
      ['night', 0.2, true],
      ['colorTone', 0.3, 0.2, 0xffe580, 0x338000, true],
      ['lsd', true],
      ['negative', true],
    ]);
    expect(ours).toEqual(pixi);
  });

  it('matrix / alpha setter', () => {
    const m = Array.from({ length: 20 }, (_, i) => (i * 7) % 5 - 1.5) as unknown as ColorMatrix;
    const ours = new ColorMatrixFilter();
    const pixi = new PixiColorMatrixFilter();
    ours.matrix = m;
    pixi.matrix = m as never;
    ours.alpha = 0.25;
    pixi.alpha = 0.25;
    ours.brightness(0.5, true);
    pixi.brightness(0.5, true);
    expect(Array.from(ours.matrix)).toEqual(Array.from(pixi.matrix));
    expect(ours.alpha).toBe(pixi.alpha);
    expect(ours.resources.colorMatrixUniforms.uniforms.uAlpha).toBe(0.25);
  });

  it('_loadMatrix 递增 uniform 版本', () => {
    const f = new ColorMatrixFilter();
    const before = f.resources.colorMatrixUniforms._dirtyId;
    f.brightness(0.5, false);
    expect(f.resources.colorMatrixUniforms._dirtyId).toBe(before + 1);
  });

  it('ColorSource 参数与 Pixi 同解析(数字 / 十六进制串)', () => {
    const colors: PixiColorSource[] = [0, 0xffffff, 0x123456, '#abcdef', '#fff', '0x7f7f7f'];
    for (const c of colors) {
      const { ours, pixi } = runBoth([['tint', c, false]]);
      expect(ours, String(c)).toEqual(pixi);
    }
  });
});
