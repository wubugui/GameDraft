/* 粒子工作台 · 原画视图 GPU 画面的端到端回归（真页面；`python -m tools.vfx_workbench --selftest <本文件>`，或真 GPU 的 Chrome：
 * `tests/test_selftest.py` 经 `tools/workbench_rhi/chrome_page.mjs --selftest … --no-skip`）。
 *
 * 钉住的事：原画视图是游戏同一个 WebGPU 渲染器（engine2d / RHI）画的——背景 + 本地预览那一个运行时模拟交给游戏的 `VfxRenderer`
 * （粒子贴图 / 薄片 / 雷 / 光柱），页面没有自己的着色器、画布上没有 WebGL / 2D 上下文画粒子；标注层叠在上面、不吃鼠标、显隐跟着视图；
 * 图层「粒子」「场景压暗」「场景」开关在 GPU 画面上生效；换场景放掉旧背景纹理；装了原画深度（与游戏同一张图）；落雷在原画视图里画得出来。
 * 宿主拿不到 WebGPU（offscreen 的 QtWebEngine）时读 GPU 画面的那几条记 SKIP 并写明原因；真 GPU 的 Chrome 跑同一份脚本不许 SKIP。
 * 只读：不存任何东西（换效果 / 场景只在页面里）。 */
(async () => {
  const log = [], wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const ok = (name, cond, extra) => log.push((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + JSON.stringify(extra) : ''));
  const until = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 10000)) { try { if (fn()) return true; } catch (e) { /* 还没好 */ } await wait(40); } return false; };
  const okGpu = (name, cond, extra) => {
    if (!v2.gpu.ok) log.push(`SKIP ${name} ${JSON.stringify({ why: v2.gpu.err || 'no GPU layer' })}`);
    else { let v = false; try { v = typeof cond === 'function' ? cond() : cond; } catch (e) { log.push(`EXC ${name} ${e && e.stack || e}`); return; } ok(name, v, typeof extra === 'function' ? extra() : extra); }
  };
  const settle = async () => { await until(() => !v2.gpu.ok || v2.gpu.settled, 20000); draw(); };
  /** GPU 画面里一块 CSS 矩形与清屏色差得出来的像素数 / 亮度和（同一个任务里重画再读） */
  const region = (x, y, w, h) => {
    const px = v2.gpu.readRect(x, y, w, h);
    let n = 0, lum = 0;
    for (let i = 0; i < px.data.length; i += 4) {
      const r = px.data[i], g = px.data[i + 1], b = px.data[i + 2];
      lum += r + g + b;
      if (Math.abs(r - 0x11) + Math.abs(g - 0x13) + Math.abs(b - 0x18) > 6) n++;
    }
    return { n, lum };
  };
  try {
    while (!window.__ready) await wait(50);
    S.link.on = false;
    await until(() => v2.gpu.ok || !!v2.gpu.err, 30000);

    // ---- G1 画布是游戏的 WebGPU 渲染器；页面没有自己的着色器
    ok('G1 the page has no shader of its own: no beam / bolt WebGL layers, no GLSL namespaces in the runtime bundle',
      typeof BeamPreview === 'undefined' && !('vfxBeamGlsl' in S.rt) && !('vfxBoltGlsl' in S.rt) && !!S.rt.vfxView && !!S.rt.workbenchRhi,
      { ns: Object.keys(S.rt || {}) });
    okGpu('G1 the 2D view is the game WebGPU renderer (engine2d / RHI via the workbench RHI layer)',
      () => v2.gpu.host.renderer.name === 'webgpu' && !v2.gpu.err && el('view2d').getContext('2d') === null && el('view2d').getContext('webgl2') === null,
      { err: v2.gpu.err });
    if (!v2.gpu.ok) ok('G1 without WebGPU the 2D view says why (and editing still works)', !!v2.gpu.err && /WebGPU|适配器|着色/.test(v2.gpu.err), { err: v2.gpu.err });

    // ---- G2 标注层：叠在 GPU 画面上、不吃鼠标、显隐跟着 #view2d（setView 只切 #view2d）
    setView(2); await wait(30);
    const ov = el('overlay2d');
    const shown2 = !!ov && !ov.hidden && getComputedStyle(ov).pointerEvents === 'none';
    setView(3); await wait(30);
    const hidden3 = !!ov && ov.hidden;
    setView(2); await wait(30);
    ok('G2 the annotation layer sits on top of the GPU view, takes no mouse, and hides with the 2D view', shown2 && hidden3 && !ov.hidden,
      { shown2, hidden3, pe: ov && getComputedStyle(ov).pointerEvents });

    // ---- G3 纸钱（薄片 + 动画包图集）在原画视图里：游戏的 VfxRenderer 画，原画深度 = 场景 depth_map；图层「粒子」去勾就没有
    await openEffect('paper_money', { jump: true });
    await until(() => !S.busy && !!S.scene, 20000);
    setView(2);
    resetSim();
    for (let i = 0; i < 90; i++) stepSim(1 / 60);
    const a = S.sim && S.sim.anchorWorld;
    if (a) { v2.fit(); v2.focus(S.cal.worldToScene(a[0], a[1], a[2]), 260); }
    await settle();
    const W = v2.c.clientWidth, H = v2.c.clientHeight;
    const box = [W * 0.2, H * 0.2, W * 0.6, H * 0.6];
    okGpu('G3 the scene depth map (same URL as SceneDepthSystem) and the background are on the GPU, the paper sheet is loaded',
      () => !!v2.gpu.last && /\/resources\/runtime\/scenes\/.+\/raw_depth_rg\.png$/.test(decodeURIComponent(v2.gpu.last.depthUrl)) && !!v2.gpu.last.bgUrl && v2.gpu.last.sheets === 1,
      () => v2.gpu.last && { depth: v2.gpu.last.depthUrl, bg: v2.gpu.last.bgUrl, sheets: v2.gpu.last.sheets, errs: v2.gpu.sheetErrors });
    let withP = null, noP = null, st = null;
    if (v2.gpu.ok) {
      st = v2.gpu.stage.stats();
      withP = region(...box);
      S.layers.particles = false; draw(); noP = region(...box);
      S.layers.particles = true; draw();
    }
    okGpu('G3 paper money is drawn by the game renderer (plate meshes in the entity layer; the particles layer toggles real pixels)',
      () => S.sim.liveCount > 50 && st.meshes >= 1 && st.drawCalls >= 1 && Math.abs(withP.lum - noP.lum) > 2000,
      () => ({ live: S.sim && S.sim.liveCount, st, withP, noP }));

    // ---- G4 图层「场景压暗」= 背景半透明压在清屏色上（GPU 画面里真暗下去）；「场景」去勾 = 背景整个不画
    if (v2.gpu.ok) {
      S.layers.particles = false; draw();
      const bright = region(...box);
      S.layers.dimMesh = true; draw(); const dim = region(...box);
      S.layers.dimMesh = false; S.layers.mesh = false; draw(); const none = region(...box);
      S.layers.mesh = true; S.layers.particles = true; draw();
      okGpu('G4 the 场景压暗 / 场景 layers act on the GPU background (dimmed art is darker, hidden art leaves the clear colour)',
        () => dim.lum < bright.lum * 0.8 && dim.lum > none.lum && none.n < 50, { bright: bright.lum, dim: dim.lum, none });
    } else okGpu('G4 the 场景压暗 / 场景 layers act on the GPU background', false);

    // ---- G5 换时段外观 / 场景：旧背景纹理放掉（不越攒越多）
    const bg0 = v2.gpu.bgUrl;
    const other = S.scenes.find((sc) => sc.depth && sc.id !== S.scene.id);
    if (other) { await loadScene(other.id, ''); await until(() => !S.busy, 20000); setView(2); await settle(); }
    okGpu('G5 switching scenes swaps the background texture and drops the old one',
      () => !!other && v2.gpu.bgUrl !== bg0 && !v2.gpu.textures.has(bg0) && [...v2.gpu.textures.keys()].filter((u) => u.startsWith('/api/scene_bg')).length === 1,
      () => ({ other: other && other.id, bg0, now: v2.gpu.bgUrl, keys: [...v2.gpu.textures.keys()] }));

    // ---- G6 落雷在原画视图里：天上那道 + 落点那几层，游戏的雷管线画得出来、这一帧没画坏
    await openEffect('lightning_bolt_01', { keepScene: true });
    await until(() => !S.busy, 20000);
    setView(2); resetSim();
    for (let i = 0; i < 6; i++) stepSim(1 / 60);
    v2.fit();
    await settle();
    let bolt = null, boltSt = null;
    if (v2.gpu.ok) { boltSt = v2.gpu.stage.stats(); bolt = region(0, 0, W, H); }
    okGpu('G6 a lightning strike renders in the 2D view with the game bolt pipeline (several meshes, bright core pixels, no frame error)',
      () => !v2.gpu.err && boltSt.meshes >= 3 && bolt.n > 1000, () => ({ err: v2.gpu.err, st: boltSt, bolt }));

    // ---- G7 冒烟钩子
    okGpu('G7 window.__rhiSmoke2d reports a live, non-empty GPU view', () => window.__rhiSmoke2d().ok === true, () => window.__rhiSmoke2d());
  } catch (error) { log.push('EXC ' + (error.stack || error)); }
  finally {
    S.link.on = false;
    window.__selftestResult = log.join('\n');
  }
})();
