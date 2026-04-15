import type { Condition } from '../../data/types';
import type { ConditionExpr } from '../../data/types';
import type { QuestManager } from '../QuestManager';
import type { FlagStore } from '../../core/FlagStore';
import type { ScenarioStateManager } from '../../core/ScenarioStateManager';
import { QuestStatus } from '../../data/types';

/** 单次条件求值的树形追踪（供 Debug 展示） */
export type ConditionTrace =
  | { kind: 'all'; result: boolean; items: ConditionTrace[] }
  | { kind: 'any'; result: boolean; items: ConditionTrace[] }
  | { kind: 'not'; result: boolean; inner: ConditionTrace }
  | { kind: 'flag'; result: boolean; label: string }
  | { kind: 'quest'; result: boolean; label: string }
  | { kind: 'scenario'; result: boolean; label: string }
  | { kind: 'unknown'; result: boolean; label: string };

const questStatusMap: Record<string, QuestStatus> = {
  Inactive: QuestStatus.Inactive,
  Active: QuestStatus.Active,
  Completed: QuestStatus.Completed,
};

/** 防止恶意或误写极深嵌套 */
export const MAX_CONDITION_DEPTH = 32;

export interface ConditionEvalContext {
  flagStore: FlagStore;
  questManager: QuestManager;
  scenarioState: ScenarioStateManager;
}

function isConditionLeaf(x: ConditionExpr): x is Condition {
  return typeof (x as Condition).flag === 'string';
}

function isQuestLeaf(x: ConditionExpr): boolean {
  const m = x as { quest?: unknown; scenario?: unknown };
  return typeof m.quest === 'string' && m.scenario === undefined;
}

function isScenarioLeaf(x: ConditionExpr): x is { scenario: string; phase: string; status: string } {
  const m = x as { scenario?: unknown; phase?: unknown; status?: unknown };
  return typeof m.scenario === 'string' && typeof m.phase === 'string' && typeof m.status === 'string';
}

function isAllNode(x: ConditionExpr): x is { all: ConditionExpr[] } {
  const m = x as { all?: unknown };
  return Array.isArray(m.all);
}

function isAnyNode(x: ConditionExpr): x is { any: ConditionExpr[] } {
  const m = x as { any?: unknown };
  return Array.isArray(m.any);
}

function isNotNode(x: ConditionExpr): x is { not: ConditionExpr } {
  const m = x as { not?: unknown };
  return m.not !== undefined && m.not !== null && typeof m.not === 'object';
}

/**
 * 统一条件求值：图对话、文档揭示等共用。
 */
export function evaluateConditionExpr(
  expr: ConditionExpr,
  ctx: ConditionEvalContext,
  depth = 0,
): boolean {
  if (depth > MAX_CONDITION_DEPTH) {
    console.warn('evaluateConditionExpr: depth exceeded', MAX_CONDITION_DEPTH);
    return false;
  }

  if (isAllNode(expr)) {
    return expr.all.every((e) => evaluateConditionExpr(e, ctx, depth + 1));
  }
  if (isAnyNode(expr)) {
    return expr.any.some((e) => evaluateConditionExpr(e, ctx, depth + 1));
  }
  if (isNotNode(expr)) {
    return !evaluateConditionExpr(expr.not, ctx, depth + 1);
  }

  if (isScenarioLeaf(expr)) {
    if (!ctx.scenarioState.phaseStatusEquals(expr.scenario, expr.phase, expr.status)) return false;
    if (expr.outcome !== undefined && expr.outcome !== null) {
      const got = ctx.scenarioState.getScenarioPhase(expr.scenario, expr.phase)?.outcome;
      return got === expr.outcome;
    }
    return true;
  }

  if (isQuestLeaf(expr)) {
    const m = expr as { quest: string; questStatus?: string; status?: string };
    const qsRaw = m.questStatus ?? m.status;
    if (typeof qsRaw !== 'string') return false;
    const want = questStatusMap[qsRaw];
    if (want === undefined) return false;
    return ctx.questManager.getStatus(m.quest) === want;
  }

  if (isConditionLeaf(expr)) {
    return ctx.flagStore.evalPureFlagConjunction([expr as Condition]);
  }

  console.warn('evaluateConditionExpr: unrecognized shape', expr);
  return false;
}

/**
 * 与 {@link evaluateConditionExpr} 同语义，额外返回树形追踪（仅用于调试展示）。
 */
export function evaluateConditionExprWithTrace(
  expr: ConditionExpr,
  ctx: ConditionEvalContext,
  depth = 0,
): { result: boolean; trace: ConditionTrace } {
  if (depth > MAX_CONDITION_DEPTH) {
    console.warn('evaluateConditionExprWithTrace: depth exceeded', MAX_CONDITION_DEPTH);
    return {
      result: false,
      trace: { kind: 'unknown', result: false, label: `嵌套超过 ${MAX_CONDITION_DEPTH}` },
    };
  }

  if (isAllNode(expr)) {
    const items: ConditionTrace[] = [];
    let ok = true;
    for (const e of expr.all) {
      const r = evaluateConditionExprWithTrace(e, ctx, depth + 1);
      items.push(r.trace);
      if (!r.result) ok = false;
    }
    return { result: ok, trace: { kind: 'all', result: ok, items } };
  }

  if (isAnyNode(expr)) {
    const items: ConditionTrace[] = [];
    let ok = false;
    for (const e of expr.any) {
      const r = evaluateConditionExprWithTrace(e, ctx, depth + 1);
      items.push(r.trace);
      if (r.result) ok = true;
    }
    return { result: ok, trace: { kind: 'any', result: ok, items } };
  }

  if (isNotNode(expr)) {
    const r = evaluateConditionExprWithTrace(expr.not, ctx, depth + 1);
    const result = !r.result;
    return { result, trace: { kind: 'not', result, inner: r.trace } };
  }

  if (isScenarioLeaf(expr)) {
    const cur = ctx.scenarioState.getScenarioPhase(expr.scenario, expr.phase);
    const actualStatus = cur?.status;
    const statusOk = ctx.scenarioState.phaseStatusEquals(expr.scenario, expr.phase, expr.status);
    let label = `scenario「${expr.scenario}」·「${expr.phase}」期望 status=${expr.status}`;
    if (actualStatus === undefined) {
      label += '（当前无记录，按 pending 比较）';
    } else {
      label += `，实际 status=${actualStatus}`;
    }
    if (!statusOk) {
      return { result: false, trace: { kind: 'scenario', result: false, label } };
    }
    if (expr.outcome !== undefined && expr.outcome !== null) {
      const got = cur?.outcome;
      const oOk = got === expr.outcome;
      label += `；期望 outcome=${JSON.stringify(expr.outcome)}实际=${JSON.stringify(got)}`;
      return { result: oOk, trace: { kind: 'scenario', result: oOk, label } };
    }
    return { result: true, trace: { kind: 'scenario', result: true, label } };
  }

  if (isQuestLeaf(expr)) {
    const m = expr as { quest: string; questStatus?: string; status?: string };
    const qsRaw = m.questStatus ?? m.status;
    const want = typeof qsRaw === 'string' ? questStatusMap[qsRaw] : undefined;
    const got = ctx.questManager.getStatus(m.quest);
    let ok = false;
    let label = `quest「${m.quest}」`;
    if (want === undefined) {
      label += `：无效状态字段 ${JSON.stringify(qsRaw)}`;
    } else {
      ok = got === want;
      label += `：期望 ${qsRaw}，实际 ${QuestStatus[got]}`;
    }
    return { result: ok, trace: { kind: 'quest', result: ok, label } };
  }

  if (isConditionLeaf(expr)) {
    const c = expr as Condition;
    const ok = ctx.flagStore.evalPureFlagConjunction([c]);
    const parts = [c.flag, c.op ?? '==', JSON.stringify(c.value)];
    const label = `flag ${parts.join(' ')}`;
    return { result: ok, trace: { kind: 'flag', result: ok, label } };
  }

  console.warn('evaluateConditionExprWithTrace: unrecognized shape', expr);
  return {
    result: false,
    trace: {
      kind: 'unknown',
      result: false,
      label: `无法识别：${JSON.stringify(expr).slice(0, 120)}`,
    },
  };
}

/** 将追踪树格式化为多行文本（Debug 面板） */
export function formatConditionTrace(trace: ConditionTrace, depth = 0): string {
  const pad = '  '.repeat(depth);
  switch (trace.kind) {
    case 'all':
      return [
        `${pad}[all] => ${trace.result}`,
        ...trace.items.map((it) => formatConditionTrace(it, depth + 1)),
      ].join('\n');
    case 'any':
      return [
        `${pad}[any] => ${trace.result}`,
        ...trace.items.map((it) => formatConditionTrace(it, depth + 1)),
      ].join('\n');
    case 'not':
      return [
        `${pad}[not] => ${trace.result}`,
        formatConditionTrace(trace.inner, depth + 1),
      ].join('\n');
    default:
      return `${pad}${trace.label} => ${trace.result}`;
  }
}

/**
 * @deprecated 使用 evaluateConditionExpr
 */
export function evaluateGraphCondition(
  c: ConditionExpr,
  flagStore: FlagStore,
  questManager: QuestManager,
  scenarioState: ScenarioStateManager,
): boolean {
  return evaluateConditionExpr(c, { flagStore, questManager, scenarioState });
}

export function evaluateAllGraphConditions(
  conds: ConditionExpr[] | undefined,
  flagStore: FlagStore,
  questManager: QuestManager,
  scenarioState: ScenarioStateManager,
): boolean {
  if (!conds || conds.length === 0) return true;
  const ctx: ConditionEvalContext = { flagStore, questManager, scenarioState };
  return conds.every((c) => evaluateConditionExpr(c, ctx));
}

/** 图 preconditions（逐项 AND）带追踪：等价于 all(conds) */
export function evaluatePreconditionsWithTrace(
  conds: ConditionExpr[] | undefined,
  ctx: ConditionEvalContext,
): { result: boolean; trace: ConditionTrace } {
  if (!conds || conds.length === 0) {
    return {
      result: true,
      trace: { kind: 'all', result: true, items: [] },
    };
  }
  if (conds.length === 1) {
    return evaluateConditionExprWithTrace(conds[0]!, ctx);
  }
  return evaluateConditionExprWithTrace({ all: conds }, ctx);
}
