(async () => {
  const lines = [];
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const check = (condition, name) => { if (!condition) throw new Error(name); lines.push('PASS ' + name); };
  const native = async action => {
    const before = window.__nativeAck || 0;
    (window.__nativeActions ||= []).push(action);
    for (let i = 0; i < 100 && (window.__nativeAck || 0) === before; i++) await sleep(40);
    check((window.__nativeAck || 0) > before, 'native ' + action.type);
  };
  // 先滚进视野:WebView2 宿主按系统文字缩放算 devicePixelRatio(本机 1.24),同样大的窗口 CSS 空间更小,
  // 列表里靠下的按钮可能在滚动区外,真鼠标点在它的矩形中心会点到盖在上面的别的面板
  const center = element => { element.scrollIntoView({ block: 'center' }); const r = element.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
  try {
    for (let i = 0; i < 100 && (!window.workbench?.workspace.scene || window.workbench.workspace.loading); i++) await sleep(200);
    const w = window.workbench.workspace;
    check(w.scene && w.cal && w.image, '真实场景、背景和深度加载');
    check(w.dirtySlots.length === 0, '打开不产生脏数据');
    // 宿主是 WebView2(tools/qt_webgpu):宿主执行脚本(ExecuteScript——本自检与宿主的轮询都这么进来)本身算一次用户激活,
    // 还会传给同源子框架,顶层文档的 hasBeenActive 恒为 true。改在一个 data: 的 iframe(不透明源,激活传不进去)里验
    // "没有手势也能出声",结果 postMessage 回来
    const quiet = await new Promise(resolve => {
      const frame = document.createElement('iframe'); frame.style.display = 'none';
      const onMessage = e => { if (e.source === frame.contentWindow) { removeEventListener('message', onMessage); frame.remove(); resolve(e.data); } };
      addEventListener('message', onMessage);
      frame.src = 'data:text/html,' + encodeURIComponent('<script>(async () => { const active = navigator.userActivation.hasBeenActive;'
        + ' const a = new AudioContext(); await a.resume(); const state = a.state; await a.close();'
        + ' parent.postMessage({ active, state }, "*"); })();<\/script>');
      document.body.append(frame);
      setTimeout(() => resolve({ active: null, state: 'timeout' }), 5000);
    });
    check(quiet.active === false, '音频验证前没有任何用户手势');
    check(quiet.state === 'running', '无点击手势音频上下文运行');
    const width = document.querySelector('canvas').getBoundingClientRect().width;
    check(width > 400, '二维画布实际布局宽度');
    const entity = w.marks().find(m => m.type === 'entity');
    check(entity, '原有场景对象显示');
    const s = w.slots.get(entity.slot), original = JSON.stringify(s.doc);
    w.edit(entity.slot, 'QA移动', () => w.move(entity, [entity.screen[0] + 20, entity.screen[1] + 10]));
    check(w.dirty(s), '编辑即时标脏');
    s.history.undo(); check(JSON.stringify(s.doc) === original && !w.dirty(s), '撤销完整还原未知字段及脏态');
    s.history.redo(); check(w.dirty(s), '重做恢复编辑');
    w.discard(entity.slot); check(!w.dirty(s), '放弃修改不复活');
    await sleep(150);
    const spawnButton = [...document.querySelectorAll('.object-list button')].find(b => b.textContent === '默认出生点');
    await native({ type: 'click', ...center(spawnButton) });
    check(w.selection?.label === '默认出生点', '实际点击对象树选择');
    const input = document.querySelector('input[aria-label="画面 X"]');
    check(input, '选中对象出现坐标表单');
    await native({ type: 'input', ...center(input), text: '432.5' });
    check(w.currentScene.doc.spawnPoint.x === 432.5, '实际键盘编辑经表单写回');
    await native({ type: 'input', ...center(input), text: '999', finishKey: 'Escape' });
    check(w.currentScene.doc.spawnPoint.x === 432.5, 'Escape 放弃属性框输入而不写入草稿');
    const c = document.querySelector('canvas'), rect = c.getBoundingClientRect();
    const zoom = Math.min(rect.width / w.scene.worldWidth, rect.height / w.scene.worldHeight) * 0.92;
    const spawn = w.currentScene.doc.spawnPoint;
    const beforeX = spawn.x;
    await native({ type: 'drag', x: rect.x + (rect.width - w.scene.worldWidth * zoom) / 2 + spawn.x * zoom,
      y: rect.y + (rect.height - w.scene.worldHeight * zoom) / 2 + spawn.y * zoom, dx: 40, dy: -20 });
    check(w.currentScene.doc.spawnPoint.x > beforeX + 20, '实际鼠标拖拽经画布写回');
    await native({ type: 'click', ...center(document.querySelector('button[aria-label="撤销"]')) });
    check(w.currentScene.doc.spawnPoint.x === 432.5, '一次撤销还原整次拖拽');
    w.discard(entity.slot);
    await w.addLight(); check(w.marks().some(m => m.type === 'light') && w.dirty(s), '新灯使用原厂默认值并放在视口中');
    w.discard(entity.slot);
    await w.newAsset('trajectory', '__workbench_ui_probe__', 'screen');
    const k = w.active, trajectory = w.slots.get(k);
    w.addPoint([w.center[0] + 150, w.center[1] + 80]);
    await w.bake(k); check(trajectory.bake?.keyframes?.length >= 2, '轨迹经过旧烘焙器生成有效帧');
    check(trajectory.bake.preview.screen.every(p => p.length >= 8), '旧预览帧格式保持一致');
    const originalScene = w.sceneId;
    await w.openScene(originalScene, w.background);
    check(w.slots.has(k) && w.dirty(trajectory), '切换场景保留未保存文档');
    w.discard(k);
    await w.newAsset('acoustic', '__workbench_acoustic_probe__');
    const ak = w.active; w.addReflector();
    check(w.slots.get(ak).doc.reflectors.length === 1, '旧声学默认定义与新增反射面');
    w.view = '3d'; w.notify(); await sleep(1200);
    const c3 = document.querySelector('.three-host canvas');
    check(c3 && c3.width > 400, '三维几何与反射面实际渲染');
    w.discard(ak); w.active = 'scene:' + w.sceneId; w.layer = 'scene'; w.view = '2d'; w.notify(); await sleep(300);
    check(w.dirtySlots.length === 0, '验证没有留下任何待保存文档');
    const marks = w.marks(); w.select(marks.find(m => m.type === 'entity')); await sleep(150);
    lines.push('PASS all edits stayed in memory; no production save requests');
    window.__selftestResult = lines.join('\n');
  } catch (e) { window.__selftestResult = lines.join('\n') + '\nFAIL ' + e.stack; }
})();
