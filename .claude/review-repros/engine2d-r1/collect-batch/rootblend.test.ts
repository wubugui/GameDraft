import { describe, expect, it } from 'vitest';
import * as P from 'pixi.js';
import { Sprite, Texture } from '../../../../src/engine2d';
import { prepareTree } from '../../../../src/engine2d/gpu/collect';

describe('detached render root with its own blendMode / tint', () => {
  it('pixi: root groupBlendMode / groupColorAlpha never updated for a detached root', () => {
    const spr = new P.Sprite(P.Texture.WHITE);
    spr.blendMode = 'add';
    spr.alpha = 0.5;
    spr.enableRenderGroup();
    P.updateRenderGroupTransforms(spr.renderGroup!, true);
    console.log('pixi root groupBlendMode', spr.groupBlendMode, 'groupColorAlpha', (spr.groupColorAlpha >>> 0).toString(16),
      'rg.worldColorAlpha', (spr.renderGroup!.worldColorAlpha >>> 0).toString(16));
    expect(spr.groupBlendMode).toBe('normal');
  });
  it('engine2d: root groupBlendMode follows localBlendMode', () => {
    const spr = new Sprite(Texture.WHITE);
    spr.blendMode = 'add';
    spr.alpha = 0.5;
    prepareTree(spr, null, 1);
    console.log('engine2d root groupBlendMode', spr.groupBlendMode, (spr.groupColorAlpha >>> 0).toString(16));
    expect(spr.groupBlendMode).toBe('add');
  });
});
