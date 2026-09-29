// Local WebGPU Inspector capture broker. Both F2 and agents submit jobs here;
// only the game instance with the matching bootId may fulfill them.
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, open, realpath, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { analyzeCapture, readCapture, summarizeCapture } from './analyze.mjs';

const MAX_FRAMES = 120;
const MAX_CAPTURE_BYTES = 512 * 1024 * 1024;
const MAX_FRAME_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_FRAME_IMAGES_BYTES = 512 * 1024 * 1024;
const MAX_DIAGNOSTIC_ENTRIES = 512;
const MAX_METADATA_BYTES = 64 * 1024 * 1024;
const MAX_HEADER_BYTES = 64;
const MIN_CAPTURE_BYTES = 16;
const CLIENT_TTL_MS = 15000;
const JOB_TTL_MS = 5 * 60 * 1000;
const MAX_HISTORY = 20;

function text(error) { return error instanceof Error ? error.message : String(error); }

async function readExactly(handle, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, position + offset);
    if (bytesRead === 0) throw new Error('WGPUCAP file is truncated');
    offset += bytesRead;
  }
}

// Inspector writes: "WGPUCAP 1 <jsonByteLength>\n", JSON, 8-byte padding, then raw payloads.
// Check the actual container before recording an upload as a successful capture.
async function validateCaptureBinary(file, fileBytes) {
  const handle = await open(file, 'r');
  try {
    const head = Buffer.alloc(Math.min(fileBytes, MAX_HEADER_BYTES));
    await readExactly(handle, head, 0);
    const newline = head.indexOf(10);
    if (newline < 0) throw new Error('WGPUCAP header is missing or too long');
    const match = /^WGPUCAP 1 ([1-9][0-9]*)$/.exec(head.subarray(0, newline).toString('ascii'));
    if (!match) throw new Error('unsupported or invalid WGPUCAP header');
    const jsonBytes = Number(match[1]);
    if (!Number.isSafeInteger(jsonBytes) || jsonBytes > MAX_METADATA_BYTES) {
      throw new Error('WGPUCAP metadata exceeds 64 MiB limit');
    }
    const metadataStart = newline + 1;
    const metadataEnd = metadataStart + jsonBytes;
    if (metadataEnd > fileBytes) throw new Error('WGPUCAP metadata is truncated');
    const json = Buffer.alloc(jsonBytes);
    await readExactly(handle, json, metadataStart);
    let metadata;
    try { metadata = JSON.parse(json.toString('utf8')); }
    catch { throw new Error('WGPUCAP metadata is not valid JSON'); }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) ||
        !Array.isArray(metadata.commands) || !Array.isArray(metadata.payloadTable) ||
        !metadata.objects || typeof metadata.objects !== 'object') {
      throw new Error('WGPUCAP metadata is missing capture commands, objects, or payload table');
    }
    if (metadata.commands.length === 0) throw new Error('WGPUCAP capture has no GPU commands');
    const binaryStart = Math.ceil(metadataEnd / 8) * 8;
    if (binaryStart > fileBytes) throw new Error('WGPUCAP binary section is truncated');
    for (const payload of metadata.payloadTable) {
      if (payload === null) continue;
      if (!Array.isArray(payload) || payload.length !== 2 ||
          !Number.isSafeInteger(payload[0]) || !Number.isSafeInteger(payload[1]) ||
          payload[0] < 0 || payload[1] < 0 || payload[0] % 8 !== 0 ||
          binaryStart + payload[0] + payload[1] > fileBytes) {
        throw new Error('WGPUCAP payload table contains an invalid or truncated entry');
      }
    }
    return {
      commandCount: metadata.commands.length,
      objectCount: Array.isArray(metadata.objects) ? metadata.objects.length : Object.keys(metadata.objects).length,
      payloadCount: metadata.payloadTable.length,
    };
  } finally {
    await handle.close();
  }
}

function validBootId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\x00-\x1f\x7f]/.test(value);
}

function contains(parent, child) {
  const rel = relative(parent.toLowerCase(), child.toLowerCase());
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function futureRealpath(path) {
  let current = resolve(path);
  const missing = [];
  while (!existsSync(current)) {
    const upper = dirname(current);
    if (upper === current) break;
    missing.unshift(current.slice(upper.length).replace(/^[/\\]/, ''));
    current = upper;
  }
  return resolve(await realpath(current), ...missing);
}

function gitWorktrees(projectRoot) {
  const roots = [projectRoot];
  try {
    const list = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: projectRoot, encoding: 'utf8', timeout: 3000, windowsHide: true,
    });
    for (const line of list.split(/\r?\n/)) if (line.startsWith('worktree ')) roots.push(line.slice(9));
  } catch { /* The supplied project root remains protected. */ }
  return [...new Set(roots.map(root => resolve(root)))];
}

function insideGitCheckout(candidate) {
  for (let dir = candidate; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return true;
    if (dir === dirname(dir)) return false;
  }
}

async function outputRoot(projectRoot) {
  const base = process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR ||
    join(process.env.LOCALAPPDATA || join(homedir(), '.local', 'share'), 'GameDraft', 'webgpu-captures');
  const candidate = await futureRealpath(base);
  if (insideGitCheckout(candidate)) {
    throw new Error('WebGPU captures must be stored outside every project worktree');
  }
  for (const root of gitWorktrees(projectRoot)) {
    const physical = await futureRealpath(root);
    if (contains(physical, candidate) || contains(candidate, physical)) {
      throw new Error('WebGPU captures must be stored outside every project worktree');
    }
  }
  await mkdir(candidate, { recursive: true });
  const actual = await realpath(candidate);
  for (const root of gitWorktrees(projectRoot)) {
    if (contains(await futureRealpath(root), actual)) {
      throw new Error('WebGPU capture directory resolves inside a project worktree');
    }
  }
  return actual;
}

function publicClient(client) {
  return {
    targetBootId: client.bootId,
    url: client.url,
    sceneId: client.sceneId,
    captureReady: client.captureReady,
    reason: client.reason,
    lastSeenAt: new Date(client.lastSeen).toISOString(),
  };
}

function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    targetBootId: job.bootId,
    state: job.state,
    requestedFrames: job.frames,
    actualFrames: job.actualFrames ?? 0,
    bytes: job.bytes ?? 0,
    sha256: job.sha256 ?? null,
    outputDir: job.state === 'completed' ? job.outputDir : null,
    captureFile: job.state === 'completed' ? job.file : null,
    error: job.error ?? null,
    createdAt: new Date(job.createdAt).toISOString(),
    updatedAt: new Date(job.updatedAt).toISOString(),
  };
}

export function createWebGpuCaptureController(projectRoot) {
  const root = resolve(projectRoot);
  const clients = new Map();
  const jobs = new Map();
  let activeJobId = null;
  let requestInFlight = false;
  let closed = false;

  function liveClients() {
    const now = Date.now();
    for (const [id, client] of clients) if (now - client.lastSeen > CLIENT_TTL_MS) clients.delete(id);
    return [...clients.values()];
  }

  function expireJobs() {
    const now = Date.now();
    for (const job of jobs.values()) {
      if (['pending', 'capturing', 'uploading'].includes(job.state) && now - job.createdAt > JOB_TTL_MS) {
        job.state = 'failed';
        job.error = 'capture timed out';
        job.updatedAt = now;
        if (activeJobId === job.id) activeJobId = null;
      }
    }
  }

  function getJob(jobId, bootId) {
    expireJobs();
    const job = jobs.get(jobId);
    if (!job || job.bootId !== bootId) throw new Error('capture job not found for this game bootId');
    return job;
  }

  function capHistory() {
    const done = [...jobs.values()].filter(job => !['pending', 'capturing', 'uploading'].includes(job.state));
    while (done.length > MAX_HISTORY) jobs.delete(done.shift().id);
  }

  function register({ targetBootId, url = '', sceneId = '', captureReady = false, reason = '' } = {}) {
    if (closed) throw new Error('capture controller is closed');
    if (!validBootId(targetBootId)) throw new Error('invalid game bootId');
    if (typeof url !== 'string' || url.length > 2048) throw new Error('invalid game URL');
    if (typeof sceneId !== 'string' || sceneId.length > 128) throw new Error('invalid sceneId');
    if (typeof reason !== 'string' || reason.length > 200) throw new Error('invalid capture readiness reason');
    const client = {
      bootId: targetBootId, url, sceneId,
      captureReady: captureReady === true,
      reason: captureReady === true ? '' : reason,
      lastSeen: Date.now(),
    };
    clients.set(targetBootId, client);
    return publicClient(client);
  }

  function list() { return liveClients().map(publicClient); }

  async function request({ targetBootId = '', frames = 1 } = {}) {
    if (closed) throw new Error('capture controller is closed');
    expireJobs();
    if (!Number.isInteger(frames) || frames < 1 || frames > MAX_FRAMES) {
      throw new Error(`frames must be an integer from 1 to ${MAX_FRAMES}`);
    }
    if (activeJobId || requestInFlight) throw new Error('another capture job is already active');
    const available = liveClients().filter(client => client.captureReady);
    let client;
    if (targetBootId) client = available.find(item => item.bootId === targetBootId);
    else if (available.length === 1) client = available[0];
    else if (available.length > 1) throw new Error('multiple capture-ready games; specify targetBootId');
    if (!client) throw new Error('no matching capture-ready game instance');
    requestInFlight = true;
    try {
      const base = await outputRoot(root);
      if (closed) throw new Error('capture controller is closed');
      const id = randomBytes(16).toString('hex');
      const outputDir = join(base, new Date().toISOString().slice(0, 10), id);
      await mkdir(outputDir, { recursive: true });
      const now = Date.now();
      const job = {
        id, bootId: client.bootId, frames, state: 'pending',
        outputDir, file: join(outputDir, 'capture.wgpuc'),
        url: client.url, sceneId: client.sceneId,
        createdAt: now, updatedAt: now, error: null,
        uploadInProgress: false, frameImages: new Map(), passImages: new Map(), diagnostics: null,
        frameImageInProgress: new Set(), frameImageBytes: 0,
        reservedFrameImageBytes: 0,
      };
      jobs.set(id, job);
      activeJobId = id;
      capHistory();
      return publicJob(job);
    } finally {
      requestInFlight = false;
    }
  }

  function poll({ targetBootId } = {}) {
    if (!validBootId(targetBootId)) throw new Error('invalid game bootId');
    expireJobs();
    const job = activeJobId ? jobs.get(activeJobId) : null;
    if (!job || job.bootId !== targetBootId) return null;
    if (job.state === 'pending') {
      job.state = 'capturing';
      job.updatedAt = Date.now();
    }
    return publicJob(job);
  }

  function status({ jobId = '', targetBootId = '' } = {}) {
    expireJobs();
    if (jobId) return publicJob(getJob(jobId, targetBootId));
    const matched = [...jobs.values()].reverse().find(job => job.bootId === targetBootId);
    return publicJob(matched || null);
  }

  async function viewerFile({ jobId = '', file = 'viewer.html' } = {}) {
    if (!/^[0-9a-f]{32}$/.test(jobId)) throw new Error('invalid capture job id');
    const job = jobs.get(jobId);
    if (!job || job.state !== 'completed') throw new Error('completed capture job not found');
    if (!job.analysisPromise) {
      job.analysisPromise = analyzeCapture(job.file).catch(error => {
        job.analysisPromise = null;
        throw error;
      });
    }
    const analysis = await job.analysisPromise;
    const report = analysis.report;
    const allowed = new Set([
      'viewer.html', 'viewer.js', 'viewer-data.js', 'report.json',
      report.frameImage,
      ...(report.frames || []).map(frame => frame.imageFile),
      ...(report.passSnapshots || []).map(snapshot => snapshot.imageFile),
      ...(report.payloads || []).map(payload => payload.bufferFile),
      ...(report.resources?.textures || []).map(texture => texture.imageFile),
      ...(report.resources?.shaders || []).map(shader => shader.codeFile),
    ].filter(value => typeof value === 'string'));
    const requested = file.replaceAll('\\', '/');
    if (!allowed.has(requested)) throw new Error('capture viewer file is not available');
    const base = await realpath(analysis.outputDir);
    const physical = await realpath(resolve(base, requested));
    if (!contains(base, physical)) throw new Error('capture viewer file escaped its analysis directory');
    return physical;
  }

  async function uploadPngImage({ jobId, targetBootId, frameIndex, passOrdinal, colorIndex, stream, contentLength }, kind) {
    if (closed) throw new Error('capture controller is closed');
    const job = getJob(jobId, targetBootId);
    const frame = Number(frameIndex);
    const pass = Number(passOrdinal);
    const color = Number(colorIndex);
    if (!Number.isInteger(frame) || frame < 1 || frame > job.frames) throw new Error('frameIndex must be within the requested capture');
    if (kind === 'pass' && (job.frames !== 1 || frame !== 1 ||
        !Number.isInteger(pass) || pass < 0 || pass >= MAX_DIAGNOSTIC_ENTRIES ||
        !Number.isInteger(color) || color < 0 || color > 7)) {
      throw new Error('pass image requires a single-frame capture and valid pass/color indices');
    }
    const key = kind === 'pass' ? `${pass}:${color}` : frame;
    const images = kind === 'pass' ? job.passImages : job.frameImages;
    if (!['pending', 'capturing'].includes(job.state) || job.uploadInProgress) {
      throw new Error('capture job is not accepting images');
    }
    if (images.has(key) || job.frameImageInProgress.has(`${kind}:${key}`)) {
      throw new Error('image already uploaded or uploading');
    }
    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
      throw new Error('frame image binary stream is required');
    }
    if (contentLength != null && (!Number.isInteger(Number(contentLength)) ||
        Number(contentLength) < 24 || Number(contentLength) > MAX_FRAME_IMAGE_BYTES ||
        job.frameImageBytes + job.reservedFrameImageBytes + Number(contentLength) > MAX_FRAME_IMAGES_BYTES)) {
      throw new Error('frame image exceeds capture image size limit');
    }
    const name = kind === 'pass' ? `pass-${String(pass).padStart(4, '0')}-color-${color}.png` :
      `frame-${String(frame).padStart(4, '0')}.png`;
    const file = join(job.outputDir, name);
    job.frameImageInProgress.add(`${kind}:${key}`);
    let handle;
    let bytes = 0;
    try {
      handle = await open(file, 'wx+');
      for await (const part of stream) {
        if (closed || !['pending', 'capturing'].includes(job.state)) throw new Error('capture stopped while uploading frame image');
        const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
        bytes += chunk.length;
        job.reservedFrameImageBytes += chunk.length;
        if (bytes > MAX_FRAME_IMAGE_BYTES ||
            job.frameImageBytes + job.reservedFrameImageBytes > MAX_FRAME_IMAGES_BYTES) {
          throw new Error('frame image exceeds capture image size limit');
        }
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
          if (bytesWritten < 1) throw new Error('frame image write stopped');
          offset += bytesWritten;
        }
      }
      if (contentLength != null && bytes !== Number(contentLength)) throw new Error('frame image upload length mismatch');
      if (bytes < 24) throw new Error('frame image is empty or truncated');
      await handle.sync();
      const header = Buffer.alloc(24);
      await readExactly(handle, header, 0);
      const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
      const width = header.readUInt32BE(16);
      const height = header.readUInt32BE(20);
      if (!header.subarray(0, 8).equals(pngSignature) ||
          header.readUInt32BE(8) !== 13 || header.subarray(12, 16).toString('ascii') !== 'IHDR' ||
          width < 1 || height < 1 || width > 16384 || height > 16384) {
        throw new Error('frame image is not a supported PNG');
      }
      await handle.close();
      handle = null;
      if (closed || !['pending', 'capturing'].includes(job.state)) throw new Error('capture stopped while uploading frame image');
      images.set(key, { file, name, bytes, width, height });
      job.frameImageBytes += bytes;
      job.updatedAt = Date.now();
      return { jobId: job.id, frameIndex: frame, passOrdinal: kind === 'pass' ? pass : null,
        colorIndex: kind === 'pass' ? color : null, file, bytes, width, height };
    } catch (error) {
      try { await handle?.close(); } catch { /* Keep the first failure. */ }
      try { await unlink(file); } catch { /* File may not exist. */ }
      throw error;
    } finally {
      job.reservedFrameImageBytes -= bytes;
      job.frameImageInProgress.delete(`${kind}:${key}`);
    }
  }

  function uploadFrameImage(args = {}) { return uploadPngImage(args, 'frame'); }
  function uploadPassImage(args = {}) { return uploadPngImage(args, 'pass'); }

  function diagnostics({ jobId, targetBootId, passes, gpuPasses, gpuProfilerStatus, warning } = {}) {
    if (closed) throw new Error('capture controller is closed');
    const job = getJob(jobId, targetBootId);
    if (job.frames !== 1 || !['pending', 'capturing'].includes(job.state) || job.uploadInProgress) {
      throw new Error('detailed diagnostics require an active single-frame capture');
    }
    if (job.diagnostics) throw new Error('capture diagnostics already uploaded');
    if (!Array.isArray(passes) || passes.length > MAX_DIAGNOSTIC_ENTRIES ||
        !Array.isArray(gpuPasses) || gpuPasses.length > MAX_DIAGNOSTIC_ENTRIES) {
      throw new Error('invalid diagnostic pass list');
    }
    for (const item of passes) {
      if (!item || !Number.isInteger(item.passOrdinal) || item.passOrdinal < 0 ||
          item.passOrdinal >= MAX_DIAGNOSTIC_ENTRIES || !Number.isInteger(item.colorIndex) ||
          item.colorIndex < 0 || item.colorIndex > 7 || typeof item.label !== 'string' || item.label.length > 200 ||
          typeof item.targetLabel !== 'string' || item.targetLabel.length > 200 ||
          (item.reason !== undefined && (typeof item.reason !== 'string' || item.reason.length > 500))) {
        throw new Error('invalid pass diagnostic');
      }
      const image = job.passImages.get(`${item.passOrdinal}:${item.colorIndex}`);
      if (!item.reason && !image) throw new Error('pass diagnostic refers to an image that was not uploaded');
      if (image && (image.width !== item.width || image.height !== item.height)) {
        throw new Error('pass image dimensions differ from diagnostic');
      }
    }
    for (const item of gpuPasses) {
      if (!item || !Number.isInteger(item.ordinal) || item.ordinal < 0 || item.ordinal >= MAX_DIAGNOSTIC_ENTRIES ||
          !['render', 'compute'].includes(item.kind) || typeof item.label !== 'string' || item.label.length > 200 ||
          !Number.isFinite(item.durationMs) || item.durationMs < 0) throw new Error('invalid GPU timing');
    }
    if (!gpuProfilerStatus || !['enabled', 'unsupported', 'disabled'].includes(gpuProfilerStatus.state) ||
        (gpuProfilerStatus.reason !== undefined && (typeof gpuProfilerStatus.reason !== 'string' ||
          gpuProfilerStatus.reason.length > 500))) throw new Error('invalid GPU profiler status');
    if (warning !== undefined && (typeof warning !== 'string' || warning.length > 500)) {
      throw new Error('invalid diagnostic warning');
    }
    job.diagnostics = { passes, gpuPasses, gpuProfilerStatus, warning };
    job.updatedAt = Date.now();
    return { jobId: job.id, passImages: job.passImages.size, passRecords: passes.length,
      gpuPasses: gpuPasses.length };
  }

  async function writeSidecars(job, actualFrames) {
    const detail = job.diagnostics;
    if (!detail && !job.frameImages.size) return null;
    const report = summarizeCapture(await readCapture(job.file));
    const displayFrames = report.frames.filter(frame => frame.frameTextureId != null &&
      report.passes.some(pass => pass.frameOrdinal === frame.frameOrdinal &&
        pass.targets?.some(target => target.outputTextureId === frame.frameTextureId)));
    const matchingFrames = detail?.passes.length ? report.frames.filter(frame => {
      const frameRender = report.passes.filter(pass => pass.frameOrdinal === frame.frameOrdinal && pass.type === 'render');
      return detail.passes.every(item => frameRender[item.passOrdinal]?.label === item.label);
    }) : [];
    const targetFrame = matchingFrames.at(-1) ?? displayFrames.at(-1) ?? report.frames.at(-1);
    const targetOrdinal = targetFrame?.frameOrdinal ?? 1;
    const passes = report.passes.filter(pass => pass.frameOrdinal === targetOrdinal);
    const renderPasses = passes.filter(pass => pass.type === 'render');
    const passSnapshots = [];
    const passUnavailable = [];
    const gpuTimings = [];
    for (const item of detail?.passes ?? []) {
      const pass = renderPasses[item.passOrdinal];
      const target = pass?.targets?.find(value => value.kind === 'color' && value.slot === item.colorIndex);
      const image = job.passImages.get(`${item.passOrdinal}:${item.colorIndex}`);
      const base = { frameOrdinal: targetOrdinal, passIndex: pass?.index ?? null, label: item.label,
        colorIndex: item.colorIndex };
      if (!pass || pass.label !== item.label || !target) {
        passUnavailable.push({ ...base, reason: 'pass label, order, or target differs from the Inspector capture' });
      } else if (item.reason || !image || !Number.isInteger(target.outputTextureId)) {
        passUnavailable.push({ ...base, reason: item.reason || 'pass output has no readable color texture' });
      } else {
        passSnapshots.push({ frameOrdinal: targetOrdinal, passIndex: pass.index,
          afterCommandIndex: pass.endCommand, textureId: target.outputTextureId,
          file: image.name, width: image.width, height: image.height,
          format: item.format, label: item.label, source: 'RHI pass-end GPU readback' });
      }
    }
    for (const item of detail?.gpuPasses ?? []) {
      const pass = passes[item.ordinal];
      if (pass?.type === item.kind && pass.label === item.label) {
        gpuTimings.push({ frameOrdinal: pass.frameOrdinal, passIndex: pass.index,
          durationMs: item.durationMs, source: 'webgpu-timestamp-query' });
      }
    }
    const sidecars = { schemaVersion: 1,
      frames: [...job.frameImages].sort(([a], [b]) => a - b).filter(([index]) => index <= actualFrames)
        .map(([index, image]) => {
          const frame = job.frames === 1 ? targetFrame : displayFrames[index - 1];
          return frame ? { frameOrdinal: frame.frameOrdinal, file: image.name,
            width: image.width, height: image.height } : null;
        }).filter(Boolean),
      passSnapshots, passUnavailable, gpuTimings,
      gpuProfilerStatus: detail?.gpuProfilerStatus ?? null,
      passCaptureWarning: detail?.warning ?? null };
    await writeFile(join(job.outputDir, 'sidecars.json'), JSON.stringify(sidecars, null, 2) + '\n', { flag: 'wx' });
    return { passSnapshots: passSnapshots.length, passUnavailable: passUnavailable.length,
      gpuTimedPasses: gpuTimings.length };
  }

  async function upload({ jobId, targetBootId, stream, actualFrames, contentLength } = {}) {
    if (closed) throw new Error('capture controller is closed');
    const job = getJob(jobId, targetBootId);
    if (!['pending', 'capturing'].includes(job.state) || job.uploadInProgress) throw new Error('capture job is not accepting an upload');
    const count = Number(actualFrames);
    if (!Number.isInteger(count) || count < 1 || count > job.frames) throw new Error('actualFrames must be between 1 and requested frames');
    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') throw new Error('binary upload stream is required');
    if (contentLength != null && (!Number.isInteger(Number(contentLength)) ||
        Number(contentLength) < 0 || Number(contentLength) > MAX_CAPTURE_BYTES)) {
      throw new Error('capture exceeds 512 MiB upload limit');
    }
    job.uploadInProgress = true;
    job.state = 'uploading';
    job.updatedAt = Date.now();
    let handle;
    let bytes = 0;
    const sha = createHash('sha256');
    try {
      handle = await open(job.file, 'wx');
      for await (const part of stream) {
        if (job.state !== 'uploading' || closed) throw new Error('capture stopped or timed out');
        const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
        bytes += chunk.length;
        if (bytes > MAX_CAPTURE_BYTES) throw new Error('capture exceeds 512 MiB upload limit');
        sha.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const result = await handle.write(chunk, offset, chunk.length - offset);
          if (result.bytesWritten < 1) throw new Error('capture file write stopped');
          offset += result.bytesWritten;
        }
      }
      if (bytes < MIN_CAPTURE_BYTES) throw new Error('capture file is empty or truncated');
      if (contentLength != null && bytes !== Number(contentLength)) throw new Error('capture upload length mismatch');
      await handle.sync();
      await handle.close();
      handle = null;
      if (job.state !== 'uploading' || closed) throw new Error('capture stopped or timed out');
      const captureSummary = await validateCaptureBinary(job.file, bytes);
      if (job.state !== 'uploading' || closed) throw new Error('capture stopped or timed out');
      const digest = sha.digest('hex');
      const diagnosticsSummary = await writeSidecars(job, count);
      const manifest = {
        schemaVersion: 1,
        captureKind: 'webgpu-inspector',
        format: 'wgpuc',
        provenance: 'GameDraft browser WebGPU Inspector Local Capture API',
        jobId: job.id,
        targetBootId: job.bootId,
        url: job.url,
        sceneId: job.sceneId,
        requestedFrames: job.frames,
        actualFrames: count,
        captureFile: job.file,
        bytes,
        sha256: digest,
        ...captureSummary,
        ...(diagnosticsSummary ? { diagnostics: diagnosticsSummary } : {}),
        frameImages: [...job.frameImages].sort(([a], [b]) => a - b).map(([index, image]) => ({
          frameIndex: index, file: image.file, bytes: image.bytes,
          width: image.width, height: image.height,
        })),
        capturedAt: new Date().toISOString(),
      };
      await writeFile(join(job.outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
      job.actualFrames = count;
      job.bytes = bytes;
      job.sha256 = digest;
      job.state = 'completed';
      job.updatedAt = Date.now();
      if (activeJobId === job.id) activeJobId = null;
      capHistory();
      return publicJob(job);
    } catch (error) {
      try { await handle?.close(); } catch { /* Keep the first failure. */ }
      try { await unlink(job.file); } catch { /* File may not have been created. */ }
      if (job.state !== 'stopped') {
        job.state = 'failed';
        job.error = text(error);
      }
      job.updatedAt = Date.now();
      if (activeJobId === job.id) activeJobId = null;
      throw error;
    } finally {
      job.uploadInProgress = false;
    }
  }

  function fail({ jobId, targetBootId, error } = {}) {
    const job = getJob(jobId, targetBootId);
    if (!['pending', 'capturing'].includes(job.state)) throw new Error('capture job is no longer active');
    job.state = 'failed';
    job.error = typeof error === 'string' && error.length <= 1000 ? error : 'browser capture failed';
    job.updatedAt = Date.now();
    if (activeJobId === job.id) activeJobId = null;
    return publicJob(job);
  }

  function stop({ jobId, targetBootId } = {}) {
    const job = getJob(jobId, targetBootId);
    if (['pending', 'capturing', 'uploading'].includes(job.state)) {
      job.state = 'stopped';
      job.updatedAt = Date.now();
      if (activeJobId === job.id) activeJobId = null;
    }
    return publicJob(job);
  }

  function close() {
    closed = true;
    for (const job of jobs.values()) {
      if (['pending', 'capturing', 'uploading'].includes(job.state)) job.state = 'stopped';
    }
    activeJobId = null;
    clients.clear();
  }

  return { register, list, request, poll, status, viewerFile, uploadFrameImage, uploadPassImage,
    diagnostics, upload, fail, stop, close };
}
