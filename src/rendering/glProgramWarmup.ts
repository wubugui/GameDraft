/**
 * GL 程序预编译：让大 shader 的编译 / 链接**不落在任何一帧可见画面上**。
 *
 * ## 为什么需要
 *
 * Pixi 在第一次用某个 `GlProgram` 画东西时才编译，而且当场 `getProgramParameter(LINK_STATUS)`
 * 同步等结果。Windows 上 ANGLE → D3D11 的 FXC 编大 shader 是秒级的——2026-09-16 实测（GTX 970）：
 * 粒子受光 11.1 s（去掉对粒子不可达的 gatherRT 之后仍 2–3 s）、薄片受光 10.1 s、光柱 0.6 s。
 * 这一等就是整个主线程停住：进茶馆第一帧 11 秒、第一次点火把同样。
 * 游戏预览窗口带 `--disable-gpu-shader-disk-cache`，每次开窗口都要重编一遍。
 *
 * ## 怎么做
 *
 * 1. `request`：开局就在**游戏自己那个 GL 上下文**上用 `KHR_parallel_shader_compile` 发起编译 + 链接。
 *    驱动在后台线程编，主线程只轮询 `COMPLETION_STATUS_KHR`（实测单次 0.1 ms）；
 * 2. `whenReady`（揭幕遮罩下）：编完的交给 Pixi 自己的 `renderer.shader.bind(shader, true)`——
 *    同一份源码、同一个上下文命中 ANGLE 的程序缓存，实测受光粒子 70 ms，落在遮罩下。
 *    没有扩展时这一步直接同步编（照样在遮罩下，逐个之间让出主线程）。
 *
 * 不碰 Pixi 私有字段：哪些已经交给 Pixi 由本类自己记。上下文换了（丢失后重建，Pixi 的程序缓存随之清空）
 * 整份作废、在新上下文上重来。
 */
import { Shader, type GlProgram } from 'pixi.js';

/** 本类用到的那一小块渲染器：WebGL 渲染器天然满足（WebGPU 渲染器没有 `gl`，交不出来就什么都不做） */
export interface GlWarmupTarget {
  readonly gl: WebGL2RenderingContext | WebGLRenderingContext;
  readonly shader: { bind(shader: Shader, skipSync?: boolean): void };
}

/** 从 Pixi 渲染器取出预编译要用的那一块；不是 WebGL 渲染器 ⇒ null */
export function glWarmupTargetOf(renderer: unknown): GlWarmupTarget | null {
  const r = renderer as { gl?: unknown; shader?: { bind?: unknown } } | null | undefined;
  return r && r.gl && r.shader && typeof r.shader.bind === 'function' ? (r as unknown as GlWarmupTarget) : null;
}

/** 轮询后台编译的间隔（毫秒） */
const POLL_MS = 16;

interface KhrParallel { readonly COMPLETION_STATUS_KHR: number }

interface Entry {
  readonly program: GlProgram;
  /** compiling = 后台在编；waiting = 等交给 Pixi（没有扩展时直接同步编）；committed = Pixi 已有；failed = 交接抛了 */
  state: 'compiling' | 'waiting' | 'committed' | 'failed';
  raw: { prog: WebGLProgram; vs: WebGLShader; fs: WebGLShader } | null;
}

export class GlProgramWarmup {
  private gl: GlWarmupTarget['gl'] | null = null;
  private ext: KhrParallel | null = null;
  private readonly entries = new Map<GlProgram, Entry>();
  /** 在途的等待（定时器）：销毁时逐个撤掉并放行，不留残留、不悬挂 */
  private readonly waits = new Set<() => void>();
  private destroyed = false;

  constructor(
    private readonly getTarget: () => GlWarmupTarget | null,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  /** 登记要预编译的程序（重复登记忽略）。有并行编译扩展就当场在后台开编，不阻塞。 */
  request(programs: readonly GlProgram[]): void {
    if (this.destroyed) return;
    const t = this.syncContext();
    for (const program of programs) {
      if (this.entries.has(program)) continue;
      const e: Entry = { program, state: 'waiting', raw: null };
      this.entries.set(program, e);
      if (t && this.ext) this.startParallel(t.gl, e);
    }
  }

  /** 还没交给 Pixi 的程序数 */
  get pending(): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.state === 'compiling' || e.state === 'waiting') n++;
    return n;
  }

  /**
   * 等登记过的程序全部交给 Pixi（它们第一次被用来画东西时不再编译）。
   * 编完一个交一个，交接之间让出主线程。限时只管"等后台编完"：超时就放行（返回 false），
   * 还在后台编的留给下一次 `whenReady` 或 Pixi 第一次使用时自己编。没有并行扩展时逐个同步编完——
   * 程序就那几个，宁可停在遮罩下，也不留到可见画面上停。永不悬挂。
   */
  async whenReady(timeoutMs: number): Promise<boolean> {
    const deadline = performance.now() + Math.max(0, timeoutMs);
    for (;;) {
      if (this.destroyed) return false;
      const t = this.syncContext();
      if (!t) return this.pending === 0;
      let compiling = 0;
      let next: Entry | null = null;
      for (const e of this.entries.values()) {
        if (e.state === 'waiting') { next ??= e; continue; }
        if (e.state !== 'compiling') continue;
        if (this.isCompiled(t.gl, e)) { e.state = 'waiting'; next ??= e; } else compiling++;
      }
      if (next) {
        this.commit(t, next);
        if (this.pending === 0) return true;
        await this.wait(0);
        continue;
      }
      if (compiling === 0) return true;
      if (performance.now() >= deadline) {
        this.log(`[glWarmup] ${compiling} 个 shader 在 ${timeoutMs} ms 内没编完，先放行（第一次用到时 Pixi 自己编）`);
        return false;
      }
      await this.wait(POLL_MS);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const cancel of [...this.waits]) cancel();
    this.waits.clear();
    const gl = this.gl;
    for (const e of this.entries.values()) if (gl) this.releaseRaw(gl, e);
    this.entries.clear();
    this.gl = null;
    this.ext = null;
  }

  // ------------------------------------------------------------------ 内部

  /** 取当前上下文；换了上下文（首次 / 丢失后重建）就在新上下文上整份重来。上下文不可用 ⇒ null */
  private syncContext(): GlWarmupTarget | null {
    const t = this.getTarget();
    const gl = t?.gl ?? null;
    if (!t || !gl || (typeof gl.isContextLost === 'function' && gl.isContextLost())) return null;
    if (gl === this.gl) return t;
    this.gl = gl;
    this.ext = gl.getExtension('KHR_parallel_shader_compile') as KhrParallel | null;
    // 旧上下文上的 GL 对象随上下文一起没了（不能拿新上下文去删）；Pixi 那边的程序缓存也清了 ⇒ 全部重交
    for (const e of this.entries.values()) {
      e.raw = null;
      e.state = 'waiting';
      if (this.ext) this.startParallel(gl, e);
    }
    return t;
  }

  private startParallel(gl: GlWarmupTarget['gl'], e: Entry): void {
    const { vertex, fragment } = e.program;
    if (!vertex || !fragment) return;   // 程序已销毁（源码被置空）：留在 waiting，交接时 Pixi 自己处理
    const vs = gl.createShader(gl.VERTEX_SHADER);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    const prog = gl.createProgram();
    if (!vs || !fs || !prog) return;   // 上下文正在丢：留在 waiting，下次交接时同步编
    // 与 Pixi `generateProgram` 同一份源码（GlProgram 构造时已处理好的 vertex / fragment），缓存才对得上
    gl.shaderSource(vs, vertex);
    gl.compileShader(vs);
    gl.shaderSource(fs, fragment);
    gl.compileShader(fs);
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    e.raw = { prog, vs, fs };
    e.state = 'compiling';
  }

  private isCompiled(gl: GlWarmupTarget['gl'], e: Entry): boolean {
    if (!e.raw || !this.ext) return true;
    return gl.getProgramParameter(e.raw.prog, this.ext.COMPLETION_STATUS_KHR) === true;
  }

  /** 交给 Pixi：它按同一份源码建自己的程序（后台编完时命中缓存；没有扩展时这里同步编） */
  private commit(t: GlWarmupTarget, e: Entry): void {
    const shader = new Shader({ glProgram: e.program, resources: {} });
    try {
      t.shader.bind(shader, true);
      e.state = 'committed';
    } catch (err) {
      e.state = 'failed';
      this.log(`[glWarmup] shader 交给 Pixi 时抛了（第一次用到时再编）：${String(err)}`);
    } finally {
      shader.destroy();
      this.releaseRaw(t.gl, e);
    }
  }

  private releaseRaw(gl: GlWarmupTarget['gl'], e: Entry): void {
    const raw = e.raw;
    e.raw = null;
    if (!raw) return;
    gl.deleteProgram(raw.prog);
    gl.deleteShader(raw.vs);
    gl.deleteShader(raw.fs);
  }

  private wait(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(id);
        this.waits.delete(done);
        resolve();
      };
      const id = setTimeout(done, ms);
      this.waits.add(done);
    });
  }
}
