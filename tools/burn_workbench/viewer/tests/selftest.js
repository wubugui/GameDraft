/* 燃烧工作台 · 交互层端到端回归（在真页面里跑；由 `sh scripts/py.sh -m tools.burn_workbench --selftest` 注入）。
 *
 * 每条 `ok()` 一行 PASS / FAIL；异常记 EXC；跑完报告写进 window.__selftestResult（桌面壳打印、有 FAIL 退出码 1）。
 * 约定：
 *  - 整个进程的读写都指在临时样例工程（`fixtures.build_project`，`/api/boot` 的 `real === false` 自证），真库一个字节不碰；
 *  - 游戏地址钉在 127.0.0.1:9（联动只验"软失败"与载荷形状）；
 *  - 手势从画布入口合成真实鼠标事件进去（护栏从最外层进）；
 *  - viewer 脚本是 classic script：`S` / `P` / `V` / `HIST` 等是词法声明、不挂 window，这里一律用裸标识符。 */
(async () => {
  const log = [];
  const ok = (name, cond, extra) => log.push((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + JSON.stringify(extra) : ''));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 4000)) { try { if (fn()) return true; } catch (e) { /* 还没好 */ } await wait(40); } return false; };
  const idle = async () => { await wait(90); await until(() => !buildTimer && !S.busy, 5000); if (P.buildPromise) await P.buildPromise; await wait(20); };
  const mouse = (type, x, y, opts) => {
    const r = V.ov.getBoundingClientRect();
    const e = new MouseEvent(type, Object.assign({ bubbles: true, cancelable: true, clientX: r.left + x, clientY: r.top + y, button: 0, buttons: 1 }, opts || {}));
    (type === 'mousedown' ? V.ov : window).dispatchEvent(e);
  };
  const key = (k, opts) => window.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, opts || {})));
  const answer = async (button, values) => {
    await until(() => !el('dialog').hidden, 4000);
    for (const [k, v] of Object.entries(values || {})) { const inp = el('dialogFields').querySelector(`[data-key="${k}"]`); if (inp) inp.value = v; }
    const b = el('dialogBtns').querySelector(`[data-choice="${button}"]`);
    if (b) b.click(); else key('Escape');
  };
  const field = (k) => el('side').querySelector(`[data-key="${k}"]`);
  const setField = async (k, v) => {
    renderInspector();
    const f = field(k);
    if (!f) return false;
    f.value = v;
    f.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(10);
    return true;
  };
  const PAPER = '/resources/runtime/images/zz_burn/paper.png';
  const CANDLE = '/resources/runtime/images/zz_burn/candle.png';
  const TK = TEMPLATE_KEY;
  const near = (a, b, eps) => Math.abs(a - b) < (eps || 1e-6);

  try {
    // ------------------------------------------------------------------ S1 启动：只有模板，没有场景
    await until(() => window.__ready, 30000);
    await idle();
    ok('S1 boot: ready, a template open in the art view, runtime bundle + GLSL + WebGL2 shader up, clean',
      !!window.__ready && S.docId === 'paper_pile' && S.view === 'art' && !S.sv && !!S.rt && !!S.glsl && V.gl.ok && !!V.gl.prog && !S.dirty,
      { doc: S.docId, view: S.view, rtErr: S.rtErr, glErr: V.gl && V.gl.err, dirty: S.dirtyIds });
    const boot = await API.json('/api/boot');
    ok('S1 selftest process reads/writes a temp project (never the real library)', boot.real === false && /burnwb_selftest_/.test(boot.data), { data: boot.data, real: boot.real });
    ok('S1 page-level dropdown is installed (no native popups)', !!window.Dropdown);
    ok('S1 no scene picker / hotspot list / placement editing anywhere on the page',
      !el('sceneSel') && !el('hotspotList') && !el('lostChip') && !/布置/.test(el('side').textContent), { side: el('side').textContent.slice(0, 80) });
    await until(() => S.refsFor === 'paper_pile', 3000);
    ok('S1 「用在哪」 lists every host of the template (2 hotspots + 1 NPC + 1 particle plate)',
      S.refs.length === 4 && el('refsList').querySelectorAll('[data-ref]').length === 4
      && el('refsList').querySelectorAll('[data-ref-kind="hotspot"]').length === 2 && !!el('refsList').querySelector('[data-ref-kind="npc"]') && !!el('refsList').querySelector('[data-ref-kind="plate"]'),
      S.refs.map((r) => `${r.kind}:${r.entity || r.effect}`));

    // ------------------------------------------------------------------ S2 模板预览 = 运行时本体、按真实尺寸
    ok('S2 art preview is the bundled runtime BurnSceneSim with one template instance',
      P.art && P.art.sim instanceof S.rt.burnSim.BurnSceneSim && P.art.key === TK && P.art.sim.keys().join() === TK);
    const ext0 = S.rt.burnGeometry.burnFrameExtent(P.art.frame);
    ok('S2 the instance is laid out at the template real size (widthCm × 0.88 wu) via burnEntityPlacement / burnPlacementFrame',
      near(ext0.width, 136.36 * 0.88, 1e-6) && near(ext0.height, 90.91 * 0.88, 1e-6) && P.art.placement.footX === 0 && P.art.placement.footY === 0, ext0);
    draw();
    ok('S2 art view says it previews at real size (no "assumed size / place it on a hotspot" hint)',
      /按真实尺寸预览：136\.36 × 90\.91 cm/.test(el('viewInfo').textContent) && !/假定尺寸|布置到热点/.test(el('viewInfo').textContent), el('viewInfo').textContent);
    restartPreview();
    previewIgnite(false);
    for (let i = 0; i < 40; i++) stepPreview(0.05);
    const fracBig = P.art.sim.debugItem(TK).ignited / P.art.grid.fuelCells;
    await setField('doc.widthCm', '68.18');
    await idle();
    const fracSmall = P.art.sim.debugItem(TK).ignited / P.art.grid.fuelCells;
    ok('S2 same events on a half-size template burn through a larger fraction in the same 2 s (speed is in cm/s at real size)',
      fracSmall > fracBig * 1.3 && near(P.t, 2, 1e-9) && near(S.rt.burnGeometry.burnFrameExtent(P.art.frame).width, 68.18 * 0.88, 1e-6), { fracBig, fracSmall });
    undo();
    await idle();
    restartPreview();

    // ------------------------------------------------------------------ S3 检视器字段编辑 / 撤销 / 重做
    const d0 = JSON.stringify(S.docs.paper_pile);
    await setField('doc.flameSeconds', '2.25');
    ok('S3 inspector numeric field writes the doc, marks dirty, one history entry',
      S.docs.paper_pile.flameSeconds === 2.25 && S.dirtyIds.includes('paper_pile') && HIST.undo.length === 1, { v: S.docs.paper_pile.flameSeconds, undo: HIST.undo.length });
    ok('S3 save button shows dirty state', el('btnSave').classList.contains('dirty'));
    key('z', { ctrlKey: true });
    ok('S3 Ctrl+Z restores the doc byte-for-byte and clears dirty', JSON.stringify(S.docs.paper_pile) === d0 && !S.dirty);
    key('y', { ctrlKey: true });
    ok('S3 Ctrl+Y redoes', S.docs.paper_pile.flameSeconds === 2.25 && S.dirty);
    undo();
    await setField('doc.gridCells', '32.5');
    ok('S3 int field refuses a non-integer (no write, no history)', S.docs.paper_pile.gridCells === 32 && !S.dirty, { g: S.docs.paper_pile.gridCells });
    await setField('doc.gridCells', '999');
    ok('S3 out-of-range int is refused, not silently clamped', S.docs.paper_pile.gridCells === 32, { g: S.docs.paper_pile.gridCells });
    await setField('doc.ignitionDelay', '');
    ok('S3 clearing an optional numeric = the key is deleted (shows default, not written back)', !('ignitionDelay' in S.docs.paper_pile) && S.dirty);
    renderInspector();
    ok('S3 cleared field shows the runtime default as placeholder', /缺省 0\.5/.test((field('doc.ignitionDelay') || {}).placeholder || ''), { ph: (field('doc.ignitionDelay') || {}).placeholder });
    undo();
    ok('S3 undo brings the key back', S.docs.paper_pile.ignitionDelay === 0.25 && !S.dirty);
    await setField('doc.look.glowKelvin', '');
    ok('S3 clearing a nested key never writes an empty container', !('glowKelvin' in (S.docs.paper_pile.look || {})) && isObj(S.docs.paper_pile.look), { look: S.docs.paper_pile.look });
    undo();
    renderInspector();
    const lightInput = field('doc.light.intensityPerM2');
    if (lightInput) { lightInput.value = ''; lightInput.dispatchEvent(new Event('change', { bubbles: true })); }
    ok('S3 required field (light.intensityPerM2) cannot be cleared', S.docs.paper_pile.light.intensityPerM2 === 12, { l: S.docs.paper_pile.light });
    ok('S3 back to the saved doc', JSON.stringify(S.docs.paper_pile) === d0 && !S.dirty);

    // ------------------------------------------------------------------ S4 真实尺寸：锁比例 / 解锁 / 偏离提示 / 必填
    const undoN4 = HIST.undo.length;
    await setField('doc.widthCm', '68.18');
    ok('S4 locked aspect: changing the width moves the height by the image pixel ratio (96×64) in ONE history entry',
      S.docs.paper_pile.widthCm === 68.18 && S.docs.paper_pile.heightCm === 45.45 && HIST.undo.length === undoN4 + 1, { w: S.docs.paper_pile.widthCm, h: S.docs.paper_pile.heightCm });
    renderInspector();
    ok('S4 no aspect warning while the size follows the image', !el('side').querySelector('[data-warn="aspect"]'));
    undo();
    ok('S4 undo restores both', S.docs.paper_pile.widthCm === 136.36 && S.docs.paper_pile.heightCm === 90.91 && !S.dirty);
    renderInspector();
    const lock = field('size.lock');
    lock.checked = false; lock.dispatchEvent(new Event('change', { bubbles: true }));
    ok('S4 unlock is a page preference (no doc change)', S.sizeLock === false && !S.dirty);
    await setField('doc.heightCm', '136.36');
    renderInspector();
    const warn = el('side').querySelector('[data-warn="aspect"]');
    ok('S4 unlocked: height alone changes; >2% off the image aspect shows a loud warning explaining held props scale by width',
      S.docs.paper_pile.widthCm === 136.36 && S.docs.paper_pile.heightCm === 136.36 && !!warn && warn.classList.contains('loud') && /按宽算/.test(warn.textContent), warn && warn.textContent);
    el('side').querySelector('[data-act="fixHeight"]').click();
    renderInspector();
    ok('S4 「按图比例改高」 fixes it and the warning goes away', S.docs.paper_pile.heightCm === 90.91 && !el('side').querySelector('[data-warn="aspect"]'), { h: S.docs.paper_pile.heightCm });
    undo(); undo();
    renderInspector();
    const lock2 = field('size.lock');
    lock2.checked = true; lock2.dispatchEvent(new Event('change', { bubbles: true }));
    await setField('doc.widthCm', '');
    ok('S4 real size is required: clearing it is refused', S.docs.paper_pile.widthCm === 136.36 && /必填/.test(el('status').textContent), { status: el('status').textContent });
    await setField('doc.heightCm', '-3');
    ok('S4 non-positive size is refused', S.docs.paper_pile.heightCm === 90.91 && !S.dirty);
    let gateErr = '';
    try { const nd = clone(S.docs.paper_pile); delete nd.widthCm; await API.post('/api/validate', { doc: nd }); } catch (e) { gateErr = String(e.message || e); }
    ok('S4 the shared gate hard-rejects a template without a real size', /widthCm/.test(gateErr), gateErr);

    // ------------------------------------------------------------------ S5 原画视图：着火点增删拖 + 握点
    setView('art');
    fitView();
    await wait(30);
    draw();
    setTool('point');
    const size = artSize();
    let sp = toScreen(size[0] * 0.25, size[1] * 0.5);
    mouse('mousedown', sp[0], sp[1]); mouse('mouseup', sp[0], sp[1]);
    const pts = () => S.docs.paper_pile.ignitionPoints;
    ok('S5 point tool: a click adds an ignition point with an auto-unique id', pts().length === 2 && pts()[1].id === 'p2' && Math.abs(pts()[1].u - 0.25) < 0.02, pts());
    setTool('select');
    sp = toScreen(pts()[1].u * size[0], pts()[1].v * size[1]);
    const to = toScreen(size[0] * 0.75, size[1] * 0.3);
    mouse('mousedown', sp[0], sp[1]);
    for (let i = 1; i <= 6; i++) mouse('mousemove', sp[0] + (to[0] - sp[0]) * i / 6, sp[1] + (to[1] - sp[1]) * i / 6);
    mouse('mouseup', to[0], to[1]);
    ok('S5 dragging a point moves it (one history entry for the whole drag)', Math.abs(pts()[1].u - 0.75) < 0.02 && Math.abs(pts()[1].v - 0.3) < 0.02 && HIST.undo.length === 2, { p: pts()[1], undo: HIST.undo.map((e) => e.label) });
    key('Delete');
    ok('S5 Delete removes the selected point', pts().length === 1);
    undo(); undo(); undo();
    ok('S5 undo all the way back = original doc', JSON.stringify(S.docs.paper_pile) === d0 && !S.dirty);
    const hist5 = HIST.undo.length;
    ok('S5 grip not written = bottom-centre default (drawn as a dashed point)', !('grip' in S.docs.paper_pile) && gripOf(S.docs.paper_pile).written === false && gripOf(S.docs.paper_pile).v === 1);
    const g0 = toScreen(size[0] * 0.5, size[1]);
    const g1 = toScreen(size[0] * 0.3, size[1] * 0.6);
    mouse('mousedown', g0[0], g0[1]);
    ok('S5 pressing on the default grip selects it', S.selGrip === true && S.selPoint === '');
    for (let i = 1; i <= 5; i++) mouse('mousemove', g0[0] + (g1[0] - g0[0]) * i / 5, g0[1] + (g1[1] - g0[1]) * i / 5);
    mouse('mouseup', g1[0], g1[1]);
    const gr = S.docs.paper_pile.grip;
    ok('S5 dragging the grip writes grip {u, v} (same interaction as ignition points, one history entry)',
      isObj(gr) && Math.abs(gr.u - 0.3) < 0.02 && Math.abs(gr.v - 0.6) < 0.02 && Object.keys(gr).join() === 'u,v' && HIST.undo.length === hist5 + 1 && /握点/.test(HIST.undo[HIST.undo.length - 1].label), { gr, undo: HIST.undo.length });
    renderInspector();
    ok('S5 inspector shows the written grip', field('doc.grip.u') && Number(field('doc.grip.u').value) === gr.u && !!el('side').querySelector('[data-act="clearGrip"]'));
    el('side').querySelector('[data-act="clearGrip"]').click();
    ok('S5 「清掉」 deletes the grip key (back to bottom centre)', !('grip' in S.docs.paper_pile));
    undo();
    S.selGrip = true;
    key('Delete');
    ok('S5 Delete with the grip selected clears it too', !('grip' in S.docs.paper_pile));
    undo(); undo();
    ok('S5 undo back to no grip', !('grip' in S.docs.paper_pile) && !S.dirty);
    await setField('doc.grip.v', '0.75');
    ok('S5 typing only v creates grip with the default u', isObj(S.docs.paper_pile.grip) && S.docs.paper_pile.grip.u === 0.5 && S.docs.paper_pile.grip.v === 0.75);
    await setField('doc.grip.u', '1.5');
    ok('S5 grip outside 0..1 is refused', S.docs.paper_pile.grip.u === 0.5);
    undo();
    ok('S5 grip edits undone', JSON.stringify(S.docs.paper_pile) === d0 && !S.dirty);
    S.selGrip = false;

    // ------------------------------------------------------------------ S6 燃料涂层笔刷
    await idle();
    const fuelBefore = P.art.grid.fuelCells;
    setTool('fuel');
    S.brush.size = 40; S.brush.strength = 1; S.brush.erase = false; S.brush.value = 0;
    await until(() => { const m = maskFor('fuel'); return m && m.ready; }, 2000);
    const a0 = toScreen(size[0] * 0.1, size[1] * 0.5), a1 = toScreen(size[0] * 0.9, size[1] * 0.5);
    const hist6 = HIST.undo.length;
    mouse('mousedown', a0[0], a0[1]);
    for (let i = 1; i <= 12; i++) mouse('mousemove', a0[0] + (a1[0] - a0[0]) * i / 12, a0[1]);
    mouse('mouseup', a1[0], a1[1]);
    const md = S.docs.paper_pile.fuel && S.docs.paper_pile.fuel.maskData;
    ok('S6 brush stroke writes fuel.maskData as a PNG data URL (one history entry)', typeof md === 'string' && md.startsWith('data:image/png;base64,') && HIST.undo.length === hist6 + 1, { undo: HIST.undo.length });
    const m = maskFor('fuel');
    ok('S6 mask buffer is long side 256 with the image aspect', m.w === 256 && m.h === Math.round(256 * size[1] / size[0]), { w: m.w, h: m.h });
    await idle();
    const fuelAfter = P.art.grid.fuelCells;
    ok('S6 the runtime grid rebuilt from the painted mask has fewer fuel cells', fuelAfter < fuelBefore, { fuelBefore, fuelAfter });
    const valid = await API.post('/api/validate', { doc: S.docs.paper_pile });
    ok('S6 painted doc passes the shared shape gate', !!valid.doc && valid.doc.fuel.maskData === md);
    key('z', { ctrlKey: true });
    await idle();
    ok('S6 undo removes the mask and the grid goes back', !S.docs.paper_pile.fuel && P.art.grid.fuelCells === fuelBefore && !S.dirty, { cells: P.art.grid.fuelCells });
    ok('S6 mask buffer re-synced to "no mask" after undo (all 255)', (() => { const mm = maskFor('fuel'); return mm && mm.ready && !mm.src && mm.data.every((x) => x === 255); })());
    key('y', { ctrlKey: true });
    await idle();
    ok('S6 redo brings the mask back (buffer re-decodes from the doc)', S.docs.paper_pile.fuel.maskData === md && await until(() => { const mm = maskFor('fuel'); return mm.ready && mm.src === md && mm.data.some((x) => x < 128); }, 3000));
    undo();
    await idle();
    setTool('select');

    // ------------------------------------------------------------------ S7 预览：点火推进、确定性、着色、消耗燃烧、预览风
    restartPreview();
    draw();
    const cp = toScreen(size[0] * 0.5, size[1] * 0.5);
    const fresh = V.gl.readPixel(cp[0], cp[1]);
    previewIgnite(false);
    for (let i = 0; i < 60; i++) stepPreview(1 / 20);
    ok('S7 ignite at the ignition point: burning at t=3', P.art.sim.state(TK) === 'burning', { t: P.t, st: P.art.sim.state(TK) });
    const rd = itemReadout(P.art.sim, P.art);
    ok('S7 readout: burning cells, remaining fuel < 1, light and particle rate follow the flame area', rd.flameCount > 0 && rd.fuelLeft < 1 && rd.light && rd.light.intensity > 0 && rd.particles[0].rate > 0, rd);
    for (let i = 0; i < 340; i++) stepPreview(1 / 20);
    const enc = (sim, k, it) => { const b = new Uint8Array(it.grid.nx * it.grid.ny * 4); sim.encodeTexture(k, b); return b; };
    const live = enc(P.art.sim, TK, P.art);
    seek(P.t);
    const replayed = enc(P.art.sim, TK, P.art);
    ok('S7 scrubbing = deterministic replay from 0: texture bytes identical to the live run', live.length === replayed.length && live.every((x, i) => x === replayed[i]));
    ok('S7 burnt out at t=20 (paper ashAlpha 0)', P.art.sim.state(TK) === 'burnt', { st: P.art.sim.state(TK) });
    draw();
    const burnt = V.gl.readPixel(cp[0], cp[1]);
    ok('S7 the SAME burnShade.glsl draws it: fresh = paper colour, burnt out = background shows through',
      Math.abs(fresh[0] - 230) < 12 && Math.abs(fresh[2] - 150) < 12 && burnt[0] < 40 && burnt[2] < 40, { fresh, burnt });
    seek(1.0);
    draw();
    const hot = V.gl.readPixel(...toScreen(size[0] * 0.5, size[1] * 0.9));
    ok('S7 at t=1 the fire line glows (emission added)', hot[0] > 240 && hot[2] < fresh[2] - 40,
      { hot, fresh, st: P.art.sim.state(TK), cam: V.cam.art, view: [V.w, V.h] });
    const sl = el('tslider');
    sl.value = '4'; sl.dispatchEvent(new Event('input')); sl.dispatchEvent(new Event('change'));
    ok('S7 timeline slider seeks (replay to that time)', near(P.t, 4, 1e-9) && P.art.sim.state(TK) === 'burning');
    addPreviewEvent(eventTarget(), 'extinguish');
    stepPreview(0.5);
    ok('S7 extinguish: spread fire freezes (state out, not burning)', P.art.sim.state(TK) !== 'burning', { st: P.art.sim.state(TK) });
    addPreviewEvent(eventTarget(), 'reset');
    stepPreview(0.1);
    ok('S7 reset: back to unburnt', P.art.sim.state(TK) === 'unburnt');
    // 消耗燃烧 + 没点时不挂燃烧着色（与游戏一样）
    await openTemplate('candle_red');
    await idle();
    await until(() => artSize() && artSize()[0] === 24, 3000);
    fitView();
    restartPreview();
    draw();
    const csz = artSize();
    const top = V.gl.readPixel(...toScreen(csz[0] * 0.5, csz[1] * 0.1));
    ok('S7 an unburnt consume template is drawn as its plain image (no fire-line glow at t=0)', Math.abs(top[0] - 200) < 14 && top[1] < 60 && top[2] < 60, { top });
    previewIgnite(true);
    for (let i = 0; i < 40; i++) stepPreview(0.25);
    const cr = itemReadout(P.art.sim, P.art);
    ok('S7 consume template (candle) burns down: burning, fuel left between 0 and 1', cr.state === 'burning' && cr.fuelLeft < 1 && cr.fuelLeft > 0, cr);
    const ws = el('windSel');
    ws.value = '8'; ws.dispatchEvent(new Event('change', { bubbles: true }));
    await idle();
    for (let i = 0; i < 40; i++) stepPreview(0.25);
    ok('S7 preview wind (page-only) blows the candle out (blowout 3 m/s < 8 m/s)', P.art.sim.state(TK) === 'out' && S.wind.mps === 8 && !S.dirty, { st: P.art.sim.state(TK) });
    ws.value = '0'; ws.dispatchEvent(new Event('change', { bubbles: true }));
    await idle();
    await openTemplate('paper_pile');
    await idle();

    // ------------------------------------------------------------------ S8 用在哪 → 只读场景视图
    const refRow = el('refsList').querySelector('[data-ref-kind="npc"]');
    refRow.click();
    await until(() => S.sv && S.sv.scene && P.sc.items.length === 4, 8000);
    await idle();
    ok('S8 clicking a scene-entity ref opens the read-only scene view with that entity selected',
      S.view === 'scene' && S.sv.scene.id === 'zz_burn_room' && S.sv.entityId === 'npc_paper' && /只读/.test(el('btnViewScene').textContent), { view: S.view, sv: S.sv && S.sv.entityId });
    const items = () => Object.fromEntries(P.sc.items.map((x) => [x.key, x]));
    const I = items();
    ok('S8 every burnable entity of the scene (hotspots + NPC) is in ONE runtime sim, each with its own template',
      P.sc.sim instanceof S.rt.burnSim.BurnSceneSim && P.sc.sim.keys().join() === 'hs_candle,hs_paper,hs_paper2,npc_paper'
      && I.hs_candle.b.id === 'candle_red' && I.npc_paper.b.id === 'paper_pile' && P.sc.problems.length === 0 && P.sc.spaceKind === 'planar', { keys: P.sc.sim.keys(), probs: P.sc.problems });
    ok('S8 perspective follows the runtime entities: hotspot only with perspectiveScaleEnabled, NPC by default',
      I.hs_paper.depthScale === 1 && near(I.hs_paper2.depthScale, 0.75) && near(I.npc_paper.depthScale, 0.875) && I.hs_candle.depthScale === 1,
      { p: I.hs_paper.depthScale, p2: I.hs_paper2.depthScale, npc: I.npc_paper.depthScale });
    const ext = (k) => S.rt.burnGeometry.burnFrameExtent(I[k].frame);
    ok('S8 size = template real size × entity scale × perspective; facing left mirrors (displayImage.facing / initialFacing)',
      near(ext('hs_paper').width, 136.36 * 0.88, 1e-6) && near(ext('hs_paper2').width, 136.36 * 0.88 * 0.75, 1e-6)
      && I.hs_paper2.placement.flipX && I.hs_paper2.frame.ux < 0 && I.npc_paper.placement.flipX && !I.hs_paper.placement.flipX
      && I.hs_paper.placement.footX === 600 && I.hs_paper.placement.footY === 600, { w: ext('hs_paper').width, w2: ext('hs_paper2').width });
    restartPreview();
    stepPreview(0.5);
    ok('S8 an instance with initial: burning is lit at 0 s (first ignition point / whole)', P.sc.sim.state('hs_candle') === 'burning' && sceneEventsOf(I.hs_candle)[0].t === 0 && P.sc.sim.state('hs_paper') === 'unburnt');
    // 只读：拖不动
    draw();
    const histS8 = HIST.undo.length;
    const ep = toScreen(600, 560), eq = toScreen(900, 300);
    mouse('mousedown', ep[0], ep[1]);
    for (let i = 1; i <= 5; i++) mouse('mousemove', ep[0] + (eq[0] - ep[0]) * i / 5, ep[1] + (eq[1] - ep[1]) * i / 5);
    mouse('mouseup', eq[0], eq[1]);
    const ent = S.sv.scene.entities.find((e) => e.id === 'hs_paper');
    ok('S8 the scene view is read-only: clicking selects, dragging moves nothing and writes no history',
      S.sv.entityId === 'hs_paper' && ent.x === 600 && ent.y === 600 && HIST.undo.length === histS8 && !S.dirty && !V.drag, { sel: S.sv.entityId, x: ent.x });
    renderInspector();
    ok('S8 the selected instance shows its host config read-only (no editable host fields)',
      /实例配置（宿主身上的 burnable，只读）/.test(el('side').textContent) && /zz_paper_lit/.test(el('side').textContent)
      && !field('place.initial') && !field('place.igniteConditions') && !el('side').querySelector('textarea'), el('side').textContent.slice(0, 200));
    // 当前模板用工作态
    await setField('doc.widthCm', '68.18');
    await idle();
    ok('S8 the current template uses the working copy in the scene view (edit width → entity shrinks, other templates untouched)',
      near(S.rt.burnGeometry.burnFrameExtent(items().hs_paper.frame).width, 68.18 * 0.88, 1e-6) && near(S.rt.burnGeometry.burnFrameExtent(items().hs_candle.frame).width, 22.73 * 0.88, 1e-6));
    undo();
    await idle();
    // 蔓延
    restartPreview();
    previewIgnite(false);
    for (let i = 0; i < 400; i++) stepPreview(1 / 20);
    ok('S8 fire spreads across instances in the scene view (hs_paper → hs_paper2)', P.sc.sim.state('hs_paper') !== 'unburnt' && P.sc.sim.state('hs_paper2') !== 'unburnt', { a: P.sc.sim.state('hs_paper'), b: P.sc.sim.state('hs_paper2') });
    restartPreview();
    // 选另一份模板的实例 → 打开那份模板（场景视图留着）
    selectEntity('hs_candle');
    renderInspector();
    el('side').querySelector('[data-act="openEntityTemplate"]').click();
    await until(() => S.docId === 'candle_red', 3000);
    ok('S8 「打开模板」 on another template\'s instance switches the template and keeps the scene view', S.docId === 'candle_red' && S.view === 'scene' && !!S.sv);
    await openTemplate('paper_pile', { view: 'scene' });
    ok('S8 launch target = the scene view\'s scene', launchSceneId() === 'zz_burn_room');

    // ------------------------------------------------------------------ S9 点火站位（场景视图里选中的实例）
    selectEntity('hs_paper');
    await idle();
    refreshStances();
    const st = S.stances;
    const pt0 = st && st.points[0];
    ok('S9 stances: one ignition point → a right and a left stance', !!pt0 && !!pt0.right && !!pt0.left, { problems: st && st.problems });
    ok('S9 residual ≈ 0 (the tip lands on the ignition point at the contact frame)', !!pt0 && pt0.right.residual < 1e-6 && pt0.left.residual < 1e-6, pt0 && [pt0.right.residual, pt0.left.residual]);
    ok('S9 facing right stands left of the point, facing left stands right of it',
      !!pt0 && pt0.right.x < pt0.target.scene.x && pt0.left.x > pt0.target.scene.x, pt0 && [pt0.right.x, pt0.target.scene.x, pt0.left.x]);
    ok('S9 the target is the ignition point on the placed instance', !!pt0 && near(pt0.target.scene.x, 600, 1e-6) && near(pt0.target.scene.y, 600 - 0.1 * 90.91 * 0.88, 1e-6), pt0 && pt0.target.scene);
    ok('S9 the tip drawn for each stance is on the target', !!pt0 && Math.hypot(pt0.right.tip.x - pt0.target.scene.x, pt0.right.tip.y - pt0.target.scene.y) < 1e-6);
    ok('S9 contact frame from igniteSlots through stateMap (clip light, frame 1)', /片段「light」第 1 帧/.test(st.contactNote), { note: st.contactNote });
    await until(() => S.walk && S.walk.key === S.stances.walkKey, 3000);
    ok('S9 walkability judged locally with its source named (scene has no depth → bounds only)',
      !!S.walk && S.walk.source === 'local' && S.walk.results.length === 2 && S.walk.results.every((x) => x === true) && /边界/.test(S.walk.note), S.walk);
    ok('S9 interaction radius = range × scale × perspective (hotspot 120 × 1 × 1) and out-of-range flag is consistent',
      near(st.radius, 120) && pt0.right.outOfRange === (pt0.right.dist > st.radius) && pt0.left.outOfRange === (pt0.left.dist > st.radius), { r: st.radius, d: pt0.right.dist });
    renderInspector();
    ok('S9 inspector lists the stances with residual / walk verdict / range', /朝右（人在左）/.test(el('side').textContent) && /站得了/.test(el('side').textContent) && /离实体/.test(el('side').textContent));
    selectEntity('npc_paper');
    await idle();
    ok('S9 an NPC instance gets stances too, radius shrinks with its perspective (80 × 0.875)', !!S.stances && S.stances.points.length === 1 && near(S.stances.radius, 70), S.stances && S.stances.radius);
    selectEntity('hs_paper');
    const sockets = S.player.sockets;
    const savedSlots = sockets.igniteSlots;
    sockets.igniteSlots = [];
    refreshStances();
    ok('S9 unmarked ignite contact frame → explicit "use frame 0" warning', /没标点火接触帧：用第 0 帧/.test(S.stances.contactNote), { note: S.stances.contactNote });
    sockets.igniteSlots = savedSlots;
    const savedMap = S.player.stateMap;
    S.player.stateMap = { idle: 'idle' };
    refreshStances();
    ok('S9 missing ignite clip → explicit "use idle frame 0" warning', /不存在：用 idle 第 0 帧/.test(S.stances.contactNote), { note: S.stances.contactNote });
    S.player.stateMap = savedMap;
    S.stance.state = 'out';
    refreshStances();
    ok('S9 a prop state that cannot ignite (igniter null / no light) is called out', S.stances.problems.some((p) => /点不了火/.test(p)) && S.stances.problems.some((p) => /没燃着/.test(p)), S.stances.problems);
    S.stance.state = '';
    refreshStances();
    const lw = await API.post('/api/walk_check', { sceneId: 'zz_burn_room', points: [[10, 10], [-4, 20], [1601, 5]] });
    ok('S9 local walk check: inside bounds ok, outside bounds refused', JSON.stringify(lw.results) === '[true,false,false]', lw.results);
    closeSceneView();
    ok('S9 closing the scene view goes back to the art view; launch falls back to the first scene that uses the template',
      S.view === 'art' && !S.sv && P.sc.items.length === 0 && el('btnViewScene').hidden && launchSceneId() === 'zz_burn_room');

    // ------------------------------------------------------------------ S10 保存（临时工程）/ 往返 / 保存锁
    await setField('doc.flameSeconds', '1.75');
    ok('S10 unsaved summary hook reports the dirty template', /paper_pile/.test(window.__unsavedSummary()));
    key('s', { ctrlKey: true });
    await until(() => !S.saving && !S.dirty, 5000);
    const disk = await API.json('/api/burnable?id=paper_pile');
    ok('S10 Ctrl+S saves through the shared gate: disk has the value, dirty cleared, history kept', disk.doc.flameSeconds === 1.75 && !S.dirty && HIST.undo.length >= 1, { fs: disk.doc.flameSeconds, dirty: S.dirtyIds });
    ok('S10 float repr of untouched numbers survives the save (intensityPerM2 stays 12.0 on disk)', await (async () => {
      const r = await fetch('/api/burnable?id=paper_pile'); const txt = await r.text(); return txt.includes('"intensityPerM2": 12.0') || txt.includes('"intensityPerM2":12.0');
    })());
    ok('S10 unsaved summary is empty after save', window.__unsavedSummary() === '');
    const again = await API.post('/api/save', { doc: S.docs.paper_pile, base: S.base.paper_pile });
    ok('S10 saving an unchanged doc writes nothing', again.written === false);
    await setField('doc.flameSeconds', '1.5');
    const pSave = saveAll();
    S.docs.paper_pile.emberSeconds = 1.25;
    refreshDirty();
    await pSave;
    ok('S10 edited while the save was in flight → stays dirty and says press again', S.dirty && /再按一次/.test(el('status').textContent), { status: el('status').textContent });
    await saveAll();
    ok('S10 second save clears it', !S.dirty);
    await setField('doc.flameSeconds', '1.6');
    S.base.paper_pile = Object.assign(clone(S.base.paper_pile), { label: '别人以为的' });
    await saveAll();
    ok('S10 disk changed elsewhere → refused, page keeps the edit and stays dirty', S.dirty && /别处/.test(el('status').textContent), { status: el('status').textContent });
    S.base.paper_pile = clone((await API.json('/api/burnable?id=paper_pile')).doc);
    await saveAll();
    ok('S10 after reloading the base the save goes through', !S.dirty);

    // ------------------------------------------------------------------ S11 新建（尺寸必填、选图）/ 复制 / 换图 / 改名（跟着改引用）/ 删除
    let pNew = newTemplate();
    await answer('ok', { id: 'bad id!', image: PAPER, widthCm: '10', heightCm: '10' });
    await pNew;
    ok('S11 illegal id is refused with a message, nothing created', !S.assets.some((a) => a.id === 'bad id!') && /id 只许/.test(el('status').textContent), { status: el('status').textContent });
    pNew = newTemplate();
    await answer('ok', { id: 'paper_pile', image: PAPER, widthCm: '10', heightCm: '10' });
    await pNew;
    ok('S11 duplicate id is refused', /已经有了/.test(el('status').textContent));
    pNew = newTemplate();
    await answer('ok', { id: 'zz_nosize', image: PAPER, widthCm: '', heightCm: '' });
    await pNew;
    ok('S11 creating without a real size is refused (size is required)', !S.assets.some((a) => a.id === 'zz_nosize') && /真实尺寸/.test(el('status').textContent), { status: el('status').textContent });
    // 选图：筛选 + 点选 → 按图的像素比例给初始尺寸
    pNew = newTemplate();
    await until(() => !el('dialog').hidden, 4000);
    const filt = el('dialogFields').querySelector('[data-key="image__filter"]');
    filt.value = 'zz_burn candle'; filt.dispatchEvent(new Event('input'));
    const listed = [...el('dialogFields').querySelectorAll('.imglist .it')].map((x) => x.dataset.url);
    el('dialogFields').querySelector(`.imglist .it[data-url="${CANDLE}"]`).click();
    const dv = (k) => el('dialogFields').querySelector(`[data-key="${k}"]`).value;
    await until(() => dv('heightCm') === '50', 3000);
    ok('S11 image picker: candidates filter by words; picking fills an initial size from the image pixel ratio (24×96 → 12.5 × 50)',
      JSON.stringify(listed) === JSON.stringify([CANDLE]) && dv('image') === CANDLE && dv('widthCm') === '12.5' && dv('heightCm') === '50' && dv('id') === 'candle', { listed, w: dv('widthCm'), h: dv('heightCm'), id: dv('id') });
    filt.value = 'paper'; filt.dispatchEvent(new Event('input'));
    el('dialogFields').querySelector(`.imglist .it[data-url="${PAPER}"]`).click();
    await until(() => dv('widthCm') === '136.36', 3000);
    ok('S11 an image a scene already shows with a world size suggests that size (120 wu → 136.36 cm, height by pixel ratio)', dv('widthCm') === '136.36' && dv('heightCm') === '90.91', { w: dv('widthCm'), h: dv('heightCm') });
    const wIn = el('dialogFields').querySelector('[data-key="widthCm"]');
    wIn.value = '30'; wIn.dispatchEvent(new Event('input'));
    ok('S11 typing the width moves the untouched height by the image ratio', dv('heightCm') === '20', { h: dv('heightCm') });
    await answer('ok', { id: 'zz_new', label: '新的' });
    await pNew;
    ok('S11 create writes a new template with its real size and opens it clean',
      S.docId === 'zz_new' && S.assets.some((a) => a.id === 'zz_new') && S.docs.zz_new.widthCm === 30 && S.docs.zz_new.heightCm === 20 && S.docs.zz_new.image === PAPER && !S.dirty, S.docs.zz_new);
    ok('S11 a new template has no hosts', S.refsFor === 'zz_new' && S.refs.length === 0 && /没有宿主用它/.test(el('refsList').textContent));
    const pImg = pickTemplateImage();
    await until(() => !el('dialog').hidden, 4000);
    const f2 = el('dialogFields').querySelector('[data-key="image__filter"]');
    f2.value = 'candle'; f2.dispatchEvent(new Event('input'));
    el('dialogFields').querySelector(`.imglist .it[data-url="${CANDLE}"]`).click();
    await answer('ok');
    await pImg;
    await until(() => artSize() && artSize()[0] === 24, 3000);
    renderInspector();
    ok('S11 changing the image is one undoable edit; a size that no longer matches the image aspect is flagged loudly',
      S.docs.zz_new.image === CANDLE && S.dirty && !!el('side').querySelector('[data-warn="aspect"]'), { img: S.docs.zz_new.image });
    undo();
    const pDup = duplicateTemplate();
    await answer('ok', { id: 'zz_dup' });
    await pDup;
    ok('S11 duplicate creates a copy and opens it', S.docId === 'zz_dup' && S.assets.some((a) => a.id === 'zz_dup'));
    // 改名：跟着改所有引用处
    await openTemplate('paper_pile');
    const pRen = renameTemplate();
    await answer('ok', { id: 'zz_paper_renamed' });
    await until(() => !el('dialog').hidden && /确认改名/.test(el('dialogTitle').textContent), 4000);
    const renText = el('dialogText').textContent;
    await answer('ok');
    await pRen;
    const refsNew = (await API.json('/api/refs?id=zz_paper_renamed')).refs;
    const refsOld = (await API.json('/api/refs?id=paper_pile')).refs;
    ok('S11 rename confirms first, listing every file whose template value will change',
      /zz_burn_room\.json（3 处）/.test(renText) && /zz_paper_money\.json（1 处）/.test(renText), renText);
    ok('S11 rename rewrites every host reference on disk in one transaction and reopens clean',
      S.docId === 'zz_paper_renamed' && refsNew.length === 4 && refsOld.length === 0 && !S.docs.paper_pile && !S.dirty && HIST.undo.length === 0
      && S.refsFor === 'zz_paper_renamed' && S.refs.length === 4, { doc: S.docId, n: refsNew.length, old: refsOld.length });
    const pRen2 = renameTemplate();
    await answer('ok', { id: 'paper_pile' });
    await until(() => !el('dialog').hidden && /确认改名/.test(el('dialogTitle').textContent), 4000);
    await answer('ok');
    await pRen2;
    ok('S11 rename back', S.docId === 'paper_pile' && (await API.json('/api/refs?id=paper_pile')).refs.length === 4);
    // 删除：有引用拒绝
    const pDel = deleteTemplate();
    await until(() => !el('dialog').hidden, 4000);
    const delText = el('dialogTitle').textContent + '\n' + el('dialogText').textContent;
    await answer('ok');
    await pDel;
    ok('S11 deleting a referenced template is refused and lists the references', /删不了/.test(delText) && /npc_paper/.test(delText) && /zz_paper_money/.test(delText) && S.assets.some((a) => a.id === 'paper_pile'), delText);
    await openTemplate('zz_dup');
    const pDel2 = deleteTemplate();
    await answer('ok');
    await pDel2;
    ok('S11 delete an unreferenced template', !S.assets.some((a) => a.id === 'zz_dup'));
    await openTemplate('zz_new');
    const pDel3 = deleteTemplate();
    await answer('ok');
    await pDel3;
    ok('S11 delete another unreferenced template', !S.assets.some((a) => a.id === 'zz_new'));
    window.__openBurnable('paper_pile');
    await until(() => S.docId === 'paper_pile', 3000);
    await idle();

    // ------------------------------------------------------------------ S12 联动：软失败 / 协议 v2 载荷 / 游戏实例选择 / 站位判定
    const pr = await pushToGame();
    ok('S12 push to game with no dev server fails softly (no red "rejected", status explains)', !!pr && pr.ok === false && pr.connected === false && !S.link.err, { pr, err: S.link.err });
    ok('S12 v2 payload: template working copies only (no library / sceneId)', !!S.link.lastBody && isObj(S.link.lastBody.burnables) && !('library' in S.link.lastBody) && !('sceneId' in S.link.lastBody), Object.keys(S.link.lastBody || {}));
    await until(() => S.link.status, 3000);
    ok('S12 link status poll reports the game as not running; game probe buttons have nothing to target', !!S.link.status && S.link.status.connected === false && /游戏没开/.test(el('linkText').textContent) && el('btnGameIgnite').disabled);
    const gp = await gameProbe('ignite');
    ok('S12 in-game probe without game instances does nothing and says why', gp === null && /没有用这份模板的实例/.test(el('status').textContent));
    S.link.on = false;
    const fake = (items) => ({ ok: true, connected: true, gameAlive: true, gameUrl: 'http://127.0.0.1:9', doc: { sceneId: 'zz_burn_room', items, stats: {}, probeSeqDone: 0 } });
    const gameItems = [
      { kind: 'scene', sceneId: 'zz_burn_room', target: 'hs_paper', template: 'paper_pile', state: 'unburnt', events: 0, ready: true },
      { kind: 'held', target: 'player', socket: 'right_hand', template: 'paper_pile', state: 'burning', events: 2, ready: true },
      { kind: 'scene', sceneId: 'zz_burn_room', target: 'hs_candle', template: 'candle_red', state: 'burning', events: 1, ready: true },
    ];
    handleLinkStatus(fake(gameItems));
    const gsel = el('gameTarget');
    const gopts = [...gsel.options].map((o) => o.textContent);
    ok('S12 「游戏里」 target list = game instances that use THIS template (scene entity + held), others left out',
      gsel.options.length === 2 && /zz_burn_room \/ hs_paper/.test(gopts[0]) && /手上 player · right_hand/.test(gopts[1]) && !el('btnGameIgnite').disabled, gopts);
    gsel.value = gsel.options[1].value;
    S.selPoint = '';
    const pProbe = gameProbe('extinguish');
    const probeBody = S.link.lastBody && S.link.lastBody.probe;
    await pProbe;
    ok('S12 probe on a held instance sends {action, target: holder, socket}', JSON.stringify(probeBody) === JSON.stringify({ action: 'extinguish', target: 'player', socket: 'right_hand' }), probeBody);
    handleLinkStatus(fake(gameItems));
    gsel.value = gsel.options[0].value;
    S.selPoint = 'p1';
    const pProbe2 = gameProbe('ignite');
    const probeBody2 = S.link.lastBody && S.link.lastBody.probe;
    await pProbe2;
    S.selPoint = '';
    ok('S12 probe on a scene instance sends {action, target: entity id, point}', JSON.stringify(probeBody2) === JSON.stringify({ action: 'ignite', target: 'hs_paper', point: 'p1' }), probeBody2);
    handleLinkStatus(fake(gameItems));
    renderInspector();
    ok('S12 the game section lists only this template\'s instances with their state', /手上 player · right_hand · 在烧/.test(el('side').textContent) && /另有 1 个实例用别的模板/.test(el('side').textContent));
    // 游戏回传的站位判定（场景视图里：游戏判定优先于本地、界面写明来源）
    await openSceneView('zz_burn_room', 'hs_paper');
    await idle();
    refreshStances();
    await until(() => S.walk && S.walk.key === S.stances.walkKey, 3000);
    handleLinkStatus(fake(gameItems));
    ok('S12 in the scene view the game target follows the selected entity', JSON.parse(el('gameTarget').value)[2] === 'hs_paper');
    S.link.walkPending = { key: S.stances.walkKey, seq: 7 };
    const withWalk = fake(gameItems);
    withWalk.doc.walkProbeResult = { seq: 7, sceneId: 'zz_burn_room', bits: '10' };
    handleLinkStatus(withWalk);
    ok('S12 game walk result replaces the local one and is labelled as the game\'s', S.walk.source === 'game' && S.walk.results[0] === true && S.walk.results[1] === false, S.walk);
    handleLinkStatus({ ok: true, connected: false, gameUrl: 'http://127.0.0.1:9' });
    S.link.on = true;

    // ------------------------------------------------------------------ S13 视图手势
    fitView();
    draw();
    const c0 = { ...V.cam.scene };
    // 鼠标事件的 client 坐标是整数：探针点按事件真正落下的位置取（画布的 top 可能是小数）
    const ovr = V.ov.getBoundingClientRect();
    const wcx = Math.round(ovr.left + 300), wcy = Math.round(ovr.top + 250);
    const probe = [wcx - ovr.left, wcy - ovr.top];
    const wBefore = toWorld(probe[0], probe[1]);
    V.ov.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -300, clientX: wcx, clientY: wcy }));
    const wAfter = toWorld(probe[0], probe[1]);
    ok('S13 wheel zooms toward the cursor (the world point under it stays put)', V.cam.scene.k > c0.k && Math.hypot(wAfter[0] - wBefore[0], wAfter[1] - wBefore[1]) < 1e-6);
    const oxBefore = V.cam.scene.ox, oyBefore = V.cam.scene.oy;
    mouse('mousedown', 200, 200, { button: 1, buttons: 4 }); mouse('mousemove', 260, 230, { button: 1, buttons: 4 }); mouse('mouseup', 260, 230, { button: 1 });
    ok('S13 middle-drag pans by exactly the mouse delta', near(V.cam.scene.ox - oxBefore, 60, 1e-9) && near(V.cam.scene.oy - oyBefore, 30, 1e-9));
    fitView();
    draw();
    const hp = toScreen(700, 575);
    selectEntity('');
    mouse('mousedown', hp[0], hp[1]); mouse('mouseup', hp[0], hp[1]);
    ok('S13 clicking an instance image in the scene view selects it', S.sv.entityId === 'hs_paper2', { sel: S.sv.entityId });
    setTool('ignite');
    restartPreview();
    const hc = toScreen(1000, 560);
    mouse('mousedown', hc[0], hc[1]); mouse('mouseup', hc[0], hc[1]);
    ok('S13 ignite tool in the scene view records an event on the clicked instance', (P.scEvents.hs_candle || []).length === 1 && P.scEvents.hs_candle[0].k === 'ignite');
    setTool('select');
    restartPreview();
    closeSceneView();
    key('2');
    ok('S13 key 2 does nothing without a scene view; key 1 = art view', S.view === 'art');

    // ------------------------------------------------------------------ S14 消耗燃烧的顺序涂层
    await openTemplate('candle_red');
    await idle();
    setView('art');
    fitView();
    draw();
    setTool('order');
    ok('S14 order tool is available for a consume template', S.tool === 'order' && !el('brushbar').hidden);
    const orderBefore = Array.from(P.art.grid.order);
    await until(() => { const mo = maskFor('order'); return mo && mo.ready; }, 2000);
    const osz = artSize();
    S.brush.size = 64; S.brush.strength = 1; S.brush.value = 1; S.brush.erase = false;
    const o0 = toScreen(osz[0] * 0.5, osz[1] * 0.1), o1 = toScreen(osz[0] * 0.5, osz[1] * 0.4);
    mouse('mousedown', o0[0], o0[1]);
    for (let i = 1; i <= 8; i++) mouse('mousemove', o0[0], o0[1] + (o1[1] - o0[1]) * i / 8);
    mouse('mouseup', o1[0], o1[1]);
    const od = S.docs.candle_red.consume.orderData;
    await idle();
    const orderAfter = Array.from(P.art.grid.order);
    ok('S14 order brush writes consume.orderData and the runtime grid order follows it',
      typeof od === 'string' && od.startsWith('data:image/png;base64,') && orderAfter.some((v, i) => Math.abs(v - orderBefore[i]) > 0.2), { hasOrder: !!od });
    renderInspector();
    ok('S14 inspector says the order mask overrides from', /优先于 from/.test(el('side').textContent));
    el('btnClearMask').click();
    await idle();
    ok('S14 clear-mask button removes the order mask (one undoable step)', !S.docs.candle_red.consume.orderData && HIST.undo[HIST.undo.length - 1].label === '清顺序涂层');
    undo(); undo();
    await idle();
    ok('S14 undo back to the saved candle', !S.dirty, { dirty: S.dirtyIds });
    setTool('select');
  } catch (e) {
    log.push('EXC ' + ((e && e.stack) || e));
  } finally {
    window.__selftestResult = log.join('\n');
  }
})();
