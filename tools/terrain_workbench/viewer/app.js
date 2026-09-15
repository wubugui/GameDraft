'use strict';
/* 地形工作台 · 交互层。
 *
 * 数据：`S.doc` = terrain.json 内容（网格单位）；`S.brush`（Uint8Array，0 自动 / 1 可走 / 2 阻挡）；`S.height`（Float32Array，
 * 高度增量，网格单位）；`S.auto`（烘焙器的自动结果）。三样合成 = `composeCollision`（Python 合成器的镜像，真相在服务端）。
 * 每次改动 → 本地即时合成 + 连通性 flood → 上色；保存 / 推给游戏 / 导出走服务端合成。
 *
 * 保存 = 写作者层（terrain/）；推给游戏（P）= 页面此刻的工作态合成进本机预览、游戏原地换上、资源不动；
 * 导出到游戏（B）= 先保存，再合成进资源。三条都是服务端 `terrain_compose.export_terrain`。
 *
 * 单位：文档网格单位；页面显示 wu = 网格单位 × `S.k`（SceneCal.wuPerQ）。世界点一律 wu 数组 [x, y, z]。 */

const STATUS_POLL_MS = 1000;
const DRAFT_MS = 8000;
const JOB_POLL_MS = 500;
const PROBE_N = 64;
const LIFT_WU = 1.2;
const REGION_RGB = { walk: [0.35, 0.95, 0.45], block: [1, 0.55, 0.2] };
const OP_RGB = [0.45, 0.6, 1];
const S = {
  scenes: [], scene: null, cal: null, marks: [], bg: null, k: 1, bgName: '',
  doc: null, grid: null, brush: null, height: null, auto: null,
  composed: null, reach: null, reachIssues: [], stats: null,
  colors: null, colorsRev: 0, cellPos: null, cellQuads: null, cellOutline: null, cellPx: 1,
  sel: { key: '' }, gizmoMode: 'move', tool: 'select', view: 3,
  brushOpt: { mode: 'block', radiusWu: 30 },
  heightOpt: { sub: 'sculpt', mode: 'raise', radiusWu: 80, strengthWu: 4, polyKind: 'flatten', valueWu: 0, featherWu: 40 },
  draft: null,
  layers: { mesh: true, dimMesh: false, grid: false, cells: true, walkTint: false, cellLines: false, reach: true, height: true, regions: true, marks: true },
  dirty: false, cleanKey: '', baseUpdated: null, needsExport: false, busy: 0, loadingScene: '', sceneOp: 0,
  link: { status: null, align: null, probeSeq: 0, probeCells: null, probeAt: 0, lastAlignRev: -1 },
  job: null, cursor: null, inspect: null, docRev: 0, composeRev: 0,
};
let v3 = null, v2 = null, history = null;
let draftTimer = 0, probeTimer = 0;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
function status(msg, kind) { const s = el('status'); s.textContent = msg || ''; s.className = kind || ''; }
function isTypingTarget(t) { return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || !!t.isContentEditable); }
function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }
function gu(v) { return v / S.k; }
function wu(v) { return v * S.k; }
function fmtWu(v, n) { return fmt(v * S.k, n == null ? 0 : n); }
function gridToWorld(x, z) { const wx = wu(x), wz = wu(z); return [wx, (S.cal ? S.cal.groundHeight(wx, wz) : 0) + LIFT_WU, wz]; }
function worldToGrid(p) { return [gu(p[0]), gu(p[2])]; }
function setBusy(on, text) {
  S.busy += on ? 1 : -1;
  if (S.busy < 0) S.busy = 0;
  el('busy').hidden = S.busy === 0;
  el('busyText').textContent = text || '';
  el('app').toggleAttribute('inert', S.busy > 0);
}
function stateKey() { return S.doc ? JSON.stringify({ doc: S.doc, brush: S.brush ? u8ToB64(S.brush) : null, height: S.height ? f32ToB64(S.height) : null }) : ''; }
function currentState() { return { doc: S.doc, brush: S.brush && S.brush.some((v) => v) ? u8ToB64(S.brush) : null, height: S.height && S.height.some((v) => v) ? f32ToB64(S.height) : null }; }
function markClean() { S.cleanKey = stateKey(); S.dirty = false; renderDocState(); }
function refreshDirty() { const d = stateKey() !== S.cleanKey; if (d !== S.dirty) { S.dirty = d; renderDocState(); } }
function touch() { S.docRev++; }
function nextId(prefix, arr) { let n = 1; const ids = new Set((arr || []).map((r) => r.id)); while (ids.has(`${prefix}${n}`)) n++; return `${prefix}${n}`; }
let ioChain = Promise.resolve();
function runIO(fn) { const p = ioChain.then(fn, fn); ioChain = p.catch(() => {}); return p; }

// ---------------------------------------------------------------------------
// 合成 / 连通性 / 上色
// ---------------------------------------------------------------------------
function recompose() {
  if (!S.doc || !S.grid) { S.composed = null; S.reach = null; S.reachIssues = []; return; }
  S.composed = composeCollision(S.grid, S.auto, S.brush, S.doc.regions || []);
  // 每个出生点各 flood 一份（判据：**每个**出生点都要走得到每个出口 / 站位，与服务端 audit_walkable 同）；上色用并集
  const spawns = S.marks.filter((m) => m.kind === 'spawn');
  S.reachBy = spawns.map((m) => ({ mark: m, reach: floodReach(S.composed.blocked, S.grid, [worldToGrid(m.world)]) }));
  S.reach = new Uint8Array(S.grid.n);
  for (const r of S.reachBy) for (let i = 0; i < S.reach.length; i++) if (r.reach[i]) S.reach[i] = 1;
  S.reachIssues = reachIssues();
  const b = S.composed.blocked, on = S.onGround; let nb = 0, nOn = 0; for (let i = 0; i < b.length; i++) { nb += b[i]; if (!on || on[i]) nOn++; }
  let unreach = 0; for (let i = 0; i < b.length; i++) if (!b[i] && !S.reach[i] && (!on || on[i])) unreach++;
  S.stats = { cells: b.length, blocked: nb, unreachable: unreach, walkable: b.length - nb, onGround: nOn };
  S.composeRev++;
  rebuildColors();
  scheduleProbe();
}
/** 连通性判据（与服务端 audit_walkable.reach_issues 同：出生点 flood → 出口 / 站位范围内要有可走格；落点必须可走） */
function reachIssues() {
  const out = [];
  const g = S.grid, blocked = S.composed.blocked;
  const spawns = S.reachBy || [];
  if (!spawns.length) out.push({ kind: 'info', text: '场景没有出生点：连通性无从谈起', bad: false });
  const withinReach = (m, reach) => {
    const r = gu(m.range || 60);
    const [cx, cz] = worldToGrid(m.world);
    const [ga, gb] = g.cellOf(cx - r, cz - r), [gc, gd] = g.cellOf(cx + r, cz + r);
    for (let j = Math.max(0, gb); j <= Math.min(g.h - 1, gd); j++) for (let i = Math.max(0, ga); i <= Math.min(g.w - 1, gc); i++) {
      const dx = g.centerX(i) - cx, dz = g.centerZ(j) - cz;
      if (dx * dx + dz * dz <= r * r && reach[g.idx(i, j)]) return true;
    }
    return false;
  };
  for (const m of S.marks) {
    if (m.kind === 'exit' || m.kind === 'align') {
      const failed = spawns.filter((s) => !withinReach(m, s.reach)).map((s) => s.mark.id);
      const ok = !failed.length;
      out.push({ kind: m.kind, id: m.id, text: `${m.kind === 'exit' ? '出口' : '站位'} ${m.id}：${ok ? '每个出生点都走得到' : `从 ${failed.join('、')} 走不到——被阻挡格切成了孤岛`}`, bad: !ok, world: m.world });
    } else if (m.kind === 'landing') {
      const [gx, gz] = g.cellOf(...worldToGrid(m.world));
      const bad = g.inside(gx, gz) && !!blocked[g.idx(gx, gz)];
      out.push({ kind: 'landing', id: m.id, text: `落点 ${m.id}：${bad ? '落在阻挡格里——跳过去就卡死' : '可走'}`, bad, world: m.world });
    } else if (m.kind === 'spawn') {
      const [gx, gz] = g.cellOf(...worldToGrid(m.world));
      const bad = g.inside(gx, gz) && !!blocked[g.idx(gx, gz)];
      out.push({ kind: 'spawn', id: m.id, text: `出生点 ${m.id}：${bad ? '落在阻挡格里（从最近可走格起算）' : '可走'}`, bad, world: m.world });
    }
  }
  return out;
}
function rebuildColors() {
  const g = S.grid; if (!g || !S.composed) { S.colors = null; return; }
  const n = g.n;
  const col = S.colors && S.colors.length === n * 24 ? S.colors : new Float32Array(n * 24);
  const { blocked, src } = S.composed;
  const L = S.layers, on = S.onGround;
  for (let k = 0; k < n; k++) {
    let r = 0, gg = 0, b = 0, a = 0;
    const s = src[k];
    const offGround = on && !on[k];
    if (offGround && s !== SRC.BRUSH_BLOCK && s !== SRC.REGION_BLOCK && s !== SRC.BRUSH_WALK && s !== SRC.REGION_WALK) {
      // 画外 / 地面之外的格：作者没碰过就什么都不画（自动阻挡也只留很淡的一层）
      if (blocked[k]) { r = 0.95; gg = 0.3; b = 0.3; a = 0.12; }
    } else if (blocked[k]) {
      if (s === SRC.BRUSH_BLOCK) { r = 1; gg = 0.35; b = 0.75; a = 0.55; }
      else if (s === SRC.REGION_BLOCK) { r = 1; gg = 0.55; b = 0.2; a = 0.55; }
      else { r = 0.95; gg = 0.3; b = 0.3; a = 0.45; }
    } else {
      if (s === SRC.BRUSH_WALK || s === SRC.REGION_WALK) { r = 0.35; gg = 0.95; b = 0.45; a = 0.42; }
      else if (L.walkTint) { r = 0.3; gg = 0.9; b = 0.4; a = 0.09; }
      if (L.reach && S.reach && !S.reach[k] && !offGround) { r = 1; gg = 0.9; b = 0.3; a = 0.5; }
    }
    if (L.height && S.height && Math.abs(S.height[k]) > 1e-9) {
      const t = Math.min(1, Math.abs(S.height[k]) * S.k / 60);
      r = r * (1 - 0.6) + 0.3 * 0.6; gg = gg * (1 - 0.6) + 0.5 * 0.6; b = b * (1 - 0.6) + 1 * 0.6; a = Math.max(a, 0.25 + 0.4 * t);
    }
    if (S.inspect && S.inspect.k === k) { r = 1; gg = 1; b = 1; a = 0.8; }
    for (let v = 0; v < 6; v++) { const o = k * 24 + v * 4; col[o] = r; col[o + 1] = gg; col[o + 2] = b; col[o + 3] = a; }
  }
  S.colors = col; S.colorsRev++;
}
/** 一场一份：格子四角的世界位置（3D 三角形）、格线、投到画面的四边形（2D） */
function buildCellGeometry() {
  const g = S.grid, cal = S.cal;
  if (!g || !cal) { S.cellPos = null; S.cellQuads = null; S.cellOutline = null; return; }
  const n = g.n;
  const pos = new Float32Array(n * 18), quads = new Float32Array(n * 8), ol = new Float32Array(n * 24);
  const corner = (i, j) => { const wx = wu(g.x_min + i * g.cell), wz = wu(g.z_min + j * g.cell); return [wx, cal.groundHeight(wx, wz) + LIFT_WU, wz]; };
  // 角点缓存（(w+1)×(h+1)）
  const cw = g.w + 1, ch = g.h + 1;
  const cx = new Float32Array(cw * ch * 3), sc = new Float32Array(cw * ch * 2);
  for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) {
    const p = corner(i, j), o = (j * cw + i) * 3;
    cx[o] = p[0]; cx[o + 1] = p[1]; cx[o + 2] = p[2];
    const s = cal.worldToScene(p[0], p[1], p[2]), so = (j * cw + i) * 2;
    sc[so] = s[0]; sc[so + 1] = s[1];
  }
  const put = (arr, o, i, j) => { const c = (j * cw + i) * 3; arr[o] = cx[c]; arr[o + 1] = cx[c + 1]; arr[o + 2] = cx[c + 2]; };
  for (let j = 0; j < g.h; j++) for (let i = 0; i < g.w; i++) {
    const k = j * g.w + i, o = k * 18;
    put(pos, o, i, j); put(pos, o + 3, i + 1, j); put(pos, o + 6, i, j + 1);
    put(pos, o + 9, i + 1, j); put(pos, o + 12, i + 1, j + 1); put(pos, o + 15, i, j + 1);
    const q = k * 8;
    for (const [t, ii, jj] of [[0, i, j], [1, i + 1, j], [2, i + 1, j + 1], [3, i, j + 1]]) { const so = (jj * cw + ii) * 2; quads[q + t * 2] = sc[so]; quads[q + t * 2 + 1] = sc[so + 1]; }
    const lo = k * 24;
    put(ol, lo, i, j); put(ol, lo + 3, i + 1, j); put(ol, lo + 6, i + 1, j); put(ol, lo + 9, i + 1, j + 1);
    put(ol, lo + 12, i + 1, j + 1); put(ol, lo + 15, i, j + 1); put(ol, lo + 18, i, j + 1); put(ol, lo + 21, i, j);
  }
  S.cellPos = pos; S.cellQuads = quads; S.cellOutline = ol;
  // 哪些格真在**画里的地面**上：格心投到画面上要在画内，且从那个画面点沿行走面反投回来仍落在这一格（±1 格）。
  // 网格是按行走面的包围盒建的，画外 / 崖壁后面的格子也在里面——它们"可走但走不到"是对的，但不该染黄吓人，也不计数
  const on = new Uint8Array(n);
  for (let j = 0; j < g.h; j++) for (let i = 0; i < g.w; i++) {
    const wx = wu(g.centerX(i)), wz = wu(g.centerZ(j));
    const s = cal.worldToScene(wx, cal.groundHeight(wx, wz), wz);
    if (!cal.inScene(s[0], s[1])) continue;
    const back = worldToGrid(cal.sceneToWorldGround(s[0], s[1]));
    const [bi, bj] = g.cellOf(back[0], back[1]);
    if (Math.abs(bi - i) <= 1 && Math.abs(bj - j) <= 1) on[j * g.w + i] = 1;
  }
  S.onGround = on;
  // 一格在画面里大约多少 wu 宽（2D 视图按它决定缩得远时只画阻挡格）
  const m = Math.floor(g.h / 2) * cw + Math.floor(g.w / 2);
  S.cellPx = Math.hypot(sc[(m + 1) * 2] - sc[m * 2], sc[(m + 1) * 2 + 1] - sc[m * 2 + 1]) || 1;
  if (v3 && v3.ok) v3.setCells(pos);
}

// ---------------------------------------------------------------------------
// 编辑（都经 edit()：一条历史 + 重合成 + 重画）
// ---------------------------------------------------------------------------
function edit(label, fn) {
  if (!S.doc) return false;
  const changed = history.commit(label, fn);
  if (changed) afterEdit();
  return changed;
}
function afterEdit() { touch(); recompose(); refreshDirty(); renderLists(); renderInspector(); draw(); }
function dragBegin(label) { history.beginDrag(label); }
function dragTick(fn) { if (!history.inDrag()) history.beginDrag('拖动'); fn(); touch(); recompose(); draw(); }
function dragEnd() { if (history.endDrag()) { refreshDirty(); renderLists(); renderInspector(); } draw(); }
function doUndo() { const l = history.undo(); if (l) { afterEdit(); status(`撤销：${l}`); } return l; }
function doRedo() { const l = history.redo(); if (l) { afterEdit(); status(`重做：${l}`); } return l; }

// 选择键：region:<id> / region:<id>:v<i> / op:<id> / op:<id>:v<i>
function parseKey(key) {
  const m = /^(region|op):([^:]+)(?::v(\d+))?$/.exec(key || '');
  if (!m) return null;
  const list = m[1] === 'region' ? S.doc.regions : S.doc.heightOps;
  const item = (list || []).find((r) => r.id === m[2]);
  if (!item) return null;
  return { kind: m[1], id: m[2], item, vi: m[3] === undefined ? -1 : +m[3], list };
}
function select(key) { S.sel.key = key || ''; renderLists(); renderInspector(); draw(); }
function objects() {
  const out = [];
  if (!S.doc || !S.cal) return out;
  const sel = parseKey(S.sel.key);
  const add = (kind, item, rgb) => {
    const on = sel && sel.id === item.id && sel.kind === kind;
    item.points.forEach((p, i) => {
      const key = `${kind}:${item.id}:v${i}`;
      const selected = S.sel.key === key;
      out.push({ key, pos: gridToWorld(p[0], p[1]), color: selected ? [1, 0.9, 0.3, 1] : on ? [rgb[0], rgb[1], rgb[2], 1] : [rgb[0], rgb[1], rgb[2], 0.7],
        size: selected ? 10 : on ? 8 : 6, vertex: true, selected, label: selected ? `顶点 ${i}` : '' });
    });
  };
  if (S.layers.regions) for (const r of S.doc.regions || []) add('region', r, REGION_RGB[r.kind] || REGION_RGB.walk);
  if (S.layers.regions) for (const o of S.doc.heightOps || []) add('op', o, OP_RGB);
  return out;
}
function labels3() {
  const out = [];
  if (!S.doc || !S.cal || !S.layers.regions) return out;
  for (const r of S.doc.regions || []) { const c = polygonCentroid(r.points); out.push({ pos: gridToWorld(c[0], c[1]), text: `${r.kind === 'walk' ? '可走' : '阻挡'} ${r.id}`, color: S.sel.key.startsWith(`region:${r.id}`) ? GZ.col.hot : `rgba(${REGION_RGB[r.kind].map((v) => Math.round(v * 255)).join(',')},.9)` }); }
  for (const o of S.doc.heightOps || []) { const c = polygonCentroid(o.points); out.push({ pos: gridToWorld(c[0], c[1]), text: `${o.kind === 'flatten' ? '压平到' : '抬高'} ${fmt(o.value * S.k, 0)} wu · ${o.id}`, color: S.sel.key.startsWith(`op:${o.id}`) ? GZ.col.hot : 'rgba(150,170,255,.9)' }); }
  return out;
}
/** 贴地折线：多边形每条边按格宽采样（与 3D / 2D 共用） */
function edgeSamples(pts, close) {
  const out = [];
  const step = Math.max(S.grid ? S.grid.cell * 0.5 : 0.01, 1e-6);
  const n = pts.length;
  for (let i = 0; i < (close ? n : n - 1); i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const m = Math.max(1, Math.ceil(len / step));
    for (let s = 0; s < m; s++) { const t0 = s / m, t1 = (s + 1) / m; out.push(gridToWorld(a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0), gridToWorld(a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1)); }
  }
  return out;
}
function regionLines3() {
  const out = [];
  if (!S.doc || !S.cal) return out;
  const flat = (segs) => { const a = new Float32Array(segs.length * 3); segs.forEach((p, i) => { a[i * 3] = p[0]; a[i * 3 + 1] = p[1] + 1; a[i * 3 + 2] = p[2]; }); return a; };
  if (S.layers.regions) {
    for (const r of S.doc.regions || []) { const on = S.sel.key.startsWith(`region:${r.id}`); const rgb = REGION_RGB[r.kind]; out.push({ pts: flat(edgeSamples(r.points, true)), color: on ? [1, 0.9, 0.3, 1] : [rgb[0], rgb[1], rgb[2], 0.95], width: on ? 2 : 1 }); }
    for (const o of S.doc.heightOps || []) { const on = S.sel.key.startsWith(`op:${o.id}`); out.push({ pts: flat(edgeSamples(o.points, true)), color: on ? [1, 0.9, 0.3, 1] : [OP_RGB[0], OP_RGB[1], OP_RGB[2], 0.95] }); }
  }
  const d = S.draft;
  if (d && d.points && d.points.length) {
    const pts = d.cur ? d.points.concat([d.cur]) : d.points;
    out.push({ pts: flat(edgeSamples(pts, pts.length > 2)), color: [1, 1, 1, 0.9], width: 1.5 });
  }
  return out;
}
function regionLines2() {
  const out = [];
  if (!S.doc || !S.cal) return out;
  const css = (rgb, a) => `rgba(${Math.round(rgb[0] * 255)},${Math.round(rgb[1] * 255)},${Math.round(rgb[2] * 255)},${a})`;
  const dense = (pts, close) => { const s = edgeSamples(pts, close); const o = []; for (let i = 0; i < s.length; i += 2) o.push(s[i]); if (s.length && !close) o.push(s[s.length - 1]); return o; };
  if (S.layers.regions) {
    for (const r of S.doc.regions || []) { const on = S.sel.key.startsWith(`region:${r.id}`); out.push({ pts: dense(r.points, true), close: true, css: on ? GZ.col.hot : css(REGION_RGB[r.kind], 0.95), width: on ? 2.5 : 1.5, fill: css(REGION_RGB[r.kind], 0.08) }); }
    for (const o of S.doc.heightOps || []) { const on = S.sel.key.startsWith(`op:${o.id}`); out.push({ pts: dense(o.points, true), close: true, css: on ? GZ.col.hot : css(OP_RGB, 0.95), width: on ? 2.5 : 1.5, dash: [6, 4] }); }
  }
  const d = S.draft;
  if (d && d.points && d.points.length) { const pts = d.cur ? d.points.concat([d.cur]) : d.points; out.push({ pts: dense(pts, pts.length > 2), close: pts.length > 2, css: 'rgba(255,255,255,.9)', width: 1.5, dash: [4, 3] }); }
  return out;
}
function regionAtWorld(w) {
  if (!S.doc) return null;
  const [x, z] = worldToGrid(w);
  const sel = parseKey(S.sel.key);
  const cand = [];
  for (const o of S.doc.heightOps || []) if (S.layers.regions && pointInPolygon(x, z, o.points)) cand.push(`op:${o.id}`);
  for (const r of S.doc.regions || []) if (S.layers.regions && pointInPolygon(x, z, r.points)) cand.push(`region:${r.id}`);
  if (!cand.length) return null;
  // 选中的那块优先；否则最小的那块（叠着时点到的是里面那块）
  if (sel) { const k = `${sel.kind}:${sel.id}`; if (cand.includes(k)) return k; }
  cand.sort((a, b) => polygonArea(parseKey(a).item.points) - polygonArea(parseKey(b).item.points));
  return cand[0];
}
function gizmoPivot() {
  const p = parseKey(S.sel.key); if (!p) return null;
  if (p.vi >= 0) { const q = p.item.points[p.vi]; if (!q) return null; return { pivot: gridToWorld(q[0], q[1]), kind: 'slot', label: `${p.id} · 顶点 ${p.vi}`, n: 1, mode: 'move' }; }
  const c = polygonCentroid(p.item.points);
  return { pivot: gridToWorld(c[0], c[1]), kind: 'slot', label: `${p.kind === 'region' ? (p.item.kind === 'walk' ? '可走' : '阻挡') : '高度'} ${p.id}（${p.item.points.length} 点）`, n: p.item.points.length };
}
function gizmoBase(key) {
  const p = parseKey(key); if (!p) return null;
  const c = p.vi >= 0 ? p.item.points[p.vi] : polygonCentroid(p.item.points);
  return { key, kind: p.vi >= 0 ? 'vertex' : 'shape', points: clone(p.item.points), pos: gridToWorld(c[0], c[1]), center: c };
}
function gizmoLabel() { const p = parseKey(S.sel.key); return p ? (p.vi >= 0 ? `挪顶点 ${p.id}[${p.vi}]` : `挪 ${p.id}`) : '挪'; }
function applyGizmo(key, base, res) {
  const p = parseKey(key); if (!p) return;
  if (res.kind === 'move') {
    const dx = gu(res.v.x), dz = gu(res.v.z);
    if (base.kind === 'vertex') p.item.points[p.vi] = [base.points[p.vi][0] + dx, base.points[p.vi][1] + dz];
    else p.item.points = base.points.map((q) => [q[0] + dx, q[1] + dz]);
  } else if (res.kind === 'rotate' && base.kind === 'shape') {
    const a = res.deg * Math.PI / 180, c = base.center, cs = Math.cos(a), sn = Math.sin(a);
    p.item.points = base.points.map((q) => [c[0] + (q[0] - c[0]) * cs - (q[1] - c[1]) * sn, c[1] + (q[0] - c[0]) * sn + (q[1] - c[1]) * cs]);
  } else if (res.kind === 'scale' && base.kind === 'shape') {
    const kx = res.k.all != null ? res.k.all : (res.k.x != null ? res.k.x : 1), kz = res.k.all != null ? res.k.all : (res.k.z != null ? res.k.z : 1), c = base.center;
    p.item.points = base.points.map((q) => [c[0] + (q[0] - c[0]) * kx, c[1] + (q[1] - c[1]) * kz]);
  }
}
function nudgeSelected(dx, dz) {
  const p = parseKey(S.sel.key); if (!p) return false;
  edit('微移', () => { const ddx = gu(dx), ddz = gu(dz); if (p.vi >= 0) { p.item.points[p.vi] = [p.item.points[p.vi][0] + ddx, p.item.points[p.vi][1] + ddz]; } else p.item.points = p.item.points.map((q) => [q[0] + ddx, q[1] + ddz]); });
  return true;
}
function edgeHit(project, mx, my, tol) {
  const p = parseKey(S.sel.key); if (!p) return null;
  const pts = p.item.points;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const pa = project(gridToWorld(a[0], a[1])), pb = project(gridToWorld(b[0], b[1]));
    if (!pa || !pb) continue;
    if (distToSeg(mx, my, pa, pb) <= tol) {
      const dx = pb[0] - pa[0], dy = pb[1] - pa[1], l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? clamp(((mx - pa[0]) * dx + (my - pa[1]) * dy) / l2, 0, 1) : 0;
      return { key: `${p.kind}:${p.id}`, after: i, pt: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] };
    }
  }
  return null;
}
function insertVertex(key, after, pt) {
  const p = parseKey(key); if (!p) return;
  edit('插入顶点', () => { p.item.points.splice(after + 1, 0, [pt[0], pt[1]]); });
  select(`${p.kind}:${p.id}:v${after + 1}`);
}
async function deleteVertexKey(key) {
  const p = parseKey(key); if (!p) return;
  if (p.vi < 0) { deleteShape(key); return; }
  if (p.item.points.length <= 3) { deleteShape(`${p.kind}:${p.id}`); return; }
  edit('删顶点', () => { p.item.points.splice(p.vi, 1); });
  select(`${p.kind}:${p.id}`);
  status(`删了 ${p.id} 的顶点 ${p.vi}（Ctrl+Z 撤销）`);
}
function deleteShape(key) {
  const p = parseKey(key); if (!p) return;
  edit(`删 ${p.id}`, () => { const i = p.list.indexOf(p.item); if (i >= 0) p.list.splice(i, 1); });
  select('');
  status(`删了 ${p.kind === 'region' ? '多边形' : '高度操作'} ${p.id}（Ctrl+Z 撤销）`, 'warn');
}

// ---------------------------------------------------------------------------
// 工具（2D / 3D 共用；g = 脚下世界点 wu）
// ---------------------------------------------------------------------------
function setTool(t) {
  if (S.tool === t) { if (t === 'select') {} else return; }
  cancelDraft();
  S.tool = t;
  for (const b of document.querySelectorAll('#tools button[data-tool]')) b.classList.toggle('on', b.dataset.tool === t);
  renderInspector(); draw();
}
function cancelDraft() { if (S.draft) { S.draft = null; draw(); } }
function brushRadiusWu() { return S.tool === 'height' ? S.heightOpt.radiusWu : S.brushOpt.radiusWu; }
function wheelRadius(dir) {
  if (S.tool !== 'brush' && S.tool !== 'height') return;
  const o = S.tool === 'height' ? S.heightOpt : S.brushOpt;
  o.radiusWu = clamp(Math.round(o.radiusWu * (dir > 0 ? 1.15 : 1 / 1.15)), 2, 2000);
  renderInspector(); draw();
}
function brushCursor() {
  if (!S.cursor || !S.grid) return null;
  if (S.tool === 'brush') { const m = S.brushOpt.mode; return { center: S.cursor, radius: S.brushOpt.radiusWu, color: m === 'walk' ? [0.35, 0.95, 0.45, 0.95] : m === 'block' ? [1, 0.4, 0.4, 0.95] : [1, 1, 1, 0.8] }; }
  if (S.tool === 'height' && S.heightOpt.sub === 'sculpt') return { center: S.cursor, radius: S.heightOpt.radiusWu, color: [0.5, 0.65, 1, 0.95] };
  return null;
}
function stampBrushAt(g) {
  const [x, z] = worldToGrid(g);
  const val = S.brushOpt.mode === 'walk' ? BRUSH.WALK : S.brushOpt.mode === 'block' ? BRUSH.BLOCK : BRUSH.AUTO;
  if (!S.brush) S.brush = new Uint8Array(S.grid.n);
  return stampCircle(S.brush, S.grid, x, z, gu(S.brushOpt.radiusWu), val);
}
function stampHeightAt(g) {
  const [x, z] = worldToGrid(g);
  if (!S.height) S.height = new Float32Array(S.grid.n);
  const o = S.heightOpt;
  return sculptHeight(S.height, S.grid, x, z, gu(o.radiusWu), o.mode, gu(o.strengthWu), gu(o.valueWu)).length;
}
/** 连续笔画：两次事件之间按半径的 1/3 插值，快速拖动不断线 */
function strokeTo(g, stamp) {
  const d = S.draft;
  const last = d && d.last;
  const r = brushRadiusWu() / 3;
  if (last) {
    const dist = Math.hypot(g[0] - last[0], g[2] - last[2]);
    const n = Math.max(1, Math.ceil(dist / Math.max(r, 1)));
    for (let i = 1; i <= n; i++) { const t = i / n; stamp([last[0] + (g[0] - last[0]) * t, 0, last[2] + (g[2] - last[2]) * t]); }
  } else stamp(g);
  if (d) d.last = g;
}
function toolDown(g, e) {
  if (!S.doc || !S.grid) { status('这个场景没有地形网格', 'warn'); return false; }
  const t = S.tool;
  const shift = e.shiftKey;
  if (t === 'polyWalk' || t === 'polyBlock' || (t === 'height' && S.heightOpt.sub === 'poly')) {
    const role = t === 'height' ? 'height' : (t === 'polyWalk') !== shift ? 'walk' : 'block';
    if (!S.draft || S.draft.kind !== 'poly') S.draft = { kind: 'poly', role, points: [], cur: null };
    S.draft.role = role;
    const p = worldToGrid(g);
    // 点回起点 = 闭合
    const first = S.draft.points[0];
    if (first && S.draft.points.length >= 3 && Math.hypot(wu(first[0] - p[0]), wu(first[1] - p[1])) < brushRadiusWu() * 0.5 + 6) { commitDraft(); return false; }
    S.draft.points.push(p);
    status(`${S.draft.points.length} 个顶点 · 双击 / Enter 闭合，右键 / Backspace 退一点，Esc 取消`);
    draw(); return false;
  }
  if (t === 'rectWalk' || t === 'rectBlock') {
    const role = (t === 'rectWalk') !== shift ? 'walk' : 'block';
    const p = worldToGrid(g);
    S.draft = { kind: 'rect', role, a: p, b: p, points: [p, p, p, p], cur: null };
    return true;
  }
  if (t === 'brush') {
    dragBegin(`笔刷·${S.brushOpt.mode === 'walk' ? '可走' : S.brushOpt.mode === 'block' ? '阻挡' : '擦'}`);
    S.draft = { kind: 'stroke', last: null };
    strokeTo(g, (p) => stampBrushAt(p));
    touch(); recompose(); draw();
    return true;
  }
  if (t === 'height' && S.heightOpt.sub === 'sculpt') {
    dragBegin(`高度·${S.heightOpt.mode}`);
    S.draft = { kind: 'stroke', last: null };
    strokeTo(g, (p) => stampHeightAt(p));
    touch(); recompose(); draw();
    return true;
  }
  if (t === 'inspect') { inspectAt(g); return false; }
  return false;
}
function toolMove(g, e) {
  const d = S.draft; if (!d) return;
  if (d.kind === 'rect') { d.b = worldToGrid(g); d.points = rectPoints(d.a, d.b); draw(); return; }
  if (d.kind === 'stroke') {
    strokeTo(g, S.tool === 'height' ? (p) => stampHeightAt(p) : (p) => stampBrushAt(p));
    dragTick(() => {});
  }
}
function toolUp(g, e) {
  const d = S.draft; if (!d) return;
  if (d.kind === 'rect') { const pts = rectPoints(d.a, d.b); S.draft = null; if (Math.abs(d.b[0] - d.a[0]) > 1e-9 && Math.abs(d.b[1] - d.a[1]) > 1e-9) addShape(d.role, pts); else draw(); return; }
  if (d.kind === 'stroke') { S.draft = null; dragEnd(); }
}
function toolRight(g, e) {
  const d = S.draft;
  if (d && d.kind === 'poly') { d.points.pop(); if (!d.points.length) S.draft = null; draw(); return; }
  if (S.tool === 'brush' && g) {
    const keep = S.brushOpt.mode; S.brushOpt.mode = 'erase';
    edit('笔刷·擦', () => { stampBrushAt(g); });
    S.brushOpt.mode = keep;
    return;
  }
  if (S.tool !== 'select') setTool('select');
}
function toolDouble(g, e) { if (S.draft && S.draft.kind === 'poly') commitDraft(); }
function rectPoints(a, b) { return [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]]; }
function commitDraft() {
  const d = S.draft; if (!d) return;
  if (d.kind === 'poly') {
    if (d.points.length < 3) { status('多边形至少 3 个点', 'warn'); return; }
    const pts = d.points.slice(); S.draft = null;
    addShape(d.role, pts);
  }
}
function addShape(role, pts) {
  if (role === 'height') {
    const o = S.heightOpt;
    const id = nextId('h', S.doc.heightOps);
    edit(`高度操作 ${id}`, () => { S.doc.heightOps.push({ id, kind: o.polyKind, value: gu(o.valueWu), feather: gu(o.featherWu), points: pts }); });
    S.tool = 'select'; for (const b of document.querySelectorAll('#tools button[data-tool]')) b.classList.toggle('on', b.dataset.tool === 'select');
    select(`op:${id}`);
    status(`加了高度操作 ${id}（${o.polyKind === 'flatten' ? '压平到' : '抬高'} ${fmt(o.valueWu, 0)} wu）——推给游戏 / 导出时才重算行走面`);
    return;
  }
  const id = nextId('r', S.doc.regions);
  edit(`${role === 'walk' ? '可走' : '阻挡'}多边形 ${id}`, () => { S.doc.regions.push({ id, kind: role, points: pts }); });
  // 画完就回选择工具：新区域选中、gizmo 立刻在（要再画一块按 P / B 就是了）
  S.tool = 'select'; for (const b of document.querySelectorAll('#tools button[data-tool]')) b.classList.toggle('on', b.dataset.tool === 'select');
  select(`region:${id}`);
  status(`加了${role === 'walk' ? '可走' : '阻挡'}多边形 ${id}`);
}
function inspectAt(g) {
  const [x, z] = worldToGrid(g);
  const [gx, gz] = S.grid.cellOf(x, z);
  if (!S.grid.inside(gx, gz)) { S.inspect = null; status('网格外（运行时按可走）'); rebuildColors(); draw(); return; }
  const k = S.grid.idx(gx, gz);
  const src = S.composed.src[k], blocked = S.composed.blocked[k], reach = S.reach[k];
  const auto = S.auto ? (() => { const [ax, az] = S.auto.grid.cellOf(S.grid.centerX(gx), S.grid.centerZ(gz)); return S.auto.grid.inside(ax, az) ? (S.auto.data[S.auto.grid.idx(ax, az)] ? '阻挡' : '可走') : '网格外'; })() : '无';
  S.inspect = { k, gx, gz, src, blocked, reach, auto, brush: S.brush ? S.brush[k] : 0, height: S.height ? S.height[k] : 0, world: g };
  rebuildColors(); renderInspector(); draw();
  status(`格 (${gx}, ${gz})：${SRC_NAME[src]} → ${blocked ? '阻挡' : '可走'}${!blocked ? (reach ? '，走得到' : '，走不到') : ''}`);
}

// ---------------------------------------------------------------------------
// 装载
// ---------------------------------------------------------------------------
async function loadScene(sceneId, bg) {
  if (!sceneId) return;
  const myOp = ++S.sceneOp;
  cancelDraft();
  history.discardDrag();
  setBusy(true, `装载 ${sceneId}…`);
  S.loadingScene = sceneId;
  try {
    const j = await API.json(`/api/scene?id=${encodeURIComponent(sceneId)}${bg ? `&bg=${encodeURIComponent(bg)}` : ''}`);
    if (myOp !== S.sceneOp) return;
    const sc = j.scene;
    S.scene = sc; S.marks = sc.marks || []; S.bgName = sc.background;
    S.cal = null; S.k = 1;
    if (sc.cal) {
      const cal = new SceneCal(sc.cal, sc.worldWidth, sc.worldHeight);
      cal.viewDirWorld = () => [cal.rows[2], cal.rows[5], cal.rows[8]];
      const bgq = `id=${encodeURIComponent(sc.id)}&bg=${encodeURIComponent(sc.background)}`;
      const [mesh, ground, hf, img] = await Promise.all([
        API.bin(`/api/scene_mesh?${bgq}&stride=2`), API.bin(`/api/scene_ground?${bgq}`), API.bin(`/api/scene_heightfield?${bgq}`),
        API.image(`/api/scene_bg?${bgq}&w=2048`),
      ]);
      if (myOp !== S.sceneOp) return;
      cal.setGround(ground); cal.setHeightfield(hf);
      S.cal = cal; S.k = cal.wuPerQ; S.bg = img;
      if (v3 && v3.ok) { v3.setMesh(mesh); v3.setTexture(img); }
      if (v2) v2.setBackground(img);
    } else {
      S.bg = null;
      if (v3 && v3.ok) { v3.setMesh(null); v3.setTexture(null); v3.setCells(null); }
      if (v2) v2.setBackground(null);
    }
    const t = await API.json(`/api/terrain?id=${encodeURIComponent(sc.id)}`);
    if (myOp !== S.sceneOp) return;
    S.doc = t.doc; S.baseUpdated = t.doc.updated || null; S.needsExport = !!(t.disk && t.disk.needsExport);
    S.grid = t.doc.grid ? new Grid(t.doc.grid) : null;
    S.brush = t.brush ? b64ToU8(t.brush) : (S.grid ? new Uint8Array(S.grid.n) : null);
    S.height = t.height ? new Float32Array(b64ToF32(t.height)) : (S.grid ? new Float32Array(S.grid.n) : null);
    S.auto = t.auto ? { grid: new Grid(t.auto.grid), data: b64ToU8(t.auto.data), bakedAt: t.auto.bakedAt } : null;
    S.sel.key = ''; S.inspect = null; S.link.align = null; S.link.lastAlignRev = -1;
    history.clear();
    markClean();
    buildCellGeometry();
    recompose();
    if (v3 && v3.ok) { v3.gridLines = null; v3.fit(true); }
    if (v2) v2.fit();
    renderScenePickers(); renderLists(); renderInspector(); renderSceneNote(); draw();
    document.title = `地形工作台 · ${sc.id}`;
    await maybeRestoreDraft(sc.id);
    if (!S.grid) status('这个场景还没有地形网格：先在照明实验室导出一次深度（烘焙器会留下自动结果）', 'warn');
    else status(`装好 ${sc.id}：${S.grid.w}×${S.grid.h} 格（每格 ${fmt(S.grid.cell * S.k, 1)} wu），阻挡 ${fmt(S.stats.blocked / S.stats.cells * 100, 1)}%，走不到的可走格 ${S.stats.unreachable}`);
  } catch (e) {
    if (myOp === S.sceneOp) status(`装不上 ${sceneId}：${e.message || e}`, 'err');
  } finally {
    if (myOp === S.sceneOp) { S.loadingScene = ''; setBusy(false); }
  }
}
async function maybeRestoreDraft(sid) {
  let d = null;
  try { d = (await API.json(`/api/draft?id=${encodeURIComponent(sid)}`)).draft; } catch (e) { return; }
  if (!d || !d.state || !d.state.doc) return;
  const key = JSON.stringify({ doc: d.state.doc, brush: d.state.brush || null, height: d.state.height || null });
  const cur = JSON.stringify({ doc: S.doc, brush: S.brush && S.brush.some((v) => v) ? u8ToB64(S.brush) : null, height: S.height && S.height.some((v) => v) ? f32ToB64(S.height) : null });
  if (key === cur) { void API.post('/api/draft/clear', { id: sid }); return; }
  const stale = d.baseUpdated && S.baseUpdated && d.baseUpdated !== S.baseUpdated;
  const pick = await choiceDialog('有没保存的草稿', `${sid} 上次关掉时还有没保存的改动（${d.savedAt || '?'} 自动存的草稿）。${stale ? '\n⚠ 盘上的作者层在那之后被改过，恢复会盖掉那些改动（保存时会再问一次）。' : ''}`,
    [['discard', '丢掉草稿'], ['later', '先不管'], ['restore', '恢复草稿']]);
  if (pick === 'restore') {
    S.doc = d.state.doc; S.grid = S.doc.grid ? new Grid(S.doc.grid) : S.grid;
    S.brush = d.state.brush ? b64ToU8(d.state.brush) : new Uint8Array(S.grid.n);
    S.height = d.state.height ? new Float32Array(b64ToF32(d.state.height)) : new Float32Array(S.grid.n);
    history.clear(); afterEdit(); status('恢复了草稿（还没保存）', 'warn');
  } else if (pick === 'discard') { void API.post('/api/draft/clear', { id: sid }); }
}
function scheduleDraft() {
  if (draftTimer) return;
  draftTimer = window.setInterval(() => {
    if (!S.dirty || !S.scene || S.busy) return;
    void API.post('/api/draft', { id: S.scene.id, draft: { savedAt: new Date().toLocaleString(), baseUpdated: S.baseUpdated, state: currentState() } }).catch(() => {});
  }, DRAFT_MS);
}

// ---------------------------------------------------------------------------
// 保存 / 推给游戏 / 导出到游戏 / 历史
// ---------------------------------------------------------------------------
async function saveTerrain(opts) {
  if (!S.scene || !S.doc || !S.grid) return false;
  if (history.inDrag()) { status('手势没松开，先松手再保存', 'warn'); return false; }
  const sid = S.scene.id;
  return runIO(async () => {
    setBusy(true, '保存作者层…');
    try {
      let r = await API.post('/api/save', { id: sid, state: currentState(), baseUpdated: S.baseUpdated, force: !!(opts && opts.force) });
      if (!r.ok && r.conflict) {
        setBusy(false);
        const yes = await confirmDialog('盘上的作者层被别处改过', `${r.err}\n\n覆盖它？（覆盖前那份会留在历史里）`);
        setBusy(true, '保存作者层…');
        if (!yes) { status('没保存（盘上那份被别处改过）', 'warn'); return false; }
        r = await API.post('/api/save', { id: sid, state: currentState(), baseUpdated: S.baseUpdated, force: true });
      }
      if (!r.ok) throw new Error(r.err || '保存失败');
      S.doc = r.doc; S.baseUpdated = r.updated; S.needsExport = !!r.needsExport;
      markClean(); void API.post('/api/draft/clear', { id: sid }).catch(() => {});
      status(`已保存 ${r.path}（${r.updated}）${r.needsExport ? ' · 待导出到游戏（B）' : ''}`, 'ok');
      renderDocState();
      return true;
    } catch (e) { status(`没存上：${e.message || e}`, 'err'); return false; } finally { setBusy(false); }
  });
}
async function pushToGame() {
  if (!S.scene || !S.grid) return;
  if (history.inDrag()) { status('手势没松开', 'warn'); return; }
  const sid = S.scene.id;
  let r;
  try { r = await API.post('/api/push', { id: sid, state: currentState() }); } catch (e) { status(`推不出去：${e.message || e}`, 'err'); return; }
  if (!r.ok) { status(r.err || '推不出去', 'err'); return; }
  status('推给游戏：合成中…');
  await watchJob('推给游戏');
}
async function exportToGame() {
  if (!S.scene || !S.grid) return;
  if (S.dirty || !S.baseUpdated) { const ok = await saveTerrain(); if (!ok) return; }
  let r;
  try { r = await API.post('/api/export', { id: S.scene.id }); } catch (e) { status(`导不出去：${e.message || e}`, 'err'); return; }
  if (!r.ok) { status(r.err || '导不出去', 'err'); return; }
  status('导出到游戏：合成中…');
  await watchJob('导出到游戏');
}
async function watchJob(name) {
  el('btnPush').disabled = true; el('btnExport').disabled = true;
  try {
    for (let i = 0; i < 2400; i++) {
      await new Promise((r) => setTimeout(r, JOB_POLL_MS));
      let j;
      try { j = await API.json('/api/job/status'); } catch (e) { continue; }
      S.job = j;
      const last = j.log && j.log.length ? j.log[j.log.length - 1] : '';
      if (!j.done) { status(`${name}：${last || '…'}（${j.elapsed}s）`); continue; }
      if (!j.succeeded) { status(`${name}失败：${j.err}`, 'err'); return; }
      const reach = j.result && j.result.reach ? j.result.reach : [];
      if (j.kind === 'export') { S.needsExport = false; renderDocState(); }
      status(`${name}完成：${last}${reach.length ? `；⚠ ${reach.length} 条连通性问题（见左栏）` : ''}`, reach.length ? 'warn' : 'ok');
      S.link.lastAlignRev = -1; scheduleProbe();
      return;
    }
  } finally { el('btnPush').disabled = false; el('btnExport').disabled = false; }
}
async function showHistory() {
  if (!S.scene) return;
  const sid = S.scene.id;
  let items = [];
  try { items = (await API.json(`/api/history?id=${encodeURIComponent(sid)}`)).items || []; } catch (e) { status(`历史读不出来：${e.message || e}`, 'err'); return; }
  if (!items.length) { status('还没有历史（每次保存前留一份）'); return; }
  const name = await dialog((form, done) => {
    form.append(h('h3', {}, `${sid} 的历史（新的在前）`), h('p', {}, '恢复会盖掉盘上的作者层（恢复前当前这份也进历史）；页面上没保存的改动会丢'));
    for (const it of items) {
      form.append(h('div', { class: 'row' }, h('span', {}, it.name), h('span', { class: 'dim', style: 'flex:1' }, `${it.updated || ''} · 多边形 ${it.regions} · 高度 ${it.heightOps}${it.brush ? ' · 笔刷' : ''}${it.height ? ' · 高度栅格' : ''}`),
        h('button', { type: 'button', onclick: () => done(it.name) }, '恢复')));
    }
    form.append(h('div', { class: 'btns' }, h('button', { type: 'button', 'data-choice': 'cancel', onclick: () => done('') }, '关闭')));
  });
  if (!name) return;
  setBusy(true, '恢复历史…');
  try {
    const r = await API.post('/api/restore', { id: sid, name });
    if (!r.ok) throw new Error(r.err);
    await loadScene(sid, S.bgName);
    status(`恢复了历史 ${name}`, 'ok');
  } catch (e) { status(`恢复失败：${e.message || e}`, 'err'); } finally { setBusy(false); }
}

// ---------------------------------------------------------------------------
// 与游戏：状态 / 拉起 / 运行时对齐
// ---------------------------------------------------------------------------
async function pollLink() {
  let r;
  try { r = await API.json('/api/link/status'); } catch (e) { r = { ok: false, alive: false, err: String(e && e.message || e) }; }
  const prev = S.link.status;
  S.link.status = r;
  // 游戏刚起来 / 刚进本场景：补一次对齐探测
  const inScene = (st) => !!(st && st.pageAlive && st.page && S.scene && st.page.sceneId === S.scene.id && !st.pageBusy);
  if (inScene(r) && !inScene(prev)) { S.link.lastAlignRev = -1; scheduleProbe(); }
  if (r.status && r.status.probeSeq === S.link.probeSeq && S.link.probeCells) settleProbe(r.status);
  renderLinkChip(); renderGamePanel();
}
function scheduleProbe() {
  if (probeTimer) clearTimeout(probeTimer);
  probeTimer = setTimeout(() => { probeTimer = 0; void sendProbe(); }, 1500);
}
/** 挑一批格心（阻挡 / 可走各半，尽量贴着边界）→ 画面点，请游戏用它自己的 isCollision 判 */
async function sendProbe() {
  const st = S.link.status;
  if (!S.scene || !S.grid || !S.composed || !S.cal) return;
  if (!(st && st.pageAlive && st.page && st.page.sceneId === S.scene.id && !st.pageBusy)) { S.link.align = S.link.align && S.link.align.stale ? S.link.align : (S.link.align ? Object.assign({}, S.link.align, { stale: true }) : null); renderLinkChip(); return; }
  if (S.link.lastAlignRev === S.composeRev) return;
  const g = S.grid, b = S.composed.blocked;
  const edges = [];
  for (let j = 1; j < g.h - 1; j++) for (let i = 1; i < g.w - 1; i++) {
    const k = g.idx(i, j);
    if (b[k] !== b[k - 1] || b[k] !== b[k + 1] || b[k] !== b[k - g.w] || b[k] !== b[k + g.w]) edges.push(k);
  }
  const pick = [];
  const seed = 1234; let x = seed;
  const rnd = () => { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff; };
  const pool = edges.length ? edges : Array.from({ length: g.n }, (_, k) => k);
  for (let i = 0; i < PROBE_N && pool.length; i++) pick.push(pool[Math.floor(rnd() * pool.length)]);
  const pts = [], cells = [];
  for (const k of pick) {
    const i = k % g.w, j = (k / g.w) | 0;
    const w = gridToWorld(g.centerX(i), g.centerZ(j)); w[1] -= LIFT_WU;
    const s = S.cal.worldToScene(w[0], w[1], w[2]);
    if (!S.cal.inScene(s[0], s[1])) continue;
    // 画面点再经行走面反投回来必须仍是这一格（边界上的采样点两边都可能，跳过这种）
    const back = worldToGrid(S.cal.sceneToWorldGround(s[0], s[1]));
    const [bi, bj] = g.cellOf(back[0], back[1]);
    if (bi !== i || bj !== j) continue;
    pts.push([s[0], s[1]]); cells.push(k);
  }
  if (!pts.length) return;
  let r;
  try { r = await API.post('/api/link/probe', { id: S.scene.id, points: pts }); } catch (e) { return; }
  if (!r.ok) return;
  S.link.probeSeq = r.seq; S.link.probeCells = cells; S.link.probeAt = Date.now(); S.link.lastAlignRev = S.composeRev;
}
function settleProbe(stt) {
  const cells = S.link.probeCells; if (!cells) return;
  const bits = String(stt.blocked || '');
  if (bits.length !== cells.length) return;
  let mismatch = 0; const bad = [];
  for (let i = 0; i < cells.length; i++) { const mine = S.composed.blocked[cells[i]] ? '1' : '0'; if (mine !== bits[i]) { mismatch++; bad.push(cells[i]); } }
  S.link.align = { n: cells.length, mismatch, bad, grid: stt.grid || null, at: Date.now(), stale: false };
  S.link.probeCells = null;
  renderLinkChip();
}
async function launchGame() {
  if (!S.scene) return;
  const st = S.link.status;
  if (st && st.pageAlive && st.page && st.page.sceneId === S.scene.id) { status('游戏已经在这个场景里'); return; }
  try {
    const r = await API.post('/api/link/open', { id: S.scene.id });
    status(r.via === 'console' ? `已让控制台拉起游戏进 ${S.scene.id}` : r.via === 'queue' ? r.detail : `拉不起来：${r.detail}${r.console ? `（控制台：${r.console}）` : ''}`, r.via === 'none' ? 'warn' : 'ok');
  } catch (e) { status(`拉不起来：${e.message || e}`, 'err'); }
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------
function draw() { if (S.view === 3 && v3 && v3.ok) v3.draw(); else if (v2) v2.draw(); }
function setView(v) {
  S.view = v;
  el('view3d').hidden = v !== 3; el('overlay3d').hidden = v !== 3; el('view2d').hidden = v !== 2;
  el('btnView3').classList.toggle('on', v === 3); el('btnView2').classList.toggle('on', v === 2);
  if (v === 3 && v3 && v3.ok) v3.resize(); else if (v2) v2.resize();
  draw();
}
function renderScenePickers() {
  const sel = el('sceneSel');
  const cur = S.scene ? S.scene.id : sel.value;
  sel.textContent = '';
  for (const s of S.scenes) sel.appendChild(h('option', { value: s.id }, `${s.id}${s.name && s.name !== s.id ? ` · ${s.name}` : ''}${!s.depth ? '（无深度）' : ''}${s.needsExport ? ' · 待导出' : ''}`));
  if (cur) sel.value = cur;
  const bg = el('bgSel');
  bg.textContent = '';
  for (const b of (S.scene && S.scene.backgrounds) || []) bg.appendChild(h('option', { value: b }, b));
  if (S.bgName) bg.value = S.bgName;
}
function renderSceneNote() {
  const n = el('sceneNote');
  if (!S.scene) { n.textContent = ''; return; }
  n.textContent = S.grid ? `${S.scene.id} · ${S.grid.w}×${S.grid.h} 格 · 每格 ${fmt(S.grid.cell * S.k, 1)} wu · ${S.auto ? `自动结果 ${S.auto.bakedAt || ''}` : '无自动结果'}` : `${S.scene.id} · 无地形网格`;
  n.className = 'chip ' + (S.grid ? 'ok' : 'warn');
}
function renderDocState() {
  el('btnUndo').disabled = !history || !history.canUndo; el('btnRedo').disabled = !history || !history.canRedo;
  el('btnUndo').title = history && history.canUndo ? `撤销：${history.peekUndo()}` : '撤销';
  el('btnRedo').title = history && history.canRedo ? `重做：${history.peekRedo()}` : '重做';
  el('btnSave').classList.toggle('dirty', S.dirty);
  el('btnExport').classList.toggle('pending', S.needsExport);
  el('btnExport').textContent = S.needsExport ? '导出到游戏（待导出）' : '导出到游戏';
  el('docState').textContent = S.scene ? `${S.dirty ? '● 未保存' : '已保存'}${S.needsExport ? ' · 资源里的不是这份' : ''}` : '';
  document.title = `${S.dirty ? '● ' : ''}地形工作台${S.scene ? ` · ${S.scene.id}` : ''}`;
}
function renderLists() {
  const rl = el('regionList'); rl.textContent = '';
  if (S.doc) {
    for (const r of S.doc.regions || []) {
      const on = S.sel.key.startsWith(`region:${r.id}`);
      const rgb = REGION_RGB[r.kind];
      rl.appendChild(h('div', { class: 'item' + (on ? ' on' : ''), onclick: () => select(`region:${r.id}`) },
        h('span', { class: 'ic', style: `background:rgba(${rgb.map((v) => Math.round(v * 255)).join(',')},.8)` }),
        h('span', { class: 'name' }, `${r.id} · ${r.kind === 'walk' ? '可走' : '阻挡'} · ${r.points.length} 点`),
        h('button', { title: '删', onclick: (e) => { e.stopPropagation(); deleteShape(`region:${r.id}`); } }, '×')));
    }
    if (!(S.doc.regions || []).length) rl.appendChild(h('div', { class: 'pad dim', style: 'padding:2px 10px' }, 'P 画可走 · Shift+P 画阻挡 · B 拉矩形'));
  }
  const ol = el('opList'); ol.textContent = '';
  if (S.doc) {
    for (const o of S.doc.heightOps || []) {
      const on = S.sel.key.startsWith(`op:${o.id}`);
      ol.appendChild(h('div', { class: 'item' + (on ? ' on' : ''), onclick: () => select(`op:${o.id}`) },
        h('span', { class: 'ic', style: 'background:rgba(115,153,255,.8)' }),
        h('span', { class: 'name' }, `${o.id} · ${o.kind === 'flatten' ? '压平到' : '抬高'} ${fmt(o.value * S.k, 0)} wu${o.feather ? ` · 羽化 ${fmt(o.feather * S.k, 0)}` : ''}`),
        h('button', { title: '删', onclick: (e) => { e.stopPropagation(); deleteShape(`op:${o.id}`); } }, '×')));
    }
    const nh = S.height ? S.height.reduce((a, v) => a + (Math.abs(v) > 1e-9 ? 1 : 0), 0) : 0;
    if (nh) ol.appendChild(h('div', { class: 'pad dim', style: 'padding:2px 10px' }, `雕刻过 ${nh} 格`));
    if (!(S.doc.heightOps || []).length && !nh) ol.appendChild(h('div', { class: 'pad dim', style: 'padding:2px 10px' }, 'H：雕刻笔刷或画高度多边形'));
  }
  const rc = el('reachList'); rc.textContent = '';
  for (const it of S.reachIssues) {
    rc.appendChild(h('div', { class: 'item' + (it.bad ? ' bad' : ''), title: '点一下对准', onclick: () => { if (it.world) focusWorld(it.world); } },
      h('span', { class: 'ic', style: `background:${it.bad ? 'rgba(255,107,107,.8)' : 'rgba(126,212,146,.6)'}` }), h('span', { class: 'name' }, it.text)));
  }
  if (S.stats) rc.appendChild(h('div', { class: 'pad dim', style: 'padding:2px 10px' }, `阻挡 ${S.stats.blocked} / ${S.stats.cells} 格（${fmt(S.stats.blocked / S.stats.cells * 100, 1)}%）· 走不到的可走格 ${S.stats.unreachable}`));
}
function focusWorld(w) { if (S.view === 3 && v3 && v3.ok) v3.focus(w, 200); else if (v2 && S.cal) v2.focus(S.cal.worldToScene(w[0], w[1], w[2]), 300); }
function focusSelected() {
  const p = parseKey(S.sel.key);
  if (p) { const c = p.vi >= 0 ? p.item.points[p.vi] : polygonCentroid(p.item.points); focusWorld(gridToWorld(c[0], c[1])); return; }
  if (S.view === 3 && v3 && v3.ok) v3.fit(true); else if (v2) v2.fit();
}
function renderInspector() {
  const root = el('inspector'); root.textContent = '';
  const sec = (title) => { const s = h('div', { class: 'sec' }); if (title) s.appendChild(h('h4', {}, title)); root.appendChild(s); return s; };
  const num = (label, get, set, step, unit, title) => h('div', { class: 'row', title: title || '' }, h('span', {}, label),
    h('input', { type: 'number', value: fmt(get(), 1), step: step || 1, onchange: (e) => { const v = parseFloat(e.target.value); if (Number.isFinite(v)) set(v); renderInspector(); draw(); } }), h('span', { class: 'unit' }, unit || ''));
  const choice = (label, opts, get, set, title) => {
    const row = h('div', { class: 'row', title: title || '' }, h('span', {}, label));
    const box = h('div', { class: 'btns', style: 'margin:0' });
    for (const [v, t] of opts) box.appendChild(h('button', { type: 'button', class: get() === v ? 'on' : '', onclick: () => { set(v); renderInspector(); draw(); } }, t));
    row.appendChild(box); return row;
  };
  if (!S.scene) { sec('').appendChild(h('div', { class: 'pad dim' }, '选一个场景')); return; }
  // 工具面板
  if (S.tool === 'brush') {
    const s = sec('笔刷');
    s.appendChild(choice('涂成', [['walk', '可走'], ['block', '阻挡'], ['erase', '擦掉（回自动）']], () => S.brushOpt.mode, (v) => { S.brushOpt.mode = v; }, '阻挡压过一切可走；擦掉 = 这一格回到烘焙器的自动结果'));
    s.appendChild(num('半径', () => S.brushOpt.radiusWu, (v) => { S.brushOpt.radiusWu = clamp(v, 2, 2000); }, 5, 'wu', '[ ] 或 Shift+滚轮'));
    s.appendChild(h('div', { class: 'pad dim' }, `一格 ${fmt(S.grid ? S.grid.cell * S.k : 0, 1)} wu · 按住拖着涂；右键点一下 = 擦`));
  } else if (S.tool === 'height') {
    const s = sec('行走面高度');
    s.appendChild(choice('方式', [['sculpt', '雕刻笔刷'], ['poly', '高度多边形']], () => S.heightOpt.sub, (v) => { S.heightOpt.sub = v; cancelDraft(); }));
    if (S.heightOpt.sub === 'sculpt') {
      s.appendChild(choice('动作', [['raise', '抬'], ['lower', '压'], ['smooth', '平滑'], ['flatten', '压平到']], () => S.heightOpt.mode, (v) => { S.heightOpt.mode = v; }));
      s.appendChild(num('半径', () => S.heightOpt.radiusWu, (v) => { S.heightOpt.radiusWu = clamp(v, 2, 2000); }, 5, 'wu'));
      s.appendChild(num('每笔', () => S.heightOpt.strengthWu, (v) => { S.heightOpt.strengthWu = clamp(v, 0.1, 500); }, 1, 'wu', '中心处一笔抬 / 压多少'));
      if (S.heightOpt.mode === 'flatten') s.appendChild(num('压平到 Δ', () => S.heightOpt.valueWu, (v) => { S.heightOpt.valueWu = v; }, 1, 'wu', '相对烘焙基底的高度增量'));
    } else {
      s.appendChild(choice('操作', [['flatten', '压平到某高度'], ['offset', '整块抬高 / 压低']], () => S.heightOpt.polyKind, (v) => { S.heightOpt.polyKind = v; }));
      s.appendChild(num(S.heightOpt.polyKind === 'flatten' ? '目标高度 Y' : '增量', () => S.heightOpt.valueWu, (v) => { S.heightOpt.valueWu = v; }, 1, 'wu', S.heightOpt.polyKind === 'flatten' ? '世界 Y（wu）；地面一般在 0 附近，看坐标读数' : '正抬负压'));
      s.appendChild(num('羽化', () => S.heightOpt.featherWu, (v) => { S.heightOpt.featherWu = Math.max(0, v); }, 5, 'wu', '边缘多宽的过渡带'));
      s.appendChild(h('div', { class: 'pad dim' }, '逐点点击画多边形，双击 / Enter 闭合'));
    }
    s.appendChild(h('div', { class: 'pad warn' }, '高度改动**不即时**重算行走面（要逐条射线重求交）：推给游戏 / 导出时算，图上蓝色只标改过的格'));
  } else if (S.tool === 'polyWalk' || S.tool === 'polyBlock' || S.tool === 'rectWalk' || S.tool === 'rectBlock') {
    const s = sec(/poly/.test(S.tool) ? '多边形' : '矩形');
    s.appendChild(h('div', { class: 'pad dim' }, `${/Walk$/.test(S.tool) ? '可走' : '阻挡'}（按住 Shift 反过来）· ${/poly/.test(S.tool) ? '逐点点击，双击 / Enter 闭合，右键 / Backspace 退一点' : '按住拖一个框'}`));
    if (S.draft && S.draft.kind === 'poly') s.appendChild(h('div', { class: 'btns' }, h('button', { type: 'button', class: 'primary', onclick: () => commitDraft() }, `闭合（${S.draft.points.length} 点）`), h('button', { type: 'button', onclick: () => cancelDraft() }, '取消')));
  } else if (S.tool === 'inspect' && S.inspect) {
    const s = sec('这一格'), i = S.inspect;
    const kv = (k, v) => s.appendChild(h('div', { class: 'row' }, h('span', {}, k), h('span', { class: 'mono' }, String(v))));
    kv('格', `(${i.gx}, ${i.gz})`); kv('决定者', SRC_NAME[i.src]); kv('结果', i.blocked ? '阻挡' : (i.reach ? '可走 · 走得到' : '可走 · 走不到'));
    kv('自动结果', i.auto); kv('笔刷', ['无', '可走', '阻挡'][i.brush] || i.brush); kv('高度增量', `${fmt(i.height * S.k, 1)} wu`);
    kv('世界', `${fmt(i.world[0], 0)}, ${fmt(i.world[1], 0)}, ${fmt(i.world[2], 0)} wu`);
    if (S.cal) { const sc = S.cal.worldToScene(i.world[0], i.world[1], i.world[2]); kv('画面', `${fmt(sc[0], 0)}, ${fmt(sc[1], 0)}`); }
  }
  // 选中物
  const p = parseKey(S.sel.key);
  if (p) {
    const s = sec(p.kind === 'region' ? `多边形 ${p.id}` : `高度操作 ${p.id}`);
    if (p.kind === 'region') s.appendChild(choice('种类', [['walk', '可走'], ['block', '阻挡']], () => p.item.kind, (v) => edit('改种类', () => { p.item.kind = v; })));
    else {
      s.appendChild(choice('操作', [['flatten', '压平到'], ['offset', '抬高']], () => p.item.kind, (v) => edit('改操作', () => { p.item.kind = v; })));
      s.appendChild(num(p.item.kind === 'flatten' ? '目标高度 Y' : '增量', () => p.item.value * S.k, (v) => edit('改高度', () => { p.item.value = gu(v); }), 1, 'wu'));
      s.appendChild(num('羽化', () => (p.item.feather || 0) * S.k, (v) => edit('改羽化', () => { p.item.feather = gu(Math.max(0, v)); }), 5, 'wu'));
    }
    s.appendChild(h('div', { class: 'row' }, h('span', {}, 'id'), h('input', { type: 'text', value: p.id, onchange: (e) => { const nid = e.target.value.trim(); if (!nid || nid === p.id) return; if (p.list.some((r) => r.id === nid)) { status(`id ${nid} 已存在`, 'warn'); renderInspector(); return; } edit('改 id', () => { p.item.id = nid; }); select(`${p.kind}:${nid}`); } })));
    s.appendChild(h('div', { class: 'pad dim' }, `${p.item.points.length} 个顶点 · 面积 ${fmt(polygonArea(p.item.points) * S.k * S.k / 7744, 1)} m²${p.vi >= 0 ? ` · 选中顶点 ${p.vi}：${fmt(p.item.points[p.vi][0] * S.k, 0)}, ${fmt(p.item.points[p.vi][1] * S.k, 0)} wu` : ''}`));
    s.appendChild(h('div', { class: 'btns' },
      h('button', { type: 'button', onclick: () => { const c = clone(p.item); c.id = nextId(p.kind === 'region' ? 'r' : 'h', p.list); c.points = c.points.map((q) => [q[0] + S.grid.cell * 2, q[1] + S.grid.cell * 2]); edit('复制', () => { p.list.push(c); }); select(`${p.kind}:${c.id}`); } }, '复制'),
      h('button', { type: 'button', class: 'danger', onclick: () => deleteShape(`${p.kind}:${p.id}`) }, '删除')));
  }
  // 场景 / 数据
  const s = sec('作者层');
  if (S.grid) {
    const kv = (k, v) => s.appendChild(h('div', { class: 'row' }, h('span', {}, k), h('span', { class: 'mono', style: 'font-size:11px' }, String(v))));
    kv('网格', `${S.grid.w}×${S.grid.h} · 每格 ${fmt(S.grid.cell * S.k, 2)} wu`);
    kv('原点', `x ${fmt(S.grid.x_min * S.k, 0)} · z ${fmt(S.grid.z_min * S.k, 0)} wu`);
    kv('自动结果', S.auto ? `${S.auto.grid.w}×${S.auto.grid.h}${S.auto.bakedAt ? ` · ${S.auto.bakedAt}` : ''}` : '无');
    kv('作者层', `${S.baseUpdated || '（还没保存过）'}`);
    kv('导出', S.needsExport ? '待导出（资源里不是这份）' : '资源与作者层一致');
    s.appendChild(h('div', { class: 'pad dim' }, '合成规则：可走 = (自动可走 ∪ 笔刷可走 ∪ 多边形可走) − (笔刷阻挡 ∪ 多边形阻挡)。阻挡压过可走，与顺序无关。'));
  } else s.appendChild(h('div', { class: 'pad warn' }, '没有地形网格：先在照明实验室导出一次深度'));
}
function renderLinkChip() {
  const chip = el('linkChip'), st = S.link.status;
  if (!st || !st.alive) { chip.textContent = '游戏没开（推给游戏 / 导出会在它开着时原地换上）'; chip.className = 'chip off'; chip.title = st && st.err ? st.err : ''; }
  else if (!st.pageAlive) { chip.textContent = 'dev server 在，游戏页没开'; chip.className = 'chip warn'; }
  else if (st.pageBusy) { chip.textContent = '游戏页正在装场景…'; chip.className = 'chip warn'; }
  else { const same = S.scene && st.page.sceneId === S.scene.id; chip.textContent = `游戏在「${st.page.sceneId || '?'}」${same ? '' : '（不是这个场景）'}${st.page.preview ? ` · 用预览#${st.page.preview}` : ''}`; chip.className = 'chip ' + (same ? 'ok' : 'warn'); }
  const a = el('alignChip'), al = S.link.align;
  if (!S.scene || !S.grid) { a.textContent = '对齐 —'; a.className = 'chip off'; return; }
  if (!(st && st.pageAlive && st.page && S.scene && st.page.sceneId === S.scene.id)) { a.textContent = al ? `对齐 ${al.mismatch === 0 ? '✓' : '✗'} ${al.n - al.mismatch}/${al.n}（游戏已离开）` : '对齐：游戏没在本场景'; a.className = 'chip off'; return; }
  if (!al) { a.textContent = '对齐：探测中…'; a.className = 'chip warn'; return; }
  const gridOk = !al.grid || (al.grid.grid_width === S.grid.w && al.grid.grid_height === S.grid.h && Math.abs(al.grid.cell_size - S.grid.cell) < 1e-9);
  a.textContent = `运行时对齐 ${al.mismatch === 0 && gridOk ? '✓' : '✗'} ${al.n - al.mismatch}/${al.n}${gridOk ? '' : ' · 网格不同（游戏里的是旧的，推一次）'}${al.stale ? '（上次）' : ''}`;
  a.className = 'chip ' + (al.mismatch === 0 && gridOk ? 'ok' : 'bad');
  a.title = al.mismatch ? `游戏的 isCollision 与这里的合成在 ${al.mismatch} 个格心上不一致——多半是游戏里还是旧的碰撞（推给游戏 / 导出后自动重测）` : '游戏用它自己的 isCollision 判了这些格心，与这里逐点一致';
}
function renderGamePanel() {
  const p = el('gamePanel'), st = S.link.status;
  p.textContent = '';
  if (!st || !st.alive) { p.appendChild(h('div', { class: 'pad dim' }, '游戏没在跑（工作台照常能改、能存）')); return; }
  const kv = (k, v) => p.appendChild(h('div', { class: 'kv' }, h('span', {}, k), h('span', {}, String(v))));
  kv('dev server', st.game || '');
  kv('游戏页', st.pageAlive ? (st.pageBusy ? '装场景中' : '开着') : '没开');
  if (st.page) { kv('场景', st.page.sceneId || '?'); kv('预览', st.page.preview ? `第 ${st.page.preview} 次推送` : '资源'); kv('已换上', st.page.applied ? `第 ${st.page.applied} 次` : '—'); }
  if (S.link.align && S.link.align.grid) kv('游戏网格', `${S.link.align.grid.grid_width}×${S.link.align.grid.grid_height}`);
}
function renderAll() { renderScenePickers(); renderLists(); renderInspector(); renderDocState(); renderSceneNote(); renderLinkChip(); renderGamePanel(); draw(); }
function onCursorWorld(w) {
  S.cursor = w;
  const c = el('coords');
  if (!w || !S.grid) { c.textContent = ''; return; }
  const [x, z] = worldToGrid(w);
  const [gx, gz] = S.grid.cellOf(x, z);
  let cell = '';
  if (S.grid.inside(gx, gz) && S.composed) { const k = S.grid.idx(gx, gz); cell = `  格 (${gx},${gz}) ${SRC_NAME[S.composed.src[k]]}${S.composed.blocked[k] ? '' : (S.reach && !S.reach[k] ? ' · 走不到' : '')}${S.height && Math.abs(S.height[k]) > 1e-9 ? ` · Δ${fmt(S.height[k] * S.k, 1)}` : ''}`; }
  else cell = '  网格外';
  const sc = S.cal ? S.cal.worldToScene(w[0], w[1], w[2]) : null;
  c.textContent = `世界 x ${fmt(w[0], 0)}  y ${fmt(w[1], 0)}  z ${fmt(w[2], 0)} wu${sc ? `  画面 ${fmt(sc[0], 0)},${fmt(sc[1], 0)}` : ''}${cell}`;
}

// ---------------------------------------------------------------------------
// 对话框
// ---------------------------------------------------------------------------
function dialog(build) {
  return new Promise((resolve) => {
    const form = el('dialogForm'); form.textContent = '';
    const onEsc = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault(); e.stopPropagation();
      if (window.Dropdown && Dropdown.isOpen()) { Dropdown.close(); return; }
      const inp = form.querySelector('input[type=text]');
      done(inp ? '' : form.querySelector('[data-choice]') ? null : false);
    };
    const done = (v) => { window.removeEventListener('keydown', onEsc, true); if (window.Dropdown) Dropdown.close(); el('dialog').hidden = true; form.textContent = ''; resolve(v); };
    build(form, done);
    el('dialog').hidden = false;
    window.addEventListener('keydown', onEsc, true);
    const inp0 = form.querySelector('input[type=text]');
    const first = inp0 || form.querySelector('button');
    if (first) { first.focus(); if (inp0) inp0.select(); }
    form.onsubmit = (e) => { e.preventDefault(); const inp = form.querySelector('input'); done(inp ? inp.value.trim() : true); };
  });
}
function confirmDialog(title, msg) {
  return dialog((form, done) => {
    form.append(h('h3', {}, title), h('p', {}, msg),
      h('div', { class: 'btns' }, h('button', { type: 'button', 'data-choice': 'cancel', onclick: () => done(false) }, '取消'),
        h('button', { class: 'primary', type: 'button', onclick: () => done(true) }, '确定')));
  });
}
function choiceDialog(title, msg, choices) {
  return dialog((form, done) => {
    const btns = h('div', { class: 'btns' });
    choices.forEach(([v, t], i) => btns.appendChild(h('button', { type: 'button', class: i === choices.length - 1 ? 'primary' : '', 'data-choice': v, onclick: () => done(v) }, t)));
    form.append(h('h3', {}, title), h('p', {}, msg), btns);
  });
}

// ---------------------------------------------------------------------------
// 键盘
// ---------------------------------------------------------------------------
function onKey(e) {
  if (!el('dialog').hidden) return;
  if (isTypingTarget(e.target)) { if (e.key === 'Escape') e.target.blur(); return; }
  if (v3 && v3.capturesKeys()) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); void saveTerrain(); return; }
  if ((e.ctrlKey || e.metaKey) && k === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); return; }
  if ((e.ctrlKey || e.metaKey) && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); doRedo(); return; }
  if (e.ctrlKey || e.metaKey) return;
  if (e.repeat && !/^Arrow/.test(e.key) && k !== '[' && k !== ']') return;
  if (e.key === 'Escape') { if (S.draft) { cancelDraft(); status('取消'); return; } if (S.tool !== 'select') { setTool('select'); return; } select(''); return; }
  if (e.key === 'Enter') { if (S.draft && S.draft.kind === 'poly') { commitDraft(); return; } }
  if (e.key === 'Backspace') { if (S.draft && S.draft.kind === 'poly') { e.preventDefault(); toolRight(null, e); return; } }
  if (k === 'v') { setTool('select'); return; }
  if (k === 'p') { setTool(e.shiftKey ? 'polyBlock' : 'polyWalk'); return; }
  if (k === 'b' && !e.shiftKey && S.tool !== 'rectWalk') { /* B = 导出（顶栏）与矩形冲突：矩形用 Shift+B / 按钮；无修饰的 B 在没选矩形工具时 = 导出 */ void exportToGame(); return; }
  if (k === 'b' && e.shiftKey) { setTool('rectBlock'); return; }
  if (k === 'r' && S.tool !== 'select') { setTool(e.shiftKey ? 'rectBlock' : 'rectWalk'); return; }
  if (k === 'k') { setTool('brush'); return; }
  if (k === 'h') { setTool('height'); return; }
  if (k === 'i') { setTool('inspect'); return; }
  if (k === 'w') { S.gizmoMode = 'move'; draw(); return; }
  if (k === 'e') { S.gizmoMode = 'rotate'; draw(); return; }
  if (k === 'r') { S.gizmoMode = 'scale'; draw(); return; }
  if (k === '[') { wheelRadius(-1); return; }
  if (k === ']') { wheelRadius(1); return; }
  if (k === '1') { setView(3); return; }
  if (k === '2') { setView(2); return; }
  if (k === '3') { setView(3); if (v3 && v3.ok) v3.topView(); return; }
  if (k === 'f') { focusSelected(); return; }
  if (k === 'p' && e.shiftKey) { return; }
  if (e.key === 'Home') { if (S.view === 3 && v3 && v3.ok) v3.fit(true); else if (v2) v2.fit(); return; }
  if (e.key === 'Delete') { if (parseKey(S.sel.key)) { void deleteVertexKey(S.sel.key); } return; }
  if (e.key === ' ') { e.preventDefault(); return; }
  const step = e.shiftKey ? 10 : 1;
  const arrow = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
  if (arrow && nudgeSelected(arrow[0], arrow[1])) e.preventDefault();
}
// 快捷键 P 与「推给游戏」按钮冲突：P 归工具（更常用），推给游戏走按钮 / Ctrl+Enter
function onKeyGlobal(e) {
  if (!el('dialog').hidden || isTypingTarget(e.target)) return;
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void pushToGame(); }
}

// ---------------------------------------------------------------------------
// host（两个视图共用的适配层）
// ---------------------------------------------------------------------------
const host = {
  get doc() { return S.doc; }, get cal() { return S.cal; }, get scene() { return S.scene; }, get marks() { return S.marks; },
  get sel() { return S.sel; }, get tool() { return S.tool; }, get gizmoMode() { return S.gizmoMode; }, get layers() { return S.layers; },
  cellColors: () => (S.colors ? { colors: S.colors, rev: S.colorsRev } : null),
  cellOutline: () => S.cellOutline,
  cellScene: () => (S.cellQuads && S.grid ? { quads: S.cellQuads, n: S.grid.n, cellPx: S.cellPx } : null),
  objects, labels3, regionLines3, regionLines2, regionAtWorld, brushCursor, wheelRadius,
  status, select, onCursorWorld, anchorWorld: () => { const m = S.marks.find((x) => x.kind === 'spawn'); return m ? m.world : null; },
  gizmoPivot, gizmoBase, applyGizmo, gizmoLabel, dragBegin, dragTick, dragEnd, nudgeSelected,
  edgeHit, insertVertex, deleteVertexKey,
  toolDown, toolMove, toolUp, toolRight, toolDouble,
};

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
function bindUI() {
  el('sceneSel').addEventListener('change', (e) => { void openScene(e.target.value); });
  el('bgSel').addEventListener('change', (e) => { if (S.scene) void loadScene(S.scene.id, e.target.value); });
  el('btnLaunchGame').addEventListener('click', () => { void launchGame(); });
  el('btnUndo').addEventListener('click', () => doUndo());
  el('btnRedo').addEventListener('click', () => doRedo());
  el('btnSave').addEventListener('click', () => { void saveTerrain(); });
  el('btnPush').addEventListener('click', () => { void pushToGame(); });
  el('btnExport').addEventListener('click', () => { void exportToGame(); });
  el('btnHistory').addEventListener('click', () => { void showHistory(); });
  for (const b of document.querySelectorAll('#tools button[data-tool]')) b.addEventListener('click', () => setTool(b.dataset.tool));
  el('btnView3').addEventListener('click', () => setView(3));
  el('btnView2').addEventListener('click', () => setView(2));
  el('btnTop').addEventListener('click', () => { setView(3); if (v3 && v3.ok) v3.topView(); });
  el('btnFocus').addEventListener('click', () => focusSelected());
  el('btnFit').addEventListener('click', () => { if (S.view === 3 && v3 && v3.ok) v3.fit(true); else if (v2) v2.fit(); });
  for (const key of Object.keys(S.layers)) {
    const cb = el(`layer_${key}`); if (!cb) continue;
    cb.checked = S.layers[key];
    cb.addEventListener('change', () => { S.layers[key] = cb.checked; rebuildColors(); draw(); });
  }
}
async function openScene(sid, opts) {
  if (!sid || (S.scene && S.scene.id === sid && !(opts && opts.force))) return;
  if (S.dirty && !(opts && opts.discard)) {
    const pick = await choiceDialog('有没保存的改动', `${S.scene.id} 还有没保存的改动。`, [['discard', '不保存，切换'], ['cancel', '取消'], ['save', '保存并切换']]);
    if (pick === 'cancel' || pick === null) { renderScenePickers(); return; }
    if (pick === 'save') { const ok = await saveTerrain(); if (!ok) { renderScenePickers(); return; } }
    else { void API.post('/api/draft/clear', { id: S.scene.id }).catch(() => {}); void API.post('/api/push/revoke', { id: S.scene.id }).catch(() => {}); }
  }
  S.dirty = false;
  await loadScene(sid);
}
async function boot() {
  history = new History({
    get: () => ({ doc: S.doc, brush: S.brush ? u8ToB64(S.brush) : null, height: S.height ? f32ToB64(S.height) : null }),
    set: (v) => { S.doc = v.doc; S.brush = v.brush ? b64ToU8(v.brush) : (S.grid ? new Uint8Array(S.grid.n) : null); S.height = v.height ? new Float32Array(b64ToF32(v.height)) : (S.grid ? new Float32Array(S.grid.n) : null); },
    onChange: () => renderDocState(), limit: 120,
  });
  v3 = new View3D(el('view3d'), el('overlay3d'), host);
  v2 = new View2D(el('view2d'), host);
  window.addEventListener('keydown', onKey);
  window.addEventListener('keydown', onKeyGlobal);
  window.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
  document.addEventListener('keydown', (e) => { const t = e.target; if (e.key === 'Enter' && t && t.tagName === 'INPUT' && (t.type === 'text' || t.type === 'number') && !el('dialogForm').contains(t)) t.blur(); });
  document.addEventListener('change', (e) => { const t = e.target; if (!t || !el('dialog').hidden) return; if ((t.tagName === 'SELECT' && !e.isTrusted) || (t.tagName === 'INPUT' && t.type === 'checkbox')) setTimeout(() => { if (document.activeElement === t) t.blur(); }, 0); }, true);
  window.addEventListener('resize', () => { if (v3 && v3.ok) v3.resize(); if (v2) v2.resize(); });
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => { if (S.view === 3 && v3 && v3.ok) v3.resize(); else if (v2) v2.resize(); }).observe(el('center'));
  bindUI();
  setTool('select');
  setView(v3 && v3.ok ? 3 : 2);
  if (!(v3 && v3.ok)) status('这台机器拿不到 WebGL2：只有 2D 原画视图', 'warn');
  let boot0 = {};
  try { boot0 = await API.json('/api/boot'); } catch (e) { /* 服务刚起 */ }
  try { S.scenes = (await API.json('/api/scenes')).scenes || []; } catch (e) { S.scenes = []; status(`场景清单读不出来：${e.message || e}`, 'err'); }
  renderScenePickers();
  const openId = boot0.open || (S.scenes.find((s) => s.depth) || S.scenes[0] || {}).id;
  if (openId) await loadScene(openId);
  renderAll();
  scheduleDraft();
  void pollLink();
  setInterval(() => { void pollLink(); }, STATUS_POLL_MS);
  window.__ready = true;
}
function unsavedSummary() { return S.dirty && S.scene ? `${S.scene.id} 的地形作者层（多边形 / 笔刷 / 高度）还没保存` : ''; }
window.__unsavedSummary = unsavedSummary;
window.__saveUnsaved = () => {
  window.__saveUnsavedResult = 'pending';
  Promise.resolve(saveTerrain()).then((ok) => { window.__saveUnsavedResult = ok ? 'ok' : (el('status').textContent || '没存上'); }, (e) => { window.__saveUnsavedResult = String(e && e.message || e); });
};
window.__onDiscardUnsaved = () => (S.scene ? Promise.all([API.post('/api/draft/clear', { id: S.scene.id }), API.post('/api/push/revoke', { id: S.scene.id })]).catch(() => {}) : Promise.resolve());
window.addEventListener('beforeunload', (e) => { if (S.dirty && !window.__discardUnsaved) { e.preventDefault(); e.returnValue = ''; } });
window.__openScene = (sid) => { if (S.busy || history.inDrag()) { status('正在装载 / 手势没松开，稍后再试', 'warn'); return; } void openScene(sid); };
window.addEventListener('DOMContentLoaded', () => { void boot(); });
