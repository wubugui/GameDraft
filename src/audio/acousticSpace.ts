/**
 * 声学空间 → 冲激响应（IR）。**纯函数，不碰 DOM、不碰引擎**。
 *
 * ## 这是什么
 *
 * 山谷回音不是弥散混响，而是**几个离散反射**。每个反射面贡献一个抽头（tap），
 * 三个物理量把它定死：
 *
 * - 延迟 `τ = L / c`，`L` 是镜像声源到听者的路径长，`c = 331.3 + 0.606 × 摄氏温度`
 * - 强度由**立体角**给：面积 / L² —— 一整面崖壁和一块凸岩返回的能量差很多
 * - **空气对高频的吸收随距离增大** —— 这才是「远」的听感来源，不是单纯变轻
 *
 * ## 三条踩过的坑（都写成了判据，别再犯）
 *
 * 1. **最近反射面的延迟必须大于干声时长**，否则回音压在原声上，
 *    听着像院子不像山谷。猿啼 3 秒 → 最近面要 500 米以上。
 *    {@link nearestGapSeconds} 把这个下限算出来给编辑器提示。
 * 2. **晚期尾必须延后到第一次反射之后**。从 0 起会把原声与回音之间那段空白填满，
 *    而那段空白正是山谷感的来源。
 * 3. **别硬套点源 1/r 衰减**：760 米往返按 1 米参考算是 −57 dB，实测整条沉到
 *    −99 dBFS 等于没有。崖壁是大反射面，走立体角项并钳上限。
 *
 * ## 坐标与单位（v2，2026-09-08 改成世界空间）
 *
 * **作者面与运行时接口一律是 M-world 的 wu**：与灯位、轨迹同一个坐标系——
 * 原点画面中心、Y 朝上、XZ 是地面（`depthConfig.M.R`，det=+1）。反射面端点是
 * 地面上的 `[x, z]`，`y` 是底高程、`height` 是面高，全是 wu。听者位置是
 * **脚下的地面世界点**（wu），耳高由 `earHeight` 单独加上。
 *
 * 物理只认米，所以本模块内部先把整个空间换算成米再算：
 *
 *     米 = wu / 88 × distanceScale
 *
 * 88 是视觉尺度锚（角色高 150 wu ≈ 1.7 m，28 个场景恒定），**不随场景变**。
 * `distanceScale` 是每个空间一个的**全局距离缩放**：画里可见的世界只有二三十米宽，
 * 而对岸主崖按硬判据要在几百米外——作者把反射面贴着画里的崖壁摆，再把整个空间
 * 等比例放大。立体角项（面积 / L²）对等比缩放不变，所以缩放只改延迟与空气吸收，
 * 不改强度，这正是「世界变大了」的物理含义。**所有距离一律缩放**，包括耳高。
 *
 * 与视觉几何**解耦**仍是硬规矩：3D 展开的场景只是描图参考，几何本身是作者数据。
 */

/** 视觉尺度锚：1 米 ≈ 88 wu（角色高 150 wu 按 1.7 m 算）。见 coordinate-spaces 机制卡。 */
export const DEFAULT_WU_PER_METER = 88;
/** 缺省耳高，wu（1.6 m × 88）。 */
export const DEFAULT_EAR_HEIGHT_WU = 141;
/** 缺省全局距离缩放：1 = 画里多大声学里就多大。 */
export const DEFAULT_DISTANCE_SCALE = 1;

/** 平面上的一段反射面。默认是竖直崖壁；`tiltDeg >= 45` 视作水平面（水面 / 岩檐）。 */
export interface AcousticReflector {
  id?: string;
  /** 端点 A，wu，地面 `[x, z]`（M-world） */
  a: [number, number];
  /** 端点 B，wu */
  b: [number, number];
  /** 面高，wu。与长度相乘得面积，面积决定立体角，也就决定强度。 */
  height: number;
  /** 吸收系数 0..1，岩石约 0.03–0.1 */
  absorb: number;
  /** 粗糙度 0..1，越大反射被抹得越开（石头的质感） */
  rough: number;
  /**
   * 底边高程，wu（M-world 的 Y），默认 0。
   * 竖直面：面覆盖 `[y, y + height]`，听者耳朵不在这个区间内时反射点被钳到边缘，
   * 路径随之变长——头顶那片崖壁确实比平齐的远。
   * 水平面：`y` 就是这个面所在的高度（脚下的潭面给地面以下的值，岩檐给头顶的值）。
   */
  y?: number;
  /** 倾角，度。0＝竖直崖壁（默认）；>=45 视作水平面。 */
  tiltDeg?: number;
}

/**
 * 听者 / 声源：**脚下的地面世界点**，wu。`y` 是地面高程（M-world Y，默认 0），
 * 耳朵在 `y + space.earHeight`。运行时把玩家脚下的地面点换算进来就是这个形状。
 */
export interface AcousticListener { x: number; z: number; y?: number }

/** M-world 里的一个绝对点（wu）：耳朵 / 发声点本身，不再另加耳高。 */
export interface AcousticPoint { x: number; y: number; z: number }

/**
 * 作者摆的**试听声源**：一个有物理位置的发声点。`x/z` 地面点、`y` 地面高程、`height` 发声点离地高度
 * （缺省 = 空间耳高：嘴和耳朵差不多高）。工作台从它试听，运行时的活声源（脚步、NPC）不用它——它们自带位置。
 */
export interface AcousticSource {
  id: string;
  label?: string;
  x: number;
  z: number;
  y?: number;
  height?: number;
}

/**
 * 运行时听者绑到谁身上：`player` 玩家的耳朵；`camera` 画面中心地面点上的耳朵；`entity` 指定 NPC；
 * `fixed` 钉在作者摆的 `listener` 上。**一个空间一份**（这是声学空间的作者数据，工作台里设）；
 * 场景 JSON 的 `acousticListener` 若也设了，按场景的（更具体）。
 */
export interface AcousticListenerBinding {
  mode: 'player' | 'camera' | 'entity' | 'fixed';
  entityId?: string;
}

/**
 * 直达声（声源 → 听者，不经反射）的参数。**全是声学米**（已含距离缩放）。
 * 反射走立体角，直达声走参考距离衰减：近于 `refDistanceM` 不再变响，远处按 `ref/(ref+rolloff·(d−ref))`。
 */
export interface DirectPathParams {
  /** 参考距离，米。缺省 7（≈ 600 wu，一个半身位） */
  refDistanceM?: number;
  /** 衰减系数，缺省 1 */
  rolloff?: number;
  /** 超过此距离不播，米。缺省 40 */
  maxDistanceM?: number;
  /** 声像宽度 0..1，缺省 0.7 */
  panWidth?: number;
}

export const DEFAULT_DIRECT: Required<DirectPathParams> = {
  refDistanceM: 7, rolloff: 1, maxDistanceM: 40, panWidth: 0.7,
};

export interface AcousticSpaceDef {
  label?: string;
  /**
   * 这个空间是在哪个场景的 3D 展开里摆的。逻辑上一份场景几何对应一个声学空间；
   * 强行绑到别的场景上也能响，只是不保证效果对。运行时不读它，工作台用它重开现场。
   */
  authoring?: { sceneId: string; background?: string };
  /** 全局距离缩放（见文件头）。缺省 1。 */
  distanceScale?: number;
  /** 耳高，wu。缺省 141（1.6 m）。**跟着 distanceScale 一起缩**。 */
  earHeight?: number;
  /** 作者态的默认听者位置；运行时按 `listenerBinding` 换成玩家 / 相机 / 实体（`fixed` 才钉在这里）。 */
  listener: AcousticListener;
  /** 运行时听者绑到谁。缺省 `player`。场景 JSON 的 `acousticListener` 可覆盖。 */
  listenerBinding?: AcousticListenerBinding;
  /** 作者摆的试听声源（有物理位置）。没有时试听从听者自己发出（自己喊）。 */
  sources?: AcousticSource[];
  /**
   * @deprecated v2 的单个声源（地面点）。工作台装载时迁成 `sources[0]`；运行时不读。
   */
  source?: AcousticListener;
  /** 直达声参数（声学米）。缺省见 {@link DEFAULT_DIRECT}。 */
  direct?: DirectPathParams;
  reflectors: AcousticReflector[];
  /** 反射阶数，1 或 2。二阶把离散抽头之间填满，是「像空间」而非「像延迟器」的分水岭。 */
  order?: 1 | 2;
  /** 晚期扩散尾 */
  tail?: { seconds: number; gain: number };
  air?: { tempC?: number; humidity?: number };
  /** 立体声展开 0..1 */
  width?: number;
  /** 是否做遮挡剔除（二维射线 × 其它反射面）。缺省开。 */
  occlusion?: boolean;
}

export interface BuiltIR {
  /** 默认是**独立拷贝**，可以安全留着；只有 `transient: true` 时才是暂存视图。 */
  left: Float32Array;
  /** 同上 */
  right: Float32Array;
  sampleRate: number;
  /** 诊断用：算出来的抽头，编辑器直接显示这张表 */
  taps: AcousticTap[];
}

export interface AcousticTap {
  order: 1 | 2;
  /** 路径长，**米**（已含距离缩放） */
  length: number;
  /** 到达延迟，秒 */
  delay: number;
  /** 到达方位角，弧度，0 = 正前（+Z），正值向右 */
  azimuth: number;
  /** 到达仰角，弧度，正值在上方（目前只用于诊断，立体声输出渲染不了它） */
  elevation: number;
  /** 线性增益（未含空气吸收，那是频率相关的） */
  gain: number;
  reflectorIds: string[];
  /** 被别的面挡掉了多少（0＝没挡，1＝全挡） */
  occluded?: number;
  /**
   * 反射点（一阶）或首次反射点（二阶），**wu**，M-world。工作台在 3D 里画路径用；
   * 水平面的反射点在听者正上/正下方。
   */
  hit?: [number, number, number];
}

/** ISO 9613-1 量级的空气吸收，10°C / 70%RH，dB per meter。 */
const ABS_F = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const ABS_A = [0.00007, 0.0002, 0.0004, 0.001, 0.003, 0.006, 0.012, 0.030, 0.090, 0.30];

/** 指定频率下的空气吸收系数，dB/m。对数频率插值。 */
export function airAbsorptionDbPerM(freqHz: number): number {
  const f = Math.min(Math.max(freqHz, ABS_F[0]), ABS_F[ABS_F.length - 1]);
  const lf = Math.log10(f);
  for (let i = 1; i < ABS_F.length; i++) {
    if (lf <= Math.log10(ABS_F[i])) {
      const l0 = Math.log10(ABS_F[i - 1]);
      const l1 = Math.log10(ABS_F[i]);
      const t = (lf - l0) / (l1 - l0);
      return ABS_A[i - 1] + t * (ABS_A[i] - ABS_A[i - 1]);
    }
  }
  return ABS_A[ABS_A.length - 1];
}

export function speedOfSound(tempC = 5): number {
  return 331.3 + 0.606 * tempC;
}

/** 这个空间里 1 wu 折合多少米（`distanceScale / 88`）。非法或缺省的缩放按 1。 */
export function metersPerWu(space: Pick<AcousticSpaceDef, 'distanceScale'>): number {
  const s = space.distanceScale;
  const scale = typeof s === 'number' && Number.isFinite(s) && s > 0 ? s : DEFAULT_DISTANCE_SCALE;
  return scale / DEFAULT_WU_PER_METER;
}

/** 耳高，wu（缺省 141）。 */
export function earHeightWu(space: Pick<AcousticSpaceDef, 'earHeight'>): number {
  const e = space.earHeight;
  return typeof e === 'number' && Number.isFinite(e) && e >= 0 ? e : DEFAULT_EAR_HEIGHT_WU;
}

/** 确定性 RNG。**不能用 Math.random**：IR 必须可复现，否则同一份配置两次听感不同。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v; }
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function isHorizontalReflector(r: Pick<AcousticReflector, 'tiltDeg'>): boolean {
  return (r.tiltDeg ?? 0) >= 45;
}

// ---------------------------------------------------------------------------
// 米制中间态：作者面（wu）→ 物理（米）。只在本模块内部存在，别往外传。
// ---------------------------------------------------------------------------

interface MetricReflector {
  id: string;
  a: [number, number];
  b: [number, number];
  height: number;
  absorb: number;
  rough: number;
  y: number;
  horizontal: boolean;
}

interface MetricPoint { x: number; z: number; y: number }

interface MetricSpace {
  reflectors: MetricReflector[];
  /** 听者水平朝向（单位）与右向：方位角在**听者系**里算，不是世界 +Z */
  fwd: [number, number];
  right: [number, number];
  /** 听者：`y` 已是**耳朵**的绝对高程（米） */
  L: MetricPoint;
  /** 声源，同上 */
  S: MetricPoint;
  occlusion: boolean;
  order: 1 | 2;
  c: number;
  /** 米 → wu 的逆换算（给 `hit` 回填用） */
  wuPerM: number;
}

/** 直达声参数（补齐缺省，非法值按缺省）。 */
export function directParams(space: Pick<AcousticSpaceDef, 'direct'>): Required<DirectPathParams> {
  const d = space.direct ?? {};
  const num = (v: unknown, dflt: number, lo = 0) =>
    typeof v === 'number' && Number.isFinite(v) && v >= lo ? v : dflt;
  return {
    refDistanceM: num(d.refDistanceM, DEFAULT_DIRECT.refDistanceM, 0.01),
    rolloff: num(d.rolloff, DEFAULT_DIRECT.rolloff),
    maxDistanceM: num(d.maxDistanceM, DEFAULT_DIRECT.maxDistanceM, 0.01),
    panWidth: Math.min(1, num(d.panWidth, DEFAULT_DIRECT.panWidth)),
  };
}

/** 作者摆的声源 → 发声点（wu，绝对）。`height` 缺省 = 耳高。 */
export function sourcePoint(space: Pick<AcousticSpaceDef, 'earHeight'>, s: AcousticSource): AcousticPoint {
  const h = typeof s.height === 'number' && Number.isFinite(s.height) && s.height >= 0 ? s.height : earHeightWu(space);
  return { x: s.x, y: (s.y ?? 0) + h, z: s.z };
}

/** 空间里的声源清单（v2 的单个 `source` 也算一个，id「声源」）。 */
export function listSources(space: Pick<AcousticSpaceDef, 'sources' | 'source'>): AcousticSource[] {
  if (Array.isArray(space.sources)) return space.sources;
  if (space.source) return [{ id: '声源', x: space.source.x, z: space.source.z, y: space.source.y }];
  return [];
}

function toMetric(space: AcousticSpaceDef, opts: CollectOptions): MetricSpace {
  const k = metersPerWu(space);
  const ear = earHeightWu(space);
  const pt = (p: AcousticListener): MetricPoint => ({
    x: p.x * k, z: p.z * k, y: ((p.y ?? 0) + ear) * k,
  });
  const abs = (p: AcousticPoint): MetricPoint => ({ x: p.x * k, z: p.z * k, y: p.y * k });
  // 听者：给了绝对耳点就用它（运行时的耳朵），否则地面点 + 耳高
  const L = opts.ear ? abs(opts.ear) : pt(opts.listener ?? space.listener);
  // 声源：给了绝对发声点就用它；没给 = 自己喊（与听者同位）
  const S = opts.source ? abs(opts.source) : L;
  // 听者朝向：取水平分量；朝天 / 没给 = 看进画面（+Z）。右 = up × forward（左手系）= (fz, −fx)
  const f = opts.forward ?? [0, 0, 1];
  const fl = Math.hypot(f[0], f[2]);
  const fwd: [number, number] = fl > 1e-6 ? [f[0] / fl, f[2] / fl] : [0, 1];
  const right: [number, number] = [fwd[1], -fwd[0]];
  return {
    fwd,
    right,
    reflectors: space.reflectors.map((r, i) => ({
      id: r.id ?? `#${i}`,
      a: [r.a[0] * k, r.a[1] * k],
      b: [r.b[0] * k, r.b[1] * k],
      height: r.height * k,
      absorb: r.absorb,
      rough: r.rough,
      y: (r.y ?? 0) * k,
      horizontal: isHorizontalReflector(r),
    })),
    L,
    S,
    occlusion: space.occlusion !== false,
    order: (space.order ?? 2) >= 2 ? 2 : 1,
    c: speedOfSound(space.air?.tempC ?? 5),
    wuPerM: k > 0 ? 1 / k : 0,
  };
}

/** 把点 p 关于线段 ab 所在直线做镜像（平面内）。 */
function mirror2(p: { x: number; z: number }, r: MetricReflector): { x: number; z: number } {
  const ax = r.a[0], az = r.a[1], bx = r.b[0], bz = r.b[1];
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz;
  if (len2 < 1e-9) return { x: p.x, z: p.z };
  const t = ((p.x - ax) * dx + (p.z - az) * dz) / len2;
  const projX = ax + t * dx, projZ = az + t * dz;
  return { x: 2 * projX - p.x, z: 2 * projZ - p.z };
}

/** 线段 ab 上离 p 最近的点（反射点的估计，画路径用）。 */
function nearestOnSegment(p: { x: number; z: number }, r: MetricReflector): { x: number; z: number } {
  const ax = r.a[0], az = r.a[1], bx = r.b[0], bz = r.b[1];
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz;
  if (len2 < 1e-9) return { x: ax, z: az };
  const t = clamp01(((p.x - ax) * dx + (p.z - az) * dz) / len2);
  return { x: ax + t * dx, z: az + t * dz };
}

function reflectorArea(r: MetricReflector): number {
  const dx = r.b[0] - r.a[0], dz = r.b[1] - r.a[1];
  return Math.hypot(dx, dz) * Math.max(0.1, r.height);
}

/**
 * 立体角项。面积 / L²，钳到 1 —— 钳位是必须的：
 * 近距离大面会算出 >1 的"放大"，那是模型在自身适用范围之外。
 */
function solidAngleGain(area: number, length: number): number {
  return Math.min(1, area / Math.max(1, length * length));
}

/** 线段 pq 与线段 ab 是否相交（用于遮挡）。 */
function segmentsCross(
  p: [number, number], q: [number, number],
  a: [number, number], b: [number, number],
): boolean {
  const d = (u: [number, number], v: [number, number], w: [number, number]) =>
    (v[0] - u[0]) * (w[1] - u[1]) - (v[1] - u[1]) * (w[0] - u[0]);
  const d1 = d(p, q, a), d2 = d(p, q, b), d3 = d(a, b, p), d4 = d(a, b, q);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0))
    && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** 有几层竖直面横在 p→q 之间（俯视二维；竖直崖壁在俯视图上就是线段，横着挡住即挡住）。 */
function crossings(ms: MetricSpace, p: [number, number], q: [number, number], skip?: MetricReflector): number {
  let n = 0;
  for (const other of ms.reflectors) {
    if (other === skip || other.horizontal) continue;
    if (segmentsCross(p, q, other.a, other.b)) n += 1;
  }
  return n;
}

/** 挡了 n 层折成衰减：一层去掉大半，两层以上基本听不见；不做硬剔除，边界处不会"啪"地消失。 */
function blockedFactor(n: number): number {
  return n === 0 ? 0 : Math.min(0.95, 0.7 + 0.15 * (n - 1));
}

/**
 * 遮挡：听者 → 反射面中点、声源 → 反射面中点两条线，任一条被别的面挡住就衰减（取重的那条）。
 * 自己喊时两条是同一条。
 */
function occlusionFactor(ms: MetricSpace, self: MetricReflector): number {
  if (!ms.occlusion) return 0;
  const mid: [number, number] = [(self.a[0] + self.b[0]) / 2, (self.a[1] + self.b[1]) / 2];
  const fromL = crossings(ms, [ms.L.x, ms.L.z], mid, self);
  const fromS = (ms.S.x === ms.L.x && ms.S.z === ms.L.z) ? fromL : crossings(ms, [ms.S.x, ms.S.z], mid, self);
  return blockedFactor(Math.max(fromL, fromS));
}

export interface CollectOptions {
  /** 覆盖作者态听者位置（运行时绑定实体/相机时用），**wu**，脚下地面点（耳高另加）。 */
  listener?: AcousticListener;
  /** 直接给耳朵的绝对位置（wu）；给了就不看 `listener` 也不加耳高。运行时听者就是这个形状。 */
  ear?: AcousticPoint;
  /** 发声点的绝对位置（wu）。不给 = 自己喊（声源与听者同位）。 */
  source?: AcousticPoint;
  /** 听者朝向（世界单位向量）；方位角以它的水平分量为正前。不给 = +Z（看进画面）。 */
  forward?: [number, number, number];
}

/** 直达声：声源 → 听者不经反射那一记。 */
export interface DirectPath {
  /** 路径长，米（已含距离缩放） */
  length: number;
  delay: number;
  /** 到达方位角，弧度，0 = 正前（+Z），正值向右 */
  azimuth: number;
  elevation: number;
  /** 距离衰减 0..1（不含遮挡） */
  gain: number;
  /** 被竖直面挡掉了多少（0＝没挡） */
  occluded: number;
  /** 超过 `maxDistanceM`：不播 */
  inaudible: boolean;
  /** 空气吸收折成的一极点低通截止（Hz） */
  cutoffHz: number;
  /** 声像 −1..1（已乘 panWidth） */
  pan: number;
}

/** 世界 XZ 偏移 → 听者系方位角（0 = 正前，正值向右） */
function azimuthIn(ms: MetricSpace, dx: number, dz: number): number {
  const xr = dx * ms.right[0] + dz * ms.right[1];
  const zf = dx * ms.fwd[0] + dz * ms.fwd[1];
  return Math.atan2(xr, zf);
}

/**
 * 直达声（有物理位置的声源才有；自己喊时 length 0、增益 1、方位 0）。
 * 距离衰减走参考距离模型（同旧脚步那套，只是单位换成声学米、参数住在空间里）；
 * 被竖直崖壁横着挡住的声源闷下去（与反射同一套遮挡）。
 */
export function directPath(space: AcousticSpaceDef, opts: CollectOptions = {}): DirectPath {
  const ms = toMetric(space, opts);
  const p = directParams(space);
  const { L, S, c } = ms;
  const dx = S.x - L.x, dy = S.y - L.y, dz = S.z - L.z;
  const flat = Math.hypot(dx, dz);
  const length = Math.hypot(flat, dy);
  const ref = Math.max(p.refDistanceM, 1e-6);
  const gain = length <= ref ? 1 : ref / (ref + Math.max(0, p.rolloff) * (length - ref));
  const occ = ms.occlusion && length > 1e-6
    ? blockedFactor(crossings(ms, [L.x, L.z], [S.x, S.z]))
    : 0;
  const azimuth = length > 1e-6 ? azimuthIn(ms, dx, dz) : 0;
  return {
    length,
    delay: length / c,
    azimuth,
    elevation: length > 1e-6 ? Math.atan2(dy, Math.max(1e-6, flat)) : 0,
    gain: clamp01(gain),
    occluded: occ,
    inaudible: length > p.maxDistanceM,
    cutoffHz: airCutoffHz(length),
    pan: clamp(Math.sin(azimuth) * p.panWidth, -1, 1),
  };
}

/** 收集一阶与二阶抽头。二阶距离必然更长，不会侵占原声与首回之间那段空白。 */
export function collectTaps(space: AcousticSpaceDef, opts: CollectOptions = {}): AcousticTap[] {
  const ms = toMetric(space, opts);
  const { L, S, c } = ms;
  const taps: AcousticTap[] = [];

  const push = (
    horiz: { x: number; z: number }, dy: number, gain: number,
    order: 1 | 2, ids: string[], occ: number, hitM: MetricPoint,
  ) => {
    const dx = horiz.x - L.x, dz = horiz.z - L.z;
    const flat = Math.hypot(dx, dz);
    const length = Math.hypot(flat, dy);
    if (length < 0.5 || gain < 1e-5) return;
    const g = gain * (1 - occ);
    if (g < 1e-5) return;
    const w = ms.wuPerM;
    taps.push({
      order, length, delay: length / c,
      azimuth: azimuthIn(ms, dx, dz),
      elevation: Math.atan2(dy, Math.max(1e-6, flat)),
      gain: g, reflectorIds: ids, occluded: occ || undefined,
      hit: [hitM.x * w, hitM.y * w, hitM.z * w],
    });
  };

  // 竖直面上的反射点高度：声源与听者耳高的中点，钳到面的上下边缘之间。
  // 自己喊且面平齐 ⇒ 就是耳高（竖直分量 0）；面在头顶 ⇒ 钳到下边缘，路径抬上去再回来。
  // 竖直分量按两段腿算（源→反射点、反射点→耳），方向取「反射点相对耳朵」的正负给仰角用。
  const vertLeg = (reflY: number) => {
    const legs = Math.abs(S.y - reflY) + Math.abs(reflY - L.y);
    return reflY >= L.y ? legs : -legs;
  };

  for (const r of ms.reflectors) {
    const occ = occlusionFactor(ms, r);
    if (r.horizontal) {
      // 水平面（水面 / 岩檐）：声源关于平面 y=r.y 的镜像；自己喊时就是上下走一个来回
      const dy = (2 * r.y - S.y) - L.y;
      const flat = Math.hypot(S.x - L.x, S.z - L.z);
      const len = Math.hypot(flat, dy);
      if (len < 0.5) continue;
      const g = solidAngleGain(reflectorArea(r), len) * (1 - clamp01(r.absorb));
      push({ x: S.x, z: S.z }, dy, g, 1, [r.id], occ, { x: (S.x + L.x) / 2, z: (S.z + L.z) / 2, y: r.y });
      continue;
    }
    // 竖直崖壁：平面内镜像声源；反射点的高度被钳到面的上下边缘之间——
    // 头顶那片崖壁确实比平齐的远（这是仰角在竖直面上唯一真正起作用的地方）
    const img = mirror2({ x: S.x, z: S.z }, r);
    const reflY = clamp((S.y + L.y) / 2, r.y, r.y + r.height);
    const dy = vertLeg(reflY);
    const flat = Math.hypot(img.x - L.x, img.z - L.z);
    const g = solidAngleGain(reflectorArea(r), Math.hypot(flat, dy))
      * (1 - clamp01(r.absorb));
    const hp = nearestOnSegment({ x: (S.x + L.x) / 2, z: (S.z + L.z) / 2 }, r);
    push(img, dy, g, 1, [r.id], occ, { x: hp.x, z: hp.z, y: reflY });
  }

  if (ms.order >= 2) {
    const vertical = ms.reflectors.filter((r) => !r.horizontal);
    for (const r1 of vertical) {
      const img1 = mirror2({ x: S.x, z: S.z }, r1);
      const a1 = reflectorArea(r1);
      const flat1 = Math.hypot(img1.x - L.x, img1.z - L.z);
      const occ1 = occlusionFactor(ms, r1);
      const hp1 = nearestOnSegment({ x: (S.x + L.x) / 2, z: (S.z + L.z) / 2 }, r1);
      const y1 = clamp((S.y + L.y) / 2, r1.y, r1.y + r1.height);
      for (const r2 of vertical) {
        if (r2 === r1) continue;
        const img2 = mirror2(img1, r2);
        const flat2 = Math.hypot(img2.x - L.x, img2.z - L.z);
        const g = solidAngleGain(a1, Math.max(1, flat1))
          * solidAngleGain(reflectorArea(r2), Math.max(1, flat2))
          * (1 - clamp01(r1.absorb)) * (1 - clamp01(r2.absorb));
        const occ = Math.min(0.95, occ1 * 0.5 + occlusionFactor(ms, r2) * 0.5);
        push(img2, vertLeg(y1), g, 2, [r1.id, r2.id], occ, { x: hp1.x, z: hp1.z, y: y1 });
      }
    }
  }
  taps.sort((p, q) => p.delay - q.delay);
  return taps;
}

/**
 * 首个回音到达的时刻（秒）。**干声时长必须小于它**，否则回音压在原声上。
 * 编辑器拿它做提示：给定一条干声，最近反射面至少要摆多远。
 */
export function nearestGapSeconds(space: AcousticSpaceDef, opts: CollectOptions = {}): number {
  const taps = collectTaps(space, opts);
  return taps.length ? taps[0].delay : Infinity;
}

/**
 * 一极点低通的截止频率：让它在 `refHz` 处的衰减恰好等于空气吸收给出的 dB 数。
 * 这样不必逐抽头做 FFT 就能拿到正确的高频倾斜。
 */
function airCutoffHz(lengthM: number, refHz = 4000): number {
  const aDb = airAbsorptionDbPerM(refHz) * lengthM;
  const ratio = Math.pow(10, aDb / 10) - 1;
  if (ratio <= 1e-6) return 20000;
  return Math.min(20000, refHz / Math.sqrt(ratio));
}

export interface BuildIROptions extends CollectOptions {
  sampleRate?: number;
  /** 直达声是否包含在 IR 里。走 wet/dry 分开总线时应为 false（默认）。 */
  includeDirect?: boolean;
  seed?: number;
  /**
   * 只要哪一部分：`early` = 离散反射（随声源位置变，运行时按声源格子各建一条）；
   * `tail` = 晚期尾（与声源无关，全空间共用一条，起点仍在首回之后）；缺省 `all`。
   */
  part?: 'all' | 'early' | 'tail';
  /**
   * `part: 'tail'` 时把尾巴放在第 0 样本（不留首回之前的空白）：运行时在卷积器前面串一个 DelayNode
   * 给起点，听者一动只改延迟不重建尾巴（重建一次 5 秒立体声尾巴实测 40ms，与早期反射一起就是 80ms，超预算一倍）。
   */
  tailAtZero?: boolean;
  /**
   * 返回**暂存缓冲的视图**而不是拷贝，只在下一次调用之前有效。
   *
   * 默认 false ——「拿两条 IR 做对比，第二条把第一条覆盖了」是典型的静默失效，
   * 默认必须安全。只有立刻把数据 `set()` 进 AudioBuffer 的热路径才该开它
   * （每次少分配两条 20 多万长的数组，实测把重算耗时的抖动压下去）。
   */
  transient?: boolean;
}

/**
 * 晚期尾的缓存。**尾巴的内容与听者位置无关**——只有起始偏移会变。
 * 听者一动就重生成 21.6 万样本×2 声道的噪声（每样本一次 exp）实测要 75ms，
 * 主线程直接卡一帧。缓存之后重算降到个位数毫秒。
 */
const tailCache = new Map<string, { l: Float32Array; r: Float32Array }>();

/**
 * IR 暂存缓冲。听者一动就新分配两条 20 多万长的 Float32Array，GC 压力实测
 * 让重算耗时在 31–49ms 之间跳。复用之后波动收窄。
 * 交给 AudioBuffer 时是 `getChannelData().set()` 拷贝，所以复用是安全的 ——
 * 调用方拿到的 subarray 只在下一次 build 之前有效，这一点写在返回值注释里。
 */
let scratchL: Float32Array = new Float32Array(0);
let scratchR: Float32Array = new Float32Array(0);

function scratch(n: number): [Float32Array, Float32Array] {
  if (scratchL.length < n) {
    scratchL = new Float32Array(n);
    scratchR = new Float32Array(n);
  } else {
    scratchL.fill(0, 0, n);
    scratchR.fill(0, 0, n);
  }
  return [scratchL, scratchR];
}

function getTail(seconds: number, sr: number, seed: number): { l: Float32Array; r: Float32Array } {
  const key = `${sr}|${seconds.toFixed(4)}|${seed}`;
  const hit = tailCache.get(key);
  if (hit) return hit;
  const tl = Math.max(1, Math.round(seconds * sr));
  const l = new Float32Array(tl);
  const r = new Float32Array(tl);
  const rng = mulberry32(seed ^ 0x5bf03635);
  const kc = Math.exp((-2 * Math.PI * 1200) / sr);
  // 指数包络用**逐样本乘一个常数**推进，别每个样本算一次 exp
  const decay = Math.exp(-6.9 / tl);
  let env = 1;
  let l1 = 0, r1 = 0;
  for (let i = 0; i < tl; i++) {
    l1 = (1 - kc) * (rng() * 2 - 1) + kc * l1;
    r1 = (1 - kc) * (rng() * 2 - 1) + kc * r1;
    l[i] = l1 * env;
    r[i] = r1 * env;
    env *= decay;
  }
  const made = { l, r };
  // 只留最近几份：切空间/改尾长会换 key，无上限会随拖动无限涨
  if (tailCache.size > 8) tailCache.clear();
  tailCache.set(key, made);
  return made;
}

export function buildImpulseResponse(
  space: AcousticSpaceDef,
  opts: BuildIROptions = {},
): BuiltIR {
  const sr = opts.sampleRate ?? 48000;
  const seed = opts.seed ?? 0x9e3779b9;
  const rng = mulberry32(seed);
  const taps = collectTaps(space, opts);
  const part = opts.part ?? 'all';
  const tail = part === 'early' ? undefined : space.tail;
  const width = clamp01(space.width ?? 0.85);

  const lastDelay = taps.length ? taps[taps.length - 1].delay : 0;
  const tailAtZero = part === 'tail' && opts.tailAtZero === true;
  const totalSec = (part === 'tail' ? (tailAtZero || !taps.length ? 0 : taps[0].delay) : lastDelay) + (tail?.seconds ?? 0) + 1.2;
  const n = Math.max(1, Math.ceil(totalSec * sr));
  const [left, right] = scratch(n);
  // 峰值边写边记，省掉最后那两遍全量扫描（实测各约 9ms）
  let peak = 0;

  if (opts.includeDirect) { left[0] += 1; right[0] += 1; peak = 1; }

  for (const tap of (part === 'tail' ? [] : taps)) {
    const spreadSec = 0.004 + 0.06 * avgRough(space, tap) * (tap.length / 200);
    const burstLen = Math.max(4, Math.round(spreadSec * sr));
    const cutoff = airCutoffHz(tap.length);
    const k = Math.exp((-2 * Math.PI * cutoff) / sr);
    let lp = 0;

    const pan = Math.sin(tap.azimuth) * width;
    const gl = tap.gain * Math.cos(((pan + 1) * Math.PI) / 4);
    const gr = tap.gain * Math.sin(((pan + 1) * Math.PI) / 4);
    // 双耳时差：pan > 0（右）⇒ 右耳先到，左耳晚 itd
    const itdSec = pan * 0.0007;
    const baseL = Math.round((tap.delay + itdSec) * sr);
    const baseR = Math.round((tap.delay - itdSec) * sr);

    const burst = new Float32Array(burstLen);
    const envDecay = Math.exp(-4 / burstLen);
    let env = 1;
    let norm = 0;
    for (let i = 0; i < burstLen; i++) {
      lp = (1 - k) * (rng() * 2 - 1) * env + k * lp;
      burst[i] = lp;
      norm += lp * lp;
      env *= envDecay;
    }
    norm = Math.sqrt(norm) || 1;
    const sl = gl / norm, sr2 = gr / norm;
    for (let i = 0; i < burstLen; i++) {
      const v = burst[i];
      const il = baseL + i, ir = baseR + i;
      if (il >= 0 && il < n) {
        const x = (left[il] += v * sl);
        const ax = x < 0 ? -x : x; if (ax > peak) peak = ax;
      }
      if (ir >= 0 && ir < n) {
        const y = (right[ir] += v * sr2);
        const ay = y < 0 ? -y : y; if (ay > peak) peak = ay;
      }
    }
  }

  if (tail && tail.seconds > 0 && taps.length) {
    // ⚠ 晚期尾**延后到第一次反射之后**。从 0 起会填满原声与回音之间那段空白，
    // 山谷感就没了。（`tailAtZero` 时起点由运行时的 DelayNode 给，这里放在 0。）
    const start = tailAtZero ? 0 : Math.round(taps[0].delay * sr);
    const cached = getTail(tail.seconds, sr, seed);
    const g = tail.gain;
    const len = Math.min(cached.l.length, n - start);
    for (let i = 0; i < len; i++) {
      const idx = start + i;
      const x = (left[idx] += cached.l[i] * g);
      const ax = x < 0 ? -x : x; if (ax > peak) peak = ax;
      const y = (right[idx] += cached.r[i] * g);
      const ay = y < 0 ? -y : y; if (ay > peak) peak = ay;
    }
  }

  // 尾部低于可闻阈（相对峰值 -80dB）的那一段裁掉：拷进 AudioBuffer 的开销与长度
  // 成正比，而那段全是听不见的余数。实测 10s 的山谷 IR 能裁掉一到两秒。
  let end = n;
  if (peak > 0) {
    const floor = peak * 1e-4;
    while (end > 1) {
      const i = end - 1;
      const l = left[i] < 0 ? -left[i] : left[i];
      const r = right[i] < 0 ? -right[i] : right[i];
      if (l > floor || r > floor) break;
      end--;
    }
    // 留 20ms 余量，别把最后一点自然衰减切秃
    end = Math.min(n, end + Math.round(0.02 * sr));
  }
  if (peak > 0.98) {
    const g = 0.98 / peak;
    for (let i = 0; i < end; i++) { left[i] *= g; right[i] *= g; }
  }
  const viewL = left.subarray(0, end);
  const viewR = right.subarray(0, end);
  // 默认给拷贝：留着做对比、存文件都安全。热路径显式要 transient 才拿视图。
  const outL = opts.transient ? viewL : viewL.slice();
  const outR = opts.transient ? viewR : viewR.slice();
  return { left: outL, right: outR, sampleRate: sr, taps };
}

function avgRough(space: AcousticSpaceDef, tap: AcousticTap): number {
  const ids = new Set(tap.reflectorIds);
  const hit = space.reflectors.filter((r, i) => ids.has(r.id ?? `#${i}`));
  if (!hit.length) return 0.4;
  return hit.reduce((s, r) => s + clamp01(r.rough), 0) / hit.length;
}
