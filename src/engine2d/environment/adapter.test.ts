/**
 * DOMAdapter 与 pixi.js 8.17 对照:接口项一致、缺省是浏览器适配器、set 整个替换;
 * 以及游戏测试里的用法(`DOMAdapter.set({ ...adapter0, createCanvas: ... })` 后再换回)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DOMAdapter as PixiDOMAdapter, BrowserAdapter as PixiBrowserAdapter } from 'pixi.js';
import { BrowserAdapter, DOMAdapter } from './adapter';

afterEach(() => {
  DOMAdapter.set(BrowserAdapter);
  vi.unstubAllGlobals();
});

describe('DOMAdapter', () => {
  it('接口项与 Pixi 的 BrowserAdapter 完全相同', () => {
    expect(Object.keys(BrowserAdapter).sort()).toEqual(Object.keys(PixiBrowserAdapter).sort());
    expect(Object.keys(DOMAdapter).sort()).toEqual(Object.keys(PixiDOMAdapter).sort());
  });

  it('缺省是 BrowserAdapter;set 整个替换,可换回', () => {
    expect(DOMAdapter.get()).toBe(BrowserAdapter);
    const adapter0 = DOMAdapter.get();
    const fake = { getContext: () => null };
    DOMAdapter.set({ ...adapter0, createCanvas: () => fake as never });
    expect(DOMAdapter.get().createCanvas()).toBe(fake);
    expect(DOMAdapter.get().getBaseUrl).toBe(adapter0.getBaseUrl);
    DOMAdapter.set(adapter0);
    expect(DOMAdapter.get()).toBe(BrowserAdapter);
  });

  it('BrowserAdapter 的各项与 Pixi 行为一致(假 document / window / navigator)', () => {
    const created: Array<{ width?: number; height?: number }> = [];
    vi.stubGlobal('document', {
      createElement: (tag: string) => {
        const el = { tag, width: 300, height: 150 };
        created.push(el);
        return el;
      },
      baseURI: 'http://host/base/',
      fonts: { tag: 'fonts' },
    });
    vi.stubGlobal('window', { location: { href: 'http://host/href' } });
    vi.stubGlobal('navigator', { userAgent: 'ua', gpu: null });
    for (const adapter of [BrowserAdapter, PixiBrowserAdapter as unknown as typeof BrowserAdapter]) {
      created.length = 0;
      const c = adapter.createCanvas(10, 20) as unknown as { tag: string; width: number; height: number };
      expect(c).toEqual({ tag: 'canvas', width: 10, height: 20 });
      // 不给宽高:照样赋值(undefined)
      const c2 = adapter.createCanvas() as unknown as { width: unknown; height: unknown };
      expect(c2.width).toBeUndefined();
      expect(c2.height).toBeUndefined();
      expect(adapter.getBaseUrl()).toBe('http://host/base/');
      expect(adapter.getFontFaceSet()).toEqual({ tag: 'fonts' });
      expect(adapter.getNavigator()).toEqual({ userAgent: 'ua', gpu: null });
    }
    vi.stubGlobal('document', { createElement: () => ({}), baseURI: null, fonts: null });
    expect(BrowserAdapter.getBaseUrl()).toBe('http://host/href');
    expect(PixiBrowserAdapter.getBaseUrl()).toBe('http://host/href');
  });

  it('fetch 透传给全局 fetch(url, options)', async () => {
    const calls: unknown[][] = [];
    vi.stubGlobal('fetch', async (...args: unknown[]) => {
      calls.push(args);
      return { ok: true } as Response;
    });
    await BrowserAdapter.fetch('http://x/a.png', { method: 'HEAD' });
    await PixiBrowserAdapter.fetch('http://x/a.png', { method: 'HEAD' });
    expect(calls[0]).toEqual(calls[1]);
  });
});
