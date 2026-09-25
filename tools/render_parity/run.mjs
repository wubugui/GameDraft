#!/usr/bin/env node
/**
 * 无头跑渲染像素对照(master 对本分支):
 *   1. 把基准分支(缺省 origin/master,没有就 master)的 src 与 public/assets/data 用 git archive 抽到
 *      .tools/render_parity_ref/<sha>/(已 gitignore;按提交缓存,基准不动就不重抽);
 *   2. 起两个 Vite 服务:参考(master 的 src + Pixi WebGL)、候选(工作区 src + engine2d WebGPU);
 *   3. Chromium 打开候选服务上的对照页,它开两个 iframe 各画各的、回读后逐像素比;
 *   4. 读 `window.__parity` 打表;有不一致 / 出错退出码非零。
 *
 * 用法:
 *   node tools/render_parity/run.mjs
 *   node tools/render_parity/run.mjs --case 阴影          # 只跑名字含关键字的用例
 *   node tools/render_parity/run.mjs --base <git 提交/分支>  # 换对照基准
 *   node tools/render_parity/run.mjs --browser <chrome/edge 可执行文件> --headed
 *   node tools/render_parity/run.mjs --serve              # 只起两个服务,打印对照页地址,手动在浏览器里看(带缩略图)
 *
 * 依赖 playwright-core(仓库不装;装在别处时用环境变量 PLAYWRIGHT_CORE 指到它的包目录;--serve 不需要)。
 * 对照只用离屏目标,不往画布上屏,所以无头 SwiftShader 也能跑 WebGPU。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const browserPath = flag('browser', process.env.RENDER_PARITY_BROWSER);
const caseFilter = flag('case', '');
const serveOnly = args.includes('--serve');

function git(...a) {
  return execFileSync('git', a, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function resolveBase() {
  const asked = flag('base', '');
  for (const ref of asked ? [asked] : ['origin/master', 'master']) {
    try {
      return { ref, sha: git('rev-parse', '--verify', `${ref}^{commit}`) };
    } catch {
      // 试下一个
    }
  }
  console.error(asked ? `基准 ${asked} 解析不到提交` : '找不到 origin/master 也找不到 master;用 --base 指定对照基准');
  process.exit(2);
}

/** 抽出基准的 src 树(按提交缓存;.complete 标记写完才算数,半截的下次重抽) */
function extractRefTree(sha) {
  const dir = path.join(repoRoot, '.tools', 'render_parity_ref', sha);
  if (fs.existsSync(path.join(dir, '.complete'))) return dir;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const tar = path.join(dir, '..', `${sha}.tar`);
  // src 之外只带 public/assets/data:运行时有一处 import 了其中的 JSON(EntityRuntimeFieldSchema)
  git('archive', '--format=tar', '-o', tar, sha, 'src', 'public/assets/data');
  execFileSync('tar', ['-xf', tar, '-C', dir], { stdio: 'inherit' });
  fs.rmSync(tar, { force: true });
  fs.writeFileSync(path.join(dir, '.complete'), `${sha}\n`);
  return dir;
}

function loadPlaywright() {
  const base = process.env.PLAYWRIGHT_CORE ? path.join(process.env.PLAYWRIGHT_CORE, 'package.json') : import.meta.url;
  try {
    return createRequire(base)('playwright-core');
  } catch {
    console.error('找不到 playwright-core。装一个(npm i -D playwright-core,或装在别处再用 PLAYWRIGHT_CORE 指过去),');
    console.error('或者手动:node tools/render_parity/run.mjs --serve,浏览器打开它给的地址。');
    process.exit(2);
  }
}

const base = resolveBase();
const refRoot = extractRefTree(base.sha);
console.log(`对照基准:${base.ref} @ ${base.sha.slice(0, 10)}(参考树 ${path.relative(repoRoot, refRoot)})`);

const { createServer } = await import('vite');
async function startServer(side) {
  process.env.RENDER_PARITY_SIDE = side;
  process.env.RENDER_PARITY_REF_ROOT = refRoot;
  const server = await createServer({ configFile: path.join(here, 'vite.config.ts'), logLevel: 'warn' });
  await server.listen();
  return server;
}
const refServer = await startServer('ref');
const candServer = await startServer('cand');
const refBase = refServer.resolvedUrls.local[0];
const candBase = candServer.resolvedUrls.local[0];
const params = new URLSearchParams({ ref: refBase });
if (caseFilter) params.set('case', caseFilter);

if (serveOnly) {
  console.log(`对照页:${candBase}?${params}\n(Ctrl+C 结束)`);
  await new Promise(() => {});
}

const { chromium } = loadPlaywright();
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
  page.on('frameattached', (f) => f.page()?.on?.('pageerror', (e) => pageErrors.push(String(e))));
  params.set('images', '0');
  await page.goto(`${candBase}?${params}`);
  await page.waitForFunction(() => window.__parity?.done, null, { timeout: 900_000 });
  const r = await page.evaluate(() => window.__parity);
  if (r.fatal) {
    console.log(`✗ 初始化失败:${r.fatal}`);
    failed++;
  }
  for (const c of r.results) {
    const mark = { pass: '✓', fail: '✗', error: '✗' }[c.status];
    console.log(`${mark} ${c.name}\n    ${c.detail.replace(/\n/g, '\n    ')}`);
    if (c.status !== 'pass') failed++;
  }
  for (const e of pageErrors) {
    console.log(`✗ 页面异常:${e}`);
    failed++;
  }
  console.log(`\n一致 ${r.results.filter((c) => c.status === 'pass').length} / 共 ${r.results.length}`);
  await browser.close();
} finally {
  await refServer.close();
  await candServer.close();
}
process.exit(failed ? 1 : 0);
