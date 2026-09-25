/**
 * engine2d 的具体渲染器。每次 `render()`:
 *   onRender 回调 → 算本次世界量 → 收集指令 → 规划(虚拟命令 + uniform 快照 + 纹理 / 缓冲上传)
 *   → 写本次的合批顶点 / 索引 / uniform 缓冲 → 在 RHI 上录制并提交(画到画布走 runFrame,画到纹理走 submit)。
 * 录制之前所有写入都已完成,录制中不写任何资源(RHI 的"录制期不许写已引用资源"不会触发)。
 * 嵌套调用(onRender 回调里再 render)用独立的一套规划状态,各自提交。
 */
import {
  RhiBufferUsage,
  RhiTextureUsage,
  type RhiBindings,
  type RhiBuffer,
  type RhiColorFormat,
  type RhiCommandList,
  type RhiFrame,
  type RhiRenderPassEncoder,
  type RhiRenderTarget,
  type RhiResourceScope,
  type RhiTexture,
} from '../../rendering/rhi';
import { RendererBase, type ExtractOptions, type ExtractSystem, type GenerateTextureOptions, type RenderOptions, type RendererOptions } from './Renderer';
import { Container, getLocalBounds } from '../scene/Container';
import { Bounds } from '../scene/Bounds';
import { Matrix } from '../math/Matrix';
import { Rectangle } from '../math/Rectangle';
import { Color } from '../color/Color';
import { Texture } from '../textures/Texture';
import { RenderTexture } from '../textures/RenderTexture';
import { TextureSource } from '../textures/TextureSource';
import { Filter } from '../filters/Filter';
import { GpuProgram } from '../shader/GpuProgram';
import { GpuTextures } from './GpuTextures';
import { GpuBuffers } from './GpuBuffers';
import { Pipelines, STENCIL_DEPTH_FORMAT } from './Pipelines';
import { Batcher } from './Batcher';
import { Collector, prepareTree } from './collect';
import { FrameBuilder, type ArenaRef, type BindingValue, type PassCmd, type VirtualCommand } from './FrameBuilder';
import type { RenderSurface } from './renderTargets';

const PASSTHROUGH_WGSL = /* wgsl */ `
struct GlobalFilterUniforms {
  uInputSize: vec4<f32>,
  uInputPixel: vec4<f32>,
  uInputClamp: vec4<f32>,
  uOutputFrame: vec4<f32>,
  uGlobalFrame: vec4<f32>,
  uOutputTexture: vec4<f32>,
};
@group(0) @binding(0) var<uniform> gfu: GlobalFilterUniforms;
@group(0) @binding(1) var uTexture: texture_2d<f32>;
@group(0) @binding(2) var uSampler: sampler;
struct VSOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>
};
fn filterVertexPosition(aPosition: vec2<f32>) -> vec4<f32> {
  var position = aPosition * gfu.uOutputFrame.zw + gfu.uOutputFrame.xy;
  position.x = position.x * (2.0 / gfu.uOutputTexture.x) - 1.0;
  position.y = position.y * (2.0 * gfu.uOutputTexture.z / gfu.uOutputTexture.y) - gfu.uOutputTexture.z;
  return vec4(position, 0.0, 1.0);
}
fn filterTextureCoord(aPosition: vec2<f32>) -> vec2<f32> {
  return aPosition * (gfu.uOutputFrame.zw * gfu.uInputSize.zw);
}
@vertex
fn mainVertex(@location(0) aPosition: vec2<f32>) -> VSOutput {
  return VSOutput(filterVertexPosition(aPosition), filterTextureCoord(aPosition));
}
@fragment
fn mainFragment(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
  return textureSample(uTexture, uSampler, uv);
}
`;

function makePassthrough(): Filter {
  return new Filter({
    gpuProgram: GpuProgram.from({
      name: 'engine2d-passthrough',
      vertex: { source: PASSTHROUGH_WGSL, entryPoint: 'mainVertex' },
      fragment: { source: PASSTHROUGH_WGSL, entryPoint: 'mainFragment' },
    }),
    resources: {},
  });
}

/** 一套规划状态 + 它的上传缓冲(嵌套 render 各用一套) */
class RenderState {
  readonly batcher = new Batcher();
  readonly collector: Collector;
  readonly builder = new FrameBuilder(makePassthrough);
  vertexBuffer: RhiBuffer | null = null;
  indexBuffer: RhiBuffer | null = null;
  uniformBuffer: RhiBuffer | null = null;

  constructor() {
    this.collector = new Collector(this.batcher, 1);
  }
}

interface TargetEntry {
  plain?: RhiRenderTarget;
  stencil?: RhiRenderTarget;
  depth?: RhiTexture;
}

export class WebGPURenderer extends RendererBase {
  readonly extract: ExtractSystem;
  private readonly scope: RhiResourceScope;
  private readonly textures: GpuTextures;
  private readonly buffers: GpuBuffers;
  private readonly pipelines: Pipelines;
  private readonly states: RenderState[] = [];
  private depth = 0;
  private readonly targets = new Map<RhiTexture, TargetEntry>();
  private readonly stencilTargets = new WeakSet<object>();
  private readonly canvasKey = {};
  private destroyed = false;
  antialias: boolean;
  /** 设备是 createRenderer 替它建的:渲染器销毁时一起销毁 */
  ownsDevice = false;

  constructor(options: RendererOptions) {
    super(options);
    this.antialias = !!options.antialias;
    this.scope = this.rhi.createScope('engine2d');
    this.textures = new GpuTextures(this.rhi, this.scope);
    this.textures.onRelease = (t) => this.releaseTargets(t);
    this.buffers = new GpuBuffers(this.rhi, this.scope);
    this.pipelines = new Pipelines(this.scope);
    this.extract = createExtract(this);
  }

  // ───────────────────────── render

  render(input: Container | RenderOptions): void {
    if (this.destroyed) return;
    const options: RenderOptions = input instanceof Container ? { container: input } : { ...input };
    const container = options.container;
    const toCanvas = options.target === undefined || options.target === this.canvas;
    let clear = options.clear;
    let clearColor = options.clearColor;
    if (toCanvas) {
      this.lastObjectRendered = container;
      clearColor ??= this.background.colorRgba;
      clear ??= this.background.clearBeforeRender;
    }
    clear ??= true;
    const clearRgba = normalizeClearColor(clearColor);
    let transform = options.transform;
    if (!transform) {
      container.updateLocalTransform();
      transform = container.localTransform;
    }
    if (!container.visible) return;

    const tick = Container._nextRenderTick();
    prepareTree(container, this, tick);

    const state = (this.states[this.depth] ??= new RenderState());
    this.depth++;
    try {
      const { collector, builder } = state;
      collector.begin(container, tick, this.resolution);
      collector.collectRoot(container);
      builder.begin({
        textures: this.textures,
        buffers: this.buffers,
        pipelines: this.pipelines,
        canvas: {
          format: this.rhi.caps.swapchainFormat,
          pixelWidth: this.canvas.width,
          pixelHeight: this.canvas.height,
          resolution: this.resolution,
          antialias: this.antialias,
        },
        roundPixels: this.roundPixels ? 1 : 0,
        stencilTargets: this.stencilTargets,
        canvasStencilKey: this.canvasKey,
      });
      builder.renderStart(toCanvas ? 'canvas' : (options.target as RenderSurface), clear, clearRgba);
      const worldAlpha = Math.min(1, Math.max(0, container.localAlpha));
      builder.globalStart({
        worldTransformMatrix: transform.clone(),
        worldColor: container.localColor + (((worldAlpha * 255) | 0) << 24),
      });
      for (const instr of collector.instructions) builder.execute(instr);
      this.upload(state);
      const cmds = builder.commands;
      const usesCanvas = cmds.some((c) => c.t === 'pass' && c.target === 'canvas');
      // 画布零面积(挂载后、布局前的头几帧,resizeTo 的元素还是 0×0):WebGPU 取不到零尺寸的交换链纹理,
      // 这一帧本来也看不见,整帧不录(Pixi WebGL 在零面积画布上是静默画空)
      if (usesCanvas && (this.canvas.width === 0 || this.canvas.height === 0)) return;
      if (usesCanvas) this.rhi.runFrame((frame) => this.record(state, cmds, frame.commands, frame));
      else this.rhi.submit('engine2d render', (commands) => this.record(state, cmds, commands, null));
    } finally {
      this.depth--;
    }
  }

  private upload(state: RenderState): void {
    const { batcher, builder } = state;
    const vBytes = batcher.attributeSize * 4;
    if (vBytes > 0) {
      state.vertexBuffer = this.ensureBuffer(state.vertexBuffer, vBytes, RhiBufferUsage.VERTEX | RhiBufferUsage.COPY_DST, 'engine2d-batch-vertices');
      this.rhi.writeBuffer(state.vertexBuffer, new Uint8Array(batcher.attr, 0, vBytes));
    }
    const iBytes = batcher.indexSize * 4;
    if (iBytes > 0) {
      state.indexBuffer = this.ensureBuffer(state.indexBuffer, iBytes, RhiBufferUsage.INDEX | RhiBufferUsage.COPY_DST, 'engine2d-batch-indices', 'uint32');
      this.rhi.writeBuffer(state.indexBuffer, new Uint8Array(batcher.indices.buffer, 0, iBytes));
    }
    const u = builder.arena.bytes;
    if (u.byteLength > 0) {
      state.uniformBuffer = this.ensureBuffer(state.uniformBuffer, u.byteLength, RhiBufferUsage.UNIFORM | RhiBufferUsage.COPY_DST, 'engine2d-uniforms');
      this.rhi.writeBuffer(state.uniformBuffer, u);
    }
  }

  private ensureBuffer(cur: RhiBuffer | null, bytes: number, usage: number, label: string, indexFormat?: 'uint32'): RhiBuffer {
    if (cur && cur.size >= bytes) return cur;
    cur?.destroy();
    let size = 64 * 1024;
    while (size < bytes) size *= 2;
    return this.scope.createBuffer({ label, usage, size, indexFormat });
  }

  private record(state: RenderState, cmds: readonly VirtualCommand[], commands: RhiCommandList, frame: RhiFrame | null): void {
    let pass: RhiRenderPassEncoder | null = null;
    let stencilRef = 0;
    let n = 0;
    for (const cmd of cmds) {
      if (cmd.t === 'pass') {
        pass?.end();
        const target = this.passTarget(cmd, frame);
        pass = commands.beginRenderPass({
          label: `engine2d pass ${n++}`,
          target,
          colorOps: [cmd.load === 'clear' ? { load: 'clear', clearValue: cmd.clearColor } : { load: 'load' }],
          depthOp: { load: 'clear', clearValue: 1 },
          stencilOp: cmd.stencilLoad === 'clear' ? { load: 'clear', clearValue: 0 } : { load: 'load' },
        });
        pass.setViewport(cmd.viewport[0], cmd.viewport[1], cmd.viewport[2], cmd.viewport[3]);
        stencilRef = 0;
        continue;
      }
      if (!pass) throw new Error('[engine2d] 绘制命令之前没有 pass');
      pass.setPipeline(this.pipelines.get(cmd.pipeline));
      pass.setBindings(this.resolveBindings(cmd.bindings, state));
      for (const s of cmd.streams) pass.setVertexBuffer(s.name, s.buffer === 'batch' ? state.vertexBuffer! : s.buffer);
      if (cmd.pipeline.depthFormat && cmd.stencilRef !== stencilRef) {
        pass.setStencilReference(cmd.stencilRef);
        stencilRef = cmd.stencilRef;
      }
      if (cmd.index) {
        pass.setIndexBuffer(cmd.index === 'batch' ? state.indexBuffer! : cmd.index);
        pass.drawIndexed(cmd.count, cmd.instances, cmd.first);
      } else {
        pass.setIndexBuffer(null);
        pass.draw(cmd.count, cmd.instances, cmd.first);
      }
    }
    pass?.end();
  }

  private resolveBindings(b: Record<string, BindingValue>, state: RenderState): RhiBindings {
    const out: RhiBindings = {};
    for (const name in b) {
      const v = b[name];
      if ((v as ArenaRef).arena !== undefined) {
        const r = v as ArenaRef;
        out[name] = { buffer: state.uniformBuffer!, offset: r.arena, size: r.size };
      } else out[name] = v as RhiBindings[string];
    }
    return out;
  }

  private passTarget(cmd: PassCmd, frame: RhiFrame | null): RhiRenderTarget {
    if (cmd.target === 'canvas') {
      if (!frame) throw new Error('[engine2d] 画到画布必须在帧内');
      return cmd.stencil ? frame.swapchainWithDepth(STENCIL_DEPTH_FORMAT) : frame.swapchain;
    }
    const color = cmd.color!;
    let e = this.targets.get(color);
    if (!e) this.targets.set(color, (e = {}));
    if (!cmd.stencil) {
      return (e.plain ??= this.scope.createRenderTarget({ label: `${color.label} 目标`, colors: [color] }));
    }
    if (!e.stencil) {
      e.depth = this.scope.createTexture({
        label: `${color.label} 模板`,
        width: color.width,
        height: color.height,
        format: STENCIL_DEPTH_FORMAT,
        usage: RhiTextureUsage.RENDER_TARGET,
      });
      e.stencil = this.scope.createRenderTarget({ label: `${color.label} 目标+模板`, colors: [color], depth: e.depth });
    }
    return e.stencil;
  }

  private releaseTargets(texture: RhiTexture): void {
    const e = this.targets.get(texture);
    if (!e) return;
    e.plain?.destroy();
    e.stencil?.destroy();
    e.depth?.destroy();
    this.targets.delete(texture);
  }

  // ───────────────────────── 生成纹理 / 回读

  generateTexture(input: Container | GenerateTextureOptions): RenderTexture {
    const options: GenerateTextureOptions = input instanceof Container ? { target: input } : input;
    const resolution = options.resolution || this.resolution;
    const antialias = options.antialias || this.antialias;
    const container = options.target;
    let clearColor: number[] | undefined;
    if (options.clearColor) {
      const cc = options.clearColor as unknown;
      clearColor = Array.isArray(cc) && cc.length === 4 ? (cc as number[]) : Color.shared.setValue(options.clearColor).toArray<number[]>();
    } else clearColor = [0, 0, 0, 0];
    const region = options.frame ? options.frame.clone() : getLocalBounds(container, new Bounds()).rectangle.clone();
    region.width = Math.max(region.width, 1 / resolution) | 0;
    region.height = Math.max(region.height, 1 / resolution) | 0;
    const target = RenderTexture.create({
      ...(options.textureSourceOptions ?? {}),
      width: region.width,
      height: region.height,
      resolution,
      antialias,
    });
    const transform = new Matrix().translate(-region.x, -region.y);
    this.render({ container, transform, target, clearColor });
    return target;
  }

  /** 原样回读一张纹理源(预乘、按存储格式的字节),测试 / 对照用 */
  readTextureRaw(source: TextureSource): ReturnType<typeof this.rhi.readTexture> {
    return this.rhi.readTexture(this.textures.get(source));
  }

  /** 回读一张纹理源的像素(RGBA、未预乘),供 extract 用 */
  async readPixels(source: TextureSource, frame?: Rectangle): Promise<{ pixels: Uint8ClampedArray; width: number; height: number }> {
    const tex = this.textures.get(source);
    const rb = await this.rhi.readTexture(tex);
    const fx = frame ? Math.round(frame.x * source._resolution) : 0;
    const fy = frame ? Math.round(frame.y * source._resolution) : 0;
    const w = frame ? Math.round(frame.width * source._resolution) : rb.width;
    const h = frame ? Math.round(frame.height * source._resolution) : rb.height;
    const out = new Uint8ClampedArray(w * h * 4);
    const bgra = rb.format === 'bgra8unorm';
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const si = ((y + fy) * rb.width + (x + fx)) * 4;
        const di = (y * w + x) * 4;
        const a = rb.data[si + 3];
        let r = rb.data[si + (bgra ? 2 : 0)];
        const g = rb.data[si + 1];
        let b = rb.data[si + (bgra ? 0 : 2)];
        let gg = g;
        if (a > 0 && a < 255) {
          r = Math.round((r * 255) / a);
          gg = Math.round((g * 255) / a);
          b = Math.round((b * 255) / a);
        }
        out[di] = r;
        out[di + 1] = gg;
        out[di + 2] = b;
        out[di + 3] = a;
      }
    }
    return { pixels: out, width: w, height: h };
  }

  destroy(options: boolean | { removeView?: boolean } = false): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.events?.destroy();
    for (const t of [...this.targets.keys()]) this.releaseTargets(t);
    this.pipelines.destroy();
    this.buffers.destroy();
    this.textures.destroy();
    this.scope.destroy();
    if (this.ownsDevice) this.rhi.destroy();
    const removeView = typeof options === 'boolean' ? options : !!options.removeView;
    if (removeView) this.canvas.parentNode?.removeChild(this.canvas);
  }

  /** 调试:当前格式 */
  get swapchainFormat(): RhiColorFormat {
    return this.rhi.caps.swapchainFormat;
  }
}

function normalizeClearColor(c: RenderOptions['clearColor']): [number, number, number, number] {
  if (c === undefined || c === null) return [0, 0, 0, 0];
  if (Array.isArray(c) && c.length === 4) return [c[0], c[1], c[2], c[3]];
  const arr = Color.shared.setValue(c as never).toArray();
  return [arr[0], arr[1], arr[2], arr[3]];
}

function createExtract(renderer: WebGPURenderer): ExtractSystem {
  const toTexture = (target: Container | Texture | ExtractOptions): { texture: Texture; frame?: Rectangle; owned: boolean } => {
    if (target instanceof Texture) return { texture: target, owned: false };
    if (target instanceof Container) return { texture: renderer.generateTexture(target), owned: true };
    const t = target.target;
    if (t instanceof Texture) return { texture: t, frame: target.frame, owned: false };
    return {
      texture: renderer.generateTexture({ target: t, frame: target.frame, resolution: target.resolution, clearColor: target.clearColor, antialias: target.antialias }),
      owned: true,
    };
  };
  const pixels: ExtractSystem['pixels'] = async (target) => {
    const { texture, frame, owned } = toTexture(target);
    try {
      return await renderer.readPixels(texture.source, frame ?? texture.frame);
    } finally {
      if (owned) texture.destroy(true);
    }
  };
  const canvas: ExtractSystem['canvas'] = async (target) => {
    const { pixels: data, width, height } = await pixels(target);
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(width, height);
    img.data.set(data);
    ctx.putImageData(img, 0, 0);
    return c;
  };
  const base64: ExtractSystem['base64'] = async (target) => {
    const c = await canvas(target);
    const opts = !(target instanceof Container) && !(target instanceof Texture) ? target : undefined;
    const format = opts?.format ?? 'png';
    return c.toDataURL(`image/${format}`, opts?.quality);
  };
  const image: ExtractSystem['image'] = async (target) => {
    const img = new Image();
    img.src = await base64(target);
    await img.decode();
    return img;
  };
  const texture: ExtractSystem['texture'] = (target) => renderer.generateTexture(target);
  return { pixels, canvas, base64, image, texture };
}
