// 程序性天空的回归护栏：旧路径逐位不变 + 新旋钮确实改变 l=0/l=1。
import { describe, expect, it } from 'vitest';

import { evalSh, skyIrradianceSh } from './skySh';

const unpack = (p: Float32Array): number[][] => {
  const out: number[][] = [[], [], []];
  for (let k = 0; k < 9; k += 1) {
    for (let c = 0; c < 3; c += 1) out[c].push(p[k * 4 + c]);
  }
  return out;
};
const lum = (sh: number[][], x: number, y: number, z: number): number =>
  0.2126 * evalSh(sh[0], x, y, z) + 0.7152 * evalSh(sh[1], x, y, z) + 0.0722 * evalSh(sh[2], x, y, z);

const chroma = (sh: number[][], x: number, y: number, z: number): string => {
  const r = evalSh(sh[0], x, y, z), g = evalSh(sh[1], x, y, z), b = evalSh(sh[2], x, y, z);
  const m = (r + g + b) / 3 || 1;
  return `[${(r / m).toFixed(2)}, ${(g / m).toFixed(2)}, ${(b / m).toFixed(2)}]`;
};

// 太阳在 +X（"西"）、压得很低
const SUN_W = [0.966, 0.259, 0] as const;    // 仰角 15°
const W = [1, 0, 0] as const;                 // 朝西的竖直面
const E = [-1, 0, 0] as const;                // 朝东的竖直面
const D = [0, -1, 0] as const;                // 朝下

describe('程序性天空', () => {
  it('旧模型绕 up 旋转对称 —— 朝东朝西必然一样亮', () => {
    const sh = unpack(skyIrradianceSh({ intensity: 1, profile: 1 } as never));
    const w = lum(sh, ...W), e = lum(sh, ...E);
    console.log(`\n【旧模型 profile=1】朝西 ${w.toFixed(4)}  朝东 ${e.toFixed(4)}  比值 ${(w / e).toFixed(3)}`);
    console.log(`  朝下 ${lum(sh, ...D).toFixed(4)}  （地面反弹：没有）`);
    expect(Math.abs(w - e)).toBeLessThan(1e-4);
  });

  it('加日侧辉光之后，朝太阳那侧显著更亮 —— 这是黄昏的本体', () => {
    const dusk = {
      intensity: 1, profile: 1, kelvin: 12000,
      horizonGain: 1.6, horizonSharp: 4, horizonKelvin: 2600,
      glowGain: 3.0, glowTight: 3, glowKelvin: 2100,
      groundGain: 0.15, groundKelvin: 3000,
    };
    const sh = unpack(skyIrradianceSh(dusk as never, SUN_W));
    const w = lum(sh, ...W), e = lum(sh, ...E);
    console.log(`\n【黄昏】朝西 ${w.toFixed(4)}  朝东 ${e.toFixed(4)}  比值 ${(w / e).toFixed(3)}`);
    console.log(`  朝西色度 ${chroma(sh, ...W)}   朝东色度 ${chroma(sh, ...E)}`);
    console.log(`  朝上 ${lum(sh, 0, 1, 0).toFixed(4)}  朝下 ${lum(sh, ...D).toFixed(4)} （地面反弹）`);
    expect(w / e).toBeGreaterThan(1.8);
  });

  it('夜：整体压低 + 冷，且朝下几乎没有反弹', () => {
    const night = {
      intensity: 0.035, profile: 0.6, kelvin: 11000,
      horizonGain: 0.5, horizonSharp: 6, horizonKelvin: 8000,
      groundGain: 0.04, groundKelvin: 9000,
    };
    const sh = unpack(skyIrradianceSh(night as never));
    console.log(`\n【夜】朝上 ${lum(sh, 0, 1, 0).toFixed(5)}  朝西 ${lum(sh, ...W).toFixed(5)}  朝下 ${lum(sh, ...D).toFixed(5)}`);
    console.log(`  朝上色度 ${chroma(sh, 0, 1, 0)}`);
    expect(lum(sh, 0, 1, 0)).toBeLessThan(0.06);
  });

  it('三个 gain 全 0 时逐位回到旧行为', () => {
    const a = skyIrradianceSh({ intensity: 1.3, profile: 2 } as never);
    const b = skyIrradianceSh({ intensity: 1.3, profile: 2, horizonGain: 0, glowGain: 0, groundGain: 0 } as never);
    for (let i = 0; i < a.length; i += 1) expect(b[i]).toBe(a[i]);
  });

  it('groundGain 让朝下的面真的收到光（旧模型恒为 0）', () => {
    const off = unpack(skyIrradianceSh({ intensity: 1, profile: 1 } as never));
    const on = unpack(skyIrradianceSh({ intensity: 1, profile: 1, groundGain: 0.3 } as never));
    console.log(`\n【地面反弹】朝下：off ${lum(off, ...D).toFixed(5)} → on ${lum(on, ...D).toFixed(5)}`);
    expect(lum(off, ...D)).toBeLessThan(1e-3);
    expect(lum(on, ...D)).toBeGreaterThan(0.05);
  });
});
