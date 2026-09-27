#!/usr/bin/env node
/**
 * 工作台 RHI 接入层 · 真浏览器跑工作台页面（Chrome + 真 GPU 的 WebGPU）：冒烟与页内自检共用。
 *
 *   node tools/workbench_rhi/chrome_page.mjs --url http://127.0.0.1:5441/ --smoke [--shot out.png]
 *   node tools/workbench_rhi/chrome_page.mjs --url http://127.0.0.1:5441/ --selftest tools/burn_workbench/viewer/tests/selftest.js
 *
 * - `--smoke`：等 `--ready` 表达式为真（缺省 `window.__ready`），再求 `--check` 表达式（缺省 `window.__rhiSmoke?.()`，
 *   页面自己报 `{ok, detail}`：拿到 WebGPU、画面非空之类）；页面报错 / 控制台 error（`--allow` 正则放过的除外）一律算失败；
 *   `--shot` 存一张整页截图。
 * - `--selftest <js>`：页面 load 后注入脚本（与桌面壳 `desktop_shell.run_desktop(selftest=…)` 同一约定：脚本把报告写进
 *   `window.__selftestResult`，每行 PASS / FAIL / EXC / SKIP），原样打印；有 FAIL / EXC 或控制台 error 退出码 1。
 *   `--no-skip` 时 SKIP 也算失败（真 GPU 上不许有"没 WebGPU 跳过"的条目）。自检里故意发的坏请求会让浏览器记
 *   「Failed to load resource: … 4xx」——自检模式下这一类只列出、不算失败（断言由自检自己做）；未捕获异常照样算。
 *
 * 浏览器：缺省 channel chrome（`--channel msedge` 可换，`--browser <exe>` 指定可执行文件），缺省无头（真显卡上无头 Chrome 的
 * WebGPU 可用，2026-09-27 RTX 4070 SUPER 实测），`--headed` 有头。依赖 playwright-core（仓库不装；`PLAYWRIGHT_CORE` 指到它的包目录）。
 * 平台无关：Windows / macOS 同一条命令。
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const url = flag('url', '');
const selftest = flag('selftest', '');
const smoke = has('smoke');
const timeoutMs = Number(flag('timeout', '600')) * 1000;
const readyExpr = flag('ready', 'window.__ready === true');
const checkExpr = flag('check', 'window.__rhiSmoke ? window.__rhiSmoke() : { ok: false, detail: "页面没有 __rhiSmoke" }');
const shot = flag('shot', '');
const allow = flag('allow', '');
const noSkip = has('no-skip');
if (!url || (!selftest && !smoke)) {
  console.error('用法：chrome_page.mjs --url <地址> (--smoke [--shot a.png] | --selftest <js> [--no-skip])');
  process.exit(2);
}

function loadPlaywright() {
  const req = createRequire(import.meta.url);
  const spec = process.env.PLAYWRIGHT_CORE || 'playwright-core';
  try {
    return req(spec);
  } catch (e) {
    console.error(`[chrome_page] 找不到 playwright-core（${spec}）：设环境变量 PLAYWRIGHT_CORE 指到它的包目录`);
    process.exit(3);
  }
}

const { chromium } = loadPlaywright();
const launchOpts = { headless: !has('headed'), args: ['--enable-unsafe-webgpu'] };
const exe = flag('browser', process.env.WORKBENCH_BROWSER || '');
let browser;
try {
  browser = exe ? await chromium.launch({ ...launchOpts, executablePath: exe }) : await chromium.launch({ ...launchOpts, channel: flag('channel', 'chrome') });
} catch (e) {
  console.error(`[chrome_page] 起不来浏览器：${e.message}`);
  process.exit(3);
}

const consoleErrors = [];
const allowRe = allow ? new RegExp(allow) : null;
let exitCode = 0;
try {
  const page = await browser.newPage({ viewport: { width: Number(flag('width', '1600')), height: Number(flag('height', '1000')) }, deviceScaleFactor: Number(flag('dpr', '1')) });
  const resourceRe = /^Failed to load resource: the server responded with a status of 4\d\d/;
  page.on('console', (m) => {
    const text = m.text();
    const tolerated = (allowRe && allowRe.test(text)) || (!!selftest && resourceRe.test(text));
    if (m.type() === 'error' && !tolerated) consoleErrors.push(text);
    if (has('verbose') || m.type() === 'error' || m.type() === 'warning') console.log(`[console.${m.type()}] ${text}`);
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  page.on('dialog', (d) => { console.log(`[dialog] ${d.type()}: ${d.message()}`); void d.dismiss(); });
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });
  const gpu = await page.evaluate(async () => {
    const a = await navigator.gpu?.requestAdapter();
    return a ? { ok: true, vendor: a.info?.vendor ?? '', arch: a.info?.architecture ?? '' } : { ok: false };
  });
  console.log(`[chrome_page] WebGPU 适配器：${gpu.ok ? `${gpu.vendor} ${gpu.arch}` : '没有'}`);

  if (smoke) {
    await page.waitForFunction(readyExpr, null, { timeout: timeoutMs });
    // 图 / 纹理是异步到的：在 --settle 秒内反复求检查式，第一次 ok 就收（一直不 ok 报最后一次）
    const settleMs = Number(flag('settle', '20')) * 1000;
    const t0 = Date.now();
    let r = await page.evaluate(checkExpr);
    while (!(r && r.ok) && Date.now() - t0 < settleMs) {
      await new Promise((res) => setTimeout(res, 250));
      r = await page.evaluate(checkExpr);
    }
    console.log(`[smoke] ${JSON.stringify(r)}`);
    if (shot) {
      fs.mkdirSync(path.dirname(path.resolve(shot)), { recursive: true });
      await page.screenshot({ path: shot });
      console.log(`[smoke] 截图 ${path.resolve(shot)}`);
    }
    if (!r || !r.ok) exitCode = 1;
  } else {
    const src = fs.readFileSync(selftest, 'utf8');
    await page.evaluate(src);
    await page.waitForFunction(() => typeof window.__selftestResult === 'string' && window.__selftestResult.length > 0, null,
      { timeout: timeoutMs, polling: 500 });
    const out = await page.evaluate(() => window.__selftestResult);
    console.log(out);
    const lines = out.split(/\r?\n/).filter((l) => l.trim());
    const bad = lines.filter((l) => l.startsWith('FAIL') || l.startsWith('EXC'));
    const skipped = lines.filter((l) => l.startsWith('SKIP'));
    const passed = lines.filter((l) => l.startsWith('PASS')).length;
    console.log(`[selftest] ${passed} passed, ${bad.length} failed, ${skipped.length} skipped`);
    if (bad.length || (noSkip && skipped.length)) exitCode = 1;
    if (shot) await page.screenshot({ path: shot });
  }
  if (consoleErrors.length) {
    console.log(`[chrome_page] 控制台 error ${consoleErrors.length} 条：`);
    for (const e of consoleErrors) console.log(`  ${e}`);
    exitCode = 1;
  } else {
    console.log('[chrome_page] 控制台无 error');
  }
} catch (e) {
  console.error(`[chrome_page] ${e.stack || e}`);
  exitCode = 1;
} finally {
  await browser.close();
}
process.exit(exitCode);
