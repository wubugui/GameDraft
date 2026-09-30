// Local WebGPU Inspector capture broker. Both F2 and agents submit jobs here;
// only the game instance with the matching bootId may fulfill them.
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeCapture, readCapture, summarizeCapture } from './analyze.mjs';
import { inspectorCaptureFrames, verifiedDrawBufferBinding, verifiedInputBinding } from './analysis_sidecars.mjs';

const MAX_FRAMES = 120;
const MAX_CAPTURE_BYTES = 512 * 1024 * 1024;
const MAX_FRAME_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_FRAME_IMAGES_BYTES = 512 * 1024 * 1024;
const MAX_PASS_RAW_BYTES = 512 * 1024 * 1024;
const MAX_DIAGNOSTIC_ENTRIES = 512;
const MAX_INPUT_ENTRIES = 1024;
const MAX_ASPECT_ENTRIES = 1024;
const MAX_BUFFER_ENTRIES = 1024;
const MAX_BUFFER_ITEM_BYTES = 16 * 1024 * 1024;
const MAX_BUFFER_RAW_BYTES = 256 * 1024 * 1024;
const MAX_INPUT_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_INPUT_IMAGES_BYTES = 512 * 1024 * 1024;
const MAX_INPUT_RAW_BYTES = 512 * 1024 * 1024;
const MAX_ASPECT_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_ASPECT_IMAGES_BYTES = 512 * 1024 * 1024;
const MAX_ASPECT_RAW_BYTES = 512 * 1024 * 1024;
const MAX_SIDECAR_MANIFEST_BYTES = 4 * 1024 * 1024;
const RAW_FORMAT_BYTES = new Map([
  ['r8unorm', 1], ['rg8unorm', 2], ['rgba8unorm', 4], ['rgba8unorm-srgb', 4],
  ['bgra8unorm', 4], ['bgra8unorm-srgb', 4],
  ['r16float', 2], ['rg16float', 4], ['rgba16float', 8],
  ['r32float', 4], ['rg32float', 8], ['rgba32float', 16],
  ['r32uint', 4], ['rgba32uint', 16],
  ['stencil8', 1],
]);
const MAX_METADATA_BYTES = 64 * 1024 * 1024;
const MAX_HEADER_BYTES = 64;
const MIN_CAPTURE_BYTES = 16;
const CLIENT_TTL_MS = 15000;
const JOB_TTL_MS = 5 * 60 * 1000;
const MAX_HISTORY = 20;
const MAX_DISK_HISTORY = 100;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_ANALYSIS_REPORT_BYTES = 64 * 1024 * 1024;
const MAX_ANALYSIS_INDEX_BYTES = 8 * 1024 * 1024;
const JOB_ID = /^[0-9a-f]{32}$/;
const DATE_DIR = /^\d{4}-\d{2}-\d{2}$/;
const ANALYSIS_DIR = /^analysis-\d{4}-\d{2}-\d{2}T[0-9-]+Z-[0-9a-f]{8}$/;
const VIEWER_SOURCE = dirname(fileURLToPath(import.meta.url));

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

function validDateDirectory(name) {
  return DATE_DIR.test(name) && !Number.isNaN(Date.parse(`${name}T00:00:00Z`)) &&
    new Date(`${name}T00:00:00Z`).toISOString().slice(0, 10) === name;
}

async function checkedDirectory(parent, path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('capture directory is not ordinary');
  const physical = await realpath(path);
  if (!contains(parent, physical)) throw new Error('capture directory escaped the capture root');
  return physical;
}

async function checkedFile(parent, path, maximum) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) {
    throw new Error('capture file is not an ordinary bounded file');
  }
  const physical = await realpath(path);
  if (!contains(parent, physical)) throw new Error('capture file escaped its directory');
  return { physical, info };
}

async function fileSha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
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
    detailedFrameIndex: job.detailedFrameIndex,
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
  const diskJobs = new Map();
  const diskLoads = new Map();
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
      // A split Draw frame can contain hundreds of sequential sidecar uploads.
      // Expire stalled work, not a job that is still making upload progress.
      if (['pending', 'capturing', 'uploading'].includes(job.state) && now - job.updatedAt > JOB_TTL_MS) {
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

  async function savedJob(base, day, id, verifyHash = true) {
    if (!validDateDirectory(day) || !JOB_ID.test(id)) throw new Error('invalid saved capture path');
    const dateDir = await checkedDirectory(base, join(base, day));
    const outputDir = await checkedDirectory(dateDir, join(dateDir, id));
    const { physical: manifestFile, info: manifestInfo } = await checkedFile(outputDir,
      join(outputDir, 'manifest.json'), MAX_MANIFEST_BYTES);
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    if (!manifest || manifest.schemaVersion !== 1 ||
        manifest.captureKind !== 'webgpu-inspector' || manifest.format !== 'wgpuc' ||
        manifest.jobId !== id || !validBootId(manifest.targetBootId) ||
        !Number.isInteger(manifest.requestedFrames) || manifest.requestedFrames < 1 ||
        manifest.requestedFrames > MAX_FRAMES ||
        !Number.isInteger(manifest.actualFrames) || manifest.actualFrames < 1 ||
        manifest.actualFrames > manifest.requestedFrames ||
        !/^[0-9a-f]{64}$/.test(manifest.sha256) ||
        !Number.isInteger(manifest.bytes) || manifest.bytes < MIN_CAPTURE_BYTES ||
        manifest.bytes > MAX_CAPTURE_BYTES) {
      throw new Error('saved capture manifest is invalid');
    }
    const detailedFrameIndex = manifest.detailedFrameIndex ?? 1;
    if (!Number.isInteger(detailedFrameIndex) || detailedFrameIndex < 1 ||
        detailedFrameIndex > manifest.requestedFrames) {
      throw new Error('saved capture detailed frame is invalid');
    }
    const createdAt = Date.parse(manifest.createdAt ?? manifest.capturedAt);
    if (!Number.isFinite(createdAt)) {
      throw new Error('saved capture timestamp is invalid');
    }
    const { physical: file, info } = await checkedFile(outputDir,
      join(outputDir, 'capture.wgpuc'), MAX_CAPTURE_BYTES);
    if (info.size !== manifest.bytes || typeof manifest.captureFile !== 'string' ||
        resolve(manifest.captureFile).toLowerCase() !== file.toLowerCase()) {
      throw new Error('saved capture size or path differs from manifest');
    }
    if (verifyHash) {
      if (await fileSha256(file) !== manifest.sha256) throw new Error('saved capture SHA-256 differs from manifest');
      await validateCaptureBinary(file, info.size);
    }
    return {
      id, bootId: manifest.targetBootId, frames: manifest.requestedFrames,
      detailedFrameIndex, actualFrames: manifest.actualFrames, bytes: info.size,
      sha256: manifest.sha256, outputDir, file, state: 'completed', error: null,
      createdAt, updatedAt: Date.parse(manifest.capturedAt) || createdAt, dateDir: day,
      fileMtimeMs: info.mtimeMs, manifestMtimeMs: manifestInfo.mtimeMs,
    };
  }

  async function unchangedSavedJob(job) {
    try {
      const capture = await checkedFile(job.outputDir, job.file, MAX_CAPTURE_BYTES);
      const manifest = await checkedFile(job.outputDir, join(job.outputDir, 'manifest.json'),
        MAX_MANIFEST_BYTES);
      return capture.info.size === job.bytes &&
        capture.info.mtimeMs === job.fileMtimeMs &&
        manifest.info.mtimeMs === job.manifestMtimeMs;
    } catch { return false; }
  }

  async function savedDates(base) {
    return (await readdir(base, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && validDateDirectory(entry.name))
      .map(entry => entry.name).sort().reverse();
  }

  async function reopenJob(id) {
    if (!JOB_ID.test(id)) throw new Error('invalid capture job id');
    const live = jobs.get(id);
    if (live?.state === 'completed') return live;
    if (diskJobs.has(id)) {
      const cached = diskJobs.get(id);
      if (await unchangedSavedJob(cached)) return cached;
      diskJobs.delete(id);
    }
    if (!diskLoads.has(id)) {
      const load = (async () => {
        const base = await outputRoot(root);
        for (const day of await savedDates(base)) {
          try {
            const job = await savedJob(base, day, id);
            diskJobs.set(id, job);
            if (diskJobs.size > MAX_DISK_HISTORY) diskJobs.delete(diskJobs.keys().next().value);
            return job;
          } catch { /* Other dates, incomplete uploads, and forged files are ignored. */ }
        }
        throw new Error('completed capture job not found');
      })().finally(() => diskLoads.delete(id));
      diskLoads.set(id, load);
    }
    return diskLoads.get(id);
  }

  async function history({ limit = MAX_HISTORY } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_DISK_HISTORY) {
      throw new Error(`limit must be an integer from 1 to ${MAX_DISK_HISTORY}`);
    }
    const base = await outputRoot(root);
    const candidates = [];
    for (const day of await savedDates(base)) {
      let dateDir;
      try { dateDir = await checkedDirectory(base, join(base, day)); }
      catch { continue; }
      for (const entry of await readdir(dateDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !JOB_ID.test(entry.name)) continue;
        try { candidates.push(await savedJob(base, day, entry.name, false)); }
        catch { /* Never expose an incomplete, linked, or forged capture. */ }
      }
    }
    candidates.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    const result = [];
    for (const candidate of candidates) {
      if (result.length >= limit) break;
      try {
        const cached = diskJobs.get(candidate.id);
        const job = cached && await unchangedSavedJob(cached) &&
          cached.sha256 === candidate.sha256 && cached.bytes === candidate.bytes ? cached :
          await savedJob(base, candidate.dateDir, candidate.id);
        diskJobs.set(candidate.id, job);
        result.push({ id: job.id, state: 'completed', requestedFrames: job.frames,
          detailedFrameIndex: job.detailedFrameIndex, actualFrames: job.actualFrames,
          bytes: job.bytes, sha256: job.sha256,
          createdAt: new Date(job.createdAt).toISOString(), captureFile: job.file });
      } catch { /* A bad recent record must not hide the next valid job. */ }
    }
    return result;
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

  async function request({ targetBootId = '', frames = 1, detailedFrameIndex = 1 } = {}) {
    if (closed) throw new Error('capture controller is closed');
    expireJobs();
    if (!Number.isInteger(frames) || frames < 1 || frames > MAX_FRAMES) {
      throw new Error(`frames must be an integer from 1 to ${MAX_FRAMES}`);
    }
    if (!Number.isInteger(detailedFrameIndex) || detailedFrameIndex < 1 ||
        detailedFrameIndex > frames) {
      throw new Error('detailedFrameIndex must be an integer within requested frames');
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
        id, bootId: client.bootId, frames, detailedFrameIndex, state: 'pending',
        outputDir, file: join(outputDir, 'capture.wgpuc'),
        url: client.url, sceneId: client.sceneId,
        createdAt: now, updatedAt: now, error: null,
        uploadInProgress: false, frameImages: new Map(), passImages: new Map(), passRaw: new Map(), diagnostics: null,
        inputImages: new Map(), inputRaw: new Map(), inputRawInProgress: new Set(),
        aspectImages: new Map(), aspectRaw: new Map(), aspectRawInProgress: new Set(),
        bufferRaw: new Map(), bufferRawInProgress: new Set(),
        frameImageInProgress: new Set(), frameImageBytes: 0,
        reservedFrameImageBytes: 0, passRawInProgress: new Set(), passRawBytes: 0,
        reservedPassRawBytes: 0, inputImageBytes: 0, reservedInputImageBytes: 0,
        inputRawBytes: 0, reservedInputRawBytes: 0,
        aspectImageBytes: 0, reservedAspectImageBytes: 0,
        aspectRawBytes: 0, reservedAspectRawBytes: 0,
        bufferRawBytes: 0, reservedBufferRawBytes: 0,
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

  // Ordinals are local to the one frame selected for deep diagnostics. An
  // omitted frame is accepted only for older single-frame clients.
  function diagnosticFrameIndex(job, frameIndex) {
    const frame = frameIndex === undefined && job.frames === 1 ? 1 : frameIndex;
    if (!Number.isInteger(frame) || frame !== job.detailedFrameIndex) {
      throw new Error('diagnostic frameIndex must equal the selected detailedFrameIndex');
    }
    return frame;
  }

  function diagnosticFilePrefix(job) {
    return job.frames === 1 ? '' : `frame-${String(job.detailedFrameIndex).padStart(4, '0')}-`;
  }

  function viewerFiles(report) {
    return new Set([
      'viewer.html', 'viewer.js', 'viewer_mesh.js', 'viewer_surface.js', 'viewer_surface.css', 'viewer_uniforms.js',
      'viewer-data.js', 'report.json',
      report.frameImage,
      ...(report.frames || []).map(frame => frame.imageFile),
      ...(report.passSnapshots || []).map(snapshot => snapshot.imageFile),
      ...(report.passSnapshots || []).map(snapshot => snapshot.rawFile),
      ...(report.inputSnapshots || []).map(snapshot => snapshot.imageFile),
      ...(report.inputSnapshots || []).map(snapshot => snapshot.rawFile),
      ...(report.aspectSnapshots || []).map(snapshot => snapshot.imageFile),
      ...(report.aspectSnapshots || []).map(snapshot => snapshot.rawFile),
      ...(report.bufferSnapshots || []).map(snapshot => snapshot.rawFile),
      ...(report.payloads || []).map(payload => payload.bufferFile),
      ...(report.resources?.textures || []).map(texture => texture.imageFile),
      ...(report.resources?.shaders || []).map(shader => shader.codeFile),
    ].filter(value => typeof value === 'string'));
  }

  function validViewerPath(name) {
    return name && !isAbsolute(name) && !name.startsWith('/') &&
      !name.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\\'));
  }

  async function analyzedWithIndex(job) {
    const analysis = await analyzeCapture(job.file);
    const files = {};
    const base = await realpath(analysis.outputDir);
    for (const name of viewerFiles(analysis.report)) {
      if (!validViewerPath(name)) throw new Error('analysis report lists an invalid file');
      const { physical, info } = await checkedFile(base, resolve(base, name), MAX_CAPTURE_BYTES);
      files[name] = { bytes: info.size, sha256: await fileSha256(physical) };
    }
    const index = { schemaVersion: 1, jobId: job.id, captureSha256: job.sha256, files };
    const encoded = JSON.stringify(index) + '\n';
    if (Buffer.byteLength(encoded) > MAX_ANALYSIS_INDEX_BYTES) {
      throw new Error('analysis integrity index exceeds 8 MiB limit');
    }
    await writeFile(join(base, 'analysis-integrity.json'), encoded, { flag: 'wx' });
    return { ...analysis, integrity: index, verifiedFiles: new Map() };
  }

  async function reusableAnalysis(job) {
    let entries;
    try { entries = await readdir(job.outputDir, { withFileTypes: true }); }
    catch { return null; }
    for (const entry of entries.filter(item => item.isDirectory() && ANALYSIS_DIR.test(item.name))
      .sort((a, b) => b.name.localeCompare(a.name))) {
      try {
        const outputDir = await checkedDirectory(job.outputDir, join(job.outputDir, entry.name));
        const { physical: reportFile } = await checkedFile(outputDir,
          join(outputDir, 'report.json'), MAX_ANALYSIS_REPORT_BYTES);
        const report = JSON.parse(await readFile(reportFile, 'utf8'));
        if (!report || report.schemaVersion !== 3 ||
            report.captureKind !== 'webgpu-inspector' || report.format !== 'wgpuc' ||
            report.sha256 !== job.sha256 || report.bytes !== job.bytes ||
            typeof report.captureFile !== 'string' ||
            resolve(report.captureFile).toLowerCase() !== job.file.toLowerCase()) continue;
        const { physical: indexFile } = await checkedFile(outputDir,
          join(outputDir, 'analysis-integrity.json'), MAX_ANALYSIS_INDEX_BYTES);
        const integrity = JSON.parse(await readFile(indexFile, 'utf8'));
        if (!integrity || integrity.schemaVersion !== 1 || integrity.jobId !== job.id ||
            integrity.captureSha256 !== job.sha256 ||
            !integrity.files || typeof integrity.files !== 'object') continue;
        const listed = viewerFiles(report);
        if ([...listed].some(name => !validViewerPath(name) ||
            !/^[0-9a-f]{64}$/.test(integrity.files[name]?.sha256) ||
            !Number.isInteger(integrity.files[name]?.bytes) ||
            integrity.files[name].bytes < 0 || integrity.files[name].bytes > MAX_CAPTURE_BYTES)) continue;
        if (await fileSha256(reportFile) !== integrity.files['report.json'].sha256) continue;
        const safeJson = JSON.stringify(report).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
          .replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
        const { physical: viewerData } = await checkedFile(outputDir,
          join(outputDir, 'viewer-data.js'), MAX_ANALYSIS_REPORT_BYTES);
        if (await readFile(viewerData, 'utf8') !==
            `window.__GAMEDRAFT_CAPTURE_REPORT__ = ${safeJson};\n`) continue;
        let currentViewer = true;
        for (const name of ['viewer.html', 'viewer.js', 'viewer_surface.js',
          'viewer_surface.css', 'viewer_uniforms.js', 'viewer_mesh.js']) {
          const source = join(VIEWER_SOURCE, name);
          if (!existsSync(source)) continue;
          const { physical: existing } = await checkedFile(outputDir, join(outputDir, name),
            MAX_ANALYSIS_REPORT_BYTES);
          if (await fileSha256(source) !== await fileSha256(existing)) {
            currentViewer = false;
            break;
          }
        }
        if (currentViewer) return { outputDir, report, integrity, verifiedFiles: new Map() };
      } catch { /* An incomplete or stale analysis is regenerated once. */ }
    }
    return null;
  }

  async function viewerFile({ jobId = '', file = 'viewer.html' } = {}) {
    const job = await reopenJob(jobId);
    if (!job.analysisPromise) {
      job.analysisPromise = (async () => await reusableAnalysis(job) ??
        await analyzedWithIndex(job))().catch(error => {
        job.analysisPromise = null;
        throw error;
      });
    }
    const analysis = await job.analysisPromise;
    const report = analysis.report;
    const allowed = viewerFiles(report);
    if (typeof file !== 'string') throw new Error('invalid capture viewer file');
    const requested = file.replaceAll('\\', '/');
    if (!allowed.has(requested)) throw new Error('capture viewer file is not available');
    if (!validViewerPath(requested)) {
      throw new Error('capture viewer file has an invalid path');
    }
    const base = await realpath(analysis.outputDir);
    const { physical, info } = await checkedFile(base, resolve(base, requested), MAX_CAPTURE_BYTES);
    const expected = analysis.integrity?.files?.[requested];
    if (!expected || expected.bytes !== info.size) {
      throw new Error('capture viewer file differs from its integrity index');
    }
    const cached = analysis.verifiedFiles.get(requested);
    if (!cached || cached.size !== info.size || cached.mtimeMs !== info.mtimeMs) {
      if (await fileSha256(physical) !== expected.sha256) {
        throw new Error('capture viewer file SHA-256 differs from its integrity index');
      }
      analysis.verifiedFiles.set(requested, { size: info.size, mtimeMs: info.mtimeMs });
    }
    return physical;
  }

  async function uploadPngImage({ jobId, targetBootId, frameIndex, passOrdinal, colorIndex,
    inputOrdinal, aspectOrdinal, stream, contentLength }, kind) {
    if (closed) throw new Error('capture controller is closed');
    const job = getJob(jobId, targetBootId);
    const frame = kind === 'frame' ? Number(frameIndex) : diagnosticFrameIndex(job, frameIndex);
    const pass = Number(passOrdinal);
    const color = Number(colorIndex);
    const input = Number(inputOrdinal);
    const aspect = Number(aspectOrdinal);
    if (!Number.isInteger(frame) || frame < 1 || frame > job.frames) throw new Error('frameIndex must be within the requested capture');
    if (kind === 'pass' && (!Number.isInteger(pass) || pass < 0 || pass >= MAX_DIAGNOSTIC_ENTRIES ||
        !Number.isInteger(color) || color < 0 || color > 7)) {
      throw new Error('pass image requires valid pass/color indices');
    }
    if (kind === 'input' && (!Number.isInteger(input) ||
        input < 0 || input >= MAX_INPUT_ENTRIES)) {
      throw new Error('input image requires a valid input ordinal');
    }
    if (kind === 'aspect' && (!Number.isInteger(aspect) ||
        aspect < 0 || aspect >= MAX_ASPECT_ENTRIES)) {
      throw new Error('aspect image requires a valid aspect ordinal');
    }
    const key = kind === 'pass' ? `${pass}:${color}` : kind === 'input' ? input :
      kind === 'aspect' ? aspect : frame;
    const images = kind === 'pass' ? job.passImages : kind === 'input' ? job.inputImages :
      kind === 'aspect' ? job.aspectImages : job.frameImages;
    const bytesField = kind === 'input' ? 'inputImageBytes' :
      kind === 'aspect' ? 'aspectImageBytes' : 'frameImageBytes';
    const reservedField = kind === 'input' ? 'reservedInputImageBytes' :
      kind === 'aspect' ? 'reservedAspectImageBytes' : 'reservedFrameImageBytes';
    const singleLimit = kind === 'input' ? MAX_INPUT_IMAGE_BYTES :
      kind === 'aspect' ? MAX_ASPECT_IMAGE_BYTES : MAX_FRAME_IMAGE_BYTES;
    const totalLimit = kind === 'input' ? MAX_INPUT_IMAGES_BYTES :
      kind === 'aspect' ? MAX_ASPECT_IMAGES_BYTES : MAX_FRAME_IMAGES_BYTES;
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
        Number(contentLength) < 24 || Number(contentLength) > singleLimit ||
        job[bytesField] + job[reservedField] + Number(contentLength) > totalLimit)) {
      throw new Error(`${kind} image exceeds capture image size limit`);
    }
    const prefix = kind === 'frame' ? '' : diagnosticFilePrefix(job);
    const name = kind === 'pass' ? `${prefix}pass-${String(pass).padStart(4, '0')}-color-${color}.png` :
      kind === 'input' ? `${prefix}input-${String(input).padStart(4, '0')}.png` :
      kind === 'aspect' ? `${prefix}aspect-${String(aspect).padStart(4, '0')}.png` :
        `frame-${String(frame).padStart(4, '0')}.png`;
    const file = join(job.outputDir, name);
    job.frameImageInProgress.add(`${kind}:${key}`);
    let handle;
    let bytes = 0;
    const sha = createHash('sha256');
    try {
      handle = await open(file, 'wx+');
      for await (const part of stream) {
        if (closed || !['pending', 'capturing'].includes(job.state)) throw new Error('capture stopped while uploading frame image');
        const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
        bytes += chunk.length;
        job[reservedField] += chunk.length;
        if (bytes > singleLimit || job[bytesField] + job[reservedField] > totalLimit) {
          throw new Error(`${kind} image exceeds capture image size limit`);
        }
        sha.update(chunk);
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
      images.set(key, { file, name, bytes, width, height, sha256: sha.digest('hex') });
      job[bytesField] += bytes;
      job.updatedAt = Date.now();
      return { jobId: job.id, frameIndex: frame, passOrdinal: kind === 'pass' ? pass : null,
        inputOrdinal: kind === 'input' ? input : null,
        aspectOrdinal: kind === 'aspect' ? aspect : null,
        colorIndex: kind === 'pass' ? color : null, file, bytes, width, height };
    } catch (error) {
      try { await handle?.close(); } catch { /* Keep the first failure. */ }
      try { await unlink(file); } catch { /* File may not exist. */ }
      throw error;
    } finally {
      job[reservedField] -= bytes;
      job.frameImageInProgress.delete(`${kind}:${key}`);
    }
  }

  function uploadFrameImage(args = {}) { return uploadPngImage(args, 'frame'); }
  function uploadPassImage(args = {}) { return uploadPngImage(args, 'pass'); }
  function uploadInputImage(args = {}) { return uploadPngImage(args, 'input'); }
  function uploadAspectImage(args = {}) { return uploadPngImage(args, 'aspect'); }

  async function uploadRaw({ jobId, targetBootId, frameIndex, passOrdinal, colorIndex,
    inputOrdinal, aspectOrdinal, format, width, height, bytesPerRow, stream, contentLength } = {}, kind) {
    if (closed) throw new Error('capture controller is closed');
    const job = getJob(jobId, targetBootId);
    const frame = diagnosticFrameIndex(job, frameIndex);
    const pass = Number(passOrdinal);
    const color = Number(colorIndex);
    const input = Number(inputOrdinal);
    const aspect = Number(aspectOrdinal);
    const w = Number(width);
    const h = Number(height);
    const stride = Number(bytesPerRow);
    const bpp = RAW_FORMAT_BYTES.get(format);
    if ((kind === 'pass' &&
        (!Number.isInteger(pass) || pass < 0 || pass >= MAX_DIAGNOSTIC_ENTRIES ||
        !Number.isInteger(color) || color < 0 || color > 7)) ||
        (kind === 'input' && (!Number.isInteger(input) || input < 0 || input >= MAX_INPUT_ENTRIES)) ||
        (kind === 'aspect' && (!Number.isInteger(aspect) || aspect < 0 || aspect >= MAX_ASPECT_ENTRIES))) {
      throw new Error(`raw ${kind} output requires a valid ordinal`);
    }
    if (!bpp || kind === 'aspect' && !['r32float', 'stencil8'].includes(format) ||
        !Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w < 1 || h < 1 ||
        w > 16384 || h > 16384 || !Number.isSafeInteger(stride) ||
        stride !== Math.ceil(w * bpp / 256) * 256) {
      throw new Error(`raw ${kind} output format, dimensions, or row stride is invalid`);
    }
    const expected = stride * h;
    if (!Number.isSafeInteger(expected) || expected > (kind === 'input' ? MAX_INPUT_RAW_BYTES :
        kind === 'aspect' ? MAX_ASPECT_RAW_BYTES : MAX_PASS_RAW_BYTES) ||
        contentLength != null && Number(contentLength) !== expected) {
      throw new Error(`raw ${kind} output byte length exceeds the limit or differs from dimensions`);
    }
    if (!['pending', 'capturing'].includes(job.state) || job.uploadInProgress) {
      throw new Error(`capture job is not accepting raw ${kind} output`);
    }
    const key = kind === 'input' ? input : kind === 'aspect' ? aspect : `${pass}:${color}`;
    const raw = kind === 'input' ? job.inputRaw : kind === 'aspect' ? job.aspectRaw : job.passRaw;
    const inProgress = kind === 'input' ? job.inputRawInProgress :
      kind === 'aspect' ? job.aspectRawInProgress : job.passRawInProgress;
    const bytesField = kind === 'input' ? 'inputRawBytes' :
      kind === 'aspect' ? 'aspectRawBytes' : 'passRawBytes';
    const reservedField = kind === 'input' ? 'reservedInputRawBytes' :
      kind === 'aspect' ? 'reservedAspectRawBytes' : 'reservedPassRawBytes';
    const totalLimit = kind === 'input' ? MAX_INPUT_RAW_BYTES :
      kind === 'aspect' ? MAX_ASPECT_RAW_BYTES : MAX_PASS_RAW_BYTES;
    if (raw.has(key) || inProgress.has(key)) throw new Error(`raw ${kind} output already uploaded`);
    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') throw new Error(`raw ${kind} output stream is required`);
    if (expected > totalLimit - job[bytesField] - job[reservedField]) {
      throw new Error(`raw ${kind} outputs exceed 512 MiB capture limit`);
    }
    const prefix = diagnosticFilePrefix(job);
    const name = kind === 'input' ? `${prefix}input-${String(input).padStart(4, '0')}.bin` :
      kind === 'aspect' ? `${prefix}aspect-${String(aspect).padStart(4, '0')}.bin` :
      `${prefix}pass-raw-${String(pass).padStart(4, '0')}-color-${color}.bin`;
    const file = join(job.outputDir, name);
    let handle;
    let bytes = 0;
    const sha = createHash('sha256');
    inProgress.add(key);
    job[reservedField] += expected;
    try {
      handle = await open(file, 'wx');
      for await (const part of stream) {
        if (closed || !['pending', 'capturing'].includes(job.state)) throw new Error(`capture stopped while uploading raw ${kind} output`);
        const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
        bytes += chunk.length;
        if (bytes > expected) throw new Error(`raw ${kind} output exceeds declared byte length`);
        sha.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
          if (bytesWritten < 1) throw new Error(`raw ${kind} output write stopped`);
          offset += bytesWritten;
        }
      }
      if (bytes !== expected) throw new Error(`raw ${kind} output length differs from dimensions`);
      await handle.sync();
      await handle.close();
      handle = null;
      if (closed || !['pending', 'capturing'].includes(job.state)) throw new Error(`capture stopped while uploading raw ${kind} output`);
      const item = { file, name, bytes, width: w, height: h, format, bytesPerRow: stride,
        sha256: sha.digest('hex') };
      raw.set(key, item);
      job[bytesField] += bytes;
      job.updatedAt = Date.now();
      return { jobId: job.id, frameIndex: frame,
        passOrdinal: kind === 'pass' ? pass : null,
        colorIndex: kind === 'pass' ? color : null,
        inputOrdinal: kind === 'input' ? input : null,
        aspectOrdinal: kind === 'aspect' ? aspect : null,
        file, bytes, format, width: w, height: h, bytesPerRow: stride };
    } catch (error) {
      try { await handle?.close(); } catch { /* Keep the first failure. */ }
      try { await unlink(file); } catch { /* File may not exist. */ }
      throw error;
    } finally {
      job[reservedField] -= expected;
      inProgress.delete(key);
    }
  }

  function uploadPassRaw(args = {}) { return uploadRaw(args, 'pass'); }
  function uploadInputRaw(args = {}) { return uploadRaw(args, 'input'); }
  function uploadAspectRaw(args = {}) { return uploadRaw(args, 'aspect'); }

  async function uploadBufferRaw({ jobId, targetBootId, frameIndex, bufferOrdinal, stream, contentLength } = {}) {
    if (closed) throw new Error('capture controller is closed');
    const job = getJob(jobId, targetBootId);
    const frame = diagnosticFrameIndex(job, frameIndex);
    const ordinal = Number(bufferOrdinal);
    if (!Number.isInteger(ordinal) ||
        ordinal < 0 || ordinal >= MAX_BUFFER_ENTRIES) {
      throw new Error('raw Draw buffer requires a valid buffer ordinal');
    }
    if (!['pending', 'capturing'].includes(job.state) || job.uploadInProgress) {
      throw new Error('capture job is not accepting raw Draw buffers');
    }
    if (job.bufferRaw.has(ordinal) || job.bufferRawInProgress.has(ordinal)) {
      throw new Error('raw Draw buffer already uploaded');
    }
    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
      throw new Error('raw Draw buffer stream is required');
    }
    if (contentLength != null && (!Number.isSafeInteger(Number(contentLength)) ||
        Number(contentLength) < 4 || Number(contentLength) % 4 !== 0 ||
        Number(contentLength) > MAX_BUFFER_ITEM_BYTES ||
        Number(contentLength) > MAX_BUFFER_RAW_BYTES - job.bufferRawBytes - job.reservedBufferRawBytes)) {
      throw new Error('raw Draw buffer length exceeds limit or is not 4-byte aligned');
    }
    const name = `${diagnosticFilePrefix(job)}buffer-${String(ordinal).padStart(4, '0')}.bin`;
    const file = join(job.outputDir, name);
    job.bufferRawInProgress.add(ordinal);
    const sha = createHash('sha256');
    let bytes = 0;
    let handle;
    try {
      handle = await open(file, 'wx');
      for await (const part of stream) {
        if (closed || !['pending', 'capturing'].includes(job.state)) {
          throw new Error('capture stopped while uploading raw Draw buffer');
        }
        const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
        bytes += chunk.length;
        job.reservedBufferRawBytes += chunk.length;
        if (bytes > MAX_BUFFER_ITEM_BYTES ||
            job.bufferRawBytes + job.reservedBufferRawBytes > MAX_BUFFER_RAW_BYTES) {
          throw new Error('raw Draw buffers exceed capture size limit');
        }
        sha.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
          if (bytesWritten < 1) throw new Error('raw Draw buffer write stopped');
          offset += bytesWritten;
        }
      }
      if (bytes < 4 || bytes % 4 !== 0 ||
          (contentLength != null && bytes !== Number(contentLength))) {
        throw new Error('raw Draw buffer length differs from declared aligned bytes');
      }
      await handle.sync();
      await handle.close();
      handle = null;
      if (closed || !['pending', 'capturing'].includes(job.state)) {
        throw new Error('capture stopped while uploading raw Draw buffer');
      }
      job.bufferRaw.set(ordinal, { file, name, bytes, sha256: sha.digest('hex') });
      job.bufferRawBytes += bytes;
      job.updatedAt = Date.now();
      return { jobId: job.id, frameIndex: frame, bufferOrdinal: ordinal, file, bytes };
    } catch (error) {
      try { await handle?.close(); } catch { /* Keep the first failure. */ }
      try { await unlink(file); } catch { /* File may not exist. */ }
      throw error;
    } finally {
      job.reservedBufferRawBytes -= bytes;
      job.bufferRawInProgress.delete(ordinal);
    }
  }

  function diagnostics({ jobId, targetBootId, frameIndex, passes, inputs = [], aspects = [], buffers = [],
    gpuPasses, gpuProfilerStatus, warning } = {}) {
    if (closed) throw new Error('capture controller is closed');
    const job = getJob(jobId, targetBootId);
    const frame = diagnosticFrameIndex(job, frameIndex);
    if (!['pending', 'capturing'].includes(job.state) || job.uploadInProgress) {
      throw new Error('detailed diagnostics require an active capture');
    }
    if (job.diagnostics) throw new Error('capture diagnostics already uploaded');
    if (!Array.isArray(passes) || passes.length > MAX_DIAGNOSTIC_ENTRIES ||
        !Array.isArray(inputs) || inputs.length > MAX_INPUT_ENTRIES ||
        !Array.isArray(aspects) || aspects.length > MAX_ASPECT_ENTRIES ||
        !Array.isArray(buffers) || buffers.length > MAX_BUFFER_ENTRIES ||
        !Array.isArray(gpuPasses) || gpuPasses.length > MAX_DIAGNOSTIC_ENTRIES) {
      throw new Error('invalid diagnostic pass list');
    }
    const passKeys = new Set();
    for (const item of passes) {
      if (!item || !Number.isInteger(item.passOrdinal) || item.passOrdinal < 0 ||
          item.passOrdinal >= MAX_DIAGNOSTIC_ENTRIES || !Number.isInteger(item.colorIndex) ||
          item.colorIndex < 0 || item.colorIndex > 7 || typeof item.label !== 'string' || item.label.length > 200 ||
          typeof item.targetLabel !== 'string' || item.targetLabel.length > 200 ||
          passKeys.has(`${item.passOrdinal}:${item.colorIndex}`) ||
          (item.reason !== undefined && (typeof item.reason !== 'string' || item.reason.length > 500))) {
        throw new Error('invalid pass diagnostic');
      }
      passKeys.add(`${item.passOrdinal}:${item.colorIndex}`);
      const image = job.passImages.get(`${item.passOrdinal}:${item.colorIndex}`);
      const raw = job.passRaw.get(`${item.passOrdinal}:${item.colorIndex}`);
      if (!item.reason && !image && !raw) {
        throw new Error('pass diagnostic refers to an output that was not uploaded');
      }
      if (image && (image.width !== item.width || image.height !== item.height)) {
        throw new Error('pass image dimensions differ from diagnostic');
      }
      if (item.rawBytesPerRow !== undefined || item.rawByteLength !== undefined) {
        if (!raw || raw.width !== item.width || raw.height !== item.height ||
            raw.format !== item.format || raw.bytesPerRow !== item.rawBytesPerRow ||
            raw.bytes !== item.rawByteLength) {
          throw new Error('raw pass output differs from diagnostic');
        }
      } else if (raw) throw new Error('raw pass output has no diagnostic metadata');
      if (item.rawReason !== undefined &&
          (typeof item.rawReason !== 'string' || item.rawReason.length > 500)) {
        throw new Error('invalid raw pass output reason');
      }
    }
    const inputOrdinals = new Set();
    for (const item of inputs) {
      if (!item || !Number.isInteger(item.inputOrdinal) || item.inputOrdinal < 0 ||
          item.inputOrdinal >= MAX_INPUT_ENTRIES || inputOrdinals.has(item.inputOrdinal) ||
          !Number.isInteger(item.passOrdinal) || item.passOrdinal < 0 ||
          item.passOrdinal >= MAX_DIAGNOSTIC_ENTRIES ||
          typeof item.bindingName !== 'string' || !item.bindingName.trim() || item.bindingName.length > 160 ||
          (item.groupSlot === undefined) !== (item.binding === undefined) ||
          (item.groupSlot !== undefined &&
            (!Number.isSafeInteger(item.groupSlot) || item.groupSlot < 0 ||
              !Number.isSafeInteger(item.binding) || item.binding < 0)) ||
          (item.textureId !== null && (!Number.isSafeInteger(item.textureId) || item.textureId < 0)) ||
          (item.viewId !== null && (!Number.isSafeInteger(item.viewId) || item.viewId < 0)) ||
          !Number.isSafeInteger(item.mipLevel) || item.mipLevel < 0 || item.mipLevel > 63 ||
          !Number.isSafeInteger(item.arrayLayer) || item.arrayLayer < 0 || item.arrayLayer > 16383 ||
          !Number.isSafeInteger(item.width) || item.width < 0 || item.width > 16384 ||
          !Number.isSafeInteger(item.height) || item.height < 0 || item.height > 16384 ||
          typeof item.format !== 'string' || item.format.length > 80 ||
          (item.reason !== undefined && (typeof item.reason !== 'string' || item.reason.length > 500)) ||
          (item.rawReason !== undefined && (typeof item.rawReason !== 'string' || item.rawReason.length > 500))) {
        throw new Error('invalid input diagnostic');
      }
      inputOrdinals.add(item.inputOrdinal);
      const image = job.inputImages.get(item.inputOrdinal);
      const raw = job.inputRaw.get(item.inputOrdinal);
      if (!image && !raw && !item.reason) {
        throw new Error('input diagnostic has no uploaded pixels or unavailable reason');
      }
      if ((image || raw) && (item.width < 1 || item.height < 1)) {
        throw new Error('uploaded input dimensions must be positive');
      }
      if (image && (image.width !== item.width || image.height !== item.height)) {
        throw new Error('input image dimensions differ from diagnostic');
      }
      if (item.rawBytesPerRow !== undefined || item.rawByteLength !== undefined) {
        if (!raw || raw.width !== item.width || raw.height !== item.height ||
            raw.format !== item.format || raw.bytesPerRow !== item.rawBytesPerRow ||
            raw.bytes !== item.rawByteLength) {
          throw new Error('raw input differs from diagnostic');
        }
      } else if (raw) throw new Error('raw input has no diagnostic metadata');
    }
    const aspectOrdinals = new Set();
    const aspectKeys = new Set();
    for (const item of aspects) {
      if (!item || !Number.isInteger(item.aspectOrdinal) || item.aspectOrdinal < 0 ||
          item.aspectOrdinal >= MAX_ASPECT_ENTRIES || aspectOrdinals.has(item.aspectOrdinal) ||
          !Number.isInteger(item.passOrdinal) || item.passOrdinal < 0 ||
          item.passOrdinal >= MAX_DIAGNOSTIC_ENTRIES ||
          !['depth', 'stencil'].includes(item.aspect) ||
          aspectKeys.has(`${item.passOrdinal}:${item.aspect}`) ||
          typeof item.label !== 'string' || item.label.length > 200 ||
          typeof item.targetLabel !== 'string' || item.targetLabel.length > 200 ||
          (item.textureId !== null && (!Number.isSafeInteger(item.textureId) || item.textureId < 0)) ||
          (item.viewId !== null && (!Number.isSafeInteger(item.viewId) || item.viewId < 0)) ||
          !Number.isSafeInteger(item.width) || item.width < 0 || item.width > 16384 ||
          !Number.isSafeInteger(item.height) || item.height < 0 || item.height > 16384 ||
          typeof item.sourceFormat !== 'string' || item.sourceFormat.length > 80 ||
          item.rawFormat !== (item.aspect === 'depth' ? 'r32float' : 'stencil8') ||
          !Number.isSafeInteger(item.sampleCount) || item.sampleCount < 1 || item.sampleCount > 32 ||
          (item.sampleIndex !== null &&
            (!Number.isSafeInteger(item.sampleIndex) || item.sampleIndex < 0 ||
              item.sampleIndex >= item.sampleCount)) ||
          (item.reason !== undefined && (typeof item.reason !== 'string' || item.reason.length > 500)) ||
          (item.imageReason !== undefined &&
            (typeof item.imageReason !== 'string' || item.imageReason.length > 500)) ||
          (item.rawReason !== undefined &&
            (typeof item.rawReason !== 'string' || item.rawReason.length > 500))) {
        throw new Error('invalid depth/stencil aspect diagnostic');
      }
      aspectOrdinals.add(item.aspectOrdinal);
      aspectKeys.add(`${item.passOrdinal}:${item.aspect}`);
      const image = job.aspectImages.get(item.aspectOrdinal);
      const raw = job.aspectRaw.get(item.aspectOrdinal);
      if (!image && !raw && !item.reason) {
        throw new Error('aspect diagnostic has no uploaded pixels or unavailable reason');
      }
      if ((image || raw) && (item.width < 1 || item.height < 1)) {
        throw new Error('uploaded aspect dimensions must be positive');
      }
      if (image && (image.width !== item.width || image.height !== item.height)) {
        throw new Error('aspect PNG dimensions differ from diagnostic');
      }
      if (item.rawBytesPerRow !== undefined || item.rawByteLength !== undefined) {
        if (!raw || raw.width !== item.width || raw.height !== item.height ||
            raw.format !== item.rawFormat || raw.bytesPerRow !== item.rawBytesPerRow ||
            raw.bytes !== item.rawByteLength) {
          throw new Error('raw aspect differs from diagnostic');
        }
      } else if (raw) throw new Error('raw aspect has no diagnostic metadata');
    }
    const bufferOrdinals = new Set();
    for (const item of buffers) {
      const shaderBinding = ['uniform', 'storage', 'read-only-storage'].includes(item?.role);
      const vertexBinding = item?.role === 'vertex';
      const indexBinding = item?.role === 'index';
      if (!item || !Number.isInteger(item.bufferOrdinal) || item.bufferOrdinal < 0 ||
          item.bufferOrdinal >= MAX_BUFFER_ENTRIES || bufferOrdinals.has(item.bufferOrdinal) ||
          !Number.isInteger(item.passOrdinal) || item.passOrdinal < 0 ||
          item.passOrdinal >= MAX_DIAGNOSTIC_ENTRIES ||
          !(shaderBinding || vertexBinding || indexBinding) ||
          (item.bufferId !== null && (!Number.isSafeInteger(item.bufferId) || item.bufferId < 0)) ||
          typeof item.bufferLabel !== 'string' || item.bufferLabel.length > 200 ||
          !Number.isSafeInteger(item.totalSize) || item.totalSize < 0 ||
          !Number.isSafeInteger(item.offset) || !Number.isSafeInteger(item.size) ||
          !Number.isSafeInteger(item.copiedOffset) || item.copiedOffset < 0 ||
          !Number.isSafeInteger(item.copiedSize) || item.copiedSize < 0 ||
          !['binding', 'draw-indices', 'bound-suffix'].includes(item.rangeScope) ||
          (shaderBinding && (item.rangeScope !== 'binding' ||
            typeof item.bindingName !== 'string' || !item.bindingName.trim() ||
            item.bindingName.length > 160 ||
            !Number.isSafeInteger(item.groupSlot) || item.groupSlot < 0 ||
            !Number.isSafeInteger(item.binding) || item.binding < 0)) ||
          (vertexBinding && (item.rangeScope !== 'bound-suffix' ||
            typeof item.streamName !== 'string' || !item.streamName.trim() ||
            item.streamName.length > 160 ||
            !Number.isSafeInteger(item.vertexSlot) || item.vertexSlot < 0)) ||
          (indexBinding && (item.rangeScope !== 'draw-indices' ||
            item.indexFormat !== undefined && !['uint16', 'uint32'].includes(item.indexFormat))) ||
          (item.reason !== undefined && (typeof item.reason !== 'string' || item.reason.length > 500)) ||
          (item.rawReason !== undefined &&
            (typeof item.rawReason !== 'string' || item.rawReason.length > 500))) {
        throw new Error('invalid pre-Draw buffer diagnostic');
      }
      bufferOrdinals.add(item.bufferOrdinal);
      const raw = job.bufferRaw.get(item.bufferOrdinal);
      if (!raw && !item.reason && !item.rawReason) {
        throw new Error('buffer diagnostic has no uploaded bytes or unavailable reason');
      }
      if (raw && (item.reason || item.bufferId === null || item.size <= 0 || item.offset < 0 ||
          item.offset + item.size > item.totalSize || item.copiedOffset % 4 !== 0 ||
          item.copiedSize % 4 !== 0 || item.copiedSize < 4 ||
          item.copiedSize > MAX_BUFFER_ITEM_BYTES || item.copiedOffset > item.offset ||
          item.copiedOffset + item.copiedSize < item.offset + item.size ||
          item.copiedOffset + item.copiedSize > item.totalSize ||
          raw.bytes !== item.copiedSize || item.rawByteLength !== raw.bytes ||
          indexBinding && !['uint16', 'uint32'].includes(item.indexFormat))) {
        throw new Error('raw pre-Draw buffer differs from diagnostic range');
      }
      if (!raw && item.rawByteLength !== undefined) {
        throw new Error('unavailable Draw buffer has raw byte metadata');
      }
    }
    const gpuOrdinals = new Set();
    for (const item of gpuPasses) {
      if (!item || !Number.isInteger(item.ordinal) || item.ordinal < 0 || item.ordinal >= MAX_DIAGNOSTIC_ENTRIES ||
          !['render', 'compute'].includes(item.kind) || typeof item.label !== 'string' || item.label.length > 200 ||
          !Number.isFinite(item.durationMs) || item.durationMs < 0 || gpuOrdinals.has(item.ordinal)) {
        throw new Error('invalid GPU timing');
      }
      gpuOrdinals.add(item.ordinal);
    }
    if (!gpuProfilerStatus || !['enabled', 'unsupported', 'disabled'].includes(gpuProfilerStatus.state) ||
        (gpuProfilerStatus.reason !== undefined && (typeof gpuProfilerStatus.reason !== 'string' ||
          gpuProfilerStatus.reason.length > 500))) throw new Error('invalid GPU profiler status');
    if (warning !== undefined && (typeof warning !== 'string' || warning.length > 500)) {
      throw new Error('invalid diagnostic warning');
    }
    job.diagnostics = { frameIndex: frame, passes, inputs, aspects, buffers, gpuPasses,
      gpuProfilerStatus, warning };
    job.updatedAt = Date.now();
    return { jobId: job.id, frameIndex: frame,
      passImages: job.passImages.size, passRecords: passes.length,
      inputImages: job.inputImages.size, inputRecords: inputs.length,
      aspectImages: job.aspectImages.size, aspectRecords: aspects.length,
      bufferRaw: job.bufferRaw.size, bufferRecords: buffers.length,
      gpuPasses: gpuPasses.length };
  }

  async function writeSidecars(job, actualFrames) {
    const detail = job.diagnostics;
    if (job.inputImages.size || job.inputRaw.size) {
      const recorded = new Set(detail?.inputs?.map(item => item.inputOrdinal) ?? []);
      for (const ordinal of [...job.inputImages.keys(), ...job.inputRaw.keys()]) {
        if (!recorded.has(ordinal)) {
          throw new Error(`uploaded input ${ordinal} has no diagnostic metadata`);
        }
      }
    }
    if (job.aspectImages.size || job.aspectRaw.size) {
      const recorded = new Set(detail?.aspects?.map(item => item.aspectOrdinal) ?? []);
      for (const ordinal of [...job.aspectImages.keys(), ...job.aspectRaw.keys()]) {
        if (!recorded.has(ordinal)) {
          throw new Error(`uploaded aspect ${ordinal} has no diagnostic metadata`);
        }
      }
    }
    if (job.bufferRaw.size) {
      const recorded = new Set(detail?.buffers?.map(item => item.bufferOrdinal) ?? []);
      for (const ordinal of job.bufferRaw.keys()) {
        if (!recorded.has(ordinal)) {
          throw new Error(`uploaded Draw buffer ${ordinal} has no diagnostic metadata`);
        }
      }
    }
    if (!detail && !job.frameImages.size) return null;
    const report = summarizeCapture(await readCapture(job.file));
    // Inspector can append command-only trailing frames. Never guess which
    // repeated Pass label belongs to the requested logical capture frame.
    const captureFrames = inspectorCaptureFrames(report.frames, report.passes, actualFrames);
    const frameMappingComplete = captureFrames.length === actualFrames;
    const targetFrame = frameMappingComplete ? captureFrames[job.detailedFrameIndex - 1] : null;
    const targetOrdinal = targetFrame?.frameOrdinal ?? null;
    const passes = report.passes.filter(pass => pass.frameOrdinal === targetOrdinal);
    const gamePasses = passes.filter(pass => !pass.diagnosticAuxiliary);
    const renderPasses = passes.filter(pass => pass.type === 'render');
    const frameIdentityIssue = detail && (!targetFrame ?
      `selected frame ${job.detailedFrameIndex} cannot be uniquely mapped to ${actualFrames} Inspector frames` :
      !detail.passes.every(item => renderPasses[item.passOrdinal]?.label === item.label) ||
        !detail.aspects.every(item => renderPasses[item.passOrdinal]?.label === item.label) ?
        'selected frame pass labels or order differ from the Inspector capture' : null);
    // Do not attach any deep data when the selected frame itself is uncertain.
    const selectedDetail = frameIdentityIssue ? null : detail;
    const passSnapshots = [];
    const passUnavailable = [];
    const inputSnapshots = [];
    const aspectSnapshots = [];
    const bufferSnapshots = [];
    const gpuTimings = [];
    for (const item of selectedDetail?.passes ?? []) {
      const pass = renderPasses[item.passOrdinal];
      const target = pass?.targets?.find(value => value.kind === 'color' && value.slot === item.colorIndex);
      const image = job.passImages.get(`${item.passOrdinal}:${item.colorIndex}`);
      const raw = job.passRaw.get(`${item.passOrdinal}:${item.colorIndex}`);
      const base = { frameOrdinal: targetOrdinal, passIndex: pass?.index ?? null, label: item.label,
        colorIndex: item.colorIndex };
      if (!pass || pass.label !== item.label || !target) {
        passUnavailable.push({ ...base, reason: 'pass label, order, or target differs from the Inspector capture' });
      } else if ((!image && !raw) || !Number.isInteger(target.outputTextureId)) {
        passUnavailable.push({ ...base, reason: item.reason || item.rawReason || 'pass output has no readable color texture' });
      } else {
        passSnapshots.push({ frameOrdinal: targetOrdinal, passIndex: pass.index,
          afterCommandIndex: pass.endCommand, textureId: target.outputTextureId,
          colorIndex: item.colorIndex,
          ...(image ? { file: image.name, imageSha256: image.sha256 } :
            { imageReason: item.reason || 'Pass PNG was not saved' }),
          ...(raw ? { rawFile: raw.name, rawFormat: raw.format, rawBytesPerRow: raw.bytesPerRow,
            rawByteLength: raw.bytes, rawSha256: raw.sha256 } :
            { rawReason: item.rawReason || 'Pass raw pixels were not saved' }),
          width: item.width, height: item.height,
          format: item.format, label: item.label, source: 'RHI pass-end GPU readback' });
      }
    }
    // The RHI record count is intentionally bounded. Preserve an explicit unavailable
    // entry for every color output beyond that cap instead of silently omitting Draws.
    if (selectedDetail) {
      const recorded = new Set(selectedDetail.passes.map(item => `${item.passOrdinal}:${item.colorIndex}`));
      for (let ordinal = 0; ordinal < renderPasses.length; ordinal++) {
        const pass = renderPasses[ordinal];
        for (const target of pass.targets?.filter(value => value.kind === 'color') ?? []) {
          if (recorded.has(`${ordinal}:${target.slot}`)) continue;
          passUnavailable.push({ frameOrdinal: targetOrdinal, passIndex: pass.index,
            label: pass.label, colorIndex: target.slot,
            reason: ordinal >= MAX_DIAGNOSTIC_ENTRIES || selectedDetail.passes.length >= MAX_DIAGNOSTIC_ENTRIES ?
              `RHI diagnostic record limit (${MAX_DIAGNOSTIC_ENTRIES} color outputs) reached` :
              'RHI did not emit a color output diagnostic for this pass' });
        }
      }
    }
    for (const item of selectedDetail?.inputs ?? []) {
      const pass = renderPasses[item.passOrdinal];
      const image = job.inputImages.get(item.inputOrdinal);
      const raw = job.inputRaw.get(item.inputOrdinal);
      const binding = verifiedInputBinding(pass, report.events, report.resources, item);
      const base = {
        frameOrdinal: targetOrdinal, passIndex: pass?.index ?? null,
        inputOrdinal: item.inputOrdinal, passOrdinal: item.passOrdinal,
        bindingName: item.bindingName, textureId: item.textureId, viewId: item.viewId,
        ...(item.groupSlot !== undefined ? { groupSlot: item.groupSlot, binding: item.binding } : {}),
        mipLevel: item.mipLevel, arrayLayer: item.arrayLayer,
        width: item.width, height: item.height, format: item.format,
      };
      if (!binding || (!image && !raw)) {
        inputSnapshots.push({ ...base, reason: !pass ?
          'input pass ordinal does not exist in the captured frame' :
            !pass.frameDebugStep ?
              'input pass is not a verified one-Draw physical render pass' :
              !binding ?
                'TextureView and texture IDs are missing or do not match the selected Draw bindings' :
                item.reason || 'input pixels were not captured' });
        continue;
      }
      inputSnapshots.push({ ...base, beforeCommandIndex: pass.frameDebugStep.drawCommandIndex,
        groupSlot: binding.groupSlot, binding: binding.binding,
        ...(binding.bindingAmbiguous ? {
          bindingAmbiguous: true, bindingCandidates: binding.bindingCandidates,
        } : {}),
        ...(image ? { file: image.name, imageSha256: image.sha256 } :
          { imageReason: item.reason || 'Input PNG was not saved' }),
        ...(raw ? { rawFile: raw.name, rawFormat: raw.format,
          rawBytesPerRow: raw.bytesPerRow, rawByteLength: raw.bytes,
          rawSha256: raw.sha256 } :
          { rawReason: item.rawReason || 'Input raw pixels were not saved' }),
      });
    }
    for (const item of selectedDetail?.buffers ?? []) {
      const pass = renderPasses[item.passOrdinal];
      const raw = job.bufferRaw.get(item.bufferOrdinal);
      const binding = verifiedDrawBufferBinding(pass, report.events, report.resources, item);
      const base = {
        frameOrdinal: targetOrdinal, passIndex: pass?.index ?? null,
        bufferOrdinal: item.bufferOrdinal, passOrdinal: item.passOrdinal,
        role: item.role,
        ...(item.bindingName !== undefined ? { bindingName: item.bindingName } : {}),
        ...(item.groupSlot !== undefined ? { groupSlot: item.groupSlot } : {}),
        ...(item.binding !== undefined ? { binding: item.binding } : {}),
        ...(item.streamName !== undefined ? { streamName: item.streamName } : {}),
        ...(item.vertexSlot !== undefined ? { vertexSlot: item.vertexSlot } : {}),
        ...(item.indexFormat !== undefined ? { indexFormat: item.indexFormat } : {}),
        bufferId: item.bufferId, bufferLabel: item.bufferLabel,
        totalSize: item.totalSize, offset: item.offset, size: item.size,
        copiedOffset: item.copiedOffset, copiedSize: item.copiedSize,
        rangeScope: item.rangeScope,
      };
      if (!binding || !raw) {
        bufferSnapshots.push({ ...base, reason: !pass ?
          'buffer pass ordinal does not exist in the captured frame' :
            !pass.frameDebugStep ?
              'buffer pass is not a verified one-Draw physical render pass' :
              !binding ?
                'Buffer ID, slot, or byte range does not match selected Draw bindings' :
                item.reason || item.rawReason || 'pre-Draw buffer bytes were not captured' });
        continue;
      }
      bufferSnapshots.push({ ...base, beforeCommandIndex: pass.frameDebugStep.drawCommandIndex,
        rawFile: raw.name, rawByteLength: raw.bytes, rawSha256: raw.sha256 });
    }
    for (const item of selectedDetail?.aspects ?? []) {
      const pass = renderPasses[item.passOrdinal];
      const target = pass?.targets?.find(value => value.kind === 'depth-stencil');
      const sourceTexture = report.resources.textures.find(value => value.id === target?.textureId);
      const image = job.aspectImages.get(item.aspectOrdinal);
      const raw = job.aspectRaw.get(item.aspectOrdinal);
      const base = {
        frameOrdinal: targetOrdinal, passIndex: pass?.index ?? null,
        aspectOrdinal: item.aspectOrdinal, passOrdinal: item.passOrdinal,
        aspect: item.aspect, textureId: item.textureId, viewId: item.viewId,
        width: item.width, height: item.height, sourceFormat: item.sourceFormat,
        rawFormat: item.rawFormat, sampleCount: item.sampleCount, sampleIndex: item.sampleIndex,
        label: item.label,
      };
      const attachmentMatches = pass?.label === item.label &&
        target?.textureId === item.textureId && target?.viewId === item.viewId &&
        (target.format == null || target.format === item.sourceFormat) &&
        (sourceTexture?.descriptor?.sampleCount == null ||
          sourceTexture.descriptor.sampleCount === item.sampleCount);
      if (!attachmentMatches || (!image && !raw)) {
        aspectSnapshots.push({ ...base, reason: !pass ?
          'aspect pass ordinal does not exist in the captured frame' :
            !target || pass.label !== item.label || target.textureId !== item.textureId ||
              target.viewId !== item.viewId ||
              target.format != null && target.format !== item.sourceFormat ?
                'depth/stencil attachment IDs, format, or pass label differ from Inspector capture' :
              !attachmentMatches ? 'depth/stencil sample count differs from Inspector capture' :
                item.reason || 'depth/stencil pixels were not captured' });
        continue;
      }
      aspectSnapshots.push({ ...base, afterCommandIndex: pass.endCommand,
        ...(image ? { file: image.name, imageSha256: image.sha256 } :
          { imageReason: item.imageReason || 'Aspect PNG was not saved' }),
        ...(raw ? { rawFile: raw.name, rawBytesPerRow: raw.bytesPerRow,
          rawByteLength: raw.bytes, rawSha256: raw.sha256 } :
          { rawReason: item.rawReason || 'Aspect raw pixels were not saved' }),
      });
    }
    if (selectedDetail) {
      const recorded = new Set(selectedDetail.aspects.map(item => `${item.passOrdinal}:${item.aspect}`));
      for (let ordinal = 0; ordinal < renderPasses.length; ordinal++) {
        const pass = renderPasses[ordinal];
        const target = pass.targets?.find(value => value.kind === 'depth-stencil');
        if (!target) continue;
        const format = target.format ?? '';
        const expected = [
          ...(format.startsWith('depth') ? ['depth'] : []),
          ...(format.includes('stencil8') ? ['stencil'] : []),
        ];
        const sourceTexture = report.resources.textures.find(value => value.id === target.textureId);
        for (const aspect of expected) {
          if (recorded.has(`${ordinal}:${aspect}`)) continue;
          aspectSnapshots.push({ frameOrdinal: targetOrdinal, passIndex: pass.index,
            aspectOrdinal: null, passOrdinal: ordinal, aspect,
            textureId: target.textureId, viewId: target.viewId,
            width: sourceTexture?.width ?? null, height: sourceTexture?.height ?? null,
            sourceFormat: format, rawFormat: aspect === 'depth' ? 'r32float' : 'stencil8',
            sampleCount: sourceTexture?.descriptor?.sampleCount ?? 1, sampleIndex: null,
            label: pass.label,
            reason: ordinal >= MAX_DIAGNOSTIC_ENTRIES || selectedDetail.aspects.length >= MAX_ASPECT_ENTRIES ?
              'RHI aspect diagnostic record limit reached' :
              'RHI did not emit a depth/stencil diagnostic for this pass' });
        }
      }
    }
    for (const item of selectedDetail?.gpuPasses ?? []) {
      const pass = gamePasses[item.ordinal];
      if (pass?.type === item.kind && pass.label === item.label) {
        gpuTimings.push({ frameOrdinal: pass.frameOrdinal, passIndex: pass.index,
          durationMs: item.durationMs, source: 'webgpu-timestamp-query' });
      }
    }
    const sidecars = { schemaVersion: 1,
      actualFrames, detailedFrameIndex: job.detailedFrameIndex,
      diagnosticFrameOrdinal: selectedDetail ? targetOrdinal : null,
      frames: [...job.frameImages].sort(([a], [b]) => a - b).filter(([index]) => index <= actualFrames)
        .map(([index, image]) => {
          const frame = frameMappingComplete ? captureFrames[index - 1] : null;
          return frame ? { frameIndex: index, frameOrdinal: frame.frameOrdinal,
            file: image.name, sha256: image.sha256,
            width: image.width, height: image.height } : null;
        }).filter(Boolean),
      passSnapshots, passUnavailable, inputSnapshots, aspectSnapshots, bufferSnapshots, gpuTimings,
      gpuProfilerStatus: selectedDetail?.gpuProfilerStatus ?? null,
      passCaptureWarning: frameIdentityIssue ?? selectedDetail?.warning ?? null };
    const manifestText = JSON.stringify(sidecars, null, 2) + '\n';
    if (Buffer.byteLength(manifestText) > MAX_SIDECAR_MANIFEST_BYTES) {
      throw new Error('sidecar manifest exceeds 4 MiB limit');
    }
    await writeFile(join(job.outputDir, 'sidecars.json'), manifestText, { flag: 'wx' });
    return { frameIndex: job.detailedFrameIndex,
      selectedFrameUnavailable: frameIdentityIssue ?? null,
      passSnapshots: passSnapshots.length,
      rawPassSnapshots: passSnapshots.filter(item => item.rawFile).length,
      inputSnapshots: inputSnapshots.filter(item => item.file || item.rawFile).length,
      inputUnavailable: inputSnapshots.filter(item => item.reason).length,
      aspectSnapshots: aspectSnapshots.filter(item => item.file || item.rawFile).length,
      aspectUnavailable: aspectSnapshots.filter(item => item.reason).length,
      bufferSnapshots: bufferSnapshots.filter(item => item.rawFile).length,
      bufferUnavailable: bufferSnapshots.filter(item => item.reason).length,
      passUnavailable: passUnavailable.length, gpuTimedPasses: gpuTimings.length };
  }

  async function upload({ jobId, targetBootId, stream, actualFrames, contentLength } = {}) {
    if (closed) throw new Error('capture controller is closed');
    const job = getJob(jobId, targetBootId);
    if (!['pending', 'capturing'].includes(job.state) || job.uploadInProgress) throw new Error('capture job is not accepting an upload');
    const count = Number(actualFrames);
    if (!Number.isInteger(count) || count < 1 || count > job.frames) throw new Error('actualFrames must be between 1 and requested frames');
    if (job.diagnostics && count < job.detailedFrameIndex) {
      throw new Error('actualFrames does not include the selected detailedFrameIndex');
    }
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
        detailedFrameIndex: job.detailedFrameIndex,
        actualFrames: count,
        createdAt: new Date(job.createdAt).toISOString(),
        captureFile: job.file,
        bytes,
        sha256: digest,
        ...captureSummary,
        ...(diagnosticsSummary ? { diagnostics: diagnosticsSummary } : {}),
        frameImages: [...job.frameImages].sort(([a], [b]) => a - b).map(([index, image]) => ({
          frameIndex: index, file: image.file, bytes: image.bytes,
          width: image.width, height: image.height, sha256: image.sha256,
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
    uploadPassRaw, uploadInputImage, uploadInputRaw,
    uploadAspectImage, uploadAspectRaw, uploadBufferRaw, history,
    diagnostics, upload, fail, stop, close };
}
