import { describe, expect, it } from 'vitest';
import {
  StrikeLightRig, seededUnitPair, strikeEnvelope,
  STRIKE_LIGHT_ID, STRIKE_LIGHT_PUSH_HZ,
} from './strikeLight';

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
