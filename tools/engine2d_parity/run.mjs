#!/usr/bin/env node
/**
 * 无头跑渲染像素对照:起 Vite → Chromium 打开对照页(同一页里一个 WebGL、一个 WebGPU 渲染器)→
 * 读 `window.__parity` → 打表;有不一致 / 出错退出码非零。
 *
 * 用法:
 *   node tools/engine2d_parity/run.mjs
 *   node tools/engine2d_parity/run.mjs --case 阴影     # 只跑名字含关键字的用例
 *   node tools/engine2d_parity/run.mjs --browser <chrome/edge 可执行文件> --headed
 *
 * 依赖 playwright-core(仓库不装;装在别处时用环境变量 PLAYWRIGHT_CORE 指到它的包目录)。
 * 没有也行:`npx vite --config tools/engine2d_parity/vite.config.ts`,浏览器打开给出的地址,页面自己出表和缩略图。
 * 对照只用离屏目标,不往画布上屏,所以无头 SwiftShader 也能跑 WebGPU。
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
const browserPath = flag('browser', process.env.E2D_PARITY_BROWSER);
const caseFilter = flag('case', '');
const dumpDir = flag('dump', '');

function loadPlaywright() {
  const base = process.env.PLAYWRIGHT_CORE ? path.join(process.env.PLAYWRIGHT_CORE, 'package.json') : import.meta.url;
  try {
    return createRequire(base)('playwright-core');
  } catch {
    console.error('找不到 playwright-core。装一个(npm i -D playwright-core,或装在别处再用 PLAYWRIGHT_CORE 指过去),');
    console.error('或者手动:npx vite --config tools/engine2d_parity/vite.config.ts,浏览器打开给出的地址。');
    process.exit(2);
  }
}

const { chromium } = loadPlaywright();
const { createServer } = await import('vite');
const server = await createServer({ configFile: path.join(here, 'vite.config.ts'), logLevel: 'warn' });
await server.listen();
const base = server.resolvedUrls.local[0];

let failed = 0;
try {
  const browser = await chromium.launch({
    headless: !args.includes('--headed'),
    args: ['--enable-unsafe-webgpu'],
    ...(browserPath ? { executablePath: browserPath } : { channel: process.platform === 'win32' ? 'msedge' : 'chrome' }),
  });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  const params = new URLSearchParams({ images: dumpDir ? '1' : '0' });
  if (caseFilter) params.set('case', caseFilter);
  await page.goto(`${base}?${params}`);
  await page.waitForFunction(() => window.__parity?.done, null, { timeout: 600_000 });
  const r = await page.evaluate(() => window.__parity);
  if (r.fatal) {
    console.log(`✗ 初始化失败:${r.fatal}`);
    failed++;
  }
  if (dumpDir) {
    const fs = await import('node:fs');
    fs.mkdirSync(dumpDir, { recursive: true });
    r.results.forEach((c, i) => {
      if (!c.images) return;
      for (const k of ['ref', 'cand', 'diff']) {
        fs.writeFileSync(path.join(dumpDir, `${String(i).padStart(2, '0')}_${k}.png`), Buffer.from(c.images[k].split(',')[1], 'base64'));
      }
    });
  }
  for (const c of r.results) {
    const mark = { pass: '✓', fail: '✗', error: '✗' }[c.status];
    console.log(`${mark} ${c.name}\n    ${c.detail.replace(/\n/g, "\n    ")}`);
    if (c.status !== 'pass') failed++;
  }
  for (const e of pageErrors) {
    console.log(`✗ 页面异常:${e}`);
    failed++;
  }
  console.log(`\n一致 ${r.results.filter((c) => c.status === 'pass').length} / 共 ${r.results.length}`);
  await browser.close();
} finally {
  await server.close();
}
process.exit(failed ? 1 : 0);
