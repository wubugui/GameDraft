import { describe, expect, it } from 'vitest';
import { CutsceneRenderer } from '../rendering/CutsceneRenderer';
import type { ParallaxKeyframe } from '../data/types';
import { applyKeyframeEasing, sampleKeyframeTrack, type KeyframeEasing } from './keyframeSampler';
import goldenRaw from './keyframeSampler.golden.json';

/**
 * 关键帧采样器的金标锁。
 *
 * `keyframeSampler.golden.json` 里的期望值**全部手算**（每条 case 的 note 写着算式），
 * 不是从实现反向生成的 —— 所以它同时是「不许悄悄改插值数学」的闸和**跨语言契约**：
 * 后续 Python 侧镜像实现读同一份 JSON、断同一批数。字段名与数值都是契约的一部分。
 *
 * 另有两道回归闸，锁住「抽公共件 = 零行为差异」：
 * 1. 同一份 fixture 过 `CutsceneRenderer` 的 parallax 私有入口，结果必须一致；
 * 2. parallax 入口与**重构前那份内联实现的逐字副本**在密集采样网格上必须逐位相同。
 */

/** 浮点断言容差（契约值，两侧语言同用）。 */
const TOL = 1e-9;

interface GoldenSample { tMs: number; expect: Record<string, number> }
interface GoldenCase {
  name: string;
  note?: string;
  keyframes: (Record<string, number | string | undefined> & { atMs: number; easing?: KeyframeEasing })[];
  channels: Record<string, number>;
  defaultEasing: KeyframeEasing;
  loop: boolean;
  samples: GoldenSample[];
}
const CASES = goldenRaw as unknown as GoldenCase[];

function expectClose(got: number, want: number, what: string): void {
  expect(Number.isFinite(got), `${what}: 期望有限数，实得 ${got}`).toBe(true);
  expect(Math.abs(got - want) <= TOL, `${what}: 期望 ${want}，实得 ${got}（差 ${got - want}）`).toBe(true);
}

// ============================================================
// 缓动族（二次，不是三次）
// ============================================================

describe('applyKeyframeEasing', () => {
  it('二次族逐值手算对齐', () => {
    for (const [u, want] of [[0, 0], [0.25, 0.25], [0.5, 0.5], [1, 1]] as const) {
      expectClose(applyKeyframeEasing(u, 'linear'), want, `linear(${u})`);
    }
    for (const [u, want] of [[0, 0], [0.25, 0.0625], [0.5, 0.25], [0.75, 0.5625], [1, 1]] as const) {
      expectClose(applyKeyframeEasing(u, 'easeIn'), want, `easeIn(${u})`);
    }
    for (const [u, want] of [[0, 0], [0.25, 0.4375], [0.5, 0.75], [0.75, 0.9375], [1, 1]] as const) {
      expectClose(applyKeyframeEasing(u, 'easeOut'), want, `easeOut(${u})`);
    }
    for (const [u, want] of [[0, 0], [0.125, 0.03125], [0.25, 0.125], [0.5, 0.5], [0.75, 0.875], [1, 1]] as const) {
      expectClose(applyKeyframeEasing(u, 'easeInOut'), want, `easeInOut(${u})`);
    }
  });

  it('easeIn/easeOut 互为镜像、easeInOut 关于 (0.5,0.5) 中心对称', () => {
    for (let u = 0; u <= 1.0000001; u += 0.05) {
      expectClose(applyKeyframeEasing(u, 'easeOut'), 1 - applyKeyframeEasing(1 - u, 'easeIn'), `mirror(${u})`);
      expectClose(applyKeyframeEasing(u, 'easeInOut'), 1 - applyKeyframeEasing(1 - u, 'easeInOut'), `sym(${u})`);
    }
  });
});

// ============================================================
// 金标 fixture
// ============================================================

describe('sampleKeyframeTrack 金标 fixture', () => {
  it('fixture 自身完整（每个 sample 的 expect 键集 == channels 键集）', () => {
    expect(CASES.length).toBeGreaterThan(0);
    const seen = new Set<string>();
    for (const c of CASES) {
      expect(seen.has(c.name), `case 名重复: ${c.name}`).toBe(false);
      seen.add(c.name);
      const chans = Object.keys(c.channels).sort();
      expect(chans.length, `${c.name}: channels 不能为空`).toBeGreaterThan(0);
      for (const s of c.samples) {
        expect(Object.keys(s.expect).sort(), `${c.name} @${s.tMs}`).toEqual(chans);
      }
    }
  });

  for (const c of CASES) {
    it(c.name, () => {
      for (const s of c.samples) {
        const got = sampleKeyframeTrack(c.keyframes, s.tMs, {
          loop: c.loop,
          defaultEasing: c.defaultEasing,
          channels: c.channels,
        });
        expect(Object.keys(got).sort(), `${c.name} @${s.tMs}: 返回键集`).toEqual(Object.keys(c.channels).sort());
        for (const [k, want] of Object.entries(s.expect)) {
          expectClose(got[k], want, `${c.name} @${s.tMs}.${k}`);
        }
      }
    });
  }
});

// ============================================================
// 顺播游标：给不给 cursor，结果必须逐位相同
// ============================================================

describe('sampleKeyframeTrack 顺播游标', () => {
  it('随机访问：cursor 版与全扫版逐位相同（且 cursor 被夹在合法段内）', () => {
    for (const c of CASES) {
      const cursor = { i: 0 };
      const segMax = Math.max(0, c.keyframes.length - 2);
      // 刻意乱序 + 越界游标，逼 cursor 走双向收敛
      const times = [...c.samples.map((s) => s.tMs)].reverse().concat(c.samples.map((s) => s.tMs));
      for (const t of times) {
        const scan = sampleKeyframeTrack(c.keyframes, t, {
          loop: c.loop, defaultEasing: c.defaultEasing, channels: c.channels,
        });
        const withCursor = sampleKeyframeTrack(c.keyframes, t, {
          loop: c.loop, defaultEasing: c.defaultEasing, channels: c.channels, cursor,
        });
        for (const k of Object.keys(c.channels)) {
          expect(withCursor[k], `${c.name} @${t}.${k}`).toBe(scan[k]);
        }
        expect(cursor.i >= 0 && cursor.i <= segMax, `${c.name} @${t}: cursor.i=${cursor.i} 越界`).toBe(true);
      }
    }
  });

  it('外部把 cursor 写坏（负数/NaN/超界）也不影响结果', () => {
    const c = CASES.find((x) => x.name === 'three-frames-linear-unequal-spans');
    expect(c).toBeTruthy();
    const kase = c as GoldenCase;
    for (const bad of [-5, 999, Number.NaN, 1.9]) {
      for (const s of kase.samples) {
        const cursor = { i: bad };
        const got = sampleKeyframeTrack(kase.keyframes, s.tMs, {
          loop: kase.loop, defaultEasing: kase.defaultEasing, channels: kase.channels, cursor,
        });
        for (const [k, want] of Object.entries(s.expect)) {
          expectClose(got[k], want, `cursor=${bad} @${s.tMs}.${k}`);
        }
      }
    }
  });

  it('顺播（时间单调递增）时 cursor 只前进', () => {
    const kase = CASES.find((x) => x.name === 'multichannel-defaults-participate') as GoldenCase;
    const cursor = { i: 0 };
    let prev = -1;
    for (let t = 0; t <= 800; t += 5) {
      sampleKeyframeTrack(kase.keyframes, t, {
        loop: false, defaultEasing: kase.defaultEasing, channels: kase.channels, cursor,
      });
      expect(cursor.i >= prev, `t=${t}: cursor 回退了 ${prev} -> ${cursor.i}`).toBe(true);
      prev = cursor.i;
    }
  });
});

// ============================================================
// 空数组：既有调用方全部前置拦掉，这里只锁「不抛异常、返回缺省」
// ============================================================

it('空关键帧返回一份 channels 缺省副本（不抛）', () => {
  const channels = { x: 3, y: 4 };
  const got = sampleKeyframeTrack([] as { atMs: number }[], 123, { channels });
  expect(got).toEqual({ x: 3, y: 4 });
  expect(got).not.toBe(channels);
});

// ============================================================
// 回归闸 1：同一 fixture 过 CutsceneRenderer 的 parallax 入口
// ============================================================

type ParallaxSampler = (
  kf: ParallaxKeyframe[],
  nowMs: number,
  loop: boolean,
  easing: KeyframeEasing,
) => Required<Omit<ParallaxKeyframe, 'atMs'>>;

/**
 * 取 private 方法：它是纯函数（不读 `this`），所以直接从原型上摘下来调即可，
 * 不必构造 `CutsceneRenderer`（那需要真 Pixi renderer / AssetManager）。
 */
const sampleParallax = (CutsceneRenderer.prototype as unknown as {
  sampleParallaxKeyframe: ParallaxSampler;
}).sampleParallaxKeyframe;

/** parallax 入口写死的通道缺省（= CutsceneRenderer 内 PARALLAX_KEYFRAME_CHANNELS）。 */
const PARALLAX_DEFAULTS: Record<string, number> = { x: 0, y: 0, scale: 1, rotation: 0, alpha: 1 };

describe('parallax 入口与通用采样器一致', () => {
  it('fixture 里凡属 parallax 通道的，缺省值与 parallax 入口一致（否则下面的比对不成立）', () => {
    for (const c of CASES) {
      for (const [k, v] of Object.entries(c.channels)) {
        if (k in PARALLAX_DEFAULTS) {
          expect(v, `${c.name}.channels.${k}`).toBe(PARALLAX_DEFAULTS[k]);
        }
      }
    }
  });

  it('同一 fixture 经 parallax 入口得到同样结果', () => {
    for (const c of CASES) {
      const kf = c.keyframes as unknown as ParallaxKeyframe[];
      for (const s of c.samples) {
        const got = sampleParallax(kf, s.tMs, c.loop, c.defaultEasing);
        for (const [k, want] of Object.entries(s.expect)) {
          // sortY 不是 parallax 通道，跳过；其余通道逐条对
          if (!(k in PARALLAX_DEFAULTS)) continue;
          expectClose((got as unknown as Record<string, number>)[k], want, `parallax ${c.name} @${s.tMs}.${k}`);
        }
      }
    }
  });
});

// ============================================================
// 回归闸 2：与重构前那份内联实现的逐字副本比对（密集网格，逐位相等）
// ============================================================

/**
 * **重构前** `CutsceneRenderer.sampleParallaxKeyframe` 的逐字副本（2026-09-03 抽公共件之前）。
 * 只存在于本测试里，作为「零行为差异」的对照物。**不要**跟着新实现改它 ——
 * 它变了这道闸就失去意义。
 */
function legacySampleParallaxKeyframe(
  kf: ParallaxKeyframe[],
  nowMs: number,
  loop: boolean,
  easing: KeyframeEasing,
): Required<Omit<ParallaxKeyframe, 'atMs'>> {
  const norm = (k: ParallaxKeyframe) => ({
    x: k.x, y: k.y,
    scale: typeof k.scale === 'number' ? k.scale : 1,
    rotation: typeof k.rotation === 'number' ? k.rotation : 0,
    alpha: typeof k.alpha === 'number' ? k.alpha : 1,
  });
  if (kf.length === 1) return norm(kf[0]);
  const last = kf[kf.length - 1];
  const total = last.atMs;
  let t = nowMs;
  if (loop && total > 0) t = ((t % total) + total) % total;
  if (t <= kf[0].atMs) return norm(kf[0]);
  if (t >= last.atMs) return norm(last);
  let i = 0;
  while (i < kf.length - 1 && kf[i + 1].atMs <= t) i++;
  const a = kf[i], b = kf[i + 1];
  const span = Math.max(1, b.atMs - a.atMs);
  let u = (t - a.atMs) / span;
  u = easing === 'easeIn' ? u * u
    : easing === 'easeOut' ? 1 - (1 - u) * (1 - u)
      : easing === 'easeInOut' ? (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2)
        : u;
  const A = norm(a), B = norm(b);
  return {
    x: A.x + (B.x - A.x) * u,
    y: A.y + (B.y - A.y) * u,
    scale: A.scale + (B.scale - A.scale) * u,
    rotation: A.rotation + (B.rotation - A.rotation) * u,
    alpha: A.alpha + (B.alpha - A.alpha) * u,
  };
}

const GRID_TRACKS: { name: string; kf: ParallaxKeyframe[] }[] = [
  { name: '单帧', kf: [{ atMs: 0, x: 5, y: 6 }] },
  { name: '单帧带全通道', kf: [{ atMs: 300, x: 5, y: 6, scale: 0.5, rotation: 30, alpha: 0.25 }] },
  {
    name: '两帧',
    kf: [
      { atMs: 0, x: 0, y: 0, scale: 1, rotation: 0, alpha: 1 },
      { atMs: 1000, x: 640, y: -360, scale: 2.5, rotation: -90, alpha: 0 },
    ],
  },
  {
    name: '五帧不等距+缺通道',
    kf: [
      { atMs: 0, x: 0, y: 0 },
      { atMs: 33, x: 12, y: -7, scale: 1.2 },
      { atMs: 700, x: 900, y: 41, rotation: 15 },
      { atMs: 701, x: 901, y: 41.5, alpha: 0.5 },
      { atMs: 2345, x: -30, y: 800, scale: 0.3, rotation: 720, alpha: 1 },
    ],
  },
  {
    name: '重复时间戳',
    kf: [
      { atMs: 0, x: 0, y: 0 },
      { atMs: 500, x: 100, y: 10 },
      { atMs: 500, x: 200, y: 20 },
      { atMs: 900, x: 300, y: 30 },
    ],
  },
  {
    name: '亚毫秒段',
    kf: [
      { atMs: 0, x: 0, y: 0 },
      { atMs: 0.5, x: 100, y: 50 },
      { atMs: 10, x: 200, y: 100 },
    ],
  },
  {
    name: '首帧非零起点',
    kf: [
      { atMs: 250, x: 10, y: 10 },
      { atMs: 1250, x: 110, y: -90 },
    ],
  },
];

const EASINGS: KeyframeEasing[] = ['linear', 'easeIn', 'easeOut', 'easeInOut'];

describe('parallax 入口 == 重构前内联实现（逐位）', () => {
  it('密集时间网格 × 4 缓动 × loop 开关', () => {
    let checked = 0;
    for (const track of GRID_TRACKS) {
      for (const easing of EASINGS) {
        for (const loop of [false, true]) {
          for (let t = -2500; t <= 5000; t += 37) {
            const want = legacySampleParallaxKeyframe(track.kf, t, loop, easing);
            const got = sampleParallax(track.kf, t, loop, easing);
            const where = `${track.name}/${easing}/loop=${loop}@${t}`;
            expect(got.x, `${where}.x`).toBe(want.x);
            expect(got.y, `${where}.y`).toBe(want.y);
            expect(got.scale, `${where}.scale`).toBe(want.scale);
            expect(got.rotation, `${where}.rotation`).toBe(want.rotation);
            expect(got.alpha, `${where}.alpha`).toBe(want.alpha);
            checked++;
          }
          // 段边界与亚毫秒时刻单独补几个非整数 t
          for (const t of [-0.5, 0, 0.25, 0.5, 0.75, 32.999, 33, 33.001, 499.5, 500, 700.5, 701, 2344.75, 2345]) {
            const want = legacySampleParallaxKeyframe(track.kf, t, loop, easing);
            const got = sampleParallax(track.kf, t, loop, easing);
            const where = `${track.name}/${easing}/loop=${loop}@${t}`;
            expect(got.x, `${where}.x`).toBe(want.x);
            expect(got.y, `${where}.y`).toBe(want.y);
            expect(got.scale, `${where}.scale`).toBe(want.scale);
            expect(got.rotation, `${where}.rotation`).toBe(want.rotation);
            expect(got.alpha, `${where}.alpha`).toBe(want.alpha);
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(10000);
  });
});
