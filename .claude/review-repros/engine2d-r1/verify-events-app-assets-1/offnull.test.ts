import { describe, it, expect } from 'vitest';
import EE3 from 'eventemitter3';
import { Container as PixiContainer } from 'pixi.js';
import { EventEmitter } from '../../../../src/engine2d/utils/EventEmitter';

function run(em: any) {
  let calls = 0;
  const f = () => { calls++; };
  em.on('x', f);
  em.off('x', f, null);
  const count = em.listenerCount('x');
  em.emit('x');
  return { count, calls };
}
function runMulti(em: any) {
  let calls = 0;
  const f = () => { calls++; };
  const a = {}, b = {};
  em.on('x', f, a); em.on('x', f, b);
  em.off('x', f, null);
  return em.listenerCount('x');
}
describe('off with null ctx', () => {
  it('compare', () => {
    const r = {
      ee3: run(new EE3()), pixiContainer: run(new PixiContainer()), engine2d: run(new EventEmitter()),
      ee3Multi: runMulti(new EE3()), engine2dMulti: runMulti(new EventEmitter()),
      ee3Zero: (() => { const e = new EE3(); const f = () => {}; e.on('x', f); e.off('x', f, 0 as any); return e.listenerCount('x'); })(),
      e2dZero: (() => { const e = new EventEmitter(); const f = () => {}; e.on('x', f); e.off('x', f, 0); return e.listenerCount('x'); })(),
    };
    console.log(JSON.stringify(r));
    expect(r.ee3).toEqual({ count: 0, calls: 0 });
    expect(r.pixiContainer).toEqual({ count: 0, calls: 0 });
    expect(r.engine2d).toEqual({ count: 1, calls: 1 }); // divergence
  });
});
