import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DEFAULT_TEXT_PALETTE,
  hasStyleMarkup,
  inspectStyleMarkup,
  isKnownPaletteId,
  paletteTagStyles,
  plainTextLength,
  setTextPalette,
  stripStyleMarkup,
  toPixiTagged,
} from './textStyle';

describe('textStyle 色板注入', () => {
  beforeEach(() => setTextPalette(undefined));

  it('缺省回落到内置色板', () => {
    expect(isKnownPaletteId('emphasis')).toBe(true);
    expect(Object.keys(paletteTagStyles()).sort()).toEqual(
      DEFAULT_TEXT_PALETTE.map((e) => e.id).sort(),
    );
  });

  it('game_config 的色板顶替内置', () => {
    setTextPalette([{ id: 'ghost', label: '鬼', color: '#123456' }]);
    expect(isKnownPaletteId('ghost')).toBe(true);
    expect(isKnownPaletteId('emphasis')).toBe(false);
    expect(paletteTagStyles().ghost.fill).toBe(0x123456);
  });

  it('空表 / 全非法条目回落到内置，不留空色板', () => {
    setTextPalette([]);
    expect(isKnownPaletteId('emphasis')).toBe(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setTextPalette([{ id: '坏 id', label: 'x', color: '#fff' }]);
    expect(isKnownPaletteId('emphasis')).toBe(true);
    warn.mockRestore();
  });

  it('非法颜色的那一条被跳过，其余仍生效', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setTextPalette([
      { id: 'ok', label: '好', color: '#ABCDEF' },
      { id: 'bad', label: '坏', color: 'red' },
    ]);
    expect(isKnownPaletteId('ok')).toBe(true);
    expect(isKnownPaletteId('bad')).toBe(false);
    warn.mockRestore();
  });
});

describe('stripStyleMarkup', () => {
  beforeEach(() => setTextPalette(undefined));

  it('无标记时原样返回（含 undefined）', () => {
    expect(stripStyleMarkup('关二狗')).toBe('关二狗');
    expect(stripStyleMarkup(undefined)).toBe('');
    expect(hasStyleMarkup('关二狗')).toBe(false);
  });

  it('去掉成对与残缺标记，正文一个字不掉', () => {
    expect(stripStyleMarkup('前[c:emphasis]中[/c]后')).toBe('前中后');
    expect(stripStyleMarkup('[c:emphasis]没闭合')).toBe('没闭合');
    expect(stripStyleMarkup('多余[/c]闭合')).toBe('多余闭合');
    expect(stripStyleMarkup('[c:nope]未知色板[/c]')).toBe('未知色板');
  });

  it('plainTextLength = 可见字数', () => {
    expect(plainTextLength('前[c:emphasis]中[/c]后')).toBe(3);
  });
});

describe('toPixiTagged', () => {
  beforeEach(() => setTextPalette(undefined));

  it('无标记快路径原样返回', () => {
    expect(toPixiTagged('一句普通台词')).toBe('一句普通台词');
  });

  it('成对标记翻成 Pixi tagged text', () => {
    expect(toPixiTagged('前[c:emphasis]中[/c]后')).toBe('前<emphasis>中</emphasis>后');
  });

  it('嵌套按栈配对', () => {
    expect(toPixiTagged('[c:emphasis]a[c:danger]b[/c]c[/c]'))
      .toBe('<emphasis>a<danger>b</danger>c</emphasis>');
  });

  it('未闭合自动补齐（Pixi 要求成对）', () => {
    expect(toPixiTagged('[c:emphasis]没闭合')).toBe('<emphasis>没闭合</emphasis>');
  });

  it('多余闭合被忽略，不产生野标签', () => {
    expect(toPixiTagged('多余[/c]闭合')).toBe('多余闭合');
  });

  it('未知色板 id 丢标记留正文', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(toPixiTagged('[c:nope]正文[/c]尾')).toBe('正文尾');
    warn.mockRestore();
  });

  it('未知 id 的闭合不会错配掉外层标记', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(toPixiTagged('[c:emphasis]a[c:nope]b[/c]c[/c]d'))
      .toBe('<emphasis>abc</emphasis>d');
    warn.mockRestore();
  });

  it('无标记时裸 < 原样透传（串里没有 tag，Pixi 不会吃掉别人）', () => {
    expect(toPixiTagged('小于号 < 与 <emphasis> 字面量')).toBe('小于号 < 与 <emphasis> 字面量');
  });

  it('有标记又有裸 < 时降级为纯文本，绝不吐出裸标记', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = toPixiTagged('温度<0[c:danger]危险[/c]');
    expect(out).toBe('温度<0危险');
    expect(out).not.toContain('<danger>');
    expect(out).not.toContain('[c:');
    warn.mockRestore();
  });

  it('降级路径的截断仍按可见字数（不吞字）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = '温度<0[c:danger]危险[/c]';
    expect(plainTextLength(raw)).toBe(6);
    expect(toPixiTagged(raw, 6)).toBe('温度<0危险');
    expect(toPixiTagged(raw, 4)).toBe('温度<0');
    warn.mockRestore();
  });

  it('无标记快路径按可见字数截断，含 < 也不少字（曾因先转义再切吞掉末字）', () => {
    const raw = 'a<bcd';
    expect(plainTextLength(raw)).toBe(5);
    expect(toPixiTagged(raw, 5)).toBe('a<bcd');
    expect(toPixiTagged(raw, 2)).toBe('a<');
  });
});

describe('toPixiTagged 截断（打字机）', () => {
  beforeEach(() => setTextPalette(undefined));

  it('按可见字数截断且标记始终成对', () => {
    const raw = '前[c:emphasis]中间[/c]后';
    expect(toPixiTagged(raw, 0)).toBe('');
    expect(toPixiTagged(raw, 1)).toBe('前');
    expect(toPixiTagged(raw, 2)).toBe('前<emphasis>中</emphasis>');
    expect(toPixiTagged(raw, 3)).toBe('前<emphasis>中间</emphasis>');
    expect(toPixiTagged(raw, 4)).toBe('前<emphasis>中间</emphasis>后');
    expect(toPixiTagged(raw, 99)).toBe(toPixiTagged(raw));
  });

  it('无标记文本按字截断', () => {
    expect(toPixiTagged('一二三四', 2)).toBe('一二');
  });

  it('截断点落在标记边界上也不吐半个标签', () => {
    const raw = '[c:danger]危[/c][c:emphasis]险[/c]';
    expect(toPixiTagged(raw, 1)).toBe('<danger>危</danger>');
    expect(toPixiTagged(raw, 2)).toBe('<danger>危</danger><emphasis>险</emphasis>');
  });
});

describe('inspectStyleMarkup（校验用）', () => {
  beforeEach(() => setTextPalette(undefined));

  it('干净文本零问题', () => {
    expect(inspectStyleMarkup('前[c:emphasis]中[/c]后'))
      .toEqual({ unknownIds: [], strayCloses: 0, unclosed: 0, malformed: [] });
  });

  it('非 ASCII slug 的 id 单列出来（不闭合时三项检查全过、剥不掉、会糊给玩家）', () => {
    expect(inspectStyleMarkup('[c:强调]很重要')).toMatchObject({ malformed: ['强调'] });
    expect(inspectStyleMarkup('[c:emphasis]好的[/c]')).toMatchObject({ malformed: [] });
  });

  it('报出未知 id / 多余闭合 / 未闭合', () => {
    expect(inspectStyleMarkup('[c:nope]x[/c]')).toMatchObject({ unknownIds: ['nope'] });
    expect(inspectStyleMarkup('x[/c]')).toMatchObject({ strayCloses: 1 });
    expect(inspectStyleMarkup('[c:emphasis]x')).toMatchObject({ unclosed: 1 });
  });
});
