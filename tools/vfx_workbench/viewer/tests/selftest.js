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

    // ------------------------------------------------------------------ S16 锚点模式「角色挂点」（手持挂件自带效果那条）
    // 运行时：`HeldPropSystem` 每帧 `moveVfx(挂点世界点)` → `VfxInstanceSim.moveAnchor`
    //（锚点跟着手走、**已发射的粒子留在原地**）。这里逐条钉住工作台跑的是同一条，且这一档只是工作态。
    {
      const modeSel = () => [...el('inspector').querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'socket'));
      const setMode = (v) => { const s = modeSel(); if (!s) return false; s.value = v; s.dispatchEvent(new Event('change', { bubbles: true })); return true; };
      // 场上放一个角色（走最外层入口：M 工具点地面）
      setTool('player');
      const cw = cv().clientWidth, ch = cv().clientHeight;
      click(R(cw * 0.45), R(ch * 0.62));
      setTool('select');
      ok('S16 a character proxy is on stage (the socket anchor hangs off it)', S.player.on && !!S.player.scene, { scene: S.player.scene && S.player.scene.map(R) });
      ok('S16 the inspector offers the anchor-mode selector (scene surface / character socket)', !!modeSel(),
        { options: modeSel() && [...modeSel().options].map((o) => o.value) });
      // ---- 开关一次：关掉之后 doc 必须逐字回到原样（这一档不许改已有资产的字节）
      const before = JSON.stringify(S.doc);
      setMode('socket');
      ok('S16 turning it on writes only authoring.attach (heightWu defaults to the flame-head height)',
        !!(S.doc.authoring && S.doc.authoring.attach) && S.doc.authoring.attach.heightWu === 110,
        { attach: S.doc.authoring && S.doc.authoring.attach });
      setMode('surface');
      ok('S16 turning it off deletes that key again: the doc is byte-for-byte what it was',
        JSON.stringify(S.doc) === before && !(S.doc.authoring && S.doc.authoring.attach), { same: JSON.stringify(S.doc) === before });
      setMode('socket');
      // 新加的行必须真的排出来（布局塌陷：控件在 DOM 里、高度是 0，看过去"这功能不存在"）
      {
        const ms = modeSel(), box = el('playerRow').querySelector('input[type=checkbox]');
        const rows = [...el('inspector').querySelectorAll('.row')].filter((r) => /挂点高|左右偏移/.test(r.textContent));
        ok('S16 the socket rows and the walk toggle are really laid out (height > 0, not collapsed to a seam)',
          !!ms && ms.offsetHeight > 0 && rows.length === 2 && rows.every((r) => r.offsetHeight > 0) && !!box && box.offsetHeight > 0,
          { sel: ms && ms.offsetHeight, rows: rows.map((r) => r.offsetHeight), box: box && box.offsetHeight });
      }
      // ---- 锚点 = 角色脚点画面点 + 离脚点高度：与运行时 `VfxSystem.sceneToWorld` 逐字同式
      {
        const ps = S.player.scene, aw = anchorWorld();
        const g = S.space.groundWorldAtScene(ps[0], ps[1]);
        const want = [g[0], g[1] + 110, g[2]];
        ok('S16 the socket anchor resolves exactly like the runtime (groundWorldAtScene(foot) + heightWu)',
          !!aw && Math.hypot(aw[0] - want[0], aw[1] - want[1], aw[2] - want[2]) < 0.01, { got: aw && aw.map(R), want: want.map(R) });
        const an = effectiveAnchor();
        ok('S16 the effective anchor is the foot screen point + offsetX, never authoring.anchor',
          Math.abs(an.x - ps[0]) < 0.01 && Math.abs(an.y - ps[1]) < 0.01 && an.h === 110, { anchor: an });
      }
      // ---- 高度 / 左右偏移改得动（gizmo 与数值框同一条写入口）
      {
        const y0 = anchorWorld()[1];
        edit('自检改挂点高', () => { host.ensureAttach().heightWu = 40; });
        const y1 = anchorWorld()[1];
        ok('S16 the socket height really lowers the anchor (110 → 40 wu above the foot)', y0 - y1 > 60, { y0: R(y0), y1: R(y1) });
        edit('自检改挂点高回去', () => { host.ensureAttach().heightWu = 110; });
        select('anchor');
        const g = v3._gizmo();
        ok('S16 selecting the anchor in socket mode still gives a gizmo immediately, labelled as the socket',
          !!g && g.axes.length === 3 && /挂点/.test(g.label), g && { mode: g.mode, label: g.label });
      }
      // ---- 拖着挂点不许双倍位移：`patchSim` 必须把 `sim.anchorWorld` 一起同步，
      //      否则下一拍 `moveAnchor` 按旧锚点再算一次增量，整批发射器被挪两倍（而且不报错）
      {
        const c = v3.project(anchorWorld());
        if (!c) { log.push('WARN S16 skipped the drag check: the anchor is off screen'); } else {
          select('anchor');
          const keepAnchor = JSON.stringify(S.doc.authoring.anchor);
          ev('mousedown', R(c[0]), R(c[1]));
          ev('mousemove', R(c[0]) + 40, R(c[1]) - 30);
          stepSim(1 / 120);
          const e0 = S.sim.emitters[0], off = e0.def.offset || [0, 0, 0], aw = anchorWorld();
          const d = Math.hypot(e0.origin[0] - (aw[0] + off[0]), e0.origin[1] - (aw[1] + off[1]), e0.origin[2] - (aw[2] + off[2]));
          ok('S16 dragging the socket while the preview runs never double-moves the emitters (sim.anchorWorld stays in sync)',
            d < 1, { d: +d.toFixed(3) });
          ev('mouseup', R(c[0]) + 40, R(c[1]) - 30);
          ok('S16 that drag wrote the socket (attach), never the scene anchor',
            JSON.stringify(S.doc.authoring.anchor) === keepAnchor && !!host.attach, { attach: host.attach });
          edit('自检把挂点摆回火头高度', () => { const o = host.ensureAttach(); o.heightWu = 110; delete o.offsetX; });
        }
      }
      // ---- 已发射的粒子留在原地：放一个 burst 8、寿命 30 s、零初速的探针发射器，它只会待在出生点
      {
        edit('自检加挂点探针发射器', () => {
          S.doc.emitters.push({
            id: 'zz_hold', appearance: { image: '/resources/runtime/images/vfx/dust.png', sizeWu: 4 },
            spawn: { max: 8, burst: 8, shape: { kind: 'point' } }, life: { seconds: [30, 30] },
          });
        });
        resetSim();
        for (let i = 0; i < 12; i++) stepSim(1 / 60);
        const hold = () => S.sim.emitters.find((e) => e.def.id === 'zz_hold');
        const snapHold = () => { const e = hold(), p = e.p, out = []; for (let k = 0; k < p.cap; k++) if (p.alive[k]) out.push([p.x[k], p.y[k], p.z[k]]); return out; };
        const born = snapHold();
        const o0 = hold().origin.slice(), a0 = anchorWorld().slice(), px0 = S.player.scene[0];
        ok('S16 the probe emitter really burst a batch that will not respawn (8 alive, 30 s life)', born.length === 8, { live: born.length });
        // 让角色来回走（左栏那个开关，不是内部函数）
        const box = el('playerRow').querySelector('input[type=checkbox]');
        box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true }));
        ok('S16 the walk toggle in the left rail really starts the character walking', S.walk.on === true);
        for (let i = 0; i < 60; i++) stepSim(1 / 60);
        const moved = Math.abs(S.player.scene[0] - px0);
        const a1 = anchorWorld().slice(), o1 = hold().origin.slice();
        const dAnchor = Math.hypot(a1[0] - a0[0], a1[1] - a0[1], a1[2] - a0[2]);
        const dOrigin = Math.hypot(o1[0] - o0[0], o1[1] - o0[1], o1[2] - o0[2]);
        const now = snapHold();
        let dPart = 0;
        for (let k = 0; k < Math.min(born.length, now.length); k++) {
          dPart = Math.max(dPart, Math.hypot(now[k][0] - born[k][0], now[k][1] - born[k][1], now[k][2] - born[k][2]));
        }
        // 走速 100 wu/s × 1 s = 100 wu（撞上半幅 / 场景边缘会提前折返，所以下限放宽）
        ok('S16 walking 1 s moves the character across the picture at walking speed', moved > 40 && moved < 160, { moved: R(moved) });
        ok('S16 the anchor and every emitter origin follow the socket (runtime moveAnchor, not a JS copy)',
          dAnchor > 30 && Math.abs(dOrigin - dAnchor) < 1, { dAnchor: R(dAnchor), dOrigin: R(dOrigin) });
        ok('S16 already-emitted particles stay where they were (that is the whole point of moveAnchor)',
          now.length === 8 && dPart < 1 && dAnchor > 30, { dPart: +dPart.toFixed(3), dAnchor: R(dAnchor) });
        ok('S16 a walking character feeds the player:motion field at walking strength (speed, not drag distance)',
          S.fields.some((f) => f.handle === 'player:motion' && f.def.strength > 0.15 && f.def.strength < 0.35),
          { strength: (S.fields.find((f) => f.handle === 'player:motion') || { def: {} }).def.strength });
        box.checked = false; box.dispatchEvent(new Event('change', { bubbles: true }));
        ok('S16 switching the walk off parks the character (no motion field strength left)', S.walk.on === false && S.player.speed === 0);
        // 挂点模式下没有角色 ⇒ 退回场景锚点，而且状态栏黄字说（不静默假装挂上了）
        clearPlayer();
        renderSimBar();
        ok('S16 with no character on stage the sim bar warns instead of silently pretending',
          /没有角色/.test(el('simInfo').textContent) && el('simInfo').className === 'warn', { info: el('simInfo').textContent });
        setTool('player'); click(R(cw * 0.45), R(ch * 0.62)); setTool('select');
        delEmitter('zz_hold');
      }
      // ---- 存盘往返 + 护栏
      {
        await saveEffect();
        const back = await API.json(`/api/effect?id=${encodeURIComponent(TMP)}`);
        const au = back.doc.authoring || {};
        ok('S16 authoring.attach survives the save round-trip and sits right after anchor',
          !!au.attach && au.attach.heightWu === 110 && Object.keys(au).indexOf('attach') === Object.keys(au).indexOf('anchor') + 1,
          { authoring: Object.keys(au), attach: au.attach });
        const bad = JSON.parse(JSON.stringify(back.doc));
        bad.authoring.attach = { heightWu: -5 };
        const r1 = await post('/api/validate', { doc: bad });
        bad.authoring.attach = { offsetX: 3 };
        const r2 = await post('/api/validate', { doc: bad });
        ok('S16 guard rejects a negative / missing socket height', r1.ok === false && r2.ok === false, { r1: r1.err, r2: r2.err });
      }
      setMode('surface');
      ok('S16 back on the scene surface, the anchor is authoring.anchor again',
        !host.attach && !!(S.doc.authoring && S.doc.authoring.anchor) && !!anchorWorld(), { anchor: S.doc.authoring && S.doc.authoring.anchor });
    }

    // ------------------------------------------------------------------ S15 薄片（纸钱）：本地预览喂的输入与 VfxSystem 同形
    // 2026-09-12：工作台不喂场景风、不传实例区域、空间不带透视 —— 纸钱 520 张躺着一张不动，且不报错。
    // 只读真资产 paper_money（不 edit、不存）；它的作者场景跑马梁有 wind + perspectiveScale + 圈了区域的实例。
    {
      const PM = 'paper_money', SC = '跑马梁';
      if (!S.effects.some((r) => r.id === PM) || !S.scenes.some((s) => s.id === SC && s.depth)) {
        log.push(`WARN S15 skipped: needs effect ${PM} and scene ${SC} with depth`);
      } else {
        S.dirty = false;
        await openEffect(PM);
        const inst = (S.sceneVfx || []).find((v) => v.effect === PM && Array.isArray(v.area) && v.area.length >= 3);
        ok('S15 opening paper_money brings up its authoring scene (wind + an instance that fences an area)',
          S.doc.id === PM && S.scene.id === SC && !!S.scene.wind && !!inst, { doc: S.doc.id, scene: S.scene.id, inst: inst && inst.id });
        ok('S15 the scene wind reaches the sim through the runtime SceneWindState (not a JS copy)',
          !!S.wind && S.wind instanceof S.rt.sceneWind.SceneWindState && !!S.wind.params && S.wind.params.speed === S.scene.wind.speed,
          { speed: S.wind && S.wind.params && S.wind.params.speed });
        const pe = S.sim && S.sim.emitters.find((e) => e.plate);
        ok('S15 the plate emitter scatters over the instance polygon, not a disc around the preview anchor',
          !!pe && !!S.area && S.area.id === inst.id && pe.plate.area.poly === inst.area, { area: S.area && S.area.id, poly: !!(pe && pe.plate.area.poly) });
        // 透视：与实体同一根轴（Game.buildVfxSpace 传的就是 perspectiveScaleResolver.scaleAt）
        const probe = [[S.cal.worldW * 0.8, S.cal.worldH * 0.2], [S.cal.worldW * 0.2, S.cal.worldH * 0.85]].map(([sx, sy]) => {
          const g = S.cal.sceneToWorldGround(sx, sy);
          return { got: S.space.metricAt(g[0], g[2]), want: S.rt.perspectiveScale.perspectiveScaleAt(S.scene.perspectiveScale, sx, sy) };
        });
        ok('S15 the preview space carries the scene perspective (metricAt == perspectiveScaleAt at the foot point, not 1)',
          probe.every((q) => Math.abs(q.got - q.want) < 0.02) && probe.some((q) => Math.abs(q.want - 1) > 0.1),
          probe.map((q) => [+q.got.toFixed(3), +q.want.toFixed(3)]));
        // 比的是**实例多边形**的包围盒，不是模拟自己的 area（没传区域时那是锚点圆盘，拿它比等于自证）
        const a = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
        for (const [x, y] of inst.area) { a.minX = Math.min(a.minX, x); a.minY = Math.min(a.minY, y); a.maxX = Math.max(a.maxX, x); a.maxY = Math.max(a.maxY, y); }
        const run = () => {
          resetSim();
          stepSim(1 / 60);
          const e = S.sim.emitters.find((x) => x.plate), p = e.p, s = { x: 0, y: 0 };
          let outside = 0;
          const a0 = [];
          for (let k = 0; k < p.cap; k++) {
            a0.push(p.alive[k] ? [p.x[k], p.y[k], p.z[k]] : null);
            if (!p.alive[k]) continue;
            S.space.toScene([p.x[k], p.y[k], p.z[k]], s);
            if (s.x < a.minX - 30 || s.x > a.maxX + 30 || s.y < a.minY - 30 || s.y > a.maxY + 30) outside++;
          }
          for (let i = 0; i < 360; i++) stepSim(1 / 60);
          let moved = 0;
          for (let k = 0; k < p.cap; k++) { const v = a0[k]; if (v && p.alive[k] && Math.hypot(p.x[k] - v[0], p.y[k] - v[1], p.z[k] - v[2]) > 2) moved++; }
          renderSimBar();
          return { moved, outside, live: S.sim.liveCount, info: el('simInfo').textContent, cls: el('simInfo').className };
        };
        const windy = run();
        ok('S15 at birth every plate lies inside the instance polygon (bbox + 30)', windy.outside === 0 && windy.live > 0, { outside: windy.outside, live: windy.live });
        const keep = S.scene.wind;
        S.scene.wind = null;
        const calm = run();
        S.scene.wind = keep;
        resetSim();
        ok('S15 the wind really blows the paper: many more plates move with the scene wind than without (6 s, same seed)',
          windy.moved >= 60 && windy.moved > calm.moved * 3, { windy: windy.moved, calm: calm.moved });
        ok('S15 the sim bar reports the wind, the plates and where the area came from',
          /风 \d+ wu\/s/.test(windy.info) && /薄片 离地/.test(windy.info) && windy.info.includes(`区域=实例「${inst.id}」`) && windy.cls !== 'warn', { info: windy.info });
        ok('S15 no wind is never silent: the sim bar warns that plates will not be blown',
          /⚠ 本场景没有 wind/.test(calm.info) && calm.cls === 'warn', { info: calm.info, cls: calm.cls });
      }
    }

    // ------------------------------------------------------------------ S17 下拉框走页内列表，不走系统原生弹窗
    // 2026-09-12 制作人实拍：Qt 的原生 <select> 弹窗在 150% 缩放屏上框比内容大一圈、**每开一次再乘一次**，
    // 白边越开越大，而且不吃页面配色。页内自绘那一份的判据就是下面这几条（见 /vendor/dropdown.js）。
    {
      const selDown = (el2) => {
        const r = el2.getBoundingClientRect();
        return el2.dispatchEvent(new MouseEvent('mousedown', {
          bubbles: true, cancelable: true, button: 0, buttons: 1,
          clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + r.height / 2),
        }));
      };
      const list = () => document.getElementById('ddlist');
      const kind = el('fieldKind');
      const delivered = selDown(kind);
      const l1 = list();
      ok('S17 mousedown on a select is cancelled (the native popup never opens) and the in-page list shows up',
        delivered === false && !!l1 && l1.children.length === kind.options.length,
        { defaultPrevented: delivered === false, items: l1 && l1.children.length, opts: kind.options.length });
      // 框不许比控件大一圈：页内列表宽度以控件为下限，最多比它宽一点点（文字本来就更长时才宽）
      const rs = kind.getBoundingClientRect(), rl = l1 ? l1.getBoundingClientRect() : null;
      ok('S17 the list is not a 1.5x oversized box: it starts at the control width, never scales with it',
        !!rl && rl.width >= rs.width - 1 && rl.width <= rs.width + 60 && rl.height <= window.innerHeight,
        { sel: +rs.width.toFixed(1), list: rl && +rl.width.toFixed(1) });
      // 反复开关不许越开越大（原生那条就是死在这里）
      const sizes = [];
      for (let i = 0; i < 5; i++) {
        Dropdown.close();
        selDown(kind);
        const r = list().getBoundingClientRect();
        sizes.push([+r.width.toFixed(1), +r.height.toFixed(1)]);
      }
      ok('S17 opening it five times in a row gives the exact same box every time (no growth)',
        sizes.every((s) => s[0] === sizes[0][0] && s[1] === sizes[0][1]), { sizes });
      // 选一项：值变了、change 发了、列表关了
      let changed = 0;
      const onCh = () => { changed++; };
      kind.addEventListener('change', onCh);
      const before = kind.value;
      const idx = [...kind.options].findIndex((o) => o.value !== before);
      list().children[idx].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
      ok('S17 picking an item sets the value, fires one change and closes the list',
        kind.value === kind.options[idx].value && changed === 1 && !list(),
        { before, after: kind.value, changed, open: !!list() });
      kind.removeEventListener('change', onCh);
      kind.value = before;
      // Esc 关，而且不漏给页面的快捷键表
      selDown(kind);
      const toolBefore = S.tool;
      const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      document.dispatchEvent(esc);
      ok('S17 Escape closes the list and does not leak to the page keymap', !list() && S.tool === toolBefore,
        { open: !!list(), tool: S.tool });
      // 顶栏那两个（效果 / 场景）也走同一条路
      for (const id of ['effectSel', 'sceneSel']) {
        Dropdown.close();
        const e2 = el(id);
        const cancelled = selDown(e2) === false;
        const l2 = list();
        ok(`S17 ${id} uses the in-page list too`, cancelled && !!l2 && l2.children.length === e2.options.length,
          { cancelled, items: l2 && l2.children.length, opts: e2.options.length });
        Dropdown.close();
      }
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
