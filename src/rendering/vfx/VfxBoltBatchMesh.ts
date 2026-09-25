/**
 * 一批雷段 = 一张 Mesh：一段折线的一层光斑一张 quad（沿这段的方向摆正、四周外扩 3.5σ），
 * 片元里算这段线与高斯光斑的卷积（见 `vfxBoltGlsl.ts`）。
 *
 * 顶点流：aPosition(2) aSeg(4) aK(2) aColor(4) aQ(3)。段数每帧不同（镜头远近决定画到第几级细分），
 * 容量不够时按两倍重建缓冲（`reserve`，写之前调）；没写入的槽位缩成零面积。
 */
import { Buffer, BufferUsage, Geometry, Mesh, type Shader } from '../../engine2d';

const FLOATS = { pos: 8, seg: 16, k: 8, col: 16, q: 12 } as const;

export class VfxBoltBatchMesh {
  readonly mesh: Mesh<Geometry, Shader>;
  private capacity = 0;
  private pos = new Float32Array(0);
  private seg = new Float32Array(0);
  private kk = new Float32Array(0);
  private col = new Float32Array(0);
  private q = new Float32Array(0);
  private bufs: Buffer[] = [];
  private count = 0;
  private dirtyFrom = 0;

  constructor(capacity: number, shader: Shader) {
    this.mesh = new Mesh({ geometry: this.build(Math.max(16, capacity)), shader });
    this.mesh.position.set(0, 0);
  }

  private build(cap: number): Geometry {
    this.capacity = cap;
    this.pos = new Float32Array(cap * FLOATS.pos);
    this.seg = new Float32Array(cap * FLOATS.seg);
    this.kk = new Float32Array(cap * FLOATS.k);
    this.col = new Float32Array(cap * FLOATS.col);
    this.q = new Float32Array(cap * FLOATS.q);
    const idx = new Uint32Array(cap * 6);
    for (let i = 0; i < cap; i++) {
      const v = i * 4;
      idx.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6);
    }
    const dyn = (data: Float32Array) => new Buffer({ data, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
    this.bufs = [dyn(this.pos), dyn(this.seg), dyn(this.kk), dyn(this.col), dyn(this.q)];
    this.count = 0;
    this.dirtyFrom = 0;
    return new Geometry({
      attributes: {
        aPosition: { buffer: this.bufs[0], format: 'float32x2' },
        aSeg: { buffer: this.bufs[1], format: 'float32x4' },
        aK: { buffer: this.bufs[2], format: 'float32x2' },
        aColor: { buffer: this.bufs[3], format: 'float32x4' },
        aQ: { buffer: this.bufs[4], format: 'float32x3' },
      },
      indexBuffer: new Buffer({ data: idx, usage: BufferUsage.INDEX | BufferUsage.COPY_DST }),
    });
  }

  get used(): number { return this.count; }

  begin(): void {
    this.count = 0;
  }

  /** 这一帧至少要写 `n` 段：不够就按两倍重建（旧几何销毁） */
  reserve(n: number): void {
    if (n <= this.capacity) return;
    let cap = this.capacity;
    while (cap < n) cap *= 2;
    const old = this.mesh.geometry;
    this.mesh.geometry = this.build(cap);
    old.destroy(true);
  }

  /**
   * 写一段：四个角（场景 wu，按 TL TR BR BL 绕）、这一段两端、σ / 峰值、预乘前 rgba、四个角各自的 q。
   * 满了返回 false。
   */
  push(
    cx: ArrayLike<number>, cy: ArrayLike<number>,
    ax: number, ay: number, bx: number, by: number, sigma: number, amp: number,
    r: number, g: number, b: number, a: number,
    q: ArrayLike<number>,
  ): boolean {
    const i = this.count;
    if (i >= this.capacity) return false;
    this.count = i + 1;
    const o8 = i * 8, o16 = i * 16, o12 = i * 12;
    for (let k = 0; k < 4; k++) {
      this.pos[o8 + k * 2] = cx[k]; this.pos[o8 + k * 2 + 1] = cy[k];
      this.seg[o16 + k * 4] = ax; this.seg[o16 + k * 4 + 1] = ay; this.seg[o16 + k * 4 + 2] = bx; this.seg[o16 + k * 4 + 3] = by;
      this.kk[o8 + k * 2] = sigma; this.kk[o8 + k * 2 + 1] = amp;
      this.col[o16 + k * 4] = r * a; this.col[o16 + k * 4 + 1] = g * a; this.col[o16 + k * 4 + 2] = b * a; this.col[o16 + k * 4 + 3] = a;
      this.q[o12 + k * 3] = q[k * 3]; this.q[o12 + k * 3 + 1] = q[k * 3 + 1]; this.q[o12 + k * 3 + 2] = q[k * 3 + 2];
    }
    return true;
  }

  end(): void {
    const from = this.count;
    const to = Math.max(this.dirtyFrom, from);
    for (let i = from; i < to; i++) {
      this.pos.fill(0, i * 8, i * 8 + 8);
      this.kk.fill(0, i * 8, i * 8 + 8);
    }
    this.dirtyFrom = from;
    for (const b of this.bufs) b.update();
    this.mesh.visible = from > 0;
  }

  destroy(): void {
    this.mesh.removeFromParent();
    const g = this.mesh.geometry;
    this.mesh.destroy();
    g.destroy(true);
  }
}
