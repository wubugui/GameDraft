import type { Condition, ScenarioLineConditionLeaf } from '../../data/types';
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
  | { kind: 'scenarioLine'; result: boolean; label: string }
  | { kind: 'narrative'; result: boolean; label: string }
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
  narrativeState?: {
    getActiveState(graphId: string): string | undefined;
    isStateActive(graphId: string, stateId: string): boolean;
    /** 到达过（含当前；initialState 视为到达过）。未注入时 reached 条件退化为 isStateActive。 */
    hasReachedState?(graphId: string, stateId: string): boolean;
    getGraph?(graphId: string): { id: string; ownerType?: string; ownerId?: string } | undefined;
    getGraphIdsByOwner?(ownerType: string, ownerId: string): string[];
    getPrimaryGraphByOwner?(ownerType: string, ownerId: string): { id: string } | undefined;
    getPrimaryActiveStateByOwner?(ownerType: string, ownerId: string): string | undefined;
    isOwnerStateActive?(ownerType: string, ownerId: string, stateId: string): boolean;
  };
  /**
   * Flag 条件叶子中 `value` 为 string 时，比较前调用（与 resolveDisplayText 一致，支持 [tag:…]）。
   * 未注入则按字面量字符串与当前 Flag 值比较。
   */
  resolveConditionLiteral?: (raw: string) => string;
  /** 当前叙事 owner：供 narrative 叶子的 `@owner` token 解析为该 owner 的主 wrapper 图。 */
  currentOwner?: { ownerType: string; ownerId: string };
  /** 当前场景 id：供 narrative 叶子的 `@scene` token 解析为 `scene:<id>` wrapper 图。 */
  currentSceneId?: string;
}

/**
 * narrative 叶子的 `narrative` 字段支持相对 token：
 * - `@owner` → 当前 owner（{@link ConditionEvalContext.currentOwner}）的主 wrapper graphId
 * - `@scene` → 当前场景（{@link ConditionEvalContext.currentSceneId}）的 `scene` wrapper graphId
 * 普通字符串原样返回。解析失败返回空串（调用方按"缺图"优雅处理）。
 */
export function resolveNarrativeGraphRef(token: string, ctx: ConditionEvalContext): string {
  const raw = String(token ?? '').trim();
  if (!raw.startsWith('@')) return raw;
  const ns = ctx.narrativeState;
  if (raw === '@owner') {
    const owner = ctx.currentOwner;
    if (!owner?.ownerType || !owner?.ownerId || !ns?.getPrimaryGraphByOwner) return '';
    return ns.getPrimaryGraphByOwner(owner.ownerType, owner.ownerId)?.id ?? '';
  }
  if (raw === '@scene') {
    const sceneId = String(ctx.currentSceneId ?? '').trim();
    if (!sceneId || !ns?.getPrimaryGraphByOwner) return '';
    return ns.getPrimaryGraphByOwner('scene', sceneId)?.id ?? '';
  }
  return '';
}

function isConditionLeaf(x: ConditionExpr): x is Condition {
  return typeof (x as Condition).flag === 'string';
}

function isQuestLeaf(x: ConditionExpr): boolean {
  const m = x as { quest?: unknown; scenario?: unknown };
  return typeof m.quest === 'string' && m.scenario === undefined;
}

function isScenarioLeaf(x: ConditionExpr): x is { scenario: string; phase: string; status: string } {
  const m = x as { scenario?: unknown; phase?: unknown; status?: unknown; scenarioLine?: unknown };
  if (typeof m.scenarioLine === 'string') return false;
  return typeof m.scenario === 'string' && typeof m.phase === 'string' && typeof m.status === 'string';
}

const SCENARIO_LINE_STATUSES = new Set<ScenarioLineConditionLeaf['lineStatus']>([
  'inactive',
  'active',
  'completed',
]);

function isScenarioLineLeaf(x: ConditionExpr): x is ScenarioLineConditionLeaf {
  const m = x as { scenarioLine?: unknown; lineStatus?: unknown; flag?: unknown; quest?: unknown };
  if (
    typeof m.scenarioLine !== 'string' ||
    typeof m.lineStatus !== 'string' ||
    typeof m.flag === 'string' ||
    m.quest !== undefined
  ) {
    return false;
  }
  return SCENARIO_LINE_STATUSES.has(m.lineStatus as ScenarioLineConditionLeaf['lineStatus']);
}

function isNarrativeStateLeaf(x: ConditionExpr): x is { narrative: string; state: string } {
  const m = x as { narrative?: unknown; state?: unknown; flag?: unknown; quest?: unknown; scenario?: unknown };
  return (
    typeof m.narrative === 'string' &&
    typeof m.state === 'string' &&
    typeof m.flag !== 'string' &&
    m.quest === undefined &&
    m.scenario === undefined
  );
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

function applyResolvedFlagConditionValue(c: Condition, ctx: ConditionEvalContext): Condition {
  if (typeof c.value !== 'string' || !ctx.resolveConditionLiteral) return c;
  const resolved = ctx.resolveConditionLiteral(c.value);
  return { ...c, value: resolved };
}

// ============================================================
// 叶子求值单一实现：trace / 非 trace 两版共用，杜绝语义漂移
//（trace 版只在其上组装 label；结果一律取自下面这组函数）。
// 非 trace 路径是每帧热路径：本组函数不得引入每次求值的字符串/对象分配。
// ============================================================

function evalScenarioLeaf(
  expr: { scenario: string; phase: string; status: string; outcome?: string | number | boolean | null },
  ctx: ConditionEvalContext,
): boolean {
  if (!ctx.scenarioState.phaseStatusEquals(expr.scenario, expr.phase, expr.status)) return false;
  if (expr.outcome !== undefined && expr.outcome !== null) {
    return ctx.scenarioState.getScenarioPhase(expr.scenario, expr.phase)?.outcome === expr.outcome;
  }
  return true;
}

function evalScenarioLineLeaf(expr: ScenarioLineConditionLeaf, ctx: ConditionEvalContext): boolean {
  const sid = expr.scenarioLine.trim();
  return sid ? ctx.scenarioState.getLineLifecycleState(sid) === expr.lineStatus : false;
}

/** graphId / stateId 由调用方解析（trace 版还要用它们拼 label，避免重复解析）。 */
function evalNarrativeLeaf(
  graphId: string,
  stateId: string,
  reached: boolean,
  ctx: ConditionEvalContext,
): boolean {
  const ns = ctx.narrativeState;
  if (!graphId || !stateId || !ns) return false;
  if (reached) {
    if (typeof ns.hasReachedState === 'function') {
      return ns.hasReachedState(graphId, stateId);
    }
    return ns.isStateActive(graphId, stateId);
  }
  return ns.isStateActive(graphId, stateId);
}

function narrativeLeafReached(expr: ConditionExpr): boolean {
  return (expr as { reached?: unknown }).reached === true;
}

function evalQuestLeaf(quest: string, qsRaw: unknown, ctx: ConditionEvalContext): boolean {
  if (typeof qsRaw !== 'string') return false;
  const want = questStatusMap[qsRaw];
  if (want === undefined) return false;
  return ctx.questManager.getStatus(quest) === want;
}

function evalFlagLeaf(expr: Condition, ctx: ConditionEvalContext): boolean {
  const c = applyResolvedFlagConditionValue(expr, ctx);
  return ctx.flagStore.evalPureFlagConjunction([c]);
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
    return evalScenarioLeaf(expr, ctx);
  }

  if (isScenarioLineLeaf(expr)) {
    return evalScenarioLineLeaf(expr, ctx);
  }

  if (isNarrativeStateLeaf(expr)) {
    const graphId = resolveNarrativeGraphRef(expr.narrative, ctx);
    const stateId = expr.state.trim();
    return evalNarrativeLeaf(graphId, stateId, narrativeLeafReached(expr), ctx);
  }

  if (isQuestLeaf(expr)) {
    const m = expr as { quest: string; questStatus?: string; status?: string };
    return evalQuestLeaf(m.quest, m.questStatus ?? m.status, ctx);
  }

  if (isConditionLeaf(expr)) {
    return evalFlagLeaf(expr as Condition, ctx);
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
    const ok = evalScenarioLeaf(expr, ctx);
    const cur = ctx.scenarioState.getScenarioPhase(expr.scenario, expr.phase);
    const actualStatus = cur?.status;
    let label = `scenario「${expr.scenario}」·「${expr.phase}」期望 status=${expr.status}`;
    if (actualStatus === undefined) {
      label += '（当前无记录，按 pending 比较）';
    } else {
      label += `，实际 status=${actualStatus}`;
    }
    if (expr.outcome !== undefined && expr.outcome !== null) {
      label += `；期望 outcome=${JSON.stringify(expr.outcome)}实际=${JSON.stringify(cur?.outcome)}`;
    }
    return { result: ok, trace: { kind: 'scenario', result: ok, label } };
  }

  if (isScenarioLineLeaf(expr)) {
    const ok = evalScenarioLineLeaf(expr, ctx);
    const sid = expr.scenarioLine.trim();
    const got = sid ? ctx.scenarioState.getLineLifecycleState(sid) : 'inactive';
    const label = `scenarioLine「${expr.scenarioLine}」期望=${expr.lineStatus}实际=${got}`;
    return { result: ok, trace: { kind: 'scenarioLine', result: ok, label } };
  }

  if (isNarrativeStateLeaf(expr)) {
    const graphId = resolveNarrativeGraphRef(expr.narrative, ctx);
    const stateId = expr.state.trim();
    const reached = narrativeLeafReached(expr);
    const ok = evalNarrativeLeaf(graphId, stateId, reached, ctx);
    const got = graphId ? ctx.narrativeState?.getActiveState(graphId) : undefined;
    const ref = expr.narrative.trim().startsWith('@') ? `${expr.narrative.trim()}→${graphId || '—'}` : expr.narrative;
    const label = reached
      ? `narrative「${ref}」期望 reached=${stateId || '—'}，当前=${got ?? '—'}`
      : `narrative「${ref}」期望=${stateId || '—'}实际=${got ?? '—'}`;
    return { result: ok, trace: { kind: 'narrative', result: ok, label } };
  }

  if (isQuestLeaf(expr)) {
    const m = expr as { quest: string; questStatus?: string; status?: string };
    const qsRaw = m.questStatus ?? m.status;
    const ok = evalQuestLeaf(m.quest, qsRaw, ctx);
    const want = typeof qsRaw === 'string' ? questStatusMap[qsRaw] : undefined;
    const got = ctx.questManager.getStatus(m.quest);
    let label = `quest「${m.quest}」`;
    if (want === undefined) {
      label += `：无效状态字段 ${JSON.stringify(qsRaw)}`;
    } else {
      label += `：期望 ${qsRaw}，实际 ${QuestStatus[got]}`;
    }
    return { result: ok, trace: { kind: 'quest', result: ok, label } };
  }

  if (isConditionLeaf(expr)) {
    const ok = evalFlagLeaf(expr as Condition, ctx);
    const orig = expr as Condition;
    const parts = [orig.flag, orig.op ?? '==', JSON.stringify(orig.value)];
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
