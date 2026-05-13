import { Graphics, Container, RenderTexture, Application } from 'pixi.js';

export function createPlaceholderBackground(
  _app: Application,
  width: number,
  height: number,
): Container {
  const container = new Container();

  const bg = new Graphics();
  bg.rect(0, 0, width, height).fill(0x2a2a3e);
  container.addChild(bg);

  const grid = new Graphics();
  for (let x = 0; x < width; x += 80) {
    grid.moveTo(x, 0);
    grid.lineTo(x, height);
  }
  for (let y = 0; y < height; y += 80) {
    grid.moveTo(0, y);
    grid.lineTo(width, y);
  }
  grid.stroke({ width: 1, color: 0x3a3a4e });
  container.addChild(grid);

  return container;
}

export function createPlaceholderPlayerTextures(app: Application): {
  texture: RenderTexture;
  frameWidth: number;
  frameHeight: number;
} {
  const frameWidth = 32;
  const frameHeight = 48;
  const frameCount = 6;

  const container = new Container();

  for (let i = 0; i < frameCount; i++) {
    const x = i * frameWidth;
    const brightness = i < 2 ? 0xd4a574 : (i % 2 === 0 ? 0xc49564 : 0xb48554);

    const head = new Graphics();
    head.circle(x + 16, 12, 7).fill(brightness);
    container.addChild(head);

    const body = new Graphics();
    body.rect(x + 10, 19, 12, 16).fill(brightness);
    container.addChild(body);

    const legs = new Graphics();
    if (i >= 2) {
      const legOff = (i % 2 === 0) ? 0 : 4;
      legs.rect(x + 10 + legOff, 35, 5, 12).fill(brightness);
      legs.rect(x + 17 - legOff, 35, 5, 12).fill(brightness);
    } else {
      legs.rect(x + 11, 35, 4, 12).fill(brightness);
      legs.rect(x + 17, 35, 4, 12).fill(brightness);
    }
    container.addChild(legs);
  }

  const texture = RenderTexture.create({
    width: frameWidth * frameCount,
    height: frameHeight,
  });
  app.renderer.render({ container, target: texture });

  return { texture, frameWidth, frameHeight };
}
