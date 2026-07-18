import type { PerspectiveScaleConfig, PerspectiveScaleRuler } from '../data/types';

/**
 * 场景透视缩放（近大远小）系数求值：唯一数学口径。
 *
 * 语义（docs/玩法功能需求清单.md A3.5）：
 * - 按实体**脚底 y** 在基准线（rulers）间分段线性插值出系数 f(y)，端点外钳制；
 * - 有效基准线需 y/scale 均为有限数且 scale>0，非法条目容错跳过（构建期由 validator 拦）；
 * - 有效基准线不足 2 条视为未配置（f≡1）；
 * - 编辑器画布预览必须与本口径一致（Python 镜像：
 *   tools/editor/shared/entity_transform_math.py::perspective_scale_at，parity 测试锁定）。
 */

/** 缩放系数下限（防配置极端值把实体缩没/翻转） */
export const PERSPECTIVE_SCALE_MIN = 0.01;

function validRulers(config: PerspectiveScaleConfig | null | undefined): PerspectiveScaleRuler[] {
  const raw = config?.rulers;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (r) =>
      typeof r?.y === 'number' && Number.isFinite(r.y) &&
      typeof r?.scale === 'number' && Number.isFinite(r.scale) && r.scale > 0,
  );
}

/** 配置是否实际生效（≥2 条有效基准线） */
export function hasPerspectiveScale(config: PerspectiveScaleConfig | null | undefined): boolean {
  return validRulers(config).length >= 2;
}

/** 移动步长是否同步缩放；未配置透视时恒 false */
export function perspectiveAffectsSpeed(config: PerspectiveScaleConfig | null | undefined): boolean {
  if (!hasPerspectiveScale(config)) return false;
  return config?.affectsSpeed !== false;
}

/**
 * 求脚底 y 处的透视缩放系数 f(y)。未配置/配置无效时恒 1。
 * rulers 顺序无要求（求值前按 y 升序排）；y 相同的重复线取后者。
 */
export function perspectiveScaleAt(
  config: PerspectiveScaleConfig | null | undefined,
  footY: number,
): number {
  const rulers = validRulers(config);
  if (rulers.length < 2) return 1;
  return scaleAtSorted([...rulers].sort((a, b) => a.y - b.y), footY);
}

/** 运行时逐帧求值句柄：基准线在创建时排好序；未配置/无效时返回 null（调用方按恒 1 处理）。 */
export interface PerspectiveScaleResolver {
  scaleAt(footY: number): number;
  /** 移动步长是否同步 × f(y) */
  readonly affectsSpeed: boolean;
}

export function createPerspectiveScaleResolver(
  config: PerspectiveScaleConfig | null | undefined,
): PerspectiveScaleResolver | null {
  const rulers = validRulers(config);
  if (rulers.length < 2) return null;
  const sorted = [...rulers].sort((a, b) => a.y - b.y);
  return {
    scaleAt: (footY: number) => scaleAtSorted(sorted, footY),
    affectsSpeed: config?.affectsSpeed !== false,
  };
}

function scaleAtSorted(sorted: PerspectiveScaleRuler[], footY: number): number {
  if (!Number.isFinite(footY)) return 1;
  if (footY <= sorted[0].y) return clampScale(sorted[0].scale);
  const last = sorted[sorted.length - 1];
  if (footY >= last.y) return clampScale(last.scale);

  for (let i = 1; i < sorted.length; i++) {
    const lo = sorted[i - 1];
    const hi = sorted[i];
    if (footY <= hi.y) {
      // 重复 y：跨度为 0 时直接取后者（避免除零）
      if (hi.y === lo.y) return clampScale(hi.scale);
      const t = (footY - lo.y) / (hi.y - lo.y);
      return clampScale(lo.scale + (hi.scale - lo.scale) * t);
    }
  }
  return clampScale(last.scale);
}

function clampScale(s: number): number {
  return Math.max(PERSPECTIVE_SCALE_MIN, s);
}
