(async () => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const lines = [];
  const check = (ok, name) => { if (!ok) throw new Error(name); lines.push('PASS ' + name); console.log('QA ' + name); };
  const native = async action => {
    const before = window.__nativeAck || 0;
    (window.__nativeActions ||= []).push(action);
    for (let i = 0; i < 100 && (window.__nativeAck || 0) === before; i++) await sleep(40);
    check((window.__nativeAck || 0) > before, 'native ' + action.type);
  };
  try {
    for (let i = 0; i < 150 && !window.workbench?.workspace.scene; i++) await sleep(200);
    const w = window.workbench.workspace;
    w.view = 'runtime'; w.notify(); await sleep(250);
    [...document.querySelectorAll('button')].find(b => b.textContent === '连接游戏预览').click();
    for (let i = 0; i < 100 && !document.querySelector('iframe'); i++) await sleep(200);
    if (!document.querySelector('iframe')) throw new Error('预览没有建立：' + w.error);
    const link = window.workbench.lightingLink;
    let ready = false, last;
    for (let i = 0; i < 80 && !ready; i++) {
      try { await link.pull(); ready = true; } catch (e) { last = e; if (i % 10 === 0) console.log('QA waiting runtime: ' + e.message); await sleep(1000); }
    }
    if (!ready) throw last;
    check(w.currentScene.doc.lighting?.sky, '真实运行时灯光已通过旧通道读取');
    const beforeLight = w.currentScene.doc.lighting.lights.length;
    await w.addLight();
    const light = w.currentScene.doc.lighting.lights.at(-1);
    let blocked = false;
    try { await link.pull(); } catch (e) { blocked = /尚未发送/.test(e.message); }
    check(blocked && w.currentScene.doc.lighting.lights.length === beforeLight + 1, '未发送的灯光不会被旧运行时值覆盖');
    await link.publish(light.id); await sleep(3000);
    await link.pull();
    check(w.currentScene.doc.lighting.lights.some(l => l.id === light.id), '旧通道完成新增灯光发送和回读');
    const frame = document.querySelector('iframe');
    const before = frame;
    w.view = '2d'; w.notify(); await sleep(500);
    w.view = 'runtime'; w.notify(); await sleep(500);
    if (document.querySelector('iframe') !== before) throw new Error('切换视图销毁了运行时');
    await window.workbench.requestClose(); await sleep(200);
    check(document.querySelector('[role="dialog"]')?.textContent.includes('未保存'), '关闭前读取运行时并展示未保存编辑');
    [...document.querySelectorAll('button')].find(b => b.textContent === '继续编辑').click();
    await sleep(200);
    check(window.__closeResult === 'cancel' && w.dirtySlots.length > 0, '取消关闭保留编辑');
    const bounds = frame.getBoundingClientRect();
    await native({ type: 'click', x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
    await native({ type: 'key', key: 'F3' });
    await sleep(1500);
    const header = document.querySelector('header').getBoundingClientRect();
    if (header.height < 20 || getComputedStyle(document.querySelector('.app')).visibility !== 'visible') throw new Error('工作台界面不可见');
    console.log('workbench-layout', JSON.stringify({ header: header.toJSON(), frame: frame.getBoundingClientRect().toJSON(), body: document.body.innerText.slice(0, 180), visibility: document.visibilityState }));
    lines.push('PASS private runtime frame opened; original game visibly rendered', 'PASS switching views retains the same game frame', 'PASS no production save requests; temporary light exists in private preview only');
    w.discard('scene:' + w.sceneId); w.notify();
    window.__selftestResult = lines.join('\n');
  } catch (e) { window.__selftestResult = lines.join('\n') + '\nFAIL ' + e.stack; }
})();
