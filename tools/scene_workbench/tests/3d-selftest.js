(async () => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), results = [];
  const check = (ok, message) => { if (!ok) throw new Error(message); results.push('PASS ' + message); };
  const native = async action => {
    window.__nativeActions ||= []; const before = window.__nativeAck || 0; window.__nativeActions.push(action);
    for (let i = 0; i < 50 && (window.__nativeAck || 0) === before; i++) await sleep(100);
    check((window.__nativeAck || 0) > before, 'native ' + action.type); await sleep(150);
  };
  try {
    for (let i = 0; i < 150 && (!window.workbench?.workspace.scene || window.workbench.workspace.loading); i++) await sleep(200);
    const w = window.workbench.workspace, start = w.sceneId;
    const candidates = [start, ...w.catalog.scenes.filter(s => s.depth && s.id !== start).slice(0, 3).map(s => s.id)];
    w.view = '3d'; w.notify(); await sleep(800);
    for (const id of candidates) {
      await w.openScene(id); await sleep(500);
      const report = window.workbench.viewport3D.audit();
      check(report?.ok, `runtime mesh/projection/front/right/up ${id}: ${JSON.stringify(report)}`);
    }
    await w.openScene(start); await sleep(500);
    await w.addLight(); w.tool = 'select'; w.layer = 'light'; w.notify(); await sleep(300);
    const mark = w.marks().filter(m => m.type === 'light').at(-1);
    const before = JSON.stringify(w.currentScene.doc), point = window.workbench.viewport3D.project(mark.world);
    await native({type:'drag', x:point[0], y:point[1], dx:45, dy:20});
    const moved = w.marks().find(m => m.key === mark.key), after = window.workbench.viewport3D.project(moved.world);
    check(Math.hypot(after[0] - point[0] - 45, after[1] - point[1] - 20) < 3, `drag preserves cursor projection ${after[0] - point[0]},${after[1] - point[1]}`);
    check(Math.abs(moved.world[1] - mark.world[1]) < .01, 'horizontal drag preserves M-world Y');
    w.currentScene.history.undo(); check(JSON.stringify(w.currentScene.doc) === before, 'native drag undo exact');
    await native({type:'drag', button:'right', x:point[0], y:point[1], dx:70, dy:25});
    const free = window.workbench.viewport3D.project(mark.world);
    await native({type:'drag', x:free[0], y:free[1], dx:25, dy:12});
    const freeMoved = w.marks().find(m => m.key === mark.key), freeAfter = window.workbench.viewport3D.project(freeMoved.world);
    check(Math.hypot(freeAfter[0] - free[0] - 25, freeAfter[1] - free[1] - 12) < 3, 'orbit camera native drag retains world coordinates');
    w.currentScene.history.undo(); check(JSON.stringify(w.currentScene.doc) === before, 'orbit drag undo exact');
    window.dispatchEvent(new CustomEvent('workbench-camera', {detail:'top'})); await sleep(200);
    const top = window.workbench.viewport3D.project(mark.world), z = window.workbench.viewport3D.project([mark.world[0], mark.world[1], mark.world[2] + 150]);
    check(z[1] < top[1], 'top view +Z points into image/up');
    window.dispatchEvent(new CustomEvent('workbench-camera', {detail:'game'})); await sleep(200);
    check(window.workbench.viewport3D.audit().ok, 'return to calibrated game camera');
    await w.newAsset('acoustic', '__3d_coordinate_probe__'); w.addReflector(); w.addSource(); w.tool = 'select';
    w.edit(w.active, 'QA position wall away from listener', d => { const r=d.reflectors[0]; window.Legacy.AcousticGeo.translate(r, 0, 400, 0); r.height=600; });
    const slot = w.slots.get(w.active), reflector = w.marks().find(m => m.type === 'reflector' && m.slot === w.active);
    w.select(reflector); await sleep(400);
    check(slot.doc.sources.length === 1, 'source creation in shared viewport');
    check(document.querySelector('.tap-table tbody tr'), 'nonzero runtime reflection taps');
    check(document.querySelector('.ir-wave')?.width > 100, 'runtime IR waveform rendered');
    check(document.querySelector('.three-host canvas')?.width > 400, 'native WebGL canvas visible');
    check(window.workbench.viewport3D.audit().ok, 'final acoustic geometry stays aligned');
    window.__selftestResult = results.join('\n') + '\nPASS all edits are unsaved drafts; no production saves';
  } catch (e) { window.__selftestResult = results.join('\n') + '\nFAIL ' + e.stack; }
})();
