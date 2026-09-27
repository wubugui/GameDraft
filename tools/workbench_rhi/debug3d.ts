/**
 * 工作台 RHI 接入层 · 3D 调试件（命名空间 `debug3d`，页面经 `/gen/debug3d.bundle.js` 拿到）。
 *
 * 工具里的 3D 调试视图（粒子 / 地形 / 声学 / 轨迹四台的 view3d：场景深度网格贴背景、网格线、线框、标记、碰撞格、公告板）
 * 游戏里没有对应效果，所以这套画法归接入层所有：**着色器只有一份**（`debug3d.wgsl`），页面不写任何 GLSL / WGSL、
 * 不碰图形 API。走游戏同一套 RHI（只有 WebGPU，不回落）。
 *
 * 用法（页面是原生 JS）：
 *
 *   const rt = await import('/gen/debug3d.bundle.js');
 *   const g = await rt.debug3d.createView(canvas, { background: [0.075, 0.085, 0.105] });   // 拿不到 WebGPU 就抛错（带人话原因）
 *   const mesh = g.createMesh({ vertices, indices });          // 位置 xyz + uv 交错（stride 5 个 float）
 *   const tex = g.createTexture(img);                           // 背景图（不预乘，与 WebGL texImage2D 缺省相同）
 *   g.render(mvp, (d) => {                                      // mvp：页面自己的相机矩阵（列主序，GL 裁剪约定 z ∈ [-1, 1]）
 *     d.mesh(mesh, { texture: tex, tint: [dim, dim, dim, 1] });
 *     d.lines(gridXYZ, { color: [1, 1, 1, 0.09] });
 *     d.points([x, y, z], { color: [1, 0.7, 0.3, 1], size: 9, depth: 'off' });
 *   });
 *
 * 取舍（照四台 view3d 的实际用法，不多做）：
 * - **相机归页面**：拾取 / gizmo / 2D 叠加层用的是页面自己的矩阵（`common.js` / `mathx.js` 的左手 lookAt），
 *   这里原样吃同一个矩阵（只把 GL 的 z ∈ [-1, 1] 在 CPU 上换成 WebGPU 的 [0, 1]），画出来的与点出来的是同一个投影。
 *   正交（near 取负、机位背后也画）与透视都只是矩阵不同。
 * - **状态与 WebGL 版一一对应**：`depth` = 'test-write'（开深度测试 LEQUAL + 写深度，WebGL 缺省）/ 'test'（测不写，
 *   `depthMask(false)`）/ 'off'（关深度测试，也不写）；除贴图网格外一律源 alpha 混合；清屏深度 1；4× MSAA（WebGL antialias:true）。
 * - **线**：宽度 ≤ 1 走原生线段（1 设备像素，WebGL 在 Chrome 上的 lineWidth 恒为 1，与旧画面相同）；宽度 > 1 才展开成屏幕空间四边形。
 * - **点 / 标记**：屏幕空间方片，边长 = size × 像素比（GL 点精灵 gl_PointSize 的语义）。
 * - **帧内一次写完**：每帧先把全部动态顶点 / 每次 draw 的统一数据写进缓冲，再录一个 pass（RHI 不许录制期写本批已引用的缓冲）。
 * - **回读**：WebGPU 画布呈现后读不回来，`readPixels` 在同一个任务里把上一帧重画一遍再 `drawImage` 取字节（同 CanvasHost）。
 * - **设备丢失**：RHI 自动恢复后缓存的 GPU 资源全部作废；网格 / 贴图留着 CPU 源，下一帧按需重建重传。
 */
// 必须排第一：先记下页面的全局，RHI（luma / probe.gl）求值时会盖 globalThis.probe，本体里放回去（见 debug3dGlobals.ts）
import { restorePageGlobals } from './debug3dGlobals';
import {
  RhiBlend,
  RhiBufferUsage,
  RhiTextureUsage,
  createRhiDevice,
  type RhiBuffer,
  type RhiDevice,
  type RhiImageSource,
  type RhiRenderPipeline,
  type RhiResourceScope,
  type RhiShader,
  type RhiTexture,
  type RhiVertexBufferLayout,
} from '../../src/rendering/rhi';
import DEBUG3D_WGSL from './debug3d.wgsl?raw';

restorePageGlobals();

export { DEBUG3D_WGSL };

export type Vec3 = ArrayLike<number>;
export type Color = ArrayLike<number>;
/** 'test-write' = 深度测试（≤）+ 写深度；'test' = 只测不写；'off' = 不测不写 */
export type DepthMode = 'test-write' | 'test' | 'off';

export class Debug3DError extends Error {
  constructor(message: string, readonly reason: 'no-webgpu' | 'no-adapter' | 'device' | 'other') {
    super(message);
    this.name = 'Debug3DError';
  }
}

// ───────────────────────────── 纯函数（CPU，单测直接测）

/**
 * GL 裁剪约定（z ∈ [-w, w]）的列主序 4×4 → WebGPU 约定（z ∈ [0, w]）：z' = (z + w) / 2，x / y / w 不变。
 * 在 float64 里算好再落 f32（与 WebGL 在着色器里乘同一个矩阵，屏幕位置相同）。
 */
export function glToWebGpuClip(m: ArrayLike<number>): Float32Array {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) out[c * 4 + r] = m[c * 4 + r];
    out[c * 4 + 2] = 0.5 * m[c * 4 + 2] + 0.5 * m[c * 4 + 3];
  }
  return out;
}

/**
 * 世界点 → 画布 CSS 像素（左上原点）与深度（WebGPU 约定，0 近 1 远）。在相机背后（w ≤ 0）返回 null。
 * `viewProj` 是 **WebGPU 约定**的矩阵（`glToWebGpuClip` 换过的）。测试 / 取样用：页面拾取仍用它自己的同一个矩阵。
 */
export function projectToCss(viewProj: ArrayLike<number>, p: Vec3, cssWidth: number, cssHeight: number): [number, number, number] | null {
  const m = viewProj;
  const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
  const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
  const z = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14];
  const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  if (!(w > 1e-9)) return null;
  return [(x / w * 0.5 + 0.5) * cssWidth, (1 - (y / w * 0.5 + 0.5)) * cssHeight, z / w];
}

/** 折线（相邻点连起来）→ 线段表（每段两个点）；少于两个点 = 空 */
export function stripToList(pts: ArrayLike<number>): Float32Array {
  const n = Math.floor(pts.length / 3);
  if (n < 2) return new Float32Array(0);
  const out = new Float32Array((n - 1) * 6);
  for (let i = 0; i < n - 1; i++) {
    for (let k = 0; k < 6; k++) out[i * 6 + k] = pts[i * 3 + k];
  }
  return out;
}

/**
 * 射线打三角网（CPU，双面，Möller–Trumbore）：最近的 t > 0 命中。`vertices` 每顶点 `stride` 个 float、前三个是 xyz；
 * 没给索引按顶点序每三个一个三角形。自检用它找"光标下网格真正的表面"来断言深度遮挡；方向不必单位化（t 按它的长度计）。
 */
export function raycastMesh(
  vertices: ArrayLike<number>, stride: number, indices: ArrayLike<number> | null | undefined, o: Vec3, d: Vec3,
): { t: number; point: [number, number, number]; tri: number } | null {
  const n = indices ? indices.length : Math.floor(vertices.length / stride);
  let best = Infinity, bestTri = -1;
  const ox = o[0], oy = o[1], oz = o[2], dx = d[0], dy = d[1], dz = d[2];
  for (let i = 0; i + 2 < n; i += 3) {
    const a = (indices ? indices[i] : i) * stride, b = (indices ? indices[i + 1] : i + 1) * stride, c = (indices ? indices[i + 2] : i + 2) * stride;
    const ax = vertices[a], ay = vertices[a + 1], az = vertices[a + 2];
    const e1x = vertices[b] - ax, e1y = vertices[b + 1] - ay, e1z = vertices[b + 2] - az;
    const e2x = vertices[c] - ax, e2y = vertices[c + 1] - ay, e2z = vertices[c + 2] - az;
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det;
    const tx = ox - ax, ty = oy - ay, tz = oz - az;
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < 0 || u > 1) continue;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < 0 || u + v > 1) continue;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (t > 1e-6 && t < best) {
      best = t;
      bestTri = i / 3;
    }
  }
  return bestTri < 0 ? null : { t: best, point: [ox + dx * best, oy + dy * best, oz + dz * best], tri: bestTri };
}

function toF32(a: ArrayLike<number>): Float32Array {
  return a instanceof Float32Array ? a : Float32Array.from(a as ArrayLike<number>);
}

function rgba(c: Color | undefined, fallback: [number, number, number, number] = [1, 1, 1, 1]): [number, number, number, number] {
  if (!c) return fallback;
  return [Number(c[0] ?? 0), Number(c[1] ?? 0), Number(c[2] ?? 0), c.length > 3 ? Number(c[3]) : 1];
}

// ───────────────────────────── 网格 / 贴图句柄（CPU 源常驻；GPU 资源按需建，设备恢复后重建）

export interface MeshDesc {
  /** 贴图网格：位置 xyz + uv 交错，每顶点 5 个 float（服务端 `/api/mesh` 的格式原样用） */
  vertices?: Float32Array;
  /** 顶点色网格：位置 xyz，每顶点 3 个 float；颜色另给（`colors` / `setColors`，每顶点 rgba 4 个 float） */
  positions?: Float32Array;
  colors?: Float32Array;
  /** 三角形索引（可省：按顶点序每三个一个三角形） */
  indices?: Uint32Array;
  label?: string;
}

export class Debug3DMesh {
  readonly kind: 'tex' | 'vcolor';
  readonly vertexCount: number;
  readonly indexCount: number;
  /** 包围盒（世界） */
  readonly min: [number, number, number];
  readonly max: [number, number, number];
  destroyed = false;
  /** @internal */ gpu: { vb: RhiBuffer; cb: RhiBuffer | null; ib: RhiBuffer | null } | null = null;
  /** @internal */ colorsDirty = false;

  /** @internal */
  constructor(readonly label: string, readonly data: Float32Array, readonly indices: Uint32Array | null, public colors: Float32Array | null) {
    this.kind = colors ? 'vcolor' : 'tex';
    const stride = this.kind === 'tex' ? 5 : 3;
    this.vertexCount = Math.floor(data.length / stride);
    this.indexCount = indices ? indices.length : this.vertexCount;
    const mn: [number, number, number] = [Infinity, Infinity, Infinity];
    const mx: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < this.vertexCount; i++) {
      for (let k = 0; k < 3; k++) {
        const v = data[i * stride + k];
        if (v < mn[k]) mn[k] = v;
        if (v > mx[k]) mx[k] = v;
      }
    }
    this.min = mn;
    this.max = mx;
  }

  /** 顶点色网格换颜色（下一帧上传；长度必须 = 顶点数 × 4） */
  setColors(colors: Float32Array): void {
    if (this.kind !== 'vcolor') throw new Debug3DError(`网格「${this.label}」不是顶点色网格`, 'other');
    if (colors.length !== this.vertexCount * 4) {
      throw new Debug3DError(`网格「${this.label}」颜色长度 ${colors.length} ≠ 顶点数 ${this.vertexCount} × 4`, 'other');
    }
    this.colors = colors;
    this.colorsDirty = true;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.gpu) {
      this.gpu.vb.destroy();
      this.gpu.cb?.destroy();
      this.gpu.ib?.destroy();
    }
    this.gpu = null;
  }
}

export class Debug3DTexture {
  destroyed = false;
  /** @internal */ gpu: RhiTexture | null = null;

  /** @internal */
  constructor(readonly image: RhiImageSource, readonly width: number, readonly height: number, readonly label: string) {}

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.gpu?.destroy();
    this.gpu = null;
  }
}

// ───────────────────────────── 录制

export interface MeshDrawOptions {
  texture?: Debug3DTexture | null;
  /** 颜色倍率（贴图网格）；缺省白 */
  tint?: Color;
  depth?: DepthMode;
  /** 缺省：贴图网格不混合（WebGL 版不透明画），顶点色网格源 alpha 混合 */
  blend?: boolean;
  /** 顶点色网格：alpha ≤ 它的片元丢掉（缺省 0.001） */
  alphaCutoff?: number;
}

export interface LineOptions {
  color?: Color;
  /** CSS 像素；≤ 1 = 原生 1 设备像素线（与 WebGL 相同），> 1 展开成四边形 */
  width?: number;
  /** true = 相邻点连成折线（LINE_STRIP）；缺省每两个点一段（LINES） */
  strip?: boolean;
  depth?: DepthMode;
}

export interface PointOptions {
  color?: Color;
  /** 边长（CSS 像素） */
  size?: number;
  depth?: DepthMode;
}

export interface FillOptions {
  color?: Color;
  depth?: DepthMode;
}

export interface QuadOptions {
  texture?: Debug3DTexture | null;
  /** 贴图时是颜色倍率（通常 [1,1,1,alpha]），没贴图时就是填充色 */
  color?: Color;
  depth?: DepthMode;
  /** 四个角的 uv（缺省 (0,0) (1,0) (1,1) (0,1)） */
  uvs?: ArrayLike<number>;
}

/** 一帧里的画法（按调用顺序画） */
export interface Debug3DDraw {
  mesh(mesh: Debug3DMesh, options?: MeshDrawOptions): void;
  lines(points: ArrayLike<number>, options?: LineOptions): void;
  points(points: ArrayLike<number>, options?: PointOptions): void;
  /** 纯色三角形（每三个点一个） */
  triangles(points: ArrayLike<number>, options?: FillOptions): void;
  /** 四边形公告板：四个角（世界）按 0-1-2 / 0-2-3 两个三角形 */
  quad(corners: ArrayLike<Vec3>, options?: QuadOptions): void;
}

type Program = 'tex' | 'vcolor' | 'flat-tri' | 'flat-line' | 'point' | 'wide';
/** 动态流：v3 = xyz（线段 / 纯色三角形）；seg = 宽线段的两端；v5 = 公告板 xyz+uv；pt = 点实例 xyz + rgba + 边长 */
type StreamName = 'v3' | 'seg' | 'v5' | 'pt';

interface Cmd {
  program: Program;
  depth: DepthMode;
  blend: boolean;
  color: [number, number, number, number];
  /** params.x：线宽（设备像素）或 alpha 下限（点的边长在实例数据里） */
  px: number;
  texture: Debug3DTexture | null;
  /** 顶点来源：动态流 + 起点 + 个数；或常驻网格 */
  stream?: StreamName;
  first: number;
  count: number;
  mesh?: Debug3DMesh;
}

export interface RenderOptions {
  /** 矩阵的裁剪约定：'gl'（缺省，z ∈ [-1, 1]，common.js / mathx.js 的 perspective / ortho）或 'webgpu' */
  clipZ?: 'gl' | 'webgpu';
  /** 设备像素 / CSS 像素（点径、线宽按它换）；缺省 = 画布像素宽 / CSS 宽，再退 devicePixelRatio */
  pixelRatio?: number;
}

export interface Debug3DOptions {
  /** 清屏色 rgb（0..1）；缺省黑 */
  background?: Color;
  /** 4× MSAA（WebGL antialias:true）；缺省 true */
  antialias?: boolean;
  /** 没有画布时（空后端单测）目标的像素尺寸；有画布一律按画布 */
  size?: [number, number];
}

export interface Debug3DStats {
  frames: number;
  draws: number;
  vertices: number;
}

const UNIFORM_SLOT = 256;
const UNIFORM_FLOATS = 24; // mat4 + color + params
const DEPTH_FORMAT = 'depth24plus' as const;

class Stream {
  data: Float32Array;
  length = 0;
  constructor(readonly floatsPerElement: number, initial = 4096) {
    this.data = new Float32Array(initial * floatsPerElement);
  }
  reset(): void {
    this.length = 0;
  }
  /** 追加若干元素，返回第一个元素的序号 */
  push(src: ArrayLike<number>, floats = src.length): number {
    const first = this.length / this.floatsPerElement;
    if (this.length + floats > this.data.length) {
      let cap = this.data.length;
      while (cap < this.length + floats) cap *= 2;
      const next = new Float32Array(cap);
      next.set(this.data.subarray(0, this.length));
      this.data = next;
    }
    if (src instanceof Float32Array) this.data.set(src.subarray(0, floats), this.length);
    else for (let i = 0; i < floats; i++) this.data[this.length + i] = src[i];
    this.length += floats;
    return first;
  }
}

class Recorder implements Debug3DDraw {
  readonly cmds: Cmd[] = [];
  readonly v3 = new Stream(3);
  readonly seg = new Stream(6, 1024);
  readonly v5 = new Stream(5, 64);
  readonly pt = new Stream(8, 1024);
  pixelRatio = 1;
  private inst = new Float32Array(8);

  reset(pixelRatio: number): void {
    this.cmds.length = 0;
    this.v3.reset();
    this.seg.reset();
    this.v5.reset();
    this.pt.reset();
    this.pixelRatio = pixelRatio;
  }

  mesh(mesh: Debug3DMesh, o: MeshDrawOptions = {}): void {
    if (!mesh || mesh.destroyed || mesh.indexCount <= 0) return;
    const vcolor = mesh.kind === 'vcolor';
    this.cmds.push({
      program: vcolor ? 'vcolor' : 'tex',
      depth: o.depth ?? 'test-write',
      blend: o.blend ?? vcolor,
      color: rgba(o.tint),
      px: vcolor ? o.alphaCutoff ?? 0.001 : 0,
      texture: vcolor ? null : o.texture ?? null,
      first: 0,
      count: mesh.indexCount,
      mesh,
    });
  }

  lines(points: ArrayLike<number>, o: LineOptions = {}): void {
    const list = o.strip ? stripToList(points) : points;
    const n = Math.floor(list.length / 6) * 2;
    if (n < 2) return;
    const width = o.width ?? 1;
    const base = { depth: o.depth ?? 'test-write', blend: true, color: rgba(o.color), texture: null } as const;
    if (width <= 1) {
      const first = this.v3.push(list, n * 3);
      this.cmds.push({ ...base, program: 'flat-line', px: 1, stream: 'v3', first, count: n });
    } else {
      const first = this.seg.push(list, n * 3);
      this.cmds.push({ ...base, program: 'wide', px: width * this.pixelRatio, stream: 'seg', first, count: n / 2 });
    }
  }

  /**
   * 点实例进 pt 流（xyz + rgba + 边长设备像素）。紧挨着上一条也是同深度档的点 ⇒ 并进它（一串颜色各异的标记 = 一次 draw；
   * 同一次 draw 里实例按顺序画，混合 / 深度结果与逐个画相同——地形台一帧几千个顶点标记，逐个画要几十毫秒）。
   */
  points(points: ArrayLike<number>, o: PointOptions = {}): void {
    const n = Math.floor(points.length / 3);
    if (n < 1) return;
    const depth = o.depth ?? 'test-write';
    const c = rgba(o.color), size = (o.size ?? 1) * this.pixelRatio, inst = this.inst;
    let first = -1;
    for (let i = 0; i < n; i++) {
      inst[0] = points[i * 3]; inst[1] = points[i * 3 + 1]; inst[2] = points[i * 3 + 2];
      inst[3] = c[0]; inst[4] = c[1]; inst[5] = c[2]; inst[6] = c[3]; inst[7] = size;
      const at = this.pt.push(inst);
      if (first < 0) first = at;
    }
    const last = this.cmds[this.cmds.length - 1];
    if (last && last.program === 'point' && last.depth === depth && last.first + last.count === first) {
      last.count += n;
      return;
    }
    this.cmds.push({ program: 'point', depth, blend: true, color: [1, 1, 1, 1], px: 0, texture: null, stream: 'pt', first, count: n });
  }

  triangles(points: ArrayLike<number>, o: FillOptions = {}): void {
    const n = Math.floor(points.length / 9) * 3;
    if (n < 3) return;
    const first = this.v3.push(points, n * 3);
    this.cmds.push({ program: 'flat-tri', depth: o.depth ?? 'test-write', blend: true, color: rgba(o.color), px: 0, texture: null, stream: 'v3', first, count: n });
  }

  quad(corners: ArrayLike<Vec3>, o: QuadOptions = {}): void {
    if (!corners || corners.length < 4) return;
    const uv = o.uvs ?? [0, 0, 1, 0, 1, 1, 0, 1];
    const v: number[] = [];
    for (const i of [0, 1, 2, 0, 2, 3]) {
      const c = corners[i];
      v.push(c[0], c[1], c[2], uv[i * 2], uv[i * 2 + 1]);
    }
    const first = this.v5.push(v);
    this.cmds.push({
      program: 'tex', depth: o.depth ?? 'test-write', blend: true, color: rgba(o.color),
      px: 0, texture: o.texture ?? null, stream: 'v5', first, count: 6,
    });
  }
}

const LAYOUTS: Record<Program, { vs: string; fs: string; topology: 'triangle-list' | 'line-list'; buffers: RhiVertexBufferLayout[] }> = {
  tex: {
    vs: 'vs_tex', fs: 'fs_tex', topology: 'triangle-list',
    buffers: [{ name: 'v5', stride: 20, attributes: [{ name: 'aPos', format: 'float32x3', offset: 0 }, { name: 'aUV', format: 'float32x2', offset: 12 }] }],
  },
  vcolor: {
    vs: 'vs_vcolor', fs: 'fs_vcolor', topology: 'triangle-list',
    buffers: [
      { name: 'vpos', stride: 12, attributes: [{ name: 'aPos', format: 'float32x3', offset: 0 }] },
      { name: 'vcol', stride: 16, attributes: [{ name: 'aColor', format: 'float32x4', offset: 0 }] },
    ],
  },
  'flat-tri': {
    vs: 'vs_flat', fs: 'fs_color', topology: 'triangle-list',
    buffers: [{ name: 'v3', stride: 12, attributes: [{ name: 'aPos', format: 'float32x3', offset: 0 }] }],
  },
  'flat-line': {
    vs: 'vs_flat', fs: 'fs_color', topology: 'line-list',
    buffers: [{ name: 'v3', stride: 12, attributes: [{ name: 'aPos', format: 'float32x3', offset: 0 }] }],
  },
  point: {
    vs: 'vs_point', fs: 'fs_color', topology: 'triangle-list',
    buffers: [{
      name: 'pt', stride: 32, stepMode: 'instance',
      attributes: [{ name: 'aCenter', format: 'float32x3', offset: 0 }, { name: 'aColor', format: 'float32x4', offset: 12 }, { name: 'aSize', format: 'float32', offset: 28 }],
    }],
  },
  wide: {
    vs: 'vs_wide', fs: 'fs_color', topology: 'triangle-list',
    buffers: [{ name: 'seg', stride: 24, stepMode: 'instance', attributes: [{ name: 'aA', format: 'float32x3', offset: 0 }, { name: 'aB', format: 'float32x3', offset: 12 }] }],
  },
};

interface Gpu {
  shaders: Map<string, RhiShader>;
  pipes: Map<string, RhiRenderPipeline>;
  white: RhiTexture;
  uniform: RhiBuffer | null;
  uniformCap: number;
  dyn: Map<StreamName, { buf: RhiBuffer; cap: number }>;
}

/**
 * 一块画布上的 3D 调试视图：自己的 RHI 设备（WebGPU）+ 深度缓冲 + 这份着色器。
 * 页面每次重画调 `render(mvp, 录制函数)`；网格 / 贴图句柄跨帧常驻。
 */
export class Debug3DView {
  lastError = '';
  /** 测试钩子：每帧在页面的画法之后再录一段（自检往真画面里插探针点，见 `selfCheck`）；平时 null */
  debugDraw: ((d: Debug3DDraw) => void) | null = null;
  readonly stats: Debug3DStats = { frames: 0, draws: 0, vertices: 0 };
  readonly sampleCount: number;
  private readonly scope: RhiResourceScope;
  private readonly background: [number, number, number, number];
  private gpu: Gpu | null = null;
  private readonly rec = new Recorder();
  private readonly meshes = new Set<Debug3DMesh>();
  private readonly textures = new Set<Debug3DTexture>();
  private lastFrame: { viewProj: Float32Array; pixelRatio: number; replay: (d: Debug3DDraw) => void } | null = null;
  private readCanvas: HTMLCanvasElement | null = null;
  private swapW = 0;
  private swapH = 0;
  private readonly headlessSize: [number, number];
  private destroyed = false;
  private readonly offs: (() => void)[] = [];

  /** 画布在哪（回读 / 尺寸）；测试里可以没有（空后端） */
  constructor(readonly rhi: RhiDevice, readonly canvas: HTMLCanvasElement | null, options: Debug3DOptions = {}) {
    this.scope = rhi.createScope('3D 调试件');
    const bg = rgba(options.background, [0, 0, 0, 1]);
    this.background = [bg[0], bg[1], bg[2], 1];
    this.sampleCount = options.antialias === false ? 1 : 4;
    this.headlessSize = options.size ?? [0, 0];
    this.offs.push(rhi.onDiagnostic((err, severity) => {
      if (severity === 'error') this.lastError = err.message;
    }));
    // 设备恢复：此前的 GPU 资源全部作废（按已销毁处理）——丢掉缓存，下一帧从 CPU 源重建
    this.offs.push(rhi.onRestored(() => {
      this.gpu = null;
      for (const m of this.meshes) m.gpu = null;
      for (const t of this.textures) t.gpu = null;
      this.swapW = 0;
      this.swapH = 0;
    }));
  }

  // ─────────── 常驻资源

  createMesh(desc: MeshDesc): Debug3DMesh {
    const label = desc.label ?? '网格';
    let mesh: Debug3DMesh;
    if (desc.vertices) mesh = new Debug3DMesh(label, desc.vertices, desc.indices ?? null, null);
    else if (desc.positions) {
      const n = Math.floor(desc.positions.length / 3);
      mesh = new Debug3DMesh(label, desc.positions, desc.indices ?? null, desc.colors ?? new Float32Array(n * 4));
      mesh.colorsDirty = true;
    } else throw new Debug3DError(`网格「${label}」既没有 vertices 也没有 positions`, 'other');
    this.meshes.add(mesh);
    const destroy = mesh.destroy.bind(mesh);
    mesh.destroy = () => {
      this.meshes.delete(mesh);
      destroy();
    };
    return mesh;
  }

  /** 图 → 贴图（不预乘、不翻转：与 WebGL `texImage2D(RGBA, img)` 缺省相同，第 0 行 = 图的顶部 = uv v 0） */
  createTexture(image: RhiImageSource, label = '贴图'): Debug3DTexture {
    const im = image as { naturalWidth?: number; naturalHeight?: number; width?: number; height?: number; displayWidth?: number; displayHeight?: number };
    const w = im.naturalWidth || im.displayWidth || im.width || 0;
    const h = im.naturalHeight || im.displayHeight || im.height || 0;
    if (!(w > 0 && h > 0)) throw new Debug3DError(`贴图「${label}」尺寸为 0（图还没装完？）`, 'other');
    const t = new Debug3DTexture(image, w, h, label);
    this.textures.add(t);
    const destroy = t.destroy.bind(t);
    t.destroy = () => {
      this.textures.delete(t);
      destroy();
    };
    return t;
  }

  // ─────────── 一帧

  /**
   * 录一帧并提交：清屏（背景色 + 深度 1）→ 按调用顺序画。`viewProj` 列主序 4×4（缺省 GL 裁剪约定）。
   * 画布像素尺寸由页面管（`canvas.width / height`），这里按它配交换链。返回是否提交成功。
   */
  render(viewProj: ArrayLike<number>, record: (d: Debug3DDraw) => void, options: RenderOptions = {}): boolean {
    if (this.destroyed) return false;
    const vp = options.clipZ === 'webgpu' ? toF32(viewProj).slice() : glToWebGpuClip(viewProj);
    const pixelRatio = options.pixelRatio ?? this.defaultPixelRatio();
    this.lastFrame = { viewProj: vp, pixelRatio, replay: record };
    return this.submit(vp, pixelRatio, record);
  }

  /** 最近一帧的矩阵（WebGPU 约定）与像素比；没画过 = null */
  get frame(): { viewProj: Float32Array; pixelRatio: number } | null {
    return this.lastFrame ? { viewProj: this.lastFrame.viewProj, pixelRatio: this.lastFrame.pixelRatio } : null;
  }

  private defaultPixelRatio(): number {
    const c = this.canvas;
    if (c && c.clientWidth > 0 && c.width > 0) return c.width / c.clientWidth;
    return (globalThis as { devicePixelRatio?: number }).devicePixelRatio || 1;
  }

  /** 目标像素尺寸：有画布按画布；没有（空后端单测）按 `options.size` */
  private targetSize(): [number, number] {
    const c = this.canvas;
    return c ? [c.width, c.height] : this.headlessSize;
  }

  private submit(vp: Float32Array, pixelRatio: number, record: (d: Debug3DDraw) => void): boolean {
    const rec = this.rec;
    rec.reset(pixelRatio);
    record(rec);
    this.debugDraw?.(rec);
    if (this.rhi.isLost) return false;
    try {
      return this.submitRecorded(vp);
    } catch (e) {
      // 帧前的资源准备出错（设备刚丢 / 参数不合法）：这一帧作废，原因留给页面；帧内的异常 RHI 自己截住
      this.lastError = (e as Error)?.message ?? String(e);
      return false;
    }
  }

  private submitRecorded(vp: Float32Array): boolean {
    const rec = this.rec;
    const gpu = this.ensureGpu();
    const [W, H] = this.targetSize();
    if (this.canvas) {
      if (W < 1 || H < 1) return false;
      if (W !== this.swapW || H !== this.swapH) {
        this.rhi.resizeSwapchain(W, H);
        this.swapW = W;
        this.swapH = H;
      }
    }
    // —— 录制前把本帧要用的数据全部写好（录制期不许写本批已引用的缓冲）
    for (const c of rec.cmds) {
      if (c.mesh) this.ensureMesh(c.mesh);
      if (c.texture) this.ensureTexture(c.texture);
    }
    const dynUsed: [StreamName, Stream][] = [['v3', rec.v3], ['seg', rec.seg], ['v5', rec.v5], ['pt', rec.pt]];
    for (const [name, s] of dynUsed) if (s.length) this.writeDynamic(gpu, name, s);
    const uniforms = this.writeUniforms(gpu, vp, rec.cmds, W, H);
    let vertices = 0;
    const ok = this.rhi.runFrame((frame) => {
      const target = this.sampleCount > 1 ? frame.swapchainMultisampled(this.sampleCount, DEPTH_FORMAT) : frame.swapchainWithDepth(DEPTH_FORMAT);
      const pass = frame.commands.beginRenderPass({
        label: '3D 调试件',
        target,
        colorOps: [{ load: 'clear', clearValue: this.background }],
        depthOp: { load: 'clear', clearValue: 1 },
      });
      rec.cmds.forEach((c, i) => {
        pass.setPipeline(this.pipeline(gpu, c.program, c.depth, c.blend, frame.swapchain.colorFormats[0]));
        pass.setBindings({
          u: { buffer: uniforms, offset: i * UNIFORM_SLOT, size: UNIFORM_FLOATS * 4 },
          uTex: c.texture?.gpu ?? gpu.white,
        });
        if (c.mesh) {
          const g = c.mesh.gpu!;
          if (c.mesh.kind === 'tex') pass.setVertexBuffer('v5', g.vb);
          else {
            pass.setVertexBuffer('vpos', g.vb);
            pass.setVertexBuffer('vcol', g.cb!);
          }
          if (g.ib) {
            pass.setIndexBuffer(g.ib);
            pass.drawIndexed(c.count);
          } else {
            pass.setIndexBuffer(null);
            pass.draw(c.count);
          }
          vertices += c.count;
          return;
        }
        pass.setIndexBuffer(null);
        const buf = gpu.dyn.get(c.stream!)!.buf;
        pass.setVertexBuffer(c.stream!, buf);
        if (c.program === 'point' || c.program === 'wide') pass.draw(6, c.count, 0, c.first);
        else pass.draw(c.count, 1, c.first, 0);
        vertices += c.program === 'point' || c.program === 'wide' ? c.count * 6 : c.count;
      });
      pass.end();
    });
    if (ok) {
      this.stats.frames++;
      this.stats.draws = rec.cmds.length;
      this.stats.vertices = vertices;
    }
    return ok;
  }

  private ensureGpu(): Gpu {
    if (this.gpu) return this.gpu;
    const white = this.scope.createTexture({
      label: '3D 调试件 · 白图', width: 1, height: 1, format: 'rgba8unorm', usage: RhiTextureUsage.SAMPLED | RhiTextureUsage.COPY_DST,
    });
    this.rhi.writeTexture(white, new Uint8Array([255, 255, 255, 255]));
    this.gpu = { shaders: new Map(), pipes: new Map(), white, uniform: null, uniformCap: 0, dyn: new Map() };
    return this.gpu;
  }

  private shader(gpu: Gpu, vs: string, fs: string): RhiShader {
    const key = `${vs}/${fs}`;
    let s = gpu.shaders.get(key);
    if (!s) {
      s = this.scope.createShader({ label: `3D 调试件 · ${key}`, wgsl: DEBUG3D_WGSL, entryPoints: { vertex: vs, fragment: fs } });
      gpu.shaders.set(key, s);
    }
    return s;
  }

  private pipeline(gpu: Gpu, program: Program, depth: DepthMode, blend: boolean, format: import('../../src/rendering/rhi').RhiColorFormat): RhiRenderPipeline {
    const key = `${program}|${depth}|${blend ? 'a' : 'o'}|${format}`;
    let p = gpu.pipes.get(key);
    if (!p) {
      const L = LAYOUTS[program];
      p = this.scope.createRenderPipeline({
        label: `3D 调试件 · ${key}`,
        shader: this.shader(gpu, L.vs, L.fs),
        vertexBuffers: L.buffers,
        topology: L.topology,
        colorFormats: [format],
        depthFormat: DEPTH_FORMAT,
        depth: depth === 'off' ? { write: false, compare: 'always' } : { write: depth === 'test-write', compare: 'less-equal' },
        blend: blend ? RhiBlend.alpha : null,
        cullMode: 'none',
        sampleCount: this.sampleCount,
      });
      gpu.pipes.set(key, p);
    }
    return p;
  }

  private ensureMesh(mesh: Debug3DMesh): void {
    if (!mesh.gpu) {
      const vb = this.scope.createBuffer({ label: `${mesh.label} · 顶点`, usage: RhiBufferUsage.VERTEX, data: mesh.data });
      const ib = mesh.indices ? this.scope.createBuffer({ label: `${mesh.label} · 索引`, usage: RhiBufferUsage.INDEX, data: mesh.indices, indexFormat: 'uint32' }) : null;
      const cb = mesh.kind === 'vcolor'
        ? this.scope.createBuffer({ label: `${mesh.label} · 颜色`, usage: RhiBufferUsage.VERTEX | RhiBufferUsage.COPY_DST, size: mesh.vertexCount * 16 })
        : null;
      mesh.gpu = { vb, cb, ib };
      mesh.colorsDirty = mesh.kind === 'vcolor';
    }
    if (mesh.colorsDirty && mesh.gpu.cb && mesh.colors) {
      this.rhi.writeBuffer(mesh.gpu.cb, mesh.colors);
      mesh.colorsDirty = false;
    }
  }

  private ensureTexture(t: Debug3DTexture): void {
    if (t.gpu || t.destroyed) return;
    // 图像源上传（copyExternalImageToTexture）要求目标可作渲染附件
    t.gpu = this.scope.createTexture({
      label: t.label, width: t.width, height: t.height, format: 'rgba8unorm',
      usage: RhiTextureUsage.SAMPLED | RhiTextureUsage.COPY_DST | RhiTextureUsage.RENDER_TARGET,
    });
    this.rhi.uploadImage(t.gpu, t.image, { premultiplyAlpha: false });
  }

  private writeDynamic(gpu: Gpu, name: StreamName, s: Stream): void {
    const bytes = s.length * 4;
    let d = gpu.dyn.get(name);
    if (!d || d.cap < bytes) {
      d?.buf.destroy();
      let cap = Math.max(d?.cap ?? 0, 64 * 1024);
      while (cap < bytes) cap *= 2;
      d = { buf: this.scope.createBuffer({ label: `3D 调试件 · 动态顶点 ${name}`, usage: RhiBufferUsage.VERTEX | RhiBufferUsage.COPY_DST, size: cap }), cap };
      gpu.dyn.set(name, d);
    }
    this.rhi.writeBuffer(d.buf, s.data.subarray(0, s.length));
  }

  private writeUniforms(gpu: Gpu, vp: Float32Array, cmds: Cmd[], W: number, H: number): RhiBuffer {
    const bytes = Math.max(1, cmds.length) * UNIFORM_SLOT;
    if (!gpu.uniform || gpu.uniformCap < bytes) {
      gpu.uniform?.destroy();
      let cap = Math.max(gpu.uniformCap, 64 * UNIFORM_SLOT);
      while (cap < bytes) cap *= 2;
      gpu.uniform = this.scope.createBuffer({ label: '3D 调试件 · 每次 draw 的统一数据', usage: RhiBufferUsage.UNIFORM | RhiBufferUsage.COPY_DST, size: cap });
      gpu.uniformCap = cap;
    }
    const f = new Float32Array(bytes / 4);
    cmds.forEach((c, i) => {
      const o = i * (UNIFORM_SLOT / 4);
      f.set(vp, o);
      f.set(c.color, o + 16);
      f[o + 20] = c.px;
      f[o + 21] = 0;
      f[o + 22] = W;
      f[o + 23] = H;
    });
    this.rhi.writeBuffer(gpu.uniform, f);
    return gpu.uniform;
  }

  // ─────────── 回读（测试 / 自检）

  /**
   * 回读画布（设备像素，自上而下 RGBA8）：同一个任务里把上一帧重画一遍再取（WebGPU 画布呈现后读不回来）。没画过 = null。
   */
  readPixels(x = 0, y = 0, width?: number, height?: number): { width: number; height: number; data: Uint8ClampedArray } | null {
    const c = this.canvas;
    if (this.destroyed || !this.lastFrame || !c) return null;
    if (!this.submit(this.lastFrame.viewProj, this.lastFrame.pixelRatio, this.lastFrame.replay)) return null;
    const W = c.width, H = c.height;
    const w = Math.max(1, Math.min(width ?? W, W - x));
    const h = Math.max(1, Math.min(height ?? H, H - y));
    const rc = (this.readCanvas ??= document.createElement('canvas'));
    if (rc.width !== W) rc.width = W;
    if (rc.height !== H) rc.height = H;
    const ctx = rc.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(c, 0, 0);
    return { width: w, height: h, data: ctx.getImageData(x, y, w, h).data };
  }

  /** 一个 CSS 点的像素 `[r, g, b, a]`（按上一帧的像素比换到设备像素） */
  readPixel(cssX: number, cssY: number): number[] {
    const c = this.canvas;
    if (!c || !this.lastFrame) return [0, 0, 0, 0];
    const r = this.lastFrame.pixelRatio;
    const x = Math.min(c.width - 1, Math.max(0, Math.floor(cssX * r)));
    const y = Math.min(c.height - 1, Math.max(0, Math.floor(cssY * r)));
    const px = this.readPixels(x, y, 1, 1);
    return px ? [...px.data] : [0, 0, 0, 0];
  }

  /** 与清屏色差得出来的像素数（冒烟：画面非空） */
  countDrawnPixels(tolerance = 6): number {
    const px = this.readPixels();
    if (!px) return 0;
    const [r, g, b] = this.background.map((v) => Math.round(v * 255));
    let n = 0;
    for (let i = 0; i < px.data.length; i += 4) {
      if (Math.abs(px.data[i] - r) + Math.abs(px.data[i + 1] - g) + Math.abs(px.data[i + 2] - b) > tolerance) n++;
    }
    return n;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const off of this.offs) off();
    for (const m of [...this.meshes]) m.destroy();
    for (const t of [...this.textures]) t.destroy();
    this.gpu = null;
    this.lastFrame = null;
    this.scope.destroy();
  }
}

// ───────────────────────────── 页内自检（真 GPU）：四台 view3d 的自检共用这一份断言

export interface SelfCheckMarker {
  pos: Vec3;
  color: Color;
  /** 点径（CSS 像素） */
  size: number;
}

export interface SelfCheckOptions {
  /** 页面自己的投影（世界 → 画布 CSS 像素）——与拾取同一个 */
  project(p: Vec3): ArrayLike<number> | null;
  /** 页面自己的拾取射线（画布 CSS 像素 → 世界 {o, d}） */
  ray(cssX: number, cssY: number): { o: Vec3; d: Vec3 } | null;
  /** 画布 CSS 尺寸 */
  cssSize: [number, number];
  /** 场景网格（CPU 源）：深度遮挡用它找真实表面；不给 = 跳过遮挡那条 */
  mesh?: { vertices: ArrayLike<number>; stride: number; indices?: ArrayLike<number> | null } | null;
  /** 页面画的标记，**按画的先后**给（后画的盖先画的）；取一个不被后画的盖住的实心标记核颜色 */
  markers?: SelfCheckMarker[];
  /** 画面非空的下限（与清屏色不同的像素占比），缺省 0.05 */
  minDrawnRatio?: number;
}

export interface SelfCheckResult {
  name: string;
  ok: boolean;
  detail: Record<string, unknown>;
}

const PROBE = [1, 0, 1, 1] as const;

/** 探针撤掉后再画一次页面自己的那一帧（画布上留的是页面画面） */
function read0(view: Debug3DView): void {
  view.debugDraw = null;
  view.readPixels(0, 0, 1, 1);
}

/**
 * 真 GPU 上的像素断言（页面先 `draw()` 过一帧）：
 * 1. 画面非空、这帧没有设备诊断错误、draw 数 > 0；
 * 2. 标记颜色：页面画的某个实心标记，在**页面自己的投影**算出的位置上读到的就是它的颜色（投影 == 画法）；
 * 3. 深度遮挡：沿页面的拾取射线打到网格真实表面，在表面前一点插一个品红探针点（测深度）→ 看得见；表面后一点 → 被网格挡住（像素不变）。
 * 读像素走 `readPixels`（同任务重画再读），探针经 `debugDraw` 插在页面画法之后。
 */
export function selfCheck(view: Debug3DView, o: SelfCheckOptions): SelfCheckResult[] {
  const out: SelfCheckResult[] = [];
  const [W, H] = o.cssSize;
  const near = (a: ArrayLike<number>, b: ArrayLike<number>, tol: number) => [0, 1, 2].every((k) => Math.abs(a[k] - b[k]) <= tol);
  const px255 = (c: Color) => [0, 1, 2].map((k) => Math.round(Number(c[k]) * 255));
  view.debugDraw = null;
  // 1. 画面非空
  const drawn = view.countDrawnPixels();
  const total = Math.max(1, (view.canvas?.width ?? 1) * (view.canvas?.height ?? 1));
  out.push({
    name: 'frame is not empty, no device error, draws > 0',
    ok: drawn / total >= (o.minDrawnRatio ?? 0.05) && !view.lastError && view.stats.draws > 0,
    detail: { drawn, total, draws: view.stats.draws, err: view.lastError },
  });
  // 2. 标记颜色：从后往前找一个实心、在画内、不被后画的标记盖住的
  const ms = o.markers ?? [];
  let picked: { m: SelfCheckMarker; c: ArrayLike<number> } | null = null;
  for (let i = ms.length - 1; i >= 0 && !picked; i--) {
    const m = ms[i];
    if (!(m.color.length < 4 || Number(m.color[3]) >= 0.999) || !(m.size >= 5)) continue;
    const c = o.project(m.pos);
    if (!c || c[0] < 8 || c[1] < 8 || c[0] > W - 8 || c[1] > H - 8) continue;
    let covered = false;
    for (let j = i + 1; j < ms.length && !covered; j++) {
      const cj = o.project(ms[j].pos);
      if (cj && Math.abs(cj[0] - c[0]) <= (ms[j].size + m.size) / 2 + 2 && Math.abs(cj[1] - c[1]) <= (ms[j].size + m.size) / 2 + 2) covered = true;
    }
    if (!covered) picked = { m, c };
  }
  if (picked) {
    const got = view.readPixel(picked.c[0], picked.c[1]);
    const want = px255(picked.m.color);
    out.push({ name: 'a marker reads back its own colour at the page\'s projected position', ok: near(got, want, 3), detail: { at: [Math.round(picked.c[0]), Math.round(picked.c[1])], got, want } });
  } else {
    out.push({ name: 'a marker reads back its own colour at the page\'s projected position', ok: false, detail: { why: '没有可核的实心标记（都在画外 / 被盖住）', n: ms.length } });
  }
  // 3. 深度遮挡：画面中部螺旋取点，射线打网格；表面后的探针**每一处**都必须被挡住（像素与不插探针时逐字节相同），
  //    表面前的探针至少一处看得见（页面别的写深度的细线恰好横在那个像素上时，前探针被它挡住不算错，换下一处）
  if (o.mesh) {
    const tried: Record<string, unknown>[] = [];
    let behindAllHidden = true, frontSeen = 0, projOk = true;
    for (let ring = 0; ring < 6 && tried.length < 8; ring++) {
      for (let a = 0; a < (ring ? 8 : 1) && tried.length < 8; a++) {
        const sx = W * (0.5 + 0.07 * ring * Math.cos(a * Math.PI / 4)), sy = H * (0.5 + 0.07 * ring * Math.sin(a * Math.PI / 4));
        const r = o.ray(sx, sy);
        if (!r) continue;
        const h = raycastMesh(o.mesh.vertices, o.mesh.stride, o.mesh.indices, r.o, r.d);
        if (!h) continue;
        const d = r.d, len = Math.hypot(d[0], d[1], d[2]) || 1;
        const delta = Math.max(6, h.t * len * 0.01);
        const at = (s: number): [number, number, number] => [h.point[0] + d[0] / len * s, h.point[1] + d[1] / len * s, h.point[2] + d[2] / len * s];
        const cp = o.project(h.point);
        const pOk = !!cp && Math.abs(cp[0] - sx) < 0.75 && Math.abs(cp[1] - sy) < 0.75;
        const read = () => view.readPixel(sx, sy);
        const base = read();
        view.debugDraw = (dd) => dd.points(at(-delta), { color: PROBE, size: 8, depth: 'test-write' });
        const gotFront = read();
        view.debugDraw = (dd) => dd.points(at(delta), { color: PROBE, size: 8, depth: 'test-write' });
        const gotBehind = read();
        view.debugDraw = null;
        const hidden = near(gotBehind, base, 0), seen = near(gotFront, px255(PROBE), 2);
        behindAllHidden &&= hidden;
        projOk &&= pOk;
        if (seen) frontSeen++;
        tried.push({ at: [Math.round(sx), Math.round(sy)], t: Math.round(h.t * len), delta: Math.round(delta), base, gotFront, gotBehind });
      }
    }
    read0(view);
    out.push({
      name: 'depth: a probe behind the mesh surface is always hidden, one in front of it is visible',
      ok: tried.length > 0 && behindAllHidden && frontSeen > 0 && projOk,
      detail: { n: tried.length, behindAllHidden, frontSeen, projOk, first: tried[0] ?? '画面中部的射线都没打到网格' },
    });
  }
  return out;
}

/** 这个宿主拿不拿得到 WebGPU：拿得到返回 ''，否则返回人话原因（不建设备） */
export async function probeWebGpu(): Promise<string> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return '这个窗口没有 WebGPU（navigator.gpu 不存在）';
  try {
    const adapter = await gpu.requestAdapter();
    return adapter ? '' : '这个窗口拿不到 WebGPU 适配器（显卡 / 驱动 / 宿主参数不支持）';
  } catch (e) {
    return `WebGPU 适配器请求失败：${(e as Error)?.message ?? e}`;
  }
}

/**
 * 在画布上建 3D 调试视图（自己的 WebGPU 设备，画布不透明合成）。拿不到 WebGPU 抛 `Debug3DError`（带原因），不回落。
 * 画布的 CSS 尺寸与像素尺寸归页面管；建之前画布至少 1×1（零面积会配出 0×0 的深度缓冲）。
 */
export async function createView(canvas: HTMLCanvasElement, options: Debug3DOptions = {}): Promise<Debug3DView> {
  const why = await probeWebGpu();
  if (why) throw new Debug3DError(why, (navigator as { gpu?: unknown }).gpu ? 'no-adapter' : 'no-webgpu');
  if (canvas.width < 1) canvas.width = 1;
  if (canvas.height < 1) canvas.height = 1;
  let rhi: RhiDevice;
  try {
    rhi = await createRhiDevice({ canvas, alphaMode: 'opaque', useDevicePixels: false, autoResize: false });
  } catch (e) {
    throw new Debug3DError(`WebGPU 设备建不起来：${(e as Error)?.message ?? e}`, 'device');
  }
  const view = new Debug3DView(rhi, canvas, options);
  const destroy = view.destroy.bind(view);
  view.destroy = () => {
    destroy();
    rhi.destroy();
  };
  return view;
}
