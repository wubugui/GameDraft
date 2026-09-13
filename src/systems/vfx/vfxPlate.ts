/**
 * 薄片粒子（纸钱 / 落叶 / 布片）的模拟：每颗粒子是一张有朝向、会弯的薄片。
 *
 * ## 气动（准定常平板，全部真实单位）
 *
 * - 空气速度 u = 场景风（`sceneWind`，含近地对数廓线与顺流推进的阵风）+ 湍流脉动（强度 × |u| × curl 噪声），
 *   相对风 w = u − v。
 * - 法向压差力 `kₙ (w·n)|w·n| n`，kₙ = g / v_t²（`terminalSpeed` = 平着自由下落的终端速度）；
 *   切向摩擦 `kₜ |wₜ| wₜ`，kₜ = kₙ × `edgeDrag`；卷起来的片边缘多兜一份风（形阻，迎风投影 ≈ |弯曲| / 2）。
 * - 翻转力矩：压心偏在迎风一侧（`pressureOffset` × 弦长）⇒ 角加速度 `24 kₙ c / L · (w·n)(n × w)`，
 *   让片横对来流（平板真实的稳定姿态）。转动阻尼由片旋转时边缘扫过空气的压差积出来：`0.375 kₙ L |ω|ω`，
 *   没有可调系数。翻飞、滑翔、飘落都是这几项的结果。
 *
 * ## 接触（地面 = 行走面高度场，物面 = 深度壳）
 *
 * - 库仑摩擦：法向力 N（重力与风压往面里压的那一份）× μ。静摩擦 + 附着力 `hold` 顶得住就一动不动；
 *   顶不住按 μₖ 滑。**不是**每子步乘个衰减系数——那样的"摩擦"跟步长绑死、而且是黏滞的。
 * - 贴死的纸（`hold = ∞`）吹不走，但形变照样跟着风（边角掀动由渲染按风速做）。
 * - 片着地后受重力绕接触边翻平（`1.5 g / L` 的倒伏角加速度，薄板绕边转动的刚体解）。
 *
 * ## 睡眠
 *
 * 静止在面上超过 0.5 s 的片入睡：之后只做一次便宜的唤醒检查（此处的风能不能顶过静摩擦 + 附着力），
 * 大部分纸钱大部分时间都在睡，所以常驻几百张也不贵。
 *
 * ## 透视
 *
 * 伪世界是正交重建的；透视场景里远处 1 wu 真实长度画出来更小。所以片的尺寸、离地高度、位移
 * 都按脚点那一点的透视系数 s 折：伪世界位移 = 真实速度 × s × dt（与实体移动步长 × f 同一条规则）。
 *
 * 纯函数式、零 Pixi、零挂钟：时间只来自调用方。
 */
import type { VfxPlateDef } from '../../data/types';
import { sampleSceneWind, type SceneWindParams } from '../../utils/sceneWind';
import type { Vec3 } from '../../utils/sceneSpace';
import {
  CONFINE_EXIT_FADE_S, CONFINE_EXIT_WEIGHT, CONFINE_FADE_IN_S, CONFINE_SETTLE_FADE_S, CONFINE_SETTLE_MEAN_S,
  confineHeightWeight, confineWeightAt, pointInPolygon, type ConfineField,
} from './vfxConfine';
import { curlNoise3 } from './vfxNoise';
import type { VfxRng } from './vfxRandom';
import { ShellSide, spawnsBehindShell, thinShellSide, type VfxSpace } from './vfxSpace';

/** 重力（wu/s²；1 m ≈ 88 wu） */
export const PLATE_GRAVITY = 865;

export const enum PlateContact {
  Free = 0,
  Ground = 1,
  Shell = 2,
}

/** 静止判据：切向速度（wu/s）与角速度（rad/s） */
const STILL_SPEED = 3;
const STILL_OMEGA = 0.8;
/** 静止多久入睡（秒） */
const SLEEP_AFTER_S = 0.5;
/** 睡着的片每隔几个子步查一次要不要醒 */
const WAKE_CHECK_EVERY = 4;
/** 透视度量每隔几个子步刷新一次（它随位置慢变） */
const METRIC_EVERY = 8;
/** 面上的转动接触阻尼（1/s）：片贴着面转会被摩擦刹住 */
const CONTACT_SPIN_DAMP = 14;
/** 离开接触判定的余量（真实 wu） */
const CONTACT_SLOP = 0.6;
/** 形阻：卷曲片的迎风投影占比 = |弯曲| × 此值 */
const CURL_FRONTAL = 0.5;
/** 贴地弯曲片的升力：kₙ × 此值 × |弯曲| × |wₜ|²（弯度升力 ~ π × 弯度 / 4） */
const CAMBER_LIFT = Math.PI / 4;
/** 丢失判据：比区域最低地面再低这么多（伪世界 wu）就算被刮下崖了 */
const LOST_DROP_WU = 320;
/** 补回的片从离地多高落下（真实 wu，区间） */
const REPLENISH_HEIGHT: [number, number] = [140, 340];
/** 补回的片往上风方向错开的距离（真实 wu，区间） */
const REPLENISH_UPWIND: [number, number] = [0, 260];
/** 限定区域时补回的片按"平着自由下落这么多秒能落地"定高度 */
const CONFINE_REPLENISH_FALL_S = 1;
/**
 * 限定区域时每子步（每发射器）最多补回几张。稳态实测每秒 4.5 张 ≈ 每子步 0.04 张，
 * 这个数只在"两块区域不相交、落点永远挑不到"的退化场景里起作用。
 */
const CONFINE_REPLENISH_PER_SUBSTEP = 4;

export interface PlateParams {
  /** 真实尺寸（wu） */
  w: number;
  h: number;
  /** 弦长（两边平均，力矩与转动阻尼用） */
  L: number;
  /** 接触半厚（真实 wu） */
  thickness: number;
  kn: number;
  kt: number;
  cop: number;
  muS: number;
  muK: number;
  pinned: number;
  onObjects: number;
  holdMax: number;
  bendK: number;
  bendOmega: number;
  bendZeta: number;
  bendMax: number;
  bendRest: number;
  segments: number;
  replenish: boolean;
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function resolvePlateParams(def: VfxPlateDef): PlateParams {
  const w = Math.max(0.5, num(def.size?.[0], 16));
  const h = Math.max(0.5, num(def.size?.[1], w));
  const vt = Math.max(5, num(def.terminalSpeed, 90));
  const kn = PLATE_GRAVITY / (vt * vt);
  const edge = Math.max(0, Math.min(1, num(def.edgeDrag, 0.08)));
  return {
    w, h,
    L: (w + h) / 2,
    thickness: Math.max(0.3, Math.min(w, h) * 0.03),
    kn,
    kt: kn * edge,
    cop: Math.max(0, Math.min(0.25, num(def.pressureOffset, 0.12))),
    muS: Math.max(0, num(def.friction?.static, 0.6)),
    muK: Math.max(0, num(def.friction?.kinetic, 0.45)),
    pinned: Math.max(0, Math.min(1, num(def.adhere?.pinned, 0.15))),
    onObjects: Math.max(0, Math.min(1, num(def.adhere?.onObjects, 1))),
    holdMax: Math.max(0, num(def.adhere?.hold, 250)),
    bendK: Math.max(1, num(def.bend?.stiffness, 1400)),
    bendOmega: 2 * Math.PI * Math.max(0.1, num(def.bend?.freq, 7)),
    bendZeta: Math.max(0, num(def.bend?.damping, 0.25)),
    bendMax: Math.max(0, Math.min(1.5, num(def.bend?.max, 0.7))),
    bendRest: Math.max(0, Math.min(1, num(def.bend?.rest, 0.25))),
    segments: Math.max(1, Math.min(16, Math.round(num(def.segments, 4)))),
    replenish: def.replenish !== false,
  };
}

/** 薄片的附加状态（与通用池同下标） */
export interface PlateArrays {
  /** 法线（世界，单位） */
  nx: Float32Array; ny: Float32Array; nz: Float32Array;
  /** 片内切线（宽度方向，单位，⊥ 法线） */
  tx: Float32Array; ty: Float32Array; tz: Float32Array;
  /** 角速度（rad/s，世界） */
  ox: Float32Array; oy: Float32Array; oz: Float32Array;
  /** 弯曲（1 = 边缘翘起半个宽度）与其速度 */
  bend: Float32Array; bendV: Float32Array; restBend: Float32Array;
  contact: Uint8Array;
  /** 接触面法线（世界） */
  cnx: Float32Array; cny: Float32Array; cnz: Float32Array;
  /** 附着力（wu/s²）；Infinity = 贴死 */
  hold: Float32Array;
  sleep: Uint8Array;
  still: Float32Array;
  /** 透视度量（渲染用同一个值） */
  metric: Float32Array;
  /**
   * 片处的风速大小（wu/s，已乘增益）：渲染据此做边角颤动。
   * ⚠ 是**没被粒子区域衰减过**的真实风——边带里躺着的纸照样跟着旁边的草一起掀边角。
   */
  wind: Float32Array;
  /** 最近一次查到的粒子区域水平权重（0..1；不限定区域恒 1）。调试 / 统计用 */
  conf: Float32Array;
}

export function createPlateArrays(cap: number): PlateArrays {
  const f = () => new Float32Array(cap);
  return {
    nx: f(), ny: f(), nz: f(), tx: f(), ty: f(), tz: f(), ox: f(), oy: f(), oz: f(),
    bend: f(), bendV: f(), restBend: f(),
    contact: new Uint8Array(cap),
    cnx: f(), cny: f(), cnz: f(),
    hold: f(),
    sleep: new Uint8Array(cap),
    still: f(), metric: f(), wind: f(),
    conf: new Float32Array(cap).fill(1),
  };
}

/** 区域（画面多边形）的预解析：包围盒、面积采样表、最低地面 */
export interface PlateArea {
  poly: [number, number][] | null;
  /** 没有多边形时：圆盘 */
  disc: { cx: number; cz: number; y: number; r: number } | null;
  minX: number; minY: number; maxX: number; maxY: number;
  /** 区域内地面的最低世界 Y（丢失判据） */
  floorY: number;
  /** 粒子区域的软边界（实例配了 `confine` 才有）：出生 / 补回按权重挑、风按权重衰减、出界淡出回收 */
  confine: ConfineField | null;
}

const pointInPoly = pointInPolygon;

export function resolvePlateArea(
  space: VfxSpace, origin: Vec3, poly: [number, number][] | null | undefined, radius: number,
  confine: ConfineField | null = null,
): PlateArea {
  if (poly && poly.length >= 3) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of poly) {
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
    // 最低地面：多边形包围盒内粗采样
    let floorY = Infinity;
    for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) {
      const sx = minX + ((maxX - minX) * i) / 8, sy = minY + ((maxY - minY) * j) / 8;
      if (!pointInPoly(poly, sx, sy)) continue;
      floorY = Math.min(floorY, space.groundWorldAtScene(sx, sy)[1]);
    }
    if (!Number.isFinite(floorY)) floorY = origin[1];
    return { poly, disc: null, minX, minY, maxX, maxY, floorY, confine };
  }
  const s = { x: 0, y: 0 };
  space.toScene(origin, s);
  return {
    poly: null,
    disc: { cx: origin[0], cz: origin[2], y: origin[1], r: Math.max(1, radius) },
    minX: s.x - radius, minY: s.y - radius, maxX: s.x + radius, maxY: s.y + radius,
    floorY: origin[1],
    confine: null,
  };
}

/** 一个世界点正下方的地面点，在粒子区域里的水平权重 */
function footWeight(space: VfxSpace, cf: ConfineField, x: number, z: number): number {
  FOOT[0] = x; FOOT[1] = space.groundY(x, z); FOOT[2] = z;
  space.toScene(FOOT, FOOT_S);
  return confineWeightAt(cf, FOOT_S.x, FOOT_S.y);
}
const FOOT: Vec3 = [0, 0, 0];
const FOOT_S = { x: 0, y: 0 };
/** 限定区域时挑落点多试几次：按权重拒绝采样会多拒掉一大半，挑不到 = 这张纸被回收掉、总数慢慢漏光 */
const CONFINE_PICK_TRIES = 96;

const tmpS = { x: 0, y: 0 };

/** 在区域里挑一个看得见表面的点（最多试 `tries` 次）；挑不到返回 null */
export function pickAreaSurface(
  space: VfxSpace, area: PlateArea, rng: VfxRng, tries = 24,
): { p: Vec3; normal: Vec3; kind: 'ground' | 'object' } | null {
  const cf = area.confine;
  const n = cf ? Math.max(tries, CONFINE_PICK_TRIES) : tries;
  for (let k = 0; k < n; k++) {
    let sx: number, sy: number;
    if (area.poly) {
      sx = rng.range(area.minX, area.maxX);
      sy = rng.range(area.minY, area.maxY);
      if (!pointInPoly(area.poly, sx, sy)) continue;
    } else {
      const d = area.disc!;
      const a = rng.range(0, Math.PI * 2), r = d.r * Math.sqrt(rng.next());
      space.toScene([d.cx + Math.cos(a) * r, d.y, d.cz + Math.sin(a) * r], tmpS);
      sx = tmpS.x; sy = tmpS.y;
    }
    const surf = space.surfaceAtScene(sx, sy);
    if (surf.kind === 'void') continue;
    // 粒子区域：按权重拒绝采样 ⇒ 密度随离边距离平滑变稀（边带里天然少，不靠遮罩）
    if (cf && rng.next() >= footWeight(space, cf, surf.p[0], surf.p[2])) continue;
    return { p: surf.p, normal: surf.normal, kind: surf.kind };
  }
  return null;
}

/** 片内切线：与法线垂直的随机单位向量 */
function randomTangent(n: Vec3, rng: VfxRng, out: Vec3): Vec3 {
  const a = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let ux = a[1] * n[2] - a[2] * n[1], uy = a[2] * n[0] - a[0] * n[2], uz = a[0] * n[1] - a[1] * n[0];
  const ul = Math.hypot(ux, uy, uz) || 1;
  ux /= ul; uy /= ul; uz /= ul;
  const vx = n[1] * uz - n[2] * uy, vy = n[2] * ux - n[0] * uz, vz = n[0] * uy - n[1] * ux;
  const th = rng.range(0, Math.PI * 2), c = Math.cos(th), s = Math.sin(th);
  out[0] = ux * c + vx * s; out[1] = uy * c + vy * s; out[2] = uz * c + vz * s;
  return out;
}

export interface PlateBody {
  x: Float32Array; y: Float32Array; z: Float32Array;
  vx: Float32Array; vy: Float32Array; vz: Float32Array;
  seed: Float32Array;
  /** 薄壳判据的滞回位（与通用池同一份，见 `thinShellSide`） */
  behind: Uint8Array;
  /** 粒子区域的淡入淡出（与通用池同一份）：透明度系数 / 每秒变化（> 0 淡出、< 0 淡入） */
  fade: Float32Array;
  fadeRate: Float32Array;
}

/** 把第 i 张片放到一个面上躺好（出生铺撒 / 补回时落地前都走这里） */
export function placePlateOnSurface(
  P: PlateParams, arr: PlateArrays, b: PlateBody, i: number, space: VfxSpace, rng: VfxRng,
  surf: { p: Vec3; normal: Vec3; kind: 'ground' | 'object' },
): void {
  const s = space.metricAt(surf.p[0], surf.p[2]);
  const n = surf.normal;
  const off = P.thickness * s;
  b.x[i] = surf.p[0] + n[0] * off; b.y[i] = surf.p[1] + n[1] * off; b.z[i] = surf.p[2] + n[2] * off;
  b.vx[i] = 0; b.vy[i] = 0; b.vz[i] = 0;
  b.behind[i] = 0;                                    // 落在看得见的那张面上
  arr.nx[i] = n[0]; arr.ny[i] = n[1]; arr.nz[i] = n[2];
  const t: Vec3 = [0, 0, 0];
  randomTangent(n, rng, t);
  arr.tx[i] = t[0]; arr.ty[i] = t[1]; arr.tz[i] = t[2];
  arr.ox[i] = 0; arr.oy[i] = 0; arr.oz[i] = 0;
  const rb = rng.range(-P.bendRest, P.bendRest);
  arr.restBend[i] = rb; arr.bend[i] = rb; arr.bendV[i] = 0;
  arr.contact[i] = surf.kind === 'object' ? PlateContact.Shell : PlateContact.Ground;
  arr.cnx[i] = n[0]; arr.cny[i] = n[1]; arr.cnz[i] = n[2];
  const pinP = surf.kind === 'object' ? P.onObjects : P.pinned;
  arr.hold[i] = rng.next() < pinP ? Infinity : rng.range(0, P.holdMax);
  arr.sleep[i] = 1;
  arr.still[i] = SLEEP_AFTER_S;
  arr.metric[i] = s;
  arr.wind[i] = 0;
}

/** 把第 i 张片放进空中（补回 / 普通发射出生）：随机朝向、跟着那里的风走 */
export function launchPlate(
  P: PlateParams, arr: PlateArrays, b: PlateBody, i: number, space: VfxSpace, rng: VfxRng,
  at: Vec3, vel: Vec3 | null,
): void {
  b.x[i] = at[0]; b.y[i] = at[1]; b.z[i] = at[2];
  b.vx[i] = vel ? vel[0] : 0; b.vy[i] = vel ? vel[1] : 0; b.vz[i] = vel ? vel[2] : 0;
  b.behind[i] = spawnsBehindShell(space, at[0], at[1], at[2]) ? 1 : 0;
  const n: Vec3 = [0, 0, 0];
  rng.unitVector(n);
  arr.nx[i] = n[0]; arr.ny[i] = n[1]; arr.nz[i] = n[2];
  const t: Vec3 = [0, 0, 0];
  randomTangent(n, rng, t);
  arr.tx[i] = t[0]; arr.ty[i] = t[1]; arr.tz[i] = t[2];
  arr.ox[i] = rng.range(-6, 6); arr.oy[i] = rng.range(-6, 6); arr.oz[i] = rng.range(-6, 6);
  const rb = rng.range(-P.bendRest, P.bendRest);
  arr.restBend[i] = rb; arr.bend[i] = rb; arr.bendV[i] = 0;
  arr.contact[i] = PlateContact.Free;
  arr.cnx[i] = 0; arr.cny[i] = 1; arr.cnz[i] = 0;
  arr.hold[i] = rng.range(0, P.holdMax);
  arr.sleep[i] = 0;
  arr.still[i] = 0;
  arr.metric[i] = space.metricAt(at[0], at[2]);
  arr.wind[i] = 0;
}

/** 补回：区域里挑一处、往上风错开、抬到半空，带着那里的风速放出去 */
export function replenishPlate(
  P: PlateParams, arr: PlateArrays, b: PlateBody, i: number, space: VfxSpace, rng: VfxRng,
  area: PlateArea, wind: SceneWindParams | null, time: number,
): boolean {
  const surf = pickAreaSurface(space, area, rng);
  if (!surf) return false;
  const s = space.metricAt(surf.p[0], surf.p[2]);
  const cf = area.confine;
  let hReal: number;
  if (cf) {
    // 限定区域时从低处放：一秒内落得了地。从 140–340 高处放的纸要飘好几秒、顺风走上千 wu，
    // 边带根本拦不住，结果是半空里一张接一张淡出（实测强风下每秒 9 张，几乎全在下风边的半空）
    const vt = Math.sqrt(PLATE_GRAVITY / P.kn);
    hReal = rng.range(0.25 * vt * CONFINE_REPLENISH_FALL_S, vt * CONFINE_REPLENISH_FALL_S);
    if (cf.ceiling !== null) hReal = Math.min(hReal, Math.max(0, cf.ceiling - cf.ceilingBand));
  } else {
    hReal = rng.pair(REPLENISH_HEIGHT, 200);
  }
  const at: Vec3 = [surf.p[0], space.groundY(surf.p[0], surf.p[2]) + hReal * s, surf.p[2]];
  const vel: Vec3 = [0, 0, 0];
  if (wind) {
    let up = rng.pair(REPLENISH_UPWIND, 0) * s;
    // 粒子区域：往上风错开这一步不许把它错到框外去（那样一补回就在淡出）——按权重接受，不行就减半再试
    if (cf) up = confinedUpwind(space, cf, at, wind, up, rng);
    at[0] -= wind.dirX * up; at[2] -= wind.dirZ * up;
    sampleSceneWind(wind, time, at[0], at[2], hReal, vel);
    const g = wind.gainVfx * (cf ? footWeight(space, cf, at[0], at[2]) : 1);
    vel[0] *= g; vel[2] *= g;
  }
  launchPlate(P, arr, b, i, space, rng, at, vel);
  if (cf) {
    // 半空里凭空冒出一张满不透明的纸就是一种硬边：从 0 淡进来
    b.fade[i] = 0; b.fadeRate[i] = -1 / CONFINE_FADE_IN_S;
  } else {
    b.fade[i] = 1; b.fadeRate[i] = 0;
  }
  return true;
}

function confinedUpwind(space: VfxSpace, cf: ConfineField, at: Vec3, wind: SceneWindParams, up: number, rng: VfxRng): number {
  for (let k = 0; k < 3 && up > 1; k++, up *= 0.5) {
    if (rng.next() < footWeight(space, cf, at[0] - wind.dirX * up, at[2] - wind.dirZ * up)) return up;
  }
  return 0;
}

export interface PlateStepEnv {
  space: VfxSpace;
  wind: SceneWindParams | null;
  /** 风的钟（与背景摆动同一个） */
  windTime: number;
  /** 发射器自己的湍流（旧语义：加速度扰动），可无 */
  turb: { strength: number; invScale: number; speed: number } | null;
  /** 噪声相位用的累计时间 */
  time: number;
  /** 全局子步序号（决定哪些子步刷度量 / 查唤醒） */
  substep: number;
  area: PlateArea;
  rng: VfxRng;
}

const U: [number, number, number] = [0, 0, 0];
const N3 = new Float32Array(3);

/**
 * 一个子步。`alive` 与 `b`（位置 / 速度 / 种子）是通用池的；返回本子步丢失又没能补回的下标数
 * （调用方据此维护 liveCount）。
 */
export function stepPlates(
  P: PlateParams, arr: PlateArrays, alive: Uint8Array, b: PlateBody, cap: number, h: number, env: PlateStepEnv,
): number {
  const sp = env.space;
  const wind = env.wind;
  const g = PLATE_GRAVITY;
  const kn = P.kn, kt = P.kt, L = P.L;
  const flipK = (24 * kn * P.cop) / L;
  const damp = 0.375 * kn * L;
  const dampN = 0.375 * kt * L;
  const align = (1.5 * g) / L;
  const halfW = P.w / 2;
  const refreshMetric = env.substep % METRIC_EVERY === 0;
  const checkWake = env.substep % WAKE_CHECK_EVERY === 0;
  const gainV = wind ? wind.gainVfx : 0;
  const cf = env.area.confine;
  // 边带里躺着的纸：权重 w 处平均躺 CONFINE_SETTLE_MEAN_S / (1−w) 秒开始淡出（只在查唤醒的子步上掷）
  const settleP = (h * WAKE_CHECK_EVERY) / CONFINE_SETTLE_MEAN_S;
  let replenishBudget = CONFINE_REPLENISH_PER_SUBSTEP;
  let killed = 0;

  for (let i = 0; i < cap; i++) {
    if (!alive[i]) continue;
    // ---- 粒子区域：淡入淡出。睡着的也每子步走——不然躺着淡出的纸会停在半透明
    if (cf && b.fadeRate[i] !== 0) {
      b.fade[i] -= b.fadeRate[i] * h;
      if (b.fade[i] <= 0) {
        b.fade[i] = 0;
        if (!P.replenish) { alive[i] = 0; killed++; continue; }
        // 淡完了等补回。⚠ 挑不到落点**不回收**：发射区域与范围区域重叠很少时，按权重拒绝采样常常挑空，
        // 回收掉就是总数一张张漏光。隐身留着、下个子步再试；每子步补回次数封顶，退化场景（两块不相交）
        // 也不会每子步几百张 × 96 次表面查询把帧打爆（校验器另报 warning）。
        if (replenishBudget > 0) {
          replenishBudget--;
          replenishPlate(P, arr, b, i, sp, env.rng, env.area, wind, env.windTime);
        }
        continue;
      }
      if (b.fade[i] >= 1) { b.fade[i] = 1; b.fadeRate[i] = 0; }
    }
    const sleeping = arr.sleep[i] === 1;
    // 睡着的片只在查唤醒的子步上露面（这是常驻几百张也便宜的原因）
    if (sleeping && !checkWake) continue;
    let x = b.x[i], y = b.y[i], z = b.z[i];
    if (!sleeping && (refreshMetric || arr.metric[i] <= 0)) arr.metric[i] = sp.metricAt(x, z);
    const s = arr.metric[i];
    const gy = sp.groundY(x, z);
    const bendAbs = Math.abs(arr.bend[i]);
    const hExp = Math.max(0, (y - gy) / s) + bendAbs * halfW + P.thickness;

    // ---- 粒子区域：权重看**正下方地面点**落在画面上的位置（区域是地上的一块，纸在它上空飞是对的）
    let cw = 1, chw = 1;
    if (cf) {
      P3[0] = x; P3[1] = gy; P3[2] = z;
      sp.toScene(P3, tmpS);
      cw = confineWeightAt(cf, tmpS.x, tmpS.y);
      arr.conf[i] = cw;
      if (cf.ceiling !== null) chw = confineHeightWeight(cf, Math.max(0, (y - gy) / s));
      if (b.fadeRate[i] <= 0) {
        if (cw < CONFINE_EXIT_WEIGHT) {
          b.fadeRate[i] = 1 / CONFINE_EXIT_FADE_S;                // 压线 / 出框：很快淡掉
        } else if (cw < 1 && checkWake && arr.contact[i] !== PlateContact.Free && env.rng.next() < (1 - cw) * settleP) {
          b.fadeRate[i] = 1 / CONFINE_SETTLE_FADE_S;              // 边带里躺着：越靠外越先走
        }
      }
    }

    // ---- 空气速度（真实 wu/s）：平均 + 阵风 + 湍流的涡，全在 `sampleSceneWind` 那一份里
    // ⚠ 别再在这里叠一份自己的噪声：以前每颗片把噪声时间轴按 `seed[i]` 错开，等于每张纸一套私有乱流，
    // 挨着的两张永远不会被同一个涡卷走（制作人 2026-09-12："吹粒子感觉很死，就一个方向"）。
    let ux = 0, uy = 0, uz = 0;
    if (wind) {
      sampleSceneWind(wind, env.windTime, x, z, hExp, U);
      ux = U[0] * gainV; uy = U[1] * gainV; uz = U[2] * gainV;
    }
    arr.wind[i] = Math.hypot(ux, uy, uz);
    // 粒子区域：边带里风按权重弱下去（飞到边上自己落下，不是撞墙）；过了高度上限，上升气流不再托它。
    // 放在 `arr.wind` 之后：渲染的边角掀动看真实风，边带里躺着的纸照样跟着旁边的草一起颤
    if (cf) {
      ux *= cw; uz *= cw;
      uy = (uy > 0 ? uy * chw : uy) * cw;
    }

    const nx = arr.nx[i], ny = arr.ny[i], nz = arr.nz[i];
    const contact = arr.contact[i];
    const cnx = arr.cnx[i], cny = arr.cny[i], cnz = arr.cnz[i];

    // ---- 睡着：只查"这里的风顶不顶得过静摩擦 + 附着"（贴死的永远不醒，形变交给渲染按风速做）
    if (sleeping) {
      if (arr.hold[i] === Infinity) continue;
      const wn = ux * nx + uy * ny + uz * nz;
      const wtx = ux - wn * nx, wty = uy - wn * ny, wtz = uz - wn * nz;
      const wtm = Math.hypot(wtx, wty, wtz);
      const ktEff = kt + kn * bendAbs * CURL_FRONTAL;
      const push = ktEff * wtm * wtm;
      const lift = kn * CAMBER_LIFT * bendAbs * wtm * wtm;
      const gIn = g * Math.max(0, cny);                       // 重力压进面里的那一份
      const slide = g * Math.sqrt(Math.max(0, 1 - cny * cny)); // 重力沿坡的那一份
      if (push + slide > P.muS * Math.max(0, gIn - lift) + arr.hold[i] || lift > gIn + arr.hold[i]) {
        arr.sleep[i] = 0;
        arr.still[i] = 0;
      } else continue;
    }

    // ---- 贴死的：不平动，姿态贴着面，只算形变
    if (arr.hold[i] === Infinity && contact !== PlateContact.Free) {
      const wn = ux * nx + uy * ny + uz * nz;
      stepBend(P, arr, i, kn * wn * Math.abs(wn), h);
      continue;
    }

    let vx = b.vx[i], vy = b.vy[i], vz = b.vz[i];
    let wx = ux - vx, wy = uy - vy, wz = uz - vz;
    const wn = wx * nx + wy * ny + wz * nz;
    const wtx = wx - wn * nx, wty = wy - wn * ny, wtz = wz - wn * nz;
    const wtm = Math.hypot(wtx, wty, wtz);
    const ktEff = kt + kn * bendAbs * CURL_FRONTAL;

    // ---- 力（每单位质量）
    const fn = kn * wn * Math.abs(wn);
    let ax = fn * nx + ktEff * wtm * wtx;
    let ay = -g + fn * ny + ktEff * wtm * wty;
    let az = fn * nz + ktEff * wtm * wtz;
    if (env.turb) {
      const t = env.turb;
      curlNoise3(x * t.invScale, y * t.invScale, z * t.invScale, env.time * t.speed + b.seed[i] * 3, N3);
      ax += N3[0] * t.strength; ay += N3[1] * t.strength; az += N3[2] * t.strength;
    }

    // ---- 力矩（角加速度）
    let ox = arr.ox[i], oy = arr.oy[i], oz = arr.oz[i];
    // 翻转：(w·n)(n × w)
    let alx = flipK * wn * (ny * wz - nz * wy);
    let aly = flipK * wn * (nz * wx - nx * wz);
    let alz = flipK * wn * (nx * wy - ny * wx);
    // 转动气动阻尼：面内轴全额，绕法线轴按切向比例
    const on = ox * nx + oy * ny + oz * nz;
    const opx = ox - on * nx, opy = oy - on * ny, opz = oz - on * nz;
    const opm = Math.hypot(opx, opy, opz);
    alx -= damp * opm * opx + dampN * Math.abs(on) * on * nx;
    aly -= damp * opm * opy + dampN * Math.abs(on) * on * ny;
    alz -= damp * opm * opz + dampN * Math.abs(on) * on * nz;

    // ---- 接触：库仑摩擦 + 附着 + 倒伏
    let held = false;
    if (contact !== PlateContact.Free) {
      const lift = kn * CAMBER_LIFT * bendAbs * wtm * wtm;
      ax += lift * cnx; ay += lift * cny; az += lift * cnz;
      const an = ax * cnx + ay * cny + az * cnz;       // < 0 = 往面里压
      const hold = arr.hold[i];
      if (an > hold) {
        arr.contact[i] = PlateContact.Free;              // 风把它掀离了面
      } else {
        const N = Math.max(0, -an);
        // 去掉法向分量（面顶住）
        ax -= an * cnx; ay -= an * cny; az -= an * cnz;
        const vn = vx * cnx + vy * cny + vz * cnz;
        if (vn < 0) { vx -= vn * cnx; vy -= vn * cny; vz -= vn * cnz; }
        const atm = Math.hypot(ax, ay, az);
        const vtm = Math.hypot(vx, vy, vz);
        if (vtm < STILL_SPEED && atm <= P.muS * N + hold) {
          held = true;
          vx = 0; vy = 0; vz = 0; ax = 0; ay = 0; az = 0;
        } else {
          // 动摩擦：沿速度反向，最多刹到 0
          const fk = P.muK * N * h;
          if (vtm > 1e-6) {
            const k = Math.min(1, fk / vtm);
            vx -= vx * k; vy -= vy * k; vz -= vz * k;
          }
        }
        // 倒伏：绕接触边翻向离得近的那一面（±接触法线）
        const sgn = nx * cnx + ny * cny + nz * cnz >= 0 ? 1 : -1;
        const mx = cnx * sgn, my = cny * sgn, mz = cnz * sgn;
        alx += align * (ny * mz - nz * my);
        aly += align * (nz * mx - nx * mz);
        alz += align * (nx * my - ny * mx);
        alx -= CONTACT_SPIN_DAMP * ox; aly -= CONTACT_SPIN_DAMP * oy; alz -= CONTACT_SPIN_DAMP * oz;
      }
    }

    // ---- 积分（位移按透视度量折进伪世界）
    vx += ax * h; vy += ay * h; vz += az * h;
    ox += alx * h; oy += aly * h; oz += alz * h;
    x += vx * s * h; y += vy * s * h; z += vz * s * h;
    // 转姿态：n += (ω×n)h, t += (ω×t)h，再正交归一
    let nnx = nx + (oy * nz - oz * ny) * h;
    let nny = ny + (oz * nx - ox * nz) * h;
    let nnz = nz + (ox * ny - oy * nx) * h;
    const nl = Math.hypot(nnx, nny, nnz) || 1;
    nnx /= nl; nny /= nl; nnz /= nl;
    const tx0 = arr.tx[i], ty0 = arr.ty[i], tz0 = arr.tz[i];
    let ttx = tx0 + (oy * tz0 - oz * ty0) * h;
    let tty = ty0 + (oz * tx0 - ox * tz0) * h;
    let ttz = tz0 + (ox * ty0 - oy * tx0) * h;
    const td = ttx * nnx + tty * nny + ttz * nnz;
    ttx -= td * nnx; tty -= td * nny; ttz -= td * nnz;
    const tl = Math.hypot(ttx, tty, ttz) || 1;
    ttx /= tl; tty /= tl; ttz /= tl;

    // ---- 碰撞：地面
    const off = P.thickness * s;
    const gy2 = sp.groundY(x, z);
    let newContact: PlateContact = PlateContact.Free;
    let ncx = arr.cnx[i], ncy = arr.cny[i], ncz = arr.cnz[i];
    if (y < gy2 + off) {
      y = gy2 + off;
      sp.groundNormal(x, z, GN);
      ncx = GN[0]; ncy = GN[1]; ncz = GN[2];
      const vn = vx * ncx + vy * ncy + vz * ncz;
      if (vn < 0) { vx -= vn * ncx; vy -= vn * ncy; vz -= vn * ncz; }
      newContact = PlateContact.Ground;
    } else if (contact === PlateContact.Ground && y < gy2 + off + CONTACT_SLOP * s && arr.contact[i] !== PlateContact.Free) {
      newContact = PlateContact.Ground;               // 贴着地面滑，没被掀起
    }
    // ---- 碰撞：物面（深度壳；朝上的像素交给地面）。薄壳：面后一个壳厚以内才算贴上 / 撞上，
    //      更深的是被风卷到了遮挡物背后（渲染侧把它藏掉），不许从背后一把推到前面
    if (sp.hasShell) {
      const c = sp.shellContact(x, y, z);
      if (c) {
        const side = thinShellSide(c.penWu, off, b.behind[i] === 1);
        b.behind[i] = side === ShellSide.Behind ? 1 : 0;
        if (!c.groundLike && side === ShellSide.Contact) {
          const push = c.penWu + off;
          x += c.normal[0] * push; y += c.normal[1] * push; z += c.normal[2] * push;
          ncx = c.normal[0]; ncy = c.normal[1]; ncz = c.normal[2];
          const vn = vx * ncx + vy * ncy + vz * ncz;
          if (vn < 0) { vx -= vn * ncx; vy -= vn * ncy; vz -= vn * ncz; }
          newContact = PlateContact.Shell;
        } else if (contact === PlateContact.Shell && !c.groundLike && side !== ShellSide.Behind
          && c.penWu > -off - CONTACT_SLOP * s && arr.contact[i] !== PlateContact.Free) {
          newContact = PlateContact.Shell;
        }
      }
    }
    arr.contact[i] = newContact;
    arr.cnx[i] = ncx; arr.cny[i] = ncy; arr.cnz[i] = ncz;

    // ---- 形变
    stepBend(P, arr, i, fn, h);

    // ---- 入睡
    const om = Math.hypot(ox, oy, oz);
    if (newContact !== PlateContact.Free && held && om < STILL_OMEGA) {
      arr.still[i] += h;
      if (arr.still[i] >= SLEEP_AFTER_S) {
        arr.sleep[i] = 1;
        vx = 0; vy = 0; vz = 0; ox = 0; oy = 0; oz = 0;
      }
    } else arr.still[i] = 0;

    // ---- 丢失：刮下崖 / 出区域
    const a = env.area;
    let lost = y < a.floorY - LOST_DROP_WU;
    // 限定区域时出框交给上面的淡出回收；包围盒外扩那条粗判据只管没限定的实例
    if (!lost && !cf) {
      P3[0] = x; P3[1] = y; P3[2] = z;
      sp.toScene(P3, tmpS);
      const mx = (a.maxX - a.minX) * 0.35 + 60, my = (a.maxY - a.minY) * 0.35 + 60;
      lost = tmpS.x < a.minX - mx || tmpS.x > a.maxX + mx || tmpS.y < a.minY - my || tmpS.y > a.maxY + my;
    }
    if (lost) {
      if (!P.replenish || !replenishPlate(P, arr, b, i, sp, env.rng, a, wind, env.windTime)) {
        alive[i] = 0;
        killed++;
      }
      continue;
    }

    b.x[i] = x; b.y[i] = y; b.z[i] = z;
    b.vx[i] = vx; b.vy[i] = vy; b.vz[i] = vz;
    arr.ox[i] = ox; arr.oy[i] = oy; arr.oz[i] = oz;
    arr.nx[i] = nnx; arr.ny[i] = nny; arr.nz[i] = nnz;
    arr.tx[i] = ttx; arr.ty[i] = tty; arr.tz[i] = ttz;
  }
  return killed;
}

const GN: Vec3 = [0, 1, 0];
const P3: Vec3 = [0, 0, 0];

/** 弯曲：阻尼振子追"静卷曲 + 法向气动载荷 / 刚度"，封顶 */
function stepBend(P: PlateParams, arr: PlateArrays, i: number, fn: number, h: number): void {
  const target = Math.max(-P.bendMax, Math.min(P.bendMax, arr.restBend[i] + fn / P.bendK));
  const w = P.bendOmega;
  const acc = -w * w * (arr.bend[i] - target) - 2 * P.bendZeta * w * arr.bendV[i];
  arr.bendV[i] += acc * h;
  arr.bend[i] = Math.max(-P.bendMax, Math.min(P.bendMax, arr.bend[i] + arr.bendV[i] * h));
}
