/// <reference types="@webgpu/types" />
/**
 * RHI 的 luma.gl 后端(只有 WebGPU,luma.gl 9.4)。
 *
 * 这一层只做三件事:把 RHI 描述符翻成 luma 调用;把 luma 里"静默"的行为(管线未就绪就跳过 draw、
 * 绑定缺项、格式不配)变成当场可见的 RhiError / 诊断;以及执行 RHI 的资源所有权与帧级异常隔离。
 * 上层不许直接碰 luma 对象。
 */
import { luma, Buffer as LumaBufferClass } from '@luma.gl/core';
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
import type {
  RhiBindingResource,
  RhiBindings,
  RhiNativeInterop,
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
  stripRowPadding,
  toLumaBufferLayout,
  toLumaBufferUsage,
  toLumaPipelineParameters,
  toLumaSamplerProps,
  toLumaTextureFormat,
  toLumaTextureUsage,
} from './lumaMapping';

export interface LumaRhiDeviceOptions {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  /** 画布合成方式:世界画布在最底层用 opaque;需要透出下层时用 premultiplied */
  alphaMode?: 'opaque' | 'premultiplied';
  /** true = 按 devicePixelRatio;数字 = 固定比例;false = 1 */
  useDevicePixels?: boolean | number;
  /** 画布 CSS 尺寸变化时自动调整后备缓冲 */
  autoResize?: boolean;
  /** 打开 luma 的调试校验(慢) */
  debug?: boolean;
}

/** 建 WebGPU 设备。环境没有 WebGPU(或拿不到适配器)时抛 RhiError('unsupported'),不回落到别的图形 API。 */
export async function createLumaRhiDevice(options: LumaRhiDeviceOptions): Promise<RhiDevice> {
  const gpu = (globalThis.navigator as Navigator & { gpu?: unknown } | undefined)?.gpu;
  if (!gpu) {
    throw new RhiError('unsupported', '此环境没有 WebGPU(navigator.gpu 不存在;需要 https 或 localhost,且浏览器 / WebView 开启 WebGPU)');
  }
  const sink: { target: LumaRhiDevice | null; early: unknown[] } = { target: null, early: [] };
  let device: Device;
  try {
    device = await luma.createDevice({
      type: 'webgpu',
      adapters: [webgpuAdapter],
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
  } catch (e) {
    throw new RhiError('unsupported', `WebGPU 设备创建失败:${e instanceof Error ? e.message : String(e)}`);
  }
  const rhi = new LumaRhiDevice(device);
  sink.target = rhi;
  for (const e of sink.early) rhi._reportBackendError(e);
  return rhi;
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
    /** 包装的外部纹理:luma 看到外部句柄不会销毁它,这里只拆 luma 的包装 */
    readonly external = false,
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
  constructor(
    scope: RhiResourceScope,
    releases: RhiReleaseQueue,
    label: string,
    readonly module: Shader,
    readonly entryPoints: { vertex?: string; fragment?: string; compute?: string },
  ) {
    super('shader', label, scope, releases);
  }

  get hasRender(): boolean {
    return this.entryPoints.vertex != null && this.entryPoints.fragment != null;
  }

  get hasCompute(): boolean {
    return this.entryPoints.compute != null;
  }

  protected releaseBackend(): void {
    this.module.destroy();
  }
}

class LumaRhiRenderPipeline extends RhiResourceBase<'render-pipeline'> implements RhiRenderPipeline {
  private _isReady = false;
  readonly ready: Promise<void>;

  constructor(
    scope: RhiResourceScope,
    releases: RhiReleaseQueue,
    label: string,
    readonly handle: RenderPipeline,
    readonly vertexArray: VertexArray,
    /** 顶点流名 → luma 的逻辑缓冲槽 */
    readonly streamSlots: ReadonlyMap<string, number>,
    readonly colorFormats: readonly RhiColorFormat[],
    readonly depthFormat: RhiDepthFormat | null,
    shaders: readonly Shader[],
    onFail: (e: unknown) => void,
  ) {
    super('render-pipeline', label, scope, releases);
    this.ready = waitPipelineReady(label, [handle], shaders).then(() => {
      this._isReady = true;
    });
    this.ready.catch(onFail);
  }

  get isReady(): boolean {
    return this._isReady;
  }

  protected releaseBackend(): void {
    this.vertexArray.destroy();
    this.handle.destroy();
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
  private armed = false;

  constructor(
    scope: RhiResourceScope,
    releases: RhiReleaseQueue,
    private readonly context: CanvasContext,
    private readonly format: RhiColorFormat,
    /** 附带的深度 / 模板格式(由画布上下文持有、随画布尺寸重建) */
    private readonly depth: RhiDepthFormat | null = null,
  ) {
    super('render-target', depth ? `画布后备缓冲+${depth}` : '画布后备缓冲', scope, releases);
  }

  /**
   * 每次取都向画布上下文要(同一帧拿到的是同一张颜色纹理)。luma 的画布帧缓冲对象只有一个,
   * 带不带深度附件是取的时候重新挂的,所以不能缓存。
   */
  get framebuffer(): Framebuffer {
    if (!this.armed) throw new RhiError('invalid-usage', '画布后备缓冲只能在 runFrame 的录制期内使用');
    return this.context.getCurrentFramebuffer({ depthStencilFormat: (this.depth ?? false) as never });
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
    return this.depth;
  }

  override destroy(): void {
    throw new RhiError('invalid-usage', '画布后备缓冲归设备所有,不能单独销毁');
  }

  _beginFrame(): void {
    this.armed = true;
  }

  _endFrame(): void {
    this.armed = false;
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
    // pass 描述符自己拼(luma 的 WebGPU pass 不设模板附件的 load / store,带模板的深度格式会校验失败),
    // 再把现成的 GPURenderPassEncoder 交给 luma 包装(luma 的 `handle` 属性)。
    const framebuffer = target.framebuffer as Framebuffer & {
      colorAttachments: Array<{ handle: GPUTextureView }>;
      depthStencilAttachment: { handle: GPUTextureView } | null;
    };
    const colorAttachments: GPURenderPassColorAttachment[] = target.colorFormats.map((format, i) => {
      const op = colorOps[i] ?? { load: 'clear' as const };
      const v = op.load === 'clear' ? op.clearValue ?? [0, 0, 0, 0] : [0, 0, 0, 0];
      return {
        view: framebuffer.colorAttachments[i].handle,
        loadOp: op.load,
        storeOp: 'store',
        // 整数格式的清屏值按整数解释;浮点 / 归一化格式按浮点
        clearValue: format.endsWith('uint') ? v.map((x) => Math.trunc(x)) : v,
      };
    });
    let depthStencilAttachment: GPURenderPassDepthStencilAttachment | undefined;
    const depthFormat = target.depthFormat;
    if (depthFormat && framebuffer.depthStencilAttachment) {
      const depthOp = desc.depthOp ?? { load: 'clear' as const };
      depthStencilAttachment = {
        view: framebuffer.depthStencilAttachment.handle,
        depthLoadOp: depthOp.load,
        depthStoreOp: 'store',
        depthClearValue: depthOp.load === 'clear' ? depthOp.clearValue ?? 1 : undefined,
      };
      if (depthFormat.includes('stencil')) {
        const stencilOp = desc.stencilOp ?? { load: 'clear' as const };
        depthStencilAttachment.stencilLoadOp = stencilOp.load;
        depthStencilAttachment.stencilStoreOp = 'store';
        if (stencilOp.load === 'clear') depthStencilAttachment.stencilClearValue = stencilOp.clearValue ?? 0;
      }
    }
    const gpuEncoder = (this.encoder as CommandEncoder & { handle: GPUCommandEncoder }).handle;
    const handle = gpuEncoder.beginRenderPass({ label: desc.label, colorAttachments, depthStencilAttachment });
    const pass = this.encoder.beginRenderPass({ id: desc.label, framebuffer: target.framebuffer, handle } as never);
    this.stats.renderPasses++;
    const enc = new LumaRenderPassEncoder(this.device, this, pass, target, desc.label, this.stats);
    this.openPass = enc;
    return enc;
  }

  beginComputePass(label: string): RhiComputePassEncoder {
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
    this.encoder.copyBufferToBuffer({
      sourceBuffer: s.handle,
      sourceOffset: srcOffset,
      destinationBuffer: d.handle,
      destinationOffset: dstOffset,
      size,
    });
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
    this.encoder.copyTextureToTexture({ sourceTexture: s.handle, destinationTexture: d.handle, width: w, height: h });
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
}

class LumaRenderPassEncoder implements RhiRenderPassEncoder {
  private pipeline: LumaRhiRenderPipeline | null = null;
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
    this.pass.setPipeline(p.handle);
    this.pipeline = p;
    this.bindingsSet = false;
  }

  setBindings(bindings: RhiBindings): void {
    const p = this.requirePipeline('setBindings');
    this.pass.setBindings(this.device._toLumaBindings(p.handle.shaderLayout, bindings, `管线「${p.label}」`, (r) => this.list._use(r)));
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

  /** 坐标左上角为原点 */
  setViewport(x: number, y: number, width: number, height: number): void {
    this.pass.setParameters({ viewport: [x, y, width, height, 0, 1] });
  }

  setScissor(x: number, y: number, width: number, height: number): void {
    this.pass.setParameters({ scissorRect: [x, y, width, height] });
  }

  setStencilReference(reference: number): void {
    // luma 的 setParameters 把参考值 0 当"没给"跳过,直接调底层
    (this.pass as RenderPass & { handle: GPURenderPassEncoder }).handle.setStencilReference(reference);
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
    if (!this.bindingsSet && p.handle.shaderLayout.bindings.length > 0) {
      throw new RhiError('invalid-usage', `管线「${p.label}」需要资源绑定:setPipeline 之后先 setBindings 再 draw`);
    }
    const va = p.vertexArray;
    for (const [name, slot] of p.streamSlots) {
      const buf = this.streams.get(name);
      if (!buf) throw new RhiError('invalid-usage', `管线「${p.label}」的顶点流「${name}」没绑定缓冲`);
      buf.assertAlive(`顶点流「${name}」`);
      va.setBuffer(slot, buf.handle);
    }
    if (indexed) {
      if (!this.indexBuffer) throw new RhiError('invalid-usage', `drawIndexed 之前没 setIndexBuffer(管线「${p.label}」)`);
      this.indexBuffer.assertAlive('索引缓冲');
      va.setIndexBuffer(this.indexBuffer.handle);
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
  private readonly swapchainDepth = new Map<RhiDepthFormat, LumaSwapchainTarget>();
  private readonly warnedSkips = new WeakSet<object>();
  private frameIndex = 0;
  /** 正在录制的命令表(submit 里可以嵌套 runFrame 之外的 submit,所以是栈) */
  private readonly recordings: LumaCommandList[] = [];
  private _lastFrameStats: RhiFrameStats = emptyStats(-1);
  private _destroyed = false;

  constructor(readonly luma: Device) {
    const L = luma.limits;
    this.caps = {
      float32Filterable: luma.isTextureFormatFilterable('rgba32float'),
      maxTextureSize: L.maxTextureDimension2D,
      maxColorAttachments: L.maxColorAttachments,
      maxComputeWorkgroupSize: [L.maxComputeWorkgroupSizeX, L.maxComputeWorkgroupSizeY, L.maxComputeWorkgroupSizeZ],
      maxComputeInvocationsPerWorkgroup: L.maxComputeInvocationsPerWorkgroup,
      swapchainFormat: luma.preferredColorFormat as RhiColorFormat,
    };
    this.info = { vendor: luma.info.vendor, renderer: luma.info.renderer };
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

  get native(): RhiNativeInterop {
    const luma = this.luma as Device & { adapter?: { handle?: GPUAdapter }; handle: GPUDevice };
    const adapter = luma.adapter?.handle ?? (luma as unknown as { adapter: GPUAdapter }).adapter;
    return {
      adapter,
      device: luma.handle,
      gpuTexture: (texture) => asTexture(texture, 'native.gpuTexture').handle.handle as GPUTexture,
      wrapTexture: (scope, desc) => {
        const t = desc.texture;
        const handle = this.luma.createTexture({
          id: desc.label,
          handle: t,
          width: t.width,
          height: t.height,
          format: t.format as never,
          mipLevels: t.mipLevelCount,
          usage: t.usage,
          sampler: toLumaSamplerProps({}),
        });
        return scope._adopt(new LumaRhiTexture(scope, this.releases, handle, fromGpuTextureUsage(t.usage), desc.label, true));
      },
    };
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
    if ((desc.usage & RhiTextureUsage.RENDER_TARGET) && !isDepthFormat(desc.format) && !this.luma.isTextureFormatRenderable(toLumaTextureFormat(desc.format))) {
      throw new RhiError('unsupported', `纹理「${desc.label}」的格式 ${desc.format} 在当前后端不能当渲染目标`);
    }
    const isImage = desc.data != null && !ArrayBuffer.isView(desc.data);
    // 上传初始内容需要拷贝目标用途;图像源走 copyExternalImageToTexture,还要求可作渲染附件
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
      // 总是显式给采样状态,缺省值由 RHI 定(clamp + 线性),不依赖 luma 的设备缺省采样器
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
    if (!desc.wgsl) throw new RhiError('invalid-usage', `着色器「${desc.label}」没有 WGSL 源`);
    const entry = {
      vertex: desc.entryPoints?.vertex ?? findEntry(desc.wgsl, 'vertex'),
      fragment: desc.entryPoints?.fragment ?? findEntry(desc.wgsl, 'fragment'),
      compute: desc.entryPoints?.compute ?? findEntry(desc.wgsl, 'compute'),
    };
    if (!entry.vertex && !entry.fragment && !entry.compute) {
      throw new RhiError('invalid-usage', `着色器「${desc.label}」里找不到 @vertex / @fragment / @compute 入口`);
    }
    const module = this.luma.createShader({ id: desc.label, source: desc.wgsl, language: 'wgsl' });
    return new LumaRhiShader(scope, this.releases, desc.label, module, entry);
  }

  createRenderPipeline(scope: RhiResourceScope, desc: RhiRenderPipelineDesc): RhiRenderPipeline {
    const shader = asShader(desc.shader, `管线「${desc.label}」`);
    if (!shader.hasRender) throw new RhiError('invalid-usage', `管线「${desc.label}」:着色器「${shader.label}」没有顶点 + 片元入口`);
    if (desc.colorFormats.length > this.caps.maxColorAttachments) {
      throw new RhiError('unsupported', `管线「${desc.label}」要 ${desc.colorFormats.length} 个颜色附件,设备上限 ${this.caps.maxColorAttachments}`);
    }
    const bufferLayout = toLumaBufferLayout(desc.vertexBuffers);
    const handle = this.luma.createRenderPipeline({
      id: desc.label,
      vs: shader.module,
      fs: shader.module,
      vertexEntryPoint: shader.entryPoints.vertex,
      fragmentEntryPoint: shader.entryPoints.fragment,
      bufferLayout,
      topology: desc.topology ?? 'triangle-list',
      colorAttachmentFormats: desc.colorFormats.map(toLumaTextureFormat) as never,
      // 深度 / 模板格式只经 parameters.depthFormat 给:luma 见到 depthStencilAttachmentFormat 会先建一个
      // 不带 stencilFront / stencilBack 的 depthStencil,之后再设模板参数时解引用 undefined 崩掉
      parameters: toLumaPipelineParameters(desc),
    });
    const vertexArray = this.luma.createVertexArray({ shaderLayout: handle.shaderLayout, bufferLayout });
    const streamSlots = this.resolveStreamSlots(vertexArray, desc);
    return new LumaRhiRenderPipeline(
      scope, this.releases, desc.label, handle, vertexArray, streamSlots,
      [...desc.colorFormats], desc.depthFormat ?? null,
      [shader.module],
      (e) => this.report(e, 'error'),
    );
  }

  createComputePipeline(scope: RhiResourceScope, desc: RhiComputePipelineDesc): RhiComputePipeline {
    const shader = asShader(desc.shader, `计算管线「${desc.label}」`);
    if (!shader.hasCompute) throw new RhiError('invalid-usage', `计算管线「${desc.label}」:着色器「${shader.label}」没有计算入口`);
    const handle = this.luma.createComputePipeline({ id: desc.label, shader: shader.module, entryPoint: shader.entryPoints.compute });
    return new LumaRhiComputePipeline(scope, this.releases, desc.label, handle, [shader.module], (e) => this.report(e, 'error'));
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
      for (const t of this.swapchainDepth.values()) t._beginFrame();
      commands = new LumaCommandList(this, `帧 ${this.frameIndex}`, stats);
      this.recordings.push(commands);
      const swapchainWithDepth = (format: RhiDepthFormat): RhiRenderTarget => {
        let t = this.swapchainDepth.get(format);
        if (!t) {
          t = new LumaSwapchainTarget(this.rootScope, this.releases, this.luma.getDefaultCanvasContext(), this.caps.swapchainFormat, format);
          this.swapchainDepth.set(format, t);
          t._beginFrame();
        }
        return t;
      };
      record({ index: this.frameIndex, commands, swapchain: this.swapchain, swapchainWithDepth });
      commands._submit();
      return true;
    } catch (e) {
      commands?._abandon();
      this.report(e, 'error');
      return false;
    } finally {
      if (commands) this.recordings.splice(this.recordings.indexOf(commands), 1);
      this.swapchain._endFrame();
      for (const t of this.swapchainDepth.values()) t._endFrame();
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
   * 采样器——luma 会按「纹理名Sampler」自动补上纹理自带的采样器,再单独传一份就是同一槽位绑两次,
   * 建 bind group 失败。着色器声明了「纹理名Sampler」而调用方没给采样器时,用纹理创建时的采样状态。
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

  /** @internal 管线还没就绪时 luma 会跳过 draw;每条管线只报一次 */
  _warnSkippedDraw(p: LumaRhiRenderPipeline): void {
    if (this.warnedSkips.has(p)) return;
    this.warnedSkips.add(p);
    this.report(
      new RhiError('backend', `管线「${p.label}」的 draw 被后端跳过(着色器尚未就绪或纹理未就绪);要避免就在首次使用前 await pipeline.ready`),
      'warning',
    );
  }

  /**
   * 录制期间,本批命令已经引用过的资源不许再写:WebGPU 的写入走队列,在**整批命令执行之前**生效,
   * 前面已经录进去的 draw 也会看到新值——不是"写在哪儿就从哪儿生效"。这类 bug 画面上只是数值不对,
   * 所以直接拒绝。逐次变化的数据用不同缓冲 / 偏移,或者在录制前写好。
   */
  private assertNotInFlight(resource: LumaRhiBuffer | LumaRhiTexture, what: string): void {
    const list = this.recordings.find((r) => r._uses(resource));
    if (list) {
      throw new RhiError(
        'invalid-usage',
        `${what}:「${resource.label}」已被正在录制的「${list.label}」引用,录制期间不能再写`
          + '(写入在整批命令执行之前生效,前面录好的命令也会读到新值;请换缓冲 / 偏移,或在录制前写好)',
      );
    }
  }

  private resolveStreamSlots(va: VertexArray, desc: RhiRenderPipelineDesc): Map<string, number> {
    const slots = new Map<string, number>();
    for (const l of desc.vertexBuffers ?? []) {
      const slot = va.getBufferSlot(l.name);
      if (slot == null) throw new RhiError('invalid-usage', `管线「${desc.label}」:顶点流「${l.name}」在着色器里没有对应的属性`);
      slots.set(l.name, slot);
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

/** GPUTextureUsage 位 → RHI 纹理用途位(数值取自 WebGPU 规范,避免在非浏览器环境依赖全局常量) */
function fromGpuTextureUsage(usage: number): number {
  let out = 0;
  if (usage & 0x01) out |= RhiTextureUsage.COPY_SRC;
  if (usage & 0x02) out |= RhiTextureUsage.COPY_DST;
  if (usage & 0x04) out |= RhiTextureUsage.SAMPLED;
  if (usage & 0x08) out |= RhiTextureUsage.STORAGE;
  if (usage & 0x10) out |= RhiTextureUsage.RENDER_TARGET;
  return out;
}

function findEntry(wgsl: string, stage: 'vertex' | 'fragment' | 'compute'): string | undefined {
  const m = new RegExp(`@${stage}(?:\\s+@workgroup_size\\([^)]*\\))?\\s+fn\\s+([A-Za-z_][A-Za-z0-9_]*)`).exec(wgsl)
    ?? new RegExp(`@workgroup_size\\([^)]*\\)\\s+@${stage}\\s+fn\\s+([A-Za-z_][A-Za-z0-9_]*)`).exec(wgsl);
  return m?.[1];
}

/** 等着色器编译、管线校验完成 */
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
