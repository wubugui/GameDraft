import { installResizeObserverQuiet } from './utils/resizeObserverQuiet';
import { Game } from './core/Game';

installResizeObserverQuiet();

const urlParams = new URLSearchParams(window.location.search);
/** 开发面板等；另见 `?cutsceneDebug` 可在非 dev 时显示过场当前 step HUD */
const devMode = urlParams.get('mode') === 'dev';
const playCutscene = urlParams.get('play_cutscene') ?? undefined;
const devScene = urlParams.get('devScene') ?? urlParams.get('dev_scene') ?? undefined;
const narrativeWarp = urlParams.get('narrativeWarp') ?? urlParams.get('narrative_warp') ?? undefined;
const waterPreview = urlParams.get('waterPreview') ?? undefined;
const sugarWheelPreview = urlParams.get('sugarWheelPreview') ?? undefined;
const paperCraftPreview = urlParams.get('paperCraftPreview') ?? undefined;
const visualCapture = urlParams.has('visualCapture');

let game: Game | null = null;

function startGame(): void {
  game = new Game();
  game.start({
    devMode,
    playCutscene,
    devScene,
    narrativeWarp,
    waterPreview,
    sugarWheelPreview,
    paperCraftPreview,
    visualCapture,
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
  || waterPreview || sugarWheelPreview || paperCraftPreview,
);
if (skipStartGate) {
  startGame();
} else {
  showStartGateThenStart();
}

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
