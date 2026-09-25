/**
 * D24 EventEmitter 与 eventemitter3(Pixi 的发射器)对照:off / removeListener 的 context 为假值
 * (null / 0 / '' / false)时不比上下文(通配);on 的 context 为假值时按发射器自己绑定 this。
 */
import EE3 from 'eventemitter3';
import { describe, expect, it } from 'vitest';
import { EventEmitter } from './EventEmitter';

type Emitter = {
  on(e: string, fn: (...a: unknown[]) => void, ctx?: unknown): unknown;
  off(e: string, fn?: (...a: unknown[]) => void, ctx?: unknown): unknown;
  emit(e: string, ...a: unknown[]): boolean;
  listenerCount(e: string): number;
};

function scenario(make: () => Emitter, offCtx: unknown, addCtxs: unknown[]): { count: number; calls: number } {
  const em = make();
  let calls = 0;
  const f = (): void => {
    calls++;
  };
  for (const c of addCtxs) em.on('x', f, c);
  em.off('x', f, offCtx);
  em.emit('x');
  return { count: em.listenerCount('x'), calls };
}

describe('D24 off 的假值 context 是通配', () => {
  const falsy: unknown[] = [null, 0, '', false, undefined];
  for (const ctx of falsy) {
    it(`off(evt, fn, ${JSON.stringify(ctx) ?? 'undefined'})`, () => {
      for (const adds of [[undefined], [{ a: 1 }, { b: 2 }]]) {
        const ee3 = scenario(() => new EE3() as unknown as Emitter, ctx, adds);
        const mine = scenario(() => new EventEmitter() as unknown as Emitter, ctx, adds);
        expect(mine).toEqual(ee3);
        expect(mine).toEqual({ count: 0, calls: 0 });
      }
    });
  }

  it('真值 context 只摘匹配的', () => {
    const a = {};
    const b = {};
    const ee3 = scenario(() => new EE3() as unknown as Emitter, a, [a, b]);
    const mine = scenario(() => new EventEmitter() as unknown as Emitter, a, [a, b]);
    expect(mine).toEqual(ee3);
    expect(mine).toEqual({ count: 1, calls: 1 });
  });

  it('on 的假值 context:回调的 this 是发射器本身(eventemitter3 的 `context || emitter`)', () => {
    for (const ctx of [0, '', false, null]) {
      const ee3 = new EE3();
      let ee3This: unknown;
      ee3.on(
        'x',
        function (this: unknown) {
          ee3This = this;
        },
        ctx,
      );
      ee3.emit('x');
      const mine = new EventEmitter();
      let mineThis: unknown;
      mine.on(
        'x',
        function (this: unknown) {
          mineThis = this;
        },
        ctx,
      );
      mine.emit('x');
      expect(ee3This).toBe(ee3);
      expect(mineThis).toBe(mine);
    }
  });
});
