/**
 * 光柱噪声哈希的融合乘加(见 vfxBeamWgsl 的 BEAM_WGSL_CORE 头注释):bmHash 第一步照 master(FXC 的 mad =
 * 融合乘加)精确算。这里用 Math.fround 逐运算照抄 WGSL 里的 bmFmaEmu(f32 语义),与精确融合乘加比。
 */
import { describe, expect, it } from 'vitest';
import { BEAM_WGSL_CORE } from './vfxBeamWgsl';

const f = Math.fround;

/** WGSL bmTwoProdErr / bmFmaEmu 的逐句 f32 照抄 */
function twoProdErr(a: number, b: number, p: number): number {
  const ca = f(4097 * a);
  const ah = f(ca - f(ca - a));
  const al = f(a - ah);
  const cb = f(4097 * b);
  const bh = f(cb - f(cb - b));
  const bl = f(b - bh);
  return f(f(f(f(f(ah * bh) - p) + f(ah * bl)) + f(al * bh)) + f(al * bl));
}

function fmaEmu(a: number, b: number, c: number): number {
  const p = f(a * b);
  const e = twoProdErr(a, b, p);
  const s = f(p + c);
  const bv = f(s - p);
  const es = f(f(p - f(s - bv)) + f(c - bv));
  return f(s + f(es + e));
}

/** 精确融合乘加:f32 × f32 在 double 里精确,加 c 后只舍入一次到 f32(double 的 53 位足够容纳并由 fround 舍入) */
const fmaExact = (a: number, b: number, c: number) => f(f(a) * f(b) + f(c));

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('光柱哈希的融合乘加', () => {
  it('bmFmaEmu 的 f32 照抄与精确融合乘加逐位相同(哈希实际用到的量级)', () => {
    const rnd = mulberry32(20260927);
    const k = f(0.3183099);
    let mismatch = 0;
    for (let i = 0; i < 20000; i++) {
      const x = f((rnd() - 0.5) * 4000); // 噪声格点坐标(世界 wu × 频率)的量级
      const c = f([0.71, 0.113, 0.419][i % 3]);
      if (fmaEmu(x, k, c) !== fmaExact(x, k, c)) mismatch++;
    }
    expect(mismatch).toBe(0);
  });

  it('先乘后加(未融合)与精确融合乘加确实不同——这正是要消掉的差', () => {
    const rnd = mulberry32(7);
    const k = f(0.3183099);
    let differ = 0;
    for (let i = 0; i < 20000; i++) {
      const x = f((rnd() - 0.5) * 4000);
      if (f(f(x * k) + f(0.71)) !== fmaExact(x, k, 0.71)) differ++;
    }
    expect(differ).toBeGreaterThan(1000);
  });

  it('WGSL 的 bmHash 三个分量都走 bmFmaEmu', () => {
    const body = /fn bmHash\([\s\S]*?\n\}/.exec(BEAM_WGSL_CORE)?.[0] ?? '';
    expect(body.match(/bmFmaEmu\(/g)?.length).toBe(3);
    expect(body).not.toMatch(/pIn \* 0\.3183099 \+/);
  });
});
