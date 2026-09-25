/**
 * engine2d `Buffer` → RHI 缓冲。尺寸变了(`_resourceId` 变)重建,内容版本变了(`_updateID` 变)重传。
 * 只在规划阶段(录制之前)调用,所以不会碰上「录制期写已引用资源」。
 * 空闲回收照 Pixi 的 GCSystem(GpuBufferSystem 的 GCManagedHash):每次取用记「最近用过」,`collect` 对
 * `autoGarbageCollect` 的缓冲 `unload()` 释放 GPU 缓冲;下次取用时按完整 CPU 数据重建(同 Pixi createGPUBuffer)。
 * 缓冲的监听每建一次挂一份、释放时摘掉,不叠加。
 */
import { RhiBufferUsage, type RhiBuffer, type RhiDevice, type RhiResourceScope } from '../../rendering/rhi';
import { BufferUsage, type Buffer } from '../shader/Buffer';
import type { GpuResourceClock } from './GpuTextures';

interface Entry {
  buffer: RhiBuffer;
  resourceId: number;
  updateId: number;
  /** 最近一次被取用的时刻(GC 时钟) */
  lastUsed: number;
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
    private readonly clock: GpuResourceClock = { get now() { return performance.now(); } },
  ) {}

  get(buffer: Buffer): RhiBuffer {
    const indexFormat = buffer.usage & BufferUsage.INDEX ? (buffer.data instanceof Uint16Array ? 'uint16' : 'uint32') : undefined;
    let e = this.entries.get(buffer);
    if (e && e.resourceId !== buffer._resourceId) {
      this.drop(buffer, e);
      e = undefined;
    }
    const data = buffer.data;
    let fresh = false;
    if (!e) {
      // WebGPU 要求写入长度 4 字节对齐;缓冲大小也按 4 取整
      const size = Math.max(4, Math.ceil(data.byteLength / 4) * 4);
      const rhiBuffer = this.scope.createBuffer({
        label: buffer.label ?? `engine2d-buffer-${buffer.uid}`,
        usage: toRhiUsage(buffer.usage),
        size,
        indexFormat,
      });
      e = { buffer: rhiBuffer, resourceId: buffer._resourceId, updateId: -1, lastUsed: this.clock.now };
      this.entries.set(buffer, e);
      buffer.once('destroy', this.onBufferGone, this);
      buffer.once('unload', this.onBufferGone, this);
      fresh = true;
    }
    e.lastUsed = this.clock.now;
    if (e.updateId !== buffer._updateID) {
      e.updateId = buffer._updateID;
      // 新建的缓冲整份写(同 Pixi 建缓冲时拷全部数据;回收后重建时最近一次 update 可能只改了前一段)
      const bytes = Math.min(Math.ceil((fresh ? data.byteLength : buffer._uploadSize) / 4) * 4, e.buffer.size);
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
    if (e) this.drop(buffer, e);
  }

  /** 空闲回收(GCSystem 的回收器):`autoGarbageCollect` 的缓冲 `now - 最近用过 >= maxUnusedTime` 就 `unload()` */
  collect(now: number, maxUnusedTime: number): void {
    for (const [buffer, e] of [...this.entries]) {
      if (buffer.autoGarbageCollect && now - e.lastUsed >= maxUnusedTime) buffer.unload();
    }
  }

  destroy(): void {
    for (const [buffer, e] of [...this.entries]) {
      this.unhook(buffer);
      e.buffer.destroy();
    }
    this.entries.clear();
  }

  private onBufferGone(buffer: Buffer): void {
    this.release(buffer);
  }

  private drop(buffer: Buffer, e: Entry): void {
    e.buffer.destroy();
    this.entries.delete(buffer);
    this.unhook(buffer);
  }

  private unhook(buffer: Buffer): void {
    buffer.off('destroy', this.onBufferGone, this);
    buffer.off('unload', this.onBufferGone, this);
  }
}
