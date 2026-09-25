import { describe, expect, it } from 'vitest';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Matrix } from '../../../../src/engine2d/math/Matrix';

function brute(c: Container): Matrix {
  const chain: Container[] = [];
  for (let p: Container | null = c; p; p = p.parent) chain.push(p);
  const m = new Matrix();
  for (let i = chain.length - 1; i >= 0; i--) {
    chain[i].updateLocalTransform();
    const t = new Matrix().appendFrom(chain[i].localTransform, m);
    m.copyFrom(t);
  }
  return m;
}

describe('world cache fuzz', () => {
  it('matches brute force', () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const nodes: Container[] = [];
    for (let i = 0; i < 12; i++) nodes.push(new Container());
    let bad = 0;
    for (let step = 0; step < 20000; step++) {
      const n = nodes[(rnd() * nodes.length) | 0];
      const op = (rnd() * 9) | 0;
      if (op === 0) n.x = rnd() * 100 - 50;
      else if (op === 1) n.rotation = rnd() * 6;
      else if (op === 2) n.scale.set(rnd() * 2 - 1, rnd() * 2);
      else if (op === 3) n.pivot.set(rnd() * 10, rnd() * 10);
      else if (op === 4) n.skew.set(rnd() * 0.5, rnd() * 0.5);
      else if (op === 5) {
        const p = nodes[(rnd() * nodes.length) | 0];
        // avoid cycles
        let ok = p !== n;
        for (let q: Container | null = p; q && ok; q = q.parent) if (q === n) ok = false;
        if (ok) p.addChild(n);
      } else if (op === 6) n.removeFromParent();
      else if (op === 7) n.setActive(rnd() < 0.5);
      else {
        const r = nodes[(rnd() * nodes.length) | 0];
        const a = r.worldTransform; const b = brute(r);
        if (a.a !== b.a || a.b !== b.b || a.c !== b.c || a.d !== b.d || a.tx !== b.tx || a.ty !== b.ty) bad++;
        const gp = r.toGlobal({ x: 3, y: 4 }); const bp = b.apply({ x: 3, y: 4 });
        if (gp.x !== bp.x || gp.y !== bp.y) bad++;
      }
    }
    expect(bad).toBe(0);
  });
});
