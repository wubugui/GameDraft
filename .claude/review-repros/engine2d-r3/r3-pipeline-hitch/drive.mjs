// r3-pipeline-hitch: count GPU pipeline creations after the reveal gate on the branch.
// usage: node drive.mjs <port> <outJson> [scenes...]
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('/tmp/claude-0/-home-user-GameDraft/198c03f2-c296-5229-99c9-049512d57ecf/scratchpad/package.json');
const { chromium } = require('playwright-core');

const port = Number(process.argv[2] || 5741);
const out = process.argv[3] || '.claude/review-repros/engine2d-r3/r3-pipeline-hitch/result.json';
const onlyScenes = process.argv.slice(4);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const INIT = `(() => {
  const S = globalThis.__pf = { log: [], frame: 0, phase: 'boot', marks: [], e2d: [], src: {} };
  const raf = globalThis.requestAnimationFrame.bind(globalThis);
  const tick = () => { S.frame++; raf(tick); }; raf(tick);
  const wrap = (proto, name, kind) => {
    const o = proto && proto[name]; if (!o) return;
    proto[name] = function (desc) {
      const t0 = performance.now();
      const r = o.apply(this, arguments);
      S.log.push({ kind, obj: r, dlabel: desc && desc.label, t: t0, dt: performance.now() - t0, frame: S.frame, phase: S.phase });
      return r;
    };
  };
  if (globalThis.GPUDevice) {
    wrap(GPUDevice.prototype, 'createRenderPipeline', 'rp');
    wrap(GPUDevice.prototype, 'createRenderPipelineAsync', 'rpa');
    wrap(GPUDevice.prototype, 'createComputePipeline', 'cp');
    wrap(GPUDevice.prototype, 'createShaderModule', 'sm');
    S.used = {};
    const osp = GPURenderPassEncoder.prototype.setPipeline;
    GPURenderPassEncoder.prototype.setPipeline = function (p) {
      const l = (p && p.label) || '?';
      const u = S.used[l] || (S.used[l] = { first: S.frame, firstT: performance.now(), n: 0, last: 0 });
      u.n++; u.last = S.frame;
      return osp.apply(this, arguments);
    };
  }
  const nst = setTimeout.bind(globalThis);
  const poll = () => {
    const g = globalThis.__game; const sm = g && g.sceneManager;
    if (sm && sm.revealGate && !sm.revealGate.__pfWrapped) {
      const orig = sm.revealGate;
      const w = async (id) => {
        S.phase = 'gate:' + id; S.marks.push({ ev: 'gate', id, t: performance.now(), frame: S.frame });
        try { return await orig(id); } finally { S.phase = 'post:' + id; S.marks.push({ ev: 'post', id, t: performance.now(), frame: S.frame }); }
      };
      w.__pfWrapped = true; sm.revealGate = w;
    }
    const r = g && g.renderer && g.renderer.app && g.renderer.app.renderer;
    const P = r && r.pipelines;
    if (P && !P.__pfWrapped) {
      P.__pfWrapped = true;
      const og = P.getSlow.bind(P);
      const known = new Set();
      P.getSlow = (k) => {
        const before = P.pipelines.size;
        const t0 = performance.now();
        const p = og(k);
        if (P.pipelines.size !== before) {
          if (!S.src[k.program.uid]) S.src[k.program.uid] = { name: k.program.name, vs: k.program.vertexEntry, fs: k.program.fragmentEntry, head: String(k.program.source).slice(0, 4000) };
          S.e2d.push({ uid: k.program.uid, program: k.program.name || ('program-' + k.program.uid), layout: k.layout.key.slice(0, 80), topology: k.topology, blend: k.blend,
            format: k.colorFormat, depth: k.depthFormat, stencil: k.stencil, mask: k.colorMask, samples: k.sampleCount,
            t: t0, dt: performance.now() - t0, frame: S.frame, phase: S.phase });
        }
        return p;
      };
    }
    nst(poll, 1);
  };
  nst(poll, 1);
  globalThis.__pfDump = () => ({
    log: S.log.map((e) => ({ kind: e.kind, label: (e.obj && e.obj.label) || e.dlabel || '', t: Math.round(e.t), dt: +e.dt.toFixed(2), frame: e.frame, phase: e.phase })),
    e2d: S.e2d.map((e) => ({ ...e, t: Math.round(e.t), dt: +e.dt.toFixed(2) })),
    marks: S.marks, frame: S.frame, phase: S.phase, src: S.src, used: S.used,
  });
})();`;

const browser = await chromium.launch({
  headless: false,
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-angle=swiftshader',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--window-size=1320,780'],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
const consoleLines = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') consoleLines.push(`[${m.type()}] ${m.text().slice(0, 300)}`); });
page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${String(e).slice(0, 300)}`));
await page.addInitScript(INIT);
if (process.env.PF_FAKEPNG) {
  const png = fs.readFileSync('.claude/review-repros/engine2d-r3/r3-pipeline-hitch/fake.png');
  const re = new RegExp(process.env.PF_FAKEPNG);
  await page.route((u) => re.test(u.pathname) && /\.(png|webp|jpe?g)$/i.test(u.pathname), (route) => route.fulfill({ status: 200, contentType: 'image/png', body: png }));
}

const first = onlyScenes[0] || 'test_room_a';
await page.goto(`http://127.0.0.1:${port}/?mode=dev&visualCapture&devScene=${encodeURIComponent(first)}`, { timeout: 120000 });

async function waitReady(id, ms = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const ok = await page.evaluate((id) => {
      const g = globalThis.__game; const sm = g && g.sceneManager;
      return !!(globalThis.__gameDevAPI && sm && !sm.isSwitching && sm.currentSceneData && (!id || sm.currentSceneData.id === id) && globalThis.__pf.phase.startsWith('post:'));
    }, id).catch(() => false);
    if (ok) return true;
    await sleep(250);
  }
  return false;
}

const results = { steps: [] };
const step = async (name, fn, settleMs = 4000) => {
  await page.evaluate((n) => { globalThis.__pf.marks.push({ ev: 'step', id: n, t: performance.now(), frame: globalThis.__pf.frame }); globalThis.__pf.stepName = n; }, name);
  let err = null;
  try { await fn(); } catch (e) { err = String(e).slice(0, 300); }
  await sleep(settleMs);
  results.steps.push({ name, err });
  console.log('step', name, err || 'ok');
};

console.log('ready', await waitReady(first, 180000));
await sleep(4000);

const scenes = onlyScenes.length > 1 ? onlyScenes.slice(1) : onlyScenes.length === 1 ? [] :
  fs.readdirSync('./public/assets/scenes').filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));

for (const s of scenes) {
  await step('scene:' + s, async () => {
    await page.evaluate((s) => { globalThis.__pf.phase = 'switch:' + s; }, s);
    const p = page.evaluate((s) => globalThis.__game.applyRuntimeCommand({ id: 'pf-' + s, type: 'debugSwitchScene', sceneId: s }).then((r) => JSON.stringify(r)), s);
    const r = await Promise.race([p, sleep(90000).then(() => 'timeout')]);
    if (r === 'timeout') throw new Error('switch timeout');
    await waitReady(s, 30000);
  }, 3500);
}

fs.writeFileSync(out, JSON.stringify({ ...results, dump: await page.evaluate(() => globalThis.__pfDump()), console: consoleLines.slice(0, 400) }, null, 1));
if (process.env.PF_EXTRA) {
  const extra = await import(process.env.PF_EXTRA);
  await extra.default({ page, step, sleep, waitReady });
  fs.writeFileSync(out, JSON.stringify({ ...results, dump: await page.evaluate(() => globalThis.__pfDump()), console: consoleLines.slice(0, 400) }, null, 1));
}
await browser.close();
console.log('done');
