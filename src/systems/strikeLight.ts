/**
 * 落雷的那一下强光：一盏**运行时点光**（M-world wu，铁律 0），按一条确定的亮度包络烧完就撤。
 *
 * 为什么是运行时灯而不是让作者在每个场景摆一盏：雷可以劈在任何场景、任何位置，
 * 摆灯是逐场景的作者成本，而且摆了之后那盏灯会被编辑器实时同步写回场景 JSON
 * （见 `SceneLightingSystem.setDynamicLights` 的注释）。走运行时灯这一条，作者数据一个字节不动。
 *
 * **推送必须限速**——灯每推一次整张光照缓存重烘一遍（见 [[held-prop-lights]] / [[scene-lighting]]）。
 * 这里 ≤ `STRIKE_LIGHT_PUSH_HZ`，但**主闪那一帧无条件立刻推**：雷的第一下晚 40ms 就不是雷了。
 *
 * 包络是写死的确定函数（不用 `Math.random`）：一记主闪 + 两记余闪，整体指数衰减。
 * 确定 = 无头截图与回放逐帧可复现，这是本项目的既定要求。
 */
import type { LightDef, RgbColor } from '../data/types';

/** 灯 id 前缀；与作者灯共处一张表，靠它认出"这是雷"。 */
export const STRIKE_LIGHT_ID = '__strike';
/** 限速上限（Hz）。 */
export const STRIKE_LIGHT_PUSH_HZ = 24;
/** 缺省作用半径（wu）。雷要照亮一整片，比火把那种贴身光源大得多。 */
export const STRIKE_LIGHT_DEFAULT_RANGE_WU = 4000;
/** 缺省色温（K）。雷是惨白偏蓝的冷光。 */
export const STRIKE_LIGHT_DEFAULT_KELVIN = 9000;
/**
 * 雷身沿主干切几段线光、另加几根分叉。每一段都是一盏运行时灯（灯表上限 24，作者灯排在后面）：
 * 8 段主干足够让墙上照出来的亮区跟着雷的折线走，再多就是在抢作者灯的槽位。
 */
export const STRIKE_CHANNEL_LIGHT_SEGMENTS = 8;
export const STRIKE_BRANCH_LIGHTS = 2;

export interface StrikeLightSpec {
  /** 灯位（M-world wu）：落点那一盏 */
  pos: [number, number, number];
  /** 峰值强度（包络的 1.0 处） */
  intensity: number;
  range?: number;
  softeningRadius?: number;
  kelvin?: number;
  color?: RgbColor;
  /** 总时长（ms）；到点必然熄灭并撤灯 */
  durationMs: number;
  /**
   * 三盏都打 reflect 位：在表面材质区的水面 / 湿地上照出反光（2026-09-24，落雷对齐参考图）。
   * 旧的单灯写法不打（与改动前逐位相同）。
   */
  reflect?: boolean;
  /**
   * 雷身：沿这道雷真实的折线一段一条线光（主干几段 + 最长的几根分叉），M-world wu；
   * 强度与落点那盏同一套包络。整道雷的形状都在发光，照亮沿途的墙、树、地面（09-24 制作人：「整个形状都是亮的」）。
   */
  lines?: { from: [number, number, number]; to: [number, number, number]; intensity: number; range: number }[];
  /**
   * 天上那一记平行光（云被雷照亮，整片场景一起亮一下）。反光位照打：镜面那一项按「铺满天的面光」算
   * （菲涅耳 × 水平照度，见 SceneLightingPass），平静水面正看只亮 2% 左右，不是一个点光的高光
   */
  sky?: { intensity: number; elevationDeg: number; azimuthDeg: number };
}

/**
 * 亮度包络，`u` = 已过时间 / 总时长，定义域 [0,1]，值域 [0,1]。
 *
 * 形状：0–6% 全亮的主闪 → 指数衰到暗 → 26% 与 52% 各一记短余闪（一次比一次弱）→ 收尾归零。
 * 末尾 12% 线性压到 0，保证**到点一定是 0**（不留一盏微亮的灯在场上）。
 */
export function strikeEnvelope(u: number): number {
  if (!(u > 0)) return u === 0 ? 1 : 0;
  if (u >= 1) return 0;
  const main = u < 0.06 ? 1 : Math.exp(-9 * (u - 0.06));
  const echo = (center: number, width: number, gain: number): number => {
    const d = Math.abs(u - center) / width;
    return d >= 1 ? 0 : gain * (1 - d * d);
  };
  const v = Math.max(main, echo(0.26, 0.05, 0.55), echo(0.52, 0.04, 0.3));
  const tail = u > 0.88 ? (1 - u) / 0.12 : 1;
  return Math.max(0, Math.min(1, v * tail));
}

/**
 * 由一个整数种子出两个 [0,1) 的数（随机落点用）。
 *
 * 要它而不是 `Math.random`：作者给了 `seed` 就该**每次都劈在同一个地方**——
 * 无头截图比对、回放、以及"这一拍的雷必须打在那棵树上"都靠这个。
 * 算法是两轮 32 位整数混淆（splitmix 风格），无状态、纯函数。
 */
export function seededUnitPair(seed: number): { a: number; b: number } {
  const mix = (x: number): number => {
    let h = x >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
    h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
    return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
  };
  const base = Math.trunc(seed) >>> 0;
  return { a: mix(base), b: mix(base ^ 0x9e3779b9) };
}

/**
 * 一次落雷的灯。同时只有一记雷——后发的接管（与震屏同口径：连发两条编排不该叠出双倍亮度）。
 */
export class StrikeLightRig {
  private spec: StrikeLightSpec | null = null;
  private elapsedMs = 0;
  private sincePushMs = Infinity;
  private pushedOnce = false;

  get active(): boolean { return this.spec !== null; }

  start(spec: StrikeLightSpec): void {
    if (!(spec.intensity > 0) || !(spec.durationMs > 0)) { this.clear(); return; }
    this.spec = spec;
    this.elapsedMs = 0;
    this.sincePushMs = Infinity;   // 主闪立刻推
    this.pushedOnce = false;
  }

  /** 撤灯。返回 true 表示调用方需要推一次空表把灯收掉。 */
  clear(): boolean {
    const needsPush = this.pushedOnce;
    this.spec = null;
    this.elapsedMs = 0;
    this.sincePushMs = Infinity;
    this.pushedOnce = false;
    return needsPush;
  }

  /**
   * 走一帧。返回要推的灯表；`null` = 这一帧不用推（限速没轮到）。
   * 雷放完的那一帧返回 `[]`（把灯收掉），之后恒 `null`。
   *
   * @param dtMs 毫秒
   */
  update(dtMs: number): LightDef[] | null {
    const spec = this.spec;
    if (!spec) return null;
    this.elapsedMs += Math.max(0, dtMs);
    this.sincePushMs += Math.max(0, dtMs);
    if (this.elapsedMs >= spec.durationMs) {
      const needsPush = this.clear();
      return needsPush ? [] : null;
    }
    const minGapMs = 1000 / STRIKE_LIGHT_PUSH_HZ;
    if (this.pushedOnce && this.sincePushMs < minGapMs) return null;
    this.sincePushMs = 0;
    this.pushedOnce = true;
    const k = strikeEnvelope(this.elapsedMs / spec.durationMs);
    const tone = spec.color ? { color: spec.color } : { kelvin: spec.kelvin ?? STRIKE_LIGHT_DEFAULT_KELVIN };
    const reflect = spec.reflect ? { reflect: true } : {};
    const out: LightDef[] = [{
      id: STRIKE_LIGHT_ID,
      kind: 'point',
      pos: spec.pos,
      intensity: spec.intensity * k,
      range: spec.range ?? STRIKE_LIGHT_DEFAULT_RANGE_WU,
      softeningRadius: spec.softeningRadius ?? 60,
      ...tone,
      ...reflect,
    }];
    (spec.lines ?? []).forEach((l, i) => {
      if (!(l.intensity > 0)) return;
      out.push({
        id: `${STRIKE_LIGHT_ID}_line${i}`, kind: 'line', pos: l.from, to: l.to,
        intensity: l.intensity * k, range: l.range, softeningRadius: spec.softeningRadius ?? 60,
        ...tone, ...reflect,
      });
    });
    if (spec.sky && spec.sky.intensity > 0) {
      out.push({
        id: `${STRIKE_LIGHT_ID}_sky`, kind: 'directional', elevationDeg: spec.sky.elevationDeg, azimuthDeg: spec.sky.azimuthDeg,
        intensity: spec.sky.intensity * k, ...tone, ...reflect,
      });
    }
    return out;
  }
}
