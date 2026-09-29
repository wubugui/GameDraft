// Reusable, plain-browser PNG surface inspector for the frame viewer.
// Pixel values are decoded PNG display RGBA bytes, never native GPU RT bytes.
(function () {
  'use strict';

  const CHANNELS = new Set(['rgba', 'red', 'green', 'blue', 'alpha']);
  const MAX_CACHE_ITEMS = 8;
  const MAX_CACHE_RAW_BYTES = 96 * 1024 * 1024;
  const MAX_SAMPLE_BYTES = 64 * 1024 * 1024;
  const MIN_SCALE = 0.001;
  const MAX_SCALE = 4096;

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const byte = value => clamp(Math.round(value), 0, 255);

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
        byteSource: 'decoded-png-display', nativeRtBytes: false,
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
      const position = pixel ? ` · (${pixel.x}, ${pixel.y}) ${pixel.rgba8 ? pixel.rgba8.join(', ') : '像素不可读'}` : '';
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

    function render() {
      raf = 0;
      if (destroyed) return;
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const pixelWidth = Math.max(1, Math.round(viewWidth * dpr));
      const pixelHeight = Math.max(1, Math.round(viewHeight * dpr));
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
      if (!next || typeof next.url !== 'string' || !next.url) {
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
        url: next.url,
        label: typeof next.label === 'string' ? next.label : '',
        format: typeof next.format === 'string' ? next.format : null,
        source: typeof next.source === 'string' ? next.source : null,
        declaredWidth: finite(next.width) ? next.width : null,
        declaredHeight: finite(next.height) ? next.height : null,
      };
      asset = null;
      pixel = null;
      loading = true;
      error = null;
      displayMessage('正在加载图像…');
      updateHud();
      schedule();
      try {
        const loaded = await loadImage(next.url);
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
        cache.delete(next.url);
        displayMessage(error);
        schedule();
        return state();
      }
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

    return { setSource, setChannel, setExposure, setZoom, reset, getState: state, destroy };
  }

  window.createGameDraftSurfaceInspector = createGameDraftSurfaceInspector;
})();
