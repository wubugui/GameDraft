import { Game } from './core/Game';

const game = new Game();
game.start().catch(console.error);

const onBeforeUnload = () => {
  game.destroy();
};

window.addEventListener('beforeunload', onBeforeUnload);
window.addEventListener('pagehide', onBeforeUnload);
