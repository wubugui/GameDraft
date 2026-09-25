/* eslint-disable @typescript-eslint/no-explicit-any */
import * as PIXI from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { GraphicsContext } from '../../../../src/engine2d/graphics/GraphicsContext';

const inputs: any[] = [
  0, 1, 0xffffff, 0x1000000, 0xffffffff, -1, 1.5, 0x123456 + 0.7, NaN, Infinity, undefined, null,
  '#fff', '#ffffff', '#ffffff80', '#FFF8', 'ffffff', '0xffffff', 'red', 'transparent', 'white', 'black',
  'rgba(10,20,30,0.5)', 'rgb(10 20 30)', 'rgba(255,255,255,0.3)', 'hsl(120, 50%, 50%)', 'hsla(120,50%,50%,0.2)', 'rgba(0,0,0,0.165)',
  [1, 0, 0], [1, 0, 0, 0.5], [255, 0, 0], new Float32Array([0.2, 0.4, 0.6, 0.8]), { r: 10, g: 20, b: 30 }, { r: 10, g: 20, b: 30, a: 0.5 },
  { h: 10, s: 20, l: 30 }, '', '  #abc  ', '#abcd', 'rgba(300,20,30,2)', 'rgb(10%,20%,30%)',
];

function tryRun(fn: () => any) {
  try { return fn(); } catch (e) { return `THROW`; }
}

describe('fill/stroke color inputs vs pixi', () => {
  it('matches', () => {
    const diffs: string[] = [];
    for (const v of inputs) {
      for (const mode of ['fillDirect', 'fillObj', 'fillObjAlpha', 'strokeObj', 'fillDeprecated']) {
        const run = (ctx: any) => tryRun(() => {
          ctx.rect(0, 0, 10, 10);
          if (mode === 'fillDirect') ctx.fill(v);
          else if (mode === 'fillObj') ctx.fill({ color: v });
          else if (mode === 'fillObjAlpha') ctx.fill({ color: v, alpha: 0.5 });
          else if (mode === 'strokeObj') ctx.stroke({ color: v, width: 2 });
          else ctx.fill(v, 0.3);
          const ins = ctx.instructions[ctx.instructions.length - 1];
          return ins ? { c: ins.data.style.color, a: ins.data.style.alpha } : 'none';
        });
        const p = run(new PIXI.GraphicsContext());
        const e = run(new GraphicsContext());
        if (JSON.stringify(p) !== JSON.stringify(e)) diffs.push(`${mode} ${JSON.stringify(v) ?? String(v)}: pixi=${JSON.stringify(p)} e2d=${JSON.stringify(e)}`);
      }
    }
    console.log(diffs.join('\n'));
    expect(diffs).toEqual([]);
  });
});
