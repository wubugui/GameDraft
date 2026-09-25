import type {
  RhiBackendType,
  RhiBufferDesc,
  RhiColorFormat,
  RhiComputePipelineDesc,
  RhiDepthFormat,
  RhiError,
  RhiRenderPassDesc,
  RhiRenderPipelineDesc,
  RhiRenderTargetDesc,
  RhiSamplerDesc,
  RhiShaderDesc,
  RhiTextureDesc,
  RhiTextureFormat,
} from './types';
import type { RhiResourceScope } from './RhiResourceScope';

/** 设备能力。后端之间的差异全部经这里暴露,上层按它选路径,RHI 不做静默降级。 */
export interface RhiCaps {
  backend: RhiBackendType;
  /** compute pass / 存储缓冲(仅 WebGPU) */
  compute: boolean;
  /** 存储纹理(compute 直接写纹理,仅 WebGPU) */
  storageTextures: boolean;
  /** rgba16float 能当渲染目标 */
  float16RenderTargets: boolean;
  /** rgba32float 能当渲染目标 */
  float32RenderTargets: boolean;
  /** rgba32float 能线性过滤 */
  float32Filterable: boolean;
  maxTextureSize: number;
  maxColorAttachments: number;
  /** compute 工作组最大尺寸与单组最大线程数(无 compute 时为 0) */
  maxComputeWorkgroupSize: [number, number, number];
  maxComputeInvocationsPerWorkgroup: number;
  /** 交换链(画布)的颜色格式 */
  swapchainFormat: RhiColorFormat;
}

export interface RhiDeviceInfo {
  backend: RhiBackendType;
  vendor: string;
  renderer: string;
}

// ───────────────────────────── 资源

export interface RhiResource {
  readonly kind: string;
  readonly label: string;
  readonly destroyed: boolean;
  /** 所属作用域(资源一律有主) */
  readonly scope: RhiResourceScope;
  /** 立即失效;底层句柄等本帧提交之后再释放 */
  destroy(): void;
}

export interface RhiBuffer extends RhiResource {
  readonly kind: 'buffer';
  readonly size: number;
  readonly usage: number;
  readonly indexFormat?: 'uint16' | 'uint32';
}

export interface RhiTexture extends RhiResource {
  readonly kind: 'texture';
  readonly width: number;
  readonly height: number;
  readonly format: RhiTextureFormat;
  readonly usage: number;
  readonly mipLevels: number;
}

export interface RhiSampler extends RhiResource {
  readonly kind: 'sampler';
}

export interface RhiShader extends RhiResource {
  readonly kind: 'shader';
  /** 含顶点 + 片元入口(可用于渲染管线) */
  readonly hasRender: boolean;
  /** 含计算入口(可用于计算管线) */
  readonly hasCompute: boolean;
}

/** 管线的着色器编译 / 链接可能是异步的(WebGL2 的并行编译、WebGPU 的异步校验)。 */
export interface RhiPipelineStatus {
  /** 编译链接成功后 resolve,失败 reject(RhiError 'backend') */
  readonly ready: Promise<void>;
  readonly isReady: boolean;
}

export interface RhiRenderPipeline extends RhiResource, RhiPipelineStatus {
  readonly kind: 'render-pipeline';
  readonly colorFormats: readonly RhiColorFormat[];
  readonly depthFormat: RhiDepthFormat | null;
}

export interface RhiComputePipeline extends RhiResource, RhiPipelineStatus {
  readonly kind: 'compute-pipeline';
}

export interface RhiRenderTarget extends RhiResource {
  readonly kind: 'render-target';
  readonly width: number;
  readonly height: number;
  readonly colorFormats: readonly RhiColorFormat[];
  readonly depthFormat: RhiDepthFormat | null;
}

/**
 * 按名字绑定的资源。名字就是着色器里的名字:
 * - 统一缓冲:WGSL 里 `var<uniform>` 的变量名 = GLSL 里 uniform block 的块名;
 * - 纹理:WGSL 纹理变量名 = GLSL `sampler2D` 名;
 * - 采样器:WGSL 里单独声明,命名约定为「纹理名 + Sampler」(`uColor` → `uColorSampler`)。
 *   传了就设成该纹理的采样状态(WebGL2 没有独立采样器,两个后端因此一致);不传就用纹理创建时的
 *   `sampler` 描述(缺省 clamp + 线性)。不按约定命名的独立采样器(仅 WGSL)照名字直接绑。
 * 着色器里没有的名字会被忽略(同一份绑定可以喂给不同着色器);着色器要的名字没给,当场报错。
 */
export type RhiBindingResource =
  | RhiBuffer
  | { buffer: RhiBuffer; offset?: number; size?: number }
  | RhiTexture
  | RhiSampler;

export type RhiBindings = Record<string, RhiBindingResource>;

// ───────────────────────────── 命令

export interface RhiRenderPassEncoder {
  setPipeline(pipeline: RhiRenderPipeline): void;
  setBindings(bindings: RhiBindings): void;
  /** 按顶点流名字(`RhiVertexBufferLayout.name`)绑定 */
  setVertexBuffer(name: string, buffer: RhiBuffer): void;
  setIndexBuffer(buffer: RhiBuffer | null): void;
  setViewport(x: number, y: number, width: number, height: number): void;
  setScissor(x: number, y: number, width: number, height: number): void;
  draw(vertexCount: number, instanceCount?: number, firstVertex?: number, firstInstance?: number): void;
  drawIndexed(indexCount: number, instanceCount?: number, firstIndex?: number, baseVertex?: number, firstInstance?: number): void;
  end(): void;
}

export interface RhiComputePassEncoder {
  setPipeline(pipeline: RhiComputePipeline): void;
  setBindings(bindings: RhiBindings): void;
  dispatch(x: number, y?: number, z?: number): void;
  end(): void;
}

export interface RhiCommandList {
  readonly label: string;
  beginRenderPass(desc: RhiRenderPassDesc): RhiRenderPassEncoder;
  /** 设备没有 compute 能力时抛 RhiError('unsupported') */
  beginComputePass(label: string): RhiComputePassEncoder;
  copyBufferToBuffer(src: RhiBuffer, srcOffset: number, dst: RhiBuffer, dstOffset: number, size: number): void;
  copyTextureToTexture(src: RhiTexture, dst: RhiTexture, width?: number, height?: number): void;
  pushDebugGroup(label: string): void;
  popDebugGroup(): void;
}

/** 一帧:这一帧的命令表 + 当前画布的后备缓冲 */
export interface RhiFrame {
  readonly index: number;
  readonly commands: RhiCommandList;
  readonly swapchain: RhiRenderTarget;
}

export interface RhiFrameStats {
  frame: number;
  renderPasses: number;
  computePasses: number;
  draws: number;
  dispatches: number;
  /** 后端因着色器未就绪等原因跳过的 draw(WebGL2 并行编译期间会发生) */
  skippedDraws: number;
}

export interface RhiTextureReadback {
  width: number;
  height: number;
  format: RhiTextureFormat;
  /** 紧排(无行填充)的像素字节 */
  data: Uint8Array;
}

export type RhiDiagnosticSeverity = 'error' | 'warning';
export type RhiDiagnosticListener = (error: RhiError, severity: RhiDiagnosticSeverity) => void;

/** 资源工厂:只给作用域用(资源一律经作用域创建,保证有主) */
export interface RhiResourceFactory {
  createBuffer(scope: RhiResourceScope, desc: RhiBufferDesc): RhiBuffer;
  createTexture(scope: RhiResourceScope, desc: RhiTextureDesc): RhiTexture;
  createSampler(scope: RhiResourceScope, desc: RhiSamplerDesc): RhiSampler;
  createShader(scope: RhiResourceScope, desc: RhiShaderDesc): RhiShader;
  createRenderPipeline(scope: RhiResourceScope, desc: RhiRenderPipelineDesc): RhiRenderPipeline;
  createComputePipeline(scope: RhiResourceScope, desc: RhiComputePipelineDesc): RhiComputePipeline;
  createRenderTarget(scope: RhiResourceScope, desc: RhiRenderTargetDesc): RhiRenderTarget;
}

export interface RhiDevice {
  readonly caps: RhiCaps;
  readonly info: RhiDeviceInfo;
  /** 设备级根作用域;场景 / 系统各自 `createScope` 挂在它下面 */
  readonly rootScope: RhiResourceScope;
  readonly isLost: boolean;
  /** 设备丢失时 resolve(原因文字) */
  readonly lost: Promise<string>;
  /** 最近一帧的统计 */
  readonly lastFrameStats: RhiFrameStats;

  createScope(label: string, parent?: RhiResourceScope): RhiResourceScope;

  writeBuffer(buffer: RhiBuffer, data: ArrayBufferView, byteOffset?: number): void;
  /** 写像素:图像源(可选预乘 / 翻转)或紧排像素数据 */
  writeTexture(texture: RhiTexture, data: ArrayBufferView, region?: { x?: number; y?: number; width?: number; height?: number }): void;
  uploadImage(texture: RhiTexture, image: import('./types').RhiImageSource, opts?: { premultiplyAlpha?: boolean; flipY?: boolean }): void;
  /** 回读缓冲(要求 COPY_SRC 用途) */
  readBuffer(buffer: RhiBuffer, byteOffset?: number, size?: number): Promise<Uint8Array>;
  /** 回读纹理(要求 COPY_SRC 用途),行填充已去掉 */
  readTexture(texture: RhiTexture): Promise<RhiTextureReadback>;

  /**
   * 录一帧并提交。录制过程中抛出的任何异常都在这里截住、上报,这一帧作废,主循环不受影响
   * ——不会出现"渲染抛一次异常整个主循环死掉"。返回是否成功提交。
   */
  runFrame(record: (frame: RhiFrame) => void): boolean;
  /** 帧外提交一批命令(加载期烘焙、预热等),同样截住异常 */
  submit(label: string, record: (commands: RhiCommandList) => void): boolean;

  onDiagnostic(listener: RhiDiagnosticListener): () => void;
  destroy(): void;
}
