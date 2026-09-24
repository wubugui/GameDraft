import { describe, expect, it } from 'vitest';
import { pickBoltVariant } from './strikePresentation';

/**
 * 雷形变体：同一条雷链里不重样（2026-09-23：一次施法五道雷各自独立抽，9 次里只有 3 次五道全不同，
 * 同一张雷形在一场雷暴里出现两次一眼就露馅）。
 */
const POOL = Array.from({ length: 10 }, (_, i) => `lightning_bolt_${String(i + 1).padStart(2, '0')}`);

describe('pickBoltVariant', () => {
  it('一条链里五道雷五个不同的雷形，哪怕五个随机数一模一样', () => {
    const used = new Set<string>();
    const picks = [0.3, 0.3, 0.3, 0.3, 0.3].map((r) => pickBoltVariant(POOL, r, used));
    expect(new Set(picks).size).toBe(5);
    expect(used.size).toBe(5);
  });

  it('池用完了才允许重复（十道以上）', () => {
    const used = new Set<string>();
    const picks = Array.from({ length: 12 }, (_, i) => pickBoltVariant(POOL, (i * 0.37) % 1, used));
    expect(new Set(picks.slice(0, 10)).size).toBe(10);
    expect(picks.slice(10).every((p) => p !== null && POOL.includes(p))).toBe(true);
  });

  it('只在没用过的里挑：随机数落在剩下那几个上，不是整池再挑一遍', () => {
    const used = new Set(POOL.slice(0, 9));
    expect(pickBoltVariant(POOL, 0, used)).toBe('lightning_bolt_10');
    expect(pickBoltVariant(POOL, 0.999, new Set(POOL.slice(1)))).toBe('lightning_bolt_01');
  });

  it('空池返回 null（调用方退回单个 effect）；随机数越界 / 非有限值不越界取', () => {
    expect(pickBoltVariant([], 0.5, new Set())).toBeNull();
    expect(POOL).toContain(pickBoltVariant(POOL, 1, new Set()));
    expect(POOL).toContain(pickBoltVariant(POOL, Number.NaN, new Set()));
    expect(POOL).toContain(pickBoltVariant(POOL, -3, new Set()));
  });
});
