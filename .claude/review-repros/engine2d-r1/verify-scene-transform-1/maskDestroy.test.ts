import { describe, it, expect } from 'vitest';
import * as E from '../../../../src/engine2d';
import * as P from 'pixi.js';

function run(lib: any) {
  const parent = new lib.Container();
  const maskG = new lib.Graphics().rect(0, 0, 500, 500).fill(0xffffff);
  const content = new lib.Graphics().rect(0, 0, 10, 10).fill(0xff0000);
  parent.addChild(maskG, content);
  content.mask = maskG;
  const before = { inc: maskG.includeInBuild, meas: maskG.measurable, w: parent.getLocalBounds().width };
  content.destroy();
  const after = { inc: maskG.includeInBuild, meas: maskG.measurable, w: parent.getLocalBounds().width, inParent: maskG.parent === parent };
  return { before, after };
}

describe('mask destroy', () => {
  it('compare', () => {
    const e = run(E); const p = run(P);
    console.log('engine2d', JSON.stringify(e));
    console.log('pixi', JSON.stringify(p));
    expect(e).not.toEqual(p);
  });
});
