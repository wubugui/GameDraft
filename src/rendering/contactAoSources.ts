/**
 * 接触 AO 方向部分的「光从哪几路来」（方向来源缺省档 `lighting`，制作人 2026-09-24 定）。
 *
 * ## 原则：影子跟角色身上看到的光一致
 *
 * 角色受光 = 间接光（probe × skyao，× 间接倍率）+ 实体灯（× 直接倍率）。接触 AO 挡的是
 * 射到地面上的这同一份光，所以每一路各算各的：
 *
 * - **间接光**：取 probe 在角色胸口的上半球来光一阶矩 `indirectUpperMoment` —— 方向、多少都与
 *   角色的间接光同一份数据（含 A7 折叠：probe 缺朝相机侧的信息，间接光与影子缺得一致）。
 *   四面均匀 → 竖直向上 → 脚下居中一团、没有方向倾向；一侧亮 → 往背光侧倾。
 * - **每盏实体灯**：各投各的影（shader 里逐像素朝灯位），不把几路方向加成一个
 *   （两盏灯在两侧时相加会抵消成一团、一强一弱时指向谁都不是的中间方向，真实是两道影）。
 * - **权重** = 这一路给脚下地面的照度 ÷ 总照度（与角色着色同一组倍率）。离得远的灯照度小，
 *   影子自然淡；没有灯就只剩间接光那一路。不设任何门槛、过渡带、回退。
 *
 * 只保留最强的 `MAX_CONTACT_AO_SOURCES` 路（片元里逐路算胶囊软影）、且占比不低于
 * `MIN_CONTACT_AO_SOURCE_SHARE`；每路都先减去 max(被挤掉那一路的权重, 下限 × 总和)，
 * 排名交替 / 跨过下限时进出的那一路权重恰为 0，不会一帧跳出一道影子。
 *
 * 铁律 0：全部在 M-world 算。probe 查表方向是 q 基，查之前 `nQ = Rᵀ·n`，结果按世界轴取。
 */
import type { PackedLights } from './lighting/lightPacking';
import { indirectEY, type ProbeCpuData } from './lighting/probeCpuSampler';

/** 片元里最多算几路胶囊软影（shader 的 uS0..uS3 与此同数）。 */
export const MAX_CONTACT_AO_SOURCES = 4;

/**
 * 占比低于这个的一路不算（与 top-K 同一个减法：每路先减 max(第 K+1 强, 这个 × 总和)，连续、不跳）。
 * 每路都会把接触片撑大到它的半影范围，权重 2e-5 的一路也照撑——真机 15 人 7.6M 屏幕像素、
 * 填充 2.7 ms/帧；这一份本来就画不出可见的暗（< 2% × 明暗）。
 */
export const MIN_CONTACT_AO_SOURCE_SHARE = 0.02;

/** 间接光上半球一阶矩的有限差分倾角：±20° 内查表法线不跨折叠边界（45° 俯角场景实测到 45° 才跨）。 */
export const INDIRECT_TILT_DEG = 20;

/**
 * 方向 AO 的仰角下限（与投影剪影同口径 25°）：再低影子拉成几倍身高的薄条，读不出来。
 * 只钳下限、不封顶——胶囊 AO 在正上方就是脚下一团，封顶会让方向过头顶时硬翻。shader 用同一个数。
 */
export const CONTACT_AO_MIN_ELEVATION_DEG = 25;

export interface ContactAoSource {
  /** true = x/y/z 是灯位（M-world wu），shader 逐像素朝它；false = x/y/z 是指向光的单位向量 */
  point: boolean;
  x: number;
  y: number;
  z: number;
  /** 从脚点看的指向光方向（M-world 单位向量，仰角已钳），CPU 端算片子覆盖范围用 */
  footDir: readonly [number, number, number];
  /** 这一路在脚下地面照度里的占比（已扣掉被挤掉那一路，所有路之和 ≤ 1） */
  weight: number;
}

type Vec3 = [number, number, number];
const LUMA = [0.2126, 0.7152, 0.0722] as const;

/** 指向光的向量 → 单位向量，仰角只钳下限（水平朝向不变）。正上方原样；朝下且无水平分量 → null。 */
export function clampAoElevation(v: readonly number[]): Vec3 | null {
  const hn = Math.hypot(v[0], v[2]);
  if (hn < 1e-9) return v[1] > 0 ? [0, 1, 0] : null;
  const el = Math.max(CONTACT_AO_MIN_ELEVATION_DEG * (Math.PI / 180), Math.atan2(v[1], hn));
  return [(v[0] / hn) * Math.cos(el), Math.sin(el), (v[2] / hn) * Math.cos(el)];
}

/**
 * 角色间接光在胸口 q 处的**上半球来光一阶矩**（M-world）：
 * 竖直分量 = 法线朝上的照度 E(up)；水平分量 = E 从朝上往该方向倾斜时的变化率
 * （倾斜时半球边界上 cos = 0，边界项为零，所以这就是 ∫上半球 L·ω dω 的水平分量，不需要假设分布）。
 * `rows` = depthConfig.M.R 三行（行主序，q→world，det=+1）。
 */
export function indirectUpperMoment(d: ProbeCpuData, q: readonly number[], rows: ArrayLike<number>): Vec3 {
  // world 方向 → q 基：nQ = Rᵀ·w
  const E = (wx: number, wy: number, wz: number): number => indirectEY(d, q,
    rows[0] * wx + rows[3] * wy + rows[6] * wz,
    rows[1] * wx + rows[4] * wy + rows[7] * wz,
    rows[2] * wx + rows[5] * wy + rows[8] * wz);
  const a = (INDIRECT_TILT_DEG * Math.PI) / 180;
  const s = Math.sin(a), c = Math.cos(a);
  return [
    (E(s, c, 0) - E(-s, c, 0)) / (2 * s),
    E(0, 1, 0),
    (E(0, c, s) - E(0, c, -s)) / (2 * s),
  ];
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** lcRectIrradiance（带符号），N 为着色法线。与 lightingCore.glsl 同式。 */
function rectIrradiance(P: Vec3, N: Vec3, vs: Vec3[]): number {
  const p = vs.map((v) => {
    const x = v[0] - P[0], y = v[1] - P[1], z = v[2] - P[2];
    const l = Math.hypot(x, y, z) || 1;
    return [x / l, y / l, z / l] as Vec3;
  });
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const a = p[i], b = p[(i + 1) % 4];
    const ax = a[1] * b[2] - a[2] * b[1], ay = a[2] * b[0] - a[0] * b[2], az = a[0] * b[1] - a[1] * b[0];
    const ln = Math.hypot(ax, ay, az);
    if (ln > 1e-6) {
      sum += Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])))
        * (ax * N[0] + ay * N[1] + az * N[2]) / ln;
    }
  }
  return sum * (0.5 / Math.PI);
}

function norm(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/**
 * 每盏实体灯给脚下地面（法线朝上）的照度亮度 + 它的来向。与角色 / 场景吃的是**同一次**
 * `packLights`，逐 kind 与 `ENTITY_SCENE_LIGHTS_GLSL` / lightingCore.glsl 同式（实体不吃灯的阴影，vis = 1）。
 * `P` = 脚点，M-world wu。
 */
export function lightGroundSources(packed: PackedLights, P: Vec3): { e: number; src: Omit<ContactAoSource, 'weight'> }[] {
  const out: { e: number; src: Omit<ContactAoSource, 'weight'> }[] = [];
  type Raw = Omit<ContactAoSource, 'weight' | 'footDir'>;
  const N: Vec3 = [0, 1, 0];
  const { a: A, b: B, c: C, d: D } = packed;
  for (let i = 0; i < packed.count; i++) {
    const o = i * 4;
    const I = B[o + 3];
    if (!(I > 0)) continue;
    const kind = Math.round(A[o + 3]);
    const lum = LUMA[0] * B[o] + LUMA[1] * B[o + 1] + LUMA[2] * B[o + 2];
    const pos: Vec3 = [A[o], A[o + 1], A[o + 2]];
    let e = 0;
    let src: Raw;
    if (kind === 0 || kind === 1) {                 // 点 / 聚
      const v: Vec3 = [pos[0] - P[0], pos[1] - P[1], pos[2] - P[2]];
      const r2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
      const r = Math.sqrt(Math.max(r2, 1e-12));
      e = I * Math.max(v[1] / r, 0) * Math.exp(-r2 / Math.max(C[o] * C[o], 1e-6)) / (r2 + C[o + 1]);
      if (kind === 1) {
        const sd = norm([D[o], D[o + 1], D[o + 2]]);
        e *= smoothstep(C[o + 3], C[o + 2], -(v[0] * sd[0] + v[1] * sd[1] + v[2] * sd[2]) / r);
      }
      src = { point: true, x: pos[0], y: pos[1], z: pos[2] };
    } else if (kind === 2) {                        // 面
      const d: Vec3 = [pos[0] - P[0], pos[1] - P[1], pos[2] - P[2]];
      const cut = Math.exp(-(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]) / Math.max(C[o] * C[o], 1e-6));
      if (cut >= 1e-4) {
        const n = norm([D[o], D[o + 1], D[o + 2]]);
        const up: Vec3 = Math.abs(n[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0];
        const u = norm([up[1] * n[2] - up[2] * n[1], up[2] * n[0] - up[0] * n[2], up[0] * n[1] - up[1] * n[0]]);
        const w: Vec3 = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
        const cr = Math.cos(C[o + 1]), sr = Math.sin(C[o + 1]);
        const hu: Vec3 = [0, 1, 2].map((k) => (u[k] * cr + w[k] * sr) * C[o + 2]) as Vec3;
        const hv: Vec3 = [0, 1, 2].map((k) => (w[k] * cr - u[k] * sr) * C[o + 3]) as Vec3;
        const twoSided = (Math.round(D[o + 3]) & 2) !== 0;
        let ok = true;
        if (!twoSided) {
          const fn = [hu[1] * hv[2] - hu[2] * hv[1], hu[2] * hv[0] - hu[0] * hv[2], hu[0] * hv[1] - hu[1] * hv[0]];
          if (fn[0] * -d[0] + fn[1] * -d[1] + fn[2] * -d[2] <= 0) ok = false;
        }
        if (ok) {
          const corner = (su: number, sv: number): Vec3 =>
            [pos[0] + su * hu[0] + sv * hv[0], pos[1] + su * hu[1] + sv * hv[1], pos[2] + su * hu[2] + sv * hv[2]];
          const ir = rectIrradiance(P, N, [corner(-1, -1), corner(-1, 1), corner(1, 1), corner(1, -1)]);
          e = I * (twoSided ? Math.abs(ir) : Math.max(ir, 0)) * cut;
        }
      }
      src = { point: true, x: pos[0], y: pos[1], z: pos[2] };
    } else if (kind === 4) {                        // 线（落雷雷身）：来向取线上离脚点最近那一点
      const seg: Vec3 = [D[o], D[o + 1], D[o + 2]];
      const len = Math.hypot(seg[0], seg[1], seg[2]);
      const w: Vec3 = [pos[0] - P[0], pos[1] - P[1], pos[2] - P[2]];
      if (len < 1e-3) {
        const r2 = w[0] * w[0] + w[1] * w[1] + w[2] * w[2];
        const r = Math.sqrt(Math.max(r2, 1e-12));
        e = I * Math.max(w[1] / r, 0) * Math.exp(-r2 / Math.max(C[o] * C[o], 1e-6)) / (r2 + C[o + 1]);
        src = { point: true, x: pos[0], y: pos[1], z: pos[2] };
      } else {
        const u: Vec3 = [seg[0] / len, seg[1] / len, seg[2] / len];
        const s0 = w[0] * u[0] + w[1] * u[1] + w[2] * u[2];
        const perp: Vec3 = [w[0] - s0 * u[0], w[1] - s0 * u[1], w[2] - s0 * u[2]];
        const b2 = perp[0] * perp[0] + perp[1] * perp[1] + perp[2] * perp[2] + C[o + 1];
        const s1 = s0 + len;
        const r0 = 1 / Math.sqrt(s0 * s0 + b2), r1 = 1 / Math.sqrt(s1 * s1 + b2);
        const lineI = (perp[1] / b2) * (s1 * r1 - s0 * r0) - u[1] * (r1 - r0);
        const t = Math.max(0, Math.min(len, -s0));
        const near: Vec3 = [w[0] + t * u[0], w[1] + t * u[1], w[2] + t * u[2]];
        e = (I / len) * Math.max(lineI, 0)
          * Math.exp(-(near[0] * near[0] + near[1] * near[1] + near[2] * near[2]) / Math.max(C[o] * C[o], 1e-6));
        src = { point: true, x: P[0] + near[0], y: P[1] + near[1], z: P[2] + near[2] };
      }
    } else {                                        // 平行光
      const dir = norm([D[o], D[o + 1], D[o + 2]]);
      e = I * Math.max(dir[1], 0);
      src = { point: false, x: dir[0], y: dir[1], z: dir[2] };
    }
    e *= lum;
    const footDir = src.point
      ? clampAoElevation([src.x - P[0], src.y - P[1], src.z - P[2]])
      : clampAoElevation([src.x, src.y, src.z]);
    if (e > 0 && footDir) out.push({ e, src: { ...src, footDir } });
  }
  return out;
}

/**
 * 间接光一路 + 各盏灯 → 片元要算的几路（按地面照度占比加权，只留最强的 K 路）。
 * `indirectMoment` 为 null（没有 probe 载荷）时只剩灯；一路都没有 → 空数组（只画简单 AO）。
 */
export function resolveContactAoSources(
  indirectMoment: readonly [number, number, number] | null,
  indirectFactor: number,
  lights: readonly { e: number; src: Omit<ContactAoSource, 'weight'> }[],
  directFactor: number,
  maxSources = MAX_CONTACT_AO_SOURCES,
): ContactAoSource[] {
  const all: { w: number; src: Omit<ContactAoSource, 'weight'> }[] = [];
  if (indirectMoment && indirectMoment[1] > 0 && indirectFactor > 0) {
    const [x, y, z] = norm([indirectMoment[0], indirectMoment[1], indirectMoment[2]]);
    const footDir = clampAoElevation([x, y, z]);
    // 地面照度 = 一阶矩的竖直分量 = E(up)
    if (footDir) all.push({ w: indirectFactor * indirectMoment[1], src: { point: false, x, y, z, footDir } });
  }
  if (directFactor > 0) for (const l of lights) all.push({ w: directFactor * l.e, src: l.src });
  const total = all.reduce((s, a) => s + a.w, 0);
  if (!(total > 0)) return [];
  all.sort((p, q) => q.w - p.w);
  const cut = Math.max(all.length > maxSources ? all[maxSources].w : 0, MIN_CONTACT_AO_SOURCE_SHARE * total);
  const out: ContactAoSource[] = [];
  for (let i = 0; i < Math.min(maxSources, all.length); i++) {
    const w = (all[i].w - cut) / total;
    if (w > 0) out.push({ ...all[i].src, weight: w });
  }
  return out;
}
