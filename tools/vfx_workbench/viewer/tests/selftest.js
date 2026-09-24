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
    {
      // 开页先开效果、由它决定装哪个场景：它有布置就停在布置它的那一份上（原来停在第一个有深度的场景，
      // 作者第一眼只看到"本场景本时段没有布置这个效果"），而且只装一遍场景
      const refs = libRefs(S.doc.id);
      ok('S1 boot opens the effect where it is placed (scene × appearance of one of its placements)',
        !refs.length || refs.some((r) => r.sceneId === S.scene.id && r.phase === S.phase), { scene: S.scene.id, phase: S.phase, refs: refs.slice(0, 3) });
    }

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
      // 下面 S5–S16 的手势坐标是按"第一个有深度的场景"标的（锚点点在地面上、刺激点落在巢上）：显式装回它，
      // 不跟着开页场景变（开页现在停在效果布置的地方，那里一下点在崖壁上，后面的前提就全不成立了）
      const base = S.scenes.find((s) => s.depth);
      if (base && S.scene.id !== base.id) await loadScene(base.id, '');
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
        em0().simulation = S.rt.vfxProgram.newEmitterProgram('flock');
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
      const undoBeforeSave = history.undoStack.length;
      await saveEffect();
      // 存盘不清撤销栈：存完才发现删错了 / 拉错了，Ctrl+Z 还得回得去（2026-09-14 日常流程审查）
      ok('S10 save clears dirty but keeps the undo stack (Ctrl+Z still walks back past a save)',
        !S.dirty && history.undoStack.length === undoBeforeSave && undoBeforeSave > 0, { dirty: S.dirty, undo: history.undoStack.length, was: undoBeforeSave });
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
      // 没有改动时 Ctrl+S 不发请求（不重写盘上那份）：保存锁要先有一处改动才测得到
      edit('自检保存锁前改', () => { em0().spawn.max = 40; });
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
      {
        let posted = 0;
        API.post = async (path, body) => { if (path === '/api/save' || path === '/api/placements/save') posted++; return origPost(path, body); };
        await saveEffect();
        API.post = origPost;
        ok('S10 Ctrl+S with nothing unsaved sends no write and says so (the file on disk is not rewritten)',
          posted === 0 && /没有未保存的改动/.test(el('status').textContent), { posted, status: el('status').textContent });
      }
    }

    // ------------------------------------------------------------------ S11 装载门
    {
      const other = S.scenes.filter((s) => s.depth && s.id !== S.scene.id)[0];
      if (!other) { log.push('WARN S11 skipped: only one scene with depth'); } else {
        const toolBefore = S.tool;
        // S8 在上一个场景里放了玩家、发了刺激：换场景后它们的世界坐标没有意义
        if (!S.player.on) setPlayerSceneAt(S.cal.worldW / 2, S.cal.worldH * 0.7, 0);
        if (!S.probes.length) S.probes.push({ at: anchorWorld().slice(), field: { kind: 'fear', tag: 'item:bug', radius: 100, strength: 1 } });
        // S8 那一发是 0.8 s 的脉冲，早就散了：补一个常驻场（换场景后它也得没了）
        if (!S.fields.length && S.rt) S.fields.push(S.rt.vfxSim.createFieldRuntime(S.probes[0].field, S.probes[0].at));
        const had36 = { player: S.player.on, probes: S.probes.length, fields: S.fields.length };
        select('player');
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
        ok('S20 #36 switching to another scene drops the previous scene\'s player marker, stimulus points and live fields (and their selection)',
          had36.player && had36.probes > 0 && had36.fields > 0 && !S.player.on && !S.player.world && !S.player.scene && S.probes.length === 0
          && S.fields.length === 0 && !S.playerField && S.sel.key === '' && !objects().some((o) => o.key === 'player' || /^probe:/.test(o.key)),
          { had36, player: S.player.on, probes: S.probes.length, fields: S.fields.length, sel: S.sel.key });
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
      renderLinkChip();
      ok('S14 the link chip says so instead of pretending — neutrally (no game is the normal case, not a red error)',
        /游戏没开/.test(el('linkChip').textContent) && !el('linkChip').classList.contains('bad'), { chip: el('linkChip').textContent, cls: el('linkChip').className });
      {
        // 送不到不算推过：原来失败也记 lastPub，拉起游戏后要等三分钟保活才补推工作态
        const lp0 = S.link.lastPub;
        const pr = await publishNow(null);
        ok('S14 a publish that did not reach the game does not count as published (no red "rejected", lastPub untouched)',
          !!pr && pr.ok === false && S.link.lastPub === lp0 && !S.link.rejected, { r: pr, lastPub: S.link.lastPub, rejected: S.link.rejected });
      }
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
        S.dirty = false; S.docDirty = false;
        // 从外面打进来（桌面壳 --open / 主编辑器）= jump：去它布置的那一份
        await openEffect(PM, { jump: true });
        // 布置搬进了布置库（自检进程里是临时拷贝）：作者场景那套外观里布置了它、而且圈了发射区域的那条
        const inst = curRows().find((v) => v.effect === PM && Array.isArray(v.area) && v.area.length >= 3);
        ok('S15 opening paper_money from outside brings up the scene it is placed in (wind + a placement that fences an area)',
          S.doc.id === PM && S.scene.id === SC && !!S.scene.wind && !!inst, { doc: S.doc.id, scene: S.scene.id, phase: S.phase, inst: inst && inst.id });
        ok('S15 the scene wind reaches the sim through the runtime SceneWindState (not a JS copy)',
          !!S.wind && S.wind instanceof S.rt.sceneWind.SceneWindState && !!S.wind.params && S.wind.params.speed === S.scene.wind.speed,
          { speed: S.wind && S.wind.params && S.wind.params.speed });
        const pe = S.sim && S.sim.emitters.find((e) => e.plate);
        ok('S15 the plate emitter scatters over the placement polygon, not a disc around the preview anchor',
          !!pe && !!S.area && S.area.id === inst.id && JSON.stringify(pe.plate.area.poly) === JSON.stringify(inst.area), { area: S.area && S.area.id, poly: !!(pe && pe.plate.area.poly) });
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
          windy.moved >= Math.min(60, windy.live * 0.2) && windy.moved > calm.moved * 3, { windy: windy.moved, calm: calm.moved, live: windy.live });
        ok('S15 the sim bar reports the wind, the plates and where the area came from',
          /风 \d+ wu\/s/.test(windy.info) && /薄片 离地/.test(windy.info) && windy.info.includes(`区域=布置「${inst.id}」`) && windy.cls !== 'warn', { info: windy.info });
        ok('S15 absent scene wind is visible and the sim bar points to the independent input settings',
          /本场景无持续风/.test(calm.info) && /局部气流和刺激/.test(calm.info) && calm.cls === 'warn', { info: calm.info, cls: calm.cls });
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

    // ------------------------------------------------------------------ S18 布置（场景 × 时段外观）：工作台是布置库唯一的作者面与写入者
    // 2026-09-14 制作人："粒子的布置也是在粒子工作台" / "白天和晚上是分开调节的" / "没配就没有"。
    // 全程在 zz_selftest_* 临时效果 + 自检进程的**临时布置库**上（app.py 把 placements.LIB_ROOT 指到临时目录）。
    {
      const SC = '跑马梁', NIGHT = '夜';
      const until = async (fn, ms) => { const t0 = performance.now(); while (!fn() && performance.now() - t0 < (ms || 20000)) await wait(40); return fn(); };
      const change = (id, v) => { const s = el(id); s.value = v; s.dispatchEvent(new Event('change', { bubbles: true })); };
      const scRow = S.scenes.find((s) => s.id === SC && s.depth);
      if (!scRow || !(scRow.phases || []).some((p) => p.key === NIGHT) || !S.effects.some((r) => r.id === TMP)) {
        log.push(`WARN S18 skipped: needs scene ${SC} with depth and a ${NIGHT} appearance, and temp effect ${TMP}`);
      } else {
        const boot = await API.json('/api/boot');
        ok('S18 the selftest process writes a temp placement library, never the real vfx_placements.json',
          !!boot.placements && boot.placements.real === false && S.libReal === false, boot.placements);
        S.dirty = false; S.docDirty = false;
        await openEffect(TMP, { keepScene: true });
        // S16 把「角色挂点」那一档存进了临时效果：这里要的是场景面上的锚点（布置的 anchor），角色也撤掉
        setAttachMode(false); clearPlayer();
        setView(3); setTool('select');
        // ---- 时段外观：顶栏的两个下拉（真 change 事件），换外观 = 换那套背景（3D 贴图与 2D 原画都换），几何共用
        change('sceneSel', SC);
        await until(() => S.scene && S.scene.id === SC && !S.busy);
        const baseInfo = S.scene.phases.find((p) => p.key === ''), nightInfo = S.scene.phases.find((p) => p.key === NIGHT);
        const texBase = decodeURIComponent(v3.texSrc || ''), bg2Base = decodeURIComponent((v2.bg && v2.bg.src) || '');
        ok('S18 the scene loads on its base appearance, labelled with the phases it covers',
          S.phase === '' && el('phaseSel').value === '' && texBase.includes(`bg=${baseInfo.background}`)
          && /基底/.test(el('phaseSel').selectedOptions[0].textContent) && !!baseInfo.timePhase,
          { phase: S.phase, bg: S.scene.background, tex: texBase.slice(-40), label: el('phaseSel').selectedOptions[0] && el('phaseSel').selectedOptions[0].textContent, tp: baseInfo.timePhase });
        change('phaseSel', NIGHT);
        await until(() => S.phase === NIGHT && !S.busy);
        const texNight = decodeURIComponent(v3.texSrc || ''), bg2Night = decodeURIComponent((v2.bg && v2.bg.src) || '');
        ok('S18 switching the appearance to 夜 loads that appearance\'s own background, in 3D and in the 2D backdrop',
          S.phase === NIGHT && S.scene.background === nightInfo.background && nightInfo.background !== baseInfo.background
          && texNight.includes(`bg=${nightInfo.background}`) && bg2Night.includes(`bg=${nightInfo.background}`) && !texNight.includes(`bg=${baseInfo.background}`)
          && bg2Base.includes(`bg=${baseInfo.background}`) && el('phaseSel').selectedOptions[0].textContent === nightInfo.label,
          { bg: S.scene.background, tex: texNight.slice(-50), bg2: bg2Night.slice(-50), label: el('phaseSel').selectedOptions[0].textContent });
        ok('S18 the geometry is shared between appearances (alignment still holds on the night background)', !!(S.align && S.align.ok), S.align);
        // ---- 这一份里别的效果的行灰显、带「打开这个效果」
        const other = el('placeList').querySelector('.item.other');
        ok('S18 the placement list shows the other effects\' rows greyed out with an "open this effect" button',
          !!other && [...other.querySelectorAll('button')].some((b) => /打开这个效果/.test(b.textContent)) && /布置 · .* · 入夜/.test(el('placeHead').textContent),
          { head: el('placeHead').textContent, rows: [...el('placeList').querySelectorAll('.item')].map((x) => x.className) });
        ok('S18 with no placement of this effect here, the preview says so and runs without an area',
          !activePlacement() && S.simInput && S.simInput.placement === '' && !(S.sim && S.sim.confine) && /本场景本时段没有布置这个效果/.test(el('simInfo').textContent),
          { info: el('simInfo').textContent });
        // ---- 把当前效果布置到这里（左栏按钮）
        const u0 = history.undoStack.length, doc0 = JSON.stringify(S.doc), pre = JSON.parse(JSON.stringify(sceneAnchor()));
        el('btnPlaceHere').click();
        const ap = activePlacement();
        const PID = ap && ap.id;
        ok('S18 "place the current effect here" adds a row with a unique id, anchored at the preview anchor, one history entry, effect doc untouched',
          !!ap && ap.effect === TMP && /^vfx_zz_selftest_a/.test(PID) && ap.anchor.x === round2(pre.x) && ap.anchor.y === round2(pre.y)
          && history.undoStack.length === u0 + 1 && S.libDirty && JSON.stringify(S.doc) === doc0,
          { ap, pre, undo: history.undoStack.length - u0, libDirty: S.libDirty });
        ok('S18 the new placement is selected and has a gizmo on its anchor immediately',
          S.sel.key === 'anchor' && !!v3._gizmo() && /布置锚点/.test(v3._gizmo().label), v3._gizmo() && { label: v3._gizmo().label });
        {
          // gizmo 拖锚点：改的是**布置的 anchor**，效果里的 authoring.anchor 一字不动
          const au0 = JSON.stringify((S.doc.authoring || {}).anchor || null), x0 = activePlacement().anchor.x;
          const gg = v3._gizmo(); const t = gg.tip.x, c = gg.c; const l = Math.hypot(t[0] - c[0], t[1] - c[1]); const d = [(t[0] - c[0]) / l, (t[1] - c[1]) / l];
          let s = null;
          for (const f of [0.62, 0.45, 0.78, 0.3, 0.9]) { const q = [R(c[0] + d[0] * l * f), R(c[1] + d[1] * l * f)]; const hh = v3._hit(q[0], q[1]); if (hh && hh.kind === 'gz' && hh.part === 'x') { s = q; break; } }
          if (s) drag(s[0], s[1], R(s[0] + d[0] * 40), R(s[1] + d[1] * 40));
          ok('S18 dragging the anchor gizmo moves the placement\'s anchor, never the effect\'s authoring anchor',
            !!s && Math.abs(activePlacement().anchor.x - x0) > 1 && JSON.stringify((S.doc.authoring || {}).anchor || null) === au0,
            { x0, x1: activePlacement().anchor.x, probe: !!s });
        }
        // 把锚点挪到画面右下角，别和下面拉的区域顶点叠在一起（检视器「布置」一节的数值框，真 change 事件）
        const numRow = (label) => [...el('inspector').querySelectorAll('.row')].find((r) => r.firstChild && r.firstChild.textContent === label);
        const setNum = (label, v) => { const r = numRow(label); const inp = r && r.querySelector('input'); if (!inp) return false; inp.value = String(v); inp.dispatchEvent(new Event('change', { bubbles: true })); return true; };
        const W = S.cal.worldW, H = S.cal.worldH;
        setNum('x', R(W * 0.86)); setNum('y', R(H * 0.9));
        ok('S18 the inspector\'s placement anchor fields write the placement, not the effect\'s authoring anchor',
          activePlacement().anchor.x === R(W * 0.86) && activePlacement().anchor.y === R(H * 0.9)
          && !(S.doc.authoring && S.doc.authoring.anchor && S.doc.authoring.anchor.x === R(W * 0.86)),
          { anchor: activePlacement().anchor });
        // ---- Ctrl+S：两份一起存；（临时）库盘上有它、键序对
        key('s', { ctrlKey: true });
        await ioChain;
        const disk = await API.json('/api/placements');
        const diskRow = (((disk.doc.scenes || {})[SC] || {}).variants || {})[NIGHT] ? disk.doc.scenes[SC].variants[NIGHT].find((r) => r.id === PID) : null;
        ok('S18 Ctrl+S saves the library too: the temp library on disk has the placement, key order per types.ts',
          !S.dirty && !!diskRow && JSON.stringify(Object.keys(diskRow)) === JSON.stringify(['id', 'effect', 'anchor'])
          && JSON.stringify(Object.keys(diskRow.anchor)) === JSON.stringify(['x', 'y', 'h'].filter((k) => k in diskRow.anchor)),
          { dirty: S.dirty, row: diskRow, status: el('status').textContent });
        // ---- 2D 原画视图里拉发射区域（工具条按钮 + 真鼠标拖框）
        // 场景是在 3D 里装的（2D 藏着、clientWidth = 0）：直接切到 2D 就得看到整张原画，不许靠手动 fit / Home 兜着
        setView(2); select('');
        {
          const a0 = v2.toCanvas(0, 0), b0 = v2.toCanvas(S.cal.worldW, S.cal.worldH);
          const cw2 = v2.c.clientWidth, ch2 = v2.c.clientHeight;
          ok('S20 #22 switching to 2D after the scene loaded in 3D shows the whole picture (fitted on first show, not a 1 px dot)',
            (b0[0] - a0[0]) >= cw2 * 0.9 || (b0[1] - a0[1]) >= ch2 * 0.9, { w: R(b0[0] - a0[0]), h: R(b0[1] - a0[1]), cw2, ch2, zoom: v2.zoom });
        }
        document.querySelector('#tools button[data-tool=areaEmit]').click();
        ok('S18 the area tool buttons in the tool strip really switch the tool', S.tool === 'areaEmit');
        const e0 = [W * 0.22, H * 0.5], e1 = [W * 0.46, H * 0.72];
        const c0 = v2.toCanvas(e0[0], e0[1]), c1 = v2.toCanvas(e1[0], e1[1]);
        const u1 = history.undoStack.length;
        drag(R(c0[0]), R(c0[1]), R(c1[0]), R(c1[1]));
        const emitA = areaPoly(activePlacement(), 'emit');
        const tol2 = 2 / v2.zoom;
        const near2 = (p, q) => !!p && Math.hypot(p[0] - q[0], p[1] - q[1]) <= tol2;
        ok('S18 2D: dragging a box with the emit-area tool writes a 4-point area in picture coords, one history entry, tool back to select',
          !!emitA && emitA.length === 4 && near2(emitA[0], [Math.min(e0[0], e1[0]), Math.min(e0[1], e1[1])]) && near2(emitA[2], [Math.max(e0[0], e1[0]), Math.max(e0[1], e1[1])])
          && history.undoStack.length === u1 + 1 && S.tool === 'select',
          { emitA, tol: +tol2.toFixed(2), undo: history.undoStack.length - u1 });
        {
          // 第七轮复核：布置到这里 / 打开效果都选着锚点；拉完区域还选着它，按 Delete 想删框 = 删掉整条布置
          select('anchor');
          const selBefore = S.sel.key, uA = history.undoStack.length;
          document.querySelector('#tools button[data-tool=areaEmit]').click();
          // 框拉得和上面那块稍有不同（一模一样 = 没改动、不进历史），起点也别压在现有顶点上
          const f0 = v2.toCanvas(W * 0.23, H * 0.52), f1 = v2.toCanvas(W * 0.46, H * 0.72);
          drag(R(f0[0]), R(f0[1]), R(f1[0]), R(f1[1]));
          const selAfter = S.sel.key, wrote = history.undoStack.length === uA + 1;
          key('Delete');
          await wait(250);                                   // 删布置先问接口有没有外部引用（异步）：等它落定再看
          ok('S18 drawing an area while the placement anchor is selected clears the selection; Delete then does not remove the placement',
            selBefore === 'anchor' && wrote && selAfter === '' && curRows().some((r) => r.id === PID) && activePlacement() && activePlacement().id === PID
            && !!areaPoly(activePlacement(), 'emit') && el('dialog').hidden,
            { selBefore, selAfter, wrote, rows: curRows().map((r) => r.id), status: el('status').textContent });
          // 还原成上面那块（后面的检查按那块的形状摆点）
          document.querySelector('#tools button[data-tool=areaEmit]').click();
          drag(R(c0[0]), R(c0[1]), R(c1[0]), R(c1[1]));
        }
        // ---- 3D 里拉范围区域（两角取地面拾取点再投回画面）
        setView(3); v3.fit(true);
        document.querySelector('#tools button[data-tool=areaRange]').click();
        const r0s = [W * 0.14, H * 0.42], r1s = [W * 0.6, H * 0.82];
        const p0 = P3(S.cal.sceneToWorldGround(r0s[0], r0s[1])), p1 = P3(S.cal.sceneToWorldGround(r1s[0], r1s[1]));
        // 与合成事件同一个像素（ev 里 clientX 取整过，画布左上角可能不在整像素上）
        const rr3 = cv().getBoundingClientRect();
        const px3 = (p) => [Math.round(rr3.left + p[0]) - rr3.left, Math.round(rr3.top + p[1]) - rr3.top];
        // 期望值不经 _groundScene（那是被测的一环）：直接地面拾取 + SceneCal.worldToScene
        const gs = (p) => { const w = v3.pickGround(...px3(p)); return w ? S.cal.worldToScene(w[0], w[1], w[2]) : null; };
        const g0 = p0 && gs(p0), g1 = p1 && gs(p1);
        const u2 = history.undoStack.length;
        if (p0 && p1) drag(p0[0], p0[1], p1[0], p1[1]);
        const rngA = areaPoly(activePlacement(), 'range');
        const nearR = (p, q) => !!p && !!q && Math.hypot(p[0] - q[0], p[1] - q[1]) <= 0.11;
        ok('S18 3D: dragging a box with the range-area tool writes confine.area from the two ground-picked corners (worldToScene), confine on',
          !!(g0 && g1 && rngA) && rngA.length === 4 && nearR(rngA[0], [round1(Math.min(g0[0], g1[0])), round1(Math.min(g0[1], g1[1]))])
          && nearR(rngA[2], [round1(Math.max(g0[0], g1[0])), round1(Math.max(g0[1], g1[1]))]) && history.undoStack.length === u2 + 1
          && JSON.stringify(Object.keys(activePlacement())) === JSON.stringify(['id', 'effect', 'anchor', 'area', 'confine']),
          { g0, g1, rngA, keys: Object.keys(activePlacement()) });
        // ---- 预览 sim 真的收到活动布置的 area + confine（与 VfxSystem.ensureSim 同形），种子 = 运行时 hashSeed(id)
        const apN = activePlacement();
        ok('S18 the preview sim is fed the active placement exactly like VfxSystem.ensureSim (area + confine as the 7th arg, seed = runtime hashSeed(id))',
          !!S.sim && !!S.sim.confine && S.sim.id === apN.id && JSON.stringify(S.simInput.area) === JSON.stringify(apN.area)
          && JSON.stringify(S.simInput.confine) === JSON.stringify(apN.confine) && typeof S.rt.vfxRandom.hashSeed === 'function'
          && S.simInput.seed === S.rt.vfxRandom.hashSeed(apN.id) && JSON.stringify(S.sim.confine.poly) === JSON.stringify(apN.confine.area),
          { simId: S.sim && S.sim.id, seed: S.simInput.seed, confine: !!(S.sim && S.sim.confine) });
        // 边带宽走检视器的数值框（缺省 120 比这块框的半高还宽时，内沿本来就不存在——那也是运行时的真相）
        setNum('边带宽', 40);
        ok('S18 the feather field writes confine.feather; the band inner edge comes from the runtime confineDistanceContour (bundle), drawn in 3D as ground-hugging lines',
          activePlacement().confine.feather === 40 && !!areaShapes().contour && areaShapes().contour.feather === 40 && areaShapes().contour.segs.length > 8 && areaLines3().length >= 3,
          { segs: areaShapes().contour && areaShapes().contour.segs.length, lines: areaLines3().length, confine: apN.confine, area: apN.area });
        // ---- 选中一个顶点：3D 与 2D 都立刻有 gizmo
        setTool('select'); select('');
        const vtx = (role, i) => areaPoly(activePlacement(), role)[i];
        let pv = P3(S.cal.sceneToWorldGround(vtx('emit', 0)[0], vtx('emit', 0)[1]));
        const hit3 = pv && v3._hit(pv[0], pv[1]);
        if (pv) click(pv[0], pv[1]);
        let g3 = v3._gizmo();
        ok('S18 3D: clicking one area vertex selects it and a move gizmo is there immediately, labelled',
          S.sel.key === 'area:emit:0' && !!g3 && g3.mode === 'move' && /发射区域 · 顶点 1/.test(g3.label) && g3.axes.map((a) => a.k).join('') === 'xz',
          { sel: S.sel.key, hit: hit3, gizmo: g3 && { label: g3.label, axes: g3.axes.map((a) => a.k) } });
        setView(2);
        const cv1 = v2.toCanvas(vtx('range', 1)[0], vtx('range', 1)[1]);
        click(R(cv1[0]), R(cv1[1]));
        const g2 = v2._gizmo();
        ok('S18 2D: clicking one area vertex in the backdrop selects it and the same gizmo shows up immediately',
          S.sel.key === 'area:range:1' && !!g2 && /范围区域 · 顶点 2/.test(g2.label), { sel: S.sel.key, gizmo: g2 && g2.label });
        // ---- gizmo 拖一个顶点：只动那一个点，一条历史
        setView(3);
        pv = P3(S.cal.sceneToWorldGround(vtx('emit', 2)[0], vtx('emit', 2)[1]));
        click(pv[0], pv[1]);
        g3 = v3._gizmo();
        const beforeEmit = JSON.stringify(areaPoly(activePlacement(), 'emit')), beforeRange = JSON.stringify(areaPoly(activePlacement(), 'range'));
        const u3 = history.undoStack.length;
        let gzOk = false;
        if (g3 && S.sel.key === 'area:emit:2') {
          const t = g3.tip.x, c = g3.c; const l = Math.hypot(t[0] - c[0], t[1] - c[1]); const d = [(t[0] - c[0]) / l, (t[1] - c[1]) / l];
          let s = null;
          for (const f of [0.62, 0.45, 0.78, 0.3, 0.9]) { const q = [R(c[0] + d[0] * l * f), R(c[1] + d[1] * l * f)]; const hh = v3._hit(q[0], q[1]); if (hh && hh.kind === 'gz' && hh.part === 'x') { s = q; break; } }
          if (s) { drag(s[0], s[1], R(s[0] + d[0] * 50), R(s[1] + d[1] * 50)); gzOk = true; }
        }
        const afterEmit = areaPoly(activePlacement(), 'emit');
        const bE = JSON.parse(beforeEmit);
        ok('S18 dragging the gizmo moves only that vertex (others and the other area untouched), as one history entry',
          gzOk && afterEmit.length === 4 && Math.hypot(afterEmit[2][0] - bE[2][0], afterEmit[2][1] - bE[2][1]) > 3
          && [0, 1, 3].every((i) => afterEmit[i][0] === bE[i][0] && afterEmit[i][1] === bE[i][1])
          && JSON.stringify(areaPoly(activePlacement(), 'range')) === beforeRange && history.undoStack.length === u3 + 1,
          { gzOk, before: bE[2], after: afterEmit[2], undo: history.undoStack.length - u3, label: history.peekUndo() });
        const u4 = history.undoStack.length, snap4 = libKey();
        g3 = v3._gizmo(); click(R(g3.c[0]), R(g3.c[1]));
        ok('S18 a plain click on the vertex gizmo is not an edit', history.undoStack.length === u4 && libKey() === snap4);
        // ---- 双击边线插点（2D），Delete 删点，右键删点
        setView(2); select('');
        const eA = vtx('emit', 0), eB = vtx('emit', 1);
        const mid = v2.toCanvas((eA[0] + eB[0]) / 2, (eA[1] + eB[1]) / 2);
        ev('mousedown', R(mid[0]), R(mid[1])); ev('mouseup', R(mid[0]), R(mid[1]));
        cv().dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: Math.round(cv().getBoundingClientRect().left + R(mid[0])), clientY: Math.round(cv().getBoundingClientRect().top + R(mid[1])), button: 0 }));
        const ins = areaPoly(activePlacement(), 'emit');
        const midS = [(eA[0] + eB[0]) / 2, (eA[1] + eB[1]) / 2];
        ok('S18 double-clicking an area edge inserts a vertex there, selected, gizmo on it',
          ins.length === 5 && Math.hypot(ins[1][0] - midS[0], ins[1][1] - midS[1]) <= 2 / v2.zoom + 1 && S.sel.key === 'area:emit:1' && !!v2._gizmo(),
          { n: ins.length, p: ins[1], mid: midS, sel: S.sel.key });
        const libBeforeDel = libKey();
        key('Delete');
        const libAfterDel = libKey();
        ok('S18 Delete removes the selected vertex', areaPoly(activePlacement(), 'emit').length === 4 && !S.sel.key, { n: areaPoly(activePlacement(), 'emit').length });
        key('z', { ctrlKey: true });
        ok('S18 undo covers placement edits (the library is part of the history snapshot)', libKey() === libBeforeDel, { n: areaPoly(activePlacement(), 'emit').length });
        key('y', { ctrlKey: true });
        ok('S18 redo re-applies it', libKey() === libAfterDel);
        // 右键：没拖动就松开 = 删点（先插一个再右键它）
        ev('mousedown', R(mid[0]), R(mid[1])); ev('mouseup', R(mid[0]), R(mid[1]));
        cv().dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: Math.round(cv().getBoundingClientRect().left + R(mid[0])), clientY: Math.round(cv().getBoundingClientRect().top + R(mid[1])), button: 0 }));
        const nIns = areaPoly(activePlacement(), 'emit').length;
        const rp = v2.toCanvas(areaPoly(activePlacement(), 'emit')[1][0], areaPoly(activePlacement(), 'emit')[1][1]);
        ev('mousedown', R(rp[0]), R(rp[1]), { button: 2, buttons: 2 }); ev('mouseup', R(rp[0]), R(rp[1]), { button: 2, buttons: 0 });
        ok('S18 right-click (no drag) on a vertex deletes it; a right-drag is a pan and deletes nothing',
          nIns === 5 && areaPoly(activePlacement(), 'emit').length === 4, { nIns, n: areaPoly(activePlacement(), 'emit').length });
        // ---- 剩 3 个再删 = 删整块（先确认）；删范围区域 = 退回用发射区域（限定照开）
        select('area:range:0'); key('Delete');
        const n3 = (areaPoly(activePlacement(), 'range') || []).length;
        select('area:range:0'); key('Delete');
        await wait(30);
        const dlgShown = !el('dialog').hidden;
        const cancelBtn = [...el('dialogForm').querySelectorAll('button')].find((b) => b.textContent === '取消');
        if (cancelBtn) cancelBtn.click();
        await wait(30);
        const still3 = n3 === 3 && !!areaPoly(activePlacement(), 'range') && areaPoly(activePlacement(), 'range').length === 3;
        select('area:range:0'); key('Delete');
        await wait(30);
        const okBtn = [...el('dialogForm').querySelectorAll('button')].find((b) => b.textContent === '确定');
        if (okBtn) okBtn.click();
        await wait(30);
        const apR = activePlacement();
        ok('S18 deleting below 3 vertices asks first; confirming drops the whole range area and falls back to the emit area (confine stays on)',
          dlgShown && still3 && !areaPoly(apR, 'range') && !!apR.confine && !('area' in apR.confine) && !!areaPoly(apR, 'emit') && !!S.sim.confine,
          { dlgShown, still3, confine: apR.confine });
        key('z', { ctrlKey: true });
        ok('S18 undo brings the range area back', !!areaPoly(activePlacement(), 'range'));
        // ---- 「限定」勾：去勾收着（含范围区域），再勾原样回来
        const chkBox = () => el('inspector').querySelector('input[data-role=confine]');
        const confBefore = JSON.stringify(activePlacement().confine);
        const cb = chkBox(); cb.checked = false; cb.dispatchEvent(new Event('change', { bubbles: true }));
        const off = activePlacement().confine;
        const cb2 = chkBox(); cb2.checked = true; cb2.dispatchEvent(new Event('change', { bubbles: true }));
        ok('S18 unticking "confine" stashes the confine (range area included); ticking it again restores it verbatim',
          off === undefined && !!(S.sim && S.sim.confine) && JSON.stringify(activePlacement().confine) === confBefore && !!areaPoly(activePlacement(), 'range'),
          { off, back: activePlacement().confine });
        ok('S18 rendering the inspector never writes the library', (() => { const b = libKey(); renderInspector(); renderLeft(); renderInspector(); return libKey() === b; })());
        // ---- 换时段外观不丢布置改动（库是全局的）
        const dirtyLib = libKey();
        change('phaseSel', '');
        await until(() => S.phase === '' && !S.busy);
        ok('S18 switching to another appearance keeps the unsaved library edits (and that appearance has no placement of this effect: none inherited)',
          S.libDirty && libKey() === dirtyLib && !activePlacement() && !(S.sim && S.sim.confine), { libDirty: S.libDirty, ap: activePlacement() && activePlacement().id });
        // 「这个效果还布置在」点一下 → 切回夜并选中
        const refItem = [...el('placeElsewhere').querySelectorAll('.item')].find((x) => x.getAttribute('data-ref') === `${SC}\n${NIGHT}\n${PID}`);
        if (refItem) refItem.click();
        await until(() => S.phase === NIGHT && !S.busy);
        await wait(30);
        ok('S18 "this effect is also placed at" jumps to that scene × appearance and selects the placement (gizmo on its anchor)',
          !!refItem && S.phase === NIGHT && !!activePlacement() && activePlacement().id === PID && S.sel.key === 'anchor' && !!v3._gizmo(),
          { ref: !!refItem, phase: S.phase, sel: S.sel.key });
        // ---- 复制到时段（整份 / 同 id 跳过 / 覆盖）
        const openCopy = async (target, scope) => {
          el('btnPlaceCopy').click(); await wait(20);
          const t = el('dialogForm').querySelector('select[data-role=copyTarget]'), s = el('dialogForm').querySelector('select[data-role=copyScope]');
          if (!t || !s) return false;
          t.value = target; s.value = scope;
          el('dialogForm').querySelector('button[data-choice=copy]').click();
          await wait(20);
          return true;
        };
        const opened = await openCopy('', 'one');
        await wait(20);
        const copied = libRows(SC, '').find((r) => r.id === PID);
        ok('S18 copy to another appearance: the selected placement lands in base as its own row (deep copy)',
          opened && !!copied && copied !== activePlacement() && JSON.stringify(copied) === JSON.stringify(activePlacement()), { opened, copied: !!copied });
        edit('自检改夜的锚点', () => { activePlacement().anchor.h = 77; });
        await openCopy('', 'one');
        const skipBtn = [...el('dialogForm').querySelectorAll('button')].find((b) => b.getAttribute('data-choice') === 'skip');
        if (skipBtn) skipBtn.click();
        await wait(30);
        ok('S18 copying onto an existing id asks overwrite / skip; skip leaves the target row alone',
          !!skipBtn && libRows(SC, '').find((r) => r.id === PID).anchor.h !== 77, { h: libRows(SC, '').find((r) => r.id === PID).anchor.h });
        await openCopy('', 'one');
        const owBtn = [...el('dialogForm').querySelectorAll('button')].find((b) => b.getAttribute('data-choice') === 'overwrite');
        if (owBtn) owBtn.click();
        await wait(30);
        ok('S18 overwrite replaces the target row in place', libRows(SC, '').find((r) => r.id === PID).anchor.h === 77);
        // ---- 选中的那一条拷到别的时段外观（左栏「「id」在别的时段外观」的「拷过去 / 拷过来」；制作人 2026-09-16：只拷选中的那一条）
        {
          const phaseRow = (k) => el('placePhases').querySelector(`[data-phase-row="${k}"]`);
          const copyBtn = (k, id, act) => phaseRow(k) && phaseRow(k).querySelector(`[data-copy-id="${id}"] button[data-act=${act}]`);
          const dlgBtn = (c) => [...el('dialogForm').querySelectorAll('button')].find((b) => b.getAttribute('data-choice') === c);
          const restOf = (ph) => canonJson(libRows(SC, ph).filter((r) => r.id !== PID));
          const rowOf = (ph) => libRows(SC, ph).find((r) => r.id === PID);
          const ctrlZ = async () => { key('z', { ctrlKey: true }); await wait(30); };
          select(`place:${PID}`);
          const snapBase = canonJson(libRows(SC, '')), snapNight = canonJson(libRows(SC, NIGHT));
          const baseRest = restOf(''), nightRest = restOf(NIGHT);
          edit('自检改夜里这条的锚点', () => { activePlacement().anchor.h = 55; });
          renderLeft();
          const nightBefore = canonJson(libRows(SC, NIGHT));
          // 别的外观有几套按场景现算（跑马梁 09-20 起多了「午」）：每套一行、每行只有这一条的拷过去 / 拷过来
          const otherPhases = S.scene.phases.filter((p) => p.key !== NIGHT);
          const ppBtns = [...el('placePhases').querySelectorAll('button')];
          ok('S18 per-placement copy: the other appearance\'s row for the selected placement says it differs, push + pull enabled, no other buttons in the section',
            S.phase === NIGHT && activePlacement().id === PID && /这条不一样/.test(phaseRow('') ? phaseRow('').textContent : '')
            && !!copyBtn('', PID, 'push') && !copyBtn('', PID, 'push').disabled && !copyBtn('', PID, 'pull').disabled
            && otherPhases.every((p) => !!phaseRow(p.key)) && ppBtns.length === 2 * otherPhases.length
            && ppBtns.every((b) => /^(push|pull)$/.test(b.getAttribute('data-act') || '') && !!b.closest(`[data-copy-id="${PID}"]`)),
            { row: phaseRow('') && phaseRow('').textContent, buttons: ppBtns.length, others: otherPhases.map((p) => p.key) });
          copyBtn('', PID, 'pull').click(); await wait(80);
          ok('S18 pulling onto an existing row asks before overwriting, naming the row',
            !el('dialog').hidden && el('dialogForm').textContent.includes(PID) && !!dlgBtn('overwrite'), { txt: el('dialogForm').textContent });
          if (dlgBtn('cancel')) dlgBtn('cancel').click();
          await wait(30);
          ok('S18 cancelling the per-placement copy leaves the library untouched', canonJson(libRows(SC, NIGHT)) === nightBefore && canonJson(libRows(SC, '')) === snapBase);
          const u0 = history.undoStack.length;
          copyBtn('', PID, 'pull').click(); await wait(80);
          if (dlgBtn('overwrite')) dlgBtn('overwrite').click();
          await wait(60);
          ok('S18 "pull" overwrites only the selected row with a deep copy; every other row in both appearances untouched; one history entry; the row stays selected',
            !!rowOf(NIGHT) && canonJson(rowOf(NIGHT)) === canonJson(rowOf('')) && rowOf(NIGHT) !== rowOf('')
            && restOf(NIGHT) === nightRest && canonJson(libRows(SC, '')) === snapBase
            && history.undoStack.length === u0 + 1 && activePlacement() === rowOf(NIGHT) && S.libDirty,
            { night: libRows(SC, NIGHT).map((r) => r.id), undo: history.undoStack.length - u0 });
          ok('S18 after the copy the row says identical and both buttons grey out',
            /这条一样/.test(phaseRow('').textContent) && copyBtn('', PID, 'push').disabled && copyBtn('', PID, 'pull').disabled, { row: phaseRow('').textContent });
          ok('S18 the copied row\'s appearance goes into the edited scopes (save / game push carry it)',
            !!(changedPlacementLibrary().scenes[SC] && changedPlacementLibrary().scenes[SC].variants && NIGHT in changedPlacementLibrary().scenes[SC].variants));
          await ctrlZ();
          ok('S18 Ctrl+Z undoes the per-placement copy in one step', canonJson(libRows(SC, NIGHT)) === nightBefore);
          // 拷过去：那边没有这条 → 直接加上，不问
          edit('自检基底删掉这条', () => { const a = rowsArr(SC, ''); a.splice(a.findIndex((r) => r.id === PID), 1); });
          renderLeft();
          ok('S18 when the other appearance lacks the row it says so: pull disabled, push enabled',
            /没有这条/.test(phaseRow('').textContent) && copyBtn('', PID, 'pull').disabled && !copyBtn('', PID, 'push').disabled, { row: phaseRow('').textContent });
          const u1 = history.undoStack.length;
          copyBtn('', PID, 'push').click(); await wait(80);
          ok('S18 "push" adds just this row there without a dialog; the rows already there untouched; selection stays here',
            el('dialog').hidden && !!rowOf('') && canonJson(rowOf('')) === canonJson(activePlacement()) && restOf('') === baseRest
            && history.undoStack.length === u1 + 1 && S.phase === NIGHT && activePlacement().id === PID,
            { base: libRows(SC, '').map((r) => r.id) });
          await ctrlZ(); await ctrlZ();                        // 撤掉拷过去、撤掉基底删行
          // 这一份里还没有当前效果的布置：列出别的时段外观里它的布置，逐条拷过来
          edit('自检夜里删掉这条', () => { const a = rowsArr(SC, NIGHT); a.splice(a.findIndex((r) => r.id === PID), 1); });
          renderLeft();
          ok('S18 with no placement of this effect here, its placements in the other appearance are listed, each with its own "pull" (no "push")',
            !activePlacement() && !!copyBtn('', PID, 'pull') && !copyBtn('', PID, 'pull').disabled && !copyBtn('', PID, 'push'),
            { row: phaseRow('') && phaseRow('').textContent });
          const u2 = history.undoStack.length;
          copyBtn('', PID, 'pull').click(); await wait(80);
          ok('S18 pulling it adds that one row here without a dialog and selects it; other rows untouched',
            el('dialog').hidden && !!rowOf(NIGHT) && canonJson(rowOf(NIGHT)) === canonJson(rowOf('')) && activePlacement() === rowOf(NIGHT)
            && S.sel.key === 'anchor' && restOf(NIGHT) === nightRest && history.undoStack.length === u2 + 1,
            { night: libRows(SC, NIGHT).map((r) => r.id), sel: S.sel.key });
          await ctrlZ();
          // 这边同 id 被别的效果占着：不许拷
          edit('自检夜里同 id 是别的效果', () => { rowsArr(SC, NIGHT).push({ id: PID, effect: 'zz_other_effect', anchor: { x: 1, y: 2 } }); });
          renderLeft();
          ok('S18 a same-id row of another effect here blocks the pull (button disabled, says why)',
            !activePlacement() && !!copyBtn('', PID, 'pull') && copyBtn('', PID, 'pull').disabled && /同 id 是/.test(phaseRow('').textContent),
            { row: phaseRow('') && phaseRow('').textContent });
          await ctrlZ(); await ctrlZ(); await ctrlZ();          // 撤掉占 id、撤掉夜里删行、撤掉改锚点
          ok('S18 undoing back restores both appearances to how they were before this block',
            canonJson(libRows(SC, '')) === snapBase && canonJson(libRows(SC, NIGHT)) === snapNight,
            { base: libRows(SC, '').map((r) => r.id), night: libRows(SC, NIGHT).map((r) => r.id) });
          select(`place:${PID}`);
        }
        // ---- publish 体里带着整份工作态布置库与切时段请求
        const bodies = [];
        const origFetch = window.fetch;
        window.fetch = (path, opts) => { if (path === '/api/link/publish' && opts && opts.body) bodies.push(JSON.parse(opts.body)); return origFetch(path, opts); };
        S.link.on = true;
        schedulePublish(); await wait(PUBLISH_DEBOUNCE_MS + 150);
        {
          // 游戏页在跑、而且在别的外观上（没在跑时按钮只记下、不发——见 S20 #7）：拿一份回传同步喂进去再点
          const keepSt = S.link.status;
          S.link.status = { ok: true, connected: true, gameAlive: true, doc: { sceneId: SC, timePhase: '辰', appearancePhase: '', instances: [], stats: {} } };
          renderPhaseButton();
          el('btnPhaseRequest').click(); await wait(200);
          S.link.status = keepSt;
        }
        window.fetch = origFetch;
        const origPost = API.post;
        const bPl = bodies.find((b) => b.placements), bPr = bodies.find((b) => b.phaseRequest);
        ok('S18 the publish body carries only edited scene/appearance scopes + the scene × appearance being edited',
          !!bPl && bPl.placements.sceneId === SC && bPl.placements.phase === NIGHT
          && libRows(SC, '', bPl.placements.library).some((r) => r.id === PID && r.anchor.h === 77) && libRows(SC, NIGHT, bPl.placements.library).some((r) => r.id === PID),
          { keys: bPl && Object.keys(bPl.placements), sid: bPl && bPl.placements.sceneId, ph: bPl && bPl.placements.phase });
        ok('S18 "let the game switch to this phase" sends a phaseRequest with the real time-phase id',
          !!bPr && bPr.phaseRequest.timePhase === NIGHT && !!bPr.placements, { pr: bPr && bPr.phaseRequest });
        {
          // 游戏面板：同场景但游戏此刻的外观 ≠ 工作台展开的那一份 → 整行黄字（拿一份回传文档同步喂进去，轮询来不及盖）
          const keepSt = S.link.status;
          S.link.status = { ok: true, connected: true, gameAlive: true, doc: { sceneId: SC, timePhase: '辰', appearancePhase: '',
            placementsApplied: { sceneId: SC, phase: '', preview: true }, instances: [], stats: {} } };
          renderGamePanel();
          const mm = el('gamePanel').querySelector('[data-role=phaseMismatch]');
          const panelTxt = el('gamePanel').textContent;
          S.link.status.doc.appearancePhase = NIGHT;
          renderGamePanel();
          const mm2 = el('gamePanel').querySelector('[data-role=phaseMismatch]');
          S.link.status = keepSt; renderGamePanel();
          ok('S18 the game panel shows "时段 · 外观" and warns in yellow when the game shows another appearance of this scene',
            !!mm && mm.classList.contains('warn') && /你在调「入夜（夜）」，游戏现在是「基底/.test(mm.textContent)
            && /时段 辰 · 外观 基底/.test(panelTxt) && /工作态/.test(panelTxt) && !mm2,
            { mm: mm && mm.textContent, panel: panelTxt.slice(0, 160), mm2: !!mm2 });
        }
        const badResp = await fetch('/api/link/publish', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ effectId: S.doc.id, def: S.doc, placements: { mode: 'scoped', library: { scenes: { [SC]: { base: [{ id: 'x', effect: 'e' }] } } }, sceneId: SC, phase: '' } }) });
        const bad = await badResp.json();
        ok('S18 a library that fails the shape gate is not pushed; the effect still is, and the reason comes back (even with no game running)',
          /布置库没推/.test(bad.placementsErr || '') && 'connected' in bad, bad);
        // ---- 保存只成功一半：不清脏，状态栏如实说哪份没存上
        edit('自检改效果', () => { em0().spawn.max = 21; });
        edit('自检改布置', () => { activePlacement().countScale = 1.5; });
        API.post = async (path, body) => { if (path === '/api/placements/save') throw new Error('模拟：布置库写盘失败'); return origPost(path, body); };
        key('s', { ctrlKey: true });
        await ioChain;
        API.post = origPost;
        ok('S18 a half-successful save never clears dirty: the effect is clean, the library stays dirty, the status names what failed',
          S.dirty && S.libDirty && !S.docDirty && /布置库没存上/.test(el('status').textContent) && /效果已存/.test(el('status').textContent) && history.undoStack.length > 0,
          { dirty: S.dirty, docDirty: S.docDirty, libDirty: S.libDirty, status: el('status').textContent });
        key('s', { ctrlKey: true });
        await ioChain;
        const disk2 = await API.json('/api/placements');
        ok('S18 saving again persists the library (both appearances, copied row included)',
          !S.dirty && libRows(SC, '', disk2.doc).some((r) => r.id === PID) && libRows(SC, NIGHT, disk2.doc).find((r) => r.id === PID).countScale === 1.5);
        // ---- 删效果的守卫：全库有布置引用它就不删、列出引用
        const del = await post('/api/delete', { id: TMP });
        let still = { ok: false };
        try { still = await API.json(`/api/effect?id=${encodeURIComponent(TMP)}`); } catch (e) { still = { ok: false, err: String(e) }; }
        ok('S18 deleting an effect that placements still use is refused with the list of (scene · appearance · id)',
          del.ok === true && del.deleted === false && del.needConfirm === true && del.refs.some((r) => r.sceneId === SC && r.phase === NIGHT && r.id === PID)
          && del.refs.some((r) => r.sceneId === SC && r.phase === '' && r.id === PID) && still.ok === true && S.effects.some((r) => r.id === TMP),
          { del });
        // ---- 改效果名：布置里引用它的一起改（走页面的改名流程）
        const TMPR = 'zz_selftest_r';
        await post('/api/delete', { id: TMPR, withPlacements: true }); await post('/api/delete', { id: `${TMPR}2`, withPlacements: true });
        await post('/api/create', { id: TMPR, sceneId: SC });
        tmp.push(TMPR, `${TMPR}2`);
        await refreshEffects();
        await openEffect(TMPR, { keepScene: true });
        placeHere();
        key('s', { ctrlKey: true }); await ioChain;
        const pRen = renameEffect(); await wait(30);
        const rin = el('dialogForm').querySelector('input');
        if (rin) { rin.value = `${TMPR}2`; el('dialogForm').requestSubmit(); }
        await pRen; await ioChain;
        const disk3 = await API.json('/api/placements');
        ok('S18 renaming an effect renames the placements that use it (on disk and in the working library)',
          S.doc && S.doc.id === `${TMPR}2` && libRefs(`${TMPR}2`, disk3.doc).length === 1 && libRefs(TMPR, disk3.doc).length === 0
          && libRefs(`${TMPR}2`).length === 1 && !S.libDirty, { doc: S.doc && S.doc.id, refs: libRefs(`${TMPR}2`, disk3.doc), status: el('status').textContent });

        // ------------------------------------------------------------------ S19 日常流程（2026-09-14 审查）：
        // 开台 → 调参 → Ctrl+S → 关窗 这条路上作者真会碰到的几处，全在临时效果 zz_selftest_r2 上
        {
          const CUR = `${TMPR}2`;
          const disk = async (id) => (await API.json(`/api/effect?id=${encodeURIComponent(id)}`)).doc;
          // ---- 关窗保护的钩子（桌面壳关窗 / F5 前来问）
          ok('S19 close guard: nothing unsaved → the page says so (the shell closes without asking)', window.__unsavedSummary() === '' && !S.dirty,
            { summary: window.__unsavedSummary() });
          edit('自检关窗前改', () => { em0().spawn.max = 61; });
          const sum = window.__unsavedSummary();
          window.__saveUnsaved();
          await until(() => window.__saveUnsavedResult && window.__saveUnsavedResult !== 'pending', 10000);
          ok('S19 close guard: unsaved edits are named, and "save and close" really saves through Ctrl+S',
            sum.includes(CUR) && window.__saveUnsavedResult === 'ok' && !S.dirty && (await disk(CUR)).emitters[0].spawn.max === 61,
            { sum, result: window.__saveUnsavedResult });
          // ---- 光标还在检视器输入框里（改了数没按回车）就 Ctrl+S：存的必须是新值
          const sizeInput = () => { const r = [...el('inspector').querySelectorAll('.row')].find((x) => /^宽度/.test(x.textContent)); return r && r.querySelector('input[type=number]'); };
          const typeInto = (inp, text) => { inp.focus(); inp.select(); return document.execCommand('insertText', false, text); };
          let inp = sizeInput();
          if (!inp || !typeInto(inp, '9.5') || inp.value !== '9.5') {
            log.push('WARN S19 skipped the focused-input save check: cannot type into the inspector here');
          } else {
            inp.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
            await ioChain;
            await until(() => !S.dirty, 5000);
            ok('S19 Ctrl+S while the cursor is still in an inspector box saves the value just typed (not the old one)',
              (await disk(CUR)).emitters[0].appearance.sizeWu === 9.5 && !S.dirty, { disk: (await disk(CUR)).emitters[0].appearance.sizeWu, dirty: S.dirty });
          }
          // ---- 改完一个数按 Tab：焦点落到下一格（同步重建会把下一格一起删掉，焦点掉回页面）
          inp = sizeInput();
          if (inp && typeInto(inp, '8')) {
            const all0 = [...el('inspector').querySelectorAll('input, select, textarea, button')];
            const next = all0[all0.indexOf(inp) + 1];
            next.focus();
            await wait(30);
            const all1 = [...el('inspector').querySelectorAll('input, select, textarea, button')];
            const ae = document.activeElement;
            ok('S19 Tab after editing a number: the value is committed and focus lands on the next box of the rebuilt inspector',
              em0().appearance.sizeWu === 8 && el('inspector').contains(ae) && all1.indexOf(ae) === all0.indexOf(next) && !all0.includes(ae),
              { sizeWu: em0().appearance.sizeWu, idx: all1.indexOf(ae), want: all0.indexOf(next), tag: ae && ae.tagName });
            ae.blur();
            key('z', { ctrlKey: true });
          }
          // ---- 对话框 Esc = 取消
          const pd = promptDialog('自检', 'id', 'x');
          await wait(0);
          key('Escape');
          const pv = await pd;
          ok('S19 Esc cancels a dialog (same as clicking 取消)', pv === '' && el('dialog').hidden, { v: pv, hidden: el('dialog').hidden });
          // ---- 空格：松开才切播放；按住的自动重复不来回翻；空格 + 拖（平移）不切
          setPlaying(false);
          const kd = (opts) => window.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: ' ', bubbles: true, cancelable: true }, opts || {})));
          const ku = () => window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true, cancelable: true }));
          kd(); ku();
          const tapPlays = S.playing;
          kd(); for (let i = 0; i < 7; i++) kd({ repeat: true }); ku();
          const heldOnce = !S.playing;
          kd(); window.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); ku();
          const panNoToggle = !S.playing;
          setPlaying(false);
          ok('S19 space toggles play on release, once per press (auto-repeat does not flip it), and space+drag (pan) does not toggle',
            tapPlays && heldOnce && panNoToggle, { tapPlays, heldOnce, panNoToggle });
          // ---- 勾一下图层 / 选一下下拉之后，焦点还回去（原来焦点留在勾选框上，Ctrl+Z / Delete / W/E/R 全没反应）
          const box = el('layer_grid');
          box.focus(); box.click();
          await wait(20);
          const released = document.activeElement !== box;
          const mode0 = S.gizmoMode;
          key('r');
          const keysWork = S.gizmoMode === 'scale';
          S.gizmoMode = mode0; box.click(); await wait(20);
          ok('S19 after ticking a layer checkbox the focus is released and single-key shortcuts work right away', released && keysWork, { released, keysWork });
          // ---- 已经在某个场景里，从下拉框换效果不被拽走（作者可能正要把它布置到这里）；状态栏说它布置在哪
          const sceneBefore = S.scene.id, phaseBefore = S.phase;
          await openEffect('bat_cliff', { force: true });
          ok('S19 switching effect from the dropdown keeps the current scene, and the status says where that effect is placed',
            S.doc.id === 'bat_cliff' && S.scene.id === sceneBefore && S.phase === phaseBefore && (libRefs('bat_cliff').length === 0 || /布置在/.test(el('status').textContent)),
            { scene: S.scene.id, status: el('status').textContent });
          await openEffect(CUR, { force: true, keepScene: true });
          // ---- 复制时带上未保存的改动（副本 = 页面上这份，源文件不动），先问再动盘
          edit('自检复制前改', () => { em0().spawn.max = 77; });
          const DUP = 'zz_selftest_dup';
          await post('/api/delete', { id: DUP, withPlacements: true });
          tmp.push(DUP);
          const pDup = duplicateEffect();
          await until(() => !el('dialog').hidden && !!el('dialogForm').querySelector('[data-choice=carry]'), 3000);
          const carry = el('dialogForm').querySelector('[data-choice=carry]');
          if (carry) carry.click();
          await until(() => !el('dialog').hidden && !!el('dialogForm').querySelector('input[type=text]'), 3000);
          const din = el('dialogForm').querySelector('input[type=text]');
          if (din) { din.value = DUP; el('dialogForm').requestSubmit(); }
          await pDup; await ioChain;
          let dupDisk = null;
          try { dupDisk = await disk(DUP); } catch (e) { dupDisk = null; }
          const srcDisk = await disk(CUR);
          ok('S19 duplicating with unsaved edits asks first, and "carry the edits" makes the copy from the page (source file untouched)',
            !!carry && S.doc.id === DUP && !!dupDisk && dupDisk.emitters[0].spawn.max === 77 && srcDisk.emitters[0].spawn.max === 61 && !S.docDirty,
            { doc: S.doc.id, dup: dupDisk && dupDisk.emitters[0].spawn.max, src: srcDisk.emitters[0].spawn.max });
          // ---- 选中一条布置按 Delete = 删这条布置（可撤销）
          await openEffect(CUR, { force: true, keepScene: true });
          const pl = curRows().find((r) => r.effect === CUR);
          if (!pl) { log.push('WARN S19 skipped the Delete-placement check: no placement of the temp effect here'); } else {
            select(`place:${pl.id}`);
            key('Delete');
            // 删完全库没有这个 id 时先问一次服务端有没有 playVfx / 条件引用它（异步）：等它落定
            const gone = await until(() => !curRows().some((r) => r.id === pl.id) && !placeDelPending, 3000);
            key('z', { ctrlKey: true });
            ok('S19 Delete on a selected placement removes that placement, and Ctrl+Z brings it back',
              gone && curRows().some((r) => r.id === pl.id), { gone, back: curRows().some((r) => r.id === pl.id) });
          }
          // ---- 复核（2026-09-14 工作流）抓出来的几条 ----
          // Enter 提交并离开这一格：焦点留在框里的话 Ctrl+Z / 空格 / W/E/R 全被吃掉
          select(`emitter:${em0().id}`);
          inp = sizeInput();
          const size0 = em0().appearance.sizeWu;
          if (inp && typeInto(inp, '7')) {
            inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
            await wait(30);
            const leftBox = !el('inspector').contains(document.activeElement);
            const took = em0().appearance.sizeWu === 7;
            key('z', { ctrlKey: true });
            ok('S19 Enter in an inspector box commits and leaves the box, so Ctrl+Z right after undoes it',
              leftBox && took && em0().appearance.sizeWu === size0, { leftBox, took, now: em0().appearance.sizeWu, was: size0 });
          }
          // 关窗保护先提交输入框里没提交的值（点标题栏 X / 按 F5 都不会让它失焦）
          inp = sizeInput();
          if (inp && typeInto(inp, '6.5')) {
            const sumTyped = window.__unsavedSummary();
            ok('S19 close guard commits a value typed but not yet entered, and therefore asks', sumTyped.includes(CUR) && em0().appearance.sizeWu === 6.5,
              { sum: sumTyped, sizeWu: em0().appearance.sizeWu });
            key('z', { ctrlKey: true });
          }
          // 收起的下拉框上：快捷键放焦点并照常生效（不做首字母跳转）；方向键留给下拉框逐项切换、不许变成「微移」
          {
            const fk = el('fieldKind'), v0 = fk.value, mode0 = S.gizmoMode, u0 = history.undoStack.length;
            fk.focus();
            const kr = new KeyboardEvent('keydown', { key: 'r', bubbles: true, cancelable: true });
            fk.dispatchEvent(kr);
            const released = document.activeElement !== fk && S.gizmoMode === 'scale' && kr.defaultPrevented && fk.value === v0;
            S.gizmoMode = mode0;
            select('anchor');
            fk.focus();
            fk.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
            const arrowStays = document.activeElement === fk && history.undoStack.length === u0;
            fk.blur();
            ok('S19 a focused (closed) dropdown: shortcut keys release it and work (no type-ahead); arrow keys stay with the dropdown (no nudge)',
              released && arrowStays, { released, arrowStays });
          }
          // 换效果时有未保存改动：可以「先保存」
          edit('自检换效果前改', () => { em0().spawn.max = 91; });
          const pOpen = openEffect('bat_cliff', { keepScene: true });
          await until(() => !el('dialog').hidden && !!el('dialogForm').querySelector('[data-choice=save]'), 3000);
          const saveBtn = el('dialogForm').querySelector('[data-choice=save]');
          if (saveBtn) saveBtn.click();
          await pOpen; await ioChain;
          ok('S19 switching effect with unsaved edits offers "save first", and it really saves before opening the other one',
            !!saveBtn && S.doc.id === 'bat_cliff' && (await disk(CUR)).emitters[0].spawn.max === 91, { doc: S.doc.id, disk: (await disk(CUR)).emitters[0].spawn.max });
          await openEffect(CUR, { force: true, keepScene: true });
          // 布置库没存时换效果：库的改动还能撤销（原来一换效果撤销栈整个清空）
          const pl2 = curRows().find((r) => r.effect === CUR);
          if (pl2) {
            const cs0 = pl2.countScale;
            editPlacement(pl2.id, '自检改数量倍率', (r) => { r.countScale = 1.7; });
            await openEffect('bat_cliff', { force: true, keepScene: true });
            const canUndo = history.canUndo;
            key('z', { ctrlKey: true });
            const back = curRows().find((r) => r.id === pl2.id);
            ok('S19 library edits stay undoable after opening another effect (the doc half is rebased, the old effect never comes back)',
              canUndo && !!back && back.countScale === cs0 && S.doc.id === 'bat_cliff' && !S.libDirty,
              { canUndo, cs: back && back.countScale, cs0, doc: S.doc.id, libDirty: S.libDirty });
            await openEffect(CUR, { force: true, keepScene: true });
          }
          // 第二轮复核：存过盘（Ctrl+S / 「先保存」）再换效果，布置库的撤销照样留着（存盘不清撤销栈）
          const pl3 = curRows().find((r) => r.effect === CUR);
          if (pl3) {
            const cs0 = pl3.countScale;
            editPlacement(pl3.id, '自检存盘后换效果前改倍率', (r) => { r.countScale = 1.3; });
            key('s', { ctrlKey: true }); await ioChain;
            const savedClean = !S.dirty;
            await openEffect('bat_cliff', { keepScene: true });
            const canUndo2 = history.canUndo;
            key('z', { ctrlKey: true });
            const back3 = curRows().find((r) => r.id === pl3.id);
            ok('S19 saved, then switched effect: the library edit is still undoable (saving never clears undo, switching effect neither)',
              savedClean && canUndo2 && !!back3 && back3.countScale === cs0, { savedClean, canUndo2, cs: back3 && back3.countScale, cs0 });
            key('y', { ctrlKey: true }); key('s', { ctrlKey: true }); await ioChain;   // 恢复到存盘的状态，库里别留脏
            await openEffect(CUR, { force: true, keepScene: true });
          }
          // 第二轮复核：鼠标在页内下拉列表里选完放掉焦点（接着按方向键是微移，不是改这个下拉框）；键盘逐项切换不放
          {
            const blendSel = [...el('inspector').querySelectorAll('select')].find((x) => [...x.options].some((o) => o.value === 'add'));
            if (blendSel) {
              const rr = blendSel.getBoundingClientRect();
              blendSel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: rr.left + 5, clientY: rr.top + 5 }));
              const items = document.getElementById('ddlist') ? [...document.getElementById('ddlist').children] : [];
              const idx = [...blendSel.options].findIndex((o) => o.value !== blendSel.value);
              if (items[idx]) items[idx].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
              await wait(40);
              const ae = document.activeElement;
              ok('S19 picking from an inspector dropdown with the mouse releases focus (arrow keys go back to nudging)',
                !!items[idx] && !(ae && ae.tagName === 'SELECT'), { active: ae && ae.tagName });
              key('z', { ctrlKey: true });
            }
          }
          // 第二轮复核：预览条（种子 / 倍速 / 刺激参数）里按 Enter 也离开输入框，空格马上能播放
          {
            const fr = el('fieldRadius'), v0 = fr.value;
            fr.focus(); fr.select(); document.execCommand('insertText', false, '300');
            fr.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
            await wait(20);
            ok('S19 Enter in a preview bar box (stimulus radius) leaves the box too, so Space plays right after',
              document.activeElement !== fr, { active: document.activeElement && document.activeElement.id });
            fr.value = v0;
          }
          // 对话框里下拉列表开着按 Esc：只关列表，对话框留着；再按一次才取消对话框
          if (curRows().length && phasesOf(S.scene.id).length > 1) {
            const pc = copyPlacementsDialog();
            await until(() => !el('dialog').hidden && !!el('dialogForm').querySelector('select'), 3000);
            const ds = el('dialogForm').querySelector('select');
            const rr = ds.getBoundingClientRect();
            ds.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: rr.left + 5, clientY: rr.top + 5 }));
            const listOpen = Dropdown.isOpen();
            key('Escape');
            const firstEsc = !Dropdown.isOpen() && !el('dialog').hidden;
            key('Escape');
            await pc;
            ok('S19 Esc with a dropdown list open inside a dialog closes just the list; the next Esc cancels the dialog',
              listOpen && firstEsc && el('dialog').hidden && !Dropdown.isOpen(), { listOpen, firstEsc, hidden: el('dialog').hidden });
          }
          // ------------------------------------------------------------------ S20 第三轮审查（2026-09-14）逐条钉住
          // 仍在临时效果 CUR（zz_selftest_r2）+ 临时布置库上；真资产 bat_cliff / incense_smoke 只读打开、绝不存
          {
            setPlaying(false);
            if (!activePlacement()) placeHere();
            const press = (t) => { t.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true })); t.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, buttons: 1 })); };
            const release = (t) => {
              t.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
              t.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
              // Chromium：按下的那个节点不在了就不发 click（这正是 #19 的坏法）
              if (t.isConnected) t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
            };
            // ---- #19 检视器里打了数没按回车、直接真按左栏一行 / 检视器折叠标题：值提交了，点击也得落地
            {
              select(`emitter:${em0().id}`);
              const size0 = em0().appearance.sizeWu;
              const inp19 = sizeInput();
              const row = el('emList').querySelector('.item');
              if (!inp19 || !row || !typeInto(inp19, '5.5')) log.push('WARN S20 #19 skipped: cannot type into the inspector here');
              else {
                press(row);
                inp19.blur();                                  // mousedown 的默认动作挪走焦点 → change → edit → 重建
                await wait(30);                                // 人按一下有几十毫秒：原来的重建都在这里面发生
                const attached = row.isConnected;
                release(row);
                await wait(30);
                ok('S20 #19 typing in an inspector box then really pressing a left-panel row: the value commits AND the click lands (the row is not torn down under the pointer)',
                  attached && em0().appearance.sizeWu === 5.5 && S.sel.key === 'anchor' && !!el('emList').querySelector('.item.on'),
                  { attached, sizeWu: em0().appearance.sizeWu, sel: S.sel.key });
                select(`emitter:${em0().id}`);
                const inp2 = sizeInput();
                const head = [...el('inspector').querySelectorAll('.secHead')].find((x) => x.textContent.includes('碰撞'));
                const was = Inspector.open.collision !== false;
                if (inp2 && head && typeInto(inp2, '4.5')) {
                  press(head); inp2.blur(); await wait(30);
                  const att2 = head.isConnected;
                  release(head); await wait(30);
                  ok('S20 #19 same with an inspector section header: value committed and the section really toggles on the first click',
                    att2 && em0().appearance.sizeWu === 4.5 && (Inspector.open.collision !== false) === !was, { att2, sizeWu: em0().appearance.sizeWu, open: Inspector.open.collision });
                  Inspector.open.collision = was; renderInspector();
                }
                edit('自检 #19 复原宽度', () => { em0().appearance.sizeWu = size0; });
              }
            }
            // ---- #26 改完上一格按 Tab 过来（没动过的框）：Ctrl+Z 走页面撤销栈；正在打字的框照旧留给文字撤销
            {
              const pl = activePlacement();
              const cs0 = pl.countScale;
              editPlacement(pl.id, '自检 #26 改倍率', (r) => { r.countScale = 1.9; });
              select(`emitter:${em0().id}`);
              const box = sizeInput();
              box.focus(); box.select();
              const kz = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
              box.dispatchEvent(kz);
              ok('S20 #26 Ctrl+Z in an untouched inspector box (where Tab landed) runs the page undo instead of doing nothing',
                kz.defaultPrevented && activePlacement().countScale === cs0 && document.activeElement !== box, { prevented: kz.defaultPrevented, cs: activePlacement().countScale, cs0 });
              const box2 = sizeInput();
              if (box2 && typeInto(box2, '3')) {
                const u = history.undoStack.length;
                const kz2 = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
                box2.dispatchEvent(kz2);
                ok('S20 #26 a box the author is typing in keeps the native text undo (page undo untouched)', !kz2.defaultPrevented && history.undoStack.length === u,
                  { prevented: kz2.defaultPrevented });
                box2.value = box2.dataset.v0; box2.blur();
              }
            }
            // ---- #20 叠在一起的锚点与零偏移发射器：什么都没选时点它拿到布置锚点（发射器 offset 是所有布置共用的）
            {
              setView(3); v3.fit(true); setTool('select'); select('');
              const c20 = P3(anchorWorld());
              const h20 = c20 && v3._hit(c20[0], c20[1]);
              const cand = c20 ? objects().filter((o) => { const q = P3(o.pos); return q && Math.hypot(q[0] - c20[0], q[1] - c20[1]) <= 3; }).map((o) => o.key) : [];
              ok('S20 #20 with nothing selected, pressing the effect marker picks the placement anchor, not the co-located zero-offset emitter',
                !!h20 && h20.key === 'anchor' && cand.some((k) => /^emitter:/.test(k)), { hit: h20, cand });
            }
            // ---- #24 / #31 直接拖标记 = 相对位移：锚点的 h / surface 留着、拖的时候不重建模拟；发射器的 y 偏移留着；2D 同理
            {
              const ap = activePlacement();
              editPlacement(ap.id, '自检 #31 抬高锚点', (r) => { r.anchor.h = 120; delete r.anchor.surface; });
              setView(3); v3.fit(true); setTool('select'); select('anchor');
              const c = P3(anchorWorld());
              if (!c) log.push('WARN S20 #31 skipped: the anchor is off screen');
              else {
                const x0 = activePlacement().anchor.x, sim0 = S.sim, u0 = history.undoStack.length;
                ev('mousedown', c[0], c[1]);
                ev('mousemove', c[0] + 20, c[1]); ev('mousemove', c[0] + 40, c[1] + 5);
                const simSame = !!sim0 && S.sim === sim0;
                ev('mouseup', c[0] + 40, c[1] + 5);
                const a1 = activePlacement().anchor;
                ok('S20 #24/#31 3D: dragging the anchor marker itself is relative like the gizmo centre (h 120 and surface kept, anchor moved), the preview is not rebuilt mid-drag, one history entry',
                  simSame && a1.h === 120 && !a1.surface && Math.abs(a1.x - x0) > 1 && history.undoStack.length === u0 + 1, { simSame, a1, x0 });
              }
              edit('自检 #31 发射器抬高', () => { em0().offset = [0, 150, 0]; });
              select(`emitter:${em0().id}`);
              const aw = anchorWorld(); const ce = P3([aw[0], aw[1] + 150, aw[2]]);
              if (!ce) log.push('WARN S20 #31 emitter check skipped: off screen');
              else {
                ev('mousedown', ce[0], ce[1]); ev('mousemove', ce[0] + 25, ce[1]); ev('mousemove', ce[0] + 50, ce[1]); ev('mouseup', ce[0] + 50, ce[1]);
                const off = em0().offset || [0, 0, 0];
                ok('S20 #31 3D: dragging an emitter marker keeps its 150 wu y offset (not slammed onto the terrain behind it)', off[1] === 150 && Math.hypot(off[0], off[2]) > 1, { off });
              }
              edit('自检 #31 发射器偏移归零', () => { delete em0().offset; });
              setView(2); select('anchor');
              const a0 = JSON.parse(JSON.stringify(activePlacement().anchor));
              const cp = v2.projectWorld(anchorWorld());
              if (!cp) log.push('WARN S20 #31 2D skipped');
              else {
                const zx = R(cp[0]), zy = R(cp[1]);
                ev('mousedown', zx, zy); ev('mousemove', zx + 15, zy + 6); ev('mousemove', zx + 30, zy + 12); ev('mouseup', zx + 30, zy + 12);
                const a2 = activePlacement().anchor, tol = 1.5 / v2.zoom + 0.5;
                ok('S20 #31 2D: dragging the anchor marker moves it by the cursor delta, h kept (no jump by the projected height)',
                  a2.h === a0.h && Math.abs((a2.x - a0.x) - 30 / v2.zoom) < tol && Math.abs((a2.y - a0.y) - 12 / v2.zoom) < tol, { a0, a2, zoom: v2.zoom });
              }
              setView(3);
            }
            // ---- #25 方向键微移玩家 / 刺激点：不重建模拟（同一个 sim、钟不回零、rev 不动）；自动重复照样微移
            {
              setView(3); setTool('select');
              setPlayerSceneAt(S.cal.worldW * 0.5, S.cal.worldH * 0.75, 0);
              select('player');
              resetSim(); for (let i = 0; i < 10; i++) stepSim(1 / 60);
              const sim0 = S.sim, t0 = S.simTime, rev0 = S.rev, w0 = S.player.world.slice();
              key('ArrowLeft', { shiftKey: true }); key('ArrowLeft', { shiftKey: true, repeat: true });
              ok('S20 #25 arrow-nudging the player (auto-repeat included) moves it without rebuilding the preview (same sim, clock kept, rev untouched)',
                !!sim0 && S.sim === sim0 && S.simTime === t0 && S.rev === rev0 && Math.hypot(S.player.world[0] - w0[0], S.player.world[2] - w0[2]) > 15,
                { same: S.sim === sim0, t: S.simTime, t0, rev: S.rev, rev0, moved: Math.hypot(S.player.world[0] - w0[0], S.player.world[2] - w0[2]) });
              S.probes.push({ at: anchorWorld().map(round2), field: { kind: 'fear', tag: 'item:bug', radius: 200, strength: 1 } });
              const pi = S.probes.length - 1;
              select(`probe:${pi}`);
              const at0 = S.probes[pi].at.slice();
              key('ArrowUp');
              ok('S20 #25 same for a stimulus point', S.sim === sim0 && S.rev === rev0 && S.probes[pi].at[2] !== at0[2], { at0, at: S.probes[pi].at });
              removeProbe(pi); clearPlayer();
            }
            // ---- #32 单键快捷键不吃自动重复（松开右键飞行时 A 还按着）；3D 视图还把飞行结束时仍按着的键的重复吞掉
            {
              setView(3); setTool('select'); S.gizmoMode = 'move';
              key('a', { repeat: true }); key('e', { repeat: true }); key('2', { repeat: true }); key('Delete', { repeat: true });
              const ignored = S.tool === 'select' && S.gizmoMode === 'move' && S.view === 3;
              key('a');
              const aWorks = S.tool === 'anchor';
              setTool('select');
              ev('mousedown', 200, 200, { button: 2, buttons: 2 });
              window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true, cancelable: true }));
              ev('mouseup', 200, 200, { button: 2, buttons: 0 });
              const rep = new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', repeat: true, bubbles: true, cancelable: true });
              window.dispatchEvent(rep);
              const toolAfter = S.tool;
              window.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', code: 'KeyA', bubbles: true }));
              ok('S20 #32 auto-repeat of A / E / 2 / Delete does nothing; a real press still switches; after a fly the held key\'s repeat never reaches the tool keymap',
                ignored && aWorks && toolAfter === 'select' && rep.defaultPrevented, { ignored, aWorks, toolAfter, swallowed: rep.defaultPrevented });
            }
            // ---- #34 拉区域框拉到一半按 Esc：两个视图都作废，松手什么都不写
            for (const view of [2, 3]) {
              setView(view); if (view === 3) v3.fit(true); else v2.fit();
              setTool('areaEmit');
              const lib0 = libKey(), cw = cv().clientWidth, ch = cv().clientHeight;
              ev('mousedown', R(cw * 0.35), R(ch * 0.6));
              ev('mousemove', R(cw * 0.45), R(ch * 0.7)); ev('mousemove', R(cw * 0.5), R(ch * 0.75));
              const drafted = !!S.areaDraft;
              key('Escape');
              ev('mousemove', R(cw * 0.55), R(ch * 0.8));
              ev('mouseup', R(cw * 0.55), R(ch * 0.8));
              ok(`S20 #34 (${view}D) Esc while dragging an area box cancels it: nothing written on release, no draft, tool back to select`,
                drafted && libKey() === lib0 && !S.areaDraft && S.tool === 'select' && !(view === 3 ? v3.drag : v2.drag), { drafted, same: libKey() === lib0, tool: S.tool });
            }
            // ---- #33 删掉选中顶点前面的一个：选中的还是同一个点（下标减一）；删选中的那个 = 清选中
            {
              setView(3); v3.fit(true); setTool('select');
              const ap = activePlacement(), W = S.cal.worldW, H = S.cal.worldH;
              const hex = [[0.3, 0.5], [0.4, 0.45], [0.5, 0.5], [0.5, 0.6], [0.4, 0.65], [0.3, 0.6]].map(([x, y]) => [round1(W * x), round1(H * y)]);
              const uHex = history.undoStack.length;
              editPlacement(ap.id, '自检 #33 六边形', (r) => { r.area = hex; });
              select('area:emit:4');
              const want = areaPoly(activePlacement(), 'emit')[4].slice();
              await deleteAreaVertexKey('area:emit:1');
              const pt = areaKey(S.sel.key);
              ok('S20 #33 deleting a vertex before the selected one keeps the same vertex selected (its index shifts down)',
                S.sel.key === 'area:emit:3' && !!pt && pt.pt[0] === want[0] && pt.pt[1] === want[1], { sel: S.sel.key, want, got: pt && pt.pt });
              await deleteAreaVertexKey('area:emit:3');
              ok('S20 #33 deleting the selected vertex clears the selection', S.sel.key === '' && areaPoly(activePlacement(), 'emit').length === 4);
              // ---- #39 按住右键飞（W）不动鼠标再松开：不是"右键点一下删点"
              const poly = areaPoly(activePlacement(), 'emit'), n0 = poly.length;
              let vp39 = null;
              for (let i = 0; i < poly.length && !vp39; i++) {
                const q = P3(S.cal.sceneToWorldGround(poly[i][0], poly[i][1]));
                const hh = q && v3._hit(q[0], q[1]);
                if (hh && hh.key === `area:emit:${i}`) vp39 = q;
              }
              if (!vp39) log.push('WARN S20 #39 skipped: no area vertex is pickable on screen');
              else {
                ev('mousedown', vp39[0], vp39[1], { button: 2, buttons: 2 });
                key('w');
                ev('mouseup', vp39[0], vp39[1], { button: 2, buttons: 0 });
                window.dispatchEvent(new KeyboardEvent('keyup', { key: 'w', code: 'KeyW', bubbles: true }));
                await wait(30);
                const kept = areaPoly(activePlacement(), 'emit').length === n0 && el('dialog').hidden;
                ev('mousedown', vp39[0], vp39[1], { button: 2, buttons: 2 }); ev('mouseup', vp39[0], vp39[1], { button: 2, buttons: 0 });
                await wait(30);
                ok('S20 #39 right-button + W (fly) without moving the mouse deletes no vertex; a plain right click still does',
                  kept && areaPoly(activePlacement(), 'emit').length === n0 - 1, { kept, n: areaPoly(activePlacement(), 'emit').length, n0 });
              }
              for (let i = 0; i < 12 && history.undoStack.length > uHex; i++) key('z', { ctrlKey: true });
            }
            // ---- #23 没点过布置行时按 ↓：挪的那一行保持活动
            {
              placeHere();
              const mine = () => curRows().filter((r) => r.effect === CUR).map((r) => r.id);
              const ids0 = mine();
              if (ids0.length < 2) log.push('WARN S20 #23 skipped: needs two placements of the temp effect');
              else {
                S.placeId = ''; renderAll();
                const first = activePlacement().id;
                const idx0 = curRows().findIndex((r) => r.id === first);
                const u23 = history.undoStack.length;
                el('btnPlaceDown').click();
                ok('S20 #23 ↓ on a placement nobody clicked keeps that same row active after the swap (highlight / inspector / preview do not jump)',
                  history.undoStack.length === u23 + 1 && activePlacement().id === first && curRows().findIndex((r) => r.id === first) === idx0 + 1, { first, active: activePlacement().id, order: mine() });
                key('z', { ctrlKey: true });
              }
              key('z', { ctrlKey: true });
            }
            // ---- #27 半径：选中时缩放 gizmo 的中心把手先拾；抓线框往外拖 = 半径变大；#35 藏起群体半径 = 线框不拾、选中放掉
            {
              edit('自检 #27 加群体', () => {
                em0().simulation = S.rt.vfxProgram.newEmitterProgram('flock');
                em0().behavior = {
                  cruise: 400, max: 700, maxAccel: 2600, minAltitude: 60, senseRadius: 120, separation: 30,
                  accel: { separation: 2000, alignment: 800, cohesion: 600 }, orbit: { radius: 180, height: 170 },
                  home: { nestRadius: 60, rangeRadius: 600, startleRadius: 300 },
                  attitude: { fear: { 'player:motion': 0.5 } }, initialState: 'roosting',
                };
              });
              const eid = em0().id;
              setView(3); v3.fit(true); setTool('select'); select(`nest:${eid}`);
              const g27 = v3._gizmo();
              const hc = g27 && v3._hit(R(g27.c[0]), R(g27.c[1]));
              ok('S20 #27 with a radius selected, the scale gizmo centre handle wins over the co-located emitter / anchor markers',
                !!hc && hc.kind === 'gz' && Gizmo.isCenter(hc.part), { hit: hc });
              setView(2); v2.fit(); select('');
              const sp = spheres().find((s) => s.key === `startle:${eid}`);
              const c2 = v2.projectWorld(sp.center), e2 = v2.projectWorld([sp.center[0] + sp.radius, sp.center[1], sp.center[2]]);
              const rpx = Math.hypot(e2[0] - c2[0], e2[1] - c2[1]), k = Math.SQRT1_2;
              const at = (f) => [R(c2[0] - rpx * f * k), R(c2[1] + rpx * f * k)];
              const p0 = at(1), h2 = v2._hit(p0[0], p0[1]);
              if (!h2 || h2.key !== `startle:${eid}`) log.push(`WARN S20 #27 ring drag skipped: the ring point hits ${JSON.stringify(h2)}`);
              else {
                const r0 = em0().behavior.home.startleRadius, u27 = history.undoStack.length;
                ev('mousedown', p0[0], p0[1]); ev('mousemove', ...at(1.2)); ev('mousemove', ...at(1.5)); ev('mouseup', ...at(1.5));
                const r1 = em0().behavior.home.startleRadius;
                ok('S20 #27 grabbing a radius ring and dragging it outward resizes that radius (about ×1.5), one history entry, the other radii untouched',
                  Math.abs(r1 / r0 - 1.5) < 0.08 && em0().behavior.home.rangeRadius === 600 && history.undoStack.length === u27 + 1, { r0, r1 });
                // 半径刚拖大了：在**现在的**线框上取一点，先证明看得见时它拾得中（对照），再藏图层
                const sp35 = spheres().find((s) => s.key === `startle:${eid}`);
                const e35 = v2.projectWorld([sp35.center[0] + sp35.radius, sp35.center[1], sp35.center[2]]);
                const r35 = Math.hypot(e35[0] - c2[0], e35[1] - c2[1]);
                const q35 = [R(c2[0] - r35 * k), R(c2[1] + r35 * k)];
                select('');
                const visHit = v2._hit(q35[0], q35[1]);
                select(`startle:${eid}`);
                el('layer_rings').click();
                const hidden = !S.layers.rings;
                const selCleared = S.sel.key === '';
                const h35 = v2._hit(q35[0], q35[1]);
                ok('S20 #35 hiding 群体半径 releases a selected radius and the invisible rings no longer take clicks (the same point picks the ring while visible)',
                  !!visHit && visHit.key === `startle:${eid}` && hidden && selCleared && !(h35 && /^(nest|range|startle):/.test(h35.key)), { visHit, hidden, selCleared, hit: h35 });
                el('layer_rings').click();
              }
              edit('自检 #27 去掉群体', () => { delete em0().behavior; em0().simulation = S.rt.vfxProgram.newEmitterProgram('particle'); });
              setView(3);
            }
            // ---- #30 选锚点 / 顶点 / 刺激点时，检视器与发射器按钮仍作用在最近操作的发射器上，左栏标出它
            {
              addEmitter();
              const second = S.doc.emitters[S.doc.emitters.length - 1].id;
              select(`emitter:${second}`);
              select('anchor');
              const idRow = [...el('inspector').querySelectorAll('.row')].find((r) => r.firstChild && r.firstChild.textContent === '发射器 id');
              const shownId = idRow && idRow.querySelector('input').value;
              const curRow = el('emList').querySelector('.item.cur');
              ok('S20 #30 selecting the anchor keeps the inspector and the emitter buttons on the emitter last worked on (not emitters[0]), marked in the left list',
                currentEmitter().id === second && shownId === second && !!curRow && curRow.getAttribute('data-emitter') === second,
                { cur: currentEmitter().id, shownId, row: curRow && curRow.getAttribute('data-emitter') });
              el('btnDelEmitter').click();
              ok('S20 #30 the emitter × button deletes that emitter (not the first), then the inspector falls back to the first',
                !S.doc.emitters.some((e) => e.id === second) && S.doc.emitters.length >= 1 && currentEmitter().id === em0().id && S.emitterId === '', { ems: S.doc.emitters.map((e) => e.id) });
            }
            // ---- #21 曲线编辑器：拖最大那个键不塌、能拖过当前最大值、横着拖过邻居不覆盖邻居
            {
              select(`emitter:${em0().id}`);
              Inspector.open.appearance = true;
              const uC = history.undoStack.length;
              edit('自检 #21 曲线', () => { em0().appearance.sizeOverLife = [[0, 0.3], [0.4, 1], [1, 2.1]]; });
              const curveCv = () => el('inspector').querySelector('canvas[data-curve="大小×寿命"]');
              let cvs = curveCv();
              const cdown = (x, y) => { const r = cvs.getBoundingClientRect(); cvs.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: r.left + x, clientY: r.top + y })); };
              const cmove = (x, y) => { const r = cvs.getBoundingClientRect(); window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: r.left + x, clientY: r.top + y })); };
              const cup = () => window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
              if (!cvs || !cvs._curve) log.push('WARN S20 #21 skipped: no curve canvas');
              else {
                let m = cvs._curve;
                const p = m.toPx([1, 2.1]), tg = m.toPx([1, 1.6]);
                // MouseEvent client coordinates quantize to CSS pixels. Use the
                // gesture's frozen scale, before mouseup auto-fits the new curve.
                const pixelValue = m.scale() / (m.H - 2 * m.PAD);
                cdown(p[0], p[1]); for (let i = 0; i < 6; i++) cmove(tg[0], tg[1]); cup();
                const c1 = em0().appearance.sizeOverLife;
                ok('S20 #21 dragging the top curve key down to 1.6 lands at 1.6 (scale frozen during the drag, no collapse), the other keys untouched',
                  Math.abs(c1[2][1] - 1.6) <= pixelValue + 1e-6 && c1[0][1] === 0.3 && c1[1][1] === 1, { c1 });
                cvs = curveCv(); m = cvs._curve;
                const pk = m.toPx([1, c1[2][1]]), top = m.toPx([1, m.scale()]);
                cdown(pk[0], pk[1]); cmove(top[0], top[1] + 2); cmove(top[0], top[1] - 6); cup();
                const c2 = em0().appearance.sizeOverLife;
                ok('S20 #21 a key can be dragged above the current maximum (headroom), clamped at the frozen scale',
                  c2[2][1] > c1[2][1] * 1.3 && c2[2][1] <= m.scale() + 1e-9, { c2, scale: m.scale() });
                cvs = curveCv(); m = cvs._curve;
                const k0 = m.toPx([0, 0.3]), mid = m.toPx([0.5, 0.3]), past = m.toPx([0.7, 0.3]);
                cdown(k0[0], k0[1]); cmove(mid[0], mid[1]); cmove(past[0], past[1]); cup();
                const c3 = em0().appearance.sizeOverLife;
                ok('S20 #21 dragging a key horizontally past its neighbour moves only the dragged key (tracked by reference): the neighbour keeps its value',
                  c3.length === 3 && c3.some((q) => q[0] === 0.4 && q[1] === 1) && c3.some((q) => Math.abs(q[0] - 0.7) < 0.02 && Math.abs(q[1] - 0.3) <= m.scale() / (m.H - 2 * m.PAD) + 1e-6), { c3 });
              }
              for (let i = 0; i < 12 && history.undoStack.length > uC; i++) key('z', { ctrlKey: true });
            }
            // ---- #40 刺激反应的 ×：删空的表连表一起删、两张都空 = 删刺激反应；效果暂时不合法时推送回黄字 defErr，不挂红字
            {
              select(`emitter:${em0().id}`);
              Inspector.open.motion = true;
              const u40 = history.undoStack.length;
              edit('自检 #40 运动', () => { em0().motion = { drag: 0.6 }; });
              const q = (s) => el('inspector').querySelector(s);
              const on = q('[data-role=stim-on]');
              if (!on) log.push('WARN S20 #40 skipped: no stimulus button');
              else {
                on.click();
                q('[data-role=stim-tag]').value = 'item:bug';
                q('[data-role="stim-add:attract"]').click();
                q('[data-role="stim-del:fear:player:motion"]').click();
                const st1 = JSON.parse(JSON.stringify(em0().motion.stimulus || null));
                const v40 = await post('/api/validate', { doc: S.doc });
                ok('S20 #40 × on the last fear tag removes the emptied fear table: attract-only is expressible and passes the gate',
                  !!st1 && !('fear' in st1) && !!st1.attract && st1.attract['item:bug'] === 0.5 && v40.ok === true, { st1, err: v40.err });
                q('[data-role="stim-del:attract:item:bug"]').click();
                ok('S20 #40 removing the last tag of the last table removes motion.stimulus (never an empty {} left behind)', !('stimulus' in em0().motion), { motion: em0().motion });
                edit('自检 #40 暂时不合法', () => { em0().motion.stimulus = { fear: {}, accel: 700 }; });
                S.link.on = true;
                const r40 = await publishNow(null);
                renderLinkChip();
                ok('S20 #40 publishing while the effect is momentarily invalid: a yellow "shape" note, not the red "game did not receive" chip',
                  !!r40 && /效果形状不对/.test(r40.defErr || '') && !S.link.rejected && /效果形状不对/.test(el('linkChip').textContent) && !el('linkChip').classList.contains('bad'),
                  { r40, chip: el('linkChip').textContent, cls: el('linkChip').className });
              }
              for (let i = 0; i < 12 && history.undoStack.length > u40; i++) key('z', { ctrlKey: true });
              await publishNow(null);
            }
            // ---- #6 关窗选「不保存」：把盘上那份效果与布置库推给游戏（返回 promise），页面不动，之后不再推工作态
            {
              edit('自检 #6 丢弃前改', () => { em0().spawn.max = 13; });
              const libBefore = libKey(), docBefore = JSON.stringify(S.doc);
              const bodies6 = [], of6 = window.fetch;
              window.fetch = (path, opts) => { if (path === '/api/link/publish' && opts && opts.body) bodies6.push(JSON.parse(opts.body)); return of6(path, opts); };
              S.link.on = true;
              const pr6 = window.__onDiscardUnsaved();
              const isPromise = !!pr6 && typeof pr6.then === 'function';
              await pr6;
              schedulePublish(); await wait(PUBLISH_DEBOUNCE_MS + 80);
              window.fetch = of6;
              const diskDoc = (await API.json(`/api/effect?id=${encodeURIComponent(CUR)}`)).doc;
              const diskLib = (await API.json('/api/placements')).doc;
              const b6 = bodies6[0];
              ok('S20 #6 "don\'t save" on close pushes the on-disk effect and library to the game (a promise the shell waits on); the page is untouched and no working copy follows',
                isPromise && bodies6.length === 1 && JSON.stringify(b6.def) === JSON.stringify(diskDoc) && b6.def.emitters[0].spawn.max !== 13
                && b6.placements.mode === 'scoped' && Object.keys(b6.placements.library.scenes).length === 0 && JSON.stringify(S.doc) === docBefore && libKey() === libBefore && S.dirty,
                { isPromise, n: bodies6.length, max: b6 && b6.def.emitters[0].spawn.max });
              S.link.discarded = false;
              key('z', { ctrlKey: true });
            }
            // ---- #7 游戏页没在跑时点「让游戏切到这个时段」：记下、不发；游戏页起来后带新序号补发。#41 游戏已经是这套外观：按钮灰、不发
            {
              const infoNow = phaseInfo(S.scene.id, S.phase);
              if (!infoNow || !infoNow.timePhase) log.push('WARN S20 #7/#41 skipped: this appearance has no time phase');
              else {
                const bodies7 = [], of7 = window.fetch;
                window.fetch = (path, opts) => { if (path === '/api/link/publish' && opts && opts.body) bodies7.push(JSON.parse(opts.body)); return of7(path, opts); };
                const keepSt = S.link.status;
                S.link.pendingPhase = null;
                S.link.status = { ok: true, connected: false, doc: null };
                const r7 = await requestGamePhase();
                const pendingOk = !!r7 && r7.pending === true && !!S.link.pendingPhase && /游戏页没在跑/.test(el('status').textContent) && !bodies7.some((b) => b.phaseRequest);
                handleLinkStatus({ ok: true, connected: true, gameAlive: true, gameUrl: S.link.gameUrl,
                  doc: { bootId: 'zz-selftest-boot-7', sceneId: S.scene.id, timePhase: '?', appearancePhase: '__zz_other__', instances: [], stats: {} } });
                await wait(200);
                const flushed = bodies7.find((b) => b.phaseRequest);
                ok('S20 #7 with no game page the phase request is remembered (not sent); when the game page comes up it is sent then',
                  pendingOk && !!flushed && flushed.phaseRequest.timePhase === infoNow.timePhase && !S.link.pendingPhase,
                  { pendingOk, flushed: flushed && flushed.phaseRequest, status: el('status').textContent });
                bodies7.length = 0;
                S.link.status = { ok: true, connected: true, gameAlive: true, doc: { bootId: 'zz-selftest-boot-7', sceneId: S.scene.id, timePhase: '?', appearancePhase: S.phase, instances: [], stats: {} } };
                renderPhaseButton();
                const disabled = el('btnPhaseRequest').disabled;
                const r41 = await requestGamePhase();
                await wait(60);
                ok('S20 #41 when the game already shows this scene × appearance the button is disabled and no phase request goes out (no day advanced for nothing)',
                  disabled && r41 === null && !bodies7.some((b) => b.phaseRequest) && /不用切/.test(el('status').textContent), { disabled, r41, status: el('status').textContent });
                window.fetch = of7;
                S.link.status = keepSt; renderPhaseButton();
              }
            }
            // ------------------------------------------------------------------ S21 第四轮复核（2026-09-14）逐条钉住
            // 仍在临时效果 CUR + 临时布置库上；游戏地址是死端口，「拉起游戏」一律被 fetch 桩截住（绝不真起游戏服务）
            {
              setPlaying(false);
              if (S.dirty) { key('s', { ctrlKey: true }); await ioChain; }
              // 同名的行（「效果」一节与「布置」一节都有 id）：`last` = 取最后一个（布置那一节在后）
              const rowOf = (label, last) => { const rs = [...el('inspector').querySelectorAll('.row')].filter((x) => x.firstChild && x.firstChild.textContent === label); return last ? rs[rs.length - 1] : rs[0]; };
              // ---- #22 画布左上角的场景芯片不吃鼠标（原来盖着的那块拉不了框、点不了顶点、滚轮 / 右键都没反应）
              {
                setView(3);
                const r = el('sceneNote').getBoundingClientRect();
                const t = document.elementFromPoint(r.left + Math.min(20, r.width / 2), r.top + r.height / 2);
                ok('S21 #22 the scene-info chip over the canvas lets presses through to the view underneath',
                  r.width > 0 && !!t && ['view3d', 'overlay3d'].includes(t.id), { top: t && (t.id || t.tagName), w: R(r.width) });
              }
              // ---- #7 顶栏长高（窗口没变）：画布缓冲区跟着新的格子走
              {
                setView(3);
                const sized = () => {
                  const c = el('view3d'), r = c.getBoundingClientRect(), d = window.devicePixelRatio || 1;
                  return c.width === Math.max(1, Math.round(r.width * d)) && c.height === Math.max(1, Math.round(r.height * d)) && el('overlay3d').height === c.height;
                };
                const h0 = el('center').getBoundingClientRect().height;
                const pad = h('div', { style: 'height:64px;flex-basis:100%' });
                el('top').appendChild(pad);
                const grew = await until(sized, 1500);
                const h1 = el('center').getBoundingClientRect().height;
                pad.remove();
                const back = await until(sized, 1500);
                ok('S21 #7 when the top bar grows (the canvas cell shrinks with no window resize) the canvas buffers follow the new box, and again when it shrinks back',
                  h1 < h0 - 30 && grew && back, { h0: R(h0), h1: R(h1), grew, back, w: el('view3d').height });
              }
              // ---- #9 删掉选中刺激点前面的一个：选中的还是同一个点
              {
                const n0 = S.probes.length;
                const mk = (x) => ({ at: [x, 0, 0], field: { kind: 'fear', tag: 'item:bug', radius: 100, strength: 1 } });
                S.probes.push(mk(1), mk(2), mk(3));
                select(`probe:${n0 + 1}`);
                removeProbe(n0);
                const kept = S.sel.key === `probe:${n0}` && S.probes[n0].at[0] === 2;
                select(`probe:${n0 + 1}`);
                removeProbe(n0 + 1);
                const cleared = S.sel.key === '';
                ok('S21 #9 removing a stimulus point before the selected one keeps that same point selected; removing the selected one clears the selection',
                  kept && cleared, { kept, cleared, sel: S.sel.key });
                S.probes.length = n0; draw(); renderLeft();
              }
              // ---- #8 暂停时 M 点一下 = 放人（速度 0）；拖 = 位移 ÷ 真实时间，停手归零；按播放从站定开始
              {
                setView(3); v3.fit(true); setPlaying(false); clearPlayer();
                const W8 = S.cal.worldW, H8 = S.cal.worldH;
                const qa = P3(S.cal.sceneToWorldGround(W8 * 0.35, H8 * 0.75)), qb = P3(S.cal.sceneToWorldGround(W8 * 0.65, H8 * 0.75));
                if (!qa || !qb) log.push('WARN S21 #8 skipped: ground points off screen');
                else {
                  setTool('player'); click(qa[0], qa[1]);
                  setTool('player'); click(qb[0], qb[1]);
                  const placed = S.player.on, clickSpeed = S.player.speed;
                  const w0 = S.player.world.slice();
                  await wait(150);
                  setPlayerAt([w0[0] + 60, w0[1], w0[2]], true);
                  const dragSpeed = S.player.speed;
                  await wait(130);
                  stepSim(1 / 60);
                  const settled = S.player.speed;
                  setPlayerAt([w0[0] + 120, w0[1], w0[2]], true);
                  setPlaying(true); const onPlay = S.player.speed; setPlaying(false);
                  ok('S21 #8 an M-tool click places the player standing (speed 0, even a long jump); a paused drag counts distance / real time and settles to 0 when the hand stops; Play starts from standing',
                    placed && clickSpeed === 0 && dragSpeed > 100 && dragSpeed < 600 && settled === 0 && onPlay === 0, { placed, clickSpeed, dragSpeed: R(dragSpeed), settled, onPlay });
                }
                clearPlayer(); setTool('select');
              }
              // ---- #10 Ctrl+S 存的内容与页面一样（服务端只是重排键序）：本地预览不回 t=0
              {
                select(`emitter:${em0().id}`);
                const m0 = em0().spawn.max;
                edit('自检 #10 改池容量', () => { em0().spawn.max = m0 + 1; });
                for (let i = 0; i < 30; i++) stepSim(1 / 60);
                const sim10 = S.sim, t10 = S.simTime;
                key('s', { ctrlKey: true }); await ioChain;
                ok('S21 #10 Ctrl+S keeps the running preview when the saved content equals the page (same sim object, clock not reset)',
                  !!sim10 && !S.dirty && S.sim === sim10 && S.simTime === t10 && t10 > 0, { same: S.sim === sim10, t: S.simTime, t10, dirty: S.dirty });
                edit('自检 #10 复原', () => { em0().spawn.max = m0; });
                key('s', { ctrlKey: true }); await ioChain;
              }
              // ---- #4 检视器里打了数没回车、从外面（主编辑器 / --open，焦点不动）打开别的效果：先提交，再按「有未保存改动」问
              {
                select(`emitter:${em0().id}`);
                const v4 = em0().appearance.sizeWu;
                const inp4 = sizeInput();
                if (S.docDirty || !inp4 || !typeInto(inp4, String(v4 + 2))) log.push('WARN S21 #4 skipped: cannot type into the inspector here');
                else {
                  const p4 = openEffect('bat_cliff', { keepScene: true });
                  const asked = await until(() => !el('dialog').hidden && !!el('dialogForm').querySelector('[data-choice=cancel]'), 3000);
                  const committed = em0().appearance.sizeWu === v4 + 2;
                  const cancel = el('dialogForm').querySelector('[data-choice=cancel]');
                  if (cancel) cancel.click();
                  await p4;
                  ok('S21 #4 opening another effect with no focus move commits the value still being typed and asks save / discard / cancel (cancel keeps it)',
                    asked && committed && S.doc.id === CUR && em0().appearance.sizeWu === v4 + 2, { asked, committed, doc: S.doc.id });
                  if (S.doc.id !== CUR) await openEffect(CUR, { force: true, keepScene: true });
                  else doUndo();
                }
              }
              // ---- #5 检视器焦点按身份放回：湍流强度里打了数没回车、直接点速度上限——上面多出两行，焦点仍在速度上限
              {
                select(`emitter:${em0().id}`);
                Inspector.open.motion = true;
                const u5 = history.undoStack.length;
                edit('自检 #5 运动', () => { em0().motion = { drag: 0.6 }; });
                const numIn = (label) => { const r = rowOf(label); return r && r.querySelector('input[type=number]'); };
                const turb = numIn('湍流强度'), maxS = numIn('速度上限');
                if (!turb || !maxS || !typeInto(turb, '40')) log.push('WARN S21 #5 skipped: cannot type into the inspector here');
                else {
                  press(maxS); maxS.focus(); release(maxS);
                  await until(() => !!numIn('湍流尺度') && el('inspector').contains(document.activeElement), 1000);
                  const ae = document.activeElement, aeRow = ae && ae.closest ? ae.closest('.row') : null;
                  const label = aeRow && aeRow.firstChild ? aeRow.firstChild.textContent : '';
                  ok('S21 #5 committing a value that inserts rows above the clicked box keeps the focus on the box that was clicked (by identity, not by position)',
                    !!em0().motion.turbulence && em0().motion.turbulence.strength === 40 && !!numIn('湍流尺度') && label === '速度上限' && ae.tagName === 'INPUT',
                    { turb: em0().motion.turbulence, active: label });
                  if (ae && ae.blur) ae.blur();
                }
                for (let i = 0; i < 6 && history.undoStack.length > u5; i++) doUndo();
              }
              // ---- #6 id 框改了名没回车、直接点「自动开」下拉并选一项：列表开着时检视器不重建，选中落在活着的下拉上，焦点照常放掉
              {
                let ap6 = activePlacement();
                if (!ap6) { placeHere(); ap6 = activePlacement(); }
                const u6 = history.undoStack.length;
                select(`place:${ap6.id}`);
                Inspector.open.placement = true; renderInspector();
                const idInp = rowOf('id', true) && rowOf('id', true).querySelector('input');
                const autoSel = rowOf('自动开', true) && rowOf('自动开', true).querySelector('select');
                const id0 = ap6.id, id1 = `${ap6.id}_dd`, want = ap6.autoStart === false ? 'true' : 'false';
                // 先把这两格滚进视野再动：focus() 滚右栏发出的 scroll 事件是异步到的，落在列表打开之后会把列表关掉（作者点的本来就是看得见的格子）
                if (autoSel) { autoSel.scrollIntoView({ block: 'center' }); await wait(80); }
                if (!idInp || !autoSel || !typeInto(idInp, id1)) log.push('WARN S21 #6 skipped: no placement id box / autoStart dropdown');
                else {
                  await wait(80);
                  const rr = autoSel.getBoundingClientRect();
                  autoSel.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
                  autoSel.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: rr.left + 5, clientY: rr.top + 5 }));
                  const renamed = curRows().some((r) => r.id === id1);
                  autoSel.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
                  autoSel.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
                  await wait(40);
                  const list = document.getElementById('ddlist');
                  const idx = [...autoSel.options].findIndex((o) => o.value === want);
                  const item = list && idx >= 0 ? list.children[idx] : null;
                  if (item) item.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
                  await wait(60);
                  const row6 = curRows().find((r) => r.id === id1);
                  const ae = document.activeElement;
                  ok('S21 #6 rename in the id box then pick from the autoStart dropdown: the pick lands on that placement and focus is released afterwards',
                    renamed && !!item && !!row6 && String(row6.autoStart) === want && !(ae && ae.tagName === 'SELECT') && !Dropdown.isOpen(),
                    { renamed, item: !!item, autoStart: row6 && row6.autoStart, want, active: ae && ae.tagName });
                }
                for (let i = 0; i < 6 && history.undoStack.length > u6; i++) doUndo();
                // 兜底：列表开着时 <select> 真被拆掉了，选中什么都不写、列表关掉、状态栏说再选一次
                const s6 = h('select', {}, h('option', { value: 'a' }, 'a'), h('option', { value: 'b' }, 'b'));
                document.body.appendChild(s6);
                let changed6 = 0; s6.addEventListener('change', () => { changed6++; });
                const sr = s6.getBoundingClientRect();
                s6.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: sr.left + 3, clientY: sr.top + 3 }));
                const it6 = document.getElementById('ddlist') ? document.getElementById('ddlist').children[1] : null;
                s6.remove();
                if (it6) it6.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
                ok('S21 #6 a pick on a dropdown whose <select> was torn down while the list was open writes nothing, closes the list and says pick again',
                  !!it6 && changed6 === 0 && s6.value === 'a' && !Dropdown.isOpen() && /再点开选一次/.test(el('status').textContent), { it: !!it6, changed6, status: el('status').textContent });
              }
              // ---- #11 滚轮落在有焦点的数值框上：先失焦（检视器与预览条都算），不步进
              {
                select(`emitter:${em0().id}`);
                const inp11 = sizeInput(), v11 = inp11 && inp11.value;
                if (!inp11) log.push('WARN S21 #11 skipped: no size box');
                else {
                  inp11.focus();
                  inp11.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100 }));
                  const insp = document.activeElement !== inp11;
                  const fr = el('fieldRadius');
                  fr.focus();
                  fr.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100 }));
                  const bar = document.activeElement !== fr;
                  ok('S21 #11 wheeling over a focused number box (inspector / preview bar) blurs it first, so the panel scrolls instead of stepping the value',
                    insp && bar && sizeInput().value === v11, { insp, bar });
                }
              }
              // ---- #12 效果的预览锚点只在它的作者场景里用；在别的场景放锚点 = 从出生点起一个、作者场景记成这里
              {
                const au0 = JSON.stringify(S.doc.authoring === undefined ? null : S.doc.authoring), lib0 = S.lib, place0 = S.placeId;
                S.lib = { scenes: {} };                          // 只在内存里：让本份没有布置（活动布置 = null），下面原样换回
                const au = ensureAuthoring();
                au.sceneId = '__zz_other_scene__'; au.background = 'zz.png'; au.anchor = { x: -9999, y: -9999, h: 0 };
                const sa = sceneAnchor();
                const ignored = sa.x !== -9999 && sa.y !== -9999;
                const na = ensureAnchor();
                const stamped = au.sceneId === S.scene.id && au.background === S.scene.background && na.x === sa.x && na.y === sa.y && sceneAnchor() === na;
                const restored = JSON.parse(au0);
                if (restored === null) delete S.doc.authoring; else S.doc.authoring = restored;
                S.lib = lib0; S.placeId = place0; refreshDirty(); rebuildSim(); renderAll();
                ok('S21 #12 an authoring anchor from another scene is not used here (falls back to the spawn point); placing one here starts from that point and records this scene as the author scene',
                  ignored && stamped && !S.dirty, { sa, ignored, stamped });
              }
              // ---- #19 曲线：空曲线画出缺省（恒 1）；第一次点 = 铺上缺省两端再加这一点；右键删到最后一个 = 删掉整个键
              {
                select(`emitter:${em0().id}`);
                Inspector.open.appearance = true;
                const u19 = history.undoStack.length;
                edit('自检 #19 清曲线', () => { delete em0().appearance.alphaOverLife; });
                renderInspector();
                const acv = () => el('inspector').querySelector('canvas[data-curve="透明×寿命"]');
                let c19 = acv();
                if (!c19 || !c19._curve) log.push('WARN S21 #19 skipped: no alpha curve canvas');
                else {
                  const cm = (cv0, x, y, button) => {
                    const r = cv0.getBoundingClientRect();
                    cv0.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button, buttons: button === 2 ? 2 : 1, clientX: r.left + x, clientY: r.top + y }));
                    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                  };
                  const m = c19._curve, pd = m.toPx([0.5, 1]);
                  const px = c19.getContext('2d').getImageData(R(pd[0]) - 4, R(pd[1]) - 1, 8, 3).data;
                  let drawn = false; for (let i = 0; i < px.length; i += 4) if (px[i + 2] > 80) drawn = true;
                  const br = m.toPx([1, 0]);
                  cm(c19, br[0], br[1], 0);
                  const a1 = JSON.parse(JSON.stringify(em0().appearance.alphaOverLife || null));
                  const fade = Array.isArray(a1) && a1.length === 2 && a1[0][0] === 0 && a1[0][1] === 1 && a1[1][0] === 1 && a1[1][1] < 0.05;
                  c19 = acv();
                  const mid = c19._curve.toPx([0.5, 0.5]);
                  cm(c19, mid[0], mid[1], 0);
                  const n2 = (em0().appearance.alphaOverLife || []).length;
                  for (let k = 0; k < 5 && em0().appearance.alphaOverLife; k++) {
                    c19 = acv();
                    const p = c19._curve.toPx(em0().appearance.alphaOverLife[0]);
                    cm(c19, p[0], p[1], 2);
                  }
                  const gone = !('alphaOverLife' in em0().appearance);
                  ok('S21 #19 an empty curve shows the implicit constant 1; the first click seeds both default ends (a fade-out, not a flat 0); right-clicking down to the last key removes the property',
                    drawn && fade && n2 === 3 && gone, { drawn, a1, n2, gone });
                }
                for (let i = 0; i < 12 && history.undoStack.length > u19; i++) doUndo();
              }
              // ---- #24 颜色×寿命（appearance.tintOverLife）：空 = 恒白；第一次加 = 两端白；插在最宽空档正中且画面不变；
              //      改颜色 / 改 t 后按 t 重排、夹 0..1；删到最后一个 = 删键；每一步一条历史，全部撤回 = 原样
              {
                select(`emitter:${em0().id}`);
                Inspector.open.appearance = true;
                const ap24 = () => em0().appearance;
                const before24 = JSON.stringify(ap24().tintOverLife === undefined ? null : ap24().tintOverLife);
                const u24 = history.undoStack.length;
                edit('自检 #24 清颜色曲线', () => { delete ap24().tintOverLife; });
                renderInspector();
                const q = (sel) => el('inspector').querySelector(sel);
                const keyRow = (n) => [...el('inspector').querySelectorAll('.sec[data-sec="appearance"] .row')]
                  .find((r) => r.firstElementChild && r.firstElementChild.textContent.trim() === `键 ${n}`);
                const setInput = (inp, v) => { inp.value = String(v); inp.dispatchEvent(new Event('change', { bubbles: true })); };
                if (!q('[data-role="tol-add"]') || !q('canvas[data-role="tol-bar"]')) log.push('FAIL S21 #24 no 颜色×寿命 editor under 乘色');
                else {
                  const white = JSON.stringify(q('canvas[data-role="tol-bar"]')._sample(0.3)) === JSON.stringify([1, 1, 1]);
                  const h0 = history.undoStack.length;
                  q('[data-role="tol-add"]').click();
                  const seeded = JSON.stringify(ap24().tintOverLife) === JSON.stringify([[0, 1, 1, 1], [1, 1, 1, 1]]) && history.undoStack.length === h0 + 1;
                  setInput(keyRow(2).querySelectorAll('input')[3], 0.2);            // 键 2（t=1）的 b → 0.2
                  const recolored = JSON.stringify(ap24().tintOverLife[1]) === JSON.stringify([1, 1, 1, 0.2]);
                  const mid0 = q('canvas[data-role="tol-bar"]')._sample(0.5);
                  q('[data-role="tol-add"]').click();                                 // 插在 0..1 正中，颜色取插值 → 画面不变
                  const k3 = ap24().tintOverLife;
                  const inserted = k3.length === 3 && k3[1][0] === 0.5 && Math.abs(k3[1][3] - mid0[2]) < 1e-3
                    && Math.abs(q('canvas[data-role="tol-bar"]')._sample(0.5)[2] - mid0[2]) < 1e-3;
                  setInput(keyRow(1).querySelectorAll('input')[0], 0.8);            // 键 1 的 t 0 → 0.8：重排到中间
                  const ts = ap24().tintOverLife.map((k) => k[0]);
                  const resorted = JSON.stringify(ts) === JSON.stringify([0.5, 0.8, 1]);
                  setInput(keyRow(1).querySelectorAll('input')[3], 7);              // 键 1 的 b 7 → 夹到 1；键 3 的 t -3 → 夹到 0
                  setInput(keyRow(3).querySelectorAll('input')[0], -3);
                  const clamped = ap24().tintOverLife.every((k) => k.every((x) => x >= 0 && x <= 1))
                    && ap24().tintOverLife[0][0] === 0 && ap24().tintOverLife.every((k, i, a) => !i || a[i - 1][0] <= k[0]);
                  const swatch = !!q('[data-role="tol-swatch:0"]');
                  for (let i = 0; i < 6 && ap24().tintOverLife; i++) q('[data-role="tol-del:0"]').click();
                  const gone = !('tintOverLife' in ap24());
                  const steps = history.undoStack.length - h0;
                  for (let i = 0; i < 20 && history.undoStack.length > u24; i++) doUndo();
                  const restored = JSON.stringify(ap24().tintOverLife === undefined ? null : ap24().tintOverLife) === before24;
                  ok('S21 #24 颜色×寿命: empty shows constant white; first add seeds white ends; add inserts at the widest gap without changing the look; edits re-sort by t and clamp to 0..1; deleting the last key removes the property; one history entry per step and undo restores the asset',
                    white && seeded && recolored && inserted && resorted && clamped && swatch && gone && steps === 9 && restored,
                    { white, seeded, recolored, inserted, resorted, clamped, swatch, gone, steps, restored });
                }
              }
              // ---- #20 方向键微移锚点：连按合成一次手势（一条历史、途中不重建预览），松键 / 停手 400 ms 收尾，吞掉按键不滚面板
              {
                let ap20 = activePlacement();
                if (!ap20) { placeHere(); ap20 = activePlacement(); }
                setView(3); setTool('select'); select(`place:${ap20.id}`);
                resetSim(); for (let i = 0; i < 10; i++) stepSim(1 / 60);
                const sim20 = S.sim, u20 = history.undoStack.length, a20 = JSON.stringify(activePlacement().anchor);
                const k1 = key('ArrowRight', { shiftKey: true });
                for (let i = 0; i < 5; i++) key('ArrowRight', { shiftKey: true, repeat: true });
                const during = S.sim === sim20 && history.undoStack.length === u20 && JSON.stringify(activePlacement().anchor) !== a20;
                window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
                const one = history.undoStack.length === u20 + 1 && !history.inDrag();
                doUndo();
                const back = JSON.stringify(activePlacement().anchor) === a20;
                key('ArrowLeft');
                await wait(550);
                const idle = history.undoStack.length === u20 + 1 && !history.inDrag();
                doUndo();
                ok('S21 #20 holding an arrow on the placement anchor is one gesture: no preview rebuild meanwhile, one history entry on key-up (and after 400 ms idle), one Ctrl+Z undoes it, the key is consumed',
                  k1.defaultPrevented && during && one && back && idle, { prevented: k1.defaultPrevented, during, one, back, idle, undo: history.undoStack.length - u20, u20 });
              }
              // ---- #21 / #23 同一效果两条布置、改第二条的名：预览跟着第二条；撤销 / 重做后选中的仍是这一条
              {
                const mine = () => curRows().filter((r) => r.effect === CUR);
                const u21 = history.undoStack.length;
                for (let i = 0; i < 3 && mine().length < 2; i++) placeHere();
                if (mine().length < 2) log.push('WARN S21 #21 skipped: needs two placements of the temp effect');
                else {
                  const p2 = mine()[1], idA = p2.id, idB = `${p2.id}_ren`;
                  select(`place:${idA}`);
                  S.confineStash[stashKey(idA)] = { area: [[0, 0], [10, 0], [10, 10]] };
                  const renamed = renamePlacement(idA, idB);
                  const afterRen = renamed && activePlacement().id === idB && S.simInput.placement === idB && !!S.confineStash[stashKey(idB)] && !S.confineStash[stashKey(idA)];
                  doUndo();
                  const afterUndo = activePlacement().id === idA && S.simInput.placement === idA && S.sel.key === 'anchor';
                  doRedo();
                  const afterRedo = activePlacement().id === idB && S.simInput.placement === idB;
                  ok('S21 #21/#23 renaming the second placement of an effect keeps the preview on it; undo / redo keep the selection on that same placement (never the first one)',
                    afterRen && afterUndo && afterRedo, { afterRen, afterUndo, afterRedo, active: activePlacement() && activePlacement().id, sim: S.simInput && S.simInput.placement });
                  delete S.confineStash[stashKey(idA)]; delete S.confineStash[stashKey(idB)];
                }
                for (let i = 0; i < 8 && history.undoStack.length > u21; i++) doUndo();
              }
              // ---- #3 游戏在别的场景时点「让游戏切到这个时段」：不报成功、先让游戏切到本场景，进来了按本场景再判一次才发
              {
                const info3 = phaseInfo(S.scene.id, S.phase);
                if (!info3 || !info3.timePhase) log.push('WARN S21 #3 skipped: this appearance has no time phase');
                else {
                  const posts = [], of3 = window.fetch;
                  window.fetch = (path, opts) => {
                    if (path === '/api/link/launch') {
                      posts.push({ path, body: JSON.parse(opts.body) });
                      return Promise.resolve(new Response(JSON.stringify({ ok: true, mode: 'switch', message: 'zz' }), { headers: { 'Content-Type': 'application/json' } }));
                    }
                    if (path === '/api/link/publish' && opts && opts.body) posts.push({ path, body: JSON.parse(opts.body) });
                    return of3(path, opts);
                  };
                  const keepSt = S.link.status;
                  S.link.on = true; S.link.pendingPhase = null;
                  const other = { ok: true, connected: true, gameAlive: true, gameUrl: S.link.gameUrl,
                    doc: { bootId: 'zz-selftest-boot-3', sceneId: '__zz_other_scene__', timePhase: '?', appearancePhase: '', instances: [], stats: {} } };
                  const inScene = (ap) => Object.assign({}, other, { doc: Object.assign({}, other.doc, { sceneId: S.scene.id, appearancePhase: ap }) });
                  const phaseSent = () => posts.some((p) => p.body && p.body.phaseRequest);
                  handleLinkStatus(other);
                  const r3 = await requestGamePhase();
                  await wait(60);
                  const launch = posts.filter((p) => p.path === '/api/link/launch');
                  const held = !!r3 && r3.pending === true && launch.length === 1 && launch[0].body.sceneId === S.scene.id && !phaseSent()
                    && !/已让游戏.*切到时段/.test(el('status').textContent) && !!S.link.pendingPhase;
                  handleLinkStatus(other);                       // 游戏还在别的场景：不发、不重复拉
                  await wait(60);
                  const waiting = !phaseSent() && posts.filter((p) => p.path === '/api/link/launch').length === 1 && !!S.link.pendingPhase;
                  handleLinkStatus(inScene('__zz_other_appearance__'));
                  await wait(200);
                  const fired = posts.find((p) => p.body && p.body.phaseRequest);
                  ok('S21 #3 with the game in another scene the phase request is held (no success claimed), the game is switched to this scene, and the request goes out once it arrives',
                    held && waiting && !!fired && fired.body.phaseRequest.timePhase === info3.timePhase && !S.link.pendingPhase,
                    { held, waiting, fired: fired && fired.body.phaseRequest, launch: launch.map((p) => p.body), status: el('status').textContent });
                  posts.length = 0;
                  handleLinkStatus(other);
                  await requestGamePhase();
                  await wait(40);
                  handleLinkStatus(inScene(S.phase));
                  await wait(150);
                  ok('S21 #3 when the game arrives and this scene already shows this appearance, nothing is sent (re-checked on arrival, no day advanced)',
                    !phaseSent() && !S.link.pendingPhase && /不用切/.test(el('status').textContent), { sent: phaseSent(), status: el('status').textContent });
                  window.fetch = of3;
                  S.link.pendingPhase = null; S.link.status = keepSt;
                  renderPhaseButton(); renderGamePanel(); renderLinkChip();
                }
              }
              // ------------------------------------------------------------------ S22 第五轮审查（2026-09-14）逐条钉住
              // 仍在临时效果 CUR + 临时布置库上；游戏地址是死端口，引用接口 / 发布一律可被 fetch 桩截住
              {
                setPlaying(false);
                if (S.dirty) { key('s', { ctrlKey: true }); await ioChain; }
                // ---- #3 武装着 A / M / K / 拉区域 / H 时去左栏选中东西 = 回到选择工具、gizmo 立刻有；Esc 退回任何工具
                {
                  setView(3);
                  const emId = em0().id;
                  setTool('anchor'); select('');
                  select(`emitter:${emId}`);
                  const direct = S.tool === 'select' && S.sel.key === `emitter:${emId}` && !!gizmoPivot() && (!v3.ok || !!v3._gizmo());
                  setTool('field'); select('');
                  const row3 = el('emList').querySelector(`[data-emitter="${CSS.escape(emId)}"]`);
                  if (row3) row3.click();
                  const viaRow = !!row3 && S.tool === 'select' && S.sel.key === `emitter:${emId}`;
                  const esc = {};
                  for (const t of ['anchor', 'player', 'field', 'pan', 'areaEmit']) { setTool(t); key('Escape'); esc[t] = S.tool; }
                  ok('S22 #3 selecting something while A / M / K / area / H is armed returns to the select tool (gizmo right away); Esc disarms every tool',
                    direct && viaRow && Object.values(esc).every((t) => t === 'select'), { direct, viaRow, esc, tool: S.tool });
                  setTool('select');
                }
                // ---- #4 存盘后撤销再重做（服务端重排过键序）：内容与盘上一样就不脏，按钮 / 标题 / 关窗提示都不亮，Ctrl+S 不重写文件
                {
                  select(`emitter:${em0().id}`);
                  const had4 = 'blend' in em0().appearance, b4 = em0().appearance.blend;
                  if (had4) { edit('自检 S22 #4 去混合', () => { delete em0().appearance.blend; }); key('s', { ctrlKey: true }); await ioChain; }
                  edit('自检 S22 #4 加混合', () => { em0().appearance.blend = 'add'; });
                  key('s', { ctrlKey: true }); await ioChain;
                  const savedClean = !S.dirty;
                  doUndo();
                  const undoDirty = S.docDirty;
                  doRedo();
                  const redoClean = !S.docDirty && !S.dirty && el('btnSave').textContent === '保存' && !el('btnSave').classList.contains('dirty')
                    && !/●/.test(document.title) && !unsavedSummary();
                  const saves = [], ofs = window.fetch;
                  window.fetch = (p, o) => { if (p === '/api/save' || p === '/api/placements/save') saves.push(p); return ofs(p, o); };
                  key('s', { ctrlKey: true }); await ioChain;
                  window.fetch = ofs;
                  const rev = (o) => (Array.isArray(o) ? o.map(rev) : o && typeof o === 'object' ? Object.fromEntries(Object.keys(o).reverse().map((k) => [k, rev(o[k])])) : o);
                  const keepDoc = S.doc, keepLib = S.lib;
                  S.doc = rev(keepDoc); S.lib = rev(keepLib); refreshDirty();
                  const revClean = !S.docDirty && !S.libDirty;
                  S.doc = keepDoc; S.lib = keepLib; refreshDirty();
                  edit('自检 S22 #4 真改', () => { em0().spawn.max += 1; });
                  const realDirty = S.docDirty && el('btnSave').textContent === '保存 ●' && /效果/.test(el('btnSave').title) && /●/.test(document.title);
                  doUndo();
                  const backClean = !S.dirty;
                  edit('自检 S22 #4 复原', () => { if (had4) em0().appearance.blend = b4; else delete em0().appearance.blend; });
                  if (S.dirty) { key('s', { ctrlKey: true }); await ioChain; }
                  ok('S22 #4 undo + redo after a save (server reordered the keys) is not dirty: no 保存 ●, no ● in the title, no close prompt, Ctrl+S rewrites nothing; a real change still lights them',
                    savedClean && undoDirty && redoClean && saves.length === 0 && revClean && realDirty && backClean,
                    { savedClean, undoDirty, redoClean, saves, revClean, realDirty, backClean, btn: el('btnSave').textContent });
                }
                // ---- #5 撤销 / 重做后区域顶点的选中跟着同一个点：撤掉插的点 = 放掉选中；撤掉删点 = 回到原来那个点；撤掉挪点 = 下标照旧
                {
                  let ap5 = activePlacement();
                  if (!ap5) { placeHere(); ap5 = activePlacement(); }
                  if (!ap5) log.push('WARN S22 #5 skipped: no placement of the temp effect here');
                  else {
                    const u5 = history.undoStack.length;
                    select(`place:${ap5.id}`);
                    editPlacement(ap5.id, '自检 S22 #5 区域', (r) => { r.area = [[100, 100], [300, 100], [300, 300], [100, 300], [50, 200]]; });
                    select('area:emit:2');
                    insertAreaVertex('emit', 0, [200, 100]);
                    const insSel = S.sel.key === 'area:emit:1';
                    doUndo();
                    const undoIns = S.sel.key === '';
                    select('area:emit:2');
                    await deleteAreaVertexKey('area:emit:0');
                    const shifted = S.sel.key === 'area:emit:1';
                    doUndo();
                    const undoDel = S.sel.key === 'area:emit:2';
                    doRedo();
                    const redoDel = S.sel.key === 'area:emit:1';
                    doUndo();
                    select('area:emit:1');
                    editPlacement(ap5.id, '自检 S22 #5 挪点', (r) => { r.area[1] = [320, 90]; });
                    doUndo();
                    const undoMove = S.sel.key === 'area:emit:1';
                    ok('S22 #5 undo / redo keep the area-vertex selection on the same point (undoing an insert releases it; undoing a delete returns to the picked point; undoing a move keeps it)',
                      insSel && undoIns && shifted && undoDel && redoDel && undoMove, { insSel, undoIns, shifted, undoDel, redoDel, undoMove, sel: S.sel.key });
                    for (let i = 0; i < 12 && history.undoStack.length > u5; i++) doUndo();
                    select('');
                  }
                }
                // ---- #10 2D 里图层「场景」去勾 = 原画不画（与 3D 同一个开关）
                {
                  setView(2);
                  const ctx = el('view2d').getContext('2d');
                  let nBg = 0;
                  const orig = ctx.drawImage;
                  ctx.drawImage = function (img, ...rest) { if (img === v2.bg) nBg++; return orig.call(this, img, ...rest); };
                  v2.draw(); const drawnOn = nBg;
                  const box = el('layer_mesh');
                  nBg = 0; box.checked = false; box.dispatchEvent(new Event('change', { bubbles: true })); v2.draw();
                  const drawnOff = nBg;
                  box.checked = true; box.dispatchEvent(new Event('change', { bubbles: true }));
                  delete ctx.drawImage;
                  ok('S22 #10 unticking the 场景 layer hides the art in the 2D view too (ticking it brings it back)',
                    !!v2.bg && drawnOn > 0 && drawnOff === 0 && S.layers.mesh === true, { bg: !!v2.bg, drawnOn, drawnOff });
                  setView(3);
                }
                // ---- #11 / #2 预览锚点记在别的场景：检视器不把那份的数当成这里的值、左栏标「默认：出生点」；「记为作者场景」从出生点起一个新的
                {
                  const au0 = JSON.stringify(S.doc.authoring === undefined ? null : S.doc.authoring), lib0 = S.lib, place0 = S.placeId;
                  S.lib = { scenes: {} };                        // 只在内存里：让本份没有布置（活动布置 = null），下面原样换回
                  const au = ensureAuthoring();
                  au.sceneId = '__zz_other_scene__'; au.background = 'zz.png'; au.anchor = { x: -9999, y: -8888, h: 37, surface: 'shell' };
                  Inspector.open.effect = true; renderInspector(); renderLeft();
                  const insp = el('inspector').textContent;
                  const inspOk = !/-9,?999|-8,?888/.test(insp) && !!el('inspector').querySelector('[data-role=foreignAnchor]') && !rowOf('离面高') && !rowOf('落在');
                  const leftOk = /默认：出生点/.test(el('emList').textContent);
                  const sa = sceneAnchor();
                  bindAuthoringScene();
                  const bound = au.sceneId === S.scene.id && au.background === S.scene.background && !!au.anchor && au.anchor.x === sa.x && au.anchor.y === sa.y
                    && au.anchor.x !== -9999 && sceneAnchor() === au.anchor;
                  renderInspector();
                  const inspHere = !!rowOf('离面高') && !el('inspector').querySelector('[data-role=foreignAnchor]');
                  const restored = JSON.parse(au0);
                  if (restored === null) delete S.doc.authoring; else S.doc.authoring = restored;
                  S.lib = lib0; S.placeId = place0; refreshDirty(); rebuildSim(); renderAll();
                  ok('S22 #11/#2 an authoring anchor recorded in another scene is not shown as this scene\'s values (left row says default spawn); 记为作者场景 reseeds it from the spawn point instead of adopting the other scene\'s coordinates',
                    inspOk && leftOk && bound && inspHere && !S.dirty, { inspOk, leftOk, bound, inspHere, anchor: au.anchor, sa, dirty: S.dirty });
                }
                // ---- #0 删布置：全库再没有这个 id、而布置库之外有 playVfx / 条件引用它 → 列出文件 · 位置、要明确确认；取消不删；接口出错照删
                {
                  const u0 = history.undoStack.length;
                  placeHere();
                  let ap0 = activePlacement();
                  // 别的时段外观里可能复制过同 id 的（S18 / S20）：改成全库唯一的 id，删它才是"最后一条"
                  if (ap0 && instanceIdCount(ap0.id) !== 1) { renamePlacement(ap0.id, `zz_s22_del_${Date.now()}`); ap0 = activePlacement(); }
                  if (!ap0 || instanceIdCount(ap0.id) !== 1) log.push('WARN S22 #0 skipped: no unique placement of the temp effect here');
                  else {
                    const id0 = ap0.id;
                    let mode = 'refs'; const asked = [];
                    const of0 = window.fetch;
                    window.fetch = (p, o) => {
                      if (typeof p === 'string' && p.startsWith('/api/instance_refs')) {
                        asked.push(p);
                        const body = mode === 'refs'
                          ? { ok: true, refs: [{ file: 'public/assets/data/quests/zz.json', path: 'quests[0].actions[2]', kind: 'playVfx' }, { file: 'public/assets/dialogues/zz.json', path: 'nodes.n1.condition', kind: 'condition' }] }
                          : { error: 'zz boom' };
                        return Promise.resolve(new Response(JSON.stringify(body), { status: mode === 'refs' ? 200 : 500, headers: { 'Content-Type': 'application/json' } }));
                      }
                      return of0(p, o);
                    };
                    select(`place:${id0}`);
                    key('Delete');
                    const dlg = await until(() => !el('dialog').hidden, 3000);
                    const msg0 = el('dialogForm').textContent;
                    const listed = /zz\.json · quests\[0\]\.actions\[2\]/.test(msg0) && /nodes\.n1\.condition/.test(msg0) && /条件/.test(msg0) && /主编辑器/.test(msg0);
                    const cancel0 = el('dialogForm').querySelector('[data-choice=cancel]');
                    if (cancel0) cancel0.click(); else key('Escape');
                    await wait(40);
                    const kept = curRows().some((r) => r.id === id0);
                    select(`place:${id0}`);
                    const pDel = delPlacement();
                    await until(() => !el('dialog').hidden, 3000);
                    const go0 = el('dialogForm').querySelector('[data-choice=delete]');
                    if (go0) go0.click();
                    const done0 = await pDel;
                    const gone0 = !curRows().some((r) => r.id === id0);
                    doUndo();
                    const back0 = curRows().some((r) => r.id === id0);
                    mode = 'error';
                    select(`place:${id0}`);
                    const pErr = delPlacement();
                    await wait(60);
                    const noDialog = el('dialog').hidden;
                    if (!noDialog) { const c = el('dialogForm').querySelector('[data-choice=cancel]'); if (c) c.click(); }
                    const doneErr = await pErr;
                    window.fetch = of0;
                    ok('S22 #0 deleting the last placement with an id that playVfx / conditions still use lists file + path and needs an explicit confirm (cancel keeps it, confirm deletes, Ctrl+Z restores); an endpoint error deletes as before',
                      dlg && listed && kept && done0 === true && gone0 && back0 && noDialog && doneErr === true && asked.length >= 3,
                      { dlg, listed, kept, done0, gone0, back0, noDialog, doneErr, asked: asked.length, msg: msg0.slice(0, 200) });
                  }
                  for (let i = 0; i < 8 && history.undoStack.length > u0; i++) doUndo();
                  select('');
                }
                // ---- #1 联动勾掉之后关窗「不保存」：之前推过工作态，就照样把盘上那份推给游戏；从没推过就不推
                {
                  const bodies1 = [], of1 = window.fetch;
                  window.fetch = (p, o) => { if (p === '/api/link/publish' && o && o.body) { bodies1.push(JSON.parse(o.body)); return Promise.resolve(new Response(JSON.stringify({ ok: false, connected: false }), { headers: { 'Content-Type': 'application/json' } })); } return of1(p, o); };
                  const keepOn = S.link.on, keepPub = S.link.lastPub;
                  S.link.on = false; S.link.lastPub = Date.now();
                  const r1 = await window.__onDiscardUnsaved();
                  const pushedOff = bodies1.length === 1 && bodies1[0].effectId === CUR && S.link.discarded;
                  S.link.discarded = false; bodies1.length = 0; S.link.lastPub = 0;
                  const r1b = await window.__onDiscardUnsaved();
                  const skipped = r1b === null && bodies1.length === 0 && !S.link.discarded;
                  window.fetch = of1;
                  S.link.on = keepOn; S.link.lastPub = keepPub; S.link.discarded = false; renderLinkChip();
                  ok('S22 #1 "don\'t save" with 联动 unticked still pushes the on-disk copy when working copies had reached the game; never-delivered stays silent',
                    !!r1 && pushedOff && skipped, { pushedOff, skipped, n: bodies1.length });
                }
                // ---- #6 键盘逐项切场景 / 时段外观：装载门拿走的焦点装完放回那个下拉框，不进历史
                {
                  const sel6 = el('sceneSel');
                  sel6.focus();
                  const u6b = history.undoStack.length;
                  await loadScene(S.scene.id, S.phase, { refocus: true });
                  const kept6 = document.activeElement === sel6 && history.undoStack.length === u6b && !S.busy;
                  sel6.blur();
                  ok('S22 #6 a keyboard-driven top-bar dropdown change gets its focus back after the busy load (the next arrow keeps stepping)', kept6,
                    { active: document.activeElement && (document.activeElement.id || document.activeElement.tagName) });
                }
                // ---- #9 预览条状态字变长变短不折行（画布不跳）；全文在 title
                {
                  const info9 = el('simInfo'), bar = el('simbar');
                  const h0 = bar.getBoundingClientRect().height;
                  info9.textContent = '状态'.repeat(400);
                  const h1 = bar.getBoundingClientRect().height;
                  renderSimBar();
                  ok('S22 #9 the preview status is one line with an ellipsis (a long status never adds a row to the preview bar); full text in the title',
                    Math.abs(h1 - h0) < 1 && getComputedStyle(info9).whiteSpace === 'nowrap' && info9.title === info9.textContent && info9.textContent.length > 0,
                    { h0: R(h0), h1: R(h1) });
                }
              }
              // ------------------------------------------------------------------ S23 第六轮审查（2026-09-14）逐条钉住
              // 仍在临时效果 CUR + 临时布置库上；改动一律撤回到进块前的历史长度
              {
                setPlaying(false);
                if (S.dirty) { key('s', { ctrlKey: true }); await ioChain; }
                if (!activePlacement()) placeHere();
                // ---- #0 离锚点约 11 px 的区域顶点：点在顶点上拿到的是顶点（最近的），什么都没选 / 选着锚点都一样；叠着的并列才看选中项
                {
                  const u0 = history.undoStack.length;
                  const ap = activePlacement();
                  if (!ap) log.push('WARN S23 #0 skipped: no placement of the temp effect here');
                  else {
                    editPlacement(ap.id, '自检 S23 #0 锚点贴地', (r) => { r.anchor = { x: round1(S.cal.worldW * 0.5), y: round1(S.cal.worldH * 0.6) }; });
                    if (em0().offset) edit('自检 S23 #0 发射器偏移归零', () => { delete em0().offset; });
                    const emKey = `emitter:${em0().id}`;
                    const results = {};
                    for (const view of [3, 2]) {
                      setView(view); if (view === 3) v3.fit(true); else v2.fit();
                      setTool('select'); select('');
                      const proj = (w) => (view === 3 ? v3.project(w) : v2.projectWorld(w));
                      const view0 = view === 3 ? v3 : v2;
                      const a = activePlacement().anchor, ca = proj(anchorWorld());
                      // 沿八个方向在画面上找一个离锚点标记 10.5～11.5 px 的地面点当顶点（旧的锚点 12 px / 发射器 13 px 拾取圈都盖得住它）
                      let pt = null;
                      for (let k = 0; k < 8 && ca && !pt; k++) {
                        const dx = Math.cos(k * Math.PI / 4), dy = Math.sin(k * Math.PI / 4);
                        for (let s = 0.5; s < 400 && !pt; s += 0.5) {
                          const cand = [round1(a.x + dx * s), round1(a.y + dy * s)];
                          const c = proj(vertexWorld(cand));
                          const d = c && Math.hypot(c[0] - ca[0], c[1] - ca[1]);
                          if (d >= 10.5 && d <= 11.5) pt = cand;
                        }
                      }
                      if (!pt) { log.push(`WARN S23 #0 (${view}D) skipped: no ground point about 11 px from the anchor marker`); continue; }
                      editPlacement(ap.id, `自检 S23 #0 区域（${view}D）`, (r) => { r.area = [pt, [pt[0] + 400, pt[1]], [pt[0] + 400, pt[1] + 400], [pt[0], pt[1] + 400]]; });
                      const cv0 = proj(vertexWorld(pt));
                      const q = [R(cv0[0]), R(cv0[1])];
                      select('');
                      const hNone = view0._hit(q[0], q[1]);
                      select('anchor');
                      const hAnchor = view0._hit(q[0], q[1]);
                      click(q[0], q[1]);
                      const clicked = S.sel.key;
                      // 叠着的锚点与零偏移发射器（并列）：选着发射器时仍拿发射器（左栏选中之后能直接拖它），什么都没选时拿锚点
                      const cA = proj(anchorWorld()), qa = [R(cA[0]), R(cA[1])];
                      select(emKey);
                      const hKeep = view0._hit(qa[0], qa[1]);
                      select('');
                      const hTie = view0._hit(qa[0], qa[1]);
                      results[view] = { d: R(Math.hypot(cv0[0] - ca[0], cv0[1] - ca[1]) * 10) / 10, hNone, hAnchor, clicked, hKeep, hTie };
                      ok(`S23 #0 (${view}D) an area vertex ~11 px from the placement anchor: pressing it picks the vertex (nothing selected, and with the anchor selected); co-located anchor / emitter still tie-break by selection then anchor-first`,
                        !!hNone && hNone.key === 'area:emit:0' && !!hAnchor && hAnchor.key === 'area:emit:0' && clicked === 'area:emit:0'
                          && !!hKeep && hKeep.key === emKey && !!hTie && hTie.key === 'anchor', results[view]);
                    }
                    setView(3); select('');
                    for (let i = 0; i < 20 && history.undoStack.length > u0; i++) key('z', { ctrlKey: true });
                  }
                }
                // ---- #1 发射方向：没写 = 各向同性（下拉明写，不显示成 0/1/0），锥角灰掉；指定 / 改回不写各一条历史；子发射器没写 = 沿命中法线、锥角可用
                {
                  const u0 = history.undoStack.length;
                  setView(3); setTool('select');
                  select(`emitter:${em0().id}`);
                  Inspector.open.spawn = true;
                  edit('自检 S23 #1 去方向', () => { delete em0().spawn.direction; delete em0().subOnly; });
                  renderInspector(); await wait(30);
                  const modeSel = () => el('inspector').querySelector('select[data-role=spawnDirMode]');
                  const spreadInp = () => { const r = rowOf('锥角'); return r && r.querySelector('input[type=number]'); };
                  const m1 = modeSel(), s1 = spreadInp();
                  const unsetOk = !!m1 && m1.value === '' && /各向同性/.test(m1.selectedOptions[0].textContent) && !rowOf('方向向量')
                    && !!s1 && s1.disabled && /无意义/.test(rowOf('锥角').title || '') && !!m1.dataset.key;
                  const u1 = history.undoStack.length;
                  if (m1) { m1.value = 'set'; m1.dispatchEvent(new Event('change', { bubbles: true })); }
                  await wait(40);
                  const setOk = JSON.stringify(em0().spawn.direction) === '[0,1,0]' && history.undoStack.length === u1 + 1
                    && !!rowOf('方向向量') && rowOf('方向向量').querySelectorAll('input[type=number]').length === 3 && !!spreadInp() && !spreadInp().disabled;
                  edit('自检 S23 #1 斜一点', () => { em0().spawn.direction = [0.3, 1, 0]; em0().spawn.spread = 20; });
                  renderInspector(); await wait(30);
                  const u2 = history.undoStack.length;
                  const m2 = modeSel();
                  if (m2) { m2.value = ''; m2.dispatchEvent(new Event('change', { bubbles: true })); }
                  await wait(40);
                  const backOk = !('direction' in em0().spawn) && history.undoStack.length === u2 + 1 && !rowOf('方向向量') && !!modeSel() && modeSel().value === '';
                  edit('自检 S23 #1 子发射器', () => { em0().subOnly = true; delete em0().behavior; em0().simulation = S.rt.vfxProgram.newEmitterProgram('particle'); });
                  renderInspector(); await wait(30);
                  const m3 = modeSel(), s3 = spreadInp();
                  const subOk = !!m3 && /沿命中法线/.test(m3.selectedOptions[0].textContent) && !!s3 && !s3.disabled;
                  ok('S23 #1 spawn 方向 unset reads 各向同性（不写） with 锥角 disabled; 指定方向 seeds [0,1,0] in one edit; switching back deletes spawn.direction in one edit; a subOnly emitter says 沿命中法线 and keeps 锥角',
                    unsetOk && setOk && backOk && subOk, { unsetOk, setOk, backOk, subOk, spawn: em0().spawn });
                  for (let i = 0; i < 20 && history.undoStack.length > u0; i++) key('z', { ctrlKey: true });
                  renderInspector();
                }
                // ---- #2 A 工具：有活动布置时状态 / 撤销叫「挪布置锚点 · id」、按钮提示说改的是布置；没有布置才是「放预览锚点」
                {
                  const u0 = history.undoStack.length;
                  const ap = activePlacement();
                  const btn = document.querySelector('#tools button[data-tool="anchor"]');
                  if (!ap || !btn) log.push('WARN S23 #2 skipped: no placement of the temp effect / no A button');
                  else {
                    setTool('anchor');
                    const titlePlaced = btn.title;
                    setAnchorScene(ap.anchor.x + 7, ap.anchor.y);
                    const labelPlaced = history.peekUndo();
                    const moved = history.undoStack.length === u0 + 1;
                    for (let i = 0; i < 5 && history.undoStack.length > u0; i++) key('z', { ctrlKey: true });
                    const lib0 = S.lib, place0 = S.placeId;
                    S.lib = { scenes: {} };                    // 只在内存里：让本份没有布置（活动布置 = null），下面原样换回
                    renderLeft();
                    const titleNone = btn.title, labelNone = anchorToolEditLabel();
                    S.lib = lib0; S.placeId = place0; refreshDirty(); rebuildSim(); renderAll(); setTool('select');
                    ok('S23 #2 with a placement active the A tool is labelled as moving that placement\'s anchor (undo / status label and button title); without one it stays 放预览锚点 / authoring.anchor',
                      moved && labelPlaced === `挪布置锚点 · ${ap.id}` && titlePlaced.includes(ap.id) && /游戏用的/.test(titlePlaced)
                        && labelNone === '放预览锚点' && /authoring\.anchor/.test(titleNone) && !titleNone.includes(ap.id),
                      { labelPlaced, labelNone, titlePlaced, titleNone });
                  }
                }
                // ---- #3 受光强度（appearance.lightGain）：受光时有一行（紧跟 镜面/自发光）；填数 = 一条历史写进 appearance.lightGain（夹 0..10）；清空 = 删键；关了受光这一行消失
                {
                  const u0 = history.undoStack.length;
                  setView(3); setTool('select');
                  select(`emitter:${em0().id}`);
                  Inspector.open.appearance = true;
                  edit('自检 S23 #3 受光', () => { delete em0().appearance.lit; delete em0().appearance.lightGain; });
                  renderInspector(); await wait(30);
                  const gainInp = () => { const r = rowOf('受光强度'); return r && r.querySelector('input[type=number]'); };
                  const rowLabels = () => [...el('inspector').querySelectorAll('.row')].map((r) => r.firstChild && r.firstChild.textContent);
                  const commit = async (v) => { const i = gainInp(); if (!i) return false; i.value = v; i.dispatchEvent(new Event('change', { bubbles: true })); await wait(40); return true; };
                  const g1 = gainInp();
                  const labs = rowLabels();
                  const shownOk = !!g1 && g1.value === '' && g1.placeholder === '1' && /不乘自发光/.test(g1.title)
                    && labs.indexOf('受光强度') === labs.indexOf('镜面/自发光') + 1;
                  const ua = history.undoStack.length;
                  await commit('2.5');
                  const setOk = em0().appearance.lightGain === 2.5 && history.undoStack.length === ua + 1 && history.peekUndo() === '改受光强度';
                  await commit('99');
                  const clampOk = em0().appearance.lightGain === 10 && history.undoStack.length === ua + 2;
                  await commit('');
                  const clearOk = !('lightGain' in em0().appearance) && history.undoStack.length === ua + 3;
                  doUndo(); await wait(30);
                  const undoOk = em0().appearance.lightGain === 10;
                  edit('自检 S23 #3 关受光', () => { em0().appearance.lit = false; });
                  renderInspector(); await wait(30);
                  const hiddenOk = !rowOf('受光强度') && !rowOf('镜面/自发光');
                  ok('S23 #3 受光强度 row sits right after 镜面/自发光 while lit (empty box, placeholder 1); typing writes appearance.lightGain in one undoable edit, clamps to 10, clearing deletes the key; the row is gone when lit is off',
                    shownOk && setOk && clampOk && clearOk && undoOk && hiddenOk,
                    { shownOk, setOk, clampOk, clearOk, undoOk, hiddenOk, labs, ap: em0().appearance });
                  for (let i = 0; i < 20 && history.undoStack.length > u0; i++) key('z', { ctrlKey: true });
                  renderInspector();
                }
                // ---- #4 跟着发射点走（motion.followAnchor）：运动模块里一行**页内**下拉；选「完全跟」= 一条历史写 "full"；
                //      选「不跟」= 一条历史删键（运动模块因此空了连模块一起删，渲染不往 doc 里塞空容器）；群体 / 薄片没写时不出下拉
                {
                  const u0 = history.undoStack.length;
                  setView(3); setTool('select');
                  select(`emitter:${em0().id}`);
                  Inspector.open.motion = true;
                  edit('自检 S23 #4 普通粒子带运动', () => {
                    delete em0().behavior; delete em0().plate; delete em0().subOnly;
                    em0().simulation = S.rt.vfxProgram.newEmitterProgram('particle');
                    em0().motion = { drag: 0.6 };
                  });
                  renderInspector(); await wait(30);
                  const faSel = () => el('inspector').querySelector('select[data-role=followAnchor]');
                  const naRow = () => el('inspector').querySelector('[data-role=followAnchor-na]');
                  const pickVia = async (value) => {
                    const s = faSel();
                    if (!s) return false;
                    const r = s.getBoundingClientRect();
                    const cancelled = s.dispatchEvent(new MouseEvent('mousedown', {
                      bubbles: true, cancelable: true, button: 0, buttons: 1,
                      clientX: Math.round(r.left + r.width / 2), clientY: Math.round(r.top + r.height / 2),
                    })) === false;
                    const l = document.getElementById('ddlist');
                    const idx = [...s.options].findIndex((o) => o.value === value);
                    if (!cancelled || !l || idx < 0) { Dropdown.close(); return false; }
                    l.children[idx].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
                    await wait(60);
                    return !Dropdown.isOpen();
                  };
                  const s1 = faSel();
                  const shownOk = !!s1 && s1.value === '' && [...s1.options].map((o) => o.value).join('|') === '|rig|full'
                    && /不跟（缺省）/.test(s1.selectedOptions[0].textContent) && /跟动作、不跟走/.test(s1.options[1].textContent)
                    && /完全跟/.test(s1.options[2].textContent) && /只有效果挂在手持挂件上/.test(s1.title) && /playPropVfx/.test(s1.title)
                    && !!rowOf('跟着发射点走') && !naRow();
                  const ua = history.undoStack.length;
                  const fullOk = (await pickVia('full')) && em0().motion.followAnchor === 'full' && em0().motion.drag === 0.6
                    && history.undoStack.length === ua + 1 && history.peekUndo() === '改跟着发射点走' && !!faSel() && faSel().value === 'full';
                  const noneOk = (await pickVia('')) && !!em0().motion && !('followAnchor' in em0().motion) && em0().motion.drag === 0.6
                    && history.undoStack.length === ua + 2 && !!faSel() && faSel().value === '';
                  // 运动模块本来没有：看一眼不写 doc；选「跟动作、不跟走」在写入时补模块；选「不跟」删键，空模块一起删
                  edit('自检 S23 #4 去运动模块', () => { delete em0().motion; });
                  renderInspector(); await wait(30);
                  const ub = history.undoStack.length;
                  const readOnly = !('motion' in em0()) && !!faSel();
                  const rigOk = (await pickVia('rig')) && JSON.stringify(em0().motion) === '{"followAnchor":"rig"}' && history.undoStack.length === ub + 1;
                  const pruneOk = (await pickVia('')) && !('motion' in em0()) && history.undoStack.length === ub + 2;
                  // 群体：没写 = 不出下拉，只一行灰字（title 说群体 / 薄片不吃）；写了 = 下拉照出 + 黄字提醒（好选「不跟」删掉）
                  edit('自检 S23 #4 群体', () => {
                    em0().simulation = S.rt.vfxProgram.newEmitterProgram('flock');
                    em0().behavior = {
                      cruise: 400, max: 700, maxAccel: 2600, minAltitude: 60, senseRadius: 120, separation: 30,
                      accel: { separation: 2000, alignment: 800, cohesion: 600 }, orbit: { radius: 180, height: 170 },
                      home: { nestRadius: 60, rangeRadius: 600, startleRadius: 300 },
                      attitude: { fear: { 'player:motion': 0.5 } }, initialState: 'roosting',
                    };
                    em0().motion = { drag: 0.6 };
                  });
                  renderInspector(); await wait(30);
                  const flockHidden = !faSel() && !!naRow() && /群体 \/ 薄片不吃 followAnchor，写了没用/.test(naRow().title);
                  edit('自检 S23 #4 群体写了 full', () => { em0().motion.followAnchor = 'full'; });
                  renderInspector(); await wait(30);
                  const warnEl = el('inspector').querySelector('[data-role=followAnchor-warn]');
                  const flockStale = !!faSel() && faSel().value === 'full' && !!warnEl && /写了没用/.test(warnEl.textContent) && !naRow();
                  edit('自检 S23 #4 薄片', () => {
                    delete em0().behavior; delete em0().motion;
                    em0().plate = { size: [16, 16], terminalSpeed: 90 };
                    em0().simulation = S.rt.vfxProgram.newEmitterProgram('plate');
                  });
                  renderInspector(); await wait(30);
                  const plateHidden = !faSel() && !!naRow() && /薄片/.test(naRow().textContent);
                  ok('S23 #4 跟着发射点走 is an in-page dropdown in 运动 (不跟 / 跟动作、不跟走 / 完全跟, title says rig only differs on a held prop); 完全跟 writes motion.followAnchor:"full" in one edit, 不跟 deletes the key in one edit (and an emptied motion module), rendering never adds a container; hidden for flock / plate unless already written (then shown with a warning)',
                    shownOk && fullOk && noneOk && readOnly && rigOk && pruneOk && flockHidden && flockStale && plateHidden,
                    { shownOk, fullOk, noneOk, readOnly, rigOk, pruneOk, flockHidden, flockStale, plateHidden, motion: em0().motion });
                  for (let i = 0; i < 30 && history.undoStack.length > u0; i++) key('z', { ctrlKey: true });
                  renderInspector();
                }
                // ---- #5 最远烧到多远（life.maxDistance）：寿命模块里一行数值框（空 = 不写，占位「不限」）；填数 = 一条历史写进去、
                //      本地预览按新定义重建（跑的是打包进来的运行时 stepGeneric），强恒定风里这个发射器的粒子离原点不超过这个距离；
                //      清空 / 填 ≤ 0 = 删键；没有寿命 / 群体 / 薄片没写时不出输入框，写了照出 + 黄字提醒
                {
                  const u0 = history.undoStack.length;
                  setView(3); setTool('select');
                  select(`emitter:${em0().id}`);
                  Inspector.open.life = true;
                  const ap5 = activePlacement();
                  if (ap5 && (ap5.area || ap5.confine)) editPlacement(ap5.id, '自检 S23 #5 去区域', (r) => { delete r.area; delete r.confine; });
                  const MAXSPD = 300;
                  edit('自检 S23 #5 普通粒子 + 强风', () => {
                    const e = em0();
                    delete e.behavior; delete e.plate; delete e.subOnly; delete e.collision; delete e.offset;
                    e.simulation = S.rt.vfxProgram.newEmitterProgram('particle');
                    e.spawn = { max: 300, rate: 150 };
                    e.motion = { wind: [1200, 0, 0], maxSpeed: MAXSPD };
                    e.life = { seconds: [3, 3] };
                  });
                  renderInspector(); await wait(30);
                  const mdInp = () => el('inspector').querySelector('input[data-role=maxDistance]');
                  const mdNa = () => el('inspector').querySelector('[data-role=maxDistance-na]');
                  const mdWarn = () => el('inspector').querySelector('[data-role=maxDistance-warn]');
                  const commitMd = async (v) => { const i = mdInp(); if (!i) return false; i.value = v; i.dispatchEvent(new Event('change', { bubbles: true })); await wait(40); return true; };
                  const simEm = () => S.sim && S.sim.emitters.find((x) => x.def.id === em0().id);
                  const farthest = () => {
                    const e = simEm(); if (!e) return { d: -1, n: 0 };
                    let d = 0, n = 0;
                    for (let i = 0; i < e.p.cap; i++) {
                      if (!e.p.alive[i]) continue;
                      n++; d = Math.max(d, Math.hypot(e.p.x[i] - e.origin[0], e.p.y[i] - e.origin[1], e.p.z[i] - e.origin[2]));
                    }
                    return { d, n };
                  };
                  const run = (sec) => { const o = simEm() && simEm().origin.slice(); for (let i = 0; i < Math.round(sec * 60); i++) stepSim(1 / 60); return !!o && JSON.stringify(o) === JSON.stringify(simEm().origin); };
                  const i1 = mdInp(), row1 = rowOf('最远烧到多远');
                  const shownOk = !!i1 && i1.value === '' && i1.placeholder === '不限' && /火星、烟不要写/.test(i1.title) && /按燃烧强度和风自动缩短/.test(i1.title)
                    && !!row1 && /wu/.test(row1.textContent) && !mdNa() && !mdWarn() && !('maxDistance' in em0().life) && !S.simErr;
                  const still0 = run(2.5);
                  const free = farthest();
                  const freeOk = still0 && free.n > 0 && free.d > 200;       // 不写：强风把粒子吹出去几百 wu
                  const ua = history.undoStack.length, sim0 = S.sim;
                  await commitMd('60');
                  const e5 = simEm();
                  const setOk = em0().life.maxDistance === 60 && JSON.stringify(Object.keys(em0().life)) === '["seconds","maxDistance"]'
                    && history.undoStack.length === ua + 1 && history.peekUndo() === '改最远烧到多远'
                    && S.sim !== sim0 && !!e5 && e5.def.life && e5.def.life.maxDistance === 60 && !!mdInp() && mdInp().value === '60';
                  const still1 = run(2.5);
                  const lim = farthest();
                  // 死亡判定在挪位置之前：活着的最多比界线多走一个子步（速度上限 × 1/120 s）
                  const limitOk = still1 && lim.n > 0 && lim.d <= 60 + MAXSPD / 120 + 1e-6;
                  await commitMd('');
                  const clearOk = !('maxDistance' in em0().life) && history.undoStack.length === ua + 2 && !!mdInp() && mdInp().value === '';
                  await commitMd('-5');
                  const nonPosOk = !('maxDistance' in em0().life) && history.undoStack.length === ua + 2;
                  doUndo(); await wait(30);
                  const undoOk = em0().life.maxDistance === 60 && !!simEm() && simEm().def.life.maxDistance === 60;
                  // 没有 life.seconds（永生）：没写 = 灰字；群体：没写 = 灰字，写了 = 输入框照出 + 黄字；薄片：灰字
                  edit('自检 S23 #5 永生', () => { em0().life = {}; });
                  renderInspector(); await wait(30);
                  const noLifeHidden = !mdInp() && !!mdNa() && /没有寿命 \/ 群体 \/ 薄片不吃 maxDistance，写了没用/.test(mdNa().title) && /life\.seconds/.test(mdNa().title);
                  edit('自检 S23 #5 群体', () => {
                    em0().simulation = S.rt.vfxProgram.newEmitterProgram('flock');
                    em0().behavior = {
                      cruise: 400, max: 700, maxAccel: 2600, minAltitude: 60, senseRadius: 120, separation: 30,
                      accel: { separation: 2000, alignment: 800, cohesion: 600 }, orbit: { radius: 180, height: 170 },
                      home: { nestRadius: 60, rangeRadius: 600, startleRadius: 300 },
                      attitude: { fear: { 'player:motion': 0.5 } }, initialState: 'roosting',
                    };
                    em0().motion = { drag: 0.6 };
                    em0().spawn = { max: 12 };
                    em0().life = { seconds: [1, 2] };
                  });
                  renderInspector(); await wait(30);
                  const flockHidden = !mdInp() && !!mdNa() && /这是群体发射器/.test(mdNa().title);
                  edit('自检 S23 #5 群体写了 maxDistance', () => { em0().life.maxDistance = 40; });
                  renderInspector(); await wait(30);
                  const flockStale = !!mdInp() && mdInp().value === '40' && !!mdWarn() && /写了没用/.test(mdWarn().textContent) && !mdNa();
                  edit('自检 S23 #5 薄片', () => {
                    delete em0().behavior; delete em0().motion;
                    em0().life = { seconds: [1, 2] };
                    em0().plate = { size: [16, 16], terminalSpeed: 90 };
                    em0().simulation = S.rt.vfxProgram.newEmitterProgram('plate');
                  });
                  renderInspector(); await wait(30);
                  const plateHidden = !mdInp() && !!mdNa() && /薄片/.test(mdNa().textContent);
                  ok('S23 #5 最远烧到多远 (life.maxDistance) is an optional number row in 寿命 (empty, placeholder 不限, the burn-out tooltip); typing 60 writes it after seconds in one edit and rebuilds the local sim with that def, whose particles then stay within 60 wu (+ one substep) of the origin under a strong constant wind (without it they fly > 200 wu); clearing / ≤ 0 deletes the key; hidden for immortal / flock / plate unless already written (then shown with a warning)',
                    shownOk && freeOk && setOk && limitOk && clearOk && nonPosOk && undoOk && noLifeHidden && flockHidden && flockStale && plateHidden,
                    { shownOk, freeOk, free: { d: R(free.d), n: free.n }, setOk, limitOk, lim: { d: R(lim.d * 100) / 100, n: lim.n }, clearOk, nonPosOk, undoOk, noLifeHidden, flockHidden, flockStale, plateHidden, err: S.simErr, life: em0().life });
                  for (let i = 0; i < 40 && history.undoStack.length > u0; i++) key('z', { ctrlKey: true });
                  renderInspector();
                }
              }
            }
            // ---- #37 动画「状态 / 栖息状态」是下拉（候选 = 动画包的 states），打错的旧值保值显示（真资产只读打开，绝不存）
            if (S.effects.some((r) => r.id === 'bat_cliff')) {
              await openEffect('bat_cliff', { force: true, keepScene: true });
              const e37 = (S.doc.emitters || []).find((e) => e.appearance && e.appearance.animFile);
              if (!e37) log.push('WARN S20 #37 skipped: bat_cliff has no animFile emitter');
              else {
                select(`emitter:${e37.id}`);
                const rowSel = (label) => { const r = [...el('inspector').querySelectorAll('.row')].find((x) => x.firstChild && x.firstChild.textContent === label); return r ? r.querySelector('select') : null; };
                const opts = (s) => (s ? [...s.options].map((o) => o.value) : []);
                const st = rowSel('状态'), rs = rowSel('栖息状态');
                ok('S20 #37 animation 状态 / 栖息状态 are dropdowns listing the anim pack states (no free-text box)',
                  !!st && !!rs && opts(st).includes('fly') && opts(st).includes('hang') && st.value === (e37.appearance.state || '') && rs.value === (e37.appearance.restState || ''),
                  { st: opts(st), value: st && st.value });
                const keep = e37.appearance.state;
                e37.appearance.state = 'fyl'; renderInspector();       // 只改内存看渲染（不经 edit、不存）
                const st2 = rowSel('状态');
                const dangling = !!st2 && st2.value === 'fyl' && /候选里没有/.test(st2.selectedOptions[0].textContent);
                e37.appearance.state = keep; renderInspector();
                ok('S20 #37 a typo value stays visible as "current value, not a candidate" instead of being silently replaced', dangling && !S.docDirty);
              }
            }
            // ---- #38 只被挂件预设用着的效果：左栏列出引用、不说"游戏里不会出现"；删除要看着清单明确选；改名拒绝并说去主编辑器改哪个文件
            if (S.effects.some((r) => r.id === 'incense_smoke')) {
              if (S.libDirty) { key('s', { ctrlKey: true }); await ioChain; }
              await openEffect('incense_smoke', { force: true, keepScene: true });
              if (!S.extRefs.some((r) => r.kind === 'prop')) log.push('WARN S20 #38 skipped: no held prop uses incense_smoke in this checkout');
              else {
                // 挂件 id 取自本检出的真实引用（where 形如「<id> · states.<s>.particles[i]」），不写死——预设改名不该让自检变红
                const propId = S.extRefs.find((r) => r.kind === 'prop').where.split(' · ')[0];
                const panel = el('placeElsewhere').textContent;
                ok('S20 #38 an effect used only by a held prop: the panel lists the prop reference and no longer says it never appears in game',
                  panel.includes(`挂件预设「${propId}」`) && !/游戏里不会出现/.test(panel), { panel, propId });
                const pd = deleteEffect();
                await until(() => !el('dialog').hidden, 3000);
                const msg = el('dialogForm').textContent;
                const cancel = el('dialogForm').querySelector('[data-choice=cancel]') || [...el('dialogForm').querySelectorAll('button')].find((b) => b.textContent === '取消');
                if (cancel) cancel.click(); else key('Escape');
                await pd;
                let still = false;
                try { still = !!(await API.json('/api/effect?id=incense_smoke')).doc; } catch (e) { still = false; }
                ok('S20 #38 deleting it lists the held-prop reference and waits for an explicit choice (cancel leaves the file alone)',
                  msg.includes(propId) && /主编辑器/.test(msg) && still && el('dialog').hidden, { msg: msg.slice(0, 240), still });
                // 不 await 到底：退化成弹改名框时自检不许卡死在对话框上——看一眼、有框就 Esc 掉再判 FAIL
                const pRen38 = renameEffect();
                await wait(60);
                const noDialog = el('dialog').hidden;
                if (!noDialog) key('Escape');
                await pRen38;
                ok('S20 #38 renaming is refused while held props still use the id, naming the file to fix in the main editor (no dialog)',
                  noDialog && /prop_presets\.json/.test(el('status').textContent) && /主编辑器/.test(el('status').textContent), { status: el('status').textContent });
              }
            }
          }
        }
      }
    }
    // ------------------------------------------------------------------ S24 燃烧两字段（2026-09-16）：外部给点 external / 薄片绑可燃模板 burnable
    // 运行时已落地：external 没给点就一颗都不发（工作台里没有燃烧系统 ⇒ 预览用假点代发，只在预览内存里）；
    // plate.burnable = {template}：绑了面燃烧模板的纸碰火受热 → 着 → 焦黑 → 成灰永久没了（参数全取模板；火焰调试工具经
    // VfxStepContext.fires 喂火焰段；模板表经打包的 resolveBurnable 当 burnTemplates 传进模拟）。
    // 只写 zz_selftest_burn_* 临时效果；模板只读工程里的真模板（本台从不写 assets/data/burnables/），改模板的情形拦截 fetch 假造。
    {
      const until24 = async (fn, ms) => { const t0 = performance.now(); while (!fn() && performance.now() - t0 < (ms || 20000)) await wait(40); return fn(); };
      if (!el('dialog').hidden) key('Escape');
      await until24(() => !S.busy, 20000);
      if (!S.cal || !S.rt) { const base = S.scenes.find((s) => s.depth); if (base) await loadScene(base.id, ''); }
      const ins = () => el('inspector');
      const q = (role) => ins().querySelector(`[data-role="${role}"]`);
      const fire = (n, v) => { if (n.type === 'checkbox') n.checked = v; else n.value = String(v); n.dispatchEvent(new Event('change', { bubbles: true })); };
      const settle = async () => { await wait(20); renderInspector(); await wait(20); };
      const FIRE_ID = 'zz_selftest_burn_fire', PAPER_ID = 'zz_selftest_burn_paper';
      // 上一轮自检中途退出留下的临时效果先删掉（带确认：临时效果不该被谁引用，万一有也照删）
      for (const id of [PAPER_ID, FIRE_ID]) { await post('/api/delete', { id, withPlacements: true, confirmExternal: true }); tmp.push(id); }
      // ---- 外部给点：检视器切形状 → 本地预览看得见（假点）→ jitter 空 = 删键 → 存盘往返
      const cr = await post('/api/create', { id: FIRE_ID, sceneId: S.scene.id, background: S.scene.background, label: '自检 外部给点' });
      await refreshEffects();
      if (!cr.ok) log.push(`FAIL S24 create ${FIRE_ID} ${JSON.stringify(cr)}`);
      else {
        S.dirty = false; S.docDirty = false;
        await openEffect(FIRE_ID, { force: true, keepScene: true });
        select(`emitter:${em0().id}`); await settle();
        const u0 = history.undoStack.length;
        const shapeSel = q('spawnShape');
        const hasOpt = !!shapeSel && [...shapeSel.options].some((o) => o.value === 'external' && /外部给点（燃烧系统）/.test(o.textContent));
        fire(shapeSel, 'external'); await settle();
        const sh = em0().spawn.shape;
        const note = q('external-note');
        ok('S24 #1 the spawn shape dropdown offers 「外部给点（燃烧系统）」; picking it writes exactly {kind:"external"} (no jitter default) in one undo step, shows the jitter row and the note (no external points in the workbench → preview fake points; the real thing in the burn workbench)',
          hasOpt && JSON.stringify(sh) === '{"kind":"external"}' && history.undoStack.length === u0 + 1 && S.docDirty
          && !!q('shape-jitter') && q('shape-jitter').value === '' && q('shape-jitter').placeholder === '1'
          && !!note && /燃烧工作台/.test(note.textContent) && /预览用假点/.test(note.textContent),
          { hasOpt, sh, undo: history.undoStack.length - u0, note: note && note.textContent });
        // 运行时本体：不给点 = 一颗不发；工作台每帧交预览用假点（同一个 setSpawnPoints）= 看得见
        rebuildSim();
        for (let i = 0; i < 60; i++) S.sim.step(1 / 60, { fields: [], player: null, time: i / 60 });
        const bare = S.sim.liveCount;
        resetSim();
        for (let i = 0; i < 60; i++) stepSim(1 / 60);
        const a = anchorWorld();
        let far = 0;
        const e0r = S.sim.emitters[0];
        for (let k = 0; k < e0r.p.cap; k++) if (e0r.p.alive[k] && Math.hypot(e0r.p.x[k] - a[0], e0r.p.y[k] - a[1], e0r.p.z[k] - a[2]) > EXT_PREVIEW_SPREAD_WU + EXT_PREVIEW_RADIUS_WU + 40) far++;
        renderSimBar(); draw();
        const marks = previewMarks().filter((m) => !m.top);
        ok('S24 #2 without points the runtime sim spawns nothing; the workbench feeds preview-only fake points around the anchor every frame so particles show up there, marked 「预览用假点」 in the view and the sim bar',
          bare === 0 && S.sim.liveCount > 0 && far === 0 && marks.length === EXT_PREVIEW_COUNT && marks[0].label === '预览用假点（外部给点）'
          && /预览用假点/.test(el('simInfo').textContent),
          { bare, live: S.sim.liveCount, far, marks: marks.length, info: el('simInfo').textContent });
        fire(q('shape-jitter'), 0.5); await settle();
        const j1 = em0().spawn.shape.jitter;
        fire(q('shape-jitter'), ''); await settle();
        const j2 = 'jitter' in em0().spawn.shape;
        fire(q('shape-jitter'), 2); await settle();
        await saveEffect();
        const back = (await API.json(`/api/effect?id=${encodeURIComponent(FIRE_ID)}`)).doc;
        ok('S24 #3 jitter: typing writes it, clearing deletes the key; save round-trips {kind:"external", jitter:2} exactly, clean, and no preview point ever reaches the file',
          j1 === 0.5 && !j2 && !S.dirty && JSON.stringify(back.emitters[0].spawn.shape) === '{"kind":"external","jitter":2}'
          && canonJson(back) === canonJson(S.doc) && !/spawnPoints|预览用假点/.test(JSON.stringify(back)),
          { j1, j2, dirty: S.dirty, shape: back.emitters[0].spawn.shape });
        await openEffect(FIRE_ID, { force: true, keepScene: true }); await settle();
        ok('S24 #3 reopening shows the external shape and its jitter', !!q('spawnShape') && q('spawnShape').value === 'external' && q('shape-jitter').value === '2' && !S.dirty);
      }
      // ---- 可燃模板（plate.burnable = {template}）：模板表 == 打包的 resolveBurnable / 候选只含面燃烧模板 / 选中写、选空删 /
      //      未知值与消耗燃烧保值展示并说原因 / 只读参数 / 旧 flammable 提示与删掉 / 存盘往返 / 打开燃烧工作台（拦截 fetch）/
      //      窗口重新获得焦点重读、内容真变了才重建 / 火焰调试点着绑了面燃烧模板的纸、绑消耗燃烧的不着。
      // 模板用工程里的真模板（只读；本台从不写 assets/data/burnables/），能绑的 / 消耗燃烧的各挑第一份
      let bt = null;
      try { bt = await API.json('/api/burnables'); } catch (e) { log.push(`FAIL S24 /api/burnables ${e && e.message}`); }
      const spreadT = bt && bt.templates.find((r) => r.bindable);
      const consumeT = bt && bt.templates.find((r) => r.mode === 'consume');
      if (!spreadT || !consumeT) log.push(`FAIL S24 needs one bindable (spread) and one consume template in assets/data/burnables ${JSON.stringify(bt && bt.templates.map((r) => [r.id, r.mode, r.bindable]))}`);
      const paperDoc = { id: PAPER_ID, label: '自检 可燃纸', emitters: [{
        id: 'paper',
        simulation: { solver: 'plate', spawnPlacement: 'surface', surfaceRadius: 30, initialVelocity: 'rest',
          influences: { sceneWind: false, wind: false, airflow: false, stimulus: false, contact: false }, recycle: { mode: 'none' } },
        appearance: { image: '/resources/runtime/images/vfx/dust.png', sizeWu: 16 },
        spawn: { max: 60, burst: 60, shape: { kind: 'area', radius: 30 } },
        plate: { size: [16, 16], terminalSpeed: 90 },
      }] };
      const sv = spreadT && consumeT ? await post('/api/save', { doc: paperDoc }) : { ok: false, err: 'no templates' };
      await refreshEffects();
      if (!sv.ok) log.push(`FAIL S24 save ${PAPER_ID} ${JSON.stringify(sv)}`);
      else {
        S.dirty = false; S.docDirty = false;
        await openEffect(PAPER_ID, { force: true, keepScene: true });
        select('emitter:paper'); await settle();
        // #4 页面模板表：服务端每一份原始文档过**打包进来的** resolveBurnable(doc, id)，不在页面里另写清洗
        const rt = S.rt.burnables;
        const mapOk = S.burn.loaded && !S.burn.err && S.burn.map instanceof Map
          && JSON.stringify(S.burn.rows.map((r) => r.id)) === JSON.stringify(bt.templates.map((r) => r.id))
          && S.burn.rows.every((r) => {
            const want = rt.resolveBurnable(r.doc, r.id);
            return want ? S.burn.map.has(r.id) && canonJson(S.burn.map.get(r.id)) === canonJson(want) : !S.burn.map.has(r.id);
          })
          && S.burn.map.size === S.burn.rows.filter((r) => rt.resolveBurnable(r.doc, r.id)).length;
        const rs = S.burn.map.get(spreadT.id), sum = spreadT.summary;
        const P = S.rt.vfxPlateBurn.resolvePlateBurnParams(rs);
        ok('S24 #4 the page template table is every /api/burnables doc passed through the bundled runtime resolveBurnable(doc, id) (nothing cleaned in page JS); the server summary agrees with the resolved template (ignition delay, flame length, opposed speed)',
          mapOk && rs.mode === 'spread' && S.burn.map.get(consumeT.id) && S.burn.map.get(consumeT.id).mode === 'consume'
          && rs.ignitionDelay === sum.ignitionDelay && rs.flameLengthCm === sum.flameLength && rs.speedOpposed === sum.speedOpposed
          && P.template === spreadT.id && Math.abs(P.flameLenWu - sum.flameLength * 0.88) < 1e-9,
          { mapOk, ids: S.burn.rows.map((r) => r.id), rs: rs && { ig: rs.ignitionDelay, fl: rs.flameLengthCm, vo: rs.speedOpposed }, sum });
        // #5 选择器：候选只含能绑的（面燃烧）模板；选中写 plate.burnable = {template}、一次历史；只读参数（缺省灰显）；选空删键
        const clean0 = canonJson(S.doc), u0 = history.undoStack.length;
        const sel0 = q('burnable-template');
        const optVals = sel0 ? [...sel0.options].map((o) => o.value) : [];
        const wantVals = [''].concat(bt.templates.filter((r) => r.bindable).map((r) => r.id));
        const offOk = !!sel0 && sel0.value === '' && JSON.stringify(optVals) === JSON.stringify(wantVals) && !optVals.includes(consumeT.id)
          && !q('burn-sum:label') && !q('burnable-why') && !!q('burn-open') && canonJson(S.doc) === clean0 && !S.dirty;
        fire(sel0, spreadT.id); await settle();
        const setOk = JSON.stringify(em0().plate.burnable) === JSON.stringify({ template: spreadT.id }) && history.undoStack.length === u0 + 1 && S.docDirty;
        const dflt = new Set(sum.defaulted || []);
        const sumKeys = ['ignitionDelay', 'flameLength', 'speedOpposed', 'speedConcurrent'];
        const sumOk = !!q('burn-sum:label') && q('burn-sum:label').textContent === (sum.label || spreadT.id)
          && q('burn-sum:size').textContent.includes(String(sum.widthCm)) && q('burn-sum:size').textContent.includes(String(sum.heightCm))
          && sumKeys.every((k) => q(`burn-sum:${k}`) && q(`burn-sum:${k}`).textContent.includes(String(sum[k])) && q(`burn-sum:${k}`).classList.contains('dim') === dflt.has(k))
          && q('burn-sum:light').textContent === (sum.light ? '有' : '没有')
          && (sum.particles.length ? sum.particles.every((p) => q('burn-sum:particles').textContent.includes(p)) : q('burn-sum:particles').textContent === '（没有）')
          && !q('burnable-why') && q('burnable-template').value === spreadT.id;
        const u1 = history.undoStack.length;
        fire(q('burnable-template'), ''); await settle();
        const emptyOk = !('burnable' in em0().plate) && history.undoStack.length === u1 + 1 && !q('burn-sum:label') && q('burnable-template').value === '';
        ok('S24 #5 可燃模板 is a selector whose candidates are exactly the bindable (spread) templates from the server; picking one writes plate.burnable = {template} in one undo step and shows its key parameters read-only (defaults greyed); picking 不可燃 deletes the key in one step',
          offOk && setOk && sumOk && emptyOk, { offOk, optVals, wantVals, setOk, burnable: em0().plate.burnable, sumOk, emptyOk });
        // #6 当前值不在候选里：保值展示并说原因（不存在 / 消耗燃烧），渲染不改 doc；旧 flammable 一行提示 +「删掉」
        const GHOST = 'zz_selftest_no_such_template';
        edit('自检：绑不存在的模板', () => { em0().plate.burnable = { template: GHOST }; }); await settle();
        const docG = canonJson(S.doc);
        renderInspector(); await settle();
        const sg = q('burnable-template');
        const ghostOpt = sg ? [...sg.options].find((o) => o.value === GHOST) : null;
        const ghostOk = !!sg && sg.value === GHOST && !!ghostOpt && /不存在/.test(ghostOpt.textContent)
          && !!q('burnable-why') && q('burnable-why').textContent.includes(GHOST) && /不在/.test(q('burnable-why').textContent)
          && canonJson(S.doc) === docG && !q('burn-sum:label');
        edit('自检：绑消耗燃烧模板', () => { em0().plate.burnable = { template: consumeT.id }; }); await settle();
        const docC = canonJson(S.doc);
        renderInspector(); await settle();
        const sc = q('burnable-template');
        const cOpts = sc ? [...sc.options].filter((o) => o.value === consumeT.id) : [];
        const consumeOk = !!sc && sc.value === consumeT.id && cOpts.length === 1 && /消耗燃烧/.test(cOpts[0].textContent)
          && !!q('burnable-why') && q('burnable-why').textContent === consumeT.note && /消耗燃烧/.test(consumeT.note)
          && !!q('burn-sum:label') && canonJson(S.doc) === docC;
        edit('自检：残留旧可燃参数', () => { em0().plate.flammable = { burnSeconds: 3, fireEffect: 'x' }; }); await settle();
        const legacy = q('flammable-legacy');
        const legacyShown = !!legacy && legacy.textContent.includes('旧可燃参数已作废，运行时不读') && !!q('flammable-legacy-del');
        const u2 = history.undoStack.length;
        if (q('flammable-legacy-del')) q('flammable-legacy-del').click();
        await settle();
        const legacyGone = !('flammable' in em0().plate) && history.undoStack.length === u2 + 1 && !q('flammable-legacy')
          && em0().plate.burnable.template === consumeT.id;
        ok('S24 #6 a current value that is not a candidate is kept and shown with the reason (missing template → 不存在 / consume template → the gate sentence), rendering never touches the doc; a leftover plate.flammable shows 「旧可燃参数已作废，运行时不读」 and 删掉 deletes just that key in one step',
          ghostOk && consumeOk && legacyShown && legacyGone,
          { ghostOk, ghostOpt: ghostOpt && ghostOpt.textContent, why: q('burnable-why') && q('burnable-why').textContent, consumeOk, legacyShown, legacyGone });
        // #7 存盘往返
        fire(q('burnable-template'), spreadT.id); await settle();
        await saveEffect();
        const back = (await API.json(`/api/effect?id=${encodeURIComponent(PAPER_ID)}`)).doc;
        ok('S24 #7 save round-trips plate.burnable = {template} exactly (last key of plate, nothing else added) and the page is clean',
          !S.dirty && JSON.stringify(back.emitters[0].plate.burnable) === JSON.stringify({ template: spreadT.id })
          && Object.keys(back.emitters[0].plate).pop() === 'burnable' && !('flammable' in back.emitters[0].plate) && canonJson(back) === canonJson(S.doc),
          { dirty: S.dirty, plate: back.emitters[0].plate });
        // #8 「打开燃烧工作台」打到 /api/open_burn_workbench（带当前模板 id）；自检拦截 fetch，不真起进程
        const realFetch = window.fetch;
        const openCalls = [];
        window.fetch = (url, opts) => {
          if (String(url).includes('/api/open_burn_workbench')) {
            openCalls.push({ url: String(url), method: opts && opts.method, body: opts && opts.body ? JSON.parse(opts.body) : null });
            return Promise.resolve(new Response(JSON.stringify({ ok: true, id: spreadT.id, message: '已另起燃烧工作台（自检拦截）' }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }));
          }
          return realFetch.call(window, url, opts);
        };
        try {
          q('burn-open').click();
          await until24(() => openCalls.length > 0 && /自检拦截/.test(el('status').textContent), 3000);
        } finally { window.fetch = realFetch; }
        ok('S24 #8 「打开燃烧工作台」 posts /api/open_burn_workbench with the current template id (intercepted, no process started) and says so in the status bar',
          openCalls.length === 1 && openCalls[0].method === 'POST' && openCalls[0].body && openCalls[0].body.id === spreadT.id
          && /自检拦截/.test(el('status').textContent), { openCalls, status: el('status').textContent });
        // #9 窗口重新获得焦点：重读模板表；绑着的模板内容真变了才重建本地预览，没变 / 变的是没绑的模板都不重建
        const IG = 7.25;
        let mutate = null;
        window.fetch = (url, opts) => {
          if (mutate && String(url).includes('/api/burnables')) {
            return realFetch.call(window, url, opts).then((r) => r.json()).then((j) => {
              mutate(j);
              return new Response(JSON.stringify(j), { status: 200, headers: { 'Content-Type': 'application/json' } });
            });
          }
          return realFetch.call(window, url, opts);
        };
        let focusOk = {};
        try {
          const sim0 = S.sim;
          mutate = null;
          window.dispatchEvent(new Event('focus'));
          await wait(300);
          focusOk.same = S.sim === sim0;
          mutate = (j) => { const r = j.templates.find((x) => x.id === consumeT.id); r.doc = Object.assign({}, r.doc, { ignitionDelay: IG }); };
          window.dispatchEvent(new Event('focus'));
          await until24(() => S.burn.map.get(consumeT.id).ignitionDelay === IG, 5000);
          focusOk.unboundChanged = S.burn.map.get(consumeT.id).ignitionDelay === IG && S.sim === sim0;
          mutate = (j) => {
            for (const id of [consumeT.id, spreadT.id]) { const r = j.templates.find((x) => x.id === id); r.doc = Object.assign({}, r.doc, { ignitionDelay: IG }); }
            // 服务端摘要也跟着那份文档（假设火焰长度没写、取缺省）：检视器的只读参数跟着重画、缺省那一项灰显
            const r = j.templates.find((x) => x.id === spreadT.id);
            r.summary = Object.assign({}, r.summary, { ignitionDelay: IG, defaulted: ['flameLength'] });
          };
          window.dispatchEvent(new Event('focus'));
          await until24(() => S.sim !== sim0, 5000);
          const sim1 = S.sim;
          focusOk.boundRebuilt = sim1 !== sim0 && !!sim1 && sim1.emitters[0].burn && sim1.emitters[0].burn.P.ignitionDelay === IG
            && S.burn.map.get(spreadT.id).ignitionDelay === IG;
          await settle();
          focusOk.inspectorFollows = !!q('burn-sum:ignitionDelay') && q('burn-sum:ignitionDelay').textContent.includes(String(IG))
            && !q('burn-sum:ignitionDelay').classList.contains('dim') && q('burn-sum:flameLength').classList.contains('dim')
            && /缺省/.test(q('burn-sum:flameLength').title);
          window.dispatchEvent(new Event('focus'));
          await wait(300);
          focusOk.sameAgain = S.sim === sim1;
          mutate = null;
          window.dispatchEvent(new Event('focus'));
          await until24(() => S.burn.map.get(spreadT.id).ignitionDelay === sum.ignitionDelay && S.sim !== sim1, 5000);
          focusOk.restored = S.sim !== sim1 && S.sim.emitters[0].burn && S.sim.emitters[0].burn.P.ignitionDelay === sum.ignitionDelay && !S.dirty;
        } finally { mutate = null; window.fetch = realFetch; }
        ok('S24 #9 window focus re-reads the template table: unchanged → nothing rebuilt; a change to an unbound template swaps the table without rebuilding; a change to the bound template rebuilds the local preview with it and the read-only parameters follow (defaulted ones greyed); the doc stays clean',
          focusOk.same && focusOk.unboundChanged && focusOk.boundRebuilt && focusOk.inspectorFollows && focusOk.sameAgain && focusOk.restored, focusOk);
        // #10 火焰调试：I 武装（提示说绑的模板会着）→ 画布上点一下放火、清火；纸真的着 → 焦黑 → 成灰；绑消耗燃烧 / 不存在的模板不着、状态栏说清楚
        resetSim();
        for (let i = 0; i < 30; i++) stepSim(1 / 60);
        const live0 = S.sim.liveCount;
        for (let i = 0; i < 90; i++) stepSim(1 / 60);
        const calm = burnStats();
        const docBefore = canonJson(S.doc), histBefore = history.undoStack.length;
        let placedByClick = false, armHint = '';
        if (S.view === 3 && v3 && v3.ok) {
          v3.fit(true); draw();
          const pa = P3(anchorWorld());
          key('i');
          const armed = S.tool === 'fire';
          armHint = el('status').textContent;
          if (pa) { click(pa[0], pa[1]); placedByClick = armed && S.fires.length === 1 && S.tool === 'select'; }
        } else { placedByClick = true; armHint = fireHint().text; }
        el('btnClearFires').click();
        const cleared = S.fires.length === 0;
        host.addFireAt(anchorWorld());
        const fireStatus = el('status').textContent;
        const fireMark = previewMarks().some((m) => m.top && m.label === '调试火焰（只在预览里）');
        let maxBurning = 0, sawLit = false, sawCharred = false;
        for (let i = 0; i < 480; i++) {
          stepSim(1 / 60);
          const bs = burnStats();
          maxBurning = Math.max(maxBurning, bs.burning);
          if (i % 5 === 0) {
            const groups = particlePoints();
            if (groups.some((g) => g.burn === 'burning' && g.pts.length)) sawLit = true;
            if (groups.some((g) => g.burn === 'charred' && g.pts.length)) sawCharred = true;
          }
        }
        const after = burnStats();
        renderSimBar();
        ok('S24 #10 fire debug tool: I arms it and says the bound template will burn, a click on the canvas places one fire segment and returns to select, 清火 clears it; the fire is preview-only (doc, dirty state and history untouched) and is drawn as 「调试火焰」',
          placedByClick && cleared && fireMark && canonJson(S.doc) === docBefore && !S.dirty && history.undoStack.length === histBefore
          && armHint.includes('会着') && armHint.includes(spreadT.id) && fireStatus.includes('会着'),
          { placedByClick, cleared, fireMark, dirty: S.dirty, armHint, fireStatus });
        ok('S24 #10 fed through VfxStepContext.fires the runtime sim ignites paper bound to a spread template (its burn params come from that template), shows burning then charred plates, and burnt plates are gone for good (live count drops, sim bar counts them)',
          live0 > 0 && calm.burning === 0 && calm.burnt === 0 && calm.flammable && calm.bound === 1 && S.sim.emitters[0].burn && S.sim.emitters[0].burn.P.template === spreadT.id
          && maxBurning > 0 && sawLit && sawCharred && after.burnt > 0
          && S.sim.liveCount <= live0 - after.burnt && /可燃 在烧 \d+ \/ 烧没 [1-9]/.test(el('simInfo').textContent),
          { live0, calm, maxBurning, sawLit, sawCharred, after, live: S.sim.liveCount, info: el('simInfo').textContent });
        // 绑消耗燃烧模板：运行时 plateBurnOf 不给燃烧态 ⇒ 放火也不着；火工具提示与状态栏说清楚是哪份、为什么
        edit('自检：绑消耗燃烧模板', () => { em0().plate.burnable = { template: consumeT.id }; }); await settle();
        resetSim();
        for (let i = 0; i < 30; i++) stepSim(1 / 60);
        host.addFireAt(anchorWorld());
        const cStatus = el('status').textContent, cKind = el('status').className;
        let cMax = 0;
        for (let i = 0; i < 480; i++) { stepSim(1 / 60); cMax = Math.max(cMax, burnStats().burning); }
        const cAfter = burnStats();
        renderSimBar();
        const cInfo = el('simInfo');
        const consumeFireOk = S.sim.emitters[0].burn === null && !cAfter.flammable && cAfter.bound === 1 && cMax === 0 && cAfter.burnt === 0
          && cStatus.includes(consumeT.id) && cStatus.includes('火焰点不着东西') && /warn/.test(cKind)
          && cInfo.className === 'warn' && cInfo.textContent.includes('可燃薄片不可燃') && cInfo.textContent.includes(consumeT.id);
        edit('自检：绑不存在的模板', () => { em0().plate.burnable = { template: GHOST }; }); await settle();
        resetSim();
        renderSimBar();
        const gInfo = el('simInfo').textContent;
        const ghostFireOk = S.sim.emitters[0].burn === null && gInfo.includes('可燃薄片不可燃') && gInfo.includes(GHOST) && fireHint().kind === 'warn';
        ok('S24 #10 paper bound to a consume template (or a missing one) never ignites: no burn state in the runtime sim, the fire tool status and the sim bar name the template and why',
          consumeFireOk && ghostFireOk, { consumeFireOk, cStatus, cKind, cMax, cAfter, info: cInfo.textContent, ghostFireOk, gInfo });
        resetSim();
        ok('S24 #10 reset clears the debug fire', S.fires.length === 0 && burnStats().burnt === 0);
      }
    }
  } catch (e) {
    log.push('EXC ' + ((e && e.stack) || e));
  } finally {
    try {
      S.dirty = false; S.docDirty = false;
      // 临时效果可能被自检布置过（临时库里）：连布置一起删
      for (const id of tmp) await API.post('/api/delete', { id, withPlacements: true });
      await refreshEffects();
    } catch (e) { log.push('EXC cleanup ' + e); }
    // 汇总行由桌面壳打（`tools/desktop_shell.py`：`[selftest] N passed, M failed`），这里只给逐条
    window.__selftestResult = log.join('\n');
  }
})();
