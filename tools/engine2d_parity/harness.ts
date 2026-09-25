/**
 * engine2d 像素对照框架。
 *
 * 用例写一次场景代码,拿到的 `lib` 在参考侧是 `pixi.js`(WebGL 渲染器 = master 的行为),在候选侧是
 * `@src/engine2d`(RHI / WebGPU)。两边 API 同名同语义,所以同一段代码两边各跑一遍,画进同尺寸离屏目标,
 * 回读预乘后的原始字节逐像素比。两侧分在两个 iframe 里(Pixi 有模块级单例)。
 */
import * as PIXI from 'pixi.js';
import * as E2D from '@src/engine2d';
import { createRenderer } from '@src/engine2d/gpu/createRenderer';
import type { WebGPURenderer } from '@src/engine2d/gpu/WebGPURenderer';

/** 用例眼里的库:按 engine2d 的类型写(两边同名同语义) */
export type Lib = typeof E2D;
export type Side = 'ref' | 'cand';

export interface DataTextureOptions {
  width: number;
  height: number;
  seed: number;
  /** 取值 0..1 */
  fill?: (x: number, y: number, channel: number, rng: () => number) => number;
  alphaMode?: 'no-premultiply-alpha' | 'premultiply-alpha-on-upload' | 'premultiplied-alpha';
  scaleMode?: 'nearest' | 'linear';
  format?: 'rgba8unorm' | 'bgra8unorm';
}

export interface Env {
  readonly side: Side;
  readonly lib: Lib;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly renderer: any;
  rng(seed: number): () => number;
  /** 两侧逐字节相同的像素纹理 */
  dataTexture(opts: DataTextureOptions): E2D.Texture;
  /** 用 2D canvas 画一张图当纹理(两侧同一段绘制代码) */
  canvasTexture(width: number, height: number, draw: (ctx: CanvasRenderingContext2D) => void): E2D.Texture;
}

export interface Case {
  name: string;
  width: number;
  height: number;
  /** 单通道最大允许误差(0..1) */
  tolerance: number;
  maxBadPixels?: number;
  clearColor?: [number, number, number, number];
  /** 渲染目标分辨率(缺省 1) */
  resolution?: number;
  build(env: Env): E2D.Container | Promise<E2D.Container>;
  frames?: number;
  beforeFrame?(env: Env, root: E2D.Container, frame: number): void;
  /** 自定义产出(多次 render 的链):返回目标纹理,框架回读它 */
  produce?(env: Env): Promise<E2D.Texture> | E2D.Texture;
}

export interface Result {
  name: string;
  status: 'pass' | 'fail' | 'error';
  maxDiff: number;
  meanDiff: number;
  badPixels: number;
  bbox: [number, number, number, number] | null;
  detail: string;
  images?: { ref: string; cand: string; diff: string };
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SideContext {
  side: Side;
  lib: Lib;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  renderer: any;
}

export async function createSide(side: Side): Promise<SideContext> {
  if (side === 'ref') {
    const renderer = await PIXI.autoDetectRenderer({ preference: 'webgl', width: 16, height: 16, antialias: false, resolution: 1, backgroundAlpha: 0 });
    if (renderer.type !== 1) throw new Error(`参考渲染器不是 WebGL(type=${renderer.type})`);
    return { side, lib: PIXI as unknown as Lib, renderer };
  }
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 16;
  const renderer = await createRenderer({ canvas, width: 16, height: 16, resolution: 1, backgroundAlpha: 0 });
  return { side, lib: E2D, renderer };
}

function makeEnv(ctx: SideContext): Env {
  const { lib } = ctx;
  return {
    side: ctx.side,
    lib,
    renderer: ctx.renderer,
    rng: mulberry32,
    dataTexture(o) {
      const rng = mulberry32(o.seed);
      const data = new Uint8Array(o.width * o.height * 4);
      for (let y = 0; y < o.height; y++) {
        for (let x = 0; x < o.width; x++) {
          for (let c = 0; c < 4; c++) {
            const v = o.fill ? o.fill(x, y, c, rng) : rng();
            data[(y * o.width + x) * 4 + c] = Math.max(0, Math.min(255, Math.round(v * 255)));
          }
        }
      }
      const source = new lib.BufferImageSource({
        resource: data,
        width: o.width,
        height: o.height,
        format: o.format ?? 'rgba8unorm',
        alphaMode: o.alphaMode ?? 'premultiplied-alpha',
        scaleMode: o.scaleMode ?? 'nearest',
      });
      return new lib.Texture({ source });
    },
    canvasTexture(width, height, draw) {
      const c = document.createElement('canvas');
      c.width = width;
      c.height = height;
      draw(c.getContext('2d')!);
      return new lib.Texture({ source: new lib.CanvasSource({ resource: c }) });
    },
  };
}

async function readRaw(ctx: SideContext, rt: E2D.Texture): Promise<Float32Array> {
  const { width, height } = rt.source;
  const pw = Math.round(width * rt.source.resolution);
  const ph = Math.round(height * rt.source.resolution);
  const out = new Float32Array(pw * ph * 4);
  if (ctx.side === 'ref') {
    const gl = ctx.renderer.gl as WebGL2RenderingContext;
    ctx.renderer.renderTarget.bind(rt, false);
    const u8 = new Uint8Array(pw * ph * 4);
    gl.readPixels(0, 0, pw, ph, gl.RGBA, gl.UNSIGNED_BYTE, u8);
    for (let i = 0; i < u8.length; i++) out[i] = u8[i] / 255;
    return out;
  }
  const rb = await (ctx.renderer as WebGPURenderer).readTextureRaw(rt.source);
  for (let i = 0; i < out.length; i++) out[i] = rb.data[i] / 255;
  if (rb.format === 'bgra8unorm') {
    for (let i = 0; i < out.length; i += 4) {
      const b = out[i];
      out[i] = out[i + 2];
      out[i + 2] = b;
    }
  }
  return out;
}

export interface SideOutput {
  name: string;
  data: Float32Array | null;
  width: number;
  height: number;
  error: string | null;
  warnings: string[];
}

export async function renderSide(ctx: SideContext, c: Case): Promise<SideOutput> {
  const warnings: string[] = [];
  const origWarn = console.warn;
  const origError = console.error;
  console.warn = (...a: unknown[]) => {
    warnings.push(a.map(String).join(' '));
    origWarn(...a);
  };
  console.error = (...a: unknown[]) => {
    warnings.push(a.map(String).join(' '));
    origError(...a);
  };
  const res = c.resolution ?? 1;
  const base = { name: c.name, width: Math.round(c.width * res), height: Math.round(c.height * res) };
  try {
    const env = makeEnv(ctx);
    if (c.produce) {
      const tex = await c.produce(env);
      return { ...base, data: await readRaw(ctx, tex), error: null, warnings };
    }
    const root = await c.build(env);
    const rt = ctx.lib.RenderTexture.create({ width: c.width, height: c.height, resolution: res, antialias: false });
    try {
      const frames = c.frames ?? 1;
      for (let f = 0; f < frames; f++) {
        c.beforeFrame?.(env, root, f);
        ctx.renderer.render({ container: root, target: rt, clear: true, clearColor: c.clearColor ?? [0, 0, 0, 0] });
      }
      return { ...base, data: await readRaw(ctx, rt), error: null, warnings };
    } finally {
      root.destroy({ children: true });
      rt.destroy(true);
    }
  } catch (e) {
    return { ...base, data: null, error: e instanceof Error ? `${e.name}: ${e.message}\n${(e.stack ?? '').split('\n').slice(1, 6).join('\n')}` : String(e), warnings };
  } finally {
    console.warn = origWarn;
    console.error = origError;
  }
}

export function compare(ref: Float32Array, cand: Float32Array, width: number, height: number, tolerance: number) {
  let maxDiff = 0;
  let sum = 0;
  let bad = 0;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      let px = 0;
      for (let ch = 0; ch < 4; ch++) {
        const d = Math.abs(ref[i + ch] - cand[i + ch]);
        px = Math.max(px, d);
        sum += d;
      }
      maxDiff = Math.max(maxDiff, px);
      if (px > tolerance + 1e-6) {
        bad++;
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }
  }
  return { maxDiff, meanDiff: sum / (width * height * 4), badPixels: bad, bbox: bad ? ([x0, y0, x1, y1] as [number, number, number, number]) : null };
}

function toDataUrl(data: Float32Array, width: number, height: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(width, height);
  for (let i = 0; i < data.length; i++) img.data[i] = Math.round(Math.max(0, Math.min(1, data[i])) * 255);
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL();
}

function diffImage(ref: Float32Array, cand: Float32Array, tolerance: number): Float32Array {
  const out = new Float32Array(ref.length);
  for (let i = 0; i < ref.length; i += 4) {
    let d = 0;
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(ref[i + c] - cand[i + c]));
    out[i] = d > tolerance ? 1 : Math.min(1, d / Math.max(tolerance, 1e-6));
    out[i + 1] = d > tolerance ? 0 : 0.2;
    out[i + 3] = 1;
  }
  return out;
}

export function judge(c: Case, ref: SideOutput, cand: SideOutput, withImages: boolean): Result {
  const base = { name: c.name, maxDiff: 0, meanDiff: 0, badPixels: 0, bbox: null };
  if (ref.error || !ref.data) return { ...base, status: 'error', detail: `参考(Pixi WebGL)出错:${ref.error}\n${ref.warnings.slice(0, 6).join('\n')}` };
  if (cand.error || !cand.data) return { ...base, status: 'error', detail: `候选(engine2d)出错:${cand.error}\n${cand.warnings.slice(0, 6).join('\n')}` };
  if (ref.data.length !== cand.data.length) return { ...base, status: 'error', detail: `两侧结果长度不同:${ref.data.length} ≠ ${cand.data.length}` };
  const s = compare(ref.data, cand.data, ref.width, ref.height, c.tolerance);
  const pass = s.badPixels <= (c.maxBadPixels ?? 0);
  return {
    ...base,
    ...s,
    status: pass ? 'pass' : 'fail',
    detail: [
      `最大差 ${s.maxDiff.toPrecision(3)} / 平均差 ${s.meanDiff.toPrecision(3)} / 超容差(${c.tolerance})像素 ${s.badPixels}` + (s.bbox ? ` 范围 [${s.bbox.join(',')}]` : ''),
      ...cand.warnings.slice(0, 6).map((w) => `候选告警:${w}`),
    ].join('\n'),
    images: withImages
      ? { ref: toDataUrl(ref.data, ref.width, ref.height), cand: toDataUrl(cand.data, ref.width, ref.height), diff: toDataUrl(diffImage(ref.data, cand.data, c.tolerance), ref.width, ref.height) }
      : undefined,
  };
}
