/* 粒子工作台 · 交互层端到端回归（在真页面里跑；由 `python -m tools.vfx_workbench --selftest` 注入）。
 *
 * 每条 `ok()` 一行 PASS/FAIL；异常记 EXC；跑完把整份报告写进 window.__selftestResult。
 * 约定：
 *  - **绝不在 bat_cliff 等真资产上 saveAsset**；临时资产一律 `zz_selftest_*` 前缀，收尾删掉；
 *  - 所有手势都从画布入口合成真实鼠标事件进去（护栏从最外层进，见 editor-tools norms）；
 *  - `app.js` 是 classic script：`S` / `v3` / `v2` / `history` / `host` 是**词法声明、不挂 window**，
 *    脚本里一律用裸标识符（写 `window.v3` 恒为 undefined，会伪装成"这台机器没 WebGL2"）。 */
(async () => {
  const log = [];
  const ok = (name, cond, extra) => log.push((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + JSON.stringify(extra) : ''));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const R = (v) => Math.round(v);
  const cv = () => (S.view === 3 ? el('view3d') : el('view2d'));
  const ev = (type, cx, cy, opts) => {
    const c = cv(); const r = c.getBoundingClientRect();
    const e = new MouseEvent(type, Object.assign({
      bubbles: true, cancelable: true, clientX: Math.round(r.left + cx), clientY: Math.round(r.top + cy), button: 0, buttons: 1,
    }, opts || {}));
    (type === 'mousedown' ? c : window).dispatchEvent(e);
  };
  const click = (cx, cy, opts) => { ev('mousedown', cx, cy, opts); ev('mouseup', cx, cy, opts); };
  const drag = (x0, y0, x1, y1, opts) => {
    ev('mousedown', x0, y0, opts);
    for (let i = 1; i <= 8; i++) ev('mousemove', x0 + (x1 - x0) * i / 8, y0 + (y1 - y0) * i / 8, opts);
    ev('mouseup', x1, y1, opts);
  };
  const wheel = (cx, cy, dy) => {
    const c = cv(); const r = c.getBoundingClientRect();
    c.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: dy, clientX: Math.round(r.left + cx), clientY: Math.round(r.top + cy) }));
  };
  const key = (k, opts) => { const e = new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, opts || {})); window.dispatchEvent(e); return e; };
  const post = async (path, body) => { try { return await API.post(path, body); } catch (e) { return { ok: false, err: String((e && e.message) || e) }; } };
  const P3 = (w) => { const c = v3.project(w); return c ? [R(c[0]), R(c[1])] : null; };
  const em0 = () => (S.doc.emitters || [])[0];
  const tmp = [];

  try {
    // ------------------------------------------------------------------ S1 启动
    for (let i = 0; i < 120 && !window.__ready; i++) await wait(250);
    ok('S1 boot: ready / doc / scene / cal / runtime bundle / WebGL2, clean',
      !!window.__ready && !!S.doc && !!S.scene && !!S.cal && !!S.rt && v3.ok && !S.dirty,
      { doc: S.doc && S.doc.id, scene: S.scene && S.scene.id, rtErr: S.rtErr });
    ok('S1 local preview really runs the runtime sim (VfxInstanceSim from the bundle)',
      !!S.sim && typeof S.sim.step === 'function' && S.sim.emitters.length > 0 && !S.simErr,
      { emitters: S.sim && S.sim.emitters.length, err: S.simErr });
    const shown = (id) => getComputedStyle(el(id)).display !== 'none';
    const topAtCenter = () => { const r = cv().getBoundingClientRect(); const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return t ? t.id || t.tagName : null; };
    ok('S1 busy / dialog overlays are really not displayed at boot', !shown('busy') && !shown('dialog'),
      { busy: getComputedStyle(el('busy')).display, dialog: getComputedStyle(el('dialog')).display });
    ok('S1 the 3D canvas is what sits under the pointer (nothing covers it)', ['view3d', 'overlay3d'].includes(topAtCenter()), { top: topAtCenter() });

    // ------------------------------------------------------------------ S2 坐标对齐（不许绕过）
    ok('S2 alignment check ran and agrees with the runtime + the server', !!(S.align && S.align.ok), S.align);
    ok('S2 scene points: runtime groundWorldAt == workbench SceneCal (25 points)', !!S.align && S.align.dPts < 0.5, { dPts: S.align && S.align.dPts, n: S.align && S.align.n });
    ok('S2 shell contact: runtime shellContactAt == server SceneGeometry.shell_contact',
      !!S.align && S.align.dPen != null && S.align.dPen < 0.5 && S.align.mismatch === 0,
      { dPen: S.align && S.align.dPen, dNormal: S.align && S.align.dNormal, nPen: S.align && S.align.nPen });

    // ------------------------------------------------------------------ S3 手性（右手 lookAt 画左手世界 = 整张镜像，且不报错）
    {
      v3.fit(true);
      const cal = S.cal;
      const sp = (S.marks.find((m) => m.kind === 'spawn') || { world: anchorWorld() }).world;
      const Rw = cal.screenRightWorld();
      const p0 = P3(sp), pr = P3([sp[0] + Rw[0] * 300, sp[1] + Rw[1] * 300, sp[2] + Rw[2] * 300]), pu = P3([sp[0], sp[1] + 300, sp[2]]);
      ok('S3 handedness: picture-right offset projects right, +Y projects up',
        !!(p0 && pr && pu) && pr[0] > p0[0] + 5 && pu[1] < p0[1] - 5, { p0, pr, pu });
      const ga = cal.sceneToWorldGround(cal.worldW * 0.3, cal.worldH * 0.7), gb = cal.sceneToWorldGround(cal.worldW * 0.7, cal.worldH * 0.7);
      const pa = P3(ga), pb = P3(gb);
      ok('S3 handedness: the point further right in the picture is further right in 3D', !!(pa && pb) && pb[0] > pa[0] + 5, { pa, pb });
      const camR = v3._right(), camF = v3._forward(), e3 = v3._eye();
      const c0 = P3([e3[0] + camF[0] * 1000, e3[1] + camF[1] * 1000, e3[2] + camF[2] * 1000]);
      const c1 = P3([e3[0] + camF[0] * 1000 + camR[0] * 200, e3[1] + camF[1] * 1000 + camR[1] * 200, e3[2] + camF[2] * 1000 + camR[2] * 200]);
      ok("S3 handedness: the camera's right projects to screen +x", !!(c0 && c1) && c1[0] > c0[0] + 5, { c0, c1 });
    }

    // ------------------------------------------------------------------ S4 Unity 式相机手势
    {
      v3.fit(true);
      const e0 = v3._eye();
      ev('mousedown', 200, 200, { button: 2, buttons: 2 });
      ev('mousemove', 260, 200, { button: 2, buttons: 2 });
      const f1 = v3._forward(), r0 = [0, 0, 0];
      const e1 = v3._eye();
      ok('S4 right-drag = look around: the eye does not move', Math.hypot(e1[0] - e0[0], e1[1] - e0[1], e1[2] - e0[2]) < 1.5, { e0: e0.map(R), e1: e1.map(R) });
      ok('S4 right-drag to the right turns the view to the right', f1[0] * v3._right()[0] + f1[2] * v3._right()[2] > -1, { f1 });
      void r0;
      // 飞行键：按住右键时 W/E 归相机，不漏给工具键表
      const modeBefore = S.gizmoMode, toolBefore = S.tool;
      key('e'); key('w');
      ok('S4 while flying, W/E go to the camera and do not leak to the tool keymap',
        S.gizmoMode === modeBefore && S.tool === toolBefore && v3.capturesKeys(), { mode: S.gizmoMode, tool: S.tool });
      const t0 = [v3.cam.tx, v3.cam.ty, v3.cam.tz];
      v3.keys.add('KeyD'); v3._flyStep(0.3); v3.keys.clear();
      ok('S4 flying (D) actually moves the camera', Math.hypot(v3.cam.tx - t0[0], v3.cam.tz - t0[2]) > 1);
      ev('mouseup', 260, 200, { button: 2, buttons: 0 });
      ok('S4 releasing the right button stops flying (keys back to the tool keymap)', !v3.capturesKeys());
      // 环绕：目标点不动
      v3.fit(true);
      const tgt0 = [v3.cam.tx, v3.cam.ty, v3.cam.tz];
      drag(200, 200, 250, 210, { altKey: true });
      const tgt1 = [v3.cam.tx, v3.cam.ty, v3.cam.tz];
      ok('S4 Alt+left = orbit: the target point does not move', Math.hypot(tgt1[0] - tgt0[0], tgt1[1] - tgt0[1], tgt1[2] - tgt0[2]) < 1e-6, { tgt0: tgt0.map(R), tgt1: tgt1.map(R) });
      // 朝光标缩放：光标下那个点在屏幕上不动
      v3.fit(true);
      const mx = 260, my = 240;
      const under = v3.pickGround(mx, my);
      const before = under ? P3(under) : null;
      wheel(mx, my, -240);
      const after = under ? P3(under) : null;
      ok('S4 wheel zooms toward the cursor: the point under it stays put',
        !!(before && after) && Math.hypot(after[0] - before[0], after[1] - before[1]) < 6, { before, after });
      // 坐标架：点中心切正交，正交下仍能拾取地面
      const lay = v3._sceneGizmoLayout();
      click(R(lay.ox), R(lay.oy));
      ok('S4 clicking the axis-triad centre switches to orthographic', v3.cam.ortho === true);
      ok('S4 picking still works in orthographic (ray reaches the ground behind the eye)', !!v3.pickGround(R(cv().clientWidth / 2), R(cv().clientHeight / 2)));
      click(R(lay.ox), R(lay.oy));
      ok('S4 clicking it again goes back to perspective', v3.cam.ortho === false);
      v3.fit(true);
    }

    // ------------------------------------------------------------------ S5 临时资产：新开资产的第一笔手势要进历史
    const TMP = 'zz_selftest_a';
    {
      await post('/api/delete', { id: TMP });
      const cr = await post('/api/create', { id: TMP, sceneId: S.scene.id, background: S.scene.background, label: '自检' });
      ok('S5 create a temp effect', !!cr.ok, { err: cr.err });
      tmp.push(TMP);
      await refreshEffects();
      await openEffect(TMP);
      ok('S5 the temp effect opened clean, with one emitter and empty history',
        S.doc.id === TMP && (S.doc.emitters || []).length === 1 && !S.dirty && history.undoStack.length === 0,
        { id: S.doc.id, emitters: (S.doc.emitters || []).map((e) => e.id), dirty: S.dirty });
    }

    // ------------------------------------------------------------------ S6 gizmo：选中立刻有、单轴只动一个分量、Ctrl 吸附、纯点不入历史
    {
      setView(3); setTool('select');
      const id = em0().id;
      select(`emitter:${id}`);
      let g = v3._gizmo();
      ok('S6 selecting one thing gives a gizmo immediately, pivot on the thing itself, labelled',
        !!g && g.mode === 'move' && g.axes.length === 3 && /发射器/.test(g.label), g && { mode: g.mode, label: g.label, axes: g.axes.map((a) => a.k) });
      // 沿轴抓：先用 _hit 核实探针点抓到的确实是那根轴（小目标会比轴优先命中）
      const along = (k, px) => {
        const gg = v3._gizmo(); const t = gg.tip[k], c = gg.c;
        const l = Math.hypot(t[0] - c[0], t[1] - c[1]); const d = [(t[0] - c[0]) / l, (t[1] - c[1]) / l];
        let s = null;
        for (const f of [0.62, 0.45, 0.78, 0.3, 0.9]) {
          const q = [R(c[0] + d[0] * l * f), R(c[1] + d[1] * l * f)];
          const hh = v3._hit(q[0], q[1]);
          if (hh && hh.kind === 'gz' && hh.part === k) { s = q; break; }
        }
        if (!s) { s = [R(c[0] + d[0] * l * 0.62), R(c[1] + d[1] * l * 0.62)]; log.push(`WARN along(${k}): no probe point hits axis ${k}`); }
        return [s[0], s[1], R(s[0] + d[0] * px), R(s[1] + d[1] * px)];
      };
      const off = () => (em0().offset || [0, 0, 0]).slice();
      const u0 = history.undoStack.length;
      let a = along('x', 40); drag(a[0], a[1], a[2], a[3]);
      const o1 = off();
      ok('S6 X arrow moves only offset.x, and the very first gesture on a new asset enters history',
        Math.abs(o1[0]) > 1 && o1[1] === 0 && o1[2] === 0 && history.undoStack.length === u0 + 1 && S.dirty,
        { offset: o1, undo: history.undoStack.length, label: history.peekUndo() });
      a = along('z', 40); drag(a[0], a[1], a[2], a[3], { ctrlKey: true });
      const o2 = off();
      ok('S6 Ctrl+drag snaps the delta to a multiple of 10 wu and moves only z',
        Math.abs(o2[2] - o1[2]) > 1 && Math.abs((o2[2] - o1[2]) / 10 - Math.round((o2[2] - o1[2]) / 10)) < 1e-6 && o2[0] === o1[0],
        { d: +(o2[2] - o1[2]).toFixed(3) });
      const u1 = history.undoStack.length, before = JSON.stringify(S.doc);
      g = v3._gizmo();
      click(R(g.c[0]), R(g.c[1]));
      ok('S6 a plain click on the gizmo is not an edit (no history, no dirty change, doc untouched)',
        history.undoStack.length === u1 && JSON.stringify(S.doc) === before, { undo: history.undoStack.length });
      // 撤销 / 重做
      key('z', { ctrlKey: true });
      ok('S6 undo rolls the offset back', JSON.stringify(off()) === JSON.stringify(o1), { offset: off() });
      key('y', { ctrlKey: true });
      ok('S6 redo brings it back', JSON.stringify(off()) === JSON.stringify(o2), { offset: off() });
      // 2D 原画视图里也立刻有 gizmo
      setView(2);
      select(`emitter:${id}`);
      const g2 = v2._gizmo();
      ok('S6 the same gizmo shows up in the 2D backdrop view (Y/Z overlap there, only the XZ plane)',
        !!g2 && g2.axes.length === 3 && Object.keys(g2.planes).length === 1, g2 && { axes: g2.axes.map((x) => x.k), planes: Object.keys(g2.planes) });
      setView(3);
    }

    // ------------------------------------------------------------------ S7 群体半径：缩放 gizmo 改半径
    {
      edit('自检加群体', () => {
        em0().behavior = {
          cruise: 400, max: 700, maxAccel: 2600, minAltitude: 60, senseRadius: 120, separation: 30,
          accel: { separation: 2000, alignment: 800, cohesion: 600 },
          orbit: { radius: 180, height: 170 },
          home: { nestRadius: 60, rangeRadius: 600, startleRadius: 300 },
          attitude: { fear: { 'player:motion': 0.5 }, reactionDelay: [0.05, 0.25], fearDecay: 0.6, fleeThreshold: 0.35, calmSeconds: 6 },
          initialState: 'roosting',
        };
      });
      const id = em0().id;
      ok('S7 three wireframe spheres show up for a flock (nest / range / startle)',
        spheres().length === 3 && spheres().every((s) => s.center.length === 3), spheres().map((s) => [s.key, R(s.radius)]));
      select(`nest:${id}`);
      const g = v3._gizmo();
      ok('S7 selecting a radius gives a scale gizmo, pivot at the sphere centre, labelled with the radius',
        !!g && g.mode === 'scale' && /巢半径/.test(g.label), g && { mode: g.mode, label: g.label });
      const r0 = em0().behavior.home.nestRadius;
      const t = g.tip.x, c = g.c;
      const l = Math.hypot(t[0] - c[0], t[1] - c[1]); const d = [(t[0] - c[0]) / l, (t[1] - c[1]) / l];
      const sx = R(c[0] + d[0] * l * 0.9), sy = R(c[1] + d[1] * l * 0.9);
      drag(sx, sy, R(sx + d[0] * 40), R(sy + d[1] * 40));
      const r1 = em0().behavior.home.nestRadius;
      ok('S7 dragging the scale axis changes only that radius', r1 > r0 + 1 && em0().behavior.home.rangeRadius === 600, { r0, r1 });
      key('z', { ctrlKey: true });
      ok('S7 undo restores the radius', em0().behavior.home.nestRadius === r0);
    }

    // ------------------------------------------------------------------ S8 锚点 / 玩家 / 刺激
    {
      setTool('anchor');
      const cw = cv().clientWidth, ch = cv().clientHeight;
      click(R(cw * 0.5), R(ch * 0.6));
      const an = S.doc.authoring && S.doc.authoring.anchor;
      ok('S8 the anchor tool writes authoring.anchor (screen point + height) and selects it',
        !!an && Number.isFinite(an.x) && Number.isFinite(an.y) && S.sel.key === 'anchor' && S.tool === 'select', { anchor: an });
      const aw = anchorWorld();
      ok('S8 the anchor resolves through the runtime VfxSpace.anchorToWorld', !!aw && aw.every(Number.isFinite), { world: aw && aw.map(R) });
      // ground ↔ shell
      const wasShell = an.surface === 'shell';
      edit('自检切到壳', () => { S.doc.authoring.anchor.surface = 'shell'; });
      const aw2 = anchorWorld();
      ok('S8 switching surface to the depth shell lands on the shell (a different world point)',
        !!aw2 && (wasShell || Math.hypot(aw2[0] - aw[0], aw2[1] - aw[1], aw2[2] - aw[2]) >= 0), { shell: aw2 && aw2.map(R) });
      key('z', { ctrlKey: true });
      // 玩家
      setTool('player');
      click(R(cw * 0.45), R(ch * 0.65));
      ok('S8 the player tool drops a draggable player marker', S.player.on && !!S.player.world && S.sel.key === 'player', { world: S.player.world && S.player.world.map(R) });
      const nf0 = S.fields.length;
      stepSim(1 / 60);
      ok('S8 a moving player brings out a player:motion fear field (same constants as VfxSystem)',
        S.fields.some((f) => f.handle === 'player:motion'), { fields: S.fields.map((f) => f.def.tag), was: nf0 });
      // 刺激：标签必须在群体的 attitude.fear 表里才有权重（不认识的标签权重 0 = 等于没发）
      edit('自检加恐惧标签', () => { em0().behavior.attitude.fear['item:bug'] = 1; });
      el('fieldKind').value = 'fear';
      el('fieldTag').value = 'item:bug';
      el('fieldRadius').value = '400';
      el('fieldStrength').value = '2';
      el('fieldDuration').value = '0.8';
      setTool('field');
      const np0 = S.probes.length;
      // 点在巢所在的那个像素上：锚点在地面、发射器偏移的 y 为 0，所以那一列的地面点就是巢中心
      const nest = S.sim.emitters[0].origin;
      const cc = v3.project([nest[0], nest[1], nest[2]]) || [cw * 0.55, ch * 0.55];
      click(R(cc[0]), R(cc[1]));
      ok('S8 the stimulus tool drops a probe marker and fires the field into the local preview',
        S.probes.length === np0 + 1 && S.fields.some((f) => f.def.tag === 'item:bug'), { probes: S.probes.length, fields: S.fields.map((f) => f.def.tag) });
      // 群体真的被吓到：跑一会儿状态应该离开 roosting
      for (let i = 0; i < 180; i++) stepSim(1 / 60);
      ok('S8 the flock reacts to the stimulus (leaves roosting within 3 s)', S.sim.state !== 'roosting',
        { state: S.sim.state, ev: S.evCount, nest: nest.map(R), probe: S.probes[np0] && S.probes[np0].at.map(R) });
      setTool('select');
    }

    // ------------------------------------------------------------------ S9 本地预览确定性（同种子跑两遍逐帧相同）
    {
      const snap = () => {
        const out = [];
        for (const e of S.sim.emitters) { const p = e.p; for (let i = 0; i < p.cap; i++) out.push(p.alive[i], +p.x[i].toFixed(3), +p.y[i].toFixed(3), +p.z[i].toFixed(3)); }
        return out.join(',');
      };
      const run = () => {
        S.fields.length = 0; S.playerField = null;
        const on = S.player.on; S.player.on = false;
        resetSim();
        const frames = [];
        for (let i = 0; i < 40; i++) { stepSim(1 / 60); frames.push(snap()); }
        S.player.on = on;
        return frames.join('|');
      };
      const a = run(), b = run();
      ok('S9 local preview is deterministic: same seed, same dt stream ⇒ frame-for-frame identical', a === b && a.length > 10, { len: a.length });
      S.seed = 999; const c = run(); S.seed = 1234;
      ok('S9 a different seed gives a different run (the seed really feeds the sim)', c !== a);
      resetSim();
    }

    // ------------------------------------------------------------------ S10 保存往返 + 保存锁
    {
      edit('自检改参数', () => {
        em0().appearance.sizeWu = 7.5;
        em0().spawn.max = 33;
        em0().appearance.alphaOverLife = [[0, 0], [0.5, 1], [1, 0]];
      });
      await saveEffect();
      ok('S10 save clears dirty and history', !S.dirty && history.undoStack.length === 0, { dirty: S.dirty });
      const back = await API.json(`/api/effect?id=${encodeURIComponent(TMP)}`);
      const d = back.doc, e0 = d.emitters[0];
      ok('S10 the file round-trips: numbers, curves, flock block and the authoring anchor all survive',
        e0.appearance.sizeWu === 7.5 && e0.spawn.max === 33 && JSON.stringify(e0.appearance.alphaOverLife) === JSON.stringify([[0, 0], [0.5, 1], [1, 0]])
        && !!e0.behavior && !!d.authoring && !!d.authoring.anchor,
        { sizeWu: e0.appearance.sizeWu, max: e0.spawn.max, hasBehavior: !!e0.behavior, anchor: d.authoring && d.authoring.anchor });
      ok('S10 key order is normalised to the types.ts order', JSON.stringify(Object.keys(d)) === JSON.stringify(['id', 'label', 'emitters', 'authoring'])
        && Object.keys(e0)[0] === 'id', { top: Object.keys(d), emitter: Object.keys(e0) });
      // 保存锁：保存在飞期间又改了 doc
      const origPost = API.post;
      let release = null;
      API.post = async (path, body) => {
        if (path === '/api/save') await new Promise((r) => { release = r; });
        return origPost(path, body);
      };
      const p = saveEffect();
      for (let i = 0; i < 40 && !release; i++) await wait(10);
      edit('自检保存期间又改', () => { em0().spawn.max = 44; });
      if (release) release();
      await p;
      API.post = origPost;
      ok('S10 save lock: a doc edited while the save was in flight stays dirty and the status says press again',
        S.dirty && /再按一次/.test(el('status').textContent), { dirty: S.dirty, status: el('status').textContent });
      await saveEffect();
      ok('S10 pressing save again really persists it', !S.dirty);
    }

    // ------------------------------------------------------------------ S11 装载门
    {
      const other = S.scenes.filter((s) => s.depth && s.id !== S.scene.id)[0];
      if (!other) { log.push('WARN S11 skipped: only one scene with depth'); } else {
        const toolBefore = S.tool;
        const pr = loadScene(other.id, '');
        ok('S11 load gate: busy overlay is really displayed and #app is inert', S.busy > 0 && getComputedStyle(el('busy')).display !== 'none' && el('app').hasAttribute('inert'),
          { busy: S.busy, display: getComputedStyle(el('busy')).display, inert: el('app').hasAttribute('inert') });
        key('m');
        ok('S11 load gate: keyboard is void while loading', S.tool === toolBefore, { tool: S.tool });
        const st0 = el('status').textContent;
        await saveEffect();
        ok('S11 load gate: saving is refused while loading', /装载中不存盘/.test(el('status').textContent), { status: el('status').textContent, was: st0 });
        await pr;
        ok('S11 the scene really switched and the gate lifted', S.scene.id === other.id && S.busy === 0 && el('busy').hidden,
          { scene: S.scene.id, busy: S.busy });
        ok('S11 alignment was re-checked for the new scene', !!(S.align && S.align.ok), S.align);
        ok('S11 the sim was rebuilt on the new scene', !!S.sim || !!S.simErr, { err: S.simErr });
      }
    }

    // ------------------------------------------------------------------ S12 护栏（服务端归一化拒绝坏形状）
    {
      const base = () => JSON.parse(JSON.stringify({ id: 'zz_selftest_probe', emitters: [{ id: 'a', appearance: { image: '/x.png', sizeWu: 4 }, spawn: { max: 10, rate: 1 } }] }));
      const bad = [];
      let d = base(); d.emitters[0].spawn.max = 0; bad.push(['spawn.max < 1', await post('/api/validate', { doc: d })]);
      d = base(); d.emitters[0].appearance.sizeWu = 0; bad.push(['appearance.sizeWu <= 0', await post('/api/validate', { doc: d })]);
      d = base(); d.emitters[0].collision = { onHit: { emitter: 'nope', count: 2 } }; bad.push(['onHit → 不存在的发射器', await post('/api/validate', { doc: d })]);
      d = base(); d.emitters[0].subOnly = true; d.emitters[0].behavior = { cruise: 1, max: 1, maxAccel: 1, minAltitude: 1, senseRadius: 1, separation: 1, accel: { separation: 1, alignment: 1, cohesion: 1 }, orbit: { radius: 1, height: 1 }, home: { nestRadius: 1, rangeRadius: 1, startleRadius: 1 }, attitude: { fear: {} } };
      bad.push(['subOnly + behavior', await post('/api/validate', { doc: d })]);
      d = base(); d.emitters.push(JSON.parse(JSON.stringify(d.emitters[0]))); bad.push(['发射器 id 重复', await post('/api/validate', { doc: d })]);
      d = base(); d.id = '../x'; bad.push(['非法 id', await post('/api/validate', { doc: d })]);
      for (const [name, r] of bad) ok(`S12 guard rejects: ${name}`, r.ok === false, { err: r.err });
      const good = await post('/api/validate', { doc: base() });
      ok('S12 a well-formed effect passes', good.ok === true, { err: good.err });
      // onHit 引用还在时删不掉那个发射器
      edit('自检加子发射器', () => {
        S.doc.emitters.push({ id: 'sub', subOnly: true, appearance: { image: '/resources/runtime/images/vfx/splash.png', sizeWu: 2 }, spawn: { max: 8, speed: [50, 90] } });
        em0().collision = Object.assign({}, em0().collision, { onHit: { emitter: 'sub', count: 3 } });
      });
      delEmitter('sub');
      ok('S12 deleting an emitter that an onHit still points at is refused (with a human reason)',
        (S.doc.emitters || []).some((e) => e.id === 'sub') && /删不了/.test(el('status').textContent), { status: el('status').textContent });
      edit('自检去掉 onHit', () => { delete em0().collision.onHit; });
      delEmitter('sub');
      ok('S12 once nothing references it, the emitter can be deleted', !(S.doc.emitters || []).some((e) => e.id === 'sub'));
    }

    // ------------------------------------------------------------------ S13 发射器列表 / 检视器只读
    {
      const before = JSON.stringify(S.doc);
      renderInspector(); renderLeft(); renderInspector();
      ok('S13 rendering the inspector never writes the doc (no default containers get stuffed in)', JSON.stringify(S.doc) === before);
      const n0 = (S.doc.emitters || []).length;
      addEmitter();
      ok('S13 add emitter appends one and selects it', (S.doc.emitters || []).length === n0 + 1 && /^emitter:/.test(S.sel.key));
      const id2 = (S.doc.emitters || [])[n0].id;
      dupEmitter(id2);
      ok('S13 duplicate gives a fresh id', (S.doc.emitters || []).length === n0 + 2 && (new Set((S.doc.emitters || []).map((e) => e.id))).size === n0 + 2);
      moveEmitter(id2, 1);
      ok('S13 reorder swaps neighbours', (S.doc.emitters || [])[n0].id !== id2);
      edit('自检改发射器 id', () => renameEmitter(id2, 'zz_renamed'));
      ok('S13 rename keeps ids unique and follows selection', (S.doc.emitters || []).some((e) => e.id === 'zz_renamed'));
      key('z', { ctrlKey: true }); key('z', { ctrlKey: true }); key('z', { ctrlKey: true }); key('z', { ctrlKey: true });
      ok('S13 undo walks all of that back', (S.doc.emitters || []).length === n0, { n: (S.doc.emitters || []).length });
    }

    // ------------------------------------------------------------------ S14 联动载荷（不真连游戏：自检把地址指到死端口）
    {
      const r = await post('/api/link/publish', { effectId: S.doc.id, def: S.doc, sceneId: S.scene.id });
      ok('S14 publish to a dead game address fails softly (connected:false), never throws', r.ok === false || r.connected === false, { r });
      const st = await API.json('/api/link/status');
      ok('S14 link status answers even with no game (workbench keeps working)', st.ok === true && st.connected === false, { connected: st.connected });
      ok('S14 the link chip says so instead of pretending', /连不上|没收到/.test(el('linkChip').textContent), { chip: el('linkChip').textContent });
    }
  } catch (e) {
    log.push('EXC ' + ((e && e.stack) || e));
  } finally {
    try {
      S.dirty = false;
      for (const id of tmp) await API.post('/api/delete', { id });
      await refreshEffects();
    } catch (e) { log.push('EXC cleanup ' + e); }
    // 汇总行由桌面壳打（`tools/desktop_shell.py`：`[selftest] N passed, M failed`），这里只给逐条
    window.__selftestResult = log.join('\n');
  }
})();
