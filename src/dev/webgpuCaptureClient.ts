/** WebGPU Inspector's local capture, driven by the dev server for both F2 and agents. */
const API = '/__gamedraft-api/webgpu-capture';
const REQUEST_TIMEOUT_MS = 8_000;
const UPLOAD_TIMEOUT_MS = 120_000;
const HEARTBEAT_MS = 1_000;
const READBACK_TIMEOUT_MS = 30_000;
const PNG_ENCODE_TIMEOUT_MS = 30_000;
const MAX_FRAME_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_FRAME_IMAGES_BYTES = 512 * 1024 * 1024;

export interface WebGpuCaptureJob {
  id: string;
  targetBootId: string;
  state: 'pending' | 'capturing' | 'uploading' | 'completed' | 'failed' | 'stopped';
  requestedFrames: number;
  actualFrames: number;
  bytes: number;
  sha256: string | null;
  outputDir: string | null;
  captureFile: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CaptureStream {
  metadata: Record<string, unknown>;
  payloads: Array<{ id: number; typedArray: string; bytes: Uint8Array }>;
}

interface FramePixels {
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
}

interface FrameImageBatch {
  jobId: string;
  uploads: Promise<void>;
  bytes: number;
  failed: boolean;
  cancelled: boolean;
}

interface Inspector {
  beginFrameCapture(): void;
  endFrameCapture(): void;
  saveCaptureData(filename: string, options: { download: false }): Promise<CaptureStream>;
  captureStreamToBlob(stream: CaptureStream): Blob;
}

function currentInspector(): Inspector | null {
  const host = window as unknown as {
    webgpuInspector?: Partial<Inspector>;
    __gamedraftWebgpuCaptureInitialized?: boolean;
  };
  const value = host.webgpuInspector;
  return host.__gamedraftWebgpuCaptureInitialized && value &&
    typeof value.beginFrameCapture === 'function' &&
    typeof value.endFrameCapture === 'function' &&
    typeof value.saveCaptureData === 'function' &&
    typeof value.captureStreamToBlob === 'function' ? value as Inspector : null;
}

async function api<T>(method: 'GET' | 'POST' | 'PUT', query: Record<string, string>, body?: object | Blob): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), method === 'PUT' ? UPLOAD_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
  try {
    const url = `${API}?${new URLSearchParams(query)}`;
    const response = await fetch(url, {
      method,
      headers: body instanceof Blob ? { 'Content-Type': body.type || 'application/octet-stream' }
        : body ? { 'Content-Type': 'application/json' } : undefined,
      body: body instanceof Blob ? body : body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const raw = await response.text();
    let data: unknown;
    try { data = JSON.parse(raw); }
    catch { data = { error: raw || `HTTP ${response.status}` }; }
    if (!response.ok) {
      const message = data && typeof data === 'object' ? (data as { error?: unknown }).error : undefined;
      throw new Error(message ? String(message) : `HTTP ${response.status}`);
    }
    return data as T;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('WebGPU 抓帧服务响应超时');
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

export class WebGpuCaptureClient {
  private readonly bootId: string;
  private readonly sceneId: () => string | undefined;
  private readonly isGpuReady: () => boolean;
  private readonly setFrameHook: (hook: ((draw: () => void) => void) | null) => void;
  private readonly readFramePixels?: () => Promise<FramePixels | null>;
  private readonly onChange: () => void;
  private timer: number | null = null;
  private tickInFlight = false;
  private disposed = false;
  private activeJob: WebGpuCaptureJob | null = null;
  private latestJob: WebGpuCaptureJob | null = null;
  private cleanup: Promise<void> = Promise.resolve();
  private exportInFlight = false;
  private framesCaptured = 0;
  private registeredReady = false;
  private unreadyReason = '';
  private serviceError = '';
  private capturePoisoned = false;
  private stoppedJobIds = new Set<string>();
  private finishedLocallyJobId: string | null = null;
  private frameImages: FrameImageBatch | null = null;

  constructor(options: {
    bootId: string;
    sceneId: () => string | undefined;
    isGpuReady: () => boolean;
    setFrameHook: (hook: ((draw: () => void) => void) | null) => void;
    readFramePixels?: () => Promise<FramePixels | null>;
    onChange: () => void;
  }) {
    this.bootId = options.bootId;
    this.sceneId = options.sceneId;
    this.isGpuReady = options.isGpuReady;
    this.setFrameHook = options.setFrameHook;
    this.readFramePixels = options.readFramePixels;
    this.onChange = options.onChange;
  }

  get status(): { ready: boolean; reason: string; job: WebGpuCaptureJob | null; framesCaptured: number; error: string } {
    return { ready: this.registeredReady, reason: this.unreadyReason,
      job: this.latestJob, framesCaptured: this.framesCaptured, error: this.serviceError };
  }

  start(): void {
    if (this.timer !== null || this.disposed) return;
    void this.tick();
    this.timer = window.setInterval(() => void this.tick(), HEARTBEAT_MS);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    const job = this.activeJob;
    this.activeJob = null;
    if (this.frameImages) this.frameImages.cancelled = true;
    this.setFrameHook(null);
    if (job) {
      void api('POST', {}, { action: 'stop', jobId: job.id, targetBootId: this.bootId }).catch(() => {});
      this.discardPartialCapture();
    }
  }

  async request(frames: number): Promise<WebGpuCaptureJob> {
    if (this.disposed) throw new Error('抓帧控制器已销毁');
    if (!Number.isInteger(frames) || frames < 1 || frames > 120) throw new Error('帧数必须为 1–120 的整数');
    if (this.capturePoisoned) throw new Error('Inspector 捕获缓存无法清空，请刷新游戏页面后重试');
    if (!this.registeredReady) throw new Error('当前游戏未就绪，无法抓取 WebGPU 帧');
    const job = await api<WebGpuCaptureJob>('POST', {}, { action: 'request', targetBootId: this.bootId, frames });
    if (!this.disposed) {
      this.finishedLocallyJobId = null;
      this.latestJob = job;
      this.framesCaptured = 0;
      this.serviceError = '';
      this.onChange();
      void this.tick();
    }
    return job;
  }

  async stop(): Promise<WebGpuCaptureJob> {
    const job = this.latestJob;
    if (!job || !['pending', 'capturing', 'uploading'].includes(job.state)) throw new Error('当前没有可停止的抓帧任务');
    this.stoppedJobIds.add(job.id);
    if (this.stoppedJobIds.size > 32) this.stoppedJobIds.delete(this.stoppedJobIds.values().next().value!);
    if (this.frameImages?.jobId === job.id) this.frameImages.cancelled = true;
    this.leaveActiveJob();
    try {
      const result = await api<WebGpuCaptureJob>('POST', {}, { action: 'stop', jobId: job.id, targetBootId: this.bootId });
      if (!this.disposed) {
        this.latestJob = result;
        this.onChange();
      }
      return result;
    } catch (error) {
      this.stoppedJobIds.delete(job.id);
      throw error;
    }
  }

  private async tick(): Promise<void> {
    if (this.disposed || this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      const hasInspector = currentInspector() !== null;
      const hasWebGpu = 'gpu' in navigator;
      const hasRhi = this.isGpuReady();
      const ready = !this.capturePoisoned && hasInspector && hasWebGpu && hasRhi;
      const reason = this.capturePoisoned ? 'Inspector 捕获缓存无法清空，请刷新页面' :
        !hasInspector ? 'Inspector 未加载或缺少本地抓帧 API' :
        !hasWebGpu ? '浏览器未提供 WebGPU' : !hasRhi ? 'RHI 尚未就绪' : '';
      const registered = await api<{ captureReady: boolean; reason: string }>('POST', {}, {
        action: 'register', targetBootId: this.bootId, url: location.href,
        sceneId: this.sceneId() ?? '', captureReady: ready, reason,
      });
      if (this.disposed) return;
      this.registeredReady = registered.captureReady === true;
      this.unreadyReason = registered.reason || '';
      const job = await api<WebGpuCaptureJob | null>('GET', { action: 'poll', targetBootId: this.bootId });
      if (this.disposed) return;
      if (job && (this.stoppedJobIds.has(job.id) || job.id === this.finishedLocallyJobId)) {
        const recent = await api<WebGpuCaptureJob | null>('GET', {
          action: 'status', jobId: job.id, targetBootId: this.bootId,
        });
        if (!this.disposed && recent) this.acceptStatus(recent);
      } else if (job?.state === 'capturing') {
        if (this.activeJob?.id !== job.id && !this.exportInFlight) {
          await this.cleanup;
          if (this.disposed) return;
          if (this.capturePoisoned) {
            await this.fail(job, 'Inspector 捕获缓存未能清空，需要刷新页面');
            return;
          }
          this.activeJob = job;
          this.framesCaptured = 0;
          this.frameImages = this.readFramePixels ? {
            jobId: job.id, uploads: Promise.resolve(), bytes: 0, failed: false, cancelled: false,
          } : null;
          this.setFrameHook((draw) => this.captureDisplayFrame(draw));
        }
        this.acceptStatus(job);
      } else {
        if (this.activeJob) this.leaveActiveJob();
        const recent = await api<WebGpuCaptureJob | null>('GET', { action: 'status', targetBootId: this.bootId });
        if (this.disposed) return;
        if (recent) this.acceptStatus(recent);
      }
      this.serviceError = '';
    } catch (error) {
      if (!this.disposed) this.serviceError = String(error);
    } finally {
      this.tickInFlight = false;
      if (!this.disposed) this.onChange();
    }
  }

  private captureDisplayFrame(draw: () => void): void {
    const job = this.activeJob;
    const inspector = currentInspector();
    if (!job || !inspector) {
      try { draw(); }
      finally { if (job) void this.fail(job, 'WebGPU Inspector 在抓帧期间不可用'); }
      return;
    }
    try {
      inspector.beginFrameCapture();
    } catch (error) {
      try { draw(); }
      finally { void this.fail(job, `无法开始抓帧：${String(error)}`); }
      return;
    }
    let rendered = false;
    let renderError: unknown;
    let renderFailed = false;
    let ended = false;
    try {
      draw();
      rendered = true;
    } catch (error) {
      renderError = error;
      renderFailed = true;
    } finally {
      try { inspector.endFrameCapture(); ended = true; }
      catch (error) { void this.fail(job, `无法结束抓帧：${String(error)}`); }
    }
    if (renderFailed) {
      void this.fail(job, `游戏渲染失败：${String(renderError)}`);
      throw renderError;
    }
    if (!rendered || !ended || this.activeJob?.id !== job.id) return;
    const frameIndex = this.framesCaptured + 1;
    const images = this.frameImages;
    if (this.readFramePixels) {
      if (!images || images.jobId !== job.id) {
        void this.fail(job, '抓帧图片批次丢失');
        return;
      }
      // Calling this here submits the GPU copy for this exact draw, before the next render.
      let readback: Promise<FramePixels | null>;
      try { readback = this.readFramePixels(); }
      catch (error) {
        void this.fail(job, `第 ${frameIndex} 帧回读失败：${String(error)}`);
        return;
      }
      this.queueFrameImage(job, images, frameIndex, readback);
    }
    this.framesCaptured = frameIndex;
    this.onChange();
    if (this.framesCaptured >= job.requestedFrames) {
      this.activeJob = null;
      this.finishedLocallyJobId = job.id;
      this.setFrameHook(null);
      this.exportInFlight = true;
      void this.export(job, inspector, this.framesCaptured, images);
    }
  }

  private queueFrameImage(job: WebGpuCaptureJob, batch: FrameImageBatch, frameIndex: number,
      readback: Promise<FramePixels | null>): void {
    // Readbacks and PNG encoding may overlap, but the PUTs must retain frame order.
    const pngReady = this.withReadbackTimeout(readback).then((pixels) => {
      if (batch.cancelled || !this.isCurrentJob(job)) throw new Error('抓帧任务已取消');
      return this.encodeFrameImage(pixels);
    });
    void pngReady.catch(() => {}); // A later ordered upload may not await it immediately.
    batch.uploads = batch.uploads.then(async () => {
      const png = await pngReady;
      if (batch.cancelled || !this.isCurrentJob(job)) return;
      if (png.size > MAX_FRAME_IMAGE_BYTES) throw new Error(`第 ${frameIndex} 帧 PNG 超过 32 MiB`);
      if (batch.bytes + png.size > MAX_FRAME_IMAGES_BYTES) throw new Error('抓帧 PNG 总量超过 512 MiB');
      await api('PUT', {
        action: 'frame-image', jobId: job.id, targetBootId: this.bootId,
        frameIndex: String(frameIndex),
      }, png);
      batch.bytes += png.size;
    });
    void batch.uploads.catch((error) => {
      if (batch.failed || batch.cancelled || !this.isCurrentJob(job)) return;
      batch.failed = true;
      batch.cancelled = true;
      void this.fail(job, `第 ${frameIndex} 帧 PNG 保存失败：${String(error)}`);
    });
  }

  private async withReadbackTimeout(readback: Promise<FramePixels | null>): Promise<FramePixels | null> {
    let timeout: number | null = null;
    try {
      return await Promise.race([
        readback,
        new Promise<never>((_, reject) => {
          timeout = window.setTimeout(() => reject(new Error('GPU 回读超时')), READBACK_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeout !== null) window.clearTimeout(timeout);
    }
  }

  private encodeFrameImage(frame: FramePixels | null): Promise<Blob> {
    if (!frame) throw new Error('GPU 画布没有可回读的图像');
    const { pixels, width, height } = frame;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
        !Number.isSafeInteger(width * height * 4) || pixels.length !== width * height * 4) {
      throw new Error('GPU 回读尺寸与 RGBA8 数据不匹配');
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('浏览器无法创建 PNG 编码画布');
    const imageData = context.createImageData(width, height);
    imageData.data.set(pixels);
    const rgba = imageData.data;
    // The RHI returns premultiplied bytes; ImageData expects straight alpha.
    for (let i = 0; i < rgba.length; i += 4) {
      const alpha = rgba[i + 3];
      if (alpha > 0 && alpha < 255) {
        rgba[i] = Math.min(255, Math.round(rgba[i] * 255 / alpha));
        rgba[i + 1] = Math.min(255, Math.round(rgba[i + 1] * 255 / alpha));
        rgba[i + 2] = Math.min(255, Math.round(rgba[i + 2] * 255 / alpha));
      }
    }
    context.putImageData(imageData, 0, 0);
    return new Promise<Blob>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('PNG 编码超时')), PNG_ENCODE_TIMEOUT_MS);
      try {
        canvas.toBlob((blob) => {
          window.clearTimeout(timeout);
          if (!blob || blob.size === 0 || blob.type !== 'image/png') reject(new Error('浏览器未生成有效 PNG'));
          else resolve(blob);
        }, 'image/png');
      } catch (error) {
        window.clearTimeout(timeout);
        reject(error);
      }
    });
  }

  private isCurrentJob(job: WebGpuCaptureJob): boolean {
    return !this.disposed && !this.stoppedJobIds.has(job.id) && this.latestJob?.id === job.id &&
      !['completed', 'failed', 'stopped'].includes(this.latestJob.state);
  }

  private async export(job: WebGpuCaptureJob, inspector: Inspector, actualFrames: number,
      images: FrameImageBatch | null): Promise<void> {
    let saved = false;
    try {
      const stream = await inspector.saveCaptureData(`${job.id}.wgpuc`, { download: false });
      saved = true;
      const blob = inspector.captureStreamToBlob(stream);
      if (!(blob instanceof Blob) || blob.size === 0) throw new Error('WebGPU Inspector 生成了空抓帧文件');
      if (images) await images.uploads;
      if (!this.isCurrentJob(job) || images?.cancelled) return;
      const result = await api<WebGpuCaptureJob>('PUT', {
        jobId: job.id, targetBootId: this.bootId, actualFrames: String(actualFrames),
      }, blob);
      if (this.isCurrentJob(job)) this.latestJob = result;
    } catch (error) {
      if (!saved) await this.discardPartialCapture();
      if (this.isCurrentJob(job) && !images?.failed) await this.fail(job, `抓帧导出失败：${String(error)}`);
    } finally {
      this.exportInFlight = false;
      if (this.frameImages === images) this.frameImages = null;
      if (!this.disposed) this.onChange();
    }
  }

  private leaveActiveJob(): void {
    const hadJob = this.activeJob !== null;
    if (this.activeJob) this.finishedLocallyJobId = this.activeJob.id;
    if (this.activeJob && this.frameImages?.jobId === this.activeJob.id) {
      this.frameImages.cancelled = true;
      this.frameImages = null;
    }
    this.activeJob = null;
    this.setFrameHook(null);
    if (hadJob && !this.exportInFlight) this.discardPartialCapture();
  }

  private discardPartialCapture(): Promise<void> {
    const inspector = currentInspector();
    if (!inspector) {
      this.capturePoisoned = true;
      this.registeredReady = false;
      return this.cleanup;
    }
    this.cleanup = this.cleanup.then(async () => {
      try { await inspector.saveCaptureData('discard.wgpuc', { download: false }); }
      catch (error) {
        this.capturePoisoned = true;
        this.registeredReady = false;
        this.serviceError = `Inspector 捕获缓存清空失败，请刷新页面：${String(error)}`;
        if (!this.disposed) this.onChange();
      }
    });
    return this.cleanup;
  }

  private async fail(job: WebGpuCaptureJob, message: string): Promise<void> {
    if (this.stoppedJobIds.has(job.id)) return;
    if (this.activeJob?.id === job.id) this.leaveActiveJob();
    try {
      const result = await api<WebGpuCaptureJob>('POST', {}, {
        action: 'fail', jobId: job.id, targetBootId: this.bootId, error: message,
      });
      if (this.isCurrentJob(job)) this.latestJob = result;
    } catch {
      if (this.isCurrentJob(job)) this.serviceError = message;
    }
    if (this.isCurrentJob(job)) this.onChange();
  }

  private acceptStatus(job: WebGpuCaptureJob): void {
    const old = this.latestJob;
    if (old?.id === job.id && ['completed', 'failed', 'stopped'].includes(old.state) &&
        ['pending', 'capturing', 'uploading'].includes(job.state)) return;
    this.latestJob = job;
  }
}
