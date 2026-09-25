/* eslint-disable @typescript-eslint/no-explicit-any */
import * as PIXI from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Sprite } from '../../../../src/engine2d/sprite/Sprite';
import { Texture } from '../../../../src/engine2d/textures/Texture';
import { Rectangle } from '../../../../src/engine2d/math/Rectangle';
import { Culler } from '../../../../src/engine2d/culling/Culler';

// Mirrors Game.updateFrustumCulling: children of entityLayer cullable, view = screen.clone().pad(w*m,h*m), default skipUpdateTransform.
function mkView() { return new Rectangle(0, 0, 800, 600).pad(800 * 0.25, 600 * 0.25); }

describe('verify: Culler on hidden(master)/inactive(branch) entity', () => {
  for (const startX of [2000, 400]) {
    it(`startX=${startX}`, () => {
      const view = mkView();
      const layer = new Container(); const npc = new Container(); const s = new Sprite(Texture.WHITE); s.width = 40; s.height = 80; npc.addChild(s); layer.addChild(npc);
      npc.cullable = true; npc.x = startX; Culler.shared.cull(layer, view);
      const e0 = npc.culled; npc.setActive(false); npc.x = 400; Culler.shared.cull(layer, view);
      const e1 = npc.culled; npc.x = 3000; Culler.shared.cull(layer, view); const e2 = npc.culled;

      const pl = new PIXI.Container(); const pn = new PIXI.Container(); const ps = new PIXI.Sprite(PIXI.Texture.WHITE); ps.width = 40; ps.height = 80; pn.addChild(ps); pl.addChild(pn);
      pn.cullable = true; pn.x = startX; (pl as any).updateTransform?.({}); PIXI.Culler.shared.cull(pl, view as any, false);
      const p0 = pn.culled; pn.visible = false; pn.x = 400; PIXI.Culler.shared.cull(pl, view as any, false);
      const p1 = pn.culled; pn.x = 3000; PIXI.Culler.shared.cull(pl, view as any, false); const p2 = pn.culled;
      // also with skipUpdateTransform=true (game default) on Pixi: invisible node early-returns so transform staleness irrelevant
      PIXI.Culler.shared.cull(pl, view as any); const p3 = pn.culled;
      console.log(JSON.stringify({ startX, e: [e0, e1, e2], p: [p0, p1, p2, p3] }));
      expect([e0, e1, e2]).toEqual([p0, p1, p2]);
    });
  }
});
