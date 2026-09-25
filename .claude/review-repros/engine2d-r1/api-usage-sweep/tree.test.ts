import { describe, it, expect } from 'vitest';
import * as P from 'pixi.js';
import * as E from '../../../../src/engine2d';
let seed = 12345;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const r = (s = 10) => (rnd() - 0.5) * s;
function build(lib: any, texP: any, depth: number, rec: any[], seedBase: number): any {
  seed = seedBase;
  const make = (d: number): any => {
    const kind = rnd();
    let n: any;
    if (d > 0 && kind < 0.4) n = new lib.Container();
    else if (kind < 0.7) { n = new lib.Sprite(texP); n.anchor.set(rnd(), rnd()); }
    else { n = new lib.Graphics(); const t = rnd(); if (t < 0.33) n.rect(r(), r(), 1 + rnd() * 5, 1 + rnd() * 5).fill(0xff0000); else if (t < 0.66) n.circle(r(), r(), 1 + rnd() * 5).stroke({ width: 1 + rnd() * 3, color: 0 }); else n.roundRect(r(), r(), 2 + rnd() * 5, 2 + rnd() * 5, 1).fill(0x00ff00).stroke({ width: 2, color: 0 }); }
    n.position.set(r(100), r(100));
    if (rnd() < 0.5) n.scale.set(0.2 + rnd() * 2, rnd() < 0.2 ? -1 : 0.2 + rnd() * 2);
    if (rnd() < 0.5) n.rotation = r(6);
    if (rnd() < 0.3) n.skew.set(r(0.5), r(0.5));
    if (rnd() < 0.3) n.pivot.set(r(10), r(10));
    if (rnd() < 0.15) n.visible = false;
    if (rnd() < 0.1) n.alpha = 0;
    rec.push(n);
    if (n instanceof lib.Container && !(n instanceof lib.Sprite) && !(n instanceof lib.Graphics)) {
      const k = 1 + Math.floor(rnd() * 4);
      for (let i = 0; i < k; i++) n.addChild(make(d - 1));
    }
    return n;
  };
  const root = new lib.Container();
  const k = 3;
  for (let i = 0; i < k; i++) root.addChild(make(depth));
  rec.unshift(root);
  return root;
}
describe('tree parity', () => {
  it('bounds + transforms', () => {
    const pTex = new P.Texture({ source: new P.TextureSource({ width: 13, height: 7 }) });
    const eTex = new E.Texture({ source: new E.TextureSource({ width: 13, height: 7 }) });
    let bad = 0;
    for (let trial = 0; trial < 60; trial++) {
      const pr: any[] = [], er: any[] = [];
      build(P, pTex, 3, pr, 1000 + trial);
      build(E, eTex, 3, er, 1000 + trial);
      expect(er.length).toBe(pr.length);
      for (let i = 0; i < pr.length; i++) {
        const pb = pr[i].getBounds(), eb = er[i].getBounds();
        const pl = pr[i].getLocalBounds(), el = er[i].getLocalBounds();
        const f = (b: any) => [b.minX, b.minY, b.maxX, b.maxY].map((v: number) => +v.toFixed(6));
        if (JSON.stringify(f(pb)) !== JSON.stringify(f(eb)) || JSON.stringify(f(pl)) !== JSON.stringify(f(el))) {
          if (bad++ < 5) console.log('trial', trial, 'node', i, pr[i].constructor.name, 'global', f(pb), f(eb), 'local', f(pl), f(el));
        }
        const pt = { x: 3.3, y: -1.7 };
        const pg = pr[i].toGlobal(pt), eg = er[i].toGlobal(pt);
        expect([eg.x, eg.y]).toEqual([pg.x, pg.y]);
        const pl2 = pr[i].toLocal(pt), el2 = er[i].toLocal(pt);
        expect([el2.x, el2.y]).toEqual([pl2.x, pl2.y]);
        expect(er[i].width).toBeCloseTo(pr[i].width, 9);
        expect(er[i].height).toBeCloseTo(pr[i].height, 9);
      }
    }
    console.log('bounds mismatches', bad);
  });
});
