/**
 * 脚底接触 AO（胶囊 AO）的配置解析——作者面 `ContactAoDef` → 着色器要的数。
 *
 * 制作人 2026-09-24 定的作者面：勾「接触 AO」就有；**方向 AO 缺省也开**（「所有 npc 默认都开方向 ao，包括主角」，
 * 同日改口，此前缺省是只有简单 AO）；取消勾选方向 AO 就只剩简单 AO（无方向的近场遮蔽）；参数都能调。
 * 明暗 / 大小不写就跟随场景光环境（`shadow.contact` / `contactSize`，光照曲线里也能按位置变）；
 * 其余参数不写就用下面的缺省。几何与着色见 EntityShadow 的 `CONTACT_FRAG`。
 *
 * ⚠ 缺省值的编辑器镜像在 `tools/editor/shared/contact_ao.py`，对账测试逐字比对这几个常量
 *   （test_npc_contact_shadow_form.py）。改这里要一起改那边。
 */
import type { ContactAoDef } from '../data/types';

/** 简单 AO 的晕开范围：无方向部分的遮挡高度占身高的比例。 */
export const CONTACT_AO_SPREAD_DEFAULT = 0.25;
/** 方向 AO 浓度（0..1）。 */
export const CONTACT_AO_DIR_STRENGTH_DEFAULT = 0.9;
/** 方向 AO 拖尾长度（× 身高），沿影子方向在这个长度内淡出。 */
export const CONTACT_AO_DIR_LENGTH_DEFAULT = 0.7;
/** 方向 AO 半影锥角（度）。越大越软、边越糊。 */
export const CONTACT_AO_DIR_CONE_DEG_DEFAULT = 32;
/** 方向 AO 的方向来源可选值（`ContactAoDef.dirSource`）。编辑器下拉与校验器的枚举对着它。 */
export const CONTACT_AO_DIR_SOURCES = ['lighting', 'binding', 'scene'] as const;
export type ContactAoDirSource = (typeof CONTACT_AO_DIR_SOURCES)[number];
/**
 * 方向来源缺省 `lighting`：跟角色身上的光一致——间接光一路（probe，与角色间接光同一份）+ 每盏实体灯
 * 各一路，各投各的影、按各自占地面照度的比例加权（见 contactAoSources.ts）。制作人 2026-09-24：
 * 先是「默认最近的灯，但只是一个选项」，同日定成「ao 方向本来就和间接光强度要一致」。
 */
export const CONTACT_AO_DIR_SOURCE_DEFAULT: ContactAoDirSource = 'lighting';
/** 方向 AO 缺省开（制作人 2026-09-24：所有 NPC 默认都开方向 AO，包括主角）。 */
export const CONTACT_AO_DIRECTIONAL_DEFAULT = true;

/** 解好的一份接触 AO 参数。 */
export interface ResolvedContactAo {
  enabled: boolean;
  directional: boolean;
  /** 方向 AO 的方向来源。 */
  dirSource: ContactAoDirSource;
  /** 明暗 0..1（脚边最暗处的浓度）。 */
  darkness: number;
  /** 大小倍率（胶囊半径 = 贴地那一截半宽 × 它）。 */
  size: number;
  /** 简单 AO 晕开范围（遮挡高度占身高比例）。 */
  spread: number;
  dirStrength: number;
  dirLength: number;
  /** 锥形软阴影的 k（= 0.5 / tan(半影锥角)），着色器直接用。 */
  coneK: number;
}

function num(v: unknown, fallback: number, lo: number, hi: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;
}

/** 半影锥角（度）→ 锥形软阴影的 k。锥角钳在 (1°, 85°) 之间，两头都退化。 */
export function coneKFromDeg(deg: number): number {
  const a = (Math.max(1, Math.min(85, deg)) * Math.PI) / 180;
  return 0.5 / Math.tan(a);
}

/**
 * 实体的 `contactAo`（可缺）+ 场景光环境的接触浓度 / 大小 → 一份完整参数。
 * 数值越界一律钳住（校验器会把越界报成错，运行时只兜底不崩）。
 */
export function resolveContactAo(
  def: ContactAoDef | null | undefined,
  sceneShadow: { contact: number; contactSize: number },
): ResolvedContactAo {
  const d = def ?? {};
  return {
    enabled: d.enabled !== false,
    directional: typeof d.directional === 'boolean' ? d.directional : CONTACT_AO_DIRECTIONAL_DEFAULT,
    dirSource: (CONTACT_AO_DIR_SOURCES as readonly string[]).includes(d.dirSource as string)
      ? d.dirSource as ContactAoDirSource
      : CONTACT_AO_DIR_SOURCE_DEFAULT,
    darkness: num(d.darkness, sceneShadow.contact, 0, 1),
    size: num(d.size, sceneShadow.contactSize, 0, 10),
    spread: num(d.spread, CONTACT_AO_SPREAD_DEFAULT, 0.01, 3),
    dirStrength: num(d.dirStrength, CONTACT_AO_DIR_STRENGTH_DEFAULT, 0, 1),
    dirLength: num(d.dirLength, CONTACT_AO_DIR_LENGTH_DEFAULT, 0.01, 10),
    coneK: coneKFromDeg(num(d.dirConeDeg, CONTACT_AO_DIR_CONE_DEG_DEFAULT, 1, 85)),
  };
}
