/**
 * 火焰输出信号 `L(t)` —— 手持光源"闪"的**唯一**数学口径。
 *
 * ## 为什么必须是一个信号
 *
 * 一支火把身上有三样东西会跳：灯的强度、火焰粒子的发射率、（有火头贴图时）挂件自身的亮度。
 * 三处各摇一个随机数，玩家会看出"光在闪、火苗没动"——这种不同步比不闪更糟。
 * 所以这里产出**一个标量**，消费者一律乘它。
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
