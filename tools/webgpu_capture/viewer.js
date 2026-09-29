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
    frameChoice: null,
    selectedBufferPayloadId: null,
    previewMode: 'frame',
    mode: 'frame',
    inspectorPage: 'detail',
    pipelineStage: 'input',
    focusScope: 'draw',
    activeSurface: null,
    navigationIndices: [],
    expandedPasses: new Set(),
    expandedCategories: new Set(),
    expandedBatches: new Set(),
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
  const PASS_CATEGORIES = { canvas: '画布合成', offscreen: '离屏渲染', filter: '滤镜', mask: '遮罩' };
  function passCategory(pass) {
    if (pass?.type === 'compute') return { key: 'compute', label: 'Compute' };
    const prefix = typeof pass?.label === 'string' ? pass.label.split(' / ', 1)[0] : '';
    return { key: PASS_CATEGORIES[prefix] ? prefix : 'unlabeled',
      label: PASS_CATEGORIES[prefix] || '未标注阶段' };
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
    surface.setSource(null);
    empty(el('event-tree'), '暂无事件');
    empty(el('event-detail'), '暂无事件详情');
    empty(el('resource-list'), '暂无资源');
    empty(el('resource-detail'), '暂无资源详情');
  }

  const rawCache = new Map();
  const bufferCache = new Map();
  const surface = window.createGameDraftSurfaceInspector(el('surface-mount'), onPixelPicked);
  function setInspectorPage(page) {
    state.inspectorPage = page;
    for (const button of el('inspector-tabs').querySelectorAll('button[data-page]')) {
      const active = button.dataset.page === page;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    for (const name of ['detail', 'pipeline', 'inputs', 'buffers', 'resources', 'errors']) {
      el(`page-${name}`).hidden = name !== page;
    }
    el('inspector-scroll').scrollTop = 0;
  }
  function setupSplitter(handle, host, cssVariable, orientation) {
    const vertical = orientation === 'vertical';
    const lower = vertical ? 220 : 180;
    const reserve = vertical ? 320 : 170;
    const setPosition = client => {
      const rect = host.getBoundingClientRect();
      const span = vertical ? rect.width : rect.height;
      if (span < lower + reserve) return;
      const position = Math.max(lower, Math.min(span - reserve,
        client - (vertical ? rect.left : rect.top)));
      host.style.setProperty(cssVariable, `${Math.round(position)}px`);
      handle.setAttribute('aria-valuenow', String(Math.round(position)));
    };
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      setPosition(vertical ? event.clientX : event.clientY);
    });
    handle.addEventListener('pointermove', event => {
      if (handle.hasPointerCapture(event.pointerId)) setPosition(vertical ? event.clientX : event.clientY);
    });
    handle.addEventListener('pointerup', event => {
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    });
    handle.addEventListener('keydown', event => {
      const delta = (vertical ? event.key === 'ArrowRight' : event.key === 'ArrowDown') ? 20 :
        (vertical ? event.key === 'ArrowLeft' : event.key === 'ArrowUp') ? -20 : 0;
      if (!delta) return;
      event.preventDefault();
      const rect = handle.getBoundingClientRect();
      setPosition((vertical ? rect.left : rect.top) + delta);
    });
  }
  function halfFloat(bits) {
    const sign = bits & 0x8000 ? -1 : 1;
    const exponent = (bits >> 10) & 31;
    const mantissa = bits & 1023;
    if (!exponent) return sign * 2 ** -14 * mantissa / 1024;
    if (exponent === 31) return mantissa ? NaN : sign * Infinity;
    return sign * 2 ** (exponent - 15) * (1 + mantissa / 1024);
  }
  async function readNativePixel(snapshot, x, y) {
    const url = assetUrl(snapshot?.rawFile);
    if (!url || !Number.isInteger(snapshot.rawBytesPerRow) || !Number.isInteger(snapshot.width) ||
        !Number.isInteger(snapshot.height) || x >= snapshot.width || y >= snapshot.height) return null;
    const format = snapshot.rawFormat || snapshot.format;
    const bpp = /^(bgra8unorm|rgba8unorm|bgra8unorm-srgb|rgba8unorm-srgb)$/.test(format) ? 4 :
      format === 'rgba16float' ? 8 : format === 'rgba32float' ? 16 : 0;
    if (!bpp || snapshot.rawBytesPerRow < snapshot.width * bpp) return null;
    let promise = rawCache.get(url);
    if (!promise) {
      promise = fetch(url).then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.arrayBuffer();
      });
      rawCache.set(url, promise);
      if (rawCache.size > 3) rawCache.delete(rawCache.keys().next().value);
    }
    const bytes = await promise;
    const offset = y * snapshot.rawBytesPerRow + x * bpp;
    if (offset + bpp > bytes.byteLength) return null;
    const view = new DataView(bytes, offset, bpp);
    let channels;
    if (bpp === 4) {
      channels = [view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)];
      if (format.startsWith('bgra')) channels = [channels[2], channels[1], channels[0], channels[3]];
      return { values: channels.map(value => value / 255), raw8: channels, format };
    }
    channels = Array.from({ length: 4 }, (_, index) => bpp === 8 ? halfFloat(view.getUint16(index * 2, true)) :
      view.getFloat32(index * 4, true));
    return { values: channels, format };
  }
  function onPixelPicked(pixel) {
    const marker = `${pixel.x}, ${pixel.y}`;
    const png = pixel.rgba8 ? `PNG RGBA8 ${pixel.rgba8.join(', ')}` : `PNG 像素不可读：${pixel.reason || '未知原因'}`;
    const snapshot = state.activeSurface?.snapshot;
    const at = state.activeSurface?.url;
    const display = el('pixel-value');
    display.textContent = `${marker} · ${png} · 读取原始 RT…`;
    if (!snapshot?.rawFile) {
      display.textContent = `${marker} · ${png} · ${snapshot ? '此捕获无原始 RT sidecar' : '仅 PNG 显示值'}`;
      return;
    }
    readNativePixel(snapshot, pixel.x, pixel.y).then(native => {
      if (state.activeSurface?.url !== at || surface.getState().pixel?.x !== pixel.x ||
          surface.getState().pixel?.y !== pixel.y) return;
      display.textContent = native ? `${marker} · RT ${native.format} RGBA (${native.values.map(value =>
        Number.isFinite(value) ? Number(value.toPrecision(7)) : String(value)).join(', ')})${native.raw8 ?
        ` · bytes ${native.raw8.join(', ')}` : ''} · ${png}` : `${marker} · ${png} · 原始 RT 格式不可读`;
    }, error => {
      if (state.activeSurface?.url === at) display.textContent = `${marker} · ${png} · 原始 RT 读取失败：${error.message}`;
    });
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
      let categoryContainer = null;
      let categoryKey = null;
      let categoryCount = null;
      let categoryLength = 0;
      let batchContainer = null;
      let batchGroup = null;
      let batchSubject = null;
      let batchCount = null;
      let batchLength = 0;
      for (const node of nodes) {
        if (node.type === 'event') {
          categoryContainer = null;
          categoryKey = null;
          batchContainer = null;
          batchSubject = null;
          const group = make('div', undefined, 'tree-children');
          appendEvents(group, [node.value]);
          holder.appendChild(group);
          continue;
        }
        const pass = node.value;
        const category = passCategory(pass);
        if (category.key !== categoryKey) {
          categoryKey = category.key;
          categoryLength = 0;
          batchContainer = null;
          batchSubject = null;
          const categoryGroup = make('details', undefined, 'tree-category');
          categoryGroup.open = state.expandedCategories.has(category.key) || !!query;
          const summary = make('summary', undefined, 'tree-category-head');
          summary.appendChild(make('span', category.label, 'tree-label'));
          categoryCount = make('span', '', 'tree-meta');
          summary.appendChild(categoryCount);
          categoryGroup.appendChild(summary);
          categoryContainer = make('div', undefined, 'tree-category-children');
          categoryGroup.appendChild(categoryContainer);
          categoryGroup.addEventListener('toggle', () => {
            if (categoryGroup.open) state.expandedCategories.add(category.key);
            else state.expandedCategories.delete(category.key);
          });
          holder.appendChild(categoryGroup);
        }
        categoryLength++;
        categoryCount.textContent = `${categoryLength} Pass`;
        let passContainer = categoryContainer;
        if (category.key === 'filter' || category.key === 'mask') {
          const segments = typeof pass.label === 'string' ? pass.label.split(' / ') : [];
          const subject = (segments[1] || category.label).replace(/gaussian-blur-(horizontal|vertical)-kernel-\d+/g, 'gaussian-blur');
          const begins = String(segments[2] || '').startsWith('input') || String(segments[2] || '').startsWith('raster');
          if (!batchContainer || begins || subject !== batchSubject) {
            batchSubject = subject;
            batchLength = 0;
            const batchKey = `${ordinal ?? 'all'}:${pass.index}`;
            batchGroup = make('details', undefined, 'tree-batch');
            batchGroup.open = state.expandedBatches.has(batchKey) || !!query;
            const summary = make('summary', undefined, 'tree-batch-head');
            summary.appendChild(make('span', subject, 'tree-label'));
            batchCount = make('span', '', 'tree-meta');
            summary.appendChild(batchCount);
            batchGroup.appendChild(summary);
            batchContainer = make('div', undefined, 'tree-batch-children');
            batchGroup.appendChild(batchContainer);
            const currentBatchGroup = batchGroup;
            batchGroup.addEventListener('toggle', () => {
              if (currentBatchGroup.open) state.expandedBatches.add(batchKey);
              else state.expandedBatches.delete(batchKey);
            });
            categoryContainer.appendChild(batchGroup);
          }
          batchLength++;
          batchCount.textContent = `${batchLength} Pass`;
          if (Number(state.selectedPass) === Number(pass.index)) batchGroup.open = true;
          passContainer = batchContainer;
        }
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
        passContainer.appendChild(group);
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
    state.focusScope = 'draw';
    if (event.passIndex !== null && event.passIndex !== undefined) {
      state.selectedPass = Number(event.passIndex);
      state.expandedPasses.add(String(event.passIndex));
      state.expandedCategories.add(passCategory(passFor(event.passIndex)).key);
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
    state.focusScope = 'pass';
    if (pass.frameOrdinal !== null && pass.frameOrdinal !== undefined) {
      state.selectedFrame = Number(pass.frameOrdinal);
      renderFrameSelector();
    }
    const firstDraw = state.events.findIndex(event => Number(event?.passIndex) === Number(index) &&
      ['draw', 'dispatch'].includes(eventKind(String(event?.method || ''))));
    state.selectedEvent = firstDraw < 0 ? null : firstDraw;
    state.expandedPasses.add(String(index));
    state.expandedCategories.add(passCategory(pass).key);
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
    const pass = state.selectedPass == null ? null : passFor(state.selectedPass);
    if (!event && !pass) {
      el('detail-index').textContent = '';
      holder.appendChild(make('p', '从左侧选择 Pass 或 Draw。', 'empty'));
      renderPipelineDetail();
      renderBindingDetail();
      return;
    }
    el('detail-index').textContent = state.focusScope === 'pass' && pass ? describePass(pass) :
      `命令 #${printable(event?.commandIndex ?? state.selectedEvent)}`;
    const grid = make('dl', undefined, 'detail-grid');
    if (pass) {
      addDetailRow(grid, 'Pass', describePass(pass));
      addDetailRow(grid, '类别', passCategory(pass).label);
      addDetailRow(grid, '帧 / 命令', `${printable(pass.frameOrdinal)} / ${printable(pass.beginCommand)}–${printable(pass.endCommand)}`);
      addDetailRow(grid, 'Draw / Dispatch', `${pass.draws ?? 0} / ${pass.dispatches ?? 0}`);
      addDetailRow(grid, 'GPU 时间', pass.gpuTiming?.source === 'webgpu-timestamp-query' && finite(pass.gpuTiming.durationMs) ?
        `${pass.gpuTiming.durationMs.toFixed(6)} ms` : '未测量');
      addDetailRow(grid, 'Pass 输出', list(pass.snapshots).length ? `${pass.snapshots.length} 张 GPU 结束读回` :
        `无读回${pass.outputUnavailableReason ? `：${pass.outputUnavailableReason}` : ''}`);
    }
    if (event) {
      addDetailRow(grid, '选中命令', `#${printable(event.commandIndex)} ${printable(event.method)}`);
      addDetailRow(grid, '调用参数', list(event.args).join(', ') || '—');
      addDetailRow(grid, '管线', event.pipelineId == null ? '未绑定' : `#${event.pipelineId} ${event.pipelineLabel || ''}`);
    }
    const pipeline = resourceArray('pipelines').find(item => String(item.id) === String(event?.pipelineId));
    if (pipeline) {
      const entryPoints = [pipeline.descriptor?.vertex?.entryPoint, pipeline.descriptor?.fragment?.entryPoint,
        pipeline.descriptor?.compute?.entryPoint].filter(Boolean);
      if (entryPoints.length) addDetailRow(grid, '入口', entryPoints.join(' / '));
    }
    holder.appendChild(grid);
    const jumps = make('div', undefined, 'resource-jumps');
    for (const [page, label] of [['pipeline', '检查管线'], ['inputs', '检查输入 / 输出'], ['buffers', '检查 Buffer']]) {
      const button = make('button', label, 'plain-button');
      button.type = 'button';
      button.addEventListener('click', () => setInspectorPage(page));
      jumps.appendChild(button);
    }
    holder.appendChild(jumps);
    if (event) {
      const raw = make('details', undefined, 'data-section');
      raw.appendChild(make('summary', '原始命令数据'));
      raw.appendChild(pre(event));
      holder.appendChild(raw);
    }
    renderPipelineDetail();
    renderBindingDetail();
  }

  function focusedDraw() {
    const event = state.events[state.selectedEvent];
    if (event && ['draw', 'dispatch'].includes(eventKind(String(event.method || '')))) return event;
    const pass = state.selectedPass == null ? null : passFor(state.selectedPass);
    return pass ? state.events.find(item => Number(item?.passIndex) === Number(pass.index) &&
      ['draw', 'dispatch'].includes(eventKind(String(item?.method || '')))) : null;
  }
  function pipelineForEvent(event) {
    return resourceArray('pipelines').find(item => String(item.id) === String(event?.pipelineId));
  }
  function shaderForStage(pipeline, stage) {
    const moduleId = pipeline?.descriptor?.[stage]?.module?.__id;
    return resourceArray('shaders').find(item => String(item.id) === String(moduleId)) ||
      resourceArray('shaders').find(item => list(pipeline?.shaderIds).some(id => String(id) === String(item.id)));
  }
  function table(container, headers, rows, onRow) {
    const node = make('table', undefined, 'binding-table');
    const head = make('thead');
    const htr = make('tr');
    for (const label of headers) htr.appendChild(make('th', label));
    head.appendChild(htr);
    node.appendChild(head);
    const body = make('tbody');
    for (const row of rows) {
      const tr = make('tr');
      for (const value of row) tr.appendChild(make('td', value));
      if (onRow) { tr.tabIndex = 0; tr.addEventListener('click', () => onRow(row));
        tr.addEventListener('keydown', event => { if (event.key === 'Enter') onRow(row); }); }
      body.appendChild(tr);
    }
    node.appendChild(body);
    container.appendChild(node);
  }
  function previewTexture(id) {
    const option = state.textureChoices.find(item => String(item.id) === String(id));
    if (option) {
      state.selectedTextureKey = option.key;
      state.previewMode = 'texture';
      renderTextureInspector();
      renderPreviewMode();
    } else if (resourceIndexById('textures', id) >= 0) selectResource('textures', resourceIndexById('textures', id));
  }
  function renderPipelineDetail() {
    const holder = el('pipeline-detail');
    clear(holder);
    const draw = focusedDraw();
    const pipeline = pipelineForEvent(draw);
    if (!pipeline) { holder.appendChild(make('p', '所选 Pass / 命令没有可用管线描述。', 'empty')); return; }
    const descriptor = pipeline.descriptor || {};
    const compute = pipeline.type === 'ComputePipeline' || !!descriptor.compute;
    const stages = compute ? [['compute', 'Compute', descriptor.compute?.entryPoint || '—']] :
      [['input', '顶点输入', `${list(draw.vertexBuffers).length} 个 Buffer`],
       ['vertex', 'Vertex Shader', descriptor.vertex?.entryPoint || '—'],
       ['raster', '光栅化', descriptor.primitive?.topology || '—'],
       ['fragment', 'Fragment Shader', descriptor.fragment?.entryPoint || '—'],
       ['output', '输出合并', `${list(draw.targets).length} 个附件`]];
    if (!stages.some(([key]) => key === state.pipelineStage)) state.pipelineStage = stages[0][0];
    const flow = make('div', undefined, 'flow');
    if (compute) flow.style.gridTemplateColumns = 'minmax(120px,1fr)';
    for (const [key, label, sub] of stages) {
      const button = make('button', undefined, 'flow-node');
      button.type = 'button';
      button.classList.toggle('active', state.pipelineStage === key);
      button.append(make('b', label), make('span', sub));
      button.addEventListener('click', () => { state.pipelineStage = key; renderPipelineDetail(); });
      flow.appendChild(button);
    }
    holder.appendChild(flow);
    holder.appendChild(make('p', `Pipeline #${pipeline.id} · ${pipeline.label || pipeline.type || '未命名'} · Draw #${draw.commandIndex}`, 'muted small'));
    const stage = state.pipelineStage;
    if (stage === 'input') {
      holder.appendChild(make('h3', '顶点缓冲与布局', 'section-caption'));
      const rows = list(draw.vertexBuffers).map(buffer => {
        const layout = descriptor.vertex?.buffers?.[buffer.slot];
        const attrs = list(layout?.attributes).map(attr => `location ${attr.shaderLocation}: ${attr.format} @${attr.offset}`).join('；');
        return [`${buffer.slot}`, `#${buffer.id} ${buffer.label || ''}`, `${layout?.arrayStride ?? '—'} B / ${layout?.stepMode || '—'}`, attrs || '—'];
      });
      table(holder, ['Slot', 'Buffer', 'Stride', 'Attributes'], rows);
      if (draw.indexBuffer) holder.appendChild(make('p', `索引：#${draw.indexBuffer.id} ${draw.indexBuffer.label || ''} · ${draw.indexBuffer.format || '格式未记载'}`, 'data-section'));
      return;
    }
    if (stage === 'raster') {
      const grid = make('dl', undefined, 'detail-grid');
      addDetailRow(grid, 'Topology', descriptor.primitive?.topology);
      addDetailRow(grid, 'Cull Mode', descriptor.primitive?.cullMode);
      addDetailRow(grid, 'Front Face', descriptor.primitive?.frontFace || '默认');
      addDetailRow(grid, 'Viewport', list(draw.viewport).join(', ') || '未单独设置');
      addDetailRow(grid, 'Scissor', draw.scissorRect ? list(draw.scissorRect).join(', ') : '未单独设置');
      addDetailRow(grid, 'Depth / Stencil', descriptor.depthStencil ? safeJson(descriptor.depthStencil, 4000) : '未启用');
      holder.appendChild(grid);
      return;
    }
    if (stage === 'output') {
      holder.appendChild(make('h3', 'Pass 输出附件', 'section-caption'));
      table(holder, ['Slot', 'Texture', '格式', 'Load / Store'], list(draw.targets).map(target =>
        [target.kind === 'color' ? `Color ${target.slot}` : target.kind,
          `#${target.outputTextureId ?? target.textureId} ${target.outputTextureLabel || target.textureLabel || ''}`,
          target.format || '—', `${target.loadOp || '—'} / ${target.storeOp || '—'}`]));
      holder.appendChild(make('h3', '混合 / 写入', 'section-caption'));
      addDataSection(holder, 'Fragment targets', descriptor.fragment?.targets);
      return;
    }
    const shaderStage = stage === 'compute' ? 'compute' : stage;
    const shader = shaderForStage(pipeline, shaderStage);
    const entry = descriptor[shaderStage]?.entryPoint;
    holder.appendChild(make('h3', `${stage === 'vertex' ? 'Vertex Shader' : stage === 'fragment' ? 'Fragment Shader' : 'Compute Shader'} · ${entry || '入口未记载'}`, 'section-caption'));
    if (!shader?.code) { holder.appendChild(make('p', '这份捕获没有该阶段的 WGSL 源码。', 'muted')); return; }
    const link = make('button', `打开 WGSL #${shader.id}`, 'inline-link');
    link.type = 'button';
    link.addEventListener('click', () => selectResource('shaders', resourceIndexById('shaders', shader.id)));
    holder.appendChild(link);
    const source = make('details', undefined, 'data-section');
    source.append(make('summary', '查看 WGSL 源码'), make('pre', shader.code));
    holder.appendChild(source);
  }

  function shaderBindingNames(pipeline) {
    const names = new Map();
    for (const id of list(pipeline?.shaderIds)) {
      const shader = resourceArray('shaders').find(item => String(item.id) === String(id));
      const code = shader?.code || '';
      const pattern = /@group\s*\(\s*(\d+)\s*\)\s*@binding\s*\(\s*(\d+)\s*\)\s*var(?:\s*<[^>]*>)?\s+([A-Za-z_]\w*)\s*:\s*([^;]+);/g;
      for (const match of code.matchAll(pattern)) names.set(`${match[1]}:${match[2]}`, { name: match[3], type: match[4].trim() });
    }
    return names;
  }
  function renderBindingDetail() {
    const holder = el('binding-detail');
    clear(holder);
    const pass = state.selectedPass == null ? null : passFor(state.selectedPass);
    const focused = focusedDraw();
    const draws = state.focusScope === 'pass' && pass ? state.events.filter(item =>
      Number(item?.passIndex) === Number(pass.index) && ['draw', 'dispatch'].includes(eventKind(String(item?.method || '')))) :
      focused ? [focused] : [];
    if (!pass && !draws.length) { holder.appendChild(make('p', '选择 Pass 或 Draw 查看绑定。', 'empty')); return; }
    holder.appendChild(make('p', state.focusScope === 'pass' ? `汇总这个 Pass 的 ${draws.length} 个 Draw / Dispatch；同一槽位有多个值时分别列出。` :
      `命令 #${focused?.commandIndex} 的绑定状态。`, 'muted small'));
    holder.appendChild(make('h3', '输出附件', 'section-caption'));
    const targets = list(pass?.targets || focused?.targets);
    if (!targets.length) holder.appendChild(make('p', '没有已记录的输出附件。', 'muted'));
    else {
      const outputRows = targets.map(target => ({ target,
        values: [`${target.kind} ${target.slot ?? ''}`, `#${target.outputTextureId ?? target.textureId} ${target.outputTextureLabel || target.textureLabel || ''}`,
          target.format || '—', `${target.loadOp || '—'} / ${target.storeOp || '—'}`] }));
      const node = make('table', undefined, 'binding-table');
      node.innerHTML = '<thead><tr><th>目标</th><th>纹理</th><th>格式</th><th>Load / Store</th><th>查看</th></tr></thead>';
      const body = make('tbody');
      for (const row of outputRows) {
        const tr = make('tr');
        for (const value of row.values) tr.appendChild(make('td', value));
        const cell = make('td');
        const button = make('button', '预览输出');
        button.type = 'button';
        button.addEventListener('click', () => previewTexture(row.target.outputTextureId ?? row.target.textureId));
        cell.appendChild(button);
        tr.appendChild(cell);
        body.appendChild(tr);
      }
      node.appendChild(body);
      holder.appendChild(node);
    }
    holder.appendChild(make('h3', '绑定输入', 'section-caption'));
    const rows = new Map();
    for (const draw of draws) {
      const names = shaderBindingNames(pipelineForEvent(draw));
      for (const group of list(draw.bindGroups)) for (const entry of list(group.resources)) {
        const resource = entry?.resource || {};
        const name = names.get(`${group.slot}:${entry.binding}`);
        const id = resource.textureId ?? resource.id;
        const kind = resource.textureId != null ? 'Texture' : resource.type || 'Unknown';
        const key = `${group.slot}:${entry.binding}:${kind}:${id}:${resource.offset ?? ''}:${resource.size ?? ''}`;
        if (!rows.has(key)) rows.set(key, { group: group.slot, binding: entry.binding, name,
          resource, id, kind, draws: [] });
        rows.get(key).draws.push(draw.commandIndex);
      }
    }
    if (!rows.size) holder.appendChild(make('p', '未记录 Bind Group 输入。', 'muted'));
    else {
      const node = make('table', undefined, 'binding-table');
      node.innerHTML = '<thead><tr><th>Group / Binding</th><th>WGSL 名称 / 类型</th><th>资源</th><th>Draw</th><th>查看</th></tr></thead>';
      const body = make('tbody');
      for (const row of rows.values()) {
        const tr = make('tr');
        tr.appendChild(make('td', `${row.group} / ${row.binding}`));
        tr.appendChild(make('td', row.name ? `${row.name.name} · ${row.name.type}` : 'WGSL 名称未记录'));
        tr.appendChild(make('td', `${row.kind} #${row.id} ${row.resource.label || ''}${row.kind === 'Buffer' ?
          ` · offset ${row.resource.offset ?? 0}, size ${row.resource.size ?? '—'} B` : ''}`));
        tr.appendChild(make('td', [...new Set(row.draws)].map(id => `#${id}`).join(', ')));
        const cell = make('td');
        if (row.kind === 'Texture') {
          const button = make('button', '预览纹理');
          button.type = 'button';
          button.addEventListener('click', () => previewTexture(row.id));
          cell.appendChild(button);
        } else if (row.kind === 'Buffer') {
          const button = make('button', '查看字节');
          button.type = 'button';
          button.addEventListener('click', () => {
            const matching = draws.find(draw => list(draw.bufferPayloads).some(item =>
              item.slot === row.group && item.binding === row.binding && String(item.bufferId) === String(row.id)));
            if (!matching) { selectResource('buffers', resourceIndexById('buffers', row.id)); return; }
            state.selectedEvent = state.events.indexOf(matching);
            state.focusScope = 'draw';
            state.selectedBufferPayloadId = list(matching.bufferPayloads).find(item =>
              item.slot === row.group && item.binding === row.binding && String(item.bufferId) === String(row.id))?.payloadId;
            renderBufferInspector();
            setInspectorPage('buffers');
          });
          cell.appendChild(button);
        }
        tr.appendChild(cell);
        body.appendChild(tr);
      }
      node.appendChild(body);
      holder.appendChild(node);
    }
  }

  function textureOptions() {
    const event = state.events[state.selectedEvent];
    const pass = state.selectedPass !== null ? passFor(state.selectedPass) :
      event?.passIndex != null ? passFor(event.passIndex) : null;
    const drawSelected = state.focusScope === 'draw' && event && ['draw', 'dispatch'].includes(eventKind(String(event.method || ''))) &&
      (state.selectedPass === null || Number(event.passIndex) === Number(state.selectedPass));
    const draws = drawSelected ? [event] : pass ? state.events.filter(item =>
      Number(item?.passIndex) === Number(pass.index) && ['draw', 'dispatch'].includes(eventKind(String(item?.method || '')))) : [];
    const options = [];
    const seen = new Set();
    const writersFor = id => list(state.report?.passes).filter(item =>
      list(item.targets).some(target => String(target.outputTextureId ?? target.textureId) === String(id)));
    const add = (id, role, label, snapshot) => {
      if (id == null) return;
      const texture = resourceArray('textures').find(item => String(item.id) === String(id));
      if (!texture) return;
      const key = `${role}:${id}`;
      if (seen.has(key)) return;
      seen.add(key);
      let evidence = snapshot ? 'this-pass' : 'capture-final';
      let file = snapshot ? snapshot.imageFile : texture.imageFile;
      if (role === '绑定输入' && pass) {
        const writers = writersFor(id);
        const earlier = writers.filter(item => Number(item.endCommand) < Number(pass.beginCommand))
          .sort((a, b) => Number(b.endCommand) - Number(a.endCommand));
        if (earlier.length) {
          const latest = earlier[0];
          snapshot = list(latest.snapshots).find(item => String(item.textureId) === String(id)) || null;
          evidence = snapshot ? 'upstream-pass' : 'upstream-unavailable';
          file = snapshot?.imageFile || null;
        } else if (writers.length) {
          snapshot = null;
          evidence = 'later-write';
          file = null;
        }
      }
      options.push({ key, id, role, label: label || texture.label || `纹理 #${id}`, texture, snapshot,
        file, evidence });
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

  function renderTextureInspector() {
    const { options, pass, drawSelected } = textureOptions();
    state.textureChoices = options;
    el('texture-count').textContent = `${options.length} 张`;
    el('texture-scope').textContent = drawSelected ? `Draw #${state.events[state.selectedEvent].commandIndex}` :
      pass ? `Pass #${pass.index}` : '帧';
    const holder = el('texture-choices');
    clear(holder);
    if (!options.length) holder.appendChild(make('p', pass ? '这个 Pass 没有可识别的纹理资源。' : '尚未选择绘制事件。', 'muted small'));
    if (!options.some(item => item.key === state.selectedTextureKey)) {
      state.selectedTextureKey = (options.find(item => item.snapshot) || options.find(item => item.file) || options[0])?.key ?? null;
    }
    if (options.length) {
      const select = make('select');
      select.setAttribute('aria-label', '选择 Pass 输出或绑定纹理');
      select.style.maxWidth = 'none';
      select.style.width = '100%';
      for (const item of options) {
        const evidence = item.evidence === 'upstream-pass' ? `上游 Pass #${item.snapshot.passIndex}` :
          item.evidence === 'this-pass' ? '本 Pass 结束' : item.evidence === 'later-write' ? '最终状态已变化' :
          item.file ? '捕获最终' : '无图像';
        const option = make('option', `${item.role} · #${item.id} ${item.label} [${evidence}]`);
        option.value = item.key;
        select.appendChild(option);
      }
      select.value = state.selectedTextureKey;
      select.addEventListener('change', () => {
        state.selectedTextureKey = select.value;
        state.previewMode = 'texture';
        renderTextureInspector();
        renderPreviewMode();
      });
      holder.appendChild(select);
    }
    const selected = options.find(item => item.key === state.selectedTextureKey);
    el('texture-note').textContent = !selected ? '选择 Pass 或 Draw 后检查绑定纹理。' : !selected.file ?
      `#${selected.id} ${selected.texture.format || ''} · ${selected.texture.width} × ${selected.texture.height}。${selected.evidence === 'later-write' ? '该纹理随后被写入，最终图不能代表此刻输入。' : selected.evidence === 'upstream-unavailable' ? '最近一次上游写入无读回图，不能还原此刻输入。' : `没有图像：${selected.texture.imageReason || '捕获未提供纹理字节'}。`}` : selected.evidence === 'upstream-pass' ?
      `当前 Pass 输入来自上游 Pass #${selected.snapshot.passIndex} 的结束 GPU 读回（命令 #${selected.snapshot.afterCommandIndex}）。` : selected.snapshot ?
      `真实 Pass 结束读回：第 ${selected.snapshot.frameOrdinal} 帧 Pass #${selected.snapshot.passIndex}（${selected.snapshot.label || ''}），结束命令 #${selected.snapshot.afterCommandIndex}；来源 ${selected.snapshot.source}；格式 ${selected.snapshot.format || selected.texture.format || '未知'}。` :
      `Inspector 纹理 mip0 最终状态快照，非所选 Draw / Pass 当时的输入。${selected.texture.imagePreviewTransform || ''}`;
  }

  function renderBufferInspector() {
    const event = state.events[state.selectedEvent];
    const bound = event && ['draw', 'dispatch'].includes(eventKind(String(event.method || ''))) ?
      list(event.bufferPayloads) : [];
    const selector = el('buffer-select');
    clear(selector);
    el('buffer-count').textContent = `${bound.length} 份`;
    const save = el('buffer-save');
    const loadFull = el('buffer-load-full');
    const hex = el('buffer-hex');
    const table = el('buffer-table-wrap');
    save.hidden = loadFull.hidden = hex.hidden = table.hidden = true;
    el('buffer-page-status').textContent = '';
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
    const bindingNames = shaderBindingNames(pipelineForEvent(event));
    for (const item of bound) {
      const symbol = item.slot != null && item.binding != null ? bindingNames.get(`${item.slot}:${item.binding}`)?.name : null;
      const option = make('option', `#${item.payloadId} ${symbol ? `${symbol} · ` : ''}${item.bufferLabel || `Buffer #${item.bufferId}`} · ${item.kind}${item.slot == null ? '' : ` ${item.slot}`}`);
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
      (payload.bufferFile ? `下方显示指定偏移的 256 字节；二进制文件包含全部。` :
        `自动导出省略：${payload.bufferExportReason || '没有可用二进制文件'}。`);
    if (!payload.bufferFile) return;
    let bytes;
    try { bytes = bufferCache.get(payload.id) || Uint8Array.from(atob(payload.previewBase64 || ''), char => char.charCodeAt(0)); }
    catch { el('buffer-note').textContent += ' 预览字节解码失败。'; return; }
    const allLoaded = bytes.byteLength >= payload.bytes;
    loadFull.hidden = allLoaded;
    const requested = Number(el('buffer-offset').value);
    const offset = Number.isFinite(requested) ? Math.max(0, Math.min(payload.bytes - 1, Math.floor(requested / 4) * 4)) : 0;
    if (offset >= bytes.length) {
      el('buffer-page-status').textContent = `偏移 ${offset} 超过已加载的 ${bytes.length} 字节；请载入完整字节。`;
      return;
    }
    const page = bytes.subarray(offset, Math.min(offset + 256, bytes.length));
    el('buffer-page-status').textContent = `${offset}–${offset + page.length - 1} / ${payload.bytes - 1} 字节${allLoaded ? '' : ' · 当前仅有报告预览'}`;
    const lines = [];
    for (let position = 0; position < page.length; position += 16) {
      const row = page.subarray(position, position + 16);
      lines.push(`${(offset + position).toString(16).padStart(8, '0')}  ${[...row].map(byte => byte.toString(16).padStart(2, '0')).join(' ').padEnd(47)}  |${[...row].map(byte => byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '.').join('')}|`);
    }
    hex.textContent = lines.join('\n') || '空 payload';
    hex.hidden = false;
    const rows = el('buffer-rows');
    clear(rows);
    const view = new DataView(page.buffer, page.byteOffset, page.byteLength);
    for (let position = 0; position + 4 <= page.length; position += 4) {
      const tr = make('tr');
      const float = view.getFloat32(position, true);
      for (const value of [(offset + position).toString(16).padStart(8, '0'),
        [...page.subarray(position, position + 4)].map(byte => byte.toString(16).padStart(2, '0')).join(' '),
        view.getUint32(position, true), Number.isFinite(float) ? String(float) : String(float)]) tr.appendChild(make('td', value));
      rows.appendChild(tr);
    }
    table.hidden = rows.childElementCount === 0;
  }

  function selectResource(kind, index) {
    if (index < 0) return;
    state.resourceKind = kind;
    state.selectedResource = index;
    renderResourceTabs();
    renderResources();
    renderResourceDetail();
    setInspectorPage('resources');
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
    const frame = state.selectedFrame === null ? null : selectedFrame();
    const pass = state.selectedPass === null ? null : passFor(state.selectedPass);
    const snapshot = list(pass?.snapshots)[0];
    const file = snapshot ? snapshot.imageFile : frame ? frame.imageFile : state.report?.frameImage;
    state.frameChoice = { file, snapshot, frame, pass,
      label: snapshot ? describePass(pass) : frame ? `第 ${frame.frameOrdinal} 帧画布` : '捕获保存时画布',
      format: snapshot?.format || frame?.format || null,
      source: snapshot ? 'Pass 结束 GPU 读回' : frame ? frame.imageSource || '帧画布' : '捕获最终画布',
      width: snapshot?.width || frame?.width || null,
      height: snapshot?.height || frame?.height || null };
    el('frame-note').textContent = snapshot ?
      `这张图是 Pass #${snapshot.passIndex}（${snapshot.label || ''}）结束后真实 GPU 读回（命令 #${snapshot.afterCommandIndex}，来源 ${snapshot.source}）。逐 Draw 输出未捕获。` :
      frame ? `帧边界按 queue.submit 推断。${frame.imageSource ? `图像来源：${frame.imageSource}。` : ''}${pass ? `该 Pass 没有独立读回${pass.outputUnavailableReason ? `：${pass.outputUnavailableReason}` : ''}；这里显示整帧画布。` : ''}逐 Draw 输出未捕获。` :
        `这里显示捕获保存时的最终画布状态；多帧时不代表每一帧。${pass?.outputUnavailableReason ? `该 Pass 输出未读回：${pass.outputUnavailableReason}。` : ''}逐 Draw 输出未捕获。`;
  }

  function renderPreviewMode() {
    const texture = state.previewMode === 'texture';
    el('frame-note').hidden = texture;
    el('texture-note').hidden = !texture;
    const frameButton = el('preview-frame-button');
    const textureButton = el('preview-texture-button');
    frameButton.classList.toggle('active', !texture);
    textureButton.classList.toggle('active', texture);
    frameButton.setAttribute('aria-pressed', String(!texture));
    textureButton.setAttribute('aria-pressed', String(texture));
    textureButton.disabled = !state.textureChoices.length;
    const selected = state.textureChoices.find(item => item.key === state.selectedTextureKey);
    const choice = texture ? selected && {
      file: selected.file, snapshot: selected.snapshot,
      label: `${selected.role} · ${selected.label}`,
      format: selected.snapshot?.format || selected.texture?.format,
      source: selected.evidence === 'upstream-pass' ? `上游 Pass #${selected.snapshot.passIndex} 结束 GPU 读回` :
        selected.snapshot ? '本 Pass 结束 GPU 读回' : '捕获最终状态快照',
      width: selected.snapshot?.width || selected.texture?.width,
      height: selected.snapshot?.height || selected.texture?.height,
      id: selected.id,
    } : state.frameChoice;
    const url = assetUrl(choice?.file);
    const save = el('texture-save');
    save.hidden = !url;
    if (url) {
      save.href = url;
      save.download = texture ? `texture-${selected.id}${selected.snapshot ? '-pass-end' : '-capture-final'}.png` :
        choice.snapshot ? `pass-${choice.snapshot.passIndex}-output.png` : 'frame-output.png';
    }
    const signature = `${url || ''}|${choice?.label || ''}|${choice?.source || ''}`;
    if (state.activeSurface?.signature !== signature || state.activeSurface?.snapshot !== choice?.snapshot) {
      state.activeSurface = { url, signature, snapshot: choice?.snapshot || null };
      el('texture-zoom').value = 'fit';
      el('pixel-value').textContent = '点击画面查看坐标和 RGBA 值；Ctrl+滚轮缩放，滚轮平移，拖动平移。';
      surface.setSource(url ? { url, label: choice.label, format: choice.format,
        source: choice.source, width: choice.width, height: choice.height } : null).then(result => {
        if (state.activeSurface?.url === url) el('frame-size').textContent = result.imageWidth ?
          `${result.imageWidth} × ${result.imageHeight} · ${choice.format || 'PNG'}` : '';
      });
    }
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
    if (state.selectedPass !== null) state.expandedCategories.add(passCategory(passFor(state.selectedPass)).key);
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
  for (const button of el('inspector-tabs').querySelectorAll('button[data-page]')) {
    button.addEventListener('click', () => setInspectorPage(button.dataset.page));
  }
  setupSplitter(el('hierarchy-splitter'), el('frame-workspace'), '--tree-width', 'vertical');
  setupSplitter(el('preview-splitter'), document.querySelector('.frame-main'), '--preview-height', 'horizontal');
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
    state.focusScope = 'draw';
    state.expandedPasses.clear();
    state.expandedCategories.clear();
    if (state.selectedPass !== null) state.expandedPasses.add(String(state.selectedPass));
    if (state.selectedPass !== null) state.expandedCategories.add(passCategory(passFor(state.selectedPass)).key);
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
    state.focusScope = 'draw';
    state.eventLimit = PAGE_SIZE;
    renderPasses();
    renderEvents();
    renderEventDetail();
    renderTextureInspector();
    renderBufferInspector();
    renderFrame();
    renderPreviewMode();
    if (state.mode === 'gpu') renderGpu();
  });
  el('event-more').addEventListener('click', () => { state.eventLimit += PAGE_SIZE; renderEvents(); });
  el('resource-search').addEventListener('input', renderResources);
  el('texture-channel').addEventListener('change', () => surface.setChannel(el('texture-channel').value));
  el('texture-exposure').addEventListener('input', () => {
    const exposure = Number(el('texture-exposure').value);
    surface.setExposure(exposure);
    el('texture-exposure-value').textContent = `${exposure > 0 ? '+' : ''}${exposure} EV`;
  });
  el('texture-zoom').addEventListener('change', () => {
    if (el('texture-zoom').value !== 'custom') surface.setZoom(el('texture-zoom').value);
  });
  el('surface-mount').addEventListener('wheel', event => {
    if (!event.ctrlKey) return;
    const select = el('texture-zoom');
    let option = select.querySelector('option[value="custom"]');
    if (!option) { option = make('option'); option.value = 'custom'; select.appendChild(option); }
    option.textContent = `${Math.round(surface.getState().zoomPercent)}% 自定义`;
    select.value = 'custom';
  });
  el('buffer-select').addEventListener('change', () => {
    state.selectedBufferPayloadId = Number(el('buffer-select').value);
    el('buffer-offset').value = '0';
    renderBufferInspector();
  });
  el('buffer-offset').addEventListener('change', renderBufferInspector);
  el('buffer-load-full').addEventListener('click', async () => {
    const id = state.selectedBufferPayloadId;
    const payload = payloadFor(id);
    const url = assetUrl(payload?.bufferFile);
    if (!url) return;
    const button = el('buffer-load-full');
    button.disabled = true;
    button.textContent = '正在加载…';
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength !== payload.bytes) throw new Error(`字节数 ${bytes.byteLength}，报告记载 ${payload.bytes}`);
      bufferCache.set(id, bytes);
      if (bufferCache.size > 2) bufferCache.delete(bufferCache.keys().next().value);
      if (state.selectedBufferPayloadId === id) renderBufferInspector();
    } catch (error) { el('buffer-note').textContent += ` 完整字节读取失败：${error.message}`; }
    finally { button.disabled = false; button.textContent = '载入完整字节'; }
  });
  loadReport().then(renderAll, error => showError(error instanceof Error ? error.message : String(error)));
}());
