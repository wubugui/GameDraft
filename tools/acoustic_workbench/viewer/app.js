'use strict';
/* 声学工作台 · 页面主逻辑。
 *
 * 文档 S.doc = { id, def }（def 与 src/audio/acousticSpace.ts 的 AcousticSpaceDef 同形：M-world wu + distanceScale）。
 * 一切编辑走 op()/dragBegin-dragTick-dragEnd → afterEdit()：抬修订号、重算抽头、防抖发给游戏、重画。
 * 抽头 / IR **不在这里算**：/gen/acoustic.bundle.js 是运行时同一份 TS 打的包，工作台 import 它。
 * 保存只在这里（/api/save 原子写 acoustic_spaces.json）；游戏是预览器。 */

const S = {
  boot: null, scenes: [], spaces: [], probes: [],
  doc: null, dirty: false, rev: 0, cleanKey: '',
  scene: null, cal: null, marks: [], loadingScene: '', sceneOp: 0, fitted: false,
  align: null,   // 坐标对齐自证结果（checkAlignment）：工作台的世界 = 运行时的世界，装场景后算一次
  launching: false,   // 顶栏那颗「拉起 / 切场景」按钮的请求在飞
  sel: { kind: null, ids: new Set() },
  tool: 'move',
  taps: [], ir: null, irTimer: 0, acoustic: null, bundleErr: '',
  probeFromId: null,   // 试听从哪个声源发出：声源 id（不是下标——撤销 / 删除之后下标会漂），null = 听者自己喊
  direct: null,        // 试听声源到听者的直达声（运行时同一份 directPath）
  lastLiveEarKey: '',  // 上次按游戏活听者重算时的耳点（挪够远才重算）
  layers: { mesh: true, grid: true, taps: true, gameListener: true, marks: true, dimMesh: false },
  link: { enabled: true, gameUrl: '', connected: false, alive: false, status: null, lastRev: 0, appliedRev: 0, probeSeq: 0, timer: 0, inFlight: false, err: '', published: 0 },
  gameListener: null,
  busy: false, saving: false, cursor: null, io: Promise.resolve(),
};

// S.probeFrom：下标视图（-1 = 自己喊），底下按 id 存
Object.defineProperty(S, 'probeFrom', {
  get() { const def = S.doc && S.doc.def; if (!def || !S.probeFromId || !def.sources) return -1; const i = def.sources.findIndex((s) => s.id === S.probeFromId); return i; },
  set(i) { const def = S.doc && S.doc.def; S.probeFromId = def && def.sources && def.sources[i] ? def.sources[i].id : null; },
});
let v3 = null;
let history = null;
let statusTimer = 0;

// ---------------------------------------------------------------- host（3D 视图回调面）
const host = {
  get cal() { return S.cal; }, get doc() { return S.doc; }, get sel() { return S.sel; }, get tool() { return S.tool; },
  get taps() { return S.taps; }, get gameListener() { return S.gameListener; }, get marks() { return S.marks; }, get layers() { return S.layers; },
  metersPerWu() { return S.acoustic && S.doc ? S.acoustic.metersPerWu(S.doc.def) : (S.doc ? (S.doc.def.distanceScale || 1) / 88 : 1 / 88); },
  select, selectMany, clearSelection, dragBegin, dragTick, dragEnd, op, status, setTool,
  onCursorWorld(p) { S.cursor = p; renderCoords(); },
  /** 听者 / 第 i 个声源的点对象（3D 视图拖拽用） */
  pointOf(who, i) { const def = S.doc && S.doc.def; if (!def) return null; return who === 'listener' ? def.listener : ((def.sources || [])[i || 0] || null); },
  get probeFrom() { return S.probeFrom; },
  /** 抽头 / 直达正按游戏里活的听者算（游戏在这个场景）：3D 路径也从那个耳点画 */
  get liveEarActive() { return !!liveEar(); },
  /** 试听从哪个发声点发出（wu，绝对点）；null = 听者自己 */
  get probeSource() { const def = S.doc && S.doc.def; return def ? probeSourcePoint(def) : null; },
  /** 加一个有位置的声源（点地面），并把试听切到它 */
  addSource(p) {
    const def = S.doc.def;
    def.sources = def.sources || [];
    def.sources.push({ id: uniqueSourceId('声源'), x: round3(p.x), z: round3(p.z), y: round3(p.y || 0) });
    S.sel = { kind: 'source', ids: new Set([def.sources.length - 1]) };
    S.probeFrom = def.sources.length - 1;
  },
  addWall(a, b) {
    const def = S.doc.def;
    const n = def.reflectors.length + 1;
    const y = round3(Math.min(a[1], b[1]));
    const len = Math.hypot(b[0] - a[0], b[2] - a[2]);
    const r = { id: uniqueReflectorId(`崖壁${n}`), a: [round3(a[0]), round3(a[2])], b: [round3(b[0]), round3(b[2])], height: round3(Math.max(150, Math.min(1200, len * 0.6))), absorb: 0.08, rough: 0.4 };
    if (y !== 0) r.y = y;
    op('加崖壁', () => { Geo.orientToward(r, def.listener); def.reflectors.push(r); });
    select('reflector', def.reflectors.length - 1, false);
    setTool('move');
    status(`加了「${r.id}」：拖 gizmo 箭头挪（绿 Y = 底高程）、拖 ▲ 改高、拖端点改形状，检视器里调吸收 / 粗糙`);
  },
  addPlane(a, b) {
    const def = S.doc.def;
    const n = def.reflectors.length + 1;
    const len = Math.hypot(b[0] - a[0], b[2] - a[2]);
    const r = { id: uniqueReflectorId(`水面${n}`), a: [round3(a[0]), round3(a[2])], b: [round3(b[0]), round3(b[2])], height: round3(Math.max(40, len * 0.6)), absorb: 0.12, rough: 0.25, y: round3(a[1]), tiltDeg: 90 };
    op('加水平面', () => { def.reflectors.push(r); });
    select('reflector', def.reflectors.length - 1, false);
    setTool('move');
    status(`加了「${r.id}」（水平面）：拖 gizmo 的绿 Y 箭头改它的高度；改名成"岩檐"并抬到头顶就是檐`);
  },
  setPoint(who, p, i) {
    const pt = host.pointOf(who, i); if (!pt) return;
    pt.x = round3(p.x); pt.z = round3(p.z); pt.y = round3(p.y || 0);
  },
};

// ---------------------------------------------------------------- 编辑骨架
function keyOf(doc) { return JSON.stringify(doc); }
function touchDoc() { S.rev += 1; }
function afterEdit(light) {
  touchDoc();
  S.dirty = keyOf(S.doc) !== S.cleanKey;
  sanitizeSelection();
  recompute(light);
  schedulePublish();
  if (light) { v3.draw(); renderInspectorSoft(); renderStatusBar(); } else render();
}
function op(label, fn) {
  if (!S.doc || S.busy) return false;
  const changed = history.commit(label, fn);
  if (changed) afterEdit(false); else { v3.draw(); }
  return changed;
}
function dragBegin(label) { if (!S.doc || S.busy) return; history.beginDrag(label); }
function dragTick(fn) { if (!history.inDrag()) return; fn(); afterEdit(true); }
function dragEnd() { const changed = history.endDrag(); if (changed) afterEdit(false); else render(); }

function sanitizeSelection() {
  const def = S.doc && S.doc.def;
  if (!def) { S.sel = { kind: null, ids: new Set() }; return; }
  if (S.sel.kind === 'reflector') { for (const i of [...S.sel.ids]) if (!def.reflectors[i]) S.sel.ids.delete(i); if (!S.sel.ids.size) S.sel.kind = null; }
  if (S.sel.kind === 'source') { for (const i of [...S.sel.ids]) if (!def.sources || !def.sources[i]) S.sel.ids.delete(i); if (!S.sel.ids.size) S.sel.kind = null; }
  if (S.probeFromId && S.probeFrom < 0) S.probeFromId = null;   // 那个声源没了（删了 / 撤销了）：回到自己喊
}
function select(kind, i, additive) {
  const def = S.doc && S.doc.def;
  if (!def) return;
  if (kind === 'reflector' && !def.reflectors[i]) { clearSelection(); return; }
  if (kind === 'source' && !(def.sources && def.sources[i])) { clearSelection(); return; }
  if (kind === 'reflector') {
    if (additive && S.sel.kind === 'reflector') { if (S.sel.ids.has(i)) S.sel.ids.delete(i); else S.sel.ids.add(i); if (!S.sel.ids.size) S.sel.kind = null; }
    else S.sel = { kind: 'reflector', ids: new Set([i]) };
  } else S.sel = { kind, ids: new Set([kind === 'source' ? i : 0]) };
  // 试听跟着选择走：选中哪个声源就从它发出，选中听者就是自己喊（选反射面不动）
  const wantFrom = kind === 'source' ? i : kind === 'listener' ? -1 : null;
  if (wantFrom !== null && wantFrom !== S.probeFrom) { S.probeFrom = wantFrom; recompute(false); }
  render();
}
function selectMany(ids, add) {
  if (add && S.sel.kind === 'reflector') for (const i of ids) S.sel.ids.add(i);
  else S.sel = { kind: 'reflector', ids: new Set(ids) };
  render();
}
function clearSelection() { S.sel = { kind: null, ids: new Set() }; render(); }
function setTool(t) {
  S.tool = t;
  document.querySelectorAll('#tools button[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
  v3.draw();
}
function uniqueSourceId(base) {
  const ids = new Set(((S.doc.def.sources) || []).map((s) => s.id));
  if (!ids.has(base)) return base;
  let n = 2; while (ids.has(`${base}${n}`)) n++;
  return `${base}${n}`;
}
/** 试听从哪个发声点发出：S.probeFrom 指向 def.sources 的下标，-1 = 听者自己（自己喊） */
function probeSourcePoint(def) {
  const s = def.sources && def.sources[S.probeFrom];
  if (!s) return null;
  if (S.acoustic) return S.acoustic.sourcePoint(def, s);
  const h = typeof s.height === 'number' ? s.height : (def.earHeight == null ? 141 : def.earHeight);
  return { x: s.x, y: (s.y || 0) + h, z: s.z };
}
/** 游戏里活的耳点（同一场景、游戏在跑）；工作台的抽头 / 直达按它算，没有就按作者态听者 */
function liveEar() {
  const gL = S.gameListener;
  if (!gL || !gL.ear || !S.link.alive || !S.link.connected) return null;
  return { x: gL.ear[0], y: gL.ear[1], z: gL.ear[2] };
}

function bindingLabel(b) {
  const m = (b && b.mode) || 'player';
  return m === 'camera' ? '跟相机' : m === 'entity' ? `跟 NPC ${b.entityId || '?'}` : m === 'fixed' ? '钉在作者点' : (b && b.mode ? '跟玩家' : '跟玩家（缺省）');
}
function uniqueReflectorId(base) {
  const ids = new Set((S.doc.def.reflectors || []).map((r) => r.id));
  if (!ids.has(base)) return base;
  let n = 2; while (ids.has(`${base}_${n}`)) n++;
  return `${base}_${n}`;
}
function status(msg, kind) {
  const e = el('status'); e.textContent = msg || ''; e.className = kind || '';
  clearTimeout(statusTimer);
  if (msg) statusTimer = setTimeout(() => { if (e.textContent === msg) { e.textContent = ''; e.className = ''; } }, 8000);
}

// ---------------------------------------------------------------- 声学（运行时同一份实现）
function recompute(light) {
  const def = S.doc && S.doc.def;
  if (!def || !S.acoustic) { S.taps = []; S.ir = null; return; }
  const src = probeSourcePoint(def);
  const ear = liveEar();
  const o = {}; if (src) o.source = src; if (ear) o.ear = ear;
  try { S.taps = S.acoustic.collectTaps(def, o); S.direct = S.acoustic.directPath(def, o); }
  catch (e) { S.taps = []; S.direct = null; status('抽头算不出来：' + e.message, 'err'); }
  clearTimeout(S.irTimer);
  S.irTimer = setTimeout(() => {
    const d = S.doc && S.doc.def; if (!d || !S.acoustic) return;
    const src2 = probeSourcePoint(d), ear2 = liveEar();
    const o2 = { sampleRate: 24000 }; if (src2) o2.source = src2; if (ear2) o2.ear = ear2;
    try { S.ir = S.acoustic.buildImpulseResponse(d, o2); } catch (e) { S.ir = null; }
    renderIR();
  }, light ? 220 : 60);
}

// ---------------------------------------------------------------- 与游戏的联动
function schedulePublish() {
  if (!S.link.enabled || !S.doc) return;
  clearTimeout(S.link.timer);
  S.link.timer = setTimeout(() => { void publishNow(null); }, 120);
}
async function publishNow(probe) {
  if (!S.link.enabled || !S.doc) return { ok: false };
  clearTimeout(S.link.timer);
  const body = { spaceId: S.doc.id, def: S.doc.def, sceneId: S.scene ? S.scene.id : undefined };
  if (probe) body.probe = probe;
  try {
    const r = await API.post('/api/link/publish', body);
    if (r.rev) { S.link.lastRev = r.rev; S.link.published += 1; S.link.err = ''; S.link.publishErr = ''; S.link.lastPublishAt = Date.now(); }
    else notePublishError(r.err || '发不出去');
    renderLinkChip();
    return r;
  } catch (e) { notePublishError(e.message); renderLinkChip(); return { ok: false, err: e.message }; }
}
/** 发布被拒（定义没过校验等）：芯片红字 + 状态栏说一次，且不被下一拍心跳冲掉，直到下一次发布成功 */
function notePublishError(msg) {
  const changed = S.link.publishErr !== msg;
  S.link.publishErr = msg; S.link.err = msg;
  if (changed) status(`游戏没收到这次改动：${msg}`, 'err');
}
async function linkTick() {
  if (S.link.inFlight) return;
  S.link.inFlight = true;
  try {
    const r = await API.json('/api/link/status');
    S.link.connected = !!r.connected; S.link.alive = !!r.gameAlive; S.link.status = r.doc || null;
    S.link.otherPages = Array.isArray(r.otherPages) ? r.otherPages : [];
    S.link.console = !!r.console; S.link.launchNote = r.launchNote || '';
    // 服务端会自己重新发现游戏地址（控制台把游戏起来后跟上）：地址变了同步到输入框，别让人看着旧的
    if (r.gameUrl && r.gameUrl !== S.link.gameUrl) { S.link.gameUrl = r.gameUrl; if (document.activeElement !== el('gameUrl')) el('gameUrl').value = r.gameUrl; }
    if (!r.connected) S.link.err = r.err || '连不上游戏 dev server';
    else if (!S.link.publishErr) S.link.err = '';   // 发布被拒的红字不被心跳冲掉
    const st = r.doc;
    // 游戏刚接上（或换了地址重新接上）：把手上这份立刻发过去，别等作者再动一下才有预览。
    // 另外槽有 5 分钟新鲜期：作者盯着 3D 看了半天没改东西，游戏那边换个场景就套不回来了——定时续一次。
    const wasAlive = S.link.wasAlive; S.link.wasAlive = !!r.gameAlive;
    const now = Date.now();
    if (S.doc && S.link.enabled && r.gameAlive && (!wasAlive || now - (S.link.lastPublishAt || 0) > 180000)) { S.link.lastPublishAt = now; void publishNow(null); }
    if (st && r.gameAlive) {
      S.link.appliedRev = st.appliedRev || 0;
      // 游戏听者：只有游戏站在本工作台正展开的场景里才画进 3D（别的场景的世界坐标画进来毫无意义）
      S.gameListener = st.listener && S.scene && st.sceneId === S.scene.id ? Object.assign({}, st.listener, { stale: false }) : null;
    } else { S.gameListener = null; }
    // 抽头 / 直达按游戏活听者算：耳点挪够远（或从有到无）才重算，别每 400ms 重建一次 IR
    const e = liveEar(); const key = e ? `${Math.round(e.x / 60)},${Math.round(e.y / 60)},${Math.round(e.z / 60)}` : '';
    if (key !== S.lastLiveEarKey) { S.lastLiveEarKey = key; recompute(true); renderTaps(); v3.draw(); }
    renderLinkChip(); renderGamePanel();
    v3.draw();
  } catch (e) { S.link.connected = false; S.link.err = e.message; renderLinkChip(); }
  finally { S.link.inFlight = false; }
}
async function probe(id) {
  if (!S.doc) return;
  S.link.probeSeq += 1;
  const seq = S.link.probeSeq;
  const def = S.doc.def, at = probeSourcePoint(def);
  const r = await publishNow({ seq, sfxId: id, at: at || null });
  if (r.probeSeq) S.link.probeSeq = r.probeSeq;   // 序号由服务端发（页面刷新后从 0 数起会被游戏当旧序号吞掉）
  const p = S.probes.find((x) => x.id === id);
  const gap = S.taps.length ? S.taps[0].delay : null;
  const st = S.link.status;
  const from = at ? `从「${def.sources[S.probeFrom].id}」` : '听者自己';
  if (!S.link.enabled) status('联动已关：工作台只算不放。要听就打开顶栏「联动」', 'warn');
  else if (!r.ok) status(`试听发不出去：${r.err || '游戏 dev server 没起'}；工作台脱离游戏只算不放`, 'warn');
  else if (!S.link.alive) status('已发给 dev server，但游戏没在跑（或没开 ?mode=dev）', 'warn');
  else if (st && st.audioUnlocked === false) status('游戏里音频还没解锁：去游戏窗口点一下再试', 'warn');
  else {
    const d = S.direct;
    const dtxt = at && d ? `　直达 ${fmt(d.length, 1)}m${d.inaudible ? '（⚠ 超出最远距离，游戏不播）' : d.occluded ? `（被挡 ${fmt(d.occluded * 100, 0)}%）` : ''}` : '';
    const sec = p ? p.seconds : 0;
    const earTxt = liveEar() ? '（按游戏里的听者算）' : '（按作者态听者算，游戏没在这个场景）';
    status(`${from}试听 ${p ? p.label : id}${dtxt}　` + (gap === null ? '（没有反射面，只有干声）'
      : gap > sec ? `首回 ${gap.toFixed(2)}s > 干声 ${sec}s：原声—空白—回音` : `首回 ${gap.toFixed(2)}s ≤ 干声 ${sec}s：回音压在原声上`) + earTxt);
    verifyProbeOutput(S.link.probeSeq);
  }
}
/** 试听"发出去了" ≠ "出声了"：等游戏回传最近 3 秒主输出峰值，没动静就红字（2026-09-08 试听全哑就是这么漏掉的）。 */
function verifyProbeOutput(seq) {
  setTimeout(() => {
    const st = S.link.status;
    if (!st || S.link.probeSeq !== seq || !S.link.alive) return;
    const pk = st.outputPeakDb;
    // 先看序号（游戏真起播了才会把它推到 seq），再看电平（只量空间音总线，BGM 冒充不了）
    if ((st.probeSeqPlayed || 0) < seq) status(`⚠ 游戏没播这次试听（它回传的已播序号 ${st.probeSeqPlayed || 0} < ${seq}）：超出最远距离？看游戏 F2 声学页 / console`, 'err');
    else if (typeof pk === 'number' && pk > -60) status(`游戏出声了 ✓ 空间音峰值 ${fmt(pk, 1)} dBFS`, 'ok');
    else status('⚠ 游戏起播了，但空间音 3 秒内一片静默：检查系统音量 / 输出设备 / 游戏 console', 'err');
  }, 2600);
}
/** 一键拉起游戏进当前场景：服务端按现状决定是切场景 / 开页 / 起服务；进度经状态轮询的 launchNote 回来。 */
async function launchGame(forceOpen) {
  if (!S.scene) { status('先装一个场景', 'warn'); return; }
  S.launching = true; renderLaunchButton();
  try {
    const r = await API.post('/api/link/launch', { sceneId: S.scene.id, forceOpen: !!forceOpen });
    status(r.message || '已发出', r.ok ? '' : 'err');
    if (r.gameUrl) { S.link.gameUrl = r.gameUrl; el('gameUrl').value = r.gameUrl; }
  } catch (e) { status('拉不起游戏：' + e.message, 'err'); }
  finally { S.launching = false; renderLaunchButton(); }
}
/**
 * 顶栏那颗按钮按现状换脸（作者按了才动，不硬同步）：
 * 没游戏 = 拉起进本场景；游戏在别的场景 = 切过来；游戏已在本场景 = 灰掉。
 */
function renderLaunchButton() {
  const b = el('btnLaunchGame'), L = S.link, st = L.status, here = S.scene && S.scene.id;
  const alive = !!(L.enabled && L.connected && L.alive && st);
  // 游戏页跑在普通浏览器里（音频没靠手势解锁不了）才露出「专用窗重开」
  const reopen = el('btnReopenGame');
  reopen.hidden = !(alive && here && st.autoplayAllowed === false);
  reopen.disabled = S.launching;
  if (!here) { b.textContent = '▶ 拉起游戏'; b.disabled = true; b.title = '先装一个场景'; return; }
  if (!alive) {
    b.textContent = `▶ 拉起游戏进「${here}」`; b.disabled = S.launching;
    b.title = '一键拉起游戏进这个场景：dev server 在跑就用专用预览窗打开游戏页（免手势音频、不后台降级、不缓存）；'
      + '都没有就让开发控制台起游戏服务（没开控制台就工作台自己起）';
    return;
  }
  if (st.sceneId === here) {
    b.textContent = `游戏已在「${here}」`; b.disabled = true;
    b.title = '游戏正在这个场景里。工作台换了场景，这里会变成「切过去」——按了才切，不会自动跟';
    return;
  }
  b.textContent = `⇄ 游戏切到「${here}」`; b.disabled = S.launching;
  b.title = `游戏现在在「${st.sceneId}」。按了才切（走运行时命令队列，几秒），不会自动跟着工作台切`;
}

// ---------------------------------------------------------------- 坐标对齐自证（工作台的世界 = 运行时的世界）
/**
 * 运行时那份 `SceneSpaceGeometry`：把工作台装到的标定与行走面场按运行时 `sceneSpace.ts` 的形状喂回去。
 * 于是运行时的 `groundWorldAt` / `worldToScene` 可以在页面里原样跑——同一份代码，不是"照着写的"。
 */
function runtimeGeo() {
  const cal = S.cal, ss = S.acoustic && S.acoustic.sceneSpace;
  if (!cal || !cal.ground || !ss) return null;
  return {
    work: { w: cal.ground.w, h: cal.ground.h },
    cal: { ppu: cal.ppu, cx: cal.cx, cy: cal.cy },
    sceneWorld: { w: cal.worldW, h: cal.worldH },
    basisRows: cal.rows, wuPerQUnit: cal.wuPerQ,
    ground: { data: cal.ground.data, w: cal.ground.w, h: cal.ground.h },
  };
}
/** 画面点 → 脚下地面世界点：有运行时包就用运行时的函数，没有才退工作台自己的 SceneCal。 */
function localGroundWorld(sx, sy) {
  const geo = runtimeGeo();
  if (geo) return S.acoustic.sceneSpace.groundWorldAt(geo, sx, sy);
  if (S.cal && S.cal.ground) return S.cal.sceneToWorldGround(sx, sy);
  return null;
}
/**
 * 对齐自证：同一批画面点分别过**运行时的** `groundWorldAt` 与工作台的 SceneCal；服务端算的出生点 / NPC 世界点再对一次；
 * 场景网格顶点反过来经运行时 `worldToScene` 投回画面、对它自己的 uv；视线方向两边点积。
 * 镜像 / 错基 / 错尺任何一环，Δ 就是几十上百 wu，场景芯片直接红字（自检 S1 也钉着它）。
 */
function checkAlignment() {
  const geo = runtimeGeo(); if (!geo) return null;
  const ss = S.acoustic.sceneSpace, cal = S.cal;
  const d3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  let dPts = 0, n = 0;
  for (let i = 1; i <= 5; i++) for (let j = 1; j <= 5; j++) {
    const sx = cal.worldW * i / 6, sy = cal.worldH * j / 6;
    dPts = Math.max(dPts, d3(ss.groundWorldAt(geo, sx, sy), cal.sceneToWorldGround(sx, sy))); n++;
  }
  let dMarks = 0;
  for (const m of S.marks) if (m.scene && m.world) { dMarks = Math.max(dMarks, d3(ss.groundWorldAt(geo, m.scene[0], m.scene[1]), m.world)); n++; }
  // 网格：uv 是像素中心 (px+0.5)/w，顶点是像素角 px，所以允许 1 px（画面 wu）
  let dMesh = 0, nMesh = 0;
  const mesh = v3 && v3.mesh;
  if (mesh && mesh.verts && mesh.nv) {
    const step = Math.max(1, Math.floor(mesh.nv / 96)), vs = mesh.verts;
    for (let i = 0; i < mesh.nv; i += step) {
      const s = ss.worldToScene(geo, [vs[i * 5], vs[i * 5 + 1], vs[i * 5 + 2]]);
      dMesh = Math.max(dMesh, Math.hypot(s.x - vs[i * 5 + 3] * cal.worldW, s.y - vs[i * 5 + 4] * cal.worldH)); nMesh++;
    }
  }
  const pxWu = cal.worldW / Math.max(cal.work.w, 1);
  const vr = ss.viewDirWorld(geo), vw = cal.viewDirWorld();
  const viewDot = vr[0] * vw[0] + vr[1] * vw[1] + vr[2] * vw[2];
  const ok = dPts < 0.5 && dMarks < 0.5 && dMesh < pxWu * 1.5 + 0.5 && viewDot > 0.9999;
  return { ok, dPts, dMarks, dMesh, dMax: Math.max(dPts, dMarks, dMesh), n, nMesh, viewDot };
}
function alignText() {
  const a = S.align;
  if (!a) return S.acoustic ? '' : '　坐标自证：没有运行时包，对不了';
  return a.ok ? `　坐标：与运行时同一套 ✓（${a.n + a.nMesh} 点 Δ${fmt(a.dMax, 2)} wu）` : `　⚠ 坐标与运行时不一致：Δ ${fmt(a.dMax, 1)} wu`;
}
function updateSceneNote() {
  const sum = S.scene, cal = S.cal;
  if (!sum) return;
  el('sceneNote').textContent = cal
    ? `${sum.name}　${sum.native.w}×${sum.native.h}　1 q = ${fmt(cal.wuPerQ, 0)} wu　地面:${sum.cal.groundSource}${alignText()}`
    : `${sum.name}　⚠ 没有深度：先在照明实验室烘一次，才能 3D 展开`;
  el('sceneNote').className = 'chip' + (S.align && !S.align.ok ? ' bad' : '');
}
function refreshAlignment() { S.align = checkAlignment(); updateSceneNote(); }

// ---------------------------------------------------------------- 装载
function setBusy(on, text) {
  S.busy = on;
  el('busy').hidden = !on; el('busyText').textContent = text || '';
  el('app').inert = on;
}
async function loadScene(sid, bg) {
  const opId = ++S.sceneOp;
  S.loadingScene = sid;
  setBusy(true, `装载场景 ${sid}…`);
  try {
    const sum = (await API.json(`/api/scene?id=${encodeURIComponent(sid)}&bg=${encodeURIComponent(bg || '')}`)).scene;
    if (opId !== S.sceneOp) return false;
    const q = `id=${encodeURIComponent(sid)}&bg=${encodeURIComponent(sum.background)}`;
    let cal = null, mesh = null, img = null;
    const jobs = [API.image(`/api/scene_bg?${q}&w=1600`)];
    if (sum.cal) jobs.push(API.bin(`/api/scene_mesh?${q}&stride=2`), API.bin(`/api/scene_ground?${q}`), API.bin(`/api/scene_heightfield?${q}`), API.bin(`/api/scene_shell?${q}`));
    const res = await Promise.all(jobs);
    if (opId !== S.sceneOp) return false;
    img = res[0];
    if (sum.cal) {
      cal = new SceneCal(sum.cal, sum.worldWidth, sum.worldHeight);
      mesh = res[1]; cal.setGround(res[2]); cal.setHeightfield(res[3]); cal.setShell(res[4]);
    }
    // 全部到齐再一次性提交
    S.scene = sum; S.cal = cal; S.marks = sum.marks || [];
    v3.setMesh(mesh); v3.setTexture(img);
    el('sceneSel').value = sid;
    fillBgSel(sum);
    if (!S.fitted || true) { v3.fit(true); S.fitted = true; }
    refreshAlignment();
    if (S.align && !S.align.ok) status(`⚠ 这个场景的 3D 展开与运行时换算对不上（Δ ${fmt(S.align.dMax, 1)} wu），别照着它摆`, 'err');
    return true;
  } catch (e) {
    status(`场景装不上：${e.message}`, 'err');
    if (S.scene) el('sceneSel').value = S.scene.id;   // 下拉别停在装不上的那个
    return false;
  } finally {
    if (opId === S.sceneOp) { S.loadingScene = ''; setBusy(false); render(); }
  }
}
async function openSpace(id) {
  if (S.busy) return;
  if (history.inDrag()) history.discardDrag();
  let r;
  try { r = await API.json(`/api/space?id=${encodeURIComponent(id)}`); } catch (e) { status(`打不开「${id}」：${e.message}`, 'err'); return; }
  S.doc = { id: r.id, def: r.def };
  S.sel = { kind: null, ids: new Set() };
  history.clear();
  S.cleanKey = keyOf(S.doc); S.dirty = false; S.rev += 1;
  el('spaceSel').value = id;
  const au = S.doc.def.authoring || {};
  const row = S.spaces.find((s) => s.id === id);
  const sid = au.sceneId || (row && row.boundBy && row.boundBy[0]) || (S.scene && S.scene.id) || (S.scenes[0] && S.scenes[0].id);
  if (sid && !(S.scene && S.scene.id === sid && (!au.background || au.background === S.scene.background))) await loadScene(sid, au.background || '');
  recompute(false);
  render();
  await publishNow(null);
  status(`打开「${id}」${au.sceneId ? '' : '（这个空间没记作者场景，保存时会记下当前场景）'}`);
}
window.__openSpace = (id) => { if (S.busy || history.inDrag()) { status('正在装载 / 手势中，稍后再切', 'warn'); return; } void confirmDiscard().then((ok) => { if (ok) openSpace(id); }); };

async function refreshSpaces() {
  S.spaces = (await API.json('/api/spaces')).spaces;
  fillSpaceSel();
  if (S.doc) el('spaceSel').value = S.doc.id;
}
function fillSpaceSel() {
  const sel = el('spaceSel'); sel.replaceChildren();
  for (const s of S.spaces) sel.append(h('option', { value: s.id }, `${s.id}${s.label ? ' · ' + s.label : ''}${s.boundBy.length ? '' : '（未绑定）'}`));
  if (!S.spaces.length) sel.append(h('option', { value: '' }, '（库里没有空间）'));
}
function fillSceneSel() {
  const sel = el('sceneSel'); sel.replaceChildren();
  for (const sc of S.scenes) sel.append(h('option', { value: sc.id }, `${sc.name}${sc.depth ? '' : '（无深度）'}${sc.acousticSpace ? ' ⟵ ' + sc.acousticSpace : ''}`));
}
function fillBgSel(sum) {
  const sel = el('bgSel'); sel.replaceChildren();
  for (const b of (sum.backgrounds || [])) sel.append(h('option', { value: b }, b));
  sel.value = sum.background; sel.hidden = (sum.backgrounds || []).length < 2;
}

// ---------------------------------------------------------------- 保存 / 新建 / 复制 / 改名 / 删除
function runIO(fn) { const p = S.io.then(fn, fn); S.io = p.catch(() => {}); return p; }
async function save() {
  if (!S.doc || S.busy) return false;
  if (history.inDrag()) { status('松手再保存', 'warn'); return false; }
  const def = deepClone(S.doc.def);
  if (!(def.authoring && def.authoring.sceneId) && S.scene) def.authoring = { sceneId: S.scene.id, background: S.scene.background };
  const rev0 = S.rev, id = S.doc.id;
  S.saving = true; renderStatusBar();
  try {
    const r = await runIO(() => API.post('/api/save', { id, def }));
    if (S.doc && S.doc.id === id && S.rev === rev0) {
      S.doc.def = r.def; S.cleanKey = keyOf(S.doc); S.dirty = false;
      status(`已保存 → ${r.path}`);
    } else status('保存期间又有改动，再按一次 Ctrl+S', 'warn');
    await refreshSpaces();
    render();
    return true;
  } catch (e) { status('保存失败：' + e.message, 'err'); return false; }
  finally { S.saving = false; renderStatusBar(); }
}
async function confirmDiscard() {
  if (!S.dirty) return true;
  const v = await dialog({ title: '有未保存的改动', body: `「${S.doc.id}」改过还没保存。`, ok: '丢弃改动', cancel: '留下' });
  return !!v;
}
async function createSpace() {
  if (!(await confirmDiscard())) return;
  const sceneId = S.scene ? S.scene.id : (S.scenes[0] && S.scenes[0].id);
  const v = await dialog({ title: '新建声学空间', fields: [{ key: 'id', label: 'id（也是场景里引用的键）', value: uniqueSpaceId(sceneId ? `${sceneId}_回音` : '新空间') }, { key: 'label', label: '说明', value: '' }], ok: '新建' });
  if (!v) return;
  try {
    await runIO(() => API.post('/api/create', { id: v.id.trim(), sceneId: sceneId || '', background: S.scene ? S.scene.background : '', label: v.label.trim() }));
    await refreshSpaces();
    await openSpace(v.id.trim());
    // 听者放到出生点脚下：落笔就在人站的地方
    const sp = S.marks.find((m) => m.kind === 'spawn');
    if (sp) op('听者放到出生点', () => host.setPoint('listener', { x: sp.world[0], y: sp.world[1], z: sp.world[2] }));
    status(`新建「${v.id.trim()}」：按 B 加崖壁，在画里的崖壁上按下拖一段；记得去主编辑器把场景绑到它`);
  } catch (e) { status('新建失败：' + e.message, 'err'); }
}
async function duplicateSpace() {
  if (!S.doc || !(await confirmDiscard())) return;
  const v = await dialog({ title: '复制空间', fields: [{ key: 'to', label: '新 id', value: uniqueSpaceId(S.doc.id + '_副本') }], ok: '复制' });
  if (!v) return;
  try { await runIO(() => API.post('/api/duplicate', { id: S.doc.id, to: v.to.trim() })); await refreshSpaces(); await openSpace(v.to.trim()); }
  catch (e) { status('复制失败：' + e.message, 'err'); }
}
async function renameSpace() {
  if (!S.doc || !(await confirmDiscard())) return;
  const v = await dialog({ title: '改名', body: '被场景绑定着的空间不能改名（场景 JSON 只有主编辑器写）；那种情况用「复制」。', fields: [{ key: 'to', label: '新 id', value: S.doc.id }], ok: '改名' });
  if (!v || v.to.trim() === S.doc.id) return;
  try { await runIO(() => API.post('/api/rename', { id: S.doc.id, to: v.to.trim() })); await refreshSpaces(); await openSpace(v.to.trim()); }
  catch (e) { status('改名失败：' + e.message, 'err'); }
}
async function deleteSpace() {
  if (!S.doc) return;
  const row = S.spaces.find((s) => s.id === S.doc.id);
  const bound = row && row.boundBy.length ? `场景 ${row.boundBy.join('、')} 绑着它，删了它们就没回音了。` : '';
  const v = await dialog({ title: `删除「${S.doc.id}」？`, body: bound + '磁盘上会留一份 .bak。', ok: '删除', danger: true });
  if (!v) return;
  try {
    const id = S.doc.id;
    await runIO(() => API.post('/api/delete', { id }));
    S.doc = null; S.dirty = false; history.clear();
    await refreshSpaces();
    if (S.spaces.length) await openSpace(S.spaces[0].id); else render();
    status(`已删除「${id}」`);
  } catch (e) { status('删除失败：' + e.message, 'err'); }
}
function uniqueSpaceId(base) { const ids = new Set(S.spaces.map((s) => s.id)); if (!ids.has(base)) return base; let n = 2; while (ids.has(`${base}_${n}`)) n++; return `${base}_${n}`; }
/**
 * 撤销 / 重做跨过了「换作者场景」：doc 里的作者场景变了，画布得跟着重装，
 * 否则就是"doc 指着 A、画布画着 B 还能存盘"。装载失败只报状态（doc 不动，作者自己再换）。
 */
async function syncSceneWithDoc() {
  const def = S.doc && S.doc.def; if (!def || S.busy) return;
  const au = def.authoring || {};
  if (!au.sceneId) return;
  const cur = S.scene;
  if (cur && cur.id === au.sceneId && (!au.background || au.background === cur.background)) return;
  const ok = await loadScene(au.sceneId, au.background || '');
  if (!ok) status(`作者场景「${au.sceneId}」装不上，画布仍是「${cur ? cur.id : '?'}」`, 'warn');
}
async function changeScene(sid, bg) {
  if (!S.doc) { await loadScene(sid, bg); return; }
  const ok = await loadScene(sid, bg);
  if (!ok) return;
  op('换作者场景', () => { S.doc.def.authoring = { sceneId: sid, background: S.scene.background }; });
  status(`「${S.doc.id}」现在按「${sid}」展开；保存后作者场景记为它`);
}

// ---------------------------------------------------------------- 对话框（页内，不用 prompt()）
function dialog(opts) {
  return new Promise((resolve) => {
    const box = el('dialog'), form = el('dialogForm');
    form.replaceChildren();
    form.append(h('h3', {}, opts.title || ''));
    if (opts.body) form.append(h('p', {}, opts.body));
    const inputs = {};
    for (const f of (opts.fields || [])) {
      const inp = h('input', { type: 'text', value: f.value || '' });
      inputs[f.key] = inp;
      form.append(h('label', { class: 'row' }, h('span', {}, f.label), inp));
    }
    const done = (v) => { box.hidden = true; resolve(v); };
    const okBtn = h('button', { type: 'submit', class: opts.danger ? 'danger' : 'primary' }, opts.ok || '确定');
    const cancel = h('button', { type: 'button', onclick: () => done(null) }, opts.cancel || '取消');
    form.append(h('div', { class: 'btns' }, cancel, okBtn));
    form.onsubmit = (e) => { e.preventDefault(); const v = {}; for (const k in inputs) v[k] = inputs[k].value; done(opts.fields ? v : true); };
    box.hidden = false;
    const first = Object.values(inputs)[0]; if (first) { first.focus(); first.select(); } else okBtn.focus();
  });
}

// ---------------------------------------------------------------- 渲染
function render() {
  sanitizeSelection();   // 渲染只读：选中集里指着已删 / 不存在的东西一律先清掉，别让检视器对着 undefined 炸
  renderSpaceList(); renderInspector(); renderTaps(); renderIR(); renderStatusBar(); renderLinkChip(); renderGamePanel(); renderCoords();
  updateUndoButtons();
  v3.draw();
}
function updateUndoButtons() {
  el('btnUndo').disabled = !history || !history.canUndo; el('btnRedo').disabled = !history || !history.canRedo;
  el('btnUndo').title = history && history.canUndo ? `撤销：${history.peekUndo()}（Ctrl+Z）` : '撤销（Ctrl+Z）';
  el('btnRedo').title = history && history.canRedo ? `重做：${history.peekRedo()}（Ctrl+Y）` : '重做（Ctrl+Y）';
}
function renderStatusBar() {
  const d = S.doc;
  el('docState').textContent = d ? `${d.id}${S.dirty ? ' ●' : ''}${S.saving ? '  保存中…' : ''}` : '（没有打开的空间）';
  el('btnSave').textContent = S.dirty ? '保存 ●' : '保存';
  el('btnSave').disabled = !d || S.saving;
  document.title = `声学工作台${d && d.id ? ' · ' + d.id + (S.dirty ? ' ●' : '') : ''}`;
}
function renderCoords() {
  const c = S.cursor, k = host.metersPerWu();
  el('coords').textContent = c ? `光标 世界 (${fmt(c[0], 0)}, ${fmt(c[1], 0)}, ${fmt(c[2], 0)}) wu = (${fmt(c[0] * k, 1)}, ${fmt(c[1] * k, 1)}, ${fmt(c[2] * k, 1)}) m` : '';
}
function renderLinkChip() {
  const chip = el('linkChip');
  const L = S.link;
  let txt, cls;
  if (!L.enabled) { txt = '联动关'; cls = 'off'; }
  else if (!L.connected) { txt = `未连游戏（${L.gameUrl || '?'}）`; cls = 'bad'; }
  else if (!L.alive) { txt = 'dev server 通，游戏没在跑'; cls = 'warn'; }
  else if (L.publishErr) { txt = `游戏没收到这份：${L.publishErr}`; cls = 'bad'; }
  else {
    const st = L.status || {};
    const synced = L.lastRev > 0 && st.appliedRev >= L.lastRev;
    txt = `游戏在「${st.sceneId || '?'}」${synced ? '，已套用#' + st.appliedRev : L.lastRev ? '，等套用#' + L.lastRev : ''}${st.pendingSpace ? '，等音频解锁才挂上' : st.audioUnlocked === false ? '，音频未解锁' : ''}`;
    cls = synced && !st.pendingSpace ? 'ok' : 'warn';
  }
  chip.textContent = txt; chip.className = 'chip ' + cls;
  chip.title = L.err ? L.err : `游戏 dev server: ${L.gameUrl}\n发了 ${L.published} 次，最近 rev ${L.lastRev}`;
  renderLaunchButton();
}
/**
 * 活的对齐证据：游戏回传的听者带「画面点 + 它自己算的世界点」，这里拿同一个画面点过本地换算再比。
 * 差得小 = 游戏用的基 / 尺 / 行走面与工作台是同一套；差几十 wu 以上就是两边不是一个世界。
 */
function gameCoordCheck(st) {
  const L = st.listener;
  if (L && L.mode === 'fixed' && !L.scene) return '听者钉在作者点上，没有画面点可比';
  if (!L || !L.scene) return '游戏没回传听者画面点';
  if (!S.scene || st.sceneId !== S.scene.id) return '游戏不在工作台展开的这个场景，比不了';
  if (!L.grounded) return '游戏那边没有行走面场（平面映射），比不了';
  const mine = localGroundWorld(L.scene.x, L.scene.y);
  if (!mine) return '本地没有行走面场，比不了';
  const d = Math.hypot(mine[0] - L.world[0], mine[1] - L.world[1], mine[2] - L.world[2]);
  if (d < 5) return `游戏听者与本地换算差 ${fmt(d, 1)} wu ✓ 同一套坐标`;
  if (d < 40) return `游戏听者与本地换算差 ${fmt(d, 0)} wu（两边行走面栅格不同，斜坡上会有几 wu）`;
  return `⚠ 游戏听者与本地换算差 ${fmt(d, 0)} wu：不是同一套坐标`;
}
function renderGamePanel() {
  const box = el('gamePanel'); box.replaceChildren();
  const st = S.link.status;
  const consoleLine = h('div', { class: 'dim' }, S.link.console ? '开发控制台：在（拉起游戏经它起服务）' : '开发控制台：没开（拉起游戏时工作台自己起服务）');
  const noteLine = S.link.launchNote ? h('div', { class: 'dim' }, '拉起：' + S.link.launchNote) : null;
  if (!S.link.enabled) { box.append(h('div', { class: 'dim' }, '联动已关：只在这里算，不发给游戏。')); return; }
  // append(null) 会把字面 "null" 当文本塞进去（真出现过），所以先滤掉
  if (!S.link.connected) { box.append(...[h('div', { class: 'dim' }, `连不上游戏 dev server（${S.link.gameUrl}）。脱离游戏也能编辑保存，只是听不到。按顶栏「▶ 拉起游戏进本场景」。`), consoleLine, noteLine].filter(Boolean)); return; }
  if (!S.link.alive || !st) { box.append(...[h('div', { class: 'dim' }, 'dev server 在跑但没开着游戏页（要 ?mode=dev）。按顶栏「▶ 拉起游戏进本场景」会打开它。'), consoleLine, noteLine].filter(Boolean)); return; }
  if (noteLine) box.append(noteLine);
  // 折米用哪个缩放：游戏挂着的就是本 doc 才用它的距离缩放；挂着别的空间就报 wu
  const sameSpace = S.doc && st.activeSpaceId === S.doc.id;
  const k = sameSpace ? host.metersPerWu() : 1;
  const unit = sameSpace ? 'm' : 'wu';
  const rows = [
    ['场景', `${st.sceneId || '?'}${S.scene && st.sceneId !== S.scene.id ? '（与工作台展开的不是同一个）' : ''}`],
    ['挂着', `${st.activeSpaceId || '无'}${st.boundSpaceId && st.boundSpaceId !== st.activeSpaceId ? `（场景绑定 ${st.boundSpaceId}）` : ''}`],
    ['听者', st.listener && st.listener.ear ? `${bindingLabel(st.listener)}（绑定来自${{ runtime: '运行时覆盖', scene: '场景 JSON', space: '声学空间', footstep: '脚步配置', default: '缺省' }[st.listener.from] || '?'}）　耳 (${fmt(st.listener.ear[0] * k, 1)}, ${fmt(st.listener.ear[1] * k, 1)}, ${fmt(st.listener.ear[2] * k, 1)}) ${unit}${st.listener.targetMissing ? '　⚠ 实体不在场，回落玩家' : ''}${st.listener.grounded ? '' : '　⚠ 平面映射'}${st.listener.perspF ? `　透视 f=${st.listener.perspF.toFixed(2)}（坐标已按透视重整，淡点是画面位置）` : ''}` : '—'],
    ['出声', typeof st.outputPeakDb === 'number' ? `空间音最近 3 秒峰值 ${fmt(st.outputPeakDb, 1)} dBFS` : '空间音静默（按试听 / 走两步后这里该有数，没有就是没出声）'],
    ['坐标', gameCoordCheck(st)],
    ['抽头', `${st.tapCount}　重算 ${fmt(st.costMs, 0)}ms${st.costMs > 25 ? ' ⚠' : ''}　挪 ${fmt(st.thresholdM, 0)}m 才重算`],
    ['音频', st.audioUnlocked
      ? (st.autoplayAllowed ? '已解锁（免手势预览窗，一直有声）' : '已解锁')
      : '未解锁：这页跑在普通浏览器里。按顶栏「⧉ 专用窗重开」，或去页里点一下'],
    ['页面', `${st.href || '?'}${st.autoplayAllowed ? '　专用预览窗' : ''}`],
  ];
  const others = S.link.otherPages || [];
  if (others.length) {
    rows.push(['⚠ 多开', `另有 ${others.length} 个游戏页也在回传（${others.map((p) => `${p.href || '?'}${p.autoplayAllowed ? '·预览窗' : '·普通页'}`).join('，')}）。`
      + '两个页会抢同一条通道，把旧的关掉；切场景只指挥上面这页'] );
  }
  for (const [a, b] of rows) box.append(h('div', { class: 'kv' }, h('span', {}, a), h('span', {}, b)));
}
function renderSpaceList() {
  const box = el('reflList'); box.replaceChildren();
  const def = S.doc && S.doc.def;
  if (!def) return;
  const k = host.metersPerWu();
  const L = def.listener;
  const byId = new Map();
  for (const t of S.taps) if (t.order === 1) for (const id of t.reflectorIds) if (!byId.has(id)) byId.set(id, t);
  def.reflectors.forEach((r, i) => {
    const on = S.sel.kind === 'reflector' && S.sel.ids.has(i);
    const m = Geo.mid(r);
    const t = byId.get(r.id || `#${i}`);
    const dist = Math.hypot(m[0] - L.x, m[1] - L.z) * k;
    const row = h('div', { class: 'item' + (on ? ' on' : ''), onclick: (e) => select('reflector', i, e.shiftKey), ondblclick: () => focusSelection() },
      h('span', { class: 'ic' }, Geo.isHorizontal(r) ? '▬' : '▮'),
      h('span', { class: 'name' }, r.id || `#${i}`),
      h('span', { class: 'dim' }, `${fmt(dist, 0)}m${t ? '  ' + t.delay.toFixed(2) + 's' : ''}${t && t.occluded ? ' 被挡' : ''}`));
    box.append(row);
  });
  const onL = S.sel.kind === 'listener';
  box.append(h('div', { class: 'item' + (onL ? ' on' : ''), onclick: () => select('listener', 0, false), ondblclick: () => focusSelection() },
    h('span', { class: 'ic' }, '●'), h('span', { class: 'name' }, `听者 · ${bindingLabel(def.listenerBinding)}`),
    h('span', { class: 'dim' }, S.probeFrom < 0 ? '▶ 自己喊' : '')));
  (def.sources || []).forEach((s, i) => {
    const on = S.sel.kind === 'source' && S.sel.ids.has(i);
    box.append(h('div', { class: 'item' + (on ? ' on' : ''), onclick: () => select('source', i, false), ondblclick: () => focusSelection() },
      h('span', { class: 'ic' }, '◆'), h('span', { class: 'name' }, s.id),
      h('span', { class: 'dim' }, `${fmt(Math.hypot(s.x - L.x, s.z - L.z) * k, 1)}m${S.probeFrom === i ? '　▶ 试听' : ''}`)));
  });
  if (!def.reflectors.length) box.append(h('div', { class: 'dim pad' }, '还没有反射面。按 B 加崖壁：在画里的崖壁上按下、拖一段松手。'));
}

function numField(label, get, set, o) {
  o = o || {};
  const inp = h('input', { type: 'number', step: o.step || 1, value: fmt(get(), o.digits == null ? 1 : o.digits) });
  if (o.min != null) inp.min = o.min; if (o.max != null) inp.max = o.max;
  inp.addEventListener('change', () => { const v = num(inp.value, NaN); if (!Number.isFinite(v)) { inp.value = fmt(get(), 1); return; } op(o.label || ('改 ' + label), () => set(o.min != null || o.max != null ? clamp(v, o.min == null ? -Infinity : o.min, o.max == null ? Infinity : o.max) : v)); });
  inp.addEventListener('keydown', (e) => e.stopPropagation());
  const row = h('label', { class: 'row' }, h('span', {}, label), inp);
  if (o.unit) row.append(h('span', { class: 'unit' }, o.unit));
  return row;
}
function slider(label, get, set, o) {
  const inp = h('input', { type: 'range', min: o.min, max: o.max, step: o.step, value: get() });
  const out = h('span', { class: 'val' }, o.show ? o.show(get()) : fmt(get(), 2));
  let dragging = false;
  inp.addEventListener('pointerdown', () => { dragging = true; dragBegin(o.label || ('改 ' + label)); });
  inp.addEventListener('input', () => { const v = num(inp.value, get()); out.textContent = o.show ? o.show(v) : fmt(v, 2); if (dragging) dragTick(() => set(v)); else op(o.label || ('改 ' + label), () => set(v)); });
  const end = () => { if (!dragging) return; dragging = false; dragEnd(); };
  inp.addEventListener('pointerup', end); inp.addEventListener('pointercancel', end); inp.addEventListener('change', end);
  inp.addEventListener('keydown', (e) => e.stopPropagation());
  return h('label', { class: 'row' }, h('span', {}, label), inp, out);
}
function renderInspectorSoft() {
  // 拖拽中只刷数字，不重建控件（重建会把正在拖的滑条弄成孤儿）
  const def = S.doc && S.doc.def; if (!def) return;
  const box = el('inspector');
  box.querySelectorAll('[data-live]').forEach((e) => { try { e.textContent = e._live(); } catch (_) { /* 旧闭包对着已删的对象 */ } });
}
function renderInspector() {
  const box = el('inspector'); box.replaceChildren();
  const def = S.doc && S.doc.def;
  if (!def) { box.append(h('div', { class: 'dim pad' }, '打开或新建一个空间。')); return; }
  const k = host.metersPerWu();
  const live = (fn) => { const e = h('span', { class: 'dim', 'data-live': '1' }, fn()); e._live = fn; return e; };
  const sec = (title, ...kids) => { const d = h('div', { class: 'sec' }, h('h3', {}, title)); for (const c of kids) if (c) d.append(c); return d; };

  if (S.sel.kind === 'reflector' && S.sel.ids.size === 1) {
    const i = [...S.sel.ids][0], r = def.reflectors[i];
    const horiz = Geo.isHorizontal(r);
    const nameInp = h('input', { type: 'text', value: r.id || '' });
    nameInp.addEventListener('change', () => op('改名', () => { r.id = nameInp.value.trim() || `#${i}`; }));
    nameInp.addEventListener('keydown', (e) => e.stopPropagation());
    const kindSel = h('select', {}, h('option', { value: '0' }, '竖直崖壁'), h('option', { value: '90' }, '水平面（水面 / 岩檐）'));
    kindSel.value = horiz ? '90' : '0';
    kindSel.addEventListener('change', () => op('改朝向', () => { if (kindSel.value === '90') r.tiltDeg = 90; else delete r.tiltDeg; }));
    const m = Geo.mid(r);
    const distM = () => `中点离听者 ${fmt(Math.hypot(m[0] - def.listener.x, m[1] - def.listener.z) * k, 1)} m　长 ${fmt(Geo.len(r) * k, 1)} m　${horiz ? '宽' : '高'} ${fmt(r.height * k, 1)} m`;
    box.append(sec(`反射面 ${r.id || '#' + i}`,
      h('label', { class: 'row' }, h('span', {}, '名字'), nameInp),
      h('label', { class: 'row' }, h('span', {}, '类型'), kindSel),
      live(distM),
      numField(horiz ? '面高程' : '底高程', () => r.y || 0, (v) => { r.y = round3(v); }, { step: 10, unit: 'wu' }),
      numField(horiz ? '宽' : '高', () => r.height, (v) => { r.height = round3(Math.max(1, v)); }, { step: 10, min: 1, unit: 'wu' }),
      slider('吸收', () => r.absorb, (v) => { r.absorb = round3(v); }, { min: 0, max: 1, step: 0.01 }),
      slider('粗糙', () => r.rough, (v) => { r.rough = round3(v); }, { min: 0, max: 1, step: 0.01 }),
      h('div', { class: 'btns' },
        h('button', { onclick: () => op('复制反射面', () => { const c = deepClone(r); c.id = uniqueReflectorId((r.id || '面') + '_副本'); Geo.translate(c, 40, 40, 0); def.reflectors.push(c); S.sel = { kind: 'reflector', ids: new Set([def.reflectors.length - 1]) }; }) }, '复制'),
        h('button', { onclick: () => op('翻转朝向', () => { const t = r.a; r.a = r.b; r.b = t; }) }, '调换 A/B'),
        h('button', { class: 'danger', onclick: () => deleteSelection() }, '删除'))));
  } else if (S.sel.kind === 'reflector' && S.sel.ids.size > 1) {
    const ids = [...S.sel.ids];
    box.append(sec(`选中 ${ids.length} 个反射面`,
      h('div', { class: 'dim' }, 'W 拖动整体移动，E 旋转，R 缩放（以包围盒中心为轴）。'),
      slider('吸收（批量）', () => def.reflectors[ids[0]].absorb, (v) => { for (const i of ids) def.reflectors[i].absorb = round3(v); }, { min: 0, max: 1, step: 0.01 }),
      slider('粗糙（批量）', () => def.reflectors[ids[0]].rough, (v) => { for (const i of ids) def.reflectors[i].rough = round3(v); }, { min: 0, max: 1, step: 0.01 }),
      h('div', { class: 'btns' }, h('button', { class: 'danger', onclick: () => deleteSelection() }, '删除'))));
  } else if (S.sel.kind === 'listener') {
    const p = def.listener, lb = def.listenerBinding || { mode: 'player' };
    const sceneOv = S.scene && S.scene.acousticListener;
    const modes = [['player', '跟玩家（耳朵在玩家脚点上方）'], ['camera', '跟相机（画面中心地面点上方，再退一段）'], ['entity', '跟指定 NPC'], ['fixed', '钉在这里（作者摆的点）']];
    const modeSel = h('select', {}, ...modes.map(([v, t]) => h('option', { value: v }, t)));
    modeSel.value = lb.mode;
    modeSel.addEventListener('change', () => op('改听者绑定', () => {
      // 一律写显式：没写的话运行时按「空间级缺省 = 跟玩家」，但落盘的数据得自己说清楚
      const m = modeSel.value;
      def.listenerBinding = Object.assign({ mode: m }, m === 'entity' && lb.entityId ? { entityId: lb.entityId } : {});
    }));
    const npcIds = (S.marks || []).filter((m) => m.kind === 'npc').map((m) => m.id);
    const entSel = h('select', {}, h('option', { value: '' }, '（选一个 NPC）'), ...npcIds.map((id) => h('option', { value: id }, id)));
    entSel.value = lb.entityId || '';
    entSel.addEventListener('change', () => op('改听者实体', () => { def.listenerBinding = { mode: 'entity', entityId: entSel.value }; }));
    const warn = (t) => h('div', { class: 'dim', style: 'color:var(--warn)' }, t);
    box.append(sec('听者',
      h('div', { class: 'dim' }, '游戏里谁是耳朵。脚步、试听、回音全用这一个听者；耳高取「整体」里的耳高。'),
      h('label', { class: 'row' }, h('span', {}, '绑到'), modeSel),
      lb.mode === 'entity' ? h('label', { class: 'row' }, h('span', {}, 'NPC'), entSel) : null,
      lb.mode === 'entity' && !lb.entityId ? warn('还没选 NPC：游戏里会回落到玩家') : null,
      lb.mode === 'entity' && lb.entityId && npcIds.length && !npcIds.includes(lb.entityId) ? warn(`「${lb.entityId}」不在作者场景的 NPC 里；游戏里找不到会回落到玩家`) : null,
      sceneOv ? warn(`场景 JSON 另设了「${bindingLabel(sceneOv)}」，游戏以场景的为准；要用这里的设置，去主编辑器把场景那项清掉`) : null,
      h('div', { class: 'dim' }, lb.mode === 'fixed' ? '耳朵钉在下面这个点上方：' : '下面这个点是作者态位置（工作台里算抽头用、`fixed` 时用）；游戏里按上面的绑定走：'),
      numField('x', () => p.x, (v) => { p.x = round3(v); }, { step: 10, unit: 'wu' }),
      numField('z', () => p.z, (v) => { p.z = round3(v); }, { step: 10, unit: 'wu' }),
      numField('地面 y', () => p.y || 0, (v) => { p.y = round3(v); }, { step: 10, unit: 'wu' }),
      h('div', { class: 'btns' },
        S.cal && S.cal.hf ? h('button', { onclick: () => op('贴地', () => { p.y = round3(S.cal.groundHeight(p.x, p.z)); }) }, '贴到地面') : null,
        S.gameListener && S.gameListener.world ? h('button', { onclick: () => op('听者放到游戏听者处', () => { const w = S.gameListener.world; p.x = round3(w[0]); p.y = round3(w[1]); p.z = round3(w[2]); }) }, '放到游戏听者处') : null)));
  } else if (S.sel.kind === 'source' && S.sel.ids.size) {
    const i = [...S.sel.ids][0], sp = def.sources[i];
    const nameInp = h('input', { type: 'text', value: sp.id });
    nameInp.addEventListener('change', () => { const v = nameInp.value.trim(); if (!v) { nameInp.value = sp.id; return; } if (def.sources.some((o, j) => j !== i && o.id === v)) { status(`已经有一个声源叫「${v}」`, 'warn'); nameInp.value = sp.id; return; } op('改声源名', () => { if (S.probeFromId === sp.id) S.probeFromId = v; sp.id = v; }); });
    nameInp.addEventListener('keydown', (e) => e.stopPropagation());
    const isFrom = S.probeFrom === i;
    box.append(sec(`声源 ${sp.id}`,
      h('div', { class: 'dim' }, '一个有物理位置的发声点：直达声按它到耳朵的距离与方位算，回音按它的镜像算。脚步 / NPC 在游戏里就是这样的声源，这里摆的是试听用的。'),
      h('label', { class: 'row' }, h('span', {}, '名字'), nameInp),
      numField('x', () => sp.x, (v) => { sp.x = round3(v); }, { step: 10, unit: 'wu' }),
      numField('z', () => sp.z, (v) => { sp.z = round3(v); }, { step: 10, unit: 'wu' }),
      numField('地面 y', () => sp.y || 0, (v) => { sp.y = round3(v); }, { step: 10, unit: 'wu' }),
      numField('发声高度', () => (sp.height == null ? (def.earHeight == null ? 141 : def.earHeight) : sp.height), (v) => { sp.height = round3(Math.max(0, v)); }, { step: 5, min: 0, unit: 'wu' }),
      liveEar() ? h('div', { class: 'dim' }, '下面按游戏里活的听者算（游戏在这个场景）') : h('div', { class: 'dim' }, '下面按作者态听者算（游戏不在这个场景）'),
      live(() => (S.direct && isFrom)
        ? `到耳朵 ${fmt(S.direct.length, 1)} m　延迟 ${fmt(S.direct.delay * 1000, 0)} ms　增益 ${fmt(S.direct.gain, 2)}　声像 ${fmt(S.direct.pan, 2)}${S.direct.occluded ? `　被挡 ${fmt(S.direct.occluded * 100, 0)}%` : ''}${S.direct.inaudible ? '　⚠ 超出最远距离，游戏不播' : ''}`
        : '（按「从这里试听」后显示直达声）'),
      h('div', { class: 'btns' },
        h('button', { class: isFrom ? 'primary' : '', onclick: () => { S.probeFrom = i; recompute(false); render(); status(`试听改从「${sp.id}」发出`); } }, isFrom ? '▶ 试听正从这里发出' : '从这里试听'),
        S.cal && S.cal.hf ? h('button', { onclick: () => op('贴地', () => { sp.y = round3(S.cal.groundHeight(sp.x, sp.z)); }) }, '贴到地面') : null,
        h('button', { class: 'danger', onclick: () => deleteSelection() }, '删除声源'))));
  }

  // 整体
  const labelInp = h('input', { type: 'text', value: def.label || '' });
  labelInp.addEventListener('change', () => op('改说明', () => { if (labelInp.value.trim()) def.label = labelInp.value.trim(); else delete def.label; }));
  labelInp.addEventListener('keydown', (e) => e.stopPropagation());
  const ds = () => def.distanceScale || 1;
  box.append(sec('整体',
    h('label', { class: 'row' }, h('span', {}, '说明'), labelInp),
    slider('距离缩放', () => Math.log10(ds()), (v) => { def.distanceScale = round3(Math.pow(10, v)); }, { min: 0, max: Math.log10(60), step: 0.01, label: '改距离缩放', show: (v) => `×${fmt(Math.pow(10, v), 2)}` }),
    live(() => `1 wu = ${fmt(1000 * host.metersPerWu(), 2)} mm；画里 1 米 = 声学里 ${fmt(ds(), 2)} 米。所有距离一律缩放（含耳高）。`),
    numField('耳高', () => def.earHeight == null ? 141 : def.earHeight, (v) => { def.earHeight = round3(Math.max(0, v)); }, { step: 5, min: 0, unit: 'wu' }),
    live(() => `耳高 = ${fmt((def.earHeight == null ? 141 : def.earHeight) * host.metersPerWu(), 2)} m${(def.earHeight || 0) > 400 ? '　⚠ 人的耳朵离脚 1.6 米上下；想表达"站得高"请抬地面 y，别抬耳高' : ''}`),
    h('label', { class: 'row' }, h('span', {}, '反射阶'), (() => { const s = h('select', {}, h('option', { value: '1' }, '一阶'), h('option', { value: '2' }, '二阶（像空间）')); s.value = String(def.order || 2); s.addEventListener('change', () => op('改反射阶', () => { def.order = Number(s.value); })); return s; })()),
    slider('尾长 s', () => (def.tail ? def.tail.seconds : 0), (v) => { (def.tail || (def.tail = { seconds: 0, gain: 0 })).seconds = round3(v); }, { min: 0, max: 8, step: 0.1 }),
    slider('尾强', () => (def.tail ? def.tail.gain : 0), (v) => { (def.tail || (def.tail = { seconds: 0, gain: 0 })).gain = round3(v); }, { min: 0, max: 0.6, step: 0.01 }),
    slider('立体宽', () => (def.width == null ? 0.8 : def.width), (v) => { def.width = round3(v); }, { min: 0, max: 1, step: 0.05 }),
    numField('气温 ℃', () => (def.air && def.air.tempC != null ? def.air.tempC : 5), (v) => { (def.air || (def.air = {})).tempC = round3(v); }, { step: 1 }),
    (() => { const c = h('input', { type: 'checkbox', checked: def.occlusion !== false }); c.addEventListener('change', () => op('改遮挡', () => { def.occlusion = c.checked; })); return h('label', { class: 'row' }, h('span', {}, '遮挡'), c, h('span', { class: 'dim' }, '被别的面挡住的反射压下去')); })(),
    h('div', { class: 'btns' },
      h('button', { onclick: () => { setTool('placeSource'); status('点地面放一个声源（可以放多个）'); } }, '加声源'),
      h('button', { class: S.probeFrom < 0 ? 'primary' : '', onclick: () => { S.probeFrom = -1; recompute(false); render(); status('试听改为听者自己喊'); } }, S.probeFrom < 0 ? '▶ 试听：听者自己喊' : '试听改为自己喊')),
    h('div', { class: 'dim' }, `听者绑定：${bindingLabel(def.listenerBinding)}（点左栏「听者」改）`)));
  const dd = { refDistanceM: 7, rolloff: 1, maxDistanceM: 40, panWidth: 0.7 };
  const dget = (k) => (def.direct && def.direct[k] != null ? def.direct[k] : dd[k]);
  const dset = (k, v) => { (def.direct || (def.direct = {}))[k] = round3(v); };
  box.append(sec('直达声（有位置的声源）',
    h('div', { class: 'dim' }, '声源到耳朵不经反射那一记：脚步、NPC、试听声源都走它。全是声学米（已含距离缩放）。近于参考距离不再变响。'),
    numField('参考距离', () => dget('refDistanceM'), (v) => dset('refDistanceM', Math.max(0.01, v)), { step: 1, min: 0.01, unit: 'm' }),
    numField('衰减系数', () => dget('rolloff'), (v) => dset('rolloff', Math.max(0, v)), { step: 0.1, min: 0, digits: 2 }),
    numField('最远', () => dget('maxDistanceM'), (v) => dset('maxDistanceM', Math.max(0.01, v)), { step: 5, min: 0.01, unit: 'm' }),
    slider('声像宽', () => dget('panWidth'), (v) => dset('panWidth', v), { min: 0, max: 1, step: 0.05 })));
  const au = def.authoring || {};
  box.append(sec('数据', h('div', { class: 'dim' }, `作者场景：${au.sceneId || '（未记，保存时记当前场景）'}${au.background ? ' / ' + au.background : ''}`),
    h('div', { class: 'dim' }, `绑定它的场景：${(S.spaces.find((s) => s.id === S.doc.id) || { boundBy: [] }).boundBy.join('、') || '无（去主编辑器场景属性里选）'}`)));
}
function renderTaps() {
  const box = el('taps'); box.replaceChildren();
  const def = S.doc && S.doc.def;
  if (!def) return;
  if (!S.acoustic) { box.append(h('div', { class: 'dim' }, '运行时模块没打成包：' + (S.bundleErr || '?'))); return; }
  const srcSel = def.sources && def.sources[S.probeFrom];
  const d = S.direct;
  box.append(h('div', { class: 'dim' }, `${liveEar() ? '按游戏活听者' : '按作者态听者'} · ${srcSel ? `从「${srcSel.id}」发出` : '听者自己喊'}${srcSel && d
    ? `　直达 ${fmt(d.length, 1)}m · ${fmt(d.delay * 1000, 0)}ms · 增益 ${fmt(d.gain, 2)} · 声像 ${fmt(d.pan, 2)}${d.occluded ? ` · 被挡 ${fmt(d.occluded * 100, 0)}%` : ''}${d.inaudible ? ' · ⚠ 超出最远距离' : ''}`
    : ''}`));
  if (!S.taps.length) { box.append(h('div', { class: 'dim' }, '没有反射面 → 只有干声。')); return; }
  const gap = S.taps[0].delay;
  const hints = S.probes.map((p) => `${p.label.split(' ')[0]}${gap > p.seconds ? '✓' : '✗'}`).join(' ');
  box.append(h('div', { class: 'dim' }, `首回 ${gap.toFixed(3)}s　放得下：${hints}　共 ${S.taps.length} 抽头`));
  const tbl = h('table', {}, h('tr', {}, h('th', {}, '阶'), h('th', {}, '面'), h('th', {}, '路径 m'), h('th', {}, '延迟 s'), h('th', {}, '方位°'), h('th', {}, '增益'), h('th', {}, '挡')));
  for (const t of S.taps.slice(0, 14)) tbl.append(h('tr', { class: t.occluded ? 'occ' : '' }, h('td', {}, String(t.order)), h('td', {}, t.reflectorIds.join('→')), h('td', {}, fmt(t.length, 0)), h('td', {}, t.delay.toFixed(3)), h('td', {}, fmt(t.azimuth * 180 / Math.PI, 0)), h('td', {}, t.gain.toFixed(4)), h('td', {}, t.occluded ? fmt(t.occluded * 100, 0) + '%' : '')));
  box.append(tbl);
}
function renderIR() {
  const c = el('irCanvas'); const g = c.getContext('2d');
  const W = c.width = c.clientWidth * (window.devicePixelRatio || 1), H = c.height = c.clientHeight * (window.devicePixelRatio || 1);
  g.clearRect(0, 0, W, H);
  const ir = S.ir; if (!ir || !ir.left.length) { g.fillStyle = 'rgba(255,255,255,.4)'; g.font = `${11 * (window.devicePixelRatio || 1)}px sans-serif`; g.fillText(S.doc ? (S.acoustic ? 'IR 计算中…' : '无 IR') : '', 8, 18); return; }
  const n = ir.left.length, sr = ir.sampleRate, secs = n / sr;
  const bins = Math.max(1, Math.floor(W));
  g.fillStyle = '#12151b'; g.fillRect(0, 0, W, H);
  g.strokeStyle = 'rgba(255,255,255,.12)';
  for (let s = 1; s < secs; s++) { const x = s / secs * W; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
  g.fillStyle = '#ffb454';
  for (let b = 0; b < bins; b++) {
    const i0 = Math.floor(b / bins * n), i1 = Math.max(i0 + 1, Math.floor((b + 1) / bins * n));
    let pk = 0; for (let i = i0; i < i1; i++) { const v = Math.abs(ir.left[i]); if (v > pk) pk = v; }
    if (pk <= 1e-6) continue;
    const db = 20 * Math.log10(pk); const hh = clamp((db + 60) / 60, 0, 1) * H;
    g.fillRect(b, H - hh, 1, hh);
  }
  if (ir.taps.length) { const x = ir.taps[0].delay / secs * W; g.strokeStyle = '#6cb4ff'; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
  g.fillStyle = 'rgba(255,255,255,.7)'; g.font = `${11 * (window.devicePixelRatio || 1)}px sans-serif`;
  g.fillText(`IR ${secs.toFixed(1)}s · 每格 1s · 纵轴 -60..0 dB`, 8, 14 * (window.devicePixelRatio || 1));
}

// ---------------------------------------------------------------- 选择集操作
function deleteSelection() {
  const def = S.doc && S.doc.def; if (!def) return;
  if (S.sel.kind === 'reflector' && S.sel.ids.size) {
    const ids = [...S.sel.ids].sort((a, b) => b - a);
    op(`删除 ${ids.length} 个反射面`, () => { for (const i of ids) def.reflectors.splice(i, 1); S.sel = { kind: null, ids: new Set() }; });
  } else if (S.sel.kind === 'source' && S.sel.ids.size) {
    const i = [...S.sel.ids][0];
    op('删声源', () => { def.sources.splice(i, 1); if (!def.sources.length) delete def.sources; S.sel = { kind: null, ids: new Set() }; });
  }
}
function focusSelection() {
  const def = S.doc && S.doc.def; if (!def) return;
  if (S.sel.kind === 'reflector' && S.sel.ids.size) { const b = Geo.bounds([...S.sel.ids].map((i) => def.reflectors[i])); v3.focus([b.cx, b.cy, b.cz], Math.max(b.x1 - b.x0, b.z1 - b.z0, b.y1 - b.y0)); }
  else if (S.sel.kind === 'source' && S.sel.ids.size && def.sources && def.sources[[...S.sel.ids][0]]) { const sp = def.sources[[...S.sel.ids][0]]; v3.focus([sp.x, sp.y || 0, sp.z], 150); }
  else v3.focus([def.listener.x, def.listener.y || 0, def.listener.z], 150);
}
function duplicateSelection() {
  const def = S.doc && S.doc.def; if (!def || S.sel.kind !== 'reflector' || !S.sel.ids.size) return;
  op('复制反射面', () => {
    const add = [];
    for (const i of [...S.sel.ids].sort((a, b) => a - b)) { const c = deepClone(def.reflectors[i]); c.id = uniqueReflectorId((c.id || '面') + '_副本'); Geo.translate(c, 40, 40, 0); def.reflectors.push(c); add.push(def.reflectors.length - 1); }
    S.sel = { kind: 'reflector', ids: new Set(add) };
  });
}

// ---------------------------------------------------------------- 键盘
function onKey(e) {
  const t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
  if (S.busy) return;
  if (!el('dialog').hidden) {   // 对话框开着：Esc = 取消，其它键别碰后面的文档
    if (e.key === 'Escape') { const c = [...el('dialogForm').querySelectorAll('button')].find((b) => b.type !== 'submit'); if (c) c.click(); }
    return;
  }
  if (v3 && v3.ok && v3.capturesKeys()) return;   // 按住右键飞行中：W/A/S/D/Q/E 归相机（view3d 在捕获阶段已吃掉，这里是保险）
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); const l = history.undo(); if (l) status('撤销：' + l); return; }
  if (ctrl && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); const l = history.redo(); if (l) status('重做：' + l); return; }
  if (ctrl && (e.key === 's' || e.key === 'S')) { e.preventDefault(); void save(); return; }
  if (ctrl && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); duplicateSelection(); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelection(); return; }
  if (e.key === 'Escape') { if (S.tool !== 'move') setTool('move'); else clearSelection(); return; }
  if (e.key === 'f' || e.key === 'F') { focusSelection(); return; }
  if (e.key === 'Home') { v3.fit(true); return; }
  const map = { q: 'select', w: 'move', e: 'rotate', r: 'scale', b: 'addWall', n: 'addPlane', l: 'placeListener', p: 'placeSource' };
  const k = e.key.toLowerCase();
  // 按着右键时 WASD/QE 是飞行键（3D 视图自己吃掉），松开右键就是工具键
  if (map[k] && !e.shiftKey && !ctrl && !e.altKey && !(v3 && v3.flying())) { setTool(map[k]); return; }
  if (e.key.startsWith('Arrow')) {
    e.preventDefault();
    const s = e.shiftKey ? 100 : 10;
    if (e.key === 'ArrowLeft') v3.nudge(-s, 0); else if (e.key === 'ArrowRight') v3.nudge(s, 0); else if (e.key === 'ArrowUp') v3.nudge(0, s); else v3.nudge(0, -s);
  }
}

// ---------------------------------------------------------------- 启动
async function boot() {
  v3 = new View3D(el('view3d'), el('overlay3d'), host);
  if (!v3.ok) { el('sceneNote').textContent = '这台机器拿不到 WebGL2，3D 视图不可用'; }
  history = new History({ get: () => S.doc, set: (d) => { S.doc = d; afterEdit(false); void syncSceneWithDoc(); }, onChange: updateUndoButtons });
  new ResizeObserver(() => v3.resize()).observe(el('center'));
  v3.resize();
  window.addEventListener('keydown', onKey);
  document.querySelectorAll('#tools button[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
  el('btnSave').addEventListener('click', () => { void save(); });
  el('btnUndo').addEventListener('click', () => { const l = history.undo(); if (l) status('撤销：' + l); });
  el('btnRedo').addEventListener('click', () => { const l = history.redo(); if (l) status('重做：' + l); });
  el('btnNew').addEventListener('click', () => { void createSpace(); });
  el('btnDup').addEventListener('click', () => { void duplicateSpace(); });
  el('btnRename').addEventListener('click', () => { void renameSpace(); });
  el('btnDelete').addEventListener('click', () => { void deleteSpace(); });
  el('btnFit').addEventListener('click', () => v3.fit(true));
  el('btnFocus').addEventListener('click', () => focusSelection());
  el('btnLaunchGame').addEventListener('click', () => { void launchGame(false); });
  el('btnReopenGame').addEventListener('click', () => { void launchGame(true); });
  el('spaceSel').addEventListener('change', async () => { const id = el('spaceSel').value; if (!id || (S.doc && id === S.doc.id)) return; if (await confirmDiscard()) await openSpace(id); else el('spaceSel').value = S.doc ? S.doc.id : ''; });
  el('sceneSel').addEventListener('change', () => { void changeScene(el('sceneSel').value, ''); });
  el('bgSel').addEventListener('change', () => { void changeScene(S.scene.id, el('bgSel').value); });
  el('linkOn').addEventListener('change', () => { S.link.enabled = el('linkOn').checked; renderLinkChip(); renderGamePanel(); if (S.link.enabled) schedulePublish(); });
  el('gameUrl').addEventListener('change', async () => { try { const r = await API.post('/api/link/config', { gameUrl: el('gameUrl').value }); S.link.gameUrl = r.gameUrl; el('gameUrl').value = r.gameUrl; status('游戏地址改为 ' + r.gameUrl); } catch (e) { status(e.message, 'err'); } });
  el('gameUrl').addEventListener('keydown', (e) => e.stopPropagation());
  for (const key of Object.keys(S.layers)) { const c = el('layer_' + key); if (c) { c.checked = S.layers[key]; c.addEventListener('change', () => { S.layers[key] = c.checked; v3.draw(); }); } }

  let bootInfo;
  try {
    const [b, sc, sp, pr] = await Promise.all([API.json('/api/boot'), API.json('/api/scenes'), API.json('/api/spaces'), API.json('/api/probes')]);
    bootInfo = b; S.scenes = sc.scenes; S.spaces = sp.spaces; S.probes = pr.probes;
    S.link.gameUrl = b.gameUrl; el('gameUrl').value = b.gameUrl;
    if (!b.bundle.ok) S.bundleErr = b.bundle.err;
  } catch (e) { status('启动失败：' + e.message, 'err'); return; }
  const probeRow = el('probes'); probeRow.replaceChildren();
  for (const p of S.probes) probeRow.append(h('button', { onclick: () => { void probe(p.id); }, title: p.id }, '▶ ' + p.label));
  fillSceneSel(); fillSpaceSel();
  try { S.acoustic = await import('/gen/acoustic.bundle.js?t=' + Date.now()); }
  catch (e) { S.acoustic = null; S.bundleErr = S.bundleErr || e.message; status('运行时模块没装上，抽头 / IR 不显示：' + S.bundleErr, 'warn'); }
  if (S.scene) refreshAlignment();   // 包比场景晚到时补一次自证
  setTool('move');
  const first = bootInfo.open || (S.spaces[0] && S.spaces[0].id);
  if (first) await openSpace(first); else if (S.scenes[0]) { await loadScene(S.scenes[0].id, ''); render(); }
  void linkTick();
  setInterval(() => { void linkTick(); }, 400);
  window.__ready = true;
}

window.addEventListener('beforeunload', (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });
document.addEventListener('DOMContentLoaded', () => { void boot(); });
