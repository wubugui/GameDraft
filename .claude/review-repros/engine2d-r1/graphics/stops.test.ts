/* eslint-disable @typescript-eslint/no-explicit-any */
import * as PIXI from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { Color } from '../../../../src/engine2d/color/Color';
import { pixiColorHexa, pixiColorNumber, pixiAlpha } from '../../../../src/engine2d/graphics/utils/pixiColor';

describe('gradient stop hexa vs pixi', () => {
  it('rgba strings with 3-decimal alpha and all rgb', () => {
    const diffs: string[] = [];
    const rgbs = ['0,0,0', '20,10,5', '200,160,90', '120,90,40', '255,255,255', '17,18,13'];
    for (const rgb of rgbs) {
      for (let k = 0; k <= 1000; k++) {
        const a = (k / 1000).toFixed(3);
        const s = `rgba(${rgb},${a})`;
        const p = new PIXI.Color(s).toHexa();
        const e = pixiColorHexa(new Color(s));
        if (p !== e) diffs.push(`${s}: pixi=${p} e2d=${e}`);
        const s2 = `rgba(${rgb},${k / 1000})`;
        const p2 = new PIXI.Color(s2).toHexa();
        const e2 = pixiColorHexa(new Color(s2));
        if (p2 !== e2) diffs.push(`${s2}: pixi=${p2} e2d=${e2}`);
      }
    }
    // numbers for fills
    for (let i = 0; i < 20000; i++) {
      const v = Math.floor(Math.random() * 0x1000000);
      const p = new PIXI.Color(v);
      const e = new Color(v);
      if (p.toNumber() !== pixiColorNumber(e) || p.alpha !== pixiAlpha(e)) diffs.push(`num ${v}`);
    }
    console.log(diffs.slice(0, 30).join('\n'), diffs.length);
    expect(diffs).toEqual([]);
  });
});
