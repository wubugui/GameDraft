import schemaJson from '../../data/breathingParams.json';

/**
 * 呼吸图参数表(唯一真相源:src/data/breathingParams.json)。
 * 运行时、呼吸工作台、主编辑器 setBreathingParams 表单都读同一份;这里只做类型化与夹紧。
 */
export interface BreathingParamDef {
  key: string;
  label: string;
  default: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  hint: string;
}

export interface BreathingParamGroup {
  id: string;
  title: string;
  note?: string;
  params: BreathingParamDef[];
}

export type BreathingParams = Record<string, number>;

export const BREATHING_PARAM_GROUPS: readonly BreathingParamGroup[] = (schemaJson as { groups: BreathingParamGroup[] }).groups;

export const BREATHING_PARAM_DEFS: ReadonlyMap<string, BreathingParamDef> = new Map(
  BREATHING_PARAM_GROUPS.flatMap((g) => g.params.map((p) => [p.key, p] as const)),
);

export function defaultBreathingParams(): BreathingParams {
  const out: BreathingParams = {};
  for (const [k, d] of BREATHING_PARAM_DEFS) out[k] = d.default;
  return out;
}

export function clampBreathingParam(key: string, value: number): number {
  const d = BREATHING_PARAM_DEFS.get(key);
  if (!d || !Number.isFinite(value)) return NaN;
  return Math.min(d.max, Math.max(d.min, value));
}

/**
 * 把一份(可能残缺、可能带未知键的)参数表并进 base:未知键与非数值丢弃并返回它们的名字,已知键按范围夹紧。
 */
export function mergeBreathingParams(base: BreathingParams, patch: Record<string, unknown> | undefined | null): { params: BreathingParams; rejected: string[] } {
  const params = { ...base };
  const rejected: string[] = [];
  if (!patch) return { params, rejected };
  for (const [k, raw] of Object.entries(patch)) {
    const v = clampBreathingParam(k, typeof raw === 'number' ? raw : Number.NaN);
    if (Number.isNaN(v)) { rejected.push(k); continue; }
    params[k] = v;
  }
  return { params, rejected };
}
