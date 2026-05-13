import { Game } from './core/Game';

const urlParams = new URLSearchParams(window.location.search);
/** 开发面板等；另见 `?cutsceneDebug` 可在非 dev 时显示过场当前 step HUD */
const devMode = urlParams.get('mode') === 'dev';
const playCutscene = urlParams.get('play_cutscene') ?? undefined;
const waterPreview = urlParams.get('waterPreview') ?? undefined;
const sugarWheelPreview = urlParams.get('sugarWheelPreview') ?? undefined;
const paperCraftPreview = urlParams.get('paperCraftPreview') ?? undefined;

let game: Game | null = new Game();
game.start({ devMode, playCutscene, waterPreview, sugarWheelPreview, paperCraftPreview }).catch(console.error);

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
