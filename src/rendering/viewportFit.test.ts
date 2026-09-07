import { describe, expect, it } from 'vitest';

import { containBox } from './viewportFit';

describe('containBox：逻辑视口等比放进可用区', () => {
  it('exe 默认窗 1280×720 放 4:3 → 960×720 柱箱（不再横向拉伸）', () => {
    expect(containBox(1280, 720, 1024, 768)).toEqual({ width: 960, height: 720, scale: 0.9375 });
  });

  it('最大化 1920×1080 → 1440×1080', () => {
    const b = containBox(1920, 1080, 1024, 768);
    expect([b.width, b.height]).toEqual([1440, 1080]);
    expect(b.scale).toBeCloseTo(1.40625);
  });

  it('编辑器预览窗 1024×768 → 原尺寸', () => {
    expect(containBox(1024, 768, 1024, 768)).toEqual({ width: 1024, height: 768, scale: 1 });
  });

  it('比 4:3 更窄的窗（竖屏）→ 宽度顶满、上下留黑', () => {
    const b = containBox(768, 1024, 1024, 768);
    expect([b.width, b.height]).toEqual([768, 576]);
  });

  it('exe 最小窗 512×384 → 等比缩小，不失真', () => {
    expect(containBox(512, 384, 1024, 768)).toEqual({ width: 512, height: 384, scale: 0.5 });
  });

  it('参数不合法（可用区还没布局出来 = 0）→ 0 盒，不抛', () => {
    expect(containBox(0, 0, 1024, 768).scale).toBe(0);
    expect(containBox(1280, 720, 0, 768).scale).toBe(0);
    expect(containBox(Number.NaN, 720, 1024, 768).scale).toBe(0);
  });

  it('结果永远不超出可用区', () => {
    for (const [w, h] of [[1279, 721], [333, 999], [2560, 1440], [1366, 768]]) {
      const b = containBox(w, h, 1024, 768);
      expect(b.width).toBeLessThanOrEqual(w);
      expect(b.height).toBeLessThanOrEqual(h);
      expect(Math.abs(b.width / b.height - 4 / 3)).toBeLessThan(0.01);
    }
  });
});
