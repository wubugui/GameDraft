/**
 * 薄片可燃（纸钱被引燃，A3.8）：受热 → 着 → 从被火碰到的那一边烧过去 → 成灰永久消失。纯函数 + 结构化数组，零 Pixi、零挂钟，
 * 与 `vfxPlate.ts` 同一套确定性前提（只吃调用方的子步长）。燃烧工作台与粒子工作台打包的是同一份。
 *
 * **参数全部取自绑的可燃物模板**（`plate.burnable.template`，只能是面燃烧模板；贴图与大小仍归粒子）：
 * 引燃时间、火焰长度、火线速度（逆流 / 顺流）、焦黑与发光、火苗粒子、火光。
 *
 * 口径（agent_docs [[burn-system]] / [[vfx-system]]）：
 * - **碰到**：片心到火焰段的距离 ≤ 火焰粗 + 片的半尺寸（× 透视度量）。每 `CONTACT_EVERY` 个子步查一次，
 *   受热按查的间隔累加、离开火按同样速率冷却——热够模板 `ignitionDelay` 秒就着。
 * - **从哪边烧、烧多快**：着的那一刻看火在片的宽度方向（切线 t）哪一侧，火线从那一侧往另一侧扫；
 *   速度与可燃物模拟同一个式子（无风，纸在飘）：`v = 逆流 + (顺流 − 逆流)·max(0, 扫的方向·上)`，
 *   一张纸烧完 = 片宽（厘米）/ v 秒——往上烧的快、往下 / 横着烧的慢。
 * - **燃着的片本身是一段火**：沿世界上方伸模板 `flameLength`；燃烧热让片处的空气多一股上升气流 √(g·L)。
 * - **烧完**：这一格永久作废（`burnt = 1`），发射 / 补回都绕开它；飞出范围被回收的燃着的片同样作废。
 * - 作废的槽位进 `newlyBurnt`，粒子系统转交燃烧系统进存档（读档后这几张不再出现）。
 */
import { BURN_WU_PER_CM, type BurnLightDef, type ResolvedBurnable } from '../../data/burnables';
import type { RgbColor, VfxFireSegment } from '../../data/types';
import { kelvinToLinearRgb } from '../../rendering/lighting/kelvin';

/** 每几个子步查一次碰火（1/120 s × 4 = 30 Hz） */
export const PLATE_BURN_CONTACT_EVERY = 4;
const WU_PER_M = 88;
const G = 9.81;

export interface PlateBurnParams {
  /** 绑的模板 id */
  template: string;
  ignitionDelay: number;
  /** 火焰长度（wu） */
  flameLenWu: number;
  /** 燃烧热托起的上升气流（wu/s，真实量） */
  liftWu: number;
  /** 火线速度（cm/s）：逆流 / 顺流 */
  speedOpposed: number;
  speedConcurrent: number;
  charColor: RgbColor;
  /** 火线发光色（sRGB 0..1）× 强度 */
  glow: RgbColor;
  glowStrength: number;
  /** 燃着的纸上发的火苗粒子：模板里 `from: flame` 的那几条（发射率 × 燃着的面积 / refArea） */
  fire: { effect: string; refArea: number }[];
  /** 火光（模板 `light`；强度 = 每平方米强度 × 燃着的面积） */
  light: BurnLightDef | null;
}

export function resolvePlateBurnParams(b: ResolvedBurnable): PlateBurnParams {
  const flameCm = Math.max(0.5, b.flameLengthCm);
  const lin = kelvinToLinearRgb(Math.max(1000, b.look.glowKelvin));
  const m = Math.max(lin[0], lin[1], lin[2], 1e-6);
  const srgb = (c: number) => Math.pow(Math.max(0, c / m), 1 / 2.2);
  return {
    template: b.id,
    ignitionDelay: b.ignitionDelay,
    flameLenWu: flameCm * BURN_WU_PER_CM,
    liftWu: Math.sqrt(G * flameCm / 100) * WU_PER_M,
    speedOpposed: b.speedOpposed,
    speedConcurrent: b.speedConcurrent,
    charColor: [b.look.charColor[0], b.look.charColor[1], b.look.charColor[2]],
    glow: [srgb(lin[0]), srgb(lin[1]), srgb(lin[2])],
    glowStrength: b.look.glowStrength,
    fire: b.particles.filter((s) => s.from === 'flame').map((s) => ({ effect: s.effect, refArea: s.refArea })),
    light: b.light,
  };
}

export interface PlateBurnState {
  P: PlateBurnParams;
  /** 累计受热（秒） */
  heat: Float32Array;
  /** 着了多久（秒）；< 0 = 没着 */
  burnT: Float32Array;
  /** 这一张从着到烧成灰要几秒（着的那一刻按朝向定） */
  dur: Float32Array;
  /** 火线从哪边扫：+1 = 从切线负侧（u=0）往正侧，−1 = 反过来 */
  dir: Int8Array;
  /** 1 = 这一格永久作废（烧没了） */
  burnt: Uint8Array;
  /** 自上次取走之后新作废的槽位 */
  newlyBurnt: number[];
  burning: number;
}

export function createPlateBurnState(cap: number, P: PlateBurnParams): PlateBurnState {
  return {
    P,
    heat: new Float32Array(cap),
    burnT: new Float32Array(cap).fill(-1),
    dur: new Float32Array(cap).fill(1),
    dir: new Int8Array(cap).fill(1),
    burnt: new Uint8Array(cap),
    newlyBurnt: [],
    burning: 0,
  };
}

/** 片心 (x,y,z) 离火焰段多近（wu） */
export function distanceToFire(f: VfxFireSegment, x: number, y: number, z: number): number {
  const px = x - f.x, py = y - f.y, pz = z - f.z;
  let s = px * f.ax + py * f.ay + pz * f.az;
  s = Math.min(f.len, Math.max(0, s));
  return Math.hypot(px - f.ax * s, py - f.ay * s, pz - f.az * s);
}

export interface PlateBurnBody {
  alive: Uint8Array;
  x: Float32Array; y: Float32Array; z: Float32Array;
}

/** 片的朝向（世界单位向量）：宽度方向切线 */
export interface PlateBurnOrient {
  tx: Float32Array; ty: Float32Array; tz: Float32Array;
}

/**
 * 一张纸着的那一刻：火在切线哪一侧（`sx,sy,sz` = 火的来处相对片心），定扫的方向与这张纸烧完要几秒。
 * `widthWu` = 片宽（真实量，wu）。
 */
export function plateIgnite(
  S: PlateBurnState, i: number, o: PlateBurnOrient, sx: number, sy: number, sz: number, widthWu: number,
): void {
  const side = sx * o.tx[i] + sy * o.ty[i] + sz * o.tz[i];
  // 火在 +t 那侧 ⇒ 火线从 u=1 往 u=0 扫（dir −1）
  const dir: 1 | -1 = side > 0 ? -1 : 1;
  const up = dir * o.ty[i];
  const P = S.P;
  const v = P.speedOpposed + (P.speedConcurrent - P.speedOpposed) * Math.max(0, up);
  S.dir[i] = dir;
  S.dur[i] = Math.max(0.05, (widthWu / BURN_WU_PER_CM) / Math.max(1e-6, v));
  S.burnT[i] = 0;
  S.heat[i] = 0;
}

/**
 * 一个子步的燃烧推进。返回本子步烧没了（被移出活池）的张数（调用方减 liveCount）。
 *
 * @param fires 外来的火焰段（本子步不变）
 * @param halfSize 片的半尺寸（wu，真实量；× 片处透视度量 `metric[i]`）
 * @param widthWu 片宽（wu，真实量；算这张纸烧完要几秒）
 * @param checkContact 这一子步查不查碰火（每 `PLATE_BURN_CONTACT_EVERY` 个子步一次）
 */
export function stepPlateBurn(
  S: PlateBurnState, b: PlateBurnBody, cap: number, h: number,
  fires: readonly VfxFireSegment[], halfSize: number, widthWu: number, metric: Float32Array, orient: PlateBurnOrient,
  checkContact: boolean, wake: (i: number) => void,
): number {
  const P = S.P;
  let removed = 0;
  let burning = 0;
  const contactH = h * PLATE_BURN_CONTACT_EVERY;
  // 本子步开头燃着的片 = 火焰段（碰别的片用；自己不碰自己）
  const own: number[] = [];
  if (checkContact) {
    for (let i = 0; i < cap; i++) if (b.alive[i] && S.burnT[i] >= 0) own.push(i);
  }
  for (let i = 0; i < cap; i++) {
    if (!b.alive[i]) continue;
    if (S.burnT[i] >= 0) {
      S.burnT[i] += h;
      if (S.burnT[i] >= S.dur[i]) {
        b.alive[i] = 0;
        S.burnt[i] = 1;
        S.burnT[i] = -1;
        S.heat[i] = 0;
        S.newlyBurnt.push(i);
        removed++;
        continue;
      }
      burning++;
      wake(i);
      continue;
    }
    if (!checkContact) continue;
    const r = halfSize * Math.max(metric[i] || 1, 1e-6);
    // 火从哪来（碰到的那段火上离片心最近的点）
    let hit = false;
    let fx = 0, fy = 0, fz = 0;
    for (let k = 0; k < fires.length && !hit; k++) {
      const f = fires[k];
      if (distanceToFire(f, b.x[i], b.y[i], b.z[i]) > f.r + r) continue;
      hit = true;
      const px = b.x[i] - f.x, py = b.y[i] - f.y, pz = b.z[i] - f.z;
      const s = Math.min(f.len, Math.max(0, px * f.ax + py * f.ay + pz * f.az));
      fx = f.x + f.ax * s; fy = f.y + f.ay * s; fz = f.z + f.az * s;
    }
    for (let k = 0; k < own.length && !hit; k++) {
      const j = own[k];
      if (j === i) continue;
      // 燃着的片：竖直向上一段火（风的倾斜在粒子层面由片自己的运动体现；这里取竖直，确定性、便宜）
      const px = b.x[i] - b.x[j], pz = b.z[i] - b.z[j];
      let s = b.y[i] - b.y[j];
      s = Math.min(P.flameLenWu, Math.max(0, s));
      const d = Math.hypot(px, b.y[i] - b.y[j] - s, pz);
      if (d > r * 2) continue;
      hit = true;
      fx = b.x[j]; fy = b.y[j] + s; fz = b.z[j];
    }
    if (hit) {
      S.heat[i] += contactH;
      if (S.heat[i] >= P.ignitionDelay) {
        plateIgnite(S, i, orient, fx - b.x[i], fy - b.y[i], fz - b.z[i], widthWu);
        burning++;
        wake(i);
      }
    } else if (S.heat[i] > 0) {
      S.heat[i] = Math.max(0, S.heat[i] - contactH);
    }
  }
  S.burning = burning;
  return removed;
}

/**
 * 燃着的片被回收器挪走（飞出范围 / 淡完补回）时调：它不会以一张新纸的样子回来——这一格作废。
 * 返回 true = 调用方应当按"杀掉"处理、不要补回。
 */
export function consumeIfBurning(S: PlateBurnState, i: number): boolean {
  if (S.burnT[i] < 0) return false;
  S.burnT[i] = -1;
  S.heat[i] = 0;
  if (!S.burnt[i]) {
    S.burnt[i] = 1;
    S.newlyBurnt.push(i);
  }
  return true;
}

/** 渲染用：第 i 张的燃烧进度 0..1（没着 = −1） */
export function plateBurnProgress(S: PlateBurnState, i: number): number {
  const t = S.burnT[i];
  return t < 0 ? -1 : Math.min(1, t / Math.max(1e-6, S.dur[i]));
}

/** 渲染用：第 i 张火线从哪边扫（+1 = 从 u=0 往 u=1） */
export function plateBurnDir(S: PlateBurnState, i: number): 1 | -1 {
  return S.dir[i] < 0 ? -1 : 1;
}
