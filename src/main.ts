import { installResizeObserverQuiet } from './utils/resizeObserverQuiet';
import { Game } from './core/Game';
import { LOAD_SLOT_PARAM, NEW_GAME_PARAM, TITLE_BOOT_PARAM } from './core/EventBridge';
import { runEntryGuard } from './core/entryGuard';
import { resolveBootParams } from './core/bootParams';

installResizeObserverQuiet();

// dev:未捕获错误必须带**堆栈**打进 console(编辑器把 console 转进日志面板)。
// 没有这个钩子时,QWebEngine 只转发一行 message ——2026-09-01 那次
// "Cannot read properties of null (reading '6')" 每帧刷屏却无从定位就是这么来的。
// 去重计数:同一条不淹日志,但每 500 次报一声让人知道它还活着。
if (import.meta.env.DEV) {
  const seen = new Map<string, number>();
  const report = (tag: string, msg: string, stack: string | undefined): void => {
    const n = (seen.get(msg) ?? 0) + 1;
    seen.set(msg, n);
    if (n <= 3 || n % 500 === 0) {
      console.error(`[${tag}#${n}] ${stack ?? msg}`);
    }
  };
  window.addEventListener('error', (e) => {
    report('uncaught', String(e.error?.message ?? e.message),
      typeof e.error?.stack === 'string' ? e.error.stack : undefined);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as { message?: string; stack?: string } | undefined;
    report('unhandled-rejection', String(r?.message ?? e.reason),
      typeof r?.stack === 'string' ? r.stack : undefined);
  });
}

/**
 * 启动参数 = 地址栏 ∪ 打包时烘进来的缺省（后者只在地址栏没给引导参数时才生效）。
 * 详见 `core/bootParams.ts`。dev server 上没有烘进来的东西，行为与以前逐字节相同。
 */
const urlParams = resolveBootParams(
  window.location.search,
  (globalThis as { __GAMEDRAFT_BOOT_QUERY__?: unknown }).__GAMEDRAFT_BOOT_QUERY__,
);
/**
 * dev 直达参数族只在 dev 构建生效：`?mode=dev` 能开 DevModeUI 任意跳场景，
 * `devScene` / `narrativeWarp` / `play_cutscene` / 各预览同样是绕过正常开局的直达通道。
 * 生产构建里玩家改 URL 不该拿到任何一条（发行阻断项，2026-08-17 审查批0）。
 */
const isDevBuild = import.meta.env.DEV;
/**
 * 把编译期档位**显式暴露出来**，给打包验收门与现场排障用。
 *
 * 起因是踩过一次：dev 档只给了 `vite build --mode development` 而没设
 * `NODE_ENV=development`，`import.meta.env.DEV` 仍编译成 false，整批调试设施被剔除，
 * 打出来的 dev 包跟发行档一模一样、连显式 `?mode=dev` 都不认——**而且没有任何报错**。
 *
 * 想从字节层面判断一个包到底是哪档，其它标记都不可靠：类名被 esbuild 压掉、
 * `__gameDevAPI` 之类的全局在 destroy 清理路径里两档都有、`import.meta.env` 早被替换掉。
 * 这一行的三元会被常量折叠成一个字面量字符串，`"dev"` / `"release"` 原样留在产物里，
 * 于是 `scripts/verify_build.mjs` 能静态判死。
 */
(globalThis as { __GAMEDRAFT_BUILD__?: string }).__GAMEDRAFT_BUILD__ = isDevBuild ? 'dev' : 'release';
/** 开发面板等；另见 `?cutsceneDebug` 可在非 dev 时显示过场当前 step HUD */
const devMode = isDevBuild && urlParams.get('mode') === 'dev';
const playCutscene = (isDevBuild && urlParams.get('play_cutscene')) || undefined;
/** 配合 play_cutscene：顶层步下标，之前的步瞬时快进后从该步起常速（编辑器「从这一步开始播」） */
const playCutsceneFrom = (isDevBuild && urlParams.get('play_cutscene_from')) || undefined;
const devScene = (isDevBuild && (urlParams.get('devScene') ?? urlParams.get('dev_scene'))) || undefined;
const narrativeWarp = (isDevBuild && (urlParams.get('narrativeWarp') ?? urlParams.get('narrative_warp'))) || undefined;
const waterPreview = (isDevBuild && urlParams.get('waterPreview')) || undefined;
const sugarWheelPreview = (isDevBuild && urlParams.get('sugarWheelPreview')) || undefined;
const paperCraftPreview = (isDevBuild && urlParams.get('paperCraftPreview')) || undefined;
const visualCapture = isDevBuild && urlParams.has('visualCapture');
/**
 * 引导态标记（由 EventBridge 在整页重启时写入，见 TITLE_BOOT_PARAM / LOAD_SLOT_PARAM）：
 * - `startAtTitle`：停在标题界面，**不装载世界**（「回主菜单」＝彻底退出这一局）；
 * - `loadSlot`：正常启动，但开局直接读这个存档槽（标题界面上点「继续」走的路）。
 */
const startAtTitle = urlParams.has(TITLE_BOOT_PARAM);
const loadSlotRaw = urlParams.get(LOAD_SLOT_PARAM);
const loadSlotParsed = loadSlotRaw === null ? Number.NaN : Number.parseInt(loadSlotRaw, 10);
const loadSlot = Number.isInteger(loadSlotParsed) && loadSlotParsed >= 0 ? loadSlotParsed : undefined;

let game: Game | null = null;

function startGame(): void {
  game = new Game();
  game.start({
    devMode,
    playCutscene,
    playCutsceneFrom,
    devScene,
    narrativeWarp,
    waterPreview,
    sugarWheelPreview,
    paperCraftPreview,
    visualCapture,
    startAtTitle,
    loadSlot,
  }).catch((e) => {
    console.error(e);
    // 先拆掉半初始化实例：Game 构造期就已挂全局输入监听、各系统已 init（EventBus 订阅已建立），
    // 不销毁会陪着错误画面一直残留（destroy 幂等；出错也不阻断下面的错误提示）。
    try {
      destroyGame();
    } catch (cleanupError) {
      console.warn('main: 启动失败后的清理也失败', cleanupError);
    }
    // 生产启动失败原本只剩黑屏：给玩家一个最小可诊断的 DOM 错误提示（dev 另有 overlay/console）
    try {
      const el = document.createElement('div');
      el.id = 'game-fatal-error';
      el.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:99999', 'display:flex',
        'align-items:center', 'justify-content:center', 'padding:24px',
        'background:#0b0d10', 'color:#e8d9b0', 'font:14px/1.6 system-ui,sans-serif',
        'text-align:center', 'white-space:pre-wrap',
      ].join(';');
      el.textContent = `游戏启动失败，请刷新页面重试。\n${e instanceof Error ? e.message : String(e)}`;
      document.body.appendChild(el);
    } catch {
      /* DOM 不可用时仅 console */
    }
  });
}

/**
 * 首启「点击开始」手势门：玩家点一下再进游戏，借这一次用户手势解锁 AudioContext，
 * 保证开场过场首句旁白的配音音画同步（浏览器 autoplay 策略要求先有手势才允许出声；
 * 否则首句配音会被推迟到下一次点击才补播、与字幕错位）。AudioManager 在 init 时会检测
 * 页面已获得的 sticky 用户激活并据此直接解锁。
 * dev / 各预览模式跳过此门，避免阻塞编辑器预览与自动化命令通道。
 */
function showStartGateThenStart(): void {
  const overlay = document.createElement('div');
  overlay.id = 'game-start-gate';
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:99998', 'display:flex',
    'flex-direction:column', 'align-items:center', 'justify-content:center',
    'gap:14px', 'cursor:pointer', 'user-select:none',
    'background:#0b0d10', 'color:#e8d9b0', 'font-family:system-ui,sans-serif',
    'text-align:center',
  ].join(';');

  const title = document.createElement('div');
  title.textContent = '点击开始';
  title.style.cssText = 'font-size:28px;letter-spacing:0.3em;font-weight:600;';

  const hint = document.createElement('div');
  hint.textContent = '点击任意处进入（开启声音）';
  hint.style.cssText = 'font-size:13px;opacity:0.55;letter-spacing:0.1em;';

  overlay.append(title, hint);

  let started = false;
  const enter = (): void => {
    if (started) return;
    started = true;
    window.removeEventListener('keydown', enter, true);
    overlay.remove();
    startGame();
  };
  // pointerdown / touchstart / keydown 任一都构成用户手势，足以解锁音频
  overlay.addEventListener('pointerdown', enter, { once: true });
  overlay.addEventListener('touchstart', enter, { once: true });
  window.addEventListener('keydown', enter, true);

  document.body.appendChild(overlay);
}

const skipStartGate = Boolean(
  devMode || playCutscene || devScene || narrativeWarp
  || waterPreview || sugarWheelPreview || paperCraftPreview
  // 标题态启动不需要这道门：标题界面本身没有要出声的东西，而玩家点「新游戏 / 继续」
  // 都会整页重启一次、那一次照常有门。多加一道只是让"回主菜单"多点一下。
  || startAtTitle,
);
/**
 * 先过入口卫兵再决定要不要起游戏：`file://` 这类根本跑不起来的当场说清楚，
 * 存档后端不可用的挂一条横幅（"这次的进度不会留下"），别让人存完档才发现。
 * 卫兵自己不抛——它出问题不该顶掉整个开局。
 */
void runEntryGuard(isDevBuild)
  .catch((e) => {
    console.warn('main: 入口检查失败，按正常流程启动', e);
    return true;
  })
  .then((ok) => {
    if (!ok) return;
    if (skipStartGate) {
      startGame();
    } else {
      showStartGateThenStart();
    }
  });

function destroyGame(): void {
  window.removeEventListener('beforeunload', onBeforeUnload);
  window.removeEventListener('pagehide', onBeforeUnload);
  if (game) {
    game.destroy();
    game = null;
  }
}

const onBeforeUnload = (): void => {
  destroyGame();
};

window.addEventListener('beforeunload', onBeforeUnload);
window.addEventListener('pagehide', onBeforeUnload);

/** 供编辑器 Qt WebEngine 在关闭预览窗口时同步停音频（无 pagehide） */
window.__gameDestroy = () => {
  destroyGame();
};

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    destroyGame();
  });
}
