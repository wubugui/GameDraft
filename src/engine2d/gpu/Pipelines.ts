/**
 * 程序 → RHI 着色器;(程序, 顶点布局, 拓扑, 混合, 目标格式, 模板状态, 颜色写掩码) → RHI 渲染管线。全部按键缓存,
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
import { vertexFormatBytes, type Geometry, type Topology } from '../shader/Geometry';

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

/** 32 位浮点 / 整数格式在 WebGPU 核心里不可混合:这类目标一律覆盖写 */
const NON_BLENDABLE = /^(r|rg|rgba)32float$|int$/;

export interface VertexLayout {
  key: string;
  buffers: RhiVertexBufferLayout[];
  /** 与 buffers 一一对应的数据源 */
  sources: Buffer[];
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
}

export class Pipelines {
  private readonly shaders = new Map<number, RhiShader>();
  private readonly pipelines = new Map<string, RhiRenderPipeline>();
  private readonly layouts = new WeakMap<Geometry, Map<number, { version: string; layout: VertexLayout }>>();

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
    const key = `${k.program.uid}|${k.layout.key}|${k.topology}|${k.blend}|${k.colorFormat}|${k.depthFormat}|${k.depthFormat ? k.stencil : '-'}|${k.colorMask}`;
    let p = this.pipelines.get(key);
    if (!p) {
      let blend = (BLEND_STATES[k.blend === 'inherit' ? 'normal' : k.blend] as RhiBlendState | null | undefined) ?? null;
      if (NON_BLENDABLE.test(k.colorFormat)) blend = null;
      p = this.scope.createRenderPipeline({
        label: `${k.program.name ?? `program-${k.program.uid}`} → ${k.colorFormat}${k.depthFormat ? `+${k.stencil}` : ''} ${k.blend}`,
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
      });
      this.pipelines.set(key, p);
    }
    return p;
  }

  /**
   * 几何对某个程序的顶点布局:只取着色器顶点入口声明了的属性(luma 对着色器不用的属性会报错),
   * 同一个 Buffer 上的属性并成一路流(交错布局)。
   */
  layout(geometry: Geometry, program: GpuProgram): VertexLayout {
    let byProgram = this.layouts.get(geometry);
    if (!byProgram) this.layouts.set(geometry, (byProgram = new Map()));
    const version = geometryVersion(geometry);
    const cached = byProgram.get(program.uid);
    if (cached && cached.version === version) return cached.layout;
    const wanted = new Set(program.attributes.map((a) => a.name));
    const groups = new Map<Buffer, { name: string; format: string; offset: number; stride?: number; instance: boolean }[]>();
    for (const [name, attr] of Object.entries(geometry.attributes)) {
      if (!wanted.has(name)) continue;
      let list = groups.get(attr.buffer);
      if (!list) groups.set(attr.buffer, (list = []));
      list.push({ name, format: attr.format, offset: attr.offset ?? 0, stride: attr.stride, instance: !!attr.instance });
    }
    const buffers: RhiVertexBufferLayout[] = [];
    const sources: Buffer[] = [];
    let i = 0;
    for (const [buffer, attrs] of groups) {
      const explicit = attrs.find((a) => a.stride)?.stride;
      const stride = explicit ?? (attrs.length === 1 ? vertexFormatBytes(attrs[0].format) : attrs.reduce((s, a) => s + vertexFormatBytes(a.format), 0));
      buffers.push({
        name: `stream${i++}`,
        stride,
        stepMode: attrs[0].instance ? 'instance' : 'vertex',
        attributes: attrs.map((a) => ({ name: a.name, format: a.format as RhiVertexFormat, offset: a.offset })),
      });
      sources.push(buffer);
    }
    const key = buffers.map((b) => `${b.stride}:${b.stepMode}:${b.attributes.map((a) => `${a.name}/${a.format}/${a.offset}`).join(',')}`).join(';');
    const layout = { key, buffers, sources };
    byProgram.set(program.uid, { version, layout });
    return layout;
  }

  destroy(): void {
    for (const p of this.pipelines.values()) p.destroy();
    for (const s of this.shaders.values()) s.destroy();
    this.pipelines.clear();
    this.shaders.clear();
  }
}

function geometryVersion(g: Geometry): string {
  let v = '';
  for (const [name, a] of Object.entries(g.attributes)) v += `${name}:${a.buffer.uid}:${a.format}:${a.offset}:${a.stride}:${a.instance ? 1 : 0};`;
  return v;
}
