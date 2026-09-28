import * as PIXI from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { prepareTree } from '../gpu/collect';
import { Matrix } from '../math/Matrix';
import { Container } from './Container';

const values = (m: Matrix | PIXI.Matrix) => [m.a, m.b, m.c, m.d, m.tx, m.ty];

describe('getGlobalTransform skipUpdate uses Pixi render history', () => {
  it('reads the last rendered camera matrix without changing current transform queries', () => {
    const ps = new PIXI.Container({ isRenderGroup: true });
    const es = new Container();
    const pc = ps.addChild(new PIXI.Container({ x: 40, scale: 0.8 }));
    const ec = es.addChild(new Container({ x: 40, scale: 0.8 }));
    const p = pc.addChild(new PIXI.Container({ x: -25, y: 12 }));
    const e = ec.addChild(new Container({ x: -25, y: 12 }));
    PIXI.updateRenderGroupTransforms(ps.renderGroup!, true);
    prepareTree(es, null, Container._nextRenderTick());
    pc.scale.set(1.7); ec.scale.set(1.7);
    pc.x = ec.x = 60;
    const out = new Matrix();
    expect(e.getGlobalTransform(out, true)).toBe(out);
    expect(values(out)).toEqual(values(p.getGlobalTransform(new PIXI.Matrix(), true)));
    expect(values(e.getGlobalTransform())).toEqual(values(p.getGlobalTransform()));
    expect(values(e.worldTransform)).toEqual(values(p.getGlobalTransform()));
    out.tx = 999;
    expect(values(e.getGlobalTransform(undefined, true))).toEqual(values(p.worldTransform));
    PIXI.updateRenderGroupTransforms(ps.renderGroup!, true);
    prepareTree(es, null, Container._nextRenderTick());
    expect(values(e.getGlobalTransform(undefined, true))).toEqual(values(p.worldTransform));
  });

  it('preserves the explicit render-root matrix while default queries follow its parent', () => {
    const stage = new Container({ x: 1000 });
    const child = stage.addChild(new Container({ x: 50 }));
    prepareTree(stage, null, Container._nextRenderTick());
    prepareTree(child, null, Container._nextRenderTick(), new Matrix(0.5, 0, 0, 0.5, 30, 40));
    expect(values(child.getGlobalTransform(undefined, true))).toEqual([0.5, 0, 0, 0.5, 30, 40]);
    expect(child.getGlobalTransform().tx).toBe(1050);
    expect(child.worldTransform.tx).toBe(1050);
  });
});
