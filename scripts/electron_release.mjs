#!/usr/bin/env node
/**
 * Windows Electron 绿色包装配入口。release.mjs 会先跑游戏抽取和验收，再调用本脚本。
 *
 * node scripts/electron_release.mjs --out-dir C:/builds/gamedraft-electron
 *
 * 默认先以 package.mjs 抽取 game/。复用现成 staging 时显式加 --use-existing-game。
 * 正式 AppID 可显式传 --steam-app-id；测试 AppID 480 只通过运行时环境变量传给壳。
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, createReadStream, existsSync, lstatSync, mkdirSync,
  mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUILD_MARKER, checkOutputPath } from './lib/build_helpers.mjs';
import {
  ELECTRON_ARCHIVE_SHA256, ELECTRON_VERSION, electronArchivePath,
} from './lib/electron_toolchain.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = '.gamedraft-electron-build.json';
const TOOL = 'gamedraft/scripts/electron_release.mjs';
const SHELL = join(ROOT, 'src-electron');
const USAGE = `用法：node scripts/electron_release.mjs --out-dir <项目外目录> \\
  [--electron-zip <官方 Windows x64 ZIP>] [--electron-sha256 <固定 SHA256>] \\
  [--target dev|release] [--use-existing-game] [--steamworks-dir <已安装的 steamworks.js>] \\
  [--steam-app-id <正式 AppID>] [--steam-restart-through-steam]

Electron ${ELECTRON_VERSION} ZIP 从 https://github.com/electron/electron/releases 获取；始终核对项目固定 SHA256。
默认缓存路径：%LOCALAPPDATA%/GameDraft/electron-probe/；也可设 GAMEDRAFT_ELECTRON_ZIP。
默认调用 TypeScript 检查与 scripts/package.mjs；现成 release/<target>/game 可加 --use-existing-game。
输出目录只接受空目录或本脚本上次生成的目录；覆盖时保留 gamedata/。正式 release.mjs 也认已有构建标记。
测试 AppID 480 只在启动包时设置 GAMEDRAFT_STEAM_APP_ID=480，不写进包。`;

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set([
    'help', 'use-existing-game', 'steam-restart-through-steam',
    'accept-release-marker', 'allow-project-release', 'force',
  ]);
  const options = new Set(['target', 'out-dir', 'electron-zip', 'electron-sha256', 'steamworks-dir', 'steam-app-id']);
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('--')) fail(`未知参数：${raw}`);
    const key = raw.slice(2);
    if (values.has(key)) fail(`参数重复：${raw}`);
    if (flags.has(key)) {
      values.set(key, true);
    } else if (options.has(key)) {
      const next = argv[++i];
      if (!next || next.startsWith('--')) fail(`${raw} 缺少值`);
      values.set(key, next);
    } else {
      fail(`未知参数：${raw}`);
    }
  }
  return values;
}

function inside(base, candidate) {
  const rel = relative(resolve(base), resolve(candidate));
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
}

/** 默认仓库外；正式入口可用 release/ 下的安全子目录。拒绝重解析点和其他工作树。 */
function checkDestination(raw, { allowProjectRelease = false } = {}) {
  if (!raw) fail(`缺少 --out-dir。\n${USAGE}`);
  const verdict = checkOutputPath(raw, ROOT);
  if (!verdict.ok) fail(`输出路径不安全：${verdict.reason}`);
  const out = verdict.abs;
  const projectRelease = join(ROOT, 'release');
  const stagingRoots = [join(projectRelease, 'dev'), join(projectRelease, 'release')];
  if (out === projectRelease || stagingRoots.some((stage) => inside(stage, out) || inside(out, stage))) {
    fail(`输出目录不能覆盖打包中转目录：${out}`);
  }
  if (inside(ROOT, out) && !(allowProjectRelease && inside(projectRelease, out))) {
    fail('Electron 绿色包必须放在项目外；正式 release.mjs 可输出到仓库 release/ 下');
  }
  for (let path = out; ; path = dirname(path)) {
    if (existsSync(path)) {
      if (lstatSync(path).isSymbolicLink()) fail(`输出路径经过链接或 junction：${path}`);
      if (existsSync(join(path, '.git')) && !(allowProjectRelease && path === ROOT)) {
        fail(`输出路径位于其他 Git 工作树：${path}`);
      }
    }
    if (path === dirname(path)) break;
  }
  // 已存在的父目录再按真实路径判一遍，防止 Windows 重解析点绕过字面路径。
  let ancestor = out;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const real = realpathSync.native(ancestor);
  const realOut = resolve(real, relative(ancestor, out));
  if ((inside(ROOT, realOut) && !(allowProjectRelease && inside(projectRelease, realOut)))
    || inside(realOut, ROOT)) fail(`输出路径实际指向项目或项目上级：${realOut}`);
  return out;
}

function checkExistingOutput(out, { acceptReleaseMarker = false, force = false } = {}) {
  if (!existsSync(out)) return;
  if (!lstatSync(out).isDirectory()) fail(`输出路径不是目录：${out}`);
  const names = readdirSync(out);
  if (names.length === 0) return;
  const ownMarkerPath = join(out, MARKER);
  const releaseMarkerPath = join(out, BUILD_MARKER);
  let recognized = false;
  for (const markerPath of [ownMarkerPath, ...(acceptReleaseMarker ? [releaseMarkerPath] : [])]) {
    if (!existsSync(markerPath)) continue;
    if (lstatSync(markerPath).isSymbolicLink()) fail(`旧构建标记是链接：${markerPath}`);
    let marker;
    try { marker = JSON.parse(readFileSync(markerPath, 'utf8')); } catch {
      if (!force) fail(`旧构建标记无法读取：${markerPath}`);
      continue;
    }
    if (markerPath === ownMarkerPath && marker.tool === TOOL && marker.schema === 1) recognized = true;
    if (markerPath === releaseMarkerPath && marker.tool === 'gamedraft/scripts/release.mjs') recognized = true;
  }
  if (!recognized && !force) fail(`目标目录非空且没有可识别的构建标记：${out}；确认无误可加 --force`);
  for (const name of names) {
    const entry = join(out, name);
    if (lstatSync(entry).isSymbolicLink()) fail(`旧包有链接或 junction，拒绝覆盖：${entry}`);
  }
  const saves = join(out, 'gamedata');
  if (existsSync(saves) && !lstatSync(saves).isDirectory()) fail(`存档路径不是目录：${saves}`);
}

function copyTree(source, dest) {
  const type = lstatSync(source);
  if (type.isSymbolicLink()) fail(`拒绝拷贝链接或 junction：${source}`);
  if (type.isFile()) {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(source, dest);
    return;
  }
  if (!type.isDirectory()) fail(`不支持的输入文件类型：${source}`);
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(source)) copyTree(join(source, name), join(dest, name));
}

function sha256(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}

function run(exe, args) {
  const result = spawnSync(exe, args, { cwd: ROOT, shell: false, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`${basename(exe)} 退出码 ${result.status}`);
}

function checkZipEntries(zip) {
  const listing = spawnSync('tar', ['-tf', zip], { shell: false, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (listing.error) throw listing.error;
  if (listing.status !== 0) fail(`无法列出 Electron ZIP：${listing.stderr?.trim() || listing.status}`);
  const names = listing.stdout.split(/\r?\n/).filter(Boolean);
  const normalizedNames = new Set(names.map((name) => name.replace(/^\.\//, '')));
  if (!normalizedNames.has('electron.exe') || !normalizedNames.has('version')) fail('Electron ZIP 缺少 electron.exe 或 version');
  for (const name of names) {
    const normalized = name.replace(/^\.\//, '');
    if (!normalized || normalized.startsWith('/') || normalized.includes('\\')
      || /^[A-Za-z]:/.test(normalized) || normalized.split('/').includes('..')) {
      fail(`Electron ZIP 内有危险路径：${name}`);
    }
  }
}

function shellFiles(stageApp) {
  const required = ['package.json', 'main.cjs', 'preload.cjs', 'storage.cjs', 'steam.cjs'];
  for (const name of required) {
    const source = join(SHELL, name);
    if (!existsSync(source)) fail(`Electron 壳缺少 ${source}`);
    copyTree(source, join(stageApp, name));
  }
  // 壳新增 .cjs 时应随包带走；README、依赖锁与开发脚本留在源码树。
  for (const name of readdirSync(SHELL)) {
    if (name.endsWith('.cjs') && !required.includes(name)) copyTree(join(SHELL, name), join(stageApp, name));
  }
  const assets = join(SHELL, 'assets');
  if (existsSync(assets)) copyTree(assets, join(stageApp, 'assets'));
}

function devCaptureFiles(stageApp) {
  const source = join(ROOT, 'tools', 'webgpu_capture');
  const target = join(stageApp, 'webgpu_capture');
  for (const name of [
    'electron_broker.mjs', 'server.mjs', 'cli.mjs', 'analyze.mjs',
    'analysis_report.mjs', 'analysis_png.mjs', 'analysis_sidecars.mjs',
    'viewer.html', 'viewer.js',
  ]) copyTree(join(source, name), join(target, name));
  for (const name of ['webgpu_inspector.js', 'LICENSE', 'SOURCE.txt']) {
    copyTree(join(source, 'vendor', name), join(target, 'vendor', name));
  }
}

function countFiles(root) {
  let files = 0;
  let bytes = 0;
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) { files += 1; bytes += stat.size; }
      else fail(`产物中出现链接或特殊文件：${path}`);
    }
  };
  walk(root);
  return { files, bytes };
}

function clearPreviousBuild(out) {
  if (!existsSync(out)) { mkdirSync(out, { recursive: true }); return; }
  const outReal = realpathSync.native(out);
  // A previous build may have been modified by hand. Check every descendant
  // before recursive removal so a nested junction cannot escape this output.
  const inspect = (dir) => {
    for (const name of readdirSync(dir)) {
      if (dir === out && name === 'gamedata') continue;
      const entry = join(dir, name);
      const stat = lstatSync(entry);
      if (stat.isSymbolicLink()) fail(`旧包含链接或 junction，拒绝覆盖：${entry}`);
      if (!inside(outReal, realpathSync.native(entry))) fail(`旧包路径越界，拒绝覆盖：${entry}`);
      if (stat.isDirectory()) inspect(entry);
    }
  };
  inspect(out);
  // 覆盖只发生在路径与 marker 验证后。标记先删；中途失败时旧包不会被误认为完整包。
  const marker = join(out, MARKER);
  if (existsSync(marker)) rmSync(marker);
  for (const name of readdirSync(out)) {
    if (name === 'gamedata') continue;
    const victim = join(out, name);
    if (!inside(out, victim) || victim === out || lstatSync(victim).isSymbolicLink()) fail(`拒绝清理不安全路径：${victim}`);
    rmSync(victim, { recursive: true, force: true });
  }
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') fail('目前只装配 Windows x64 Electron 绿色包');
  const args = parseArgs(process.argv.slice(2));
  if (args.has('help')) { console.log(USAGE); return; }
  const target = args.get('target') ?? 'release';
  if (!['dev', 'release'].includes(target)) fail(`未知 target：${target}`);
  const destinationOptions = { allowProjectRelease: args.has('allow-project-release') };
  const outputOptions = { acceptReleaseMarker: args.has('accept-release-marker'), force: args.has('force') };
  const out = checkDestination(args.get('out-dir'), destinationOptions);
  checkExistingOutput(out, outputOptions);

  const suppliedHash = args.get('electron-sha256');
  if (suppliedHash && String(suppliedHash).toLowerCase() !== ELECTRON_ARCHIVE_SHA256) {
    fail(`Electron ZIP 必须匹配项目固定 SHA256 ${ELECTRON_ARCHIVE_SHA256}；传入 ${suppliedHash}`);
  }
  const expectedHash = ELECTRON_ARCHIVE_SHA256;
  const zip = electronArchivePath(args.get('electron-zip'));
  if (!zip) fail('找不到 Electron ZIP 缓存根。请给 --electron-zip 或设置 GAMEDRAFT_ELECTRON_ZIP / LOCALAPPDATA');
  if (!existsSync(zip) || !lstatSync(zip).isFile()) {
    fail(`找不到 Electron ${ELECTRON_VERSION} 官方 ZIP：${zip}\n从 https://github.com/electron/electron/releases 下载对应 Windows x64 ZIP，或给 --electron-zip <路径>；文件仍须匹配固定 SHA256 ${expectedHash}`);
  }

  const shellPackagePath = join(SHELL, 'package.json');
  if (!existsSync(shellPackagePath)) fail(`找不到 ${shellPackagePath}`);
  const shellPackage = JSON.parse(readFileSync(shellPackagePath, 'utf8'));
  const expectedElectronVersion = shellPackage.devDependencies?.electron ?? shellPackage.dependencies?.electron;
  const expectedSteamVersion = shellPackage.dependencies?.['steamworks.js'];
  if (!/^\d+\.\d+\.\d+$/.test(expectedElectronVersion ?? '')) fail('src-electron/package.json 必须精确锁定 Electron 版本');
  if (expectedElectronVersion !== ELECTRON_VERSION) fail(`项目固定 Electron ${ELECTRON_VERSION}，壳声明 ${expectedElectronVersion}`);
  if (!/^\d+\.\d+\.\d+$/.test(expectedSteamVersion ?? '')) fail('src-electron/package.json 必须精确锁定 steamworks.js 版本');

  let appId = null;
  if (args.has('steam-app-id')) {
    const raw = args.get('steam-app-id');
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) fail('正式 Steam AppID 必须是正整数');
    appId = Number(raw);
    if (appId === 480) fail('测试 AppID 480 不得写进绿色包；测试时用 GAMEDRAFT_STEAM_APP_ID=480');
  }
  if (args.has('steam-restart-through-steam') && appId === null) fail('--steam-restart-through-steam 需要正式 --steam-app-id');

  const actualHash = await sha256(zip);
  if (actualHash !== expectedHash) fail(`Electron ZIP SHA256 不匹配：预期 ${expectedHash}，实际 ${actualHash}`);
  checkZipEntries(zip);

  const steamSource = resolve(args.get('steamworks-dir') ?? join(SHELL, 'node_modules', 'steamworks.js'));
  const steamPackage = join(steamSource, 'package.json');
  if (!args.has('steamworks-dir') && !existsSync(steamPackage)) {
    const npmCli = process.env.npm_execpath || join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (!existsSync(npmCli)) fail(`缺少 steamworks.js 与 npm CLI：${steamSource}；先在 src-electron 执行 npm ci --omit=dev`);
    console.log('安装锁定的 steamworks.js 运行依赖（npm ci --omit=dev）');
    run(process.execPath, [npmCli, 'ci', '--omit=dev', '--prefix', SHELL]);
  }
  if (!existsSync(steamPackage)) fail(`缺少 steamworks.js 运行依赖：${steamSource}；先在 src-electron 安装依赖或给 --steamworks-dir`);
  if (lstatSync(steamSource).isSymbolicLink()) fail(`Steam 原生模块不接受链接目录：${steamSource}`);
  const steamVersion = JSON.parse(readFileSync(steamPackage, 'utf8')).version;
  if (steamVersion !== expectedSteamVersion) fail(`steamworks.js 版本不匹配：壳需 ${expectedSteamVersion}，输入为 ${steamVersion}`);
  const steamDll = join(steamSource, 'dist', 'win64', 'steam_api64.dll');
  const steamNode = join(steamSource, 'dist', 'win64', 'steamworksjs.win32-x64-msvc.node');
  for (const path of [steamDll, steamNode]) if (!existsSync(path)) fail(`Steam 原生依赖缺失：${path}`);

  if (!args.has('use-existing-game')) {
    const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
    if (!existsSync(tsc)) fail('缺少 TypeScript，先在项目根 npm install');
    run(process.execPath, [tsc, '--noEmit']);
    run(process.execPath, [join(ROOT, 'scripts', 'package.mjs'), '--target', target]);
  }
  const gameSource = join(ROOT, 'release', target, 'game');
  if (!existsSync(join(gameSource, 'index.html'))) fail(`游戏抽取产物不存在：${join(gameSource, 'index.html')}`);

  // Electron 与 game/ 会有数 GB；临时装配必须落在目标同卷，不能占用系统 TEMP 所在盘。
  // 先重新校验父目录，随后仅在这个明确指定的输出父目录创建带唯一前缀的临时目录。
  const stageParent = dirname(out);
  mkdirSync(stageParent, { recursive: true });
  checkDestination(out, destinationOptions);
  const stageParentReal = realpathSync.native(stageParent);
  const tempRoot = mkdtempSync(join(stageParent, '.gamedraft-electron-stage-'));
  try {
    const extracted = join(tempRoot, 'electron');
    const bundle = join(tempRoot, 'bundle');
    mkdirSync(extracted);
    mkdirSync(bundle);
    run('tar', ['-xf', zip, '-C', extracted]);
    const actualVersion = readFileSync(join(extracted, 'version'), 'utf8').trim();
    if (actualVersion !== expectedElectronVersion) fail(`Electron ZIP 版本不匹配：壳需 ${expectedElectronVersion}，ZIP 为 ${actualVersion}`);
    copyTree(extracted, bundle);
    renameSync(join(bundle, 'electron.exe'), join(bundle, 'GameDraft.exe'));

    const app = join(bundle, 'resources', 'app');
    if (existsSync(app)) fail('Electron ZIP 自带 resources/app，与游戏壳冲突');
    mkdirSync(app);
    shellFiles(app);
    if (target === 'dev') devCaptureFiles(app);
    copyTree(steamSource, join(app, 'node_modules', 'steamworks.js'));
    copyFileSync(steamDll, join(bundle, 'steam_api64.dll'));
    copyTree(gameSource, join(bundle, 'game'));
    if (appId !== null) {
      writeFileSync(join(bundle, 'steam_config.json'), `${JSON.stringify({
        appId,
        restartThroughSteam: args.has('steam-restart-through-steam'),
      }, null, 2)}\n`);
    }
    if (!existsSync(join(bundle, 'game', 'index.html')) || !existsSync(join(bundle, 'resources', 'app', 'main.cjs'))) {
      fail('绿色包关键入口缺失');
    }
    const payload = countFiles(bundle);
    const marker = {
      schema: 1,
      tool: TOOL,
      target,
      builtAt: new Date().toISOString(),
      electron: { version: actualVersion, archive: basename(zip), sha256: actualHash },
      steamworks: { version: steamVersion, nativeSha256: await sha256(steamNode) },
      steamAppId: appId ?? 'Steam launch environment / runtime override',
      gameStagingReused: args.has('use-existing-game'),
      gameVerified: false,
      payload,
      note: '覆盖时只保留 gamedata/；正式发布前仍需真机和 Steam Overlay 验收。',
    };

    // 所有输入齐备、临时包装配成功之后才碰用户指定的目标目录。
    checkDestination(out, destinationOptions);
    checkExistingOutput(out, outputOptions);
    clearPreviousBuild(out);
    for (const name of readdirSync(bundle)) copyTree(join(bundle, name), join(out, name));
    writeFileSync(join(out, MARKER), `${JSON.stringify(marker, null, 2)}\n`);
    console.log(`Electron 绿色包：${out}`);
    console.log(`入口：${join(out, 'GameDraft.exe')}；${payload.files} 个文件；${(payload.bytes / 1024 / 1024).toFixed(1)} MB`);
    console.log(`Electron ${actualVersion} / steamworks.js ${steamVersion} / AppID ${appId ?? '运行时 Steam 环境'}`);
  } finally {
    // Windows 上递归清理前验证真实路径：只删本次在目标父目录直属创建的临时目录。
    if (existsSync(tempRoot)) {
      const stageReal = realpathSync.native(tempRoot);
      if (lstatSync(tempRoot).isSymbolicLink()
        || !basename(tempRoot).startsWith('.gamedraft-electron-stage-')
        || !inside(stageParentReal, stageReal)
        || relative(stageParentReal, dirname(stageReal)) !== '') {
        fail(`临时目录路径已变化，拒绝递归清理：${tempRoot}`);
      }
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(`Electron 绿色包失败：${error.stack ?? error.message}`);
  process.exitCode = 1;
});
