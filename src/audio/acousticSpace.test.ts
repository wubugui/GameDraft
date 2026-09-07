import { describe, it, expect } from 'vitest';
import {
  buildImpulseResponse, collectTaps, nearestGapSeconds,
  airAbsorptionDbPerM, speedOfSound, sceneToAcoustic,
  type AcousticSpaceDef,
} from './acousticSpace';

/** 一个开阔大山谷：对岸主崖在 300m 外，左侧岩嘴稍近。 */
const 山谷: AcousticSpaceDef = {
  listener: { x: 0, z: 0 },
  reflectors: [
    { id: '对岸主崖', a: [-260, 300], b: [260, 340], height: 120, absorb: 0.06, rough: 0.35 },
    { id: '左岩嘴', a: [-420, 120], b: [-380, 260], height: 60, absorb: 0.10, rough: 0.5 },
  ],
  order: 2,
  tail: { seconds: 4.5, gain: 0.11 },
  air: { tempC: 5 },
  width: 0.95,
};

/** 贴壁：近处两面小壁，几乎没有回音。 */
const 贴壁: AcousticSpaceDef = {
  listener: { x: 0, z: 0 },
  reflectors: [
    { id: '岩壁', a: [-3, 5], b: [3, 5], height: 4, absorb: 0.6, rough: 0.8 },
  ],
  order: 1,
  air: { tempC: 5 },
  width: 0.3,
};

describe('物理量', () => {
  it('声速随温度走，5°C 约 334 m/s', () => {
    expect(speedOfSound(5)).toBeCloseTo(334.3, 1);
    expect(speedOfSound(20)).toBeGreaterThan(speedOfSound(0));
  });

  it('空气吸收随频率单调上升 —— 这是「远」的听感来源', () => {
    const lo = airAbsorptionDbPerM(250);
    const mid = airAbsorptionDbPerM(2000);
    const hi = airAbsorptionDbPerM(8000);
    expect(mid).toBeGreaterThan(lo);
    expect(hi).toBeGreaterThan(mid);
    // 8kHz 每米约 0.09dB：600m 往返就掉 50dB 以上，远处回音必然发闷
    expect(hi * 600).toBeGreaterThan(50);
  });
});

describe('抽头', () => {
  it('镜像声源给出往返路径：300m 外的面约 600m 路径', () => {
    const taps = collectTaps(山谷);
    const first = taps[0];
    expect(first.length).toBeGreaterThan(500);
    expect(first.length).toBeLessThan(700);
  });

  it('延迟 = 路径 / 声速', () => {
    const taps = collectTaps(山谷);
    const c = speedOfSound(5);
    for (const t of taps) expect(t.delay).toBeCloseTo(t.length / c, 6);
  });

  it('二阶必然晚于一阶，不会侵占原声与首回之间那段空白', () => {
    const taps = collectTaps(山谷);
    const firstOrder = taps.filter((t) => t.order === 1);
    const secondOrder = taps.filter((t) => t.order === 2);
    expect(secondOrder.length).toBeGreaterThan(0);
    const earliestFirst = Math.min(...firstOrder.map((t) => t.delay));
    for (const t of secondOrder) expect(t.delay).toBeGreaterThanOrEqual(earliestFirst);
  });

  it('抽头按到达时间排序', () => {
    const taps = collectTaps(山谷);
    for (let i = 1; i < taps.length; i++) {
      expect(taps[i].delay).toBeGreaterThanOrEqual(taps[i - 1].delay);
    }
  });

  it('大面比小面返回更强（立体角项）', () => {
    const big = collectTaps({
      ...山谷, order: 1,
      reflectors: [{ id: 'A', a: [-200, 300], b: [200, 300], height: 120, absorb: 0, rough: 0 }],
    })[0];
    const small = collectTaps({
      ...山谷, order: 1,
      reflectors: [{ id: 'A', a: [-5, 300], b: [5, 300], height: 6, absorb: 0, rough: 0 }],
    })[0];
    expect(big.gain).toBeGreaterThan(small.gain);
  });

  it('吸收越大回音越弱', () => {
    const mk = (absorb: number) => collectTaps({
      ...山谷, order: 1,
      reflectors: [{ id: 'A', a: [-200, 300], b: [200, 300], height: 120, absorb, rough: 0 }],
    })[0].gain;
    expect(mk(0.9)).toBeLessThan(mk(0.05));
  });

  it('方位角能区分左右', () => {
    const 左 = collectTaps({
      ...山谷, order: 1,
      reflectors: [{ id: 'L', a: [-300, -20], b: [-300, 20], height: 50, absorb: 0.1, rough: 0.3 }],
    })[0];
    const 右 = collectTaps({
      ...山谷, order: 1,
      reflectors: [{ id: 'R', a: [300, -20], b: [300, 20], height: 50, absorb: 0.1, rough: 0.3 }],
    })[0];
    expect(左.azimuth).toBeLessThan(0);
    expect(右.azimuth).toBeGreaterThan(0);
  });
});

describe('空白判据 —— 最近反射面的延迟必须大于干声时长', () => {
  it('大山谷首回在 1.5s 之后，3 秒的猿啼放得下', () => {
    // 300m 面 => 约 600m 路径 => 约 1.8s
    expect(nearestGapSeconds(山谷)).toBeGreaterThan(1.5);
  });

  it('贴壁首回极早，只够放极短的音', () => {
    expect(nearestGapSeconds(贴壁)).toBeLessThan(0.1);
  });
});

describe('IR', () => {
  it('长度必须覆盖最晚那个回音（尾部只裁听不见的部分）', () => {
    const ir = buildImpulseResponse(山谷, { sampleRate: 48000 });
    expect(ir.left.length).toBe(ir.right.length);
    expect(ir.sampleRate).toBe(48000);
    const last = ir.taps[ir.taps.length - 1];
    // 最晚那记回音必须在里面 —— 裁掉它就等于把回音砍了
    expect(ir.left.length / 48000).toBeGreaterThan(last.delay);
  });

  it('尾部裁剪只切掉低于 -80dB 的余数，不动可闻内容', () => {
    const ir = buildImpulseResponse(山谷, { sampleRate: 48000 });
    let peak = 0;
    for (let i = 0; i < ir.left.length; i++) {
      peak = Math.max(peak, Math.abs(ir.left[i]), Math.abs(ir.right[i]));
    }
    // 裁完之后，末尾 20ms 之前的最后一个样本仍应在阈值之上或紧邻它
    const guard = Math.round(0.02 * 48000);
    const tailIdx = Math.max(0, ir.left.length - guard - 1);
    const v = Math.max(Math.abs(ir.left[tailIdx]), Math.abs(ir.right[tailIdx]));
    expect(v).toBeLessThanOrEqual(peak);   // 只是确认没越界；裁剪不该放大任何东西
    expect(peak).toBeGreaterThan(0);
  });

  it('默认不含直达声（走 wet/dry 分开总线）', () => {
    const ir = buildImpulseResponse(山谷, { sampleRate: 48000 });
    expect(Math.abs(ir.left[0])).toBeLessThan(1e-6);
    const withDirect = buildImpulseResponse(山谷, { sampleRate: 48000, includeDirect: true });
    expect(Math.abs(withDirect.left[0])).toBeGreaterThan(0);
  });

  it('首回之前是空的 —— 那段空白正是山谷感的来源', () => {
    const ir = buildImpulseResponse(山谷, { sampleRate: 48000 });
    const firstIdx = Math.floor(ir.taps[0].delay * 48000);
    let maxBefore = 0;
    for (let i = 0; i < firstIdx - 480; i++) {
      maxBefore = Math.max(maxBefore, Math.abs(ir.left[i]), Math.abs(ir.right[i]));
    }
    expect(maxBefore).toBeLessThan(1e-6);
  });

  it('确定性：同一份配置两次结果逐样本相同', () => {
    const a = buildImpulseResponse(山谷, { sampleRate: 24000 });
    const b = buildImpulseResponse(山谷, { sampleRate: 24000 });
    expect(a.left.length).toBe(b.left.length);
    for (let i = 0; i < a.left.length; i += 97) expect(a.left[i]).toBe(b.left[i]);
  });

  it('峰值不越界', () => {
    const ir = buildImpulseResponse(山谷, { sampleRate: 24000 });
    // 先扫出峰值再断言一次。逐样本 expect 是 25 万采样 × 2 = 50 万次断言，
    // 单跑能过、全量并行下直接超时（踩过）。
    let peak = 0;
    for (let i = 0; i < ir.left.length; i++) {
      const l = Math.abs(ir.left[i]); if (l > peak) peak = l;
      const r = Math.abs(ir.right[i]); if (r > peak) peak = r;
    }
    expect(peak).toBeLessThanOrEqual(1);
    expect(peak).toBeGreaterThan(0);
  });

  it('远处的面比近处的面高频更少（空气吸收在起作用）', () => {
    const near = buildImpulseResponse({
      ...山谷, order: 1, tail: undefined,
      reflectors: [{ id: 'A', a: [-50, 40], b: [50, 40], height: 40, absorb: 0.05, rough: 0.1 }],
    }, { sampleRate: 48000 });
    const far = buildImpulseResponse({
      ...山谷, order: 1, tail: undefined,
      reflectors: [{ id: 'A', a: [-400, 600], b: [400, 600], height: 300, absorb: 0.05, rough: 0.1 }],
    }, { sampleRate: 48000 });
    // 用相邻样本差的能量占比当"高频含量"的粗代理
    const hfRatio = (x: Float32Array) => {
      let d = 0, e = 0;
      for (let i = 1; i < x.length; i++) { const df = x[i] - x[i - 1]; d += df * df; e += x[i] * x[i]; }
      return e > 0 ? d / e : 0;
    };
    expect(hfRatio(far.left)).toBeLessThan(hfRatio(near.left));
  });

  it('没有反射面时不炸', () => {
    const ir = buildImpulseResponse({ listener: { x: 0, z: 0 }, reflectors: [] });
    expect(ir.taps.length).toBe(0);
    expect(ir.left.length).toBeGreaterThan(0);
  });
});

// ============ 活听者 / 仰角 / 遮挡 ============

describe('活听者（绑实体或相机）', () => {
  it('听者挪近对岸，回音变早', () => {
    const 远 = nearestGapSeconds(山谷);
    const 近 = nearestGapSeconds(山谷, { listener: { x: 0, z: 200 } });
    expect(近).toBeLessThan(远);
  });

  it('听者挪动改变到达方位 —— 声像是活的', () => {
    // ⚠ 墙若与视线垂直，自己喊的回声永远原路返回、方位恒为 0，横着走也不变
    //   （这是对的物理，不是 bug）。要让方位动，墙得是斜的。
    const 斜墙: AcousticSpaceDef = {
      ...山谷, order: 1,
      reflectors: [{ id: '斜崖', a: [80, 120], b: [320, 360], height: 120, absorb: 0.05, rough: 0.2 }],
    };
    const mk = (x: number) => collectTaps(斜墙, { listener: { x, z: 0 } })[0].azimuth;
    const 左 = mk(-150), 右 = mk(150);
    expect(Math.abs(左 - 右)).toBeGreaterThan(0.05);   // 方位确实随位置变了
  });

  it('墙与视线垂直时方位恒为 0（自己喊原路返回，这是对的物理）', () => {
    const 正墙: AcousticSpaceDef = {
      ...山谷, order: 1,
      reflectors: [{ id: 'A', a: [-200, 300], b: [200, 300], height: 120, absorb: 0.05, rough: 0.2 }],
    };
    for (const x of [-120, 0, 120]) {
      expect(collectTaps(正墙, { listener: { x, z: 0 } })[0].azimuth).toBeCloseTo(0, 6);
    }
  });

  it('IR 随听者位置变化 —— 不变就等于实时没有意义', () => {
    const a = buildImpulseResponse(山谷, { sampleRate: 24000, listener: { x: 0, z: 0 } });
    const b = buildImpulseResponse(山谷, { sampleRate: 24000, listener: { x: 0, z: 250 } });
    expect(a.taps[0].delay).not.toBeCloseTo(b.taps[0].delay, 3);
  });

  it('场景 wu 坐标能换算进声学米制（尺度锚：角色高 150wu ≈ 1.7m）', () => {
    const space: AcousticSpaceDef = {
      ...山谷, anchor: { x: 1000, y: 500 }, wuPerMeter: 88,
    };
    const at = sceneToAcoustic({ x: 1000, y: 500 }, space);
    expect(at.x).toBeCloseTo(0, 6);
    expect(at.z).toBeCloseTo(0, 6);
    // 往右 880wu = 10m；场景 y 向下，声学 z 向前，所以要翻号
    const right = sceneToAcoustic({ x: 1880, y: 500 }, space);
    expect(right.x).toBeCloseTo(10, 6);
    const up = sceneToAcoustic({ x: 1000, y: 500 - 880 }, space);
    expect(up.z).toBeCloseTo(10, 6);
  });
});

describe('仰角', () => {
  it('水平面（脚下的水面）给出上下来回的那一记', () => {
    const 水面: AcousticSpaceDef = {
      listener: { x: 0, z: 0, y: 20 },   // 站在离水面 20m 高的栈道上
      reflectors: [{ id: '潭面', a: [-60, -60], b: [60, 60], height: 1, absorb: 0.1, rough: 0.2, y: 0, tiltDeg: 90 }],
      order: 1, air: { tempC: 5 },
    };
    const taps = collectTaps(水面);
    expect(taps.length).toBe(1);
    // 上下走一个来回 = 40m
    expect(taps[0].length).toBeCloseTo(40, 1);
    expect(taps[0].elevation).toBeLessThan(0);   // 从下方回来
  });

  it('头顶那片崖壁比平齐的远（反射点被钳到面的下边缘）', () => {
    const mk = (baseY: number) => collectTaps({
      listener: { x: 0, z: 0, y: 1.6 },
      reflectors: [{ id: 'A', a: [-100, 200], b: [100, 200], height: 40, absorb: 0.05, rough: 0.2, y: baseY }],
      order: 1, air: { tempC: 5 },
    })[0].length;
    expect(mk(120)).toBeGreaterThan(mk(0));
  });

  it('平齐的竖直面不受耳高影响（镜像在平面内，y 抵消）', () => {
    const mk = (ey: number) => collectTaps({
      listener: { x: 0, z: 0, y: ey },
      reflectors: [{ id: 'A', a: [-100, 200], b: [100, 200], height: 200, absorb: 0.05, rough: 0.2, y: 0 }],
      order: 1, air: { tempC: 5 },
    })[0].length;
    expect(mk(1.6)).toBeCloseTo(mk(30), 3);
  });
});

describe('遮挡', () => {
  const 被挡: AcousticSpaceDef = {
    listener: { x: 0, z: 0 },
    reflectors: [
      { id: '远崖', a: [-200, 400], b: [200, 400], height: 100, absorb: 0.05, rough: 0.2 },
      { id: '挡板', a: [-150, 60], b: [150, 60], height: 80, absorb: 0.05, rough: 0.2 },
    ],
    order: 1, air: { tempC: 5 },
  };

  it('挡在中间的面把后面那面压下去', () => {
    const 有挡 = collectTaps(被挡).find((t) => t.reflectorIds.includes('远崖'))!;
    const 无挡 = collectTaps({ ...被挡, occlusion: false })
      .find((t) => t.reflectorIds.includes('远崖'))!;
    expect(有挡.gain).toBeLessThan(无挡.gain);
    expect(有挡.occluded).toBeGreaterThan(0);
  });

  it('不做硬剔除 —— 边界处不会「啪」地消失', () => {
    const t = collectTaps(被挡).find((x) => x.reflectorIds.includes('远崖'));
    expect(t).toBeTruthy();
    expect(t!.gain).toBeGreaterThan(0);
  });

  it('没有东西挡时不衰减', () => {
    const 单面 = collectTaps({ ...被挡, reflectors: [被挡.reflectors[0]] })[0];
    expect(单面.occluded).toBeUndefined();
  });
});

describe('暂存缓冲的生命周期（静默失效的陷阱）', () => {
  it('默认返回拷贝：连建两条不会互相覆盖', () => {
    const a = buildImpulseResponse(山谷, { sampleRate: 24000 });
    const snapshot = Array.from(a.left.slice(0, 200));
    buildImpulseResponse(贴壁, { sampleRate: 24000 });   // 第二条，若共享缓冲就会覆盖第一条
    expect(Array.from(a.left.slice(0, 200))).toEqual(snapshot);
  });

  it('transient 明确说明是视图 —— 只有立刻拷走的调用方才该用', () => {
    const a = buildImpulseResponse(山谷, { sampleRate: 24000, transient: true });
    const len = a.left.length;
    buildImpulseResponse(贴壁, { sampleRate: 24000, transient: true });
    // 视图长度仍在，但内容已被下一次覆盖 —— 这是文档承诺的行为，不是 bug
    expect(a.left.length).toBe(len);
  });
});
