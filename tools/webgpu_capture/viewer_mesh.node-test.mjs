import test from 'node:test';
import assert from 'node:assert/strict';
import './viewer_mesh.js';

const inspector = globalThis.GameDraftMeshInspector;

function fixture({ indexed = true, firstIndex = 0, baseVertex = 0,
  vertexOffset = 0, attributeOffset = 0, stride = 8,
  positions = [[0, 0], [1, 0], [1, 1], [0, 1]],
  indices = [0, 1, 2, 0, 2, 3], topology = 'triangle-list' } = {}) {
  const vertexBytes = new Uint8Array(stride * positions.length);
  const vertexView = new DataView(vertexBytes.buffer);
  for (let index = 0; index < positions.length; index++) {
    vertexView.setFloat32(index * stride + attributeOffset, positions[index][0], true);
    vertexView.setFloat32(index * stride + attributeOffset + 4, positions[index][1], true);
  }
  const indexBytes = new Uint8Array(Math.ceil(indices.length * 2 / 4) * 4);
  const indexView = new DataView(indexBytes.buffer);
  indices.forEach((value, index) => indexView.setUint16(index * 2, value, true));
  const count = indexed ? indices.length - firstIndex : positions.length;
  const indexOffset = firstIndex * 2;
  const indexCopiedOffset = Math.floor(indexOffset / 4) * 4;
  const indexCopiedSize = Math.ceil((indexOffset + count * 2) / 4) * 4 - indexCopiedOffset;
  const event = { method: indexed ? 'drawIndexed' : 'draw',
    args: indexed ? [count, 1, firstIndex, baseVertex, 0] : [count, 1, 0, 0],
    commandIndex: 51, passIndex: 7, frameOrdinal: 1,
    vertexBuffers: [{ slot: 0, id: 10, offset: vertexOffset, size: vertexBytes.length }],
    ...(indexed ? { indexBuffer: { id: 11, offset: 0, size: indexBytes.length, format: 'uint16' } } : {}),
  };
  const pipeline = { descriptor: { primitive: { topology }, vertex: { buffers: [{
    arrayStride: stride, stepMode: 'vertex',
    attributes: [{ shaderLocation: 1, offset: attributeOffset, format: 'float32x2' }],
  }] } } };
  const vertexSnapshot = { bufferOrdinal: 1, role: 'vertex', vertexSlot: 0, bufferId: 10,
    offset: vertexOffset, size: vertexBytes.length, totalSize: vertexOffset + vertexBytes.length,
    copiedOffset: vertexOffset, copiedSize: vertexBytes.length,
    rawByteLength: vertexBytes.length, rawFile: 'vertex.bin', captureMoment: 'pre-draw',
    drawCommandIndex: 51, passIndex: 7, frameOrdinal: 1 };
  const snapshots = [vertexSnapshot];
  const bytesByOrdinal = new Map([[1, vertexBytes]]);
  if (indexed) {
    snapshots.push({ bufferOrdinal: 2, role: 'index', bufferId: 11, indexFormat: 'uint16',
      offset: indexOffset, size: count * 2, totalSize: indexBytes.length,
      copiedOffset: indexCopiedOffset, copiedSize: indexCopiedSize,
      rawByteLength: indexCopiedSize, rawFile: 'index.bin', captureMoment: 'pre-draw',
      drawCommandIndex: 51, passIndex: 7, frameOrdinal: 1 });
    bytesByOrdinal.set(2, indexBytes.subarray(indexCopiedOffset, indexCopiedOffset + indexCopiedSize));
  }
  const pass = { type: 'render', draws: 1, index: 7, frameOrdinal: 1,
    frameDebugStep: { drawCommandIndex: 51 }, bufferSnapshots: snapshots };
  return { event, pipeline, pass, positionLocation: 1, bytesByOrdinal };
}

test('indexed quad uses exact pre-Draw bytes and produces two input-space triangles', () => {
  const result = inspector.decodeDraw(fixture());
  assert.equal(result.status, 'ok');
  assert.equal(result.primitives.length, 2);
  assert.deepEqual(result.primitives.map(value => value.corners), [[0, 1, 2], [3, 4, 5]]);
  assert.deepEqual(result.rows.map(value => value.vertexIndex), [0, 1, 2, 0, 2, 3]);
  assert.deepEqual(result.bounds, { minX: 0, maxX: 1, minY: 0, maxY: 1 });
  assert.deepEqual([result.rows[5].x, result.rows[5].y], [0, 1]);
});

test('firstIndex, baseVertex, binding offset and attribute offset target exact bytes', () => {
  const input = fixture({ firstIndex: 2, baseVertex: -1,
    vertexOffset: 12, attributeOffset: 4, stride: 12,
    positions: [[10, 20], [30, 40], [50, 60]], indices: [99, 99, 1, 2, 3] });
  const result = inspector.decodeDraw(input);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.rows.map(value => value.sourceIndex), [1, 2, 3]);
  assert.deepEqual(result.rows.map(value => value.vertexIndex), [0, 1, 2]);
  assert.deepEqual(result.rows.map(value => value.byteOffset), [16, 28, 40]);
  assert.deepEqual(result.rows.map(value => [value.x, value.y]), [[10, 20], [30, 40], [50, 60]]);
});

test('nonindexed firstVertex uses firstVertex instead of treating it as a byte offset', () => {
  const input = fixture({ indexed: false, positions: [[99, 99], [0, 0], [1, 0], [0, 1]] });
  input.event.args = [3, 1, 1, 0];
  const result = inspector.decodeDraw(input);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.rows.map(value => value.vertexIndex), [1, 2, 3]);
  assert.deepEqual(result.bounds, { minX: 0, maxX: 1, minY: 0, maxY: 1 });
});

test('unproven or missing pre-Draw bytes never produce a wireframe', () => {
  const input = fixture();
  input.pass.bufferSnapshots[0].captureMoment = 'pass-end';
  assert.match(inspector.decodeDraw(input).reason, /Draw 前字节快照/);
  input.pass.bufferSnapshots[0].captureMoment = 'pre-draw';
  input.bytesByOrdinal.delete(1);
  assert.match(inspector.decodeDraw(input).reason, /\.bin 不可用/);
  input.pass.frameDebugStep.drawCommandIndex = 52;
  assert.match(inspector.decodeDraw(input).reason, /单 Draw 物理 Pass/);
});

test('unsupported topology and vertex_index-generated geometry are explicit', () => {
  const input = fixture({ topology: 'point-list' });
  assert.match(inspector.decodeDraw(input).reason, /暂不支持 point-list/);
  input.pipeline.descriptor.primitive.topology = 'triangle-list';
  input.pipeline.descriptor.vertex.buffers = [];
  assert.match(inspector.decodeDraw(input).reason, /vertex_index/);
});
