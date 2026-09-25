import { describe, expect, it } from 'vitest';
import * as P from 'pixi.js';
import { Container, Sprite, Texture } from '../../../../src/engine2d';
import { prepareTree } from '../../../../src/engine2d/gpu/collect';

describe('render-group promoted sprite: master (pixi) vs engine2d colour', () => {
  it('pixi: vertex colour and RG uniform both carry tint and ancestor alpha', () => {
    const stage = new P.Container();
    stage.enableRenderGroup();
    const objectRoot = new P.Container();
    objectRoot.alpha = 0.5;
    stage.addChild(objectRoot);
    const spr = new P.Sprite(P.Texture.WHITE);
    spr.tint = 0xccc6bd;
    objectRoot.addChild(spr);
    // contactAo bake happens before first main render: enableRenderGroup first
    spr.enableRenderGroup();
    const pipe = new P.SpritePipe({ uid: 1, _roundPixels: 0 } as never);
    P.updateRenderGroupTransforms(stage.renderGroup, true);
    const gpu = (pipe as any)._getGpuSprite(spr);
    const vtx = gpu.color >>> 0;
    const uni = spr.renderGroup!.worldColorAlpha >>> 0;
    console.log('pixi vertex', vtx.toString(16), 'uniform', uni.toString(16), 'transform', JSON.stringify(gpu.transform));
    expect(vtx).toBe(0x7fbdc6cc);
    expect(uni).toBe(0x7fbdc6cc);
  });

  it('engine2d: colour applied once', () => {
    const stage = new Container();
    const objectRoot = new Container();
    objectRoot.alpha = 0.5;
    stage.addChild(objectRoot);
    const spr = new Sprite(Texture.WHITE);
    spr.tint = 0xccc6bd;
    objectRoot.addChild(spr);
    spr.enableRenderGroup();
    prepareTree(stage, null, 1);
    console.log('engine2d vertex', (spr.groupColorAlpha >>> 0).toString(16));
    expect(spr.groupColorAlpha >>> 0).toBe(0x7fbdc6cc);
  });
});
