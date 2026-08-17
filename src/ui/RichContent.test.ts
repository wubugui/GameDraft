import { parseRichMarkup, resolveContentImageUrl } from './RichContent';

describe('resolveContentImageUrl (rich text [img:...] media binding)', () => {
  it('routes short asset-style ref to runtime media root', () => {
    expect(resolveContentImageUrl('images/backgrounds/back_alley_dock_bg.png')).toBe(
      '/resources/runtime/images/backgrounds/back_alley_dock_bg.png',
    );
  });

  it('passes through full runtime URL', () => {
    expect(
      resolveContentImageUrl('/resources/runtime/images/illustrations/x.png'),
    ).toBe('/resources/runtime/images/illustrations/x.png');
  });

  it('returns empty string for assets-rooted media (forbidden after migration)', () => {
    expect(resolveContentImageUrl('/assets/images/x.png')).toBe('');
    expect(resolveContentImageUrl('assets/images/x.png')).toBe('');
  });

  it('returns empty string for unknown absolute URL', () => {
    expect(resolveContentImageUrl('/foo/bar.png')).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(resolveContentImageUrl('')).toBe('');
  });
});

describe('parseRichMarkup (块级标记 → RichBlock)', () => {
  it('空行分段、行首 [h]/[hr] 成块', () => {
    expect(parseRichMarkup('[h]来历\n第一段\n还是第一段\n\n第二段\n[hr]')).toEqual([
      { kind: 'heading', text: '来历' },
      { kind: 'paragraph', text: '第一段\n还是第一段' },
      { kind: 'paragraph', text: '第二段' },
      { kind: 'divider' },
    ]);
  });

  it('[img:] 独立成块并识别档位，[caption] 附到前一张图', () => {
    expect(parseRichMarkup('[img:images/a.png|wide]\n[caption]城隍庙旧照')).toEqual([
      { kind: 'image', path: 'images/a.png', size: 'wide', caption: '城隍庙旧照' },
    ]);
  });

  it('段中混排 [img:]（v1 兼容语义）切成 文/图/文', () => {
    expect(parseRichMarkup('前文[img:images/a.png]后文')).toEqual([
      { kind: 'paragraph', text: '前文' },
      { kind: 'image', path: 'images/a.png', size: 'inline' },
      { kind: 'paragraph', text: '后文' },
    ]);
  });

  it('[quote] 块成引文；漏写闭合不吃内容', () => {
    expect(parseRichMarkup('[quote]床板要竖着放\n[/quote]')).toEqual([
      { kind: 'quote', text: '床板要竖着放' },
    ]);
    expect(parseRichMarkup('[quote]没闭合的引文')).toEqual([
      { kind: 'quote', text: '没闭合的引文' },
    ]);
  });

  it('正文里的 [c:] 标记原样留在段文本里（行内层的事）', () => {
    expect(parseRichMarkup('这句有[c:clue]线索[/c]在内')).toEqual([
      { kind: 'paragraph', text: '这句有[c:clue]线索[/c]在内' },
    ]);
  });
});
