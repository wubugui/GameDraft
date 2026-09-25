import { describe, it, expect } from 'vitest';
import * as E from '../../../../src/engine2d';
import * as P from 'pixi.js';

function build(lib: any) {
  const layer = new lib.Container();
  const npc = new lib.Container();
  npc.addChild(new lib.Graphics().rect(0, 0, 10, 10).fill(0xffffff));
  layer.addChild(npc);
  npc.cullable = true;
  return { layer, npc };
}
const view = { x: 0, y: 0, width: 100, height: 100 };

// Mirrors Game.ts:10740-10741 per-frame shading loop skip test.
function drivenCount(layer: any) { let n = 0; for (const c of layer.children) { if (c.culled) continue; n++; } return n; }

describe('verify: culler on hidden entity', () => {
  it('master (pixi, visible=false) vs branch (engine2d, setActive(false))', () => {
    const p = build(P); P.Culler.shared.cull(p.layer, view);
    const e = build(E); E.Culler.shared.cull(e.layer, view);
    expect(p.npc.culled).toBe(false); expect(e.npc.culled).toBe(false);
    p.npc.visible = false; e.npc.setActive(false);
    for (let f = 0; f < 3; f++) { P.Culler.shared.cull(p.layer, view); E.Culler.shared.cull(e.layer, view); }
    console.log({ pixi: p.npc.culled, e2d: e.npc.culled, pixiDriven: drivenCount(p.layer), e2dDriven: drivenCount(e.layer) });
    expect(p.npc.culled).toBe(true);
    expect(e.npc.culled).toBe(false);
    expect(drivenCount(p.layer)).toBe(0);
    expect(drivenCount(e.layer)).toBe(1);
  });
  it('engine2d visible=false alone matches pixi (culler port itself fine)', () => {
    const e = build(E); E.Culler.shared.cull(e.layer, view);
    e.npc.visible = false; E.Culler.shared.cull(e.layer, view);
    console.log({ e2dVisibleFalse: e.npc.culled });
    expect(e.npc.culled).toBe(true);
  });
  it('reactivation: engine2d uncull same frame', () => {
    const e = build(E); E.Culler.shared.cull(e.layer, view);
    e.npc.setActive(false); E.Culler.shared.cull(e.layer, view);
    e.npc.setActive(true); E.Culler.shared.cull(e.layer, view);
    expect(e.npc.culled).toBe(false);
  });
});
