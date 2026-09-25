import { describe, it, expect } from 'vitest';
import * as P from 'pixi.js';
import { Sprite as ESprite } from '../../../../src/engine2d/sprite/Sprite';
import { Texture as ETexture } from '../../../../src/engine2d/textures/Texture';

describe('Sprite anchor ctor', () => {
  it('anchor:0 with defaultAnchor', () => {
    const pt = new P.Texture({ source: P.Texture.WHITE.source, defaultAnchor: { x: 0.5, y: 1 } });
    const ps = new P.Sprite({ texture: pt, anchor: 0 });
    const et = new ETexture({ source: (ETexture as any).WHITE.source, defaultAnchor: { x: 0.5, y: 1 } } as any);
    const es = new ESprite({ texture: et, anchor: 0 });
    console.log('pixi', ps.anchor.x, ps.anchor.y, 'engine2d', es.anchor.x, es.anchor.y);
    expect([ps.anchor.x, ps.anchor.y]).toEqual([0.5, 1]);
    expect([es.anchor.x, es.anchor.y]).toEqual([0, 0]);
  });
  it('anchor:null', () => {
    let pErr: unknown = null, eErr: unknown = null;
    try { new P.Sprite({ texture: P.Texture.WHITE, anchor: null as any }); } catch (e) { pErr = e; }
    try { new ESprite({ texture: (ETexture as any).WHITE, anchor: null as any }); } catch (e) { eErr = e; }
    console.log('pixi err', String(pErr), 'engine2d err', String(eErr));
    expect(pErr).toBeNull();
    expect(eErr).toBeInstanceOf(TypeError);
  });
});
