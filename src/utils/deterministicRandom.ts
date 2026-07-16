/** Stable cross-runtime PRNG: UTF-8 FNV-1a seed followed by xorshift32. */
export function seedUtf8Fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  }
  return hash || 1;
}

export function createDeterministicRandom(seedText: string): () => number {
  const random = new DeterministicRandom(seedText);
  return () => random.next();
}

export class DeterministicRandom {
  private state: number;

  constructor(seedText: string) {
    this.state = seedUtf8Fnv1a(seedText);
  }

  next(): number {
    let x = this.state >>> 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state / 0x100000000;
  }

  getState(): number {
    return this.state >>> 0;
  }

  setState(value: unknown): void {
    const numeric = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(numeric)) this.state = (Math.trunc(numeric) >>> 0) || 1;
  }
}
