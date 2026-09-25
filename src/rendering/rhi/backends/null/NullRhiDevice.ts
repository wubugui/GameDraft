/**
 * 空后端:不碰 GPU,只把命令记进日志。给单元测试、无头逻辑跑用。
 *
 * 校验与真后端(LumaRhiDevice)逐条一致——用途位、已销毁资源、外来资源、pass 嵌套、格式 / 采样数匹配、上限、
 * 越界、录制期写入冲突、着色器要的绑定 / 顶点流 / 索引缓冲、画布后备缓冲只在帧内可用——这样上层在空后端上
 * 通过的用法,在真后端上也不会因为这些原因失败。着色器布局用 luma 同一个 WGSL 接口扫描器(真后端建管线时也靠它推布局)。
 * **不光栅化**:纹理内容无从得知,`readTexture` 直接报不支持;缓冲在 CPU 侧有一份,写入 / 缓冲间拷贝 / 回读是真的。
 *
 * 模拟建坏的管线:`failPipeline` 选项命中的管线 `ready` reject,录制时跳过它的 draw / dispatch(计入 skippedDraws、
 * 告警一次),与真后端确认管线建坏之后的行为相同。
 */
import { scanWGSLInterface } from '@luma.gl/shadertools/wgsl';
import type {
  RhiBindings,
  RhiBuffer,
  RhiCaps,
  RhiCommandList,
  RhiComputePassEncoder,
  RhiComputePipeline,
  RhiDevice,
  RhiDeviceInfo,
  RhiDiagnosticListener,
  RhiDiagnosticSeverity,
  RhiFrame,
  RhiFrameStats,
  RhiNativeInterop,
  RhiRenderPassEncoder,
  RhiRenderPipeline,
  RhiRenderTarget,
  RhiResourceFactory,
  RhiSampler,
  RhiShader,
  RhiTexture,
  RhiTextureReadback,
} from '../../RhiDevice';
import { RhiReleaseQueue, RhiResourceBase, RhiResourceScope } from '../../RhiResourceScope';
import {
  RhiBufferUsage,
  RhiError,
  RhiTextureUsage,
  isDepthFormat,
  type RhiBufferDesc,
  type RhiColorFormat,
  type RhiComputePipelineDesc,
  type RhiDepthFormat,
  type RhiImageSource,
  type RhiRenderPassDesc,
  type RhiRenderPipelineDesc,
  type RhiRenderTargetDesc,
  type RhiSamplerDesc,
  type RhiShaderDesc,
  type RhiTextureDesc,
  type RhiTextureFormat,
} from '../../types';
import { SAMPLER_SUFFIX, missingBindings, resolveShaderEntries, type RhiShaderEntries } from '../backendRules';

export interface NullRhiDeviceOptions {
  swapchainSize?: [number, number];
  /** 模拟建坏的管线:按管线标签判,返回 true 的管线 `ready` reject、draw / dispatch 被跳过 */
  failPipeline?: (label: string) => boolean;
  /** 设备的 2D 纹理尺寸上限(缺省 8192 = WebGPU 规范缺省;真设备按适配器要,桌面常见 16384) */
  maxTextureSize?: number;
}

class NullBuffer extends RhiResourceBase<'buffer'> implements RhiBuffer {
  readonly bytes: Uint8Array;
  constructor(scope: RhiResourceScope, releases: RhiReleaseQueue, desc: RhiBufferDesc, readonly size: number, private readonly log: string[]) {
    super('buffer', desc.label, scope, releases);
    this.bytes = new Uint8Array(size);
    if (desc.data) this.bytes.set(new Uint8Array(desc.data.buffer, desc.data.byteOffset, desc.data.byteLength));
    this.usage = desc.usage;
    this.indexFormat = desc.indexFormat;
  }
  readonly usage: number;
  readonly indexFormat?: 'uint16' | 'uint32';
  protected releaseBackend(): void {
    this.log.push(`release buffer ${this.label}`);
  }
}

class NullTexture extends RhiResourceBase<'texture'> implements RhiTexture {
  readonly width: number;
  readonly height: number;
  readonly format: RhiTextureFormat;
  readonly usage: number;
  readonly mipLevels: number;
  readonly sampleCount: number;
  constructor(scope: RhiResourceScope, releases: RhiReleaseQueue, desc: RhiTextureDesc, usage: number, private readonly log: string[]) {
    super('texture', desc.label, scope, releases);
    this.width = desc.width;
    this.height = desc.height;
    this.format = desc.format;
    this.usage = usage;
    this.mipLevels = desc.mipLevels ?? 1;
    this.sampleCount = desc.sampleCount ?? 1;
  }
  protected releaseBackend(): void {
    this.log.push(`release texture ${this.label}`);
  }
}

class NullSampler extends RhiResourceBase<'sampler'> implements RhiSampler {
  protected releaseBackend(): void {}
}

class NullShader extends RhiResourceBase<'shader'> implements RhiShader {
  constructor(scope: RhiResourceScope, releases: RhiReleaseQueue, label: string, readonly wgsl: string, readonly entryPoints: RhiShaderEntries) {
    super('shader', label, scope, releases);
  }
  get hasRender(): boolean {
    return this.entryPoints.vertex != null && this.entryPoints.fragment != null;
  }
  get hasCompute(): boolean {
    return this.entryPoints.compute != null;
  }
  protected releaseBackend(): void {}
}

/** 管线就绪状态:正常的立即就绪;模拟建坏的 `ready` reject、`failed` 为真 */
class NullPipelineState {
  readonly ready: Promise<void>;
  readonly isReady: boolean;
  constructor(label: string, readonly failed: boolean, onFail: (e: unknown) => void) {
    this.isReady = !failed;
    this.ready = failed ? Promise.reject(new RhiError('backend', `管线「${label}」创建 / 校验失败(空后端模拟)`)) : Promise.resolve();
    this.ready.catch(onFail);
  }
}

class NullRenderPipeline extends RhiResourceBase<'render-pipeline'> implements RhiRenderPipeline {
  constructor(
    scope: RhiResourceScope,
    releases: RhiReleaseQueue,
    label: string,
    readonly colorFormats: readonly RhiColorFormat[],
    readonly depthFormat: RhiDepthFormat | null,
    readonly streams: readonly string[],
    readonly sampleCount: number,
    /** 着色器声明的绑定名(与真后端同一扫描器得出) */
    readonly bindingNames: readonly string[],
    private readonly state: NullPipelineState,
  ) {
    super('render-pipeline', label, scope, releases);
  }
  get ready(): Promise<void> {
    return this.state.ready;
  }
  get isReady(): boolean {
    return this.state.isReady;
  }
  get failed(): boolean {
    return this.state.failed;
  }
  protected releaseBackend(): void {}
}

class NullComputePipeline extends RhiResourceBase<'compute-pipeline'> implements RhiComputePipeline {
  constructor(
    scope: RhiResourceScope,
    releases: RhiReleaseQueue,
    label: string,
    readonly bindingNames: readonly string[],
    private readonly state: NullPipelineState,
  ) {
    super('compute-pipeline', label, scope, releases);
  }
  get ready(): Promise<void> {
    return this.state.ready;
  }
  get isReady(): boolean {
    return this.state.isReady;
  }
  get failed(): boolean {
    return this.state.failed;
  }
  protected releaseBackend(): void {}
}

class NullRenderTarget extends RhiResourceBase<'render-target'> implements RhiRenderTarget {
  constructor(
    scope: RhiResourceScope,
    releases: RhiReleaseQueue,
    label: string,
    readonly width: number,
    readonly height: number,
    readonly colors: readonly NullTexture[],
    readonly depth: NullTexture | null,
    private readonly log: string[],
    private readonly samples?: number,
    /** 逐颜色附件的 resolve 目标(画布 MSAA 的 resolve 目标是这一帧的画布,记成 'canvas') */
    readonly resolves: readonly (NullTexture | 'canvas' | null)[] = [],
  ) {
    super('render-target', label, scope, releases);
  }
  get sampleCount(): number {
    return this.samples ?? (this.colors[0] ?? this.depth)?.sampleCount ?? 1;
  }
  get colorFormats(): readonly RhiColorFormat[] {
    return this.colors.map((c) => c.format as RhiColorFormat);
  }
  get depthFormat(): RhiDepthFormat | null {
    return (this.depth?.format as RhiDepthFormat | undefined) ?? null;
  }
  override assertAlive(usage: string): void {
    super.assertAlive(usage);
    for (const c of this.colors) c.assertAlive(`${usage}(渲染目标「${this.label}」的颜色附件)`);
    this.depth?.assertAlive(`${usage}(渲染目标「${this.label}」的深度附件)`);
    for (const r of this.resolves) if (r && r !== 'canvas') r.assertAlive(`${usage}(渲染目标「${this.label}」的 resolve 目标)`);
  }
  protected releaseBackend(): void {
    this.log.push(`release target ${this.label}`);
  }
}

class NullSwapchain extends NullRenderTarget {
  /** 只在 runFrame 的录制期内可用(同真后端) */
  armed = false;
  override destroy(): void {
    throw new RhiError('invalid-usage', '画布后备缓冲归设备所有,不能单独销毁');
  }
  override get colorFormats(): readonly RhiColorFormat[] {
    return ['bgra8unorm'];
  }
}

class NullCommandList implements RhiCommandList {
  private open: { end(): void } | null = null;
  readonly used = new Set<object>();
  constructor(private readonly device: NullRhiDevice, readonly label: string, private readonly stats: RhiFrameStats) {}

  beginRenderPass(desc: RhiRenderPassDesc): RhiRenderPassEncoder {
    this.assertClosed(`beginRenderPass「${desc.label}」`);
    if (!(desc.target instanceof NullRenderTarget)) throw new RhiError('invalid-usage', '渲染目标:不是本设备的渲染目标');
    const t = desc.target;
    t.assertAlive(`render pass「${desc.label}」的目标`);
    if (t instanceof NullSwapchain && !t.armed) throw new RhiError('invalid-usage', '画布后备缓冲只能在 runFrame 的录制期内使用');
    for (const c of t.colors) this.used.add(c);
    if (t.depth) this.used.add(t.depth);
    for (const r of t.resolves) if (r && r !== 'canvas') this.used.add(r);
    const colorOps = desc.colorOps ?? [];
    if (colorOps.length > t.colorFormats.length) {
      throw new RhiError('invalid-usage', `render pass「${desc.label}」给了 ${colorOps.length} 个颜色附件操作,目标只有 ${t.colorFormats.length} 个附件`);
    }
    this.stats.renderPasses++;
    const ops = t.colorFormats.map((_, i) => desc.colorOps?.[i]?.load ?? 'clear').join(',');
    const resolves = t.resolves.map((r) => (r === 'canvas' ? '画布' : r?.label ?? '-')).join(',');
    this.device.log.push(`begin render ${desc.label} -> ${t.label} [${ops}]${t.resolves.length ? ` resolve→${resolves}` : ''}`);
    let pipeline: NullRenderPipeline | null = null;
    let bindingsSet = false;
    const streams = new Map<string, NullBuffer>();
    let indexBuffer: NullBuffer | null = null;
    const requirePipeline = (what: string): NullRenderPipeline => {
      if (!pipeline) throw new RhiError('invalid-usage', `render pass「${desc.label}」${what}:还没 setPipeline`);
      pipeline.assertAlive(`render pass「${desc.label}」${what}`);
      return pipeline;
    };
    /** 管线建坏:跳过这次 draw;否则照真后端校验绑定 / 顶点流 / 索引 */
    const prepareDraw = (indexed: boolean): NullRenderPipeline | null => {
      const p = requirePipeline('draw');
      if (p.failed) {
        this.stats.skippedDraws++;
        this.device._warnSkippedDraw(p);
        this.device.log.push(`skip draw ${p.label}`);
        return null;
      }
      if (!bindingsSet && p.bindingNames.length > 0) {
        throw new RhiError('invalid-usage', `管线「${p.label}」需要资源绑定:setPipeline 之后先 setBindings 再 draw`);
      }
      for (const s of p.streams) {
        const b = streams.get(s);
        if (!b) throw new RhiError('invalid-usage', `管线「${p.label}」的顶点流「${s}」没绑定缓冲`);
        b.assertAlive(`顶点流「${s}」`);
      }
      if (indexed) {
        if (!indexBuffer) throw new RhiError('invalid-usage', `drawIndexed 之前没 setIndexBuffer(管线「${p.label}」)`);
        indexBuffer.assertAlive('索引缓冲');
      }
      return p;
    };
    const enc: RhiRenderPassEncoder = {
      setPipeline: (p) => {
        if (!(p instanceof NullRenderPipeline)) throw new RhiError('invalid-usage', `render pass「${desc.label}」setPipeline:不是本设备的渲染管线`);
        p.assertAlive('setPipeline');
        if (p.sampleCount !== t.sampleCount) {
          throw new RhiError('invalid-usage', `管线「${p.label}」的采样数 ${p.sampleCount} 与 render pass「${desc.label}」的目标(${t.sampleCount})不一致`);
        }
        const same = p.colorFormats.length === t.colorFormats.length && p.colorFormats.every((f, i) => f === t.colorFormats[i]);
        if (!same || p.depthFormat !== t.depthFormat) {
          throw new RhiError('invalid-usage', `管线「${p.label}」的目标格式与 render pass「${desc.label}」不一致`);
        }
        pipeline = p;
        bindingsSet = false;
      },
      setBindings: (b) => {
        const p = requirePipeline('setBindings');
        if (!p.failed) this.useBindings(p.bindingNames, b, `管线「${p.label}」`);
        bindingsSet = true;
      },
      setVertexBuffer: (name, b) => {
        const nb = asBuffer(b, `顶点流「${name}」`);
        if (!(nb.usage & RhiBufferUsage.VERTEX)) throw new RhiError('invalid-usage', `缓冲「${nb.label}」作顶点流需要 VERTEX`);
        this.used.add(nb);
        streams.set(name, nb);
      },
      setIndexBuffer: (b) => {
        if (b == null) {
          indexBuffer = null;
          return;
        }
        const nb = asBuffer(b, '索引缓冲');
        if (!(nb.usage & RhiBufferUsage.INDEX)) throw new RhiError('invalid-usage', `缓冲「${nb.label}」作索引需要 INDEX`);
        if (!nb.indexFormat) throw new RhiError('invalid-usage', `索引缓冲「${nb.label}」创建时没给 indexFormat`);
        this.used.add(nb);
        indexBuffer = nb;
      },
      setViewport: () => {},
      setScissor: () => {},
      setStencilReference: () => {},
      draw: (count) => {
        const p = prepareDraw(false);
        if (!p) return;
        this.stats.draws++;
        this.device.log.push(`draw ${p.label} ${count}`);
      },
      drawIndexed: (count) => {
        const p = prepareDraw(true);
        if (!p) return;
        this.stats.draws++;
        this.device.log.push(`drawIndexed ${p.label} ${count}`);
      },
      end: () => {
        if (this.open !== enc) return;
        this.open = null;
        this.device.log.push(`end render ${desc.label}`);
      },
    };
    this.open = enc;
    return enc;
  }

  beginComputePass(label: string): RhiComputePassEncoder {
    this.assertClosed(`beginComputePass「${label}」`);
    this.stats.computePasses++;
    this.device.log.push(`begin compute ${label}`);
    let pipeline: NullComputePipeline | null = null;
    let bindingsSet = false;
    const enc: RhiComputePassEncoder = {
      setPipeline: (p) => {
        if (!(p instanceof NullComputePipeline)) throw new RhiError('invalid-usage', `compute pass「${label}」setPipeline:不是本设备的计算管线`);
        p.assertAlive('setPipeline');
        pipeline = p;
        bindingsSet = false;
      },
      setBindings: (b) => {
        if (!pipeline) throw new RhiError('invalid-usage', `compute pass「${label}」setBindings:还没 setPipeline`);
        if (!pipeline.failed) this.useBindings(pipeline.bindingNames, b, `管线「${pipeline.label}」`);
        bindingsSet = true;
      },
      dispatch: (x, y = 1, z = 1) => {
        if (!pipeline) throw new RhiError('invalid-usage', `compute pass「${label}」dispatch:还没 setPipeline`);
        pipeline.assertAlive(`compute pass「${label}」dispatch`);
        if (pipeline.failed) {
          this.device._warnSkippedDraw(pipeline);
          this.device.log.push(`skip dispatch ${pipeline.label}`);
          return;
        }
        if (!bindingsSet && pipeline.bindingNames.length > 0) {
          throw new RhiError('invalid-usage', `管线「${pipeline.label}」需要资源绑定:setPipeline 之后先 setBindings 再 dispatch`);
        }
        this.stats.dispatches++;
        this.device.log.push(`dispatch ${pipeline.label} ${x}x${y}x${z}`);
      },
      end: () => {
        if (this.open !== enc) return;
        this.open = null;
        this.device.log.push(`end compute ${label}`);
      },
    };
    this.open = enc;
    return enc;
  }

  copyBufferToBuffer(src: RhiBuffer, srcOffset: number, dst: RhiBuffer, dstOffset: number, size: number): void {
    this.assertClosed('copyBufferToBuffer');
    const s = asBuffer(src, 'copyBufferToBuffer 源');
    const d = asBuffer(dst, 'copyBufferToBuffer 目标');
    if (!(s.usage & RhiBufferUsage.COPY_SRC)) throw new RhiError('invalid-usage', `缓冲「${s.label}」作拷贝源需要 COPY_SRC`);
    if (!(d.usage & RhiBufferUsage.COPY_DST)) throw new RhiError('invalid-usage', `缓冲「${d.label}」作拷贝目标需要 COPY_DST`);
    this.used.add(s);
    this.used.add(d);
    if (srcOffset < 0 || dstOffset < 0 || srcOffset + size > s.size || dstOffset + size > d.size) {
      throw new RhiError('invalid-usage', `copyBufferToBuffer 越界:源「${s.label}」[${srcOffset}, +${size}) / 目标「${d.label}」[${dstOffset}, +${size})`);
    }
    d.bytes.set(s.bytes.subarray(srcOffset, srcOffset + size), dstOffset);
    this.device.log.push(`copy buffer ${s.label} -> ${d.label}`);
  }

  copyTextureToTexture(src: RhiTexture, dst: RhiTexture, width?: number, height?: number): void {
    this.assertClosed('copyTextureToTexture');
    const s = asTexture(src, 'copyTextureToTexture 源');
    const d = asTexture(dst, 'copyTextureToTexture 目标');
    if (!(s.usage & RhiTextureUsage.COPY_SRC)) throw new RhiError('invalid-usage', `纹理「${s.label}」作拷贝源需要 COPY_SRC`);
    if (!(d.usage & RhiTextureUsage.COPY_DST)) throw new RhiError('invalid-usage', `纹理「${d.label}」作拷贝目标需要 COPY_DST`);
    this.used.add(s);
    this.used.add(d);
    const w = width ?? s.width;
    const h = height ?? s.height;
    if (w > s.width || h > s.height || w > d.width || h > d.height) {
      throw new RhiError('invalid-usage', `copyTextureToTexture 越界:${w}×${h},源「${s.label}」${s.width}×${s.height},目标「${d.label}」${d.width}×${d.height}`);
    }
    if (s.format !== d.format) {
      throw new RhiError('invalid-usage', `copyTextureToTexture 格式不同:「${s.label}」${s.format} → 「${d.label}」${d.format}`);
    }
    this.device.log.push(`copy texture ${s.label} -> ${d.label}`);
  }

  pushDebugGroup(label: string): void {
    this.device.log.push(`push ${label}`);
  }

  popDebugGroup(): void {
    this.device.log.push('pop');
  }

  finish(): void {
    this.assertClosed(`提交「${this.label}」`);
  }

  /**
   * 照真后端解析绑定:只看着色器声明了的名字(没声明的忽略);缺项 / 已销毁 / 外来资源当场报;
   * 「纹理名Sampler」在纹理给了时随纹理走。登记本批引用(录制期写入冲突检查用)。
   */
  private useBindings(declared: readonly string[], b: RhiBindings, where: string): void {
    for (const name of declared) {
      const res = b[name];
      if (name.endsWith(SAMPLER_SUFFIX) && (res === undefined || res instanceof NullSampler) && b[name.slice(0, -SAMPLER_SUFFIX.length)] instanceof NullTexture) {
        res?.assertAlive(`${where} 绑定 ${name}`);
        continue;
      }
      if (res === undefined) throw new RhiError('invalid-usage', `${where}:着色器需要的绑定没给 —— ${missingBindings(declared, b).join(', ')}`);
      if (res instanceof NullTexture) {
        res.assertAlive(`${where} 绑定 ${name}`);
        const sampler = b[name + SAMPLER_SUFFIX];
        if (sampler instanceof NullSampler) sampler.assertAlive(`${where} 绑定 ${name + SAMPLER_SUFFIX}`);
        this.used.add(res);
      } else if (res instanceof NullBuffer || res instanceof NullSampler) {
        res.assertAlive(`${where} 绑定 ${name}`);
        if (res instanceof NullBuffer) this.used.add(res);
      } else if (typeof res === 'object' && res !== null && 'buffer' in res) {
        this.used.add(asBuffer(res.buffer, `${where} 绑定 ${name}`));
      } else {
        throw new RhiError('invalid-usage', `${where} 绑定 ${name}:不认识的绑定资源`);
      }
    }
  }

  private assertClosed(what: string): void {
    if (this.open) throw new RhiError('invalid-usage', `${what}:上一个 pass 还没 end()`);
  }
}

export class NullRhiDevice implements RhiDevice, RhiResourceFactory {
  readonly caps: RhiCaps;
  readonly info: RhiDeviceInfo;
  readonly rootScope: RhiResourceScope;
  /** 命令 / 释放日志(测试断言用) */
  readonly log: string[] = [];
  private _lost!: Promise<string>;
  private resolveLost!: (reason: string) => void;
  private _isLost = false;
  private readonly releases: RhiReleaseQueue;
  private readonly listeners = new Set<RhiDiagnosticListener>();
  private readonly restoredListeners = new Set<() => void>();
  private readonly swapchain: NullSwapchain;
  private readonly swapchainDepth = new Map<RhiDepthFormat, NullSwapchain>();
  private readonly swapchainMsaa = new Map<string, NullSwapchain>();
  private readonly recordings: NullCommandList[] = [];
  private readonly warnedSkips = new WeakSet<object>();
  private readonly failPipeline: (label: string) => boolean;
  private frameIndex = 0;
  private destroyed = false;
  private stats: RhiFrameStats = { frame: -1, renderPasses: 0, computePasses: 0, draws: 0, dispatches: 0, skippedDraws: 0 };

  constructor(options: NullRhiDeviceOptions = {}) {
    this.caps = {
      float32Filterable: false,
      maxTextureSize: options.maxTextureSize ?? 8192,
      maxColorAttachments: 8,
      maxComputeWorkgroupSize: [256, 256, 64],
      maxComputeInvocationsPerWorkgroup: 256,
      swapchainFormat: 'bgra8unorm',
    };
    this.info = { vendor: 'null', renderer: 'null' };
    this.releases = new RhiReleaseQueue((e) => this.report(e, 'error'));
    this.rootScope = new RhiResourceScope('设备', this, null);
    const [w, h] = options.swapchainSize ?? [640, 360];
    this.swapchain = new NullSwapchain(this.rootScope, this.releases, '画布后备缓冲', w, h, [], null, this.log);
    this.newLostPromise();
    this.failPipeline = options.failPipeline ?? (() => false);
  }

  get isLost(): boolean {
    return this._isLost;
  }

  get lost(): Promise<string> {
    return this._lost;
  }

  onRestored(listener: () => void): () => void {
    this.restoredListeners.add(listener);
    return () => this.restoredListeners.delete(listener);
  }

  /**
   * 模拟设备丢失(测试用),可见行为同真后端:立即进入丢失状态(`lost` resolve、报 error 诊断、帧作废);
   * `restore`(缺省 true)时下一轮宏任务「重建设备」——此前的资源全部作废(作用域保留)、报「已恢复」、通知 onRestored。
   * 返回的 Promise 在恢复完成(或不恢复时丢失之后)resolve。已销毁 / 已丢失时什么都不做。
   */
  async loseDevice(reason = '模拟设备丢失', options: { restore?: boolean } = {}): Promise<void> {
    if (this.destroyed || this._isLost) return;
    this._isLost = true;
    this.resolveLost(reason);
    this.report(new RhiError('backend', `图形设备丢失:${reason}`), 'error');
    if (options.restore === false) return;
    await new Promise((r) => setTimeout(r, 0));
    if (this.destroyed) return;
    this.rootScope._invalidateResources();
    this.swapchainDepth.clear();
    this.swapchainMsaa.clear();
    this.releases.flush();
    this._isLost = false;
    this.newLostPromise();
    this.report(new RhiError('backend', '图形设备已恢复:此前的 GPU 资源已作废、按需重建重传(空后端模拟)'), 'warning');
    for (const l of [...this.restoredListeners]) l();
  }

  private newLostPromise(): void {
    this._lost = new Promise((resolve) => {
      this.resolveLost = resolve;
    });
  }

  get lastFrameStats(): RhiFrameStats {
    return this.stats;
  }

  /** 空后端没有真设备 */
  get native(): RhiNativeInterop {
    throw new RhiError('unsupported', '空后端没有底层 GPU 设备,互通口不可用');
  }

  /** 延迟释放队列里还压着的句柄数 */
  get pendingReleases(): number {
    return this.releases.pendingCount;
  }

  createScope(label: string, parent: RhiResourceScope = this.rootScope): RhiResourceScope {
    return parent.createChild(label);
  }

  createBuffer(scope: RhiResourceScope, desc: RhiBufferDesc): RhiBuffer {
    const size = desc.size ?? desc.data?.byteLength ?? 0;
    if (!(size > 0)) throw new RhiError('invalid-usage', `缓冲「${desc.label}」大小必须 > 0`);
    if (desc.data && desc.data.byteLength > size) {
      throw new RhiError('invalid-usage', `缓冲「${desc.label}」的初始数据(${desc.data.byteLength} 字节)超过大小 ${size}`);
    }
    if ((desc.usage & RhiBufferUsage.INDEX) && !desc.indexFormat) throw new RhiError('invalid-usage', `索引缓冲「${desc.label}」要给 indexFormat`);
    this.log.push(`create buffer ${desc.label}`);
    return new NullBuffer(scope, this.releases, desc, size, this.log);
  }

  createTexture(scope: RhiResourceScope, desc: RhiTextureDesc): RhiTexture {
    if (desc.flipY) throw unsupportedFlipY(desc.label);
    if (!(desc.width > 0 && desc.height > 0)) throw new RhiError('invalid-usage', `纹理「${desc.label}」尺寸非法:${desc.width}×${desc.height}`);
    if (desc.width > this.caps.maxTextureSize || desc.height > this.caps.maxTextureSize) {
      throw new RhiError('unsupported', `纹理「${desc.label}」${desc.width}×${desc.height} 超过设备上限 ${this.caps.maxTextureSize}`);
    }
    // 渲染目标格式:RHI 的颜色格式在 WebGPU 核心里全都可渲染,真后端的「不可渲染」检查在这里恒不触发
    const samples = desc.sampleCount ?? 1;
    if (samples !== 1 && samples !== 4) throw new RhiError('unsupported', `纹理「${desc.label}」的采样数 ${samples} 不支持(WebGPU 只有 1 / 4)`);
    if (samples > 1) {
      if (desc.usage !== RhiTextureUsage.RENDER_TARGET) {
        throw new RhiError('invalid-usage', `多重采样纹理「${desc.label}」只能当渲染附件(用途只许 RENDER_TARGET)`);
      }
      if (desc.data != null || (desc.mipLevels ?? 1) !== 1) {
        throw new RhiError('invalid-usage', `多重采样纹理「${desc.label}」不能带初始数据、不能多级 mip`);
      }
    }
    // 用途位照真后端补:上传初始内容要拷贝目标;图像源走 copyExternalImageToTexture,还要可作渲染附件
    const isImage = desc.data != null && !ArrayBuffer.isView(desc.data);
    let usage = desc.usage;
    if (desc.data != null) usage |= RhiTextureUsage.COPY_DST;
    if (isImage) usage |= RhiTextureUsage.RENDER_TARGET;
    this.log.push(`create texture ${desc.label}`);
    return new NullTexture(scope, this.releases, desc, usage, this.log);
  }

  createSampler(scope: RhiResourceScope, desc: RhiSamplerDesc): RhiSampler {
    return new NullSampler('sampler', desc.label ?? 'sampler', scope, this.releases);
  }

  createShader(scope: RhiResourceScope, desc: RhiShaderDesc): RhiShader {
    const entries = resolveShaderEntries(desc);
    return new NullShader(scope, this.releases, desc.label, desc.wgsl, entries);
  }

  createRenderPipeline(scope: RhiResourceScope, desc: RhiRenderPipelineDesc): RhiRenderPipeline {
    const shader = asShader(desc.shader, `管线「${desc.label}」`);
    if (!shader.hasRender) throw new RhiError('invalid-usage', `管线「${desc.label}」:着色器「${shader.label}」没有顶点 + 片元入口`);
    if (desc.colorFormats.length > this.caps.maxColorAttachments) {
      throw new RhiError('unsupported', `管线「${desc.label}」要 ${desc.colorFormats.length} 个颜色附件,设备上限 ${this.caps.maxColorAttachments}`);
    }
    // 真后端建管线时 luma 用同一扫描器从 WGSL 推布局,推不出来就建不了
    const layout = scanWGSLInterface(shader.wgsl, { vertexEntryPoint: shader.entryPoints.vertex });
    if (!layout) throw new RhiError('invalid-usage', `管线「${desc.label}」:着色器「${shader.label}」的接口 luma 推不出布局`);
    const state = new NullPipelineState(desc.label, this.failPipeline(desc.label), (e) => this.report(e, 'error'));
    return new NullRenderPipeline(
      scope, this.releases, desc.label, [...desc.colorFormats], desc.depthFormat ?? null,
      (desc.vertexBuffers ?? []).map((v) => v.name), desc.sampleCount ?? 1, layout.bindings.map((b) => b.name), state,
    );
  }

  createComputePipeline(scope: RhiResourceScope, desc: RhiComputePipelineDesc): RhiComputePipeline {
    const shader = asShader(desc.shader, `计算管线「${desc.label}」`);
    if (!shader.hasCompute) throw new RhiError('invalid-usage', `计算管线「${desc.label}」:着色器「${shader.label}」没有计算入口`);
    const layout = scanWGSLInterface(shader.wgsl, { scanVertexAttributes: false });
    if (!layout) throw new RhiError('invalid-usage', `计算管线「${desc.label}」:着色器「${shader.label}」的接口 luma 推不出布局`);
    const state = new NullPipelineState(desc.label, this.failPipeline(desc.label), (e) => this.report(e, 'error'));
    return new NullComputePipeline(scope, this.releases, desc.label, layout.bindings.map((b) => b.name), state);
  }

  createRenderTarget(scope: RhiResourceScope, desc: RhiRenderTargetDesc): RhiRenderTarget {
    if (desc.colors.length === 0 && !desc.depth) throw new RhiError('invalid-usage', `渲染目标「${desc.label}」至少要一个附件`);
    const colors = desc.colors.map((c, i) => asTexture(c, `渲染目标「${desc.label}」颜色附件 ${i}`));
    const depth = desc.depth ? asTexture(desc.depth, `渲染目标「${desc.label}」深度附件`) : null;
    const all = depth ? [...colors, depth] : colors;
    const { width, height } = all[0];
    for (const t of all) {
      if (t.width !== width || t.height !== height) throw new RhiError('invalid-usage', `渲染目标「${desc.label}」附件尺寸不一致`);
      if (!(t.usage & RhiTextureUsage.RENDER_TARGET)) throw new RhiError('invalid-usage', `纹理「${t.label}」作附件需要 RENDER_TARGET`);
    }
    for (const c of colors) if (isDepthFormat(c.format)) throw new RhiError('invalid-usage', `「${c.label}」是深度格式,不能当颜色附件`);
    if (depth && !isDepthFormat(depth.format)) throw new RhiError('invalid-usage', `「${depth.label}」不是深度格式`);
    const samples = all[0].sampleCount;
    if (all.some((t) => t.sampleCount !== samples)) throw new RhiError('invalid-usage', `渲染目标「${desc.label}」附件采样数不一致`);
    const resolves = (desc.resolveTargets ?? []).map((r, i) => {
      if (!r) return null;
      const t = asTexture(r, `渲染目标「${desc.label}」resolve 目标 ${i}`);
      const c = colors[i];
      if (!c) throw new RhiError('invalid-usage', `渲染目标「${desc.label}」的 resolve 目标 ${i} 没有对应的颜色附件`);
      if (c.sampleCount === 1) throw new RhiError('invalid-usage', `渲染目标「${desc.label}」颜色附件 ${i} 不是多重采样,不需要 resolve`);
      if (t.sampleCount !== 1 || t.width !== width || t.height !== height || t.format !== c.format) {
        throw new RhiError('invalid-usage', `resolve 目标「${t.label}」须是与附件同尺寸同格式的单采样纹理`);
      }
      if (!(t.usage & RhiTextureUsage.RENDER_TARGET)) throw new RhiError('invalid-usage', `纹理「${t.label}」作 resolve 目标需要 RENDER_TARGET`);
      return t;
    });
    this.log.push(`create target ${desc.label}`);
    return new NullRenderTarget(scope, this.releases, desc.label, width, height, colors, depth, this.log, undefined, resolves);
  }

  writeBuffer(buffer: RhiBuffer, data: ArrayBufferView, byteOffset = 0): void {
    const b = asBuffer(buffer, 'writeBuffer');
    this.assertNotInFlight(b, 'writeBuffer');
    if (byteOffset + data.byteLength > b.size) throw new RhiError('invalid-usage', `writeBuffer 越界:缓冲「${b.label}」`);
    b.bytes.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), byteOffset);
  }

  writeTexture(texture: RhiTexture): void {
    const t = asTexture(texture, 'writeTexture');
    this.assertNotInFlight(t, 'writeTexture');
    if (!(t.usage & RhiTextureUsage.COPY_DST)) throw new RhiError('invalid-usage', `纹理「${t.label}」写入需要 COPY_DST`);
  }

  uploadImage(texture: RhiTexture, _image: RhiImageSource, opts: { premultiplyAlpha?: boolean; flipY?: boolean } = {}): void {
    const t = asTexture(texture, 'uploadImage');
    if (opts.flipY) throw unsupportedFlipY(t.label);
    this.writeTexture(t);
  }

  generateMipmaps(texture: RhiTexture): void {
    (texture as NullTexture).assertAlive('generateMipmaps');
    this.assertNotInFlight(texture, 'generateMipmaps');
    const need = RhiTextureUsage.SAMPLED | RhiTextureUsage.RENDER_TARGET;
    if ((texture.usage & need) !== need) throw new RhiError('invalid-usage', `纹理「${texture.label}」生成 mip 需要 SAMPLED + RENDER_TARGET`);
    if (texture.mipLevels <= 1) return;
    this.log.push(`generate mips ${texture.label} ${texture.mipLevels}`);
  }

  async readBuffer(buffer: RhiBuffer, byteOffset = 0, size?: number): Promise<Uint8Array> {
    const b = asBuffer(buffer, 'readBuffer');
    if (!(b.usage & RhiBufferUsage.COPY_SRC)) throw new RhiError('invalid-usage', `回读缓冲「${b.label}」需要 COPY_SRC`);
    return b.bytes.slice(byteOffset, byteOffset + (size ?? b.size - byteOffset));
  }

  async readTexture(texture: RhiTexture): Promise<RhiTextureReadback> {
    const t = asTexture(texture, 'readTexture');
    if (!(t.usage & RhiTextureUsage.COPY_SRC)) throw new RhiError('invalid-usage', `回读纹理「${t.label}」需要 COPY_SRC`);
    throw new RhiError('unsupported', `空后端不光栅化,读不了纹理「${t.label}」`);
  }

  resizeSwapchain(): void {}

  runFrame(record: (frame: RhiFrame) => void): boolean {
    if (this._isLost || this.destroyed) return false;
    const stats: RhiFrameStats = { frame: this.frameIndex, renderPasses: 0, computePasses: 0, draws: 0, dispatches: 0, skippedDraws: 0 };
    const commands = new NullCommandList(this, `帧 ${this.frameIndex}`, stats);
    const swapchainWithDepth = (format: RhiDepthFormat): RhiRenderTarget => {
      let t = this.swapchainDepth.get(format);
      if (!t) {
        const depth = new NullTexture(
          this.rootScope,
          this.releases,
          { label: `画布深度 ${format}`, width: this.swapchain.width, height: this.swapchain.height, format, usage: RhiTextureUsage.RENDER_TARGET },
          RhiTextureUsage.RENDER_TARGET,
          this.log,
        );
        t = new NullSwapchain(this.rootScope, this.releases, `画布后备缓冲+${format}`, this.swapchain.width, this.swapchain.height, [], depth, this.log);
        this.swapchainDepth.set(format, t);
        t.armed = true;
      }
      return t;
    };
    const swapchainMultisampled = (sampleCount: number, depthFormat: RhiDepthFormat | null = null): RhiRenderTarget => {
      if (sampleCount === 1) return depthFormat ? swapchainWithDepth(depthFormat) : this.swapchain;
      if (sampleCount !== 4) throw new RhiError('unsupported', `画布多重采样数 ${sampleCount} 不支持(WebGPU 只有 1 / 4)`);
      const key = `${sampleCount}|${depthFormat ?? ''}`;
      let t = this.swapchainMsaa.get(key);
      if (!t) {
        const depth = depthFormat
          ? new NullTexture(this.rootScope, this.releases, {
              label: `画布 MSAA 深度 ${depthFormat}`, width: this.swapchain.width, height: this.swapchain.height,
              format: depthFormat, usage: RhiTextureUsage.RENDER_TARGET, sampleCount,
            }, RhiTextureUsage.RENDER_TARGET, this.log)
          : null;
        t = new NullSwapchain(this.rootScope, this.releases, `画布后备缓冲 MSAA×${sampleCount}${depthFormat ? `+${depthFormat}` : ''}`,
          this.swapchain.width, this.swapchain.height, [], depth, this.log, sampleCount, ['canvas']);
        this.swapchainMsaa.set(key, t);
        t.armed = true;
      }
      return t;
    };
    this.armSwapchains(true);
    return this.record(commands, () => record({ index: this.frameIndex, commands, swapchain: this.swapchain, swapchainWithDepth, swapchainMultisampled }), () => {
      this.armSwapchains(false);
      this.stats = stats;
      this.frameIndex++;
    });
  }

  submit(label: string, record: (commands: RhiCommandList) => void): boolean {
    if (this._isLost || this.destroyed) return false;
    const stats: RhiFrameStats = { frame: this.frameIndex, renderPasses: 0, computePasses: 0, draws: 0, dispatches: 0, skippedDraws: 0 };
    const commands = new NullCommandList(this, label, stats);
    return this.record(commands, () => record(commands), () => {});
  }

  onDiagnostic(listener: RhiDiagnosticListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.rootScope.destroy();
    this.releases.flush();
    this.listeners.clear();
    this.restoredListeners.clear();
  }

  /** @internal draw / dispatch 因管线建坏被跳过;每条管线只报一次(同真后端) */
  _warnSkippedDraw(p: NullRenderPipeline | NullComputePipeline): void {
    if (this.warnedSkips.has(p)) return;
    this.warnedSkips.add(p);
    this.report(new RhiError('backend', `管线「${p.label}」创建失败,用它的 draw / dispatch 一律跳过(只丢这些 draw,帧里其余内容照常提交)`), 'warning');
  }

  private armSwapchains(armed: boolean): void {
    this.swapchain.armed = armed;
    for (const t of this.swapchainDepth.values()) t.armed = armed;
    for (const t of this.swapchainMsaa.values()) t.armed = armed;
  }

  private record(commands: NullCommandList, body: () => void, after: () => void): boolean {
    this.releases.beginRecording();
    this.recordings.push(commands);
    try {
      body();
      commands.finish();
      this.log.push(`submit ${commands.label}`);
      return true;
    } catch (e) {
      this.log.push(`abandon ${commands.label}`);
      this.report(e, 'error');
      return false;
    } finally {
      this.recordings.splice(this.recordings.indexOf(commands), 1);
      after();
      this.releases.endRecording();
    }
  }

  private assertNotInFlight(resource: object, what: string): void {
    const list = this.recordings.find((r) => r.used.has(resource));
    if (list) throw new RhiError('invalid-usage', `${what}:资源已被正在录制的「${list.label}」引用,录制期间不能再写`);
  }

  private report(error: unknown, severity: RhiDiagnosticSeverity): void {
    const e = error instanceof RhiError ? error : new RhiError('backend', error instanceof Error ? error.message : String(error));
    if (this.listeners.size === 0) {
      if (severity === 'error') console.error(e);
      else console.warn(e);
      return;
    }
    for (const l of this.listeners) l(e, severity);
  }
}

function asBuffer(b: RhiBuffer, what: string): NullBuffer {
  if (!(b instanceof NullBuffer)) throw new RhiError('invalid-usage', `${what}:不是本设备的缓冲`);
  b.assertAlive(what);
  return b;
}

function asTexture(t: RhiTexture, what: string): NullTexture {
  if (!(t instanceof NullTexture)) throw new RhiError('invalid-usage', `${what}:不是本设备的纹理`);
  t.assertAlive(what);
  return t;
}

function asShader(s: RhiShader, what: string): NullShader {
  if (!(s instanceof NullShader)) throw new RhiError('invalid-usage', `${what}:不是本设备的着色器`);
  s.assertAlive(what);
  return s;
}

function unsupportedFlipY(label: string): RhiError {
  return new RhiError('unsupported', `纹理「${label}」:图像上传不支持 flipY(同真后端)`);
}
