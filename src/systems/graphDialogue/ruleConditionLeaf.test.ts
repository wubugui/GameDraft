import { describe, expect, it } from 'vitest';
import {
  evaluateConditionExpr,
  evaluateConditionExprWithTrace,
  type ConditionEvalContext,
} from './evaluateGraphCondition';
import type { ConditionExpr, RuleLayerKey } from '../../data/types';

/**
 * rule 叶子契约。
 *
 * 它是「层图 reached/active」的读法糖：掌握 = reached 入口版本（单调），
 * 可信 = 当前 active 版本不是被推翻的那一版。本组测试锁住三件事——
 * 1) mode 缺省是 usable（safe-by-default：被推翻的规矩不再开门）；
 * 2) 漏填 layer 恒 false，不悄悄放行；
 * 3) 未注入 ruleState 时恒 false，且不误伤其它叶子。
 */

type LayerFacts = { known: boolean; usable: boolean; version?: string };

function makeCtx(facts: Record<string, Partial<Record<RuleLayerKey, LayerFacts>>> | null): ConditionEvalContext {
  const base: ConditionEvalContext = {
    flagStore: { evalPureFlagConjunction: () => false } as never,
    questManager: { getStatus: () => 0 } as never,
    scenarioState: {
      phaseStatusEquals: () => false,
      getScenarioPhase: () => undefined,
      getLineLifecycleState: () => 'inactive',
    } as never,
  };
  if (!facts) return base;
  const layerOf = (ruleId: string, layer: RuleLayerKey): LayerFacts | undefined => facts[ruleId]?.[layer];
  return {
    ...base,
    ruleState: {
      isLayerKnown: (r, l) => layerOf(r, l)?.known === true,
      isLayerUsable: (r, l) => layerOf(r, l)?.usable === true,
      isRuleDiscovered: (r) => Object.values(facts[r] ?? {}).some((f) => f?.known === true),
      isRuleAcquired: (r) => {
        const layers = Object.values(facts[r] ?? {});
        return layers.length > 0 && layers.every((f) => f?.known === true);
      },
      getLayerVersion: (r, l) => layerOf(r, l)?.version,
    },
  };
}

/** 干尸才走：象验成可用；理只掌握但已被推翻；术没听说过。 */
const FACTS = {
  rule_dry_corpse: {
    xiang: { known: true, usable: true, version: '验成' },
    li: { known: true, usable: false, version: '推翻' },
  },
} as const;

const ctx = makeCtx(FACTS as never);

describe('rule 条件叶', () => {
  it('mode 缺省 = usable：掌握且未被推翻才放行', () => {
    expect(evaluateConditionExpr({ rule: 'rule_dry_corpse', layer: 'xiang' } as ConditionExpr, ctx)).toBe(true);
    // 理层掌握了，但当前版本被推翻 —— 缺省 usable 必须拦住
    expect(evaluateConditionExpr({ rule: 'rule_dry_corpse', layer: 'li' } as ConditionExpr, ctx)).toBe(false);
  });

  it('mode=known 只问掌握，不问可信度', () => {
    expect(
      evaluateConditionExpr({ rule: 'rule_dry_corpse', layer: 'li', mode: 'known' } as ConditionExpr, ctx),
    ).toBe(true);
  });

  it('mode=acquired 要求每一层都掌握', () => {
    // 干尸才走定义了象+理两层，两层都 known → acquired 成立（不问可信度）
    expect(evaluateConditionExpr({ rule: 'rule_dry_corpse', mode: 'acquired' } as ConditionExpr, ctx)).toBe(true);
    expect(evaluateConditionExpr({ rule: 'rule_never_heard', mode: 'acquired' } as ConditionExpr, ctx)).toBe(false);
  });

  it('mode=discovered 问的是整条规矩听说过没有，可不填 layer', () => {
    expect(evaluateConditionExpr({ rule: 'rule_dry_corpse', mode: 'discovered' } as ConditionExpr, ctx)).toBe(true);
    expect(evaluateConditionExpr({ rule: 'rule_never_heard', mode: 'discovered' } as ConditionExpr, ctx)).toBe(false);
  });

  it('version 另填时额外要求当前生效版本相等', () => {
    expect(
      evaluateConditionExpr({ rule: 'rule_dry_corpse', layer: 'xiang', version: '验成' } as ConditionExpr, ctx),
    ).toBe(true);
    expect(
      evaluateConditionExpr({ rule: 'rule_dry_corpse', layer: 'xiang', version: '存疑' } as ConditionExpr, ctx),
    ).toBe(false);
  });

  it('非 discovered 模式漏填 / 写错 layer 恒 false，不悄悄放行', () => {
    expect(evaluateConditionExpr({ rule: 'rule_dry_corpse' } as ConditionExpr, ctx)).toBe(false);
    expect(evaluateConditionExpr({ rule: 'rule_dry_corpse', layer: 'xyz' } as unknown as ConditionExpr, ctx)).toBe(false);
  });

  it('未注入 ruleState 时恒 false（没有规矩系统 = 什么都没掌握）', () => {
    const bare = makeCtx(null);
    expect(evaluateConditionExpr({ rule: 'rule_dry_corpse', layer: 'xiang' } as ConditionExpr, bare)).toBe(false);
    expect(evaluateConditionExpr({ rule: 'rule_dry_corpse', mode: 'discovered' } as ConditionExpr, bare)).toBe(false);
  });

  it('参与 all / any / not 组合', () => {
    const expr: ConditionExpr = {
      all: [
        { rule: 'rule_dry_corpse', layer: 'xiang' },
        { not: { rule: 'rule_dry_corpse', layer: 'li' } },
      ],
    } as ConditionExpr;
    expect(evaluateConditionExpr(expr, ctx)).toBe(true);
  });

  it('不劫持其它叶子：带 flag / narrative / plane 的对象仍走各自分支', () => {
    // 这些对象即使带了 rule 字段也不该被当成规矩叶（守卫互斥）
    const planeCtx: ConditionEvalContext = { ...ctx, getActivePlaneId: () => '背尸' };
    expect(evaluateConditionExpr({ plane: '背尸' } as ConditionExpr, planeCtx)).toBe(true);
    expect(evaluateConditionExpr({ plane: 'normal' } as ConditionExpr, planeCtx)).toBe(false);
  });

  it('trace 版结果与非 trace 版一致，且给出可读 label', () => {
    const expr = { rule: 'rule_dry_corpse', layer: 'li', mode: 'usable' } as ConditionExpr;
    const plain = evaluateConditionExpr(expr, ctx);
    const traced = evaluateConditionExprWithTrace(expr, ctx);
    expect(traced.result).toBe(plain);
    expect(traced.trace.kind).toBe('rule');
    expect(traced.trace.kind === 'rule' && traced.trace.label).toContain('rule_dry_corpse');
    expect(traced.trace.kind === 'rule' && traced.trace.label).toContain('推翻');
  });
});
