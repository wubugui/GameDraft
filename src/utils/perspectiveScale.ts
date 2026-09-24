import type {
  PerspectiveCameraFollowConfig,
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

/**
 * 相机跟随透视的 zoom 上限（相对基线的倍数）缺省值。
 *
 * 1.5 不是拍脑袋：zoom 直接乘在背景的屏幕显示尺寸上，全段开启时最远端的放大倍数
 * 就是 `f近/f远`（实测跑马梁 6.76×、test_room_a 2.22×、雾津街头 1.86×），
 * 再往上背景必糊。撞上限即停止补偿，人物继续正常变小。
 */
export const DEFAULT_PERSPECTIVE_CAMERA_MAX_ZOOM_RATIO = 1.5;

/** 退化轴判定：|far-near|² 小于此视为无效（near≈far） */
const AXIS_MIN_LEN_SQ = 1e-6;

function validPoint(p: PerspectivePoint | null | undefined): PerspectivePoint | null {
  if (!p) return null;
  if (typeof p.x !== 'number' || !Number.isFinite(p.x)) return null;
  if (typeof p.y !== 'number' || !Number.isFinite(p.y)) return null;
  if (typeof p.scale !== 'number' || !Number.isFinite(p.scale) || p.scale <= 0) return null;
  return { x: p.x, y: p.y, scale: p.scale };
}

/**
 * 预解析后的轴数据：near 原点 + 轴向量 + |轴|² + 沿轴排序的停靠点（含 0/1 端点）。
 *
 * `followNext` = 从本停靠点到下一个停靠点那一段，相机是否跟随（末尾那个端点上无意义）。
 * 开关随停靠点一起排序，所以对 midStops 乱序免疫——见 `PerspectiveMidStop.cameraFollow` 的注释。
 */
interface AxisData {
  nx: number;
  ny: number;
  ax: number;
  ay: number;
  lenSq: number;
  stops: Array<{ pos: number; scale: number; followNext: boolean }>;
}

function axisData(config: PerspectiveScaleConfig | null | undefined): AxisData | null {
  const near = validPoint(config?.near);
  const far = validPoint(config?.far);
  if (!near || !far) return null;
  const ax = far.x - near.x;
  const ay = far.y - near.y;
  const lenSq = ax * ax + ay * ay;
  if (lenSq <= AXIS_MIN_LEN_SQ) return null;

  const stops: AxisData['stops'] = [
    { pos: 0, scale: near.scale, followNext: config?.cameraFollow?.firstSegment !== false },
  ];
  const mids = config?.midStops;
  if (Array.isArray(mids)) {
    for (const m of mids as PerspectiveMidStop[]) {
      if (
        typeof m?.pos === 'number' && Number.isFinite(m.pos) && m.pos > 0 && m.pos < 1 &&
        typeof m?.scale === 'number' && Number.isFinite(m.scale) && m.scale > 0
      ) {
        stops.push({ pos: m.pos, scale: m.scale, followNext: m.cameraFollow !== false });
      }
    }
  }
  stops.push({ pos: 1, scale: far.scale, followNext: false });
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

/** 脚底点在 near→far 轴上的归一化投影（钳到 [0,1]，轴外取端点）；非有限输入回落 0 */
function axisT(a: AxisData, footX: number, footY: number): number {
  if (!Number.isFinite(footX) || !Number.isFinite(footY)) return Number.NaN;
  const raw = ((footX - a.nx) * a.ax + (footY - a.ny) * a.ay) / a.lenSq;
  return raw <= 0 ? 0 : raw >= 1 ? 1 : raw;
}

function scaleFromAxis(a: AxisData, footX: number, footY: number): number {
  const t = axisT(a, footX, footY);
  if (!Number.isFinite(t)) return 1;
  return scaleAtT(a, t);
}

function scaleAtT(a: AxisData, t: number): number {
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

/* ------------------------------------------------------------------ *
 * 相机跟随透视（需求清单 A3.5，2026-09-20 拍板）
 * ------------------------------------------------------------------ */

/**
 * 逐帧求 zoom 倍数的句柄。**只有场景写了 `perspectiveScale.cameraFollow` 才造得出来**；
 * 返回 null 时调用方必须一次 zoom 都不写（不写键 = 效果与开此功能之前严格一致）。
 */
export interface PerspectiveCameraFollowResolver {
  /** 镜头跟随点处的 zoom 相对基线倍数（已按 maxZoomRatio 钳上限；下限由相机按地图边界钳） */
  zoomRatioAt(footX: number, footY: number): number;
  /** 轴走到底（t=1）时的累计倍数，未钳上限——编辑器/校验器用它报「这根轴会把背景放大几倍」 */
  readonly rawRatioAtFar: number;
  /** 作者填的上限（缺省 1.5） */
  readonly maxZoomRatio: number;
}

/**
 * 累计倍数 R(t)：t 之前每个**开启**段贡献 `f(段起点)/f(段内走到处)`，关闭段贡献 1
 * （把当前倍数原样带过去）。这样 R 只由位置决定，正走反走同一点一样，且跨段不跳变。
 */
function followRatioRaw(a: AxisData, t: number): number {
  const stops = a.stops;
  let r = 1;
  for (let i = 0; i + 1 < stops.length; i++) {
    const lo = stops[i];
    const hi = stops[i + 1];
    if (t <= lo.pos) break;
    if (!lo.followNext) continue;
    // 这一段走到哪：整段走完取 hi，否则取 t 处的系数
    const endScale = t >= hi.pos ? clampScale(hi.scale) : scaleAtT(a, t);
    r *= clampScale(lo.scale) / endScale;
  }
  return r;
}

export function createPerspectiveCameraFollowResolver(
  config: PerspectiveScaleConfig | null | undefined,
): PerspectiveCameraFollowResolver | null {
  const follow: PerspectiveCameraFollowConfig | undefined = config?.cameraFollow ?? undefined;
  // 不写键 = 不跟随。写了但不是对象（手改坏的 JSON）同样当没写：运行时对内容错容错跳过。
  if (!follow || typeof follow !== 'object') return null;
  const a = axisData(config);
  if (!a) return null;

  const rawRef = follow.refPos;
  const refPos = typeof rawRef === 'number' && Number.isFinite(rawRef)
    ? (rawRef <= 0 ? 0 : rawRef >= 1 ? 1 : rawRef)
    : 0;
  const rawMax = follow.maxZoomRatio;
  const maxZoomRatio = typeof rawMax === 'number' && Number.isFinite(rawMax) && rawMax >= 1
    ? rawMax
    : DEFAULT_PERSPECTIVE_CAMERA_MAX_ZOOM_RATIO;

  // 基准点处 zoom 恰为基线 ⇒ 全轴的倍数都除以 R(refPos)
  const refRatio = followRatioRaw(a, refPos);
  const norm = refRatio > 0 && Number.isFinite(refRatio) ? refRatio : 1;
  const rawRatioAtFar = followRatioRaw(a, 1) / norm;

  return {
    zoomRatioAt(footX: number, footY: number): number {
      const t = axisT(a, footX, footY);
      if (!Number.isFinite(t)) return 1;
      const r = followRatioRaw(a, t) / norm;
      if (!Number.isFinite(r) || r <= 0) return 1;
      // 上限钳住往里推那一侧；往外拉那一侧不在这里钳（相机按「视野不超出地图」自己钳）
      return r > maxZoomRatio ? maxZoomRatio : r;
    },
    rawRatioAtFar,
    maxZoomRatio,
  };
}
