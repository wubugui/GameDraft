import { Game } from './core/Game';

const urlParams = new URLSearchParams(window.location.search);
const devMode = urlParams.get('mode') === 'dev';
const playCutscene = urlParams.get('play_cutscene') ?? undefined;

let game: Game | null = new Game();
game.start({ devMode, playCutscene }).catch(console.error);

const onBeforeUnload = () => {
  game?.destroy();
};

window.addEventListener('beforeunload', onBeforeUnload);
window.addEventListener('pagehide', onBeforeUnload);

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    window.removeEventListener('beforeunload', onBeforeUnload);
    window.removeEventListener('pagehide', onBeforeUnload);
    game?.destroy();
    game = null;
  });
}
