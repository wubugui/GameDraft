#!/usr/bin/env node
/**
 * 呼吸工作台 · 真 GPU 逐像素对照：同一组输入（呼吸图 + 表演帧 + "屏"的尺寸 / 分辨率），
 *
 *   工作台：真页面（`serve.py` + 接入层打的包 + `viewer/app.js` → `breathingView.BreathingStage`）——
 *           预览 = 画布同任务回读（`CanvasHost.readPixels`），出片 = 成品尺寸离屏纹理异步回读（`offscreenReadback`，与出片同一条 `capture`）；
 *   游戏  ：`ref.ts`（vite 按游戏模块图编译 `src/`，照游戏组装层 `showBreathingLayer` + 呼吸图 Mesh 现拼）画出来的画布；
 *
 * 两边在同一个 Chrome（真显卡 WebGPU）里各画各的，**必须逐字节相同**，每帧 uniform 也必须相同。不同就把两张图与差异热图写进 --out。
 * 预览对的是游戏画布；出片对的是引擎自己的离屏读法 `extract`（逐字节），另报与游戏画布的差——引擎的画布 pass 为了与 master 的
 * WebGL 逐位一致是上下颠倒光栅化再翻上屏的，离屏纹理不翻，两者在个别像素差 1（容差：最大差 ≤ 1、≤ 0.1% 像素，超了算失败）。
 *
 *   node tools/breathing_workbench/tests/parity/run.mjs --python <python 解释器>      # 自己起样例工程的工作台服务
 *   node tools/breathing_workbench/tests/parity/run.mjs --wb http://127.0.0.1:5481   # 用已经在跑的样例工程服务（--serve --fixture）
 *   node tools/breathing_workbench/tests/parity/run.mjs --wb http://127.0.0.1:5482 --real --asset dream_face_paper
 *        # 真工程的服务（只读：对照只画、只读，不存盘不出片）；--real 显式允许
 *   选项：--out <目录>（缺省系统临时目录）  --case <关键字>  --headed  --browser <exe>  --channel msedge
 *
 * 依赖 playwright-core（`PLAYWRIGHT_CORE` 指到它的包目录）。平台无关：只起子进程与回环端口。
 * 无 GPU 的那一半（逐条 GPU 命令与字节）在 `tools/breathing_workbench/gpu/breathingView.test.ts`（vitest）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePngRgb } from '../../../ab_compare/png.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..', '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const outDir = path.resolve(flag('out', path.join(os.tmpdir(), 'breathing_workbench_parity')));
const only = flag('case', '');
const CLEAR = 0x000000;

/**
 * 用例：预览（页面自己的布局 / 指定 CSS 尺寸与分辨率，含非整数分辨率与"按住看原图"）+ 出片（成品尺寸离屏纹理异步回读）。
 * steps × dt 推进确定性表演（不抖动、跳过第一口深叹，与出片循环同一个起点）；gaspAt = 在第几步猛抽一口气。
 */
const CASES = [
  { name: 'preview-page-layout', kind: 'preview', steps: 45, dt: 1 / 30 },
  { name: 'preview-rest-compare', kind: 'preview', steps: 45, dt: 1 / 30, compare: true, css: [480, 270], dpr: 1 },
  { name: 'preview-inhale-dpr1.5', kind: 'preview', steps: 20, dt: 1 / 30, css: [333.5, 187.625], dpr: 1.5 },
  { name: 'preview-gasp-dpr1.25', kind: 'preview', steps: 30, dt: 1 / 30, gaspAt: 8, css: [640, 360], dpr: 1.25 },
  { name: 'output-t0', kind: 'output', steps: 0, dt: 1 / 15 },
  { name: 'output-exhale', kind: 'output', steps: 70, dt: 1 / 15 },
  { name: 'output-gasp', kind: 'output', steps: 24, dt: 1 / 15, gaspAt: 6 },
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

/** 工作台页里：把表演推到用例那一帧，画（预览 = 画布；出片 = 离屏纹理），回读，并把这一帧交给 GPU 的输入原样导出 */
async function driveWorkbench(c) {
  const S = window.__bw;
  const A = window.__bwApi;
  const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
  if (!S.gpu || !S.gpu.ok) throw new Error(`工作台没拿到 GPU：${S.gpu && S.gpu.err}`);
  if (S.id !== c.asset) await A.openAsset(c.asset);
  if (!S.ready || !S.stage.ready) throw new Error(`呼吸图 ${c.asset} 没装好`);
  S.paused = true;
  const bp = S.rt.breathingParams;
  const params = bp.mergeBreathingParams(bp.defaultBreathingParams(), S.doc.params).params;
  const perf = new S.rt.BreathingPerformance.BreathingPerformance(params, S.def.rig.limits);
  perf.setNoJitter(true);
  perf.skipFirstSigh();
  for (let k = 0; k < c.steps; k++) {
    if (c.gaspAt === k) void perf.gasp();
    perf.step(c.dt);
  }
  const saved = S.perf;
  S.perf = perf;
  S.compare = !!c.compare;
  const input = { frame: perf.frame(), vent: perf.p('vent'), cran: perf.p('cran'), inflate: perf.p('inflate'), sink: perf.p('sink') };
  let px;
  let css;
  let dpr;
  let uniforms = null;
  try {
    if (c.kind === 'output') {
      const tgt = S.rt.offscreenReadback.createOffscreenTarget(S.host, S.def.size[0], S.def.size[1]);
      try { px = await A.capture(tgt); } finally { tgt.destroy(); }
      css = [S.def.size[0], S.def.size[1]];
      dpr = 1;
    } else {
      if (c.css) S.host.resize(c.css[0], c.css[1], c.dpr);   // 与下面的画 + 发读同一个任务：页面的 rAF 插不进来
      A.draw();
      // 回读的拷贝在调用当下就发出；尺寸 / uniform 也在同一个任务里取（await 期间页面的 rAF 会按自己的布局把画布改回去）
      const pending = S.host.readPixels();
      css = [S.host.renderer.screen.width, S.host.renderer.screen.height];
      dpr = S.host.renderer.resolution;
      uniforms = S.stage.currentUniforms();
      px = await pending;
    }
  } finally {
    S.compare = false;
    S.perf = saved;
  }
  return {
    w: px.width, h: px.height, pixels: b64(px.data), css, dpr, uniforms: uniforms ?? S.stage.currentUniforms(),
    input: c.compare ? null : input, phase: input.frame.phase, paperMm: input.frame.paperMm, chest: input.frame.chest,
  };
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
      const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'breathwb_selftest_parity_'));
      const child = spawn(py, ['-m', 'tools.breathing_workbench', '--serve', '--port', String(port), '--fixture', proj],
        { cwd: repoRoot, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }, stdio: 'ignore' });
      cleanups.push(() => { child.kill(); fs.rmSync(proj, { recursive: true, force: true }); });
      wb = `http://127.0.0.1:${port}`;
    }
    await waitHttp(`${wb}/api/boot`);
    const boot = await (await fetch(`${wb}/api/boot`)).json();
    if (boot.real !== false && !args.includes('--real')) throw new Error(`${wb} 不是样例工程服务（real=${boot.real}）：真工程要显式 --real`);
    const list = (await (await fetch(`${wb}/api/breathing`)).json()).breathing || [];
    const asset = flag('asset', boot.real === false ? 'sample_breath' : (list[0] && list[0].id));
    if (!list.some((r) => r.id === asset)) throw new Error(`服务里没有呼吸图 ${asset}`);
    process.env.BREATH_PARITY_WB = wb;
    process.env.BREATH_PARITY_PORT = String(await freePort());
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
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    const w = await ctx.newPage();
    const r = await ctx.newPage();
    const resourceRe = /^Failed to load resource: the server responded with a status of 404/;
    for (const [p, tag] of [[w, 'workbench'], [r, 'ref']]) {
      p.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
      p.on('console', (m) => { if (m.type() === 'error' && !resourceRe.test(m.text())) errors.push(`${tag}: ${m.text()}`); });
    }
    await w.goto(`${wb}/`);
    await w.waitForFunction(() => window.__ready === true && window.__bw && window.__bw.ready, null, { timeout: 180000 });
    await r.goto(refUrl);
    await r.waitForFunction(() => window.__refReady === true, null, { timeout: 120000 });

    const compare = (got, ref) => {
      const a = Buffer.from(got.pixels, 'base64');
      const b = Buffer.from(ref.pixels, 'base64');
      let diff = 0;
      let maxd = 0;
      let lit = 0;
      if (got.w !== ref.w || got.h !== ref.h || a.length !== b.length) diff = -1;
      else {
        for (let i = 0; i < a.length; i += 4) {
          const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]), Math.abs(a[i + 3] - b[i + 3]));
          if (d) { diff++; maxd = Math.max(maxd, d); }
          if (a[i] + a[i + 1] + a[i + 2] > 12) lit++;
        }
      }
      return { a, b, diff, maxd, lit, uniSame: JSON.stringify(got.uniforms) === JSON.stringify(ref.uniforms) };
    };
    const dump = (name, got, ref, cmp) => {
      if (cmp.diff === 0 || ref.w !== got.w || ref.h !== got.h) return;
      writePng(`${name}.game.png`, ref.w, ref.h, cmp.b);
      const { a, b } = cmp;
      const heat = Buffer.alloc(a.length);
      for (let i = 0; i < a.length; i += 4) {
        const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
        heat[i] = d ? 255 : a[i] >> 2; heat[i + 1] = d ? Math.min(255, d * 16) : a[i + 1] >> 2; heat[i + 2] = a[i + 2] >> 2; heat[i + 3] = 255;
      }
      writePng(`${name}.diff.png`, got.w, got.h, heat);
    };
    const line = (cmp) => `不同像素 ${cmp.diff}${cmp.maxd ? `（最大差 ${cmp.maxd}）` : ''}`;

    let bad = 0;
    for (const c of CASES) {
      const got = await w.evaluate(driveWorkbench, { ...c, asset });
      const refIn = { asset, css: got.css, dpr: got.dpr, background: CLEAR, input: got.input };
      // 预览：对游戏画布（上屏那一张）逐字节；出片：对引擎自己的离屏读法（extract）逐字节，另报与画布的差（引擎画布翻转光栅化，见 ref.ts）
      const ref = await r.evaluate((inp) => window.__renderRef(inp), { ...refIn, mode: c.kind === 'output' ? 'extract' : 'canvas' });
      const cmp = compare(got, ref);
      const ok = cmp.diff === 0 && cmp.lit > 100 && cmp.uniSame;
      let extra = '';
      if (c.kind === 'output') {
        const onCanvas = await r.evaluate((inp) => window.__renderRef(inp), { ...refIn, mode: 'canvas' });
        const cc = compare(got, onCanvas);
        const n = got.w * got.h;
        const canvasOk = cc.diff >= 0 && cc.maxd <= 1 && cc.diff <= n * 0.001 && cc.uniSame;
        if (!canvasOk) bad++;
        extra = `  | 对游戏画布：${line(cc)}（${((Math.max(0, cc.diff) / n) * 100).toFixed(4)}%）${canvasOk ? ' 在容差内' : ' 超出容差'}`;
        dump(path.join(outDir, `${c.name}.vs-canvas`), got, onCanvas, cc);
      }
      if (!ok) bad++;
      const base = path.join(outDir, c.name);
      writePng(`${base}.workbench.png`, got.w, got.h, cmp.a);
      dump(base, got, ref, cmp);
      console.log(`${ok ? 'SAME' : 'DIFF'}  ${c.name.padEnd(24)} ${got.w}x${got.h} (css ${got.css.map((v) => +v.toFixed(3)).join('x')} @${got.dpr})`
        + `  对${c.kind === 'output' ? '引擎离屏 extract' : '游戏画布'}：${line(cmp)}  非黑像素 ${cmp.lit}  uniform ${cmp.uniSame ? '相同' : `不同 ${JSON.stringify(got.uniforms)} vs ${JSON.stringify(ref.uniforms)}`}`
        + `  ${c.compare ? '按住看原图' : `${got.phase || '起点'} 胸口 ${got.chest.toFixed(3)} 纸 ${got.paperMm.toFixed(2)}mm`}${extra}`);
    }
    console.log(`\n[parity] 呼吸图 ${asset}：${CASES.length - bad}/${CASES.length} 例逐字节相同；截图在 ${outDir}`);
    if (errors.length) {
      console.log(`[parity] 页面报错 ${errors.length} 条：\n  ${errors.join('\n  ')}`);
      bad++;
    }
    return bad ? 1 : 0;
  } finally {
    for (const f of cleanups.reverse()) { try { await f(); } catch { /* 收尾尽力 */ } }
  }
}

main().then((code) => process.exit(code), (e) => { console.error(`[parity] ${e.stack || e}`); process.exit(1); });
