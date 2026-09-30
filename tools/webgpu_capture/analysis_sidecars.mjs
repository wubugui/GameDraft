// Game canvas and pass readbacks are separate evidence. Inspector texture mip
// payloads may contain only a final state; never reuse them for earlier passes.
import { copyFile, lstat, mkdir, open, readFile, readdir, realpath, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_SIDECAR_BYTES = 128 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_PASS_RAW_BYTES = 512 * 1024 * 1024;
const MAX_BUFFER_ITEM_BYTES = 16 * 1024 * 1024;
const RAW_FORMAT_BYTES = new Map([
  ['r8unorm', 1], ['rg8unorm', 2], ['rgba8unorm', 4], ['rgba8unorm-srgb', 4],
  ['bgra8unorm', 4], ['bgra8unorm-srgb', 4],
  ['r16float', 2], ['rg16float', 4], ['rgba16float', 8],
  ['r32float', 4], ['rg32float', 8], ['rgba32float', 16],
  ['r32uint', 4], ['rgba32uint', 16],
  ['stencil8', 1],
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
    throw new Error('sidecars.json must be a regular file of at most 4 MiB');
  }
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  if (!manifest || manifest.schemaVersion !== 1 ||
      !Array.isArray(manifest.frames) || !Array.isArray(manifest.passSnapshots) ||
      !Array.isArray(manifest.gpuTimings) ||
      (manifest.inputSnapshots !== undefined && !Array.isArray(manifest.inputSnapshots)) ||
      (manifest.inputSnapshots?.length ?? 0) > 1024 ||
      (manifest.aspectSnapshots !== undefined && !Array.isArray(manifest.aspectSnapshots)) ||
      (manifest.aspectSnapshots?.length ?? 0) > 2048 ||
      (manifest.bufferSnapshots !== undefined && !Array.isArray(manifest.bufferSnapshots)) ||
      (manifest.bufferSnapshots?.length ?? 0) > 1024 ||
      (manifest.passUnavailable !== undefined && !Array.isArray(manifest.passUnavailable))) {
    throw new Error('sidecars.json requires schemaVersion 1 and frames, passSnapshots, gpuTimings arrays');
  }
  return manifest;
}

// A sidecar may describe a real pre-Draw input only when the Inspector command
// independently proves both object IDs are bound at that exact one-Draw pass.
export function verifiedInputBinding(pass, events, resources, item) {
  const drawCommandIndex = pass?.frameDebugStep?.drawCommandIndex;
  if (pass?.type !== 'render' || pass?.draws !== 1 ||
      !Number.isSafeInteger(drawCommandIndex) || drawCommandIndex <= pass.beginCommand ||
      drawCommandIndex >= pass.endCommand ||
      !Number.isSafeInteger(item?.textureId) || !Number.isSafeInteger(item?.viewId)) return null;
  const event = events?.[drawCommandIndex];
  if (!event || event.commandIndex !== drawCommandIndex || event.passIndex !== pass.index ||
      event.frameOrdinal !== pass.frameOrdinal ||
      !['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect'].includes(event.method)) return null;
  const view = resources?.textureViews?.find(value => value.id === item.viewId);
  if (!view || view.textureId !== item.textureId) return null;
  const baseMip = view.descriptor?.baseMipLevel ?? 0;
  const mipCount = view.descriptor?.mipLevelCount;
  const baseLayer = view.descriptor?.baseArrayLayer ?? 0;
  const layerCount = view.descriptor?.arrayLayerCount;
  if (!Number.isSafeInteger(baseMip) || baseMip < 0 ||
      !Number.isSafeInteger(baseLayer) || baseLayer < 0 ||
      (mipCount !== undefined && (!Number.isSafeInteger(mipCount) || mipCount < 1)) ||
      (layerCount !== undefined && (!Number.isSafeInteger(layerCount) || layerCount < 1)) ||
      !Number.isSafeInteger(item.mipLevel) || item.mipLevel < baseMip ||
      (Number.isSafeInteger(mipCount) && item.mipLevel >= baseMip + mipCount) ||
      !Number.isSafeInteger(item.arrayLayer) || item.arrayLayer < baseLayer ||
      (Number.isSafeInteger(layerCount) && item.arrayLayer >= baseLayer + layerCount)) return null;
  if ((item.groupSlot == null) !== (item.binding == null) ||
      (item.groupSlot != null &&
        (!Number.isSafeInteger(item.groupSlot) || item.groupSlot < 0 ||
          !Number.isSafeInteger(item.binding) || item.binding < 0))) return null;
  const candidates = [];
  for (const group of event.bindGroups ?? []) {
    for (const entry of group.resources ?? []) {
      if (entry?.resource?.type === 'TextureView' && entry.resource.id === item.viewId &&
          entry.resource.textureId === item.textureId) {
        candidates.push({ groupSlot: group.slot, binding: entry.binding });
      }
    }
  }
  if (item.groupSlot != null) {
    return candidates.find(value =>
      value.groupSlot === item.groupSlot && value.binding === item.binding) ?? null;
  }
  if (candidates.length === 1) return candidates[0];
  return candidates.length ? { groupSlot: null, binding: null,
    bindingAmbiguous: true, bindingCandidates: candidates } : null;
}

/** Only an Inspector Draw with the same native Buffer and slot can own these bytes. */
export function verifiedDrawBufferBinding(pass, events, resources, item) {
  const drawCommandIndex = pass?.frameDebugStep?.drawCommandIndex;
  if (pass?.type !== 'render' || pass.draws !== 1 ||
      !Number.isSafeInteger(drawCommandIndex) || drawCommandIndex <= pass.beginCommand ||
      drawCommandIndex >= pass.endCommand || !Number.isSafeInteger(item?.bufferId)) return null;
  const event = events?.[drawCommandIndex];
  if (!event || event.commandIndex !== drawCommandIndex || event.passIndex !== pass.index ||
      event.frameOrdinal !== pass.frameOrdinal ||
      !['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect'].includes(event.method)) return null;
  const resource = resources?.buffers?.find(value => value.id === item.bufferId);
  if (!resource || Number.isSafeInteger(resource.size) && resource.size !== item.totalSize) return null;
  if (['uniform', 'storage', 'read-only-storage'].includes(item.role)) {
    const group = event.bindGroups?.find(value => value.slot === item.groupSlot);
    if (!group || (group.dynamicOffsets?.length ?? 0) > 0) return null;
    const binding = group.resources?.find(value => value.binding === item.binding);
    if (binding?.resource?.type !== 'Buffer' || binding.resource.id !== item.bufferId ||
        (binding.resource.offset ?? 0) !== item.offset ||
        (Number.isSafeInteger(binding.resource.size) && binding.resource.size !== item.size)) return null;
    return { groupSlot: item.groupSlot, binding: item.binding };
  }
  if (item.role === 'vertex') {
    const stream = event.vertexBuffers?.find(value => value.slot === item.vertexSlot);
    if (!stream || stream.id !== item.bufferId || stream.offset !== item.offset ||
        (Number.isSafeInteger(stream.size) && stream.size !== item.size)) return null;
    return { vertexSlot: item.vertexSlot };
  }
  if (item.role === 'index') {
    const bound = event.indexBuffer;
    const stride = item.indexFormat === 'uint16' ? 2 : item.indexFormat === 'uint32' ? 4 : 0;
    if (!bound || bound.id !== item.bufferId || bound.format !== item.indexFormat ||
        !stride || event.method !== 'drawIndexed' ||
        !Number.isSafeInteger(event.args?.[0]) || !Number.isSafeInteger(event.args?.[2])) return null;
    const offset = (bound.offset ?? 0) + event.args[2] * stride;
    const size = event.args[0] * stride;
    if (offset !== item.offset || size !== item.size ||
        (Number.isSafeInteger(bound.size) && offset + size > (bound.offset ?? 0) + bound.size)) return null;
    return { indexFormat: item.indexFormat };
  }
  return null;
}

async function copySidecar(sourceDir, outputDir, file, destination, expectedWidth, expectedHeight,
  expectedSha256 = null) {
  const safe = relativePng(file);
  if (!safe) throw new Error('sidecar PNG path must be a safe relative path');
  if (expectedSha256 !== null && (typeof expectedSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(expectedSha256))) {
    throw new Error('sidecar PNG SHA-256 is missing or invalid');
  }
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
  if (expectedSha256 !== null) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(dest)) hash.update(chunk);
    if (hash.digest('hex') !== expectedSha256) {
      await unlink(dest);
      throw new Error('sidecar PNG SHA-256 differs from manifest');
    }
  }
  return dest;
}

async function copyRawSidecar(sourceDir, outputDir, item, destination, requireHash = false,
  expectedFormat = item.format) {
  const safe = relativeRaw(item.rawFile);
  if (!safe) throw new Error('raw pass path must be a safe relative .bin path');
  const bpp = RAW_FORMAT_BYTES.get(item.rawFormat);
  const width = item.width;
  const height = item.height;
  const stride = item.rawBytesPerRow;
  if (!bpp || item.rawFormat !== expectedFormat ||
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
  if (requireHash && item.rawSha256 === undefined) {
    throw new Error('raw input SHA-256 is missing');
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
  if (requireHash) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(dest)) hash.update(chunk);
    if (hash.digest('hex') !== item.rawSha256) {
      await unlink(dest);
      throw new Error('raw input SHA-256 differs after copying');
    }
  }
  return dest;
}

async function copyDrawBufferSidecar(sourceDir, outputDir, item, destination) {
  const safe = relativeRaw(item.rawFile);
  if (!safe) throw new Error('Draw buffer path must be a safe relative .bin path');
  if (typeof item.rawSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(item.rawSha256)) {
    throw new Error('Draw buffer SHA-256 is missing or invalid');
  }
  if (!Number.isSafeInteger(item.rawByteLength) ||
      item.rawByteLength !== item.copiedSize || item.rawByteLength < 4 ||
      item.rawByteLength > MAX_BUFFER_ITEM_BYTES) {
    throw new Error('Draw buffer length differs from copied range');
  }
  const sourceRoot = await realpath(sourceDir);
  const source = join(sourceDir, ...safe.split('/'));
  const physical = await realpath(source);
  const rel = relative(sourceRoot, physical);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('Draw buffer file escaped capture directory');
  }
  const stat = await lstat(source);
  if (!stat.isFile() || stat.size !== item.rawByteLength) {
    throw new Error('Draw buffer file length differs from manifest');
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(source)) hash.update(chunk);
  if (hash.digest('hex') !== item.rawSha256) throw new Error('Draw buffer SHA-256 differs from manifest');
  const dest = join(outputDir, destination);
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(source, dest);
  const copiedHash = createHash('sha256');
  for await (const chunk of createReadStream(dest)) copiedHash.update(chunk);
  if (copiedHash.digest('hex') !== item.rawSha256) {
    await unlink(dest);
    throw new Error('Draw buffer SHA-256 differs after copying');
  }
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

export async function attachFrameSidecars(captureFile, outputDir, frames, passes,
  events = [], resources = {}) {
  const sourceDir = dirname(captureFile);
  const exports = [];
  const errors = [];
  const passSnapshots = [];
  const inputSnapshots = [];
  const aspectSnapshots = [];
  const bufferSnapshots = [];
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

  const inputOrdinals = new Set();
  for (const item of manifest?.inputSnapshots ?? []) {
    try {
      const pass = passRecord(item, frames, passes);
      if (!Number.isSafeInteger(item.inputOrdinal) || item.inputOrdinal < 0 ||
          item.inputOrdinal >= 1024 || inputOrdinals.has(item.inputOrdinal) ||
          typeof item.bindingName !== 'string' || !item.bindingName.trim() ||
          item.bindingName.length > 160 ||
          !Number.isSafeInteger(item.mipLevel) || item.mipLevel < 0 ||
          !Number.isSafeInteger(item.arrayLayer) || item.arrayLayer < 0 ||
          !Number.isSafeInteger(item.width) || item.width < 0 || item.width > 16384 ||
          !Number.isSafeInteger(item.height) || item.height < 0 || item.height > 16384 ||
          typeof item.format !== 'string' || item.format.length > 80) {
        throw new Error('input snapshot metadata is invalid or duplicated');
      }
      inputOrdinals.add(item.inputOrdinal);
      const binding = verifiedInputBinding(pass, events, resources, item);
      const drawCommandIndex = pass.frameDebugStep?.drawCommandIndex;
      const base = {
        frameOrdinal: item.frameOrdinal, passIndex: item.passIndex,
        inputOrdinal: item.inputOrdinal, bindingName: item.bindingName,
        textureId: item.textureId ?? null, viewId: item.viewId ?? null,
        mipLevel: item.mipLevel, arrayLayer: item.arrayLayer,
        width: item.width, height: item.height, format: item.format,
        imageFile: null, rawFile: null,
      };
      if (!binding || item.beforeCommandIndex !== drawCommandIndex ||
          (!item.file && !item.rawFile)) {
        const unavailable = { ...base, captureMoment: 'unavailable',
          reason: typeof item.reason === 'string' && item.reason.trim() ?
            item.reason.slice(0, 500) :
            !binding ? 'input IDs do not match the selected Draw bindings' :
              item.beforeCommandIndex !== drawCommandIndex ?
                'input capture command does not match the selected Draw' :
                'input pixels were not saved' };
        (pass.inputSnapshots ??= []).push(unavailable);
        inputSnapshots.push(unavailable);
        continue;
      }
      const snapshot = { ...base, captureMoment: 'pre-draw',
        drawCommandIndex, groupSlot: binding.groupSlot, binding: binding.binding,
        ...(binding.bindingAmbiguous ? {
          bindingAmbiguous: true, bindingCandidates: binding.bindingCandidates,
        } : {}),
        source: 'RHI pre-Draw GPU readback' };
      if (item.file) {
        try {
          if (typeof item.imageSha256 !== 'string') throw new Error('input PNG SHA-256 is missing');
          const relativeFile = `input-snapshots/frame-${item.frameOrdinal}-pass-${item.passIndex}-input-${item.inputOrdinal}.png`;
          const dest = await copySidecar(sourceDir, outputDir, item.file, relativeFile,
            item.width, item.height, item.imageSha256);
          snapshot.imageFile = relativeFile;
          snapshot.imageSha256 = item.imageSha256;
          exports.push(dest);
        } catch (error) {
          snapshot.imageReason = error.message;
          errors.push({ inputOrdinal: item.inputOrdinal, file: item.file, reason: error.message });
        }
      } else snapshot.imageReason = item.imageReason || 'Input PNG was not saved';
      if (item.rawFile) {
        try {
          const relativeFile = `input-raw/frame-${item.frameOrdinal}-pass-${item.passIndex}-input-${item.inputOrdinal}.bin`;
          const dest = await copyRawSidecar(sourceDir, outputDir, item, relativeFile, true);
          snapshot.rawFile = relativeFile;
          snapshot.rawFormat = item.rawFormat;
          snapshot.rawBytesPerRow = item.rawBytesPerRow;
          snapshot.rawByteLength = item.rawByteLength;
          snapshot.rawSha256 = item.rawSha256;
          exports.push(dest);
        } catch (error) {
          snapshot.rawReason = error.message;
          errors.push({ inputOrdinal: item.inputOrdinal, file: item.rawFile, reason: error.message });
        }
      } else snapshot.rawReason = item.rawReason || 'Input raw pixels were not saved';
      if (!snapshot.imageFile && !snapshot.rawFile) {
        snapshot.captureMoment = 'unavailable';
        snapshot.reason = 'input pixel files failed validation';
        delete snapshot.source;
        delete snapshot.drawCommandIndex;
      }
      (pass.inputSnapshots ??= []).push(snapshot);
      inputSnapshots.push(snapshot);
    } catch (error) {
      errors.push({ inputOrdinal: item?.inputOrdinal, passIndex: item?.passIndex,
        file: item?.file ?? item?.rawFile, reason: error.message });
    }
  }

  const bufferOrdinals = new Set();
  for (const item of manifest?.bufferSnapshots ?? []) {
    try {
      const pass = passRecord(item, frames, passes);
      if (!Number.isSafeInteger(item.bufferOrdinal) || item.bufferOrdinal < 0 ||
          item.bufferOrdinal >= 1024 || bufferOrdinals.has(item.bufferOrdinal) ||
          !Number.isSafeInteger(item.passOrdinal) || item.passOrdinal < 0 ||
          !['uniform', 'storage', 'read-only-storage', 'vertex', 'index'].includes(item.role) ||
          !Number.isSafeInteger(item.totalSize) || item.totalSize < 0 ||
          !Number.isSafeInteger(item.offset) || !Number.isSafeInteger(item.size) ||
          !Number.isSafeInteger(item.copiedOffset) || item.copiedOffset < 0 ||
          !Number.isSafeInteger(item.copiedSize) || item.copiedSize < 0 ||
          !['binding', 'draw-indices', 'bound-suffix'].includes(item.rangeScope)) {
        throw new Error('pre-Draw buffer metadata is invalid or duplicated');
      }
      bufferOrdinals.add(item.bufferOrdinal);
      const renderPasses = passes.filter(value =>
        value.frameOrdinal === item.frameOrdinal && value.type === 'render');
      const binding = renderPasses[item.passOrdinal]?.index === pass.index ?
        verifiedDrawBufferBinding(pass, events, resources, item) : null;
      const rangeValid = item.offset >= 0 && item.size > 0 &&
        Number.isSafeInteger(item.offset + item.size) &&
        item.offset + item.size <= item.totalSize &&
        item.copiedOffset % 4 === 0 && item.copiedSize % 4 === 0 &&
        item.copiedSize >= 4 && item.copiedSize <= MAX_BUFFER_ITEM_BYTES &&
        item.copiedOffset <= item.offset &&
        item.copiedOffset + item.copiedSize >= item.offset + item.size &&
        item.copiedOffset + item.copiedSize <= item.totalSize;
      const base = {
        frameOrdinal: item.frameOrdinal, passIndex: item.passIndex,
        bufferOrdinal: item.bufferOrdinal, role: item.role,
        ...(item.bindingName !== undefined ? { bindingName: item.bindingName } : {}),
        ...(item.groupSlot !== undefined ? { groupSlot: item.groupSlot } : {}),
        ...(item.binding !== undefined ? { binding: item.binding } : {}),
        ...(item.streamName !== undefined ? { streamName: item.streamName } : {}),
        ...(item.vertexSlot !== undefined ? { vertexSlot: item.vertexSlot } : {}),
        ...(item.indexFormat !== undefined ? { indexFormat: item.indexFormat } : {}),
        bufferId: item.bufferId ?? null,
        bufferLabel: typeof item.bufferLabel === 'string' ? item.bufferLabel.slice(0, 200) : '',
        totalSize: item.totalSize, offset: item.offset, size: item.size,
        copiedOffset: item.copiedOffset, copiedSize: item.copiedSize,
        rangeScope: item.rangeScope, rawFile: null,
      };
      if (!binding || !rangeValid ||
          item.beforeCommandIndex !== pass.frameDebugStep?.drawCommandIndex || !item.rawFile) {
        const unavailable = { ...base, captureMoment: 'unavailable',
          reason: !binding ? 'Buffer ID, slot, or byte range does not match selected Draw bindings' :
            !rangeValid ? 'copied Buffer byte range is invalid' :
            item.beforeCommandIndex !== pass.frameDebugStep?.drawCommandIndex ?
              'buffer capture command does not match selected Draw' :
              typeof item.reason === 'string' && item.reason.trim() ?
                item.reason.slice(0, 500) : 'pre-Draw buffer bytes were not saved' };
        (pass.bufferSnapshots ??= []).push(unavailable);
        bufferSnapshots.push(unavailable);
        continue;
      }
      const snapshot = { ...base, captureMoment: 'pre-draw',
        drawCommandIndex: pass.frameDebugStep.drawCommandIndex,
        source: 'RHI pre-Draw GPU buffer copy' };
      try {
        const relativeFile = `buffer-snapshots/frame-${item.frameOrdinal}-pass-${item.passIndex}-buffer-${item.bufferOrdinal}.bin`;
        const dest = await copyDrawBufferSidecar(sourceDir, outputDir, item, relativeFile);
        snapshot.rawFile = relativeFile;
        snapshot.rawByteLength = item.rawByteLength;
        snapshot.rawSha256 = item.rawSha256;
        exports.push(dest);
      } catch (error) {
        snapshot.captureMoment = 'unavailable';
        snapshot.reason = 'pre-Draw buffer file failed validation';
        snapshot.rawReason = error.message;
        delete snapshot.drawCommandIndex;
        delete snapshot.source;
        errors.push({ bufferOrdinal: item.bufferOrdinal, file: item.rawFile, reason: error.message });
      }
      (pass.bufferSnapshots ??= []).push(snapshot);
      bufferSnapshots.push(snapshot);
    } catch (error) {
      errors.push({ bufferOrdinal: item?.bufferOrdinal, passIndex: item?.passIndex,
        file: item?.rawFile, reason: error.message });
    }
  }

  const aspectOrdinals = new Set();
  const aspectKeys = new Set();
  for (const item of manifest?.aspectSnapshots ?? []) {
    try {
      const pass = passRecord(item, frames, passes);
      if (pass.type !== 'render' || !['depth', 'stencil'].includes(item.aspect) ||
          !Number.isSafeInteger(item.passOrdinal) || item.passOrdinal < 0 ||
          (item.aspectOrdinal !== null &&
            (!Number.isSafeInteger(item.aspectOrdinal) || item.aspectOrdinal < 0 ||
              item.aspectOrdinal >= 1024 || aspectOrdinals.has(item.aspectOrdinal))) ||
          aspectKeys.has(`${item.frameOrdinal}:${item.passIndex}:${item.aspect}`) ||
          typeof item.sourceFormat !== 'string' || item.sourceFormat.length > 80 ||
          item.rawFormat !== (item.aspect === 'depth' ? 'r32float' : 'stencil8') ||
          !Number.isSafeInteger(item.sampleCount) || item.sampleCount < 1 ||
          item.sampleCount > 32 ||
          (item.sampleIndex !== null &&
            (!Number.isSafeInteger(item.sampleIndex) || item.sampleIndex < 0 ||
              item.sampleIndex >= item.sampleCount))) {
        throw new Error('depth/stencil aspect metadata is invalid or duplicated');
      }
      if (item.aspectOrdinal !== null) aspectOrdinals.add(item.aspectOrdinal);
      aspectKeys.add(`${item.frameOrdinal}:${item.passIndex}:${item.aspect}`);
      const target = pass.targets?.find(value => value.kind === 'depth-stencil');
      const texture = resources?.textures?.find(value => value.id === target?.textureId);
      const renderPasses = passes.filter(value =>
        value.frameOrdinal === item.frameOrdinal && value.type === 'render');
      const attachmentMatches = renderPasses[item.passOrdinal]?.index === pass.index &&
        item.label === pass.label && target && target.textureId === item.textureId &&
        target.viewId === item.viewId &&
        (item.aspect === 'depth' ? target.format?.startsWith('depth') :
          target.format?.includes('stencil8')) &&
        (target.format == null || target.format === item.sourceFormat) &&
        (texture?.descriptor?.sampleCount == null ||
          texture.descriptor.sampleCount === item.sampleCount);
      const base = {
        frameOrdinal: item.frameOrdinal, passIndex: item.passIndex,
        aspectOrdinal: item.aspectOrdinal, aspect: item.aspect,
        textureId: item.textureId ?? null, viewId: item.viewId ?? null,
        width: item.width ?? null, height: item.height ?? null,
        sourceFormat: item.sourceFormat, rawFormat: item.rawFormat,
        sampleCount: item.sampleCount, sampleIndex: item.sampleIndex,
        imageFile: null, rawFile: null,
      };
      if (!attachmentMatches || item.afterCommandIndex !== pass.endCommand ||
          (!item.file && !item.rawFile)) {
        const unavailable = { ...base, captureMoment: 'unavailable',
          reason: !attachmentMatches ?
            'depth/stencil attachment IDs, format, or sample count differ from Inspector capture' :
            item.file || item.rawFile ?
              'aspect capture command does not match this Pass end' :
              typeof item.reason === 'string' && item.reason.trim() ?
                item.reason.slice(0, 500) : 'depth/stencil pixels were not saved' };
        (pass.aspectSnapshots ??= []).push(unavailable);
        aspectSnapshots.push(unavailable);
        continue;
      }
      const snapshot = { ...base, captureMoment: 'pass-end',
        afterCommandIndex: pass.endCommand, source: 'RHI depth/stencil pass-end GPU readback' };
      if (item.file) {
        try {
          if (typeof item.imageSha256 !== 'string') throw new Error('aspect PNG SHA-256 is missing');
          const relativeFile = `aspect-snapshots/frame-${item.frameOrdinal}-pass-${item.passIndex}-${item.aspect}.png`;
          const dest = await copySidecar(sourceDir, outputDir, item.file, relativeFile,
            item.width, item.height, item.imageSha256);
          snapshot.imageFile = relativeFile;
          snapshot.imageSha256 = item.imageSha256;
          exports.push(dest);
        } catch (error) {
          snapshot.imageReason = error.message;
          errors.push({ aspectOrdinal: item.aspectOrdinal, file: item.file, reason: error.message });
        }
      } else snapshot.imageReason = item.imageReason || 'Aspect PNG was not saved';
      if (item.rawFile) {
        try {
          const relativeFile = `aspect-raw/frame-${item.frameOrdinal}-pass-${item.passIndex}-${item.aspect}.bin`;
          const dest = await copyRawSidecar(sourceDir, outputDir, item, relativeFile, true,
            item.rawFormat);
          snapshot.rawFile = relativeFile;
          snapshot.rawBytesPerRow = item.rawBytesPerRow;
          snapshot.rawByteLength = item.rawByteLength;
          snapshot.rawSha256 = item.rawSha256;
          exports.push(dest);
        } catch (error) {
          snapshot.rawReason = error.message;
          errors.push({ aspectOrdinal: item.aspectOrdinal, file: item.rawFile, reason: error.message });
        }
      } else snapshot.rawReason = item.rawReason || 'Aspect raw pixels were not saved';
      if (!snapshot.imageFile && !snapshot.rawFile) {
        snapshot.captureMoment = 'unavailable';
        snapshot.reason = 'depth/stencil pixel files failed validation';
        delete snapshot.source;
        delete snapshot.afterCommandIndex;
      }
      (pass.aspectSnapshots ??= []).push(snapshot);
      aspectSnapshots.push(snapshot);
    } catch (error) {
      errors.push({ aspectOrdinal: item?.aspectOrdinal, passIndex: item?.passIndex,
        file: item?.file ?? item?.rawFile, reason: error.message });
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
    exports, attached, errors, frameImage, passSnapshots, inputSnapshots,
    aspectSnapshots, bufferSnapshots, passUnavailable,
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
