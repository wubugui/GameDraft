#!/usr/bin/env node
/**
 * 整局画面对照(master 对本分支):两边各起一个**隔离**的游戏 dev 服,逐个场景 `?mode=dev&visualCapture&devScene=<id>`
 * 直达,等切场收尾后截画布,逐像素比,出并排图与汇总表。用例级的着色器对照见 run.mjs;这里看的是整条运行时
 * (场景搭建、图层、UI、滤镜链、上屏)有没有跑偏、有没有新报错。
 *
 *   node tools/render_parity/game_sweep.mjs                       # 全部场景,基准 origin/master(没有就 master)
 *   node tools/render_parity/game_sweep.mjs --scenes dev_room,河边  # 只扫这几个
 *   node tools/render_parity/game_sweep.mjs --base <提交> --wait 12000 --threshold 3 --out <目录>
 *   node tools/render_parity/game_sweep.mjs --browser <chrome> [--headless] [--swiftshader]
 *
 * - 基准侧:`git worktree add` 到 .tools/game_parity_ref/<sha>/(已 gitignore;按提交缓存),node_modules 逐项链到
 *   仓库根那份(自己的 .vite 预构建缓存,两个 dev 服不互相作废),public/resources/runtime(DVC 素材)链到工作区那份。
 * - 两个 dev 服都带 GAMEDRAFT_SWEEP_ISOLATED=1(命令队列 / 快照 / 存档都不碰人手里那份)。
 * - 缺省开**有头**浏览器:WebGPU 上屏在一些无头环境里拿不到(实测 Linux 容器无头 Chromium 上屏即丢设备);
 *   Linux 无显示时套 xvfb-run,并加 --swiftshader(Vulkan / WebGL 都走 SwiftShader)。
 * - 判定(退出码非零):本分支出现 master 没有的非素材类报错;本分支没切进场景而 master 切进了;
 *   像素差(单通道 > 16)占比超过 --threshold(缺省 3%)。缺素材类报错(图 / 音频 404、解码失败)两边一样,不计。
 *   ⚠ 游戏按真实时间跑(环境台词、摆动、粒子),小比例差是常态;看并排图判断。
 *   已知的系统性差异:恰好落在半像素上的水平边(1 像素网格线、HUD 面板上下边)会差一行——WebGL 默认帧缓冲自下而上
 *   光栅化、WebGPU 自上而下,平局归属相反;离屏目标两边一致(run.mjs 逐位相同)。
 *
 * 依赖 playwright-core(仓库不装;用 PLAYWRIGHT_CORE 指到它的包目录)。
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
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
const has = (name) => args.includes(`--${name}`);
const WAIT = Number(flag('wait', '9000'));
const THRESHOLD = Number(flag('threshold', '3'));
const OUT = path.resolve(flag('out', path.join(repoRoot, '.tools', 'game_sweep_out')));
// 端口避开编辑器(5173)、agent(5174–5188)、RHI 冒烟(5191)、对照页(5192/5198)、扫描(5194–5197)
const PORTS = { ref: 5189, cand: 5190 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (...a) => execFileSync('git', a, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

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

function link(target, at) {
  if (fs.existsSync(at)) return;
  fs.mkdirSync(path.dirname(at), { recursive: true });
  // 目录用 junction(Windows 不要管理员权限;POSIX 上忽略类型参数)
  fs.symlinkSync(target, at, fs.statSync(target).isDirectory() ? 'junction' : 'file');
}

/** 基准树:worktree(按提交缓存;换了基准就把旧的撤掉) */
function ensureRefTree(sha) {
  const parent = path.join(repoRoot, '.tools', 'game_parity_ref');
  const dir = path.join(parent, sha);
  fs.mkdirSync(parent, { recursive: true });
  for (const old of fs.readdirSync(parent)) {
    if (old === sha) continue;
    try {
      git('worktree', 'remove', '--force', path.join(parent, old));
    } catch {
      fs.rmSync(path.join(parent, old), { recursive: true, force: true });
    }
  }
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.rmSync(dir, { recursive: true, force: true });
    git('worktree', 'prune');
    git('worktree', 'add', '--detach', dir, sha);
  }
  // node_modules:建一个真目录,里面逐项链到仓库根那份 —— 包照常解析,.vite 预构建缓存各用各的
  const nm = path.join(dir, 'node_modules');
  if (fs.existsSync(nm) && fs.lstatSync(nm).isSymbolicLink()) fs.unlinkSync(nm);
  fs.mkdirSync(nm, { recursive: true });
  for (const e of fs.readdirSync(path.join(repoRoot, 'node_modules'))) {
    if (e === '.vite') continue;
    link(path.join(repoRoot, 'node_modules', e), path.join(nm, e));
  }
  const res = path.join(repoRoot, 'public', 'resources', 'runtime');
  if (fs.existsSync(res)) link(res, path.join(dir, 'public', 'resources', 'runtime'));
  return dir;
}

function startVite(cwd, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(cwd, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
      cwd,
      env: { ...process.env, GAMEDRAFT_NO_OPEN: '1', GAMEDRAFT_SWEEP_ISOLATED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let settled = false;
    const onData = (b) => {
      out += String(b);
      if (!settled && /ready in|Local:/.test(out)) {
        settled = true;
        resolve({ child, url: `http://127.0.0.1:${port}/` });
      }
      if (!settled && /already in use|EADDRINUSE/i.test(out)) {
        settled = true;
        reject(new Error(`端口 ${port} 被占`));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`dev 服在就绪前退出(code ${code}):\n${out.slice(-800)}`));
      }
    });
  });
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
  else {
    try {
      child.kill('SIGTERM');
    } catch {
      // 已退出
    }
  }
}

function loadPlaywright() {
  const base = process.env.PLAYWRIGHT_CORE ? path.join(process.env.PLAYWRIGHT_CORE, 'package.json') : import.meta.url;
  try {
    return createRequire(base)('playwright-core');
  } catch {
    console.error('找不到 playwright-core(npm i -D playwright-core,或装在别处再用 PLAYWRIGHT_CORE 指过去)');
    process.exit(2);
  }
}

/** 缺素材导致的报错两边一样,不计入判定 */
const ASSET_NOISE = /could not be decoded|Failed to load|加载失败|not valid JSON|status of 404|Decoding audio data failed|AudioContext was not allowed/;

async function capture(browser, base, id) {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().split('\n')[0].slice(0, 200));
  });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${String(e).split('\n')[0].slice(0, 200)}`));
  try {
    await page.goto(`${base}?mode=dev&visualCapture&devScene=${encodeURIComponent(id)}`);
    const t0 = Date.now();
    let entered = false;
    while (Date.now() - t0 < WAIT * 4) {
      entered = await page.evaluate((sid) => {
        const sm = window.__game?.sceneManager;
        return !!sm && sm.switching === false && sm.currentSceneData?.id === sid;
      }, id).catch(() => false);
      if (entered) break;
      await sleep(500);
    }
    await sleep(WAIT);
    await page.evaluate(() => {
      for (const el of document.body.querySelectorAll('*')) {
        if (el.tagName !== 'CANVAS' && !el.querySelector('canvas')) el.style.visibility = 'hidden';
      }
    });
    const canvas = await page.$('canvas');
    const png = canvas ? await canvas.screenshot() : null;
    return { png, entered, errors };
  } finally {
    await page.close();
  }
}

/** 在浏览器里比两张 PNG(不引 PNG 解码依赖),出差异统计与三联图 */
async function comparePngs(browser, a, b) {
  const page = await browser.newPage();
  try {
    return await page.evaluate(async ({ a, b }) => {
      const load = (s) => new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => res(img);
        img.onerror = rej;
        img.src = `data:image/png;base64,${s}`;
      });
      const [ia, ib] = await Promise.all([load(a), load(b)]);
      const w = Math.min(ia.width, ib.width);
      const h = Math.min(ia.height, ib.height);
      const c = document.createElement('canvas');
      c.width = w * 3;
      c.height = h;
      const ctx = c.getContext('2d');
      ctx.drawImage(ia, 0, 0);
      ctx.drawImage(ib, w, 0);
      const da = ctx.getImageData(0, 0, w, h).data;
      const db = ctx.getImageData(w, 0, w, h).data;
      const diff = ctx.createImageData(w, h);
      let bad = 0;
      let max = 0;
      let sa = 0;
      let sb = 0;
      for (let i = 0; i < da.length; i += 4) {
        const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]));
        sa += da[i] + da[i + 1] + da[i + 2];
        sb += db[i] + db[i + 1] + db[i + 2];
        if (d > 16) bad++;
        max = Math.max(max, d);
        const v = Math.min(255, d * 4);
        diff.data[i] = v;
        diff.data[i + 1] = d > 16 ? 0 : v;
        diff.data[i + 2] = d > 16 ? 0 : v;
        diff.data[i + 3] = 255;
      }
      ctx.putImageData(diff, w * 2, 0);
      return {
        sameSize: ia.width === ib.width && ia.height === ib.height,
        badPct: (bad / (w * h)) * 100,
        max,
        lumA: sa / (w * h * 3),
        lumB: sb / (w * h * 3),
        triptych: c.toDataURL('image/png').split(',')[1],
      };
    }, { a: a.toString('base64'), b: b.toString('base64') });
  } finally {
    await page.close();
  }
}

const base = resolveBase();
const refDir = ensureRefTree(base.sha);
const scenes = (flag('scenes', '') || fs.readdirSync(path.join(repoRoot, 'public', 'assets', 'scenes')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).join(','))
  .split(',').map((s) => s.trim()).filter(Boolean);
console.log(`对照基准:${base.ref} @ ${base.sha.slice(0, 10)};场景 ${scenes.length} 个;结果 → ${path.relative(repoRoot, OUT) || OUT}`);
fs.mkdirSync(OUT, { recursive: true });

const { chromium } = loadPlaywright();
const servers = [];
let failed = 0;
try {
  const ref = await startVite(refDir, PORTS.ref);
  servers.push(ref.child);
  const cand = await startVite(repoRoot, PORTS.cand);
  servers.push(cand.child);
  const browserPath = flag('browser', process.env.RENDER_PARITY_BROWSER);
  const browser = await chromium.launch({
    headless: has('headless'),
    args: [
      '--enable-unsafe-webgpu', '--autoplay-policy=no-user-gesture-required', '--window-size=1100,860',
      ...(has('swiftshader') ? ['--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-angle=swiftshader'] : []),
    ],
    ...(browserPath ? { executablePath: browserPath } : { channel: process.platform === 'win32' ? 'msedge' : 'chrome' }),
  });
  // 先各开一次首页:让两个 dev 服把依赖预构建做完(否则第一个场景会撞上「Outdated Optimize Dep」整页重载)
  for (const s of [ref, cand]) {
    const p = await browser.newPage();
    await p.goto(`${s.url}?mode=dev&visualCapture`).catch(() => {});
    await sleep(8000);
    await p.close();
  }
  const rows = [];
  for (const id of scenes) {
    const a = await capture(browser, ref.url, id);
    const b = await capture(browser, cand.url, id);
    const aErr = new Set(a.errors.filter((e) => !ASSET_NOISE.test(e)));
    const newErr = [...new Set(b.errors.filter((e) => !ASSET_NOISE.test(e)))].filter((e) => !aErr.has(e));
    let cmp = null;
    if (a.png && b.png) {
      cmp = await comparePngs(browser, a.png, b.png);
      fs.writeFileSync(path.join(OUT, `${id}.png`), Buffer.from(cmp.triptych, 'base64'));
    }
    const problems = [];
    if (!b.png) problems.push('本分支没有画布');
    if (a.entered && !b.entered) problems.push('本分支没切进场景(master 切进了)');
    if (newErr.length) problems.push(`本分支新增报错:${newErr.slice(0, 3).join(' | ')}`);
    if (cmp && !cmp.sameSize) problems.push('画布尺寸不同');
    if (cmp && cmp.badPct > THRESHOLD) problems.push(`像素差 ${cmp.badPct.toFixed(2)}% > ${THRESHOLD}%`);
    if (problems.length) failed++;
    const line = `${problems.length ? '✗' : '✓'} ${id}  差 ${cmp ? cmp.badPct.toFixed(2) : '-'}%  亮度 ${cmp ? `${cmp.lumA.toFixed(1)}/${cmp.lumB.toFixed(1)}` : '-'}` +
      `${a.entered ? '' : '  (master 没切进场景)'}${problems.length ? `\n    ${problems.join('\n    ')}` : ''}`;
    console.log(line);
    rows.push({ id, entered: [a.entered, b.entered], badPct: cmp?.badPct ?? null, max: cmp?.max ?? null, problems, refErrors: a.errors.length, candErrors: b.errors.length });
  }
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({ base, threshold: THRESHOLD, rows }, null, 1));
  console.log(`\n一致 ${rows.length - failed} / 共 ${rows.length}(并排图:master | 本分支 | 差异,在 ${OUT})`);
  await browser.close();
} finally {
  for (const c of servers) killTree(c);
}
process.exit(failed ? 1 : 0);
