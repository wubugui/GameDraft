import { describe, expect, it } from 'vitest';
import * as PIXI from 'pixi.js';
import { SpritePipe } from 'pixi.js';
import { Sprite } from '../../../../src/engine2d/sprite/Sprite';
import { Texture } from '../../../../src/engine2d/textures/Texture';
import { TextureSource } from '../../../../src/engine2d/textures/TextureSource';

describe('roundPixels toggled after first render', () => {
  it('pixi freezes, engine2d follows', () => {
    const added: any[] = [];
    const renderer: any = { uid: 1, _roundPixels: 0, renderPipes: { batch: { addToBatch: (b: any) => added.push(b.roundPixels) } } };
    const pipe = new (SpritePipe as any)(renderer);
    const ps = new PIXI.Sprite(new PIXI.Texture({ source: new PIXI.TextureSource({ width: 8, height: 8 }) }));
    pipe.addRenderable(ps, {});           // frame 1 (during scene load)
    ps.roundPixels = true;                // Game.syncEntityPixelDensityMatch -> Hotspot.applyEntityPixelDensityMatch
    ps.didViewUpdate = true;
    pipe.addRenderable(ps, {});           // later frames
    const mine: number[] = [];
    const collector: any = { addBatchable: (b: any) => mine.push(b.roundPixels) };
    const ms = new Sprite(new Texture({ source: new TextureSource({ width: 8, height: 8 }) }));
    ms.collectRenderables(collector);
    ms.roundPixels = true;
    ms.collectRenderables(collector);
    console.log('pixi', added, 'engine2d', mine);
    expect(added).toEqual([0, 0]);
    expect(mine).toEqual([0, 1]);
  });
});
