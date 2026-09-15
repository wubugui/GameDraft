/** 反射光的三个独立倍率。自发光和最终显示曝光不属于它们。 */
export interface LightFactors {
  indirectFactor: number;
  directFactor: number;
  totalFactor: number;
}

/** 场景作者数据：角色/粒子各自一份；色度不与亮度倍率混用。 */
export interface EntityLightResponse extends LightFactors {
  eChroma: number;
}

export function lightChroma(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value)) : fallback;
}

export function resolveLightResponse(
  value: Partial<EntityLightResponse> | undefined,
  fallback: EntityLightResponse,
): EntityLightResponse {
  return { ...resolveLightFactors(value, fallback), eChroma: lightChroma(value?.eChroma, fallback.eChroma) };
}

export const LIGHT_FACTOR_MAX = 64;
export const DEFAULT_LIGHT_FACTORS: Readonly<LightFactors> = Object.freeze({
  indirectFactor: 1, directFactor: 1, totalFactor: 1,
});

export function lightFactor(value: unknown, fallback = 1): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(LIGHT_FACTOR_MAX, value)) : fallback;
}

export function resolveLightFactors(value?: Partial<LightFactors> | null, fallback = DEFAULT_LIGHT_FACTORS): LightFactors {
  return {
    indirectFactor: lightFactor(value?.indirectFactor, fallback.indirectFactor),
    directFactor: lightFactor(value?.directFactor, fallback.directFactor),
    totalFactor: lightFactor(value?.totalFactor, fallback.totalFactor),
  };
}

/** 旧式 alb * (probe * giStrength + lamps) / π * 2^beta 的等价参数。 */
export function legacyLightFactors(beta: number, giStrength: number): LightFactors {
  return { indirectFactor: lightFactor(giStrength), directFactor: 1, totalFactor: Math.pow(2, beta) / Math.PI };
}

export function validSceneLightFactors(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(([kind, factors]) =>
    ['character', 'particles'].includes(kind) && factors && typeof factors === 'object' && !Array.isArray(factors)
    && Object.entries(factors).every(([key, v]) =>
      (key === 'eChroma' || Object.prototype.hasOwnProperty.call(DEFAULT_LIGHT_FACTORS, key))
      && typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= (key === 'eChroma' ? 1 : LIGHT_FACTOR_MAX)));
}
