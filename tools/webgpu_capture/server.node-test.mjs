import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdtemp, realpath, rm, writeFile, mkdir, link, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { createWebGpuCaptureController } from './server.mjs';
import { attachFrameSidecars, verifiedInputBinding } from './analysis_sidecars.mjs';
import { analyzeCapture, summarizeCapture } from './analyze.mjs';

function sampleCapture(frames = 1) {
  const commands = Array.from({ length: frames }, () => [
    { method: 'beginRenderPass', args: [{ label: 'sample pass', colorAttachments: [] }] },
    { method: 'draw', args: [3] }, { method: 'end' }, { method: 'submit' },
  ]).flat();
  const metadata = Buffer.from(JSON.stringify({
    schemaVersion: 1, objects: [], commands, payloadTable: [[0, 3]],
  }));
  const header = Buffer.from(`WGPUCAP 1 ${metadata.length}\n`);
  const padding = Buffer.alloc((8 - ((header.length + metadata.length) % 8)) % 8, 10);
  return Buffer.concat([header, metadata, padding, Buffer.from([1, 2, 3]), Buffer.alloc(5)]);
}

function uploadEmptyDiagnostics(broker, job, targetBootId, actualFrames) {
  for (let frameIndex = 1; frameIndex <= actualFrames; frameIndex++) {
    postDiagnostics(broker, { jobId: job.id, targetBootId, frameIndex,
      passes: [], gpuPasses: [], gpuProfilerStatus: { state: 'disabled' } });
  }
}

function postDiagnostics(broker, args) {
  return broker.diagnostics({ resourceInventory: { textureCount: 0,
    textureSubresourceCount: 0, bufferCount: 0 }, resourceTextures: [],
  resourceBuffers: [], ...args });
}

test('stores a checked capture outside the worktree for its exact game bootId', async () => {
  const external = await mkdtemp(join(tmpdir(), 'gamedraft-webgpu-capture-'));
  const oldOutput = process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR;
  process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR = external;
  const broker = createWebGpuCaptureController(resolve('.'));
  let cancelBroker;
  try {
    broker.register({ targetBootId: 'game-a', url: 'http://127.0.0.1:5216/', captureReady: true });
    assert.equal(broker.list()[0].targetBootId, 'game-a');
    const pending = await broker.request({ frames: 2 });
    assert.equal(pending.state, 'pending');
    await assert.rejects(broker.request({ targetBootId: 'game-a' }), /already active/);
    assert.equal(broker.poll({ targetBootId: 'game-b' }), null);
    assert.equal(broker.poll({ targetBootId: 'game-a' }).state, 'capturing');
    const capture = sampleCapture(2);
    await assert.rejects(broker.upload({
      jobId: pending.id, targetBootId: 'game-b', stream: Readable.from([capture]), actualFrames: 2,
    }), /not found/);
    uploadEmptyDiagnostics(broker, pending, 'game-a', 2);
    const completed = await broker.upload({
      jobId: pending.id, targetBootId: 'game-a', stream: Readable.from([capture]),
      actualFrames: 2, contentLength: capture.length,
    });
    assert.equal(completed.state, 'completed');
    assert.equal(completed.actualFrames, 2);
    assert.ok(completed.captureFile.toLowerCase().startsWith((await realpath(external)).toLowerCase()));
    assert.deepEqual(await readFile(completed.captureFile), capture);
    assert.equal(completed.sha256, createHash('sha256').update(capture).digest('hex'));
    const manifest = JSON.parse(await readFile(join(completed.outputDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.commandCount, 8);
    assert.equal(manifest.payloadCount, 1);

    let cancelJobId;
    cancelBroker = createWebGpuCaptureController(resolve('.'), {
      writeManifest: async (...args) => {
        await writeFile(...args);
        assert.equal(cancelBroker.stop({ jobId: cancelJobId,
          targetBootId: 'game-cancel' }).state, 'stopped');
      },
    });
    cancelBroker.register({ targetBootId: 'game-cancel', captureReady: true });
    const cancelJob = await cancelBroker.request({ targetBootId: 'game-cancel', frames: 1 });
    cancelJobId = cancelJob.id;
    uploadEmptyDiagnostics(cancelBroker, cancelJob, 'game-cancel', 1);
    const cancelCapture = sampleCapture();
    await assert.rejects(cancelBroker.upload({ jobId: cancelJobId,
      targetBootId: 'game-cancel', actualFrames: 1,
      contentLength: cancelCapture.length, stream: Readable.from([cancelCapture]) }),
    /stopped or timed out during manifest write/);
    assert.equal(cancelBroker.status({ jobId: cancelJobId,
      targetBootId: 'game-cancel' }).state, 'stopped');
    const cancelDir = join(external, cancelJob.createdAt.slice(0, 10), cancelJobId);
    await assert.rejects(readFile(join(cancelDir, 'manifest.json')), /ENOENT/);
    assert.equal(JSON.parse(await readFile(join(cancelDir, 'diagnostics.json'), 'utf8')).state,
      'stopped');
    assert.ok(!(await cancelBroker.history({ limit: 10 })).some(item => item.id === cancelJobId));
  } finally {
    broker.close();
    cancelBroker?.close();
    if (oldOutput === undefined) delete process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR;
    else process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR = oldOutput;
    await rm(external, { recursive: true, force: true });
  }
});

test('reopens a completed capture after broker restart and reuses its verified analysis', async () => {
  const external = await mkdtemp(join(tmpdir(), 'gamedraft-webgpu-history-'));
  const oldOutput = process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR;
  process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR = external;
  const first = createWebGpuCaptureController(resolve('.'));
  let second;
  try {
    first.register({ targetBootId: 'history-game', captureReady: true });
    const pending = await first.request({ frames: 1 });
    const capture = sampleCapture();
    uploadEmptyDiagnostics(first, pending, 'history-game', 1);
    const completed = await first.upload({ jobId: pending.id, targetBootId: 'history-game',
      actualFrames: 1, contentLength: capture.length, stream: Readable.from([capture]) });
    const initialReport = await first.viewerFile({ jobId: pending.id, file: 'report.json' });
    const initialAnalysisDir = resolve(initialReport, '..');
    first.close();
    second = createWebGpuCaptureController(resolve('.'));
    const listed = await second.history({ limit: 10 });
    assert.equal(listed.length, 1);
    assert.deepEqual(listed[0].id, pending.id);
    assert.equal(listed[0].actualFrames, 1);
    assert.equal(listed[0].detailedFrameIndex, 1);
    assert.equal(listed[0].bytes, capture.length);
    assert.equal(listed[0].captureFile, completed.captureFile);
    const reopened = await second.viewerFile({ jobId: pending.id, file: 'report.json' });
    assert.equal(resolve(reopened, '..'), initialAnalysisDir);
    assert.equal(resolve(await second.viewerFile({ jobId: pending.id, file: 'viewer.html' }), '..'),
      initialAnalysisDir);
    await assert.rejects(second.viewerFile({ jobId: pending.id, file: '../manifest.json' }),
      /not available|invalid path/);
    const analyses = (await readdir(completed.outputDir)).filter(name => name.startsWith('analysis-'));
    assert.equal(analyses.length, 1);
    const manifestFile = join(completed.outputDir, 'manifest.json');
    const tampered = JSON.parse(await readFile(manifestFile, 'utf8'));
    tampered.sha256 = '0'.repeat(64);
    await writeFile(manifestFile, JSON.stringify(tampered));
    assert.deepEqual(await second.history({ limit: 10 }), []);
    await assert.rejects(second.viewerFile({ jobId: pending.id }), /not found/);
  } finally {
    first.close();
    second?.close();
    if (oldOutput === undefined) delete process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR;
    else process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR = oldOutput;
    await rm(external, { recursive: true, force: true });
  }
});

test('history skips forged manifests, changed capture hashes and paths outside the fixed job directory', async () => {
  const external = await mkdtemp(join(tmpdir(), 'gamedraft-webgpu-history-reject-'));
  const oldOutput = process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR;
  process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR = external;
  const creator = createWebGpuCaptureController(resolve('.'));
  let reader;
  try {
    creator.register({ targetBootId: 'history-reject', captureReady: true });
    const saved = [];
    for (let index = 0; index < 3; index++) {
      const pending = await creator.request({ frames: 2 });
      uploadEmptyDiagnostics(creator, pending, 'history-reject', 1);
      saved.push(await creator.upload({ jobId: pending.id, targetBootId: 'history-reject',
        actualFrames: 1, contentLength: sampleCapture().length,
        stream: Readable.from([sampleCapture()]) }));
    }
    creator.close();
    const forged = join(saved[0].outputDir, 'manifest.json');
    const forgedDoc = JSON.parse(await readFile(forged, 'utf8'));
    forgedDoc.jobId = 'f'.repeat(32);
    await writeFile(forged, JSON.stringify(forgedDoc));
    const wrongPath = join(saved[1].outputDir, 'manifest.json');
    const wrongDoc = JSON.parse(await readFile(wrongPath, 'utf8'));
    wrongDoc.captureFile = join(external, 'capture.wgpuc');
    await writeFile(wrongPath, JSON.stringify(wrongDoc));
    await writeFile(saved[2].captureFile, Buffer.from('tampered capture'));
    reader = createWebGpuCaptureController(resolve('.'));
    assert.deepEqual(await reader.history({ limit: 10 }), []);
    for (const job of saved) {
      await assert.rejects(reader.viewerFile({ jobId: job.id }), /not found/);
    }
    await assert.rejects(reader.viewerFile({ jobId: '../' }), /invalid capture job id/);
  } finally {
    creator.close();
    reader?.close();
    if (oldOutput === undefined) delete process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR;
    else process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR = oldOutput;
    await rm(external, { recursive: true, force: true });
  }
});

test('history limits recent entries and accepts a legacy manifest without detailedFrameIndex', async () => {
  const external = await mkdtemp(join(tmpdir(), 'gamedraft-webgpu-legacy-history-'));
  const oldOutput = process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR;
  process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR = external;
  const creator = createWebGpuCaptureController(resolve('.'));
  let reader;
  try {
    creator.register({ targetBootId: 'legacy-history', captureReady: true });
    const saved = [];
    for (let index = 0; index < 2; index++) {
      const pending = await creator.request({ frames: 1 });
      uploadEmptyDiagnostics(creator, pending, 'legacy-history', 1);
      saved.push(await creator.upload({ jobId: pending.id, targetBootId: 'legacy-history',
        actualFrames: 1, contentLength: sampleCapture().length,
        stream: Readable.from([sampleCapture()]) }));
    }
    creator.close();
    const manifestFile = join(saved[0].outputDir, 'manifest.json');
    const legacy = JSON.parse(await readFile(manifestFile, 'utf8'));
    delete legacy.detailedFrameIndex;
    delete legacy.createdAt;
    await writeFile(manifestFile, JSON.stringify(legacy));
    reader = createWebGpuCaptureController(resolve('.'));
    const all = await reader.history({ limit: 2 });
    assert.equal(all.length, 2);
    assert.equal(all[0].id, saved[1].id);
    assert.equal(all[1].id, saved[0].id);
    assert.equal(all[1].detailedFrameIndex, 1);
    assert.deepEqual((await reader.history({ limit: 1 })).map(item => item.id), [saved[1].id]);
    await assert.rejects(reader.history({ limit: 101 }), /limit must be/);
  } finally {
    creator.close();
    reader?.close();
    if (oldOutput === undefined) delete process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR;
    else process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR = oldOutput;
    await rm(external, { recursive: true, force: true });
  }
});

test('persists output directory settings and reopens captures from prior roots', async () => {
  const external = await mkdtemp(join(tmpdir(), 'gamedraft-webgpu-settings-'));
  const oldLocalAppData = process.env.LOCALAPPDATA;
  const oldOutput = process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR;
  process.env.LOCALAPPDATA = join(external, 'appdata');
  delete process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR;
  const firstRoot = join(external, 'first');
  const secondRoot = join(external, 'second');
  const broker = createWebGpuCaptureController(resolve('.'));
  let reopened;
  try {
    assert.equal((await broker.getSettings()).outputDirectory,
      join(external, 'appdata', 'GameDraft', 'webgpu-captures'));
    assert.equal((await broker.setSettings({ outputDirectory: firstRoot })).outputDirectory,
      await realpath(firstRoot));
    broker.register({ targetBootId: 'settings-game', captureReady: true });
    const job = await broker.request({ targetBootId: 'settings-game' });
    uploadEmptyDiagnostics(broker, job, 'settings-game', 1);
    const capture = sampleCapture();
    const completed = await broker.upload({ jobId: job.id, targetBootId: 'settings-game',
      actualFrames: 1, contentLength: capture.length, stream: Readable.from([capture]) });
    assert.ok(completed.outputDir.startsWith(await realpath(firstRoot)));
    assert.equal((await broker.setSettings({ outputDirectory: secondRoot })).outputDirectory,
      await realpath(secondRoot));
    broker.close();
    reopened = createWebGpuCaptureController(resolve('.'));
    assert.ok((await reopened.history({ limit: 10 })).some(item => item.id === job.id));
    assert.equal(await reopened.viewerFile({ jobId: job.id, file: 'report.json' })
      .then(file => file.endsWith('report.json')), true);
    const settings = JSON.parse(await readFile(join(process.env.LOCALAPPDATA,
      'GameDraft', 'webgpu-capture-settings.json'), 'utf8'));
    assert.ok(settings.historyDirectories.includes(await realpath(firstRoot)));
  } finally {
    broker.close();
    reopened?.close();
    if (oldLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = oldLocalAppData;
    if (oldOutput === undefined) delete process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR;
    else process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR = oldOutput;
    await rm(external, { recursive: true, force: true });
  }
});

test('rejects a file that only claims to be a capture', async () => {
  const external = await mkdtemp(join(tmpdir(), 'gamedraft-webgpu-reject-'));
  const oldOutput = process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR;
  process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR = external;
  const broker = createWebGpuCaptureController(resolve('.'));
  try {
    broker.register({ targetBootId: 'game-b', captureReady: true });
    const job = await broker.request({ targetBootId: 'game-b' });
    uploadEmptyDiagnostics(broker, job, 'game-b', 1);
    await assert.rejects(broker.upload({
      jobId: job.id, targetBootId: 'game-b',
      stream: Readable.from([Buffer.from('not a capture at all')]), actualFrames: 1,
    }), /WGPUCAP/);
    assert.equal(broker.status({ jobId: job.id, targetBootId: 'game-b' }).state, 'failed');
  } finally {
    broker.close();
    if (oldOutput === undefined) delete process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR;
    else process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR = oldOutput;
    await rm(external, { recursive: true, force: true });
  }
});

test('bounds raw Pass uploads at 2 GiB and accepts a verified raw-only output', async () => {
  const external = await mkdtemp(join(tmpdir(), 'gamedraft-webgpu-raw-'));
  const oldOutput = process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR;
  process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR = external;
  const broker = createWebGpuCaptureController(resolve('.'));
  try {
    broker.register({ targetBootId: 'game-raw', captureReady: true });
    const job = await broker.request({ targetBootId: 'game-raw', frames: 1 });
    const base = { jobId: job.id, targetBootId: 'game-raw', frameIndex: 1,
      passOrdinal: 0, colorIndex: 0, format: 'rgba32float', width: 16384,
      bytesPerRow: 262144 };
    await assert.rejects(broker.uploadPassRaw({ ...base, height: 8193,
      contentLength: 262144 * 8193, stream: Readable.from([]) }), /byte length exceeds the limit/);
    // This exact boundary reaches the stream-length check; it is not rejected as over budget.
    await assert.rejects(broker.uploadPassRaw({ ...base, height: 8192,
      contentLength: 2 * 1024 * 1024 * 1024, stream: Readable.from([]) }), /length differs from dimensions/);
    const saved = await broker.uploadPassRaw({ ...base, format: 'rgba8unorm',
      width: 1, height: 1, bytesPerRow: 256, contentLength: 256,
      stream: Readable.from([Buffer.alloc(256, 7)]) });
    assert.equal(saved.bytes, 256);
    await assert.rejects(broker.uploadInputRaw({ jobId: job.id, targetBootId: 'game-raw',
      inputOrdinal: 1024, format: 'rg16float', width: 1, height: 1,
      bytesPerRow: 256, contentLength: 256, stream: Readable.from([]) }), /valid ordinal/);
    const input = await broker.uploadInputRaw({ jobId: job.id, targetBootId: 'game-raw',
      inputOrdinal: 0, format: 'rg16float', width: 1, height: 1,
      bytesPerRow: 256, contentLength: 256,
      stream: Readable.from([Buffer.alloc(256, 9)]) });
    assert.equal(input.inputOrdinal, 0);
    assert.equal(input.bytes, 256);
    const detail = postDiagnostics(broker, { jobId: job.id, targetBootId: 'game-raw',
      passes: [{ passOrdinal: 0, colorIndex: 0, label: 'draw 0', targetLabel: 'screen',
        width: 1, height: 1, format: 'rgba8unorm', rawBytesPerRow: 256, rawByteLength: 256 }],
      inputs: [{ inputOrdinal: 0, passOrdinal: 0, bindingName: 'uInput',
        textureId: 3, viewId: 4, mipLevel: 0, arrayLayer: 0,
        width: 1, height: 1, format: 'rg16float', rawBytesPerRow: 256,
        rawByteLength: 256 }],
      gpuPasses: [], gpuProfilerStatus: { state: 'disabled' } });
    assert.equal(detail.passRecords, 1);
    assert.equal(detail.inputRecords, 1);
  } finally {
    broker.close();
    if (oldOutput === undefined) delete process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR;
    else process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR = oldOutput;
    await rm(external, { recursive: true, force: true });
  }
});

test('does not complete when a frame-end live resource has no raw readback', async () => {
  const external = await mkdtemp(join(tmpdir(), 'gamedraft-webgpu-incomplete-resource-'));
  const oldOutput = process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR;
  process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR = external;
  const broker = createWebGpuCaptureController(resolve('.'));
  try {
    broker.register({ targetBootId: 'game-incomplete', captureReady: true });
    const job = await broker.request({ targetBootId: 'game-incomplete' });
    assert.throws(() => broker.diagnostics({ jobId: job.id, targetBootId: 'game-incomplete',
      passes: [], gpuPasses: [], gpuProfilerStatus: { state: 'disabled' } }),
    /resource inventory/);
    postDiagnostics(broker, { jobId: job.id, targetBootId: 'game-incomplete',
      passes: [], gpuPasses: [], gpuProfilerStatus: { state: 'disabled' },
      resourceInventory: { textureCount: 1, textureSubresourceCount: 1, bufferCount: 0 },
      resourceTextures: [{ resourceOrdinal: 0, textureOrdinal: 0, textureId: null,
        label: 'unsupported', width: 1, height: 1, sourceFormat: 'rgba8unorm',
        rawFormat: 'rgba8unorm', mipLevel: 0, arrayLayer: 0, aspect: 'color',
        sampleCount: 1, captureMoment: 'frame-end', reason: 'GPU readback unsupported' }] });
    const capture = sampleCapture();
    await assert.rejects(broker.upload({ jobId: job.id, targetBootId: 'game-incomplete',
      actualFrames: 1, contentLength: capture.length, stream: Readable.from([capture]) }),
    /no complete raw readback/);
    assert.equal(broker.status({ jobId: job.id, targetBootId: 'game-incomplete' }).state, 'failed');
  } finally {
    broker.close();
    if (oldOutput === undefined) delete process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR;
    else process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR = oldOutput;
    await rm(external, { recursive: true, force: true });
  }
});

test('fails a capture when the 512-record readback cap omits a stored color output', async () => {
  const external = await mkdtemp(join(tmpdir(), 'gamedraft-webgpu-record-cap-'));
  const oldOutput = process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR;
  process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR = external;
  const broker = createWebGpuCaptureController(resolve('.'));
  try {
    broker.register({ targetBootId: 'game-cap', captureReady: true });
    const job = await broker.request({ targetBootId: 'game-cap', frames: 1 });
    const commands = [];
    for (let i = 0; i < 513; i++) {
      commands.push({ method: 'beginRenderPass', args: [{ label: `pass-${i}`,
        colorAttachments: [{ view: { __id: 2 }, loadOp: 'load', storeOp: 'store' }] }] },
      { method: 'draw', args: [3] }, { method: 'end' });
    }
    commands.push({ method: 'submit' });
    const metadata = Buffer.from(JSON.stringify({ schemaVersion: 1,
      objects: [{ id: 1, type: 'Texture', width: 1, height: 1, format: 'rgba8unorm' },
        { id: 2, type: 'TextureView', texture: { __id: 1 } }],
      commands, payloadTable: [] }));
    const header = Buffer.from(`WGPUCAP 1 ${metadata.length}\n`);
    const padding = Buffer.alloc((8 - ((header.length + metadata.length) % 8)) % 8);
    const capture = Buffer.concat([header, metadata, padding]);
    const passes = Array.from({ length: 512 }, (_, passOrdinal) => ({ passOrdinal,
      colorIndex: 0, label: `pass-${passOrdinal}`, targetLabel: 'rt',
      width: 1, height: 1, format: 'rgba8unorm', reason: 'GPU readback budget exhausted' }));
    postDiagnostics(broker, { jobId: job.id, targetBootId: 'game-cap', passes,
      gpuPasses: [], gpuProfilerStatus: { state: 'disabled' },
      warning: '1 color output exceeds the 512-record readback cap' });
    await assert.rejects(broker.upload({ jobId: job.id, targetBootId: 'game-cap',
      stream: Readable.from([capture]), actualFrames: 1, contentLength: capture.length }),
    /diagnostics are incomplete.*512-record readback cap/);
    assert.equal(broker.status({ jobId: job.id, targetBootId: 'game-cap' }).state, 'failed');
    const failedDir = join(external, job.createdAt.slice(0, 10), job.id);
    assert.deepEqual(await readFile(join(failedDir, 'capture.wgpuc')), capture);
    const evidence = JSON.parse(await readFile(join(failedDir, 'diagnostics.json'), 'utf8'));
    assert.match(evidence.error, /512-record readback cap/);
    assert.equal(evidence.diagnostics[0].frameIndex, 1);
    await assert.rejects(readFile(join(failedDir, 'manifest.json')), /ENOENT/);
  } finally {
    broker.close();
    if (oldOutput === undefined) delete process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR;
    else process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR = oldOutput;
    await rm(external, { recursive: true, force: true });
  }
});

test('checks stored Inspector targets even when diagnostics omit them; permits undefined discard contents', async () => {
  const external = await mkdtemp(join(tmpdir(), 'gamedraft-webgpu-stored-target-'));
  const oldOutput = process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR;
  process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR = external;
  const broker = createWebGpuCaptureController(resolve('.'));
  try {
    broker.register({ targetBootId: 'game-targets', captureReady: true });
    const captureWithStoreOp = storeOp => {
      const metadata = Buffer.from(JSON.stringify({ schemaVersion: 1,
        objects: [{ id: 1, type: 'Texture', width: 1, height: 1, format: 'rgba8unorm' },
          { id: 2, type: 'TextureView', texture: { __id: 1 } }],
        commands: [{ method: 'beginRenderPass', args: [{ label: 'one target',
          colorAttachments: [{ view: { __id: 2 }, loadOp: 'load', storeOp }] }] },
        { method: 'draw', args: [3] }, { method: 'end' }, { method: 'submit' }],
        payloadTable: [] }));
      const header = Buffer.from(`WGPUCAP 1 ${metadata.length}\n`);
      return Buffer.concat([header, metadata,
        Buffer.alloc((8 - ((header.length + metadata.length) % 8)) % 8)]);
    };
    const stored = await broker.request({ targetBootId: 'game-targets', frames: 1 });
    postDiagnostics(broker, { jobId: stored.id, targetBootId: 'game-targets',
      passes: [], gpuPasses: [], gpuProfilerStatus: { state: 'disabled' } });
    const storedCapture = captureWithStoreOp('store');
    await assert.rejects(broker.upload({ jobId: stored.id, targetBootId: 'game-targets',
      actualFrames: 1, contentLength: storedCapture.length,
      stream: Readable.from([storedCapture]) }), /stored color 0 has no verified pass-end raw/);
    assert.equal(broker.status({ jobId: stored.id, targetBootId: 'game-targets' }).state, 'failed');

    const discarded = await broker.request({ targetBootId: 'game-targets', frames: 1 });
    postDiagnostics(broker, { jobId: discarded.id, targetBootId: 'game-targets',
      passes: [], gpuPasses: [], gpuProfilerStatus: { state: 'disabled' } });
    const discardCapture = captureWithStoreOp('discard');
    const completed = await broker.upload({ jobId: discarded.id, targetBootId: 'game-targets',
      actualFrames: 1, contentLength: discardCapture.length,
      stream: Readable.from([discardCapture]) });
    assert.equal(completed.state, 'completed');
  } finally {
    broker.close();
    if (oldOutput === undefined) delete process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR;
    else process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR = oldOutput;
    await rm(external, { recursive: true, force: true });
  }
});

test('marks only verified one-Draw step pass readbacks as post-Draw outputs', async () => {
  const external = await mkdtemp(join(tmpdir(), 'gamedraft-draw-step-'));
  const output = join(external, 'analysis');
  try {
    await mkdir(output);
    const objects = [
      { id: 1, type: 'Texture', width: 1, height: 1, format: 'rgba8unorm' },
      { id: 2, type: 'TextureView', texture: { __id: 1 } },
      { id: 3, type: 'Texture', width: 1, height: 1, format: 'rgba8unorm' },
      { id: 4, type: 'TextureView', texture: { __id: 3 } },
      { id: 5, type: 'BindGroup', descriptor: { entries: [
        { binding: 0, resource: { __id: 4 } },
      ] } },
    ];
    const begin = label => ({ method: 'beginRenderPass', args: [{ label,
      colorAttachments: [{ view: { __id: 2 }, loadOp: 'load', storeOp: 'store' }] }] });
    const commands = [
      begin('canvas / test / frame-debug draw 1/2'),
      { method: 'setBindGroup', args: [0, { __id: 5 }] },
      { method: 'draw', args: [3] }, { method: 'end' },
      begin('canvas / test / frame-debug draw 2/2'),
      { method: 'setBindGroup', args: [0, { __id: 5 }] },
      { method: 'drawIndexed', args: [6] }, { method: 'end' },
      begin('canvas / ordinary'), { method: 'draw', args: [3] }, { method: 'draw', args: [3] }, { method: 'end' },
      begin('canvas / incomplete / frame-debug draw 1/2'), { method: 'draw', args: [3] }, { method: 'end' },
      { method: 'submit' },
    ];
    const report = summarizeCapture({ metadata: { objects, commands, payloadTable: [] },
      payloads: [], captureFile: join(external, 'capture.wgpuc'), size: 0 });
    const { passes, frames, events } = report;
    assert.equal(passes.length, 4);
    assert.deepEqual(passes.slice(0, 2).map(pass => pass.frameDebugStep?.drawCommandIndex), [2, 6]);
    assert.deepEqual(passes.slice(0, 2).map(pass => pass.frameDebugStep?.drawOrdinal), [1, 2]);
    assert.equal(passes[2].frameDebugStep, undefined);
    assert.equal(passes[3].frameDebugStep, undefined);
    assert.equal(events[2].method, 'draw');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlMysAAAAAASUVORK5CYII=', 'base64');
    await writeFile(join(external, 'pixel.png'), png);
    const rawInput = Buffer.alloc(256, 11);
    await writeFile(join(external, 'input.bin'), rawInput);
    const snapshots = passes.map(pass => ({ frameOrdinal: 1, passIndex: pass.index,
      afterCommandIndex: pass.endCommand, textureId: 1, colorIndex: 0,
      format: 'rgba8unorm', width: 1, height: 1, file: 'pixel.png' }));
    const inputSnapshots = [
      { frameOrdinal: 1, passIndex: 0, inputOrdinal: 0, bindingName: 'uInput',
        textureId: 3, viewId: 4, mipLevel: 0, arrayLayer: 0, width: 1, height: 1,
        format: 'rgba8unorm', beforeCommandIndex: 2,
        file: 'pixel.png', imageSha256: createHash('sha256').update(png).digest('hex'),
        rawFile: 'input.bin', rawFormat: 'rgba8unorm', rawBytesPerRow: 256,
        rawByteLength: 256, rawSha256: createHash('sha256').update(rawInput).digest('hex') },
      { frameOrdinal: 1, passIndex: 1, inputOrdinal: 1, bindingName: 'wrongView',
        textureId: 3, viewId: 999, mipLevel: 0, arrayLayer: 0, width: 1, height: 1,
        format: 'rgba8unorm', beforeCommandIndex: 6, file: 'pixel.png' },
      { frameOrdinal: 1, passIndex: 1, inputOrdinal: 2, bindingName: 'badDigest',
        textureId: 3, viewId: 4, mipLevel: 0, arrayLayer: 0, width: 1, height: 1,
        format: 'rgba8unorm', beforeCommandIndex: 6, file: 'pixel.png',
        imageSha256: '0'.repeat(64) },
    ];
    await writeFile(join(external, 'sidecars.json'), JSON.stringify({ schemaVersion: 1,
      frames: [], passSnapshots: snapshots, inputSnapshots, passUnavailable: [], gpuTimings: [] }));
    const attached = await attachFrameSidecars(join(external, 'capture.wgpuc'), output,
      frames, passes, events, report.resources);
    assert.equal(attached.errors.length, 1);
    assert.match(attached.errors[0].reason, /SHA-256 differs/);
    assert.deepEqual(attached.passSnapshots.map(item => item.captureMoment),
      ['post-draw', 'post-draw', 'pass-end', 'pass-end']);
    assert.deepEqual(attached.passSnapshots.map(item => item.drawCommandIndex), [2, 6, undefined, undefined]);
    assert.deepEqual(attached.inputSnapshots.map(item => item.captureMoment),
      ['pre-draw', 'unavailable', 'unavailable']);
    assert.equal(attached.inputSnapshots[0].drawCommandIndex, 2);
    assert.equal(attached.inputSnapshots[0].binding, 0);
    assert.equal(attached.inputSnapshots[0].rawByteLength, 256);
    assert.match(attached.inputSnapshots[1].reason, /IDs do not match/);
    assert.equal(attached.inputSnapshots[2].imageFile, null);
    const oldOutput = process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR;
    process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR = external;
    const broker = createWebGpuCaptureController(resolve('.'));
    try {
      broker.register({ targetBootId: 'game-input', captureReady: true });
      const job = await broker.request({ targetBootId: 'game-input', frames: 1 });
      await broker.uploadInputImage({ jobId: job.id, targetBootId: 'game-input',
        inputOrdinal: 0, contentLength: png.length, stream: Readable.from([png]) });
      await broker.uploadInputRaw({ jobId: job.id, targetBootId: 'game-input',
        inputOrdinal: 0, format: 'rgba8unorm', width: 1, height: 1,
        bytesPerRow: 256, contentLength: rawInput.length,
        stream: Readable.from([rawInput]) });
      for (let passOrdinal = 0; passOrdinal < passes.length; passOrdinal++) {
        await broker.uploadPassRaw({ jobId: job.id, targetBootId: 'game-input',
          passOrdinal, colorIndex: 0, format: 'rgba8unorm', width: 1, height: 1,
          bytesPerRow: 256, contentLength: rawInput.length,
          stream: Readable.from([rawInput]) });
      }
      postDiagnostics(broker, { jobId: job.id, targetBootId: 'game-input',
        passes: passes.map((pass, passOrdinal) => ({ passOrdinal, colorIndex: 0, label: pass.label,
          targetLabel: 'screen', width: 1, height: 1, format: 'rgba8unorm',
          rawBytesPerRow: 256, rawByteLength: 256 })),
        inputs: [{ inputOrdinal: 0, passOrdinal: 0, bindingName: 'uInput',
          groupSlot: 0, binding: 0,
          textureId: 3, viewId: 4, mipLevel: 0, arrayLayer: 0,
          width: 1, height: 1, format: 'rgba8unorm',
          rawBytesPerRow: 256, rawByteLength: 256 }],
        gpuPasses: [], gpuProfilerStatus: { state: 'disabled' } });
      const metadata = Buffer.from(JSON.stringify({ schemaVersion: 1,
        objects, commands, payloadTable: [] }));
      const header = Buffer.from(`WGPUCAP 1 ${metadata.length}\n`);
      const padding = Buffer.alloc((8 - ((header.length + metadata.length) % 8)) % 8);
      const capture = Buffer.concat([header, metadata, padding]);
      const completed = await broker.upload({ jobId: job.id, targetBootId: 'game-input',
        actualFrames: 1, contentLength: capture.length, stream: Readable.from([capture]) });
      assert.equal(completed.state, 'completed');
      const persisted = JSON.parse(await readFile(join(completed.outputDir, 'sidecars.json'), 'utf8'));
      assert.equal(persisted.inputSnapshots[0].beforeCommandIndex, 2);
      assert.equal(persisted.inputSnapshots[0].viewId, 4);
      assert.equal(persisted.inputSnapshots[0].groupSlot, 0);
      assert.equal(persisted.inputSnapshots[0].binding, 0);
      assert.ok(persisted.inputSnapshots[0].imageSha256);
      const reportFile = await broker.viewerFile({ jobId: job.id, file: 'report.json' });
      const analyzed = JSON.parse(await readFile(reportFile, 'utf8'));
      assert.equal(analyzed.passes[0].inputSnapshots[0].captureMoment, 'pre-draw');
      assert.equal(analyzed.passes[0].inputSnapshots[0].rawByteLength, 256);
      assert.equal(analyzed.passes[0].inputSnapshots[0].binding, 0);
      assert.ok(await broker.viewerFile({ jobId: job.id,
        file: analyzed.passes[0].inputSnapshots[0].imageFile }));
    } finally {
      broker.close();
      if (oldOutput === undefined) delete process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR;
      else process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR = oldOutput;
    }
  } finally {
    await rm(external, { recursive: true, force: true });
  }
});

test('persists verified depth/stencil aspects and rejects tampered or mismatched evidence', async () => {
  const external = await mkdtemp(join(tmpdir(), 'gamedraft-aspect-sidecar-'));
  const oldOutput = process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR;
  process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR = external;
  const broker = createWebGpuCaptureController(resolve('.'));
  try {
    const objects = [
      { id: 1, type: 'Texture', width: 1, height: 1, format: 'rgba8unorm' },
      { id: 2, type: 'TextureView', texture: { __id: 1 } },
      { id: 3, type: 'Texture', width: 1, height: 1, format: 'depth24plus-stencil8',
        descriptor: { format: 'depth24plus-stencil8', sampleCount: 1 } },
      { id: 4, type: 'TextureView', texture: { __id: 3 } },
    ];
    const commands = [
      { method: 'beginRenderPass', args: [{ label: 'scene / frame-debug draw 1/1',
        colorAttachments: [{ view: { __id: 2 }, loadOp: 'load', storeOp: 'store' }],
        depthStencilAttachment: { view: { __id: 4 }, depthLoadOp: 'load',
          depthStoreOp: 'store', stencilLoadOp: 'load', stencilStoreOp: 'store' } }] },
      { method: 'draw', args: [3] }, { method: 'end' }, { method: 'submit' },
    ];
    const metadata = Buffer.from(JSON.stringify({ schemaVersion: 1, objects, commands,
      payloadTable: [] }));
    const header = Buffer.from(`WGPUCAP 1 ${metadata.length}\n`);
    const capture = Buffer.concat([header, metadata,
      Buffer.alloc((8 - ((header.length + metadata.length) % 8)) % 8)]);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlMysAAAAAASUVORK5CYII=', 'base64');
    const depthRaw = Buffer.alloc(256);
    depthRaw.writeFloatLE(0.42, 0);
    const stencilRaw = Buffer.alloc(256, 7);
    broker.register({ targetBootId: 'game-aspect', captureReady: true });
    const job = await broker.request({ targetBootId: 'game-aspect', frames: 1 });
    const base = { jobId: job.id, targetBootId: 'game-aspect' };
    await assert.rejects(broker.uploadAspectRaw({ ...base, aspectOrdinal: 1024,
      format: 'stencil8', width: 1, height: 1, bytesPerRow: 256,
      contentLength: 256, stream: Readable.from([stencilRaw]) }), /valid ordinal/);
    await broker.uploadAspectImage({ ...base, aspectOrdinal: 0,
      contentLength: png.length, stream: Readable.from([png]) });
    await broker.uploadAspectRaw({ ...base, aspectOrdinal: 0,
      format: 'r32float', width: 1, height: 1, bytesPerRow: 256,
      contentLength: depthRaw.length, stream: Readable.from([depthRaw]) });
    await broker.uploadAspectRaw({ ...base, aspectOrdinal: 1,
      format: 'stencil8', width: 1, height: 1, bytesPerRow: 256,
      contentLength: stencilRaw.length, stream: Readable.from([stencilRaw]) });
    await broker.uploadPassRaw({ ...base, passOrdinal: 0, colorIndex: 0,
      format: 'rgba8unorm', width: 1, height: 1, bytesPerRow: 256,
      contentLength: 256, stream: Readable.from([Buffer.alloc(256, 3)]) });
    await broker.uploadResourceTextureRaw({ ...base, resourceOrdinal: 0,
      format: 'r32float', width: 1, height: 1, bytesPerRow: 4,
      contentLength: 4, stream: Readable.from([depthRaw.subarray(0, 4)]) });
    await broker.uploadResourceTextureRaw({ ...base, resourceOrdinal: 1,
      format: 'stencil8', width: 1, height: 1, bytesPerRow: 256,
      contentLength: stencilRaw.length, stream: Readable.from([stencilRaw]) });
    const aspects = [
      { aspectOrdinal: 0, passOrdinal: 0, label: 'scene / frame-debug draw 1/1',
        targetLabel: 'depth', aspect: 'depth', textureId: 3, viewId: 4,
        width: 1, height: 1, sourceFormat: 'depth24plus-stencil8', rawFormat: 'r32float',
        sampleCount: 1, sampleIndex: null, rawBytesPerRow: 256, rawByteLength: 256 },
      { aspectOrdinal: 1, passOrdinal: 0, label: 'scene / frame-debug draw 1/1',
        targetLabel: 'stencil', aspect: 'stencil', textureId: 3, viewId: 4,
        width: 1, height: 1, sourceFormat: 'depth24plus-stencil8', rawFormat: 'stencil8',
        sampleCount: 1, sampleIndex: null, rawBytesPerRow: 256, rawByteLength: 256 },
    ];
    assert.equal(postDiagnostics(broker, { ...base, passes: [{ passOrdinal: 0,
      colorIndex: 0, label: 'scene / frame-debug draw 1/1', targetLabel: 'screen',
      width: 1, height: 1, format: 'rgba8unorm', rawBytesPerRow: 256,
      rawByteLength: 256 }], aspects,
      resourceInventory: { textureCount: 1, textureSubresourceCount: 2, bufferCount: 0 },
      resourceTextures: [
        { resourceOrdinal: 0, textureOrdinal: 0, textureId: 3, label: 'depth',
          width: 1, height: 1, sourceFormat: 'depth24plus-stencil8',
          rawFormat: 'r32float', mipLevel: 0, arrayLayer: 0, aspect: 'depth',
          sampleCount: 1, captureMoment: 'frame-end', rawBytesPerRow: 4,
          rawByteLength: 4 },
        { resourceOrdinal: 1, textureOrdinal: 0, textureId: 3, label: 'stencil',
          width: 1, height: 1, sourceFormat: 'depth24plus-stencil8',
          rawFormat: 'stencil8', mipLevel: 0, arrayLayer: 0, aspect: 'stencil',
          sampleCount: 1, captureMoment: 'frame-end', rawBytesPerRow: 256,
          rawByteLength: 256 },
      ],
      gpuPasses: [], gpuProfilerStatus: { state: 'disabled' } }).aspectRecords, 2);
    const completed = await broker.upload({ ...base, actualFrames: 1,
      contentLength: capture.length, stream: Readable.from([capture]) });
    assert.equal(completed.state, 'completed');
    const sidecars = JSON.parse(await readFile(join(completed.outputDir, 'sidecars.json'), 'utf8'));
    assert.equal(sidecars.aspectSnapshots.length, 2);
    assert.equal(sidecars.resourceTextureSnapshots.length, 2);
    assert.equal(sidecars.aspectSnapshots[0].afterCommandIndex, 2);
    assert.equal(sidecars.aspectSnapshots[1].rawFormat, 'stencil8');
    const reportFile = await broker.viewerFile({ jobId: job.id, file: 'report.json' });
    const analyzed = JSON.parse(await readFile(reportFile, 'utf8'));
    assert.deepEqual(analyzed.passes[0].aspectSnapshots.map(item => item.captureMoment),
      ['pass-end', 'pass-end']);
    assert.equal(analyzed.passes[0].aspectSnapshots[0].rawFormat, 'r32float');
    assert.ok(await broker.viewerFile({ jobId: job.id,
      file: analyzed.passes[0].aspectSnapshots[1].rawFile }));

    const tampered = join(completed.outputDir, sidecars.aspectSnapshots[1].rawFile);
    await writeFile(tampered, Buffer.alloc(256, 99));
    const tamperedOutput = join(external, 'tampered-analysis');
    await mkdir(tamperedOutput);
    const failedHash = await attachFrameSidecars(completed.captureFile, tamperedOutput,
      analyzed.frames, analyzed.passes, analyzed.events, analyzed.resources);
    assert.equal(failedHash.aspectSnapshots[1].captureMoment, 'unavailable');
    assert.match(failedHash.errors[0].reason, /SHA-256 differs/);
    await assert.rejects(analyzeCapture(completed.captureFile),
      /required sidecar failed validation.*SHA-256 differs/);

    await writeFile(tampered, stencilRaw);
    sidecars.aspectSnapshots[1].viewId = 999;
    await writeFile(join(completed.outputDir, 'sidecars.json'), JSON.stringify(sidecars));
    const mismatchedOutput = join(external, 'mismatched-analysis');
    await mkdir(mismatchedOutput);
    const failedId = await attachFrameSidecars(completed.captureFile, mismatchedOutput,
      analyzed.frames, analyzed.passes, analyzed.events, analyzed.resources);
    assert.equal(failedId.aspectSnapshots[1].captureMoment, 'unavailable');
    assert.match(failedId.aspectSnapshots[1].reason, /attachment IDs/);
  } finally {
    broker.close();
    if (oldOutput === undefined) delete process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR;
    else process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR = oldOutput;
    await rm(external, { recursive: true, force: true });
  }
});

test('keeps RHI GPU timings and Draw steps aligned around diagnostic depth compute passes', async () => {
  const external = await mkdtemp(join(tmpdir(), 'gamedraft-depth-aux-order-'));
  const oldOutput = process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR;
  process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR = external;
  const broker = createWebGpuCaptureController(resolve('.'));
  try {
    const objects = [
      { id: 1, type: 'Texture', width: 1, height: 1, format: 'rgba8unorm' },
      { id: 2, type: 'TextureView', texture: { __id: 1 } },
    ];
    const render = label => ({ method: 'beginRenderPass', args: [{ label,
      colorAttachments: [{ view: { __id: 2 }, loadOp: 'load', storeOp: 'store' }] }] });
    const commands = [
      render('scene / frame-debug draw 1/2'), { method: 'draw', args: [3] }, { method: 'end' },
      { method: 'beginComputePass', args: [{ label: 'frame-debug depth after render pass 0' }] },
      { method: 'dispatchWorkgroups', args: [1] }, { method: 'end' },
      render('scene / frame-debug draw 2/2'), { method: 'draw', args: [3] }, { method: 'end' },
      { method: 'beginComputePass', args: [{ label: 'game compute' }] },
      { method: 'dispatchWorkgroups', args: [1] }, { method: 'end' },
      { method: 'submit' },
    ];
    const metadata = Buffer.from(JSON.stringify({ schemaVersion: 1, objects, commands,
      payloadTable: [] }));
    const header = Buffer.from(`WGPUCAP 1 ${metadata.length}\n`);
    const capture = Buffer.concat([header, metadata,
      Buffer.alloc((8 - ((header.length + metadata.length) % 8)) % 8)]);
    broker.register({ targetBootId: 'game-aux', captureReady: true });
    const job = await broker.request({ targetBootId: 'game-aux', frames: 1 });
    const base = { jobId: job.id, targetBootId: 'game-aux' };
    for (const passOrdinal of [0, 1]) {
      await broker.uploadPassRaw({ ...base, passOrdinal, colorIndex: 0,
        format: 'rgba8unorm', width: 1, height: 1, bytesPerRow: 256,
        contentLength: 256, stream: Readable.from([Buffer.alloc(256, passOrdinal)]) });
    }
    postDiagnostics(broker, { ...base, passes: [0, 1].map(passOrdinal => ({ passOrdinal,
      colorIndex: 0, label: `scene / frame-debug draw ${passOrdinal + 1}/2`,
      targetLabel: 'screen', width: 1, height: 1, format: 'rgba8unorm',
      rawBytesPerRow: 256, rawByteLength: 256 })),
    gpuPasses: [
      { ordinal: 0, kind: 'render', label: 'scene / frame-debug draw 1/2', durationMs: 1 },
      { ordinal: 1, kind: 'render', label: 'scene / frame-debug draw 2/2', durationMs: 2 },
      { ordinal: 2, kind: 'compute', label: 'game compute', durationMs: 3 },
    ], gpuProfilerStatus: { state: 'enabled' } });
    const completed = await broker.upload({ ...base, actualFrames: 1,
      contentLength: capture.length, stream: Readable.from([capture]) });
    const sidecars = JSON.parse(await readFile(join(completed.outputDir, 'sidecars.json'), 'utf8'));
    assert.deepEqual(sidecars.gpuTimings.map(item => item.passIndex), [0, 2, 3]);
    const analyzed = JSON.parse(await readFile(await broker.viewerFile({
      jobId: job.id, file: 'report.json' }), 'utf8'));
    assert.deepEqual(analyzed.passes.filter(pass => pass.frameDebugStep)
      .map(pass => pass.frameDebugStep.drawOrdinal), [1, 2]);
    assert.equal(analyzed.passes[1].diagnosticAuxiliary, 'depth-readback');
    assert.equal(analyzed.passes[1].gpuTiming, undefined);
    assert.deepEqual(analyzed.passes.filter(pass => pass.gpuTiming)
      .map(pass => pass.gpuTiming.durationMs), [1, 2, 3]);
  } finally {
    broker.close();
    if (oldOutput === undefined) delete process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR;
    else process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR = oldOutput;
    await rm(external, { recursive: true, force: true });
  }
});

test('attributes a reused TextureView only to an explicitly verified binding slot', () => {
  const pass = { type: 'render', draws: 1, beginCommand: 0, endCommand: 3,
    index: 0, frameOrdinal: 1, frameDebugStep: { drawCommandIndex: 2 } };
  const resource = { type: 'TextureView', id: 4, textureId: 3 };
  const events = [null, null, { commandIndex: 2, passIndex: 0, frameOrdinal: 1,
    method: 'draw', bindGroups: [{ slot: 0, resources: [
      { binding: 1, resource }, { binding: 3, resource },
    ] }] }];
  const resources = { textureViews: [{ id: 4, textureId: 3, descriptor: {} }] };
  const input = { textureId: 3, viewId: 4, mipLevel: 0, arrayLayer: 0 };
  assert.deepEqual(verifiedInputBinding(pass, events, resources,
    { ...input, groupSlot: 0, binding: 3 }), { groupSlot: 0, binding: 3 });
  assert.equal(verifiedInputBinding(pass, events, resources,
    { ...input, groupSlot: 0, binding: 2 }), null);
  const ambiguous = verifiedInputBinding(pass, events, resources, input);
  assert.equal(ambiguous.groupSlot, null);
  assert.equal(ambiguous.binding, null);
  assert.equal(ambiguous.bindingAmbiguous, true);
  assert.deepEqual(ambiguous.bindingCandidates, [
    { groupSlot: 0, binding: 1 }, { groupSlot: 0, binding: 3 },
  ]);
});

test('exports exact pre-Draw shader, vertex and index Buffer ranges with evidence checks', async () => {
  const external = await mkdtemp(join(tmpdir(), 'gamedraft-buffer-sidecar-'));
  const oldOutput = process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR;
  process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR = external;
  const broker = createWebGpuCaptureController(resolve('.'));
  try {
    const objects = [
      { id: 1, type: 'Texture', width: 1, height: 1, format: 'rgba8unorm' },
      { id: 2, type: 'TextureView', texture: { __id: 1 } },
      { id: 3, type: 'Buffer', size: 16 },
      { id: 4, type: 'Buffer', size: 32 },
      { id: 5, type: 'Buffer', size: 16 },
      { id: 6, type: 'BindGroup', descriptor: { entries: [
        { binding: 0, resource: { buffer: { __id: 3 }, offset: 0, size: 16 } },
      ] } },
    ];
    const commands = [
      { method: 'beginRenderPass', args: [{ label: 'scene / frame-debug draw 1/1',
        colorAttachments: [{ view: { __id: 2 }, loadOp: 'load', storeOp: 'store' }] }] },
      { method: 'setBindGroup', args: [0, { __id: 6 }] },
      { method: 'setVertexBuffer', args: [0, { __id: 4 }, 0, 32] },
      { method: 'setIndexBuffer', args: [{ __id: 5 }, 'uint16', 0, 16] },
      { method: 'drawIndexed', args: [3, 1, 2, 0, 0] },
      { method: 'end' }, { method: 'submit' },
    ];
    const metadata = Buffer.from(JSON.stringify({ schemaVersion: 1, objects, commands,
      payloadTable: [] }));
    const header = Buffer.from(`WGPUCAP 1 ${metadata.length}\n`);
    const capture = Buffer.concat([header, metadata,
      Buffer.alloc((8 - ((header.length + metadata.length) % 8)) % 8)]);
    broker.register({ targetBootId: 'game-buffer', captureReady: true });
    const job = await broker.request({ targetBootId: 'game-buffer', frames: 1 });
    const base = { jobId: job.id, targetBootId: 'game-buffer' };
    const bytes = [Buffer.alloc(16, 1), Buffer.alloc(32, 2), Buffer.alloc(8, 3)];
    await assert.rejects(broker.uploadBufferRaw({ ...base, bufferOrdinal: 8192,
      contentLength: 8, stream: Readable.from([bytes[2]]) }), /valid buffer ordinal/);
    for (const [bufferOrdinal, raw] of bytes.entries()) {
      await broker.uploadBufferRaw({ ...base, bufferOrdinal,
        contentLength: raw.length, stream: Readable.from([raw]) });
    }
    await broker.uploadPassRaw({ ...base, passOrdinal: 0, colorIndex: 0,
      format: 'rgba8unorm', width: 1, height: 1, bytesPerRow: 256,
      contentLength: 256, stream: Readable.from([Buffer.alloc(256, 4)]) });
    const buffers = [
      { bufferOrdinal: 0, passOrdinal: 0, role: 'uniform', bindingName: 'Globals',
        groupSlot: 0, binding: 0, bufferId: 3, bufferLabel: 'globals', totalSize: 16,
        offset: 0, size: 16, copiedOffset: 0, copiedSize: 16,
        rangeScope: 'binding', rawByteLength: 16 },
      { bufferOrdinal: 1, passOrdinal: 0, role: 'vertex', streamName: 'position',
        vertexSlot: 0, bufferId: 4, bufferLabel: 'quad', totalSize: 32,
        offset: 0, size: 32, copiedOffset: 0, copiedSize: 32,
        rangeScope: 'bound-suffix', rawByteLength: 32 },
      { bufferOrdinal: 2, passOrdinal: 0, role: 'index', indexFormat: 'uint16',
        bufferId: 5, bufferLabel: 'indices', totalSize: 16,
        offset: 4, size: 6, copiedOffset: 4, copiedSize: 8,
        rangeScope: 'draw-indices', rawByteLength: 8 },
    ];
    postDiagnostics(broker, { ...base, passes: [{ passOrdinal: 0, colorIndex: 0,
      label: 'scene / frame-debug draw 1/1', targetLabel: 'screen',
      width: 1, height: 1, format: 'rgba8unorm', rawBytesPerRow: 256,
      rawByteLength: 256 }],
    buffers, gpuPasses: [], gpuProfilerStatus: { state: 'disabled' } });
    const completed = await broker.upload({ ...base, actualFrames: 1,
      contentLength: capture.length, stream: Readable.from([capture]) });
    assert.equal(completed.state, 'completed');
    const sidecars = JSON.parse(await readFile(join(completed.outputDir, 'sidecars.json'), 'utf8'));
    assert.equal(sidecars.bufferSnapshots.length, 3);
    assert.deepEqual(sidecars.bufferSnapshots.map(item => item.beforeCommandIndex), [4, 4, 4]);
    assert.deepEqual(sidecars.bufferSnapshots.map(item => item.rawByteLength), [16, 32, 8]);
    const analyzed = JSON.parse(await readFile(await broker.viewerFile({
      jobId: job.id, file: 'report.json' }), 'utf8'));
    assert.deepEqual(analyzed.passes[0].bufferSnapshots.map(item => item.captureMoment),
      ['pre-draw', 'pre-draw', 'pre-draw']);
    assert.deepEqual(analyzed.passes[0].bufferSnapshots.map(item => item.bufferId), [3, 4, 5]);
    assert.equal(analyzed.passes[0].bufferSnapshots[2].rangeScope, 'draw-indices');
    assert.equal(analyzed.passes[0].bufferSnapshots[2].copiedOffset, 4);
    const exportedRawName = analyzed.passes[0].bufferSnapshots[2].rawFile;
    const exportedRaw = await broker.viewerFile({ jobId: job.id, file: exportedRawName });
    assert.ok(exportedRaw);
    await writeFile(exportedRaw, Buffer.alloc(9, 99));
    await assert.rejects(broker.viewerFile({ jobId: job.id, file: exportedRawName }),
      /integrity index/);

    const copied = join(completed.outputDir, sidecars.bufferSnapshots[2].rawFile);
    await writeFile(copied, Buffer.alloc(8, 99));
    const badHashDir = join(external, 'bad-buffer-hash');
    await mkdir(badHashDir);
    const badHash = await attachFrameSidecars(completed.captureFile, badHashDir,
      analyzed.frames, analyzed.passes, analyzed.events, analyzed.resources);
    assert.equal(badHash.bufferSnapshots[2].captureMoment, 'unavailable');
    assert.match(badHash.errors[0].reason, /SHA-256 differs/);

    await writeFile(copied, bytes[2]);
    sidecars.bufferSnapshots[0].binding = 1;
    await writeFile(join(completed.outputDir, 'sidecars.json'), JSON.stringify(sidecars));
    const badSlotDir = join(external, 'bad-buffer-slot');
    await mkdir(badSlotDir);
    const badSlot = await attachFrameSidecars(completed.captureFile, badSlotDir,
      analyzed.frames, analyzed.passes, analyzed.events, analyzed.resources);
    assert.equal(badSlot.bufferSnapshots[0].captureMoment, 'unavailable');
    assert.match(badSlot.bufferSnapshots[0].reason, /slot/);
  } finally {
    broker.close();
    if (oldOutput === undefined) delete process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR;
    else process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR = oldOutput;
    await rm(external, { recursive: true, force: true });
  }
});

test('shares one same-frame input readback while preserving each Draw binding and source command', async () => {
  const external = await mkdtemp(join(tmpdir(), 'gamedraft-input-alias-'));
  const oldOutput = process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR;
  process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR = external;
  const broker = createWebGpuCaptureController(resolve('.'));
  try {
    const label = ordinal => `scene / frame-debug draw ${ordinal + 1}/2`;
    const objects = [
      { id: 1, type: 'Texture', width: 1, height: 1, format: 'rgba8unorm' },
      { id: 2, type: 'TextureView', texture: { __id: 1 } },
      { id: 3, type: 'Texture', width: 1, height: 1, format: 'rgba8unorm' },
      { id: 4, type: 'TextureView', texture: { __id: 3 } },
      { id: 5, type: 'BindGroup', descriptor: { entries: [
        { binding: 0, resource: { __id: 4 } },
      ] } },
    ];
    const commands = [0, 1].flatMap(passOrdinal => [
      { method: 'beginRenderPass', args: [{ label: label(passOrdinal),
        colorAttachments: [{ view: { __id: 2 }, loadOp: 'load', storeOp: 'store' }] }] },
      { method: 'setBindGroup', args: [0, { __id: 5 }] },
      { method: 'draw', args: [3] }, { method: 'end' },
    ]).concat([{ method: 'submit' }]);
    const metadata = Buffer.from(JSON.stringify({ schemaVersion: 1, objects, commands,
      payloadTable: [] }));
    const header = Buffer.from(`WGPUCAP 1 ${metadata.length}\n`);
    const capture = Buffer.concat([header, metadata,
      Buffer.alloc((8 - ((header.length + metadata.length) % 8)) % 8)]);
    const raw = Buffer.alloc(256, 12);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlMysAAAAAASUVORK5CYII=', 'base64');
    broker.register({ targetBootId: 'game-alias', captureReady: true });
    const job = await broker.request({ targetBootId: 'game-alias', frames: 1 });
    const base = { jobId: job.id, targetBootId: 'game-alias' };
    for (const passOrdinal of [0, 1]) {
      await broker.uploadPassRaw({ ...base, passOrdinal, colorIndex: 0,
        format: 'rgba8unorm', width: 1, height: 1, bytesPerRow: 256,
        contentLength: raw.length, stream: Readable.from([raw]) });
    }
    await broker.uploadInputRaw({ ...base, inputOrdinal: 0, format: 'rgba8unorm',
      width: 1, height: 1, bytesPerRow: 256, contentLength: raw.length,
      stream: Readable.from([raw]) });
    await broker.uploadInputImage({ ...base, inputOrdinal: 0,
      contentLength: png.length, stream: Readable.from([png]) });
    const passes = [0, 1].map(passOrdinal => ({ passOrdinal, colorIndex: 0,
      label: label(passOrdinal), targetLabel: 'screen', width: 1, height: 1,
      format: 'rgba8unorm', rawBytesPerRow: 256, rawByteLength: 256 }));
    const inputs = [0, 1].map(inputOrdinal => ({ inputOrdinal,
      passOrdinal: inputOrdinal, bindingName: 'uInput', groupSlot: 0, binding: 0,
      textureId: 3, viewId: 4, mipLevel: 0, arrayLayer: 0,
      width: 1, height: 1, format: 'rgba8unorm', contentVersion: 0,
      rawBytesPerRow: 256, rawByteLength: 256,
      ...(inputOrdinal ? { rawAliasInputOrdinal: 0 } : {}) }));
    assert.throws(() => postDiagnostics(broker, { ...base, passes,
      inputs: [inputs[0], { ...inputs[1], contentVersion: 1 }],
      gpuPasses: [], gpuProfilerStatus: { state: 'disabled' } }),
    /raw alias differs/);
    postDiagnostics(broker, { ...base, passes, inputs,
      gpuPasses: [], gpuProfilerStatus: { state: 'disabled' } });
    const completed = await broker.upload({ ...base, actualFrames: 1,
      contentLength: capture.length, stream: Readable.from([capture]) });
    assert.equal(completed.state, 'completed');
    const sidecars = JSON.parse(await readFile(join(completed.outputDir, 'sidecars.json'), 'utf8'));
    assert.equal(sidecars.inputSnapshots.length, 2);
    assert.equal(sidecars.inputSnapshots[0].rawFile, sidecars.inputSnapshots[1].rawFile);
    assert.equal(sidecars.inputSnapshots[0].file, sidecars.inputSnapshots[1].file);
    const report = JSON.parse(await readFile(await broker.viewerFile({
      jobId: job.id, file: 'report.json' }), 'utf8'));
    assert.equal(report.inputSnapshots.length, 2);
    assert.notEqual(report.inputSnapshots[0].beforeCommandIndex,
      report.inputSnapshots[1].beforeCommandIndex);
    assert.equal(report.inputSnapshots[1].rawAliasInputOrdinal, 0);
    assert.equal(report.inputSnapshots[1].rawSourceBeforeCommandIndex,
      report.inputSnapshots[0].beforeCommandIndex);
    assert.equal(report.inputSnapshots[0].rawFile, report.inputSnapshots[1].rawFile);
    assert.equal(report.inputSnapshots[0].imageFile, report.inputSnapshots[1].imageFile);
    const analysisDir = resolve(await broker.viewerFile({ jobId: job.id,
      file: 'report.json' }), '..');
    assert.equal((await readdir(join(analysisDir, 'input-raw'))).length, 1);
    assert.equal((await readdir(join(analysisDir, 'input-snapshots'))).length, 1);
    const probeSource = join(external, 'hard-link-probe.bin');
    const probeTarget = join(external, 'hard-link-probe-linked.bin');
    await writeFile(probeSource, raw);
    let hardLinksSupported = false;
    try { await link(probeSource, probeTarget); hardLinksSupported = true; }
    catch (error) {
      if (!['EXDEV', 'ENOTSUP', 'ENOSYS', 'EPERM', 'EACCES', 'EMLINK', 'EINVAL']
        .includes(error?.code)) throw error;
    }
    if (hardLinksSupported) {
      for (const [source, exported] of [
        [sidecars.inputSnapshots[0].rawFile, report.inputSnapshots[0].rawFile],
        [sidecars.inputSnapshots[0].file, report.inputSnapshots[0].imageFile],
      ]) {
        const [sourceInfo, exportedInfo] = await Promise.all([
          stat(join(completed.outputDir, source)), stat(join(analysisDir, exported)),
        ]);
        assert.equal(exportedInfo.dev, sourceInfo.dev);
        assert.equal(exportedInfo.ino, sourceInfo.ino);
        assert.ok(exportedInfo.nlink >= 2);
      }
      await unlink(probeTarget);
    }
    await unlink(probeSource);
    const integrity = JSON.parse(await readFile(join(analysisDir,
      'analysis-integrity.json'), 'utf8'));
    assert.equal(integrity.files[report.inputSnapshots[0].rawFile].sha256,
      report.inputSnapshots[0].rawSha256);
    const independentExport = await analyzeCapture(completed.captureFile);
    const independentRaw = independentExport.report.inputSnapshots[0].rawFile;
    assert.notEqual((await stat(join(independentExport.outputDir, independentRaw))).ino,
      (await stat(join(completed.outputDir, sidecars.inputSnapshots[0].rawFile))).ino);

    const writerJob = await broker.request({ targetBootId: 'game-alias', frames: 1 });
    const writerBase = { jobId: writerJob.id, targetBootId: 'game-alias' };
    const writerCommands = [
      ...commands.slice(0, 4),
      { method: 'beginRenderPass', args: [{ label: 'write input',
        colorAttachments: [{ view: { __id: 4 }, loadOp: 'load', storeOp: 'store' }] }] },
      { method: 'draw', args: [3] }, { method: 'end' },
      ...commands.slice(4, 8), { method: 'submit' },
    ];
    const writerMetadata = Buffer.from(JSON.stringify({ schemaVersion: 1, objects,
      commands: writerCommands, payloadTable: [] }));
    const writerHeader = Buffer.from(`WGPUCAP 1 ${writerMetadata.length}\n`);
    const writerCapture = Buffer.concat([writerHeader, writerMetadata,
      Buffer.alloc((8 - ((writerHeader.length + writerMetadata.length) % 8)) % 8)]);
    for (const passOrdinal of [0, 1, 2]) {
      await broker.uploadPassRaw({ ...writerBase, passOrdinal, colorIndex: 0,
        format: 'rgba8unorm', width: 1, height: 1, bytesPerRow: 256,
        contentLength: raw.length, stream: Readable.from([raw]) });
    }
    await broker.uploadInputRaw({ ...writerBase, inputOrdinal: 0, format: 'rgba8unorm',
      width: 1, height: 1, bytesPerRow: 256, contentLength: raw.length,
      stream: Readable.from([raw]) });
    postDiagnostics(broker, { ...writerBase,
      passes: [passes[0], { ...passes[0], passOrdinal: 1, label: 'write input' },
        { ...passes[1], passOrdinal: 2 }],
      inputs: [inputs[0], { ...inputs[1], passOrdinal: 2 }],
      gpuPasses: [], gpuProfilerStatus: { state: 'disabled' } });
    await assert.rejects(broker.upload({ ...writerBase, actualFrames: 1,
      contentLength: writerCapture.length, stream: Readable.from([writerCapture]) }),
    /raw alias crosses an Inspector texture write/);
    assert.equal(broker.status(writerBase).state, 'failed');

    const rejectInterveningOperation = async intervening => {
      const blockedJob = await broker.request({ targetBootId: 'game-alias', frames: 1 });
      const blockedBase = { jobId: blockedJob.id, targetBootId: 'game-alias' };
      const blockedCommands = [...commands.slice(0, 4), ...intervening,
        ...commands.slice(4, 8), { method: 'submit' }];
      const blockedMetadata = Buffer.from(JSON.stringify({ schemaVersion: 1, objects,
        commands: blockedCommands, payloadTable: [] }));
      const blockedHeader = Buffer.from(`WGPUCAP 1 ${blockedMetadata.length}\n`);
      const blockedCapture = Buffer.concat([blockedHeader, blockedMetadata,
        Buffer.alloc((8 - ((blockedHeader.length + blockedMetadata.length) % 8)) % 8)]);
      for (const passOrdinal of [0, 1]) {
        await broker.uploadPassRaw({ ...blockedBase, passOrdinal, colorIndex: 0,
          format: 'rgba8unorm', width: 1, height: 1, bytesPerRow: 256,
          contentLength: raw.length, stream: Readable.from([raw]) });
      }
      await broker.uploadInputRaw({ ...blockedBase, inputOrdinal: 0, format: 'rgba8unorm',
        width: 1, height: 1, bytesPerRow: 256, contentLength: raw.length,
        stream: Readable.from([raw]) });
      postDiagnostics(broker, { ...blockedBase, passes, inputs,
        gpuPasses: [], gpuProfilerStatus: { state: 'disabled' } });
      await assert.rejects(broker.upload({ ...blockedBase, actualFrames: 1,
        contentLength: blockedCapture.length, stream: Readable.from([blockedCapture]) }),
      /raw alias crosses an Inspector texture write/);
    };
    await rejectInterveningOperation([{ method: 'copyTextureToTexture', args: [
      { texture: { __id: 1 } }, { texture: { __id: 3 } },
      { width: 1, height: 1, depthOrArrayLayers: 1 },
    ] }]);
    await rejectInterveningOperation([
      { method: 'beginComputePass', args: [{ label: 'potential storage write' }] },
      { method: 'dispatchWorkgroups', args: [1] }, { method: 'end' },
    ]);
  } finally {
    broker.close();
    if (oldOutput === undefined) delete process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR;
    else process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR = oldOutput;
    await rm(external, { recursive: true, force: true });
  }
});

test('multi-frame diagnostics attach every resource to its exact frame despite repeated Pass labels', async () => {
  // A logical game frame can submit offscreen work before the canvas. Explicit
  // boundaries must group it even when every frame repeats the same labels.
  const commands = Array.from({ length: 4 }, () => [
    { method: 'beginRenderPass', args: [{ label: 'repeated', colorAttachments: [] }] },
    { method: 'end', args: [] }, { method: 'submit', args: [] },
  ]).flat();
  const metadata = { objects: [], commands, payloadTable: [],
    gamedraftCapture: { version: 1, frameSubmissionCounts: [2, 2] } };
  const grouped = summarizeCapture({ metadata, payloads: [] });
  assert.deepEqual(grouped.passes.map(pass => pass.frameOrdinal), [1, 1, 2, 2]);
  assert.deepEqual(grouped.frames.map(frame => frame.boundaryConfidence), ['explicit', 'explicit']);
  assert.throws(() => summarizeCapture({ metadata: { ...metadata,
    gamedraftCapture: { version: 1, frameSubmissionCounts: [2, 1] } }, payloads: [] }),
  /frame submission boundaries/);
  const external = await mkdtemp(join(tmpdir(), 'gamedraft-selected-frame-'));
  const oldOutput = process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR;
  process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR = external;
  const broker = createWebGpuCaptureController(resolve('.'));
  try {
    const label = 'scene / frame-debug draw 1/1';
    const objects = [
      { id: 1, type: 'Texture', width: 1, height: 1, format: 'rgba8unorm' },
      { id: 2, type: 'TextureView', texture: { __id: 1 } },
      { id: 3, type: 'Texture', width: 1, height: 1, format: 'rgba8unorm' },
      { id: 4, type: 'TextureView', texture: { __id: 3 } },
      { id: 5, type: 'Buffer', size: 16 },
      { id: 6, type: 'BindGroup', descriptor: { entries: [
        { binding: 0, resource: { __id: 4 } },
        { binding: 1, resource: { buffer: { __id: 5 }, offset: 0, size: 16 } },
      ] } },
    ];
    const commands = Array.from({ length: 2 }, () => [
      { method: 'beginRenderPass', args: [{ label,
        colorAttachments: [{ view: { __id: 2 }, loadOp: 'load', storeOp: 'store' }] }] },
      { method: 'setBindGroup', args: [0, { __id: 6 }] },
      { method: 'draw', args: [3] }, { method: 'end' }, { method: 'submit' },
    ]).flat();
    const metadata = Buffer.from(JSON.stringify({ schemaVersion: 1, objects, commands,
      payloadTable: [] }));
    const header = Buffer.from(`WGPUCAP 1 ${metadata.length}\n`);
    const capture = Buffer.concat([header, metadata,
      Buffer.alloc((8 - ((header.length + metadata.length) % 8)) % 8)]);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlMysAAAAAASUVORK5CYII=', 'base64');
    const rawInput = Buffer.alloc(256, 7);
    const rawBuffer = Buffer.alloc(16, 9);
    broker.register({ targetBootId: 'game-selected', captureReady: true });
    await assert.rejects(broker.request({ targetBootId: 'game-selected', frames: 2,
      detailedFrameIndex: 3 }), /detailedFrameIndex/);
    const job = await broker.request({ targetBootId: 'game-selected', frames: 2,
      detailedFrameIndex: 2 });
    assert.equal(job.detailedFrameIndex, 2);
    assert.equal(broker.poll({ targetBootId: 'game-selected' }).detailedFrameIndex, 2);
    const base = { jobId: job.id, targetBootId: 'game-selected' };
    for (const frameIndex of [1, 2]) {
      await broker.uploadFrameImage({ ...base, frameIndex,
        contentLength: png.length, stream: Readable.from([png]) });
    }
    await assert.rejects(broker.uploadPassImage({ ...base, passOrdinal: 0, colorIndex: 0,
      contentLength: png.length, stream: Readable.from([png]) }), /frameIndex/);
    for (const frameIndex of [1, 2]) {
      await broker.uploadPassImage({ ...base, frameIndex, passOrdinal: 0, colorIndex: 0,
        contentLength: png.length, stream: Readable.from([png]) });
      await broker.uploadPassRaw({ ...base, frameIndex, passOrdinal: 0, colorIndex: 0,
        format: 'rgba8unorm', width: 1, height: 1, bytesPerRow: 256,
        contentLength: 256, stream: Readable.from([rawInput]) });
      await broker.uploadInputRaw({ ...base, frameIndex, inputOrdinal: 0,
        format: 'rgba8unorm', width: 1, height: 1, bytesPerRow: 256,
        contentLength: 256, stream: Readable.from([rawInput]) });
      await broker.uploadBufferRaw({ ...base, frameIndex, bufferOrdinal: 0,
        contentLength: 16, stream: Readable.from([rawBuffer]) });
      await broker.uploadResourceTextureImage({ ...base, frameIndex, resourceOrdinal: 0,
        contentLength: png.length, stream: Readable.from([png]) });
      await broker.uploadResourceTextureRaw({ ...base, frameIndex, resourceOrdinal: 0,
        format: 'rgba8unorm', width: 1, height: 1, bytesPerRow: 256,
        contentLength: 256, stream: Readable.from([rawInput]) });
      await broker.uploadResourceBufferRaw({ ...base, frameIndex, resourceOrdinal: 0,
        contentLength: 16, stream: Readable.from([rawBuffer]) });
    }
    await assert.rejects(broker.uploadPassImage({ ...base, frameIndex: 2,
      passOrdinal: 0, colorIndex: 0, contentLength: png.length,
      stream: Readable.from([png]) }), /already uploaded/);
    const detail = { ...base, passes: [{ passOrdinal: 0, colorIndex: 0,
      label, targetLabel: 'screen', width: 1, height: 1, format: 'rgba8unorm',
      rawBytesPerRow: 256, rawByteLength: 256 }],
    inputs: [{ inputOrdinal: 0, passOrdinal: 0, bindingName: 'uInput',
      groupSlot: 0, binding: 0, textureId: 3, viewId: 4, mipLevel: 0, arrayLayer: 0,
      width: 1, height: 1, format: 'rgba8unorm', rawBytesPerRow: 256, rawByteLength: 256 }],
    buffers: [{ bufferOrdinal: 0, passOrdinal: 0, role: 'uniform', bindingName: 'uGlobals',
      groupSlot: 0, binding: 1, bufferId: 5, bufferLabel: 'globals', totalSize: 16,
      offset: 0, size: 16, copiedOffset: 0, copiedSize: 16,
      rangeScope: 'binding', rawByteLength: 16 }],
    gpuPasses: [{ ordinal: 0, kind: 'render', label, durationMs: 1.25 }],
    gpuProfilerStatus: { state: 'enabled' },
    resourceInventory: { textureCount: 1, textureSubresourceCount: 1, bufferCount: 1 },
    resourceTextures: [{ resourceOrdinal: 0, textureOrdinal: 0, textureId: 1,
      label: 'screen', width: 1, height: 1, sourceFormat: 'rgba8unorm',
      rawFormat: 'rgba8unorm', mipLevel: 0, arrayLayer: 0, aspect: 'color',
      sampleCount: 1, captureMoment: 'frame-end', rawBytesPerRow: 256,
      rawByteLength: 256 }],
    resourceBuffers: [{ resourceOrdinal: 0, bufferId: 5, label: 'globals',
      totalSize: 16, copiedOffset: 0, copiedSize: 16, captureMoment: 'frame-end',
      rawByteLength: 16 }] };
    postDiagnostics(broker, { ...detail, frameIndex: 1 });
    await assert.rejects(broker.upload({ ...base, actualFrames: 2,
      contentLength: capture.length, stream: Readable.from([capture]) }),
    /frame 2 diagnostics/);
    postDiagnostics(broker, { ...detail, frameIndex: 2 });
    assert.throws(() => postDiagnostics(broker, { ...detail, frameIndex: 1 }),
      /already uploaded/);
    const completed = await broker.upload({ ...base, actualFrames: 2,
      contentLength: capture.length, stream: Readable.from([capture]) });
    assert.equal(completed.state, 'completed');
    const sidecarsPath = join(completed.outputDir, 'sidecars.json');
    const sidecars = JSON.parse(await readFile(sidecarsPath, 'utf8'));
    assert.equal(sidecars.detailedFrameIndex, 2);
    assert.equal(sidecars.diagnosticFrameOrdinal, 2);
    assert.deepEqual(sidecars.diagnosticFrames.map(item => [item.frameIndex, item.frameOrdinal]),
      [[1, 1], [2, 2]]);
    assert.deepEqual(sidecars.frames.map(item => [item.frameIndex, item.frameOrdinal]),
      [[1, 1], [2, 2]]);
    assert.deepEqual(sidecars.passSnapshots.map(item => item.frameOrdinal), [1, 2]);
    assert.deepEqual(sidecars.inputSnapshots.map(item => item.frameOrdinal), [1, 2]);
    assert.deepEqual(sidecars.bufferSnapshots.map(item => item.frameOrdinal), [1, 2]);
    assert.deepEqual(sidecars.gpuTimings.map(item => item.frameOrdinal), [1, 2]);
    assert.deepEqual(sidecars.resourceTextureSnapshots.map(item => item.frameOrdinal), [1, 2]);
    assert.deepEqual(sidecars.resourceBufferSnapshots.map(item => item.frameOrdinal), [1, 2]);
    assert.notEqual(sidecars.passSnapshots[0].file, sidecars.passSnapshots[1].file);
    assert.notEqual(sidecars.inputSnapshots[0].rawFile, sidecars.inputSnapshots[1].rawFile);
    assert.notEqual(sidecars.bufferSnapshots[0].rawFile, sidecars.bufferSnapshots[1].rawFile);
    assert.notEqual(sidecars.resourceTextureSnapshots[0].rawFile,
      sidecars.resourceTextureSnapshots[1].rawFile);
    assert.notEqual(sidecars.resourceBufferSnapshots[0].rawFile,
      sidecars.resourceBufferSnapshots[1].rawFile);
    const report = JSON.parse(await readFile(await broker.viewerFile({
      jobId: job.id, file: 'report.json' }), 'utf8'));
    assert.equal(report.passes[0].inputSnapshots?.[0]?.captureMoment, 'pre-draw');
    assert.equal(report.passes[0].bufferSnapshots?.[0]?.captureMoment, 'pre-draw');
    assert.equal(report.passes[1].inputSnapshots?.[0]?.captureMoment, 'pre-draw');
    assert.equal(report.passes[1].bufferSnapshots?.[0]?.captureMoment, 'pre-draw');
    assert.equal(report.passes[1].snapshots?.[0]?.captureMoment, 'post-draw');
    assert.equal(report.resources.textures.find(item => item.id === 1).frameEndSnapshots.length, 2);
    assert.equal(report.resources.buffers.find(item => item.id === 5).frameEndSnapshots.length, 2);
    assert.ok(report.frames[0].imageFile);
    assert.ok(report.frames[1].imageFile);

    sidecars.inputSnapshots[0].frameOrdinal = 2;
    await writeFile(sidecarsPath, JSON.stringify(sidecars));
    const badFrameDir = join(external, 'bad-frame');
    await mkdir(badFrameDir);
    const badFrame = await attachFrameSidecars(completed.captureFile, badFrameDir,
      report.frames, report.passes, report.events, report.resources);
    assert.equal(badFrame.inputSnapshots.length, 1);
    assert.equal(badFrame.passSnapshots.length, 2);
    assert.match(badFrame.errors[0].reason, /does not belong to frame/);

    sidecars.inputSnapshots[0].frameOrdinal = 2;
    await writeFile(sidecarsPath, JSON.stringify(sidecars));
    const passFile = join(completed.outputDir, sidecars.passSnapshots[0].file);
    const changedPng = Buffer.from(png);
    changedPng[changedPng.length - 1] ^= 1;
    await writeFile(passFile, changedPng);
    const badHashDir = join(external, 'bad-pass-hash');
    await mkdir(badHashDir);
    const badHash = await attachFrameSidecars(completed.captureFile, badHashDir,
      report.frames, report.passes, report.events, report.resources);
    assert.equal(badHash.passSnapshots.length, 2);
    assert.ok(badHash.errors.some(item => /PNG SHA-256 differs/.test(item.reason)));
    sidecars.inputSnapshots[0].frameOrdinal = 1;
    await writeFile(sidecarsPath, JSON.stringify(sidecars));
    const pngOptional = await analyzeCapture(completed.captureFile);
    assert.ok(pngOptional.report.sidecarErrors.some(item => /PNG SHA-256 differs/.test(item.reason)));
    assert.equal(pngOptional.report.passSnapshots.filter(item => item.rawFile).length, 2);
  } finally {
    broker.close();
    if (oldOutput === undefined) delete process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR;
    else process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR = oldOutput;
    await rm(external, { recursive: true, force: true });
  }
});
