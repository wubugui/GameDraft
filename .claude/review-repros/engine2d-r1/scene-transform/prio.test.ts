import * as PIXI from 'pixi.js';
import { expect, it } from 'vitest';
import * as E from '../../../../src/engine2d';
it('effect order with filters then mask', () => {
  const pc = new PIXI.Container(); const pm = new PIXI.Graphics().rect(0, 0, 10, 10).fill(0xffffff);
  const ec = new E.Container(); const em = new E.Graphics().rect(0, 0, 10, 10).fill(0xffffff);
  pc.filters = [{} as any]; ec.filters = [{} as any];
  pc.mask = pm; ec.mask = em;
  const pk = pc.effects.map((e: any) => (e.pipe === 'filter' ? 'filters' : 'mask'));
  const ek = ec.effects.map((e: any) => e.kind);
  expect(ek).toEqual(pk);
});
