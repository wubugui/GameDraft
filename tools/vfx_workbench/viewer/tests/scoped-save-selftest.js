/* Real workbench controls + HTTP save, with the desktop selftest's temporary placement library. */
(async () => {
  const log = [];
  const ok = (name, condition) => log.push(`${condition ? 'PASS' : 'FAIL'} ${name}`);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const originalFetch = window.fetch, originalPost = API.post;
  try {
    while (!window.__ready) await wait(50);
    const boot = await API.json('/api/boot');
    if (boot.placements.real !== false) throw new Error('Refuse to write a real placement library');
    S.link.on = false;
    await openEffect('paper_money', { force: true, jump: true });
    await loadScene('跑马梁', '');
    const untouched = JSON.parse(JSON.stringify(S.lib.scenes.teahouse));
    if (!untouched || !activePlacement()) throw new Error('Missing teahouse / hill fixture');
    ok('Opening hill without editing produces no placement submission', Object.keys(changedPlacementLibrary().scenes).length === 0);
    // Another author changes the unopened room after this window loaded its library.
    untouched.base.find((r) => r.effect === 'teahouse_haze').anchor.h = 987;
    await API.post('/api/placements/save', { changes: { scenes: { teahouse: untouched } } });
    const submitted = [], previews = [];
    API.post = async (url, body) => { if (url === '/api/placements/save') submitted.push(body); return originalPost(url, body); };
    window.fetch = (url, options) => {
      if (url === '/api/link/publish') {
        previews.push(JSON.parse(options.body));
        return Promise.resolve(new Response(JSON.stringify({ ok: true, rev: previews.length, connected: true }), { status: 200 }));
      }
      return originalFetch(url, options);
    };
    S.link.on = true;
    const section = el('inspector').querySelector('[data-sec="placement"]');
    if (!section) throw new Error('Missing placement inspector');
    if (!section.querySelector('input')) section.firstElementChild.click();
    const row = [...section.querySelectorAll('.row')].find((r) => r.firstChild.textContent === 'x');
    const input = row && row.querySelector('input');
    if (!input) throw new Error('Missing placement X input');
    const originalX = activePlacement().anchor.x;
    input.value = String(originalX + 1);
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(PUBLISH_DEBOUNCE_MS + 150);
    const preview = previews[previews.length - 1];
    ok('Editing hill publishes only hill base, never unopened teahouse', preview && preview.placements.mode === 'scoped'
      && Object.keys(preview.placements.library.scenes).join() === '跑马梁'
      && Object.keys(preview.placements.library.scenes['跑马梁']).join() === 'base');
    el('btnSave').click();
    await ioChain;
    const disk = (await API.json('/api/placements')).doc;
    ok('Save button sends only modified hill scope', submitted.length === 1
      && !submitted[0].doc && Object.keys(submitted[0].changes.scenes).join() === '跑马梁');
    ok('Unopened teahouse keeps external author changes after hill save', canonJson(disk.scenes.teahouse) === canonJson(untouched));
    ok('Successful save clears dirty and preview edit scopes', !S.dirty && Object.keys(changedPlacementLibrary().scenes).length === 0);
    el('btnUndo').click();
    ok('Undo after save only dirties hill, never imports the stale teahouse into edits',
      Object.keys(changedPlacementLibrary().scenes).join() === '跑马梁' && activePlacement().anchor.x === originalX);
    el('btnSave').click();
    await ioChain;
    ok('Saving undo preserves unopened teahouse again', canonJson((await API.json('/api/placements')).doc.scenes.teahouse) === canonJson(untouched));
  } catch (error) {
    log.push('EXC ' + (error.stack || error));
  } finally {
    window.fetch = originalFetch; API.post = originalPost;
    S.link.on = false;
    window.__selftestResult = log.join('\n');
  }
})();
