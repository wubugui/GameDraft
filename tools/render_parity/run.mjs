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
 *   node tools/render_parity/run.mjs --channel chrome     # 用哪个已装浏览器(缺省 Windows msedge、其余 chrome)
 *   node tools/render_parity/run.mjs --port 5460          # 参考服务端口(候选 +1);缺省 5192 / 5198,被占往后找
 *   node tools/render_parity/run.mjs --browser-arg=--use-webgpu-adapter=d3d11   # 追加浏览器启动参数(可多次)
 *   node tools/render_parity/run.mjs --json out.json      # 结果(不含缩略图)另存一份 JSON
 *   node tools/render_parity/run.mjs --fallback-adapter   # 候选侧 WebGPU 强制取回落适配器(Chrome 里 = SwiftShader)。
 *       Windows 上参考侧照旧是显卡(再加 --use-angle=swiftshader 连回落适配器都拿不到),两侧不是同一实现,只作参考、不可比
 *   node tools/render_parity/run.mjs --mutants            # 变异自检:按 mutants.json 逐条把运行时源改坏一处(只改候选侧
 *                                                         # 内存里的源),要求它点名的用例当场变红;--case 按变异 id / 用例名筛
 *   node tools/render_parity/run.mjs --serve --mutate <id> # 手动看某条变异
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
const runMutants = args.includes('--mutants');
const fallbackAdapter = args.includes('--fallback-adapter');
const channel = flag('channel', process.platform === 'win32' ? 'msedge' : 'chrome');
const portBase = Number(flag('port', process.env.RENDER_PARITY_PORT ?? '')) || 0;
const jsonPath = flag('json', '');
const browserArgs = args.filter((a) => a.startsWith('--browser-arg=')).map((a) => a.slice('--browser-arg='.length));

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
  // 相对路径 + cwd:Windows 上 PATH 里可能是 Git 自带的 GNU tar,它把 `D:\...` 里的 `D:` 当远端主机名
  execFileSync('tar', ['-xf', path.basename(tar), '-C', path.relative(path.dirname(tar), dir)], {
    stdio: 'inherit', cwd: path.dirname(tar),
  });
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
async function startServer(side, mutant = '') {
  process.env.RENDER_PARITY_SIDE = side;
  process.env.RENDER_PARITY_REF_ROOT = refRoot;
  if (portBase) process.env.RENDER_PARITY_PORT = String(portBase);
  process.env.RENDER_PARITY_MUTATE = side === 'cand' ? mutant : '';
  const server = await createServer({ configFile: path.join(here, 'vite.config.ts'), logLevel: 'warn' });
  await server.listen();
  return server;
}
const refServer = await startServer('ref');
const refBase = refServer.resolvedUrls.local[0];
const pageParams = (caseQuery) => {
  const p = new URLSearchParams({ ref: refBase });
  if (caseQuery) p.set('case', caseQuery);
  return p;
};

if (serveOnly) {
  const candServer = await startServer('cand', flag('mutate', ''));
  console.log(`对照页:${candServer.resolvedUrls.local[0]}?${pageParams(caseFilter)}\n(Ctrl+C 结束)`);
  await new Promise(() => {});
}

/** 起一个候选服务(可带变异)、开一个新浏览器上下文跑完对照页,返回 window.__parity 与页面异常 */
async function runOnce(browser, caseQuery, mutant = '') {
  const candServer = await startServer('cand', mutant);
  const context = await browser.newContext();
  if (fallbackAdapter) {
    // RHI 取适配器不带选项;这里在每个 frame 里把 requestAdapter 包一层,强制回落适配器(只影响本对照页)
    await context.addInitScript(() => {
      const gpu = navigator.gpu;
      if (!gpu) return;
      const orig = gpu.requestAdapter.bind(gpu);
      gpu.requestAdapter = (o) => orig({ ...(o ?? {}), forceFallbackAdapter: true });
    });
  }
  try {
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('frameattached', (f) => f.page()?.on?.('pageerror', (e) => pageErrors.push(String(e))));
    const params = pageParams(caseQuery);
    params.set('images', '0');
    await page.goto(`${candServer.resolvedUrls.local[0]}?${params}`);
    await page.waitForFunction(() => window.__parity?.done, null, { timeout: 900_000 });
    const report = await page.evaluate(() => window.__parity);
    // 证据:两侧各自跑在什么适配器上(WebGPU 适配器信息 / WebGL 的 UNMASKED_RENDERER)
    const adapters = await page.evaluate(async () => {
      const a = await navigator.gpu?.requestAdapter();
      const i = a?.info ?? {};
      const gl = document.createElement('canvas').getContext('webgl2');
      const ext = gl?.getExtension('WEBGL_debug_renderer_info');
      return {
        webgpu: a ? [i.vendor, i.architecture, i.description, i.backend, i.d3dShaderModel && `SM${i.d3dShaderModel}`].filter(Boolean).join(' / ') : '(无 WebGPU 适配器)',
        webgl: gl ? String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER)) : '(无 WebGL2)',
      };
    });
    return { report, pageErrors, adapters };
  } finally {
    await context.close();
    await candServer.close();
  }
}

function printReport({ report: r, pageErrors }, verbose = true) {
  let failed = 0;
  if (r.fatal) {
    console.log(`✗ 初始化失败:${r.fatal}`);
    failed++;
  }
  for (const c of r.results) {
    const mark = { pass: '✓', fail: '✗', error: '✗' }[c.status];
    if (verbose || c.status !== 'pass') console.log(`${mark} ${c.name}\n    ${c.detail.replace(/\n/g, '\n    ')}`);
    if (c.status !== 'pass') failed++;
  }
  for (const e of pageErrors) {
    console.log(`✗ 页面异常:${e}`);
    failed++;
  }
  return failed;
}

const { chromium } = loadPlaywright();
let failed = 0;
const jsonOut = { base: base.sha, browser: browserPath || channel, browserArgs, adapters: null, results: null, mutants: [] };
try {
  const browser = await chromium.launch({
    headless: !args.includes('--headed'),
    args: ['--enable-unsafe-webgpu', '--enable-webgpu-developer-features', ...browserArgs],
    ...(browserPath ? { executablePath: browserPath } : { channel }),
  });
  try {
    if (runMutants) {
      // 变异自检:每条变异只跑它点名的用例;至少一条变红才算「抓住」,否则整轮失败
      const MUTANTS = JSON.parse(fs.readFileSync(path.join(here, 'mutants.json'), 'utf8'));
      const picked = MUTANTS.filter((m) => !caseFilter || m.id.includes(caseFilter) || m.cases.includes(caseFilter));
      for (const m of picked) {
        const out = await runOnce(browser, m.cases, m.id);
        jsonOut.adapters ??= out.adapters;
        const res = out.report.results;
        const red = res.filter((c) => c.status !== 'pass');
        const worst = res.reduce((w, c) => (c.maxDiff > (w?.maxDiff ?? -1) ? c : w), null);
        const caught = red.length > 0 && !out.report.fatal;
        if (!caught) failed++;
        console.log(`${caught ? '✓ 抓住' : '✗ 漏网'} 变异 ${m.id}:${m.desc}`);
        console.log(`    用例 ${res.length} 条,变红 ${red.length} 条;最大差 ${worst ? worst.maxDiff.toPrecision(3) : '-'}(${worst?.name ?? '-'})`);
        if (out.report.fatal) console.log(`    初始化失败:${out.report.fatal}`);
        for (const c of red.slice(0, 4)) console.log(`    ✗ ${c.name}:${c.detail.split('\n')[0]}`);
        jsonOut.mutants.push({ id: m.id, desc: m.desc, caught, red: red.map((c) => ({ name: c.name, maxDiff: c.maxDiff, badPixels: c.badPixels, detail: c.detail })), total: res.length });
      }
      console.log(`\n变异自检:抓住 ${jsonOut.mutants.filter((m) => m.caught).length} / 共 ${jsonOut.mutants.length}`);
    } else {
      const out = await runOnce(browser, caseFilter);
      jsonOut.adapters = out.adapters;
      jsonOut.results = out.report.results.map(({ images, ...c }) => c);
      console.log(`候选侧 WebGPU 适配器:${out.adapters.webgpu}\n参考侧 WebGL 渲染器:${out.adapters.webgl}\n`);
      failed += printReport(out);
      console.log(`\n一致 ${out.report.results.filter((c) => c.status === 'pass').length} / 共 ${out.report.results.length}`);
    }
  } finally {
    await browser.close();
  }
} finally {
  await refServer.close();
}
if (jsonPath) fs.writeFileSync(jsonPath, JSON.stringify(jsonOut, null, 1));
process.exit(failed ? 1 : 0);
