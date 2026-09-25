/**
 * 文字位图生成与 pixi.js 8.17 对照:同一假 2D 上下文下,记录 CanvasTextGenerator 对画布的全部调用
 * (resetTransform / scale / font / textBaseline / 描边参数 / fillStyle / strokeStyle / 阴影参数 / fillText /
 * strokeText 及坐标 / 渐变参数与色标)逐条比较;另比画布尺寸与 frame(含 style.trim 的非透明包围盒)。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import * as PIXI from 'pixi.js';
import { FakeContext2D, makeFakeAdapter } from './_testing/fakeCanvas';
import { setTextDOMAdapter, type TextDOMAdapter } from './adapter';
import { TextStyle, type TextStyleOptions } from './TextStyle';
import { CanvasTextGenerator } from './canvas/CanvasTextGenerator';
import { CanvasTextMetrics } from './canvas/CanvasTextMetrics';
import type { FillGradientLike } from './fill';

beforeAll(() => {
  const adapter = makeFakeAdapter();
  PIXI.DOMAdapter.set(adapter as unknown as PIXI.Adapter);
  setTextDOMAdapter(adapter as unknown as TextDOMAdapter);
});

interface GenResult {
  calls: unknown[];
  frame: { x: number; y: number; width: number; height: number };
  canvas: [number, number];
}

function genPixi(text: string, opts: TextStyleOptions, resolution: number): GenResult {
  const style = new PIXI.TextStyle(opts as PIXI.TextStyleOptions);
  const { canvasAndContext, frame } = PIXI.CanvasTextGenerator.getCanvasAndContext({ text, style, resolution });
  const ctx = canvasAndContext.context as unknown as FakeContext2D;
  const out: GenResult = {
    calls: ctx.calls.slice(),
    frame: { x: frame.x, y: frame.y, width: frame.width, height: frame.height },
    canvas: [canvasAndContext.canvas.width, canvasAndContext.canvas.height],
  };
  PIXI.CanvasTextGenerator.returnCanvasAndContext(canvasAndContext);
  ctx.calls.length = 0;
  return out;
}

function genMine(text: string, opts: TextStyleOptions, resolution: number): GenResult {
  const style = new TextStyle(opts);
  const { canvasAndContext, frame } = CanvasTextGenerator.getCanvasAndContext({ text, style, resolution });
  const ctx = canvasAndContext.context as unknown as FakeContext2D;
  const out: GenResult = {
    calls: ctx.calls.slice(),
    frame: { x: frame.x, y: frame.y, width: frame.width, height: frame.height },
    canvas: [canvasAndContext.canvas.width, canvasAndContext.canvas.height],
  };
  CanvasTextGenerator.returnCanvasAndContext(canvasAndContext);
  ctx.calls.length = 0;
  return out;
}

const LONG = '夜里的巷子很安静,只有远处传来几声狗叫。He stopped, looked back — nothing there. 「谁在那里?」';

const CASES: Array<[string, string, TextStyleOptions]> = [
  ['缺省单行', 'Hello', {}],
  ['空串', '', { fontSize: 20 }],
  ['多行左对齐', 'first line\nsecond, longer line\nthird', { fontSize: 20, fill: 0xffffff }],
  ['换行居中', LONG, { fontSize: 18, wordWrap: true, wordWrapWidth: 220, align: 'center', breakWords: true, fill: '#e8dcc0' }],
  ['换行右对齐', LONG, { fontSize: 18, wordWrap: true, wordWrapWidth: 260, align: 'right', breakWords: true }],
  ['两端对齐', 'one two three four five six seven eight nine ten eleven twelve', { fontSize: 16, wordWrap: true, wordWrapWidth: 150, align: 'justify' }],
  ['两端对齐 + 字距', 'one two three four five six seven eight nine ten', { fontSize: 16, wordWrap: true, wordWrapWidth: 170, align: 'justify', letterSpacing: 1.5 }],
  ['字距', '字距测试 letter spacing', { fontSize: 22, letterSpacing: 3 }],
  ['负字距', 'tight text', { fontSize: 22, letterSpacing: -1 }],
  ['描边', 'Stroked', { fontSize: 30, fill: 0xffcc00, stroke: { color: 0x000000, width: 5, join: 'round' } }],
  ['描边半透明', 'Stroke α', { fontSize: 30, stroke: { color: 'rgba(0,0,0,0.5)', width: 3 } }],
  ['投影', 'Shadow', { fontSize: 28, fill: 0xffffff, dropShadow: { color: 0x000000, alpha: 0.6, blur: 4, distance: 3, angle: Math.PI / 2 } }],
  ['投影 + 描边 + 换行', LONG, { fontSize: 18, wordWrap: true, wordWrapWidth: 240, breakWords: true, stroke: { color: 0x222222, width: 2 }, dropShadow: true }],
  ['行高大于字号', 'a\nb\nc', { fontSize: 20, lineHeight: 40 }],
  ['行高小于字号', 'a\nb\nc', { fontSize: 20, lineHeight: 12 }],
  ['leading', 'a\nb\nc', { fontSize: 20, leading: 7 }],
  ['padding', 'Padded', { fontSize: 24, padding: 6 }],
  ['textBaseline middle', 'Baseline', { fontSize: 24, textBaseline: 'middle' }],
  ['粗斜体字体族', 'Styled 字体', { fontSize: 19, fontWeight: 'bold', fontStyle: 'italic', fontFamily: '"Songti SC", STSong, "Kaiti SC", STKaiti, serif' }],
  ['半透明填充', 'Alpha', { fontSize: 24, fill: { color: 0x336699, alpha: 0.4 } }],
  ['trim', 'Trimmed', { fontSize: 32, trim: true, padding: 4 }],
  ['trim + 投影', 'TS', { fontSize: 32, trim: true, dropShadow: { distance: 6, blur: 1 } }],
  ['标签色板', '他说<c1>别回头</c1>,<c2>快走</c2>。', { fontSize: 18, tagStyles: { c1: { fill: 0xff6644 }, c2: { fill: '#88ccff' } } }],
  [
    '标签换行两端对齐',
    'alpha <c1>beta gamma</c1> delta <c2>epsilon zeta eta</c2> theta iota kappa',
    { fontSize: 16, wordWrap: true, wordWrapWidth: 160, align: 'justify', tagStyles: { c1: { fill: 0xff0000 }, c2: { fill: 0x00ff00 } } },
  ],
  [
    '标签描边投影字号',
    'base <big>BIG</big> and <em>em\nnext</em> line',
    {
      fontSize: 16,
      align: 'center',
      tagStyles: {
        big: { fontSize: 30, stroke: { color: 0x000000, width: 4 } },
        em: { fontStyle: 'italic', dropShadow: { distance: 2, color: 0x330000 }, letterSpacing: 2 },
      },
    },
  ],
  ['标签 + padding + 投影', '<c1>影</c1>子 shadow', { fontSize: 20, padding: 3, dropShadow: true, tagStyles: { c1: { fill: 0xffffff } } }],
];

describe('CanvasTextGenerator 绘制调用序列与 pixi 一致', () => {
  for (const resolution of [1, 2, 1.5]) {
    for (const [name, text, opts] of CASES) {
      it(`${name} @${resolution}x`, () => {
        const p = genPixi(text, structuredClone(opts), resolution);
        const m = genMine(text, structuredClone(opts), resolution);
        expect(m.canvas).toEqual(p.canvas);
        expect(m.frame).toEqual(p.frame);
        expect(m.calls).toEqual(p.calls);
        expect(m.calls.length).toBeGreaterThan(3);
      });
    }
  }

  it('渐变填充(竖直按行重复 / 斜向铺满)与 pixi 一致', () => {
    const makeGradients = (): PIXI.FillGradient[] => [
      new PIXI.FillGradient({ type: 'linear', start: { x: 0, y: 0 }, end: { x: 0, y: 1 }, colorStops: [{ offset: 0, color: 0xff0000 }, { offset: 1, color: 0x0000ff }], textureSpace: 'local' }),
      new PIXI.FillGradient({ type: 'linear', start: { x: 0, y: 0 }, end: { x: 1, y: 1 }, colorStops: [{ offset: 0, color: 'white' }, { offset: 0.5, color: '#00ff00' }, { offset: 1, color: 0x000000 }] }),
      new PIXI.FillGradient({ type: 'radial', center: { x: 0.5, y: 0.5 }, innerRadius: 0, outerCenter: { x: 0.5, y: 0.5 }, outerRadius: 0.5, colorStops: [{ offset: 0, color: 0xffffff }, { offset: 1, color: 0x000000 }] }),
    ];
    const text = 'Gradient line one\nline two\nline three';
    for (let i = 0; i < 3; i++) {
      for (const extra of [{}, { stroke: { color: 0, width: 2 } }, { padding: 4 }] as TextStyleOptions[]) {
        const gp = makeGradients()[i];
        const gm = makeGradients()[i];
        const p = genPixi(text, { fontSize: 20, fill: gp as unknown as FillGradientLike, ...extra }, 2);
        const m = genMine(text, { fontSize: 20, fill: gm as unknown as FillGradientLike, ...extra }, 2);
        expect(m.calls).toEqual(p.calls);
      }
    }
  });

  it('实验性原生字距开启时也一致', () => {
    PIXI.CanvasTextMetrics.experimentalLetterSpacing = true;
    CanvasTextMetrics.experimentalLetterSpacing = true;
    try {
      for (const [, text, opts] of CASES.filter(([n]) => /字距|对齐/.test(n))) {
        const p = genPixi(text, structuredClone(opts), 1);
        const m = genMine(text, structuredClone(opts), 1);
        expect(m.calls).toEqual(p.calls);
        expect(m.frame).toEqual(p.frame);
      }
    } finally {
      PIXI.CanvasTextMetrics.experimentalLetterSpacing = false;
      CanvasTextMetrics.experimentalLetterSpacing = false;
    }
  });
});
