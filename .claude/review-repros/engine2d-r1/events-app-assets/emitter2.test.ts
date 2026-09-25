/* eslint-disable @typescript-eslint/no-explicit-any */
import EE3 from 'eventemitter3';
import { describe, expect, it } from 'vitest';
import { EventEmitter } from '../../../../src/engine2d/utils/EventEmitter';

const cases: Record<string, (em: any, log: string[]) => void> = {
  offNullCtx: (em, log) => { const f = () => log.push('f'); em.on('x', f); em.off('x', f, null); log.push(String(em.listenerCount('x'))); em.emit('x'); },
  offNullCtxOnNull: (em, log) => { const f = () => log.push('f'); em.on('x', f, null); em.off('x', f, null); log.push(String(em.listenerCount('x'))); em.emit('x'); },
  offCtxWhenRegisteredWithout: (em, log) => { const f = () => log.push('f'); const c = {}; em.on('x', f); em.off('x', f, c); log.push(String(em.listenerCount('x'))); },
  onceThenOffWithCtx: (em, log) => { const f = function (this: any) { log.push('f' + (this === em)); }; em.once('x', f); em.on('x', f); em.off('x', f, undefined, true); log.push(String(em.listenerCount('x'))); em.emit('x'); em.emit('x'); },
  onceSameFnTwoCtx: (em, log) => { const a = { id: 'a' }; const b = { id: 'b' }; const f = function (this: any) { log.push('f' + this.id); }; em.once('x', f, a); em.once('x', f, b); em.emit('x'); log.push(String(em.listenerCount('x'))); em.emit('x'); },
  addDuringEmit: (em, log) => { const g = () => log.push('g'); const f = () => { log.push('f'); em.on('x', g); }; em.on('x', f); em.emit('x'); em.emit('x'); },
  removeDuringEmit2: (em, log) => { const g = () => log.push('g'); const f = () => { log.push('f'); em.off('x', g); }; em.on('x', f); em.on('x', g); em.emit('x'); em.emit('x'); },
};
describe('EventEmitter targeted', () => {
  for (const [name, fn] of Object.entries(cases)) {
    it(name, () => {
      const a: string[] = []; const b: string[] = [];
      fn(new EventEmitter(), a); fn(new (EE3 as any)(), b);
      expect(a).toEqual(b);
    });
  }
});
