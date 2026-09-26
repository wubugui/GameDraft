import * as PIXI from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Graphics } from '../../../../src/engine2d/graphics/Graphics';

let seed = 999;
function rnd(): number { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function ri(n: number): number { return Math.floor(rnd() * n); }

describe('mutation differential', () => {
  it('random mutations keep worldTransform/bounds equal', () => {
    const fails: string[] = [];
    for (let iter = 0; iter < 200; iter++) {
      const pn: PIXI.Container[] = [];
      const en: Container[] = [];
      const pRoot = new PIXI.Container();
      const eRoot = new Container();
      pn.push(pRoot); en.push(eRoot);
      for (let i = 0; i < 12; i++) {
        const leaf = rnd() < 0.5;
        const p = leaf ? new PIXI.Graphics().rect(0, 0, 5 + ri(20), 5 + ri(20)).fill(0xffffff) : new PIXI.Container();
        const e = leaf ? new Graphics().rect(0, 0, (p as PIXI.Graphics).width, (p as PIXI.Graphics).height).fill(0xffffff) : new Container();
        const parentIdx = ri(pn.length);
        let pp = pn[parentIdx]; let ep = en[parentIdx];
        // graphics can't have children in engine2d? both allowChildren false only warns
        if (pp instanceof PIXI.Graphics) { pp = pRoot; ep = eRoot; }
        pp.addChild(p); ep.addChild(e);
        pn.push(p); en.push(e);
      }
      for (let step = 0; step < 30; step++) {
        const k = 1 + ri(pn.length - 1);
        const p = pn[k]; const e = en[k];
        const op = ri(9);
        const v = (rnd() - 0.5) * 50;
        switch (op) {
          case 0: p.x = v; e.x = v; break;
          case 1: p.scale.set(0.5 + rnd()); e.scale.set(p.scale.x); break;
          case 2: p.rotation = v / 10; e.rotation = v / 10; break;
          case 3: p.pivot.y = v; e.pivot.y = v; break;
          case 4: p.origin.set(v, -v); e.origin.set(v, -v); break;
          case 5: p.skew.x = v / 100; e.skew.x = v / 100; break;
          case 6: { // reparent to a random container (non-graphics, not descendant)
            const j = ri(pn.length);
            let tp = pn[j]; let te = en[j];
            if (tp instanceof PIXI.Graphics) break;
            // avoid cycles
            let a: PIXI.Container | null = tp; let cyc = false;
            while (a) { if (a === p) { cyc = true; break; } a = a.parent; }
            if (cyc) break;
            tp.addChild(p); te.addChild(e);
            break;
          }
          case 7: p.angle = v; e.angle = v; break;
          case 8: p.position.set(v, v * 2); e.position.set(v, v * 2); break;
        }
        // read after each mutation
        const q = 1 + ri(pn.length - 1);
        const pg = pn[q].toGlobal({ x: 1, y: 2 });
        const eg = en[q].toGlobal({ x: 1, y: 2 });
        if (Math.abs(pg.x - eg.x) > 1e-6 || Math.abs(pg.y - eg.y) > 1e-6) fails.push(`it${iter} s${step} toGlobal ${pg.x},${pg.y} vs ${eg.x},${eg.y}`);
        const pb = pn[q].getBounds(); const eb = en[q].getBounds();
        if (Math.abs(pb.x - eb.x) > 1e-6 || Math.abs(pb.width - eb.width) > 1e-6 || Math.abs(pb.y - eb.y) > 1e-6) fails.push(`it${iter} s${step} bounds`);
        const pl = pRoot.getLocalBounds(); const el = eRoot.getLocalBounds();
        if (Math.abs(pl.x - el.x) > 1e-6 || Math.abs(pl.width - el.width) > 1e-6) fails.push(`it${iter} s${step} rootLocal`);
      }
    }
    console.log(fails.slice(0, 20).join('\n'));
    expect(fails.length).toBe(0);
  });
});
