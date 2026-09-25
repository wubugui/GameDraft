/**
 * 空后端:不碰 GPU,只把命令记进日志。给单元测试、无头逻辑跑用。
 *
 * 校验照真后端做(用途位、已销毁资源、pass 嵌套、格式匹配、录制期写入冲突),这样上层在空后端上
 * 通过的用法,在真后端上也不会因为这些原因失败。**不光栅化**:纹理内容无从得知,`readTexture`
 * 直接报不支持;缓冲在 CPU 侧有一份,写入 / 缓冲间拷贝 / 回读是真的。
 */
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

export interface NullRhiDeviceOptions {
  swapchainSize?: [number, number];
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
  constructor(scope: RhiResourceScope, releases: RhiReleaseQueue, label: string, readonly hasRender: boolean, readonly hasCompute: boolean) {
    super('shader', label, scope, releases);
  }
  protected releaseBackend(): void {}
}

class NullRenderPipeline extends RhiResourceBase<'render-pipeline'> implements RhiRenderPipeline {
  readonly ready = Promise.resolve();
  readonly isReady = true;
  constructor(
    scope: RhiResourceScope,
    releases: RhiReleaseQueue,
    label: string,
    readonly colorFormats: readonly RhiColorFormat[],
    readonly depthFormat: RhiDepthFormat | null,
    readonly streams: readonly string[],
    readonly sampleCount = 1,
  ) {
    super('render-pipeline', label, scope, releases);
  }
  protected releaseBackend(): void {}
}

class NullComputePipeline extends RhiResourceBase<'compute-pipeline'> implements RhiComputePipeline {
  readonly ready = Promise.resolve();
  readonly isReady = true;
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
    const t = desc.target as NullRenderTarget;
    t.assertAlive(`render pass「${desc.label}」的目标`);
    for (const c of t.colors) this.used.add(c);
    if (t.depth) this.used.add(t.depth);
    for (const r of t.resolves) if (r && r !== 'canvas') this.used.add(r);
    this.stats.renderPasses++;
    const ops = t.colorFormats.map((_, i) => desc.colorOps?.[i]?.load ?? 'clear').join(',');
    const resolves = t.resolves.map((r) => (r === 'canvas' ? '画布' : r?.label ?? '-')).join(',');
    this.device.log.push(`begin render ${desc.label} -> ${t.label} [${ops}]${t.resolves.length ? ` resolve→${resolves}` : ''}`);
    let pipeline: NullRenderPipeline | null = null;
    const streams = new Set<string>();
    const enc: RhiRenderPassEncoder = {
      setPipeline: (p) => {
        const np = p as NullRenderPipeline;
        np.assertAlive('setPipeline');
        const same = np.colorFormats.length === t.colorFormats.length && np.colorFormats.every((f, i) => f === t.colorFormats[i]);
        if (!same || np.depthFormat !== t.depthFormat) {
          throw new RhiError('invalid-usage', `管线「${np.label}」的目标格式与 render pass「${desc.label}」不一致`);
        }
        if (np.sampleCount !== t.sampleCount) {
          throw new RhiError('invalid-usage', `管线「${np.label}」的采样数 ${np.sampleCount} 与 render pass「${desc.label}」的目标(${t.sampleCount})不一致`);
        }
        pipeline = np;
      },
      setBindings: (b) => this.useBindings(b),
      setVertexBuffer: (name, b) => {
        (b as NullBuffer).assertAlive(`顶点流 ${name}`);
        if (!(b.usage & RhiBufferUsage.VERTEX)) throw new RhiError('invalid-usage', `缓冲「${b.label}」作顶点流需要 VERTEX`);
        this.used.add(b);
        streams.add(name);
      },
      setIndexBuffer: (b) => {
        if (b) this.used.add(b);
      },
      setViewport: () => {},
      setScissor: () => {},
      setStencilReference: () => {},
      draw: (count) => {
        if (!pipeline) throw new RhiError('invalid-usage', 'draw 之前没 setPipeline');
        for (const s of pipeline.streams) if (!streams.has(s)) throw new RhiError('invalid-usage', `顶点流「${s}」没绑定缓冲`);
        this.stats.draws++;
        this.device.log.push(`draw ${pipeline.label} ${count}`);
      },
      drawIndexed: (count) => {
        if (!pipeline) throw new RhiError('invalid-usage', 'drawIndexed 之前没 setPipeline');
        this.stats.draws++;
        this.device.log.push(`drawIndexed ${pipeline.label} ${count}`);
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
    const enc: RhiComputePassEncoder = {
      setPipeline: (p) => {
        (p as NullComputePipeline).assertAlive('setPipeline');
        pipeline = p as NullComputePipeline;
      },
      setBindings: (b) => this.useBindings(b),
      dispatch: (x, y = 1, z = 1) => {
        if (!pipeline) throw new RhiError('invalid-usage', 'dispatch 之前没 setPipeline');
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
    const s = src as NullBuffer;
    const d = dst as NullBuffer;
    s.assertAlive('拷贝源');
    d.assertAlive('拷贝目标');
    if (!(s.usage & RhiBufferUsage.COPY_SRC)) throw new RhiError('invalid-usage', `缓冲「${s.label}」作拷贝源需要 COPY_SRC`);
    if (!(d.usage & RhiBufferUsage.COPY_DST)) throw new RhiError('invalid-usage', `缓冲「${d.label}」作拷贝目标需要 COPY_DST`);
    this.used.add(s);
    this.used.add(d);
    d.bytes.set(s.bytes.subarray(srcOffset, srcOffset + size), dstOffset);
    this.device.log.push(`copy buffer ${s.label} -> ${d.label}`);
  }

  copyTextureToTexture(src: RhiTexture, dst: RhiTexture): void {
    this.assertClosed('copyTextureToTexture');
    (src as NullTexture).assertAlive('拷贝源');
    (dst as NullTexture).assertAlive('拷贝目标');
    if (!(src.usage & RhiTextureUsage.COPY_SRC)) throw new RhiError('invalid-usage', `纹理「${src.label}」作拷贝源需要 COPY_SRC`);
    if (!(dst.usage & RhiTextureUsage.COPY_DST)) throw new RhiError('invalid-usage', `纹理「${dst.label}」作拷贝目标需要 COPY_DST`);
    this.used.add(src);
    this.used.add(dst);
    this.device.log.push(`copy texture ${src.label} -> ${dst.label}`);
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

  private useBindings(b: RhiBindings): void {
    for (const r of Object.values(b)) {
      const res = ('buffer' in r ? r.buffer : r) as RhiResourceBase<string>;
      res.assertAlive('绑定');
      if (res.kind !== 'sampler') this.used.add(res);
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
  readonly lost: Promise<string>;
  readonly isLost = false;
  /** 命令 / 释放日志(测试断言用) */
  readonly log: string[] = [];
  private readonly releases: RhiReleaseQueue;
  private readonly listeners = new Set<RhiDiagnosticListener>();
  private readonly swapchain: NullSwapchain;
  private readonly swapchainDepth = new Map<RhiDepthFormat, NullSwapchain>();
  private readonly swapchainMsaa = new Map<string, NullSwapchain>();
  private readonly recordings: NullCommandList[] = [];
  private frameIndex = 0;
  private stats: RhiFrameStats = { frame: -1, renderPasses: 0, computePasses: 0, draws: 0, dispatches: 0, skippedDraws: 0 };

  constructor(options: NullRhiDeviceOptions = {}) {
    this.caps = {
      float32Filterable: false,
      maxTextureSize: 8192,
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
    this.lost = new Promise(() => {});
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
    if ((desc.usage & RhiBufferUsage.INDEX) && !desc.indexFormat) throw new RhiError('invalid-usage', `索引缓冲「${desc.label}」要给 indexFormat`);
    this.log.push(`create buffer ${desc.label}`);
    return new NullBuffer(scope, this.releases, desc, size, this.log);
  }

  createTexture(scope: RhiResourceScope, desc: RhiTextureDesc): RhiTexture {
    if (!(desc.width > 0 && desc.height > 0)) throw new RhiError('invalid-usage', `纹理「${desc.label}」尺寸非法`);
    const samples = desc.sampleCount ?? 1;
    if (samples !== 1 && samples !== 4) throw new RhiError('unsupported', `纹理「${desc.label}」的采样数 ${samples} 不支持`);
    if (samples > 1 && (desc.usage !== RhiTextureUsage.RENDER_TARGET || desc.data != null)) {
      throw new RhiError('invalid-usage', `多重采样纹理「${desc.label}」只能当渲染附件、不能带初始数据`);
    }
    let usage = desc.usage;
    if (desc.data != null) usage |= RhiTextureUsage.COPY_DST;
    this.log.push(`create texture ${desc.label}`);
    return new NullTexture(scope, this.releases, desc, usage, this.log);
  }

  createSampler(scope: RhiResourceScope, desc: RhiSamplerDesc): RhiSampler {
    return new NullSampler('sampler', desc.label ?? 'sampler', scope, this.releases);
  }

  createShader(scope: RhiResourceScope, desc: RhiShaderDesc): RhiShader {
    const wgsl = desc.wgsl ?? '';
    const hasRender = /@vertex/.test(wgsl) && /@fragment/.test(wgsl);
    const hasCompute = /@compute/.test(wgsl);
    if (!hasRender && !hasCompute) throw new RhiError('invalid-usage', `着色器「${desc.label}」里找不到 @vertex / @fragment / @compute 入口`);
    return new NullShader(scope, this.releases, desc.label, hasRender, hasCompute);
  }

  createRenderPipeline(scope: RhiResourceScope, desc: RhiRenderPipelineDesc): RhiRenderPipeline {
    if (!desc.shader.hasRender) throw new RhiError('invalid-usage', `管线「${desc.label}」:着色器没有顶点 + 片元入口`);
    return new NullRenderPipeline(scope, this.releases, desc.label, [...desc.colorFormats], desc.depthFormat ?? null, (desc.vertexBuffers ?? []).map((v) => v.name), desc.sampleCount ?? 1);
  }

  createComputePipeline(scope: RhiResourceScope, desc: RhiComputePipelineDesc): RhiComputePipeline {
    if (!desc.shader.hasCompute) throw new RhiError('invalid-usage', `计算管线「${desc.label}」:着色器没有计算入口`);
    return new NullComputePipeline('compute-pipeline', desc.label, scope, this.releases);
  }

  createRenderTarget(scope: RhiResourceScope, desc: RhiRenderTargetDesc): RhiRenderTarget {
    const colors = desc.colors as NullTexture[];
    const depth = (desc.depth as NullTexture | null | undefined) ?? null;
    const all = depth ? [...colors, depth] : colors;
    if (all.length === 0) throw new RhiError('invalid-usage', `渲染目标「${desc.label}」至少要一个附件`);
    const { width, height } = all[0];
    for (const t of all) {
      t.assertAlive(`渲染目标「${desc.label}」的附件`);
      if (t.width !== width || t.height !== height) throw new RhiError('invalid-usage', `渲染目标「${desc.label}」附件尺寸不一致`);
      if (!(t.usage & RhiTextureUsage.RENDER_TARGET)) throw new RhiError('invalid-usage', `纹理「${t.label}」作附件需要 RENDER_TARGET`);
    }
    for (const c of colors) if (isDepthFormat(c.format)) throw new RhiError('invalid-usage', `「${c.label}」是深度格式,不能当颜色附件`);
    if (depth && !isDepthFormat(depth.format)) throw new RhiError('invalid-usage', `「${depth.label}」不是深度格式`);
    const samples = all[0].sampleCount;
    if (all.some((t) => t.sampleCount !== samples)) throw new RhiError('invalid-usage', `渲染目标「${desc.label}」附件采样数不一致`);
    (desc.resolveTargets ?? []).forEach((r, i) => {
      if (!r) return;
      const c = colors[i];
      if (!c || c.sampleCount === 1) throw new RhiError('invalid-usage', `渲染目标「${desc.label}」的 resolve 目标 ${i} 没有对应的多重采样颜色附件`);
      if (r.sampleCount !== 1 || r.width !== width || r.height !== height || r.format !== c.format) {
        throw new RhiError('invalid-usage', `resolve 目标「${r.label}」须是与附件同尺寸同格式的单采样纹理`);
      }
    });
    this.log.push(`create target ${desc.label}`);
    return new NullRenderTarget(
      scope, this.releases, desc.label, width, height, colors, depth, this.log, undefined, (desc.resolveTargets ?? []) as (NullTexture | null)[],
    );
  }

  writeBuffer(buffer: RhiBuffer, data: ArrayBufferView, byteOffset = 0): void {
    const b = buffer as NullBuffer;
    b.assertAlive('writeBuffer');
    this.assertNotInFlight(b, 'writeBuffer');
    if (byteOffset + data.byteLength > b.size) throw new RhiError('invalid-usage', `writeBuffer 越界:缓冲「${b.label}」`);
    b.bytes.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), byteOffset);
  }

  writeTexture(texture: RhiTexture): void {
    (texture as NullTexture).assertAlive('writeTexture');
    this.assertNotInFlight(texture, 'writeTexture');
    if (!(texture.usage & RhiTextureUsage.COPY_DST)) throw new RhiError('invalid-usage', `纹理「${texture.label}」写入需要 COPY_DST`);
  }

  uploadImage(texture: RhiTexture, _image: RhiImageSource): void {
    this.writeTexture(texture);
  }

  async readBuffer(buffer: RhiBuffer, byteOffset = 0, size?: number): Promise<Uint8Array> {
    const b = buffer as NullBuffer;
    b.assertAlive('readBuffer');
    if (!(b.usage & RhiBufferUsage.COPY_SRC)) throw new RhiError('invalid-usage', `回读缓冲「${b.label}」需要 COPY_SRC`);
    return b.bytes.slice(byteOffset, byteOffset + (size ?? b.size - byteOffset));
  }

  async readTexture(texture: RhiTexture): Promise<RhiTextureReadback> {
    throw new RhiError('unsupported', `空后端不光栅化,读不了纹理「${texture.label}」`);
  }

  resizeSwapchain(): void {}

  runFrame(record: (frame: RhiFrame) => void): boolean {
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
      }
      return t;
    };
    const swapchainMultisampled = (sampleCount: number, depthFormat: RhiDepthFormat | null = null): RhiRenderTarget => {
      if (sampleCount === 1) return depthFormat ? swapchainWithDepth(depthFormat) : this.swapchain;
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
      }
      return t;
    };
    return this.record(commands, () => record({ index: this.frameIndex, commands, swapchain: this.swapchain, swapchainWithDepth, swapchainMultisampled }), () => {
      this.stats = stats;
      this.frameIndex++;
    });
  }

  submit(label: string, record: (commands: RhiCommandList) => void): boolean {
    const stats: RhiFrameStats = { frame: this.frameIndex, renderPasses: 0, computePasses: 0, draws: 0, dispatches: 0, skippedDraws: 0 };
    const commands = new NullCommandList(this, label, stats);
    return this.record(commands, () => record(commands), () => {});
  }

  onDiagnostic(listener: RhiDiagnosticListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  destroy(): void {
    this.rootScope.destroy();
    this.releases.flush();
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
