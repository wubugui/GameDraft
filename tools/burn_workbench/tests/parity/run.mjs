#!/usr/bin/env node
/** Workbench WebGPU vs frozen master BurnGL: opaque canvas channel threshold 1 (existing migration rule), five existing inputs.
 * Exact equality is also reported; no differing pixel may exceed 1 in any RGBA channel.
 * Usage: node tools/burn_workbench/tests/parity/run.mjs --python <python> --out <fresh directory>
 * Test-only master provenance is in legacy-source.json; full independent tool A/B is separate.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePngRgb } from '../../../ab_compare/png.mjs';
import { compareCanvasRgba } from './compare.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const outDir = path.resolve(flag('out', path.join(os.tmpdir(), 'burn_workbench_parity')));
const only = flag('case', '');


/** 用例：原画视图三张（火线发光 / 焦黑成灰 / 消耗燃烧的蜡烛）+ 场景视图一张（背景 + 三个热点，NPC 在画面外）+ 高分屏 */
const CASES = [
  { name: 'art-paper-t1-fireline', template: 'paper_pile', ignite: 'point', dt: 0.05, steps: 20, cam: { k: 4.5, ox: 40.25, oy: 60.5 } },
  { name: 'art-paper-t6-char-ash', template: 'paper_pile', ignite: 'point', dt: 0.25, steps: 24, cam: null },
  { name: 'art-candle-t5-consume', template: 'candle_red', ignite: 'all', dt: 0.25, steps: 20, cam: { k: 6, ox: 300.5, oy: 40 } },
  { name: 'scene-room-t2.5', scene: 'zz_burn_room', entity: 'hs_paper', ignite: 'point', dt: 0.1, steps: 25, cam: { k: 1.2, ox: -540, oy: -360 } },
  { name: 'art-paper-t2-dpr1.5', template: 'paper_pile', ignite: 'point', dt: 0.1, steps: 20, cam: { k: 3.25, ox: 20, oy: 30 }, dpr: 1.5 },
].filter((c) => !only || c.name.includes(only));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

async function waitHttp(url, ms = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status < 500) return;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${url} ${ms / 1000} 秒内没起来`);
}

/** 工作台页里：把视图摆到用例那一帧，画，同任务回读画布，并把这一帧交给 GPU 的输入原样导出 */
async function driveWorkbench(c) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 10000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch { /* 还没好 */ } await wait(30); }
    return false;
  };
  const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
  if (!V.gpu || !V.gpu.ok) throw new Error(`工作台没拿到 GPU：${V.gpu && V.gpu.err}`);
  if (c.scene) {
    if (!S.sv || S.sv.sceneId !== c.scene) await openSceneView(c.scene, c.entity);
    await until(() => S.sv && S.sv.scene && P.sc.items.length > 0);
    selectEntity(c.entity);
  } else {
    if (S.sv) closeSceneView();
    if (S.docId !== c.template) await openTemplate(c.template);
    await until(() => artSize() && P.art && P.art.id === S.docId && P.art.grid);
  }
  if (P.buildPromise) await P.buildPromise;
  await until(() => !S.busy && !P.buildPromise);
  restartPreview();
  if (c.ignite) previewIgnite(c.ignite === 'all');
  for (let i = 0; i < c.steps; i++) stepPreview(c.dt);
  const view = c.scene ? 'scene' : 'art';
  const fitKey = c.scene ? `s:${S.sv.scene.id}` : `a:${S.docId}`;
  if (c.cam) Object.assign(V.cam[view], c.cam, { fitKey });
  draw();
  await until(() => V.gpu.pendingTextures === 0);
  draw();
  // 回读的拷贝在调用当下就发出；这一帧的其余输入也要在同一个任务里取完（await 期间页面的 rAF 可能改画布尺寸 / 状态）
  const pxPending = V.gpu.host.readPixels();
  const cam = V.cam[view];
  const items = V.gpu.items.map((it) => {
    let screen = null;
    if (it.kind === 'frame') {
      const f = it.frame;
      screen = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) => [(f.ox + u * f.ux + v * f.vx) * cam.k + cam.ox, (f.oy + u * f.uy + v * f.vy) * cam.k + cam.oy]);
    }
    let burn = null;
    if (it.burn) {
      const field = new Uint8Array(it.burn.gridW * it.burn.gridH * 4);
      it.burn.encode(field);
      burn = { gridW: it.burn.gridW, gridH: it.burn.gridH, field: b64(field), params: it.burn.params };
    }
    return { key: it.key, kind: it.kind, url: it.url, def: it.def || null, screen, burn };
  });
  const out = {
    input: {
      css: [V.gpu.cssWidth, V.gpu.cssHeight], dpr: V.gpu.host.renderer.resolution,
      cam: { k: cam.k, ox: cam.ox, oy: cam.oy },
      bg: V.gpu.bg ? { url: V.gpu.bg.url, w: V.gpu.bg.w, h: V.gpu.bg.h } : null,
      perspective: S.sv && S.sv.scene ? S.sv.scene.perspectiveScale : null,
      items,
    },
    burning: items.filter((i) => i.burn).map((i) => i.key),
  };
  const px = await pxPending;
  return { w: px.width, h: px.height, pixels: b64(px.data), ...out };
}

function writePng(file, w, h, rgba) {
  const rgb = Buffer.alloc(w * h * 3);
  for (let i = 0, j = 0; i < w * h; i++, j += 3) { rgb[j] = rgba[i * 4]; rgb[j + 1] = rgba[i * 4 + 1]; rgb[j + 2] = rgba[i * 4 + 2]; }
  fs.writeFileSync(file, encodePngRgb(w, h, rgb));
}

async function main() {
  const req = createRequire(import.meta.url);
  let pw;
  try { pw = req(process.env.PLAYWRIGHT_CORE || 'playwright-core'); } catch {
    console.error('[parity] 找不到 playwright-core：设 PLAYWRIGHT_CORE 指到它的包目录');
    process.exit(3);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const cleanups = [];
  let wb = flag('wb', '');
  try {
    if (!wb) {
      const py = flag('python', process.env.PYTHON || '');
      if (!py) throw new Error('要么 --wb <样例工程服务地址>，要么 --python <解释器>（自己起 --serve --fixture）');
      const port = await freePort();
      const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'burnwb_selftest_parity_'));
      const child = spawn(py, ['-m', 'tools.burn_workbench', '--serve', '--port', String(port), '--fixture', proj],
        { cwd: repoRoot, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }, stdio: 'ignore' });
      cleanups.push(() => { child.kill(); fs.rmSync(proj, { recursive: true, force: true }); });
      wb = `http://127.0.0.1:${port}`;
    }
    await waitHttp(`${wb}/api/boot`);
    const boot = await (await fetch(`${wb}/api/boot`)).json();
    if (boot.real !== false) throw new Error(`${wb} 不是样例工程服务（real=${boot.real}）：对照只许在临时工程上跑`);
    process.env.BURN_PARITY_WB = wb;
    process.env.BURN_PARITY_PORT = String(await freePort());
    const { createServer } = await import('vite');
    const vite = await createServer({ configFile: path.join(here, 'vite.config.ts') });
    await vite.listen();
    cleanups.push(() => vite.close());
    const refUrl = vite.resolvedUrls.local[0];

    const exe = flag('browser', '');
    const launch = { headless: !args.includes('--headed'), args: ['--enable-unsafe-webgpu'] };
    const browser = exe ? await pw.chromium.launch({ ...launch, executablePath: exe }) : await pw.chromium.launch({ ...launch, channel: flag('channel', 'chrome') });
    cleanups.push(() => browser.close());
    const errors = [];
    const pages = new Map();
    const pageFor = async (dpr) => {
      if (pages.has(dpr)) return pages.get(dpr);
      const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: dpr });
      const w = await ctx.newPage();
      const r = await ctx.newPage();
      for (const [p, tag] of [[w, 'workbench'], [r, 'ref']]) {
        p.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
        p.on('console', (m) => { if (m.type() === 'error') errors.push(`${tag}: ${m.text()}`); });
      }
      await w.goto(`${wb}/`);
      await w.waitForFunction(() => window.__ready === true && V.gpu && (V.gpu.ok || V.gpu.err), null, { timeout: 120000 });
      await r.goto(refUrl);
      await r.waitForFunction(() => window.__refReady === true, null, { timeout: 120000 });
      const pair = { w, r };
      pages.set(dpr, pair);
      return pair;
    };

    let bad = 0;
    const reports = [];
    for (const c of CASES) {
      const { w, r } = await pageFor(c.dpr || 1);
      const got = await w.evaluate(driveWorkbench, c);
      const ref = await r.evaluate((input) => window.__renderRef(input), got.input);
      const a = Buffer.from(got.pixels, 'base64');
      const b = Buffer.from(ref.pixels, 'base64');
      const comparison = compareCanvasRgba({ width: got.w, height: got.h, data: a }, { width: ref.w, height: ref.h, data: b });
      const diff = comparison.diffPixels;
      const maxd = comparison.maxChannelDiff;
      let lit = 0;
      for (let i = 0; i < a.length; i += 4) {
        if (Math.abs(a[i] - 17) + Math.abs(a[i + 1] - 17) + Math.abs(a[i + 2] - 19) > 6) lit++;
      }
      const ok = comparison.passed && lit > 100 && got.burning.length > 0;
      reports.push({ case: c.name, width: got.w, height: got.h, comparison, lit, burning: got.burning, passed: ok,
        referenceContext: ref.context, referenceRenderer: ref.renderer });
      if (!ok) bad++;
      const base = path.join(outDir, c.name);
      writePng(`${base}.workbench.png`, got.w, got.h, a);
      writePng(`${base}.legacy-tool.png`, ref.w, ref.h, b);
      if (diff !== 0 && ref.w === got.w && ref.h === got.h) {
        const heat = Buffer.alloc(a.length);
        for (let i = 0; i < a.length; i += 4) {
          const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
          heat[i] = d ? 255 : a[i] >> 2; heat[i + 1] = d ? Math.min(255, d * 16) : a[i + 1] >> 2; heat[i + 2] = a[i + 2] >> 2; heat[i + 3] = 255;
        }
        writePng(`${base}.diff.png`, got.w, got.h, heat);
      }
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(26)} ${got.w}x${got.h}  exactEqual=${comparison.exactEqual} 不同像素 ${diff} 最大差 ${maxd} 超1像素 ${comparison.pixelsOver1}  非底色像素 ${lit}  在烧 ${got.burning.join(',') || '无'}`);
    }
    console.log(`\n[parity] ${CASES.length - bad}/${CASES.length} 例每通道差 ≤1；exactEqual 单列，截图在 ${outDir}`);
    if (errors.length) {
      console.log(`[parity] 页面报错 ${errors.length} 条：\n  ${errors.join('\n  ')}`);
      bad++;
    }
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({
      oracle: 'frozen master BurnGL pipeline; full independent A/B is a separate gate', threshold: 1,
      reports, errors, exit: bad ? 1 : 0,
    }, null, 2) + '\n');
    return bad ? 1 : 0;
  } finally {
    for (const f of cleanups.reverse()) { try { await f(); } catch { /* 收尾尽力 */ } }
  }
}

main().then((code) => process.exit(code), (e) => { console.error(`[parity] ${e.stack || e}`); process.exit(1); });
