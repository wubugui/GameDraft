import type { ActionDef } from '../../data/types';

export interface SugarWheelIndexEntry {
  id: string;
  label: string;
  file: string;
}

export interface SugarWheelSectorDef {
  id: string;
  label: string;
  /**
   * 物理跑道高度倾向：不写或无效时视为 1。1 是基准平地，越大表示该格越低、越容易停留，
   * 越小表示该格越高、越难停留；不等同精确中奖率。0 会按运行时下限折算为很高的坡，不保证绝对不命中。
   */
  weight?: number;
  /** 透传给 `minigame:sugarWheelResult` 的配置数据，由外部系统自行解释。 */
  payload?: Record<string, unknown>;
  /** 玩家在 idle/result 阶段转盘上手势拖完指针松手后，对当前指针所指数格顺序执行（与其它编辑器 Action 相同筛选器）。 */
  actionsOnPointerDrag?: ActionDef[];
  /** 蓄力松手后转盘停稳并落在本格时顺序执行，再走结果横幅与 `minigame:sugarWheelResult`。 */
  actionsOnSpinLanding?: ActionDef[];
}

export interface SugarWheelInstance {
  id: string;
  label: string;
  backgroundImage?: string;
  /** 背景铺放方式：cover 铺满裁切；contain 完整显示。 */
  backgroundFit?: 'cover' | 'contain';
  /** 可选前景遮罩层，例如围观人群，绘制在转盘/指针之上、UI 之下。 */
  foregroundImage?: string;
  /** 前景铺放方式：cover 铺满裁切；contain 完整显示。 */
  foregroundFit?: 'cover' | 'contain';
  wheelImage: string;
  pointerImage: string;
  /** 指针贴图锚点 X（0–1），默认 0.5 即水平居中。旋转与缩放均以锚点为原点。 */
  pointerAnchorX?: number;
  /** 指针贴图锚点 Y（0–1），默认 0.9；旋转与缩放均以锚点为原点。 */
  pointerAnchorY?: number;
  pointerScale?: number;
  wheelScale?: number;
  wheelMaxSizePercent?: number;
  wheelMaxSizePx?: number;
  /** 转盘层相对布局中心点（水平居中、竖直按留白算出）的像素偏移，默认 0。 */
  wheelCenterOffsetXPx?: number;
  wheelCenterOffsetYPx?: number;
  /** 指针锚点在转盘层局部坐标内的位置（转盘中心为原点），默认 (0,0)。 */
  pointerOffsetXPx?: number;
  pointerOffsetYPx?: number;
  /**
   * 蓄力圆形按钮：**中心**相对「布局中转盘中心」(cx+wheelCenterOffsetX, cy+wheelCenterOffsetY) 的屏幕像素偏移。
   * 未配置时与 `wheelGeomRadiusPx * 0.72` 同向，落在右下侧默认位。
   */
  chargeButtonWheelOffsetXPx?: number;
  chargeButtonWheelOffsetYPx?: number;
  /** 蓄力按钮直径（px），未配置时 52。 */
  chargeButtonDiameterPx?: number;
  sectorAngleOffsetDeg?: number;
  /**
   * 分格起点相位：第 0 格左边界在角 `offset + phase·step`（弧度、顺时针，0 为正上）。
   * 在 `offset===0`、`phase===0` 时边界线落在正上方，与多数盘面「12 点射线为区界」一致。
   * 未填视为 0。
   */
  sectorCenterPhase?: number;
  /** 指针贴图相对数学方向的附加旋转，单位度（针头不朝正上时校准）。 */
  pointerArtOffsetDeg?: number;
  /** 蓄力映射：1=线性；>1 时前半段更细腻（如 1.35）。 */
  powerChargeCurve?: number;
  /** 格子排列方向；指针初始角由拖动决定，松手后角速度/角加速度同向；counterclockwise 时取反。 */
  sectorDirection?: 'clockwise' | 'counterclockwise';
  /** 按住多久蓄满力。 */
  powerChargeMs?: number;
  /** 轻点时的最低蓄力比例底数，0-1（仍可能与曲线相乘）。 */
  minLaunchPower?: number;

  // ----- 物理停针（欧拉积分 θ+=ωΔt，ω+=αΔt，阻力线性项） -----
  /** 阻力系数 k（1/s），欧拉：ω ← ω + (α - k·ω)·Δt；越小转越久。 */
  spinLinearDragPerSec?: number;
  /**
   * |ω| 低于该阈值（rad/s）时叠加快增阻力；与 spinDragLowSpeedBoostPerSec 配合。
   * ≤0 或未配 boost 时关闭，仅使用 spinLinearDragPerSec。
   */
  spinDragLowSpeedThresholdRadPerSec?: number;
  /**
   * 低速额外阻力（1/s）：停转附近（|ω|→0）在基础 k 上增加，近似 blend·boost；
   * blend 为 |ω| 相对阈值的 smootherstep，避免末段刹车过冲。
   */
  spinDragLowSpeedBoostPerSec?: number;
  /** 蓄力 0 时松手初始角速度 ω（rad/s），默认 0。 */
  spinChargeMinVelocityRadPerSec?: number;
  /** 蓄力满时松手初始角速度 ω（rad/s），默认 11。 */
  spinChargeMaxVelocityRadPerSec?: number;
  /** 蓄力 0 时松手初始角加速度 α（rad/s²），默认 0。 */
  spinChargeMinAccelRadPerSec2?: number;
  /** 蓄力满时松手初始角加速度 α（rad/s²），默认 9。 */
  spinChargeMaxAccelRadPerSec2?: number;
  /**
   * 松手后 α 的指数衰减半衰期（秒）；≤0 时当帧将 α 置 0。
   * 蓄力转化为「初速 + 初加速度」，随后 α 衰减，仅靠阻力减速。
   */
  spinAccelHalfLifeSec?: number;
  /** |ω| 低于该值视为可停转（rad/s），默认 0.06。 */
  spinStopSpeedRadPerSec?: number;
  /** |ω| 持续低于阈值达该时长（秒）后解析扇区，默认 0.085。 */
  spinStopSettleSec?: number;

  /** 干摩擦角加速度（rad/s²），方向与 ω 相反；轻拨时单靠 k·ω 会衰得极慢时可救场。未配置用内置正数；JSON 显式写 0 关闭。 */
  spinDryFrictionAccelRadPerSec2?: number;
  /**
   * 低于该 |ω|（rad/s）时把 weight 势能扭矩按 |ω|/本值 缩小，避免临界角速下被偏置条「顶着」慢转不停。
   * 未配置用内置；显式写 ≤0 关闭此削弱（仍受干摩擦与其它阻力影响）。
   */
  spinWeightBiasCreepRefRadPerSec?: number;

  /**
   * weight 跑道高度场整体强度（rad/s²）。未配置或 ≤0 时用内置常量；只放大/缩小「低谷/高坡」的体感差距，仍不校准为表格概率。
   */
  spinWeightBiasStrengthRadPerSec2?: number;

  /** @deprecated 已由各扇区 weight 自动推导势能偏置；JSON 残留时忽略 */
  spinBiasTorqueRadPerSec2?: number;
  /** @deprecated 已由各扇区 weight 自动推导；JSON 残留时忽略 */
  spinBiasStableAngleDeg?: number;

  /** @deprecated 物理模式下忽略，仅兼容旧 JSON / 编辑器 */
  sectorStopJitterNormalized?: number;
  spinRevolutionsJitterAtFullPower?: number;
  minSpinDurationMs?: number;
  maxSpinDurationMs?: number;
  spinDurationMs?: number;
  minFullSpins?: number;
  maxFullSpins?: number;

  /** 气泡锚点：role 与 `showSpeech(role, …)` 一致；未配置时使用场景内建默认比例。 */
  speechAnchors?: SugarWheelSpeechAnchor[];
  /** 气泡默认停留时长（ms），默认 3000。 */
  speechDurationMs?: number;
  /** 同时可见气泡上限，默认 2。 */
  speechMaxVisible?: number;

  sectors: SugarWheelSectorDef[];

  /** 旋转氛围脚本组；每次抽奖随机（加权）选一组，整次旋转沿用。 */
  atmosphereGroups?: SugarWheelAtmosphereGroup[];
}

// ---------------------------------------------------------------------------
// 旋转氛围脚本
// ---------------------------------------------------------------------------

/** 一组氛围脚本：策划配 N 组，开局随机选一组。 */
export interface SugarWheelAtmosphereGroup {
  id: string;
  label?: string;
  /** 随机选组权重，默认 1。 */
  weight?: number;
  /** 命名文案池，步骤内用 pool 名引用。 */
  vars: Record<string, string[]>;
  /** 四阶段脚本 */
  start?: SugarWheelAtmosphereStep[];
  spinning?: SugarWheelAtmosphereStep[];
  slowing?: SugarWheelAtmosphereStep[];
  stop?: SugarWheelAtmosphereStep[];
}

export type SugarWheelAtmospherePhaseName = 'start' | 'spinning' | 'slowing' | 'stop';

/**
 * 一步指令。`op` 决定行为，其余字段按 op 取值。
 *
 * - `say`  ：让 `role` 说话；文案来自 `pool`（vars 键名）随机抽或 `text` 直写。
 * - `pick` ：从 `pool` 随机取一条写入临时槽位 `slot`（默认 `_line`），后续 `say` 可引用。
 * - `wait` ：暂停 `sec` 秒再跑下一步。
 * - `chance` ：以 `p`（0-1）概率执行 `then` 子步骤列表。
 * - `when_near_sector`：当前指针角在 `sectorId` 扇区 ± `degBuffer` 度内时执行 `then`，否则 `else`。
 */
export interface SugarWheelAtmosphereStep {
  op: 'say' | 'pick' | 'wait' | 'chance' | 'when_near_sector';
  // say
  role?: string;
  text?: string;
  pool?: string;
  durationMs?: number;
  // pick
  slot?: string;
  // wait
  sec?: number;
  // chance
  p?: number;
  // when_near_sector
  sectorId?: string;
  degBuffer?: number;
  // branching
  then?: SugarWheelAtmosphereStep[];
  else?: SugarWheelAtmosphereStep[];
}

/** 糖画转盘小游戏中 `showSpeech` 的气泡屏幕锚点（比例坐标）。 */
export interface SugarWheelSpeechAnchor {
  role: string;
  label?: string;
  xRatio?: number;
  yRatio?: number;
  tailDirection?: 'up' | 'down' | 'none';
}

export interface SugarWheelResult {
  instanceId: string;
  instanceLabel: string;
  sectorId: string;
  sectorLabel: string;
  sectorIndex: number;
  sectorPayload?: Record<string, unknown>;
}
