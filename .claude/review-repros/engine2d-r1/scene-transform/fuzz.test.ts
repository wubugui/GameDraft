/* eslint-disable @typescript-eslint/no-explicit-any */
import * as PIXI from 'pixi.js';
import { describe, expect, it } from 'vitest';
import * as E from '../../../../src/engine2d';
import { getLocalBounds as eGetLocalBounds } from '../../../../src/engine2d/scene/Container';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Pair = { p: any; e: any; kind: 'c' | 'g' };

function mkPair(r: () => number, log: { p: string[]; e: string[] }, id: number): Pair {
  let p: any;
  let e: any;
  let kind: 'c' | 'g';
  if (r() < 0.5) {
    const x = Math.round(r() * 40 - 20);
    const y = Math.round(r() * 40 - 20);
    const w = Math.round(r() * 30 + 1);
    const h = Math.round(r() * 30 + 1);
    p = new PIXI.Graphics().rect(x, y, w, h).fill(0xffffff);
    e = new E.Graphics().rect(x, y, w, h).fill(0xffffff);
    kind = 'g';
  } else {
    p = new PIXI.Container();
    e = new E.Container();
    kind = 'c';
  }
  p.label = e.label = `n${id}`;
  for (const ev of ['added', 'removed', 'childAdded', 'childRemoved', 'destroyed']) {
    p.on(ev, (a: any, b: any, c: any) => log.p.push(`${id}:${ev}:${a?.label ?? ''}:${b?.label ?? ''}:${c ?? ''}`));
    e.on(ev, (a: any, b: any, c: any) => log.e.push(`${id}:${ev}:${a?.label ?? ''}:${b?.label ?? ''}:${c ?? ''}`));
  }
  return { p, e, kind };
}

function b2a(b: any): number[] {
  return [b.minX, b.minY, b.maxX, b.maxY];
}

function closeArr(a: number[], b: number[], msg: string): void {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) {
    const ok = a[i] === b[i] || Math.abs(a[i] - b[i]) < 1e-9 || (Number.isNaN(a[i]) && Number.isNaN(b[i]));
    if (!ok) throw new Error(`${msg}: [${a}] vs [${b}]`);
  }
}

describe('scene-transform fuzz vs pixi', () => {
  for (let seed = 1; seed <= 1500; seed++) {
    it(`seed ${seed}`, () => {
      const r = rng(seed);
      const log = { p: [] as string[], e: [] as string[] };
      const nodes: Pair[] = [];
      const root = mkPair(r, log, 0);
      if (root.kind === 'g') { /* ok */ }
      nodes.push(root);
      let id = 1;
      const pick = (): Pair => nodes[Math.floor(r() * nodes.length)];
      const ops: string[] = [];
      for (let step = 0; step < 60; step++) {
        const op = Math.floor(r() * 23);
        if (!nodes.length) break;
        const a = pick();
        const v = Math.round((r() * 4 - 2) * 100) / 100;
        const opName = `${op}@${nodes.indexOf(a)} v=${v}`;
        ops.push(opName);
        try {
          switch (op) {
            case 0: {
              // add a new node under a container-ish node
              const c = mkPair(r, log, id++);
              nodes.push(c);
              const par = nodes.filter((n) => n.kind === 'c')[Math.floor(r() * nodes.filter((n) => n.kind === 'c').length)];
              if (par && par !== c) { par.p.addChild(c.p); par.e.addChild(c.e); }
              break;
            }
            case 1: a.p.x = v * 10; a.e.x = v * 10; break;
            case 2: a.p.position.set(v * 5, -v * 3); a.e.position.set(v * 5, -v * 3); break;
            case 3: a.p.scale.set(v); a.e.scale.set(v); break;
            case 4: a.p.scale = { x: v, y: 1.5 }; a.e.scale = { x: v, y: 1.5 }; break;
            case 5: a.p.rotation = v; a.e.rotation = v; break;
            case 6: a.p.angle = v * 45; a.e.angle = v * 45; break;
            case 7: a.p.skew.set(v * 0.2, -v * 0.1); a.e.skew.set(v * 0.2, -v * 0.1); break;
            case 8: a.p.pivot.set(v * 7, v * 3); a.e.pivot.set(v * 7, v * 3); break;
            case 9: a.p.visible = v > 0; a.e.visible = v > 0; a.p._didViewChangeTick++; a.e._didViewChangeTick++; break;
            case 10: a.p.width = Math.abs(v) * 20; a.e.width = Math.abs(v) * 20; break;
            case 11: a.p.height = Math.abs(v) * 20; a.e.height = Math.abs(v) * 20; break;
            case 12: {
              const m = new PIXI.Matrix(1.1, v * 0.1, -v * 0.2, 0.9, v * 3, 5);
              const me = new E.Matrix(1.1, v * 0.1, -v * 0.2, 0.9, v * 3, 5);
              a.p.setFromMatrix(m); a.e.setFromMatrix(me); break;
            }
            case 13: {
              // reparentChild into a container not in a's subtree
              const cands = nodes.filter((n) => n.kind === 'c' && n !== a && !isAncestorP(a.p, n.p));
              const t = cands[Math.floor(r() * cands.length)];
              if (t && a.p.parent && a.p.parent !== t.p) { t.p.addChild(a.p); t.e.addChild(a.e); }
              break;
            }
            case 14: {
              if (a.p.children.length >= 2) {
                const i1 = Math.floor(r() * a.p.children.length);
                const i2 = Math.floor(r() * a.p.children.length);
                a.p.swapChildren(a.p.children[i1], a.p.children[i2]);
                a.e.swapChildren(a.e.children[i1], a.e.children[i2]);
              }
              break;
            }
            case 15: {
              if (a.p.children.length >= 1) {
                const i1 = Math.floor(r() * a.p.children.length);
                const i2 = Math.floor(r() * a.p.children.length);
                a.p.setChildIndex(a.p.children[i1], i2);
                a.e.setChildIndex(a.e.children[i1], i2);
              }
              break;
            }
            case 16: {
              a.p.zIndex = Math.round(v); a.e.zIndex = Math.round(v);
              break;
            }
            case 17: {
              a.p.sortChildren(); a.e.sortChildren();
              break;
            }
            case 18: {
              // move a node to a different parent via addChildAt
              const cands = nodes.filter((n) => n.kind === 'c' && n !== a && !isAncestorP(a.p, n.p));
              const t = cands[Math.floor(r() * cands.length)];
              if (t) {
                const idx = Math.floor(r() * (t.p.children.length + 1));
                const ip = t.p.children.includes(a.p) ? Math.min(idx, t.p.children.length - 1) : idx;
                t.p.addChildAt(a.p, ip); t.e.addChildAt(a.e, ip);
              }
              break;
            }
            case 19: {
              // mask: use a graphics sibling/any other graphics node
              const gs = nodes.filter((n) => n.kind === 'g' && n !== a && !isAncestorP(n.p, a.p));
              const m = gs[Math.floor(r() * gs.length)];
              if (v > 0 && m && !m.p.mask && !nodes.some((q) => q.p.mask === a.p) && !nodes.some((q) => q.p.mask === m.p)) {
                a.p.mask = m.p; a.e.mask = m.e;
              } else { a.p.mask = null; a.e.mask = null; }
              for (let q: any = a.p; q; q = q.parent) q._didViewChangeTick++;
              for (let q: any = a.e; q; q = q.parent) q._didViewChangeTick++;
              break;
            }
            case 20: {
              if (v > 0) { a.p.boundsArea = new PIXI.Rectangle(-5, -5, 10 * v, 10); a.e.boundsArea = new E.Rectangle(-5, -5, 10 * v, 10); }
              else { a.p.boundsArea = undefined; a.e.boundsArea = undefined; }
              for (let q: any = a.p; q; q = q.parent) q._didViewChangeTick++;
              for (let q: any = a.e; q; q = q.parent) q._didViewChangeTick++;
              break;
            }
            case 22: {
              if (a !== root && !isAncestorP(a.p, root.p) && r() < 0.5) {
                const opt = r() < 0.5 ? { children: true } : false;
                const dead = new Set<any>();
                const walk = (q: any) => { dead.add(q); if (opt) for (const ch of q.children) walk(ch); };
                walk(a.p);
                // masks referencing destroyed nodes: clear first on both
                for (const q of nodes) if (dead.has(q.p.mask) || (dead.has(q.p) && q.p.mask)) { q.p.mask = null; q.e.mask = null; }
                a.p.destroy(opt); a.e.destroy(opt);
                for (let qi = nodes.length - 1; qi >= 0; qi--) if (dead.has(nodes[qi].p)) nodes.splice(qi, 1);
              }
              break;
            }
            case 21: {
              a.p.origin.set(v * 4, -v * 2); a.e.origin.set(v * 4, -v * 2); break;
            }
          }
        } catch (err) {
          throw new Error(`op ${opName} threw: ${(err as Error).message}`);
        }
        // compare
        for (let k = 0; k < nodes.length; k++) {
          const n = nodes[k];
          if (r() < 0.6) continue;
          const ctx = `seed ${seed} step ${step} op ${opName} node ${k} ops=${ops.join(',')}`;
          expect(n.e.children.map((c: any) => c.label), ctx).toEqual(n.p.children.map((c: any) => c.label));
          expect(n.e.parent?.label ?? null, ctx).toBe(n.p.parent?.label ?? null);
          try { const eb = b2a(n.e.getLocalBounds()); try { closeArr(eb, b2a(n.p.getLocalBounds()), 'x'); } catch { closeArr(eb, b2a((PIXI as any).getLocalBounds(n.p, new PIXI.Bounds())), `localBounds ${ctx}`); } } catch (err) {
            const fresh = b2a((PIXI as any).getLocalBounds(n.p, new PIXI.Bounds()));
            const efresh = b2a(eGetLocalBounds(n.e, new E.Bounds()));
            const dump = (x: any) => nodes.map((q, qi) => `${qi}:${q.kind}:${x(q).label} par=${x(q).parent?.label} mask=${x(q).mask?.label} meas=${x(q).measurable} vis=${x(q).visible} eff=${x(q).effects.length} ticks=${x(q)._didViewChangeTick}/${x(q)._didContainerChangeTick}`).join('\n');
            throw new Error((err as Error).message.split(" ops=")[0] + " :: " + (err as Error).message.slice(-160) + ` pixiFresh=${fresh} eFresh=${efresh}` + '\nPIXI\n' + dump((q: any) => q.p) + '\nE\n' + dump((q: any) => q.e));
          }
          try { closeArr(b2a(n.e.getBounds()), b2a(n.p.getBounds()), `bounds ${ctx}`); } catch (err) {
            const dump = (x: any) => nodes.map((q, qi) => `${qi}:${q.kind}:${x(q).label} par=${x(q).parent?.label} mask=${x(q).mask?.label} meas=${x(q).measurable} vis=${x(q).visible} eff=${x(q).effects.length}`).join('\n');
            throw new Error((err as Error).message + '\nPIXI\n' + dump((q: any) => q.p) + '\nE\n' + dump((q: any) => q.e));
          }
          const pg = n.p.getGlobalTransform(new PIXI.Matrix(), false);
          const eg = n.e.getGlobalTransform(new E.Matrix(), false);
          closeArr([eg.a, eg.b, eg.c, eg.d, eg.tx, eg.ty], [pg.a, pg.b, pg.c, pg.d, pg.tx, pg.ty], `gt ${ctx}`);
          const tp = { x: 3.5, y: -2 };
          const pgp = n.p.toGlobal(tp);
          const egp = n.e.toGlobal(tp);
          closeArr([egp.x, egp.y], [pgp.x, pgp.y], `toGlobal ${ctx}`);
          const plp = n.p.toLocal(tp, nodes[0].p);
          const elp = n.e.toLocal(tp, nodes[0].e);
          closeArr([elp.x, elp.y], [plp.x, plp.y], `toLocal ${ctx}`);
          { try { closeArr([n.e.width, n.e.height], [n.p.width, n.p.height], 'x'); } catch { const fb = (PIXI as any).getLocalBounds(n.p, new PIXI.Bounds()); closeArr([n.e.width, n.e.height], [Math.abs(n.p.scale.x * fb.width), Math.abs(n.p.scale.y * fb.height)], `size ${ctx}`); } }
          const pp = n.p.getGlobalPosition();
          const ep = n.e.getGlobalPosition();
          closeArr([ep.x, ep.y], [pp.x, pp.y], `gpos ${ctx}`);
          expect(n.e.sortDirty, ctx).toBe(n.p.sortDirty);
          expect(n.e.sortableChildren, ctx).toBe(n.p.sortableChildren);
        }
        expect(log.e).toEqual(log.p);
      }
      // destroy root with children
      root.p.destroy({ children: true });
      root.e.destroy({ children: true });
      expect(log.e).toEqual(log.p);
    });
  }
});

function isAncestorP(maybeAncestor: any, node: any): boolean {
  for (let c = node; c; c = c.parent) if (c === maybeAncestor) return true;
  return false;
}
