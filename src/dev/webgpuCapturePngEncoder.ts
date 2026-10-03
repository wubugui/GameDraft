import {
  capturePngAbortError, capturePngTaskSize, encodeCapturePng,
  type WebGpuCapturePngTask, type WebGpuCapturePngWorkerRequest,
  type WebGpuCapturePngWorkerResponse,
} from './webgpuCapturePngCodec';

export type { WebGpuCapturePngTask } from './webgpuCapturePngCodec';

export interface WebGpuCapturePngEncoderOptions {
  /** Bounded to 2–4 workers; memory admission can reduce actual concurrency. */
  workerCount?: number;
  maxInFlightBytes?: number;
  timeoutMs?: number;
}

interface PendingEncode {
  id: number;
  task: WebGpuCapturePngTask;
  workingBytes: number;
  resolve: (blob: Blob) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  timer?: ReturnType<typeof setTimeout>;
  dispatchTimer?: ReturnType<typeof setTimeout>;
  controller?: AbortController;
  slot?: WorkerSlot;
  active: boolean;
  settled: boolean;
}

interface WorkerSlot {
  worker: Worker;
  ready: boolean;
  pending?: PendingEncode;
  startupTimer?: ReturnType<typeof setTimeout>;
}

/** Owns bounded CPU workers. Queued tasks retain references, never speculative raw copies. */
export class WebGpuCapturePngEncoder {
  private readonly desiredWorkers: number;
  private readonly maxInFlightBytes: number;
  private readonly timeoutMs: number;
  private readonly queue: PendingEncode[] = [];
  private readonly pending = new Map<number, PendingEncode>();
  private readonly slots: WorkerSlot[] = [];
  private nextId = 1;
  private activeBytes = 0;
  private fallbackActive = false;
  private initialized = false;
  private disposed = false;
  private failure?: Error;
  private selectedBackend: 'web-worker' | 'main-thread';
  private unsupportedReason?: string;

  constructor(options: WebGpuCapturePngEncoderOptions = {}) {
    const requestedWorkers = options.workerCount ?? 4;
    this.desiredWorkers = Number.isFinite(requestedWorkers)
      ? Math.max(2, Math.min(4, Math.floor(requestedWorkers))) : 4;
    const memory = options.maxInFlightBytes ?? 256 * 1024 * 1024;
    const timeout = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(memory) || memory < 1 || !Number.isFinite(timeout) || timeout < 1) {
      throw new Error('PNG 编码内存预算或超时无效');
    }
    this.maxInFlightBytes = memory;
    this.timeoutMs = timeout;
    this.selectedBackend = typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined' &&
      typeof OffscreenCanvas.prototype.convertToBlob === 'function' ? 'web-worker' : 'main-thread';
    if (this.selectedBackend === 'main-thread') {
      this.unsupportedReason = '当前宿主不支持 Worker / OffscreenCanvas PNG，使用主线程兼容编码';
    }
  }

  get backend(): 'web-worker' | 'main-thread' { return this.selectedBackend; }
  get workerCount(): number { return this.selectedBackend === 'web-worker' ? this.desiredWorkers : 0; }
  get fallbackReason(): string | undefined { return this.unsupportedReason; }

  encode(task: WebGpuCapturePngTask, options: { signal?: AbortSignal } = {}): Promise<Blob> {
    if (this.disposed) return Promise.reject(new Error('PNG 编码器已关闭'));
    if (this.failure) return Promise.reject(this.failure);
    if (options.signal?.aborted) return Promise.reject(capturePngAbortError());
    let workingBytes: number;
    try {
      workingBytes = capturePngTaskSize(task).workingBytes;
      if (workingBytes > this.maxInFlightBytes) {
        throw new Error(`PNG 工作内存超过 ${Math.round(this.maxInFlightBytes / 1024 / 1024)} MiB 上限，原始 GPU 字节仍可导出`);
      }
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return new Promise<Blob>((resolve, reject) => {
      const pending: PendingEncode = {
        id: this.nextId++, task, workingBytes, resolve, reject,
        signal: options.signal, active: false, settled: false,
      };
      pending.onAbort = () => this.cancel(pending, capturePngAbortError());
      pending.signal?.addEventListener('abort', pending.onAbort, { once: true });
      this.pending.set(pending.id, pending);
      this.queue.push(pending);
      this.initialize();
      this.pump();
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseAll(new Error('PNG 编码器已关闭'));
  }

  private initialize(): void {
    if (this.initialized || this.selectedBackend !== 'web-worker') return;
    this.initialized = true;
    try {
      for (let i = 0; i < this.desiredWorkers; i++) this.createWorker();
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private createWorker(): void {
    const worker = new Worker(new URL('./webgpuCapturePngWorker.ts', import.meta.url), { type: 'module' });
    const slot: WorkerSlot = { worker, ready: false };
    this.slots.push(slot);
    slot.startupTimer = setTimeout(() => this.fail(new Error('PNG Worker 启动超时')), this.timeoutMs);
    worker.onmessage = (event: MessageEvent<WebGpuCapturePngWorkerResponse>): void => {
      if (this.disposed || this.failure || !this.slots.includes(slot)) return;
      const message = event.data;
      if (message.type === 'ready') {
        clearTimeout(slot.startupTimer);
        slot.startupTimer = undefined;
        if (!message.supported) {
          this.useFallback(message.reason ?? 'Worker 不支持 PNG 编码');
          return;
        }
        slot.ready = true;
        this.pump();
      } else {
        const pending = slot.pending;
        if (!pending || pending.id !== message.id) {
          this.fail(new Error('PNG Worker 返回了不匹配的任务编号'));
          return;
        }
        if (message.type === 'error') this.settle(pending, undefined, new Error(message.message));
        else if (!(message.blob instanceof Blob) || !message.blob.size || message.blob.type !== 'image/png') {
          this.settle(pending, undefined, new Error('PNG Worker 未返回有效 PNG'));
        } else this.settle(pending, message.blob);
        this.pump();
      }
    };
    worker.onerror = (event): void => {
      event.preventDefault();
      this.fail(new Error(`PNG Worker 失败: ${event.message || '未知错误'}`));
    };
    worker.onmessageerror = (): void => this.fail(new Error('PNG Worker 消息无法读取'));
  }

  private useFallback(reason: string): void {
    // Initialization capability failure is the sole automatic fallback. If another
    // worker already started encoding, terminate it and requeue its original bytes.
    for (const slot of this.slots) {
      const pending = slot.pending;
      if (pending) {
        clearTimeout(pending.timer);
        pending.timer = undefined;
        pending.slot = undefined;
        pending.active = false;
        this.activeBytes -= pending.workingBytes;
        this.queue.unshift(pending);
      }
      this.terminate(slot);
    }
    this.slots.length = 0;
    this.selectedBackend = 'main-thread';
    this.unsupportedReason = reason;
    this.pump();
  }

  private pump(): void {
    if (this.disposed || this.failure) return;
    if (this.selectedBackend === 'main-thread') {
      if (this.fallbackActive) return;
      const pending = this.queue.shift();
      if (!pending) return;
      this.fallbackActive = true;
      this.start(pending);
      pending.controller = new AbortController();
      // Allow progress/status painting before the explicitly reported fallback.
      pending.dispatchTimer = setTimeout(() => {
        pending.dispatchTimer = undefined;
        if (pending.settled) return;
        void encodeCapturePng(pending.task, { offscreen: false, signal: pending.controller!.signal }).then(
          (blob) => { this.settle(pending, blob); this.pump(); },
          (error: unknown) => {
            this.settle(pending, undefined, error instanceof Error ? error : new Error(String(error)));
            this.pump();
          },
        );
      }, 0);
      return;
    }
    for (const slot of this.slots) {
      if (!slot.ready || slot.pending) continue;
      const pending = this.queue[0];
      if (!pending || this.activeBytes + pending.workingBytes > this.maxInFlightBytes) continue;
      this.queue.shift();
      pending.slot = slot;
      slot.pending = pending;
      this.start(pending);
      try {
        const task = this.cloneForWorker(pending.task);
        const pixels = task.kind === 'rgba' ? task.pixels : task.capture.rawPixels!;
        const message: WebGpuCapturePngWorkerRequest = { id: pending.id, task };
        slot.worker.postMessage(message, [pixels.buffer as ArrayBuffer]);
      } catch (error) {
        this.settle(pending, undefined, error instanceof Error ? error : new Error(String(error)));
        queueMicrotask(() => this.pump());
      }
    }
  }

  private cloneForWorker(task: WebGpuCapturePngTask): WebGpuCapturePngTask {
    // Copy only the exact view, only after admission. Never detach the frame's raw
    // buffer: its .raw upload can be running concurrently with PNG conversion.
    if (task.kind === 'rgba') return { ...task, pixels: new Uint8ClampedArray(task.pixels) };
    const rawPixels = new Uint8Array(task.capture.rawPixels!);
    switch (task.kind) {
      case 'pass': return { ...task, capture: { ...task.capture, rawPixels } };
      case 'input': return { ...task, capture: { ...task.capture, rawPixels } };
      case 'aspect': return { ...task, capture: { ...task.capture, rawPixels } };
      case 'resource': return { ...task, capture: { ...task.capture, rawPixels } };
    }
  }

  private start(pending: PendingEncode): void {
    pending.active = true;
    this.activeBytes += pending.workingBytes;
    pending.timer = setTimeout(() => this.cancel(pending, new Error('PNG 编码超时')), this.timeoutMs);
  }

  private cancel(pending: PendingEncode, error: Error): void {
    if (pending.settled) return;
    const slot = pending.slot;
    if (slot) {
      this.terminate(slot);
      this.slots.splice(this.slots.indexOf(slot), 1);
    }
    pending.controller?.abort();
    this.settle(pending, undefined, error);
    if (slot && !this.disposed && !this.failure) {
      try { this.createWorker(); }
      catch (createError) { this.fail(createError instanceof Error ? createError : new Error(String(createError))); }
    }
    this.pump();
  }

  private settle(pending: PendingEncode, blob?: Blob, error?: Error): void {
    if (pending.settled) return;
    pending.settled = true;
    clearTimeout(pending.timer);
    clearTimeout(pending.dispatchTimer);
    if (pending.onAbort) pending.signal?.removeEventListener('abort', pending.onAbort);
    this.pending.delete(pending.id);
    const index = this.queue.indexOf(pending);
    if (index >= 0) this.queue.splice(index, 1);
    if (pending.slot) pending.slot.pending = undefined;
    if (pending.active) {
      this.activeBytes -= pending.workingBytes;
      if (!pending.slot) this.fallbackActive = false;
    }
    if (error) pending.reject(error);
    else if (blob) pending.resolve(blob);
    else pending.reject(new Error('PNG 编码没有返回结果'));
  }

  private terminate(slot: WorkerSlot): void {
    clearTimeout(slot.startupTimer);
    slot.worker.onmessage = slot.worker.onerror = slot.worker.onmessageerror = null;
    slot.worker.terminate();
  }

  private fail(error: Error): void {
    if (this.failure || this.disposed) return;
    this.failure = error;
    this.releaseAll(error);
  }

  private releaseAll(error: Error): void {
    for (const slot of this.slots) this.terminate(slot);
    this.slots.length = 0;
    for (const pending of this.pending.values()) {
      pending.controller?.abort();
      this.settle(pending, undefined, error);
    }
    this.queue.length = 0;
  }
}
