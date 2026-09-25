/**
 * 从外面驱动一局真游戏:起浏览器、装确定性控制、冷启动、锁步推进、检查点取证。
 *
 * 只碰 master 上就有的入口:`window.__game`(DEV 实例;私有方法 applyRuntimeCommand 在 JS 里照样可调)与
 * `window.__gameDevAPI`(isReady / stepFixedTicks / startMinigame / playCutscene / completeDialogueText …)。
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
    if (opts.freezeAt === 'boot') await ctx.addInitScript(EARLY_FREEZE_SCRIPT);
    await ctx.clock.install({ time: opts.epoch });
    const page = await ctx.newPage();
    watch = new PageWatch(page, side.dir);
    const expectScene = scenario.boot.scene;
    const url = `${side.url}${bootQuery(scenario.boot)}`;
    const tBoot = Date.now();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
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
    res.sync = await evalT(page, SYNC_FN, { seed: opts.seed }, 30000, '同步点');
    if (!res.sync.hasStep) res.unsupported.push('__gameDevAPI.stepFixedTicks');
    if (res.sync.fixed === 'unsupported') res.unsupported.push('__game.applyRuntimeCommand(debugSetFixedTickMode)');
    await watch.quiesce();

    let ticks = 0;
    let cpIndex = 0;
    const advance = async (n) => {
      for (let done = 0; done < n;) {
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
      } else if ('settle' in step) {
        await sleep(step.settle);
        await watch.quiesce();
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
