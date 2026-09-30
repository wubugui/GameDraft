/** WebGPU Inspector's local capture, driven by the dev server for both F2 and agents. */
import type { RhiDevice } from '../rendering/rhi/RhiDevice';
import { captureFrameDiagnostics, visualizeCapturedAspectPixels, visualizeCapturedInputPixels, visualizeCapturedPassPixels,
  visualizeCapturedResourceTexture,
  type CapturedFrameDiagnostics } from './webgpuFrameDiagnostics';

const API = '/__gamedraft-api/webgpu-capture';
const REQUEST_TIMEOUT_MS = 8_000;
const UPLOAD_TIMEOUT_MS = 120_000;
const FINAL_UPLOAD_TIMEOUT_MS = 3_600_000;
const HEARTBEAT_MS = 1_000;
const READBACK_TIMEOUT_MS = 30_000;
const PNG_ENCODE_TIMEOUT_MS = 30_000;
const MAX_FRAME_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_FRAME_IMAGES_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_RESOURCE_IMAGES_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_CAPTURE_BYTES = 1024 * 1024 * 1024;

export interface WebGpuCaptureJob {
  id: string;
  targetBootId: string;
  state: 'pending' | 'capturing' | 'uploading' | 'completed' | 'failed' | 'stopped';
  requestedFrames: number;
  detailedFrameIndex: number;
  resourceFrames?: number[];
  actualFrames: number;
  bytes: number;
  sha256: string | null;
  outputDir: string | null;
  captureFile: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WebGpuCaptureHistoryItem {
  id: string;
  state: 'completed';
  requestedFrames: number;
  detailedFrameIndex: number;
  resourceFrames?: number[];
  actualFrames: number;
  bytes: number;
  sha256: string;
  createdAt: string;
  captureFile: string;
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

interface FrameDiagnosticBatch {
  jobId: string;
  uploads: Promise<void>;
  active: ReturnType<typeof captureFrameDiagnostics> | null;
  busy: boolean;
  cancelled: boolean;
  failed: boolean;
}

interface Inspector {
  beginFrameCapture(options: { maxBufferSize: number; maxTextureSize: number }): void;
  endFrameCapture(): void;
  disableRecording(): void;
  enableRecording(): void;
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
    typeof value.disableRecording === 'function' &&
    typeof value.enableRecording === 'function' &&
    typeof value.saveCaptureData === 'function' &&
    typeof value.captureStreamToBlob === 'function' ? value as Inspector : null;
}

async function api<T>(method: 'GET' | 'POST' | 'PUT', query: Record<string, string>,
  body?: object | Blob, timeoutMs?: number, externalSignal?: AbortSignal,
  keepalive = false): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = (): void => controller.abort();
  if (externalSignal?.aborted) abort();
  else externalSignal?.addEventListener('abort', abort, { once: true });
  const timeout = window.setTimeout(() => {
    timedOut = true;
    abort();
  }, timeoutMs ?? (method === 'PUT' ? UPLOAD_TIMEOUT_MS : REQUEST_TIMEOUT_MS));
  try {
    const url = `${API}?${new URLSearchParams(query)}`;
    const response = await fetch(url, {
      method,
      headers: body instanceof Blob ? { 'Content-Type': body.type || 'application/octet-stream' }
        : body ? { 'Content-Type': 'application/json' } : undefined,
      body: body instanceof Blob ? body : body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      keepalive,
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
    if (timedOut) throw new Error('WebGPU 抓帧服务响应超时');
    if (externalSignal?.aborted) throw new Error('抓帧任务已取消');
    if (controller.signal.aborted) throw new Error('WebGPU 抓帧服务响应中止');
    throw error;
  } finally {
    window.clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', abort);
  }
}

export class WebGpuCaptureClient {
  private readonly bootId: string;
  private readonly sceneId: () => string | undefined;
  private readonly isGpuReady: () => boolean;
  private readonly getCaptureReadiness?: () => { ready: boolean; reason: string };
  private readonly getRhi?: () => RhiDevice | null;
  private readonly setFrameHook: (hook: ((draw: () => void) => void) | null) => void;
  private readonly readFramePixels?: () => Promise<FramePixels | null>;
  private readonly suspendFrameLoop?: () => (() => void);
  private readonly advanceFrameLoop?: () => void;
  private readonly onChange: () => void;
  private timer: number | null = null;
  private tickInFlight = false;
  private disposed = false;
  private activeJob: WebGpuCaptureJob | null = null;
  private latestJob: WebGpuCaptureJob | null = null;
  private cleanup: Promise<void> = Promise.resolve();
  private exportInFlight = false;
  private exportingJob: WebGpuCaptureJob | null = null;
  private finalUpload: { jobId: string; controller: AbortController } | null = null;
  private framesCaptured = 0;
  private registeredReady = false;
  private unreadyReason = '';
  private serviceError = '';
  private capturePoisoned = false;
  private stoppedJobIds = new Set<string>();
  private finishedLocallyJobId: string | null = null;
  private frameImages: FrameImageBatch | null = null;
  private frameDiagnostics: FrameDiagnosticBatch | null = null;
  private resumeFrameLoop: (() => void) | null = null;

  constructor(options: {
    bootId: string;
    sceneId: () => string | undefined;
    isGpuReady: () => boolean;
    getCaptureReadiness?: () => { ready: boolean; reason: string };
    getRhi?: () => RhiDevice | null;
    setFrameHook: (hook: ((draw: () => void) => void) | null) => void;
    readFramePixels?: () => Promise<FramePixels | null>;
    suspendFrameLoop?: () => (() => void);
    advanceFrameLoop?: () => void;
    onChange: () => void;
  }) {
    this.bootId = options.bootId;
    this.sceneId = options.sceneId;
    this.isGpuReady = options.isGpuReady;
    this.getCaptureReadiness = options.getCaptureReadiness;
    this.getRhi = options.getRhi;
    this.setFrameHook = options.setFrameHook;
    this.readFramePixels = options.readFramePixels;
    this.suspendFrameLoop = options.suspendFrameLoop;
    this.advanceFrameLoop = options.advanceFrameLoop;
    this.onChange = options.onChange;
  }

  get status(): { ready: boolean; reason: string; job: WebGpuCaptureJob | null; framesCaptured: number; error: string; frozen: boolean } {
    return { ready: this.registeredReady, reason: this.unreadyReason,
      job: this.latestJob, framesCaptured: this.framesCaptured, error: this.serviceError,
      frozen: this.resumeFrameLoop !== null };
  }

  async history(limit = 20): Promise<WebGpuCaptureHistoryItem[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('历史抓帧数量必须是 1–100');
    return api<WebGpuCaptureHistoryItem[]>('GET',
      { action: 'history', limit: String(limit) }, undefined, 30_000);
  }

  async captureSettings(): Promise<{ outputDirectory: string }> {
    return api<{ outputDirectory: string }>('GET', { action: 'settings' });
  }

  async setCaptureDirectory(outputDirectory: string): Promise<{ outputDirectory: string }> {
    return api<{ outputDirectory: string }>('POST', {}, {
      action: 'settings', outputDirectory,
    });
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
    const jobs = [this.activeJob, this.exportingJob].filter((job): job is WebGpuCaptureJob => job !== null);
    this.finalUpload?.controller.abort();
    this.activeJob = null;
    this.exportingJob = null;
    if (this.frameImages) this.frameImages.cancelled = true;
    if (this.frameDiagnostics) {
      this.frameDiagnostics.cancelled = true;
      this.frameDiagnostics.active?.cancel();
    }
    this.releaseFrameLoop();
    this.frameDiagnostics = null;
    this.setFrameHook(null);
    for (const job of new Map(jobs.map(item => [item.id, item])).values()) {
      void api('POST', {}, { action: 'stop', jobId: job.id, targetBootId: this.bootId },
        undefined, undefined, true).catch(() => {});
    }
    if (jobs.length) this.discardPartialCapture();
  }

  async request(frames: number, detailedFrameIndex = 1): Promise<WebGpuCaptureJob> {
    if (this.disposed) throw new Error('抓帧控制器已销毁');
    if (!Number.isInteger(frames) || frames < 1 || frames > 120) throw new Error('帧数必须为 1–120 的整数');
    if (!Number.isInteger(detailedFrameIndex) || detailedFrameIndex < 1 || detailedFrameIndex > frames) {
      throw new Error(`详细分析帧必须是 1–${frames} 的整数`);
    }
    if (frames > 1 && !this.suspendFrameLoop) throw new Error('连续抓帧需要暂停帧循环能力');
    if (this.capturePoisoned) throw new Error('Inspector 捕获缓存无法清空，请刷新游戏页面后重试');
    if (!this.registeredReady) throw new Error('当前游戏未就绪，无法抓取 WebGPU 帧');
    if (this.exportInFlight || this.activeJob || this.resumeFrameLoop) throw new Error('当前抓帧尚未完成');
    const captureReadiness = this.getCaptureReadiness?.();
    if (captureReadiness && !captureReadiness.ready) throw new Error(captureReadiness.reason);
    // Freeze immediately for a local request. Polling, readback and disk transports
    // keep running; only the capture controller may explicitly advance a game frame.
    if (this.advanceFrameLoop) {
      this.holdFrameLoop();
      this.onChange();
    }
    const requestHold = this.resumeFrameLoop;
    let job: WebGpuCaptureJob;
    try {
      job = await api<WebGpuCaptureJob>('POST', {}, {
        action: 'request', targetBootId: this.bootId, frames, detailedFrameIndex,
      });
    } catch (error) {
      // The heartbeat may have adopted the server-created job while this POST
      // response was lost. Its capture still owns the same hold through export.
      if (this.resumeFrameLoop === requestHold && !this.activeJob && !this.exportingJob) {
        this.releaseFrameLoop();
      }
      throw error;
    }
    if (this.disposed) {
      void api('POST', {}, { action: 'stop', jobId: job.id, targetBootId: this.bootId },
        undefined, undefined, true).catch(() => {});
      throw new Error('抓帧控制器已销毁');
    }
    if (!this.disposed) {
      // A heartbeat can adopt this same job before the request response arrives.
      // Do not reset a frame already captured by that heartbeat.
      if (this.latestJob?.id !== job.id) {
        this.finishedLocallyJobId = null;
        this.latestJob = job;
        this.framesCaptured = 0;
      }
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
    if (this.finalUpload?.jobId === job.id) this.finalUpload.controller.abort();
    if (this.frameImages?.jobId === job.id) this.frameImages.cancelled = true;
    if (this.frameDiagnostics?.jobId === job.id) {
      this.frameDiagnostics.cancelled = true;
      this.frameDiagnostics.active?.cancel();
      this.frameDiagnostics = null;
    }
    this.releaseFrameLoop();
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
      const hasDiagnostics = hasRhi && Boolean(this.getRhi?.()?.frameDebugCapture);
      const captureReadiness = this.getCaptureReadiness?.();
      const ready = !this.capturePoisoned && hasInspector && hasWebGpu && hasRhi && hasDiagnostics
        && captureReadiness?.ready !== false;
      const reason = this.capturePoisoned ? 'Inspector 捕获缓存无法清空，请刷新页面' :
        !hasInspector ? 'Inspector 未加载或缺少本地抓帧 API' :
        !hasWebGpu ? '浏览器未提供 WebGPU' : !hasRhi ? 'RHI 尚未就绪' :
        !hasDiagnostics ? 'RHI 逐 pass 诊断钩子不可用' :
        captureReadiness?.ready === false ? captureReadiness.reason : '';
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
          if (this.stoppedJobIds.has(job.id) || job.id === this.finishedLocallyJobId
            || (this.latestJob?.id === job.id && ['completed', 'failed', 'stopped'].includes(this.latestJob.state))) {
            return;
          }
          const adoptionReadiness = this.getCaptureReadiness?.();
          if (adoptionReadiness?.ready === false) {
            await this.fail(job, adoptionReadiness.reason);
            return;
          }
          if (this.capturePoisoned) {
            await this.fail(job, 'Inspector 捕获缓存未能清空，需要刷新页面');
            return;
          }
          this.activeJob = job;
          this.framesCaptured = 0;
          this.frameImages = this.readFramePixels ? {
            jobId: job.id, uploads: Promise.resolve(), bytes: 0, failed: false, cancelled: false,
          } : null;
          this.frameDiagnostics = {
            jobId: job.id, uploads: Promise.resolve(), active: null,
            busy: false, cancelled: false, failed: false,
          };
          this.setFrameHook((draw) => this.captureDisplayFrame(draw));
          this.acceptStatus(job);
          if (this.advanceFrameLoop) {
            try {
              this.holdFrameLoop();
              this.advanceFrameLoop();
            } catch (error) {
              await this.fail(job, `无法推进捕获帧：${String(error)}`);
              return;
            }
          }
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
    const batch = this.frameDiagnostics;
    if (!batch || batch.jobId !== job.id) {
      try { draw(); }
      finally { void this.fail(job, '逐帧诊断批次丢失'); }
      return;
    }
    if (job.requestedFrames > 1 && !this.suspendFrameLoop) {
      try { draw(); }
      finally { void this.fail(job, '连续抓帧需要暂停帧循环能力'); }
      return;
    }
    // Hold the game through readback, every file upload and final analysis.
    // Between captured frames only one explicit step is permitted.
    if (batch.busy) {
      try { draw(); }
      finally { void this.fail(job, '上一捕获帧仍在导出，连续帧记录中断'); }
      return;
    }
    const frameIndex = this.framesCaptured + 1;
    const rhi = this.getRhi?.();
    if (!rhi?.frameDebugCapture) {
      try { draw(); }
      finally { void this.fail(job, 'RHI 逐 pass 诊断钩子不可用，无法完整抓帧'); }
      return;
    }
    let diagnostic: ReturnType<typeof captureFrameDiagnostics>;
    try {
      diagnostic = captureFrameDiagnostics(rhi, inspector);
      batch.active = diagnostic;
    } catch (error) {
      try { draw(); }
      finally { void this.fail(job, `无法安装逐帧诊断：${String(error)}`); }
      return;
    }
    try {
      // Inspector keeps game commands, object IDs and descriptors. Native resource
      // payloads are exported by the per-frame RHI sidecars, including pre-Draw
      // inputs and frame-end live objects, so its automatic copies are duplicate.
      inspector.beginFrameCapture({ maxBufferSize: 0, maxTextureSize: 0 });
    } catch (error) {
      diagnostic.cancel();
      batch.active = null;
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
      diagnostic.cancel();
      batch.active = null;
      void this.fail(job, `游戏渲染失败：${String(renderError)}`);
      throw renderError;
    }
    if (!rendered || !ended || this.activeJob?.id !== job.id) {
      diagnostic.cancel();
      batch.active = null;
      return;
    }
    const result = diagnostic.finish();
    void result.catch(() => {});
    batch.busy = true;
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
    let frameResume: (() => void) | null;
    try {
      this.holdFrameLoop();
      frameResume = this.resumeFrameLoop;
    } catch (error) {
      diagnostic.cancel();
      void this.fail(job, `无法暂停游戏帧循环：${String(error)}`);
      return;
    }
    batch.uploads = batch.uploads.then(async () => {
      let frameWritten = false;
      try {
        const diagnostics = await result;
        if (batch.cancelled || !this.isCurrentJob(job)) return;
        await this.exportDiagnostics(job, frameIndex, diagnostics);
        if (images) await images.uploads;
        frameWritten = true;
      } finally {
        if (batch.active === diagnostic) batch.active = null;
        batch.busy = false;
        if (frameWritten && frameIndex < job.requestedFrames && !batch.cancelled && this.isCurrentJob(job)) {
          if (this.advanceFrameLoop) this.advanceFrameLoop();
          else this.releaseFrameLoop(frameResume);
        }
      }
    });
    void batch.uploads.catch((error) => {
      if (batch.failed || batch.cancelled || !this.isCurrentJob(job)) return;
      batch.failed = true;
      batch.cancelled = true;
      void this.fail(job, `第 ${frameIndex} 帧逐 pass 导出失败：${String(error)}`);
    });
    this.framesCaptured = frameIndex;
    this.onChange();
    if (this.framesCaptured >= job.requestedFrames) {
      this.activeJob = null;
      this.finishedLocallyJobId = job.id;
      this.setFrameHook(null);
      this.exportInFlight = true;
      this.exportingJob = job;
      void this.export(job, inspector, this.framesCaptured, images, batch);
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
      if (batch.bytes + png.size > MAX_FRAME_IMAGES_BYTES) throw new Error('抓帧画布 PNG 总量超过 16 GiB');
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

  private encodeFrameImage(frame: FramePixels | null, unpremultiply = true): Promise<Blob> {
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
    if (unpremultiply) {
      for (let i = 0; i < rgba.length; i += 4) {
        const alpha = rgba[i + 3];
        if (alpha > 0 && alpha < 255) {
          rgba[i] = Math.min(255, Math.round(rgba[i] * 255 / alpha));
          rgba[i + 1] = Math.min(255, Math.round(rgba[i + 1] * 255 / alpha));
          rgba[i + 2] = Math.min(255, Math.round(rgba[i + 2] * 255 / alpha));
        }
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
      images: FrameImageBatch | null, diagnostics: FrameDiagnosticBatch): Promise<void> {
    let saved = false;
    try {
      await diagnostics.uploads;
      if (!this.isCurrentJob(job) || diagnostics.cancelled || images?.cancelled) return;
      const stream = await inspector.saveCaptureData(`${job.id}.wgpuc`, { download: false });
      saved = true;
      const blob = inspector.captureStreamToBlob(stream);
      if (!(blob instanceof Blob) || blob.size === 0) throw new Error('WebGPU Inspector 生成了空抓帧文件');
      if (blob.size > MAX_CAPTURE_BYTES) {
        throw new Error(`WGPUCAP ${blob.size} bytes 超过 1 GiB 原生容器上限`);
      }
      if (images) await images.uploads;
      if (!this.isCurrentJob(job) || diagnostics.cancelled || images?.cancelled) return;
      const controller = new AbortController();
      this.finalUpload = { jobId: job.id, controller };
      const result = await api<WebGpuCaptureJob>('PUT', {
        action: 'upload', jobId: job.id, targetBootId: this.bootId,
        actualFrames: String(actualFrames),
      }, blob, FINAL_UPLOAD_TIMEOUT_MS, controller.signal);
      if (result.state !== 'completed' && this.isCurrentJob(job)) {
        throw new Error(result.error || '抓帧服务未确认全部文件写入完成');
      }
      if (this.isCurrentJob(job)) this.latestJob = result;
    } catch (error) {
      if (!saved) await this.discardPartialCapture();
      if (this.isCurrentJob(job) && !images?.failed) await this.fail(job, `抓帧导出失败：${String(error)}`);
    } finally {
      if (this.finalUpload?.jobId === job.id) this.finalUpload = null;
      if (this.exportingJob?.id === job.id) this.exportingJob = null;
      this.exportInFlight = false;
      if (this.frameImages === images) this.frameImages = null;
      if (this.frameDiagnostics === diagnostics) {
        this.frameDiagnostics = null;
        this.releaseFrameLoop();
      }
      if (!this.disposed) this.onChange();
    }
  }

  private async exportDiagnostics(job: WebGpuCaptureJob, frameIndex: number,
      diagnostics: CapturedFrameDiagnostics): Promise<void> {
    const passes: Array<{ passOrdinal: number; label: string; targetLabel: string;
      colorIndex: number; width: number; height: number; format: string; reason?: string;
      rawBytesPerRow?: number; rawByteLength?: number; rawReason?: string }> = [];
    const inputs: Array<{ inputOrdinal: number; passOrdinal: number; bindingName: string; textureId: number | null;
      viewId: number | null; groupSlot: number; binding: number; contentVersion: number;
      mipLevel: number; arrayLayer: number; rawAliasInputOrdinal?: number;
      width: number; height: number;
      format: string; reason?: string; rawBytesPerRow?: number; rawByteLength?: number;
      rawReason?: string }> = [];
    const aspects: Array<{ aspectOrdinal: number; passOrdinal: number; label: string; targetLabel: string;
      aspect: 'depth' | 'stencil'; textureId: number | null; viewId: number | null;
      width: number; height: number; sourceFormat: string; rawFormat: 'r32float' | 'stencil8';
      sampleCount: number; sampleIndex: number | null; reason?: string;
      rawBytesPerRow?: number; rawByteLength?: number; rawReason?: string }> = [];
    const buffers: Array<{ bufferOrdinal: number; passOrdinal: number;
      role: 'uniform' | 'storage' | 'read-only-storage' | 'vertex' | 'index';
      bindingName?: string; groupSlot?: number; binding?: number; streamName?: string;
      vertexSlot?: number; indexFormat?: 'uint16' | 'uint32'; bufferId: number | null;
      bufferLabel: string; totalSize: number; offset: number; size: number;
      copiedOffset: number; copiedSize: number; rangeScope: 'binding' | 'draw-indices' | 'bound-suffix';
      reason?: string; rawByteLength?: number; rawReason?: string }> = [];
    const resourceTextures: Array<{ resourceOrdinal: number; textureOrdinal: number;
      textureId: number | null; label: string; width: number; height: number;
      sourceFormat: string; rawFormat: string; mipLevel: number; arrayLayer: number;
      aspect: 'color' | 'depth' | 'stencil'; sampleCount: number;
      captureMoment: 'frame-end'; reason?: string; rawBytesPerRow?: number;
      rawByteLength?: number; rawReason?: string }> = [];
    const resourceBuffers: Array<{ resourceOrdinal: number; bufferId: number | null;
      label: string; totalSize: number; copiedOffset: 0; copiedSize: number;
      captureMoment: 'frame-end'; reason?: string; rawByteLength?: number;
      rawReason?: string }> = [];
    // Bound local disk writes within a frame; the next frame still waits for every ACK.
    const pendingUploads = new Set<Promise<void>>();
    let uploadFailed = false;
    let uploadError: unknown;
    const upload = async (query: Record<string, string>, blob: Blob): Promise<void> => {
      if (uploadFailed) throw uploadError;
      const task = api('PUT', query, blob).then(() => {}, (error) => {
        if (!uploadFailed) uploadError = error;
        uploadFailed = true;
      }).finally(() => { pendingUploads.delete(task); });
      pendingUploads.add(task);
      if (pendingUploads.size >= 4) await Promise.race(pendingUploads);
      if (uploadFailed) throw uploadError;
    };
    let pngBytes = 0;
    let resourcePngBytes = 0;
    const uploadedInputs = new WeakMap<Uint8Array, {
      ordinal: number; rawByteLength: number; rawBytesPerRow: number;
      textureId: number | null; viewId: number | null; contentVersion: number;
      mipLevel: number; arrayLayer: number; width: number; height: number; format: string;
    }>();
    try {
      for (const item of diagnostics.passes) {
        if (!this.isCurrentJob(job)) return;
        if (uploadFailed) throw uploadError;
        let reason = item.reason?.slice(0, 500);
        if (item.rawPixels && item.rawBytesPerRow) {
          try {
            const pixels = visualizeCapturedPassPixels(item);
            const png = await this.encodeFrameImage({ pixels,
              width: item.width, height: item.height }, false);
            if (png.size > MAX_FRAME_IMAGE_BYTES) throw new Error('PNG 超过 32 MiB');
            if (pngBytes + png.size > MAX_FRAME_IMAGES_BYTES) {
              throw new Error('本帧 PNG 总量达到 16 GiB 上限');
            }
            await upload({
              action: 'pass-image', jobId: job.id, targetBootId: this.bootId,
              frameIndex: String(frameIndex), passOrdinal: String(item.passOrdinal), colorIndex: String(item.colorIndex),
            }, png);
            pngBytes += png.size;
          } catch (error) { reason = `Pass PNG 导出失败：${String(error)}`.slice(0, 500); }
        } else if (!reason) reason = 'Pass 没有可读回的颜色输出';
        let rawReason: string | undefined;
        let rawByteLength: number | undefined;
        if (item.rawPixels && item.rawBytesPerRow) {
          try {
            const raw = new Blob([item.rawPixels as BlobPart], { type: 'application/octet-stream' });
            item.rawPixels = undefined;
            await upload({
              action: 'pass-raw', jobId: job.id, targetBootId: this.bootId,
              frameIndex: String(frameIndex), passOrdinal: String(item.passOrdinal), colorIndex: String(item.colorIndex),
              format: item.format, width: String(item.width), height: String(item.height),
              bytesPerRow: String(item.rawBytesPerRow),
            }, raw);
            rawByteLength = raw.size;
          } catch (error) { rawReason = `Pass 原始像素导出失败：${String(error)}`.slice(0, 500); }
          finally { item.rawPixels = undefined; }
        } else rawReason = item.reason?.slice(0, 500) || 'Pass 没有可回读的原始像素';
        passes.push({
          passOrdinal: item.passOrdinal, label: item.label, targetLabel: item.targetLabel,
          colorIndex: item.colorIndex, width: item.width, height: item.height,
          format: item.format, ...(reason ? { reason } : {}),
          ...(rawByteLength === undefined ? { rawReason } : {
            rawBytesPerRow: item.rawBytesPerRow, rawByteLength,
          }),
        });
      }
      for (const [inputOrdinal, item] of diagnostics.inputs.entries()) {
        if (!this.isCurrentJob(job)) return;
        if (uploadFailed) throw uploadError;
        const pixels = item.rawPixels;
        const uploaded = pixels ? uploadedInputs.get(pixels) : undefined;
        if (uploaded && uploaded.textureId === item.textureId && uploaded.viewId === item.viewId &&
            uploaded.contentVersion === item.contentVersion && uploaded.mipLevel === item.mipLevel &&
            uploaded.arrayLayer === item.arrayLayer && uploaded.width === item.width &&
            uploaded.height === item.height && uploaded.format === item.format &&
            uploaded.rawBytesPerRow === item.rawBytesPerRow) {
          item.rawPixels = undefined;
          inputs.push({ inputOrdinal, passOrdinal: item.passOrdinal, bindingName: item.bindingName,
            textureId: item.textureId, viewId: item.viewId, groupSlot: item.groupSlot,
            binding: item.binding, contentVersion: item.contentVersion,
            mipLevel: item.mipLevel, arrayLayer: item.arrayLayer,
            width: item.width, height: item.height, format: item.format,
            rawAliasInputOrdinal: uploaded.ordinal, rawBytesPerRow: uploaded.rawBytesPerRow,
            rawByteLength: uploaded.rawByteLength,
          });
          continue;
        }
        let reason = item.reason?.slice(0, 500);
        if (item.rawPixels && item.rawBytesPerRow) {
          try {
            const pixels = visualizeCapturedInputPixels(item);
            if (pixels) {
              const png = await this.encodeFrameImage({ pixels,
                width: item.width, height: item.height }, false);
              if (png.size > MAX_FRAME_IMAGE_BYTES) throw new Error('PNG 超过 32 MiB');
              if (pngBytes + png.size > MAX_FRAME_IMAGES_BYTES) {
                  throw new Error('本帧 PNG 总量达到 16 GiB 上限');
              }
              await upload({
                action: 'input-image', jobId: job.id, targetBootId: this.bootId,
                frameIndex: String(frameIndex), inputOrdinal: String(inputOrdinal),
              }, png);
              pngBytes += png.size;
            } else reason = `输入纹理 ${item.format} 没有可导出的 PNG 预览`;
          } catch (error) { reason = `输入纹理 PNG 导出失败：${String(error)}`.slice(0, 500); }
        } else if (!reason) reason = 'Draw 输入纹理没有可读回的像素';
        let rawReason: string | undefined;
        let rawByteLength: number | undefined;
        if (item.rawPixels && item.rawBytesPerRow) {
          try {
            const raw = new Blob([item.rawPixels as BlobPart], { type: 'application/octet-stream' });
            item.rawPixels = undefined;
            await upload({
              action: 'input-raw', jobId: job.id, targetBootId: this.bootId,
              frameIndex: String(frameIndex), inputOrdinal: String(inputOrdinal),
              format: item.format, width: String(item.width), height: String(item.height),
              bytesPerRow: String(item.rawBytesPerRow),
            }, raw);
            rawByteLength = raw.size;
          } catch (error) { rawReason = `Draw 输入纹理原始像素导出失败：${String(error)}`.slice(0, 500); }
          finally { item.rawPixels = undefined; }
        } else rawReason = item.reason?.slice(0, 500) || 'Draw 输入纹理没有可回读的原始像素';
        inputs.push({
          inputOrdinal, passOrdinal: item.passOrdinal, bindingName: item.bindingName,
          textureId: item.textureId, viewId: item.viewId,
          groupSlot: item.groupSlot, binding: item.binding, contentVersion: item.contentVersion,
          mipLevel: item.mipLevel, arrayLayer: item.arrayLayer,
          width: item.width, height: item.height, format: item.format,
          ...(reason ? { reason } : {}),
          ...(rawByteLength === undefined ? { rawReason } : {
            rawBytesPerRow: item.rawBytesPerRow, rawByteLength,
          }),
        });
        if (pixels && rawByteLength !== undefined && item.rawBytesPerRow !== undefined) {
          uploadedInputs.set(pixels, { ordinal: inputOrdinal, rawByteLength,
            rawBytesPerRow: item.rawBytesPerRow, textureId: item.textureId,
            viewId: item.viewId, contentVersion: item.contentVersion,
            mipLevel: item.mipLevel, arrayLayer: item.arrayLayer,
            width: item.width, height: item.height, format: item.format });
        }
      }
      for (const [aspectOrdinal, item] of diagnostics.aspects.entries()) {
        if (!this.isCurrentJob(job)) return;
        if (uploadFailed) throw uploadError;
        let reason = item.reason?.slice(0, 500);
        if (item.rawPixels && item.rawBytesPerRow) {
          try {
            const pixels = visualizeCapturedAspectPixels(item);
            const png = await this.encodeFrameImage({ pixels,
              width: item.width, height: item.height }, false);
            if (png.size > MAX_FRAME_IMAGE_BYTES) throw new Error('PNG 超过 32 MiB');
            if (pngBytes + png.size > MAX_FRAME_IMAGES_BYTES) {
              throw new Error('本帧 PNG 总量达到 16 GiB 上限');
            }
            await upload({
              action: 'aspect-image', jobId: job.id, targetBootId: this.bootId,
              frameIndex: String(frameIndex), aspectOrdinal: String(aspectOrdinal),
            }, png);
            pngBytes += png.size;
          } catch (error) { reason = `深度/模板 PNG 导出失败：${String(error)}`.slice(0, 500); }
        } else if (!reason) reason = '此 Pass 的深度/模板没有可回读的像素';
        let rawReason: string | undefined;
        let rawByteLength: number | undefined;
        if (item.rawPixels && item.rawBytesPerRow) {
          try {
            const raw = new Blob([item.rawPixels as BlobPart], { type: 'application/octet-stream' });
            item.rawPixels = undefined;
            await upload({
              action: 'aspect-raw', jobId: job.id, targetBootId: this.bootId,
              frameIndex: String(frameIndex), aspectOrdinal: String(aspectOrdinal),
              format: item.rawFormat, width: String(item.width), height: String(item.height),
              bytesPerRow: String(item.rawBytesPerRow),
            }, raw);
            rawByteLength = raw.size;
          } catch (error) { rawReason = `深度/模板原始像素导出失败：${String(error)}`.slice(0, 500); }
          finally { item.rawPixels = undefined; }
        } else rawReason = item.reason?.slice(0, 500) || '深度/模板没有可回读的原始像素';
        aspects.push({
          aspectOrdinal, passOrdinal: item.passOrdinal, label: item.label,
          targetLabel: item.targetLabel, aspect: item.aspect, textureId: item.textureId,
          viewId: item.viewId, width: item.width, height: item.height,
          sourceFormat: item.sourceFormat, rawFormat: item.rawFormat,
          sampleCount: item.sampleCount, sampleIndex: item.sampleIndex,
          ...(reason ? { reason } : {}),
          ...(rawByteLength === undefined ? { rawReason } : {
            rawBytesPerRow: item.rawBytesPerRow, rawByteLength,
          }),
        });
      }
      for (const [bufferOrdinal, item] of diagnostics.buffers.entries()) {
        if (!this.isCurrentJob(job)) return;
        if (uploadFailed) throw uploadError;
        let rawByteLength: number | undefined;
        let rawReason: string | undefined;
        if (item.rawBytes?.byteLength) {
          try {
            const raw = new Blob([item.rawBytes as BlobPart], { type: 'application/octet-stream' });
            item.rawBytes = undefined;
            await upload({
              action: 'buffer-raw', jobId: job.id, targetBootId: this.bootId,
              frameIndex: String(frameIndex), bufferOrdinal: String(bufferOrdinal),
            }, raw);
            rawByteLength = raw.size;
          } catch (error) { rawReason = `Draw 前 Buffer 导出失败：${String(error)}`.slice(0, 500); }
          finally { item.rawBytes = undefined; }
        } else rawReason = item.reason?.slice(0, 500) || 'Draw 前 Buffer 没有可回读的字节';
        buffers.push({
          bufferOrdinal, passOrdinal: item.passOrdinal, role: item.role,
          ...(item.bindingName ? { bindingName: item.bindingName } : {}),
          ...(item.groupSlot === undefined ? {} : { groupSlot: item.groupSlot }),
          ...(item.binding === undefined ? {} : { binding: item.binding }),
          ...(item.streamName ? { streamName: item.streamName } : {}),
          ...(item.vertexSlot === undefined ? {} : { vertexSlot: item.vertexSlot }),
          ...(item.indexFormat ? { indexFormat: item.indexFormat } : {}),
          bufferId: item.bufferId, bufferLabel: item.bufferLabel, totalSize: item.totalSize,
          offset: item.offset, size: item.size, copiedOffset: item.copiedOffset,
          copiedSize: item.copiedSize, rangeScope: item.rangeScope,
          ...(item.reason ? { reason: item.reason.slice(0, 500) } : {}),
          ...(rawByteLength === undefined ? { rawReason } : { rawByteLength }),
        });
      }
      for (const [resourceOrdinal, item] of diagnostics.resourceTextures.entries()) {
        if (!this.isCurrentJob(job)) return;
        if (uploadFailed) throw uploadError;
        let reason = item.reason?.slice(0, 500);
        if (item.rawPixels && item.rawBytesPerRow) {
          try {
            const pixels = visualizeCapturedResourceTexture(item);
            const png = await this.encodeFrameImage({ pixels,
              width: item.width, height: item.height }, false);
            if (png.size > MAX_FRAME_IMAGE_BYTES) throw new Error('PNG 超过 32 MiB');
            if (resourcePngBytes + png.size > MAX_RESOURCE_IMAGES_BYTES) {
              throw new Error('本帧资源纹理 PNG 总量达到 2 GiB 上限');
            }
            await upload({
              action: 'resource-texture-image', jobId: job.id, targetBootId: this.bootId,
              frameIndex: String(frameIndex), resourceOrdinal: String(resourceOrdinal),
            }, png);
            resourcePngBytes += png.size;
          } catch (error) { reason = `资源纹理 PNG 导出失败：${String(error)}`.slice(0, 500); }
        } else if (!reason) reason = '资源纹理没有可回读的像素';
        let rawReason: string | undefined;
        let rawByteLength: number | undefined;
        if (item.rawPixels && item.rawBytesPerRow) {
          try {
            const raw = new Blob([item.rawPixels as BlobPart], { type: 'application/octet-stream' });
            item.rawPixels = undefined;
            await upload({
              action: 'resource-texture-raw', jobId: job.id, targetBootId: this.bootId,
              frameIndex: String(frameIndex), resourceOrdinal: String(resourceOrdinal),
              format: item.rawFormat, width: String(item.width), height: String(item.height),
              bytesPerRow: String(item.rawBytesPerRow),
            }, raw);
            rawByteLength = raw.size;
          } catch (error) { rawReason = `资源纹理原始像素导出失败：${String(error)}`.slice(0, 500); }
          finally { item.rawPixels = undefined; }
        } else rawReason = item.reason?.slice(0, 500) || '资源纹理没有可回读的原始像素';
        resourceTextures.push({
          resourceOrdinal, textureOrdinal: item.textureOrdinal, textureId: item.textureId,
          label: item.label, width: item.width, height: item.height,
          sourceFormat: item.sourceFormat, rawFormat: item.rawFormat,
          mipLevel: item.mipLevel, arrayLayer: item.arrayLayer,
          aspect: item.aspect, sampleCount: item.sampleCount,
          captureMoment: item.captureMoment, ...(reason ? { reason } : {}),
          ...(rawByteLength === undefined ? { rawReason } : {
            rawBytesPerRow: item.rawBytesPerRow, rawByteLength,
          }),
        });
      }
      for (const [resourceOrdinal, item] of diagnostics.resourceBuffers.entries()) {
        if (!this.isCurrentJob(job)) return;
        if (uploadFailed) throw uploadError;
        let rawByteLength: number | undefined;
        let rawReason: string | undefined;
        if (item.rawBytes?.byteLength) {
          try {
            const raw = new Blob([item.rawBytes as BlobPart], { type: 'application/octet-stream' });
            item.rawBytes = undefined;
            await upload({
              action: 'resource-buffer-raw', jobId: job.id, targetBootId: this.bootId,
              frameIndex: String(frameIndex), resourceOrdinal: String(resourceOrdinal),
            }, raw);
            rawByteLength = raw.size;
          } catch (error) { rawReason = `资源 Buffer 导出失败：${String(error)}`.slice(0, 500); }
          finally { item.rawBytes = undefined; }
        } else rawReason = item.reason?.slice(0, 500) || '资源 Buffer 没有可回读的字节';
        resourceBuffers.push({
          resourceOrdinal, bufferId: item.bufferId, label: item.label,
          totalSize: item.totalSize, copiedOffset: item.copiedOffset,
          copiedSize: item.copiedSize, captureMoment: item.captureMoment,
          ...(item.reason ? { reason: item.reason.slice(0, 500) } : {}),
          ...(rawByteLength === undefined ? { rawReason } : { rawByteLength }),
        });
      }
      if (!this.isCurrentJob(job)) return;
      await Promise.all(pendingUploads);
      if (uploadFailed) throw uploadError;
      await api('POST', {}, { action: 'diagnostics', jobId: job.id, targetBootId: this.bootId,
        frameIndex, passes, inputs, aspects, buffers,
        resourceInventory: diagnostics.resourceInventory, resourceTextures, resourceBuffers,
        gpuPasses: diagnostics.gpuPasses,
        gpuProfilerStatus: diagnostics.gpuProfilerStatus,
        ...(diagnostics.warning ? { warning: diagnostics.warning } : {}) });
    } finally {
      await Promise.all(pendingUploads);
      for (const item of [...diagnostics.passes, ...diagnostics.inputs, ...diagnostics.aspects]) item.rawPixels = undefined;
      for (const item of diagnostics.buffers) item.rawBytes = undefined;
      for (const item of diagnostics.resourceTextures) item.rawPixels = undefined;
      for (const item of diagnostics.resourceBuffers) item.rawBytes = undefined;
    }
  }

  private leaveActiveJob(): void {
    const hadJob = this.activeJob !== null;
    if (this.activeJob) this.finishedLocallyJobId = this.activeJob.id;
    if (this.activeJob && this.frameImages?.jobId === this.activeJob.id) {
      this.frameImages.cancelled = true;
      this.frameImages = null;
    }
    if (this.activeJob && this.frameDiagnostics?.jobId === this.activeJob.id) {
      this.frameDiagnostics.cancelled = true;
      this.frameDiagnostics.active?.cancel();
      this.frameDiagnostics = null;
    }
    this.activeJob = null;
    this.setFrameHook(null);
    this.releaseFrameLoop();
    if (hadJob && !this.exportInFlight) this.discardPartialCapture();
  }

  private releaseFrameLoop(expected?: (() => void) | null): void {
    if (expected !== undefined && this.resumeFrameLoop !== expected) return;
    const resume = this.resumeFrameLoop;
    this.resumeFrameLoop = null;
    resume?.();
  }

  private holdFrameLoop(): void {
    if (!this.resumeFrameLoop) this.resumeFrameLoop = this.suspendFrameLoop?.() ?? null;
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
    if (this.isCurrentJob(job)) {
      this.finishedLocallyJobId = job.id;
      this.releaseFrameLoop();
    }
    if (this.activeJob?.id === job.id) this.leaveActiveJob();
    if (this.frameDiagnostics?.jobId === job.id) {
      this.frameDiagnostics.cancelled = true;
      this.frameDiagnostics.active?.cancel();
      this.releaseFrameLoop();
    }
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
    if (old?.id === job.id) {
      const progress = { pending: 0, capturing: 1, uploading: 2, completed: 3, failed: 3, stopped: 3 };
      if (progress[job.state] < progress[old.state]) return;
      if (['failed', 'stopped'].includes(old.state) && job.state === 'completed') return;
    }
    this.latestJob = job;
  }
}
