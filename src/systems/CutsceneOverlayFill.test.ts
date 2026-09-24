import { describe, expect, it, vi } from 'vitest';
import { CutsceneManager } from './CutsceneManager';

/**
 * 叠图「铺满窗口」（showOverlayImage 的 `fill`）：勾了走 cover 画法（等比盖满整屏、
 * 随窗口缩放重铺），没勾照旧按屏幕百分比定位。句柄与 hideOverlayImage 共用同一张表。
 */
function makeRig() {
  const renderer = {
    showImg: vi.fn(() => Promise.resolve()),
    showPercentImg: vi.fn(() => Promise.resolve()),
    hideImg: vi.fn(),
  } as any;
  const eventBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() } as any;
  const mgr = new CutsceneManager(eventBus, {} as any, { executeAwait: vi.fn() } as any, renderer);
  return { mgr, renderer };
}

describe('showOverlayImage · 铺满窗口', () => {
  it('fill=true 走 cover 画法，order 照传，百分比不参与', async () => {
    const { mgr, renderer } = makeRig();
    await mgr.showOverlayImage('ov', '/a.png', 10, 20, 30, 5, true);
    expect(renderer.showImg).toHaveBeenCalledWith('/a.png', 'ov', undefined, 5);
    expect(renderer.showPercentImg).not.toHaveBeenCalled();
  });

  it('不给 fill 照旧按百分比定位', async () => {
    const { mgr, renderer } = makeRig();
    await mgr.showOverlayImage('ov', '/a.png', 10, 20, 30);
    expect(renderer.showPercentImg).toHaveBeenCalledWith('/a.png', 'ov', 10, 20, 30, undefined);
    expect(renderer.showImg).not.toHaveBeenCalled();
  });

  it('两种画法收图都走同一个句柄', () => {
    const { mgr, renderer } = makeRig();
    mgr.hideOverlayImage('ov');
    expect(renderer.hideImg).toHaveBeenCalledWith('ov');
  });
});
