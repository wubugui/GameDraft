/**
 * 一次 render() 的规划阶段:把收集到的指令表"执行"成一张虚拟命令表(pass 切换 + 绘制),
 * 期间算好所有 uniform(写进 Arena)、确保纹理 / 缓冲已上传。录制阶段只按虚拟命令调 RHI。
 *
 * 目标切换、全局 uniform 栈、滤镜系统、遮罩的逻辑逐段照 Pixi 8.17 移植
 * (RenderTargetSystem.bind / push / pop、GlobalUniformSystem、FilterSystem、StencilMaskPipe、GpuStencilSystem、
 * AlphaMaskPipe、ColorMaskPipe),
 * 保证滤镜区域、临时纹理尺寸、uniform 数值与 master 相同。
 */
import type { RhiBuffer, RhiColorFormat, RhiSampler, RhiTexture } from '../../rendering/rhi';
import { Matrix } from '../math/Matrix';
import { Rectangle } from '../math/Rectangle';
import { Bounds } from '../scene/Bounds';
import { FilterEffect, type AlphaMask, type Container } from '../scene/Container';
import { Sprite } from '../sprite/Sprite';
import { MaskFilter } from '../filters/mask/MaskFilter';
import { Texture } from '../textures/Texture';
import { TextureSource } from '../textures/TextureSource';
import { TexturePool } from '../textures/TexturePool';
import type { TextureStyle } from '../textures/TextureStyle';
import { UniformGroup } from '../shader/UniformGroup';
import { Buffer, BufferResource } from '../shader/Buffer';
import { Geometry } from '../shader/Geometry';
import { GpuProgram } from '../shader/GpuProgram';
import { packUbo, createUboLayout } from '../shader/uboLayout';
import type { Shader } from '../shader/Shader';
import type { Filter, FilterSystemLike } from '../filters/Filter';
import type { BlendMode } from '../core/blendModes';
import type { CustomDrawable, UnbatchedGraphics } from '../core/contracts';
import { warn } from '../assets/utils/warn';
import { Arena } from './Arena';
import { adjustedBlendMode, type BatchRecord } from './Batcher';
import { BATCH_WGSL, GRAPHICS_WGSL, MAX_BATCH_TEXTURES, MESH_WGSL } from './batchShader';
import { STENCIL_DEPTH_FORMAT, targetSampleCount, type PipelineKey, type Pipelines, type StencilMode, type VertexLayout } from './Pipelines';
import type { GpuTextures } from './GpuTextures';
import type { GpuBuffers } from './GpuBuffers';
import type { Instruction } from './collect';
import type { RenderSurface } from './renderTargets';

// ───────────────────────── 虚拟命令

/** 画布或某张纹理源 */
export type TargetRef = 'canvas' | TextureSource;

export interface PassCmd {
  readonly t: 'pass';
  target: TargetRef;
  /** 纹理目标:本次要用的 RHI 纹理(规划时已建好 / 上传) */
  color: RhiTexture | null;
  load: 'clear' | 'load';
  clearColor: [number, number, number, number];
  stencil: boolean;
  stencilLoad: 'clear' | 'load';
  viewport: [number, number, number, number];
  /** 多重采样数:>1 时画进目标配套的多重采样纹理,pass 结束 resolve 回目标(antialias) */
  samples: number;
}

/**
 * uniform 在 Arena 里的片段。本身就是 RHI 的缓冲区段绑定:`buffer` 在规划完、本次的 uniform 缓冲建好后统一填上
 * (FrameBuilder.bindUniformBuffer),录制时绑定表原样交给 RHI,不再逐 draw 另拼一份
 */
export interface ArenaRef {
  buffer: RhiBuffer | null;
  /** Arena 里的字节偏移(= uniform 缓冲里的偏移) */
  offset: number;
  size: number;
}

export type BindingValue = RhiTexture | RhiSampler | RhiBuffer | ArenaRef | { buffer: RhiBuffer; offset?: number; size?: number };

export interface DrawCmd {
  readonly t: 'draw';
  pipeline: PipelineKey;
  bindings: Record<string, BindingValue>;
  /** 顶点流(名字 → 缓冲);'batch' = 本次合批顶点缓冲 */
  streams: Array<{ name: string; buffer: RhiBuffer | 'batch' }>;
  index: RhiBuffer | 'batch' | null;
  count: number;
  first: number;
  instances: number;
  stencilRef: number;
}

export type VirtualCommand = PassCmd | DrawCmd;

// ───────────────────────── 规划器用到的外部依赖

export interface FrameContext {
  textures: GpuTextures;
  buffers: GpuBuffers;
  pipelines: Pipelines;
  /** 画布:颜色格式、像素尺寸、分辨率 */
  canvas: { format: RhiColorFormat; pixelWidth: number; pixelHeight: number; resolution: number; antialias: boolean };
  /** 渲染器级的 roundPixels 开关 */
  roundPixels: number;
  /** 目标上是否已经挂过模板(照 Pixi:RenderTarget.stencil 一旦为 true 就一直带着) */
  stencilTargets: WeakSet<object>;
  canvasStencilKey: object;
}

// ───────────────────────── 常量资源

const batchProgram = new GpuProgram({
  name: 'engine2d-batch',
  vertex: { source: BATCH_WGSL, entryPoint: 'mainVertex' },
  fragment: { source: BATCH_WGSL, entryPoint: 'mainFragment' },
});

const graphicsProgram = new GpuProgram({
  name: 'engine2d-graphics',
  vertex: { source: GRAPHICS_WGSL, entryPoint: 'mainVertex' },
  fragment: { source: GRAPHICS_WGSL, entryPoint: 'mainFragment' },
});

const meshProgram = new GpuProgram({
  name: 'engine2d-mesh',
  vertex: { source: MESH_WGSL, entryPoint: 'mainVertex' },
  fragment: { source: MESH_WGSL, entryPoint: 'mainFragment' },
});

/** 合批着色器的纹理 / 采样器绑定名(常量表:每个 draw 都要填 16 对,不逐次拼串) */
const BATCH_TEXTURE_NAMES = Array.from({ length: MAX_BATCH_TEXTURES }, (_, i) => `textureSource${i + 1}`);
const BATCH_SAMPLER_NAMES = Array.from({ length: MAX_BATCH_TEXTURES }, (_, i) => `textureSampler${i + 1}`);

export const BATCH_LAYOUT: VertexLayout = {
  key: 'engine2d-batch',
  buffers: [
    {
      name: 'stream0',
      stride: 24,
      stepMode: 'vertex',
      attributes: [
        { name: 'aPosition', format: 'float32x2', offset: 0 },
        { name: 'aUV', format: 'float32x2', offset: 8 },
        { name: 'aColor', format: 'unorm8x4', offset: 16 },
        { name: 'aTextureIdAndRound', format: 'uint16x2', offset: 20 },
      ],
    },
  ],
  sources: [],
};

const quadGeometry = new Geometry({
  attributes: {
    aPosition: { buffer: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), format: 'float32x2', stride: 8, offset: 0 },
  },
  indexBuffer: new Uint32Array([0, 1, 2, 0, 2, 3]),
});

const GLOBAL_LAYOUT = createUboLayout([
  { name: 'uProjectionMatrix', type: 'mat3x3<f32>', size: 1 },
  { name: 'uWorldTransformMatrix', type: 'mat3x3<f32>', size: 1 },
  { name: 'uWorldColorAlpha', type: 'vec4<f32>', size: 1 },
  { name: 'uResolution', type: 'vec2<f32>', size: 1 },
  // 引擎自加的尾字段(Pixi 没有):离屏目标 1 / 画布 0,内置合批 / 图形 / 网格着色器的 roundPixels 按它翻 y 断平
  // (见 batchShader 的 ROUND_PIXELS_WGSL)。放在末尾,只声明前四个字段的游戏 WGSL 布局不受影响。
  { name: 'uRoundFlipY', type: 'f32', size: 1 },
]);

const LOCAL_LAYOUT = createUboLayout([
  { name: 'uTransformMatrix', type: 'mat3x3<f32>', size: 1 },
  { name: 'uColor', type: 'vec4<f32>', size: 1 },
  { name: 'uRound', type: 'f32', size: 1 },
]);

const TEXTURE_UNIFORMS_LAYOUT = createUboLayout([{ name: 'uTextureMatrix', type: 'mat3x3<f32>', size: 1 }]);

const FILTER_LAYOUT = createUboLayout([
  { name: 'uInputSize', type: 'vec4<f32>', size: 1 },
  { name: 'uInputPixel', type: 'vec4<f32>', size: 1 },
  { name: 'uInputClamp', type: 'vec4<f32>', size: 1 },
  { name: 'uOutputFrame', type: 'vec4<f32>', size: 1 },
  { name: 'uGlobalFrame', type: 'vec4<f32>', size: 1 },
  { name: 'uOutputTexture', type: 'vec4<f32>', size: 1 },
]);

/** 0xAABBGGRR → 预乘 rgba(照 Pixi color32BitToUniform) */
function color32BitToUniform(abgr: number, out: Float32Array | number[], offset: number): void {
  const alpha = ((abgr >> 24) & 255) / 255;
  out[offset++] = ((abgr & 255) / 255) * alpha;
  out[offset++] = (((abgr >> 8) & 255) / 255) * alpha;
  out[offset++] = (((abgr >> 16) & 255) / 255) * alpha;
  out[offset++] = alpha;
}

function calculateProjection(pm: Matrix, x: number, y: number, width: number, height: number, flipY: boolean): Matrix {
  const sign = flipY ? 1 : -1;
  pm.identity();
  pm.a = (1 / width) * 2;
  pm.d = sign * ((1 / height) * 2);
  pm.tx = -1 - x * pm.a;
  pm.ty = -sign - y * pm.d;
  return pm;
}

// ───────────────────────── 目标

interface BoundTarget {
  ref: TargetRef;
  /** 以它为键记模板状态 / 遮罩栈 */
  key: object;
  color: RhiTexture | null;
  format: RhiColorFormat;
  pixelWidth: number;
  pixelHeight: number;
  resolution: number;
  /** 逻辑尺寸 */
  width: number;
  height: number;
  antialias: boolean;
}

interface GlobalUniformData {
  projectionMatrix: Matrix;
  resolution: [number, number];
  worldTransformMatrix: Matrix;
  worldColor: number;
  offset: { x: number; y: number };
  arena: ArenaRef;
}

/** 照 Pixi AlphaMaskPipe 的 AlphaMaskEffect:一个只装 MaskFilter 的滤镜效果(按层复用) */
interface AlphaMaskEntry {
  effect: FilterEffect;
  filter: MaskFilter;
  /** 遮罩体先画进临时纹理时用的内部精灵(Pixi 的 `new Sprite(Texture.EMPTY)`) */
  internalSprite: Sprite;
  /** 内部精灵的世界变换(只有平移 = 临时纹理左上角) */
  internalWorld: Matrix;
  bounds: Bounds;
}

interface AlphaMaskStage {
  entry: AlphaMaskEntry;
  maskedContainer: Container;
  filterTexture?: Texture;
}

/**
 * 颜色写掩码:Pixi 的遮罩值按 WebGL `gl.colorMask(8 & m, 4 & m, 2 & m, 1 & m)` 解释(8 = R … 1 = A,master 走 WebGL);
 * RHI 用 WebGPU 位序(1 = R … 8 = A),四位倒过来。0 / 15(模板遮罩用的两个值)不变
 */
function colorMaskToRhi(m: number): number {
  return ((m & 8) >> 3) | ((m & 4) >> 1) | ((m & 2) << 1) | ((m & 1) << 3);
}

class FilterData {
  skip = false;
  inputTexture: Texture | null = null;
  backTexture: Texture | null = null;
  filters: readonly Filter[] | null = null;
  bounds = new Bounds();
  container: Container | null = null;
  blendRequired = false;
  outputRenderSurface: RenderSurface | 'canvas' | null = null;
  globalFrame = { x: 0, y: 0, width: 0, height: 0 };
  firstEnabledIndex = -1;
  lastEnabledIndex = -1;
  resolution = 1;
  antialias = false;
}

export class FrameBuilder implements FilterSystemLike {
  readonly commands: VirtualCommand[] = [];
  readonly arena = new Arena();

  private ctx!: FrameContext;
  // 目标
  private current!: BoundTarget;
  private currentSurface: RenderSurface | 'canvas' = 'canvas';
  private rootTarget!: BoundTarget;
  private readonly rootViewPort = new Rectangle();
  private readonly viewport = new Rectangle();
  private readonly projectionMatrix = new Matrix();
  /** 照 Pixi RenderTargetSystem 的 _renderTargetStack:只有 renderStart / pushRenderTarget 入栈(滤镜切目标用 bind,不入栈) */
  private readonly targetStack: Array<RenderSurface | 'canvas'> = [];
  private passStencil = false;
  private passSamples = 1;
  // 全局 uniform
  private guStack: GlobalUniformData[] = [];
  private currentGU!: GlobalUniformData;
  // 模板 / 颜色掩码(照 GpuStencilSystem:每个目标各记一份)
  private readonly stencilState = new Map<object, { mode: StencilMode; ref: number }>();
  private readonly maskStack = new Map<object, number>();
  private colorMask = 15;
  // 滤镜
  private readonly filterStack: FilterData[] = [];
  private filterStackIndex = 0;
  private activeFilterData: FilterData | null = null;
  private passthrough: Filter | null = null;
  // alpha 遮罩(AlphaMaskPipe)
  private readonly activeMaskStage: AlphaMaskStage[] = [];
  private readonly alphaMaskPool: AlphaMaskEntry[] = [];
  // 本次 render 内去重
  private readonly groupSlices = new Map<UniformGroup, ArenaRef>();
  /** 本次规划从纹理池借出、还没还的纹理(规划中途抛错时由 abort 归还) */
  private readonly borrowed = new Set<Texture>();
  /** updateFilterUniforms 的暂存数组 */
  private readonly filterScratch = {
    outputFrame: new Float32Array(4),
    inputSize: new Float32Array(4),
    inputPixel: new Float32Array(4),
    inputClamp: new Float32Array(4),
    globalFrame: new Float32Array(4),
    outputTexture: new Float32Array(4),
  };
  /** 本次 render 分出去的全部 uniform 片段(uniform 缓冲建好后统一填 buffer) */
  private readonly arenaRefs: ArenaRef[] = [];

  constructor(private readonly makePassthrough: () => Filter) {}

  begin(ctx: FrameContext): void {
    this.ctx = ctx;
    this.commands.length = 0;
    this.arena.reset();
    this.guStack = [];
    this.stencilState.clear();
    this.maskStack.clear();
    this.colorMask = 15;
    this.filterStackIndex = 0;
    this.activeFilterData = null;
    this.activeMaskStage.length = 0;
    this.groupSlices.clear();
    this.arenaRefs.length = 0;
    this.passStencil = false;
  }

  /**
   * 规划中途抛错(如池纹理超过设备上限、建纹理抛 unsupported)后调用:把借出的池纹理还回池里。
   * Pixi 在 WebGPU 上建出无效纹理也不抛,照常走到 filterPop / popAlphaMask 归还;这里不补还的话每失败一帧池里多一张
   */
  abort(): void {
    for (const t of this.borrowed) TexturePool.returnTexture(t);
    this.borrowed.clear();
  }

  private takePoolTexture(frameWidth: number, frameHeight: number, resolution: number, antialias: boolean): Texture {
    const t = TexturePool.getOptimalTexture(frameWidth, frameHeight, resolution, antialias);
    this.borrowed.add(t);
    return t;
  }

  private returnPoolTexture(t: Texture): void {
    this.borrowed.delete(t);
    TexturePool.returnTexture(t);
  }

  /** 本次的 uniform 缓冲建好了:填进本次分出去的每个片段(之后绑定表可以直接交给 RHI) */
  bindUniformBuffer(buffer: RhiBuffer | null): void {
    const refs = this.arenaRefs;
    for (let i = 0; i < refs.length; i++) refs[i].buffer = buffer;
  }

  /** 新的 uniform 片段(登记到本次的片段表) */
  private arenaRef(offset: number, size: number): ArenaRef {
    const ref: ArenaRef = { buffer: null, offset, size };
    this.arenaRefs.push(ref);
    return ref;
  }

  // ───────────────────────── 目标(RenderTargetSystem)

  renderStart(target: RenderSurface | 'canvas', clear: boolean, clearColor: [number, number, number, number]): void {
    this.targetStack.length = 0;
    this.pushRenderTarget(target, clear, clearColor);
    this.rootViewPort.copyFrom(this.viewport);
    this.rootTarget = this.current;
  }

  /** 照 Pixi RenderTargetSystem.push:绑定并入栈 */
  private pushRenderTarget(surface: RenderSurface | 'canvas', clear: boolean, clearColor?: [number, number, number, number]): void {
    this.bind(surface, clear, clearColor);
    this.targetStack.push(surface);
  }

  /**
   * 照 Pixi RenderTargetSystem.pop:出栈后以 load 重新绑定栈顶。栈里只有 renderStart / push 进来的目标,
   * 所以在滤镜里弹出时回到的是渲染根而不是滤镜的输入纹理(Pixi 原样)。Pixi 重绑的是 RenderTarget 对象、不带帧,
   * 根是带子帧的纹理时视口是整张纹理;这里按纹理的帧(只有子帧纹理当根时才有差别)
   */
  private popRenderTarget(): void {
    this.targetStack.pop();
    this.bind(this.targetStack[this.targetStack.length - 1], false);
  }

  /** 绑定目标并开新 pass(Pixi 的 bind:每次都开新 pass) */
  bind(surface: RenderSurface | 'canvas', clear: boolean, clearColor?: [number, number, number, number], frame?: Rectangle): void {
    const t = this.resolveTarget(surface);
    this.current = t;
    this.currentSurface = surface;
    if (!frame && surface instanceof Texture) frame = surface.frame;
    const viewport = this.viewport;
    if (frame) {
      const res = t.resolution;
      const baseX = (frame.x * res + 0.5) | 0;
      const baseY = (frame.y * res + 0.5) | 0;
      const baseW = (frame.width * res + 0.5) | 0;
      const baseH = (frame.height * res + 0.5) | 0;
      let x = baseX;
      let y = baseY;
      let w = baseW;
      let h = baseH;
      x = Math.min(Math.max(x, 0), t.pixelWidth - 1);
      y = Math.min(Math.max(y, 0), t.pixelHeight - 1);
      w = Math.min(Math.max(w, 1), t.pixelWidth - x);
      h = Math.min(Math.max(h, 1), t.pixelHeight - y);
      viewport.x = x;
      viewport.y = y;
      viewport.width = w;
      viewport.height = h;
    } else {
      viewport.x = 0;
      viewport.y = 0;
      viewport.width = t.pixelWidth;
      viewport.height = t.pixelHeight;
    }
    calculateProjection(this.projectionMatrix, 0, 0, viewport.width / t.resolution, viewport.height / t.resolution, false);
    this.startPass(clear, clearColor ?? [0, 0, 0, 0], clear);
  }

  private startPass(clearColor: boolean, color: [number, number, number, number], clearStencil: boolean): void {
    const t = this.current;
    const stencil = this.ctx.stencilTargets.has(t.key);
    const samples = targetSampleCount(t.antialias, t.format);
    this.passStencil = stencil;
    this.passSamples = samples;
    this.commands.push({
      t: 'pass',
      target: t.ref,
      color: t.color,
      load: clearColor ? 'clear' : 'load',
      clearColor: color,
      stencil,
      stencilLoad: clearStencil ? 'clear' : 'load',
      viewport: [this.viewport.x, this.viewport.y, this.viewport.width, this.viewport.height],
      samples,
    });
  }

  /** 遮罩要用模板了:目标此后一直带模板;当前 pass 没带就以 load 重开(照 Pixi ensureDepthStencil) */
  private ensureDepthStencil(): void {
    const key = this.current.key;
    if (!this.ctx.stencilTargets.has(key)) {
      this.ctx.stencilTargets.add(key);
      this.startPass(false, [0, 0, 0, 0], false);
    } else if (!this.passStencil) {
      this.startPass(false, [0, 0, 0, 0], false);
    }
  }

  private resolveTarget(surface: RenderSurface | 'canvas'): BoundTarget {
    if (surface === 'canvas' || (typeof HTMLCanvasElement !== 'undefined' && surface instanceof HTMLCanvasElement)) {
      const c = this.ctx.canvas;
      return {
        ref: 'canvas',
        key: this.ctx.canvasStencilKey,
        color: null,
        format: c.format,
        pixelWidth: c.pixelWidth,
        pixelHeight: c.pixelHeight,
        resolution: c.resolution,
        width: c.pixelWidth / c.resolution,
        height: c.pixelHeight / c.resolution,
        antialias: c.antialias,
      };
    }
    const source = surface instanceof Texture ? surface.source : (surface as TextureSource);
    const color = this.ctx.textures.get(source, true);
    return {
      ref: source,
      key: source,
      color,
      format: color.format as RhiColorFormat,
      pixelWidth: source.pixelWidth,
      pixelHeight: source.pixelHeight,
      resolution: source._resolution,
      width: source.width,
      height: source.height,
      antialias: source.antialias,
    };
  }

  // ───────────────────────── 全局 uniform(GlobalUniformSystem)

  globalStart(options: { worldTransformMatrix: Matrix; worldColor: number }): void {
    this.guStack = [];
    this.globalPush(options);
  }

  globalPush(options: { projectionMatrix?: Matrix; worldTransformMatrix?: Matrix; worldColor?: number; offset?: { x: number; y: number } }): void {
    const prev = this.guStack.length ? this.guStack[this.guStack.length - 1] : null;
    const cur = {
      worldTransformMatrix: prev?.worldTransformMatrix ?? new Matrix(),
      worldColor: prev?.worldColor ?? 0xffffffff,
      offset: prev?.offset ?? { x: 0, y: 0 },
    };
    const data: GlobalUniformData = {
      projectionMatrix: (options.projectionMatrix ?? this.projectionMatrix).clone(),
      resolution: [this.current.pixelWidth, this.current.pixelHeight],
      worldTransformMatrix: options.worldTransformMatrix ?? cur.worldTransformMatrix,
      worldColor: options.worldColor ?? cur.worldColor,
      offset: options.offset ?? cur.offset,
      arena: this.arenaRef(0, GLOBAL_LAYOUT.size),
    };
    const wt = data.worldTransformMatrix.clone();
    wt.tx -= data.offset.x;
    wt.ty -= data.offset.y;
    const color = new Float32Array(4);
    color32BitToUniform(data.worldColor, color, 0);
    data.arena.offset = this.writeUbo(GLOBAL_LAYOUT, {
      uProjectionMatrix: data.projectionMatrix,
      uWorldTransformMatrix: wt,
      uWorldColorAlpha: color,
      uResolution: data.resolution,
      uRoundFlipY: this.current.ref === 'canvas' ? 0 : 1,
    });
    this.guStack.push(data);
    this.currentGU = data;
  }

  globalPop(): void {
    this.guStack.pop();
    this.currentGU = this.guStack[this.guStack.length - 1];
  }

  // ───────────────────────── 指令执行

  execute(instr: Instruction): void {
    switch (instr.t) {
      case 'batch':
        this.drawBatch(instr);
        return;
      case 'custom':
        this.drawCustom(instr.drawable);
        return;
      case 'unbatched':
        this.drawUnbatched(instr.item, instr.batches);
        return;
      case 'pushFilter':
        this.filterPush(instr.container, instr.effect);
        return;
      case 'popFilter':
        this.filterPop();
        return;
      case 'pushAlphaMaskBegin':
      case 'pushAlphaMaskEnd':
      case 'popAlphaMaskEnd':
        this.alphaMaskExecute(instr);
        return;
      case 'colorMask':
        // 照 Pixi ColorMaskPipe.execute → ColorMaskSystem.setMask
        this.colorMask = instr.colorMask;
        return;
      default:
        this.maskExecute(instr);
    }
  }

  /** 不合批图形(照 Pixi GraphicsPipe.execute + GpuGraphicsAdaptor.execute) */
  private drawUnbatched(item: UnbatchedGraphics, batches: readonly BatchRecord[]): void {
    if (!item.isRenderable) return;
    const color = new Float32Array(4);
    color32BitToUniform(item.groupColorAlpha, color, 0);
    const local = this.arenaRef(
      this.writeUbo(LOCAL_LAYOUT, {
        uTransformMatrix: item.groupTransform,
        uColor: color,
        uRound: this.ctx.roundPixels | item._roundPixels,
      }),
      LOCAL_LAYOUT.size,
    );
    for (const batch of batches) this.drawBatch(batch, graphicsProgram, item.groupBlendMode, local);
  }

  private drawBatch(batch: BatchRecord, program = batchProgram, blend: BlendMode = batch.blendMode, local?: ArenaRef): void {
    const bindings: Record<string, BindingValue> = { globalUniforms: this.currentGU.arena };
    if (local) bindings.localUniforms = local;
    const empty = Texture.EMPTY.source;
    const textures = this.ctx.textures;
    for (let i = 0; i < MAX_BATCH_TEXTURES; i++) {
      const source = batch.textures[i] ?? empty;
      bindings[BATCH_TEXTURE_NAMES[i]] = textures.get(source);
      bindings[BATCH_SAMPLER_NAMES[i]] = textures.sampler(source.style);
    }
    this.pushDraw({
      program,
      layout: BATCH_LAYOUT,
      topology: batch.topology,
      blend,
      bindings,
      streams: [{ name: 'stream0', buffer: 'batch' }],
      index: 'batch',
      count: batch.size,
      first: batch.start,
      instances: 1,
    });
  }

  private drawCustom(mesh: CustomDrawable): void {
    const m = mesh as CustomDrawable & { isRenderable?: boolean; _roundPixels?: number };
    if (m.isRenderable === false) return;
    const shader = mesh.shader;
    const texture = mesh.texture;
    const blend = adjustedBlendMode(mesh.groupBlendMode, texture.source);
    const local = new Float32Array(4);
    color32BitToUniform(mesh.groupColorAlpha, local, 0);
    const localRef = this.arenaRef(
      this.writeUbo(LOCAL_LAYOUT, {
        uTransformMatrix: mesh.groupTransform,
        uColor: local,
        uRound: this.ctx.roundPixels | (m._roundPixels ?? 0),
      }),
      LOCAL_LAYOUT.size,
    );
    // 照 Pixi GpuMeshAdapter:带 shader 却没有 WGSL 程序时告警并跳过这次绘制,不拿缺省网格程序顶替
    if (shader && !shader.gpuProgram) {
      warn('Mesh shader has no gpuProgram', shader);
      return;
    }
    const program = shader ? shader.gpuProgram! : meshProgram;
    const bindings: Record<string, BindingValue> = {
      globalUniforms: this.currentGU.arena,
      localUniforms: localRef,
    };
    if (!shader) {
      bindings.uTexture = this.ctx.textures.get(texture.source);
      bindings.uSampler = this.ctx.textures.sampler(texture.source.style);
      // 照 Pixi GlMeshAdaptor / GpuTextureSystem:总是纹理矩阵的 mapCoord(isSimple 只说帧是整张源,trim 仍会进矩阵)
      bindings.textureUniforms = this.arenaRef(
        this.writeUbo(TEXTURE_UNIFORMS_LAYOUT, { uTextureMatrix: texture.textureMatrix.mapCoord }),
        TEXTURE_UNIFORMS_LAYOUT.size,
      );
    } else {
      this.resolveResources(shader, bindings);
      if (!('uTexture' in bindings)) {
        bindings.uTexture = this.ctx.textures.get(texture.source);
        if (!('uSampler' in bindings)) bindings.uSampler = this.ctx.textures.sampler(texture.source.style);
      }
    }
    this.drawGeometry(program, mesh.geometry, blend, bindings);
  }

  private drawGeometry(program: GpuProgram, geometry: Geometry, blend: BlendMode, bindings: Record<string, BindingValue>, instanceCount?: number): void {
    const layout = this.ctx.pipelines.layout(geometry, program);
    const streams = layout.buffers.map((b, i) => ({ name: b.name, buffer: this.ctx.buffers.get(layout.sources[i]) as RhiBuffer | 'batch' }));
    const index = geometry.indexBuffer ? this.ctx.buffers.get(geometry.indexBuffer) : null;
    const count = geometry.indexBuffer ? geometry.indexBuffer.data.length : geometry.getSize();
    this.pushDraw({
      program,
      layout,
      topology: geometry.topology,
      blend,
      bindings,
      streams,
      index,
      count,
      first: 0,
      instances: instanceCount ?? geometry.instanceCount,
    });
  }

  private pushDraw(d: {
    program: GpuProgram;
    layout: VertexLayout;
    topology: DrawCmd['pipeline']['topology'];
    blend: BlendMode;
    bindings: Record<string, BindingValue>;
    streams: DrawCmd['streams'];
    index: DrawCmd['index'];
    count: number;
    first: number;
    instances: number;
  }): void {
    if (d.count <= 0) return;
    const st = this.stencilState.get(this.current.key) ?? { mode: 'disabled' as StencilMode, ref: 0 };
    this.commands.push({
      t: 'draw',
      pipeline: {
        program: d.program,
        layout: d.layout,
        topology: d.topology,
        blend: d.blend,
        colorFormat: this.current.format,
        depthFormat: this.passStencil ? STENCIL_DEPTH_FORMAT : null,
        stencil: st.mode,
        colorMask: colorMaskToRhi(this.colorMask),
        sampleCount: this.passSamples,
      },
      bindings: d.bindings,
      streams: d.streams,
      index: d.index,
      count: d.count,
      first: d.first,
      instances: d.instances,
      stencilRef: st.ref,
    });
  }

  /** 着色器资源表 → 绑定(UniformGroup 快照进 Arena;纹理源 / 采样器 / 缓冲取 GPU 对象) */
  private resolveResources(shader: Shader, out: Record<string, BindingValue>): void {
    const res = shader.resources;
    for (const name in res) {
      const v = res[name] as unknown;
      if (v == null) continue;
      if (v instanceof UniformGroup) {
        out[name] = this.snapshotGroup(v);
      } else if (v instanceof TextureSource) {
        out[name] = this.ctx.textures.get(v);
      } else if (v instanceof Texture) {
        out[name] = this.ctx.textures.get(v.source);
      } else if ((v as TextureStyle)._resourceType === 'textureSampler') {
        out[name] = this.ctx.textures.sampler(v as TextureStyle);
      } else if (v instanceof Buffer) {
        out[name] = this.ctx.buffers.get(v);
      } else if (v instanceof BufferResource) {
        out[name] = { buffer: this.ctx.buffers.get(v.buffer), offset: v.offset, size: v.size || undefined };
      }
    }
  }

  /**
   * UniformGroup 按"绘制当时的值"拍快照(滤镜会在同一次 render 里改了值再画,例如模糊的多个 pass)。
   * 与这个组上一次的快照逐字节相同就复用那份、退回刚分配的空间。
   */
  private snapshotGroup(g: UniformGroup): ArenaRef {
    const layout = g.layout;
    const mark = this.arena.size;
    const offset = this.writeUbo(layout, g.uniforms);
    const prev = this.groupSlices.get(g);
    if (prev && this.arena.equal(prev.offset, offset, layout.size)) {
      this.arena.size = mark;
      return prev;
    }
    const ref = this.arenaRef(offset, layout.size);
    this.groupSlices.set(g, ref);
    return ref;
  }

  private writeUbo(layout: ReturnType<typeof createUboLayout>, values: Record<string, unknown>): number {
    const offset = this.arena.alloc(layout.size);
    packUbo(layout, values, this.arena.f32, this.arena.i32, this.arena.u32, offset / 4);
    return offset;
  }

  // ───────────────────────── 模板遮罩(StencilMaskPipe + GpuStencilSystem + GpuColorMaskSystem)

  private setStencilMode(mode: StencilMode, ref: number): void {
    this.stencilState.set(this.current.key, { mode, ref });
  }

  private maskExecute(instr: Extract<Instruction, { t: 'pushMaskBegin' | 'pushMaskEnd' | 'popMaskBegin' | 'popMaskEnd' }>): void {
    const key = this.current.key;
    let maskStackIndex = this.maskStack.get(key) ?? 0;
    if (instr.t === 'pushMaskBegin') {
      this.ensureDepthStencil();
      this.setStencilMode('add', maskStackIndex);
      maskStackIndex++;
      this.colorMask = 0;
    } else if (instr.t === 'pushMaskEnd') {
      this.setStencilMode(instr.inverse ? 'inverse' : 'active', maskStackIndex);
      this.colorMask = 15;
    } else if (instr.t === 'popMaskBegin') {
      this.colorMask = 0;
      if (maskStackIndex !== 0) this.setStencilMode('remove', maskStackIndex);
      else {
        this.startPass(false, [0, 0, 0, 0], true);
        this.setStencilMode('disabled', maskStackIndex);
      }
      maskStackIndex--;
    } else if (instr.t === 'popMaskEnd') {
      // 照 Pixi StencilMaskPipe.execute:弹出后总回到 MASK_ACTIVE(外层反向遮罩也不例外)
      this.setStencilMode('active', maskStackIndex);
      this.colorMask = 15;
    }
    this.maskStack.set(key, maskStackIndex);
  }

  // ───────────────────────── alpha 遮罩(AlphaMaskPipe)

  private alphaMaskExecute(instr: Extract<Instruction, { t: 'pushAlphaMaskBegin' | 'pushAlphaMaskEnd' | 'popAlphaMaskEnd' }>): void {
    const renderMask = instr.mask.renderMaskToTexture;
    if (instr.t === 'pushAlphaMaskBegin') {
      const entry = this.alphaMaskPool.pop() ?? createAlphaMaskEntry();
      entry.filter.inverse = instr.inverse;
      if (renderMask) {
        const maskContainer = instr.mask.mask;
        maskContainer.measurable = true;
        const bounds = this.maskGlobalBounds(maskContainer, entry.bounds);
        maskContainer.measurable = false;
        bounds.ceil();
        const target = this.current;
        const filterTexture = this.takePoolTexture(bounds.width, bounds.height, target.resolution, target.antialias);
        this.pushRenderTarget(filterTexture, true);
        this.globalPush({ offset: bounds, worldColor: 0xffffffff });
        const sprite = entry.internalSprite;
        sprite.texture = filterTexture;
        entry.internalWorld.set(1, 0, 0, 1, bounds.minX, bounds.minY);
        entry.filter.sprite = sprite;
        entry.filter.spriteWorldTransform = entry.internalWorld;
        this.activeMaskStage.push({ entry, maskedContainer: instr.container, filterTexture });
      } else {
        entry.filter.sprite = instr.mask.mask as Sprite;
        entry.filter.spriteWorldTransform = null;
        this.activeMaskStage.push({ entry, maskedContainer: instr.container });
      }
    } else if (instr.t === 'pushAlphaMaskEnd') {
      const maskData = this.activeMaskStage[this.activeMaskStage.length - 1];
      if (renderMask) {
        this.popRenderTarget();
        this.globalPop();
      }
      this.filterPush(maskData.maskedContainer, maskData.entry.effect);
    } else {
      this.filterPop();
      const maskData = this.activeMaskStage.pop()!;
      if (renderMask) this.returnPoolTexture(maskData.filterTexture!);
      // 进池前换回内部精灵:不替用户的遮罩精灵续命(Pixi 池里的效果会一直指着它,之后走画进纹理的路径时还会改它的纹理)
      maskData.entry.filter.sprite = maskData.entry.internalSprite;
      this.alphaMaskPool.push(maskData.entry);
    }
  }

  /**
   * 照 Pixi `getGlobalBounds(mask, skipUpdateTransform = true)`:各节点用本次渲染的世界变换(相对根的 groupTransform × 根变换),
   * 只看 visible / measurable(不看 renderable / culled)
   */
  private maskGlobalBounds(mask: Container, bounds: Bounds): Bounds {
    bounds.clear();
    const rootWorld = this.guStack[0].worldTransformMatrix;
    globalBoundsRecursive(mask, bounds, rootWorld);
    if (!bounds.isValid) bounds.set(0, 0, 0, 0);
    return bounds;
  }

  /** 照 Pixi FilterSystem.calculateSpriteMatrix(精灵的世界变换 = 本次渲染的 groupTransform × 根变换) */
  calculateSpriteMatrix(outputMatrix: Matrix, sprite: Sprite, worldTransform?: Matrix): Matrix {
    const data = this.activeFilterData!;
    const mappedMatrix = outputMatrix.set(
      data.inputTexture!.source.width,
      0,
      0,
      data.inputTexture!.source.height,
      data.bounds.minX,
      data.bounds.minY,
    );
    const world = worldTransform ? worldTransform.clone() : new Matrix().appendFrom(sprite.groupTransform, this.guStack[0].worldTransformMatrix);
    world.invert();
    mappedMatrix.prepend(world);
    mappedMatrix.scale(1 / sprite.texture.orig.width, 1 / sprite.texture.orig.height);
    mappedMatrix.translate(sprite.anchor.x, sprite.anchor.y);
    return mappedMatrix;
  }

  // ───────────────────────── 滤镜(FilterSystem)

  private filterPush(container: Container, effect: FilterEffect): void {
    const filters = effect.filters ?? [];
    const filterData = this.pushFilterData();
    filterData.skip = false;
    filterData.filters = filters;
    filterData.container = container;
    filterData.outputRenderSurface = this.currentSurface;
    const rootResolution = this.current.resolution;
    const rootAntialias = this.current.antialias;
    if (filters.every((f) => !f.enabled)) {
      filterData.skip = true;
      return;
    }
    const bounds = filterData.bounds;
    this.calculateFilterArea(container, effect, bounds);
    this.calculateFilterBounds(filterData, this.rootViewPort, rootAntialias, rootResolution, 1);
    if (filterData.skip) return;
    const previousFilterData = this.getPreviousFilterData();
    const globalResolution = this.findFilterResolution(rootResolution);
    let offsetX = 0;
    let offsetY = 0;
    if (previousFilterData) {
      offsetX = previousFilterData.bounds.minX;
      offsetY = previousFilterData.bounds.minY;
    }
    const gf = filterData.globalFrame;
    gf.x = offsetX * globalResolution;
    gf.y = offsetY * globalResolution;
    gf.width = this.current.width * globalResolution;
    gf.height = this.current.height * globalResolution;
    // _setupFilterTextures
    filterData.backTexture = Texture.EMPTY;
    filterData.inputTexture = this.takePoolTexture(bounds.width, bounds.height, filterData.resolution, filterData.antialias);
    if (filterData.blendRequired) {
      filterData.backTexture = this.getBackTexture(bounds, previousFilterData?.bounds);
    }
    this.bind(filterData.inputTexture, true);
    this.globalPush({ offset: bounds });
  }

  private filterPop(): void {
    const filterData = this.popFilterData();
    if (filterData.skip) return;
    this.globalPop();
    this.activeFilterData = filterData;
    this.applyFiltersToTexture(filterData, false);
    if (filterData.blendRequired && filterData.backTexture) this.returnPoolTexture(filterData.backTexture);
    this.returnPoolTexture(filterData.inputTexture!);
  }

  /** 混合型滤镜要的"背景"纹理:把输出目标上对应区域拷一份(本实现用绘制拷贝,录制时生效) */
  private getBackTexture(bounds: Bounds, previousBounds?: Bounds): Texture {
    const out = this.current;
    const res = out.resolution;
    const back = this.takePoolTexture(bounds.width, bounds.height, res, false);
    let x = bounds.minX;
    let y = bounds.minY;
    if (previousBounds) {
      x -= previousBounds.minX;
      y -= previousBounds.minY;
    }
    x = Math.floor(x * res);
    y = Math.floor(y * res);
    void x;
    void y;
    // 目前运行时没有 blendRequired 的滤镜;真要用时补一条纹理区域拷贝命令
    throw new Error('[engine2d] blendRequired 滤镜暂不支持(运行时未用到)');
    return back;
  }

  /** FilterSystemLike:滤镜的 apply 回调这里 */
  applyFilter(filter: Filter, input: Texture, output: RenderSurface | 'canvas', clear: boolean): void {
    const filterData = this.activeFilterData!;
    const isFinalTarget = filterData.outputRenderSurface === output;
    const rootResolution = this.rootTarget.resolution;
    const resolution = this.findFilterResolution(rootResolution);
    let offsetX = 0;
    let offsetY = 0;
    if (isFinalTarget) {
      const o = this.findPreviousFilterOffset();
      offsetX = o.x;
      offsetY = o.y;
    }
    const u = this.updateFilterUniforms(input, output, filterData, offsetX, offsetY, resolution, isFinalTarget, clear);
    const f = filter.enabled ? filter : this.getPassthrough();
    const bindings: Record<string, BindingValue> = {};
    this.resolveResources(f, bindings);
    bindings.gfu = u;
    bindings.uTexture = this.ctx.textures.get(input.source);
    bindings.uSampler = this.ctx.textures.sampler(input.source.style);
    if (filterData.backTexture) bindings.uBackTexture = this.ctx.textures.get(filterData.backTexture.source);
    const program = f.gpuProgram;
    if (!program) throw new Error('[engine2d] 滤镜没有 WGSL 程序(gpuProgram)');
    this.drawGeometry(program, quadGeometry, f.blendMode, bindings);
  }

  private updateFilterUniforms(
    input: Texture,
    output: RenderSurface | 'canvas',
    filterData: FilterData,
    offsetX: number,
    offsetY: number,
    resolution: number,
    isFinalTarget: boolean,
    clear: boolean,
  ): ArenaRef {
    // 暂存数组复用(写进 Arena 时就拷走了,不跨调用保留)
    const { outputFrame, inputSize, inputPixel, inputClamp, globalFrame, outputTexture } = this.filterScratch;
    outputFrame.fill(0);
    inputSize.fill(0);
    inputPixel.fill(0);
    inputClamp.fill(0);
    globalFrame.fill(0);
    outputTexture.fill(0);
    if (isFinalTarget) {
      outputFrame[0] = filterData.bounds.minX - offsetX;
      outputFrame[1] = filterData.bounds.minY - offsetY;
    }
    outputFrame[2] = input.frame.width;
    outputFrame[3] = input.frame.height;
    inputSize[0] = input.source.width;
    inputSize[1] = input.source.height;
    inputSize[2] = 1 / inputSize[0];
    inputSize[3] = 1 / inputSize[1];
    inputPixel[0] = input.source.pixelWidth;
    inputPixel[1] = input.source.pixelHeight;
    inputPixel[2] = 1 / inputPixel[0];
    inputPixel[3] = 1 / inputPixel[1];
    inputClamp[0] = 0.5 * inputPixel[2];
    inputClamp[1] = 0.5 * inputPixel[3];
    inputClamp[2] = input.frame.width * inputSize[2] - 0.5 * inputPixel[2];
    inputClamp[3] = input.frame.height * inputSize[3] - 0.5 * inputPixel[3];
    const root = this.rootTarget;
    globalFrame[0] = offsetX * resolution;
    globalFrame[1] = offsetY * resolution;
    globalFrame[2] = root.width * resolution;
    globalFrame[3] = root.height * resolution;
    this.bind(output, !!clear);
    if (output instanceof Texture) {
      outputTexture[0] = output.frame.width;
      outputTexture[1] = output.frame.height;
    } else {
      outputTexture[0] = this.current.width;
      outputTexture[1] = this.current.height;
    }
    outputTexture[2] = -1;
    return this.arenaRef(
      this.writeUbo(FILTER_LAYOUT, {
        uInputSize: inputSize,
        uInputPixel: inputPixel,
        uInputClamp: inputClamp,
        uOutputFrame: outputFrame,
        uGlobalFrame: globalFrame,
        uOutputTexture: outputTexture,
      }),
      FILTER_LAYOUT.size,
    );
  }

  private getPassthrough(): Filter {
    return (this.passthrough ??= this.makePassthrough());
  }

  private findFilterResolution(rootResolution: number): number {
    let i = this.filterStackIndex - 1;
    while (i > 0 && this.filterStack[i].skip) --i;
    return i > 0 && this.filterStack[i].inputTexture ? this.filterStack[i].inputTexture!.source._resolution : rootResolution;
  }

  private findPreviousFilterOffset(): { x: number; y: number } {
    let x = 0;
    let y = 0;
    let last = this.filterStackIndex;
    while (last > 0) {
      last--;
      const prev = this.filterStack[last];
      if (!prev.skip) {
        x = prev.bounds.minX;
        y = prev.bounds.minY;
        break;
      }
    }
    return { x, y };
  }

  /** 滤镜区域 = 容器子树在世界空间的包围盒(照 Pixi getFastGlobalBounds;用本次渲染算好的相对变换 × 根变换) */
  private calculateFilterArea(container: Container, effect: FilterEffect, bounds: Bounds): void {
    const rootWorld = this.currentGU ? this.guStack[0].worldTransformMatrix : Matrix.IDENTITY;
    if (effect.filterArea) {
      bounds.clear();
      bounds.addRect(effect.filterArea);
      bounds.applyMatrix(new Matrix().appendFrom(container.groupTransform, rootWorld));
      return;
    }
    bounds.clear();
    fastBoundsRecursive(container, bounds, rootWorld);
    if (!bounds.isValid) bounds.set(0, 0, 0, 0);
    bounds.applyMatrix(rootWorld);
  }

  private calculateFilterBounds(filterData: FilterData, viewPort: Rectangle, rootAntialias: boolean, rootResolution: number, paddingMultiplier: number): void {
    const bounds = filterData.bounds;
    const filters = filterData.filters!;
    let resolution = Infinity;
    let padding = 0;
    let antialias = true;
    let blendRequired = false;
    let enabled = false;
    let clipToViewport = true;
    let first = -1;
    let last = -1;
    for (let i = 0; i < filters.length; i++) {
      const filter = filters[i];
      if (!filter.enabled) continue;
      if (first === -1) first = i;
      last = i;
      resolution = Math.min(resolution, filter.resolution === 'inherit' ? rootResolution : filter.resolution);
      padding += filter.padding;
      if (filter.antialias === 'off') antialias = false;
      else if (filter.antialias === 'inherit') antialias &&= rootAntialias;
      if (!filter.clipToViewport) clipToViewport = false;
      if (!(filter.compatibleRenderers & 2)) {
        enabled = false;
        break;
      }
      enabled = true;
      blendRequired ||= filter.blendRequired;
    }
    if (!enabled) {
      filterData.skip = true;
      return;
    }
    if (clipToViewport) bounds.fitBounds(0, viewPort.width / rootResolution, 0, viewPort.height / rootResolution);
    bounds.scale(resolution).ceil().scale(1 / resolution).pad((padding | 0) * paddingMultiplier);
    if (!bounds.isPositive) {
      filterData.skip = true;
      return;
    }
    filterData.antialias = antialias;
    filterData.resolution = resolution;
    filterData.blendRequired = blendRequired;
    filterData.firstEnabledIndex = first;
    filterData.lastEnabledIndex = last;
  }

  private applyFiltersToTexture(filterData: FilterData, clear: boolean): void {
    const inputTexture = filterData.inputTexture!;
    const bounds = filterData.bounds;
    const filters = filterData.filters!;
    const first = filterData.firstEnabledIndex;
    const last = filterData.lastEnabledIndex;
    const output = filterData.outputRenderSurface!;
    if (first === last) {
      filters[first].apply(this, inputTexture, output as RenderSurface, clear);
    } else {
      let flip = inputTexture;
      const temp = this.takePoolTexture(bounds.width, bounds.height, flip.source._resolution, false);
      let flop = temp;
      for (let i = first; i < last; i++) {
        const filter = filters[i];
        if (!filter.enabled) continue;
        filter.apply(this, flip, flop, true);
        const t = flip;
        flip = flop;
        flop = t;
      }
      filters[last].apply(this, flip, output as RenderSurface, clear);
      this.returnPoolTexture(temp);
    }
  }

  private popFilterData(): FilterData {
    this.filterStackIndex--;
    return this.filterStack[this.filterStackIndex];
  }

  private getPreviousFilterData(): FilterData | undefined {
    let prev: FilterData | undefined;
    let index = this.filterStackIndex - 1;
    while (index > 0) {
      index--;
      prev = this.filterStack[index];
      if (!prev.skip) break;
    }
    return prev;
  }

  private pushFilterData(): FilterData {
    let d = this.filterStack[this.filterStackIndex];
    if (!d) d = this.filterStack[this.filterStackIndex] = new FilterData();
    this.filterStackIndex++;
    return d;
  }
}

function createAlphaMaskEntry(): AlphaMaskEntry {
  // 照 Pixi AlphaMaskEffect:MaskFilter({ sprite: new Sprite(Texture.EMPTY), inverse: false, resolution / antialias: 'inherit' })
  const internalSprite = new Sprite(Texture.EMPTY);
  const filter = new MaskFilter({ sprite: internalSprite, inverse: false, resolution: 'inherit', antialias: 'inherit' });
  const effect = new FilterEffect();
  effect.filters = [filter];
  return { effect, filter, internalSprite, internalWorld: new Matrix(), bounds: new Bounds() };
}

/** 照 Pixi `_getGlobalBounds`(skipUpdateTransform = true):世界变换取本次渲染的 groupTransform × 根变换 */
function globalBoundsRecursive(c: Container, bounds: Bounds, rootWorld: Matrix): void {
  if (!c._activeSelf || !c.visible || !c.measurable) return;
  const world = new Matrix().appendFrom(c.groupTransform, rootWorld);
  const parentBounds = bounds;
  const preserve = c.effects.length > 0;
  if (preserve) bounds = new Bounds();
  if (c.boundsArea) {
    bounds.addRect(c.boundsArea, world);
  } else {
    const own = c.bounds;
    if (own && !own.isEmpty()) {
      bounds.matrix = world;
      bounds.addBounds(own);
    }
    for (const child of c.children) globalBoundsRecursive(child, bounds, rootWorld);
  }
  if (preserve) {
    for (const e of c.effects) e.addBounds?.(bounds);
    parentBounds.addBounds(bounds, Matrix.IDENTITY);
  }
}

/**
 * 照 Pixi `_getGlobalBoundsRecursive`(factorRenderLayers 忽略):只算完全可见(localDisplayStatus === 7)且可量的节点,
 * 坐标用相对渲染根的 groupTransform;带效果的节点先在自己的局部盒里收集,遮罩效果按世界空间求交。
 */
function fastBoundsRecursive(c: Container, bounds: Bounds, rootWorld: Matrix): void {
  // 未激活的子树与 Pixi 里 visible=false 的一样不计(它的 groupTransform 本次也没算过)
  if (!c._activeSelf || c.localDisplayStatus !== 7 || !c.measurable) return;
  const manageEffects = c.effects.length > 0;
  const local = manageEffects ? new Bounds() : bounds;
  if (c.boundsArea) {
    local.addRect(c.boundsArea, c.groupTransform);
  } else {
    if (c.renderPipeId) {
      const vb = c.bounds;
      if (vb) local.addFrame(vb.minX, vb.minY, vb.maxX, vb.maxY, c.groupTransform);
    }
    for (const child of c.children) fastBoundsRecursive(child, local, rootWorld);
  }
  if (manageEffects) {
    let advanced = false;
    for (const e of c.effects) {
      if (e.addBounds) {
        if (!advanced) {
          advanced = true;
          local.applyMatrix(rootWorld);
        }
        e.addBounds(local);
      }
    }
    if (advanced) local.applyMatrix(rootWorld.clone().invert());
    bounds.addBounds(local);
  }
}
