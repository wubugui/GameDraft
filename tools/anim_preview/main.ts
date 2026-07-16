import { Application, Container, Graphics, Assets, Texture, Sprite, Rectangle } from 'pixi.js';
import { SpriteEntity } from '@src/rendering/SpriteEntity';
import { normalizeAnimationSetDef } from '@src/data/resolveAnimationSet';
import { EntityLightingFilter } from '@src/rendering/EntityLightingFilter';
import { PlanarEntityShadow } from '@src/rendering/EntityShadow';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const escapeHtml = (value: unknown): string => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

interface WorkbenchPreviewCandidateDetail {
  id: string;
  label: string;
  folderName: string;
  revisionId: string;
  animUrl: string;
  atlasUrl: string;
  animVersion: string;
  atlasVersion: string;
}

function versionedUrl(rawUrl: string, version: unknown): string {
  const url = new URL(rawUrl, window.location.href);
  if (version !== undefined && version !== null && String(version)) {
    url.searchParams.set('v', String(version));
  }
  return url.href;
}

let app: Application;
let world: Container;          // scaled by zoom; anchor at (0,0)
let sceneBgSprite: Sprite | null = null;   // real scene background image (behind everything)
let bgLayer: Graphics;
let overlay: Graphics;
let shadowLayer: Container;    // under the entity (world space)
let onionLayer: Container;
let entity: SpriteEntity | null = null;
let atlasTex: Texture | null = null;

let bundles: any[] = [];
let candidateBundle: any = null;
let previewRuntimeReady = false;
let current: any = null;
let curDef: any = null;
let curRaw: any = null;
let curState = '';
let playing = true;
let loopOverride = true;
let speed = 1;
let facing: 1 | -1 = 1;
let zoom = 1;
let scrubbing = false;
let selectionGeneration = 0;
let onionRenderKey = '';
let previewPageActive = false;
let previewNeedsFit = true;

function setPreviewZoom(next: number): void {
  const safe = Math.max(0.001, Math.min(100000, Number(next) || 1));
  const control = $('zoom') as HTMLInputElement;
  if (safe > Number(control.max)) control.max = String(Math.ceil(safe * 1.2));
  if (safe < Number(control.min)) control.min = String(safe);
  zoom = safe;
  control.value = String(safe);
}

// lighting
let lightFilter: EntityLightingFilter | null = null;
let shadow: PlanarEntityShadow | null = null;
let probeTex: Texture | null = null;
let lastAmbHex = '';
// compare
let entityB: SpriteEntity | null = null;
let atlasTexB: Texture | null = null;
let curDefB: any = null;
// scene placement (character stood in a real scene at true world scale)
let curScene: any = null;
let sceneList: any[] = [];

// ---------- Pixi ----------
async function initPixi() {
  app = new Application();
  await app.init({ backgroundAlpha: 0, antialias: true, resizeTo: $('stageWrap') });
  $('stage').appendChild(app.canvas);
  sceneBgSprite = new Sprite(); sceneBgSprite.visible = false; app.stage.addChild(sceneBgSprite);
  bgLayer = new Graphics(); app.stage.addChild(bgLayer);
  world = new Container(); app.stage.addChild(world);
  shadowLayer = new Container(); world.addChild(shadowLayer);
  onionLayer = new Container(); world.addChild(onionLayer);
  overlay = new Graphics(); app.stage.addChild(overlay);
  app.ticker.add(() => tick(app.ticker.deltaMS / 1000));
  new ResizeObserver(() => layout()).observe($('stageWrap'));
  layout();
  syncPreviewPageActivity(document.getElementById('previewPage')?.classList.contains('active') === true);
}

function syncPreviewPageActivity(active: boolean) {
  previewPageActive = active;
  if (!app) return;
  if (!active) {
    app.ticker.stop();
    return;
  }
  app.ticker.start();
  requestAnimationFrame(() => {
    if (!previewPageActive || !app) return;
    layout();
    if (previewNeedsFit && curDef) {
      if (($('bg') as HTMLSelectElement).value === 'scene' && curScene) {
        setPreviewZoom(sceneComfortZoom());
        layout();
      } else {
        fitZoom();
      }
      previewNeedsFit = false;
    }
  });
}
function layout() {
  if (!app) return;
  applyPlacement();
  drawBg(app.renderer.width, app.renderer.height);
}
/** Comfortable camera scale: character ~55% of stage height (never tiny). */
function sceneComfortZoom(): number {
  const h = app ? app.renderer.height : 800;
  return curDef ? Math.max(0.02, (h * 0.55) / curDef.worldHeight) : 1;
}
/** Position world + scene bg per current mode.
 *  "scene" mode = a CAMERA: the character keeps its on-screen size (`zoom`), the
 *  background is drawn ENLARGED at the same world scale and the view is centred on
 *  the character's spawn — so you see a cropped, in-game-like slice around the char. */
function applyPlacement() {
  const w = app.renderer.width, h = app.renderer.height;
  const inScene = ($('bg') as HTMLSelectElement).value === 'scene' && curScene && curDef
    && sceneBgSprite?.texture && sceneBgSprite.texture.width > 1;
  if (inScene) {
    const tw = sceneBgSprite!.texture.width;
    const ppw = zoom;                                       // camera scale (char stays this size)
    const cx = w / 2, cy = h * 0.66;                        // char feet land here on screen
    world.x = cx - curScene.spawnX * ppw;
    world.y = cy - curScene.spawnY * ppw;
    const bgScale = (ppw * curScene.worldWidth) / tw;       // bg at the SAME world scale (enlarged)
    sceneBgSprite!.scale.set(bgScale);
    sceneBgSprite!.x = world.x + (curScene.bgX || 0) * ppw;
    sceneBgSprite!.y = world.y + (curScene.bgY || 0) * ppw;
    if (entity) { entity.x = curScene.spawnX; entity.y = curScene.spawnY; }
  } else {
    world.x = Math.round(w / 2); world.y = Math.round(h * 0.72);
    if (entity) { entity.x = 0; entity.y = 0; }
  }
}
function drawBg(w: number, h: number) {
  const mode = ($('bg') as HTMLSelectElement).value;
  if (sceneBgSprite) sceneBgSprite.visible = mode === 'scene' && !!sceneBgSprite.texture && sceneBgSprite.texture.width > 1;
  bgLayer.clear();
  if (mode === 'transparent' || mode === 'scene') return;   // scene draws via the sprite
  if (mode === 'grey') { bgLayer.rect(0, 0, w, h).fill(0x808080); return; }
  if (mode === 'sceneColor') { bgLayer.rect(0, 0, w, h).fill(0x3a4a5a); return; }
  const c = 16;
  for (let y = 0; y < h; y += c) for (let x = 0; x < w; x += c)
    bgLayer.rect(x, y, c, c).fill(((x / c + y / c) & 1) ? 0x2a3342 : 0x222a37);
}
async function loadScene(sc: any) {
  if (!sceneBgSprite || !sc) return;
  try {
    sceneBgSprite.texture = await Assets.load(sc.bgUrl); curScene = sc;
    setPreviewZoom(sceneComfortZoom());
    layout();
  } catch { toast('场景加载失败'); }
}
async function loadScenes() {
  try {
    const r = await fetch('/api/anim/scenes').then((x) => x.json());
    sceneList = r.scenes || [];
    const sel = $('sceneBg') as HTMLSelectElement;
    sel.replaceChildren(...sceneList.map((s: any, i: number) => {
      const option = document.createElement('option');
      option.value = String(i);
      option.textContent = `${s.name} · ${s.id}`;
      return option;
    }));
  } catch { /* none */ }
}

// ---------- render loop ----------
function tick(dt: number) {
  if (entity && curState) {
    const stateLoop = !!curDef?.states?.[curState]?.loop;
    if (playing) {
      entity.setPlaying(true); entity.update(dt * speed);
      const i = entity.getFrameIndex(), n = entity.getFrameCount();
      if (i >= n - 1 && n > 1) { if (!loopOverride) setPlaying(false); else if (!stateLoop) entity.setFrameIndex(0); }
    } else entity.setPlaying(false);
    if (($('pdm') as HTMLInputElement).checked) {
      const d = parseFloat(($('dbg') as HTMLInputElement).value) || 1;
      entity.applyPixelDensityMatch({ x: d, y: d }, 1);
    }
    if (entityB && playing) { entityB.setPlaying(true); entityB.update(dt * speed); }
    world.scale.set(zoom);
    driveLighting();
    drawOnion();
    updateTransport();
    drawOverlay();
  }
}

function drawOverlay() {
  overlay.clear();
  if (!entity || !curDef) return;
  const ax = world.x + entity.x * zoom, ay = world.y + entity.y * zoom;
  const ww = curDef.worldWidth * zoom, wh = curDef.worldHeight * zoom;
  if (($('ovCell') as HTMLInputElement).checked)
    overlay.rect(ax - ww / 2, ay - wh, ww, wh).stroke({ color: 0x4f9dff, width: 1, alpha: 0.7 });
  if (($('ovAnchor') as HTMLInputElement).checked) {
    overlay.moveTo(ax - 12, ay).lineTo(ax + 12, ay).moveTo(ax, ay - 12).lineTo(ax, ay + 12)
      .stroke({ color: 0xff4d4d, width: 1.5 });
    overlay.circle(ax, ay, 3).fill({ color: 0xff4d4d, alpha: 0.9 });
  }
}
function updateTransport() {
  if (!entity) return;
  const i = entity.getFrameIndex(), n = entity.getFrameCount();
  $('frameLabel').textContent = `${i + 1}/${n}`;
  if (!scrubbing) ($('timeline') as HTMLInputElement).value = String(i);
  const source = current?.isWorkbenchCandidate ? '工作台 H 候选（未发布）' : '已发布资源';
  $('stageInfo').textContent = `${source} · ${current?.label || current?.id || ''} · ${curState} · 帧 ${i + 1}/${n} · 世界 ${curDef.worldWidth}×${curDef.worldHeight} · zoom ${zoom.toFixed(2)}`;
}

// ---------- lighting (game modules) ----------
function hex2rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
function buildLightEnv(): any {
  const mode = ($('shadowMode') as HTMLSelectElement).value;
  return {
    key: { azimuthDeg: +($('lAzi') as HTMLInputElement).value, elevationDeg: +($('lElev') as HTMLInputElement).value,
           color: hex2rgb(($('lKey') as HTMLInputElement).value), intensity: +($('lKeyI') as HTMLInputElement).value },
    ambient: { color: hex2rgb(($('lAmb') as HTMLInputElement).value), intensity: +($('lAmbI') as HTMLInputElement).value },
    shadow: { mode, enabled: mode !== 'off', darkness: +($('sDark') as HTMLInputElement).value, softness: 0.5,
              length: +($('sLen') as HTMLInputElement).value, contact: 0.35, contactSize: 1, softSamples: 1, softRadius: 0, billboard: 'light' },
    toneStrength: +($('lTone') as HTMLInputElement).value, toneEnabled: +($('lTone') as HTMLInputElement).value > 0,
    ao: { contact: +($('lAoC') as HTMLInputElement).value, form: +($('lAoF') as HTMLInputElement).value },
  };
}
function makeProbe(rgb: [number, number, number]): Texture {
  const c = document.createElement('canvas'); c.width = c.height = 4;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = `rgb(${Math.round(rgb[0] * 255)},${Math.round(rgb[1] * 255)},${Math.round(rgb[2] * 255)})`;
  ctx.fillRect(0, 0, 4, 4);
  return Texture.from(c);
}
function rebuildLighting() {
  if (!entity || !curDef) return;
  const env = buildLightEnv();
  const ambHex = ($('lAmb') as HTMLInputElement).value;
  if (!probeTex || ambHex !== lastAmbHex) { probeTex = makeProbe(env.ambient.color); lastAmbHex = ambHex; }
  lightFilter = EntityLightingFilter.createForEntity({
    depthTexture: null, cfg: null, probeSource: probeTex.source, lightEnv: env,
    sampleLiftWorld: curDef.worldHeight * 0.4,
  });
  applyLightingAttach();
}
function applyLightingAttach() {
  if (!entity) return;
  entity.container.filters = ($('lightOn') as HTMLInputElement).checked && lightFilter ? [lightFilter as any] : [];
}
function driveLighting() {
  if (!entity) return;
  const on = ($('lightOn') as HTMLInputElement).checked;
  if (on && lightFilter) {
    const env = buildLightEnv();
    lightFilter.setProjectionScale(zoom);
    lightFilter.setWorldContainerPos(world.x, world.y);
    lightFilter.setSceneSize(Math.max(1, curDef.worldWidth), Math.max(1, curDef.worldHeight));
    lightFilter.setEntityFootX(entity.x); lightFilter.setEntityFootY(entity.y);
    lightFilter.setWorldToPixel(curDef.cellWidth / curDef.worldWidth, curDef.cellHeight / curDef.worldHeight);
    lightFilter.setKeyLight(env.key.color, env.key.intensity);
    lightFilter.setAmbient(env.ambient.color, env.ambient.intensity);
    lightFilter.setTone(env.toneEnabled ? env.toneStrength : 0);
    lightFilter.setAO(env.ao.contact, env.ao.form);
  }
  if (shadow) {
    const env = buildLightEnv();
    shadow.update({
      getFootX: () => entity!.x, getFootY: () => entity!.y,
      getWorldWidth: () => curDef.worldWidth, getWorldHeight: () => curDef.worldHeight,
      getTexture: () => entity!.getDisplayTexture(), getFacing: () => facing, isVisible: () => true,
    } as any, env as any);
  }
}

// ---------- onion skin ----------
function makeGhost(slot: number, def: any, tex: Texture, f: 1 | -1): Sprite {
  const box = def.atlasFrames?.[slot];
  const w = box?.width || def.cellWidth, h = box?.height || def.cellHeight;
  const col = slot % def.cols, row = Math.floor(slot / def.cols);
  const t = new Texture({ source: tex.source, frame: new Rectangle(col * def.cellWidth, row * def.cellHeight, w, h) });
  const s = new Sprite(t); s.anchor.set(0.5, 1);
  s.scale.set((def.worldWidth / w) * f, def.worldHeight / h);
  return s;
}
function drawOnion() {
  const enabled = ($('onion') as HTMLInputElement).checked;
  const key = entity && curDef && atlasTex && enabled
    ? `${current?.id}|${curState}|${entity.getFrameIndex()}|${facing}|${($('onionN') as HTMLInputElement).value}`
    : 'off';
  if (key === onionRenderKey) return;
  onionRenderKey = key;
  onionLayer.removeChildren().forEach((child) => child.destroy({ children: true, texture: true }));
  if (!entity || !curDef || !atlasTex || !enabled) return;
  const seq = curDef.states[curState].frames;
  const n = seq.length, i = entity.getFrameIndex();
  const k = Math.max(1, Math.min(6, +($('onionN') as HTMLInputElement).value || 2));
  for (let d = -k; d <= k; d++) {
    if (d === 0) continue;
    const j = ((i + d) % n + n) % n;
    const g = makeGhost(seq[j], curDef, atlasTex, facing);
    g.alpha = 0.22 * (1 - Math.abs(d) / (k + 1));
    g.tint = d < 0 ? 0x66aaff : 0xff8866;
    onionLayer.addChild(g);
  }
}

// ---------- data / selection ----------
async function loadIndex() {
  const r = await fetch('/api/anim/index').then((x) => x.json());
  bundles = r.bundles || [];
  renderCharList(); fillCompareChars();
}
function renderCharList() {
  renderCandidatePreview();
  const q = ($('search') as HTMLInputElement).value.trim().toLowerCase();
  const list = $('charList'); list.innerHTML = '';
  const shown = bundles.filter((b) => !q || b.id.toLowerCase().includes(q));
  $('charCount').textContent = `${shown.length}/${bundles.length}`;
  for (const b of shown) {
    const el = document.createElement('div');
    el.className = 'char' + (current?.id === b.id ? ' sel' : '') + (b.summary?.valid ? '' : ' bad');
    const st = b.summary?.valid ? `${b.summary.stateCount} 状态 · ${b.summary.frameCount ?? '?'} 帧` : '无效 anim.json';
    const title = document.createElement('div'); title.textContent = b.id;
    const sub = document.createElement('div'); sub.className = 'sub'; sub.textContent = `${st}${b.atlasExists ? '' : ' · 缺图'}`;
    el.append(title, sub);
    el.onclick = () => selectChar(b);
    list.appendChild(el);
  }
}

function renderCandidatePreview() {
  const root = $('candidatePreview');
  root.replaceChildren();
  if (!candidateBundle) return;
  const heading = document.createElement('h2');
  heading.textContent = '工作台 H 候选 · 未发布';
  const row = document.createElement('div');
  row.className = `char candidate${current?.id === candidateBundle.id ? ' sel' : ''}${candidateBundle.summary?.valid === false ? ' bad' : ''}`;
  row.title = `${candidateBundle.folderName} · ${candidateBundle.revisionId}`;
  const title = document.createElement('div');
  title.textContent = candidateBundle.label;
  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = candidateBundle.summary?.valid === false
    ? '真实渲染器加载失败 · 未发布'
    : candidateBundle.summary?.valid
      ? `${candidateBundle.summary.stateCount} 状态 · ${candidateBundle.summary.frameCount ?? '?'} 帧 · 未发布`
      : '点击后直接用 SpriteEntity 校验 · 不会发布';
  row.append(title, sub);
  row.onclick = () => void selectChar(candidateBundle);
  root.append(heading, row);
}

function installWorkbenchPreviewBridge() {
  window.addEventListener('workbench-preview-candidate', (event) => {
    const detail = (event as CustomEvent<WorkbenchPreviewCandidateDetail>).detail;
    if (!detail
      || !detail.id
      || !detail.label
      || !detail.animUrl
      || !detail.atlasUrl
      || !detail.revisionId) {
      toast('H 候选预览参数不完整');
      return;
    }
    candidateBundle = {
      id: detail.id,
      label: detail.label,
      folderName: detail.folderName,
      revisionId: detail.revisionId,
      animUrl: detail.animUrl,
      atlasUrl: detail.atlasUrl,
      animMtime: detail.animVersion,
      atlasMtime: detail.atlasVersion,
      atlasExists: true,
      summary: null,
      isWorkbenchCandidate: true,
    };
    renderCharList();
    if (previewRuntimeReady) void selectChar(candidateBundle);
  });
}

async function selectChar(b: any) {
  const generation = ++selectionGeneration;
  try {
    current = b; renderCharList();
    const [nextRaw, nextAtlas] = await Promise.all([
      fetch(versionedUrl(b.animUrl, b.animMtime)).then((response) => {
        if (!response.ok) throw new Error(`anim.json HTTP ${response.status}`);
        return response.json();
      }),
      Assets.load(versionedUrl(b.atlasUrl, b.atlasMtime)),
    ]);
    if (generation !== selectionGeneration) return;
    curRaw = nextRaw;
    atlasTex = nextAtlas;
    curDef = normalizeAnimationSetDef(curRaw, atlasTex!.width, atlasTex!.height);
    if (b.isWorkbenchCandidate) {
      b.summary = {
        valid: true,
        stateCount: Object.keys(curDef.states).length,
        frameCount: curDef.atlasFrames?.length,
      };
      b.atlasExists = true;
      renderCharList();
    }
    if (entity) { world.removeChild(entity.container); entity.destroy(); }
    entity = new SpriteEntity();
    entity.loadFromDef(atlasTex!, curDef);
    entity.setPixelDensityMatchActive(($('pdm') as HTMLInputElement).checked);
    entity.x = 0; entity.y = 0;
    world.addChild(entity.container);
    if (shadow) { shadow.destroy(); }
    shadow = new PlanarEntityShadow(shadowLayer, null);
    rebuildLighting();
    renderStates(); renderInfo(b, atlasTex!);
    if (!previewPageActive) {
      previewNeedsFit = true;
    } else if (($('bg') as HTMLSelectElement).value === 'scene' && curScene) {
      setPreviewZoom(sceneComfortZoom()); layout();
      previewNeedsFit = false;
    } else {
      fitZoom();
      previewNeedsFit = false;
    }
    const want = new URLSearchParams(location.search).get('state');
    const states = Object.keys(curDef.states);
    selectState(want && states.includes(want) ? want : states[0]);
  } catch (e: any) {
    if (generation === selectionGeneration) {
      if (b.isWorkbenchCandidate) {
        b.summary = { valid: false };
        renderCharList();
      }
      toast('加载失败: ' + (e?.message || e));
    }
  }
}
function selectState(name: string) {
  if (!entity || !name || !curDef.states[name]) return;
  curState = name;
  onionRenderKey = '';
  entity.playAnimation(name); entity.setDirection(facing, 0); setPlaying(true);
  const n = entity.getFrameCount();
  const tl = $('timeline') as HTMLInputElement; tl.max = String(Math.max(0, n - 1)); tl.value = '0';
  ($('fps') as HTMLInputElement).value = String(curDef.states[name].frameRate);
  renderStates(); renderStateInfo();
}
function renderStates() {
  const box = $('stateList'); box.innerHTML = '';
  if (!curDef) return;
  for (const name of Object.keys(curDef.states)) {
    const el = document.createElement('div');
    el.className = 'state' + (name === curState ? ' sel' : '');
    el.textContent = name; el.onclick = () => selectState(name); box.appendChild(el);
  }
  const sel = $('stateSel') as HTMLSelectElement;
  sel.replaceChildren(...Object.keys(curDef.states).map((name) => {
    const option = document.createElement('option'); option.value = name; option.textContent = name; return option;
  }));
  sel.value = curState;
}
function renderInfo(b: any, tex: Texture) {
  const d = curDef;
  const atlasOk = tex.width <= 2048 && tex.height <= 2048;
  const gridOk = d.cols * d.cellWidth === tex.width && d.rows * d.cellHeight === tex.height;
  const previewLabel = b.label || b.id;
  const sourceBadge = b.isWorkbenchCandidate
    ? '<span class="pill under_review">工作台 H 候选 · 未发布</span>'
    : '<span class="pill published">已发布</span>';
  const candidateOrigin = b.isWorkbenchCandidate
    ? `<div class="kv"><span class="k">工作区版本</span><span class="v mono">${escapeHtml(b.revisionId)}</span></div>`
    : '';
  $('info').innerHTML = `
    <div class="card"><h2 style="margin:0 0 6px">${escapeHtml(previewLabel)} ${sourceBadge}</h2>
      ${candidateOrigin}
      <div class="kv"><span class="k">图集</span><span class="v mono">${tex.width}×${tex.height} <span class="pill ${atlasOk ? 'ok' : 'no'}">${atlasOk ? '≤2K' : '>2K!'}</span></span></div>
      <div class="kv"><span class="k">网格</span><span class="v mono">${d.cols}×${d.rows} <span class="pill ${gridOk ? 'ok' : 'no'}">${gridOk ? '匹配' : '不匹配'}</span></span></div>
      <div class="kv"><span class="k">单格 cell</span><span class="v mono">${d.cellWidth}×${d.cellHeight}</span></div>
      <div class="kv"><span class="k">总帧</span><span class="v mono">${d.atlasFrames?.length ?? '—'}</span></div>
      <div class="kv"><span class="k">世界尺寸</span><span class="v mono">${d.worldWidth}×${d.worldHeight}</span></div>
      <div class="kv"><span class="k">像素/世界</span><span class="v mono">${(d.cellWidth / d.worldWidth).toFixed(2)} × ${(d.cellHeight / d.worldHeight).toFixed(2)}</span></div>
      <div class="kv"><span class="k">状态数</span><span class="v mono">${Object.keys(d.states).length}</span></div>
    </div><div id="stateInfo"></div>`;
}
function renderStateInfo() {
  const el = document.getElementById('stateInfo'); if (!el || !curDef) return;
  const s = curDef.states[curState]; if (!s) return;
  const dur = (s.frames.length / (s.frameRate || 1)).toFixed(2);
  const rows = s.frames.map((slot: number, i: number) => {
    const box = curDef.atlasFrames?.[slot];
    return `<tr><td>${i}</td><td class="mono">${slot}</td><td class="mono">${slot % curDef.cols},${Math.floor(slot / curDef.cols)}</td><td class="mono">${box ? box.contentWidth + '×' + box.contentHeight : '—'}</td></tr>`;
  }).join('');
  el.innerHTML = `<div class="card"><h2 style="margin:0 0 6px">状态 · ${escapeHtml(curState)}</h2>
      <div class="kv"><span class="k">帧率</span><span class="v mono">${s.frameRate} fps</span></div>
      <div class="kv"><span class="k">循环</span><span class="v"><span class="pill ${s.loop ? 'ok' : 'no'}">${s.loop}</span></span></div>
      <div class="kv"><span class="k">帧数</span><span class="v mono">${s.frames.length}</span></div>
      <div class="kv"><span class="k">时长</span><span class="v mono">${dur}s</span></div>
      <table class="frames"><thead><tr><th>#</th><th>slot</th><th>col,row</th><th>content</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

// ---------- compare ----------
function fillCompareChars() {
  const sel = $('cmpChar') as HTMLSelectElement; const prev = sel.value;
  sel.replaceChildren(...bundles.filter((b) => b.summary?.valid).map((bundle) => {
    const option = document.createElement('option'); option.value = bundle.id; option.textContent = bundle.id; return option;
  }));
  if (prev) sel.value = prev;
}
async function loadCompareB() {
  const on = ($('cmp') as HTMLInputElement).checked;
  ($('cmpChar') as HTMLElement).style.display = on ? '' : 'none';
  ($('cmpState') as HTMLElement).style.display = on ? '' : 'none';
  if (entityB) { world.removeChild(entityB.container); entityB.destroy(); entityB = null; }
  if (!on) { if (entity) entity.x = 0; return; }
  const id = ($('cmpChar') as HTMLSelectElement).value; const b = bundles.find((x) => x.id === id); if (!b) return;
  const raw = await fetch(versionedUrl(b.animUrl, b.animMtime)).then((r) => r.json());
  atlasTexB = await Assets.load(versionedUrl(b.atlasUrl, b.atlasMtime));
  curDefB = normalizeAnimationSetDef(raw, atlasTexB!.width, atlasTexB!.height);
  entityB = new SpriteEntity(); entityB.loadFromDef(atlasTexB!, curDefB);
  const sel = $('cmpState') as HTMLSelectElement;
  sel.replaceChildren(...Object.keys(curDefB.states).map((state) => {
    const option = document.createElement('option'); option.value = state; option.textContent = state; return option;
  }));
  const st = curDefB.states[curState] ? curState : Object.keys(curDefB.states)[0];
  sel.value = st; entityB.playAnimation(st); entityB.setDirection(facing, 0);
  const off = (curDef.worldWidth + curDefB.worldWidth) * 0.6;
  if (entity) entity.x = -off / 2; entityB.x = off / 2; entityB.y = 0;
  world.addChild(entityB.container);
}

// ---------- atlas inspector ----------
function openAtlas() {
  if (!atlasTex || !curDef) return;
  $('atlasModal').style.display = 'block';
  const canvas = $('atlasCanvas') as HTMLCanvasElement;
  const W = atlasTex.width, H = atlasTex.height; canvas.width = W; canvas.height = H;
  const g = canvas.getContext('2d')!;
  const src: any = (atlasTex.source as any).resource;
  try { g.drawImage(src, 0, 0, W, H); } catch { g.fillStyle = '#222'; g.fillRect(0, 0, W, H); }
  g.lineWidth = 1; g.strokeStyle = 'rgba(80,140,255,.45)';
  for (let c = 0; c <= curDef.cols; c++) { g.beginPath(); g.moveTo(c * curDef.cellWidth, 0); g.lineTo(c * curDef.cellWidth, H); g.stroke(); }
  for (let r = 0; r <= curDef.rows; r++) { g.beginPath(); g.moveTo(0, r * curDef.cellHeight); g.lineTo(W, r * curDef.cellHeight); g.stroke(); }
  g.strokeStyle = 'rgba(52,211,153,.95)'; g.lineWidth = 2;
  for (const slot of curDef.states[curState].frames) {
    const col = slot % curDef.cols, row = Math.floor(slot / curDef.cols);
    g.strokeRect(col * curDef.cellWidth + 1, row * curDef.cellHeight + 1, curDef.cellWidth - 2, curDef.cellHeight - 2);
  }
  $('atlasMeta').textContent = ` ${W}×${H} · 网格 ${curDef.cols}×${curDef.rows} · cell ${curDef.cellWidth}×${curDef.cellHeight} · 绿框=当前状态「${curState}」`;
}

// ---------- GIF export ----------
async function exportGif() {
  if (!entity || !curState) return;
  toast('导出 GIF 中…');
  const wasPlaying = playing;
  const previousFrame = entity.getFrameIndex();
  const overlayWasVisible = overlay.visible;
  try {
    const { GIFEncoder, quantize, applyPalette } = await import('gifenc');
    const seq = curDef.states[curState].frames;
    const fps = curDef.states[curState].frameRate || 8;
    setPlaying(false);
    const W = app.renderer.width, H = app.renderer.height;
    const off = document.createElement('canvas'); off.width = W; off.height = H;
    const octx = off.getContext('2d')!;
    const gif = GIFEncoder();
    overlay.visible = false;
    for (let i = 0; i < seq.length; i++) {
      entity.setFrameIndex(i); driveLighting(); drawOnion(); world.scale.set(zoom);
      app.renderer.render(app.stage);
      const canvas: HTMLCanvasElement = (app.renderer.extract as any).canvas(app.stage);
      octx.clearRect(0, 0, W, H); octx.drawImage(canvas, 0, 0);
      const { data } = octx.getImageData(0, 0, W, H);
      const palette = quantize(data, 256);
      const index = applyPalette(data, palette);
      gif.writeFrame(index, W, H, { palette, delay: Math.round(1000 / fps) });
    }
    gif.finish();
    const blob = new Blob([gif.bytes()], { type: 'image/gif' });
    const anchor = document.createElement('a'); anchor.href = URL.createObjectURL(blob);
    anchor.download = `${current.id}_${curState}.gif`; anchor.click(); URL.revokeObjectURL(anchor.href);
    toast('GIF 已导出');
  } catch (error: any) {
    toast(`GIF 导出失败: ${error?.message || error}`);
  } finally {
    overlay.visible = overlayWasVisible;
    entity.setFrameIndex(previousFrame);
    onionRenderKey = '';
    setPlaying(wasPlaying);
  }
}

// ---------- controls ----------
function setPlaying(p: boolean) { playing = p; $('btnPlay').textContent = p ? '⏸ 暂停' : '▶ 播放'; entity?.setPlaying(p); }
function fitZoom() {
  if (!curDef || !app) return;
  setPreviewZoom((app.renderer.height * 0.55) / curDef.worldHeight);
  world.scale.set(zoom); applyPlacement();
}
function bindControls() {
  $('btnPlay').onclick = () => setPlaying(!playing);
  $('btnLoop').onclick = () => { loopOverride = !loopOverride; $('btnLoop').classList.toggle('on', loopOverride); };
  $('btnLoop').classList.add('on');
  $('btnPrev').onclick = () => { setPlaying(false); entity?.setFrameIndex(entity.getFrameIndex() - 1); };
  $('btnNext').onclick = () => { setPlaying(false); entity?.setFrameIndex(entity.getFrameIndex() + 1); };
  $('btnFacing').onclick = () => { facing = facing === 1 ? -1 : 1; entity?.setDirection(facing, 0); entityB?.setDirection(facing, 0); };
  $('btnFit').onclick = () => fitZoom();
  const tl = $('timeline') as HTMLInputElement;
  tl.oninput = () => { scrubbing = true; setPlaying(false); entity?.setFrameIndex(parseInt(tl.value)); };
  tl.onchange = () => { scrubbing = false; };
  const sp = $('speed') as HTMLInputElement;
  sp.oninput = () => { speed = parseFloat(sp.value); $('speedV').textContent = speed.toFixed(1) + '×'; };
  ($('fps') as HTMLInputElement).onchange = (e) => { if (curDef && curState) curDef.states[curState].frameRate = Math.max(1, parseInt((e.target as HTMLInputElement).value) || 8); renderStateInfo(); };
  const zm = $('zoom') as HTMLInputElement; zm.oninput = () => { zoom = parseFloat(zm.value); world.scale.set(zoom); applyPlacement(); };
  ($('stateSel') as HTMLSelectElement).onchange = (e) => selectState((e.target as HTMLSelectElement).value);
  const bgSel = $('bg') as HTMLSelectElement, sceneSel = $('sceneBg') as HTMLSelectElement;
  bgSel.onchange = () => {
    sceneSel.style.display = bgSel.value === 'scene' ? '' : 'none';
    if (bgSel.value === 'scene' && sceneList.length) loadScene(sceneList[parseInt(sceneSel.value) || 0]);
    else { curScene = null; layout(); }
  };
  sceneSel.onchange = () => loadScene(sceneList[parseInt(sceneSel.value) || 0]);
  ($('pdm') as HTMLInputElement).onchange = (e) => entity?.setPixelDensityMatchActive((e.target as HTMLInputElement).checked);
  ($('search') as HTMLInputElement).oninput = () => renderCharList();
  ($('lightOn') as HTMLInputElement).onchange = () => applyLightingAttach();
  ($('lAmb') as HTMLInputElement).onchange = () => rebuildLighting();
  $('btnAtlas').onclick = () => openAtlas();
  $('atlasClose').onclick = () => { $('atlasModal').style.display = 'none'; };
  $('btnLight').onclick = () => { $('lightModal').style.display = 'flex'; };
  $('lightClose').onclick = () => { $('lightModal').style.display = 'none'; };
  $('lightModal').onclick = (e) => { if (e.target === $('lightModal')) $('lightModal').style.display = 'none'; };
  $('btnGif').onclick = () => exportGif();
  ($('cmp') as HTMLInputElement).onchange = () => loadCompareB();
  ($('cmpChar') as HTMLSelectElement).onchange = () => loadCompareB();
  ($('cmpState') as HTMLSelectElement).onchange = () => { const s = ($('cmpState') as HTMLSelectElement).value; entityB?.playAnimation(s); };
  window.addEventListener('workbench-page-change', (event) => {
    const pageId = (event as CustomEvent<{ pageId?: string }>).detail?.pageId;
    syncPreviewPageActivity(pageId === 'previewPage');
  });
  window.addEventListener('keydown', (e) => {
    if (!document.getElementById('previewPage')?.classList.contains('active')) return;
    const target = e.target instanceof HTMLElement ? e.target : null;
    if (target && (target.matches('input,select,textarea,button') || target.isContentEditable || target.closest('[contenteditable="true"]'))) return;
    if (e.key === ' ') { e.preventDefault(); setPlaying(!playing); }
    else if (e.key === 'ArrowLeft') { setPlaying(false); entity?.setFrameIndex(entity.getFrameIndex() - 1); }
    else if (e.key === 'ArrowRight') { setPlaying(false); entity?.setFrameIndex(entity.getFrameIndex() + 1); }
  });
}
function bindLiveRefresh() {
  const hot = (import.meta as any).hot; if (!hot) return;
  hot.on('anim:changed', async (p: any) => {
    const prevId = current?.id; await loadIndex();
    if (prevId && p?.id === prevId) { const b = bundles.find((x) => x.id === prevId); if (b) { toast(`热重载 ${prevId} (${p.kind})`); await selectChar(b); } }
    else if (p?.kind === 'add') toast(`发现新动画: ${p.id}`);
  });
}
let toastTimer: any;
function toast(msg: string) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2200); }

async function main() {
  await initPixi(); bindControls(); bindLiveRefresh(); await loadIndex(); await loadScenes();
  previewRuntimeReady = true;
  if (candidateBundle) {
    await selectChar(candidateBundle);
    return;
  }
  const want = new URLSearchParams(location.search).get('char');
  const b = bundles.find((x) => x.id === want) || bundles.find((x) => x.summary?.valid);
  if (b) await selectChar(b);
}
installWorkbenchPreviewBridge();
main();
