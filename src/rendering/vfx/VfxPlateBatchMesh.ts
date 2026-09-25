/**
 * 一批薄片粒子（纸钱 / 落叶）= 一张 Mesh：每张片是沿宽度切 `segs` 段的一条带（`2·(segs+1)` 顶点），
 * 顶点逐个投影（片能弯、能侧着、能翻过去，四个角不在一个平面上）。
 *
 * 顶点流与 `VfxBatchMesh` 同名同格式（无光 shader 原样能用），另多一条 `aNrm`（世界法线，受光 shader 用）：
 *   aPosition(2) aUV(2) aColor(4) aQ(3) aLocal(2) aMisc(2) aNrm(3)
 * ⚠ 反过来不行：受光的薄片 shader 声明了 `aNrm`，拿去配 `VfxBatchMesh` 会在绑定时抛异常——
 *   渲染路径上抛一次 = 整局卡死（pixi-v8-traps），所以两种网格各配各的 program。
 *
 * 顶点排布：第 k 列上 `2k` = 上沿、`2k+1` = 下沿；没写入的槽位缩成零面积，索引缓冲恒满不重建。
 */
import { Buffer, BufferUsage, Geometry, Mesh, type Shader } from '../../engine2d';

/** 一张片的逐顶点数据（由渲染器按 `2·(segs+1)` 个顶点填满后 push） */
export interface VfxPlateStrip {
  /** 场景坐标（wu）xy 交错 */
  pos: Float32Array;
  uv: Float32Array;
  /** 预乘前 rgba（0..1）交错 */
  col: Float32Array;
  /** 每顶点伪世界 q */
  q: Float32Array;
  /** 每顶点世界法线（已翻到朝向相机那一面） */
  nrm: Float32Array;
  /**
   * 每顶点 `aMisc`：x = 软边宽（q，薄片恒 0）；y = **逐顶点自发光份额**（0..1，燃着的纸那道火线；
   * 受光程序取 `max(uEmissive, vMisc.y)`，不燃烧的纸恒 0 ⇒ 与改动前逐位相同）。
   */
  misc: Float32Array;
}

export function createPlateStrip(segs: number): VfxPlateStrip {
  const n = 2 * (segs + 1);
  return {
    pos: new Float32Array(n * 2), uv: new Float32Array(n * 2), col: new Float32Array(n * 4),
    q: new Float32Array(n * 3), nrm: new Float32Array(n * 3), misc: new Float32Array(n * 2),
  };
}

export class VfxPlateBatchMesh {
  readonly mesh: Mesh<Geometry, Shader>;
  readonly capacity: number;
  readonly segs: number;
  private readonly vpp: number;
  private readonly pos: Float32Array;
  private readonly uv: Float32Array;
  private readonly col: Float32Array;
  private readonly q: Float32Array;
  private readonly nrm: Float32Array;
  private readonly misc: Float32Array;
  private readonly miscBuf: Buffer;
  private readonly posBuf: Buffer;
  private readonly uvBuf: Buffer;
  private readonly colBuf: Buffer;
  private readonly qBuf: Buffer;
  private readonly nrmBuf: Buffer;
  private count = 0;
  private dirtyFrom = 0;

  constructor(capacity: number, segs: number, shader: Shader) {
    this.capacity = Math.max(1, capacity);
    this.segs = Math.max(1, segs | 0);
    const cap = this.capacity;
    const vpp = 2 * (this.segs + 1);
    this.vpp = vpp;
    const nv = cap * vpp;
    this.pos = new Float32Array(nv * 2);
    this.uv = new Float32Array(nv * 2);
    this.col = new Float32Array(nv * 4);
    this.q = new Float32Array(nv * 3);
    this.nrm = new Float32Array(nv * 3);
    const local = new Float32Array(nv * 2);
    this.misc = new Float32Array(nv * 2);
    const idx = new Uint32Array(cap * this.segs * 6);
    let o = 0;
    for (let i = 0; i < cap; i++) {
      const base = i * vpp;
      for (let k = 0; k <= this.segs; k++) {
        const u = k / this.segs;
        local[(base + 2 * k) * 2] = u; local[(base + 2 * k) * 2 + 1] = 0;
        local[(base + 2 * k + 1) * 2] = u; local[(base + 2 * k + 1) * 2 + 1] = 1;
      }
      for (let k = 0; k < this.segs; k++) {
        const t0 = base + 2 * k, b0 = t0 + 1, t1 = t0 + 2, b1 = t0 + 3;
        idx[o++] = t0; idx[o++] = t1; idx[o++] = b1;
        idx[o++] = t0; idx[o++] = b1; idx[o++] = b0;
      }
    }
    const dyn = (data: Float32Array) => new Buffer({ data, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST });
    this.posBuf = dyn(this.pos);
    this.uvBuf = dyn(this.uv);
    this.colBuf = dyn(this.col);
    this.qBuf = dyn(this.q);
    this.nrmBuf = dyn(this.nrm);
    this.miscBuf = dyn(this.misc);
    const geometry = new Geometry({
      attributes: {
        aPosition: { buffer: this.posBuf, format: 'float32x2' },
        aUV: { buffer: this.uvBuf, format: 'float32x2' },
        aColor: { buffer: this.colBuf, format: 'float32x4' },
        aQ: { buffer: this.qBuf, format: 'float32x3' },
        aLocal: { buffer: new Buffer({ data: local, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST }), format: 'float32x2' },
        aMisc: { buffer: this.miscBuf, format: 'float32x2' },
        aNrm: { buffer: this.nrmBuf, format: 'float32x3' },
      },
      indexBuffer: new Buffer({ data: idx, usage: BufferUsage.INDEX | BufferUsage.COPY_DST }),
    });
    this.mesh = new Mesh({ geometry, shader });
    this.mesh.position.set(0, 0);
  }

  get used(): number { return this.count; }

  begin(): void {
    this.count = 0;
  }

  /** 写一张；满了返回 false。`strip` 的顶点数必须等于本网格的 `2·(segs+1)`。 */
  push(strip: VfxPlateStrip): boolean {
    const i = this.count;
    if (i >= this.capacity) return false;
    this.count = i + 1;
    const v0 = i * this.vpp;
    this.pos.set(strip.pos, v0 * 2);
    this.uv.set(strip.uv, v0 * 2);
    this.col.set(strip.col, v0 * 4);
    this.q.set(strip.q, v0 * 3);
    this.nrm.set(strip.nrm, v0 * 3);
    this.misc.set(strip.misc, v0 * 2);
    return true;
  }

  end(): void {
    const from = this.count;
    const to = Math.max(this.dirtyFrom, from);
    const vpp = this.vpp;
    if (from < this.capacity) {
      for (let i = from; i < to; i++) {
        this.pos.fill(0, i * vpp * 2, (i + 1) * vpp * 2);
        this.col.fill(0, i * vpp * 4, (i + 1) * vpp * 4);
      }
    }
    this.dirtyFrom = from;
    this.posBuf.update();
    this.uvBuf.update();
    this.colBuf.update();
    this.qBuf.update();
    this.nrmBuf.update();
    this.miscBuf.update();
    this.mesh.visible = from > 0;
  }

  destroy(): void {
    this.mesh.removeFromParent();
    const g = this.mesh.geometry;
    this.mesh.destroy();
    g.destroy(true);
  }
}
