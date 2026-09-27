/**
 * 工作台 RHI 接入层 · 光照体实验室的环境 FX(命名空间 `lightvolFx`,`tools/lightvolume_lab` 的包里用)。
 *
 * 光照体实验室的「环境 FX — 2D 近似」(高度雾、流体体积雾、体积光、积水倒影、积雪 / 脚印)游戏里没有对应效果——
 * 它按已废除的拟合地面 floor_depth_A/B 算——所以这套画法归接入层所有:**着色器只有一份**(`lightvolFx.wgsl`,由迁移前页面
 * 内联的四段 GLSL 逐句搬来),页面不写任何 GLSL / WGSL、不碰图形 API。走游戏同一套 RHI(只有 WebGPU,不回落)。
 *
 *   const fx = await rt.lightvolFx.createLightVolFx(canvas);         // 拿不到 WebGPU 就抛错(带人话原因)
 *   await fx.setScene({ bg, depth, simSize: [220, 140] });           // 原画 / 深度图的 RGBA 字节(不预乘,第 0 行 = 图顶)
 *   fx.simStep(sim, calib);  fx.stamp(uv, r);  fx.paint(uv, r, 0.5, erase);  fx.composite(comp, calib);
 *
 * 与迁移前一一对应(页面 `index.html` 的 FX 段):
 * - 渲染目标:雾 ×2(乒乓,220 × h,清成 (0.5, 0.5, 0, 1) = 速度中性)、脚印 / 湿度(画布尺寸,清成黑),全是 rgba8unorm + 线性 + 夹边;
 * - SIM:读 fog[cur] 写 fog[cur ^ 1] 再换;STAMP:加性混合进脚印图;PAINT:加性 / 反向减(擦)混合进湿度图;COMP:画到画布;
 * - 一份模块一份绑定布局(RHI 按整个模块推布局):每个 pass 用不到、且正在被它写的那张图,绑 1×1 占位图(WebGPU 不许同一 pass
 *   里一张图既当附件又被绑来采样)。
 * - 每个操作是一次独立提交(STAMP / PAINT 在指针事件里调,不在帧里);统一数据每个操作各一块缓冲,录制前写好。
 * - 回读:画布同 CanvasHost(同一个任务里把上一次合成重画一遍再 drawImage);渲染目标走 `rhi.readTexture`(异步)。
 */
import {
  RhiBlend,
  RhiBufferUsage,
  RhiTextureUsage,
  createRhiDevice,
  type RhiBlendState,
  type RhiBuffer,
  type RhiDevice,
  type RhiRenderPipeline,
  type RhiRenderTarget,
  type RhiResourceScope,
  type RhiSampler,
  type RhiTexture,
  type RhiTextureReadback,
} from '../../src/rendering/rhi';
import LIGHTVOL_FX_WGSL from './lightvolFx.wgsl?raw';

export { LIGHTVOL_FX_WGSL };

type V3 = ArrayLike<number>;

/** 标定(= 页面 `buildCfg` 的那些字段;floorA / floorB 缺 = NaN,与迁移前 uniform1f(undefined) 相同) */
export interface LvCalib {
  W: number; H: number; wtpX: number; wtpY: number;
  ppu: number; cx: number; cy: number; invert: number;
  scale: number; offset: number; floorA?: number; floorB?: number;
  right: V3; up: V3; vd: V3;
}

/** COMP 的参数(与迁移前 composite() 设的 uniform 同名同义;开关 0 / 1) */
export interface LvCompParams {
  enHFog: number; enVFog: number; enGod: number; enPud: number; enSnow: number; enFoot: number;
  time: number; dbg: number;
  fogCol: V3; fogD: number; fogH: number; snowCol: V3; skyCol: V3; godInt: number;
  lightW: V3; shadowDist: number; shadowSteps: number;
  pudAmt: number; pudRefl: number; snowAmt: number; snowUp: number;
  ripple: number; ssrDist: number; reflMinH: number; ssrSteps: number;
  charShow: V3;
}

/** SIM 的参数(与迁移前 simStep() 同名同义) */
export interface LvSimParams {
  time: number; dt: number; flow: number; dissip: number; src: number; carveR: number; vort: number;
  charUv: V3; charVel: V3;
}

export interface LvImage {
  width: number;
  height: number;
  /** RGBA8,不预乘,第 0 行 = 图顶 */
  data: Uint8Array | Uint8ClampedArray;
}

/** 统一数据的 float 个数(19 个 vec4,顺序见 lightvolFx.wgsl 的 struct U) */
export const LV_UNIFORM_FLOATS = 76;

const n = (v: number | undefined): number => (v === undefined || v === null ? NaN : Number(v));

/**
 * 装一块统一数据。`comp` / `sim` / `brush` 缺的段填 0(那个 pass 不读)。纯函数,单测直接测。
 * `brush` = STAMP / PAINT 的 [半径, 强度, 中心 x, 中心 y]。
 */
export function packUniforms(cal: LvCalib, comp?: LvCompParams | null, sim?: LvSimParams | null, brush?: ArrayLike<number> | null): Float32Array {
  const f = new Float32Array(LV_UNIFORM_FLOATS);
  const put = (i: number, a: number, b: number, c: number, d: number) => { f[i] = a; f[i + 1] = b; f[i + 2] = c; f[i + 3] = d; };
  put(0, cal.W, cal.H, cal.wtpX, cal.wtpY);
  put(4, cal.ppu, cal.cx, cal.cy, cal.invert);
  put(8, cal.scale, cal.offset, n(cal.floorA), n(cal.floorB));
  put(12, cal.right[0], cal.right[1], cal.right[2], 0);
  put(16, cal.up[0], cal.up[1], cal.up[2], 0);
  put(20, cal.vd[0], cal.vd[1], cal.vd[2], 0);
  if (comp) {
    put(24, comp.enHFog, comp.enVFog, comp.enGod, comp.enPud);
    put(28, comp.enSnow, comp.enFoot, comp.time, comp.dbg);
    put(32, comp.fogCol[0], comp.fogCol[1], comp.fogCol[2], comp.fogD);
    put(36, comp.snowCol[0], comp.snowCol[1], comp.snowCol[2], comp.fogH);
    put(40, comp.skyCol[0], comp.skyCol[1], comp.skyCol[2], comp.godInt);
    put(44, comp.lightW[0], comp.lightW[1], comp.lightW[2], comp.shadowDist);
    put(48, comp.pudAmt, comp.pudRefl, comp.snowAmt, comp.snowUp);
    put(52, comp.ripple, comp.ssrDist, comp.reflMinH, Math.round(comp.ssrSteps));
    put(56, comp.charShow[0], comp.charShow[1], Math.round(comp.shadowSteps), 0);
  }
  if (sim) {
    f[30] = sim.time;
    put(60, sim.dt, sim.flow, sim.dissip, sim.src);
    put(64, sim.carveR, sim.vort, sim.charUv[0], sim.charUv[1]);
    put(68, sim.charVel[0], sim.charVel[1], 0, 0);
  }
  if (brush) {
    f[70] = brush[0];
    f[71] = brush[1];
    put(72, brush[2], brush[3], 0, 0);
  }
  return f;
}

/** 擦湿度:dst − src(GL 的 blendEquation(FUNC_REVERSE_SUBTRACT) + blendFunc(ONE, ONE),颜色与 alpha 同) */
export const BLEND_ERASE: RhiBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one', operation: 'reverse-subtract' },
  alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'reverse-subtract' },
};

export class LightVolFxError extends Error {
  constructor(message: string, readonly reason: 'no-webgpu' | 'no-adapter' | 'device' | 'other') {
    super(message);
    this.name = 'LightVolFxError';
  }
}

interface Rt { tex: RhiTexture; target: RhiRenderTarget; w: number; h: number }
interface Gpu {
  scope: RhiResourceScope;
  sampler: RhiSampler;
  dummy: RhiTexture;
  bg: RhiTexture;
  depth: RhiTexture;
  fog: [Rt, Rt];
  foot: Rt;
  wet: Rt;
  pipes: { comp: RhiRenderPipeline; sim: RhiRenderPipeline; stamp: RhiRenderPipeline; paintAdd: RhiRenderPipeline; paintErase: RhiRenderPipeline };
  ub: { comp: RhiBuffer; sim: RhiBuffer; stamp: RhiBuffer; paint: RhiBuffer };
}

export interface LvSceneInput {
  bg: LvImage;
  depth: LvImage;
  /** 雾模拟分辨率(迁移前 220 × max(60, 220·bgH / bgW)) */
  simSize: [number, number];
}

const RT_USAGE = RhiTextureUsage.RENDER_TARGET | RhiTextureUsage.SAMPLED | RhiTextureUsage.COPY_SRC;

/** 一块画布上的环境 FX:自己的 RHI 设备 + 这份着色器 + 渲染目标 */
export class LightVolFx {
  lastError = '';
  /** 当前的雾(乒乓下标) */
  cur = 0;
  private gpu: Gpu | null = null;
  private building: Promise<void> | null = null;
  private scene: LvSceneInput | null = null;
  private swapW = 0;
  private swapH = 0;
  private lastComposite: { comp: LvCompParams; cal: LvCalib } | null = null;
  private readCanvas: HTMLCanvasElement | null = null;
  private readonly offs: (() => void)[] = [];
  private destroyed = false;

  /** `canvas` = 画布(null = 空后端单测,合成只画到交换链) */
  constructor(readonly rhi: RhiDevice, readonly canvas: HTMLCanvasElement | null) {
    this.offs.push(rhi.onDiagnostic((err, severity) => {
      if (severity === 'error') this.lastError = err.message;
    }));
    // 设备恢复:GPU 资源全部作废;原画 / 深度从 CPU 源重建,渲染目标里画过的(雾 / 脚印 / 湿度)没了——同 WebGL 上下文丢失
    this.offs.push(rhi.onRestored(() => {
      this.gpu = null;
      this.swapW = 0;
      this.swapH = 0;
      if (this.scene) void this.build(this.scene);
    }));
  }

  /** 场景已装、管线都编好了 */
  get ready(): boolean {
    return !!this.gpu && !this.building;
  }

  /** 雾模拟的尺寸 */
  get simSize(): [number, number] {
    return this.scene ? [this.scene.simSize[0], this.scene.simSize[1]] : [0, 0];
  }

  /** 装场景:传原画 / 深度图、建渲染目标并清好、等管线编完(之后的每一步都不会因为管线没好被跳过) */
  async setScene(input: LvSceneInput): Promise<void> {
    this.scene = input;
    await this.build(input);
  }

  private async build(input: LvSceneInput): Promise<void> {
    const task = (async () => {
      const old = this.gpu;
      this.gpu = null;
      old?.scope.destroy();
      const rhi = this.rhi;
      const scope = rhi.createScope('光照体 FX');
      const sampler = scope.createSampler({ label: '光照体 FX · 线性夹边', magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
      const img = (label: string, im: LvImage) => scope.createTexture({
        label, width: im.width, height: im.height, format: 'rgba8unorm', usage: RhiTextureUsage.SAMPLED | RhiTextureUsage.COPY_DST,
        data: im.data instanceof Uint8Array ? im.data : new Uint8Array(im.data.buffer, im.data.byteOffset, im.data.byteLength),
      });
      const dummy = scope.createTexture({ label: '光照体 FX · 占位', width: 1, height: 1, format: 'rgba8unorm', usage: RhiTextureUsage.SAMPLED, data: new Uint8Array([0, 0, 0, 255]) });
      const rtOf = (label: string, w: number, h: number): Rt => {
        const tex = scope.createTexture({ label, width: w, height: h, format: 'rgba8unorm', usage: RT_USAGE });
        return { tex, target: scope.createRenderTarget({ label, colors: [tex] }), w, h };
      };
      const [sw, sh] = input.simSize;
      const cw = Math.max(1, this.canvas?.width ?? input.bg.width);
      const ch = Math.max(1, this.canvas?.height ?? input.bg.height);
      const swapFormat = rhi.caps.swapchainFormat;
      const pipe = (label: string, fs: string, format: typeof swapFormat, blend: RhiBlendState | null) => scope.createRenderPipeline({
        label: `光照体 FX · ${label}`,
        shader: scope.createShader({ label: `光照体 FX · ${label}`, wgsl: LIGHTVOL_FX_WGSL, entryPoints: { vertex: 'vs', fragment: fs } }),
        colorFormats: [format], blend, cullMode: 'none',
      });
      const ubuf = (label: string) => scope.createBuffer({ label: `光照体 FX · ${label} 统一数据`, usage: RhiBufferUsage.UNIFORM | RhiBufferUsage.COPY_DST, size: LV_UNIFORM_FLOATS * 4 });
      const gpu: Gpu = {
        scope, sampler, dummy,
        bg: img('光照体 FX · 原画', input.bg),
        depth: img('光照体 FX · 深度', input.depth),
        fog: [rtOf('光照体 FX · 雾 0', sw, sh), rtOf('光照体 FX · 雾 1', sw, sh)],
        foot: rtOf('光照体 FX · 脚印', cw, ch),
        wet: rtOf('光照体 FX · 湿度', cw, ch),
        pipes: {
          comp: pipe('合成', 'fsComp', swapFormat, null),
          sim: pipe('雾模拟', 'fsSim', 'rgba8unorm', null),
          stamp: pipe('脚印', 'fsStamp', 'rgba8unorm', RhiBlend.additive),
          paintAdd: pipe('画积水', 'fsPaint', 'rgba8unorm', RhiBlend.additive),
          paintErase: pipe('擦积水', 'fsPaint', 'rgba8unorm', BLEND_ERASE),
        },
        ub: { comp: ubuf('合成'), sim: ubuf('雾模拟'), stamp: ubuf('脚印'), paint: ubuf('积水笔刷') },
      };
      await Promise.all(Object.values(gpu.pipes).map((p) => p.ready));
      this.gpu = gpu;
      this.cur = 0;
      this.clear(gpu.fog[0], [0.5, 0.5, 0, 1]);
      this.clear(gpu.fog[1], [0.5, 0.5, 0, 1]);
      this.clear(gpu.foot, [0, 0, 0, 1]);
      this.clear(gpu.wet, [0, 0, 0, 1]);
    })();
    this.building = task;
    try {
      await task;
    } finally {
      if (this.building === task) this.building = null;
    }
  }

  private clear(r: Rt, color: [number, number, number, number]): boolean {
    return this.rhi.submit('光照体 FX · 清', (c) => {
      c.beginRenderPass({ label: '光照体 FX · 清', target: r.target, colorOps: [{ load: 'clear', clearValue: color }] }).end();
    });
  }

  /** 脚印图清空(迁移前 clearRT(foot)) */
  clearFoot(): boolean {
    return !!this.gpu && this.clear(this.gpu.foot, [0, 0, 0, 1]);
  }

  /** 湿度图清空 */
  clearWet(): boolean {
    return !!this.gpu && this.clear(this.gpu.wet, [0, 0, 0, 1]);
  }

  private bindings(g: Gpu, ub: RhiBuffer, over: Partial<Record<'uFog' | 'uFoot' | 'uWet' | 'uPrev', RhiTexture>> = {}) {
    return {
      u: ub, uBg: g.bg, uDepth: g.depth,
      uFog: over.uFog ?? g.fog[this.cur].tex, uFoot: over.uFoot ?? g.foot.tex, uWet: over.uWet ?? g.wet.tex,
      uPrev: over.uPrev ?? g.dummy, uLinear: g.sampler,
    };
  }

  private offscreen(label: string, r: Rt, pipe: RhiRenderPipeline, bindings: ReturnType<LightVolFx['bindings']>): boolean {
    return this.rhi.submit(`光照体 FX · ${label}`, (c) => {
      const p = c.beginRenderPass({ label: `光照体 FX · ${label}`, target: r.target, colorOps: [{ load: 'load' }] });
      p.setPipeline(pipe);
      p.setBindings(bindings);
      p.draw(3);
      p.end();
    });
  }

  /** 雾模拟一步:读 fog[cur] 写 fog[cur ^ 1],再换 */
  simStep(sim: LvSimParams, cal: LvCalib): boolean {
    const g = this.gpu;
    if (!g || this.destroyed) return false;
    const src = g.fog[this.cur], dst = g.fog[this.cur ^ 1];
    this.rhi.writeBuffer(g.ub.sim, packUniforms(cal, null, sim, null));
    const ok = this.offscreen('雾模拟', dst, g.pipes.sim, this.bindings(g, g.ub.sim, { uPrev: src.tex, uFog: g.dummy }));
    if (ok) this.cur ^= 1;
    return ok;
  }

  /** 脚印:以 uv(y 朝上,与画布事件换算一致)为心的高斯,加性写进脚印图 */
  stamp(uv: V3, r: number): boolean {
    const g = this.gpu;
    if (!g || this.destroyed) return false;
    this.rhi.writeBuffer(g.ub.stamp, packUniforms(ZERO_CAL, null, null, [r, 0, uv[0], uv[1]]));
    return this.offscreen('脚印', g.foot, g.pipes.stamp, this.bindings(g, g.ub.stamp, { uFoot: g.dummy }));
  }

  /** 积水笔刷:加性画 / 反向减擦 */
  paint(uv: V3, r: number, strength: number, erase: boolean): boolean {
    const g = this.gpu;
    if (!g || this.destroyed) return false;
    this.rhi.writeBuffer(g.ub.paint, packUniforms(ZERO_CAL, null, null, [r, strength, uv[0], uv[1]]));
    return this.offscreen(erase ? '擦积水' : '画积水', g.wet, erase ? g.pipes.paintErase : g.pipes.paintAdd,
      this.bindings(g, g.ub.paint, { uWet: g.dummy }));
  }

  /** 合成到画布(画布像素尺寸由页面管) */
  composite(comp: LvCompParams, cal: LvCalib): boolean {
    const g = this.gpu;
    if (!g || this.destroyed || this.rhi.isLost) return false;
    this.lastComposite = { comp, cal };
    const c = this.canvas;
    if (c) {
      if (c.width < 1 || c.height < 1) return false;
      if (c.width !== this.swapW || c.height !== this.swapH) {
        this.rhi.resizeSwapchain(c.width, c.height);
        this.swapW = c.width;
        this.swapH = c.height;
      }
    }
    this.rhi.writeBuffer(g.ub.comp, packUniforms(cal, comp, null, null));
    return this.rhi.runFrame((frame) => {
      const p = frame.commands.beginRenderPass({ label: '光照体 FX · 合成', target: frame.swapchain, colorOps: [{ load: 'clear', clearValue: [0, 0, 0, 1] }] });
      p.setPipeline(g.pipes.comp);
      p.setBindings(this.bindings(g, g.ub.comp));
      p.draw(3);
      p.end();
    });
  }

  /**
   * 回读画布(设备像素,自上而下 RGBA8):同一个任务里把上一次合成重画一遍再取(WebGPU 画布呈现后读不回来)。没合成过 = null。
   */
  readPixels(x = 0, y = 0, width?: number, height?: number): { width: number; height: number; data: Uint8ClampedArray } | null {
    const c = this.canvas;
    const last = this.lastComposite;
    if (!c || !last || !this.composite(last.comp, last.cal)) return null;
    const W = c.width, H = c.height;
    const w = Math.max(1, Math.min(width ?? W, W - x));
    const h = Math.max(1, Math.min(height ?? H, H - y));
    const rc = (this.readCanvas ??= document.createElement('canvas'));
    if (rc.width !== W) rc.width = W;
    if (rc.height !== H) rc.height = H;
    const ctx = rc.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(c, 0, 0);
    return { width: w, height: h, data: ctx.getImageData(x, y, w, h).data };
  }

  /** 回读一张渲染目标(异步):'fog' = 当前的雾 */
  async readTarget(which: 'fog' | 'foot' | 'wet'): Promise<RhiTextureReadback | null> {
    const g = this.gpu;
    if (!g) return null;
    const r = which === 'fog' ? g.fog[this.cur] : which === 'foot' ? g.foot : g.wet;
    return this.rhi.readTexture(r.tex);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const off of this.offs) off();
    this.gpu?.scope.destroy();
    this.gpu = null;
  }
}

/** STAMP / PAINT 不读标定:占位 */
const ZERO_CAL: LvCalib = { W: 0, H: 0, wtpX: 0, wtpY: 0, ppu: 0, cx: 0, cy: 0, invert: 0, scale: 0, offset: 0, floorA: 0, floorB: 0, right: [0, 0, 0], up: [0, 0, 0], vd: [0, 0, 0] };

/** 这个宿主拿不拿得到 WebGPU:拿得到返回 '',否则返回人话原因(不建设备) */
export async function probeWebGpu(): Promise<string> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return '这个窗口没有 WebGPU(navigator.gpu 不存在)';
  try {
    const adapter = await gpu.requestAdapter();
    return adapter ? '' : '这个窗口拿不到 WebGPU 适配器(显卡 / 驱动 / 宿主参数不支持)';
  } catch (e) {
    return `WebGPU 适配器请求失败:${(e as Error)?.message ?? e}`;
  }
}

/** 在画布上建 FX(自己一台 RHI 设备);拿不到 WebGPU 抛 LightVolFxError(带人话原因) */
export async function createLightVolFx(canvas: HTMLCanvasElement): Promise<LightVolFx> {
  const why = await probeWebGpu();
  if (why) throw new LightVolFxError(why, (navigator as { gpu?: unknown }).gpu ? 'no-adapter' : 'no-webgpu');
  if (canvas.width < 1) canvas.width = 1;
  if (canvas.height < 1) canvas.height = 1;
  let rhi: RhiDevice;
  try {
    rhi = await createRhiDevice({ canvas, alphaMode: 'opaque', useDevicePixels: false, autoResize: false });
  } catch (e) {
    throw new LightVolFxError(`WebGPU 设备建不起来:${(e as Error)?.message ?? e}`, 'device');
  }
  const fx = new LightVolFx(rhi, canvas);
  const destroy = fx.destroy.bind(fx);
  fx.destroy = () => {
    destroy();
    rhi.destroy();
  };
  return fx;
}
