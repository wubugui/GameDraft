/**
 * 火焰输出信号 `L(t)` —— 手持光源"闪"的**唯一**数学口径。
 *
 * ## 为什么必须是一个信号
 *
 * 一支火把身上有三样东西会跳：灯的强度、火的大小（粒子新生大小 / 帧动画火苗高度）、（有火头贴图时）挂件自身的亮度。
 * 三处各摇一个随机数，玩家会看出"光在闪、火苗没动"——这种不同步比不闪更糟。
 * 所以这里产出**一个标量**，消费者一律乘它。
 *
 * ## 两种闪
 *
 * - **物理闪烁**（`PhysicalFlicker`，火把）：频率与对风的反应从燃烧面直径与火把处的气流推出，见文件下半；
 * - **正弦闪烁**（`flameOutput`，灯笼）：下面这一段说的就是它。
 *
 * ## 为什么是三个错频正弦而不是 random()
 *
 * 与场景风的阵风（`utils/sceneWind.ts`）同一个思路，理由也同一条：
 * **确定性**。同一个种子、同一串 `t` ⇒ 逐位相同，无头验证才断言得了；
 * `Math.random()` 一进来，"灯为什么这一帧是这个亮度"就再也复现不了。
 *
 * 作者填的是**相对波动幅度 `amp` 与频率 `hz`**（有名字的量），不是"随机 ±20%"那种
 * 调出来好看的魔数（见 decisions/2026-08-23-physical-derivation-over-fitting）。
 *
 * 纯函数、不读挂钟（时间由调用方传）。
 */

/**
 * 火焰对风的参照速度（wu/s）。
 *
 * `1 m ≈ 88 wu`（粒子卡里的换算：角色高 150 wu ≈ 1.7 m），所以这是 **1 m/s 的风**——
 * 差不多是"烛火明显被吹得晃起来"的那个量级。`windAmp` 就以它为单位度量。
 */
export const FLAME_WIND_REF_WU_PER_S = 88;

/** 风把波动幅度推高的上限倍数：再大的风也不会让幅度无限涨（火早该被吹灭了）。 */
const WIND_AMP_MAX_MUL = 4;

/**
 * 三个错频分量：[频率倍率, 权重]。权重和为 1 ⇒ 原始值落在 [−1, 1]，均值 0。
 * 频率比刻意取无理数感（1 / 0.41 / 0.23）——同频叠加会听出周期，火焰不该有节拍。
 */
const HARMONICS: readonly (readonly [number, number])[] = [
  [1.0, 0.5],
  [2.41, 0.3],
  [5.23, 0.2],
];

/**
 * 火焰输出乘子：均值 1、峰谷约 `1 ± amp`。
 *
 * @param t     自起火累计秒（调用方的钟，别读挂钟）
 * @param amp   相对波动幅度（0 = 不闪）
 * @param hz    基频（Hz）
 * @param seed  种子：只决定初相，同一支火把恒定 ⇒ 两盏并排的火把不同步
 */
export function flameOutput(t: number, amp: number, hz: number, seed: number): number {
  if (!(amp > 0) || !(hz > 0)) return 1;
  // 种子 → [0, 2π) 的三个初相。整数哈希，纯函数，无状态。
  let h = (seed | 0) >>> 0;
  let raw = 0;
  for (const [mul, w] of HARMONICS) {
    h = (h * 1664525 + 1013904223) >>> 0;
    const phase = (h / 4294967296) * Math.PI * 2;
    raw += w * Math.sin(2 * Math.PI * hz * mul * t + phase);
  }
  // 下限 0.05：火焰输出不会真的到 0（到 0 就是灭了，那是状态切换的事，不是波动）
  return Math.max(0.05, 1 + amp * raw);
}

// ------------------------------------------------------------------ 物理闪烁（火把：明火 / 炭火）
//
// 2026-09-15 制作人："闪的太快、和火焰对不上"。老的三个正弦（7 / 16.9 / 36.6 Hz）在跑马梁的风里被推到 ±80%，
// 75% 的能量在 7 Hz 以上。查到的规律（出处写在各常量上）：
// - 火自己"喘"是浮力不稳定，频率只看燃烧面大小 f = 1.5/√D，波形是慢长快塌的锯齿，周期很稳；
// - 整团火照出去的总光看不太出喘频（NIST Kim/Sivathanu/Gore：积分辐射无明显脉动峰，能量在 10–20 Hz 以下）⇒ 喘在灯上的幅度小；
// - 风速压过浮力速度 √(gD) 喘就被压住（co-flow 实验：气流大到一定程度脉动完全消失）；
// - 横风里火焰长度 ∝ u^−0.21（Thomas 1963）⇒ 亮度跟着**阵风**起落，节奏是风的（秒级）。
// 气流由调用方给（火把处的相对气流：场景风 − 人走动，护火挡掉一部分），与火苗倾斜、粒子吃的是同一股风。

const G_M_PER_S2 = 9.81;

/** 喘的频率系数：`f = 1.5 · D^−½`（D 米）。Cetegen & Ahmed 1993（Combust. Flame 93），浮力池火 / 扩散火焰 */
export const FLAME_PUFF_FREQ_COEFF = 1.5;

/** 横风火焰长度对风速的指数：`L_f ∝ u^−0.21`（Thomas 1963 横风池火关系） */
export const FLAME_LENGTH_WIND_EXPONENT = -0.21;

/** 喘一个周期里"慢慢长大"占的比例，其余是塌下去（蜡烛光电管实测是锯齿：慢长快塌） */
export const FLAME_PUFF_RISE_FRACTION = 0.8;

/** 喘在光输出上的缺省相对幅度（半峰）。积分辐射看不出喘频 ⇒ 取小；没有直接实测，是估计值 */
export const FLAME_PUFF_AMP_DEFAULT = 0.1;

/** 逐周期的频率抖动（±）：实测喘频很稳（"remarkably stable"），只给一点点 */
const PUFF_FREQ_JITTER = 0.05;
/** 逐周期的幅度抖动（±）：塌下去的那一截每次大小不一 */
const PUFF_AMP_JITTER = 0.2;

/**
 * 湍流光输出波动（相对均方根）。第一版漏了这一项，制作人真跑："光感觉他就没有闪"——大风压掉喘、火焰长度随风只变 u^−0.21，剩下一条缓线。
 * 规律：湍流扩散火焰的辐射波动沿视线实测可达 100%，频谱高频按 f^−5/3 衰减（Faeth / Gore 组，luminous turbulent diffusion flames）；
 * 10 cm 火把头的浮力雷诺数 √(gD)·D/ν ≈ 6000，无风也已是湍流火。整团火的光是十几个涡叠出来的 ⇒ 100%/√16 ≈ 25%（估计值）；
 * 无风时只有浮力羽流自己的弱湍流，取 10%（估计值）。两者之间按喘被压掉的比例过渡。
 */
export const FLAME_TURB_RMS_STILL = 0.1;
export const FLAME_TURB_RMS_WIND = 0.25;
/**
 * 湍流波动的角频率：横风绕火把头脱涡 `f = St·u/D`（圆柱 St ≈ 0.2），不低于喘的频率（无风时最大的结构就是喘）。
 * 以上按一阶衰减（≈ f^−2，接近湍流的 f^−5/3）。12 m/s、10 cm ⇒ 24 Hz：风越大闪得越碎越快。
 */
export const FLAME_SHEDDING_STROUHAL = 0.2;
/** 炭火：热惯性大，风的湍流只让它慢慢一明一暗（角频率 1 Hz、大风时均方根 10%，估计值） */
export const EMBER_TURB_RMS_WIND = 0.1;
export const EMBER_TURB_CORNER_HZ = 1;

/** 湍流波动此刻的相对均方根：无风 `FLAME_TURB_RMS_STILL` → 大风 `FLAME_TURB_RMS_WIND`，按 `u²/(gD+u²)` 过渡 */
export function flameTurbulenceRms(airMps: number, diameterM: number): number {
  const windy = 1 - flamePuffWeight(airMps, diameterM);
  return FLAME_TURB_RMS_STILL + (FLAME_TURB_RMS_WIND - FLAME_TURB_RMS_STILL) * windy;
}

/** 湍流波动的角频率（Hz）：`max(1.5/√D, 0.2·u/D)` */
export function flameTurbulenceCornerHz(airMps: number, diameterM: number): number {
  const d = Math.max(1e-4, diameterM);
  return Math.max(flamePuffFrequency(d), (FLAME_SHEDDING_STROUHAL * Math.max(0, airMps)) / d);
}

/** 空气运动黏度（m²/s，~300 K）与氧的施密特数：炭火强制对流传质用 */
const AIR_KINEMATIC_VISCOSITY = 1.6e-5;
const OXYGEN_SCHMIDT = 0.7;

/** 喘的频率（Hz）：`1.5/√D` */
export function flamePuffFrequency(diameterM: number): number {
  return FLAME_PUFF_FREQ_COEFF / Math.sqrt(Math.max(1e-4, diameterM));
}

/** 火自身的浮力速度 `√(gD)`（m/s）：风比它小，火照样自己喘、长度不怎么变 */
export function flameBuoyantSpeed(diameterM: number): number {
  return Math.sqrt(G_M_PER_S2 * Math.max(1e-4, diameterM));
}

/** 喘还剩几成：`1/(1 + u²/(gD))`——风压过浮力速度就喘不起来 */
export function flamePuffWeight(airMps: number, diameterM: number): number {
  const ub = flameBuoyantSpeed(diameterM);
  return 1 / (1 + (airMps * airMps) / (ub * ub));
}

/** 风把明火吹短带来的亮度倍率：`(√(u² + gD)/√(gD))^−0.21`。无风 = 1 */
export function flameWindFactor(airMps: number, diameterM: number): number {
  const ub = flameBuoyantSpeed(diameterM);
  return Math.pow(Math.hypot(airMps, ub) / ub, FLAME_LENGTH_WIND_EXPONENT);
}

/** 风把炭火吹亮的倍率：Ranz–Marshall `Sh = 2 + 0.6 Re^½ Sc^⅓`，以无风（浮力速度）为基准。无风 = 1 */
export function emberWindFactor(airMps: number, diameterM: number): number {
  const d = Math.max(1e-4, diameterM);
  const sh = (u: number) => 2 + 0.6 * Math.sqrt((u * d) / AIR_KINEMATIC_VISCOSITY) * Math.cbrt(OXYGEN_SCHMIDT);
  const ub = flameBuoyantSpeed(d);
  return sh(Math.hypot(airMps, ub)) / sh(ub);
}

/** 喘的波形：相位 0..1 → −1..1，慢长快塌的锯齿，一个周期均值 0 */
export function flamePuffWave(phase: number): number {
  const r = FLAME_PUFF_RISE_FRACTION;
  const saw = phase < r ? phase / r : 1 - (phase - r) / (1 - r);
  return 2 * saw - 1;
}

function hashUnit(seed: number, n: number): number {
  let h = (Math.imul(seed | 0, 2654435761) ^ Math.imul(n | 0, 40503)) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 2246822519) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 3266489917) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * 物理闪烁的运行态（每支挂着的火把一个）。确定性：同种子 + 同一串 (dt, 气流) ⇒ 逐位相同。
 * 喘是准周期（逐周期抖一点频率和幅度），所以要带相位状态走，不是 t 的纯函数。
 */
export class PhysicalFlicker {
  private phase: number;
  private cycle = 0;
  private cycleHz: number;
  private cycleAmp: number;
  /** 湍流波动的状态（单位方差的一阶自回归）与步数（噪声的哈希序号） */
  private turb = 0;
  private tick = 0;

  constructor(
    readonly kind: 'flame' | 'ember',
    readonly diameterM: number,
    readonly puffAmp: number,
    private readonly seed: number,
  ) {
    this.phase = hashUnit(seed, 0x9e37);
    this.cycleHz = this.jitterHz(0);
    this.cycleAmp = this.jitterAmp(0);
  }

  private jitterHz(k: number): number {
    return flamePuffFrequency(this.diameterM) * (1 + PUFF_FREQ_JITTER * (2 * hashUnit(this.seed, k * 2 + 1) - 1));
  }

  private jitterAmp(k: number): number {
    return this.puffAmp * (1 + PUFF_AMP_JITTER * (2 * hashUnit(this.seed, k * 2 + 2) - 1));
  }

  /**
   * 湍流一步：单位方差的一阶自回归（Ornstein–Uhlenbeck 精确离散），角频率 `cornerHz`。
   * 噪声取种子 × 步数的哈希（Box–Muller），不读 Math.random —— 同种子同一串输入逐位可复现。
   */
  private stepTurbulence(dt: number, cornerHz: number): number {
    if (!(dt > 0)) return this.turb;
    const a = Math.exp(-2 * Math.PI * cornerHz * dt);
    const u1 = Math.max(1e-9, hashUnit(this.seed ^ 0x5bd1e995, this.tick * 2 + 7));
    const u2 = hashUnit(this.seed ^ 0x5bd1e995, this.tick * 2 + 8);
    this.tick++;
    const g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    this.turb = a * this.turb + Math.sqrt(1 - a * a) * g;
    return this.turb;
  }

  /** 走一帧，返回这一帧的火焰输出 `L`（无风、不喘时均值 1）。`airMps` = 火把处相对气流的水平速度（m/s） */
  step(dt: number, airMps: number): number {
    const u = Number.isFinite(airMps) && airMps > 0 ? airMps : 0;
    if (this.kind === 'ember') {
      const windy = 1 - flamePuffWeight(u, this.diameterM);
      const flutter = 1 + EMBER_TURB_RMS_WIND * windy * this.stepTurbulence(dt, EMBER_TURB_CORNER_HZ);
      return Math.max(0.05, emberWindFactor(u, this.diameterM) * Math.max(0.2, flutter));
    }
    const turbulence = Math.max(0.2, 1 + flameTurbulenceRms(u, this.diameterM)
      * this.stepTurbulence(dt, flameTurbulenceCornerHz(u, this.diameterM)));
    if (dt > 0) {
      this.phase += this.cycleHz * dt;
      while (this.phase >= 1) {
        this.phase -= 1;
        this.cycle++;
        this.cycleHz = this.jitterHz(this.cycle);
        this.cycleAmp = this.jitterAmp(this.cycle);
      }
    }
    const puff = 1 + this.cycleAmp * flamePuffWeight(u, this.diameterM) * flamePuffWave(this.phase);
    return Math.max(0.05, puff * turbulence * flameWindFactor(u, this.diameterM));
  }
}

// ------------------------------------------------------------------ 快被吹灭时的时断时续（guttering）
//
// 2026-09-15 制作人："这个火要灭的时候根本看不到一个明显的状态"。火势只让火苗缩一点、光暗一点，太平缓。
// 真火接近吹熄时是**局部熄灭—再复燃**反复发生：火焰被掐断、缩回燃料表面，隔一个"重燃时间"又窜起来；
// 越接近吹熄，断着的时间占比越大、燃着的时候越短。这里用一个两态过程表达它。

/** 火势高于它不断（火还旺） */
export const GUTTER_START_VITALITY = 0.75;
/** 火势到 0 时燃着的时间占比（剩下的时间都断着） */
export const GUTTER_MIN_DUTY = 0.25;
/** 断一次平均多久（秒）：重燃时间——火把头的余热把燃料蒸气重新点着要的时间（估计值，没有实测） */
export const GUTTER_REIGNITE_SECONDS = 0.12;
/** 断着时灯剩几成：火把头还烫、还在发光 */
export const GUTTER_OFF_LIGHT = 0.2;
/** 断着时火苗剩几成（粒子发射量与新生大小、帧动画火苗高度都乘它） */
export const GUTTER_OFF_FLAME = 0.05;

/** 火势 → 燃着的时间占比：`v ≥ 0.75` 恒燃；以下线性降到 `v = 0` 时 0.25 */
export function gutterDuty(vitality: number): number {
  const v = vitality < 0 ? 0 : vitality > 1 ? 1 : vitality;
  if (v >= GUTTER_START_VITALITY) return 1;
  return GUTTER_MIN_DUTY + (1 - GUTTER_MIN_DUTY) * (v / GUTTER_START_VITALITY);
}

/**
 * 两态（燃着 / 断着）过程，**每一帧按此刻的占比重新判**：断着转燃着的速率 = 1 / 重燃时间，燃着转断着的速率
 * 按占比推出 `1 / T_on`，`T_on = T_off · duty / (1 − duty)`（稳态燃着占比恰好 = duty；占比 1 = 一直燃着）。
 * 这一帧切换的概率 `1 − exp(−dt / T)`（泊松事件，互不记忆）。
 *
 * ⚠ 第一版在切到燃着时一次性抽一段燃着时长：火势刚跌破 0.75（占比 0.996）那一下抽到 12 s，
 * 之后火势掉到底也得等它走完——整段火要灭的过程一次都没断（2026-09-15 单测抓到）。所以不许预抽时长。
 * 噪声是种子 × 帧序号的哈希——同种子同一串 (dt, 占比) 逐位可复现。
 */
export class GutterProcess {
  private on = true;
  private n = 0;

  constructor(private readonly seed: number) {}

  /** 走一帧，返回这一帧燃着没有 */
  step(dt: number, duty: number): boolean {
    if (!(duty < 1)) {
      this.on = true;
      return true;
    }
    if (!(dt > 0)) return this.on;
    const d = Math.max(0.01, duty);
    const meanStay = this.on ? (GUTTER_REIGNITE_SECONDS * d) / (1 - d) : GUTTER_REIGNITE_SECONDS;
    const u = hashUnit(this.seed ^ 0x27d4eb2f, this.n++);
    if (u < 1 - Math.exp(-dt / meanStay)) this.on = !this.on;
    return this.on;
  }
}

/**
 * 当地风把波动幅度推成多少：`amp × (1 + windAmp × u/u_ref)`，封顶 `WIND_AMP_MAX_MUL`。
 *
 * `u` 取火焰处的空气速度大小（`sampleSceneWind` 的水平分量，wu/s）。
 * `windAmp` 缺省 0 ⇒ 室内的灯笼完全不吃风，读数与场景有没有风无关。
 */
export function flickerAmpWithWind(amp: number, windSpeed: number, windAmp: number | undefined): number {
  if (!(amp > 0)) return 0;
  const k = windAmp ?? 0;
  if (!(k > 0) || !(windSpeed > 0)) return amp;
  const mul = Math.min(WIND_AMP_MAX_MUL, 1 + (k * windSpeed) / FLAME_WIND_REF_WU_PER_S);
  return amp * mul;
}

/**
 * 燃烧强度 → 新生火焰粒子的大小倍率：**Heskestad 火焰高度关系** `L_f ∝ Q^(2/5)`。
 *
 * 燃烧强度描述的是热释放率（火有多旺）；火焰的尺度按它的 2/5 次方变，不是等比例——
 * 等比例的话"护火"压到 0.75 的火苗会小一大截，而真实的火只是矮一点点（0.75^0.4 ≈ 0.89）。
 * 0 ⇒ 0（配合发射率 0：不再发、在飞的自然烧完）。
 */
export const BURN_SIZE_EXPONENT = 0.4;

export function burnSizeScale(burn: number): number {
  if (!(burn > 0)) return 0;
  return Math.pow(Math.min(1, burn), BURN_SIZE_EXPONENT);
}

/**
 * 灯位/强度的**死区**：跟随灯每动一下都要重烘整张光照缓存（`SceneLightingPass` 的第一级），
 * 所以"没怎么动"就不要标脏——不然"稳态每帧零光照计算"会退化成每帧全屏重算。
 *
 * @param posEpsWu  位置阈值（wu）。1 wu ≈ 角色身高的 1/150，屏幕上远小于一个像素
 * @param relEps    强度相对阈值
 */
export function lightChangedEnough(
  prev: { pos: readonly [number, number, number]; intensity: number } | null,
  next: { pos: readonly [number, number, number]; intensity: number },
  posEpsWu = 1,
  relEps = 0.01,
): boolean {
  if (!prev) return true;
  if (Math.abs(next.pos[0] - prev.pos[0]) > posEpsWu) return true;
  if (Math.abs(next.pos[1] - prev.pos[1]) > posEpsWu) return true;
  if (Math.abs(next.pos[2] - prev.pos[2]) > posEpsWu) return true;
  const base = Math.max(Math.abs(prev.intensity), 1e-6);
  return Math.abs(next.intensity - prev.intensity) / base > relEps;
}

/**
 * 状态切换的过渡：`0` → `1` 的线性进度。`durationMs <= 0` ⇒ 立刻到位（1）。
 * 用线性而不是 ease：火把由亮转暗是物理过程，作者要的是"多久"，不是"怎么弯"。
 */
export function transitionProgress(elapsedMs: number, durationMs: number): number {
  if (!(durationMs > 0)) return 1;
  const p = elapsedMs / durationMs;
  return p <= 0 ? 0 : p >= 1 ? 1 : p;
}
