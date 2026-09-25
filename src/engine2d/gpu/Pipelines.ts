/**
 * 程序 → RHI 着色器;(程序, 顶点布局, 拓扑, 混合, 目标格式, 模板状态, 颜色写掩码, 采样数) → RHI 渲染管线。全部按键缓存,
 * 挂在渲染器的根作用域上,渲染器销毁时一起收。
 */
import type {
  RhiBlendState,
  RhiColorFormat,
  RhiDepthFormat,
  RhiRenderPipeline,
  RhiResourceScope,
  RhiShader,
  RhiStencilState,
  RhiVertexBufferLayout,
  RhiVertexFormat,
} from '../../rendering/rhi';
import { BLEND_STATES, type BlendMode } from '../core/blendModes';
import type { GpuProgram } from '../shader/GpuProgram';
import type { Buffer } from '../shader/Buffer';
import { ensureAttributes, vertexFormatBytes, type Geometry, type Topology } from '../shader/Geometry';

/** 模板用法(照 Pixi 的 STENCIL_MODES) */
export type StencilMode = 'disabled' | 'add' | 'remove' | 'active' | 'inverse';

export const STENCIL_DEPTH_FORMAT: RhiDepthFormat = 'depth24plus-stencil8';

const STENCIL_STATES: Record<StencilMode, RhiStencilState> = {
  disabled: { compare: 'always', passOp: 'keep', writeMask: 0, readMask: 0 },
  add: { compare: 'equal', passOp: 'increment-clamp' },
  remove: { compare: 'equal', passOp: 'decrement-clamp' },
  active: { compare: 'equal', passOp: 'keep', writeMask: 0 },
  inverse: { compare: 'not-equal', passOp: 'keep', writeMask: 0 },
};

/** WebGPU 核心里能多重采样**且**能 resolve 的颜色格式(32 位浮点 / 整数不行) */
const MSAA_RESOLVABLE = /^(r|rg|rgba)8unorm$|^rgba8unorm-srgb$|^bgra8unorm$|^(r|rg|rgba)16float$/;

/**
 * 目标的多重采样数(照 Pixi:目标纹理源 antialias ⇒ MSAA×4,画布跟渲染器的 antialias 选项)。
 * 格式不支持 resolve 的目标照常单采样画(Pixi 在这里会直接校验失败)。
 */
export function targetSampleCount(antialias: boolean, format: RhiColorFormat): number {
  return antialias && MSAA_RESOLVABLE.test(format) ? 4 : 1;
}

/** 32 位浮点 / 整数格式在 WebGPU 核心里不可混合:这类目标一律覆盖写 */
const NON_BLENDABLE = /^(r|rg|rgba)32float$|int$/;

export interface VertexLayout {
  key: string;
  buffers: RhiVertexBufferLayout[];
  /**
   * 与 buffers 一一对应的数据源:该路流上第一个属性的名字。绘制时按名现取 `geometry.attributes[name].buffer`
   * (照 Pixi GpuEncoderSystem.setGeometry 的 getBufferNamesToBind),直接换掉属性的 Buffer 下一次绘制就生效
   */
  sources: string[];
}

export interface PipelineKey {
  program: GpuProgram;
  layout: VertexLayout;
  topology: Topology;
  blend: BlendMode;
  colorFormat: RhiColorFormat;
  depthFormat: RhiDepthFormat | null;
  stencil: StencilMode;
  colorMask: number;
  /** 目标的多重采样数(1 = 不抗锯齿;抗锯齿目标是 4) */
  sampleCount: number;
}

/** 快路径键里模板用法的序号(只在带深度 / 模板时参与,同慢键) */
const STENCIL_INDEX: Record<StencilMode, number> = { disabled: 0, add: 1, remove: 2, active: 3, inverse: 4 };

/** 快路径键里串值(拓扑 / 混合 / 格式)的序号上限:超了就只走慢键 */
const STATE_ID_LIMIT = 1024;

export class Pipelines {
  private readonly shaders = new Map<number, RhiShader>();
  private readonly pipelines = new Map<string, RhiRenderPipeline>();
  /**
   * 快路径:程序对象 → 顶点布局对象 → 其余状态压成的整数 → 管线。每个 draw 都要取一次管线,
   * 命中时不拼 9 段的键串(拼串 + 串哈希是录制期的一大块开销);没命中再走按串的慢键(不同布局对象同键时共用管线)
   */
  private fast = new WeakMap<GpuProgram, WeakMap<VertexLayout, Map<number, RhiRenderPipeline>>>();
  /** 串值 → 小整数(快路径键用) */
  private readonly stateIds = new Map<string, number>();
  private readonly layouts = new WeakMap<Geometry, Map<number, { version: number; layout: VertexLayout }>>();
  /** 已补过格式 / 跨度的几何(照 Pixi getPipeline 的 `!geometry._layoutKey` 门:每个几何只补一次,之后加属性也不重补) */
  private readonly ensuredGeometries = new WeakSet<Geometry>();

  constructor(private readonly scope: RhiResourceScope) {}

  shader(program: GpuProgram): RhiShader {
    let s = this.shaders.get(program.uid);
    if (!s) {
      s = this.scope.createShader({
        label: program.name ?? `engine2d-program-${program.uid}`,
        wgsl: program.source,
        entryPoints: { vertex: program.vertexEntry, fragment: program.fragmentEntry },
      });
      this.shaders.set(program.uid, s);
    }
    return s;
  }

  get(k: PipelineKey): RhiRenderPipeline {
    let byLayout = this.fast.get(k.program);
    if (!byLayout) this.fast.set(k.program, (byLayout = new WeakMap()));
    let byState = byLayout.get(k.layout);
    if (!byState) byLayout.set(k.layout, (byState = new Map()));
    const state = this.stateKey(k);
    if (state >= 0) {
      const hit = byState.get(state);
      if (hit) return hit;
    }
    const p = this.getSlow(k);
    if (state >= 0) byState.set(state, p);
    return p;
  }

  /** 除程序与布局外的状态压成一个整数(各字段互不重叠);串值序号超限返回 -1(只走慢键) */
  private stateKey(k: PipelineKey): number {
    const topology = this.stateId(k.topology);
    const blend = this.stateId(k.blend);
    const color = this.stateId(k.colorFormat);
    const depth = k.depthFormat ? this.stateId(k.depthFormat) + 1 : 0;
    if (topology >= STATE_ID_LIMIT || blend >= STATE_ID_LIMIT || color >= STATE_ID_LIMIT || depth >= STATE_ID_LIMIT) return -1;
    if (!(k.colorMask >= 0 && k.colorMask < 16) || !(k.sampleCount >= 1 && k.sampleCount < 32)) return -1;
    const stencil = k.depthFormat ? STENCIL_INDEX[k.stencil] : 0;
    // 10 + 10 + 10 + 10 + 3 + 4 + 5 = 52 位,在双精度整数范围内
    return ((((((topology * STATE_ID_LIMIT + blend) * STATE_ID_LIMIT + color) * STATE_ID_LIMIT + depth) * 8 + stencil) * 16 + k.colorMask) * 32) + k.sampleCount;
  }

  private stateId(v: string): number {
    let id = this.stateIds.get(v);
    if (id === undefined) this.stateIds.set(v, (id = this.stateIds.size));
    return id;
  }

  private getSlow(k: PipelineKey): RhiRenderPipeline {
    const key = `${k.program.uid}|${k.layout.key}|${k.topology}|${k.blend}|${k.colorFormat}|${k.depthFormat}|${k.depthFormat ? k.stencil : '-'}|${k.colorMask}|${k.sampleCount}`;
    let p = this.pipelines.get(key);
    if (!p) {
      let blend = (BLEND_STATES[k.blend === 'inherit' ? 'normal' : k.blend] as RhiBlendState | null | undefined) ?? null;
      if (NON_BLENDABLE.test(k.colorFormat)) blend = null;
      p = this.scope.createRenderPipeline({
        label: `${k.program.name ?? `program-${k.program.uid}`} → ${k.colorFormat}${k.sampleCount > 1 ? `×${k.sampleCount}` : ''}${k.depthFormat ? `+${k.stencil}` : ''} ${k.blend}`,
        shader: this.shader(k.program),
        vertexBuffers: k.layout.buffers,
        topology: k.topology,
        colorFormats: [k.colorFormat],
        depthFormat: k.depthFormat ?? undefined,
        depth: k.depthFormat ? { write: false, compare: 'always' } : undefined,
        stencil: k.depthFormat ? STENCIL_STATES[k.stencil] : undefined,
        blend,
        colorWriteMask: k.colorMask,
        cullMode: 'none',
        sampleCount: k.sampleCount,
      });
      this.pipelines.set(key, p);
    }
    return p;
  }

  /**
   * 已建的全部管线都就绪(着色器编成后端代码、管线校验完)。超时返回 false,不抛——建坏的管线录制时只跳过它自己的 draw(RHI 计入 skippedDraws、告警一次),帧照常提交。
   * WebGPU 在**建管线**时才把 WGSL 编成后端着色器(Windows 上经 HLSL → FXC / DXC,大着色器秒级),
   * 这一步不挡 JS,但用到它的那一帧要等 GPU 进程编完;揭幕前等它,就把这段等待落在遮罩下。
   */
  async whenAllReady(timeoutMs: number): Promise<boolean> {
    const all = Promise.allSettled([...this.pipelines.values()].map((p) => p.ready)).then(() => true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
    });
    try {
      return await Promise.race([all, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 几何对某个程序的顶点布局:只取着色器顶点入口声明了的属性(luma 对着色器不用的属性会报错),
   * 同一个 Buffer 上的属性并成一路流(交错布局)。没给的格式 / 跨度先按 Pixi 的 ensureAttributes 补上
   * (格式取着色器的参数类型,跨度按同一 Buffer 上全部属性算,不只着色器用到的);同 Pixi,每个几何只在第一次配程序时补一次,
   * 不在每次绘制重跑(否则每帧都分配、缺格式的多余属性每帧告警,把 500 条告警上限耗光)。
   */
  layout(geometry: Geometry, program: GpuProgram): VertexLayout {
    let byProgram = this.layouts.get(geometry);
    if (!byProgram) this.layouts.set(geometry, (byProgram = new Map()));
    if (!this.ensuredGeometries.has(geometry)) {
      ensureAttributes(geometry, program.attributes);
      this.ensuredGeometries.add(geometry);
    }
    // 照 Pixi 的 geometry._layoutKey:布局只在属性表变了(addAttribute)才重推,命中时不枚举属性
    const version = geometry._attributesVersion;
    const cached = byProgram.get(program.uid);
    if (cached && cached.version === version) return cached.layout;
    const wanted = new Set(program.attributes.map((a) => a.name));
    const groups = new Map<Buffer, { name: string; format: string; offset: number; stride?: number; instance: boolean }[]>();
    for (const [name, attr] of Object.entries(geometry.attributes)) {
      if (!wanted.has(name)) continue;
      let list = groups.get(attr.buffer);
      if (!list) groups.set(attr.buffer, (list = []));
      list.push({ name, format: attr.format!, offset: attr.offset ?? 0, stride: attr.stride, instance: !!attr.instance });
    }
    const buffers: RhiVertexBufferLayout[] = [];
    const sources: string[] = [];
    let i = 0;
    for (const attrs of groups.values()) {
      const explicit = attrs.find((a) => a.stride)?.stride;
      const stride = explicit ?? (attrs.length === 1 ? vertexFormatBytes(attrs[0].format) : attrs.reduce((s, a) => s + vertexFormatBytes(a.format), 0));
      buffers.push({
        name: `stream${i++}`,
        stride,
        stepMode: attrs[0].instance ? 'instance' : 'vertex',
        attributes: attrs.map((a) => ({ name: a.name, format: a.format as RhiVertexFormat, offset: a.offset })),
      });
      sources.push(attrs[0].name);
    }
    const key = buffers.map((b) => `${b.stride}:${b.stepMode}:${b.attributes.map((a) => `${a.name}/${a.format}/${a.offset}`).join(',')}`).join(';');
    const layout = { key, buffers, sources };
    byProgram.set(program.uid, { version, layout });
    return layout;
  }

  destroy(): void {
    this.reset();
  }

  /**
   * 丢掉全部着色器与管线(含预建的)。设备丢失后重建时也走这里(照 Pixi GlShaderSystem 的 contextChange:程序下次用到时重编);
   * 顶点布局只是 CPU 侧的推导,保留
   */
  reset(): void {
    for (const p of this.pipelines.values()) p.destroy();
    for (const s of this.shaders.values()) s.destroy();
    this.pipelines.clear();
    this.shaders.clear();
    this.fast = new WeakMap();
  }
}
