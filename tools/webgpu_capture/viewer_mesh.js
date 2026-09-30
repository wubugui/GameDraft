// Pre-vertex-shader input inspection. This does not execute the vertex shader
// and must never be described as clip space, screen space, or post-VS geometry.
(function (root) {
  'use strict';

  const MAX_DRAW_VERTICES = 50000;
  const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
  const TABLE_ROWS = 400;
  const SUPPORTED_TOPOLOGIES = new Set([
    'triangle-list', 'triangle-strip', 'line-list', 'line-strip',
  ]);

  const unavailable = reason => ({ status: 'unavailable', reason });
  const safeInteger = value => Number.isSafeInteger(value) && value >= 0;
  const list = value => Array.isArray(value) ? value : [];
  const asBytes = value => value instanceof Uint8Array ? value : null;

  function formatInfo(format) {
    const match = /^(float32|float16|uint32|sint32|uint16|sint16|unorm16|snorm16|uint8|sint8|unorm8|snorm8)x([234])$/.exec(format || '');
    if (!match) return null;
    const componentBytes = /32$/.test(match[1]) ? 4 : /16$/.test(match[1]) ? 2 : 1;
    return { kind: match[1], count: Number(match[2]), componentBytes,
      byteLength: Number(match[2]) * componentBytes };
  }

  function halfToFloat(bits) {
    const sign = bits & 0x8000 ? -1 : 1;
    const exponent = (bits >> 10) & 31;
    const fraction = bits & 1023;
    if (exponent === 31) return fraction ? NaN : sign * Infinity;
    if (exponent === 0) return sign * fraction * 2 ** -24;
    return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
  }

  function readAttribute(bytes, offset, format) {
    const info = formatInfo(format);
    if (!info || !safeInteger(offset) || offset + info.byteLength > bytes.length) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, info.byteLength);
    const values = [];
    for (let component = 0; component < info.count; component++) {
      const pos = component * info.componentBytes;
      const kind = info.kind;
      let value;
      if (kind === 'float32') value = view.getFloat32(pos, true);
      else if (kind === 'float16') value = halfToFloat(view.getUint16(pos, true));
      else if (kind === 'uint32') value = view.getUint32(pos, true);
      else if (kind === 'sint32') value = view.getInt32(pos, true);
      else if (kind === 'uint16') value = view.getUint16(pos, true);
      else if (kind === 'sint16') value = view.getInt16(pos, true);
      else if (kind === 'uint8') value = view.getUint8(pos);
      else if (kind === 'sint8') value = view.getInt8(pos);
      else if (kind === 'unorm16') value = view.getUint16(pos, true) / 65535;
      else if (kind === 'unorm8') value = view.getUint8(pos) / 255;
      else if (kind === 'snorm16') value = Math.max(-1, view.getInt16(pos, true) / 32767);
      else value = Math.max(-1, view.getInt8(pos) / 127);
      values.push(value);
    }
    return values;
  }

  function positionAttributes(event, pipeline) {
    const buffers = list(pipeline?.descriptor?.vertex?.buffers);
    const candidates = [];
    for (let slot = 0; slot < buffers.length; slot++) {
      const layout = buffers[slot];
      if (!layout || (layout.stepMode || 'vertex') !== 'vertex' ||
          !safeInteger(layout.arrayStride) || layout.arrayStride < 1) continue;
      for (const attribute of list(layout.attributes)) {
        const info = formatInfo(attribute?.format);
        if (!safeInteger(attribute?.shaderLocation) || !safeInteger(attribute?.offset) ||
            !info || info.count < 2 || attribute.offset + info.byteLength > layout.arrayStride) continue;
        candidates.push({ shaderLocation: attribute.shaderLocation, slot,
          format: attribute.format, offset: attribute.offset,
          stride: layout.arrayStride,
          bufferId: list(event?.vertexBuffers).find(item => item.slot === slot)?.id ?? null });
      }
    }
    return candidates.sort((a, b) => a.shaderLocation - b.shaderLocation);
  }

  function recommendedLocation(candidates) {
    const byLikelyPosition = [...candidates].sort((a, b) => {
      const rank = item => item.format.startsWith('float32') ? 0 :
        item.format.startsWith('float16') ? 1 : 2;
      return rank(a) - rank(b) || a.offset - b.offset || a.shaderLocation - b.shaderLocation;
    });
    return byLikelyPosition[0]?.shaderLocation ?? null;
  }

  function exactSnapshot(pass, event, role, slot) {
    if (!pass?.frameDebugStep || pass.type !== 'render' || pass.draws !== 1 ||
        pass.frameDebugStep.drawCommandIndex !== event.commandIndex ||
        pass.index !== event.passIndex || pass.frameOrdinal !== event.frameOrdinal) return null;
    return list(pass.bufferSnapshots).find(item => item.captureMoment === 'pre-draw' &&
      item.drawCommandIndex === event.commandIndex && item.passIndex === pass.index &&
      item.frameOrdinal === pass.frameOrdinal && item.role === role &&
      (role !== 'vertex' || item.vertexSlot === slot)) || null;
  }

  function snapshotBytes(snapshot, bytesByOrdinal) {
    const bytes = asBytes(bytesByOrdinal instanceof Map ?
      bytesByOrdinal.get(snapshot?.bufferOrdinal) : bytesByOrdinal?.[snapshot?.bufferOrdinal]);
    if (!snapshot || !snapshot.rawFile || !safeInteger(snapshot.rawByteLength) ||
        snapshot.rawByteLength < 1 || snapshot.rawByteLength > MAX_SNAPSHOT_BYTES ||
        !bytes || bytes.length !== snapshot.rawByteLength ||
        snapshot.copiedSize !== bytes.length || !safeInteger(snapshot.copiedOffset)) return null;
    return bytes;
  }

  function readBoundAttribute(event, pass, bytesByOrdinal, slot, attribute, vertexIndex) {
    const binding = list(event.vertexBuffers).find(item => item.slot === slot);
    const layout = pipelineVertexBuffer(attribute.pipeline, slot);
    const snapshot = exactSnapshot(pass, event, 'vertex', slot);
    const bytes = snapshotBytes(snapshot, bytesByOrdinal);
    const info = formatInfo(attribute.format);
    if (!binding || !layout || !snapshot || !bytes || !info ||
        binding.id !== snapshot.bufferId || binding.offset !== snapshot.offset ||
        !safeInteger(binding.offset) || !safeInteger(vertexIndex) ||
        !safeInteger(layout.arrayStride) || !safeInteger(attribute.offset)) return null;
    const absolute = binding.offset + vertexIndex * layout.arrayStride + attribute.offset;
    const bindingEnd = Number.isSafeInteger(binding.size) ? binding.offset + binding.size : snapshot.totalSize;
    if (!safeInteger(absolute) || absolute + info.byteLength > bindingEnd ||
        absolute < snapshot.offset || absolute + info.byteLength > snapshot.offset + snapshot.size ||
        absolute < snapshot.copiedOffset ||
        absolute + info.byteLength > snapshot.copiedOffset + bytes.length) return null;
    const values = readAttribute(bytes, absolute - snapshot.copiedOffset, attribute.format);
    return values ? { values, absolute } : null;
  }

  function pipelineVertexBuffer(pipeline, slot) {
    return list(pipeline?.descriptor?.vertex?.buffers)[slot] || null;
  }

  function primitivesFor(topology, points) {
    const primitives = [];
    const run = [];
    const emitRun = () => {
      if (topology === 'triangle-list') {
        for (let i = 0; i + 2 < run.length; i += 3)
          primitives.push({ kind: 'triangle', corners: [run[i], run[i + 1], run[i + 2]] });
      } else if (topology === 'line-list') {
        for (let i = 0; i + 1 < run.length; i += 2)
          primitives.push({ kind: 'line', corners: [run[i], run[i + 1]] });
      } else if (topology === 'triangle-strip') {
        for (let i = 0; i + 2 < run.length; i++)
          primitives.push({ kind: 'triangle', corners: [run[i], run[i + 1], run[i + 2]] });
      } else {
        for (let i = 0; i + 1 < run.length; i++)
          primitives.push({ kind: 'line', corners: [run[i], run[i + 1]] });
      }
      run.length = 0;
    };
    for (let i = 0; i < points.length; i++) {
      if (points[i] === null) emitRun();
      else run.push(i);
    }
    emitRun();
    return primitives;
  }

  function decodeDraw({ event, pipeline, pass, positionLocation, bytesByOrdinal }) {
    if (!event || !['draw', 'drawIndexed'].includes(event.method))
      return unavailable('只支持参数已知的 draw / drawIndexed；Indirect Draw 的顶点数量无法从此报告核实。');
    if (!pass?.frameDebugStep || pass.frameDebugStep.drawCommandIndex !== event.commandIndex ||
        pass.frameOrdinal !== event.frameOrdinal || pass.index !== event.passIndex)
      return unavailable('所选 Draw 没有可核实的单 Draw 物理 Pass；无法证明 Buffer 是当时的输入。');
    const topology = pipeline?.descriptor?.primitive?.topology || 'triangle-list';
    if (!SUPPORTED_TOPOLOGIES.has(topology)) return unavailable(`暂不支持 ${topology} 的线框重建。`);
    const candidates = positionAttributes(event, pipeline);
    if (!candidates.length) return unavailable('管线没有可解码的二维顶点属性；几何可能由 vertex_index 在 Shader 中生成。');
    const selectedLocation = positionLocation == null ? recommendedLocation(candidates) : Number(positionLocation);
    const position = candidates.find(item => item.shaderLocation === selectedLocation);
    if (!position) return unavailable(`shaderLocation ${positionLocation} 不在可解码的逐顶点属性中。`);
    const args = list(event.args);
    const count = args[0];
    const instanceCount = args[1];
    if (!safeInteger(count) || count < 1 || count > MAX_DRAW_VERTICES ||
        !safeInteger(instanceCount) || instanceCount < 1)
      return unavailable(`Draw 顶点/索引数无效或超过 ${MAX_DRAW_VERTICES} 项上限，或实例数为 0。`);
    const indexed = event.method === 'drawIndexed';
    const firstVertex = indexed ? 0 : args[2];
    const firstIndex = indexed ? args[2] : 0;
    const baseVertex = indexed ? args[3] : 0;
    if (!safeInteger(firstVertex) || !safeInteger(firstIndex) ||
        !Number.isSafeInteger(baseVertex)) return unavailable('Draw 首顶点、首索引或 baseVertex 参数无效。');
    const vertexSnapshot = exactSnapshot(pass, event, 'vertex', position.slot);
    if (!vertexSnapshot) return unavailable(`顶点 Slot ${position.slot} 缺少 Draw 前字节快照。`);
    if (!snapshotBytes(vertexSnapshot, bytesByOrdinal))
      return unavailable(`顶点 Slot ${position.slot} 的 Draw 前 .bin 不可用、超出限制或字节长度不符。`);
    let indexView = null;
    let indexSnapshot = null;
    let indexStride = 0;
    if (indexed) {
      indexSnapshot = exactSnapshot(pass, event, 'index');
      const bytes = snapshotBytes(indexSnapshot, bytesByOrdinal);
      const binding = event.indexBuffer;
      indexStride = binding?.format === 'uint16' ? 2 : binding?.format === 'uint32' ? 4 : 0;
      if (!indexSnapshot || !bytes || !binding || !indexStride ||
          indexSnapshot.bufferId !== binding.id ||
          indexSnapshot.indexFormat !== binding.format ||
          indexSnapshot.offset !== binding.offset + firstIndex * indexStride ||
          indexSnapshot.size !== count * indexStride)
        return unavailable('索引 Buffer 的 Draw 前快照缺失，或格式、范围与所选 Draw 不匹配。');
      indexView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    const vertexBuffers = list(pipeline?.descriptor?.vertex?.buffers);
    const attributes = [];
    for (let slot = 0; slot < vertexBuffers.length; slot++) {
      if ((vertexBuffers[slot]?.stepMode || 'vertex') !== 'vertex') continue;
      for (const item of list(vertexBuffers[slot]?.attributes))
        attributes.push({ slot, shaderLocation: item.shaderLocation, format: item.format,
          offset: item.offset, pipeline });
    }
    attributes.sort((a, b) => a.shaderLocation - b.shaderLocation);
    const points = [];
    const rows = [];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const restart = indexed && topology.endsWith('-strip') ?
      (indexStride === 2 ? 0xffff : 0xffffffff) : null;
    for (let order = 0; order < count; order++) {
      let sourceIndex = null;
      let vertexIndex;
      if (indexed) {
        const absolute = indexSnapshot.offset + order * indexStride;
        const relative = absolute - indexSnapshot.copiedOffset;
        if (!safeInteger(relative) || relative + indexStride > indexView.byteLength)
          return unavailable(`索引 ${order} 超出保存的字节范围。`);
        sourceIndex = indexStride === 2 ? indexView.getUint16(relative, true) : indexView.getUint32(relative, true);
        if (sourceIndex === restart) {
          points.push(null);
          if (rows.length < TABLE_ROWS) rows.push({ order, restart: true, sourceIndex });
          continue;
        }
        vertexIndex = sourceIndex + baseVertex;
      } else vertexIndex = firstVertex + order;
      if (!safeInteger(vertexIndex)) return unavailable(`顶点 ${order} 的索引加 baseVertex 后越界。`);
      const result = readBoundAttribute(event, pass, bytesByOrdinal, position.slot,
        { ...position, pipeline }, vertexIndex);
      if (!result || !Number.isFinite(result.values[0]) || !Number.isFinite(result.values[1]))
        return unavailable(`顶点 ${order}（索引 ${vertexIndex}）的位置字节越界、丢失或值不是有限数。`);
      const x = result.values[0], y = result.values[1];
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      points.push({ order, sourceIndex, vertexIndex, x, y });
      if (rows.length < TABLE_ROWS) {
        const values = attributes.map(attribute => {
          const decoded = readBoundAttribute(event, pass, bytesByOrdinal,
            attribute.slot, attribute, vertexIndex);
          return decoded ? decoded.values : null;
        });
        rows.push({ order, sourceIndex, vertexIndex,
          byteOffset: result.absolute, x, y, values });
      }
    }
    const primitives = primitivesFor(topology, points);
    if (!primitives.length) return unavailable('该 Draw 没有形成完整的三角形或线段。');
    return { status: 'ok', topology, indexed, count, instanceCount,
      firstVertex, firstIndex, baseVertex, position, attributes, points,
      primitives, rows, rowLimit: TABLE_ROWS,
      bounds: { minX, maxX, minY, maxY } };
  }

  const api = { decodeDraw, positionAttributes, recommendedLocation, readAttribute,
    MAX_SNAPSHOT_BYTES, TABLE_ROWS };
  root.GameDraftMeshInspector = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof window !== 'undefined' ? window : globalThis));
