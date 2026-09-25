import * as PIXI from 'pixi.js';
import { expect, it } from 'vitest';
import { groupD8 } from '../../../../src/engine2d/math/groupD8';
it('groupD8', () => {
  for (let i = 0; i < 16; i++) {
    expect([groupD8.uX(i), groupD8.uY(i), groupD8.vX(i), groupD8.vY(i), groupD8.inv(i), groupD8.isVertical(i)]).toEqual([
      PIXI.groupD8.uX(i), PIXI.groupD8.uY(i), PIXI.groupD8.vX(i), PIXI.groupD8.vY(i), PIXI.groupD8.inv(i), PIXI.groupD8.isVertical(i)]);
    for (let j = 0; j < 16; j++) expect(groupD8.add(i, j)).toBe(PIXI.groupD8.add(i, j));
  }
  for (const k of ['E','SE','S','SW','W','NW','N','NE','MIRROR_VERTICAL','MAIN_DIAGONAL','MIRROR_HORIZONTAL','REVERSE_DIAGONAL']) expect((groupD8 as any)[k]).toBe((PIXI.groupD8 as any)[k]);
});
