import type {
  PerspectiveMidStop,
  PerspectivePoint,
  PerspectiveScaleConfig,
} from '../data/types';

/**
 * 场景透视缩放（近大远小）系数求值：唯一数学口径。
 *
 * 语义（docs/玩法功能需求清单.md A3.5）：
 * - 作者画一根深度轴 near→far（可任意方向）；实体按**脚底点在轴上的归一化投影** t∈[0,1]
 *   分段线性插值出系数 f（t=0→near.scale，t=1→far.scale，midStops 为中途点）；轴外投影钳端点；
 * - near/far 需 x/y/scale 均有限且 scale>0，退化轴（near≈far）视为未配置（f≡1）；
 * - 编辑器画布预览必须与本口径一致（Python 镜像：
 *   tools/editor/shared/entity_transform_math.py::perspective_scale_at，parity 测试锁定）。
 */

/** 缩放系数下限（防配置极端值把实体缩没/翻转） */
export const PERSPECTIVE_SCALE_MIN = 0.01;

/** 退化轴判定：|far-near|² 小于此视为无效（near≈far） */
const AXIS_MIN_LEN_SQ = 1e-6;

function validPoint(p: PerspectivePoint | null | undefined): PerspectivePoint | null {
  if (!p) return null;
  if (typeof p.x !== 'number' || !Number.isFinite(p.x)) return null;
  if (typeof p.y !== 'number' || !Number.isFinite(p.y)) return null;
  if (typeof p.scale !== 'number' || !Number.isFinite(p.scale) || p.scale <= 0) return null;
  return { x: p.x, y: p.y, scale: p.scale };
}

/** 预解析后的轴数据：near 原点 + 轴向量 + |轴|² + 沿轴排序的 (pos, scale) 停靠点（含 0/1 端点） */
interface AxisData {
  nx: number;
  ny: number;
  ax: number;
  ay: number;
  lenSq: number;
  stops: Array<{ pos: number; scale: number }>;
}

function axisData(config: PerspectiveScaleConfig | null | undefined): AxisData | null {
  const near = validPoint(config?.near);
  const far = validPoint(config?.far);
  if (!near || !far) return null;
  const ax = far.x - near.x;
  const ay = far.y - near.y;
  const lenSq = ax * ax + ay * ay;
  if (lenSq <= AXIS_MIN_LEN_SQ) return null;

  const stops: Array<{ pos: number; scale: number }> = [{ pos: 0, scale: near.scale }];
  const mids = config?.midStops;
  if (Array.isArray(mids)) {
    for (const m of mids as PerspectiveMidStop[]) {
      if (
        typeof m?.pos === 'number' && Number.isFinite(m.pos) && m.pos > 0 && m.pos < 1 &&
        typeof m?.scale === 'number' && Number.isFinite(m.scale) && m.scale > 0
      ) {
        stops.push({ pos: m.pos, scale: m.scale });
      }
    }
  }
  stops.push({ pos: 1, scale: far.scale });
  stops.sort((a, b) => a.pos - b.pos);
  return { nx: near.x, ny: near.y, ax, ay, lenSq, stops };
}

/** 配置是否实际生效（near/far 有效且轴非退化） */
export function hasPerspectiveScale(config: PerspectiveScaleConfig | null | undefined): boolean {
  return axisData(config) != null;
}

/** 移动步长是否同步缩放；未配置透视时恒 false */
export function perspectiveAffectsSpeed(config: PerspectiveScaleConfig | null | undefined): boolean {
  if (!hasPerspectiveScale(config)) return false;
  return config?.affectsSpeed !== false;
}

/**
 * 求脚底点 (footX, footY) 处的透视缩放系数 f。未配置/配置无效时恒 1。
 */
export function perspectiveScaleAt(
  config: PerspectiveScaleConfig | null | undefined,
  footX: number,
  footY: number,
): number {
  const a = axisData(config);
  if (!a) return 1;
  return scaleFromAxis(a, footX, footY);
}

/** 运行时逐帧求值句柄：轴数据在创建时预解析；未配置/无效时返回 null（调用方按恒 1 处理）。 */
export interface PerspectiveScaleResolver {
  scaleAt(footX: number, footY: number): number;
  /** 移动步长是否同步 × f */
  readonly affectsSpeed: boolean;
}

export function createPerspectiveScaleResolver(
  config: PerspectiveScaleConfig | null | undefined,
): PerspectiveScaleResolver | null {
  const a = axisData(config);
  if (!a) return null;
  return {
    scaleAt: (footX: number, footY: number) => scaleFromAxis(a, footX, footY),
    affectsSpeed: config?.affectsSpeed !== false,
  };
}

function scaleFromAxis(a: AxisData, footX: number, footY: number): number {
  if (!Number.isFinite(footX) || !Number.isFinite(footY)) return 1;
  // 脚底点在 near→far 轴上的归一化投影（钳到 [0,1]，轴外取端点）
  const raw = ((footX - a.nx) * a.ax + (footY - a.ny) * a.ay) / a.lenSq;
  const t = raw <= 0 ? 0 : raw >= 1 ? 1 : raw;

  const stops = a.stops;
  if (t <= stops[0].pos) return clampScale(stops[0].scale);
  const last = stops[stops.length - 1];
  if (t >= last.pos) return clampScale(last.scale);
  for (let i = 1; i < stops.length; i++) {
    const lo = stops[i - 1];
    const hi = stops[i];
    if (t <= hi.pos) {
      if (hi.pos === lo.pos) return clampScale(hi.scale);
      const k = (t - lo.pos) / (hi.pos - lo.pos);
      return clampScale(lo.scale + (hi.scale - lo.scale) * k);
    }
  }
  return clampScale(last.scale);
}

function clampScale(s: number): number {
  return Math.max(PERSPECTIVE_SCALE_MIN, s);
}
