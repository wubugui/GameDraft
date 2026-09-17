/* Real inspector edits, undo, save and reopen; only a disposable effect is written. */
(async () => {
  const log = [], wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const ok = (name, value) => log.push(`${value ? 'PASS' : 'FAIL'} ${name}`);
  const id = 'zz_selftest_timing_' + Date.now(); let created = false;
  function row(sec, label) {
    const section = el('inspector').querySelector(`[data-sec="${sec}"]`);
    if (!section?.querySelector('input')) section?.firstElementChild.click();
    return [...section.querySelectorAll('.row')].find(n => n.firstElementChild?.textContent === label);
  }
  async function change(sec, label, value, index = 0) {
    const n = row(sec, label)?.querySelectorAll('input')[index];
    if (!n || n.disabled) throw new Error(`Missing ${sec}/${label}`);
    if (n.type === 'checkbox') n.checked = value; else n.value = String(value);
    n.dispatchEvent(new Event('change', { bubbles: true })); await wait(30);
  }
  try {
    while (!window.__ready) await wait(50);
    S.link.on = false;
    const doc = { id, future: { keep: [3, 1] }, emitters: [{ id: 'smoke',
      appearance: { image: '/resources/runtime/images/vfx/smoke_puff.png', sizeWu: 10 },
      spawn: { max: 64, rate: 4, burst: 3 }, life: { seconds: [5, 7] } }] };
    await API.post('/api/save', { doc }); created = true;
    await openEffect(id, { force: true, keepScene: true }); await wait(50);
    const clean = canonJson(S.doc);
    row('timing', '随机预热');
    ok('Opening timing controls does not materialize fields or mark dirty', !S.dirty && canonJson(S.doc) === clean);
    await change('timing', '随机预热', true);
    await change('timing', '预热时长', 2);
    await change('timing', '预热时长', 6, 1);
    await change('spawn', '间隔浮动', 0.4);
    ok('Inspector edits actual simulation inputs', canonJson(S.doc.prewarmSeconds) === '[2,6]' && S.sim.effect.prewarmSeconds[1] === 6
      && S.sim.emitters[0].def.spawn.intervalJitter === 0.4);
    S.sim.step(1 / 120, { fields: [], player: null, time: 0 });
    ok('Workbench shared simulator begins at a warmed progress', S.sim.time >= 2 && S.sim.time <= 6.02 && S.sim.liveCount > 0);
    el('btnSave').click(); await ioChain;
    let saved = (await API.json(`/api/effect?id=${id}`)).doc;
    ok('Save retains both timing fields and unrelated properties', !S.dirty && saved.prewarmSeconds[1] === 6
      && saved.emitters[0].spawn.intervalJitter === 0.4 && canonJson(saved.future) === canonJson(doc.future));
    el('btnUndo').click(); await wait(30);
    ok('Undo after save removes only the last timing edit', S.dirty && S.doc.emitters[0].spawn.intervalJitter === undefined && S.doc.prewarmSeconds[1] === 6);
    el('btnRedo').click(); await wait(30);
    ok('Redo returns to the exact saved state', !S.dirty && canonJson(S.doc) === canonJson(saved));
    await openEffect(id, { force: true, keepScene: true }); await wait(40);
    ok('Reopen shows saved timing values', row('timing', '预热时长').querySelectorAll('input')[1].value === '6'
      && row('spawn', '间隔浮动').querySelector('input').value === '0.4');
    await change('timing', '随机预热', false);
    await change('spawn', '间隔浮动', '');
    el('btnSave').click(); await ioChain;
    saved = (await API.json(`/api/effect?id=${id}`)).doc;
    ok('Disabling and clearing saves the original default behavior', saved.prewarmSeconds === undefined && saved.emitters[0].spawn.intervalJitter === undefined);
  } catch (error) { log.push('EXC ' + (error.stack || error)); }
  finally {
    S.link.on = false;
    if (created) try { await API.post('/api/delete', { id, withPlacements: true }); } catch (e) { log.push('EXC Cleanup: ' + e); }
    window.__selftestResult = log.join('\n');
  }
})();
