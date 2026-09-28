import * as PIXI from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { Container, Matrix, type Renderer } from '../../engine2d';
import { prepareTree } from '../../engine2d/gpu/collect';
import { ObjectExamineContactAoFilter } from './contactAo';

interface AoInternals {
  castRect: { x: number; y: number; w: number; h: number };
  maskScale: number;
  compositePass: { uniforms: { uniforms: { uMaskX: Float32Array; uMaskY: Float32Array } } };
}
const values = (m: Matrix | PIXI.Matrix) => [m.a, m.b, m.c, m.d, m.tx, m.ty];

describe('object-examine AO uses the same rendered frame as master', () => {
  it.each([false, true])('camera changes before bake (caster outside objectRoot=%s)', (detached) => {
    const ps = new PIXI.Container({ isRenderGroup: true });
    const es = new Container();
    const pc = ps.addChild(new PIXI.Container({ x: 512, y: 394, scale: 1.9754905477 }));
    const ec = es.addChild(new Container({ x: 512, y: 394, scale: 1.9754905477 }));
    const pRoot = pc.addChild(new PIXI.Container({ pivot: { x: 768, y: 384 } }));
    const eRoot = ec.addChild(new Container({ pivot: { x: 768, y: 384 } }));
    const pBody = (detached ? ps : pRoot).addChild(new PIXI.Container({ x: 20, y: 30 }));
    const eBody = (detached ? es : eRoot).addChild(new Container({ x: 20, y: 30 }));
    PIXI.updateRenderGroupTransforms(ps.renderGroup!, true);
    prepareTree(es, null, Container._nextRenderTick());
    pc.scale.set(1.9845289119); ec.scale.set(1.9845289119);
    pc.x = ec.x = 519;
    pBody.x = eBody.x = 25;
    const ao = new ObjectExamineContactAoFilter();
    try {
      ao.setCasters(eBody, []);
      ao.setPixelsPerCm(12);
      ao.setCastArea(0, 0, 1536, 768);
      const state = ao as unknown as AoInternals;
      const { x, y, w, h } = state.castRect;
      const expected = pRoot.worldTransform.clone().invert()
        .prepend(new PIXI.Matrix(1, 0, 0, 1, -x, -y))
        .prepend(new PIXI.Matrix(1 / w, 0, 0, 1 / h, 0, 0));
      const renders: { container: Container; transform?: Matrix }[] = [];
      const renderer = { render: (o: { container: Container; transform?: Matrix }) => {
        renders.push({ container: o.container, transform: o.transform?.clone() });
      } } as unknown as Renderer;
      ao.bake(renderer, eRoot);
      const u = state.compositePass.uniforms.uniforms;
      expect(Array.from(u.uMaskX)).toEqual(Array.from(new Float32Array([expected.a, expected.c, expected.tx, 0])));
      expect(Array.from(u.uMaskY)).toEqual(Array.from(new Float32Array([expected.b, expected.d, expected.ty, 0])));
      const casterExpected = detached
        ? pBody.worldTransform.clone().prepend(pRoot.worldTransform.clone().invert())
        : (pBody.updateLocalTransform(), pBody.localTransform.clone());
      casterExpected.prepend(new PIXI.Matrix(1, 0, 0, 1, -x, -y))
        .prepend(new PIXI.Matrix(state.maskScale, 0, 0, state.maskScale, 0, 0));
      expect(values(renders.find((o) => o.container === eBody)!.transform!)).toEqual(values(casterExpected));
    } finally {
      ao.destroy();
    }
  });
});
