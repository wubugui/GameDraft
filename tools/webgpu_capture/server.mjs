// Local WebGPU Inspector capture broker. Both F2 and agents submit jobs here;
// only the game instance with the matching bootId may fulfill them.
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeCapture, readCapture, summarizeCapture } from './analyze.mjs';
import { inspectorCaptureFrames, verifiedDrawBufferBinding, verifiedInputBinding } from './analysis_sidecars.mjs';

const MAX_FRAMES = 120;
const MAX_CAPTURE_BYTES = 1024 * 1024 * 1024;
const MAX_FRAME_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_FRAME_IMAGES_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_PASS_RAW_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_DIAGNOSTIC_ENTRIES = 512;
const MAX_INPUT_ENTRIES = 1024;
const MAX_ASPECT_ENTRIES = 1024;
const MAX_BUFFER_ENTRIES = 8192;
const MAX_BUFFER_ITEM_BYTES = 256 * 1024 * 1024;
const MAX_BUFFER_RAW_BYTES = 256 * 1024 * 1024;
const MAX_INPUT_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_INPUT_IMAGES_BYTES = 512 * 1024 * 1024;
const MAX_INPUT_RAW_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ASPECT_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_ASPECT_IMAGES_BYTES = 512 * 1024 * 1024;
const MAX_ASPECT_RAW_BYTES = 512 * 1024 * 1024;
const MAX_RESOURCE_TEXTURE_ENTRIES = 8192;
const MAX_RESOURCE_BUFFER_ENTRIES = 4096;
const MAX_RESOURCE_TEXTURE_ITEM_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_RESOURCE_TEXTURE_RAW_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_RESOURCE_BUFFER_RAW_BYTES = 1024 * 1024 * 1024;
const MAX_SIDECAR_JOB_BYTES = 32 * 1024 * 1024 * 1024;
const MAX_SIDECAR_MANIFEST_BYTES = 64 * 1024 * 1024;
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
const JOB_TTL_MS = 60 * 60 * 1000;
const MAX_HISTORY = 20;
const MAX_DISK_HISTORY = 100;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_ANALYSIS_REPORT_BYTES = 64 * 1024 * 1024;
const MAX_ANALYSIS_INDEX_BYTES = 8 * 1024 * 1024;
const MAX_VIEWER_FILE_BYTES = 2 * 1024 * 1024 * 1024;
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

function inspectorTextureWriteBetween(capture, report, textureId, fromCommand, toCommand) {
  if (!Number.isSafeInteger(textureId) || !Number.isInteger(fromCommand) ||
      !Number.isInteger(toCommand) || fromCommand > toCommand) return true;
  for (const pass of report.passes) {
    if (pass.type !== 'render' || pass.endCommand <= fromCommand ||
        pass.endCommand >= toCommand) continue;
    if (pass.targets?.some(target => [target.textureId, target.resolveTextureId,
      target.outputTextureId].includes(textureId))) return true;
  }
  const destinationArgument = new Map([
    ['writeTexture', 0], ['copyBufferToTexture', 1],
    ['copyTextureToTexture', 1], ['copyExternalImageToTexture', 1],
  ]);
  for (let index = fromCommand + 1; index < toCommand; index++) {
    const command = capture.metadata.commands[index];
    const method = command?.method;
    if (method === 'dispatchWorkgroups' || method === 'dispatchWorkgroupsIndirect') return true;
    if (destinationArgument.has(method)) {
      const destination = command.args?.[destinationArgument.get(method)];
      const destinationId = destination?.texture?.__id ?? destination?.__id;
      if (!Number.isSafeInteger(destinationId) || destinationId === textureId) return true;
    } else if (typeof method === 'string' && /texture/i.test(method) &&
        !['getCurrentTexture', 'createView', 'copyTextureToBuffer'].includes(method)) {
      // Unknown texture operation: sharing would require an unproved write check.
      return true;
    }
  }
  return false;
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

function defaultOutputDirectory() {
  return join(process.env.LOCALAPPDATA || join(homedir(), '.local', 'share'),
    'GameDraft', 'webgpu-captures');
}

function settingsFile() {
  return join(process.env.LOCALAPPDATA || join(homedir(), '.local', 'share'),
    'GameDraft', 'webgpu-capture-settings.json');
}

async function outputRoot(projectRoot, base = defaultOutputDirectory(), create = true) {
  if (typeof base !== 'string' || !isAbsolute(base) || !base.trim() || base.length > 2048) {
    throw new Error('capture outputDirectory must be an absolute path');
  }
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
  if (create) await mkdir(candidate, { recursive: true });
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
    resourceFrames: job.resourceFrames ??
      (job.diagnostics instanceof Map ? [...job.diagnostics.keys()].sort((a, b) => a - b) : []),
    bytes: job.bytes ?? 0,
    sha256: job.sha256 ?? null,
    outputDir: job.state === 'completed' ? job.outputDir : null,
    captureFile: job.state === 'completed' ? job.file : null,
    error: job.error ?? null,
    createdAt: new Date(job.createdAt).toISOString(),
    updatedAt: new Date(job.updatedAt).toISOString(),
  };
}

export function createWebGpuCaptureController(projectRoot, { writeManifest = writeFile } = {}) {
  const root = resolve(projectRoot);
  const clients = new Map();
  const jobs = new Map();
  const diskJobs = new Map();
  const diskLoads = new Map();
  let activeJobId = null;
  let requestInFlight = false;
  let closed = false;

  async function loadSettings() {
    let data;
    try { data = JSON.parse(await readFile(settingsFile(), 'utf8')); }
    catch (error) {
      if (error?.code === 'ENOENT') return { outputDirectory: null, historyDirectories: [] };
      throw new Error(`capture settings cannot be read: ${text(error)}`);
    }
    if (!data || data.schemaVersion !== 1 ||
        (data.outputDirectory !== null && data.outputDirectory !== undefined &&
          (typeof data.outputDirectory !== 'string' || !isAbsolute(data.outputDirectory))) ||
        !Array.isArray(data.historyDirectories) || data.historyDirectories.length > 32 ||
        data.historyDirectories.some(path => typeof path !== 'string' || !isAbsolute(path))) {
      throw new Error('capture settings file is invalid');
    }
    return { outputDirectory: data.outputDirectory ?? null,
      historyDirectories: data.historyDirectories };
  }

  async function getSettings() {
    const settings = await loadSettings();
    return { outputDirectory: process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR ||
      settings.outputDirectory || defaultOutputDirectory() };
  }

  async function saveSettings(settings) {
    const file = settingsFile();
    await mkdir(dirname(file), { recursive: true });
    const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await writeFile(temp, JSON.stringify({ schemaVersion: 1, ...settings }, null, 2) + '\n', { flag: 'wx' });
      await rename(temp, file);
    } catch (error) {
      try { await unlink(temp); } catch { /* Preserve the first error. */ }
      throw error;
    }
  }

  async function setSettings({ outputDirectory } = {}) {
    if (closed) throw new Error('capture controller is closed');
    const selected = await outputRoot(root, outputDirectory);
    const old = await loadSettings();
    const historyDirectories = [...new Set([
      old.outputDirectory || defaultOutputDirectory(), ...old.historyDirectories,
    ].filter(path => resolve(path).toLowerCase() !== selected.toLowerCase()))].slice(0, 32);
    await saveSettings({ outputDirectory: selected, historyDirectories });
    return getSettings();
  }

  async function rememberOutputDirectory(base) {
    const old = await loadSettings();
    if (resolve(base).toLowerCase() === resolve(old.outputDirectory || defaultOutputDirectory()).toLowerCase() ||
        old.historyDirectories.some(path => resolve(path).toLowerCase() === resolve(base).toLowerCase())) return;
    await saveSettings({ outputDirectory: old.outputDirectory,
      historyDirectories: [base, ...old.historyDirectories].slice(0, 32) });
  }

  async function readableOutputRoots() {
    if (process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR) {
      try { return [await outputRoot(root, process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR, false)]; }
      catch { return []; }
    }
    const settings = await loadSettings();
    const candidates = [settings.outputDirectory, ...settings.historyDirectories,
      defaultOutputDirectory()];
    const roots = [];
    for (const candidate of [...new Set(candidates.filter(Boolean))]) {
      try { roots.push(await outputRoot(root, candidate, false)); }
      catch { /* Stale or unsafe saved roots cannot expose files. */ }
    }
    return [...new Set(roots)];
  }

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
        (manifest.resourceFrames !== undefined &&
          (!Array.isArray(manifest.resourceFrames) ||
            manifest.resourceFrames.length !== manifest.actualFrames ||
            manifest.resourceFrames.some((frame, index) => frame !== index + 1))) ||
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
      detailedFrameIndex, actualFrames: manifest.actualFrames,
      resourceFrames: Array.isArray(manifest.resourceFrames) ? manifest.resourceFrames : [],
      bytes: info.size,
      sha256: manifest.sha256, outputDir, file, state: 'completed', error: null,
      createdAt, updatedAt: Date.parse(manifest.capturedAt) || createdAt, dateDir: day, base,
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
        for (const base of await readableOutputRoots()) {
        for (const day of await savedDates(base)) {
          try {
            const job = await savedJob(base, day, id);
            diskJobs.set(id, job);
            if (diskJobs.size > MAX_DISK_HISTORY) diskJobs.delete(diskJobs.keys().next().value);
            return job;
          } catch { /* Other dates, incomplete uploads, and forged files are ignored. */ }
        }
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
    const candidates = [];
    for (const base of await readableOutputRoots()) {
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
    }
    candidates.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    const result = [];
    for (const candidate of candidates) {
      if (result.length >= limit) break;
      try {
        const cached = diskJobs.get(candidate.id);
        const job = cached && await unchangedSavedJob(cached) &&
          cached.sha256 === candidate.sha256 && cached.bytes === candidate.bytes ? cached :
          await savedJob(candidate.base, candidate.dateDir, candidate.id);
        diskJobs.set(candidate.id, job);
        result.push({ id: job.id, state: 'completed', requestedFrames: job.frames,
          detailedFrameIndex: job.detailedFrameIndex, actualFrames: job.actualFrames,
          resourceFrames: job.resourceFrames,
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

  async function request({ targetBootId = '', frames = 1, detailedFrameIndex = 1,
    outputDirectory } = {}) {
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
      const settings = await loadSettings();
      const base = await outputRoot(root, process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR ||
        outputDirectory || settings.outputDirectory || defaultOutputDirectory());
      if (!process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR) await rememberOutputDirectory(base);
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
        uploadInProgress: false, frameImages: new Map(), passImages: new Map(), passRaw: new Map(), diagnostics: new Map(),
        inputImages: new Map(), inputRaw: new Map(), inputRawInProgress: new Set(),
        aspectImages: new Map(), aspectRaw: new Map(), aspectRawInProgress: new Set(),
        bufferRaw: new Map(), bufferRawInProgress: new Set(),
        resourceTextureImages: new Map(), resourceTextureRaw: new Map(),
        resourceTextureRawInProgress: new Set(),
        resourceBufferRaw: new Map(), resourceBufferRawInProgress: new Set(),
        frameImageInProgress: new Set(), frameImageBytes: 0,
        reservedFrameImageBytes: 0, passRawInProgress: new Set(), passRawBytes: 0,
        reservedPassRawBytes: 0, inputImageBytes: 0, reservedInputImageBytes: 0,
        inputRawBytes: 0, reservedInputRawBytes: 0,
        aspectImageBytes: 0, reservedAspectImageBytes: 0,
        aspectRawBytes: 0, reservedAspectRawBytes: 0,
        bufferRawBytes: 0, reservedBufferRawBytes: 0,
        sidecarBudgets: new Map(), sidecarBytes: 0, reservedSidecarBytes: 0,
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

  // Ordinals are local to each frame. An omitted frame is accepted only for
  // older single-frame clients.
  function diagnosticFrameIndex(job, frameIndex) {
    const frame = frameIndex === undefined && job.frames === 1 ? 1 : frameIndex;
    if (!Number.isInteger(frame) || frame < 1 || frame > job.frames) {
      throw new Error('diagnostic frameIndex must be within requested frames');
    }
    return frame;
  }

  function diagnosticFilePrefix(job, frame) {
    return job.frames === 1 ? '' : `frame-${String(frame).padStart(4, '0')}-`;
  }

  function diagnosticKey(frame, ordinal, subOrdinal) {
    return subOrdinal === undefined ? `${frame}:${ordinal}` : `${frame}:${ordinal}:${subOrdinal}`;
  }

  function sidecarBudget(job, kind, frame) {
    const key = `${kind}:${frame}`;
    if (!job.sidecarBudgets.has(key)) job.sidecarBudgets.set(key, { used: 0, reserved: 0 });
    return job.sidecarBudgets.get(key);
  }

  function requireSidecarBudget(job, budget, bytes, limit, kind) {
    if (budget.used + budget.reserved + bytes > limit ||
        job.sidecarBytes + job.reservedSidecarBytes + bytes > MAX_SIDECAR_JOB_BYTES) {
      throw new Error(`${kind} exceeds per-frame or 32 GiB capture sidecar limit`);
    }
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
      ...(report.resourceTextureSnapshots || []).map(snapshot => snapshot.imageFile),
      ...(report.resourceTextureSnapshots || []).map(snapshot => snapshot.rawFile),
      ...(report.resourceBufferSnapshots || []).map(snapshot => snapshot.rawFile),
      ...(report.payloads || []).map(payload => payload.bufferFile),
      ...(report.resources?.textures || []).map(texture => texture.imageFile),
      ...(report.resources?.shaders || []).map(shader => shader.codeFile),
    ].filter(value => typeof value === 'string'));
  }

  function validViewerPath(name) {
    return name && !isAbsolute(name) && !name.startsWith('/') &&
      !name.split('/').some(part => !part || part === '.' || part === '..' || part.includes('\\'));
  }

  async function analyzedWithIndex(job, strictSidecars = false) {
    const analysis = await analyzeCapture(job.file, { strictSidecars, preferHardLinks: true });
    const files = {};
    const base = await realpath(analysis.outputDir);
    for (const name of viewerFiles(analysis.report)) {
      if (!validViewerPath(name)) throw new Error('analysis report lists an invalid file');
      const { physical, info } = await checkedFile(base, resolve(base, name), MAX_VIEWER_FILE_BYTES);
      const verified = analysis.verifiedSidecarFiles?.get(name);
      const linkedInfo = verified ? await lstat(physical, { bigint: true }) : null;
      const sameVerifiedInode = verified && /^[0-9a-f]{64}$/.test(verified.sha256) &&
        linkedInfo.isFile() && linkedInfo.ino > 0n &&
        linkedInfo.dev === verified.dev && linkedInfo.ino === verified.ino &&
        linkedInfo.size === verified.size && BigInt(info.size) === verified.size &&
        linkedInfo.mtimeNs === verified.mtimeNs &&
        linkedInfo.ctimeNs === verified.ctimeNs;
      files[name] = { bytes: info.size,
        sha256: sameVerifiedInode ? verified.sha256 : await fileSha256(physical) };
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
            integrity.files[name].bytes < 0 || integrity.files[name].bytes > MAX_VIEWER_FILE_BYTES)) continue;
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
    const { physical, info } = await checkedFile(base, resolve(base, requested), MAX_VIEWER_FILE_BYTES);
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
    inputOrdinal, aspectOrdinal, resourceOrdinal, stream, contentLength }, kind) {
    if (closed) throw new Error('capture controller is closed');
    const job = getJob(jobId, targetBootId);
    const frame = kind === 'frame' ? Number(frameIndex) : diagnosticFrameIndex(job, frameIndex);
    const pass = Number(passOrdinal);
    const color = Number(colorIndex);
    const input = Number(inputOrdinal);
    const aspect = Number(aspectOrdinal);
    const resource = Number(resourceOrdinal);
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
    if (kind === 'resource-texture' && (!Number.isInteger(resource) ||
        resource < 0 || resource >= MAX_RESOURCE_TEXTURE_ENTRIES)) {
      throw new Error('resource texture image requires a valid resource ordinal');
    }
    const key = kind === 'pass' ? diagnosticKey(frame, pass, color) :
      kind === 'input' ? diagnosticKey(frame, input) :
      kind === 'aspect' ? diagnosticKey(frame, aspect) :
      kind === 'resource-texture' ? diagnosticKey(frame, resource) : frame;
    const images = kind === 'pass' ? job.passImages : kind === 'input' ? job.inputImages :
      kind === 'aspect' ? job.aspectImages : kind === 'resource-texture' ?
        job.resourceTextureImages : job.frameImages;
    const bytesField = kind === 'input' ? 'inputImageBytes' :
      kind === 'aspect' ? 'aspectImageBytes' : 'frameImageBytes';
    const reservedField = kind === 'input' ? 'reservedInputImageBytes' :
      kind === 'aspect' ? 'reservedAspectImageBytes' : 'reservedFrameImageBytes';
    const singleLimit = kind === 'input' ? MAX_INPUT_IMAGE_BYTES :
      kind === 'aspect' ? MAX_ASPECT_IMAGE_BYTES : MAX_FRAME_IMAGE_BYTES;
    const totalLimit = kind === 'input' ? MAX_INPUT_IMAGES_BYTES :
      kind === 'aspect' ? MAX_ASPECT_IMAGES_BYTES :
      kind === 'resource-texture' ? MAX_RESOURCE_TEXTURE_RAW_BYTES : MAX_FRAME_IMAGES_BYTES;
    const budget = kind === 'frame' ? null : sidecarBudget(job, `${kind}-image`, frame);
    if (!['pending', 'capturing'].includes(job.state) || job.uploadInProgress) {
      throw new Error('capture job is not accepting images');
    }
    if (kind !== 'frame' && job.diagnostics.has(frame)) {
      throw new Error('frame diagnostics already uploaded');
    }
    if (images.has(key) || job.frameImageInProgress.has(`${kind}:${key}`)) {
      throw new Error('image already uploaded or uploading');
    }
    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
      throw new Error('frame image binary stream is required');
    }
    if (contentLength != null && (!Number.isInteger(Number(contentLength)) ||
        Number(contentLength) < 24 || Number(contentLength) > singleLimit ||
        (kind === 'frame' && job[bytesField] + job[reservedField] + Number(contentLength) > totalLimit) ||
        (budget && (budget.used + budget.reserved + Number(contentLength) > totalLimit ||
          job.sidecarBytes + job.reservedSidecarBytes + Number(contentLength) > MAX_SIDECAR_JOB_BYTES)))) {
      throw new Error(`${kind} image exceeds capture image size limit`);
    }
    const prefix = kind === 'frame' ? '' : diagnosticFilePrefix(job, frame);
    const name = kind === 'pass' ? `${prefix}pass-${String(pass).padStart(4, '0')}-color-${color}.png` :
      kind === 'input' ? `${prefix}input-${String(input).padStart(4, '0')}.png` :
      kind === 'aspect' ? `${prefix}aspect-${String(aspect).padStart(4, '0')}.png` :
      kind === 'resource-texture' ? `${prefix}resource-texture-${String(resource).padStart(4, '0')}.png` :
        `frame-${String(frame).padStart(4, '0')}.png`;
    const file = join(job.outputDir, name);
    job.frameImageInProgress.add(`${kind}:${key}`);
    let handle;
    let bytes = 0;
    let reservedBytes = 0;
    const sha = createHash('sha256');
    try {
      handle = await open(file, 'wx+');
      for await (const part of stream) {
        if (closed || !['pending', 'capturing'].includes(job.state)) throw new Error('capture stopped while uploading frame image');
        const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
        bytes += chunk.length;
        if (bytes > singleLimit) throw new Error(`${kind} image exceeds capture image size limit`);
        if (budget) {
          requireSidecarBudget(job, budget, chunk.length, totalLimit, `${kind} image`);
          budget.reserved += chunk.length;
          job.reservedSidecarBytes += chunk.length;
        } else job[reservedField] += chunk.length;
        reservedBytes += chunk.length;
        if (!budget && job[bytesField] + job[reservedField] > totalLimit) {
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
      if (budget) { budget.used += bytes; job.sidecarBytes += bytes; }
      else job[bytesField] += bytes;
      job.updatedAt = Date.now();
      return { jobId: job.id, frameIndex: frame, passOrdinal: kind === 'pass' ? pass : null,
        inputOrdinal: kind === 'input' ? input : null,
        aspectOrdinal: kind === 'aspect' ? aspect : null,
        resourceOrdinal: kind === 'resource-texture' ? resource : null,
        colorIndex: kind === 'pass' ? color : null, file, bytes, width, height };
    } catch (error) {
      try { await handle?.close(); } catch { /* Keep the first failure. */ }
      try { await unlink(file); } catch { /* File may not exist. */ }
      throw error;
    } finally {
      if (budget) { budget.reserved -= reservedBytes; job.reservedSidecarBytes -= reservedBytes; }
      else job[reservedField] -= reservedBytes;
      job.frameImageInProgress.delete(`${kind}:${key}`);
    }
  }

  function uploadFrameImage(args = {}) { return uploadPngImage(args, 'frame'); }
  function uploadPassImage(args = {}) { return uploadPngImage(args, 'pass'); }
  function uploadInputImage(args = {}) { return uploadPngImage(args, 'input'); }
  function uploadAspectImage(args = {}) { return uploadPngImage(args, 'aspect'); }
  function uploadResourceTextureImage(args = {}) { return uploadPngImage(args, 'resource-texture'); }

  async function uploadRaw({ jobId, targetBootId, frameIndex, passOrdinal, colorIndex,
    inputOrdinal, aspectOrdinal, resourceOrdinal, format, width, height, bytesPerRow,
    stream, contentLength } = {}, kind) {
    if (closed) throw new Error('capture controller is closed');
    const job = getJob(jobId, targetBootId);
    const frame = diagnosticFrameIndex(job, frameIndex);
    const pass = Number(passOrdinal);
    const color = Number(colorIndex);
    const input = Number(inputOrdinal);
    const aspect = Number(aspectOrdinal);
    const resource = Number(resourceOrdinal);
    const w = Number(width);
    const h = Number(height);
    const stride = Number(bytesPerRow);
    const bpp = RAW_FORMAT_BYTES.get(format);
    if ((kind === 'pass' &&
        (!Number.isInteger(pass) || pass < 0 || pass >= MAX_DIAGNOSTIC_ENTRIES ||
        !Number.isInteger(color) || color < 0 || color > 7)) ||
        (kind === 'input' && (!Number.isInteger(input) || input < 0 || input >= MAX_INPUT_ENTRIES)) ||
        (kind === 'aspect' && (!Number.isInteger(aspect) || aspect < 0 || aspect >= MAX_ASPECT_ENTRIES)) ||
        (kind === 'resource-texture' && (!Number.isInteger(resource) || resource < 0 ||
          resource >= MAX_RESOURCE_TEXTURE_ENTRIES))) {
      throw new Error(`raw ${kind} output requires a valid ordinal`);
    }
    if (!bpp || kind === 'aspect' && !['r32float', 'stencil8'].includes(format) ||
        !Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w < 1 || h < 1 ||
        w > 16384 || h > 16384 || !Number.isSafeInteger(stride) ||
        stride !== Math.ceil(w * bpp / 256) * 256 &&
          !(kind === 'resource-texture' && stride === w * bpp)) {
      throw new Error(`raw ${kind} output format, dimensions, or row stride is invalid`);
    }
    const expected = stride * h;
    if (!Number.isSafeInteger(expected) || expected > (kind === 'input' ? MAX_INPUT_RAW_BYTES :
        kind === 'aspect' ? MAX_ASPECT_RAW_BYTES : kind === 'resource-texture' ?
          MAX_RESOURCE_TEXTURE_ITEM_BYTES : MAX_PASS_RAW_BYTES) ||
        contentLength != null && Number(contentLength) !== expected) {
      throw new Error(`raw ${kind} output byte length exceeds the limit or differs from dimensions`);
    }
    if (!['pending', 'capturing'].includes(job.state) || job.uploadInProgress) {
      throw new Error(`capture job is not accepting raw ${kind} output`);
    }
    const key = kind === 'input' ? diagnosticKey(frame, input) :
      kind === 'aspect' ? diagnosticKey(frame, aspect) :
      kind === 'resource-texture' ? diagnosticKey(frame, resource) : diagnosticKey(frame, pass, color);
    const raw = kind === 'input' ? job.inputRaw : kind === 'aspect' ? job.aspectRaw :
      kind === 'resource-texture' ? job.resourceTextureRaw : job.passRaw;
    const inProgress = kind === 'input' ? job.inputRawInProgress :
      kind === 'aspect' ? job.aspectRawInProgress : kind === 'resource-texture' ?
        job.resourceTextureRawInProgress : job.passRawInProgress;
    const totalLimit = kind === 'input' ? MAX_INPUT_RAW_BYTES :
      kind === 'aspect' ? MAX_ASPECT_RAW_BYTES : kind === 'resource-texture' ?
        MAX_RESOURCE_TEXTURE_RAW_BYTES : MAX_PASS_RAW_BYTES;
    const budget = sidecarBudget(job, `${kind}-raw`, frame);
    if (job.diagnostics.has(frame)) throw new Error('frame diagnostics already uploaded');
    if (raw.has(key) || inProgress.has(key)) throw new Error(`raw ${kind} output already uploaded`);
    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') throw new Error(`raw ${kind} output stream is required`);
    requireSidecarBudget(job, budget, expected, totalLimit, `raw ${kind} output`);
    const prefix = diagnosticFilePrefix(job, frame);
    const name = kind === 'input' ? `${prefix}input-${String(input).padStart(4, '0')}.bin` :
      kind === 'aspect' ? `${prefix}aspect-${String(aspect).padStart(4, '0')}.bin` :
      kind === 'resource-texture' ? `${prefix}resource-texture-${String(resource).padStart(4, '0')}.bin` :
      `${prefix}pass-raw-${String(pass).padStart(4, '0')}-color-${color}.bin`;
    const file = join(job.outputDir, name);
    let handle;
    let bytes = 0;
    const sha = createHash('sha256');
    inProgress.add(key);
    budget.reserved += expected;
    job.reservedSidecarBytes += expected;
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
      budget.used += bytes;
      job.sidecarBytes += bytes;
      job.updatedAt = Date.now();
      return { jobId: job.id, frameIndex: frame,
        passOrdinal: kind === 'pass' ? pass : null,
        colorIndex: kind === 'pass' ? color : null,
        inputOrdinal: kind === 'input' ? input : null,
        aspectOrdinal: kind === 'aspect' ? aspect : null,
        resourceOrdinal: kind === 'resource-texture' ? resource : null,
        file, bytes, format, width: w, height: h, bytesPerRow: stride };
    } catch (error) {
      try { await handle?.close(); } catch { /* Keep the first failure. */ }
      try { await unlink(file); } catch { /* File may not exist. */ }
      throw error;
    } finally {
      budget.reserved -= expected;
      job.reservedSidecarBytes -= expected;
      inProgress.delete(key);
    }
  }

  function uploadPassRaw(args = {}) { return uploadRaw(args, 'pass'); }
  function uploadInputRaw(args = {}) { return uploadRaw(args, 'input'); }
  function uploadAspectRaw(args = {}) { return uploadRaw(args, 'aspect'); }
  function uploadResourceTextureRaw(args = {}) { return uploadRaw(args, 'resource-texture'); }

  async function uploadBufferRawKind({ jobId, targetBootId, frameIndex, bufferOrdinal,
    resourceOrdinal, stream, contentLength } = {}, kind) {
    if (closed) throw new Error('capture controller is closed');
    const job = getJob(jobId, targetBootId);
    const frame = diagnosticFrameIndex(job, frameIndex);
    const resource = kind === 'resource-buffer';
    const ordinal = Number(resource ? resourceOrdinal : bufferOrdinal);
    const key = diagnosticKey(frame, ordinal);
    const budget = sidecarBudget(job, kind, frame);
    const itemLimit = resource ? MAX_RESOURCE_BUFFER_RAW_BYTES : MAX_BUFFER_ITEM_BYTES;
    const totalLimit = resource ? MAX_RESOURCE_BUFFER_RAW_BYTES : MAX_BUFFER_RAW_BYTES;
    const raw = resource ? job.resourceBufferRaw : job.bufferRaw;
    const inProgress = resource ? job.resourceBufferRawInProgress : job.bufferRawInProgress;
    if (!Number.isInteger(ordinal) ||
        ordinal < 0 || ordinal >= (resource ? MAX_RESOURCE_BUFFER_ENTRIES : MAX_BUFFER_ENTRIES)) {
      throw new Error('raw Draw buffer requires a valid buffer ordinal');
    }
    if (!['pending', 'capturing'].includes(job.state) || job.uploadInProgress) {
      throw new Error('capture job is not accepting raw Draw buffers');
    }
    if (job.diagnostics.has(frame)) throw new Error('frame diagnostics already uploaded');
    if (raw.has(key) || inProgress.has(key)) {
      throw new Error('raw Draw buffer already uploaded');
    }
    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
      throw new Error('raw Draw buffer stream is required');
    }
    if (contentLength != null && (!Number.isSafeInteger(Number(contentLength)) ||
        Number(contentLength) < 4 || Number(contentLength) % 4 !== 0 ||
        Number(contentLength) > itemLimit ||
        budget.used + budget.reserved + Number(contentLength) > totalLimit ||
        job.sidecarBytes + job.reservedSidecarBytes + Number(contentLength) > MAX_SIDECAR_JOB_BYTES)) {
      throw new Error('raw Draw buffer length exceeds limit or is not 4-byte aligned');
    }
    const name = `${diagnosticFilePrefix(job, frame)}${resource ? 'resource-buffer' : 'buffer'}-${String(ordinal).padStart(4, '0')}.bin`;
    const file = join(job.outputDir, name);
    inProgress.add(key);
    const sha = createHash('sha256');
    let bytes = 0;
    let reservedBytes = 0;
    let handle;
    try {
      handle = await open(file, 'wx');
      for await (const part of stream) {
        if (closed || !['pending', 'capturing'].includes(job.state)) {
          throw new Error('capture stopped while uploading raw Draw buffer');
        }
        const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
        bytes += chunk.length;
        if (bytes > itemLimit) {
          throw new Error('raw Draw buffers exceed capture size limit');
        }
        requireSidecarBudget(job, budget, chunk.length, totalLimit, 'raw Draw buffers');
        budget.reserved += chunk.length;
        job.reservedSidecarBytes += chunk.length;
        reservedBytes += chunk.length;
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
      raw.set(key, { file, name, bytes, sha256: sha.digest('hex') });
      budget.used += bytes;
      job.sidecarBytes += bytes;
      job.updatedAt = Date.now();
      return { jobId: job.id, frameIndex: frame,
        ...(resource ? { resourceOrdinal: ordinal } : { bufferOrdinal: ordinal }), file, bytes };
    } catch (error) {
      try { await handle?.close(); } catch { /* Keep the first failure. */ }
      try { await unlink(file); } catch { /* File may not exist. */ }
      throw error;
    } finally {
      budget.reserved -= reservedBytes;
      job.reservedSidecarBytes -= reservedBytes;
      inProgress.delete(key);
    }
  }

  function uploadBufferRaw(args = {}) { return uploadBufferRawKind(args, 'buffer'); }
  function uploadResourceBufferRaw(args = {}) { return uploadBufferRawKind(args, 'resource-buffer'); }

  function diagnostics({ jobId, targetBootId, frameIndex, passes, inputs = [], aspects = [], buffers = [],
    resourceInventory, resourceTextures, resourceBuffers,
    gpuPasses, gpuProfilerStatus, warning } = {}) {
    if (closed) throw new Error('capture controller is closed');
    const job = getJob(jobId, targetBootId);
    const frame = diagnosticFrameIndex(job, frameIndex);
    if (!['pending', 'capturing'].includes(job.state) || job.uploadInProgress) {
      throw new Error('detailed diagnostics require an active capture');
    }
    if (job.diagnostics.has(frame)) throw new Error('capture diagnostics already uploaded for this frame');
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
      const image = job.passImages.get(diagnosticKey(frame, item.passOrdinal, item.colorIndex));
      const raw = job.passRaw.get(diagnosticKey(frame, item.passOrdinal, item.colorIndex));
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
    const inputByOrdinal = new Map();
    const inputAliases = [];
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
           (item.contentVersion !== undefined &&
             (!Number.isSafeInteger(item.contentVersion) || item.contentVersion < 0)) ||
           (item.rawAliasInputOrdinal !== undefined &&
             (!Number.isSafeInteger(item.contentVersion) ||
               !Number.isInteger(item.rawAliasInputOrdinal) || item.rawAliasInputOrdinal < 0 ||
               item.rawAliasInputOrdinal >= item.inputOrdinal)) ||
           (item.reason !== undefined && (typeof item.reason !== 'string' || item.reason.length > 500)) ||
          (item.rawReason !== undefined && (typeof item.rawReason !== 'string' || item.rawReason.length > 500))) {
        throw new Error('invalid input diagnostic');
      }
      inputOrdinals.add(item.inputOrdinal);
      inputByOrdinal.set(item.inputOrdinal, item);
      const image = job.inputImages.get(diagnosticKey(frame, item.inputOrdinal));
      const raw = job.inputRaw.get(diagnosticKey(frame, item.inputOrdinal));
      if (item.rawAliasInputOrdinal !== undefined) {
        if (image || raw || item.reason || item.rawReason) {
          throw new Error('aliased input must not upload another file or report an unavailable reason');
        }
        inputAliases.push(item);
        continue;
      }
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
    const resolvedInputAliases = [];
    for (const item of inputAliases) {
      const source = inputByOrdinal.get(item.rawAliasInputOrdinal);
      const sourceKey = diagnosticKey(frame, item.rawAliasInputOrdinal);
      const raw = job.inputRaw.get(sourceKey);
      const image = job.inputImages.get(sourceKey);
      if (!source || source.rawAliasInputOrdinal !== undefined || !raw ||
          source.textureId === null || item.textureId !== source.textureId ||
          item.viewId !== source.viewId || item.mipLevel !== source.mipLevel ||
          item.arrayLayer !== source.arrayLayer || item.format !== source.format ||
          item.width !== source.width || item.height !== source.height ||
          item.contentVersion !== source.contentVersion ||
          item.rawBytesPerRow !== source.rawBytesPerRow ||
          item.rawByteLength !== source.rawByteLength ||
          raw.format !== item.format || raw.width !== item.width ||
          raw.height !== item.height || raw.bytesPerRow !== item.rawBytesPerRow ||
          raw.bytes !== item.rawByteLength ||
          (image && (image.width !== item.width || image.height !== item.height))) {
        throw new Error(`input ${item.inputOrdinal} raw alias differs from its same-frame uploaded source`);
      }
      resolvedInputAliases.push({ key: diagnosticKey(frame, item.inputOrdinal), raw, image });
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
      const image = job.aspectImages.get(diagnosticKey(frame, item.aspectOrdinal));
      const raw = job.aspectRaw.get(diagnosticKey(frame, item.aspectOrdinal));
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
      const raw = job.bufferRaw.get(diagnosticKey(frame, item.bufferOrdinal));
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
    if (!resourceInventory || !Number.isInteger(resourceInventory.textureCount) ||
        resourceInventory.textureCount < 0 || resourceInventory.textureCount > MAX_RESOURCE_TEXTURE_ENTRIES ||
        !Number.isInteger(resourceInventory.textureSubresourceCount) ||
        resourceInventory.textureSubresourceCount < 0 ||
        resourceInventory.textureSubresourceCount > MAX_RESOURCE_TEXTURE_ENTRIES ||
        !Number.isInteger(resourceInventory.bufferCount) ||
        resourceInventory.bufferCount < 0 || resourceInventory.bufferCount > MAX_RESOURCE_BUFFER_ENTRIES ||
        !Array.isArray(resourceTextures) ||
        resourceTextures.length !== resourceInventory.textureSubresourceCount ||
        !Array.isArray(resourceBuffers) || resourceBuffers.length !== resourceInventory.bufferCount) {
      throw new Error('frame-end resource inventory is missing or inconsistent');
    }
    const textureOrdinals = new Set();
    const textureObjects = new Map();
    for (let index = 0; index < resourceTextures.length; index++) {
      const item = resourceTextures[index];
      if (!item || item.resourceOrdinal !== index ||
          !Number.isInteger(item.textureOrdinal) || item.textureOrdinal < 0 ||
          item.textureOrdinal >= resourceInventory.textureCount ||
          (item.textureId !== null && (!Number.isSafeInteger(item.textureId) || item.textureId < 0)) ||
          typeof item.label !== 'string' || item.label.length > 200 ||
          !Number.isInteger(item.width) || item.width < 1 || item.width > 16384 ||
          !Number.isInteger(item.height) || item.height < 1 || item.height > 16384 ||
          typeof item.sourceFormat !== 'string' || item.sourceFormat.length > 80 ||
          !RAW_FORMAT_BYTES.has(item.rawFormat) ||
          !Number.isInteger(item.mipLevel) || item.mipLevel < 0 || item.mipLevel > 63 ||
          !Number.isInteger(item.arrayLayer) || item.arrayLayer < 0 || item.arrayLayer > 16383 ||
          !['color', 'depth', 'stencil'].includes(item.aspect) ||
          !Number.isInteger(item.sampleCount) || item.sampleCount < 1 || item.sampleCount > 32 ||
          item.captureMoment !== 'frame-end' ||
          (item.reason !== undefined && (typeof item.reason !== 'string' || item.reason.length > 500)) ||
          (item.rawReason !== undefined && (typeof item.rawReason !== 'string' || item.rawReason.length > 500))) {
        throw new Error('invalid frame-end resource texture diagnostic');
      }
      const priorId = textureObjects.get(item.textureOrdinal);
      if (priorId !== undefined && priorId !== item.textureId) {
        throw new Error('resource texture ordinal changes Inspector texture ID');
      }
      textureObjects.set(item.textureOrdinal, item.textureId);
      textureOrdinals.add(item.textureOrdinal);
      const image = job.resourceTextureImages.get(diagnosticKey(frame, index));
      const raw = job.resourceTextureRaw.get(diagnosticKey(frame, index));
      if (image && (image.width !== item.width || image.height !== item.height)) {
        throw new Error('frame-end resource texture PNG dimensions differ from diagnostic');
      }
      if (raw && (raw.width !== item.width || raw.height !== item.height ||
          raw.format !== item.rawFormat || raw.bytesPerRow !== item.rawBytesPerRow ||
          raw.bytes !== item.rawByteLength)) {
        throw new Error('frame-end resource texture raw differs from diagnostic');
      }
      if (!raw && !item.reason && !item.rawReason) {
        throw new Error('frame-end resource texture has no raw pixels or unavailable reason');
      }
    }
    if (textureOrdinals.size !== resourceInventory.textureCount ||
        Array.from({ length: resourceInventory.textureCount }, (_, ordinal) => ordinal)
          .some(ordinal => !textureOrdinals.has(ordinal))) {
      throw new Error('frame-end texture inventory ordinals are incomplete');
    }
    for (let index = 0; index < resourceBuffers.length; index++) {
      const item = resourceBuffers[index];
      if (!item || item.resourceOrdinal !== index ||
          (item.bufferId !== null && (!Number.isSafeInteger(item.bufferId) || item.bufferId < 0)) ||
          typeof item.label !== 'string' || item.label.length > 200 ||
          !Number.isSafeInteger(item.totalSize) || item.totalSize < 0 ||
          item.copiedOffset !== 0 || item.copiedSize !== item.totalSize ||
          item.captureMoment !== 'frame-end' ||
          (item.reason !== undefined && (typeof item.reason !== 'string' || item.reason.length > 500)) ||
          (item.rawReason !== undefined && (typeof item.rawReason !== 'string' || item.rawReason.length > 500))) {
        throw new Error('invalid frame-end resource Buffer diagnostic');
      }
      const raw = job.resourceBufferRaw.get(diagnosticKey(frame, index));
      if (raw && (raw.bytes !== item.totalSize || item.rawByteLength !== raw.bytes)) {
        throw new Error('frame-end resource Buffer raw differs from full Buffer size');
      }
      if (!raw && !item.reason && !item.rawReason) {
        throw new Error('frame-end resource Buffer has no raw bytes or unavailable reason');
      }
    }
    for (const alias of resolvedInputAliases) {
      job.inputRaw.set(alias.key, alias.raw);
      if (alias.image) job.inputImages.set(alias.key, alias.image);
    }
    job.diagnostics.set(frame, { frameIndex: frame, passes, inputs, aspects, buffers, gpuPasses,
      resourceInventory, resourceTextures, resourceBuffers, gpuProfilerStatus, warning });
    job.updatedAt = Date.now();
    return { jobId: job.id, frameIndex: frame,
      passImages: [...job.passImages.keys()].filter(key => key.startsWith(`${frame}:`)).length,
      passRecords: passes.length,
      inputImages: [...job.inputImages.keys()].filter(key => key.startsWith(`${frame}:`)).length,
      inputRecords: inputs.length,
      aspectImages: [...job.aspectImages.keys()].filter(key => key.startsWith(`${frame}:`)).length,
      aspectRecords: aspects.length,
      bufferRaw: [...job.bufferRaw.keys()].filter(key => key.startsWith(`${frame}:`)).length,
      bufferRecords: buffers.length,
      resourceTextures: resourceTextures.length, resourceBuffers: resourceBuffers.length,
      gpuPasses: gpuPasses.length };
  }

  async function writeSidecars(job, actualFrames) {
    for (let frameIndex = 1; frameIndex <= actualFrames; frameIndex++) {
      const detail = job.diagnostics.get(frameIndex);
      if (!detail) throw new Error(`frame ${frameIndex} has no diagnostic metadata`);
      for (const [kind, files, records, ordinal] of [
        ['pass image', job.passImages, detail.passes, item => diagnosticKey(frameIndex, item.passOrdinal, item.colorIndex)],
        ['pass raw', job.passRaw, detail.passes, item => diagnosticKey(frameIndex, item.passOrdinal, item.colorIndex)],
        ['input image', job.inputImages, detail.inputs, item => diagnosticKey(frameIndex, item.inputOrdinal)],
        ['input raw', job.inputRaw, detail.inputs, item => diagnosticKey(frameIndex, item.inputOrdinal)],
        ['aspect image', job.aspectImages, detail.aspects, item => diagnosticKey(frameIndex, item.aspectOrdinal)],
        ['aspect raw', job.aspectRaw, detail.aspects, item => diagnosticKey(frameIndex, item.aspectOrdinal)],
        ['Draw buffer', job.bufferRaw, detail.buffers, item => diagnosticKey(frameIndex, item.bufferOrdinal)],
        ['resource texture image', job.resourceTextureImages, detail.resourceTextures,
          item => diagnosticKey(frameIndex, item.resourceOrdinal)],
        ['resource texture raw', job.resourceTextureRaw, detail.resourceTextures,
          item => diagnosticKey(frameIndex, item.resourceOrdinal)],
        ['resource Buffer raw', job.resourceBufferRaw, detail.resourceBuffers,
          item => diagnosticKey(frameIndex, item.resourceOrdinal)],
      ]) {
        const recorded = new Set(records.map(ordinal));
        for (const key of files.keys()) {
          if (key.startsWith(`${frameIndex}:`) && !recorded.has(key)) {
            throw new Error(`uploaded ${kind} ${key} has no diagnostic metadata`);
          }
        }
      }
    }
    for (const frameIndex of job.diagnostics.keys()) {
      if (frameIndex > actualFrames) throw new Error(`frame ${frameIndex} diagnostics exceed actualFrames`);
    }
    for (const files of [job.passImages, job.passRaw, job.inputImages, job.inputRaw,
      job.aspectImages, job.aspectRaw, job.bufferRaw, job.resourceTextureImages,
      job.resourceTextureRaw, job.resourceBufferRaw]) {
      for (const key of files.keys()) {
        if (Number(key.split(':', 1)[0]) > actualFrames) {
          throw new Error(`uploaded frame ${key} diagnostic file exceeds actualFrames`);
        }
      }
    }
    if ([...job.frameImages.keys()].some(frameIndex => frameIndex > actualFrames)) {
      throw new Error('uploaded frame image exceeds actualFrames');
    }
    const capture = await readCapture(job.file);
    const report = summarizeCapture(capture);
    // Inspector can append command-only trailing frames. Never guess which
    // repeated Pass label belongs to the requested logical capture frame.
    const captureFrames = inspectorCaptureFrames(report.frames, report.passes, actualFrames);
    const frameMappingComplete = captureFrames.length === actualFrames;
    if (!frameMappingComplete) throw new Error(`${actualFrames} capture frames cannot be uniquely mapped to Inspector frames`);
    const passSnapshots = [];
    const passUnavailable = [];
    const inputSnapshots = [];
    const aspectSnapshots = [];
    const bufferSnapshots = [];
    const resourceTextureSnapshots = [];
    const resourceBufferSnapshots = [];
    const gpuTimings = [];
    const diagnosticFrames = [];
    for (let frameIndex = 1; frameIndex <= actualFrames; frameIndex++) {
    const detail = job.diagnostics.get(frameIndex);
    const targetFrame = captureFrames[frameIndex - 1];
    const targetOrdinal = targetFrame.frameOrdinal;
    const passes = report.passes.filter(pass => pass.frameOrdinal === targetOrdinal);
    const gamePasses = passes.filter(pass => !pass.diagnosticAuxiliary);
    const renderPasses = passes.filter(pass => pass.type === 'render');
    // A warning means at least one diagnostic was truncated, including GPU
    // readback and timing limits. A completed capture must not hide that loss.
    if (detail.warning?.trim()) {
      throw new Error(`frame ${frameIndex} diagnostics are incomplete: ${detail.warning}`);
    }
    if (!detail.passes.every(item => renderPasses[item.passOrdinal]?.label === item.label) ||
        !detail.aspects.every(item => renderPasses[item.passOrdinal]?.label === item.label) ||
        !detail.inputs.every(item => renderPasses[item.passOrdinal]) ||
        !detail.buffers.every(item => renderPasses[item.passOrdinal])) {
      throw new Error(`frame ${frameIndex} pass labels or order differ from the Inspector capture`);
    }
    const selectedDetail = detail;
    diagnosticFrames.push({ frameIndex, frameOrdinal: targetOrdinal,
      gpuProfilerStatus: detail.gpuProfilerStatus, passCaptureWarning: detail.warning ?? null,
      resourceInventory: detail.resourceInventory });
    for (const item of selectedDetail?.passes ?? []) {
      const pass = renderPasses[item.passOrdinal];
      const target = pass?.targets?.find(value => value.kind === 'color' && value.slot === item.colorIndex);
      const image = job.passImages.get(diagnosticKey(frameIndex, item.passOrdinal, item.colorIndex));
      const raw = job.passRaw.get(diagnosticKey(frameIndex, item.passOrdinal, item.colorIndex));
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
      const aliasSource = item.rawAliasInputOrdinal === undefined ? null :
        detail.inputs.find(source => source.inputOrdinal === item.rawAliasInputOrdinal);
      const sourcePass = aliasSource ? renderPasses[aliasSource.passOrdinal] : null;
      const rawSourceBeforeCommandIndex = sourcePass?.frameDebugStep?.drawCommandIndex;
      if (aliasSource && (pass?.frameDebugStep?.drawCommandIndex == null ||
          inspectorTextureWriteBetween(capture, report, item.textureId,
            rawSourceBeforeCommandIndex, pass.frameDebugStep.drawCommandIndex))) {
        throw new Error(`frame ${frameIndex} Draw input ${item.inputOrdinal} raw alias crosses an Inspector texture write or unverified Draw`);
      }
      const image = job.inputImages.get(diagnosticKey(frameIndex, item.inputOrdinal));
      const raw = job.inputRaw.get(diagnosticKey(frameIndex, item.inputOrdinal));
      const binding = verifiedInputBinding(pass, report.events, report.resources, item);
      const base = {
        frameOrdinal: targetOrdinal, passIndex: pass?.index ?? null,
        inputOrdinal: item.inputOrdinal, passOrdinal: item.passOrdinal,
        bindingName: item.bindingName, textureId: item.textureId, viewId: item.viewId,
        ...(item.contentVersion !== undefined ? { contentVersion: item.contentVersion } : {}),
        ...(aliasSource ? { rawAliasInputOrdinal: item.rawAliasInputOrdinal,
          rawSourceBeforeCommandIndex } : {}),
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
      const raw = job.bufferRaw.get(diagnosticKey(frameIndex, item.bufferOrdinal));
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
      const image = job.aspectImages.get(diagnosticKey(frameIndex, item.aspectOrdinal));
      const raw = job.aspectRaw.get(diagnosticKey(frameIndex, item.aspectOrdinal));
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
    const textureGroups = new Map();
    for (const item of detail.resourceTextures) {
      const image = job.resourceTextureImages.get(diagnosticKey(frameIndex, item.resourceOrdinal));
      const raw = job.resourceTextureRaw.get(diagnosticKey(frameIndex, item.resourceOrdinal));
      if (!raw || item.textureId === null) {
        throw new Error(`frame ${frameIndex} resource texture ${item.resourceOrdinal} has no complete raw readback`);
      }
      const texture = report.resources.textures.find(value => value.id === item.textureId);
      const width = texture?.width ?? texture?.descriptor?.size?.width;
      const height = texture?.height ?? texture?.descriptor?.size?.height;
      const layers = texture?.depthOrArrayLayers ?? texture?.descriptor?.size?.depthOrArrayLayers ?? 1;
      const samples = texture?.descriptor?.sampleCount ?? 1;
      const mipCount = texture?.descriptor?.mipLevelCount ?? 1;
      if (!texture || texture.format !== item.sourceFormat || texture.dimension !== '2d' ||
          layers !== 1 || samples !== item.sampleCount || samples !== 1 ||
          !Number.isInteger(width) || !Number.isInteger(height) ||
          !Number.isInteger(mipCount) || mipCount < 1 ||
          item.mipLevel >= mipCount || item.arrayLayer !== 0 ||
          item.width !== Math.max(1, Math.floor(width / 2 ** item.mipLevel)) ||
          item.height !== Math.max(1, Math.floor(height / 2 ** item.mipLevel)) ||
          (item.aspect === 'color' && item.rawFormat !== item.sourceFormat) ||
          (item.aspect === 'depth' && item.rawFormat !== 'r32float') ||
          (item.aspect === 'stencil' && item.rawFormat !== 'stencil8')) {
        throw new Error(`frame ${frameIndex} resource texture ${item.resourceOrdinal} differs from Inspector descriptor`);
      }
      let group = textureGroups.get(item.textureOrdinal);
      if (!group) {
        group = { texture, mipCount, subresources: new Set() };
        textureGroups.set(item.textureOrdinal, group);
      }
      if (group.texture.id !== texture.id || group.mipCount !== mipCount ||
          group.subresources.has(`${item.mipLevel}:${item.aspect}`)) {
        throw new Error(`frame ${frameIndex} resource texture subresource is duplicated or mismatched`);
      }
      group.subresources.add(`${item.mipLevel}:${item.aspect}`);
      resourceTextureSnapshots.push({ frameOrdinal: targetOrdinal,
        resourceOrdinal: item.resourceOrdinal, textureOrdinal: item.textureOrdinal,
        textureId: item.textureId, label: item.label, width: item.width, height: item.height,
        sourceFormat: item.sourceFormat, rawFormat: item.rawFormat,
        mipLevel: item.mipLevel, arrayLayer: item.arrayLayer, aspect: item.aspect,
        sampleCount: item.sampleCount, captureMoment: 'frame-end',
        ...(image ? { file: image.name, imageSha256: image.sha256 } :
          { imageReason: 'Resource PNG was not saved' }),
        rawFile: raw.name, rawBytesPerRow: raw.bytesPerRow,
        rawByteLength: raw.bytes, rawSha256: raw.sha256 });
    }
    for (const group of textureGroups.values()) {
      const format = group.texture.format ?? '';
      const aspects = format.startsWith('depth') ?
        (format.includes('stencil8') ? ['depth', 'stencil'] : ['depth']) :
        format.includes('stencil8') ? ['stencil'] : ['color'];
      for (let mip = 0; mip < group.mipCount; mip++) {
        for (const aspect of aspects) {
          if (!group.subresources.has(`${mip}:${aspect}`)) {
            throw new Error(`frame ${frameIndex} resource texture is missing mip ${mip} ${aspect}`);
          }
        }
      }
      if (group.subresources.size !== group.mipCount * aspects.length) {
        throw new Error(`frame ${frameIndex} resource texture has unexpected subresources`);
      }
    }
    if (new Set([...textureGroups.values()].map(group => group.texture.id)).size !==
        detail.resourceInventory.textureCount) {
      throw new Error(`frame ${frameIndex} resource textures reuse an Inspector ID`);
    }
    const resourceBufferIds = new Set();
    for (const item of detail.resourceBuffers) {
      const raw = job.resourceBufferRaw.get(diagnosticKey(frameIndex, item.resourceOrdinal));
      if (!raw || item.bufferId === null) {
        throw new Error(`frame ${frameIndex} resource Buffer ${item.resourceOrdinal} has no complete raw readback`);
      }
      const buffer = report.resources.buffers.find(value => value.id === item.bufferId);
      if (!buffer || buffer.size !== item.totalSize || raw.bytes !== item.totalSize ||
          item.copiedOffset !== 0 || item.copiedSize !== item.totalSize ||
          resourceBufferIds.has(item.bufferId)) {
        throw new Error(`frame ${frameIndex} resource Buffer ${item.resourceOrdinal} differs from Inspector descriptor`);
      }
      resourceBufferIds.add(item.bufferId);
      resourceBufferSnapshots.push({ frameOrdinal: targetOrdinal,
        resourceOrdinal: item.resourceOrdinal, bufferId: item.bufferId,
        label: item.label, totalSize: item.totalSize, copiedOffset: 0,
        copiedSize: item.totalSize, captureMoment: 'frame-end',
        rawFile: raw.name, rawByteLength: raw.bytes, rawSha256: raw.sha256 });
    }
    for (const item of selectedDetail?.gpuPasses ?? []) {
      const pass = gamePasses[item.ordinal];
      if (pass?.type !== item.kind || pass.label !== item.label) {
        throw new Error(`frame ${frameIndex} GPU timing pass does not match Inspector capture`);
      }
      gpuTimings.push({ frameOrdinal: pass.frameOrdinal, passIndex: pass.index,
        durationMs: item.durationMs, source: 'webgpu-timestamp-query' });
    }
    // Inspect the capture's actual attachments, including outputs omitted
    // entirely from RHI diagnostics. PNG previews are optional; verified raw
    // bytes are required for every stored output. A discarded attachment with
    // no resolve has undefined pass-end contents and is not a readable RT.
    for (const pass of renderPasses) {
      if (pass.diagnosticAuxiliary) continue;
      for (const target of pass.targets ?? []) {
        if (target.kind === 'color') {
          const hasResolve = Number.isInteger(target.resolveTextureId);
          if (!hasResolve && target.storeOp === 'discard') continue;
          if (hasResolve && target.storeOp === 'store' &&
              target.textureId !== target.resolveTextureId) {
            throw new Error(`frame ${frameIndex} pass ${pass.index} color ${target.slot} stores an MSAA source without its own raw readback`);
          }
          const snapshot = passSnapshots.find(item => item.frameOrdinal === targetOrdinal &&
            item.passIndex === pass.index && item.colorIndex === target.slot &&
            item.textureId === target.outputTextureId && item.rawFile);
          const texture = report.resources.textures.find(item => item.id === target.outputTextureId);
          if (!snapshot || !texture || texture.width !== snapshot.width ||
              texture.height !== snapshot.height || texture.format !== snapshot.format) {
            throw new Error(`frame ${frameIndex} pass ${pass.index} stored color ${target.slot} has no verified pass-end raw readback`);
          }
        } else if (target.kind === 'depth-stencil') {
          const format = target.format ?? report.resources.textures.find(item =>
            item.id === target.textureId)?.format;
          if (typeof format !== 'string') {
            throw new Error(`frame ${frameIndex} pass ${pass.index} depth/stencil format is unknown`);
          }
          for (const [aspect, stored] of [
            ['depth', format.startsWith('depth') && target.depthStoreOp !== 'discard'],
            ['stencil', format.includes('stencil8') && target.stencilStoreOp !== 'discard'],
          ]) {
            if (!stored) continue;
            const snapshot = aspectSnapshots.find(item => item.frameOrdinal === targetOrdinal &&
              item.passIndex === pass.index && item.aspect === aspect &&
              item.textureId === target.textureId && item.viewId === target.viewId &&
              item.afterCommandIndex === pass.endCommand && item.rawFile);
            if (!snapshot) {
              throw new Error(`frame ${frameIndex} pass ${pass.index} stored ${aspect} has no verified pass-end raw readback`);
            }
          }
        }
      }
    }
    // Frame-end resource pixels cannot stand in for the earlier input or
    // bound Buffer bytes at a Draw. Keep those capture moments distinct.
    for (const item of detail.inputs) {
      if (!inputSnapshots.some(snapshot => snapshot.frameOrdinal === targetOrdinal &&
          snapshot.inputOrdinal === item.inputOrdinal && snapshot.rawFile &&
          Number.isInteger(snapshot.beforeCommandIndex))) {
        throw new Error(`frame ${frameIndex} Draw input ${item.inputOrdinal} has no verified pre-Draw raw readback`);
      }
    }
    for (const item of detail.buffers) {
      if (!bufferSnapshots.some(snapshot => snapshot.frameOrdinal === targetOrdinal &&
          snapshot.bufferOrdinal === item.bufferOrdinal && snapshot.rawFile &&
          Number.isInteger(snapshot.beforeCommandIndex))) {
        throw new Error(`frame ${frameIndex} Draw Buffer ${item.bufferOrdinal} has no verified pre-Draw raw readback`);
      }
    }
    }
    const selectedFrame = diagnosticFrames[job.detailedFrameIndex - 1] ?? null;
    const sidecars = { schemaVersion: 1,
      actualFrames, detailedFrameIndex: job.detailedFrameIndex,
      diagnosticFrameOrdinal: selectedFrame?.frameOrdinal ?? null,
      diagnosticFrames,
      frames: [...job.frameImages].sort(([a], [b]) => a - b).filter(([index]) => index <= actualFrames)
        .map(([index, image]) => {
          const frame = frameMappingComplete ? captureFrames[index - 1] : null;
          return frame ? { frameIndex: index, frameOrdinal: frame.frameOrdinal,
            file: image.name, sha256: image.sha256,
            width: image.width, height: image.height } : null;
        }).filter(Boolean),
      passSnapshots, passUnavailable, inputSnapshots, aspectSnapshots, bufferSnapshots,
      resourceTextureSnapshots, resourceBufferSnapshots, gpuTimings,
      gpuProfilerStatus: selectedFrame?.gpuProfilerStatus ?? null,
      passCaptureWarning: selectedFrame?.passCaptureWarning ?? null };
    const manifestText = JSON.stringify(sidecars, null, 2) + '\n';
    if (Buffer.byteLength(manifestText) > MAX_SIDECAR_MANIFEST_BYTES) {
      throw new Error('sidecar manifest exceeds 64 MiB limit');
    }
    await writeFile(join(job.outputDir, 'sidecars.json'), manifestText, { flag: 'wx' });
    return { frameIndex: job.detailedFrameIndex,
      resourceFrames: diagnosticFrames.map(item => item.frameIndex),
      selectedFrameUnavailable: null,
      passSnapshots: passSnapshots.length,
      rawPassSnapshots: passSnapshots.filter(item => item.rawFile).length,
      inputSnapshots: inputSnapshots.filter(item => item.file || item.rawFile).length,
      inputUnavailable: inputSnapshots.filter(item => item.reason).length,
      aspectSnapshots: aspectSnapshots.filter(item => item.file || item.rawFile).length,
      aspectUnavailable: aspectSnapshots.filter(item => item.reason).length,
      bufferSnapshots: bufferSnapshots.filter(item => item.rawFile).length,
      bufferUnavailable: bufferSnapshots.filter(item => item.reason).length,
      resourceTextureSnapshots: resourceTextureSnapshots.length,
      resourceBufferSnapshots: resourceBufferSnapshots.length,
      passUnavailable: passUnavailable.length, gpuTimedPasses: gpuTimings.length };
  }

  async function upload({ jobId, targetBootId, stream, actualFrames, contentLength } = {}) {
    if (closed) throw new Error('capture controller is closed');
    const job = getJob(jobId, targetBootId);
    if (!['pending', 'capturing'].includes(job.state) || job.uploadInProgress) throw new Error('capture job is not accepting an upload');
    const count = Number(actualFrames);
    if (!Number.isInteger(count) || count < 1 || count > job.frames) throw new Error('actualFrames must be between 1 and requested frames');
    for (let frameIndex = 1; frameIndex <= count; frameIndex++) {
      if (!job.diagnostics.has(frameIndex)) {
        throw new Error(`frame ${frameIndex} diagnostics must be uploaded before capture completion`);
      }
    }
    if (job.diagnostics.size !== count || job.reservedSidecarBytes !== 0 ||
        job.frameImageInProgress.size || job.passRawInProgress.size ||
        job.inputRawInProgress.size || job.aspectRawInProgress.size ||
        job.bufferRawInProgress.size || job.resourceTextureRawInProgress.size ||
        job.resourceBufferRawInProgress.size) {
      throw new Error('capture diagnostic uploads are incomplete or outside actualFrames');
    }
    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') throw new Error('binary upload stream is required');
    if (contentLength != null && (!Number.isInteger(Number(contentLength)) ||
        Number(contentLength) < 0 || Number(contentLength) > MAX_CAPTURE_BYTES)) {
      throw new Error('capture exceeds 1 GiB upload limit');
    }
    job.uploadInProgress = true;
    job.state = 'uploading';
    job.updatedAt = Date.now();
    let handle;
    let bytes = 0;
    let validatedCapture = false;
    const sha = createHash('sha256');
    try {
      handle = await open(job.file, 'wx');
      for await (const part of stream) {
        if (job.state !== 'uploading' || closed) throw new Error('capture stopped or timed out');
        const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
        bytes += chunk.length;
        if (bytes > MAX_CAPTURE_BYTES) throw new Error('capture exceeds 1 GiB upload limit');
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
      validatedCapture = true;
      if (job.state !== 'uploading' || closed) throw new Error('capture stopped or timed out');
      const digest = sha.digest('hex');
      const diagnosticsSummary = await writeSidecars(job, count);
      job.bytes = bytes;
      job.sha256 = digest;
      // Completion means the copied, hashed raw files are also usable in the
      // report. Analysis must succeed before a new full-frame job is complete.
      const verifiedAnalysis = await analyzedWithIndex(job, true);
      if (job.state !== 'uploading' || closed) throw new Error('capture stopped or timed out during analysis');
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
        resourceFrames: diagnosticsSummary.resourceFrames,
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
      await writeManifest(join(job.outputDir, 'manifest.json'),
        JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
      if (job.state !== 'uploading' || closed) {
        throw new Error('capture stopped or timed out during manifest write');
      }
      job.actualFrames = count;
      job.resourceFrames = diagnosticsSummary.resourceFrames;
      job.analysisPromise = Promise.resolve(verifiedAnalysis);
      job.state = 'completed';
      job.updatedAt = Date.now();
      if (activeJobId === job.id) activeJobId = null;
      capHistory();
      return publicJob(job);
    } catch (error) {
      job.analysisPromise = null;
      try { await handle?.close(); } catch { /* Keep the first failure. */ }
      // A stop can arrive while the final write is pending. Never leave a
      // completed-looking manifest for a job that did not commit completion.
      try { await unlink(join(job.outputDir, 'manifest.json')); }
      catch (cleanupError) { if (cleanupError?.code !== 'ENOENT') {
        error = new Error(`${text(error)}; incomplete manifest cleanup failed: ${text(cleanupError)}`);
      } }
      if (validatedCapture) {
        // Keep valid native evidence and the exact diagnostics for failed jobs.
        // There is no manifest.json, so history will never present this as complete.
        try {
          await writeFile(join(job.outputDir, 'diagnostics.json'), JSON.stringify({
            schemaVersion: 1, jobId: job.id, state: job.state === 'stopped' ? 'stopped' : 'failed',
            error: text(error), requestedFrames: job.frames, actualFrames: count,
            captureFile: job.file, bytes,
            diagnostics: [...job.diagnostics].sort(([a], [b]) => a - b)
              .map(([, detail]) => detail),
          }, null, 2) + '\n', { flag: 'wx' });
        } catch { /* Preserve the original capture error. */ }
      } else {
        try { await unlink(job.file); } catch { /* File may not have been created. */ }
      }
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

  return { register, list, getSettings, setSettings, request, poll, status, viewerFile, uploadFrameImage, uploadPassImage,
    uploadPassRaw, uploadInputImage, uploadInputRaw,
    uploadAspectImage, uploadAspectRaw, uploadBufferRaw,
    uploadResourceTextureImage, uploadResourceTextureRaw, uploadResourceBufferRaw, history,
    diagnostics, upload, fail, stop, close };
}
