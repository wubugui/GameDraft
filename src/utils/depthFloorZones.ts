import type { ZoneDef, Condition } from '../data/types';
import type { FlagStore } from '../core/FlagStore';
import { isPointInPolygon, isValidZonePolygon } from './zoneGeometry';
import type { ConditionEvalContext } from '../systems/graphDialogue/evaluateGraphCondition';
import { evaluateConditionExprList } from '../systems/graphDialogue/conditionEvalBridge';

/**
 * 脚底中心 (footWorldX, footWorldY) 落在 depth_floor 区内时，返回应叠加的 floor 偏移。
 * 多区重叠：取 |floorOffsetBoost| 最大的一条的带符号值；并列时保留先遍历到的。
 */
export function resolveDepthFloorOffsetBoost(
  zones: ZoneDef[] | undefined,
  footWorldX: number,
  footWorldY: number,
  flagStore: FlagStore,
  conditionCtx?: ConditionEvalContext,
): number {
  if (!zones?.length) return 0;
  let best: number | null = null;
  let bestAbs = -1;
  for (const z of zones) {
    if (z.zoneKind !== 'depth_floor') continue;
    const raw = z.floorOffsetBoost;
    if (raw === undefined || raw === null || typeof raw !== 'number' || !Number.isFinite(raw)) {
      continue;
    }
    if (z.conditions && z.conditions.length > 0) {
      const ok = conditionCtx
        ? evaluateConditionExprList(z.conditions, conditionCtx)
        : flagStore.checkConditions(z.conditions as Condition[]);
      if (!ok) continue;
    }
    if (!isValidZonePolygon(z.polygon) || !isPointInPolygon(z.polygon, footWorldX, footWorldY)) {
      continue;
    }
    const ab = Math.abs(raw);
    if (ab > bestAbs) {
      bestAbs = ab;
      best = raw;
    }
  }
  return best ?? 0;
}
