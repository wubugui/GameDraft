/* eslint-disable @typescript-eslint/no-explicit-any */
import * as PIXI from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Sprite } from '../../../../src/engine2d/sprite/Sprite';
import { Texture } from '../../../../src/engine2d/textures/Texture';
import { Rectangle } from '../../../../src/engine2d/math/Rectangle';
import { Culler } from '../../../../src/engine2d/culling/Culler';

describe('Culler: hidden entity (master visible=false) vs inactive (branch setActive(false))', () => {
  it('culled flag after hide', () => {
    const view = new Rectangle(0, 0, 800, 600).pad(80, 60);
    // engine2d
    const layer = new Container(); const npc = new Container(); const s = new Sprite(Texture.WHITE); s.width = 40; s.height = 80; npc.addChild(s); layer.addChild(npc);
    npc.cullable = true; npc.x = 2000; Culler.shared.cull(layer, view);
    const e0 = npc.culled; npc.setActive(false); npc.x = 400; Culler.shared.cull(layer, view);
    const e1 = npc.culled;
    // pixi
    const pl = new PIXI.Container({ isRenderGroup: true }); const pn = new PIXI.Container(); const ps = new PIXI.Sprite(PIXI.Texture.WHITE); ps.width = 40; ps.height = 80; pn.addChild(ps); pl.addChild(pn);
    pn.cullable = true; pn.x = 2000; PIXI.Culler.shared.cull(pl, view as any, false);
    const p0 = pn.culled; pn.visible = false; pn.x = 400; PIXI.Culler.shared.cull(pl, view as any, false);
    const p1 = pn.culled;
    console.log({ e0, e1, p0, p1 });
    expect([e0, e1]).toEqual([p0, p1]);
  });
});
