/** 与编辑器 health_validation.health_action_errors 同口径。 */
export function healthActionErrors(kind: string, p: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const number = (v: unknown, positive = false, max = Infinity): v is number =>
    typeof v === 'number' && Number.isFinite(v) && (positive ? v > 0 : v >= 0) && v <= max;
  const name = (v: unknown) => typeof v === 'string' && !!v.trim();
  if (['lockHealth', 'unlockHealth', 'applyHealthProtection', 'removeHealthProtection', 'setRetryCheckpoint'].includes(kind)
    && !name(p.id)) errors.push('id 必须是非空名称');
  if (['setMaxHealth', 'inflictHealthDamage'].includes(kind) && !number(p.amount, kind === 'setMaxHealth')) errors.push('amount 数值非法');
  if (kind === 'lockHealth') {
    if (!('min' in p) && !('max' in p)) errors.push('至少指定 min 或 max');
    for (const key of ['min', 'max']) if (key in p && !number(p[key])) errors.push(`${key} 须为非负有限数`);
    if (number(p.min) && number(p.max) && p.min > p.max) errors.push('min 不得大于 max');
    if ('scope' in p && (typeof p.scope !== 'string' || !['', 'scene', 'persistent'].includes(p.scope))) errors.push('scope 只能为 scene 或 persistent');
  }
  if (kind === 'inflictHealthDamage') {
    if (typeof p.kind !== 'string' || !['yin', 'fright'].includes(p.kind)) errors.push('kind 须为 yin 或 fright');
    if (!name(p.sourceId)) errors.push('sourceId 须为非空伤害来源名称');
  }
  if (kind === 'applyHealthProtection') {
    if (!number(p.seconds, true)) errors.push('seconds 须为正有限数');
    if ('reduction' in p && !number(p.reduction, false, 1)) errors.push('reduction 须在 0 到 1 之间');
    if ('maxHealthBonus' in p && !number(p.maxHealthBonus)) errors.push('maxHealthBonus 须为非负有限数');
    if ('kind' in p && (typeof p.kind !== 'string' || !['', 'yin', 'fright'].includes(p.kind))) errors.push('kind 只能为 yin、fright 或留空');
  }
  return errors;
}
