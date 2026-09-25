/**
 * RHI(渲染硬件接口)的公共类型。
 *
 * 上层渲染代码只认这里的类型;具体图形 API 由后端(`backends/`)翻译。只有 WebGPU 一个图形后端,
 * 命名与语义照 WebGPU:显式的 render pass / compute pass、创建后不可变的管线、按名字绑定资源、
 * 资源必须有所有者。没有 WebGL 回落:环境没有 WebGPU 就在创建设备时明确失败。
 */

/** 颜色格式(取 WebGPU 名)。32 位浮点能否线性过滤取决于设备特性,查 `RhiCaps`。 */
export type RhiColorFormat =
  | 'r8unorm'
  | 'rg8unorm'
  | 'rgba8unorm'
  | 'rgba8unorm-srgb'
  | 'bgra8unorm'
  | 'r16float'
  | 'rg16float'
  | 'rgba16float'
  | 'r32float'
  | 'rg32float'
  | 'rgba32float'
  | 'r32uint'
  | 'rgba32uint';

export type RhiDepthFormat = 'depth16unorm' | 'depth24plus' | 'depth24plus-stencil8' | 'depth32float';

export type RhiTextureFormat = RhiColorFormat | RhiDepthFormat;

export function isDepthFormat(format: RhiTextureFormat): format is RhiDepthFormat {
  return format.startsWith('depth');
}

/** 缓冲用途位。组合使用:`RhiBufferUsage.VERTEX | RhiBufferUsage.COPY_DST`。 */
export const RhiBufferUsage = {
  VERTEX: 1 << 0,
  INDEX: 1 << 1,
  UNIFORM: 1 << 2,
  STORAGE: 1 << 3,
  INDIRECT: 1 << 4,
  /** 可作拷贝源;回读(`readBuffer`)要求有这一位 */
  COPY_SRC: 1 << 5,
  COPY_DST: 1 << 6,
} as const;

/** 纹理用途位。 */
export const RhiTextureUsage = {
  /** 着色器里采样 */
  SAMPLED: 1 << 0,
  /** 作颜色 / 深度附件 */
  RENDER_TARGET: 1 << 1,
  /** 存储纹理(compute 读写) */
  STORAGE: 1 << 2,
  /** 可作拷贝源;回读(`readTexture`)要求有这一位 */
  COPY_SRC: 1 << 3,
  COPY_DST: 1 << 4,
} as const;

export type RhiAddressMode = 'clamp-to-edge' | 'repeat' | 'mirror-repeat';
export type RhiFilterMode = 'nearest' | 'linear';
export type RhiCompareFunction =
  | 'never'
  | 'less'
  | 'equal'
  | 'less-equal'
  | 'greater'
  | 'not-equal'
  | 'greater-equal'
  | 'always';

export interface RhiSamplerDesc {
  label?: string;
  addressModeU?: RhiAddressMode;
  addressModeV?: RhiAddressMode;
  magFilter?: RhiFilterMode;
  minFilter?: RhiFilterMode;
  mipmapFilter?: 'none' | RhiFilterMode;
  /** 给了就是比较采样器(阴影图之类) */
  compare?: RhiCompareFunction;
}

/** 可直接上传进纹理的图像源 */
export type RhiImageSource =
  | ImageBitmap
  | ImageData
  | HTMLImageElement
  | HTMLCanvasElement
  | HTMLVideoElement
  | OffscreenCanvas
  | VideoFrame;

export interface RhiBufferDesc {
  label: string;
  /** `RhiBufferUsage` 位组合 */
  usage: number;
  /** 字节数;给了 `data` 可省(取其长度) */
  size?: number;
  data?: ArrayBufferView;
  /** 作索引缓冲时的元素类型 */
  indexFormat?: 'uint16' | 'uint32';
}

export interface RhiTextureDesc {
  label: string;
  width: number;
  height: number;
  format: RhiTextureFormat;
  /** `RhiTextureUsage` 位组合 */
  usage: number;
  mipLevels?: number;
  /** 初始内容:图像源,或按行紧排的像素数据 */
  data?: RhiImageSource | ArrayBufferView;
  /**
   * 图像源上传时是否预乘 alpha。缺省 **false**:alpha 当数据用的贴图(遮罩、编码图)不会在上传时被乘掉
   * ——Pixi 时代这是一个要靠特殊装载参数才能躲开的坑,这里默认就不乘。要预乘的颜色图显式传 true。
   */
  premultiplyAlpha?: boolean;
  /** **不支持**:传 true 当场报 `unsupported`(luma 的 WebGPU 图像拷贝把 flipY 写死成 false,不报就是静默丢掉);要翻转在着色器里翻 uv */
  flipY?: boolean;
  /** 纹理自带的采样状态:着色器声明了「纹理名Sampler」而绑定时没单独给采样器时用它(见 `RhiBindings`) */
  sampler?: RhiSamplerDesc;
  /**
   * 多重采样数:1(缺省)或 4。4 的纹理只能当渲染附件(用途只许 RENDER_TARGET),不能采样 / 拷贝 / 带初始数据 / 多级 mip;
   * 画完经渲染目标的 `resolveTargets` 落到单采样纹理上再用(MSAA 抗锯齿)。
   */
  sampleCount?: number;
}

/** 着色器源:一个 WGSL 模块,可同时含顶点、片元、计算入口(入口名缺省按 `@vertex` 等标注自动找)。 */
export interface RhiShaderDesc {
  label: string;
  wgsl: string;
  entryPoints?: { vertex?: string; fragment?: string; compute?: string };
}

export type RhiVertexFormat =
  | 'float32'
  | 'float32x2'
  | 'float32x3'
  | 'float32x4'
  | 'uint32'
  | 'uint32x2'
  | 'uint32x3'
  | 'uint32x4'
  | 'sint32'
  | 'sint32x2'
  | 'sint32x3'
  | 'sint32x4'
  | 'uint8x2'
  | 'uint8x4'
  | 'sint8x2'
  | 'sint8x4'
  | 'unorm8x2'
  | 'unorm8x4'
  | 'snorm8x2'
  | 'snorm8x4'
  | 'uint16x2'
  | 'uint16x4'
  | 'sint16x2'
  | 'sint16x4'
  | 'unorm16x2'
  | 'unorm16x4'
  | 'snorm16x2'
  | 'snorm16x4'
  | 'float16x2'
  | 'float16x4';

export interface RhiVertexAttribute {
  /** 着色器里的属性名 */
  name: string;
  format: RhiVertexFormat;
  /** 在一个顶点记录里的字节偏移 */
  offset: number;
}

/** 一路顶点流。绘制时按 `name` 绑定缓冲(`setVertexBuffer(name, buffer)`),与后端槽位无关。 */
export interface RhiVertexBufferLayout {
  name: string;
  stride: number;
  stepMode?: 'vertex' | 'instance';
  attributes: RhiVertexAttribute[];
}

export type RhiBlendFactor =
  | 'zero'
  | 'one'
  | 'src'
  | 'one-minus-src'
  | 'src-alpha'
  | 'one-minus-src-alpha'
  | 'dst'
  | 'one-minus-dst'
  | 'dst-alpha'
  | 'one-minus-dst-alpha';

export type RhiBlendOperation = 'add' | 'subtract' | 'reverse-subtract' | 'min' | 'max';

export interface RhiBlendComponent {
  srcFactor: RhiBlendFactor;
  dstFactor: RhiBlendFactor;
  operation?: RhiBlendOperation;
}

export interface RhiBlendState {
  color: RhiBlendComponent;
  alpha: RhiBlendComponent;
}

/** 常用混合预设 */
export const RhiBlend = {
  /** 源 alpha 混合(源未预乘) */
  alpha: {
    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
  },
  /** 预乘 alpha 混合 */
  premultiplied: {
    color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
    alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
  },
  /** 加性(灯、火光、辉光) */
  additive: {
    color: { srcFactor: 'one', dstFactor: 'one' },
    alpha: { srcFactor: 'one', dstFactor: 'one' },
  },
} as const satisfies Record<string, RhiBlendState>;

export type RhiPrimitiveTopology = 'triangle-list' | 'triangle-strip' | 'line-list' | 'line-strip' | 'point-list';

export interface RhiDepthState {
  write: boolean;
  compare: RhiCompareFunction;
}

export type RhiStencilOperation =
  | 'keep'
  | 'zero'
  | 'replace'
  | 'invert'
  | 'increment-clamp'
  | 'decrement-clamp'
  | 'increment-wrap'
  | 'decrement-wrap';

/**
 * 模板测试(正反面相同)。目标要有带模板的深度附件(`depth24plus-stencil8`);参考值在 pass 里用
 * `setStencilReference` 设,pass 开始时为 0。
 */
export interface RhiStencilState {
  compare: RhiCompareFunction;
  passOp?: RhiStencilOperation;
  failOp?: RhiStencilOperation;
  depthFailOp?: RhiStencilOperation;
  readMask?: number;
  writeMask?: number;
}

/** 颜色写掩码位(`RhiRenderPipelineDesc.colorWriteMask`) */
export const RhiColorWrite = { RED: 1, GREEN: 2, BLUE: 4, ALPHA: 8, ALL: 15, NONE: 0 } as const;

/** 渲染管线 = 着色器 + 顶点布局 + 光栅 / 混合 / 深度状态 + 目标格式。创建后不可变。 */
export interface RhiRenderPipelineDesc {
  label: string;
  shader: import('./RhiDevice').RhiShader;
  vertexBuffers?: RhiVertexBufferLayout[];
  topology?: RhiPrimitiveTopology;
  /** 必须与绘制时渲染目标的颜色附件格式逐个相同 */
  colorFormats: RhiColorFormat[];
  depthFormat?: RhiDepthFormat;
  /** null / 不给 = 不混合(直接覆盖) */
  blend?: RhiBlendState | null;
  depth?: RhiDepthState;
  /** 模板测试;给了就要求 `depthFormat` 是带模板的格式 */
  stencil?: RhiStencilState;
  /** 颜色写掩码(`RhiColorWrite` 位组合),缺省全写 */
  colorWriteMask?: number;
  cullMode?: 'none' | 'front' | 'back';
  /** 多重采样数,必须与绘制时渲染目标的 `sampleCount` 相同;缺省 1 */
  sampleCount?: number;
}

export interface RhiComputePipelineDesc {
  label: string;
  shader: import('./RhiDevice').RhiShader;
}

export interface RhiRenderTargetDesc {
  label: string;
  colors: import('./RhiDevice').RhiTexture[];
  depth?: import('./RhiDevice').RhiTexture | null;
  /**
   * 逐颜色附件的 resolve 目标(单采样、与附件同尺寸同格式、带 RENDER_TARGET 用途)。颜色附件是多重采样时,
   * 每个 pass 结束都把结果 resolve 进去;附件与深度附件的采样数必须一致。
   */
  resolveTargets?: (import('./RhiDevice').RhiTexture | null)[];
}

/** 颜色附件在 pass 开始时的处理:清成某色,或保留原内容 */
export type RhiColorLoad = { load: 'clear'; clearValue?: [number, number, number, number] } | { load: 'load' };
export type RhiDepthLoad = { load: 'clear'; clearValue?: number } | { load: 'load' };
export type RhiStencilLoad = { load: 'clear'; clearValue?: number } | { load: 'load' };

export interface RhiRenderPassDesc {
  label: string;
  target: import('./RhiDevice').RhiRenderTarget;
  /** 逐颜色附件;缺省全部清成透明黑 */
  colorOps?: RhiColorLoad[];
  /** 缺省清成 1 */
  depthOp?: RhiDepthLoad;
  /** 目标的深度附件带模板时生效;缺省清成 0 */
  stencilOp?: RhiStencilLoad;
}

export type RhiErrorCode =
  /** 环境 / 设备没有这项能力(没有 WebGPU、超出设备上限、格式不支持) */
  | 'unsupported'
  /** 用了已销毁的资源 */
  | 'destroyed-resource'
  /** 描述符不合法 / 前后不匹配(格式、用途、尺寸) */
  | 'invalid-usage'
  /** 后端图形 API 报错(着色器编译、管线校验、设备丢失) */
  | 'backend';

export class RhiError extends Error {
  constructor(readonly code: RhiErrorCode, message: string) {
    super(`[RHI:${code}] ${message}`);
    this.name = 'RhiError';
  }
}
