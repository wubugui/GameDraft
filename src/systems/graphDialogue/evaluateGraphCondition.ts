import type { Condition } from '../../data/types';
import type { GraphCondition } from '../../data/types';
import type { QuestManager } from '../QuestManager';
import type { FlagStore } from '../../core/FlagStore';
import { QuestStatus } from '../../data/types';

const questStatusMap: Record<string, QuestStatus> = {
  Inactive: QuestStatus.Inactive,
  Active: QuestStatus.Active,
  Completed: QuestStatus.Completed,
};

/**
 * 图对话 switch / preconditions 与热区、任务等统一走 FlagStore.checkConditions，
 * 避免两套语义（字符串、缺省 value 等）不一致。
 */
export function evaluateGraphCondition(
  c: GraphCondition,
  flagStore: FlagStore,
  questManager: QuestManager,
): boolean {
  const m = c as { quest?: unknown; questStatus?: unknown; status?: unknown };
  if (typeof m.quest === 'string') {
    /** 设计稿示例用 `status`，TS 类型为 `questStatus`，二者等价 */
    const qsRaw = m.questStatus ?? m.status;
    if (typeof qsRaw !== 'string') return false;
    const want = questStatusMap[qsRaw];
    if (want === undefined) return false;
    return questManager.getStatus(m.quest) === want;
  }
  return flagStore.checkConditions([c as Condition]);
}

export function evaluateAllGraphConditions(
  conds: GraphCondition[] | undefined,
  flagStore: FlagStore,
  questManager: QuestManager,
): boolean {
  if (!conds || conds.length === 0) return true;
  return conds.every(c => evaluateGraphCondition(c, flagStore, questManager));
}
