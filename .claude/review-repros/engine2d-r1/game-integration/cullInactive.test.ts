import { describe, it, expect } from 'vitest';
import * as E from '../../../../src/engine2d';
import * as P from 'pixi.js';

function build(lib: any) {
  const layer = new lib.Container();
  const npc = new lib.Container();
  const g = new lib.Graphics().rect(0, 0, 10, 10).fill(0xffffff);
  npc.addChild(g);
  npc.cullable = true;
  layer.addChild(npc);
  return { layer, npc };
}

describe('culler on hidden npc', () => {
  it('pixi visible=false => culled true; engine2d setActive(false) => stale', () => {
    const view = { x: 0, y: 0, width: 100, height: 100 };
    const p = build(P);
    P.Culler.shared.cull(p.layer, view);
    expect(p.npc.culled).toBe(false);
    p.npc.visible = false;
    P.Culler.shared.cull(p.layer, view);
    const pixiCulled = p.npc.culled;

    const e = build(E);
    E.Culler.shared.cull(e.layer, view);
    expect(e.npc.culled).toBe(false);
    e.npc.setActive(false);
    E.Culler.shared.cull(e.layer, view);
    const e2dCulled = e.npc.culled;
    // eslint-disable-next-line no-console
    console.log({ pixiCulled, e2dCulled });
    expect(pixiCulled).toBe(true);
    expect(e2dCulled).toBe(false);
  });
});
