'use strict';
/* 燃烧工作台 · 主机：装载、左栏（模板 + 用在哪）、模板增删改名、只读场景视图、保存、预览循环、站位判定、联动、键盘、关窗钩子。
 *
 * 硬契约见 core.js 文件头；另外几条：
 * - **模板和场景无关**：没有"先选场景"。场景只从「用在哪」点开一个场景实体引用时出现，而且只读——
 *   摆放 / 宿主上的可燃配置（初始 / 玩家能不能点 / 条件 / 信号）归主编辑器，这里一个都不写。
 * - **保存**：Ctrl+S 先让焦点所在输入框失焦（值只在 change 时写回）；只存真改了的那几份；存盘不清撤销栈；
 *   保存在飞期间又改了 = 不清脏、状态栏说再按一次；只成功一部分 = 如实列出没存上的。
 * - **改名**：先存；服务端先给改名清单（会改哪些文件、几处）→ 作者确认 → 一次事务（确认之后那些文件被别处改过就拒绝）；
 *   做完清撤销栈（旧快照里是旧 id）。**删除**：还有宿主引用就拒绝并列出来；没有才删。
 * - **推给游戏 ≠ 导出**：推的是页面上此刻的模板工作态（存没存都算），资源一个字节不动；「联动」勾着 = 改动自动推。
 *   关窗选「不保存」时，推过的就把盘上那份推回去（游戏不再挂着被丢掉的工作态）。
 *   「在游戏里点着 / 熄灭 / 复原」从游戏回传的实例里选**用这份模板的**（场景实体或手上的）。
 * - **站位能不能站**：本地判定（边界 + 与 isCollision 同一条反投影）；游戏在那个场景时发 walkProbe 以游戏的判定为准，界面写明来源。 */

const PUBLISH_DEBOUNCE_MS = 150;
const PUBLISH_KEEPALIVE_MS = 180000;
const STATUS_POLL_MS = 500;
let pubTimer = 0;
let sidePanelAt = 0;
let sliderDragging = false;

// ---------------------------------------------------------------------------
// 装载
// ---------------------------------------------------------------------------
async function ensureDoc(id) {
  if (!id) return false;
  if (S.docs[id]) return true;
  try {
    const j = await API.json(`/api/burnable?id=${encodeURIComponent(id)}`);
    if (!S.docs[id]) acceptDiskDoc(id, j.doc);
    return true;
  } catch (e) {
    return false;
  }
}
async function refreshAssets() {
  try { S.assets = (await API.json('/api/burnables')).burnables || []; } catch (e) { /* 清单读不到：左栏照旧 */ }
  renderLeft();
}
async function ensureImages() {
  try {
    const j = await API.json('/api/images');
    S.images = { images: j.images || [], used: j.used || {}, worldSizes: j.worldSizes || {} };
  } catch (e) { /* 候选读不到：弹窗里只剩当前值 */ }
}
/** 「用在哪」：服务端扫全工程（主编辑器存过之后要再扫一次，左栏「刷新」） */
async function refreshRefs() {
  const id = S.docId;
  if (!id) { S.refs = []; S.refsFor = ''; S.refsErr = ''; renderLeft(); return; }
  try {
    const j = await API.json(`/api/refs?id=${encodeURIComponent(id)}`);
    if (S.docId !== id) return;
    S.refs = j.refs || []; S.refsFor = id; S.refsErr = '';
  } catch (e) {
    if (S.docId !== id) return;
    S.refs = []; S.refsFor = id; S.refsErr = String((e && e.message) || e);
  }
  renderLeft();
  renderSimBar();
}

async function openTemplate(id, opts) {
  const o = opts || {};
  if (!(await ensureDoc(id))) { status(`模板「${id}」打不开（不存在 / 读不懂）`, 'err'); return false; }
  if (S.docId !== id) { P.artEvents = []; S.selPoint = ''; S.selGrip = false; V.cam.art.fitKey = ''; }
  S.docId = id;
  if (o.view !== 'scene') setView('art');
  refreshDirty();
  renderAll();
  schedulePreviewBuild();
  await refreshRefs();
  renderGameTargets();
  return true;
}

/** 从「用在哪」点开一个场景实体：只读场景视图（背景 + 这个场景所有开了可燃的实体） */
async function openSceneView(sid, entityId) {
  const op = ++S.sceneOp;
  setBusy(true, `装载场景「${sid}」…`);
  try {
    const sc = (await API.json(`/api/scene?id=${encodeURIComponent(sid)}`)).scene;
    const [img, ground, shell] = await Promise.all([
      sc.hasBackground ? API.image(`/api/scene_bg?id=${encodeURIComponent(sid)}&w=1600&t=${Date.now()}`).catch(() => null) : null,
      sc.cal ? API.bin(`/api/scene_ground?id=${encodeURIComponent(sid)}`).catch(() => null) : null,
      sc.cal ? API.bin(`/api/scene_shell?id=${encodeURIComponent(sid)}`).catch(() => null) : null,
    ]);
    if (op !== S.sceneOp) return false;
    await Promise.all([...new Set(sc.entities.map((e) => e.template))].map((t) => ensureDoc(t)));
    if (op !== S.sceneOp) return false;
    const same = !!(S.sv && S.sv.scene && S.sv.scene.id === sid);
    const keep = same ? S.sv.entityId : '';
    S.sv = { sceneId: sid, scene: sc, bgImg: img, entityId: entityId !== undefined ? entityId : keep };
    buildSceneSpace(sc, ground, sc.cal ? shell : null);
    if (!same) { P.scEvents = {}; V.cam.scene.fitKey = ''; S.stances = null; S.walk = null; }
    P.sc.sig = '';
    setView('scene');
    renderAll();
    schedulePreviewBuild(true);
    const missing = sc.entities.filter((e) => !S.docs[e.template]).map((e) => `${e.id}→${e.template}`);
    if (missing.length) status(`场景「${sc.name}」已装上（只读）· ⚠ ${missing.length} 个实例的模板不存在：${missing.join('、')}`, 'warn');
    else status(`场景「${sc.name}」已装上（只读：${sc.entities.length} 个可燃实例）${sc.cal ? '' : ` · ${sc.calNote}`}`, 'ok');
    return true;
  } catch (e) {
    if (op === S.sceneOp) status(`场景装不上：${(e && e.message) || e}`, 'err');
    return false;
  } finally {
    setBusy(false);
  }
}
function closeSceneView() {
  S.sceneOp++;
  S.sv = null;
  S.stances = null; S.walk = null;
  P.scEvents = {};
  Object.assign(P.sc, { sceneId: '', space: null, spaceKind: 'none', persp: null, wind: null, geo: null, items: [], sim: null, problems: [], sig: '' });
  if (V.gl && V.gl.ok) V.gl.dropFields(new Set([...V.gl.fields.keys()].filter((k) => k.startsWith('a:'))));
  setView('art');
  renderAll();
}
function selectEntity(id) {
  if (!S.sv) return;
  S.sv.entityId = id || '';
  S.selPoint = '';
  renderGameTargets();
  refreshStances();
  renderInspector();
  requestDraw();
}

// ---------------------------------------------------------------------------
// 编辑之后 / 预览建完
// ---------------------------------------------------------------------------
function onDocsChanged() {
  schedulePreviewBuild();
  renderLeft();
  renderInspectorSoon();
  requestDraw();
  schedulePublish();
}
function onPreviewBuilt() {
  refreshStances();
  renderInspectorSoon();
  requestDraw();
}
function onImageLoaded(url) {
  // 原画到了：检视器的尺寸一节要图的像素比例
  const doc = S.docs[S.docId];
  if (doc && doc.image === url) renderInspectorSoon();
}

function renderAll() {
  refreshDirty();
  renderLeft();
  renderViewBar();
  renderInspector();
  renderSimBar();
  requestDraw();
}

// ---------------------------------------------------------------------------
// 站位 + 能不能站（场景视图里选中的实例）
// ---------------------------------------------------------------------------
function refreshStances() {
  const sv = S.sv;
  const key = sv ? sv.entityId : '';
  if (!S.rt || !sv || !sv.scene || !key || !sceneItem(key)) {
    S.stances = null;
    renderInspectorSoon(); requestDraw();
    return;
  }
  const st = computeStances(key);
  st.entityId = key;
  const feet = [];
  for (const pt of st.points) for (const s of [pt.right, pt.left]) if (s) feet.push([round2(s.x), round2(s.y)]);
  st.feet = feet;
  st.walkKey = `${sv.scene.id}|${JSON.stringify(feet)}`;
  S.stances = st;
  if (feet.length && (!S.walk || S.walk.key !== st.walkKey)) void requestWalk(st, false);
  renderInspectorSoon(); requestDraw();
}
async function requestWalk(st, force) {
  const key = st.walkKey, sid = S.sv.scene.id;
  try {
    const r = await API.post('/api/walk_check', { sceneId: sid, points: st.feet });
    if (S.stances && S.stances.walkKey === key && !(S.walk && S.walk.key === key && S.walk.source === 'game')) {
      S.walk = { key, results: r.results, source: 'local', note: r.note || '' };
      renderInspectorSoon(); requestDraw();
    }
  } catch (e) {
    if (S.stances && S.stances.walkKey === key) { S.walk = { key, results: st.feet.map(() => null), source: 'local', note: `本地判定失败：${(e && e.message) || e}` }; renderInspectorSoon(); requestDraw(); }
  }
  if (gameInSceneView()) await requestGameWalk(st, force);
}
function gameInSceneView() {
  const s = S.link.status;
  return !!(s && s.connected && s.gameAlive && s.doc && S.sv && S.sv.scene && s.doc.sceneId === S.sv.scene.id);
}
async function requestGameWalk(st, force) {
  if (!st || !st.feet.length || !S.sv || !S.sv.scene) return null;
  const r = await publishNow({ walk: { sceneId: S.sv.scene.id, points: st.feet, force: !!force } }, !S.link.on);
  if (r && r.ok && r.walkSeq) S.link.walkPending = { key: st.walkKey, seq: r.walkSeq };
  return r;
}

// ---------------------------------------------------------------------------
// 左栏：模板 + 用在哪
// ---------------------------------------------------------------------------
const REF_GROUPS = [
  ['scene', '场景实体（点开 = 只读场景视图）', (r) => r.kind === 'hotspot' || r.kind === 'npc'],
  ['prop', '挂件预设', (r) => r.kind === 'prop'],
  ['spawn', '轨迹 spawn 规格', (r) => r.kind === 'spawn'],
  ['plate', '粒子效果（薄片）', (r) => r.kind === 'plate'],
  ['other', '其它', (r) => !['hotspot', 'npc', 'prop', 'spawn', 'plate'].includes(r.kind)],
];
function refKey(r) { return `${r.file}|${(r.path || []).join('/')}`; }

function renderLeft() {
  const list = el('assetList');
  list.textContent = '';
  const ids = [...new Set([...S.assets.map((a) => a.id), ...Object.keys(S.docs)])].sort();
  for (const id of ids) {
    const row = S.assets.find((a) => a.id === id) || {};
    const doc = S.docs[id];
    const dirty = S.dirtyIds.includes(id);
    const w = doc ? doc.widthCm : row.widthCm, hh = doc ? doc.heightCm : row.heightCm;
    list.append(h('div', { class: `item${id === S.docId ? ' on' : ''}`, 'data-asset': id, title: (doc && doc.image) || row.image || '', onclick: () => { void openTemplate(id); } },
      h('span', { class: 'dot', text: dirty ? '●' : '' }),
      h('span', { class: 'name', text: `${id}${(doc && doc.label) || row.label ? ` · ${(doc && doc.label) || row.label}` : ''}` }),
      row.error ? h('span', { class: 'bad', text: '⚠ 读不懂', title: row.error }) : null,
      h('span', { class: 'tag', text: `${((doc && doc.mode) || row.mode) === 'consume' ? '消耗' : '面'}${typeof w === 'number' && typeof hh === 'number' ? ` · ${w}×${hh}` : ' · ⚠ 没尺寸'}` })));
  }
  if (!ids.length) list.append(note('还没有模板（新建一份）'));
  el('btnDup').disabled = !S.docId; el('btnRename').disabled = !S.docId; el('btnDelete').disabled = !S.docId;
  // 用在哪
  const rl = el('refsList');
  rl.textContent = '';
  el('refsHead').firstChild.textContent = S.docId ? `用在哪 · ${S.docId}${S.refsFor === S.docId ? ` · ${S.refs.length}` : ''} ` : '用在哪 ';
  if (!S.docId) return;
  if (S.refsFor !== S.docId) { rl.append(note('扫描中…')); return; }
  if (S.refsErr) { rl.append(note(`扫不出来：${S.refsErr}`, 'err')); return; }
  if (!S.refs.length) {
    rl.append(h('div', { class: 'note', style: 'padding: 2px 10px', text: '没有宿主用它（热点 / NPC / 挂件预设 / 轨迹 spawn / 粒子薄片里写 burnable.template = 这个 id）' }));
    return;
  }
  for (const [gid, title, pred] of REF_GROUPS) {
    const rows = S.refs.filter(pred);
    if (!rows.length) continue;
    rl.append(h('div', { class: 'refkind', text: `${title} · ${rows.length}` }));
    for (const r of rows) {
      if (gid === 'scene') {
        const on = !!(S.sv && S.sv.scene && S.sv.scene.id === r.scene && S.sv.entityId === r.entity);
        rl.append(h('div', { class: `item${on ? ' on' : ''}`, 'data-ref': refKey(r), 'data-ref-kind': r.kind, title: `${r.file} ${r.where || ''}`,
          onclick: () => { void openSceneView(r.scene, r.entity || ''); } },
        h('span', { class: 'fire', text: r.kind === 'npc' ? '👤' : '🔥' }),
        h('span', { class: 'name', text: `${r.sceneName && r.sceneName !== r.scene ? `${r.sceneName}（${r.scene}）` : r.scene} / ${r.entity || '?'}${r.entityLabel ? ` · ${r.entityLabel}` : ''}` }),
        h('span', { class: 'tag', text: KIND_LABEL[r.kind] })));
      } else {
        const text = gid === 'prop' ? `${r.prop}${r.label ? ` · ${r.label}` : ''}` : gid === 'plate' ? `${r.effect || r.file}` : `${r.file.replace(/^public\/assets\//, '')}${r.entity ? ` · ${r.entity}` : ''}`;
        rl.append(h('div', { class: 'item ro', 'data-ref': refKey(r), 'data-ref-kind': r.kind, title: `${r.file} ${r.where || ''}（在编辑它的地方改：主编辑器 / 动作编辑器 / 粒子工作台）` },
          h('span', { class: 'name', text }),
          h('span', { class: 'tag', text: gid === 'spawn' || gid === 'other' ? (r.where || '') : KIND_LABEL[r.kind] || '' })));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 模板：新建 / 复制 / 换图 / 改名 / 删除
// ---------------------------------------------------------------------------
function takenIds() { return new Set([...S.assets.map((a) => a.id), ...Object.keys(S.docs)]); }
function suggestId(base) {
  const b = String(base || 'burnable').replace(/\.[a-z0-9]+$/i, '').replace(/[^A-Za-z0-9_\-一-鿿]+/g, '_').replace(/^_+|_+$/g, '') || 'burnable';
  const used = takenIds();
  if (!used.has(b)) return b;
  let k = 2;
  while (used.has(`${b}_${k}`)) k++;
  return `${b}_${k}`;
}
function checkNewId(id) {
  if (!validId(id)) return 'id 只许字母数字 _ - 与汉字';
  if (takenIds().has(id)) return `「${id}」已经有了`;
  return '';
}
/** 新建时按图给的初始真实尺寸：场景里这张图写过展示尺寸就按它（wu → cm），否则长边先给 50 cm；比例一律按图的像素 */
function suggestSize(url, pxW, pxH) {
  const ws = S.images.worldSizes && S.images.worldSizes[url];
  if (ws && ws[0] > 0) {
    const w = round2(ws[0] / (S.rt ? S.rt.burnables.BURN_WU_PER_CM : 0.88));
    return { w, h: round2(w * pxH / pxW), why: '按场景里这张图的展示宽度换算' };
  }
  const long = 50;
  return pxW >= pxH ? { w: long, h: round2(long * pxH / pxW), why: '长边先给 50 cm' } : { w: round2(long * pxW / pxH), h: long, why: '长边先给 50 cm' };
}
async function newTemplate() {
  await ensureImages();
  const onChange = (key, inputs, how) => {
    const img = inputs.image;
    const pw = Number(img.dataset.w), ph = Number(img.dataset.h);
    if (key === 'image' && how === 'loaded' && pw > 0 && ph > 0) {
      const s = suggestSize(img.value, pw, ph);
      if (!inputs.widthCm.dataset.touched) inputs.widthCm.value = String(s.w);
      if (!inputs.heightCm.dataset.touched) inputs.heightCm.value = String(s.h);
      if (!inputs.id.dataset.touched) inputs.id.value = suggestId(img.value.split('/').pop());
      el('dialogText').textContent = `模板和场景无关：选一张图、给真实尺寸（厘米，必填）。\n图 ${pw}×${ph} px：初始尺寸${s.why}、高按图的像素比例——照实物改。`;
    } else if (key === 'widthCm' && how === 'typed') {
      inputs.widthCm.dataset.touched = '1';
      const n = Number(inputs.widthCm.value);
      if (!inputs.heightCm.dataset.touched && n > 0 && pw > 0 && ph > 0) inputs.heightCm.value = String(round2(n * ph / pw));
    } else if (key === 'heightCm' && how === 'typed') {
      inputs.heightCm.dataset.touched = '1';
    } else if (key === 'id' && how === 'typed') {
      inputs.id.dataset.touched = '1';
    }
  };
  const r = await dialog({
    title: '新建可燃物模板',
    text: '模板和场景无关：选一张图、给真实尺寸（厘米，必填；选了图会按图的像素比例给一个初始值——照实物改）。',
    fields: [
      { key: 'id', label: 'id', value: suggestId('burnable') },
      { key: 'label', label: '名称', value: '' },
      { key: 'image', label: '原画', type: 'image', value: '' },
      { key: 'mode', label: '燃烧方式', type: 'select', value: 'spread', options: [['spread', '面燃烧（纸 / 布）'], ['consume', '消耗燃烧（蜡烛 / 香）']] },
      { key: 'widthCm', label: '真实宽', value: '', unit: 'cm' },
      { key: 'heightCm', label: '真实高', value: '', unit: 'cm' },
    ],
    buttons: [{ id: 'cancel', label: '取消' }, { id: 'ok', label: '建', primary: true }],
    onChange,
  });
  if (r.button !== 'ok') return null;
  const id = String(r.values.id || '').trim();
  const bad = checkNewId(id);
  if (bad) { status(`没建：${bad}`, 'err'); return null; }
  if (!r.values.image) { status('没建：要选一张原画', 'err'); return null; }
  const w = Number(String(r.values.widthCm || '').trim()), hh = Number(String(r.values.heightCm || '').trim());
  if (!(Number.isFinite(w) && w > 0 && Number.isFinite(hh) && hh > 0) || String(r.values.widthCm || '').trim() === '' || String(r.values.heightCm || '').trim() === '') {
    status('没建：真实尺寸（宽 / 高 cm）必填且 > 0', 'err');
    return null;
  }
  try {
    const j = await API.post('/api/create', { id, image: r.values.image, label: r.values.label, mode: r.values.mode, widthCm: w, heightCm: hh });
    acceptDiskDoc(id, j.doc);
    await refreshAssets();
    await openTemplate(id);
    status(`已建「${id}」（${j.path}）`, 'ok');
    return id;
  } catch (e) {
    status(`没建：${(e && e.message) || e}`, 'err');
    return null;
  }
}
async function duplicateTemplate() {
  const src = S.docId;
  if (!src || !S.docs[src]) return null;
  const r = await dialog({ title: `复制「${src}」`, text: docDirty(src) ? '这份有没存的改动：副本带着页面上此刻的内容，原文件不动。' : '', fields: [{ key: 'id', label: '新 id', value: suggestId(`${src}_copy`) }] });
  if (r.button !== 'ok') return null;
  const to = String(r.values.id || '').trim();
  const bad = checkNewId(to);
  if (bad) { status(`没复制：${bad}`, 'err'); return null; }
  try {
    const j = await API.post('/api/duplicate', { id: src, to, doc: S.docs[src] });
    acceptDiskDoc(to, j.doc);
    await refreshAssets();
    await openTemplate(to);
    status(`已复制成「${to}」`, 'ok');
    return to;
  } catch (e) {
    status(`没复制：${(e && e.message) || e}`, 'err');
    return null;
  }
}
async function pickTemplateImage() {
  const doc = S.docs[S.docId];
  if (!doc) return false;
  await ensureImages();
  const r = await dialog({ title: `换「${doc.id}」的原画`, text: '燃料涂层 / 着火点 / 握点都按图的归一化坐标存：换一张比例不同的图，它们跟着拉伸。',
    fields: [{ key: 'image', label: '原画', type: 'image', value: doc.image || '' }] });
  if (r.button !== 'ok' || !r.values.image || r.values.image === doc.image) return false;
  const url = r.values.image;
  return edit('换原画', () => { S.docs[S.docId].image = url; });
}
async function needSavedFirst(what) {
  const id = S.docId;
  if (!docDirty(id)) return true;
  const r = await dialog({ title: `${what}前要先保存`, text: `「${id}」有没存的改动，先存上。`, buttons: [{ id: 'cancel', label: '取消' }, { id: 'save', label: '保存并继续', primary: true }] });
  if (r.button !== 'save') return false;
  await saveAll();
  if (docDirty(id)) { status(`没存上，${what}取消了`, 'err'); return false; }
  return true;
}
async function renameTemplate() {
  const old = S.docId;
  if (!old) return null;
  if (!(await needSavedFirst('改名'))) return null;
  const r = await dialog({ title: `改名「${old}」`, text: '引用它的宿主（热点 / NPC / 挂件预设 / 轨迹 spawn / 粒子薄片）会一起改。', fields: [{ key: 'id', label: '新 id', value: old }] });
  if (r.button !== 'ok') return null;
  const to = String(r.values.id || '').trim();
  if (to === old) return null;
  const bad = checkNewId(to);
  if (bad) { status(`没改名：${bad}`, 'err'); return null; }
  let plan;
  try {
    plan = await API.post('/api/rename_plan', { id: old, to });
  } catch (e) {
    status(`没改名：${(e && e.message) || e}`, 'err');
    return null;
  }
  const files = plan.files || [];
  const c = await dialog({
    title: `确认改名「${old}」→「${to}」`,
    text: (files.length
      ? `会一起改这 ${files.length} 个文件里的 ${plan.refs.length} 处引用（只改 burnable.template 那个值，文件里别的字节不动）：\n${files.map((f) => `  ${f.file}（${f.count} 处）`).join('\n')}`
      : '没有宿主引用它：只改模板的文件名与 id。')
      + `\n\n模板文件：${S.boot.burnablesDir || 'burnables'}/${old}.json → ${to}.json`
      + (files.length ? '\n\n⚠ 主编辑器 / 粒子工作台若开着这些文件并且有没存的改动：主编辑器下次保存会弹「检测到外部修改」——'
        + '那时别选继续保存（会把这里改的名覆盖回旧 id），先在那边重新载入再改；粒子工作台会拒存"效果已被外部修改"，同样重新打开再改。' : ''),
    buttons: [{ id: 'cancel', label: '取消' }, { id: 'ok', label: '改名', primary: true }],
  });
  if (c.button !== 'ok') return null;
  try {
    const j = await API.post('/api/rename', { id: old, to, expect: plan.expect });
    delete S.docs[old]; delete S.clean[old]; delete S.base[old];
    acceptDiskDoc(to, j.doc);
    clearHistory();
    await refreshAssets();
    await openTemplate(to, { view: S.view });
    if (S.sv && S.sv.scene) await openSceneView(S.sv.scene.id, S.sv.entityId);
    status(`已改名「${old}」→「${to}」：${j.refsChanged} 处引用（${(j.files || []).length} 个文件）一起改了（撤销栈清空）`, 'ok');
    return to;
  } catch (e) {
    status(`没改名：${(e && e.message) || e}`, 'err');
    await refreshRefs();
    return null;
  }
}
async function deleteTemplate() {
  const id = S.docId;
  if (!id) return null;
  let refs;
  try { refs = (await API.json(`/api/refs?id=${encodeURIComponent(id)}`)).refs || []; } catch (e) { status(`没删：查不了谁在用它（${(e && e.message) || e}）`, 'err'); return null; }
  const listRefs = (rs) => rs.slice(0, 12).map((x) => `  ${KIND_LABEL[x.kind] || x.kind} · ${x.scene ? `${x.scene} / ${x.entity}` : x.prop || x.effect || x.file}${x.kind === 'spawn' || x.kind === 'other' ? ` · ${x.file}` : ''}`).join('\n') + (rs.length > 12 ? `\n  …还有 ${rs.length - 12} 处` : '');
  if (refs.length) {
    await dialog({ title: `删不了「${id}」`, text: `还有 ${refs.length} 处宿主在用它：\n${listRefs(refs)}\n\n先去这些地方把可燃关掉或换一份模板，再删。`, buttons: [{ id: 'ok', label: '知道了', primary: true }] });
    status(`没删「${id}」：还有 ${refs.length} 处在用`, 'err');
    S.refs = refs; S.refsFor = id; renderLeft();
    return null;
  }
  const r = await dialog({
    title: `删除「${id}」`,
    text: `没有宿主引用它。文件删掉就没了（git 里还有）${docDirty(id) ? '；页面上没存的改动一起丢掉' : ''}。`,
    buttons: [{ id: 'cancel', label: '取消' }, { id: 'ok', label: '删', danger: true, primary: true }],
  });
  if (r.button !== 'ok') return null;
  try {
    const j = await API.post('/api/delete', { id });
    if (!j.deleted) {
      if (j.refs && j.refs.length) { status(`没删：刚刚有 ${j.refs.length} 处开始用它了\n${listRefs(j.refs)}`, 'err'); S.refs = j.refs; S.refsFor = id; renderLeft(); }
      else status('没删：文件不存在', 'err');
      return null;
    }
    delete S.docs[id]; delete S.clean[id]; delete S.base[id];
    clearHistory();
    S.docId = '';
    await refreshAssets();
    const next = S.assets[0];
    if (next) await openTemplate(next.id); else { S.refs = []; S.refsFor = ''; renderAll(); }
    schedulePreviewBuild(true);
    status(`已删「${id}」（撤销栈清空）`, 'ok');
    return true;
  } catch (e) {
    status(`没删：${(e && e.message) || e}`, 'err');
    return null;
  }
}

// ---------------------------------------------------------------------------
// 保存
// ---------------------------------------------------------------------------
function saveAll() {
  if (S.saving) return S.saving;
  commitFocusedInput();
  if (HIST.drag || (V.drag && V.drag.kind !== 'pan')) { status('手势没松开，松开再存', 'warn'); return Promise.resolve(false); }
  if (S.busy) { status('正在装载，稍后再存', 'warn'); return Promise.resolve(false); }
  refreshDirty();
  const ids = S.dirtyIds.slice();
  if (!ids.length) { status('没有未保存的改动'); return Promise.resolve(true); }
  const run = async () => {
    const failed = [], done = [], warns = [];
    let raced = false;
    for (const id of ids) {
      const doc = S.docs[id];
      if (!doc) continue;
      const sent = canonJson(doc);
      try {
        const j = await API.post('/api/save', { doc, base: S.base[id] === undefined ? null : S.base[id] });
        if (S.docs[id] && canonJson(S.docs[id]) === sent) acceptDiskDoc(id, j.doc);
        else { S.base[id] = clone(j.doc); S.clean[id] = canonJson(j.doc); raced = true; }
        done.push(id);
        for (const w of j.warnings || []) warns.push(`${id}：${w}`);
      } catch (e) {
        failed.push(`${id}：${(e && e.message) || e}`);
      }
    }
    refreshDirty();
    await refreshAssets();
    renderAll();
    schedulePreviewBuild();
    if (failed.length) status(`${done.length ? `存了 ${done.join('、')}；` : ''}没存上：${failed.join('；')}`, 'err');
    else if (raced) status(`存了 ${done.join('、')}，但保存期间又改了：再按一次 Ctrl+S`, 'warn');
    else if (warns.length) status(`已存 ${done.join('、')} · ⚠ ${warns.join('；')}`, 'warn');
    else status(`已存 ${done.join('、')}`, 'ok');
    return !failed.length;
  };
  S.saving = run().finally(() => { S.saving = null; });
  return S.saving;
}

// ---------------------------------------------------------------------------
// 联动
// ---------------------------------------------------------------------------
function schedulePublish() {
  if (!S.link.on || S.link.discarded) return;
  if (pubTimer) clearTimeout(pubTimer);
  pubTimer = setTimeout(() => { pubTimer = 0; void publishNow({}); }, PUBLISH_DEBOUNCE_MS);
}
const pubInflight = new Set();
/**
 * 推一发。`extra.probe = {action, target, socket?, point?}` / `extra.walk = {sceneId, points}`；
 * `probeOnly` = 这一发不带工作态（联动没勾时的探针 / 站位判定：游戏不重建、不换预览）。
 */
function publishNow(extra, probeOnly) {
  if (S.link.discarded) return Promise.resolve(null);
  const body = Object.assign({}, extra || {});
  if (!probeOnly) body.burnables = S.docs;
  S.link.lastBody = body;
  const run = async () => {
    let r;
    try {
      const resp = await fetch('/api/link/publish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
      r = await resp.json();
    } catch (e) {
      r = { ok: false, err: String((e && e.message) || e) };
    }
    if (r.ok) { S.link.lastPub = Date.now(); if (!probeOnly) S.link.pushed = true; }
    S.link.err = r.ok || r.connected === false ? '' : (r.err || '游戏没收到');
    S.link.notes = r.notes || [];
    renderLinkText();
    return r;
  };
  const p = run();
  pubInflight.add(p);
  p.finally(() => pubInflight.delete(p));
  return p;
}
async function pushToGame() {
  const r = await publishNow({});
  if (r && r.ok) status(`已推给游戏（工作态 #${r.rev}，资源没动）${S.link.status && S.link.status.gameAlive ? '' : ' · 游戏页没开：开了会读到这份'}`, 'ok');
  else if (r && r.connected === false) status('游戏的 dev server 没开：开了再推（或勾「联动」让它自动推）', 'warn');
  else status(`没推过去：${(r && r.err) || '?'}`, 'err');
  return r;
}
/** 游戏回传的实例里用当前模板的（场景实体 / 手上的） */
function gameItemsOfTemplate() {
  const st = S.link.status;
  const items = st && st.connected && st.gameAlive && st.doc && Array.isArray(st.doc.items) ? st.doc.items : [];
  return items.filter((it) => it && it.template === S.docId && typeof it.target === 'string' && it.target);
}
function gameItemValue(it) { return JSON.stringify([it.kind === 'held' ? 'held' : 'scene', it.sceneId || '', it.target, it.socket || '']); }
function renderGameTargets() {
  const sel = el('gameTarget');
  if (!sel) return;
  const items = gameItemsOfTemplate();
  const prev = sel.value;
  const opts = items.map((it) => [gameItemValue(it), `${gameItemLabel(it)} · ${STATE_LABEL[it.state] || it.state}`]);
  const same = sel.options.length === opts.length && opts.every(([v, t], i) => sel.options[i].value === v && sel.options[i].textContent === t);
  if (!same) {
    sel.textContent = '';
    if (!opts.length) sel.append(h('option', { value: '', text: '（游戏里没有用这份模板的实例）' }));
    for (const [v, t] of opts) sel.append(h('option', { value: v, text: t }));
  }
  let want = opts.some(([v]) => v === prev) ? prev : '';
  const sv = S.sv;
  if (sv && sv.entityId && sv.scene) {
    const hit = items.find((it) => it.kind !== 'held' && it.target === sv.entityId && (it.sceneId || '') === sv.scene.id);
    if (hit && (!want || S.link.targetFollow !== sv.entityId)) { want = gameItemValue(hit); S.link.targetFollow = sv.entityId; }
  }
  sel.value = want || (opts[0] ? opts[0][0] : '');
  sel.disabled = !opts.length;
  for (const id of ['btnGameIgnite', 'btnGameExt', 'btnGameReset']) el(id).disabled = !opts.length;
}
function selectedGameItem() {
  const v = el('gameTarget').value;
  return gameItemsOfTemplate().find((it) => gameItemValue(it) === v) || null;
}
async function gameProbe(action) {
  const it = selectedGameItem();
  if (!it) { status('游戏里没有用这份模板的实例可选（游戏没开 / 当前场景里没有 / 手上没拿）', 'warn'); return null; }
  const probe = { action, target: it.target };
  if (it.kind === 'held' && it.socket) probe.socket = it.socket;
  if (action === 'ignite' && S.selPoint) probe.point = S.selPoint;
  const r = await publishNow({ probe }, !S.link.on);
  const what = ({ ignite: '点着', extinguish: '熄灭', reset: '复原' })[action];
  if (r && r.ok) status(`已请游戏${what}「${gameItemLabel(it)}」（探针 #${r.probeSeq}）`, 'ok');
  else status(`没发出去：${(r && r.err) || '?'}`, 'err');
  return r;
}
async function pollLink() {
  let r;
  try { r = await API.json('/api/link/status'); } catch (e) { r = { ok: false, connected: false, err: String((e && e.message) || e) }; }
  handleLinkStatus(r);
}
function handleLinkStatus(r) {
  const prev = S.link.status;
  S.link.status = r;
  if (r.gameUrl !== undefined && document.activeElement !== el('gameUrl')) el('gameUrl').value = r.gameUrl || '';
  S.link.gameUrl = r.gameUrl || S.link.gameUrl;
  if (r.connected && r.gameAlive) {
    const bootOf = (st) => (st && st.connected && st.gameAlive && st.doc ? String(st.doc.bootId || st.doc.writer || '') : '');
    const cameUp = bootOf(r) !== bootOf(prev);
    if (S.link.on && !S.link.discarded && (cameUp || Date.now() - S.link.lastPub > PUBLISH_KEEPALIVE_MS)) void publishNow({});
    const d = r.doc || {};
    const wp = S.link.walkPending, wr = d.walkProbeResult;
    if (wp && wr && wr.seq >= wp.seq && S.sv && S.sv.scene && wr.sceneId === S.sv.scene.id && S.stances && S.stances.walkKey === wp.key && typeof wr.bits === 'string') {
      S.walk = { key: wp.key, results: [...wr.bits].map((b) => b === '1'), source: 'game', note: '' };
      S.link.walkPending = null;
      renderInspectorSoon(); requestDraw();
    } else if (!wp && S.stances && S.stances.feet.length && gameInSceneView() && !(S.walk && S.walk.key === S.stances.walkKey && S.walk.source === 'game')) {
      void requestGameWalk(S.stances, false);
    }
  }
  renderGameTargets();
  renderLinkText();
}
function renderLinkText() {
  const st = S.link.status;
  let t;
  if (!st || !st.connected) t = `游戏没开（${(st && st.gameUrl) || '?'}）`;
  else if (!st.gameAlive) t = 'dev server 在，没有游戏页';
  else {
    const d = st.doc || {};
    t = `游戏在「${d.sceneId || '?'}」· ${d.appliedRev ? `工作态 #${d.appliedRev}` : '盘上那份'} · 在烧 ${d.stats ? d.stats.burning : '?'}`;
  }
  if (S.link.err) t += ` · ⚠ ${S.link.err}`;
  el('linkText').textContent = t;
  el('linkText').title = t;
}
async function discardLiveWorkingCopy() {
  if (!S.link.pushed) return null;
  S.link.discarded = true;
  if (pubTimer) { clearTimeout(pubTimer); pubTimer = 0; }
  await Promise.allSettled([...pubInflight]);
  const burnables = {};
  for (const id of Object.keys(S.docs)) if (S.base[id]) burnables[id] = S.base[id];
  try {
    const resp = await fetch('/api/link/publish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ burnables }), cache: 'no-store' });
    return await resp.json();
  } catch (e) {
    return null;
  }
}
/** 拉起游戏进哪个场景：场景视图里那个；没开场景视图 = 第一个用这份模板的场景实体所在的场景 */
function launchSceneId() {
  if (S.sv && S.sv.scene) return S.sv.scene.id;
  const r = S.refs.find((x) => (x.kind === 'hotspot' || x.kind === 'npc') && x.scene);
  return r ? r.scene : '';
}

// ---------------------------------------------------------------------------
// 预览条
// ---------------------------------------------------------------------------
function renderSimBar() {
  el('btnPlay').textContent = P.playing ? '⏸ 暂停' : '▶ 播放';
  const s = el('tslider');
  s.max = String(P.duration);
  if (!sliderDragging) s.value = String(P.t);
  el('tText').textContent = `${fmt(P.t, 2)} s`;
  const tgt = eventTarget();
  const n = tgt ? (tgt.scene ? sceneEventsOf(tgt.it).length : P.artEvents.length) : 0;
  el('evText').textContent = tgt ? `→ ${tgt.scene ? `实例 ${tgt.key}` : `模板「${S.docId}」（真实尺寸）`} · 事件 ${n}` : (S.view === 'scene' ? '（场景视图里点一个实例）' : '（打开一份模板）');
  for (const id of ['btnIgnitePoint', 'btnIgniteAll', 'btnExtinguish', 'btnResetItem']) el(id).disabled = !tgt;
  el('windGrp').hidden = S.view === 'scene';
  el('btnWindDir').textContent = S.wind.dir < 0 ? '←' : '→';
  el('btnGameWalk').disabled = !(S.view === 'scene' && S.stances && S.stances.feet && S.stances.feet.length);
  const sid = launchSceneId();
  el('btnLaunch').disabled = !sid;
  el('btnLaunch').title = sid ? `让游戏进「${sid}」（游戏没开就拉起）` : '这份模板没有场景实体在用：拉起游戏要一个场景';
}
function setPlaying(on) {
  P.playing = !!on;
  P.lastFrameMs = performance.now();
  renderSimBar();
  requestDraw();
}
function previewIgnite(all) {
  const tgt = eventTarget();
  if (!tgt) { status('没有预览目标', 'warn'); return; }
  const pts = tgt.it.b.ignitionPoints;
  if (all || !pts.length) { addPreviewEvent(tgt, 'igniteAll'); status(`预览：「${tgt.scene ? tgt.key : S.docId}」整体点着 @ ${fmt(P.t, 2)} s`, 'ok'); return; }
  const p = pts.find((x) => x.id === S.selPoint) || pts[0];
  addPreviewEvent(tgt, 'ignite', p.u, p.v);
  status(`预览：「${tgt.scene ? tgt.key : S.docId}」在着火点 ${p.id} 点着 @ ${fmt(P.t, 2)} s`, 'ok');
}
function frameLoop(now) {
  if (P.playing) {
    const dt = Math.min(0.1, Math.max(0, (now - P.lastFrameMs) / 1000)) * P.speed;
    stepPreview(dt);
    requestDraw();
    if (now - sidePanelAt > 250) { sidePanelAt = now; refreshLiveSections(); }
  }
  P.lastFrameMs = now;
  requestAnimationFrame(frameLoop);
}
/** 播放期间只换预览读数与游戏两块（整栏重建会打断正在打字的输入框） */
function refreshLiveSections() {
  const side = el('side');
  const ae = document.activeElement;
  for (const [key, make] of [['preview', previewSection], ['game', gameSection]]) {
    const old = side.querySelector(`[data-sec="${key}"]`);
    if (!old || (ae && old.contains(ae))) continue;
    const n = make();
    if (n) old.replaceWith(n);
  }
}

// ---------------------------------------------------------------------------
// 键盘
// ---------------------------------------------------------------------------
function onKey(e) {
  if (!el('dialog').hidden) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (ctrl && k === 's') { e.preventDefault(); void saveAll(); return; }
  if (S.busy) return;
  const typing = isTypingTarget(e.target);
  if (ctrl && !typing && (k === 'z' || k === 'y')) {
    e.preventDefault();
    if (k === 'y' || e.shiftKey) redo(); else undo();
    return;
  }
  if (typing || ctrl || e.altKey) return;
  if (e.key === ' ') { e.preventDefault(); if (!e.repeat) { V.spaceDown = true; S.spaceTap = true; } return; }
  if (e.repeat) return;
  if (k === '1') setView('art');
  else if (k === '2') { if (S.sv) setView('scene'); }
  else if (k === 'f') fitView();
  else if (k === 'v') setTool('select');
  else if (k === 'p') setTool('point');
  else if (k === 'b') setTool('fuel');
  else if (k === 'o') setTool('order');
  else if (k === 'i') setTool('ignite');
  else if (k === 'e') { S.brush.erase = !S.brush.erase; el('brushErase').checked = S.brush.erase; requestDraw(); }
  else if (k === '[') { S.brush.size = Math.max(1, S.brush.size - 2); el('brushSize').value = String(S.brush.size); requestDraw(); }
  else if (k === ']') { S.brush.size = Math.min(64, S.brush.size + 2); el('brushSize').value = String(S.brush.size); requestDraw(); }
  else if (e.key === 'Escape') setTool('select');
  else if ((e.key === 'Delete' || e.key === 'Backspace') && S.view === 'art' && S.docs[S.docId] && (S.selPoint || S.selGrip)) {
    const d = S.docs[S.docId];
    if (S.selGrip) {
      if (isObj(d.grip)) edit('清握点', () => { delete d.grip; });
      S.selGrip = false;
    } else {
      const id = S.selPoint;
      const i = Array.isArray(d.ignitionPoints) ? d.ignitionPoints.findIndex((p) => p && p.id === id) : -1;
      if (i >= 0) { edit(`删着火点 ${id}`, () => { d.ignitionPoints.splice(i, 1); if (!d.ignitionPoints.length) delete d.ignitionPoints; }); S.selPoint = ''; }
    }
  } else return;
  e.preventDefault();
}
function onKeyUp(e) {
  if (e.key !== ' ') return;
  V.spaceDown = false;
  const tap = S.spaceTap; S.spaceTap = false;
  if (tap && !S.busy && el('dialog').hidden && !isTypingTarget(e.target)) setPlaying(!P.playing);
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
function bindUI() {
  el('btnSave').addEventListener('click', () => { void saveAll(); });
  el('btnUndo').addEventListener('click', () => undo());
  el('btnRedo').addEventListener('click', () => redo());
  el('btnNew').addEventListener('click', () => { void newTemplate(); });
  el('btnDup').addEventListener('click', () => { void duplicateTemplate(); });
  el('btnRename').addEventListener('click', () => { void renameTemplate(); });
  el('btnDelete').addEventListener('click', () => { void deleteTemplate(); });
  el('btnRefsReload').addEventListener('click', () => { void refreshRefs().then(() => status(`「用在哪」已重新扫描：${S.refs.length} 处`, 'ok')); });
  el('btnCloseScene').addEventListener('click', () => closeSceneView());
  el('btnPush').addEventListener('click', () => { void pushToGame(); });
  el('linkOn').addEventListener('change', (e) => { S.link.on = e.target.checked; if (S.link.on) schedulePublish(); renderLinkText(); });
  el('btnLaunch').addEventListener('click', async () => {
    const sid = launchSceneId();
    if (!sid) { status('这份模板没有场景实体在用：拉起游戏要一个场景', 'warn'); return; }
    try { const r = await API.post('/api/link/launch', { sceneId: sid }); status(r.message || '已请求', r.ok ? 'ok' : 'err'); }
    catch (e) { status(`拉不起来：${(e && e.message) || e}`, 'err'); }
  });
  el('gameUrl').addEventListener('change', async (e) => {
    try { await API.post('/api/link/config', { gameUrl: e.target.value }); S.link.lastPub = 0; void pollLink(); }
    catch (err) { status(`地址设不上：${(err && err.message) || err}`, 'err'); }
  });
  el('btnPlay').addEventListener('click', () => setPlaying(!P.playing));
  el('speedSel').addEventListener('change', (e) => { P.speed = Number(e.target.value) || 1; });
  const sl = el('tslider');
  sl.addEventListener('input', () => { sliderDragging = true; seek(Number(sl.value)); renderSimBar(); });
  sl.addEventListener('change', () => { sliderDragging = false; seek(Number(sl.value)); renderSimBar(); renderInspectorSoon(); });
  el('btnIgnitePoint').addEventListener('click', () => previewIgnite(false));
  el('btnIgniteAll').addEventListener('click', () => previewIgnite(true));
  el('btnExtinguish').addEventListener('click', () => { const t = eventTarget(); if (t) { addPreviewEvent(t, 'extinguish'); status(`预览：熄灭 @ ${fmt(P.t, 2)} s`, 'ok'); } });
  el('btnResetItem').addEventListener('click', () => { const t = eventTarget(); if (t) { addPreviewEvent(t, 'reset'); status(`预览：复原 @ ${fmt(P.t, 2)} s`, 'ok'); } });
  el('btnRestart').addEventListener('click', () => { restartPreview(); renderSimBar(); renderInspectorSoon(); });
  el('windSel').addEventListener('change', (e) => { S.wind.mps = Number(e.target.value) || 0; schedulePreviewBuild(); renderSimBar(); renderInspectorSoon(); });
  el('btnWindDir').addEventListener('click', () => { S.wind.dir = S.wind.dir < 0 ? 1 : -1; schedulePreviewBuild(); renderSimBar(); });
  el('btnGameIgnite').addEventListener('click', () => { void gameProbe('ignite'); });
  el('btnGameExt').addEventListener('click', () => { void gameProbe('extinguish'); });
  el('btnGameReset').addEventListener('click', () => { void gameProbe('reset'); });
  el('btnGameWalk').addEventListener('click', async () => {
    if (!S.stances || !S.stances.feet.length) { status('先在场景视图里选一个站位解得出来的实例', 'warn'); return; }
    const r = await requestGameWalk(S.stances, true);
    if (r && r.ok) status(gameInSceneView() ? '已请游戏判站位（它自己的 isCollision）' : '已发站位判定请求：游戏进这个场景时会判', 'ok');
    else status(`没发出去：${(r && r.err) || '?'}`, 'err');
  });
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (e.key === 'Enter' && t && t.tagName === 'INPUT' && t.type === 'text' && !el('dialogBox').contains(t)) t.blur();
  });
  // 勾选框 / 页内下拉选完把焦点还回来（不然空格 / 快捷键落在它们身上）
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!t || !el('dialog').hidden) return;
    if ((t.tagName === 'SELECT' && !e.isTrusted) || (t.tagName === 'INPUT' && t.type === 'checkbox')) setTimeout(() => { if (document.activeElement === t) t.blur(); }, 0);
  }, true);
  document.addEventListener('ddclose', () => renderInspectorSoon());
}

async function boot() {
  bindUI();
  await loadRuntime();
  initViews();
  let boot0 = {};
  try { boot0 = await API.json('/api/boot'); } catch (e) { /* 服务刚起 */ }
  S.boot = boot0;
  if (boot0.bundle && !boot0.bundle.ok && boot0.bundle.err && !S.rtErr) S.rtErr = boot0.bundle.err;
  const [playerJ, presetsJ, effectsJ] = await Promise.all([
    API.json('/api/player').catch(() => null),
    API.json('/api/presets').catch(() => ({ presets: [] })),
    API.json('/api/effects').catch(() => ({ effects: [] })),
    ensureImages(),
  ]);
  S.player = playerJ;
  S.presets = presetsJ.presets || [];
  S.effects = effectsJ.effects || [];
  S.link.on = true;
  el('linkOn').checked = true;
  await refreshAssets();
  const openId = boot0.open || (S.assets[0] ? S.assets[0].id : '');
  if (openId) await openTemplate(openId);
  renderAll();
  void pollLink();
  setInterval(() => { void pollLink(); }, STATUS_POLL_MS);
  requestAnimationFrame(frameLoop);
  if (S.rtErr) status(`⚠ 运行时包装不上：${S.rtErr}（能改能存，本地预览 / 站位不可用）`, 'err');
  else if (!el('status').textContent) status('就绪', 'ok');
  window.__ready = true;
}

// ---------------------------------------------------------------------------
// 桌面壳钩子
// ---------------------------------------------------------------------------
function unsavedSummary() {
  commitFocusedInput();
  refreshDirty();
  const parts = S.dirtyIds.map((id) => `模板「${id}」`);
  return parts.length ? `${parts.join('、')}有未保存的改动。` : '';
}
window.__unsavedSummary = unsavedSummary;
window.__saveUnsaved = () => {
  window.__saveUnsavedResult = 'pending';
  Promise.resolve(saveAll()).then(() => {
    window.__saveUnsavedResult = S.dirty ? (el('status').textContent || '没存上') : 'ok';
  }, (e) => { window.__saveUnsavedResult = String((e && e.message) || e); });
};
window.__onDiscardUnsaved = () => discardLiveWorkingCopy();
window.addEventListener('beforeunload', (e) => {
  if (!window.__discardUnsaved) commitFocusedInput();
  if (S.dirty && !window.__discardUnsaved) { e.preventDefault(); e.returnValue = ''; }
});
window.__openBurnable = (id) => {
  if (S.busy || HIST.drag) { status('正在装载 / 手势没松开，稍后再试', 'warn'); return; }
  void openTemplate(id);
};

window.addEventListener('DOMContentLoaded', () => { void boot(); });
