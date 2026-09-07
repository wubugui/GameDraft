import {
  groundWorldAt,
  raise,
  viewDirWorld,
  type SceneSpaceGeometry,
  type Vec3,
} from './sceneSpace';

/**
 * 空间化音频的几何层：把「场景坐标 wu(2D) + 离地高度」解成 **M-world wu(3D)**，
 * 再算听者与声源之间的距离与方位。
 *
 * ## 🔴 铁律 0 的音频版
 *
 * **所有距离/方位一律在 M-world、单位 wu 里算。** 场景坐标(2D、原点画布左上、y 向下)
 * 只是**作者面与输入**；q 空间只是**场景几何的来源**。两者都必须先转到 M-world 才参与计算。
 *
 * 混用不报错，只是位置不对：拿场景坐标的 y 当纵深、或拿 q 空间的量直接算 `1/r`，
 * 结果都「差不多对」而单位全错（`wuPerQUnit` 逐场景 154–880 倍）。
 *
 * 唯一的换算入口是 `src/utils/sceneSpace.ts`。本文件**一行坐标数学都不自己写**。
 *
 * ## 两级精度，且必须报出来自己在哪一级
 *
 * | 级别 | 前提 | 纵深从哪来 | 精度 |
 * |---|---|---|---|
 * | `field` | 场景有 `depthConfig` + 烘好的行走面场 | `ground_d` 真值，过 R 与 `wuPerQUnit` | 真三维 |
 * | `planar` | 没有上述任一 | 由屏幕 y 按 `planarDepthScale` 近似 | 近似，**且必须自报** |
 *
 * ⚠ `planar` 不是可有可无的兜底：全仓 36 个场景里 **8 个没有 `depthConfig`**
 * （`dev_room` + 跑马梁 / 崖墓入口 / 崖墓前段 / 崖墓前段1 / 崖墓后段 / 崖墓正式 / 牛头凼），
 * 而后面那七个正是背尸上山这一关的全部场景。只写 `field` 一条路 = 在最需要它的关卡里静默失效。
 *
 * `planar` 的模型是**声明出来的近似**，不是伪造：把场景 y 当纵深、按
 * `planarDepthScale` 折一次尺度（缺省 `1/sin45° ≈ 1.4142`，即假定 45° 俯角——
 * 实测 24/28 个有标定的场景确为 45°）。它对**横向**（声像的主要载体）是精确的，
 * 只有纵深是近似。
 */

/** 一个能发声或听声的目标。**与 `ShadowSource` 同形**，所以玩家/NPC/热点的现成适配器可直接复用。 */
export interface AudioSpaceTarget {
  /** 脚点场景坐标 wu。⚠ 必须是 `contactX` 不是 `x`：NPC 可配锚点，轨迹飞行期间 contactY 是落点。 */
  contactX: number;
  contactY: number;
  /** 离地高度 wu（耳朵/嘴/发声点）。脚步声取 0。角色高 150 wu。 */
  heightWu: number;
}

/** 解算器：唯一负责「场景坐标 + 高度 → M-world」的东西。 */
export type AudioSpaceResolver =
  | { mode: 'field'; geo: SceneSpaceGeometry }
  | { mode: 'planar'; planarDepthScale: number };

/** 缺省纵深近似系数 = 1/sin(45°)。实测 24/28 个有标定的场景俯角就是 45°。 */
export const DEFAULT_PLANAR_DEPTH_SCALE = Math.SQRT2;

export function planarResolver(planarDepthScale = DEFAULT_PLANAR_DEPTH_SCALE): AudioSpaceResolver {
  return { mode: 'planar', planarDepthScale };
}

/**
 * 场景坐标 + 离地高度 → M-world wu。
 *
 * `field` 级：`groundWorldAt` 拿行走面真深度落地，再沿 M-world 的 **Y** 抬高。
 * `planar` 级：`[x, height, −y·scale]`。**负号**是因为场景 y 向下＝向画面近处，
 * 而 M-world 的 +Z 是远离相机——写成正号会让前后景整体对调，且不报错。
 *
 * ⚠ `planar` 的绝对原点无意义（只有差值参与计算），这是刻意的：没有标定就不知道画面中心在哪。
 */
export function resolveWorld(r: AudioSpaceResolver, t: AudioSpaceTarget): Vec3 {
  if (r.mode === 'field') {
    return raise(groundWorldAt(r.geo, t.contactX, t.contactY), t.heightWu);
  }
  return [t.contactX, t.heightWu, -t.contactY * r.planarDepthScale];
}

/** 听者位姿，M-world。`right` 是从 forward×up 现算好的横向轴，声像只认它。 */
export interface AudioListener {
  pos: Vec3;
  forward: Vec3;
  up: Vec3;
  right: Vec3;
}

function norm(v: Vec3, fallback: Vec3): Vec3 {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (!(len > 1e-9)) return fallback;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/**
 * 由 forward/up 补出正交的 right，并把三轴都归一。
 *
 * ⚠ **`right = up × forward`，不是 `forward × up`。** M-world 是右手系且 forward 指向
 * 画面**里**（+Z 方向），`forward × up` 给出的是 **−X**，即整个声像左右颠倒。
 * 这个错**不会报任何错**，只是听感和画面对不上——正是坐标类 bug 的典型形态，
 * 所以下面 `cameraListener` 那条「right 必须等于 +X」的单测是硬判据，不许删。
 * （OpenGL 相机惯例里 forward 是 −Z，那种约定下才是 `forward × up`。）
 */
export function makeListener(pos: Vec3, forward: Vec3, up: Vec3): AudioListener {
  const f = norm(forward, [0, 0, 1]);
  const u0 = norm(up, [0, 1, 0]);
  const r = norm(cross(u0, f), [1, 0, 0]);
  // up 重新正交化：作者/相机给的 up 不一定严格垂直于 forward
  const u = norm(cross(f, r), [0, 1, 0]);
  return { pos, forward: f, up: u, right: r };
}

/**
 * 相机听者：**站在画面后方 `backWu` 处，沿视线看进画面**。
 *
 * 这是缺省听者，也是唯一能正确表达「推拉镜头」的那个：镜头拉远 ⇒ `backWu` 变大 ⇒
 * 一切变远变轻、声像收窄，正是「退后一步」的听感。
 *
 * ## 🔴 `backWu` 必须由 zoom 比值算，不许用可视宽度
 *
 * `Camera.getViewWidth() = screenWidth / (ppu × zoom × worldScale)`，其中
 * `ppu / zoom / worldScale` 全是**场景**属性，只有 `screenWidth` 随**窗口**变。
 * 用可视宽度当视距，玩家拉大窗口时全场声音会突然变远——那是窗口变大，不是镜头后退。
 *
 * 正确量：`backWu = backAtBaseZoomWu × (sceneBaseZoom / zoom)`。
 * zoom == sceneBaseZoom（进场景的缺省）时恒为 `backAtBaseZoomWu`，逐场景一致；
 * 而 wu 是有物理锚的尺（角色高 150 wu），所以同一个数在每个场景意思相同。
 */
export function cameraListener(
  r: AudioSpaceResolver,
  cameraSceneX: number,
  cameraSceneY: number,
  backWu: number,
  forward?: Vec3,
): AudioListener {
  const f = forward ?? (r.mode === 'field' ? viewDirWorld(r.geo) : planarViewDir(r));
  // 画面中心在地面上的那一点：与声源同一条解算链，保证两者可直接相减
  const center = resolveWorld(r, { contactX: cameraSceneX, contactY: cameraSceneY, heightWu: 0 });
  const pos: Vec3 = [
    center[0] - f[0] * backWu,
    center[1] - f[1] * backWu,
    center[2] - f[2] * backWu,
  ];
  // up 取真·世界上方；makeListener 会把它对 forward 正交化
  return makeListener(pos, f, [0, 1, 0]);
}

/**
 * `planar` 级的视线方向。
 *
 * 必须与 field 级 `R·(0,0,1) = (0, −sinθ, +cosθ)` **逐分量同号**：两级的 +Z 都是
 * 「远离相机」（planar 里 `world.z = −y·scale`，屏幕上方 y 小 ⇒ z 大 ⇒ 远）。
 * z 写成负号不会报错，只会让 `right` 翻向、整个声像左右颠倒——单测锁着这一条。
 */
function planarViewDir(r: Extract<AudioSpaceResolver, { mode: 'planar' }>): Vec3 {
  void r;
  return norm([0, -Math.SQRT1_2, Math.SQRT1_2], [0, 0, 1]);
}

/** 实体听者：把某个目标的耳朵当听者。朝向沿用相机视线（2.5D 里实体没有可听的朝向）。 */
export function targetListener(
  r: AudioSpaceResolver,
  t: AudioSpaceTarget,
  forward?: Vec3,
): AudioListener {
  const f = forward ?? (r.mode === 'field' ? viewDirWorld(r.geo) : planarViewDir(r));
  return makeListener(resolveWorld(r, t), f, [0, 1, 0]);
}

export interface SpatialParams {
  /** 参考距离 wu：近于此不再变响。角色高 150 wu，缺省 150 = 一个身高。 */
  refDistanceWu: number;
  /** 衰减系数。WebAudio `inverse` 模型的 rolloffFactor 同义。 */
  rolloff: number;
  /**
   * 超过此距离一律静音（省掉远处声源的播放）。
   *
   * ⚠ 用相机听者时，**画面正中的声源距离听者也有 `backWu`**（听者站在画面后方）。
   * 所以 `maxDistanceWu` 必须显著大于 `backWu`，否则连脚下的声音都会被判成听不见。
   */
  maxDistanceWu: number;
  /** 声像宽度上限 0..1。1 = 允许全左/全右；缺省 0.7，留一点中间感。 */
  panWidth: number;
}

export const DEFAULT_SPATIAL_PARAMS: SpatialParams = {
  refDistanceWu: 150,
  rolloff: 1,
  maxDistanceWu: 3000,
  panWidth: 0.7,
};

export interface SpatialResult {
  /** 距离衰减增益 0..1（**不含**通道音量与素材基准音量）。 */
  gain: number;
  /** 声像 −1(全左) .. +1(全右)，已乘 panWidth。 */
  pan: number;
  /** 听者到声源的三维距离，wu。 */
  distanceWu: number;
  /** 超出 maxDistanceWu：调用方应当整个跳过这次播放。 */
  inaudible: boolean;
}

/**
 * 听者 + 声源(M-world) → 增益与声像。
 *
 * ## 距离衰减用 WebAudio 的 `inverse` 模型原式，不自己拟合
 *
 * `gain = ref / (ref + rolloff × (max(d, ref) − ref))`
 *
 * 照抄规范式而不是「调一个听起来对的曲线」：拟合出来的曲线换个场景/换个 refDistance
 * 就不成立，而这条是有物理意义的（点声源反平方律的工程化形式），换参数仍然自洽。
 *
 * ## 声像取方向在听者横轴上的投影
 *
 * `pan = dot(normalize(src − listener), right) × panWidth`
 *
 * 这条式子对「听者就是相机」与「听者是某个实体」是**同一条**，没有特例：
 * 相机听者时 `right` 恰好是 M-world 的 +X＝屏幕右，于是退化成「看到在左边就听在左边」；
 * 而听者被设成别人时，它自动变成那个人的左右。
 *
 * 听者站在画面后方 `backWu` 处这一点顺带解决了退化情形：`src − listener` 永远不为零向量，
 * 声源贴到听者正上方时声像也不会乱跳。
 */
export function spatialize(
  listener: AudioListener,
  sourceWorld: Vec3,
  params: SpatialParams,
): SpatialResult {
  const dx = sourceWorld[0] - listener.pos[0];
  const dy = sourceWorld[1] - listener.pos[1];
  const dz = sourceWorld[2] - listener.pos[2];
  const d = Math.hypot(dx, dy, dz);

  const ref = Math.max(params.refDistanceWu, 1e-6);
  const gain = ref / (ref + Math.max(0, params.rolloff) * (Math.max(d, ref) - ref));

  let pan = 0;
  if (d > 1e-9) {
    const dot = (dx * listener.right[0] + dy * listener.right[1] + dz * listener.right[2]) / d;
    pan = Math.max(-1, Math.min(1, dot)) * Math.max(0, Math.min(1, params.panWidth));
  }

  return {
    gain: Math.max(0, Math.min(1, gain)),
    pan,
    distanceWu: d,
    inaudible: d > params.maxDistanceWu,
  };
}

/**
 * `wuPerQUnit` 的可疑值判据。
 *
 * `SceneLightingSystem.wuPerQUnit` 在没有载荷时返回 `?? 1`，而真值逐场景是 **154–880**。
 * 拿 1 去算，听者与声源的坐标会缩在 ±2 的 q 尺度上，任何按 wu 定的 `refDistanceWu`
 * 都会让整场声音要么全满幅要么全静音——**不报错**。同族事故在光照侧已发生过两次
 * （角色自落地起没吃到过一盏点光而日志照打；编辑器摆灯位置全错）。
 *
 * 所以音频侧一律把 1 当**可疑值**拒绝，退到 `planar`，而不是当合法缺省接受。
 */
export function isSuspectWuPerQUnit(v: number | null | undefined): boolean {
  return !(typeof v === 'number') || !Number.isFinite(v) || v <= 1.0000001;
}
