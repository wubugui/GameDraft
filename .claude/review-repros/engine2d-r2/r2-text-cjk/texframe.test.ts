import { beforeAll, describe, expect, it } from 'vitest';
import * as PIXI from 'pixi.js';
import { makeFakeAdapter } from '../../../../src/engine2d/text/_testing/fakeCanvas';
import { setTextDOMAdapter, type TextDOMAdapter } from '../../../../src/engine2d/text/adapter';
import { Text } from '../../../../src/engine2d/text/Text';
import type { BatchableElement, RenderCollector } from '../../../../src/engine2d/core/contracts';

beforeAll(() => {
  const adapter = makeFakeAdapter();
  PIXI.DOMAdapter.set(adapter as unknown as PIXI.Adapter);
  setTextDOMAdapter(adapter as unknown as TextDOMAdapter);
});

class FakeCollector implements RenderCollector {
  items: BatchableElement[] = [];
  constructor(public resolution: number) {}
  addBatchable(e: BatchableElement): void { this.items.push(e); }
  addCustom(): void {}
  addUnbatched(): void {}
  pushFilter(): void {}
  popFilter(): void {}
  pushMask(): void {}
  popMask(): void {}
}

const UI = '"Songti SC", STSong, "Kaiti SC", STKaiti, serif';
const STRS = ['你', '确定', '夜里的巷子很安静,只有远处传来几声狗叫。', '「谁在那里?」他停下脚步,回头看了一眼——什么也没有。再往前走就是老街了。', '……'];
const STYLES: PIXI.TextStyleOptions[] = [
  { fontSize: 14, fontFamily: UI },
  { fontSize: 25, fontFamily: UI, wordWrap: true, breakWords: true, wordWrapWidth: 920, lineHeight: 40 },
  { fontSize: 20, fontFamily: UI, align: 'center', letterSpacing: 0.5, wordWrap: true, breakWords: true, wordWrapWidth: 100 },
  { fontSize: 44, fontFamily: UI, letterSpacing: 8, dropShadow: { color: 0, alpha: 0.85, blur: 6, distance: 2, angle: Math.PI / 2 } },
  { fontSize: 96, fontFamily: UI, letterSpacing: 8 },
];

describe('text texture frame/uv/source vs Pixi CanvasTextSystem at fractional DPR', () => {
  it('matches', () => {
    const bad: string[] = [];
    for (const res of [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3]) {
      for (const st of STYLES) {
        for (const s of STRS) {
          for (const anchor of [0, 0.5, { x: 0.5, y: 1 }]) {
            const pt = new PIXI.Text({ text: s, style: st, anchor });
            const sys = new PIXI.CanvasTextSystem({ resolution: res, texture: { initSource() {} } } as unknown as PIXI.Renderer);
            const tex = sys.getManagedTexture(pt);
            const pb = { texture: tex, bounds: { minX: 0, maxX: 1, minY: 0, maxY: 0 } };
            PIXI.updateTextBounds(pb as unknown as PIXI.BatchableSprite, pt);
            const A = {
              b: { ...pb.bounds },
              f: [tex.frame.x, tex.frame.y, tex.frame.width, tex.frame.height],
              uv: { ...tex.uvs },
              src: [tex.source.pixelWidth, tex.source.pixelHeight, tex.source.width, tex.source.height, tex.source.resolution],
              lb: (() => { const r = pt.getLocalBounds(); return [r.x, r.y, r.width, r.height]; })(),
              wh: [pt.width, pt.height],
            };
            const mt = new Text({ text: s, style: st as never, anchor });
            const col = new FakeCollector(res);
            mt.collectRenderables(col);
            const it0 = col.items[0];
            const t2 = it0.texture;
            const B = {
              b: { ...it0.bounds! },
              f: [t2.frame.x, t2.frame.y, t2.frame.width, t2.frame.height],
              uv: { ...t2.uvs },
              src: [t2.source.pixelWidth, t2.source.pixelHeight, t2.source.width, t2.source.height, t2.source.resolution],
              lb: (() => { const r = mt.getLocalBounds(); return [r.x, r.y, r.width, r.height]; })(),
              wh: [mt.width, mt.height],
            };
            try {
              expect(B).toEqual(A);
            } catch {
              bad.push(`res=${res} ${JSON.stringify(st).slice(0, 60)} ${s.slice(0, 6)}\nP=${JSON.stringify(A)}\nM=${JSON.stringify(B)}`);
            }
            sys.decreaseReferenceCount(pt.styleKey);
            mt.destroy();
          }
        }
      }
    }
    if (bad.length) console.log(bad.slice(0, 5).join('\n\n'), `\n(total ${bad.length})`);
    expect(bad.length).toBe(0);
  });
});
