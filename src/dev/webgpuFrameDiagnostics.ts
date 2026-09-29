import type { RhiDevice, RhiGpuSubmissionProfile, RhiRenderPassEndCapture } from '../rendering/rhi/RhiDevice';

const MAX_RAW_BYTES = 256 * 1024 * 1024;
const MAX_PASS_RECORDS = 512;
const MAP_TIMEOUT_MS = 30_000;
const PROFILE_TIMEOUT_MS = 10_000;

export interface CapturedPassPixels {
  passOrdinal: number;
  label: string;
  targetLabel: string;
  colorIndex: number;
  width: number;
  height: number;
  format: string;
  reason?: string;
  pixels?: Uint8ClampedArray;
}

export interface CapturedGpuPass {
  ordinal: number;
  kind: 'render' | 'compute';
  label: string;
  durationMs: number;
}

export interface CapturedFrameDiagnostics {
  passes: CapturedPassPixels[];
  gpuPasses: CapturedGpuPass[];
  gpuProfilerStatus: { state: 'enabled' | 'unsupported' | 'disabled'; reason?: string };
  warning?: string;
}

interface PendingPass {
  info: CapturedPassPixels;
  buffer?: GPUBuffer;
  bytesPerRow?: number;
}

function bytesPerPixel(format: string): number {
  if (format === 'rgba8unorm' || format === 'rgba8unorm-srgb' ||
      format === 'bgra8unorm' || format === 'bgra8unorm-srgb') return 4;
  if (format === 'r8unorm') return 1;
  if (format === 'rgba16float') return 8;
  return 0;
}

function halfFloat(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >>> 10) & 31;
  const fraction = bits & 1023;
  if (exponent === 0) return sign * 2 ** -14 * fraction / 1024;
  if (exponent === 31) return fraction ? NaN : sign * Infinity;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

function visualize(raw: Uint8Array, width: number, height: number, bytesPerRow: number,
    format: string): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4);
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dst = (y * width + x) * 4;
      const src = y * bytesPerRow + x * bytesPerPixel(format);
      if (format === 'rgba16float') {
        // Visualize HDR values for PNG; the Inspector's raw payload remains the numeric source.
        for (let channel = 0; channel < 3; channel++) {
          const value = halfFloat(view.getUint16(src + channel * 2, true));
          const mapped = Number.isFinite(value) ? Math.max(0, value) / (1 + Math.max(0, value)) : 0;
          rgba[dst + channel] = Math.round(Math.max(0, Math.min(1, mapped)) * 255);
        }
        const alpha = halfFloat(view.getUint16(src + 6, true));
        rgba[dst + 3] = Number.isFinite(alpha) ? Math.round(Math.max(0, Math.min(1, alpha)) * 255) : 0;
      } else if (format === 'r8unorm') {
        rgba[dst] = rgba[dst + 1] = rgba[dst + 2] = raw[src];
        rgba[dst + 3] = 255;
      } else if (format.startsWith('bgra8')) {
        rgba[dst] = raw[src + 2];
        rgba[dst + 1] = raw[src + 1];
        rgba[dst + 2] = raw[src];
        rgba[dst + 3] = raw[src + 3];
      } else {
        rgba.set(raw.subarray(src, src + 4), dst);
      }
    }
  }
  return rgba;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: number | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => reject(new Error(message)), ms);
    })]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}

/** One-shot pass-end snapshots and real timestamp queries for a single captured frame. */
export function captureFrameDiagnostics(rhi: RhiDevice): {
  finish: () => Promise<CapturedFrameDiagnostics>;
  cancel: () => void;
} {
  const device = rhi.native.device;
  const pending: PendingPass[] = [];
  let allocated = 0;
  let omittedPasses = 0;
  let finished = false;
  let cancelled = false;
  let expectedFrame: number | null = null;
  let expectedLabel = '';
  let submittedResolve!: () => void;
  let abortedReject!: (reason: Error) => void;
  const submitted = new Promise<void>((resolve, reject) => {
    submittedResolve = resolve;
    abortedReject = reject;
  });
  void submitted.catch(() => {});

  const status = rhi.gpuProfiler?.status() ?? { state: 'unsupported' as const,
    reason: 'RHI 没有 GPU timestamp-query 诊断能力' };
  const restoreProfiler = status.state === 'disabled';
  let profileResolve!: (value: RhiGpuSubmissionProfile) => void;
  const profilePromise = new Promise<RhiGpuSubmissionProfile>(resolve => { profileResolve = resolve; });
  const offProfile = rhi.gpuProfiler?.onResult(profile => {
    if (profile.kind === 'frame' && expectedFrame !== null && profile.frame === expectedFrame &&
        (!expectedLabel || profile.label === expectedLabel)) profileResolve(profile);
  });
  if (restoreProfiler) rhi.gpuProfiler?.setEnabled(true);

  const onPassEnd = (event: RhiRenderPassEndCapture): void => {
    expectedFrame = event.frame;
    expectedLabel = event.submissionLabel;
    if (event.colorIndex === null) return;
    if (pending.length >= MAX_PASS_RECORDS || event.passOrdinal >= MAX_PASS_RECORDS) {
      omittedPasses++;
      return;
    }
    const format = event.format ?? '';
    const info: CapturedPassPixels = {
      passOrdinal: event.passOrdinal, label: event.label, targetLabel: event.targetLabel,
      colorIndex: event.colorIndex, width: event.width, height: event.height, format,
    };
    const record: PendingPass = { info };
    pending.push(record);
    const bpp = bytesPerPixel(format);
    if (!event.copyable || !event.texture) info.reason = event.reason || '目标纹理不支持回读';
    else if (!bpp) info.reason = `暂不支持 ${format || '未知'} 格式的颜色输出 PNG`;
    else if (!Number.isSafeInteger(event.width * event.height * bpp) || event.width < 1 || event.height < 1) {
      info.reason = '颜色输出尺寸无效';
    } else {
      const bytesPerRow = Math.ceil(event.width * bpp / 256) * 256;
      const size = bytesPerRow * event.height;
      if (!Number.isSafeInteger(size) || size > device.limits.maxBufferSize ||
          size > MAX_RAW_BYTES - allocated) {
        info.reason = '本帧中间画面回读达到 256 MiB 上限';
      } else {
        let buffer: GPUBuffer | undefined;
        try {
          buffer = device.createBuffer({ label: `frame-debug pass ${event.passOrdinal} color ${event.colorIndex}`,
            size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
          event.encoder.copyTextureToBuffer({ texture: event.texture },
            { buffer, bytesPerRow, rowsPerImage: event.height },
            { width: event.width, height: event.height, depthOrArrayLayers: 1 });
          record.buffer = buffer;
          record.bytesPerRow = bytesPerRow;
          allocated += size;
        } catch (error) {
          buffer?.destroy();
          info.reason = `GPU 中间画面拷贝失败：${String(error)}`;
        }
      }
    }
  };

  const stopHook = rhi.frameDebugCapture?.captureNextSubmission({
    kind: 'frame', onPassEnd,
    onSubmitted: () => submittedResolve(),
    onAborted: () => abortedReject(new Error('GPU 提交中止')),
  });
  if (!stopHook) submittedResolve();

  const cancel = (): void => {
    if (cancelled) return;
    cancelled = true;
    stopHook?.();
    offProfile?.();
    if (restoreProfiler) rhi.gpuProfiler?.setEnabled(false);
    for (const record of pending) {
      record.buffer?.destroy();
      record.buffer = undefined;
    }
    submittedResolve();
  };

  const finish = async (): Promise<CapturedFrameDiagnostics> => {
    if (finished) throw new Error('逐 pass 诊断结果只能读取一次');
    finished = true;
    let gpuProfilerStatus: CapturedFrameDiagnostics['gpuProfilerStatus'] = status;
    let gpuPasses: CapturedGpuPass[] = [];
    try {
      await withTimeout(submitted, MAP_TIMEOUT_MS, 'GPU 帧提交超时');
      if (!cancelled) {
        for (const record of pending) {
          const buffer = record.buffer;
          if (!buffer || record.info.reason) continue;
          try {
            await withTimeout(buffer.mapAsync(GPUMapMode.READ), MAP_TIMEOUT_MS, 'GPU 画面回读超时');
            const raw = new Uint8Array(buffer.getMappedRange());
            record.info.pixels = visualize(raw, record.info.width, record.info.height,
              record.bytesPerRow!, record.info.format);
          } catch (error) {
            record.info.reason = `GPU 画面回读失败：${String(error)}`;
          } finally {
            try { buffer.unmap(); } catch { /* A failed map has no mapping to release. */ }
            buffer.destroy();
            record.buffer = undefined;
          }
        }
      }
      if (status.state !== 'unsupported' && !cancelled) {
        try {
          const profile = await withTimeout(profilePromise, PROFILE_TIMEOUT_MS, 'GPU timestamp-query 无结果');
          gpuPasses = profile.passes.slice(0, MAX_PASS_RECORDS).map((pass, ordinal) => ({
            ordinal, kind: pass.kind, label: pass.label, durationMs: pass.gpuMs,
          }));
          if (profile.passes.length > MAX_PASS_RECORDS) omittedPasses += profile.passes.length - MAX_PASS_RECORDS;
          gpuProfilerStatus = { state: 'enabled' };
        } catch (error) {
          gpuProfilerStatus = { state: 'unsupported', reason: String(error) };
        }
      }
    } finally {
      stopHook?.();
      offProfile?.();
      if (restoreProfiler) rhi.gpuProfiler?.setEnabled(false);
      for (const record of pending) {
        record.buffer?.destroy();
        record.buffer = undefined;
      }
    }
    return { passes: pending.map(record => record.info), gpuPasses, gpuProfilerStatus,
      ...(omittedPasses ? { warning: `${omittedPasses} 个诊断记录超过 512 个 Pass 上限` } : {}) };
  };
  return { finish, cancel };
}
