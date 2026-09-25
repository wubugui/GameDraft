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
import { GCSystem } from './GCSystem';
import { Pipelines, STENCIL_DEPTH_FORMAT, targetSampleCount } from './Pipelines';
import { Batcher, adjustedBlendMode } from './Batcher';
import type { BlendMode } from '../core/blendModes';
import type { Geometry } from '../shader/Geometry';
import { Collector, prepareTree } from './collect';
import { FrameBuilder, type PassCmd, type VirtualCommand } from './FrameBuilder';
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
  /**
   * 抗锯齿目标(照 Pixi 的 msaaTextures):同尺寸同格式的多重采样颜色,带不带模板的两种目标共用它(中途补模板以 load
   * 重开读到的是刚画的),pass 结束 resolve 回纹理本身
   */
  msaaColor?: RhiTexture;
  msaaDepth?: RhiTexture;
  msaaPlain?: RhiRenderTarget;
  msaaStencil?: RhiRenderTarget;
}

/** 一组要预建的管线:程序 + 它会配的几何(只看顶点布局)+ 会用到的混合;目标格式缺省画布 + 离屏缺省 */
export interface PipelinePrewarmSpec {
  program: GpuProgram;
  geometry: Geometry;
  blendModes: readonly BlendMode[];
  /** 网格的纹理(只影响非预乘纹理的混合变体);缺省 Texture.WHITE,与没给纹理的自定义网格相同 */
  texture?: Texture;
  /** 缺省:画布格式(采样数随渲染器 antialias)+ 离屏缺省 bgra8unorm(单采样) */
  colorFormats?: readonly RhiColorFormat[];
  /** 给了 colorFormats 时这些目标的采样数;缺省 1 */
  sampleCount?: number;
}

export class WebGPURenderer extends RendererBase {
  readonly extract: ExtractSystem;
  /** 空闲 GPU 资源回收(照 Pixi 的 `renderer.gc`;选项 gcActive / gcMaxUnusedTime / gcFrequency) */
  readonly gc: GCSystem;
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
  /** 退订设备恢复通知 */
  private readonly offRestored: () => void;
  /** 设备恢复的通知落在一次 render 中途(理论上不会:恢复只在帧外):等最外层这次 render 结束再丢缓存 */
  private contextChangePending = false;
  antialias: boolean;
  /** 设备是 createRenderer 替它建的:渲染器销毁时一起销毁 */
  ownsDevice = false;

  constructor(options: RendererOptions) {
    super(options);
    this.antialias = !!options.antialias;
    this.scope = this.rhi.createScope('engine2d');
    this.gc = new GCSystem(options);
    this.textures = new GpuTextures(this.rhi, this.scope, this.gc);
    this.textures.onRelease = (t) => this.releaseTargets(t);
    this.buffers = new GpuBuffers(this.rhi, this.scope, this.gc);
    this.gc.addCollector((now, maxUnused) => this.textures.collect(now, maxUnused));
    this.gc.addCollector((now, maxUnused) => this.buffers.collect(now, maxUnused));
    this.pipelines = new Pipelines(this.scope);
    this.extract = createExtract(this);
    this.offRestored = this.rhi.onRestored(() => this.contextChange());
  }

  /**
   * 设备丢失后 RHI 在同一画布上重建了设备(照 Pixi 的 runners.contextChange):旧设备上的 GPU 对象已全部作废,
   * 这里丢掉所有缓存——纹理 / 采样器、缓冲、着色器 / 管线(含预建的)、渲染目标(模板 / MSAA)、每套规划状态的
   * 合批顶点 / 索引 / uniform 缓冲;下一次 render 按需重建,CPU 源重传。只在 GPU 上的内容(RenderTexture 画过的)没了,
   * 与 WebGL 上下文丢失后 Pixi 的结果相同(重建成空纹理)。
   */
  private contextChange(): void {
    if (this.destroyed) return;
    if (this.depth > 0) {
      this.contextChangePending = true;
      return;
    }
    this.contextChangePending = false;
    for (const t of [...this.targets.keys()]) this.releaseTargets(t);
    this.pipelines.reset();
    this.buffers.reset();
    this.textures.reset();
    for (const s of this.states) {
      s.vertexBuffer = null;
      s.indexBuffer = null;
      s.uniformBuffer = null;
    }
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
    if (!container.visible || !container.activeSelf) return;

    const tick = Container._nextRenderTick();
    this.gc.prerender();
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
    } catch (e) {
      // 规划中途失败:借出的池纹理还回去(不然每失败一帧池里多一张),异常照旧抛给调用方(游戏的渲染兜错)
      state.builder.abort();
      throw e;
    } finally {
      this.depth--;
      // 最外层这一次都已提交:到点就回收空闲资源(Pixi GCSystem.postrender)
      if (this.depth === 0) {
        if (this.contextChangePending) this.contextChange();
        this.gc.postrender();
      }
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
    // 规划时分出的 uniform 片段此时才知道落在哪个缓冲:填上后绑定表直接交给 RHI
    builder.bindUniformBuffer(state.uniformBuffer);
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
      pass.setBindings(cmd.bindings as RhiBindings);
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

  private passTarget(cmd: PassCmd, frame: RhiFrame | null): RhiRenderTarget {
    if (cmd.target === 'canvas') {
      if (!frame) throw new Error('[engine2d] 画到画布必须在帧内');
      if (cmd.samples > 1) return frame.swapchainMultisampled(cmd.samples, cmd.stencil ? STENCIL_DEPTH_FORMAT : null);
      return cmd.stencil ? frame.swapchainWithDepth(STENCIL_DEPTH_FORMAT) : frame.swapchain;
    }
    const color = cmd.color!;
    let e = this.targets.get(color);
    if (!e) this.targets.set(color, (e = {}));
    if (cmd.samples > 1) return this.msaaTarget(color, e, cmd.samples, cmd.stencil);
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

  private msaaTarget(color: RhiTexture, e: TargetEntry, samples: number, stencil: boolean): RhiRenderTarget {
    e.msaaColor ??= this.scope.createTexture({
      label: `${color.label} MSAA×${samples}`,
      width: color.width,
      height: color.height,
      format: color.format,
      usage: RhiTextureUsage.RENDER_TARGET,
      sampleCount: samples,
    });
    if (!stencil) {
      return (e.msaaPlain ??= this.scope.createRenderTarget({
        label: `${color.label} 目标 MSAA×${samples}`,
        colors: [e.msaaColor],
        resolveTargets: [color],
      }));
    }
    if (!e.msaaStencil) {
      e.msaaDepth = this.scope.createTexture({
        label: `${color.label} 模板 MSAA×${samples}`,
        width: color.width,
        height: color.height,
        format: STENCIL_DEPTH_FORMAT,
        usage: RhiTextureUsage.RENDER_TARGET,
        sampleCount: samples,
      });
      e.msaaStencil = this.scope.createRenderTarget({
        label: `${color.label} 目标+模板 MSAA×${samples}`,
        colors: [e.msaaColor],
        depth: e.msaaDepth,
        resolveTargets: [color],
      });
    }
    return e.msaaStencil;
  }

  private releaseTargets(texture: RhiTexture): void {
    const e = this.targets.get(texture);
    if (!e) return;
    e.plain?.destroy();
    e.stencil?.destroy();
    e.depth?.destroy();
    e.msaaPlain?.destroy();
    e.msaaStencil?.destroy();
    e.msaaDepth?.destroy();
    e.msaaColor?.destroy();
    this.targets.delete(texture);
  }

  // ───────────────────────── 管线预建

  /**
   * 按(程序 × 几何的顶点布局 × 混合 × 目标格式)提前建好管线,真画时命中同一份缓存。
   * WebGPU 在建管线时才把 WGSL 编成后端着色器,大着色器(受光粒子这类)秒级;不预建就落在它第一次出现的那一帧。
   * 缺省目标格式 = 画布格式 + 离屏缺省格式(滤镜 / RenderTexture 的 bgra8unorm)。建不起来的只告警,不抛。
   * 每个目标建两份:不带模板的,和带深度模板、模板停用的——目标一旦用过模板遮罩就一直带模板(照 Pixi),
   * 此后遮罩外的 draw 要的是后一份;只建前一份的话,开局第一次对话(正文挂遮罩)之后画布上的预建全部落空。
   * 遮罩里 / 同帧弹出遮罩之后(active / inverse)的变体不建:粒子不画在遮罩里,且画在 UI 层之前。
   */
  prewarmPipelines(specs: readonly PipelinePrewarmSpec[]): void {
    if (this.destroyed) return;
    const swapchainFormat = this.rhi.caps.swapchainFormat;
    const defaults: Array<{ format: RhiColorFormat; samples: number }> = [
      { format: swapchainFormat, samples: targetSampleCount(this.antialias, swapchainFormat) },
    ];
    if (swapchainFormat !== 'bgra8unorm' || defaults[0].samples !== 1) defaults.push({ format: 'bgra8unorm', samples: 1 });
    for (const s of specs) {
      try {
        const layout = this.pipelines.layout(s.geometry, s.program);
        const texture = s.texture ?? Texture.WHITE;
        for (const mode of s.blendModes) {
          const blend = adjustedBlendMode(mode, texture.source);
          const targets = s.colorFormats?.map((format) => ({ format, samples: s.sampleCount ?? 1 })) ?? defaults;
          for (const t of targets) {
            for (const depthFormat of [null, STENCIL_DEPTH_FORMAT]) {
              this.pipelines.get({
                program: s.program, layout, topology: s.geometry.topology, blend,
                colorFormat: t.format, depthFormat, stencil: 'disabled', colorMask: 15, sampleCount: t.samples,
              });
            }
          }
        }
      } catch (e) {
        console.warn(`[engine2d] 预建管线失败(${s.program.name ?? `program-${s.program.uid}`}):`, e);
      }
    }
  }

  /** 纹理源在 GPU 侧的纹理:没建就按真画时同一条路建好并上传(诊断 / 取证用;源已销毁时抛) */
  gpuTextureOf(source: TextureSource): RhiTexture {
    return this.textures.get(source);
  }

  /** 已建的全部管线都编完、校验完;超时返回 false(见 Pipelines.whenAllReady) */
  pipelinesReady(timeoutMs = 10_000): Promise<boolean> {
    return this.pipelines.whenAllReady(timeoutMs);
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
    // 同 Pixi GenerateTextureSystem:画完按 level 0 生成各级(只有 autoGenerateMipmaps 的多级纹理才真的生成)
    target.source.updateMipmaps();
    return target;
  }

  /** 原样回读一张纹理源(预乘、按存储格式的字节),测试 / 对照用 */
  readTextureRaw(source: TextureSource): ReturnType<typeof this.rhi.readTexture> {
    return this.rhi.readTexture(this.textures.get(source));
  }

  /**
   * 回读一张纹理源的像素(RGBA、**预乘**,即 GPU 里存的字节),供 extract 用。
   * 照 master 的 Pixi WebGL `GlTextureSystem.getPixels`:读回的就是预乘字节,反预乘那一步在 Pixi 里是死代码(`if (false)`)。
   */
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
        out[di] = rb.data[si + (bgra ? 2 : 0)];
        out[di + 1] = rb.data[si + 1];
        out[di + 2] = rb.data[si + (bgra ? 0 : 2)];
        out[di + 3] = rb.data[si + 3];
      }
    }
    return { pixels: out, width: w, height: h };
  }

  destroy(options: boolean | { removeView?: boolean } = false): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.offRestored();
    this.events?.destroy();
    for (const t of [...this.targets.keys()]) this.releaseTargets(t);
    this.gc.destroy();
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

/** Pixi ExtractSystem 的 imageTypes / defaultImageOptions */
const EXTRACT_IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' } as const;
const EXTRACT_DEFAULT_IMAGE_OPTIONS = { format: 'png', quality: 1 } as const;

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
    // 照 Pixi ExtractSystem:格式名 → MIME(jpg → image/jpeg),缺省 png、质量 1
    const format = opts?.format ?? EXTRACT_DEFAULT_IMAGE_OPTIONS.format;
    const quality = opts?.quality ?? EXTRACT_DEFAULT_IMAGE_OPTIONS.quality;
    return c.toDataURL(EXTRACT_IMAGE_TYPES[format], quality);
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
