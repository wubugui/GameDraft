import { EventEmitter } from '../utils/EventEmitter';
import { uid } from '../utils/uid';

/** 缓冲用途位(数值与 Pixi / WebGPU 相同) */
export const BufferUsage = {
  MAP_READ: 0x0001,
  MAP_WRITE: 0x0002,
  COPY_SRC: 0x0004,
  COPY_DST: 0x0008,
  INDEX: 0x0010,
  VERTEX: 0x0020,
  UNIFORM: 0x0040,
  STORAGE: 0x0080,
  INDIRECT: 0x0100,
  QUERY_RESOLVE: 0x0200,
  STATIC: 0x0400,
} as const;

export type BufferData = Float32Array | Uint32Array | Uint16Array | Int32Array | Uint8Array | Int8Array | Int16Array;

export interface BufferOptions {
  data?: BufferData | number[];
  size?: number;
  usage: number;
  label?: string;
  shrinkToFit?: boolean;
}

/**
 * CPU 侧缓冲(照 Pixi `Buffer`):内容改了调 `update()`,GPU 侧在下次使用时重传。
 * 重新赋 `data`(长度变了)会让 GPU 缓冲按新大小重建。
 */
export class Buffer extends EventEmitter {
  readonly uid = uid('buffer');
  readonly _resourceType = 'buffer';
  usage: number;
  label?: string;
  shrinkToFit: boolean;
  destroyed = false;
  /** 内容版本 */
  _updateID = 1;
  /** 需要重建 GPU 缓冲的版本(尺寸变化) */
  _resourceId = uid('resource');
  descriptor: { size: number; usage: number; mappedAtCreation: boolean; label?: string };
  private _data: BufferData;
  private _updateSize: number;

  constructor({ data, size, usage, label, shrinkToFit = true }: BufferOptions) {
    super();
    if (data instanceof Array) data = new Float32Array(data);
    this._data = (data ?? new Float32Array(Math.ceil((size ?? 0) / 4))) as BufferData;
    size ??= this._data.byteLength;
    this.usage = usage;
    this.label = label;
    this.shrinkToFit = shrinkToFit;
    this.descriptor = { size, usage, mappedAtCreation: !!data, label };
    this._updateSize = size;
  }

  get data(): BufferData {
    return this._data;
  }
  set data(value: BufferData) {
    this.setDataWithSize(value, value.length, true);
  }

  get static(): boolean {
    return !!(this.usage & BufferUsage.STATIC);
  }
  set static(v: boolean) {
    if (v) this.usage |= BufferUsage.STATIC;
    else this.usage &= ~BufferUsage.STATIC;
  }

  /** 按元素个数设数据(Pixi 语义:`size` 是元素数) */
  setDataWithSize(value: BufferData, size: number, syncGPU: boolean): void {
    this._updateID++;
    this._updateSize = size * value.BYTES_PER_ELEMENT;
    if (this._data === value) {
      if (syncGPU) this.emit('update', this);
      return;
    }
    const old = this._data;
    this._data = value;
    if (!old || old.length !== value.length) {
      if (!this.shrinkToFit && old && value.byteLength < old.byteLength) {
        if (syncGPU) this.emit('update', this);
      } else {
        this.descriptor.size = value.byteLength;
        this._resourceId = uid('resource');
        this.emit('change', this);
      }
      return;
    }
    if (syncGPU) this.emit('update', this);
  }

  /** 内容改了;`sizeInBytes` 只重传前这么多字节 */
  update(sizeInBytes?: number): void {
    this._updateSize = sizeInBytes ?? this._updateSize;
    this._updateID++;
    this.emit('update', this);
  }

  /** 本次要传的字节数 */
  get _uploadSize(): number {
    return Math.min(this._updateSize || this._data.byteLength, this._data.byteLength);
  }

  destroy(): void {
    this.destroyed = true;
    this.emit('destroy', this);
    this.emit('change', this);
    this._data = null as unknown as BufferData;
    this.descriptor = null as unknown as Buffer['descriptor'];
    this.removeAllListeners();
  }
}

/** 着色器里以 `{buffer, offset, size}` 绑定的缓冲片段 */
export class BufferResource {
  readonly _resourceType = 'bufferResource';
  readonly uid = uid('buffer');
  constructor(public buffer: Buffer, public offset = 0, public size = 0) {}
}
