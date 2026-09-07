import { describe, it, expect } from 'vitest';
import spacesJson from '../../public/assets/data/acoustic_spaces.json';
import {
  buildImpulseResponse, collectTaps, nearestGapSeconds,
  type AcousticSpaceDef,
} from './acousticSpace';

/**
 * 校验**线上那份** `acoustic_spaces.json`，不是手写样例。
 * 样例永远挑不出你没想到的那类真实数据。
 */
const raw = spacesJson as unknown as { spaces: Record<string, AcousticSpaceDef> };
const spaces = Object.entries(raw.spaces);

/**
 * 各空间的设计意图，写成可判定的判据。
 *
 * ⚠ 「首回时刻」不等于「有没有悠远回音」。栈道上人贴着岩壁走，身后几米就有面墙，
 * 那记几十毫秒的近反射是**贴壁的箱声**，本来就该有；峡谷真正要保证的是
 * **对崖那记远回**存在。所以近反射与远回分开判 —— 这条是测试第一次跑挂时想清楚的：
 * 挂的是判据，不是数据。
 */
const 意图: Record<string, {
  /** 首个反射的时刻区间 */
  minGap?: number; maxGap?: number;
  /** 必须存在一个晚于此刻的反射（远回） */
  farReturnAfter?: number;
  /** 必须**不存在**晚于此刻的反射（确实没有远处的面） */
  noReturnAfter?: number;
  minTaps?: number;
}> = {
  // 开阔山脊：近处什么都没有，首回必须晚于 1.5s，才放得下 3 秒的猿啼
  '山谷_大': { minGap: 1.5, minTaps: 6 },
  // 贴壁栈道：身后有壁（近反射合理），但对崖那记远回必须在
  '峡谷_窄深': { maxGap: 0.2, farReturnAfter: 0.7, minTaps: 6 },
  // 棺龛墙：近而密，回音压在原声上是对的（多重错拍）
  '棺龛墙': { maxGap: 0.2, minTaps: 10 },
  // 墓面：近处密，外加临江对岸的一记远回
  '崖墓_墓面': { maxGap: 0.2, farReturnAfter: 1.0, minTaps: 10 },
  // 背风处：几乎无回，而且**远处不能有任何东西**
  '贴壁_无回': { maxGap: 0.1, noReturnAfter: 0.3 },
};

describe('acoustic_spaces.json 全集', () => {
  it('至少有五个空间', () => {
    expect(spaces.length).toBeGreaterThanOrEqual(5);
  });

  it.each(spaces)('%s 结构合法', (_name, space) => {
    expect(space.listener).toBeTruthy();
    expect(Array.isArray(space.reflectors)).toBe(true);
    for (const r of space.reflectors) {
      expect(r.a).toHaveLength(2);
      expect(r.b).toHaveLength(2);
      expect(r.height).toBeGreaterThan(0);
      expect(r.absorb).toBeGreaterThanOrEqual(0);
      expect(r.absorb).toBeLessThanOrEqual(1);
      expect(r.rough).toBeGreaterThanOrEqual(0);
      expect(r.rough).toBeLessThanOrEqual(1);
      // 端点不能重合，否则镜像退化
      expect(Math.hypot(r.b[0] - r.a[0], r.b[1] - r.a[1])).toBeGreaterThan(0.5);
    }
  });

  it.each(spaces)('%s 能算出抽头且都是有限数', (_name, space) => {
    const taps = collectTaps(space);
    expect(taps.length).toBeGreaterThan(0);
    for (const t of taps) {
      expect(Number.isFinite(t.delay)).toBe(true);
      expect(Number.isFinite(t.gain)).toBe(true);
      expect(t.gain).toBeGreaterThan(0);
      expect(t.delay).toBeGreaterThan(0);
    }
  });

  it.each(spaces)('%s 首回时刻符合设计意图', (name, space) => {
    const gap = nearestGapSeconds(space);
    const want = 意图[name];
    if (!want) return;
    if (want.minGap !== undefined) expect(gap).toBeGreaterThan(want.minGap);
    if (want.maxGap !== undefined) expect(gap).toBeLessThan(want.maxGap);
  });

  it.each(spaces)('%s 远回的有无符合设计意图', (name, space) => {
    const want = 意图[name];
    if (!want) return;
    const taps = collectTaps(space);
    if (want.farReturnAfter !== undefined) {
      const far = taps.filter((t) => t.delay > want.farReturnAfter!);
      expect(far.length, `${name} 应当有晚于 ${want.farReturnAfter}s 的远回`)
        .toBeGreaterThan(0);
      // 远回不能弱到听不见（相对最强抽头 -60dB 以内）
      const strongest = Math.max(...taps.map((t) => t.gain));
      expect(Math.max(...far.map((t) => t.gain))).toBeGreaterThan(strongest * 1e-3);
    }
    if (want.noReturnAfter !== undefined) {
      const late = taps.filter((t) => t.delay > want.noReturnAfter!);
      expect(late.length, `${name} 不该有晚于 ${want.noReturnAfter}s 的反射`).toBe(0);
    }
  });

  it.each(spaces)('%s 抽头数量符合设计意图', (name, space) => {
    const want = 意图[name];
    if (!want?.minTaps) return;
    expect(collectTaps(space).length).toBeGreaterThanOrEqual(want.minTaps);
  });

  it.each(spaces)('%s IR 能构建、长度合理、不削顶', (_name, space) => {
    const ir = buildImpulseResponse(space, { sampleRate: 24000 });
    expect(ir.left.length).toBe(ir.right.length);
    // 不能长到离谱（>30s 多半是摆错了距离）
    expect(ir.left.length / 24000).toBeLessThan(30);
    let peak = 0;
    for (let i = 0; i < ir.left.length; i++) {
      peak = Math.max(peak, Math.abs(ir.left[i]), Math.abs(ir.right[i]));
    }
    expect(peak).toBeLessThanOrEqual(1);
    expect(peak).toBeGreaterThan(0);
  });

  it('山谷比棺龛墙的首回晚得多 —— 这是两种空间的本质差别', () => {
    expect(nearestGapSeconds(raw.spaces['山谷_大']))
      .toBeGreaterThan(nearestGapSeconds(raw.spaces['棺龛墙']) * 5);
  });
});

describe('线上数据用上了新能力', () => {
  it('峡谷有脚下的水面（水平反射面），崖墓有头顶岩檐', () => {
    const gorge = raw.spaces['峡谷_窄深'];
    const tomb = raw.spaces['崖墓_墓面'];
    const horiz = (s: AcousticSpaceDef) =>
      s.reflectors.filter((r) => (r.tiltDeg ?? 0) >= 45);
    expect(horiz(gorge).length).toBeGreaterThan(0);
    expect(horiz(tomb).length).toBeGreaterThan(0);
  });

  it('峡谷的水面给出上下来回那一记，方向在下方', () => {
    const taps = collectTaps(raw.spaces['峡谷_窄深']);
    const down = taps.filter((t) => t.elevation < -0.5);
    expect(down.length).toBeGreaterThan(0);
  });

  it.each(spaces)('%s 听者挪动会改变回音（实时的前提）', (_n, space) => {
    const base = collectTaps(space);
    if (!base.length) return;
    const moved = collectTaps(space, { listener: { ...space.listener, z: (space.listener.z ?? 0) + 40 } });
    const same = base.length === moved.length
      && base.every((t, i) => Math.abs(t.delay - moved[i].delay) < 1e-6);
    expect(same).toBe(false);
  });

  it.each(spaces)('%s 每个空间都显式写了遮挡开关与 wuPerMeter', (_n, space) => {
    expect(typeof space.occlusion).toBe('boolean');
    expect(space.wuPerMeter).toBeGreaterThan(0);
  });
});
