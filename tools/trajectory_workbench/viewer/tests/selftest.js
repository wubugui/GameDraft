/* 轨迹工作台 · 交互层端到端回归（在真页面里跑；由 `python -m tools.trajectory_workbench --selftest` 注入）。
 *
 * 这是审查循环里反复踩到的那些坑的固化版：新开资产的第一笔手势、保存后改数值、在飞的烘焙 / 保存竞态、
 * 换场景与撤销重做的现场同步、装载门、渲染只读、手势跨 doc、时间键、起点在地面线之下……
 * 每条 `ok()` 一行 PASS/FAIL；异常记 EXC；跑完把整份报告写进 window.__selftestResult。
 * 约定：只读 coin_drop_demo（绝不在它上面 saveAsset）；临时资产 zz_selftest_* 用完即删；
 * 所有 API 替身在 finally 里还原；每步从 S.doc 重新取段引用（撤销后 doc 整份替换）。 */
(async () => {
  const log = [];
  const ok = (name, cond, extra) => log.push((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + JSON.stringify(extra) : ''));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const settle = async () => { clearTimeout(S.bakeTimer); await bakeNow(); };   // 把挂着的烘焙立刻跑完（派生量 / 段边界 / 警告都以它为准）
  const R = (v) => Math.round(v);
  const c2 = () => el('view2d');
  const ev = (type, cx, cy, opts, target) => { const c = target || c2(); const r = c.getBoundingClientRect(); const e = new MouseEvent(type, Object.assign({ bubbles: true, cancelable: true, clientX: Math.round(r.left + cx), clientY: Math.round(r.top + cy), button: 0, buttons: 1 }, opts || {})); (type === 'mousedown' || type === 'dblclick' ? c : window).dispatchEvent(e); };
  const click = (cx, cy, opts, t) => { ev('mousedown', cx, cy, opts, t); ev('mouseup', cx, cy, opts, t); };
  const drag = (x0, y0, x1, y1, opts, t) => { ev('mousedown', x0, y0, opts, t); for (let i = 1; i <= 6; i++) ev('mousemove', x0 + (x1 - x0) * i / 6, y0 + (y1 - y0) * i / 6, opts, t); ev('mouseup', x1, y1, opts, t); };
  const key = (k, opts, target) => { const e = new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, opts || {})); (target || window).dispatchEvent(e); return e; };
  const segs = () => S.doc.source.segments;
  const TC = (sx, sy) => { const c = v2.toCanvas(sx, sy); return [R(c[0]), R(c[1])]; };
  const focusAnchor = () => { const o = Edit.originScreen(host); const an = { x: o[0], y: o[1] }; v2.zoom = 1; v2.ox = c2().clientWidth / 2 - an.x; v2.oy = c2().clientHeight / 2 - an.y; v2.draw(); return an; };   // 曲线起点（曲线没有锚点了）
  const tmpIds = [];
  const mkScreen = async (id) => {
    const doc = { id, label: '自检', space: 'screen', keyframes: [], source: { segments: [
      { id: 'm1', kind: 'manual', startFrom: 'explicit', start: { x: 975.1, y: 1491.9 }, path: { points: [{ x: 975.1, y: 1491.9 }, { x: 1055, y: 1450 }, { x: 1140, y: 1470 }] }, timing: { durationMs: 800, keys: [{ atMs: 0, progress: 0 }, { atMs: 800, progress: 1 }] } },
      { id: 'p1', kind: 'physics', startFrom: 'previous', v0: { x: -100, y: -200 }, gravity: 1500, groundY: 1500 }] },
      binding: 'scene', slots: [], authoring: { sceneId: '雾津街头', background: 'background.png' } };
    await API.post('/api/save', { doc }); tmpIds.push(id);
    const tr = await API.json('/api/trajectories'); S.assets = tr.trajectories; fillAssetSel();
    return doc;
  };
  const refreshAssets = async () => { const tr = await API.json('/api/trajectories'); S.assets = tr.trajectories; fillAssetSel(); if (S.doc) el('assetSel').value = S.doc.id; };
  const origAPI = { json: API.json, post: API.post, bin: API.bin, image: API.image };
  const restoreAPI = () => { API.json = origAPI.json; API.post = origAPI.post; API.bin = origAPI.bin; API.image = origAPI.image; };
  let coinJson = '';
  try {
    // ---------------------------------------------------------------- S1 启动
    for (let i = 0; i < 40 && !(S.doc && S.bake); i++) await wait(250);
    ok('S1 boot: coin open, clean, gate down', S.doc && S.doc.id === 'coin_drop_demo' && !S.dirty && el('busy').hidden && !el('app').inert, { id: S.doc && S.doc.id, v3: !!(v3 && v3.ok) });
    coinJson = JSON.stringify(S.doc);
    // ---------------------------------------------------------------- S2 渲染只读
    { const before = JSON.stringify(S.doc);
      for (let i = 0; i < segs().length; i++) { host.selectSegmentScope(i); renderInspector(); host.selectSegment(i); if (segs()[i].kind === 'manual') host.selectPoint(1, false); renderInspector(); await wait(30); }
      ok('S2 inspector rendering never writes the doc', JSON.stringify(S.doc) === before && !S.dirty && history.undoStack.length === 0);
      host.selectSegmentScope(1); const c = TC(...Edit.originScreen(host)); click(c[0] + 300, c[1] + 300);
      ok('S2 clicking around does not dirty', !S.dirty && history.undoStack.length === 0); }
    // ---------------------------------------------------------------- S3 第一笔手势（新开资产）
    await mkScreen('zz_selftest_a');
    await openAsset('zz_selftest_a'); await wait(200);
    { const an = focusAnchor(); setTool('pen'); host.selectSegment(0); const n0 = segs()[0].path.points.length;
      for (const q of [[an.x + 200, an.y - 50], [an.x + 260, an.y - 80]]) { const c = TC(q[0], q[1]); click(c[0], c[1]); }
      ok('S3 first pen clicks after open: one history entry each', segs()[0].path.points.length === n0 + 2 && history.undoStack.length === 2 && !history.inDrag() && history.peekUndo() === '加点', { n: segs()[0].path.points.length, undo: history.undoStack.length });
      key('z', { ctrlKey: true }); key('y', { ctrlKey: true });
      ok('S3 undo + redo in one task', segs()[0].path.points.length === n0 + 2 && !history.canRedo, { n: segs()[0].path.points.length });
      key('Escape'); ok('S3 Esc back to select', S.tool === 'select'); }
    clearDirty(); await openAsset('zz_selftest_a'); await wait(200);
    { const an = focusAnchor(); setTool('physics'); const t0 = TC(an.x - 150, an.y + 60); drag(t0[0], t0[1], t0[0] - 60, t0[1] + 20);
      const ps = segs()[segs().length - 1]; const pi = host.physicsInfo(ps);
      ok('S3 first physics drag after open lands under the mouse', ps.kind === 'physics' && pi && !pi.grounded && Math.abs(pi.landing[0] - (an.x - 210)) < 2 && history.undoStack.length === 1 && !history.inDrag() && S.tool === 'select', { landing: pi && pi.landing.map(R) });
      key('z', { ctrlKey: true }); ok('S3 undo removes the new physics segment', segs().length === 2); }
    // ---------------------------------------------------------------- S4 点 / 框选 / gizmo / 变换
    { clearDirty(); await openAsset('zz_selftest_a'); await wait(200); const an = focusAnchor(); host.selectSegment(0);
      let pts = host.effPoints(segs()[0]); let c = TC(pts[1].sx, pts[1].sy); click(c[0], c[1]);
      ok('S4 click selects point', S.sel.points.has(1) && S.sel.points.size === 1);
      const x0 = pts[1].sx; drag(c[0], c[1], c[0] + 20, c[1] + 10); pts = host.effPoints(segs()[0]);
      ok('S4 drag point moves it', Math.abs(pts[1].sx - x0 - 20) <= 1 && history.peekUndo() === '移动控制点');
      key('z', { ctrlKey: true }); pts = host.effPoints(segs()[0]); ok('S4 undo drag', Math.abs(pts[1].sx - x0) <= 1);
      const bx0 = TC(Math.min(...pts.slice(1).map((p) => p.sx)) - 15, Math.min(...pts.slice(1).map((p) => p.sy)) - 15), bx1 = TC(Math.max(...pts.slice(1).map((p) => p.sx)) + 15, Math.max(...pts.slice(1).map((p) => p.sy)) + 15);
      drag(bx0[0], bx0[1], bx1[0], bx1[1]);
      ok('S4 box select', S.sel.points.size === 2 && !S.sel.points.has(0) && !!host.gizmo(), [...S.sel.points]);
      let gg = v2._gizmo(); const before = [...S.sel.points].sort().map((i) => host.effPoints(segs()[0])[i].sx);
      ok('S4 2D gizmo (screen space) has X / Y axes and no planes', !!gg && gg.dim === 2 && gg.axes.length === 2 && Object.keys(gg.planes).length === 0 && gg.mode === 'move', gg && { axes: gg.axes.map((a) => a.k), planes: Object.keys(gg.planes) });
      drag(R(gg.c[0]), R(gg.c[1]), R(gg.c[0]) + 12, R(gg.c[1]));
      const after = [...S.sel.points].sort().map((i) => host.effPoints(segs()[0])[i].sx);
      ok('S4 gizmo move', after.every((v, k) => Math.abs(v - before[k] - 12) < 0.6) && history.peekUndo() === '移动');
      key('z', { ctrlKey: true });
      let dirty0 = S.dirty, undo0 = history.undoStack.length, doc0 = JSON.stringify(S.doc);
      gg = v2._gizmo(); ev('mousedown', R(gg.c[0]), R(gg.c[1])); ev('mousemove', R(gg.c[0]) + 1, R(gg.c[1])); ev('mouseup', R(gg.c[0]) + 1, R(gg.c[1]));
      ok('S4 1px jitter is not an edit', S.dirty === dirty0 && history.undoStack.length === undo0 && JSON.stringify(S.doc) === doc0);
      // 单轴：X 箭头只动 x；Y 箭头（画面上）只动 y 且向上为负
      { const g1 = v2._gizmo(); const yy = [...S.sel.points].sort().map((i) => host.effPoints(segs()[0])[i].sy); const xx = [...S.sel.points].sort().map((i) => host.effPoints(segs()[0])[i].sx);
        const tx = g1.tip.x, cx = g1.c; const sx = [R(cx[0] + (tx[0] - cx[0]) * 0.6), R(cx[1] + (tx[1] - cx[1]) * 0.6)]; drag(sx[0], sx[1], sx[0] + 15, sx[1]);
        const xx1 = [...S.sel.points].sort().map((i) => host.effPoints(segs()[0])[i].sx), yy1 = [...S.sel.points].sort().map((i) => host.effPoints(segs()[0])[i].sy);
        ok('S4 2D X arrow moves only x', xx1.every((v, k) => Math.abs(v - xx[k] - 15) < 0.6) && yy1.every((v, k) => Math.abs(v - yy[k]) < 1e-6), { dx: xx1.map((v, k) => +(v - xx[k]).toFixed(2)) });
        key('z', { ctrlKey: true });
        const g2 = v2._gizmo(); const ty = g2.tip.y, cy = g2.c; const sy = [R(cy[0] + (ty[0] - cy[0]) * 0.6), R(cy[1] + (ty[1] - cy[1]) * 0.6)]; drag(sy[0], sy[1], sy[0], sy[1] - 15);
        const xx2 = [...S.sel.points].sort().map((i) => host.effPoints(segs()[0])[i].sx), yy2 = [...S.sel.points].sort().map((i) => host.effPoints(segs()[0])[i].sy);
        ok('S4 2D Y arrow moves only y (up = smaller y)', yy2.every((v, k) => Math.abs(v - yy[k] + 15) < 0.6) && xx2.every((v, k) => Math.abs(v - xx[k]) < 1e-6), { dy: yy2.map((v, k) => +(v - yy[k]).toFixed(2)) });
        key('z', { ctrlKey: true }); }
      // 单点选中也有 gizmo（制作人 2026-09-11："第一次点击根本没有 gizmo"）
      { pts = host.effPoints(segs()[0]); const c1 = TC(pts[1].sx, pts[1].sy); click(c1[0], c1[1]);
        const g1 = v2._gizmo();
        ok('S4 single selected point gets a gizmo right away', S.sel.points.size === 1 && !!g1 && g1.n === 1 && Math.abs(g1.c[0] - c1[0]) < 1.5 && Math.abs(g1.c[1] - c1[1]) < 1.5, g1 && { n: g1.n });
        const x1 = pts[1].sx; drag(c1[0], c1[1], c1[0] + 10, c1[1]);
        ok('S4 dragging the point itself is still a point drag (center defers to the point)', Math.abs(host.effPoints(segs()[0])[1].sx - x1 - 10) <= 1 && history.peekUndo() === '移动控制点', history.peekUndo());
        key('z', { ctrlKey: true }); }
      host.selectSegmentScope(0); gg = v2._gizmo(); const p0 = host.effPoints(segs()[0]).map((p) => [p.sx, p.sy]);
      drag(R(gg.c[0]), R(gg.c[1]), R(gg.c[0]) + 20, R(gg.c[1]) + 10);
      const p1 = host.effPoints(segs()[0]).map((p) => [p.sx, p.sy]);
      // 第 0 段的起点就是曲线起点（自定，可拖）：整段挪就是整段挪，没有"促升"这回事了
      ok('S4 whole-segment move moves every point (segment 0 start = curve start, always explicit)', segs()[0].startFrom === 'explicit' && p1.every((p, k) => Math.abs(p[0] - p0[k][0] - 20) < 0.6 && Math.abs(p[1] - p0[k][1] - 10) < 0.6), { startFrom: segs()[0].startFrom, d: p1.map((p, k) => [R(p[0] - p0[k][0]), R(p[1] - p0[k][1])]) });
      key('z', { ctrlKey: true }); ok('S4 undo restores the segment', host.effPoints(segs()[0]).every((p, k) => Math.abs(p.sx - p0[k][0]) < 1e-6));
      dirty0 = S.dirty; undo0 = history.undoStack.length; doc0 = JSON.stringify(S.doc);
      host.setScope('segment'); el('txDx').value = '0'; el('txDy').value = '0'; applyNumericTransform('move'); el('txRot').value = '0'; applyNumericTransform('rot'); el('txScale').value = '1'; applyNumericTransform('scale');
      ok('S4 zero numeric transforms are no-ops', S.dirty === dirty0 && history.undoStack.length === undo0 && JSON.stringify(S.doc) === doc0 && segs()[0].startFrom === 'explicit');
      // 整条平移：曲线起点、各段与插槽一起挪（曲线没有锚点）
      host.op('slot', () => Edit.addSlot(host, 900, 1400, '人站位'));
      host.setScope('all'); const o0 = Edit.originScreen(host).slice(); const sl0 = Object.assign({}, Edit.slots(S.doc)[0]); el('txDx').value = '40'; el('txDy').value = '-20'; applyNumericTransform('move');
      ok('S4 whole-trajectory translate moves the curve start, every point and the slots together', Math.abs(Edit.originScreen(host)[0] - o0[0] - 40) < 0.6 && Math.abs(Edit.originScreen(host)[1] - o0[1] + 20) < 0.6 && Math.abs(Edit.slots(S.doc)[0].x - sl0.x - 40) < 0.6 && Math.abs(Edit.slots(S.doc)[0].y - sl0.y + 20) < 0.6, { o: Edit.originScreen(host), slot: Edit.slots(S.doc)[0] });
      key('z', { ctrlKey: true }); host.clearSelection();
      // 命名插槽（曲线暴露给场景的位置）：S 工具放置 → 选中 + gizmo；拖它 / 拖 gizmo 只动插槽；Delete 删；曲线一动不动
      { const pts0 = host.effPoints(segs()[0]).map((p) => [p.sx, p.sy]); const n0 = Edit.slots(S.doc).length;
        setTool('slot'); const tc = TC(o0[0] - 60, o0[1] + 40); click(tc[0], tc[1]);
        const sl = Edit.slots(S.doc)[n0]; const g1 = v2._gizmo();
        ok('S4 slot tool places a named slot, selects it, gizmo sits on it, curve untouched', Edit.slots(S.doc).length === n0 + 1 && !!sl && Math.abs(sl.x - (o0[0] - 60)) < 0.6 && S.sel.handle === 'slot:' + sl.id && !!g1 && g1.label.startsWith('插槽') && S.tool === 'select' && host.effPoints(segs()[0]).every((p, k) => Math.abs(p.sx - pts0[k][0]) < 1e-6), { slots: Edit.slots(S.doc).map((q) => q.id), handle: S.sel.handle, label: g1 && g1.label });
        const sc = TC(sl.x, sl.y); drag(sc[0], sc[1], sc[0] + 25, sc[1] + 5);
        ok('S4 dragging the slot moves only the slot', Math.abs(Edit.slots(S.doc)[n0].x - (o0[0] - 60) - 25) < 0.6 && host.effPoints(segs()[0]).every((p, k) => Math.abs(p.sx - pts0[k][0]) < 1e-6) && history.peekUndo() === '移动插槽', { slot: Edit.slots(S.doc)[n0], undo: history.peekUndo() });
        const g2 = v2._gizmo(); const tx = g2.tip.x; const sx = [R(g2.c[0] + (tx[0] - g2.c[0]) * 0.6), R(g2.c[1] + (tx[1] - g2.c[1]) * 0.6)]; const before = Object.assign({}, Edit.slots(S.doc)[n0]); drag(sx[0], sx[1], sx[0] + 15, sx[1]);
        ok('S4 slot gizmo X arrow moves the slot along x only', Math.abs(Edit.slots(S.doc)[n0].x - before.x - 15) < 0.6 && Math.abs(Edit.slots(S.doc)[n0].y - before.y) < 1e-6, { slot: Edit.slots(S.doc)[n0], before });
        key('Delete');
        ok('S4 Delete removes the selected slot', Edit.slots(S.doc).length === n0 && !S.sel.handle, { n: Edit.slots(S.doc).length });
        key('z', { ctrlKey: true }); key('z', { ctrlKey: true }); key('z', { ctrlKey: true }); key('z', { ctrlKey: true });   // 删 / X 轴 / 拖 / 放置
        ok('S4 undo walks the slot edits back', Edit.slots(S.doc).length === n0, { n: Edit.slots(S.doc).length });
        key('z', { ctrlKey: true }); }   // 撤掉最开始 host.op('slot') 那个
      // 曲线原点（2026-09-11 第二轮）：原点是作者摆的点，不是第一帧——调运动起点绝不许动它
      { host.clearSelection(); const pts0 = host.effPoints(segs()[0]).map((p) => [p.sx, p.sy]);
        const st0 = Edit.curveStartScreen(host).slice();
        const want = [st0[0] - 70, st0[1] + 50];
        setTool('origin'); const tc = TC(want[0], want[1]); click(tc[0], tc[1]);
        const gO = v2._gizmo(); const o1 = Edit.originScreen(host).slice();
        ok('S4 origin tool puts the curve origin where clicked, selects it, curve untouched', Math.abs(o1[0] - want[0]) < 0.6 && Math.abs(o1[1] - want[1]) < 0.6 && S.sel.handle === 'origin' && !!gO && gO.label === '曲线原点' && S.tool === 'select' && host.effPoints(segs()[0]).every((p, k) => Math.abs(p.sx - pts0[k][0]) < 1e-6), { origin: o1, want, handle: S.sel.handle, label: gO && gO.label });
        const oc = TC(o1[0], o1[1]); drag(oc[0], oc[1], oc[0] + 30, oc[1] - 10);
        const o2 = Edit.originScreen(host).slice();
        ok('S4 dragging the origin moves only the origin (the curve does not move)', Math.abs(o2[0] - o1[0] - 30) < 0.6 && Math.abs(o2[1] - o1[1] + 10) < 0.6 && host.effPoints(segs()[0]).every((p, k) => Math.abs(p.sx - pts0[k][0]) < 1e-6 && Math.abs(p.sy - pts0[k][1]) < 1e-6) && history.peekUndo() === '移动曲线原点', { o1, o2, undo: history.peekUndo() });
        // 制作人那句话的判据：调运动起点，原点一动不动
        host.selectSegment(0); host.selectPoint(0, false);
        const pc = TC(st0[0], st0[1]); drag(pc[0], pc[1], pc[0] + 40, pc[1] + 20);
        ok('S4 moving the motion start leaves the origin where the author put it', Math.abs(Edit.curveStartScreen(host)[0] - st0[0] - 40) < 0.8 && Math.abs(Edit.originScreen(host)[0] - o2[0]) < 1e-6 && Math.abs(Edit.originScreen(host)[1] - o2[1]) < 1e-6, { start: Edit.curveStartScreen(host), origin: Edit.originScreen(host), was: o2 });
        key('z', { ctrlKey: true }); key('z', { ctrlKey: true }); key('z', { ctrlKey: true }); host.clearSelection();
        ok('S4 undo walks the origin edits back', Math.abs(Edit.curveStartScreen(host)[0] - st0[0]) < 1e-6 && host.effPoints(segs()[0]).every((p, k) => Math.abs(p.sx - pts0[k][0]) < 1e-6), { start: Edit.curveStartScreen(host), st0 }); }
      // 拾取优先级：别的点正好躺在选中点的 gizmo 轴上 → 点它得选它（"选这个点，动的是另一个点"）
      { host.op('p2', () => Edit.setPoint(host, segs()[0], 2, [host.effPoints(segs()[0])[1].sx + 50, host.effPoints(segs()[0])[1].sy]));
        host.selectPoint(1, false); v2.draw(); const g1 = v2._gizmo(); const c2 = TC(host.effPoints(segs()[0])[2].sx, host.effPoints(segs()[0])[2].sy);
        ok('S4 setup: point 2 sits on point 1 X arrow', !!g1 && Math.abs(c2[1] - g1.c[1]) < 1.5 && c2[0] - g1.c[0] > 20 && c2[0] - g1.c[0] < 84, { dx: c2[0] - (g1 ? g1.c[0] : 0) });
        const hp = v2._hit(c2[0], c2[1]);
        ok('S4 a point under another point gizmo arrow is hit as that point, not the arrow', hp && hp.kind === 'point' && hp.i === 2, hp);
        const x2 = host.effPoints(segs()[0])[2].sx, x1 = host.effPoints(segs()[0])[1].sx; drag(c2[0], c2[1], c2[0], c2[1] + 15);
        ok('S4 dragging it moves point 2 only (point 1 untouched)', S.sel.points.has(2) && S.sel.points.size === 1 && Math.abs(host.effPoints(segs()[0])[2].sy - (host.effPoints(segs()[0])[1].sy + 15)) < 0.6 && Math.abs(host.effPoints(segs()[0])[1].sx - x1) < 1e-6 && Math.abs(host.effPoints(segs()[0])[2].sx - x2) < 1e-6, { sel: [...S.sel.points] });
        key('z', { ctrlKey: true }); key('z', { ctrlKey: true }); }
      host.selectSegment(0); pts = host.effPoints(segs()[0]); c = TC(pts[2].sx, pts[2].sy);
      ev('mousedown', c[0], c[1], { button: 2, buttons: 2 }); ev('mouseup', c[0], c[1], { button: 2, buttons: 0 });
      ok('S4 right-click deletes a point', segs()[0].path.points.length === 2); key('z', { ctrlKey: true }); ok('S4 undo delete', segs()[0].path.points.length === 3);
      key('Delete'); ok('S4 Delete with no selection on manual only hints', segs()[0].path.points.length === 3 && el('status').textContent.includes('没有选中'));
      host.selectSegment(1); key('Delete'); ok('S4 Delete on physics with points scope only hints', segs().length === 2 && el('status').textContent.includes('整段')); }
    // ---------------------------------------------------------------- S5 抛体把手
    { host.selectSegmentScope(1); const seg1 = () => segs()[1]; let pi = host.physicsInfo(seg1());
      const L = TC(pi.landing[0], pi.landing[1]); const lx0 = pi.landing[0]; drag(L[0], L[1], L[0] + 30, L[1]); pi = host.physicsInfo(seg1());
      ok('S5 landing drag keeps vy and moves landing', Math.abs(pi.landing[0] - lx0 - 30) < 1.5 && seg1().v0.y === -200, { landing: pi.landing.map(R) });
      // 抛体把手也是"物体"：点一下就选中它，gizmo 落在它上面，轴按它的自由度裁剪（2026-09-11 制作人："最高点 / 落点 / 初速全都没有 gizmo"）
      { ok('S5 landing handle is selected after the drag and has an X-only gizmo (screen space landing lives on the ground line)', S.sel.handle === 'landing' && !!v2._gizmo() && v2._gizmo().axes.map((a) => a.k).join() === 'x' && v2._gizmo().label === '落点', { handle: S.sel.handle, axes: v2._gizmo() && v2._gizmo().axes.map((a) => a.k) });
        const tipC = TC(pi.tip[0], pi.tip[1]); click(tipC[0], tipC[1]); const gv = v2._gizmo();
        ok('S5 clicking the v0 tip selects it with an X / Y gizmo on the tip', S.sel.handle === 'v0' && !!gv && gv.axes.map((a) => a.k).join() === 'x,y' && Math.abs(gv.c[0] - tipC[0]) < 1.5 && Math.abs(gv.c[1] - tipC[1]) < 1.5, { handle: S.sel.handle });
        const v0a = Object.assign({}, seg1().v0); const tx = gv.tip.x; const sx = [R(gv.c[0] + (tx[0] - gv.c[0]) * 0.6), R(gv.c[1] + (tx[1] - gv.c[1]) * 0.6)]; drag(sx[0], sx[1], sx[0] + 25, sx[1]);
        ok('S5 v0 gizmo X arrow changes only v0.x (tip moved 25 wu → +100/s)', Math.abs(seg1().v0.x - v0a.x - 100) < 2 && seg1().v0.y === v0a.y && history.peekUndo() === '移动初速（箭尖）', { v0: seg1().v0, v0a, undo: history.peekUndo() });
        key('z', { ctrlKey: true });
        const pa = host.physicsInfo(seg1()); const apC = TC(pa.apex[0], pa.apex[1]); click(apC[0], apC[1]); const ga = v2._gizmo();
        ok('S5 apex handle gizmo is Y-only', S.sel.handle === 'apex' && !!ga && ga.axes.map((a) => a.k).join() === 'y' && !ga.cfg.center, { handle: S.sel.handle, axes: ga && ga.axes.map((a) => a.k) });
        const ay = pa.apex[1], lx = pa.landing[0]; const ty = ga.tip.y; const sy = [R(ga.c[0] + (ty[0] - ga.c[0]) * 0.6), R(ga.c[1] + (ty[1] - ga.c[1]) * 0.6)]; drag(sy[0], sy[1], sy[0], sy[1] - 20);
        const pb = host.physicsInfo(seg1());
        ok('S5 apex gizmo Y arrow raises the apex by 20 and keeps the landing', Math.abs((ay - pb.apex[1]) - 20) < 0.8 && Math.abs(pb.landing[0] - lx) < 0.8, { dApex: +(ay - pb.apex[1]).toFixed(2), dLanding: +(pb.landing[0] - lx).toFixed(2) });
        key('z', { ctrlKey: true }); host.selectSegmentScope(1); }
      const A = TC(pi.apex[0], pi.apex[1]); const ay0 = pi.apex[1]; drag(A[0], A[1], A[0], A[1] - 20); const pi2 = host.physicsInfo(seg1());
      ok('S5 apex drag raises apex, keeps landing', Math.abs((ay0 - pi2.apex[1]) - 20) < 0.6 && Math.abs(pi2.landing[0] - pi.landing[0]) < 0.6);
      const gl = TC(0, seg1().groundY)[1]; const stc = TC(pi2.start[0], pi2.start[1]);
      ok('S5 ground-line edge handle hit', v2._hit(27, gl) && v2._hit(27, gl).kind === 'ground');
      drag(27, gl, 27, stc[1] - 60); ok('S5 ground line cannot go above start', seg1().groundY >= pi2.start[1] - 1e-6 && el('status').textContent.includes('地面线'));
      host.op('改重力', () => { seg1().gravity = 0; }); const v0g = Object.assign({}, seg1().v0); setTool('physics'); drag(L[0], L[1], L[0] + 10, L[1]);
      ok('S5 g=0: landing drag refuses, v0 untouched and finite, tool back to select', Number.isFinite(seg1().v0.x) && Number.isFinite(seg1().v0.y) && seg1().v0.x === v0g.x && seg1().v0.y === v0g.y && el('status').textContent.includes('重力') && S.tool === 'select' && !history.inDrag(), { v0: seg1().v0, status: el('status').textContent });
      while (history.canUndo) key('z', { ctrlKey: true }); clearDirty();
      host.op('low', () => Edit.setPoint(host, segs()[0], 2, [1140, segs()[1].groundY + 60])); await settle(); const pi3 = host.physicsInfo(segs()[1]);
      ok('S5 start below ground line is lifted, landing sane', pi3.lifted && Math.abs(pi3.landing[0]) < 5000 && el('inspector').textContent.includes('地面线之下'), { lifted: pi3.lifted, start: pi3.start.map(R), gy: pi3.groundY });
      { const gy0 = segs()[1].groundY; const gl = TC(0, gy0)[1]; drag(27, gl, 27, gl + 4);
        ok('S5 lifted: ground-line nudge moves the line by the nudge, no jump to the old start', Math.abs(segs()[1].groundY - gy0 - 4) < 0.6 && !el('status').textContent.includes('不能高于'), { gy: segs()[1].groundY, gy0 });
        key('z', { ctrlKey: true });
        const pi4 = host.physicsInfo(segs()[1]); const L4 = TC(pi4.landing[0], pi4.landing[1]); drag(L4[0], L4[1], L4[0] - 30, L4[1] + 3);
        ok('S5 lifted: landing drag moves the line only by the mouse, landing follows', Math.abs(segs()[1].groundY - gy0 - 3) < 0.6 && Math.abs(host.physicsInfo(segs()[1]).landing[0] - (pi4.landing[0] - 30)) < 1.5, { gy: segs()[1].groundY, gy0, landing: host.physicsInfo(segs()[1]).landing.map(R) });
        key('z', { ctrlKey: true }); }
      key('z', { ctrlKey: true }); }
    // ---------------------------------------------------------------- S6 时间曲线
    { host.selectSegment(0); renderInspector(); await wait(120);
      const seg0 = () => segs()[0]; const tcv = el('timing'); const W = tcv.clientWidth, H = tcv.clientHeight, pad = 14; const dur = seg0().timing.durationMs; const r = tcv.getBoundingClientRect();
      tcv.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: r.left + pad + (W - 2 * pad) * 0.5, clientY: r.top + H - pad - (H - 2 * pad) * 0.5 }));
      const ks0 = seg0().timing.keys.map((k) => k.atMs);
      ok('S6 dblclick inserts a sorted middle key', ks0.length === 3 && ks0[0] < ks0[1] && ks0[1] < ks0[2], ks0);
      renderInspector(); await wait(120); const t2 = el('timing'); const r2 = t2.getBoundingClientRect(); const mid = Object.assign({}, seg0().timing.keys[1]);
      const mx = r2.left + pad + (mid.atMs / dur) * (W - 2 * pad), my = r2.top + H - pad - mid.progress * (H - 2 * pad);
      { const d0 = S.dirty, u0 = history.undoStack.length, k0 = Object.keys(seg0()).join();
        t2.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: mx, clientY: my, button: 0 })); window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: mx, clientY: my }));
        ok('S6 clicking a key without moving is not an edit (no dirty / history / tracks:{})', S.dirty === d0 && history.undoStack.length === u0 && Object.keys(seg0()).join() === k0 && !history.inDrag(), Object.keys(seg0())); }
      await wait(60); const t2b = el('timing');   // 松手会重画检视器：时间画布是新元素，别往旧的上派事件
      t2b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: mx, clientY: my, button: 0 }));
      window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: mx, clientY: my - 20 })); window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: mx, clientY: my - 20 }));
      const ks1 = seg0().timing.keys;
      ok('S6 dragging the middle key moves only it', ks1.length === 3 && Math.abs(ks1[1].atMs - mid.atMs) < 1 && ks1[1].progress > mid.progress + 0.05 && ks1[2].atMs === dur && ks1[2].progress === 1 && history.peekUndo() === '拖时间键', ks1);
      key('z', { ctrlKey: true }); key('z', { ctrlKey: true });
      delete seg0().timing; renderInspector(); await wait(120); let threw = false; const onerr = () => { threw = true; }; window.addEventListener('error', onerr);
      const t3 = el('timing'); const r3 = t3.getBoundingClientRect(); t3.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: r3.left + W / 2, clientY: r3.top + H / 2 })); await wait(80); window.removeEventListener('error', onerr);
      const kk = (seg0().timing || {}).keys || [];
      ok('S6 dblclick without timing does not throw and seeds both endpoints', !threw && kk.length === 3 && kk[0].atMs === 0 && kk[0].progress === 0 && kk[2].atMs === seg0().timing.durationMs && kk[2].progress === 1, kk);
      key('z', { ctrlKey: true }); clearDirty(); }
    // ---------------------------------------------------------------- S7 保存
    { clearDirty(); await openAsset('zz_selftest_a'); await wait(200); host.selectSegment(0);
      host.op('m', () => Edit.setPoint(host, segs()[0], 1, [1060, 1450]));
      const rc = await saveAsset(); await wait(150);
      const durInp = [...document.querySelectorAll('#inspector .row')].find((r) => r.textContent.startsWith('时长')).querySelector('input');
      durInp.value = '1500'; durInp.dispatchEvent(new Event('change'));
      ok('S7 inspector bound to the new doc after save', rc === 'ok' && segs()[0].timing.durationMs === 1500 && S.dirty && history.peekUndo() === '改时长');
      let inflight = 0, maxIn = 0; const op = API.post;
      API.post = async (path, body) => { if (path === '/api/save' || path === '/api/rename') { inflight++; maxIn = Math.max(maxIn, inflight); await wait(250); try { return await op(path, body); } finally { inflight--; } } return op(path, body); };
      const p = saveAsset(); await wait(60); el('label').value = '自检_改了'; el('label').dispatchEvent(new Event('input')); const rcL = await p; await wait(150);
      ok('S7 label typed during save is kept, stays dirty', rcL === 'conflict' && S.doc.label === '自检_改了' && S.dirty && el('status').textContent.includes('保存期间又有改动'), { rcL, label: S.doc.label, dirty: S.dirty });
      const rc2 = await saveAsset(); ok('S7 resave clean', rc2 === 'ok' && !S.dirty && el('label').value === '自检_改了');
      host.op('m4', () => Edit.setPoint(host, segs()[0], 1, [1062, 1450])); const dEdit = S.dirty; key('z', { ctrlKey: true }); const dUndo = S.dirty; key('y', { ctrlKey: true }); const dRedo = S.dirty; key('z', { ctrlKey: true });
      ok('S7 undo back to the saved state is clean again, redo away is dirty', dEdit && !dUndo && dRedo && !S.dirty, { dEdit, dUndo, dRedo });
      inflight = 0; maxIn = 0;
      host.op('m2', () => Edit.setPoint(host, segs()[0], 1, [1065, 1450]));
      const codes = await Promise.all([saveAsset(), saveAsset(), saveAsset()]);
      ok('S7 three concurrent saves serialized', maxIn === 1 && codes.every((c) => c === 'ok') && !S.dirty, { maxIn, codes });
      inflight = 0; maxIn = 0; host.op('m3', () => Edit.setPoint(host, segs()[0], 1, [1070, 1450]));
      await Promise.all([renameTo('zz_selftest_b'), saveAsset()]); tmpIds.push('zz_selftest_b'); API.post = op; await wait(150);
      const ids = (await API.json('/api/trajectories')).trajectories.map((a) => a.id);
      ok('S7 rename + save chained: single file, new id, clean', maxIn === 1 && S.doc.id === 'zz_selftest_b' && ids.includes('zz_selftest_b') && !ids.includes('zz_selftest_a') && !S.dirty, { ids });
      el('label').focus(); el('label').value = '自检_键'; el('label').dispatchEvent(new Event('input'));
      const evS = key('s', { ctrlKey: true }, el('label')); await wait(500);
      ok('S7 Ctrl+S inside an input saves', evS.defaultPrevented && !S.dirty && (await API.json('/api/trajectory?id=zz_selftest_b')).doc.label === '自检_键'); }
    // ---------------------------------------------------------------- S8 手势跨 doc
    { host.selectSegmentScope(0); host.beginTransform();
      window.__openTrajectory('coin_drop_demo'); ok('S8 external open refused mid-gesture', S.doc.id === 'zz_selftest_b' && el('status').textContent.includes('手势'));
      await openAsset('coin_drop_demo'); await wait(200);
      host.applyTransform(Edit.T.translate2(20, 0)); host.endTransform('移动');
      ok('S8 stale transform after doc switch is ignored', S.doc.id === 'coin_drop_demo' && JSON.stringify(S.doc) === coinJson && !S.dirty && !history.inDrag()); }
    // ---------------------------------------------------------------- S9 场景曲线只能在绑定场景打开 / 换时段进历史 / 相对曲线换背景不进历史 / 装载门 / envBroken
    { clearDirty(); await openAsset('zz_selftest_b'); await wait(200);
      const envState = () => ({ binding: S.doc.binding, doc: S.doc.authoring.sceneId, bg: S.doc.authoring.background, backdrop: S.backdrop, scene: S.scene && S.scene.id, sceneBg: S.scene && S.scene.background, sel: el('sceneSel').value, selDisabled: el('sceneSel').disabled, loading: S.loadingScene, busy: !el('busy').hidden, inert: el('app').inert, envBroken: S.envBroken, undo: history.undoStack.map((e) => e.label), status: el('status').textContent });
      // 场景曲线绑定作者场景：换到别的场景被拒（下拉禁用；脚本硬调也退回），数据、历史、脏标都不动
      await changeScene('河边', 'background.png').catch(() => {}); await wait(150);
      ok('S9 scene curve refuses another scene (bound to its author scene; dropdown disabled + snapped back, no history, clean)', S.doc.binding === 'scene' && S.doc.authoring.sceneId === '雾津街头' && S.scene.id === '雾津街头' && el('sceneSel').value === '雾津街头' && el('sceneSel').disabled && history.undoStack.length === 0 && !S.dirty && el('status').textContent.includes('只能在那里打开'), envState());
      // 换时段（同一场景另一张背景）可以：装载门升起、落地后进历史"换时段"
      API.json = async (path, o) => { if (path.startsWith('/api/scene?')) await wait(1200); return origAPI.json(path, o); };
      const pc = changeScene('雾津街头', 'background-night.png'); await wait(250);
      ok('S9 busy gate up while loading (inert, save refused, keys cancelled)', !el('busy').hidden && el('app').inert && (await saveAsset()) === 'skipped' && key('ArrowRight', { shiftKey: true }, el('bgSel')).defaultPrevented, envState());
      await pc; restoreAPI(); await wait(300);
      ok('S9 time-variant change lands consistently (scene kept, background follows, history 换时段)', S.doc.authoring.sceneId === '雾津街头' && S.doc.authoring.background === 'background-night.png' && S.scene.id === '雾津街头' && S.scene.background === 'background-night.png' && el('bgSel').value === 'background-night.png' && history.peekUndo() === '换时段' && el('busy').hidden && !el('app').inert, envState());
      key('z', { ctrlKey: true }); await wait(4500);
      ok('S9 undo reloads the previous background', S.doc.authoring.background === 'background.png' && S.scene.background === 'background.png' && el('bgSel').value === 'background.png', envState());
      key('y', { ctrlKey: true }); const t0 = performance.now(); while (performance.now() - t0 < 4) {} key('z', { ctrlKey: true }); await wait(6000);
      ok('S9 quick redo/undo ends consistent', S.doc.authoring.sceneId === S.scene.id && S.doc.authoring.background === S.scene.background && el('bgSel').value === S.scene.background && S.loadingScene === S.scene.id + '|' + (S.scene.background || ''), envState());
      const bg0 = S.doc.authoring.background;
      API.json = async (path, o) => { if (path.startsWith('/api/scene?') && path.includes(encodeURIComponent('background-night.png'))) throw new Error('模拟断连'); return origAPI.json(path, o); };
      await changeScene('雾津街头', 'background-night.png').catch(() => {}); restoreAPI(); await wait(200);
      ok('S9 failed background load rolls back doc/select/loadingScene', S.doc.authoring.background === bg0 && el('bgSel').value === bg0 && S.loadingScene === '雾津街头|' + (S.scene.background || '') && el('status').textContent.includes('失败'), envState());
      if (bg0 !== 'background.png') { await changeScene('雾津街头', 'background.png'); await wait(200); }
      // 改成相对曲线：数据里的场景绑定丢掉（当前场景变成背景），下拉解禁，进历史一笔
      clearDirty(); el('binding').value = 'free'; el('binding').dispatchEvent(new Event('change')); await wait(100);
      ok('S9 binding → free drops the scene from the data (backdrop = the scene it was on), enables the dropdown, one history entry', S.doc.binding === 'free' && !S.doc.authoring.sceneId && !S.doc.authoring.background && S.backdrop && S.backdrop.scene === '雾津街头' && !el('sceneSel').disabled && history.peekUndo() === '改成相对曲线' && S.dirty, envState());
      const nUndo = history.undoStack.length; clearDirty();
      el('sceneSel').value = '河边'; el('sceneSel').dispatchEvent(new Event('change')); await wait(4500);
      ok('S9 free curve: dropdown change swaps only the backdrop (data untouched, no history, stays clean)', S.backdrop.scene === '河边' && S.scene.id === '河边' && el('sceneSel').value === '河边' && !S.doc.authoring.sceneId && history.undoStack.length === nUndo && !S.dirty && el('busy').hidden, envState());
      API.json = async (path, o) => { if (path.startsWith('/api/scene?') && path.includes(encodeURIComponent('城门口'))) throw new Error('模拟断连'); return origAPI.json(path, o); };
      await changeScene('城门口', 'background.png').catch(() => {}); restoreAPI(); await wait(200);
      ok('S9 failed backdrop load rolls back backdrop/select/loadingScene', S.backdrop.scene === '河边' && el('sceneSel').value === '河边' && S.scene.id === '河边' && S.loadingScene === '河边|' + (S.scene.background || '') && el('status').textContent.includes('失败'), envState());
      // 撤销"改成相对曲线"：doc 回到绑定雾津街头，画布却在河边 → 重装；重装失败 → envBroken 门
      API.json = async (path, o) => { if (path.startsWith('/api/scene?')) throw new Error('模拟断连'); return origAPI.json(path, o); };
      key('z', { ctrlKey: true }); await wait(1200);
      ok('S9 undo back to a scene curve with the canvas elsewhere: failed reload raises the envBroken gate', !!S.envBroken && !el('busy').hidden && !el('busyRetry').hidden && (await saveAsset()) === 'skipped' && key('p').defaultPrevented && S.doc.binding === 'scene' && S.doc.authoring.sceneId === '雾津街头' && S.scene.id === '河边', envState());
      restoreAPI(); el('busyRetry').click(); await wait(4500);
      ok('S9 retry clears the gate and aligns canvas with doc (dropdown locked again)', !S.envBroken && el('busy').hidden && S.doc.authoring.sceneId === '雾津街头' && S.scene.id === '雾津街头' && el('sceneSel').value === '雾津街头' && el('sceneSel').disabled && el('binding').value === 'scene', envState());
      clearDirty(); }
    // ---------------------------------------------------------------- S10 世界空间（需要深度场景 + 新建对话框）
    if (S.scenes.some((s) => s.id === '雾津街头' && s.depth)) {
      clearDirty(); await refreshAssets();
      newAssetDialog(); await wait(200);
      const inputs = [...document.querySelectorAll('#modal input, #modal select')];
      inputs[0].value = 'zz_selftest_w'; inputs[2].value = 'world'; inputs[3].value = '雾津街头'; inputs[3].dispatchEvent(new Event('change'));
      [...document.querySelectorAll('#modal .btns button')].find((b) => b.textContent === '创建').click();
      for (let i = 0; i < 40 && !(S.doc && S.doc.id === 'zz_selftest_w' && S.cal && S.cal.shell); i++) await wait(250);
      ok('S10 world asset created with shell + heightfield', S.doc && S.doc.id === 'zz_selftest_w' && S.doc.space === 'world' && !!S.cal && !!S.cal.shell && !!S.cal.hf);
      el('entitySel').value = 'player'; el('entitySel').dispatchEvent(new Event('change')); await wait(600);
      const an = focusAnchor(); setTool('pen');
      for (const q of [[an.x + 60, an.y - 30], [an.x + 120, an.y - 60], [an.x + 180, an.y - 30]]) { const c = TC(q[0], q[1]); click(c[0], c[1], { altKey: true }); }
      key('Escape'); const seg = () => segs()[0]; const eff = () => host.effPoints(seg());
      host.op('h', () => { Edit.setPoint(host, seg(), 1, { h: 40 }); Edit.setPoint(host, seg(), 2, { h: 80 }); Edit.setPoint(host, seg(), 3, { h: 20 }); }); await settle();
      const maxH0 = Math.max(...S.bake.preview.world.map((w) => w[4]));
      ok('S10 world profile baked', eff().length === 4 && Math.abs(maxH0 - 80) < 1.5 && el('warnings').textContent === '', { maxH0, warn: el('warnings').textContent });
      host.selectPoint(1, false); let c = TC(eff()[1].sx, eff()[1].sy); drag(c[0], c[1] - 18, c[0], c[1] - 18 - 20);
      ok('S10 height handle raises by 20/cosθ', Math.abs(eff()[1].h - 40 - 20 / S.cal.cosTheta) < 1.5, eff()[1].h); key('z', { ctrlKey: true });
      // ---- S14 2D 原画视图里的 3D gizmo（世界空间资产：X / Y(h) / Z 三根轴 + XZ 贴地面片；单点即出现；点幽灵 = 整条）。
      // 2026-09-11 制作人："选中物体根本没有 gizmo / 第一次点击没有自动激活，要切换一下才看得到"——他在原画视图里选点。
      { host.selectPoint(2, false); v2.draw(); const g0 = v2._gizmo();
        ok('S14 world asset in 2D view: a single selected point gets X / Y(h) / Z gizmo with a ground plane', !!g0 && g0.dim === 3 && g0.n === 1 && g0.axes.length === 3 && !!g0.planes.xz && !g0.planes.yz && g0.axes.find((a) => a.k === 'z').offset, g0 && { axes: g0.axes.map((a) => a.k + (a.offset ? '(offset)' : '')), planes: Object.keys(g0.planes) });
        const along2 = (k, px) => { const g = v2._gizmo(); const t = g.tip[k], b = g.base[k]; const l = Math.hypot(t[0] - b[0], t[1] - b[1]); const d = [(t[0] - b[0]) / l, (t[1] - b[1]) / l]; const s = [b[0] + d[0] * l * 0.62, b[1] + d[1] * l * 0.62]; return [R(s[0]), R(s[1]), R(s[0] + d[0] * px), R(s[1] + d[1] * px)]; };
        let q0 = eff()[2], a = along2('x', 20); drag(a[0], a[1], a[2], a[3]); let q1 = eff()[2];
        ok('S14 2D X arrow moves only world x', Math.abs(q1.x - q0.x) > 1 && Math.abs(q1.z - q0.z) < 1e-6 && Math.abs(q1.h - q0.h) < 1e-6 && history.peekUndo() === '移动', { dx: +(q1.x - q0.x).toFixed(2), dz: +(q1.z - q0.z).toFixed(2), dh: +(q1.h - q0.h).toFixed(2), undo: history.peekUndo() });
        q0 = eff()[2]; a = along2('z', 20); drag(a[0], a[1], a[2], a[3]); q1 = eff()[2];
        ok('S14 2D Z arrow (drawn offset because it overlaps Y on the artwork) moves only world z', Math.abs(q1.z - q0.z) > 1 && Math.abs(q1.x - q0.x) < 1e-6 && Math.abs(q1.h - q0.h) < 1e-6, { dz: +(q1.z - q0.z).toFixed(2), dx: +(q1.x - q0.x).toFixed(2), dh: +(q1.h - q0.h).toFixed(2) });
        q0 = eff()[2]; a = along2('y', 20); drag(a[0], a[1], a[2], a[3], { ctrlKey: true }); q1 = eff()[2];
        const dhs = q1.h - q0.h;
        ok('S14 2D Y arrow with Ctrl snaps h to 10 wu and moves only h', Math.abs(dhs) > 1 && Math.abs(dhs / 10 - Math.round(dhs / 10)) < 1e-6 && Math.abs(q1.x - q0.x) < 1e-6 && Math.abs(q1.z - q0.z) < 1e-6, { dh: +dhs.toFixed(2) });
        q0 = eff()[2]; { const g = v2._gizmo(); const pl = g.planes.xz.poly; const cx = pl.reduce((s, p) => s + p[0], 0) / 4, cy = pl.reduce((s, p) => s + p[1], 0) / 4; drag(R(cx), R(cy), R(cx) + 12, R(cy) - 6); } q1 = eff()[2];
        ok('S14 2D XZ plane drags along the ground keeping h', Math.hypot(q1.x - q0.x, q1.z - q0.z) > 1 && Math.abs(q1.h - q0.h) < 1e-6, { dx: +(q1.x - q0.x).toFixed(2), dz: +(q1.z - q0.z).toFixed(2), dh: +(q1.h - q0.h).toFixed(2) });
        host.selectPoints([1, 2], false); setGizmoMode('rotate'); v2.draw(); const gr = v2._gizmo();
        const d12 = () => { const e = eff(); return Math.hypot(e[1].x - e[2].x, e[1].z - e[2].z); };
        const dd0 = d12(); const rp = gr.ring[0], rq = gr.ring[6]; drag(R(rp[0]), R(rp[1]), R(rq[0]), R(rq[1])); const dd1 = d12();
        ok('S14 2D ring rotates two points about their centroid (distance kept)', !!gr.ring && Math.abs(dd1 - dd0) < 0.1 && history.peekUndo() === '旋转', { dd0: +dd0.toFixed(2), dd1: +dd1.toFixed(2), undo: history.peekUndo() });
        setGizmoMode('move');
        for (let i = 0; i < 5; i++) key('z', { ctrlKey: true });   // 撤掉 x / z / h / 面片 / 旋转
        await settle(); host.clearSelection(); S.tMs = 0; v2.draw(); const gr0 = v2._ghostRect();
        if (gr0) { click(R((gr0.x0 + gr0.x1) / 2), R((gr0.y0 + gr0.y1) / 2)); const ga = v2._gizmo();
          ok('S14 clicking the ghost selects the whole trajectory with the gizmo over the curve start', S.sel.scope === 'all' && !!ga && Math.abs(ga.c[0] - TC(...Edit.originScreen(host))[0]) < 2, { scope: S.sel.scope, n: S.sel.points.size }); }
        else log.push('SKIP S14 ghost (no ghost drawn)');
        host.clearSelection(); }
      const hStored = seg().path.points.map((p) => p.h);
      el('sceneSel').value = '河边'; el('sceneSel').dispatchEvent(new Event('change')); await wait(5000); await settle();
      const maxH1 = S.bake ? Math.max(...S.bake.preview.world.map((w) => w[4])) : -1;
      ok('S10 scene change keeps the height profile (stored h untouched, bake intact, no warnings)', JSON.stringify(seg().path.points.map((p) => p.h)) === JSON.stringify(hStored) && Math.abs(maxH1 - 80) < 1.5 && el('warnings').textContent === '', { maxH1, warn: el('warnings').textContent, scene: S.scene.id });
      key('z', { ctrlKey: true }); await wait(4500); await settle();
      setTool('physics'); const t0 = TC(an.x - 120, an.y + 30); const t1 = [t0[0] - 40, t0[1] + 10]; drag(t0[0], t0[1], t1[0], t1[1]);
      const ps = segs()[1]; const pi = ps && host.physicsInfo(ps); const sm = v2.toScene(t1[0], t1[1]); const g = S.cal.sceneToWorldGround(sm[0], sm[1]);
      ok('S10 world physics landing = ground pick under mouse', ps && ps.kind === 'physics' && pi && !pi.grounded && Math.abs(pi.landingW[0] - g[0]) < 1.5 && Math.abs(pi.landingW[2] - g[2]) < 1.5 && S.tool === 'select', { kind: ps && ps.kind, landingW: pi && pi.landingW.map(R), g: g.map(R), grounded: pi && pi.grounded, v0: ps && ps.v0, scene: S.scene.id });
      const rc = await saveAsset(); tmpIds.push('zz_selftest_w'); await wait(150);
      const back = await API.json('/api/trajectory?id=zz_selftest_w');
      ok('S10 world file round trip', rc === 'ok' && back.doc.space === 'world' && back.doc.worldKeyframes.length === back.doc.keyframes.length && !!back.doc.authoring.originWorld && !!back.doc.authoring.origin && back.doc.binding === 'scene' && back.doc.authoring.entity.kind === 'player');
      if (v3 && v3.ok) {
        setView('3d'); await wait(60); v3.resize(); v3.fitCurve(); host.selectSegment(0); v3.draw(); const c3 = el('view3d');
        const pr = v3.project(eff()[2].pos);
        ok('S10 3D projects and hit-tests a point', !!pr && v3._hit(pr[0], pr[1]) && v3._hit(pr[0], pr[1]).kind === 'point');
        const w0 = eff()[2]; drag(R(pr[0]), R(pr[1]), R(pr[0]) + 15, R(pr[1]), {}, c3); const w1 = eff()[2];
        ok('S10 3D drag moves point in xz and keeps h', Math.hypot(w1.x - w0.x, w1.z - w0.z) > 1 && Math.abs(w1.h - w0.h) < 1e-6 && history.peekUndo() === '移动控制点');
        key('z', { ctrlKey: true });

        // ---- S11 投影判据：画面不能是镜像的。镜像**一处都不报错**（投影与拾取共用同一个 mvp 及其逆，
        // 所以自洽），只有钉住"世界的右 → 屏幕的右"才抓得住。2026-09-08 声学工作台、2026-09-10 这里
        // 各被制作人抓到一次，两次都是右手 lookAt 画左手系 M-world。见 common.js lookAt 注释。
        const cam0 = Object.assign({}, v3.cam);
        const cal3 = host.cal, base = eff()[2].pos;
        const proj = (p) => v3.project(p);
        const step = (v, k) => [base[0] + v[0] * k, base[1] + v[1] * k, base[2] + v[2] * k];
        // (a) 相机自身的右：任何朝向都必须投到屏幕 x 增大——直接钉 lookAt 与相机基同手性
        const sB = proj(base), sR = proj(step(v3._right(), 60));
        ok('S11 camera right projects to screen +x (lookAt handedness)', !!sB && !!sR && sR[0] - sB[0] > 1, { dx: sR && sB ? +(sR[0] - sB[0]).toFixed(2) : null });
        // (b) 相机对准原画视线时，原画的右/上必须与屏幕同向（不是镜像）
        const rw = cal3.rows, vd = norm3([rw[2], rw[5], rw[8]]);   // q 的 +z 过 R = "进画"方向
        v3.cam.yaw = Math.atan2(vd[0], vd[2]); v3.cam.pitch = Math.asin(Math.max(-1, Math.min(1, -vd[1])));
        const aB = proj(base), aR = proj(step(cal3.screenRightWorld(), 60)), aU = proj(step(cal3.screenUpWorld(), 60));
        ok('S11 artwork right/up are not mirrored in the 3D view', !!aB && !!aR && !!aU && aR[0] - aB[0] > 1 && aU[1] - aB[1] < -1,
          { dxRight: aR && aB ? +(aR[0] - aB[0]).toFixed(2) : null, dyUp: aU && aB ? +(aU[1] - aB[1]).toFixed(2) : null });
        Object.assign(v3.cam, cam0); v3.draw();

        // ---- S13 Unity 式相机与变换 gizmo（2026-09-10 制作人打回"怎么移动相机 / 怎么自由挪点"后重做）。
        // 相机：右键环视（机位不动）、右键+键飞行（键不漏给快捷键表）、Alt+左键环绕（目标不动）、中键平移、
        // 滚轮朝光标缩放（光标下的点不动）、坐标架一键正交视角；gizmo：单轴 / 吸附 / 旋转 / 缩放 / F 对准 / 框选。
        const c3r = () => el('view3d');
        const camA = Object.assign({}, v3.cam);
        const eye0 = v3._eye();
        drag(200, 200, 260, 200, { button: 2, buttons: 2 }, c3r());
        const eye1 = v3._eye();
        ok('S13 right-drag looks around: eye fixed, yaw changed, fly mode released', Math.hypot(eye1[0] - eye0[0], eye1[1] - eye0[1], eye1[2] - eye0[2]) < 1e-3 && Math.abs(v3.cam.yaw - camA.yaw) > 0.1 && !v3.fly, { dyaw: +(v3.cam.yaw - camA.yaw).toFixed(3) });
        Object.assign(v3.cam, camA);
        const eyeB = v3._eye();
        ev('mousedown', 200, 200, { button: 2, buttons: 2 }, c3r());
        key('e', { code: 'KeyE' });   // 按住右键时 E = 上升，不是"旋转 gizmo"
        v3._flyStep(0.2);
        const eyeC = v3._eye();
        ev('mouseup', 200, 200, { button: 2, buttons: 0 }, c3r());
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyE', key: 'e', bubbles: true }));
        ok('S13 right-button + E flies up and the key is not taken as a shortcut', eyeC[1] - eyeB[1] > 10 && S.gizmoMode === 'move' && S.tool === 'select' && !v3.fly && v3.keys.size === 0, { dy: R(eyeC[1] - eyeB[1]), mode: S.gizmoMode, tool: S.tool });
        Object.assign(v3.cam, camA); const selN = S.sel.points.size;
        drag(200, 200, 260, 200, { altKey: true }, c3r());
        ok('S13 Alt+left orbits: target fixed, yaw changed, selection untouched', Math.abs(v3.cam.tx - camA.tx) < 1e-6 && Math.abs(v3.cam.tz - camA.tz) < 1e-6 && Math.abs(v3.cam.yaw - camA.yaw) > 0.1 && S.sel.points.size === selN, { dyaw: +(v3.cam.yaw - camA.yaw).toFixed(3), sel: S.sel.points.size, selN });
        Object.assign(v3.cam, camA);
        drag(200, 200, 260, 220, { button: 1, buttons: 4 }, c3r());
        ok('S13 middle-drag pans: target moved, orientation kept', Math.hypot(v3.cam.tx - camA.tx, v3.cam.ty - camA.ty, v3.cam.tz - camA.tz) > 1 && Math.abs(v3.cam.yaw - camA.yaw) < 1e-9 && Math.abs(v3.cam.pitch - camA.pitch) < 1e-9);
        Object.assign(v3.cam, camA); v3.draw();
        const zx = R(c3r().clientWidth * 0.55), zy = R(c3r().clientHeight * 0.6);
        const pz = v3.pickGround(zx, zy);
        if (pz) {
          const s0 = v3.project(pz); const rr = c3r().getBoundingClientRect();
          c3r().dispatchEvent(new WheelEvent('wheel', { deltaY: -400, clientX: rr.left + zx, clientY: rr.top + zy, bubbles: true, cancelable: true }));
          const s1 = v3.project(pz);
          ok('S13 wheel zooms toward the cursor (picked ground point stays put on screen)', !!s0 && !!s1 && Math.hypot(s1[0] - s0[0], s1[1] - s0[1]) < 1.5 && v3.cam.dist < camA.dist, { shift: s0 && s1 ? +Math.hypot(s1[0] - s0[0], s1[1] - s0[1]).toFixed(2) : null, dist: R(v3.cam.dist) });
        } else log.push('SKIP S13 zoom (no ground under probe pixel)');
        Object.assign(v3.cam, camA); v3.draw();
        const lay = v3._sceneGizmoLayout(); const armY = lay.arms.find((a) => a.axis === 'y' && a.sign > 0);
        click(R(armY.x), R(armY.y), {}, c3r());
        const gp = v3.pickGround(R(c3r().clientWidth / 2), R(c3r().clientHeight / 2));
        ok('S13 scene gizmo Y arm → orthographic top view that still picks the ground', v3.cam.ortho && v3.cam.pitch > 1.5 && !!gp, { pitch: +v3.cam.pitch.toFixed(3), ortho: v3.cam.ortho, gp: gp && gp.map(R) });
        const lay2 = v3._sceneGizmoLayout(); click(R(lay2.ox), R(lay2.oy), {}, c3r());
        ok('S13 scene gizmo center toggles back to perspective', !v3.cam.ortho);
        Object.assign(v3.cam, camA); v3.fitCurve();
        // gizmo：单点 → 移动；X 箭头只动 x、Y 箭头只动 h、Ctrl+Z 箭头吸附 10 wu
        host.selectSegment(0); host.selectPoint(2, false); setGizmoMode('move'); v3.draw();
        const gz1 = v3._gizmo();
        ok('S13 move gizmo appears at the selected point', !!gz1 && gz1.mode === 'move' && Math.hypot(gz1.pivot[0] - eff()[2].pos[0], gz1.pivot[2] - eff()[2].pos[2]) < 1e-6 && Object.keys(gz1.planes).length === 3, { mode: gz1 && gz1.mode, planes: gz1 && Object.keys(gz1.planes) });
        const along = (k, px) => { const g = v3._gizmo(); const t = g.tip[k], c = g.c; const l = Math.hypot(t[0] - c[0], t[1] - c[1]); const d = [(t[0] - c[0]) / l, (t[1] - c[1]) / l]; const s = [c[0] + d[0] * l * 0.62, c[1] + d[1] * l * 0.62]; return [R(s[0]), R(s[1]), R(s[0] + d[0] * px), R(s[1] + d[1] * px)]; };
        let p0 = eff()[2], a = along('x', 30); drag(a[0], a[1], a[2], a[3], {}, c3r()); let p1 = eff()[2];
        ok('S13 X arrow moves only x', Math.abs(p1.x - p0.x) > 1 && Math.abs(p1.z - p0.z) < 1e-6 && Math.abs(p1.h - p0.h) < 1e-6 && history.peekUndo() === '移动', { dx: +(p1.x - p0.x).toFixed(2), dz: +(p1.z - p0.z).toFixed(2), dh: +(p1.h - p0.h).toFixed(2), undo: history.peekUndo() });
        p0 = eff()[2]; a = along('y', 30); drag(a[0], a[1], a[2], a[3], {}, c3r()); p1 = eff()[2];
        ok('S13 Y arrow moves only h', Math.abs(p1.h - p0.h) > 1 && Math.abs(p1.x - p0.x) < 1e-6 && Math.abs(p1.z - p0.z) < 1e-6, { dh: +(p1.h - p0.h).toFixed(2) });
        p0 = eff()[2]; a = along('z', 30); drag(a[0], a[1], a[2], a[3], { ctrlKey: true }, c3r()); p1 = eff()[2];
        const dzs = p1.z - p0.z;
        ok('S13 Ctrl+drag Z arrow snaps to 10 wu and moves only z', Math.abs(dzs) > 1 && Math.abs(dzs / 10 - Math.round(dzs / 10)) < 1e-6 && Math.abs(p1.x - p0.x) < 1e-6 && Math.abs(p1.h - p0.h) < 1e-6, { dz: +dzs.toFixed(2) });
        // 两点 → 旋转环（绕质心，距离不变）/ 缩放中心（等比）
        host.selectPoints([1, 2], false); setGizmoMode('rotate'); v3.draw();
        const gz2 = v3._gizmo();
        ok('S13 rotate gizmo shows a ring for two points', !!gz2 && gz2.mode === 'rotate' && !!gz2.ring && gz2.ring.length === 48);
        const dist12 = () => { const e = eff(); return Math.hypot(e[1].x - e[2].x, e[1].z - e[2].z); };
        const q0 = eff().map((p) => [p.x, p.z]), d0 = dist12();
        const rp = gz2.ring[0], rq = gz2.ring[6];
        drag(R(rp[0]), R(rp[1]), R(rq[0]), R(rq[1]), {}, c3r());
        const q1 = eff().map((p) => [p.x, p.z]), d1 = dist12();
        ok('S13 ring drag rotates the two points about their centroid (distance kept, positions changed)', Math.abs(d1 - d0) < 0.1 && Math.hypot(q1[1][0] - q0[1][0], q1[1][1] - q0[1][1]) > 1 && history.peekUndo() === '旋转', { d0: +d0.toFixed(2), d1: +d1.toFixed(2), undo: history.peekUndo() });
        setGizmoMode('scale'); v3.draw();
        const gz3 = v3._gizmo(); const d2 = dist12();
        drag(R(gz3.c[0]), R(gz3.c[1]), R(gz3.c[0]) + 40, R(gz3.c[1]) - 40, {}, c3r());
        const d3 = dist12();
        ok('S13 scale gizmo center scales uniformly about the centroid', !!gz3 && gz3.mode === 'scale' && d3 > d2 * 1.2 && history.peekUndo() === '缩放', { d2: +d2.toFixed(2), d3: +d3.toFixed(2), undo: history.peekUndo() });
        // 纯点一下 gizmo 不算编辑
        const undoN = history.peekUndo(); const dirtyG = S.dirty; const gz3b = v3._gizmo();
        click(R(gz3b.c[0]), R(gz3b.c[1]), {}, c3r());
        ok('S13 clicking a gizmo handle without dragging is not an edit', history.peekUndo() === undoN && S.dirty === dirtyG, { undo: history.peekUndo() });
        // F 对准选中；整段范围也有 gizmo
        host.selectPoint(2, false); setGizmoMode('move'); key('f');
        ok('S13 F frames the selection (camera target = selected point)', Math.abs(v3.cam.tx - eff()[2].pos[0]) < 1e-6 && Math.abs(v3.cam.tz - eff()[2].pos[2]) < 1e-6 && v3.cam.dist < 1000, { dist: R(v3.cam.dist) });
        host.selectSegmentScope(0); v3.draw();
        const gz4 = v3._gizmo();
        const st4 = (() => { const sg = segs()[0]; if (Edit.isPinned(S.doc, sg) || sg.kind === 'physics') return Edit.segStartWorld(host, sg); const ps = Edit.effPointsWorld(host, sg); const c = [0, 0, 0]; for (const p of ps) for (let k = 0; k < 3; k++) c[k] += p.pos[k] / ps.length; return c; })();
        ok('S13 segment scope gets a gizmo on the segment itself (start when pinned / physics, else the centroid of its points; never floating above) with a label', !!gz4 && gz4.n === 2 && gz4.mode === 'move' && Math.hypot(gz4.pivot[0] - st4[0], gz4.pivot[1] - st4[1], gz4.pivot[2] - st4[2]) < 1e-6 && gz4.label.startsWith('整段'), gz4 && { label: gz4.label, pivot: gz4.pivot.map(R), want: st4.map(R) });
        // 抛体把手在 3D 里也有 gizmo：落点 = X / Z + 贴地面片；锚点工具 = 重定锚点（曲线不动）
        if (segs()[1] && segs()[1].kind === 'physics') {
          host.selectSegmentScope(1); v3.fitCurve(); v3.draw();
          const pi5 = host.physicsInfo(segs()[1]); const lc = v3.project(pi5.landingW);
          if (lc && !pi5.grounded) {
            click(R(lc[0]), R(lc[1]), {}, c3r()); const gl = v3._gizmo();
            ok('S13 clicking the landing selects it with an X / Z + XZ gizmo on the landing point', S.sel.handle === 'landing' && !!gl && gl.axes.map((a) => a.k).join() === 'x,z' && !!gl.planes.xz && gl.label === '落点', { handle: S.sel.handle, axes: gl && gl.axes.map((a) => a.k) });
            const L0 = pi5.landingW.slice(); const ax = gl.tip.x, cx = gl.c;
            // 沿轴找一处真抓到 X 轴的位置：小目标（起点 / 箭尖 / 锚点）优先于轴，固定比例处可能正压着别的把手
            let s5 = null, hf = null;
            for (const f of [0.62, 0.45, 0.8, 0.3, 0.9]) { const p = [R(cx[0] + (ax[0] - cx[0]) * f), R(cx[1] + (ax[1] - cx[1]) * f)]; const hh = v3._hit(p[0], p[1]); if (hh && hh.kind === 'gz' && hh.part === 'x') { s5 = p; hf = f; break; } }
            if (s5) {
              drag(s5[0], s5[1], s5[0] + 20, s5[1], {}, c3r());   // ⚠ 3D 的手势必须把 c3r() 传给 drag：缺省目标是 2D 画布，事件根本到不了 3D 视图
              const L1 = host.physicsInfo(segs()[1]).landingW;
              ok('S13 landing gizmo X arrow moves the landing along world x only', Math.abs(L1[0] - L0[0]) > 1 && Math.abs(L1[2] - L0[2]) < 1.5 && history.peekUndo() === '移动落点', { dx: +(L1[0] - L0[0]).toFixed(2), dz: +(L1[2] - L0[2]).toFixed(2), undo: history.peekUndo(), f: hf });
            } else ok('S13 landing gizmo X arrow is grabbable somewhere along its length', false, { hits: [0.62, 0.45, 0.8, 0.3, 0.9].map((f) => v3._hit(R(cx[0] + (ax[0] - cx[0]) * f), R(cx[1] + (ax[1] - cx[1]) * f))) });
            key('z', { ctrlKey: true });
          } else log.push('SKIP S13 landing gizmo (landing not visible)');
          host.selectSegment(0);
        }
        { const p0s = eff().map((p) => p.pos.slice()); const n0 = Edit.slots(S.doc).length;
          v3.fitCurve(); v3.draw();
          const ow = Edit.originWorld(host); const oc = ow ? v3.project([ow[0] + 80, S.cal.groundHeight(ow[0] + 80, ow[2] + 40), ow[2] + 40]) : null;   // 起点旁 80/40 wu 的地面点：行走面里，往返对得上
          const probe = oc ? [R(oc[0]), R(oc[1])] : [R(c3r().clientWidth * 0.3), R(c3r().clientHeight * 0.7)];
          const gp = v3.pickGround(probe[0], probe[1]);
          if (gp) { setTool('slot'); click(probe[0], probe[1], {}, c3r()); const p1s = eff().map((p) => p.pos);
            const sl = Edit.slots(S.doc)[n0]; const gw = sl ? Edit.slotWorld(host, sl) : null;
            const maxMove = Math.max(...p1s.map((p, k) => Math.hypot(p[0] - p0s[k][0], p[1] - p0s[k][1], p[2] - p0s[k][2])));
            ok('S13 slot tool in 3D places a slot at the picked ground point; curve untouched; slot has a gizmo', !!sl && !!gw && Math.hypot(gw[0] - gp[0], gw[2] - gp[2]) < 1.5 && maxMove < 1e-6 && S.sel.handle === 'slot:' + sl.id && !!v3._gizmo() && v3._gizmo().axes.map((a) => a.k).join() === 'x,z' && S.tool === 'select', { slot: sl, gp: gp.map(R), maxMove, handle: S.sel.handle });
            key('z', { ctrlKey: true }); }
          else log.push('SKIP S13 slot tool (no ground under probe pixel)'); }
        // 左键空白拖 = 框选；点空白 = 清选择
        host.clearSelection(); v3.fitCurve(); v3.draw();
        const ps3 = eff().map((p) => v3.project(p.pos)).filter(Boolean);
        const H3 = c3r().clientHeight;
        drag(4, H3 - 4, R(Math.max(...ps3.map((p) => p[0]))) + 12, R(Math.min(...ps3.map((p) => p[1]))) - 30, {}, c3r());
        ok('S13 plain left-drag on empty space box-selects', S.sel.points.size === eff().length && S.sel.scope === 'points', { n: S.sel.points.size, total: eff().length });
        click(4, H3 - 4, {}, c3r());
        ok('S13 click on empty space clears the selection', S.sel.points.size === 0);
        for (let i = 0; i < 5; i++) key('z', { ctrlKey: true });   // 撤掉 S13 的五笔（x / h / z / 旋转 / 缩放）
        setGizmoMode('move');
        Object.assign(v3.cam, cam0); v3.draw();
        setView('2d');
      } else log.push('SKIP S10 3D (no WebGL2 offscreen)');
      // ---- S12 对齐判据：工作台的坐标 == 游戏运行时的坐标。拿运行时打来的那份 TS 原样跑，
      // 不是"照着写的"。地面点管"作者点的那里"，投影管"预览的形状 == 开播的形状"。
      // 纯数学，不吃 WebGL，所以在 3D 门外面跑。
      {
        const a = S.align;
        ok('S12 runtime bundle loaded (sceneSpace + trajectoryProjection)',
          !!(S.runtime && S.runtime.sceneSpace && S.runtime.trajectoryProjection), { err: S.bundleErr || null });
        ok('S12 workbench world == runtime world (ground pick + playback projection)',
          !!a && a.ok, a);
      }
    } else log.push('SKIP S10 world (雾津街头 has no depth)');
  } catch (e) { log.push('EXC ' + (e && e.stack || e)); }
  finally {
    restoreAPI();
    try {
      clearDirty(); dropGestures(); setEnvBroken(null);
      for (const id of tmpIds) await origAPI.post('/api/delete', { id }).catch(() => ({}));
      await refreshAssets(); await openAsset('coin_drop_demo'); await wait(200);
      ok('Z cleanup: temp assets deleted, coin identical', S.assets.every((a) => !a.id.startsWith('zz_selftest_')) && JSON.stringify(S.doc) === coinJson && !S.dirty, S.assets.map((a) => a.id));
    } catch (e) { log.push('EXC cleanup ' + (e && e.stack || e)); }
    window.__selftestResult = log.join('\n');
  }
})();
