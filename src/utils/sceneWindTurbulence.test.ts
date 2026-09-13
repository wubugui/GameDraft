import { describe, expect, it } from 'vitest';
import { addSceneWindTurbulence, resolveSceneWind, sampleSceneWind, windGustMul } from './sceneWind';

const W = resolveSceneWind({
  direction: [-1, 0, -0.25], speed: 400, gust: { amount: 0.8, period: 7 }, veer: 14,
  turbulence: { intensity: 0.35, scale: 140 }, roughness: 1,
})!;

const fluct = (t: number, x: number, y: number, z: number, rms = 100): [number, number, number] => {
  const o = [0, 0, 0];
  addSceneWindTurbulence(W, t, x, y, z, rms, o);
  return [o[0], o[1], o[2]];
};

/**
 * 湍流要是"真的涡"：无散度（不会凭空涌出 / 汇聚）、空间相干（挨着的两粒被同一个涡带走）、
 * 三个方向都有（横风与上升下沉）。这几条钉住的是**结构**，不是数值——退回"逐粒私有噪声"或
 * "只有顺风一个方向"时它们会红。
 */
describe('场景风的湍流场', () => {
  it('无散度：∇·u′ ≈ 0', () => {
    const h = 0.5;
    let worst = 0;
    for (const [x, y, z] of [[0, 100, 0], [523, 40, -317], [-1200, 260, 880], [77, 5, 41]]) {
      const dx = fluct(3.1, x + h, y, z)[0] - fluct(3.1, x - h, y, z)[0];
      const dy = fluct(3.1, x, y + h, z)[1] - fluct(3.1, x, y - h, z)[1];
      const dz = fluct(3.1, x, y, z + h)[2] - fluct(3.1, x, y, z - h)[2];
      const div = Math.abs((dx + dy + dz) / (2 * h));
      // 与同尺度上的剪切比：散度要小两个数量级以上
      const shear = Math.abs(fluct(3.1, x + h, y, z)[2] - fluct(3.1, x - h, y, z)[2]) / (2 * h);
      worst = Math.max(worst, div / Math.max(shear, 1e-9));
    }
    expect(worst).toBeLessThan(0.01);
  });

  it('三个方向都有脉动（横风 + 上升下沉），不是只顺风推', () => {
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (let i = 0; i < 400; i++) {
      const [a, b, c] = fluct(i * 0.13, i * 37, 60 + (i % 7) * 30, i * -53);
      sx += a * a; sy += b * b; sz += c * c; n++;
    }
    const [rx, ry, rz] = [Math.sqrt(sx / n), Math.sqrt(sy / n), Math.sqrt(sz / n)];
    // 竖直分量不能是零头：上升下沉气流是纸钱被卷起来的来源
    expect(ry).toBeGreaterThan(0.3 * Math.max(rx, rz));
    expect(Math.min(rx, rz)).toBeGreaterThan(0.3 * Math.max(rx, rz));
  });

  it('脉动强度 ≈ 传进去的 rms', () => {
    let s = 0, n = 0;
    for (let i = 0; i < 2000; i++) {
      const [a, b, c] = fluct(i * 0.017, i * 13.7, 80 + (i % 11) * 20, i * -29.3, 100);
      s += a * a + b * b + c * c; n++;
    }
    expect(Math.sqrt(s / n)).toBeGreaterThan(70);
    expect(Math.sqrt(s / n)).toBeLessThan(140);
  });

  it('空间相干：一个涡尺度以内像，几个涡尺度以外就不像了', () => {
    const cos = (d: number): number => {
      let dot = 0, la = 0, lb = 0;
      for (let i = 0; i < 200; i++) {
        const x = i * 91.3, y = 70 + (i % 5) * 25, z = i * -63.1, t = i * 0.21;
        const a = fluct(t, x, y, z), b = fluct(t, x + d, y, z);
        for (let k = 0; k < 3; k++) { dot += a[k] * b[k]; la += a[k] * a[k]; lb += b[k] * b[k]; }
      }
      return dot / Math.sqrt(la * lb);
    };
    const near = cos(14);          // 涡尺度的 1/10
    const far = cos(600);          // 好几个涡尺度
    expect(near).toBeGreaterThan(0.8);
    expect(far).toBeLessThan(near - 0.3);
  });

  it('同一份参数 ⇒ 同一片涡（可复现）', () => {
    const w2 = resolveSceneWind({
      direction: [-1, 0, -0.25], speed: 400, turbulence: { intensity: 0.35, scale: 140 }, roughness: 1,
    })!;
    const o1 = [0, 0, 0], o2 = [0, 0, 0];
    addSceneWindTurbulence(W, 2.5, 300, 90, -120, 100, o1);
    addSceneWindTurbulence(w2, 2.5, 300, 90, -120, 100, o2);
    expect(o2).toEqual(o1);
  });

  it('sampleSceneWind 带上了涡：竖直分量不再恒为 0，也不再全场同向', () => {
    const out = [0, 0, 0];
    let vert = 0, spread = 0, n = 0;
    let meanX = 0, meanZ = 0;
    for (let i = 0; i < 300; i++) {
      sampleSceneWind(W, i * 0.11, i * 47, i * -31, 90, out);
      vert = Math.max(vert, Math.abs(out[1]));
      meanX += out[0]; meanZ += out[2];
      n++;
    }
    meanX /= n; meanZ /= n;
    const ml = Math.hypot(meanX, meanZ);
    for (let i = 0; i < 300; i++) {
      sampleSceneWind(W, i * 0.11, i * 47, i * -31, 90, out);
      const c = (out[0] * meanX + out[2] * meanZ) / (ml * Math.hypot(out[0], out[2]) || 1);
      spread = Math.max(spread, Math.acos(Math.min(1, Math.max(-1, c))));
    }
    expect(vert).toBeGreaterThan(5);                      // wu/s 量级的上升 / 下沉
    expect(spread).toBeGreaterThan(0.25);                 // 至少有 ~15° 的方向散布
  });

  it('强度为 0 ⇒ 一个字不变（老场景不受影响）', () => {
    const calm = resolveSceneWind({
      direction: [-1, 0, -0.25], speed: 400, turbulence: { intensity: 0, scale: 140 }, roughness: 1,
    })!;
    const out = [0, 0, 0];
    sampleSceneWind(calm, 4.2, 100, -200, 90, out);
    expect(out[1]).toBe(0);
    const o2 = [0, 0, 0];
    addSceneWindTurbulence(calm, 4.2, 100, 90, -200, 0, o2);
    expect(o2).toEqual([0, 0, 0]);
  });
});

/**
 * 热路径的正弦走了 2048 格查表(`fastCos` / `fastSin`)。这里用同一张模式表 + `Math.cos` 写一份参考实现,
 * 钉住"换成查表不改变结果"——误差必须远小于风本身的量级,否则就是拿画面换性能。
 */
describe('查表与真三角函数的一致性', () => {
  it('湍流：查表版与 Math.cos 参考实现逐点一致（误差 < 1e-3 wu/s）', () => {
    const m = W.turbModes;
    const modes = m.length / 8;
    const ref = (t: number, x: number, y: number, z: number, rms: number): [number, number, number] => {
      const ax = x - W.dirX * W.speed * t, az = z - W.dirZ * W.speed * t;
      let a = 0, b = 0, c = 0;
      for (let i = 0; i < modes; i++) {
        const o = i * 8;
        const ph = m[o] * ax + m[o + 1] * y + m[o + 2] * az + m[o + 6] * rms * t + m[o + 7];
        const k = Math.cos(ph) * rms;
        a += m[o + 3] * k; b += m[o + 4] * k; c += m[o + 5] * k;
      }
      return [a, b, c];
    };
    let worst = 0;
    for (let i = 0; i < 500; i++) {
      const t = i * 0.37, x = i * 113.7, y = 40 + (i % 9) * 35, z = i * -87.3;
      const got = fluct(t, x, y, z, 140);
      const want = ref(t, x, y, z, 140);
      for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(got[k] - want[k]));
    }
    expect(worst).toBeLessThan(1e-3);
  });

  it('阵风与风向摆动：查表不改变平均与峰值', () => {
    let sum = 0, peak = -1e9, low = 1e9;
    for (let i = 0; i < 20000; i++) {
      const g = windGustMul(W, i * 0.01);
      sum += g; peak = Math.max(peak, g); low = Math.min(low, g);
    }
    expect(sum / 20000).toBeCloseTo(1, 1);            // 时间平均钉在 1
    expect(peak).toBeLessThan(1 + W.gustAmount + 0.05);
    expect(low).toBeGreaterThan(1 - W.gustAmount / 4 - 0.05);
  });
});
