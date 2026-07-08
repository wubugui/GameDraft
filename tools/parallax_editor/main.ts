import { Application, Container, Sprite, Texture, Assets, Graphics } from 'pixi.js';

// ---------- 类型（与 src/data/types.ts 的 Parallax* 一致） ----------
interface Keyframe { atMs: number; x: number; y: number; scale?: number; rotation?: number; alpha?: number }
interface Layer {
  id: string; image: string; zIndex?: number; keyframes: Keyframe[]; easing?: string; loop?: boolean;
  depth?: number;                 // 推摄像机：该层视差强度（缺省按 zIndex 自动）
  sourceKeyframes?: Keyframe[];    // 编辑器专用：相机模式下图层「自身运动」原始帧（供再编辑；运行时忽略）
  sourceEasing?: string;          // 编辑器专用：自身运动缓动
}
interface CamKey { atMs: number; panX: number; panY: number; zoom: number; roll: number }
interface Camera { enabled: boolean; keyframes: CamKey[] }   // 编辑器专用；运行时忽略
interface Scene { id: string; widthRef: number; heightRef: number; layers: Layer[]; camera?: Camera }

// ---------- 状态 ----------
// 单一真相源 = `scene`。layer.keyframes 始终是图层「自身运动」（场景坐标）。
// 推摄像机 = 叠加在自身运动之上的虚拟镜头（相当于把各层放进摄像机坐标）；
// 保存时按每层 depth 把「相机 × 自身运动」烘焙成 layer.keyframes（运行时只播这个），
// 自身运动原样存到 sourceKeyframes 供再编辑。
let scenes: Scene[] = [];
let scene: Scene = { id: 'new_scene', widthRef: 1672, heightRef: 941, layers: [] };
let loadedId = '';
let dirty = false;
let selLayer = -1;
let selKf = -1;
let selCamKf = -1;
let currentMs = 0;
let maxMs = 14000;
let playing = false;
let lastT = 0;
// 电影黑边预览：纯编辑器本地状态(localStorage),不进 parallax_scenes.json。上下各占 heightRef 的 mbPct。
let mbOn = false;
let mbPct = 0.1;

const $ = (id: string) => document.getElementById(id)!;
const texCache = new Map<string, Texture>();
const spriteMap = new Map<string, Sprite>();
const alphaMaps = new Map<string, { w: number; h: number; data: Uint8ClampedArray } | null>();

// ---------- Pixi ----------
const app = new Application();
const stage = new Container();
const overlay = new Graphics();
let images: { url: string; name: string }[] = [];

async function boot() {
  await app.init({ background: '#0e0f12', antialias: true, resizeTo: $('stage-wrap') as HTMLElement });
  ($('pixi') as HTMLElement).appendChild(app.canvas);
  app.stage.addChild(stage);
  stage.sortableChildren = true;
  overlay.zIndex = 1e6;
  stage.addChild(overlay);

  images = await fetch('/api/parallax/images').then(r => r.json()).then(d => d.images || []).catch(() => []);
  scenes = await fetch('/api/parallax/scenes').then(r => r.json()).then(d => d.scenes || []).catch(() => []);
  fillImageOptions();
  fillSceneSelect();
  const wantScene = new URLSearchParams(location.search).get('scene');
  if (scenes.length) {
    const wantIdx = wantScene ? scenes.findIndex(s => s.id === wantScene) : -1;
    const idx = wantIdx >= 0 ? wantIdx : 0;
    loadScene(scenes[idx]);
    ($('scene-select') as HTMLSelectElement).value = String(idx);
  } else rebuildAll();

  loadMovieBarPref();
  app.ticker.add(renderFrame);
  bindUI();
  bindCanvasDrag();
  updateSaveBtn();
  window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
}

// ---------- 脏标记 / 保存态 ----------
function markDirty() { if (!dirty) { dirty = true; updateSaveBtn(); } }
function updateSaveBtn() {
  const b = $('btn-save');
  b.textContent = dirty ? '● 保存到 parallax_scenes.json（有未存改动）' : '保存到 parallax_scenes.json';
  b.classList.toggle('dirty', dirty);
}
function confirmDiscardIfDirty(): boolean {
  if (!dirty) return true;
  return window.confirm('当前场景有未保存的改动，切换会丢弃这些改动。\n确定要放弃并继续吗？（取消则留在当前场景，可先点保存）');
}

// ---------- 关键帧插值（镜像运行时 sampleParallaxKeyframe） ----------
function sample(kf: Keyframe[], nowMs: number, loop: boolean, easing: string) {
  const norm = (k: Keyframe) => ({ x: k.x, y: k.y, scale: k.scale ?? 1, rotation: k.rotation ?? 0, alpha: k.alpha ?? 1 });
  if (kf.length === 0) return { x: 0, y: 0, scale: 1, rotation: 0, alpha: 1 };
  if (kf.length === 1) return norm(kf[0]);
  const last = kf[kf.length - 1]; const total = last.atMs;
  let t = nowMs; if (loop && total > 0) t = ((t % total) + total) % total;
  if (t <= kf[0].atMs) return norm(kf[0]);
  if (t >= last.atMs) return norm(last);
  let i = 0; while (i < kf.length - 1 && kf[i + 1].atMs <= t) i++;
  const a = kf[i], b = kf[i + 1]; const span = Math.max(1, b.atMs - a.atMs);
  let u = (t - a.atMs) / span;
  u = easing === 'easeIn' ? u * u : easing === 'easeOut' ? 1 - (1 - u) * (1 - u)
    : easing === 'easeInOut' ? (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2) : u;
  const A = norm(a), B = norm(b);
  return { x: A.x + (B.x - A.x) * u, y: A.y + (B.y - A.y) * u, scale: A.scale + (B.scale - A.scale) * u,
    rotation: A.rotation + (B.rotation - A.rotation) * u, alpha: A.alpha + (B.alpha - A.alpha) * u };
}

// ---------- 推摄像机 ----------
function ensureCamera(): Camera { if (!scene.camera) scene.camera = { enabled: false, keyframes: [] }; return scene.camera; }
function camActive(): boolean { return !!(scene.camera && scene.camera.enabled); }
function depthOf(l: Layer): number {
  if (l.depth != null) return l.depth;
  return Math.max(0.12, Math.min(1.2, 0.12 + (l.zIndex ?? 0) / 34));
}
function sampleCamera(nowMs: number): { panX: number; panY: number; zoom: number; roll: number } {
  const kf = (scene.camera?.keyframes ?? []).slice().sort((a, b) => a.atMs - b.atMs);
  if (kf.length === 0) return { panX: 0, panY: 0, zoom: 1, roll: 0 };
  if (kf.length === 1) return { panX: kf[0].panX, panY: kf[0].panY, zoom: kf[0].zoom, roll: kf[0].roll };
  const last = kf[kf.length - 1];
  const t = nowMs;
  if (t <= kf[0].atMs) return { ...kf[0] };
  if (t >= last.atMs) return { panX: last.panX, panY: last.panY, zoom: last.zoom, roll: last.roll };
  let i = 0; while (i < kf.length - 1 && kf[i + 1].atMs <= t) i++;
  const a = kf[i], b = kf[i + 1]; const span = Math.max(1, b.atMs - a.atMs);
  let u = (t - a.atMs) / span; u = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2; // 镜头缓推缓移
  return {
    panX: a.panX + (b.panX - a.panX) * u, panY: a.panY + (b.panY - a.panY) * u,
    zoom: a.zoom + (b.zoom - a.zoom) * u, roll: a.roll + (b.roll - a.roll) * u,
  };
}
/** 把镜头「叠加」到某层的自身变换 own 之上（相当于把该层放进摄像机坐标）。
 *  近层(depth 大)受镜头影响更多：zoom 绕画布中心缩放、pan 视差位移、roll 整机绕中心旋转。 */
function composeCam(l: Layer, cam: { panX: number; panY: number; zoom: number; roll: number },
                    own: { x: number; y: number; scale: number; rotation: number; alpha: number }) {
  const d = depthOf(l);
  const cx = scene.widthRef / 2, cy = scene.heightRef / 2;
  const ez = 1 + (cam.zoom - 1) * d;
  let rx = (own.x - cx) * ez, ry = (own.y - cy) * ez;   // 自身位置相对中心，随镜头 zoom 缩放
  const rad = cam.roll * Math.PI / 180, cs = Math.cos(rad), sn = Math.sin(rad);
  const rx2 = rx * cs - ry * sn, ry2 = rx * sn + ry * cs; // 绕中心 roll
  return {
    x: cx + rx2 + cam.panX * d,
    y: cy + ry2 + cam.panY * d,
    scale: own.scale * ez,          // 自身缩放 × 镜头缩放（叠加）
    rotation: own.rotation + cam.roll,
    alpha: own.alpha,
  };
}
/** 烘焙用的采样时间点：所有自身/相机关键帧断点 + 每段细分到 ≤700ms（相机含缓动，线性回放需足够密度）。 */
function bakeTimes(): number[] {
  const bp = new Set<number>([0]);
  for (const l of scene.layers) for (const k of l.keyframes) bp.add(Math.round(k.atMs));
  for (const k of (scene.camera?.keyframes ?? [])) bp.add(Math.round(k.atMs));
  const sorted = [...bp].filter(t => t >= 0).sort((a, b) => a - b);
  const out: number[] = [];
  for (let i = 0; i < sorted.length; i++) {
    out.push(sorted[i]);
    if (i < sorted.length - 1) {
      const gap = sorted[i + 1] - sorted[i];
      const steps = Math.floor(gap / 700);
      for (let j = 1; j <= steps; j++) { const t = sorted[i] + Math.round(gap * j / (steps + 1)); if (t > sorted[i] && t < sorted[i + 1]) out.push(t); }
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}
/** 把「相机 × 该层自身运动」在采样点上烘焙成一串（线性回放的）关键帧。 */
function bakedKeyframesFor(l: Layer, times: number[]): Keyframe[] {
  return times.map(t => {
    const own = sample(l.keyframes, t, !!l.loop, l.easing || 'linear');
    const s = composeCam(l, sampleCamera(t), own);
    return { atMs: t, x: s.x, y: s.y, scale: s.scale, rotation: s.rotation, alpha: s.alpha };
  });
}

// ---------- 渲染 ----------
function currentDisp() {
  const vw = app.renderer.width, vh = app.renderer.height;
  return Math.min(vw / scene.widthRef, vh / scene.heightRef);
}
function renderFrame() {
  const vw = app.renderer.width, vh = app.renderer.height;
  const disp = currentDisp();
  stage.scale.set(disp);
  stage.position.set((vw - scene.widthRef * disp) / 2, (vh - scene.heightRef * disp) / 2);

  const cam = camActive() ? sampleCamera(currentMs) : null;
  for (const layer of scene.layers) {
    const sp = spriteMap.get(layer.id);
    if (!sp) continue;
    const own = sample(layer.keyframes, currentMs, !!layer.loop, layer.easing || 'linear'); // 图层自身运动
    const s = cam ? composeCam(layer, cam, own) : own;                                       // 叠加镜头
    sp.x = s.x; sp.y = s.y; sp.scale.set(s.scale); sp.rotation = (s.rotation * Math.PI) / 180;
    sp.alpha = Math.max(0, Math.min(1, s.alpha));
    sp.zIndex = layer.zIndex ?? 0;
  }
  drawOverlay();
  drawMovieBar();
  if (playing) {
    const now = performance.now(); const dt = lastT ? now - lastT : 16; lastT = now;
    currentMs += dt; if (currentMs > maxMs) currentMs = 0;
    ($('tl-scrub') as HTMLInputElement).value = String(Math.round(currentMs));
    updateTimeLabel();
  }
  ($('hud') as HTMLElement).textContent =
    `画布 ${scene.widthRef}×${scene.heightRef}  |  ${scene.layers.length} 层  |  t=${Math.round(currentMs)}ms` +
    (camActive() ? '  |  🎥 推摄像机（叠加在各层自身运动之上）' : '') + (dirty ? '  |  ● 未保存' : '') +
    `\n${camActive() ? '镜头叠加各层自身运动实时预览；改图层自身运动请先关相机再拖' : '拖元素=在当前时间打关键帧（只在不透明处能选中图层）'}`;
}
function drawOverlay() {
  overlay.clear();
  overlay.rect(0, 0, scene.widthRef, scene.heightRef).stroke({ width: 2 / currentDisp(), color: 0x4a6fb5, alpha: 0.7 });
  const layer = scene.layers[selLayer];
  if (!layer || camActive()) return; // 相机模式下不画每层轨迹（sprite 已被镜头变换）
  if (layer.keyframes.length > 1) {
    overlay.moveTo(layer.keyframes[0].x, layer.keyframes[0].y);
    for (const k of layer.keyframes.slice(1)) overlay.lineTo(k.x, k.y);
    overlay.stroke({ width: 2 / currentDisp(), color: 0xffcf7a, alpha: 0.8 });
  }
  layer.keyframes.forEach((k, i) => {
    overlay.circle(k.x, k.y, (i === selKf ? 9 : 6) / currentDisp())
      .fill({ color: i === selKf ? 0xff7a7a : 0xffcf7a, alpha: 0.95 });
  });
  const sp = spriteMap.get(layer.id);
  if (sp) {
    const b = sp.getLocalBounds();
    overlay.rect(sp.x - (b.width / 2) * sp.scale.x, sp.y - (b.height / 2) * sp.scale.y, b.width * sp.scale.x, b.height * sp.scale.y)
      .stroke({ width: 1.5 / currentDisp(), color: 0x4ade80, alpha: 0.6 });
  }
}

// ---------- 电影黑边预览（仅编辑器本地，不进 JSON） ----------
function drawMovieBar() {
  if (!mbOn || mbPct <= 0) return;
  const p = Math.max(0, Math.min(0.49, mbPct));
  const bh = p * scene.heightRef;
  // 画在 overlay（授权坐标，随场景 fit 缩放）里、drawOverlay 之后追加 → 恒在最上层，
  // 上下各一条纯黑，模拟运行时 showMovieBar 盖住画面上下。
  overlay.rect(0, 0, scene.widthRef, bh).fill({ color: 0x000000, alpha: 1 });
  overlay.rect(0, scene.heightRef - bh, scene.widthRef, bh).fill({ color: 0x000000, alpha: 1 });
}
function loadMovieBarPref() {
  try {
    const s = JSON.parse(localStorage.getItem('px-editor-moviebar') || '{}');
    mbOn = !!s.on;
    mbPct = typeof s.pct === 'number' ? Math.max(0, Math.min(0.49, s.pct)) : 0.1;
  } catch { mbOn = false; mbPct = 0.1; }
  const on = document.getElementById('mb-on') as HTMLInputElement | null;
  const pct = document.getElementById('mb-pct') as HTMLInputElement | null;
  if (on) on.checked = mbOn;
  if (pct) pct.value = String(mbPct);
}
function saveMovieBarPref() { localStorage.setItem('px-editor-moviebar', JSON.stringify({ on: mbOn, pct: mbPct })); }

// ---------- sprite / alpha 管理 ----------
async function ensureTexture(url: string): Promise<Texture> {
  if (texCache.has(url)) return texCache.get(url)!;
  const t = await Assets.load(url); texCache.set(url, t); return t;
}
async function ensureAlphaMap(url: string): Promise<{ w: number; h: number; data: Uint8ClampedArray } | null> {
  if (alphaMaps.has(url)) return alphaMaps.get(url)!;
  alphaMaps.set(url, null);
  try {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('img')); img.src = url; });
    const w = img.naturalWidth, h = img.naturalHeight;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0);
    const map = { w, h, data: ctx.getImageData(0, 0, w, h).data };
    alphaMaps.set(url, map);
    return map;
  } catch {
    alphaMaps.set(url, null);
    return null;
  }
}
async function rebuildAll() {
  for (const sp of spriteMap.values()) sp.destroy();
  spriteMap.clear();
  for (const layer of scene.layers) {
    let tex: Texture | null = null;
    try { tex = await ensureTexture(layer.image); } catch { /* missing */ }
    const sp = new Sprite(tex || Texture.WHITE); sp.anchor.set(0.5); sp.eventMode = 'static'; sp.cursor = 'move';
    (sp as any).__layerId = layer.id;
    stage.addChild(sp); spriteMap.set(layer.id, sp);
    if (layer.image) ensureAlphaMap(layer.image);
  }
  refreshLayerList();
}

// ---------- UI ----------
function fillImageOptions() {
  const sel = $('l-image') as HTMLSelectElement;
  sel.innerHTML = '<option value="">（选图片）</option>' +
    images.map(im => `<option value="${im.url}">${im.name}</option>`).join('');
}
function fillSceneSelect() {
  const sel = $('scene-select') as HTMLSelectElement;
  sel.innerHTML = scenes.map((s, i) => `<option value="${i}">${s.id}</option>`).join('') || '<option>（无）</option>';
}
function refreshLayerList() {
  const el = $('layer-list');
  el.innerHTML = scene.layers.map((l, i) =>
    `<div class="item ${i === selLayer ? 'sel' : ''}" data-i="${i}"><span class="zi">z${l.zIndex ?? 0}</span><span class="nm">${l.id}${l.image ? ' · ' + l.image.split('/').pop() : ' · ⚠未选图'}</span></div>`).join('')
    || '<div class="item muted">（还没有图层，点＋加图层）</div>';
  el.querySelectorAll('.item[data-i]').forEach(node =>
    node.addEventListener('click', () => { selLayer = Number((node as HTMLElement).dataset.i); selKf = -1; refreshLayerList(); refreshLayerProps(); }));
  refreshLayerProps();
  refreshJson();
}
function refreshLayerProps() {
  const box = $('layer-props'); const layer = scene.layers[selLayer];
  box.style.display = layer ? '' : 'none';
  if (!layer) return;
  ($('l-id') as HTMLInputElement).value = layer.id;
  ($('l-image') as HTMLSelectElement).value = layer.image;
  ($('l-z') as HTMLInputElement).value = String(layer.zIndex ?? 0);
  ($('l-ease') as HTMLSelectElement).value = layer.easing || 'linear';
  ($('l-loop') as HTMLInputElement).checked = !!layer.loop;
  ($('l-depth') as HTMLInputElement).value = String(Math.round(depthOf(layer) * 100) / 100);
  drawKfTrack(); refreshKfProps();
}
function drawKfTrack() {
  const track = $('kf-track'); const layer = scene.layers[selLayer];
  track.querySelectorAll('.kf-mark').forEach(n => n.remove());
  if (!layer) return;
  const w = track.clientWidth || 280;
  layer.keyframes.forEach((k, i) => {
    const m = document.createElement('div'); m.className = 'kf-mark' + (i === selKf ? ' sel' : '');
    m.style.left = `${(k.atMs / Math.max(1, maxMs)) * w}px`; m.title = `${k.atMs}ms`;
    m.addEventListener('click', (e) => { e.stopPropagation(); selKf = i; currentMs = k.atMs; syncScrub(); refreshLayerProps(); });
    track.appendChild(m);
  });
  ($('playhead') as HTMLElement).style.left = `${(currentMs / Math.max(1, maxMs)) * w}px`;
}
function refreshKfProps() {
  const box = $('kf-props'); const layer = scene.layers[selLayer];
  const k = layer && selKf >= 0 ? layer.keyframes[selKf] : null;
  box.style.display = k ? '' : 'none';
  if (!k) return;
  ($('k-t') as HTMLInputElement).value = String(k.atMs);
  ($('k-x') as HTMLInputElement).value = String(Math.round(k.x));
  ($('k-y') as HTMLInputElement).value = String(Math.round(k.y));
  ($('k-s') as HTMLInputElement).value = String(k.scale ?? 1);
  ($('k-r') as HTMLInputElement).value = String(k.rotation ?? 0);
  ($('k-a') as HTMLInputElement).value = String(k.alpha ?? 1);
}

// ---------- 相机 UI ----------
function refreshCamUI() {
  const cam = ensureCamera();
  ($('cam-enable') as HTMLInputElement).checked = cam.enabled;
  ($('cam-body') as HTMLElement).style.display = cam.enabled ? '' : 'none';
  drawCamTrack(); refreshCamKfProps();
}
function drawCamTrack() {
  const track = $('cam-track'); const cam = scene.camera;
  track.querySelectorAll('.cam-mark').forEach(n => n.remove());
  const w = track.clientWidth || 280;
  (cam?.keyframes ?? []).forEach((k, i) => {
    const m = document.createElement('div'); m.className = 'cam-mark' + (i === selCamKf ? ' sel' : '');
    m.style.left = `${(k.atMs / Math.max(1, maxMs)) * w}px`; m.title = `${k.atMs}ms zoom${k.zoom}`;
    m.addEventListener('click', (e) => { e.stopPropagation(); selCamKf = i; currentMs = k.atMs; syncScrub(); refreshCamKfProps(); });
    track.appendChild(m);
  });
  ($('cam-playhead') as HTMLElement).style.left = `${(currentMs / Math.max(1, maxMs)) * w}px`;
}
function refreshCamKfProps() {
  const box = $('cam-kf-props'); const cam = scene.camera;
  const k = cam && selCamKf >= 0 ? cam.keyframes[selCamKf] : null;
  box.style.display = k ? '' : 'none';
  if (!k) return;
  ($('cam-t') as HTMLInputElement).value = String(k.atMs);
  ($('cam-zoom') as HTMLInputElement).value = String(k.zoom);
  ($('cam-px') as HTMLInputElement).value = String(k.panX);
  ($('cam-py') as HTMLInputElement).value = String(k.panY);
  ($('cam-roll') as HTMLInputElement).value = String(k.roll);
}

function cleanKfs(kfs: Keyframe[]): Keyframe[] {
  return [...kfs].sort((a, b) => a.atMs - b.atMs).map(k => ({
    atMs: Math.round(k.atMs), x: Math.round(k.x * 100) / 100, y: Math.round(k.y * 100) / 100,
    scale: k.scale != null && k.scale !== 1 ? Math.round(k.scale * 1000) / 1000 : undefined,
    rotation: k.rotation ? Math.round(k.rotation * 1000) / 1000 : undefined,
    alpha: k.alpha != null && k.alpha !== 1 ? k.alpha : undefined,
  })) as Keyframe[];
}
function sceneClean(): Scene {
  const camOn = camActive();
  const times = camOn ? bakeTimes() : [];
  const out: Scene = {
    id: scene.id, widthRef: scene.widthRef, heightRef: scene.heightRef,
    layers: scene.layers.map(l => {
      // 运行时播放帧：相机开→烘焙「相机×自身运动」（线性回放）；相机关→就是自身运动
      const runtimeKfs = camOn ? bakedKeyframesFor(l, times) : l.keyframes;
      const e: any = {
        id: l.id, image: l.image, zIndex: l.zIndex ?? 0,
        // 相机开时运行时帧是密采样，必须线性回放 → 不写 easing（=linear）
        easing: !camOn && l.easing && l.easing !== 'linear' ? l.easing : undefined,
        loop: l.loop ? true : undefined,
        depth: camOn && l.depth != null ? l.depth : undefined,
        keyframes: cleanKfs(runtimeKfs),
      };
      if (camOn) {
        e.sourceKeyframes = cleanKfs(l.keyframes);              // 保留自身运动供再编辑
        if (l.easing && l.easing !== 'linear') e.sourceEasing = l.easing;
      }
      return e;
    }) as Layer[],
  } as Scene;
  if (scene.camera && (scene.camera.enabled || scene.camera.keyframes.length)) {
    out.camera = {
      enabled: scene.camera.enabled,
      keyframes: scene.camera.keyframes.slice().sort((a, b) => a.atMs - b.atMs).map(k => ({
        atMs: Math.round(k.atMs), panX: k.panX, panY: k.panY, zoom: k.zoom, roll: k.roll,
      })),
    };
  }
  return out;
}
function refreshJson() { ($('json-out') as HTMLTextAreaElement).value = JSON.stringify(sceneClean(), null, 2); }
function loadScene(s: Scene) {
  scene = JSON.parse(JSON.stringify(s));
  scene.widthRef ||= 1672; scene.heightRef ||= 941; scene.layers ||= [];
  if (!scene.camera) scene.camera = { enabled: false, keyframes: [] };
  // 工作态 layer.keyframes 恒为「自身运动」：若磁盘上是相机烘焙结果(有 sourceKeyframes)，还原自身运动
  for (const l of scene.layers) {
    if (Array.isArray(l.sourceKeyframes) && l.sourceKeyframes.length) {
      l.keyframes = l.sourceKeyframes;
      if (l.sourceEasing) l.easing = l.sourceEasing;
    }
    delete l.sourceKeyframes; delete l.sourceEasing;
  }
  loadedId = scene.id;
  dirty = false; updateSaveBtn();
  selLayer = scene.layers.length ? 0 : -1; selKf = -1; selCamKf = scene.camera.keyframes.length ? 0 : -1; currentMs = 0;
  maxMs = Math.max(14000, ...scene.layers.flatMap(l => l.keyframes.map(k => k.atMs)), ...scene.camera.keyframes.map(k => k.atMs));
  ($('scene-id') as HTMLInputElement).value = scene.id;
  ($('scene-w') as HTMLInputElement).value = String(scene.widthRef);
  ($('scene-h') as HTMLInputElement).value = String(scene.heightRef);
  ($('tl-max') as HTMLInputElement).value = String(maxMs);
  ($('tl-scrub') as HTMLInputElement).max = String(maxMs);
  refreshCamUI();
  rebuildAll();
}
function syncScrub() { ($('tl-scrub') as HTMLInputElement).value = String(Math.round(currentMs)); updateTimeLabel(); drawKfTrack(); drawCamTrack(); }
function updateTimeLabel() { ($('tl-time') as HTMLElement).textContent = `${Math.round(currentMs)} / ${maxMs} ms`; }
function toast(msg: string) { const t = $('toast'); t.textContent = msg; t.style.opacity = '1'; setTimeout(() => t.style.opacity = '0', 1600); }

function bindUI() {
  $('scene-select').addEventListener('change', e => {
    const selEl = e.target as HTMLSelectElement;
    const i = Number(selEl.value);
    if (!scenes[i]) return;
    if (!confirmDiscardIfDirty()) { selEl.value = String(scenes.findIndex(s => s.id === loadedId)); return; }
    loadScene(scenes[i]);
  });
  $('scene-new').addEventListener('click', () => {
    if (!confirmDiscardIfDirty()) return;
    loadScene({ id: 'new_scene_' + (scenes.length + 1), widthRef: 1672, heightRef: 941, layers: [] });
  });
  $('scene-id').addEventListener('input', e => { scene.id = (e.target as HTMLInputElement).value.trim(); markDirty(); refreshJson(); });
  $('scene-w').addEventListener('input', e => { scene.widthRef = Number((e.target as HTMLInputElement).value) || 1672; markDirty(); refreshJson(); });
  $('scene-h').addEventListener('input', e => { scene.heightRef = Number((e.target as HTMLInputElement).value) || 941; markDirty(); refreshJson(); });

  $('layer-add').addEventListener('click', () => {
    const id = 'layer' + (scene.layers.length + 1);
    scene.layers.push({ id, image: '', zIndex: scene.layers.length * 10, keyframes: [{ atMs: 0, x: scene.widthRef / 2, y: scene.heightRef / 2, scale: 1 }] });
    selLayer = scene.layers.length - 1; selKf = 0; markDirty(); rebuildAll();
    toast('已加图层 — 在下方「图片」选好贴图，再拖到画布上打关键帧');
  });
  $('layer-del').addEventListener('click', () => { if (selLayer < 0) return; scene.layers.splice(selLayer, 1); selLayer = Math.min(selLayer, scene.layers.length - 1); markDirty(); rebuildAll(); });
  $('layer-up').addEventListener('click', () => moveLayer(-1));
  $('layer-down').addEventListener('click', () => moveLayer(1));
  $('l-id').addEventListener('input', e => {
    const l = scene.layers[selLayer]; if (!l) return;
    const oldId = l.id; const newId = (e.target as HTMLInputElement).value.trim();
    l.id = newId;
    const sp = spriteMap.get(oldId);
    if (sp && oldId !== newId) { spriteMap.delete(oldId); spriteMap.set(newId, sp); (sp as any).__layerId = newId; }
    markDirty(); refreshLayerList();
  });
  $('l-image').addEventListener('change', async e => { const l = scene.layers[selLayer]; if (l) { l.image = (e.target as HTMLSelectElement).value; markDirty(); await rebuildAll(); } });
  $('l-z').addEventListener('input', e => { const l = scene.layers[selLayer]; if (l) { l.zIndex = Number((e.target as HTMLInputElement).value) || 0; markDirty(); refreshLayerList(); } });
  $('l-ease').addEventListener('change', e => { const l = scene.layers[selLayer]; if (l) { l.easing = (e.target as HTMLSelectElement).value; markDirty(); refreshJson(); } });
  $('l-loop').addEventListener('change', e => { const l = scene.layers[selLayer]; if (l) { l.loop = (e.target as HTMLInputElement).checked; markDirty(); refreshJson(); } });
  $('l-depth').addEventListener('input', e => { const l = scene.layers[selLayer]; if (l) { l.depth = Number((e.target as HTMLInputElement).value); markDirty(); refreshJson(); } });

  $('kf-add').addEventListener('click', () => {
    const l = scene.layers[selLayer]; if (!l) return;
    const s = sample(l.keyframes, currentMs, false, l.easing || 'linear');
    const existing = l.keyframes.findIndex(k => Math.abs(k.atMs - currentMs) < 1);
    if (existing >= 0) { selKf = existing; }
    else { l.keyframes.push({ atMs: Math.round(currentMs), x: s.x, y: s.y, scale: s.scale, rotation: s.rotation, alpha: s.alpha }); l.keyframes.sort((a, b) => a.atMs - b.atMs); selKf = l.keyframes.findIndex(k => Math.abs(k.atMs - currentMs) < 1); }
    markDirty(); refreshLayerProps(); refreshJson();
  });
  $('kf-del').addEventListener('click', () => { const l = scene.layers[selLayer]; if (l && selKf >= 0) { l.keyframes.splice(selKf, 1); selKf = -1; markDirty(); refreshLayerProps(); refreshJson(); } });
  const kfEdit = (prop: keyof Keyframe, id: string) => $(id).addEventListener('input', e => {
    const l = scene.layers[selLayer]; if (!l || selKf < 0) return;
    (l.keyframes[selKf] as any)[prop] = Number((e.target as HTMLInputElement).value);
    if (prop === 'atMs') l.keyframes.sort((a, b) => a.atMs - b.atMs);
    markDirty(); refreshJson(); drawKfTrack();
  });
  kfEdit('atMs', 'k-t'); kfEdit('x', 'k-x'); kfEdit('y', 'k-y'); kfEdit('scale', 'k-s'); kfEdit('rotation', 'k-r'); kfEdit('alpha', 'k-a');

  // ----- 推摄像机 -----
  $('cam-enable').addEventListener('change', e => {
    const cam = ensureCamera();
    cam.enabled = (e.target as HTMLInputElement).checked;
    if (cam.enabled && cam.keyframes.length === 0) {
      cam.keyframes = [
        { atMs: 0, panX: 0, panY: 0, zoom: 1, roll: 0 },
        { atMs: maxMs, panX: 0, panY: 0, zoom: 1.12, roll: 0 },
      ];
      selCamKf = 1;
    }
    markDirty(); refreshCamUI(); refreshJson();
  });
  $('cam-kf-add').addEventListener('click', () => {
    const cam = ensureCamera();
    const c = sampleCamera(currentMs);
    const ex = cam.keyframes.findIndex(k => Math.abs(k.atMs - currentMs) < 1);
    if (ex >= 0) selCamKf = ex;
    else { cam.keyframes.push({ atMs: Math.round(currentMs), panX: c.panX, panY: c.panY, zoom: c.zoom, roll: c.roll }); cam.keyframes.sort((a, b) => a.atMs - b.atMs); selCamKf = cam.keyframes.findIndex(k => Math.abs(k.atMs - currentMs) < 1); }
    markDirty(); refreshCamKfProps(); drawCamTrack(); refreshJson();
  });
  $('cam-kf-del').addEventListener('click', () => { const cam = scene.camera; if (cam && selCamKf >= 0) { cam.keyframes.splice(selCamKf, 1); selCamKf = -1; markDirty(); refreshCamKfProps(); drawCamTrack(); refreshJson(); } });
  const camEdit = (prop: keyof CamKey, id: string) => $(id).addEventListener('input', e => {
    const cam = scene.camera; if (!cam || selCamKf < 0) return;
    (cam.keyframes[selCamKf] as any)[prop] = Number((e.target as HTMLInputElement).value);
    if (prop === 'atMs') cam.keyframes.sort((a, b) => a.atMs - b.atMs);
    markDirty(); refreshJson(); drawCamTrack();
  });
  camEdit('atMs', 'cam-t'); camEdit('zoom', 'cam-zoom'); camEdit('panX', 'cam-px'); camEdit('panY', 'cam-py'); camEdit('roll', 'cam-roll');

  $('tl-play').addEventListener('click', () => { playing = !playing; lastT = 0; ($('tl-play') as HTMLElement).textContent = playing ? '⏸ 暂停' : '▶ 播放'; });
  $('tl-stop').addEventListener('click', () => { playing = false; currentMs = 0; ($('tl-play') as HTMLElement).textContent = '▶ 播放'; syncScrub(); });
  $('tl-scrub').addEventListener('input', e => { currentMs = Number((e.target as HTMLInputElement).value); playing = false; ($('tl-play') as HTMLElement).textContent = '▶ 播放'; updateTimeLabel(); drawKfTrack(); drawCamTrack(); });
  $('tl-max').addEventListener('input', e => { maxMs = Math.max(1000, Number((e.target as HTMLInputElement).value) || 14000); ($('tl-scrub') as HTMLInputElement).max = String(maxMs); syncScrub(); });

  // 电影黑边预览（仅本地，不改场景数据/不入脏/不写 JSON）
  $('mb-on').addEventListener('change', e => { mbOn = (e.target as HTMLInputElement).checked; saveMovieBarPref(); });
  $('mb-pct').addEventListener('input', e => { mbPct = Math.max(0, Math.min(0.49, Number((e.target as HTMLInputElement).value) || 0)); saveMovieBarPref(); });

  $('btn-copy').addEventListener('click', () => { navigator.clipboard.writeText(($('json-out') as HTMLTextAreaElement).value); toast('已复制 JSON'); });
  $('btn-save').addEventListener('click', saveScenes);
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveScenes(); }
  });
}
function moveLayer(d: number) {
  const i = selLayer, j = i + d; if (i < 0 || j < 0 || j >= scene.layers.length) return;
  [scene.layers[i], scene.layers[j]] = [scene.layers[j], scene.layers[i]]; selLayer = j; markDirty(); refreshLayerList();
}
async function saveScenes() {
  const clean = sceneClean();  // 相机开时内部已烘焙「相机×自身运动」→ keyframes，自身运动进 sourceKeyframes
  if (!clean.id) { toast('先填场景 id 再保存'); return; }
  if (!clean.layers.length) { toast('这个场景一层都没有，先＋加图层'); return; }
  const bad = clean.layers.find(l => !l.image);
  if (bad) { toast(`图层「${bad.id}」还没选图片，先选好贴图再保存（否则运行时这层不显示）`); return; }
  const dupIds = clean.layers.map(l => l.id).filter((v, i, a) => a.indexOf(v) !== i);
  if (dupIds.length) { toast(`图层 id 重复：${dupIds[0]}（同场景内 id 要唯一）`); return; }

  if (loadedId && loadedId !== clean.id) {
    const oldIdx = scenes.findIndex(s => s.id === loadedId);
    if (oldIdx >= 0) scenes.splice(oldIdx, 1);
  }
  const idx = scenes.findIndex(s => s.id === clean.id);
  if (idx >= 0) scenes[idx] = clean; else scenes.push(clean);

  const r = await fetch('/api/parallax/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(scenes) }).then(r => r.json()).catch(e => ({ ok: false, error: String(e) }));
  if (r.ok) {
    loadedId = clean.id; dirty = false; updateSaveBtn();
    fillSceneSelect(); ($('scene-select') as HTMLSelectElement).value = String(scenes.findIndex(s => s.id === clean.id));
    toast(`已保存 ${r.count} 个场景到 parallax_scenes.json` + (camActive() ? '（相机已叠加烘焙进各层）' : ''));
  } else toast('保存失败：' + r.error);
}

// ---------- 画布拖拽打帧 ----------
function layerHitAt(layer: Layer, px: number, py: number): boolean {
  const sp = spriteMap.get(layer.id); if (!sp) return false;
  const gp = sp.toLocal({ x: px, y: py } as any);
  const b = sp.getLocalBounds();
  if (gp.x < b.x || gp.x > b.x + b.width || gp.y < b.y || gp.y > b.y + b.height) return false;
  const map = layer.image ? alphaMaps.get(layer.image) : null;
  if (!map) return true;
  const tx = Math.floor((gp.x - b.x) / b.width * map.w);
  const ty = Math.floor((gp.y - b.y) / b.height * map.h);
  if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) return false;
  return map.data[(ty * map.w + tx) * 4 + 3] > 16;
}
function bindCanvasDrag() {
  let dragging: string | null = null;
  let downX = 0, downY = 0, moved = false;
  const DRAG_THRESHOLD = 4;
  app.stage.eventMode = 'static';
  app.stage.hitArea = { contains: () => true } as any;
  app.canvas.addEventListener('pointerdown', (e: PointerEvent) => {
    const rect = app.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    let hit: string | null = null; let hz = -Infinity;
    for (const layer of scene.layers) {
      if ((layer.zIndex ?? 0) < hz) continue;
      if (layerHitAt(layer, px, py)) { hit = layer.id; hz = layer.zIndex ?? 0; }
    }
    if (hit) {
      dragging = hit; downX = e.clientX; downY = e.clientY; moved = false;
      selLayer = scene.layers.findIndex(l => l.id === hit); selKf = -1; refreshLayerList();
    }
  });
  app.canvas.addEventListener('pointermove', (e: PointerEvent) => {
    if (!dragging) return;
    // 推摄像机模式下画布拖动只选中不打帧：镜头是叠加变换，拖的屏幕位不等于图层自身位（要改自身运动先关相机）
    if (camActive()) return;
    if (!moved) {
      if (Math.hypot(e.clientX - downX, e.clientY - downY) < DRAG_THRESHOLD) return;
      moved = true;
    }
    const rect = app.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    const local = stage.toLocal({ x: px, y: py } as any);
    const l = scene.layers[selLayer]; if (!l) return;
    const s = sample(l.keyframes, currentMs, false, l.easing || 'linear');
    const ei = l.keyframes.findIndex(k => Math.abs(k.atMs - currentMs) < 1);
    if (ei >= 0) { l.keyframes[ei].x = local.x; l.keyframes[ei].y = local.y; selKf = ei; }
    else { l.keyframes.push({ atMs: Math.round(currentMs), x: local.x, y: local.y, scale: s.scale, rotation: s.rotation, alpha: s.alpha }); l.keyframes.sort((a, b) => a.atMs - b.atMs); selKf = l.keyframes.findIndex(k => Math.abs(k.atMs - currentMs) < 1); }
    markDirty(); refreshKfProps(); drawKfTrack(); refreshJson();
  });
  window.addEventListener('pointerup', () => { dragging = null; moved = false; });
}

boot();
