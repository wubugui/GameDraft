/** 夜间生存的共享数据契约；UI、运行时、编辑器镜像均以此语义为准。 */
import type { ConditionExpr } from './types';

export type HealthDamageKind = 'yin' | 'fright';

/** 一个有效防护来源。一个 id 只结算一次，多来源减伤按剩余伤害相乘。 */
export interface HealthProtection {
  id: string;
  maxHealthBonus?: number;
  /** 0 不减伤，1 完全防护；不写 kinds / threatIds 表示不限。 */
  reduction?: number;
  kinds?: HealthDamageKind[];
  threatIds?: string[];
}

/** 主动防护的剩余时间走游戏时钟；同 id 重用会刷新，不按使用次数叠乘。 */
export interface TimedHealthProtection extends HealthProtection {
  remainingSeconds: number;
}

export interface HealthDamage {
  amount: number;
  kind: HealthDamageKind;
  /** 内容来源，供防护匹配、调试和死亡说明，不硬编码 NPC / 场景。 */
  sourceId: string;
  deathNoteId?: string;
}

/** 临时限制约束当前值，不改永久上限。scene 限制由换场入口释放。 */
export interface HealthBounds {
  id: string;
  min?: number;
  max?: number;
  scope?: 'scene' | 'persistent';
}

export interface HealthDamageResult {
  requested: number;
  afterProtection: number;
  applied: number;
  depleted: boolean;
  protectionIds: string[];
}

export interface HealthDepletion extends HealthDamage {
  result: HealthDamageResult;
}

/** 文案与首次死亡卡均由策划配置；实际恢复复用完整存档链路。 */
export interface RetryConfig {
  title?: string;
  retryText?: string;
  menuText?: string;
  failedText?: string;
  firstDeathNoteId?: string;
}

/** 只认策划指定的火，不从灯光亮度推断安全。 */
export interface FireProtectionConfig {
  heldPropIds?: string[];
  /** 平滑火焰闪烁的短暂缺帧，秒。取下火把或离开范围立即失效。 */
  lossGraceSeconds?: number;
}

/** 环境保护火挂在热点上；默认必须由燃烧系统确认仍有明火。 */
export interface FireProtectionDef {
  radius: number;
  requiresBurning?: boolean;
  conditions?: ConditionExpr[];
}

/** 挂在 NPC / 热点上的持续威胁；距离使用与场景交互相同的地面坐标单位。 */
export interface HealthThreatDef {
  /** 全工程唯一，供特定护身物与调试引用；不依赖实体显示名。 */
  id: string;
  kind: HealthDamageKind;
  /** 进入此范围意味着过界；yin 才请求显示三把火。 */
  boundaryRadius: number;
  damageRadius: number;
  attackPerSecond: number;
  /** 近身后改用更强的一档，仍为数值结算，不硬编码死亡。 */
  nearRadius?: number;
  nearAttackPerSecond?: number;
  /** 普通阴间实体遇有效火源一定退避；特殊实体须显式写 ignore。 */
  fireResponse?: 'repelled' | 'ignore';
  nightOnly?: boolean;
  affectsWhenHidden?: boolean;
  /** 受控教学可在演出中展示真实损耗；普通威胁在演出期间暂停。 */
  duringPresentation?: boolean;
  conditions?: ConditionExpr[];
  deathNoteId?: string;
  enteredSignal?: string;
  repelledSignal?: string;
  leftSignal?: string;
  /** 范围内的存在声；被火驱退/退出范围立即停止发新声。 */
  presenceSfx?: string;
  soundInterval?: number;
  /** 写了即把声源放在玩家行进方向后方（场景单位）；不写用实体位置。 */
  soundBehindPlayer?: number;
  soundOnlyMoving?: boolean;
  soundVolume?: number;
}

/** Fractional damage stays fractional: frame rate must not change survivability. */
export function resolveHealthDamage(
  damage: HealthDamage,
  protections: readonly HealthProtection[],
): { amount: number; protectionIds: string[] } {
  let amount = Number.isFinite(damage.amount) ? Math.max(0, damage.amount) : 0;
  const protectionIds: string[] = [];
  const seen = new Set<string>();
  for (const p of protections) {
    if (!p.id || seen.has(p.id)) continue;
    seen.add(p.id);
    if (Array.isArray(p.kinds) && p.kinds.length && !p.kinds.includes(damage.kind)) continue;
    if (Array.isArray(p.threatIds) && p.threatIds.length && !p.threatIds.includes(damage.sourceId)) continue;
    const reduction = Number.isFinite(p.reduction) ? Math.max(0, Math.min(1, p.reduction!)) : 0;
    if (reduction <= 0) continue;
    amount *= 1 - reduction;
    protectionIds.push(p.id);
  }
  return { amount, protectionIds };
}

export function protectionHealthBonus(protections: readonly HealthProtection[]): number {
  const seen = new Set<string>();
  let bonus = 0;
  for (const p of protections) {
    if (!p.id || seen.has(p.id)) continue;
    seen.add(p.id);
    if (Number.isFinite(p.maxHealthBonus)) bonus += Math.max(0, p.maxHealthBonus!);
  }
  return bonus;
}
