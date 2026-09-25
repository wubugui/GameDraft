/**
 * RHI 的 luma.gl 后端(WebGPU / WebGL2 两条路都走 luma.gl 9.4)。
 *
 * 这一层只做三件事:把 RHI 描述符翻成 luma 调用;把 luma 里"静默"的行为(WebGL2 着色器未链接完
 * 就跳过 draw、绑定缺项、格式不配)变成当场可见的 RhiError / 诊断;以及执行 RHI 的资源所有权与
 * 帧级异常隔离。上层不许直接碰 luma 对象。
 */
import { luma, getAttributeInfosFromLayouts, Buffer as LumaBufferClass } from '@luma.gl/core';
import type {
  Binding,
  Bindings,
  Buffer as LumaBuffer,
  CanvasContext,
  CommandEncoder,
  ComputePass,
  ComputePipeline,
  ComputeShaderLayout,
  Device,
  Framebuffer,
  RenderPass,
  RenderPipeline,
  Sampler,
  Shader,
  ShaderLayout,
  Texture,
  VertexArray,
} from '@luma.gl/core';
import { webgpuAdapter } from '@luma.gl/webgpu';
import { webgl2Adapter } from '@luma.gl/webgl';
import {
  RhiBufferUsage,
  RhiError,
  RhiTextureUsage,
  isDepthFormat,
  type RhiBackendType,
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
import type {
  RhiBindingResource,
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
  backendAttemptOrder,
  stripRowPadding,
  toLumaBufferLayout,
  toLumaBufferUsage,
  toLumaPipelineParameters,
  toLumaSamplerProps,
  toLumaTextureFormat,
  toLumaTextureUsage,
  toRhiBackend,
} from './lumaMapping';

export interface LumaRhiDeviceOptions {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  /** `auto`:有 WebGPU 用 WebGPU,否则 WebGL2 */
  backend?: 'auto' | RhiBackendType;
  /** 画布合成方式:世界画布在最底层用 opaque;需要透出下层时用 premultiplied */
  alphaMode?: 'opaque' | 'premultiplied';
  /** true = 按 devicePixelRatio;数字 = 固定比例;false = 1 */
  useDevicePixels?: boolean | number;
  /** 画布 CSS 尺寸变化时自动调整后备缓冲 */
  autoResize?: boolean;
  /** 打开 luma 的调试校验(慢) */
  debug?: boolean;
}

/** 按顺序尝试后端,第一个成功的胜出;全部失败抛 RhiError('unsupported') 并列出每个后端的原因 */
export async function createLumaRhiDevice(options: LumaRhiDeviceOptions): Promise<RhiDevice> {
  const order = backendAttemptOrder(options.backend ?? 'auto', await hasUsableWebGPU());
  const failures: string[] = [];
  for (const backend of order) {
    const sink: { target: LumaRhiDevice | null; early: unknown[] } = { target: null, early: [] };
    try {
      const device = await luma.createDevice({
        type: backend === 'webgpu' ? 'webgpu' : 'webgl',
        adapters: [webgpuAdapter, webgl2Adapter],
        createCanvasContext: {
          canvas: options.canvas,
          alphaMode: options.alphaMode ?? 'opaque',
          useDevicePixels: options.useDevicePixels ?? true,
          autoResize: options.autoResize ?? true,
        },
        debug: options.debug ?? false,
        debugShaders: options.debug ? 'errors' : 'never',
        onError: (error: Error) => {
          if (sink.target) sink.target._reportBackendError(error);
          else sink.early.push(error);
        },
      });
      const rhi = new LumaRhiDevice(device);
      sink.target = rhi;
      for (const e of sink.early) rhi._reportBackendError(e);
      return rhi;
    } catch (e) {
      failures.push(`${backend}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new RhiError('unsupported', `没有可用的图形后端(${failures.join(';') || '无候选'})`);
}

async function hasUsableWebGPU(): Promise<boolean> {
  const gpu = (globalThis.navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } } | undefined)?.gpu;
  if (!gpu) return false;
  try {
    return (await gpu.requestAdapter()) != null;
  } catch {
    return false;
  }
}

// ───────────────────────────── 资源

class LumaRhiBuffer extends RhiResourceBase<'buffer'> implements RhiBuffer {
  constructor(
    scope: RhiResourceScope,
    releases: RhiReleaseQueue,
    readonly handle: LumaBuffer,
    readonly size: number,
    readonly usage: number,
    readonly indexFormat: 'uint16' | 'uint32' | undefined,
    label: string,
  ) {
    super('buffer', label, scope, releases);
  }

  protected releaseBackend(): void {
    this.handle.destroy();
  }
}

class LumaRhiTexture extends RhiResourceBase<'texture'> implements RhiTexture {
  constructor(
    scope: RhiResourceScope,
    releases: RhiReleaseQueue,
    readonly handle: Texture,
    readonly usage: number,
    label: string,
  ) {
    super('texture', label, scope, releases);
  }

  get width(): number {
    return this.handle.width;
  }

  get height(): number {
    return this.handle.height;
  }

  get format(): RhiTextureFormat {
    return this.handle.format as RhiTextureFormat;
  }

  get mipLevels(): number {
    return this.handle.mipLevels;
  }

  protected releaseBackend(): void {
    this.handle.destroy();
  }
}

class LumaRhiSampler extends RhiResourceBase<'sampler'> implements RhiSampler {
  constructor(scope: RhiResourceScope, releases: RhiReleaseQueue, readonly handle: Sampler, label: string) {
    super('sampler', label, scope, releases);
  }

  protected releaseBackend(): void {
    this.handle.destroy();
  }
}

class LumaRhiShader extends RhiResourceBase<'shader'> implements RhiShader {
  private _flippedVs: Shader | null = null;

  constructor(
    scope: RhiResourceScope,
    releases: RhiReleaseQueue,
    label: string,
    readonly vs: Shader | null,
    readonly fs: Shader | null,
    readonly cs: Shader | null,
    readonly entryPoints: { vertex?: string; fragment?: string; compute?: string },
    /** WebGL2:顶点着色器源(用来生成 Y 翻转变体) */
    private readonly glslVertex: string | null = null,
  ) {
    super('shader', label, scope, releases);
  }

  /** WebGL2 离屏渲染用的 Y 翻转顶点着色器(见 `flipClipSpaceY`),首次要时建 */
  flippedVs(device: Device): Shader {
    if (!this._flippedVs) {
      this._flippedVs = device.createShader({
        id: `${this.label}:vs:flipY`,
        stage: 'vertex',
        source: flipClipSpaceY(this.glslVertex!, this.label),
        language: 'glsl',
      });
    }
    return this._flippedVs;
  }

  get hasRender(): boolean {
    return this.vs != null && this.fs != null;
  }

  get hasCompute(): boolean {
    return this.cs != null;
  }

  protected releaseBackend(): void {
    // 同一个 WGSL 模块可能同时充当 vs / fs / cs,只销毁一次
    for (const s of new Set([this.vs, this.fs, this.cs, this._flippedVs])) s?.destroy();
  }
}

/** 一条管线在后端的一个具体实例 */
interface PipelineVariant {
  handle: RenderPipeline;
  vertexArray: VertexArray;
  /** 顶点流名 → 后端槽位(WebGPU 是逻辑缓冲槽,WebGL2 是该流里各属性的 location) */
  streamSlots: ReadonlyMap<string, readonly number[]>;
}

class LumaRhiRenderPipeline extends RhiResourceBase<'render-pipeline'> implements RhiRenderPipeline {
  private _isReady = false;
  readonly ready: Promise<void>;

  constructor(
    scope: RhiResourceScope,
    releases: RhiReleaseQueue,
    label: string,
    /** 画到离屏目标用的实例(WebGL2 下是 Y 翻转变体) */
    readonly offscreen: PipelineVariant,
    /** 画到画布后备缓冲用的实例(WebGPU 下与 offscreen 是同一个) */
    readonly onscreen: PipelineVariant,
    readonly colorFormats: readonly RhiColorFormat[],
    readonly depthFormat: RhiDepthFormat | null,
    shaders: readonly Shader[],
    onFail: (e: unknown) => void,
  ) {
    super('render-pipeline', label, scope, releases);
    const handles = [...new Set([offscreen.handle, onscreen.handle])];
    this.ready = waitPipelineReady(label, handles, shaders).then(() => {
      this._isReady = true;
    });
    this.ready.catch(onFail);
  }

  get isReady(): boolean {
    return this._isReady;
  }

  variant(toSwapchain: boolean): PipelineVariant {
    return toSwapchain ? this.onscreen : this.offscreen;
  }

  protected releaseBackend(): void {
    for (const v of new Set([this.offscreen, this.onscreen])) {
      v.vertexArray.destroy();
      v.handle.destroy();
    }
  }
}

class LumaRhiComputePipeline extends RhiResourceBase<'compute-pipeline'> implements RhiComputePipeline {
  private _isReady = false;
  readonly ready: Promise<void>;

  constructor(
    scope: RhiResourceScope,
    releases: RhiReleaseQueue,
    label: string,
    readonly handle: ComputePipeline,
    shaders: readonly Shader[],
    onFail: (e: unknown) => void,
  ) {
    super('compute-pipeline', label, scope, releases);
    this.ready = waitPipelineReady(label, [], shaders).then(() => {
      this._isReady = true;
    });
    this.ready.catch(onFail);
  }

  get isReady(): boolean {
    return this._isReady;
  }

  protected releaseBackend(): void {
    this.handle.destroy();
  }
}

class LumaRhiRenderTarget extends RhiResourceBase<'render-target'> implements RhiRenderTarget {
  constructor(
    scope: RhiResourceScope,
    releases: RhiReleaseQueue,
    label: string,
    readonly framebuffer: Framebuffer,
    readonly colors: readonly LumaRhiTexture[],
    readonly depth: LumaRhiTexture | null,
  ) {
    super('render-target', label, scope, releases);
  }

  get width(): number {
    return this.framebuffer.width;
  }

  get height(): number {
    return this.framebuffer.height;
  }

  get colorFormats(): readonly RhiColorFormat[] {
    return this.colors.map((c) => c.format as RhiColorFormat);
  }

  get depthFormat(): RhiDepthFormat | null {
    return (this.depth?.format as RhiDepthFormat | undefined) ?? null;
  }

  /** 附件被单独销毁时,目标也就不能再用了 */
  override assertAlive(usage: string): void {
    super.assertAlive(usage);
    for (const c of this.colors) c.assertAlive(`${usage}(渲染目标「${this.label}」的颜色附件)`);
    this.depth?.assertAlive(`${usage}(渲染目标「${this.label}」的深度附件)`);
  }

  protected releaseBackend(): void {
    // 只拆帧缓冲对象,附件纹理归各自的所有者
    this.framebuffer.destroy();
  }
}

/**
 * 画布后备缓冲。只在 runFrame 录制期内可用,**第一次被当作 pass 目标时**才向画布要这一帧的纹理
 * ——这一帧没画到画布就不取(不空耗一次呈现,加载期只做离屏烘焙的帧也不碰画布)。不归任何作用域销毁。
 */
class LumaSwapchainTarget extends RhiResourceBase<'render-target'> implements RhiRenderTarget {
  private current: Framebuffer | null = null;
  private armed = false;

  constructor(
    scope: RhiResourceScope,
    releases: RhiReleaseQueue,
    private readonly context: CanvasContext,
    private readonly format: RhiColorFormat,
  ) {
    super('render-target', '画布后备缓冲', scope, releases);
  }

  get framebuffer(): Framebuffer {
    if (!this.armed) throw new RhiError('invalid-usage', '画布后备缓冲只能在 runFrame 的录制期内使用');
    this.current ??= this.context.getCurrentFramebuffer({ depthStencilFormat: false });
    return this.current;
  }

  get width(): number {
    return this.context.getDrawingBufferSize()[0];
  }

  get height(): number {
    return this.context.getDrawingBufferSize()[1];
  }

  get colorFormats(): readonly RhiColorFormat[] {
    return [this.format];
  }

  get depthFormat(): RhiDepthFormat | null {
    return null;
  }

  override destroy(): void {
    throw new RhiError('invalid-usage', '画布后备缓冲归设备所有,不能单独销毁');
  }

  _beginFrame(): void {
    this.armed = true;
    this.current = null;
  }

  _endFrame(): void {
    this.armed = false;
    this.current = null;
  }

  protected releaseBackend(): void {}
}

// ───────────────────────────── 命令

class LumaCommandList implements RhiCommandList {
  private readonly encoder: CommandEncoder;
  private openPass: { end(): void } | null = null;
  /** 本批命令里已经引用过的缓冲 / 纹理(录制期写入冲突检查用) */
  private readonly used = new Set<LumaRhiBuffer | LumaRhiTexture>();

  constructor(
    private readonly device: LumaRhiDevice,
    readonly label: string,
    private readonly stats: RhiFrameStats,
  ) {
    this.encoder = device.luma.createCommandEncoder({ id: label });
  }

  beginRenderPass(desc: RhiRenderPassDesc): RhiRenderPassEncoder {
    this.assertNoOpenPass(`beginRenderPass「${desc.label}」`);
    const target = asTarget(desc.target);
    target.assertAlive(`render pass「${desc.label}」的目标`);
    if (target instanceof LumaRhiRenderTarget) {
      for (const c of target.colors) this._use(c);
      if (target.depth) this._use(target.depth);
    }
    const colorOps = desc.colorOps ?? [];
    if (colorOps.length > target.colorFormats.length) {
      throw new RhiError('invalid-usage', `render pass「${desc.label}」给了 ${colorOps.length} 个颜色附件操作,目标只有 ${target.colorFormats.length} 个附件`);
    }
    const clearColors = target.colorFormats.map((format, i) => {
      const op = colorOps[i] ?? { load: 'clear' as const };
      if (op.load !== 'clear') return false as const;
      const v = op.clearValue ?? [0, 0, 0, 0];
      // 整数格式要用整数清屏值(WebGL2 走 clearBufferuiv)
      return format.endsWith('uint') ? new Uint32Array(v) : new Float32Array(v);
    });
    const depthOp = desc.depthOp ?? { load: 'clear' as const };
    const pass = this.encoder.beginRenderPass({
      id: desc.label,
      framebuffer: target.framebuffer,
      clearColors,
      clearColor: clearColors.length === 1 && clearColors[0] ? (Array.from(clearColors[0]) as [number, number, number, number]) : false,
      clearDepth: target.depthFormat ? (depthOp.load === 'clear' ? depthOp.clearValue ?? 1 : false) : false,
      clearStencil: false,
    });
    this.stats.renderPasses++;
    const enc = new LumaRenderPassEncoder(this.device, this, pass, target, desc.label, this.stats);
    this.openPass = enc;
    return enc;
  }

  beginComputePass(label: string): RhiComputePassEncoder {
    if (!this.device.caps.compute) {
      throw new RhiError('unsupported', `compute pass「${label}」:当前后端(${this.device.caps.backend})没有 compute`);
    }
    this.assertNoOpenPass(`beginComputePass「${label}」`);
    const pass = this.encoder.beginComputePass({ id: label });
    this.stats.computePasses++;
    const enc = new LumaComputePassEncoder(this.device, this, pass, label, this.stats);
    this.openPass = enc;
    return enc;
  }

  copyBufferToBuffer(src: RhiBuffer, srcOffset: number, dst: RhiBuffer, dstOffset: number, size: number): void {
    this.assertNoOpenPass('copyBufferToBuffer');
    const s = asBuffer(src, 'copyBufferToBuffer 源');
    const d = asBuffer(dst, 'copyBufferToBuffer 目标');
    requireUsage(s.usage, RhiBufferUsage.COPY_SRC, `缓冲「${s.label}」作拷贝源`, 'COPY_SRC');
    requireUsage(d.usage, RhiBufferUsage.COPY_DST, `缓冲「${d.label}」作拷贝目标`, 'COPY_DST');
    this._use(s);
    this._use(d);
    if (srcOffset < 0 || dstOffset < 0 || srcOffset + size > s.size || dstOffset + size > d.size) {
      throw new RhiError('invalid-usage', `copyBufferToBuffer 越界:源「${s.label}」[${srcOffset}, +${size}) / 目标「${d.label}」[${dstOffset}, +${size})`);
    }
    this.inOrder((enc) => enc.copyBufferToBuffer({
      sourceBuffer: s.handle,
      sourceOffset: srcOffset,
      destinationBuffer: d.handle,
      destinationOffset: dstOffset,
      size,
    }));
  }

  copyTextureToTexture(src: RhiTexture, dst: RhiTexture, width?: number, height?: number): void {
    this.assertNoOpenPass('copyTextureToTexture');
    const s = asTexture(src, 'copyTextureToTexture 源');
    const d = asTexture(dst, 'copyTextureToTexture 目标');
    requireUsage(s.usage, RhiTextureUsage.COPY_SRC, `纹理「${s.label}」作拷贝源`, 'COPY_SRC');
    requireUsage(d.usage, RhiTextureUsage.COPY_DST, `纹理「${d.label}」作拷贝目标`, 'COPY_DST');
    this._use(s);
    this._use(d);
    const w = width ?? s.width;
    const h = height ?? s.height;
    if (w > s.width || h > s.height || w > d.width || h > d.height) {
      throw new RhiError('invalid-usage', `copyTextureToTexture 越界:${w}×${h},源「${s.label}」${s.width}×${s.height},目标「${d.label}」${d.width}×${d.height}`);
    }
    if (s.format !== d.format) {
      throw new RhiError('invalid-usage', `copyTextureToTexture 格式不同:「${s.label}」${s.format} → 「${d.label}」${d.format}`);
    }
    this.inOrder((enc) => enc.copyTextureToTexture({ sourceTexture: s.handle, destinationTexture: d.handle, width: w, height: h }));
  }

  pushDebugGroup(label: string): void {
    this.encoder.pushDebugGroup(label);
  }

  popDebugGroup(): void {
    this.encoder.popDebugGroup();
  }

  /** @internal */
  _use(resource: LumaRhiBuffer | LumaRhiTexture): void {
    this.used.add(resource);
  }

  /** @internal */
  _uses(resource: LumaRhiBuffer | LumaRhiTexture): boolean {
    return this.used.has(resource);
  }

  /** @internal */
  _passEnded(): void {
    this.openPass = null;
  }

  /** @internal */
  _submit(): void {
    this.assertNoOpenPass(`提交「${this.label}」`);
    this.device.luma.submit(this.encoder.finish());
  }

  /** @internal 录制失败:收尾开着的 pass,整批丢弃 */
  _abandon(): void {
    try {
      this.openPass?.end();
    } catch {
      /* 录制已经失败,收尾失败不再追究 */
    }
    this.openPass = null;
    try {
      this.encoder.destroy();
    } catch {
      /* 同上 */
    }
  }

  private assertNoOpenPass(what: string): void {
    if (this.openPass) throw new RhiError('invalid-usage', `${what}:上一个 pass 还没 end()`);
  }

  /**
   * 保证命令按录制顺序执行。luma 的 WebGL2 后端里 render pass 是**当场执行**的,拷贝却攒到
   * submit 才执行——照原样用,"先拷贝再在 pass 里读"会读到拷贝前的内容。WebGL2 下拷贝因此也当场执行。
   */
  private inOrder(record: (encoder: CommandEncoder) => void): void {
    if (this.device.caps.backend !== 'webgl2') {
      record(this.encoder);
      return;
    }
    const immediate = this.device.luma.createCommandEncoder({ id: `${this.label}:copy` });
    record(immediate);
    this.device.luma.submit(immediate.finish());
  }
}

class LumaRenderPassEncoder implements RhiRenderPassEncoder {
  private pipeline: LumaRhiRenderPipeline | null = null;
  private variant: PipelineVariant | null = null;
  private bindingsSet = false;
  private readonly streams = new Map<string, LumaRhiBuffer>();
  private indexBuffer: LumaRhiBuffer | null = null;
  private ended = false;

  constructor(
    private readonly device: LumaRhiDevice,
    private readonly list: LumaCommandList,
    private readonly pass: RenderPass,
    private readonly target: LumaRhiRenderTarget | LumaSwapchainTarget,
    private readonly label: string,
    private readonly stats: RhiFrameStats,
  ) {}

  setPipeline(pipeline: RhiRenderPipeline): void {
    const p = asRenderPipeline(pipeline, `render pass「${this.label}」setPipeline`);
    if (!sameFormats(p.colorFormats, this.target.colorFormats) || p.depthFormat !== this.target.depthFormat) {
      throw new RhiError(
        'invalid-usage',
        `管线「${p.label}」的目标格式 [${p.colorFormats.join(', ')}|${p.depthFormat ?? '无深度'}] `
          + `与 render pass「${this.label}」的目标 [${this.target.colorFormats.join(', ')}|${this.target.depthFormat ?? '无深度'}] 不一致`,
      );
    }
    const variant = p.variant(this.target instanceof LumaSwapchainTarget);
    this.pass.setPipeline(variant.handle);
    this.pipeline = p;
    this.variant = variant;
    this.bindingsSet = false;
  }

  setBindings(bindings: RhiBindings): void {
    const p = this.requirePipeline('setBindings');
    const layout = this.variant!.handle.shaderLayout;
    this.pass.setBindings(this.device._toLumaBindings(layout, bindings, `管线「${p.label}」`, (r) => this.list._use(r)));
    this.bindingsSet = true;
  }

  setVertexBuffer(name: string, buffer: RhiBuffer): void {
    const b = asBuffer(buffer, `顶点流「${name}」`);
    requireUsage(b.usage, RhiBufferUsage.VERTEX, `缓冲「${b.label}」作顶点流`, 'VERTEX');
    this.list._use(b);
    this.streams.set(name, b);
  }

  setIndexBuffer(buffer: RhiBuffer | null): void {
    if (buffer == null) {
      this.indexBuffer = null;
      return;
    }
    const b = asBuffer(buffer, '索引缓冲');
    requireUsage(b.usage, RhiBufferUsage.INDEX, `缓冲「${b.label}」作索引`, 'INDEX');
    if (!b.indexFormat) throw new RhiError('invalid-usage', `索引缓冲「${b.label}」创建时没给 indexFormat`);
    this.list._use(b);
    this.indexBuffer = b;
  }

  /** 坐标一律左上角为原点(WebGPU 约定);WebGL2 画布的左下原点由后端换算 */
  setViewport(x: number, y: number, width: number, height: number): void {
    this.pass.setParameters({ viewport: [x, this.glY(y, height), width, height, 0, 1] });
  }

  setScissor(x: number, y: number, width: number, height: number): void {
    this.pass.setParameters({ scissorRect: [x, this.glY(y, height), width, height] });
  }

  /** WebGL2 离屏目标已经按 Y 翻转渲染,行序与 WebGPU 相同;只有画布要从左下原点换算 */
  private glY(y: number, height: number): number {
    if (this.device.caps.backend === 'webgl2' && this.target instanceof LumaSwapchainTarget) {
      return this.target.height - y - height;
    }
    return y;
  }

  draw(vertexCount: number, instanceCount = 1, firstVertex = 0, firstInstance = 0): void {
    const p = this.prepareDraw(false);
    const drawn = this.pass.draw({ vertexCount, instanceCount, firstVertex, firstInstance, isInstanced: instanceCount > 1 });
    this.count(p, drawn);
  }

  drawIndexed(indexCount: number, instanceCount = 1, firstIndex = 0, baseVertex = 0, firstInstance = 0): void {
    const p = this.prepareDraw(true);
    const drawn = this.pass.draw({ indexCount, instanceCount, firstIndex, baseVertex, firstInstance, isInstanced: instanceCount > 1 });
    this.count(p, drawn);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.pass.end();
    this.list._passEnded();
  }

  private requirePipeline(what: string): LumaRhiRenderPipeline {
    if (!this.pipeline) throw new RhiError('invalid-usage', `render pass「${this.label}」${what}:还没 setPipeline`);
    this.pipeline.assertAlive(`render pass「${this.label}」${what}`);
    return this.pipeline;
  }

  private prepareDraw(indexed: boolean): LumaRhiRenderPipeline {
    const p = this.requirePipeline('draw');
    const v = this.variant!;
    if (!this.bindingsSet && v.handle.shaderLayout.bindings.length > 0) {
      throw new RhiError('invalid-usage', `管线「${p.label}」需要资源绑定:setPipeline 之后先 setBindings 再 draw`);
    }
    const va = v.vertexArray;
    for (const [name, slots] of v.streamSlots) {
      const buf = this.streams.get(name);
      if (!buf) throw new RhiError('invalid-usage', `管线「${p.label}」的顶点流「${name}」没绑定缓冲`);
      buf.assertAlive(`顶点流「${name}」`);
      for (const slot of slots) va.setBuffer(slot, buf.handle);
    }
    if (indexed) {
      if (!this.indexBuffer) throw new RhiError('invalid-usage', `drawIndexed 之前没 setIndexBuffer(管线「${p.label}」)`);
      this.indexBuffer.assertAlive('索引缓冲');
      va.setIndexBuffer(this.indexBuffer.handle);
    } else if (this.device.caps.backend === 'webgl2') {
      // WebGL2 下"有没有索引缓冲"就是"是不是索引绘制",非索引绘制必须摘掉
      va.setIndexBuffer(null);
    }
    this.pass.setVertexArray(va);
    return p;
  }

  private count(p: LumaRhiRenderPipeline, drawn: boolean): void {
    if (drawn) this.stats.draws++;
    else {
      this.stats.skippedDraws++;
      this.device._warnSkippedDraw(p);
    }
  }
}

class LumaComputePassEncoder implements RhiComputePassEncoder {
  private pipeline: LumaRhiComputePipeline | null = null;
  private bindingsSet = false;
  private ended = false;

  constructor(
    private readonly device: LumaRhiDevice,
    private readonly list: LumaCommandList,
    private readonly pass: ComputePass,
    private readonly label: string,
    private readonly stats: RhiFrameStats,
  ) {}

  setPipeline(pipeline: RhiComputePipeline): void {
    const p = asComputePipeline(pipeline, `compute pass「${this.label}」setPipeline`);
    this.pass.setPipeline(p.handle);
    this.pipeline = p;
    this.bindingsSet = false;
  }

  setBindings(bindings: RhiBindings): void {
    if (!this.pipeline) throw new RhiError('invalid-usage', `compute pass「${this.label}」setBindings:还没 setPipeline`);
    // luma 的 ComputePass 基类没声明 setBindings,只有 WebGPU 实现有;compute 只在 WebGPU 上开放
    (this.pass as ComputePass & { setBindings(b: Bindings): void }).setBindings(
      this.device._toLumaBindings(this.pipeline.handle.shaderLayout, bindings, `管线「${this.pipeline.label}」`, (r) => this.list._use(r)),
    );
    this.bindingsSet = true;
  }

  dispatch(x: number, y = 1, z = 1): void {
    if (!this.pipeline) throw new RhiError('invalid-usage', `compute pass「${this.label}」dispatch:还没 setPipeline`);
    this.pipeline.assertAlive(`compute pass「${this.label}」dispatch`);
    if (!this.bindingsSet && this.pipeline.handle.shaderLayout.bindings.length > 0) {
      throw new RhiError('invalid-usage', `管线「${this.pipeline.label}」需要资源绑定:setPipeline 之后先 setBindings 再 dispatch`);
    }
    this.pass.dispatch(x, y, z);
    this.stats.dispatches++;
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.pass.end();
    this.list._passEnded();
  }
}

// ───────────────────────────── 设备

function emptyStats(frame: number): RhiFrameStats {
  return { frame, renderPasses: 0, computePasses: 0, draws: 0, dispatches: 0, skippedDraws: 0 };
}

export class LumaRhiDevice implements RhiDevice, RhiResourceFactory {
  readonly caps: RhiCaps;
  readonly info: RhiDeviceInfo;
  readonly rootScope: RhiResourceScope;
  readonly lost: Promise<string>;
  private _isLost = false;
  private readonly releases: RhiReleaseQueue;
  private readonly listeners = new Set<RhiDiagnosticListener>();
  private readonly swapchain: LumaSwapchainTarget;
  private readonly warnedSkips = new WeakSet<object>();
  private frameIndex = 0;
  /** 正在录制的命令表(submit 里可以嵌套 runFrame 之外的 submit,所以是栈) */
  private readonly recordings: LumaCommandList[] = [];
  private _lastFrameStats: RhiFrameStats = emptyStats(-1);
  private _destroyed = false;

  constructor(readonly luma: Device) {
    const backend = toRhiBackend(luma.type);
    const compute = backend === 'webgpu';
    const L = luma.limits;
    this.caps = {
      backend,
      compute,
      storageTextures: compute,
      float16RenderTargets: luma.isTextureFormatRenderable('rgba16float'),
      float32RenderTargets: luma.isTextureFormatRenderable('rgba32float'),
      float32Filterable: luma.isTextureFormatFilterable('rgba32float'),
      maxTextureSize: L.maxTextureDimension2D,
      maxColorAttachments: L.maxColorAttachments,
      maxComputeWorkgroupSize: compute ? [L.maxComputeWorkgroupSizeX, L.maxComputeWorkgroupSizeY, L.maxComputeWorkgroupSizeZ] : [0, 0, 0],
      maxComputeInvocationsPerWorkgroup: compute ? L.maxComputeInvocationsPerWorkgroup : 0,
      swapchainFormat: luma.preferredColorFormat as RhiColorFormat,
    };
    this.info = { backend, vendor: luma.info.vendor, renderer: luma.info.renderer };
    this.releases = new RhiReleaseQueue((e) => this.report(e, 'error'));
    this.rootScope = new RhiResourceScope('设备', this, null);
    this.swapchain = new LumaSwapchainTarget(this.rootScope, this.releases, luma.getDefaultCanvasContext(), this.caps.swapchainFormat);
    this.lost = luma.lost.then((info) => {
      this._isLost = true;
      const reason = info?.message || info?.reason || '未知原因';
      if (!this._destroyed) this.report(new RhiError('backend', `图形设备丢失:${reason}`), 'error');
      return reason;
    });
  }

  get isLost(): boolean {
    return this._isLost;
  }

  get lastFrameStats(): RhiFrameStats {
    return this._lastFrameStats;
  }

  createScope(label: string, parent: RhiResourceScope = this.rootScope): RhiResourceScope {
    return parent.createChild(label);
  }

  // ── 资源工厂(只经作用域调用)

  createBuffer(scope: RhiResourceScope, desc: RhiBufferDesc): RhiBuffer {
    const size = desc.size ?? desc.data?.byteLength ?? 0;
    if (!(size > 0)) throw new RhiError('invalid-usage', `缓冲「${desc.label}」大小必须 > 0`);
    if (desc.data && desc.data.byteLength > size) {
      throw new RhiError('invalid-usage', `缓冲「${desc.label}」的初始数据(${desc.data.byteLength} 字节)超过大小 ${size}`);
    }
    if ((desc.usage & RhiBufferUsage.STORAGE) && !this.caps.compute) {
      throw new RhiError('unsupported', `缓冲「${desc.label}」要存储用途,当前后端(${this.caps.backend})不支持`);
    }
    if ((desc.usage & RhiBufferUsage.INDEX) && !desc.indexFormat) {
      throw new RhiError('invalid-usage', `索引缓冲「${desc.label}」要给 indexFormat`);
    }
    const handle = this.luma.createBuffer({
      id: desc.label,
      usage: toLumaBufferUsage(desc.usage),
      byteLength: size,
      data: desc.data ?? null,
      indexType: desc.indexFormat,
    });
    return new LumaRhiBuffer(scope, this.releases, handle, size, desc.usage, desc.indexFormat, desc.label);
  }

  createTexture(scope: RhiResourceScope, desc: RhiTextureDesc): RhiTexture {
    if (!(desc.width > 0 && desc.height > 0)) {
      throw new RhiError('invalid-usage', `纹理「${desc.label}」尺寸非法:${desc.width}×${desc.height}`);
    }
    if (desc.width > this.caps.maxTextureSize || desc.height > this.caps.maxTextureSize) {
      throw new RhiError('unsupported', `纹理「${desc.label}」${desc.width}×${desc.height} 超过设备上限 ${this.caps.maxTextureSize}`);
    }
    if ((desc.usage & RhiTextureUsage.STORAGE) && !this.caps.storageTextures) {
      throw new RhiError('unsupported', `纹理「${desc.label}」要存储用途,当前后端(${this.caps.backend})不支持`);
    }
    if ((desc.usage & RhiTextureUsage.RENDER_TARGET) && !isDepthFormat(desc.format) && !this.luma.isTextureFormatRenderable(toLumaTextureFormat(desc.format))) {
      throw new RhiError('unsupported', `纹理「${desc.label}」的格式 ${desc.format} 在当前后端不能当渲染目标`);
    }
    const isImage = desc.data != null && !ArrayBuffer.isView(desc.data);
    // 上传初始内容需要拷贝目标用途;图像源在 WebGPU 上走 copyExternalImageToTexture,还要求可作渲染附件
    let usage = desc.usage;
    if (desc.data != null) usage |= RhiTextureUsage.COPY_DST;
    if (isImage) usage |= RhiTextureUsage.RENDER_TARGET;
    const handle = this.luma.createTexture({
      id: desc.label,
      width: desc.width,
      height: desc.height,
      format: toLumaTextureFormat(desc.format),
      usage: toLumaTextureUsage(usage),
      mipLevels: desc.mipLevels ?? 1,
      // 总是显式给采样状态:两个后端的缺省采样器不一样,缺省值统一由 RHI 定(clamp + 线性)
      sampler: toLumaSamplerProps(desc.sampler ?? {}),
    });
    const tex = new LumaRhiTexture(scope, this.releases, handle, usage, desc.label);
    if (isImage) this.uploadImage(tex, desc.data as RhiImageSource, { premultiplyAlpha: desc.premultiplyAlpha, flipY: desc.flipY });
    else if (desc.data != null) this.writeTexture(tex, desc.data as ArrayBufferView);
    return tex;
  }

  createSampler(scope: RhiResourceScope, desc: RhiSamplerDesc): RhiSampler {
    const handle = this.luma.createSampler(toLumaSamplerProps(desc));
    return new LumaRhiSampler(scope, this.releases, handle, desc.label ?? 'sampler');
  }

  createShader(scope: RhiResourceScope, desc: RhiShaderDesc): RhiShader {
    if (this.caps.backend === 'webgpu') {
      if (!desc.wgsl) throw new RhiError('unsupported', `着色器「${desc.label}」没有 WGSL 源,WebGPU 后端用不了`);
      const entry = {
        vertex: desc.entryPoints?.vertex ?? findEntry(desc.wgsl, 'vertex'),
        fragment: desc.entryPoints?.fragment ?? findEntry(desc.wgsl, 'fragment'),
        compute: desc.entryPoints?.compute ?? findEntry(desc.wgsl, 'compute'),
      };
      const module = this.luma.createShader({ id: desc.label, source: desc.wgsl, language: 'wgsl' });
      const render = entry.vertex && entry.fragment ? module : null;
      return new LumaRhiShader(scope, this.releases, desc.label, render, render, entry.compute ? module : null, entry);
    }
    if (!desc.glsl) {
      const why = desc.wgsl && findEntry(desc.wgsl, 'compute') ? '(计算着色器在 WebGL2 上不可用)' : '';
      throw new RhiError('unsupported', `着色器「${desc.label}」没有 GLSL 源,WebGL2 后端用不了${why}`);
    }
    const vs = this.luma.createShader({ id: `${desc.label}:vs`, stage: 'vertex', source: desc.glsl.vertex, language: 'glsl' });
    const fs = this.luma.createShader({ id: `${desc.label}:fs`, stage: 'fragment', source: desc.glsl.fragment, language: 'glsl' });
    return new LumaRhiShader(scope, this.releases, desc.label, vs, fs, null, {}, desc.glsl.vertex);
  }

  createRenderPipeline(scope: RhiResourceScope, desc: RhiRenderPipelineDesc): RhiRenderPipeline {
    const shader = asShader(desc.shader, `管线「${desc.label}」`);
    if (!shader.hasRender) throw new RhiError('invalid-usage', `管线「${desc.label}」:着色器「${shader.label}」没有顶点 + 片元入口`);
    if (desc.colorFormats.length > this.caps.maxColorAttachments) {
      throw new RhiError('unsupported', `管线「${desc.label}」要 ${desc.colorFormats.length} 个颜色附件,设备上限 ${this.caps.maxColorAttachments}`);
    }
    const bufferLayout = toLumaBufferLayout(desc.vertexBuffers);
    const build = (vs: Shader, flipY: boolean): PipelineVariant => {
      const handle = this.luma.createRenderPipeline({
        id: flipY ? `${desc.label}:flipY` : desc.label,
        vs,
        fs: shader.fs,
        vertexEntryPoint: shader.entryPoints.vertex,
        fragmentEntryPoint: shader.entryPoints.fragment,
        bufferLayout,
        topology: desc.topology ?? 'triangle-list',
        colorAttachmentFormats: desc.colorFormats.map(toLumaTextureFormat) as never,
        depthStencilAttachmentFormat: desc.depthFormat ? (toLumaTextureFormat(desc.depthFormat) as never) : undefined,
        parameters: toLumaPipelineParameters(flipY ? { ...desc, cullMode: swapCull(desc.cullMode) } : desc),
      });
      const vertexArray = this.luma.createVertexArray({ shaderLayout: handle.shaderLayout, bufferLayout });
      return { handle, vertexArray, streamSlots: this.resolveStreamSlots(handle, vertexArray, desc) };
    };
    const onscreen = build(shader.vs!, false);
    // WebGL2:离屏目标用 Y 翻转变体渲染,纹理行序与 WebGPU 一致(第 0 行 = 画面顶部)。两个变体都预先建好,
    // 不在第一次用到时现建——现建的那几帧 draw 会因为还没链接完被跳过。
    const offscreen = this.caps.backend === 'webgl2' ? build(shader.flippedVs(this.luma), true) : onscreen;
    return new LumaRhiRenderPipeline(
      scope, this.releases, desc.label, offscreen, onscreen,
      [...desc.colorFormats], desc.depthFormat ?? null,
      [...new Set([shader.vs!, shader.fs!, offscreen.handle.vs ?? shader.vs!])],
      (e) => this.report(e, 'error'),
    );
  }

  createComputePipeline(scope: RhiResourceScope, desc: RhiComputePipelineDesc): RhiComputePipeline {
    if (!this.caps.compute) {
      throw new RhiError('unsupported', `计算管线「${desc.label}」:当前后端(${this.caps.backend})没有 compute`);
    }
    const shader = asShader(desc.shader, `计算管线「${desc.label}」`);
    if (!shader.cs) throw new RhiError('invalid-usage', `计算管线「${desc.label}」:着色器「${shader.label}」没有计算入口`);
    const handle = this.luma.createComputePipeline({ id: desc.label, shader: shader.cs, entryPoint: shader.entryPoints.compute });
    return new LumaRhiComputePipeline(scope, this.releases, desc.label, handle, [shader.cs], (e) => this.report(e, 'error'));
  }

  createRenderTarget(scope: RhiResourceScope, desc: RhiRenderTargetDesc): RhiRenderTarget {
    if (desc.colors.length === 0 && !desc.depth) {
      throw new RhiError('invalid-usage', `渲染目标「${desc.label}」至少要一个附件`);
    }
    const colors = desc.colors.map((c, i) => asTexture(c, `渲染目标「${desc.label}」颜色附件 ${i}`));
    const depth = desc.depth ? asTexture(desc.depth, `渲染目标「${desc.label}」深度附件`) : null;
    const all = depth ? [...colors, depth] : colors;
    const { width, height } = all[0];
    for (const t of all) {
      if (t.width !== width || t.height !== height) {
        throw new RhiError('invalid-usage', `渲染目标「${desc.label}」附件尺寸不一致:「${t.label}」${t.width}×${t.height} ≠ ${width}×${height}`);
      }
      requireUsage(t.usage, RhiTextureUsage.RENDER_TARGET, `纹理「${t.label}」作附件`, 'RENDER_TARGET');
    }
    for (const c of colors) {
      if (isDepthFormat(c.format)) throw new RhiError('invalid-usage', `「${c.label}」是深度格式,不能当颜色附件`);
    }
    if (depth && !isDepthFormat(depth.format)) throw new RhiError('invalid-usage', `「${depth.label}」不是深度格式,不能当深度附件`);
    const framebuffer = this.luma.createFramebuffer({
      id: desc.label,
      width,
      height,
      colorAttachments: colors.map((c) => c.handle),
      depthStencilAttachment: depth?.handle ?? null,
    });
    return new LumaRhiRenderTarget(scope, this.releases, desc.label, framebuffer, colors, depth);
  }

  // ── 数据上传 / 回读

  writeBuffer(buffer: RhiBuffer, data: ArrayBufferView, byteOffset = 0): void {
    const b = asBuffer(buffer, 'writeBuffer');
    this.assertNotInFlight(b, 'writeBuffer');
    if (byteOffset + data.byteLength > b.size) {
      throw new RhiError('invalid-usage', `writeBuffer 越界:缓冲「${b.label}」大小 ${b.size},写 [${byteOffset}, ${byteOffset + data.byteLength})`);
    }
    b.handle.write(data, byteOffset);
  }

  writeTexture(texture: RhiTexture, data: ArrayBufferView, region: { x?: number; y?: number; width?: number; height?: number } = {}): void {
    const t = asTexture(texture, 'writeTexture');
    this.assertNotInFlight(t, 'writeTexture');
    requireUsage(t.usage, RhiTextureUsage.COPY_DST, `纹理「${t.label}」写入`, 'COPY_DST');
    t.handle.writeData(data, {
      x: region.x ?? 0,
      y: region.y ?? 0,
      width: region.width ?? t.width,
      height: region.height ?? t.height,
    });
  }

  uploadImage(texture: RhiTexture, image: RhiImageSource, opts: { premultiplyAlpha?: boolean; flipY?: boolean } = {}): void {
    const t = asTexture(texture, 'uploadImage');
    this.assertNotInFlight(t, 'uploadImage');
    requireUsage(t.usage, RhiTextureUsage.COPY_DST, `纹理「${t.label}」上传图像`, 'COPY_DST');
    t.handle.copyExternalImage({
      image,
      premultipliedAlpha: opts.premultiplyAlpha ?? false,
      flipY: opts.flipY ?? false,
    });
  }

  async readBuffer(buffer: RhiBuffer, byteOffset = 0, size?: number): Promise<Uint8Array> {
    const b = asBuffer(buffer, 'readBuffer');
    requireUsage(b.usage, RhiBufferUsage.COPY_SRC, `回读缓冲「${b.label}」`, 'COPY_SRC');
    const len = size ?? b.size - byteOffset;
    return b.handle.readAsync(byteOffset, len);
  }

  async readTexture(texture: RhiTexture): Promise<RhiTextureReadback> {
    const t = asTexture(texture, 'readTexture');
    requireUsage(t.usage, RhiTextureUsage.COPY_SRC, `回读纹理「${t.label}」`, 'COPY_SRC');
    const layout = t.handle.computeMemoryLayout({});
    const staging = this.luma.createBuffer({
      id: `readback:${t.label}`,
      usage: LumaBufferClass.COPY_DST | LumaBufferClass.MAP_READ,
      byteLength: layout.byteLength,
    });
    try {
      t.handle.readBuffer({}, staging);
      const bytes = await staging.readAsync(0, layout.byteLength);
      return {
        width: t.width,
        height: t.height,
        format: t.format,
        data: stripRowPadding(bytes, t.width, t.height, layout.bytesPerPixel, layout.bytesPerRow),
      };
    } finally {
      staging.destroy();
    }
  }

  // ── 帧

  runFrame(record: (frame: RhiFrame) => void): boolean {
    if (this._isLost || this._destroyed) return false;
    const stats = emptyStats(this.frameIndex);
    let commands: LumaCommandList | null = null;
    this.releases.beginRecording();
    try {
      this.swapchain._beginFrame();
      commands = new LumaCommandList(this, `帧 ${this.frameIndex}`, stats);
      this.recordings.push(commands);
      record({ index: this.frameIndex, commands, swapchain: this.swapchain });
      commands._submit();
      return true;
    } catch (e) {
      commands?._abandon();
      this.report(e, 'error');
      return false;
    } finally {
      if (commands) this.recordings.splice(this.recordings.indexOf(commands), 1);
      this.swapchain._endFrame();
      this._lastFrameStats = stats;
      this.frameIndex++;
      this.releases.endRecording();
    }
  }

  submit(label: string, record: (commands: RhiCommandList) => void): boolean {
    if (this._isLost || this._destroyed) return false;
    const stats = emptyStats(this.frameIndex);
    let commands: LumaCommandList | null = null;
    this.releases.beginRecording();
    try {
      commands = new LumaCommandList(this, label, stats);
      this.recordings.push(commands);
      record(commands);
      commands._submit();
      return true;
    } catch (e) {
      commands?._abandon();
      this.report(e, 'error');
      return false;
    } finally {
      if (commands) this.recordings.splice(this.recordings.indexOf(commands), 1);
      this.releases.endRecording();
    }
  }

  onDiagnostic(listener: RhiDiagnosticListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  destroy(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    this.rootScope.destroy();
    this.releases.flush();
    this.listeners.clear();
    this.luma.destroy();
  }

  // ── 内部

  /**
   * @internal RHI 绑定 → luma 绑定;只保留着色器里声明了的名字,缺项当场报。
   *
   * 采样器按命名约定配给纹理:「纹理名 + Sampler」。配上的采样器**不单独进绑定**,而是设成纹理当前的
   * 采样器——luma 的 WebGPU 路径会按「纹理名Sampler」自动补上纹理自带的采样器(再单独传一份就是重复
   * 绑定,建 bind group 失败),WebGL2 本来就没有独立采样器。两个后端于是走同一条路。
   * 着色器声明了「纹理名Sampler」而调用方没给采样器时,用纹理创建时的采样状态。
   */
  _toLumaBindings(
    layout: ShaderLayout | ComputeShaderLayout,
    bindings: RhiBindings,
    where: string,
    use: (r: LumaRhiBuffer | LumaRhiTexture) => void,
  ): Bindings {
    const declared = new Set(layout.bindings.map((b) => b.name));
    const out: Bindings = {};
    for (const [name, res] of Object.entries(bindings)) {
      if (res instanceof LumaRhiSampler && name.endsWith(SAMPLER_SUFFIX)) {
        const texName = name.slice(0, -SAMPLER_SUFFIX.length);
        const tex = bindings[texName];
        if (tex instanceof LumaRhiTexture) {
          res.assertAlive(`${where} 绑定 ${name}`);
          tex.assertAlive(`${where} 绑定 ${texName}`);
          if (declared.has(texName) && tex.handle.sampler !== res.handle) tex.handle.setSampler(res.handle);
          continue;
        }
      }
      if (!declared.has(name)) continue;
      out[name] = unwrapBinding(res, `${where} 绑定 ${name}`, use);
    }
    const missing = [...declared].filter((n) => {
      if (n in out) return false;
      if (!n.endsWith(SAMPLER_SUFFIX)) return true;
      // 「纹理名Sampler」:纹理给了就用纹理的采样器
      return !(bindings[n.slice(0, -SAMPLER_SUFFIX.length)] instanceof LumaRhiTexture);
    });
    if (missing.length) {
      throw new RhiError('invalid-usage', `${where}:着色器需要的绑定没给 —— ${missing.join(', ')}`);
    }
    return out;
  }

  /** @internal luma 报上来的后端错误 */
  _reportBackendError(error: unknown): void {
    this.report(error instanceof RhiError ? error : new RhiError('backend', error instanceof Error ? error.message : String(error)), 'error');
  }

  /** @internal WebGL2 着色器还没链接完时 luma 会跳过 draw;每条管线只报一次 */
  _warnSkippedDraw(p: LumaRhiRenderPipeline): void {
    if (this.warnedSkips.has(p)) return;
    this.warnedSkips.add(p);
    this.report(
      new RhiError('backend', `管线「${p.label}」的 draw 被后端跳过(着色器尚未就绪或纹理未就绪);要避免就在首次使用前 await pipeline.ready`),
      'warning',
    );
  }

  /**
   * 录制期间,本批命令已经引用过的资源不许再写:WebGPU 的写入走队列,在整批命令执行**之前**生效
   * (前面的 draw 也会看到新值);WebGL2 当场生效(前面的 draw 看到旧值)。两个后端结果不同,
   * 所以直接拒绝。逐次变化的数据用不同缓冲 / 偏移,或者在录制前写好。
   */
  private assertNotInFlight(resource: LumaRhiBuffer | LumaRhiTexture, what: string): void {
    const list = this.recordings.find((r) => r._uses(resource));
    if (list) {
      throw new RhiError(
        'invalid-usage',
        `${what}:「${resource.label}」已被正在录制的「${list.label}」引用,录制期间不能再写`
          + '(WebGPU 下写入在整批命令之前生效、WebGL2 下当场生效,两后端结果会不同;请换缓冲 / 偏移,或在录制前写好)',
      );
    }
  }

  private resolveStreamSlots(handle: RenderPipeline, va: VertexArray, desc: RhiRenderPipelineDesc): Map<string, number[]> {
    const slots = new Map<string, number[]>();
    const layouts = desc.vertexBuffers ?? [];
    if (layouts.length === 0) return slots;
    if (this.caps.backend === 'webgpu') {
      for (const l of layouts) {
        const slot = va.getBufferSlot(l.name);
        if (slot != null) slots.set(l.name, [slot]);
      }
      return slots;
    }
    const infos = getAttributeInfosFromLayouts(handle.shaderLayout, toLumaBufferLayout(layouts));
    for (const info of Object.values(infos)) {
      const list = slots.get(info.bufferName) ?? [];
      list.push(info.location);
      slots.set(info.bufferName, list);
    }
    return slots;
  }

  private report(error: unknown, severity: RhiDiagnosticSeverity): void {
    const e = error instanceof RhiError ? error : new RhiError('backend', error instanceof Error ? error.message : String(error));
    if (this.listeners.size === 0) {
      if (severity === 'error') console.error(e);
      else console.warn(e);
      return;
    }
    for (const l of this.listeners) {
      try {
        l(e, severity);
      } catch (listenerError) {
        console.error('RHI 诊断监听器自身抛错', listenerError);
      }
    }
  }
}

// ───────────────────────────── 辅助

const SAMPLER_SUFFIX = 'Sampler';

function findEntry(wgsl: string, stage: 'vertex' | 'fragment' | 'compute'): string | undefined {
  const m = new RegExp(`@${stage}(?:\\s+@workgroup_size\\([^)]*\\))?\\s+fn\\s+([A-Za-z_][A-Za-z0-9_]*)`).exec(wgsl)
    ?? new RegExp(`@workgroup_size\\([^)]*\\)\\s+@${stage}\\s+fn\\s+([A-Za-z_][A-Za-z0-9_]*)`).exec(wgsl);
  return m?.[1];
}

/** 等着色器编译、管线链接完成(WebGL2 并行编译、WebGPU 异步校验) */
async function waitPipelineReady(label: string, pipelines: readonly RenderPipeline[], shaders: readonly Shader[]): Promise<void> {
  for (const s of new Set(shaders)) {
    const status = await s.asyncCompilationStatus;
    if (status === 'error') {
      const messages = await s.getCompilationInfo().catch(() => []);
      const text = messages.filter((m) => m.type === 'error').map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('\n');
      throw new RhiError('backend', `管线「${label}」:着色器「${s.id}」编译失败\n${text}`);
    }
  }
  const start = Date.now();
  for (const pipeline of pipelines) {
    for (;;) {
      (pipeline as RenderPipeline & { _syncLinkStatus?: () => void })._syncLinkStatus?.();
      if (pipeline.linkStatus === 'success') break;
      if (pipeline.linkStatus === 'error') throw new RhiError('backend', `管线「${label}」链接 / 校验失败`);
      if (Date.now() - start > 60_000) throw new RhiError('backend', `管线「${label}」等待链接超过 60 秒`);
      await new Promise((r) => setTimeout(r, 4));
    }
  }
}

/**
 * GLSL 顶点着色器的 Y 翻转变体:把用户的 main 改名,外面包一层,末尾把裁剪空间 Y 取反。
 * WebGL2 的帧缓冲第 0 行在底部、WebGPU 在顶部;离屏渲染时翻一下,纹理行序、回读结果、
 * 视口 / 裁剪矩形坐标、gl_FragCoord 就都与 WebGPU 相同,多 pass 链不会一层层倒过来。
 */
function flipClipSpaceY(source: string, label: string): string {
  const re = /\bvoid\s+main\s*\(\s*(?:void\s*)?\)/g;
  const hits = source.match(re)?.length ?? 0;
  if (hits !== 1) {
    throw new RhiError('invalid-usage', `着色器「${label}」的 GLSL 顶点源里要有且只有一个 void main(),实际 ${hits} 个`);
  }
  return `${source.replace(re, 'void rhi_userMain()')}
void main() {
  rhi_userMain();
  gl_Position.y = -gl_Position.y;
}
`;
}

/** Y 翻转后三角形绕序反过来,剔除面跟着换,剔除结果才与 WebGPU 一致 */
function swapCull(mode: RhiRenderPipelineDesc['cullMode']): RhiRenderPipelineDesc['cullMode'] {
  return mode === 'front' ? 'back' : mode === 'back' ? 'front' : mode;
}

function sameFormats(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((f, i) => f === b[i]);
}

function requireUsage(has: number, bit: number, what: string, name: string): void {
  if ((has & bit) === 0) throw new RhiError('invalid-usage', `${what} 需要用途位 ${name}(创建时没给)`);
}

function asBuffer(b: RhiBuffer, what: string): LumaRhiBuffer {
  if (!(b instanceof LumaRhiBuffer)) throw new RhiError('invalid-usage', `${what}:不是本设备的缓冲`);
  b.assertAlive(what);
  return b;
}

function asTexture(t: RhiTexture, what: string): LumaRhiTexture {
  if (!(t instanceof LumaRhiTexture)) throw new RhiError('invalid-usage', `${what}:不是本设备的纹理`);
  t.assertAlive(what);
  return t;
}

function asShader(s: RhiShader, what: string): LumaRhiShader {
  if (!(s instanceof LumaRhiShader)) throw new RhiError('invalid-usage', `${what}:不是本设备的着色器`);
  s.assertAlive(what);
  return s;
}

function asRenderPipeline(p: RhiRenderPipeline, what: string): LumaRhiRenderPipeline {
  if (!(p instanceof LumaRhiRenderPipeline)) throw new RhiError('invalid-usage', `${what}:不是本设备的渲染管线`);
  p.assertAlive(what);
  return p;
}

function asComputePipeline(p: RhiComputePipeline, what: string): LumaRhiComputePipeline {
  if (!(p instanceof LumaRhiComputePipeline)) throw new RhiError('invalid-usage', `${what}:不是本设备的计算管线`);
  p.assertAlive(what);
  return p;
}

function asTarget(t: RhiRenderTarget, what = '渲染目标'): LumaRhiRenderTarget | LumaSwapchainTarget {
  if (!(t instanceof LumaRhiRenderTarget) && !(t instanceof LumaSwapchainTarget)) {
    throw new RhiError('invalid-usage', `${what}:不是本设备的渲染目标`);
  }
  return t;
}

function unwrapBinding(res: RhiBindingResource, what: string, use: (r: LumaRhiBuffer | LumaRhiTexture) => void): Binding {
  if (res instanceof LumaRhiBuffer || res instanceof LumaRhiTexture || res instanceof LumaRhiSampler) {
    res.assertAlive(what);
    if (!(res instanceof LumaRhiSampler)) use(res);
    return res.handle;
  }
  if (typeof res === 'object' && res !== null && 'buffer' in res) {
    const b = asBuffer(res.buffer, what);
    use(b);
    return { buffer: b.handle, offset: res.offset, size: res.size };
  }
  throw new RhiError('invalid-usage', `${what}:不认识的绑定资源`);
}
