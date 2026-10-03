import { deflateSync, inflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { capturePngTaskSize, encodeCapturePng, type WebGpuCapturePngTask } from './webgpuCapturePngCodec';

// The canvas boundary is a Node fixture. The production codec still performs all
// native-format decoding and alpha conversion; a separate PNG parser checks bytes.
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(width: number, height: number, pixels: Uint8ClampedArray): Blob {
  const chunk = (name: string, data: Buffer): Buffer => {
    const type = Buffer.from(name); const result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length); type.copy(result, 4); data.copy(result, 8);
    result.writeUInt32BE(crc32(Buffer.concat([type, data])), data.length + 8);
    return result;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rows.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  return new Blob([new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]))], { type: 'image/png' });
}
async function decode(blob: Blob): Promise<{ width: number; height: number; rgba: number[] }> {
  const bytes = Buffer.from(await blob.arrayBuffer());
  expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  let width = 0; let height = 0; const names: string[] = []; const idat: Buffer[] = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset); const name = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length); names.push(name);
    expect(bytes.readUInt32BE(offset + length + 8)).toBe(crc32(bytes.subarray(offset + 4, offset + length + 8)));
    if (name === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      expect([...data.subarray(8)]).toEqual([8, 6, 0, 0, 0]);
    }
    if (name === 'IDAT') idat.push(data);
    offset += length + 12;
  }
  expect(names).toEqual(['IHDR', 'IDAT', 'IEND']);
  const rows = inflateSync(Buffer.concat(idat)); expect(rows.length).toBe((width * 4 + 1) * height);
  const rgba: number[] = [];
  for (let y = 0; y < height; y++) {
    expect(rows[y * (width * 4 + 1)]).toBe(0);
    rgba.push(...rows.subarray(y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1)));
  }
  return { width, height, rgba };
}

const canvases: TestCanvas[] = [];
class TestCanvas {
  pixels = new Uint8ClampedArray();
  constructor(public width = 0, public height = 0) { canvases.push(this); }
  getContext(): object { return { putImageData: (data: { data: Uint8ClampedArray }) => { this.pixels = data.data.slice(); } }; }
  convertToBlob(): Promise<Blob> { return Promise.resolve(png(this.width, this.height, this.pixels)); }
  toBlob(callback: (blob: Blob) => void): void { callback(png(this.width, this.height, this.pixels)); }
}
beforeEach(() => {
  canvases.length = 0;
  vi.stubGlobal('OffscreenCanvas', TestCanvas);
  vi.stubGlobal('ImageData', class { constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {} });
  vi.stubGlobal('document', { createElement: () => new TestCanvas() });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('capture PNG codec pixel and canvas contract', () => {
  it('uses a valid CRC oracle and preserves offset views, dimensions and straight-alpha RGBA in both backends', async () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    const source = new Uint8Array([99, 98, 64, 32, 0, 128, 1, 2, 3, 255, 97]);
    const pixels = source.subarray(2, 10); const original = [...source];
    for (const offscreen of [true, false]) {
      expect(await decode(await encodeCapturePng({ kind: 'rgba', pixels, width: 2, height: 1 }, { offscreen })))
        .toEqual({ width: 2, height: 1, rgba: [128, 64, 0, 128, 1, 2, 3, 255] });
      expect([...source]).toEqual(original);
      expect(canvases[canvases.length - 1]).toMatchObject({ width: 1, height: 1 });
    }
  });

  it('honors unpremultiply=false and ownsPixels without touching bytes outside the transferred view', async () => {
    const bytes = new Uint8Array([77, 10, 20, 30, 128, 66]);
    const task = { kind: 'rgba' as const, pixels: bytes.subarray(1, 5), width: 1, height: 1 };
    expect((await decode(await encodeCapturePng({ ...task, unpremultiply: false }, { offscreen: true }))).rgba).toEqual([10, 20, 30, 128]);
    expect((await decode(await encodeCapturePng(task, { offscreen: true, ownsPixels: true }))).rgba).toEqual([20, 40, 60, 128]);
    expect([...bytes]).toEqual([77, 20, 40, 60, 128, 66]);
  });

  it.each(['pass', 'input', 'resource'] as const)('decodes padded BGRA rows for %s without changing authoritative raw bytes', async (kind) => {
    const rawPixels = new Uint8Array([3, 2, 1, 255, 90, 91, 92, 93, 6, 5, 4, 255]);
    const capture = { width: 1, height: 2, format: 'bgra8unorm', rawFormat: 'bgra8unorm', sourceFormat: 'bgra8unorm',
      aspect: 'color' as const, rawPixels, rawBytesPerRow: 8, passOrdinal: 0, label: 'fixture', targetLabel: 'fixture',
      colorIndex: 0, bindingName: 'fixture', groupSlot: 0, binding: 0, textureId: null, viewId: null, contentVersion: 0,
      mipLevel: 0, arrayLayer: 0, textureOrdinal: 0, sampleCount: 1, captureMoment: 'frame-end' as const };
    const task = { kind, capture } as WebGpuCapturePngTask; const original = [...rawPixels];
    expect(await decode(await encodeCapturePng(task, { offscreen: true })))
      .toEqual({ width: 1, height: 2, rgba: [1, 2, 3, 255, 4, 5, 6, 255] });
    expect([...rawPixels]).toEqual(original);
  });

  it.each(['aspect', 'resource'] as const)('maps %s depth f32 and stencil u8 through the real diagnostic visualizer', async (kind) => {
    const raw = new Uint8Array(12); new DataView(raw.buffer).setFloat32(4, 0.5, true);
    const depth = { width: 1, height: 1, aspect: 'depth', rawPixels: raw.subarray(4, 8), rawBytesPerRow: 4 };
    const stencil = { width: 1, height: 1, aspect: 'stencil', rawPixels: new Uint8Array([31]), rawBytesPerRow: 1 };
    for (const [capture, grey] of [[depth, 128], [stencil, 31]] as const) {
      expect((await decode(await encodeCapturePng({ kind, capture } as WebGpuCapturePngTask, { offscreen: true }))).rgba)
        .toEqual([grey, grey, grey, 255]);
    }
  });

  it('maps float HDR RGBA without treating input previews as premultiplied canvas pixels', async () => {
    const rawPixels = new Uint8Array(new Float32Array([1, 3, -1, 0.5]).buffer);
    const task = { kind: 'pass', capture: { width: 1, height: 1, format: 'rgba32float', rawPixels, rawBytesPerRow: 16 } } as WebGpuCapturePngTask;
    expect((await decode(await encodeCapturePng(task, { offscreen: true }))).rgba).toEqual([128, 191, 0, 128]);
  });

  it.each(['r32uint', 'rgba32uint'] as const)('visualizes %s integer textures with channel clamping and exact row offsets', async (format) => {
    const raw = new Uint8Array(24); const view = new DataView(raw.buffer);
    [23, 256, 0, 128].forEach((value, index) => view.setUint32(4 + index * 4, value, true));
    const task = { kind: 'pass', capture: { width: 1, height: 1, format, rawPixels: raw.subarray(4, 20), rawBytesPerRow: 16 } } as WebGpuCapturePngTask;
    expect((await decode(await encodeCapturePng(task, { offscreen: true }))).rgba)
      .toEqual(format === 'r32uint' ? [23, 23, 23, 255] : [23, 255, 0, 128]);
  });

  it.each([true, false])('rejects invalid canvas PNG output and releases its backing store (offscreen=%s)', async (offscreen) => {
    vi.spyOn(TestCanvas.prototype, 'convertToBlob').mockResolvedValue(new Blob([], { type: 'image/png' }));
    vi.spyOn(TestCanvas.prototype, 'toBlob').mockImplementation(callback => callback(new Blob(['invalid'], { type: 'text/plain' })));
    await expect(encodeCapturePng({ kind: 'rgba', width: 2, height: 1, pixels: new Uint8Array(8) }, { offscreen }))
      .rejects.toThrow(/有效 PNG/);
    expect(canvases[canvases.length - 1]).toMatchObject({ width: 1, height: 1 });
  });

  it.each([[0, 1], [1.5, 1], [1, NaN], [8192, 4097]])('rejects invalid or over-budget dimensions %s x %s before creating a canvas', async (width, height) => {
    const task = { kind: 'rgba' as const, width, height, pixels: new Uint8Array() };
    expect(() => capturePngTaskSize(task)).toThrow();
    await expect(encodeCapturePng(task, { offscreen: true })).rejects.toThrow(); expect(canvases).toHaveLength(0);
  });

  it('rejects incorrect RGBA size and missing or too-short raw rows, with exact memory admission accounting', () => {
    expect(capturePngTaskSize({ kind: 'rgba', width: 1, height: 1, pixels: new Uint8Array(4) }))
      .toEqual({ width: 1, height: 1, rawBytes: 4, workingBytes: 12 });
    expect(() => capturePngTaskSize({ kind: 'rgba', width: 1, height: 1, pixels: new Uint8Array(3) })).toThrow(/RGBA8/);
    for (const capture of [{ width: 1, height: 1 }, { width: 1, height: 2, rawPixels: new Uint8Array(8), rawBytesPerRow: 8 }]) {
      expect(() => capturePngTaskSize({ kind: 'pass', capture } as WebGpuCapturePngTask)).toThrow(/原始像素/);
    }
  });

  it('rejects pre-abort and releases fallback canvas immediately on abort despite a late toBlob result', async () => {
    const controller = new AbortController(); controller.abort();
    const task = { kind: 'rgba' as const, width: 1, height: 1, pixels: new Uint8Array(4) };
    await expect(encodeCapturePng(task, { offscreen: true, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(canvases).toHaveLength(0);
    let finish!: (blob: Blob) => void;
    vi.spyOn(TestCanvas.prototype, 'toBlob').mockImplementation(callback => { finish = callback; });
    const active = new AbortController(); const pending = encodeCapturePng(task, { offscreen: false, signal: active.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' }); active.abort(); await rejected;
    expect(canvases[canvases.length - 1]).toMatchObject({ width: 1, height: 1 });
    finish(new Blob(['late'], { type: 'image/png' })); await Promise.resolve();
  });
});
