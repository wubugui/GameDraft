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

/**
 * 场景的**透视纵深标定**（`perspectiveScale` 的音频侧读法）。给了才重整，不给完全走正交老路。
 *
 * ## 为什么音频要吃这个
 *
 * `ground_d` 是烘焙时按 `Y(q)=qy·cosθ−d·sinθ=Yg` 解出的行走面 —— **一个 45° 斜平面，
 * 纵深与屏幕 y 基本线性，不含透视**（实测跑马梁全程 M-world 的 y 分量恒在 0.00~0.21，
 * z 均匀推进，沿视线只有 11.4 m）。而 `perspectiveScale` 说同一段路"看着远了 6.76 倍"。
 * 两套模型对不上的后果是**视听脱节**：跟随镜头下玩家缩到 1/6.76 而声音一个 dB 不变；
 * 相机顶到边界时声音还会先变大 4 dB 再变小（他先走近画面中心），画面却在单调变远。
 *
 * ## 数学（`f ∝ 1/d` 是投影定义式，不是拟合）
 *
 * `f` 是屏幕尺寸因子，透视投影下屏幕尺寸 ∝ 1/深度 ⇒ 深度 = `baseDepthWu / f`。
 * 正交反投影给的 `P_o` 里**垂直于视线的分量是准的**（横向就是屏幕横向），只有沿视线的不准：
 *
 * ```
 * P_p = [ P_o⊥ + forward × baseDepthWu ] / f      P_o⊥ = P_o − forward·(P_o·forward)
 * ```
 *
 * 深度 `D0/f`、横向 `P_o⊥/f` —— 远处横向也一起拉开，正是透视。虚拟相机取在 M-world 原点：
 * 它对所有点是同一个平移，**不影响任何两点之间的距离**，所以取哪都行。
 * 离地高度在重整**之后**才加（人在远处仍是 150 wu 高，只是看着小）。
 *
 * 与 `perspectiveAffectsSpeed` 自洽：远处步长 ×f、每单位步长的世界距离 ∝1/f，
 * 相乘是**恒定的世界速度** —— 说明作者摆透视轴时摆的就是这个关系。
 *
 * ⚠ **只重整由场景坐标解出来的点**（听者 / 玩家 / NPC / 热点）。声学空间的反射面是作者
 * 在工作台里按听感摆的 M-world 数据，与视觉几何解耦（scene-acoustics 的硬规矩），不动它。
 */
export interface AudioPerspective {
  /** 脚点处的屏幕缩放因子 f；恒 1 就等于没有透视 */
  scaleAt(sceneX: number, sceneY: number): number;
  /** `f=1` 处到虚拟相机的深度（wu）＝ 相机听者的基准视距 `backAtBaseZoomWu` */
  baseDepthWu: number;
}

/** 解算器：唯一负责「场景坐标 + 高度 → M-world」的东西。`persp` 缺省＝正交（旧行为逐位不变）。 */
export type AudioSpaceResolver =
  | { mode: 'field'; geo: SceneSpaceGeometry; persp?: AudioPerspective }
  | { mode: 'planar'; planarDepthScale: number; persp?: AudioPerspective };

/** 缺省纵深近似系数 = 1/sin(45°)。实测 24/28 个有标定的场景俯角就是 45°。 */
export const DEFAULT_PLANAR_DEPTH_SCALE = Math.SQRT2;

/**
 * 相机听者在**基准 zoom** 下退到画面后方多少 wu（缺省 600 ≈ 6.8 m）。
 *
 * ⚠ 这个数**推不出来,只能听着定**：游戏投影是正交的（`sceneSpace.worldToScene` 明确丢掉深度
 * 分量），正交相机在无穷远、没有位置，所以不存在能从 `depthConfig` 标定反推的"真实视距"。
 * 它是作者约定，唯一的物理锚是 wu 这把尺（角色高 150 wu），所以同一个数在每个场景意思相同。
 *
 * 也正因为它是约定而不是推导量，**逐场景可覆盖**：景别差得远的场景（大远景 vs 贴脸特写）
 * 该有不同的视距。优先级 = 场景 `acousticListener.backAtBaseZoomWu` >
 * `footstep_sets.json` 的 `spatial.listenerBackAtBaseZoomWu` > 本值。
 */
export const DEFAULT_LISTENER_BACK_AT_BASE_ZOOM_WU = 600;

export function planarResolver(planarDepthScale = DEFAULT_PLANAR_DEPTH_SCALE): AudioSpaceResolver {
  return { mode: 'planar', planarDepthScale };
}

/** f 的下限，与 `perspectiveScale.PERSPECTIVE_SCALE_MIN` 同值：0 会把深度打到无穷。 */
const PERSP_F_MIN = 0.01;

/** 该解算器的视线方向（field 走 R·(0,0,1)，planar 走 45° 约定）。 */
function viewDir(r: AudioSpaceResolver): Vec3 {
  return r.mode === 'field' ? viewDirWorld(r.geo) : planarViewDir(r);
}

/**
 * 正交反投影出的地面点 → 透视纵深重整后的地面点。数学与判据见 {@link AudioPerspective}。
 * `f === 1` 时结果不是恒等（深度被钉到 `baseDepthWu`），所以**只在真有透视标定时调**。
 */
function remapPerspective(r: AudioSpaceResolver, p: AudioPerspective, ground: Vec3,
                          sceneX: number, sceneY: number): Vec3 {
  const f = Math.max(p.scaleAt(sceneX, sceneY), PERSP_F_MIN);
  const fwd = viewDir(r);
  const along = ground[0] * fwd[0] + ground[1] * fwd[1] + ground[2] * fwd[2];
  return [
    (ground[0] - fwd[0] * along + fwd[0] * p.baseDepthWu) / f,
    (ground[1] - fwd[1] * along + fwd[1] * p.baseDepthWu) / f,
    (ground[2] - fwd[2] * along + fwd[2] * p.baseDepthWu) / f,
  ];
}

/**
 * 场景坐标 + 离地高度 → M-world wu。
 *
 * `field` 级：`groundWorldAt` 拿行走面真深度落地。
 * `planar` 级：`[x, 0, −y·scale]`。**负号**是因为场景 y 向下＝向画面近处，
 * 而 M-world 的 +Z 是远离相机——写成正号会让前后景整体对调，且不报错。
 *
 * 落地之后：配了透视标定的场景先按 `f` 重整纵深（见 {@link AudioPerspective}），
 * **再**沿 M-world 的 **Y** 抬高——高度不参与透视缩放（远处的人仍是 150 wu 高）。
 *
 * ⚠ `planar` 的绝对原点无意义（只有差值参与计算），这是刻意的：没有标定就不知道画面中心在哪。
 */
export function resolveWorld(r: AudioSpaceResolver, t: AudioSpaceTarget): Vec3 {
  const ground: Vec3 = r.mode === 'field'
    ? groundWorldAt(r.geo, t.contactX, t.contactY)
    : [t.contactX, 0, -t.contactY * r.planarDepthScale];
  const g = r.persp ? remapPerspective(r, r.persp, ground, t.contactX, t.contactY) : ground;
  return raise(g, t.heightWu);
}

/**
 * 相机听者这一帧的实际视距（wu）：`基准视距 × (sceneBaseZoom / zoom) ÷ f(画面中心)`。
 *
 * 两个因子各管各的、**相乘不相干**：zoom 是运行时推拉镜头，`f` 是这张画本身的透视纵深。
 * 没有透视标定的场景 `f` 恒 1，退化成原来的纯 zoom 比。
 */
export function cameraBackWu(
  r: AudioSpaceResolver,
  cameraSceneX: number,
  cameraSceneY: number,
  backAtBaseZoomWu: number,
  zoomRatio: number,
): number {
  const f = r.persp ? Math.max(r.persp.scaleAt(cameraSceneX, cameraSceneY), PERSP_F_MIN) : 1;
  return backAtBaseZoomWu * zoomRatio / f;
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
 *
 * ## 🔴 相机听者**不叠耳高**
 *
 * 听者就是镜头本身，`pos` 到画面中心地面点的距离**恰好等于 `backWu`**（单测锁着这一条）。
 * `earHeight` 是「人耳离地」，对镜头没有物理意义；叠上去等于把两种模型（"镜头在中心后方
 * backWu"与"一个人站在镜头位置"）搅在一起——退得越远耳朵飞得越高，而且 `backWu` 这个
 * 作者旋钮的读数不再等于实际视距。2026-09-08 前 `Game.resolveAudioListener` 自己抄了一份
 * 数学并多加了耳高（实测视距因此从 600 wu 变成 707 wu），已改为一律调本函数。
 *
 * ⚠ **这是这条数学的唯一实现**：相机听者的位置不许在别处再算一遍。
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

/**
 * 运行时解出来的听者（每帧一份，喂给空间音总线，也回传给工作台画在 3D 里）。
 *
 * 听者**只有一个**：脚步、试听、场景回音全用它。绑定按优先级取：
 * 运行时覆盖（动作 / 调试命令）> 场景 JSON `acousticListener` > 声学空间 `listenerBinding` >
 * `footstep_sets.json` 的 `listener` > `camera`。`from` 记的就是这次取到哪一层。
 */
export interface AudioListenerSnapshot {
  /** 用来落地的场景点（wu，画布左上原点）；钉在空间作者点上时没有 */
  scene: { x: number; y: number } | null;
  /** 脚下地面点（wu，M-world） */
  world: Vec3;
  /** 耳点（wu，M-world）：地面点 + 耳高（相机听者再往视线反方向退 backWu） */
  ear: Vec3;
  /** 视线方向（世界单位向量），直达声方位以它为正前 */
  forward: Vec3;
  /** 有行走面场（field）还是平面近似（planar） */
  grounded: boolean;
  mode: 'player' | 'camera' | 'entity' | 'fixed';
  from: 'runtime' | 'scene' | 'space' | 'footstep' | 'default';
  entityId?: string;
  /** 绑的实体不在场景里，回落到了玩家 */
  targetMissing?: boolean;
  /** 相机听者往画面后方退了多少 wu（按 zoom 折算后的值） */
  backWu?: number;
  /**
   * **未经透视重整**的正交地面点（只有配了 `perspectiveScale` 的场景才有）。
   *
   * 🔴 给作者面画图用，**不许拿去算距离**。配了透视线的场景里 `world` / `ear` 已按
   * `f` 重整过，与声学工作台里那份「场景 3D 展开」和作者摆的反射面**不在同一个空间**；
   * 直接把 `world` 画进去会让听者飘到奇怪的地方，而且不报错。工作台画听者、
   * 「放到游戏听者处」一律用本字段，距离与抽头仍看运行时算出来的那份。
   */
  worldOrtho?: Vec3;
  /** 听者处的透视缩放因子 f（没有透视标定时省略）。状态行拿它说明"这一帧重整了多少"。 */
  perspF?: number;
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
