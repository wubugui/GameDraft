import { describe, expect, it } from 'vitest';
import { Container, Sprite, Texture, SpritePipe, updateRenderGroupTransforms, Matrix } from 'pixi.js';

describe('pixi nested render group semantics (sprite root)', () => {
  it('color / transform of a sprite that became a render group', () => {
    const stage = new Container();
    stage.enableRenderGroup();
    const objectRoot = new Container();
    objectRoot.scale.set(2);
    objectRoot.x = 100;
    objectRoot.alpha = 0.5;
    stage.addChild(objectRoot);
    const spr = new Sprite(Texture.WHITE);
    spr.x = 5;
    spr.tint = 0x808080;
    objectRoot.addChild(spr);

    const fakeRenderer = { uid: 1, _roundPixels: 0 } as never;
    const pipe = new SpritePipe(fakeRenderer);
    // first main render: transforms updated, sprite gets its BatchableSprite
    updateRenderGroupTransforms(stage.renderGroup, true);
    const gpu = (pipe as any)._getGpuSprite(spr);
    console.log('before RG: color', (gpu.color >>> 0).toString(16), 'transform', JSON.stringify(gpu.transform));

    // contactAo bake: renderer.render({container: spr, transform}) -> enableRenderGroup
    spr.enableRenderGroup();
    spr.tint = 0x808081; spr.tint = 0x808080; // poke update
    objectRoot.x = 101; objectRoot.x = 100;
    updateRenderGroupTransforms(stage.renderGroup, true);
    const rg = spr.renderGroup!;
    console.log('after RG: batchable color', (gpu.color >>> 0).toString(16),
      'batchable.transform', JSON.stringify(gpu.transform),
      'sprite.groupTransform', JSON.stringify(spr.groupTransform),
      'rg.worldTransform', JSON.stringify(rg.worldTransform),
      'rg.worldColorAlpha', (rg.worldColorAlpha >>> 0).toString(16),
      'isSame(batchable.transform, relativeGroupTransform)', gpu.transform === spr.relativeGroupTransform);
    expect(true).toBe(true);
    void Matrix;
  });
});
