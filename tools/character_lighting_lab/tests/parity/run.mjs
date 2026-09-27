#!/usr/bin/env node
/**
 * 角色照明实验室 · 真 GPU 逐像素对照:同一组输入(本机工作台按游戏格式现场变换的虚拟载荷 + 脚点 / 角色高 + 着色参数 + 相机 +
 * 画布尺寸 / 分辨率 + 背景),
 *
 *   实验室:真页面(`serve.py` + 接入层打的包 + `viewer/app.js` → `gpu/charLabView.ts` 的 CharLabStage)画出来的 2D 画布;
 *   游戏  :`ref.ts`(vite 按游戏模块图编译 `src/`,照游戏组装层 SceneDepthSystem + CharacterLightingSystem + LitSpriteQuad 现拼)画出来的画布;
 *
 * 两边在同一个 Chrome(真显卡 WebGPU)里各画各的、同任务回读,**必须逐字节相同**。不同就把两张图与差异热图写进 --out。
 * 用的是**真工程数据**:本机实验室工作台(`tools/character_lighting_lab/out/`)里已烘过的场景;一个都没有 ⇒ 退出码 4(pytest 记 skip)。
 *
 *   node tools/character_lighting_lab/tests/parity/run.mjs --python <python 解释器>      # 自己起实验室服务
 *   node tools/character_lighting_lab/tests/parity/run.mjs --lab http://127.0.0.1:5531   # 用已经在跑的服务
 *   选项:--out <目录>(缺省系统临时目录) --scene <场景 id> --case <关键字> --headed --channel msedge
 *
 * 依赖 playwright-core(`PLAYWRIGHT_CORE` 指到它的包目录)。平台无关:只起子进程与回环端口。
 * 无 GPU 的那一半(逐条 GPU 命令与字节)在 `tools/character_lighting_lab/gpu/charLabView.test.ts`(vitest)。
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
const outDir = path.resolve(flag('out', path.join(os.tmpdir(), 'charlab_parity')));
const only = flag('case', '');
const CLEAR = [10, 13, 15];

/** 用例:三种 probe 档 + RT、遮挡开关、法线视图、放大、合成参数改了(虚拟载荷换一份)、预览亮度 2 + 高分屏 */
const CASES = [
  { name: 'L1-occlusion', mode: 1, occl: true },
  { name: 'BIN-zoom2', mode: 3, occl: false, zoom: 2 },
  { name: 'SH-normals', mode: 2, occl: true, normal: true },
  { name: 'RT-nee-missnorm', mode: 0, occl: true, nee: true, missMode: true, spp: 24 },
  { name: 'BIN-amb0.4-nee', mode: 3, occl: true, amb: 0.4, nee: true },
  { name: 'L1-gain2-dpr1.5', mode: 1, occl: true, pgainEv: 1, dpr: 1.5 },
].filter((c) => !only || c.name.includes(only));
// 调试用:CHARLAB_PARITY_CASES='[{"name":"x","mode":1,"occl":true}]' 整张换掉用例表
if (process.env.CHARLAB_PARITY_CASES) CASES.splice(0, CASES.length, ...JSON.parse(process.env.CHARLAB_PARITY_CASES));

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

/** 实验室页里:把视图摆到用例那一帧,画,同任务回读 GPU 画布,并把这一帧交给 GPU 的输入原样导出 */
async function driveLab(c) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 90000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch { /* 还没好 */ } await wait(50); }
    throw new Error('等不到:' + fn);
  };
  const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };
  if (!V.host || !V.stage) throw new Error(`实验室没拿到 GPU:${V.err}`);
  if (!S.man || S.man.name !== c.scene) {
    const sel = document.getElementById('scene'); sel.value = c.scene; sel.dispatchEvent(new Event('change'));
  }
  await until(() => V.sceneReady === c.scene && V.stage.loaded && !V.payloadPending);
  setView(0);
  const box = (id, on) => { const el = document.getElementById(id); if (el.checked !== !!on) { el.checked = !!on; el.dispatchEvent(new Event('change')); } };
  box('nee', c.nee); setSlider('amb', c.amb ?? 1); box('missnorm', c.missMode);
  box('dbg_occl', c.occl); box('dbg_normal', c.normal);
  setSlider('contact', 0);                 // 实验室接触阴影不进游戏:对照里不画
  setSlider('pgain', c.pgainEv ?? 0);
  setSlider('spp', c.spp ?? 64);
  const bg = document.getElementById('bgview'); bg.value = '0'; bg.dispatchEvent(new Event('change'));
  setMode(c.mode);
  await wait(400);                         // nee / amb 改了 → 250ms 后重装虚拟载荷
  await until(() => !V.payloadPending && V.stage.loaded);
  await V.stage.requestMode(c.mode);
  await until(() => V.stage.mode === c.mode);
  const f0 = footScene();
  S.v2 = c.zoom ? { zoom: c.zoom, ox: Math.max(0, f0.x - S.work.w / c.zoom / 2), oy: Math.max(0, f0.y - f0.hPx * 0.6 - S.work.h / c.zoom / 2) } : { zoom: 1, ox: 0, oy: 0 };
  clamp2D();
  draw2D();
  const px = V.host.readPixels();
  const frame = labFrame();
  const g = sceneInfo(S.man.name);
  const bgIn = V.bgView && !(S.bgview === 0 && Math.abs(S.pgain - 1) < 1e-9)
    ? { w: V.bgView.source.pixelWidth, h: V.bgView.source.pixelHeight, pixels: b64(new Uint8Array(V.bgView.source.resource.buffer, V.bgView.source.resource.byteOffset, V.bgView.source.resource.byteLength)), nearest: V.bgView.source.scaleMode === 'nearest' }
    : { url: V.bgTexUrl };
  return {
    w: px.width, h: px.height, pixels: b64(px.data),
    input: {
      css: [V.host.renderer.screen.width, V.host.renderer.screen.height], dpr: V.host.renderer.resolution, background: 0x0a0d0f,
      scene: { sceneId: S.man.name, bgImage: (g && g.bg) || 'background.png', baseUrl: payloadBase(S.man.name), work: S.man.work, native: S.man.native, wuPerQUnit: S.man.cal.ppu },
      frame: { camera: frame.camera, foot: frame.foot, heightPx: frame.heightPx, occlusion: frame.occlusion, shading: frame.shading },
      bg: bgIn, charColor: '/char/albedo.png', charNormal: '/char/normal.png',
    },
    lab: { mode: V.stage.mode, loaded: V.stage.loaded, err: V.host.lastError || '' },
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
    console.error('[parity] 找不到 playwright-core:设 PLAYWRIGHT_CORE 指到它的包目录');
    return 3;
  }
  fs.mkdirSync(outDir, { recursive: true });
  const cleanups = [];
  let lab = flag('lab', '');
  try {
    if (!lab) {
      const py = flag('python', process.env.PYTHON || '');
      if (!py) throw new Error('要么 --lab <实验室服务地址>,要么 --python <解释器>(自己起 --serve)');
      const port = await freePort();
      const child = spawn(py, ['-m', 'tools.character_lighting_lab', '--serve', '--port', String(port), '--no-open'],
        { cwd: repoRoot, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }, stdio: 'ignore' });
      cleanups.push(() => child.kill());
      lab = `http://127.0.0.1:${port}`;
    }
    await waitHttp(`${lab}/api/boot`, 300000);
    const baked = await (await fetch(`${lab}/api/scenes`)).json();
    if (!baked.length) { console.log('[parity] 本机实验室工作台里没有已烘场景(out/ 是逐机器的本地产物)'); return 4; }
    const want = flag('scene', '');
    const pick = baked.find((m) => m.name === want) || baked.find((m) => m.name === '雾津街头') || baked[0];
    const scene = pick.name;
    process.env.CHARLAB_PARITY_LAB = lab;
    process.env.CHARLAB_PARITY_PORT = String(await freePort());
    const { createServer } = await import('vite');
    const vite = await createServer({ configFile: path.join(here, 'vite.config.ts') });
    await vite.listen();
    cleanups.push(() => vite.close());
    const refUrl = vite.resolvedUrls.local[0];

    const launch = { headless: !args.includes('--headed'), args: ['--enable-unsafe-webgpu'] };
    const exe = flag('browser', '');
    const browser = exe ? await pw.chromium.launch({ ...launch, executablePath: exe }) : await pw.chromium.launch({ ...launch, channel: flag('channel', 'chrome') });
    cleanups.push(() => browser.close());
    const errors = [];
    const pages = new Map();
    const pageFor = async (dpr) => {
      if (pages.has(dpr)) return pages.get(dpr);
      const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: dpr });
      const w = await ctx.newPage();
      const r = await ctx.newPage();
      for (const [p, tag] of [[w, 'lab'], [r, 'ref']]) {
        p.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
        p.on('console', (m) => {
          const t = m.text();
          if (m.type() === 'error' && !/^Failed to load resource: the server responded with a status of 404/.test(t)) errors.push(`${tag}: ${t}`);
        });
      }
      await w.goto(`${lab}/`);
      await w.waitForFunction(() => window.__ready === true, null, { timeout: 300000 });
      await r.goto(refUrl);
      await r.waitForFunction(() => window.__refReady === true, null, { timeout: 300000 });
      const pair = { w, r };
      pages.set(dpr, pair);
      return pair;
    };

    let bad = 0;
    for (const c of CASES) {
      const { w, r } = await pageFor(c.dpr || 1);
      const got = await w.evaluate(driveLab, { ...c, scene });
      const ref = await r.evaluate((input) => window.__renderRef(input), got.input);
      const a = Buffer.from(got.pixels, 'base64');
      const b = Buffer.from(ref.pixels, 'base64');
      let diff = 0, maxd = 0, lit = 0;
      if (got.w !== ref.w || got.h !== ref.h || a.length !== b.length) diff = -1;
      else {
        for (let i = 0; i < a.length; i += 4) {
          const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]), Math.abs(a[i + 3] - b[i + 3]));
          if (d) { diff++; maxd = Math.max(maxd, d); }
          if (Math.abs(a[i] - CLEAR[0]) + Math.abs(a[i + 1] - CLEAR[1]) + Math.abs(a[i + 2] - CLEAR[2]) > 6) lit++;
        }
      }
      const ok = diff === 0 && lit > a.length / 8 && got.lab.loaded && got.lab.mode === c.mode && !got.lab.err;
      if (!ok) bad++;
      const base = path.join(outDir, c.name);
      writePng(`${base}.lab.png`, got.w, got.h, a);
      if (diff !== 0 && ref.w === got.w && ref.h === got.h) {
        writePng(`${base}.game.png`, ref.w, ref.h, b);
        const heat = Buffer.alloc(a.length);
        for (let i = 0; i < a.length; i += 4) {
          const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
          heat[i] = d ? 255 : a[i] >> 2; heat[i + 1] = d ? Math.min(255, d * 16) : a[i + 1] >> 2; heat[i + 2] = a[i + 2] >> 2; heat[i + 3] = 255;
        }
        writePng(`${base}.diff.png`, got.w, got.h, heat);
      }
      console.log(`${ok ? 'SAME' : 'DIFF'}  ${c.name.padEnd(20)} ${scene} ${got.w}x${got.h}  不同像素 ${diff}${maxd ? `(最大差 ${maxd})` : ''}  非底色像素 ${lit}  档 ${got.lab.mode}${got.lab.err ? '  设备错误 ' + got.lab.err : ''}`);
    }
    console.log(`\n[parity] ${CASES.length - bad}/${CASES.length} 例逐字节相同;截图在 ${outDir}`);
    if (errors.length) {
      console.log(`[parity] 页面报错 ${errors.length} 条:\n  ${errors.join('\n  ')}`);
      bad++;
    }
    return bad ? 1 : 0;
  } finally {
    for (const f of cleanups.reverse()) { try { await f(); } catch { /* 收尾尽力 */ } }
  }
}

main().then((code) => process.exit(code), (e) => { console.error(`[parity] ${e.stack || e}`); process.exit(1); });
