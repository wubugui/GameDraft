// A game readback sidecar is a separate, per-frame image. Inspector's texture
// table can reuse one CanvasTexture ID across frames and retain only its last
// state, so earlier images must never be invented from that payload.
import { copyFile, lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_SIDECAR_BYTES = 128 * 1024 * 1024;

async function validPng(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size < 33 || stat.size > MAX_SIDECAR_BYTES) {
    throw new Error('sidecar is not a regular PNG file within the 128 MiB limit');
  }
  const file = await open(path, 'r');
  try {
    const head = Buffer.alloc(24);
    const { bytesRead } = await file.read(head, 0, head.length, 0);
    if (bytesRead !== 24 || !head.subarray(0, 8).equals(PNG_SIGNATURE) ||
        head.readUInt32BE(8) !== 13 || head.toString('ascii', 12, 16) !== 'IHDR' ||
        head.readUInt32BE(16) < 1 || head.readUInt32BE(20) < 1) {
      throw new Error('sidecar PNG header is invalid');
    }
  } finally {
    await file.close();
  }
}

export async function attachFrameSidecars(captureFile, outputDir, frames) {
  const sourceDir = dirname(captureFile);
  const names = await readdir(sourceDir);
  const candidates = names.filter(name => /^frame-[0-9]{4}\.png$/.test(name));
  if (!candidates.length) return { exports: [], attached: 0, errors: [], frameImage: null };

  const exports = [];
  const errors = [];
  let attached = 0;
  await mkdir(join(outputDir, 'frames'), { recursive: true });
  for (const name of candidates) {
    const ordinal = Number(name.slice(6, 10));
    const frame = frames.find(item => item.frameOrdinal === ordinal);
    if (!frame) continue;
    const source = join(sourceDir, name);
    try {
      await validPng(source);
      const relativeFile = `frames/${ordinal}.png`;
      const dest = join(outputDir, relativeFile);
      try { await unlink(dest); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      await copyFile(source, dest);
      frame.imageFile = relativeFile;
      frame.imageSource = `game canvas readback sidecar ${name}`;
      delete frame.imageReason;
      exports.push(dest);
      attached++;
    } catch (error) {
      errors.push({ frameOrdinal: ordinal, file: name, reason: error.message });
    }
  }

  let frameImage = null;
  const last = frames.at(-1);
  if (last?.imageSource?.startsWith('game canvas readback sidecar')) {
    const dest = join(outputDir, 'frame.png');
    try { await unlink(dest); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    await copyFile(join(outputDir, last.imageFile), dest);
    frameImage = 'frame.png';
    exports.push(dest);
  }
  return { exports, attached, errors, frameImage };
}
