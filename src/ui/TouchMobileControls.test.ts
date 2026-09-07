import { describe, expect, it } from 'vitest';

import { decideTouchUi, type TouchUiSignals } from './TouchMobileControls';

const base: TouchUiSignals = {
  shortSide: 1080,
  anyPointerFine: true,
  pointerCoarse: false,
  hasTouch: false,
  uaMobile: false,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/148.0',
};

describe('decideTouchUi：触屏 HUD 还是桌面 HUD', () => {
  it('普通桌面（鼠标、无触摸）→ 桌面', () => {
    expect(decideTouchUi(base)).toBe(false);
  });

  it('真手机：主指针 coarse → 触屏（快车道，不看别的）', () => {
    expect(decideTouchUi({ ...base, shortSide: 390, anyPointerFine: false, pointerCoarse: true, hasTouch: true })).toBe(true);
  });

  it('硬否决：桌面尺寸屏 + 系统里有精确指针，即使主指针被报成 coarse 也按桌面', () => {
    expect(decideTouchUi({ ...base, shortSide: 1080, anyPointerFine: true, pointerCoarse: true, hasTouch: true })).toBe(false);
  });

  it('QtWebEngine（编辑器预览 / 打包验收扫描）一律桌面——它在触屏 PC 上把 coarse=true、any-pointer:fine=false，硬否决够不着', () => {
    const qt = { ...base, shortSide: 540, anyPointerFine: false, pointerCoarse: true, hasTouch: true,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) QtWebEngine/6.11.2 Chrome/140.0.7339.225 Safari/537.36' };
    expect(decideTouchUi(qt)).toBe(false);
    // 同样的信号换成 WebView2/Chrome 的 UA 仍走原判据（coarse 快车道 → 触屏）
    expect(decideTouchUi({ ...qt, userAgent: base.userAgent })).toBe(true);
  });

  it('coarse 漏报的真手机：有触摸 + UA 说是手机 → 触屏', () => {
    expect(decideTouchUi({ ...base, shortSide: 412, anyPointerFine: false, hasTouch: true,
      userAgent: 'Mozilla/5.0 (Linux; Android 14) Mobile Chrome/140' })).toBe(true);
    expect(decideTouchUi({ ...base, shortSide: 412, anyPointerFine: false, hasTouch: true, uaMobile: true })).toBe(true);
  });

  it('触屏显示器 / 数位板：有触摸但屏幕是桌面尺寸、UA 是桌面 → 桌面', () => {
    expect(decideTouchUi({ ...base, shortSide: 1440, anyPointerFine: false, hasTouch: true })).toBe(false);
  });

  it('coarse 漏报 + 屏幕短边在门限内 → 触屏（兜底支的最后一条）', () => {
    expect(decideTouchUi({ ...base, shortSide: 768, anyPointerFine: false, hasTouch: true })).toBe(true);
  });
});
