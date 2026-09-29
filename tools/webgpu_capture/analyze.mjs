// Read WebGPU Inspector's WGPUCAP v1 container without loading raw GPU bytes into memory.
// The report and optional exports are written beside captures, outside Git worktrees.
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { copyFile, mkdir, open, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { buildCaptureDetails } from './analysis_report.mjs';
import { exportTextureImages } from './analysis_png.mjs';
import { attachFrameSidecars } from './analysis_sidecars.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAX_CAPTURE_BYTES = 512 * 1024 * 1024;
const MAX_METADATA_BYTES = 64 * 1024 * 1024;
const MAX_EXPORT_FILES = 256;
const MAX_BUFFER_PREVIEW_BYTES = 1024;
const MAX_AUTO_BUFFER_FILES = 1024;
const MAX_AUTO_BUFFER_BYTES = 256 * 1024 * 1024;
const DRAW = new Set(['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect']);
const DISPATCH = new Set(['dispatchWorkgroups', 'dispatchWorkgroupsIndirect']);
const COPY = new Set(['copyBufferToBuffer', 'copyBufferToTexture', 'copyTextureToBuffer', 'copyTextureToTexture']);

async function readExactly(handle, bytes, position) {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.read(bytes, offset, bytes.length - offset, position + offset);
    if (!result.bytesRead) throw new Error('WGPUCAP file is truncated');
    offset += result.bytesRead;
  }
}

export async function readCapture(path) {
  const captureFile = resolve(path);
  if (extname(captureFile).toLowerCase() !== '.wgpuc') throw new Error('capture must be a .wgpuc file');
  const handle = await open(captureFile, 'r');
  try {
    const { size } = await handle.stat();
    if (!Number.isSafeInteger(size) || size < 16 || size > MAX_CAPTURE_BYTES) {
      throw new Error('capture file must be between 16 bytes and 512 MiB');
    }
    const head = Buffer.alloc(Math.min(size, 64));
    await readExactly(handle, head, 0);
    const newline = head.indexOf(10);
    if (newline < 0) throw new Error('WGPUCAP header is missing or too long');
    const header = /^WGPUCAP 1 ([1-9][0-9]*)$/.exec(head.subarray(0, newline).toString('ascii'));
    if (!header) throw new Error('unsupported or invalid WGPUCAP header');
    const metadataBytes = Number(header[1]);
    if (!Number.isSafeInteger(metadataBytes) || metadataBytes > MAX_METADATA_BYTES) {
      throw new Error('WGPUCAP metadata exceeds 64 MiB');
    }
    const metadataStart = newline + 1;
    const metadataEnd = metadataStart + metadataBytes;
    if (metadataEnd > size) throw new Error('WGPUCAP metadata is truncated');
    const rawMetadata = Buffer.alloc(metadataBytes);
    await readExactly(handle, rawMetadata, metadataStart);
    let metadata;
    try { metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawMetadata)); }
    catch { throw new Error('WGPUCAP metadata is not valid UTF-8 JSON'); }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) ||
        !Array.isArray(metadata.commands) || !metadata.commands.length ||
        !metadata.objects || typeof metadata.objects !== 'object' ||
        !Array.isArray(metadata.payloadTable)) {
      throw new Error('WGPUCAP metadata is missing commands, objects, or payload table');
    }
    const binaryStart = Math.ceil(metadataEnd / 8) * 8;
    if (binaryStart > size) throw new Error('WGPUCAP binary section is truncated');
    const binaryBytes = size - binaryStart;
    const payloads = metadata.payloadTable.map((entry, id) => {
      if (entry == null) return null;
      if (!Array.isArray(entry) || entry.length !== 2 ||
          !Number.isSafeInteger(entry[0]) || !Number.isSafeInteger(entry[1]) ||
          entry[0] < 0 || entry[1] < 0 || entry[0] % 8 !== 0 ||
          entry[0] > binaryBytes || entry[1] > binaryBytes - entry[0]) {
        throw new Error(`WGPUCAP payload ${id} is invalid or truncated`);
      }
      return { id, offset: binaryStart + entry[0], bytes: entry[1] };
    });
    return { captureFile, size, metadata, payloads };
  } finally {
    await handle.close();
  }
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function countBy(values, key) {
  const counts = Object.create(null);
  for (const value of values) {
    const name = value && typeof value[key] === 'string' ? value[key] : '(unknown)';
    counts[name] = (counts[name] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function indexPayloads(payloads, details) {
  const uses = new Map(payloads.filter(Boolean).map(({ id, bytes }) => [id, {
    id, bytes, textureIds: new Set(), bufferIds: new Set(),
    sourceCommandIndexes: new Set(), drawCommandIndexes: new Set(),
  }]));
  for (const texture of details.resources.textures) {
    for (const mip of texture.mipLevels) uses.get(mip.payloadId)?.textureIds.add(texture.id);
  }
  for (const event of details.events) {
    for (const binding of event.bufferPayloads ?? []) {
      const use = uses.get(binding.payloadId);
      if (!use) continue;
      if (binding.bufferId !== null) use.bufferIds.add(binding.bufferId);
      use.sourceCommandIndexes.add(binding.sourceCommandIndex);
      if (DRAW.has(event.method) || DISPATCH.has(event.method)) {
        use.drawCommandIndexes.add(event.commandIndex);
      }
    }
  }
  return [...uses.values()].map(use => ({
    id: use.id, bytes: use.bytes,
    textureIds: [...use.textureIds], bufferIds: [...use.bufferIds],
    sourceCommandIndexes: [...use.sourceCommandIndexes],
    drawCommandIndexes: [...use.drawCommandIndexes],
    unattributed: !use.textureIds.size && !use.bufferIds.size && !use.sourceCommandIndexes.size,
  }));
}

function summarizePasses(commands) {
  const passes = [];
  let current = null;
  for (let index = 0; index < commands.length; index++) {
    const cmd = commands[index];
    const method = cmd?.method;
    if (method === 'beginRenderPass' || method === 'beginComputePass') {
      current = {
        index: passes.length, type: method === 'beginRenderPass' ? 'render' : 'compute',
        label: typeof cmd.args?.[0]?.label === 'string' ? cmd.args[0].label : '',
        beginCommand: index, endCommand: null,
        draws: 0, dispatches: 0, pipelineBinds: 0, bindGroupBinds: 0,
      };
      if (typeof cmd.duration === 'number' && Number.isFinite(cmd.duration)) {
        current.inspectorDurationMs = cmd.duration;
      }
      passes.push(current);
    } else if (current && method === 'end') {
      current.endCommand = index;
      current = null;
    } else if (current) {
      if (DRAW.has(method)) current.draws++;
      else if (DISPATCH.has(method)) current.dispatches++;
      else if (method === 'setPipeline') current.pipelineBinds++;
      else if (method === 'setBindGroup') current.bindGroupBinds++;
    }
  }
  return passes;
}

export function summarizeCapture(capture) {
  const { metadata, payloads, captureFile, size } = capture;
  const objects = Array.isArray(metadata.objects) ? metadata.objects : Object.values(metadata.objects);
  const methodCounts = countBy(metadata.commands, 'method');
  const objectCounts = countBy(objects, 'type');
  const validErrors = Array.isArray(metadata.validationErrors) ? metadata.validationErrors : [];
  const passes = summarizePasses(metadata.commands);
  const details = buildCaptureDetails(metadata, passes);
  const payloadIndex = indexPayloads(payloads, details);
  const stats = {
    drawCalls: [...DRAW].reduce((n, method) => n + (methodCounts[method] || 0), 0),
    dispatches: [...DISPATCH].reduce((n, method) => n + (methodCounts[method] || 0), 0),
    renderPasses: methodCounts.beginRenderPass || 0,
    computePasses: methodCounts.beginComputePass || 0,
    copyCommands: [...COPY].reduce((n, method) => n + (methodCounts[method] || 0), 0),
    pipelineCreatesInCapture: (methodCounts.createRenderPipeline || 0) +
      (methodCounts.createComputePipeline || 0) +
      (methodCounts.createRenderPipelineAsync || 0) +
      (methodCounts.createComputePipelineAsync || 0),
    shaderCreatesInCapture: methodCounts.createShaderModule || 0,
  };
  const report = {
    schemaVersion: 3,
    captureKind: 'webgpu-inspector', format: 'wgpuc',
    captureFile, bytes: size,
    inspector: {
      schemaVersion: metadata.schemaVersion ?? null,
      tool: metadata.tool ?? null, toolVersion: metadata.toolVersion ?? null,
      exportedAt: metadata.exportedAt ?? null,
    },
    commandCount: metadata.commands.length, objectCount: objects.length,
    payloadCount: payloads.filter(Boolean).length,
    payloadBytes: payloads.reduce((total, payload) => total + (payload?.bytes || 0), 0),
    stats, methodCounts, objectCounts, passes,
    events: details.events, frames: details.frames, resources: details.resources,
    frameTextureId: details.frameTextureId,
    frameBoundaryNote: 'Frame ordinals infer one frame per queue.submit; this is not an Inspector-native frame boundary.',
    imageNote: 'Texture PNGs are capture texture-state snapshots, not outputs after individual draws. Per-frame sidecar images, when present, come from game canvas readback.',
    bufferPayloadNote: 'Draw bufferPayloads are Inspector bytes recorded when each buffer or bind group was bound. They are not post-draw GPU readback. Automatically exported payloads have complete .bin files and up to 1024 preview bytes; bufferExportSummary and each omitted payload state any export limit.',
    gpuTiming: null,
    validationErrorCount: validErrors.length,
    validationErrors: validErrors.slice(0, 30).map(value => ({
      message: String(value?.message ?? value).slice(0, 2000),
    })),
    payloads: payloadIndex,
    unattributedPayloadIds: payloadIndex.filter(payload => payload.unattributed).map(payload => payload.id),
  };
  return report;
}

function within(parent, child) {
  const p = process.platform === 'win32' ? parent.toLowerCase() : parent;
  const c = process.platform === 'win32' ? child.toLowerCase() : child;
  const rel = relative(p, c);
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

async function outsideWorktrees(path) {
  const candidate = await futureRealpath(path);
  const roots = [PROJECT_ROOT];
  try {
    const list = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 3000, windowsHide: true,
    });
    for (const line of list.split(/\r?\n/)) if (line.startsWith('worktree ')) roots.push(line.slice(9));
  } catch { /* PROJECT_ROOT still remains protected. */ }
  for (const root of roots) {
    if (within(await futureRealpath(root), candidate)) {
      throw new Error('analysis output must be outside every project worktree');
    }
  }
  return candidate;
}

function selectedPayloads(payloads, requested) {
  if (requested === undefined) return [];
  const ids = requested === 'all' ? payloads.filter(Boolean).map(item => item.id) : requested;
  if (!Array.isArray(ids) || ids.length > MAX_EXPORT_FILES) {
    throw new Error(`at most ${MAX_EXPORT_FILES} payloads can be exported at once`);
  }
  return [...new Set(ids)].map(id => {
    if (!Number.isSafeInteger(id) || id < 0 || !payloads[id]) throw new Error(`payload ${id} does not exist`);
    return payloads[id];
  });
}

async function exportBufferPayloads(capture, outputDir, report) {
  const used = report.payloads.filter(item => item.bufferIds.length || item.sourceCommandIndexes.length);
  const summary = { considered: used.length, exported: 0, bytes: 0, omitted: 0,
    maxFiles: MAX_AUTO_BUFFER_FILES, maxBytes: MAX_AUTO_BUFFER_BYTES };
  report.bufferExportSummary = summary;
  if (!used.length) return [];
  const directory = join(outputDir, 'buffers');
  await mkdir(directory);
  const exports = [];
  const handle = await open(capture.captureFile, 'r');
  try {
    for (const item of used) {
      const payload = capture.payloads[item.id];
      if (!payload) continue;
      const reason = summary.exported >= MAX_AUTO_BUFFER_FILES ?
        `自动导出达到 ${MAX_AUTO_BUFFER_FILES} 个文件上限；可用 CLI 按 ID 导出` :
        payload.bytes > MAX_AUTO_BUFFER_BYTES - summary.bytes ?
          '自动导出达到 256 MiB 总字节上限；可用 CLI 按 ID 导出' : null;
      if (reason) {
        item.bufferExportReason = reason;
        summary.omitted++;
        continue;
      }
      const name = `${String(item.id).padStart(6, '0')}.bin`;
      const file = join(directory, name);
      if (payload.bytes) {
        await pipeline(
          createReadStream(capture.captureFile, { start: payload.offset, end: payload.offset + payload.bytes - 1 }),
          createWriteStream(file, { flags: 'wx' }),
        );
      } else {
        await writeFile(file, Buffer.alloc(0), { flag: 'wx' });
      }
      item.bufferFile = `buffers/${name}`;
      const preview = Buffer.alloc(Math.min(payload.bytes, MAX_BUFFER_PREVIEW_BYTES));
      if (preview.length) await readExactly(handle, preview, payload.offset);
      item.previewBase64 = preview.toString('base64');
      item.previewBytes = preview.length;
      exports.push(file);
      summary.exported++;
      summary.bytes += payload.bytes;
    }
  } finally {
    await handle.close();
  }
  return exports;
}

export async function analyzeCapture(path, options = {}) {
  const capture = await readCapture(path);
  const report = summarizeCapture(capture);
  report.sha256 = await sha256File(capture.captureFile);
  const selected = selectedPayloads(capture.payloads, options.payloads);
  const defaultParent = dirname(capture.captureFile);
  const fallbackParent = join(process.env.LOCALAPPDATA || join(homedir(), '.local', 'share'), 'GameDraft', 'webgpu-captures');
  const parent = options.output ? dirname(resolve(options.output)) :
    (await outsideWorktrees(defaultParent).then(() => defaultParent, () => fallbackParent));
  const proposed = options.output ? resolve(options.output) :
    join(parent, `analysis-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`);
  const outputDir = await outsideWorktrees(proposed);
  await mkdir(dirname(outputDir), { recursive: true });
  await mkdir(outputDir);
  // Check the realized directory too; a junction in an existing parent cannot move output into Git.
  await outsideWorktrees(await realpath(outputDir));
  const exports = [];
  exports.push(...await exportBufferPayloads(capture, outputDir, report));
  if (options.exportMetadata) {
    const metadataFile = join(outputDir, 'metadata.json');
    await writeFile(metadataFile, JSON.stringify(capture.metadata) + '\n', { flag: 'wx' });
    exports.push(metadataFile);
  }
  for (const payload of selected) {
    const payloadFile = join(outputDir, `payload-${String(payload.id).padStart(6, '0')}.bin`);
    if (payload.bytes) {
      await pipeline(
        createReadStream(capture.captureFile, { start: payload.offset, end: payload.offset + payload.bytes - 1 }),
        createWriteStream(payloadFile, { flags: 'wx' }),
      );
    } else {
      await writeFile(payloadFile, Buffer.alloc(0), { flag: 'wx' });
    }
    exports.push(payloadFile);
  }
  const shaders = report.resources.shaders.filter(shader => typeof shader.code === 'string');
  if (shaders.length) {
    const shaderDir = join(outputDir, 'shaders');
    await mkdir(shaderDir);
    for (const [index, shader] of shaders.entries()) {
      const fileName = `${String(index).padStart(3, '0')}.wgsl`;
      const shaderFile = join(shaderDir, fileName);
      await writeFile(shaderFile, shader.code, { flag: 'wx' });
      shader.codeFile = `shaders/${fileName}`;
      exports.push(shaderFile);
    }
  }
  const images = await exportTextureImages(capture, outputDir, report.resources.textures, report.frames);
  const sidecars = await attachFrameSidecars(capture.captureFile, outputDir, report.frames, report.passes);
  report.frameImage = sidecars.frameImage ?? images.frameImage;
  report.imageExportSummary = { ...images.summary, sidecarFrames: sidecars.attached };
  report.sidecarErrors = sidecars.errors;
  report.sidecarManifest = sidecars.manifest;
  report.passSnapshots = sidecars.passSnapshots;
  report.imageNote = sidecars.passSnapshots.some(snapshot => snapshot.captureMoment === 'post-draw') ?
    'Verified frame-debug one-Draw physical Pass readbacks show the output after that Draw. Other Pass readbacks show only Pass-end state; Inspector texture mip images show capture-final state.' :
    'Texture PNGs are capture-final texture-state snapshots. Pass sidecars show Pass-end state, not output after individual Draws. Per-frame sidecars come from game canvas readback.';
  report.passUnavailable = sidecars.passUnavailable;
  report.gpuProfilerStatus = sidecars.gpuProfilerStatus;
  report.passCaptureWarning = sidecars.passCaptureWarning;
  report.gpuTiming = sidecars.gpuTiming;
  exports.push(...images.exports, ...sidecars.exports);

  const viewerSourceDir = dirname(fileURLToPath(import.meta.url));
  const viewerHtml = join(viewerSourceDir, 'viewer.html');
  const viewerJs = join(viewerSourceDir, 'viewer.js');
  const viewerSurfaceJs = join(viewerSourceDir, 'viewer_surface.js');
  const viewerSurfaceCss = join(viewerSourceDir, 'viewer_surface.css');
  let viewerFile = null;
  if (existsSync(viewerHtml) && existsSync(viewerJs)) {
    viewerFile = join(outputDir, 'viewer.html');
    await copyFile(viewerHtml, viewerFile);
    await copyFile(viewerJs, join(outputDir, 'viewer.js'));
    report.viewerFile = 'viewer.html';
    exports.push(viewerFile, join(outputDir, 'viewer.js'));
    for (const [source, name] of [[viewerSurfaceJs, 'viewer_surface.js'], [viewerSurfaceCss, 'viewer_surface.css']]) {
      if (existsSync(source)) {
        await copyFile(source, join(outputDir, name));
        exports.push(join(outputDir, name));
      }
    }
  } else {
    report.viewerFile = null;
  }
  const viewerDataFile = join(outputDir, 'viewer-data.js');
  exports.push(viewerDataFile);
  report.exports = [...new Set(exports)];
  const reportFile = join(outputDir, 'report.json');
  await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  const safeJson = JSON.stringify(report).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  await writeFile(viewerDataFile, `window.__GAMEDRAFT_CAPTURE_REPORT__ = ${safeJson};\n`, { flag: 'wx' });
  return {
    outputDir, reportFile, report, exports: report.exports,
    frameImage: report.frameImage ? join(outputDir, report.frameImage) : null,
    viewerFile, eventCount: report.events.length,
    imageCount: images.summary.exported + sidecars.attached,
  };
}
