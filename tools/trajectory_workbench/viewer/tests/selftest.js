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
  const focusAnchor = () => { const an = S.doc.authoring.anchor; v2.zoom = 1; v2.ox = c2().clientWidth / 2 - an.x; v2.oy = c2().clientHeight / 2 - an.y; v2.draw(); return an; };
  const tmpIds = [];
  const mkScreen = async (id) => {
    const doc = { id, label: '自检', space: 'screen', keyframes: [], source: { segments: [
      { id: 'm1', kind: 'manual', startFrom: 'anchor', path: { points: [{ x: 975.1, y: 1491.9 }, { x: 1055, y: 1450 }, { x: 1140, y: 1470 }] }, timing: { durationMs: 800, keys: [{ atMs: 0, progress: 0 }, { atMs: 800, progress: 1 }] } },
      { id: 'p1', kind: 'physics', startFrom: 'previous', v0: { x: -100, y: -200 }, gravity: 1500, groundY: 1500 }] },
      authoring: { sceneId: '雾津街头', background: 'background.png', anchor: { x: 975.1, y: 1491.9 }, contactOffsetY: 0 } };
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
      host.selectSegmentScope(1); const c = TC(S.doc.authoring.anchor.x, S.doc.authoring.anchor.y); click(c[0] + 300, c[1] + 300);
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
      let gg = v2._gizmoGeom(); const before = [...S.sel.points].sort().map((i) => host.effPoints(segs()[0])[i].sx);
      drag(R(gg.move[0]), R(gg.move[1]), R(gg.move[0]) + 12, R(gg.move[1]));
      const after = [...S.sel.points].sort().map((i) => host.effPoints(segs()[0])[i].sx);
      ok('S4 gizmo move', after.every((v, k) => Math.abs(v - before[k] - 12) < 0.6) && history.peekUndo() === '移动');
      key('z', { ctrlKey: true });
      let dirty0 = S.dirty, undo0 = history.undoStack.length, doc0 = JSON.stringify(S.doc);
      gg = v2._gizmoGeom(); ev('mousedown', R(gg.move[0]), R(gg.move[1])); ev('mousemove', R(gg.move[0]) + 1, R(gg.move[1])); ev('mouseup', R(gg.move[0]) + 1, R(gg.move[1]));
      ok('S4 1px jitter is not an edit', S.dirty === dirty0 && history.undoStack.length === undo0 && JSON.stringify(S.doc) === doc0);
      host.selectSegmentScope(0); gg = v2._gizmoGeom(); const p0 = host.effPoints(segs()[0]).map((p) => [p.sx, p.sy]);
      drag(R(gg.move[0]), R(gg.move[1]), R(gg.move[0]) + 20, R(gg.move[1]) + 10);
      const p1 = host.effPoints(segs()[0]).map((p) => [p.sx, p.sy]);
      ok('S4 whole-segment move promotes pinned start and moves every point', segs()[0].startFrom === 'explicit' && p1.every((p, k) => Math.abs(p[0] - p0[k][0] - 20) < 0.6 && Math.abs(p[1] - p0[k][1] - 10) < 0.6) && el('status').textContent.includes('自定'), { startFrom: segs()[0].startFrom, d: p1.map((p, k) => [R(p[0] - p0[k][0]), R(p[1] - p0[k][1])]) });
      key('z', { ctrlKey: true }); ok('S4 undo restores pinned start', segs()[0].startFrom === 'anchor');
      dirty0 = S.dirty; undo0 = history.undoStack.length; doc0 = JSON.stringify(S.doc);
      host.setScope('segment'); el('txDx').value = '0'; el('txDy').value = '0'; applyNumericTransform('move'); el('txRot').value = '0'; applyNumericTransform('rot'); el('txScale').value = '1'; applyNumericTransform('scale');
      ok('S4 zero numeric transforms are no-ops', S.dirty === dirty0 && history.undoStack.length === undo0 && JSON.stringify(S.doc) === doc0 && segs()[0].startFrom === 'anchor');
      host.setScope('all'); const an0 = Object.assign({}, S.doc.authoring.anchor); el('txDx').value = '40'; el('txDy').value = '-20'; applyNumericTransform('move');
      ok('S4 whole-trajectory translate moves the anchor', S.doc.authoring.anchor.x === an0.x + 40 && S.doc.authoring.anchor.y === an0.y - 20);
      key('z', { ctrlKey: true }); host.clearSelection();
      const ac = TC(an0.x, an0.y); drag(ac[0], ac[1], ac[0] + 30, ac[1]);
      ok('S4 anchor drag moves anchor and curve follows', Math.abs(S.doc.authoring.anchor.x - an0.x - 30) < 0.6 && Math.abs(host.effPoints(segs()[0])[0].sx - an0.x - 30) < 0.6);
      key('z', { ctrlKey: true });
      host.selectSegment(0); pts = host.effPoints(segs()[0]); c = TC(pts[2].sx, pts[2].sy);
      ev('mousedown', c[0], c[1], { button: 2, buttons: 2 }); ev('mouseup', c[0], c[1], { button: 2, buttons: 0 });
      ok('S4 right-click deletes a point', segs()[0].path.points.length === 2); key('z', { ctrlKey: true }); ok('S4 undo delete', segs()[0].path.points.length === 3);
      key('Delete'); ok('S4 Delete with no selection on manual only hints', segs()[0].path.points.length === 3 && el('status').textContent.includes('没有选中'));
      host.selectSegment(1); key('Delete'); ok('S4 Delete on physics with points scope only hints', segs().length === 2 && el('status').textContent.includes('整段')); }
    // ---------------------------------------------------------------- S5 抛体把手
    { host.selectSegmentScope(1); const seg1 = () => segs()[1]; let pi = host.physicsInfo(seg1());
      const L = TC(pi.landing[0], pi.landing[1]); const lx0 = pi.landing[0]; drag(L[0], L[1], L[0] + 30, L[1]); pi = host.physicsInfo(seg1());
      ok('S5 landing drag keeps vy and moves landing', Math.abs(pi.landing[0] - lx0 - 30) < 1.5 && seg1().v0.y === -200, { landing: pi.landing.map(R) });
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
    // ---------------------------------------------------------------- S9 换场景 / 撤销重做 / 装载门 / envBroken
    { clearDirty(); await openAsset('zz_selftest_b'); await wait(200);
      API.json = async (path, o) => { if (path.startsWith('/api/scene?')) await wait(1200); return origAPI.json(path, o); };
      const pc = changeScene('河边', 'background.png'); await wait(250);
      ok('S9 busy gate up while loading (inert, save refused, keys cancelled)', !el('busy').hidden && el('app').inert && (await saveAsset()) === 'skipped' && key('ArrowRight', { shiftKey: true }, el('sceneSel')).defaultPrevented);
      await pc; restoreAPI(); await wait(300);
      const envState = () => ({ doc: S.doc.authoring.sceneId, scene: S.scene && S.scene.id, sel: el('sceneSel').value, loading: S.loadingScene, busy: !el('busy').hidden, inert: el('app').inert, envBroken: S.envBroken, undo: history.undoStack.map((e) => e.label), status: el('status').textContent });
      ok('S9 scene changed consistently', S.doc.authoring.sceneId === '河边' && S.scene.id === '河边' && el('sceneSel').value === '河边' && el('busy').hidden && !el('app').inert, envState());
      key('z', { ctrlKey: true }); await wait(4500);
      ok('S9 undo reloads the previous scene', S.doc.authoring.sceneId === '雾津街头' && S.scene.id === '雾津街头' && el('sceneSel').value === '雾津街头', envState());
      key('y', { ctrlKey: true }); const t0 = performance.now(); while (performance.now() - t0 < 4) {} key('z', { ctrlKey: true }); await wait(6000);
      ok('S9 quick redo/undo ends consistent', S.doc.authoring.sceneId === S.scene.id && el('sceneSel').value === S.scene.id && S.loadingScene === S.scene.id + '|' + (S.scene.background || ''), envState());
      const sid0 = S.doc.authoring.sceneId;
      API.json = async (path, o) => { if (path.startsWith('/api/scene?') && path.includes(encodeURIComponent('城门口'))) throw new Error('模拟断连'); return origAPI.json(path, o); };
      await changeScene('城门口', 'background.png').catch(() => {}); restoreAPI(); await wait(200);
      ok('S9 failed scene load rolls back doc/select/loadingScene', S.doc.authoring.sceneId === sid0 && el('sceneSel').value === sid0 && S.loadingScene === sid0 + '|' + (S.scene.background || '') && el('status').textContent.includes('失败'), envState());
      if (sid0 !== '雾津街头') { await changeScene('雾津街头', 'background.png'); await wait(200); }
      clearDirty(); el('sceneSel').value = '河边'; el('sceneSel').dispatchEvent(new Event('change')); await wait(4500);
      ok('S9 dropdown change lands on 河边', S.doc.authoring.sceneId === '河边' && S.scene.id === '河边' && history.peekUndo() === '换场景', envState());
      API.json = async (path, o) => { if (path.startsWith('/api/scene?')) throw new Error('模拟断连'); return origAPI.json(path, o); };
      key('z', { ctrlKey: true }); await wait(1200);
      ok('S9 failed undo-reload raises the envBroken gate', !!S.envBroken && !el('busy').hidden && !el('busyRetry').hidden && (await saveAsset()) === 'skipped' && key('p').defaultPrevented && S.doc.authoring.sceneId === '雾津街头' && S.scene.id === '河边', envState());
      restoreAPI(); el('busyRetry').click(); await wait(4500);
      ok('S9 retry clears the gate and aligns canvas with doc', !S.envBroken && el('busy').hidden && S.doc.authoring.sceneId === '雾津街头' && S.scene.id === '雾津街头' && el('sceneSel').value === '雾津街头', envState());
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
      ok('S10 world file round trip', rc === 'ok' && back.doc.space === 'world' && back.doc.worldKeyframes.length === back.doc.keyframes.length && !!back.doc.authoring.anchorWorld && back.doc.authoring.entity.kind === 'player');
      if (v3 && v3.ok) {
        setView('3d'); await wait(60); v3.resize(); v3.fitCurve(); host.selectSegment(0); v3.draw(); const c3 = el('view3d');
        const pr = v3.project(eff()[2].pos);
        ok('S10 3D projects and hit-tests a point', !!pr && v3._hit(pr[0], pr[1]) && v3._hit(pr[0], pr[1]).kind === 'point');
        const w0 = eff()[2]; drag(R(pr[0]), R(pr[1]), R(pr[0]) + 15, R(pr[1]), {}, c3); const w1 = eff()[2];
        ok('S10 3D drag moves point in xz and keeps h', Math.hypot(w1.x - w0.x, w1.z - w0.z) > 1 && Math.abs(w1.h - w0.h) < 1e-6 && history.peekUndo() === '移动控制点');
        key('z', { ctrlKey: true }); setView('2d');
      } else log.push('SKIP S10 3D (no WebGL2 offscreen)');
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
