import { resolveContentImageUrl } from './RichContent';

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
