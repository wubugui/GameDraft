#!/usr/bin/env node
/**
 * 出一个**可以直接发布的绿色版**：抽取内容 → 验收 → 编译 exe → 装配到指定目录。
 *
 * 这是编辑器和自动化**共用的唯一入口**。两边的区别只有一个：传进来的 `--out-dir`。
 *
 *   编辑器手动 build   每次传同一个目录 → 覆盖上一次
 *   自动化定期 build   每次传一个新目录 → 全部留档
 *
 * 所以输出目录**不写进任何配置文件**——它不是"这个项目怎么构建"的一部分，
 * 而是"这一次把结果放哪"。档位差异（从哪个场景起、带不带调试设施）才在
 * `tools/build/build_config.json` 里，那份是存盘的，脱离编辑器也能跑。
 *
 * ## 产出
 *
 *   <out-dir>/gamedraft.exe          3 MB，双击即玩
 *   <out-dir>/game/                  游戏内容
 *   <out-dir>/.gamedraft-build.json  构建标记（下次覆盖的依据）+ 体积/耗时账
 *
 * 不打 NSIS 安装包：只要绿色版的话，makensis 压 566 MB 要多花四五分钟，
 * 对"定期自动构建"是纯浪费。要安装包单独跑 `npm run tauri:build`。
 *
 * ## 用法
 *
 *   node scripts/release.mjs --out-dir D:/builds/current
 *   node scripts/release.mjs --out-dir D:/builds/2026-08-28T09-00 --target dev
 *   node scripts/release.mjs --out-dir <非空的陌生目录> --force
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BUILD_MARKER, checkOutputPath, outputDirDisposition,
} from './lib/build_helpers.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 覆盖构建时**不删**的目录：玩家存档。
 *
 * 与 `src-tauri/src/gamedata.rs` 的 `resolve_root` 同名——那边把存档落在 exe 旁的
 * `gamedata/`，这边就得认得它。两处改名要一起改。
 */
const KEEP_ON_OVERWRITE = 'gamedata';

// ------------------------------------------------------------------ 参数

const args = process.argv.slice(2);
function flag(name, fallback = undefined) {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = args[i + 1];
  return next && !next.startsWith('--') ? next : true;
}
const TARGET = String(flag('target', 'release'));
const OUT_DIR = flag('out-dir');
const FORCE = Boolean(flag('force', false));
const SKIP_VERIFY = Boolean(flag('skip-verify', false));
/**
 * 全场景抓取扫描（scene_sweep.mjs）默认**开**：它是唯一能证明"清单没漏东西"的门
 * （静态比对只能证明"清单说要的都在"）。跳过要显式说，构建标记里会记 `swept: false`。
 */
const SKIP_SWEEP = Boolean(flag('skip-sweep', false));
/** 清单与 src/ 都没变时缺省复用上一次的扫描报告（全量扫描要二三十分钟）；显式要求重扫用这个。 */
const FORCE_SWEEP = Boolean(flag('force-sweep', false));

const t0 = Date.now();
const step = (m) => console.log(`\n\u001b[36m▶ ${m}\u001b[0m`);
const info = (m) => console.log(`  ${m}`);
const warn = (m) => console.log(`\u001b[33m  ⚠ ${m}\u001b[0m`);
const mb = (b) => `${(b / 1024 / 1024).toFixed(1)} MB`;

function die(msg, code = 2) {
  console.error(`\n\u001b[31m✖ ${msg}\u001b[0m`);
  process.exit(code);
}

if (!['dev', 'release'].includes(TARGET)) die(`未知 target: ${TARGET}（可用：dev / release）`);
if (!OUT_DIR || OUT_DIR === true) {
  die('必须给 --out-dir <目录>：这一次的结果放哪。\n'
    + '  它不写进配置文件——编辑器每次传同一个（覆盖），自动化每次传新的（留档）。');
}

// --------------------------------------------------------- 输出目录闸门

/** 目录现在是什么状态：missing / empty / previous-build / foreign */
function inspectOutDir(dir) {
  if (!existsSync(dir)) return 'missing';
  if (!statSync(dir).isDirectory()) return 'foreign';
  const entries = readdirSync(dir);
  if (entries.length === 0) return 'empty';
  return entries.includes(BUILD_MARKER) ? 'previous-build' : 'foreign';
}

const pathCheck = checkOutputPath(OUT_DIR, ROOT);
if (!pathCheck.ok) die(`输出目录不能用：${pathCheck.reason}`);
const outAbs = pathCheck.abs;

const disposition = outputDirDisposition(inspectOutDir(outAbs), { force: FORCE });
if (!disposition.ok) die(`${outAbs}\n  ${disposition.reason}`);

// ------------------------------------------------------------- 子进程

function run(cmd, cmdArgs, extraEnv = {}) {
  const r = spawnSync(cmd, cmdArgs, {
    stdio: 'inherit',
    cwd: ROOT,
    shell: false,
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
      // 刚装完 Rust 的机器上 PATH 还没刷新；补一手 cargo 的默认位置
      PATH: `${join(process.env.USERPROFILE || process.env.HOME || '', '.cargo', 'bin')}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
      ...extraEnv,
    },
  });
  if (r.error) throw r.error;
  return r.status ?? 1;
}

function runNode(script, scriptArgs) {
  return run(process.execPath, [join(ROOT, 'scripts', script), ...scriptArgs]);
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

/**
 * 覆盖前清掉上一次的构建产物，**但保住 `gamedata/`**。
 *
 * 手动构建的常态就是"输出目录不变、反复覆盖"，而 `gamedata/` 是**玩家存档**
 * ——整目录 `rm -rf` 会让每次构建都把自己的存档清掉。存档是这一整轮改动
 * 好不容易才让它"待在一个人能找到的地方"的东西，不能在这里又给弄丢。
 *
 * 残留的其它文件照清：说不清"这个包里到底有什么"比多留几个文件更糟。
 */
function clearBuildOutputs(dir) {
  for (const name of readdirSync(dir)) {
    if (name === KEEP_ON_OVERWRITE) continue;
    try {
      rmSync(join(dir, name), { recursive: true, force: true });
    } catch (e) {
      // 上一次构建出来的 exe 很可能还开着——那时删它会以 EBUSY/EPERM 失败。
      // 这个提示比原始错误码有用得多。
      die(
        `清理输出目录失败：${e.message}\n`
        + `  ${join(dir, name)}\n`
        + '  最常见的原因是**上一次构建出来的 gamedraft.exe 还开着**'
        + '（或者有资源管理器/杀软正占着里面的文件）。关掉再跑一次。',
      );
    }
  }
}

function copyTree(srcDir, destDir) {
  mkdirSync(destDir, { recursive: true });
  for (const name of readdirSync(srcDir)) {
    const s = join(srcDir, name);
    const d = join(destDir, name);
    if (statSync(s).isDirectory()) copyTree(s, d);
    else copyFileSync(s, d);
  }
}

/**
 * `src/` 下每个 .ts 的 (相对路径, 大小, mtime_ns) 指纹——与
 * `tools/build/scene_sweep.py` 的 `src_fingerprint` 同一条公式（每行 `rel\tsize\tmtime_ns`，
 * 按 rel 排序）。算不出来返回空串 = 永远不复用（安全方向）。
 */
async function srcFingerprint(srcRoot) {
  try {
    const rows = [];
    for (const f of await walkFiles(srcRoot)) {
      if (!f.endsWith('.ts')) continue;
      const st = statSync(f, { bigint: true });
      rows.push([relative(srcRoot, f).split(sep).join('/'), st.size, st.mtimeNs]);
    }
    rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const h = createHash('sha1');
    for (const [rel, size, mtime] of rows) h.update(`${rel}\t${size}\t${mtime}\n`);
    return h.digest('hex');
  } catch {
    return '';
  }
}

/**
 * 上一次的扫描报告还作不作数：对的是**当前这份清单**、跑的时候 src/ 与现在逐字节同版、
 * 全量（非 --scenes/--limit）且 PASS。四条缺一不可；缺的那条就是重扫的理由。
 */
async function sweepReportReusable(target) {
  const sweepPath = join(ROOT, '.build', `sweep-${target}.json`);
  const manifestPath = join(ROOT, '.build', `manifest-${target}.json`);
  if (!existsSync(sweepPath) || !existsSync(manifestPath)) return { ok: false, why: '没有上一次的扫描报告' };
  let s;
  try {
    s = JSON.parse(readFileSync(sweepPath, 'utf-8'));
  } catch {
    return { ok: false, why: '扫描报告读不出来' };
  }
  const manifestSha1 = createHash('sha1').update(readFileSync(manifestPath)).digest('hex');
  if (s.manifestSha1 !== manifestSha1) return { ok: false, why: '清单变了' };
  const fp = await srcFingerprint(join(ROOT, 'src'));
  if (!fp || !s.srcFingerprint || s.srcFingerprint !== fp) return { ok: false, why: 'src/ 变了（或报告没记指纹）' };
  if (s.partial) return { ok: false, why: '上一次是部分扫描' };
  if (s.verdict !== 'PASS') return { ok: false, why: '上一次没通过' };
  return { ok: true, sweptAt: s.sweptAt, summary: s.summary };
}

// ------------------------------------------------------------------ main

async function main() {
  console.log(`发布构建：target=${TARGET}`);
  console.log(`输出目录：${outAbs}（${{
    create: '新建', use: '目录为空，直接用', overwrite: '覆盖上一次构建',
  }[disposition.action]}）`);

  step('1/5 抽取内容');
  if (runNode('package.mjs', ['--target', TARGET]) !== 0) die('打包失败，见上面的输出');

  // 扫描排在静态验收**之前**：它写出 .build/sweep-<target>.json，验收门会把这份结果
  // 按清单哈希对账后一并计入——于是 verify-report.json 里同时有静态与动态两半的结论。
  step('2/5 全场景抓取扫描（真跑每个场景，反向核对清单）');
  if (SKIP_SWEEP) {
    warn('--skip-sweep：跳过全场景扫描。清单漏没漏东西这一步就没人证明了。');
  } else {
    const reuse = FORCE_SWEEP ? { ok: false, why: '--force-sweep' } : await sweepReportReusable(TARGET);
    if (reuse.ok) {
      info(`复用 ${reuse.sweptAt} 的扫描报告：清单与 src/ 都没变，${reuse.summary?.scenes ?? '?'} 个场景零漏抽（要重扫加 --force-sweep）`);
    } else {
      info(`重扫（${reuse.why}）`);
      if (runNode('scene_sweep.mjs', ['--target', TARGET]) !== 0) {
        die('全场景扫描不通过，不出包：运行时真会请求的文件不在抽取清单里，见上面的输出。\n'
          + '  补 tools/build/manifest_rules.json 或 asset_manifest.py 的展开器；'
          + '确认可以接受的话加 --skip-sweep 再跑一次。');
      }
    }
  }

  step('3/5 验收产物');
  if (SKIP_VERIFY) {
    warn('--skip-verify：跳过验收。发布前请自行确认。');
  } else if (runNode('verify_build.mjs', ['--target', TARGET, '--port', '5299']) !== 0) {
    die('验收不通过，不出包。\n'
      + '  确认那些问题可以接受的话，加 --skip-verify 再跑一次。');
  }

  step('4/5 编译 exe');
  // --no-bundle：只要绿色版，不打 NSIS。省掉 makensis 压 566 MB 的四五分钟。
  const tauriCli = join(ROOT, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
  if (!existsSync(tauriCli)) die('找不到 @tauri-apps/cli，先 npm install');
  if (run(process.execPath, [tauriCli, 'build', '--no-bundle']) !== 0) {
    die('exe 编译失败，见上面的输出（需要 Rust 工具链：winget install Rustlang.Rustup）');
  }
  const exeSrc = join(ROOT, 'src-tauri', 'target', 'release', 'gamedraft.exe');
  if (!existsSync(exeSrc)) die(`编译报成功但找不到 ${relative(ROOT, exeSrc)}`);

  step('5/5 装配到输出目录');
  if (disposition.action === 'overwrite') clearBuildOutputs(outAbs);
  mkdirSync(outAbs, { recursive: true });

  copyFileSync(exeSrc, join(outAbs, 'gamedraft.exe'));
  const gameSrc = join(ROOT, 'release', TARGET, 'game');
  if (!existsSync(gameSrc)) die(`找不到打包内容 ${relative(ROOT, gameSrc)}`);
  copyTree(gameSrc, join(outAbs, 'game'));

  const files = await walkFiles(outAbs);
  const totalBytes = files.reduce((n, f) => n + statSync(f).size, 0);

  let packageReport = null;
  try {
    packageReport = JSON.parse(readFileSync(join(ROOT, 'release', TARGET, 'build-report.json'), 'utf-8'));
  } catch { /* 有更好，没有也不挡 */ }
  let sweepSummary = null;
  if (!SKIP_SWEEP) {
    try {
      const s = JSON.parse(readFileSync(join(ROOT, '.build', `sweep-${TARGET}.json`), 'utf-8'));
      sweepSummary = { verdict: s.verdict, sweptAt: s.sweptAt, ...(s.summary ?? {}) };
    } catch { /* 扫描门已经通过了才会走到这里；报告读不出来不挡出包 */ }
  }

  const marker = {
    tool: 'gamedraft/scripts/release.mjs',
    target: TARGET,
    builtAt: new Date().toISOString(),
    fileCount: files.length,
    totalBytes,
    verified: !SKIP_VERIFY,
    // 全场景抓取扫描：true = 每个场景真跑过、运行时请求的文件全在清单里
    swept: !SKIP_SWEEP,
    sweep: sweepSummary,
    package: packageReport,
    // 这个文件的存在就是"可以覆盖"的依据，见 build_helpers.BUILD_MARKER
    note: '本目录由 GameDraft 构建生成，再次构建到这里会被整体覆盖。',
  };
  writeFileSync(join(outAbs, BUILD_MARKER), `${JSON.stringify(marker, null, 2)}\n`, 'utf-8');

  step('完成');
  info(`${outAbs}`);
  info(`  gamedraft.exe   ${mb(statSync(join(outAbs, 'gamedraft.exe')).size)}`);
  info(`  game/           ${files.length - 2} 个文件`);
  info(`总计 ${mb(totalBytes)}，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`\n双击 ${join(outAbs, 'gamedraft.exe')} 即可运行（存档落在同目录的 gamedata/）。`);
}

main().catch((e) => {
  console.error(`\n\u001b[31m✖ 发布构建失败：${e.stack ?? e.message}\u001b[0m`);
  process.exit(1);
});
