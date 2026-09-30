import type { RhiDepthStencilAspectCapture, RhiDevice, RhiDrawBufferCapture, RhiDrawInputCapture,
  RhiFrameResourceBufferCapture, RhiFrameResourceInventory, RhiFrameResourceTextureCapture,
  RhiGpuSubmissionProfile, RhiRenderPassEndCapture } from '../rendering/rhi/RhiDevice';

const MAX_RAW_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_PASS_RECORDS = 512;
const MAX_INPUT_RECORDS = 1024;
const MAX_INPUT_RAW_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ASPECT_RECORDS = 1024;
const MAX_ASPECT_RAW_BYTES = 512 * 1024 * 1024;
const MAX_BUFFER_RECORDS = 8192;
const MAX_BUFFER_ITEM_BYTES = 16 * 1024 * 1024;
const MAX_BUFFER_RAW_BYTES = 256 * 1024 * 1024;
const MAX_RESOURCE_TEXTURE_RECORDS = 8192;
const MAX_RESOURCE_BUFFER_RECORDS = 4096;
const MAX_RESOURCE_TEXTURE_RAW_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_RESOURCE_BUFFER_RAW_BYTES = 1024 * 1024 * 1024;
const MAX_PNG_RGBA_BYTES = 128 * 1024 * 1024;
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
  /** 原始 GPU copyTextureToBuffer 字节；保留每行 256 字节对齐和纹理原生通道顺序。 */
  rawPixels?: Uint8Array;
  rawBytesPerRow?: number;
}

/** 纹理在选中 Draw 执行前、同一个原生命令编码器上实际回读的状态。 */
export interface CapturedInputPixels {
  passOrdinal: number;
  bindingName: string;
  groupSlot: number;
  binding: number;
  textureId: number | null;
  viewId: number | null;
  contentVersion: number;
  mipLevel: number;
  arrayLayer: number;
  width: number;
  height: number;
  format: string;
  reason?: string;
  rawPixels?: Uint8Array;
  rawBytesPerRow?: number;
}

/** Pass end 时读取的深度 / 模板；depth 原始数据是 f32，MSAA 只读 sample 0。 */
export interface CapturedAspectPixels {
  passOrdinal: number;
  label: string;
  targetLabel: string;
  aspect: 'depth' | 'stencil';
  textureId: number | null;
  viewId: number | null;
  width: number;
  height: number;
  sourceFormat: string;
  rawFormat: 'r32float' | 'stencil8';
  sampleCount: number;
  sampleIndex: number | null;
  reason?: string;
  rawPixels?: Uint8Array;
  rawBytesPerRow?: number;
}

/** 同一原生命令编码器中、Draw 开始前的实际 Buffer 字节。 */
export interface CapturedDrawBuffer {
  passOrdinal: number;
  role: RhiDrawBufferCapture['role'];
  bindingName?: string;
  groupSlot?: number;
  binding?: number;
  streamName?: string;
  vertexSlot?: number;
  indexFormat?: 'uint16' | 'uint32';
  bufferId: number | null;
  bufferLabel: string;
  totalSize: number;
  /** Shader 绑定 / Draw 索引实际使用的请求范围。 */
  offset: number;
  size: number;
  /** copyBufferToBuffer 要求 4 字节对齐；rawBytes 精确对应这个范围。 */
  copiedOffset: number;
  copiedSize: number;
  rangeScope: RhiDrawBufferCapture['rangeScope'];
  reason?: string;
  rawBytes?: Uint8Array;
}

/** One live RHI texture mip/aspect, snapped after the frame's render and compute work. */
export interface CapturedResourceTexture {
  textureOrdinal: number;
  textureId: number | null;
  label: string;
  width: number;
  height: number;
  sourceFormat: string;
  rawFormat: string;
  mipLevel: number;
  arrayLayer: number;
  aspect: 'color' | 'depth' | 'stencil';
  sampleCount: number;
  captureMoment: 'frame-end';
  reason?: string;
  rawPixels?: Uint8Array;
  rawBytesPerRow?: number;
}

export interface CapturedResourceBuffer {
  bufferId: number | null;
  label: string;
  totalSize: number;
  copiedOffset: 0;
  copiedSize: number;
  captureMoment: 'frame-end';
  reason?: string;
  rawBytes?: Uint8Array;
}

export interface CapturedGpuPass {
  ordinal: number;
  kind: 'render' | 'compute';
  label: string;
  durationMs: number;
}

export interface CapturedFrameDiagnostics {
  passes: CapturedPassPixels[];
  inputs: CapturedInputPixels[];
  aspects: CapturedAspectPixels[];
  buffers: CapturedDrawBuffer[];
  resourceInventory: RhiFrameResourceInventory;
  resourceTextures: CapturedResourceTexture[];
  resourceBuffers: CapturedResourceBuffer[];
  gpuPasses: CapturedGpuPass[];
  gpuProfilerStatus: { state: 'enabled' | 'unsupported' | 'disabled'; reason?: string };
  warning?: string;
}

interface PendingPass {
  info: CapturedPassPixels;
  buffer?: GPUBuffer;
  bytesPerRow?: number;
}

interface PendingInput {
  info: CapturedInputPixels;
  buffer?: GPUBuffer;
  bytesPerRow?: number;
  sharedFrom?: PendingInput;
}

interface PendingAspect {
  info: CapturedAspectPixels;
  buffer?: GPUBuffer;
  bytesPerRow?: number;
}

interface PendingDrawBuffer {
  info: CapturedDrawBuffer;
  buffer?: GPUBuffer;
}

interface PendingResourceTexture {
  info: CapturedResourceTexture;
  buffer?: GPUBuffer;
  bytesPerRow?: number;
}

interface PendingResourceBuffer {
  info: CapturedResourceBuffer;
  buffer?: GPUBuffer;
}

function bytesPerPixel(format: string): number {
  if (format === 'rgba8unorm' || format === 'rgba8unorm-srgb' ||
      format === 'bgra8unorm' || format === 'bgra8unorm-srgb' || format === 'r32float' ||
      format === 'r32uint' || format === 'rg16float') return 4;
  if (format === 'r8unorm') return 1;
  if (format === 'rg8unorm' || format === 'r16float') return 2;
  if (format === 'rgba16float' || format === 'rg32float') return 8;
  if (format === 'rgba32float' || format === 'rgba32uint') return 16;
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
      if (format === 'rgba16float' || format === 'rgba32float' || format === 'rg16float' ||
          format === 'rg32float' || format === 'r16float' || format === 'r32float') {
        // Visualize HDR values for PNG; the Inspector's raw payload remains the numeric source.
        const channels = format.startsWith('rgba') ? 4 : format.startsWith('rg') ? 2 : 1;
        const half = format.includes('16');
        for (let channel = 0; channel < Math.min(channels, 3); channel++) {
          const value = half ? halfFloat(view.getUint16(src + channel * 2, true)) :
            view.getFloat32(src + channel * 4, true);
          const mapped = Number.isFinite(value) ? Math.max(0, value) / (1 + Math.max(0, value)) : 0;
          rgba[dst + channel] = Math.round(Math.max(0, Math.min(1, mapped)) * 255);
        }
        if (channels === 1) rgba[dst + 1] = rgba[dst + 2] = rgba[dst];
        if (channels === 2) rgba[dst + 2] = 0;
        if (channels === 4) {
          const alpha = half ? halfFloat(view.getUint16(src + 6, true)) : view.getFloat32(src + 12, true);
          rgba[dst + 3] = Number.isFinite(alpha) ? Math.round(Math.max(0, Math.min(1, alpha)) * 255) : 0;
        } else rgba[dst + 3] = 255;
      } else if (format === 'r8unorm') {
        rgba[dst] = rgba[dst + 1] = rgba[dst + 2] = raw[src];
        rgba[dst + 3] = 255;
      } else if (format === 'rg8unorm') {
        rgba[dst] = raw[src]; rgba[dst + 1] = raw[src + 1];
        rgba[dst + 2] = 0; rgba[dst + 3] = 255;
      } else if (format === 'r32uint' || format === 'rgba32uint') {
        const channels = format === 'r32uint' ? 1 : 4;
        for (let channel = 0; channel < Math.min(channels, 3); channel++) {
          rgba[dst + channel] = Math.min(255, view.getUint32(src + channel * 4, true));
        }
        if (channels === 1) rgba[dst + 1] = rgba[dst + 2] = rgba[dst];
        rgba[dst + 3] = channels === 4 ? Math.min(255, view.getUint32(src + 12, true)) : 255;
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

/** Decode one Pass for PNG only when it is about to be uploaded. Raw native bytes remain authoritative. */
export function visualizeCapturedPassPixels(pass: CapturedPassPixels): Uint8ClampedArray {
  if (!pass.rawPixels || !pass.rawBytesPerRow) throw new Error('Pass 没有可回读的原始像素');
  if (pass.width * pass.height * 4 > MAX_PNG_RGBA_BYTES) {
    throw new Error('Pass PNG 预览超过 128 MiB 解码上限，原始 RT 字节仍会导出');
  }
  return visualize(pass.rawPixels, pass.width, pass.height, pass.rawBytesPerRow, pass.format);
}

/** Decode a real pre-Draw input snapshot for PNG; raw native bytes remain authoritative. */
export function visualizeCapturedInputPixels(input: CapturedInputPixels): Uint8ClampedArray {
  if (!input.rawPixels || !input.rawBytesPerRow) throw new Error('Draw 输入没有可回读的原始像素');
  if (input.width * input.height * 4 > MAX_PNG_RGBA_BYTES) {
    throw new Error('Draw 输入 PNG 预览超过 128 MiB 解码上限，原始纹理字节仍会导出');
  }
  return visualize(input.rawPixels, input.width, input.height, input.rawBytesPerRow, input.format);
}

/** PNG 仅作可视化；深度的精确 f32 / 模板的精确 u8 仍以 raw 文件为准。 */
export function visualizeCapturedAspectPixels(aspect: CapturedAspectPixels): Uint8ClampedArray {
  if (!aspect.rawPixels || !aspect.rawBytesPerRow) throw new Error('深度 / 模板没有可回读的原始像素');
  if (aspect.width * aspect.height * 4 > MAX_PNG_RGBA_BYTES) {
    throw new Error('深度 / 模板 PNG 预览超过 128 MiB 解码上限，原始字节仍会导出');
  }
  const out = new Uint8ClampedArray(aspect.width * aspect.height * 4);
  const raw = aspect.rawPixels;
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  for (let y = 0; y < aspect.height; y++) {
    for (let x = 0; x < aspect.width; x++) {
      const offset = y * aspect.rawBytesPerRow + x * (aspect.aspect === 'depth' ? 4 : 1);
      const value = aspect.aspect === 'depth'
        ? Math.round(Math.max(0, Math.min(1, view.getFloat32(offset, true))) * 255)
        : raw[offset];
      const dst = (y * aspect.width + x) * 4;
      out[dst] = out[dst + 1] = out[dst + 2] = value;
      out[dst + 3] = 255;
    }
  }
  return out;
}

export function visualizeCapturedResourceTexture(texture: CapturedResourceTexture): Uint8ClampedArray {
  if (!texture.rawPixels || !texture.rawBytesPerRow) throw new Error('资源纹理没有可回读的像素');
  if (texture.width * texture.height * 4 > MAX_PNG_RGBA_BYTES) {
    throw new Error('资源纹理 PNG 预览超过 128 MiB 解码上限，原始字节仍会导出');
  }
  if (texture.aspect === 'color') {
    return visualize(texture.rawPixels, texture.width, texture.height,
      texture.rawBytesPerRow, texture.rawFormat);
  }
  return visualizeCapturedAspectPixels({
    passOrdinal: -1, label: texture.label, targetLabel: texture.label,
    aspect: texture.aspect, textureId: texture.textureId, viewId: null,
    width: texture.width, height: texture.height, sourceFormat: texture.sourceFormat,
    rawFormat: texture.aspect === 'depth' ? 'r32float' : 'stencil8',
    sampleCount: texture.sampleCount, sampleIndex: null,
    rawPixels: texture.rawPixels, rawBytesPerRow: texture.rawBytesPerRow,
  });
}

const DEPTH_READBACK_WGSL = `
@group(0) @binding(0) var sourceDepth: texture_depth_2d;
@group(0) @binding(1) var<storage, read_write> values: array<f32>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let size = textureDimensions(sourceDepth);
  if (gid.x >= size.x || gid.y >= size.y) { return; }
  values[gid.y * size.x + gid.x] = textureLoad(sourceDepth, vec2<i32>(gid.xy), 0);
}`;

const MSAA_DEPTH_READBACK_WGSL = `
@group(0) @binding(0) var sourceDepth: texture_depth_multisampled_2d;
@group(0) @binding(1) var<storage, read_write> values: array<f32>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let size = textureDimensions(sourceDepth);
  if (gid.x >= size.x || gid.y >= size.y) { return; }
  values[gid.y * size.x + gid.x] = textureLoad(sourceDepth, vec2<i32>(gid.xy), 0);
}`;

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
export function captureFrameDiagnostics(rhi: RhiDevice, recordingControl?: {
  disableRecording(): void;
  enableRecording(): void;
}): {
  finish: () => Promise<CapturedFrameDiagnostics>;
  cancel: () => void;
} {
  const device = rhi.native.device;
  const pending: PendingPass[] = [];
  const pendingInputs: PendingInput[] = [];
  const inputReadbackCache = new WeakMap<GPUTexture, Map<string, PendingInput>>();
  const pendingAspects: PendingAspect[] = [];
  const pendingBuffers: PendingDrawBuffer[] = [];
  const pendingResourceTextures: PendingResourceTexture[] = [];
  const pendingResourceBuffers: PendingResourceBuffer[] = [];
  let resourceInventory: RhiFrameResourceInventory | null = null;
  // 顺序编码：每次 depth compute 紧跟 copy 到独立 staging，后续 pass 可复用 storage 缓冲。
  const depthScratchBuffers: GPUBuffer[] = [];
  let depthScratch: GPUBuffer | null = null;
  let depthScratchSize = 0;
  let allocated = 0;
  let inputAllocated = 0;
  let aspectAllocated = 0;
  let bufferAllocated = 0;
  let resourceTextureAllocated = 0;
  let resourceBufferAllocated = 0;
  let omittedReadbacks = 0;
  let omittedInputs = 0;
  let omittedAspects = 0;
  let omittedBuffers = 0;
  let omittedTimings = 0;
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

  let depthPipeline: GPUComputePipeline | undefined;
  let msaaDepthPipeline: GPUComputePipeline | undefined;
  const pipelineForDepth = (sampleCount: number): GPUComputePipeline => {
    if (sampleCount > 1) {
      return (msaaDepthPipeline ??= device.createComputePipeline({
        label: 'frame-debug MSAA depth sample 0', layout: 'auto',
        compute: { module: device.createShaderModule({ code: MSAA_DEPTH_READBACK_WGSL }), entryPoint: 'main' },
      }));
    }
    return (depthPipeline ??= device.createComputePipeline({
      label: 'frame-debug depth', layout: 'auto',
      compute: { module: device.createShaderModule({ code: DEPTH_READBACK_WGSL }), entryPoint: 'main' },
    }));
  };

  const onPassEnd = (event: RhiRenderPassEndCapture): void => {
    expectedFrame = event.frame;
    expectedLabel = event.submissionLabel;
    if (event.colorIndex === null) return;
    if (pending.length >= MAX_PASS_RECORDS || event.passOrdinal >= MAX_PASS_RECORDS) {
      omittedReadbacks++;
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
      if (!Number.isSafeInteger(size) || size > device.limits.maxBufferSize) {
        info.reason = '此颜色输出超过 GPU 单缓冲回读上限';
      } else if (size > MAX_RAW_BYTES - allocated) {
        info.reason = '本帧中间画面回读达到 2 GiB 上限';
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

  const onDrawInput = (event: RhiDrawInputCapture): void => {
    if (pendingInputs.length >= MAX_INPUT_RECORDS) {
      omittedInputs++;
      return;
    }
    const info: CapturedInputPixels = {
      passOrdinal: event.passOrdinal, bindingName: event.bindingName,
      groupSlot: event.groupSlot, binding: event.binding,
      textureId: event.textureId, viewId: event.viewId, contentVersion: event.contentVersion,
      mipLevel: event.mipLevel,
      arrayLayer: event.arrayLayer, width: event.width, height: event.height, format: event.format,
    };
    const record: PendingInput = { info };
    pendingInputs.push(record);
    const bpp = bytesPerPixel(event.format);
    if (event.reason || !event.texture) info.reason = event.reason ?? 'Draw 输入纹理不可回读';
    else if (event.textureId === null || event.viewId === null) info.reason = '缺少 Inspector 纹理或视图 ID';
    else if (!Number.isSafeInteger(event.contentVersion) || event.contentVersion < 0) {
      info.reason = 'Draw 输入纹理内容版本无效';
    }
    else if (!bpp) info.reason = `暂不支持 ${event.format || '未知'} 格式的 Draw 输入纹理回读`;
    else if (event.width < 1 || event.height < 1 || !Number.isSafeInteger(event.width * event.height * bpp)) {
      info.reason = 'Draw 输入纹理尺寸无效';
    } else {
      const bytesPerRow = Math.ceil(event.width * bpp / 256) * 256;
      const size = bytesPerRow * event.height;
      const key = [event.contentVersion, event.viewId, event.mipLevel, event.arrayLayer,
        event.format, event.width, event.height].join(':');
      const cached = inputReadbackCache.get(event.texture)?.get(key);
      if (!Number.isSafeInteger(size) || size > device.limits.maxBufferSize) {
        info.reason = '此 Draw 输入纹理超过 GPU 单缓冲回读上限';
      } else if (cached?.buffer && !cached.info.reason) {
        record.sharedFrom = cached;
        record.bytesPerRow = cached.bytesPerRow;
      } else if (size > MAX_INPUT_RAW_BYTES - inputAllocated) {
        info.reason = '本帧 Draw 输入回读达到 2 GiB 上限';
      } else {
        let buffer: GPUBuffer | undefined;
        try {
          buffer = device.createBuffer({ label: `frame-debug input pass ${event.passOrdinal} ${event.bindingName} mip ${event.mipLevel}`,
            size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
          event.encoder.copyTextureToBuffer({ texture: event.texture, mipLevel: event.mipLevel,
            origin: { z: event.arrayLayer } },
          { buffer, bytesPerRow, rowsPerImage: event.height },
          { width: event.width, height: event.height, depthOrArrayLayers: 1 });
          record.buffer = buffer;
          record.bytesPerRow = bytesPerRow;
          inputAllocated += size;
          let versions = inputReadbackCache.get(event.texture);
          if (!versions) {
            versions = new Map();
            inputReadbackCache.set(event.texture, versions);
          }
          versions.set(key, record);
        } catch (error) {
          buffer?.destroy();
          info.reason = `Draw 输入纹理拷贝失败：${String(error)}`;
        }
      }
    }
  };

  const onDrawBuffer = (event: RhiDrawBufferCapture): void => {
    if (pendingBuffers.length >= MAX_BUFFER_RECORDS) {
      omittedBuffers++;
      return;
    }
    const validRange = Number.isSafeInteger(event.offset) && Number.isSafeInteger(event.size) &&
      event.offset >= 0 && event.size > 0 && event.offset + event.size <= event.totalSize;
    const copiedOffset = validRange ? Math.floor(event.offset / 4) * 4 : 0;
    const copiedEnd = validRange ? Math.ceil((event.offset + event.size) / 4) * 4 : 0;
    const copiedSize = copiedEnd - copiedOffset;
    const info: CapturedDrawBuffer = {
      passOrdinal: event.passOrdinal, role: event.role,
      ...(event.bindingName !== undefined ? { bindingName: event.bindingName } : {}),
      ...(event.groupSlot !== undefined ? { groupSlot: event.groupSlot } : {}),
      ...(event.binding !== undefined ? { binding: event.binding } : {}),
      ...(event.streamName !== undefined ? { streamName: event.streamName } : {}),
      ...(event.vertexSlot !== undefined ? { vertexSlot: event.vertexSlot } : {}),
      ...(event.indexFormat !== undefined ? { indexFormat: event.indexFormat } : {}),
      bufferId: event.bufferId, bufferLabel: event.bufferLabel, totalSize: event.totalSize,
      offset: event.offset, size: event.size, copiedOffset, copiedSize, rangeScope: event.rangeScope,
    };
    const record: PendingDrawBuffer = { info };
    pendingBuffers.push(record);
    if (event.reason || !event.buffer) { info.reason = event.reason ?? 'Draw Buffer 不可回读'; return; }
    if (event.bufferId === null) { info.reason = '缺少 Inspector Buffer ID'; return; }
    if (!validRange || copiedEnd > event.totalSize || !Number.isSafeInteger(copiedSize)) {
      info.reason = 'Draw Buffer 范围无法完整按 4 字节对齐回读'; return;
    }
    if (copiedSize > MAX_BUFFER_ITEM_BYTES) {
      info.reason = '此 Draw Buffer 范围超过 16 MiB 单项回读上限'; return;
    }
    if (copiedSize > device.limits.maxBufferSize || copiedSize > MAX_BUFFER_RAW_BYTES - bufferAllocated) {
      info.reason = '本帧 Draw Buffer 回读达到 GPU 或 256 MiB 总量上限'; return;
    }
    try {
      const buffer = device.createBuffer({ label: `frame-debug buffer pass ${event.passOrdinal} ${event.role}`,
        size: copiedSize, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      record.buffer = buffer;
      event.encoder.copyBufferToBuffer(event.buffer, copiedOffset, buffer, 0, copiedSize);
      bufferAllocated += copiedSize;
    } catch (error) {
      record.buffer?.destroy(); record.buffer = undefined;
      info.reason = `Draw Buffer 拷贝失败：${String(error)}`;
    }
  };

  const onAspectEnd = (event: RhiDepthStencilAspectCapture): void => {
    expectedFrame = event.frame;
    expectedLabel = event.submissionLabel;
    if (pendingAspects.length >= MAX_ASPECT_RECORDS) {
      omittedAspects++;
      return;
    }
    const info: CapturedAspectPixels = {
      passOrdinal: event.passOrdinal, label: event.label, targetLabel: event.targetLabel,
      aspect: event.aspect, textureId: event.textureId, viewId: event.viewId,
      width: event.width, height: event.height, sourceFormat: event.sourceFormat,
      rawFormat: event.aspect === 'depth' ? 'r32float' : 'stencil8',
      sampleCount: event.sampleCount, sampleIndex: event.aspect === 'depth' && event.sampleCount > 1 ? 0 : null,
    };
    const record: PendingAspect = { info };
    pendingAspects.push(record);
    const texture = event.texture;
    if (event.reason || !texture) { info.reason = event.reason ?? '深度 / 模板附件不可访问'; return; }
    if (event.textureId === null || event.viewId === null) {
      info.reason = 'WebGPU Inspector 未提供深度 / 模板附件纹理或视图 ID'; return;
    }
    if (event.width < 1 || event.height < 1 || !Number.isSafeInteger(event.width * event.height * 4)) {
      info.reason = '深度 / 模板附件尺寸无效'; return;
    }
    if (event.sampleCount !== 1 && event.sampleCount !== 4) {
      info.reason = `不支持 ${event.sampleCount}× 多重采样附件回读`; return;
    }
    if (event.aspect === 'stencil' && event.sampleCount !== 1) {
      info.reason = 'WebGPU 不允许直接拷贝多重采样模板；模板 MSAA 暂无无损回读路径'; return;
    }
    const bytesPerRow = event.aspect === 'depth' ? event.width * 4 : Math.ceil(event.width / 256) * 256;
    const size = bytesPerRow * event.height;
    if (!Number.isSafeInteger(size) || size > device.limits.maxBufferSize) {
      info.reason = '此深度 / 模板附件超过 GPU 单缓冲回读上限'; return;
    }
    if (size > MAX_ASPECT_RAW_BYTES - aspectAllocated) {
      info.reason = '本帧深度 / 模板回读达到 512 MiB 上限'; return;
    }
    if (event.aspect === 'depth') {
      if ((texture.usage & GPUTextureUsage.TEXTURE_BINDING) === 0) {
        info.reason = '深度附件缺少 TEXTURE_BINDING 用途，不能采样转换'; return;
      }
      if (size > device.limits.maxStorageBufferBindingSize) {
        info.reason = '此深度附件超过 GPU 存储缓冲绑定上限'; return;
      }
      try {
        const pipeline = pipelineForDepth(event.sampleCount);
        const view = texture.createView({ label: `frame-debug depth ${event.passOrdinal}`,
          aspect: 'depth-only', dimension: '2d' });
        if (!depthScratch || depthScratchSize < size) {
          depthScratch = device.createBuffer({ label: `frame-debug depth scratch ${size}`,
            size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
          depthScratchBuffers.push(depthScratch);
          depthScratchSize = size;
        }
        const computeBuffer = depthScratch;
        const buffer = device.createBuffer({ label: `frame-debug depth read ${event.passOrdinal}`,
          size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        record.buffer = buffer;
        const bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
          { binding: 0, resource: view }, { binding: 1, resource: { buffer: computeBuffer } },
        ] });
        const pass = event.encoder.beginComputePass({ label: `frame-debug depth after render pass ${event.passOrdinal}` });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(Math.ceil(event.width / 8), Math.ceil(event.height / 8));
        pass.end();
        event.encoder.copyBufferToBuffer(computeBuffer, 0, buffer, 0, size);
        record.bytesPerRow = bytesPerRow;
        aspectAllocated += size;
      } catch (error) {
        record.buffer?.destroy(); record.buffer = undefined;
        info.reason = `深度附件 GPU 转换失败：${String(error)}`;
      }
    } else {
      if ((texture.usage & GPUTextureUsage.COPY_SRC) === 0) {
        info.reason = '模板附件缺少 COPY_SRC 用途'; return;
      }
      try {
        const buffer = device.createBuffer({ label: `frame-debug stencil read ${event.passOrdinal}`,
          size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        record.buffer = buffer;
        event.encoder.copyTextureToBuffer({ texture, aspect: 'stencil-only' },
          { buffer, bytesPerRow, rowsPerImage: event.height },
          { width: event.width, height: event.height, depthOrArrayLayers: 1 });
        record.bytesPerRow = bytesPerRow;
        aspectAllocated += size;
      } catch (error) {
        record.buffer?.destroy(); record.buffer = undefined;
        info.reason = `模板附件 GPU 拷贝失败：${String(error)}`;
      }
    }
  };

  const onResourceTexture = (event: RhiFrameResourceTextureCapture): void => {
    if (pendingResourceTextures.length >= MAX_RESOURCE_TEXTURE_RECORDS) {
      throw new Error(`活纹理子资源超过 ${MAX_RESOURCE_TEXTURE_RECORDS} 条上限`);
    }
    const info: CapturedResourceTexture = {
      textureOrdinal: event.textureOrdinal, textureId: event.textureId,
      label: event.label, width: event.width, height: event.height,
      sourceFormat: event.sourceFormat,
      rawFormat: event.aspect === 'depth' ? 'r32float'
        : event.aspect === 'stencil' ? 'stencil8' : event.sourceFormat,
      mipLevel: event.mipLevel, arrayLayer: event.arrayLayer, aspect: event.aspect,
      sampleCount: event.sampleCount, captureMoment: 'frame-end',
    };
    const record: PendingResourceTexture = { info };
    pendingResourceTextures.push(record);
    const texture = event.texture;
    if (event.reason || !texture) { info.reason = event.reason ?? '资源纹理不可访问'; return; }
    if (event.textureId === null) { info.reason = '缺少 Inspector 纹理 ID'; return; }
    if (event.width < 1 || event.height < 1 || !Number.isSafeInteger(event.width * event.height * 4)) {
      info.reason = '资源纹理尺寸无效'; return;
    }
    const bpp = event.aspect === 'depth' ? 4
      : event.aspect === 'stencil' ? 1 : bytesPerPixel(event.sourceFormat);
    if (!bpp) { info.reason = `不支持 ${event.sourceFormat} 资源纹理格式回读`; return; }
    const bytesPerRow = event.aspect === 'depth' ? event.width * 4
      : Math.ceil(event.width * bpp / 256) * 256;
    const size = bytesPerRow * event.height;
    if (!Number.isSafeInteger(size) || size > device.limits.maxBufferSize) {
      info.reason = '资源纹理超过 GPU 单缓冲回读上限'; return;
    }
    if (size > MAX_RESOURCE_TEXTURE_RAW_BYTES - resourceTextureAllocated) {
      info.reason = '本帧资源纹理回读达到 2 GiB 上限'; return;
    }
    try {
      if (event.aspect === 'depth') {
        if (size > device.limits.maxStorageBufferBindingSize) {
          info.reason = '深度资源纹理超过 GPU 存储缓冲绑定上限'; return;
        }
        const pipeline = pipelineForDepth(1);
        const view = texture.createView({ aspect: 'depth-only', dimension: '2d',
          baseMipLevel: event.mipLevel, mipLevelCount: 1,
          baseArrayLayer: event.arrayLayer, arrayLayerCount: 1 });
        if (!depthScratch || depthScratchSize < size) {
          depthScratch = device.createBuffer({ label: `frame-debug resource depth scratch ${size}`,
            size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
          depthScratchBuffers.push(depthScratch);
          depthScratchSize = size;
        }
        const buffer = device.createBuffer({ label: `frame-debug resource depth ${event.label} mip ${event.mipLevel}`,
          size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        record.buffer = buffer;
        const bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
          { binding: 0, resource: view }, { binding: 1, resource: { buffer: depthScratch } },
        ] });
        const pass = event.encoder.beginComputePass({ label: `frame-debug resource depth ${event.label}` });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(Math.ceil(event.width / 8), Math.ceil(event.height / 8));
        pass.end();
        event.encoder.copyBufferToBuffer(depthScratch, 0, buffer, 0, size);
      } else {
        const buffer = device.createBuffer({ label: `frame-debug resource texture ${event.label} mip ${event.mipLevel}`,
          size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        record.buffer = buffer;
        event.encoder.copyTextureToBuffer({ texture, mipLevel: event.mipLevel,
          origin: { z: event.arrayLayer },
          ...(event.aspect === 'stencil' ? { aspect: 'stencil-only' as const } : {}) },
        { buffer, bytesPerRow, rowsPerImage: event.height },
        { width: event.width, height: event.height, depthOrArrayLayers: 1 });
      }
      record.bytesPerRow = bytesPerRow;
      resourceTextureAllocated += size;
    } catch (error) {
      record.buffer?.destroy(); record.buffer = undefined;
      info.reason = `资源纹理 GPU 拷贝失败：${String(error)}`;
    }
  };

  const onResourceBuffer = (event: RhiFrameResourceBufferCapture): void => {
    if (pendingResourceBuffers.length >= MAX_RESOURCE_BUFFER_RECORDS) {
      throw new Error(`活 Buffer 超过 ${MAX_RESOURCE_BUFFER_RECORDS} 条上限`);
    }
    const info: CapturedResourceBuffer = {
      bufferId: event.bufferId, label: event.label, totalSize: event.totalSize,
      copiedOffset: 0, copiedSize: event.totalSize, captureMoment: 'frame-end',
    };
    const record: PendingResourceBuffer = { info };
    pendingResourceBuffers.push(record);
    if (event.reason || !event.buffer) { info.reason = event.reason ?? '资源 Buffer 不可访问'; return; }
    if (event.bufferId === null) { info.reason = '缺少 Inspector Buffer ID'; return; }
    const size = event.totalSize;
    if (!Number.isSafeInteger(size) || size < 4 || size % 4 !== 0) {
      info.reason = '资源 Buffer 全长无法按 4 字节对齐回读'; return;
    }
    if (size > device.limits.maxBufferSize || size > MAX_RESOURCE_BUFFER_RAW_BYTES - resourceBufferAllocated) {
      info.reason = '资源 Buffer 超过 GPU 或单帧 1 GiB 回读上限'; return;
    }
    try {
      const buffer = device.createBuffer({ label: `frame-debug whole buffer ${event.label}`,
        size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      record.buffer = buffer;
      event.encoder.copyBufferToBuffer(event.buffer, 0, buffer, 0, size);
      resourceBufferAllocated += size;
    } catch (error) {
      record.buffer?.destroy(); record.buffer = undefined;
      info.reason = `资源 Buffer GPU 拷贝失败：${String(error)}`;
    }
  };

  const onResourceInventory = (inventory: RhiFrameResourceInventory): void => {
    resourceInventory = inventory;
    if (inventory.textureSubresourceCount !== pendingResourceTextures.length ||
        inventory.bufferCount !== pendingResourceBuffers.length) {
      throw new Error('RHI 活资源清单与逐项快照数不一致');
    }
  };

  // These hooks only encode diagnostic copies. Their native GPU work must execute,
  // but Inspector already has the real game commands and the complete sidecars.
  // Keep the copies out of WGPUCAP so every staging buffer is not recorded twice.
  const withoutInspectorRecording = <T>(callback: (event: T) => void): (event: T) => void => (event) => {
    if (!recordingControl) { callback(event); return; }
    recordingControl.disableRecording();
    try { callback(event); }
    finally { recordingControl.enableRecording(); }
  };
  const stopHook = rhi.frameDebugCapture?.captureNextSubmission({
    kind: 'frame',
    onPassEnd: withoutInspectorRecording(onPassEnd),
    onDrawInput: withoutInspectorRecording(onDrawInput),
    onDrawBuffer: withoutInspectorRecording(onDrawBuffer),
    onAspectEnd: withoutInspectorRecording(onAspectEnd),
    onResourceTexture: withoutInspectorRecording(onResourceTexture),
    onResourceBuffer: withoutInspectorRecording(onResourceBuffer),
    onResourceInventory,
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
      record.info.rawPixels = undefined;
    }
    for (const record of pendingInputs) {
      record.buffer?.destroy();
      record.buffer = undefined;
      record.info.rawPixels = undefined;
    }
    for (const record of pendingAspects) {
      record.buffer?.destroy();
      record.buffer = undefined;
      record.info.rawPixels = undefined;
    }
    for (const record of pendingBuffers) {
      record.buffer?.destroy();
      record.buffer = undefined;
      record.info.rawBytes = undefined;
    }
    for (const record of pendingResourceTextures) {
      record.buffer?.destroy();
      record.buffer = undefined;
      record.info.rawPixels = undefined;
    }
    for (const record of pendingResourceBuffers) {
      record.buffer?.destroy();
      record.buffer = undefined;
      record.info.rawBytes = undefined;
    }
    for (const buffer of depthScratchBuffers) buffer.destroy();
    depthScratchBuffers.length = 0;
    submittedResolve();
  };

  const finish = async (): Promise<CapturedFrameDiagnostics> => {
    if (finished) throw new Error('逐 pass 诊断结果只能读取一次');
    finished = true;
    let gpuProfilerStatus: CapturedFrameDiagnostics['gpuProfilerStatus'] = status;
    let gpuPasses: CapturedGpuPass[] = [];
    try {
      await withTimeout(submitted, MAP_TIMEOUT_MS, 'GPU 帧提交超时');
      if (!resourceInventory && !cancelled) throw new Error('RHI 未返回帧末活资源清单');
      if (!cancelled) {
        for (const record of pendingInputs) {
          const buffer = record.buffer;
          if (!buffer || record.info.reason) continue;
          try {
            await withTimeout(buffer.mapAsync(GPUMapMode.READ), MAP_TIMEOUT_MS, 'GPU Draw 输入回读超时');
            if (cancelled) continue;
            record.info.rawPixels = new Uint8Array(buffer.getMappedRange()).slice();
            record.info.rawBytesPerRow = record.bytesPerRow;
          } catch (error) {
            record.info.reason = `GPU Draw 输入回读失败：${String(error)}`;
          } finally {
            try { buffer.unmap(); } catch { /* A failed map has no mapping to release. */ }
            buffer.destroy();
            record.buffer = undefined;
          }
        }
        for (const record of pendingInputs) {
          if (!record.sharedFrom) continue;
          const source = record.sharedFrom.info;
          if (source.rawPixels && source.rawBytesPerRow) {
            record.info.rawPixels = source.rawPixels;
            record.info.rawBytesPerRow = source.rawBytesPerRow;
          } else record.info.reason = source.reason ?? '共享 Draw 输入回读失败';
        }
        for (const record of pending) {
          const buffer = record.buffer;
          if (!buffer || record.info.reason) continue;
          try {
            await withTimeout(buffer.mapAsync(GPUMapMode.READ), MAP_TIMEOUT_MS, 'GPU 画面回读超时');
            if (cancelled) continue;
            const raw = new Uint8Array(buffer.getMappedRange()).slice();
            record.info.rawPixels = raw;
            record.info.rawBytesPerRow = record.bytesPerRow;
          } catch (error) {
            record.info.reason = `GPU 画面回读失败：${String(error)}`;
          } finally {
            try { buffer.unmap(); } catch { /* A failed map has no mapping to release. */ }
            buffer.destroy();
            record.buffer = undefined;
          }
        }
        for (const record of pendingAspects) {
          const buffer = record.buffer;
          if (!buffer || record.info.reason) continue;
          try {
            await withTimeout(buffer.mapAsync(GPUMapMode.READ), MAP_TIMEOUT_MS, 'GPU 深度 / 模板回读超时');
            if (cancelled) continue;
            record.info.rawPixels = new Uint8Array(buffer.getMappedRange()).slice();
            record.info.rawBytesPerRow = record.bytesPerRow;
          } catch (error) {
            record.info.reason = `GPU 深度 / 模板回读失败：${String(error)}`;
          } finally {
            try { buffer.unmap(); } catch { /* A failed map has no mapping to release. */ }
            buffer.destroy();
            record.buffer = undefined;
          }
        }
        for (const record of pendingBuffers) {
          const buffer = record.buffer;
          if (!buffer || record.info.reason) continue;
          try {
            await withTimeout(buffer.mapAsync(GPUMapMode.READ), MAP_TIMEOUT_MS, 'GPU Draw Buffer 回读超时');
            if (cancelled) continue;
            record.info.rawBytes = new Uint8Array(buffer.getMappedRange()).slice();
          } catch (error) {
            record.info.reason = `GPU Draw Buffer 回读失败：${String(error)}`;
          } finally {
            try { buffer.unmap(); } catch { /* A failed map has no mapping to release. */ }
            buffer.destroy();
            record.buffer = undefined;
          }
        }
        for (const record of pendingResourceTextures) {
          const buffer = record.buffer;
          if (!buffer || record.info.reason) continue;
          try {
            await withTimeout(buffer.mapAsync(GPUMapMode.READ), MAP_TIMEOUT_MS, 'GPU 资源纹理回读超时');
            if (cancelled) continue;
            record.info.rawPixels = new Uint8Array(buffer.getMappedRange()).slice();
            record.info.rawBytesPerRow = record.bytesPerRow;
          } catch (error) {
            record.info.reason = `GPU 资源纹理回读失败：${String(error)}`;
          } finally {
            try { buffer.unmap(); } catch { /* A failed map has no mapping to release. */ }
            buffer.destroy();
            record.buffer = undefined;
          }
        }
        for (const record of pendingResourceBuffers) {
          const buffer = record.buffer;
          if (!buffer || record.info.reason) continue;
          try {
            await withTimeout(buffer.mapAsync(GPUMapMode.READ), MAP_TIMEOUT_MS, 'GPU 资源 Buffer 回读超时');
            if (cancelled) continue;
            record.info.rawBytes = new Uint8Array(buffer.getMappedRange()).slice();
          } catch (error) {
            record.info.reason = `GPU 资源 Buffer 回读失败：${String(error)}`;
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
          if (profile.passes.length > MAX_PASS_RECORDS) omittedTimings = profile.passes.length - MAX_PASS_RECORDS;
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
      for (const record of pendingInputs) {
        record.buffer?.destroy();
        record.buffer = undefined;
      }
      for (const record of pendingAspects) {
        record.buffer?.destroy();
        record.buffer = undefined;
      }
      for (const record of pendingBuffers) {
        record.buffer?.destroy();
        record.buffer = undefined;
      }
      for (const record of pendingResourceTextures) {
        record.buffer?.destroy();
        record.buffer = undefined;
      }
      for (const record of pendingResourceBuffers) {
        record.buffer?.destroy();
        record.buffer = undefined;
      }
      for (const buffer of depthScratchBuffers) buffer.destroy();
      depthScratchBuffers.length = 0;
    }
    const omitted = [
      omittedReadbacks ? `${omittedReadbacks} 个颜色输出超过 ${MAX_PASS_RECORDS} 条回读记录上限` : '',
      omittedInputs ? `${omittedInputs} 个 Draw 输入超过 ${MAX_INPUT_RECORDS} 条回读记录上限` : '',
      omittedAspects ? `${omittedAspects} 个深度 / 模板附件超过 ${MAX_ASPECT_RECORDS} 条回读记录上限` : '',
      omittedBuffers ? `${omittedBuffers} 个 Draw Buffer 超过 ${MAX_BUFFER_RECORDS} 条回读记录上限` : '',
      omittedTimings ? `${omittedTimings} 个 GPU 计时结果超过 ${MAX_PASS_RECORDS} 条记录上限` : '',
    ].filter(Boolean).join('；');
    return { passes: pending.map(record => record.info), inputs: pendingInputs.map(record => record.info),
      aspects: pendingAspects.map(record => record.info), gpuPasses, gpuProfilerStatus,
      buffers: pendingBuffers.map(record => record.info),
      resourceInventory: resourceInventory ?? { textureCount: 0, bufferCount: 0, textureSubresourceCount: 0 },
      resourceTextures: pendingResourceTextures.map(record => record.info),
      resourceBuffers: pendingResourceBuffers.map(record => record.info),
      ...(omitted ? { warning: omitted } : {}) };
  };
  return { finish, cancel };
}
