/// <reference types="@webgpu/types" />
/**
 * RHI 的 luma.gl 后端(只有 WebGPU,luma.gl 9.4)。
 *
 * 这一层只做三件事:把 RHI 描述符翻成 luma 调用;把 luma 里"静默"的行为(管线未就绪就跳过 draw、
 * 绑定缺项、格式不配)变成当场可见的 RhiError / 诊断;以及执行 RHI 的资源所有权与帧级异常隔离。
 * 上层不许直接碰 luma 对象。
 */
import { luma, Buffer as LumaBufferClass, _getDefaultBindGroupFactory } from '@luma.gl/core';
import type {
  Bindings,
  Buffer as LumaBuffer,
  CanvasContext,
  CommandEncoder,
  ComputePass,
  ComputePipeline,
  ComputeShaderLayout,
  Device,
  Framebuffer,
  RenderPipeline,
  Sampler,
  Shader,
  ShaderLayout,
  Texture,
  TextureView,
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
import { WebGpuMipmapGenerator } from './lumaMipmaps';
import { SAMPLER_SUFFIX, missingBindings, resolveShaderEntries } from '../backendRules';

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

/**
 * 向适配器要设备时带上它支持的 2D 纹理尺寸上限(R2-1)。master 的 Pixi WebGL 拿的是 GPU 的 MAX_TEXTURE_SIZE
 * (桌面常见 16384);WebGPU 不显式要就只给规范缺省 8192——放大观察物件时 contact-AO 滤镜的池纹理(不裁到视口,
 * 向上取 2 的幂)要 16384 宽,建不出来就整帧失败。luma 只在 featureLevel 'max' 时转发适配器上限,但那一档连
 * 全部特性一起要(会改变 float32-filterable 等),没有按项要的口子,所以在适配器上包一层 requestDevice,
 * 只补这一项;特性照 core 档不多要(Pixi 8.17 的 GpuDeviceSystem 只额外要纹理压缩特性,运行时不用)。
 */
export function requestAdapterTextureLimit(adapter: GPUAdapter): GPUAdapter {
  const requestDevice = adapter.requestDevice.bind(adapter);
  adapter.requestDevice = (desc: GPUDeviceDescriptor = {}) =>
    requestDevice({
      ...desc,
      requiredLimits: { ...desc.requiredLimits, maxTextureDimension2D: adapter.limits.maxTextureDimension2D },
    });
  return adapter;
}

/**
 * luma 的 WebGPU 适配器,只换掉取原生适配器这一步(WebGPUAdapter.requestGPUAdapter:每次建设备都重新
 * `navigator.gpu.requestAdapter`,这里照做再包一层)
 */
const webgpuAdapterWithTextureLimit: typeof webgpuAdapter = Object.create(webgpuAdapter, {
  requestGPUAdapter: {
    value: async (options: GPURequestAdapterOptions): Promise<GPUAdapter | null> => {
      const adapter = await (globalThis.navigator as Navigator & { gpu: GPU }).gpu.requestAdapter(options);
      return adapter && requestAdapterTextureLimit(adapter);
    },
  },
});

/**
 * 建 WebGPU 设备。环境没有 WebGPU(或拿不到适配器)时抛 RhiError('unsupported'),不回落到别的图形 API。
 * 设备丢失(GPU 进程崩溃 / 驱动重置 / TDR / 切显卡)后按同一套参数在同一画布上重建(见 LumaRhiDevice 的「丢失与恢复」)。
 */
export async function createLumaRhiDevice(options: LumaRhiDeviceOptions): Promise<RhiDevice> {
  const gpu = (globalThis.navigator as Navigator & { gpu?: unknown } | undefined)?.gpu;
  if (!gpu) {
    throw new RhiError('unsupported', '此环境没有 WebGPU(navigator.gpu 不存在;需要 https 或 localhost,且浏览器 / WebView 开启 WebGPU)');
  }
  const sink: { target: LumaRhiDevice | null; early: unknown[] } = { target: null, early: [] };
  // 每次都重新要适配器(丢过设备的适配器不能再用);画布上下文参数(格式 / alphaMode / 像素比 / 自动调整)与首次相同
  const open = async (): Promise<Device> => {
    try {
      return await luma.createDevice({
        type: 'webgpu',
        adapters: [webgpuAdapterWithTextureLimit],
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
  };
  const device = await open();
  const rhi = new LumaRhiDevice(device, { recreateDevice: open });
  sink.target = rhi;
  for (const e of sink.early) rhi._reportBackendError(e);
  return rhi;
}

/** 设备丢失后的恢复参数 */
export interface LumaRhiDeviceRecovery {
  /** 按原参数在同一画布上重建 luma 设备(createLumaRhiDevice 给);不给 = 丢失即终局(只报诊断) */
  recreateDevice?: () => Promise<Device>;
  /** 第 i 次重建前等多久(毫秒);次数 = 长度,用尽还没建成就报错放弃 */
  restoreRetryDelaysMs?: readonly number[];
}

/** 重建设备前的等待:GPU 进程重启 / 驱动重置期间适配器可能暂时要不到,逐次放宽,前后约 15 秒 */
const DEFAULT_RESTORE_RETRY_DELAYS_MS: readonly number[] = [0, 250, 1000, 2000, 4000, 8000];

function capsOf(luma: Device): RhiCaps {
  const L = luma.limits;
  return {
    float32Filterable: luma.isTextureFormatFilterable('rgba32float'),
    maxTextureSize: L.maxTextureDimension2D,
    maxColorAttachments: L.maxColorAttachments,
    maxComputeWorkgroupSize: [L.maxComputeWorkgroupSizeX, L.maxComputeWorkgroupSizeY, L.maxComputeWorkgroupSizeZ],
    maxComputeInvocationsPerWorkgroup: L.maxComputeInvocationsPerWorkgroup,
    swapchainFormat: luma.preferredColorFormat as RhiColorFormat,
  };
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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

  get sampleCount(): number {
    return (this.handle as Texture & { samples?: number }).samples ?? 1;
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
    /** 建着色器模块时原生错误作用域接到的错误(没有为 null) */
    readonly creationError: Promise<GPUError | null>,
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

/**
 * 管线的失败状态。着色器编译失败、建管线校验 / 内部错误都会让管线成为无效对象;WebGPU 里拿无效管线 setPipeline
 * 会让整个 pass、进而整批命令作废(一帧全黑)。master(Pixi GL)里坏掉的程序只影响它自己的 draw,
 * 所以确认失败后这条管线的 draw / dispatch 在录制时跳过(计入 skippedDraws、告警一次),帧里其余内容照常提交。
 * 失败是异步才知道的(错误作用域 / 编译信息都是 Promise):知道之前照常画,与未失败的管线行为一致。
 */
class LumaPipelineState {
  isReady = false;
  failed = false;
  readonly ready: Promise<void>;

  constructor(wait: Promise<void>, onFail: (e: unknown) => void) {
    this.ready = wait.then(
      () => {
        this.isReady = true;
      },
      (e: unknown) => {
        this.failed = true;
        throw e;
      },
    );
    this.ready.catch(onFail);
  }
}

class LumaRhiRenderPipeline extends RhiResourceBase<'render-pipeline'> implements RhiRenderPipeline {
  private readonly state: LumaPipelineState;
  /** 顶点流名(数组形式,draw 时不走 Map 迭代器) */
  readonly streamNames: readonly string[];
  /** 原生顶点缓冲槽:第 i 个槽绑 streamNames[vertexSlotStream[i]](-1 = 没有对应的流,不绑),偏移 vertexSlotOffset[i] */
  readonly vertexSlotStream: readonly number[];
  readonly vertexSlotOffset: readonly number[];
  readonly bindings: LumaBindingPlan;

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
    readonly sampleCount: number,
    shaders: readonly LumaRhiShader[],
    creationError: Promise<GPUError | null>,
    onFail: (e: unknown) => void,
  ) {
    super('render-pipeline', label, scope, releases);
    this.streamNames = [...streamSlots.keys()];
    const physical = resolvePhysicalVertexSlots(vertexArray, label);
    const logical = [...streamSlots.values()];
    this.vertexSlotStream = physical.map((slot) => logical.indexOf(slot.logicalSlot));
    this.vertexSlotOffset = physical.map((slot) => slot.bindingOffset);
    this.bindings = new LumaBindingPlan(handle.shaderLayout);
    this.state = new LumaPipelineState(waitPipelineReady(label, [handle], shaders, [creationError]), onFail);
  }

  get ready(): Promise<void> {
    return this.state.ready;
  }

  get isReady(): boolean {
    return this.state.isReady;
  }

  /** 已确认建坏了(着色器编译 / 管线校验 / 内部错误):录制时跳过它的 draw */
  get failed(): boolean {
    return this.state.failed;
  }

  protected releaseBackend(): void {
    this.vertexArray.destroy();
    this.handle.destroy();
  }
}

class LumaRhiComputePipeline extends RhiResourceBase<'compute-pipeline'> implements RhiComputePipeline {
  private readonly state: LumaPipelineState;
  readonly bindings: LumaBindingPlan;

  constructor(
    scope: RhiResourceScope,
    releases: RhiReleaseQueue,
    label: string,
    readonly handle: ComputePipeline,
    shaders: readonly LumaRhiShader[],
    creationError: Promise<GPUError | null>,
    onFail: (e: unknown) => void,
  ) {
    super('compute-pipeline', label, scope, releases);
    this.bindings = new LumaBindingPlan(handle.shaderLayout);
    this.state = new LumaPipelineState(waitPipelineReady(label, [], shaders, [creationError]), onFail);
  }

  get ready(): Promise<void> {
    return this.state.ready;
  }

  get isReady(): boolean {
    return this.state.isReady;
  }

  /** 已确认建坏了:录制时跳过它的 dispatch */
  get failed(): boolean {
    return this.state.failed;
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
    /** 逐颜色附件的 resolve 目标(多重采样附件才有) */
    readonly resolves: readonly (LumaRhiTexture | null)[] = [],
    /** 多级 mip 的附件 / resolve 目标用的 level 0 单级视图(本目标建的,随目标拆) */
    private readonly levelViews: ReadonlyMap<LumaRhiTexture, TextureView> = new Map(),
  ) {
    super('render-target', label, scope, releases);
  }

  get sampleCount(): number {
    return (this.colors[0] ?? this.depth)?.sampleCount ?? 1;
  }

  /** 第 i 个颜色附件的 resolve 视图 */
  resolveView(i: number): GPUTextureView | undefined {
    const r = this.resolves[i];
    if (!r) return undefined;
    const level0 = this.levelViews.get(r);
    return level0 ? (level0 as TextureView & { handle: GPUTextureView }).handle : (r.handle as Texture & { view: { handle: GPUTextureView } }).view.handle;
  }

  get width(): number {
    return this.framebuffer.width;
  }

  get height(): number {
    return this.framebuffer.height;
  }

  /** 附件格式建后不变:算一次(setPipeline 每次都要比对) */
  private formats: readonly RhiColorFormat[] | null = null;

  get colorFormats(): readonly RhiColorFormat[] {
    return (this.formats ??= this.colors.map((c) => c.format as RhiColorFormat));
  }

  get depthFormat(): RhiDepthFormat | null {
    return (this.depth?.format as RhiDepthFormat | undefined) ?? null;
  }

  /** 附件被单独销毁时,目标也就不能再用了 */
  override assertAlive(usage: string): void {
    super.assertAlive(usage);
    for (const c of this.colors) c.assertAlive(`${usage}(渲染目标「${this.label}」的颜色附件)`);
    this.depth?.assertAlive(`${usage}(渲染目标「${this.label}」的深度附件)`);
    for (const r of this.resolves) r?.assertAlive(`${usage}(渲染目标「${this.label}」的 resolve 目标)`);
  }

  protected releaseBackend(): void {
    // 只拆帧缓冲对象与本目标建的单级视图,附件纹理归各自的所有者
    this.framebuffer.destroy();
    for (const v of this.levelViews.values()) v.destroy();
  }
}

/**
 * 画布后备缓冲。只在 runFrame 录制期内可用,**第一次被当作 pass 目标时**才向画布要这一帧的纹理
 * ——这一帧没画到画布就不取(不空耗一次呈现,加载期只做离屏烘焙的帧也不碰画布)。不归任何作用域销毁。
 */
class LumaSwapchainTarget extends RhiResourceBase<'render-target'> implements RhiRenderTarget {
  private armed = false;
  private formats: readonly RhiColorFormat[] | null = null;
  /**
   * 本帧开 pass 用的附件视图(第一次取时从画布帧缓冲拿)。同一帧里画布纹理与深度缓冲不变;luma 的画布帧缓冲对象
   * 在带 / 不带深度的目标之间共用、取的时候才重挂附件,所以缓存视图、不缓存那个对象
   */
  private views: { color: GPUTextureView; depth: GPUTextureView | null } | null = null;

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

  /** 本帧开 pass 用的颜色 / 深度附件视图(每帧只向画布取一次帧缓冲) */
  passViews(): { color: GPUTextureView; depth: GPUTextureView | null } {
    if (!this.views) {
      const fb = this.framebuffer as Framebuffer & {
        colorAttachments: Array<{ handle: GPUTextureView }>;
        depthStencilAttachment: { handle: GPUTextureView } | null;
      };
      this.views = { color: fb.colorAttachments[0].handle, depth: fb.depthStencilAttachment?.handle ?? null };
    }
    return this.views;
  }

  get width(): number {
    return this.context.getDrawingBufferSize()[0];
  }

  get height(): number {
    return this.context.getDrawingBufferSize()[1];
  }

  get colorFormats(): readonly RhiColorFormat[] {
    return (this.formats ??= [this.format]);
  }

  get depthFormat(): RhiDepthFormat | null {
    return this.depth;
  }

  get sampleCount(): number {
    return 1;
  }

  override destroy(): void {
    throw new RhiError('invalid-usage', '画布后备缓冲归设备所有,不能单独销毁');
  }

  _beginFrame(): void {
    this.armed = true;
    this.views = null;
  }

  _endFrame(): void {
    this.armed = false;
    this.views = null;
  }

  protected releaseBackend(): void {}
}

/**
 * 画布 MSAA 的多重采样颜色纹理:同一采样数下、带不带深度的各个画布目标**共用这一张**——遮罩中途给画布补模板时
 * (无深度 pass 以 load 重开成带深度 pass)读到的必须是刚画的内容。按画布纹理尺寸懒建、尺寸变了重建。
 */
class LumaMsaaSwapchainColor {
  texture: Texture | null = null;
  /** 纹理每重建一次加一(带深度的目标据此重建帧缓冲) */
  generation = 0;

  constructor(
    private readonly luma: Device,
    private readonly label: string,
    private readonly format: RhiColorFormat,
    readonly sampleCount: number,
  ) {}

  ensure(w: number, h: number): Texture {
    const t = this.texture;
    if (t && t.width === w && t.height === h) return t;
    t?.destroy();
    this.generation++;
    return (this.texture = this.luma.createTexture({
      id: this.label, width: w, height: h, format: toLumaTextureFormat(this.format),
      usage: toLumaTextureUsage(RhiTextureUsage.RENDER_TARGET), samples: this.sampleCount,
    } as never));
  }

  release(): void {
    this.texture?.destroy();
    this.texture = null;
  }
}

/**
 * 多重采样(MSAA)画布目标:颜色(与可选的深度 / 模板)画进设备持有的多重采样纹理,每个 pass 结束 resolve 到
 * 这一帧的画布纹理。多重采样颜色同采样数共用一张(见 LumaMsaaSwapchainColor),深度各目标自带;都按画布纹理尺寸懒建、
 * 尺寸变了重建;跨 pass、跨帧保留内容。设备销毁时释放。
 */
class LumaMsaaSwapchainTarget extends RhiResourceBase<'render-target'> implements RhiRenderTarget {
  private armed = false;
  private formats: readonly RhiColorFormat[] | null = null;
  private depthTex: Texture | null = null;
  private fb: Framebuffer | null = null;
  private fbGeneration = -1;

  constructor(
    scope: RhiResourceScope,
    releases: RhiReleaseQueue,
    private readonly luma: Device,
    private readonly context: CanvasContext,
    private readonly format: RhiColorFormat,
    private readonly colorStore: LumaMsaaSwapchainColor,
    private readonly depth: RhiDepthFormat | null,
  ) {
    super('render-target', `画布后备缓冲 MSAA×${colorStore.sampleCount}${depth ? `+${depth}` : ''}`, scope, releases);
  }

  get sampleCount(): number {
    return this.colorStore.sampleCount;
  }

  private get canvasFramebuffer(): Framebuffer {
    if (!this.armed) throw new RhiError('invalid-usage', '画布后备缓冲只能在 runFrame 的录制期内使用');
    return this.context.getCurrentFramebuffer({ depthStencilFormat: false as never });
  }

  /** 这一帧画布纹理的视图(resolve 目标) */
  get resolveView(): GPUTextureView {
    return (this.canvasFramebuffer as Framebuffer & { colorAttachments: Array<{ handle: GPUTextureView }> }).colorAttachments[0].handle;
  }

  /** 多重采样附件组成的帧缓冲(先取这一帧的画布纹理,按它的尺寸建 / 重建多重采样纹理) */
  get framebuffer(): Framebuffer {
    const canvasFb = this.canvasFramebuffer;
    const w = canvasFb.width;
    const h = canvasFb.height;
    const color = this.colorStore.ensure(w, h);
    if (!this.fb || this.fbGeneration !== this.colorStore.generation) {
      this.releaseOwn();
      this.depthTex = this.depth
        ? this.luma.createTexture({
            id: `${this.label} 深度`, width: w, height: h, format: toLumaTextureFormat(this.depth),
            usage: toLumaTextureUsage(RhiTextureUsage.RENDER_TARGET), samples: this.sampleCount,
          } as never)
        : null;
      this.fb = this.luma.createFramebuffer({
        id: this.label, width: w, height: h, colorAttachments: [color], depthStencilAttachment: this.depthTex,
      });
      this.fbGeneration = this.colorStore.generation;
    }
    return this.fb;
  }

  get width(): number {
    return this.context.getDrawingBufferSize()[0];
  }

  get height(): number {
    return this.context.getDrawingBufferSize()[1];
  }

  get colorFormats(): readonly RhiColorFormat[] {
    return (this.formats ??= [this.format]);
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

  /** 只放自己的帧缓冲与深度(共用的多重采样颜色归设备放) */
  private releaseOwn(): void {
    this.fb?.destroy();
    this.depthTex?.destroy();
    this.fb = null;
    this.depthTex = null;
    this.fbGeneration = -1;
  }

  /** @internal 设备销毁时调 */
  releaseTextures(): void {
    this.releaseOwn();
  }

  protected releaseBackend(): void {
    this.releaseOwn();
  }
}

// ───────────────────────────── 绑定(bind group 缓存)

/** 一条管线最多缓存的 bind group 组合数;超了整棵清掉重来(缓冲区段偏移组合多时防无界增长) */
const MAX_BIND_GROUP_ENTRIES = 1024;

/** 缓存树的一个节点:资源对象走 WeakMap、偏移 / 尺寸走 Map,叶子存逐组的原生 bind group */
interface BindCacheNode {
  objects?: WeakMap<object, BindCacheNode>;
  numbers?: Map<number, BindCacheNode>;
  groups?: readonly (GPUBindGroup | null)[];
}

function stepObject(node: BindCacheNode, key: object): BindCacheNode {
  const m = (node.objects ??= new WeakMap());
  let next = m.get(key);
  if (!next) m.set(key, (next = {}));
  return next;
}

function stepNumber(node: BindCacheNode, key: number): BindCacheNode {
  const m = (node.numbers ??= new Map());
  let next = m.get(key);
  if (!next) m.set(key, (next = {}));
  return next;
}

/**
 * 一条管线的绑定计划(按着色器布局算一次)+ bind group 缓存。
 *
 * luma 的 setBindings 不给缓存键时每次都新建 GPUBindGroup,外加标签字符串、分组对象等一串临时对象;engine2d 每个 draw
 * 都 setBindings 一次。Pixi 8 的 WebGPU BindGroupSystem 按资源键缓存 bind group,这里照做:键 = 着色器声明的每个绑定
 * 所指资源的身份(缓冲区段再加偏移 / 尺寸;纹理再加它当前的采样器——配对的「纹理名Sampler」随纹理进 bind group)。
 * 命中就把缓存的 bind group 直接设给原生 pass,不经 luma、不分配;没命中才经 luma 的工厂建。
 *
 * 采样器按命名约定配给纹理(「纹理名 + Sampler」):配上的采样器**不单独进绑定**,而是设成纹理当前的采样器——
 * luma 建 bind group 时会按「纹理名Sampler」自动补上纹理自带的采样器,再单独传一份就是同一槽位绑两次、建 bind group 失败。
 * 着色器声明了「纹理名Sampler」而调用方没给采样器时,用纹理创建时的采样状态。
 *
 * 资源对象作 WeakMap 键:已销毁的资源过不了存活检查、走不到缓存(等于随销毁失效),对象回收后条目随之消失;
 * 重建出来的是新对象、新键。
 */
class LumaBindingPlan {
  /** 着色器声明的绑定名(布局顺序) */
  private readonly names: readonly string[];
  /** names[i] + Sampler:按约定配给纹理 names[i] 的采样器名 */
  private readonly pairedSampler: readonly string[];
  /** names[i] + Sampler 本身也是声明了的绑定:采样器随纹理进 bind group,键里要带上纹理当前的采样器 */
  private readonly pairedSamplerDeclared: readonly boolean[];
  /** names[i] 形如「纹理名Sampler」时的纹理名,否则 null */
  private readonly textureOf: readonly (string | null)[];
  private root: BindCacheNode = {};
  private entries = 0;

  constructor(layout: ShaderLayout | ComputeShaderLayout) {
    this.names = layout.bindings.map((b) => b.name);
    const declared = new Set(this.names);
    this.pairedSampler = this.names.map((n) => n + SAMPLER_SUFFIX);
    this.pairedSamplerDeclared = this.pairedSampler.map((n) => declared.has(n));
    this.textureOf = this.names.map((n) => (n.endsWith(SAMPLER_SUFFIX) ? n.slice(0, -SAMPLER_SUFFIX.length) : null));
  }

  /**
   * 解析一次 setBindings:只看着色器声明了的名字;缺项 / 已销毁 / 外来资源当场报;配对的采样器设成纹理当前的采样器;
   * 登记本批引用;返回逐组的 bind group。热路径:命中缓存时不分配(报错文字只在出错时拼)。
   */
  resolve(
    device: LumaRhiDevice,
    pipeline: RenderPipeline | ComputePipeline,
    bindings: RhiBindings,
    owner: string,
    list: LumaCommandList,
  ): readonly (GPUBindGroup | null)[] {
    if (this.entries >= MAX_BIND_GROUP_ENTRIES) {
      this.root = {};
      this.entries = 0;
    }
    let node = this.root;
    const names = this.names;
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const res = bindings[name];
      const texName = this.textureOf[i];
      if (texName !== null && (res === undefined || res instanceof LumaRhiSampler) && bindings[texName] instanceof LumaRhiTexture) {
        // 「纹理名Sampler」:纹理给了就用纹理的采样器(传了采样器的已在纹理那一项设进去),不单独进绑定
        if (res !== undefined && res.destroyed) res.assertAlive(`管线「${owner}」绑定 ${name}`);
        continue;
      }
      if (res === undefined) {
        throw new RhiError('invalid-usage', `管线「${owner}」:着色器需要的绑定没给 —— ${missingBindings(names, bindings).join(', ')}`);
      }
      if (res instanceof LumaRhiTexture) {
        if (res.destroyed) res.assertAlive(`管线「${owner}」绑定 ${name}`);
        const sampler = bindings[this.pairedSampler[i]];
        if (sampler instanceof LumaRhiSampler) {
          if (sampler.destroyed) sampler.assertAlive(`管线「${owner}」绑定 ${this.pairedSampler[i]}`);
          if (res.handle.sampler !== sampler.handle) res.handle.setSampler(sampler.handle);
        }
        list._use(res);
        node = stepObject(node, res);
        if (this.pairedSamplerDeclared[i]) node = stepObject(node, res.handle.sampler);
      } else if (res instanceof LumaRhiBuffer || res instanceof LumaRhiSampler) {
        if (res.destroyed) res.assertAlive(`管线「${owner}」绑定 ${name}`);
        if (res instanceof LumaRhiBuffer) list._use(res);
        node = stepObject(node, res);
      } else if (typeof res === 'object' && res !== null && 'buffer' in res) {
        const b = res.buffer;
        if (!(b instanceof LumaRhiBuffer)) throw new RhiError('invalid-usage', `管线「${owner}」绑定 ${name}:不是本设备的缓冲`);
        if (b.destroyed) b.assertAlive(`管线「${owner}」绑定 ${name}`);
        list._use(b);
        node = stepNumber(stepNumber(stepObject(node, b), res.offset ?? -1), res.size ?? -1);
      } else {
        throw new RhiError('invalid-usage', `管线「${owner}」绑定 ${name}:不认识的绑定资源`);
      }
    }
    if (!node.groups) {
      node.groups = device._createBindGroups(pipeline, this.toLuma(bindings));
      this.entries++;
    }
    return node.groups;
  }

  /** 没命中缓存时才调:拼给 luma 的绑定表(已由 resolve 校验过) */
  private toLuma(bindings: RhiBindings): Bindings {
    const out: Bindings = {};
    for (let i = 0; i < this.names.length; i++) {
      const name = this.names[i];
      const res = bindings[name];
      const texName = this.textureOf[i];
      if (texName !== null && (res === undefined || res instanceof LumaRhiSampler) && bindings[texName] instanceof LumaRhiTexture) continue;
      if (res instanceof LumaRhiBuffer || res instanceof LumaRhiTexture || res instanceof LumaRhiSampler) out[name] = res.handle;
      else if (typeof res === 'object' && res !== null && 'buffer' in res) {
        out[name] = { buffer: (res.buffer as LumaRhiBuffer).handle, offset: res.offset, size: res.size };
      }
    }
    return out;
  }
}

// ───────────────────────────── 命令

class LumaCommandList implements RhiCommandList {
  /**
   * 原生命令编码器,finish 后直接交原生队列提交。luma 的 CommandEncoder / CommandBuffer 各是一个带资源统计的 Resource
   * (每批一建一拆),提交时的错误作用域关调试时是空操作,对原生命令没有作用,所以热路径(每帧的 render pass)不经它
   */
  private readonly native: GPUCommandEncoder;
  /** 拷贝 / 计算 pass / 调试组仍经 luma 的编码器:用到时才包同一个原生编码器(一批最多包一次) */
  private lumaEncoder: CommandEncoder | null = null;
  private openPass: { end(): void } | null = null;
  /** 本批命令里已经引用过的缓冲 / 纹理(录制期写入冲突检查用) */
  private readonly used = new Set<LumaRhiBuffer | LumaRhiTexture>();

  constructor(
    private readonly device: LumaRhiDevice,
    readonly label: string,
    private readonly stats: RhiFrameStats,
  ) {
    this.native = device.gpuDevice.createCommandEncoder({ label });
  }

  private get encoder(): CommandEncoder {
    return (this.lumaEncoder ??= this.device.luma.createCommandEncoder({ id: this.label, handle: this.native } as never));
  }

  beginRenderPass(desc: RhiRenderPassDesc): RhiRenderPassEncoder {
    this.assertNoOpenPass(`beginRenderPass「${desc.label}」`);
    const target = asTarget(desc.target);
    target.assertAlive(`render pass「${desc.label}」的目标`);
    if (target instanceof LumaRhiRenderTarget) {
      for (const c of target.colors) this._use(c);
      if (target.depth) this._use(target.depth);
      for (const r of target.resolves) if (r) this._use(r);
    }
    const colorOps = desc.colorOps ?? [];
    if (colorOps.length > target.colorFormats.length) {
      throw new RhiError('invalid-usage', `render pass「${desc.label}」给了 ${colorOps.length} 个颜色附件操作,目标只有 ${target.colorFormats.length} 个附件`);
    }
    // pass 描述符自己拼(luma 的 WebGPU pass 不设模板附件的 load / store,带模板的深度格式会校验失败),
    // 再把现成的 GPURenderPassEncoder 交给 luma 包装(luma 的 `handle` 属性)。
    // 画布目标用本帧缓存的附件视图;其余目标的帧缓冲是自己的对象,直接取
    const swapViews = target instanceof LumaSwapchainTarget ? target.passViews() : null;
    const framebuffer = swapViews
      ? { colorAttachments: [{ handle: swapViews.color }], depthStencilAttachment: swapViews.depth ? { handle: swapViews.depth } : null }
      : target.framebuffer as Framebuffer & {
        colorAttachments: Array<{ handle: GPUTextureView }>;
        depthStencilAttachment: { handle: GPUTextureView } | null;
      };
    const colorAttachments: GPURenderPassColorAttachment[] = target.colorFormats.map((format, i) => {
      const op = colorOps[i] ?? { load: 'clear' as const };
      const v = op.load === 'clear' ? op.clearValue ?? [0, 0, 0, 0] : [0, 0, 0, 0];
      const resolveTarget = target instanceof LumaRhiRenderTarget ? target.resolveView(i)
        : target instanceof LumaMsaaSwapchainTarget && i === 0 ? target.resolveView : undefined;
      return {
        view: framebuffer.colorAttachments[i].handle,
        ...(resolveTarget ? { resolveTarget } : {}),
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
    // 直接在原生 encoder 上开 pass,不再交给 luma 包装:luma 9.4 的 WebGPURenderPass 构造时每次都 JSON.stringify
    // 整个描述符去打(关着的)日志、经 probe 读 performance.memory、做资源统计,end 时再拆统计;这些对原生 pass
    // 没有任何作用(关调试时它的错误作用域也是空操作),每帧几十个 pass 就是几毫秒纯开销。
    const handle = this.native.beginRenderPass({ label: desc.label, colorAttachments, depthStencilAttachment });
    this.stats.renderPasses++;
    const enc = new LumaRenderPassEncoder(this.device, this, handle, target, desc.label, this.stats);
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
    const commandBuffer = this.native.finish();
    // luma 的包装只用来编码,拆掉它的资源统计(不再经它 finish / 提交)
    this.lumaEncoder?.destroy();
    this.lumaEncoder = null;
    this.device.gpuDevice.queue.submit([commandBuffer]);
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
      // 原生编码器不 finish 就直接丢弃(WebGPU 没有别的撤销方式);luma 的包装拆掉统计
      this.lumaEncoder?.destroy();
    } catch {
      /* 同上 */
    }
    this.lumaEncoder = null;
  }

  private assertNoOpenPass(what: string): void {
    if (this.openPass) throw new RhiError('invalid-usage', `${what}:上一个 pass 还没 end()`);
  }
}

/**
 * render pass 录制。整个 pass 都不经 luma 的 RenderPass(开 pass 见 LumaCommandList.beginRenderPass),直接操作原生 pass:
 * luma 每次 setPipeline 都新建闭包 + popErrorScope 的 Promise,每个 draw 都经顶点数组 bindBeforeRender
 * 重设全部顶点 / 索引缓冲,且逐槽拼日志参数(关了日志也照样分配)。这里照 Pixi 8 GpuEncoderSystem:
 * 记下本 pass 已绑的原生管线 / bind group / 顶点缓冲 / 索引缓冲,只在变了时下发原生调用,draw 直接调原生。
 * (WebGPU 里这些绑定状态跨 setPipeline 保留、只在 pass 内有效,所以每个 pass 各记一份。)
 */
class LumaRenderPassEncoder implements RhiRenderPassEncoder {
  private pipeline: LumaRhiRenderPipeline | null = null;
  private bindingsSet = false;
  /** 当前管线已确认建坏:它的绑定 / draw 一律跳过,不碰原生 pass(见 LumaPipelineState) */
  private skipping = false;
  private readonly streams = new Map<string, LumaRhiBuffer>();
  private indexBuffer: LumaRhiBuffer | null = null;
  private ended = false;
  /** 本 pass 已下发给原生层的状态(相同就不再下发) */
  private boundPipeline: GPURenderPipeline | null = null;
  private readonly boundGroups: (GPUBindGroup | undefined)[] = [];
  private readonly boundVertex: (GPUBuffer | undefined)[] = [];
  private readonly boundVertexOffset: number[] = [];
  private boundIndex: GPUBuffer | null = null;
  private boundIndexFormat: GPUIndexFormat | null = null;
  /** draw 时按流序号取缓冲(逐 draw 复用) */
  private readonly drawStreams: LumaRhiBuffer[] = [];

  constructor(
    private readonly device: LumaRhiDevice,
    private readonly list: LumaCommandList,
    private readonly native: GPURenderPassEncoder,
    private readonly target: LumaRhiRenderTarget | LumaSwapchainTarget | LumaMsaaSwapchainTarget,
    private readonly label: string,
    private readonly stats: RhiFrameStats,
  ) {}

  setPipeline(pipeline: RhiRenderPipeline): void {
    if (!(pipeline instanceof LumaRhiRenderPipeline)) throw new RhiError('invalid-usage', `render pass「${this.label}」setPipeline:不是本设备的渲染管线`);
    const p = pipeline;
    if (p.destroyed) p.assertAlive(`render pass「${this.label}」setPipeline`);
    if (p.sampleCount !== this.target.sampleCount) {
      throw new RhiError(
        'invalid-usage',
        `管线「${p.label}」的采样数 ${p.sampleCount} 与 render pass「${this.label}」的目标(${this.target.sampleCount})不一致`,
      );
    }
    if (!sameFormats(p.colorFormats, this.target.colorFormats) || p.depthFormat !== this.target.depthFormat) {
      throw new RhiError(
        'invalid-usage',
        `管线「${p.label}」的目标格式 [${p.colorFormats.join(', ')}|${p.depthFormat ?? '无深度'}] `
          + `与 render pass「${this.label}」的目标 [${this.target.colorFormats.join(', ')}|${this.target.depthFormat ?? '无深度'}] 不一致`,
      );
    }
    this.skipping = p.failed;
    if (!this.skipping) {
      const native = p.handle.handle as GPURenderPipeline;
      if (native !== this.boundPipeline) {
        this.native.setPipeline(native);
        this.boundPipeline = native;
      }
    }
    this.pipeline = p;
    this.bindingsSet = false;
  }

  setBindings(bindings: RhiBindings): void {
    const p = this.requirePipeline('setBindings');
    if (this.skipping) {
      this.bindingsSet = true;
      return;
    }
    const groups = p.bindings.resolve(this.device, p.handle, bindings, p.label, this.list);
    for (let g = 0; g < groups.length; g++) {
      const bg = groups[g];
      if (bg && bg !== this.boundGroups[g]) {
        this.native.setBindGroup(g, bg);
        this.boundGroups[g] = bg;
      }
    }
    this.bindingsSet = true;
  }

  setVertexBuffer(name: string, buffer: RhiBuffer): void {
    if (!(buffer instanceof LumaRhiBuffer)) throw new RhiError('invalid-usage', `顶点流「${name}」:不是本设备的缓冲`);
    const b = buffer;
    if (b.destroyed) b.assertAlive(`顶点流「${name}」`);
    if ((b.usage & RhiBufferUsage.VERTEX) === 0) requireUsage(b.usage, RhiBufferUsage.VERTEX, `缓冲「${b.label}」作顶点流`, 'VERTEX');
    this.list._use(b);
    this.streams.set(name, b);
  }

  setIndexBuffer(buffer: RhiBuffer | null): void {
    if (buffer == null) {
      this.indexBuffer = null;
      return;
    }
    if (!(buffer instanceof LumaRhiBuffer)) throw new RhiError('invalid-usage', '索引缓冲:不是本设备的缓冲');
    const b = buffer;
    b.assertAlive('索引缓冲');
    if ((b.usage & RhiBufferUsage.INDEX) === 0) requireUsage(b.usage, RhiBufferUsage.INDEX, `缓冲「${b.label}」作索引`, 'INDEX');
    if (!b.indexFormat) throw new RhiError('invalid-usage', `索引缓冲「${b.label}」创建时没给 indexFormat`);
    this.list._use(b);
    this.indexBuffer = b;
  }

  /** 坐标左上角为原点 */
  setViewport(x: number, y: number, width: number, height: number): void {
    this.native.setViewport(x, y, width, height, 0, 1);
  }

  setScissor(x: number, y: number, width: number, height: number): void {
    this.native.setScissorRect(x, y, width, height);
  }

  setStencilReference(reference: number): void {
    // luma 的 setParameters 把参考值 0 当"没给"跳过,直接调底层
    this.native.setStencilReference(reference);
  }

  draw(vertexCount: number, instanceCount = 1, firstVertex = 0, firstInstance = 0): void {
    const p = this.prepareDraw(false);
    if (!p) return;
    this.native.draw(vertexCount, instanceCount, firstVertex, firstInstance);
    this.count(p, true);
  }

  drawIndexed(indexCount: number, instanceCount = 1, firstIndex = 0, baseVertex = 0, firstInstance = 0): void {
    const p = this.prepareDraw(true);
    if (!p) return;
    this.native.drawIndexed(indexCount, instanceCount, firstIndex, baseVertex, firstInstance);
    this.count(p, true);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.native.end();
    this.list._passEnded();
  }

  private requirePipeline(what: string): LumaRhiRenderPipeline {
    const p = this.pipeline;
    if (!p) throw new RhiError('invalid-usage', `render pass「${this.label}」${what}:还没 setPipeline`);
    if (p.destroyed) p.assertAlive(`render pass「${this.label}」${what}`);
    return p;
  }

  /** 校验并把变了的顶点流 / 索引设给原生 pass;当前管线已确认建坏时记一次跳过、返回 null */
  private prepareDraw(indexed: boolean): LumaRhiRenderPipeline | null {
    const p = this.requirePipeline('draw');
    if (this.skipping) {
      this.count(p, false);
      return null;
    }
    if (!this.bindingsSet && p.handle.shaderLayout.bindings.length > 0) {
      throw new RhiError('invalid-usage', `管线「${p.label}」需要资源绑定:setPipeline 之后先 setBindings 再 draw`);
    }
    const names = p.streamNames;
    const bufs = this.drawStreams;
    for (let i = 0; i < names.length; i++) {
      const buf = this.streams.get(names[i]);
      if (!buf) throw new RhiError('invalid-usage', `管线「${p.label}」的顶点流「${names[i]}」没绑定缓冲`);
      if (buf.destroyed) buf.assertAlive(`顶点流「${names[i]}」`);
      bufs[i] = buf;
    }
    if (indexed) {
      const ib = this.indexBuffer;
      if (!ib) throw new RhiError('invalid-usage', `drawIndexed 之前没 setIndexBuffer(管线「${p.label}」)`);
      ib.assertAlive('索引缓冲');
      const native = ib.handle.handle as GPUBuffer;
      const format = ib.indexFormat as GPUIndexFormat;
      if (native !== this.boundIndex || format !== this.boundIndexFormat) {
        this.native.setIndexBuffer(native, format);
        this.boundIndex = native;
        this.boundIndexFormat = format;
      }
    }
    const slotStream = p.vertexSlotStream;
    for (let slot = 0; slot < slotStream.length; slot++) {
      const stream = slotStream[slot];
      if (stream < 0) continue;
      const native = bufs[stream].handle.handle as GPUBuffer;
      const offset = p.vertexSlotOffset[slot];
      if (native !== this.boundVertex[slot] || offset !== this.boundVertexOffset[slot]) {
        this.native.setVertexBuffer(slot, native, offset);
        this.boundVertex[slot] = native;
        this.boundVertexOffset[slot] = offset;
      }
    }
    bufs.length = 0;
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
  /** 当前管线已确认建坏:绑定 / dispatch 跳过 */
  private skipping = false;
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
    this.skipping = p.failed;
    if (!this.skipping) this.pass.setPipeline(p.handle);
    this.pipeline = p;
    this.bindingsSet = false;
  }

  setBindings(bindings: RhiBindings): void {
    const p = this.pipeline;
    if (!p) throw new RhiError('invalid-usage', `compute pass「${this.label}」setBindings:还没 setPipeline`);
    if (this.skipping) {
      this.bindingsSet = true;
      return;
    }
    const groups = p.bindings.resolve(this.device, p.handle, bindings, p.label, this.list);
    const native = (this.pass as ComputePass & { handle: GPUComputePassEncoder }).handle;
    for (let g = 0; g < groups.length; g++) {
      const bg = groups[g];
      if (bg) native.setBindGroup(g, bg);
    }
    this.bindingsSet = true;
  }

  dispatch(x: number, y = 1, z = 1): void {
    if (!this.pipeline) throw new RhiError('invalid-usage', `compute pass「${this.label}」dispatch:还没 setPipeline`);
    this.pipeline.assertAlive(`compute pass「${this.label}」dispatch`);
    if (this.skipping) {
      this.device._warnSkippedDraw(this.pipeline);
      return;
    }
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

/**
 * 丢失与恢复(对照 master 的 Pixi WebGL:webglcontextlost 里 preventDefault 让浏览器恢复上下文,webglcontextrestored 时
 * runners.contextChange,各系统丢掉旧 GL 对象、下次用时从 CPU 源重建重传)。WebGPU 丢了的设备永远不能再用,
 * 只能重新要适配器 / 设备,所以这里的「恢复」是:
 *   丢失(不是自己 destroy 引起的)→ 报诊断 → 拆旧画布上下文 → 按原参数在同一画布上建新设备(失败按间隔重试)
 *   → 旧设备上的资源全部作废(作用域保留)→ 重建设备持有的画布目标、补回画布尺寸 → 报「已恢复」→ 通知 onRestored。
 * 同一个 RhiDevice 对象跨代存活:持有它的渲染器 / 诊断订阅都不用换。恢复是异步的,只发生在帧外;
 * 恢复之前 runFrame / submit 一律作废(同 WebGL 上下文丢失期间画不出东西)。
 */
export class LumaRhiDevice implements RhiDevice, RhiResourceFactory {
  readonly caps: RhiCaps;
  readonly info: RhiDeviceInfo;
  readonly rootScope: RhiResourceScope;
  private _luma: Device;
  private _lost!: Promise<string>;
  private _isLost = false;
  /**
   * 挂着的异步回读的 reject:当前这一代设备丢失时统一 reject 并清空,回读完成时自行摘掉。
   * 不能在 `_lost` 上逐次挂 then:它跨整个设备寿命挂着,每次回读的结果都会经那条反应链被扣住直到丢失(实际就是永远)
   */
  private readonly pendingReadbacks = new Set<(reason: string) => void>();
  private readonly releases: RhiReleaseQueue;
  private readonly listeners = new Set<RhiDiagnosticListener>();
  private readonly restoredListeners = new Set<() => void>();
  /** 正在重建设备(同时只有一轮) */
  private restoring = false;
  /** 当前设备的画布上下文已拆(丢失后到新设备接上之前;以及销毁后) */
  private canvasReleased = false;
  /** 最近一次 resizeSwapchain 的尺寸:新设备的画布上下文按它补 */
  private swapchainSize: [number, number] | null = null;
  private swapchain: LumaSwapchainTarget;
  private readonly swapchainDepth = new Map<RhiDepthFormat, LumaSwapchainTarget>();
  /** 多重采样画布目标:`${采样数}|${深度格式}` → 目标(设备持有,销毁时释放) */
  private readonly swapchainMsaa = new Map<string, LumaMsaaSwapchainTarget>();
  private readonly swapchainMsaaColors = new Map<number, LumaMsaaSwapchainColor>();
  private readonly warnedSkips = new WeakSet<object>();
  private frameIndex = 0;
  /** 正在录制的命令表(submit 里可以嵌套 runFrame 之外的 submit,所以是栈) */
  private readonly recordings: LumaCommandList[] = [];
  private _lastFrameStats: RhiFrameStats = emptyStats(-1);
  private _destroyed = false;
  /** mip 生成器(首次生成时建,管线按格式缓存) */
  private mipmaps: WebGpuMipmapGenerator | null = null;

  constructor(luma: Device, private readonly recovery: LumaRhiDeviceRecovery = {}) {
    this._luma = luma;
    this.caps = capsOf(luma);
    this.info = { vendor: luma.info.vendor, renderer: luma.info.renderer };
    this.releases = new RhiReleaseQueue((e) => this.report(e, 'error'));
    this.rootScope = new RhiResourceScope('设备', this, null);
    this.swapchain = new LumaSwapchainTarget(this.rootScope, this.releases, luma.getDefaultCanvasContext(), this.caps.swapchainFormat);
    this.watchLoss(luma);
  }

  /** 当前这一代的 luma 设备(恢复后换成新的) */
  get luma(): Device {
    return this._luma;
  }

  /** @internal 当前这一代的原生 GPUDevice(命令编码 / 提交直接用它) */
  get gpuDevice(): GPUDevice {
    return (this._luma as Device & { handle: GPUDevice }).handle;
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
    if (desc.flipY) throw unsupportedFlipY(desc.label);
    if (!(desc.width > 0 && desc.height > 0)) {
      throw new RhiError('invalid-usage', `纹理「${desc.label}」尺寸非法:${desc.width}×${desc.height}`);
    }
    if (desc.width > this.caps.maxTextureSize || desc.height > this.caps.maxTextureSize) {
      throw new RhiError('unsupported', `纹理「${desc.label}」${desc.width}×${desc.height} 超过设备上限 ${this.caps.maxTextureSize}`);
    }
    if ((desc.usage & RhiTextureUsage.RENDER_TARGET) && !isDepthFormat(desc.format) && !this.luma.isTextureFormatRenderable(toLumaTextureFormat(desc.format))) {
      throw new RhiError('unsupported', `纹理「${desc.label}」的格式 ${desc.format} 在当前后端不能当渲染目标`);
    }
    const samples = desc.sampleCount ?? 1;
    if (samples !== 1 && samples !== 4) {
      throw new RhiError('unsupported', `纹理「${desc.label}」的采样数 ${samples} 不支持(WebGPU 只有 1 / 4)`);
    }
    if (samples > 1) {
      if (desc.usage !== RhiTextureUsage.RENDER_TARGET) {
        throw new RhiError('invalid-usage', `多重采样纹理「${desc.label}」只能当渲染附件(用途只许 RENDER_TARGET),画完 resolve 到单采样纹理再采样 / 拷贝`);
      }
      if (desc.data != null || (desc.mipLevels ?? 1) !== 1) {
        throw new RhiError('invalid-usage', `多重采样纹理「${desc.label}」不能带初始数据、不能多级 mip`);
      }
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
      ...(samples > 1 ? { samples } : {}),
      // 总是显式给采样状态,缺省值由 RHI 定(clamp + 线性),不依赖 luma 的设备缺省采样器
      sampler: toLumaSamplerProps(desc.sampler ?? {}),
    } as never);
    const tex = new LumaRhiTexture(scope, this.releases, handle, usage, desc.label);
    if (isImage) this.uploadImage(tex, desc.data as RhiImageSource, { premultiplyAlpha: desc.premultiplyAlpha });
    else if (desc.data != null) this.writeTexture(tex, desc.data as ArrayBufferView);
    return tex;
  }

  createSampler(scope: RhiResourceScope, desc: RhiSamplerDesc): RhiSampler {
    const handle = this.luma.createSampler(toLumaSamplerProps(desc));
    return new LumaRhiSampler(scope, this.releases, handle, desc.label ?? 'sampler');
  }

  createShader(scope: RhiResourceScope, desc: RhiShaderDesc): RhiShader {
    const entry = resolveShaderEntries(desc);
    const [module, creationError] = this.captureErrors(() => this.luma.createShader({ id: desc.label, source: desc.wgsl, language: 'wgsl' }));
    return new LumaRhiShader(scope, this.releases, desc.label, module, entry, creationError);
  }

  createRenderPipeline(scope: RhiResourceScope, desc: RhiRenderPipelineDesc): RhiRenderPipeline {
    const shader = asShader(desc.shader, `管线「${desc.label}」`);
    if (!shader.hasRender) throw new RhiError('invalid-usage', `管线「${desc.label}」:着色器「${shader.label}」没有顶点 + 片元入口`);
    if (desc.colorFormats.length > this.caps.maxColorAttachments) {
      throw new RhiError('unsupported', `管线「${desc.label}」要 ${desc.colorFormats.length} 个颜色附件,设备上限 ${this.caps.maxColorAttachments}`);
    }
    const bufferLayout = toLumaBufferLayout(desc.vertexBuffers);
    const [handle, creationError] = this.captureErrors(() => this.luma.createRenderPipeline({
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
    }));
    const vertexArray = this.luma.createVertexArray({ shaderLayout: handle.shaderLayout, bufferLayout });
    const streamSlots = this.resolveStreamSlots(vertexArray, desc);
    return new LumaRhiRenderPipeline(
      scope, this.releases, desc.label, handle, vertexArray, streamSlots,
      [...desc.colorFormats], desc.depthFormat ?? null, desc.sampleCount ?? 1,
      [shader], creationError,
      (e) => this.report(e, 'error'),
    );
  }

  createComputePipeline(scope: RhiResourceScope, desc: RhiComputePipelineDesc): RhiComputePipeline {
    const shader = asShader(desc.shader, `计算管线「${desc.label}」`);
    if (!shader.hasCompute) throw new RhiError('invalid-usage', `计算管线「${desc.label}」:着色器「${shader.label}」没有计算入口`);
    const [handle, creationError] = this.captureErrors(
      () => this.luma.createComputePipeline({ id: desc.label, shader: shader.module, entryPoint: shader.entryPoints.compute }),
    );
    return new LumaRhiComputePipeline(scope, this.releases, desc.label, handle, [shader], creationError, (e) => this.report(e, 'error'));
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
    const samples = all[0].sampleCount;
    for (const t of all) {
      if (t.sampleCount !== samples) {
        throw new RhiError('invalid-usage', `渲染目标「${desc.label}」附件采样数不一致:「${t.label}」${t.sampleCount} ≠ ${samples}`);
      }
    }
    const resolves = (desc.resolveTargets ?? []).map((r, i) => {
      if (!r) return null;
      const t = asTexture(r, `渲染目标「${desc.label}」resolve 目标 ${i}`);
      const c = colors[i];
      if (!c) throw new RhiError('invalid-usage', `渲染目标「${desc.label}」的 resolve 目标 ${i} 没有对应的颜色附件`);
      if (c.sampleCount === 1) throw new RhiError('invalid-usage', `渲染目标「${desc.label}」颜色附件 ${i} 不是多重采样,不需要 resolve`);
      if (t.sampleCount !== 1) throw new RhiError('invalid-usage', `resolve 目标「${t.label}」必须是单采样纹理`);
      if (t.width !== width || t.height !== height || t.format !== c.format) {
        throw new RhiError('invalid-usage', `resolve 目标「${t.label}」须与附件「${c.label}」同尺寸同格式`);
      }
      requireUsage(t.usage, RhiTextureUsage.RENDER_TARGET, `纹理「${t.label}」作 resolve 目标`, 'RENDER_TARGET');
      return t;
    });
    // WebGPU 的附件视图只能有一级 mip:多级纹理(自动 mip 的源被当目标画)画 / resolve 进 level 0,
    // 其余级由 generateMipmaps 生成(同 Pixi GpuRenderTargetAdaptor 的 baseMipLevel / mipLevelCount: 1)
    const levelViews = new Map<LumaRhiTexture, TextureView>();
    for (const t of [...colors, ...resolves]) {
      if (t && t.mipLevels > 1 && !levelViews.has(t)) {
        levelViews.set(t, t.handle.createView({ dimension: '2d', baseMipLevel: 0, mipLevelCount: 1, arrayLayerCount: 1 }));
      }
    }
    const framebuffer = this.luma.createFramebuffer({
      id: desc.label,
      width,
      height,
      colorAttachments: colors.map((c) => levelViews.get(c) ?? c.handle),
      depthStencilAttachment: depth?.handle ?? null,
    });
    return new LumaRhiRenderTarget(scope, this.releases, desc.label, framebuffer, colors, depth, resolves, levelViews);
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
    if (opts.flipY) throw unsupportedFlipY(t.label);
    this.assertNotInFlight(t, 'uploadImage');
    requireUsage(t.usage, RhiTextureUsage.COPY_DST, `纹理「${t.label}」上传图像`, 'COPY_DST');
    t.handle.copyExternalImage({ image, premultipliedAlpha: opts.premultiplyAlpha ?? false });
  }

  generateMipmaps(texture: RhiTexture): void {
    const t = asTexture(texture, 'generateMipmaps');
    this.assertNotInFlight(t, 'generateMipmaps');
    requireUsage(t.usage, RhiTextureUsage.SAMPLED, `纹理「${t.label}」生成 mip`, 'SAMPLED');
    requireUsage(t.usage, RhiTextureUsage.RENDER_TARGET, `纹理「${t.label}」生成 mip`, 'RENDER_TARGET');
    if (t.mipLevels <= 1) return;
    // 照 Pixi GpuMipmapGenerator:逐级把上一级线性采样渲染到下一级,管线按格式缓存、全部级一个编码器一次提交
    // (与 RHI 的命令表无关;调用发生在规划阶段、帧录制之前,队列顺序 = 上传 → 生成 mip → 本帧)。
    // 不用 luma 的 generateMipmapsWebGPU:每次现建管线、每级提交一次,上传那一帧会卡(见 lumaMipmaps.ts)。
    // 格式不可渲染 / 不可过滤时当场抛(WebGPU 自己的校验错误是异步的):上报诊断,纹理只剩 level 0 可用,不打断这一帧
    try {
      const caps = this.luma.getTextureFormatCapabilities(t.handle.format);
      if (!caps.render || !caps.filter) {
        throw new Error(`格式 ${t.handle.format} 不可渲染或不可过滤(render=${caps.render}, filter=${caps.filter})`);
      }
      this.mipmaps ??= new WebGpuMipmapGenerator((this.luma as Device & { handle: GPUDevice }).handle);
      this.mipmaps.generate(t.handle.handle as GPUTexture);
    } catch (e) {
      this.report(new RhiError('backend', `纹理「${t.label}」生成 mip 失败:${e instanceof Error ? e.message : String(e)}`), 'error');
    }
  }

  async readBuffer(buffer: RhiBuffer, byteOffset = 0, size?: number): Promise<Uint8Array> {
    const b = asBuffer(buffer, 'readBuffer');
    requireUsage(b.usage, RhiBufferUsage.COPY_SRC, `回读缓冲「${b.label}」`, 'COPY_SRC');
    const len = size ?? b.size - byteOffset;
    return this.untilLost(b.handle.readAsync(byteOffset, len), `回读缓冲「${b.label}」`);
  }

  async readTexture(texture: RhiTexture): Promise<RhiTextureReadback> {
    const t = asTexture(texture, 'readTexture');
    requireUsage(t.usage, RhiTextureUsage.COPY_SRC, `回读纹理「${t.label}」`, 'COPY_SRC');
    return this.untilLost(this.readTextureNow(t), `回读纹理「${t.label}」`);
  }

  private async readTextureNow(t: LumaRhiTexture): Promise<RhiTextureReadback> {
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

  resizeSwapchain(pixelWidth: number, pixelHeight: number): void {
    if (this._destroyed || !(pixelWidth > 0 && pixelHeight > 0)) return;
    this.swapchainSize = [pixelWidth, pixelHeight];
    // 丢失后旧画布上下文已拆:只记下尺寸,新设备接上时补给它的画布上下文
    if (this.canvasReleased) return;
    // luma 自己记着「绘制缓冲尺寸」,下次取帧缓冲时按它重配画布上下文、重建深度缓冲;
    // 不告诉它的话,它只在取颜色纹理时发现尺寸不符再补,深度缓冲会停在建设备时的尺寸
    this.luma.getDefaultCanvasContext().setDrawingBufferSize(pixelWidth, pixelHeight);
  }

  runFrame(record: (frame: RhiFrame) => void): boolean {
    if (this._isLost || this._destroyed) return false;
    const stats = emptyStats(this.frameIndex);
    let commands: LumaCommandList | null = null;
    this.releases.beginRecording();
    try {
      this.swapchain._beginFrame();
      for (const t of this.swapchainDepth.values()) t._beginFrame();
      for (const t of this.swapchainMsaa.values()) t._beginFrame();
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
      const swapchainMultisampled = (sampleCount: number, depthFormat: RhiDepthFormat | null = null): RhiRenderTarget => {
        if (sampleCount === 1) return depthFormat ? swapchainWithDepth(depthFormat) : this.swapchain;
        if (sampleCount !== 4) throw new RhiError('unsupported', `画布多重采样数 ${sampleCount} 不支持(WebGPU 只有 1 / 4)`);
        const key = `${sampleCount}|${depthFormat ?? ''}`;
        let t = this.swapchainMsaa.get(key);
        if (!t) {
          let color = this.swapchainMsaaColors.get(sampleCount);
          if (!color) {
            color = new LumaMsaaSwapchainColor(this.luma, `画布后备缓冲 MSAA×${sampleCount} 颜色`, this.caps.swapchainFormat, sampleCount);
            this.swapchainMsaaColors.set(sampleCount, color);
          }
          t = new LumaMsaaSwapchainTarget(
            this.rootScope, this.releases, this.luma, this.luma.getDefaultCanvasContext(), this.caps.swapchainFormat, color, depthFormat,
          );
          this.swapchainMsaa.set(key, t);
          t._beginFrame();
        }
        return t;
      };
      record({ index: this.frameIndex, commands, swapchain: this.swapchain, swapchainWithDepth, swapchainMultisampled });
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
      for (const t of this.swapchainMsaa.values()) t._endFrame();
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
    this.releaseSwapchainTargets();
    this.releases.flush();
    this.releaseCanvas();
    this.listeners.clear();
    this.restoredListeners.clear();
    this.luma.destroy();
  }

  // ── 丢失与恢复

  /** 盯住这一代设备的丢失;已被换下的旧设备迟到的丢失信号不理 */
  private watchLoss(device: Device): void {
    this._lost = device.lost.then((info) => {
      const reason = info?.message || info?.reason || '未知原因';
      if (device !== this._luma) return reason;
      this._isLost = true;
      this.rejectPendingReadbacks(reason);
      if (this._destroyed) return reason;
      this.report(new RhiError('backend', `图形设备丢失:${reason}`), 'error');
      void this.restore();
      return reason;
    });
  }

  /** 丢失后在同一画布上重建设备(失败按间隔重试);没给 recreateDevice 就停在丢失状态 */
  private async restore(): Promise<void> {
    const recreate = this.recovery.recreateDevice;
    if (!recreate || this.restoring) return;
    this.restoring = true;
    try {
      // 旧画布上下文先拆:同一块画布只有一个 GPUCanvasContext,新设备建的时候会重新 configure 它,晚拆就把新配置 unconfigure 掉了
      this.releaseCanvas();
      const delays = this.recovery.restoreRetryDelaysMs ?? DEFAULT_RESTORE_RETRY_DELAYS_MS;
      let lastError: unknown = null;
      for (let i = 0; i < delays.length; i++) {
        if (delays[i] > 0) await new Promise((r) => setTimeout(r, delays[i]));
        if (this._destroyed) return;
        let next: Device;
        try {
          next = await recreate();
        } catch (e) {
          lastError = e;
          this.report(new RhiError('backend', `图形设备重建失败(第 ${i + 1}/${delays.length} 次):${errorText(e)}`), 'warning');
          continue;
        }
        if (this._destroyed) {
          // 等新设备期间已销毁:新设备连同它配置的画布上下文一起拆
          try {
            next.getDefaultCanvasContext().destroy();
          } catch {
            /* 设备都不要了,拆不干净也不再追究 */
          }
          next.destroy();
          return;
        }
        this.adopt(next);
        return;
      }
      this.report(new RhiError('backend', `图形设备恢复失败(重建 ${delays.length} 次都没成,需要刷新页面):${errorText(lastError)}`), 'error');
    } finally {
      this.restoring = false;
    }
  }

  /** 换上新设备:旧资源全部作废,重建设备持有的画布目标,通知持有 GPU 缓存的一方(同 Pixi 的 runners.contextChange) */
  private adopt(next: Device): void {
    const old = this._luma;
    this.rootScope._invalidateResources();
    this.releaseSwapchainTargets();
    this.releases.flush();
    try {
      old.destroy();
    } catch (e) {
      this.report(e, 'warning');
    }
    this._luma = next;
    this.canvasReleased = false;
    Object.assign(this.caps, capsOf(next));
    Object.assign(this.info, { vendor: next.info.vendor, renderer: next.info.renderer });
    this.mipmaps = null;
    const ctx = next.getDefaultCanvasContext();
    this.swapchain = new LumaSwapchainTarget(this.rootScope, this.releases, ctx, this.caps.swapchainFormat);
    if (this.swapchainSize) ctx.setDrawingBufferSize(this.swapchainSize[0], this.swapchainSize[1]);
    this._isLost = false;
    this.watchLoss(next);
    this.report(
      new RhiError('backend', '图形设备已恢复:同一画布上重建了设备,此前的 GPU 资源已作废、按需重建重传(渲染纹理里画过的内容没了)'),
      'warning',
    );
    for (const l of [...this.restoredListeners]) {
      try {
        l();
      } catch (e) {
        this.report(e, 'error');
      }
    }
  }

  /**
   * 拆当前设备的画布上下文(只拆一次)。要单独拆:luma 的 WebGPUDevice.destroy 不碰它——不拆的话 GPUCanvasContext 仍配置着,
   * ResizeObserver / IntersectionObserver / devicePixelRatio 监听都还挂着、引用着已销毁的设备
   */
  private releaseCanvas(): void {
    if (this.canvasReleased) return;
    this.canvasReleased = true;
    try {
      this.luma.getDefaultCanvasContext().destroy();
    } catch (e) {
      this.report(e, 'warning');
    }
  }

  /** 放掉设备持有的画布目标(深度 / 多重采样) */
  private releaseSwapchainTargets(): void {
    this.swapchainDepth.clear();
    for (const t of this.swapchainMsaa.values()) t.releaseTextures();
    this.swapchainMsaa.clear();
    for (const c of this.swapchainMsaaColors.values()) c.release();
    this.swapchainMsaaColors.clear();
  }

  /** 异步回读与这一代设备的丢失赛跑:设备丢了就 reject,不让调用方永远等着(GPU 进程崩溃时 mapAsync 可能迟迟不回) */
  private untilLost<T>(work: Promise<T>, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const onLost = (reason: string): void => reject(new RhiError('backend', `${what}:等待期间图形设备丢失(${reason})`));
      this.pendingReadbacks.add(onLost);
      work.then(resolve, reject).finally(() => this.pendingReadbacks.delete(onLost));
    });
  }

  /** 当前这一代设备丢了:挂着的回读全部 reject(已完成的早已摘掉,不受影响) */
  private rejectPendingReadbacks(reason: string): void {
    const pending = [...this.pendingReadbacks];
    this.pendingReadbacks.clear();
    for (const onLost of pending) onLost(reason);
  }

  // ── 内部

  /** @internal 经 luma 的工厂建一组 bind group(没命中 LumaBindingPlan 缓存时才走到) */
  _createBindGroups(pipeline: RenderPipeline | ComputePipeline, bindings: Bindings): (GPUBindGroup | null)[] {
    const map = _getDefaultBindGroupFactory(this.luma).getBindGroups(pipeline, bindings) as Record<number, GPUBindGroup | null | undefined>;
    const out: (GPUBindGroup | null)[] = [];
    for (const key of Object.keys(map)) out[Number(key)] = map[Number(key)] ?? null;
    for (let g = 0; g < out.length; g++) out[g] ??= null;
    return out;
  }

  /** @internal luma 报上来的后端错误 */
  _reportBackendError(error: unknown): void {
    this.report(error instanceof RhiError ? error : new RhiError('backend', error instanceof Error ? error.message : String(error)), 'error');
  }

  /** @internal 已确认建坏的管线:它的 draw / dispatch 被跳过;每条管线只报一次(未确认之前照常录制) */
  _warnSkippedDraw(p: LumaRhiRenderPipeline | LumaRhiComputePipeline): void {
    if (this.warnedSkips.has(p)) return;
    this.warnedSkips.add(p);
    this.report(
      new RhiError('backend', `管线「${p.label}」创建失败,用它的 draw / dispatch 一律跳过(只丢这些 draw,帧里其余内容照常提交)`),
      'warning',
    );
  }

  /**
   * 在原生错误作用域(validation + internal)里建 GPU 对象,返回对象与作用域接到的错误。
   * luma 关着调试时(缺省关)它自己的 push / popErrorScope 是空操作,建坏的着色器模块 / 管线不会反映到 linkStatus 上,
   * 只能在这里自己接住;接不到的话坏管线照常 setPipeline,整批命令作废。
   */
  private captureErrors<T>(create: () => T): [T, Promise<GPUError | null>] {
    const gpu = (this.luma as Device & { handle?: GPUDevice }).handle;
    if (!gpu || typeof gpu.pushErrorScope !== 'function') return [create(), Promise.resolve(null)];
    gpu.pushErrorScope('validation');
    gpu.pushErrorScope('internal');
    let value: T;
    let errors!: Promise<GPUError | null>;
    try {
      value = create();
    } finally {
      // 作用域后进先出:先弹 internal 再弹 validation(建对象抛了也要弹,保持作用域栈平衡);弹失败(设备已丢等)当没有错误
      const internal = gpu.popErrorScope().catch(() => null);
      const validation = gpu.popErrorScope().catch(() => null);
      errors = Promise.all([internal, validation]).then(([a, b]) => a ?? b);
    }
    return [value, errors];
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

/** luma 9.4 WebGPUVertexArray 推好的槽位(与建管线时的 GPUVertexBufferLayout 同一份推导) */
type LumaWebGpuVertexArrayInternals = VertexArray & {
  resolvedBufferSlots?: readonly { bufferName: string; shaderSlot: number; bindingOffset: number }[];
  logicalBufferSlots?: Readonly<Record<string, number>>;
};

/**
 * 原生顶点缓冲槽 → 逻辑缓冲槽 + 偏移。照 luma WebGPUVertexArray.bindBeforeRender 的映射
 * (`logicalBufferSlots[bufferName] ?? shaderSlot`),draw 时由 RHI 自己按这张表设原生顶点缓冲。
 */
function resolvePhysicalVertexSlots(va: VertexArray, label: string): { logicalSlot: number; bindingOffset: number }[] {
  const { resolvedBufferSlots, logicalBufferSlots } = va as LumaWebGpuVertexArrayInternals;
  if (!resolvedBufferSlots || !logicalBufferSlots) {
    throw new RhiError('backend', `管线「${label}」:luma 顶点数组缺 resolvedBufferSlots / logicalBufferSlots(luma 版本变了?)`);
  }
  const out: { logicalSlot: number; bindingOffset: number }[] = [];
  for (const r of resolvedBufferSlots) {
    out[r.shaderSlot] = { logicalSlot: logicalBufferSlots[r.bufferName] ?? r.shaderSlot, bindingOffset: r.bindingOffset };
  }
  return out;
}

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

/**
 * 等着色器编译、管线校验完成。建坏的判据:着色器编译信息里有 error、建着色器模块 / 管线时原生错误作用域接到错误、
 * luma 报链接失败(开调试时)。
 */
async function waitPipelineReady(
  label: string,
  pipelines: readonly RenderPipeline[],
  shaders: readonly LumaRhiShader[],
  creationErrors: readonly Promise<GPUError | null>[],
): Promise<void> {
  for (const shader of new Set(shaders)) {
    const s = shader.module;
    const status = await s.asyncCompilationStatus;
    if (status === 'error') {
      const messages = await s.getCompilationInfo().catch(() => []);
      const text = messages.filter((m) => m.type === 'error').map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('\n');
      throw new RhiError('backend', `管线「${label}」:着色器「${s.id}」编译失败\n${text}`);
    }
    const error = await shader.creationError;
    if (error) throw new RhiError('backend', `管线「${label}」:着色器「${shader.label}」创建失败\n${error.message}`);
  }
  for (const pending of creationErrors) {
    const error = await pending;
    if (error) throw new RhiError('backend', `管线「${label}」创建 / 校验失败\n${error.message}`);
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

function asComputePipeline(p: RhiComputePipeline, what: string): LumaRhiComputePipeline {
  if (!(p instanceof LumaRhiComputePipeline)) throw new RhiError('invalid-usage', `${what}:不是本设备的计算管线`);
  p.assertAlive(what);
  return p;
}

function asTarget(t: RhiRenderTarget, what = '渲染目标'): LumaRhiRenderTarget | LumaSwapchainTarget | LumaMsaaSwapchainTarget {
  if (!(t instanceof LumaRhiRenderTarget) && !(t instanceof LumaSwapchainTarget) && !(t instanceof LumaMsaaSwapchainTarget)) {
    throw new RhiError('invalid-usage', `${what}:不是本设备的渲染目标`);
  }
  return t;
}

function unsupportedFlipY(label: string): RhiError {
  // luma 9.4 的 WebGPU 图像拷贝把 flipY 写死成 false(CPU 适配器的回落上传也不翻),传了只会被静默丢掉;没有调用方用它,不如当场报
  return new RhiError('unsupported', `纹理「${label}」:图像上传不支持 flipY(luma WebGPU 固定不翻转);要翻转请在着色器里翻 uv 或上传前翻好`);
}
