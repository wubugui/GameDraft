#!/usr/bin/env node
/**
 * 无头跑 RHI 冒烟页:起 Vite → 用 Chromium 内核浏览器分别以 WebGPU / WebGL2 打开 → 读 `window.__rhiSmoke`
 * → 打表,有失败退出码非零。
 *
 * 用法:
 *   node tools/rhi_smoke/run.mjs                        # 两个后端都跑
 *   node tools/rhi_smoke/run.mjs --backend webgl2
 *   node tools/rhi_smoke/run.mjs --browser <chrome/edge 可执行文件>
 *   node tools/rhi_smoke/run.mjs --case 渲染图 --verbose   # 只跑名字含关键字的用例,打印浏览器控制台错误
 *
 * 依赖 playwright-core(仓库不装;装在别处时用环境变量 PLAYWRIGHT_CORE 指到它的包目录)。
 * 没有也行:`npx vite --config tools/rhi_smoke/vite.config.ts` 起服,浏览器里直接开,页面自己出表。
 * 浏览器缺省:Windows 用 Edge,其他用 Chrome;无头 Linux 上 WebGPU 走 SwiftShader,需要 `--enable-unsafe-webgpu`(已带)。
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const backends = String(flag('backend', 'webgpu,webgl2')).split(',');
const browserPath = flag('browser', process.env.RHI_SMOKE_BROWSER);
const caseFilter = flag('case', '');

function loadPlaywright() {
  const base = process.env.PLAYWRIGHT_CORE ? path.join(process.env.PLAYWRIGHT_CORE, 'package.json') : import.meta.url;
  try {
    return createRequire(base)('playwright-core');
  } catch {
    console.error('找不到 playwright-core。装一个(npm i -D playwright-core,或装在别处再用 PLAYWRIGHT_CORE 指过去),');
    console.error('或者手动:npx vite --config tools/rhi_smoke/vite.config.ts,浏览器打开给出的地址。');
    process.exit(2);
  }
}

const { chromium } = loadPlaywright();
const { createServer } = await import('vite');
const server = await createServer({ configFile: path.join(here, 'vite.config.ts'), logLevel: 'warn' });
await server.listen();
const base = server.resolvedUrls.local[0];

const launch = {
  headless: !args.includes('--headed'),
  args: ['--enable-unsafe-webgpu'],
  ...(browserPath ? { executablePath: browserPath } : { channel: process.platform === 'win32' ? 'msedge' : 'chrome' }),
};

let failed = 0;
try {
  const browser = await chromium.launch(launch);
  for (const backend of backends) {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    const consoleErrors = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
    await page.goto(`${base}?backend=${backend}${caseFilter ? `&case=${encodeURIComponent(caseFilter)}` : ''}`);
    await page.waitForFunction(() => window.__rhiSmoke?.done, null, { timeout: 300_000 });
    const r = await page.evaluate(() => window.__rhiSmoke);
    console.log(`\n══ ${backend} ══ 实际后端:${r.backend ?? '无'} · ${r.renderer}`);
    if (r.fatal) {
      console.log(`  ✗ 设备创建失败:${r.fatal}`);
      failed++;
    } else if (r.backend !== backend) {
      console.log(`  ✗ 请求 ${backend} 却得到 ${r.backend}`);
      failed++;
    }
    for (const c of r.results) {
      const mark = { pass: '✓', fail: '✗', skip: '–' }[c.status];
      console.log(`  ${mark} ${c.name}(${c.ms}ms)${c.detail ? `\n      ${c.detail.replace(/\n/g, '\n      ')}` : ''}`);
      if (c.status === 'fail') failed++;
    }
    if (args.includes('--verbose')) for (const e of consoleErrors) console.log(`  · 控制台:${e}`);
    for (const e of pageErrors) {
      console.log(`  ✗ 页面异常:${e}`);
      failed++;
    }
    await page.close();
  }
  await browser.close();
} finally {
  await server.close();
}
console.log(failed ? `\n失败 ${failed} 项` : '\n全部通过');
process.exit(failed ? 1 : 0);
