import type { SceneLightEnv } from '../../data/types';

/**
 * 位面（Plane）配置：一份全局注册的数据资产 = 系统配置（下述各槽）+ 独占实体集
 * （由实体/zone 的 `planes?: string[]` 归属字段反向定义，缺省 = 存在于所有位面）。
 *
 * - 任意时刻**恰有一个激活位面**：叙事状态节点以 `activePlane` 点名；无点名时激活 `normal`。
 *   `normal` 是开局默认位面，与其它位面同构（首条固定 `{"id":"normal","label":"常态"}`）。
 * - 激活派生与五槽 apply/revert 由 `PlaneReconciler` 统一调度（对账只派生规则，
 *   过程量——玩家位置/血值/背包——仍归既有存档系统）。
 * - 各槽字段全部可缺省；缺省 = 该槽不施加任何修改（与 normal 等价）。
 *
 * 数据文件：`public/assets/data/planes.json`（PlaneDef 数组）。
 */
export interface PlaneMovementConfig {
  /** 恒定漂移速度 X（世界单位/秒，向量加进位置积分；无输入也被拽走） */
  driftX?: number;
  /** 恒定漂移速度 Y（世界单位/秒） */
  driftY?: number;
  /** 移速系数（乘在场景 walk/run 速度上）；缺省 1 */
  speedScale?: number;
  /** false 时禁止奔跑（Shift/触屏跑被掩蔽）；缺省 true */
  allowRun?: boolean;
}

export interface PlaneInteractionConfig {
  /** false 时禁止拾取（pickup 型热点不出提示、不可触发）；缺省 true */
  canPickup?: boolean;
  /** false 时禁止一切热点交互；缺省 true */
  canInteractHotspots?: boolean;
  /** false 时禁止与 NPC 对话；缺省 true */
  canTalkNpcs?: boolean;
}

export interface PlaneCameraConfig {
  /** 激活期间的相机缩放（仅 Exploring 态应用；离开位面恢复场景默认 zoom） */
  zoom?: number;
}

export interface PlaneDef {
  id: string;
  label?: string;
  movement?: PlaneMovementConfig;
  interaction?: PlaneInteractionConfig;
  camera?: PlaneCameraConfig;
  /** 位面光照档（partial，经 resolveLightEnv 补全；激活期挂起场景 lightEnvCurve） */
  lighting?: SceneLightEnv;
  /** 激活且 Exploring 时每秒扣阳气（经 HealthSystem.damage，可触发死亡系绳） */
  healthDrainPerSec?: number;
}
