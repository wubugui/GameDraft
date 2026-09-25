/**
 * TextStyle 与 pixi.js 8.17 对照:同样的选项喂给两边,比较规范化结果(fill / stroke / dropShadow / 字号 /
 * font 串 / padding)、update 事件与 styleKey 的计数行为、Proxy 字段改动、clone / reset / assign / destroy。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import * as PIXI from 'pixi.js';
import { makeFakeAdapter } from './_testing/fakeCanvas';
import { setTextDOMAdapter, type TextDOMAdapter } from './adapter';
import { TextStyle, type TextStyleOptions } from './TextStyle';
import { Texture } from '../textures/Texture';

beforeAll(() => {
  const adapter = makeFakeAdapter();
  PIXI.DOMAdapter.set(adapter as unknown as PIXI.Adapter);
  setTextDOMAdapter(adapter as unknown as TextDOMAdapter);
});

type AnyStyle = Record<string, unknown>;

function normFill(f: AnyStyle | null | undefined, white: unknown): unknown {
  if (!f) return f;
  const out: AnyStyle = { ...f };
  out.texture = f.texture === white ? 'WHITE' : f.texture ? 'texture' : f.texture;
  out.fill = f.fill ? 'fill-object' : f.fill;
  out.matrix = f.matrix ? 'matrix' : f.matrix;
  return out;
}

function snapshot(style: PIXI.TextStyle | TextStyle, white: unknown): AnyStyle {
  const s = style as unknown as AnyStyle;
  const fontString = s._fontString; // 先取:数组字体族会被就地加引号(两边一致)
  const orig = s.fill as AnyStyle | null;
  return {
    align: s.align,
    breakWords: s.breakWords,
    dropShadow: s.dropShadow ? { ...(s.dropShadow as object) } : s.dropShadow,
    fontFamily: Array.isArray(s.fontFamily) ? [...(s.fontFamily as string[])] : s.fontFamily,
    fontSize: s.fontSize,
    fontStyle: s.fontStyle,
    fontVariant: s.fontVariant,
    fontWeight: s.fontWeight,
    leading: s.leading,
    letterSpacing: s.letterSpacing,
    lineHeight: s.lineHeight,
    padding: s.padding,
    textBaseline: s.textBaseline,
    trim: s.trim,
    whiteSpace: s.whiteSpace,
    wordWrap: s.wordWrap,
    wordWrapWidth: s.wordWrapWidth,
    tagStyles: s.tagStyles,
    fill: orig !== null && typeof orig === 'object' && !Array.isArray(orig) ? normFill(orig, white) : orig,
    _fill: normFill(s._fill as AnyStyle, white),
    _stroke: normFill(s._stroke as AnyStyle, white),
    fontString,
    finalPadding: (style as TextStyle)._getFinalPadding(),
    tick: s._tick,
  };
}

const CASES: Array<[string, AnyStyle]> = [
  ['缺省', {}],
  ['数字颜色', { fontSize: 24, fill: 0xffffff, fontFamily: 'Arial' }],
  ['#rrggbbaa', { fill: '#ff000080' }],
  ['rgba()', { fill: 'rgba(10,20,30,0.25)' }],
  ['float32 alpha', { fill: 'rgba(0,0,0,0.6)', stroke: { color: 0xffffff, alpha: 0.3, width: 2 }, dropShadow: { alpha: 0.7 } }],
  ['#rgba 短写', { fill: '#f008' }],
  ['fill 0 → black', { fill: 0 }],
  ['数组颜色', { fill: [1, 0.5, 0] }],
  ['颜色名', { fill: 'white', stroke: 'red' }],
  ['FillStyle 对象', { fill: { color: 0x00ff00, alpha: 0.5 } }],
  ['stroke 对象', { stroke: { color: 0x0000ff, width: 3 } }],
  ['stroke 颜色', { stroke: 0xff0000 }],
  ['stroke 全字段', { stroke: { color: 'white', width: 2, join: 'round', cap: 'square', miterLimit: 4, alpha: 0.5 } }],
  ['dropShadow true', { dropShadow: true }],
  ['dropShadow 对象', { dropShadow: { color: 0x000000, alpha: 0.6, blur: 4, distance: 3, angle: Math.PI / 2 } }],
  ['dropShadow 部分', { dropShadow: { distance: 2 } }],
  ['fontSize 串', { fontSize: '30px' }],
  ['fontStyle 大写', { fontStyle: 'ITALIC' }],
  ['字体族数组', { fontFamily: ['Songti SC', 'serif', '"Kaiti SC"'] }],
  ['游戏字体族串', { fontFamily: '"Songti SC", STSong, "Kaiti SC", STKaiti, serif' }],
  [
    '排版全字段',
    {
      wordWrap: true, wordWrapWidth: 200, breakWords: true, align: 'center', lineHeight: 30, leading: 4,
      letterSpacing: 2, padding: 5, whiteSpace: 'normal', textBaseline: 'middle', fontWeight: 'bold',
      fontVariant: 'small-caps', trim: true,
    },
  ],
  ['tagStyles', { tagStyles: { c1: { fill: 0xff0000 }, em: { fontWeight: 'bold', fill: '#00ff00' } } }],
  ['v7 dropShadow', { dropShadow: true, dropShadowAlpha: 0.4, dropShadowDistance: 2, dropShadowColor: 0x333333 }],
  ['v7 strokeThickness', { stroke: 0xff0000, strokeThickness: 4 }],
  ['v7 strokeThickness 对象', { stroke: { color: 0x00ff00 }, strokeThickness: 2 }],
];

describe('TextStyle 规范化与 pixi 一致', () => {
  for (const [name, opts] of CASES) {
    it(name, () => {
      const p = new PIXI.TextStyle(structuredClone(opts) as PIXI.TextStyleOptions);
      const m = new TextStyle(structuredClone(opts) as TextStyleOptions);
      expect(snapshot(m, Texture.WHITE)).toEqual(snapshot(p, PIXI.Texture.WHITE));
      expect(m.styleKey).toMatch(/^\d+-0$/);
    });
  }

  it('由已有 TextStyle 构造(_toObject 路径)', () => {
    for (const [, opts] of CASES) {
      const p = new PIXI.TextStyle(new PIXI.TextStyle(structuredClone(opts) as PIXI.TextStyleOptions));
      const m = new TextStyle(new TextStyle(structuredClone(opts) as TextStyleOptions));
      expect(snapshot(m, Texture.WHITE)).toEqual(snapshot(p, PIXI.Texture.WHITE));
    }
  });

  it('clone 与原样式同值、不同 uid', () => {
    for (const [, opts] of CASES) {
      const p = new PIXI.TextStyle(structuredClone(opts) as PIXI.TextStyleOptions).clone();
      const src = new TextStyle(structuredClone(opts) as TextStyleOptions);
      const m = src.clone();
      expect(m.uid).not.toBe(src.uid);
      expect(snapshot(m, Texture.WHITE)).toEqual(snapshot(p, PIXI.Texture.WHITE));
    }
  });
});

describe('TextStyle 改动行为与 pixi 一致', () => {
  function run(style: PIXI.TextStyle | TextStyle): { events: number; ticks: number[]; snaps: AnyStyle[] } {
    const white = style instanceof PIXI.TextStyle ? PIXI.Texture.WHITE : Texture.WHITE;
    const s = style as unknown as AnyStyle & TextStyle;
    let events = 0;
    const ticks: number[] = [];
    const snaps: AnyStyle[] = [];
    (style as TextStyle).on('update', () => {
      events++;
      ticks.push(s._tick);
    });
    s.fontSize = 30;
    s.fontSize = 30; // 同值不发
    s.fontSize = '40pt' as unknown as number;
    s.fill = 0xff0000;
    s.fill = 0xff0000;
    s.fill = { color: 0x00ff00, alpha: 0.5 };
    (s.fill as AnyStyle).alpha = 0.25; // Proxy:重算 _fill 并发 update
    snaps.push(snapshot(style, white));
    s.stroke = { color: 0x000000, width: 4 };
    (s.stroke as AnyStyle).width = 6;
    snaps.push(snapshot(style, white));
    s.dropShadow = true;
    (s.dropShadow as AnyStyle).alpha = 0.3;
    (s.dropShadow as AnyStyle).alpha = 0.3;
    snaps.push(snapshot(style, white));
    s.dropShadow = false as unknown as TextStyle['dropShadow'];
    s.fontStyle = 'OBLIQUE' as 'oblique';
    s.wordWrap = true;
    s.wordWrapWidth = 321;
    s.align = 'right';
    s.letterSpacing = 1.5;
    s.tagStyles = { a: { fill: 0x123456 } };
    s.tagStyles = undefined;
    snaps.push(snapshot(style, white));
    s.assign({ fontSize: 12, leading: 3, lineHeight: 20 });
    snaps.push(snapshot(style, white));
    s.reset();
    snaps.push(snapshot(style, white));
    return { events, ticks, snaps };
  }

  it('事件次数 / tick / 各阶段快照相同', () => {
    const p = run(new PIXI.TextStyle({ fontFamily: 'Arial' }));
    const m = run(new TextStyle({ fontFamily: 'Arial' }));
    expect(m.events).toBe(p.events);
    expect(m.ticks).toEqual(p.ticks);
    expect(m.snaps).toEqual(p.snaps);
  });

  it('_fontString 在 update 后失效重算', () => {
    const m = new TextStyle({ fontSize: 10 });
    const p = new PIXI.TextStyle({ fontSize: 10 });
    expect(m._fontString).toBe((p as unknown as AnyStyle)._fontString);
    m.fontWeight = 'bold';
    p.fontWeight = 'bold';
    expect(m._fontString).toBe((p as unknown as AnyStyle)._fontString);
  });

  it('destroy 清掉 fill / stroke / dropShadow 与监听', () => {
    const opts = { fill: 0xff0000, stroke: { color: 0, width: 2 }, dropShadow: true };
    const p = new PIXI.TextStyle(opts);
    const m = new TextStyle(opts);
    let calls = 0;
    m.on('update', () => calls++);
    p.destroy();
    m.destroy();
    expect(calls).toBe(0);
    const pp = p as unknown as AnyStyle;
    const mm = m as unknown as AnyStyle;
    expect([mm._fill, mm._stroke, mm.dropShadow, mm.fill, mm.stroke]).toEqual([pp._fill, pp._stroke, pp.dropShadow, pp.fill, pp.stroke]);
  });

  it('v7 渐变写法:参数不合法时同样报错', () => {
    expect(() => new PIXI.TextStyle({ fillGradientStops: [0, 1], fill: [] } as unknown as PIXI.TextStyleOptions)).toThrow();
    expect(() => new TextStyle({ fillGradientStops: [0, 1], fill: [] } as unknown as TextStyleOptions)).toThrow();
  });
});
