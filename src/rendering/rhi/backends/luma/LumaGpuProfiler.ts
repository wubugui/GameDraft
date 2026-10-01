/// <reference types="@webgpu/types" />
import type {
  RhiGpuPassTiming,
  RhiGpuProfiler,
  RhiGpuProfilerStatus,
  RhiGpuSubmissionProfile,
} from '../../RhiDevice';

// 查询结果每项 64 bit，WebGPU timestamp 的单位为纳秒。
const QUERIES_PER_SET = 256;
const MAX_IN_FLIGHT = 8;
const READBACK_TIMEOUT_MS = 10_000;

interface QueryChunk {
  set: GPUQuerySet;
  used: number;
  byteOffset: number;
}

interface PendingPass {
  kind: 'render' | 'compute';
  label: string;
  byteOffset: number;
}

/** 一批命令的查询资源归这一批所有；映射完成、丢失或录制失败后逐一释放。 */
export class LumaGpuTimingCapture {
  private readonly chunks: QueryChunk[] = [];
  private readonly passes: PendingPass[] = [];
  private queryCount = 0;
  private resolveBuffer: GPUBuffer | null = null;
  private readBuffer: GPUBuffer | null = null;
  private cancelRead: ((error: Error) => void) | null = null;
  private canceled = false;
  private cleaned = false;

  constructor(
    private readonly owner: LumaGpuProfiler,
    private readonly device: GPUDevice,
    private readonly kind: 'frame' | 'submit',
    private readonly frame: number | null,
    private readonly label: string,
    private readonly onResult?: (profile: RhiGpuSubmissionProfile) => void,
  ) {}

  /** 在开始 render / compute pass 之前调用；只把查询索引放在 pass descriptor 的 timestampWrites。 */
  beginPass(kind: 'render' | 'compute', label: string): GPURenderPassTimestampWrites {
    let chunk = this.chunks[this.chunks.length - 1];
    if (!chunk || chunk.used + 2 > QUERIES_PER_SET) {
      chunk = { set: this.device.createQuerySet({ type: 'timestamp', count: QUERIES_PER_SET }), used: 0, byteOffset: this.queryCount * 8 };
      this.chunks.push(chunk);
    }
    const beginningOfPassWriteIndex = chunk.used;
    chunk.used += 2;
    this.passes.push({ kind, label, byteOffset: this.queryCount * 8 });
    this.queryCount += 2;
    return { querySet: chunk.set, beginningOfPassWriteIndex, endOfPassWriteIndex: beginningOfPassWriteIndex + 1 };
  }

  /** 所有 pass 结束后、同一个 GPUCommandEncoder.finish() 之前编码 resolve 与读回拷贝。 */
  finishEncoding(encoder: GPUCommandEncoder): void {
    if (!this.queryCount) return;
    const bytes = this.queryCount * 8;
    this.resolveBuffer = this.device.createBuffer({
      label: `GPU timings resolve: ${this.label}`,
      size: bytes,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    this.readBuffer = this.device.createBuffer({
      label: `GPU timings readback: ${this.label}`,
      size: bytes,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    for (const chunk of this.chunks) {
      encoder.resolveQuerySet(chunk.set, 0, chunk.used, this.resolveBuffer, chunk.byteOffset);
    }
    encoder.copyBufferToBuffer(this.resolveBuffer, 0, this.readBuffer, 0, bytes);
  }

  /** queue.submit 成功后才映射；异步结果不会挡住游戏帧。 */
  submitted(): void {
    if (!this.queryCount) {
      this.publish({ kind: this.kind, frame: this.frame, label: this.label, passes: [], totalGpuMs: 0 });
      this.cleanup();
      return;
    }
    void this.readResults().catch((error: unknown) => {
      if (!this.canceled) this.owner.report(error);
    }).finally(() => this.cleanup());
  }

  cancel(): void {
    this.canceled = true;
    this.cancelRead?.(new Error('GPU timing capture canceled'));
    this.cleanup();
  }

  private async readResults(): Promise<void> {
    const read = this.readBuffer;
    if (!read) throw new Error('GPU timing readback buffer missing');
    const canceled = new Promise<never>((_resolve, reject) => { this.cancelRead = reject; });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(`GPU timing readback exceeded ${READBACK_TIMEOUT_MS} ms`)),
        READBACK_TIMEOUT_MS);
    });
    try {
      await Promise.race([read.mapAsync(GPUMapMode.READ), canceled, timedOut]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      this.cancelRead = null;
    }
    if (this.canceled) return;
    const range = read.getMappedRange();
    const passes: RhiGpuPassTiming[] = [];
    let totalGpuMs = 0;
    try {
      const view = new DataView(range);
      for (const pass of this.passes) {
        const begin = view.getBigUint64(pass.byteOffset, true);
        const end = view.getBigUint64(pass.byteOffset + 8, true);
        if (end < begin) throw new Error(`GPU timestamp order invalid in pass ${pass.label}`);
        const gpuMs = Number(end - begin) / 1_000_000;
        passes.push({ kind: pass.kind, label: pass.label, gpuMs });
        totalGpuMs += gpuMs;
      }
    } finally {
      read.unmap();
    }
    this.publish({ kind: this.kind, frame: this.frame, label: this.label, passes, totalGpuMs });
  }

  private publish(profile: RhiGpuSubmissionProfile): void {
    this.owner.publish(profile);
    this.onResult?.(profile);
  }

  private cleanup(): void {
    if (this.cleaned) return;
    this.cleaned = true;
    this.resolveBuffer?.destroy();
    this.readBuffer?.destroy();
    for (const chunk of this.chunks) chunk.set.destroy();
    this.owner.finished(this);
  }
}

/** 仅显式启用时采样。设备没有 timestamp-query 时状态始终清楚报 unsupported。 */
export class LumaGpuProfiler implements RhiGpuProfiler {
  private readonly listeners = new Set<(profile: RhiGpuSubmissionProfile) => void>();
  private readonly inFlight = new Set<LumaGpuTimingCapture>();
  private wantEnabled: boolean;
  private destroyed = false;

  constructor(
    private device: GPUDevice,
    private readonly featureRequested: boolean,
    initiallyEnabled: boolean,
    private readonly onError: (error: unknown) => void,
  ) {
    this.wantEnabled = initiallyEnabled;
  }

  status(): RhiGpuProfilerStatus {
    if (this.destroyed) return { state: 'unsupported', reason: '设备已销毁' };
    if (!this.featureRequested) return { state: 'unsupported', reason: '当前设备未请求 timestamp-query（仅开发模式或显式 gpuProfiling 调试选项可请求）' };
    if (!this.device.features?.has('timestamp-query')) return { state: 'unsupported', reason: 'WebGPU 适配器或设备不支持 timestamp-query' };
    return { state: this.wantEnabled ? 'enabled' : 'disabled' };
  }

  setEnabled(enabled: boolean): void {
    this.wantEnabled = enabled;
  }

  onResult(listener: (profile: RhiGpuSubmissionProfile) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(kind: 'frame' | 'submit', frame: number | null, label: string,
    onResult?: (profile: RhiGpuSubmissionProfile) => void): LumaGpuTimingCapture | null {
    // Ordinary sampling may drop a busy frame. Explicit capture must retain every
    // submission; its caller holds the game until this frame's readbacks finish.
    if (this.status().state !== 'enabled' || (!onResult && this.inFlight.size >= MAX_IN_FLIGHT)) return null;
    const capture = new LumaGpuTimingCapture(this, this.device, kind, frame, label, onResult);
    this.inFlight.add(capture);
    return capture;
  }

  /** 当前 GPUDevice 丢失/换代：旧查询不能映射，新设备重新核查 feature。 */
  setDevice(next: GPUDevice): void {
    this.cancelPending();
    this.device = next;
  }

  cancelPending(): void {
    for (const capture of [...this.inFlight]) capture.cancel();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelPending();
    this.listeners.clear();
  }

  publish(profile: RhiGpuSubmissionProfile): void {
    if (this.destroyed) return;
    for (const listener of [...this.listeners]) {
      try { listener(profile); } catch (error) { this.report(error); }
    }
  }

  report(error: unknown): void {
    if (!this.destroyed) this.onError(error);
  }

  finished(capture: LumaGpuTimingCapture): void {
    this.inFlight.delete(capture);
  }
}
