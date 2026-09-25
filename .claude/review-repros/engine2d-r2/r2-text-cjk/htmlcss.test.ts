import { describe, expect, it } from 'vitest';
import * as PIXI from 'pixi.js';
import { HTMLTextStyle } from '../../../../src/engine2d/text/html/HTMLTextStyle';

const UI = '"Songti SC", STSong, "Kaiti SC", STKaiti, serif';

describe('HTMLText style -> CSS parity (CutsceneRenderer subtitle)', () => {
  for (const align of ['left', 'center', 'right'] as const) {
    for (const ww of [80, 944, 603.5]) {
      for (const ff of [UI, 'sans-serif']) {
        it(`${align} ${ww} ${ff}`, () => {
          const opts = { fontSize: 18, fill: '#ffffff', fontFamily: ff, wordWrap: true, wordWrapWidth: ww, align };
          const p = new PIXI.HTMLTextStyle(opts as never);
          const m = new HTMLTextStyle(opts as never);
          expect(m.cssStyle).toEqual(p.cssStyle);
          expect(m.padding).toEqual(p.padding);
          expect(m._getFinalPadding()).toEqual(p._getFinalPadding());
          const pc = p.clone();
          const mc = m.clone();
          expect(mc.cssStyle).toEqual(pc.cssStyle);
        });
      }
    }
  }
  it('fill variants / dropShadow / stroke', () => {
    const variants: Array<Record<string, unknown>> = [
      { fill: 0xffcc88 },
      { fill: '#ffcc8880' },
      { fill: 'rgba(255,0,0,0.5)' },
      { dropShadow: { alpha: 0.9, angle: Math.PI / 2, blur: 4, color: 0x000000, distance: 2 } },
      { stroke: { color: 0x000000, width: 3 } },
      { breakWords: true, wordWrap: true, lineHeight: 30, letterSpacing: 1.5 },
      { tagStyles: { b: { fill: 0xff0000, fontSize: 20, breakWords: true } } },
    ];
    for (const v of variants) {
      const p = new PIXI.HTMLTextStyle({ fontSize: 18, ...(v as object) } as never);
      const m = new HTMLTextStyle({ fontSize: 18, ...(v as object) } as never);
      expect(m.cssStyle).toEqual(p.cssStyle);
    }
  });
});
