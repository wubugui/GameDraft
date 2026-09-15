/* New module controls through real DOM events and HTTP, using only a unique temporary effect. */
(async () => {
  const log = [], wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const ok = (name, value) => log.push(`${value ? 'PASS' : 'FAIL'} ${name}`);
  const id = 'zz_selftest_pipeline_' + Date.now();
  let created = false;
  const row = (sec, label) => [...el('inspector').querySelectorAll(`[data-sec="${sec}"] .row`)].find(n => n.firstElementChild?.textContent === label);
  async function change(sec, label, value, selector = 'select') {
    const n = row(sec, label)?.querySelector(selector);
    if (!n || n.disabled) throw new Error(`Missing or disabled ${sec}/${label}`);
    if (n.type === 'checkbox') n.checked = value; else n.value = String(value);
    n.dispatchEvent(new Event('change', { bubbles: true }));
    n.blur(); await wait(30);
  }
  try {
    while (!window.__ready) await wait(50);
    S.link.on = false;
    const boot = await API.json('/api/boot');
    if (boot.placements.real !== false) throw new Error('Selftest placement isolation missing');
    const paper = (await API.json('/api/effect?id=paper_money')).doc;
    const seed = structuredClone(paper); seed.id = id;
    seed.emitters[0].futureProperty = { values: [3, 1, 2] };
    await API.post('/api/save', { doc: seed }); created = true;
    await refreshEffects(); await openEffect(id, { force: true, jump: true });
    select(`emitter:${S.doc.emitters[0].id}`);
    const before = canonJson(S.doc);
    for (const key of ['simulation', 'plate', 'collision', 'motion']) {
      const sec = el('inspector').querySelector(`[data-sec="${key}"]`);
      if (sec && !sec.querySelector('input,select,button')) { sec.firstElementChild.click(); await wait(20); }
    }
    ok('Opening all module controls does not materialize configuration or mark dirty', !S.dirty && canonJson(S.doc) === before && !S.doc.emitters[0].simulation);
    ok('Legacy surface paper shows rest birth and disabled old launch velocity', row('simulation', '出生速度').querySelector('select').value === 'rest' && row('spawn', '初速').querySelector('input').disabled);
    ok('Inactive gravity, private force and collision controls explain non-use', row('motion', '重力').querySelector('input').disabled
      && row('motion', '恒定风').querySelector('input').disabled
      && [...el('inspector').querySelectorAll('[data-sec="collision"] input,[data-sec="collision"] button')].every(n => n.disabled));
    ok('Automatic replacement height is not presented as a fake fixed height', row('simulation', '高度方式').querySelector('select').value === 'auto' && !row('simulation', '补回高度'));
    await change('simulation', '无区域时半径', 37, 'input');
    ok('Unplaced surface radius edits the actual shared emission sampler', S.sim.emitters[0].area.disc.r === 37);
    el('btnUndo').click(); await wait(30);
    ok('Undo radius restores the legacy document without materializing defaults', canonJson(S.doc) === before);
    await change('simulation', '出生速度', 'configured');
    ok('Surface birth can use configured speed', !row('spawn', '初速').querySelector('input').disabled && S.doc.emitters[0].simulation.spawnPlacement === 'surface');
    await change('simulation', '局部气流（空气速度）', true, 'input');
    await change('simulation', '标签刺激响应', true, 'input');
    ok('Enabling label response enables its parameter controls', !el('inspector').querySelector('[data-role="stimulus-controls"] input').disabled);
    await change('simulation', '高度方式', 'custom');
    const height = row('simulation', '补回高度').querySelectorAll('input')[1];
    height.scrollIntoView(); height.focus(); height.select();
    if (!document.execCommand('insertText', false, '91') || height.value !== '91') throw new Error('Unable to enter replacement height through the browser editing command');
    el('btnSave').click(); await ioChain; await wait(60);
    let saved = (await API.json(`/api/effect?id=${id}`)).doc;
    ok('Save commits a still-focused replacement height before writing', saved.emitters[0].simulation.recycle.height[1] === 91 && !S.dirty);
    ok('Save preserves inactive motion values and unknown fields', saved.emitters[0].motion.gravity === paper.emitters[0].motion.gravity
      && canonJson(saved.emitters[0].futureProperty) === canonJson(seed.emitters[0].futureProperty));
    el('btnUndo').click(); await wait(30);
    ok('Undo after save restores the previous height and marks dirty', S.doc.emitters[0].simulation.recycle.height[1] === 50 && S.dirty);
    el('btnRedo').click(); await wait(30);
    ok('Redo restores the exact saved document', canonJson(S.doc) === canonJson(saved));
    await change('simulation', '运动模型', 'particle');
    ok('Switching model retains dormant plate data and enables ordinary forces', !!S.doc.emitters[0].plate
      && !row('motion', '重力').querySelector('input').disabled && row('plate', '尺寸').querySelector('input').disabled);
    el('btnUndo').click(); await wait(30);
    ok('Undo model switch restores execution options and physical parameters', canonJson(S.doc) === canonJson(saved));
    await change('simulation', '高度方式', 'auto');
    el('btnSave').click(); await ioChain;
    await openEffect(id, { force: true, jump: true });
    ok('Reload preserves absence of automatic height and enabled inputs', !S.doc.emitters[0].simulation.recycle.height && S.doc.emitters[0].simulation.influences.airflow);
    ok('Workbench runs the shared field geometry simulator without errors', S.space?.kind === 'field' && !!S.sim && !S.simErr);
    // A second writer modifies the same effect while this editor has an unsaved module edit.
    const diskBase = (await API.json(`/api/effect?id=${id}`)).doc;
    await change('simulation', '出生速度', 'rest');
    const pendingDoc = canonJson(S.doc);
    const external = { ...diskBase, label: 'external version', futureExternal: [4, 2] };
    await API.post('/api/save', { doc: external });
    el('btnSave').click(); await ioChain;
    ok('External effect conflict preserves both disk data and unsaved controls', S.docDirty
      && canonJson(S.doc) === pendingDoc && /外部修改/.test(el('status').textContent)
      && canonJson((await API.json(`/api/effect?id=${id}`)).doc) === canonJson(external));
    await openEffect(id, { force: true, keepScene: true });
    const sid = Object.keys(S.lib.scenes).find(s => S.lib.scenes[s].base?.length);
    if (!sid) throw new Error('No isolated placement scope for conflict check');
    const localRows = structuredClone(S.lib.scenes[sid].base), otherRows = structuredClone(localRows);
    localRows[0].anchor.x += 1; otherRows[0].anchor.x += 2;
    edit('自检布置冲突', () => { S.lib.scenes[sid].base = localRows; });
    await API.post('/api/placements/save', { changes: { scenes: { [sid]: { base: otherRows } } } });
    el('btnSave').click(); await ioChain;
    ok('Same-scope conflict keeps unsaved placement and the external placement', S.libDirty
      && canonJson(S.lib.scenes[sid].base) === canonJson(localRows) && /外部修改/.test(el('status').textContent)
      && canonJson((await API.json('/api/placements')).doc.scenes[sid].base) === canonJson(otherRows));
  } catch (error) { log.push('EXC ' + (error.stack || error)); }
  finally {
    S.link.on = false;
    if (created) try { await API.post('/api/delete', { id, withPlacements: true }); } catch (e) { log.push('EXC Cleanup: ' + e); }
    window.__selftestResult = log.join('\n');
  }
})();
