/**
 * 关键帧采样器 —— 「一串关键帧 + 一个时刻 → 一组通道值」的**唯一**实现。
 *
 * 来历：这段插值原本内联在 `CutsceneRenderer.sampleParallaxKeyframe` 里，只服务 parallax 图层的
 * 五个通道（x/y/scale/rotation/alpha）。实体轨迹动画要复用**一模一样**的时间轴语义
 * （边界、loop 环绕、缓动族、span 下限），于是抽到这里做通道无关的通用件。
 *
 * ⚠ **这份实现同时是跨语言契约**：`src/utils/keyframeSampler.golden.json` 里的金标数值由
 * 本文件与（后续的）Python 侧镜像实现共同满足。改这里的数学 = 改契约，两侧金标必须同改，
 * 而且会**改掉现网所有视差过场的手感** —— 缓动是二次族（不是三次），别"顺手升级"。
 */

/** 段内缓动族（二次）。与 `ParallaxLayerDef.easing` 逐值同构。 */
export type KeyframeEasing = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';

/**
 * 把线性进度 `u`（通常 0..1）按缓动族重映射。
 * 逐字搬自旧 `sampleParallaxKeyframe`：二次族，不夹紧、不校验入参
 * （`u` 越界时按同一多项式外推，与旧行为一致）。
 */
export function applyKeyframeEasing(u: number, easing: KeyframeEasing): number {
  return easing === 'easeIn' ? u * u
    : easing === 'easeOut' ? 1 - (1 - u) * (1 - u)
      : easing === 'easeInOut' ? (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2)
        : u;
}

export interface KeyframeSampleOptions {
  /** 时间轴是否环绕（缺省 false = 停在末帧）。仅当末帧 `atMs > 0` 时真的环绕。 */
  loop?: boolean;
  /** 关键帧自身未写 `easing` 时用的段缓动；再缺省 `linear`。 */
  defaultEasing?: KeyframeEasing;
  /**
   * 「通道名 → 缺省值」表。返回值的键集**恒等于**本表的键集：
   * 关键帧上该键不是 number（缺、undefined、字符串…）时取缺省值，**且缺省值照样参与插值**。
   */
  channels: Record<string, number>;
  /**
   * 可选顺播游标（O(1) 顺序播放）。给了就从 `cursor.i` 起线性前进/后退并回写；
   * 不给就每次从 0 全扫。**给不给的采样结果逐位相同**（有单测锁死），只是复杂度不同。
   */
  cursor?: { i: number };
}

/**
 * 在关键帧序列内按 `tMs` 采样出各通道值。
 *
 * 边界语义（与旧 parallax 实现逐字一致，改一条就是行为回归）：
 * - 单帧：直接返回该帧（不看 loop、不看 t）；
 * - `loop` 且末帧 `atMs > 0`：先把 t 折进 `[0, 末帧atMs)`（`((t%total)+total)%total`，负 t 也对）；
 * - `t <= 首帧.atMs` → 首帧；`t >= 末帧.atMs` → 末帧；
 * - 段长 `span = Math.max(1, b.atMs - a.atMs)` —— **下限 1ms**，所以亚毫秒段会被拉长
 *   （0.5ms 的段里 t=0.25 得到 u=0.25 而不是 0.5）。这是既有行为，不是 bug。
 * - 段缓动取 `a.easing ?? defaultEasing ?? 'linear'`（**起始帧**说了算，末帧的 easing 永不生效）。
 *
 * 空数组（旧实现会抛 TypeError，且调用方已全部前置拦掉）在此返回一份缺省值副本：
 * 对既有调用方不可达，对新调用方比抛异常安全。
 */
export function sampleKeyframeTrack<K extends { atMs: number; easing?: KeyframeEasing }>(
  kf: readonly K[],
  tMs: number,
  opts: KeyframeSampleOptions,
): Record<string, number> {
  const channels = opts.channels;
  const names = Object.keys(channels);
  const norm = (k: K): Record<string, number> => {
    const src = k as unknown as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const name of names) {
      const v = src[name];
      out[name] = typeof v === 'number' ? v : channels[name];
    }
    return out;
  };
  const cursor = opts.cursor;
  const setCursor = (i: number): void => { if (cursor) cursor.i = i; };

  if (kf.length === 0) { setCursor(0); return { ...channels }; }
  if (kf.length === 1) { setCursor(0); return norm(kf[0]); }

  const last = kf[kf.length - 1];
  const total = last.atMs;
  let t = tMs;
  if (opts.loop && total > 0) t = ((t % total) + total) % total;
  if (t <= kf[0].atMs) { setCursor(0); return norm(kf[0]); }
  if (t >= last.atMs) { setCursor(kf.length - 2); return norm(last); }

  let i = 0;
  if (cursor) {
    // 游标可能被 loop 环绕/倒放/外部乱写抛在后面或前面：先夹紧再双向线性收敛。
    i = Math.trunc(cursor.i);
    if (!(i >= 0)) i = 0;
    if (i > kf.length - 2) i = kf.length - 2;
    while (i > 0 && kf[i].atMs > t) i--;
  }
  while (i < kf.length - 1 && kf[i + 1].atMs <= t) i++;
  setCursor(i);

  const a = kf[i], b = kf[i + 1];
  const span = Math.max(1, b.atMs - a.atMs);
  const u = applyKeyframeEasing((t - a.atMs) / span, a.easing ?? opts.defaultEasing ?? 'linear');
  const A = norm(a), B = norm(b);
  const out: Record<string, number> = {};
  for (const name of names) out[name] = A[name] + (B[name] - A[name]) * u;
  return out;
}
