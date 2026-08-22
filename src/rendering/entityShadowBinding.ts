/**
 * 角色阴影的**手动绑定**解析。
 *
 * ## 为什么是手动的
 *
 * 制作人 2026-08-20 明确否决了自动 resolve：
 * 「角色阴影的控制，要能够手动指定绑定灯光和虚拟灯光（他有时候就是不需要跟着灯光），
 * **不能自动 resolve**！」
 *
 * 被删掉的旧机制（能流模型 + 槽位分配 + 时间低通）问题在于：影子往哪儿投是**算**出来的，
 * 作者既看不懂也改不动，换个灯就全变。演出需要"这一刻影子必须往那边倒"时，没有任何抓手。
 *
 * 所以这里**没有任何猜测**：作者绑哪盏灯就用哪盏，绑虚拟灯就用作者给的角度，
 * 不绑就没有影子。同一份数据永远解出同一个结果——没有时间低通、没有槽位继承、
 * 没有身份匹配，逐帧幂等。
 *
 * ## 为什么只能是剪影
 *
 * 角色是**一个片**（billboard），没有真实几何可投。所以影子形状只能取角色 mask 的剪影
 * 再按光向剪切（脚边钉住、头边偏移）。逐像素与重建面求交会把形状啃烂——这条是用户红线。
 * 场景那边的阴影是真几何（深度场 march），两类分开算、最后 resolve 到一起。
 *
 * ## 剪影的三个一阶修正（2026-08-22）
 *
 * 纯"正面剪影 + 平移"在很多角度会读成一张贴地的纸片。这里在**不动剪影来源**的前提下
 * 补了三个几何量，都是从已有的灯位/M 里算出来的，不新增作者字段：
 *
 * 1. `length` 乘上**地面各向异性**（`groundScreenScale`）——原来横着倒的影子恒短 41%；
 * 2. `spread`：点光的头端**散开**（平行四边形 → 梯形），平行光恒 1；
 * 3. `widthScale`：**迎光截面**，侧光时把影子压窄到体厚，代替"换一张侧面剪影"。
 *
 * 这三条都不做逐像素求交，不撞上面那条红线。真正治本是烘方位相关剪影图集，未做。
 */
import type { EntityShadowBinding, LightDef } from '../data/types';
import {
  DEFAULT_LAMP_RADIUS_WU, DEFAULT_LIGHT_RANGE_WU, directionFromAngles,
} from './lighting/lightPacking';

/**
 * 感知仰角下限。12° 的影子会拉成 5 倍身高的薄条，每像素浓度摊没，真机上根本读不出来
 * （2026-07-22 实测）。物理上是对的，看上去是坏的——这里选看得见。
 */
const MIN_ELEVATION_DEG = 25;
/** 上限：接近正上方时影子缩成一小团，再高就没有方向信息了。 */
const MAX_ELEVATION_DEG = 80;

/**
 * 人在平面上的**体厚 ÷ 肩宽**。侧向受光时影子该有这么窄。
 *
 * 剪影贴图恒是正面帧（角色是 billboard，没有侧面 mask），所以侧光投出来的一直是正面轮廓
 * —— "很多角度看着完全变成片"的物理根源就在这。0.38 是把身体近似成平面椭圆后的短轴比，
 * 一阶地把那个错误吃掉；真正治本要烘一套方位相关剪影图集（见 [[entity-lighting]] 未做项）。
 */
const BODY_THICKNESS_RATIO = 0.38;

/**
 * 点光散开的上限。`u = 半身高 / 灯高于胸口的高度`，u→1 时灯压到头顶、投影分母趋零，
 * 影子会炸成整屏。
 *
 * 0.25（头端最宽 1.67 倍）是**观感**上限，不是物理上限：本作的灯有摆得比角色还矮的
 * （雾津街头 lamp_2 在 125 wu，角色高 150），那种位形物理上真的会把影子甩成一把扇子，
 * 但屏幕上只会读成"坏掉了"。这里要的是"看着像投影而不是贴纸"，够用即可。
 * 典型高杆灯（lamp_5 在 396 wu）解出来约 1.26，本来就落在封顶之内、不受影响。
 */
const MAX_SPREAD_U = 0.25;

/** 解出来的一条影子。全部是 `PlanarEntityShadow` 直接消费的量。 */
export interface ShadowCastSolution {
  /** 屏幕上影子指向的方向（度）。 */
  screenAngleDeg: number;
  /** 光源仰角（度，已钳到可读区间）。 */
  elevationDeg: number;
  /** 浓度 0..1。 */
  darkness: number;
  /** 软度（模糊做在剪影上）。 */
  softness: number;
  /** planar reach 系数：影长 = 角色高 × length。**已含地面各向异性**（见 `groundScreenScale`）。 */
  length: number;
  /** 接触斑强度 0..1。 */
  contact: number;
  /** 头端半宽 ÷ 底边半宽（点光投影散开）；平行光 / 虚拟灯恒 1。 */
  spread: number;
  /** 底边半宽的横向系数（迎光截面）；见 `BODY_THICKNESS_RATIO`。 */
  widthScale: number;
}

export interface ShadowBindingContext {
  /** 角色参考点（胸口）的坐标，**伪世界 q 尺度**（与 shader 同尺，见下）。 */
  charWorld: [number, number, number];
  /**
   * 1 个伪世界 q 单位 = 多少 wu。灯的 `pos`/`range`/半径是**世界空间 wu**，
   * 这里要折进 q 再算。
   *
   * ⚠ 为什么整段在 q 里算而不是在 wu 里：`intensity` 的量纲绑在距离单位上
   *   （照度 = I/r²）。shader 里 march 走的是 q，所以 `intensity` 是相对 q 定义的。
   *   若这边改在 wu 里算，同一个 `intensity` 给出的照度会差 `wuPerQUnit²`
   *   （雾津街头 774400 倍）——影子浓度会整片归零，而且不报错。
   */
  wuPerQUnit: number;
  /**
   * `depthConfig.M.R` 三行，行主序 9 元素（q→world）。
   * ⚠ 必须是 **det=+1** 的游戏约定矩阵，不是实验室那份 det=−1 的
   * ——混用会让 Z 轴整体翻号，影子前后颠倒。
   */
  mRows: ArrayLike<number>;
  /** 场景灯表（按 id 查）。 */
  lights: readonly LightDef[];
  /** 天光强度。用来算"这盏灯相对环境有多强" → 影子该多浓。 */
  skyIntensity: number;
  /**
   * 角色**全身高**，同样是**伪世界 q 尺度**（与 `charWorld` / 灯的 q 化坐标同尺）。
   *
   * 只有点光/聚光/面光的 `spread` 用它：散开程度 = 灯离头顶有多近，那是个比值，
   * 两边必须同尺。给 wu 会差 `wuPerQUnit`（雾津街头 880 倍）——不报错，只是影子恒不散开。
   */
  charHeightQ: number;
}

/** `'light:<id>'` → `<id>`；不是这个形式返回 null。 */
export function parseLightRef(source: string): string | null {
  return source.startsWith('light:') ? source.slice(6) : null;
}

/**
 * 世界方向 → 屏幕上的影子方向（度）。
 *
 * 影子倒向背光侧，所以取光的**水平**方向取反，再经 Mᵀ 回到 q，最后投屏
 * （屏幕 x = q.x，屏幕 y = −q.y）。
 */
function shadowScreenAngle(mRows: ArrayLike<number>, lx: number, lz: number): number {
  const hn = Math.max(Math.hypot(lx, lz), 1e-6);
  const hx = -lx / hn;
  const hz = -lz / hn;
  // world → q：M 正交，转置即逆（行主序 r00..r22，按列取）
  const qvx = mRows[0] * hx + mRows[6] * hz;
  const qvy = mRows[1] * hx + mRows[7] * hz;
  return (Math.atan2(-qvy, qvx) * 180) / Math.PI;
}

/**
 * **地面位移 → 屏幕长度**的各向异性因子（以"角色身高在屏幕上的长度"为 1）。
 *
 * `shadowScreenAngle` 把光向投屏后只取了角度、把**模长**扔了，于是 `reach = 角色高 × 1/tanθ`
 * 被各向同性地当成屏幕长度用。但地面是斜的（本作 M 是绕 X 转 45°）：同样长的地面位移，
 * 沿世界 X（屏幕横向）投出来是沿世界 Z（屏幕纵向）的 1/cos45 = **1.41 倍**。
 * 结果是横着倒的影子恒定短 41% —— 短而敦实，正是"贴在地上的纸片"那种观感。
 *
 * 这里把丢掉的模长补回来：
 *   屏幕长度 = ppu·|proj(水平地面单位向量)|·L，角色屏幕高 H = ppu·|proj(世界竖直单位向量)|·h
 *   ⇒ 屏幕长度 / H = (地面模长 / 竖直模长) × (L/h)
 * 返回的就是括号里那个比值。屏幕约定同 `shadowScreenAngle`（x = q.x，y = −q.y），
 * 取模时符号无关，所以直接给光向、不必先取反。
 */
function groundScreenScale(mRows: ArrayLike<number>, lx: number, lz: number): number {
  const hn = Math.max(Math.hypot(lx, lz), 1e-6);
  const nx = lx / hn;
  const nz = lz / hn;
  // world → q：M 正交，转置即逆（行主序 r00..r22，按列取）
  const gx = mRows[0] * nx + mRows[6] * nz;
  const gy = mRows[1] * nx + mRows[7] * nz;
  const vx = mRows[3];                       // 世界竖直 (0,1,0) 投到 q
  const vy = mRows[4];
  return Math.hypot(gx, gy) / Math.max(Math.hypot(vx, vy), 1e-6);
}

/**
 * 仰角 → planar reach。影长 = aniso/tan(仰角)，封顶防拖满屏。
 *
 * 封顶必须**在乘完 aniso 之后**：2.5 这个上限管的是"影子别拖满屏幕"，是屏幕长度的事。
 */
function lengthFromElevation(elevationDeg: number, aniso = 1): number {
  const t = Math.tan((Math.max(elevationDeg, 5) * Math.PI) / 180);
  return Math.min(2.5, Math.max(0.4, aniso / Math.max(t, 0.05)));
}

/**
 * 迎光截面 → 底边半宽系数。
 *
 * 身体在平面上近似成椭圆：左右半轴 1（肩宽）、前后半轴 `BODY_THICKNESS_RATIO`（体厚）。
 * 影子的横向是**垂直于光的水平方向**，椭圆在单位方向 n 上的支撑半径 = √((a·nₓ)²+(b·n_z)²)，
 * 代入 n = (−h_z, h_x) 即下式。角色是 billboard，左右轴恒是世界 X（屏幕横向）。
 *
 * 校验：灯在世界 X 向（影子横着倒）→ 只剩体厚；灯在世界 Z 向（影子朝屏幕上下倒）→ 全肩宽。
 */
function widthScaleFromGroundDir(hx: number, hz: number): number {
  const hn = Math.max(Math.hypot(hx, hz), 1e-6);
  return Math.hypot(hz / hn, (BODY_THICKNESS_RATIO * hx) / hn);
}

/**
 * 一盏灯在角色处的照度（与 shader 的 `lcFalloff` 同式）。
 *
 * 只用来定影子浓度，**不参与角色受光**——受光走 shader 的逐像素 N·L，
 * 这里是 CPU 上的一个标量估计，两者算的是不同的东西，不必也不该对齐到逐位。
 */
function lightIlluminance(l: LightDef, ctx: ShadowBindingContext): number {
  if (l.kind === 'directional') return l.intensity;
  const k = 1 / Math.max(ctx.wuPerQUnit, 1e-9);      // wu → q
  const p = l.pos ?? [0, 0, 0];
  const dx = p[0] * k - ctx.charWorld[0];
  const dy = p[1] * k - ctx.charWorld[1];
  const dz = p[2] * k - ctx.charWorld[2];
  const r2 = dx * dx + dy * dy + dz * dz;
  const range = (l.range ?? DEFAULT_LIGHT_RANGE_WU) * k;
  const cut = Math.exp(-r2 / Math.max(range * range, 1e-6));
  const soft = (l.softeningRadius ?? DEFAULT_LAMP_RADIUS_WU) * k;
  return (l.intensity * cut) / (r2 + soft * soft);
}

/**
 * 光源的角尺寸 → 影子软度。面光按实际尺寸（窗户是真的大，影子该软），
 * 点/聚光按灯体半径（小，硬影），平行光最硬（日面角半径极小）。
 *
 * 全程 **wu**，不换算——`dist` 是世界距离，灯体半径与面光尺寸也都是 wu，
 * 三者同尺，比值才有意义。
 */
function softnessOf(l: LightDef, dist: number, wuPerQUnit: number): number {
  if (l.kind === 'directional') return 0.25;
  const k = 1 / Math.max(wuPerQUnit, 1e-9);          // wu → q（dist 是 q）
  let radius = (l.softeningRadius ?? DEFAULT_LAMP_RADIUS_WU) * k;
  if (l.kind === 'area') {
    const s = l.size ?? [DEFAULT_LIGHT_RANGE_WU * 0.3, DEFAULT_LIGHT_RANGE_WU * 0.2];
    radius = 0.5 * Math.hypot(s[0], s[1]) * k;
  }
  return Math.max(0.25, Math.min(1.2, (radius / Math.max(dist, 1e-3)) * 6));
}

/**
 * 解一条绑定。返回 null = 这条不投影（`source: 'none'`、灯查不到、灯关着）。
 *
 * **纯函数、逐帧幂等**：同样的输入永远同样的输出。这正是"手动"的意思——
 * 作者摆的东西不会被系统在背后调整。
 */
export function resolveBoundShadow(
  binding: EntityShadowBinding,
  ctx: ShadowBindingContext,
): ShadowCastSolution | null {
  if (binding.source === 'none') return null;

  if (binding.source === 'virtual') {
    const v = binding.virtual;
    if (!v) return null;
    const el = Math.max(MIN_ELEVATION_DEG, Math.min(MAX_ELEVATION_DEG, v.elevationDeg));
    const az = v.azimuthDeg * (Math.PI / 180);
    return {
      // 虚拟灯的方位角作者直接给的就是**屏幕**方向——虚拟灯没有世界位置，
      // 再去绕一圈世界坐标只会让作者调的数和看到的效果对不上。
      screenAngleDeg: v.azimuthDeg,
      elevationDeg: el,
      darkness: clamp01(v.darkness),
      softness: Math.max(0, v.softness),
      // `length` 是 planar reach 系数（影长 = 角色高 × length），本来就是无量纲的。
      // ⚠ 这里**不乘**地面各向异性：作者给的是屏幕方向、调的是屏幕长度，
      //   系统再乘一个因子等于把作者盯着画面调出来的数偷偷改掉。
      length: v.length > 0 ? v.length : lengthFromElevation(el),
      contact: clamp01(v.darkness) * 0.5,
      // 虚拟灯没有世界位置 → 当平行光看待，不散开。
      spread: 1,
      // 迎光截面按屏幕方位角近似：屏幕横向≈世界 X，屏幕纵向≈世界 Z（见 shadowScreenAngle）。
      widthScale: widthScaleFromGroundDir(Math.cos(az), Math.sin(az)),
    };
  }

  const id = parseLightRef(binding.source);
  if (!id) return null;
  const light = ctx.lights.find((l) => l.id === id);
  if (!light || !(light.enabled ?? true)) return null;

  // 指向光源的世界方向
  let lx: number;
  let ly: number;
  let lz: number;
  let dist = Infinity;
  if (light.kind === 'directional') {
    [lx, ly, lz] = directionFromAngles(light.elevationDeg ?? 45, light.azimuthDeg ?? 180);
  } else {
    const k = 1 / Math.max(ctx.wuPerQUnit, 1e-9);
    const p = light.pos ?? [0, 0, 0];
    lx = p[0] * k - ctx.charWorld[0];
    ly = p[1] * k - ctx.charWorld[1];
    lz = p[2] * k - ctx.charWorld[2];
    dist = Math.hypot(lx, ly, lz);
    if (dist < 1e-5) return null;               // 角色正站在灯里，方向无定义
  }

  const elevationDeg = Math.max(MIN_ELEVATION_DEG, Math.min(MAX_ELEVATION_DEG,
    (Math.atan2(ly, Math.hypot(lx, lz)) * 180) / Math.PI));

  // 浓度 = 这盏灯占**全部照明**的份额。份额高 → 挡住它就没别的光来填 → 影子实。
  //
  // ⚠ 分母必须含**其余的灯**，不能只有天光。只除天光的话，任何一盏灯只要靠近角色
  //   就立刻压过天光（本作天光 0.045，灯 ~4，差两个量级），浓度整片钉在 1：
  //   两盏同样近的灯会各投一个全黑影子，而实际它们互相填光、各自只该有半浓。
  //   实测雾津街头：走到 lamp_5 前 13 m 浓度就已经饱和，全街都是硬黑影。
  const e = lightIlluminance(light, ctx);
  let total = ctx.skyIntensity;
  for (const l of ctx.lights) {
    if (!(l.enabled ?? true)) continue;
    total += lightIlluminance(l, ctx);
  }
  const darkness = clamp01(binding.darkness ?? e / Math.max(total, 1e-6));

  const baseLen = lengthFromElevation(elevationDeg, groundScreenScale(ctx.mRows, lx, lz));

  // 头端散开：灯在头顶多高决定投影分母。灯高（离地）= ly + 半身高，角色高 = 2×半身高，
  // 头端放大 = 灯高/(灯高−角色高) = (1+u)/(1−u)，u = 半身高/ly。平行光 u=0，不散。
  // ly 是"灯高于**胸口**"（charWorld 取的是胸口），与 charHeightQ 同为 q 尺度。
  const halfH = 0.5 * Math.max(ctx.charHeightQ, 0);
  const u = light.kind === 'directional'
    ? 0
    : Math.max(0, Math.min(MAX_SPREAD_U, halfH / Math.max(ly, 1e-6)));

  return {
    screenAngleDeg: shadowScreenAngle(ctx.mRows, lx, lz),
    elevationDeg,
    darkness,
    softness: binding.softness ?? softnessOf(light, dist === Infinity ? 1e3 : dist, ctx.wuPerQUnit),
    length: baseLen * (binding.lengthScale ?? 1),
    contact: darkness * 0.5,
    spread: (1 + u) / (1 - u),
    widthScale: widthScaleFromGroundDir(lx, lz),
  };
}

/**
 * 解一整组绑定。返回的条目与输入**同序**（作者列表里的第几条就是第几条），
 * 不投影的位置留 null —— 调用方按下标复用 planar 实例，避免影子在列表里跳位。
 */
export function resolveBoundShadows(
  bindings: readonly EntityShadowBinding[],
  ctx: ShadowBindingContext,
): (ShadowCastSolution | null)[] {
  return bindings.map((b) => resolveBoundShadow(b, ctx));
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}
