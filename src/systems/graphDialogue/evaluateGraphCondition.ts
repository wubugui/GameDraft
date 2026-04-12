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

function evalFlagCondition(c: Condition, flagStore: FlagStore): boolean {
  const flag = c.flag;
  const op = c.op ?? '==';
  const left = flagStore.get(flag);
  const right = c.value;

  if (right === undefined) {
    if (op === '!=') return !left;
    return !!left;
  }
  if (typeof right === 'boolean') {
    const lv = !!left;
    if (op === '==') return lv === right;
    if (op === '!=') return lv !== right;
    return false;
  }
  const ln = typeof left === 'number' ? left : Number(left);
  const rn = right as number;
  if (!Number.isFinite(ln) || !Number.isFinite(rn)) return false;
  switch (op) {
    case '==':
      return ln === rn;
    case '!=':
      return ln !== rn;
    case '>':
      return ln > rn;
    case '<':
      return ln < rn;
    case '>=':
      return ln >= rn;
    case '<=':
      return ln <= rn;
    default:
      return false;
  }
}

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
  return evalFlagCondition(c as Condition, flagStore);
}

export function evaluateAllGraphConditions(
  conds: GraphCondition[] | undefined,
  flagStore: FlagStore,
  questManager: QuestManager,
): boolean {
  if (!conds || conds.length === 0) return true;
  return conds.every(c => evaluateGraphCondition(c, flagStore, questManager));
}
