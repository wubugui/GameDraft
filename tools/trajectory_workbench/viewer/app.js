'use strict';
/* 轨迹工作台 · 应用主体。
 * 状态只有一份 doc（资产文档，内存态）；一切改动 → Edit.* 落进 doc（经 History 入栈）→ afterEdit
 * → 防抖 POST /api/bake 取预览 + 帧；「保存」= POST /api/save（服务端再烘一次并原子写盘）。
 * 画布是主入口（工具模式 / 把手 / gizmo），右栏表单只做精修。 */

const S = {
  scenes: [], assets: [],
  doc: null, dirty: false, cleanKey: null,   // cleanKey：上次落盘 / 打开时的快照键，撤销回到它就重新算干净
  scene: null, cal: null, bgImage: null, entity: null,
  bake: null, segIndex: -1,
  sel: { points: new Set(), scope: 'points', handle: null },   // handle：选中的把手（'v0'|'apex'|'landing'|'start'|'anchor'），它们也有自己的 gizmo
  tMs: 0, playing: false, view: '2d', tool: 'select', gizmoMode: 'move',   // gizmoMode：3D 变换 gizmo 的 W/E/R（移动/旋转/缩放）
  layers: { allCurves: true, ghost: true, persp: true, npcs: false, obstacles: false, grid: false, axis: true },
  bakeTimer: 0, bakeSeq: 0, rev: 0, loadingScene: null, sceneOp: 0, entityOp: 0, entityLoad: 0, envSync: 0, busy: 0, envBroken: null, io: null,
  npcImgs: new Map(), obstacleCanvas: null, clipboard: null, txSnap: null,
  runtime: null, bundleErr: '', align: null,   // 运行时打来的 sceneSpace / trajectoryProjection + 坐标对齐自证
  backdrop: null,   // 相对曲线（binding:'free'）此刻画在哪个场景 {scene,bg}：纯 UI 态，不写进数据
};
let v2, v3, history;

// ---------------------------------------------------------------- host（两个视图 + Edit 共用的口）
const host = {
  get scene() { return S.scene; }, get cal() { return S.cal; }, get bgImage() { return S.bgImage; }, get entity() { return S.entity; },
  get doc() { return S.doc; }, get bake() { return S.bake; }, get tMs() { return S.tMs; }, get tool() { return S.tool; },
  get layers() { return S.layers; }, get sel() { return S.sel; }, get segIndex() { return S.segIndex; }, get gizmoMode() { return S.gizmoMode; },
  get obstacleCanvas() { return S.obstacleCanvas; },
  activeSeg() { const segs = S.doc && S.doc.source && S.doc.source.segments; return segs && segs[S.segIndex] || null; },
  bakeSegment(i) { return S.bake && S.bake.segments && S.bake.segments[i] || null; },
  /** 骑在曲线上那个东西静止时支点离地高（世界 wu）：`source.bake.restHeight`，是烘焙参数不是实体属性——换预览实体曲线不动 */
  restH() { const b = S.doc && S.doc.source && S.doc.source.bake || {}; return Number.isFinite(b.restHeight) ? b.restHeight : 0; },
  /** 支点 → 接地线的画面偏移：`source.bake.contactOffsetY` */
  contactOffsetY() { const b = S.doc && S.doc.source && S.doc.source.bake || {}; return Number.isFinite(b.contactOffsetY) ? b.contactOffsetY : 0; },
  binding() { return S.doc && S.doc.binding === 'free' ? 'free' : 'scene'; },
  entityRadius() { return S.entity ? Math.max(1, round2(S.entity.meta.worldWidth * S.entity.meta.scale / 2)) : 7; },
  pinned(seg) { return Edit.isPinned(S.doc, seg); },
  effPoints(seg) { return Edit.effPoints(host, seg); },
  segStartScreen(seg) { return Edit.segStartScreen(host, seg); },
  physicsInfo(seg) { try { return Edit.physicsInfo(host, seg); } catch (e) { return null; } },
  npcs() { return S.scene ? S.scene.npcs : []; },
  npcImage(id) { return S.npcImgs.get(id) || null; },
  /** 手绘段的本地曲线（画面折线） */
  localCurve(seg) {
    if (!seg || seg.kind !== 'manual') return null;
    const pts = Edit.effPoints(host, seg);
    if (pts.length < 2) return null;
    if (S.doc.space === 'world') return host.localCurveWorld(seg).map((w) => S.cal.worldToScene(w[0], w[1], w[2]));
    return densePath(pts.map((p) => [p.sx, p.sy]), !!(seg.path && seg.path.smooth));
  },
  /** 世界空间手绘段本地曲线（世界 xyz）：与 bake3d 同式——xz 走样条，h 按**归一弧长**在控制点间线性，y = 地面 + h（绝对 h） */
  localCurveWorld(seg) {
    const pts = Edit.effPointsWorld(host, seg);
    if (pts.length < 2 || !S.cal) return [];
    const smp = worldCurveSamples(pts.map((p) => ({ x: p.x, z: p.z, h: p.hAbs })), !!(seg.path && seg.path.smooth));
    return smp.map((q) => [q.x, S.cal.groundHeight(q.x, q.z) + q.h, q.z]);
  },
  localEdgeToPointIndex(seg, k) { const smooth = !!(seg.path && seg.path.smooth) && (seg.path.points || []).length >= 3; return smooth ? Math.max(0, Math.floor((k - 1) / 16)) : k; },
  /** 烘焙曲线按段切片（画面）：[{i,label,pts,foot,hard,ticks,start}] */
  previewSlices() {
    const b = S.bake; if (!b || !b.preview || !b.preview.screen || !b.segments) return [];
    const out = [];
    b.segments.forEach((bs, i) => {
      const pts = [], foot = [], hard = [], ticks = [];
      let lastTick = -1;
      for (const s of b.preview.screen) {
        if (s[0] < bs.startMs - 1e-6 || s[0] > bs.endMs + 1e-6) continue;
        pts.push([s[1], s[2]]); foot.push([s[1], s[3]]);
        if (s[8]) hard.push([s[1], s[2]]);
        const tk = Math.floor(s[0] / 500); if (tk !== lastTick && s[0] > bs.startMs) { ticks.push([s[1], s[2]]); } lastTick = tk;
      }
      const seg = S.doc.source.segments[i];
      const st = S.doc.space === 'world' && S.cal && bs.start && bs.start.length === 3 ? S.cal.worldToScene(bs.start[0], bs.start[1], bs.start[2]) : (bs.start || [0, 0]);
      out.push({ i, label: seg ? seg.id : String(i), pts, foot, hard, ticks, start: st });
    });
    return out;
  },
  previewSlicesWorld() {
    const b = S.bake; if (!b || !b.preview || !b.preview.world || !b.segments) return [];
    return b.segments.map((bs, i) => {
      const pos = [], foot = [];
      for (const w of b.preview.world) { if (w[0] < bs.startMs - 1e-6 || w[0] > bs.endMs + 1e-6) continue; pos.push(w[1], w[2], w[3]); foot.push(w[1], w[2] - w[4], w[3]); }
      return { i, pos, foot };
    });
  },
  /** 画面坐标 → 该空间的点坐标；世界空间沿地面拾取，h 保留（hKeep / 现值） */
  posFromScreen(sx, sy, seg, i, hKeep) {
    if (S.doc.space !== 'world') return [sx, sy];
    const g = S.cal.sceneToWorldGround(sx, sy);
    let hh = hKeep;
    if (hh == null && seg && seg.path && seg.path.points && seg.path.points[i]) hh = Edit.effPointsWorld(host, seg)[i].h;
    return { x: g[0], z: g[2], h: hh == null ? 0 : hh };
  },
  gizmo() {
    const scope = S.sel.scope, seg = host.activeSeg();
    if (!S.doc) return null;
    if (scope === 'points' && (S.sel.points.size < 2 || !seg || seg.kind !== 'manual')) return null;
    if (scope === 'segment' && !seg) return null;
    const box = Edit.bounds(host, scope, seg, S.sel.points);
    if (!box) return null;
    let pivot;
    if (scope === 'all') pivot = Edit.originScreen(host);
    else if (scope === 'segment' && Edit.isPinned(S.doc, seg)) pivot = Edit.segStartScreen(host, seg);
    else if (scope === 'segment' && seg.kind === 'physics') pivot = Edit.segStartScreen(host, seg);
    else pivot = [(box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2];
    return { box, pivot, scope };
  },
  /** 变换 gizmo 的轴心（两个视图共用）：模型点（世界 xyz / 画面 [x,y]）与选中数 n（< 2 只给移动）；null = 不显示。
   *  选中点 → 质心（单点也给；只选了钉住的 0 号点不给假把手）；整段 / 整条 → 现算的变换轴（落在那个东西本身上）。 */
  gizmoPivot() {
    if (!S.doc) return null;
    const world = S.doc.space === 'world', scope = S.sel.scope, seg = host.activeSeg();
    if (world && !S.cal) return null;
    // 把手：gizmo 就落在把手上（初速箭尖 / 最高点 / 落点 / 自定起点 / 插槽）
    if (S.sel.handle) {
      const k = S.sel.handle, b = host.handleBase(k); if (!b) return null;
      let pivot = null;
      if (k === 'apex') { const seg2 = host.activeSeg(); const pi = seg2 && host.physicsInfo(seg2); pivot = pi ? (world ? pi.apexW : pi.apex) : null; }
      else if (k === 'start') { const pi = host.physicsInfo(seg); pivot = pi ? (world ? pi.startW : pi.start) : null; }
      else pivot = world ? b.w : b.s;
      return pivot ? { pivot: pivot.slice(), n: 1, kind: k, label: host.handleLabel(k) } : null;
    }
    if (scope === 'points') {
      if (!seg || seg.kind !== 'manual' || !S.sel.points.size) return null;
      const eff = host.effPoints(seg); const list = [...S.sel.points].filter((i) => eff[i]);
      if (!list.length) return null;
      if (list.length === 1 && list[0] === 0 && Edit.isPinned(S.doc, seg)) return null;
      const dim = world ? 3 : 2, pivot = new Array(dim).fill(0);
      for (const i of list) { const p = world ? eff[i].pos : [eff[i].sx, eff[i].sy]; for (let k = 0; k < dim; k++) pivot[k] += p[k] / list.length; }
      return { pivot, n: list.length, kind: 'points', label: list.length === 1 ? `点 ${list[0]}` : `${list.length} 个点` };
    }
    if (scope === 'segment' && !seg) return null;
    const label = scope === 'all' ? '整条轨迹' : `整段 · ${seg.id}`;
    if (!world) { const pv = host._pivotNative(true); return pv ? { pivot: [pv[0], pv[1]], n: 2, kind: scope, label } : null; }
    // 世界：轴心就是那个东西本身的位置（整条 = 曲线起点；钉住 / 抛体的段 = 段起点；自定起点的手绘段 = 点的质心），不抬高——悬在半空谁都不知道选了什么
    let pivot = null;
    if (scope === 'all') pivot = Edit.originWorld(host);
    else if (Edit.isPinned(S.doc, seg) || seg.kind === 'physics') pivot = Edit.segStartWorld(host, seg);
    else { const pts = Edit.effPointsWorld(host, seg); if (pts.length) { pivot = [0, 0, 0]; for (const p of pts) for (let k = 0; k < 3; k++) pivot[k] += p.pos[k] / pts.length; } }
    return pivot ? { pivot: pivot.slice(), n: 2, kind: scope, label } : null;
  },
  /** gizmo 轴在该空间的表示：画面 [x,y]；世界 [x,z]。变换进行中用开始时记下的轴（点动了包围盒中心会漂）；
   *  `live` = 要现算的（3D gizmo 画在哪：拖的时候把手跟着几何走，算变换仍用记下的轴）。 */
  _pivotNative(live) {
    if (S.txPivot && !live) return S.txPivot;
    const gz = host.gizmo(); if (!gz) return null;
    if (S.doc.space !== 'world') return gz.pivot;
    const scope = S.sel.scope, seg = host.activeSeg();
    if (scope === 'all') { const a = Edit.originWorld(host); return a ? [a[0], a[2]] : null; }
    if (scope === 'segment') { const w = Edit.segStartWorld(host, seg); if (Edit.isPinned(S.doc, seg) || seg.kind === 'physics') return [w[0], w[2]]; }
    const pts = Edit.effPointsWorld(host, seg).filter((_, i) => scope === 'segment' || S.sel.points.has(i));
    if (!pts.length) { const g = S.cal.sceneToWorldGround(gz.pivot[0], gz.pivot[1]); return [g[0], g[2]]; }
    return [pts.reduce((a, p) => a + p.x, 0) / pts.length, pts.reduce((a, p) => a + p.z, 0) / pts.length];
  },
  makeTranslate(dxWu, dyWu) {
    if (S.doc.space !== 'world') return Edit.T.translate2(dxWu, dyWu);
    const gz = S.txGizmo || host.gizmo(); const p = gz ? gz.pivot : Edit.originScreen(host);
    const a = S.cal.sceneToWorldGround(p[0], p[1]), b = S.cal.sceneToWorldGround(p[0] + dxWu, p[1] + dyWu);
    return Edit.T.translate3(b[0] - a[0], b[2] - a[2], 0);
  },
  makeRotate(deg) { const pv = host._pivotNative(); if (!pv) return null; return S.doc.space === 'world' ? Edit.T.rotateY(pv, -deg) : Edit.T.rotate2(pv, deg); },
  makeScale(k) { const pv = host._pivotNative(); if (!pv) return null; return S.doc.space === 'world' ? Edit.T.scale3(pv, k, k, k) : Edit.T.scale2(pv, k, k); },
  makeMirror(axis) { const pv = host._pivotNative() || (S.doc.space === 'world' ? (() => { const a = Edit.originWorld(host); return a ? [a[0], a[2]] : [0, 0]; })() : Edit.originScreen(host)); return S.doc.space === 'world' ? Edit.T.mirror3(pv, axis === 'x' ? 'x' : 'z') : Edit.T.mirror2(pv, axis); },
  // ---- 选择
  selectPoint(i, add) { if (!add) S.sel.points = new Set(); S.sel.points.add(i); S.sel.scope = 'points'; S.sel.handle = null; renderInspector(); updateScopeButtons(); },
  togglePoint(i) { if (S.sel.points.has(i)) S.sel.points.delete(i); else S.sel.points.add(i); S.sel.scope = 'points'; S.sel.handle = null; renderInspector(); updateScopeButtons(); },
  selectPoints(list, add) { if (!add) S.sel.points = new Set(); for (const i of list) S.sel.points.add(i); S.sel.scope = 'points'; S.sel.handle = null; renderInspector(); updateScopeButtons(); },
  /** 选中一个把手（初速箭尖 / 最高点 / 落点 / 自定起点 / 插槽）：它就是"那个物体"，gizmo 落在它上面 */
  selectHandle(kind) { S.sel.points = new Set(); S.sel.scope = 'points'; S.sel.handle = kind; renderInspector(); updateScopeButtons(); },
  /** Ctrl+A：全选。起点钉住的段"全选点"不能整体挪（0 号点不动会拉变形），所以直接等于"整段"范围。 */
  selectAllPoints() {
    const seg = host.activeSeg(); if (!seg) return;
    if (seg.kind !== 'manual' || Edit.isPinned(S.doc, seg)) { host.selectSegmentScope(S.segIndex); setStatus('已切到"整段"范围：拖 gizmo 移动（会把起点改成"自定"）'); return; }
    S.sel.points = new Set((seg.path.points || []).map((_, i) => i)); S.sel.scope = 'points'; S.sel.handle = null; renderInspector(); updateScopeButtons(); draw();
  },
  selectSegment(i) { S.segIndex = i; S.sel.points = new Set(); S.sel.scope = 'points'; S.sel.handle = null; renderSegList(); renderInspector(); updateScopeButtons(); draw(); },
  selectSegmentScope(i) { S.segIndex = i; S.sel.points = new Set(); S.sel.scope = 'segment'; S.sel.handle = null; renderSegList(); renderInspector(); updateScopeButtons(); draw(); },
  setScope(scope) { S.sel.scope = scope; S.sel.handle = null; if (scope !== 'points') S.sel.points = new Set(); updateScopeButtons(); renderInspector(); draw(); },
  clearSelection() { S.sel.points = new Set(); S.sel.scope = 'points'; S.sel.handle = null; renderInspector(); updateScopeButtons(); draw(); },
  /** 把手 gizmo 的基准值（拖拽开始时记下；模型量：世界 xyz / 画面 [x,y]） */
  handleBase(kind) {
    const seg = host.activeSeg(), world = S.doc.space === 'world', au = S.doc.authoring;
    if (kind.startsWith('slot:')) { const sl = Edit.findSlot(S.doc, kind.slice(5)); if (!sl) return null; return world ? { w: Edit.slotWorld(host, sl) } : { s: [num(sl.x, 0), num(sl.y, 0)] }; }
    if (kind === 'origin') { const w = Edit.originWorld(host); const s = Edit.originScreen(host); return world ? (w ? { w: w.slice() } : null) : { s: s.slice() }; }
    if (!seg || seg.kind !== 'physics') return null;
    const pi = host.physicsInfo(seg); if (!pi) return null;
    if (kind === 'v0') return world ? { w: pi.tipW.slice() } : { s: pi.tip.slice() };
    if (kind === 'apex') return { y: world ? (pi.apexW ? pi.apexW[1] : null) : (pi.apex ? pi.apex[1] : null) };
    if (kind === 'landing') return world ? { w: pi.landingW.slice() } : { s: pi.landing.slice() };
    if (kind === 'start') return world ? { xzh: S.cal.worldToXZH(pi.startW[0], pi.startW[1], pi.startW[2]) } : { s: pi.start.slice() };
    return null;
  },
  /** 把手 gizmo 拖动：基准 + 模型位移 → 各自的设置器（与直接拖把手同一套设置器，只是位移被约束在轴 / 面上） */
  applyHandle(kind, b, v) {
    const seg = host.activeSeg(), world = S.doc.space === 'world', au = S.doc.authoring;
    const vx = v.x || 0, vy = v.y || 0, vz = v.z || 0;
    if (kind === 'origin') {
      // 原点可以离地（抛体从半空出手时常在出手点上），所以三根轴都作用在它自己身上
      if (world) { if (!b.w) return; Edit.setOriginWorld(host, [b.w[0] + vx, b.w[1] + vy, b.w[2] + vz]); }
      else Edit.setOriginScreen(host, [b.s[0] + vx, b.s[1] + vy]);
      return;
    }
    if (kind.startsWith('slot:')) {
      const id = kind.slice(5);
      if (world) { if (!b.w) return; const x = b.w[0] + vx, z = b.w[2] + vz; const f = S.cal.worldToScene(x, S.cal.groundHeight(x, z), z); Edit.setSlot(host, id, { x: f[0], y: f[1] }); }
      else Edit.setSlot(host, id, { x: b.s[0] + vx, y: b.s[1] + vy });
      return;
    }
    if (!seg || seg.kind !== 'physics') return;
    if (kind === 'v0') Edit.setTip(host, seg, world ? [b.w[0] + vx, b.w[1] + vy, b.w[2] + vz] : [b.s[0] + vx, b.s[1] + vy]);
    else if (kind === 'apex') { if (b.y != null) Edit.setApex(host, seg, b.y + vy); }
    else if (kind === 'landing') Edit.setLanding(host, seg, world ? [b.w[0] + vx, b.w[2] + vz] : [b.s[0] + vx]);
    else if (kind === 'start') Edit.setExplicitStart(host, seg, world ? { x: b.xzh.x + vx, z: b.xzh.z + vz, h: b.xzh.h + vy } : [b.s[0] + vx, b.s[1] + vy]);
  },
  handleLabel(kind) { if (kind && kind.startsWith('slot:')) { const sl = Edit.findSlot(S.doc, kind.slice(5)); return '插槽 · ' + (sl ? (sl.label || sl.id) : kind.slice(5)); } return { v0: '初速（箭尖）', apex: '最高点', landing: '落点', start: '起点', origin: '曲线原点' }[kind] || kind; },
  setTool(t) { setTool(t); },
  status(msg, cls) { setStatus(msg, cls); },
  // ---- 编辑管线（只有真的改了 doc 才标脏：纯点一下把手不能把资产标成"未保存"）
  op(label, fn) { const changed = history.commit(label, fn); afterEdit({ dirty: changed }); return changed; },
  dragBegin(label) { S.dragDoc = S.doc; history.beginDrag(label); },
  dragTick(fn) { if (S.doc !== S.dragDoc) return; fn(); afterEdit({ quick: true, dirty: false }); },
  dragEnd() { if (S.doc !== S.dragDoc) { S.dragDoc = null; history.discardDrag(); return false; } const changed = history.endDrag(); afterEdit({ dirty: changed }); return changed; },
  afterEdit() { afterEdit({ dirty: false }); },
  beginTransform() { S.txSnap = deepClone(S.doc.source.segments); S.txAuthoring = deepClone(S.doc.authoring); S.txDoc = S.doc; S.txGizmo = host.gizmo(); S.txPivot = host._pivotNative(); S.txNote = ''; history.beginDrag('变换'); },
  applyTransform(T) {
    if (!T || !S.txSnap || S.doc !== S.txDoc) return;   // 手势开始时的那份 doc 已被换掉（外部 --open）：这一发作废
    // 每 tick 从快照重来（段 + 插槽 + 整份 authoring 都回到起点，零位移就真的什么都不变）
    S.doc.source.segments = deepClone(S.txSnap);
    S.doc.authoring = deepClone(S.txAuthoring);
    const seg = host.activeSeg();
    let r = null;
    if (S.sel.scope === 'all') r = Edit.transformAll(host, T);
    else if (S.sel.scope === 'segment' && seg) r = Edit.transformSegment(host, seg, T, null);
    else if (seg) r = Edit.transformSegment(host, seg, T, S.sel.points);
    if (r && r.promoted) S.txNote = '整段平移：起点已改成"自定"（脱离上一段末点）';
    else if (r && r.allMoved && T.kind === 'translate') S.txNote = '整条平移：起点、各段与插槽一起挪';
    afterEdit({ quick: true, dirty: false });
  },
  endTransform(label) {
    S.txSnap = null; S.txAuthoring = null; S.txGizmo = null; S.txPivot = null;
    if (label) history.relabel(label);
    const changed = history.endDrag(); afterEdit({ dirty: changed });
    if (changed && S.txNote) setStatus(S.txNote);
    S.txNote = '';
  },
  /** 加点工具：追加 / 插入一个点（自动建手绘段）。入历史栈的是一次拖拽（视图松手时 dragEnd）。 */
  penAdd(sx, sy, edgeAfter, forceGround) {
    if (!S.doc) return null;
    host.dragBegin('加点');
    let seg = host.activeSeg();
    if (!seg || seg.kind !== 'manual') { S.segIndex = Edit.addSegment(host, 'manual'); seg = host.activeSeg(); }
    const pos = S.doc.space === 'world' ? (() => { const p = S.cal.pickSurface(sx, sy, !forceGround); return { x: p.x, z: p.z, h: p.h }; })() : [sx, sy];
    const i = edgeAfter != null ? Edit.insertPoint(host, seg, edgeAfter, pos) : Edit.appendPoint(host, seg, pos);
    S.sel.points = new Set([i]); S.sel.scope = 'points';
    afterEdit({ quick: true }); renderSegList();
    return { seg, i };
  },
  penAddXZH(p) {
    if (!S.doc) return null;
    host.dragBegin('加点');
    let seg = host.activeSeg();
    if (!seg || seg.kind !== 'manual') { S.segIndex = Edit.addSegment(host, 'manual'); seg = host.activeSeg(); }
    const i = Edit.appendPoint(host, seg, { x: p.x, z: p.z, h: p.h });
    S.sel.points = new Set([i]); S.sel.scope = 'points';
    afterEdit({ quick: true }); renderSegList();
    return { seg, i };
  },
  /** 抛体工具按下：活动段是抛体就用它，否则新建一段。返回段。 */
  physicsBegin() {
    if (!S.doc) return null;
    let seg = host.activeSeg();
    if (seg && seg.kind === 'physics') { host.dragBegin('拖落点'); return seg; }
    host.dragBegin('新建抛体段');
    S.segIndex = Edit.addSegment(host, 'physics'); seg = host.activeSeg();
    S.sel.points = new Set(); S.sel.scope = 'segment';
    afterEdit({ quick: true }); renderSegList();
    return seg;
  },
  /** 插槽工具：在画面点 / 3D 地面点放一个命名插槽（曲线暴露给场景的位置），放完选中它 */
  placeSlotScreen(sx, sy) {
    let id = null;
    host.op('放置插槽', () => { id = Edit.addSlot(host, sx, sy); });
    if (id) { host.selectHandle('slot:' + id); renderSlots(); renderOrigin(); setStatus(`插槽 ${id} 已放下：右栏改名字；其他动作可以把实体挪到它这里`); }
    return id;
  },
  placeSlotFromGround(g) { const f = S.cal.worldToScene(g[0], g[1], g[2]); return host.placeSlotScreen(f[0], f[1]); },
  /** 原点工具：把曲线原点放到画面点 / 3D 地面点上（放完选中它）。 */
  placeOriginScreen(sx, sy) {
    host.op('放置曲线原点', () => Edit.setOriginScreen(host, [sx, sy]));
    host.selectHandle('origin'); renderOrigin();
    setStatus('曲线原点已放下：播放时给的位置对齐的就是它（曲线的形状与它的相对关系不变）');
  },
  placeOriginFromGround(g) { host.op('放置曲线原点', () => Edit.setOriginWorld(host, [g[0], g[1], g[2]])); host.selectHandle('origin'); renderOrigin(); setStatus('曲线原点已放下（贴地）'); },
  contextSegment(i, cx, cy) { showCtxMenu(i, cx, cy); },
  onCursor(s) {
    const e = el('coords');
    if (!s) { e.textContent = '—'; return; }
    let t = `画面 ${fmt(s[0], 0)}, ${fmt(s[1], 0)}`;
    if (S.cal && S.cal.ground) {
      if (S.cal.inScene(s[0], s[1])) {
        const p = S.cal.pickSurface(s[0], s[1], true);
        t += `   世界 ${fmt(p.pos[0], 0)}, ${fmt(p.pos[1], 0)}, ${fmt(p.pos[2], 0)}` + (p.onShell ? `   表面 h ${fmt(p.h, 0)}` : '') + (S.cal.isObstacleAt(s[0], s[1]) ? '   [障碍]' : '');
      } else t += '   画外';
    }
    e.textContent = t;
  },
  onCursorWorld(g) { const e = el('coords'); e.textContent = g ? `世界 ${fmt(g[0], 0)}, ${fmt(g[1], 0)}, ${fmt(g[2], 0)}（地面）` : '—'; },
};

// ---------------------------------------------------------------- 视图 / 状态
function draw() { if (S.view === '2d') v2.draw(); else if (v3 && v3.ok) v3.draw(); }
function setStatus(msg, cls) { const e = el('status'); e.textContent = msg; e.className = cls || ''; }
function markDirty() { S.dirty = true; el('btnSave').classList.add('dirty'); }
/** 凡是不走 afterEdit 却直接改 S.doc 的地方（名称框、改名）一律走这里：修订号必须动，否则在飞的保存 / 烘焙会把改动抹回去 */
function touchDoc() { S.rev++; markDirty(); }
/** "干净"的判据：历史快照（不含 id/label）+ 名称。清脏时记下，撤销 / 重做回到这一份就重新算干净 */
function cleanKey() { return history && S.doc ? history.snapshot() + '\n' + (S.doc.label || '') : null; }
function clearDirty() { S.dirty = false; S.cleanKey = cleanKey(); el('btnSave').classList.remove('dirty'); }
/** 换 doc（打开 / 新建 / 退回）时：正在进行的手势 / 变换一并作废，别让它把上一份资产的几何写进新 doc */
function dropGestures() { S.txSnap = null; S.txAuthoring = null; S.txGizmo = null; S.txPivot = null; S.txDoc = null; S.dragDoc = null; history.discardDrag(); }
function afterEdit(o) {
  const quick = o && o.quick;
  S.rev++;
  if (!o || o.dirty !== false) markDirty();
  if (!quick) { renderSegList(); renderInspector(); renderSlots(); renderOrigin(); }
  else { renderInspectorLive(); renderSlotsLive(); renderOriginLive(); }
  scheduleBake(quick ? 90 : 0);
  draw();
}
function setTool(t) {
  S.tool = t;
  for (const b of document.querySelectorAll('#tools button[data-tool]')) b.classList.toggle('on', b.dataset.tool === t);
  draw();
}
/** 3D 变换 gizmo 的模式（Unity 的 W/E/R）；顺手切回选择工具。2D 视图的变换框三种把手常显，不看这个。 */
function setGizmoMode(m) {
  S.gizmoMode = m;
  for (const b of document.querySelectorAll('#tools button[data-gizmo]')) b.classList.toggle('on', b.dataset.gizmo === m);
  if (S.tool !== 'select') setTool('select'); else draw();
  if (S.view === '3d') setStatus({ move: '移动 gizmo：箭头 = 沿轴 · 小方块 = 沿面 · 中心 / 拖点 = 贴地走 · Ctrl 吸附', rotate: '旋转 gizmo：拖圆环 = 绕竖直轴（Ctrl 吸附 15°）', scale: '缩放 gizmo：轴末端 = 单轴 · 中心 = 等比（Ctrl 吸附 ×0.1）' }[m]);
}
function updateScopeButtons() {
  el('scopePoints').classList.toggle('on', S.sel.scope === 'points');
  el('scopeSegment').classList.toggle('on', S.sel.scope === 'segment');
  el('scopeAll').classList.toggle('on', S.sel.scope === 'all');
  el('txRotHint').textContent = S.doc && S.doc.space === 'world' ? '绕竖直轴' : '';
}
function updateHistoryButtons() {
  el('btnUndo').disabled = !history.canUndo; el('btnRedo').disabled = !history.canRedo;
  el('btnUndo').title = 'Ctrl+Z' + (history.canUndo ? '：' + history.peekUndo() : '');
  el('btnRedo').title = 'Ctrl+Y' + (history.canRedo ? '：' + history.peekRedo() : '');
}

// ---------------------------------------------------------------- 启动
async function boot() {
  history = new History({
    // id / label 不进历史（改名 / 另存 / 名称框都绕开历史栈；快照里带着它们，撤销一条无关编辑就会把 id 倒回去、Ctrl+S 写错文件）
    get: () => { if (!S.doc) return S.doc; const { id, label, ...rest } = S.doc; return rest; },
    // 撤销 / 重做落回"上次落盘时的那份"（含名称）就不算脏：撤到底后保存按钮不该还亮着
    set: (doc) => { const cur = S.doc || {}; doc.id = cur.id; if (cur.label != null) doc.label = cur.label; else delete doc.label; S.doc = doc; S.rev++; S.bakeSeq++; clearTimeout(S.bakeTimer); clampSelection(); if (cleanKey() === S.cleanKey) clearDirty(); else markDirty(); renderAll(); syncEnvWithDoc(); },
    onChange: updateHistoryButtons,
  });
  v2 = new View2D(el('view2d'), host);
  try { v3 = new View3D(el('view3d'), host); v3.overlay = el('overlay3d'); } catch (e) { console.warn('3D 视图不可用', e); v3 = { ok: false, draw() {}, resize() {}, fit() {}, fitCurve() {}, setMesh() {}, setTexture() {}, setGhostTexture() {} }; }
  if (!v3.ok) el('tab3d').title = '这台机器拿不到 WebGL2，3D 视图不可用';
  wireUI();
  window.addEventListener('resize', () => { v2.resize(); v3.resize(); });
  v2.resize(); v3.resize();
  updateHistoryButtons(); updateScopeButtons();
  // 运行时的换算 / 投影（同一份 TS 打的包）。装不上不拦着干活，但场景芯片会说明"对不了"——
  // 页面画的形状与游戏开播的形状没人核过，这件事必须让作者看见。
  try { S.runtime = await import('/gen/runtime.bundle.js?t=' + Date.now()); }
  catch (e) { S.runtime = null; S.bundleErr = e.message; console.warn('运行时包装不上', e); }
  try {
    const [sc, tr] = await Promise.all([API.json('/api/scenes'), API.json('/api/trajectories')]);
    S.scenes = sc.scenes; S.assets = tr.trajectories;
    fillSceneSel(); fillAssetSel();
    const b = await API.json('/api/boot');
    if (b.open) await openAsset(b.open);
    else if (S.assets.length && !S.assets[0].error) await openAsset(S.assets[0].id);
    else await newAssetDialog();
  } catch (e) { setStatus('启动失败: ' + e.message, 'err'); }
}
window.__openTrajectory = (id) => {
  if (S.busy > 0 || S.envBroken || history.inDrag() || S.txSnap) { setStatus('正在装载 / 现场没对上 / 手势没松开，稍后再从主编辑器打开 ' + id, 'err'); return; }
  confirmDiscard().then((ok) => { if (ok) openAsset(id).catch((e) => setStatus(e.message, 'err')); });
};

function fillSceneSel() {
  const sel = el('sceneSel'); sel.innerHTML = '';
  for (const s of S.scenes) sel.append(h('option', { value: s.id }, `${s.name}${s.depth ? '' : '（无深度）'}`));
}
function fillBgSel() {
  const sel = el('bgSel'); sel.innerHTML = '';
  const sc = S.scenes.find((s) => s.id === el('sceneSel').value);
  for (const b of (sc ? sc.backgrounds : [])) sel.append(h('option', { value: b.image }, `${b.image}${b.ground ? '' : ' (无行走面场)'}`));
}
function fillAssetSel() {
  const sel = el('assetSel'); sel.innerHTML = '';
  sel.append(h('option', { value: '' }, '— 选一条轨迹 —'));
  for (const a of S.assets) { const label = S.doc && a.id === S.doc.id ? (S.doc.label || '') : (a.label || ''); sel.append(h('option', { value: a.id }, a.error ? `⚠ ${a.id}（坏文件）` : `${a.id}${label ? ' · ' + label : ''}  [${a.space === 'world' ? '3D' : '2D'} ${a.frames}帧]`)); }
  if (S.doc) sel.value = S.assets.some((a) => a.id === S.doc.id) ? S.doc.id : '';
}
function fillEntitySel() {
  const sel = el('entitySel'); sel.innerHTML = '';
  sel.append(h('option', { value: '' }, '（不预览实体）'));
  sel.append(h('option', { value: 'player' }, '玩家'));
  for (const n of (S.scene ? S.scene.npcs : [])) sel.append(h('option', { value: n.id }, `${n.name}${n.hasImage ? '' : '（无图）'}`));
  const e = S.doc && S.doc.authoring.entity;
  sel.value = e ? (e.kind === 'player' ? 'player' : e.id || '') : '';
}
/** 右栏"插槽"列表：id / 名字 / 坐标 / 删；点行选中它（gizmo 落上去）。渲染只读，改动经 host.op。 */
function renderSlots() {
  const box = el('slotlist'); if (!box) return; box.innerHTML = '';
  if (!S.doc) return;
  const slots = Edit.slots(S.doc);
  el('slotCount').textContent = slots.length ? `${slots.length} 个` : '还没有插槽：按 S 在画布上点一下放一个';
  for (const sl of slots) {
    const on = S.sel.handle === 'slot:' + sl.id;
    const idInp = h('input', { type: 'text', value: sl.id, style: 'width:96px', title: '插槽 id（其他动作引用它）' });
    idInp.addEventListener('change', () => host.op('改插槽 id', () => { if (!Edit.renameSlot(host, sl.id, idInp.value)) { idInp.value = sl.id; setStatus('插槽 id 不能为空或重复', 'err'); } else if (S.sel.handle === 'slot:' + sl.id) S.sel.handle = 'slot:' + idInp.value.trim(); }));
    const lbInp = h('input', { type: 'text', value: sl.label || '', placeholder: '名字（策划看的）', style: 'width:110px' });
    lbInp.addEventListener('change', () => host.op('改插槽名', () => Edit.setSlotLabel(host, sl.id, lbInp.value)));
    const xy = h('span', { class: 'mono dim' }, `${fmt(sl.x, 0)}, ${fmt(sl.y, 0)}`);
    const del = h('button', { class: 'danger', title: '删除这个插槽（引用它的动作会悬空）', onclick: (e) => { e.stopPropagation(); host.op('删插槽', () => Edit.deleteSlot(host, sl.id)); if (S.sel.handle === 'slot:' + sl.id) host.clearSelection(); } }, '×');
    const row = h('div', { class: 'seg' + (on ? ' on' : ''), onclick: (e) => { if (e.target.tagName === 'INPUT') return; host.selectHandle('slot:' + sl.id); draw(); renderSlots(); renderOrigin(); } }, idInp, lbInp, xy, del);
    for (const inp of [idInp, lbInp]) inp.addEventListener('mousedown', (e) => e.stopPropagation());
    box.append(row);
  }
}
/** 右栏"曲线原点"：坐标 + 两个常用动作。原点是作者摆的参考点，不是第一帧（2026-09-11 第二轮）。 */
function renderOrigin() {
  const box = el('originbox'); if (!box) return; box.innerHTML = '';
  if (!S.doc) return;
  const world = S.doc.space === 'world';
  const o = Edit.originScreen(host);
  const w = world ? Edit.originWorld(host) : null;
  const on = S.sel.handle === 'origin';
  const txt = world && w
    ? `x ${fmt(w[0], 0)} · z ${fmt(w[2], 0)} · 离地 ${fmt(Edit.originHeight(host), 1)}`
    : `x ${fmt(o[0], 0)} · y ${fmt(o[1], 0)}`;
  const row = h('div', { class: 'seg' + (on ? ' on' : ''), onclick: () => { host.selectHandle('origin'); draw(); renderOrigin(); } },
    h('span', { class: 'mono' }, txt),
    h('span', { class: 'dim' }, Edit.hasOrigin(host) ? '' : '（还没单独摆过：跟着曲线起点）'));
  const place = h('button', { title: '在画布上点一下放原点（O）', onclick: () => setTool('origin') }, '画布放置 (O)');
  const toStart = h('button', { title: '把原点放回曲线起点（第 0 段的起点）', onclick: () => { host.op('原点放到曲线起点', () => Edit.originToCurveStart(host)); renderOrigin(); draw(); setStatus('原点已放到曲线起点'); } }, '放到曲线起点');
  const acts = h('div', { class: 'row' }, place, toStart);
  if (world) {
    const hInp = h('input', { type: 'number', step: '1', value: String(fmt(Edit.originHeight(host), 2)), style: 'width:70px', title: '原点离地高（wu）' });
    hInp.addEventListener('change', () => { host.op('改原点离地高', () => Edit.setOriginHeight(host, parseFloat(hInp.value) || 0)); renderOrigin(); draw(); });
    hInp.addEventListener('mousedown', (e) => e.stopPropagation());
    acts.append(h('span', { class: 'lbl' }, '离地'), hInp);
  }
  box.append(row, acts);
}
function renderOriginLive() { const box = el('originbox'); if (!box || !S.doc) return; const m = box.querySelector('span.mono'); if (!m) return; const world = S.doc.space === 'world'; const w = world ? Edit.originWorld(host) : null; const o = Edit.originScreen(host); m.textContent = world && w ? `x ${fmt(w[0], 0)} · z ${fmt(w[2], 0)} · 离地 ${fmt(Edit.originHeight(host), 1)}` : `x ${fmt(o[0], 0)} · y ${fmt(o[1], 0)}`; }
function renderSlotsLive() { const box = el('slotlist'); if (!box || !S.doc) return; const rows = box.children; Edit.slots(S.doc).forEach((sl, i) => { const r = rows[i]; if (!r) return; const xy = r.querySelector('span.mono'); if (xy) xy.textContent = `${fmt(sl.x, 0)}, ${fmt(sl.y, 0)}`; }); }

function wireUI() {
  el('assetSel').addEventListener('change', async (e) => { if (e.target.value) { if (!(await confirmDiscard())) { e.target.value = S.doc ? S.doc.id : ''; return; } openAsset(e.target.value).catch((x) => setStatus(x.message, 'err')); } });
  el('btnNew').addEventListener('click', async () => { if (await confirmDiscard()) newAssetDialog().catch((e) => setStatus('新建失败: ' + e.message, 'err')); });
  el('btnSave').addEventListener('click', saveAsset);
  el('btnRename').addEventListener('click', renameAsset);
  el('btnDup').addEventListener('click', duplicateAsset);
  el('btnDelete').addEventListener('click', deleteAsset);
  el('btnUndo').addEventListener('click', () => doUndo());
  el('btnRedo').addEventListener('click', () => doRedo());
  el('busyRetry').addEventListener('click', () => { syncEnvWithDoc(); });
  el('label').addEventListener('input', (e) => { if (S.doc) { S.doc.label = e.target.value; touchDoc(); fillAssetSelKeep(); } });
  el('space').addEventListener('change', (e) => changeSpace(e.target.value));
  el('sceneSel').addEventListener('change', () => { fillBgSel(); changeScene(el('sceneSel').value, el('bgSel').value).catch((e) => setStatus('换场景失败: ' + e.message, 'err')); });
  el('bgSel').addEventListener('change', () => changeScene(el('sceneSel').value, el('bgSel').value).catch((e) => setStatus('换时段失败: ' + e.message, 'err')));
  el('entitySel').addEventListener('change', (e) => changeEntity(e.target.value));
  el('binding').addEventListener('change', (e) => changeBinding(e.target.value));
  el('btnSlotPlace').addEventListener('click', () => setTool('slot'));
  el('btnBakeFromEntity').addEventListener('click', () => takeBakeParamsFromEntity(true));
  for (const b of document.querySelectorAll('#tools button[data-tool]')) b.addEventListener('click', () => setTool(b.dataset.tool));
  for (const b of document.querySelectorAll('#tools button[data-gizmo]')) b.addEventListener('click', () => setGizmoMode(b.dataset.gizmo));
  el('tab2d').addEventListener('click', () => setView('2d'));
  el('tab3d').addEventListener('click', () => setView('3d'));
  el('btnFit').addEventListener('click', () => { if (S.view === '2d') v2.fit(); else v3.fit(); });
  el('btnFitCurve').addEventListener('click', () => { if (S.view === '2d') v2.fitCurve(); else v3.frameSelection(); });
  el('btnHelp').addEventListener('click', showHelp);
  el('btnAddManual').addEventListener('click', () => { host.op('新建手绘段', () => { S.segIndex = Edit.addSegment(host, 'manual'); S.sel.points = new Set(); S.sel.scope = 'points'; }); setTool('pen'); setStatus('手绘段：在画布上点击追加控制点（Enter 结束）'); });
  el('btnAddPhysics').addEventListener('click', () => { host.op('新建抛体段', () => { S.segIndex = Edit.addSegment(host, 'physics'); S.sel.points = new Set(); S.sel.scope = 'segment'; }); setTool('select'); setStatus('抛体段：拖橙色箭尖改初速，拖绿色落点直接定落点，拖紫色最高点改弧高'); });
  el('btnSegUp').addEventListener('click', () => host.op('段上移', () => { S.segIndex = Edit.moveSegment(host, S.segIndex, -1); }));
  el('btnSegDown').addEventListener('click', () => host.op('段下移', () => { S.segIndex = Edit.moveSegment(host, S.segIndex, 1); }));
  el('btnSegDup').addEventListener('click', duplicateSegment);
  el('btnSegDel').addEventListener('click', deleteSegment);
  el('scopePoints').addEventListener('click', () => host.setScope('points'));
  el('scopeSegment').addEventListener('click', () => { if (S.segIndex >= 0) host.setScope('segment'); });
  el('scopeAll').addEventListener('click', () => host.setScope('all'));
  el('btnTxMove').addEventListener('click', () => applyNumericTransform('move'));
  el('btnTxRot').addEventListener('click', () => applyNumericTransform('rot'));
  el('btnTxScale').addEventListener('click', () => applyNumericTransform('scale'));
  el('btnMirrorX').addEventListener('click', () => applyNumericTransform('mx'));
  el('btnMirrorY').addEventListener('click', () => applyNumericTransform('my'));
  for (const cb of document.querySelectorAll('input[data-layer]')) { cb.checked = !!S.layers[cb.dataset.layer]; cb.addEventListener('change', () => { S.layers[cb.dataset.layer] = cb.checked; if (cb.dataset.layer === 'npcs' && cb.checked) loadNpcImages(); draw(); }); }
  for (const id of ['sampleHz', 'tolPos', 'tolRot', 'tolScale', 'tolAlpha', 'restHeight', 'contactOffsetY']) el(id).addEventListener('change', readBakeSettings);
  el('btnPlay').addEventListener('click', togglePlay);
  el('btnStepBack').addEventListener('click', () => stepTime(-1000 / 60));
  el('btnStepFwd').addEventListener('click', () => stepTime(1000 / 60));
  el('scrub').addEventListener('input', (e) => { const total = S.bake ? S.bake.totalMs : 0; S.tMs = total * e.target.value / 1000; S.playing = false; el('btnPlay').textContent = '▶ 播放'; updateTime(); draw(); });
  window.addEventListener('keydown', onKey);
  window.addEventListener('beforeunload', (e) => { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });
  document.addEventListener('mousedown', (e) => { if (!el('ctxmenu').contains(e.target)) hideCtxMenu(); });
}
function onKey(e) {
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (ctrl && k === 's') {
    // 焦点在输入框里也要能存：先 blur 让 change 提交（检视器数字框是 change 提交，不 blur 会存到旧值），再存
    e.preventDefault();
    if (isTyping(e)) { e.target.blur(); setTimeout(() => saveAsset(), 0); } else saveAsset();
    return;
  }
  if (S.view === '3d' && v3.ok && v3.capturesKeys()) return;   // 按住右键飞行中：W/A/S/D/Q/E 归相机（view3d 在捕获阶段已吃掉，这里是保险）
  if (S.busy > 0) { e.preventDefault(); return; }   // 装载中：一切键盘编辑作废（含停在下拉 / 输入框上的焦点）
  if (S.envBroken) {   // 现场没对上：只放行撤销 / 重做（它们会再触发一次重装）
    if (ctrl && (k === 'z' || k === 'y')) { e.preventDefault(); if (k === 'y' || e.shiftKey) doRedo(); else doUndo(); }
    else e.preventDefault();
    return;
  }
  if (isTyping(e) && !(e.target && e.target.tagName === 'SELECT')) { if (e.key === 'Escape') e.target.blur(); return; }   // 下拉不算打字：焦点停在场景下拉上 Ctrl+Z 也得管用
  if (el('modalWrap').classList.contains('show')) return;
  if (ctrl && k === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); return; }
  if (ctrl && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); doRedo(); return; }
  if (ctrl && k === 'a') { e.preventDefault(); host.selectAllPoints(); return; }
  if (ctrl && k === 'd') { e.preventDefault(); duplicateSegment(); return; }
  if (ctrl && k === 'c') { const seg = host.activeSeg(); if (seg) { S.clipboard = deepClone(seg); setStatus('已复制段 ' + seg.id); } return; }
  if (ctrl && k === 'v') { if (S.clipboard && S.doc) host.op('粘贴段', () => { S.segIndex = Edit.pasteSegment(host, S.clipboard); S.sel.points = new Set(); S.sel.scope = 'segment'; }); return; }
  if (ctrl) return;
  if (!S.doc) return;
  switch (e.key) {
    case 'v': case 'V': setTool('select'); return;
    case 'p': case 'P': setTool('pen'); return;
    case 't': case 'T': setTool('physics'); return;
    case 's': case 'S': setTool('slot'); return;
    case 'o': case 'O': setTool('origin'); return;
    case 'h': case 'H': case 'q': case 'Q': setTool('pan'); return;   // Q = Unity 的手形工具
    case 'w': case 'W': setGizmoMode('move'); return;
    case 'e': case 'E': setGizmoMode('rotate'); return;
    case 'r': case 'R': setGizmoMode('scale'); return;
    case 'Escape': if (S.tool !== 'select') setTool('select'); else host.clearSelection(); return;
    case 'Enter': if (S.tool === 'pen' || S.tool === 'physics' || S.tool === 'slot' || S.tool === 'origin') setTool('select'); return;
    case 'Delete': case 'Backspace': e.preventDefault(); deleteSelection(); return;
    case 'k': case 'K': togglePlay(); return;
    case ',': stepTime(-1000 / 60); return;
    case '.': stepTime(1000 / 60); return;
    case 'Home': if (S.view === '2d') v2.fit(); else v3.fit(); return;
    case 'f': case 'F': if (S.view === '2d') v2.fitCurve(); else v3.frameSelection(); return;   // 3D：对准选中（Unity 的 F）
    case '[': if (S.segIndex > 0) host.selectSegment(S.segIndex - 1); return;
    case ']': if (S.segIndex < S.doc.source.segments.length - 1) host.selectSegment(S.segIndex + 1); return;
    case '1': setView('2d'); return;
    case '2': setView('3d'); return;
    case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown': {
      e.preventDefault();
      const d = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0, dy = e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0;
      if (S.view === '2d') v2.nudge(dx, dy); else if (v3.ok) v3.nudge(dx, -dy);   // 3D：↑ = 往远处（+z）
      return;
    }
    default: return;
  }
}
function doUndo() { const l = history.undo(); if (l) setStatus('撤销：' + l); }
function doRedo() { const l = history.redo(); if (l) setStatus('重做：' + l); }
/** 撤销/重做后：doc 里的场景 / 时段 / 预览实体与当前装载的现场对不上就重装（换场景、换实体都进历史栈，画布不能画着另一个场景）。 */
/** 现场对得上时同步直接放行（不升门：升门再降门要过一个微任务，连按 Ctrl+Z / Ctrl+Y 的第二下会被门吃掉） */
function envMismatch() {
  if (!S.doc) return false;
  const au = S.doc.authoring, ref = docSceneRef(), wantBg = ref.bg || '', wantKey = ref.scene + '|' + wantBg;
  const sceneMismatch = !S.scene || S.loadingScene !== wantKey || S.scene.id !== ref.scene || (wantBg && S.scene.background !== wantBg);
  const entId = au.entity ? (au.entity.kind === 'player' ? 'player' : au.entity.id || '') : '';
  return sceneMismatch || (S.entity ? S.entity.id : '') !== entId;
}
async function syncEnvWithDoc() {
  if (!S.doc) return;
  if (!envMismatch() && !S.envBroken) { scheduleBake(0); return; }
  setBusy(1, '重新装载现场…'); try { return await _syncEnvWithDoc(); } finally { setBusy(-1); }
}
async function _syncEnvWithDoc() {
  if (!S.doc) return;
  const op = ++S.envSync;
  const au = S.doc.authoring;
  // 判据同时看"已装载的"和"正在装载的"（loadScene 同步设 S.loadingScene）：撤销→重做落在装载途中时，
  // 已装载的还是旧场景、正在装的却是另一个，不重装就会画着 A 写着 B
  const ref = docSceneRef(), wantBg = ref.bg || '';
  const wantKey = ref.scene + '|' + wantBg;
  const sceneMismatch = !S.scene || S.loadingScene !== wantKey || S.scene.id !== ref.scene || (wantBg && S.scene.background !== wantBg);
  const entId = au.entity ? (au.entity.kind === 'player' ? 'player' : au.entity.id || '') : '';
  const entMismatch = (S.entity ? S.entity.id : '') !== entId;
  try {
    if (sceneMismatch) {
      setStatus('doc 指向 ' + ref.scene + '，重新装载现场…');
      el('sceneSel').value = ref.scene; fillBgSel(); if (wantBg) el('bgSel').value = wantBg;
      await loadScene(ref.scene, wantBg || el('bgSel').value);
      if (op !== S.envSync) return;
      fillEntitySel();
    }
    if (sceneMismatch || entMismatch) { await loadEntity(entId); if (op !== S.envSync) return; el('entitySel').value = entId; S.bake = null; renderAll(); }
    if (S.envBroken) setEnvBroken(null);   // 对上了
  } catch (e) {
    if (op !== S.envSync) return;
    S.loadingScene = S.scene ? S.scene.id + '|' + (S.scene.background || '') : null;
    const msg = '重新装载现场失败：' + e.message + '（画布仍是 ' + (S.scene ? S.scene.id : '空') + '，doc 指向 ' + ref.scene + '）。点"重试装载"，或 Ctrl+Z / Ctrl+Y 换一个状态';
    setStatus(msg, 'err');
    setEnvBroken(msg);
    return;
  }
  if (sceneMismatch) { v2.fitCurve(); if (v3.ok) v3.fitCurve(); }
  scheduleBake(0);
}
function clampSelection() {
  const segs = S.doc ? Edit.segs(S.doc) : [];
  if (S.segIndex >= segs.length) S.segIndex = segs.length - 1;
  if (S.segIndex < 0 && segs.length) S.segIndex = 0;
  const seg = host.activeSeg();
  const n = seg && seg.path && seg.path.points ? seg.path.points.length : 0;
  S.sel.points = new Set([...S.sel.points].filter((i) => i < n));
  if (S.sel.handle && S.sel.handle !== 'anchor' && !(seg && seg.kind === 'physics')) S.sel.handle = null;   // 撤销把抛体段撤没了：把手选择作废
}
function deleteSelection() {
  if (S.sel.handle === 'origin') { setStatus('曲线原点删不掉（每条曲线都有一个）：拖它、或右栏「放到曲线起点」', 'err'); return; }
  if (S.sel.handle && S.sel.handle.startsWith('slot:')) { const id = S.sel.handle.slice(5); host.op('删插槽', () => Edit.deleteSlot(host, id)); host.clearSelection(); setStatus(`已删除插槽 ${id}（Ctrl+Z 撤销）`); return; }
  const seg = host.activeSeg(); if (!seg) return;
  if (S.sel.scope === 'segment') { deleteSegment(); setStatus('已删除段 ' + seg.id + '（Ctrl+Z 撤销）'); return; }
  if (S.sel.scope === 'all') { setStatus('范围是"整条"：要删整条轨迹用顶栏"删除…"', 'err'); return; }
  if (seg.kind === 'physics') { setStatus('抛体段没有点可删；范围切到"整段"（点曲线 / 右栏"整段"）再按 Delete 删这一段'); return; }
  if (!S.sel.points.size) { setStatus('没有选中的点（Delete 删点；选"整段"再按 Delete 删段）'); return; }
  const idx = [...S.sel.points];
  host.op('删除控制点', () => { const n = Edit.deletePoints(host, seg, idx); if (n < idx.length) setStatus(n ? '锁定的起点没删' : '至少留一个点', 'err'); S.sel.points = new Set(); });
}
function deleteSegment() {
  if (S.segIndex < 0) return;
  host.op('删除段', () => { Edit.deleteSegment(host, S.segIndex); S.segIndex = Math.min(S.segIndex, Edit.segs(S.doc).length - 1); S.sel.points = new Set(); S.sel.scope = 'points'; });
}
function duplicateSegment() { if (S.segIndex < 0) return; host.op('复制段', () => { S.segIndex = Edit.duplicateSegment(host, S.segIndex); S.sel.points = new Set(); S.sel.scope = 'segment'; }); }
function applyNumericTransform(kind) {
  if (!S.doc) return;
  const seg = host.activeSeg();
  if (S.sel.scope === 'points' && (!seg || seg.kind !== 'manual' || !S.sel.points.size)) { setStatus('先选点，或把范围切到"整段 / 整条"', 'err'); return; }
  if (S.sel.scope === 'segment' && !seg) return;
  let T = null, label = '';
  if (kind === 'move') { const dx = num(el('txDx').value, 0), dy = num(el('txDy').value, 0); if (!dx && !dy) { setStatus('平移量为 0'); return; } T = host.makeTranslate(dx, dy); label = '平移'; }
  else if (kind === 'rot') { const a = num(el('txRot').value, 0); if (!a) { setStatus('角度为 0'); return; } T = host.makeRotate(a); label = '旋转'; }
  else if (kind === 'scale') { const k = num(el('txScale').value, 1); if (!(k > 0)) { setStatus('缩放必须 > 0', 'err'); return; } if (k === 1) { setStatus('缩放 ×1'); return; } T = host.makeScale(k); label = '缩放'; }
  else if (kind === 'mx') { T = host.makeMirror('x'); label = '镜像'; }
  else if (kind === 'my') { T = host.makeMirror('y'); label = '镜像'; }
  if (!T) return;
  host.beginTransform(); host.applyTransform(T); host.endTransform(label);
}
function fillAssetSelKeep() { const v = el('assetSel').value; fillAssetSel(); el('assetSel').value = v; }
async function confirmDiscard() { return !S.dirty || confirmModal('当前轨迹有未保存的改动，丢弃？', '丢弃'); }
function setView(v) {
  if (v === '3d' && !v3.ok) return;
  S.view = v; el('tab2d').classList.toggle('on', v === '2d'); el('tab3d').classList.toggle('on', v === '3d');
  el('view2d').style.display = v === '2d' ? 'block' : 'none'; el('view3d').style.display = v === '3d' ? 'block' : 'none'; el('overlay3d').style.display = v === '3d' ? 'block' : 'none';
  if (v === '2d') v2.resize(); else v3.resize();
  draw();
}

// ---------------------------------------------------------------- 弹窗
function modal(spec) {
  return new Promise((resolve) => {
    const wrap = el('modalWrap'), box = el('modal'); box.innerHTML = '';
    box.append(h('h2', {}, spec.title));
    if (spec.message) box.append(h('div', { class: 'msg' }, spec.message));
    const inputs = {};
    for (const f of (spec.fields || [])) {
      let inp;
      if (f.type === 'select') { inp = h('select', { style: 'min-width:220px' }); for (const o of f.options) inp.append(h('option', { value: o.value }, o.label)); inp.value = f.value; }
      else if (f.type === 'checkbox') inp = h('input', { type: 'checkbox', checked: !!f.value });
      else inp = h('input', { type: 'text', value: f.value == null ? '' : f.value, style: 'min-width:220px', placeholder: f.placeholder || '' });
      inputs[f.key] = inp;
      if (f.onchange) inp.addEventListener('change', () => f.onchange(inputs));
      box.append(h('div', { class: 'row' }, h('span', { class: 'lbl' }, f.label), inp, f.hint ? h('span', { class: 'dim' }, f.hint) : null));
    }
    const err = h('div', { style: 'color:var(--err);min-height:16px;font-size:12px' }); box.append(err);
    const done = (v) => { wrap.classList.remove('show'); window.removeEventListener('keydown', onk, true); resolve(v); };
    const ok = async () => {
      const vals = {}; for (const [k, inp] of Object.entries(inputs)) vals[k] = inp.type === 'checkbox' ? inp.checked : inp.value;
      if (spec.validate) { const m = await spec.validate(vals); if (m) { err.textContent = m; return; } }
      done(vals);
    };
    const onk = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } else if (e.key === 'Enter' && e.target.tagName !== 'SELECT') { e.stopPropagation(); ok(); } };
    window.addEventListener('keydown', onk, true);
    box.append(h('div', { class: 'btns' }, h('button', { onclick: () => done(null) }, spec.cancel || '取消'), h('button', { class: spec.danger ? 'danger' : 'primary', onclick: ok }, spec.ok || '确定')));
    wrap.classList.add('show');
    const first = Object.values(inputs)[0]; if (first && first.focus) { first.focus(); if (first.select) first.select(); }
    if (spec.onOpen) spec.onOpen(inputs);
  });
}
async function confirmModal(message, okLabel, danger) { return !!(await modal({ title: '确认', message, ok: okLabel || '确定', danger: !!danger })); }
function showHelp() {
  modal({ title: '快捷键与手势', message:
    '工具：V 选择 · P 加点 · T 抛体（拖落点）· S 插槽（放命名插槽点）· H/Q 手形（平移）· W/E/R 移动/旋转/缩放 gizmo · Esc 回选择/取消选择 · Enter 结束加点\n' +
    '2D 画布：滚轮缩放 · 中键/空格+左键/右键拖 平移 · Home 复位 · F 框住轨迹 · 1/2 切 2D/3D\n' +
    '3D 相机（Unity 习惯）：右键拖 环视 · 按住右键 W/A/S/D 前左后右、Q/E 下上飞行（Shift ×3，滚轮调速）· Alt+左键 环绕 · 中键/空格+左键 平移 · 滚轮 缩放到光标 · Alt+右键 推拉 · F 对准选中 · Home 整场 · 双击点 对准它 · 右上角坐标架：点 X/Y/Z 臂 = 从那一侧正交看，点中心 = 透视⇄正交\n' +
    '选择：点点/拖点 · Shift/Ctrl+点 加减选 · 左键空白拖 框选（Shift 追加）· 点曲线选段 · 点幽灵（预览实体）选整条 · 点插槽选它 · 双击曲线 插点（2D）· Ctrl+A 全选点 · [ ] 上/下一段\n' +
    '曲线：没有锚点——播放位置在播放时给；场景曲线绑定作者场景、不给位置就在画的地方播；相对曲线不绑场景、播放必须给位置。插槽 = 曲线暴露给场景的位置，其他动作可以把实体挪到那里。换预览实体曲线不动。\n' +
    '变换 gizmo（2D / 3D 视图都有，选中任何东西就出现在轴心，一个点也算）：W 移动——世界空间 红X（画面右）/ 绿Y 改离地高度 / 蓝Z 沿地面往远处（2D 里与 Y 重叠，错开画成虚线）、绿面片 / 中心贴地走；画面空间 X/Y 箭头 + 中心自由挪；E 旋转：拖圆环；R 缩放：轴末端单轴、中心等比；拖动时按住 Ctrl 吸附（10 wu / 15° / ×0.1）\n' +
    '编辑：Delete 删点（整段范围时删段）· 方向键微移（Shift ×10）· Ctrl+Z/Y 撤销重做 · Ctrl+D 复制段 · Ctrl+C/V 复制/粘贴段\n' +
    '世界空间：拖点沿地面走；选中点上方 ▲ 或 Alt+拖 改离地高度；加点时点在桌面/台阶上会落在其表面（Alt 强制落地面）；右键点点 删点\n' +
    '抛体：拖橙色箭尖 = 初速（Alt = 竖直分量）· 拖绿色落点 = 直接定落点 · 拖紫色最高点 = 弧高 · 2D 拖绿色虚线 = 地面线\n' +
    '播放：K 播放/暂停 · , . 逐帧 · Ctrl+S 保存', ok: '知道了' });
}
function showCtxMenu(i, cx, cy) {
  const m = el('ctxmenu'); m.innerHTML = '';
  const seg = Edit.segs(S.doc)[i]; if (!seg) return;
  const item = (label, fn) => m.append(h('div', { onclick: () => { hideCtxMenu(); fn(); } }, label));
  item(`选中 ${seg.id}`, () => host.selectSegmentScope(i));
  item('复制到剪贴板', () => { S.clipboard = deepClone(seg); setStatus('已复制段 ' + seg.id); });
  item('复制一份接在后面', () => host.op('复制段', () => { S.segIndex = Edit.duplicateSegment(host, i); S.sel.scope = 'segment'; }));
  item('上移', () => host.op('段上移', () => { S.segIndex = Edit.moveSegment(host, i, -1); }));
  item('下移', () => host.op('段下移', () => { S.segIndex = Edit.moveSegment(host, i, 1); }));
  item('删除这一段', () => host.op('删除段', () => { Edit.deleteSegment(host, i); S.segIndex = Math.min(i, Edit.segs(S.doc).length - 1); S.sel.points = new Set(); S.sel.scope = 'points'; }));
  m.style.left = cx + 'px'; m.style.top = cy + 'px'; m.style.display = 'block';
}
function hideCtxMenu() { el('ctxmenu').style.display = 'none'; }

// ---------------------------------------------------------------- 资产
function blankDoc(id, space, binding, sceneId, bg) {
  return {
    id, label: '', space: space || 'screen', binding: binding === 'free' ? 'free' : 'scene', keyframes: [], slots: [],
    source: { segments: [], bake: { sampleHz: 60, tolerance: { pos: 0.5, rot: 0.5, scale: 0.005, alpha: 0.005 } } },
    authoring: binding === 'free' ? {} : { sceneId, background: bg || '' },
  };
}
/** doc 此刻画在哪个场景：场景曲线 = 绑定的作者场景；相对曲线 = 背景场景（UI 态） */
function docSceneRef() {
  if (!S.doc) return { scene: '', bg: '' };
  if (host.binding() === 'scene') return { scene: S.doc.authoring.sceneId || '', bg: S.doc.authoring.background || '' };
  return { scene: (S.backdrop && S.backdrop.scene) || '', bg: (S.backdrop && S.backdrop.bg) || '' };
}
function backdropBody() { return host.binding() === 'free' ? { scene: docSceneRef().scene, bg: docSceneRef().bg } : undefined; }
async function newAssetDialog() {
  const sc0 = S.scenes.find((s) => s.depth) || S.scenes[0];
  if (!sc0) { setStatus('工程里没有场景', 'err'); return; }
  const sceneOpts = S.scenes.map((s) => ({ value: s.id, label: `${s.name}${s.depth ? '' : '（无深度，只能画面空间）'}` }));
  const bgOpts = (sid) => (S.scenes.find((s) => s.id === sid) || { backgrounds: [] }).backgrounds.map((b) => ({ value: b.image, label: b.image + (b.ground ? '' : ' (无行走面场)') }));
  const vals = await modal({
    title: '新建轨迹', fields: [
      { key: 'id', label: 'id（文件名）', value: 'traj_' + Date.now().toString(36), hint: '全局唯一' },
      { key: 'label', label: '名称', value: '', placeholder: '策划看的名字' },
      { key: 'space', label: '空间', type: 'select', value: sc0.depth ? 'world' : 'screen', options: [{ value: 'screen', label: '画面空间 (2D)' }, { value: 'world', label: '世界空间 (3D，需要深度)' }] },
      { key: 'binding', label: '类型', type: 'select', value: 'scene', options: [{ value: 'scene', label: '场景曲线（定死在这个场景里，播放可不给位置）' }, { value: 'free', label: '相对曲线（不绑场景，播放时必须给位置）' }], hint: '只有一种曲线，只是配置不同' },
      { key: 'scene', label: '场景', type: 'select', value: sc0.id, options: sceneOpts, hint: '场景曲线：绑定的作者场景；相对曲线：只是这次画在哪（不写进数据）', onchange: (inputs) => { const bs = inputs.bg; bs.innerHTML = ''; for (const o of bgOpts(inputs.scene.value)) bs.append(h('option', { value: o.value }, o.label)); } },
      { key: 'bg', label: '时段背景', type: 'select', value: (sc0.backgrounds[0] || {}).image || '', options: bgOpts(sc0.id) },
    ],
    validate: (v) => {
      const id = v.id.trim();
      if (!id) return 'id 不能为空';
      if (/[\\/:*?"<>|]/.test(id) || id.startsWith('.')) return 'id 不能含 \\ / : * ? " < > |，也不能以 . 开头';
      if (S.assets.some((a) => a.id === id)) return 'id 已存在: ' + id;
      const sc = S.scenes.find((s) => s.id === v.scene);
      if (v.space === 'world' && !(sc && sc.depth)) return '这个场景没有深度，世界空间无法还原；换场景或用画面空间';
      return '';
    },
    ok: '创建',
  });
  if (!vals) return;
  const prev = captureSession();
  S.doc = blankDoc(vals.id.trim(), vals.space, vals.binding, vals.scene, vals.bg); S.doc.label = vals.label.trim();
  S.backdrop = { scene: vals.scene, bg: vals.bg };
  S.bake = null; S.segIndex = -1; S.sel = { points: new Set(), scope: 'points' }; S.tMs = 0; S.rev++;
  dropGestures(); history.clear();
  el('label').value = S.doc.label; el('space').value = S.doc.space;
  try { await loadAuthoringScene(); }
  catch (e) { await restoreSession(prev, `新建失败：装载场景 ${vals.scene} 出错（${e.message}），半成品已丢弃`); return; }
  markDirty(); renderAll(); v2.fit(); if (v3.ok) v3.fit();
  el('assetSel').value = '';
  setTool('pen');
  setStatus(host.binding() === 'free' ? '新的相对曲线（未保存）：直接在画布上点击开始画线；它不绑场景，换场景只是换背景' : '新的场景曲线（未保存）：直接在画布上点击开始画线；按 S 放命名插槽');
}
/** 打开 / 新建失败时要能整个退回：把"当前编辑现场"拍下来 */
function captureSession() {
  return { doc: S.doc, dirty: S.dirty, bake: S.bake, segIndex: S.segIndex, sel: S.sel, tMs: S.tMs, undo: history.undoStack.slice(), redo: history.redoStack.slice(), assetSel: el('assetSel').value };
}
async function restoreSession(prev, msg) {
  S.doc = prev.doc; S.bake = prev.bake; S.segIndex = prev.segIndex; S.sel = prev.sel; S.tMs = prev.tMs; S.rev++; S.bakeSeq++; clearTimeout(S.bakeTimer);
  history.undoStack = prev.undo; history.redoStack = prev.redo; updateHistoryButtons();
  if (prev.dirty) markDirty(); else clearDirty();
  fillAssetSel(); el('assetSel').value = prev.assetSel;
  if (S.doc) { el('label').value = S.doc.label || ''; el('space').value = S.doc.space || 'screen'; }
  renderAll();
  setStatus(msg, 'err');
  if (S.doc) {
    await syncEnvWithDoc();   // 场景可能装到一半：按原 doc 重新对齐
    const cur = el('status');
    setStatus(msg + (cur.className === 'err' && cur.textContent !== msg ? '；' + cur.textContent : ''), 'err');   // 对齐失败也一并说，但主因是打开/新建失败
  }
}
async function openAsset(id) {
  const r = await API.json('/api/trajectory?id=' + encodeURIComponent(id));
  const prev = captureSession();
  S.doc = r.doc; S.bake = null; S.segIndex = (S.doc.source && S.doc.source.segments && S.doc.source.segments.length) ? 0 : -1;
  S.sel = { points: new Set(), scope: 'points' }; S.tMs = 0; S.rev++;
  S.doc.source = S.doc.source || { segments: [] }; S.doc.source.bake = S.doc.source.bake || {};
  S.doc.authoring = S.doc.authoring || {};
  if (S.doc.binding !== 'free' && S.doc.binding !== 'scene') S.doc.binding = S.doc.authoring.sceneId ? 'scene' : 'free';
  if (S.doc.binding === 'free') { delete S.doc.authoring.sceneId; delete S.doc.authoring.background; }
  S.doc.slots = Array.isArray(S.doc.slots) ? S.doc.slots : [];
  const migrated = migrateLegacyAnchor(S.doc);
  dropGestures(); history.clear();
  el('label').value = S.doc.label || ''; el('space').value = S.doc.space || 'screen'; el('binding').value = S.doc.binding;
  el('assetSel').value = id;
  try { await loadAuthoringScene(); }
  catch (e) { await restoreSession(prev, `打开 ${id} 失败：装载场景 ${docSceneRef().scene || '?'} 出错（${e.message}），已退回 ${prev.doc ? prev.doc.id : '空'}`); return; }
  if (migrated) markDirty(); else clearDirty();
  renderAll(); v2.fitCurve(); if (v3.ok) v3.fitCurve();
  setTool('select');
  await bakeNow();
  v2.fitCurve();
  setStatus(`已打开 ${id}（${S.doc.keyframes ? S.doc.keyframes.length : 0} 帧在盘上）` + (migrated ? '；旧资产的锚点已迁成曲线起点，保存一次落盘' : ''), 'ok');
}
/** 2026-09-11 前的资产：`authoring.anchor` 是"实体锚点"，第 0 段钉在它上面。曲线不再有锚点：
 *  第 0 段的起点改成自定、钉在原来锚点的位置（曲线一个像素不动）；anchorHeight / contactOffsetY 挪进烘焙参数。 */
function migrateLegacyAnchor(doc) {
  const au = doc.authoring || {}; let changed = false;
  const bk = doc.source.bake = doc.source.bake || {};
  if (Number.isFinite(au.anchorHeight) && bk.restHeight == null) { bk.restHeight = au.anchorHeight; changed = true; }
  if (Number.isFinite(au.contactOffsetY) && bk.contactOffsetY == null) { bk.contactOffsetY = au.contactOffsetY; changed = true; }
  const segs = Edit.segs(doc);
  if (au.anchor && segs[0] && !segs[0].start && (segs[0].startFrom === 'anchor' || segs[0].startFrom === 'entity' || segs[0].startFrom == null)) {
    if (doc.space === 'world') {
      // 世界空间：锚点世界坐标（服务端回填过）→ {x,z,h}；没回填过就等装完场景由 originWorld 回落算（authoring.anchor 保留到那时）
      if (au.anchorWorld && Number.isFinite(au.anchorWorld.x)) { S.pendingLegacyAnchorWorld = au.anchorWorld; }
      else S.pendingLegacyAnchor = { x: au.anchor.x, y: au.anchor.y };
    } else segs[0].start = { x: round2(au.anchor.x), y: round2(au.anchor.y) };
    segs[0].startFrom = 'explicit'; changed = true;
  }
  for (const seg of segs) if (seg.startFrom === 'anchor' || seg.startFrom === 'entity') { seg.startFrom = 'explicit'; changed = true; }
  if (!au.origin && au.anchor) au.origin = { x: au.anchor.x, y: au.anchor.y };
  for (const k of ['anchor', 'anchorWorld', 'anchorHeight', 'contactOffsetY']) if (k in au) { delete au[k]; changed = true; }
  return changed;
}
/** 保存。返回 'ok' | 'conflict'（写盘了但期间又有改动，仍是脏态）| 'error' | 'skipped'。 */
async function saveAsset() {
  if (!S.doc) return 'skipped';
  if (S.busy > 0) { setStatus('场景还在装载，等装完再存', 'err'); return 'skipped'; }
  if (S.envBroken) { setStatus('现场没对上（画布与 doc 不是同一个场景），先重试装载再存', 'err'); return 'skipped'; }
  if (!Edit.segs(S.doc).length && !(S.doc.keyframes && S.doc.keyframes.length)) { setStatus('还没有任何分段，没东西可存', 'err'); return 'skipped'; }
  return runIO(saveAssetNow);
}
async function saveAssetNow() {
  if (!S.doc) return 'skipped';
  if (S.busy > 0 || S.envBroken) { setStatus(S.envBroken ? '现场没对上，先重试装载再存' : '场景还在装载，等装完再存', 'err'); return 'skipped'; }
  try {
    setStatus('保存中…');
    clearTimeout(S.bakeTimer); S.bakeSeq++; S.rev++;   // 在飞的预览烘焙作废：保存返回的那份才是真相
    const rev = S.rev, doc = S.doc;
    const r = await API.post('/api/save', { doc, backdrop: backdropBody() });
    if (doc !== S.doc || rev !== S.rev) {
      // 保存在飞期间又改了：盘上是发出时那份，内存这份更新——绝不能用旧的覆盖新的、更不能标成"已保存"
      const tr0 = await API.json('/api/trajectories'); S.assets = tr0.trajectories; fillAssetSel();
      setStatus(`已写盘 ${r.path}，但保存期间又有改动：当前仍是未保存状态，再按一次 Ctrl+S`, 'err');
      return 'conflict';
    }
    S.doc = r.doc; S.rev++; applyBake(r.bake); clearDirty(); el('label').value = S.doc.label || '';
    clampSelection(); renderAll();   // doc 换成了服务端返回的那份：检视器必须重建，否则数值框还绑在旧对象上
    const tr = await API.json('/api/trajectories'); S.assets = tr.trajectories; fillAssetSel(); el('assetSel').value = S.doc.id;
    setStatus(`已保存 ${r.path}（${S.doc.keyframes.length} 帧）`, 'ok');
    return 'ok';
  } catch (e) { setStatus('保存失败: ' + e.message, 'err'); return 'error'; }
}
async function renameAsset() {
  if (!S.doc) return;
  const v = await modal({ title: '改名', fields: [{ key: 'to', label: '新 id', value: S.doc.id }], validate: (x) => { const t = x.to.trim(); if (!t) return 'id 不能为空'; if (t !== S.doc.id && S.assets.some((a) => a.id === t)) return 'id 已存在'; return ''; } });
  if (!v) return;
  const to = v.to.trim(); if (to === S.doc.id) return;
  await renameTo(to);
}
/** 改名落盘。先等在飞的保存落地（否则服务端 rename 与 save 谁先谁后不可控，会留下两份文件）。 */
function renameTo(to) {
  return runIO(async () => {
    try {
      if (S.assets.some((a) => a.id === S.doc.id)) await API.post('/api/rename', { id: S.doc.id, to });
      S.doc.id = to; S.rev++;   // 修订号必须动：在飞的保存返回时才知道 doc 已经不是发出时那份
      const tr = await API.json('/api/trajectories'); S.assets = tr.trajectories; fillAssetSel(); el('assetSel').value = to;
      setStatus('已改名为 ' + to + (S.dirty ? '（其它改动仍需保存）' : ''), 'ok');
    } catch (e) { setStatus('改名失败: ' + e.message, 'err'); }
  });
}
async function duplicateAsset() {
  if (!S.doc) return;
  const v = await modal({ title: '另存为', fields: [{ key: 'to', label: '新 id', value: S.doc.id + '_copy' }], validate: (x) => { const t = x.to.trim(); if (!t) return 'id 不能为空'; if (S.assets.some((a) => a.id === t)) return 'id 已存在'; return ''; }, ok: '另存' });
  if (!v) return;
  const prevDoc = S.doc, prevDirty = S.dirty, to = v.to.trim();
  S.doc = deepClone(S.doc); S.doc.id = to; S.rev++; markDirty();
  const rc = await saveAsset();
  if (rc === 'ok') { history.clear(); return; }   // 另存成功 = 一份新资产，从干净历史开始
  if (rc === 'conflict') {
    // 副本已写盘，但期间又编辑了：现在编辑的就是副本（脏态保留），别退回去再留一份孤儿文件
    history.clear();
    setStatus(`副本 ${to} 已写盘，但另存期间又有改动：现在编辑的是副本 ${to}，未保存的改动仍在，再按一次 Ctrl+S`, 'err');
    return;
  }
  // 另存失败：回到原资产、原脏态，历史一条不丢
  S.doc = prevDoc; S.rev++; if (prevDirty) markDirty(); else clearDirty(); fillAssetSel(); el('assetSel').value = S.assets.some((a) => a.id === prevDoc.id) ? prevDoc.id : '';
  setStatus('另存为失败，仍在编辑 ' + prevDoc.id + '：' + el('status').textContent, 'err');
}
async function deleteAsset() {
  if (!S.doc) return;
  if (!(await confirmModal(`删除轨迹 ${S.doc.id}？文件会被移除；引用它的 playTrajectory 会在校验里报警。`, '删除', true))) return;
  try {
    await runIO(() => API.post('/api/delete', { id: S.doc.id }));   // 与保存同一条链：在飞的保存落地后再删，否则删完又被写回来
    const tr = await API.json('/api/trajectories'); S.assets = tr.trajectories; S.doc = null; S.bake = null; history.clear(); fillAssetSel(); renderAll();
    setStatus('已删除', 'ok');
    if (S.assets.length && !S.assets[0].error) await openAsset(S.assets[0].id); else await newAssetDialog();
  } catch (e) { setStatus('删除失败: ' + e.message, 'err'); }
}

// ---------------------------------------------------------------- 场景 / 实体
async function loadAuthoringScene() { setBusy(1, '装载场景 ' + docSceneRef().scene + '…'); try { return await _loadAuthoringScene(); } finally { setBusy(-1); } }
async function _loadAuthoringScene() {
  const au = S.doc.authoring;
  const free = host.binding() === 'free';
  // 场景曲线：绑定的作者场景（缺 / 无效就退到第一个有深度的场景并写回——旧数据）；相对曲线：背景场景，缺省 = 当前画布 / 第一个有深度的场景
  let sid = free ? ((S.backdrop && S.backdrop.scene) || (S.scene && S.scene.id) || '') : (au.sceneId || '');
  if (!sid || !S.scenes.some((s) => s.id === sid)) { const sc = S.scenes.find((s) => s.depth) || S.scenes[0]; sid = sc ? sc.id : ''; }
  el('sceneSel').value = sid; fillBgSel();
  let bg = free ? ((S.backdrop && S.backdrop.scene === sid && S.backdrop.bg) || '') : (au.background || '');
  if (bg && [...el('bgSel').options].some((o) => o.value === bg)) el('bgSel').value = bg; else bg = el('bgSel').value;
  if (free) { S.backdrop = { scene: sid, bg }; delete au.sceneId; delete au.background; }
  else { au.sceneId = sid; au.background = bg; }
  el('sceneSel').disabled = !free; el('sceneSel').title = free ? '相对曲线：换背景场景（不写进数据）' : '场景曲线绑定这个场景，只能在这里打开；要换场景就新建一条';
  await loadScene(sid, bg);
  fillEntitySel();
  await loadEntity(au.entity ? (au.entity.kind === 'player' ? 'player' : au.entity.id) : '');
  // 旧资产的世界空间锚点：装完场景才有标定，这时把第 0 段起点钉到它上面
  if (S.pendingLegacyAnchorWorld || S.pendingLegacyAnchor) {
    const seg0 = Edit.segs(S.doc)[0];
    if (seg0 && S.cal) {
      const w = S.pendingLegacyAnchorWorld ? [S.pendingLegacyAnchorWorld.x, S.pendingLegacyAnchorWorld.y, S.pendingLegacyAnchorWorld.z]
        : (() => { const g = S.cal.sceneToWorldGround(S.pendingLegacyAnchor.x, S.pendingLegacyAnchor.y + host.contactOffsetY()); return [g[0], g[1] + host.restH(), g[2]]; })();
      const q = S.cal.worldToXZH(w[0], w[1], w[2]);
      seg0.start = { x: round2(q.x), z: round2(q.z), h: round2(Math.max(0, q.h)) };
    }
    S.pendingLegacyAnchorWorld = null; S.pendingLegacyAnchor = null;
  }
}
/** 装场景：所有数据（描述 + 背景图 + 行走面 + 高度场 + 壳 + 网格）**全部到齐后一次性提交**——
 *  中途失败时上一个场景原封不动（否则会留下"新标定 + 空行走面 + 旧底图"的混态画布）。 */
async function loadScene(sid, bg) {
  const prevKey = S.loadingScene;
  const key = sid + '|' + bg; S.loadingScene = key;
  setStatus('装载场景 ' + sid + '…');
  let scene, cal = null, res;
  try {
    const r = await API.json(`/api/scene?id=${encodeURIComponent(sid)}&bg=${encodeURIComponent(bg || '')}`);
    if (S.loadingScene !== key) return;
    scene = r.scene;
    const q = `id=${encodeURIComponent(sid)}&bg=${encodeURIComponent(bg || '')}`;
    const jobs = [API.image(`/api/scene_bg?${q}&w=1600`)];
    if (scene.cal) {
      cal = new SceneCal(scene.cal, scene.worldWidth, scene.worldHeight);
      jobs.push(API.bin(`/api/scene_ground?${q}`), API.bin(`/api/scene_heightfield?${q}`), API.bin(`/api/scene_shell?${q}`));
      if (v3.ok) jobs.push(API.bin(`/api/scene_mesh?${q}&stride=2`));
    }
    res = await Promise.all(jobs);
    if (S.loadingScene !== key) return;
  } catch (e) {
    if (S.loadingScene === key) S.loadingScene = prevKey;   // 没装上：还是原来那个场景
    throw e;
  }
  // 提交
  S.scene = scene; S.cal = cal; S.npcImgs = new Map(); S.obstacleCanvas = null;
  S.bgImage = res[0];
  if (S.cal) {
    S.cal.setGround(res[1]); S.cal.setHeightfield(res[2]); S.cal.setShell(res[3]);
    S.obstacleCanvas = buildObstacleCanvas(S.cal);
    if (v3.ok) { v3.setMesh(res[4]); v3.setTexture(S.bgImage); }
  } else if (v3.ok) v3.mesh = null;
  if (S.layers.npcs) loadNpcImages();
  refreshAlignment();
  renderSceneInfo();
  setStatus('场景就绪：' + S.scene.name + (S.cal ? `（${S.cal.ground ? '有' : '无'}行走面 · 俯角 ${fmt(Math.acos(S.cal.cosTheta) * 180 / Math.PI)}°）` : '（无深度：只能画面空间）'));
}
/** 装载门：换场景 / 换实体 / 打开 / 新建 / 撤销重装期间挡住一切输入与保存（遮罩 + 键盘 + Ctrl+S），
 *  这几秒里 doc 与画布本来就不一致，任何编辑 / 存盘都是在半迁移的资产上动手。 */
function setBusy(delta, text) {
  S.busy = Math.max(0, (S.busy || 0) + delta);
  refreshGate(text);
}
/** 遮罩 = 装载中 或 现场没对上（envBroken）。`#app` 加 inert：焦点停在下拉 / 输入框上也收不到键盘与鼠标。 */
function refreshGate(text) {
  const b = el('busy'), on = S.busy > 0 || !!S.envBroken;
  b.hidden = !on;
  el('app').inert = on;
  el('busyRetry').hidden = !S.envBroken || S.busy > 0;
  const sp = b.querySelector('.spin'); if (sp) sp.hidden = !(S.busy > 0);
  if (S.busy > 0 && text) el('busyText').textContent = text;
  else if (S.busy > 0 && !el('busyText').textContent) el('busyText').textContent = '装载中…';
  else if (S.envBroken) el('busyText').textContent = S.envBroken;
  if (!on) el('busyText').textContent = '';
}
/** 撤销 / 重做后重装现场失败：立"现场没对上"的门——绝不能留下"doc 指着 A、画布画着 B 还能编辑存盘"的状态 */
function setEnvBroken(msg) { S.envBroken = msg || null; refreshGate(); }
/** 磁盘操作（存 / 改名 / 删 / 另存）一律串到同一条链上：谁先谁后由这条链定，不再看服务端的处理顺序。 */
function runIO(fn) {
  const p = (S.io || Promise.resolve()).then(fn, fn);
  S.io = p.catch(() => {});
  return p;
}
/** 障碍层：壳比行走面近 > 3wu 的像素（立在地上的东西 / 墙）染红 */
function buildObstacleCanvas(cal) {
  if (!cal.shell || !cal.ground) return null;
  const w = cal.shell.w, hh = cal.shell.h;
  const c = document.createElement('canvas'); c.width = w; c.height = hh;
  const g = c.getContext('2d'); const img = g.createImageData(w, hh); const d = img.data;
  const thr = 3 / cal.wuPerQ;
  for (let i = 0; i < w * hh; i++) { const gap = cal.ground.data[i] - cal.shell.data[i]; if (gap > thr) { const a = clamp(gap / (thr * 12), 0.35, 1); d[i * 4] = 255; d[i * 4 + 1] = 70; d[i * 4 + 2] = 70; d[i * 4 + 3] = Math.round(a * 255); } }
  g.putImageData(img, 0, 0);
  return c;
}
async function loadNpcImages() {
  if (!S.scene) return;
  const sid = S.doc ? S.doc.authoring.sceneId : S.scene.id, bg = S.doc ? (S.doc.authoring.background || '') : '';
  for (const n of S.scene.npcs) {
    if (!n.hasImage || S.npcImgs.has(n.id)) continue;
    S.npcImgs.set(n.id, { img: null, meta: null });
    const q = `scene=${encodeURIComponent(sid)}&bg=${encodeURIComponent(bg)}&npc=${encodeURIComponent(n.id)}`;
    Promise.all([API.json('/api/entity?' + q), API.image('/api/entity_png?' + q)]).then(([meta, img]) => { S.npcImgs.set(n.id, { img, meta: meta.entity }); draw(); }).catch(() => {});
  }
}
/** 换场景 / 换实体串到同一条链上（`S.envChain`）：第二次一定在第一次整个落地之后才开始，历史基线不会拍到半迁移的 doc */
function chainEnv(fn) { const p = (S.envChain || Promise.resolve()).then(fn, fn); S.envChain = p.catch(() => {}); return p; }
function changeScene(sid, bg) { if (!S.doc) return Promise.resolve(); return chainEnv(async () => { setBusy(1, '装载场景 ' + sid + '…'); try { return await _changeScene(sid, bg); } finally { setBusy(-1); } }); }
async function _changeScene(sid, bg) {
  if (!S.doc) return;
  const op = ++S.sceneOp;   // 连续快换场景：后一次进来前一次就整个作废（每个 await 之后核对）
  const free = host.binding() === 'free';
  const au = S.doc.authoring;
  const prevRef = docSceneRef();
  if (!free && sid !== prevRef.scene) {
    // 场景曲线绑定作者场景：只能在这里打开；换时段可以，换场景不行（要换就新建一条相对曲线或另存）
    el('sceneSel').value = prevRef.scene;
    setStatus('场景曲线绑定在 ' + prevRef.scene + '，只能在那里打开；要在别的场景用，把类型改成"相对曲线"或新建一条', 'err');
    return;
  }
  const before = free ? null : history.snapshot();
  S.rev++; S.bakeSeq++; clearTimeout(S.bakeTimer);
  if (free) S.backdrop = { scene: sid, bg }; else { au.background = bg; delete au.originWorld; }
  try {
    await loadScene(sid, bg);
  } catch (e) {
    if (op !== S.sceneOp) return;
    // 装不上（深度图缺失 / 后端错 / 断连）：退回原场景，下拉同步回去，"正在装载"的键也回到已装载的那个，出声
    if (free) S.backdrop = { scene: prevRef.scene, bg: prevRef.bg }; else au.background = prevRef.bg;
    S.loadingScene = S.scene ? S.scene.id + '|' + (S.scene.background || '') : null;
    el('sceneSel').value = prevRef.scene; fillBgSel(); if (prevRef.bg) el('bgSel').value = prevRef.bg;
    const what = sid === prevRef.scene ? `时段 ${bg}` : `场景 ${sid}`;
    setStatus(`装载${what} 失败：${e.message}（已留在 ${prevRef.scene}${prevRef.bg ? ' · ' + prevRef.bg : ''}）`, 'err');
    scheduleBake(0);
    return;
  }
  if (op !== S.sceneOp) return;
  el('sceneSel').value = sid; fillBgSel(); if (bg) el('bgSel').value = bg;   // 不管是谁叫的（下拉 / 撤销 / 脚本），下拉必须跟 doc 走
  fillEntitySel();
  let note = '';
  if (S.doc.space === 'world' && !S.cal) { S.doc.space = 'screen'; el('space').value = 'screen'; note = '新场景没有深度：资产已切回画面空间；'; }
  S.bake = null;
  await changeEntity(el('entitySel').value, true, true, false);
  if (op !== S.sceneOp) return;
  if (before) { history._push({ label: '换时段', before, after: history.snapshot() }); markDirty(); }
  renderAll(); v2.fitCurve(); if (v3.ok) v3.fitCurve(); scheduleBake(0);
  if (note) setStatus(note, 'err');
  else if (free) setStatus('背景换成 ' + sid + '（相对曲线不绑场景，曲线的坐标原样；整条 gizmo 可以把它挪到想要的地方）');
}
/** 曲线类型切换：场景曲线 ⇄ 相对曲线。相对 → 场景：绑定当前背景场景；场景 → 相对：把绑定丢掉（当前场景变成背景）。 */
function changeBinding(v) {
  if (!S.doc) return;
  const to = v === 'free' ? 'free' : 'scene';
  if (host.binding() === to) return;
  const cur = docSceneRef();
  host.op(to === 'free' ? '改成相对曲线' : '改成场景曲线', () => {
    S.doc.binding = to;
    if (to === 'free') { delete S.doc.authoring.sceneId; delete S.doc.authoring.background; }
    else { S.doc.authoring.sceneId = cur.scene; S.doc.authoring.background = cur.bg; }
  });
  S.backdrop = { scene: cur.scene, bg: cur.bg };
  el('sceneSel').disabled = to === 'scene';
  setStatus(to === 'free' ? '已改成相对曲线：不绑场景，可以在任何场景里打开；播放时必须给位置' : `已改成场景曲线：绑定 ${cur.scene}，只能在那里打开；播放可不给位置`);
}
async function loadEntity(id) {
  const op = ++S.entityLoad;   // 后一次装载进来，前一次的结果作废（否则慢的那发最后落地，幽灵与 doc 对不上）
  S.entity = null;
  if (v3.ok) v3.setGhostTexture(null);
  if (!id) { draw(); return; }
  try {
    const sid = S.doc.authoring.sceneId, bg = S.doc.authoring.background || '';
    const q = `scene=${encodeURIComponent(sid)}&bg=${encodeURIComponent(bg)}&npc=${encodeURIComponent(id)}`;
    const [meta, img] = await Promise.all([API.json('/api/entity?' + q), API.image('/api/entity_png?' + q)]);
    if (op !== S.entityLoad) return;
    S.entity = { id, meta: meta.entity, img };
    if (v3.ok) v3.setGhostTexture(img);
  } catch (e) { if (op === S.entityLoad) setStatus('实体预览不可用: ' + e.message); }
  draw();
}
function changeEntity(id, noHistory, silent, carry) { if (!S.doc) return Promise.resolve(); const run = async () => { setBusy(1, '装载预览实体…'); try { return await _changeEntity(id, noHistory, silent, carry); } finally { setBusy(-1); } }; return carry === false ? run() : chainEnv(run); }
async function _changeEntity(id, noHistory, silent, carry) {
  if (!S.doc) return;
  const op = ++S.entityOp;   // 连续快换实体：后一次进来前一次作废
  const before = history.snapshot();
  const au = S.doc.authoring;
  S.rev++; S.bakeSeq++; clearTimeout(S.bakeTimer);
  if (!id) delete au.entity; else au.entity = id === 'player' ? { kind: 'player' } : { kind: 'npc', id };
  await loadEntity(id);
  if (op !== S.entityOp) return;
  // 预览实体只是骑在曲线上的那个东西：曲线一个像素不动。尺寸参数（restHeight / contactOffsetY）只在还没设过时从它取一次
  const took = takeBakeParamsFromEntity(false, true);
  S.bake = null;
  if (!noHistory) history._push({ label: '换预览实体', before, after: history.snapshot() });
  if (cleanKey() === S.cleanKey) clearDirty(); else markDirty();   // 相对曲线换背景后同步实体：doc 没变（同一个预览实体）就不脏
  renderAll(); scheduleBake(0);
  if (!silent && S.entity) setStatus('预览实体换成 ' + (id === 'player' ? '玩家' : id) + '（曲线不动）' + (took ? '；烘焙参数按它的尺寸填了一次' : ''));
}
/** 从预览实体取"骑在曲线上那个东西"的尺寸参数：restHeight（世界，支点离地高 = contactOffsetY / cosθ）、contactOffsetY（画面）。
 *  onlyIfUnset = 只在还没设过时填（换实体时的一次性缺省）；显式按钮则覆盖。 */
function takeBakeParamsFromEntity(withHistory, onlyIfUnset) {
  if (!S.doc || !S.entity) return false;
  const b = S.doc.source.bake = S.doc.source.bake || {};
  const contact = round2(S.entity.meta.contactOffsetY || 0);
  const rest = round2(contact / Math.max(1e-6, S.cal ? S.cal.cosTheta : 1));
  const apply = () => { if (!onlyIfUnset || b.contactOffsetY == null) b.contactOffsetY = contact; if (!onlyIfUnset || b.restHeight == null) b.restHeight = rest; };
  if (onlyIfUnset && b.contactOffsetY != null && b.restHeight != null) return false;
  if (withHistory) host.op('烘焙参数取自预览实体', apply); else apply();
  if (withHistory) setStatus(`已按 ${S.entity.id} 的尺寸填烘焙参数：接地偏移 ${contact}、静止离地高 ${rest}`);
  return true;
}
async function changeSpace(space) {
  if (!S.doc || S.doc.space === space) return;
  if (space === 'world' && !S.cal) { setStatus('这个场景没有深度，世界空间无法还原；先在角色照明实验室烘该场景深度', 'err'); el('space').value = 'screen'; return; }
  if (Edit.segs(S.doc).length && !(await confirmModal('切换空间会把现有分段的坐标换算到新空间（形状尽量保留）。继续？', '切换'))) { el('space').value = S.doc.space; return; }
  host.op('切换空间', () => {
    Edit.convertSpace(host, S.doc.space, space);
    S.doc.space = space; delete S.doc.authoring.originWorld; delete S.doc.worldKeyframes;
  });
  S.bake = null; renderAll(); scheduleBake(0);
}

// ---------------------------------------------------------------- 分段列表 / 检视器
function renderSegList() {
  const box = el('seglist'); box.innerHTML = '';
  if (!S.doc) { el('segCount').textContent = ''; return; }
  const segs = Edit.segs(S.doc);
  el('segCount').textContent = segs.length ? `${segs.length} 段` : '还没有分段：直接在画布上点击开始画线';
  segs.forEach((seg, i) => {
    const bs = host.bakeSegment(i);
    const dur = bs ? `${fmt(bs.startMs, 0)}→${fmt(bs.endMs, 0)}ms` : '';
    const row = h('div', { class: 'seg' + (i === S.segIndex ? ' on' : ''), onclick: () => host.selectSegmentScope(i), ondblclick: () => { host.selectSegmentScope(i); if (S.view === '2d') v2.fitCurve(); else v3.fitCurve(); } },
      h('span', { class: 'k' }, seg.kind === 'physics' ? '抛体' : '手绘'), h('span', { class: 't' }, seg.id + (seg.kind === 'manual' ? `  · ${(seg.path && seg.path.points || []).length} 点` : '')), h('span', { class: 'k' }, dur));
    box.append(row);
  });
}
function numInput(obj, key, opts) {
  const o = opts || {};
  const inp = h('input', { type: 'number', step: o.step || 1, value: obj[key] == null ? '' : obj[key] });
  inp.addEventListener('change', () => {
    const v = parseFloat(inp.value);
    if (Number.isFinite(v) && o.min != null && v < o.min) { setStatus(`${o.label || key}：最小 ${o.min}`, 'err'); inp.value = obj[key] == null ? '' : obj[key]; return; }
    if (!Number.isFinite(v) && o.required) { setStatus(`${o.label || key}：必须是数`, 'err'); inp.value = obj[key] == null ? '' : obj[key]; return; }
    host.op(o.label || '改参数', () => { if (Number.isFinite(v)) obj[key] = v; else delete obj[key]; if (o.after) o.after(v); });
  });
  return inp;
}
/** 即时写入（拖动中不重建表单）的数值框：读 getter、写 setter */
function liveInput(get, set, opts) {
  const o = opts || {};
  const inp = h('input', { type: 'number', step: o.step || 1, value: fmtNum(get()) });
  inp.dataset.live = '1'; inp._get = get;
  inp.addEventListener('change', () => { const v = parseFloat(inp.value); if (Number.isFinite(v)) host.op(o.label || '改数值', () => set(v)); else inp.value = fmtNum(get()); });
  return inp;
}
function fmtNum(v) { return Number.isFinite(v) ? String(Math.round(v * 100) / 100) : ''; }
function renderInspectorLive() {
  for (const inp of document.querySelectorAll('#inspector input[data-live]')) { if (document.activeElement !== inp && inp._get) inp.value = fmtNum(inp._get()); }
  const seg = host.activeSeg();
  if (seg && seg.kind === 'physics') { const e = el('physReadout'); if (e) e.textContent = physicsReadout(seg); }
}
function row(label, ...kids) { return h('div', { class: 'row' }, h('span', { class: 'lbl' }, label), ...kids); }
function physicsReadout(seg) {
  const pi = host.physicsInfo(seg); if (!pi) return '';
  const liftNote = pi.lifted ? '⚠ 起点在地面线之下（上一段末点比地面线低）：烘焙会把起点抬到地面线 · ' : '';
  if (pi.grounded) return liftNote + '起点贴地且不往上抛：直接贴地滚动';
  const world = S.doc.space === 'world';
  const L = world ? pi.landingW : pi.landing, A = world ? pi.apexW : pi.apex;
  return liftNote + `第一跳 ${fmt(pi.t * 1000, 0)} ms · 落点 ${world ? `${fmt(L[0], 0)}, ${fmt(L[2], 0)}` : `${fmt(L[0], 0)}, ${fmt(L[1], 0)}`}` + (A ? ` · 最高点离起点 ${fmt(world ? A[1] - pi.startW[1] : pi.start[1] - A[1], 0)} wu` : '');
}
function renderInspector() {
  const box = el('inspector'); box.innerHTML = '';
  const seg = host.activeSeg();
  if (!seg) { box.append(h('h3', {}, '检视器'), h('div', { class: 'dim' }, S.doc ? '没有选中的段。在画布上点击开始画线（自动建手绘段），或用左侧"抛体"工具拖一个落点。' : '—')); return; }
  const world = S.doc.space === 'world';
  const i = S.segIndex;
  box.append(h('h3', {}, `第 ${i + 1} 段 · ${seg.kind === 'physics' ? '抛体' : '手绘'}`, h('span', { class: 'pill' }, seg.id)));
  const idInp = h('input', { type: 'text', value: seg.id, style: 'width:130px' });
  idInp.addEventListener('change', () => host.op('改段 id', () => { seg.id = idInp.value.trim() || seg.id; }));
  const mode = Edit.startMode(S.doc, seg);
  const sf = i === 0
    ? h('span', { class: 'dim' }, '曲线起点（可拖；播放位置就落在这里）')
    : h('select', {}, h('option', { value: 'previous' }, '上一段末点'), h('option', { value: 'explicit' }, '自定（可拖）'));
  if (i > 0) { sf.value = mode; sf.addEventListener('change', () => host.op('改起点方式', () => Edit.setStartMode(host, seg, sf.value))); }
  box.append(row('段 id', idInp), row('起点', sf));
  if (mode === 'explicit') {
    // 渲染只读：没有 start 的（手改 / 旧文件）按现算的起点显示，写入才走 Edit.setExplicitStart（它会先补齐 start）
    const stv = () => seg.start || (world ? Edit.segStartXZH(host, seg) : (() => { const s = Edit.segStartScreen(host, seg); return { x: s[0], y: s[1] }; })());
    box.append(world
      ? row('起点 x/z/h', liveInput(() => stv().x, (v) => Edit.setExplicitStart(host, seg, { x: v }), { label: '改起点' }), liveInput(() => stv().z, (v) => Edit.setExplicitStart(host, seg, { z: v }), { label: '改起点' }), liveInput(() => num(stv().h, 0) - host.restH(), (v) => Edit.setExplicitStart(host, seg, { h: v + host.restH() }), { step: 0.5, label: '改起点' }), h('span', { class: 'dim' }, 'h = 离地高度'))
      : row('起点 x/y', liveInput(() => stv().x, (v) => Edit.setExplicitStart(host, seg, [v, stv().y]), { label: '改起点' }), liveInput(() => stv().y, (v) => Edit.setExplicitStart(host, seg, [stv().x, v]), { label: '改起点' })));
  }
  if (seg.kind === 'manual') renderManualForm(box, seg, world);
  else renderPhysicsForm(box, seg, world);
}
/** 表单是只读视图：缺省容器（path / timing / tracks / v0 / stop / spin）只在**写入**时才补到 doc 上（`ensureManual/ensurePhysics`），
 *  渲染本身绝不改 doc——否则光是点开检视器就会把 `tracks:{}` 之类写进文件，字节变了、脏标记却没亮。 */
function ensureManual(seg) { seg.path = seg.path || { points: [] }; seg.timing = seg.timing || { durationMs: 1000, keys: [] }; seg.tracks = seg.tracks || {}; return seg; }
function ensurePhysics(seg) { seg.v0 = seg.v0 || { x: 0, y: 0 }; seg.stop = seg.stop || {}; seg.spin = seg.spin || {}; return seg; }   // 只建空容器：行为缺省归烘焙机
/** 数值框：读的是现值（容器可能还不存在），写的时候才建容器 */
function numInputLazy(getObj, key, opts) {
  const o = opts || {};
  const cur = getObj(false); const v0 = cur && cur[key] != null ? cur[key] : '';
  const inp = h('input', { type: 'number', step: o.step || 1, value: v0 });
  inp.addEventListener('change', () => {
    const v = parseFloat(inp.value);
    if (Number.isFinite(v) && o.min != null && v < o.min) { setStatus(`${o.label || key}：最小 ${o.min}`, 'err'); inp.value = v0; return; }
    if (!Number.isFinite(v) && !getObj(false)) { inp.value = ''; return; }   // 清一个本来就不存在的字段：什么都不建
    host.op(o.label || '改参数', () => { const obj = getObj(true); if (Number.isFinite(v)) obj[key] = v; else delete obj[key]; });
  });
  return inp;
}
function renderManualForm(box, seg, world) {
  const path = seg.path || { points: [] }, timing = seg.timing || { durationMs: 1000, keys: [] }, tracks = seg.tracks || {};
  const smooth = h('input', { type: 'checkbox', checked: !!path.smooth });
  smooth.addEventListener('change', () => host.op('平滑', () => Edit.setSmooth(host, seg, smooth.checked)));
  const n = (path.points || []).length;
  box.append(row('路径', h('label', { class: 'chk' }, smooth, '平滑曲线'), h('span', { class: 'dim' }, `${n} 点`), h('button', { onclick: () => setTool('pen') }, '继续加点 (P)')));
  // 选中点
  const pts = Edit.effPoints(host, seg);
  const selIdx = [...S.sel.points].filter((k) => k < pts.length).sort((a, b) => a - b);
  if (selIdx.length === 1) {
    const k = selIdx[0], pinned = Edit.isPinned(S.doc, seg) && k === 0;
    const pr = world
      ? row(`点 ${k}`, h('span', { class: 'dim' }, 'x'), liveInput(() => Edit.effPoints(host, seg)[k].x, (v) => Edit.setPoint(host, seg, k, { x: v }), { label: '改点' }),
        h('span', { class: 'dim' }, 'z'), liveInput(() => Edit.effPoints(host, seg)[k].z, (v) => Edit.setPoint(host, seg, k, { z: v }), { label: '改点' }),
        h('span', { class: 'dim' }, 'h'), liveInput(() => Edit.effPoints(host, seg)[k].h, (v) => Edit.setPoint(host, seg, k, { h: v }), { label: '改离地高度', step: 0.5 }))
      : row(`点 ${k}`, h('span', { class: 'dim' }, 'x'), liveInput(() => Edit.effPoints(host, seg)[k].sx, (v) => Edit.setPoint(host, seg, k, [v, Edit.effPoints(host, seg)[k].sy]), { label: '改点' }),
        h('span', { class: 'dim' }, 'y'), liveInput(() => Edit.effPoints(host, seg)[k].sy, (v) => Edit.setPoint(host, seg, k, [Edit.effPoints(host, seg)[k].sx, v]), { label: '改点' }));
    if (pinned) { for (const inp of pr.querySelectorAll('input')) inp.disabled = true; pr.append(h('span', { class: 'dim' }, '起点锁定')); }
    else pr.append(h('button', { class: 'danger', onclick: deleteSelection, title: 'Delete' }, '删点'));
    box.append(pr);
  } else if (selIdx.length > 1) box.append(row('选中', h('span', {}, `${selIdx.length} 个点`), h('button', { class: 'danger', onclick: deleteSelection }, '删点'), h('span', { class: 'dim' }, '画布上有变换框')));
  box.append(row('时长 ms', liveInput(() => (seg.timing || timing).durationMs, (v) => { ensureManual(seg).timing.durationMs = Math.max(1, v); }, { step: 10, label: '改时长' }), h('span', { class: 'dim' }, '整段走完用时')));
  box.append(h('div', { class: 'dim', style: 'margin-top:4px' }, '时间曲线（横：时间 · 纵：路径进度 0→1）只管快慢，不改路径形状：拖键改节奏；双击加键；右键删键；首键钉在 t=0'));
  { const ks = timing.keys || []; const last = ks.length ? ks[ks.length - 1] : null;
    if (last && Math.abs(num(last.progress, 1) - 1) > 1e-6) box.append(h('div', { class: 'dim', style: 'color:var(--warn)' }, `末键进度 ${fmt(num(last.progress, 0), 2)} ≠ 1：实体停在路径 ${fmt(num(last.progress, 0) * 100, 0)}% 处不走完，下一段若接"上一段末点"会从那里起（不是路径末端）`));
    if (ks.length && Math.abs(num(ks[0].atMs, 0)) > 1e-6) box.append(h('div', { class: 'dim', style: 'color:var(--warn)' }, `首键在 ${fmt(ks[0].atMs, 0)}ms 而不是 0：开头会保持首键进度不动`)); }
  const tc = h('canvas', { id: 'timing' }); box.append(tc); setTimeout(() => timingEditor(tc, seg), 0);
  const kt = h('table', { class: 'keys' }, h('tr', {}, h('th', {}, 'atMs'), h('th', {}, 'progress'), h('th', {}, 'easing'), h('th', {})));
  (timing.keys || []).forEach((k, ki) => {
    const es = easingSel(k); const del = h('button', { onclick: () => host.op('删时间键', () => { ensureManual(seg).timing.keys.splice(ki, 1); }) }, '×');
    kt.append(h('tr', {}, h('td', {}, numInput(k, 'atMs', { step: 10, label: '改时间键' })), h('td', {}, numInput(k, 'progress', { step: 0.01, label: '改时间键' })), h('td', {}, es), h('td', {}, del)));
  });
  box.append(kt);
  box.append(row('', h('button', { onclick: () => host.op('加时间键', () => { const t = ensureManual(seg).timing; t.keys = (t.keys || []).concat([{ atMs: round2(t.durationMs / 2), progress: 0.5 }]).sort((a, b) => a.atMs - b.atMs); }) }, '+ 键')));
  const roll = seg.roll || null;
  const rollChk = h('input', { type: 'checkbox', checked: !!roll });
  rollChk.addEventListener('change', () => host.op('滚动', () => { if (rollChk.checked) seg.roll = { radius: host.entityRadius(), direction: 1 }; else delete seg.roll; }));
  box.append(row('滚动', h('label', { class: 'chk' }, rollChk, '按路程/半径自转'), roll ? h('span', {}, '半径 ', numInput(seg.roll, 'radius', { step: 0.5, label: '改滚动半径' })) : null,
    roll ? (() => { const d = h('select', {}, h('option', { value: '1' }, '顺时针'), h('option', { value: '-1' }, '逆时针')); d.value = String(seg.roll.direction || 1); d.addEventListener('change', () => host.op('滚动方向', () => { seg.roll.direction = parseInt(d.value, 10); })); return d; })() : null));
  const det = h('details', {}, h('summary', {}, '通道轨（旋转 / 缩放 / 透明' + (world ? '' : ' / 深度锚') + '）'));
  const chans = ['rotation', 'scale', 'scaleX', 'scaleY', 'alpha'].concat(world ? [] : ['sortY']);
  for (const ch of chans) {
    const keys = tracks[ch];
    const line = h('div', { class: 'row' }, h('span', { class: 'lbl' }, ch));
    if (!keys) line.append(h('button', { onclick: () => host.op('启用通道', () => { const dv = ch === 'alpha' || ch.startsWith('scale') ? 1 : 0; const m = ensureManual(seg); m.tracks[ch] = [{ atMs: 0, value: dv }, { atMs: m.timing.durationMs, value: dv }]; }) }, '启用'));
    else {
      line.append(h('button', { onclick: () => host.op('停用通道', () => { delete seg.tracks[ch]; if (!Object.keys(seg.tracks).length) delete seg.tracks; }) }, '停用'));
      line.append(h('button', { onclick: () => host.op('加通道键', () => { keys.push({ atMs: round2((seg.timing || timing).durationMs / 2), value: keys[keys.length - 1].value }); keys.sort((a, b) => a.atMs - b.atMs); }) }, '+ 键'));
    }
    det.append(line);
    if (keys) {
      const t = h('table', { class: 'keys' });
      keys.forEach((k, ki) => t.append(h('tr', {}, h('td', {}, numInput(k, 'atMs', { step: 10, label: '改通道键' })), h('td', {}, numInput(k, 'value', { step: ch === 'rotation' ? 5 : 0.05, label: '改通道键' })), h('td', {}, easingSel(k)), h('td', {}, h('button', { onclick: () => host.op('删通道键', () => { keys.splice(ki, 1); if (!keys.length) { delete seg.tracks[ch]; if (!Object.keys(seg.tracks).length) delete seg.tracks; } }) }, '×')))));
      det.append(t);
    }
  }
  box.append(det);
}
function renderPhysicsForm(box, seg, world) {
  const v0 = seg.v0 || { x: 0, y: 0 };
  box.append(h('div', { class: 'dim', id: 'physReadout' }, physicsReadout(seg)));
  box.append(h('div', { class: 'dim' }, '画布把手：橙色箭尖 = 初速 · 绿色 ◆ = 落点（直接拖）· 紫色 ● = 最高点' + (world ? '' : ' · 绿色虚线 = 地面线')));
  const pi = () => host.physicsInfo(seg);
  const vx = () => num((seg.v0 || v0).x, 0), vy = () => num((seg.v0 || v0).y, 0), vz = () => num((seg.v0 || v0).z, 0);
  if (world) {
    box.append(row('初速 x/y/z', liveInput(vx, (v) => Edit.setV0(host, seg, { x: v }), { step: 5, label: '改初速' }), liveInput(vy, (v) => Edit.setV0(host, seg, { y: v }), { step: 5, label: '改初速' }), liveInput(vz, (v) => Edit.setV0(host, seg, { z: v }), { step: 5, label: '改初速' }), h('span', { class: 'dim' }, 'y 向上为正')));
    box.append(row('落点 x/z', liveInput(() => { const p = pi(); return p ? p.landingW[0] : 0; }, (v) => { const p = pi(); Edit.setLanding(host, seg, [v, p.landingW[2]]); }, { label: '改落点' }), liveInput(() => { const p = pi(); return p ? p.landingW[2] : 0; }, (v) => { const p = pi(); Edit.setLanding(host, seg, [p.landingW[0], v]); }, { label: '改落点' }), h('span', { class: 'dim' }, '地面坐标')));
    box.append(row('弧高', liveInput(() => { const p = pi(); return p && p.apexW ? p.apexW[1] - p.startW[1] : 0; }, (v) => { const p = pi(); Edit.setApex(host, seg, p.startW[1] + v); }, { step: 5, label: '改最高点' }), h('span', { class: 'dim' }, '最高点高出起点 wu')));
  } else {
    box.append(row('初速 x/y', liveInput(vx, (v) => Edit.setV0(host, seg, { x: v }), { step: 5, label: '改初速' }), liveInput(vy, (v) => Edit.setV0(host, seg, { y: v }), { step: 5, label: '改初速' }), h('span', { class: 'dim' }, 'y 向下为正，往上抛填负')));
    box.append(row('落点 x', liveInput(() => { const p = pi(); return p ? p.landing[0] : 0; }, (v) => Edit.setLanding(host, seg, [v, null]), { label: '改落点' }), h('span', { class: 'lbl' }, '地面 y'), liveInput(() => seg.groundY, (v) => Edit.setGroundY(host, seg, v), { label: '改地面线' })));
    box.append(row('弧高', liveInput(() => { const p = pi(); return p && p.apex ? p.start[1] - p.apex[1] : 0; }, (v) => { const p = pi(); Edit.setApex(host, seg, p.start[1] - v); }, { step: 5, label: '改最高点' }), h('span', { class: 'dim' }, '最高点高出起点 wu')));
  }
  box.append(row('重力', numInput(seg, 'gravity', { step: 10, label: '改重力', min: 1, required: true }), h('span', { class: 'dim' }, world ? 'wu/s²（≈865 = 9.8m/s²）' : 'wu/s²')));
  box.append(row('弹性', numInput(seg, 'restitution', { step: 0.05, label: '改弹性' }), h('span', { class: 'lbl' }, '切向损失'), numInput(seg, 'tangentialDamping', { step: 0.05, label: '改切向损失' })));
  box.append(row('滚动摩擦', numInput(seg, 'rollingFriction', { step: 5, label: '改滚动摩擦' })));
  const spin = (create) => (create ? ensurePhysics(seg).spin : (seg.spin || null));
  const stop = (create) => (create ? ensurePhysics(seg).stop : (seg.stop || null));
  box.append(row('自转半径', numInputLazy(spin, 'radius', { step: 0.5, label: '改自转半径' }), h('span', { class: 'lbl' }, '初角速 °/s'), numInputLazy(spin, 'omega0', { step: 10, label: '改初角速' })));
  if (world) box.append(row('碰撞半径', numInput(seg, 'radius', { step: 0.5, label: '改碰撞半径' }), h('span', { class: 'dim' }, '撞墙用；缺省=自转半径')));
  box.append(row('停机', h('span', {}, '速度 <'), numInputLazy(stop, 'minSpeed', { step: 5, label: '改停机' }), h('span', {}, '或 >'), numInputLazy(stop, 'maxMs', { step: 100, label: '改停机' }), h('span', {}, 'ms')));
  box.append(row('段采样 Hz', numInput(seg, 'sampleHz', { step: 10, label: '改采样率' }), h('span', { class: 'dim' }, '留空 = 全局')));
}
function easingSel(k) {
  const s = h('select', {}, h('option', { value: '' }, 'linear'), h('option', { value: 'easeIn' }, 'easeIn'), h('option', { value: 'easeOut' }, 'easeOut'), h('option', { value: 'easeInOut' }, 'easeInOut'));
  s.value = k.easing || ''; s.addEventListener('change', () => host.op('改缓动', () => { if (s.value) k.easing = s.value; else delete k.easing; }));
  return s;
}
/** 时间曲线小编辑器：键 = (atMs, progress)。
 *  window 上的 mousemove/mouseup 只挂一次（`timingLive` 指向当前活着的编辑器），表单每次重建不再泄漏监听器。 */
let timingLive = null;
window.addEventListener('mousemove', (e) => { if (timingLive) timingLive.move(e); });
window.addEventListener('mouseup', () => { if (timingLive) timingLive.up(); });
function timingEditor(canvas, seg) {
  const g = canvas.getContext('2d');
  const W = canvas.clientWidth || 340, H = canvas.clientHeight || 120; canvas.width = W; canvas.height = H;
  const pad = 14;
  // 只读：渲染绝不改 doc（排序后的副本），写入只在 host.op / 拖拽闭包里做
  const keys = () => (((seg.timing || {}).keys) || []).slice().sort((a, b) => a.atMs - b.atMs);
  const dur = () => Math.max(1, num((seg.timing || {}).durationMs, 1000));
  const toC = (k) => [pad + (k.atMs / dur()) * (W - 2 * pad), H - pad - clamp(k.progress, 0, 1) * (H - 2 * pad)];
  let sel = -1, dragging = false;
  const drawT = () => {
    g.clearRect(0, 0, W, H); g.strokeStyle = '#3a3f4a'; g.strokeRect(pad, pad, W - 2 * pad, H - 2 * pad);
    const ks = keys(); if (!ks.length) return;
    g.strokeStyle = '#6cb4ff'; g.lineWidth = 2; g.beginPath();
    for (let t = 0; t <= 1; t += 1 / 120) {
      const at = t * dur(); const p = evalTiming(ks, at, dur()); const c = [pad + t * (W - 2 * pad), H - pad - p * (H - 2 * pad)];
      if (t === 0) g.moveTo(c[0], c[1]); else g.lineTo(c[0], c[1]);
    }
    g.stroke();
    ks.forEach((k, i) => { const c = toC(k); g.fillStyle = i === sel ? '#ffb454' : '#fff'; g.beginPath(); g.arc(c[0], c[1], 4.5, 0, Math.PI * 2); g.fill(); });
  };
  const hit = (mx, my) => { const ks = keys(); for (let i = ks.length - 1; i >= 0; i--) { const c = toC(ks[i]); if (Math.hypot(c[0] - mx, c[1] - my) < 8) return i; } return -1; };
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('mousedown', (e) => {
    const [mx, my] = pos(e); const i = hit(mx, my);
    if (e.button === 2) { if (i > 0) host.op('删时间键', () => { const ks = keys(); ks.splice(i, 1); ensureManual(seg).timing.keys = ks; }); return; }
    sel = i; dragging = i >= 0;
    // 命中了键 ⇒ seg.timing.keys 必然已存在：就地排成命中用的顺序（序号才对得上），**不走 ensureManual**——
    // 它会顺手补 tracks:{}，纯点一下不挪就把资产标脏 + 留一条空转撤销 + 往文件里塞空容器
    if (dragging) { host.dragBegin('拖时间键'); seg.timing.keys = keys(); }
    drawT();
  });
  canvas.addEventListener('dblclick', (e) => {
    const [mx, my] = pos(e);
    const at = clamp((mx - pad) / (W - 2 * pad), 0, 1) * dur(), pr = clamp(1 - (my - pad) / (H - 2 * pad), 0, 1);
    host.op('加时间键', () => {
      // 空曲线上加第一颗键：先补两端（0→0、时长→1，与 addSegment 同构），否则单键 timing 会把整段冻在那个进度上
      const cur = keys(); const base = cur.length ? cur : [{ atMs: 0, progress: 0 }, { atMs: dur(), progress: 1 }].filter((k) => Math.abs(k.atMs - at) > 1e-6);
      ensureManual(seg).timing.keys = base.concat([{ atMs: round2(at), progress: round2(pr) }]).sort((a, b) => a.atMs - b.atMs);
    });
  });
  const mm = (e) => {
    if (!dragging || sel < 0) return;
    const [mx, my] = pos(e); const ks = (seg.timing || {}).keys || []; const k = ks[sel]; if (!k) return;
    if (sel > 0) k.atMs = round2(clamp((mx - pad) / (W - 2 * pad), 0, 1) * dur());
    k.progress = round2(clamp(1 - (my - pad) / (H - 2 * pad), 0, 1));
    S.rev++; drawT(); scheduleBake(200);
  };
  const mu = () => { if (dragging) { dragging = false; if (seg.timing) seg.timing.keys = keys(); host.dragEnd(); } };
  timingLive = { move: mm, up: mu };
  drawT();
}
function evalTiming(keys, at, dur) {
  if (!keys.length) return clamp(at / dur, 0, 1);
  if (at <= keys[0].atMs) return keys[0].progress;
  const last = keys[keys.length - 1];
  if (at >= last.atMs) return last.progress;
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1], b = keys[i];
    if (at <= b.atMs) { const span = Math.max(1, b.atMs - a.atMs); let u = (at - a.atMs) / span; u = ease(u, a.easing); return a.progress + (b.progress - a.progress) * u; }
  }
  return last.progress;
}
function ease(u, e) { if (e === 'easeIn') return u * u; if (e === 'easeOut') return 1 - (1 - u) * (1 - u); if (e === 'easeInOut') return u < 0.5 ? 2 * u * u : 1 - 2 * (1 - u) * (1 - u); return u; }

// ---------------------------------------------------------------- 烘焙
function readBakeSettings() {
  if (!S.doc) return;
  host.op('改烘焙参数', () => {
    const b = S.doc.source.bake = S.doc.source.bake || {};
    b.sampleHz = num(el('sampleHz').value, 60);
    b.tolerance = { pos: num(el('tolPos').value, 0.5), rot: num(el('tolRot').value, 0.5), scale: num(el('tolScale').value, 0.005), alpha: num(el('tolAlpha').value, 0.005) };
    b.restHeight = Math.max(0, num(el('restHeight').value, 0));
    b.contactOffsetY = num(el('contactOffsetY').value, 0);
  });
}
function writeBakeSettings() {
  const b = (S.doc && S.doc.source.bake) || {}; const t = b.tolerance || {};
  el('sampleHz').value = b.sampleHz != null ? b.sampleHz : 60;
  el('tolPos').value = t.pos != null ? t.pos : 0.5; el('tolRot').value = t.rot != null ? t.rot : 0.5; el('tolScale').value = t.scale != null ? t.scale : 0.005; el('tolAlpha').value = t.alpha != null ? t.alpha : 0.005;
  el('restHeight').value = b.restHeight != null ? b.restHeight : 0; el('contactOffsetY').value = b.contactOffsetY != null ? b.contactOffsetY : 0;
}
function scheduleBake(ms) {
  clearTimeout(S.bakeTimer);
  S.bakeTimer = setTimeout(() => { bakeNow().catch((e) => setStatus('烘焙失败: ' + e.message, 'err')); }, ms == null ? 300 : ms);
}
/** 在飞的烘焙响应只对"发出时的那份 doc"有效：doc 修订号（S.rev，每次 afterEdit / 换场景 / 换实体自增）变了就整发丢弃，
 *  不只看"有没有更新的一发已经发出"（响应可能比下一次防抖更早到，把拖拽的最后一段 / 整次换场景抹回去）。 */
async function bakeNow() {
  if (!S.doc) return;
  const seq = ++S.bakeSeq, rev = S.rev, doc = S.doc;
  const r = await API.post('/api/bake', { doc, backdrop: backdropBody() });
  if (seq !== S.bakeSeq || rev !== S.rev || doc !== S.doc) return;
  applyBake(r);
}
function applyBake(r) {
  S.bake = r;
  // 只合并服务端**算出来**的派生量（曲线起点 origin / originWorld、插槽脚下的世界点）；sceneId / entity 等作者面字段以本地为准，绝不整份覆盖
  if (r.authoring) {
    const au = S.doc.authoring;
    if (r.authoring.origin) au.origin = r.authoring.origin;
    if (r.authoring.originWorld) au.originWorld = r.authoring.originWorld; else delete au.originWorld;
  }
  if (Array.isArray(r.slots)) { const mine = Edit.slots(S.doc); for (const rs of r.slots) { const sl = mine.find((q) => q.id === rs.id); if (sl && rs.world) sl.world = rs.world; } }
  if (r.keyframes && r.keyframes.length) { S.doc.keyframes = r.keyframes; if (r.worldKeyframes) S.doc.worldKeyframes = r.worldKeyframes; else delete S.doc.worldKeyframes; }
  const total = r.totalMs || 0;
  if (S.tMs > total) S.tMs = total;
  el('bakeInfo').textContent = r.keyframes && r.keyframes.length
    ? `${r.keyframes.length} 帧${r.worldKeyframes ? '（3D ' + r.worldKeyframes.length + '）' : ''} · ${fmt(total, 0)} ms · ${r.preview.screen.length} 密采样`
    : '（没烘出帧）';
  el('warnings').textContent = (r.warnings || []).join('\n');
  renderSegList(); renderInspectorLive(); updateTime(); draw();
}

// ---------------------------------------------------------------- 播放
function togglePlay() {
  if (!S.bake || !S.bake.totalMs) return;
  S.playing = !S.playing; el('btnPlay').textContent = S.playing ? '❚❚ 暂停' : '▶ 播放';
  if (S.playing) { if (S.tMs >= S.bake.totalMs) S.tMs = 0; lastT = 0; requestAnimationFrame(tick); }
}
function stepTime(d) { if (!S.bake) return; S.playing = false; el('btnPlay').textContent = '▶ 播放'; S.tMs = clamp(S.tMs + d, 0, S.bake.totalMs); updateTime(); draw(); }
let lastT = 0;
function tick(now) {
  if (!S.playing || !S.bake) return;
  const dt = lastT ? (now - lastT) : 0; lastT = now;
  S.tMs += dt;
  if (S.tMs >= S.bake.totalMs) { if (el('loop').checked) S.tMs = 0; else { S.tMs = S.bake.totalMs; S.playing = false; el('btnPlay').textContent = '▶ 播放'; } }
  updateTime(); draw();
  if (S.playing) requestAnimationFrame(tick);
}
function updateTime() {
  const total = S.bake ? S.bake.totalMs : 0;
  el('timeLabel').textContent = `${fmt(S.tMs, 0)} / ${fmt(total, 0)} ms`;
  el('scrub').value = total > 0 ? Math.round(S.tMs / total * 1000) : 0;
}

// ---------------------------------------------------------------- 渲染
// ---------------------------------------------------------------- 坐标对齐自证（工作台的世界 = 游戏的世界）
/**
 * 运行时那份 `SceneSpaceGeometry`：把工作台装到的标定与行走面场按运行时 `sceneSpace.ts` 的形状喂回去，
 * 于是运行时的 `groundWorldAt` 可以在页面里**原样跑**——同一份代码，不是"照着写的"。
 */
function runtimeGeo() {
  const cal = S.cal, rt = S.runtime;
  if (!cal || !cal.ground || !rt) return null;
  return {
    work: { w: cal.work.w, h: cal.work.h },
    cal: { ppu: cal.ppu, cx: cal.cx, cy: cal.cy },
    sceneWorld: { w: cal.worldW, h: cal.worldH },
    basisRows: cal.rows, wuPerQUnit: cal.wuPerQ,
    ground: { data: cal.ground.data, w: cal.ground.w, h: cal.ground.h },
  };
}
/**
 * 对齐自证：把"作者摆点"与"游戏开播"两条口径分别拿运行时的函数跑一遍，和工作台自己的 SceneCal 比。
 *   dPts  画面点 → M-world 地面点（`sceneSpace.groundWorldAt`）：作者点的那里 == 运行时认为的那里
 *   dProj 3D 相对位移 → 画面偏移（`trajectoryProjection.projectWorldOffset`）：预览里的形状 == 开播时的形状
 *   dRound 世界点 → 画面 → 世界的往返（这条只用工作台自己，抓标定自身退化）
 * 镜像 / 错基 / 错尺任何一环，Δ 就是几十上百 wu。**这道自证是必须的**：坐标错了从来不报错，
 * 投影与拾取共用同一套换算所以自洽（2026-09-08 声学、2026-09-10 这里，制作人各抓到一次）。
 */
function checkAlignment() {
  const geo = runtimeGeo(); if (!geo) return null;
  const rt = S.runtime, cal = S.cal;
  const d3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  let dPts = 0, n = 0;
  for (let i = 1; i <= 5; i++) for (let j = 1; j <= 5; j++) {
    const sx = cal.worldW * i / 6, sy = cal.worldH * j / 6;
    dPts = Math.max(dPts, d3(rt.sceneSpace.groundWorldAt(geo, sx, sy), cal.sceneToWorldGround(sx, sy))); n++;
  }
  // 投影：拿一批 3D 位移过运行时的 projectWorldOffset 与工作台的 projectOffset（预览曲线就是它画的）
  let dProj = 0, nProj = 0;
  const rows = cal.rows;
  for (const d of [[100, 0, 0], [0, 100, 0], [0, 0, 100], [-70, 40, 25], [33, -110, -60], [12, 7, -3]]) {
    const a = rt.trajectoryProjection.projectWorldOffset(rows, d[0], d[1], d[2]);
    const b = cal.projectOffset(d[0], d[1], d[2]);
    dProj = Math.max(dProj, Math.hypot(a.x - b[0], a.y - b[1])); nProj++;
  }
  // 往返：世界点 → 画面 → 世界（地面上的点应当原样回来）
  let dRound = 0;
  for (let i = 1; i <= 3; i++) for (let j = 1; j <= 3; j++) {
    const sx = cal.worldW * i / 4, sy = cal.worldH * j / 4;
    const w = cal.sceneToWorldGround(sx, sy);
    const s2 = cal.worldToScene(w[0], w[1], w[2]);
    dRound = Math.max(dRound, Math.hypot(s2[0] - sx, s2[1] - sy));
  }
  const ok = dPts < 0.5 && dProj < 1e-6 && dRound < 0.5;
  return { ok, dPts, dProj, dRound, n, nProj };
}
function refreshAlignment() { S.align = checkAlignment(); }
function alignText() {
  const a = S.align;
  if (!a) return S.runtime ? '' : '\n⚠ 坐标自证：没有运行时包，对不了（页面画的可能不是游戏要播的）';
  return a.ok
    ? `\n坐标：与运行时同一套 ✓（${a.n + a.nProj} 点 Δ${fmt(a.dPts, 2)} wu · 投影 Δ${a.dProj.toExponential(0)}）`
    : `\n⚠ 坐标与运行时不一致：地面 Δ${fmt(a.dPts, 1)} wu · 投影 Δ${fmt(a.dProj, 3)}`;
}
function renderSceneInfo() {
  const s = S.scene; if (!s) { el('sceneInfo').textContent = '—'; return; }
  const c = s.cal;
  el('sceneInfo').textContent = `${s.id} · ${s.background}\n世界 ${fmt(s.worldWidth, 0)}×${fmt(s.worldHeight, 0)} wu · 原生 ${s.native.w}×${s.native.h}px`
    + (c ? `\n俯角 ${fmt(Math.acos(c.cosTheta) * 180 / Math.PI)}° · wuPerQ ${fmt(c.wuPerQUnit, 1)} · 地面：${c.groundSource === 'ground_d' ? '行走面场' : '深度壳(近似)'}` : '\n无深度（不能用世界空间）')
    + (c ? alignText() : '');
  // 对不上是"别信这个页面"级别的事，直接把整块信息染红（芯片本身是 mono/dim，别把类洗掉）
  const broken = !!(S.align && !S.align.ok) || (!!c && !S.runtime);
  el('sceneInfo').style.color = broken ? 'var(--err, #f66)' : 'var(--dim)';
}
function renderAll() {
  const hasDoc = !!S.doc;
  for (const id of ['btnSave', 'btnRename', 'btnDup', 'btnDelete', 'btnAddManual', 'btnAddPhysics', 'btnSegUp', 'btnSegDown', 'btnSegDup', 'btnSegDel', 'btnSlotPlace', 'btnBakeFromEntity']) el(id).disabled = !hasDoc;
  if (hasDoc) { writeBakeSettings(); fillEntitySel(); renderSlots(); renderOrigin(); el('label').value = S.doc.label || ''; el('space').value = S.doc.space || 'screen'; el('binding').value = host.binding(); el('sceneSel').disabled = host.binding() === 'scene'; }
  clampSelection();
  renderSegList(); renderInspector(); updateScopeButtons(); updateHistoryButtons(); updateTime(); draw();
}

boot();
