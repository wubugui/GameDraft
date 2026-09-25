/**
 * 渲染像素对照框架。
 *
 * 同一段运行时代码(真实的 Mesh / Filter / Shader 类)分别交给两个渲染器画进同尺寸的离屏目标,
 * 回读后逐像素比:
 *   - 参考:Pixi WebGL 渲染器,跑 GLSL —— 就是 master 上游戏的行为;
 *   - 候选:Pixi WebGPU 渲染器,跑 WGSL,且**用 RHI 的 GPUDevice**(迁移后的真实结构)。
 * 移植一个着色器 = 给它补上 WGSL,再写一个用例证明两边像素一致。
 */
import {
  autoDetectRenderer,
  BufferImageSource,
  Container,
  RenderTexture,
  Texture,
  type Renderer,
  type WebGLRenderer,
} from 'pixi.js';
import { createRhiDevice, type RhiDevice } from '@src/rendering/rhi';
import { installPixiWebGpuPatches } from '@src/rendering/legacy/pixiWebGpuPatches';

export type ParityTarget = 'rgba8unorm' | 'rgba16float' | 'rgba32float';
export type ParityDataFormat = 'rgba8unorm' | 'r8unorm' | 'rgba16float' | 'rgba32float';

export interface DataTextureOptions {
  width: number;
  height: number;
  format?: ParityDataFormat;
  /** 同一种子两个渲染器拿到逐字节相同的内容 */
  seed: number;
  /** 自定义取值(0..1;float 格式可越界);缺省均匀随机 */
  fill?: (x: number, y: number, channel: number, rng: () => number) => number;
  /** 缺省 no-premultiply-alpha:数据纹理不许被上传链路乘掉 alpha */
  alphaMode?: 'no-premultiply-alpha' | 'premultiply-alpha-on-upload' | 'premultiplied-alpha';
  scaleMode?: 'nearest' | 'linear';
  addressMode?: 'clamp-to-edge' | 'repeat' | 'mirror-repeat';
}

export interface ParityEnv {
  /** 当前是哪一边 */
  readonly side: 'gl' | 'gpu';
  readonly renderer: Renderer;
  rng(seed: number): () => number;
  dataTexture(opts: DataTextureOptions): Texture;
  /**
   * 回读一张渲染目标(`RenderTexture`)为 w*h*4 的浮点数组(8 位目标归一到 0..1,`bgra8unorm` 已换成 RGBA 通道序)。
   * 多 pass 的离屏链在 `produce()` 里自己驱动宿主类渲染,再用它回读结果。
   */
  readTexture(texture: Texture, target: ParityTarget): Promise<Float32Array>;
}

export interface ParityCase {
  /** 「模块 / 场景」,例如「阴影前缀 / 初始化 pass」 */
  name: string;
  width: number;
  height: number;
  /** 对照目标的格式;浮点目标按浮点值比较 */
  target?: ParityTarget;
  /** 单通道允许的最大绝对误差(8 位目标按 0..1 归一后的值) */
  tolerance: number;
  /** 超出容差的像素最多几个(缺省 0) */
  maxBadPixels?: number;
  clearColor?: [number, number, number, number];
  /** 用真实运行时代码搭出要画的东西。两个渲染器各调一次,各拿各的对象 */
  build(env: ParityEnv): Container | Promise<Container>;
  /** 画之前调用(可逐帧推进状态);缺省只画一帧 */
  frames?: number;
  beforeFrame?(env: ParityEnv, root: Container, frame: number): void;
  /**
   * 完全自定义:不走「搭场景画一帧」,自己产出一份 w*h*4 的浮点结果(比如多 pass 的离屏烘焙链)。
   * 给了它就不调 build。
   */
  produce?(env: ParityEnv): Promise<Float32Array>;
}

export interface ParityResult {
  name: string;
  status: 'pass' | 'fail' | 'error';
  maxDiff: number;
  meanDiff: number;
  badPixels: number;
  bbox: [number, number, number, number] | null;
  detail: string;
  images?: { ref: string; cand: string; diff: string };
  ms: number;
}

// ───────────────────────────── 渲染器

/**
 * 每一侧只建一个渲染器,且两侧在不同的 iframe 里跑:Pixi 有模块级单例(批处理着色器的纹理槽数等),
 * 同页两个渲染器会互相覆盖,和真实游戏(只有一个渲染器)的环境不一样。
 */
export interface SideRenderer {
  side: 'gl' | 'gpu';
  renderer: Renderer;
  rhi: RhiDevice | null;
}

export async function createSideRenderer(side: 'gl' | 'gpu'): Promise<SideRenderer> {
  if (side === 'gl') {
    const renderer = await autoDetectRenderer({ preference: 'webgl', width: 16, height: 16, antialias: false, resolution: 1, backgroundAlpha: 0 });
    if (renderer.type !== 1 /* RendererType.WEBGL */) throw new Error(`参考渲染器不是 WebGL(type=${renderer.type})`);
    return { side, renderer, rhi: null };
  }
  const rhiCanvas = document.createElement('canvas');
  rhiCanvas.width = 16;
  rhiCanvas.height = 16;
  const rhi = await createRhiDevice({ canvas: rhiCanvas, useDevicePixels: false, autoResize: false });
  // 与游戏切换后一致:建 WebGPU 渲染器前装上 Pixi 补丁(目标格式进管线)
  installPixiWebGpuPatches();
  const renderer = await autoDetectRenderer({
    preference: 'webgpu',
    width: 16,
    height: 16,
    antialias: false,
    resolution: 1,
    backgroundAlpha: 0,
    // 与 RHI 共用同一个 GPUDevice:迁移后的结构就是这样
    webgpu: { gpu: { adapter: rhi.native.adapter, device: rhi.native.device } } as never,
  });
  if (renderer.type !== 2 /* RendererType.WEBGPU */) throw new Error(`候选渲染器不是 WebGPU(type=${renderer.type})`);
  if ((renderer as unknown as { gpu: { device: GPUDevice } }).gpu.device !== rhi.native.device) {
    throw new Error('Pixi WebGPU 渲染器没有用上 RHI 的 GPUDevice');
  }
  return { side, renderer, rhi };
}

// ───────────────────────────── 输入

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

function toHalf(v: number): number {
  const f32 = new Float32Array([v]);
  const u32 = new Uint32Array(f32.buffer)[0];
  const sign = (u32 >>> 16) & 0x8000;
  let exp = ((u32 >>> 23) & 0xff) - 127 + 15;
  let mant = u32 & 0x7fffff;
  if (exp <= 0) {
    if (exp < -10) return sign;
    mant = (mant | 0x800000) >>> (1 - exp);
    return sign | ((mant + 0x1000) >>> 13);
  }
  if (exp >= 31) return sign | 0x7c00;
  const h = sign | (exp << 10) | ((mant + 0x1000) >>> 13);
  return h;
}

export function fromHalf(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >>> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

function makeEnv(sr: SideRenderer): ParityEnv {
  const { side, renderer } = sr;
  return {
    side,
    renderer,
    async readTexture(texture: Texture, target: ParityTarget): Promise<Float32Array> {
      const rt = texture as RenderTexture;
      return side === 'gl' ? readGl(renderer as WebGLRenderer, rt, target) : readGpu(sr.rhi!, renderer, rt, target);
    },
    rng: mulberry32,
    dataTexture(o: DataTextureOptions): Texture {
      const format = o.format ?? 'rgba8unorm';
      const channels = format === 'r8unorm' ? 1 : 4;
      const rng = mulberry32(o.seed);
      const n = o.width * o.height * channels;
      const values = new Float32Array(n);
      for (let y = 0; y < o.height; y++) {
        for (let x = 0; x < o.width; x++) {
          for (let c = 0; c < channels; c++) {
            values[(y * o.width + x) * channels + c] = o.fill ? o.fill(x, y, c, rng) : rng();
          }
        }
      }
      let resource: Uint8Array | Uint16Array | Float32Array;
      if (format === 'rgba8unorm' || format === 'r8unorm') {
        resource = new Uint8Array(n);
        for (let i = 0; i < n; i++) resource[i] = Math.max(0, Math.min(255, Math.round(values[i] * 255)));
      } else if (format === 'rgba16float') {
        resource = new Uint16Array(n);
        for (let i = 0; i < n; i++) resource[i] = toHalf(values[i]);
      } else {
        resource = values;
      }
      const source = new BufferImageSource({
        resource,
        width: o.width,
        height: o.height,
        format,
        alphaMode: o.alphaMode ?? 'no-premultiply-alpha',
        scaleMode: o.scaleMode ?? 'nearest',
        addressMode: o.addressMode ?? 'clamp-to-edge',
      });
      return new Texture({ source });
    },
  };
}

// ───────────────────────────── 回读

function readGl(renderer: WebGLRenderer, rt: RenderTexture, target: ParityTarget): Float32Array {
  const { width, height } = rt.source;
  const gl = renderer.gl;
  // 让 Pixi 自己绑上这张 RT 的帧缓冲(它有状态缓存,手绑会和它打架)
  renderer.renderTarget.bind(rt, false);
  const out = new Float32Array(width * height * 4);
  if (target === 'rgba8unorm') {
    const u8 = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, u8);
    for (let i = 0; i < u8.length; i++) out[i] = u8[i] / 255;
  } else {
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, out);
  }
  return out;
}

async function readGpu(rhi: RhiDevice, renderer: Renderer, rt: RenderTexture, target: ParityTarget): Promise<Float32Array> {
  const gpuTexture = (renderer as unknown as { texture: { getGpuSource(s: unknown): GPUTexture } }).texture.getGpuSource(rt.source);
  // 经 RHI 互通口包成 RHI 纹理再回读 —— 顺带验证互通口
  const scope = rhi.createScope('对照回读');
  try {
    const tex = rhi.native.wrapTexture(scope, { label: '对照目标', texture: gpuTexture });
    const rb = await rhi.readTexture(tex);
    const { width, height } = rb;
    const out = new Float32Array(width * height * 4);
    if (target === 'rgba8unorm') {
      for (let i = 0; i < out.length; i++) out[i] = rb.data[i] / 255;
      // 没指定格式的 Pixi 渲染目标缺省是 bgra8unorm:WebGPU 显存里真是 BGRA 字节序(WebGL 侧照样存 RGBA),
      // 回读按存储格式换回 RGBA 再比
      if (rb.format === 'bgra8unorm') {
        for (let i = 0; i < out.length; i += 4) {
          const b = out[i];
          out[i] = out[i + 2];
          out[i + 2] = b;
        }
      }
    } else if (target === 'rgba16float') {
      const u16 = new Uint16Array(rb.data.buffer, rb.data.byteOffset, rb.data.byteLength / 2);
      for (let i = 0; i < out.length; i++) out[i] = fromHalf(u16[i]);
    } else {
      out.set(new Float32Array(rb.data.buffer, rb.data.byteOffset, out.length));
    }
    return out;
  } finally {
    scope.destroy();
  }
}

export interface SideOutput {
  name: string;
  data: Float32Array | null;
  error: string | null;
  warnings: string[];
}

/** 在本侧把一个用例画出来并回读(每侧的 iframe 里调用) */
export async function renderSide(sr: SideRenderer, c: ParityCase): Promise<SideOutput> {
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
  try {
    const env = makeEnv(sr);
    if (c.produce) return { name: c.name, data: await c.produce(env), error: null, warnings };
    const target = c.target ?? 'rgba8unorm';
    const root = await c.build(env);
    const rt = RenderTexture.create({ width: c.width, height: c.height, format: target, resolution: 1, antialias: false });
    try {
      const frames = c.frames ?? 1;
      for (let f = 0; f < frames; f++) {
        c.beforeFrame?.(env, root, f);
        sr.renderer.render({ container: root, target: rt, clear: true, clearColor: c.clearColor ?? [0, 0, 0, 0] });
      }
      const data = sr.side === 'gl'
        ? readGl(sr.renderer as WebGLRenderer, rt, target)
        : await readGpu(sr.rhi!, sr.renderer, rt, target);
      return { name: c.name, data, error: null, warnings };
    } finally {
      root.destroy({ children: true });
      rt.destroy(true);
    }
  } catch (e) {
    return { name: c.name, data: null, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e), warnings };
  } finally {
    console.warn = origWarn;
    console.error = origError;
  }
}

// ───────────────────────────── 比较

export function compare(ref: Float32Array, cand: Float32Array, width: number, height: number, tolerance: number) {
  let maxDiff = 0;
  let sum = 0;
  let bad = 0;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      let px = 0;
      for (let c = 0; c < 4; c++) {
        const a = ref[i + c];
        const b = cand[i + c];
        const d = Number.isNaN(a) || Number.isNaN(b) ? (Number.isNaN(a) && Number.isNaN(b) ? 0 : Infinity) : Math.abs(a - b);
        px = Math.max(px, d);
        sum += Number.isFinite(d) ? d : 1;
      }
      maxDiff = Math.max(maxDiff, px);
      if (px > tolerance) {
        bad++;
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
    }
  }
  return {
    maxDiff,
    meanDiff: sum / (width * height * 4),
    badPixels: bad,
    bbox: bad ? ([x0, y0, x1, y1] as [number, number, number, number]) : null,
  };
}

function toDataUrl(data: Float32Array, width: number, height: number, map: (v: number, c: number) => number): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(width, height);
  for (let i = 0; i < data.length; i++) img.data[i] = Math.max(0, Math.min(255, Math.round(map(data[i], i % 4) * 255)));
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL();
}

function diffImage(ref: Float32Array, cand: Float32Array, tolerance: number): Float32Array {
  const out = new Float32Array(ref.length);
  for (let i = 0; i < ref.length; i += 4) {
    let d = 0;
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(ref[i + c] - cand[i + c]) || 0);
    out[i] = d > tolerance ? 1 : Math.min(1, d / Math.max(tolerance, 1e-6));
    out[i + 1] = d > tolerance ? 0 : 0.2;
    out[i + 2] = 0;
    out[i + 3] = 1;
  }
  return out;
}

// ───────────────────────────── 两侧结果比较

export function judge(c: ParityCase, ref: SideOutput, cand: SideOutput, ms: number, withImages: boolean): ParityResult {
  const base = { name: c.name, maxDiff: 0, meanDiff: 0, badPixels: 0, bbox: null, ms };
  if (ref.error || !ref.data) {
    return { ...base, status: 'error', detail: `参考(WebGL)出错:${ref.error}\n${ref.warnings.slice(0, 6).join('\n')}` };
  }
  if (cand.error || !cand.data) {
    return { ...base, status: 'error', detail: `候选(WebGPU)出错:${cand.error}\n${cand.warnings.slice(0, 6).join('\n')}` };
  }
  if (ref.data.length !== cand.data.length) {
    return { ...base, status: 'error', detail: `两侧结果长度不同:${ref.data.length} ≠ ${cand.data.length}` };
  }
  const s = compare(ref.data, cand.data, c.width, c.height, c.tolerance);
  const pass = s.badPixels <= (c.maxBadPixels ?? 0);
  const float = (c.target ?? 'rgba8unorm') !== 'rgba8unorm';
  const show = (v: number, ch: number) => (ch === 3 && float ? 1 : v);
  return {
    ...base,
    ...s,
    status: pass ? 'pass' : 'fail',
    detail: [
      `最大差 ${s.maxDiff.toPrecision(3)} / 平均差 ${s.meanDiff.toPrecision(3)} / 超容差(${c.tolerance})像素 ${s.badPixels}` +
        (s.bbox ? ` 范围 [${s.bbox.join(',')}]` : ''),
      ...cand.warnings.slice(0, 6).map((w) => `候选告警:${w}`),
    ].join('\n'),
    images: withImages
      ? {
          ref: toDataUrl(ref.data, c.width, c.height, show),
          cand: toDataUrl(cand.data, c.width, c.height, show),
          diff: toDataUrl(diffImage(ref.data, cand.data, c.tolerance), c.width, c.height, (v) => v),
        }
      : undefined,
  };
}
