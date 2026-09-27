#!/usr/bin/env node
/**
 * 粒子工作台 · 真 GPU 逐像素对照：同一组输入（效果 + 实例种子 / 锚点 + 场景空间 + 风 + 步长序列 + 相机 + 画布尺寸 + 背景 + 场景深度），
 *
 *   工作台：真页面（`serve.py` + 接入层打的包 + `viewer/view2d.js` → `vfxView.VfxStage`）的原画视图画出来的画布；
 *   游戏  ：`ref.ts`（vite 按游戏模块图编译 `src/`，照游戏组装层 VfxInstanceSim + VfxRenderer + Renderer 的层现拼）画出来的画布；
 *
 * 两边在同一个 Chrome（真显卡 WebGPU）里各跑各的模拟（先比模拟摘要）、各画各的、同任务回读，**必须逐字节相同**。
 * 不同就把两张图与差异热图写进 --out。用的是工程真数据（真场景、真效果、真贴图）；服务开在自检沙箱里
 * （布置库 / 样式库是临时拷贝、游戏地址钉死端口），对照本身什么都不写。
 *
 *   node tools/vfx_workbench/tests/parity/run.mjs --python <python 解释器>      # 自己起工作台服务（--serve --selftest-sandbox）
 *   node tools/vfx_workbench/tests/parity/run.mjs --wb http://127.0.0.1:5490   # 用已经在跑的服务
 *   选项：--out <目录>（缺省系统临时目录）  --case <关键字>  --headed  --browser <exe>  --channel msedge
 *
 * 依赖 playwright-core（`PLAYWRIGHT_CORE` 指到它的包目录）。平台无关：只起子进程与回环端口。
 * 无 GPU 的那一半（逐条 GPU 命令与字节）在 `tools/vfx_workbench/gpu/vfxView.test.ts`（vitest）。
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
const outDir = path.resolve(flag('out', path.join(os.tmpdir(), 'vfx_workbench_parity')));
const only = flag('case', '');
const CLEAR = 0x111318;

/**
 * 用例：普通粒子（纸钱薄片 / 雷符的云与雨，受光外观走无光口径）、光柱（3D 光柱 + 柱里的尘埃，原画深度挡）、落雷（天雷 + 落点那几层）、高分屏。
 * `focus` = 镜头对准锚点、半径（wu）；不给 = 整场。
 */
const CASES = [
  { name: 'paper-money@跑马梁', effect: 'paper_money', scene: '跑马梁', steps: 90, dt: 1 / 60, focus: 260 },
  { name: 'storm-clouds@跑马梁', effect: 'storm_clouds', scene: '跑马梁', steps: 120, dt: 1 / 60 },
  { name: 'storm-rain@跑马梁', effect: 'storm_rain', scene: '跑马梁', steps: 45, dt: 1 / 60, focus: 700 },
  { name: 'beam-dust@bridge_underpass', effect: 'dust_motes', scene: 'bridge_underpass', steps: 150, dt: 1 / 60, focus: 420 },
  { name: 'bolt@bridge_underpass', effect: 'lightning_bolt_01', scene: 'bridge_underpass', steps: 6, dt: 1 / 60 },
  { name: 'bolt-dpr1.5@崖墓前段', effect: 'lightning_bolt_03', scene: '崖墓前段', steps: 9, dt: 1 / 60, focus: 900, dpr: 1.5 },
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

/** 工作台页里：装效果 / 场景、干净地重跑本地预览 N 步、摆相机、画、同任务回读，并把这一帧的全部输入原样导出 */
async function driveWorkbench(c) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch { /* 还没好 */ } await wait(30); }
    return false;
  };
  const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
  const f32b64 = (f) => b64(new Uint8Array(f.buffer, f.byteOffset, f.byteLength));
  const digestOf = (sim) => {
    let sum = 0;
    for (const e of sim.emitters) { const p = e.p; for (let i = 0; i < p.cap; i++) if (p.alive[i]) sum += p.x[i] * 1.3 + p.y[i] * 1.7 + p.z[i] * 1.9 + p.age[i]; }
    return { live: sim.liveCount, sum };
  };
  await until(() => v2.gpu.ok || v2.gpu.err, 30000);
  if (!v2.gpu.ok) throw new Error(`工作台原画视图没拿到 GPU：${v2.gpu.err}`);
  S.link.on = false;
  if (!S.doc || S.doc.id !== c.effect) await openEffect(c.effect, { jump: true });
  await until(() => !S.busy);
  if (!S.scene || S.scene.id !== c.scene || S.phase !== (c.phase || '')) await loadScene(c.scene, c.phase || '');
  await until(() => !S.busy);
  if (!S.doc || S.doc.id !== c.effect || !S.scene || S.scene.id !== c.scene) throw new Error(`装不上 ${c.effect} @ ${c.scene}`);
  if (attachOn() || S.walk.on || S.player.on) throw new Error('本地预览带着角色（挂点 / 来回走 / 玩家）：对照只比没有角色的那一种');
  setView(2);
  await until(() => v2.c.clientWidth > 0);
  resetSim();
  if (!S.sim) throw new Error(`本地预览没建起来：${S.simErr}`);
  for (let i = 0; i < c.steps; i++) stepSim(c.dt);
  if (S.fields.length || S.fires.length || (S.contacts && S.contacts.length)) throw new Error('本地预览里有刺激场 / 火 / 接触：对照只比没有的那一种');
  v2.fit();
  if (c.focus) { const a = S.sim.anchorWorld; v2.focus(S.cal.worldToScene(a[0], a[1], a[2]), c.focus); }
  draw();
  await until(() => v2.gpu.settled, 30000);
  // 渲染器从空状态画这一帧（与参考页同一个起点）：天上那道雷按镜头要的高度往上续算，每续一次多一段折线——
  // 摆镜头途中画过的几帧会让雷形按"历次镜头"分段（游戏里也一样随镜头史变），对照只比"这个镜头下第一次画"
  v2.gpu.stage.clear();
  draw();
  if (v2.gpu.err) throw new Error(`工作台这一帧画坏了：${v2.gpu.err}`);
  const px = v2.gpu.host.readPixels();
  const r = v2.gpu.host.renderer;
  const cal = S.cal;
  let space;
  if (cal.planar) space = { kind: 'planar', k: cal.k };
  else {
    const g = runtimeGeo();
    space = {
      kind: 'field',
      geo: { work: g.work, cal: g.cal, sceneWorld: g.sceneWorld, basisRows: Array.from(g.basisRows), wuPerQUnit: g.wuPerQUnit,
        ground: { w: g.ground.w, h: g.ground.h, data: f32b64(g.ground.data) } },
      shell: cal.shell ? { w: cal.shell.w, h: cal.shell.h, data: f32b64(cal.shell.data), cal: { ppu: cal.ppu, cx: cal.cx, cy: cal.cy }, rows: Array.from(cal.rows) } : null,
    };
  }
  const o = S.sim.options || {};
  let burnDocs = null;
  if (o.burnTemplates) {
    burnDocs = {};
    for (const row of S.burn.rows) if (o.burnTemplates.has(row.id)) burnDocs[row.id] = row.doc;
  }
  return {
    w: px.width, h: px.height, pixels: b64(px.data),
    digest: digestOf(S.sim),
    input: {
      css: [r.screen.width, r.screen.height], dpr: r.resolution,
      cam: { zoom: v2.zoom, ox: v2.ox, oy: v2.oy },
      sceneId: S.scene.id, world: { w: cal.worldW, h: cal.worldH },
      bg: S.layers.mesh && v2.gpu.bgUrl ? { url: v2.gpu.bgUrl, alpha: S.layers.dimMesh ? 0.5 : 1 } : null,
      depthConfig: S.scene.depthConfig || null,
      perspective: S.scene.perspectiveScale || null,
      space,
      sim: { id: S.sim.id, effect: S.sim.effect, anchorWorld: Array.from(S.sim.anchorWorld), seed: S.sim.seed, countScale: S.sim.countScale,
        area: o.area || null, confine: o.confine || null, surfaceKind: o.surfaceKind, burnDocs },
      wind: S.scene.wind || null,
      steps: Array.from({ length: c.steps }, () => c.dt),
    },
    stats: v2.gpu.stage.stats(),
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
      if (!py) throw new Error('要么 --wb <工作台服务地址>，要么 --python <解释器>（自己起 --serve --selftest-sandbox）');
      const port = await freePort();
      // 沙箱目录归这里清理（服务子进程是被硬结束的，它自己的收尾不跑）
      const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'vfxwb_parity_'));
      const child = spawn(py, ['-m', 'tools.vfx_workbench', '--serve', '--port', String(port), '--selftest-sandbox', sandbox],
        { cwd: repoRoot, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }, stdio: 'ignore' });
      cleanups.push(async () => {
        child.kill();
        await new Promise((r) => setTimeout(r, 300));
        fs.rmSync(sandbox, { recursive: true, force: true });
      });
      wb = `http://127.0.0.1:${port}`;
    }
    await waitHttp(`${wb}/api/boot`);
    process.env.VFX_PARITY_WB = wb;
    process.env.VFX_PARITY_PORT = String(await freePort());
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
      await w.waitForFunction(() => window.__ready === true, null, { timeout: 180000 });
      await r.goto(refUrl);
      await r.waitForFunction(() => window.__refReady === true, null, { timeout: 180000 });
      const pair = { w, r };
      pages.set(dpr, pair);
      return pair;
    };

    let bad = 0;
    for (const c of CASES) {
      const { w, r } = await pageFor(c.dpr || 1);
      const got = await w.evaluate(driveWorkbench, c);
      const ref = await r.evaluate((input) => window.__renderRef(input), { ...got.input, background: CLEAR });
      const a = Buffer.from(got.pixels, 'base64');
      const b = Buffer.from(ref.pixels, 'base64');
      const simSame = got.digest.live === ref.digest.live && got.digest.sum === ref.digest.sum;
      let diff = 0;
      let maxd = 0;
      let lit = 0;
      if (got.w !== ref.w || got.h !== ref.h || a.length !== b.length) diff = -1;
      else {
        for (let i = 0; i < a.length; i += 4) {
          const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]), Math.abs(a[i + 3] - b[i + 3]));
          if (d) { diff++; maxd = Math.max(maxd, d); }
          if (Math.abs(a[i] - 0x11) + Math.abs(a[i + 1] - 0x13) + Math.abs(a[i + 2] - 0x18) > 6) lit++;
        }
      }
      const ok = diff === 0 && simSame && lit > 1000 && got.digest.live > 0 && got.stats.drawCalls > 0;
      if (!ok) bad++;
      const base = path.join(outDir, c.name.replace(/[@/\\:]/g, '_'));
      writePng(`${base}.workbench.png`, got.w, got.h, a);
      if (diff !== 0 && ref.w === got.w && ref.h === got.h) {
        writePng(`${base}.game.png`, ref.w, ref.h, b);
        const heat = Buffer.alloc(a.length);
        for (let i = 0; i < a.length; i += 4) {
          const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
          heat[i] = d ? 255 : a[i] >> 2; heat[i + 1] = d ? Math.min(255, d * 16) : a[i + 1] >> 2; heat[i + 2] = a[i + 2] >> 2; heat[i + 3] = 255;
        }
        writePng(`${base}.diff.png`, got.w, got.h, heat);
      }
      console.log(`${ok ? 'SAME' : 'DIFF'}  ${c.name.padEnd(30)} ${got.w}x${got.h}  不同像素 ${diff}${maxd ? `（最大差 ${maxd}）` : ''}  非底色像素 ${lit}`
        + `  模拟 ${simSame ? '同步' : `不同步（工作台 ${JSON.stringify(got.digest)} / 游戏 ${JSON.stringify(ref.digest)}）`}  活粒子 ${got.digest.live}  draw ${got.stats.drawCalls}`);
    }
    console.log(`\n[parity] ${CASES.length - bad}/${CASES.length} 例逐字节相同；截图在 ${outDir}`);
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
