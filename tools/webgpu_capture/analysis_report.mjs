// Turn Inspector's command stream and object table into navigable GPU state.
// Texture images are attached separately by analysis_png.mjs.
const DRAW = new Set(['draw', 'drawIndexed', 'drawIndirect', 'drawIndexedIndirect']);
const DISPATCH = new Set(['dispatchWorkgroups', 'dispatchWorkgroupsIndirect']);
const FRAME_DEBUG_STEP = /^(.*?) \/ frame-debug draw ([1-9]\d*)\/([1-9]\d*)$/;

function objectList(metadata) {
  return Array.isArray(metadata.objects) ? metadata.objects :
    Object.entries(metadata.objects).map(([id, value]) => ({ id: value.id ?? Number(id), ...value }));
}

function refId(value) {
  return value && typeof value === 'object' && '__id' in value ? value.__id : null;
}

function boundResource(resource, byId) {
  const directId = refId(resource);
  const bufferId = refId(resource?.buffer);
  const id = directId ?? bufferId;
  const object = byId.get(id);
  const result = {
    id, type: object?.type ?? resource?.__class ?? resource?.buffer?.__class ?? null,
    label: object?.label ?? resource?.__label ?? resource?.buffer?.__label ?? '',
  };
  if (object?.type === 'TextureView') result.textureId = refId(object.texture);
  if (object?.type === 'Texture') result.textureId = id;
  if (bufferId !== null) {
    result.offset = resource.offset ?? 0;
    result.size = resource.size ?? null;
  }
  return result;
}

function bindingEntries(group, byId) {
  const entries = group?.descriptor?.entries;
  return Array.isArray(entries) ? entries.map(entry => ({
    binding: entry.binding,
    resource: boundResource(entry.resource, byId),
  })) : [];
}

function attachmentTarget(attachment, kind, slot, byId) {
  const viewId = refId(attachment?.view);
  const view = byId.get(viewId);
  const textureId = refId(view?.texture);
  const texture = byId.get(textureId);
  const resolveViewId = refId(attachment?.resolveTarget);
  const resolveView = byId.get(resolveViewId);
  const resolveTextureId = refId(resolveView?.texture);
  const resolveTexture = byId.get(resolveTextureId);
  return {
    kind, slot, viewId, textureId, resolveViewId, resolveTextureId,
    outputTextureId: resolveTextureId ?? textureId,
    textureLabel: texture?.label ?? attachment?.view?.__label ?? '',
    outputTextureLabel: resolveTexture?.label ?? texture?.label ?? '',
    format: view?.descriptor?.format ?? texture?.format ?? null,
    loadOp: attachment?.loadOp ?? attachment?.depthLoadOp ?? null,
    storeOp: attachment?.storeOp ?? attachment?.depthStoreOp ?? null,
  };
}

function passTargets(descriptor, byId) {
  const targets = [];
  for (const [slot, attachment] of (descriptor?.colorAttachments ?? []).entries()) {
    if (attachment) targets.push(attachmentTarget(attachment, 'color', slot, byId));
  }
  if (descriptor?.depthStencilAttachment) {
    targets.push(attachmentTarget(descriptor.depthStencilAttachment, 'depth-stencil', 0, byId));
  }
  return targets;
}

function emptyState() {
  return {
    pipelineId: null, pipelineLabel: '', bindGroups: new Map(), vertexBuffers: new Map(),
    indexBuffer: null, viewport: null, scissorRect: null, stencilReference: null,
  };
}

function dataPayloads(command, bufferId, sourceCommandIndex, kind, slot, group, byId) {
  const data = Array.isArray(command.bufferData) ? command.bufferData : [];
  return data.filter(item => Number.isSafeInteger(item?.__payloadId)).map(item => {
    const entry = group?.descriptor?.entries?.[item.entryIndex];
    const resolvedId = refId(entry?.resource?.buffer) ?? bufferId;
    return {
      payloadId: item.__payloadId,
      byteLength: item.byteLength ?? item.__byteLength ?? null,
      bufferId: resolvedId,
      bufferLabel: byId.get(resolvedId)?.label ?? '',
      sourceCommandIndex, kind, slot,
      binding: entry?.binding ?? null,
      bufferOffset: Number.isSafeInteger(entry?.resource?.offset) ? entry.resource.offset : null,
    };
  });
}

function boundGroups(state, byId, includeResources) {
  return [...state.bindGroups.entries()].sort(([a], [b]) => a - b).map(([slot, binding]) => {
    const group = byId.get(binding.id);
    const result = {
      slot, id: binding.id, label: group?.label ?? binding.label,
      dynamicOffsets: binding.dynamicOffsets,
    };
    if (includeResources) result.resources = bindingEntries(group, byId);
    return result;
  });
}

function resourceTable(objects, byId) {
  const resources = {
    textures: [], shaders: [], pipelines: [], buffers: [], textureViews: [], bindGroups: [], samplers: [],
  };
  for (const object of objects) {
    const common = { id: object.id, label: object.label ?? '', descriptor: object.descriptor ?? null };
    switch (object.type) {
      case 'Texture':
        resources.textures.push({ ...common, width: object.width ?? null,
          height: object.height ?? null, depthOrArrayLayers: object.depthOrArrayLayers ?? 1,
          dimension: object.dimension ?? object.descriptor?.dimension ?? '2d',
          format: object.format ?? object.descriptor?.format ?? null,
          mipLevels: Array.isArray(object.mipData) ? object.mipData.map(mip => ({
            mipLevel: mip.mipLevel, payloadId: mip.__payloadId ?? null,
            byteLength: mip.byteLength ?? mip.__byteLength ?? null,
          })) : [],
        });
        break;
      case 'ShaderModule':
        resources.shaders.push({ ...common, code: object.descriptor?.code ?? null,
          hasVertexEntries: object.hasVertexEntries ?? null,
          hasFragmentEntries: object.hasFragmentEntries ?? null,
          hasComputeEntries: object.hasComputeEntries ?? null,
        });
        break;
      case 'RenderPipeline':
      case 'ComputePipeline':
        resources.pipelines.push({ ...common, type: object.type,
          shaderIds: [...new Set([
            refId(object.descriptor?.vertex?.module),
            refId(object.descriptor?.fragment?.module),
            refId(object.descriptor?.compute?.module),
          ].filter(id => id !== null))],
        });
        break;
      case 'Buffer':
        resources.buffers.push({ ...common, size: object.size ?? object.descriptor?.size ?? null });
        break;
      case 'TextureView':
        resources.textureViews.push({ ...common, textureId: refId(object.texture) });
        break;
      case 'BindGroup':
        resources.bindGroups.push({ ...common, entries: bindingEntries(object, byId) });
        break;
      case 'Sampler':
        resources.samplers.push(common);
        break;
      default:
        break;
    }
  }
  return resources;
}

export function buildCaptureDetails(metadata, passes) {
  const objects = objectList(metadata);
  const byId = new Map(objects.map(object => [object.id, object]));
  const resources = resourceTable(objects, byId);
  const events = [];
  const frames = [];
  let activePass = null;
  let nextPassIndex = 0;
  let state = emptyState();
  let frameTextureId = null;
  let frameOrdinal = 1;
  let frameBeginCommand = 0;
  let currentFrameTextureId = null;

  for (let commandIndex = 0; commandIndex < metadata.commands.length; commandIndex++) {
    const command = metadata.commands[commandIndex];
    const method = command?.method ?? '(unknown)';
    const args = Array.isArray(command?.args) ? command.args : [];
    if (method === 'beginRenderPass' || method === 'beginComputePass') {
      activePass = { index: nextPassIndex++, targets: passTargets(args[0], byId) };
      state = emptyState();
      if (passes[activePass.index]) {
        passes[activePass.index].frameOrdinal = frameOrdinal;
        passes[activePass.index].targets = activePass.targets;
        passes[activePass.index].drawCommandIndexes = [];
      }
    } else if (activePass && method === 'setPipeline') {
      state.pipelineId = refId(args[0]);
      state.pipelineLabel = byId.get(state.pipelineId)?.label ?? args[0]?.__label ?? '';
    } else if (activePass && method === 'setBindGroup') {
      const slot = args[0];
      if (Number.isSafeInteger(slot) && slot >= 0) {
        const group = byId.get(refId(args[1]));
        state.bindGroups.set(slot, {
          id: refId(args[1]), label: args[1]?.__label ?? '',
          dynamicOffsets: args.length > 2 ? args.slice(2) : [],
          payloads: dataPayloads(command, null, commandIndex, 'bind-group', slot, group, byId),
        });
      }
    } else if (activePass && method === 'setVertexBuffer') {
      const slot = args[0];
      if (Number.isSafeInteger(slot) && slot >= 0) state.vertexBuffers.set(slot, {
        slot, id: refId(args[1]), label: byId.get(refId(args[1]))?.label ?? args[1]?.__label ?? '',
        offset: args[2] ?? 0, size: args[3] ?? null,
        payloads: dataPayloads(command, refId(args[1]), commandIndex, 'vertex', slot, null, byId),
      });
    } else if (activePass && method === 'setIndexBuffer') {
      state.indexBuffer = {
        id: refId(args[0]), label: byId.get(refId(args[0]))?.label ?? args[0]?.__label ?? '',
        format: args[1] ?? null, offset: args[2] ?? 0, size: args[3] ?? null,
        payloads: dataPayloads(command, refId(args[0]), commandIndex, 'index', null, null, byId),
      };
    } else if (activePass && method === 'setViewport') {
      state.viewport = args;
    } else if (activePass && method === 'setScissorRect') {
      state.scissorRect = args;
    } else if (activePass && method === 'setStencilReference') {
      state.stencilReference = args[0] ?? null;
    } else if (method === 'getCurrentTexture') {
      currentFrameTextureId = command.result ?? null;
    }

    const draw = DRAW.has(method);
    const dispatch = DISPATCH.has(method);
    const event = {
      commandIndex, method, frameOrdinal, passIndex: activePass?.index ?? null,
      pipelineId: activePass ? state.pipelineId : null,
      pipelineLabel: activePass ? state.pipelineLabel : '',
      bindGroups: activePass ? boundGroups(state, byId, draw || dispatch) : [],
      args,
    };
    if (Array.isArray(command?.bufferData)) {
      const group = method === 'setBindGroup' ? byId.get(refId(args[1])) : null;
      event.bufferPayloads = dataPayloads(command,
        method === 'setBindGroup' ? null : refId(method === 'setVertexBuffer' ? args[1] : args[0]),
        commandIndex, method, method === 'setBindGroup' || method === 'setVertexBuffer' ? args[0] : null,
        group, byId);
    }
    if (activePass && (draw || dispatch || method === 'beginRenderPass' || method === 'beginComputePass')) {
      event.targets = activePass.targets;
    }
    if (draw || dispatch) {
      event.vertexBuffers = [...state.vertexBuffers.values()].sort((a, b) => a.slot - b.slot);
      event.indexBuffer = state.indexBuffer;
      event.bufferPayloads = [
        ...[...state.bindGroups.values()].flatMap(binding => binding.payloads),
        ...[...state.vertexBuffers.values()].flatMap(binding => binding.payloads),
        ...(state.indexBuffer?.payloads ?? []),
      ];
      event.viewport = state.viewport;
      event.scissorRect = state.scissorRect;
      event.stencilReference = state.stencilReference;
      if (draw && passes[activePass?.index]) passes[activePass.index].drawCommandIndexes.push(commandIndex);
    }
    events.push(event);
    if (method === 'submit') {
      frames.push({
        frameOrdinal, beginCommand: frameBeginCommand, endCommand: commandIndex,
        submitCommandIndex: commandIndex, boundarySource: 'queue.submit',
        boundaryConfidence: 'inferred', frameTextureId: currentFrameTextureId,
        imageFile: null,
      });
      frameTextureId = currentFrameTextureId;
      frameOrdinal++;
      frameBeginCommand = commandIndex + 1;
      currentFrameTextureId = null;
    }
    if (activePass && method === 'end') {
      activePass = null;
      state = emptyState();
    }
  }

  if (frameBeginCommand < metadata.commands.length && frames.length &&
      metadata.commands.slice(frameBeginCommand).every(command =>
        ['mapAsync', 'getMappedRange', 'unmap', 'destroy'].includes(command?.method))) {
    // A timestamp/readback map after the final queue.submit is bookkeeping,
    // not another rendered frame. Keep these events with that submission.
    for (const event of events) {
      if (event.commandIndex >= frameBeginCommand) event.frameOrdinal = frameOrdinal - 1;
    }
  } else if (frameBeginCommand < metadata.commands.length) {
    frames.push({
      frameOrdinal, beginCommand: frameBeginCommand, endCommand: metadata.commands.length - 1,
      submitCommandIndex: null, boundarySource: 'queue.submit',
      boundaryConfidence: 'inferred; no closing submit in capture',
      frameTextureId: currentFrameTextureId, imageFile: null,
    });
    frameTextureId = currentFrameTextureId ?? frameTextureId;
  }

  if (frameTextureId === null) {
    frameTextureId = resources.textures.find(texture => texture.label === 'CanvasTexture')?.id ?? null;
    // Only the last frame may inherit a texture snapshot without a recorded
    // getCurrentTexture command; earlier frame images would be invented.
    if (frameTextureId !== null && frames.length) frames.at(-1).frameTextureId = frameTextureId;
  }
  // The renderer splits a logical render pass into one physical pass per Draw
  // only during a requested frame-debug capture. A matching name alone does
  // not prove that a Pass output is the selected Draw's output: require the
  // complete ordered run and exactly one real Draw in each physical pass.
  for (let start = 0; start < passes.length;) {
    const match = typeof passes[start].label === 'string' ? passes[start].label.match(FRAME_DEBUG_STEP) : null;
    if (!match || !match[1] || Number(match[2]) !== 1) { start++; continue; }
    const total = Number(match[3]);
    if (!Number.isSafeInteger(total) || total < 1 || total > passes.length - start) { start++; continue; }
    const run = passes.slice(start, start + total);
    const valid = run.every((pass, offset) => {
      const step = typeof pass.label === 'string' ? pass.label.match(FRAME_DEBUG_STEP) : null;
      const drawCommandIndex = pass.drawCommandIndexes?.[0];
      return step && step[1] === match[1] && Number(step[2]) === offset + 1 &&
        Number(step[3]) === total && pass.type === 'render' && pass.draws === 1 &&
        pass.drawCommandIndexes?.length === 1 && Number.isSafeInteger(drawCommandIndex) &&
        pass.frameOrdinal === run[0].frameOrdinal &&
        events[drawCommandIndex]?.passIndex === pass.index && DRAW.has(events[drawCommandIndex]?.method);
    });
    if (!valid) { start++; continue; }
    for (const [offset, pass] of run.entries()) {
      pass.frameDebugStep = {
        logicalLabel: match[1], drawOrdinal: offset + 1, totalDraws: total,
        drawCommandIndex: pass.drawCommandIndexes[0],
      };
    }
    start += total;
  }
  return { events, resources, frames, frameTextureId };
}
