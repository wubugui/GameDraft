import { describe, expect, it } from 'vitest';
import * as P from 'pixi.js';
import { Sprite, Texture, Container } from '../../../../src/engine2d';
import type { BatchableElement, RenderCollector } from '../../../../src/engine2d/core/contracts';

describe('sprite.roundPixels toggled after first render', () => {
  it('pixi 8.17 snapshots roundPixels into BatchableSprite at first render', () => {
    const spr = new P.Sprite(P.Texture.WHITE);
    const stage = new P.Container();
    stage.enableRenderGroup();
    stage.addChild(spr);
    const pipe = new P.SpritePipe({ uid: 7, _roundPixels: 0 } as never);
    const gpu = (pipe as any)._getGpuSprite(spr); // first render: addRenderable -> _getGpuSprite
    expect(gpu.roundPixels).toBe(0);
    spr.roundPixels = true; // SpriteEntity.setPixelDensityMatchActive(true)
    pipe.updateRenderable = pipe.updateRenderable; // no API refreshes it
    const again = (pipe as any)._getGpuSprite(spr);
    expect(again).toBe(gpu);
    expect(again.roundPixels).toBe(0); // master keeps drawing un-rounded
  });

  it('engine2d reads roundPixels live every frame', () => {
    const spr = new Sprite(Texture.WHITE);
    const stage = new Container();
    stage.addChild(spr);
    const seen: number[] = [];
    const collector = { resolution: 1, addBatchable: (e: BatchableElement) => seen.push(e.roundPixels) } as unknown as RenderCollector;
    spr.collectRenderables(collector);
    spr.roundPixels = true;
    spr.collectRenderables(collector);
    expect(seen).toEqual([0, 1]);
  });
});
