import { describe, it, expect } from 'vitest';
import * as P from 'pixi.js';
import * as E from '../../../../src/engine2d';
const r = () => (Math.random() - 0.5) * 10;
describe('math parity', () => {
  it('Matrix ops', () => {
    for (let k = 0; k < 200; k++) {
      const v = [r(), r(), r(), r(), r(), r()];
      const w = [r(), r(), r(), r(), r(), r()];
      const pa = new P.Matrix(...v), ea = new E.Matrix(...v);
      const pb = new P.Matrix(...w), eb = new E.Matrix(...w);
      const ops: [string, (m: any, o: any) => any][] = [
        ['append', (m, o) => m.append(o)], ['prepend', (m, o) => m.prepend(o)], ['invert', (m) => m.invert()],
        ['appendFrom', (m, o) => m.appendFrom(o, m.clone())], ['translate', (m) => m.translate(1.5, -2)], ['scale', (m) => m.scale(2, 0.5)], ['rotate', (m) => m.rotate(0.3)],
      ];
      for (const [name, op] of ops) {
        const p = op(pa.clone(), pb), e = op(ea.clone(), eb);
        for (const f of ['a', 'b', 'c', 'd', 'tx', 'ty']) expect(e[f], name + f).toBe(p[f]);
      }
      const pt = { x: r(), y: r() };
      const pp = pa.apply(pt), ep = ea.apply(pt);
      expect([ep.x, ep.y]).toEqual([pp.x, pp.y]);
      const pi = pa.applyInverse(pt), ei = ea.applyInverse(pt);
      expect([ei.x, ei.y]).toEqual([pi.x, pi.y]);
      const pc = new P.Container(), ec = new E.Container();
      pa.decompose(pc as any); ea.decompose(ec as any);
      for (const f of ['x', 'y', 'rotation']) expect((ec as any)[f], 'decompose ' + f).toBe((pc as any)[f]);
      expect([ec.scale.x, ec.scale.y, ec.skew.x, ec.skew.y, ec.pivot.x]).toEqual([pc.scale.x, pc.scale.y, pc.skew.x, pc.skew.y, pc.pivot.x]);
    }
  });
  it('Rectangle ops', () => {
    for (let k = 0; k < 200; k++) {
      const v = [r(), r(), Math.abs(r()), Math.abs(r())];
      const w = [r(), r(), Math.abs(r()), Math.abs(r())];
      const pa = new P.Rectangle(...v), ea = new E.Rectangle(...v);
      const pb = new P.Rectangle(...w), eb = new E.Rectangle(...w);
      const x = r(), y = r();
      expect(ea.contains(x, y)).toBe(pa.contains(x, y));
      expect(ea.intersects(eb as any)).toBe(pa.intersects(pb));
      const m = [r(), r(), r(), r(), r(), r()];
      expect(ea.intersects(eb as any, new E.Matrix(...m) as any)).toBe(pa.intersects(pb, new P.Matrix(...m)));
      const f = (o: any) => [o.x, o.y, o.width, o.height];
      expect(f(ea.clone().pad(1.5, 2))).toEqual(f(pa.clone().pad(1.5, 2)));
      expect(f(ea.clone().fit(eb as any))).toEqual(f(pa.clone().fit(pb)));
      expect(f(ea.clone().enlarge(eb as any))).toEqual(f(pa.clone().enlarge(pb)));
      expect(f(ea.clone().ceil(2))).toEqual(f(pa.clone().ceil(2)));
      expect(ea.containsRect(eb as any)).toBe(pa.containsRect(pb));
      expect(ea.strokeContains(x, y, 2)).toBe(pa.strokeContains(x, y, 2));
      const pc = new P.Circle(v[0], v[1], v[2]), ec = new E.Circle(v[0], v[1], v[2]);
      expect(ec.contains(x, y)).toBe(pc.contains(x, y));
    }
  });
});
