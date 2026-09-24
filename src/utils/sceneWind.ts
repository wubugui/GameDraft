/**
 * 场景风：空气速度场 u(x, t) 的**唯一**数学口径——粒子模拟（`vfxSim`）与背景草木随风动
 * （`backgroundSway`，逐株转角在 CPU 上算）读的是这一份、同一个钟。
 *
 * 模型（字段语义见 `types.ts` 的 `SceneWindDef`，正文见 agent_docs [[scene-wind]]）：
 * - **平均风**：水平方向 × 离地 2 m 处的风速 × 对数廓线 `ln(h/z0) / ln(h_ref/z0)`；
 * - **阵风**：三个错频正弦叠成的包络，**随平均风顺流推进**（相位 τ = t − 顺风距离 / 平均风速，
 *   冻结湍流假设），外加一条横向的相位弯曲，让阵风前沿不是一堵直墙；包络取三次方，
 *   所以是"一阵一阵"的，不是正弦波；
 * - **风向摆动**：同一相位上的慢摆；
 * - **湍流**：一片**真的涡**——若干无散度的随机波叠加（每个模式的振幅 ⟂ 波矢 ⇒ ∇·u′ = 0），
 *   随平均风顺流推进、按各自的涡翻转时间衰变重生。有横风、有上升下沉、原地打圈，
 *   而且**同一处的两粒会被同一个涡带走**（空间相干）——这是"看着不死板"的来源。
 *   ⚠ 别再让每颗粒子把噪声的时间轴按自己的种子错开：那样每粒有一套私有乱流，永远不会一起绕一个涡转。
 *
 * 需要风的地方一律调这里，不许在 shader 或别处另写一份（两份必然漂、漂了不报错）。
 * 纯函数、零分配热路径、不读挂钟（时间由调用方传）——粒子工作台打包的是同一个文件。
 */
import type { SceneWindDef } from '../data/types';
import { windGustErrors, type WindGustDef } from '../data/windGust';

/** 风速的参考高度：离地 2 m */
export const WIND_REF_HEIGHT_WU = 176;

/** 阵风包络的三个分量：[周期倍率, 权重, 相位]。权重和为 1 ⇒ 包络原始值落在 [−1, 1]。 */
const GUST_HARMONICS: readonly (readonly [number, number, number])[] = [
  [1.0, 0.5, 0.0],
  [0.53, 0.3, 1.3],
  [0.29, 0.2, 2.9],
];
/**
 * 包络 g = ½ + ½·raw 的三次方均值。raw 是三个独立相位正弦按权重叠加，方差 Σw²/2 = 0.19，
 * g 的均值 0.5、标准差 0.22 ⇒ E[g³] ≈ 0.5³ + 3·0.5·0.22² ≈ 0.2。拿它把**平均**风速钉在 `speed`。
 */
const GUST_CUBE_MEAN = 0.2;
/** 风向摆动的周期倍率与相位（与阵风错开，风向与风速不同步） */
const VEER_PERIOD_MUL = 1.7;
const VEER_PHASE = 0.7;
/** 横向相位弯曲：幅度（阵风周期的倍数）/ 波长（顺风一个周期推进距离的倍数） */
const LATERAL_BEND = 0.3;
const LATERAL_WAVELENGTH = 1.5;
/** 阵风推进速度的下限（wu/s）：风速极小时别让相位 τ 被一个近零的数除爆 */
const MIN_ADVECTION = 20;
/** 廓线上限：2 m 以上继续按对数涨，但封顶（高处的风不无限大） */
const PROFILE_MAX = 1.6;
/**
 * 湍流的随机波模式数：3 个尺度 × 2 个方向。再多也只是更贵——涡的"看得出来"靠最大的那两三个。
 * 每个模式一个波矢 k 与一个**垂直于 k** 的振幅方向 â：u′ = Σ A·â·cos(k·x + ωt + φ)，
 * 因为 k·â = 0 所以 ∇·u′ = 0 —— 不会出现"凭空涌出 / 汇聚"的假流场，只会打旋。
 */
export const WIND_TURB_MODES = 6;
/** 三个尺度相对涡尺度的倍率与能量权重（Kolmogorov：u_L ∝ L^(1/3)，大涡带大部分能量） */
const TURB_OCTAVES: readonly (readonly [number, number])[] = [[1, 1], [0.42, 0.75], [0.17, 0.55]];
/** 涡的翻转率系数：ω = 系数 × 该尺度的脉动速度 / 尺度（小涡转得快、活得短） */
const TURB_TURNOVER = 0.9;

/**
 * 正弦查表（热路径专用）：`sampleSceneWind` 每帧被逐粒子逐子步调上千次，一次里有 6 个涡模式 +
 * 3 个阵风谐波 + 1 个风向摆动 —— 全走 `Math.cos` 时实测 ≈ 1 µs/次、每帧 0.3 ms。
 * 2048 格 + 线性插值的误差 < 1e-6（远小于风本身的不确定度），换来约 3 倍速度。
 * ⚠ 只给这个文件的热路径用；相位量级要留在 2³¹ 以内（世界坐标 × 波数、ω × 钟都远小于它）。
 */
const TRIG_N = 2048;
const TRIG_TAB = (() => {
  const a = new Float32Array(TRIG_N + 1);
  for (let i = 0; i <= TRIG_N; i++) a[i] = Math.cos((2 * Math.PI * i) / TRIG_N);
  return a;
})();
const TRIG_SCALE = TRIG_N / (2 * Math.PI);

function fastCos(a: number): number {
  const x = a * TRIG_SCALE;
  const i = Math.floor(x);
  const f = x - i;
  const k = i & (TRIG_N - 1);
  const c0 = TRIG_TAB[k];
  return c0 + (TRIG_TAB[k + 1] - c0) * f;
}

function fastSin(a: number): number {
  return fastCos(a - Math.PI / 2);
}

export interface SceneWindParams {
  /** 水平单位方向（M-world 的 X / Z 分量） */
  dirX: number;
  dirZ: number;
  /** 离地 2 m 的平均风速（wu/s） */
  speed: number;
  gustAmount: number;
  gustPeriod: number;
  veerRad: number;
  turbIntensity: number;
  turbScale: number;
  roughness: number;
  /** ln(h_ref / z0)：廓线分母 */
  logRef: number;
  gainVfx: number;
  gainSway: number;
  /** 草木波浪尺寸（wu）：同一株上相距小于它的点一起动 */
  waveSize: number;
  /** 叶片细抖的波长（wu）与频率（Hz） */
  leafSize: number;
  leafHz: number;
  /**
   * 湍流模式表（`WIND_TURB_MODES` 个 × 8 个数：kx, ky, kz, ax, ay, az, 翻转率, 相位）。
   * 由涡尺度与方向确定性生成（同一份风参数 ⇒ 同一片涡，无头验证可逐位复现）。
   */
  turbModes: Float32Array;
}

/**
 * 草木波浪尺寸缺省（wu）：等于改成可调之前那个逐点湍流节奏的**实际**相关长度，所以不写就与原来逐位一致。
 * ⚠ 不是 180：逐点相位 `swayPhase` 的三项正弦叠起来斜率约 0.19 rad/wu，两点相距二十来 wu
 *   节奏就开始错开（实测相距 18 wu 时相关系数 0.96）。数字要说真话——作者读到"20"就知道比这大的植物会起波浪。
 */
export const SWAY_WAVE_SIZE_DEFAULT = 20;
/** 叶片细抖缺省：波长 22 wu（原来写死的 22 原画像素，1:1 的场景里不变）、3.2 Hz */
export const SWAY_LEAF_SIZE_DEFAULT = 22;
export const SWAY_LEAF_HZ_DEFAULT = 3.2;

function finite(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * 场景数据 → 预解析的风参数。没配、风速不为正、方向没有水平分量 ⇒ null（= 这个场景没有风）。
 */
export function resolveSceneWind(def: SceneWindDef | null | undefined): SceneWindParams | null {
  if (!def || !Array.isArray(def.direction)) return null;
  const speed = finite(def.speed, 0);
  if (!(speed > 0)) return null;
  const dx = finite(def.direction[0], 0);
  const dz = finite(def.direction[2], 0);
  const l = Math.hypot(dx, dz);
  if (!(l > 1e-6)) return null;
  const roughness = Math.max(0.05, finite(def.roughness, 1));
  return {
    dirX: dx / l,
    dirZ: dz / l,
    speed,
    gustAmount: Math.max(0, finite(def.gust?.amount, 0.6)),
    gustPeriod: Math.max(0.5, finite(def.gust?.period, 6)),
    veerRad: (finite(def.veer, 12) * Math.PI) / 180,
    turbIntensity: Math.max(0, finite(def.turbulence?.intensity, 0.3)),
    turbScale: Math.max(1, finite(def.turbulence?.scale, 140)),
    roughness,
    logRef: Math.log(Math.max(WIND_REF_HEIGHT_WU / roughness, 1.0001)),
    gainVfx: Math.max(0, finite(def.gain?.vfx, 1)),
    gainSway: Math.max(0, finite(def.gain?.sway, 1)),
    waveSize: Math.max(1, finite(def.waveSize, SWAY_WAVE_SIZE_DEFAULT)),
    leafSize: Math.max(2, finite(def.leaf?.size, SWAY_LEAF_SIZE_DEFAULT)),
    leafHz: Math.max(0, finite(def.leaf?.speed, SWAY_LEAF_HZ_DEFAULT)),
    turbModes: buildTurbModes(Math.max(1, finite(def.turbulence?.scale, 140))),
  };
}

/**
 * 湍流模式表：确定性生成（黄金角铺球面取波矢方向，振幅取 k 的任一垂直方向再绕 k 转一个角）。
 * 归一化到 Σ A²/2 = 1，于是 `sampleSceneWind` 里乘上「强度 × 该高度的平均风速」就是脉动的 rms。
 */
function buildTurbModes(scale: number): Float32Array {
  const out = new Float32Array(WIND_TURB_MODES * 8);
  const ga = Math.PI * (3 - Math.sqrt(5));
  let sum = 0;
  for (let i = 0; i < WIND_TURB_MODES; i++) {
    const [mul, wgt] = TURB_OCTAVES[i % TURB_OCTAVES.length];
    const L = Math.max(scale * mul, 1e-3);
    // 方向：黄金角螺旋（确定性、铺得开）
    const z = 1 - ((2 * i + 1) / WIND_TURB_MODES) * 2;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const th = ga * i;
    const kx = r * Math.cos(th), ky = z, kz = r * Math.sin(th);
    // 振幅方向：任取一条垂直于 k 的，再绕 k 转 φ_i（让每个模式的偏振错开）
    const px = Math.abs(kx) < 0.9 ? 1 : 0, py = Math.abs(kx) < 0.9 ? 0 : 1;
    let ux = ky * 0 - kz * py, uy = kz * px - kx * 0, uz = kx * py - ky * px;
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul; uy /= ul; uz /= ul;
    const vx = ky * uz - kz * uy, vy = kz * ux - kx * uz, vz = kx * uy - ky * ux;
    const rot = 2.399963 * i + 0.7;
    const cr = Math.cos(rot), sr = Math.sin(rot);
    const ax = ux * cr + vx * sr, ay = uy * cr + vy * sr, az = uz * cr + vz * sr;
    const k = (2 * Math.PI) / L;
    const o = i * 8;
    out[o] = kx * k; out[o + 1] = ky * k; out[o + 2] = kz * k;
    out[o + 3] = ax * wgt; out[o + 4] = ay * wgt; out[o + 5] = az * wgt;
    out[o + 6] = (TURB_TURNOVER * wgt) / L;          // × (强度 × 风速) = 角频率
    out[o + 7] = 1.7 * i * i + 0.31 * i;             // 相位
    sum += wgt * wgt;
  }
  const norm = Math.sqrt(2 / Math.max(sum * 2, 1e-9));  // 使 Σ(A·norm)²/2 = 1
  for (let i = 0; i < WIND_TURB_MODES; i++) {
    const o = i * 8;
    out[o + 3] *= norm; out[o + 4] *= norm; out[o + 5] *= norm;
  }
  return out;
}

/**
 * 湍流脉动（wu/s，写进 `out[0..2]` 的**增量**）：无散度随机波叠加，涡随平均风推进、按翻转率衰变。
 * `rms` 传"强度 × 该处平均风速"。不含消费者倍率。
 */
export function addSceneWindTurbulence(
  p: SceneWindParams, t: number, x: number, y: number, z: number, rms: number, out: number[] | Float32Array,
): void {
  if (!(rms > 0)) return;
  const m = p.turbModes;
  // 冻结湍流：涡整体随平均风走（在随风漂的坐标里采样）
  const ax = x - p.dirX * p.speed * t, az = z - p.dirZ * p.speed * t;
  const wsc = rms;
  for (let i = 0; i < WIND_TURB_MODES; i++) {
    const o = i * 8;
    const ph = m[o] * ax + m[o + 1] * y + m[o + 2] * az + m[o + 6] * wsc * t + m[o + 7];
    const c = fastCos(ph) * rms;
    out[0] += m[o + 3] * c;
    out[1] += m[o + 4] * c;
    out[2] += m[o + 5] * c;
  }
}

/** 世界 XZ 处、时刻 t 的阵风相位 τ（秒）。阵风顺流推进，横向再弯一下。 */
export function windPhase(p: SceneWindParams, t: number, x: number, z: number): number {
  const c = Math.max(p.speed, MIN_ADVECTION);
  const along = x * p.dirX + z * p.dirZ;
  const across = -x * p.dirZ + z * p.dirX;
  const lateral = LATERAL_BEND * p.gustPeriod
    * fastSin((2 * Math.PI * across) / (LATERAL_WAVELENGTH * c * p.gustPeriod));
  return t - along / c + lateral;
}

function gustFromRaw(p: SceneWindParams, raw: number): number {
  const g = 0.5 + 0.5 * raw;
  return 1 + (p.gustAmount * (g * g * g - GUST_CUBE_MEAN)) / (1 - GUST_CUBE_MEAN);
}

/** 阵风倍率（乘在平均风速上）：顶峰 1 + amount，谷底 1 − amount/4，时间平均 ≈ 1。 */
export function windGustMul(p: SceneWindParams, tau: number): number {
  let raw = 0;
  for (const [pm, w, ph] of GUST_HARMONICS) raw += w * fastSin((2 * Math.PI * tau) / (p.gustPeriod * pm) + ph);
  return gustFromRaw(p, raw);
}

/**
 * 阵风的批量求值（成千上万个固定点、每帧一个 t）：τ = t + off，off = `windPhase(p, 0, x, z)` 只随点变。
 * 按和角公式拆成"只随点"与"只随 t"两半——点那半（`WIND_GUST_BASIS` 个数）在参数变了时才重算，
 * 每帧只算 t 那半，逐点就剩乘加。与 `windGustMul(p, t + off)` 逐位同一个公式。
 */
export const WIND_GUST_BASIS = GUST_HARMONICS.length * 2;

export function windGustBasis(p: SceneWindParams, off: number, out: Float32Array, o: number): void {
  for (let h = 0; h < GUST_HARMONICS.length; h++) {
    const [pm, w, ph] = GUST_HARMONICS[h];
    const a = (2 * Math.PI * off) / (p.gustPeriod * pm) + ph;
    out[o + 2 * h] = w * Math.cos(a);
    out[o + 2 * h + 1] = w * Math.sin(a);
  }
}

/** t 那半：每个谐波的 (sin ωt, cos ωt)，长 `WIND_GUST_BASIS` */
export function windGustClock(p: SceneWindParams, t: number, out: Float32Array): void {
  for (let h = 0; h < GUST_HARMONICS.length; h++) {
    const a = (2 * Math.PI * t) / (p.gustPeriod * GUST_HARMONICS[h][0]);
    out[2 * h] = Math.sin(a);
    out[2 * h + 1] = Math.cos(a);
  }
}

export function windGustFromBasis(p: SceneWindParams, clock: Float32Array, basis: Float32Array, o: number): number {
  let raw = 0;
  for (let k = 0; k < WIND_GUST_BASIS; k += 2) raw += clock[k] * basis[o + k] + clock[k + 1] * basis[o + k + 1];
  return gustFromRaw(p, raw);
}

/** 风向偏角（弧度，绕世界 +Y） */
export function windVeer(p: SceneWindParams, tau: number): number {
  return p.veerRad * fastSin((2 * Math.PI * tau) / (p.gustPeriod * VEER_PERIOD_MUL) + VEER_PHASE);
}

/** 近地对数廓线：离地高 h（真实 wu）处风速 / 2 m 处风速。h ≤ z0 ⇒ 0。 */
export function windProfile(p: SceneWindParams, hReal: number): number {
  if (!(hReal > p.roughness)) return 0;
  return Math.min(PROFILE_MAX, Math.log(hReal / p.roughness) / p.logRef);
}

/**
 * 世界 XZ、离地真实高度 `hReal` 处的空气速度（wu/s），写进 `out[0..2]`：**平均 + 阵风 + 湍流**。
 * 湍流是一片无散度的涡（横风、上升下沉、原地打圈都从这来，`out[1]` 因此可以非零），
 * 同一时刻同一处的两个消费者拿到**同一个涡**——别在调用方再叠一份自己的噪声。
 * 不含消费者倍率（倍率由调用方乘：粒子乘 `gainVfx`，摆动乘 `gainSway`）。
 */
export function sampleSceneWind(
  p: SceneWindParams, t: number, x: number, z: number, hReal: number, out: number[] | Float32Array,
): void {
  const tau = windPhase(p, t, x, z);
  const prof = windProfile(p, hReal);
  const u = p.speed * windGustMul(p, tau) * prof;
  const a = windVeer(p, tau);
  const c = Math.cos(a), s = Math.sin(a);
  out[0] = (p.dirX * c - p.dirZ * s) * u;
  out[1] = 0;
  out[2] = (p.dirX * s + p.dirZ * c) * u;
  // 脉动的量级按该高度的平均风速算：贴地的纸吃到的乱流本来就小
  addSceneWindTurbulence(p, t, x, Math.max(hReal, 0), z, p.turbIntensity * p.speed * prof, out);
}


/**
 * 一阵**冲击风**（2026-09-24，落雷落地那一下）：从 (x, z) 往外推开的一圈空气，只给**表现**用——
 * 吃场景风的粒子（纸钱、落叶、烟、扬尘）与草木摇曳。**不进** `sampleSceneWind`：手里火把的火苗 / 护火、
 * 燃烧系统读的是那一份，冲击进了它们就成了玩法（一道雷吹灭玩家的火把、燃烧重放对不上）。
 *
 * 时间用冲击自己的钟（`SceneWindState.blastTime`），不用场景风的钟：没写风的场景里风钟不走，
 * 而且燃烧系统的存档记着风钟的映射，不许为了冲击去推它。
 */
export interface WindBlast {
  /** 中心（M-world wu） */
  x: number;
  z: number;
  /** 起始时刻（冲击钟，秒） */
  t0: number;
  /** 中心处的峰值风速（wu/s） */
  strength: number;
  /** 半径（wu）：外面没有 */
  radius: number;
  /** 持续（秒） */
  duration: number;
}

/** 冲击起风的时长（秒）：四十毫秒冲到峰值，之后按 (1−u)² 收 */
const BLAST_ATTACK_S = 0.04;
/** 冲击里往上的那一份（相对水平）：落点炸开，空气先往外、也往上 */
const BLAST_UPWARD = 0.35;
/** 冲击只在贴地这么高以内（wu）满额，往上线性减到 3 倍处为零 */
const BLAST_HEIGHT_WU = 150;

/** 冲击在 age 秒时的强度包络（0..1） */
export function windBlastEnvelope(age: number, duration: number): number {
  if (!(age >= 0) || !(duration > 0) || age >= duration) return 0;
  const rise = age < BLAST_ATTACK_S ? age / BLAST_ATTACK_S : 1;
  const u = age / duration;
  return rise * (1 - u) * (1 - u);
}

/**
 * 把这些冲击在世界 XZ、离地 `hReal` 处的空气速度**加进** `out[0..2]`（wu/s）：水平从中心往外，带一点往上；
 * 强度 × 包络 × (1 − r/半径)²。返回加了多大（速度大小，0 = 这里没有冲击）。
 */
export function addWindBlasts(
  blasts: readonly WindBlast[] | null | undefined, t: number, x: number, z: number, hReal: number,
  out: number[] | Float32Array,
): number {
  if (!blasts || blasts.length === 0) return 0;
  const hk = hReal <= BLAST_HEIGHT_WU ? 1 : Math.max(0, 1 - (hReal - BLAST_HEIGHT_WU) / (2 * BLAST_HEIGHT_WU));
  if (hk <= 0) return 0;
  let sum = 0;
  for (const b of blasts) {
    const env = windBlastEnvelope(t - b.t0, b.duration);
    if (env <= 0) continue;
    const dx = x - b.x, dz = z - b.z;
    const r = Math.hypot(dx, dz);
    if (!(r < b.radius)) continue;
    const f = 1 - r / b.radius;
    const v = b.strength * env * f * f * hk;
    // 正中心没有方向：只往上
    const nx = r > 1e-3 ? dx / r : 0, nz = r > 1e-3 ? dz / r : 0;
    out[0] += nx * v;
    out[1] += v * BLAST_UPWARD;
    out[2] += nz * v;
    sum += v;
  }
  return sum;
}

/**
 * 场景风的运行态：一份参数 + 一个钟 + 调试覆盖。组装层持有一个，逐帧 `advance(dt)`，
 * 粒子系统与背景摆动都从它读——**同一个钟**，所以同一阵风两边同拍。
 */
/** 调试面板的临时覆盖（不落盘）：风速倍率 / 两路增益 / 湍流强度倍率 */
export interface SceneWindOverride {
  speedMul?: number;
  gainVfx?: number;
  gainSway?: number;
  turbMul?: number;
  /** 以下三个是**绝对值**（不是倍率），直接替换 JSON 里的 */
  waveSize?: number;
  leafSize?: number;
  leafHz?: number;
}

export class SceneWindState {
  private base: SceneWindParams | null = null;
  private live: SceneWindParams | null = null;
  private override: SceneWindOverride = {};
  private gust: { def: WindGustDef; elapsed: number; finish: () => void } | null = null;
  private gustWeight = 0;
  private blastList: WindBlast[] = [];
  constructor(private readonly ambientPulse?: (id: string, volume: number | undefined, weight: number) => void) {}
  /** 自进场景起的秒数（切场景清零） */
  time = 0;
  /** 冲击风的钟（秒）：一直走、切场景清零（见 {@link WindBlast} 为什么不用 `time`） */
  blastTime = 0;

  /** 此刻还没吹完的冲击（只读；给吃场景风的粒子与草木摇曳） */
  get blasts(): readonly WindBlast[] { return this.blastList; }

  /** 落一阵冲击（中心 M-world wu、峰值风速 wu/s、半径 wu、秒）。不改场景风参数，别的消费者一概不受影响 */
  addBlast(b: { x: number; z: number; strength: number; radius: number; duration: number }): void {
    if (![b.x, b.z, b.strength, b.radius, b.duration].every(Number.isFinite) || !(b.strength > 0) || !(b.radius > 0) || !(b.duration > 0)) return;
    this.blastList = [...this.blastList, { ...b, t0: this.blastTime }];
  }

  clearBlasts(): void { this.blastList = []; }

  /** 换场景：按新场景数据重设（没有风 ⇒ 之后 `params` 恒 null） */
  reset(def: SceneWindDef | null | undefined): void {
    this.clearGust();
    this.base = resolveSceneWind(def);
    this.time = 0;
    this.blastTime = 0;
    this.blastList = [];
    this.rebuild();
  }

  advance(dt: number): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    if (this.live) this.time += dt;
    if (this.blastList.length) {
      this.blastTime += dt;
      const t = this.blastTime;
      if (this.blastList.some((b) => t - b.t0 >= b.duration)) this.blastList = this.blastList.filter((b) => t - b.t0 < b.duration);
    }
    if (this.gust) {
      this.gust.elapsed += dt * 1000;
      if (this.gust.elapsed >= this.gust.def.durationMs) this.clearGust();
      else this.updateGust();
    }
  }

  /** 后发覆盖前发；替换、切场景、读档、跳过均会解除等待并恢复音量。 */
  startGust(def: WindGustDef): Promise<void> {
    if (windGustErrors(def as unknown as Record<string, unknown>).length) return Promise.resolve();
    this.clearGust();
    if (!this.base || this.base.speed <= 0) {
      console.warn('sceneWindGust: current scene needs a nonzero authored wind');
      return Promise.resolve();
    }
    return new Promise<void>((finish) => {
      this.gust = { def: { ...def }, elapsed: 0, finish };
      this.updateGust();
    });
  }

  clearGust(): void {
    const old = this.gust;
    this.gust = null;
    this.gustWeight = 0;
    if (old?.def.id) this.ambientPulse?.(old.def.id, undefined, 0);
    this.rebuild();
    old?.finish();
  }

  get gustSnapshot(): object | null {
    return this.gust ? { ...this.gust.def, elapsedMs: this.gust.elapsed, weight: this.gustWeight } : null;
  }

  private updateGust(): void {
    const g = this.gust!;
    const attack = g.def.attackMs ?? Math.min(120, g.def.durationMs * 0.1);
    const release = g.def.releaseMs ?? Math.min(500, g.def.durationMs * 0.25);
    this.gustWeight = Math.max(0, Math.min(1, attack > 0 ? g.elapsed / attack : 1,
      release > 0 ? (g.def.durationMs - g.elapsed) / release : 1));
    this.rebuild();
    if (g.def.id) this.ambientPulse?.(g.def.id, g.def.volume ?? 1, this.gustWeight);
  }

  /** 当前生效的参数（含调试覆盖）；没有风 ⇒ null */
  get params(): SceneWindParams | null { return this.live; }

  /** 本场景数据里写的那份（不含覆盖），给调试面板显示 */
  get authored(): SceneWindParams | null { return this.base; }

  /** 调试面板：临时覆盖风速倍率 / 两路增益（不落盘；切场景不清，便于对比） */
  setOverride(o: SceneWindOverride): void {
    this.override = { ...this.override, ...o };
    this.rebuild();
  }

  get overrides(): SceneWindOverride { return this.override; }

  private rebuild(): void {
    const b = this.base;
    if (!b) { this.live = null; return; }
    const o = this.override;
    this.live = {
      ...b,
      speed: b.speed * (o.speedMul ?? 1) * (1 + ((this.gust?.def.speedMultiplier ?? 1) - 1) * this.gustWeight),
      gainVfx: o.gainVfx ?? b.gainVfx,
      gainSway: o.gainSway ?? b.gainSway,
      turbIntensity: b.turbIntensity * (o.turbMul ?? 1),
      waveSize: o.waveSize ?? b.waveSize,
      leafSize: o.leafSize ?? b.leafSize,
      leafHz: o.leafHz ?? b.leafHz,
    };
  }
}
