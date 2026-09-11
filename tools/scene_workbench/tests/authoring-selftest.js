(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms)), results = [];
  const check = (ok, text) => { if (!ok) throw new Error(text); results.push('PASS ' + text); };
  const native = async action => {
    const n = window.__nativeAck || 0; (window.__nativeActions ||= []).push(action);
    for (let i = 0; i < 50 && (window.__nativeAck || 0) === n; i++) await sleep(100);
    check((window.__nativeAck || 0) > n, 'native ' + action.type); await sleep(150);
  };
  try {
    for (let i = 0; i < 150 && (!window.workbench?.workspace.scene || window.workbench.workspace.loading); i++) await sleep(200);
    const w = window.workbench.workspace, E = window.Legacy.Edit;
    await w.newAsset('trajectory', '__trajectory_authoring_probe__', 'world');
    const slot = w.slots.get(w.active), key = w.active;
    w.edit(key, 'QA physics', () => { E.deleteSegment(w.host(slot), 0); E.addSegment(w.host(slot), 'physics'); });
    w.edit(key, 'QA launch', d => { const s = d.source.segments[0]; s.gravity = 900; E.setV0(w.host(slot), s, {x:120, y:450, z:80}); });
    await w.bake(key); w.tool = 'select'; w.view = '3d'; w.notify(); await sleep(650);
    const apex = w.marks().find(m => m.slot === key && m.type === 'apex');
    check(apex?.world, 'original physics apex handle in shared 3D canvas');
    const before = JSON.stringify(slot.doc), beforeInfo = E.physicsInfo(w.host(slot), slot.doc.source.segments[0]);
    const p = window.workbench.viewport3D.project(apex.world);
    await native({type:'drag', x:p[0], y:p[1], dx:0, dy:-30});
    const afterInfo = E.physicsInfo(w.host(slot), slot.doc.source.segments[0]);
    check(afterInfo.apexW[1] > beforeInfo.apexW[1] + 10, 'native apex drag edits original v0 solver');
    slot.history.undo(); check(JSON.stringify(slot.doc) === before, 'physics drag is one exact undo');
    w.transformTrajectory('all', 0, 'translate', 60, 30);
    check(JSON.stringify(slot.doc) !== before, 'whole path transform calls original Edit');
    slot.history.undo(); check(JSON.stringify(slot.doc) === before, 'whole path transform undo preserves physics');
    w.edit(key, 'QA manual path', () => { E.deleteSegment(w.host(slot), 0); E.addSegment(w.host(slot), 'manual'); });
    const [cx, cy] = w.center; w.addPoint([cx + 100, cy + 30]); w.addPoint([cx + 160, cy + 60]);
    await w.bake(key); w.tool = 'select';
    const points = w.marks().filter(m => m.slot === key && m.type === 'point');
    check(points.length >= 3, 'manual path uses original appendPoint and baker');
    w.select(points[1]); w.select(points[2], true); const docBefore = JSON.stringify(slot.doc);
    w.transformTrajectory('points', 0, 'translate', 25, 10);
    check(JSON.stringify(slot.doc) !== docBefore, 'multiple selected points transformed');
    slot.history.undo(); check(JSON.stringify(slot.doc) === docBefore, 'multiple point transform is one undo');
    await w.bake(key); await sleep(200);
    const play = [...document.querySelectorAll('.timeline button')].find(b => b.textContent === '播放'), r = play.getBoundingClientRect();
    const clean = JSON.stringify(slot.doc);
    await native({type:'click', x:r.left + r.width/2, y:r.top + r.height/2}); await sleep(300);
    check(w.playhead > 50 && w.playing, 'native timeline playback advances');
    w.playing = false; w.playhead = Math.min(500, slot.bake.totalMs / 2); w.notify();
    check(JSON.stringify(slot.doc) === clean, 'timeline does not alter authored document');
    check(window.workbench.viewport3D.audit().ok, 'trajectory remains aligned with runtime camera');
    window.__selftestResult = results.join('\n') + '\nPASS unsaved drafts only';
  } catch (e) { window.__selftestResult = results.join('\n') + '\nFAIL ' + e.stack; }
})();
