import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { createWebGpuCaptureController } from './server.mjs';

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
