import type { RuleDef, RuleFragmentDef } from '../data/types';

export interface RuleOwnerGraph {
  id: string;
  ownerType: string;
  ownerId?: string;
  states: Record<string, unknown>;
  run?: unknown;
}

/** Authoritative rule projection checks; Python mirrors these codes with shared cases. */
export function validateRuleKnowledge(
  rule: RuleDef, graphs: RuleOwnerGraph[], fragments: RuleFragmentDef[] = [],
): string[] {
  const owned = graphs.filter(g => g.ownerType === 'rule' && g.ownerId === rule.id);
  if (rule.narrativeStates === undefined) return owned.length ? ['rule.mode.missing'] : [];
  const errors: string[] = [];
  const variants = rule.narrativeStates;
  if (!variants || typeof variants !== 'object' || Array.isArray(variants) || !Object.keys(variants).length) {
    return ['rule.states.invalid'];
  }
  if (owned.length !== 1) errors.push('rule.owner.count');
  if (owned.some(g => g.run !== undefined && g.run !== null)) errors.push('rule.owner.repeatable');
  if (fragments.some(f => f.ruleId === rule.id)) errors.push('rule.fragments.mixed');
  const states = owned.length === 1 ? Object.keys(owned[0]!.states) : [];
  for (const state of states) {
    if (!(state in variants)) errors.push(`rule.state.missing:${state}`);
  }
  for (const [state, variant] of Object.entries(variants)) {
    if (owned.length === 1 && !states.includes(state)) errors.push(`rule.state.unknown:${state}`);
    if (!variant || typeof variant.layers !== 'object' || !variant.layers || Array.isArray(variant.layers)) {
      errors.push(`rule.layers.invalid:${state}`);
      continue;
    }
    for (const [layer, body] of Object.entries(variant.layers)) {
      if (!['xiang', 'li', 'shu'].includes(layer) || !Object.prototype.hasOwnProperty.call(rule.layers ?? {}, layer)) {
        errors.push(`rule.layer.undefined:${state}:${layer}`);
      }
      if (!body || typeof body.text !== 'string' || !body.text.trim()) errors.push(`rule.text.empty:${state}:${layer}`);
      if (body?.verified !== undefined && !['unverified', 'effective', 'questionable'].includes(body.verified)) {
        errors.push(`rule.verified.invalid:${state}:${layer}`);
      }
    }
  }
  return errors;
}
