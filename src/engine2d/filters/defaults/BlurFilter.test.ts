/**
 * BlurFilter / BlurFilterPass 与 Pixi 8.17 对照:
 * - 高斯权重表、按 (方向, kernelSize) 生成的 WGSL 逐字节相同;
 * - 各种构造 / setter 序列后的 strength / quality / passes / padding / uStrength 等状态相同;
 * - 用假 filterManager 记录 apply 的调用序列(哪个 pass、输入 / 输出、clear、当时的 uStrength、blendMode)
 *   与临时纹理(池里借的尺寸 / 分辨率 / 帧,借还是否复用)与 Pixi 喂同样假对象的结果相同。
 *   Pixi 侧的假渲染器取 WebGPU 类型(engine2d 只有 WebGPU,走的是 Pixi 的 WebGPU 分支)。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  BlurFilter as PixiBlurFilter,
  BlurFilterPass as PixiBlurFilterPass,
  DOMAdapter,
  GAUSSIAN_VALUES as PIXI_GAUSSIAN_VALUES,
  RendererType as PixiRendererType,
  TexturePool as PixiTexturePool,
  generateBlurProgram as pixiGenerateBlurProgram,
  type BlurFilterOptions as PixiBlurFilterOptions,
  type FilterSystem as PixiFilterSystem,
  type Texture as PixiTexture,
} from 'pixi.js';
import { BlurFilter, type BlurFilterOptions } from './blur/BlurFilter';
import { BlurFilterPass } from './blur/BlurFilterPass';
import { GAUSSIAN_VALUES } from './blur/const';
import { generateBlurProgram } from './blur/gpu/generateBlurProgram';
import { TexturePool } from '../../textures/TexturePool';
import type { Texture } from '../../textures/Texture';
import type { FilterSystemLike } from '../Filter';
import type { RenderSurface } from '../../gpu/renderTargets';

const adapter0 = DOMAdapter.get();
beforeAll(() => {
  // Pixi 构造 GlProgram 时要探一次片元精度;node 里给一张拿不到上下文的假画布
  DOMAdapter.set({ ...adapter0, createCanvas: () => ({ getContext: () => null }) as never });
  // Pixi 的弃用 API(数字参数构造、blur / blurX / blurY)会打警告
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => {
  DOMAdapter.set(adapter0);
  vi.restoreAllMocks();
});

const KERNEL_SIZES = [5, 7, 9, 11, 13, 15];

/* eslint-disable @typescript-eslint/no-explicit-any */
function passState(p: any): Record<string, unknown> {
  return {
    horizontal: p.horizontal,
    strength: p.strength,
    blur: p.blur,
    passes: p.passes,
    quality: p.quality,
    legacy: p.legacy,
    padding: p.padding,
    resolution: p.resolution,
    antialias: p.antialias,
    blendMode: p.blendMode,
    blendRequired: p.blendRequired,
    clipToViewport: p.clipToViewport,
    enabled: p.enabled,
    uStrength: p.resources.blurUniforms.uniforms.uStrength,
    uniformDecl: Object.entries(p.resources.blurUniforms.uniformStructures).map(([k, v]: [string, any]) => [k, v.type, v.size ?? 1]),
  };
}

function blurState(f: any): Record<string, unknown> {
  let strength: unknown;
  try {
    strength = f.strength;
  } catch (e) {
    strength = `throw: ${(e as Error).message}`;
  }
  return {
    strength,
    strengthX: f.strengthX,
    strengthY: f.strengthY,
    quality: f.quality,
    padding: f.padding,
    resolution: f.resolution,
    antialias: f.antialias,
    blendMode: f.blendMode,
    blendRequired: f.blendRequired,
    clipToViewport: f.clipToViewport,
    enabled: f.enabled,
    repeatEdgePixels: f.repeatEdgePixels,
    compatibleRenderers: f.compatibleRenderers,
    x: passState(f.blurXFilter),
    y: passState(f.blurYFilter),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

describe('模糊着色器生成', () => {
  it('高斯权重表相同', () => {
    expect(GAUSSIAN_VALUES).toEqual(PIXI_GAUSSIAN_VALUES);
  });

  for (const kernelSize of KERNEL_SIZES) {
    for (const horizontal of [true, false]) {
      it(`generateBlurProgram(${horizontal}, ${kernelSize}) 的 WGSL 与 Pixi 逐字节相同`, () => {
        const ours = generateBlurProgram(horizontal, kernelSize);
        const pixi = pixiGenerateBlurProgram(horizontal, kernelSize);
        expect(ours.vertex.source).toBe(pixi.vertex!.source);
        expect(ours.fragment!.source).toBe(pixi.fragment!.source);
        expect(ours.vertex.entryPoint).toBe(pixi.vertex!.entryPoint);
        expect(ours.fragment!.entryPoint).toBe(pixi.fragment!.entryPoint);
        // 占位符全部展开
        expect(ours.source).not.toMatch(/%[a-z-]+%/);
        // 每个采样点一个插值变量
        expect(ours.source.match(/@location\(\d+\) offset\d+: vec2<f32>,/g)).toHaveLength(kernelSize * 2);
      });
    }
  }
});

const CONSTRUCTIONS: Array<{ name: string; args: unknown[] }> = [
  { name: '无参', args: [] },
  { name: '空对象', args: [{}] },
  { name: 'strength + quality', args: [{ strength: 5, quality: 3 }] },
  { name: 'strengthX / strengthY', args: [{ strengthX: 2, strengthY: 7 }] },
  { name: 'strengthX = 0 不回落到 strength', args: [{ strength: 3, strengthX: 0 }] },
  { name: 'legacy + kernelSize 9 + inherit(contactAo 用法)', args: [{ strength: 1, quality: 2, kernelSize: 9, legacy: true, resolution: 'inherit' }] },
  { name: '负强度 + 其它滤镜选项', args: [{ strength: -4, quality: 1, kernelSize: 15, padding: 7, blendMode: 'add', antialias: true, clipToViewport: false }] },
  { name: '游戏用法 { strength, quality: 3 }', args: [{ strength: 2.5, quality: 3 }] },
  { name: '弃用:数字参数 (4, 2, null, 7)', args: [4, 2, null, 7] },
  { name: '弃用:数字参数 (6)', args: [6] },
  { name: '弃用:数字参数 (6, undefined, 2)', args: [6, undefined, 2] },
];

describe('BlurFilter 状态与 Pixi 对照', () => {
  for (const { name, args } of CONSTRUCTIONS) {
    it(`构造:${name}`, () => {
      const ours = new (BlurFilter as unknown as new (...a: unknown[]) => BlurFilter)(...args);
      const pixi = new (PixiBlurFilter as unknown as new (...a: unknown[]) => PixiBlurFilter)(...args);
      expect(blurState(ours)).toEqual(blurState(pixi));
      expect(ours.blurXFilter).toBeInstanceOf(BlurFilterPass);
      expect(ours.gpuProgram).toBeNull();
      expect(ours.blurXFilter.gpuProgram!.vertex.source).toBe(pixi.blurXFilter.gpuProgram.vertex!.source);
      expect(ours.blurYFilter.gpuProgram!.vertex.source).toBe(pixi.blurYFilter.gpuProgram.vertex!.source);
    });
  }

  it('setter 序列', () => {
    const ours = new BlurFilter();
    const pixi = new PixiBlurFilter();
    const steps: Array<(f: Record<string, unknown>) => void> = [
      (f) => { f.strength = 10; },
      (f) => { f.quality = 5; },
      (f) => { f.strengthX = 3; },
      (f) => { f.strengthY = -9; },
      (f) => { f.repeatEdgePixels = true; },
      (f) => { f.strength = 2; },
      (f) => { f.repeatEdgePixels = false; },
      (f) => { f.blur = 4; },
      (f) => { f.blurX = 1; },
      (f) => { f.blurY = 2.5; },
      (f) => { f.quality = 1; },
      (f) => { f.blendMode = 'screen'; },
      (f) => { f.strengthY = 0; },
    ];
    steps.forEach((step, i) => {
      step(ours as unknown as Record<string, unknown>);
      step(pixi as unknown as Record<string, unknown>);
      expect(blurState(ours), `第 ${i} 步`).toEqual(blurState(pixi));
    });
    expect((ours as unknown as { blurX: number }).blurX).toBe(pixi.blurX);
    expect((ours as unknown as { blurY: number }).blurY).toBe(pixi.blurY);
  });

  it('BlurFilterPass 单独构造', () => {
    for (const opts of [{ horizontal: true }, { horizontal: false, strength: 3, quality: 2, kernelSize: 11 }, { horizontal: true, legacy: true, strength: -2 }]) {
      const ours = new BlurFilterPass(opts);
      const pixi = new PixiBlurFilterPass(opts);
      expect(passState(ours)).toEqual(passState(pixi));
    }
  });
});

// ─────────────────────────── apply 调用序列

interface TexInfo {
  frameWidth: number;
  frameHeight: number;
  pixelWidth: number;
  pixelHeight: number;
  resolution: number;
}

interface CallRecord {
  pass: 'x' | 'y';
  input: string;
  output: string;
  clear: boolean;
  uStrength: number;
  blendMode: string;
}

interface TexLike {
  frame: { width: number; height: number };
  source: { pixelWidth: number; pixelHeight: number; _resolution: number };
}

/** 给出现过的纹理起名(input / output / tmp0 / tmp1 …),并记下临时纹理首次出现时的尺寸 */
class Recorder {
  readonly calls: CallRecord[] = [];
  readonly temps: Array<TexInfo & { label: string }> = [];
  private readonly labels = new Map<unknown, string>();

  constructor(input: unknown, output: unknown) {
    this.labels.set(input, 'input');
    this.labels.set(output, 'output');
  }

  label(t: unknown): string {
    let l = this.labels.get(t);
    if (!l) {
      l = `tmp${this.temps.length}`;
      this.labels.set(t, l);
      const tex = t as TexLike;
      this.temps.push({
        label: l,
        frameWidth: tex.frame.width,
        frameHeight: tex.frame.height,
        pixelWidth: tex.source.pixelWidth,
        pixelHeight: tex.source.pixelHeight,
        resolution: tex.source._resolution,
      });
    }
    return l;
  }

  record(filter: { horizontal: boolean; blendMode: string; resources: Record<string, { uniforms: { uStrength: number } }> }, input: unknown, output: unknown, clear: boolean): void {
    this.calls.push({
      pass: filter.horizontal ? 'x' : 'y',
      input: this.label(input),
      output: this.label(output),
      clear,
      uStrength: filter.resources.blurUniforms.uniforms.uStrength,
      blendMode: filter.blendMode,
    });
  }
}

interface ApplyCase {
  options: BlurFilterOptions;
  input: [number, number, number];
  clear: boolean;
}

function runOurs(c: ApplyCase, times: number): Recorder {
  const filter = new BlurFilter(c.options);
  const input = TexturePool.getOptimalTexture(...c.input, false);
  const output = { label: 'output' } as unknown as RenderSurface;
  const rec = new Recorder(input, output);
  const fm: FilterSystemLike = {
    applyFilter: (f, i, o, clear) => rec.record(f as unknown as Parameters<Recorder['record']>[0], i, o, clear),
    calculateSpriteMatrix: (m) => m,
  };
  for (let n = 0; n < times; n++) filter.apply(fm, input as Texture, output, c.clear);
  TexturePool.returnTexture(input);
  return rec;
}

function runPixi(c: ApplyCase, times: number): Recorder {
  const filter = new PixiBlurFilter(c.options as PixiBlurFilterOptions);
  const input = PixiTexturePool.getOptimalTexture(...c.input, false);
  const output = { label: 'output' } as unknown as PixiTexture;
  const rec = new Recorder(input, output);
  const fm = {
    renderer: { type: PixiRendererType.WEBGPU, renderPipes: {} },
    applyFilter: (f: unknown, i: unknown, o: unknown, clear: boolean) => rec.record(f as Parameters<Recorder['record']>[0], i, o, clear),
  } as unknown as PixiFilterSystem;
  for (let n = 0; n < times; n++) filter.apply(fm, input, output, c.clear);
  PixiTexturePool.returnTexture(input);
  return rec;
}

const OPTION_SETS: BlurFilterOptions[] = [
  {},
  { strength: 3, quality: 1 },
  { strength: 2.5, quality: 3 },
  { strengthX: 5, strengthY: 0, quality: 3 },
  { strengthX: 0, strengthY: 5, quality: 2 },
  { strength: 0 },
  { strength: 2, quality: 3, legacy: true },
  { strength: 1, quality: 1, legacy: true },
  { strength: 1, quality: 2, kernelSize: 9, legacy: true, resolution: 'inherit' },
  { strengthX: -3, strengthY: 6, quality: 5, legacy: true, blendMode: 'add' },
  { strength: 4, quality: 2, blendMode: 'screen' },
  { strengthX: 7, strengthY: 0, quality: 4, blendMode: 'multiply' },
];

const INPUTS: Array<[number, number, number]> = [
  [100, 50, 1],
  [33.3, 17.9, 2],
  [257, 3, 0.5],
];

describe('BlurFilter.apply 调用序列与 Pixi(WebGPU 分支)对照', () => {
  for (const options of OPTION_SETS) {
    for (const input of INPUTS) {
      for (const clear of [true, false]) {
        const c: ApplyCase = { options, input, clear };
        it(`${JSON.stringify(options)} 输入 ${input.join('×')} clear=${clear}`, () => {
          // 连续 apply 两次:第二次应复用第一次归还的临时纹理(标签不增)
          const ours = runOurs(c, 2);
          const pixi = runPixi(c, 2);
          expect(ours.calls.length).toBeGreaterThan(0);
          expect(ours.calls).toEqual(pixi.calls);
          expect(ours.temps).toEqual(pixi.temps);
        });
      }
    }
  }

  it('optimized 多 pass 的 uStrength 逐 pass 减半,平方和等于 strength²', () => {
    const rec = runOurs({ options: { strengthX: 6, strengthY: 0, quality: 4 }, input: [64, 64, 1], clear: true }, 1);
    const s = rec.calls.map((r) => r.uStrength);
    expect(s).toHaveLength(4);
    for (let i = 1; i < s.length; i++) expect(s[i]).toBeCloseTo(s[i - 1] * 0.5, 12);
    expect(Math.sqrt(s.reduce((a, v) => a + v * v, 0))).toBeCloseTo(6, 12);
  });
});
