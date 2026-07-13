import { describe, expect, it } from 'vitest';
import { createDeterministicRandom, DeterministicRandom, seedUtf8Fnv1a } from './deterministicRandom';

describe('cross-runtime deterministic random', () => {
  it('uses UTF-8 FNV-1a and a stable xorshift32 stream, including Chinese ids', () => {
    expect(seedUtf8Fnv1a('转盘_生肖')).toBe(0x2f0068cd);
    const a = createDeterministicRandom('转盘_生肖');
    const b = createDeterministicRandom('转盘_生肖');
    const sequence = Array.from({ length: 4 }, () => a());
    expect(sequence).toEqual(Array.from({ length: 4 }, () => b()));
    expect(sequence).toEqual([
      0.3794385122600943,
      0.6201965021900833,
      0.16621697833761573,
      0.08592581795528531,
    ]);
  });

  it('restores the exact next value from a saved state', () => {
    const a = new DeterministicRandom('gamedraft-runtime-v1');
    a.next();
    const state = a.getState();
    const expected = a.next();
    const b = new DeterministicRandom('different');
    b.setState(state);
    expect(b.next()).toBe(expected);
  });
});
