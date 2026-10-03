// Game canvas and pass readbacks are separate evidence. Inspector texture mip
// payloads may contain only a final state; never reuse them for earlier passes.
import { copyFile, link, lstat, mkdir, open, readFile, readdir, realpath, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_SIDECAR_BYTES = 128 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_PASS_RAW_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_INPUT_RAW_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_INPUT_RECORDS = 512 * 16;
const MAX_BUFFER_ITEM_BYTES = 256 * 1024 * 1024;
const MAX_RESOURCE_TEXTURE_RAW_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_RESOURCE_BUFFER_RAW_BYTES = 1024 * 1024 * 1024;
const RAW_FORMAT_BYTES = new Map([
  ['r8unorm', 1], ['rg8unorm', 2], ['rgba8unorm', 4], ['rgba8unorm-srgb', 4],
  ['bgra8unorm', 4], ['bgra8unorm-srgb', 4],
  ['r16float', 2], ['rg16float', 4], ['rgba16float', 8],
  ['r32float', 4], ['rg32float', 8], ['rgba32float', 16],
  ['r32uint', 4], ['rgba32uint', 16],
  ['stencil8', 1],
]);

function sameContentIdentity(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeNs === b.mtimeNs;
}

async function checkedSourceHash(source, expectedSha256, description) {
  const before = await lstat(source, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`${description} is not an ordinary file`);
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(source)) hash.update(chunk);
  const after = await lstat(source, { bigint: true });
  if (!sameContentIdentity(before, after) || before.ctimeNs !== after.ctimeNs) {
    throw new Error(`${description} changed during SHA-256 validation`);
  }
  if (hash.digest('hex') !== expectedSha256) {
    throw new Error(`${description} SHA-256 differs from manifest`);
  }
  return after;
}

async function linkVerifiedSidecar(source, dest, outputDir, expectedSha256,
  sourceInfo, verifiedFiles) {
  if (!verifiedFiles || !sourceInfo || typeof sourceInfo.ino !== 'bigint' ||
      sourceInfo.ino <= 0n) return false;
  try {
    await link(source, dest);
  } catch (error) {
    if (['EXDEV', 'ENOTSUP', 'ENOSYS', 'EPERM', 'EACCES', 'EMLINK', 'EINVAL']
      .includes(error?.code)) return false;
    throw error;
  }
  try {
    const currentSource = await lstat(source, { bigint: true });
    const linked = await lstat(dest, { bigint: true });
    if (!currentSource.isFile() || !linked.isFile() ||
        !sameContentIdentity(sourceInfo, currentSource) ||
        !sameContentIdentity(currentSource, linked)) {
      throw new Error('sidecar hard link does not match its verified source');
    }
    const name = relative(outputDir, dest).replaceAll('\\', '/');
    verifiedFiles.set(name, { sha256: expectedSha256, dev: linked.dev,
      ino: linked.ino, size: linked.size, mtimeNs: linked.mtimeNs,
      ctimeNs: linked.ctimeNs });
    return true;
  } catch (error) {
    try { await unlink(dest); } catch { /* Preserve the identity error. */ }
    throw error;
  }
}

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
    throw new Error('sidecars.json must be a regular file of at most 64 MiB');
  }
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  if (!manifest || manifest.schemaVersion !== 1 ||
      !Array.isArray(manifest.frames) || !Array.isArray(manifest.passSnapshots) ||
      !Array.isArray(manifest.gpuTimings) ||
      (manifest.inputSnapshots !== undefined && !Array.isArray(manifest.inputSnapshots)) ||
      (manifest.inputSnapshots?.length ?? 0) > 120 * MAX_INPUT_RECORDS ||
      (manifest.aspectSnapshots !== undefined && !Array.isArray(manifest.aspectSnapshots)) ||
      (manifest.aspectSnapshots?.length ?? 0) > 120 * 2048 ||
      (manifest.bufferSnapshots !== undefined && !Array.isArray(manifest.bufferSnapshots)) ||
      (manifest.bufferSnapshots?.length ?? 0) > 120 * 8192 ||
      (manifest.resourceTextureSnapshots !== undefined && !Array.isArray(manifest.resourceTextureSnapshots)) ||
      (manifest.resourceTextureSnapshots?.length ?? 0) > 120 * 8192 ||
      (manifest.resourceBufferSnapshots !== undefined && !Array.isArray(manifest.resourceBufferSnapshots)) ||
      (manifest.resourceBufferSnapshots?.length ?? 0) > 120 * 4096 ||
      (manifest.diagnosticFrames !== undefined && !Array.isArray(manifest.diagnosticFrames)) ||
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

/** A logical capture frame must have one unambiguous Inspector command range. */
export function inspectorCaptureFrames(frames, passes, actualFrames) {
  if (!Number.isInteger(actualFrames) || actualFrames < 1) return [];
  const displayFrames = frames.filter(frame => frame.frameTextureId != null &&
    passes.some(pass => pass.frameOrdinal === frame.frameOrdinal &&
      pass.targets?.some(target => target.outputTextureId === frame.frameTextureId)));
  if (displayFrames.length) return displayFrames.length === actualFrames ? displayFrames : [];
  // Offscreen-only captures have no getCurrentTexture command. Fall back only
  // when every requested frame has an independently bounded render or submit.
  const rendered = frames.filter(frame => passes.some(pass =>
    pass.frameOrdinal === frame.frameOrdinal && pass.type === 'render'));
  if (rendered.length) return rendered.length === actualFrames ? rendered : [];
  const submitted = frames.filter(frame => Number.isInteger(frame.submitCommandIndex));
  return submitted.length === actualFrames ? submitted : [];
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
  expectedSha256 = null, verifiedFiles = null) {
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
  const sourceInfo = expectedSha256 === null ? null :
    await checkedSourceHash(physicalSource, expectedSha256, 'sidecar PNG');
  if (sourceInfo && await linkVerifiedSidecar(physicalSource, dest, outputDir,
    expectedSha256, sourceInfo, verifiedFiles)) return dest;
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
  expectedFormat = item.format, maxBytes = MAX_PASS_RAW_BYTES, allowPacked = false,
  verifiedFiles = null) {
  const safe = relativeRaw(item.rawFile);
  if (!safe) throw new Error('raw pass path must be a safe relative .bin path');
  const bpp = RAW_FORMAT_BYTES.get(item.rawFormat);
  const width = item.width;
  const height = item.height;
  const stride = item.rawBytesPerRow;
  if (!bpp || item.rawFormat !== expectedFormat ||
      !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width < 1 || height < 1 || width > 16384 || height > 16384 ||
      stride !== Math.ceil(width * bpp / 256) * 256 &&
        !(allowPacked && stride === width * bpp) ||
      !Number.isSafeInteger(item.rawByteLength) || item.rawByteLength !== stride * height ||
      item.rawByteLength > maxBytes) {
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
  let sourceInfo = null;
  if (item.rawSha256 !== undefined) {
    if (typeof item.rawSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(item.rawSha256)) {
      throw new Error('raw pass SHA-256 is invalid');
    }
    sourceInfo = await checkedSourceHash(physical, item.rawSha256, 'raw pass');
  }
  const dest = join(outputDir, destination);
  await mkdir(dirname(dest), { recursive: true });
  if (sourceInfo && await linkVerifiedSidecar(physical, dest, outputDir,
    item.rawSha256, sourceInfo, verifiedFiles)) return dest;
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

async function copyDrawBufferSidecar(sourceDir, outputDir, item, destination,
  maxBytes = MAX_BUFFER_ITEM_BYTES, verifiedFiles = null) {
  const safe = relativeRaw(item.rawFile);
  if (!safe) throw new Error('Draw buffer path must be a safe relative .bin path');
  if (typeof item.rawSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(item.rawSha256)) {
    throw new Error('Draw buffer SHA-256 is missing or invalid');
  }
  if (!Number.isSafeInteger(item.rawByteLength) ||
      item.rawByteLength !== item.copiedSize || item.rawByteLength < 4 ||
      item.rawByteLength > maxBytes) {
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
  const sourceInfo = await checkedSourceHash(physical, item.rawSha256, 'Draw buffer');
  const dest = join(outputDir, destination);
  await mkdir(dirname(dest), { recursive: true });
  if (await linkVerifiedSidecar(physical, dest, outputDir,
    item.rawSha256, sourceInfo, verifiedFiles)) return dest;
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
  events = [], resources = {}, options = {}) {
  const sourceDir = dirname(captureFile);
  const exports = [];
  const verifiedFiles = new Map();
  const linkCredentials = options.preferHardLinks === true ? verifiedFiles : null;
  const errors = [];
  const passSnapshots = [];
  const inputSnapshots = [];
  const aspectSnapshots = [];
  const bufferSnapshots = [];
  const resourceTextureSnapshots = [];
  const resourceBufferSnapshots = [];
  const passUnavailable = [];
  let attached = 0;
  let manifest = null;
  let captureFrames = [];
  try { manifest = await readSidecarManifest(sourceDir); }
  catch (error) { errors.push({ file: 'sidecars.json', reason: error.message }); }

  // Every new diagnostic frame carries its independently parsed Inspector
  // ordinal. Keep the selected-frame check for older sidecar manifests.
  if (manifest?.diagnosticFrames || manifest?.detailedFrameIndex !== undefined) {
    try {
      const deepItems = [
        ...manifest.passSnapshots, ...(manifest.passUnavailable ?? []),
        ...(manifest.inputSnapshots ?? []), ...(manifest.aspectSnapshots ?? []),
        ...(manifest.bufferSnapshots ?? []),
        ...(manifest.resourceTextureSnapshots ?? []),
        ...(manifest.resourceBufferSnapshots ?? []), ...manifest.gpuTimings,
      ];
      if (!Number.isInteger(manifest.actualFrames) || manifest.actualFrames < 1 ||
          manifest.actualFrames > 120) {
        throw new Error('sidecar actual frame count is invalid');
      }
      captureFrames = inspectorCaptureFrames(frames, passes, manifest.actualFrames);
      if (manifest.diagnosticFrames) {
        if (captureFrames.length !== manifest.actualFrames ||
            manifest.diagnosticFrames.length !== manifest.actualFrames ||
            manifest.diagnosticFrames.some((item, index) =>
              item?.frameIndex !== index + 1 ||
              item.frameOrdinal !== captureFrames[index]?.frameOrdinal) ||
            deepItems.some(item => !manifest.diagnosticFrames.some(frame =>
              frame.frameOrdinal === item?.frameOrdinal))) {
          throw new Error('sidecar diagnostics do not match all Inspector capture frames');
        }
        for (const frame of manifest.diagnosticFrames) {
          const inventory = frame.resourceInventory;
          const textures = (manifest.resourceTextureSnapshots ?? []).filter(item =>
            item.frameOrdinal === frame.frameOrdinal);
          const buffers = (manifest.resourceBufferSnapshots ?? []).filter(item =>
            item.frameOrdinal === frame.frameOrdinal);
          if (!inventory || textures.length !== inventory.textureSubresourceCount ||
              new Set(textures.map(item => item.textureOrdinal)).size !== inventory.textureCount ||
              buffers.length !== inventory.bufferCount ||
              textures.some((item, index) => item.resourceOrdinal !== index || !item.rawFile) ||
              buffers.some((item, index) => item.resourceOrdinal !== index || !item.rawFile)) {
            throw new Error('sidecar frame-end resource inventory is incomplete');
          }
        }
      } else {
        if (!Number.isInteger(manifest.detailedFrameIndex) ||
            manifest.detailedFrameIndex < 1 || manifest.detailedFrameIndex > manifest.actualFrames) {
          throw new Error('sidecar selected frame index is invalid');
        }
        const selected = captureFrames[manifest.detailedFrameIndex - 1];
        if (deepItems.length && (!selected ||
            manifest.diagnosticFrameOrdinal !== selected.frameOrdinal ||
            deepItems.some(item => item?.frameOrdinal !== selected.frameOrdinal))) {
          throw new Error('sidecar deep diagnostics do not belong to the selected Inspector frame');
        }
      }
    } catch (error) {
      errors.push({ file: 'sidecars.json', reason: error.message });
      manifest = { ...manifest, passSnapshots: [], passUnavailable: [], inputSnapshots: [],
        aspectSnapshots: [], bufferSnapshots: [], resourceTextureSnapshots: [],
        resourceBufferSnapshots: [], diagnosticFrames: [], gpuTimings: [] };
    }
  }

  // Legacy canvas readbacks predate sidecars.json and are still real per-frame
  // readbacks. Manifest entries take precedence for the same ordinal.
  const names = await readdir(sourceDir);
  const legacy = (manifest ? [] : names.filter(name => /^frame-[0-9]{4}\.png$/.test(name))).map(name => ({
    frameOrdinal: Number(name.slice(6, 10)), file: name, source: 'legacy canvas readback',
  }));
  const frameEntries = [...legacy, ...(manifest?.frames ?? []).map(item =>
    ({ ...item, source: 'sidecars.json canvas readback' }))];
  let checked = 0;
  const total = frameEntries.length + ['passSnapshots', 'inputSnapshots', 'bufferSnapshots',
    'aspectSnapshots', 'resourceTextureSnapshots', 'resourceBufferSnapshots']
    .reduce((count, key) => count + (manifest?.[key]?.length ?? 0), 0);
  function* progressEntries(items) {
    options.onProgress?.('校验并关联资源快照', checked, total, '项');
    for (const item of items) {
      yield item;
      options.onProgress?.('校验并关联资源快照', ++checked, total, '项');
    }
  }
  const attachedFrames = new Set();
  for (const item of progressEntries(frameEntries)) {
    try {
      const frame = frameRecord(item, frames);
      if (manifest?.detailedFrameIndex !== undefined &&
          (!Number.isInteger(item.frameIndex) ||
            captureFrames[item.frameIndex - 1]?.frameOrdinal !== frame.frameOrdinal ||
            typeof item.sha256 !== 'string')) {
        throw new Error('canvas image does not belong to its recorded capture frame');
      }
      const relativeFile = `frames/${frame.frameOrdinal}.png`;
      const dest = await copySidecar(sourceDir, outputDir, item.file, relativeFile,
        item.width, item.height, item.sha256 ?? null, linkCredentials);
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
  for (const item of progressEntries(manifest?.passSnapshots ?? [])) {
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
          if (manifest.detailedFrameIndex !== undefined && !item.imageSha256) {
            throw new Error('pass PNG SHA-256 is missing');
          }
          const dest = await copySidecar(sourceDir, outputDir, item.file, relativeFile,
            item.width, item.height, item.imageSha256 ?? null, linkCredentials);
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
          const dest = await copyRawSidecar(sourceDir, outputDir, item, relativeFile,
            false, item.format, MAX_PASS_RAW_BYTES, false, linkCredentials);
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
  const inputManifestByOrdinal = new Map((manifest?.inputSnapshots ?? []).map(item =>
    [`${item.frameOrdinal}:${item.inputOrdinal}`, item]));
  const copiedInputPng = new Map();
  const copiedInputRaw = new Map();
  for (const item of progressEntries(manifest?.inputSnapshots ?? [])) {
    try {
      const pass = passRecord(item, frames, passes);
      if (!Number.isSafeInteger(item.inputOrdinal) || item.inputOrdinal < 0 ||
          item.inputOrdinal >= MAX_INPUT_RECORDS ||
          inputOrdinals.has(`${item.frameOrdinal}:${item.inputOrdinal}`) ||
          typeof item.bindingName !== 'string' || !item.bindingName.trim() ||
          item.bindingName.length > 160 ||
          !Number.isSafeInteger(item.mipLevel) || item.mipLevel < 0 ||
          !Number.isSafeInteger(item.arrayLayer) || item.arrayLayer < 0 ||
          !Number.isSafeInteger(item.width) || item.width < 0 || item.width > 16384 ||
          !Number.isSafeInteger(item.height) || item.height < 0 || item.height > 16384 ||
          typeof item.format !== 'string' || item.format.length > 80 ||
          (item.contentVersion !== undefined &&
            (!Number.isSafeInteger(item.contentVersion) || item.contentVersion < 0))) {
        throw new Error('input snapshot metadata is invalid or duplicated');
      }
      inputOrdinals.add(`${item.frameOrdinal}:${item.inputOrdinal}`);
      const aliasSource = item.rawAliasInputOrdinal === undefined ? null :
        inputManifestByOrdinal.get(`${item.frameOrdinal}:${item.rawAliasInputOrdinal}`);
      if (item.rawAliasInputOrdinal !== undefined &&
          (!Number.isInteger(item.rawAliasInputOrdinal) ||
            item.rawAliasInputOrdinal < 0 || item.rawAliasInputOrdinal >= item.inputOrdinal ||
            !aliasSource || aliasSource.rawAliasInputOrdinal !== undefined ||
            !Number.isSafeInteger(item.contentVersion) ||
            item.contentVersion !== aliasSource.contentVersion ||
            item.textureId !== aliasSource.textureId || item.viewId !== aliasSource.viewId ||
            item.mipLevel !== aliasSource.mipLevel || item.arrayLayer !== aliasSource.arrayLayer ||
            item.format !== aliasSource.format || item.width !== aliasSource.width ||
            item.height !== aliasSource.height || item.rawFormat !== aliasSource.rawFormat ||
            item.rawBytesPerRow !== aliasSource.rawBytesPerRow ||
            item.rawByteLength !== aliasSource.rawByteLength ||
            item.rawSha256 !== aliasSource.rawSha256 || item.rawFile !== aliasSource.rawFile ||
            item.file !== aliasSource.file || item.imageSha256 !== aliasSource.imageSha256 ||
            item.rawSourceBeforeCommandIndex !== aliasSource.beforeCommandIndex)) {
        throw new Error('input raw alias differs from its verified source Draw');
      }
      const binding = verifiedInputBinding(pass, events, resources, item);
      const drawCommandIndex = pass.frameDebugStep?.drawCommandIndex;
      const base = {
        frameOrdinal: item.frameOrdinal, passIndex: item.passIndex,
        inputOrdinal: item.inputOrdinal, bindingName: item.bindingName,
        textureId: item.textureId ?? null, viewId: item.viewId ?? null,
        mipLevel: item.mipLevel, arrayLayer: item.arrayLayer,
        width: item.width, height: item.height, format: item.format,
        ...(item.contentVersion !== undefined ? { contentVersion: item.contentVersion } : {}),
        ...(aliasSource ? { rawAliasInputOrdinal: item.rawAliasInputOrdinal,
          rawSourceBeforeCommandIndex: item.rawSourceBeforeCommandIndex } : {}),
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
        drawCommandIndex, beforeCommandIndex: drawCommandIndex,
        groupSlot: binding.groupSlot, binding: binding.binding,
        ...(binding.bindingAmbiguous ? {
          bindingAmbiguous: true, bindingCandidates: binding.bindingCandidates,
        } : {}),
        source: aliasSource ?
          'RHI pre-Draw GPU readback reused after verified unchanged texture' :
          'RHI pre-Draw GPU readback' };
      if (item.file) {
        try {
          if (typeof item.imageSha256 !== 'string') throw new Error('input PNG SHA-256 is missing');
          const imageKey = `${item.frameOrdinal}:${item.file}`;
          let copied = copiedInputPng.get(imageKey);
          if (copied && copied.sha256 !== item.imageSha256) {
            throw new Error('input PNG SHA-256 differs from shared source');
          }
          if (copied && (copied.width !== item.width || copied.height !== item.height)) {
            throw new Error('shared input PNG dimensions differ from source');
          }
          if (!copied) {
            const relativeFile = `input-snapshots/frame-${item.frameOrdinal}-pass-${item.passIndex}-input-${item.inputOrdinal}.png`;
            const dest = await copySidecar(sourceDir, outputDir, item.file, relativeFile,
              item.width, item.height, item.imageSha256, linkCredentials);
            copied = { relativeFile, sha256: item.imageSha256,
              width: item.width, height: item.height };
            copiedInputPng.set(imageKey, copied);
            exports.push(dest);
          }
          snapshot.imageFile = copied.relativeFile;
          snapshot.imageSha256 = item.imageSha256;
        } catch (error) {
          snapshot.imageReason = error.message;
          errors.push({ inputOrdinal: item.inputOrdinal, file: item.file, reason: error.message });
        }
      } else snapshot.imageReason = item.imageReason || 'Input PNG was not saved';
      if (item.rawFile) {
        try {
          const rawKey = `${item.frameOrdinal}:${item.rawFile}`;
          let copied = copiedInputRaw.get(rawKey);
          if (copied && (copied.sha256 !== item.rawSha256 ||
              copied.format !== item.rawFormat || copied.width !== item.width ||
              copied.height !== item.height || copied.bytesPerRow !== item.rawBytesPerRow ||
              copied.bytes !== item.rawByteLength)) {
            throw new Error('shared input raw metadata differs from its source');
          }
          if (!copied) {
            const relativeFile = `input-raw/frame-${item.frameOrdinal}-pass-${item.passIndex}-input-${item.inputOrdinal}.bin`;
            const dest = await copyRawSidecar(sourceDir, outputDir, item, relativeFile,
              true, item.format, MAX_INPUT_RAW_BYTES, false, linkCredentials);
            copied = { relativeFile, sha256: item.rawSha256, format: item.rawFormat,
              width: item.width, height: item.height, bytesPerRow: item.rawBytesPerRow,
              bytes: item.rawByteLength };
            copiedInputRaw.set(rawKey, copied);
            exports.push(dest);
          }
          snapshot.rawFile = copied.relativeFile;
          snapshot.rawFormat = item.rawFormat;
          snapshot.rawBytesPerRow = item.rawBytesPerRow;
          snapshot.rawByteLength = item.rawByteLength;
          snapshot.rawSha256 = item.rawSha256;
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
        file: item?.rawFile ?? item?.file, reason: error.message });
    }
  }

  const bufferOrdinals = new Set();
  for (const item of progressEntries(manifest?.bufferSnapshots ?? [])) {
    try {
      const pass = passRecord(item, frames, passes);
      if (!Number.isSafeInteger(item.bufferOrdinal) || item.bufferOrdinal < 0 ||
          item.bufferOrdinal >= 8192 ||
          bufferOrdinals.has(`${item.frameOrdinal}:${item.bufferOrdinal}`) ||
          !Number.isSafeInteger(item.passOrdinal) || item.passOrdinal < 0 ||
          !['uniform', 'storage', 'read-only-storage', 'vertex', 'index'].includes(item.role) ||
          !Number.isSafeInteger(item.totalSize) || item.totalSize < 0 ||
          !Number.isSafeInteger(item.offset) || !Number.isSafeInteger(item.size) ||
          !Number.isSafeInteger(item.copiedOffset) || item.copiedOffset < 0 ||
          !Number.isSafeInteger(item.copiedSize) || item.copiedSize < 0 ||
          !['binding', 'draw-indices', 'bound-suffix'].includes(item.rangeScope)) {
        throw new Error('pre-Draw buffer metadata is invalid or duplicated');
      }
      bufferOrdinals.add(`${item.frameOrdinal}:${item.bufferOrdinal}`);
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
        const dest = await copyDrawBufferSidecar(sourceDir, outputDir, item, relativeFile,
          MAX_BUFFER_ITEM_BYTES, linkCredentials);
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
  for (const item of progressEntries(manifest?.aspectSnapshots ?? [])) {
    try {
      const pass = passRecord(item, frames, passes);
      if (pass.type !== 'render' || !['depth', 'stencil'].includes(item.aspect) ||
          !Number.isSafeInteger(item.passOrdinal) || item.passOrdinal < 0 ||
          (item.aspectOrdinal !== null &&
            (!Number.isSafeInteger(item.aspectOrdinal) || item.aspectOrdinal < 0 ||
              item.aspectOrdinal >= 1024 ||
              aspectOrdinals.has(`${item.frameOrdinal}:${item.aspectOrdinal}`))) ||
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
      if (item.aspectOrdinal !== null) aspectOrdinals.add(`${item.frameOrdinal}:${item.aspectOrdinal}`);
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
            item.width, item.height, item.imageSha256, linkCredentials);
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
            item.rawFormat, MAX_PASS_RAW_BYTES, false, linkCredentials);
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

  const resourceTextureKeys = new Set();
  for (const item of progressEntries(manifest?.resourceTextureSnapshots ?? [])) {
    try {
      frameRecord(item, frames);
      const texture = resources?.textures?.find(value => value.id === item.textureId);
      const width = texture?.width ?? texture?.descriptor?.size?.width;
      const height = texture?.height ?? texture?.descriptor?.size?.height;
      const layers = texture?.depthOrArrayLayers ?? texture?.descriptor?.size?.depthOrArrayLayers ?? 1;
      const mipCount = texture?.descriptor?.mipLevelCount ?? 1;
      const samples = texture?.descriptor?.sampleCount ?? 1;
      const key = `${item.frameOrdinal}:${item.resourceOrdinal}`;
      if (!texture || !Number.isInteger(item.resourceOrdinal) || item.resourceOrdinal < 0 ||
          !Number.isInteger(item.textureOrdinal) || item.textureOrdinal < 0 ||
          resourceTextureKeys.has(key) || item.captureMoment !== 'frame-end' ||
          texture.format !== item.sourceFormat || texture.dimension !== '2d' ||
          layers !== 1 || samples !== 1 || item.sampleCount !== samples ||
          !Number.isInteger(item.mipLevel) || item.mipLevel < 0 ||
          item.mipLevel >= mipCount || item.arrayLayer !== 0 ||
          item.width !== Math.max(1, Math.floor(width / 2 ** item.mipLevel)) ||
          item.height !== Math.max(1, Math.floor(height / 2 ** item.mipLevel)) ||
          !['color', 'depth', 'stencil'].includes(item.aspect) ||
          (item.aspect === 'color' && item.rawFormat !== item.sourceFormat) ||
          (item.aspect === 'depth' && item.rawFormat !== 'r32float') ||
          (item.aspect === 'stencil' && item.rawFormat !== 'stencil8')) {
        throw new Error('frame-end resource texture differs from Inspector descriptor');
      }
      resourceTextureKeys.add(key);
      const snapshot = { frameOrdinal: item.frameOrdinal,
        resourceOrdinal: item.resourceOrdinal, textureOrdinal: item.textureOrdinal,
        textureId: item.textureId, label: item.label,
        width: item.width, height: item.height, sourceFormat: item.sourceFormat,
        rawFormat: item.rawFormat, mipLevel: item.mipLevel, arrayLayer: item.arrayLayer,
        aspect: item.aspect, sampleCount: item.sampleCount, captureMoment: 'frame-end',
        imageFile: null, rawFile: null };
      if (item.file) {
        try {
          if (typeof item.imageSha256 !== 'string') throw new Error('resource texture PNG SHA-256 is missing');
          const relativeFile = `resource-textures/frame-${item.frameOrdinal}-texture-${item.textureId}-mip-${item.mipLevel}-${item.aspect}.png`;
          const dest = await copySidecar(sourceDir, outputDir, item.file, relativeFile,
            item.width, item.height, item.imageSha256, linkCredentials);
          snapshot.imageFile = relativeFile;
          exports.push(dest);
        } catch (error) {
          snapshot.imageReason = error.message;
          errors.push({ frameOrdinal: item.frameOrdinal, resourceOrdinal: item.resourceOrdinal,
            file: item.file, reason: error.message });
        }
      } else snapshot.imageReason = item.imageReason || 'Resource PNG was not saved';
      const relativeRaw = `resource-texture-raw/frame-${item.frameOrdinal}-texture-${item.textureId}-mip-${item.mipLevel}-${item.aspect}.bin`;
      const dest = await copyRawSidecar(sourceDir, outputDir, item, relativeRaw,
        true, item.rawFormat, MAX_RESOURCE_TEXTURE_RAW_BYTES, true, linkCredentials);
      snapshot.rawFile = relativeRaw;
      snapshot.rawBytesPerRow = item.rawBytesPerRow;
      snapshot.rawByteLength = item.rawByteLength;
      snapshot.rawSha256 = item.rawSha256;
      exports.push(dest);
      (texture.frameEndSnapshots ??= []).push(snapshot);
      resourceTextureSnapshots.push(snapshot);
    } catch (error) {
      errors.push({ frameOrdinal: item?.frameOrdinal, resourceOrdinal: item?.resourceOrdinal,
        file: item?.rawFile, reason: error.message });
    }
  }

  const resourceBufferKeys = new Set();
  for (const item of progressEntries(manifest?.resourceBufferSnapshots ?? [])) {
    try {
      frameRecord(item, frames);
      const buffer = resources?.buffers?.find(value => value.id === item.bufferId);
      const key = `${item.frameOrdinal}:${item.resourceOrdinal}`;
      if (!buffer || !Number.isInteger(item.resourceOrdinal) || item.resourceOrdinal < 0 ||
          resourceBufferKeys.has(key) || item.captureMoment !== 'frame-end' ||
          !Number.isSafeInteger(item.totalSize) || buffer.size !== item.totalSize ||
          item.copiedOffset !== 0 || item.copiedSize !== item.totalSize) {
        throw new Error('frame-end resource Buffer differs from Inspector descriptor');
      }
      resourceBufferKeys.add(key);
      const relativeRaw = `resource-buffers/frame-${item.frameOrdinal}-buffer-${item.bufferId}.bin`;
      const dest = await copyDrawBufferSidecar(sourceDir, outputDir, item, relativeRaw,
        MAX_RESOURCE_BUFFER_RAW_BYTES, linkCredentials);
      const snapshot = { frameOrdinal: item.frameOrdinal,
        resourceOrdinal: item.resourceOrdinal, bufferId: item.bufferId, label: item.label,
        totalSize: item.totalSize, copiedOffset: 0, copiedSize: item.totalSize,
        captureMoment: 'frame-end', rawFile: relativeRaw,
        rawByteLength: item.rawByteLength, rawSha256: item.rawSha256 };
      exports.push(dest);
      (buffer.frameEndSnapshots ??= []).push(snapshot);
      resourceBufferSnapshots.push(snapshot);
    } catch (error) {
      errors.push({ frameOrdinal: item?.frameOrdinal, resourceOrdinal: item?.resourceOrdinal,
        file: item?.rawFile, reason: error.message });
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
    exports, verifiedFiles, attached, errors, frameImage, passSnapshots, inputSnapshots,
    aspectSnapshots, bufferSnapshots, resourceTextureSnapshots,
    resourceBufferSnapshots, passUnavailable,
    resourceFrames: manifest?.diagnosticFrames?.map(frame => frame.frameIndex) ?? [],
    diagnosticFrames: manifest?.diagnosticFrames ?? [],
    manifest: manifest ? { schemaVersion: 1, file: 'sidecars.json' } : null,
    sourceManifest: manifest,
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
