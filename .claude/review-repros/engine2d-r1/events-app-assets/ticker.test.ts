/* eslint-disable @typescript-eslint/no-explicit-any */
import * as PIXI from 'pixi.js';
import { describe, expect, it, vi } from 'vitest';
import { Ticker } from '../../../../src/engine2d/ticker/Ticker';

function run(T: any): string[] {
  const log: string[] = [];
  const t = new T();
  const ctxA = { n: 'A' };
  const f = (name: string) => function (this: any, tk: any) { log.push(`${name}:${this?.n ?? '-'}:${tk.deltaMS.toFixed(3)}:${tk.deltaTime.toFixed(4)}:${tk.elapsedMS.toFixed(3)}`); };
  const a = f('a'), b = f('b'), c = f('c'), d = f('d');
  const selfRemove = function (this: any) { log.push('self'); t.remove(selfRemove); t.add(d, undefined, 100); t.remove(c); };
  t.add(a, ctxA, 0); t.add(b, undefined, 25); t.addOnce(c, undefined, -25); t.add(selfRemove, undefined, 0); t.add(a, undefined, 0);
  t.lastTime = 0;
  const times = [16, 33, 50, 300, 301, 301, 320, 1000];
  t.speed = 1.5;
  for (const tm of times) { t.update(tm); log.push(`count=${t.count}`); }
  t.minFPS = 20; t.maxFPS = 30; log.push(`fps ${t.minFPS} ${t.maxFPS}`);
  for (const tm of [1010, 1020, 1040, 1060, 1100, 1500]) { t.update(tm); log.push(`t${tm}:${t.deltaMS.toFixed(3)}`); }
  t.maxFPS = 10; log.push(`fps2 ${t.minFPS} ${t.maxFPS}`);
  t.minFPS = 70; log.push(`fps3 ${t.minFPS} ${t.maxFPS}`);
  t.remove(a, ctxA); t.update(2000); log.push(`count=${t.count}`);
  t.destroy(); log.push(`destroyed count=${t.count}`);
  return log;
}
describe('Ticker parity', () => {
  it('same log', () => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    expect(run(Ticker)).toEqual(run(PIXI.Ticker));
  });
});
