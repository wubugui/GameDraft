/**
 * engine2d `Buffer` → RHI 缓冲。尺寸变了(`_resourceId` 变)重建,内容版本变了(`_updateID` 变)重传。
 * 只在规划阶段(录制之前)调用,所以不会碰上「录制期写已引用资源」。
 */
import { RhiBufferUsage, type RhiBuffer, type RhiDevice, type RhiResourceScope } from '../../rendering/rhi';
import { BufferUsage, type Buffer } from '../shader/Buffer';

interface Entry {
  buffer: RhiBuffer;
  resourceId: number;
  updateId: number;
}

function toRhiUsage(usage: number): number {
  let out = RhiBufferUsage.COPY_DST;
  if (usage & BufferUsage.VERTEX) out |= RhiBufferUsage.VERTEX;
  if (usage & BufferUsage.INDEX) out |= RhiBufferUsage.INDEX;
  if (usage & BufferUsage.UNIFORM) out |= RhiBufferUsage.UNIFORM;
  if (usage & BufferUsage.STORAGE) out |= RhiBufferUsage.STORAGE;
  return out;
}

export class GpuBuffers {
  private readonly entries = new Map<Buffer, Entry>();

  constructor(
    private readonly rhi: RhiDevice,
    private readonly scope: RhiResourceScope,
  ) {}

  get(buffer: Buffer): RhiBuffer {
    const indexFormat = buffer.usage & BufferUsage.INDEX ? (buffer.data instanceof Uint16Array ? 'uint16' : 'uint32') : undefined;
    let e = this.entries.get(buffer);
    if (e && e.resourceId !== buffer._resourceId) {
      e.buffer.destroy();
      this.entries.delete(buffer);
      e = undefined;
    }
    const data = buffer.data;
    if (!e) {
      // WebGPU 要求写入长度 4 字节对齐;缓冲大小也按 4 取整
      const size = Math.max(4, Math.ceil(data.byteLength / 4) * 4);
      const rhiBuffer = this.scope.createBuffer({
        label: buffer.label ?? `engine2d-buffer-${buffer.uid}`,
        usage: toRhiUsage(buffer.usage),
        size,
        indexFormat,
      });
      e = { buffer: rhiBuffer, resourceId: buffer._resourceId, updateId: -1 };
      this.entries.set(buffer, e);
      buffer.once('destroy', () => this.release(buffer));
    }
    if (e.updateId !== buffer._updateID) {
      e.updateId = buffer._updateID;
      const bytes = Math.min(Math.ceil(buffer._uploadSize / 4) * 4, e.buffer.size);
      if (bytes > 0) {
        if (data.byteLength % 4 === 0 || bytes <= data.byteLength) {
          const n = Math.min(bytes, Math.floor(data.byteLength / 4) * 4);
          if (n > 0) this.rhi.writeBuffer(e.buffer, new Uint8Array(data.buffer, data.byteOffset, n));
          if (n < bytes) this.writeTail(e.buffer, data, n);
        } else this.writeTail(e.buffer, data, 0);
      }
    }
    return e.buffer;
  }

  /** 长度不是 4 的倍数(例如 Uint16 索引的奇数个)时,补零到 4 字节对齐再写 */
  private writeTail(target: RhiBuffer, data: ArrayBufferView, from: number): void {
    const rest = data.byteLength - from;
    const padded = new Uint8Array(Math.ceil(rest / 4) * 4);
    padded.set(new Uint8Array(data.buffer, data.byteOffset + from, rest));
    this.rhi.writeBuffer(target, padded, from);
  }

  release(buffer: Buffer): void {
    const e = this.entries.get(buffer);
    if (!e) return;
    e.buffer.destroy();
    this.entries.delete(buffer);
  }

  destroy(): void {
    for (const e of this.entries.values()) e.buffer.destroy();
    this.entries.clear();
  }
}
