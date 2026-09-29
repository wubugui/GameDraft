#!/usr/bin/env node
/** Run the native Electron shell against the local Vite server with HMR. */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fallbackRoot = process.env.LOCALAPPDATA || process.env.TEMP;
const defaultOutDir = process.env.GAMEDRAFT_ELECTRON_DEV_OUT
  || (existsSync('F:/build') ? 'F:/build/GameDraft/dev'
    : fallbackRoot ? join(fallbackRoot, 'GameDraft', 'builds', 'dev') : null);
const usage = `用法：npm run electron:dev -- [选项]
  --out-dir <项目外桌面包目录>  默认 F:/build/GameDraft/dev（若 F:/build 不存在则用 %LOCALAPPDATA%）
  --port <端口>                本脚本启动 Vite，默认 5173
  --dev-url <HTTP(S) 地址>    连接已经运行的 Vite 服务，不启动新服务
  --run-only                  只用现有 Electron 包
  --rebuild-shell             即使包已存在也重新构建
  --build-config <JSON>       启动参数配置，默认 tools/build/build_config.json
  --electron-zip <ZIP>        构建 Electron 包时转交给 release.mjs
  --steamworks-dir <目录>     构建 Electron 包时转交给 release.mjs
  --steam-smoke-out <JSON>    运行壳的真实页面与 Steam smoke
  --steam-smoke-exit          smoke 写完后自动关闭游戏`;

function parseArgs(argv) {
  const options = new Set([
    'out-dir', 'port', 'dev-url', 'build-config', 'electron-zip',
    'steamworks-dir', 'steam-smoke-out',
  ]);
  const flags = new Set(['run-only', 'rebuild-shell', 'steam-smoke-exit', 'help']);
  const args = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    const name = raw.startsWith('--') ? raw.slice(2) : '';
    if (!options.has(name) && !flags.has(name)) throw new Error(`未知参数：${raw}\n${usage}`);
    if (args.has(name)) throw new Error(`参数重复：${raw}`);
    if (flags.has(name)) args.set(name, true);
    else {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${raw} 需要值`);
      args.set(name, value);
    }
  }
  return args;
}

function validDevUrl(raw, bootQuery) {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('--dev-url 必须是无账号和片段的 HTTP(S) 地址');
  }
  if (!url.search && bootQuery) url.search = bootQuery;
  return url.href;
}

function readBootQuery(configPath) {
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const raw = config?.targets?.dev?.bootQuery;
  if (typeof raw !== 'string') throw new Error(`${configPath} 缺少 targets.dev.bootQuery`);
  return raw.trim().replace(/^\?/, '');
}

function sameFile(a, b) {
  return existsSync(a) && existsSync(b) && readFileSync(a).equals(readFileSync(b));
}

function shellReady(outDir) {
  const app = join(outDir, 'resources', 'app');
  if (!existsSync(join(outDir, 'GameDraft.exe')) || !existsSync(join(outDir, 'game', 'index.html'))) return false;
  return ['main.cjs', 'preload.cjs'].every(name => sameFile(join(root, 'src-electron', name), join(app, name)));
}

function isDevBuild(outDir) {
  try {
    const marker = JSON.parse(readFileSync(join(outDir, '.gamedraft-build.json'), 'utf8'));
    return marker.tool === 'gamedraft/scripts/release.mjs'
      && marker.runtime === 'electron' && marker.target === 'dev';
  } catch {
    return false;
  }
}

function buildShell(outDir, args) {
  const releaseArgs = [
    join(root, 'scripts', 'release.mjs'), '--target', 'dev', '--out-dir', outDir,
    '--skip-sweep', '--skip-verify',
  ];
  for (const option of ['build-config', 'electron-zip', 'steamworks-dir']) {
    if (args.has(option)) releaseArgs.push(`--${option}`, resolve(args.get(option)));
  }
  const build = spawnSync(process.execPath, releaseArgs, { cwd: root, stdio: 'inherit', shell: false });
  if (build.error) throw build.error;
  if (build.status !== 0) throw new Error(`Electron dev 包构建失败，退出码 ${build.status ?? '未知'}`);
}

async function requireFreePort(port) {
  await new Promise((ok, fail) => {
    const server = createServer();
    server.once('error', error => fail(new Error(`本地端口 ${port} 已被占用：${error.message}。可用 --port 换端口或 --dev-url 指向已有服务。`)));
    server.listen({ host: '127.0.0.1', port }, () => server.close(ok));
  });
}

function stopTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    // Only the PID started by this command is targeted; /T includes Vite's helpers.
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', shell: false });
  } else {
    child.kill('SIGTERM');
  }
}

async function waitForVite(url, child) {
  const deadline = Date.now() + 90_000;
  let startupError = null;
  child.once('error', error => { startupError = error; });
  while (Date.now() < deadline) {
    if (startupError) throw startupError;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Vite 提前退出：${child.exitCode ?? child.signalCode}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1200), cache: 'no-store' });
      if (response.ok) return;
    } catch { /* Server still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error(`Vite 90 秒内没有响应：${url}`);
}

async function checkExistingVite(url) {
  const client = new URL('/@vite/client', url);
  const response = await fetch(client, { signal: AbortSignal.timeout(10_000), cache: 'no-store' });
  if (!response.ok) throw new Error(`现有地址没有响应 Vite 客户端：${client}（HTTP ${response.status}）`);
}

async function runGame(exe, outDir, url, args) {
  const env = { ...process.env, GAMEDRAFT_DEV_URL: url };
  const gameArgs = [];
  if (args.has('steam-smoke-out')) gameArgs.push(`--steam-smoke-out=${resolve(args.get('steam-smoke-out'))}`);
  if (args.has('steam-smoke-exit')) gameArgs.push('--steam-smoke-exit');
  console.log(`Electron 开发窗：${url}\n桌面壳：${exe}`);
  const game = spawn(exe, gameArgs, { cwd: outDir, env, stdio: 'inherit', shell: false });
  const interrupted = () => stopTree(game);
  process.on('SIGINT', interrupted);
  process.on('SIGTERM', interrupted);
  try {
    const started = Date.now();
    const result = await new Promise((ok, fail) => {
      game.once('error', fail);
      game.once('exit', (code, signal) => ok({ code, signal }));
    });
    if (Date.now() - started < 2000 && !args.has('steam-smoke-exit')) {
      throw new Error('Electron 很快退出；如已有另一个 GameDraft 实例，先关闭它再启动开发窗');
    }
    if (result.signal || result.code !== 0) throw new Error(`Electron 退出：${result.signal || result.code}`);
  } finally {
    process.off('SIGINT', interrupted);
    process.off('SIGTERM', interrupted);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.has('help')) { console.log(usage); return; }
  if (args.has('run-only') && args.has('rebuild-shell')) throw new Error('--run-only 与 --rebuild-shell 不能同时使用');
  if (!defaultOutDir && !args.has('out-dir')) throw new Error('无法确定项目外构建目录；请传 --out-dir');
  const outDir = resolve(args.get('out-dir') ?? defaultOutDir);
  const configPath = resolve(args.get('build-config') ?? join(root, 'tools', 'build', 'build_config.json'));
  const bootQuery = readBootQuery(configPath);
  const rawPort = args.get('port') ?? '5173';
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port 必须是 1–65535 的整数');
  if (args.has('dev-url') && args.has('port')) throw new Error('--dev-url 连接已有服务，不需要 --port');
  if (args.has('steam-smoke-exit') && !args.has('steam-smoke-out')) throw new Error('--steam-smoke-exit 需要 --steam-smoke-out');

  if (args.has('run-only')) {
    if (!shellReady(outDir)) throw new Error(`现有 Electron 包缺失或桌面壳已变：${outDir}；去掉 --run-only 构建新包`);
  } else if (args.has('rebuild-shell') || !shellReady(outDir)) {
    if (existsSync(join(outDir, '.gamedraft-build.json')) && !isDevBuild(outDir)) {
      throw new Error(`目标是非 dev 构建：${outDir}；请另选 --out-dir`);
    }
    buildShell(outDir, args);
    if (!shellReady(outDir)) throw new Error(`构建后 Electron 桌面壳不完整：${outDir}`);
  }

  const exe = join(outDir, 'GameDraft.exe');
  let vite = null;
  const rawUrl = args.get('dev-url') || process.env.GAMEDRAFT_DEV_URL;
  let url;
  try {
    if (rawUrl) {
      url = validDevUrl(rawUrl, bootQuery);
      await checkExistingVite(url);
    } else {
      await requireFreePort(port);
      url = validDevUrl(`http://127.0.0.1:${port}/`, bootQuery);
      const viteScript = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
      if (!existsSync(viteScript)) throw new Error('找不到 Vite，请先 npm install');
      vite = spawn(process.execPath, [viteScript, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
        cwd: root, stdio: 'inherit', shell: false,
        env: { ...process.env, GAMEDRAFT_NO_OPEN: '1' },
      });
      await waitForVite(url, vite);
    }
    await runGame(exe, outDir, url, args);
  } finally {
    if (vite) stopTree(vite);
  }
}

main().catch(error => { console.error(`Electron 开发窗启动失败：${error.message}`); process.exitCode = 1; });
