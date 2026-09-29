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
    selectedPass: null,
    selectedEvent: null,
    eventLimit: PAGE_SIZE,
    resourceKind: 'textures',
    selectedResource: null,
  };
  const el = id => document.getElementById(id);
  const list = value => Array.isArray(value) ? value : [];
  const printable = value => value === null || value === undefined || value === '' ? '—' : String(value);
  const finite = value => typeof value === 'number' && Number.isFinite(value);

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
    empty(el('event-list'), '暂无事件');
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
    el('timing-note').textContent = timing && finite(timing.sumPassDurationMs)
      ? `报告包含 ${printable(timing.timedPasses)} 个 pass 的时长字段，合计 ${timing.sumPassDurationMs} ms；具体计时来源和精度以捕获工具为准。这里不推算逐 draw GPU 耗时。`
      : '捕获中没有 GPU 时间戳。这里可检查命令和资源，不能用 Draw 数或 Pass 数推断 GPU 耗时。';
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
    select.value = state.selectedFrame === null ? 'all' : String(state.selectedFrame);
  }

  function renderPasses() {
    const passes = list(state.report?.passes);
    const visible = state.selectedFrame === null ? passes : passes.filter(pass =>
      pass?.frameOrdinal !== null && pass?.frameOrdinal !== undefined &&
      Number(pass.frameOrdinal) === Number(state.selectedFrame));
    el('pass-count').textContent = state.selectedFrame === null ? `${passes.length} 个` : `${visible.length} / ${passes.length}`;
    const holder = el('pass-list');
    clear(holder);
    if (!visible.length) { holder.appendChild(make('p', passes.length ? '所选帧没有 Pass 摘要。' : '报告没有 Pass 摘要。', 'empty')); return; }
    for (const pass of visible) {
      const button = make('button', undefined, 'list-button');
      button.type = 'button';
      button.classList.toggle('active', state.selectedPass !== null && Number(state.selectedPass) === Number(pass.index));
      button.appendChild(make('span', describePass(pass)));
      const count = pass.type === 'compute' ? `${pass.dispatches ?? 0} dispatch` : `${pass.draws ?? 0} draw`;
      const timing = finite(pass.durationMs) ? ` · 记录时长 ${pass.durationMs} ms` : '';
      button.appendChild(make('span', `${count} · 命令 ${printable(pass.beginCommand)}–${printable(pass.endCommand)}${timing}`, 'sub'));
      button.addEventListener('click', () => {
        state.selectedPass = pass.index;
        state.eventLimit = PAGE_SIZE;
        renderPasses();
        renderEvents();
      });
      holder.appendChild(button);
    }
  }

  function eventMatches(event, query, kind) {
    const method = String(event?.method || '');
    if (kind !== 'all' && eventKind(method) !== kind) return false;
    if (state.selectedFrame !== null && (event?.frameOrdinal === null || event?.frameOrdinal === undefined ||
        Number(event.frameOrdinal) !== Number(state.selectedFrame))) return false;
    if (state.selectedPass !== null && (event?.passIndex === null || event?.passIndex === undefined ||
        Number(event.passIndex) !== Number(state.selectedPass))) return false;
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
    el('event-count').textContent = `${matches.length} / ${state.events.length}`;
    const holder = el('event-list');
    clear(holder);
    if (!matches.length) {
      holder.appendChild(make('p', state.events.length ? '没有符合条件的事件。' : '报告没有事件明细；可查看 Pass 与统计。', 'empty'));
    }
    for (const index of matches.slice(0, state.eventLimit)) {
      const event = state.events[index];
      const button = make('button', undefined, 'list-button');
      button.type = 'button';
      button.classList.toggle('active', state.selectedEvent === index);
      button.appendChild(make('span', `#${printable(event.commandIndex ?? index)} ${printable(event.method)}`));
      const pipeline = event.pipelineLabel || event.pipelineId;
      const pass = event.passIndex === null || event.passIndex === undefined ? '帧级' : `Pass ${event.passIndex}`;
      button.appendChild(make('span', pipeline ? `${pass} · ${pipeline}` : pass, 'sub'));
      button.addEventListener('click', () => {
        state.selectedEvent = index;
        renderEvents();
        renderEventDetail();
      });
      holder.appendChild(button);
    }
    el('event-list-status').textContent = `显示 ${Math.min(matches.length, state.eventLimit)} / ${matches.length} 条`;
    el('event-more').hidden = matches.length <= state.eventLimit;
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
    addDetailRow(grid, '管线', event.pipelineLabel || event.pipelineId);
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

  function selectResource(kind, index) {
    state.resourceKind = kind;
    state.selectedResource = index;
    renderResourceTabs();
    renderResources();
    renderResourceDetail();
    el('resource-detail').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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
    const details = { ...item };
    delete details.code;
    delete details.imageFile;
    addDataSection(holder, '资源描述', details);
  }

  function renderErrors() {
    const errors = list(state.report?.validationErrors);
    const total = state.report?.validationErrorCount ?? errors.length;
    el('error-count').textContent = String(total);
    const holder = el('errors');
    clear(holder);
    if (!total) { holder.appendChild(make('p', '报告未记录验证错误。', 'muted small')); return; }
    if (!errors.length) { holder.appendChild(make('p', '报告记载错误数量，但未附明细。', 'muted small')); return; }
    for (const error of errors) holder.appendChild(make('p', error?.message ?? error, 'error-item'));
    if (total > errors.length) holder.appendChild(make('p', `仅展示前 ${errors.length} 条。`, 'muted small'));
  }

  function renderFrame() {
    const img = el('frame-image');
    const placeholder = el('frame-empty');
    const frame = state.selectedFrame === null ? null : selectedFrame();
    const file = frame ? frame.imageFile : state.report?.frameImage;
    el('frame-note').textContent = frame
      ? `帧边界按 queue.submit 推断。${frame.imageSource ? `图像来源：${frame.imageSource}。` : ''}选中事件只显示记录状态，不生成该 draw 单独的输出图。`
      : '显示捕获保存时的画布图像；连抓时不代表每一帧。选中事件只显示记录状态，不生成该 draw 单独的输出图。';
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
    img.alt = frame ? `第 ${frame.frameOrdinal} 帧导出的图像` : '捕获保存时的画布图像';
    img.onload = () => {
      img.hidden = false;
      placeholder.hidden = true;
      el('frame-size').textContent = `${img.naturalWidth} × ${img.naturalHeight}${frame ? ` · 第 ${frame.frameOrdinal} 帧` : ' · 保存时画布'}`;
    };
    img.onerror = () => {
      img.hidden = true;
      placeholder.hidden = false;
      placeholder.textContent = '帧图像无法读取；请检查分析目录中的导出文件。';
      el('frame-size').textContent = '';
    };
    img.src = url;
  }

  function renderAll(report) {
    if (!report || typeof report !== 'object' || Array.isArray(report)) throw new Error('report.json 不是有效的报告对象');
    state.report = report;
    state.events = list(report.events);
    state.resources = report.resources && typeof report.resources === 'object' ? report.resources : {};
    const frames = list(report.frames);
    state.selectedFrame = frames.length && finite(Number(frames[frames.length - 1]?.frameOrdinal)) ?
      Number(frames[frames.length - 1].frameOrdinal) : null;
    state.selectedEvent = state.events.findIndex(event =>
      (state.selectedFrame === null || Number(event?.frameOrdinal) === state.selectedFrame) &&
      eventKind(String(event?.method || '')) === 'draw');
    if (state.selectedEvent < 0) state.selectedEvent = state.events.findIndex(event =>
      state.selectedFrame === null || Number(event?.frameOrdinal) === state.selectedFrame);
    if (state.selectedEvent < 0) state.selectedEvent = null;
    el('fatal').textContent = '';
    renderTop();
    renderFrameSelector();
    renderPasses();
    renderEvents();
    renderEventDetail();
    renderFrame();
    renderResourceTabs();
    renderResources();
    renderResourceDetail();
    renderErrors();
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

  el('event-search').addEventListener('input', () => { state.eventLimit = PAGE_SIZE; renderEvents(); });
  el('event-kind').addEventListener('change', () => { state.eventLimit = PAGE_SIZE; renderEvents(); });
  el('frame-select').addEventListener('change', () => {
    state.selectedFrame = el('frame-select').value === 'all' ? null : Number(el('frame-select').value);
    state.selectedPass = null;
    state.eventLimit = PAGE_SIZE;
    state.selectedEvent = state.events.findIndex(event =>
      (state.selectedFrame === null || Number(event?.frameOrdinal) === state.selectedFrame) &&
      eventKind(String(event?.method || '')) === 'draw');
    if (state.selectedEvent < 0) state.selectedEvent = state.events.findIndex(event =>
      state.selectedFrame === null || Number(event?.frameOrdinal) === state.selectedFrame);
    if (state.selectedEvent < 0) state.selectedEvent = null;
    renderPasses();
    renderEvents();
    renderEventDetail();
    renderFrame();
  });
  el('clear-pass').addEventListener('click', () => {
    state.selectedPass = null;
    state.eventLimit = PAGE_SIZE;
    renderPasses();
    renderEvents();
  });
  el('event-more').addEventListener('click', () => { state.eventLimit += PAGE_SIZE; renderEvents(); });
  el('resource-search').addEventListener('input', renderResources);
  loadReport().then(renderAll, error => showError(error instanceof Error ? error.message : String(error)));
}());
