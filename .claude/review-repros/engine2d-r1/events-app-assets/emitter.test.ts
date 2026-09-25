/* eslint-disable @typescript-eslint/no-explicit-any */
import EE3 from 'eventemitter3';
import { describe, expect, it } from 'vitest';
import { EventEmitter } from '../../../../src/engine2d/utils/EventEmitter';

function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function run(make: () => any, seed: number): string[] {
  const r = rng(seed);
  const em = make();
  const log: string[] = [];
  const ctxs = [undefined, undefined, { id: 'c1' }, { id: 'c2' }];
  const fns: any[] = [];
  for (let i = 0; i < 4; i++) {
    const id = i;
    fns.push(function (this: any, ...args: any[]) {
      log.push(`f${id}:${this === em ? 'em' : this?.id ?? String(this)}:${args.join(',')}`);
      if (r() < 0.15) { em.off('x', fns[Math.floor(r() * 4)]); log.push('inner-off'); }
      if (r() < 0.1) { em.on('x', fns[Math.floor(r() * 4)]); log.push('inner-on'); }
    });
  }
  for (let k = 0; k < 60; k++) {
    const op = Math.floor(r() * 7);
    const f = fns[Math.floor(r() * 4)];
    const c = ctxs[Math.floor(r() * 4)];
    const ev = r() < 0.8 ? 'x' : 'y';
    if (op === 0) em.on(ev, f, c);
    else if (op === 1) em.once(ev, f, c);
    else if (op === 2) em.off(ev, f, c);
    else if (op === 3) em.off(ev, f);
    else if (op === 4) log.push(`emit=${em.emit(ev, k)}`);
    else if (op === 5) log.push(`count=${em.listenerCount(ev)}`);
    else if (op === 6 && r() < 0.2) em.removeAllListeners(r() < 0.5 ? ev : undefined);
  }
  return log;
}
describe('EventEmitter vs eventemitter3', () => {
  it('fuzz', () => {
    const bad: string[] = [];
    for (let s = 1; s < 400; s++) {
      const a = run(() => new EventEmitter(), s); const b = run(() => new (EE3 as any)(), s);
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        let i = 0; while (a[i] === b[i]) i++;
        bad.push(`seed ${s} @${i}: e2d=${a[i]} ee3=${b[i]}`);
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });
});
