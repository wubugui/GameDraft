/* 角色照明实验室 · 查看器画面的端到端回归(在真页面里跑;桌面壳 `python -m tools.character_lighting_lab --selftest` 注入,
 * 或真 GPU 的 Chrome:`tools/workbench_rhi/chrome_page.mjs --selftest … --no-skip`)。
 *
 * 每条 `ok()` 一行 PASS / FAIL;异常记 EXC;跑完报告写进 window.__selftestResult。
 * 约定:只动视图参数,不点任何烘焙 / 导出 / 存盘按钮——真工程、本机工作台一个字节不碰。
 * viewer 是 classic script:`S` / `V` / `setMode` … 是词法声明、不挂 window,这里一律用裸标识符。
 * 拿不到 WebGPU 的宿主(离屏 Qt / 驱动不行)时着色层那几条记 SKIP 并写明原因;真 GPU 的 Chrome 跑同一份脚本不许有 SKIP。 */
(async () => {
  const log = [];
  const ok = (name, cond, extra) => log.push((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + JSON.stringify(extra) : ''));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 8000)) { try { if (fn()) return true; } catch (e) { /* 还没好 */ } await wait(40); } return false; };
  const noGpu = () => !V.host || !V.stage;
  const okGpu = async (name, fn, extra) => {
    if (noGpu()) { log.push(`SKIP ${name} ${JSON.stringify({ why: V.err || 'no GPU layer' })}`); return; }
    try { const r = await fn(); ok(name, typeof r === 'object' && r !== null ? !!r.ok : !!r, typeof r === 'object' && r !== null ? r : extra); }
    catch (e) { log.push(`EXC ${name} ${e && e.stack || e}`); }
  };
  const settle = async () => { await wait(350); await until(() => !V.payloadPending && V.stage && V.stage.loaded, 30000); };
  const same = (a, b) => a.every((v, i) => v === b[i]);
  const hash = (u8, stride = 7) => { let h = 0x811c9dc5 >>> 0; for (let i = 0; i < u8.length; i += stride) { h ^= u8[i]; h = Math.imul(h, 0x01000193) >>> 0; } return h; };
  /** 角色 quad 在画布上的那一块(设备像素):亮度均值 + 逐字节哈希(同一帧重读必须逐字节相同)。
   *  画布回读是异步的 RHI 纹理回读:在这个任务里先画一帧再发起回读(拷贝在调用当下提交,之后主循环再画不影响读到的) */
  const readChar = async () => {
    draw2D();
    const f = footScene(), c = camera2D(), d = V.host.renderer.resolution;
    const w = f.hPx * S.charAspect * c.scale, h = f.hPx * c.scale;
    const x0 = Math.floor((f.x * c.scale + c.x - w / 2) * d), y0 = Math.floor((f.y * c.scale + c.y - h) * d);
    const px = await V.host.readPixels(Math.max(0, x0), Math.max(0, y0), Math.ceil(w * d), Math.ceil(h * d));
    let sum = 0;
    for (let i = 0; i < px.data.length; i += 4) sum += px.data[i] + px.data[i + 1] + px.data[i + 2];
    return { mean: +(sum / (px.data.length / 4) / 3).toFixed(2), hash: hash(px.data, 1) };
  };
  const box = (id, on) => { const el = document.getElementById(id); if (el.checked !== !!on) { el.checked = !!on; el.dispatchEvent(new Event('change')); } };

  try {
    // ------------------------------------------------------------------ S1 启动
    await until(() => window.__ready === true, 120000);
    await until(() => V.sceneReady && V.sceneReady === (S.man && S.man.name), 120000);
    ok('S1 boot: ready, a baked scene fully loaded, bundle namespaces present, no GLSL / WebGL objects on the page',
      !!window.__ready && !!S.man && !!V.rt && !!V.rt.charLabView && !!V.rt.debug3d && !!V.rt.labImages && !!V.rt.workbenchRhi
      && typeof CHAR_SHADE_CORE === 'undefined' && ![...document.scripts].some((s) => /char_shade_core/.test(s.src)),
      { scene: S.man && S.man.name, err: V.err });
    setView(0);
    box('dbg_occl', true); box('dbg_normal', false);
    setMode(1);
    await settle();

    // ------------------------------------------------------------------ S2 2D 画面 = 游戏渲染器 + 游戏受光载荷(虚拟目录)
    await okGpu('S2 the 2D view is the game WebGPU renderer; the character payload is the game loader on the virtual bake dir',
      async () => {
        draw2D();
        const drawn = await V.host.countDrawnPixels(), total = canvas2d.width * canvas2d.height;
        const base = V.stage.lighting.loadedBakeBase || '';
        return { ok: V.host.renderer.name === 'webgpu' && V.stage.loaded && drawn > total * 0.5 && !V.host.lastError
          && base.startsWith('/api/game_payload/') && base === payloadBase(S.man.name), drawn, total, base, err: V.host.lastError };
      });
    // ------------------------------------------------------------------ S3 角色是游戏 lit 网格画的,绑的是载荷纹理(不是退白的)
    await okGpu('S3 the character is the game lit mesh bound to the loaded payload textures, and it changes the frame',
      async () => {
        draw2D();
        const cv = V.stage['char'];
        const r = V.stage.lighting['resources'];
        const bound = !!cv && cv.shader.resources.uValid === r.valid && cv.shader.resources.uPL1 === r.atlasL1;
        const withChar = await readChar();
        charReady = false; const without = await readChar(); charReady = true;
        const again = await readChar();
        return { ok: bound && withChar.hash !== without.hash && withChar.hash === again.hash, bound, withChar, without };
      });
    // ------------------------------------------------------------------ S4 四档切换(游戏 applyCharMode 同一条)
    await okGpu('S4 L1 / SH / octahedral / RT switch through the game loader (atlas / volumes), frame stays lit, no device error',
      async () => {
        const got = {};
        for (const m of [2, 3, 0, 1]) {
          setMode(m); await V.stage.requestMode(m); await until(() => V.stage.mode === m, 20000);
          got[m] = await readChar();
        }
        const r = V.stage.lighting['resources'];
        const lit = Object.values(got).every((p) => p.mean > 2);
        const distinct = new Set(Object.values(got).map((p) => p.hash)).size === 4;
        return { ok: V.stage.mode === 1 && lit && distinct && !V.host.lastError && r.atlasL1.width > 1 && !V.stage.lighting.hasVolumes, got };
      });
    // ------------------------------------------------------------------ S5 遮挡 = 游戏的深度遮挡滤镜挂在角色容器上
    await okGpu('S5 occlusion is the game depth-occlusion filter on the character container (toggle attaches / detaches it)',
      () => {
        box('dbg_occl', true); draw2D();
        const on = V.stage['char'].box.filters.length;
        const f = V.stage['char'].box.filters[0];
        box('dbg_occl', false); draw2D();
        const off = V.stage['char'].box.filters.length;
        box('dbg_occl', true); draw2D();
        return { ok: on === 1 && off === 0 && !!f && f === V.stage['depthFilter'] && V.stage.depth.isEnabled, on, off };
      });
    // ------------------------------------------------------------------ S6 amb / nee 改了 → 虚拟载荷换一份合成,游戏装载器重装
    await okGpu('S6 changing amb / NEE recomposes the virtual payload (export formula) and the game loader reloads it',
      async () => {
        const before = await readChar(), amb0 = S.amb;
        setSlider('amb', 0.3); await settle(); await until(() => V.stage['char'], 3000);
        const base = V.stage.lighting.loadedBakeBase;
        const after = await readChar();
        setSlider('amb', amb0); await settle();
        const back = await readChar();
        return { ok: /a0\.300$/.test(base) && after.mean < before.mean && before.hash === back.hash
          && V.stage.lighting.loadedBakeBase === payloadBase(S.man.name), base, before, after, back };
      });
    // ------------------------------------------------------------------ S7 纯工具视图的背景(CPU 逐像素,没有着色器)
    await okGpu('S7 background views (HDR / gain / depth / EV zones) are CPU images fed to the renderer as textures',
      async () => {
        const sel = document.getElementById('bgview');
        const hashes = {}, dims = {};
        for (const m of ['1', '2', '3', '4']) {
          sel.value = m; sel.dispatchEvent(new Event('change'));
          const t = currentBgTexture();
          hashes[m] = hash(t.source.resource);
          dims[m] = [t.width, t.height];
        }
        sel.value = '0'; sel.dispatchEvent(new Event('change'));
        const orig = currentBgTexture() === V.bgTex;
        const distinct = new Set(Object.values(hashes)).size === 4;
        return { ok: distinct && orig && dims['3'][0] === S.work.w && dims['1'][0] === V.W2, dims };
      });
    // ------------------------------------------------------------------ S8 标注层(2D 画布)
    {
      box('dbg_walk', true); draw2D();
      const px = octx.getImageData(0, 0, canvas.width, canvas.height).data;
      let green = 0;
      for (let i = 0; i < px.length; i += 4) if (px[i + 3] > 200 && px[i + 1] > 200 && px[i] < 60) green++;
      box('dbg_walk', false); draw2D();
      const px2 = octx.getImageData(0, 0, canvas.width, canvas.height).data;
      let left = 0;
      for (let i = 0; i < px2.length; i += 4) if (px2[i + 3] > 0) left++;
      ok('S8 annotations (walkable dots) are drawn on the 2D overlay canvas and cleared when turned off', green > 20 && left === 0, { green, left });
    }
    // ------------------------------------------------------------------ S9 3D 检视 = 3D 调试件:画面 / 投影 == 画法 / 深度遮挡
    if (!V.g3) log.push(`SKIP S9 3D view ${JSON.stringify({ why: V.err3 || 'no 3D view' })}`);
    else {
      try {
        setView(1); setPanoMode(-1); setCamMode('orbit'); fitCamera();
        box('dbg_probes', true);
        draw3D(); await wait(50); draw3D();
        const mvp = camMVP(), dpr = V.dpr;
        const cssW = canvas3d.width / dpr, cssH = canvas3d.height / dpr;
        const project = (p) => { const c = projectToCanvas(mvp, p); return c ? [c[0] / dpr, c[1] / dpr] : null; };
        const inv = invert4(mvp);
        const unproj = (x, y, z) => { const v = [x, y, z, 1], o = [0, 0, 0, 0];
          for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) o[r] += inv[c * 4 + r] * v[c];
          return [o[0] / o[3], o[1] / o[3], o[2] / o[3]]; };
        const ray = (sx, sy) => { const nx = sx / cssW * 2 - 1, ny = 1 - sy / cssH * 2;
          const a = unproj(nx, ny, -1), b = unproj(nx, ny, 1); return { o: a, d: [b[0] - a[0], b[1] - a[1], b[2] - a[2]] }; };
        // 标记 = 页面 drawProbeDots3D 同序同色(正交轨道机位 w = 1 → 点径 8)
        const D = S.probe, C = S.probeDC, g = S.probeGain, markers = [];
        for (let i = 0; i < D.Pn; i++) {
          const pos = [D.pos[i * 3], D.pos[i * 3 + 1], D.pos[i * 3 + 2]], sel = i === S.selProbe;
          if (C[i * 4 + 3] < 0.5) { markers.push({ pos, color: [0.42, 0.10, 0.10, 1], size: 8 * (sel ? 2.2 : 1) }); continue; }
          const c = [lin2srgbJ(C[i * 4] * g), lin2srgbJ(C[i * 4 + 1] * g), lin2srgbJ(C[i * 4 + 2] * g)].map((v) => Math.min(1, v));
          if (sel) markers.push({ pos, color: [1, 0.35, 0.85, 1], size: 8 * 2.2 }, { pos, color: [c[0], c[1], c[2], 1], size: 8 * 2.2 * 0.62 });
          else markers.push({ pos, color: [c[0] * 0.32, c[1] * 0.32, c[2] * 0.32, 1], size: 8 }, { pos, color: [c[0], c[1], c[2], 1], size: 8 * 0.82 });
        }
        const m0 = V.mesh3 && V.mesh3.find((m) => m);
        const res = V.rt.debug3d.selfCheck(V.g3, { project, ray, cssSize: [cssW, cssH], markers,
          mesh: m0 ? { vertices: m0.data, stride: 5, indices: m0.indices } : null });
        for (const r of res) ok('S9 3D debug view: ' + r.name, r.ok, r.detail);
      } catch (e) { log.push(`EXC S9 ${e && e.stack || e}`); }
      box('dbg_probes', false);
    }
    // ------------------------------------------------------------------ S10 3D 的角色 quad 贴游戏着色、全景图贴在球上
    if (!V.g3 || noGpu()) log.push(`SKIP S10 3D character / panorama ${JSON.stringify({ why: V.err3 || V.err || 'no GPU' })}`);
    else {
      try {
        setView(1); setCamMode('fly'); fitCamera();
        V.char3Key = '';
        draw3D();
        const gotChar = await until(() => { draw3D(); return !!V.char3 && !!V.char3Key; }, 15000);
        setPanoMode(0);
        const gotPano = await until(() => { draw3D(); return !!(V.pano && V.pano.tex && V.sphere); }, 15000);
        const cx = canvas3d.width / V.dpr / 2, cy = canvas3d.height / V.dpr / 2;
        draw3D();
        const withPano = V.g3.readPixel(cx, cy);
        setPanoMode(-1); draw3D();
        const noPano = V.g3.readPixel(cx, cy);
        // 角色 quad 的胸口(底边中点 → 顶边中点的 55%)投到画布上:画角色 / 不画角色像素不同
        const [lt, rt, rb, lb] = char3Corners();
        const mid = (a, b, t) => a.map((v, k) => v + (b[k] - v) * t);
        const chestW = mid(mid(lb, rb, 0.5), mid(lt, rt, 0.5), 0.55);
        const cp = projectToCanvas(camMVP(), chestW);
        let charOn = null, charOff = null;
        if (cp) {
          const sx = cp[0] / V.dpr, sy = cp[1] / V.dpr;
          draw3D(); charOn = V.g3.readPixel(sx, sy);
          S.pano.drawChar = 0; draw3D(); charOff = V.g3.readPixel(sx, sy); S.pano.drawChar = 1; draw3D();
        }
        ok('S10 3D: the character quad carries the game shading rendered offscreen; the panorama map on the eye sphere changes the frame',
          gotChar && gotPano && V.char3.width > 1 && !same(withPano.slice(0, 3), noPano.slice(0, 3))
          && !!charOn && !same(charOn.slice(0, 3), charOff.slice(0, 3)) && !V.g3.lastError,
          { gotChar, gotPano, withPano, noPano, at: cp, charOn, charOff, err: V.g3.lastError });
      } catch (e) { log.push(`EXC S10 ${e && e.stack || e}`); }
      setView(0);
    }
  } catch (e) {
    log.push('EXC ' + (e && e.stack || e));
  }
  const pass = log.filter((l) => l.startsWith('PASS')).length;
  const fail = log.filter((l) => l.startsWith('FAIL') || l.startsWith('EXC')).length;
  const skip = log.filter((l) => l.startsWith('SKIP')).length;
  log.push(`[selftest] ${pass} passed, ${fail} failed, ${skip} skipped`);
  window.__selftestResult = log.join('\n');

  /** 列主序 4×4 求逆(投影矩阵反投影拾取射线用) */
  function invert4(m) {
    const inv = new Array(16);
    inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
    inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
    inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
    inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
    inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
    inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
    inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
    inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
    inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
    inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
    inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
    inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
    inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
    inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
    inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
    inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];
    const det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
    return inv.map((v) => v / det);
  }
})();
