#!/usr/bin/env node
/**
 * 产物验收门：证明打出来的包**能玩**，而不只是"构建没报错"。
 *
 * 这两件事差得很远。清单漏抽一个素材、发行档没剥干净调试后门、staging 少拷一个文件
 * ——构建全都会成功，然后玩家拿到一个黑屏或者一堆 404。
 *
 * ## 三道检查
 *
 * 1. **完整性**：清单承诺的文件是不是都在？入口 HTML 与 JS 在不在？
 * 2. **发行卫生**：release 档里不该有 authoring 残留（`.py` / `.npy` / preview / 备份），
 *    也不该留 dev 直达后门（`?play_cutscene` 那一族 URL 参数是明确的发行阻断项，
 *    见 `src/main.ts` 的注释）。
 * 3. **可服务**：真起一个静态服务，把入口和 JS 抓下来，确认字节能出得去。
 *
 * ## 404 记录模式
 *
 * `--serve` 会把服务留着不退，并把每一个 404 记进 `verify-report.json`。
 * 真跑一遍游戏（浏览器或 headless agent）之后看这份记录，就知道清单到底漏没漏东西
 * ——这是静态分析永远证明不了、只能靠跑出来的那一半。
 *
 * 用法：
 *   node scripts/verify_build.mjs --target release
 *   node scripts/verify_build.mjs --target dev --serve --port 5199
 */

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync, statSync, createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  bakeFreshness,
  classify404,
  classifyLeak,
  decodeUrlPath,
  manifestEntryLanded,
  safeStaticPath,
} from './lib/build_helpers.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
function flag(name, fallback = undefined) {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = args[i + 1];
  return next && !next.startsWith('--') ? next : true;
}
const TARGET = String(flag('target', 'release'));
const SERVE = Boolean(flag('serve', false));
const PORT = Number(flag('port', 5199));
const STAGING = String(flag('dir', join(ROOT, 'release', TARGET)));
const GAME_DIR = join(STAGING, 'game');

const problems = [];
const notes = [];
function fail(msg) {
  problems.push(msg);
  console.log(`[31m  ✖ ${msg}[0m`);
}
function pass(msg) {
  console.log(`[32m  ✓ ${msg}[0m`);
}
function note(msg) {
  notes.push(msg);
  console.log(`[33m  · ${msg}[0m`);
}
function step(msg) {
  console.log(`\n[36m▶ ${msg}[0m`);
}
function mb(n) {
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
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

// ------------------------------------------------------------ 1. 完整性

async function checkIntegrity() {
  step('完整性');
  if (!existsSync(GAME_DIR)) {
    fail(`产物目录不存在：${relative(ROOT, GAME_DIR)}（先跑 npm run package:${TARGET}）`);
    return { files: [], relSet: new Set() };
  }
  const files = await walkFiles(GAME_DIR);
  const relSet = new Set(files.map((f) => relative(GAME_DIR, f).split(sep).join('/')));

  if (relSet.has('index.html')) pass('入口 index.html 在');
  else fail('缺 index.html');

  const jsFiles = [...relSet].filter((r) => r.endsWith('.js'));
  if (jsFiles.length) pass(`JS 产物 ${jsFiles.length} 个`);
  else fail('一个 JS 文件都没有——vite build 的产物没进来');

  // 清单承诺 vs 实际落地
  const manifestPath = join(ROOT, '.build', `manifest-${TARGET}.json`);
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    // 清单记源文件名（.wav），发行档落地的是 .ogg——比对要认这层转码，
    // 逐字比对会把 194 个音频误报成"没落地"。判定见 lib/build_helpers.mjs。
    const missing = manifest.files.filter((r) => !manifestEntryLanded(r, relSet));
    const transcoded = manifest.files
      .filter((r) => !relSet.has(r) && manifestEntryLanded(r, relSet)).length;
    if (missing.length === 0) {
      pass(
        `清单 ${manifest.files.length} 个文件全部落地`
        + (transcoded ? `（其中 ${transcoded} 个音频以 .ogg 形态）` : ''),
      );
    } else {
      fail(`清单里有 ${missing.length} 个文件没落地，例如：${missing.slice(0, 3).join(', ')}`);
    }
  } else {
    note(`没有 ${relative(ROOT, manifestPath)}，跳过清单比对`);
  }

  const total = files.reduce((n, f) => n + statSync(f).size, 0);
  pass(`共 ${files.length} 个文件，${mb(total)}`);
  return { files, relSet, totalBytes: total };
}

// -------------------------------------------------------- 2. 发行卫生

/**
 * 发行档必须成立的两条判据。
 *
 * ## 为什么不搜 `play_cutscene` 这类 URL 参数名
 *
 * 试过，**全是误报**：那些字面量在发行包里合法存在，因为
 * `EventBridge.restartPage()` 要用它们做 URL 净化名单（"新游戏 = 净化 URL 整页 reload"，
 * 见 save-restore-contracts 卡）。参数名在不在，和后门活没活，是两件事。
 *
 * 真正说明问题的是下面这两条：
 *
 * - `import.meta.env` **必须消失**。它是 vite 的编译期替换目标；还能搜到就说明
 *   define 那一趟没跑，`isDevBuild` 在运行时不是 false —— 那才是后门真的活着。
 * - dev 专属 UI 的类名**必须消失**。它们只在 `isDevBuild` 分支里被构造，
 *   常量折叠 + 摇树之后应当整棵不见。还在 = 死代码没消掉，包白胖一圈，
 *   而且说明剥离没有按预期发生。
 *
 * 行为层面的证明（发行包开 `?mode=dev` 应当**没有**任何 dev UI）只能靠真跑，
 * 见文件头 `--serve` 那一段。
 */
const RELEASE_MUST_NOT_CONTAIN = [
  { lit: 'import.meta.env', why: 'vite 的编译期替换没跑——dev 门在运行时不是 false' },
  { lit: 'DevModeUI', why: 'dev 跳场景面板没被摇掉' },
  { lit: 'DebugPanelUI', why: 'F2 调试面板没被摇掉' },
];

async function checkHygiene(relSet) {
  step('发行卫生');
  let leaks = 0;
  for (const rel of relSet) {
    const leak = classifyLeak(rel);
    if (leak) {
      fail(`authoring 残留（${leak.why}）：${rel}`);
      leaks++;
    }
  }
  if (!leaks) pass('没有 authoring 残留');

  const jsFiles = [...relSet].filter((r) => r.endsWith('.js'));
  const readJs = (rel) => {
    try {
      return readFileSync(join(GAME_DIR, rel.split('/').join(sep)), 'utf-8');
    } catch {
      return '';
    }
  };

  /**
   * **产物到底是哪一档。**
   *
   * `src/main.ts` 把编译期的 `import.meta.env.DEV` 折叠成一个字面量字符串写进
   * `__GAMEDRAFT_BUILD__`，所以这里能静态判死。
   *
   * 踩过一次才加的：dev 档只给了 `vite build --mode development` 而没设
   * `NODE_ENV=development`，`import.meta.env.DEV` 仍编译成 false，整批调试设施被剔除
   * ——打出来的 dev 包跟发行档一模一样，连显式 `?mode=dev` 都不认，**而且没有任何报错**。
   * 别的标记都不可靠：类名被 esbuild 压掉、`__gameDevAPI` 在 destroy 清理路径里两档都有。
   */
  // 引号形式不能写死：压缩器（Vite 8 的 rolldown/oxc）会把字符串字面量改写成
  // 反引号模板，`="dev"` 这种精确匹配会扑空。三种引号都认。
  const stampRe = (v) => new RegExp(`__GAMEDRAFT_BUILD__\\s*=\\s*["'\`]${v}["'\`]`);
  const stampedDev = jsFiles.some((r) => stampRe('dev').test(readJs(r)));
  const stampedRelease = jsFiles.some((r) => stampRe('release').test(readJs(r)));
  if (stampedDev === stampedRelease) {
    fail(`产物没有可识别的档位标记（dev=${stampedDev} release=${stampedRelease}）——main.ts 的 __GAMEDRAFT_BUILD__ 没进产物？`);
  } else if ((TARGET === 'dev') !== stampedDev) {
    fail(
      `档位对不上：要打的是 ${TARGET}，产物标的是 ${stampedDev ? 'dev' : 'release'}。`
      + (TARGET === 'dev'
        ? ' import.meta.env.DEV 编译成了 false，整批调试设施被剔除，这个包实际上等于发行档。'
        : ' 调试设施可能没剥干净。'),
    );
  } else {
    pass(`档位标记正确：${TARGET}`);
  }

  if (TARGET !== 'release') {
    note('dev 档：保留调试设施，跳过发行专有的剥离检查');
    return;
  }
  let found = 0;
  for (const rel of jsFiles) {
    const text = readJs(rel);
    for (const { lit, why } of RELEASE_MUST_NOT_CONTAIN) {
      if (text.includes(lit)) {
        fail(`发行包里还有 "${lit}"（${rel}）——${why}`);
        found++;
      }
    }
  }
  if (!found) pass(`dev 设施已剥净（查了 ${jsFiles.length} 个 JS）`);

  const wavs = [...relSet].filter((r) => r.toLowerCase().endsWith('.wav'));
  if (wavs.length) fail(`发行包里还有 ${wavs.length} 个未转码的 wav`);
  else pass('音频已全部转码（无 wav 残留）');
}

// ---------------------------------------------------- 2b. 内容一致性（烘焙新鲜度）

/**
 * 光照烘焙与背景图是不是同一版。
 *
 * **这一类问题所有既有的门都抓不到**：文件都在（素材审计过）、路径都对（不产生 404）、
 * 类型也对，唯独**内容换了**——重画了背景却没重烘光照。运行时的表现是
 * `[CharLighting] ERROR: <场景> : 照明烘焙过期(bake X vs bg Y)，已禁用`，
 * 那个场景的角色光照被**整个关掉**，画面明显不对但没有任何一条报错指向根因。
 *
 * 判据与运行时逐字一致：`lighting/lighting.json` 的 `background_sha1`
 * 是 `background.png` 的 SHA-1 前 12 位（见 src/core/CharacterLightingSystem.ts 的哈希门）。
 *
 * 放在验收门而不是打包器里：打 dev 包做测试不该被一条存量数据问题卡住，
 * 但"这个包能不能发"必须知道。
 */
async function checkBakeFreshness(relSet) {
  step('内容一致性（光照烘焙 vs 背景图）');
  const scenes = [...relSet]
    .filter((r) => /^resources\/runtime\/scenes\/[^/]+\/lighting\/lighting\.json$/.test(r))
    .map((r) => r.split('/')[3]);
  if (scenes.length === 0) {
    note('产物里没有角色光照载荷，跳过');
    return;
  }
  let stale = 0;
  for (const scene of scenes) {
    const lightJson = `resources/runtime/scenes/${scene}/lighting/lighting.json`;
    const bgRel = `resources/runtime/scenes/${scene}/background.png`;
    if (!relSet.has(bgRel)) {
      note(`${scene}: 有光照载荷但产物里没有 background.png，跳过比对`);
      continue;
    }
    let baked;
    try {
      baked = JSON.parse(readFileSync(join(GAME_DIR, lightJson.split('/').join(sep)), 'utf-8'))
        ?.background_sha1;
    } catch {
      fail(`${scene}: lighting.json 读不出来`);
      stale++;
      continue;
    }
    const actualFull = createHash('sha1')
      .update(readFileSync(join(GAME_DIR, bgRel.split('/').join(sep))))
      .digest('hex');
    const v = bakeFreshness(baked, actualFull);
    if (v.ok === null) {
      note(`${scene}: ${v.reason}，跳过`);
      continue;
    }
    if (!v.ok) {
      fail(
        `${scene}: 光照烘焙过期（烘焙时 bg=${v.baked}，包里 bg=${v.actual}）`
        + ' —— 运行时会把这个场景的角色光照整个禁用',
      );
      stale++;
    }
  }
  if (!stale) pass(`${scenes.length} 个场景的光照烘焙与背景图一致`);
  else note('重烘那几个场景，或把 background.png 恢复到烘焙时那一版');
}

// -------------------------------------------------------- 3. 起服 + 404 记录

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.bin': 'application/octet-stream',
  '.glsl': 'text/plain; charset=utf-8',
};

const missed = new Map();

function startServer() {
  const server = createServer((req, res) => {
    // 畸形转义（`%ZZ`）在 http 处理器里同步抛出去**整个进程就没了**——而 --serve
    // 是设计来挂着让人跑一小时游戏的，攒的 404 记录会跟着一起蒸发。
    const urlPath = decodeUrlPath(req.url);
    if (urlPath === null) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('malformed url escape');
      return;
    }
    // 随时查当前 404 记录，不必停掉服务——真跑验证时要一边玩一边看漏了什么
    if (urlPath === '/__verify/404') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        count: missed.size,
        entries: [...missed.entries()].map(([url, n]) => ({ url, n })),
      }, null, 2));
      return;
    }
    const safe = safeStaticPath(GAME_DIR, urlPath);
    if (!safe.ok) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('bad path');
      return;
    }
    const { disk } = safe;
    if (!existsSync(disk) || !statSync(disk).isFile()) {
      missed.set(urlPath, (missed.get(urlPath) ?? 0) + 1);
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`404 ${urlPath}`);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[extname(disk).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    createReadStream(disk).pipe(res);
  });
  return new Promise((res, rej) => {
    server.on('error', rej);
    server.listen(PORT, '127.0.0.1', () => res(server));
  });
}

async function checkServable(server) {
  step('可服务');
  const base = `http://127.0.0.1:${PORT}`;
  const html = await fetch(`${base}/index.html`).then((r) => (r.ok ? r.text() : null)).catch(() => null);
  if (!html) {
    fail('取不到 index.html');
    return;
  }
  pass(`index.html 可取（${html.length} 字节）`);

  // 从 index.html 里把 <script src> / <link href> 抠出来，逐个抓一遍——
  // 入口引用的东西必须都在，否则就是白屏。
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1])
    .filter((u) => !u.startsWith('http') && !u.startsWith('data:'));
  let bad = 0;
  for (const r of refs) {
    const u = new URL(r.replace(/^\.\//, '/'), base);
    const ok = await fetch(u).then((x) => x.ok).catch(() => false);
    if (!ok) {
      fail(`入口引用取不到：${r}`);
      bad++;
    }
  }
  if (!bad) pass(`入口引用全部可取（${refs.length} 个）`);
  void server;
}

// ------------------------------------------------------------------ main

async function main() {
  console.log(`验收产物：${relative(ROOT, GAME_DIR)}（target=${TARGET}）`);
  const { relSet, totalBytes } = await checkIntegrity();
  if (relSet.size) {
    await checkHygiene(relSet);
    await checkBakeFreshness(relSet);
  }

  let server = null;
  try {
    server = await startServer();
    await checkServable(server);
  } catch (e) {
    fail(`起静态服务失败：${e.message}`);
  }

  const report = {
    target: TARGET,
    checkedAt: new Date().toISOString(),
    gameDir: relative(ROOT, GAME_DIR),
    fileCount: relSet.size,
    totalBytes: totalBytes ?? 0,
    problems,
    notes,
    missing404: [...missed.entries()].map(([url, count]) => ({ url, count })),
    verdict: problems.length === 0 ? 'PASS' : 'FAIL',
  };

  if (SERVE) {
    step('保持服务，记录 404');
    console.log(`  ${`http://127.0.0.1:${PORT}/`}`);
    console.log('  现在去真跑一遍游戏；Ctrl-C 结束后 404 记录会写进报告。');
    const finish = () => {
      const all = [...missed.entries()].map(([url, count]) => ({ url, count }));
      const real = [];
      const expected = [];
      for (const m of all) {
        const known = classify404(m.url);
        if (known) expected.push({ ...m, why: known.why });
        else real.push(m);
      }
      report.missing404 = real;
      report.expected404 = expected;
      report.verdict = problems.length === 0 && real.length === 0 ? 'PASS' : 'FAIL';
      writeFileSync(join(STAGING, 'verify-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf-8');

      console.log(`\n404 记录：${all.length} 种（按设计 ${expected.length} 种，真漏 ${real.length} 种）`);
      if (expected.length) {
        console.log('\n[33m按设计会 404（不算问题）：[0m');
        for (const m of expected.slice(0, 20)) console.log(`  ${m.count}×  ${m.url}\n       ${m.why}`);
      }
      if (real.length) {
        console.log('\n[31m真的漏抽了（要补 tools/build/manifest_rules.json）：[0m');
        for (const m of real.slice(0, 40)) console.log(`  ${m.count}×  ${m.url}`);
      } else {
        console.log('\n[32m没有漏抽的素材。[0m');
      }
      process.exit(report.verdict === 'PASS' ? 0 : 1);
    };
    process.on('SIGINT', finish);
    process.on('SIGTERM', finish);
    return;
  }

  server?.close();
  writeFileSync(join(STAGING, 'verify-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
  step(report.verdict === 'PASS' ? '通过' : '不通过');
  if (problems.length) {
    console.log(`  ${problems.length} 个问题，详见 ${relative(ROOT, join(STAGING, 'verify-report.json'))}`);
  }
  console.log(
    '\n静态检查证明不了"能玩"。要真跑一遍：\n'
    + `  node scripts/verify_build.mjs --target ${TARGET} --serve\n`
    + '  然后用浏览器/headless agent 打开它，走一段流程，Ctrl-C 看 404 记录。\n',
  );
  process.exit(report.verdict === 'PASS' ? 0 : 1);
}

main().catch((e) => {
  console.error(`\n[31m✖ 验收脚本自身出错：${e.stack ?? e.message}[0m`);
  process.exit(2);
});
