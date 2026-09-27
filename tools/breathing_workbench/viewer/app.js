/* 呼吸工作台页面。
 *
 * 模拟 / 参数表 / 资产解析 / uniform 换算 / 呼吸声全部来自 `/gen/breathing.bundle.js`(运行时 TS 原样打包)——页面里没有第二份模拟。
 * **这里也没有着色器**:画布上是游戏同一个 WebGPU 渲染器(engine2d / RHI,经工作台 RHI 接入层 `S.rt.workbenchRhi`),
 * 画面由包里的 `S.rt.breathingView.BreathingStage` 用游戏自己的呼吸图 Mesh(`breathingShade.wgsl`)拼;贴图与游戏同一条 `Assets.load`。
 * 出片 = 同一个舞台画进成品尺寸的离屏渲染纹理、异步回读(`S.rt.offscreenReadback`,自上而下)。
 * 宿主拿不到 WebGPU 就明确说画不了,**不回落**任何别的 API;调参、剧情、保存、推给游戏照常。
 * 这里只管:界面、剧情时间轴的播放、出片的逐帧推进、与服务端 / 游戏的往来。 */
'use strict';

const $ = (id) => document.getElementById(id);
async function api(path, body) {
  const init = body === undefined ? { cache: 'no-store' } : { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const r = await fetch(path, init);
  let j = null;
  try { j = await r.json(); } catch (e) { throw new Error(`HTTP ${r.status}`); }
  if (!j || j.ok === false) throw new Error((j && j.err) || `HTTP ${r.status}`);
  return j;
}
const clone = (v) => JSON.parse(JSON.stringify(v));

const S = {
  rt: null, boot: null, list: [], id: '', disk: null, doc: null, def: null, check: null, stories: [],
  perf: null, host: null, stage: null, gpu: { ok: false, err: '' }, texUrls: [], ready: false,
  speed: 1, paused: false, compare: false, muted: false, hist: [], last: 0,
  run: null, rendering: false, audio: null, synth: null,
  livePush: false, pushTimer: null, link: null, renderDir: '', renderMeta: null,
};
window.__bw = S;   // 自检脚本读状态用

// ---------------------------------------------------------------- 运行时包
async function loadRuntime() {
  S.rt = await import('/gen/breathing.bundle.js');
}
const groups = () => S.rt.breathingParams.BREATHING_PARAM_GROUPS;
const defs = () => S.rt.breathingParams.BREATHING_PARAM_DEFS;
const decimals = (step) => (step < 0.1 ? 2 : step < 1 ? 1 : 0);
const fmt = (d, v) => String(+Number(v).toFixed(decimals(d.step))) + (d.unit ? ' ' + d.unit : '');
function workingParams() {
  const out = S.rt.breathingParams.defaultBreathingParams();
  return S.rt.breathingParams.mergeBreathingParams(out, S.doc ? S.doc.params : {}).params;
}
function diskParams() {
  const out = S.rt.breathingParams.defaultBreathingParams();
  return S.rt.breathingParams.mergeBreathingParams(out, S.disk ? S.disk.params : {}).params;
}
function newPerf() {
  const p = new S.rt.BreathingPerformance.BreathingPerformance(workingParams(), S.def.rig.limits);
  return p;
}

// ---------------------------------------------------------------- GPU(游戏同一个 WebGPU 渲染器 + 呼吸图 Mesh)
async function initGpu() {
  try {
    S.host = await S.rt.workbenchRhi.createCanvasHost($('gl'), { background: 0x000000 });
    S.stage = new S.rt.breathingView.BreathingStage();
    S.gpu = { ok: true, err: '' };
  } catch (e) {
    S.gpu = { ok: false, err: `画面预览画不了:${(e && e.message) || e}(调参、剧情、保存、推给游戏照常)` };
  }
}
function loadImg(url) { return S.rt.workbenchRhi.loadTexture(url).catch((e) => { throw new Error(`读不到 ${url}:${(e && e.message) || e}`); }); }
async function loadLayers() {
  const def = S.def, L = def.layers;
  const urls = [L.base, L.body, L.sheet, L.flap].filter(Boolean);
  const [base, body, sheet, flap, bin] = await Promise.all([
    loadImg(L.base), L.body ? loadImg(L.body) : null, L.sheet ? loadImg(L.sheet) : null, L.flap ? loadImg(L.flap) : null,
    fetch(def.fields.file, { cache: 'no-store' }).then((r) => { if (!r.ok) throw new Error('读不到位移场 ' + def.fields.file); return r.arrayBuffer(); }),
  ]);
  // 先让舞台换上新图(旧的 mesh / 位移场随之拆掉),再放掉新图里不再用的旧贴图(绑定已销毁的纹理 = 那一帧抛错)
  S.stage.setAsset({ size: def.size, rig: def.rig, fields: def.fields, fieldBytes: bin, base, body, sheet, flap });
  for (const u of S.texUrls) if (!urls.includes(u)) void S.rt.workbenchRhi.unloadTexture(u);
  S.texUrls = urls;
}
function stageInput() {
  const p = S.perf;
  return { frame: p.frame(), vent: p.p('vent'), cran: p.p('cran'), inflate: p.p('inflate'), sink: p.p('sink') };
}
/** 这一帧的每帧 uniform 推给舞台(按住看原图 = 静止帧) */
function syncStage() {
  if (S.compare) S.stage.apply(S.rt.breathingView.REST_UNIFORMS);
  else S.stage.applyFrame(stageInput());
}
/** 画到画布(预览):屏 = 画布的 CSS 尺寸 */
function draw() {
  if (!S.gpu.ok || !S.def) return;
  const scr = S.host.renderer.screen;
  S.stage.layout(scr.width, scr.height);
  syncStage();
  try {
    S.host.render(S.stage.root);
    if (S.host.lastError) S.gpu.err = `GPU:${S.host.lastError}`;
  } catch (e) {
    S.gpu.err = `这一帧画坏了:${(e && e.message) || e}`;
  }
}
/** 画进离屏目标(出片 / 自检):屏 = 目标像素;返回异步回读(自上而下 RGBA8) */
function capture(target) {
  S.stage.layout(target.width, target.height);
  syncStage();
  return target.capture(S.stage.root);
}
function resizeCanvas() {
  const c = $('gl'), r = c.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (S.gpu.ok && r.width > 1 && r.height > 1) {
    // 画布像素不超过图本身的宽(与以前同一个上限)
    const res = Math.max(0.25, Math.min(dpr, S.def ? S.def.size[0] / r.width : dpr));
    const scr = S.host.renderer.screen;
    if (Math.abs(scr.width - r.width) > 0.01 || Math.abs(scr.height - r.height) > 0.01 || S.host.renderer.resolution !== res) S.host.resize(r.width, r.height, res);
  }
  const tr = $('trace'), tb = tr.getBoundingClientRect();
  const tw = Math.max(2, Math.round(tb.width * dpr)), th = Math.max(2, Math.round(tb.height * dpr));
  if (tr.width !== tw || tr.height !== th) { tr.width = tw; tr.height = th; }
}

// ---------------------------------------------------------------- 声音
function ensureAudio() {
  if (S.audio) { if (S.audio.state === 'suspended') S.audio.resume(); return; }
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  S.audio = new Ctx();
  S.synth = S.rt.breathSynth.createBreathSynth(S.audio, S.audio.destination);
}
document.addEventListener('pointerdown', () => { if (S.rt) ensureAudio(); }, { capture: true });

// ---------------------------------------------------------------- 推进
function tick(dt) {
  if (!S.perf) return;
  S.perf.step(dt);
  storyTick();
}
function frameLoop(ts) {
  const real = Math.min(0.05, S.last ? (ts - S.last) / 1000 : 0.016);
  S.last = ts;
  if (S.ready && !S.rendering) {
    if (!S.paused) tick(real * S.speed);
    resizeCanvas();
    draw();
    const f = S.perf.frame();
    if (S.synth) S.synth.update(S.paused ? 0 : f.flow, S.paused || S.muted ? 0 : S.perf.p('volume'));
    const mm = f.paperMm;
    if (!S.hist.length || S.perf.time() > S.hist[S.hist.length - 1].t) S.hist.push({ t: S.perf.time(), v: f.chest, mm, kind: f.kind });
    while (S.hist.length && S.perf.time() - S.hist[0].t > 10.5) S.hist.shift();
    $('stageState').textContent = `${f.phase || '—'}　胸口 ${f.chest.toFixed(2)}　纸 ${mm >= 0 ? '+' : ''}${mm.toFixed(1)} mm　垂帘 ${f.flapDeg >= 0 ? '+' : ''}${f.flapDeg.toFixed(1)}°` + (S.paused ? '　[暂停]' : S.speed !== 1 ? `　[${S.speed}×]` : '');
    drawTrace();
  }
  requestAnimationFrame(frameLoop);
}
function drawTrace() {
  const c = $('trace'), ctx = c.getContext('2d'), w = c.width, h = c.height, css = getComputedStyle(document.documentElement);
  const col = (n) => css.getPropertyValue(n).trim();
  ctx.clearRect(0, 0, w, h);
  const now = S.perf.time(), X = (t) => (1 - (now - t) / 10) * w;
  for (let i = 0; i + 1 < S.hist.length; i++) {
    const k = S.hist[i].kind; if (k !== 'in' && k !== 'ex' && k !== 'gasp') continue;
    const x0 = X(S.hist[i].t), x1 = X(S.hist[i + 1].t); if (x1 < 0) continue;
    ctx.fillStyle = col(k === 'ex' ? '--band-ex' : '--band-in'); ctx.fillRect(Math.max(0, x0), 0, x1 - Math.max(0, x0) + 0.5, h);
  }
  const lane1 = [h * 0.06, h * 0.44], mid = h * 0.73, half = h * 0.24;
  ctx.strokeStyle = col('--line'); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, lane1[1]); ctx.lineTo(w, lane1[1]); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();
  const vmax = Math.max(1.4, S.perf.p('sighDepth') / 100 * 1.05, S.perf.p('gaspChest') / 100 * 1.05);
  const pmax = Math.max(S.perf.p('inflate'), S.perf.p('sink'), S.perf.p('upLimit') * 0.8, 4);
  const lw = Math.max(1.5, w / 600);
  const line = (key, color, yOf) => {
    ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.beginPath(); let started = false;
    for (const s of S.hist) { const x = X(s.t); if (x < 0) continue; const y = yOf(s[key]); if (started) ctx.lineTo(x, y); else { ctx.moveTo(x, y); started = true; } }
    ctx.stroke();
  };
  line('v', col('--fg'), (v) => lane1[1] - Math.min(v / vmax, 1.2) * (lane1[1] - lane1[0]));
  line('mm', col('--accent'), (m) => mid - (m / pmax) * half);
}

// ---------------------------------------------------------------- 剧情时间轴(对话图里那一段,原样演)
function startStory(story, auto) {
  if (!story) return;
  S.run = { steps: story.steps, i: 0, block: null, visible: false, line: null, ended: false, endAt: null, auto: auto || null,
    lineShownAt: 0, inhales: 0, lastKind: '', firstLineDone: false };
  S.perf = newPerf();
  S.hist = [];
  $('stage').classList.add('story');
  setVisible(false);
}
function stopStory() {
  S.run = null;
  $('dlg').hidden = true;
  $('stage').classList.remove('story');
  setVisible(true);
  S.perf = newPerf();
  S.hist = [];
}
function setVisible(v) { $('gl').style.visibility = v ? 'visible' : 'hidden'; if (S.run) S.run.visible = v; }
function showLine(step) {
  S.run.line = { speaker: step.speaker, text: step.text };
  S.run.lineShownAt = S.perf.time();
  $('dlgWho').textContent = step.speaker; $('dlgText').textContent = step.text; $('dlg').hidden = false;
}
function advanceLine() {
  if (!S.run || !S.run.line) return;
  S.run.line = null; S.run.firstLineDone = true;
  $('dlg').hidden = true;
  S.run.i++;
}
function storyTick() {
  const R = S.run;
  if (!R || R.ended) return;
  const f = S.perf.frame();
  if (f.kind === 'in' && R.lastKind !== 'in') R.inhales++;
  R.lastKind = f.kind;
  for (let guard = 0; guard < 64; guard++) {
    if (R.line) {
      // 出片时自动点:第一句等「深叹 + 正常 n 口」之后下一口开头;其余按秒
      if (R.auto) {
        if (!R.firstLineDone ? R.inhales >= R.auto.breaths + 2 : S.perf.time() - R.lineShownAt >= R.auto.readSec) advanceLine();
      }
      if (R.line) return;
      continue;
    }
    if (R.block) {
      if (R.block.until !== undefined && S.perf.time() < R.block.until) return;
      if (R.block.doneFn && !R.block.doneFn()) return;
      R.block = null;
      R.i++;
      continue;
    }
    if (R.i >= R.steps.length) {
      if (R.endAt === null) R.endAt = S.perf.time() + 1;
      if (S.perf.time() >= R.endAt) { R.ended = true; if (!R.auto) setTimeout(stopStory, 0); }
      return;
    }
    const st = R.steps[R.i];
    switch (st.kind) {
      case 'show': S.perf.restart(); R.inhales = 0; R.lastKind = ''; setVisible(true); R.i++; break;
      case 'line': showLine(st); return;
      case 'perform': {
        let pr = null;
        if (st.act === 'fadeOut') pr = S.perf.fadeOut();
        else if (st.act === 'gasp') pr = S.perf.gasp();
        else if (st.act === 'breathe') S.perf.breathe();
        else if (st.act === 'stopNow') S.perf.stopNow();
        else if (st.act === 'restart') S.perf.restart();
        // 等「渐弱走完 / 猛吸结束」:逐帧轮询表演自己的判据(出片是同步逐帧推的,不能靠 Promise 的微任务时机)
        if (st.wait && pr) { R.block = { doneFn: st.act === 'fadeOut' ? () => S.perf.isSettled() : () => S.perf.isGaspDone() }; return; }
        R.i++;
        break;
      }
      case 'params': S.perf.setParams(st.params || {}, Math.max(0, st.durationMs || 0) / 1000); R.i++; break;
      case 'wait': case 'black': R.block = { until: S.perf.time() + Math.max(0, st.ms || 0) / 1000 }; return;
      case 'hide': setVisible(false); R.i++; break;
      default: R.i++;
    }
  }
}
$('stage').addEventListener('click', () => { if (S.run && !S.run.auto) advanceLine(); });
$('dlg').addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); if (S.run && !S.run.auto) advanceLine(); } });

// ---------------------------------------------------------------- 参数面板
const UI = {};
function buildParams() {
  const box = $('params');
  box.innerHTML = '';
  for (const g of groups()) {
    const det = document.createElement('details');
    det.className = 'grp'; det.open = !['gasp', 'fade', 'sound'].includes(g.id);
    det.innerHTML = `<summary>${g.title}${g.note ? `<small>${g.note}</small>` : ''}</summary><div class="sliders"></div>`;
    const sl = det.querySelector('.sliders');
    for (const d of g.params) {
      const el = document.createElement('div');
      el.className = 'sl';
      el.innerHTML = `<label for="sl_${d.key}" title="双击恢复盘上的值">${d.label}</label><output></output>`
        + `<input id="sl_${d.key}" data-key="${d.key}" type="range" min="${d.min}" max="${d.max}" step="${d.step}">` + (d.hint ? `<small>${d.hint}</small>` : '');
      sl.appendChild(el);
      const inp = el.querySelector('input'), out = el.querySelector('output');
      UI[d.key] = { inp, out, d };
      inp.addEventListener('input', () => setParam(d.key, parseFloat(inp.value)));
      el.querySelector('label').addEventListener('dblclick', () => setParam(d.key, diskParams()[d.key]));
    }
    if (g.id === 'rhythm') { const dv = document.createElement('div'); dv.className = 'hint'; dv.id = 'derivedRate'; sl.appendChild(dv); }
    box.appendChild(det);
  }
}
function syncParamsUI(force) {
  if (!S.doc) return;
  const wp = workingParams(), dp = diskParams();
  for (const [k, u] of Object.entries(UI)) {
    if (force || parseFloat(u.inp.value) !== wp[k]) u.inp.value = wp[k];
    u.out.textContent = fmt(u.d, wp[k]);
    u.out.classList.toggle('chg', Math.abs(wp[k] - dp[k]) > 1e-9);
  }
  const per = wp.ti + wp.te + wp.tp;
  const dr = $('derivedRate'); if (dr) dr.textContent = `一口 ${per.toFixed(2)} s = 每分钟 ${(60 / per).toFixed(1)} 口`;
  if (document.activeElement !== $('ptext')) $('ptext').value = paramText();
  const dirty = isDirty();
  $('bSave').classList.toggle('dirty', dirty);
  $('saveNote').textContent = dirty ? '有没导出的改动' : '';
}
function setParam(k, v) {
  if (!S.doc || !Number.isFinite(v)) return;
  const d = defs().get(k);
  const val = Math.min(d.max, Math.max(d.min, v));
  S.doc.params = Object.assign({}, S.doc.params, { [k]: val });
  if (S.perf) S.perf.setParams({ [k]: val });
  syncParamsUI(false);
  if (S.livePush) schedulePush();
}
function isDirty() { return !!(S.doc && S.disk && JSON.stringify(S.doc) !== JSON.stringify(S.disk)); }
function paramText() {
  const wp = workingParams(), dp = diskParams();
  const changed = [...defs().keys()].filter((k) => Math.abs(wp[k] - dp[k]) > 1e-9);
  const lines = [`呼吸图参数(${S.id})`, '【改过的】' + (changed.length ? changed.map((k) => `${defs().get(k).label} = ${fmt(defs().get(k), wp[k])}`).join(';') : '(没改,都是盘上的值)')];
  for (const g of groups()) lines.push(`${g.title}:` + g.params.map((d) => `${d.label} = ${fmt(d, wp[d.key])}`).join(';'));
  return lines.join('\n');
}
function applyText(txt) {
  const byLabel = {}; for (const [k, d] of defs()) byLabel[d.label] = k;
  let n = 0; const unknown = [];
  for (const chunk of txt.split(/[\n;;]+/)) {
    const eq = chunk.indexOf('='); if (eq < 0) continue;
    let left = chunk.slice(0, eq);
    left = left.slice(Math.max(left.lastIndexOf(':'), left.lastIndexOf('】'), left.lastIndexOf(':')) + 1).trim();
    const v = parseFloat(chunk.slice(eq + 1));
    const k = byLabel[left];
    if (!k || !Number.isFinite(v)) { if (left) unknown.push(left); continue; }
    const d = defs().get(k);
    S.doc.params = Object.assign({}, S.doc.params, { [k]: Math.min(d.max, Math.max(d.min, v)) }); n++;
  }
  if (S.perf) S.perf.setParams(S.doc.params);
  syncParamsUI(true);
  if (S.livePush) schedulePush();
  return { applied: n, unknown };
}

// ---------------------------------------------------------------- 资产
async function openAsset(id) {
  if (S.doc && id !== S.id && isDirty() && !confirm(`「${S.id}」的参数改了没导出,切过去就丢了。继续?`)) { $('assetSel').value = S.id; return; }
  const j = await api(`/api/breathing/doc?id=${encodeURIComponent(id)}`);
  const def = S.rt.breathingOverlays.resolveBreathingOverlay(j.doc, id);
  S.id = id; S.disk = j.doc; S.doc = clone(j.doc); S.check = j.check; S.stories = j.stories || [];
  $('assetSel').value = id;
  const errs = (j.check.errors || []).map((e) => `✗ ${e}`), warns = (j.check.warnings || []).map((w) => `⚠ ${w}`);
  if (def.error) errs.unshift(`✗ ${def.error}`);
  $('checkMsg').innerHTML = [...errs.map((e) => `<span class="err">${esc(e)}</span>`), ...warns.map((w) => `<span class="warn">${esc(w)}</span>`)].join('\n');
  $('assetInfo').textContent = `${j.doc.label || ''}　${(j.doc.size || []).join('×')}　${S.stories.length} 处在用`;
  const ss = $('storySel');
  ss.innerHTML = S.stories.length ? S.stories.map((s, i) => `<option value="${i}">${esc(s.graph)} · ${esc(s.handle)}(${s.lines} 句)</option>`).join('') : '<option value="">(没有对话图用到它)</option>';
  $('bStory').disabled = !S.stories.length; $('bRenderStory').disabled = !S.stories.length;
  if (def.error) { S.ready = false; $('stageMsg').textContent = def.error; $('stageMsg').hidden = false; return; }
  S.def = def;
  S.ready = false;
  $('stage').style.setProperty('--aspect', String(def.size[0] / def.size[1]));
  if (S.gpu.ok) {
    $('stageMsg').textContent = '加载分层图与位移场…'; $('stageMsg').hidden = false;
    try { await loadLayers(); } catch (e) { $('stageMsg').textContent = String(e.message || e); return; }
  }
  S.run = null; $('dlg').hidden = true; $('stage').classList.remove('story'); setVisible(true);
  S.perf = newPerf(); S.hist = [];
  syncParamsUI(true);
  // 没有 WebGPU:画面那块写明原因(不回落),其余照常
  $('stageMsg').textContent = S.gpu.ok ? '' : S.gpu.err;
  $('stageMsg').hidden = S.gpu.ok;
  S.ready = true;
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
async function save() {
  if (!S.doc) return false;
  try {
    const j = await api('/api/save', { doc: S.doc, base: S.disk });
    S.disk = j.doc; S.doc = clone(j.doc);
    syncParamsUI(true);
    $('saveNote').textContent = j.written ? `已导出到游戏:${j.path}` : '和盘上一样,没写';
    if (j.warnings && j.warnings.length) $('saveNote').textContent += '(' + j.warnings.join(';') + ')';
    return true;
  } catch (e) {
    $('saveNote').textContent = '导出失败:' + (e.message || e);
    return false;
  }
}
window.__unsavedSummary = () => (isDirty() ? `呼吸图「${S.id}」的参数改了还没导出到游戏` : '');
window.__saveUnsaved = () => { save().then((ok) => { window.__saveUnsavedResult = ok ? 'ok' : 'fail'; }); };
window.__openBreathing = (id) => { openAsset(id).catch((e) => { $('checkMsg').textContent = String(e.message || e); }); };
window.addEventListener('beforeunload', (ev) => { if (isDirty() && !window.__discardingUnsaved) { ev.preventDefault(); ev.returnValue = ''; } });
window.addEventListener('keydown', (ev) => { if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); save(); } });

// ---------------------------------------------------------------- 游戏联动
async function publish(probeAction) {
  if (!S.doc) return null;
  const body = { breathing: { [S.id]: S.doc } };
  if (probeAction) body.probe = { action: probeAction, target: S.id };
  try {
    const r = await api('/api/link/publish', body);
    $('linkStatus').dataset.note = r.notes ? r.notes.join(';') : '';
    return r;
  } catch (e) {
    $('linkStatus').dataset.note = '推不过去:' + (e.message || e);
    return null;
  }
}
function schedulePush() {
  clearTimeout(S.pushTimer);
  S.pushTimer = setTimeout(() => publish(null), 120);
}
async function pollLink() {
  try {
    const st = await api('/api/link/status');
    S.link = st;
    const el = $('linkStatus'), note = el.dataset.note || '';
    if (!st.connected) { el.innerHTML = `<span class="warn">游戏:连不上 ${esc(st.gameUrl)}</span>${note ? '　' + esc(note) : ''}`; }
    else if (!st.gameAlive) { el.innerHTML = `<span class="warn">游戏:dev server 在,没开着游戏页</span>${note ? '　' + esc(note) : ''}`; }
    else {
      const d = st.doc || {}, inst = (d.instances || []);
      const mine = inst.filter((i) => i.asset === S.id);
      el.innerHTML = `<span class="ok">游戏:已连接</span>　场景 ${esc(d.sceneId || '—')}　`
        + (mine.length ? mine.map((i) => `「${esc(i.handle)}」${esc(i.phase || i.mode)} 胸口 ${i.chest} 纸 ${i.paperMm} mm`).join(';') : '没显示着这张图')
        + (note ? '　' + esc(note) : '');
    }
  } catch (e) { /* 服务自己挂了才会到这 */ }
  setTimeout(pollLink, 1000);
}

// ---------------------------------------------------------------- 出片(同一份模拟与游戏同一份渲染逐帧画进离屏纹理、异步读回、送给服务端拼)
async function renderFrames(kind, fps, stepFn, metaFn, doneFn) {
  if (!S.gpu.ok) throw new Error(S.gpu.err || '没有 GPU 画面,出不了片');
  const def = S.def, w = def.size[0], h = def.size[1];
  // 先停住预览推进,再等服务端:以前 S.rendering 在 begin 回来之后才置上,等的那几帧里 rAF 照常按真实时间推这条表演,
  // 成片的起点随请求快慢漂(实测一次漂了 0.067 s),同参数两次出片对不上
  S.rendering = true;
  const inflight = new Set();
  let target = null;
  try {
    const begin = await api('/api/render/begin', { kind, id: S.id, fps, width: w, height: h, paramsText: paramText() });
    // 成品尺寸的离屏渲染纹理:画第 i 帧 → 发读 i(拷贝当场排进 GPU 队列)→ 推进 → 画第 i+1 帧…;同时最多挂 4 帧在读 / 在传
    target = S.rt.offscreenReadback.createOffscreenTarget(S.host, w, h);
    const meta = [];
    for (let i = 0; i < 40000; i++) {
      if (doneFn(i)) break;
      meta.push(metaFn(i));
      const idx = i;
      const p = capture(target)
        .then((px) => fetch(`/api/render/frame?token=${begin.token}&i=${idx}`, { method: 'POST', body: px.data }))
        .then((r) => r.json()).then((j) => { if (!j.ok) throw new Error(j.err); });
      inflight.add(p); p.finally(() => inflight.delete(p)).catch(() => {});
      if (inflight.size >= 4) await Promise.race(inflight);
      if (i % 30 === 0) $('renderNote').textContent = `出片中… 第 ${i} 帧`;
      stepFn(i);
    }
    await Promise.all([...inflight]);
    $('renderNote').textContent = '拼成品中…';
    const fin = await api('/api/render/finish', { token: begin.token, meta: { fps, params: paramText(), frames: meta } });
    S.renderDir = fin.dir;
    S.renderMeta = meta;
    $('renderNote').textContent = `出好了(${fin.frames} 帧):${fin.files.join('、')}`;
    $('bReveal').hidden = false;
    return fin;
  } finally {
    await Promise.allSettled([...inflight]);
    if (target) target.destroy();
    S.rendering = false;
  }
}
async function renderLoop() {
  const saved = S.perf;
  const perf = newPerf();
  perf.setNoJitter(true); perf.skipFirstSigh();
  S.perf = perf;
  const per = perf.p('ti') + perf.p('te') + perf.p('tp');
  const N = Math.max(8, Math.round(per * 15)), dt = per / N;
  for (let k = 0; k < 4 * N; k++) perf.step(dt);
  try {
    return await renderFrames('loop', N / per, () => perf.step(dt),
      () => { const f = perf.frame(); return { t: +perf.time().toFixed(4), ph: f.phase, V: +f.chest.toFixed(4), mm: +f.paperMm.toFixed(3) }; },
      (i) => i >= N);
  } finally { S.perf = saved; }
}
async function renderStory() {
  const story = S.stories[Number($('storySel').value) || 0];
  if (!story) return null;
  const fps = 30;
  startStory(story, { breaths: Math.max(0, Number($('rBreaths').value) || 0), readSec: Math.max(0.5, Number($('rRead').value) || 2.5) });
  try {
    return await renderFrames('story', fps, () => tick(1 / fps),
      () => { const f = S.perf.frame(); const R = S.run; return { t: +S.perf.time().toFixed(4), ph: f.phase, V: +f.chest.toFixed(4), mm: +f.paperMm.toFixed(3), black: R.visible ? 0 : 1, line: R.line ? { ...R.line } : null }; },
      () => !S.run || S.run.ended);
  } finally { stopStory(); }
}

// ---------------------------------------------------------------- 按钮
function bindButtons() {
  $('assetSel').addEventListener('change', () => openAsset($('assetSel').value).catch((e) => { $('checkMsg').textContent = String(e.message || e); }));
  $('bSave').onclick = () => save();
  $('bBreathe').onclick = () => { if (S.run) stopStory(); S.perf.breathe(); };
  $('bFade').onclick = () => { if (S.run) stopStory(); void S.perf.fadeOut(); };
  $('bGasp').onclick = () => { if (S.run) stopStory(); void S.perf.gasp(); };
  $('bStop').onclick = () => { if (S.run) stopStory(); S.perf.stopNow(); };
  $('bRestart').onclick = () => { if (S.run) stopStory(); S.perf.restart(); S.hist = []; };
  $('bStory').onclick = () => startStory(S.stories[Number($('storySel').value) || 0], null);
  const bp = $('bPause');
  bp.onclick = () => { S.paused = !S.paused; bp.setAttribute('aria-pressed', String(S.paused)); bp.textContent = S.paused ? '继续' : '暂停'; };
  $('bStep').onclick = () => { if (!S.paused) bp.onclick(); tick(1 / 15); };
  for (const b of document.querySelectorAll('button[data-speed]')) b.onclick = () => {
    S.speed = parseFloat(b.dataset.speed);
    for (const o of document.querySelectorAll('button[data-speed]')) o.setAttribute('aria-pressed', String(o === b));
  };
  const bc = $('bCompare');
  const on = () => { S.compare = true; }, off = () => { S.compare = false; };
  bc.addEventListener('pointerdown', on); bc.addEventListener('pointerup', off); bc.addEventListener('pointerleave', off);
  const bm = $('bMute');
  bm.onclick = () => { S.muted = !S.muted; bm.setAttribute('aria-pressed', String(S.muted)); };
  $('bPush').onclick = () => publish(null);
  $('livePush').addEventListener('change', (e) => { S.livePush = e.target.checked; if (S.livePush) publish(null); });
  $('bGameShow').onclick = () => publish('show');
  $('bGameHide').onclick = () => publish('hide');
  $('bGameRestart').onclick = () => publish('restart');
  $('bGameFade').onclick = () => publish('fadeOut');
  $('bGameGasp').onclick = () => publish('gasp');
  $('bLaunch').onclick = async () => {
    try { const r = await api('/api/link/launch', { sceneId: (S.boot && S.boot.initialScene) || '' }); $('linkStatus').dataset.note = r.message || ''; }
    catch (e) { $('linkStatus').dataset.note = '拉不起来:' + (e.message || e); }
  };
  $('bCopy').onclick = async () => {
    const t = paramText(); $('ptext').value = t;
    try { await navigator.clipboard.writeText(t); $('textNote').textContent = '已复制。'; }
    catch (e) { $('ptext').focus(); $('ptext').select(); $('textNote').textContent = '浏览器不让直接复制:已经全选,按 Ctrl+C。'; }
  };
  $('bApply').onclick = () => {
    const r = applyText($('ptext').value);
    $('textNote').textContent = `套用了 ${r.applied} 项` + (r.unknown.length ? `;认不出:${r.unknown.join('、')}` : '。');
    $('ptext').value = paramText();
  };
  $('bRevert').onclick = () => { S.doc.params = clone(S.disk.params || {}); S.perf.setParams(diskParams()); syncParamsUI(true); if (S.livePush) schedulePush(); };
  $('bRenderLoop').onclick = () => renderLoop().catch((e) => { $('renderNote').textContent = '出片失败:' + (e.message || e); });
  $('bRenderStory').onclick = () => renderStory().catch((e) => { $('renderNote').textContent = '出片失败:' + (e.message || e); });
  $('bReveal').onclick = () => api('/api/render/reveal', { path: S.renderDir }).catch(() => {});
}

// 自检脚本用的入口(页面是 module,函数不挂 window)
window.__bwApi = { startStory, stopStory, tick, renderLoop, renderStory, setParam, save, publish, openAsset, applyText, paramText, isDirty, draw, capture };

/** 浏览器冒烟(`tools/workbench_rhi/chrome_page.mjs --smoke`):拿到 WebGPU、这一帧画出了东西、GPU 没报错 */
window.__rhiSmoke = async () => {
  if (!S.gpu.ok) return { ok: false, detail: S.gpu.err || '没有 GPU 画面' };
  draw();
  const drawn = await S.host.countDrawnPixels();
  const size = [$('gl').width, $('gl').height];
  return { ok: drawn > 64 && !S.gpu.err && S.stage.ready, detail: { drawn, size, gpuErr: S.gpu.err, id: S.id } };
};

// ---------------------------------------------------------------- 启动
(async () => {
  try {
    S.boot = await api('/api/boot');
    if (!S.boot.bundle.ok) throw new Error('运行时模块打包失败:' + S.boot.bundle.err);
    await loadRuntime();
    await initGpu();
    buildParams();
    bindButtons();
    const L = await api('/api/breathing');
    S.list = L.breathing;
    $('assetSel').innerHTML = S.list.map((r) => `<option value="${esc(r.id)}">${esc(r.id)}${r.label ? ' · ' + esc(r.label) : ''}${r.error ? '(坏)' : ''}</option>`).join('');
    const first = S.boot.open || (S.list[0] && S.list[0].id);
    if (first) await openAsset(first);
    else $('stageMsg').textContent = '还没有呼吸图(由离线拆层工具烘出来)';
    requestAnimationFrame(frameLoop);
    pollLink();
    window.__ready = true;
  } catch (e) {
    $('stageMsg').textContent = String(e.message || e);
    $('stageMsg').hidden = false;
    window.__bootError = String(e.message || e);
  }
})();
