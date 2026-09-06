"""Mirror of src/core/ruleKnowledgeValidation.ts; shared-case tests enforce parity."""


def validate_rule_knowledge(rule, graphs, fragments=()):
    owned = [g for g in graphs if g.get('ownerType') == 'rule' and g.get('ownerId') == rule.get('id')]
    if 'narrativeStates' not in rule:
        return ['rule.mode.missing'] if owned else []
    variants = rule['narrativeStates']
    if not isinstance(variants, dict) or not variants:
        return ['rule.states.invalid']
    errors = []
    if len(owned) != 1:
        errors.append('rule.owner.count')
    if any(g.get('run') is not None for g in owned):
        errors.append('rule.owner.repeatable')
    if any(f.get('ruleId') == rule.get('id') for f in fragments):
        errors.append('rule.fragments.mixed')
    states = list(owned[0].get('states', {})) if len(owned) == 1 else []
    for state in states:
        if state not in variants:
            errors.append(f'rule.state.missing:{state}')
    for state, variant in variants.items():
        if len(owned) == 1 and state not in states:
            errors.append(f'rule.state.unknown:{state}')
        if not isinstance(variant, dict) or not isinstance(variant.get('layers'), dict):
            errors.append(f'rule.layers.invalid:{state}')
            continue
        for layer, body in variant['layers'].items():
            if layer not in ('xiang', 'li', 'shu') or layer not in (rule.get('layers') or {}):
                errors.append(f'rule.layer.undefined:{state}:{layer}')
            if not isinstance(body, dict) or not isinstance(body.get('text'), str) or not body['text'].strip():
                errors.append(f'rule.text.empty:{state}:{layer}')
            if isinstance(body, dict) and 'verified' in body and body['verified'] not in ('unverified', 'effective', 'questionable'):
                errors.append(f'rule.verified.invalid:{state}:{layer}')
    return errors
