/* 地形工作台 · 交互层端到端回归（在真页面里跑；由 `python -m tools.terrain_workbench --selftest` 注入）。
 *
 * 每条 `ok()` 一行 PASS/FAIL；异常记 EXC；跑完把整份报告写进 window.__selftestResult。
 * 约定：所有手势都从画布入口合成真实鼠标事件进去；`S` / `v3` / `v2` / `history` 是 app.js 的词法声明（裸标识符）。
 * 服务端已把作者层 / 预览 / 草稿指到临时树（app.py），这里放心保存 / 推送。 */
(async () => {
  const log = [];
  const ok = (name, cond, extra) => log.push((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + JSON.stringify(extra) : ''));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const R = (v) => Math.round(v);
  const cv = () => (S.view === 3 ? el('view3d') : el('view2d'));
  const ev = (type, cx, cy, opts) => {
    const c = cv(); const r = c.getBoundingClientRect();
    const e = new MouseEvent(type, Object.assign({ bubbles: true, cancelable: true, clientX: Math.round(r.left + cx), clientY: Math.round(r.top + cy), button: 0, buttons: 1 }, opts || {}));
    (type === 'mousedown' ? c : window).dispatchEvent(e);
  };
  const click = (cx, cy, opts) => { ev('mousedown', cx, cy, opts); ev('mouseup', cx, cy, opts); };
  const dbl = (cx, cy) => { const c = cv(); const r = c.getBoundingClientRect(); c.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: Math.round(r.left + cx), clientY: Math.round(r.top + cy), button: 0 })); };
  const drag = (x0, y0, x1, y1, opts) => { ev('mousedown', x0, y0, opts); for (let i = 1; i <= 8; i++) ev('mousemove', x0 + (x1 - x0) * i / 8, y0 + (y1 - y0) * i / 8, opts); ev('mouseup', x1, y1, opts); };
  const wheel = (cx, cy, dy) => { const c = cv(); const r = c.getBoundingClientRect(); c.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: dy, clientX: Math.round(r.left + cx), clientY: Math.round(r.top + cy) })); };
  const key = (k, opts) => { const e = new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, opts || {})); window.dispatchEvent(e); return e; };
  const P3 = (w) => { const c = v3.project(w); return c ? [R(c[0]), R(c[1])] : null; };
  const countBlocked = () => S.stats.blocked;
  const cwh = () => { const c = cv(); return [c.clientWidth, c.clientHeight]; };
  /** 画布上找一个地面拾取得到、且在网格里的点（从中心往外螺旋找） */
  const groundSpot = (prefer) => {
    const [W, H] = cwh();
    for (let r = 0; r < 6; r++) for (let a = 0; a < 8; a++) {
      const x = W * (0.5 + 0.08 * r * Math.cos(a)), y = H * ((prefer || 0.62) + 0.06 * r * Math.sin(a));
      const g = S.view === 3 ? v3.pickGround(x, y) : v2.groundAt(x, y);
      if (!g) continue;
      const [gx, gz] = S.grid.cellOf(...worldToGrid(g));
      if (S.grid.inside(gx, gz) && S.onGround[S.grid.idx(gx, gz)]) return [x, y, g];
    }
    return null;
  };

  try {
    // ------------------------------------------------------------------ S1 启动
    for (let i = 0; i < 160 && !window.__ready; i++) await wait(250);
    ok('S1 boot: ready / scene / cal / grid / composed / WebGL2 / clean', !!window.__ready && !!S.scene && !!S.cal && !!S.grid && !!S.composed && v3.ok && !S.dirty,
      { scene: S.scene && S.scene.id, grid: S.grid && [S.grid.w, S.grid.h], v3: v3.ok });
    const shown = (id) => getComputedStyle(el(id)).display !== 'none';
    ok('S1 busy / dialog overlays are not displayed at boot', !shown('busy') && !shown('dialog'));
    ok('S1 the 3D canvas sits under the pointer', (() => { const r = cv().getBoundingClientRect(); const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return t && ['view3d', 'overlay3d'].includes(t.id); })());

    // ------------------------------------------------------------------ S2 页面合成 == 服务端合成（逐格）
    {
      const srv = await API.post('/api/compose', { id: S.scene.id, state: currentState() });
      const sb = b64ToU8(srv.blocked), ss = b64ToU8(srv.src);
      let dB = 0, dS = 0; for (let i = 0; i < sb.length; i++) { if (sb[i] !== S.composed.blocked[i]) dB++; if (ss[i] !== S.composed.src[i]) dS++; }
      ok('S2 local compose == server compose (blocked + source, every cell)', dB === 0 && dS === 0 && sb.length === S.grid.n, { dB, dS, n: sb.length });
    }

    // ------------------------------------------------------------------ S3 手性
    {
      v3.fit(true);
      const cal = S.cal;
      const sp = (S.marks.find((m) => m.kind === 'spawn') || { world: [0, 0, 0] }).world;
      const Rw = cal.screenRightWorld();
      const p0 = P3(sp), pr = P3([sp[0] + Rw[0] * 300, sp[1] + Rw[1] * 300, sp[2] + Rw[2] * 300]), pu = P3([sp[0], sp[1] + 300, sp[2]]);
      ok('S3 handedness: picture-right offset projects right, +Y projects up', !!(p0 && pr && pu) && pr[0] > p0[0] + 5 && pu[1] < p0[1] - 5, { p0, pr, pu });
      const camR = v3._right(), camF = v3._forward(), e3 = v3._eye();
      const c0 = P3([e3[0] + camF[0] * 1000, e3[1] + camF[1] * 1000, e3[2] + camF[2] * 1000]);
      const c1 = P3([e3[0] + camF[0] * 1000 + camR[0] * 200, e3[1] + camF[1] * 1000 + camR[1] * 200, e3[2] + camF[2] * 1000 + camR[2] * 200]);
      ok("S3 handedness: the camera's right projects to screen +x", !!(c0 && c1) && c1[0] > c0[0] + 5, { c0, c1 });
    }

    // ------------------------------------------------------------------ S4 相机手势
    {
      v3.fit(true);
      const e0 = v3._eye();
      ev('mousedown', 200, 200, { button: 2, buttons: 2 });
      ev('mousemove', 260, 200, { button: 2, buttons: 2 });
      const e1 = v3._eye();
      ok('S4 right-drag = look around: the eye does not move', Math.hypot(e1[0] - e0[0], e1[1] - e0[1], e1[2] - e0[2]) < 1.5);
      const toolBefore = S.tool;
      key('k'); key('w');
      ok('S4 while flying, keys go to the camera, not the tool keymap', S.tool === toolBefore && v3.capturesKeys());
      ev('mouseup', 260, 200, { button: 2, buttons: 0 });
      ok('S4 releasing the right button stops flying', !v3.capturesKeys());
      v3.fit(true);
      const tgt0 = [v3.cam.tx, v3.cam.ty, v3.cam.tz];
      drag(200, 200, 250, 210, { altKey: true });
      ok('S4 Alt+left = orbit: target stays', Math.hypot(v3.cam.tx - tgt0[0], v3.cam.ty - tgt0[1], v3.cam.tz - tgt0[2]) < 1e-6);
      v3.fit(true);
      const sp = groundSpot(0.5);
      if (sp) {
        const before = P3(sp[2]); wheel(sp[0], sp[1], -240); const after = P3(sp[2]);
        ok('S4 wheel zooms toward the cursor: the point under it stays put', !!(before && after) && Math.hypot(after[0] - before[0], after[1] - before[1]) < 6, { before, after });
      } else ok('S4 wheel zoom (no ground spot found)', false);
      v3.fit(true);
      const c0 = [v3.cam.tx, v3.cam.tz];
      drag(300, 300, 340, 320, { button: 1, buttons: 4 });
      ok('S4 middle-drag pans', Math.hypot(v3.cam.tx - c0[0], v3.cam.tz - c0[1]) > 1);
      key('3');
      ok('S4 "3" = top view (orthographic, looking down)', v3.cam.ortho && v3.cam.pitch > 1.5);
      key('1'); v3.fit(true);
      ok('S4 "1" back to 3D perspective', S.view === 3 && !v3.cam.ortho);
    }

    // ------------------------------------------------------------------ S5 笔刷（真手势）+ 撤销 / 重做 + 连通性重算
    {
      v3.fit(true);
      const sp = groundSpot(0.6);
      ok('S5 found a ground spot to paint on', !!sp);
      const b0 = countBlocked(), stats0 = S.stats.unreachable;
      setTool('brush'); S.brushOpt.mode = 'block'; S.brushOpt.radiusWu = Math.max(20, S.grid.cell * S.k * 2.5);
      const [W, H] = cwh();
      drag(sp[0], sp[1], sp[0] + W * 0.1, sp[1]);
      const b1 = countBlocked();
      ok('S5 brush stroke adds blocked cells and is ONE undo entry', b1 > b0 && history.canUndo && /笔刷/.test(history.peekUndo()) && S.dirty, { b0, b1, undo: history.peekUndo() });
      ok('S5 reach recomputed after the stroke (stats present)', typeof S.stats.unreachable === 'number');
      S.brushOpt.mode = 'walk';
      drag(sp[0], sp[1], sp[0] + W * 0.1, sp[1]);
      const b2 = countBlocked();
      ok('S5 walk brush overrides auto-blocked cells (fewer blocked than after the block stroke)', b2 < b1, { b1, b2 });
      key('z', { ctrlKey: true }); key('z', { ctrlKey: true });
      ok('S5 two undos restore the original blocked count', countBlocked() === b0, { now: countBlocked(), b0 });
      key('y', { ctrlKey: true });
      ok('S5 redo re-applies the block stroke', countBlocked() === b1);
      key('z', { ctrlKey: true });
      // 右键点一下 = 擦
      S.brushOpt.mode = 'block'; drag(sp[0], sp[1], sp[0] + W * 0.05, sp[1]);
      const b3 = countBlocked();
      ev('mousedown', sp[0], sp[1], { button: 2, buttons: 2 }); ev('mouseup', sp[0], sp[1], { button: 2, buttons: 0 });
      ok('S5 right-click without dragging = erase at that spot', countBlocked() < b3 && /擦/.test(history.peekUndo()), { b3, now: countBlocked() });
      while (history.canUndo) history.undo();
      afterEdit();
      ok('S5 undo all ⇒ clean', !S.dirty && countBlocked() === b0);
      void stats0;
    }

    // ------------------------------------------------------------------ S6 多边形 / 矩形 / 顶点 / gizmo
    {
      v3.fit(true);
      setTool('polyWalk');
      const [W, H] = cwh();
      const a = groundSpot(0.6), b = groundSpot(0.7);
      ok('S6 ground spots for polygon', !!(a && b));
      click(a[0], a[1]); click(a[0] + W * 0.1, a[1]); click(a[0] + W * 0.05, a[1] + H * 0.08);
      ok('S6 three clicks = 3 draft vertices', !!S.draft && S.draft.points.length === 3);
      key('Enter');
      const r1 = S.doc.regions[0];
      ok('S6 Enter closes the polygon into a walk region, selects it and returns to the select tool', !!r1 && r1.kind === 'walk' && r1.points.length === 3 && S.sel.key === `region:${r1.id}` && S.tool === 'select', { sel: S.sel.key, tool: S.tool });
      ok('S6 selecting a region shows the gizmo immediately (3D)', !!v3._gizmo());
      // 点顶点
      const vw = gridToWorld(r1.points[1][0], r1.points[1][1]);
      const pv = P3(vw);
      click(pv[0], pv[1]);
      ok('S6 clicking a vertex selects it (gizmo on the vertex)', S.sel.key === `region:${r1.id}:v1` && !!v3._gizmo(), { sel: S.sel.key });
      // 拖顶点：世界 XZ 变了
      const before = r1.points[1].slice();
      drag(pv[0], pv[1], pv[0] + 30, pv[1] + 10);
      const after = S.doc.regions[0].points[1];
      ok('S6 dragging a vertex moves it on the ground (one history entry)', (Math.abs(after[0] - before[0]) > 1e-6 || Math.abs(after[1] - before[1]) > 1e-6) && /挪/.test(history.peekUndo()), { before, after });
      // 双击边线插点
      const p0 = P3(gridToWorld(S.doc.regions[0].points[0][0], S.doc.regions[0].points[0][1])), p1 = P3(gridToWorld(S.doc.regions[0].points[1][0], S.doc.regions[0].points[1][1]));
      select(`region:${r1.id}`);
      dbl((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2);
      ok('S6 double-click on an edge inserts a vertex', S.doc.regions[0].points.length === 4, { n: S.doc.regions[0].points.length });
      key('Delete');
      ok('S6 Delete removes the selected vertex', S.doc.regions[0].points.length === 3);
      // 阻挡矩形
      setTool('rectBlock');
      const c = groundSpot(0.75);
      const nb0 = countBlocked();
      drag(c[0], c[1], c[0] + W * 0.08, c[1] + H * 0.05);
      const r2 = S.doc.regions[1];
      ok('S6 rect tool creates a 4-point block region that adds blocked cells', !!r2 && r2.kind === 'block' && r2.points.length === 4 && countBlocked() > nb0, { nb0, now: countBlocked() });
      // 阻挡压过可走：把矩形挪到可走多边形上
      const inspector = el('inspector');
      ok('S6 inspector shows the selected region with kind buttons', !!inspector.querySelector('button.on') && /多边形/.test(inspector.textContent));
      // 面板改种类
      const btnWalk = [...inspector.querySelectorAll('button')].find((x) => x.textContent === '可走');
      btnWalk.click();
      ok('S6 changing kind in the inspector is an undoable edit', S.doc.regions[1].kind === 'walk' && /种类/.test(history.peekUndo()));
      key('z', { ctrlKey: true });
      ok('S6 undo restores the kind', S.doc.regions[1].kind === 'block');
      // 2D 视图里同一份（先回选择工具：矩形工具下点画布是拉框）
      setTool('select');
      key('2'); await wait(50); v2.fit();
      const q = v2.projectWorld(gridToWorld(S.doc.regions[0].points[0][0], S.doc.regions[0].points[0][1]));
      click(q[0], q[1]);
      ok('S6 2D view: clicking the same vertex selects it and shows the gizmo', S.sel.key === `region:${r1.id}:v0` && !!v2._gizmo(), { sel: S.sel.key });
      key('1');
    }

    // ------------------------------------------------------------------ S7 高度 / 检视 / 快捷键
    {
      v3.fit(true);
      setTool('height'); S.heightOpt.sub = 'sculpt'; S.heightOpt.mode = 'raise'; S.heightOpt.radiusWu = S.grid.cell * S.k * 3; S.heightOpt.strengthWu = 10;
      const sp = groundSpot(0.6);
      const [W] = cwh();
      drag(sp[0], sp[1], sp[0] + W * 0.05, sp[1]);
      const nh = S.height.reduce((a, v) => a + (Math.abs(v) > 1e-9 ? 1 : 0), 0);
      ok('S7 height sculpt writes the delta raster (grid units, accumulates along the stroke) as one history entry', nh > 0 && /高度/.test(history.peekUndo()) && Math.max(...S.height) * S.k > 1, { nh, maxWu: Math.max(...S.height) * S.k });
      S.heightOpt.sub = 'poly'; S.heightOpt.polyKind = 'offset'; S.heightOpt.valueWu = 12; S.heightOpt.featherWu = 20;
      click(sp[0], sp[1]); click(sp[0] + W * 0.08, sp[1]); click(sp[0] + W * 0.04, sp[1] + 30);
      key('Enter');
      const op = S.doc.heightOps[0];
      ok('S7 height polygon becomes a heightOp in grid units', !!op && op.kind === 'offset' && Math.abs(op.value * S.k - 12) < 1e-6 && Math.abs(op.feather * S.k - 20) < 1e-6 && op.points.length === 3, op);
      setTool('inspect');
      click(sp[0], sp[1]);
      ok('S7 inspect tool reports the cell', !!S.inspect && /格 \(/.test(el('status').textContent), { status: el('status').textContent });
      setTool('brush');
      const r0 = S.brushOpt.radiusWu; key(']'); key(']'); key('[');
      ok('S7 [ ] change the brush radius', S.brushOpt.radiusWu > r0);
      key('Escape');
      ok('S7 Esc returns to select', S.tool === 'select');
    }

    // ------------------------------------------------------------------ S8 保存往返（隔离树）+ 待导出 + 历史 + 草稿
    {
      const stateBefore = currentState();
      const r = await saveTerrain();
      ok('S8 save writes the authoring layers and clears dirty', r === true && !S.dirty && !!S.baseUpdated, { updated: S.baseUpdated });
      const t = await API.json(`/api/terrain?id=${encodeURIComponent(S.scene.id)}`);
      ok('S8 saved doc round-trips (regions + heightOps + height raster present)', t.doc.regions.length === 2 && t.doc.heightOps.length === 1 && !!t.height && t.doc.height && t.doc.height.range > 0, { regions: t.doc.regions.length, ops: t.doc.heightOps.length });
      ok('S8 export badge lit after saving changes', S.needsExport === true && el('btnExport').classList.contains('pending'));
      const hist = await API.json(`/api/history?id=${encodeURIComponent(S.scene.id)}`);
      ok('S8 a history snapshot was kept before saving', hist.items.length >= 1);
      // 草稿：改一下、存草稿、清掉
      edit('测试', () => { S.doc.regions[0].points[0][0] += 0.01; });
      await API.post('/api/draft', { id: S.scene.id, draft: { savedAt: 'now', baseUpdated: S.baseUpdated, state: currentState() } });
      const d = await API.json(`/api/draft?id=${encodeURIComponent(S.scene.id)}`);
      ok('S8 draft store round-trips', !!d.draft && d.draft.savedAt === 'now');
      await API.post('/api/draft/clear', { id: S.scene.id });
      key('z', { ctrlKey: true });
      ok('S8 close-guard hooks are wired', typeof window.__unsavedSummary === 'function' && typeof window.__saveUnsaved === 'function' && window.__unsavedSummary() === '');
      void stateBefore;
    }

    // ------------------------------------------------------------------ S9 推给游戏（游戏指到死端口）：合成成功、通知失败不算失败、资源不动
    {
      await pushToGame();
      const j = S.job;
      ok('S9 push composes into the preview dir even with no game (job succeeded, notify failed softly)', !!j && j.done && j.succeeded && j.push && j.push.pushed === false, { kind: j && j.kind, err: j && j.err, push: j && j.push });
      ok('S9 status line reports the push outcome', /推给游戏/.test(el('status').textContent), { status: el('status').textContent });
      ok('S9 link chip says the game is not running', /游戏没开|没开/.test(el('linkChip').textContent), { chip: el('linkChip').textContent });
      ok('S9 alignment chip does not claim alignment without a game', !/✓/.test(el('alignChip').textContent), { chip: el('alignChip').textContent });
    }

    // ------------------------------------------------------------------ S10 连通性判据（每个出生点都要走得到出口）
    {
      const spawns = S.marks.filter((m) => m.kind === 'spawn');
      const items = S.reachIssues;
      ok('S10 reach issues list has one line per exit/align/landing/spawn mark', items.length >= spawns.length, { n: items.length, spawns: spawns.length });
      // 把出生点周围全堵死 ⇒ 出口走不到
      if (spawns.length) {
        const g = worldToGrid(spawns[0].world);
        const rr = S.grid.cell * 6;
        edit('围死', () => { S.doc.regions.push({ id: 'zz_wall', kind: 'block', points: [[g[0] - rr, g[1] - rr], [g[0] + rr, g[1] - rr], [g[0] + rr, g[1] + rr], [g[0] - rr, g[1] + rr]] }); });
        const exits = S.reachIssues.filter((i) => i.kind === 'exit' || i.kind === 'align');
        ok('S10 walling in the spawn makes exits unreachable (bad lines)', exits.length === 0 || exits.some((i) => i.bad), exits.map((i) => i.text));
        key('z', { ctrlKey: true });
      }
    }
  } catch (e) {
    log.push('EXC ' + ((e && e.stack) || e));
  } finally {
    try { S.dirty = false; } catch (e) { /* 收尾 */ }
    window.__selftestResult = log.join('\n');
  }
})();
