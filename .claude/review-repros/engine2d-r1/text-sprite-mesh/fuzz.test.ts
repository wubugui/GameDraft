import { beforeAll, describe, expect, it } from 'vitest';
import * as PIXI from 'pixi.js';
import { FakeContext2D, makeFakeAdapter } from '../../../../src/engine2d/text/_testing/fakeCanvas';
import { setTextDOMAdapter, type TextDOMAdapter } from '../../../../src/engine2d/text/adapter';
import { TextStyle, type TextStyleOptions } from '../../../../src/engine2d/text/TextStyle';
import { CanvasTextGenerator } from '../../../../src/engine2d/text/canvas/CanvasTextGenerator';
import { CanvasTextMetrics } from '../../../../src/engine2d/text/canvas/CanvasTextMetrics';

beforeAll(() => {
  const adapter = makeFakeAdapter();
  PIXI.DOMAdapter.set(adapter as unknown as PIXI.Adapter);
  setTextDOMAdapter(adapter as unknown as TextDOMAdapter);
});

let seed = Number(process.env.SEED ?? 12345);
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
function pick<T>(a: T[]): T { return a[Math.floor(rnd() * a.length)]; }

const PIECES = ['夜里', '的巷子', '很安静', ',', '。', '「谁?」', ' ', '  ', '\n', '\t', 'hello', 'world', 'well-known', 'a', 'Supercalifragilistic', '……', '——', '😀', '1234', ' \n ', '<c1>', '</c1>', '<c2>', '</c2>', '<b>', '</b>', '[x]', '&lt;', '\r\n', 'ｆｕｌｌ', '!?', '  end  '];

function randText(tagged: boolean) {
  let s = '';
  const n = 1 + Math.floor(rnd() * 14);
  for (let i = 0; i < n; i++) {
    let p = pick(PIECES);
    if (!tagged && p.startsWith('<')) p = 'x';
    s += p;
  }
  return s;
}

function randStyle(tagged: boolean): TextStyleOptions {
  const o: TextStyleOptions = { fontSize: pick([12, 14, 16, 18, 22, 30]) };
  if (rnd() < 0.7) { o.wordWrap = true; o.wordWrapWidth = pick([20, 50, 80, 120, 200, 400]); }
  if (rnd() < 0.5) o.breakWords = true;
  if (rnd() < 0.4) o.whiteSpace = pick(['normal', 'pre', 'pre-line'] as const);
  if (rnd() < 0.4) o.align = pick(['left', 'center', 'right', 'justify'] as const);
  if (rnd() < 0.3) o.letterSpacing = pick([1, 2, -1, 0.5]);
  if (rnd() < 0.3) o.lineHeight = pick([10, 20, 28, 40]);
  if (rnd() < 0.3) o.leading = pick([2, 5, -2]);
  if (rnd() < 0.3) o.stroke = { color: 0, width: pick([1, 2, 4]) };
  if (rnd() < 0.3) o.dropShadow = pick([true, { distance: 3, blur: 2, alpha: 0.5 }]);
  if (rnd() < 0.2) o.padding = pick([2, 4]);
  if (rnd() < 0.15) o.trim = true;
  if (rnd() < 0.2) o.textBaseline = pick(['middle', 'top', 'bottom', 'alphabetic'] as const);
  if (rnd() < 0.2) o.fontWeight = 'bold';
  if (rnd() < 0.2) o.fill = pick([0xff0000, '#88ccff', { color: 0x336699, alpha: 0.5 }]);
  if (tagged) {
    o.tagStyles = {
      c1: { fill: 0xff6644 },
      c2: pick([{ fontSize: 30 }, { fill: '#00ff00', letterSpacing: 2 }, { stroke: { color: 0, width: 3 } }, { dropShadow: { distance: 2 } }, { fontSize: 10, fontWeight: 'bold' }]),
      b: { fontWeight: 'bold' },
    };
  }
  return o;
}

function sig(m: any) {
  return {
    width: m.width, height: m.height, lines: m.lines, lineWidths: m.lineWidths, lineHeight: m.lineHeight,
    maxLineWidth: m.maxLineWidth, fp: { ...m.fontProperties },
    runs: m.runsByLine?.map((l: any[]) => l.map((r) => r.text)),
    la: m.lineAscents, ld: m.lineDescents, lh: m.lineHeights, ds: m.hasDropShadow,
  };
}

function gen(P: any, Gen: any, text: string, opts: any, resolution: number) {
  const style = new P(opts);
  const { canvasAndContext, frame } = Gen.getCanvasAndContext({ text, style, resolution });
  const ctx = canvasAndContext.context as unknown as FakeContext2D;
  const out = { calls: ctx.calls.slice(), frame: { x: frame.x, y: frame.y, width: frame.width, height: frame.height }, canvas: [canvasAndContext.canvas.width, canvasAndContext.canvas.height] };
  Gen.returnCanvasAndContext(canvasAndContext);
  ctx.calls.length = 0;
  return out;
}

describe('fuzz', () => {
  it('metrics + generator', () => {
    let fails: string[] = [];
    for (let i = 0; i < Number(process.env.N ?? 3000); i++) {
      const tagged = rnd() < 0.4;
      const text = randText(tagged);
      const opts = randStyle(tagged);
      const pm = sig(PIXI.CanvasTextMetrics.measureText(text, new PIXI.TextStyle(structuredClone(opts) as any)));
      const mm = sig(CanvasTextMetrics.measureText(text, new TextStyle(structuredClone(opts))));
      try { expect(mm).toEqual(pm); } catch (e) { fails.push('M ' + JSON.stringify(text) + ' ' + JSON.stringify(opts) + '\n' + String(e).slice(0, 800)); }
      const res = pick([1, 2, 1.5, 1.25]);
      const pg = gen(PIXI.TextStyle, PIXI.CanvasTextGenerator, text, structuredClone(opts), res);
      const mg = gen(TextStyle, CanvasTextGenerator, text, structuredClone(opts), res);
      try { expect(mg).toEqual(pg); } catch (e) { fails.push('G ' + JSON.stringify(text) + ' ' + JSON.stringify(opts) + ' res=' + res + '\n' + String(e).slice(0, 800)); }
    }
    console.log('fails', fails.length, fails.slice(0, 6).join('\n----\n'));
    expect(fails.length).toBe(0);
  }, 600000);
});
