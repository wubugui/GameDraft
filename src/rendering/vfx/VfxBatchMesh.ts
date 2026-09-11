/**
 * 一批粒子 = 一张 Mesh：动态顶点缓冲，4 顶点 / 只，容量固定、按需写入。
 *
 * 为什么不是 N 个 Sprite：实体层的排序器与裁剪器每帧遍历每个子节点，逐 Sprite 的遮挡还要逐个滤镜 RT；
 * 一批一张网格，排序器只看见一个节点，遮挡在自己的片元里做。
 *
 * 顶点流（交错在几条独立 Buffer 里，方便只更新用到的段）：
 *   aPosition(2) aUV(2) aColor(4) aQ(3) aLocal(2) aMisc(2)
 * 没写入的槽位四个顶点缩成一点（零面积，不出片元），索引缓冲恒满，不重建。
 */
import {
  Buffer,
  BufferUsage,
  Geometry,
  Mesh,
  type Shader,
} from 'pixi.js';

export interface VfxQuad {
  /** 四角场景坐标（wu）：TL TR BR BL */
  x0: number; y0: number; x1: number; y1: number; x2: number; y2: number; x3: number; y3: number;
  /** 图集 uv 矩形 */
  u0: number; v0: number; u1: number; v1: number;
  /** 镜像：u 左右翻 */
  mirror: boolean;
  /** 预乘前的 rgba（0..1） */
  r: number; g: number; b: number; a: number;
  /** 粒子中心 q */
  qx: number; qy: number; qz: number;
  /** 软边宽（q 单位） */
  softQ: number;
}

export class VfxBatchMesh {
  readonly mesh: Mesh<Geometry, Shader>;
  readonly capacity: number;
  private readonly pos: Float32Array;
  private readonly uv: Float32Array;
  private readonly col: Float32Array;
  private readonly q: Float32Array;
  private readonly misc: Float32Array;
  private readonly posBuf: Buffer;
  private readonly uvBuf: Buffer;
  private readonly colBuf: Buffer;
  private readonly qBuf: Buffer;
  private readonly miscBuf: Buffer;
  private count = 0;
  private dirtyFrom = 0;

  constructor(capacity: number, shader: Shader) {
    this.capacity = Math.max(1, capacity);
    const cap = this.capacity;
    this.pos = new Float32Array(cap * 8);
    this.uv = new Float32Array(cap * 8);
    this.col = new Float32Array(cap * 16);
    this.q = new Float32Array(cap * 12);
    this.misc = new Float32Array(cap * 8);
    const local = new Float32Array(cap * 8);
    const idx = new Uint32Array(cap * 6);
    for (let i = 0; i < cap; i++) {
      local.set([0, 0, 1, 0, 1, 1, 0, 1], i * 8);
      const v = i * 4;
      idx.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6);
    }
    const dyn = (data: Float32Array) => new Buffer({ data, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
    this.posBuf = dyn(this.pos);
    this.uvBuf = dyn(this.uv);
    this.colBuf = dyn(this.col);
    this.qBuf = dyn(this.q);
    this.miscBuf = dyn(this.misc);
    const geometry = new Geometry({
      attributes: {
        aPosition: { buffer: this.posBuf, format: 'float32x2' },
        aUV: { buffer: this.uvBuf, format: 'float32x2' },
        aColor: { buffer: this.colBuf, format: 'float32x4' },
        aQ: { buffer: this.qBuf, format: 'float32x3' },
        aLocal: { buffer: new Buffer({ data: local, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST }), format: 'float32x2' },
        aMisc: { buffer: this.miscBuf, format: 'float32x2' },
      },
      indexBuffer: new Buffer({ data: idx, usage: BufferUsage.INDEX | BufferUsage.COPY_DST }),
    });
    this.mesh = new Mesh({ geometry, shader });
    // 网格本身零位移：顶点已是场景坐标
    this.mesh.position.set(0, 0);
  }

  get used(): number { return this.count; }

  begin(): void {
    this.count = 0;
  }

  /** 写一只；满了返回 false */
  push(quad: VfxQuad): boolean {
    const i = this.count;
    if (i >= this.capacity) return false;
    this.count = i + 1;
    const p = this.pos, o8 = i * 8;
    p[o8] = quad.x0; p[o8 + 1] = quad.y0;
    p[o8 + 2] = quad.x1; p[o8 + 3] = quad.y1;
    p[o8 + 4] = quad.x2; p[o8 + 5] = quad.y2;
    p[o8 + 6] = quad.x3; p[o8 + 7] = quad.y3;
    const u = this.uv;
    const ua = quad.mirror ? quad.u1 : quad.u0, ub = quad.mirror ? quad.u0 : quad.u1;
    u[o8] = ua; u[o8 + 1] = quad.v0;
    u[o8 + 2] = ub; u[o8 + 3] = quad.v0;
    u[o8 + 4] = ub; u[o8 + 5] = quad.v1;
    u[o8 + 6] = ua; u[o8 + 7] = quad.v1;
    const c = this.col, o16 = i * 16;
    const a = quad.a, r = quad.r * a, g = quad.g * a, b = quad.b * a;
    for (let k = 0; k < 4; k++) { c[o16 + k * 4] = r; c[o16 + k * 4 + 1] = g; c[o16 + k * 4 + 2] = b; c[o16 + k * 4 + 3] = a; }
    const qq = this.q, o12 = i * 12;
    for (let k = 0; k < 4; k++) { qq[o12 + k * 3] = quad.qx; qq[o12 + k * 3 + 1] = quad.qy; qq[o12 + k * 3 + 2] = quad.qz; }
    const m = this.misc;
    for (let k = 0; k < 4; k++) { m[o8 + k * 2] = quad.softQ; m[o8 + k * 2 + 1] = 0; }
    return true;
  }

  /** 写完：没用到的槽位缩成零面积（收缩到第一个未用槽位的上一次位置即可），上传缓冲。 */
  end(): void {
    const from = this.count;
    const to = Math.max(this.dirtyFrom, from);
    if (from < this.capacity) {
      // 只清"上一帧用过、这一帧没用"的区间；其余本来就是 0
      const p = this.pos;
      for (let i = from; i < to; i++) p.fill(0, i * 8, i * 8 + 8);
      for (let i = from; i < to; i++) this.col.fill(0, i * 16, i * 16 + 16);
    }
    this.dirtyFrom = from;
    this.posBuf.update();
    this.uvBuf.update();
    this.colBuf.update();
    this.qBuf.update();
    this.miscBuf.update();
    this.mesh.visible = from > 0;
  }

  destroy(): void {
    this.mesh.removeFromParent();
    // Pixi Mesh.destroy 只把 geometry 置空、不销毁它——缓冲要自己收；shader 由所有者回收
    const g = this.mesh.geometry;
    this.mesh.destroy();
    g.destroy(true);
  }
}
