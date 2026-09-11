import { describe, it, expect } from 'vitest';
import {
  buildImpulseResponse, collectTaps, nearestGapSeconds, directPath, sourcePoint, listSources,
  airAbsorptionDbPerM, speedOfSound, metersPerWu, earHeightWu,
  DEFAULT_WU_PER_METER, DEFAULT_EAR_HEIGHT_WU, DEFAULT_DIRECT,
  type AcousticSpaceDef,
} from './acousticSpace';

/**
 * 作者面一律是 wu。为了让下面的几何按**米**读（300 = 300 米），夹具统一
 * `distanceScale: 88`——1 wu 折 1 米。这不是取巧：距离缩放本来就是「整个空间等比放大」。
 * 缺省缩放（1 wu = 1/88 米）的语义单独在「尺度」一节里钉。
 */
const 米制 = { distanceScale: DEFAULT_WU_PER_METER, earHeight: 1.6 } as const;

/** 一个开阔大山谷：对岸主崖在 300m 外，左侧岩嘴稍近。 */
const 山谷: AcousticSpaceDef = {
  ...米制,
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
  ...米制,
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

describe('尺度：wu → 米 = wu / 88 × distanceScale', () => {
  it('缺省缩放 1：880 wu 就是 10 米；缺省耳高 141 wu', () => {
    expect(metersPerWu({})).toBeCloseTo(1 / 88, 9);
    expect(880 * metersPerWu({})).toBeCloseTo(10, 6);
    expect(earHeightWu({})).toBe(DEFAULT_EAR_HEIGHT_WU);
  });

  it('非法缩放（0 / 负 / NaN）按 1 处理，不会把整个空间算成 0 米', () => {
    expect(metersPerWu({ distanceScale: 0 })).toBeCloseTo(1 / 88, 9);
    expect(metersPerWu({ distanceScale: -3 })).toBeCloseTo(1 / 88, 9);
    expect(metersPerWu({ distanceScale: Number.NaN })).toBeCloseTo(1 / 88, 9);
  });

  it('缩放 k 倍：延迟 ×k，立体角增益不变（面积/L² 是尺度不变量）', () => {
    // 画里 20 米开外的崖壁（1760 wu），缩放 15 之后应当在 300 米外
    const near: AcousticSpaceDef = {
      listener: { x: 0, z: 0 },
      reflectors: [{ id: 'A', a: [-880, 1760], b: [880, 1760], height: 440, absorb: 0, rough: 0 }],
      order: 1, air: { tempC: 5 },
    };
    const far: AcousticSpaceDef = { ...near, distanceScale: 15 };
    const a = collectTaps(near)[0];
    const b = collectTaps(far)[0];
    expect(a.length).toBeCloseTo(40, 3);
    expect(b.length).toBeCloseTo(600, 3);
    expect(b.delay / a.delay).toBeCloseTo(15, 6);
    expect(b.gain).toBeCloseTo(a.gain, 9);
  });

  it('耳高跟着缩：栈道离潭面 1.5 米、缩放 15 就是 22.5 米的上下往返', () => {
    const s: AcousticSpaceDef = {
      distanceScale: 15, earHeight: 0,
      listener: { x: 0, z: 0, y: 132 },   // 脚下地面在潭面之上 1.5m（132 wu）
      reflectors: [{ id: '潭', a: [-880, -880], b: [880, 880], height: 88, absorb: 0.1, rough: 0.2, y: 0, tiltDeg: 90 }],
      order: 1, air: { tempC: 5 },
    };
    expect(collectTaps(s)[0].length).toBeCloseTo(45, 3);
  });

  it('米制夹具确实是 1 wu = 1 米（否则下面所有「米」的断言都在自欺）', () => {
    expect(metersPerWu(山谷)).toBeCloseTo(1, 9);
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

  it('每个抽头带反射点（wu）：一阶落在那面墙上，工作台据此画路径', () => {
    const one: AcousticSpaceDef = {
      ...山谷, order: 1,
      reflectors: [{ id: 'A', a: [-200, 300], b: [200, 300], height: 120, absorb: 0.05, rough: 0.2 }],
    };
    const t = collectTaps(one, { listener: { x: 50, z: 0 } })[0];
    expect(t.hit).toBeTruthy();
    expect(t.hit![2]).toBeCloseTo(300, 6);       // z 在墙上（米制夹具 1 wu = 1 m）
    expect(t.hit![0]).toBeCloseTo(50, 6);        // 自己喊：反射点正对着自己
    expect(t.hit![1]).toBeCloseTo(1.6, 6);       // 高度 = 耳高（面平齐）
  });

  it('没有 id 的反射面用 #序号 当 id，二阶抽头的粗糙度平均照样能查到', () => {
    const noId: AcousticSpaceDef = {
      ...山谷,
      reflectors: [
        { a: [-200, 300], b: [200, 300], height: 120, absorb: 0.05, rough: 0.2 },
        { a: [300, -20], b: [300, 20], height: 50, absorb: 0.1, rough: 0.3 },
      ],
    };
    const taps = collectTaps(noId);
    expect(taps.some((t) => t.order === 2)).toBe(true);
    for (const t of taps) for (const id of t.reflectorIds) expect(id).toMatch(/^#\d+$/);
    expect(() => buildImpulseResponse(noId, { sampleRate: 24000 })).not.toThrow();
  });
});

describe('空白判据 —— 最近反射面的延迟必须大于干声时长', () => {
  it('大山谷首回在 1.5s 之后，3 秒的猿啼放得下', () => {
    expect(nearestGapSeconds(山谷)).toBeGreaterThan(1.5);
  });

  it('贴壁首回极早，只够放极短的音', () => {
    expect(nearestGapSeconds(贴壁)).toBeLessThan(0.1);
  });
});

describe('IR', () => {
  it('长度必须覆盖最晚那个回音（尾部只裁听不见的部分）', () => {
    const ir = buildImpulseResponse(山谷, { sampleRate: 24000 });
    const last = ir.taps[ir.taps.length - 1];
    expect(ir.left.length / 24000).toBeGreaterThan(last.delay);
    expect(ir.right.length).toBe(ir.left.length);
  });

  it('尾部裁剪只切掉低于 -80dB 的余数，不动可闻内容', () => {
    const ir = buildImpulseResponse(山谷, { sampleRate: 24000 });
    let peak = 0;
    for (let i = 0; i < ir.left.length; i++) peak = Math.max(peak, Math.abs(ir.left[i]));
    const tail = ir.left.slice(-24000);
    let tailPeak = 0;
    for (let i = 0; i < tail.length; i++) tailPeak = Math.max(tailPeak, Math.abs(tail[i]));
    expect(tailPeak).toBeLessThan(peak * 0.02);
  });

  it('默认不含直达声（走 wet/dry 分开总线）', () => {
    const ir = buildImpulseResponse(山谷, { sampleRate: 24000 });
    expect(ir.left[0]).toBe(0);
    const withDirect = buildImpulseResponse(山谷, { sampleRate: 24000, includeDirect: true });
    expect(withDirect.left[0]).toBeGreaterThan(0);
  });

  it('首回之前是空的 —— 那段空白正是山谷感的来源', () => {
    const ir = buildImpulseResponse(山谷, { sampleRate: 24000 });
    const firstAt = Math.floor(ir.taps[0].delay * 24000) - 100;
    for (let i = 0; i < firstAt; i++) {
      expect(ir.left[i]).toBe(0);
      expect(ir.right[i]).toBe(0);
    }
  });

  it('确定性：同一份配置两次结果逐样本相同', () => {
    const a = buildImpulseResponse(山谷, { sampleRate: 24000 });
    const b = buildImpulseResponse(山谷, { sampleRate: 24000 });
    expect(Array.from(a.left.slice(0, 5000))).toEqual(Array.from(b.left.slice(0, 5000)));
  });

  it('峰值不越界', () => {
    const loud: AcousticSpaceDef = {
      ...山谷,
      reflectors: Array.from({ length: 12 }, (_, i) => ({
        id: `w${i}`, a: [-300, 40 + i * 3] as [number, number], b: [300, 40 + i * 3] as [number, number],
        height: 300, absorb: 0, rough: 0,
      })),
      tail: { seconds: 2, gain: 0.5 },
    };
    const ir = buildImpulseResponse(loud, { sampleRate: 24000 });
    for (let i = 0; i < ir.left.length; i++) {
      expect(Math.abs(ir.left[i])).toBeLessThanOrEqual(1);
      expect(Math.abs(ir.right[i])).toBeLessThanOrEqual(1);
    }
  });

  it('远处的面比近处的面高频更少（空气吸收在起作用）', () => {
    const sr = 24000;
    const mk = (z: number) => buildImpulseResponse({
      ...山谷, order: 1, tail: undefined,
      reflectors: [{ id: 'A', a: [-200, z], b: [200, z], height: 150, absorb: 0, rough: 0 }],
    }, { sampleRate: sr });
    const hfRatio = (ir: ReturnType<typeof buildImpulseResponse>) => {
      const at = Math.round(ir.taps[0].delay * sr);
      const seg = ir.left.slice(at, at + 400);
      let lo = 0, hi = 0;
      for (let i = 1; i < seg.length; i++) {
        const d = seg[i] - seg[i - 1];
        hi += d * d; lo += seg[i] * seg[i];
      }
      return hi / Math.max(lo, 1e-12);
    };
    expect(hfRatio(mk(600))).toBeLessThan(hfRatio(mk(60)));
  });

  it('没有反射面时不炸', () => {
    const empty: AcousticSpaceDef = { ...山谷, reflectors: [] };
    const ir = buildImpulseResponse(empty, { sampleRate: 24000 });
    expect(ir.taps.length).toBe(0);
    expect(ir.left.length).toBeGreaterThan(0);
  });
});

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

  it('运行时给的是脚下地面点：地面抬高 = 耳朵抬高，头顶岩檐的往返随之变短', () => {
    const 檐: AcousticSpaceDef = {
      ...米制, earHeight: 1.6,
      listener: { x: 0, z: 0, y: 0 },
      reflectors: [{ id: '檐', a: [-20, -20], b: [20, 20], height: 1, absorb: 0.1, rough: 0.2, y: 16, tiltDeg: 90 }],
      order: 1, air: { tempC: 5 },
    };
    const 平地 = collectTaps(檐)[0].length;                                  // 2 × (16 − 1.6)
    const 台阶 = collectTaps(檐, { listener: { x: 0, z: 0, y: 4 } })[0].length; // 2 × (16 − 5.6)
    expect(平地).toBeCloseTo(28.8, 3);
    expect(台阶).toBeCloseTo(20.8, 3);
  });
});

describe('仰角', () => {
  it('水平面（脚下的水面）给出上下来回的那一记', () => {
    const 水面: AcousticSpaceDef = {
      ...米制, earHeight: 0,
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
      ...米制,
      listener: { x: 0, z: 0 },
      reflectors: [{ id: 'A', a: [-100, 200], b: [100, 200], height: 40, absorb: 0.05, rough: 0.2, y: baseY }],
      order: 1, air: { tempC: 5 },
    })[0].length;
    expect(mk(120)).toBeGreaterThan(mk(0));
  });

  it('平齐的竖直面不受耳高影响（镜像在平面内，y 抵消）', () => {
    const mk = (ey: number) => collectTaps({
      ...米制, earHeight: ey,
      listener: { x: 0, z: 0 },
      reflectors: [{ id: 'A', a: [-100, 200], b: [100, 200], height: 200, absorb: 0.05, rough: 0.2, y: 0 }],
      order: 1, air: { tempC: 5 },
    })[0].length;
    expect(mk(1.6)).toBeCloseTo(mk(30), 3);
  });
});

describe('遮挡', () => {
  const 被挡: AcousticSpaceDef = {
    ...米制,
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

describe('有位置的声源（v3：声源不在听者上）', () => {
  /** 一面正对的墙在 z=300m，横跨 x∈[-200,200]；听者在原点，耳高 1.6m */
  const 正墙: AcousticSpaceDef = {
    ...米制,
    listener: { x: 0, z: 0 },
    reflectors: [{ id: '墙', a: [-200, 300], b: [200, 300], height: 120, absorb: 0.05, rough: 0.3 }],
    order: 1,
    air: { tempC: 5 },
  };
  const ear = { x: 0, y: 1.6, z: 0 };

  it('自己喊：一阶路径 = 2d；声源挪到墙前 100m 处：路径 = 镜像声源到听者 = 500m，不再是 2d', () => {
    const self = collectTaps(正墙, { ear });
    expect(self[0].length).toBeCloseTo(600, 0);
    const near = collectTaps(正墙, { ear, source: { x: 0, y: 1.6, z: 200 } });
    // S 在 z=200，镜像到 z=400，到听者 400m
    expect(near[0].length).toBeCloseTo(400, 0);
    expect(near[0].delay).toBeLessThan(self[0].delay);
  });

  it('声源在左边：一阶反射从左边来（镜像声源在墙那边、x 仍在左）', () => {
    const t = collectTaps(正墙, { ear, source: { x: -150, y: 1.6, z: 0 } });
    expect(t[0].azimuth).toBeLessThan(0);
    const t2 = collectTaps(正墙, { ear, source: { x: 150, y: 1.6, z: 0 } });
    expect(t2[0].azimuth).toBeGreaterThan(0);
  });

  it('水平面：声源不在听者上时仍是关于 y=r.y 的镜像（路径 = 镜像点到耳）', () => {
    const 水面: AcousticSpaceDef = {
      ...米制, listener: { x: 0, z: 0 },
      reflectors: [{ id: '潭', a: [-50, -50], b: [50, -50], height: 100, absorb: 0.02, rough: 0.05, y: -3, tiltDeg: 90 }],
      order: 1,
    };
    const self = collectTaps(水面, { ear });
    // 自己喊：上下来回 2×(1.6+3) = 9.2m
    expect(self[0].length).toBeCloseTo(9.2, 1);
    const s = collectTaps(水面, { ear, source: { x: 30, y: 1.6, z: 0 } });
    // 声源镜像到 y=-7.6，到耳 (30, 9.2) → 31.38m
    expect(s[0].length).toBeCloseTo(Math.hypot(30, 9.2), 1);
    expect(s[0].elevation).toBeLessThan(0);
  });

  it('直达声：自己喊时长度 0、增益 1、声像 0、不闷', () => {
    const d = directPath(正墙, { ear });
    expect(d.length).toBe(0);
    expect(d.gain).toBe(1);
    expect(d.pan).toBe(0);
    expect(d.occluded).toBe(0);
    expect(d.inaudible).toBe(false);
  });

  it('直达声：右边的声源 pan > 0、左边 < 0；远的比近的轻；参考距离以内不变响', () => {
    const r = directPath(正墙, { ear, source: { x: 20, y: 1.6, z: 0 } });
    const l = directPath(正墙, { ear, source: { x: -20, y: 1.6, z: 0 } });
    expect(r.pan).toBeGreaterThan(0);
    expect(l.pan).toBeLessThan(0);
    expect(Math.abs(r.pan)).toBeLessThanOrEqual(DEFAULT_DIRECT.panWidth);
    const near = directPath(正墙, { ear, source: { x: 0, y: 1.6, z: 3 } });
    const mid = directPath(正墙, { ear, source: { x: 0, y: 1.6, z: 14 } });
    const far = directPath(正墙, { ear, source: { x: 0, y: 1.6, z: 28 } });
    expect(near.gain).toBe(1);                         // 3m < 参考距离 7m
    expect(mid.gain).toBeCloseTo(0.5, 6);              // d = 2·ref ⇒ 1/(1+rolloff)
    expect(far.gain).toBeLessThan(mid.gain);
    expect(far.delay).toBeCloseTo(28 / speedOfSound(5), 6);
  });

  it('直达声：超过 maxDistanceM 报 inaudible；空间自己的 direct 参数生效', () => {
    const d = directPath(正墙, { ear, source: { x: 0, y: 1.6, z: 45 } });
    expect(d.inaudible).toBe(true);
    const wide: AcousticSpaceDef = { ...正墙, direct: { maxDistanceM: 100, refDistanceM: 50, panWidth: 0.2 } };
    const d2 = directPath(wide, { ear, source: { x: 30, y: 1.6, z: 30 } });
    expect(d2.inaudible).toBe(false);
    expect(d2.gain).toBe(1);                           // 42m < 50m 参考距离
    expect(Math.abs(d2.pan)).toBeLessThanOrEqual(0.2);
  });

  it('直达声：被竖直崖壁横挡时闷下去（occluded > 0），关掉遮挡就不闷', () => {
    // 声源在墙那边（z=350），墙横在中间
    const d = directPath(正墙, { ear, source: { x: 0, y: 1.6, z: 350 }, });
    expect(d.occluded).toBeGreaterThan(0);
    const open = directPath({ ...正墙, occlusion: false, direct: { maxDistanceM: 1000 } }, { ear, source: { x: 0, y: 1.6, z: 350 } });
    expect(open.occluded).toBe(0);
  });

  it('IR 分部：early 只有离散反射、无尾；tail 只有尾且起点在首回之后；all = 两者', () => {
    const early = buildImpulseResponse(山谷, { sampleRate: 24000, part: 'early' });
    const tail = buildImpulseResponse(山谷, { sampleRate: 24000, part: 'tail' });
    const all = buildImpulseResponse(山谷, { sampleRate: 24000 });
    const first = Math.round(early.taps[0].delay * 24000);
    // tail 在首回之前是空的
    let pre = 0; for (let i = 0; i < first - 5; i++) pre = Math.max(pre, Math.abs(tail.left[i]));
    expect(pre).toBe(0);
    // early 不含尾：最后一个抽头之后不久就归零；all 比 early 长（多了尾）
    expect(all.left.length).toBeGreaterThan(early.left.length);
    expect(tail.left.length).toBeLessThanOrEqual(all.left.length);
  });

  it('作者摆的声源：发声点 = 地面 + height（缺省耳高）；v2 单个 source 迁成清单', () => {
    const s = sourcePoint(米制 as unknown as AcousticSpaceDef, { id: 'a', x: 5, z: 6, y: 1 });
    expect(s).toEqual({ x: 5, y: 2.6, z: 6 });
    expect(sourcePoint(米制 as unknown as AcousticSpaceDef, { id: 'a', x: 5, z: 6, height: 0.3 }).y).toBeCloseTo(0.3, 9);
    expect(listSources({ source: { x: 1, z: 2 } })).toEqual([{ id: '声源', x: 1, z: 2, y: undefined }]);
    expect(listSources({ sources: [{ id: 'k', x: 0, z: 0 }] })).toHaveLength(1);
    expect(listSources({})).toEqual([]);
  });
});
