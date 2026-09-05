#!/usr/bin/env node
/**
 * GameDraft 打包器：把开发树里的东西**抽取**成一个能独立跑的游戏产物。
 *
 * ## 只读抽取
 *
 * 本脚本对 `public/`、`src/`、`resources/` 只读。所有输出都落在 `release/<target>/`
 * 与 `.build/`（都已 gitignore）。包体裁剪一律通过"不抽取"实现——开发树里的东西
 * 一件都不搬、不改、不删。音频转码与 JSON 里 `.wav→.ogg` 的改写只发生在 **staging 副本**上。
 *
 * ## 两个档位
 *
 *   dev      调试设施齐全（F2 面板、命令通道、光影切档载荷），不压缩，给自己和测试用
 *   release  剥调试代码、按清单裁素材、音频转 ogg，给玩家
 *
 * 两档的**游戏内容完全一致**，差的只是调试设施与压缩。
 *
 * ## 流程
 *
 *   1. 生成抽取清单（tools/build/asset_manifest.py，按档位）
 *   2. vite build → dist/（只有 JS/CSS/index.html；public/ 不由 vite 拷）
 *   3. staging：dist/* + 清单里的 public 文件 → release/<target>/game/
 *   4. 音频转码 wav→ogg（release 档），并同步改写 staging 里 JSON 的引用
 *   5. 写 build-report.json，打印体积账
 *
 * 用法：
 *   node scripts/package.mjs --target release
 *   node scripts/package.mjs --target dev --skip-vite     # 只重做素材抽取
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync, copyFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkStagingDir, swapWavRef } from './lib/build_helpers.mjs';
import { SCENE_INDEX_REL, writeSceneIndex } from './lib/scene_index.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT, 'public');
const DIST_DIR = join(ROOT, 'dist');
const BUILD_DIR = join(ROOT, '.build');

// ---------------------------------------------------------------- 小工具

const args = process.argv.slice(2);
function flag(name, fallback = undefined) {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = args[i + 1];
  return next && !next.startsWith('--') ? next : true;
}
const TARGET = String(flag('target', 'release'));
const SKIP_VITE = Boolean(flag('skip-vite', false));
const STAGING = String(flag('out', join(ROOT, 'release', TARGET)));

if (!['dev', 'release'].includes(TARGET)) {
  console.error(`未知 target: ${TARGET}（可用：dev / release）`);
  process.exit(2);
}

/**
 * `--out` 会被 `rmSync(recursive, force)` 直接删掉，**必须**先证明它在产物根之下。
 *
 * 没有这道闸的话：`--out .` 递归删当前目录，`--out public` 删掉 2.9 GB 素材树，
 * `--out` 后面漏了值还会因为 `flag()` 返回布尔而在 cwd 下建一个叫 `true` 的目录。
 * 文件头写着"对 public/、src/、resources/ 只读"——那句承诺得有代码守着才算数。
 */
const RELEASE_ROOT = resolve(ROOT, 'release');
{
  const verdict = checkStagingDir(RELEASE_ROOT, STAGING);
  if (!verdict.ok) {
    console.error(`拒绝把产物写到 ${verdict.abs}\n  --out ${verdict.reason}。`);
    process.exit(2);
  }
}

const t0 = Date.now();
function step(msg) {
  console.log(`\n[36m▶ ${msg}[0m`);
}
function info(msg) {
  console.log(`  ${msg}`);
}
function warn(msg) {
  console.log(`[33m  ⚠ ${msg}[0m`);
}
function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, {
    stdio: 'inherit',
    cwd: ROOT,
    shell: false,
    // Python 子进程默认按系统 ANSI 码页写 stdout，中文报告在 Windows 控制台上会变成乱码——
    // 报告看不懂等于没有报告。
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    ...opts,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`${cmd} ${cmdArgs.join(' ')} 退出码 ${r.status}`);
  }
  return r;
}

/**
 * 用 node 直接跑本地依赖的 JS 入口，不经 npx / .cmd 包装。
 *
 * Windows 上 `spawnSync('npx.cmd', ...)` 会抛 `EINVAL`——Node 20 起为了堵命令注入，
 * 拒绝在 `shell:false` 下执行 `.cmd`/`.bat`。开 `shell:true` 能绕过，但那把参数交给
 * cmd 解析，路径里有空格或中文时又是另一类坑。直接调 JS 入口两个问题都没有。
 */
function runNodeBin(relEntry, binArgs, extraEnv = {}) {
  const entry = join(ROOT, 'node_modules', ...relEntry.split('/'));
  if (!existsSync(entry)) throw new Error(`找不到 ${relEntry}，先 npm install`);
  run(process.execPath, [entry, ...binArgs], {
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', ...extraEnv },
  });
}

/**
 * 找一个外部可执行文件。
 *
 * 先问 PATH，找不到再去几个**已知安装位置**翻一遍。第二步不是多余的：
 * winget / Homebrew 装完会改 PATH，但**已经在跑的 shell 拿不到新值**——
 * 于是"我明明刚装了 ffmpeg"和"打包说找不到 ffmpeg"会同时成立，
 * 而错误信息还理直气壮地叫你再装一次。多翻这几个目录，省掉一次重启 shell。
 */
function which(bin) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(probe, [bin], { stdio: 'pipe', shell: false });
  if (r.status === 0) {
    const hit = String(r.stdout).split(/\r?\n/)[0].trim();
    if (hit) return hit;
  }
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const candidates = process.platform === 'win32'
    ? [
      join(home, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', `${bin}.exe`),
      join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', `${bin}.exe`),
      join(process.env.ProgramFiles || '', bin, 'bin', `${bin}.exe`),
    ]
    : [`/usr/local/bin/${bin}`, `/opt/homebrew/bin/${bin}`, `/usr/bin/${bin}`];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

async function walkFiles(dir) {
  const out = [];
  async function rec(d) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) await rec(p);
      else if (e.isFile()) out.push(p);
    }
  }
  await rec(dir);
  return out;
}

function copyInto(srcFile, destFile) {
  mkdirSync(dirname(destFile), { recursive: true });
  copyFileSync(srcFile, destFile);
}

// ---------------------------------------------------------- 1. 抽取清单

function generateManifest() {
  step(`生成抽取清单（target=${TARGET}）`);
  mkdirSync(BUILD_DIR, { recursive: true });
  const out = join(BUILD_DIR, `manifest-${TARGET}.json`);
  run(pythonExe(), [
    '-m', 'tools.build.asset_manifest', ROOT,
    '--target', TARGET,
    '--out', out,
    // 素材审计有 issue = 有引用指向不存在的文件。带着这种状态打包出来的一定会 404，
    // 与其发出去再发现，不如现在就停。
    '--strict',
  ]);
  const manifest = JSON.parse(readFileSync(out, 'utf-8'));
  info(`清单：${manifest.files.length} 个文件，${mb(manifest.totalBytes)}`);
  return manifest;
}

// ------------------------------------------------------------ 2. vite build

function viteBuild() {
  if (SKIP_VITE) {
    step('跳过 vite build（--skip-vite）');
    if (!existsSync(join(DIST_DIR, 'index.html'))) {
      throw new Error('dist/index.html 不存在，第一次打包不能用 --skip-vite');
    }
    return;
  }
  step(`vite build（mode=${TARGET === 'dev' ? 'development' : 'production'}）`);
  rmSync(DIST_DIR, { recursive: true, force: true });
  /**
   * dev 档要让 `import.meta.env.DEV` 为真 —— F2 面板、命令通道、`?mode=dev` 直达族
   * 全被 `isDevBuild` 守着，假就等于整批被静态剔除。
   *
   * **只给 `--mode development` 不够。** Vite 判 `isProduction` 看的是 `NODE_ENV`，
   * 而 `vite build` 会把没设的 `NODE_ENV` 默认成 `production`，`--mode` 压不过它。
   * 实测过：只给 --mode 打出来的 dev 包，连显式 `?mode=dev` 都不认，
   * 跟发行档一模一样 —— 而且没有任何报错，看着像成功了。
   */
  const modeArgs = TARGET === 'dev' ? ['--mode', 'development'] : [];
  const env = TARGET === 'dev' ? { NODE_ENV: 'development' } : { NODE_ENV: 'production' };
  runNodeBin('vite/bin/vite.js', ['build', ...modeArgs], env);
  if (!existsSync(join(DIST_DIR, 'index.html'))) {
    throw new Error('vite build 没有产出 dist/index.html');
  }
}

// -------------------------------------------------------------- 3. staging

async function stage(manifest) {
  step(`装配产物 → ${relative(ROOT, STAGING)}`);
  const gameDir = join(STAGING, 'game');
  rmSync(STAGING, { recursive: true, force: true });
  mkdirSync(gameDir, { recursive: true });

  // 3a. vite 产物（JS/CSS/index.html）
  const distFiles = await walkFiles(DIST_DIR);
  let distBytes = 0;
  for (const f of distFiles) {
    const rel = relative(DIST_DIR, f);
    copyInto(f, join(gameDir, rel));
    distBytes += statSync(f).size;
  }
  info(`代码产物：${distFiles.length} 个文件，${mb(distBytes)}`);

  // 3b. 清单里的素材
  let assetBytes = 0;
  let missing = 0;
  for (const rel of manifest.files) {
    const src = join(PUBLIC_DIR, rel.split('/').join(sep));
    if (!existsSync(src)) {
      warn(`清单里有、磁盘上没有：${rel}`);
      missing++;
      continue;
    }
    copyInto(src, join(gameDir, rel.split('/').join(sep)));
    assetBytes += statSync(src).size;
  }
  info(`素材：${manifest.files.length - missing} 个文件，${mb(assetBytes)}`);
  if (missing) throw new Error(`${missing} 个清单文件在磁盘上不存在，打包中止`);

  // 3c. 场景索引：按**已落地**的 assets/scenes 派生（不进抽取清单——它不是开发树里的文件，
  // 是产物自己的派生物；开发服由 vite 中间件按请求现算同一份）。Dev 菜单 / F2 靠它列全部场景。
  const sceneCount = await writeSceneIndex(gameDir);
  info(`场景索引：${sceneCount} 个场景 → ${SCENE_INDEX_REL}（打包时派生）`);

  const boot = bakeBootConfig(gameDir);
  return { gameDir, distBytes, assetBytes, boot };
}

/**
 * 把档位的启动缺省烘进产物。
 *
 * 游戏的引导态靠 URL 参数表达，而**双击 exe / 打开产物首页时地址栏是干净的**——
 * 不烘的话发行版每次都直接开一局新游戏，玩家走不到标题上那个「继续」。
 * 详见 `src/core/bootParams.ts` 的长注释与 `tools/build/build_config.json`。
 *
 * 写成**独立的 `boot.js`** 而不是内联 `<script>`：Tauri 那边的 CSP 是
 * `script-src 'self' …`，内联脚本要 `'unsafe-inline'` 或 nonce，而外部文件天然合规。
 */
function bakeBootConfig(gameDir) {
  const cfgPath = join(ROOT, 'tools', 'build', 'build_config.json');
  let bootQuery = '';
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    const raw = cfg?.targets?.[TARGET]?.bootQuery;
    bootQuery = typeof raw === 'string' ? raw.trim().replace(/^\?/, '') : '';
  } catch (e) {
    throw new Error(`读不了构建配置 ${relative(ROOT, cfgPath)}：${e.message}`);
  }

  const indexPath = join(gameDir, 'index.html');
  let html = readFileSync(indexPath, 'utf-8');
  if (bootQuery) {
    writeFileSync(
      join(gameDir, 'boot.js'),
      `// 由 scripts/package.mjs 按 target=${TARGET} 生成，改这里没用——改 tools/build/build_config.json\n`
      + `window.__GAMEDRAFT_BOOT_QUERY__ = ${JSON.stringify(bootQuery)};\n`,
      'utf-8',
    );
    // 必须排在那个 type=module 的入口**之前**：模块脚本一执行就读这个全局
    if (!html.includes('boot.js')) {
      html = html.replace(/<script\s+type="module"/, '<script src="./boot.js"></script>\n    <script type="module"');
      if (!html.includes('boot.js')) throw new Error('index.html 里找不到 type="module" 入口，无法注入 boot.js');
      writeFileSync(indexPath, html, 'utf-8');
    }
    info(`启动缺省：?${bootQuery}`);
  } else {
    info('启动缺省：无（产物首次加载走缺省路径＝直接开新局）');
  }
  return { bootQuery };
}

// ---------------------------------------------------------- 4. 音频转码

/**
 * wav → ogg。**只动 staging 副本**，开发树里的 wav 原样不动。
 *
 * 转完必须同步改写 staging 里 JSON 的引用——`audio_config.json` 的 `src` 写的是
 * `audio/bgm/x.wav`，文件改名了引用不改，游戏就是一片静音而且不报错。
 */
async function transcodeAudio(gameDir) {
  step('音频转码 wav → ogg');
  const wavs = (await walkFiles(join(gameDir, 'resources', 'runtime', 'audio')))
    .filter((f) => f.toLowerCase().endsWith('.wav'));
  if (wavs.length === 0) {
    info('没有 wav 要转');
    return { transcoded: 0, savedBytes: 0, skipped: false };
  }

  const ffmpeg = which('ffmpeg');
  if (!ffmpeg) {
    if (TARGET === 'release') {
      throw new Error(
        `找不到 ffmpeg，无法把 ${wavs.length} 个 wav 转成 ogg。\n`
        + '  发行包必须按要求转码——带着 wav 发出去等于悄悄改了交付内容。\n'
        + '  装一个：  winget install Gyan.FFmpeg\n'
        + '  只想先看看包长什么样：  node scripts/package.mjs --target dev',
      );
    }
    warn(`找不到 ffmpeg，${wavs.length} 个 wav 原样保留（dev 包可接受，发行包会直接报错）`);
    return { transcoded: 0, savedBytes: 0, skipped: true };
  }

  let before = 0;
  let after = 0;
  const renamed = new Map(); // public 相对路径：xxx.wav -> xxx.ogg
  for (const wav of wavs) {
    const ogg = `${wav.slice(0, -4)}.ogg`;
    before += statSync(wav).size;
    const r = spawnSync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', wav,
      '-c:a', 'libvorbis', '-qscale:a', '5',
      ogg,
    ], { stdio: 'inherit' });
    if (r.status !== 0 || !existsSync(ogg)) {
      throw new Error(`ffmpeg 转码失败：${relative(gameDir, wav)}`);
    }
    after += statSync(ogg).size;
    rmSync(wav);
    const relWav = relative(gameDir, wav).split(sep).join('/');
    renamed.set(relWav, `${relWav.slice(0, -4)}.ogg`);
  }
  info(`转了 ${wavs.length} 个：${mb(before)} → ${mb(after)}（省 ${mb(before - after)}）`);

  const rewritten = await rewriteAudioRefs(gameDir, renamed);
  info(`改写了 ${rewritten} 处 JSON 里的音频引用`);
  await assertNoDanglingWavRefs(gameDir);
  return { transcoded: wavs.length, savedBytes: before - after, skipped: false };
}

/**
 * 转码之后**再扫一遍**：产物里不许还有指向 `.wav` 的引用。
 *
 * 这是整条链唯一的闭环。改写函数只扫 `assets/**`、只认 `audio/` 下的文件——
 * 哪天有人把音效引用写进 `resources/` 下的某个 sidecar，或者把 wav 放到 `audio/`
 * 之外，改写就漏；而文件已经改名成 `.ogg`，引用还指着 `.wav`，结果是**一片静音
 * 且不报错**。验收门那边查的是"还有没有 .wav 文件"，恰好是互补的另一半，
 * 单独哪一半都拦不住这件事。
 */
async function assertNoDanglingWavRefs(gameDir) {
  const dangling = [];
  const seen = (rel, where) => dangling.push(`${where} → ${rel}`);
  const walkVal = (v, where) => {
    if (Array.isArray(v)) return v.forEach((x) => walkVal(x, where));
    if (v && typeof v === 'object') return Object.values(v).forEach((x) => walkVal(x, where));
    if (typeof v === 'string' && v.toLowerCase().endsWith('.wav')) seen(v, where);
  };
  for (const jp of (await walkFiles(gameDir)).filter((f) => f.endsWith('.json'))) {
    let data;
    try {
      data = JSON.parse(readFileSync(jp, 'utf-8'));
    } catch {
      continue;
    }
    walkVal(data, relative(gameDir, jp).split(sep).join('/'));
  }
  if (dangling.length) {
    throw new Error(
      `转码后产物里还有 ${dangling.length} 处指向 .wav 的引用（文件已改名成 .ogg，`
      + `这些引用会静默加载失败、表现为没声音）：\n  ${dangling.slice(0, 10).join('\n  ')}`
      + (dangling.length > 10 ? `\n  ...另 ${dangling.length - 10} 处` : ''),
    );
  }
  info('闭环检查：产物里零 .wav 引用');
}

/**
 * 把 staging 里 JSON 中指向已转码 wav 的引用改成 ogg。
 *
 * 逐个 JSON 走全部字符串叶子，只在**该字符串确实指向一个转过码的文件**时才改——
 * 全文替换 `.wav` 会误伤文案里提到的文件名、注释、还有没进包的路径。
 */
async function rewriteAudioRefs(gameDir, renamed) {
  if (renamed.size === 0) return 0;
  // 认三种写法：完整相对路径、短名（audio_config 里写的是 `audio/bgm/x.wav`）、
  // 带前导斜杠的绝对 URL。判定逻辑与单测同一份实现，见 scripts/lib/build_helpers.mjs。
  const index = new Set([
    ...renamed.keys(),
    ...[...renamed.keys()].map((k) => k.replace(/^resources\/runtime\//, '')),
  ]);

  let count = 0;
  const swap = (s) => {
    const out = swapWavRef(s, index);
    if (out !== s) count++;
    return out;
  };
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return swap(v);
  };

  const jsons = (await walkFiles(join(gameDir, 'assets'))).filter((f) => f.endsWith('.json'));
  for (const jp of jsons) {
    let data;
    const raw = readFileSync(jp, 'utf-8');
    try {
      data = JSON.parse(raw);
    } catch {
      continue; // 不是合法 JSON 就别碰它
    }
    const before = count;
    const next = walk(data);
    if (count !== before) {
      writeFileSync(jp, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
    }
  }
  return count;
}

// ------------------------------------------------------------- 5. 收尾报告

function writeReport(gameDir, stats) {
  const report = {
    target: TARGET,
    // 时间戳由调用方（这里）盖，脚本本身是确定性的
    builtAt: new Date().toISOString(),
    manifestFiles: stats.manifestFiles,
    codeBytes: stats.distBytes,
    assetBytes: stats.assetBytes,
    audio: stats.audio,
    boot: stats.boot,
    totalBytes: stats.totalBytes,
  };
  writeFileSync(join(STAGING, 'build-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  return report;
}

// ------------------------------------------------------------------ main

async function main() {
  const manifest = generateManifest();
  viteBuild();
  const { gameDir, distBytes, assetBytes, boot } = await stage(manifest);
  const audio = await transcodeAudio(gameDir);

  const allFiles = await walkFiles(gameDir);
  const totalBytes = allFiles.reduce((n, f) => n + statSync(f).size, 0);

  const report = writeReport(gameDir, {
    manifestFiles: manifest.files.length,
    distBytes,
    assetBytes,
    audio,
    boot,
    totalBytes,
  });

  step('完成');
  info(`产物：${relative(ROOT, gameDir)}`);
  info(`文件数：${allFiles.length}`);
  info(`体积：${mb(totalBytes)}（代码 ${mb(distBytes)} + 素材 ${mb(assetBytes - (audio.savedBytes || 0))}）`);
  if (audio.skipped) warn('音频未转码：产物里仍是 wav');
  info(`报告：${relative(ROOT, join(STAGING, 'build-report.json'))}`);
  info(`耗时：${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(
    `\n下一步：\n  验收产物   node scripts/verify_build.mjs --target ${TARGET}\n`
    + (TARGET === 'release' ? '  打 exe     npm run tauri:build\n' : ''),
  );
  return report;
}

main().catch((e) => {
  console.error(`\n[31m✖ 打包失败：${e.message}[0m`);
  process.exit(1);
});
