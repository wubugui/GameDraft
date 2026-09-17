/**
 * 程序化火苗 —— 帧动画火苗（挂件预设 `flame`）"此刻长什么样"的**唯一**数学口径。
 *
 * ## 分工
 *
 * 帧动画火苗 = **帧动画**（只管"火在烧"）+ **程序化**（大小、倾斜、明灭）。
 * 帧动画不画状态：点着 / 护火 / 残炭 / 灭之间的差别全是这里算出来的连续量。
 * （2026-09-15 制作人定：火把本身改用粒子挂载，帧动画火苗作为挂件能力保留。）
 *
 * ## 倾斜是物理推出来的，不是调出来的
 *
 * 火苗在横风里的倾角由 **Froude 数**决定：`tanθ = u² / (g·H)`
 * （u = 相对火苗的水平气流，H = 火苗高，g = 重力加速度，全 SI）。
 * 量级核对：10 cm 的火苗在 1 m/s 的风里 Fr≈1 ⇒ 约 45°，0.5 m/s ⇒ 约 14°，与蜡烛/火把的日常观感一致。
 * **相对**气流 = 场景风 − 举火把那个人的速度：人举着火把跑，火苗往身后拖，不用另写规则。
 *
 * ## 大小也是物理关系
 *
 * 火苗高度按 Heskestad 关系随火焰输出的 2/5 次方变（不是等比例，见 `heldPropSignal.BURN_SIZE_EXPONENT`），
 * 并有 50 ms 的响应时间；贴图是直立面上的一张图，只表达面内的倾斜，往镜头方向倒的分量只表现为变短。
 *
 * 纯函数、确定性、不读挂钟（时间由调用方传），与 `heldPropSignal` 同一个约定。
 */

import { FLAME_WIND_REF_WU_PER_S } from './heldPropSignal';

type Vec3 = [number, number, number];

/** 1 m 折多少 wu。与火焰风参照同一个换算（角色高 150 wu ≈ 1.7 m），不另起一个数。 */
export const FLAME_WU_PER_M = FLAME_WIND_REF_WU_PER_S;

/** 重力加速度（m/s²） */
export const FLAME_GRAVITY_M_PER_S2 = 9.81;

/**
 * 倾角上限（弧度）。Froude 关系在强风里会给出趋近 90° 的角——那时真火早被吹得贴着杆子或灭了，
 * "灭"是状态切换的事，不是这里的事；这里只保证画面上的火苗不会横着躺平。
 */
export const FLAME_MAX_TILT_RAD = (70 * Math.PI) / 180;

/**
 * 火苗对气流的响应时间（秒）：一阶低通的时间常数。火焰是一团有惯性的热气，
 * 风一变不会在同一帧就倒过去——没有这一项，阵风里的湍流分量会让火苗逐帧抽搐。
 */
export const FLAME_AIRFLOW_TAU_S = 0.08;

/**
 * 宿主速度的"瞬移"判据（wu/s）：超过它就不是走路跑步能达到的速度（切场景、传送、读档重挂），
 * 那一帧的位移不算气流，否则火苗会被一下子吹到 70°。约 34 m/s。
 *
 * ⚠ 速度取**宿主接地点**的，不取起火点的：起火点跟着手，手的位置是逐帧动画——换帧那一下挂点跳几十 wu，
 * 求出来就是几百 wu/s 的假速度，火苗每 3–4 帧抽一下（2026-09-15 真跑抓到）。
 */
export const FLAME_TELEPORT_WU_PER_S = 3000;

/** 火苗高度低于满火的这一比例就不画（燃烧强度 × 闪烁已经小到看不见） */
export const FLAME_MIN_VISIBLE_RATIO = 0.01;

/**
 * 火苗高度的响应时间（秒）：一阶低通。火焰高度跟不上 17 / 37 Hz 那两个闪烁谐波——
 * 那两个分量是给灯光"呼吸里带爆裂"的，逐帧拿去缩放贴图在 60 fps 下就是频闪（2026-09-15 真跑抓到）。
 */
export const FLAME_HEIGHT_TAU_S = 0.05;

/**
 * 横风里的火苗倾角（弧度，≥0，封顶 {@link FLAME_MAX_TILT_RAD}）。
 *
 * @param airSpeedWu    水平相对气流大小（wu/s）
 * @param flameHeightWu 火苗的**平均**高度（wu）——跟着闪烁的高度走，倾角就跟着闪烁抽搐
 */
export function flameTiltAngle(airSpeedWu: number, flameHeightWu: number): number {
  if (!(airSpeedWu > 0) || !(flameHeightWu > 0)) return 0;
  const u = airSpeedWu / FLAME_WU_PER_M;
  const h = flameHeightWu / FLAME_WU_PER_M;
  const fr = (u * u) / (FLAME_GRAVITY_M_PER_S2 * h);
  return Math.min(FLAME_MAX_TILT_RAD, Math.atan(fr));
}

/**
 * 气流的一阶低通：`prev + (next − prev)·(1 − e^(−dt/τ))`。`prev` 为 null（刚挂上 / 刚瞬移）时直接取 `next`。
 * 按 dt 精确离散，帧率不同答案一致（不是"每帧乘 0.9"那种跟帧率绑死的写法）。
 */
export function smoothAirflow(prev: Vec3 | null, next: Vec3, dt: number, tau = FLAME_AIRFLOW_TAU_S): Vec3 {
  if (!prev || !(dt > 0)) return [next[0], next[1], next[2]];
  const k = tau > 0 ? 1 - Math.exp(-dt / tau) : 1;
  return [
    prev[0] + (next[0] - prev[0]) * k,
    prev[1] + (next[1] - prev[1]) * k,
    prev[2] + (next[2] - prev[2]) * k,
  ];
}

/** 标量一阶低通（同 {@link smoothAirflow} 的离散方式；`prev` 为 null 时直接取 `next`） */
export function smoothScalar(prev: number | null, next: number, dt: number, tau: number): number {
  if (prev === null || !(dt > 0)) return next;
  const k = tau > 0 ? 1 - Math.exp(-dt / tau) : 1;
  return prev + (next - prev) * k;
}

/**
 * 相对空气的水平气流（M-world，wu/s）：场景风 − 宿主速度，只留水平分量（y 是世界上方）。
 * 速度超过瞬移判据 ⇒ 当这一帧没动（见 {@link FLAME_TELEPORT_WU_PER_S}）。
 */
export function relativeHorizontalAirflow(wind: Vec3, velocity: Vec3 | null): Vec3 {
  let vx = 0;
  let vz = 0;
  if (velocity) {
    const speed = Math.hypot(velocity[0], velocity[1], velocity[2]);
    if (speed <= FLAME_TELEPORT_WU_PER_S) {
      vx = velocity[0];
      vz = velocity[2];
    }
  }
  return [wind[0] - vx, 0, wind[2] - vz];
}

/**
 * 画面水平方向在世界水平面里对应的单位矢量（相机的"右"）。
 *
 * 用三个投影点求：`base`、`base + e_x·s`、`base + e_z·s` 的画面坐标。取水平组合 `a·e_x + b·e_z`
 * 使画面 y 不动（`a·dy_x + b·dy_z = 0`），再按画面 x 为正定号。**不手推 R 的行列**——写反了也自洽、零报错
 * （同 `sceneSpace.viewDirWorld` 的理由）。退化（两轴画面 y 都不变）⇒ 世界 ±x。
 */
export function screenRightHorizontal(
  sb: { x: number; y: number },
  sx: { x: number; y: number },
  sz: { x: number; y: number },
): Vec3 {
  const dxX = sx.x - sb.x;
  const dyX = sx.y - sb.y;
  const dxZ = sz.x - sb.x;
  const dyZ = sz.y - sb.y;
  let a = dyZ;
  let b = -dyX;
  const len = Math.hypot(a, b);
  if (!(len > 1e-12)) return dxX >= 0 ? [1, 0, 0] : [-1, 0, 0];
  a /= len;
  b /= len;
  if (a * dxX + b * dxZ < 0) {
    a = -a;
    b = -b;
  }
  // +0：把 −0 收成 0（取反零分量时会冒出 −0，数值无差，只是别让比较里多出一种零）
  return [a + 0, 0, b + 0];
}

/**
 * 倾斜的火苗怎么画到一张**直立面**上的贴图里。
 *
 * 火苗贴图与角色一样是立在世界里、正对相机的一张图：它只能表达**直立面内**的倾斜（左右歪），
 * 垂直于直立面的那一分量（往镜头倒 / 往画里倒）只能表现为**变短**。所以：
 * 面内分量 = `sinθ · (气流方向 · 相机右)`，竖直分量 = `cosθ`；
 * 画面倾角 = `atan2(面内, 竖直)`（顺时针为正），长度比 = `√(竖直² + 面内²)`。
 *
 * 竖直分量恒 ≥ cos(封顶角) > 0 ⇒ **火苗永远不会在画面上耷拉到水平线以下**——按完整 3D 轴投影时，
 * 往镜头方向倒的那一分量被 45° 俯视投成"往下"，风一大火苗尖朝地（2026-09-15 真跑抓到）。
 *
 * @param air      水平相对气流（M-world wu/s，已低通）
 * @param heightWu 火苗的**平均**高度（燃烧强度 × 满火高度；不含闪烁）
 * @param right    {@link screenRightHorizontal}
 */
export function flameBillboardPose(air: Vec3, heightWu: number, right: Vec3): { angleRad: number; lengthRatio: number } {
  const speed = Math.hypot(air[0], air[2]);
  const theta = flameTiltAngle(speed, heightWu);
  if (!(theta > 0) || !(speed > 0)) return { angleRad: 0, lengthRatio: 1 };
  const lateral = (air[0] * right[0] + air[2] * right[2]) / speed;
  const inPlane = Math.sin(theta) * lateral;
  const vertical = Math.cos(theta);
  return { angleRad: Math.atan2(inPlane, vertical), lengthRatio: Math.hypot(vertical, inPlane) };
}

/**
 * 帧动画当前帧号。种子只决定起始相位：两支并排的火把不同步（与 `flameOutput` 的种子同一份）。
 */
export function flameFrameIndex(timeSec: number, fps: number, frames: number, seed: number): number {
  const n = Math.max(1, Math.trunc(frames));
  const rate = fps > 0 ? fps : 24;
  const phase = ((seed >>> 0) % n);
  const i = Math.floor(Math.max(0, timeSec) * rate) + phase;
  return ((i % n) + n) % n;
}
