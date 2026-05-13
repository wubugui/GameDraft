import type { Condition, ConditionExpr } from '../../data/types';
import { evaluateConditionExpr, type ConditionEvalContext } from './evaluateGraphCondition';

/**
 * 热区、区域、任务、遭遇、地图等：条件列表语义为组内 AND，与旧 `Condition[]` 一致。
 * 每项须为合法 `ConditionExpr`（纯 flag 的 `Condition` 是合法叶子）。
 */
export function evaluateConditionExprList(
  conditions: ConditionExpr[] | Condition[] | undefined | null,
  ctx: ConditionEvalContext,
): boolean {
  if (!conditions || conditions.length === 0) return true;
  for (const c of conditions) {
    if (!evaluateConditionExpr(c as ConditionExpr, ctx)) return false;
  }
  return true;
}
