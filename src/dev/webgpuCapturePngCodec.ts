import {
  visualizeCapturedAspectPixels, visualizeCapturedInputPixels, visualizeCapturedPassPixels,
  visualizeCapturedResourceTexture,
  type CapturedAspectPixels, type CapturedInputPixels, type CapturedPassPixels,
  type CapturedResourceTexture,
} from './webgpuFrameDiagnostics';

export type WebGpuCapturePngTask = (
  | { kind: 'rgba'; pixels: Uint8Array | Uint8ClampedArray; width: number; height: number }
  | { kind: 'pass'; capture: CapturedPassPixels }
  | { kind: 'input'; capture: CapturedInputPixels }
  | { kind: 'aspect'; capture: CapturedAspectPixels }
  | { kind: 'resource'; capture: CapturedResourceTexture }
) & { unpremultiply?: boolean };

export type WebGpuCapturePngWorkerRequest = { id: number; task: WebGpuCapturePngTask };
export type WebGpuCapturePngWorkerResponse =
  | { type: 'ready'; supported: boolean; reason?: string }
  | { type: 'result'; id: number; blob: Blob }
  | { type: 'error'; id: number; message: string };

export function capturePngTaskSize(task: WebGpuCapturePngTask): {
  width: number; height: number; rawBytes: number; workingBytes: number;
} {
  const { width, height } = task.kind === 'rgba' ? task : task.capture;
  const rgbaBytes = width * height * 4;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      !Number.isSafeInteger(rgbaBytes)) throw new Error('GPU 回读图像尺寸无效');
  if (rgbaBytes > 128 * 1024 * 1024) {
    throw new Error('PNG 预览超过 128 MiB 解码上限，原始 GPU 字节仍可导出');
  }
  let rawBytes: number;
  if (task.kind === 'rgba') {
    rawBytes = task.pixels.byteLength;
    if (rawBytes !== rgbaBytes) throw new Error('GPU 回读尺寸与 RGBA8 数据不匹配');
  } else {
    const { rawPixels, rawBytesPerRow } = task.capture;
    if (!rawPixels?.byteLength || !rawBytesPerRow || !Number.isSafeInteger(rawBytesPerRow) ||
        rawBytesPerRow < 1 || rawPixels.byteLength <= (height - 1) * rawBytesPerRow) {
      throw new Error('纹理没有有效的原始像素或行步长');
    }
    rawBytes = rawPixels.byteLength;
  }
  // A transferred raw copy, decoded RGBA and the canvas backing store. The original
  // raw bytes belong to capture/upload and are never transferred or modified here.
  return { width, height, rawBytes, workingBytes: rawBytes + rgbaBytes * 2 };
}

export function capturePngAbortError(): Error {
  const error = new Error('PNG 编码已取消');
  error.name = 'AbortError';
  return error;
}

/** Shared codec keeps worker and unsupported-browser fallback pixel semantics identical. */
export async function encodeCapturePng(task: WebGpuCapturePngTask, options: {
  offscreen: boolean;
  ownsPixels?: boolean;
  signal?: AbortSignal;
}): Promise<Blob> {
  const { width, height } = capturePngTaskSize(task);
  if (options.signal?.aborted) throw capturePngAbortError();
  let rgba: Uint8ClampedArray<ArrayBuffer>;
  switch (task.kind) {
    case 'rgba':
      rgba = options.ownsPixels && task.pixels.buffer instanceof ArrayBuffer
        ? new Uint8ClampedArray(task.pixels.buffer, task.pixels.byteOffset, task.pixels.byteLength)
        : new Uint8ClampedArray(task.pixels);
      break;
    // These existing functions are the authority for BGRA, float/HDR, depth and stencil.
    case 'pass': rgba = visualizeCapturedPassPixels(task.capture) as Uint8ClampedArray<ArrayBuffer>; break;
    case 'input': rgba = visualizeCapturedInputPixels(task.capture) as Uint8ClampedArray<ArrayBuffer>; break;
    case 'aspect': rgba = visualizeCapturedAspectPixels(task.capture) as Uint8ClampedArray<ArrayBuffer>; break;
    case 'resource': rgba = visualizeCapturedResourceTexture(task.capture) as Uint8ClampedArray<ArrayBuffer>; break;
  }
  if (task.unpremultiply ?? task.kind === 'rgba') {
    // The frame canvas is premultiplied; ImageData expects straight alpha. Raw
    // resource previews opt in explicitly, exactly as in the existing capture client.
    for (let i = 0; i < rgba.length; i += 4) {
      const alpha = rgba[i + 3];
      if (alpha > 0 && alpha < 255) {
        rgba[i] = Math.min(255, Math.round(rgba[i] * 255 / alpha));
        rgba[i + 1] = Math.min(255, Math.round(rgba[i + 1] * 255 / alpha));
        rgba[i + 2] = Math.min(255, Math.round(rgba[i + 2] * 255 / alpha));
      }
    }
  }

  if (options.offscreen) {
    const canvas = new OffscreenCanvas(width, height);
    try {
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Worker 无法创建 PNG 编码画布');
      context.putImageData(new ImageData(rgba, width, height), 0, 0);
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      if (!blob.size || blob.type !== 'image/png') throw new Error('浏览器未生成有效 PNG');
      return blob;
    } finally {
      canvas.width = canvas.height = 1;
    }
  }

  // Only used when Worker/OffscreenCanvas is unavailable; the caller exposes this
  // backend to the UI instead of presenting a main-thread encode as parallel work.
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    canvas.width = canvas.height = 1;
    throw new Error('浏览器无法创建 PNG 编码画布');
  }
  const imageData = typeof ImageData !== 'undefined'
    ? new ImageData(rgba, width, height) : context.createImageData(width, height);
  if (imageData.data !== rgba) imageData.data.set(rgba);
  context.putImageData(imageData, 0, 0);
  return new Promise<Blob>((resolve, reject) => {
    let settled = false;
    const finish = (blob?: Blob | null, error?: unknown): void => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', onAbort);
      canvas.width = canvas.height = 1;
      if (error) reject(error);
      else if (!blob?.size || blob.type !== 'image/png') reject(new Error('浏览器未生成有效 PNG'));
      else resolve(blob);
    };
    const onAbort = (): void => finish(undefined, capturePngAbortError());
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) return onAbort();
    try { canvas.toBlob((blob) => finish(blob), 'image/png'); }
    catch (error) { finish(undefined, error); }
  });
}
