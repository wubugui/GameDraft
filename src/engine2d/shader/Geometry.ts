import { EventEmitter } from '../utils/EventEmitter';
import { uid } from '../utils/uid';
import { Bounds } from '../scene/Bounds';
import { Buffer, BufferUsage, type BufferData } from './Buffer';

export type VertexFormat =
  | 'uint8x2' | 'uint8x4' | 'sint8x2' | 'sint8x4' | 'unorm8x2' | 'unorm8x4' | 'snorm8x2' | 'snorm8x4'
  | 'uint16x2' | 'uint16x4' | 'sint16x2' | 'sint16x4' | 'unorm16x2' | 'unorm16x4' | 'snorm16x2' | 'snorm16x4'
  | 'float16x2' | 'float16x4' | 'float32' | 'float32x2' | 'float32x3' | 'float32x4'
  | 'uint32' | 'uint32x2' | 'uint32x3' | 'uint32x4' | 'sint32' | 'sint32x2' | 'sint32x3' | 'sint32x4';

export type Topology = 'point-list' | 'line-list' | 'line-strip' | 'triangle-list' | 'triangle-strip';

export interface Attribute {
  buffer: Buffer;
  format: VertexFormat;
  /** 字节跨度;缺省 = 格式大小(紧排) */
  stride?: number;
  /** 字节偏移 */
  offset?: number;
  instance?: boolean;
  /** 不用于 WebGPU:Pixi 的起始顶点 */
  start?: number;
}

export interface AttributeOption {
  buffer: Buffer | BufferData | number[];
  format?: VertexFormat;
  stride?: number;
  offset?: number;
  instance?: boolean;
  start?: number;
}

export interface GeometryDescriptor {
  label?: string;
  attributes?: Record<string, Buffer | BufferData | number[] | AttributeOption>;
  indexBuffer?: Buffer | BufferData | number[];
  topology?: Topology;
  instanceCount?: number;
}

const FORMAT_BYTES: Record<string, number> = {
  uint8x2: 2, uint8x4: 4, sint8x2: 2, sint8x4: 4, unorm8x2: 2, unorm8x4: 4, snorm8x2: 2, snorm8x4: 4,
  uint16x2: 4, uint16x4: 8, sint16x2: 4, sint16x4: 8, unorm16x2: 4, unorm16x4: 8, snorm16x2: 4, snorm16x4: 8,
  float16x2: 4, float16x4: 8, float32: 4, float32x2: 8, float32x3: 12, float32x4: 16,
  uint32: 4, uint32x2: 8, uint32x3: 12, uint32x4: 16, sint32: 4, sint32x2: 8, sint32x3: 12, sint32x4: 16,
};

export function vertexFormatBytes(format: string): number {
  const b = FORMAT_BYTES[format];
  if (!b) throw new Error(`[engine2d] 不认识的顶点格式 ${format}`);
  return b;
}

function ensureBuffer(b: Buffer | BufferData | number[], index: boolean): Buffer {
  if (b instanceof Buffer) return b;
  const data = b instanceof Array ? (index ? new Uint32Array(b) : new Float32Array(b)) : b;
  return new Buffer({ data, usage: (index ? BufferUsage.INDEX : BufferUsage.VERTEX) | BufferUsage.COPY_DST, label: index ? 'index' : 'attribute' });
}

/** 顶点数据(照 Pixi `Geometry`):按属性名对着色器的 `@location` 参数名绑定 */
export class Geometry extends EventEmitter {
  readonly uid = uid('geometry');
  readonly _layoutKey = uid('geometryLayout');
  label?: string;
  topology: Topology;
  attributes: Record<string, Attribute> = {};
  buffers: Buffer[] = [];
  indexBuffer?: Buffer;
  instanceCount: number;
  destroyed = false;
  _boundsDirty = true;
  private readonly _bounds = new Bounds();

  constructor(options: GeometryDescriptor = {}) {
    super();
    this.label = options.label;
    this.topology = options.topology ?? 'triangle-list';
    this.instanceCount = options.instanceCount ?? 1;
    for (const name in options.attributes ?? {}) this.addAttribute(name, options.attributes![name]);
    if (options.indexBuffer) this.addIndex(options.indexBuffer);
  }

  addAttribute(name: string, attributeOption: Buffer | BufferData | number[] | AttributeOption): void {
    const opt: AttributeOption = attributeOption instanceof Buffer || ArrayBuffer.isView(attributeOption) || Array.isArray(attributeOption)
      ? { buffer: attributeOption as Buffer }
      : (attributeOption as AttributeOption);
    const buffer = ensureBuffer(opt.buffer, false);
    const format = opt.format ?? 'float32x2';
    this.attributes[name] = {
      buffer,
      format,
      stride: opt.stride,
      offset: opt.offset ?? 0,
      instance: opt.instance ?? false,
      start: opt.start,
    };
    if (!this.buffers.includes(buffer)) {
      this.buffers.push(buffer);
      buffer.on('update', this.onBufferUpdate, this);
      buffer.on('change', this.onBufferUpdate, this);
    }
  }

  addIndex(indexBuffer: Buffer | BufferData | number[]): void {
    const b = ensureBuffer(indexBuffer, true);
    b.usage |= BufferUsage.INDEX;
    this.indexBuffer = b;
    if (!this.buffers.includes(b)) this.buffers.push(b);
  }

  getAttribute(id: string): Attribute {
    return this.attributes[id];
  }

  getIndex(): Buffer {
    return this.indexBuffer!;
  }

  getBuffer(id: string): Buffer {
    return this.getAttribute(id).buffer;
  }

  /** 顶点数(按第一个非实例属性的缓冲长度推) */
  getSize(): number {
    for (const name in this.attributes) {
      const a = this.attributes[name];
      if (a.instance) continue;
      const stride = a.stride || vertexFormatBytes(a.format);
      return a.buffer.data.byteLength / stride;
    }
    return 0;
  }

  /** aPosition 的包围盒 */
  get bounds(): Bounds {
    if (!this._boundsDirty) return this._bounds;
    this._boundsDirty = false;
    const b = this._bounds.clear();
    const attr = this.attributes.aPosition;
    if (!attr) return b;
    const data = attr.buffer.data as Float32Array;
    const stride = (attr.stride || 8) / 4;
    const off = (attr.offset ?? 0) / 4;
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (let i = off; i + 1 < data.length; i += stride) {
      const x = data[i];
      const y = data[i + 1];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    b.minX = minX; b.minY = minY; b.maxX = maxX; b.maxY = maxY;
    return b;
  }

  protected onBufferUpdate(): void {
    this._boundsDirty = true;
    this.emit('update', this);
  }

  destroy(destroyBuffers = false): void {
    this.destroyed = true;
    this.emit('destroy', this);
    this.removeAllListeners();
    if (destroyBuffers) for (const b of this.buffers) b.destroy();
    // 照 Pixi Geometry.destroy:索引缓冲总归本几何所有,不带 destroyBuffers 也销毁(顶点缓冲可能共享,留给空闲回收)
    if (this.indexBuffer && !this.indexBuffer.destroyed) this.indexBuffer.destroy();
    this.attributes = {};
    this.buffers = [];
    this.indexBuffer = undefined;
  }
}
