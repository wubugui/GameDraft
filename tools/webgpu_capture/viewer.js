// Shared by the Vite capture route and a self-contained analysis directory.
// All capture-owned strings enter the page through textContent, never HTML.
(function () {
  'use strict';

  const RESOURCE_KINDS = [
    ['textures', '纹理'],
    ['shaders', '着色器'],
    ['pipelines', '管线'],
    ['buffers', '缓冲'],
  ];
  const PAGE_SIZE = 200;
  const state = {
    report: null,
    events: [],
    resources: {},
    selectedFrame: null,
    frameFilter: null,
    selectedPass: null,
    selectedEvent: null,
    eventLimit: PAGE_SIZE,
    resourceKind: 'textures',
    selectedResource: null,
    selectedTextureKey: null,
    textureChoices: [],
    selectedBufferPayloadId: null,
    previewMode: 'frame',
    mode: 'frame',
    navigationIndices: [],
    expandedPasses: new Set(),
  };
  const el = id => document.getElementById(id);
  const list = value => Array.isArray(value) ? value : [];
  const printable = value => value === null || value === undefined || value === '' ? '—' : String(value);
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const compactGpuMs = value => value < 0.001 ? '<0.001 ms' : `${value.toFixed(3)} ms`;

  function clear(node) { node.replaceChildren(); }
  function setText(node, value) { node.textContent = printable(value); }
  function make(tag, value, className) {
    const node = document.createElement(tag);
    if (value !== undefined) node.textContent = printable(value);
    if (className) node.className = className;
    return node;
  }
  function empty(node, message) { clear(node); node.appendChild(make('p', message, 'empty')); }
  function safeJson(value, maxLength = 60000) {
    let json;
    try { json = JSON.stringify(value, null, 2); }
    catch { json = String(value); }
    if (json === undefined) json = String(value);
    return json.length > maxLength ? json.slice(0, maxLength) + '\n…（内容过长，已截断）' : json;
  }
  function pre(value, maxLength) { return make('pre', safeJson(value, maxLength)); }
  function shortPath(path) {
    if (typeof path !== 'string') return '—';
    return path.replace(/\\/g, '/').split('/').pop() || path;
  }
  function safeAssetPath(value) {
    if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('?') ||
        value.includes('#') || value.includes('\0') || value.startsWith('/')) return null;
    const segments = value.split('/');
    if (segments.some(segment => !segment || segment === '.' || segment === '..')) return null;
    return segments.map(encodeURIComponent).join('/');
  }
  function assetUrl(file) {
    const path = safeAssetPath(file);
    if (!path) return null;
    if (location.protocol === 'file:') return new URL(path, location.href).href;
    const url = new URL(location.href);
    url.searchParams.set('file', file);
    return url.href;
  }
  function describePass(pass) {
    const label = pass && typeof pass.label === 'string' && pass.label ? pass.label : `${pass?.type || 'pass'} pass`;
    return `#${printable(pass?.index)} ${label}`;
  }
  function passFor(index) {
    return list(state.report?.passes).find(pass => Number(pass?.index) === Number(index));
  }
  function payloadFor(id) {
    return list(state.report?.payloads).find(item => item.id === id);
  }
  function selectedFrame() {
    return list(state.report?.frames).find(frame => Number(frame?.frameOrdinal) === Number(state.selectedFrame));
  }
  function resourceArray(kind) { return list(state.resources[kind]); }
  function resourceIndexById(kind, id) {
    return resourceArray(kind).findIndex(item => item && String(item.id) === String(id));
  }
  function eventKind(method) {
    if (/^draw/.test(method)) return 'draw';
    if (/^dispatch/.test(method)) return 'dispatch';
    if (/^(setPipeline|setBindGroup|setVertexBuffer|setIndexBuffer)/.test(method)) return 'bind';
    if (/^copy/.test(method)) return 'copy';
    return 'other';
  }

  function showError(message) {
    el('fatal').textContent = message;
    el('timing-note').textContent = '报告未能打开。';
    el('frame-empty').textContent = '暂无图像';
    empty(el('event-tree'), '暂无事件');
    empty(el('event-detail'), '暂无事件详情');
    empty(el('resource-list'), '暂无资源');
    empty(el('resource-detail'), '暂无资源详情');
  }

  function renderTop() {
    const report = state.report;
    const meta = el('top-meta');
    clear(meta);
    const pairs = [
      ['格式', report.format || 'wgpuc'],
      ['文件', shortPath(report.captureFile)],
      ['命令', report.commandCount ?? state.events.length],
    ];
    if (list(report.frames).length) pairs.push(['推断帧', list(report.frames).length]);
    const jobId = new URLSearchParams(location.search).get('jobId');
    if (jobId && location.protocol !== 'file:') pairs.unshift(['任务', jobId]);
    if (report.inspector?.toolVersion) pairs.push(['Inspector', report.inspector.toolVersion]);
    for (const [label, value] of pairs) meta.appendChild(make('span', `${label}：${printable(value)}`));

    const stats = report.stats || {};
    const summary = [
      [stats.drawCalls ?? state.events.filter(item => eventKind(String(item?.method || '')) === 'draw').length, 'Draw'],
      [stats.dispatches ?? 0, 'Dispatch'],
      [list(report.passes).length, 'Pass'],
      [report.commandCount ?? state.events.length, '命令'],
      [resourceArray('textures').length, '纹理'],
      [report.validationErrorCount ?? list(report.validationErrors).length, '验证错误'],
    ];
    const container = el('summary');
    clear(container);
    for (const [value, label] of summary) {
      const card = make('div', undefined, 'stat');
      card.append(make('strong', value), make('span', label));
      container.appendChild(card);
    }

    const timing = report.gpuTiming;
    const profiler = report.gpuProfilerStatus;
    el('timing-note').textContent = (timing?.source === 'webgpu-timestamp-query' && finite(timing.sumPassDurationMs)
      ? `WebGPU timestamp query sidecar：${printable(timing.timedPasses)} 个 Pass，记录时长合计 ${timing.sumPassDurationMs} ms。未测量的 Pass 和 Draw 不显示估算值。`
      : `这份捕获没有有效的 WebGPU GPU 时间戳。${profiler?.state ? `Profiler 状态：${profiler.state}。` : ''}${profiler?.reason || 'Draw 数和 Pass 数不能推算 GPU 耗时。'}`) +
      (report.passCaptureWarning ? ` 中间画面限制：${report.passCaptureWarning}` : '');
  }

  function renderFrameSelector() {
    const frames = list(state.report?.frames);
    const select = el('frame-select');
    clear(select);
    if (!frames.length) {
      const option = make('option', '单帧 / 未分帧');
      option.value = 'all';
      select.appendChild(option);
      select.disabled = true;
      return;
    }
    select.disabled = false;
    const all = make('option', `全部帧（${frames.length}）`);
    all.value = 'all';
    select.appendChild(all);
    for (const frame of frames) {
      const ordinal = Number(frame?.frameOrdinal);
      if (!Number.isFinite(ordinal)) continue;
      const option = make('option', `第 ${ordinal} 帧 · 命令 ${printable(frame.beginCommand)}–${printable(frame.endCommand)}`);
      option.value = String(ordinal);
      select.appendChild(option);
    }
    select.value = state.frameFilter === null ? 'all' : String(state.frameFilter);
  }

  function renderPasses() {
    const passes = list(state.report?.passes);
    const visible = state.frameFilter === null ? passes : passes.filter(pass =>
      pass?.frameOrdinal !== null && pass?.frameOrdinal !== undefined &&
      Number(pass.frameOrdinal) === Number(state.frameFilter));
    el('pass-count').textContent = state.frameFilter === null ? `${passes.length} 个` : `${visible.length} / ${passes.length}`;
  }

  function eventMatches(event, query, kind) {
    const method = String(event?.method || '');
    if (kind === 'visual' ? !['draw', 'dispatch'].includes(eventKind(method)) :
      kind !== 'all' && eventKind(method) !== kind) return false;
    if (state.frameFilter !== null && (event?.frameOrdinal === null || event?.frameOrdinal === undefined ||
        Number(event.frameOrdinal) !== Number(state.frameFilter))) return false;
    if (!query) return true;
    const head = [method, event?.commandIndex, event?.pipelineId, event?.pipelineLabel,
      event?.passIndex, event?.frameOrdinal].map(printable).join(' ').toLocaleLowerCase();
    if (head.includes(query)) return true;
    return safeJson([event?.args, event?.bindGroups], 12000).toLocaleLowerCase().includes(query);
  }
  function renderEvents() {
    const query = el('event-search').value.trim().toLocaleLowerCase();
    const kind = el('event-kind').value;
    const matches = [];
    for (let i = 0; i < state.events.length; i++) {
      if (eventMatches(state.events[i], query, kind)) matches.push(i);
    }
    state.navigationIndices = matches;
    el('event-count').textContent = `${matches.length} / ${state.events.length}`;
    const holder = el('event-tree');
    const previousScroll = holder.scrollTop;
    clear(holder);
    if (!matches.length) {
      holder.appendChild(make('p', state.events.length ? '没有符合条件的事件。' : '报告没有事件明细；可查看 Pass 与统计。', 'empty'));
    }
    const visible = matches.slice(0, state.eventLimit);
    const byPass = new Map();
    for (const index of visible) {
      const event = state.events[index];
      const key = event?.passIndex == null ? 'frame' : String(event.passIndex);
      if (!byPass.has(key)) byPass.set(key, []);
      byPass.get(key).push(index);
    }
    const appendEvents = (target, indices) => {
      for (const index of indices) {
        const event = state.events[index];
        const button = make('button', undefined, 'tree-event');
        button.type = 'button';
        button.dataset.eventIndex = String(index);
        button.classList.toggle('active', state.selectedEvent === index);
        button.setAttribute('aria-selected', String(state.selectedEvent === index));
        button.appendChild(make('span', `#${printable(event.commandIndex ?? index)}  ${printable(event.method)}`, 'tree-label'));
        const pipeline = event.pipelineLabel || event.pipelineId;
        if (pipeline) button.appendChild(make('span', String(pipeline), 'tree-meta'));
        button.addEventListener('click', () => selectEvent(index));
        target.appendChild(button);
      }
    };
    const allFrames = list(state.report?.frames);
    const frames = allFrames.length ? allFrames.filter(frame => state.frameFilter === null ||
      Number(frame?.frameOrdinal) === Number(state.frameFilter)) : [null];
    if (matches.length) for (const frame of frames) {
      const ordinal = frame?.frameOrdinal ?? null;
      const belongs = event => ordinal === null || Number(event?.frameOrdinal) === Number(ordinal);
      const inFrame = visible.filter(index => belongs(state.events[index]));
      if (!inFrame.length && query) continue;
      holder.appendChild(make('div', frame ?
        `▾ 第 ${frame.frameOrdinal} 帧 · 命令 ${printable(frame.beginCommand)}–${printable(frame.endCommand)}` :
        '▾ 捕获事件', 'tree-frame'));
      const passes = list(state.report?.passes).filter(pass => ordinal === null ||
        Number(pass?.frameOrdinal) === Number(ordinal));
      const passIds = new Set(passes.map(pass => String(pass.index)));
      const ungrouped = inFrame.filter(index => state.events[index]?.passIndex == null ||
        !passIds.has(String(state.events[index].passIndex)));
      const nodes = passes.filter(pass => (byPass.get(String(pass.index)) || []).length || !query)
        .map(pass => ({ type: 'pass', value: pass, order: Number(pass.beginCommand) || 0 }));
      nodes.push(...ungrouped.map(index => ({ type: 'event', value: index,
        order: Number(state.events[index]?.commandIndex) || index })));
      nodes.sort((a, b) => a.order - b.order);
      for (const node of nodes) {
        if (node.type === 'event') {
          const group = make('div', undefined, 'tree-children');
          appendEvents(group, [node.value]);
          holder.appendChild(group);
          continue;
        }
        const pass = node.value;
        const key = String(pass.index);
        const group = make('details', undefined, 'tree-pass');
        group.open = state.expandedPasses.has(key);
        const head = make('summary', undefined, 'tree-pass-head');
        head.appendChild(make('span', describePass(pass), 'tree-label'));
        const gpuMs = pass.gpuTiming?.source === 'webgpu-timestamp-query' && finite(pass.gpuTiming.durationMs) ?
          compactGpuMs(pass.gpuTiming.durationMs) : '';
        head.appendChild(make('span', `${pass.type === 'compute' ? pass.dispatches ?? 0 : pass.draws ?? 0} ${pass.type === 'compute' ? 'dispatch' : 'draw'}${gpuMs ? ` · ${gpuMs}` : ''}`, 'tree-meta'));
        head.classList.toggle('active', state.selectedPass !== null && Number(state.selectedPass) === Number(pass.index));
        head.addEventListener('click', event => {
          event.preventDefault();
          if (group.open && state.selectedPass !== null && Number(state.selectedPass) === Number(pass.index)) {
            state.expandedPasses.delete(key);
            renderEvents();
          } else {
            state.expandedPasses.add(key);
            selectPass(pass.index, { keepTreeScroll: true });
          }
        });
        group.appendChild(head);
        const children = make('div', undefined, 'tree-children');
        appendEvents(children, byPass.get(key) || []);
        group.appendChild(children);
        holder.appendChild(group);
      }
    }
    holder.scrollTop = previousScroll;
    el('event-list-status').textContent = `显示 ${Math.min(matches.length, state.eventLimit)} / ${matches.length} 条`;
    el('event-more').hidden = matches.length <= state.eventLimit;
    const step = matches.indexOf(state.selectedEvent);
    const range = el('event-range');
    range.max = String(Math.max(0, matches.length - 1));
    range.value = String(Math.max(0, step));
    range.disabled = !matches.length;
    el('event-prev').disabled = step <= 0;
    el('event-next').disabled = !matches.length || step >= matches.length - 1;
    el('event-position').textContent = matches.length ? `${step < 0 ? '—' : step + 1} / ${matches.length}` : '0 / 0';
  }

  function selectEvent(index, scrollToSelected = false) {
    const event = state.events[index];
    if (!event) return;
    const navigationPosition = state.navigationIndices.indexOf(index);
    if (navigationPosition >= state.eventLimit) state.eventLimit = Math.ceil((navigationPosition + 1) / PAGE_SIZE) * PAGE_SIZE;
    state.selectedEvent = index;
    if (event.passIndex !== null && event.passIndex !== undefined) {
      state.selectedPass = Number(event.passIndex);
      state.expandedPasses.add(String(event.passIndex));
    } else state.selectedPass = null;
    if (event.frameOrdinal !== null && event.frameOrdinal !== undefined) {
      state.selectedFrame = Number(event.frameOrdinal);
      renderFrameSelector();
    }
    state.selectedTextureKey = null;
    state.selectedBufferPayloadId = null;
    state.previewMode = 'frame';
    renderPasses();
    renderEvents();
    renderEventDetail();
    renderTextureInspector();
    renderBufferInspector();
    renderFrame();
    renderPreviewMode();
    if (scrollToSelected) el('event-tree').querySelector(`[data-event-index="${index}"]`)?.scrollIntoView({ block: 'center' });
  }

  function selectPass(index, options = {}) {
    const pass = passFor(index);
    if (!pass) return;
    state.selectedPass = Number(index);
    if (pass.frameOrdinal !== null && pass.frameOrdinal !== undefined) {
      state.selectedFrame = Number(pass.frameOrdinal);
      renderFrameSelector();
    }
    const firstDraw = state.events.findIndex(event => Number(event?.passIndex) === Number(index) &&
      ['draw', 'dispatch'].includes(eventKind(String(event?.method || ''))));
    state.selectedEvent = firstDraw < 0 ? null : firstDraw;
    state.expandedPasses.add(String(index));
    state.selectedTextureKey = null;
    state.selectedBufferPayloadId = null;
    state.previewMode = 'frame';
    renderPasses();
    renderEvents();
    renderEventDetail();
    renderTextureInspector();
    renderBufferInspector();
    renderFrame();
    renderPreviewMode();
    if (!options.keepTreeScroll) el('event-tree').querySelector(`[data-event-index="${firstDraw}"]`)?.scrollIntoView({ block: 'center' });
  }

  function addDetailRow(grid, label, value) {
    grid.append(make('dt', label), make('dd', value));
  }
  function addDataSection(container, title, value, maxLength) {
    if (value === undefined || value === null) return;
    const section = make('section', undefined, 'data-section');
    section.append(make('label', title), pre(value, maxLength));
    container.appendChild(section);
  }
  function addResourceJumps(holder, event) {
    const targets = [];
    const seen = new Set();
    const add = (kind, id, label) => {
      if (id === null || id === undefined || resourceIndexById(kind, id) < 0) return;
      const key = `${kind}:${id}`;
      if (seen.has(key)) return;
      seen.add(key);
      targets.push({ kind, id, label });
    };
    for (const group of list(event.bindGroups)) {
      for (const entry of list(group?.resources)) {
        const resource = entry?.resource;
        if (resource?.textureId !== undefined) add('textures', resource.textureId, resource.label);
        else if (resource?.type === 'Buffer') add('buffers', resource.id, resource.label);
      }
    }
    for (const target of list(event.targets)) add('textures', target?.textureId, target?.textureLabel);
    for (const buffer of list(event.vertexBuffers)) add('buffers', buffer?.id, buffer?.label);
    if (event.indexBuffer) add('buffers', event.indexBuffer.id, event.indexBuffer.label);
    if (!targets.length) return;
    const section = make('section', undefined, 'data-section');
    section.appendChild(make('label', '相关资源'));
    const links = make('div', undefined, 'resource-jumps');
    for (const target of targets) {
      const button = make('button', `${target.kind === 'textures' ? '纹理' : '缓冲'} #${target.id} ${target.label || ''}`, 'plain-button');
      button.type = 'button';
      button.addEventListener('click', () => {
        el('resource-search').value = '';
        selectResource(target.kind, resourceIndexById(target.kind, target.id));
      });
      links.appendChild(button);
    }
    section.appendChild(links);
    holder.appendChild(section);
  }
  function renderEventDetail() {
    const holder = el('event-detail');
    clear(holder);
    const event = state.events[state.selectedEvent];
    if (!event) {
      el('detail-index').textContent = '';
      holder.appendChild(make('p', '选择一个事件查看管线、绑定和调用参数。', 'empty'));
      return;
    }
    el('detail-index').textContent = `命令 #${printable(event.commandIndex ?? state.selectedEvent)}`;
    const grid = make('dl', undefined, 'detail-grid');
    addDetailRow(grid, '调用', event.method);
    if (event.frameOrdinal !== undefined && event.frameOrdinal !== null) addDetailRow(grid, '推断帧', event.frameOrdinal);
    const pass = event.passIndex === null || event.passIndex === undefined ? null : passFor(event.passIndex);
    addDetailRow(grid, 'Pass', pass ? describePass(pass) : event.passIndex ?? '帧级');
    addDetailRow(grid, '管线', event.pipelineId == null ? '未绑定' : `#${event.pipelineId} ${event.pipelineLabel || ''}`);
    const pipeline = resourceArray('pipelines').find(item => String(item.id) === String(event.pipelineId));
    if (pipeline) {
      addDetailRow(grid, 'WGSL 模块', list(pipeline.shaderIds).map(id => `#${id}`).join(', ') || '未记录');
      const entryPoints = [pipeline.descriptor?.vertex?.entryPoint, pipeline.descriptor?.fragment?.entryPoint,
        pipeline.descriptor?.compute?.entryPoint].filter(Boolean);
      if (entryPoints.length) addDetailRow(grid, '入口', entryPoints.join(' / '));
    }
    if (list(event.targets).length) addDetailRow(grid, '渲染目标', event.targets.map(target =>
      `${target.kind} ${target.slot}: #${target.textureId} ${target.textureLabel || ''} ${target.format || ''}`).join('；'));
    holder.appendChild(grid);
    if (event.pipelineId !== undefined && event.pipelineId !== null &&
        resourceIndexById('pipelines', event.pipelineId) >= 0) {
      const jump = make('button', '查看这条管线与着色器', 'inline-link');
      jump.type = 'button';
      jump.addEventListener('click', () => {
        el('resource-search').value = '';
        selectResource('pipelines', resourceIndexById('pipelines', event.pipelineId));
      });
      holder.appendChild(jump);
    }
    addResourceJumps(holder, event);
    addDataSection(holder, '绑定组状态', event.bindGroups);
    addDataSection(holder, '绘制 / 派发参数', event.args);
    addDataSection(holder, '顶点缓冲', event.vertexBuffers);
    addDataSection(holder, '索引缓冲', event.indexBuffer);
    addDataSection(holder, '相关缓冲 Payload', event.bufferPayloads);
    addDataSection(holder, '渲染目标', event.targets);
    addDataSection(holder, '视口', event.viewport);
    addDataSection(holder, '裁剪区域', event.scissorRect);
    addDataSection(holder, '模板参考值', event.stencilReference);
  }

  function textureOptions() {
    const event = state.events[state.selectedEvent];
    const pass = state.selectedPass !== null ? passFor(state.selectedPass) :
      event?.passIndex != null ? passFor(event.passIndex) : null;
    const drawSelected = event && ['draw', 'dispatch'].includes(eventKind(String(event.method || ''))) &&
      (state.selectedPass === null || Number(event.passIndex) === Number(state.selectedPass));
    const draws = drawSelected ? [event] : pass ? state.events.filter(item =>
      Number(item?.passIndex) === Number(pass.index) && ['draw', 'dispatch'].includes(eventKind(String(item?.method || '')))) : [];
    const options = [];
    const seen = new Set();
    const add = (id, role, label, snapshot) => {
      if (id == null) return;
      const texture = resourceArray('textures').find(item => String(item.id) === String(id));
      if (!texture) return;
      const key = `${role}:${id}`;
      if (seen.has(key)) return;
      seen.add(key);
      options.push({ key, id, role, label: label || texture.label || `纹理 #${id}`, texture, snapshot,
        file: snapshot?.imageFile || texture.imageFile });
    };
    for (const draw of draws) {
      for (const group of list(draw.bindGroups)) for (const entry of list(group?.resources)) {
        if (entry?.resource?.textureId != null) add(entry.resource.textureId, '绑定输入', entry.resource.label);
      }
    }
    for (const target of list(pass?.targets || event?.targets)) {
      const outputId = target.outputTextureId ?? target.textureId;
      const snapshot = list(pass?.snapshots).find(item => String(item.textureId) === String(outputId));
      add(outputId, snapshot ? 'Pass 结束读回' : '渲染目标',
        target.outputTextureLabel || target.textureLabel, snapshot);
    }
    return { options, pass, drawSelected };
  }

  function applyTextureControls() {
    const img = el('texture-image');
    const channel = el('texture-channel').value;
    const exposure = Number(el('texture-exposure').value);
    const filters = [];
    if (channel !== 'rgba') filters.push(`url(#texture-${channel})`);
    if (exposure !== 0) filters.push(`brightness(${2 ** exposure})`);
    img.style.filter = filters.join(' ') || 'none';
    el('texture-exposure-value').textContent = `${exposure > 0 ? '+' : ''}${exposure} EV`;
    const zoom = el('texture-zoom').value;
    img.classList.toggle('fit', zoom === 'fit');
    img.style.width = zoom === 'fit' || !img.naturalWidth ? '' : `${Math.round(img.naturalWidth * Number(zoom) / 100)}px`;
  }

  function renderTextureInspector() {
    const { options, pass, drawSelected } = textureOptions();
    state.textureChoices = options;
    el('texture-count').textContent = `${options.length} 张`;
    el('texture-scope').textContent = drawSelected ?
      `命令 #${state.events[state.selectedEvent].commandIndex} 的绑定输入和渲染目标。${pass?.outputUnavailableReason ? `Pass 输出未读回：${pass.outputUnavailableReason}` : pass?.partialOutputUnavailableReason ? `部分输出未读回：${pass.partialOutputUnavailableReason}` : ''}` :
      pass ? `${describePass(pass)} 全部 Draw 的绑定输入和 Pass 目标。${pass.outputUnavailableReason ? `Pass 输出未读回：${pass.outputUnavailableReason}` : pass.partialOutputUnavailableReason ? `部分输出未读回：${pass.partialOutputUnavailableReason}` : ''}` : '选择 Pass 或 Draw 查看绑定纹理。';
    const holder = el('texture-choices');
    clear(holder);
    if (!options.length) holder.appendChild(make('p', pass ? '这个 Pass 没有可识别的纹理资源。' : '尚未选择绘制事件。', 'muted small'));
    if (!options.some(item => item.key === state.selectedTextureKey)) {
      state.selectedTextureKey = (options.find(item => item.snapshot) || options.find(item => item.file) || options[0])?.key ?? null;
    }
    for (const item of options) {
      const evidence = item.snapshot ? 'Pass 结束实读回' : item.file ? '最终状态快照' : '无图像';
      const button = make('button', `${item.role} · #${item.id} ${item.label} · ${evidence}`, 'plain-button');
      button.type = 'button';
      button.classList.toggle('active', item.key === state.selectedTextureKey);
      button.addEventListener('click', () => {
        state.selectedTextureKey = item.key;
        state.previewMode = 'texture';
        renderTextureInspector();
        renderPreviewMode();
      });
      holder.appendChild(button);
    }
    const selected = options.find(item => item.key === state.selectedTextureKey);
    const img = el('texture-image');
    const placeholder = el('texture-empty');
    const save = el('texture-save');
    const url = assetUrl(selected?.file);
    save.hidden = !url;
    if (url) { save.href = url; save.download = `texture-${selected.id}${selected.snapshot ? '-pass-end' : '-capture-final'}.png`; }
    if (!selected || !url) {
      img.hidden = true;
      img.removeAttribute('src');
      placeholder.hidden = false;
      placeholder.textContent = selected ? `没有可预览的 payload。${selected.texture.imageReason || '捕获未提供纹理字节。'}` : '选择 Pass 或 Draw 查看纹理。';
      el('texture-note').textContent = selected ? `#${selected.id} ${selected.texture.format || ''} · ${selected.texture.width} × ${selected.texture.height}。该资源没有逐 Draw 输出图。` : '';
      return;
    }
    img.onload = () => { img.hidden = false; placeholder.hidden = true; applyTextureControls(); };
    img.onerror = () => { img.hidden = true; placeholder.hidden = false; placeholder.textContent = '纹理预览文件无法读取。'; };
    if (img.src !== url) img.src = url;
    else { img.hidden = false; placeholder.hidden = true; applyTextureControls(); }
    el('texture-note').textContent = selected.snapshot ?
      `真实 Pass 结束读回：第 ${selected.snapshot.frameOrdinal} 帧 Pass #${selected.snapshot.passIndex}（${selected.snapshot.label || ''}），结束命令 #${selected.snapshot.afterCommandIndex}；来源 ${selected.snapshot.source}；格式 ${selected.snapshot.format || selected.texture.format || '未知'}。` :
      `Inspector 纹理 mip0 最终状态快照，非所选 Draw / Pass 的输出。${selected.texture.imagePreviewTransform || ''} 曝光与通道只调整 PNG 预览显示。`;
  }

  function renderBufferInspector() {
    const event = state.events[state.selectedEvent];
    const bound = event && ['draw', 'dispatch'].includes(eventKind(String(event.method || ''))) ?
      list(event.bufferPayloads) : [];
    const selector = el('buffer-select');
    clear(selector);
    el('buffer-count').textContent = `${bound.length} 份`;
    const save = el('buffer-save');
    const hex = el('buffer-hex');
    const table = el('buffer-table-wrap');
    save.hidden = hex.hidden = table.hidden = true;
    if (!bound.length) {
      selector.disabled = true;
      const hasBuffer = event && (list(event.vertexBuffers).length || event.indexBuffer ||
        list(event.bindGroups).some(group => list(group.resources).some(entry => entry?.resource?.type === 'Buffer')));
      el('buffer-note').textContent = hasBuffer ?
        '这个 Draw 有缓冲绑定，但 Inspector 没有捕获对应字节；无法显示或导出其当时内容。' :
        '选择有缓冲 payload 的 Draw 查看当时绑定的字节。';
      return;
    }
    selector.disabled = false;
    if (!bound.some(item => item.payloadId === state.selectedBufferPayloadId)) state.selectedBufferPayloadId = bound[0].payloadId;
    for (const item of bound) {
      const option = make('option', `#${item.payloadId} ${item.bufferLabel || `Buffer #${item.bufferId}`} · ${item.kind}${item.slot == null ? '' : ` ${item.slot}`}`);
      option.value = String(item.payloadId);
      selector.appendChild(option);
    }
    selector.value = String(state.selectedBufferPayloadId);
    const item = bound.find(value => value.payloadId === state.selectedBufferPayloadId);
    const payload = payloadFor(item.payloadId);
    if (!payload) { el('buffer-note').textContent = '报告中找不到这份 payload。'; return; }
    const url = assetUrl(payload.bufferFile);
    if (url) { save.hidden = false; save.href = url; save.download = `buffer-${item.bufferId}-draw-${event.commandIndex}-payload-${item.payloadId}.bin`; }
    el('buffer-note').textContent = `Buffer #${item.bufferId} ${item.bufferLabel || ''} · ${payload.bytes} 字节，来源绑定命令 #${item.sourceCommandIndex}，用于 Draw #${event.commandIndex}。这是绑定时捕获的字节，不是 Draw 后回读。` +
      (payload.bufferFile ? `下方仅显示前 ${payload.previewBytes ?? 0} 字节；二进制文件包含全部。` :
        `自动导出省略：${payload.bufferExportReason || '没有可用二进制文件'}。`);
    if (!payload.bufferFile) return;
    let bytes;
    try { bytes = Uint8Array.from(atob(payload.previewBase64 || ''), char => char.charCodeAt(0)); }
    catch { el('buffer-note').textContent += ' 预览字节解码失败。'; return; }
    const lines = [];
    for (let offset = 0; offset < bytes.length; offset += 16) {
      const row = bytes.slice(offset, offset + 16);
      lines.push(`${offset.toString(16).padStart(8, '0')}  ${[...row].map(byte => byte.toString(16).padStart(2, '0')).join(' ').padEnd(47)}  |${[...row].map(byte => byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '.').join('')}|`);
    }
    hex.textContent = lines.join('\n') || '空 payload';
    hex.hidden = false;
    const rows = el('buffer-rows');
    clear(rows);
    const view = new DataView(bytes.buffer);
    for (let offset = 0; offset + 4 <= bytes.length; offset += 4) {
      const tr = make('tr');
      const float = view.getFloat32(offset, true);
      for (const value of [offset.toString(16).padStart(8, '0'),
        [...bytes.slice(offset, offset + 4)].map(byte => byte.toString(16).padStart(2, '0')).join(' '),
        view.getUint32(offset, true), Number.isFinite(float) ? String(float) : String(float)]) tr.appendChild(make('td', value));
      rows.appendChild(tr);
    }
    table.hidden = rows.childElementCount === 0;
  }

  function selectResource(kind, index) {
    state.resourceKind = kind;
    state.selectedResource = index;
    renderResourceTabs();
    renderResources();
    renderResourceDetail();
    const panel = el('resource-panel');
    if (panel) panel.open = true;
    const scroll = el('inspector-scroll');
    if (scroll && panel) scroll.scrollTop = panel.offsetTop - scroll.offsetTop;
  }
  function renderResourceTabs() {
    const holder = el('resource-tabs');
    clear(holder);
    for (const [kind, label] of RESOURCE_KINDS) {
      const button = make('button', `${label} ${resourceArray(kind).length}`, 'tab');
      button.type = 'button';
      button.classList.toggle('active', kind === state.resourceKind);
      button.setAttribute('aria-pressed', kind === state.resourceKind ? 'true' : 'false');
      button.addEventListener('click', () => {
        state.resourceKind = kind;
        state.selectedResource = null;
        renderResourceTabs();
        renderResources();
        renderResourceDetail();
      });
      holder.appendChild(button);
    }
  }
  function renderResources() {
    const kind = state.resourceKind;
    const items = resourceArray(kind);
    const query = el('resource-search').value.trim().toLocaleLowerCase();
    el('resource-count').textContent = String(RESOURCE_KINDS.reduce((sum, [name]) => sum + resourceArray(name).length, 0));
    const holder = el('resource-list');
    clear(holder);
    let visible = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const haystack = [item?.id, item?.label, item?.code, item?.format, item?.imageFile]
        .map(printable).join(' ').toLocaleLowerCase();
      if (query && !haystack.includes(query)) continue;
      visible++;
      const button = make('button', undefined, 'list-button');
      button.type = 'button';
      button.classList.toggle('active', state.selectedResource === i);
      button.appendChild(make('span', `${printable(item?.label || kind.slice(0, -1))} · #${printable(item?.id ?? i)}`));
      const sub = kind === 'textures' ? [item?.width, item?.height, item?.format].filter(value => value !== undefined && value !== null).join(' × ') :
        kind === 'shaders' ? `${typeof item?.code === 'string' ? item.code.length : 0} 字符 WGSL` : '';
      if (sub) button.appendChild(make('span', sub, 'sub'));
      button.addEventListener('click', () => selectResource(kind, i));
      holder.appendChild(button);
    }
    if (!visible) holder.appendChild(make('p', items.length ? '没有符合条件的资源。' : '这类资源未记录。', 'empty'));
  }
  function renderResourceDetail() {
    const holder = el('resource-detail');
    clear(holder);
    const kind = state.resourceKind;
    const item = resourceArray(kind)[state.selectedResource];
    if (!item) { holder.appendChild(make('p', '选择资源查看图片、描述或 WGSL。', 'empty')); return; }
    const grid = make('dl', undefined, 'detail-grid');
    addDetailRow(grid, 'ID', item.id ?? state.selectedResource);
    addDetailRow(grid, '标签', item.label);
    if (item.format !== undefined) addDetailRow(grid, '格式', item.format);
    if (item.width !== undefined || item.height !== undefined) addDetailRow(grid, '尺寸', `${printable(item.width)} × ${printable(item.height)}`);
    holder.appendChild(grid);

    if (kind === 'textures') {
      const box = make('div', undefined, 'resource-preview');
      const url = assetUrl(item.imageFile);
      if (url) {
        const img = make('img');
        img.alt = `纹理 ${printable(item.label || item.id)} 的导出预览`;
        const problem = make('p', '纹理图片无法读取；仍可查看描述信息。', 'muted small');
        problem.hidden = true;
        img.addEventListener('error', () => { img.hidden = true; problem.hidden = false; });
        img.src = url;
        box.append(img, problem);
      } else {
        box.appendChild(make('p', item.imageFile ? '图片路径无效，已拒绝加载。' :
          `这张纹理没有导出的图片。${item.imageReason ? `原因：${item.imageReason}` : ''}`, 'muted small'));
      }
      holder.appendChild(box);
      if (item.imageFile) holder.appendChild(make('p',
        `来源：${item.imageSource || 'Inspector 纹理快照'}。仅代表捕获保存时的最终纹理状态，非任一 Draw 或 Pass 的当时输出。${item.imagePreviewTransform || ''}`,
        'inspect-note'));
    }
    if (kind === 'shaders') {
      if (typeof item.code === 'string' && item.code) {
        const section = make('section', undefined, 'data-section');
        section.append(make('label', 'WGSL 源码'), make('pre', item.code));
        holder.appendChild(section);
      } else holder.appendChild(make('p', '捕获未包含这条着色器的 WGSL 源码。', 'muted small'));
    }
    if (kind === 'pipelines') {
      const shaderIds = [...list(item.shaderIds), item.vertexShaderId, item.fragmentShaderId, item.computeShaderId,
        item.vertex?.shaderId, item.fragment?.shaderId, item.compute?.shaderId].filter(id => id !== undefined && id !== null);
      for (const id of new Set(shaderIds.map(String))) {
        const index = resourceIndexById('shaders', id);
        if (index < 0) continue;
        const button = make('button', `查看 WGSL #${id}`, 'inline-link');
        button.type = 'button';
        button.addEventListener('click', () => selectResource('shaders', index));
        holder.append(button, make('span', ' '));
      }
    }
    if (kind === 'buffers') {
      const captured = list(state.report?.payloads).filter(payload => list(payload.bufferIds).some(id => String(id) === String(item.id)));
      holder.appendChild(make('p', captured.length ?
        `记录了 ${captured.length} 份绑定时 payload。同一 Buffer 可在不同 Draw 有不同字节；请从 Pass → Draw 选择准确版本。` :
        'Inspector 未捕获这个 Buffer 的字节；只有资源描述，不能还原其内容。', 'inspect-note'));
    }
    const details = { ...item };
    delete details.code;
    delete details.imageFile;
    addDataSection(holder, '资源描述', details);
  }

  function renderErrors() {
    const errors = list(state.report?.validationErrors);
    const total = state.report?.validationErrorCount ?? errors.length;
    const sidecarErrors = list(state.report?.sidecarErrors);
    el('error-count').textContent = String(total + sidecarErrors.length);
    const holder = el('errors');
    clear(holder);
    if (!total && !sidecarErrors.length) { holder.appendChild(make('p', '报告未记录验证错误或 Sidecar 错误。', 'muted small')); return; }
    if (total && !errors.length) holder.appendChild(make('p', '报告记载验证错误数量，但未附明细。', 'muted small'));
    for (const error of errors) holder.appendChild(make('p', error?.message ?? error, 'error-item'));
    if (total > errors.length) holder.appendChild(make('p', `仅展示前 ${errors.length} 条。`, 'muted small'));
    for (const error of sidecarErrors) holder.appendChild(make('p',
      `Sidecar ${error?.file || ''}：${error?.reason || '未知错误'}`, 'error-item'));
  }

  function renderFrame() {
    const img = el('frame-image');
    const placeholder = el('frame-empty');
    const frame = state.selectedFrame === null ? null : selectedFrame();
    const pass = state.selectedPass === null ? null : passFor(state.selectedPass);
    const snapshot = list(pass?.snapshots)[0];
    const file = snapshot?.imageFile || (frame ? frame.imageFile : state.report?.frameImage);
    el('frame-note').textContent = snapshot ?
      `这张图是 Pass #${snapshot.passIndex}（${snapshot.label || ''}）结束后真实 GPU 读回（命令 #${snapshot.afterCommandIndex}，来源 ${snapshot.source}）。逐 Draw 输出未捕获。` :
      frame ? `帧边界按 queue.submit 推断。${frame.imageSource ? `图像来源：${frame.imageSource}。` : ''}${pass ? `该 Pass 没有独立读回${pass.outputUnavailableReason ? `：${pass.outputUnavailableReason}` : ''}；这里显示整帧画布。` : ''}逐 Draw 输出未捕获。` :
        `这里显示捕获保存时的最终画布状态；多帧时不代表每一帧。${pass?.outputUnavailableReason ? `该 Pass 输出未读回：${pass.outputUnavailableReason}。` : ''}逐 Draw 输出未捕获。`;
    const url = assetUrl(file);
    if (!url) {
      img.hidden = true;
      placeholder.textContent = file ? '帧图像路径无效，已拒绝加载。' :
        frame ? `该帧未保存画面；事件与资源仍可查看。${frame.imageReason ? `原因：${frame.imageReason}` : ''}` :
          '捕获未导出画布图像；事件与资源仍可查看。';
      placeholder.hidden = false;
      el('frame-size').textContent = '';
      return;
    }
    img.alt = snapshot ? `Pass #${snapshot.passIndex} 结束读回` : frame ? `第 ${frame.frameOrdinal} 帧导出的图像` : '捕获保存时的画布图像';
    img.onload = () => {
      img.hidden = false;
      placeholder.hidden = true;
      el('frame-size').textContent = `${img.naturalWidth} × ${img.naturalHeight}${snapshot ? ` · Pass #${snapshot.passIndex}` : frame ? ` · 第 ${frame.frameOrdinal} 帧` : ' · 保存时画布'}`;
    };
    img.onerror = () => {
      img.hidden = true;
      placeholder.hidden = false;
      placeholder.textContent = '帧图像无法读取；请检查分析目录中的导出文件。';
      el('frame-size').textContent = '';
    };
    img.src = url;
  }

  function renderPreviewMode() {
    const texture = state.previewMode === 'texture';
    el('frame-box').hidden = texture;
    el('texture-stage').hidden = !texture;
    el('frame-note').hidden = texture;
    el('texture-note').hidden = !texture;
    const frameButton = el('preview-frame-button');
    const textureButton = el('preview-texture-button');
    frameButton.classList.toggle('active', !texture);
    textureButton.classList.toggle('active', texture);
    frameButton.setAttribute('aria-pressed', String(!texture));
    textureButton.setAttribute('aria-pressed', String(texture));
    textureButton.disabled = !state.textureChoices.length;
  }

  function renderMode() {
    const gpu = state.mode === 'gpu';
    el('frame-workspace').hidden = gpu;
    el('gpu-workspace').hidden = !gpu;
    for (const [id, active] of [['mode-frame', !gpu], ['mode-gpu', gpu]]) {
      const button = el(id);
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    if (gpu) renderGpu();
  }

  function renderGpu() {
    const frame = selectedFrame();
    const passes = list(state.report?.passes).filter(pass => state.selectedFrame === null ||
      Number(pass?.frameOrdinal) === Number(state.selectedFrame));
    const measured = passes.filter(pass => pass.gpuTiming?.source === 'webgpu-timestamp-query' &&
      finite(pass.gpuTiming.durationMs) && pass.gpuTiming.durationMs >= 0);
    const bars = el('gpu-bars');
    const rows = el('gpu-table-body');
    clear(bars);
    clear(rows);
    const note = el('gpu-note');
    if (note) note.textContent = frame ? `第 ${frame.frameOrdinal} 帧 · Pass 实测时间戳；未测项留空。没有逐 Draw GPU 时间和历史曲线。` :
      '捕获中的 Pass 实测时间戳；未测项留空。没有逐 Draw GPU 时间和历史曲线。';
    if (!measured.length) {
      bars.appendChild(make('p', '此帧没有可用的 GPU Pass 时间戳。', 'empty'));
    }
    if (!passes.length) {
      const tr = make('tr');
      const td = make('td', '此帧没有 Pass。');
      td.colSpan = 5;
      tr.appendChild(td);
      rows.appendChild(tr);
      return;
    }
    measured.sort((a, b) => b.gpuTiming.durationMs - a.gpuTiming.durationMs);
    const total = measured.reduce((sum, pass) => sum + pass.gpuTiming.durationMs, 0);
    const max = measured[0]?.gpuTiming.durationMs || 1;
    for (const pass of measured) {
      const duration = pass.gpuTiming.durationMs;
      const row = make('button', undefined, 'gpu-bar-row');
      row.type = 'button';
      row.title = `查看 ${describePass(pass)}`;
      row.appendChild(make('span', describePass(pass), 'gpu-bar-label'));
      const track = make('span', undefined, 'gpu-bar-track');
      const fill = make('span', undefined, 'gpu-bar-fill');
      fill.style.width = `${Math.max(0.3, duration / max * 100)}%`;
      track.appendChild(fill);
      row.append(track, make('span', `${duration.toFixed(3)} ms`, 'gpu-bar-value'));
      row.addEventListener('click', () => {
        state.mode = 'frame';
        renderMode();
        selectPass(pass.index);
      });
      bars.appendChild(row);
    }
    const measuredDuration = pass => pass.gpuTiming?.source === 'webgpu-timestamp-query' &&
      finite(pass.gpuTiming.durationMs) && pass.gpuTiming.durationMs >= 0 ? pass.gpuTiming.durationMs : null;
    const tablePasses = [...passes].sort((a, b) => (measuredDuration(b) ?? -1) - (measuredDuration(a) ?? -1));
    for (const pass of tablePasses) {
      const duration = measuredDuration(pass);
      const percent = duration !== null && total > 0 ? `${(duration / total * 100).toFixed(1)}%` : '—';
      const tr = make('tr');
      tr.tabIndex = 0;
      tr.title = `查看 ${describePass(pass)}`;
      for (const value of [describePass(pass), pass.draws ?? 0, pass.dispatches ?? 0,
        duration === null ? '—' : duration.toFixed(6), percent]) tr.appendChild(make('td', value));
      const open = () => { state.mode = 'frame'; renderMode(); selectPass(pass.index); };
      tr.addEventListener('click', open);
      tr.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
      rows.appendChild(tr);
    }
  }

  function renderAll(report) {
    if (!report || typeof report !== 'object' || Array.isArray(report)) throw new Error('report.json 不是有效的报告对象');
    state.report = report;
    state.events = list(report.events);
    state.resources = report.resources && typeof report.resources === 'object' ? report.resources : {};
    const frames = list(report.frames);
    state.selectedFrame = frames.length && finite(Number(frames[frames.length - 1]?.frameOrdinal)) ?
      Number(frames[frames.length - 1].frameOrdinal) : null;
    state.frameFilter = state.selectedFrame;
    state.selectedEvent = state.events.findLastIndex(event =>
      (state.selectedFrame === null || Number(event?.frameOrdinal) === state.selectedFrame) &&
      eventKind(String(event?.method || '')) === 'draw');
    if (state.selectedEvent < 0) state.selectedEvent = state.events.findIndex(event =>
      state.selectedFrame === null || Number(event?.frameOrdinal) === state.selectedFrame);
    if (state.selectedEvent < 0) state.selectedEvent = null;
    state.selectedPass = state.selectedEvent === null ? null : state.events[state.selectedEvent]?.passIndex ?? null;
    if (state.selectedPass !== null) state.expandedPasses.add(String(state.selectedPass));
    el('fatal').textContent = '';
    renderTop();
    renderFrameSelector();
    renderPasses();
    renderEvents();
    renderEventDetail();
    renderTextureInspector();
    renderBufferInspector();
    renderFrame();
    renderPreviewMode();
    renderMode();
    renderResourceTabs();
    renderResources();
    renderResourceDetail();
    renderErrors();
    if (state.selectedEvent !== null) el('event-tree').querySelector(`[data-event-index="${state.selectedEvent}"]`)?.scrollIntoView({ block: 'center' });
  }

  function loadOfflineReport() {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = './viewer-data.js';
      script.onload = () => window.__GAMEDRAFT_CAPTURE_REPORT__ ?
        resolve(window.__GAMEDRAFT_CAPTURE_REPORT__) : reject(new Error('viewer-data.js 没有提供捕获报告'));
      script.onerror = () => reject(new Error('找不到 viewer-data.js；请双击分析输出目录中的 viewer.html'));
      document.body.appendChild(script);
    });
  }
  async function loadReport() {
    if (location.protocol === 'file:') return loadOfflineReport();
    const jobId = new URLSearchParams(location.search).get('jobId');
    if (!jobId) throw new Error('缺少 jobId；请从 F2 抓帧任务打开查看器');
    const url = new URL(location.href);
    url.searchParams.set('jobId', jobId);
    url.searchParams.set('file', 'report.json');
    const response = await fetch(url.href, { cache: 'no-store' });
    if (!response.ok) throw new Error(`读取 report.json 失败：HTTP ${response.status}`);
    return response.json();
  }

  function applyEventFilter() {
    state.eventLimit = PAGE_SIZE;
    renderEvents();
    if (state.navigationIndices.length && !state.navigationIndices.slice(0, PAGE_SIZE).includes(state.selectedEvent)) {
      selectEvent(state.navigationIndices[0], true);
    }
  }
  el('event-search').addEventListener('input', applyEventFilter);
  el('event-kind').addEventListener('change', applyEventFilter);
  el('event-prev').addEventListener('click', () => {
    const index = state.navigationIndices.indexOf(state.selectedEvent);
    if (index > 0) selectEvent(state.navigationIndices[index - 1], true);
  });
  el('event-next').addEventListener('click', () => {
    const index = state.navigationIndices.indexOf(state.selectedEvent);
    if (index < state.navigationIndices.length - 1) selectEvent(state.navigationIndices[index + 1], true);
  });
  el('event-range').addEventListener('input', () => {
    const index = state.navigationIndices[Number(el('event-range').value)];
    if (index !== undefined) selectEvent(index, true);
  });
  el('mode-frame').addEventListener('click', () => { state.mode = 'frame'; renderMode(); });
  el('mode-gpu').addEventListener('click', () => { state.mode = 'gpu'; renderMode(); });
  el('preview-frame-button').addEventListener('click', () => { state.previewMode = 'frame'; renderPreviewMode(); });
  el('preview-texture-button').addEventListener('click', () => { state.previewMode = 'texture'; renderPreviewMode(); });
  el('frame-select').addEventListener('change', () => {
    state.frameFilter = el('frame-select').value === 'all' ? null : Number(el('frame-select').value);
    state.selectedFrame = state.frameFilter;
    state.selectedPass = null;
    state.eventLimit = PAGE_SIZE;
    state.selectedEvent = state.events.findIndex(event =>
      (state.frameFilter === null || Number(event?.frameOrdinal) === state.frameFilter) &&
      eventKind(String(event?.method || '')) === 'draw');
    if (state.selectedEvent < 0) state.selectedEvent = state.events.findIndex(event =>
      state.frameFilter === null || Number(event?.frameOrdinal) === state.frameFilter);
    if (state.selectedEvent < 0) state.selectedEvent = null;
    if (state.selectedEvent !== null && state.events[state.selectedEvent]?.frameOrdinal != null) {
      state.selectedFrame = Number(state.events[state.selectedEvent].frameOrdinal);
    }
    state.selectedPass = state.selectedEvent === null ? null : state.events[state.selectedEvent]?.passIndex ?? null;
    state.expandedPasses.clear();
    if (state.selectedPass !== null) state.expandedPasses.add(String(state.selectedPass));
    renderPasses();
    renderEvents();
    renderEventDetail();
    state.selectedTextureKey = null;
    state.selectedBufferPayloadId = null;
    state.previewMode = 'frame';
    renderTextureInspector();
    renderBufferInspector();
    renderFrame();
    renderPreviewMode();
    if (state.mode === 'gpu') renderGpu();
    if (state.selectedEvent !== null) el('event-tree').querySelector(`[data-event-index="${state.selectedEvent}"]`)?.scrollIntoView({ block: 'center' });
  });
  el('clear-pass').addEventListener('click', () => {
    state.selectedPass = null;
    state.eventLimit = PAGE_SIZE;
    renderPasses();
    renderEvents();
    renderTextureInspector();
    renderBufferInspector();
    renderFrame();
    if (state.mode === 'gpu') renderGpu();
  });
  el('event-more').addEventListener('click', () => { state.eventLimit += PAGE_SIZE; renderEvents(); });
  el('resource-search').addEventListener('input', renderResources);
  el('texture-channel').addEventListener('change', applyTextureControls);
  el('texture-exposure').addEventListener('input', applyTextureControls);
  el('texture-zoom').addEventListener('change', applyTextureControls);
  el('buffer-select').addEventListener('change', () => { state.selectedBufferPayloadId = Number(el('buffer-select').value); renderBufferInspector(); });
  loadReport().then(renderAll, error => showError(error instanceof Error ? error.message : String(error)));
}());
