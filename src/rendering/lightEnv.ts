import type { RgbColor, SceneLightEnv, EntityLightingConfig, ShadowMode } from '../data/types';

/**
 * 解析后的光照环境：把可缺省的 SceneLightEnv（场景 → 全局默认 → 内置基线）
 * 归一化为全部字段都为具体数值的结构，供滤镜与阴影直接消费。
 *
 * 约定：
 * - key.azimuthDeg 为「光来向」（屏幕平面，0=右、逆时针为正）；阴影朝其反方向投。
 * - key.elevationDeg 越低，阴影越长（length = cot(elev)，夹在合理区间）。
 * - 颜色为 0..1 线性近似，色调融入只用其色度（保亮度白平衡）。
 */
export interface ResolvedLightEnv {
  key: { azimuthDeg: number; elevationDeg: number; color: RgbColor; intensity: number };
  ambient: { color: RgbColor; intensity: number };
  shadow: {
    mode: ShadowMode;
    enabled: boolean; darkness: number; softness: number; length: number; skewX: number;
    contact: number; contactSize: number; drape: number; drapeEnabled: boolean;
    softSamples: number; softRadius: number; billboard: 'light' | 'camera';
  };
  toneStrength: number;
  /** 色调融入开关（与 shadow.mode 解耦） */
  toneEnabled: boolean;
  ao: { contact: number; form: number };
}

/** 内置基线：无任何配置时也能产出合理的接地阴影 + 轻微色调融入。 */
const BASELINE: ResolvedLightEnv = {
  key: { azimuthDeg: 125, elevationDeg: 55, color: [1.0, 0.97, 0.92], intensity: 1.0 },
  ambient: { color: [0.55, 0.6, 0.72], intensity: 1.0 },
  shadow: {
    mode: 'real',
    enabled: true, darkness: 0.4, softness: 1.0, length: 0, skewX: 0,
    contact: 0.5, contactSize: 1.0, drape: 0.6, drapeEnabled: true,
    softSamples: 1, softRadius: 0.05, billboard: 'light',
  },
  toneStrength: 0.45,
  toneEnabled: true,
  ao: { contact: 0.45, form: 0.25 },
};

const DEG2RAD = Math.PI / 180;

function num(v: number | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function color(v: RgbColor | undefined, fallback: RgbColor): RgbColor {
  if (!Array.isArray(v) || v.length < 3) return fallback;
  const c = (i: number): number => {
    const x = Number(v[i]);
    return Number.isFinite(x) ? Math.max(0, Math.min(4, x)) : fallback[i];
  };
  return [c(0), c(1), c(2)];
}

/** 由仰角推导阴影长度（相对角色高度），夹在 [0.3, 1.6]。 */
function lengthFromElevation(elevDeg: number): number {
  const e = Math.max(8, Math.min(85, elevDeg)) * DEG2RAD;
  const cot = Math.cos(e) / Math.max(Math.sin(e), 1e-3);
  return Math.max(0.3, Math.min(1.6, cot));
}

/**
 * 由方位角推导阴影水平倾斜（弧度）。光来向的水平分量为 cos(az)，阴影朝反方向倾，
 * 故 skewX 取 -cos(az) 乘一个适中系数。仰角越低，水平投影越夸张，故再乘 length 的温和函数。
 */
function skewFromKey(azDeg: number, length: number): number {
  const az = azDeg * DEG2RAD;
  const horiz = -Math.cos(az); // [-1,1]
  const lenBoost = 0.5 + 0.5 * Math.min(1, length); // 0.65~1.3 区间
  return Math.max(-1.1, Math.min(1.1, horiz * 0.6 * lenBoost));
}

/** 合并三层（base < global < scene），返回全字段具体的解析结果。 */
function mergeOne(base: ResolvedLightEnv, src: SceneLightEnv | undefined): ResolvedLightEnv {
  if (!src) return base;
  const azimuthDeg = num(src.key?.azimuthDeg, base.key.azimuthDeg);
  const elevationDeg = num(src.key?.elevationDeg, base.key.elevationDeg);
  const length = num(src.shadow?.length, lengthFromElevation(elevationDeg));
  const skewX = num(src.shadow?.skewX, skewFromKey(azimuthDeg, length));
  return {
    key: {
      azimuthDeg,
      elevationDeg,
      color: color(src.key?.color, base.key.color),
      intensity: num(src.key?.intensity, base.key.intensity),
    },
    ambient: {
      color: color(src.ambient?.color, base.ambient.color),
      intensity: num(src.ambient?.intensity, base.ambient.intensity),
    },
    shadow: {
      mode: src.shadow?.mode ?? base.shadow.mode,
      enabled: src.shadow?.enabled ?? base.shadow.enabled,
      darkness: Math.max(0, Math.min(1, num(src.shadow?.darkness, base.shadow.darkness))),
      softness: Math.max(0, num(src.shadow?.softness, base.shadow.softness)),
      length,
      skewX,
      contact: Math.max(0, Math.min(1, num(src.shadow?.contact, base.shadow.contact))),
      contactSize: Math.max(0.1, num(src.shadow?.contactSize, base.shadow.contactSize)),
      drape: Math.max(0, num(src.shadow?.drape, base.shadow.drape)),
      drapeEnabled: src.shadow?.drapeEnabled ?? base.shadow.drapeEnabled,
      softSamples: Math.max(1, Math.min(16, Math.round(num(src.shadow?.softSamples, base.shadow.softSamples)))),
      softRadius: Math.max(0, num(src.shadow?.softRadius, base.shadow.softRadius)),
      billboard: src.shadow?.billboard ?? base.shadow.billboard,
    },
    toneStrength: Math.max(0, Math.min(1, num(src.toneStrength, base.toneStrength))),
    toneEnabled: src.toneEnabled ?? base.toneEnabled,
    ao: {
      contact: Math.max(0, Math.min(1, num(src.ao?.contact, base.ao.contact))),
      form: Math.max(0, Math.min(1, num(src.ao?.form, base.ao.form))),
    },
  };
}

/**
 * 解析当前场景的光照环境。
 * @param sceneEnv  场景 JSON 的 lightEnv（可空）
 * @param globalDefault game_config.entityLighting.defaultLightEnv（可空）
 */
export function resolveLightEnv(
  sceneEnv: SceneLightEnv | undefined,
  globalCfg: EntityLightingConfig | undefined,
): ResolvedLightEnv {
  // 先把内置基线的 length/skew 补全（基线本身 azimuth/elev 已定）
  const base: ResolvedLightEnv = {
    ...BASELINE,
    shadow: {
      ...BASELINE.shadow,
      length: lengthFromElevation(BASELINE.key.elevationDeg),
      skewX: skewFromKey(BASELINE.key.azimuthDeg, lengthFromElevation(BASELINE.key.elevationDeg)),
    },
  };
  const withGlobal = mergeOne(base, globalCfg?.defaultLightEnv);
  const resolved = mergeOne(withGlobal, sceneEnv);
  // mode / tone 与 shadowMode 解耦：场景覆盖 > 全局 entityLighting 顶层 > 合并结果
  resolved.shadow.mode = sceneEnv?.shadow?.mode ?? globalCfg?.shadowMode ?? resolved.shadow.mode;
  resolved.toneEnabled = sceneEnv?.toneEnabled ?? globalCfg?.toneEnabled ?? resolved.toneEnabled;
  return resolved;
}
