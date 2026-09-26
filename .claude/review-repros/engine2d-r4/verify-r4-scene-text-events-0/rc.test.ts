import { describe, it, expect } from 'vitest';
import { Container as PC } from 'pixi.js';
import { Container as EC } from '../../../../src/engine2d';

function run(C: any) {
  const p = new C();
  const kids = Array.from({ length: 10 }, () => new C());
  kids.forEach((k: any) => p.addChild(k));
  const removedEvents: any[] = [];
  kids.forEach((k: any, i: number) => k.on('removed', () => removedEvents.push(i)));
  const ret = p.removeChildren(2, 5);
  const orphans = kids.filter((k: any) => k.parent === p && !p.children.includes(k)).map((k: any) => kids.indexOf(k));
  return { returned: ret.length, left: p.children.length, leftIdx: p.children.map((k: any) => kids.indexOf(k)), orphans, removedEvents };
}
describe('removeChildren(2,5)', () => {
  it('compare', () => {
    const pr = run(PC), er = run(EC);
    console.log('pixi', JSON.stringify(pr));
    console.log('engine2d', JSON.stringify(er));
    expect(pr).not.toEqual(er);
  });
});
