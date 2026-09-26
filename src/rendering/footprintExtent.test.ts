import { describe, expect, it } from 'vitest';
import { medianFootprint, mirrorFootprint, scanFootprint } from './footprintExtent';

/** 造一条 w×h 的 RGBA 像素，给定的 [x0,x1) × [y0,y1) 矩形不透明。 */
function strip(w: number, h: number, boxes: [number, number, number, number][]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (const [x0, x1, y0, y1] of boxes) {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) d[(y * w + x) * 4 + 3] = 255;
  }
  return d;
}

describe('scanFootprint：剪影贴地那一截的左右范围', () => {
  it('两只脚贴着帧底：范围从左脚左沿到右脚右沿（两脚之间的空隙算在里面）', () => {
    const d = strip(100, 40, [[30, 40, 30, 40], [55, 68, 32, 40]]);
    expect(scanFootprint(d, 100, 40, 6)).toEqual({ lo: 0.3, hi: 0.68 });
  });

  it('脚离帧底有透明边：从最低的不透明行往上找，照样找得到（帧底 ≠ 脚底）', () => {
    const d = strip(100, 40, [[40, 60, 20, 28]]);          // 最低行 27，帧底 39
    expect(scanFootprint(d, 100, 40, 4)).toEqual({ lo: 0.4, hi: 0.6 });
  });

  it('只取最低那一截：上面更宽的身体不算', () => {
    const d = strip(100, 40, [[10, 90, 0, 20], [45, 55, 20, 40]]);   // 宽身子在上，窄腿在下
    expect(scanFootprint(d, 100, 40, 6)).toEqual({ lo: 0.45, hi: 0.55 });
  });

  it('整条都透明：null（这一帧底部没东西挨地，不画接触阴影）', () => {
    expect(scanFootprint(strip(50, 20, []), 50, 20, 4)).toBeNull();
  });

  it('半透明（低于阈值）不算贴地', () => {
    const d = strip(50, 10, []);
    for (let x = 0; x < 50; x++) d[(9 * 50 + x) * 4 + 3] = 100;
    expect(scanFootprint(d, 50, 10, 3)).toBeNull();
  });
});

describe('mirrorFootprint：显示朝向与图集相反时关于帧中线翻', () => {
  it('镜像', () => {
    expect(mirrorFootprint({ lo: 0.2, hi: 0.5 }, true)).toEqual({ lo: 0.5, hi: 0.8 });
  });
  it('不镜像原样', () => {
    const fp = { lo: 0.2, hi: 0.5 };
    expect(mirrorFootprint(fp, false)).toBe(fp);
  });
});

describe('medianFootprint：身体胶囊按站立片段定一份，不跟每帧步幅变', () => {
  it('中心、半宽各取中位数：偶尔挪一下脚的那一帧不带偏', () => {
    const fp = medianFootprint([
      { lo: 0.4, hi: 0.6 }, { lo: 0.4, hi: 0.6 }, { lo: 0.1, hi: 0.9 }, { lo: 0.42, hi: 0.62 },
    ])!;
    // 中心 0.5 / 0.5 / 0.5 / 0.52 → 0.5；半宽 0.1 / 0.1 / 0.4 / 0.1 → 0.1
    expect(fp.lo).toBeCloseTo(0.4, 10);
    expect(fp.hi).toBeCloseTo(0.6, 10);
  });

  it('偶数帧取中间两个的平均', () => {
    const fp = medianFootprint([{ lo: 0.4, hi: 0.6 }, { lo: 0.5, hi: 0.9 }])!;
    expect((fp.lo + fp.hi) / 2).toBeCloseTo(0.6, 10);   // 中心 0.5、0.7
    expect((fp.hi - fp.lo) / 2).toBeCloseTo(0.15, 10);  // 半宽 0.1、0.2
  });

  it('挨不着地的帧不参与；全都挨不着地 ⇒ null', () => {
    const one = medianFootprint([null, { lo: 0.3, hi: 0.5 }, null])!;
    expect(one.lo).toBeCloseTo(0.3, 10);
    expect(one.hi).toBeCloseTo(0.5, 10);
    expect(medianFootprint([null, null])).toBeNull();
    expect(medianFootprint([])).toBeNull();
  });

  it('有帧读不到像素 ⇒ undefined（调用方不缓存、退回按当前帧）', () => {
    expect(medianFootprint([{ lo: 0.3, hi: 0.5 }, undefined])).toBeUndefined();
  });
});
