/* 粒子工作台 · 表面材质区（水面 / 湿地）的端到端回归（真页面；`python -m tools.vfx_workbench --selftest <本文件>`）。
 *
 * 自检进程把布置库指到临时拷贝（app.py，/api/boot 的 placements.real 自证）。钉住的事：
 * 工具条两个按钮真的切工具并显示表面区；在 2D 原画视图里真按鼠标拖一个框 = 新的一块水面（场景级，不是哪条布置的）；
 * 顶点是可选对象、方向键微移 / 双击边线加点 / 删点都走同一套；检视器改种类 / 反光进历史、可撤；
 * 推给游戏的预览只带改了的场景的 surfaces；存盘落进布置库的 scenes[场景].surfaces；删掉最后一块 = 键没了；
 * 本地预览的锚点在水面里 = 按水面放（与游戏 surfaceKindAt 同判据）。 */
(async () => {
  const log = [];
  const ok = (name, value, extra) => log.push(`${value ? 'PASS' : 'FAIL'} ${name}${extra !== undefined ? ' ' + JSON.stringify(extra) : ''}`);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const originalFetch = window.fetch;
  const SID = '跑马梁';
  try {
    while (!window.__ready) await wait(50);
    const boot = await API.json('/api/boot');
    if (boot.placements.real !== false) throw new Error('Refuse to write a real placement library');
    S.link.on = false;
    await openEffect('paper_money', { force: true, jump: true });
    await loadScene(SID, '');
    if (!S.cal) throw new Error(`${SID} has no depth payload in this checkout`);
    // 起点：这个场景在临时库里的表面区清空（别的场景不碰）
    if (sceneSurfaces().length) {
      editSurfaces('清空（自检起点）', (arr) => { arr.length = 0; });
      el('btnSave').click(); await ioChain;
    }
    ok('T0 starts clean: no surfaces here, nothing dirty', sceneSurfaces().length === 0 && !S.dirty);

    // ---- 工具条按钮
    document.querySelector('#tools button[data-tool=areaWater]').click();
    ok('T1 the water tool button switches the tool and shows the surfaces', S.tool === 'areaWater' && S.surfEdit);
    setView(2); await wait(80);

    // ---- 真按鼠标拖一个框（2D 原画视图）
    const previews = [];
    window.fetch = (url, options) => {
      if (url === '/api/link/publish') {
        previews.push(JSON.parse(options.body));
        return Promise.resolve(new Response(JSON.stringify({ ok: true, rev: previews.length, connected: true }), { status: 200 }));
      }
      return originalFetch(url, options);
    };
    S.link.on = true;
    const cvs = el('view2d');
    const rect = cvs.getBoundingClientRect();
    const x0 = rect.width * 0.35, y0 = rect.height * 0.55, x1 = rect.width * 0.6, y1 = rect.height * 0.75;
    cvs.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: rect.left + x0, clientY: rect.top + y0 }));
    window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: rect.left + x1, clientY: rect.top + y1 }));
    window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await wait(PUBLISH_DEBOUNCE_MS + 150);
    const rs = sceneSurfaces();
    ok('T2 dragging a box made one water region with 4 vertices, back on the select tool',
      rs.length === 1 && rs[0].kind === 'water' && rs[0].id === 'water_1' && rs[0].polygon.length === 4 && S.tool === 'select',
      { rs, tool: S.tool });
    ok('T2 the new region is a scene-level edit (not any placement), one history entry', S.libDirty && /水面/.test(history.peekUndo()),
      { undo: history.peekUndo() });
    const pv = previews[previews.length - 1];
    ok('T2 the game preview carries only this scene\'s surfaces',
      !!pv && pv.placements.mode === 'scoped' && Object.keys(pv.placements.library.scenes).join() === SID
      && Object.keys(pv.placements.library.scenes[SID]).join() === 'surfaces' && pv.placements.library.scenes[SID].surfaces.length === 1,
      pv && pv.placements);

    // ---- 顶点：是可选对象；方向键微移 = 一条历史
    ok('T3 the first vertex is selected and has a gizmo pivot', S.sel.key === 'area:s0:0' && !!gizmoPivot(), { sel: S.sel.key });
    const p0 = rs[0].polygon[0].slice();
    nudgeSelected(10, 0, 0); nudgeEnd(); await wait(30);
    const p0b = sceneSurfaces()[0].polygon[0];
    ok('T3 nudging the selected vertex moves it on the ground', p0b[0] !== p0[0] || p0b[1] !== p0[1], { p0, p0b });
    const mid = [(rs[0].polygon[0][0] + rs[0].polygon[1][0]) / 2, (rs[0].polygon[0][1] + rs[0].polygon[1][1]) / 2];
    insertAreaVertex('s0', 0, mid);
    ok('T3 inserting on an edge adds a vertex and selects it', sceneSurfaces()[0].polygon.length === 5 && S.sel.key === 'area:s0:1');
    await deleteAreaVertexKey('area:s0:1');
    ok('T3 deleting that vertex brings it back to 4', sceneSurfaces()[0].polygon.length === 4);

    // ---- 检视器：改种类 / 反光，可撤
    Inspector.open.surfaces = true; renderInspector(); await wait(30);
    const sec = el('inspector').querySelector('.sec[data-sec="surfaces"]');
    // 区的行在「全局缺省」那几行之后：同名（反光 / 粗糙度）取最后一个
    const rowOf = (label) => [...sec.querySelectorAll('.row')].filter((n) => n.firstElementChild && n.firstElementChild.textContent === label).pop();
    const kindSel = rowOf('种类').querySelector('select');
    kindSel.value = 'wet'; kindSel.dispatchEvent(new Event('change', { bubbles: true })); await wait(30);
    ok('T4 the inspector switches the region to wet', sceneSurfaces()[0].kind === 'wet');
    doUndo(); await wait(30);
    ok('T4 Ctrl+Z brings it back to water', sceneSurfaces()[0].kind === 'water');
    const refl = el('inspector').querySelector('.sec[data-sec="surfaces"]');
    const rr = [...refl.querySelectorAll('.row')].filter((n) => n.firstElementChild && n.firstElementChild.textContent === '反光').pop().querySelector('input');
    rr.value = '0.5'; rr.dispatchEvent(new Event('change', { bubbles: true })); await wait(30);
    ok('T4 the reflect field writes 0.5 (empty = runtime default, placeholder shows it)', sceneSurfaces()[0].reflect === 0.5 && rr.placeholder === '1');

    // ---- 本地预览：锚点在水面里 = 按水面放
    const poly = sceneSurfaces()[0].polygon;
    const cx = poly.reduce((a, p) => a + p[0], 0) / poly.length, cy = poly.reduce((a, p) => a + p[1], 0) / poly.length;
    ok('T5 an anchor inside the water region previews as water, outside as ground',
      previewSurfaceKind({ x: cx, y: cy }) === 'water' && previewSurfaceKind({ x: -99999, y: -99999 }) === 'ground');

    // ---- 存盘 / 删掉 / 再存
    el('btnSave').click(); await ioChain;
    let disk = (await API.json('/api/placements')).doc;
    const ds = disk.scenes[SID] && disk.scenes[SID].surfaces;
    ok('T6 saving writes scenes[scene].surfaces in the canonical key order, nothing dirty afterwards',
      Array.isArray(ds) && ds.length === 1 && Object.keys(ds[0]).join() === 'id,kind,polygon,reflect' && !S.dirty,
      { ds, dirty: S.dirty });
    const del = el('inspector').querySelector('.sec[data-sec="surfaces"] [data-role="surfDelete"]');
    del.click(); await wait(30);
    ok('T7 deleting the last region leaves no empty surfaces array in the draft', sceneSurfaces().length === 0 && !('surfaces' in (S.lib.scenes[SID] || {})));
    el('btnSave').click(); await ioChain;
    disk = (await API.json('/api/placements')).doc;
    ok('T7 saved: the scene has no surfaces key on disk', !(disk.scenes[SID] && 'surfaces' in disk.scenes[SID]));
    setSurfEdit(false);
    ok('T8 turning the display off hides the surface vertices', !objects().some((o) => /^area:s\d+:/.test(o.key)));

    // ---- 没画区域的地方（全局缺省材质，所有场景一份）
    Inspector.open.surfaces = true; renderInspector(); await wait(30);
    const gsec = el('inspector').querySelector('.sec[data-sec="surfaces"]');
    ok('T9 the global default block is there, placeholders show the runtime defaults',
      !!gsec.querySelector('[data-role="surfDefault"]')
      && [...gsec.querySelectorAll('.row')].some((n) => n.firstElementChild && n.firstElementChild.textContent === '细节起伏'
        && n.querySelector('input').placeholder === String(SURFACE_DEFAULTS.ground.detail)));
    const drow = [...gsec.querySelectorAll('.row')].find((n) => n.firstElementChild && n.firstElementChild.textContent === '细节起伏').querySelector('input');
    drow.value = '1.5'; drow.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(PUBLISH_DEBOUNCE_MS + 150);
    const pv2 = previews[previews.length - 1];
    ok('T9 editing it writes the library top level and the preview carries it (no scene touched)',
      S.lib.defaultSurface && S.lib.defaultSurface.detail === 1.5 && changedPlacementLibrary().defaultSurface.detail === 1.5
      && Object.keys(changedPlacementLibrary().scenes).length === 0
      && !!pv2 && pv2.placements.library.defaultSurface && pv2.placements.library.defaultSurface.detail === 1.5,
      { lib: S.lib.defaultSurface, pv: pv2 && pv2.placements.library });
    el('btnSave').click(); await ioChain;
    let disk2 = (await API.json('/api/placements')).doc;
    ok('T9 saved at the library top level, nothing dirty', disk2.defaultSurface && disk2.defaultSurface.detail === 1.5 && !S.dirty,
      { ds: disk2.defaultSurface });
    const drow2 = [...el('inspector').querySelector('.sec[data-sec="surfaces"]').querySelectorAll('.row')]
      .find((n) => n.firstElementChild && n.firstElementChild.textContent === '细节起伏').querySelector('input');
    drow2.value = ''; drow2.dispatchEvent(new Event('change', { bubbles: true })); await wait(30);
    el('btnSave').click(); await ioChain;
    disk2 = (await API.json('/api/placements')).doc;
    ok('T9 clearing the only field removes defaultSurface from disk (back to runtime defaults)', !('defaultSurface' in disk2) && !S.dirty);
  } catch (error) {
    log.push('EXC ' + (error.stack || error));
  } finally {
    window.fetch = originalFetch; S.link.on = false;
    window.__selftestResult = log.join('\n');
  }
})();
