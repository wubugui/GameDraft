#!/usr/bin/env node
/**
 * A/B 真游戏对照:两个 git 提交(缺省 A = origin/master、B = HEAD)各自一棵**完全独立**的工作树、各自 `npm ci`、
 * 各自跑自己未改动的 dev 服,由外部用同一串输入、同一套确定性控制驱动两局游戏,逐检查点比截图 / 状态 / 报错,
 * 并用 A/A、B/B 重复运行量出噪声底,只报超出噪声底的差异。方法与局限见同目录 README.md。
 *
 * 用法(Windows,制作人机器:真 GPU、素材在):
 *   node tools/ab_compare/run.mjs                                   # 全部场景种类(很久;先用过滤试)
 *   node tools/ab_compare/run.mjs --scenes dev_room,河边            # 只跑这几个场景(及其 NPC / 缩放 / DPR)
 *   node tools/ab_compare/run.mjs --only scene,npc --npcs-per-scene 1
 *   node tools/ab_compare/run.mjs --a origin/master --b HEAD --perf
 *   (浏览器缺省 channel chrome,起不来退到 msedge;有头)
 *   playwright-core 仓库不装:装在任意目录后指过去,PowerShell `$env:PLAYWRIGHT_CORE="D:\x\node_modules\playwright-core"`,
 *   cmd `set PLAYWRIGHT_CORE=D:\x\node_modules\playwright-core`
 *
 * 用法(Linux 容器,无显示、无素材):
 *   xvfb-run -a node tools/ab_compare/run.mjs --browser /opt/pw-browsers/chromium-1194/chrome-linux/chrome --swiftshader \
 *     --scenes dev_room,teahouse,河边 --only scene,npc,minigame,cutscene --npcs-per-scene 1 \
 *     --minigames water:dev_pond --cutscenes prologue_day_end
 *   (无头 Chromium 上屏会丢 WebGPU 设备,所以一律有头 + xvfb-run;npm 源被墙时加 --npm-registry https://registry.npmjs.org/)
 *
 * 选项:
 *   --a <ref> / --b <ref>          两侧提交(B 取提交;主工作区未提交的改动不在 B 里,会大声提示)
 *   --only <种类,…>                scene,npc,minigame,cutscene,warp,resize,dpr(缺省全部)
 *   --scenes <id,…>                场景过滤(作用于 scene / npc / resize / dpr)
 *   --npcs-per-scene <n>           每个场景取前 n 个有对话图的 NPC(缺省 2)
 *   --minigames first|all|<kind:id,…>   缺省 first(每种第一个);种类 water/sugarWheel/paperCraft/objectExamine/pressureHold
 *   --cutscenes <id,…> / --warps <id,…>  缺省全部
 *   --resize-scenes / --dpr-scenes <id,…> 缺省选中场景的前两个
 *   --repeats <1|2>                每侧跑几轮(缺省 2:A1 B1 A2 B2,量噪声底;1 = 不量)
 *   --viewport 1280x720 --dpr 1    视口与 deviceScaleFactor
 *   --chunk <n>                    锁步粒度:每次假时钟前进 n 帧再 stepFixedTicks(n)(缺省 1)
 *   --settle <ms>                  就绪后墙钟沉淀(缺省 2500)
 *   --freeze ready|settled|boot    冻结逻辑的时机:就绪同一任务里(缺省)| 沉淀之后(按原始顺序)|
 *                                  一挂出 __game 就冻(装载期不跑任何真实时间的逻辑帧;消掉「装载快慢不同 → 状态不同」)
 *   --boot-timeout <ms>            冷启动就绪上限(缺省 180000)
 *   --step-timeout <ms>            单次推进上限(缺省 180000)
 *   --epoch <ISO>  --pause-offset <ms>  --seed <int>   确定性参数(两边相同)
 *   --threshold 16 --noise-factor 2 --margin 0.1       像素判定
 *   --ignore-row-shift             超噪声的像素差若 ≥95% 可由 ±1 行位移解释(WebGL/WebGPU 半像素水平边),不判失败(照样列出)
 *   --assets <dir>                 素材目录(缺省 <主工作区>/public/resources/runtime)
 *   --browser <exe> | --channel chrome|msedge   --headless   --swiftshader   --reuse-browser
 *   --npm-registry <url>           npm ci 改走这个源(--replace-registry-host=always)
 *   --no-install                   不跑 npm ci(依赖缺了直接报错)
 *   --port <n>                     dev 服起始端口(缺省 5211)
 *   --origin-port <n>              页面看到的源端口(缺省 5173 = 规范 dev 源;两边相同,浏览器解析规则改道到各自真端口,不实际连它)
 *   --out <dir>                    输出目录(缺省 .tools/ab_out/latest;只清自己建的目录)
 *   --embed-images  --keep-raw     报告内嵌缩略图 / 保留每轮原始截图与运行记录
 *   --recompare                    不重跑:拿 --out 目录里 --keep-raw 留下的原始截图,按当前判定参数重比、重出报告
 *   --perf --perf-scenes <id,…> --perf-seconds 4   真实时间性能 + JS 堆对照(--perf-only:只跑这一项)
 *
 * 退出码:0 = B 在噪声底内与 A 一致且无新增报错;1 = 有超噪声的分歧 / B 新增报错 / 有场景无法对照(A 没起来)/
 *        独立性复核不过;2 = 工具自身失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareScenario } from './compare.mjs';
import { launchBrowser, loadPlaywright, runPerf, runScenario, warmUp } from './driver.mjs';
import { renderReport } from './report.mjs';
import { KINDS, buildScenarios } from './scenarios.mjs';
import {
  checkViteDeps, ensureDeps, ensureWorktree, killTree, linkAssets, mainTreeDirt, makeGit, pickPort, resolveCommit,
  startVite, trackedChanges, untrackedFiles, wipeIsolatedSaves,
} from './trees.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const argv = process.argv.slice(2);

function arg(name, fallback) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}` && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) return argv[i + 1];
    if (argv[i].startsWith(`--${name}=`)) return argv[i].slice(name.length + 3);
  }
  return fallback;
}
const has = (name) => argv.includes(`--${name}`);
const list = (name) => {
  const v = arg(name, '');
  return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : null;
};
const log = (...a) => console.log(...a);

if (has('help') || has('h')) {
  const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  console.log(src.slice(src.indexOf('/**') + 3, src.indexOf('*/')).replace(/^ \* ?/gm, ''));
  process.exit(0);
}

const [vw, vh] = arg('viewport', '1280x720').split('x').map(Number);
const opts = {
  viewport: { width: vw, height: vh },
  dpr: Number(arg('dpr', '1')),
  repeats: Math.max(1, Math.min(2, Number(arg('repeats', '2')))),
  chunk: Math.max(1, Math.min(200, Number(arg('chunk', '1')))),
  settle: Number(arg('settle', '2500')),
  freezeAt: ['settled', 'boot'].includes(arg('freeze', 'ready')) ? arg('freeze', 'ready') : 'ready',
  bootTimeout: Number(arg('boot-timeout', '180000')),
  stepTimeout: Number(arg('step-timeout', '180000')),
  epoch: Date.parse(arg('epoch', '2026-01-01T09:00:00+08:00')),
  pauseOffset: Number(arg('pause-offset', '600000')),
  seed: Number(arg('seed', '20260101')) | 0,
  threshold: Number(arg('threshold', '16')),
  noiseFactor: Number(arg('noise-factor', '2')),
  margin: Number(arg('margin', '0.1')),
  ignoreRowShift: has('ignore-row-shift'),
  headless: has('headless'),
  swiftshader: has('swiftshader'),
  browserPath: arg('browser', process.env.AB_COMPARE_BROWSER ?? ''),
  channel: arg('channel', ''),
  embed: has('embed-images'),
  perfSeconds: Number(arg('perf-seconds', '4')),
  perfSettle: 2000,
};
if (!Number.isFinite(opts.epoch)) {
  console.error('--epoch 解析不了');
  process.exit(2);
}

const git = makeGit(repoRoot);
const outDir = path.resolve(arg('out', path.join(repoRoot, '.tools', 'ab_out', 'latest')));

/** 输出目录只清自己建的(有 .ab_out 标记)或空目录,别的一律拒绝,免得 --out 指错把别人的东西删了 */
function prepareOut(dir) {
  if (fs.existsSync(dir)) {
    const entries = fs.readdirSync(dir);
    if (entries.length && !entries.includes('.ab_out')) {
      console.error(`输出目录 ${dir} 非空且不是本工具建的(缺 .ab_out 标记),不清它;换一个 --out`);
      process.exit(2);
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.ab_out'), 'tools/ab_compare 输出目录(整目录每次运行重建)\n');
}

async function main() {
  const startedAt = new Date().toISOString();
  // ---- 两侧提交
  const aRef = arg('a', '');
  const aCands = aRef ? [aRef] : ['origin/master', 'master'];
  let A = null;
  for (const r of aCands) {
    const sha = resolveCommit(git, r);
    if (sha) {
      A = { label: 'A', ref: r, sha };
      break;
    }
  }
  const bRef = arg('b', 'HEAD');
  const bSha = resolveCommit(git, bRef);
  if (!A || !bSha) {
    console.error(!A ? `A 侧解析不到提交(试过 ${aCands.join(' / ')})` : `B 侧 ${bRef} 解析不到提交`);
    process.exit(2);
  }
  const B = { label: 'B', ref: bRef, sha: bSha };
  log(`A = ${A.ref} @ ${A.sha.slice(0, 10)}\nB = ${B.ref} @ ${B.sha.slice(0, 10)}`);
  const dirt = mainTreeDirt(git);
  if (dirt.tracked.length) {
    log(`\n⚠⚠ 主工作区有 ${dirt.tracked.length} 处未提交的已跟踪改动 —— 它们【不在】B 里(B 是提交 ${B.sha.slice(0, 10)})。`
      + `\n   想对照这些改动,先提交再跑。前几处:${dirt.tracked.slice(0, 5).map((l) => l.trim()).join(' | ')}\n`);
  }
  if (dirt.untracked.length) log(`⚠ 主工作区还有 ${dirt.untracked.length} 个未跟踪文件 / 目录,同样不在 B 里。`);

  // ---- 两棵树 + 各自依赖 + 素材
  const npmExtra = arg('npm-registry', '') ? [`--registry=${arg('npm-registry', '')}`, '--replace-registry-host=always'] : [];
  const assetsSrc = path.resolve(arg('assets', path.join(repoRoot, 'public', 'resources', 'runtime')));
  const assets = { src: assetsSrc, linked: false };
  for (const side of [A, B]) {
    const t = ensureWorktree(git, repoRoot, side.label, side.sha, log);
    side.dir = t.dir;
    side.reused = t.reused;
    side.resetDirty = t.resetDirty;
    if (has('no-install')) {
      if (!fs.existsSync(path.join(side.dir, 'node_modules', 'vite', 'bin', 'vite.js'))) throw new Error(`${side.label}: --no-install 但树里没有依赖`);
    } else {
      side.deps = ensureDeps(side.dir, npmExtra, log);
    }
    const l = linkAssets(side.dir, assetsSrc);
    assets.linked = l.linked;
    assets.note = l.note ?? l.reason ?? null;
  }
  if (!assets.linked) {
    log(`\n${'!'.repeat(78)}\n!! 素材目录不存在:${assetsSrc}\n!! 场景将在【缺原画、缺光照数据】的情况下渲染;缺素材类报错两边一样,单列不计。\n!! 在有素材的机器上跑,或用 --assets <dir> 指到 DVC 拉下来的 runtime 目录。\n${'!'.repeat(78)}\n`);
  }

  // ---- 场景表
  const kinds = new Set(list('only') ?? KINDS);
  for (const k of kinds) if (!KINDS.includes(k)) throw new Error(`--only 里有未知种类 ${k}(可选:${KINDS.join(',')})`);
  const built = buildScenarios({
    treeDirs: [A.dir, B.dir],
    kinds,
    scenes: list('scenes'),
    npcsPerScene: Number(arg('npcs-per-scene', '2')),
    minigames: arg('minigames', 'first'),
    cutscenes: list('cutscenes'),
    warps: list('warps'),
    resizeScenes: list('resize-scenes'),
    dprScenes: list('dpr-scenes'),
    viewport: opts.viewport,
  });
  if (built.unknownScenes.length) log(`⚠ 两棵树里都没有这些场景:${built.unknownScenes.join(', ')}`);
  const scenarios = has('perf-only') ? [] : built.scenarios;
  log(`场景表:${scenarios.length} 个(${[...kinds].map((k) => `${k} ${scenarios.filter((s) => s.kind === k).length}`).join(' · ')});每个 ${opts.repeats * 2} 轮`);
  if (!scenarios.length && !has('perf') && !has('perf-only')) throw new Error('过滤后一个场景都没有');

  prepareOut(outDir);
  const rawRoot = path.join(outDir, 'raw');
  const { chromium } = loadPlaywright(repoRoot);

  // ---- dev 服
  const servers = [];
  const cleanup = () => {
    for (const s of servers) killTree(s.child);
  };
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });
  // 缺省用 5173 = 仓库规范的 dev 源:游戏的入口卫兵就不会因「不是规范源」告警,与平常开发时一致。
  // 浏览器永远不会真去连本机 5173(解析规则改道了),人手里开着的 dev 服不受影响;上下文是全新的,也碰不到人手里的存储。
  const originPort = Number(arg('origin-port', '5173'));
  const taken = new Set([originPort]);
  const results = [];
  let perf = null;
  let browserDesc = '';
  try {
    for (const side of [A, B]) {
      wipeIsolatedSaves(side.dir);
      const port = await pickPort(Number(arg('port', '5211')), taken);
      const s = await startVite(side.dir, port, log);
      servers.push(s);
      // 页面看到的源两边相同(http://127.0.0.1:<origin-port>),由该侧浏览器的解析规则把连接改道到本侧 dev 服的真端口。
      // 否则报错文案、dev 报错浮层里的 URL 端口两边不同,本身就是像素 / 报错差异。
      Object.assign(side, {
        url: `http://127.0.0.1:${originPort}/`,
        realUrl: s.url,
        port,
        browserArgs: [`--host-resolver-rules=MAP 127.0.0.1:${originPort} 127.0.0.1:${port}`],
      });
      log(`dev 服 ${side.label}:${s.url}(cwd ${path.relative(repoRoot, side.dir)};页面源 ${side.url})`);
    }
    {
      const b = await launchBrowser(chromium, opts);
      browserDesc = `${b.browserType().name()} ${b.version()} · ${opts.headless ? '无头' : '有头'}${opts.swiftshader ? ' · SwiftShader' : ''}${opts.browserPath ? ` · ${opts.browserPath}` : opts.channel ? ` · channel ${opts.channel}` : ''}`;
      await b.close();
    }
    log(`浏览器:${browserDesc}`);
    for (const side of [A, B]) await warmUp(chromium, opts, side, log);

    // ---- 逐场景:A1 B1 A2 B2
    // 复用浏览器也按侧分开,各带本侧的解析改道规则(不带就会真去连本机 5173)
    const shared = has('reuse-browser')
      ? { A: await launchBrowser(chromium, opts, A.browserArgs), B: await launchBrowser(chromium, opts, B.browserArgs) }
      : null;
    const order = [];
    for (let r = 1; r <= opts.repeats; r++) order.push([A, r], [B, r]);
    for (const [si, sc] of scenarios.entries()) {
      const t0 = Date.now();
      const runs = { A: [], B: [] };
      for (const [side, r] of order) {
        wipeIsolatedSaves(side.dir);
        const rawDir = path.join(rawRoot, sc.id, `${side.label}${r}`);
        let res = await runScenario({ chromium, opts, side, scenario: sc, rawDir, sharedBrowser: shared?.[side.label] ?? null });
        if (res.reloaded) {
          log(`  ${side.label}${r} 中途整页重载,重跑一次`);
          fs.rmSync(rawDir, { recursive: true, force: true });
          res = await runScenario({ chromium, opts, side, scenario: sc, rawDir, sharedBrowser: shared?.[side.label] ?? null });
        }
        side.fsViolations = [...new Set([...(side.fsViolations ?? []), ...res.fsViolations])];
        runs[side.label].push(res);
        if (res.fatal) log(`  ${side.label}${r}:${res.fatal}`);
      }
      const row = compareScenario({ scenario: sc, runs, imgDir: path.join(outDir, 'img', sc.id), outDir, opts });
      results.push(row);
      if (!has('keep-raw')) fs.rmSync(path.join(rawRoot, sc.id), { recursive: true, force: true });
      const worst = (k) => row.checkpoints.reduce((m, c) => (c[k].ab !== null && c[k].ab > m ? c[k].ab : m), 0);
      const noise = (k) => row.checkpoints.reduce((m, c) => Math.max(m, c[k].noisePct), 0);
      log(`[${si + 1}/${scenarios.length}] ${row.inconclusive ? '?' : row.diverged ? '✗' : '✓'} ${sc.id}  整页 A/B ${worst('px').toFixed(3)}% 噪声 ${noise('px').toFixed(3)}%`
        + ` · 画布 A/B ${worst('pxCanvas').toFixed(3)}% 噪声 ${noise('pxCanvas').toFixed(3)}%`
        + `${row.flags.length ? `  ${row.flags.join(' · ')}` : ''}${row.inconclusive ? `  ${row.inconclusive}` : ''}  (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
      writeOutputs();
    }
    if (shared) for (const b of Object.values(shared)) await b.close().catch(() => {});

    // ---- 性能(可选)
    if (has('perf') || has('perf-only')) {
      const perfScenes = list('perf-scenes') ?? (list('scenes') ?? ['dev_room', 'teahouse', '河边']);
      log(`性能:${perfScenes.join(', ')}(每场景 ${opts.perfSeconds} s,真实时间)`);
      perf = [];
      for (let r = 1; r <= opts.repeats; r++) {
        for (const side of [A, B]) perf.push(await runPerf({ chromium, opts, side, scenes: perfScenes, log }));
      }
    }
  } finally {
    cleanup();
  }
  return writeOutputs(true);

  function writeOutputs(final = false) {
    const isolation = {};
    for (const side of [A, B]) {
      isolation[side.label] = {
        dir: path.relative(repoRoot, side.dir),
        trackedChanges: final ? trackedChanges(side.dir) : [],
        untracked: final ? untrackedFiles(side.dir).slice(0, 20) : [],
        resetBeforeRun: side.resetDirty ?? [],
        viteDeps: final ? checkViteDeps(side.dir) : { checked: false, problems: [] },
        fsViolations: side.fsViolations ?? [],
        nodeModulesIsLink: (() => {
          try {
            return fs.lstatSync(path.join(side.dir, 'node_modules')).isSymbolicLink();
          } catch {
            return false;
          }
        })(),
        lockSha256: side.deps?.lockSha256 ?? null,
      };
    }
    const unsupported = unsupportedOf(results);
    const noiseLines = noiseSummary(results, opts);
    const isoBad = ['A', 'B'].some((k) => isolation[k].trackedChanges.length || isolation[k].viteDeps.problems.length || isolation[k].fsViolations.length || isolation[k].nodeModulesIsLink);
    const summary = {
      meta: {
        A: { ref: A.ref, sha: A.sha, dir: path.relative(repoRoot, A.dir) },
        B: { ref: B.ref, sha: B.sha, dir: path.relative(repoRoot, B.dir) },
        startedAt,
        finishedAt: final ? new Date().toISOString() : '(进行中)',
        opts: { ...opts, browserPath: opts.browserPath || null },
        browser: browserDesc,
        assets,
        mainDirty: dirt,
        isolation,
        unsupported,
        platform: `${process.platform} ${process.arch} node ${process.version}`,
      },
      noise: { lines: noiseLines },
      verdict: {
        scenarios: results.length,
        diverged: results.filter((r) => r.diverged).map((r) => r.id),
        inconclusive: results.filter((r) => r.inconclusive).map((r) => r.id),
        isolationProblems: isoBad,
      },
      perf,
      scenarios: results,
    };
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 1));
    fs.writeFileSync(path.join(outDir, 'report.html'), renderReport(summary));
    if (final) {
      log(`\n${noiseLines.join('\n')}`);
      for (const k of ['A', 'B']) {
        const iso = isolation[k];
        log(`独立性 ${k}:已跟踪改动 ${iso.trackedChanges.length ? iso.trackedChanges.join(' | ') : '无'} · 预构建依赖 ${iso.viteDeps.checked ? (iso.viteDeps.problems.length ? iso.viteDeps.problems.join(' | ') : `${iso.viteDeps.entries} 项全在树内`) : '未生成'} · /@fs 越界 ${iso.fsViolations.length || '无'}`);
      }
      if (unsupported.length) log(`unsupported:${unsupported.join(';')}`);
      if (!assets.linked) log('⚠ 本次没有素材:画面对照只反映缺素材路径。');
      if (dirt.tracked.length) log(`⚠ 主工作区未提交改动 ${dirt.tracked.length} 处不在 B 里。`);
      log(`\n${summary.verdict.diverged.length} / ${results.length} 个场景 B 相对 A 超出噪声底或有新报错${summary.verdict.diverged.length ? `:${summary.verdict.diverged.join(', ')}` : ''}`);
      if (summary.verdict.inconclusive.length) log(`⚠ ${summary.verdict.inconclusive.length} 个场景无法对照(A 没起来):${summary.verdict.inconclusive.join(', ')}`);
      if (opts.freezeAt !== 'boot' && results.some((r) => r.flags.includes('状态分歧'))) {
        log(`⚠ 有「状态分歧」而冻结时机是 ${opts.freezeAt}:装载快慢不同也会留下不同状态,先用 --freeze boot 复核`);
      }
      log(`报告:${path.join(outDir, 'report.html')}`);
    }
    return summary;
  }
}

function unsupportedOf(results) {
  return [...new Set(results.flatMap((r) => [...r.unsupported.A.map((u) => `A:${u}`), ...r.unsupported.B.map((u) => `B:${u}`)]))];
}

/** 噪声底汇总(整页 / 画布层,按种类) */
function noiseSummary(results, opts) {
  const cps = results.flatMap((r) => r.checkpoints);
  const maxOf = (f) => cps.reduce((m, c) => Math.max(m, f(c) ?? 0), 0);
  return [
    `检查点 ${cps.length} 个;A/A 像素差最大 ${maxOf((c) => c.px.aa?.badPct).toFixed(3)}%(变化像素最大 ${maxOf((c) => c.px.aa?.changedPct).toFixed(3)}%)`
      + `;B/B 最大 ${maxOf((c) => c.px.bb?.badPct).toFixed(3)}%(变化 ${maxOf((c) => c.px.bb?.changedPct).toFixed(3)}%)`,
    opts.repeats > 1
      ? `A/A 与 B/B 都逐像素相同的检查点:${cps.filter((c) => c.px.aa && c.px.aa.changedPct === 0 && c.px.bb && c.px.bb.changedPct === 0).length} / ${cps.length}`
        + `(只看画布层:${cps.filter((c) => c.pxCanvas.aa && c.pxCanvas.aa.changedPct === 0 && c.pxCanvas.bb && c.pxCanvas.bb.changedPct === 0).length} / ${cps.length})`
      : '--repeats 1:没有量噪声底(噪声记 0)',
    `画布层:A/A 最大 ${maxOf((c) => c.pxCanvas.aa?.badPct).toFixed(3)}% · B/B 最大 ${maxOf((c) => c.pxCanvas.bb?.badPct).toFixed(3)}% · A/B 最大 ${maxOf((c) => c.pxCanvas.ab).toFixed(3)}%`,
    `状态探针里抖动(A/A 或 B/B 不同)的路径数最大 ${maxOf((c) => c.state.noisyPaths)}`,
    ...KINDS.filter((k) => results.some((r) => r.kind === k)).map((k) => {
      const kc = results.filter((r) => r.kind === k).flatMap((r) => r.checkpoints);
      const mx = (f) => kc.reduce((m, c) => Math.max(m, f(c) ?? 0), 0);
      return `  ${k}:整页 A/A ≤ ${mx((c) => c.px.aa?.badPct).toFixed(3)}% · B/B ≤ ${mx((c) => c.px.bb?.badPct).toFixed(3)}% · A/B ≤ ${mx((c) => c.px.ab).toFixed(3)}%`
        + ` | 画布层 A/A ≤ ${mx((c) => c.pxCanvas.aa?.badPct).toFixed(3)}% · B/B ≤ ${mx((c) => c.pxCanvas.bb?.badPct).toFixed(3)}% · A/B ≤ ${mx((c) => c.pxCanvas.ab).toFixed(3)}%`;
    }),
  ];
}

/**
 * --recompare:不重跑游戏,用上一次 --keep-raw 留下的截图与运行记录(raw/<场景>/<A1…>/run.json)按当前命令行的
 * 判定参数(--threshold / --noise-factor / --margin / --ignore-row-shift / --embed-images)重新比、重出报告。
 */
function recompareMain() {
  const prev = JSON.parse(fs.readFileSync(path.join(outDir, 'summary.json'), 'utf8'));
  const rawRoot = path.join(outDir, 'raw');
  if (!fs.existsSync(rawRoot)) throw new Error(`${rawRoot} 不存在:上一次要带 --keep-raw 跑`);
  fs.rmSync(path.join(outDir, 'img'), { recursive: true, force: true });
  const judge = { ...prev.meta.opts, threshold: opts.threshold, noiseFactor: opts.noiseFactor, margin: opts.margin, ignoreRowShift: opts.ignoreRowShift, embed: opts.embed };
  const results = [];
  for (const id of fs.readdirSync(rawRoot).sort()) {
    const runs = { A: [], B: [] };
    let def = null;
    for (const side of ['A', 'B']) {
      for (let r = 1; r <= 2; r++) {
        const f = path.join(rawRoot, id, `${side}${r}`, 'run.json');
        if (!fs.existsSync(f)) continue;
        const rec = JSON.parse(fs.readFileSync(f, 'utf8'));
        def ??= rec.scenarioDef;
        runs[side].push(rec);
      }
    }
    if (!def) continue;
    results.push(compareScenario({ scenario: def, runs, imgDir: path.join(outDir, 'img', id), outDir, opts: judge }));
  }
  const order = new Map(prev.scenarios.map((s, i) => [s.id, i]));
  results.sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9));
  const summary = {
    ...prev,
    meta: { ...prev.meta, opts: judge, unsupported: unsupportedOf(results), recomparedAt: new Date().toISOString() },
    noise: { lines: noiseSummary(results, judge) },
    verdict: {
      ...prev.verdict,
      scenarios: results.length,
      diverged: results.filter((r) => r.diverged).map((r) => r.id),
      inconclusive: results.filter((r) => r.inconclusive).map((r) => r.id),
    },
    scenarios: results,
  };
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 1));
  fs.writeFileSync(path.join(outDir, 'report.html'), renderReport(summary));
  log(summary.noise.lines.join('\n'));
  log(`\n重判:${summary.verdict.diverged.length} / ${results.length} 个场景超出噪声底或有新报错${summary.verdict.diverged.length ? `:${summary.verdict.diverged.join(', ')}` : ''}`);
  if (summary.verdict.inconclusive.length) log(`⚠ ${summary.verdict.inconclusive.length} 个场景无法对照(A 没起来):${summary.verdict.inconclusive.join(', ')}`);
  log(`报告:${path.join(outDir, 'report.html')}`);
  return summary;
}

(has('recompare') ? Promise.resolve().then(recompareMain) : main()).then(
  (summary) => process.exit(summary.verdict.diverged.length || summary.verdict.inconclusive?.length || summary.verdict.isolationProblems ? 1 : 0),
  (e) => {
    console.error(`\n工具失败:${e?.stack ?? e}`);
    process.exit(2);
  },
);
