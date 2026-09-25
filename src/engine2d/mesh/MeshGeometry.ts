import { Buffer, BufferUsage } from '../shader/Buffer';
import { Geometry, type Topology } from '../shader/Geometry';

export type BatchMode = 'auto' | 'batch' | 'no-batch';

export interface MeshGeometryOptions {
  positions?: Float32Array;
  uvs?: Float32Array;
  indices?: Uint32Array | Uint16Array;
  topology?: Topology;
  shrinkBuffersToFit?: boolean;
}

/** 位置 + uv + 索引的网格几何(照 Pixi `MeshGeometry`):属性名 aPosition / aUV */
export class MeshGeometry extends Geometry {
  batchMode: BatchMode = 'auto';

  constructor(options: MeshGeometryOptions = {}) {
    const positions = options.positions || new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
    let uvs = options.uvs;
    if (!uvs) uvs = options.positions ? new Float32Array(positions.length) : new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
    const indices = options.indices || new Uint32Array([0, 1, 2, 0, 2, 3]);
    const shrinkToFit = options.shrinkBuffersToFit ?? false;
    super({
      attributes: {
        aPosition: {
          buffer: new Buffer({ data: positions, label: 'attribute-mesh-positions', shrinkToFit, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST }),
          format: 'float32x2',
          stride: 8,
          offset: 0,
        },
        aUV: {
          buffer: new Buffer({ data: uvs, label: 'attribute-mesh-uvs', shrinkToFit, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST }),
          format: 'float32x2',
          stride: 8,
          offset: 0,
        },
      },
      indexBuffer: new Buffer({ data: indices, label: 'index-mesh-buffer', shrinkToFit, usage: BufferUsage.INDEX | BufferUsage.COPY_DST }),
      topology: options.topology ?? 'triangle-list',
    });
  }

  get positions(): Float32Array {
    return this.attributes.aPosition.buffer.data as Float32Array;
  }
  set positions(value: Float32Array) {
    this.attributes.aPosition.buffer.data = value;
  }

  get uvs(): Float32Array {
    return this.attributes.aUV.buffer.data as Float32Array;
  }
  set uvs(value: Float32Array) {
    this.attributes.aUV.buffer.data = value;
  }

  get indices(): Uint32Array | Uint16Array {
    return this.indexBuffer!.data as Uint32Array;
  }
  set indices(value: Uint32Array | Uint16Array) {
    this.indexBuffer!.data = value;
  }
}

export interface PlaneGeometryOptions {
  width?: number;
  height?: number;
  verticesX?: number;
  verticesY?: number;
}

/** 规则网格平面(照 Pixi `PlaneGeometry`) */
export class PlaneGeometry extends MeshGeometry {
  static defaultOptions = { width: 100, height: 100, verticesX: 10, verticesY: 10 };
  verticesX!: number;
  verticesY!: number;
  width!: number;
  height!: number;

  constructor(options: PlaneGeometryOptions = {}) {
    super({});
    this.build(options);
  }

  build(options: PlaneGeometryOptions): void {
    const o = { ...PlaneGeometry.defaultOptions, ...options };
    this.verticesX = this.verticesX ?? o.verticesX;
    this.verticesY = this.verticesY ?? o.verticesY;
    this.width = this.width ?? o.width;
    this.height = this.height ?? o.height;
    const total = this.verticesX * this.verticesY;
    const verts: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const vx = this.verticesX - 1;
    const vy = this.verticesY - 1;
    const sizeX = this.width / vx;
    const sizeY = this.height / vy;
    for (let i = 0; i < total; i++) {
      const x = i % this.verticesX;
      const y = (i / this.verticesX) | 0;
      verts.push(x * sizeX, y * sizeY);
      uvs.push(x / vx, y / vy);
    }
    const totalSub = vx * vy;
    for (let i = 0; i < totalSub; i++) {
      const xpos = i % vx;
      const ypos = (i / vx) | 0;
      const v1 = ypos * this.verticesX + xpos;
      const v2 = ypos * this.verticesX + xpos + 1;
      const v3 = (ypos + 1) * this.verticesX + xpos;
      const v4 = (ypos + 1) * this.verticesX + xpos + 1;
      indices.push(v1, v2, v3, v2, v4, v3);
    }
    this.buffers[0].data = new Float32Array(verts);
    this.buffers[1].data = new Float32Array(uvs);
    this.indexBuffer!.data = new Uint32Array(indices);
    this.buffers[0].update();
    this.buffers[1].update();
    this.indexBuffer!.update();
  }
}
