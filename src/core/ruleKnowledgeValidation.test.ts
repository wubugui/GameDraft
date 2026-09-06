import { describe, expect, it } from 'vitest';
import { validateRuleKnowledge, type RuleOwnerGraph } from './ruleKnowledgeValidation';
import type { RuleDef, RuleFragmentDef } from '../data/types';
import cases from './fixtures/rule-knowledge-validation.json';

describe('native knowledge authoring contract (shared with Python)', () => {
  for (const input of cases.cases) {
    it(input.name, () => {
      const c = input as { rule?: object; graphs?: RuleOwnerGraph[]; fragments?: RuleFragmentDef[]; errors: string[] };
      expect(validateRuleKnowledge({ ...cases.rule, ...c.rule } as RuleDef,
        c.graphs ?? cases.graphs, c.fragments ?? [])).toEqual(c.errors);
    });
  }
  it('old rules keep their grant mode unless an owner graph is attached', () => {
    const rule = { ...cases.rule } as RuleDef;
    delete rule.narrativeStates;
    expect(validateRuleKnowledge(rule, [])).toEqual([]);
    expect(validateRuleKnowledge(rule, cases.graphs)).toEqual(['rule.mode.missing']);
  });
});
