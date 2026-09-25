import { describe, it, expect } from 'vitest';
import * as P from 'pixi.js';
import * as E from '../../../../src/engine2d';

function kinds(c: any) {
  return c.effects.map((e: any) => e.kind ?? e.pipe ?? e.constructor.name);
}
describe('effect order', () => {
  it('filters then mask', () => {
    const pc = new P.Container(); const pg = new P.Graphics();
    pc.filters = [({} as any)]; pc.mask = pg;
    const ec = new (E as any).Container(); const eg = new (E as any).Graphics();
    ec.filters = [new (E as any).AlphaFilter()]; ec.mask = eg;
    console.log('pixi', kinds(pc), pc.effects.map((e: any) => e.priority));
    console.log('e2d ', kinds(ec), ec.effects.map((e: any) => e.priority));
    // mask-null-then-reset on filtered container
    const pc2 = new P.Container(); pc2.mask = new P.Graphics(); pc2.filters = [({} as any)]; pc2.mask = null; pc2.mask = new P.Graphics();
    const ec2 = new (E as any).Container(); ec2.mask = new (E as any).Graphics(); ec2.filters = [new (E as any).AlphaFilter()]; ec2.mask = null; ec2.mask = new (E as any).Graphics();
    console.log('pixi2', kinds(pc2)); console.log('e2d2 ', kinds(ec2));
    expect(kinds(ec)[0]).toBe('filters');
  });
});
