// Reusable PNG/native-RT surface inspector for the frame viewer.
// Raw viewports fetch byte ranges; file:// viewers use one capped local read.
(function () {
  'use strict';

  const CHANNELS = new Set(['rgba', 'red', 'green', 'blue', 'alpha']);
  const MAX_CACHE_ITEMS = 8;
  const MAX_CACHE_RAW_BYTES = 96 * 1024 * 1024;
  const MAX_SAMPLE_BYTES = 64 * 1024 * 1024;
  const MAX_RAW_RANGE_BYTES = 8 * 1024 * 1024;
  const MAX_RAW_CACHE_BYTES = 64 * 1024 * 1024;
  const MAX_RAW_FILE_BYTES = 512 * 1024 * 1024;
  const MAX_VIEWPORT_PIXELS = 8 * 1024 * 1024;
  const RAW_BYTES_PER_PIXEL = new Map([
    ['r8unorm', 1], ['stencil8', 1], ['rg8unorm', 2], ['r16float', 2], ['rg16float', 4],
    ['r32float', 4], ['rg32float', 8], ['r32uint', 4], ['rgba32uint', 16],
    ['rgba8unorm', 4], ['rgba8unorm-srgb', 4],
    ['bgra8unorm', 4], ['bgra8unorm-srgb', 4],
    ['rgba16float', 8], ['rgba32float', 16],
  ]);
  const FLOAT_RT_FORMATS = new Set(['r16float', 'rg16float', 'rgba16float',
    'r32float', 'rg32float', 'rgba32float']);
  const UINT_RT_FORMATS = new Set(['r32uint', 'rgba32uint']);
  const STENCIL_RT_FORMATS = new Set(['stencil8']);
  const componentCount = format => format.startsWith('rgba') || format.startsWith('bgra') ? 4 :
    format.startsWith('rg') ? 2 : 1;
  const MIN_SCALE = 0.001;
  const MAX_SCALE = 4096;

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const byte = value => clamp(Math.round(value), 0, 255);
  function exposedColorByte(value, factor, floatRt) {
    const exposed = value * factor;
    if (!floatRt) return byte(exposed * 255);
    // Match the capture PNG's Reinhard curve, but apply EV before mapping HDR values.
    const positive = Number.isFinite(exposed) ? Math.max(0, exposed) : 0;
    return byte(255 * positive / (1 + positive));
  }

  function halfFloat(bits) {
    const sign = bits & 0x8000 ? -1 : 1;
    const exponent = (bits >> 10) & 31;
    const mantissa = bits & 1023;
    if (!exponent) return sign * 2 ** -14 * mantissa / 1024;
    if (exponent === 31) return mantissa ? NaN : sign * Infinity;
    return sign * 2 ** (exponent - 15) * (1 + mantissa / 1024);
  }

  function makeRawReader(next) {
    const format = next.rawFormat || next.format;
    const bpp = RAW_BYTES_PER_PIXEL.get(format);
    if (!bpp) throw new Error(`无法直接预览原始 RT 格式：${format || '未知'}`);
    const width = next.width;
    const height = next.height;
    const stride = next.rawBytesPerRow;
    const length = next.rawByteLength;
    if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0 ||
        !Number.isSafeInteger(stride) || stride < width * bpp ||
        !Number.isSafeInteger(length) || length !== stride * height || length > MAX_RAW_FILE_BYTES) {
      throw new Error('原始 RT 尺寸或行跨度无效');
    }
    return { url: next.rawUrl, format, bpp, width, height, stride, length,
      rows: new Map(), cachedBytes: 0 };
  }

  function decodeRawPixel(reader, view, offset, out) {
    const format = reader.format;
    out[0] = out[1] = out[2] = 0;
    out[3] = 1;
    if (format === 'stencil8') {
      out[0] = view.getUint8(offset);
      out[1] = out[2] = out[0];
    } else if (format === 'r8unorm') {
      out[0] = view.getUint8(offset) / 255;
      out[1] = out[2] = out[0];
    } else if (format === 'rg8unorm') {
      out[0] = view.getUint8(offset) / 255;
      out[1] = view.getUint8(offset + 1) / 255;
    } else if (format.startsWith('rgba8') || format.startsWith('bgra8')) {
      const bgra = format.startsWith('bgra');
      out[0] = view.getUint8(offset + (bgra ? 2 : 0)) / 255;
      out[1] = view.getUint8(offset + 1) / 255;
      out[2] = view.getUint8(offset + (bgra ? 0 : 2)) / 255;
      out[3] = view.getUint8(offset + 3) / 255;
    } else if (FLOAT_RT_FORMATS.has(format)) {
      const count = componentCount(format);
      const half = format.includes('16');
      for (let i = 0; i < count; i++) out[i] = half ?
        halfFloat(view.getUint16(offset + i * 2, true)) : view.getFloat32(offset + i * 4, true);
      if (count === 1) out[1] = out[2] = out[0];
    } else if (UINT_RT_FORMATS.has(format)) {
      const count = componentCount(format);
      for (let i = 0; i < count; i++) out[i] = view.getUint32(offset + i * 4, true);
      if (count === 1) out[1] = out[2] = out[0];
    }
    return out;
  }

  async function fetchRawRange(reader, start, end, signal) {
    const length = end - start + 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 ||
        end >= reader.length || length <= 0 || length > MAX_RAW_RANGE_BYTES) {
      throw new RangeError('原始 RT 读取范围无效');
    }
    // A double-clicked offline viewer uses file://, whose response ignores HTTP
    // Range. Keep one bounded copy per source so pixel inspection still works.
    if (reader.url.startsWith('file:')) {
      if (reader.length > 64 * 1024 * 1024) {
        throw new Error('离线原始 RT 超过 64 MiB，请从游戏内打开分析器按范围读取');
      }
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      reader.offlineBytes ||= fetch(reader.url, { signal }).then(async response => {
        if (!response.ok) throw new Error(`离线原始 RT 读取失败：HTTP ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength !== reader.length) throw new Error('离线原始 RT 文件长度不匹配');
        return bytes;
      });
      const bytes = await reader.offlineBytes;
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      return bytes.slice(start, end + 1);
    }
    const response = await fetch(reader.url, { headers: { Range: `bytes=${start}-${end}` }, signal });
    const range = response.headers.get('content-range');
    if (response.status !== 206 || range !== `bytes ${start}-${end}/${reader.length}`) {
      void response.body?.cancel().catch(() => {});
      throw new Error(response.status === 200 ? '抓帧文件服务不支持按范围读取原始 RT' :
        `原始 RT 范围读取失败：HTTP ${response.status}`);
    }
    const declared = Number(response.headers.get('content-length'));
    if (declared !== length) {
      void response.body?.cancel().catch(() => {});
      throw new Error('原始 RT 范围长度不匹配');
    }
    const result = new Uint8Array(length);
    const stream = response.body?.getReader();
    if (!stream) throw new Error('原始 RT 响应没有字节流');
    let received = 0;
    while (true) {
      const { done, value } = await stream.read();
      if (done) break;
      if (received + value.byteLength > length) {
        await stream.cancel();
        throw new Error('原始 RT 响应超出声明范围');
      }
      result.set(value, received);
      received += value.byteLength;
    }
    if (received !== length) throw new Error('原始 RT 响应不完整');
    return result;
  }

  // Read a pixel from any verified RT sidecar without replacing the visible
  // texture. The frame viewer uses this for a bounded, observed timeline.
  async function readGameDraftRawPixel(next, x, y, signal) {
    const reader = makeRawReader(next);
    if (typeof reader.url !== 'string' || !reader.url ||
        !Number.isSafeInteger(x) || !Number.isSafeInteger(y) ||
        x < 0 || y < 0 || x >= reader.width || y >= reader.height) {
      throw new RangeError('原始 RT 像素坐标或来源无效');
    }
    const start = y * reader.stride + x * reader.bpp;
    const bytes = await fetchRawRange(reader, start, start + reader.bpp - 1, signal);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const values = decodeRawPixel(reader, view, 0, [0, 0, 0, 0]).slice(0, componentCount(reader.format));
    const raw8 = reader.format === 'stencil8' || reader.format.endsWith('8unorm') ||
      reader.format.endsWith('8unorm-srgb') ? [...bytes] : null;
    return { values, raw8, rawBytes: [...bytes], format: reader.format };
  }

  function createGameDraftSurfaceInspector(mount, onPixel) {
    if (!(mount instanceof HTMLElement)) throw new TypeError('surface inspector mount must be an HTMLElement');
    if (onPixel !== undefined && typeof onPixel !== 'function') throw new TypeError('onPixel must be a function');

    const previousStyle = {
      position: mount.style.position, overflow: mount.style.overflow,
      padding: mount.style.padding, display: mount.style.display,
    };
    mount.classList.add('gd-surface-mount');
    mount.style.position = 'relative';
    mount.style.overflow = 'hidden';
    mount.style.padding = '0';
    mount.style.display = 'block';

    const root = document.createElement('div');
    root.className = 'gd-surface-root';
    root.tabIndex = 0;
    root.setAttribute('role', 'img');
    root.setAttribute('aria-label', '纹理画布查看器');
    const canvas = document.createElement('canvas');
    canvas.className = 'gd-surface-canvas';
    const message = document.createElement('div');
    message.className = 'gd-surface-message';
    message.setAttribute('role', 'status');
    message.setAttribute('aria-live', 'polite');
    const hud = document.createElement('div');
    hud.className = 'gd-surface-hud';
    root.append(canvas, message, hud);
    mount.replaceChildren(root);
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) throw new Error('2D canvas is unavailable');

    const cache = new Map();
    let asset = null;
    let rawReader = null;
    let rawRenderAbort = null;
    let rawRenderToken = 0;
    let source = null;
    let channel = 'rgba';
    let exposureEV = 0;
    let zoomMode = 'fit';
    let scale = 1;
    let offsetX = 0;
    let offsetY = 0;
    let viewWidth = 0;
    let viewHeight = 0;
    let pixel = null;
    let error = null;
    let loading = false;
    let destroyed = false;
    let loadToken = 0;
    let raf = 0;
    let pointer = null;

    function trimPixelCache() {
      let bytes = 0;
      for (const entry of cache.values()) bytes += entry.asset?.rgba?.byteLength || 0;
      if (bytes <= MAX_CACHE_RAW_BYTES) return;
      for (const entry of cache.values()) {
        if (entry.asset === asset || !entry.asset?.rgba) continue;
        bytes -= entry.asset.rgba.byteLength;
        entry.asset.rgba = null;
        entry.asset.processed = null;
        if (bytes <= MAX_CACHE_RAW_BYTES) break;
      }
    }

    function state() {
      const zoomPercent = Math.round(scale * 1000) / 10;
      return {
        source: source ? { ...source } : null,
        loading, error, channel, exposureEV, zoomMode,
        zoom: zoomMode === 'fit' ? 'fit' : zoomPercent,
        zoomPercent,
        scale, offsetX, offsetY,
        imageWidth: asset?.width ?? 0, imageHeight: asset?.height ?? 0,
        pixelError: asset?.readError ?? null,
        pixel: pixel ? { ...pixel } : null,
        byteSource: asset?.raw ? 'native-raw-rt' : 'decoded-png-display',
        nativeRtBytes: !!asset?.raw,
      };
    }

    function displayMessage(text) {
      message.textContent = text || '';
      message.hidden = !text;
    }

    function updateHud() {
      if (!asset) { hud.textContent = ''; return; }
      const zoom = `${Math.round(scale * 100)}%`;
      const name = source?.label || '纹理';
      const values = pixel?.native?.values?.map(value => Number.isFinite(value) ?
        Number(value.toPrecision(6)) : String(value));
      const position = pixel ? ` · (${pixel.x}, ${pixel.y}) ${values ?
        `RT ${values.join(', ')}` : pixel.rgba8 ? pixel.rgba8.join(', ') : pixel.reason || '读取中'}` : '';
      hud.textContent = `${name} · ${asset.width}×${asset.height} · ${zoom}${position}`;
    }

    function fit() {
      zoomMode = 'fit';
      if (!asset || !viewWidth || !viewHeight) return;
      scale = Math.min(viewWidth / asset.width, viewHeight / asset.height);
      offsetX = (viewWidth - asset.width * scale) / 2;
      offsetY = (viewHeight - asset.height * scale) / 2;
      updateHud();
      schedule();
    }

    function constrainPan() {
      if (!asset) return;
      const margin = Math.min(36, Math.max(8, Math.min(viewWidth, viewHeight) * 0.06));
      const drawnWidth = asset.width * scale;
      const drawnHeight = asset.height * scale;
      offsetX = clamp(offsetX, margin - drawnWidth, viewWidth - margin);
      offsetY = clamp(offsetY, margin - drawnHeight, viewHeight - margin);
    }

    function zoomAt(newScale, anchorX, anchorY, mode) {
      if (!Number.isFinite(newScale) || newScale <= 0) return;
      if (!asset) { zoomMode = mode; scale = newScale; return; }
      const oldScale = scale;
      const imageX = (anchorX - offsetX) / oldScale;
      const imageY = (anchorY - offsetY) / oldScale;
      scale = clamp(newScale, MIN_SCALE, MAX_SCALE);
      offsetX = anchorX - imageX * scale;
      offsetY = anchorY - imageY * scale;
      zoomMode = mode;
      constrainPan();
      updateHud();
      schedule();
    }

    function readPixels(item) {
      if (item.rgba || item.readError) return item.rgba;
      if (item.width * item.height * 4 > MAX_SAMPLE_BYTES) {
        item.readError = '图像太大，无法安全读取像素';
        return null;
      }
      try {
        const rawCanvas = document.createElement('canvas');
        rawCanvas.width = item.width;
        rawCanvas.height = item.height;
        const rawCtx = rawCanvas.getContext('2d', { willReadFrequently: true });
        if (!rawCtx) throw new Error('2D pixel readback unavailable');
        rawCtx.drawImage(item.image, 0, 0);
        item.rgba = rawCtx.getImageData(0, 0, item.width, item.height).data;
        trimPixelCache();
        return item.rgba;
      } catch (cause) {
        item.readError = `PNG 像素无法读取：${cause?.message || String(cause)}`;
        return null;
      }
    }

    function transformPixel(rgba, index) {
      const factor = 2 ** exposureEV;
      const r = rgba[index];
      const g = rgba[index + 1];
      const b = rgba[index + 2];
      const a = rgba[index + 3];
      if (channel === 'rgba') return [byte(r * factor), byte(g * factor), byte(b * factor), a];
      const component = channel === 'red' ? r : channel === 'green' ? g : channel === 'blue' ? b : a;
      const value = byte(component * factor);
      return [value, value, value, 255];
    }

    function displayImage(item) {
      if (FLOAT_RT_FORMATS.has(source?.rawFormat || source?.format) && !rawReader) {
        displayMessage('原始 float RT 不可用；PNG 只供固定色调映射预览，曝光调整不可用。');
        return item.image;
      }
      if (channel === 'rgba' && exposureEV === 0) return item.image;
      const key = `${channel}:${exposureEV}`;
      if (item.processed?.key === key) return item.processed.canvas;
      const rgba = readPixels(item);
      if (!rgba) {
        displayMessage(`${item.readError}。通道与曝光保持原图显示。`);
        return item.image;
      }
      const processed = document.createElement('canvas');
      processed.width = item.width;
      processed.height = item.height;
      const processCtx = processed.getContext('2d');
      if (!processCtx) return item.image;
      const imageData = processCtx.createImageData(item.width, item.height);
      const dest = imageData.data;
      for (let index = 0; index < rgba.length; index += 4) {
        const color = transformPixel(rgba, index);
        dest[index] = color[0];
        dest[index + 1] = color[1];
        dest[index + 2] = color[2];
        dest[index + 3] = color[3];
      }
      processCtx.putImageData(imageData, 0, 0);
      item.processed = { key, canvas: processed };
      return processed;
    }

    function drawPixelGrid() {
      if (!asset || scale < 4) return;
      const left = Math.max(0, Math.floor(-offsetX / scale));
      const right = Math.min(asset.width, Math.ceil((viewWidth - offsetX) / scale));
      const top = Math.max(0, Math.floor(-offsetY / scale));
      const bottom = Math.min(asset.height, Math.ceil((viewHeight - offsetY) / scale));
      if (right - left > 3000 || bottom - top > 3000) return;
      ctx.save();
      ctx.beginPath();
      ctx.rect(offsetX, offsetY, asset.width * scale, asset.height * scale);
      ctx.clip();
      ctx.beginPath();
      for (let x = left; x <= right; x++) {
        const line = Math.round(offsetX + x * scale) + 0.5;
        ctx.moveTo(line, 0);
        ctx.lineTo(line, viewHeight);
      }
      for (let y = top; y <= bottom; y++) {
        const line = Math.round(offsetY + y * scale) + 0.5;
        ctx.moveTo(0, line);
        ctx.lineTo(viewWidth, line);
      }
      ctx.strokeStyle = 'rgba(255,255,255,.24)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }

    function cachedRawRow(reader, y, minX, maxX) {
      const row = reader.rows.get(y);
      if (!row || row.minX > minX || row.maxX < maxX) return null;
      reader.rows.delete(y);
      reader.rows.set(y, row);
      return row;
    }

    function rememberRawRow(reader, y, minX, maxX, bytes) {
      if (bytes.byteLength > MAX_RAW_CACHE_BYTES) return;
      const previous = reader.rows.get(y);
      if (previous) reader.cachedBytes -= previous.bytes.byteLength;
      reader.rows.delete(y);
      reader.rows.set(y, { minX, maxX, bytes });
      reader.cachedBytes += bytes.byteLength;
      while (reader.cachedBytes > MAX_RAW_CACHE_BYTES) {
        const oldest = reader.rows.keys().next().value;
        reader.cachedBytes -= reader.rows.get(oldest).bytes.byteLength;
        reader.rows.delete(oldest);
      }
    }

    function paintNative(reader, values, dest, index, factor) {
      if (reader.format === 'stencil8' && source?.aspect === 'stencil') {
        // A value of 1 is the common mask marker, but literal 1/255 looks black.
        // This transform affects the viewport only; pixel inspection retains u8.
        const shade = channel === 'alpha' ? 255 : values[0] > 0 ? 255 : 0;
        dest[index] = dest[index + 1] = dest[index + 2] = shade;
        dest[index + 3] = 255;
        return;
      }
      const floatRt = FLOAT_RT_FORMATS.has(reader.format);
      const unsigned = UINT_RT_FORMATS.has(reader.format) || STENCIL_RT_FORMATS.has(reader.format);
      const colorByte = value => unsigned ? byte(value * factor) :
        source?.aspect === 'depth' ? byte(value * factor * 255) :
          exposedColorByte(value, factor, floatRt);
      if (channel === 'rgba') {
        dest[index] = colorByte(values[0]);
        dest[index + 1] = colorByte(values[1]);
        dest[index + 2] = colorByte(values[2]);
        dest[index + 3] = unsigned && componentCount(reader.format) === 4 ?
          byte(values[3]) : byte(values[3] * 255);
      } else {
        const component = channel === 'red' ? 0 : channel === 'green' ? 1 : channel === 'blue' ? 2 : 3;
        const shade = component === 3 ? unsigned ? byte(values[3] * factor) : byte(values[3] * 255 * factor) :
          colorByte(values[component]);
        dest[index] = dest[index + 1] = dest[index + 2] = shade;
        dest[index + 3] = 255;
      }
    }

    async function renderRawViewport(reader, width, height, signal) {
      const imageData = ctx.createImageData(width, height);
      const sourceXs = new Int32Array(width);
      let minX = reader.width;
      let maxX = -1;
      for (let x = 0; x < width; x++) {
        const sourceX = Math.floor((((x + 0.5) / width) * viewWidth - offsetX) / scale);
        sourceXs[x] = sourceX >= 0 && sourceX < reader.width ? sourceX : -1;
        if (sourceXs[x] >= 0) {
          minX = Math.min(minX, sourceX);
          maxX = Math.max(maxX, sourceX);
        }
      }
      if (maxX < minX) return imageData;

      const rows = new Map();
      for (let y = 0; y < height; y++) {
        const sourceY = Math.floor((((y + 0.5) / height) * viewHeight - offsetY) / scale);
        if (sourceY < 0 || sourceY >= reader.height) continue;
        if (!rows.has(sourceY)) rows.set(sourceY, []);
        rows.get(sourceY).push(y);
      }
      const sourceRows = [...rows.keys()].sort((a, b) => a - b);
      const rowBytes = (maxX - minX + 1) * reader.bpp;
      if (rowBytes > MAX_RAW_RANGE_BYTES) throw new Error('单行可见 RT 字节超过 8 MiB 范围读取上限');
      const runs = [];
      for (const y of sourceRows) {
        const last = runs[runs.length - 1];
        if (last && y === last.endY + 1 && (y - last.startY) * reader.stride + rowBytes <= MAX_RAW_RANGE_BYTES) {
          last.endY = y;
        } else runs.push({ startY: y, endY: y });
      }

      const values = [0, 0, 0, 0];
      const factor = 2 ** exposureEV;
      let runIndex = 0;
      const workers = Array.from({ length: Math.min(8, runs.length) }, async () => {
        while (runIndex < runs.length) {
          const run = runs[runIndex++];
          if (signal.aborted) return;
          let rawRows = [];
          for (let y = run.startY; y <= run.endY; y++) {
            rawRows.push(cachedRawRow(reader, y, minX, maxX));
          }
          if (rawRows.some(row => !row)) {
            const start = run.startY * reader.stride + minX * reader.bpp;
            const end = run.endY * reader.stride + (maxX + 1) * reader.bpp - 1;
            const bytes = await fetchRawRange(reader, start, end, signal);
            if (signal.aborted) return;
            rawRows = [];
            for (let y = run.startY; y <= run.endY; y++) {
              const byteOffset = (y - run.startY) * reader.stride;
              const rowBytesCopy = bytes.slice(byteOffset, byteOffset + rowBytes);
              const row = { minX, maxX, bytes: rowBytesCopy };
              rememberRawRow(reader, y, minX, maxX, rowBytesCopy);
              rawRows.push(row);
            }
          }
          for (let y = run.startY; y <= run.endY; y++) {
            const row = rawRows[y - run.startY];
            const view = new DataView(row.bytes.buffer, row.bytes.byteOffset, row.bytes.byteLength);
            const painted = new Uint8ClampedArray(width * 4);
            for (let x = 0; x < width; x++) {
              if (sourceXs[x] < 0) continue;
              decodeRawPixel(reader, view, (sourceXs[x] - row.minX) * reader.bpp, values);
              paintNative(reader, values, painted, x * 4, factor);
            }
            for (const destY of rows.get(y)) imageData.data.set(painted, destY * width * 4);
          }
        }
      });
      await Promise.all(workers);
      return imageData;
    }

    function renderRaw(reader, dpr) {
      rawRenderAbort?.abort();
      const controller = new AbortController();
      rawRenderAbort = controller;
      const token = ++rawRenderToken;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      loading = true;
      displayMessage('正在读取原始 RT 的可见区域…');
      renderRawViewport(reader, canvas.width, canvas.height, controller.signal).then(imageData => {
        if (destroyed || token !== rawRenderToken || controller.signal.aborted) return;
        ctx.putImageData(imageData, 0, 0);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawPixelGrid();
        loading = false;
        error = null;
        displayMessage('');
      }, cause => {
        if (destroyed || token !== rawRenderToken || controller.signal.aborted) return;
        loading = false;
        error = cause?.message || String(cause);
        ctx.clearRect(0, 0, viewWidth, viewHeight);
        displayMessage(error);
      });
    }

    function render() {
      raf = 0;
      if (destroyed) return;
      const dpr = Math.min(Math.max(1, window.devicePixelRatio || 1),
        Math.sqrt(MAX_VIEWPORT_PIXELS / Math.max(1, viewWidth * viewHeight)));
      const pixelWidth = Math.max(1, Math.round(viewWidth * dpr));
      const pixelHeight = Math.max(1, Math.round(viewHeight * dpr));
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (asset?.raw) { renderRaw(rawReader, dpr); return; }
      ctx.clearRect(0, 0, viewWidth, viewHeight);
      if (!asset) return;
      const image = displayImage(asset);
      ctx.imageSmoothingEnabled = scale < 1;
      ctx.drawImage(image, offsetX, offsetY, asset.width * scale, asset.height * scale);
      drawPixelGrid();
    }

    function schedule() {
      if (!destroyed && !raf) raf = requestAnimationFrame(render);
    }

    function measure() {
      if (destroyed) return;
      const oldWidth = viewWidth;
      const oldHeight = viewHeight;
      const centerX = asset ? (oldWidth ? (oldWidth / 2 - offsetX) / scale : asset.width / 2) : 0;
      const centerY = asset ? (oldHeight ? (oldHeight / 2 - offsetY) / scale : asset.height / 2) : 0;
      viewWidth = root.clientWidth;
      viewHeight = root.clientHeight;
      if (asset && viewWidth && viewHeight) {
        if (zoomMode === 'fit') fit();
        else {
          offsetX = viewWidth / 2 - centerX * scale;
          offsetY = viewHeight / 2 - centerY * scale;
          constrainPan();
        }
      }
      schedule();
    }

    function loadImage(url) {
      if (cache.has(url)) {
        const entry = cache.get(url);
        cache.delete(url);
        cache.set(url, entry);
        return entry.promise;
      }
      const entry = { promise: null, asset: null };
      entry.promise = new Promise((resolve, reject) => {
        const image = new Image();
        image.decoding = 'async';
        image.onload = () => {
          const item = { image, width: image.naturalWidth, height: image.naturalHeight,
            rgba: null, readError: null, processed: null };
          if (!item.width || !item.height) reject(new Error('PNG 图像尺寸无效'));
          else { entry.asset = item; resolve(item); }
        };
        image.onerror = () => reject(new Error('PNG 图像加载失败'));
        image.src = url;
      });
      cache.set(url, entry);
      while (cache.size > MAX_CACHE_ITEMS) cache.delete(cache.keys().next().value);
      return entry.promise;
    }

    async function setSource(next) {
      if (destroyed) return state();
      const token = ++loadToken;
      rawRenderAbort?.abort();
      rawRenderToken++;
      rawReader = null;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const imageUrl = typeof next?.url === 'string' && next.url ? next.url : null;
      const rawUrl = typeof next?.rawUrl === 'string' && next.rawUrl ? next.rawUrl : null;
      if (!imageUrl && !rawUrl) {
        source = null;
        asset = null;
        pixel = null;
        loading = false;
        error = null;
        displayMessage('没有可查看的图像');
        updateHud();
        schedule();
        return state();
      }
      source = {
        url: imageUrl,
        rawUrl,
        label: typeof next.label === 'string' ? next.label : '',
        format: typeof next.format === 'string' ? next.format : null,
        rawFormat: typeof next.rawFormat === 'string' ? next.rawFormat : null,
        aspect: next.aspect === 'depth' || next.aspect === 'stencil' ? next.aspect : null,
        rawBytesPerRow: next.rawBytesPerRow,
        rawByteLength: next.rawByteLength,
        source: typeof next.source === 'string' ? next.source : null,
        declaredWidth: finite(next.width) ? next.width : null,
        declaredHeight: finite(next.height) ? next.height : null,
      };
      let rawError = null;
      if (rawUrl) {
        try { rawReader = makeRawReader(next); }
        catch (cause) { rawError = cause?.message || String(cause); }
      }
      asset = null;
      pixel = null;
      loading = true;
      error = null;
      displayMessage(imageUrl ? '正在加载图像…' : '正在准备原始 RT…');
      updateHud();
      schedule();
      if (!imageUrl || (rawReader && (FLOAT_RT_FORMATS.has(rawReader.format) ||
          UINT_RT_FORMATS.has(rawReader.format) || STENCIL_RT_FORMATS.has(rawReader.format)))) {
        if (!rawReader) {
          loading = false;
          error = rawError || '没有可查看的原始 RT';
          displayMessage(error);
          return state();
        }
        asset = { raw: true, width: rawReader.width, height: rawReader.height };
        if (imageUrl) displayMessage('正在从原始纹理字节绘制预览…');
        fit();
        return state();
      }
      try {
        const loaded = await loadImage(imageUrl);
        if (destroyed || token !== loadToken) return state();
        asset = loaded;
        loading = false;
        displayMessage('');
        fit();
        return state();
      } catch (cause) {
        if (destroyed || token !== loadToken) return state();
        loading = false;
        error = cause?.message || String(cause);
        cache.delete(imageUrl);
        if (rawReader) {
          asset = { raw: true, width: rawReader.width, height: rawReader.height };
          error = null;
          loading = true;
          displayMessage('PNG 无法读取，正在显示原始 RT…');
          fit();
          return state();
        }
        displayMessage(error);
        schedule();
        return state();
      }
    }

    async function readNativePixel(x, y) {
      const reader = rawReader;
      if (!reader || !Number.isInteger(x) || !Number.isInteger(y) ||
          x < 0 || y < 0 || x >= reader.width || y >= reader.height) return null;
      const cached = cachedRawRow(reader, y, x, x);
      const bytes = cached?.bytes || await fetchRawRange(reader,
        y * reader.stride + x * reader.bpp,
        y * reader.stride + (x + 1) * reader.bpp - 1);
      const offset = cached ? (x - cached.minX) * reader.bpp : 0;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const values = decodeRawPixel(reader, view, offset, [0, 0, 0, 0]).slice(0, componentCount(reader.format));
      const raw8 = reader.format === 'stencil8' || reader.format.endsWith('8unorm') || reader.format.endsWith('8unorm-srgb') ?
        [...bytes.subarray(offset, offset + reader.bpp)] : null;
      return { values, raw8, format: reader.format };
    }

    function setChannel(value) {
      if (!CHANNELS.has(value)) throw new RangeError('channel must be rgba, red, green, blue, or alpha');
      channel = value;
      pixel = null;
      if (asset) asset.processed = null;
      updateHud();
      if (channel === 'rgba' && exposureEV === 0 && !error) displayMessage('');
      schedule();
      return state();
    }

    function setExposure(value) {
      const number = Number(value);
      if (!Number.isFinite(number)) throw new RangeError('exposure must be a finite EV value');
      exposureEV = clamp(number, -16, 16);
      pixel = null;
      if (asset) asset.processed = null;
      updateHud();
      if (channel === 'rgba' && exposureEV === 0 && !error) displayMessage('');
      schedule();
      return state();
    }

    function setZoom(value) {
      if (value === 'fit') { fit(); return state(); }
      const percent = Number(value);
      if (!Number.isFinite(percent) || percent <= 0) throw new RangeError('zoom must be fit or a positive percent');
      zoomAt(percent / 100, viewWidth / 2, viewHeight / 2, percent);
      return state();
    }

    function reset() {
      channel = 'rgba';
      exposureEV = 0;
      pixel = null;
      if (asset) asset.processed = null;
      if (asset && !error) displayMessage('');
      fit();
      schedule();
      return state();
    }

    function localPoint(event) {
      const rect = root.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    }

    function pick(point) {
      if (!asset) return;
      const x = Math.floor((point.x - offsetX) / scale);
      const y = Math.floor((point.y - offsetY) / scale);
      if (x < 0 || y < 0 || x >= asset.width || y >= asset.height) return;
      if (asset.raw) {
        const token = loadToken;
        pixel = { x, y, rgba8: null, displayRgba8: null, available: false,
          reason: '正在读取原始 RT 像素', byteSource: 'native-raw-rt', nativeRtBytes: true,
          format: rawReader?.format || null, source: source?.source ?? null,
          label: source?.label ?? '', url: source?.rawUrl ?? null,
          width: asset.width, height: asset.height, channel, exposureEV };
        updateHud();
        readNativePixel(x, y).then(native => {
          if (destroyed || token !== loadToken || pixel?.x !== x || pixel?.y !== y) return;
          pixel.native = native;
          pixel.available = !!native;
          pixel.reason = native ? null : '原始 RT 格式不可读';
          updateHud();
          if (onPixel) onPixel({ ...pixel });
        }, cause => {
          if (destroyed || token !== loadToken || pixel?.x !== x || pixel?.y !== y) return;
          pixel.reason = `原始 RT 像素读取失败：${cause?.message || String(cause)}`;
          updateHud();
          if (onPixel) onPixel({ ...pixel });
        });
        return;
      }
      const rgba = readPixels(asset);
      const index = (y * asset.width + x) * 4;
      const original = rgba ? Array.from(rgba.subarray(index, index + 4)) : null;
      pixel = {
        x, y, rgba8: original,
        displayRgba8: rgba ? transformPixel(rgba, index) : null,
        available: !!rgba,
        reason: rgba ? null : asset.readError,
        byteSource: 'decoded-png-display', nativeRtBytes: false,
        format: source?.format ?? null, source: source?.source ?? null,
        label: source?.label ?? '', url: source?.url ?? null,
        width: asset.width, height: asset.height,
        channel, exposureEV,
      };
      updateHud();
      if (onPixel) onPixel({ ...pixel });
    }

    function onPointerDown(event) {
      if ((event.button !== 0 && event.button !== 1) || !asset) return;
      event.preventDefault();
      root.focus({ preventScroll: true });
      const point = localPoint(event);
      pointer = { id: event.pointerId, startX: point.x, startY: point.y,
        initialX: offsetX, initialY: offsetY, moved: false };
      root.setPointerCapture(event.pointerId);
      root.classList.add('gd-surface-dragging');
    }

    function onPointerMove(event) {
      if (!pointer || event.pointerId !== pointer.id) return;
      const point = localPoint(event);
      const deltaX = point.x - pointer.startX;
      const deltaY = point.y - pointer.startY;
      if (Math.hypot(deltaX, deltaY) >= 3) pointer.moved = true;
      if (!pointer.moved) return;
      offsetX = pointer.initialX + deltaX;
      offsetY = pointer.initialY + deltaY;
      constrainPan();
      schedule();
    }

    function onPointerUp(event) {
      if (!pointer || event.pointerId !== pointer.id) return;
      const wasClick = !pointer.moved && event.button === 0;
      pointer = null;
      root.classList.remove('gd-surface-dragging');
      if (root.hasPointerCapture(event.pointerId)) root.releasePointerCapture(event.pointerId);
      if (wasClick) pick(localPoint(event));
    }

    function onPointerCancel(event) {
      if (!pointer || event.pointerId !== pointer.id) return;
      pointer = null;
      root.classList.remove('gd-surface-dragging');
    }

    function onWheel(event) {
      if (!asset) return;
      event.preventDefault();
      const factor = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 :
        event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? viewHeight : 1;
      if (event.ctrlKey) {
        const point = localPoint(event);
        const nextScale = scale * Math.exp(-event.deltaY * factor * 0.002);
        zoomAt(nextScale, point.x, point.y, 'custom');
      } else {
        offsetX -= event.deltaX * factor;
        offsetY -= event.deltaY * factor;
        constrainPan();
        schedule();
      }
    }

    function onKeyDown(event) {
      if (event.key === 'Home' || event.key.toLowerCase() === 'f') {
        event.preventDefault();
        fit();
      }
    }

    root.addEventListener('pointerdown', onPointerDown);
    root.addEventListener('pointermove', onPointerMove);
    root.addEventListener('pointerup', onPointerUp);
    root.addEventListener('pointercancel', onPointerCancel);
    root.addEventListener('wheel', onWheel, { passive: false });
    root.addEventListener('keydown', onKeyDown);
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (observer) observer.observe(root);
    else window.addEventListener('resize', measure);
    measure();
    displayMessage('没有可查看的图像');

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      loadToken++;
      rawRenderAbort?.abort();
      rawReader?.rows.clear();
      if (raf) cancelAnimationFrame(raf);
      if (observer) observer.disconnect();
      else window.removeEventListener('resize', measure);
      root.removeEventListener('pointerdown', onPointerDown);
      root.removeEventListener('pointermove', onPointerMove);
      root.removeEventListener('pointerup', onPointerUp);
      root.removeEventListener('pointercancel', onPointerCancel);
      root.removeEventListener('wheel', onWheel);
      root.removeEventListener('keydown', onKeyDown);
      cache.clear();
      if (root.parentNode === mount) {
        mount.replaceChildren();
        mount.classList.remove('gd-surface-mount');
        mount.style.position = previousStyle.position;
        mount.style.overflow = previousStyle.overflow;
        mount.style.padding = previousStyle.padding;
        mount.style.display = previousStyle.display;
      }
    }

    return { setSource, setChannel, setExposure, setZoom, reset, readNativePixel,
      getState: state, destroy };
  }

  window.createGameDraftSurfaceInspector = createGameDraftSurfaceInspector;
  window.readGameDraftRawPixel = readGameDraftRawPixel;
})();
