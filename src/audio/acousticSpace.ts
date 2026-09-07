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
 * ## 坐标与单位
 *
 * 平面 `(x, z)` + 高度 `y`，**单位一律米**。与视觉几何**解耦**：场景 `worldWidth`
 * 是可行走范围，不是画里的世界（跑马梁世界盒约 23 米，画上对岸在几百米外）。
 * 声学空间是作者数据，按听感调，不从碰撞盒反推。
 *
 * **听者位置可以是活的**：`anchor` + `wuPerMeter` 把场景世界坐标（wu）映射进这套
 * 米制坐标，运行时把玩家/相机的位置换算过来喂给 {@link buildImpulseResponse}，
 * 走动就会改变回音 —— 不然「实时」没有意义。
 */

/** 平面上的一段反射面。默认是竖直崖壁；`tiltDeg >= 45` 视作水平面（水面 / 岩檐）。 */
export interface AcousticReflector {
  id?: string;
  /** 端点 A，米，`[x, z]` */
  a: [number, number];
  /** 端点 B，米 */
  b: [number, number];
  /** 面高，米。与长度相乘得面积，面积决定立体角，也就决定强度。 */
  height: number;
  /** 吸收系数 0..1，岩石约 0.03–0.1 */
  absorb: number;
  /** 粗糙度 0..1，越大反射被抹得越开（石头的质感） */
  rough: number;
  /**
   * 底边高程，米，默认 0（听者脚下为 0）。
   * 竖直面：面覆盖 `[y, y + height]`，听者不在这个区间内时反射点被钳到边缘，
   * 路径随之变长——头顶那片崖壁确实比平齐的远。
   * 水平面：`y` 就是这个面所在的高度（水面给负值，岩檐给正值）。
   */
  y?: number;
  /** 倾角，度。0＝竖直崖壁（默认）；>=45 视作水平面。 */
  tiltDeg?: number;
}

/** 听者。`y` 是耳高，默认 1.6 米。 */
export interface AcousticListener { x: number; z: number; y?: number }

export interface AcousticSpaceDef {
  label?: string;
  /** 作者态的默认听者位置；运行时可被绑定的实体/相机覆盖。 */
  listener: AcousticListener;
  /** 声源位置；缺省＝与听者同位（自己喊） */
  source?: AcousticListener;
  reflectors: AcousticReflector[];
  /** 反射阶数，1 或 2。二阶把离散抽头之间填满，是「像空间」而非「像延迟器」的分水岭。 */
  order?: 1 | 2;
  /** 晚期扩散尾 */
  tail?: { seconds: number; gain: number };
  air?: { tempC?: number; humidity?: number };
  /** 立体声展开 0..1 */
  width?: number;
  /**
   * 场景世界坐标（wu）里，哪一点对应本空间的原点。
   * 有它才能把玩家/相机的位置换算进来。缺省＝场景中心。
   */
  anchor?: { x: number; y: number };
  /**
   * 多少个 wu 折合一米。缺省 88 —— 尺度锚是「角色高 150 wu」，
   * 人按 1.7 米算即 1 米 ≈ 88 wu（见 coordinate-spaces 机制卡）。
   */
  wuPerMeter?: number;
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
  /** 路径长，米 */
  length: number;
  /** 到达延迟，秒 */
  delay: number;
  /** 到达方位角，弧度，0 = 正前，正值向右 */
  azimuth: number;
  /** 到达仰角，弧度，正值在上方（目前只用于诊断，立体声输出渲染不了它） */
  elevation: number;
  /** 线性增益（未含空气吸收，那是频率相关的） */
  gain: number;
  reflectorIds: string[];
  /** 被别的面挡掉了多少（0＝没挡，1＝全挡） */
  occluded?: number;
}

/** ISO 9613-1 量级的空气吸收，10°C / 70%RH，dB per meter。 */
const ABS_F = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const ABS_A = [0.00007, 0.0002, 0.0004, 0.001, 0.003, 0.006, 0.012, 0.030, 0.090, 0.30];

export const DEFAULT_WU_PER_METER = 88;
const DEFAULT_EAR_HEIGHT = 1.6;

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

/**
 * 场景世界坐标（wu）→ 声学米制坐标。
 *
 * 尺度锚：角色高 150 wu，28 个场景恒定；人按 1.7 米算即 1 米 ≈ 88 wu。
 * ⚠ 场景 y 轴向下（画布左上为原点），声学 z 轴向前，所以这里翻一次符号。
 */
export function sceneToAcoustic(
  scene: { x: number; y: number },
  space: AcousticSpaceDef,
  fallbackAnchor?: { x: number; y: number },
): { x: number; z: number } {
  const anchor = space.anchor ?? fallbackAnchor ?? { x: 0, y: 0 };
  const per = space.wuPerMeter && space.wuPerMeter > 0
    ? space.wuPerMeter : DEFAULT_WU_PER_METER;
  return {
    x: (scene.x - anchor.x) / per,
    z: -(scene.y - anchor.y) / per,
  };
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

function isHorizontal(r: AcousticReflector): boolean {
  return (r.tiltDeg ?? 0) >= 45;
}

/** 把点 p 关于线段 ab 所在直线做镜像（平面内）。 */
function mirror2(p: { x: number; z: number }, r: AcousticReflector): { x: number; z: number } {
  const ax = r.a[0], az = r.a[1], bx = r.b[0], bz = r.b[1];
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz;
  if (len2 < 1e-9) return { x: p.x, z: p.z };
  const t = ((p.x - ax) * dx + (p.z - az) * dz) / len2;
  const projX = ax + t * dx, projZ = az + t * dz;
  return { x: 2 * projX - p.x, z: 2 * projZ - p.z };
}

function reflectorArea(r: AcousticReflector): number {
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

/**
 * 遮挡：从听者到反射面中点的直线，被别的面挡住就衰减。
 * 二维就够——竖直崖壁在俯视图上就是线段，横着挡住即挡住。
 */
function occlusionFactor(
  space: AcousticSpaceDef, L: AcousticListener, self: AcousticReflector,
): number {
  if (space.occlusion === false) return 0;
  const mid: [number, number] = [(self.a[0] + self.b[0]) / 2, (self.a[1] + self.b[1]) / 2];
  const from: [number, number] = [L.x, L.z];
  let blocked = 0;
  for (const other of space.reflectors) {
    if (other === self || isHorizontal(other)) continue;
    if (segmentsCross(from, mid, other.a, other.b)) blocked += 1;
  }
  // 一层挡住去掉大半，两层以上基本听不见；不做硬剔除，边界处不会"啪"地消失
  return blocked === 0 ? 0 : Math.min(0.95, 0.7 + 0.15 * (blocked - 1));
}

export interface CollectOptions {
  /** 覆盖作者态听者位置（运行时绑定实体/相机时用） */
  listener?: AcousticListener;
}

/** 收集一阶与二阶抽头。二阶距离必然更长，不会侵占原声与首回之间那段空白。 */
export function collectTaps(space: AcousticSpaceDef, opts: CollectOptions = {}): AcousticTap[] {
  const c = speedOfSound(space.air?.tempC ?? 5);
  const L = opts.listener ?? space.listener;
  const Ly = L.y ?? DEFAULT_EAR_HEIGHT;
  const S = space.source ?? L;
  const Sy = S.y ?? Ly;
  const taps: AcousticTap[] = [];

  const push = (
    horiz: { x: number; z: number }, dy: number, gain: number,
    order: 1 | 2, ids: string[], occ: number,
  ) => {
    const dx = horiz.x - L.x, dz = horiz.z - L.z;
    const flat = Math.hypot(dx, dz);
    const length = Math.hypot(flat, dy);
    if (length < 0.5 || gain < 1e-5) return;
    const g = gain * (1 - occ);
    if (g < 1e-5) return;
    taps.push({
      order, length, delay: length / c,
      azimuth: Math.atan2(dx, dz),
      elevation: Math.atan2(dy, Math.max(1e-6, flat)),
      gain: g, reflectorIds: ids, occluded: occ || undefined,
    });
  };

  for (const r of space.reflectors) {
    const occ = occlusionFactor(space, { ...L, y: Ly }, r);
    if (isHorizontal(r)) {
      // 水平面（水面 / 岩檐）：镜像在 y 上，路径就是上下走一个来回
      const surfY = r.y ?? 0;
      const dy = 2 * (surfY - Ly);
      const len = Math.abs(dy);
      if (len < 0.5) continue;
      const g = solidAngleGain(reflectorArea(r), len) * (1 - clamp01(r.absorb));
      push({ x: L.x, z: L.z }, dy, g, 1, [r.id ?? '?'], occ);
      continue;
    }
    // 竖直崖壁：平面内镜像；反射点的高度被钳到面的上下边缘之间——
    // 头顶那片崖壁确实比平齐的远（这是仰角在竖直面上唯一真正起作用的地方）
    const img = mirror2({ x: S.x, z: S.z }, r);
    const bottom = r.y ?? 0;
    const reflY = clamp(Sy, bottom, bottom + r.height);
    const dy = 2 * (reflY - Ly);
    const flat = Math.hypot(img.x - L.x, img.z - L.z);
    const g = solidAngleGain(reflectorArea(r), Math.hypot(flat, dy))
      * (1 - clamp01(r.absorb));
    push(img, dy, g, 1, [r.id ?? '?'], occ);
  }

  if ((space.order ?? 2) >= 2) {
    const vertical = space.reflectors.filter((r) => !isHorizontal(r));
    for (const r1 of vertical) {
      const img1 = mirror2({ x: S.x, z: S.z }, r1);
      const a1 = reflectorArea(r1);
      const flat1 = Math.hypot(img1.x - L.x, img1.z - L.z);
      const occ1 = occlusionFactor(space, { ...L, y: Ly }, r1);
      for (const r2 of vertical) {
        if (r2 === r1) continue;
        const img2 = mirror2(img1, r2);
        const flat2 = Math.hypot(img2.x - L.x, img2.z - L.z);
        const g = solidAngleGain(a1, Math.max(1, flat1))
          * solidAngleGain(reflectorArea(r2), Math.max(1, flat2))
          * (1 - clamp01(r1.absorb)) * (1 - clamp01(r2.absorb));
        const occ = Math.min(0.95, occ1 * 0.5
          + occlusionFactor(space, { ...L, y: Ly }, r2) * 0.5);
        push(img2, 0, g, 2, [r1.id ?? '?', r2.id ?? '?'], occ);
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
  const tail = space.tail;
  const width = clamp01(space.width ?? 0.85);

  const lastDelay = taps.length ? taps[taps.length - 1].delay : 0;
  const totalSec = lastDelay + (tail?.seconds ?? 0) + 0.5;
  const n = Math.max(1, Math.ceil(totalSec * sr));
  const [left, right] = scratch(n);
  // 峰值边写边记，省掉最后那两遍全量扫描（实测各约 9ms）
  let peak = 0;

  if (opts.includeDirect) { left[0] += 1; right[0] += 1; peak = 1; }

  for (const tap of taps) {
    const spreadSec = 0.004 + 0.06 * avgRough(space, tap) * (tap.length / 200);
    const burstLen = Math.max(4, Math.round(spreadSec * sr));
    const cutoff = airCutoffHz(tap.length);
    const k = Math.exp((-2 * Math.PI * cutoff) / sr);
    let lp = 0;

    const pan = Math.sin(tap.azimuth) * width;
    const gl = tap.gain * Math.cos(((pan + 1) * Math.PI) / 4);
    const gr = tap.gain * Math.sin(((pan + 1) * Math.PI) / 4);
    const itdSec = pan * 0.0007;
    const baseL = Math.round((tap.delay - itdSec) * sr);
    const baseR = Math.round((tap.delay + itdSec) * sr);

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
    // 山谷感就没了。
    const start = Math.round(taps[0].delay * sr);
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
  const hit = space.reflectors.filter((r) => ids.has(r.id ?? '?'));
  if (!hit.length) return 0.4;
  return hit.reduce((s, r) => s + clamp01(r.rough), 0) / hit.length;
}

