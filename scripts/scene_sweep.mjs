#!/usr/bin/env node
/**
 * 全场景抓取扫描的编排器：起一个**隔离的** dev 服 → 无头把每个场景真跑一遍 → 停掉。
 *
 * 干活的是 `tools/build/scene_sweep.py`（QtWebEngine 驱动 + 请求拦截 + 清单核对），
 * 这里只管三件事：
 *
 * 1. 清单在不在（`.build/manifest-<target>.json`）——没有就现生成一份；
 * 2. dev 服：用 `GAMEDRAFT_SWEEP_ISOLATED=1` 起（命令队列 / 快照 / 存档都不碰人手里那份），
 *    端口从 5197 往下试，谁空用谁；扫完不管成败都杀掉整棵进程树；
 * 3. 退出码原样透传——`release.mjs` 与 `npm run build` 据此停包。
 *
 * 用法：
 *   node scripts/scene_sweep.mjs --target release         # 缺省
 *   node scripts/scene_sweep.mjs --target dev --scenes 雾津街头,城门口
 *   node scripts/scene_sweep.mjs --url http://127.0.0.1:5173   # 对着在跑的 dev 服（不隔离！）
 *
 * 扫描会开一个真的浏览器窗口（QtWebEngine），跑完自动关。不是离屏：本机实测离屏下 GPU
 * 上下文会丢、rAF 停摆，切场永远收不了尾（`--offscreen` 只留作实验）。
 *
 * ⚠ `--url` 指向别人的 dev 服时**不隔离**：那份游戏的轮询器会消费共享命令队列。
 *   自己调试可以，管线里别这么用。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
function flag(name, fallback = undefined) {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = args[i + 1];
  return next && !next.startsWith('--') ? next : true;
}
const TARGET = String(flag('target', 'release'));
const URL_FLAG = flag('url');
const OUT = String(flag('out', join(ROOT, '.build', `sweep-${TARGET}.json`)));
const SCENES = flag('scenes');
const LIMIT = flag('limit');
const OFFSCREEN = Boolean(flag('offscreen', false));
const GEN_MANIFEST = Boolean(flag('gen-manifest', false));
/** 端口候选：编辑器占 5173、验收门占 5199/5299、agent 起的在 5174–5188，这里避开 */
const PORTS = [5197, 5196, 5195, 5194];

if (!['dev', 'release'].includes(TARGET)) {
  console.error(`未知 target: ${TARGET}（可用：dev / release）`);
  process.exit(2);
}

const step = (m) => console.log(`\n[36m▶ ${m}[0m`);
const info = (m) => console.log(`  ${m}`);
const warn = (m) => console.log(`[33m  ⚠ ${m}[0m`);
function die(msg, code = 2) {
  console.error(`\n[31m✖ ${msg}[0m`);
  process.exit(code);
}

/** 跨平台挑 python：项目自带 venv 优先（部分 Windows 机上 python3 是 Store stub 会静默空转）。 */
function pythonExe() {
  const candidates = [
    join(ROOT, '.tools', 'venv', 'Scripts', 'python.exe'),
    join(ROOT, '.tools', 'venv', 'bin', 'python'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return process.platform === 'win32' ? 'python' : 'python3';
}

const PY_ENV = { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };

function ensureManifest(manifestPath) {
  if (existsSync(manifestPath) && !GEN_MANIFEST) {
    info(`清单：${relative(ROOT, manifestPath)}`);
    return;
  }
  step(`生成抽取清单（target=${TARGET}）`);
  const r = spawnSync(pythonExe(), [
    '-m', 'tools.build.asset_manifest', ROOT, '--target', TARGET, '--out', manifestPath, '--strict',
  ], { stdio: 'inherit', cwd: ROOT, env: { ...process.env, ...PY_ENV } });
  if (r.status !== 0) die('清单生成失败（素材审计有 issue 或展开器发现硬伤），见上面的输出');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHttp(url, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await sleep(400);
  }
  return false;
}

/** 起隔离 dev 服；端口被占（strictPort）→ 抛，调用方换下一个。 */
function startVite(port) {
  return new Promise((resolvePromise, reject) => {
    const vite = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
    if (!existsSync(vite)) {
      reject(new Error('找不到 node_modules/vite，先 npm install'));
      return;
    }
    const child = spawn(process.execPath, [vite, '--port', String(port), '--strictPort'], {
      cwd: ROOT,
      env: { ...process.env, GAMEDRAFT_NO_OPEN: '1', GAMEDRAFT_SWEEP_ISOLATED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let settled = false;
    let output = '';
    const onData = (buf) => {
      output += String(buf);
      if (!settled && /already in use|EADDRINUSE/i.test(output)) {
        settled = true;
        try { child.kill(); } catch { /* 已退出 */ }
        reject(new Error(`端口 ${port} 被占`));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        reject(new Error(`dev 服在就绪前退出（code ${code}）：\n${output.slice(-800)}`));
      }
    });
    const url = `http://127.0.0.1:${port}`;
    waitHttp(`${url}/`, 90_000).then((ok) => {
      if (settled) return;
      settled = true;
      if (ok) resolvePromise({ child, url });
      else {
        try { child.kill(); } catch { /* 已退出 */ }
        reject(new Error(`dev 服 90s 内没就绪：\n${output.slice(-800)}`));
      }
    });
  });
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    // vite 会再起 esbuild 等子进程，只杀父进程会留孤儿占着端口
    spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
  } else {
    try { child.kill('SIGTERM'); } catch { /* 已退出 */ }
  }
}

async function main() {
  const manifestPath = join(ROOT, '.build', `manifest-${TARGET}.json`);
  step(`全场景抓取扫描（target=${TARGET}）`);
  ensureManifest(manifestPath);

  let url = URL_FLAG ? String(URL_FLAG) : null;
  let child = null;
  if (url) {
    warn(`对着现成的 ${url} 扫描——那份 dev 服**不隔离**，它会消费共享命令队列`);
  } else {
    for (const port of PORTS) {
      try {
        ({ child, url } = await startVite(port));
        info(`隔离 dev 服：${url}（GAMEDRAFT_SWEEP_ISOLATED=1）`);
        break;
      } catch (e) {
        warn(String(e.message).split('\n')[0]);
      }
    }
    if (!url) die(`${PORTS.join(' / ')} 都起不来 dev 服`);
  }

  const pyArgs = [
    // -X faulthandler：QtWebEngine 是原生代码，崩了（0xC0000005）Python 自己什么都不说；
    // -u：不缓冲，崩的时候前面的进度别跟着一起蒸发
    '-X', 'faulthandler', '-u',
    '-m', 'tools.build.scene_sweep',
    '--url', url, '--manifest', manifestPath, '--out', OUT, '--project-root', ROOT,
  ];
  if (SCENES && SCENES !== true) pyArgs.push('--scenes', String(SCENES));
  if (LIMIT && LIMIT !== true) pyArgs.push('--limit', String(LIMIT));
  if (OFFSCREEN) pyArgs.push('--offscreen');

  let status = 1;
  try {
    const r = spawnSync(pythonExe(), pyArgs, {
      stdio: 'inherit',
      cwd: ROOT,
      env: { ...process.env, ...PY_ENV },
    });
    if (r.error) throw r.error;
    status = r.status ?? 1;
  } finally {
    killTree(child);
  }
  if (status !== 0) {
    console.error(`\n[31m✖ 全场景扫描不通过（退出码 ${status}），报告：${relative(ROOT, OUT)}[0m`);
  } else {
    console.log(`\n[32m全场景扫描通过，报告：${relative(ROOT, OUT)}[0m`);
  }
  process.exit(status);
}

main().catch((e) => {
  console.error(`\n[31m✖ 扫描编排器自身出错：${e.stack ?? e.message}[0m`);
  process.exit(2);
});
