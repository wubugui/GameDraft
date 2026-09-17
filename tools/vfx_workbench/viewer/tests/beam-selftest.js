/* 光柱（体积光）交互层回归：左栏加光柱 → 选中立刻有 gizmo → 原画视图真实预览（运行时那段 GLSL）→
 * 从画布入口拖起点把手（一条历史、跟手走）→ 检视器改强度 / 截面 / 模式 → 尘埃挂到光柱上 → 存盘往返 →
 * 改名连带引用 / 被引用时删不掉 → 没深度的场景里 2D 光带照样预览。只写一次性的 zz_selftest_beam_* 效果，收尾删掉。 */
(async () => {
  const log = [], wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const ok = (name, cond, extra) => log.push((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + JSON.stringify(extra) : ''));
  const id = 'zz_selftest_beam_' + Date.now();
  let created = false;
  const cv = () => (S.view === 3 ? el('view3d') : el('view2d'));
  const ev = (type, cx, cy, opts) => {
    const c = cv(), r = c.getBoundingClientRect();
    const e = new MouseEvent(type, Object.assign({ bubbles: true, cancelable: true, clientX: Math.round(r.left + cx), clientY: Math.round(r.top + cy), button: 0, buttons: 1 }, opts || {}));
    (type === 'mousedown' ? c : window).dispatchEvent(e);
  };
  const drag = (x0, y0, x1, y1) => {
    ev('mousedown', x0, y0);
    for (let i = 1; i <= 8; i++) ev('mousemove', x0 + (x1 - x0) * i / 8, y0 + (y1 - y0) * i / 8);
    ev('mouseup', x1, y1);
  };
  const row = (sec, label) => {
    const section = el('inspector').querySelector(`[data-sec="${sec}"]`);
    if (section && !section.querySelector('input, select')) section.firstElementChild.click();
    const s2 = el('inspector').querySelector(`[data-sec="${sec}"]`);
    return s2 ? [...s2.querySelectorAll('.row')].find((n) => n.firstElementChild && n.firstElementChild.textContent === label) : null;
  };
  const change = async (n, value) => {
    if (!n) throw new Error('missing control');
    if (n.type === 'checkbox') n.checked = !!value; else n.value = String(value);
    n.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(40);
  };
  /** 2D 画布在某画面点附近的亮度和（光柱开 / 关对比用） */
  const lumAt = (sx, sy) => {
    const c = el('view2d'), g = c.getContext('2d'), dpr = window.devicePixelRatio || 1;
    const px = Math.round((sx * v2.zoom + v2.ox) * dpr), py = Math.round((sy * v2.zoom + v2.oy) * dpr);
    const d = g.getImageData(px - 3, py - 3, 7, 7).data;
    let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2];
    return s;
  };
  try {
    while (!window.__ready) await wait(50);
    S.link.on = false;
    if (!S.cal || S.cal.planar) { const base = S.scenes.find((s) => s.depth); if (base) await loadScene(base.id, ''); }
    const doc = { id, emitters: [{ id: 'dust', appearance: { image: '/resources/runtime/images/vfx/dust.png', sizeWu: 6, lit: false, blend: 'add' },
      spawn: { max: 40, rate: 10, burst: 20 }, life: { seconds: [4, 6] } }] };
    await API.post('/api/save', { doc }); created = true;
    await openEffect(id, { force: true, keepScene: true }); await wait(60);
    setView(2); await wait(60);

    // ---- 加光柱：左栏按钮 → 一条历史、选中起点把手、检视器换成光柱、gizmo 立刻在把手上
    const u0 = history.undoStack.length;
    el('btnAddBeam3').click(); await wait(60);
    const b = S.doc.beams && S.doc.beams[0];
    const pv = gizmoPivot();
    ok('B1 「+ 3D」adds one beam in one edit, selects its start handle, the inspector switches to the beam and the gizmo sits on the handle',
      !!b && b.mode === '3d' && S.sel.key === `beam:${b.id}` && history.undoStack.length === u0 + 1
        && !!el('inspector').querySelector('[data-sec="beamShape"]') && !!pv && !!v2._gizmo(),
      { beam: b && b.id, sel: S.sel.key, pv: !!pv });
    ok('B1 local preview runs the runtime sim with the beam (frame solved by vfxBeam.ts)',
      !!S.sim && S.sim.beams.length === 1 && !!S.sim.beamFrame(S.sim.beams[0]).frame3d && !S.simErr, { err: S.simErr });

    // ---- 原画视图真实预览：光柱开 / 关，光柱中段那一片确实亮了（编译的是运行时那段 GLSL）
    const f = S.sim.beamFrame(S.sim.beams[0]).frame3d;
    const mid = [f.origin[0] + f.axis[0] * f.length * 0.5, f.origin[1] + f.axis[1] * f.length * 0.5, f.origin[2] + f.axis[2] * f.length * 0.5];
    const ms = S.cal.worldToScene(mid[0], mid[1], mid[2]);
    S.layers.beams = false; v2.draw(); const off = lumAt(ms[0], ms[1]);
    S.layers.beams = true; v2.draw(); const on = lumAt(ms[0], ms[1]);
    ok('B2 the 2D view draws the beam with the runtime shader core (mid-shaft pixels brighter with the beams layer on, no compile error)',
      !!beamPreview && !beamPreview.err && on > off + 30, { on, off, err: beamPreview && beamPreview.err });

    // ---- 从画布入口拖起点把手：一条历史、写的是 shape3d.from、光柱跟手走（不等松手重建）
    const from0 = (b.shape3d.from || [0, 0, 0]).slice();
    const hp = v2.projectWorld(beamPointWorld(b, 'from'));
    const u1 = history.undoStack.length;
    ev('mousedown', hp[0], hp[1]);
    for (let i = 1; i <= 6; i++) ev('mousemove', hp[0] + 6 * i, hp[1]);
    const midDrag = S.sim.beamFrame(S.sim.beams[0]).frame3d.origin.slice();
    ev('mouseup', hp[0] + 36, hp[1]); await wait(60);
    const from1 = S.doc.beams[0].shape3d.from || [0, 0, 0];
    ok('B3 dragging the start handle from the 2D canvas moves shape3d.from (one history entry) and the beam follows during the drag',
      history.undoStack.length === u1 + 1 && Math.hypot(from1[0] - from0[0], from1[2] - from0[2]) > 5 && Math.abs(midDrag[0] - f.origin[0]) > 5,
      { from0, from1, midDragX: midDrag[0], x0: f.origin[0] });

    // ---- 检视器：强度 / 截面 / 模式
    await change(row('beam', '强度').querySelector('input'), 0.8);
    await change(row('beamShape', '截面').querySelector('select'), 'polygon');
    const sec = S.doc.beams[0].shape3d.section;
    ok('B4 inspector edits write the beam (intensity; rect → polygon keeps a sensible radius)',
      S.doc.beams[0].intensity === 0.8 && sec.kind === 'polygon' && sec.sides === 6 && sec.radius > 0 && S.sim.beams[0].def.shape3d.section.kind === 'polygon', { sec });
    const shape3d = JSON.stringify(S.doc.beams[0].shape3d);
    await change(row('beam', '模式').querySelector('select'), '2d');
    ok('B4 switching to 2D creates a default shape2d and keeps shape3d untouched (switch back loses nothing)',
      S.doc.beams[0].mode === '2d' && !!S.doc.beams[0].shape2d && JSON.stringify(S.doc.beams[0].shape3d) === shape3d
        && !!S.sim.beamFrame(S.sim.beams[0]).frame2d);
    await change(row('beam', '模式').querySelector('select'), '3d');

    // ---- 尘埃挂到光柱上：发射形状「光柱体积」+「被光柱照亮」都是下拉（候选 = 本效果的光柱）
    select('emitter:dust'); await wait(40);
    await change(row('spawn', '形状').querySelector('select'), 'beam');
    await change(row('appearance', '被光柱照亮').querySelector('select'), S.doc.beams[0].id);
    const em = S.doc.emitters[0];
    for (let i = 0; i < 60; i++) stepSim(1 / 60);
    const lb = S.sim.beamFrame(S.sim.beams[0]);
    let inside = 0;
    const loc = { t01: 0, u: 0, v: 0, edge: 0 };
    const p = S.sim.emitters[0].p;
    for (let k = 0; k < p.cap; k++) if (p.alive[k] && S.rt.vfxBeam.beam3dLocal(lb.frame3d, p.x[k], p.y[k], p.z[k], loc)) inside++;
    ok('B5 dust on the beam: spawn shape = beam volume and beamLit via dropdowns; every live particle is born inside the beam',
      em.spawn.shape.kind === 'beam' && em.spawn.shape.beam === S.doc.beams[0].id && em.appearance.beamLit.beam === S.doc.beams[0].id
        && S.sim.liveCount > 5 && inside === S.sim.liveCount, { live: S.sim.liveCount, inside, shape: em.spawn.shape });

    // ---- 存盘往返：服务端闸门收（键序按 types.ts）、重开一样
    el('btnSave').click(); await ioChain; await wait(40);
    const saved = (await API.json(`/api/effect?id=${id}`)).doc;
    const keys = Object.keys(saved.beams[0]);
    ok('B6 save round-trips the beam (server gate accepts it, types.ts key order, dust refs kept) and clears dirty',
      !S.dirty && keys[0] === 'id' && keys[1] === 'mode' && keys.indexOf('shape3d') < keys.indexOf('color')
        && saved.emitters[0].appearance.beamLit.beam === saved.beams[0].id && Object.keys(saved).indexOf('beams') === Object.keys(saved).indexOf('emitters') + 1,
      { keys, status: el('status').textContent });

    // ---- 改名连带引用；被引用时删不掉
    const oldId = S.doc.beams[0].id;
    edit('自检 改光柱 id', () => renameBeam(oldId, 'shaft'));
    ok('B7 renaming a beam rewrites the dust references (spawn shape + beamLit)',
      S.doc.beams[0].id === 'shaft' && S.doc.emitters[0].spawn.shape.beam === 'shaft' && S.doc.emitters[0].appearance.beamLit.beam === 'shaft');
    delBeam('shaft'); await wait(20);
    ok('B7 deleting a beam still used by dust is refused with a readable reason', S.doc.beams.length === 1 && /还用着它/.test(el('status').textContent),
      { status: el('status').textContent });

    // ---- 没深度的场景：平面近似，2D 光带照样预览。工程里的场景都烘过深度，这里按 loadScene 没标定时那一支
    //      原样装一个平面近似标定（同一个 PlanarCal + buildSpace），不另写判据
    {
      const flat = S.scene;
      S.cal = new PlanarCal(S.scene.worldWidth, S.scene.worldHeight, Math.SQRT2);
      buildSpace(); rebuildSim(); v2.setBackground(v2.bg);
      edit('自检 2D 光带', () => { S.doc.beams[0].mode = '2d'; S.doc.beams[0].shape2d = { from: [-40, -160], to: [0, 0], width: [30, 120] }; });
      setView(2); await wait(40);
      const b2 = S.sim && S.sim.beamFrame(S.sim.beams[0]);
      const c2 = b2 && b2.frame2d ? [(b2.frame2d.corners[0] + b2.frame2d.corners[4]) / 2, (b2.frame2d.corners[1] + b2.frame2d.corners[5]) / 2] : null;
      S.layers.beams = false; v2.draw(); const off2 = c2 ? lumAt(c2[0], c2[1]) : 0;
      S.layers.beams = true; v2.draw(); const on2 = c2 ? lumAt(c2[0], c2[1]) : 0;
      ok('B8 a scene without depth loads with the planar calibration: local sim runs, the 2D band is drawn',
        !!S.cal && S.cal.planar === true && !!S.space && S.space.kind === 'planar' && !!b2 && !!b2.frame2d && on2 > off2 + 30,
        { scene: flat.id, on2, off2, err: S.simErr, planar: !!(S.cal && S.cal.planar), space: S.space && S.space.kind, frame: !!(b2 && b2.frame2d) });
      await loadScene(flat.id, S.phase); await wait(60);
    }
  } catch (error) { log.push('EXC ' + (error.stack || error)); }
  finally {
    S.link.on = false;
    if (created) try { await API.post('/api/delete', { id, withPlacements: true }); } catch (e) { log.push('EXC Cleanup: ' + e); }
    window.__selftestResult = log.join('\n');
  }
})();
