import type { LightDef } from '../data/types';
import type { Camera } from '../rendering/Camera';
import {
  DEFAULT_LIGHT_RANGE_WU, directionFromAngles,
} from '../rendering/lighting/lightPacking';
import type { LightSpace, Vec3 } from './lightSpace';

/**
 * **聚光与面光的形状 gizmo**：把「照向哪儿、张多大口、面板多大、朝哪面」这些
 * 三维量算成屏幕上的可拖手柄。
 *
 * ## 为什么这两种灯必须有形状 gizmo，点光不必
 *
 * 点光的作者面只有**位置 + 半径**两样，位置能拖、半径是一个标量，数字框够用。
 * 聚光与面光不同——它们的关键参数是**朝向**：
 *
 * · 聚光的 `dir` 是三维单位向量。人没法盲填三个分量：填出来的东西既不知道指哪，
 *   也不知道打在哪。填错的表现是「灯亮着但地上什么都没有」，与「灯坏了」无法区分。
 * · 面光的 `orientation` 同理，而且更狠：单面面光**背面完全不发光**
 *   （`lcAreaLight` 里 `dot(n, -d) <= 0` 直接 return 0），朝向填反 = 整盏灯全黑。
 *
 * 所以本文件的产物就一句话：**把方向变成画面上能拖的一个点**。
 *
 * ## 一个约定：靶点在行走面上
 *
 * 聚光的靶点解成「射线打在行走面上的那一点」，拖动时也反过来落回行走面
 * （与拖灯本体完全同一套：`groundWorldAt` → `dir = normalize(T − pos)`）。
 * 2.5D 场景里只有这一张几何，靶点没有别的地方可落。射不到地面的聚光
 * （平射/朝上）画成**悬空靶点**并标出来，不假装有交点。
 */

/** 手柄的点选半径（屏幕像素）。比灯本体的 16 小一点，避免抢灯的点击。 */
export const SHAPE_HANDLE_PICK_PX = 13;

/** 锥口/矩形边上画多少段（够圆即可，gizmo 不是渲染）。 */
const RING_SEGMENTS = 28;

export type ScreenPt = { x: number; y: number };

/** 聚光的形状 gizmo。 */
export interface SpotGizmo {
  /** 靶点（世界 wu） */
  targetWorld: Vec3;
  /** 靶点是不是真打在行走面上。false = 这盏灯根本没照到地 */
  onGround: boolean;
  /** 灯到靶点的距离（wu）——锥口半径由它 × tan(角) 得出 */
  dist: number;
  /** 灯本体的屏幕位置（画中轴线要，别再让 draw 层去找一遍投影） */
  lamp: ScreenPt;
  target: ScreenPt;
  outerRing: ScreenPt[];
  innerRing: ScreenPt[];
  outerHandle: ScreenPt;
  innerHandle: ScreenPt;
  /** 锥口平面里 +u 方向在屏幕上的单位向量与尺度（拖锥角要用） */
  uScreen: ScreenPt;
  pxPerWuU: number;
}

/** 面光的形状 gizmo。 */
export interface AreaGizmo {
  /** 四角，绕向与 `lcAreaLight` 的顶点顺序一致（−U−V, −U+V, +U+V, +U−V） */
  corners: ScreenPt[];
  center: ScreenPt;
  /** 半宽/半高手柄（+U / +V 边的中点） */
  widthHandle: ScreenPt;
  heightHandle: ScreenPt;
  /** 法线针尖（拖它改朝向） */
  normalHandle: ScreenPt;
  /** 转柄（拖它绕自身法线自转）。画在 +V 边外侧，与尺寸手柄分得开。 */
  rollHandle: ScreenPt;
  /** 当前自转角（度）。拖动时以它为起点，不累加。 */
  rollDeg: number;
  /** 正面朝不朝着我们（单面光背面全黑，这个要画出来） */
  facingCamera: boolean;
  uScreen: ScreenPt;
  vScreen: ScreenPt;
  pxPerWuU: number;
  pxPerWuV: number;
}

// ---------------------------------------------------------------- 小工具
function norm(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function add(a: Vec3, b: Vec3, k = 1): Vec3 {
  return [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
}

/**
 * 由法线 + **绕法线的自转** 推出正交基。
 * **与 shader 的 `areaAxes` 逐字同一条配方** —— 面光的四角必须与 GPU 上真正被
 * 积分的那个矩形重合，差一点就是「拖着框调，画面上亮的却是别处」。
 *
 * 前两步造出来的只是一组**参考基**（从法线算出来的，作者说了不算）；
 * 第三步的平面内旋转才是「哪边是宽」这件事的作者面。
 */
export function axesFromNormal(n0: Vec3, rollDeg = 0): { n: Vec3; u: Vec3; v: Vec3 } {
  const n = norm(n0);
  const up: Vec3 = Math.abs(n[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0];
  const u0 = norm(cross(up, n));
  const v0 = cross(n, u0);
  const r = (rollDeg * Math.PI) / 180;
  const c = Math.cos(r);
  const sn = Math.sin(r);
  return {
    n,
    u: [u0[0] * c + v0[0] * sn, u0[1] * c + v0[1] * sn, u0[2] * c + v0[2] * sn],
    v: [v0[0] * c - u0[0] * sn, v0[1] * c - u0[1] * sn, v0[2] * c - u0[2] * sn],
  };
}

/** 面光的自转角（度）。缺省 0 —— 与 `packLights` 的 `l.rollDeg ?? 0` 对齐。 */
export function areaRollOf(l: LightDef): number {
  return typeof l.rollDeg === 'number' ? l.rollDeg : 0;
}

/**
 * 一盏灯的朝向轴（聚光的射出方向 / 面光的法线）。
 *
 * **逐字照抄 `packLights` 里那一行** `l.dir ?? l.orientation ?? [0,0,-1]`：
 * gizmo 画的必须是 GPU 上真正在用的那条轴，缺省值差一点就是「画面上箭头指这边、
 * 光却打在那边」。
 *
 * ⚠ 面光缺省是 `[0,0,-1]`，**不是** `LightDef.orientation` 注释上写的
 *   「取深度场在 pos 处的法线」—— 那句已过期，代码里没有这回事。
 */
export function lightAxisOf(l: LightDef): Vec3 {
  const d = l.dir ?? l.orientation ?? [0, 0, -1];
  return norm([d[0], d[1], d[2]]);
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * 相机的**视线方向**在灯世界里是哪一条。
 *
 * 相机是正交的，`worldToScene` 明写着「丢掉深度分量」——被丢掉的正是伪世界的 qz。
 * 所以视线就是「只让 qz 变」的那条世界方向：`qToWorld([0,0,1]) − qToWorld(0)`。
 * 深度朝画面里增大，所以它就是「从相机往场景里看」的朝向。
 *
 * 手推 R 的第三列也能得到同一条，但那要求这里对 basisRows 的行/列约定不写反；
 * 走公开的 `qToWorld` 差一次减法，换来「写反了也自洽」。
 */
export function viewDirection(ls: LightSpace): Vec3 {
  const o = ls.qToWorld([0, 0, 0]);
  const z = ls.qToWorld([0, 0, 1]);
  return norm([z[0] - o[0], z[1] - o[1], z[2] - o[2]]);
}

/** 世界点 → 屏幕点（正交投影，与灯本体 gizmo 同一条路）。 */
function project(ls: LightSpace, camera: Camera, w: Vec3): ScreenPt {
  const s = ls.worldToScene(w);
  return camera.worldToScreen(s.x, s.y);
}

/**
 * 「沿某条世界轴走 1 wu，屏幕上走多少像素、朝哪个方向」。
 *
 * 有限差分而不是手推 R 的某一行：换场景/换标定自动跟着变，也不会写反符号。
 * 与 `screenPxPerHeightWu` 同一套办法。
 */
function screenAxis(
  ls: LightSpace, camera: Camera, at: Vec3, axis: Vec3,
): { dir: ScreenPt; pxPerWu: number } {
  const a = project(ls, camera, at);
  const b = project(ls, camera, add(at, axis));
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return { dir: { x: 1, y: 0 }, pxPerWu: 0 };
  return { dir: { x: dx / len, y: dy / len }, pxPerWu: len };
}

/** 以 `center` 为心、在 (u,v) 张的平面里画一圈，投到屏幕。 */
function ringScreen(
  ls: LightSpace, camera: Camera, center: Vec3, u: Vec3, v: Vec3, r: number,
): ScreenPt[] {
  const out: ScreenPt[] = [];
  for (let i = 0; i < RING_SEGMENTS; i++) {
    const t = (i / RING_SEGMENTS) * Math.PI * 2;
    const c = Math.cos(t) * r;
    const s = Math.sin(t) * r;
    out.push(project(ls, camera, [
      center[0] + u[0] * c + v[0] * s,
      center[1] + u[1] * c + v[1] * s,
      center[2] + u[2] * c + v[2] * s,
    ]));
  }
  return out;
}

/** 角度 → 该距离上的锥口半径。夹在 (0,89°) 内，89° 之外 tan 会炸。 */
function coneRadius(dist: number, deg: number): number {
  const a = Math.max(0.5, Math.min(89, deg));
  return dist * Math.tan((a * Math.PI) / 180);
}

// ---------------------------------------------------------------- 聚光
export function buildSpotGizmo(
  ls: LightSpace, camera: Camera, light: LightDef,
): SpotGizmo | null {
  if (light.kind !== 'spot' || !light.pos) return null;
  const pos: Vec3 = [light.pos[0], light.pos[1], light.pos[2]];
  const dir = lightAxisOf(light);
  const range = light.range ?? DEFAULT_LIGHT_RANGE_WU;
  // 靶点：先按真几何求交；射不到就退回「沿 dir 走一个作用半径」的悬空点。
  // 悬空是**说出来的**状态，不是兜底假装 —— 见 SpotGizmo.onGround。
  const hit = ls.groundHitAlong(pos, dir, range * 2.5);
  const targetWorld: Vec3 = hit ?? add(pos, dir, range);
  const dist = Math.max(
    Math.hypot(
      targetWorld[0] - pos[0], targetWorld[1] - pos[1], targetWorld[2] - pos[2],
    ),
    1e-3,
  );
  const { u, v } = axesFromNormal(dir);
  const rOuter = coneRadius(dist, light.outerAngleDeg ?? 40);
  const rInner = coneRadius(dist, Math.min(light.innerAngleDeg ?? 25, light.outerAngleDeg ?? 40));
  const ua = screenAxis(ls, camera, targetWorld, u);
  return {
    targetWorld,
    onGround: hit !== null,
    dist,
    lamp: project(ls, camera, pos),
    target: project(ls, camera, targetWorld),
    outerRing: ringScreen(ls, camera, targetWorld, u, v, rOuter),
    innerRing: ringScreen(ls, camera, targetWorld, u, v, rInner),
    outerHandle: project(ls, camera, add(targetWorld, u, rOuter)),
    innerHandle: project(ls, camera, add(targetWorld, u, rInner)),
    uScreen: ua.dir,
    pxPerWuU: ua.pxPerWu,
  };
}

/**
 * 拖锥口手柄 → 新的锥角（度）。
 *
 * 把「指针相对靶点的位移」投到 u 的屏幕方向上，除以尺度得世界半径，再 atan。
 * **不是累加增量**：累加会随帧率漂，而且松手再拖会接不上。
 */
export function coneAngleFromPointer(
  g: SpotGizmo, pointer: ScreenPt,
): number | null {
  if (g.pxPerWuU <= 0) return null;
  const dx = pointer.x - g.target.x;
  const dy = pointer.y - g.target.y;
  const along = dx * g.uScreen.x + dy * g.uScreen.y;
  const r = Math.max(along / g.pxPerWuU, 0);
  const deg = (Math.atan2(r, g.dist) * 180) / Math.PI;
  return Math.max(0.5, Math.min(89, deg));
}

// ---------------------------------------------------------------- 面光
/** 面光的缺省尺寸，与 `packLights` 的 fallback 同口径。 */
export function areaSizeOf(light: LightDef): [number, number] {
  const s = light.size
    ?? [DEFAULT_LIGHT_RANGE_WU * 0.3, DEFAULT_LIGHT_RANGE_WU * 0.2];
  return [Math.max(s[0], 1), Math.max(s[1], 1)];
}

export function buildAreaGizmo(
  ls: LightSpace, camera: Camera, light: LightDef,
): AreaGizmo | null {
  if (light.kind !== 'area' || !light.pos) return null;
  const c: Vec3 = [light.pos[0], light.pos[1], light.pos[2]];
  const rollDeg = areaRollOf(light);
  const { n, u, v } = axesFromNormal(lightAxisOf(light), rollDeg);
  const [w, h] = areaSizeOf(light);
  const hw = w * 0.5;
  const hh = h * 0.5;
  const corner = (su: number, sv: number): ScreenPt => project(ls, camera, [
    c[0] + u[0] * hw * su + v[0] * hh * sv,
    c[1] + u[1] * hw * su + v[1] * hh * sv,
    c[2] + u[2] * hw * su + v[2] * hh * sv,
  ]);
  const ua = screenAxis(ls, camera, c, u);
  const va = screenAxis(ls, camera, c, v);
  void n;
  // 法线针长度：取半宽半高里大的那个的 0.9 倍——针要够长才拖得动，
  // 又不能长到把整个画面横穿。
  const needle = Math.max(hw, hh) * 0.9;
  return {
    corners: [corner(-1, -1), corner(-1, 1), corner(1, 1), corner(1, -1)],
    center: project(ls, camera, c),
    widthHandle: project(ls, camera, add(c, u, hw)),
    heightHandle: project(ls, camera, add(c, v, hh)),
    normalHandle: project(ls, camera, add(c, n, needle)),
    // 转柄摆在 +V 边**外面**：与高度手柄同一条线上（Figma/Unity 的旋转柄就在这个位置），
    // 但离开一段，免得面板一小两个手柄就叠在一起。
    rollHandle: project(ls, camera, add(c, v, hh + Math.max(hw, hh) * 0.42)),
    rollDeg,
    facingCamera: dot(n, viewDirection(ls)) < 0,
    uScreen: ua.dir,
    vScreen: va.dir,
    pxPerWuU: ua.pxPerWu,
    pxPerWuV: va.pxPerWu,
  };
}

/** 拖宽/高手柄 → 新的**全**尺寸（wu）。同样是绝对投影，不累加。 */
export function areaSizeFromPointer(
  g: AreaGizmo, pointer: ScreenPt, axis: 'w' | 'h',
): number | null {
  const dirS = axis === 'w' ? g.uScreen : g.vScreen;
  const scale = axis === 'w' ? g.pxPerWuU : g.pxPerWuV;
  if (scale <= 0) return null;
  const dx = pointer.x - g.center.x;
  const dy = pointer.y - g.center.y;
  const half = (dx * dirS.x + dy * dirS.y) / scale;
  return Math.max(Math.abs(half) * 2, 1);
}

/**
 * 拖转柄 → 新的自转角（度）。
 *
 * ## 为什么不是「量屏幕上的夹角」
 *
 * 矩形是**投影**过的，屏幕上转 10° 不等于绕法线转 10°（正交投影把一个圆压成椭圆）。
 * 照着屏幕夹角改自转，转一圈会忽快忽慢，而且面板越接近侧对镜头越离谱。
 *
 * ## 正确的解法：在面板自己的平面里解
 *
 * 投影是**仿射**的，所以「中心 + a·u + b·v」投出来就是「Sc + a·Mu + b·Mv」，
 * 其中 Mu/Mv 是两条半轴各走 1 wu 在屏幕上的位移。把指针相对中心的位移 d 拿去
 * 解这个 2×2 方程得到 (a, b) —— 那就是指针在**面板平面里**的坐标，
 * 再 atan 就是真正的转角。转柄此刻在 (0, L)，所以解出来的 φ 是相对当前 roll 的增量。
 *
 * 起手基必须**冻住**（传起手那一帧的 gizmo）：gizmo 每帧按新 roll 重建，
 * 拿当帧的基去解会把已经转过的角再算一遍，转起来是加速的。
 */
export function rollFromPointer(gStart: AreaGizmo, pointer: ScreenPt): number | null {
  const mux = gStart.uScreen.x * gStart.pxPerWuU;
  const muy = gStart.uScreen.y * gStart.pxPerWuU;
  const mvx = gStart.vScreen.x * gStart.pxPerWuV;
  const mvy = gStart.vScreen.y * gStart.pxPerWuV;
  const det = mux * mvy - muy * mvx;
  // 退化：这个视角下两条半轴投影共线（面板正侧对镜头），平面里的坐标解不出来
  if (Math.abs(det) < 1e-9) return null;
  const dx = pointer.x - gStart.center.x;
  const dy = pointer.y - gStart.center.y;
  const a = (dx * mvy - dy * mvx) / det;
  const b = (mux * dy - muy * dx) / det;
  if (Math.abs(a) < 1e-9 && Math.abs(b) < 1e-9) return null;
  const phi = (Math.atan2(-a, b) * 180) / Math.PI;
  return normalizeDeg(gStart.rollDeg + phi);
}

/** 自转角规到 [-180, 180)：不规的话拖几圈就变成 3600°，读数没法看。 */
export function normalizeDeg(deg: number): number {
  let d = deg % 360;
  if (d >= 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

/**
 * 法线 ↔ 仰角/方位角。**与 `directionFromAngles` 互为逆** ——
 * 拖朝向时先解成两个角、加上位移、再由那个函数变回向量，这样拖出来的永远是单位向量，
 * 也永远落在同一族约定里（azimuth 0 = 画面深处，90 = 右）。
 */
export function anglesFromDirection(d: Vec3): { elevationDeg: number; azimuthDeg: number } {
  const n = norm(d);
  const elevationDeg = (Math.asin(Math.max(-1, Math.min(1, n[1]))) * 180) / Math.PI;
  const azimuthDeg = (Math.atan2(n[0], n[2]) * 180) / Math.PI;
  return { elevationDeg, azimuthDeg };
}

/** 每屏幕像素转多少度（拖法线针）。 */
export const NORMAL_DEG_PER_PX = 0.6;

/**
 * 拖法线针 → 新的朝向向量。
 *
 * 水平位移改方位、竖直位移改仰角（屏幕往上 = 抬头）。仰角夹在 ±89°：
 * ±90 时方位失去意义（万向锁），拖过去之后就再也转不回来了。
 */
export function normalFromPointerDelta(
  base: Vec3, dxPx: number, dyPx: number, fine: number,
): Vec3 {
  const a = anglesFromDirection(base);
  const azim = a.azimuthDeg + dxPx * NORMAL_DEG_PER_PX * fine;
  const elev = Math.max(-89, Math.min(89, a.elevationDeg - dyPx * NORMAL_DEG_PER_PX * fine));
  return directionFromAngles(elev, azim);
}

/** 拖出来的方向保留几位小数（与位置的 1 位同理由：diff 里看得懂）。 */
export function roundDir(d: Vec3): Vec3 {
  return [
    Math.round(d[0] * 1e4) / 1e4,
    Math.round(d[1] * 1e4) / 1e4,
    Math.round(d[2] * 1e4) / 1e4,
  ];
}
