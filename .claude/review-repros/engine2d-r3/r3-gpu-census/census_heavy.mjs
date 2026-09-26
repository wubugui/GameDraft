// GPU resource census: branch (engine2d/WebGPU) vs master (Pixi/WebGL).
// usage: node census.mjs <side:branch|master> <port> <outJson> [rounds] [idleMs]
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire('/tmp/claude-0/-home-user-GameDraft/198c03f2-c296-5229-99c9-049512d57ecf/scratchpad/package.json');
const { chromium } = require('playwright-core');

const [side, port, out, roundsArg, idleArg, scenesArg] = process.argv.slice(2);
const ROUNDS = Number(roundsArg ?? 5);
const IDLE_MS = Number(idleArg ?? 75000);
const SCENES = (scenesArg ?? 'dev_room,teahouse,河边,雾津街头,义庄,城隍庙夜').split(',');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HOOK = `(() => {
  const C = (globalThis.__census = { gpu: {}, gl: {}, texBytes: 0, glTexBytes: 0, gcRuns: 0, gcRunsAt: [] });
  const live = (m, k, d) => { m[k] = (m[k] || 0) + d; };
  if (globalThis.GPUDevice) {
    const P = GPUDevice.prototype;
    const texInfo = new WeakMap();
    const wrapCreate = (name, key, onObj) => {
      const orig = P[name];
      if (!orig) return;
      P[name] = function (...a) { const o = orig.apply(this, a); live(C.gpu, key + '_created', 1); onObj && onObj(o, a[0]); return o; };
    };
    wrapCreate('createTexture', 'tex', (o, d) => {
      const s = d.size; const w = Array.isArray(s) ? s[0] : s.width; const h = Array.isArray(s) ? (s[1] ?? 1) : (s.height ?? 1);
      const bpp = /rgba16float|rg32/.test(d.format) ? 8 : /rgba32/.test(d.format) ? 16 : /^r8|stencil8$/.test(d.format) && !/depth24/.test(d.format) ? 1 : 4;
      const mips = d.mipLevelCount || 1; const b = Math.round(w * h * bpp * (d.sampleCount || 1) * (mips > 1 ? 4 / 3 : 1));
      texInfo.set(o, b); C.texBytes += b;
    });
    wrapCreate('createBuffer', 'buf', (o, d) => { texInfo.set(o, d.size); C.bufBytes = (C.bufBytes || 0) + d.size; });
    wrapCreate('createBindGroup', 'bindGroup');
    wrapCreate('createRenderPipeline', 'pipeline');
    wrapCreate('createSampler', 'sampler');
    wrapCreate('createShaderModule', 'shader');
    const dT = GPUTexture.prototype.destroy;
    const dead = new WeakSet();
    GPUTexture.prototype.destroy = function () { if (!dead.has(this)) { dead.add(this); live(C.gpu, 'tex_destroyed', 1); C.texBytes -= texInfo.get(this) || 0; } return dT.call(this); };
    const dB = GPUBuffer.prototype.destroy;
    GPUBuffer.prototype.destroy = function () { if (!dead.has(this)) { dead.add(this); live(C.gpu, 'buf_destroyed', 1); C.bufBytes -= texInfo.get(this) || 0; } return dB.call(this); };
  }
  for (const Ctx of [globalThis.WebGL2RenderingContext, globalThis.WebGLRenderingContext]) {
    if (!Ctx) continue;
    const P = Ctx.prototype;
    const bytes = new WeakMap();
    const bound = new WeakMap(); // ctx -> {unit, map}
    const st = (gl) => { let s = bound.get(gl); if (!s) bound.set(gl, (s = { unit: 0, tex: {} })); return s; };
    for (const k of ['Texture', 'Buffer', 'Framebuffer', 'Renderbuffer', 'VertexArray', 'Program']) {
      const c = P['create' + k], d = P['delete' + k];
      if (!c) continue;
      P['create' + k] = function (...a) { const o = c.apply(this, a); live(C.gl, k + '_created', 1); return o; };
      const deadSet = new WeakSet();
      P['delete' + k] = function (o) { if (o && !deadSet.has(o)) { deadSet.add(o); live(C.gl, k + '_deleted', 1); if (k === 'Texture') C.glTexBytes -= bytes.get(o) || 0; } return d.call(this, o); };
    }
    const aT = P.activeTexture; P.activeTexture = function (u) { st(this).unit = u; return aT.call(this, u); };
    const bT = P.bindTexture; P.bindTexture = function (t, o) { st(this).tex[st(this).unit + ':' + t] = o; return bT.call(this, t, o); };
    const setB = (gl, target, b) => { const o = st(gl).tex[st(gl).unit + ':' + target]; if (!o) return; C.glTexBytes += b - (bytes.get(o) || 0); bytes.set(o, b); };
    const tI = P.texImage2D; P.texImage2D = function (...a) {
      if (a[1] === 0) { let w, h; if (a.length >= 8) { w = a[3]; h = a[4]; } else { const s = a[5]; w = s?.naturalWidth || s?.videoWidth || s?.displayWidth || s?.width || 0; h = s?.naturalHeight || s?.videoHeight || s?.displayHeight || s?.height || 0; } setB(this, a[0], w * h * 4); }
      return tI.apply(this, a);
    };
    const tS = P.texStorage2D; if (tS) P.texStorage2D = function (t, l, f, w, h) { setB(this, t, w * h * 4 * (l > 1 ? 4 / 3 : 1)); return tS.apply(this, arguments); };
  }
})();`;

const PROBE_BRANCH = `async () => {
  const g = globalThis.__game; const R = g.renderer.app.renderer;
  if (!R.__censusHooked) { R.__censusHooked = true; const run = R.gc.run.bind(R.gc); R.gc.run = function () { __census.gcRuns++; __census.gcRunsAt.push(Math.round(performance.now())); return run(); }; }
  const TP = (await import('/src/engine2d/textures/TexturePool.ts')).TexturePool;
  let pooled = 0; for (const k in TP._texturePool) pooled += TP._texturePool[k].length;
  const e2d = {
    textures: R.textures.entries.size, samplers: R.textures.samplers.size, buffers: R.buffers.entries.size,
    pipelines: R.pipelines.pipelines.size, shaders: R.pipelines.shaders.size, targets: R.targets.size,
    scopeRes: R.scope.resourceCount, scopeChildren: R.scope.childCount, rootRes: R.rhi.rootScope.resourceCount,
    releasePending: R.rhi.releases?.pendingCount, states: R.states.length,
    poolFree: pooled, poolKeyHash: Object.keys(TP._poolKeyHash).length,
  };
  // per-type breakdown of GpuTextures entries
  const lbl = {}; for (const [src] of R.textures.entries) { const l = (String(src.label || '').replace(/[0-9]+/g, '#').slice(0, 30)) + '|' + (src.resource ? src.resource.constructor.name : 'noRes') + '|gc' + (src.autoGarbageCollect ? 1 : 0) + '|' + src.pixelWidth + 'x' + src.pixelHeight; lbl[l] = (lbl[l] || 0) + 1; }
  const bl = {}; for (const [b] of R.buffers.entries) { const l = String(b.label || 'nolabel').replace(/[0-9]+/g, '#').slice(0, 40); bl[l] = (bl[l] || 0) + 1; }
  return { e2d, texLabels: lbl, bufLabels: bl };
}`;

const PROBE_MASTER = `async () => {
  const g = globalThis.__game; const R = g.renderer.app.renderer;
  if (!R.__censusHooked) { R.__censusHooked = true; const run = R.gc.run.bind(R.gc); R.gc.run = function () { __census.gcRuns++; __census.gcRunsAt.push(Math.round(performance.now())); return run(); }; }
  const cnt = (h) => { if (!h) return null; let n = 0; for (const k in h.items) if (h.items[k]) n++; return n; };
  const pixiUrl = performance.getEntriesByType('resource').map((e) => e.name).find((n) => /\\.vite\\/deps\\/pixi_+js\\.js/.test(n));
  let pooled = null, poolKeyHash = null;
  if (pixiUrl) { const TP = (await import(pixiUrl)).TexturePool; pooled = 0; for (const k in TP._texturePool) pooled += TP._texturePool[k].length; poolKeyHash = Object.keys(TP._poolKeyHash).length; }
  const p = R.renderPipes;
  const pixi = {
    textures: cnt(R.texture._managedTextures), buffers: cnt(R.buffer._managedBuffers), geometries: cnt(R.geometry._managedGeometries),
    gfxContexts: cnt(R.graphicsContext._managedContexts), gfxRenderables: cnt(p.graphics?._managedGraphics),
    texts: cnt(p.text?._managedTexts), htmlTexts: cnt(p.htmlText?._managedTexts), nine: cnt(p.nineSliceSprite?._managedSprites), tiling: cnt(p.tilingSprite?._managedTilingSprites),
    gcManaged: R.gc._managedResources.length, rtHash: R.renderTarget._renderSurfaceToRenderTargetHash?.size,
    glRT: R.renderTarget._gpuRenderTargetHash ? Object.values(R.renderTarget._gpuRenderTargetHash).filter(Boolean).length : null,
    samplers: R.texture._glSamplers ? Object.keys(R.texture._glSamplers).length : null,
    poolFree: pooled, poolKeyHash, pixiUrl: !!pixiUrl,
  };
  const lbl = {}; for (const k in R.texture._managedTextures.items) { const s = R.texture._managedTextures.items[k]; if (!s) continue; const l = String(s.label || '').replace(/[0-9]+/g, '#').slice(0, 30) + '|' + (s.resource ? s.resource.constructor.name : 'noRes') + '|gc' + (s.autoGarbageCollect ? 1 : 0) + '|' + s.pixelWidth + 'x' + s.pixelHeight; lbl[l] = (lbl[l] || 0) + 1; }
  return { pixi, texLabels: lbl };
}`;

const COMMON = `() => {
  const C = globalThis.__census; const g = globalThis.__game;
  if (globalThis.gc) globalThis.gc();
  const gpu = {}; for (const k of ['tex', 'buf']) gpu[k + '_live'] = (C.gpu[k + '_created'] || 0) - (C.gpu[k + '_destroyed'] || 0);
  const gl = {}; for (const k of ['Texture', 'Buffer', 'Framebuffer', 'Renderbuffer', 'VertexArray', 'Program']) if (C.gl[k + '_created'] != null) gl[k + '_live'] = C.gl[k + '_created'] - (C.gl[k + '_deleted'] || 0);
  return {
    t: Math.round(performance.now()), scene: g.sceneManager.currentSceneData?.id,
    gpuCreated: { ...C.gpu }, gpu, gpuTexMB: +(C.texBytes / 1048576).toFixed(2), gpuBufMB: +((C.bufBytes || 0) / 1048576).toFixed(2),
    gl, glTexMB: +(C.glTexBytes / 1048576).toFixed(2), gcRuns: C.gcRuns, gcRunsAt: C.gcRunsAt.slice(-3),
    heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
    stageChildren: g.renderer.app.stage.children.length,
  };
}`;

async function withTimeout(p, ms) { return Promise.race([p, sleep(ms).then(() => 'timeout')]); }

async function main() {
  const browser = await chromium.launch({
    headless: false,
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
      '--enable-precise-memory-info', '--js-flags=--expose-gc', '--autoplay-policy=no-user-gesture-required', '--window-size=1320,860'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await ctx.addInitScript(HOOK);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror ' + String(e).slice(0, 300)));
  page.on('console', (m) => { if (m.type() === 'error') { const t = m.text(); if (!/Failed to load resource|404|decode|加载失败|素材/.test(t)) errors.push('console ' + t.slice(0, 300)); } });
  const url = `http://127.0.0.1:${port}/?mode=dev&visualCapture&devScene=${encodeURIComponent(SCENES[0])}`;
  await page.goto(url, { timeout: 120000 });
  const t0 = Date.now();
  while (Date.now() - t0 < 180000) {
    const ok = await page.evaluate(() => !!(globalThis.__gameDevAPI?.isReady?.() && globalThis.__game?.sceneManager?.currentSceneData)).catch(() => false);
    if (ok) break;
    await sleep(500);
  }
  await sleep(3000);
  const probe = side === 'branch' ? PROBE_BRANCH : PROBE_MASTER;
  const sample = async (tag) => {
    const a = await page.evaluate(`(${COMMON})()`);
    const b = await page.evaluate(`(${probe})()`).catch((e) => ({ probeError: String(e).slice(0, 300) }));
    const s = { tag, wall: Math.round((Date.now() - t0) / 1000), ...a, ...b };
    console.log(JSON.stringify({ tag, wall: s.wall, scene: s.scene, gpu: s.gpu, gpuTexMB: s.gpuTexMB, gpuBufMB: s.gpuBufMB, gl: s.gl, glTexMB: s.glTexMB, gcRuns: s.gcRuns, heapMB: s.heapMB, e2d: s.e2d, pixi: s.pixi, bg: s.gpuCreated?.bindGroup, pl: s.gpuCreated?.pipeline }));
    return s;
  };
  const cmd = (c) => page.evaluate((c) => globalThis.__game.applyRuntimeCommand({ id: 'census-' + Math.random(), ...c }).then((r) => r && r.ok, (e) => 'err ' + e), c);
  const samples = [await sample('boot')];
  const PANELS = ['inventory', 'quest', 'rules', 'map', 'dialogueLog', 'bookshelf'];
  const api = (name, ...args) => page.evaluate(([n, a]) => { try { return Promise.resolve(globalThis.__gameDevAPI[n](...a)).then((v) => v, (e) => 'err ' + e); } catch (e) { return 'throw ' + e; } }, [name, args]);
  const MINIS = [['water', 'dev_pond'], ['sugarWheel', 'sugar_zodiac'], ['paperCraft', 'wujin_paper_servant_daywork'], ['objectExamine', 'demo_waterlogged_corpse'], ['pressureHold', 'carry_bride_corpse']];
  const CUTS = ['prologue_opening', '说书-李天狗大战旱魃', 'ghost_flashback'];
  for (let r = 1; r <= ROUNDS; r++) {
    const log = [];
    for (const [kind, id] of MINIS) {
      console.log('mini', kind); const res = await withTimeout(api('startMinigame', kind, id), 20000);
      await sleep(2500);
      await withTimeout(cmd({ type: 'debugClick', x: 640, y: 360 }), 3000);
      await withTimeout(cmd({ type: 'debugDrag', fromX: 450, fromY: 400, toX: 830, toY: 320, durationMs: 300 }), 5000);
      await sleep(1500);
      const st = await withTimeout(page.evaluate(() => globalThis.__game.stateController?.currentState ?? globalThis.__game.stateController?._currentState), 3000);
      await withTimeout(page.keyboard.press('Escape'), 3000); await sleep(300); await withTimeout(page.keyboard.press('Escape'), 3000); await sleep(300); console.log('  esc done');
      log.push(`${kind}:${res}:${st}`);
      await withTimeout(cmd({ type: 'debugSwitchScene', sceneId: SCENES[0] }), 60000);
    }
    for (const id of CUTS) {
      console.log('cut', id); await withTimeout(api('playCutscene', id), 5000);
      for (let k = 0; k < 4; k++) { await sleep(1000); await withTimeout(api('completeCutsceneText'), 3000); await withTimeout(cmd({ type: 'playerTap' }), 3000); }
      await page.keyboard.press('Escape'); await sleep(300);
      await withTimeout(cmd({ type: 'debugSwitchScene', sceneId: SCENES[1] || SCENES[0] }), 60000);
      await withTimeout(cmd({ type: 'debugSwitchScene', sceneId: SCENES[0] }), 60000);
    }
    console.log('resize'); for (let k = 0; k < 3; k++) { await page.setViewportSize({ width: 960, height: 540 }); await sleep(700); await page.setViewportSize({ width: 1280, height: 720 }); await sleep(700); }
    const sv = await withTimeout(cmd({ type: 'debugSaveGame', slot: 3 }), 10000);
    const ld = await withTimeout(cmd({ type: 'debugLoadGame', slot: 3 }), 30000);
    await sleep(2000);
    if (r === 1) console.log('round1', log.join(' '), 'save', sv, 'load', ld);
    samples.push(await sample(`r${r}-active`));
    await withTimeout(cmd({ type: 'debugSwitchScene', sceneId: SCENES[0] }), 60000);
    await sleep(IDLE_MS);
    samples.push(await sample(`r${r}-idle`));
  }
  fs.writeFileSync(out, JSON.stringify({ side, samples, errors: errors.slice(0, 60) }, null, 1));
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
