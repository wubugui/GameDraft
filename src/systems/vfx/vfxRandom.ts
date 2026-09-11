/**
 * 粒子系统的确定性随机源。**不许用 `Math.random`**：同一份场景 + 同一串 dt ⇒ 逐位相同，
 * 无头验证靠它逐帧断言。
 */

/** mulberry32：32 位状态、周期 2^32，足够粒子用。 */
export class VfxRng {
  private s: number;

  constructor(seed: number) {
    this.s = (seed >>> 0) || 0x9e3779b9;
  }

  /** [0, 1) */
  next(): number {
    let t = (this.s += 0x6d2b79f5) >>> 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** [a, b) */
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }

  /** 区间 `[min,max]` 的二元组形式 */
  pair(r: readonly [number, number] | undefined, fallback: number): number {
    if (!r) return fallback;
    return this.range(r[0], r[1]);
  }

  /** 单位球面均匀方向 */
  unitVector(out: Float32Array | number[] = [0, 0, 0], o = 0): Float32Array | number[] {
    const z = this.range(-1, 1);
    const a = this.range(0, Math.PI * 2);
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    out[o] = r * Math.cos(a);
    out[o + 1] = z;
    out[o + 2] = r * Math.sin(a);
    return out;
  }

  /** 围绕 `dir`（单位向量）半角 `spreadRad` 的圆锥内均匀方向 */
  coneVector(dir: readonly number[], spreadRad: number, out: number[] = [0, 0, 0]): number[] {
    if (spreadRad <= 1e-6) {
      out[0] = dir[0]; out[1] = dir[1]; out[2] = dir[2];
      return out;
    }
    const cosMax = Math.cos(spreadRad);
    const cz = this.range(cosMax, 1);
    const sz = Math.sqrt(Math.max(0, 1 - cz * cz));
    const phi = this.range(0, Math.PI * 2);
    // 局部基：dir 为 z
    const dx = dir[0], dy = dir[1], dz = dir[2];
    const ax = Math.abs(dy) < 0.9 ? 0 : 1, ay = Math.abs(dy) < 0.9 ? 1 : 0;
    // u = normalize(cross(up, dir))
    let ux = ay * dz - 0 * dy, uy = 0 * dx - ax * dz, uz = ax * dy - ay * dx;
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul; uy /= ul; uz /= ul;
    // v = cross(dir, u)
    const vx = dy * uz - dz * uy, vy = dz * ux - dx * uz, vz = dx * uy - dy * ux;
    const cp = Math.cos(phi) * sz, sp = Math.sin(phi) * sz;
    out[0] = dx * cz + ux * cp + vx * sp;
    out[1] = dy * cz + uy * cp + vy * sp;
    out[2] = dz * cz + uz * cp + vz * sp;
    return out;
  }
}

/** 字符串 → 32 位种子（FNV-1a）。实例没写 seed 时按 id 派生，同名同种子。 */
export function hashSeed(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
