import type {
  LightEnvCurveDef,
  LightEnvCurvePoint,
  RgbColor,
  SceneLightEnv,
} from '../data/types';
import type { ResolvedLightEnv } from './lightEnv';

/**
 * 「光照环境曲线」纯几何/插值工具（无 Pixi 依赖，可独立测试）。
 *
 * 运行时：玩家世界坐标 → 投影到折线得归一化弧长 t01 → 在相邻关键帧之间插值出一份
 * 部分 SceneLightEnv → 交给 resolveLightEnv 补全 → copyResolvedInto 原地写回当前环境
 * （保持对象身份，使持有引用的 shadowField / 阴影逐帧读到新值）。
 */

/** 预处理后的曲线：折线点 + 累计弧长，避免逐帧重复求段长。 */
export interface PreparedLightCurve {
  points: LightEnvCurvePoint[];
  /** cum[i] = 从 points[0] 到 points[i] 的累计长度，cum[0]=0 */
  cum: number[];
  total: number;
}

/**
 * 预处理曲线：累计各段长度。点数 <2 或总长≈0 时返回 null（调用方据此回落到静态 lightEnv）。
 */
export function prepareLightCurve(def: LightEnvCurveDef | undefined): PreparedLightCurve | null {
  const pts = def?.points;
  if (!Array.isArray(pts) || pts.length < 2) return null;
  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x;
    const dy = pts[i].y - pts[i - 1].y;
    cum.push(cum[i - 1] + Math.hypot(dx, dy));
  }
  const total = cum[cum.length - 1];
  if (!(total > 1e-6)) return null;
  return { points: pts, cum, total };
}

/**
 * 把世界点 (px,py) 投影到折线，返回归一化弧长 t01∈[0,1]（取最近段的最近点）。
 */
export function projectToCurveT(curve: PreparedLightCurve, px: number, py: number): number {
  const { points, cum, total } = curve;
  let bestD2 = Infinity;
  let bestArc = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const ax = points[i].x, ay = points[i].y;
    const bx = points[i + 1].x, by = points[i + 1].y;
    const abx = bx - ax, aby = by - ay;
    const len2 = abx * abx + aby * aby;
    let t = len2 > 1e-9 ? ((px - ax) * abx + (py - ay) * aby) / len2 : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const qx = ax + abx * t, qy = ay + aby * t;
    const dx = px - qx, dy = py - qy;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      bestArc = cum[i] + t * (cum[i + 1] - cum[i]);
    }
  }
  return Math.max(0, Math.min(1, bestArc / total));
}

function lerp(a: number, b: number, u: number): number {
  return a + (b - a) * u;
}

/** 颜色逐通道线性插值。 */
function lerpRgb(a: RgbColor, b: RgbColor, u: number): RgbColor {
  return [lerp(a[0], b[0], u), lerp(a[1], b[1], u), lerp(a[2], b[2], u)];
}

/** 角度按最短弧插值（处理 350°→10° 环绕）。 */
function lerpAngleDeg(a: number, b: number, u: number): number {
  let d = ((b - a) % 360 + 540) % 360 - 180; // 归一到 (-180,180]
  let r = a + d * u;
  r = ((r % 360) + 360) % 360;
  return r;
}

/** 取两端值：都缺省→undefined；只一端有→用那端（该段内恒定）；都有→[a,b] 供混合。 */
function pair<T>(a: T | undefined, b: T | undefined): [T, T] | [T] | null {
  if (a === undefined && b === undefined) return null;
  if (a === undefined) return [b as T];
  if (b === undefined) return [a as T];
  return [a, b];
}

function blendNum(a: number | undefined, b: number | undefined, u: number): number | undefined {
  const p = pair(a, b);
  if (!p) return undefined;
  return p.length === 1 ? p[0] : lerp(p[0], p[1], u);
}

function blendAngle(a: number | undefined, b: number | undefined, u: number): number | undefined {
  const p = pair(a, b);
  if (!p) return undefined;
  return p.length === 1 ? p[0] : lerpAngleDeg(p[0], p[1], u);
}

function blendColor(a: RgbColor | undefined, b: RgbColor | undefined, u: number): RgbColor | undefined {
  const p = pair(a, b);
  if (!p) return undefined;
  return p.length === 1 ? p[0] : lerpRgb(p[0], p[1], u);
}

/** 离散值（布尔/枚举）：取最近关键帧（u<0.5→a，否则 b）；不可平滑混合。 */
function pick<T>(a: T | undefined, b: T | undefined, u: number): T | undefined {
  const p = pair(a, b);
  if (!p) return undefined;
  if (p.length === 1) return p[0];
  return u < 0.5 ? p[0] : p[1];
}

/** 去掉对象里 undefined 的键，保持「部分 SceneLightEnv」最小化（便于 resolveLightEnv 回落）。 */
function compact<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) {
    if (o[k] === undefined) delete o[k];
  }
  return o;
}

/**
 * 在 t01 处插值出一份部分 SceneLightEnv。
 * 连续量（key 方位/仰角/颜色/强度、ambient、shadow 数值、toneStrength、ao）平滑插值；
 * 离散量（shadow.mode/enabled/billboard/drapeEnabled、toneEnabled）取最近关键帧。
 */
export function interpolateLightEnv(curve: PreparedLightCurve, t01: number): SceneLightEnv {
  const { points, cum, total } = curve;
  const arc = Math.max(0, Math.min(1, t01)) * total;
  // 定位所在段
  let j = 0;
  while (j < points.length - 2 && cum[j + 1] < arc) j++;
  const segLen = cum[j + 1] - cum[j];
  const uRaw = segLen > 1e-9 ? (arc - cum[j]) / segLen : 0;
  // smoothstep 让控制点处一阶连续，避免折点突变
  const u = uRaw * uRaw * (3 - 2 * uRaw);

  const a = points[j].env ?? {};
  const b = points[j + 1].env ?? {};

  const key = compact({
    azimuthDeg: blendAngle(a.key?.azimuthDeg, b.key?.azimuthDeg, u),
    elevationDeg: blendNum(a.key?.elevationDeg, b.key?.elevationDeg, u),
    color: blendColor(a.key?.color, b.key?.color, u),
    intensity: blendNum(a.key?.intensity, b.key?.intensity, u),
  });
  const ambient = compact({
    color: blendColor(a.ambient?.color, b.ambient?.color, u),
    intensity: blendNum(a.ambient?.intensity, b.ambient?.intensity, u),
  });
  const shadow = compact({
    mode: pick(a.shadow?.mode, b.shadow?.mode, u),
    enabled: pick(a.shadow?.enabled, b.shadow?.enabled, u),
    darkness: blendNum(a.shadow?.darkness, b.shadow?.darkness, u),
    softness: blendNum(a.shadow?.softness, b.shadow?.softness, u),
    length: blendNum(a.shadow?.length, b.shadow?.length, u),
    skewX: blendNum(a.shadow?.skewX, b.shadow?.skewX, u),
    contact: blendNum(a.shadow?.contact, b.shadow?.contact, u),
    contactSize: blendNum(a.shadow?.contactSize, b.shadow?.contactSize, u),
    drape: blendNum(a.shadow?.drape, b.shadow?.drape, u),
    drapeEnabled: pick(a.shadow?.drapeEnabled, b.shadow?.drapeEnabled, u),
    softSamples: blendNum(a.shadow?.softSamples, b.shadow?.softSamples, u),
    softRadius: blendNum(a.shadow?.softRadius, b.shadow?.softRadius, u),
    billboard: pick(a.shadow?.billboard, b.shadow?.billboard, u),
  });

  const out: SceneLightEnv = {};
  if (Object.keys(key).length) out.key = key as SceneLightEnv['key'];
  if (Object.keys(ambient).length) out.ambient = ambient as SceneLightEnv['ambient'];
  if (Object.keys(shadow).length) out.shadow = shadow as SceneLightEnv['shadow'];
  const tone = blendNum(a.toneStrength, b.toneStrength, u);
  if (tone !== undefined) out.toneStrength = tone;
  const toneEnabled = pick(a.toneEnabled, b.toneEnabled, u);
  if (toneEnabled !== undefined) out.toneEnabled = toneEnabled;
  const ao = compact({
    contact: blendNum(a.ao?.contact, b.ao?.contact, u),
    form: blendNum(a.ao?.form, b.ao?.form, u),
  });
  if (Object.keys(ao).length) out.ao = ao as SceneLightEnv['ao'];
  return out;
}

/**
 * 把 src 的全部字段原地拷入 dst（保持 dst 对象身份不变）。
 * shadowField 与各阴影持有 currentLightEnv 的引用并逐帧读取字段，故必须原地改而非重赋引用。
 */
export function copyResolvedInto(dst: ResolvedLightEnv, src: ResolvedLightEnv): void {
  dst.key.azimuthDeg = src.key.azimuthDeg;
  dst.key.elevationDeg = src.key.elevationDeg;
  dst.key.color = src.key.color;
  dst.key.intensity = src.key.intensity;
  dst.ambient.color = src.ambient.color;
  dst.ambient.intensity = src.ambient.intensity;
  dst.shadow.mode = src.shadow.mode;
  dst.shadow.enabled = src.shadow.enabled;
  dst.shadow.darkness = src.shadow.darkness;
  dst.shadow.softness = src.shadow.softness;
  dst.shadow.length = src.shadow.length;
  dst.shadow.skewX = src.shadow.skewX;
  dst.shadow.contact = src.shadow.contact;
  dst.shadow.contactSize = src.shadow.contactSize;
  dst.shadow.drape = src.shadow.drape;
  dst.shadow.drapeEnabled = src.shadow.drapeEnabled;
  dst.shadow.softSamples = src.shadow.softSamples;
  dst.shadow.softRadius = src.shadow.softRadius;
  dst.shadow.billboard = src.shadow.billboard;
  dst.toneStrength = src.toneStrength;
  dst.toneEnabled = src.toneEnabled;
  dst.ao.contact = src.ao.contact;
  dst.ao.form = src.ao.form;
}
