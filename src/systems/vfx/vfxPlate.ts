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
import { addWindBlasts, sampleSceneWind, type SceneWindParams, type WindBlast } from '../../utils/sceneWind';
import type { Vec3 } from '../../utils/sceneSpace';
import {
  CONFINE_EXIT_FADE_S, CONFINE_EXIT_WEIGHT, CONFINE_SETTLE_FADE_S, CONFINE_SETTLE_MEAN_S,
  confineHeightWeight, confineWeightAt, type ConfineField,
} from './vfxConfine';
import { curlNoise3 } from './vfxNoise';
import { accumulateAirflow, accumulateFieldAcceleration, type VfxFieldRuntime, type VfxStimulusResponse } from './vfxFields';
import type { VfxParticleLifecycle } from './vfxLifecycle';
import { resolveKinematicContacts, type VfxKinematicContact } from './vfxContact';
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
  velocity?: Vec3,
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
  if (velocity && (velocity[0] !== 0 || velocity[1] !== 0 || velocity[2] !== 0)) {
    b.vx[i] = velocity[0]; b.vy[i] = velocity[1]; b.vz[i] = velocity[2];
    arr.sleep[i] = 0; arr.still[i] = 0;
    // A launched particle has not established adhesion; collision can establish contact later.
    arr.hold[i] = 0;
    if (velocity[0] * n[0] + velocity[1] * n[1] + velocity[2] * n[2] > 0) arr.contact[i] = PlateContact.Free;
  }
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

export interface PlateStepEnv {
  space: VfxSpace;
  wind: SceneWindParams | null;
  /** 风的钟（与背景摆动同一个） */
  windTime: number;
  /** 冲击风（落雷落地那一下）与它自己的钟；没有 = null */
  blasts?: readonly WindBlast[] | null;
  blastTime?: number;
  /** 发射器自己的湍流（旧语义：加速度扰动），可无 */
  turb: { strength: number; invScale: number; speed: number } | null;
  /** 噪声相位用的累计时间 */
  time: number;
  /** 全局子步序号（决定哪些子步刷度量 / 查唤醒） */
  substep: number;
  confine: ConfineField | null;
  lifecycle: VfxParticleLifecycle;
  fields: readonly VfxFieldRuntime[];
  contacts?: readonly VfxKinematicContact[];
  contactStart?: number;
  contactEnd?: number;
  fieldWind: boolean;
  airflow: boolean;
  stimulus: VfxStimulusResponse | null;
  rng: VfxRng;
  /** 实例吃场景风的倍率（手持火把护火时的挡风）；缺省 1 */
  windScale?: number;
  /**
   * 可燃薄片（`plate.flammable`）：燃着的片（`burnT[i] ≥ 0`）处的空气多一股竖直上升气流 `liftWu`（wu/s，真实量）——
   * 燃烧热托起来的。没有可燃模块 = null，一字不变。
   */
  burn?: { burnT: Float32Array; liftWu: number } | null;
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
  const gainV = wind ? wind.gainVfx * (env.windScale ?? 1) : 0;
  const cf = env.confine;
  // 边带里躺着的纸：权重 w 处平均躺 CONFINE_SETTLE_MEAN_S / (1−w) 秒开始淡出（只在查唤醒的子步上掷）
  const settleP = (h * WAKE_CHECK_EVERY) / CONFINE_SETTLE_MEAN_S;
  env.lifecycle.beginStep();

  for (let i = 0; i < cap; i++) {
    if (!alive[i]) continue;
    if (env.lifecycle.beforeParticle(i, h)) continue;
    if (env.contacts?.length && arr.hold[i] !== Infinity) {
      const s = sp.metricAt(b.x[i], b.z[i]);
      if (resolveKinematicContacts(env.contacts, b, i, h, env.contactStart ?? 0, env.contactEnd ?? 1, s)) {
        arr.metric[i] = s;
        arr.sleep[i] = 0; arr.still[i] = 0; arr.hold[i] = 0;
        // Contact transfers momentum and breaks finite adhesion. The existing
        // aerodynamic/ground solver owns all subsequent tumbling and settling.
        if (b.vx[i] * arr.cnx[i] + b.vy[i] * arr.cny[i] + b.vz[i] * arr.cnz[i] > 0) arr.contact[i] = PlateContact.Free;
      }
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
    // 冲击风（落雷）：纸钱被落点那一下从中心掀开（没写风的场景也有）
    if (env.blasts) {
      U[0] = 0; U[1] = 0; U[2] = 0;
      if (addWindBlasts(env.blasts, env.blastTime ?? 0, x, z, hExp, U) > 0) {
        const gb = wind ? gainV : (env.windScale ?? 1);
        ux += U[0] * gb; uy += U[1] * gb; uz += U[2] * gb;
      }
    }
    // 燃着的纸：燃烧热托起的上升气流（真实量，与风同一处叠；纸自己的气动决定它飘多高）
    if (env.burn && env.burn.burnT[i] >= 0) uy += env.burn.liftWu;
    let hasLocalAirflow = false;
    if (env.airflow) {
      U[0] = 0; U[1] = 0; U[2] = 0;
      accumulateAirflow(env.fields, x, y, z, U);
      hasLocalAirflow = U[0] !== 0 || U[1] !== 0 || U[2] !== 0;
      // The public field is in M-world; this solver integrates in local physical wu
      // and applies metric to position displacements; its stored velocity remains physical wu/s.
      if (hasLocalAirflow) { ux += U[0] / s; uy += U[1] / s; uz += U[2] / s; }
    }
    EXTRA[0] = 0; EXTRA[1] = 0; EXTRA[2] = 0;
    if (env.fieldWind || env.stimulus) {
      accumulateFieldAcceleration(env.fields, env.fieldWind, env.stimulus, x, y, z, b.seed[i], EXTRA);
    }
    const hasExternalForce = EXTRA[0] !== 0 || EXTRA[1] !== 0 || EXTRA[2] !== 0;
    if (hasExternalForce) { EXTRA[0] /= s; EXTRA[1] /= s; EXTRA[2] /= s; }
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
      const lift = kn * CAMBER_LIFT * bendAbs * wtm * wtm;
      // Scene wind has vertical pressure too. Sleeping and moving paper must
      // evaluate the same force; otherwise an updraft cannot wake a flat sheet.
      const pressure = kn * wn * Math.abs(wn);
      const ax = pressure * nx + ktEff * wtm * wtx + lift * cnx + EXTRA[0];
      const ay = -g + pressure * ny + ktEff * wtm * wty + lift * cny + EXTRA[1];
      const az = pressure * nz + ktEff * wtm * wtz + lift * cnz + EXTRA[2];
      const an = ax * cnx + ay * cny + az * cnz;
      const tangent = Math.hypot(ax - an * cnx, ay - an * cny, az - an * cnz);
      const wake = tangent > P.muS * Math.max(0, -an) + arr.hold[i] || an > arr.hold[i];
      if (wake) {
        arr.sleep[i] = 0;
        arr.still[i] = 0;
      } else {
        env.lifecycle.settled(i, x, y, z);
        continue;
      }
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
    // At storm speeds, explicit quadratic drag can reverse relative velocity in
    // one step and then explode. Use its integrated decay only in that stiff
    // regime; ordinary wind retains the original operations and trajectories.
    const normalDecay = quadraticDecay(kn * Math.abs(wn), h);
    const tangentDecay = quadraticDecay(ktEff * wtm, h);
    const fn = kn * wn * Math.abs(wn) * normalDecay;
    let ax = fn * nx + ktEff * wtm * wtx * tangentDecay;
    let ay = -g + fn * ny + ktEff * wtm * wty * tangentDecay;
    let az = fn * nz + ktEff * wtm * wtz * tangentDecay;
    if (env.turb) {
      const t = env.turb;
      curlNoise3(x * t.invScale, y * t.invScale, z * t.invScale, env.time * t.speed + b.seed[i] * 3, N3);
      ax += N3[0] * t.strength; ay += N3[1] * t.strength; az += N3[2] * t.strength;
    }
    if (hasExternalForce) { ax += EXTRA[0]; ay += EXTRA[1]; az += EXTRA[2]; }

    // ---- 力矩（角加速度）
    let ox = arr.ox[i], oy = arr.oy[i], oz = arr.oz[i];
    // 翻转：(w·n)(n × w)
    let alx = flipK * wn * (ny * wz - nz * wy) * normalDecay;
    let aly = flipK * wn * (nz * wx - nx * wz) * normalDecay;
    let alz = flipK * wn * (nx * wy - ny * wx) * normalDecay;
    // 转动气动阻尼：面内轴全额，绕法线轴按切向比例
    const on = ox * nx + oy * ny + oz * nz;
    const opx = ox - on * nx, opy = oy - on * ny, opz = oz - on * nz;
    const opm = Math.hypot(opx, opy, opz);
    const spinDecay = quadraticDecay(damp * opm, h), normalSpinDecay = quadraticDecay(dampN * Math.abs(on), h);
    alx -= damp * opm * opx * spinDecay + dampN * Math.abs(on) * on * nx * normalSpinDecay;
    aly -= damp * opm * opy * spinDecay + dampN * Math.abs(on) * on * ny * normalSpinDecay;
    alz -= damp * opm * opz * spinDecay + dampN * Math.abs(on) * on * nz * normalSpinDecay;

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
    // A shell projection can move x/z onto a higher part of the slope, even
    // when its own normal points upward. Recheck the floor at the final x/z.
    if (newContact === PlateContact.Shell) {
      const floor = sp.groundY(x, z) + off;
      if (y < floor) {
        y = floor;
        sp.groundNormal(x, z, GN);
        ncx = GN[0]; ncy = GN[1]; ncz = GN[2];
        const vn = vx * ncx + vy * ncy + vz * ncz;
        if (vn < 0) { vx -= vn * ncx; vy -= vn * ncy; vz -= vn * ncz; }
        newContact = PlateContact.Ground;
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

    if (env.lifecycle.afterMotion(i, x, y, z)) continue;

    b.x[i] = x; b.y[i] = y; b.z[i] = z;
    b.vx[i] = vx; b.vy[i] = vy; b.vz[i] = vz;
    arr.ox[i] = ox; arr.oy[i] = oy; arr.oz[i] = oz;
    arr.nx[i] = nnx; arr.ny[i] = nny; arr.nz[i] = nnz;
    arr.tx[i] = ttx; arr.ty[i] = tty; arr.tz[i] = ttz;
  }
  return env.lifecycle.killed;
}

const GN: Vec3 = [0, 1, 0];
const P3: Vec3 = [0, 0, 0];
const tmpS = { x: 0, y: 0 };
const EXTRA: Vec3 = [0, 0, 0];

/** du/dt = -k|u|u => u(t+h) = u(t)/(1+k|u|h).
 * Preserve the established explicit solver while the step is below its
 * monotonicity limit; the implicit branch cannot overshoot the air velocity.
 */
function quadraticDecay(rate: number, h: number): number {
  return rate * h <= 0.5 ? 1 : 1 / (1 + rate * h);
}

/** 弯曲：阻尼振子追"静卷曲 + 法向气动载荷 / 刚度"，封顶 */
function stepBend(P: PlateParams, arr: PlateArrays, i: number, fn: number, h: number): void {
  const target = Math.max(-P.bendMax, Math.min(P.bendMax, arr.restBend[i] + fn / P.bendK));
  const w = P.bendOmega;
  const acc = -w * w * (arr.bend[i] - target) - 2 * P.bendZeta * w * arr.bendV[i];
  arr.bendV[i] += acc * h;
  arr.bend[i] = Math.max(-P.bendMax, Math.min(P.bendMax, arr.bend[i] + arr.bendV[i] * h));
}
