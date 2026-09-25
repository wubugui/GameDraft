import { describe, it, expect } from 'vitest';
import { EventEmitter as E2 } from '../../../../src/engine2d/utils/EventEmitter';
import EE3 from 'eventemitter3';
import { Container as PixiContainer } from 'pixi.js';
import { Container as E2Container } from '../../../../src/engine2d';

function run(em: any, ctx: unknown, n = 1) {
  let calls = 0;
  const fn = () => { calls++; };
  for (let i = 0; i < n; i++) em.on('x', fn);
  em.off('x', fn, ctx);
  em.emit('x');
  return calls;
}
describe('off(event, fn, falsy ctx)', () => {
  for (const ctx of [null, 0, '', false]) {
    it(`ctx=${JSON.stringify(ctx)}`, () => {
      const r = {
        ee3_single: run(new EE3(), ctx), e2_single: run(new E2(), ctx),
        ee3_multi: run(new EE3(), ctx, 2), e2_multi: run(new E2(), ctx, 2),
        pixiC: run(new PixiContainer(), ctx), e2C: run(new E2Container(), ctx),
      };
      console.log(JSON.stringify(ctx), JSON.stringify(r));
      expect(r.e2_single).toBe(r.ee3_single);
    });
  }
});
