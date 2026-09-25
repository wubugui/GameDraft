/**
 * 渲染图(frame graph / render graph)。
 *
 * 每帧重新声明:这一帧有哪些 pass、每个 pass 读什么写什么。图据此
 *   1. 推出执行依赖,把结果没人要的 pass 剔除(剔除从"有外部效果"的 pass 倒推);
 *   2. 算出每个瞬时资源的生命期,只在用到的那段时间占用物理资源,生命期不重叠的资源共用一块(别名复用);
 *   3. 按用法推出每个资源要的用途位(采样 / 附件 / 存储 / 拷贝),导入资源缺用途位当场报错;
 *   4. 顺序执行,pass 的开始 / 结束由图负责。
 *
 * pass 回调里只能取自己声明过的资源——没声明就用,依赖推导会漏,所以直接报错。
 * 图只依赖 RHI 接口,不认识任何后端。
 */
import type {
  RhiBuffer,
  RhiCommandList,
  RhiComputePassEncoder,
  RhiRenderPassEncoder,
  RhiRenderTarget,
  RhiTexture,
} from '../RhiDevice';
import {
  RhiBufferUsage,
  RhiError,
  RhiTextureUsage,
  isDepthFormat,
  type RhiColorLoad,
  type RhiDepthLoad,
  type RhiTextureFormat,
} from '../types';
import type { RgTransientPool } from './RgTransientPool';

// ───────────────────────────── 句柄

interface RgHandleBase<K extends string> {
  readonly kind: K;
  readonly name: string;
  /** @internal */
  readonly _id: number;
  /** @internal */
  readonly _graph: RenderGraph;
}

export type RgTexture = RgHandleBase<'rg-texture'>;
export type RgBuffer = RgHandleBase<'rg-buffer'>;
/** 只能导入(画布后备缓冲这类不是纹理的目标) */
export type RgRenderTarget = RgHandleBase<'rg-render-target'>;
export type RgResource = RgTexture | RgBuffer;

export interface RgTextureDesc {
  width: number;
  height: number;
  format: RhiTextureFormat;
  /** 额外用途位;按用法推出来的(采样 / 附件 / 存储 / 拷贝)不必写 */
  usage?: number;
  mipLevels?: number;
}

export interface RgBufferDesc {
  size: number;
  /** 顶点 / 索引 / 统一 / 存储等用途要写明(缓冲的用途没法从 pass 声明里推);拷贝与 compute 写入会自动补 */
  usage: number;
  indexFormat?: 'uint16' | 'uint32';
}

// ───────────────────────────── pass 声明

export interface RgColorAttachment {
  texture: RgTexture;
  /** 缺省 clear */
  load?: 'clear' | 'load';
  clearValue?: [number, number, number, number];
}

export interface RgDepthAttachment {
  texture: RgTexture;
  load?: 'clear' | 'load';
  clearValue?: number;
}

export interface RgPassContext {
  texture(handle: RgTexture): RhiTexture;
  buffer(handle: RgBuffer): RhiBuffer;
}

export interface RgRenderPassContext extends RgPassContext {
  /** 本 pass 渲染目标的尺寸(像素) */
  readonly targetWidth: number;
  readonly targetHeight: number;
}

export interface RgRenderPassDesc {
  /** 画到图内纹理;与 `target` 二选一 */
  colors?: RgColorAttachment[];
  depth?: RgDepthAttachment;
  /** 画到导入的渲染目标(画布后备缓冲等) */
  target?: { renderTarget: RgRenderTarget; colorOps?: RhiColorLoad[]; depthOp?: RhiDepthLoad };
  /** 着色器里读的资源(纹理按采样处理;缓冲的用途以其描述为准) */
  reads?: RgResource[];
  /** 结果在图外可见:没人读也不剔除 */
  sideEffect?: boolean;
  execute(pass: RhiRenderPassEncoder, ctx: RgRenderPassContext): void;
}

export interface RgComputePassDesc {
  /** 读:纹理按采样处理 */
  reads?: RgResource[];
  /** 写:纹理按存储纹理处理,缓冲补存储用途。读改写(累加等)要同时列进 reads */
  writes?: RgResource[];
  sideEffect?: boolean;
  execute(pass: RhiComputePassEncoder, ctx: RgPassContext): void;
}

export interface RgCopyPassDesc {
  reads?: RgResource[];
  writes?: RgResource[];
  sideEffect?: boolean;
  execute(commands: RhiCommandList, ctx: RgPassContext): void;
}

// ───────────────────────────── 编译结果(调试 / 可视化用)

export interface RgCompiledPass {
  name: string;
  kind: 'render' | 'compute' | 'copy';
  culled: boolean;
  reads: string[];
  writes: string[];
}

export interface RgCompiledResource {
  name: string;
  kind: 'texture' | 'buffer' | 'render-target';
  imported: boolean;
  /** 生命期(未被任何保留的 pass 用到时为 null) */
  firstPass: string | null;
  lastPass: string | null;
  usage: number;
}

export interface RgCompiled {
  passes: RgCompiledPass[];
  resources: RgCompiledResource[];
}

// ───────────────────────────── 内部结构

type ResKind = 'texture' | 'buffer' | 'render-target';

interface ResNode {
  id: number;
  name: string;
  kind: ResKind;
  imported: RhiTexture | RhiBuffer | RhiRenderTarget | null;
  textureDesc?: Required<RgTextureDesc>;
  bufferDesc?: RgBufferDesc;
  usage: number;
  first: number;
  last: number;
  physical: RhiTexture | RhiBuffer | RhiRenderTarget | null;
}

interface Access {
  res: ResNode;
  read: boolean;
  write: boolean;
  usage: number;
  /** 作附件(不能在同一 pass 里再被采样) */
  attachment: boolean;
}

interface PassNode {
  index: number;
  name: string;
  kind: 'render' | 'compute' | 'copy';
  accesses: Access[];
  sideEffect: boolean;
  deps: Set<number>;
  needed: boolean;
  render?: RgRenderPassDesc;
  compute?: RgComputePassDesc;
  copy?: RgCopyPassDesc;
}

export interface RenderGraphOptions {
  label: string;
  pool: RgTransientPool;
}

export class RenderGraph {
  readonly label: string;
  private readonly pool: RgTransientPool;
  private readonly resources: ResNode[] = [];
  private readonly passes: PassNode[] = [];
  private readonly passNames = new Set<string>();
  private compiled: RgCompiled | null = null;
  private executed = false;

  constructor(options: RenderGraphOptions) {
    this.label = options.label;
    this.pool = options.pool;
  }

  // ── 资源声明

  createTexture(name: string, desc: RgTextureDesc): RgTexture {
    this.assertOpen(`createTexture「${name}」`);
    if (!(desc.width > 0 && desc.height > 0)) {
      throw new RhiError('invalid-usage', `图纹理「${name}」尺寸非法:${desc.width}×${desc.height}`);
    }
    const node = this.addResource(name, 'texture', null);
    node.textureDesc = { width: desc.width, height: desc.height, format: desc.format, usage: desc.usage ?? 0, mipLevels: desc.mipLevels ?? 1 };
    node.usage = desc.usage ?? 0;
    return this.handle('rg-texture', node);
  }

  createBuffer(name: string, desc: RgBufferDesc): RgBuffer {
    this.assertOpen(`createBuffer「${name}」`);
    if (!(desc.size > 0)) throw new RhiError('invalid-usage', `图缓冲「${name}」大小必须 > 0`);
    const node = this.addResource(name, 'buffer', null);
    node.bufferDesc = { ...desc };
    node.usage = desc.usage;
    return this.handle('rg-buffer', node);
  }

  /** 导入图外的纹理(常驻贴图、上一帧的历史缓冲、要回读的结果等)。写导入资源的 pass 不会被剔除。 */
  importTexture(name: string, texture: RhiTexture): RgTexture {
    this.assertOpen(`importTexture「${name}」`);
    return this.handle('rg-texture', this.addResource(name, 'texture', texture));
  }

  importBuffer(name: string, buffer: RhiBuffer): RgBuffer {
    this.assertOpen(`importBuffer「${name}」`);
    return this.handle('rg-buffer', this.addResource(name, 'buffer', buffer));
  }

  /** 导入渲染目标(典型是画布后备缓冲 `frame.swapchain`) */
  importRenderTarget(name: string, target: RhiRenderTarget): RgRenderTarget {
    this.assertOpen(`importRenderTarget「${name}」`);
    return this.handle('rg-render-target', this.addResource(name, 'render-target', target));
  }

  // ── pass 声明

  addRenderPass(name: string, desc: RgRenderPassDesc): void {
    this.assertOpen(`addRenderPass「${name}」`);
    const hasColors = (desc.colors?.length ?? 0) > 0 || desc.depth != null;
    if (hasColors === (desc.target != null)) {
      throw new RhiError('invalid-usage', `render pass「${name}」:colors/depth 与 target 必须二选一`);
    }
    const accesses: Access[] = [];
    if (desc.target) {
      const rt = this.node(desc.target.renderTarget, name, 'render-target');
      const loads = (desc.target.colorOps ?? []).some((op) => op.load === 'load') || desc.target.depthOp?.load === 'load';
      accesses.push({ res: rt, read: loads, write: true, usage: 0, attachment: true });
    }
    for (const c of desc.colors ?? []) {
      const n = this.node(c.texture, name, 'texture');
      accesses.push({ res: n, read: c.load === 'load', write: true, usage: RhiTextureUsage.RENDER_TARGET, attachment: true });
    }
    if (desc.depth) {
      const n = this.node(desc.depth.texture, name, 'texture');
      accesses.push({ res: n, read: desc.depth.load === 'load', write: true, usage: RhiTextureUsage.RENDER_TARGET, attachment: true });
    }
    for (const r of desc.reads ?? []) {
      const n = this.node(r, name);
      accesses.push({ res: n, read: true, write: false, usage: n.kind === 'texture' ? RhiTextureUsage.SAMPLED : 0, attachment: false });
    }
    this.addPass(name, 'render', accesses, desc.sideEffect ?? false).render = desc;
  }

  addComputePass(name: string, desc: RgComputePassDesc): void {
    this.assertOpen(`addComputePass「${name}」`);
    const accesses: Access[] = [];
    for (const r of desc.reads ?? []) {
      const n = this.node(r, name);
      accesses.push({ res: n, read: true, write: false, usage: n.kind === 'texture' ? RhiTextureUsage.SAMPLED : 0, attachment: false });
    }
    for (const w of desc.writes ?? []) {
      const n = this.node(w, name);
      accesses.push({
        res: n, read: false, write: true,
        usage: n.kind === 'texture' ? RhiTextureUsage.STORAGE : RhiBufferUsage.STORAGE,
        attachment: false,
      });
    }
    this.addPass(name, 'compute', accesses, desc.sideEffect ?? false).compute = desc;
  }

  addCopyPass(name: string, desc: RgCopyPassDesc): void {
    this.assertOpen(`addCopyPass「${name}」`);
    const accesses: Access[] = [];
    for (const r of desc.reads ?? []) {
      const n = this.node(r, name);
      accesses.push({ res: n, read: true, write: false, usage: n.kind === 'texture' ? RhiTextureUsage.COPY_SRC : RhiBufferUsage.COPY_SRC, attachment: false });
    }
    for (const w of desc.writes ?? []) {
      const n = this.node(w, name);
      accesses.push({ res: n, read: false, write: true, usage: n.kind === 'texture' ? RhiTextureUsage.COPY_DST : RhiBufferUsage.COPY_DST, attachment: false });
    }
    this.addPass(name, 'copy', accesses, desc.sideEffect ?? false).copy = desc;
  }

  // ── 编译

  compile(): RgCompiled {
    if (this.compiled) return this.compiled;
    this.resolveDependencies();
    this.cull();
    this.computeLifetimesAndUsage();
    this.validate();
    this.compiled = {
      passes: this.passes.map((p) => ({
        name: p.name,
        kind: p.kind,
        culled: !p.needed,
        reads: p.accesses.filter((a) => a.read).map((a) => a.res.name),
        writes: p.accesses.filter((a) => a.write).map((a) => a.res.name),
      })),
      resources: this.resources.map((r) => ({
        name: r.name,
        kind: r.kind,
        imported: r.imported != null,
        firstPass: r.first >= 0 ? this.passes[r.first].name : null,
        lastPass: r.last >= 0 ? this.passes[r.last].name : null,
        usage: r.usage,
      })),
    };
    return this.compiled;
  }

  // ── 执行

  /** 编译(若还没)并把保留下来的 pass 依次录进命令表。一张图只能执行一次。 */
  execute(commands: RhiCommandList): void {
    this.compile();
    if (this.executed) throw new RhiError('invalid-usage', `渲染图「${this.label}」已经执行过;每帧新建一张图`);
    this.executed = true;
    if (this.pool.destroyed) throw new RhiError('destroyed-resource', `渲染图「${this.label}」的瞬时资源池已销毁`);
    this.pool._beginTick();
    try {
      for (const p of this.passes) {
        if (!p.needed) continue;
        for (const r of this.resources) if (r.first === p.index && !r.imported) this.acquire(r, p.name);
        commands.pushDebugGroup(p.name);
        this.runPass(p, commands);
        commands.popDebugGroup();
        for (const r of this.resources) if (r.last === p.index && !r.imported) this.release(r);
      }
    } finally {
      for (const r of this.resources) if (!r.imported) r.physical = null;
      this.pool._endTick();
    }
  }

  // ── 内部:声明

  private addResource(name: string, kind: ResKind, imported: ResNode['imported']): ResNode {
    if (imported && (imported as { destroyed: boolean }).destroyed) {
      throw new RhiError('destroyed-resource', `渲染图「${this.label}」导入的「${name}」已销毁`);
    }
    const node: ResNode = {
      id: this.resources.length, name, kind, imported,
      usage: 0, first: -1, last: -1, physical: imported,
    };
    this.resources.push(node);
    return node;
  }

  private handle<K extends 'rg-texture' | 'rg-buffer' | 'rg-render-target'>(kind: K, node: ResNode): RgHandleBase<K> {
    return Object.freeze({ kind, name: node.name, _id: node.id, _graph: this });
  }

  private node(h: RgHandleBase<string>, passName: string, expect?: ResKind): ResNode {
    if (h._graph !== this) throw new RhiError('invalid-usage', `pass「${passName}」用了别的渲染图的资源「${h.name}」`);
    const n = this.resources[h._id];
    if (expect && n.kind !== expect) throw new RhiError('invalid-usage', `pass「${passName}」:「${h.name}」是 ${n.kind},这里要 ${expect}`);
    if (!expect && n.kind === 'render-target') {
      throw new RhiError('invalid-usage', `pass「${passName}」:导入的渲染目标「${h.name}」只能作 render pass 的 target`);
    }
    return n;
  }

  private addPass(name: string, kind: PassNode['kind'], accesses: Access[], sideEffect: boolean): PassNode {
    if (this.passNames.has(name)) throw new RhiError('invalid-usage', `渲染图「${this.label}」里 pass 重名:「${name}」`);
    const seen = new Map<number, Access>();
    for (const a of accesses) {
      const prev = seen.get(a.res.id);
      if (prev && (prev.attachment || a.attachment)) {
        throw new RhiError('invalid-usage', `pass「${name}」里「${a.res.name}」既当附件又被读写(反馈回路)`);
      }
      seen.set(a.res.id, a);
    }
    this.passNames.add(name);
    const p: PassNode = { index: this.passes.length, name, kind, accesses, sideEffect, deps: new Set(), needed: false };
    this.passes.push(p);
    return p;
  }

  private assertOpen(what: string): void {
    if (this.compiled) throw new RhiError('invalid-usage', `${what}:渲染图「${this.label}」已编译,不能再改`);
  }

  // ── 内部:编译

  private resolveDependencies(): void {
    const lastWriter = new Map<number, number>();
    for (const p of this.passes) {
      for (const a of p.accesses) {
        if (!a.read) continue;
        const w = lastWriter.get(a.res.id);
        if (w != null) p.deps.add(w);
        else if (!a.res.imported) {
          throw new RhiError('invalid-usage', `pass「${p.name}」读了「${a.res.name}」,但此前没有任何 pass 写过它`);
        }
      }
      for (const a of p.accesses) if (a.write) lastWriter.set(a.res.id, p.index);
    }
  }

  private cull(): void {
    const stack: number[] = [];
    for (const p of this.passes) {
      if (p.sideEffect || p.accesses.some((a) => a.write && a.res.imported)) {
        p.needed = true;
        stack.push(p.index);
      }
    }
    while (stack.length) {
      const p = this.passes[stack.pop()!];
      for (const d of p.deps) {
        if (!this.passes[d].needed) {
          this.passes[d].needed = true;
          stack.push(d);
        }
      }
    }
  }

  private computeLifetimesAndUsage(): void {
    for (const p of this.passes) {
      if (!p.needed) continue;
      for (const a of p.accesses) {
        const r = a.res;
        if (r.first < 0) r.first = p.index;
        r.last = p.index;
        r.usage |= a.usage;
      }
    }
  }

  private validate(): void {
    for (const r of this.resources) {
      if (r.first < 0) continue;
      if (r.kind === 'texture' && r.imported) {
        this.requireImportedUsage(r, (r.imported as RhiTexture).usage);
      } else if (r.kind === 'buffer' && r.imported) {
        this.requireImportedUsage(r, (r.imported as RhiBuffer).usage);
      }
    }
    for (const p of this.passes) {
      if (!p.needed || p.kind !== 'render') continue;
      const desc = p.render!;
      if (desc.target) continue;
      const atts = [...(desc.colors ?? []).map((c) => ({ c, depth: false })), ...(desc.depth ? [{ c: desc.depth, depth: true }] : [])];
      let size: [number, number] | null = null;
      for (const { c, depth } of atts) {
        const r = this.resources[c.texture._id];
        const [w, h, format] = this.textureShape(r);
        if (depth !== isDepthFormat(format)) {
          throw new RhiError('invalid-usage', `render pass「${p.name}」:「${r.name}」(${format})${depth ? '不是深度格式,不能当深度附件' : '是深度格式,不能当颜色附件'}`);
        }
        if (size && (size[0] !== w || size[1] !== h)) {
          throw new RhiError('invalid-usage', `render pass「${p.name}」附件尺寸不一致:「${r.name}」${w}×${h} ≠ ${size[0]}×${size[1]}`);
        }
        size = [w, h];
      }
    }
  }

  private requireImportedUsage(r: ResNode, has: number): void {
    const missing = r.usage & ~has;
    if (missing) {
      const names = r.kind === 'texture' ? RhiTextureUsage : RhiBufferUsage;
      const list = Object.entries(names).filter(([, bit]) => missing & bit).map(([k]) => k).join(' | ');
      throw new RhiError('invalid-usage', `导入的「${r.name}」缺用途位 ${list}(图里的用法需要)`);
    }
  }

  private textureShape(r: ResNode): [number, number, RhiTextureFormat] {
    if (r.imported) {
      const t = r.imported as RhiTexture;
      return [t.width, t.height, t.format];
    }
    const d = r.textureDesc!;
    return [d.width, d.height, d.format];
  }

  // ── 内部:执行

  private acquire(r: ResNode, passName: string): void {
    if (r.kind === 'texture') {
      const d = r.textureDesc!;
      r.physical = this.pool._acquireTexture({ width: d.width, height: d.height, format: d.format, usage: r.usage, mipLevels: d.mipLevels }, `${this.label}/${passName}/${r.name}`);
    } else if (r.kind === 'buffer') {
      const d = r.bufferDesc!;
      r.physical = this.pool._acquireBuffer({ size: d.size, usage: r.usage, indexFormat: d.indexFormat }, `${this.label}/${passName}/${r.name}`);
    }
  }

  private release(r: ResNode): void {
    if (!r.physical) return;
    if (r.kind === 'texture') this.pool._releaseTexture(r.physical as RhiTexture);
    else if (r.kind === 'buffer') this.pool._releaseBuffer(r.physical as RhiBuffer);
  }

  private context(p: PassNode): RgPassContext {
    const declared = new Map<number, Access>();
    for (const a of p.accesses) if (!a.attachment) declared.set(a.res.id, a);
    const get = (h: RgHandleBase<string>, kind: ResKind): unknown => {
      if (h._graph !== this) throw new RhiError('invalid-usage', `pass「${p.name}」取了别的渲染图的资源「${h.name}」`);
      const a = declared.get(h._id);
      if (!a || a.res.kind !== kind) {
        throw new RhiError('invalid-usage', `pass「${p.name}」没声明就用了「${h.name}」(在 reads / writes 里声明;附件不能在同一 pass 里取用)`);
      }
      return a.res.physical;
    };
    return {
      texture: (h) => get(h, 'texture') as RhiTexture,
      buffer: (h) => get(h, 'buffer') as RhiBuffer,
    };
  }

  private runPass(p: PassNode, commands: RhiCommandList): void {
    const ctx = this.context(p);
    if (p.kind === 'compute') {
      const pass = commands.beginComputePass(p.name);
      p.compute!.execute(pass, ctx);
      pass.end();
      return;
    }
    if (p.kind === 'copy') {
      p.copy!.execute(commands, ctx);
      return;
    }
    const desc = p.render!;
    let target: RhiRenderTarget;
    let colorOps: RhiColorLoad[];
    let depthOp: RhiDepthLoad | undefined;
    if (desc.target) {
      target = this.resources[desc.target.renderTarget._id].physical as RhiRenderTarget;
      colorOps = desc.target.colorOps ?? [];
      depthOp = desc.target.depthOp;
    } else {
      const colors = (desc.colors ?? []).map((c) => this.resources[c.texture._id].physical as RhiTexture);
      const depth = desc.depth ? (this.resources[desc.depth.texture._id].physical as RhiTexture) : null;
      target = this.pool._renderTarget(colors, depth, `${this.label}/${p.name}`);
      colorOps = (desc.colors ?? []).map((c) => (c.load === 'load' ? { load: 'load' } : { load: 'clear', clearValue: c.clearValue }));
      depthOp = desc.depth ? (desc.depth.load === 'load' ? { load: 'load' } : { load: 'clear', clearValue: desc.depth.clearValue }) : undefined;
    }
    const pass = commands.beginRenderPass({ label: p.name, target, colorOps, depthOp });
    desc.execute(pass, { ...ctx, targetWidth: target.width, targetHeight: target.height });
    pass.end();
  }
}
