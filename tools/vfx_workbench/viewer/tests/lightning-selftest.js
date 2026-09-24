/* 粒子工作台 · 雷电样式那一节的端到端回归（真页面；`python -m tools.vfx_workbench --selftest <本文件>`）。
 *
 * 自检进程把样式库指到临时拷贝（app.py）；这里只建 `zz_selftest_lightning_*` 效果、收尾删掉。
 * 钉住的事：渲染不写东西；现画预览真的画出了雷（两块画布上有亮像素）；改参数只脏样式库（不脏效果）、进撤销栈；
 * 换样式进待换清单；效果没存就拒绝套用；套用 = 存库 + 把 bolts 与样式那几层写进效果 + 落盘 + 页面重开那份
 * （不烘任何贴图）；样式那几层在发射器检视器里锁住贴图与宽度；「同步给同组」把样式以外的层抄过去。 */
(async () => {
  const log = [], wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const ok = (name, value, extra) => log.push(`${value ? 'PASS' : 'FAIL'} ${name}${extra !== undefined ? ' ' + JSON.stringify(extra) : ''}`);
  const stamp = Date.now();
  const id = 'zz_selftest_lightning_' + stamp, id2 = id + '_b', group = 'zz_selftest_group_' + stamp;
  const made = [];
  const sec = () => el('inspector').querySelector('.sec[data-sec="lightning"]');
  const rowOf = (label) => [...(sec() ? sec().querySelectorAll('.row') : [])].find((n) => n.firstElementChild && n.firstElementChild.textContent === label);
  const styleOf = (sid) => S.ls.lib.styles.find((s) => s.id === sid);
  try {
    while (!window.__ready) await wait(50);
    S.link.on = false;
    ok('L1 style library loaded with the built-in drawn-bolt presets, nothing dirty',
      S.ls.loaded && !S.ls.err && ['ref_bolt', 'ref_bolt_straight', 'ref_bolt_branchy'].every((x) => styleOf(x)) && !S.lsDirty
      && S.ls.lib.styles.every((s) => s.kind === 'bolt'),
      { err: S.ls.err, ids: S.ls.lib && S.ls.lib.styles.map((s) => s.id) });
    const author = { id: 'impact_sparks', appearance: { image: '/resources/runtime/images/vfx/spark.png', sizeWu: 3, blend: 'add', lit: false }, spawn: { max: 5, burst: 4 } };
    const doc = { id, emitters: [author], generator: { kind: 'lightning', style: 'ref_bolt_straight', seed: 11, group } };
    await API.post('/api/save', { doc }); made.push(id);
    await API.post('/api/save', { doc: { id: id2, emitters: [], generator: { kind: 'lightning', style: 'ref_bolt_straight', seed: 12, group } } }); made.push(id2);
    await refreshEffects();
    await openEffect(id, { force: true, keepScene: true }); await wait(120);
    ok('L2 a generator effect shows the 雷电样式 section, picker on its style', !!sec() && sec().querySelector('select').value === 'ref_bolt_straight');
    ok('L2 rendering the section writes nothing (effect and library clean)', !S.dirty && !S.lsDirty, { dirty: S.dirty, ls: S.lsDirty });
    ok('L2 a generator effect does not also show the folded 「没用」 section', !el('inspector').querySelector('.sec[data-sec="lightningOff"]'));
    ok('L2 the impact knobs (blast wind / ignite radius) are in the style section', !!rowOf('冲击风多猛') && !!rowOf('点火半径'));

    // ---- 现画预览：拼出来、真的画出了雷（不是空画布）
    const pv = LightningPanel.player;
    for (let k = 0; k < 60 && !(pv && pv.composed); k++) await wait(50);
    let lit = 0;
    if (pv && pv.composed && pv.canvas) {
      // 从劈下那一刻重播、当场画一帧（无头壳里 rAF 不一定跑，直接调 draw）
      pv.replay(false); pv.t0 = performance.now() - 30; pv.draw();
      const c2 = document.createElement('canvas'); c2.width = pv.canvas.width; c2.height = pv.canvas.height;
      const g = c2.getContext('2d'); g.drawImage(pv.canvas, 0, 0);
      const px = g.getImageData(0, 0, c2.width, c2.height).data;
      for (let i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] > 600) lit++;
    }
    ok('L2 the drawn preview composed and shows a bright bolt', !!(pv && pv.composed) && lit > 20, { composed: !!(pv && pv.composed), lit, err: pv && pv.err, perr: LightningPanel.previewErr });

    // ---- 改参数：只脏样式库、进撤销栈、撤销回来
    const inp = rowOf('分叉多密') && rowOf('分叉多密').querySelector('input');
    if (!inp) throw new Error('no 分叉多密 row');
    const before = styleOf('ref_bolt_straight').params.branchPerKWu;
    inp.value = String(before + 7); inp.dispatchEvent(new Event('change', { bubbles: true })); await wait(60);
    ok('L3 editing a style parameter changes the library draft only: 雷电样式 dirty, effect not, one history entry',
      styleOf('ref_bolt_straight').params.branchPerKWu === before + 7 && S.lsDirty && !S.docDirty && /分叉多密/.test(history.peekUndo()),
      { v: styleOf('ref_bolt_straight').params.branchPerKWu, ls: S.lsDirty, doc: S.docDirty, undo: history.peekUndo() });
    ok('L3 the changed row is marked against the saved library', rowOf('分叉多密') && rowOf('分叉多密').dataset.changed === 'true');
    ok('L3 the status line says the style is not applied yet', /雷电样式 ●未套用/.test(el('docState').textContent));
    doUndo(); await wait(60);
    ok('L3 Ctrl+Z reverts the parameter and clears the mark', styleOf('ref_bolt_straight').params.branchPerKWu === before && !S.lsDirty);

    // ---- 换样式：进待换清单（同组两份一起换）
    const pick = sec().querySelector('select');
    pick.value = 'ref_bolt'; pick.dispatchEvent(new Event('change', { bubbles: true })); await wait(60);
    ok('L4 switching the style queues the whole group', S.ls.assign[id] === 'ref_bolt' && S.ls.assign[id2] === 'ref_bolt' && S.lsDirty && !S.docDirty,
      { assign: S.ls.assign });
    ok('L4 the apply button counts both effects', /2 个效果/.test(sec().querySelector('[data-role="lightning-apply"]').textContent));

    // ---- 效果有没存的改动：拒绝套用（套用要重写这份文件）
    host.edit('改标签', () => { S.doc.label = '没存的改动'; }); await wait(30);
    await applyLightning(); await wait(30);
    ok('L5 apply refuses while the effect has unsaved edits, the queued switch survives',
      S.ls.assign[id] === 'ref_bolt' && /先 Ctrl\+S/.test(el('status').textContent), { status: el('status').textContent });
    doUndo(); await wait(30);
    ok('L5 undoing the label edit keeps the queued style switch', !S.docDirty && S.ls.assign[id] === 'ref_bolt');

    // ---- 套用：bolts 与样式那几层写进效果，不烘贴图
    await applyLightning(); await wait(150);
    const disk = (await API.json(`/api/effect?id=${encodeURIComponent(id)}`)).doc;
    ok('L6 apply wrote the drawn bolt: style switched, bolts sky/ground/water, style layers first, the author layer kept',
      disk.generator.style === 'ref_bolt' && !!disk.generator.built
      && (disk.bolts || []).map((b) => b.id).join() === 'sky,ground,water'
      && disk.emitters.map((e) => e.id).join() === 'bolt,bolt_stroke,ground_arcs,water_arcs,impact_sparks'
      && disk.emitters.slice(0, 4).every((e) => e.appearance.bolt && !e.appearance.animFile && !e.appearance.image),
      { gen: disk.generator, ids: disk.emitters.map((e) => e.id), bolts: (disk.bolts || []).map((b) => b.id) });
    ok('L6 the sky bolt carries its lights and the landing impact', !!disk.bolts[0].light && !!disk.bolts[0].impact && disk.bolts[0].impact.igniteRadiusWu > 0);
    ok('L6 the page reopened the saved effect: nothing dirty, state line says up to date',
      !S.dirty && !S.lsDirty && canonJson(S.doc) === canonJson(disk) && /按现在的样式套用/.test((document.querySelector('[data-role="lightning-state"]') || {}).textContent || ''),
      { state: (document.querySelector('[data-role="lightning-state"]') || {}).textContent, status: el('status').textContent });

    // ---- 样式那几层：发射器检视器里贴图 / 宽度锁住，曲线照常可调
    select('emitter:bolt'); await wait(80);
    const apRow = (label) => [...el('inspector').querySelectorAll('.sec[data-sec="appearance"] .row')].find((n) => n.firstElementChild && n.firstElementChild.textContent === label);
    const w = apRow('宽度');
    ok('L7 a style layer locks 宽度 in the emitter inspector and says why',
      !!w && w.querySelector('input').disabled && !!el('inspector').querySelector('[data-role="lightning-owned"]'));
    select('emitter:impact_sparks'); await wait(80);
    ok('L7 an author layer of the same effect is not locked', !apRow('宽度').querySelector('input').disabled);

    // ---- 同步给同组：样式以外的层抄过去，那份自己的样式层（种子）不动
    const syncBtn = sec().querySelector('[data-role="lightning-sync-group"]');
    ok('L8 the group sync button is there and enabled for a saved effect', !!syncBtn && !syncBtn.disabled);
    await syncLightningGroup(); await wait(120);
    const other = (await API.json(`/api/effect?id=${encodeURIComponent(id2)}`)).doc;
    ok('L8 syncing copied the author layer to the other effect of the group and kept its own bolt seed',
      other.emitters.map((e) => e.id).join() === 'bolt,bolt_stroke,ground_arcs,water_arcs,impact_sparks' && other.bolts[0].seed === 12,
      { ids: other.emitters.map((e) => e.id), seed: other.bolts && other.bolts[0].seed });
  } catch (error) { log.push('EXC ' + (error.stack || error)); }
  finally {
    S.link.on = false;
    for (const x of made) try { await API.post('/api/delete', { id: x, withPlacements: true }); } catch (e) { log.push('EXC cleanup: ' + e); }
    window.__selftestResult = log.join('\n');
  }
})();
