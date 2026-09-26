import * as PIXI from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { Container } from '../../../../src/engine2d/scene/Container';

describe('misc', () => {
  it('removeChildren(begin, end) with begin > 0', () => {
    const p = new PIXI.Container();
    const e = new Container();
    const pc = Array.from({ length: 10 }, () => new PIXI.Container());
    const ec = Array.from({ length: 10 }, () => new Container());
    p.addChild(...pc); e.addChild(...ec);
    const pr = p.removeChildren(2, 5);
    const er = e.removeChildren(2, 5);
    console.log('pixi removed', pr.length, 'left', p.children.length, 'orphans with parent still set', pc.filter((c) => c.parent === p && !p.children.includes(c)).length);
    console.log('e2d removed', er.length, 'left', e.children.length);
    expect(e.children.length).toBe(p.children.length);
  });
});
