import * as PIXI from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { Container } from '../../../../src/engine2d/scene/Container';
import { Graphics } from '../../../../src/engine2d/graphics/Graphics';

describe('getLocalBounds cache vs Pixi: mask body outside the measured subtree', () => {
  it('sibling mask body redrawn after first measure', () => {
    const pp = new PIXI.Container();
    const pm = new PIXI.Graphics().rect(0, 0, 50, 50).fill(0xffffff);
    const pc = new PIXI.Graphics().rect(0, 0, 200, 200).fill(0xffffff);
    pp.addChild(pm, pc);
    pc.mask = pm;
    const pFirst = pc.getLocalBounds().width;
    pm.clear().rect(0, 0, 120, 120).fill(0xffffff);
    const pSecond = pc.getLocalBounds().width;

    const p = new Container();
    const m = new Graphics().rect(0, 0, 50, 50).fill(0xffffff);
    const c = new Graphics().rect(0, 0, 200, 200).fill(0xffffff);
    p.addChild(m, c);
    c.mask = m;
    const eFirst = c.getLocalBounds().width;
    m.clear().rect(0, 0, 120, 120).fill(0xffffff);
    const eSecond = c.getLocalBounds().width;
    console.log({ pFirst, pSecond, eFirst, eSecond, eWidth: c.width, pWidth: pc.width });
    expect([eFirst, eSecond]).toEqual([pFirst, pSecond]);
  });

  it('sibling mask body moved after first measure', () => {
    const pp = new PIXI.Container();
    const pm = new PIXI.Graphics().rect(0, 0, 50, 50).fill(0xffffff);
    const pc = new PIXI.Graphics().rect(0, 0, 200, 200).fill(0xffffff);
    pp.addChild(pm, pc);
    pc.mask = pm;
    const pFirst = pc.getLocalBounds().x;
    pm.x = 30;
    const pSecond = pc.getLocalBounds().x;

    const p = new Container();
    const m = new Graphics().rect(0, 0, 50, 50).fill(0xffffff);
    const c = new Graphics().rect(0, 0, 200, 200).fill(0xffffff);
    p.addChild(m, c);
    c.mask = m;
    const eFirst = c.getLocalBounds().x;
    m.x = 30;
    const eSecond = c.getLocalBounds().x;
    console.log({ pFirst, pSecond, eFirst, eSecond });
    expect([eFirst, eSecond]).toEqual([pFirst, pSecond]);
  });
});
