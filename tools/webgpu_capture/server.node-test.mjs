import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, realpath, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { createWebGpuCaptureController } from './server.mjs';
import { attachFrameSidecars } from './analysis_sidecars.mjs';
import { summarizeCapture } from './analyze.mjs';

function sampleCapture() {
  const metadata = Buffer.from(JSON.stringify({
    schemaVersion: 1, objects: [], commands: [{ type: 'draw' }], payloadTable: [[0, 3]],
  }));
  const header = Buffer.from(`WGPUCAP 1 ${metadata.length}\n`);
  const padding = Buffer.alloc((8 - ((header.length + metadata.length) % 8)) % 8, 10);
  return Buffer.concat([header, metadata, padding, Buffer.from([1, 2, 3]), Buffer.alloc(5)]);
}

test('stores a checked capture outside the worktree for its exact game bootId', async () => {
  const external = await mkdtemp(join(tmpdir(), 'gamedraft-webgpu-capture-'));
  const oldOutput = process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR;
  process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR = external;
  const broker = createWebGpuCaptureController(resolve('.'));
  try {
    broker.register({ targetBootId: 'game-a', url: 'http://127.0.0.1:5216/', captureReady: true });
    assert.equal(broker.list()[0].targetBootId, 'game-a');
    const pending = await broker.request({ frames: 2 });
    assert.equal(pending.state, 'pending');
    await assert.rejects(broker.request({ targetBootId: 'game-a' }), /already active/);
    assert.equal(broker.poll({ targetBootId: 'game-b' }), null);
    assert.equal(broker.poll({ targetBootId: 'game-a' }).state, 'capturing');
    const capture = sampleCapture();
    await assert.rejects(broker.upload({
      jobId: pending.id, targetBootId: 'game-b', stream: Readable.from([capture]), actualFrames: 2,
    }), /not found/);
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
    assert.equal(manifest.commandCount, 1);
    assert.equal(manifest.payloadCount, 1);
  } finally {
    broker.close();
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

test('bounds raw Pass uploads at 512 MiB and accepts a verified raw-only output', async () => {
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
    await assert.rejects(broker.uploadPassRaw({ ...base, height: 2049,
      contentLength: 262144 * 2049, stream: Readable.from([]) }), /byte length exceeds the limit/);
    // This exact boundary reaches the stream-length check; it is not rejected as over budget.
    await assert.rejects(broker.uploadPassRaw({ ...base, height: 2048,
      contentLength: 512 * 1024 * 1024, stream: Readable.from([]) }), /length differs from dimensions/);
    const saved = await broker.uploadPassRaw({ ...base, format: 'rgba8unorm',
      width: 1, height: 1, bytesPerRow: 256, contentLength: 256,
      stream: Readable.from([Buffer.alloc(256, 7)]) });
    assert.equal(saved.bytes, 256);
    const detail = broker.diagnostics({ jobId: job.id, targetBootId: 'game-raw',
      passes: [{ passOrdinal: 0, colorIndex: 0, label: 'draw 0', targetLabel: 'screen',
        width: 1, height: 1, format: 'rgba8unorm', rawBytesPerRow: 256, rawByteLength: 256 }],
      gpuPasses: [], gpuProfilerStatus: { state: 'disabled' } });
    assert.equal(detail.passRecords, 1);
  } finally {
    broker.close();
    if (oldOutput === undefined) delete process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR;
    else process.env.GAMEDRAFT_WEBGPU_CAPTURE_DIR = oldOutput;
    await rm(external, { recursive: true, force: true });
  }
});

test('reports every color output beyond the 512-record readback cap as unavailable', async () => {
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
    broker.diagnostics({ jobId: job.id, targetBootId: 'game-cap', passes,
      gpuPasses: [], gpuProfilerStatus: { state: 'disabled' },
      warning: '1 color output exceeds the 512-record readback cap' });
    const completed = await broker.upload({ jobId: job.id, targetBootId: 'game-cap',
      stream: Readable.from([capture]), actualFrames: 1, contentLength: capture.length });
    assert.equal(completed.state, 'completed');
    const sidecars = JSON.parse(await readFile(join(completed.outputDir, 'sidecars.json'), 'utf8'));
    assert.equal(sidecars.passUnavailable.length, 513);
    assert.equal(sidecars.passUnavailable.at(-1).passIndex, 512);
    assert.match(sidecars.passUnavailable.at(-1).reason, /512 color outputs/);
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
    ];
    const begin = label => ({ method: 'beginRenderPass', args: [{ label,
      colorAttachments: [{ view: { __id: 2 }, loadOp: 'load', storeOp: 'store' }] }] });
    const commands = [
      begin('canvas / test / frame-debug draw 1/2'), { method: 'draw', args: [3] }, { method: 'end' },
      begin('canvas / test / frame-debug draw 2/2'), { method: 'drawIndexed', args: [6] }, { method: 'end' },
      begin('canvas / ordinary'), { method: 'draw', args: [3] }, { method: 'draw', args: [3] }, { method: 'end' },
      begin('canvas / incomplete / frame-debug draw 1/2'), { method: 'draw', args: [3] }, { method: 'end' },
      { method: 'submit' },
    ];
    const report = summarizeCapture({ metadata: { objects, commands, payloadTable: [] },
      payloads: [], captureFile: join(external, 'capture.wgpuc'), size: 0 });
    const { passes, frames, events } = report;
    assert.equal(passes.length, 4);
    assert.deepEqual(passes.slice(0, 2).map(pass => pass.frameDebugStep?.drawCommandIndex), [1, 4]);
    assert.deepEqual(passes.slice(0, 2).map(pass => pass.frameDebugStep?.drawOrdinal), [1, 2]);
    assert.equal(passes[2].frameDebugStep, undefined);
    assert.equal(passes[3].frameDebugStep, undefined);
    assert.equal(events[1].method, 'draw');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlMysAAAAAASUVORK5CYII=', 'base64');
    await writeFile(join(external, 'pixel.png'), png);
    const snapshots = passes.map(pass => ({ frameOrdinal: 1, passIndex: pass.index,
      afterCommandIndex: pass.endCommand, textureId: 1, colorIndex: 0,
      format: 'rgba8unorm', width: 1, height: 1, file: 'pixel.png' }));
    await writeFile(join(external, 'sidecars.json'), JSON.stringify({ schemaVersion: 1,
      frames: [], passSnapshots: snapshots, passUnavailable: [], gpuTimings: [] }));
    const attached = await attachFrameSidecars(join(external, 'capture.wgpuc'), output, frames, passes);
    assert.deepEqual(attached.errors, []);
    assert.deepEqual(attached.passSnapshots.map(item => item.captureMoment),
      ['post-draw', 'post-draw', 'pass-end', 'pass-end']);
    assert.deepEqual(attached.passSnapshots.map(item => item.drawCommandIndex), [1, 4, undefined, undefined]);
  } finally {
    await rm(external, { recursive: true, force: true });
  }
});
