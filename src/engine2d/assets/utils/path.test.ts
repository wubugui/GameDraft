import { expect, it } from 'vitest';
import { path } from './path';

it('keeps the packaged game host when resolving root-relative assets', () => {
  const page = 'gamedraft://game/index.html';
  const title = '/resources/runtime/images/backgrounds/menu_wujin_dock.png';

  expect(path.rootname(page)).toBe('gamedraft://game/');
  expect(path.toAbsolute(title, page)).toBe(
    'gamedraft://game/resources/runtime/images/backgrounds/menu_wujin_dock.png',
  );
  expect(path.toAbsolute('images/icon.png', page)).toBe('gamedraft://game/images/icon.png');
});

it('keeps HTTP and file roots stable', () => {
  expect(path.rootname('https://example.test/game/index.html')).toBe('https://example.test/');
  expect(path.rootname('file:///C:/game/index.html')).toBe('file:///');
});
