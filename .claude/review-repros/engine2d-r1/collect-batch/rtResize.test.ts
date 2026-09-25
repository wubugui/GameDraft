import { describe, expect, it } from 'vitest';
import * as P from 'pixi.js';
import { Container, RenderTexture, Sprite } from '../../../../src/engine2d';
import type { BatchableElement, RenderCollector } from '../../../../src/engine2d/core/contracts';

// WaterMinigameScene.layout(): bottomMrt.resize(texW, texH) on a non-dynamic RenderTexture shown by bottomMrtSprite
describe('sprite showing a non-dynamic RenderTexture that is resized after first render', () => {
  it('pixi (master): quad bounds and filter bounds both stay at the old size', () => {
    const rt = P.RenderTexture.create({ width: 800, height: 600 });
    const spr = new P.Sprite(rt);
    const stage = new P.Container();
    stage.enableRenderGroup();
    stage.addChild(spr);
    const pipe = new P.SpritePipe({ uid: 3, _roundPixels: 0 } as never);
    const gpu = (pipe as any)._getGpuSprite(spr); // first render (addRenderable, didViewUpdate)
    (pipe as any)._updateBatchableSprite(spr, gpu);
    spr.didViewUpdate = false;
    void spr.bounds;
    rt.resize(600, 450); // window resize -> layout()
    spr.width = 600; spr.height = 450;
    // next render: updateRenderable only refreshes bounds if didViewUpdate
    expect(spr.didViewUpdate).toBe(false);
    console.log('pixi quad', JSON.stringify(gpu.bounds), 'filter bounds', spr.bounds.maxX, spr.bounds.maxY, 'scale', spr.scale.x);
    expect(gpu.bounds.maxX).toBe(800);
    expect(spr.bounds.maxX).toBe(800);
  });

  it('engine2d: quad bounds follow the new size, filter bounds (ViewContainer.bounds) stay at the old size', () => {
    const rt = RenderTexture.create({ width: 800, height: 600 });
    const spr = new Sprite(rt);
    const stage = new Container();
    stage.addChild(spr);
    const seen: { maxX: number; maxY: number }[] = [];
    const collector = { resolution: 1, addBatchable: (e: BatchableElement) => seen.push({ ...e.bounds! }) } as unknown as RenderCollector;
    spr.collectRenderables(collector);
    void spr.bounds;
    rt.resize(600, 450);
    spr.width = 600; spr.height = 450;
    spr.collectRenderables(collector);
    console.log('engine2d quad', JSON.stringify(seen[1]), 'filter bounds', spr.bounds.maxX, spr.bounds.maxY, 'scale', spr.scale.x);
    expect(seen[1].maxX).toBe(600);
    expect(spr.bounds.maxX).toBe(800);
  });
});
