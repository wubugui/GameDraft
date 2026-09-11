/* 声学工作台 · 交互层端到端回归（在真页面里跑；由 `python -m tools.acoustic_workbench --selftest` 注入）。
 *
 * 每条 `ok()` 一行 PASS/FAIL；异常记 EXC；跑完把整份报告写进 window.__selftestResult。
 * 约定：只读工程里已有的空间（绝不在它们上面 save）；临时空间 zz_selftest_* 用完即删；
 * 所有手势都从画布入口合成真实鼠标事件进去（护栏从最外层进，见 editor-tools norms）。 */
(async () => {
  const log = [];
  const ok = (name, cond, extra) => log.push((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + JSON.stringify(extra) : ''));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const R = (v) => Math.round(v);
  const cv = () => el('view3d');
  const ev = (type, cx, cy, opts) => { const c = cv(); const r = c.getBoundingClientRect(); const e = new MouseEvent(type, Object.assign({ bubbles: true, cancelable: true, clientX: Math.round(r.left + cx), clientY: Math.round(r.top + cy), button: 0, buttons: 1 }, opts || {})); (type === 'mousedown' ? c : window).dispatchEvent(e); };
  const click = (cx, cy, opts) => { ev('mousedown', cx, cy, opts); ev('mouseup', cx, cy, opts); };
  const drag = (x0, y0, x1, y1, opts) => { ev('mousedown', x0, y0, opts); for (let i = 1; i <= 8; i++) ev('mousemove', x0 + (x1 - x0) * i / 8, y0 + (y1 - y0) * i / 8, opts); ev('mouseup', x1, y1, opts); };
  const key = (k, opts) => { const e = new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, opts || {})); window.dispatchEvent(e); return e; };
  const refl = () => S.doc.def.reflectors;
  const P = (w) => { const c = v3.project(w); return c ? [R(c[0]), R(c[1])] : null; };
  const tmp = [];
  const mkTemp = async (id) => { await API.post('/api/create', { id, sceneId: S.scene.id, background: S.scene.background, label: '自检' }); tmp.push(id); await refreshSpaces(); };
  let baseJson = '';
  try {
    // ---------------------------------------------------------------- S1 启动
    for (let i = 0; i < 80 && !window.__ready; i++) await wait(250);
    ok('S1 boot: ready, space open, scene expanded, bundle loaded', window.__ready && S.doc && S.cal && S.acoustic && v3.ok && !S.dirty, { doc: S.doc && S.doc.id, scene: S.scene && S.scene.id, taps: S.taps.length, bundle: !!S.acoustic });
    baseJson = JSON.stringify(S.doc);
    ok('S1 taps come from the runtime module (has hit points, meters)', S.taps.length > 0 && S.taps.every((t) => Array.isArray(t.hit) && Number.isFinite(t.length)));
    // 遮罩层真的没盖着画布：看**算出来的** display，别只看 hidden 属性（id 选择器里的 display:flex 会压过 UA 的 [hidden]，
    // 那样 #busy / #dialog 从开页起就一直显示 —— 两层压暗 + 正中一个空框，画布一个点都点不到；属性照样是 hidden）
    const shown = (id) => getComputedStyle(el(id)).display !== 'none';
    const topElAtCenter = () => { const r = cv().getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); };
    const topAtCenter = () => { const t = topElAtCenter(); return t ? t.id || t.tagName : null; };
    const dialogCoversCenter = () => { const t = topElAtCenter(); return !!t && el('dialog').contains(t); };
    ok('S1 busy / dialog overlays are really not displayed at boot', !shown('busy') && !shown('dialog'), { busy: getComputedStyle(el('busy')).display, dialog: getComputedStyle(el('dialog')).display });
    ok('S1 the 3D canvas is what sits under the pointer (nothing covers it)', ['view3d', 'overlay3d'].includes(topAtCenter()), { top: topAtCenter() });
    // ---------------------------------------------------------------- S1b 坐标：工作台的世界 = 运行时的世界，且画面不镜像
    ok('S1b runtime sceneSpace is in the bundle and the alignment check ran', !!(S.acoustic && S.acoustic.sceneSpace && S.align), { align: S.align });
    ok('S1b scene→world / marks / mesh uv / view dir all agree with the runtime code', !!(S.align && S.align.ok), S.align);
    {
      v3.fit(true);
      const cal = S.cal, sp = (S.marks.find((m) => m.kind === 'spawn') || { world: [0, 0, 0] }).world;
      const Rw = cal.screenRightWorld();
      const p0 = P(sp), pr = P([sp[0] + Rw[0] * 300, sp[1] + Rw[1] * 300, sp[2] + Rw[2] * 300]), pu = P([sp[0], sp[1] + 300, sp[2]]);
      // 右手 lookAt 画左手世界 = 整体镜像：画面右会跑到屏幕左。这一条就是那次事故的钉子
      ok('S1b handedness: picture-right offset projects to the right, +Y projects up', !!(p0 && pr && pu) && pr[0] > p0[0] + 5 && pu[1] < p0[1] - 5, { p0, pr, pu });
      const ga = cal.sceneToWorldGround(cal.worldW * 0.3, cal.worldH * 0.7), gb = cal.sceneToWorldGround(cal.worldW * 0.7, cal.worldH * 0.7);
      const pa = P(ga), pb = P(gb);
      ok('S1b handedness: the point further right in the picture is further right in 3D', !!(pa && pb) && pb[0] > pa[0] + 5, { pa, pb });
      // 转头：右键向右拖，视线转向相机右侧
      const r0 = v3._right(), f0 = v3._forward();
      ev('mousedown', 200, 200, { button: 2, buttons: 2 }); ev('mousemove', 260, 200, { button: 2, buttons: 2 });
      const f1 = v3._forward();
      ev('mouseup', 260, 200, { button: 2, buttons: 0 });
      ok('S1b controls: right-drag to the right turns the view to the right', f1[0] * r0[0] + f1[2] * r0[2] > 0.05, { f0, f1, r0 });
      // 平移：中键向右拖，固定点在屏幕上跟着往右
      v3.fit(true); const m0 = P(sp);
      ev('mousedown', 200, 200, { button: 1, buttons: 4 }); ev('mousemove', 260, 200, { button: 1, buttons: 4 });
      const m1 = P(sp);
      ev('mouseup', 260, 200, { button: 1, buttons: 0 });
      ok('S1b controls: middle-drag to the right slides the world to the right', !!(m0 && m1) && m1[0] > m0[0] + 5, { m0, m1 });
      // 飞行：D 向右平飞，固定点在屏幕上往左走
      v3.fit(true); const q0 = P(sp);
      v3.keys.add('KeyD'); v3._flyStep(0.5); v3.keys.clear();
      const q1 = P(sp);
      ok('S1b controls: strafing right (D) makes a fixed world point slide left', !!(q0 && q1) && q1[0] < q0[0] - 2, { q0, q1 });
      v3.fit(true);
    }
    // ---------------------------------------------------------------- S2 渲染只读
    { for (let i = 0; i < refl().length; i++) { select('reflector', i, false); await wait(10); } select('listener', 0, false); clearSelection();
      ok('S2 selecting / rendering never writes the doc', JSON.stringify(S.doc) === baseJson && !S.dirty && history.undoStack.length === 0); }
    // ---------------------------------------------------------------- S3 临时空间：加崖壁（真实拖拽）
    await mkTemp('zz_selftest_a');
    await openSpace('zz_selftest_a'); await wait(100);
    ok('S3 temp space opened clean', S.doc.id === 'zz_selftest_a' && refl().length === 0 && !S.dirty);
    {
      const L = S.doc.def.listener;
      // 把听者放到出生点脚下（新建时 createSpace 会做，这里走 API 建的所以手动来一次）
      const sp = S.marks.find((m) => m.kind === 'spawn');
      if (sp) op('听者放到出生点', () => host.setPoint('listener', { x: sp.world[0], y: sp.world[1], z: sp.world[2] }));
      v3.focus([L.x, L.y || 0, L.z], 400); v3.cam.pitch = 0.9; v3.draw();
      const ga = [L.x - 150, v3.groundY(L.x - 150, L.z + 300), L.z + 300], gb = [L.x + 150, v3.groundY(L.x + 150, L.z + 300), L.z + 300];
      const a = P(ga), b = P(gb);
      setTool('addWall');
      const n0 = refl().length, u0 = history.undoStack.length;
      drag(a[0], a[1], b[0], b[1]);
      const w = refl()[refl().length - 1];
      ok('S3 addWall drag creates one wall, selected, tool back to move, one history entry', refl().length === n0 + 1 && S.sel.kind === 'reflector' && S.sel.ids.has(refl().length - 1) && S.tool === 'move' && history.undoStack.length === u0 + 1 && S.dirty, { n: refl().length, tool: S.tool, w });
      // A/B 会被摆成"从听者看去左→右"（orientToward），所以按无序对比
      const nearPt = (p, g) => Math.abs(p[0] - g[0]) < 40 && Math.abs(p[1] - g[2]) < 40;
      ok('S3 wall endpoints land near where the mouse was (world XZ, unordered)', w && ((nearPt(w.a, ga) && nearPt(w.b, gb)) || (nearPt(w.a, gb) && nearPt(w.b, ga))), w && { a: w.a, b: w.b, ga, gb });
      ok('S3 taps recomputed after adding a wall', S.taps.length >= 1);
      key('z', { ctrlKey: true }); ok('S3 undo removes the wall', refl().length === n0);
      key('y', { ctrlKey: true }); ok('S3 redo brings it back', refl().length === n0 + 1);
    }
    // ---------------------------------------------------------------- S4 变换 gizmo（Unity 式 W/E/R）：单轴只动一个分量、Ctrl 吸附是整数倍、
    // 中心贴地挪、绿环绕轴心、等比缩放；听者只给移动 gizmo；直接把手 ▲ / 端点 A 仍在；纯点一下不算编辑
    {
      const i = refl().length - 1; select('reflector', i, false);
      const L = S.doc.def.listener;
      v3.focus([L.x, L.y || 0, L.z], 400); v3.cam.pitch = 0.9; v3.draw();
      setTool('move'); const u0 = history.undoStack.length;
      let gz = v3._gizmo();
      const m = Geo.mid(refl()[i]);
      ok('S4 move gizmo sits at the wall centre (half height) with 3 axes + 3 planes', !!gz && gz.mode === 'move' && gz.kind === 'reflector' && Math.abs(gz.pivot[0] - m[0]) < 1e-6 && Math.abs(gz.pivot[2] - m[1]) < 1e-6 && gz.axes.length === 3 && Object.keys(gz.planes).length === 3, gz && { mode: gz.mode, pivot: gz.pivot.map(R), planes: Object.keys(gz.planes) });
      // 沿轴抓点：轴线上按下（优先 62% 处；端点 / ▲ 把手比 gizmo 优先，若恰好叠在那儿就换一个比例，先用 _hit 核实抓到的是这根轴），再沿轴向拖 px
      const along = (k, px, part) => {
        const g = v3._gizmo(); const t = g.tip[k], c = g.c; const l = Math.hypot(t[0] - c[0], t[1] - c[1]); const d = [(t[0] - c[0]) / l, (t[1] - c[1]) / l];
        const want = part || k; let s = null;
        for (const f of [0.62, 0.45, 0.78, 0.3, 0.9]) { const q = [R(c[0] + d[0] * l * f), R(c[1] + d[1] * l * f)]; const h = v3._hit(q[0], q[1]); if (h && h.kind === 'gz' && h.part === want) { s = q; break; } }
        if (!s) { s = [R(c[0] + d[0] * l * 0.62), R(c[1] + d[1] * l * 0.62)]; log.push(`WARN along(${k}): no probe point on the axis hits gizmo part ${want}`); }
        return [s[0], s[1], R(s[0] + d[0] * px), R(s[1] + d[1] * px)];
      };
      const snap = () => JSON.parse(JSON.stringify(refl()[i]));
      let b0 = snap(), a = along('x', 30); drag(a[0], a[1], a[2], a[3]); let b1 = snap();
      ok('S4 X arrow moves a and b equally in x only (z / y / height untouched)', Math.abs(b1.a[0] - b0.a[0]) > 1 && Math.abs((b1.a[0] - b0.a[0]) - (b1.b[0] - b0.b[0])) < 1e-6 && Math.abs(b1.a[1] - b0.a[1]) < 1e-6 && Math.abs(b1.b[1] - b0.b[1]) < 1e-6 && (b1.y || 0) === (b0.y || 0) && b1.height === b0.height && history.peekUndo() === '移动', { dx: +(b1.a[0] - b0.a[0]).toFixed(2), dz: +(b1.a[1] - b0.a[1]).toFixed(2), undo: history.peekUndo() });
      b0 = snap(); a = along('y', 30); drag(a[0], a[1], a[2], a[3]); b1 = snap();
      ok('S4 Y arrow changes only the base elevation y', Math.abs((b1.y || 0) - (b0.y || 0)) > 1 && JSON.stringify(b1.a) === JSON.stringify(b0.a) && JSON.stringify(b1.b) === JSON.stringify(b0.b) && b1.height === b0.height, { dy: +((b1.y || 0) - (b0.y || 0)).toFixed(2) });
      b0 = snap(); a = along('z', 30); drag(a[0], a[1], a[2], a[3], { ctrlKey: true }); b1 = snap();
      const dzs = b1.a[1] - b0.a[1];
      ok('S4 Ctrl+drag Z arrow snaps to a multiple of 10 wu and moves only z', Math.abs(dzs) > 1 && Math.abs(dzs / 10 - Math.round(dzs / 10)) < 1e-6 && Math.abs(b1.a[0] - b0.a[0]) < 1e-6 && Math.abs((b1.b[1] - b0.b[1]) - dzs) < 1e-6 && (b1.y || 0) === (b0.y || 0), { dz: +dzs.toFixed(2) });
      b0 = snap(); gz = v3._gizmo(); drag(R(gz.c[0]), R(gz.c[1]), R(gz.c[0]) + 40, R(gz.c[1]) + 25); b1 = snap();
      ok('S4 centre drag translates both endpoints equally in XZ, y untouched', Math.hypot(b1.a[0] - b0.a[0], b1.a[1] - b0.a[1]) > 5 && Math.abs((b1.a[0] - b0.a[0]) - (b1.b[0] - b0.b[0])) < 1e-6 && Math.abs((b1.a[1] - b0.a[1]) - (b1.b[1] - b0.b[1])) < 1e-6 && (b1.y || 0) === (b0.y || 0), { da: [+(b1.a[0] - b0.a[0]).toFixed(2), +(b1.a[1] - b0.a[1]).toFixed(2)] });
      // 旋转：绿环，绕面中心，长度不变；Ctrl 吸附 15°（两笔同向共 60°，留着 X 跨度给后面的单轴缩放）
      setTool('rotate'); gz = v3._gizmo();
      ok('S4 rotate gizmo shows a 48-point ring at the wall centre', !!gz && gz.mode === 'rotate' && !!gz.ring && gz.ring.length === 48);
      const len0 = Geo.len(refl()[i]), ang0 = Geo.angle(refl()[i]), mid0 = Geo.mid(refl()[i]);
      let rp = gz.ring[0], rq = gz.ring[4]; drag(R(rp[0]), R(rp[1]), R(rq[0]), R(rq[1]));
      const mid1 = Geo.mid(refl()[i]);
      ok('S4 ring drag rotates about the centre: angle changed, length and midpoint kept', Math.abs(Geo.angle(refl()[i]) - ang0) > 0.05 && Math.abs(Geo.len(refl()[i]) - len0) < 0.5 && Math.hypot(mid1[0] - mid0[0], mid1[1] - mid0[1]) < 0.01 && history.peekUndo() === '旋转', { dAng: +(Geo.angle(refl()[i]) - ang0).toFixed(3), undo: history.peekUndo() });
      const angA = Geo.angle(refl()[i]); gz = v3._gizmo(); rp = gz.ring[0]; rq = gz.ring[3]; drag(R(rp[0]), R(rp[1]), R(rq[0]), R(rq[1]), { ctrlKey: true });
      let dAng = (Geo.angle(refl()[i]) - angA) * 180 / Math.PI; while (dAng > 180) dAng -= 360; while (dAng < -180) dAng += 360;
      ok('S4 Ctrl+ring drag snaps to a multiple of 15°', Math.abs(dAng) > 1 && Math.abs(dAng / 15 - Math.round(dAng / 15)) < 1e-3, { dAng: +dAng.toFixed(3) });
      // 缩放：中心等比（长度与面高同倍、中点不动）；Ctrl+X 末端方块只拉 x、倍率吸附 ×0.1
      setTool('scale'); gz = v3._gizmo();
      const len1 = Geo.len(refl()[i]), h1 = refl()[i].height, midA = Geo.mid(refl()[i]);
      drag(R(gz.c[0]), R(gz.c[1]), R(gz.c[0]) + 40, R(gz.c[1]) - 40);
      const midB = Geo.mid(refl()[i]), kU = Geo.len(refl()[i]) / len1;
      ok('S4 scale centre scales length and height by the same factor, midpoint kept', !!gz && gz.mode === 'scale' && kU > 1.2 && Math.abs(refl()[i].height / h1 - kU) < 0.02 && Math.hypot(midB[0] - midA[0], midB[1] - midA[1]) < 1 && history.peekUndo() === '缩放', { k: +kU.toFixed(3), kh: +(refl()[i].height / h1).toFixed(3), undo: history.peekUndo() });
      b0 = snap(); a = along('x', 30, 'sx'); drag(a[0], a[1], a[2], a[3], { ctrlKey: true }); b1 = snap();
      const kx = (b1.b[0] - b1.a[0]) / (b0.b[0] - b0.a[0]);
      ok('S4 Ctrl+X end square stretches x only, factor a multiple of 0.1', Math.abs(kx - 1) > 0.05 && Math.abs(kx / 0.1 - Math.round(kx / 0.1)) < 1e-3 && Math.abs(b1.a[1] - b0.a[1]) < 1e-6 && Math.abs(b1.b[1] - b0.b[1]) < 1e-6 && b1.height === b0.height, { kx: +kx.toFixed(3), undo: history.peekUndo() });
      // 纯点一下 gizmo 不算编辑
      const undoN = history.undoStack.length, dirtyG = S.dirty; gz = v3._gizmo(); click(R(gz.c[0]), R(gz.c[1]));
      ok('S4 clicking a gizmo handle without dragging is not an edit', history.undoStack.length === undoN && S.dirty === dirtyG);
      // 直接把手：▲ 面高（顶边靠 A 那侧四分之一处，避开 gizmo 的 Y 轴）、端点 A
      setTool('move');
      const hh = v3._handles().find((x) => x.kind === 'height'); const c4 = P(hh.p); const h0 = refl()[i].height;
      drag(c4[0], c4[1], c4[0], c4[1] - 60);
      ok('S4 height handle drag raises the wall', refl()[i].height > h0 + 5, { h0, h: refl()[i].height });
      const he = v3._handles().find((x) => x.kind === 'end' && x.end === 'a'); const c5 = P(he.p); const a0 = refl()[i].a.slice(), bb0 = refl()[i].b.slice();
      drag(c5[0], c5[1], c5[0] + 40, c5[1] + 20);
      ok('S4 endpoint A drag moves only A', Math.hypot(refl()[i].a[0] - a0[0], refl()[i].a[1] - a0[1]) > 5 && JSON.stringify(refl()[i].b) === JSON.stringify(bb0), { a0, a: refl()[i].a });
      // 听者是一个点：任何工具下都只给移动 gizmo；X 箭头只动 x（y 不跟地面）；中心 = 贴地走（y 跟行走面）
      select('listener', 0, false); setTool('rotate'); gz = v3._gizmo();
      ok('S4 a point (listener) only ever gets the move gizmo, even under the rotate tool', !!gz && gz.kind === 'listener' && gz.mode === 'move', gz && { kind: gz.kind, mode: gz.mode });
      setTool('move'); const L0 = JSON.parse(JSON.stringify(S.doc.def.listener));
      a = along('x', 30); drag(a[0], a[1], a[2], a[3]); const L1 = JSON.parse(JSON.stringify(S.doc.def.listener));
      ok('S4 listener X arrow moves only x', Math.abs(L1.x - L0.x) > 1 && Math.abs(L1.z - L0.z) < 1e-6 && Math.abs((L1.y || 0) - (L0.y || 0)) < 1e-6 && history.peekUndo() === '移动', { dx: +(L1.x - L0.x).toFixed(2), dz: +(L1.z - L0.z).toFixed(2), dy: +((L1.y || 0) - (L0.y || 0)).toFixed(2) });
      gz = v3._gizmo(); drag(R(gz.c[0]), R(gz.c[1]), R(gz.c[0]) + 30, R(gz.c[1]) + 20); const L2 = S.doc.def.listener;
      ok('S4 listener centre drag walks on the ground (y follows the heightfield)', Math.hypot(L2.x - L1.x, L2.z - L1.z) > 1 && Math.abs((L2.y || 0) - v3.groundY(L2.x, L2.z)) < 0.01, { y: L2.y, g: +v3.groundY(L2.x, L2.z).toFixed(3) });
      ok('S4 every drag is exactly one history entry (12 drags)', history.undoStack.length === u0 + 12, { n: history.undoStack.length - u0 });
    }
    // ---------------------------------------------------------------- S4c 相机手势（Unity 场景视图）：机位不动 / 目标不动 / 光标下点不动 / 飞行键不漏给快捷键表 / 正交视角 / 框选
    {
      const i = refl().length - 1;
      v3.fit(true); const camA = Object.assign({}, v3.cam);
      const eye0 = v3._eye();
      drag(200, 200, 260, 200, { button: 2, buttons: 2 });
      const eye1 = v3._eye();
      ok('S4c right-drag looks around: eye fixed, yaw changed, fly mode released', Math.hypot(eye1[0] - eye0[0], eye1[1] - eye0[1], eye1[2] - eye0[2]) < 1e-3 && Math.abs(v3.cam.yaw - camA.yaw) > 0.1 && !v3.fly, { dyaw: +(v3.cam.yaw - camA.yaw).toFixed(3), dEye: +Math.hypot(eye1[0] - eye0[0], eye1[1] - eye0[1], eye1[2] - eye0[2]).toFixed(4) });
      Object.assign(v3.cam, camA);
      // 按住右键时 E = 上升，且在捕获阶段就被吃掉（松开右键 E 才是旋转工具）
      setTool('move'); const eyeB = v3._eye();
      ev('mousedown', 200, 200, { button: 2, buttons: 2 });
      const ke = new KeyboardEvent('keydown', { key: 'e', code: 'KeyE', bubbles: true, cancelable: true }); window.dispatchEvent(ke);
      v3._flyStep(0.2);
      const eyeC = v3._eye();
      ev('mouseup', 200, 200, { button: 2, buttons: 0 });
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'e', code: 'KeyE', bubbles: true }));
      ok('S4c right-button + E flies up and the key is not taken as the rotate-tool shortcut', eyeC[1] - eyeB[1] > 10 && S.tool === 'move' && ke.defaultPrevented && !v3.fly && v3.keys.size === 0, { dy: R(eyeC[1] - eyeB[1]), tool: S.tool, prevented: ke.defaultPrevented });
      Object.assign(v3.cam, camA);
      select('reflector', i, false); const selN = S.sel.ids.size;
      drag(200, 200, 260, 200, { altKey: true });
      ok('S4c Alt+left orbits: target fixed, yaw changed, selection untouched', Math.abs(v3.cam.tx - camA.tx) < 1e-6 && Math.abs(v3.cam.tz - camA.tz) < 1e-6 && Math.abs(v3.cam.yaw - camA.yaw) > 0.1 && S.sel.ids.size === selN, { dyaw: +(v3.cam.yaw - camA.yaw).toFixed(3), sel: S.sel.ids.size });
      Object.assign(v3.cam, camA);
      drag(200, 200, 260, 220, { button: 1, buttons: 4 });
      ok('S4c middle-drag pans: target moved, orientation kept', Math.hypot(v3.cam.tx - camA.tx, v3.cam.ty - camA.ty, v3.cam.tz - camA.tz) > 1 && Math.abs(v3.cam.yaw - camA.yaw) < 1e-9 && Math.abs(v3.cam.pitch - camA.pitch) < 1e-9);
      Object.assign(v3.cam, camA);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }));
      drag(200, 200, 260, 220);
      window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true }));
      ok('S4c space + left-drag pans instead of box-selecting', Math.hypot(v3.cam.tx - camA.tx, v3.cam.ty - camA.ty, v3.cam.tz - camA.tz) > 1 && S.sel.ids.size === selN && !v3.spaceDown, { sel: S.sel.ids.size });
      Object.assign(v3.cam, camA); v3.draw();
      // 滚轮朝光标缩放：光标下的地面点在屏幕上不动
      const zx = R(cv().clientWidth * 0.55), zy = R(cv().clientHeight * 0.6);
      const pz = v3.pickGround(zx, zy);
      if (pz) {
        const s0 = v3.project(pz); const rr = cv().getBoundingClientRect();
        cv().dispatchEvent(new WheelEvent('wheel', { deltaY: -400, clientX: rr.left + zx, clientY: rr.top + zy, bubbles: true, cancelable: true }));
        const s1 = v3.project(pz);
        ok('S4c wheel zooms toward the cursor (picked ground point stays put on screen)', !!s0 && !!s1 && Math.hypot(s1[0] - s0[0], s1[1] - s0[1]) < 1.5 && v3.cam.dist < camA.dist, { shift: s0 && s1 ? +Math.hypot(s1[0] - s0[0], s1[1] - s0[1]).toFixed(2) : null, dist: R(v3.cam.dist) });
      } else log.push('SKIP S4c zoom (no ground under probe pixel)');
      Object.assign(v3.cam, camA); v3.draw();
      // 坐标架：Y 臂 → 正交顶视（仍能拾取地面）；中心 → 回透视
      const lay = v3._sceneGizmoLayout(); const armY = lay.arms.find((a) => a.axis === 'y' && a.sign > 0);
      click(R(armY.x), R(armY.y));
      const gp = v3.pickGround(R(cv().clientWidth / 2), R(cv().clientHeight / 2));
      ok('S4c scene gizmo Y arm → orthographic top view that still picks the ground', v3.cam.ortho && v3.cam.pitch > 1.5 && !!gp, { pitch: +v3.cam.pitch.toFixed(3), ortho: v3.cam.ortho, gp: gp && gp.map(R) });
      const lay2 = v3._sceneGizmoLayout(); click(R(lay2.ox), R(lay2.oy));
      ok('S4c scene gizmo centre toggles back to perspective', !v3.cam.ortho);
      Object.assign(v3.cam, camA);
      // F 对准选中
      key('f');
      const bb = Geo.bounds([refl()[i]]);
      ok('S4c F frames the selection (camera target = selection centre)', Math.abs(v3.cam.tx - bb.cx) < 1e-6 && Math.abs(v3.cam.tz - bb.cz) < 1e-6, { tx: R(v3.cam.tx), cx: R(bb.cx) });
      // 左键空白拖 = 框选（移动工具下也是）；点空白 = 清选择；双击物体 = 选中并对准
      Object.assign(v3.cam, camA); clearSelection(); setTool('move'); v3.draw();
      const mids = refl().map((r) => { const mm = Geo.mid(r); return v3.project([mm[0], (r.y || 0) + (Geo.isHorizontal(r) ? 0 : r.height / 2), mm[1]]); }).filter(Boolean);
      const H3 = cv().clientHeight;
      drag(4, H3 - 4, R(Math.max(...mids.map((p) => p[0]))) + 20, R(Math.min(...mids.map((p) => p[1]))) - 20);
      ok('S4c plain left-drag on empty space box-selects (under the move tool too)', S.sel.kind === 'reflector' && S.sel.ids.size === refl().length, { n: S.sel.ids.size, total: refl().length });
      click(4, H3 - 4);
      ok('S4c click on empty space clears the selection', S.sel.kind === null);
      const wm = mids[mids.length - 1]; const rr2 = cv().getBoundingClientRect();
      cv().dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: Math.round(rr2.left + wm[0]), clientY: Math.round(rr2.top + wm[1]), button: 0 }));
      ok('S4c double-click on a wall selects it and frames it', S.sel.kind === 'reflector' && S.sel.ids.has(i) && Math.abs(v3.cam.tx - bb.cx) < 1e-6 && Math.abs(v3.cam.tz - bb.cz) < 1e-6, { sel: [...S.sel.ids], tx: R(v3.cam.tx), cx: R(bb.cx) });
      Object.assign(v3.cam, camA); v3.draw();
    }
    // ---------------------------------------------------------------- S5 检视器与距离缩放
    {
      const i = refl().length - 1; select('reflector', i, false);
      const numByLabel = (txt) => { const row = [...el('inspector').querySelectorAll('label.row')].find((r) => r.firstChild && r.firstChild.textContent === txt); return row && row.querySelector('input[type=number]'); };
      const inp = numByLabel('高');
      inp.value = '777'; inp.dispatchEvent(new Event('change', { bubbles: true }));
      ok('S5 inspector number field commits via op', refl()[i].height === 777 && history.peekUndo().includes('高'));
      const d0 = S.taps[0].delay;
      op('改距离缩放', () => { S.doc.def.distanceScale = 10; });
      ok('S5 distanceScale ×10 scales the first delay ×10 (runtime math, not a mirror)', Math.abs(S.taps[0].delay / d0 - 10) < 1e-6, { d0, d1: S.taps[0].delay });
      const rangeByLabel = (txt) => { const row = [...el('inspector').querySelectorAll('label.row')].find((r) => r.firstChild && r.firstChild.textContent === txt); return row && row.querySelector('input[type=range]'); };
      const sl = rangeByLabel('距离缩放');   // ⚠ 别按序号取：选中反射面时前面还有吸收 / 粗糙两条
      sl.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      sl.value = String(Math.log10(20)); sl.dispatchEvent(new Event('input', { bubbles: true }));
      sl.value = String(Math.log10(30)); sl.dispatchEvent(new Event('input', { bubbles: true }));
      sl.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      // 对数滑条 step 0.01 会把 log10(30) 量化到 1.48 → 30.2，容差按一档给
      ok('S5 slider drag = one history entry, final value applied', Math.abs(S.doc.def.distanceScale - 30) < 1 && history.peekUndo() === '改距离缩放', { ds: S.doc.def.distanceScale });
      op('改距离缩放', () => { S.doc.def.distanceScale = 1; });
    }
    // ---------------------------------------------------------------- S6 保存往返
    {
      const before = JSON.parse(JSON.stringify(S.doc.def));
      const saved = await save();
      ok('S6 save succeeds and clears dirty', saved && !S.dirty);
      const back = (await API.json('/api/space?id=zz_selftest_a')).def;
      ok('S6 disk == normalized doc (endpoints, height, scale)', JSON.stringify(back.reflectors[0].a) === JSON.stringify(S.doc.def.reflectors[0].a) && back.reflectors[0].height === before.reflectors[0].height && back.authoring.sceneId === S.scene.id, { back: back.reflectors[0], sceneId: back.authoring.sceneId });
      // 保存期间又有改动 → 不清脏
      const p = save(); op('改说明', () => { S.doc.def.label = 'x' + Date.now(); }); await p;
      ok('S6 edit during save keeps dirty', S.dirty === true);
      await save();
      ok('S6 second save clears', !S.dirty);
    }
    // ---------------------------------------------------------------- S7 删除 / 复制 / 键盘
    {
      const n = refl().length;
      key('d', { ctrlKey: true });
      ok('S7 Ctrl+D duplicates the selected wall', refl().length === n + 1 && S.sel.ids.size === 1);
      key('Delete');
      ok('S7 Delete removes selection', refl().length === n && S.sel.kind === null);
      key('b'); ok('S7 B = addWall tool', S.tool === 'addWall');
      key('Escape'); ok('S7 Esc back to move', S.tool === 'move');
      key('q'); ok('S7 Q = select tool (canvas focused, no RMB held)', S.tool === 'select'); key('w');
      ok('S7 W = move tool', S.tool === 'move');
      // 按着右键时 W 是飞行键：工具不变、相机前进
      // （这里故意只给 key 不给 code：合成事件 / 旧浏览器那条路也得能飞；定时步进 120ms 内必须动）
      { const c0 = v3._eye(); ev('mousedown', 200, 200, { button: 2, buttons: 2 }); cv().dispatchEvent(new KeyboardEvent('keydown', { key: 'w', bubbles: true })); await wait(120); cv().dispatchEvent(new KeyboardEvent('keyup', { key: 'w', bubbles: true })); ev('mouseup', 200, 200, { button: 2, buttons: 0 });
        const c1 = v3._eye(); const moved = Math.hypot(c1[0] - c0[0], c1[1] - c0[1], c1[2] - c0[2]);
        ok('S7 W while RMB held flies (interval stepping, key without code) instead of switching tool', S.tool === 'move' && moved > 1 && !v3.fly && v3.keys.size === 0, { moved: +moved.toFixed(2), tool: S.tool }); }
      const dirty0 = S.dirty;
      // 脏时切空间：弹页内对话框；点「留下」不切
      op('改说明', () => { S.doc.def.label = 'dirty'; });
      const pr = window.__openSpace(S.spaces[0].id === 'zz_selftest_a' ? S.spaces[1].id : S.spaces[0].id);
      await wait(50);
      const dlg = el('dialog');
      ok('S7 switching space while dirty shows the in-page dialog', dlg && !dlg.hidden && shown('dialog') && dialogCoversCenter(), { top: topAtCenter() });
      const cancel = [...el('dialogForm').querySelectorAll('button')].find((b) => b.textContent === '留下'); if (cancel) cancel.click();
      await wait(50);
      ok('S7 "留下" keeps the current doc and really takes the dialog away', S.doc.id === 'zz_selftest_a' && S.dirty && !shown('dialog') && ['view3d', 'overlay3d'].includes(topAtCenter()), { dirty0, top: topAtCenter() });
      await save();
    }
    // ---------------------------------------------------------------- S8 试听（无游戏也要给人话）
    {
      await probe('sfx_gibbon_dry_a');
      const st = el('status').textContent;
      // 自检可能恰好撞上一个开着的游戏页：那几种结果（没解锁 / 首回提示）也都是人话，一样算过
      ok('S8 probe explains itself whatever the game is doing', /发不出去|没在跑|未解锁|没解锁|首回/.test(st), { st });
      ok('S8 probe seq advanced', S.link.probeSeq >= 1);
      // 顶栏按钮按现状换脸：没游戏 = 拉起；游戏在别的场景 = 切过去；已在本场景 = 灰掉（都不硬同步）
      {
        const b = el('btnLaunchGame'), L = S.link, saved = { connected: L.connected, alive: L.alive, status: L.status, enabled: L.enabled };
        L.enabled = true; L.connected = false; L.alive = false; L.status = null; renderLinkChip();
        ok('S8b button offers to launch when no game is running', b.textContent.startsWith('▶ 拉起游戏进「' + S.scene.id) && !b.disabled, { t: b.textContent });
        L.connected = true; L.alive = true; L.status = { sceneId: '__elsewhere__', autoplayAllowed: false, audioUnlocked: false }; renderLinkChip();
        ok('S8b button offers to switch the game when it is in another scene', b.textContent === `⇄ 游戏切到「${S.scene.id}」` && !b.disabled, { t: b.textContent });
        ok('S8b "reopen in preview window" shows only for a plain-browser page', !el('btnReopenGame').hidden, {});
        L.status = { sceneId: S.scene.id, autoplayAllowed: true, audioUnlocked: true }; renderLinkChip();
        ok('S8b button is greyed when the game is already in this scene', b.textContent === `游戏已在「${S.scene.id}」` && b.disabled, { t: b.textContent });
        ok('S8b "reopen" is hidden for a preview-window page', el('btnReopenGame').hidden, {});
        Object.assign(L, saved); renderLinkChip();
      }
    }
    // ---------------------------------------------------------------- S9 换场景不丢文档、撤销跨换场
    {
      const other = S.scenes.find((s) => s.depth && s.id !== S.scene.id);
      if (other) {
        const id0 = S.doc.id, n0 = refl().length;
        await changeScene(other.id, '');
        ok('S9 change scene keeps doc, marks authoring', S.doc.id === id0 && refl().length === n0 && S.doc.def.authoring.sceneId === other.id && S.scene.id === other.id && S.dirty);
        key('z', { ctrlKey: true });
        ok('S9 undo restores authoring scene id in doc', S.doc.def.authoring.sceneId !== other.id);
        for (let i = 0; i < 80 && (S.busy || S.loadingScene); i++) await wait(100);
        await wait(100);
        ok('S9 canvas follows the doc after undo (scene reloaded)', S.scene.id === S.doc.def.authoring.sceneId, { scene: S.scene.id, doc: S.doc.def.authoring.sceneId });
      } else ok('S9 (skipped: no second scene with depth)', true);
    }
    // ---------------------------------------------------------------- S10 有位置的声源 / 听者绑定 / 直达声（v3）
    {
      await openSpace('zz_selftest_a'); await wait(100);
      const def = () => S.doc.def;
      const n0 = (def().sources || []).length, u0 = history.undoStack.length;
      const L = def().listener;
      v3.focus([L.x, L.y || 0, L.z], 400); v3.cam.pitch = 0.9; v3.draw();
      const gp = [L.x + 200, v3.groundY(L.x + 200, L.z + 100), L.z + 100];
      const c = P(gp);
      setTool('placeSource'); click(c[0], c[1]);
      ok('S10 placeSource click adds a source, selects it, probe follows it, one history entry, tool back to move',
        (def().sources || []).length === n0 + 1 && S.sel.kind === 'source' && S.sel.ids.has(n0) && S.probeFrom === n0 && history.undoStack.length === u0 + 1 && S.tool === 'move',
        { sources: def().sources, probeFrom: S.probeFrom, tool: S.tool });
      const sp = def().sources[n0];
      ok('S10 the new source landed near where the mouse was', !!sp && Math.abs(sp.x - gp[0]) < 40 && Math.abs(sp.z - gp[2]) < 40, { sp, gp });
      // 直达声 + 抽头按它算：声源在听者右前方 ⇒ 直达长度 > 0、声像向右
      ok('S10 direct path is computed for the probe source (length > 0, pan > 0 for a source on the right)', !!S.direct && S.direct.length > 0 && S.direct.pan > 0, S.direct);
      // 试听带发声点：publish 的 probe.at 就是这个声源的发声点（地面 + 发声高度）
      let sent = null; const origPost = API.post;
      API.post = async (path, body) => { if (path === '/api/link/publish' && body.probe) sent = body.probe; return origPost(path, body); };
      await probe('sfx_gibbon_dry_a');
      ok('S10 probe carries the source emit point (at) when a source is the probe source', !!(sent && sent.at) && Math.abs(sent.at.x - sp.x) < 1e-6 && sent.at.y > (sp.y || 0), { sent });
      S.probeFrom = -1; recompute(false); render(); sent = null;
      await probe('sfx_gibbon_dry_a'); API.post = origPost;
      ok('S10 probe from the listener itself carries at = null and direct length 0', !!sent && sent.at === null && !!S.direct && S.direct.length === 0, { sent, direct: S.direct });
      // 听者绑定：检视器下拉写进 def.listenerBinding，可撤销
      select('listener', 0, false);
      const bindSel = [...el('inspector').querySelectorAll('select')].find((x) => [...x.options].some((o) => o.value === 'camera'));
      ok('S10 listener inspector offers the binding selector', !!bindSel);
      if (bindSel) { bindSel.value = 'camera'; bindSel.dispatchEvent(new Event('change')); }
      ok('S10 binding = camera lands in def.listenerBinding', !!def().listenerBinding && def().listenerBinding.mode === 'camera', { lb: def().listenerBinding });
      key('z', { ctrlKey: true });
      ok('S10 undo restores the previous binding (new spaces are born with an explicit player binding)', !!def().listenerBinding && def().listenerBinding.mode === 'player', { lb: def().listenerBinding });
      // 落盘往返：sources / listenerBinding / direct 都留得住
      op('改直达与绑定', () => { def().direct = { refDistanceM: 12 }; def().listenerBinding = { mode: 'camera' }; });
      await save();
      const back = await API.json('/api/space?id=zz_selftest_a');
      const got = back.space ? (back.space.def || back.space) : back.def;
      ok('S10 save round-trips sources / listenerBinding / direct', !!got && Array.isArray(got.sources) && got.sources.length === n0 + 1 && !!got.listenerBinding && got.listenerBinding.mode === 'camera' && !!got.direct && got.direct.refDistanceM === 12,
        { sources: got && got.sources, lb: got && got.listenerBinding, direct: got && got.direct });
      select('source', n0, false); key('Delete');
      ok('S10 Delete removes the selected source and the probe goes back to the listener', (def().sources || []).length === n0 && S.probeFrom === -1, { sources: def().sources, probeFrom: S.probeFrom });
    }
  } catch (e) {
    log.push('EXC ' + (e && e.stack || e));
  } finally {
    try { for (const id of tmp) await API.post('/api/delete', { id }); await refreshSpaces(); } catch (e) { log.push('EXC cleanup ' + e); }
    window.__selftestResult = log.join('\n');
  }
})();
