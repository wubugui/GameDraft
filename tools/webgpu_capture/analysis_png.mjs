// Export texture-state snapshots from .wgpuc binary payloads. These are not
// outputs after individual draw calls; the capture contains no such snapshots.
import { deflateSync } from 'node:zlib';
import { copyFile, link, mkdir, open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_IMAGE_BYTES = 128 * 1024 * 1024;
const FORMAT_BYTES = new Map([
  ['rgba8unorm', 4], ['rgba8unorm-srgb', 4],
  ['bgra8unorm', 4], ['bgra8unorm-srgb', 4],
  ['rgba16float', 8], ['r8unorm', 1],
]);
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});

function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) value = CRC_TABLE[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const result = Buffer.allocUnsafe(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  name.copy(result, 4);
  data.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, 8 + data.length)), 8 + data.length);
  return result;
}

function encodePng(width, height, rgba) {
  const scanlines = Buffer.allocUnsafe(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    const dst = y * (width * 4 + 1);
    scanlines[dst] = 0; // PNG filter None.
    rgba.copy(scanlines, dst + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // Eight bits per channel.
  ihdr[9] = 6; // RGBA.
  return Buffer.concat([
    PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(scanlines)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function readExactly(handle, bytes, position) {
  let offset = 0;
  while (offset < bytes.length) {
    const read = await handle.read(bytes, offset, bytes.length - offset, position + offset);
    if (!read.bytesRead) throw new Error('WGPUCAP texture payload is truncated');
    offset += read.bytesRead;
  }
}

function payloadFor(texture, payloads) {
  const bytesPerPixel = FORMAT_BYTES.get(texture.format);
  if (!bytesPerPixel) {
    return { status: 'unsupported-format', reason: `PNG export does not support ${texture.format ?? 'unknown'} texture format` };
  }
  if (texture.dimension !== '2d' || texture.depthOrArrayLayers !== 1 ||
      (texture.descriptor?.sampleCount ?? 1) !== 1) {
    return { status: 'unsupported-layout', reason: 'PNG export supports single-layer, non-multisampled 2D textures' };
  }
  const { width, height } = texture;
  const tightRow = width * bytesPerPixel;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width < 1 || height < 1 || tightRow * height > MAX_IMAGE_BYTES ||
      width * height * 4 > MAX_IMAGE_BYTES) {
    return { status: 'unsupported-size', reason: 'texture dimensions exceed the 128 MiB PNG export limit' };
  }
  const mip = texture.mipLevels.find(level => level.mipLevel === 0);
  const payload = mip && payloads[mip.payloadId];
  if (!payload) return { status: 'no-payload', reason: 'capture has no mip 0 texture payload' };
  if (payload.bytes > MAX_IMAGE_BYTES) {
    return { status: 'unsupported-size', reason: 'texture payload exceeds the 128 MiB PNG export limit' };
  }
  const alignedRow = Math.ceil(tightRow / 256) * 256;
  const stride = payload.bytes === tightRow * height ? tightRow :
    payload.bytes === alignedRow * height ? alignedRow : null;
  if (stride === null) {
    return { status: 'unsupported-layout', reason: `payload length ${payload.bytes} is neither tightly packed nor 256-byte row aligned` };
  }
  return { status: 'ready', payload, stride };
}

function halfToFloat(bits) {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >>> 10) & 31;
  const fraction = bits & 1023;
  if (exponent === 31) return fraction ? NaN : sign * Infinity;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

function previewByte(value) {
  // An 8-bit PNG is a display preview. Keep the conversion deterministic and
  // disclose clipping; the original float payload is not a rendered pass.
  return Math.round(Math.min(1, Math.max(0, Number.isNaN(value) ? 0 : value)) * 255);
}

function rgbaFromPayload(source, texture, stride) {
  const { width, height } = texture;
  const rgba = Buffer.allocUnsafe(width * height * 4);
  const bgra = texture.format.startsWith('bgra');
  for (let y = 0; y < height; y++) {
    const srcRow = y * stride;
    const dstRow = y * width * 4;
    if (texture.format === 'r8unorm') {
      for (let x = 0; x < width; x++) {
        const dst = dstRow + x * 4;
        rgba[dst] = rgba[dst + 1] = rgba[dst + 2] = source[srcRow + x];
        rgba[dst + 3] = 255;
      }
      continue;
    }
    if (texture.format === 'rgba16float') {
      for (let x = 0; x < width; x++) {
        const src = srcRow + x * 8;
        const dst = dstRow + x * 4;
        for (let channel = 0; channel < 4; channel++) {
          rgba[dst + channel] = previewByte(halfToFloat(source.readUInt16LE(src + channel * 2)));
        }
      }
      continue;
    }
    if (!bgra) {
      source.copy(rgba, dstRow, srcRow, srcRow + width * 4);
      continue;
    }
    for (let x = 0; x < width; x++) {
      const src = srcRow + x * 4;
      const dst = dstRow + x * 4;
      rgba[dst] = source[src + 2];
      rgba[dst + 1] = source[src + 1];
      rgba[dst + 2] = source[src];
      rgba[dst + 3] = source[src + 3];
    }
  }
  return rgba;
}

async function aliasImage(source, dest) {
  try { await link(source, dest); }
  catch (error) {
    // Some filesystems refuse hard links; a regular copy is equivalent here.
    if (error?.code !== 'EPERM' && error?.code !== 'EACCES' &&
        error?.code !== 'ENOTSUP' && error?.code !== 'EXDEV') throw error;
    await copyFile(source, dest);
  }
}

export async function exportTextureImages(capture, outputDir, textures, frames) {
  const textureDir = join(outputDir, 'textures');
  await mkdir(textureDir);
  const exports = [];
  const summary = { exported: 0, noPayload: 0, unsupported: 0 };
  const fileNames = new Set();
  const handle = await open(capture.captureFile, 'r');
  try {
    for (const [index, texture] of textures.entries()) {
      const choice = payloadFor(texture, capture.payloads);
      if (choice.status !== 'ready') {
        texture.imageStatus = choice.status;
        texture.imageReason = choice.reason;
        if (choice.status === 'no-payload') summary.noPayload++;
        else summary.unsupported++;
        continue;
      }
      const source = Buffer.allocUnsafe(choice.payload.bytes);
      await readExactly(handle, source, choice.payload.offset);
      const rgba = rgbaFromPayload(source, texture, choice.stride);
      // Object IDs come from a capture file; never use an arbitrary string as a path.
      let fileName = Number.isFinite(texture.id) ? `${texture.id}.png` : `${index}.png`;
      if (fileNames.has(fileName)) fileName = `${index}-${fileName}`;
      fileNames.add(fileName);
      const filePath = join(textureDir, fileName);
      await writeFile(filePath, encodePng(texture.width, texture.height, rgba), { flag: 'wx' });
      texture.imageStatus = 'exported';
      texture.imageFile = `textures/${fileName}`;
      texture.imageSource = 'capture texture mip 0 snapshot; not a per-draw output';
      texture.imagePreviewTransform = texture.format === 'rgba16float'
        ? 'float16 线性值裁剪到 [0,1] 后转为 8 位 PNG；HDR 和负值会被截断。'
        : texture.format === 'r8unorm' ? 'R 通道复制为灰度 RGB。' : '通道字节复制为 PNG。';
      texture.rowStrideBytes = choice.stride;
      texture.payloadId = choice.payload.id;
      exports.push(filePath);
      summary.exported++;
    }
  } finally {
    await handle.close();
  }

  const lastUse = new Map(frames.map((frame, index) => [frame.frameTextureId, index]));
  const frameDir = join(outputDir, 'frames');
  let madeFrameDir = false;
  for (const [index, frame] of frames.entries()) {
    const texture = textures.find(item => item.id === frame.frameTextureId);
    if (!texture?.imageFile) {
      frame.imageReason = texture?.imageReason ?? 'capture has no canvas texture payload for this frame';
      continue;
    }
    if (lastUse.get(frame.frameTextureId) !== index) {
      frame.imageReason = 'canvas texture ID is reused; capture stores only its final snapshot';
      continue;
    }
    if (!madeFrameDir) { await mkdir(frameDir); madeFrameDir = true; }
    const frameFile = `frames/${frame.frameOrdinal}.png`;
    const dest = join(outputDir, frameFile);
    await aliasImage(join(outputDir, texture.imageFile), dest);
    frame.imageFile = frameFile;
    frame.imageSource = 'WGPUCAP CanvasTexture mip 0 final snapshot';
    exports.push(dest);
  }

  const lastFrame = frames.at(-1);
  let frameImage = null;
  if (lastFrame?.imageFile) {
    const source = join(outputDir, lastFrame.imageFile);
    const dest = join(outputDir, 'frame.png');
    await aliasImage(source, dest);
    frameImage = 'frame.png';
    exports.push(dest);
  }
  return { frameImage, exports, summary };
}
