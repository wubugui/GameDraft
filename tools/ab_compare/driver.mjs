/**
 * 从外面驱动一局真游戏:起浏览器、装确定性控制、冷启动、锁步推进、检查点取证。
 *
 * 只碰 master 上就有的入口:`window.__game`(DEV 实例;私有方法 applyRuntimeCommand 在 JS 里照样可调)与
 * `window.__gameDevAPI`(isReady / stepFixedTicks / startMinigame / playCutscene / completeDialogueText …),
 * 外加外部输入(Playwright 真键盘 / 真鼠标:key / keyDown / keyUp / click / wheel 步骤)。
 * 不注入任何游戏代码;页面里多出来的只有:
 *   - 浏览器环境控制(两边一样):Playwright 假时钟、Math.random 换成定种子的 mulberry32(另挂 __abReseed 供同步点重播种);
 *   - 驱动自己的记账(window.__abOps:发出去的命令 / API 调用各自兑现没有)。
 *
 * 时间模型(两边完全一致):
 *   1. 装载期:假时钟从固定纪元起**随墙钟流动**,游戏照常装载;
 *   2. 就绪(__gameDevAPI.isReady() 且 sceneManager 不在切换且 currentSceneData.id === 目标)的**同一个任务里**
 *      发 debugSetFixedTickMode(true) 冻住逻辑(缺省 --freeze ready;--freeze settled 则按原顺序先墙钟沉淀再冻;
 *      --freeze boot 则游戏一挂出 __game 就冻,装载期一帧真实时间的逻辑都不跑——见 EARLY_FREEZE_SCRIPT);
 *   3. 墙钟沉淀若干毫秒(只让在途 I/O 落地),再 clock.pauseAt(纪元 + 固定偏移) —— 两边停在同一个绝对时刻,
 *      performance.now() 也相同;随后再发一次 debugSetFixedTickMode(true)(把动画时钟在同一刻归零)并重播种;
 *   4. 之后每推进 k 帧 = 假时钟前进 round(k×1000/60) ms(兑现 setTimeout / rAF 驱动的淡入淡出、过场补间)
 *      + __gameDevAPI.stepFixedTicks(k, 1000/60)(逻辑 tick 并显式出一帧)。两者都停着时,墙钟流逝不改变游戏状态,
 *      只让网络 / 解码这类真异步落地;每次推进后若有网络活动就等它静下来(quiesce)再继续。
 *
 * --freeze pump(泵式装载)把 1–3 换成完全由 node 掌控的装载:假时钟从纪元起就**停着**(只记一条 pauseAt(纪元),
 * 再用 pumpClockSettleScript 在文档一开始就把它真正停住,performance.now() 从 0 起),逻辑同 boot 一挂出 __game 就冻;之后循环 { 等真异步落地(见 pumpIdle)→ 同步读状态 →
 * 就绪就停 → 假时钟前进一步:下一个非 rAF 定时器落在本帧内就只走到它,否则走到帧末 + 有 stepFixedTicks 了就恰好一个逻辑 tick }。装载期一帧都不按墙钟走,帧数只取决于
 * 游戏在装载里等了多少个定时器 / rAF;两边帧数相同 ⇔ 就绪时假时钟的绝对时刻相同(不再 pauseAt 跳秒)。见 pumpBoot。
 *
 * 同源:两边页面都开在 http://127.0.0.1:<origin-port>/,各侧浏览器用 `--host-resolver-rules=MAP …` 把这个地址改道到
 * 本侧 dev 服的真端口(见 run.mjs)。否则报错文案、dev 报错浮层里的 URL 端口两边不同,本身就成了像素 / 报错差异。
 * 除这一条改道规则外,两边浏览器参数完全相同。
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { bootQuery } from './scenarios.mjs';

const isWin = process.platform === 'win32';
export const FRAME_MS = 1000 / 60;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const msgOf = (e) => String(e?.message ?? e).split('\n')[0].slice(0, 300);

export function loadPlaywright(repoRoot) {
  const bases = [];
  if (process.env.PLAYWRIGHT_CORE) bases.push(path.join(process.env.PLAYWRIGHT_CORE, 'package.json'));
  bases.push(path.join(repoRoot, 'package.json'));
  for (const b of bases) {
    try {
      return createRequire(b)('playwright-core');
    } catch {
      // 试下一个
    }
  }
  console.error('找不到 playwright-core。仓库不装它:\n'
    + '  npm i --prefix <某个目录> playwright-core\n'
    + '  然后 PLAYWRIGHT_CORE=<某个目录>/node_modules/playwright-core node tools/ab_compare/run.mjs …');
  process.exit(2);
}

/** 两边完全相同的浏览器启动参数(extra 里只放本侧的解析改道规则,以及性能轮的 --expose-gc) */
export function browserArgs(opts, extra = []) {
  const { width, height } = opts.viewport;
  return [
    '--enable-unsafe-webgpu',
    '--autoplay-policy=no-user-gesture-required',
    '--force-color-profile=srgb',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--enable-precise-memory-info',
    `--window-size=${Math.max(width, 960) + 40},${Math.max(height, 540) + 160}`,
    // --enable-unsafe-swiftshader:master 的 WebGL 在 SwiftShader 上靠「自动回落软件 WebGL」,新版 Chrome 要显式允许
    ...(opts.swiftshader ? ['--enable-features=Vulkan', '--use-vulkan=swiftshader', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : []),
    ...extra,
  ];
}

export async function launchBrowser(chromium, opts, extra = []) {
  const base = { headless: !!opts.headless, args: browserArgs(opts, extra) };
  if (opts.browserPath) return chromium.launch({ ...base, executablePath: opts.browserPath });
  const channels = opts.channel ? [opts.channel] : isWin ? ['chrome', 'msedge'] : ['chrome', null];
  let last;
  for (const ch of channels) {
    try {
      return await chromium.launch(ch ? { ...base, channel: ch } : base);
    } catch (e) {
      last = e;
    }
  }
  throw new Error(`起不来浏览器(试过 ${channels.map((c) => c ?? 'playwright 自带').join(' / ')}):${msgOf(last)};用 --browser <可执行文件> 指定`);
}

/** 浏览器环境控制:Math.random → mulberry32(固定种子);__abReseed(seed) 供同步点重播种。不碰游戏代码。 */
export function seedInitScript(seed) {
  return `(() => {
  let a = ${seed | 0};
  const random = function random() {
    let t = (a += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  Object.defineProperty(Math, 'random', { value: random, writable: true, configurable: true });
  Object.defineProperty(globalThis, '__abReseed', { value: (v) => { a = v | 0; }, configurable: true });
})();`;
}

/**
 * --freeze boot 用:游戏一挂出 window.__game 就经它自己的命令入口开固定帧模式,装载期一帧真实时间的逻辑都不跑。
 * 用的是加这段脚本时的**原生** setTimeout(本脚本排在假时钟脚本之前),轮询不受假时钟影响。
 * 只调游戏已有的 applyRuntimeCommand;启动早期它后半截(快照)可能因系统未就绪报错,但开关在第一句就已置上。
 */
export const EARLY_FREEZE_SCRIPT = `(() => {
  const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
  const tryFreeze = () => {
    const g = globalThis.__game;
    if (g && typeof g.applyRuntimeCommand === 'function') {
      try {
        Promise.resolve(g.applyRuntimeCommand({ id: 'ab-freeze-early', type: 'debugSetFixedTickMode', enabled: true })).catch(() => {});
      } catch (e) { /* 开关已置上,后半截失败不要紧 */ }
      globalThis.__abFrozeEarly = true;
      return;
    }
    nativeSetTimeout(tryFreeze, 1);
  };
  nativeSetTimeout(tryFreeze, 1);
})();`;

/**
 * --freeze pump 用,必须排在 Playwright 假时钟的两段 init script(时钟源 + `log('pauseAt')`)**之后**:当场把假时钟真正停住。
 *
 * Playwright 的 `inject()` 装完假时钟会先 `controller.resume()`(随墙钟走),`pauseAt` 那条日志要等页面第一次碰时钟 API
 * (Date.now / performance.now / setTimeout …)才回放;回放只把 `_realTime` 置空,**不**撤掉 resume 时排下的那个墙钟定时器
 * (最长 100 ms)。于是:页面前 100 ms 没碰时钟(模块还在网络上)→ 那个定时器先到,`performance.now()` 被墙钟推走约 100 ms
 * 才停;就算停住了,它之后还会在墙钟里触发一次「跑到期定时器」。两件都随机器快慢变——实测整条装载时间线偶发整体晚 100 ms
 * (6 帧),或帧与帧之间假时刻被推走 3 ms。
 * 这里在文档一开始就调页内 `controller.pauseAt(纪元)`:回放日志(停在纪元、ticks = 0),`_innerPause` 顺手撤掉那个墙钟定时器。
 * 只碰 Playwright 注入的假时钟,不碰游戏代码。
 */
export const pumpClockSettleScript = (epoch) => `(() => {
  const c = globalThis.__pwClock && globalThis.__pwClock.controller;
  if (c && typeof c.pauseAt === 'function') {
    try { Promise.resolve(c.pauseAt(${Number(epoch)})).catch(() => {}); } catch (e) { /* 时钟没装上:泵会在读状态时报 */ }
  }
})();`;

// ---------------------------------------------------------------- 报错归类

const ASSET_URL_RE = /\/resources\/|\.(png|jpe?g|webp|gif|avif|ktx2|basis|ogg|mp3|wav|m4a|aac|flac|webm|mp4|glb|bin|atlas|ttf|otf|woff2?)(\?|#|$)/i;
/** 缺素材时两边一样会出的报错(图 / 音频 404、解码失败、自动播放策略):单独归一类,不参与判定 */
const ASSET_MSG_RE = /could not be decoded|加载失败|not valid JSON|status of 40[34]|Decoding audio data failed|Unable to decode audio|EncodingError|AudioContext was not allowed|play\(\) request|no supported sources?|\/resources\/runtime\/|素材缺失|找不到素材|Failed to load resource/i;

/** 让同一条报错在 A、B 两个 dev 服上写法一致:去端口、去 vite 版本参数、去行列号、去耗时数字 */
export function normalizeMsg(s) {
  return String(s)
    .replace(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+/g, '<origin>')
    .replace(/([?&])(v|t|import|ts|url|raw|worker|inline)=[^&\s)'"]*/g, '$1$2')
    .replace(/(\.js|\.ts|\.mjs|\.tsx)(\?[^\s)'"]*)?:\d+(:\d+)?/g, '$1:L')
    .replace(/\b(chunk|dist)-[A-Za-z0-9_-]{6,}\.js/g, '$1-<hash>.js')
    .replace(/\b\d+(?:\.\d+)?\s?(ms|s|秒|毫秒|px|%|MB|KB|bytes)\b/g, '<n>$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

/** 盯一个页面:报错 / 告警 / 失败请求按检查点分段收;网络在途数(给 quiesce 用);`/@fs/` 越界请求(混源证据) */
class PageWatch {
  constructor(page, treeDir) {
    this.items = [];
    this.inflight = new Map();
    this.lastActivity = Date.now();
    this.seq = 0;
    this.quietSeq = -1;
    this.fsViolations = new Set();
    this.treeDir = path.resolve(treeDir);
    /** 发出过的请求总数与最近 20 个 URL(--freeze pump 的装载诊断用) */
    this.reqCount = 0;
    this.lastUrls = [];
    page.on('console', (m) => {
      const t = m.type();
      if (t !== 'error' && t !== 'warning') return;
      const loc = m.location()?.url ?? '';
      const text = m.text();
      // 「Failed to load resource」正文里没有 URL,拿 location 补上,才分得清是素材还是代码
      this.push(t === 'error' ? 'error' : 'warning', /Failed to load resource/.test(text) && loc ? `${text} ← ${loc}` : text, loc);
    });
    page.on('pageerror', (e) => this.push('pageerror', String(e?.stack ?? e)));
    page.on('request', (r) => {
      this.inflight.set(r, Date.now());
      this.touch();
      this.checkFs(r.url());
      this.reqCount++;
      this.lastUrls.push(r.url());
      if (this.lastUrls.length > 20) this.lastUrls.shift();
    });
    page.on('requestfinished', (r) => {
      this.inflight.delete(r);
      this.touch();
    });
    page.on('requestfailed', (r) => {
      this.inflight.delete(r);
      this.touch();
      const why = r.failure()?.errorText ?? '';
      this.push('requestfailed', `${why} ${r.url()}`, r.url(), /ERR_ABORTED/.test(why));
    });
    page.on('response', (r) => {
      if (r.status() >= 400) this.push('http', `HTTP ${r.status()} ${r.url()}`, r.url());
    });
  }

  touch() {
    this.lastActivity = Date.now();
    this.seq++;
  }

  checkFs(url) {
    // vite 用 /@fs/<绝对路径> 伺服根目录之外的文件:落到本树之外 = 模块从主工作区等别处解析来了
    const m = /\/@fs\/([^?#]+)/.exec(url);
    if (!m) return;
    let p = decodeURIComponent(m[1]); // Windows:C:/…;POSIX:home/…(前导 / 被 /@fs/ 吃掉了)
    if (!isWin) p = `/${p}`;
    const rel = path.relative(isWin ? this.treeDir.toLowerCase() : this.treeDir, isWin ? path.resolve(p).toLowerCase() : path.resolve(p));
    if (rel.startsWith('..') || path.isAbsolute(rel)) this.fsViolations.add(p);
  }

  push(type, text, url = '', forceAsset = false) {
    const full = String(text).slice(0, 2000);
    const first = full.split('\n')[0];
    const asset = forceAsset
      || (type === 'http' && ASSET_URL_RE.test(url))
      || (type === 'requestfailed' && ASSET_URL_RE.test(url))
      || ((type === 'error' || type === 'warning') && (ASSET_MSG_RE.test(first) || (url && ASSET_URL_RE.test(url) && /Failed to load resource/.test(first))));
    this.items.push({ type, text: full, norm: normalizeMsg(first), asset });
  }

  drain() {
    const out = this.items;
    this.items = [];
    return out;
  }

  activeCount(stuckMs) {
    const now = Date.now();
    let n = 0;
    for (const t of this.inflight.values()) if (now - t < stuckMs) n++;
    return n;
  }

  /** 等网络静下来:没有(不太老的)在途请求且最近 graceMs 内没有新活动。自上次静止后没有任何活动则立即返回。 */
  async quiesce({ graceMs = 150, maxMs = 20000, stuckMs = 8000 } = {}) {
    if (this.seq === this.quietSeq && this.activeCount(stuckMs) === 0) return 0;
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      if (this.activeCount(stuckMs) === 0 && Date.now() - this.lastActivity >= graceMs) break;
      await sleep(20);
    }
    this.quietSeq = this.seq;
    return Date.now() - t0;
  }
}

/** page.evaluate 本身没有超时:游戏卡死时整个驱动会跟着挂住,这里统一加 */
function evalT(page, fn, arg, ms, what = 'evaluate') {
  let timer;
  return Promise.race([
    page.evaluate(fn, arg),
    new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error(`${what} 超时 ${ms} ms(游戏可能卡死)`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------- 页内函数(序列化进页面执行)

/**
 * 等就绪;就绪的同一个任务里冻住逻辑(applyDevRuntimeCommand 在第一个 await 之前就同步置上 fixedTickMode)。
 *
 * 就绪 = __gameDevAPI.isReady() 且 当前场景数据 id === 目标(currentSceneId 在切换**开始**就变了,不能用)且
 *   (a) 切换已收尾(sceneManager.switching === false 且启动直达路由已落地 runtimeReady !== false),或
 *   (b) 场景已装上、但开场演出(过场 / 图对话)正攥着切换没放——叙事跳转的最后一跳、带 onEnter 演出的场景都这样,
 *       演出要点击才往下走,不认 (b) 就永远等不到 (a)。
 * 超时由 node 侧掌握(装载期假时钟虽随墙钟流动,实测比墙钟慢好几倍,页内拿 Date.now() 计时不可靠):
 * node 超时后置 window.__abStopWait,页内循环看到就退出。
 */
const READY_FN = async ({ expectScene, freeze }) => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__abStopWait = false;
  const state = () => {
    const g = window.__game;
    const api = window.__gameDevAPI;
    const sm = g?.sceneManager;
    return {
      hasGame: !!g,
      apiReady: !!(api && typeof api.isReady === 'function' && api.isReady()),
      runtimeReady: typeof g?.runtimeReady === 'boolean' ? g.runtimeReady : null,
      switching: sm ? !!sm.switching : null,
      sceneId: sm?.currentSceneData?.id ?? null,
      cutscene: !!g?.cutsceneManager?.isPlaying,
      dialogue: !!g?.graphDialogueManager?.isActive,
      gameState: g?.stateController?.currentState ?? null,
      fatal: document.getElementById('game-fatal-error')?.textContent?.slice(0, 300) ?? null,
    };
  };
  const ready = (s) => s.apiReady && s.sceneId === expectScene
    && ((s.switching === false && s.runtimeReady !== false) || (s.switching === true && (s.cutscene || s.dialogue)));
  let s = state();
  while (!ready(s)) {
    if (s.fatal) return { ok: false, reason: `启动失败:${s.fatal}`, state: s };
    if (window.__abStopWait) return { ok: false, reason: '就绪等待超时', state: s };
    await wait(4);
    s = state();
  }
  let froze = 'skipped';
  if (freeze) {
    const g = window.__game;
    if (typeof g.applyRuntimeCommand !== 'function') {
      froze = 'unsupported';
    } else {
      const p = g.applyRuntimeCommand({ id: 'ab-freeze-boot', type: 'debugSetFixedTickMode', enabled: true });
      froze = 'yes';
      const r = await Promise.race([p, wait(8000).then(() => null)]);
      if (r && r.ok === false) froze = `failed: ${r.message}`;
    }
  }
  return { ok: true, state: s, froze, heldByPerformance: s.switching === true };
};

const SYNC_FN = async ({ seed }) => {
  const g = window.__game;
  let fixed = 'unsupported';
  if (typeof g?.applyRuntimeCommand === 'function') {
    const r = await g.applyRuntimeCommand({ id: 'ab-freeze-sync', type: 'debugSetFixedTickMode', enabled: true });
    fixed = r?.ok ? 'yes' : `failed: ${r?.message}`;
  }
  const reseeded = typeof globalThis.__abReseed === 'function';
  if (reseeded) globalThis.__abReseed(seed);
  return {
    fixed,
    reseeded,
    pageClock: typeof globalThis.__pwClock?.controller?.runFor === 'function',
    now: performance.now(),
    date: Date.now(),
    hasStep: typeof window.__gameDevAPI?.stepFixedTicks === 'function',
  };
};

const ADVANCE_FN = async ({ ms, k, dt, pageClock }) => {
  const errs = [];
  const m = (e) => String(e?.message ?? e).split('\n')[0].slice(0, 300);
  if (ms > 0 && pageClock) {
    try {
      await globalThis.__pwClock.controller.runFor(ms);
    } catch (e) {
      errs.push(`[假时钟回调抛错] ${m(e)}`);
    }
  }
  const api = window.__gameDevAPI;
  if (!api || typeof api.stepFixedTicks !== 'function') return { errs, unsupported: true };
  try {
    await api.stepFixedTicks(k, dt);
  } catch (e) {
    errs.push(`[stepFixedTicks 抛错] ${m(e)}`);
  }
  return { errs };
};

/** 发出去不等:命令 / API 可能要等假时钟或固定帧才兑现,兑现结果记在 window.__abOps[id] */
const DISPATCH_FN = ({ id, kind, name, args, cmd }) => {
  const ops = (window.__abOps ??= {});
  const rec = { state: 'pending', result: null };
  ops[id] = rec;
  const m = (e) => String(e?.message ?? e).split('\n')[0].slice(0, 300);
  const brief = (v) => {
    try {
      const s = JSON.stringify(v);
      return s === undefined ? null : s.slice(0, 300);
    } catch {
      return String(v).slice(0, 300);
    }
  };
  const track = (p, isCmd) => Promise.resolve(p).then(
    (v) => {
      if (isCmd && v && typeof v === 'object' && 'ok' in v) {
        rec.state = v.ok ? 'done' : /^unsupported runtime command/.test(String(v.message)) ? 'unsupported' : 'failed';
        rec.result = String(v.message ?? '').slice(0, 300);
      } else {
        rec.state = 'done';
        rec.result = brief(v);
      }
    },
    (e) => {
      rec.state = 'error';
      rec.result = m(e);
    },
  );
  try {
    if (kind === 'cmd') {
      const g = window.__game;
      if (!g || typeof g.applyRuntimeCommand !== 'function') {
        rec.state = 'unsupported';
        rec.result = 'window.__game.applyRuntimeCommand 不存在';
      } else {
        track(g.applyRuntimeCommand({ id: `ab-${id}`, ...cmd }), true);
      }
    } else {
      const api = window.__gameDevAPI;
      if (!api || typeof api[name] !== 'function') {
        rec.state = 'unsupported';
        rec.result = `window.__gameDevAPI.${name} 不存在`;
      } else {
        track(api[name](...(args ?? [])), false);
      }
    }
  } catch (e) {
    rec.state = 'error';
    rec.result = m(e);
  }
  return { ...rec };
};

const OPS_FN = () => JSON.parse(JSON.stringify(window.__abOps ?? {}));

/**
 * --freeze pump 用的状态读取:**同步**函数(假时钟停着,页内不能起任何定时器),只读现成字段、不调游戏逻辑。
 *
 * 返回就绪判据要的那几项(同 READY_FN)+ 两样东西:
 *   pending —— 此刻还在途、而且**不靠假时钟也会自己落地**的真异步(等它们是确定的,不会等死):
 *     renderer  渲染器还在 init(WebGPU 设备 / 动态 import);
 *     assets    AssetManager 各桶在途装载(fetch + 解码;不含 audio 桶:Howler 的 load 事件走 setTimeout(0),要等假时钟);
 *     howls     Howler 里还在 'loading' 的声音(XHR + decodeAudioData);
 *     gl        (master)GlProgramWarmup 后台并行编译中、COMPLETION_STATUS_KHR 还是 false 的程序(只读查询);
 *     pipelines (分支)渲染管线原生校验还 pending(luma linkStatus === 'pending');
 *     plSettling(分支)luma 已链接、但 RHI 的就绪链(第二次 getCompilationInfo、原生错误作用域出栈)还没落定的管线
 *               ——即 engine2d pipelinesReady 等的东西。实测这类回调要几十到几百毫秒墙钟才回来,短于 --pump-settle 的静止窗
 *               兜不住:不等它就推一帧的话,那一帧的 queue.submit 顺手把它冲回来,分支的揭幕闸就比 master(GL 同步编译)
 *               晚整整一帧(牛头凼:A 98 帧、B 99 帧,onEnter 的三把火晚一拍,像素差 0.014%);
 *     shaders   (分支)着色器模块编译信息还没回来(luma compilationStatus === 'pending');
 *     fonts     document.fonts 还在装;images  DOM 里还没解码完的 <img>。
 *   fp —— 进度指纹:上面这些的计数、各桶条目数 / 统计、管线就绪数、场景 / 切换 / 状态机、事件总线序号、假时钟的定时器数、
 *     DOM 节点数、画面盒尺寸……假时钟停着时它只会因真异步落地而变(真异步的后续排了新定时器也算);node 侧要它静止一段墙钟
 *     (--pump-settle)才推进下一步,兜住上面没点名的短尾巴(ResizeObserver 回调、第二次 getCompilationInfo、错误作用域出栈 …)。
 *   clock / curtain / loadStep / plWait —— 诊断用(阶段表、clockLeaks)。
 */
const PUMP_STATE_FN = () => {
  const t = (f, d = null) => {
    try {
      const v = f();
      return v === undefined ? d : v;
    } catch {
      return d;
    }
  };
  const g = window.__game;
  const api = window.__gameDevAPI;
  const sm = t(() => g?.sceneManager);
  const s = {
    hasGame: !!g,
    frozen: t(() => g?.fixedTickMode === true, false),
    hasStep: typeof api?.stepFixedTicks === 'function',
    apiReady: t(() => !!(api && typeof api.isReady === 'function' && api.isReady()), false),
    runtimeReady: typeof g?.runtimeReady === 'boolean' ? g.runtimeReady : null,
    switching: sm ? t(() => !!sm.switching, null) : null,
    sceneId: t(() => sm?.currentSceneData?.id ?? null),
    cutscene: t(() => !!g?.cutsceneManager?.isPlaying, false),
    dialogue: t(() => !!g?.graphDialogueManager?.isActive, false),
    gameState: t(() => g?.stateController?.currentState ?? null),
    fatal: t(() => document.getElementById('game-fatal-error')?.textContent?.slice(0, 300) ?? null),
    // 诊断(阶段表用):切场遮幕在不在、切场进度条上的装载步骤文案(DEV 才有)
    curtain: t(() => (sm.transitionOverlay ? (sm.animRafId ? 'fading' : 'on') : 'off'), null),
    loadStep: t(() => sm.transitionDebugLabel?.text?.split('\n')[0]?.slice(0, 40) ?? null),
  };
  const p = { renderer: 0, assets: 0, howls: 0, gl: 0, pipelines: 0, plSettling: 0, shaders: 0, fonts: 0, images: 0 };
  const fp = [];
  if (g) {
    p.renderer = t(() => (!g.tearDownComplete && g.renderer && typeof g.renderer.isInitialized === 'function' && !g.renderer.isInitialized() ? 1 : 0), 0);
    const buckets = t(() => g.assetManager?.buckets);
    if (buckets && typeof buckets === 'object') {
      for (const k of Object.keys(buckets).sort()) {
        const b = buckets[k];
        const inflight = t(() => b.inflight.size, 0);
        if (k !== 'audio') p.assets += inflight;
        fp.push(`${k}:${t(() => b.entries.size)}/${inflight}/${t(() => b.errors.size)}/${t(() => b.stats.loads)}/${t(() => b.stats.errors)}`);
      }
    }
    const w = t(() => g.glProgramWarmup);
    if (w && w.entries instanceof Map) {
      const st = {};
      for (const e of w.entries.values()) {
        st[e.state] = (st[e.state] ?? 0) + 1;
        if (e.state === 'compiling' && e.raw && w.gl && w.ext) {
          if (!t(() => w.gl.getProgramParameter(e.raw.prog, w.ext.COMPLETION_STATUS_KHR) === true, true)) p.gl++;
        }
      }
      fp.push(`gl:${JSON.stringify(st)}`);
    }
    const pl = t(() => g.renderer.app.renderer.pipelines);
    if (pl && pl.pipelines instanceof Map) {
      let ready = 0;
      let failed = 0;
      let nw = 0;
      for (const x of pl.pipelines.values()) {
        if (t(() => x.isReady, false)) ready++;
        else if (t(() => x.failed, false)) failed++;
        else {
          const ls = t(() => x.handle.linkStatus, '?');
          if (ls === 'pending') p.pipelines++;
          else p.plSettling++;
          // 诊断:还没就绪的管线各卡在哪(luma linkStatus)
          s.plWait = s.plWait ?? {};
          s.plWait[ls] = (s.plWait[ls] ?? 0) + 1;
          if (++nw <= 4) s.plWait[`#${String(t(() => x.label, '?')).slice(0, 50)}`] = ls;
        }
      }
      let shaders = 0;
      if (pl.shaders instanceof Map) {
        for (const sh of pl.shaders.values()) {
          shaders++;
          if (t(() => sh.module.compilationStatus) === 'pending') p.shaders++;
        }
      }
      fp.push(`pl:${pl.pipelines.size}/${ready}/${failed}/${shaders}`);
    }
    fp.push(`g:${s.switching}/${s.sceneId}/${t(() => sm.currentSceneId)}/${s.gameState}/${s.runtimeReady}/${s.hasStep}/${s.cutscene}/${s.dialogue}`
      + `/${t(() => !!g.mainTick)}/${t(() => g.eventBus.debugTraceSeq)}/${t(() => g.vfxSystem.pendingLoads.size)}/${t(() => !!g.vfxSystem.rebuilding)}`
      + `/${t(() => g.vfxSystem.instances.size)}/${s.frozen}`);
  }
  const H = window.Howler;
  if (H && Array.isArray(H._howls)) {
    const st = {};
    for (const h of H._howls) {
      const k = t(() => h._state, '?');
      st[k] = (st[k] ?? 0) + 1;
      if (k === 'loading') p.howls++;
    }
    fp.push(`howl:${JSON.stringify(st)}/${t(() => H.ctx.state)}`);
  }
  const fonts = t(() => document.fonts.status);
  if (fonts === 'loading') p.fonts = 1;
  fp.push(`fonts:${fonts}/${t(() => document.fonts.size)}`);
  for (const img of document.images) {
    if (img.getAttribute('src') && img.loading !== 'lazy' && !img.complete) p.images++;
  }
  // 假时钟自身(诊断):当前 ticks、是否在随墙钟走(_realTime)、定时器数。停着的钟在帧与帧之间绝不该动
  const clk = globalThis.__pwClock?.controller;
  s.clock = clk ? { t: t(() => clk._now.ticks), rt: !!clk._realTime, n: t(() => clk._timers.size) } : null;
  fp.push(`clk:${s.clock?.t}/${s.clock?.rt}/${s.clock?.n}`);
  const mount = document.getElementById('game-mount');
  fp.push(`dom:${document.getElementsByTagName('*').length}/${document.readyState}/${mount?.style.width}x${mount?.style.height}`);
  s.pending = p;
  s.fp = fp.join('|');
  return s;
};

/**
 * --freeze pump 的一步:假时钟前进到 min(下一个**非 rAF** 定时器, 本帧末 frameEnd)。
 *   - 下一个 setTimeout / setInterval / requestIdleCallback 落在本帧之内 ⇒ 只走到它(途中的 rAF 照常触发),**不**跑逻辑 tick,
 *     回 node 再等一次真异步落地——游戏里「await setTimeout(0)」这类让一下主线程的写法在真机上只花零点几毫秒,
 *     整帧量化会把它放大成整整一帧(实测 master 揭幕闸里 GlProgramWarmup 逐个交接之间的 wait(0) 让茶馆装载多出 1 帧);
 *   - 否则走到帧末(触发途中的定时器与 rAF),再(已挂出 __gameDevAPI.stepFixedTicks 时)恰好一个固定逻辑 tick。与 ADVANCE_FN 同一顺序。
 * 定时器表只读 Playwright 注入的假时钟(__pwClock.controller 的 _now / _timers,浏览器环境控制,不是游戏代码);
 * 读不到(Playwright 改了内部)⇒ 退回整帧推进(ms)。
 */
const PUMP_STEP_FN = async ({ frameEnd, ms, dt }) => {
  const errs = [];
  const m = (e) => String(e?.message ?? e).split('\n')[0].slice(0, 300);
  const c = globalThis.__pwClock?.controller;
  if (typeof c?.runFor !== 'function') throw new Error('页内没有 Playwright 假时钟(__pwClock),泵不动');
  const now = c._now?.ticks;
  let run = ms;
  let frame = true;
  let timerAt = null;
  let timer = null;
  if (typeof now === 'number' && c._timers instanceof Map) {
    let at = Infinity;
    for (const x of c._timers.values()) {
      if (x.type !== 'AnimationFrame' && x.callAt < at) {
        at = x.callAt;
        timer = x;
      }
    }
    if (at < frameEnd) {
      frame = false;
      timerAt = at;
      run = Math.max(0, at - now);
    } else {
      run = Math.max(0, frameEnd - now);
    }
  }
  try {
    await c.runFor(run);
  } catch (e) {
    errs.push(`[假时钟回调抛错] ${m(e)}`);
  }
  const api = window.__gameDevAPI;
  let stepped = false;
  if (frame && api && typeof api.stepFixedTicks === 'function') {
    stepped = true;
    try {
      await api.stepFixedTicks(1, dt);
    } catch (e) {
      errs.push(`[stepFixedTicks 抛错] ${m(e)}`);
    }
  }
  // 定时器步的来历(诊断用):类型、延时、建它时的假时刻
  const info = timer && !frame ? `${timer.type[0]}${timer.delay}@${timer.createdAt}` : null;
  return { errs, stepped, frame, timerAt, before: now, after: c._now?.ticks, info, now: performance.now(), internals: typeof now === 'number' };
};

/**
 * 「只看画布」那一层截图用:把不含画布的 DOM 元素逐个设 visibility:hidden(不改布局 → 不触发 ResizeObserver,
 * 游戏逻辑无感),截完原样还回去。整页图 = 画布 + DOM 覆盖层;画布层图 = 只有渲染器画的东西。
 */
const HIDE_DOM_FN = () => {
  const saved = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (el.tagName === 'CANVAS' || el.querySelector('canvas')) continue;
    saved.push([el, el.style.visibility]);
    el.style.visibility = 'hidden';
  }
  window.__abHidden = saved;
  return saved.length;
};
const RESTORE_DOM_FN = () => {
  for (const [el, v] of window.__abHidden ?? []) el.style.visibility = v;
  window.__abHidden = null;
};

/**
 * 状态探针:只读两边都有的字段。主体来自 master 就有的 __gameDevAPI.getNarrativeDebugSnapshot()
 * (= 游戏自己的运行时调试快照),挑掉易变 / 冗余项(eventTrace、存档全量、时间戳、bootId…);
 * 另读几样直观字段(场景、玩家、相机、对话文本、过场、小游戏)方便看报告。
 * 数字截到 4 位小数,活对象只记 '<object>'(不钻进渲染器内部:A、B 渲染器实现不同,钻进去全是假差异)。
 */
const PROBE_FN = () => {
  const g = window.__game;
  const api = window.__gameDevAPI;
  const R = (v, d = 0) => {
    if (v === null || v === undefined) return null;
    const t = typeof v;
    if (t === 'number') return Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : String(v);
    if (t === 'string') return v.length > 300 ? `${v.slice(0, 300)}…` : v;
    if (t === 'boolean') return v;
    if (t === 'bigint') return String(v);
    if (t !== 'object') return undefined;
    if (d > 8) return '<depth>';
    if (Array.isArray(v)) return v.slice(0, 200).map((x) => R(x, d + 1) ?? null);
    if (v instanceof Map) return R(Object.fromEntries([...v.entries()].slice(0, 300)), d);
    if (v instanceof Set) return R([...v].slice(0, 300), d);
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return '<object>';
    const o = {};
    for (const k of Object.keys(v).sort().slice(0, 400)) {
      const x = R(v[k], d + 1);
      if (x !== undefined) o[k] = x;
    }
    return o;
  };
  const safe = (f) => {
    try {
      return R(f()) ?? null;
    } catch (e) {
      return { __error: String(e?.message ?? e).slice(0, 200) };
    }
  };
  if (!g) return { __error: 'window.__game 不存在' };
  let snap = null;
  try {
    snap = typeof api?.getNarrativeDebugSnapshot === 'function' ? api.getNarrativeDebugSnapshot() : null;
  } catch (e) {
    snap = { __error: String(e?.message ?? e).slice(0, 200) };
  }
  const KEYS = [
    'currentSceneId', 'gameState', 'previousGameState', 'flags', 'questState', 'scenarioState', 'narrativeState',
    'documentReveals', 'health', 'retry', 'healthThreats', 'fireProtection', 'activeZones', 'zoneInteractPrompt',
    'uiState', 'hudVisualState', 'renderState', 'entityVisualState', 'audioState', 'inFlight', 'dialogue',
    'dialogueView', 'minigameDebug', 'playerActs', 'planes', 'inventory', 'interactables', 'playerView',
    'runtimeRandomState', 'windGust', '__error',
  ];
  const snapshot = {};
  if (snap && typeof snap === 'object') for (const k of KEYS) if (k in snap) snapshot[k] = R(snap[k]) ?? null;
  return {
    sceneId: safe(() => g.sceneManager.currentSceneData?.id ?? null),
    switching: safe(() => g.sceneManager.switching),
    player: safe(() => ({ x: g.player.x, y: g.player.y, facing: g.player.facingDirection })),
    camera: safe(() => ({ x: g.camera.getX(), y: g.camera.getY(), zoom: g.camera.getZoom() })),
    playerDialogue: safe(() => g.graphDialogueManager.getPlayerDialogue()),
    cutscene: safe(() => ({ playing: g.cutsceneManager.isPlaying, playback: api?.getCutscenePlayback?.() ?? null })),
    snapshot,
  };
};

const MEASURE_FN = ({ ms }) => new Promise((resolve) => {
  const iv = [];
  let last = null;
  const t0 = performance.now();
  const f = (now) => {
    if (last !== null) iv.push(now - last);
    last = now;
    if (now - t0 < ms) {
      requestAnimationFrame(f);
      return;
    }
    iv.sort((a, b) => a - b);
    const mean = iv.reduce((s, x) => s + x, 0) / Math.max(1, iv.length);
    resolve({ frames: iv.length, meanMs: mean, p95Ms: iv[Math.floor(iv.length * 0.95)] ?? null, maxMs: iv[iv.length - 1] ?? null });
  };
  requestAnimationFrame(f);
});

const HEAP_FN = async () => {
  if (typeof globalThis.gc === 'function') {
    globalThis.gc();
    globalThis.gc();
  }
  await new Promise((r) => setTimeout(r, 300));
  const m = performance.memory;
  return m ? { usedMB: m.usedJSHeapSize / 1048576, totalMB: m.totalJSHeapSize / 1048576, gc: typeof globalThis.gc === 'function' } : null;
};

// ---------------------------------------------------------------- 一次运行

async function waitReady(page, expectScene, timeoutMs, freeze) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const left = Math.max(1000, deadline - Date.now());
    try {
      return await evalT(page, READY_FN, { expectScene, freeze }, left, '就绪等待');
    } catch (e) {
      last = e;
      // 整页重载(vite 依赖重新预构建)会毁掉执行上下文:等新文档起来接着等
      if (/Execution context was destroyed|navigat|Cannot find context/i.test(String(e))) {
        await sleep(500);
        continue;
      }
      if (!/就绪等待 超时/.test(String(e))) throw e;
    }
  }
  // 到点了:叫停页内循环,顺手读一下卡在哪
  const state = await evalT(page, () => {
    window.__abStopWait = true;
    const g = window.__game;
    const sm = g?.sceneManager;
    return {
      sceneId: sm?.currentSceneData?.id ?? null, switching: sm ? !!sm.switching : null,
      runtimeReady: typeof g?.runtimeReady === 'boolean' ? g.runtimeReady : null,
      gameState: g?.stateController?.currentState ?? null, cutscene: !!g?.cutsceneManager?.isPlaying,
    };
  }, null, 10000, '读启动状态').catch(() => null);
  return { ok: false, reason: `就绪等待超时(${timeoutMs} ms)${state ? `,卡在 ${JSON.stringify(state)}` : ''}${last && !/超时/.test(String(last)) ? `;${msgOf(last)}` : ''}`, state };
}

// ---------------------------------------------------------------- --freeze pump:泵式装载

/** 就绪判据,与 READY_FN 里的 ready() 逐字同义(那边是页内 async 轮询,这边是 node 拿同步读到的状态判) */
const pumpReady = (s, expectScene) => s.apiReady && s.sceneId === expectScene
  && ((s.switching === false && s.runtimeReady !== false) || (s.switching === true && (s.cutscene || s.dialogue)));

const pendingKeys = (p) => Object.keys(p ?? {}).filter((k) => p[k] > 0);
const isContextLoss = (e) => /Execution context was destroyed|navigat|Cannot find context|Target closed|frame was detached/i.test(String(e));

/**
 * 等「这一刻能自己落地的真异步都落地了」:网络静下来(quiesce)、PUMP_STATE_FN 的 pending 全为 0(或已判卡死)、
 * 且进度指纹 + 网络活动序号 + 报错条数连续 --pump-settle 毫秒墙钟没变。返回最后一次读到的状态。
 *
 * pending 某项超过 --pump-stall 毫秒墙钟既不落地、指纹也不动 ⇒ 判它其实在等假时钟(或永远不来),记一条 stall,
 * 把这一项当时的计数记成「卡住的底数」:本次装载之后只有**超过**底数的部分才继续挡(免得每帧都干等一个卡住的东西)。
 */
async function pumpIdle(page, watch, opts, rec) {
  const t0 = Date.now();
  let key = null;
  let changedAt = t0;
  let changes = -1;
  const seen = {};
  const req0 = rec.reqSeen ?? watch.reqCount; // 从上一次等待结束算起:推进那一步里发出的请求也算进来
  // AB_PUMP_TRACE=1:逐次记下这次等待里指纹哪几段、在第几毫秒变了(找「没点名、又长过静止窗」的真异步用)
  const trace = process.env.AB_PUMP_TRACE === '1' ? [] : null;
  let prevFp = rec.lastFp ?? null;
  const done = (s) => {
    if (trace && rec.trace.length < 2000) rec.trace.push({ f: rec.frames, st: rec.timerSteps, ms: Date.now() - t0, ev: trace });
    rec.lastFp = s.fp;
    const now = Date.now();
    rec.idleMs += now - t0;
    // 诊断:这一次等待里见过的在途项、新发的请求、指纹变了几次(只记有事发生的,两边帧数对不上时照它找)
    const net = watch.reqCount - req0;
    rec.reqSeen = watch.reqCount;
    if ((Object.keys(seen).length || net || changes > 0) && rec.idleLog.length < 400) {
      const urls = net ? watch.lastUrls.slice(-Math.min(net, 4)).map((u) => decodeURIComponent(u.replace(/^https?:\/\/[^/]+/, '').split('?')[0]).slice(-60)) : [];
      rec.idleLog.push(`${rec.frames}.${rec.timerSteps}: ${now - t0}ms${Object.keys(seen).length ? ` pend ${JSON.stringify(seen)}` : ''}${net ? ` net+${net} ${urls.join(' ')}` : ''}${changes > 0 ? ` fp×${changes}` : ''}`);
    }
    return s;
  };
  for (;;) {
    await watch.quiesce();
    const s = await evalT(page, PUMP_STATE_FN, null, 15000, '泵:读状态');
    const now = Date.now();
    const k = `${s.fp}#${watch.seq}#${watch.items.length}`;
    if (k !== key) {
      key = k;
      changedAt = now;
      changes++;
      if (trace && trace.length < 40) {
        const a = (prevFp ?? '').split('|');
        const b = s.fp.split('|');
        const segs = b.filter((x, i) => x !== a[i]).map((x) => x.slice(0, 90));
        trace.push(`+${now - t0} ${segs.join(' ; ')}${watch.activeCount(8000) ? ` net${watch.activeCount(8000)}` : ''}`);
      }
      prevFp = s.fp;
    }
    for (const x of pendingKeys(s.pending)) seen[x] = Math.max(seen[x] ?? 0, s.pending[x]);
    const blocking = pendingKeys(s.pending).filter((x) => s.pending[x] > (rec.stuck[x] ?? 0));
    const still = now - changedAt;
    if (!blocking.length && watch.activeCount(8000) === 0 && still >= opts.pumpSettle) return done(s);
    if (blocking.length && still >= opts.pumpStall) {
      rec.stalls.push({ frame: rec.frames, tick: rec.ticks, pending: Object.fromEntries(blocking.map((x) => [x, s.pending[x]])), waitedMs: now - t0 });
      for (const x of blocking) rec.stuck[x] = s.pending[x];
      return done(s);
    }
    await sleep(blocking.length ? 4 : Math.max(2, Math.min(8, opts.pumpSettle / 4)));
  }
}

/**
 * --freeze pump 的装载:假时钟从纪元起停着(runScenario 只记了一条 pauseAt(纪元)),逻辑一挂出 __game 就冻(EARLY_FREEZE_SCRIPT)。
 * 循环 {
 *   pumpIdle:等能自己落地的真异步落地(模块 / 动态 import / fetch 是网络 → quiesce;解码 / 着色器 / 管线 / 设备 → pending;
 *            ResizeObserver 之类的短尾巴 → 指纹静止窗);
 *   同步读状态;启动失败 → 退;就绪(同 READY_FN)→ 退;
 *   游戏还没挂出来 / 还没冻住 → 不动假时钟,接着等(这一段只有网络与模块求值,不等任何定时器);
 *   否则假时钟前进一步(PUMP_STEP_FN):下一个非 rAF 定时器落在本帧内就只走到它(不计帧、不跑 tick),
 *   否则走到帧末(round 累计 1000/60)、有 stepFixedTicks 了就再恰好一个逻辑 tick。
 * }
 * 页内定时器 / rAF 只在「前进一帧」里兑现,真异步只在帧与帧之间落地,所以装载帧数只取决于游戏装载里等了多少个定时器 / rAF,
 * 与机器快慢无关(pumpIdle 的判据没兜住的真异步除外——stall 记录与两侧帧数对比会把它暴露出来)。
 * 装载中整页重载(vite 依赖重新预构建)时新文档从纪元重来,计数清零、记一次 reloads。
 */
async function pumpBoot(page, watch, expectScene, opts) {
  const rec = { frames: 0, ticks: 0, timerSteps: 0, fakeMs: 0, firstStepFrame: null, stalls: [], stuck: {}, idleMs: 0, reloads: 0, phases: [], timerLog: [], idleLog: [], trace: [], clockLeaks: [] };
  // 新文档(整页重载)只认 domcontentloaded:同文档的 history 导航不触发它
  let docs = 0;
  const onDoc = () => {
    docs++;
  };
  page.on('domcontentloaded', onDoc);
  try {
    return await pumpLoop(page, watch, expectScene, opts, rec, () => docs);
  } finally {
    page.off('domcontentloaded', onDoc);
  }
}

async function pumpLoop(page, watch, expectScene, opts, rec, docCount) {
  const deadline = Date.now() + opts.bootTimeout;
  let last = null;
  let phase = null;
  let seenDocs = docCount();
  const resetForNewDoc = async () => {
    Object.assign(rec, { frames: 0, ticks: 0, timerSteps: 0, fakeMs: 0, firstStepFrame: null, stuck: {}, reloads: rec.reloads + 1, timerLog: [], idleLog: [], expectT: 0, readyFrame: undefined });
    rec.phases.push({ frame: 0, tick: 0, reload: true });
    phase = null;
    seenDocs = docCount();
    await sleep(500);
  };
  for (;;) {
    if (Date.now() > deadline) {
      return { ok: false, reason: `就绪等待超时(${opts.bootTimeout} ms,泵到第 ${rec.frames} 帧 / ${rec.ticks} tick)${last ? `,卡在 ${JSON.stringify({ sceneId: last.sceneId, switching: last.switching, runtimeReady: last.runtimeReady, gameState: last.gameState, cutscene: last.cutscene, dialogue: last.dialogue, hasGame: last.hasGame, frozen: last.frozen, pending: last.pending })}` : ''}`, state: last, pump: rec };
    }
    let s;
    try {
      s = await pumpIdle(page, watch, opts, rec);
    } catch (e) {
      if (!isContextLoss(e)) throw e;
      await resetForNewDoc();
      continue;
    }
    if (docCount() !== seenDocs) {
      await resetForNewDoc();
      continue;
    }
    last = s;
    // 停着的假时钟在两步之间绝不该动;动了(或在随墙钟走)= 有墙钟相关的东西漏进来了,大声记(run.mjs 会打出来)
    if (s.clock && (s.clock.rt || (typeof s.clock.t === 'number' && s.clock.t !== (rec.expectT ?? 0)))) {
      if (rec.clockLeaks.length < 50) rec.clockLeaks.push({ frame: rec.frames, timerSteps: rec.timerSteps, expected: rec.expectT ?? 0, got: s.clock.t, realTime: s.clock.rt });
    }
    if (s.clock && typeof s.clock.t === 'number') rec.expectT = s.clock.t;
    // 阶段变化记一笔(帧号 / tick 号 → 场景、切换、状态机…),两边装载帧数对不上时照它找是哪一段多 / 少了帧
    const ph = `${s.hasGame}|${s.frozen}|${s.hasStep}|${s.sceneId}|${s.switching}|${s.runtimeReady}|${s.gameState}|${s.cutscene}|${s.dialogue}|${s.curtain}|${s.loadStep}|${JSON.stringify(s.plWait ?? null)}`;
    if (ph !== phase) {
      phase = ph;
      if (rec.phases.length < 200) {
        rec.phases.push({ frame: rec.frames, tick: rec.ticks, timerSteps: rec.timerSteps, sceneId: s.sceneId, switching: s.switching, runtimeReady: s.runtimeReady, gameState: s.gameState, cutscene: s.cutscene, dialogue: s.dialogue, hasStep: s.hasStep, frozen: s.frozen, curtain: s.curtain, loadStep: s.loadStep, plWait: s.plWait ?? null });
      }
    }
    if (s.fatal) return { ok: false, reason: `启动失败:${s.fatal}`, state: s, pump: rec };
    if (pumpReady(s, expectScene)) {
      // 就绪可能落在帧内定时器步之后(帧中间):master 揭幕闸里 GlProgramWarmup 逐个交接之间的 wait(0) 每跳把假时钟推 1 ms,
      // 就地同步的话两边同步点差几毫秒(实测 A 3 ms / B 0 ms),之后按 rAF 16 ms 一拍读 performance.now() 的补间
      // (过场淡入淡出、标题)每隔一二十帧错一拍,叙事留痕的时间戳也差几毫秒。所以就绪后再推到下一个整帧边界
      // (带那一帧的逻辑 tick),两边都这样:同步点 = 纪元 + (就绪那一帧 + 1) 帧,绝对假时刻严格相同。
      rec.readyFrame ??= rec.frames;
      if (rec.frames > rec.readyFrame) {
        return { ok: true, state: s, froze: 'pump', heldByPerformance: s.switching === true, pump: rec };
      }
    }
    if (!s.hasGame || !s.frozen) {
      await sleep(4);
      continue;
    }
    const frameEnd = Math.round((rec.frames + 1) * FRAME_MS);
    const ms = frameEnd - Math.round(rec.frames * FRAME_MS);
    let r;
    try {
      r = await evalT(page, PUMP_STEP_FN, { frameEnd, ms, dt: FRAME_MS }, opts.stepTimeout, '泵一步');
    } catch (e) {
      if (!isContextLoss(e)) throw e;
      continue; // 下一轮 pumpIdle 撞上新文档,在那里清零
    }
    if (!r.internals) rec.wholeFrameFallback = true;
    if (typeof r.after === 'number') rec.expectT = r.after;
    if (r.frame) {
      rec.frames++;
      rec.fakeMs = frameEnd;
    } else {
      rec.timerSteps++;
      // 帧内定时器步:帧号 · 走之前 → 走到的假时刻 · 定时器(类型首字母 + 延时 @ 建立时刻)。两边帧数对不上时照它找是哪个定时器跨了帧
      if (rec.timerLog.length < 400) rec.timerLog.push(`${rec.frames}:${r.before}→${r.timerAt} ${r.info}`);
    }
    if (r.stepped) {
      rec.ticks++;
      rec.firstStepFrame ??= rec.frames;
    }
    for (const e of r.errs) watch.push('pageerror', e);
  }
}

const cpFileName = (i, name) => `${String(i).padStart(2, '0')}_${String(name).replace(/[\\/:*?"<>|\s]+/g, '_')}.png`;

/**
 * 跑一个场景的一次(一侧、一轮)。
 * @returns 运行记录:boot / checkpoints[{name,tick,file,probe,ops,items}] / steps / tailItems / fatal / unsupported / fsViolations
 */
export async function runScenario({ chromium, opts, side, scenario, rawDir, sharedBrowser = null }) {
  const res = {
    side: side.label, scenario: scenario.id, boot: null, sync: null, checkpoints: [], steps: [], tailItems: [],
    fatal: null, unsupported: [], fsViolations: [], reloaded: false, ticks: 0, wallMs: 0,
  };
  const t0 = Date.now();
  fs.mkdirSync(rawDir, { recursive: true });
  const viewport = scenario.boot.viewport ?? opts.viewport;
  const dpr = scenario.boot.dpr ?? opts.dpr;
  const browser = sharedBrowser ?? await launchBrowser(chromium, opts, side.browserArgs ?? []);
  let ctx = null;
  let watch = null;
  try {
    ctx = await browser.newContext({ viewport, deviceScaleFactor: dpr, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
    await ctx.addInitScript(seedInitScript(opts.seed));
    const pump = opts.freezeAt === 'pump';
    if (opts.freezeAt === 'boot' || pump) await ctx.addInitScript(EARLY_FREEZE_SCRIPT);
    // pump:只记一条 pauseAt(纪元)、不 install —— 页内回放时钟日志时直接停在纪元,performance.now() 从 0 起。
    // (install 再 pauseAt 的话,两条日志之间的墙钟间隔会被回放成 ticks,performance.now() 的起点就随机器快慢漂了。)
    if (pump) {
      await ctx.clock.pauseAt(opts.epoch);
      await ctx.addInitScript(pumpClockSettleScript(opts.epoch)); // 排在时钟两段脚本之后:当场停住并撤掉墙钟定时器
    } else {
      await ctx.clock.install({ time: opts.epoch });
    }
    const page = await ctx.newPage();
    watch = new PageWatch(page, side.dir);
    const expectScene = scenario.boot.scene;
    const url = `${side.url}${bootQuery(scenario.boot)}`;
    const tBoot = Date.now();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
    if (pump) {
      const ready = await pumpBoot(page, watch, expectScene, opts);
      res.boot = { ...ready, url: url.replace(side.url, '/'), bootMs: Date.now() - tBoot };
      if (!ready.ok) {
        res.fatal = `启动未就绪:${ready.reason}`;
        res.tailItems = watch.drain();
        return res;
      }
      page.on('domcontentloaded', () => {
        res.reloaded = true;
      });
      // 假时钟本来就停着:不墙钟沉淀、不 pauseAt 跳秒(那会一次性触发途中的定时器);就绪时的绝对假时刻 = 纪元 + 装载帧数的毫秒数
      await watch.quiesce();
    } else {
      const freezeAtReady = opts.freezeAt !== 'settled';
      const ready = await waitReady(page, expectScene, opts.bootTimeout, freezeAtReady);
      res.boot = { ...ready, url: url.replace(side.url, '/'), bootMs: Date.now() - tBoot };
      if (!ready.ok) {
        res.fatal = `启动未就绪:${ready.reason}`;
        res.tailItems = watch.drain();
        return res;
      }
      // 就绪之后再来一次 domcontentloaded = 整页重载了(同文档的 history 导航不触发它)
      page.on('domcontentloaded', () => {
        res.reloaded = true;
      });
      await sleep(opts.settle);
      await watch.quiesce();
      if (!freezeAtReady) {
        const r = await evalT(page, READY_FN, { expectScene, freeze: true }, 20000, '冻结');
        res.boot.froze = r.froze;
      }
      try {
        await page.clock.pauseAt(opts.epoch + opts.pauseOffset);
      } catch (e) {
        res.fatal = `clock.pauseAt 失败(装载超过 --pause-offset?):${msgOf(e)}`;
        return res;
      }
    }
    res.sync = await evalT(page, SYNC_FN, { seed: opts.seed }, 30000, '同步点');
    if (pump) {
      // 同步点的假时刻:两边装载帧数相同 ⇔ 相同(run.mjs / compare.mjs 对帧数不同大声报)
      res.boot.pump.syncNow = res.sync.now;
      res.boot.pump.syncDate = res.sync.date;
    }
    if (!res.sync.hasStep) res.unsupported.push('__gameDevAPI.stepFixedTicks');
    if (res.sync.fixed === 'unsupported') res.unsupported.push('__game.applyRuntimeCommand(debugSetFixedTickMode)');
    await watch.quiesce();

    let ticks = 0;
    let cpIndex = 0;
    // pump:装载之后的推进也等真异步落地(同 pumpIdle:装载桶 / 解码 / 管线 / 字体 / 指纹静止)再走下一帧。
    // 只等网络静下来的话,运行中才装的东西(过场插图、切场景的原画、HTMLText 生成)可能早一帧或晚一帧落地,
    // 以它为起点的推拉镜 / 淡入就差一帧——实测说书过场 B1 / B2 同一检查点整幅原画错位(同侧噪声 15%)。
    const runRec = pump && opts.pumpRun !== false
      ? { frames: 0, ticks: 0, timerSteps: 0, stalls: [], stuck: {}, idleMs: 0, idleLog: [], trace: [], lastFp: null, timerLog: [], clockLeaks: [] }
      : null;
    if (runRec) res.runPump = runRec;
    const runIdle = async () => {
      if (!runRec) return;
      runRec.frames = ticks;
      runRec.ticks = ticks;
      await pumpIdle(page, watch, opts, runRec);
    };
    // pump 的运行期一帧:同装载期逐个帧内定时器推进(PUMP_STEP_FN),每步之间让真异步落地。整帧 runFor 的话帧内定时器连着触发,
    // 中间不给真异步落地的机会——分支切场景时新管线落定(plSettling)是真异步,揭幕闸的轮询定时器在那一帧里看不到它,
    // 揭幕就晚一帧(实测向导一拍切进阎王岭山口后 B 的 NPC 动画相位一直差一个 tick);master 的 GL 同步编译没有这一步。
    // 帧内步用 0 静止窗:没有在途项就直接走,有(plSettling / 解码 …)照常等它落定。
    const idleOpts = { ...opts, pumpSettle: 0 };
    const pumpFrame = async () => {
      const frameEnd = res.sync.now + Math.round((ticks + 1) * FRAME_MS);
      const ms = Math.round((ticks + 1) * FRAME_MS) - Math.round(ticks * FRAME_MS);
      for (let guard = 0; guard < 500; guard++) {
        const r = await evalT(page, PUMP_STEP_FN, { frameEnd, ms, dt: FRAME_MS }, opts.stepTimeout, '推进 1 帧(泵)');
        for (const e of r.errs) watch.push('pageerror', e);
        if (r.frame) {
          if (typeof r.after === 'number' && r.after !== frameEnd && runRec.clockLeaks.length < 50) {
            runRec.clockLeaks.push({ tick: ticks, expected: frameEnd, got: r.after });
          }
          return r;
        }
        runRec.timerSteps++;
        if (runRec.timerLog.length < 400) runRec.timerLog.push(`${ticks}:${r.before}→${r.timerAt} ${r.info}`);
        runRec.frames = ticks;
        await pumpIdle(page, watch, idleOpts, runRec);
      }
      throw new Error(`运行期第 ${ticks} 帧里帧内定时器步超过 500 次(定时器风暴?)`);
    };
    const advance = async (n) => {
      for (let done = 0; done < n;) {
        await runIdle();
        if (runRec && opts.chunk === 1 && res.sync.pageClock && typeof res.sync.now === 'number') {
          const r = await pumpFrame();
          ticks += 1;
          done += 1;
          if (!r.stepped) {
            if (!res.unsupported.includes('__gameDevAPI.stepFixedTicks')) res.unsupported.push('__gameDevAPI.stepFixedTicks');
            break;
          }
          await watch.quiesce();
          continue;
        }
        const k = Math.min(opts.chunk, n - done);
        const ms = Math.round((ticks + k) * FRAME_MS) - Math.round(ticks * FRAME_MS);
        if (!res.sync.pageClock && ms > 0) await page.clock.runFor(ms);
        const r = await evalT(page, ADVANCE_FN, { ms, k, dt: FRAME_MS, pageClock: res.sync.pageClock }, opts.stepTimeout, `推进 ${k} 帧`);
        for (const e of r.errs) watch.push('pageerror', e);
        ticks += k;
        done += k;
        if (r.unsupported) {
          if (!res.unsupported.includes('__gameDevAPI.stepFixedTicks')) res.unsupported.push('__gameDevAPI.stepFixedTicks');
          break;
        }
        await watch.quiesce();
      }
      await runIdle();
    };
    for (let i = 0; i < scenario.steps.length; i++) {
      const step = scenario.steps[i];
      if (res.reloaded) {
        res.fatal = '运行中页面整页重载了(多半是 vite 依赖重新预构建);本轮作废';
        break;
      }
      if ('advance' in step) {
        await advance(step.advance);
      } else if ('checkpoint' in step) {
        await watch.quiesce();
        const file = path.join(rawDir, cpFileName(cpIndex, step.checkpoint));
        const canvasFile = path.join(rawDir, cpFileName(cpIndex, `${step.checkpoint}__canvas`));
        cpIndex++;
        let wrote = null;
        let wroteCanvas = null;
        const shot = () => page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide', scale: 'device', timeout: 90000 });
        try {
          fs.writeFileSync(file, await shot());
          wrote = file;
          await evalT(page, HIDE_DOM_FN, null, 10000, '隐藏 DOM 层');
          try {
            fs.writeFileSync(canvasFile, await shot());
            wroteCanvas = canvasFile;
          } finally {
            await evalT(page, RESTORE_DOM_FN, null, 10000, '还原 DOM 层');
          }
        } catch (e) {
          watch.push('pageerror', `[截图失败] ${msgOf(e)}`);
        }
        const probe = await evalT(page, PROBE_FN, null, 30000, '状态探针').catch((e) => ({ __error: msgOf(e) }));
        const ops = await evalT(page, OPS_FN, null, 10000, '读命令状态').catch(() => ({}));
        res.checkpoints.push({ name: step.checkpoint, tick: ticks, file: wrote, canvasFile: wroteCanvas, probe, ops, items: watch.drain() });
      } else if ('cmd' in step || 'api' in step) {
        const id = `s${i}`;
        const desc = 'cmd' in step ? `cmd ${step.cmd.type}` : `api ${step.api}(${(step.args ?? []).map((a) => JSON.stringify(a)).join(', ')})`;
        const r = await evalT(page, DISPATCH_FN, { id, kind: 'cmd' in step ? 'cmd' : 'api', name: step.api, args: step.args, cmd: step.cmd }, 20000, desc);
        res.steps.push({ id, desc, atTick: ticks, immediate: r.state });
        if (r.state === 'unsupported') res.unsupported.push(`${desc}:${r.result}`);
        await watch.quiesce();
      } else if ('viewport' in step) {
        await page.setViewportSize(step.viewport);
        res.steps.push({ id: `s${i}`, desc: `viewport ${step.viewport.width}x${step.viewport.height}`, atTick: ticks, immediate: 'done' });
      } else if ('key' in step || 'keyDown' in step || 'keyUp' in step || 'click' in step || 'wheel' in step) {
        // 外部输入:Playwright 真键盘 / 真鼠标(CDP Input.dispatch*),与玩家操作同一条路径,不碰游戏代码。
        // 只有快捷键才开得了的面板(背包 I、任务 Tab、书架 B …)靠它;两边同一时刻同一输入。
        let desc;
        let state = 'done';
        let result = null;
        try {
          if ('key' in step) {
            desc = `key ${step.key}`;
            await page.keyboard.press(step.key);
          } else if ('keyDown' in step) {
            desc = `keyDown ${step.keyDown}`;
            await page.keyboard.down(step.keyDown);
          } else if ('keyUp' in step) {
            desc = `keyUp ${step.keyUp}`;
            await page.keyboard.up(step.keyUp);
          } else if ('click' in step) {
            desc = `click ${step.click.x},${step.click.y}`;
            await page.mouse.click(step.click.x, step.click.y);
          } else {
            const w = step.wheel;
            desc = `wheel ${w.x},${w.y} Δ${w.dx ?? 0},${w.dy ?? 0}`;
            await page.mouse.move(w.x, w.y);
            await page.mouse.wheel(w.dx ?? 0, w.dy ?? 0);
          }
        } catch (e) {
          state = 'error';
          result = msgOf(e);
          watch.push('pageerror', `[外部输入失败] ${desc}:${result}`);
        }
        res.steps.push({ id: `s${i}`, desc, atTick: ticks, immediate: state, ...(result ? { result } : {}) });
        await watch.quiesce();
      } else if ('settle' in step) {
        await sleep(step.settle);
        await watch.quiesce();
      } else if ('inScene' in step) {
        // 场景表对账标记(validate.mjs 用它切换「当前场景」核对 NPC / 热区 / 坐标),运行时什么都不做
      }
    }
    res.ticks = ticks;
    const finalOps = await evalT(page, OPS_FN, null, 10000, '读命令状态').catch(() => ({}));
    for (const s of res.steps) {
      const f = finalOps[s.id];
      if (f) Object.assign(s, { final: f.state, result: f.result });
    }
  } catch (e) {
    res.fatal = msgOf(e);
  } finally {
    if (watch) {
      res.tailItems.push(...watch.drain());
      res.fsViolations = [...watch.fsViolations];
    }
    res.wallMs = Date.now() - t0;
    // 运行记录落盘(与截图同目录):--recompare 靠它不重跑游戏、只换判定参数重出报告
    try {
      fs.writeFileSync(path.join(rawDir, 'run.json'), JSON.stringify({ ...res, scenarioDef: scenario }));
    } catch {
      // 落盘失败不影响本轮结果
    }
    await ctx?.close().catch(() => {});
    if (!sharedBrowser) await browser.close().catch(() => {});
  }
  return res;
}

// ---------------------------------------------------------------- 性能(真实时间,不控时钟)

export async function runPerf({ chromium, opts, side, scenes, log }) {
  const out = { side: side.label, scenes: [], heap: [], errors: [] };
  const browser = await launchBrowser(chromium, opts, [...(side.browserArgs ?? []), '--js-flags=--expose-gc']);
  try {
    for (const s of scenes) {
      const ctx = await browser.newContext({ viewport: opts.viewport, deviceScaleFactor: opts.dpr });
      try {
        await ctx.addInitScript(seedInitScript(opts.seed));
        const page = await ctx.newPage();
        await page.goto(`${side.url}${bootQuery({ scene: s })}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
        const ready = await waitReady(page, s, opts.bootTimeout, false);
        if (!ready.ok) {
          out.scenes.push({ scene: s, ok: false, reason: ready.reason });
          continue;
        }
        await sleep(opts.perfSettle);
        const m = await evalT(page, MEASURE_FN, { ms: opts.perfSeconds * 1000 }, opts.perfSeconds * 1000 + 30000, '测帧');
        const heap = await evalT(page, HEAP_FN, null, 20000, '读堆').catch(() => null);
        out.scenes.push({ scene: s, ok: true, ...m, heapMB: heap?.usedMB ?? null });
        log?.(`  perf ${side.label} ${s}: ${m.frames} 帧,均 ${m.meanMs.toFixed(2)} ms,p95 ${m.p95Ms?.toFixed(2)} ms`);
      } catch (e) {
        out.scenes.push({ scene: s, ok: false, reason: msgOf(e) });
      } finally {
        await ctx.close().catch(() => {});
      }
    }
    // 堆:同一页里把这些场景轮切 3 遍,每遍之后 gc 两次再读 usedJSHeapSize
    const ctx = await browser.newContext({ viewport: opts.viewport, deviceScaleFactor: opts.dpr });
    try {
      await ctx.addInitScript(seedInitScript(opts.seed));
      const page = await ctx.newPage();
      await page.goto(`${side.url}${bootQuery({ scene: 'dev_room' })}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
      const ready = await waitReady(page, 'dev_room', opts.bootTimeout, false);
      if (!ready.ok) throw new Error(`dev_room 没起来:${ready.reason}`);
      out.heap.push({ round: 0, ...(await evalT(page, HEAP_FN, null, 20000, '读堆')) });
      for (let round = 1; round <= 3; round++) {
        for (const s of scenes) {
          const r = await evalT(page, (sid) => window.__game.applyRuntimeCommand({ id: `ab-perf-${sid}`, type: 'debugSwitchScene', sceneId: sid }), s, 180000, `切场景 ${s}`);
          if (!r?.ok) out.errors.push(`切到 ${s} 失败:${r?.message}`);
          await sleep(1000);
        }
        out.heap.push({ round, ...(await evalT(page, HEAP_FN, null, 20000, '读堆')) });
        log?.(`  heap ${side.label} 第 ${round} 轮:${out.heap[out.heap.length - 1].usedMB?.toFixed(1)} MB`);
      }
    } catch (e) {
      out.errors.push(msgOf(e));
    } finally {
      await ctx.close().catch(() => {});
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return out;
}

/** 预热一个 dev 服:开一次首页,让 vite 把依赖预构建做完(否则第一个场景会撞上整页重载) */
export async function warmUp(chromium, opts, side, log) {
  const browser = await launchBrowser(chromium, opts, side.browserArgs ?? []);
  try {
    const page = await browser.newPage({ viewport: opts.viewport });
    const t0 = Date.now();
    await page.goto(`${side.url}${bootQuery({ scene: 'dev_room' })}`, { waitUntil: 'domcontentloaded', timeout: 180000 }).catch(() => {});
    const r = await waitReady(page, 'dev_room', opts.bootTimeout, false).catch((e) => ({ ok: false, reason: msgOf(e) }));
    await sleep(2000);
    log(`预热 ${side.label}(:${side.port}):${r.ok ? '就绪' : `未就绪 —— ${r.reason}`},${((Date.now() - t0) / 1000).toFixed(1)} s`);
    return r;
  } finally {
    await browser.close().catch(() => {});
  }
}
