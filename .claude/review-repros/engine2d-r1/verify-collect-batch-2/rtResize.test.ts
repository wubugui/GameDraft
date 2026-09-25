import { describe, expect, it, vi } from 'vitest';
import * as P from 'pixi.js';
import { NullRhiDevice } from '../../../../src/rendering/rhi/backends/null/NullRhiDevice';
import { Container, RenderTexture, Sprite, AlphaFilter } from '../../../../src/engine2d';
import { FrameBuilder } from '../../../../src/engine2d/gpu/FrameBuilder';
import { WebGPURenderer } from '../../../../src/engine2d/gpu/WebGPURenderer';

// WaterMinigameScene.layout(): non-dynamic RT grows 600x450 -> 800x600 after first render, sprite width/height set to target size.
const TARGET_W = 900, TARGET_H = 675;

describe('RT resize under a filtered sprite (grow case)', () => {
  it('pixi (master): quad and filter bounds both remain at the old local size', () => {
    const rt = P.RenderTexture.create({ width: 600, height: 450 });
    const spr = new P.Sprite(rt);
    // (Pixi filter construction needs a DOM; filter area = getFastGlobalBounds of the sprite, which reads spr.bounds)
    const stage = new P.Container();
    stage.enableRenderGroup();
    stage.addChild(spr);
    const pipe = new P.SpritePipe({ uid: 3, _roundPixels: 0 } as never);
    // first render: addRenderable with didViewUpdate
    const gpu = (pipe as any)._getGpuSprite(spr);
    if (spr.didViewUpdate) (pipe as any)._updateBatchableSprite(spr, gpu);
    spr.didViewUpdate = false; // RenderGroup.updateRenderable / validate resets
    const fb1 = spr.getFastGlobalBounds(true);
    // layout()
    rt.resize(800, 600);
    spr.texture = rt; // same texture -> early return
    spr.width = TARGET_W; spr.height = TARGET_H;
    // second render
    if (spr.didViewUpdate) (pipe as any)._updateBatchableSprite(spr, gpu);
    stage.updateTransform?.({});
    (spr as any).updateLocalTransform?.();
    const quadScreenW = (gpu.bounds.maxX - gpu.bounds.minX) * spr.scale.x;
    const fb2 = spr.getFastGlobalBounds(true);
    console.log('PIXI first filter bounds', fb1.width, 'quad local', JSON.stringify(gpu.bounds), 'scale', spr.scale.x, 'quad screen w', quadScreenW, 'filter local bounds', spr.bounds.maxX, spr.bounds.maxY);
    expect(spr.didViewUpdate).toBe(false);
    expect(gpu.bounds.maxX).toBe(600);
    expect(spr.bounds.maxX).toBe(600);
  });

  it('engine2d (branch): quad follows new size, filter area stays at old size -> quad cropped', () => {
    const rhi = new NullRhiDevice();
    const canvas = { width: 1024, height: 1024, style: {} } as unknown as HTMLCanvasElement;
    const renderer = new WebGPURenderer({ rhi, canvas, width: 1024, height: 1024 });
    const areas: number[][] = [];
    const orig = (FrameBuilder.prototype as any).calculateFilterArea;
    const spyArea = vi.spyOn(FrameBuilder.prototype as any, 'calculateFilterArea').mockImplementation(function (this: unknown, c: unknown, e: unknown, b: any) {
      orig.call(this, c, e, b);
      areas.push([b.minX, b.minY, b.maxX, b.maxY]);
    });
    const quads: number[][] = [];
    const origCollect = Sprite.prototype.collectRenderables;
    const spyCollect = vi.spyOn(Sprite.prototype, 'collectRenderables').mockImplementation(function (this: Sprite, col: any) {
      origCollect.call(this, col);
      const b = (this as any)._batchable.bounds;
      quads.push([b.minX, b.minY, b.maxX, b.maxY, this.scale.x, this.scale.y]);
    });

    const rt = RenderTexture.create({ width: 600, height: 450 });
    const spr = new Sprite(rt);
    spr.filters = [new AlphaFilter()];
    const stage = new Container();
    stage.addChild(spr);
    spr.width = 600; spr.height = 450; // initial layout
    renderer.render({ container: stage });
    rt.resize(800, 600);
    spr.texture = rt;
    spr.width = TARGET_W; spr.height = TARGET_H;
    renderer.render({ container: stage });
    console.log('ENGINE2D filter areas (screen)', JSON.stringify(areas), 'quads (local + scale)', JSON.stringify(quads));
    const q = quads[quads.length - 1];
    const a = areas[areas.length - 1];
    const quadScreenW = (q[2] - q[0]) * q[4];
    const quadScreenH = (q[3] - q[1]) * q[5];
    console.log('ENGINE2D quad screen', quadScreenW, quadScreenH, 'filter area', a[2] - a[0], a[3] - a[1]);
    expect(quadScreenW).toBeCloseTo(TARGET_W);
    expect(a[2] - a[0]).toBeCloseTo(600 * q[4]); // filter area 675 wide < quad 900 wide -> right 225px cropped
    spyArea.mockRestore(); spyCollect.mockRestore();
    renderer.destroy();
  });
});
