/**
 * r2-text-cjk: engine2d vs pixi.js 8.17 text layout on REAL game content + REAL game TextStyles.
 * Same deterministic fake canvas for both sides.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as PIXI from 'pixi.js';
import { FakeContext2D, makeFakeAdapter } from '../../../../src/engine2d/text/_testing/fakeCanvas';
import { setTextDOMAdapter, type TextDOMAdapter } from '../../../../src/engine2d/text/adapter';
import { TextStyle, type TextStyleOptions } from '../../../../src/engine2d/text/TextStyle';
import { CanvasTextMetrics } from '../../../../src/engine2d/text/canvas/CanvasTextMetrics';
import { CanvasTextGenerator } from '../../../../src/engine2d/text/canvas/CanvasTextGenerator';
import { paletteTagStyles, toPixiTagged, hasStyleMarkup, sliceStyledMarkup, plainTextLength } from '../../../../src/core/textStyle';

const ROOT = path.resolve(__dirname, '../../..');

function collectStrings(): string[] {
  const cjk = /[⺀-鿿＀-￯]/;
  const out = new Set<string>();
  const dirs = ['public/assets/data', 'public/assets/dialogues', 'public/assets/scenes'];
  const walkFs = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walkFs(p);
      else if (e.name.endsWith('.json')) {
        let j: unknown;
        try {
          j = JSON.parse(fs.readFileSync(p, 'utf8'));
        } catch {
          continue;
        }
        const walk = (x: unknown): void => {
          if (typeof x === 'string') {
            if (cjk.test(x)) out.add(x);
          } else if (Array.isArray(x)) x.forEach(walk);
          else if (x && typeof x === 'object') Object.values(x).forEach(walk);
        };
        walk(j);
      }
    }
  };
  for (const d of dirs) walkFs(path.join(ROOT, d));
  return [...out].sort();
}

const UI = '"Songti SC", STSong, "Kaiti SC", STKaiti, serif';
const DISPLAY = '"Kaiti SC", STKaiti, "Songti SC", serif';
const FP_SHADOW = { alpha: 0.9, angle: Math.PI / 2, blur: 4, color: 0x000000, distance: 2 };
const ART_SHADOW = { color: 0x000000, alpha: 0.85, blur: 6, distance: 2, angle: Math.PI / 2 };

// Real game styles (values from src/ui/*, src/systems/EmoteBubbleManager.ts, src/rendering/CutsceneRenderer.ts)
const STYLES: Array<[string, TextStyleOptions]> = [
  ['DialogueUI.body', { fontSize: 25, fill: 0xe8dcc8, fontFamily: UI, wordWrap: true, breakWords: true, wordWrapWidth: 1024 - 64 - 40, lineHeight: 40 }],
  ['DialogueUI.body.fp', { fontSize: 25, fill: 0xe8dcc8, fontFamily: UI, wordWrap: true, breakWords: true, wordWrapWidth: 700, lineHeight: 40, dropShadow: { ...FP_SHADOW } }],
  ['DialogueUI.choice', { fontSize: 25, fill: 0xffffff, fontFamily: UI, align: 'center', wordWrap: true, breakWords: true, wordWrapWidth: 520 }],
  ['DialogueLog.body', { fontSize: 20, fontFamily: UI, wordWrap: true, breakWords: true, wordWrapWidth: 560, fill: 0xe8dcc8 }],
  ['DialogueLog.left', { fontSize: 20, fontFamily: DISPLAY, fill: 0xffcc66, wordWrap: true, breakWords: true, wordWrapWidth: 120 }],
  ['Bubble.speech', { fontSize: 20, fill: 0xe8dcc8, fontFamily: DISPLAY, align: 'center', letterSpacing: 0.5 }],
  ['Bubble.rich', { fontSize: 20, fill: 0xe8dcc8, fontFamily: DISPLAY, align: 'center', letterSpacing: 0.5, wordWrap: true, wordWrapWidth: 100, breakWords: true }],
  ['Bubble.rich.k1.3', { fontSize: 26, fill: 0xe8dcc8, fontFamily: DISPLAY, align: 'center', letterSpacing: 0.65, wordWrap: true, wordWrapWidth: 130, breakWords: true }],
  ['Subtitle', { fontSize: 18, fill: 0xffffff, fontFamily: UI, wordWrap: true, wordWrapWidth: 944, align: 'center' }],
  ['Subtitle.left', { fontSize: 18, fill: 0xffffff, fontFamily: UI, wordWrap: true, wordWrapWidth: 944, align: 'left' }],
  ['Inspect.body', { fontSize: 20, fill: 0xe8dcc8, fontFamily: UI, wordWrap: true, breakWords: true, lineHeight: 32, wordWrapWidth: 520 }],
  ['Inspect.title', { fontSize: 30, fill: 0xffcc66, fontFamily: DISPLAY, fontWeight: 'bold', letterSpacing: 4, wordWrap: true, breakWords: true, wordWrapWidth: 560 }],
  ['Inspect.hint', { fontSize: 16, fill: 0x8e867a, fontFamily: UI, letterSpacing: 2, wordWrap: true, breakWords: true, wordWrapWidth: 560 }],
  ['Archive.row', { fontSize: 20, fill: 0xe8dcc8, fontFamily: UI, wordWrap: true, breakWords: true, wordWrapWidth: 220 }],
  ['Archive.heading', { fontSize: 30, fill: 0xffcc66, fontFamily: DISPLAY, fontWeight: 'bold', letterSpacing: 4, wordWrap: true, breakWords: true, wordWrapWidth: 400 }],
  ['Book.body', { fontSize: 20, fill: 0x2a2018, fontFamily: UI, wordWrap: true, breakWords: true, lineHeight: 32, wordWrapWidth: 380 }],
  ['Menu.art', { fontSize: 44, fill: 0xffcc66, fontFamily: DISPLAY, letterSpacing: 8, dropShadow: { ...ART_SHADOW } }],
  ['Hint.small', { fontSize: 16, fill: 0x8e867a, fontFamily: UI, letterSpacing: 1 }],
  ['Title.nowrap', { fontSize: 30, fill: 0xffcc66, fontFamily: DISPLAY, letterSpacing: 4 }],
  ['v7.dropShadow', { fontSize: 20, fill: 0xffffff, fontFamily: UI, wordWrap: true, wordWrapWidth: 400, dropShadow: true, dropShadowColor: 0x000000, dropShadowAlpha: 0.55, dropShadowBlur: 6, dropShadowDistance: 2 } as TextStyleOptions],
  ['stroke', { fontSize: 22, fill: 0xffffff, fontFamily: UI, stroke: { color: 0x000000, width: 3 }, wordWrap: true, breakWords: true, wordWrapWidth: 300 }],
  ['justify', { fontSize: 20, fill: 0xffffff, fontFamily: UI, align: 'justify', wordWrap: true, wordWrapWidth: 300 }],
  ['nobreak', { fontSize: 20, fill: 0xffffff, fontFamily: UI, wordWrap: true, breakWords: false, wordWrapWidth: 300 }],
  ['leading', { fontSize: 20, fill: 0xffffff, fontFamily: UI, wordWrap: true, breakWords: true, wordWrapWidth: 300, leading: 6, lineHeight: 30 }],
];

type AnyRec = Record<string, unknown>;

function styleSig(s: AnyRec): AnyRec {
  const f = s._fill as AnyRec | null;
  const st = s._stroke as AnyRec | null;
  return {
    font: s._fontString,
    fill: f ? [f.color, f.alpha] : f,
    stroke: st ? [st.color, st.width] : st,
    ls: s.letterSpacing,
    lh: s.lineHeight,
    ds: !!s.dropShadow,
  };
}

function sig(m: AnyRec): AnyRec {
  return {
    width: m.width,
    height: m.height,
    lines: m.lines,
    lineWidths: m.lineWidths,
    lineHeight: m.lineHeight,
    maxLineWidth: m.maxLineWidth,
    fp: { ...(m.fontProperties as object) },
    runs: (m.runsByLine as Array<Array<{ text: string; style: AnyRec }>> | undefined)?.map((l) => l.map((r) => [r.text, styleSig(r.style)])),
    la: m.lineAscents,
    ld: m.lineDescents,
    lhs: m.lineHeights,
    hds: m.hasDropShadow,
  };
}

let STRINGS: string[] = [];

beforeAll(() => {
  const adapter = makeFakeAdapter();
  PIXI.DOMAdapter.set(adapter as unknown as PIXI.Adapter);
  setTextDOMAdapter(adapter as unknown as TextDOMAdapter);
  STRINGS = collectStrings();
});

function variants(raw: string): Array<{ text: string; tagged: boolean }> {
  const out: Array<{ text: string; tagged: boolean }> = [];
  const needs = hasStyleMarkup(raw) && !raw.includes('<');
  out.push({ text: toPixiTagged(raw), tagged: needs });
  // typewriter prefixes
  const n = plainTextLength(raw);
  for (const k of [Math.floor(n / 3), Math.floor((2 * n) / 3)]) {
    if (k > 0 && k < n) out.push({ text: toPixiTagged(raw, k), tagged: needs });
  }
  void sliceStyledMarkup;
  return out;
}

describe('real content layout parity', () => {
  it('measureText: all strings x all game styles', () => {
    expect(STRINGS.length).toBeGreaterThan(1000);
    const tags = paletteTagStyles();
    let n = 0;
    const diffs: string[] = [];
    for (const [name, opts] of STYLES) {
      const eP = new PIXI.TextStyle(opts as PIXI.TextStyleOptions);
      const eM = new TextStyle(opts);
      const tP = new PIXI.TextStyle({ ...(opts as PIXI.TextStyleOptions), tagStyles: tags as never });
      const tM = new TextStyle({ ...opts, tagStyles: tags });
      for (const raw of STRINGS) {
        for (const v of variants(raw)) {
          const a = sig(PIXI.CanvasTextMetrics.measureText(v.text, v.tagged ? tP : eP) as unknown as AnyRec);
          const b = sig(CanvasTextMetrics.measureText(v.text, v.tagged ? tM : eM) as unknown as AnyRec);
          n++;
          try {
            expect(b).toEqual(a);
          } catch {
            if (diffs.length < 10) diffs.push(`${name} :: ${JSON.stringify(v.text).slice(0, 80)}\nP=${JSON.stringify(a).slice(0, 400)}\nM=${JSON.stringify(b).slice(0, 400)}`);
          }
          // wordWrap=false override
          const a2 = sig(PIXI.CanvasTextMetrics.measureText(v.text, eP, undefined, false) as unknown as AnyRec);
          const b2 = sig(CanvasTextMetrics.measureText(v.text, eM, undefined, false) as unknown as AnyRec);
          try {
            expect(b2).toEqual(a2);
          } catch {
            if (diffs.length < 10) diffs.push(`${name} nowrap :: ${v.text.slice(0, 60)}`);
          }
        }
      }
    }
    console.log(`compared ${n} (string,style) pairs; diffs=${diffs.length}`);
    if (diffs.length) console.log(diffs.join('\n\n'));
    expect(diffs).toEqual([]);
  }, 900000);

  it('CanvasTextGenerator: canvas sizing + draw calls on real content', () => {
    const tags = paletteTagStyles();
    const diffs: string[] = [];
    let n = 0;
    const sample = STRINGS.filter((_, i) => i % 3 === 0);
    for (const res of [1, 1.5, 2]) {
      for (const [name, opts] of STYLES) {
        const eP = new PIXI.TextStyle(opts as PIXI.TextStyleOptions);
        const eM = new TextStyle(opts);
        const tP = new PIXI.TextStyle({ ...(opts as PIXI.TextStyleOptions), tagStyles: tags as never });
        const tM = new TextStyle({ ...opts, tagStyles: tags });
        for (const raw of sample) {
          const v = variants(raw)[0];
          const gp = PIXI.CanvasTextGenerator.getCanvasAndContext({ text: v.text, style: v.tagged ? tP : eP, resolution: res });
          const cp = gp.canvasAndContext.context as unknown as FakeContext2D;
          const A = { calls: cp.calls.slice(), frame: [gp.frame.x, gp.frame.y, gp.frame.width, gp.frame.height], c: [gp.canvasAndContext.canvas.width, gp.canvasAndContext.canvas.height] };
          PIXI.CanvasTextGenerator.returnCanvasAndContext(gp.canvasAndContext);
          cp.calls.length = 0;
          const gm = CanvasTextGenerator.getCanvasAndContext({ text: v.text, style: v.tagged ? tM : eM, resolution: res });
          const cm = gm.canvasAndContext.context as unknown as FakeContext2D;
          const B = { calls: cm.calls.slice(), frame: [gm.frame.x, gm.frame.y, gm.frame.width, gm.frame.height], c: [gm.canvasAndContext.canvas.width, gm.canvasAndContext.canvas.height] };
          CanvasTextGenerator.returnCanvasAndContext(gm.canvasAndContext);
          cm.calls.length = 0;
          n++;
          try {
            expect(B).toEqual(A);
          } catch {
            if (diffs.length < 5) diffs.push(`${name} res=${res} :: ${v.text.slice(0, 60)}\nP=${JSON.stringify(A).slice(0, 600)}\nM=${JSON.stringify(B).slice(0, 600)}`);
          }
        }
      }
    }
    console.log(`generator compared ${n}; diffs=${diffs.length}`);
    if (diffs.length) console.log(diffs.join('\n\n'));
    expect(diffs.length).toBe(0);
  }, 900000);
});
