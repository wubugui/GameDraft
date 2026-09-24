/**
 * 一道雷的形状（纯计算，无 Pixi，工作台 bundle 同一份）：效果 `bolts[]` 的参数 + 种子 → 一组折线。
 *
 * 来历（2026-09-24，制作人给了 20 张室外参考图并定调「效果要和这些图对齐」）：
 * - 雷**从天上来**：任何图、任何位置都从画面顶上出去，雷顶不许悬在半空 ⇒ 主干从落点一路往上长到云底
 *   （`cloudWu`，远在任何镜头之外），但**只现算到镜头需要的高度**（`extendBolt`）：
 *   随机数按大步的步号取，往上补算与一次算完逐位相同，镜头动了形状不变；
 * - 整道雷**斜着**、走向有几处大弯（缓变的随机过程），大步之间是**尖角**（逐步偏离走向、偏向按概率翻面）；
 * - **分形**：参考图里远景图（雾津街头一个人 60 像素）和近景图（崖墓入口一个人 330 像素）的雷，
 *   折角在屏幕上一样密、分叉一样多——真闪电本来就是自相似的，拉近了看得到更小的折和更小的枝杈。
 *   所以每一大步按「中点往旁边折」逐级细分到 `detailWu`（每个点记下是第几级），渲染侧按屏幕上
 *   分得清的那一级画；分叉长短按**幂律**取（短的多、长的少，密度按 1/长度），于是任何镜头下看得见的
 *   分叉根数差不多——雷仍是世界里的同一个东西，没有一处按屏幕定。
 * - 分叉往斜下外侧走，比主干细、暗，梢上淡到没有，不落地；自己还会再分叉（同一套幂律）；
 * - 下半截更亮更粗（`lowBoost*`）。
 *
 * ## 坐标
 *
 * - `sky`：落点在原点的**直立面**上，`x` = 画面横向（wu，向右为正），`y` = 离落点多高（wu，向上为正）。
 *   渲染侧按落点那一处的透视系数把它换成场景坐标，与角色同一把尺（人高 150 wu）。
 * - `surface`：贴着地面 / 水面，`x` / `y` = 相对落点的世界 X / Z 偏移（wu）。
 *
 * 所有长度是**真实世界 wu**（透视场景里远处的雷画出来更小，那一步在渲染侧，与粒子尺寸同一条）。
 */
import type { VfxBoltDef, VfxBoltSkyShapeDef, VfxBoltSurfaceShapeDef } from '../../data/types';
import { VfxRng } from './vfxRandom';

const DEG = Math.PI / 180;
/** 主干走向离竖直最多偏这么多（再斜就不像从天上劈下来的了） */
const MAX_HEADING = 75 * DEG;
/** 往下长的分叉最低到离地这么高（wu）…… */
const BRANCH_FLOOR_WU = 30;
/** ……且不低于它出发高度的这一成（长在高处的分叉在高处就淡掉了） */
const BRANCH_FLOOR_FRAC = 0.3;
/** 细分最多几级（防参数把点数炸开：大步 400 wu 细到 3 wu 是 7 级） */
const MAX_LEVEL = 9;
/** 细分时段长在这以下按满 `roughness` 折，以上按 √(它/段长) 收（见 `subdivide`） */
const ROUGH_FULL_WU = 40;

/** 一条折线：点在 `[start, start + count)` */
export interface BoltLine {
  start: number;
  count: number;
  /** 0 = 主干，1.. = 第几级分叉 */
  depth: number;
  /** 这条线的总长（wu）：渲染侧按它在屏幕上多长决定画不画（太短的枝杈远看是一个亮点） */
  len: number;
  /** `meanSeg[L]` = 只取 `level ≤ L` 的点时平均一段多长（wu）；渲染侧据此挑画到第几级 */
  meanSeg: number[];
}

/**
 * 一道雷的几何。点存成平行数组，`level[i]` = 这个点是第几级细分出来的（0 = 大步的端点）：
 * 渲染侧只取 `level ≤ L` 的点就得到一条"粗到 L 级"的折线（芯按屏幕上分得清的最细一级、光晕按光晕宽那一级）。
 */
export interface BoltGeometry {
  kind: 'sky' | 'surface';
  x: number[];
  y: number[];
  /** 逐点亮度倍率（分叉往梢上淡到 0、下半截加亮） */
  inten: number[];
  /** 逐点粗细倍率 */
  width: number[];
  level: number[];
  lines: BoltLine[];
  /** 已经算到多高（`sky`；`surface` 一次算完 = Infinity） */
  builtTo: number;
  /** 包围盒（已算出的全部点，含分叉；wu） */
  x0: number; x1: number; y0: number; y1: number;
  /** 往上续算的状态（`sky`） */
  grow: SkyGrowState | null;
}

interface SkyGrowState {
  P: VfxBoltSkyShapeDef;
  seed: number;
  /** 下一大步的步号 */
  k: number;
  x: number;
  y: number;
  /** 大弯（OU 过程）当前值（弧度） */
  bend: number;
  /** 上一步的偏向（±1） */
  side: number;
  /** 整体走向（弧度，左右已定） */
  tilt: number;
}

/** 两个种子混成一个（splitmix 风格，无状态） */
export function mixBoltSeed(a: number, b: number): number {
  let h = (Math.imul((a >>> 0) ^ 0x9e3779b9, 0x85ebca6b) ^ (b >>> 0)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  return (h ^ (h >>> 15)) >>> 0;
}

/**
 * 这一次的雷形种子 = 实例种子 × 落点世界坐标（取整）。渲染侧画雷与落雷演出摆灯**共用这一个**
 * （灯沿着画出来的那道雷身摆）。落点混进来：雷符的 effectSeed 恒 0，不混的话同一个效果每次劈出来一模一样。
 */
export function boltInstanceSeed(instanceSeed: number, anchorWorld: readonly number[]): number {
  const posSeed = mixBoltSeed(mixBoltSeed(Math.round(anchorWorld[0]), Math.round(anchorWorld[1])), Math.round(anchorWorld[2]));
  return mixBoltSeed(instanceSeed >>> 0, posSeed);
}

function rngAt(seed: number, k: number, salt: number): VfxRng {
  return new VfxRng(mixBoltSeed(mixBoltSeed(seed, k | 0), salt));
}

/** 标准正态（Box–Muller，一次取一个） */
function gauss(r: VfxRng): number {
  const u = Math.max(1e-12, r.next());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r.next());
}

function lo(r: readonly [number, number]): number { return Math.min(r[0], r[1]); }
function hi(r: readonly [number, number]): number { return Math.max(r[0], r[1]); }

function emptyGeometry(kind: 'sky' | 'surface'): BoltGeometry {
  return {
    kind, x: [], y: [], inten: [], width: [], level: [], lines: [],
    builtTo: 0, x0: 0, x1: 0, y0: 0, y1: 0, grow: null,
  };
}

/**
 * 中点往旁边折，逐级细分到段长不超过 `detail`。输入 = 大步的端点（level 0），输出按沿线顺序、
 * 每个点带自己的级数。偏移 = 本级段长 × `rough` × U(−1,1)，垂直于本级那一段——自相似，每一级的折都是尖角。
 */
function subdivide(
  jx: readonly number[], jy: readonly number[], rough: number, detail: number,
  rngOf: (seg: number) => VfxRng,
): { x: number[]; y: number[]; lv: number[]; seg: number[]; sub: number[] } {
  // seg / sub：每个输出点属于第几大步、是那一步里的第几个点（起点记 −1 / 0）——给按点取随机数的调用方一个
  // 与「这次从哪开始算」无关的坐标
  const ox: number[] = [jx[0]], oy: number[] = [jy[0]], lv: number[] = [0], sg: number[] = [-1], sb: number[] = [0];
  for (let s = 1; s < jx.length; s++) {
    const r = rngOf(s - 1);
    const ax = jx[s - 1], ay = jy[s - 1], bx = jx[s], by = jy[s];
    const len = Math.hypot(bx - ax, by - ay);
    let depth = 0;
    while (depth < MAX_LEVEL && len / (1 << depth) > detail) depth++;
    // 一大步细分成 2^depth 小段：按层填（先 1/2，再 1/4、3/4……），父段端点决定子段的垂直方向
    const n = 1 << depth;
    const px = new Array<number>(n + 1), py = new Array<number>(n + 1), pl = new Array<number>(n + 1);
    px[0] = ax; py[0] = ay; pl[0] = 0; px[n] = bx; py[n] = by; pl[n] = 0;
    for (let d = 1; d <= depth; d++) {
      const step = n >> d;
      for (let i = step; i < n; i += step * 2) {
        const a = i - step, b = i + step;
        const sx = px[b] - px[a], sy = py[b] - py[a];
        const sl = Math.hypot(sx, sy);
        // 大尺度折得轻、小尺度折得碎：段长超过 ROUGH_FULL_WU 的那几级按 √(ROUGH_FULL_WU/段长) 收着折。
        // 不收的话近景图（崖墓入口、河边一个人两三百像素）里看到的只是一道大弯的一截——整道雷斜成一条斜线，
        // 参考图里近景的雷照样是陡的、带中小折角
        const off = (r.next() * 2 - 1) * rough * sl * Math.min(1, Math.sqrt(ROUGH_FULL_WU / Math.max(sl, 1e-6)));
        const nx = sl > 1e-9 ? -sy / sl : 0, ny = sl > 1e-9 ? sx / sl : 0;
        px[i] = (px[a] + px[b]) * 0.5 + nx * off;
        py[i] = (py[a] + py[b]) * 0.5 + ny * off;
        pl[i] = d;
      }
    }
    for (let i = 1; i <= n; i++) { ox.push(px[i]); oy.push(py[i]); lv.push(pl[i]); sg.push(s - 1); sb.push(i); }
  }
  return { x: ox, y: oy, lv, seg: sg, sub: sb };
}

function pushLine(
  g: BoltGeometry, depth: number, x: number[], y: number[], lv: number[],
  intenAt: (t01: number, y: number) => number, widthAt: (t01: number, y: number) => number,
): number {
  const n = x.length;
  if (n < 2) return -1;
  let total = 0;
  for (let i = 1; i < n; i++) total += Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]);
  const start = g.x.length;
  let acc = 0;
  let maxLv = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) acc += Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]);
    const u = total > 1e-9 ? acc / total : 0;
    g.x.push(x[i]); g.y.push(y[i]); g.level.push(lv[i]);
    g.inten.push(intenAt(u, y[i])); g.width.push(widthAt(u, y[i]));
    if (lv[i] > maxLv) maxLv = lv[i];
    if (x[i] < g.x0) g.x0 = x[i];
    if (x[i] > g.x1) g.x1 = x[i];
    if (y[i] < g.y0) g.y0 = y[i];
    if (y[i] > g.y1) g.y1 = y[i];
  }
  // 各级的平均段长：只取 level ≤ L 的点连成的折线（端点 level 0 总在里面）
  const perLv = new Array<number>(maxLv + 1).fill(0);
  for (let i = 0; i < n; i++) perLv[lv[i]]++;
  const meanSeg: number[] = [];
  let cnt = 0;
  for (let L = 0; L <= maxLv; L++) {
    cnt += perLv[L];
    meanSeg.push(total / Math.max(1, cnt - 1));
  }
  g.lines.push({ start, count: n, depth, len: total, meanSeg });
  return g.lines.length - 1;
}

/**
 * 分叉长度的幂律指数：P(长 > l) ∝ l^-α。α = 1 时任何镜头下看得见的分叉根数完全一样；
 * 参考图里远景图（雾津街头、跑马梁）的分叉明显比近景图（崖墓入口）多，取 0.7（长分叉多一点）。
 */
const BRANCH_POWER = 0.7;

/** 幂律取长度：`[a, b]` 里短的多、长的少 */
function paretoLen(r: VfxRng, a: number, b: number): number {
  const lo_ = Math.max(1e-3, Math.min(a, b)), hi_ = Math.max(a, b);
  // 截断的 Pareto：CDF 反函数采样
  const la = Math.pow(lo_, -BRANCH_POWER), lb = Math.pow(hi_, -BRANCH_POWER);
  return Math.pow(la - r.next() * (la - lb), -1 / BRANCH_POWER);
}

interface BranchShape {
  kinkDeg: [number, number];
  roughness: number;
  detailWu: number;
  branchMinWu: number;
  branchMaxWu: number;
  forkPerKWu: number;
  forkDepth: number;
}

/**
 * 一根分叉（及它的再分叉）：从 (x, y) 出发、朝 `heading`（弧度；`down` 时 0 = 竖直向下，否则是平面里的朝向）
 * 走 `len`，大步是尖角折线、再按分形细分；沿途按幂律再分叉（深度到 `forkDepth` 为止）。
 * 亮度从 `i0` 淡到 0、粗细从 `w0` 收到四成。
 */
function growBranch(
  g: BoltGeometry, S: BranchShape, r: VfxRng, x: number, y: number, heading: number, len: number,
  i0: number, w0: number, depth: number, down: boolean,
): void {
  const jx = [x], jy = [y];
  let walked = 0;
  let side = r.next() < 0.5 ? -1 : 1;
  // 分叉的大步随分叉长短缩放（短枝杈是几折小折，长分叉是几折大折）：一根分叉 3–6 大步
  const nSteps = 3 + Math.floor(r.next() * 4);
  const step = len / nSteps;
  const floor = down ? Math.max(BRANCH_FLOOR_WU, y * BRANCH_FLOOR_FRAC) : -Infinity;
  let cx = x, cy = y;
  while (walked < len - 1e-6) {
    const seg = Math.min(len - walked, step * r.range(0.7, 1.3));
    if (r.next() < 0.7) side = -side;
    const h = heading + side * r.range(lo(S.kinkDeg), hi(S.kinkDeg)) * DEG;
    const nx = cx + Math.sin(h) * seg;
    const ny = cy + (down ? -Math.cos(h) * seg : Math.cos(h) * seg);
    if (ny < floor) break;
    cx = nx; cy = ny;
    jx.push(cx); jy.push(cy);
    walked += seg;
  }
  if (jx.length < 2) return;
  const sub = subdivide(jx, jy, S.roughness, S.detailWu, () => r);
  const li = pushLine(g, depth, sub.x, sub.y, sub.lv, (t) => i0 * (1 - t) * (1 - t * 0.3), (t) => w0 * (1 - 0.6 * t));
  if (li < 0 || depth >= S.forkDepth || S.forkPerKWu <= 0) return;
  // 再分叉：沿这根分叉按长度的泊松过程，长度按幂律（不超过母枝剩下的长度）
  const L = g.lines[li];
  let acc = 0;
  for (let i = L.start + 1; i < L.start + L.count; i++) {
    const seg = Math.hypot(g.x[i] - g.x[i - 1], g.y[i] - g.y[i - 1]);
    acc += seg;
    const left = L.len - acc;
    if (left < S.branchMinWu * 2) break;
    if (r.next() >= (S.forkPerKWu / 1000) * seg) continue;
    const fl = paretoLen(r, S.branchMinWu, Math.min(S.branchMaxWu, left * 0.8));
    const fh = heading + (r.next() < 0.5 ? -1 : 1) * r.range(20, 45) * DEG;
    growBranch(g, S, r, g.x[i], g.y[i], fh, fl, g.inten[i] * 0.7, g.width[i] * 0.75, depth + 1, down);
  }
}

/** 新建一道雷的几何（`sky` 只先建状态，按需 `extendBolt` 往上补） */
export function createBolt(def: VfxBoltDef, instanceSeed: number): BoltGeometry {
  const seed = mixBoltSeed(def.seed ?? 0, instanceSeed >>> 0);
  if (def.kind === 'surface') return buildSurface(def.surface!, seed);
  const P = def.sky!;
  const g = emptyGeometry('sky');
  const r0 = rngAt(seed, -1, 0x71);
  const tilt = (r0.next() < 0.5 ? -1 : 1) * r0.range(lo(P.tiltDeg), hi(P.tiltDeg)) * DEG;
  g.grow = { P, seed, k: 0, x: 0, y: 0, bend: gauss(r0) * P.bendDeg * DEG * 0.5, side: r0.next() < 0.5 ? -1 : 1, tilt };
  return g;
}

/** 主干下半截的亮度倍率 */
function lowBoost(P: VfxBoltSkyShapeDef, y: number): number {
  const k = Math.max(0, P.lowBoostGain - 1);
  if (k <= 0 || !(P.lowBoostWu > 0)) return 1;
  const t = Math.max(0, y) / P.lowBoostWu;
  return 1 + k * Math.exp(-t * t);
}

/**
 * 把天上那道雷往上算到至少 `needWu` 高（再多算一截：更高处长出来往下垂的分叉也可能进画面）。
 * 已经够高 / 到了云底就什么都不做。每续一次主干多一段折线（渲染侧逐段画，段与段首尾相接、接缝不断）。
 */
export function extendBolt(g: BoltGeometry, needWu: number): void {
  const s = g.grow;
  if (!s) return;
  const P = s.P;
  const reach = Math.min(P.cloudWu, needWu + P.branchMaxWu * 0.5);
  if (g.builtTo >= reach) return;
  const jx = [s.x], jy = [s.y];
  const k0 = s.k;
  const bendLen = Math.max(1, P.bendLenWu);
  while (s.y < reach) {
    const r = rngAt(s.seed, s.k, 0x5b);
    const seg = r.range(lo(P.stepWu), hi(P.stepWu));
    // 大弯：Ornstein–Uhlenbeck，走 seg 这么远后与上一刻的相关系数 exp(-seg / bendLen)
    const a = Math.exp(-seg / bendLen);
    s.bend = s.bend * a + P.bendDeg * DEG * Math.sqrt(Math.max(0, 1 - a * a)) * gauss(r);
    if (r.next() < P.zigzag) s.side = -s.side;
    const dev = s.side * r.range(lo(P.kinkDeg), hi(P.kinkDeg)) * DEG;
    const h = Math.max(-MAX_HEADING, Math.min(MAX_HEADING, s.tilt + s.bend + dev));
    s.x += Math.sin(h) * seg;
    s.y += Math.cos(h) * seg;
    jx.push(s.x); jy.push(s.y);
    s.k++;
  }
  // 细分的随机数按**大步的步号**取（不按这一次续算从哪开始）：分几次续算与一次算完逐位相同
  const sub = subdivide(jx, jy, P.roughness, P.detailWu, (seg) => rngAt(s.seed, k0 + seg, 0x3c));
  const li = pushLine(g, 0, sub.x, sub.y, sub.lv, (_t, y) => lowBoost(P, y), (_t, y) => 1 + (lowBoost(P, y) - 1) * 0.5);
  // 分叉：沿主干按长度的泊松过程（离地 branchFromWu 起、到它的两倍高处渐渐长满），长度按幂律
  if (li >= 0 && P.branchPerKWu > 0) {
    const L = g.lines[li];
    const S: BranchShape = P;
    for (let i = L.start + 1; i < L.start + L.count; i++) {
      const y = g.y[i];
      const ramp = Math.max(0, Math.min(1, (y - P.branchFromWu) / Math.max(1, P.branchFromWu)));
      if (ramp <= 0) continue;
      const seg = Math.hypot(g.x[i] - g.x[i - 1], y - g.y[i - 1]);
      // 每个点自己的随机数，按它在**全局第几大步**、那一步里第几个点取：分几次续算与一次算完长出同一批分叉
      // （原来按「这一截从第几步开始 + 这一截里第几个点」取——画雷的那份按镜头分截续算、灯那份一次算到灯高，
      //   两份分叉对不上，挂在最长分叉上的灯照着一根画面上没有的分叉）
      const j = i - L.start;
      const r = rngAt(mixBoltSeed(s.seed, 0xb7), mixBoltSeed(k0 + sub.seg[j], sub.sub[j]), 0xb8);
      if (r.next() >= (P.branchPerKWu / 1000) * seg * ramp) continue;
      const side = r.next() < 0.5 ? -1 : 1;
      const ang = side * r.range(lo(P.branchAngleDeg), hi(P.branchAngleDeg)) * DEG;
      const len = paretoLen(r, P.branchMinWu, P.branchMaxWu);
      const i0 = r.range(lo(P.branchIntensity), hi(P.branchIntensity)) * (0.55 + 0.45 * Math.min(1, len / (P.branchMaxWu * 0.3)));
      // 分叉朝下走（0 = 竖直向下），往外偏 ang，再顺着整体歪的方向带一点
      growBranch(g, S, r, g.x[i], y, ang - s.tilt * 0.5, len, i0, P.branchWidth, 1, true);
    }
  }
  g.builtTo = s.y;
}

/** 从落点贴着地面 / 水面往外爬的一圈电弧（一次算完） */
function buildSurface(P: VfxBoltSurfaceShapeDef, seed: number): BoltGeometry {
  const g = emptyGeometry('surface');
  const r = rngAt(seed, 0, 0x2d);
  const n = Math.max(0, Math.round(r.range(lo(P.count), hi(P.count))));
  const base = r.next() * Math.PI * 2;
  const S: BranchShape = {
    kinkDeg: P.kinkDeg, roughness: P.roughness, detailWu: P.detailWu,
    branchMinWu: P.lenWu[0] * 0.2, branchMaxWu: P.lenWu[1] * 0.6, forkPerKWu: P.forkPerKWu, forkDepth: 2,
  };
  for (let i = 0; i < n; i++) {
    const rr = rngAt(seed, i + 1, 0x2e);
    const h = base + (i / Math.max(1, n)) * Math.PI * 2 + rr.range(-0.4, 0.4);
    const len = rr.range(lo(P.lenWu), hi(P.lenWu));
    const i0 = rr.range(lo(P.intensity), hi(P.intensity));
    growBranch(g, S, rr, 0, 0, h, len, i0, 1, 1, false);
  }
  g.builtTo = Infinity;
  return g;
}

/** 摆灯用的一段（局部坐标 wu）；`share` = 这一段分到雷身总亮度的几成（主干各段之和 = 1，分叉另加） */
export interface BoltLightSegment { x0: number; y0: number; x1: number; y1: number; share: number }

/**
 * 雷身的灯怎么摆：主干从落点到 `heightWu` 那一截，按大步的折点切成至多 `maxMain` 段（多了均匀抽点），
 * 每段一条线光、亮度按段长分；再加最长的 `maxBranches` 根分叉（从根到梢一条，亮度 = 分叉长 × 根部亮度，
 * 与主干同一个"每 wu 多亮"）。整道雷的**形状**都在发光，不是只有落点一个灯。
 */
export function boltLightPolylines(g: BoltGeometry, heightWu: number, maxMain: number, maxBranches: number): BoltLightSegment[] {
  if (g.kind !== 'sky' || !(heightWu > 0)) return [];
  extendBolt(g, heightWu);
  const px: number[] = [], py: number[] = [];
  for (const L of g.lines) {
    if (L.depth !== 0) continue;
    for (let i = L.start; i < L.start + L.count; i++) {
      if (g.level[i] !== 0) continue;
      const x = g.x[i], y = g.y[i];
      if (px.length > 0 && px[px.length - 1] === x && py[py.length - 1] === y) continue;
      if (y >= heightWu && px.length > 0) {
        const lx = px[px.length - 1], ly = py[py.length - 1];
        const t = y - ly > 1e-9 ? (heightWu - ly) / (y - ly) : 1;
        px.push(lx + (x - lx) * t); py.push(heightWu);
        break;
      }
      px.push(x); py.push(y);
    }
    if (py.length > 0 && py[py.length - 1] >= heightWu) break;
  }
  if (px.length < 2) return [];
  // 多了均匀抽点（首尾保留）
  const n = px.length - 1;
  const keep: number[] = [];
  const m = Math.max(1, Math.min(maxMain, n));
  for (let k = 0; k <= m; k++) keep.push(Math.round((k * n) / m));
  let total = 0;
  const segs: BoltLightSegment[] = [];
  for (let k = 1; k < keep.length; k++) {
    const a = keep[k - 1], b = keep[k];
    if (a === b) continue;
    const s = { x0: px[a], y0: py[a], x1: px[b], y1: py[b], share: 0 };
    s.share = Math.hypot(s.x1 - s.x0, s.y1 - s.y0);
    total += s.share;
    segs.push(s);
  }
  for (const s of segs) s.share /= Math.max(total, 1e-6);
  const branches = g.lines
    .filter((L) => L.depth === 1 && g.y[L.start] <= heightWu && L.count >= 2)
    .sort((a, b) => b.len - a.len)
    .slice(0, Math.max(0, maxBranches));
  for (const L of branches) {
    const a = L.start, b = L.start + L.count - 1;
    segs.push({ x0: g.x[a], y0: g.y[a], x1: g.x[b], y1: g.y[b], share: (L.len * g.inten[a]) / Math.max(total, 1e-6) });
  }
  return segs;
}

/**
 * 主干在高度 `h` 处的横向位置（wu）：沿主干折线插值（灯沿着雷身摆，用它找线光的上端）。
 * 还没算到那么高时先往上补算。
 */
export function boltAxisAt(g: BoltGeometry, h: number): number {
  if (g.kind !== 'sky') return 0;
  extendBolt(g, h);
  let px = 0, py = 0;
  for (const L of g.lines) {
    if (L.depth !== 0) continue;
    for (let i = L.start; i < L.start + L.count; i++) {
      if (g.level[i] !== 0) continue;
      const x = g.x[i], y = g.y[i];
      if (y >= h) {
        if (y - py < 1e-9) return x;
        return px + (x - px) * ((h - py) / (y - py));
      }
      px = x; py = y;
    }
  }
  return px;
}
