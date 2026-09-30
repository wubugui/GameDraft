import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdtemp, realpath, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { createWebGpuCaptureController } from './server.mjs';
import { attachFrameSidecars, verifiedInputBinding } from './analysis_sidecars.mjs';
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
    await assert.rejects(broker.uploadInputRaw({ jobId: job.id, targetBootId: 'game-raw',
      inputOrdinal: 1024, format: 'rg16float', width: 1, height: 1,
      bytesPerRow: 256, contentLength: 256, stream: Readable.from([]) }), /valid ordinal/);
    const input = await broker.uploadInputRaw({ jobId: job.id, targetBootId: 'game-raw',
      inputOrdinal: 0, format: 'rg16float', width: 1, height: 1,
      bytesPerRow: 256, contentLength: 256,
      stream: Readable.from([Buffer.alloc(256, 9)]) });
    assert.equal(input.inputOrdinal, 0);
    assert.equal(input.bytes, 256);
    const detail = broker.diagnostics({ jobId: job.id, targetBootId: 'game-raw',
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
      broker.diagnostics({ jobId: job.id, targetBootId: 'game-input',
        passes: [{ passOrdinal: 0, colorIndex: 0, label: passes[0].label,
          targetLabel: 'screen', width: 1, height: 1, format: 'rgba8unorm',
          reason: 'output omitted in input fixture' }],
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
    assert.equal(broker.diagnostics({ ...base, passes: [], aspects,
      gpuPasses: [], gpuProfilerStatus: { state: 'disabled' } }).aspectRecords, 2);
    const completed = await broker.upload({ ...base, actualFrames: 1,
      contentLength: capture.length, stream: Readable.from([capture]) });
    assert.equal(completed.state, 'completed');
    const sidecars = JSON.parse(await readFile(join(completed.outputDir, 'sidecars.json'), 'utf8'));
    assert.equal(sidecars.aspectSnapshots.length, 2);
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
    broker.diagnostics({ ...base, passes: [0, 1].map(passOrdinal => ({ passOrdinal,
      colorIndex: 0, label: `scene / frame-debug draw ${passOrdinal + 1}/2`,
      targetLabel: 'screen', width: 1, height: 1, format: 'rgba8unorm',
      reason: 'color omitted in fixture' })),
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
    await assert.rejects(broker.uploadBufferRaw({ ...base, bufferOrdinal: 1024,
      contentLength: 8, stream: Readable.from([bytes[2]]) }), /valid buffer ordinal/);
    for (const [bufferOrdinal, raw] of bytes.entries()) {
      await broker.uploadBufferRaw({ ...base, bufferOrdinal,
        contentLength: raw.length, stream: Readable.from([raw]) });
    }
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
    broker.diagnostics({ ...base, passes: [{ passOrdinal: 0, colorIndex: 0,
      label: 'scene / frame-debug draw 1/1', targetLabel: 'screen',
      width: 1, height: 1, format: 'rgba8unorm', reason: 'color omitted in fixture' }],
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
    assert.ok(await broker.viewerFile({ jobId: job.id,
      file: analyzed.passes[0].bufferSnapshots[2].rawFile }));

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
