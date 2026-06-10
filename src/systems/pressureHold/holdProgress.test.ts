import { describe, expect, it } from 'vitest';
import { HoldProgress, clamp01, validateInterruptRatios } from './holdProgress';

describe('HoldProgress', () => {
  it('按住时按 fillSeconds 线性充能，到停点截断', () => {
    const p = new HoldProgress({ startRatio: 0, stopRatio: 0.6, fillSeconds: 2, decayPerSecond: 0.5 });
    p.tick(1, true);
    expect(p.current).toBeCloseTo(0.5);
    expect(p.reachedStop).toBe(false);
    p.tick(1, true);
    expect(p.current).toBeCloseTo(0.6);
    expect(p.reachedStop).toBe(true);
  });

  it('松手时按 decayPerSecond 回落，不低于 0', () => {
    const p = new HoldProgress({ startRatio: 0, stopRatio: 1, fillSeconds: 2, decayPerSecond: 0.4 });
    p.tick(1, true); // 0.5
    p.tick(0.5, false);
    expect(p.current).toBeCloseTo(0.3);
    p.tick(10, false);
    expect(p.current).toBe(0);
  });

  it('到达停点后 tick 不再改变进度', () => {
    const p = new HoldProgress({ startRatio: 0.5, stopRatio: 0.6, fillSeconds: 1, decayPerSecond: 1 });
    p.tick(1, true);
    expect(p.current).toBeCloseTo(0.6);
    p.tick(1, false);
    expect(p.current).toBeCloseTo(0.6);
  });

  it('非法 dt 被忽略', () => {
    const p = new HoldProgress({ startRatio: 0, stopRatio: 1, fillSeconds: 1, decayPerSecond: 1 });
    p.tick(NaN, true);
    p.tick(-1, true);
    expect(p.current).toBe(0);
  });

  it('非法配置抛错', () => {
    expect(() => new HoldProgress({ startRatio: 0, stopRatio: 1, fillSeconds: 0, decayPerSecond: 1 })).toThrow();
    expect(() => new HoldProgress({ startRatio: 0.7, stopRatio: 0.6, fillSeconds: 1, decayPerSecond: 1 })).toThrow();
  });
});

describe('validateInterruptRatios', () => {
  it('排序并通过合法配置', () => {
    expect(validateInterruptRatios([0.9, 0.6])).toEqual([0.6, 0.9]);
  });
  it('越界与重复抛错', () => {
    expect(() => validateInterruptRatios([0])).toThrow();
    expect(() => validateInterruptRatios([1])).toThrow();
    expect(() => validateInterruptRatios([0.5, 0.5])).toThrow();
  });
});

describe('clamp01', () => {
  it('夹取范围并兜底非数', () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(NaN)).toBe(0);
    expect(clamp01(0.4)).toBe(0.4);
  });
});
