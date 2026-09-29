// Game canvas and pass readbacks are separate evidence. Inspector texture mip
// payloads may contain only a final state; never reuse them for earlier passes.
import { copyFile, lstat, mkdir, open, readFile, readdir, realpath, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_SIDECAR_BYTES = 128 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_PASS_RAW_BYTES = 512 * 1024 * 1024;
const RAW_FORMAT_BYTES = new Map([
  ['r8unorm', 1], ['rgba8unorm', 4], ['rgba8unorm-srgb', 4],
  ['bgra8unorm', 4], ['bgra8unorm-srgb', 4], ['rgba16float', 8], ['rgba32float', 16],
]);

function relativePng(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 240 &&
    value.endsWith('.png') && value.split('/').every(segment =>
      segment !== '.' && segment !== '..' && /^[\w.-]+$/.test(segment)) ? value : null;
}

function relativeRaw(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 240 &&
    value.endsWith('.bin') && value.split('/').every(segment =>
      segment !== '.' && segment !== '..' && /^[\w.-]+$/.test(segment)) ? value : null;
}

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
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  } finally {
    await file.close();
  }
}

async function readSidecarManifest(sourceDir) {
  const path = join(sourceDir, 'sidecars.json');
  let stat;
  try { stat = await lstat(path); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) {
    throw new Error('sidecars.json must be a regular file of at most 1 MiB');
  }
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  if (!manifest || manifest.schemaVersion !== 1 ||
      !Array.isArray(manifest.frames) || !Array.isArray(manifest.passSnapshots) ||
      !Array.isArray(manifest.gpuTimings) ||
      (manifest.passUnavailable !== undefined && !Array.isArray(manifest.passUnavailable))) {
    throw new Error('sidecars.json requires schemaVersion 1 and frames, passSnapshots, gpuTimings arrays');
  }
  return manifest;
}

async function copySidecar(sourceDir, outputDir, file, destination, expectedWidth, expectedHeight) {
  const safe = relativePng(file);
  if (!safe) throw new Error('sidecar PNG path must be a safe relative path');
  const source = join(sourceDir, ...safe.split('/'));
  const sourceRoot = await realpath(sourceDir);
  const physicalSource = await realpath(source);
  const pathWithinRoot = relative(sourceRoot, physicalSource);
  if (pathWithinRoot === '..' || pathWithinRoot.startsWith(`..${sep}`) || isAbsolute(pathWithinRoot)) {
    throw new Error('sidecar PNG escaped the capture directory');
  }
  const dimensions = await validPng(source);
  if ((expectedWidth != null && dimensions.width !== expectedWidth) ||
      (expectedHeight != null && dimensions.height !== expectedHeight)) {
    throw new Error(`sidecar PNG size ${dimensions.width}×${dimensions.height} differs from manifest`);
  }
  const dest = join(outputDir, destination);
  await mkdir(dirname(dest), { recursive: true });
  try { await unlink(dest); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  await copyFile(source, dest);
  return dest;
}

async function copyRawSidecar(sourceDir, outputDir, item, destination) {
  const safe = relativeRaw(item.rawFile);
  if (!safe) throw new Error('raw pass path must be a safe relative .bin path');
  const bpp = RAW_FORMAT_BYTES.get(item.rawFormat);
  const width = item.width;
  const height = item.height;
  const stride = item.rawBytesPerRow;
  if (!bpp || item.rawFormat !== item.format ||
      !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width < 1 || height < 1 || width > 16384 || height > 16384 ||
      stride !== Math.ceil(width * bpp / 256) * 256 ||
      !Number.isSafeInteger(item.rawByteLength) || item.rawByteLength !== stride * height ||
      item.rawByteLength > MAX_PASS_RAW_BYTES) {
    throw new Error('raw pass format, dimensions, stride, or byte length is invalid');
  }
  const sourceRoot = await realpath(sourceDir);
  const source = join(sourceDir, ...safe.split('/'));
  const physical = await realpath(source);
  const rel = relative(sourceRoot, physical);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('raw pass file escaped the capture directory');
  }
  const stat = await lstat(source);
  if (!stat.isFile() || stat.size !== item.rawByteLength) {
    throw new Error('raw pass file length differs from manifest');
  }
  if (item.rawSha256 !== undefined) {
    if (typeof item.rawSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(item.rawSha256)) {
      throw new Error('raw pass SHA-256 is invalid');
    }
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(source)) hash.update(chunk);
    if (hash.digest('hex') !== item.rawSha256) throw new Error('raw pass SHA-256 differs from manifest');
  }
  const dest = join(outputDir, destination);
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(source, dest);
  return dest;
}

function frameRecord(item, frames) {
  const ordinal = item?.frameOrdinal;
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) throw new Error('frameOrdinal must be a positive integer');
  const frame = frames.find(value => value.frameOrdinal === ordinal);
  if (!frame) throw new Error(`frame ${ordinal} does not exist in capture`);
  return frame;
}

function passRecord(item, frames, passes) {
  const frame = frameRecord(item, frames);
  if (!Number.isSafeInteger(item.passIndex) || item.passIndex < 0) {
    throw new Error('passIndex must be a nonnegative integer');
  }
  const pass = passes.find(value => value.index === item.passIndex && value.frameOrdinal === frame.frameOrdinal);
  if (!pass) throw new Error(`pass ${item.passIndex} does not belong to frame ${frame.frameOrdinal}`);
  return pass;
}

export async function attachFrameSidecars(captureFile, outputDir, frames, passes) {
  const sourceDir = dirname(captureFile);
  const exports = [];
  const errors = [];
  const passSnapshots = [];
  const passUnavailable = [];
  let attached = 0;
  let manifest = null;
  try { manifest = await readSidecarManifest(sourceDir); }
  catch (error) { errors.push({ file: 'sidecars.json', reason: error.message }); }

  // Legacy canvas readbacks predate sidecars.json and are still real per-frame
  // readbacks. Manifest entries take precedence for the same ordinal.
  const names = await readdir(sourceDir);
  const legacy = (manifest ? [] : names.filter(name => /^frame-[0-9]{4}\.png$/.test(name))).map(name => ({
    frameOrdinal: Number(name.slice(6, 10)), file: name, source: 'legacy canvas readback',
  }));
  const frameEntries = [...legacy, ...(manifest?.frames ?? []).map(item =>
    ({ ...item, source: 'sidecars.json canvas readback' }))];
  const attachedFrames = new Set();
  for (const item of frameEntries) {
    try {
      const frame = frameRecord(item, frames);
      const relativeFile = `frames/${frame.frameOrdinal}.png`;
      const dest = await copySidecar(sourceDir, outputDir, item.file, relativeFile, item.width, item.height);
      frame.imageFile = relativeFile;
      frame.imageSource = `game canvas readback sidecar ${item.file}`;
      frame.imageEvidence = item.source;
      delete frame.imageReason;
      exports.push(dest);
      if (!attachedFrames.has(frame.frameOrdinal)) { attached++; attachedFrames.add(frame.frameOrdinal); }
    } catch (error) {
      errors.push({ frameOrdinal: item.frameOrdinal, file: item.file, reason: error.message });
    }
  }

  const snapshotKeys = new Set();
  for (const item of manifest?.passSnapshots ?? []) {
    try {
      const pass = passRecord(item, frames, passes);
      if (!Number.isSafeInteger(item.afterCommandIndex) || item.afterCommandIndex !== pass.endCommand) {
        throw new Error('afterCommandIndex must equal this pass end command');
      }
      const target = pass.targets?.find(target => target.kind === 'color' &&
        target.outputTextureId === item.textureId &&
        (item.colorIndex === undefined || item.colorIndex === target.slot));
      if (!Number.isSafeInteger(item.textureId) || !target ||
          !Number.isSafeInteger(target.slot) || target.slot < 0 || target.slot > 7) {
        throw new Error('textureId must name a render target of this pass');
      }
      const key = `${item.frameOrdinal}:${item.passIndex}:${item.textureId}`;
      if (snapshotKeys.has(key)) throw new Error('duplicate pass snapshot');
      snapshotKeys.add(key);
      const snapshot = {
        frameOrdinal: item.frameOrdinal, passIndex: item.passIndex,
        afterCommandIndex: item.afterCommandIndex, textureId: item.textureId,
        imageFile: null, width: item.width ?? null, height: item.height ?? null,
        format: typeof item.format === 'string' ? item.format.slice(0, 80) : null,
        label: typeof item.label === 'string' ? item.label.slice(0, 160) : pass.label,
        source: typeof item.source === 'string' ? item.source.slice(0, 160) : 'game pass-end GPU readback sidecar',
      };
      if (item.file) {
        try {
          const relativeFile = `pass-snapshots/frame-${item.frameOrdinal}-pass-${item.passIndex}-texture-${item.textureId}.png`;
          const dest = await copySidecar(sourceDir, outputDir, item.file, relativeFile, item.width, item.height);
          snapshot.imageFile = relativeFile;
          exports.push(dest);
        } catch (error) {
          snapshot.imageReason = error.message;
          errors.push({ frameOrdinal: item.frameOrdinal, passIndex: item.passIndex, file: item.file, reason: error.message });
        }
      } else snapshot.imageReason = item.imageReason || 'Pass PNG was not saved';
      if (item.rawFile) {
        try {
          const relativeFile = `pass-raw/frame-${item.frameOrdinal}-pass-${item.passIndex}-color-${target.slot}.bin`;
          const dest = await copyRawSidecar(sourceDir, outputDir, item, relativeFile);
          snapshot.rawFile = relativeFile;
          snapshot.rawFormat = item.rawFormat;
          snapshot.rawBytesPerRow = item.rawBytesPerRow;
          snapshot.rawByteLength = item.rawByteLength;
          snapshot.rawSha256 = item.rawSha256 ?? null;
          exports.push(dest);
        } catch (error) {
          snapshot.rawReason = error.message;
          errors.push({ frameOrdinal: item.frameOrdinal, passIndex: item.passIndex, file: item.rawFile, reason: error.message });
        }
      } else snapshot.rawReason = item.rawReason || 'Pass raw pixels were not saved';
      if (!snapshot.imageFile && !snapshot.rawFile) continue;
      // A pass-end readback is a post-Draw image only for a verified one-Draw
      // physical step pass. Ordinary multi-Draw passes retain pass-end scope.
      if (pass.frameDebugStep && pass.frameDebugStep.drawCommandIndex > pass.beginCommand &&
          pass.frameDebugStep.drawCommandIndex < pass.endCommand) {
        snapshot.captureMoment = 'post-draw';
        snapshot.drawCommandIndex = pass.frameDebugStep.drawCommandIndex;
        snapshot.drawOrdinal = pass.frameDebugStep.drawOrdinal;
        snapshot.totalDraws = pass.frameDebugStep.totalDraws;
      } else snapshot.captureMoment = 'pass-end';
      (pass.snapshots ??= []).push(snapshot);
      passSnapshots.push(snapshot);
    } catch (error) {
      errors.push({ frameOrdinal: item?.frameOrdinal, passIndex: item?.passIndex, file: item?.file, reason: error.message });
    }
  }

  for (const item of manifest?.passUnavailable ?? []) {
    try {
      const pass = passRecord(item, frames, passes);
      if (typeof item.reason !== 'string' || !item.reason.trim()) {
        throw new Error('unavailable pass output needs a reason');
      }
      const partial = Array.isArray(pass.snapshots) && pass.snapshots.length > 0;
      const key = partial ? 'partialOutputUnavailableReason' : 'outputUnavailableReason';
      pass[key] = [pass[key], item.reason.slice(0, 500)].filter(Boolean).join('；');
      passUnavailable.push({ frameOrdinal: item.frameOrdinal, passIndex: item.passIndex,
        reason: item.reason.slice(0, 500), partial });
    } catch (error) {
      errors.push({ frameOrdinal: item?.frameOrdinal, passIndex: item?.passIndex, reason: error.message });
    }
  }

  const timingKeys = new Set();
  const gpuTimings = [];
  for (const item of manifest?.gpuTimings ?? []) {
    try {
      const pass = passRecord(item, frames, passes);
      if (item.source !== 'webgpu-timestamp-query' ||
          typeof item.durationMs !== 'number' || !Number.isFinite(item.durationMs) || item.durationMs < 0) {
        throw new Error('GPU duration needs a finite nonnegative ms value from webgpu-timestamp-query');
      }
      const key = `${item.frameOrdinal}:${item.passIndex}`;
      if (timingKeys.has(key)) throw new Error('duplicate GPU timing');
      timingKeys.add(key);
      pass.gpuTiming = { durationMs: item.durationMs, source: item.source };
      gpuTimings.push(pass.gpuTiming);
    } catch (error) {
      errors.push({ frameOrdinal: item?.frameOrdinal, passIndex: item?.passIndex, reason: error.message });
    }
  }

  // Inspector may record mapAsync after the final queue.submit as an inferred
  // trailing frame with no render. Use the last *actual canvas readback*.
  const last = [...frames].reverse().find(frame =>
    frame.imageSource?.startsWith('game canvas readback sidecar'));
  let frameImage = null;
  if (last?.imageSource?.startsWith('game canvas readback sidecar')) {
    const dest = join(outputDir, 'frame.png');
    // analysis_png may have hard-linked frame.png to a texture-state snapshot.
    // Break that link before replacing it with the independent game readback.
    try { await unlink(dest); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    await copyFile(join(outputDir, last.imageFile), dest);
    frameImage = 'frame.png';
    exports.push(join(outputDir, frameImage));
  }
  const status = manifest?.gpuProfilerStatus;
  const gpuProfilerStatus = status && typeof status.state === 'string' ? {
    state: status.state.slice(0, 80),
    reason: typeof status.reason === 'string' ? status.reason.slice(0, 500) : null,
  } : null;
  return {
    exports, attached, errors, frameImage, passSnapshots, passUnavailable,
    manifest: manifest ? { schemaVersion: 1, file: 'sidecars.json' } : null,
    gpuProfilerStatus,
    passCaptureWarning: typeof manifest?.passCaptureWarning === 'string' ?
      manifest.passCaptureWarning.slice(0, 500) : null,
    gpuTiming: gpuTimings.length ? {
      timedPasses: gpuTimings.length,
      sumPassDurationMs: Math.round(gpuTimings.reduce((sum, value) => sum + value.durationMs, 0) * 1000) / 1000,
      source: 'webgpu-timestamp-query',
    } : null,
  };
}
