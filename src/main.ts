import { Game } from './core/Game';

let game: Game | null = new Game();
game.start().catch(console.error);

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
