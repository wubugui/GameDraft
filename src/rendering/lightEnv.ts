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
    enabled: boolean; darkness: number; softness: number; length: number;
    contact: number; contactSize: number;
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
    // length 为占位：resolveLightEnv 末端统一按「显式值 > 最终 elevation 推导」定值
    enabled: true, darkness: 0.4, softness: 1.0, length: 0,
    contact: 0.5, contactSize: 1.0,
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

/** 显式数值：合法有限数返回本值，否则 undefined（供跨层「显式值优先」判定） */
function explicitNum(v: number | undefined): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
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

/** 合并三层（base < global < scene），返回全字段具体的解析结果。 */
function mergeOne(base: ResolvedLightEnv, src: SceneLightEnv | undefined): ResolvedLightEnv {
  if (!src) return base;
  const azimuthDeg = num(src.key?.azimuthDeg, base.key.azimuthDeg);
  const elevationDeg = num(src.key?.elevationDeg, base.key.elevationDeg);
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
      // length 在此仅逐层继承显式值（不按本层 elevation 重算，避免丢上一层显式配置）；
      // 整条链都无显式值时由 resolveLightEnv 末端按最终 elevation 推导
      length: num(src.shadow?.length, base.shadow.length),
      contact: Math.max(0, Math.min(1, num(src.shadow?.contact, base.shadow.contact))),
      contactSize: Math.max(0.1, num(src.shadow?.contactSize, base.shadow.contactSize)),
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
 * @param globalCfg game_config.entityLighting（含 defaultLightEnv，可空）
 */
export function resolveLightEnv(
  sceneEnv: SceneLightEnv | undefined,
  globalCfg: EntityLightingConfig | undefined,
): ResolvedLightEnv {
  // 基线须逐层克隆：mergeOne(src 为空) 原样返回 base，而返回值会被调用方原地改写
  //（F2 调试 / copyResolvedInto），不克隆会污染模块级 BASELINE。
  const base: ResolvedLightEnv = {
    key: { ...BASELINE.key },
    ambient: { ...BASELINE.ambient },
    shadow: { ...BASELINE.shadow },
    toneStrength: BASELINE.toneStrength,
    toneEnabled: BASELINE.toneEnabled,
    ao: { ...BASELINE.ao },
  };
  const withGlobal = mergeOne(base, globalCfg?.defaultLightEnv);
  const resolved = mergeOne(withGlobal, sceneEnv);
  // mode / tone 与 shadowMode 解耦：场景覆盖 > 全局 entityLighting 顶层 > 合并结果
  resolved.shadow.mode = sceneEnv?.shadow?.mode ?? globalCfg?.shadowMode ?? resolved.shadow.mode;
  resolved.toneEnabled = sceneEnv?.toneEnabled ?? globalCfg?.toneEnabled ?? resolved.toneEnabled;
  // length：显式值沿链取最近一层（scene > global）；整条链都未显式配置时才由最终 elevation 推导，
  // 保证「场景只改仰角」的既有行为不变，同时不丢上层显式 length。
  const explicitLength = explicitNum(sceneEnv?.shadow?.length)
    ?? explicitNum(globalCfg?.defaultLightEnv?.shadow?.length);
  resolved.shadow.length = explicitLength ?? lengthFromElevation(resolved.key.elevationDeg);
  return resolved;
}
