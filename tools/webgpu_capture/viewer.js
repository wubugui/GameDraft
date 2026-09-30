// Shared by the Vite capture route and a self-contained analysis directory.
// All capture-owned strings enter the page through textContent, never HTML.
(function () {
  'use strict';

  const RESOURCE_KINDS = [
    ['textures', '纹理'],
    ['shaders', '着色器'],
    ['pipelines', '管线'],
    ['buffers', '缓冲'],
    ['samplers', '采样器'],
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
    selectedOutputKey: null,
    outputChoices: [],
    textureWrites: new Map(),
    textureViews: new Map(),
    frameChoice: null,
    selectedBufferPayloadId: null,
    preferredBufferBinding: null,
    previewMode: 'frame',
    mode: 'frame',
    pipelineStage: 'input',
    meshLocation: null,
    meshSelectionKey: null,
    focusScope: 'draw',
    activeSurface: null,
    navigationIndices: [],
    expandedFrames: new Set(),
    collapsedFrames: new Set(),
    expandedPasses: new Set(),
    collapsedPasses: new Set(),
    expandedCategories: new Set(),
    collapsedCategories: new Set(),
    expandedBatches: new Set(),
    collapsedBatches: new Set(),
    expandedSteps: new Set(),
    collapsedSteps: new Set(),
    pixelTimeline: null,
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
  function treePassLabel(pass, withinEffect) {
    const label = pass?.frameDebugStep?.logicalLabel || pass?.label || `${pass?.type || 'pass'} pass`;
    if (['unlabeled', 'other'].includes(passCategory(pass).key)) {
      if (!/^engine2d pass \d+$/i.test(label.trim())) return label;
      const target = list(pass.targets).find(item => item.kind === 'color') || list(pass.targets)[0];
      const targetId = target?.outputTextureId ?? target?.textureId;
      const targetName = target?.outputTextureLabel || target?.textureLabel ||
        (targetId != null ? `纹理 #${targetId}` : '');
      const pipelines = new Map();
      for (const event of state.events) {
        if (Number(event?.passIndex) !== Number(pass.index) ||
          !['draw', 'dispatch'].includes(eventKind(String(event?.method || ''))) || event.pipelineId == null) continue;
        pipelines.set(String(event.pipelineId), event.pipelineLabel || `Pipeline #${event.pipelineId}`);
      }
      const pipelineClue = pipelines.size > 1 ? `${pipelines.size} 条管线` : [...pipelines.values()][0] || '';
      return `未标注 Pass #${pass.index}${targetName ? ` → ${targetName}` : ''}${pipelineClue ? ` · ${pipelineClue}` : ''}`;
    }
    const parts = label.split(' / ');
    return parts.length >= 3 ? parts.slice(withinEffect ? 2 : 1).join(' / ') :
      parts.length === 2 ? parts[1] : label;
  }
  function postDrawSnapshots(pass, event) {
    if (!pass?.frameDebugStep || !event || eventKind(String(event.method || '')) !== 'draw' ||
        Number(pass.frameDebugStep.drawCommandIndex) !== Number(event.commandIndex) ||
        Number(event.passIndex) !== Number(pass.index)) return [];
    return list(pass.snapshots).filter(snapshot => snapshot?.captureMoment === 'post-draw' &&
      Number(snapshot.drawCommandIndex) === Number(event.commandIndex) &&
      Number(snapshot.passIndex) === Number(pass.index) &&
      Number(snapshot.frameOrdinal) === Number(pass.frameOrdinal));
  }
  function hasRawFloat(snapshot) {
    const bytesPerPixel = ({ r16float: 2, rg16float: 4, rgba16float: 8,
      r32float: 4, rg32float: 8, rgba32float: 16 })[snapshot?.rawFormat] || 0;
    return !!assetUrl(snapshot?.rawFile) && !!bytesPerPixel &&
      Number.isSafeInteger(snapshot.width) && snapshot.width > 0 &&
      Number.isSafeInteger(snapshot.height) && snapshot.height > 0 &&
      Number.isSafeInteger(snapshot.rawBytesPerRow) &&
      snapshot.rawBytesPerRow >= snapshot.width * bytesPerPixel &&
      Number.isSafeInteger(snapshot.rawByteLength) &&
      snapshot.rawByteLength === snapshot.rawBytesPerRow * snapshot.height &&
      snapshot.rawByteLength <= 512 * 1024 * 1024;
  }
  const PASS_CATEGORIES = { canvas: '画布合成', offscreen: '离屏渲染', filter: '滤镜', mask: '遮罩' };
  function passCategory(pass) {
    if (pass?.type === 'compute') return { key: 'compute', label: 'Compute' };
    const prefix = typeof pass?.label === 'string' ? pass.label.split(' / ', 1)[0] : '';
    if (PASS_CATEGORIES[prefix]) return { key: prefix, label: PASS_CATEGORIES[prefix] };
    if (!prefix || /^engine2d pass \d+$/i.test(prefix.trim())) {
      return { key: 'unlabeled', label: '未标注阶段' };
    }
    return { key: 'other', label: '其他' };
  }
  function treeEffectSubject(pass, category) {
    const segments = (pass.frameDebugStep?.logicalLabel || pass.label || '').split(' / ');
    return `${category.label} · ${(segments[1] || pass.label || '未命名')
      .replace(/gaussian-blur-(horizontal|vertical)-kernel-\d+/g, 'gaussian-blur')}`;
  }
  function treeEffectBegins(pass) {
    const segments = (pass.frameDebugStep?.logicalLabel || pass.label || '').split(' / ');
    return (!pass.frameDebugStep || pass.frameDebugStep.drawOrdinal === 1) &&
      (String(segments[2] || '').startsWith('input') || String(segments[2] || '').startsWith('raster'));
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

  const bufferCache = new Map();
  const bufferPending = new Map();
  const bufferErrors = new Map();
  const surface = window.createGameDraftSurfaceInspector(el('surface-mount'), onPixelPicked);
  function setInspectorPage(page) {
    const target = el(`page-${page}`);
    if (!target) return;
    target.open = true;
    target.scrollIntoView({ block: 'start' });
  }
  function setupSplitter(handle, host, cssVariable, orientation) {
    const vertical = orientation === 'vertical';
    const lower = vertical ? 300 : 320;
    const reserve = vertical ? 320 : 150;
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

  let pixelTimelineAbort = null;
  let pixelTimelineGeneration = 0;
  function clearPixelTimeline(message = '选择 Pass 输出并点击像素，查看这一帧真实 RT 读回中的数值轨迹。') {
    pixelTimelineAbort?.abort();
    pixelTimelineAbort = null;
    pixelTimelineGeneration++;
    state.pixelTimeline = null;
    el('pixel-timeline-status').textContent = '';
    empty(el('pixel-timeline'), message);
  }
  function pixelTimelineTarget() {
    if (state.previewMode !== 'frame') return null;
    const choice = state.outputChoices.find(item => item.key === state.selectedOutputKey);
    const snapshot = choice?.snapshot;
    if (!choice || !snapshot) return null;
    return {
      textureId: snapshot.textureId,
      frameOrdinal: Number(snapshot.frameOrdinal),
      aspect: snapshot.aspect || null,
      format: snapshot.rawFormat,
      width: snapshot.width,
      height: snapshot.height,
      sampleIndex: snapshot.sampleIndex ?? 0,
      role: choice.role,
    };
  }
  function pixelTimelineEntries(target) {
    const entries = [];
    for (const pass of list(state.report?.passes)) {
      if (Number(pass.frameOrdinal) !== target.frameOrdinal) continue;
      const attached = list(pass.targets).some(item => target.aspect ?
        item.kind === 'depth-stencil' && String(item.textureId) === String(target.textureId) :
        item.kind === 'color' && String(item.outputTextureId ?? item.textureId) === String(target.textureId));
      if (!attached) continue;
      const snapshots = target.aspect ? list(pass.aspectSnapshots) : list(pass.snapshots);
      const snapshot = snapshots.find(item => String(item.textureId) === String(target.textureId) &&
        (item.aspect || null) === target.aspect && Number(item.sampleIndex ?? 0) === Number(target.sampleIndex));
      let gap = !snapshot?.rawFile ? snapshot?.rawReason || snapshot?.reason ||
        pass.outputUnavailableReason || '此 Pass 没有原始 RT 读回' : null;
      if (!gap && (snapshot.rawFormat !== target.format || snapshot.width !== target.width ||
          snapshot.height !== target.height)) gap = '格式或尺寸与所选输出不同';
      entries.push({ pass, snapshot, gap,
        commandIndex: Number(snapshot?.afterCommandIndex ?? pass.endCommand),
        drawCommandIndex: snapshot?.captureMoment === 'post-draw' ? snapshot.drawCommandIndex : null });
    }
    return entries.sort((a, b) => a.commandIndex - b.commandIndex || Number(a.pass.index) - Number(b.pass.index));
  }
  function pixelValueText(sample) {
    if (!sample) return '—';
    if (sample.format === 'stencil8') return `Stencil ${sample.values[0]}`;
    const values = sample.format.endsWith('8unorm') || sample.format.endsWith('8unorm-srgb') ?
      sample.values.map(value => Math.round(value * 255)) :
      sample.values.map(value => Number.isFinite(value) ? Number(value.toPrecision(8)) : String(value));
    return `${sample.format.startsWith('bgra') || sample.format.startsWith('rgba') ? 'RGBA' : sample.format} (${values.join(', ')})`;
  }
  function samePixelValue(left, right) {
    return left?.format === right?.format && left.rawBytes.length === right.rawBytes.length &&
      left.rawBytes.every((value, index) => value === right.rawBytes[index]);
  }
  function highlightPixelTimeline() {
    const holder = el('pixel-timeline');
    for (const row of holder.querySelectorAll('[data-timeline-pass]')) {
      row.classList.toggle('pixel-current', Number(row.dataset.timelinePass) === Number(state.selectedPass));
    }
  }
  function beginPixelTimeline(pixel) {
    const target = pixelTimelineTarget();
    const clickKey = `${state.activeSurface?.signature || ''}:${pixel.x}:${pixel.y}`;
    if (state.pixelTimeline?.clickKey === clickKey) return;
    clearPixelTimeline();
    if (!target || !Number.isSafeInteger(target.frameOrdinal) || target.textureId == null) return;
    const holder = el('pixel-timeline');
    const panel = el('page-pixel-timeline');
    panel.open = true;
    panel.scrollIntoView({ block: 'start' });
    if (!state.frameChoice?.snapshot?.rawFile || !target.format) {
      empty(holder, '所选输出只有 PNG 或无读回，不能生成原始像素观测轨迹。');
      return;
    }
    const entries = pixelTimelineEntries(target);
    if (!entries.length) {
      empty(holder, '这一帧没有该输出纹理的 Pass 记录。');
      return;
    }
    const controller = new AbortController();
    pixelTimelineAbort = controller;
    const generation = ++pixelTimelineGeneration;
    const trace = { ...target, x: pixel.x, y: pixel.y, clickKey, entries, observations: [] };
    state.pixelTimeline = trace;
    clear(holder);
    const heading = make('div', undefined, 'pixel-timeline-head');
    heading.appendChild(make('strong', `${target.role} · Texture #${target.textureId} · 第 ${target.frameOrdinal} 帧 · (${pixel.x}, ${pixel.y})`));
    const exportButton = make('button', '导出观测 JSON', 'plain-button');
    exportButton.type = 'button';
    exportButton.disabled = true;
    heading.appendChild(exportButton);
    holder.appendChild(heading);
    holder.appendChild(make('p', '只列真实 Pass / Draw 结束的原始 RT 读回。数值变化不证明片元命中、深度测试结果或 Shader 输出；缺读回处标为断档。', 'inspect-note'));
    const wrap = make('div', undefined, 'pixel-timeline-wrap');
    const tableNode = make('table', undefined, 'pixel-timeline-table');
    const thead = make('thead');
    const labels = ['观测点', '结束命令', '原始像素值', '相对上次读回'];
    const headerRow = make('tr');
    for (const label of labels) headerRow.appendChild(make('th', label));
    thead.appendChild(headerRow);
    tableNode.appendChild(thead);
    const tbody = make('tbody');
    for (const entry of entries) {
      const row = make('tr');
      row.dataset.timelinePass = String(entry.pass.index);
      const point = make('td');
      const action = make('button', entry.drawCommandIndex != null ?
        `Draw #${entry.drawCommandIndex} · P${entry.pass.index}` : `Pass #${entry.pass.index} 结束`, 'inline-link');
      action.type = 'button';
      action.title = describePass(entry.pass);
      action.addEventListener('click', () => {
        const index = entry.drawCommandIndex == null ? -1 : state.events.findIndex(event =>
          Number(event?.commandIndex) === Number(entry.drawCommandIndex) &&
          Number(event?.passIndex) === Number(entry.pass.index));
        if (index >= 0) selectEvent(index, true);
        else selectPass(entry.pass.index);
      });
      point.appendChild(action);
      row.append(point, make('td', `#${printable(entry.commandIndex)}`));
      entry.valueCell = make('td', entry.gap ? '未读回' : '读取中…');
      entry.changeCell = make('td', entry.gap ? '断档' : '—');
      row.append(entry.valueCell, entry.changeCell);
      if (entry.gap) {
        row.classList.add('pixel-gap');
        entry.valueCell.title = entry.gap;
      }
      tbody.appendChild(row);
    }
    tableNode.appendChild(tbody);
    wrap.appendChild(tableNode);
    holder.appendChild(wrap);
    highlightPixelTimeline();
    el('pixel-timeline-status').textContent = `${entries.length} 个目标 Pass · 读取中`;
    void (async () => {
      let previous = null;
      let changes = 0;
      let gaps = 0;
      for (const entry of entries) {
        if (controller.signal.aborted || generation !== pixelTimelineGeneration) return;
        let sample = null;
        let reason = entry.gap;
        if (!reason) {
          try {
            sample = await window.readGameDraftRawPixel({
              rawUrl: assetUrl(entry.snapshot.rawFile), rawFormat: entry.snapshot.rawFormat,
              width: entry.snapshot.width, height: entry.snapshot.height,
              rawBytesPerRow: entry.snapshot.rawBytesPerRow,
              rawByteLength: entry.snapshot.rawByteLength,
            }, pixel.x, pixel.y, controller.signal);
          } catch (error) {
            if (controller.signal.aborted) return;
            reason = error?.message || String(error);
          }
        }
        if (controller.signal.aborted || generation !== pixelTimelineGeneration) return;
        let comparison;
        if (sample) {
          comparison = previous ? samePixelValue(previous, sample) ? '不变' : '首次观测变化' : '起点 / 上游断档';
          if (comparison === '首次观测变化') {
            changes++;
            entry.changeCell.classList.add('pixel-change');
          }
          previous = sample;
          entry.valueCell.textContent = pixelValueText(sample);
        } else {
          gaps++;
          previous = null;
          comparison = '断档';
          entry.valueCell.textContent = `不可读：${reason || '未知原因'}`;
          entry.valueCell.classList.add('pixel-gap');
        }
        entry.changeCell.textContent = comparison;
        trace.observations.push({ passIndex: entry.pass.index, passLabel: entry.pass.label,
          commandIndex: entry.commandIndex, drawCommandIndex: entry.drawCommandIndex,
          rawFile: entry.snapshot?.rawFile ?? null, rawSha256: entry.snapshot?.rawSha256 ?? null,
          captureMoment: entry.snapshot?.captureMoment ?? null,
          values: sample?.values ?? null, rawBytes: sample?.rawBytes ?? null, format: sample?.format ?? null,
          comparison, reason: sample ? null : reason });
        el('pixel-timeline-status').textContent = `${trace.observations.length}/${entries.length} 读回 · ${changes} 变化 · ${gaps} 断档`;
      }
      exportButton.disabled = false;
      exportButton.addEventListener('click', () => {
        const data = { kind: 'observed-rt-pixel-timeline', frameOrdinal: target.frameOrdinal,
          textureId: target.textureId, aspect: target.aspect, sampleIndex: target.sampleIndex,
          x: pixel.x, y: pixel.y, limitations: 'Only observed pass-end RT bytes; changes do not prove fragment coverage or shader output.',
          observations: trace.observations };
        const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
        const anchor = make('a');
        anchor.href = url;
        anchor.download = `pixel-frame-${target.frameOrdinal}-texture-${target.textureId}-${pixel.x}-${pixel.y}.json`;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      });
    })().catch(error => {
      if (generation === pixelTimelineGeneration) el('pixel-timeline-status').textContent =
        `读取失败：${error?.message || String(error)}`;
    });
  }
  function onPixelPicked(pixel) {
    const marker = `${pixel.x}, ${pixel.y}`;
    const png = pixel.nativeRtBytes ? '原始 RT 可见区域' :
      pixel.rgba8 ? `PNG RGBA8 ${pixel.rgba8.join(', ')}` :
        `PNG 像素不可读：${pixel.reason || '未知原因'}`;
    const snapshot = state.activeSurface?.snapshot;
    const at = state.activeSurface?.signature;
    const display = el('pixel-value');
    const show = value => { display.textContent = value; display.title = value; };
    if (state.previewMode === 'frame') beginPixelTimeline(pixel);
    const formatNative = native => `${marker} · RT ${native.format} 通道值 (${native.values.map(value =>
      Number.isFinite(value) ? Number(value.toPrecision(7)) : String(value)).join(', ')})${native.raw8 ?
      ` · 原始字节 ${native.raw8.join(', ')}` : ''} · ${png}`;
    if (pixel.nativeRtBytes) {
      show(pixel.native ? formatNative(pixel.native) :
        `${marker} · ${pixel.reason || '原始 RT 像素不可读'}`);
      return;
    }
    show(`${marker} · ${png} · 读取原始 RT…`);
    if (!snapshot?.rawFile) {
      show(`${marker} · ${png} · ${snapshot ? '此捕获无原始 RT sidecar' : '仅 PNG 显示值'}`);
      return;
    }
    surface.readNativePixel(pixel.x, pixel.y).then(native => {
      if (state.activeSurface?.signature !== at || surface.getState().pixel?.x !== pixel.x ||
          surface.getState().pixel?.y !== pixel.y) return;
      show(native ? formatNative(native) : `${marker} · ${png} · 原始 RT 格式不可读`);
    }, error => {
      if (state.activeSurface?.signature === at) show(`${marker} · ${png} · 原始 RT 读取失败：${error.message}`);
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
    const passes = list(state.report?.passes).filter(pass => !pass?.diagnosticAuxiliary);
    const visible = state.frameFilter === null ? passes : passes.filter(pass =>
      pass?.frameOrdinal !== null && pass?.frameOrdinal !== undefined &&
      Number(pass.frameOrdinal) === Number(state.frameFilter));
    el('pass-count').textContent = state.frameFilter === null ? `${passes.length} 个` : `${visible.length} / ${passes.length}`;
  }

  function eventMatches(event, query, kind) {
    const method = String(event?.method || '');
    if (kind !== 'all' && event?.passIndex != null &&
        passFor(event.passIndex)?.diagnosticAuxiliary) return false;
    if (kind === 'visual' ? !['draw', 'dispatch'].includes(eventKind(method)) :
      kind !== 'all' && eventKind(method) !== kind) return false;
    if (state.frameFilter !== null && (event?.frameOrdinal === null || event?.frameOrdinal === undefined ||
        Number(event.frameOrdinal) !== Number(state.frameFilter))) return false;
    if (!query) return true;
    const pass = event?.passIndex == null ? null : passFor(event.passIndex);
    const head = [method, event?.commandIndex, event?.pipelineId, event?.pipelineLabel,
      event?.passIndex, event?.frameOrdinal, pass?.label, pass && treePassLabel(pass, false),
      pass?.frameDebugStep?.logicalLabel].map(printable).join(' ').toLocaleLowerCase();
    if (head.includes(query)) return true;
    return safeJson([event?.args, event?.bindGroups], 12000).toLocaleLowerCase().includes(query);
  }
  function passMatchesTreeQuery(pass, query) {
    if (!query) return true;
    return [pass.label, treePassLabel(pass, false), pass.index,
      ...list(pass.targets).map(target => target.outputTextureLabel || target.textureLabel ||
        target.outputTextureId || target.textureId)].map(printable).join(' ').toLocaleLowerCase().includes(query);
  }
  function renderEvents() {
    const query = el('event-search').value.trim().toLocaleLowerCase();
    const kind = el('event-kind').value;
    const matches = [];
    for (let i = 0; i < state.events.length; i++) {
      if (eventMatches(state.events[i], query, kind)) matches.push(i);
    }
    state.navigationIndices = matches;
    const selectedPosition = matches.indexOf(state.selectedEvent);
    if (selectedPosition >= state.eventLimit) {
      state.eventLimit = Math.ceil((selectedPosition + 1) / PAGE_SIZE) * PAGE_SIZE;
    }
    const total = state.events.filter(item => eventMatches(item, '', kind)).length;
    el('event-count').textContent = `${matches.length} / ${total}`;
    const holder = el('event-tree');
    const previousScroll = holder.scrollTop;
    clear(holder);
    const disclosureOpen = (opened, closed, key, selected) =>
      !closed.has(key) && (opened.has(key) || selected || !!query);
    const rememberDisclosure = (opened, closed, key, open) => {
      if (open) { opened.add(key); closed.delete(key); }
      else { opened.delete(key); closed.add(key); }
    };
    let shownTreeNodes = 0;
    let zeroDrawPassCount = 0;
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
        button.appendChild(make('span', printable(event.method), 'tree-label'));
        const pipeline = event.pipelineLabel || event.pipelineId;
        button.appendChild(make('span', `${pipeline ? `${pipeline} · ` : ''}#${printable(event.commandIndex ?? index)}`, 'tree-meta'));
        button.addEventListener('click', () => selectEvent(index));
        target.appendChild(button);
      }
    };
    const allFrames = list(state.report?.frames);
    const frames = allFrames.length ? allFrames.filter(frame => state.frameFilter === null ||
      Number(frame?.frameOrdinal) === Number(state.frameFilter)) : [null];
    for (const frame of frames) {
      const ordinal = frame?.frameOrdinal ?? null;
      const belongs = event => ordinal === null || Number(event?.frameOrdinal) === Number(ordinal);
      const inFrame = visible.filter(index => belongs(state.events[index]));
      const passes = list(state.report?.passes).filter(pass =>
        (kind === 'all' || !pass?.diagnosticAuxiliary) &&
        (ordinal === null || Number(pass?.frameOrdinal) === Number(ordinal)));
      const passIds = new Set(passes.map(pass => String(pass.index)));
      // Build stable run identities before applying search or the event-page limit.
      // An omitted diagnostic pass must not split the visible visual stage, while
      // a visible command outside a pass does split the original command sequence.
      const sourceNodes = passes.map(pass => ({ type: 'pass', value: pass,
        order: Number(pass.beginCommand) || 0 }));
      for (let index = 0; index < state.events.length; index++) {
        const event = state.events[index];
        if (!belongs(event) || !eventMatches(event, '', kind) ||
            (event?.passIndex != null && passIds.has(String(event.passIndex)))) continue;
        sourceNodes.push({ type: 'event', value: index, order: Number(event.commandIndex) || 0 });
      }
      sourceNodes.sort((a, b) => a.order - b.order || (a.type === 'pass' ? -1 : 1));
      const categoryRun = new Map();
      const effectRun = new Map();
      const stepRun = new Map();
      let sourceCategory = null;
      let sourceCategoryKey = null;
      let sourceEffect = null;
      let sourceEffectKey = null;
      let sourceStepKey = null;
      let sourceStepOrdinal = 0;
      let sourceStepLogical = null;
      for (const sourceNode of sourceNodes) {
        if (sourceNode.type === 'event') {
          sourceCategory = sourceCategoryKey = sourceEffect = sourceEffectKey =
            sourceStepKey = sourceStepLogical = null;
          sourceStepOrdinal = 0;
          continue;
        }
        const sourcePass = sourceNode.value;
        const category = passCategory(sourcePass);
        if (category.key !== sourceCategory) {
          sourceCategory = category.key;
          sourceCategoryKey = `${ordinal ?? 'all'}:stage:${sourcePass.index}`;
          sourceEffect = sourceEffectKey = sourceStepKey = sourceStepLogical = null;
          sourceStepOrdinal = 0;
        }
        categoryRun.set(String(sourcePass.index), sourceCategoryKey);
        if (category.key === 'filter' || category.key === 'mask') {
          const subject = treeEffectSubject(sourcePass, category);
          if (!sourceEffectKey || treeEffectBegins(sourcePass) || subject !== sourceEffect) {
            sourceEffect = subject;
            sourceEffectKey = `${sourceCategoryKey}:effect:${sourcePass.index}`;
            sourceStepKey = sourceStepLogical = null;
            sourceStepOrdinal = 0;
          }
          effectRun.set(String(sourcePass.index), sourceEffectKey);
        } else {
          sourceEffect = sourceEffectKey = null;
        }
        const sourceStep = sourcePass.frameDebugStep;
        if (sourceStep?.totalDraws > 1) {
          const logical = `${sourceEffectKey || sourceCategoryKey}:${sourceStep.logicalLabel}:${sourceStep.totalDraws}`;
          if (!sourceStepKey || logical !== sourceStepLogical ||
              Number(sourceStep.drawOrdinal) !== sourceStepOrdinal + 1) {
            sourceStepKey = `${logical}:step:${sourcePass.index}`;
          }
          sourceStepLogical = logical;
          sourceStepOrdinal = Number(sourceStep.drawOrdinal);
          stepRun.set(String(sourcePass.index), sourceStepKey);
        } else {
          sourceStepKey = sourceStepLogical = null;
          sourceStepOrdinal = 0;
        }
      }
      const ungrouped = inFrame.filter(index => state.events[index]?.passIndex == null ||
        !passIds.has(String(state.events[index].passIndex)));
      const nodes = passes.filter(pass => (byPass.get(String(pass.index)) || []).length ||
        ((kind === 'visual' || kind === 'all') &&
          (pass.type === 'compute' ? Number(pass.dispatches ?? 0) === 0 : Number(pass.draws ?? 0) === 0) &&
          passMatchesTreeQuery(pass, query)))
        .map(pass => ({ type: 'pass', value: pass, order: Number(pass.beginCommand) || 0 }));
      for (const index of ungrouped) nodes.push({ type: 'event', value: index,
        order: Number(state.events[index]?.commandIndex) || 0 });
      nodes.sort((a, b) => a.order - b.order || (a.type === 'pass' ? -1 : 1));
      if (!nodes.length) continue;
      shownTreeNodes += nodes.length;
      zeroDrawPassCount += nodes.filter(node => node.type === 'pass' && node.value.draws === 0 &&
        !(byPass.get(String(node.value.index)) || []).length).length;
      const frameKey = String(ordinal ?? 'all');
      const selectedPass = state.selectedPass == null ? null : passFor(state.selectedPass);
      const selectedEvent = state.selectedEvent == null ? null : state.events[state.selectedEvent];
      const selectedInFrame = ordinal === null ||
        Number(selectedPass?.frameOrdinal ?? selectedEvent?.frameOrdinal) === Number(ordinal);
      const frameGroup = make('details', undefined, 'tree-frame-group');
      frameGroup.open = disclosureOpen(state.expandedFrames, state.collapsedFrames, frameKey, selectedInFrame);
      const frameHead = make('summary', undefined, 'tree-frame');
      const frameCaption = frame ?
        `第 ${frame.frameOrdinal} 帧 · 命令 ${printable(frame.beginCommand)}–${printable(frame.endCommand)}` :
        '捕获事件';
      const frameTitle = make('span', `${frameGroup.open ? '▾' : '▸'} ${frameCaption}`, 'tree-label');
      frameHead.appendChild(frameTitle);
      frameHead.addEventListener('click', event => {
        event.preventDefault();
        frameGroup.open = !frameGroup.open;
        frameTitle.textContent = `${frameGroup.open ? '▾' : '▸'} ${frameCaption}`;
        rememberDisclosure(state.expandedFrames, state.collapsedFrames, frameKey, frameGroup.open);
      });
      frameGroup.appendChild(frameHead);
      const frameContainer = make('div', undefined, 'tree-frame-children');
      frameGroup.appendChild(frameContainer);
      holder.appendChild(frameGroup);
      let categoryGroup = null;
      let categoryContainer = null;
      let categoryCount = null;
      let categoryLength = 0;
      let batchContainer = null;
      let batchGroup = null;
      let currentBatchKey = null;
      let batchCount = null;
      let batchLength = 0;
      let stepContainer = null;
      let stepGroupKey = null;
      let previousCategoryKey = null;
      for (const node of nodes) {
        if (node.type === 'event') {
          batchContainer = null;
          currentBatchKey = null;
          stepContainer = null;
          previousCategoryKey = null;
          categoryContainer = null;
          appendEvents(frameContainer, [node.value]);
          continue;
        }
        const pass = node.value;
        const category = passCategory(pass);
        const runKey = categoryRun.get(String(pass.index)) || `${ordinal ?? 'all'}:stage:${pass.index}`;
        if (runKey !== previousCategoryKey) {
          batchContainer = null;
          currentBatchKey = null;
          stepContainer = null;
          stepGroupKey = null;
          previousCategoryKey = runKey;
          categoryLength = 0;
          const stageLabel = category.label;
          categoryGroup = make('details', undefined, 'tree-category');
          categoryGroup.open = disclosureOpen(state.expandedCategories, state.collapsedCategories, runKey, false);
          const summary = make('summary', undefined, 'tree-category-head');
          summary.title = stageLabel;
          summary.appendChild(make('span', stageLabel, 'tree-label'));
          categoryCount = make('span', '', 'tree-meta');
          summary.appendChild(categoryCount);
          const currentCategoryGroup = categoryGroup;
          summary.addEventListener('click', event => {
            event.preventDefault();
            currentCategoryGroup.open = !currentCategoryGroup.open;
            rememberDisclosure(state.expandedCategories, state.collapsedCategories, runKey, currentCategoryGroup.open);
          });
          categoryGroup.appendChild(summary);
          categoryContainer = make('div', undefined, 'tree-category-children');
          categoryGroup.appendChild(categoryContainer);
          frameContainer.appendChild(categoryGroup);
        }
        categoryLength++;
        categoryCount.textContent = `${categoryLength} Pass`;
        if (state.selectedPass !== null && Number(state.selectedPass) === Number(pass.index) &&
            !state.collapsedCategories.has(runKey)) categoryGroup.open = true;
        let passContainer = categoryContainer;
        if (category.key === 'filter' || category.key === 'mask') {
          const subject = treeEffectSubject(pass, category);
          const batchKey = effectRun.get(String(pass.index)) || `${runKey}:effect:${pass.index}`;
          if (!batchContainer || batchKey !== currentBatchKey) {
            currentBatchKey = batchKey;
            batchLength = 0;
            stepContainer = null;
            stepGroupKey = null;
            batchGroup = make('details', undefined, 'tree-batch');
            batchGroup.open = disclosureOpen(state.expandedBatches, state.collapsedBatches, batchKey, false);
            const summary = make('summary', undefined, 'tree-batch-head');
            summary.title = subject;
            summary.appendChild(make('span', subject, 'tree-label'));
            batchCount = make('span', '', 'tree-meta');
            summary.appendChild(batchCount);
            batchGroup.appendChild(summary);
            batchContainer = make('div', undefined, 'tree-batch-children');
            batchGroup.appendChild(batchContainer);
            const currentBatchGroup = batchGroup;
            summary.addEventListener('click', event => {
              event.preventDefault();
              currentBatchGroup.open = !currentBatchGroup.open;
              rememberDisclosure(state.expandedBatches, state.collapsedBatches, batchKey, currentBatchGroup.open);
            });
            categoryContainer.appendChild(batchGroup);
          }
          batchLength++;
          batchCount.textContent = `${batchLength} Pass`;
          if (state.selectedPass !== null && Number(state.selectedPass) === Number(pass.index) &&
              !state.collapsedBatches.has(batchKey)) batchGroup.open = true;
          passContainer = batchContainer;
        }
        const step = pass.frameDebugStep;
        if (step?.totalDraws > 1) {
          const expansionKey = stepRun.get(String(pass.index)) || `${runKey}:step:${pass.index}`;
          if (!stepContainer || stepGroupKey !== expansionKey) {
            stepGroupKey = expansionKey;
            const group = make('details', undefined, 'tree-batch tree-step-group');
            group.open = disclosureOpen(state.expandedSteps, state.collapsedSteps, expansionKey, false);
            const summary = make('summary', undefined, 'tree-batch-head');
            summary.title = step.logicalLabel || pass.label || '';
            summary.appendChild(make('span', treePassLabel(pass, passContainer === batchContainer && !!batchContainer), 'tree-label'));
            summary.appendChild(make('span', `${step.totalDraws} Draw · 逐步输出`, 'tree-meta'));
            group.appendChild(summary);
            stepContainer = make('div', undefined, 'tree-batch-children');
            group.appendChild(stepContainer);
            summary.addEventListener('click', event => {
              event.preventDefault();
              group.open = !group.open;
              rememberDisclosure(state.expandedSteps, state.collapsedSteps, expansionKey, group.open);
            });
            passContainer.appendChild(group);
          }
          if (state.selectedPass !== null && Number(state.selectedPass) === Number(pass.index) &&
              !state.collapsedSteps.has(expansionKey)) stepContainer.parentElement.open = true;
          passContainer = stepContainer;
        } else {
          stepContainer = null;
          stepGroupKey = null;
        }
        const key = String(pass.index);
        const passEvents = byPass.get(key) || [];
        if ((kind === 'visual' || kind === 'all') && passEvents.length === 0 &&
            (pass.type === 'compute' ? Number(pass.dispatches ?? 0) === 0 : Number(pass.draws ?? 0) === 0)) {
          const head = make('button', undefined, 'tree-pass-head tree-pass-leaf');
          head.type = 'button';
          head.dataset.passIndex = key;
          head.classList.toggle('active', state.selectedPass === Number(pass.index));
          head.setAttribute('aria-selected', String(state.selectedPass === Number(pass.index)));
          const emptyOperation = pass.type === 'compute' ? '0 Dispatch' : '0 Draw';
          head.title = `${describePass(pass)}\n${emptyOperation}；请检查 Pass 的附件及操作。`;
          head.appendChild(make('span', `${treePassLabel(pass, passContainer === batchContainer && !!batchContainer)} · ${emptyOperation}`, 'tree-label'));
          head.appendChild(make('span', `P${pass.index}`, 'tree-meta'));
          head.addEventListener('click', () => selectPass(pass.index, { keepTreeScroll: true }));
          passContainer.appendChild(head);
          continue;
        }
        const group = make('details', undefined, 'tree-pass');
        group.open = disclosureOpen(state.expandedPasses, state.collapsedPasses, key,
          state.selectedPass !== null && Number(state.selectedPass) === Number(pass.index));
        const head = make('summary', undefined, 'tree-pass-head');
        head.title = describePass(pass);
        head.appendChild(make('span', step?.totalDraws > 1 ? `Draw ${step.drawOrdinal}/${step.totalDraws}` :
          treePassLabel(pass, passContainer === batchContainer && !!batchContainer), 'tree-label'));
        const gpuMs = pass.gpuTiming?.source === 'webgpu-timestamp-query' && finite(pass.gpuTiming.durationMs) ?
          compactGpuMs(pass.gpuTiming.durationMs) : '';
        head.appendChild(make('span', `#${pass.index} · ${pass.type === 'compute' ? pass.dispatches ?? 0 : pass.draws ?? 0} ${pass.type === 'compute' ? 'dispatch' : 'draw'}${gpuMs ? ` · ${gpuMs}` : ''}`, 'tree-meta'));
        head.classList.toggle('active', state.selectedPass !== null && Number(state.selectedPass) === Number(pass.index));
        head.addEventListener('click', event => {
          event.preventDefault();
          group.open = !group.open;
          rememberDisclosure(state.expandedPasses, state.collapsedPasses, key, group.open);
          selectPass(pass.index, { keepTreeScroll: true });
        });
        group.appendChild(head);
        const children = make('div', undefined, 'tree-children');
        appendEvents(children, byPass.get(key) || []);
        group.appendChild(children);
        passContainer.appendChild(group);
      }
    }
    if (!shownTreeNodes) holder.appendChild(make('p', state.events.length ?
      '没有符合条件的事件或 Pass。' : '报告没有事件明细；可查看 Pass 与统计。', 'empty'));
    holder.scrollTop = previousScroll;
    el('event-list-status').textContent = `显示 ${Math.min(matches.length, state.eventLimit)} / ${matches.length} 事件${zeroDrawPassCount ? ` · ${zeroDrawPassCount} 个 0 Draw Pass` : ''}`;
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
    } else state.selectedPass = null;
    if (event.frameOrdinal !== null && event.frameOrdinal !== undefined) {
      state.selectedFrame = Number(event.frameOrdinal);
      renderFrameSelector();
    }
    state.selectedTextureKey = null;
    state.selectedBufferPayloadId = null;
    if (state.previewMode !== 'mesh') state.previewMode = 'frame';
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
    state.selectedTextureKey = null;
    state.selectedBufferPayloadId = null;
    if (state.previewMode !== 'mesh') state.previewMode = 'frame';
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
        else if (resource?.type === 'Sampler') add('samplers', resource.id, resource.label);
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
      const kindLabel = { textures: '纹理', buffers: '缓冲', samplers: '采样器' };
      const button = make('button', `${kindLabel[target.kind]} #${target.id} ${target.label || ''}`, 'plain-button');
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
        `${pass.gpuTiming.durationMs.toFixed(6)} ms${pass.frameDebugStep ? '（单 Draw 物理 Pass，含 Pass 开销）' : ''}` : '未测量');
      const readable = snapshot => !!(snapshot?.imageFile || snapshot?.rawFile);
      const colors = list(pass.snapshots).filter(readable).length;
      const depth = list(pass.aspectSnapshots).filter(item => item?.aspect === 'depth' && readable(item)).length;
      const stencil = list(pass.aspectSnapshots).filter(item => item?.aspect === 'stencil' && readable(item)).length;
      const outputCounts = [colors && `${colors} Color`, depth && `${depth} Depth`, stencil && `${stencil} Stencil`].filter(Boolean);
      addDetailRow(grid, 'Pass 输出', outputCounts.length ? `${outputCounts.join(' / ')} 可查看的 GPU 读回` :
        `无读回${pass.outputUnavailableReason ? `：${pass.outputUnavailableReason}` : ''}`);
    }
    if (event && state.focusScope !== 'pass') {
      addDetailRow(grid, '选中命令', `#${printable(event.commandIndex)} ${printable(event.method)}`);
      if (eventKind(String(event.method || '')) === 'draw') {
        const output = postDrawSnapshots(pass, event);
        addDetailRow(grid, '逐 Draw 输出', output.length ?
          `${output.length} 张真实 GPU 读回 · ${pass.frameDebugStep.drawOrdinal}/${pass.frameDebugStep.totalDraws}` :
          '未捕获；若有 Pass 结束图，它不能代表此 Draw 后画面');
      }
      addDetailRow(grid, '调用参数', list(event.args).join(', ') || '—');
      addDetailRow(grid, '管线', event.pipelineId == null ? '未绑定' : `#${event.pipelineId} ${event.pipelineLabel || ''}`);
    }
    const scopeDraws = state.focusScope === 'pass' && pass ? state.events.filter(item =>
      Number(item?.passIndex) === Number(pass.index) &&
      ['draw', 'dispatch'].includes(eventKind(String(item?.method || '')))) : event ? [event] : [];
    if (state.focusScope === 'pass' && pass) {
      const pipelines = new Map();
      for (const draw of scopeDraws) if (draw.pipelineId != null) {
        pipelines.set(String(draw.pipelineId), `#${draw.pipelineId} ${draw.pipelineLabel || ''}`.trim());
      }
      addDetailRow(grid, '管线数', `${pipelines.size} 条${pipelines.size > 1 ? '；请选择具体 Draw 查看当时管线和参数' : ''}`);
      if (pipelines.size) addDetailRow(grid, '涉及管线', [...pipelines.values()].join('；'));
    }
    const bound = scopeDraws.flatMap(draw => list(draw.bindGroups).flatMap(group => list(group.resources)));
    const textureCount = new Set(bound.filter(item => item?.resource?.textureId != null)
      .map(item => `${item.resource.textureId}:${item.resource.id}`)).size;
    const bufferCount = new Set(bound.filter(item => item?.resource?.type === 'Buffer')
      .map(item => item.resource.id)).size;
    const targetCount = list(pass?.targets || event?.targets).length;
    holder.appendChild(make('p',
      `${targetCount} 个输出附件 · ${textureCount} 个绑定纹理视图 · ${bufferCount} 个绑定 Buffer` +
      (state.focusScope === 'pass' ? ` · ${scopeDraws.length} 个 Draw / Dispatch` : '') +
      '。这些是命令绑定状态，不能证明 Shader 实际读取了每个槽位。',
      'muted small'));
    const pipeline = state.focusScope === 'pass' && scopeDraws.length !== 1 ? null :
      resourceArray('pipelines').find(item => String(item.id) === String(event?.pipelineId));
    if (pipeline) {
      const entryPoints = [pipeline.descriptor?.vertex?.entryPoint, pipeline.descriptor?.fragment?.entryPoint,
        pipeline.descriptor?.compute?.entryPoint].filter(Boolean);
      if (entryPoints.length) addDetailRow(grid, '入口', entryPoints.join(' / '));
    }
    holder.appendChild(grid);
    const jumps = make('div', undefined, 'resource-jumps');
    for (const [page, label] of [['pipeline', '检查管线'], ['mesh', 'Mesh Preview'],
      ['inputs', '检查输入 / 输出'], ['buffers', '检查 Buffer']]) {
      const button = make('button', label, 'plain-button');
      button.type = 'button';
      button.addEventListener('click', () => {
        if (page === 'mesh') { state.previewMode = 'mesh'; renderPreviewMode(); }
        else setInspectorPage(page);
      });
      jumps.appendChild(button);
    }
    holder.appendChild(jumps);
    if (event && state.focusScope !== 'pass') {
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
    if (state.focusScope === 'pass') {
      const pass = state.selectedPass == null ? null : passFor(state.selectedPass);
      const draws = pass ? state.events.filter(item => Number(item?.passIndex) === Number(pass.index) &&
        ['draw', 'dispatch'].includes(eventKind(String(item?.method || '')))) : [];
      return draws.length === 1 ? draws[0] : null;
    }
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
    return moduleId == null ? null :
      resourceArray('shaders').find(item => String(item.id) === String(moduleId)) || null;
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
  function openDrawBuffer(draw, predicate) {
    const index = state.events.indexOf(draw);
    if (index < 0) return;
    const choice = bufferChoices(draw).find(predicate);
    selectEvent(index);
    if (choice) state.selectedBufferPayloadId = choice.key;
    renderBufferInspector();
    setInspectorPage('buffers');
  }
  function stageShaderBindings(shader) {
    const pattern = /@group\s*\(\s*(\d+)\s*\)\s*@binding\s*\(\s*(\d+)\s*\)\s*var(?:\s*<[^>]*>)?\s+([A-Za-z_]\w*)\s*:\s*([^;]+);/g;
    return [...String(shader?.code || '').matchAll(pattern)].map(match => ({
      group: Number(match[1]), binding: Number(match[2]), name: match[3], type: match[4].trim(),
    })).sort((a, b) => a.group - b.group || a.binding - b.binding);
  }
  function appendStageBindings(holder, draw, shader) {
    const declarations = stageShaderBindings(shader);
    holder.appendChild(make('h3', 'Shader 模块声明与当前 Draw 绑定', 'section-caption'));
    holder.appendChild(make('p', '按 WGSL 模块声明关联绑定槽；模块声明不证明这个阶段实际读取了资源。', 'muted small'));
    if (!declarations.length) {
      holder.appendChild(make('p', shader?.code ? 'WGSL 中没有可识别的 @group/@binding 声明。' :
        '没有 WGSL 源码，无法把绑定槽归入此阶段；完整绑定仍可在「输入与输出」查看。', 'muted small'));
      return;
    }
    const byGroup = new Map();
    for (const declaration of declarations) {
      if (!byGroup.has(declaration.group)) byGroup.set(declaration.group, []);
      byGroup.get(declaration.group).push(declaration);
    }
    for (const [slot, entries] of byGroup) {
      const section = make('details', undefined, 'binding-resource');
      section.open = slot === 0 || declarations.length <= 12;
      section.appendChild(make('summary', `Bind Group ${slot} · ${entries.length} 个 WGSL 声明`));
      const grid = make('table', undefined, 'binding-table');
      grid.innerHTML = '<thead><tr><th>Binding</th><th>WGSL 名称 / 类型</th><th>此 Draw 绑定资源</th><th>检查</th></tr></thead>';
      const body = make('tbody');
      const group = list(draw.bindGroups).find(item => Number(item.slot) === slot);
      for (const declaration of entries) {
        const resource = list(group?.resources).find(item => Number(item.binding) === declaration.binding)?.resource;
        const row = make('tr');
        row.appendChild(make('td', `${slot} / ${declaration.binding}`));
        row.appendChild(make('td', `${declaration.name} · ${declaration.type}`));
        row.appendChild(make('td', resource ? `#${resource.id} ${resource.label || ''}${resource.textureId != null ?
          ` · Texture #${resource.textureId}` : ''}` : '未绑定'));
        const action = make('td');
        if (resource?.type === 'Buffer') {
          const button = make('button', '查看值 / 字节', 'inline-link');
          button.type = 'button';
          button.addEventListener('click', () => openDrawBuffer(draw, item =>
            Number(item.groupSlot) === slot && Number(item.binding) === declaration.binding &&
            String(item.bufferId) === String(resource.id)));
          action.appendChild(button);
        } else if (resource?.textureId != null) {
          const button = make('button', '查看纹理', 'inline-link');
          button.type = 'button';
          button.addEventListener('click', () => previewTexture(resource.textureId,
            resource.type === 'TextureView' ? resource.id : null, true));
          action.appendChild(button);
        } else if (resource?.type === 'Sampler' && resourceIndexById('samplers', resource.id) >= 0) {
          const button = make('button', '查看采样状态', 'inline-link');
          button.type = 'button';
          button.addEventListener('click', () => selectResource('samplers', resourceIndexById('samplers', resource.id)));
          action.appendChild(button);
        }
        row.appendChild(action);
        body.appendChild(row);
      }
      grid.appendChild(body);
      section.appendChild(grid);
      holder.appendChild(section);
    }
  }
  function previewTexture(id, viewId = null, input = false) {
    const option = state.textureChoices.find(item => String(item.id) === String(id) &&
      (!input || item.role === '绑定输入') &&
      (viewId == null || String(item.viewId) === String(viewId)));
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
    if (!pipeline) {
      const pass = state.selectedPass == null ? null : passFor(state.selectedPass);
      const draws = state.focusScope === 'pass' && pass ? state.events.filter(item =>
        Number(item?.passIndex) === Number(pass.index) &&
        ['draw', 'dispatch'].includes(eventKind(String(item?.method || '')))) : [];
      if (draws.length > 1) {
        const ids = new Set(draws.filter(item => item.pipelineId != null).map(item => String(item.pipelineId)));
        holder.appendChild(make('p', `此 Pass 有 ${draws.length} 个 Draw / Dispatch、${ids.size} 条管线。请选择具体命令查看准确的管线状态和参数。`, 'inspect-note'));
        const links = make('div', undefined, 'resource-jumps');
        for (const item of draws) {
          const button = make('button', `#${item.commandIndex} ${item.pipelineLabel || `Pipeline #${printable(item.pipelineId)}`}`, 'plain-button');
          button.type = 'button';
          button.addEventListener('click', () => selectEvent(state.events.indexOf(item), true));
          links.appendChild(button);
        }
        holder.appendChild(links);
      } else holder.appendChild(make('p', '所选 Pass / 命令没有可用管线描述。', 'empty'));
      return;
    }
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
    holder.appendChild(make('p', `Pipeline #${pipeline.id} · ${pipeline.label || pipeline.type || '未命名'} · Draw #${draw.commandIndex}${state.focusScope === 'pass' ? '（此 Pass 只有一个 Draw）' : ''}。这里显示 API 管线状态，不执行 Shader 单步调试。`, 'muted small'));
    const stage = state.pipelineStage;
    if (stage === 'input') {
      holder.appendChild(make('h3', '顶点缓冲与布局', 'section-caption'));
      const rows = list(draw.vertexBuffers).map(buffer => {
        const layout = descriptor.vertex?.buffers?.[buffer.slot];
        const attrs = list(layout?.attributes).map(attr => `location ${attr.shaderLocation}: ${attr.format} @${attr.offset}`).join('；');
        return [`${buffer.slot}`, `#${buffer.id} ${buffer.label || ''}`, `${layout?.arrayStride ?? '—'} B / ${layout?.stepMode || '—'}`, attrs || '—'];
      });
      table(holder, ['Slot', 'Buffer', 'Stride', 'Attributes'], rows);
      for (const buffer of list(draw.vertexBuffers)) {
        const button = make('button', `查看 Slot ${buffer.slot} · Buffer #${buffer.id} 字节`, 'inline-link');
        button.type = 'button';
        button.addEventListener('click', () => openDrawBuffer(draw, item =>
          item.role === 'vertex' && Number(item.vertexSlot) === Number(buffer.slot) &&
          String(item.bufferId) === String(buffer.id)));
        holder.append(button, make('span', ' '));
      }
      if (draw.indexBuffer) holder.appendChild(make('p', `索引：#${draw.indexBuffer.id} ${draw.indexBuffer.label || ''} · ${draw.indexBuffer.format || '格式未记载'}`, 'data-section'));
      if (draw.indexBuffer) {
        const button = make('button', `查看 Index Buffer #${draw.indexBuffer.id} 字节`, 'inline-link');
        button.type = 'button';
        button.addEventListener('click', () => openDrawBuffer(draw, item =>
          item.role === 'index' && String(item.bufferId) === String(draw.indexBuffer.id)));
        holder.appendChild(button);
      }
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
    appendStageBindings(holder, draw, shader);
    if (!shader?.code) { holder.appendChild(make('p', '这份捕获没有该阶段的 WGSL 源码。', 'muted')); return; }
    const link = make('button', `打开 WGSL #${shader.id}`, 'inline-link');
    link.type = 'button';
    link.addEventListener('click', () => selectResource('shaders', resourceIndexById('shaders', shader.id)));
    holder.appendChild(link);
    const source = make('details', undefined, 'data-section');
    source.append(make('summary', '查看 WGSL 源码'), make('pre', shader.code));
    holder.appendChild(source);
  }

  const meshByteCache = new Map();
  let meshRenderTicket = 0;
  async function meshSnapshotBytes(snapshot) {
    if (!snapshot?.rawFile || !Number.isSafeInteger(snapshot.rawByteLength) ||
        snapshot.rawByteLength < 1 ||
        snapshot.rawByteLength > window.GameDraftMeshInspector.MAX_SNAPSHOT_BYTES) {
      throw new Error('Draw 前 Buffer 文件缺失或超过单文件 16 MiB 上限');
    }
    const url = assetUrl(snapshot.rawFile);
    if (!url) throw new Error('Buffer 文件路径无效');
    const key = snapshot.rawFile + ':' + snapshot.rawSha256;
    if (!meshByteCache.has(key)) {
      const pending = (async () => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Buffer 文件 HTTP ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length !== snapshot.rawByteLength) throw new Error('Buffer 文件长度与报告不符');
        if (snapshot.rawSha256 && typeof crypto !== 'undefined' && crypto.subtle) {
          const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
          const hex = [...hash].map(value => value.toString(16).padStart(2, '0')).join('');
          if (hex !== snapshot.rawSha256) throw new Error('Buffer 文件 SHA-256 与报告不符');
        }
        return bytes;
      })();
      meshByteCache.set(key, pending);
      while (meshByteCache.size > 4) meshByteCache.delete(meshByteCache.keys().next().value);
    }
    try { return await meshByteCache.get(key); }
    catch (error) { meshByteCache.delete(key); throw error; }
  }

  function meshNumber(value) {
    return Number.isFinite(value) ? String(Number(value.toPrecision(7))) : String(value);
  }

  function paintMesh(canvas, result, selectedOrder = null) {
    canvas.width = 960;
    canvas.height = 420;
    const context = canvas.getContext('2d');
    if (!context) return;
    const width = canvas.width, height = canvas.height, pad = 38;
    context.fillStyle = '#151b22';
    context.fillRect(0, 0, width, height);
    const spanX = Math.max(1e-9, result.bounds.maxX - result.bounds.minX);
    const spanY = Math.max(1e-9, result.bounds.maxY - result.bounds.minY);
    const scale = Math.min((width - 2 * pad) / spanX, (height - 2 * pad) / spanY);
    const originX = (width - spanX * scale) / 2;
    const originY = (height - spanY * scale) / 2;
    const point = value => ({
      x: originX + (value.x - result.bounds.minX) * scale,
      y: height - originY - (value.y - result.bounds.minY) * scale,
    });
    context.strokeStyle = '#293642';
    context.lineWidth = 1;
    for (let grid = 0; grid <= 4; grid++) {
      const x = pad + (width - pad * 2) * grid / 4;
      const y = pad + (height - pad * 2) * grid / 4;
      context.beginPath(); context.moveTo(x, pad); context.lineTo(x, height - pad); context.stroke();
      context.beginPath(); context.moveTo(pad, y); context.lineTo(width - pad, y); context.stroke();
    }
    const total = result.primitives.length;
    for (let index = 0; index < total; index++) {
      const primitive = result.primitives[index];
      const first = result.points[primitive.corners[0]];
      if (!first) continue;
      context.beginPath();
      const start = point(first);
      context.moveTo(start.x, start.y);
      for (const corner of primitive.corners.slice(1)) {
        const vertex = result.points[corner];
        if (!vertex) continue;
        const pos = point(vertex);
        context.lineTo(pos.x, pos.y);
      }
      if (primitive.kind === 'triangle') context.closePath();
      const progress = total <= 1 ? 0 : index / (total - 1);
      context.strokeStyle = `hsl(${206 - progress * 172} 82% 65% / .62)`;
      context.lineWidth = 1.2;
      context.stroke();
    }
    const first = result.points.find(Boolean);
    const last = result.points.findLast(Boolean);
    for (const [vertex, color] of [[first, '#70c6ff'], [last, '#ffd177']]) {
      if (!vertex) continue;
      const pos = point(vertex);
      context.fillStyle = color;
      context.beginPath(); context.arc(pos.x, pos.y, 4, 0, Math.PI * 2); context.fill();
    }
    if (selectedOrder !== null && result.points[selectedOrder]) {
      const selected = point(result.points[selectedOrder]);
      context.strokeStyle = '#fff'; context.lineWidth = 2;
      context.beginPath(); context.arc(selected.x, selected.y, 8, 0, Math.PI * 2); context.stroke();
    }
    context.fillStyle = '#aec0d0';
    context.font = '12px Consolas, monospace';
    context.fillText(`${meshNumber(result.bounds.minX)}, ${meshNumber(result.bounds.minY)}`, 8, height - 8);
    context.fillText(`${meshNumber(result.bounds.maxX)}, ${meshNumber(result.bounds.maxY)}`, width - 210, 18);
    context.fillText('Y ↑ · 蓝 → 橙：绘制顺序', 8, 18);
  }

  function showMeshResult(result, loadErrors) {
    const holder = el('mesh-detail');
    clear(holder);
    if (result.status !== 'ok') {
      holder.appendChild(make('p', `不可预览：${result.reason}${loadErrors.length ? `；${loadErrors[0]}` : ''}`, 'empty'));
      el('mesh-summary').textContent = '';
      return;
    }
    el('mesh-summary').textContent = `${result.topology} · ${result.count} ${result.indexed ? '索引' : '顶点'} · ${result.primitives.length} 个图元`;
    const note = make('p', `位置 location ${result.position.shaderLocation} · Slot ${result.position.slot} · ${result.position.format} · 输入字节偏移 ${result.position.offset} · ${result.instanceCount} 实例；只显示一份顶点输入，实例变换和 Shader 运算未执行。`, 'muted small');
    holder.appendChild(note);
    const canvas = make('canvas', undefined, 'mesh-canvas');
    canvas.setAttribute('aria-label', '所选位置属性的顶点输入线框；蓝色先绘，橙色后绘');
    holder.appendChild(canvas);
    paintMesh(canvas, result);
    const data = make('details', undefined, 'mesh-data');
    data.appendChild(make('summary', `顶点表 ${result.rows.length} / ${result.count} · 展开查看属性`));
    const status = make('p', '点击行在线框上定位顶点。横纵坐标是原始属性值；线框按范围适配，不代表最终像素坐标。', 'muted small');
    data.appendChild(status);
    const wrap = make('div', undefined, 'mesh-table-scroll');
    const grid = make('table', undefined, 'binding-table');
    const head = make('thead');
    const header = make('tr');
    const names = ['顺序', '原索引', '顶点索引', 'Buffer 字节', 'X', 'Y',
      ...result.attributes.map(item => `loc ${item.shaderLocation} (${item.format})`)];
    for (const name of names) header.appendChild(make('th', name));
    head.appendChild(header); grid.appendChild(head);
    const body = make('tbody');
    for (const row of result.rows) {
      const tr = make('tr');
      const values = row.restart ? [row.order, 'strip 重启', '—', '—', '—', '—',
        ...result.attributes.map(() => '—')] :
        [row.order, row.sourceIndex ?? '—', row.vertexIndex, row.byteOffset,
          meshNumber(row.x), meshNumber(row.y),
          ...row.values.map(value => value ? value.map(meshNumber).join(', ') : '不可用')];
      for (const value of values) tr.appendChild(make('td', value));
      if (!row.restart) {
        tr.tabIndex = 0;
        const select = () => paintMesh(canvas, result, row.order);
        tr.addEventListener('click', select);
        tr.addEventListener('keydown', event => {
          if (event.key === 'Enter') { event.preventDefault(); select(); }
        });
      }
      body.appendChild(tr);
    }
    grid.appendChild(body); wrap.appendChild(grid); data.appendChild(wrap); holder.appendChild(data);
  }

  async function renderMeshInspector() {
    const ticket = ++meshRenderTicket;
    if (state.previewMode !== 'mesh') return;
    const holder = el('mesh-detail');
    const select = el('mesh-position-location');
    clear(holder); clear(select);
    select.disabled = true;
    el('mesh-summary').textContent = '';
    const event = state.focusScope === 'draw' ? state.events[state.selectedEvent] : null;
    if (!event || eventKind(String(event.method || '')) !== 'draw') {
      holder.appendChild(make('p', '选择一个 Draw 查看顶点输入。', 'empty'));
      return;
    }
    const pass = passFor(event.passIndex);
    const pipeline = pipelineForEvent(event);
    const inspector = window.GameDraftMeshInspector;
    if (!inspector) { holder.appendChild(make('p', '顶点输入解码器未加载。', 'empty')); return; }
    const candidates = inspector.positionAttributes(event, pipeline);
    for (const candidate of candidates) {
      const option = make('option', `location ${candidate.shaderLocation} · Slot ${candidate.slot} · ${candidate.format} @${candidate.offset}`);
      option.value = String(candidate.shaderLocation);
      select.appendChild(option);
    }
    const eventKey = `${event.frameOrdinal}:${event.passIndex}:${event.commandIndex}`;
    if (state.meshSelectionKey !== eventKey ||
        !candidates.some(item => item.shaderLocation === state.meshLocation)) {
      state.meshSelectionKey = eventKey;
      state.meshLocation = inspector.recommendedLocation(candidates);
    }
    select.disabled = !candidates.length;
    if (state.meshLocation !== null) select.value = String(state.meshLocation);
    if (!candidates.length || !pass?.bufferSnapshots?.length) {
      showMeshResult(inspector.decodeDraw({ event, pipeline, pass,
        positionLocation: state.meshLocation, bytesByOrdinal: new Map() }), []);
      return;
    }
    holder.appendChild(make('p', '读取 Draw 前顶点与索引字节…', 'muted small'));
    const snapshots = list(pass.bufferSnapshots).filter(item =>
      item.captureMoment === 'pre-draw' && ['vertex', 'index'].includes(item.role));
    const required = snapshots.filter(item => item.role === 'index' ||
      item.vertexSlot === candidates.find(candidate => candidate.shaderLocation === state.meshLocation)?.slot);
    const extra = snapshots.filter(item => !required.includes(item));
    const chosen = [...required];
    let budget = required.reduce((sum, item) => sum + (item.rawByteLength || 0), 0);
    for (const item of extra) {
      if (budget + (item.rawByteLength || 0) > 32 * 1024 * 1024) continue;
      chosen.push(item); budget += item.rawByteLength || 0;
    }
    const bytesByOrdinal = new Map();
    const loadErrors = [];
    await Promise.all(chosen.map(async snapshot => {
      try { bytesByOrdinal.set(snapshot.bufferOrdinal, await meshSnapshotBytes(snapshot)); }
      catch (error) { loadErrors.push(`${snapshot.role} Slot ${snapshot.vertexSlot ?? '索引'}：${error.message || String(error)}`); }
    }));
    if (ticket !== meshRenderTicket || state.previewMode !== 'mesh') return;
    try {
      showMeshResult(inspector.decodeDraw({ event, pipeline, pass,
        positionLocation: state.meshLocation, bytesByOrdinal }), loadErrors);
    } catch (error) {
      empty(holder, `顶点输入解码失败：${error.message || String(error)}`);
    }
  }

  function shaderBindingNames(pipeline) {
    const names = new Map();
    for (const id of list(pipeline?.shaderIds)) {
      const shader = resourceArray('shaders').find(item => String(item.id) === String(id));
      const code = shader?.code || '';
      const pattern = /@group\s*\(\s*(\d+)\s*\)\s*@binding\s*\(\s*(\d+)\s*\)\s*var(?:\s*<([^>]*)>)?\s+([A-Za-z_]\w*)\s*:\s*([^;]+);/g;
      for (const match of code.matchAll(pattern)) {
        const qualifier = (match[3] || '').split(',').map(part => part.trim());
        const type = match[5].trim();
        let access = 'unknown';
        if (qualifier[0] === 'storage') access = qualifier[1] === 'read_write' ? 'read-write' :
          qualifier[1] === 'read' || qualifier[1] === 'write' ? qualifier[1] : 'unknown';
        else if (qualifier[0] === 'uniform' || /^texture_(?!storage)/.test(type) || /^sampler/.test(type)) access = 'read';
        else if (/^texture_storage/.test(type)) {
          const storageAccess = type.match(/,\s*(read_write|read|write)\s*>/);
          access = storageAccess?.[1] === 'read_write' ? 'read-write' : storageAccess?.[1] || 'unknown';
        }
        names.set(`${match[1]}:${match[2]}`, { name: match[4], type, access });
      }
    }
    return names;
  }
  function bindingAccessLabel(access) {
    return ({ 'read': 'WGSL 只读', 'write': 'WGSL 只写',
      'read-write': 'WGSL 可读写' })[access] || '访问方式未确认';
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
    holder.appendChild(make('h3', `Pass #${pass?.index ?? focused?.passIndex} · ${draws.length} 个 Draw / Dispatch`, 'section-caption'));
    holder.appendChild(make('p', '按命令 → Bind Group → Binding 查看当时的资源和范围；WGSL 声明只说明可访问方式，绑定本身不证明实际读写。', 'muted small'));
    holder.appendChild(make('h3', '输出附件', 'section-caption'));
    const outputs = outputChoicesFor(pass);
    if (!outputs.length) holder.appendChild(make('p', pass?.type === 'compute' ?
      'Compute Pass 没有渲染附件；可写 Buffer / Storage Texture 在下方绑定资源中标出。' :
      '没有已记录的输出附件。', 'muted'));
    else {
      const node = make('table', undefined, 'binding-table');
      node.innerHTML = '<thead><tr><th>目标</th><th>纹理</th><th>格式</th><th>Load / Store</th><th>查看</th></tr></thead>';
      const body = make('tbody');
      for (const output of outputs) {
        const target = output.target;
        const tr = make('tr');
        for (const value of [output.role, output.label, target.format || '—',
          `${target.loadOp || '—'} / ${target.storeOp || '—'}`]) tr.appendChild(make('td', value));
        const cell = make('td');
        if (output.snapshot?.imageFile || output.snapshot?.rawFile) {
          const button = make('button', '预览该输出', 'inline-link');
          button.type = 'button';
          button.addEventListener('click', () => {
            state.selectedOutputKey = output.key;
            state.previewMode = 'frame';
            renderFrame();
            renderPreviewMode();
          });
          cell.appendChild(button);
        } else {
          const unavailable = make('span', '未读回', 'binding-sub');
          unavailable.title = output.unavailableReason;
          cell.appendChild(unavailable);
        }
        tr.appendChild(cell);
        body.appendChild(tr);
      }
      node.appendChild(body);
      holder.appendChild(node);
    }
    holder.appendChild(make('h3', '绑定资源（输入与可写）', 'section-caption'));
    if (!draws.length) holder.appendChild(make('p', '这个 Pass 没有 Draw / Dispatch 绑定状态。', 'muted'));
    for (const draw of draws) {
      const drawNode = make('details', undefined, 'binding-resource binding-draw');
      drawNode.open = draws.length === 1;
      const drawSummary = make('summary');
      drawSummary.appendChild(make('span', `#${draw.commandIndex} ${draw.method} · ${draw.pipelineLabel || `Pipeline #${printable(draw.pipelineId)}`}`));
      drawSummary.appendChild(make('span', `${list(draw.bindGroups).length} Bind Group`, 'binding-sub'));
      drawNode.appendChild(drawSummary);
      const names = shaderBindingNames(pipelineForEvent(draw));
      const drawBuffers = bufferChoices(draw);
      if (!list(draw.bindGroups).length) drawNode.appendChild(make('p', '没有记录 Bind Group。', 'muted small'));
      for (const group of list(draw.bindGroups)) {
        const groupNode = make('details', undefined, 'binding-resource binding-group');
        groupNode.open = draws.length === 1;
        const groupSummary = make('summary');
        groupSummary.appendChild(make('span', `Bind Group ${group.slot} · #${printable(group.id)} ${group.label || ''}`));
        groupSummary.appendChild(make('span', `${list(group.resources).length} Binding`, 'binding-sub'));
        groupNode.appendChild(groupSummary);
        if (list(group.dynamicOffsets).length) groupNode.appendChild(make('p',
          `Group 动态偏移 [${group.dynamicOffsets.join(', ')}]；未解析到具体槽位，以下基础范围不含它。`, 'binding-sub'));
        for (const entry of list(group.resources)) {
          const resource = entry?.resource || {};
          const name = names.get(`${group.slot}:${entry.binding}`);
          const item = make('div', undefined, 'binding-entry');
          item.appendChild(make('span', `Binding ${entry.binding} · ${name?.name || 'WGSL 名称未记录'}`, 'binding-name'));
          const access = make('span', bindingAccessLabel(name?.access), 'binding-access');
          access.dataset.access = name?.access || 'unknown';
          item.appendChild(access);
          const kind = resource.textureId != null ? 'TextureView' : resource.type || 'Unknown';
          const id = resource.textureId ?? resource.id;
          let detail = `${kind} #${printable(id)} ${resource.label || ''}`;
          if (resource.type === 'TextureView') detail += ` · View #${resource.id}`;
          if (resource.type === 'Buffer') {
            const captured = drawBuffers.find(choice => Number(choice.groupSlot) === Number(group.slot) &&
              Number(choice.binding) === Number(entry.binding) && String(choice.bufferId) === String(resource.id));
            const offset = captured?.type === 'snapshot' ? captured.offset : resource.offset ?? 0;
            const size = captured?.type === 'snapshot' ? captured.size : resource.size;
            detail += ` · [${offset}, ${Number.isSafeInteger(size) ? offset + size : '末尾未记录'}) B`;
            if (captured?.type === 'snapshot' && captured.captureMoment === 'pre-draw') detail += ' · Draw 前字节';
          }
          if (name?.type) detail += ` · ${name.type}`;
          item.appendChild(make('span', detail, 'binding-sub'));
          if (resource.type === 'Buffer') {
            const button = make('button', '查看值 / 字节', 'inline-link');
            button.type = 'button';
            button.addEventListener('click', () => openDrawBuffer(draw, choice =>
              Number(choice.groupSlot) === Number(group.slot) && Number(choice.binding) === Number(entry.binding) &&
              String(choice.bufferId) === String(resource.id)));
            item.appendChild(button);
          } else if (resource.textureId != null) {
            const button = make('button', '查看此 Draw 输入', 'inline-link');
            button.type = 'button';
            button.addEventListener('click', () => {
              selectEvent(state.events.indexOf(draw));
              previewTexture(resource.textureId, resource.type === 'TextureView' ? resource.id : null, true);
            });
            item.appendChild(button);
          } else if (resource.type === 'Sampler' && resourceIndexById('samplers', resource.id) >= 0) {
            const button = make('button', '查看采样器', 'inline-link');
            button.type = 'button';
            button.addEventListener('click', () => selectResource('samplers', resourceIndexById('samplers', resource.id)));
            item.appendChild(button);
          }
          groupNode.appendChild(item);
        }
        drawNode.appendChild(groupNode);
      }
      const vertexInputs = list(draw.vertexBuffers);
      const indexInput = String(draw.method || '').startsWith('drawIndexed') ? draw.indexBuffer : null;
      if (vertexInputs.length || indexInput) {
        const streams = make('details', undefined, 'binding-resource binding-group');
        streams.open = draws.length === 1;
        const streamSummary = make('summary');
        streamSummary.appendChild(make('span', '顶点 / 索引输入'));
        streamSummary.appendChild(make('span', `${vertexInputs.length + (indexInput ? 1 : 0)} Buffer`, 'binding-sub'));
        streams.appendChild(streamSummary);
        for (const vertex of vertexInputs) {
          const item = make('div', undefined, 'binding-entry');
          item.appendChild(make('span', `Vertex Slot ${vertex.slot}`, 'binding-name'));
          item.appendChild(make('span', `Buffer #${vertex.id} ${vertex.label || ''} · [${vertex.offset ?? 0}, ${Number.isSafeInteger(vertex.size) ? (vertex.offset ?? 0) + vertex.size : '末尾未记录'}) B`, 'binding-sub'));
          const button = make('button', '查看值 / 字节', 'inline-link');
          button.type = 'button';
          button.addEventListener('click', () => openDrawBuffer(draw, choice =>
            choice.role === 'vertex' && Number(choice.vertexSlot) === Number(vertex.slot) &&
            String(choice.bufferId) === String(vertex.id)));
          item.appendChild(button);
          streams.appendChild(item);
        }
        if (indexInput) {
          const item = make('div', undefined, 'binding-entry');
          item.appendChild(make('span', `Index · ${indexInput.format || '格式未记录'}`, 'binding-name'));
          item.appendChild(make('span', `Buffer #${indexInput.id} ${indexInput.label || ''} · [${indexInput.offset ?? 0}, ${Number.isSafeInteger(indexInput.size) ? (indexInput.offset ?? 0) + indexInput.size : '末尾未记录'}) B`, 'binding-sub'));
          const button = make('button', '查看值 / 字节', 'inline-link');
          button.type = 'button';
          button.addEventListener('click', () => openDrawBuffer(draw, choice =>
            choice.role === 'index' && String(choice.bufferId) === String(indexInput.id)));
          item.appendChild(button);
          streams.appendChild(item);
        }
        drawNode.appendChild(streams);
      }
      holder.appendChild(drawNode);
    }
  }

  function buildTextureWriteTimeline(report) {
    const writes = new Map();
    const views = new Map(list(report?.resources?.textureViews).map(view => [String(view.id), view]));
    const textureIds = new Set(list(report?.resources?.textures).map(texture => String(texture.id)));
    const push = (id, write) => {
      if (id == null || !textureIds.has(String(id)) || !Number.isFinite(write.commandIndex)) return;
      const key = String(id);
      if (!writes.has(key)) writes.set(key, []);
      writes.get(key).push(write);
    };
    const textureId = value => {
      const id = value?.__id;
      if (id == null) return null;
      return textureIds.has(String(id)) ? id : views.get(String(id))?.textureId ?? null;
    };
    const destinationId = value => textureId(value?.texture ?? value?.view ?? value);
    for (const pass of list(report?.passes)) {
      if (!Number.isFinite(Number(pass.endCommand))) continue;
      for (const target of list(pass.targets)) {
        const outputId = target.outputTextureId ?? target.textureId;
        const snapshot = target.kind === 'color' ? list(pass.snapshots).find(item =>
          String(item.textureId) === String(outputId)) || null : null;
        for (const id of new Set([target.textureId, target.resolveTextureId].filter(item => item != null))) {
          push(id, { commandIndex: Number(pass.endCommand), kind: 'pass', passIndex: pass.index,
            snapshot: String(id) === String(outputId) ? snapshot : null });
        }
      }
    }
    for (const event of list(report?.events)) {
      const args = list(event.args);
      const index = Number(event.commandIndex);
      if (!Number.isFinite(index)) continue;
      const destination = event.method === 'writeTexture' ? args[0] :
        event.method === 'copyExternalImageToTexture' || event.method === 'copyBufferToTexture' ||
        event.method === 'copyTextureToTexture' ? args[1] : null;
      if (destination) {
        push(destinationId(destination), { commandIndex: index, kind: event.method });
        continue;
      }
      if (event.method === 'dispatchWorkgroups' || event.method === 'dispatchWorkgroupsIndirect') {
        // The Inspector report does not state storage-texture access. Treat every bound texture
        // as potentially written by compute, so an older image cannot impersonate a later input.
        for (const group of list(event.bindGroups)) for (const entry of list(group?.resources)) {
          push(entry?.resource?.textureId, { commandIndex: index, kind: 'compute-possible-write' });
        }
      }
    }
    for (const entries of writes.values()) entries.sort((a, b) => a.commandIndex - b.commandIndex);
    return { writes, views };
  }

  function inputViewUnavailableReason(texture, viewId) {
    const view = viewId == null ? null : state.textureViews.get(String(viewId));
    if (viewId != null && !view && String(viewId) !== String(texture.id)) return '绑定纹理视图信息缺失';
    const descriptor = view?.descriptor || {};
    const mipCount = Number(texture?.descriptor?.mipLevelCount ?? 1);
    const layers = Number(texture?.depthOrArrayLayers ?? texture?.descriptor?.size?.depthOrArrayLayers ?? 1);
    if (Number(descriptor.baseMipLevel ?? 0) !== 0 || Number(descriptor.mipLevelCount ?? mipCount) !== 1 ||
        mipCount !== 1 || Number(descriptor.baseArrayLayer ?? 0) !== 0 ||
        Number(descriptor.arrayLayerCount ?? layers) !== 1 || layers !== 1 ||
        (descriptor.aspect && descriptor.aspect !== 'all') ||
        (descriptor.dimension && descriptor.dimension !== '2d') ||
        (texture.dimension && texture.dimension !== '2d')) {
      return '绑定的是非完整 mip0/第 0 层二维视图，现有图像不能代表该输入';
    }
    return null;
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
    const seen = new Map();
    const inputEvent = draws.length === 1 ? draws[0] : null;
    const add = (id, role, label, snapshot, evidenceOverride, viewId = null, mipLevel = null,
      binding = null) => {
      if (id == null) return;
      const texture = resourceArray('textures').find(item => String(item.id) === String(id));
      if (!texture) return;
      const key = `${role}:${id}:${viewId ?? ''}:${mipLevel ?? ''}`;
      const existing = seen.get(key);
      const recordBinding = option => {
        if (!binding) return;
        const identity = `${binding.group}:${binding.slot}:${binding.draw}`;
        if (!option.bindings.some(item => `${item.group}:${item.slot}:${item.draw}` === identity)) {
          option.bindings.push(binding);
        }
      };
      if (existing) {
        if (role === '绑定输入' && label && !existing.bindingNames.includes(label)) {
          existing.bindingNames.push(label);
          existing.label = existing.bindingNames.length === 1 ? label :
            `${existing.bindingNames[0]} +${existing.bindingNames.length - 1} 个绑定`;
        }
        recordBinding(existing);
        return;
      }
      let evidence = snapshot?.captureMoment === 'pre-draw' ? 'pre-draw' :
        snapshot?.captureMoment === 'unavailable' ?
          role === '绑定输入' ? 'input-unavailable' : 'aspect-unavailable' :
          evidenceOverride || (snapshot ? 'this-pass' : 'capture-final');
      let file = snapshot ? snapshot.imageFile : texture.imageFile;
      if ((role === '深度' || role === '模板') && !snapshot) file = null;
      if (role === '绑定输入' && !inputEvent) {
        snapshot = null;
        file = null;
        evidence = 'pass-aggregate';
      }
      if (role === '绑定输入' && pass && evidence !== 'pre-draw' && evidence !== 'input-unavailable') {
        const viewReason = inputViewUnavailableReason(texture, viewId);
        const writes = state.textureWrites.get(String(id)) || [];
        const command = Number(inputEvent?.commandIndex);
        const latest = Number.isFinite(command) ? writes.filter(item => item.commandIndex < command).at(-1) : null;
        const later = Number.isFinite(command) ? writes.find(item => item.commandIndex > command) : null;
        if (viewReason || !inputEvent) {
          snapshot = null; file = null;
          evidence = viewReason ? 'view-unavailable' : 'pass-aggregate';
        } else if (latest?.snapshot) {
          snapshot = latest.snapshot;
          evidence = 'upstream-pass-candidate';
          file = snapshot.imageFile || null;
        } else if (texture.imageFile) {
          snapshot = null;
          evidence = 'capture-final-unverified';
          file = texture.imageFile;
        } else {
          snapshot = null; file = null;
          evidence = latest ? 'upstream-unavailable' : later ? 'later-write' : 'no-image';
        }
        if (viewReason) evidenceOverride = viewReason;
      }
      const option = { key, id, role, viewId, label: label || texture.label || `纹理 #${id}`,
        bindingNames: role === '绑定输入' && label ? [label] : [], texture, snapshot,
        bindings: [],
        file, evidence, mipLevel, unavailableReason: evidence === 'input-unavailable' ||
          evidence === 'aspect-unavailable' ? snapshot?.reason || snapshot?.rawReason ||
            snapshot?.imageReason : evidenceOverride };
      options.push(option);
      seen.set(key, option);
      recordBinding(option);
    };
    for (const draw of draws) {
      for (const group of list(draw.bindGroups)) for (const entry of list(group?.resources)) {
        if (entry?.resource?.textureId == null) continue;
        const textureId = entry.resource.textureId;
        const viewId = entry.resource.type === 'TextureView' ? entry.resource.id : null;
        const recorded = list(pass?.inputSnapshots).filter(item =>
          String(item.textureId) === String(textureId) && String(item.viewId) === String(viewId) &&
          (item.captureMoment === 'unavailable' || Number(item.drawCommandIndex) === Number(draw.commandIndex)));
        if (recorded.length) {
          for (const snapshot of recorded) add(textureId, '绑定输入',
            snapshot.bindingName || entry.resource.label || `纹理 #${textureId}`,
            snapshot, undefined, viewId, snapshot.mipLevel ?? 0,
            { group: group.slot, slot: entry.binding, draw: draw.commandIndex,
              name: snapshot.bindingName || entry.resource.label || '' });
        } else add(textureId, '绑定输入', entry.resource.label, null, undefined, viewId, null,
          { group: group.slot, slot: entry.binding, draw: draw.commandIndex,
            name: entry.resource.label || '' });
      }
    }
    for (const target of list(pass?.targets || event?.targets)) {
      const outputId = target.outputTextureId ?? target.textureId;
      if (target.kind === 'depth-stencil') {
        const aspects = target.format?.includes('stencil') ? ['depth', 'stencil'] : ['depth'];
        for (const aspect of aspects) {
          const aspectSnapshot = list(pass?.aspectSnapshots).find(item => item.aspect === aspect &&
            String(item.textureId) === String(target.textureId) &&
            String(item.viewId) === String(target.viewId));
          add(outputId, aspect === 'depth' ? '深度' : '模板',
            target.outputTextureLabel || target.textureLabel,
            aspectSnapshot, aspectSnapshot ? 'pass-end-aspect' : 'aspect-not-captured', target.viewId);
        }
        continue;
      }
      const snapshot = list(pass?.snapshots).find(item => String(item.textureId) === String(outputId));
      const postDraw = drawSelected && postDrawSnapshots(pass, event).includes(snapshot);
      add(outputId, postDraw ? 'Draw 后输出' : snapshot ? 'Pass 结束读回' : '渲染目标',
        target.outputTextureLabel || target.textureLabel, snapshot, postDraw ? 'post-draw' : undefined);
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
      const area = item => (item.snapshot?.width || item.texture?.width || 0) *
        (item.snapshot?.height || item.texture?.height || 0);
      const capturedInputs = options.filter(item => item.evidence === 'pre-draw' &&
        (item.file || item.snapshot?.rawFile));
      const preferred = capturedInputs.sort((a, b) => area(b) - area(a))[0];
      state.selectedTextureKey = (preferred || options.find(item => item.snapshot) ||
        options.find(item => item.file) || options[0])?.key ?? null;
    }
    if (options.length) {
      const select = make('select');
      select.setAttribute('aria-label', '选择 Pass 输出或绑定纹理');
      select.style.maxWidth = 'none';
      select.style.width = '100%';
      for (const item of options) {
        const evidence = item.evidence === 'pre-draw' ? `Draw #${item.snapshot.drawCommandIndex} 前实拍 · mip ${item.mipLevel ?? 0}` :
          item.evidence === 'input-unavailable' ? `Draw 输入不可回读 · mip ${item.mipLevel ?? 0}` :
          item.evidence === 'pass-end-aspect' ? `Pass 结束 · ${item.snapshot.sampleCount > 1 ? `sample ${item.snapshot.sampleIndex ?? 0}/${item.snapshot.sampleCount}` : '单样本'}` :
          item.evidence === 'aspect-unavailable' ? '此 Pass 不可回读' :
          item.evidence === 'aspect-not-captured' ? '旧捕获无独立读回' :
          item.evidence === 'upstream-pass-candidate' ? `上游 Pass #${item.snapshot.passIndex} 候选` :
          item.evidence === 'post-draw' ? `Draw #${item.snapshot.drawCommandIndex} 后` :
          item.evidence === 'this-pass' ? '本 Pass 结束' :
          item.evidence === 'capture-final-unverified' ? '帧末快照，非 Draw 输入实拍' :
          item.evidence === 'view-unavailable' ? '视图范围未捕获' :
          item.evidence === 'pass-aggregate' ? '请选具体 Draw' :
          item.evidence === 'later-write' ? '最终状态已变化' :
          item.file ? '捕获最终' : '无图像';
        const option = make('option', `${item.role} · #${item.id} ${item.label} [${evidence}]`);
        if (item.bindingNames.length > 1) option.title = `共享此纹理的绑定：${item.bindingNames.join('、')}`;
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
    el('texture-note').textContent = !selected ? '选择 Pass 或 Draw 后检查绑定纹理。' :
      !selected.file && !selected.snapshot?.rawFile ?
        `#${selected.id} ${selected.texture.format || ''} · ${selected.texture.width} × ${selected.texture.height}。${selected.evidence === 'later-write' ? '该纹理随后被写入，最终图不能代表此刻输入。' :
          selected.evidence === 'input-unavailable' ? `所选 Draw 的输入未能读回：${selected.unavailableReason || '未提供原因'}。` :
          selected.evidence === 'aspect-unavailable' ? `所选 Pass 的${selected.role}未能读回：${selected.unavailableReason || '未提供原因'}。` :
          selected.evidence === 'aspect-not-captured' ? '这份旧捕获没有独立的深度/模板读回。' :
          selected.evidence === 'upstream-unavailable' ? '最近一次写入无当时读回，不能还原此刻输入。' :
          selected.evidence === 'view-unavailable' ? `${selected.unavailableReason}。` :
          selected.evidence === 'pass-aggregate' ? '此 Pass 有多个 Draw，请选具体 Draw 查看当时输入。' :
          `没有图像：${selected.texture.imageReason || '捕获未提供纹理字节'}。`}` :
        (selected.evidence === 'pre-draw' ?
          `真实 Draw #${selected.snapshot.drawCommandIndex} 前的 GPU 输入读回：绑定 ${selected.bindingNames.join('、') || selected.snapshot.bindingName || '未知'}，纹理 #${selected.id}，mip ${selected.snapshot.mipLevel ?? 0}，层 ${selected.snapshot.arrayLayer ?? 0}；来源 ${selected.snapshot.source || 'RHI pre-draw GPU readback'}；格式 ${selected.snapshot.format || selected.texture.format || '未知'}。` :
          selected.evidence === 'pass-end-aspect' ?
          `真实 Pass #${selected.snapshot.passIndex} 结束后的${selected.role}读回：纹理 #${selected.id}，${selected.snapshot.sourceFormat}；${selected.snapshot.sampleCount > 1 ? `MSAA sample ${selected.snapshot.sampleIndex ?? 0}/${selected.snapshot.sampleCount}` : '单样本'}；原始数据 ${selected.snapshot.rawFormat}。` :
          selected.evidence === 'upstream-pass-candidate' ?
          `显示上游 Pass #${selected.snapshot.passIndex} 的结束 GPU 读回；这是输入候选，未在所选 Draw 绑定时直接捕获，不能证明纹理当时内容。` : selected.snapshot ?
            `${selected.evidence === 'post-draw' ? `真实 Draw #${selected.snapshot.drawCommandIndex} 后` : '真实 Pass 结束'}读回：第 ${selected.snapshot.frameOrdinal} 帧 Pass #${selected.snapshot.passIndex}（${selected.snapshot.label || ''}），结束命令 #${selected.snapshot.afterCommandIndex}；来源 ${selected.snapshot.source}；格式 ${selected.snapshot.format || selected.texture.format || '未知'}。` :
            selected.evidence === 'capture-final-unverified' ?
              `这里只是捕获帧末的 mip0 纹理快照，未在所选 Draw 读取时抓取，不能证明是当时输入。${selected.texture.imagePreviewTransform || ''}` :
              `Inspector 纹理 mip0 最终状态快照，非所选 Draw / Pass 当时的输入。${selected.texture.imagePreviewTransform || ''}`) +
          (!selected.file && selected.snapshot?.rawFile ? 'PNG 未生成；画布尝试按可见区域读取原始 RT。' : '');
    if (selected?.snapshot?.aspect === 'depth') el('texture-note').textContent +=
      '深度按 0–1 线性显示；曝光只改变预览，不改原始值。';
    else if (selected?.snapshot?.aspect === 'stencil') el('texture-note').textContent +=
      '模板预览按非零值显示亮色；点击像素仍显示精确 u8 值，下载的原始数据不变。';
    else if (hasRawFloat(selected?.snapshot)) el('texture-note').textContent +=
      '浮点预览从原始值先应用曝光、再色调映射；PNG 仅供导出。';
  }

  function uniformValue(value) {
    if (Array.isArray(value)) return `[${value.map(uniformValue).join(', ')}]`;
    return typeof value === 'number' && Number.isFinite(value) ?
      String(Number(value.toPrecision(7))) : String(value);
  }
  function renderUniformFields(event, item, bytes) {
    const holder = el('buffer-uniform-fields');
    if (!holder) return;
    clear(holder);
    if (item?.kind !== 'bind-group' || item.slot == null || item.binding == null) {
      holder.appendChild(make('p', '顶点 / 索引 Buffer 没有可核实的 WGSL Uniform 字段布局。', 'muted small'));
      return;
    }
    const group = list(event?.bindGroups).find(value => Number(value.slot) === Number(item.slot));
    const entry = list(group?.resources).find(value => Number(value.binding) === Number(item.binding) &&
      value?.resource?.type === 'Buffer' && String(value.resource.id) === String(item.bufferId));
    if (!entry) {
      holder.appendChild(make('p', '选中 Draw 的绑定记录与字节文件不匹配，无法解码参数。', 'muted small'));
      return;
    }
    const result = window.GameDraftUniformInspector?.inspectBinding({
      shaders: resourceArray('shaders'), pipeline: pipelineForEvent(event),
      group: Number(item.slot), binding: Number(item.binding), bytes,
      declaredSize: entry.resource.size == null ? null : Number(entry.resource.size),
    }) || { status: 'unavailable', reason: 'Uniform 解码器未加载' };
    if (result.status !== 'ok') {
      holder.appendChild(make('p', `参数不可解码：${result.reason}`, 'muted small'));
      return;
    }
    holder.appendChild(make('h3', `${result.variable} · ${result.structName} · ${result.size} B`, 'section-caption'));
    const grid = make('table', undefined, 'binding-table uniform-table');
    const head = make('thead');
    const title = make('tr');
    for (const label of ['字段', 'WGSL 类型', '偏移', '捕获字节解码值']) title.appendChild(make('th', label));
    head.appendChild(title);
    grid.appendChild(head);
    const body = make('tbody');
    for (const field of result.fields) {
      const row = make('tr');
      for (const [index, value] of [field.name, field.type, `+${field.offset} B`, uniformValue(field.value)].entries()) {
        const cell = make('td', value);
        if (index === 3) cell.title = JSON.stringify(field.value);
        row.appendChild(cell);
      }
      body.appendChild(row);
    }
    grid.appendChild(body);
    holder.appendChild(grid);
  }
  const MAX_BUFFER_VIEW_BYTES = 16 * 1024 * 1024;
  function bufferIdentity(item) {
    if (item.role === 'vertex' || item.kind === 'vertex') {
      return 'v:' + item.vertexSlot + ':' + item.bufferId;
    }
    if (item.role === 'index' || item.kind === 'index') return 'i:' + item.bufferId;
    return 'g:' + (item.groupSlot ?? item.slot) + ':' + item.binding + ':' + item.bufferId;
  }
  function bufferChoices(event) {
    const pass = passFor(event.passIndex);
    const exactPass = pass?.frameDebugStep &&
      Number(pass.frameDebugStep.drawCommandIndex) === Number(event.commandIndex) &&
      Number(pass.frameOrdinal) === Number(event.frameOrdinal);
    const choices = [];
    const covered = new Set();
    if (exactPass) for (const snapshot of list(pass.bufferSnapshots)) {
      const choice = { key: 'draw:' + pass.index + ':' + snapshot.bufferOrdinal,
        type: 'snapshot', ...snapshot };
      choices.push(choice);
      covered.add(bufferIdentity(choice));
    }
    const names = shaderBindingNames(pipelineForEvent(event));
    for (const payload of list(event.bufferPayloads)) {
      if (payload.bufferId == null) continue;
      const group = payload.kind === 'bind-group' ? list(event.bindGroups).find(item =>
        Number(item.slot) === Number(payload.slot)) : null;
      const bound = payload.kind === 'bind-group' ? list(group?.resources).find(item =>
        Number(item.binding) === Number(payload.binding) &&
        String(item?.resource?.id) === String(payload.bufferId))?.resource :
        payload.kind === 'vertex' ? list(event.vertexBuffers).find(item =>
          Number(item.slot) === Number(payload.slot) && String(item.id) === String(payload.bufferId)) :
          payload.kind === 'index' && String(event.indexBuffer?.id) === String(payload.bufferId) ? event.indexBuffer : null;
      const choice = {
        key: 'legacy:' + payload.payloadId, type: 'legacy', payload,
        kind: payload.kind, bufferId: payload.bufferId, bufferLabel: payload.bufferLabel,
        groupSlot: payload.kind === 'bind-group' ? payload.slot : null,
        vertexSlot: payload.kind === 'vertex' ? payload.slot : null,
        binding: payload.binding, role: payload.kind === 'vertex' ? 'vertex' :
          payload.kind === 'index' ? 'index' : 'bound',
        size: payload.bytes ?? payload.byteLength,
        boundOffset: bound?.offset,
        boundSize: bound?.size,
        dynamicOffsets: list(group?.dynamicOffsets),
        bindingName: payload.kind === 'bind-group' ?
          names.get(payload.slot + ':' + payload.binding)?.name : null,
      };
      const identity = bufferIdentity(choice);
      if (!covered.has(identity)) {
        choices.push(choice);
        covered.add(identity);
      }
    }
    for (const group of list(event.bindGroups)) for (const entry of list(group.resources)) {
      const resource = entry?.resource;
      if (resource?.type !== 'Buffer' || resource.id == null) continue;
      const choice = {
        key: 'missing:g:' + group.slot + ':' + entry.binding + ':' + resource.id,
        type: 'missing', role: 'bound', groupSlot: group.slot, binding: entry.binding,
        bindingName: names.get(group.slot + ':' + entry.binding)?.name,
        bufferId: resource.id, bufferLabel: resource.label,
        offset: resource.offset ?? 0, size: resource.size ?? null,
      };
      const identity = bufferIdentity(choice);
      if (!covered.has(identity)) { choices.push(choice); covered.add(identity); }
    }
    for (const vertex of list(event.vertexBuffers)) {
      const choice = {
        key: 'missing:v:' + vertex.slot + ':' + vertex.id,
        type: 'missing', role: 'vertex', vertexSlot: vertex.slot,
        bufferId: vertex.id, bufferLabel: vertex.label,
        offset: vertex.offset ?? 0, size: vertex.size ?? null,
      };
      const identity = bufferIdentity(choice);
      if (!covered.has(identity)) { choices.push(choice); covered.add(identity); }
    }
    if (event.indexBuffer && String(event.method).startsWith('drawIndexed')) {
      const index = event.indexBuffer;
      const choice = {
        key: 'missing:i:' + index.id, type: 'missing', role: 'index',
        indexFormat: index.format, bufferId: index.id, bufferLabel: index.label,
        offset: index.offset ?? 0, size: index.size ?? null,
      };
      const identity = bufferIdentity(choice);
      if (!covered.has(identity)) { choices.push(choice); covered.add(identity); }
    }
    return choices;
  }
  function bufferRoleLabel(choice) {
    const names = { uniform: 'Uniform', storage: 'Storage',
      'read-only-storage': 'Read-only Storage', vertex: 'Vertex', index: 'Index', bound: '绑定 Buffer' };
    return names[choice.role] || choice.role || 'Buffer';
  }
  function bufferChoiceLabel(choice) {
    const evidence = choice.type === 'snapshot' ?
      choice.captureMoment === 'pre-draw' ? 'Draw 前' : '读回失败' :
      choice.type === 'legacy' ? '旧 Payload' : '无字节';
    const location = choice.groupSlot != null ? 'G' + choice.groupSlot + '/B' + choice.binding :
      choice.vertexSlot != null ? 'Slot ' + choice.vertexSlot : '';
    const name = choice.bindingName || choice.streamName || choice.bufferLabel || '';
    const boundOffset = choice.type === 'legacy' ? choice.boundOffset : choice.offset;
    const boundSize = choice.type === 'legacy' ? choice.boundSize : choice.size;
    const range = Number.isSafeInteger(boundOffset) ?
      ` · [${boundOffset}, ${Number.isSafeInteger(boundSize) ? boundOffset + boundSize : '末尾未记录'}) B` : '';
    return evidence + ' · ' + bufferRoleLabel(choice) + ' ' + name +
      (location ? ' · ' + location : '') + ' · #' + printable(choice.bufferId) +
      range;
  }
  function startBufferLoad(choice, file, expected) {
    if (!file || !Number.isSafeInteger(expected) || expected < 1 ||
        expected > MAX_BUFFER_VIEW_BYTES || bufferCache.has(choice.key) ||
        bufferPending.has(choice.key) || bufferErrors.has(choice.key)) return;
    const url = assetUrl(file);
    if (!url) { bufferErrors.set(choice.key, '文件路径无效'); return; }
    const pending = (async () => {
      const response = await fetch(url);
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength !== expected) {
        throw new Error('文件 ' + bytes.byteLength + ' B，报告记载 ' + expected + ' B');
      }
      bufferCache.set(choice.key, bytes);
      while (bufferCache.size > 3) bufferCache.delete(bufferCache.keys().next().value);
    })();
    bufferPending.set(choice.key, pending);
    pending.catch(error => bufferErrors.set(choice.key, error.message || String(error)))
      .finally(() => {
        bufferPending.delete(choice.key);
        if (state.selectedBufferPayloadId === choice.key) renderBufferInspector();
      });
  }
  function renderBufferInspector() {
    const event = focusedDraw();
    const draw = event && (state.selectedPass == null ||
      Number(event.passIndex) === Number(state.selectedPass)) ? event : null;
    const choices = draw ? bufferChoices(draw) : [];
    const selector = el('buffer-select');
    clear(selector);
    const exactCount = choices.filter(item => item.type === 'snapshot' && item.captureMoment === 'pre-draw').length;
    el('buffer-count').textContent = choices.length + ' 项 · ' + exactCount + ' 项 Draw 前';
    const save = el('buffer-save');
    const retry = el('buffer-load-full');
    const hex = el('buffer-hex');
    const grid = el('buffer-table-wrap');
    const uniformFields = el('buffer-uniform-fields');
    clear(uniformFields);
    save.hidden = retry.hidden = hex.hidden = grid.hidden = true;
    el('buffer-page-status').textContent = '';
    if (!choices.length) {
      selector.disabled = true;
      const pass = state.selectedPass == null ? null : passFor(state.selectedPass);
      const drawCount = pass ? state.events.filter(item => Number(item?.passIndex) === Number(pass.index) &&
        ['draw', 'dispatch'].includes(eventKind(String(item?.method || '')))).length : 0;
      el('buffer-note').textContent = draw ?
        '该 Draw 没有可核实的 Buffer 绑定或字节。' : drawCount > 1 ?
          `这个 Pass 有 ${drawCount} 个 Draw / Dispatch，请在左侧选择具体命令查看当时的 Buffer。` :
          '选择一个 Draw 查看实际绑定的 Buffer。';
      return;
    }
    selector.disabled = false;
    for (const choice of choices) {
      const option = make('option', bufferChoiceLabel(choice));
      option.value = choice.key;
      selector.appendChild(option);
    }
    if (state.preferredBufferBinding) {
      const target = state.preferredBufferBinding;
      state.selectedBufferPayloadId = choices.find(item =>
        Number(item.groupSlot) === Number(target.groupSlot) &&
        Number(item.binding) === Number(target.binding) &&
        String(item.bufferId) === String(target.bufferId))?.key ?? null;
      state.preferredBufferBinding = null;
    }
    if (typeof state.selectedBufferPayloadId === 'number') {
      state.selectedBufferPayloadId = choices.find(item =>
        item.type === 'legacy' && item.payload.payloadId === state.selectedBufferPayloadId)?.key ?? null;
    }
    if (!choices.some(item => item.key === state.selectedBufferPayloadId)) {
      state.selectedBufferPayloadId = choices[0].key;
    }
    selector.value = state.selectedBufferPayloadId;
    const choice = choices.find(item => item.key === state.selectedBufferPayloadId);
    if (el('buffer-offset').dataset.choice !== choice.key) {
      el('buffer-offset').dataset.choice = choice.key;
      el('buffer-offset').value = String(choice.type === 'snapshot' ? choice.offset : 0);
    }
    let file = null;
    let expected = null;
    let fileBase = 0;
    let rangeStart = 0;
    let rangeSize = 0;
    let note = '';
    if (choice.type === 'snapshot') {
      file = choice.captureMoment === 'pre-draw' ? choice.rawFile : null;
      expected = choice.rawByteLength;
      fileBase = choice.copiedOffset;
      rangeStart = choice.offset;
      rangeSize = choice.size;
      note = (choice.captureMoment === 'pre-draw' ?
        'Draw #' + draw.commandIndex + ' 前 GPU 实际读回 · ' :
        'Draw #' + draw.commandIndex + ' 前读回请求 · ') +
        bufferRoleLabel(choice) + ' ' + (choice.bindingName || choice.streamName || '') +
        ' · Buffer #' + choice.bufferId + ' ' + (choice.bufferLabel || '') +
        ' · 绑定范围 [' + choice.offset + ', ' + (choice.offset + choice.size) + ') B' +
        ' · 文件拷贝范围 [' + choice.copiedOffset + ', ' +
        (choice.copiedOffset + choice.copiedSize) + ') B' +
        (choice.rangeScope === 'bound-suffix' ? '（Vertex 为绑定剩余范围，可能包含未读取顶点）' :
          choice.rangeScope === 'draw-indices' ? '（Index 为本 Draw 使用的索引字节）' : '') + '。';
      if (!file) note = 'Draw 前 Buffer 不可用：' + (choice.reason || '未保存字节') +
        (choice.rawReason ? ' · ' + choice.rawReason : '') + '。' + note;
    } else if (choice.type === 'legacy') {
      const payload = payloadFor(choice.payload.payloadId);
      file = payload?.bufferFile || null;
      expected = payload?.bytes;
      rangeSize = Number.isSafeInteger(payload?.bytes) ? payload.bytes : 0;
      const boundRange = Number.isSafeInteger(choice.boundOffset) ?
        `；此 Draw 的绑定范围 [${choice.boundOffset}, ${Number.isSafeInteger(choice.boundSize) ?
          choice.boundOffset + choice.boundSize : '末尾未记录'}) B` +
          (choice.dynamicOffsets.length ? '（Group 动态偏移未映射到具体槽位）' : '') : '';
      note = '旧 Inspector payload #' + choice.payload.payloadId + '，关联绑定命令 #' +
        choice.payload.sourceCommandIndex + ' / Draw #' + draw.commandIndex +
        boundRange + '。GPU 拷贝在 Pass 结束后编码，不能证明 Draw 前值；以下偏移属于 payload 文件，不代表绑定起点。' +
        (!file ? ' 完整文件未导出：' + (payload?.bufferExportReason || '无记录') + '。' : '');
    } else {
      note = '该 Draw 绑定了 Buffer #' + choice.bufferId + ' ' + (choice.bufferLabel || '') +
        '，但没有可用的 Draw 前读回或旧 Inspector payload。';
    }
    el('buffer-note').textContent = note;
    const url = assetUrl(file);
    if (url) {
      save.hidden = false;
      save.href = url;
      save.textContent = choice.type === 'snapshot' ? '下载 Draw 前 .bin' : '下载旧 Payload .bin';
      save.download = choice.type === 'snapshot' ?
        'draw-' + draw.commandIndex + '-buffer-' + choice.bufferId + '-' + choice.bufferOrdinal + '.bin' :
        'buffer-' + choice.bufferId + '-payload-' + choice.payload.payloadId + '.bin';
    }
    if (!file && choice.type !== 'legacy') return;
    if (file && expected > MAX_BUFFER_VIEW_BYTES) {
      el('buffer-note').textContent += ' 文件超过 16 MiB，保留下载，页面不自动加载。';
      return;
    }
    let bytes = bufferCache.get(choice.key);
    if (!bytes && choice.type === 'legacy') {
      const payload = payloadFor(choice.payload.payloadId);
      try {
        bytes = Uint8Array.from(atob(payload?.previewBase64 || ''), char => char.charCodeAt(0));
      } catch { el('buffer-note').textContent += ' 旧 payload 预览解码失败。'; }
    }
    if (!bufferCache.has(choice.key) && file) startBufferLoad(choice, file, expected);
    const loadError = bufferErrors.get(choice.key);
    if (loadError) {
      el('buffer-note').textContent += ' 字节文件读取失败：' + loadError + '。';
      retry.hidden = false;
    } else if (!bytes && file) el('buffer-note').textContent += ' 正在读取字节…';
    if (!bytes?.byteLength) return;
    const availableEnd = Math.min(rangeStart + rangeSize, fileBase + bytes.byteLength);
    const logicalStart = rangeStart - fileBase;
    if (choice.type === 'snapshot' && choice.captureMoment === 'pre-draw' &&
        choice.role === 'uniform' && logicalStart >= 0 &&
        bytes.byteLength >= logicalStart + rangeSize) {
      renderUniformFields(draw, { kind: 'bind-group', slot: choice.groupSlot,
        binding: choice.binding, bufferId: choice.bufferId, role: choice.role },
        bytes.subarray(logicalStart, logicalStart + rangeSize));
    } else if (choice.type === 'snapshot' && choice.role !== 'uniform') {
      uniformFields.appendChild(make('p', '该绑定不是 Uniform；使用下方原始字节查看。', 'muted small'));
    } else if (choice.type === 'legacy') {
      uniformFields.appendChild(make('p', '旧 payload 不是可靠的 Draw 前绑定范围，字段值不作 Uniform 解码。', 'muted small'));
    }
    const requested = Number(el('buffer-offset').value);
    const clamped = Number.isFinite(requested) ?
      Math.max(rangeStart, Math.min(availableEnd - 1, Math.floor(requested))) : rangeStart;
    if (availableEnd <= rangeStart || clamped < fileBase) {
      el('buffer-page-status').textContent = '选定范围尚未加载。';
      return;
    }
    const offset = rangeStart + Math.floor((clamped - rangeStart) / 4) * 4;
    const page = bytes.subarray(offset - fileBase, Math.min(offset - fileBase + 256, availableEnd - fileBase));
    el('buffer-page-status').textContent = '[' + offset + ', ' + (offset + page.length) +
      ') / [' + rangeStart + ', ' + (rangeStart + rangeSize) + ') B' +
      (availableEnd < rangeStart + rangeSize ? ' · 当前仅有预览字节' : '');
    const lines = [];
    for (let position = 0; position < page.length; position += 16) {
      const row = page.subarray(position, position + 16);
      lines.push((offset + position).toString(16).padStart(8, '0') + '  ' +
        [...row].map(byte => byte.toString(16).padStart(2, '0')).join(' ').padEnd(47) +
        '  |' + [...row].map(byte => byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '.').join('') + '|');
    }
    hex.textContent = lines.join('\n') || '范围内没有字节';
    hex.hidden = false;
    const rows = el('buffer-rows');
    clear(rows);
    const view = new DataView(page.buffer, page.byteOffset, page.byteLength);
    for (let position = 0; position + 4 <= page.length; position += 4) {
      const tr = make('tr');
      const float = view.getFloat32(position, true);
      for (const value of [
        (offset + position).toString(16).padStart(8, '0'),
        [...page.subarray(position, position + 4)].map(byte => byte.toString(16).padStart(2, '0')).join(' '),
        view.getUint32(position, true), Number.isFinite(float) ? String(Number(float.toPrecision(7))) : String(float),
      ]) tr.appendChild(make('td', value));
      rows.appendChild(tr);
    }
    grid.hidden = rows.childElementCount === 0;
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
        kind === 'shaders' ? `${typeof item?.code === 'string' ? item.code.length : 0} 字符 WGSL` :
        kind === 'samplers' ? [item?.descriptor?.minFilter, item?.descriptor?.magFilter,
          item?.descriptor?.addressModeU, item?.descriptor?.addressModeV].filter(Boolean).join(' · ') : '';
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
    if (kind === 'samplers') {
      const descriptor = item.descriptor || {};
      addDetailRow(grid, 'Min / Mag / Mipmap', [descriptor.minFilter, descriptor.magFilter,
        descriptor.mipmapFilter].map(printable).join(' / '));
      addDetailRow(grid, 'U / V / W 寻址', [descriptor.addressModeU, descriptor.addressModeV,
        descriptor.addressModeW].map(printable).join(' / '));
      addDetailRow(grid, 'LOD', `${printable(descriptor.lodMinClamp)}–${printable(descriptor.lodMaxClamp)}`);
      addDetailRow(grid, 'Compare / Anisotropy', `${printable(descriptor.compare)} / ${printable(descriptor.maxAnisotropy)}`);
    }
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
      const snapshots = list(state.report?.bufferSnapshots).filter(snapshot =>
        String(snapshot.bufferId) === String(item.id));
      const exact = snapshots.filter(snapshot => snapshot.captureMoment === 'pre-draw').length;
      const unavailable = snapshots.filter(snapshot => snapshot.captureMoment === 'unavailable').length;
      const captured = list(state.report?.payloads).filter(payload => list(payload.bufferIds).some(id => String(id) === String(item.id)));
      holder.appendChild(make('p', `Draw 前读回 ${exact} 份，失败 ${unavailable} 份；旧 Inspector payload ${captured.length} 份。` +
        (exact ? '选择对应 Draw 的 Buffers 面板查看准确的绑定范围和原始字节。' :
          '旧 payload 在 Pass 后拷贝，不能证明 Draw 前值。'), 'inspect-note'));
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

  function outputChoicesFor(pass) {
    if (!pass) return [];
    const choices = [];
    for (const target of list(pass.targets)) {
      const color = target.kind === 'color';
      if (!color && target.kind !== 'depth-stencil') continue;
      const textureId = color ? target.outputTextureId ?? target.textureId : target.textureId;
      const aspects = color ? [null] : target.format?.includes('stencil') ? ['depth', 'stencil'] : ['depth'];
      for (const aspect of aspects) {
        const snapshot = color ? list(pass.snapshots).find(item =>
          String(item.textureId) === String(textureId)) : list(pass.aspectSnapshots).find(item =>
            item.aspect === aspect && String(item.textureId) === String(textureId) &&
            String(item.viewId) === String(target.viewId));
        const role = color ? `Color ${target.slot}` : aspect === 'depth' ? 'Depth' : 'Stencil';
        const label = `${role} · #${printable(textureId)} ${target.outputTextureLabel || target.textureLabel || ''}`.trim();
        choices.push({
          key: `${pass.index}:${role}:${textureId}`, label, role, target, snapshot: snapshot || null,
          unavailableReason: snapshot?.reason || (!snapshot?.imageFile && !snapshot?.rawFile ?
            snapshot?.imageReason || snapshot?.rawReason : null) ||
            pass.outputUnavailableReason || pass.partialOutputUnavailableReason ||
            '该输出没有此 Pass 结束时的 GPU 读回',
        });
      }
    }
    return choices;
  }

  function renderFrame() {
    const frame = state.selectedFrame === null ? null : selectedFrame();
    const pass = state.selectedPass === null ? null : passFor(state.selectedPass);
    state.outputChoices = outputChoicesFor(pass);
    if (!state.outputChoices.some(item => item.key === state.selectedOutputKey)) {
      state.selectedOutputKey = (state.outputChoices.find(item => item.snapshot?.imageFile || item.snapshot?.rawFile) ||
        state.outputChoices[0])?.key ?? null;
    }
    const outputs = el('output-choices');
    clear(outputs);
    if (state.outputChoices.length) {
      const select = make('select');
      select.setAttribute('aria-label', '选择所选 Pass 的输出渲染目标');
      for (const item of state.outputChoices) {
        const available = !!(item.snapshot?.imageFile || item.snapshot?.rawFile);
        const option = make('option', `${item.label}${available ? '' : ' · 未读回'}`);
        option.value = item.key;
        option.title = available ? item.snapshot?.source || 'Pass 结束 GPU 读回' : item.unavailableReason;
        select.appendChild(option);
      }
      select.value = state.selectedOutputKey;
      select.addEventListener('change', () => {
        state.selectedOutputKey = select.value;
        renderFrame();
        renderPreviewMode();
      });
      outputs.appendChild(select);
    }
    const selected = state.outputChoices.find(item => item.key === state.selectedOutputKey);
    const snapshot = selected?.snapshot || null;
    const postDraw = snapshot?.captureMoment === 'post-draw';
    const file = pass ? snapshot?.imageFile || null : frame ? frame.imageFile : state.report?.frameImage;
    const unavailableReason = pass && !snapshot?.imageFile && !snapshot?.rawFile ?
      `Pass #${pass.index}${selected ? ` 的 ${selected.role}` : ''} 输出不可查看：${selected?.unavailableReason ||
        '没有可识别的输出目标或 GPU 读回'}` : null;
    state.frameChoice = { file, snapshot, frame, pass, unavailableReason,
      label: pass ? selected?.label || describePass(pass) : frame ? `第 ${frame.frameOrdinal} 帧画布` : '捕获保存时画布',
      format: snapshot?.sourceFormat || snapshot?.format || selected?.target?.format ||
        (pass ? null : frame?.format) || null,
      source: snapshot?.source || (postDraw ? '单 Draw 物理 Pass 结束 GPU 读回' :
        pass ? 'Pass 结束 GPU 读回' : frame ? frame.imageSource || '帧画布' : '捕获最终画布'),
      width: snapshot?.width || (pass ? null : frame?.width) || null,
      height: snapshot?.height || (pass ? null : frame?.height) || null };
    if (state.pixelTimeline) {
      const trace = state.pixelTimeline;
      if (!snapshot?.rawFile || Number(snapshot.frameOrdinal) !== trace.frameOrdinal ||
          String(snapshot.textureId) !== String(trace.textureId) ||
          (snapshot.aspect || null) !== trace.aspect || Number(snapshot.sampleIndex ?? 0) !== Number(trace.sampleIndex)) {
        clearPixelTimeline();
      } else highlightPixelTimeline();
    }
    el('frame-note').textContent = unavailableReason || (snapshot ?
      `${selected.label}：${postDraw ? `真实 Draw #${snapshot.drawCommandIndex} 后` : `真实 Pass #${snapshot.passIndex} 结束后`}的 GPU 读回${snapshot.afterCommandIndex != null ? `（命令 #${snapshot.afterCommandIndex}）` : ''}；来源 ${snapshot.source || '捕获 sidecar'}。${snapshot.imageFile ? '' : 'PNG 缺失；画布使用原始 RT。'}${postDraw && pass?.frameDebugStep ?
        `逻辑 Pass「${pass.frameDebugStep.logicalLabel}」的第 ${pass.frameDebugStep.drawOrdinal}/${pass.frameDebugStep.totalDraws} 个 Draw。` :
        !postDraw && state.focusScope === 'draw' ? '这是 Pass 结束状态，不能认作所选 Draw 后状态。' : ''}` :
      frame ? `帧边界按 queue.submit 推断。${frame.imageSource ? `图像来源：${frame.imageSource}。` : ''}` :
        '这里显示捕获保存时的最终画布状态；多帧时不代表每一帧。');
    if (hasRawFloat(snapshot)) el('frame-note').textContent +=
      '浮点预览从原始值先应用曝光、再色调映射；PNG 仅供导出。';
  }

  function renderPreviewMode() {
    const texture = state.previewMode === 'texture';
    const mesh = state.previewMode === 'mesh';
    if ((texture || mesh) && state.pixelTimeline) clearPixelTimeline();
    for (const [id, active] of [['preview-frame-button', !texture && !mesh],
      ['preview-texture-button', texture], ['preview-mesh-button', mesh]]) {
      const button = el(id);
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    el('preview-texture-button').disabled = !state.textureChoices.length;
    el('output-choices').hidden = texture || mesh || !state.outputChoices.length;
    el('texture-scope').hidden = !texture;
    el('texture-choices').hidden = !texture;
    el('texture-count').textContent = texture ? `${state.textureChoices.length} 张纹理` :
      `${state.outputChoices.length} 个输出`;
    el('texture-controls').hidden = mesh;
    el('mesh-controls').hidden = !mesh;
    el('mesh-preview').hidden = !mesh;
    el('surface-mount').parentElement.hidden = mesh;
    el('pixel-readout').hidden = mesh;
    document.querySelector('.preview-evidence').hidden = mesh;
    document.querySelector('.preview-head-meta').hidden = mesh;
    el('frame-title').textContent = mesh ? 'Mesh Preview' : 'Render Target';
    if (mesh) {
      renderMeshInspector();
      return;
    }
    ++meshRenderTicket;
    el('frame-note').hidden = texture;
    el('texture-note').hidden = !texture;
    const selected = state.textureChoices.find(item => item.key === state.selectedTextureKey);
    const choice = texture ? selected && {
      file: selected.file, snapshot: selected.snapshot,
      label: `${selected.role} · ${selected.label}`,
      format: selected.snapshot?.sourceFormat || selected.snapshot?.format || selected.texture?.format,
      source: selected.evidence === 'pre-draw' ? `Draw #${selected.snapshot.drawCommandIndex} 前 GPU 输入读回 · mip ${selected.mipLevel ?? 0}` :
        selected.evidence === 'pass-end-aspect' ?
          `Pass #${selected.snapshot.passIndex} 结束 GPU ${selected.role}读回` :
        selected.evidence === 'upstream-pass-candidate' ? `上游 Pass #${selected.snapshot.passIndex} 读回 · Draw 输入未验证` :
        selected.evidence === 'post-draw' ? `Draw #${selected.snapshot.drawCommandIndex} 后 GPU 读回` :
        selected.snapshot ? '本 Pass 结束 GPU 读回' :
        selected.evidence === 'capture-final-unverified' ? '帧末快照 · Draw 输入未验证' : '捕获最终状态快照',
      width: selected.snapshot?.width || selected.texture?.width,
      height: selected.snapshot?.height || selected.texture?.height,
      id: selected.id,
    } : state.frameChoice;
    const url = assetUrl(choice?.file);
    const unavailable = el('output-unavailable');
    unavailable.hidden = texture || mesh || !!url || !!assetUrl(choice?.snapshot?.rawFile) ||
      !choice?.unavailableReason;
    unavailable.textContent = unavailable.hidden ? '' : choice.unavailableReason;
    const save = el('texture-save');
    const saveRaw = el('texture-save-raw');
    save.hidden = !url;
    const rawUrl = assetUrl(choice?.snapshot?.rawFile);
    saveRaw.hidden = !rawUrl;
    if (rawUrl) {
      saveRaw.href = rawUrl;
      saveRaw.download = choice.snapshot.aspect ?
        `pass-${choice.snapshot.passIndex}-${choice.snapshot.aspect}-${choice.snapshot.rawFormat}.bin` :
        choice.snapshot.captureMoment === 'pre-draw' ?
        `draw-${choice.snapshot.drawCommandIndex}-input-${choice.snapshot.textureId}-mip-${choice.snapshot.mipLevel ?? 0}-${choice.snapshot.rawFormat || 'raw'}.bin` :
        `pass-${choice.snapshot.passIndex}-texture-${choice.snapshot.textureId}-${choice.snapshot.rawFormat || 'raw'}.bin`;
    }
    if (url) {
      save.href = url;
      save.download = texture ? `texture-${selected.id}${selected.snapshot?.aspect ?
        `-pass-${selected.snapshot.passIndex}-${selected.snapshot.aspect}` :
        selected.evidence === 'pre-draw' ? `-draw-${selected.snapshot.drawCommandIndex}-input-mip-${selected.mipLevel ?? 0}` :
        selected.evidence === 'post-draw' ? `-draw-${selected.snapshot.drawCommandIndex}` :
        selected.snapshot ? '-pass-end' : '-capture-final'}.png` :
        choice.snapshot?.captureMoment === 'post-draw' ? `draw-${choice.snapshot.drawCommandIndex}-output.png` :
          choice.snapshot ? `pass-${choice.snapshot.passIndex}-output.png` : 'frame-output.png';
    }
    const signature = `${url || ''}|${rawUrl || ''}|${choice?.label || ''}|${choice?.source || ''}`;
    if (state.activeSurface?.signature !== signature || state.activeSurface?.snapshot !== choice?.snapshot) {
      const priorZoom = surface.getState();
      state.activeSurface = { url: url || rawUrl, signature, snapshot: choice?.snapshot || null };
      const pixelTip = '点击画面查看坐标和原始通道值；Ctrl+滚轮缩放，滚轮平移，拖动平移。';
      el('pixel-value').textContent = pixelTip;
      el('pixel-value').title = pixelTip;
      surface.setSource(url || rawUrl ? { url, rawUrl, label: choice.label, format: choice.format,
        rawFormat: choice?.snapshot?.rawFormat, aspect: choice?.snapshot?.aspect,
        rawBytesPerRow: choice?.snapshot?.rawBytesPerRow,
        rawByteLength: choice?.snapshot?.rawByteLength,
        source: choice.source, width: choice.width, height: choice.height } : null).then(result => {
        if (state.activeSurface?.signature !== signature) return;
        el('frame-size').textContent = result.imageWidth ?
          `${result.imageWidth} × ${result.imageHeight} · ${!url && rawUrl ? choice?.snapshot?.rawFormat || '原始 RT' : choice.format || 'PNG'}${hasRawFloat(choice?.snapshot) && result.nativeRtBytes ? ' · 原始浮点值' : ''}` : '';
        if (result.imageWidth && priorZoom.zoomMode !== 'fit') {
          const zoom = surface.setZoom(priorZoom.zoomPercent);
          const select = el('texture-zoom');
          const match = [...select.options].find(option => Number(option.value) === Math.round(zoom.zoomPercent));
          if (match) select.value = match.value;
          else {
            let custom = select.querySelector('option[value="custom"]');
            if (!custom) { custom = make('option'); custom.value = 'custom'; select.appendChild(custom); }
            custom.textContent = `${Math.round(zoom.zoomPercent)}% 自定义`;
            select.value = 'custom';
          }
        } else if (result.imageWidth) el('texture-zoom').value = 'fit';
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
    const passes = list(state.report?.passes).filter(pass => !pass?.diagnosticAuxiliary &&
      (state.selectedFrame === null || Number(pass?.frameOrdinal) === Number(state.selectedFrame)));
    const measured = passes.filter(pass => pass.gpuTiming?.source === 'webgpu-timestamp-query' &&
      finite(pass.gpuTiming.durationMs) && pass.gpuTiming.durationMs >= 0);
    const bars = el('gpu-bars');
    const rows = el('gpu-table-body');
    clear(bars);
    clear(rows);
    const note = el('gpu-note');
    const hasDrawSteps = measured.some(pass => pass.frameDebugStep);
    if (note) note.textContent = !measured.length ?
      `${frame ? `第 ${frame.frameOrdinal} 帧` : '捕获'}没有可用的 GPU Pass 时间戳；未测项显示 —。` :
      `${frame ? `第 ${frame.frameOrdinal} 帧` : '捕获'} · GPU Pass 实测时间戳；未测项留空。` +
        (hasDrawSteps ? '逐 Draw 阶段计的是单 Draw 物理 Pass（含 Pass 开销），没有独立的 Draw 指令计时。' :
          '没有逐 Draw GPU 时间和历史曲线。');
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
    for (const key of ['expandedFrames', 'collapsedFrames', 'expandedPasses', 'collapsedPasses',
      'expandedCategories', 'collapsedCategories', 'expandedBatches', 'collapsedBatches',
      'expandedSteps', 'collapsedSteps']) state[key].clear();
    clearPixelTimeline();
    state.events = list(report.events);
    state.resources = report.resources && typeof report.resources === 'object' ? report.resources : {};
    const textureTimeline = buildTextureWriteTimeline(report);
    state.textureWrites = textureTimeline.writes;
    state.textureViews = textureTimeline.views;
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
  el('preview-mesh-button').addEventListener('click', () => { state.previewMode = 'mesh'; renderPreviewMode(); });
  el('preview-maximize')?.addEventListener('click', () => {
    const host = document.querySelector('.frame-main');
    const maximized = host.classList.toggle('preview-maximized');
    const button = el('preview-maximize');
    button.textContent = maximized ? '还原' : '放大输出';
    button.setAttribute('aria-pressed', String(maximized));
    button.title = maximized ? '还原输出预览和事件信息' : '最大化输出预览';
  });
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
    renderPasses();
    renderEvents();
    renderEventDetail();
    state.selectedTextureKey = null;
    state.selectedBufferPayloadId = null;
    if (state.previewMode !== 'mesh') state.previewMode = 'frame';
    renderTextureInspector();
    renderBufferInspector();
    renderFrame();
    renderPreviewMode();
    if (state.mode === 'gpu') renderGpu();
    if (state.selectedEvent !== null) el('event-tree').querySelector(`[data-event-index="${state.selectedEvent}"]`)?.scrollIntoView({ block: 'center' });
  });
  el('clear-pass').addEventListener('click', () => {
    el('event-search').value = '';
    el('event-kind').value = 'visual';
    state.frameFilter = null;
    renderFrameSelector();
    state.eventLimit = PAGE_SIZE;
    renderPasses();
    renderEvents();
    if (state.navigationIndices.length) selectEvent(state.navigationIndices[0], true);
    else {
      state.selectedPass = null;
      state.selectedEvent = null;
      renderEventDetail();
      renderTextureInspector();
      renderBufferInspector();
      renderFrame();
      renderPreviewMode();
    }
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
    state.selectedBufferPayloadId = el('buffer-select').value;
    renderBufferInspector();
  });
  el('mesh-position-location').addEventListener('change', () => {
    state.meshLocation = Number(el('mesh-position-location').value);
    renderMeshInspector();
  });
  el('buffer-offset').addEventListener('change', renderBufferInspector);
  el('buffer-load-full').addEventListener('click', () => {
    const key = state.selectedBufferPayloadId;
    bufferErrors.delete(key);
    renderBufferInspector();
  });
  loadReport().then(renderAll, error => showError(error instanceof Error ? error.message : String(error)));
}());
