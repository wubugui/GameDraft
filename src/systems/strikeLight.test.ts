import { describe, expect, it } from 'vitest';
import {
  StrikeLightRig, seededUnitPair, strikeEnvelope,
  STRIKE_LIGHT_ID, STRIKE_LIGHT_PUSH_HZ,
} from './strikeLight';
import { sampleStrikeFallback, type StrikeSurfacePoint } from './strikePresentation';

describe('落雷的灯', () => {
  it('包络：主闪满亮、末尾必然归零、全程夹在 0..1', () => {
    expect(strikeEnvelope(0)).toBe(1);
    expect(strikeEnvelope(0.03)).toBe(1);
    // 到点必须是 0：留一盏微亮的灯在场上比不亮更糟（画面莫名偏亮且没人知道是谁）
    expect(strikeEnvelope(1)).toBe(0);
    expect(strikeEnvelope(1.5)).toBe(0);
    for (let i = 0; i <= 100; i++) {
      const v = strikeEnvelope(i / 100);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('包络：主闪之后确实暗下去，且两记余闪比主闪弱', () => {
    const dip = strikeEnvelope(0.18);           // 主闪与第一记余闪之间的谷
    expect(dip).toBeLessThan(0.5);
    expect(strikeEnvelope(0.26)).toBeGreaterThan(dip);   // 第一记余闪
    expect(strikeEnvelope(0.26)).toBeLessThan(1);
    expect(strikeEnvelope(0.52)).toBeLessThan(strikeEnvelope(0.26));  // 一记比一记弱
  });

  it('主闪那一帧无条件立刻推，之后按限速推', () => {
    const rig = new StrikeLightRig();
    rig.start({ pos: [1, 2, 3], intensity: 40, durationMs: 400 });
    const first = rig.update(4);
    expect(first).not.toBeNull();
    expect(first?.[0]?.id).toBe(STRIKE_LIGHT_ID);
    expect(first?.[0]?.intensity).toBeCloseTo(40, 5);   // 主闪 = 峰值
    // 限速窗口内不再推（灯每推一次整张光照缓存重烘一遍）
    const gapMs = 1000 / STRIKE_LIGHT_PUSH_HZ;
    expect(rig.update(gapMs * 0.3)).toBeNull();
    expect(rig.update(gapMs * 0.3)).toBeNull();
    expect(rig.update(gapMs * 0.6)).not.toBeNull();
  });

  it('到点收灯：最后一帧推一次空表，之后恒 null', () => {
    const rig = new StrikeLightRig();
    rig.start({ pos: [0, 0, 0], intensity: 10, durationMs: 100 });
    expect(rig.update(4)).not.toBeNull();
    expect(rig.update(200)).toEqual([]);     // 收掉
    expect(rig.active).toBe(false);
    expect(rig.update(16)).toBeNull();
  });

  it('没推过就不用收：clear 不会让调用方白推一次空表', () => {
    const rig = new StrikeLightRig();
    expect(rig.clear()).toBe(false);
    rig.start({ pos: [0, 0, 0], intensity: 10, durationMs: 100 });
    expect(rig.clear()).toBe(false);          // start 了但一帧都没走过 ⇒ 场上没有灯
    rig.start({ pos: [0, 0, 0], intensity: 10, durationMs: 100 });
    rig.update(4);
    expect(rig.clear()).toBe(true);           // 推过 ⇒ 必须收
  });

  it('强度或时长为 0 视为不放雷', () => {
    const rig = new StrikeLightRig();
    rig.start({ pos: [0, 0, 0], intensity: 0, durationMs: 400 });
    expect(rig.active).toBe(false);
    rig.start({ pos: [0, 0, 0], intensity: 9, durationMs: 0 });
    expect(rig.active).toBe(false);
  });

  it('后发的接管，不叠加', () => {
    const rig = new StrikeLightRig();
    rig.start({ pos: [0, 0, 0], intensity: 10, durationMs: 400 });
    rig.update(4);
    rig.update(300);
    rig.start({ pos: [5, 5, 5], intensity: 10, durationMs: 400 });
    const next = rig.update(4);
    // 接管 = 从头按新参数来：又是主闪的峰值，位置也换成新的
    expect(next?.[0]?.intensity).toBeCloseTo(10, 5);
    expect(next?.[0]?.pos).toEqual([5, 5, 5]);
  });

  it('color 与 kelvin 二选一，绝不同时写（两者都给时运行时 color 赢，写两份会让人以为能混用）', () => {
    const rig = new StrikeLightRig();
    rig.start({ pos: [0, 0, 0], intensity: 5, durationMs: 200, color: [0.5, 0.6, 1] });
    const withColor = rig.update(4)?.[0];
    expect(withColor?.color).toEqual([0.5, 0.6, 1]);
    expect(withColor?.kelvin).toBeUndefined();

    const rig2 = new StrikeLightRig();
    rig2.start({ pos: [0, 0, 0], intensity: 5, durationMs: 200 });
    const withKelvin = rig2.update(4)?.[0];
    expect(withKelvin?.kelvin).toBeGreaterThan(0);
    expect(withKelvin?.color).toBeUndefined();
  });
});

describe('随机落点的种子', () => {
  it('同一个种子恒出同一对数（无头复现靠这条）', () => {
    expect(seededUnitPair(7)).toEqual(seededUnitPair(7));
    expect(seededUnitPair(7)).not.toEqual(seededUnitPair(8));
  });

  it('两个分量落在 [0,1) 且互不相等（同值会让落点永远在一条对角线上）', () => {
    for (const seed of [0, 1, 42, 9999, -3, 2 ** 31]) {
      const { a, b } = seededUnitPair(seed);
      for (const v of [a, b]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
      }
      expect(a).not.toBe(b);
    }
  });
});

describe('无目标落雷的世界表面距离', () => {
  const point = (world: [number, number, number], areaWu2 = 1): StrikeSurfacePoint => ({
    x: 50, y: 50, world, normal: [0, 1, 0], kind: 'ground', areaWu2,
  });
  const pick = (candidates: StrikeSurfacePoint[], extra: Partial<Parameters<typeof sampleStrikeFallback>[0]> = {}) =>
    sampleStrikeFallback({ from: [0, 0, 0], radius: 100, minDistance: 20, separation: 0,
      previous: [], random: { angle: 0.2, radius: 0.3 }, candidates,
      bounds: { left: 0, right: 100, top: 0, bottom: 100 }, ...extra });

  it('同一个画面位置，纵深和高差超出半径都拒绝；保留原始表面坐标', () => {
    const near = point([30, 40, 0]);
    expect(pick([point([0, 0, 101]), point([0, 101, 0]), near])).toBe(near);
    expect(pick([point([0, 0, 101]), point([0, 101, 0])])).toBeNull();
    expect(pick([point([0, 0, 19])])).toBeNull();
    expect(pick([point([0, 0, 100])])?.world).toEqual([0, 0, 100]);
  });

  it('镜头边界只筛掉候选，不会把点夹到边上或放宽世界距离', () => {
    const outside = { ...point([0, 0, 50]), x: 101 };
    expect(pick([outside])).toBeNull();
    expect(outside.x).toBe(101);
    expect(pick([point([0, 0, 50])], { minDistance: 110 })).toBeNull();
    expect(pick([])).toBeNull();
  });

  it('间距同样包含纵深；严格配置无解则跳过，允许放宽也必须仍贴原面', () => {
    const p = point([0, 0, 60]);
    expect(pick([p], { previous: [[0, 0, 20]], separation: 40, strictSeparation: true })).toBe(p);
    expect(pick([p], { previous: [[0, 0, 59]], separation: 40, strictSeparation: true })).toBeNull();
    expect(pick([p], { previous: [[0, 0, 59]], separation: 40, strictSeparation: false })).toBe(p);
  });

  it('按世界表面积抽样，同样的种子和候选得到同样结果', () => {
    const small = point([0, 0, 40], 1), large = point([0, 0, 60], 3);
    let largeHits = 0;
    for (let i = 0; i < 1000; i++) {
      const options = { random: { angle: (i + 0.5) / 1000, radius: 0 } };
      const chosen = pick([small, large], options);
      expect(pick([small, large], options)).toBe(chosen);
      if (chosen === large) largeHits++;
    }
    expect(largeHits).toBe(750);
  });
});
