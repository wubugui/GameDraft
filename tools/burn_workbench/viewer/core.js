'use strict';
/* 燃烧工作台 · 页面公共层：状态 S、服务接口、撤销 / 重做、脏态、对话框（含选原画）、DOM 小工具。
 *
 * 硬契约（照粒子 / 轨迹台）：
 * - **本工作台是 `assets/data/burnables/`（可燃物模板）唯一的写入者**；写盘经服务端共享闸门
 *   `tools/editor/shared/burnables.py`（只收键序、不改数值）+ 原子写。**模板和场景没有关系**：谁用它写在宿主自己身上，
 *   这里不编辑宿主（场景视图只读）；只有改名时服务端跟着改宿主上的 `template` 值（一次事务）。
 * - **工作态**：`S.docs`（打开过的每份模板）。换模板 / 开关场景视图不丢改动；Ctrl+S 一次存所有改过的，
 *   只成功一部分时如实说哪份没存上、那份不清脏。
 * - **撤销 / 重做覆盖一切编辑**（字段、尺寸、握点与着火点拖动、涂层笔画）：快照 = 每份文档的 JSON 串，
 *   没变的那份复用上一个快照的同一个串（涂层 data URL 不跟着每一步复制一遍）。
 * - **只有真改了才标脏**（与盘上那份按键序无关的 JSON 比）；缺省容器只在写入闭包里补，渲染时不往文档里塞东西。
 * - 本文件与其余 viewer 脚本都是 classic script：顶层 `const S` 等是词法声明、不挂 window（自检里用裸标识符）。 */

const API = {
  async json(path, opts) {
    const r = await fetch(path, Object.assign({ cache: 'no-store' }, opts || {}));
    let j;
    try { j = await r.json(); } catch (e) { throw new Error(`${path}: 非 JSON 响应 (${r.status})`); }
    if (!j.ok) throw new Error(j.err || `${path}: ${r.status}`);
    return j;
  },
  post(path, body) {
    return API.json(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  },
  async bin(path) {
    const r = await fetch(path, { cache: 'no-store' });
    if (!r.ok) throw new Error(`${path}: ${r.status}`);
    return r.arrayBuffer();
  },
  image(path) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('图片装不上: ' + path));
      img.src = path;
    });
  },
};

const el = (id) => document.getElementById(id);
function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k === 'style') e.setAttribute('style', v);
    else if (k in e && typeof v !== 'string') e[k] = v;
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : String(c));
  return e;
}
function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
function canonJson(o) {
  const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
  return JSON.stringify(sortKeys(o));
}
function fmt(v, d = 2) { return Number.isFinite(v) ? v.toFixed(d) : '—'; }
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
/** 尺寸的写法：两位小数（与样例模板同精度）；不改作者手写的数，只在"跟着比例算出来"时用 */
function round2(v) { return Math.round(v * 100) / 100; }
/** 与共享闸门 `burnables.is_valid_id` 同一条：字母数字 _ - 与汉字 */
const ID_RE = /^[A-Za-z0-9_\-一-鿿]+$/;
function validId(s) { return typeof s === 'string' && s.length > 0 && s.length <= 120 && ID_RE.test(s); }

function status(msg, kind) {
  const e = el('status');
  e.textContent = msg || '';
  e.title = msg || '';
  e.className = kind || '';
}

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------
const S = {
  rt: null, rtErr: '', glsl: '', glslErr: '',
  boot: {},
  assets: [],
  /** 工作态模板 id → 文档；`clean` = 盘上那份的 canonJson；`base` = 盘上那份（保存时给服务端比"被别处改过没有"） */
  docs: {}, clean: {}, base: {},
  docId: '',
  /** 「用在哪」（当前模板的宿主引用，服务端扫全工程） */
  refs: [], refsFor: '', refsErr: '',
  /** 'art' 原画视图（主视图） | 'scene' 只读场景视图（从「用在哪」点开） */
  view: 'art',
  /** 场景视图：`{ scene, bgImg, entityId }`；没开 = null */
  sv: null, sceneOp: 0,
  player: null, presets: [], effects: [],
  /** 原画候选 `{images, used, worldSizes}` */
  images: { images: [], used: {}, worldSizes: {} },
  stance: { presetId: '', state: '', socket: '' },
  tool: 'select',
  brush: { size: 10, strength: 0.6, value: 1, erase: false },
  /** 选中的着火点 id；`selGrip` = 选中的是握点 */
  selPoint: '', selGrip: false,
  layers: { grid: true, fuel: true, mask: true, particles: true, lights: true, stances: true, ranges: true },
  /** 真实尺寸锁宽高比（按图；页面偏好，不写资源） */
  sizeLock: true,
  /** 原画视图的预览风（m/s + 往右 1 / 往左 -1；页面偏好，不写资源） */
  wind: { mps: 0, dir: 1 },
  dirty: false, dirtyIds: [],
  busy: 0, saving: null,
  stances: null, walk: null,
  link: { on: false, status: null, lastPub: 0, pushed: false, discarded: false, err: '', notes: [], walkPending: null, gameUrl: '' },
};

// ---------------------------------------------------------------------------
// 撤销 / 重做（快照：每份文档）
// ---------------------------------------------------------------------------
const HIST = { undo: [], redo: [], drag: null, limit: 300, last: null };

function snapshot() {
  const prev = HIST.last;
  const docs = {};
  for (const [id, d] of Object.entries(S.docs)) {
    const s = JSON.stringify(d);
    docs[id] = prev && prev.docs[id] === s ? prev.docs[id] : s;
  }
  const snap = { docs };
  HIST.last = snap;
  return snap;
}
function sameSnap(a, b) {
  const ka = Object.keys(a.docs), kb = Object.keys(b.docs);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (a.docs[k] !== b.docs[k]) return false;
  return true;
}
function applySnap(snap) {
  for (const [id, s] of Object.entries(snap.docs)) S.docs[id] = JSON.parse(s);
  HIST.last = snap;
}
/** 一次原子编辑。返回有没有真改了什么 */
function edit(label, fn) {
  if (HIST.drag) { fn(); afterEdit(); return true; }
  const before = snapshot();
  fn();
  const after = snapshot();
  if (sameSnap(before, after)) { afterEdit(true); return false; }
  pushHist({ label, before, after });
  afterEdit();
  return true;
}
function pushHist(e) {
  HIST.undo.push(e);
  if (HIST.undo.length > HIST.limit) HIST.undo.shift();
  HIST.redo.length = 0;
}
function beginDrag(label) { if (!HIST.drag) HIST.drag = { label, before: snapshot() }; }
function endDrag() {
  const d = HIST.drag; HIST.drag = null;
  if (!d) return false;
  const after = snapshot();
  if (sameSnap(d.before, after)) { afterEdit(true); return false; }
  pushHist({ label: d.label, before: d.before, after });
  afterEdit();
  return true;
}
function cancelDrag() {
  const d = HIST.drag; HIST.drag = null;
  if (d) { applySnap(d.before); afterEdit(); }
}
function undo() {
  if (HIST.drag) cancelDrag();
  const e = HIST.undo.pop();
  if (!e) { status('没有可撤销的', 'warn'); return null; }
  applySnap(e.before);
  HIST.redo.push(e);
  afterEdit();
  status(`撤销：${e.label}`);
  return e.label;
}
function redo() {
  if (HIST.drag) cancelDrag();
  const e = HIST.redo.pop();
  if (!e) { status('没有可重做的', 'warn'); return null; }
  applySnap(e.after);
  HIST.undo.push(e);
  afterEdit();
  status(`重做：${e.label}`);
  return e.label;
}
function clearHistory() { HIST.undo.length = 0; HIST.redo.length = 0; HIST.drag = null; HIST.last = null; }

/** 编辑之后：脏态、预览重建、左栏 / 检视器 / 视图、联动。`noop` = 什么都没变（只刷一下显示） */
function afterEdit(noop) {
  if (!noop) {
    refreshDirty();
    if (typeof onDocsChanged === 'function') onDocsChanged();
  }
}

// ---------------------------------------------------------------------------
// 脏态
// ---------------------------------------------------------------------------
function docDirty(id) { return !!S.docs[id] && canonJson(S.docs[id]) !== S.clean[id]; }
function refreshDirty() {
  S.dirtyIds = Object.keys(S.docs).filter(docDirty).sort();
  S.dirty = S.dirtyIds.length > 0;
  const b = el('btnSave');
  if (b) { b.classList.toggle('dirty', S.dirty); b.textContent = S.dirty ? '保存 ●' : '保存'; }
  document.title = `${S.dirty ? '● ' : ''}燃烧工作台${S.docId ? ` · ${S.docId}` : ''}${S.sv && S.sv.scene ? ` · 场景 ${S.sv.scene.id}（只读）` : ''}`;
  const u = el('btnUndo'), r = el('btnRedo');
  if (u) { u.disabled = !HIST.undo.length; u.title = HIST.undo.length ? `Ctrl+Z：${HIST.undo[HIST.undo.length - 1].label}` : 'Ctrl+Z'; }
  if (r) { r.disabled = !HIST.redo.length; r.title = HIST.redo.length ? `Ctrl+Y：${HIST.redo[HIST.redo.length - 1].label}` : 'Ctrl+Y'; }
}
/** 收下盘上的一份（打开 / 存完）：工作态与基线都换成它 */
function acceptDiskDoc(id, doc) {
  S.docs[id] = doc;
  S.base[id] = clone(doc);
  S.clean[id] = canonJson(doc);
  HIST.last = null;
}

// ---------------------------------------------------------------------------
// 装载门 / 对话框
// ---------------------------------------------------------------------------
function setBusy(on, text) {
  S.busy = Math.max(0, S.busy + (on ? 1 : -1));
  el('busy').hidden = S.busy === 0;
  el('busyText').textContent = text || '装载中…';
  if (S.busy > 0) el('app').setAttribute('inert', ''); else el('app').removeAttribute('inert');
}
function commitFocusedInput() {
  const ae = document.activeElement;
  if (ae && ae !== document.body && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) && typeof ae.blur === 'function') ae.blur();
}
function isTypingTarget(t) {
  if (!t) return false;
  if (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
  return t.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'button', 'submit', 'color'].includes(t.type);
}

const IMG_LIST_MAX = 300;
/**
 * 选原画的字段（对话框里）：只读的当前值 + 筛选框 + 候选列表 + 预览。候选 = `public/resources/runtime` 下全部图
 * （与校验器的媒体口径同一个面），已经有模板在用的排前面。选中会在输入框上记 `data-w` / `data-h`（图的像素尺寸）。
 */
function imagePickerField(f, inputs, onChange) {
  const cur = h('input', { type: 'text', class: 'wide', readonly: true, value: f.value || '' });
  cur.dataset.key = f.key;
  const filter = h('input', { type: 'text', class: 'wide', placeholder: '筛选：路径里的字（空格分隔多个词）' });
  filter.dataset.key = `${f.key}__filter`;
  const list = h('div', { class: 'imglist' });
  const prevImg = h('img', { alt: '' });
  const prevNote = h('span', { class: 'note' });
  const all = (S.images && S.images.images) || [];
  const used = (S.images && S.images.used) || {};
  const ordered = [...all.filter((u) => used[u]), ...all.filter((u) => !used[u])];
  if (f.value && !all.includes(f.value)) ordered.unshift(f.value);
  const preview = (url) => {
    cur.dataset.w = ''; cur.dataset.h = '';
    if (!url) { prevImg.removeAttribute('src'); prevNote.textContent = '还没选'; return; }
    prevNote.textContent = '装载中…';
    prevImg.onload = () => {
      if (cur.value !== url) return;
      cur.dataset.w = String(prevImg.naturalWidth); cur.dataset.h = String(prevImg.naturalHeight);
      prevNote.textContent = `${prevImg.naturalWidth}×${prevImg.naturalHeight} px${used[url] ? ` · 模板 ${used[url].join('、')} 在用` : ''}${all.includes(url) ? '' : ' · ⚠ 不在 public/resources/runtime 下的图里（校验器会拒）'}`;
      if (onChange) onChange(f.key, inputs, 'loaded');
    };
    prevImg.onerror = () => { if (cur.value === url) prevNote.textContent = `⚠ 图装不上：${url}`; };
    prevImg.src = url;
  };
  const render = () => {
    const terms = filter.value.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = ordered.filter((u) => terms.every((t) => u.toLowerCase().includes(t)));
    list.textContent = '';
    for (const u of hits.slice(0, IMG_LIST_MAX)) {
      list.append(h('div', { class: `it${u === cur.value ? ' on' : ''}`, 'data-url': u, title: u,
        onclick: () => { cur.value = u; preview(u); render(); if (onChange) onChange(f.key, inputs, 'picked'); } },
      used[u] ? h('span', { class: 'u', text: '★ ' }) : null, u.replace(/^\/resources\/runtime\//, '')));
    }
    if (hits.length > IMG_LIST_MAX) list.append(h('div', { class: 'note', text: `还有 ${hits.length - IMG_LIST_MAX} 张，缩小筛选` }));
    if (!hits.length) list.append(h('div', { class: 'note', text: '没有匹配的图' }));
  };
  filter.addEventListener('input', render);
  inputs[f.key] = cur;
  inputs[filter.dataset.key] = filter;
  render();
  preview(cur.value);
  return h('div', { class: 'imgpick' },
    h('div', { class: 'row' }, h('label', { text: f.label }), cur),
    h('div', { class: 'row' }, h('label', { text: '' }), filter),
    list, h('div', { class: 'imgprev' }, prevImg, prevNote));
}

let dialogResolve = null;
/**
 * 页内对话框（不用浏览器 confirm / prompt：Qt 壳里它们是模态的、样子不吃页面配色，自检里也没人点）。
 * `fields: [{key, label, type: 'text'|'select'|'image', value, options: [[value, text]]}]`；`buttons: [{id, label, primary?, danger?}]`；
 * `onChange(key, inputs, how)` = 字段变了（给联动字段用，比如选了图就填尺寸）。
 * 返回 `{button, values}`；Esc = `{button: 'cancel'}`。
 */
function dialog({ title, text, fields, buttons, onChange }) {
  if (dialogResolve) dialogResolve({ button: 'cancel', values: {} });
  el('dialogTitle').textContent = title || '';
  el('dialogText').textContent = text || '';
  const fwrap = el('dialogFields');
  fwrap.textContent = '';
  const inputs = {};
  for (const f of fields || []) {
    if (f.type === 'image') { fwrap.append(imagePickerField(f, inputs, onChange)); continue; }
    let inp;
    if (f.type === 'select') {
      inp = h('select', { class: 'wide' }, (f.options || []).map(([v, t]) => h('option', { value: v, text: t })));
      inp.value = f.value != null ? String(f.value) : '';
      inp.addEventListener('change', () => { if (onChange) onChange(f.key, inputs, 'changed'); });
    } else {
      inp = h('input', { type: 'text', class: 'wide', value: f.value != null ? String(f.value) : '' });
      inp.addEventListener('input', () => { if (onChange) onChange(f.key, inputs, 'typed'); });
    }
    inp.dataset.key = f.key;
    inputs[f.key] = inp;
    fwrap.append(h('div', { class: 'row' }, h('label', { text: f.label }), inp, f.unit ? h('span', { class: 'unit', text: f.unit }) : null));
  }
  const bwrap = el('dialogBtns');
  bwrap.textContent = '';
  const btns = buttons && buttons.length ? buttons : [{ id: 'cancel', label: '取消' }, { id: 'ok', label: '确定', primary: true }];
  const done = (id) => {
    const values = {};
    for (const [k, inp] of Object.entries(inputs)) if (!k.endsWith('__filter')) values[k] = inp.value;
    el('dialog').hidden = true;
    const r = dialogResolve; dialogResolve = null;
    if (r) r({ button: id, values, inputs });
  };
  for (const b of btns) {
    bwrap.append(h('button', { type: 'button', class: (b.primary ? 'primary ' : '') + (b.danger ? 'danger' : ''), 'data-choice': b.id, text: b.label, onclick: () => done(b.id) }));
  }
  el('dialog').hidden = false;
  const first = Object.values(inputs).find((x) => !x.readOnly);
  setTimeout(() => { if (first) { first.focus(); if (first.select) first.select(); } else { const p = bwrap.querySelector('.primary'); if (p) p.focus(); } }, 0);
  return new Promise((res) => {
    dialogResolve = res;
    el('dialogBox').onkeydown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done('cancel'); }
      else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON' && !(window.Dropdown && window.Dropdown.isOpen())) {
        e.preventDefault(); e.stopPropagation();
        const p = btns.find((b) => b.primary) || btns[btns.length - 1];
        done(p.id);
      }
    };
  });
}
