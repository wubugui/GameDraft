import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { evaluateConditionExprWithTrace, type ConditionEvalContext } from '../../src/systems/graphDialogue/evaluateGraphCondition';
import { QuestStatus, type Condition, type ConditionExpr } from '../../src/data/types';
import { compareFlagOrder, looseEqualFlag } from '../../src/core/flagComparison';

type Json = Record<string, any>;

function readJson(path: string): any {
  return JSON.parse(readFileSync(resolve(path), 'utf8').replace(/^\uFEFF/, ''));
}

function questStatus(raw: any): QuestStatus {
  if (raw === QuestStatus.Active || raw === 'Active' || raw === 'active') return QuestStatus.Active;
  if (raw === QuestStatus.Completed || raw === 'Completed' || raw === 'completed') return QuestStatus.Completed;
  return QuestStatus.Inactive;
}

function conditionContext(state: Json): ConditionEvalContext {
  const flags = state.flags && typeof state.flags === 'object' ? state.flags : {};
  const quests = state.quests && typeof state.quests === 'object' ? state.quests : {};
  const scenarios = state.scenarios && typeof state.scenarios === 'object' ? state.scenarios : {};
  const scenarioLines = state.scenarioLines && typeof state.scenarioLines === 'object' ? state.scenarioLines : {};
  const narrative = state.narrative && typeof state.narrative === 'object' ? state.narrative : {};
  return {
    flagStore: {
      evalPureFlagConjunction(conditions: Condition[]): boolean {
        for (const cond of conditions) {
          const expected = cond.value === undefined || cond.value === null ? true : cond.value;
          const raw = flags[cond.flag];
          const actual = raw !== undefined ? raw : typeof expected === 'boolean' ? false : typeof expected === 'number' ? 0 : '';
          const op = cond.op ?? '==';
          if (op === '==' && !looseEqualFlag(actual, expected)) return false;
          if (op === '!=' && looseEqualFlag(actual, expected)) return false;
          if ((op === '>' || op === '<' || op === '>=' || op === '<=') && !compareFlagOrder(actual, expected, op)) return false;
        }
        return true;
      },
    } as any,
    questManager: {
      getStatus(id: string): QuestStatus {
        return questStatus(quests[id]);
      },
    } as any,
    scenarioState: {
      phaseStatusEquals(scenario: string, phase: string, status: string): boolean {
        return scenarios?.[scenario]?.[phase]?.status === status;
      },
      getScenarioPhase(scenario: string, phase: string): any {
        return scenarios?.[scenario]?.[phase];
      },
      getLineLifecycleState(id: string): any {
        return scenarioLines[id] ?? 'inactive';
      },
    } as any,
    narrativeState: {
      getActiveState(id: string): string | undefined {
        return narrative[id];
      },
      isStateActive(id: string, stateId: string): boolean {
        return narrative[id] === stateId;
      },
    },
    resolveConditionLiteral(raw: string): string {
      return String(state.literals?.[raw] ?? raw);
    },
  };
}

function sourceFor(runtimeRef: string, sourceMap: Json): any {
  const sourceId = sourceMap.runtimeToSource?.[runtimeRef];
  return sourceId ? { sourceId, ...(sourceMap.sources?.[sourceId] ?? {}) } : null;
}

function pushCondition(out: any[], runtimeRef: string, expr: ConditionExpr[] | ConditionExpr | undefined, state: Json, sourceMap: Json): void {
  if (!expr || (Array.isArray(expr) && expr.length === 0)) return;
  const wrapped = Array.isArray(expr) ? ({ all: expr } as ConditionExpr) : expr;
  const evaluated = evaluateConditionExprWithTrace(wrapped, conditionContext(state));
  out.push({ runtimeRef, source: sourceFor(runtimeRef, sourceMap), result: evaluated.result, trace: evaluated.trace });
}

const [runtimeRootPath, statePath, sourceMapPath, outPath] = process.argv.slice(2);
if (!runtimeRootPath || !statePath || !sourceMapPath || !outPath) {
  throw new Error('usage: tsx explain_runtime.ts <runtime_preview_root> <state.json> <source_map.json> <out.json>');
}

const root = resolve(runtimeRootPath);
const state = readJson(statePath);
const sourceMap = readJson(sourceMapPath);
const quests = readJson(resolve(root, 'public/assets/data/quests.json')) as any[];
const narrative = readJson(resolve(root, 'public/assets/data/narrative_graphs.json'));

const conditions: any[] = [];
for (const q of quests) {
  pushCondition(conditions, `quest:${q.id}.preconditions`, q.preconditions, state, sourceMap);
  pushCondition(conditions, `quest:${q.id}.completionConditions`, q.completionConditions, state, sourceMap);
  for (const edge of q.nextQuests ?? []) {
    pushCondition(conditions, `quest:${q.id}.nextQuest:${edge.questId}.conditions`, edge.conditions, state, sourceMap);
  }
}

for (const comp of narrative.compositions ?? []) {
  const graph = comp.mainGraph ?? {};
  for (const transition of graph.transitions ?? []) {
    pushCondition(conditions, `narrative:${graph.id}.transition:${transition.id}.conditions`, transition.conditions, state, sourceMap);
  }
}

const result = { ok: true, conditions };
writeFileSync(resolve(outPath), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(result, null, 2));
