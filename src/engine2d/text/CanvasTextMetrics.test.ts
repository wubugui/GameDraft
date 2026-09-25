/**
 * CanvasTextMetrics 与 pixi.js 8.17 对照:同一假 2D 上下文(度量可预测,advance 与 actualBoundingBox 有差)下,
 * 同样的文字 + 样式喂给两边,比较换行结果、行宽、总宽高、行高、字体度量;带标签文字再比逐行样式段、
 * 每行 ascent / descent / 行高;另比 graphemeSegmenter、分词工具与可覆盖钩子的行为。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import * as PIXI from 'pixi.js';
import { makeFakeAdapter } from './_testing/fakeCanvas';
import { setTextDOMAdapter, type TextDOMAdapter } from './adapter';
import { TextStyle, type TextStyleOptions } from './TextStyle';
import { CanvasTextMetrics } from './canvas/CanvasTextMetrics';
import { tokenize, trimRight } from './canvas/utils/textTokenization';
import { getPlainText, parseTaggedText } from './canvas/utils/parseTaggedText';

beforeAll(() => {
  const adapter = makeFakeAdapter();
  PIXI.DOMAdapter.set(adapter as unknown as PIXI.Adapter);
  setTextDOMAdapter(adapter as unknown as TextDOMAdapter);
});

type AnyRec = Record<string, unknown>;

function styleSig(s: AnyRec): AnyRec {
  const f = s._fill as AnyRec | null;
  const st = s._stroke as AnyRec | null;
  return {
    font: s._fontString,
    fill: f ? [f.color, f.alpha] : f,
    stroke: st ? [st.color, st.width] : st,
    letterSpacing: s.letterSpacing,
    lineHeight: s.lineHeight,
    dropShadow: !!s.dropShadow,
  };
}

function metricsSig(m: PIXI.CanvasTextMetrics | CanvasTextMetrics): AnyRec {
  const r = m as unknown as AnyRec;
  return {
    width: r.width,
    height: r.height,
    lines: r.lines,
    lineWidths: r.lineWidths,
    lineHeight: r.lineHeight,
    maxLineWidth: r.maxLineWidth,
    fontProperties: { ...(r.fontProperties as object) },
    runsByLine: (r.runsByLine as Array<Array<{ text: string; style: AnyRec }>> | undefined)?.map((line) =>
      line.map((run) => ({ text: run.text, style: styleSig(run.style) })),
    ),
    lineAscents: r.lineAscents,
    lineDescents: r.lineDescents,
    lineHeights: r.lineHeights,
    hasDropShadow: r.hasDropShadow,
  };
}

const LONG_EN = 'The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs!';
const LONG_ZH = '夜里的巷子很安静,只有远处传来几声狗叫。他停下脚步,回头看了一眼——什么也没有。「谁在那里?」';
const MIXED = '第3章 Chapter-Three:回到 old-town 的那天,下着雨……well-known 的老板说:"欢迎回来"。';

const TEXTS: Array<[string, string]> = [
  ['空串', ''],
  ['单字', 'M'],
  ['英文长句', LONG_EN],
  ['中文长句', LONG_ZH],
  ['中英混排', MIXED],
  ['多换行', 'line one\nline two\r\nline three\rline four\n\n'],
  ['首尾空白', '   leading and trailing   \n  second   line  '],
  ['制表符', 'a\tb\t\tc  d'],
  ['连字符', 'self-contained well-known up-to-date'],
  ['长单词', 'Supercalifragilisticexpialidocious antidisestablishmentarianism'],
  ['emoji 字素簇', '👨‍👩‍👧‍👦 family 🧑‍💻 dev é é à'],
  ['全角空格', '甲　乙　丙 丁'],
];

const STYLES: Array<[string, TextStyleOptions]> = [
  ['缺省', {}],
  ['换行 200', { wordWrap: true, wordWrapWidth: 200 }],
  ['换行 + breakWords', { wordWrap: true, wordWrapWidth: 120, breakWords: true }],
  ['换行 normal 空白', { wordWrap: true, wordWrapWidth: 160, whiteSpace: 'normal' }],
  ['换行 pre-line', { wordWrap: true, wordWrapWidth: 160, whiteSpace: 'pre-line', breakWords: true }],
  ['居中换行', { wordWrap: true, wordWrapWidth: 300, align: 'center', fontSize: 18 }],
  ['右对齐 + 字距', { wordWrap: true, wordWrapWidth: 240, align: 'right', letterSpacing: 2.5, fontSize: 20 }],
  ['两端对齐', { wordWrap: true, wordWrapWidth: 260, align: 'justify', fontSize: 16 }],
  ['行高 + leading', { lineHeight: 34, leading: 6, fontSize: 22 }],
  ['描边 + 投影', { stroke: { color: 0, width: 4 }, dropShadow: { distance: 3, blur: 2 }, fontSize: 24 }],
  ['小行高', { lineHeight: 10, fontSize: 24, wordWrap: true, wordWrapWidth: 180, breakWords: true }],
  ['粗斜体', { fontWeight: 'bold', fontStyle: 'italic', fontSize: 17.5 }],
  ['游戏正文', { fontFamily: '"Songti SC", STSong, "Kaiti SC", STKaiti, serif', fontSize: 18, wordWrap: true, wordWrapWidth: 420, breakWords: true, lineHeight: 27, fill: 0xe8dcc0 }],
  ['letterSpacing 负', { letterSpacing: -1, wordWrap: true, wordWrapWidth: 150 }],
];

describe('CanvasTextMetrics.measureText 与 pixi 一致', () => {
  for (const [sname, sopts] of STYLES) {
    for (const [tname, text] of TEXTS) {
      it(`${sname} × ${tname}`, () => {
        const p = PIXI.CanvasTextMetrics.measureText(text, new PIXI.TextStyle(sopts as PIXI.TextStyleOptions));
        const m = CanvasTextMetrics.measureText(text, new TextStyle(sopts));
        expect(metricsSig(m)).toEqual(metricsSig(p));
      });
    }
  }

  it('显式 wordWrap 参数覆盖样式', () => {
    const opts: TextStyleOptions = { wordWrap: true, wordWrapWidth: 100 };
    const p = PIXI.CanvasTextMetrics.measureText(LONG_EN, new PIXI.TextStyle(opts as PIXI.TextStyleOptions), undefined, false);
    const m = CanvasTextMetrics.measureText(LONG_EN, new TextStyle(opts), undefined, false);
    expect(metricsSig(m)).toEqual(metricsSig(p));
    expect(m.lines.length).toBe(1);
  });

  it('undefined 文字按一个空格测', () => {
    const p = PIXI.CanvasTextMetrics.measureText(undefined as unknown as string, new PIXI.TextStyle());
    const m = CanvasTextMetrics.measureText(undefined, new TextStyle());
    expect(metricsSig(m)).toEqual(metricsSig(p));
  });

  it('结果按 文字 + styleKey 缓存,改样式后重测', () => {
    const s = new TextStyle({ fontSize: 20 });
    const a = CanvasTextMetrics.measureText('abc', s);
    expect(CanvasTextMetrics.measureText('abc', s)).toBe(a);
    s.fontSize = 30;
    const b = CanvasTextMetrics.measureText('abc', s);
    expect(b).not.toBe(a);
    expect(b.width).toBeGreaterThan(a.width);
  });

  it('measureFont / 字体度量缓存 / clearMetrics', () => {
    const font = 'normal normal normal 26px "Arial"';
    expect(CanvasTextMetrics.measureFont(font)).toEqual(PIXI.CanvasTextMetrics.measureFont(font));
    expect(CanvasTextMetrics.measureFont(font)).toBe(CanvasTextMetrics.measureFont(font));
    const before = CanvasTextMetrics.measureFont(font);
    CanvasTextMetrics.clearMetrics(font);
    expect(CanvasTextMetrics.measureFont(font)).not.toBe(before);
    expect(CanvasTextMetrics.measureFont(font)).toEqual(before);
  });

  it('_measureText(含字距)与 pixi 相同', () => {
    const pc = PIXI.CanvasTextMetrics._context;
    const mc = CanvasTextMetrics._context;
    for (const font of ['normal normal normal 20px Arial', 'italic normal bold 13px serif']) {
      pc.font = font;
      mc.font = font;
      for (const t of ['', 'a', 'hello world', '中文字', '👨‍👩‍👧 x']) {
        for (const ls of [0, 1.5, -2]) {
          expect(CanvasTextMetrics._measureText(t, ls, mc)).toBe(PIXI.CanvasTextMetrics._measureText(t, ls, pc));
        }
      }
    }
  });

  it('graphemeSegmenter / 分词 / trimRight 与 pixi 相同', () => {
    for (const [, t] of TEXTS) {
      expect(CanvasTextMetrics.graphemeSegmenter(t)).toEqual(PIXI.CanvasTextMetrics.graphemeSegmenter(t));
      expect(tokenize(t)).toEqual(PIXI.tokenize(t));
      expect(trimRight(t)).toEqual(PIXI.trimRight(t));
    }
    expect(CanvasTextMetrics.experimentalLetterSpacingSupported).toBe(PIXI.CanvasTextMetrics.experimentalLetterSpacingSupported);
  });

  it('可覆盖的 canBreakChars 钩子生效(与 pixi 一样)', () => {
    const style: TextStyleOptions = { wordWrap: true, wordWrapWidth: 60, breakWords: true };
    const noBreakInDigits = (c: string, n: string): boolean => !(/\d/.test(c) && /\d/.test(n));
    const origP = PIXI.CanvasTextMetrics.canBreakChars;
    const origM = CanvasTextMetrics.canBreakChars;
    PIXI.CanvasTextMetrics.canBreakChars = noBreakInDigits;
    CanvasTextMetrics.canBreakChars = noBreakInDigits;
    try {
      const text = 'abc1234567890defghij';
      const p = PIXI.CanvasTextMetrics.measureText(text, new PIXI.TextStyle(style as PIXI.TextStyleOptions));
      const m = CanvasTextMetrics.measureText(text, new TextStyle(style));
      expect(metricsSig(m)).toEqual(metricsSig(p));
    } finally {
      PIXI.CanvasTextMetrics.canBreakChars = origP;
      CanvasTextMetrics.canBreakChars = origM;
    }
  });
});

const PALETTE = { c1: { fill: 0xff6644 }, c2: { fill: '#88ccff' }, dim: { fill: 0x888888 } };

const TAGGED_TEXTS: Array<[string, string]> = [
  ['单段', '他说<c1>别回头</c1>。'],
  ['多段', '<c1>红</c1>和<c2>蓝</c2>之间,是<dim>灰色的</dim>地带。'],
  ['嵌套', 'a <big>big <em>and em</em> text</big> end'],
  ['未知标签按字面', 'x < y and <unknown>tag</unknown> <c1>ok</c1>'],
  ['未闭合', '<c1>never closed and a < lone bracket'],
  ['跨行', '<c1>第一行\n第二行</c1>\n<c2>第三行</c2>'],
  ['长段换行', `前言<c1>${LONG_ZH}</c1>后记 ${LONG_EN}`],
  ['英文跨段单词', 'hello<c1>world</c1>again and <c2>anoth</c2>er word here'],
  ['空标签与空白', '<c1></c1>   <c2> spaced </c2>  tail  '],
];

const TAGGED_STYLES: Array<[string, TextStyleOptions]> = [
  ['色板', { fontSize: 18, tagStyles: PALETTE }],
  ['色板 + 换行', { fontSize: 18, wordWrap: true, wordWrapWidth: 200, breakWords: true, tagStyles: PALETTE }],
  ['色板 + 换行不拆词', { fontSize: 16, wordWrap: true, wordWrapWidth: 90, tagStyles: PALETTE }],
  ['色板 + normal 空白', { fontSize: 16, wordWrap: true, wordWrapWidth: 150, whiteSpace: 'normal', tagStyles: PALETTE }],
  [
    '字号混排',
    {
      fontSize: 16,
      lineHeight: 0,
      wordWrap: true,
      wordWrapWidth: 220,
      align: 'center',
      tagStyles: {
        ...PALETTE,
        big: { fontSize: 30, fontWeight: 'bold' },
        em: { fontStyle: 'italic', stroke: { color: 0, width: 3 }, dropShadow: { distance: 2 } },
      },
    },
  ],
  ['固定行高 + leading', { fontSize: 20, lineHeight: 30, leading: 2, tagStyles: { ...PALETTE, big: { fontSize: 28 } } }],
];

describe('带标签文字的度量与 pixi 一致', () => {
  for (const [sname, sopts] of TAGGED_STYLES) {
    for (const [tname, text] of TAGGED_TEXTS) {
      it(`${sname} × ${tname}`, () => {
        const ps = new PIXI.TextStyle(structuredClone(sopts) as PIXI.TextStyleOptions);
        const ms = new TextStyle(structuredClone(sopts));
        const p = PIXI.CanvasTextMetrics.measureText(text, ps);
        const m = CanvasTextMetrics.measureText(text, ms);
        expect(metricsSig(m)).toEqual(metricsSig(p));
        const pr = PIXI.parseTaggedText(text, ps).map((r) => ({ text: r.text, style: styleSig(r.style as unknown as AnyRec) }));
        const mr = parseTaggedText(text, ms).map((r) => ({ text: r.text, style: styleSig(r.style as unknown as AnyRec) }));
        expect(mr).toEqual(pr);
        expect(getPlainText(text, ms)).toBe(PIXI.getPlainText(text, ps));
      });
    }
  }

  it('没有 tagStyles 时 < 按字面测', () => {
    const text = 'a <c1>b</c1>';
    const p = PIXI.CanvasTextMetrics.measureText(text, new PIXI.TextStyle({ fontSize: 18 }));
    const m = CanvasTextMetrics.measureText(text, new TextStyle({ fontSize: 18 }));
    expect(metricsSig(m)).toEqual(metricsSig(p));
    expect(m.runsByLine).toBeUndefined();
  });
});
