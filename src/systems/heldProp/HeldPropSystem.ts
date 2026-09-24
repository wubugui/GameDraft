import type { ActionDef, IGameSystem, GameContext, LightDef, VfxFireSegment } from '../../data/types';
import type { PropFlickerPhysicalDef, PropLightDef, PropPresetDef, ResolvedPropAttach } from '../../data/propPresets';
import type { BurnableHostDef } from '../../data/burnables';
import {
  PROP_BLOWOUT_DEFAULT_FADE_MS,
  PROP_FUEL_EMBER_RATE,
  PROP_FUEL_WIND_FACTOR,
  PROP_CONTROL_DEFAULTS,
  PROP_EFFECTS_MAX,
  PROP_IGNITER_DEFAULT_FLAME_CM,
  applyPropEffects,
  parsePropLockMode,
  propEffectFuelRate,
  propFuelLowSeconds,
  resolvePropAttach,
  resolvePropStateName,
  type PropEffectDef,
  type PropLockMode,
  type PropPlayerControlDef,
} from '../../data/propPresets';
import {
  BURN_SIZE_EXPONENT,
  FLAME_PUFF_AMP_DEFAULT,
  GUTTER_OFF_FLAME,
  GUTTER_OFF_LIGHT,
  GutterProcess,
  PhysicalFlicker,
  flameWindFactor,
  gutterDuty,
  burnSizeScale,
  flameOutput,
  flickerAmpWithWind,
  lightChangedEnough,
  transitionProgress,
} from './heldPropSignal';
import {
  FLAME_HEIGHT_TAU_S,
  FLAME_MIN_VISIBLE_RATIO,
  FLAME_WU_PER_M,
  flameBillboardPose,
  flameFrameIndex,
  relativeHorizontalAirflow,
  screenRightHorizontal,
  smoothAirflow,
  smoothScalar,
} from './heldPropFlame';

/** 求"相机右"时沿世界 x / z 各挪多远去投影（wu）。只影响有限差分的数值条件，不影响结果 */
const SCREEN_AXIS_PROBE_WU = 100;

type Vec3 = [number, number, number];

/**
 * 手持挂件（火把 / 灯笼 / 提灯）的运行态。
 *
 * ## 干三件事（都是"运行时的灯与手上的东西"，同一批依赖）
 *
 * ① **挂件的状态机**：`attach` / `setState` / `detach`。状态是**离散**的（点着 / 护火 /
 *    残炭 / 灭），动作只切状态名；连续量（灯的渐变、火焰的闪、发射率）在这里逐帧算 ——
 *    这是本项目既有的形状（轨迹烘成资产、粒子是效果资产，动作只说"谁、播哪条"）。
 * ② **跟随灯**：挂件自带的灯，以及场景里配了 `LightDef.follow` 的作者灯（更夫的灯笼），
 *    每帧解出位置后经 `SceneLightingSystem.setDynamicLights` 加在作者灯之外
 *    （**绝不写作者数据**——那份会被编辑器实时同步回写进场景 JSON）。
 *    效果锚点同理经 `VfxSystem.moveInstanceAnchor` 挪。
 * ③ **灯的渐灭 / 渐亮**（`fadeLight`）：作者灯的强度**倍率**覆盖，门口那盏灯笼被风吹灭走这条。
 *
 * ## 闪 = 一个信号
 *
 * `heldPropSignal.flameOutput` 产一个 `L(t)`，同时驱动灯的强度与火的大小（L^0.4 低通，见 `stepFlameHeat`）。
 * 两处各摇一个随机数会看出"灯在闪、火苗不动"，所以这里只有一个信号。
 *
 * ## 挂件上的火：粒子挂载 + 帧动画火苗（2026-09-15 制作人定）
 *
 * **粒子挂载**（`particles`）：每条 = 一个粒子效果挂在贴图上的一个点（没写点 = 起火点），逐帧跟着燃烧物走。
 * 粒子在世界里模拟：被风吹歪、人举着走拖在身后，都是模拟出来的。这里只逐帧推三个**实例倍率**：
 * 发射率 = 燃烧强度（0 = 不再发，在飞的自然烧完；闪烁不进发射率）；新生粒子大小 = 燃烧强度^0.4 × 闪烁的热
 * （Heskestad 火焰高度关系）；吃场景风 = 1 − 挡风（护火）。锚点相对宿主的位移（动画带出来的）在飞的粒子整团跟着，
 * 宿主在世界里的平移不带（拖尾）。火把本身只用这一种。
 *
 * **帧动画火苗**（`flame`，保留的能力）：大小 = 满火高度 × 燃烧强度 × 闪烁逐帧真值的 2/5 次方再过 50 ms 低通；
 * 倾角 = 相对气流（场景风 − 宿主速度）× (1 − 挡风) 按 Froude 数推出，只取直立面内的分量画成倾斜、面外画成变短；
 * 帧号 = 自挂上累计秒 × 帧率 + 种子相位。数学在 `heldPropFlame`（纯函数）。
 *
 * 燃烧强度随 `fadeMs` 与灯同钟渐变。灯位钉在起火点、吃闪烁的区间均值；火苗 / 粒子怎么晃都不带着灯晃
 * （跟了就是每帧重烘光照）。
 *
 * ## 挂件上的一次性效果（`playPropVfx`）
 *
 * 与粒子挂载同一套锚点（贴图上的点 → 起火点 → 挂点）、同一套排序宿主与转身带粒子，但**不属于状态**：
 * 放完自己收（`VfxSystem` 的 oneShot 实例），切状态不停，只有卸下 / 拆除时当场散；不吃燃烧强度 / 闪烁 / 挡风。
 * 典型用法：「灭」状态的进入动作里播熄灭后冒的那口烟——状态进入动作里不写 target / socket = 这件挂件自己
 * （{@link HeldPropSystem.runEnterActions} 注入，只注入顶层那几条）。
 *
 * ## 风吹灭火（火势）
 *
 * 预设 / 状态写了 `blowout` 的挂件有一个火势 `vitality`（0..1）：火把处的相对气流（`entry.air`，已算挡风与人走动）
 * 超过吹熄风速就掉、低于就回；乘在燃烧强度与灯强度上。越过残炭线 / 掉到底按 `auto` 自己切状态，再执行
 * `onEmberActions` / `onOutActions`（发叙事信号就在里面发）。只往下触发——物理不点火。`lockPropState` 锁定不灭 = 只回不掉。
 *
 * ## 玩家按键（`playerControl`，只对玩家身上的挂件）
 *
 * `PROP_CONTROL_KEYS.toggle`（T）：点着 / 护火时熄灭，灭了 / 残炭时点火；按住 `PROP_CONTROL_KEYS.guard`（Q）：点着时护火、松开回点着。
 * 输入由组装层给（只在可操作的游戏状态里给，演出 / 面板里给 null）；本系统不读键盘。锁：`lit` 熄不了、`unlit` 点不着。
 * 动作点火（从残炭 / 灭切出去）火势回满。火势不入档（派生量），锁入档。字段语义见 `PropBlowoutDef`。
 *
 * ## 状态自带的进入动作
 *
 * `setPropState` 真的切到一个状态、或 `attachToSocket` 动作挂上时，执行该状态的 `onEnterActions`；
 * 读档重挂、切场景自动重挂**不执行**（派生表现不是"进入"）。同一挂点一帧内切换超过
 * {@link MAX_TRANSITIONS_PER_FRAME} 次就拒绝（状态动作互相切来切去的死循环）。
 *
 * ## 存档
 *
 * 只有 `persistent: true` 的预设（手持物）入档，存的是**玩法事实**
 * （谁、哪个挂点、哪支、什么状态）；贴图 / 灯 / 粒子全是从这条事实**派生**的表现，
 * 与位面对账器同一个形状：切场景与读档都重派生一次，自己零表现态持久化。
 * 演出挂件（缺省）不入档、切场景即散 —— 与既有 `attachToSocket` 行为一致。
 *
 * ## 分层
 *
 * 依赖一律窄回调注入（律 11）：本系统不 import 渲染层、不 import 别的系统。
 */

export interface HeldPropDeps {
  getPreset: (propId: string) => PropPresetDef | undefined;
  /**
   * 挂点在**当前帧**相对实体接地点的偏移（场景 wu，y 向上为负），**已含实体的左右朝向**
   * （Player 转身在精灵上、NPC 转身在外层容器上，两种都要算进去 —— 见
   * `SpriteEntity.getSocketOffsetFromContact`）。
   * 这一帧没标注 ⇒ null（挂件此刻是隐着的，灯也该跟着灭 —— 刀在鞘里手上就没有火）。
   */
  getSocketLocalPose: (targetId: string, socket: string) => { x: number; y: number; front: boolean; clearanceWu: number; bodyWidthWu: number } | null;
  /** 挂点的实际画面位置 + 前后关系 → 身体外侧 M-world 点；无真 3D 几何时 null。 */
  socketToLightWorld: (
    contact: { x: number; y: number },
    pose: { x: number; y: number; front: boolean; clearanceWu: number; bodyWidthWu: number },
  ) => Vec3 | null;
  /** 实体脚点（场景坐标 wu）；实体不在场 ⇒ null */
  getEntityContact: (targetId: string) => { x: number; y: number } | null;
  /** 该实体动画包里**已标注**的挂点名；实体不在场 ⇒ null（拼错挂点名要能报出来） */
  listSockets: (targetId: string) => string[] | null;
  /**
   * 场景点 + 离地高度（wu）→ **M-world** 灯坐标（wu，铁律 0）。
   * 场景此刻没有真 3D 几何（照明载荷没到 / 没烘）⇒ **null**，绝不能退回别的坐标系：
   * 粒子的平面近似空间返回的是画面坐标，拿它当灯位不报错，只是灯静默落到别处。
   */
  sceneToLightWorld: (sceneX: number, sceneY: number, heightWu: number) => Vec3 | null;
  /**
   * 场景点 + 离地高度（wu）→ **粒子模拟空间**里的坐标（效果锚点用）。
   * 与灯位分开：粒子在平面近似空间里照样要跑，而灯不能拿那份坐标。还没进场景 ⇒ null。
   */
  sceneToVfxWorld: (sceneX: number, sceneY: number, heightWu: number) => Vec3 | null;
  /**
   * 该点处的空气速度大小（wu/s，场景风）。`world` 是 M-world 坐标，`heightWu` = 离地高度
   * （风的对数廓线要它）。场景没配风 ⇒ 0。
   */
  windSpeedAt: (world: Vec3, heightWu: number) => number;
  /** 挂/换贴图（切状态会重挂一次，纹理变了没法淡入淡出） */
  attachView: (targetId: string, socket: string, resolved: ResolvedPropAttach) => Promise<void>;
  detachView: (targetId: string, socket: string) => void;
  /** 把运行时灯整批推给光照系统（空数组 = 一盏也没有） */
  setDynamicLights: (lights: LightDef[]) => void;
  /** 把作者灯的强度倍率整批推给光照系统（`fadeLight`；空表 = 没有任何覆盖） */
  setLightIntensityScales: (scales: Map<string, number>) => void;
  /**
   * 开一个跟随效果。`host` = 它挂在谁手里哪个挂点上：渲染据此把整团粒子钉在宿主的挂件那一侧排序
   * （挂件在身后时火舌不会一半飘到人前面）。
   */
  playVfx: (
    effect: string, world: Vec3, host: { targetId: string; socket: string }, oneShot: boolean,
  ) => string | null;
  /**
   * 挪跟随效果的锚点。`carry` = 在飞的粒子一起平移的量（M-world wu；null = 不带，已发射的留在世界里自己飘）。
   * 带的是**锚点相对宿主的那部分位移**（动画带出来的：转身翻面、走 / 站换姿势、逐帧动画换帧），见 syncParticles。
   */
  moveVfx: (id: string, world: Vec3, carry: Vec3 | null) => boolean;
  /** 硬停：当场散（卸下挂件 / 拆除） */
  stopVfx: (id: string) => void;
  /** 软停：不再发射、在飞的飞完（切状态：火舌停了，空中的火星该飞完） */
  softStopVfx: (id: string) => void;
  setVfxRate: (id: string, k: number) => void;
  /** 新生粒子大小倍率（燃烧强度 → 火苗大小） */
  setVfxSizeScale: (id: string, k: number) => void;
  /** 吃场景风的倍率（护火 = 挡风） */
  setVfxWindScale: (id: string, k: number) => void;
  /** 最远烧到多远的倍率（火焰长度：燃烧强度与风把它缩短） */
  setVfxDistanceScale: (id: string, k: number) => void;
  /**
   * 挂件**贴图上某一点**（起火点，归一化）此刻相对接地点的偏移，形状同 `getSocketLocalPose`
   * （穿过挂件自己的支点 / 自转 / 缩放 / 镜像）。贴图还没挂上 / 挂点这帧没标注 ⇒ null。
   */
  getPropPointLocalPose: (
    targetId: string, socket: string, point: [number, number],
  ) => { x: number; y: number; front: boolean; clearanceWu: number; bodyWidthWu: number } | null;
  /** 该点处的场景风速度矢量（M-world，wu/s）；场景没配风 ⇒ [0,0,0]。帧动画火苗倾斜用 */
  windVectorAt: (world: Vec3, heightWu: number) => Vec3;
  /** M-world → 场景坐标（帧动画火苗倾斜投到画面上用）；无真 3D 几何 ⇒ null */
  worldToScene: (world: Vec3) => { x: number; y: number } | null;
  /** 推一帧帧动画火苗（null = 这个挂点现在没有火苗可画） */
  setFlameView: (targetId: string, socket: string, params: HeldFlameViewParams | null) => void;
  /** 执行状态自带的进入动作（返回覆盖真实完成时间的 Promise） */
  runStateActions: (actions: ActionDef[]) => Promise<void>;
  /**
   * 玩家操作挂件的按键（这一帧）：`togglePressed` = 刚按下点火 / 熄灭键，`guardHeld` = 按住护火键。
   * 不受理输入的游戏状态（演出 / 对话 / 面板）返回 null。
   */
  readPlayerPropInput: () => { togglePressed: boolean; guardHeld: boolean } | null;
  /**
   * 玩家手上那支火「快灭了」的提示（火边的符号）；null = 这一刻不提示（淡掉）。有玩家可操作的挂件时逐帧推。
   */
  setFireHint: (hint: HeldFireHint | null) => void;
  /**
   * 挂件的玩法事实变了（挂上 / 卸下 / 切状态 / 锁 / 火势跨过一档 {@link VITALITY_NOTIFY_STEP}）：
   * 组装层据此让叙事状态机重评 reactive 条件（`heldProp` 条件叶）。同一帧可能调好几次，接收方自己合批。
   */
  onHeldChanged: () => void;
  /**
   * 可燃挂件（预设开了 `burnable`，A3.8）被**收起来**（`detach`：动作卸下 / 收进包里）——燃烧系统熄灭它、记成"包里那根"。
   * 切场景 / 读档整批卸下不走这里（那条燃烧系统按暂存接着烧）。
   */
  onBurnablePropRemoved?: (targetId: string, socket: string, propId: string) => void;
  /** 可燃挂件此刻在不在烧（燃烧系统问；`heldProp` 条件叶的 `burning` 与防护火源读它）。火把那一套照旧看灯 */
  burnablePropBurning?: (targetId: string, socket: string) => boolean;
  /**
   * 当前火种（玩家背包里设的那种，见玩法清单 A3.7「火种」）；没设 ⇒ null。`available` = 还能点几次。
   * 不设这个 dep（旧测试 / 无背包的宿主）⇒ 点火不要火种（按 T 直接点着，与火种落地前一致）。
   */
  igniterStatus?:() => { name: string; seconds: number; windLimit: number; available: number } | null;
  /** 用掉当前火种的一次（开始点那一刻扣，点没点着都算）；用不了 ⇒ null */
  consumeIgniterUse?: () => { name: string; seconds: number; windLimit: number } | null;
  /** 点火的结果（组装层出提示字 / 音效）；`name` = 火种名 */
  onIgniteResult?: (result: HeldIgniteResult, name: string) => void;
  /**
   * 效果块（`prop_effects.json`，见玩法清单 A3.7「效果自由组合」）；不给 / 查不到 ⇒ 这块不算
   * （数值不乘、场不放、标签不给）——缺一块效果不该让整支火把挂不上。
   */
  getEffect?: (id: string) => PropEffectDef | undefined;
  /**
   * 效果块的场（驱虫 / 招东西）：`handle` 认一份场，同 handle 反复喂 = 挪位置；`world` 为 null = 撤掉。
   * 不给这个 dep ⇒ 只有数值与标签生效，场不放。
   */
  setPropField?: (handle: string, field: { kind: 'fear' | 'attract'; tag: string; radius: number; strength: number } | null, world: Vec3 | null) => void;
  log: (m: string) => void;
}

/**
 * 用火种点火的结果：`started` 开始点 / `success` 点着了 / `failWind` 风太大 / `failMove` 人动了 / `failCancel` 停了手 /
 * `failInterrupted` 进了对话演出面板、切场景 / `noneSet` 没设火种 / `empty` 当前火种用完了 / `locked` 锁了点不燃 /
 * `moving` 按 T 时人还在走（不开始、不耗火种：站稳了再点）/ `spent` 这根烧完了，点不着了
 */
export type HeldIgniteResult =
  | 'started' | 'success' | 'failWind' | 'failMove' | 'failCancel' | 'failInterrupted' | 'noneSet' | 'empty' | 'locked'
  | 'moving' | 'spent';

/** 「快灭了」提示的一帧（与 `rendering/FireHintMarker.FireHintTarget` 同形；系统层不 import 渲染层） */
export interface HeldFireHint {
  targetId: string;
  /** 起火点（场景坐标 wu） */
  sceneX: number;
  sceneY: number;
  /**
   * 符号中心相对起火点的方向（画面单位向量，y 向下）：离**火舌、杆子、身体那一侧**都最远的方向（见 {@link pickHintAngle}）。
   * 2026-09-15 四轮真跑逐像素测出来的：固定人身外侧 ⇒ 朝左迎风火舌扫到；按上风侧 ⇒ 上风是身体那侧时压杆子；
   * 垂直于杆子背着火 ⇒ 走路时另一只手的小臂伸到火把头下面，压手。
   */
  dirX: number;
  dirY: number;
  /** 剩下的火势 0..1 */
  fill: number;
  /** 危险程度 0..1：提示线处 0、火势见底 1；残炭恒 1 */
  danger: number;
  /** 火势正在往下掉（false = 挡住了风，在往回长） */
  falling: boolean;
  /** 已经是残炭 */
  ember: boolean;
  /**
   * 符号在说哪件事：`vitality` 快灭了（上面几项）/ `igniting` 正在用火种点（`fill` = 点了几成）/
   * `failed` 刚才没点着（红、一抖、淡掉）。缺省 `vitality`
   */
  mode?: 'vitality' | 'igniting' | 'failed';
}

/**
 * 一件挂着的东西此刻的玩法事实（`heldProp` 条件叶读的就是它，别的系统也查它）。
 * `burning` = 当前状态有灯（点着 / 护火 / 残炭 ⇒ true；灭 ⇒ false；刀、没配灯的道具恒 false）。
 */
export interface HeldPropStatus {
  target: string;
  socket: string;
  prop: string;
  state: string;
  burning: boolean;
  /** 火势 0..1；没有 blowout 的恒 1 */
  vitality: number;
  /** 还剩几成燃料 0..1；没有耐久（烧不完）的恒 1 */
  fuel: number;
  /** 挂着的效果块 id 与它们的标签（`heldProp` 条件叶的 `effect` 两样都认） */
  effects: string[];
  /** 第几级（1 起；没有等级表的恒 1） */
  level: number;
  lock: PropLockMode;
}

/** 火势每跨过这么一档（0.05）通知一次：条件叶能写"火势低于 0.3"，又不至于每帧唤醒叙事重评 */
export const VITALITY_NOTIFY_STEP = 0.05;

/** 推给视图的帧动画火苗参数（与 `SpriteEntity.AttachmentFlameParams` 同形；系统层不 import 渲染层） */
export interface HeldFlameViewParams {
  visible: boolean;
  frame: number;
  /** 一格帧此刻的高度（wu，透视系数 1 处；含燃烧强度、闪烁、前倾透视缩短） */
  heightWu: number;
  /** 画面倾角（弧度，顺时针为正，相对画面竖直） */
  angleRad: number;
}

/** 一条粒子挂载的运行态：效果 + 贴图上的点 + 这一刻的效果实例 id（null = 锚点还解不出来，等下一帧开） */
interface HeldParticleMount {
  effect: string;
  point: [number, number] | null;
  id: string | null;
  /** 上一帧挪到的锚点（null = 这条还没挪过）：算"相对宿主的位移"要它 */
  last?: Vec3 | null;
}

/**
 * 锚点相对宿主的位移 = 锚点位移 − 宿主平移（在飞的粒子带这一份）。上一帧没有锚点 / 宿主解不出来 ⇒ 不带；
 * 小到 1e-6 wu 以下也当不带（站着不动时逐帧推一个零向量没有意义）。
 */
export function rigCarry(last: Vec3 | null, at: Vec3, hostDelta: Vec3 | null): Vec3 | null {
  if (!last || !hostDelta) return null;
  const dx = at[0] - last[0] - hostDelta[0];
  const dy = at[1] - last[1] - hostDelta[1];
  const dz = at[2] - last[2] - hostDelta[2];
  return Math.hypot(dx, dy, dz) > 1e-6 ? [dx, dy, dz] : null;
}

/**
 * 玩家操作挂着的火用的键（`playerControl`）：T 点火 / 熄灭，按住 Q 护火（2026-09-15 制作人：原来的 V 离 WASD 远、边走边按太难；
 * Q 原是「嗅」键，嗅挪到 V）。改键要同步触屏按钮、玩法清单与说明文案
 */
export const PROP_CONTROL_KEYS = { toggle: 'KeyT', guard: 'KeyQ' } as const;

/** 挂点回来后物理闪烁的灯亮回来要多久（秒）：火苗粒子从 0 长回来要一茬寿命（torch_flame 核心 0.2–0.36 s） */
export const FLAME_REGROW_SECONDS = 0.3;

/** 画面横向相对气流多大时火舌歪 45°（m/s；只用来判火舌往哪边歪，不是火舌形状） */
const HINT_FLAME_LEAN_MPS = 1;
/** 提示符号躲火舌的半角（火舌有宽度，被风压着时贴着起火点横着拖） */
export const HINT_FLAME_HALF_RAD = (25 * Math.PI) / 180;
/** 躲杆子的半角 */
export const HINT_STICK_HALF_RAD = (10 * Math.PI) / 180;
/** 躲身体那一侧的半角：水平指向人身中轴 ±55°（躯干、另一只手的小臂、头） */
export const HINT_BODY_HALF_RAD = (55 * Math.PI) / 180;
/** 回滞：上一次的方向还留有这么多余量、且只比最好的差不到 {@link HINT_KEEP_SLACK_RAD}，就不换 */
const HINT_KEEP_MIN_RAD = (10 * Math.PI) / 180;
const HINT_KEEP_SLACK_RAD = (20 * Math.PI) / 180;
const HINT_SAMPLES = 72;

/**
 * 从一点看出去，离一组障碍方向都最远的方向（画面角，弧度）。余量 = 到每个障碍的夹角 − 它的半角，取最小；
 * 在 72 个方向里取余量最大的（就是最宽空隙的中线）。回滞：上一次的方向余量还 ≥ 10° 且只比最好的差不到 20° ⇒ 原地不动
 * ——风一抖、走路一帧一帧换姿势，符号不跟着跳。
 */
export function pickHintAngle(obstacles: readonly { angle: number; half: number }[], prev: number | null): number {
  const clearance = (a: number) => {
    let m = Math.PI;
    for (const o of obstacles) {
      const d = Math.abs(Math.atan2(Math.sin(a - o.angle), Math.cos(a - o.angle))) - o.half;
      if (d < m) m = d;
    }
    return m;
  };
  let best = 0, bestC = -Infinity;
  for (let i = 0; i < HINT_SAMPLES; i++) {
    const a = -Math.PI + (i / HINT_SAMPLES) * 2 * Math.PI;
    const c = clearance(a);
    if (c > bestC + 1e-9) { bestC = c; best = a; }
  }
  if (prev !== null) {
    const pc = clearance(prev);
    if (pc >= HINT_KEEP_MIN_RAD && pc >= bestC - HINT_KEEP_SLACK_RAD) return prev;
  }
  return best;
}
/** 气流投到画面上用的探针时长（秒）：base + air × 它，只取方向与大小，不必是真位移 */
const HINT_PROBE_S = 0.01;

/** 玩家按住 / 松开护火键的切换渐变（毫秒）：身子一侧、手一拢，是一下的事 */
export const PLAYER_GUARD_FADE_MS = 150;

/** 用火种点火时人走动超过这个速度（m/s）就算"动了"、没点着：站着微调脚、动画呼吸不算 */
export const IGNITE_MOVE_LIMIT_MPS = 0.25;
/** 没点着之后符号红着抖多久（秒） */
export const IGNITE_FAIL_SHOW_SEC = 0.45;

/** 越线触发过一次后，火势要回到线上方这么多才重新武装（防在线附近抖着连发） */
export const BLOWOUT_REARM_MARGIN = 0.1;

/** 同一挂点一帧内最多切几次状态（超过 = 状态动作互相切的死循环） */
export const MAX_TRANSITIONS_PER_FRAME = 8;

/** 这一次挂载的显式覆盖（动作参数里写的"这次歪着拿"）。切状态时仍然生效。 */
export interface HeldPropOverrides {
  images?: string[];
  anchorX?: number;
  anchorY?: number;
  rotation?: number;
  scale?: number;
  lit?: boolean;
  mirror?: boolean;
}

interface HeldEntry {
  target: string;
  socket: string;
  propId: string;
  overrides: HeldPropOverrides;
  /** 当前状态名；没有状态表时是空串 */
  state: string;
  persistent: boolean;
  resolved: ResolvedPropAttach;
  /** 自挂上累计秒（火焰信号的钟，不读挂钟） */
  time: number;
  /** 火焰信号的种子：两支并排的火把不同步 */
  seed: number;
  /** 状态过渡：强度从 → 到（毫秒计时） */
  fadeFrom: number;
  fadeTo: number;
  fadeMs: number;
  fadeElapsedMs: number;
  /**
   * 这一帧**用哪盏灯的形状**（色温 / 半径 / 软化 / 闪烁）。
   *
   * 与 `resolved.light` 不同的一种情况就是"渐灭到没有灯的状态"：目标状态 `light: null`
   * 时它仍是上一个状态那盏，强度插值到 0 之后才置 null —— 否则 `fadeMs` 算了也发不出去，
   * 画面上是啪一下黑（2026-09-12 无头实测抓到）。
   */
  lightDef: PropLightDef | null;
  /** 这个状态的粒子挂载（逐条一个效果实例；锚点当时解不出来的 id 为 null，等 update 里解出来再开） */
  mounts: HeldParticleMount[];
  /** 一次性效果（`playPropVfx`）：跟着挂件走、放完即从这里摘掉；id 为 null = 锚点还没解出来，等 update 开 */
  oneShots: HeldParticleMount[];
  /**
   * 上次推灯以来逐帧强度的累加与帧数 —— 推出去的是**这一段的均值**，不是当帧瞬时值。
   *
   * 为什么必须这样:闪烁的三个分量在 7 / 16.9 / 36.6 Hz,而推送限速到 20 Hz,
   * 瞬时采样的 Nyquist 只有 10 Hz ⇒ 上面两个谐波**折叠**成 1~2 Hz 的慢晃,
   * 谷底还被削掉(实测 RMS 偏离真值 10.8%、单次跳变到基准的 20%)。
   * 取区间均值就是正规的抽取滤波:推送率不变、混叠消掉,灯读起来是干净的 7 Hz 呼吸,
   * 细碎的爆裂交给逐帧免费的火那一路(眼睛从火苗读爆裂、从光圈读呼吸)。
   */
  iSum: number;
  iCount: number;
  lastLight: { pos: Vec3; intensity: number } | null;
  /** 燃烧强度过渡：从 → 到（与灯强度共用 fadeMs / fadeElapsedMs 这一个钟） */
  burnFrom: number;
  burnTo: number;
  /** 这一帧火焰信号的**逐帧真值**（火的"热"吃它；灯这一帧没算时由 {@link HeldPropSystem.stepFlameHeat} 补） */
  flameL: number;
  /** 这一帧已经切了几次状态（死循环闸，update 开头清零） */
  transitionsThisFrame: number;
  /** 宿主接地点上一帧的世界位置（帧动画火苗：求速度 → 相对气流）；null = 刚挂上 / 刚解不出来 */
  lastHostWorld: Vec3 | null;
  /** 低通后的火苗高度系数（Heskestad：闪烁输出的 2/5 次方）；null = 从下一个样本重新起 */
  flameHeat: number | null;
  /** 物理闪烁的运行态（灯配了 `flicker.kind`）；换了定义（切状态）按 `flickerKey` 重建 */
  flicker: PhysicalFlicker | null;
  flickerKey: string;
  /**
   * 物理闪烁推给灯的那一份：`flameL` 过推送率的抗混叠低通——一阶，τ = 推送间隔 / 2（与站着时那个"推送间隔长的区间均值"
   * 等效噪声带宽相同：1/(4τ) = 1/(2T)）。
   * 站着（限速推）与走路（位置在动、每帧都推）读同一个低通后的信号——原来走路时推的是没平均的逐帧值，
   * 24 Hz 的湍流原样上屏、一帧一跳（2026-09-15 真跑抓到）。null = 还没起步
   */
  flameLLight: number | null;
  /** 火势 0..1（风吹灭火，见 `PropBlowoutDef`）；没有 `blowout` 的挂件恒 1 */
  vitality: number;
  /**
   * 物理闪烁灯上一帧真正推出去的亮度（这一帧没发光 = 0）。切状态时记成 `fadeFromOutput`，渐变在**亮度本身**上插：
   * 原来插的是基准强度、再乘新状态的闪烁——点着 → 残炭那一下，残炭在大风里的倍率 4–5 乘上还没降下来的点着强度，灯往上窜；
   * 残炭 → 点火那一下低通里还留着残炭的 3.9，亮成点着的 1.8 倍闪一帧（2026-09-15 真跑抓到）。null = 还没发过
   */
  lastLiveOutput: number | null;
  fadeFromOutput: number | null;
  /** 挂点连续解得出来多少秒（挂点一没清零）：火苗粒子从 0 长回来要一茬寿命，物理闪烁的灯跟着它亮起来 */
  regrowSec: number;
  /** 快被吹灭时的时断时续（`gutterDuty(火势)` 驱动）；这一帧燃着没有 */
  gutter: GutterProcess;
  gutterOn: boolean;
  /** `lockPropState` 的锁：`lit` 锁定不灭 / `unlit` 点不燃 / `none`（入档） */
  lock: PropLockMode;
  /** 当前的护火是玩家按住护火键切出来的（松键才切回；别的来源切的护火松键不管） */
  playerGuarding: boolean;
  /** 正在用火种点火（玩家可操作的那件）；null = 没在点 */
  igniting: { name: string; seconds: number; windLimit: number; elapsed: number } | null;
  /** 没点着之后符号还红着抖多久（秒） */
  igniteFailSec: number;
  /** 上一帧宿主脚点（场景 wu）：点火时判"人动了"（不依赖真 3D 几何） */
  lastContact: { x: number; y: number } | null;
  /** 宿主此刻走多快（m/s，场景平面；点火判"人动了"） */
  hostSpeedMps: number;
  /** 还剩多少燃料（秒）；null = 这根没有耐久（烧不完） */
  fuelLeft: number | null;
  /** 烧完了、等手上这根的烟散完就自己卸下（`fuel.keepInHandWhenSpent` 为真时不置） */
  spentDetachPending: boolean;
  /**
   * 烧完那一下的动作（「灭」的进入动作 + `onSpentActions`）跑完了没有。
   * 进入动作是**异步**跑的，那口烟要等它才开得起来——不等就会"烟还没开就把挂件卸了"（2026-09-16 自测抓到）。
   */
  spentActionsDone: boolean;
  /** 这根火把挂的效果块（至多 {@link PROP_EFFECTS_MAX} 块；查不到的跳过） */
  effects: PropEffectDef[];
  /** 这一帧放出去的场的 handle（要撤的时候按它撤） */
  fieldHandles: string[];
  /** 残炭里玩家按住护火键：状态不变（炭不是明火），但挡风按护火状态的比例算——挡住了风火势回得来、就复燃 */
  extraShelter: number;
  /** 点火判定读本帧挡过的风；表现用 air 的低通历史不能让已拢住的手失效。 */
  ignitionWindMps: number;
  /** 这一帧火势在往下掉（提示符号据此跳 / 不跳） */
  falling: boolean;
  /** 火势落在第几档（{@link VITALITY_NOTIFY_STEP}）：档变了才通知 */
  vitalityBucket: number;
  /** 起火点这一帧的场景坐标、脚点、灯位、人身外侧（提示符号用）；解不出来 null */
  hintAnchor: { x: number; y: number; contactX: number; contactY: number; lightWorld: Vec3 | null; outer: -1 | 1 } | null;
  /** 提示符号上一次摆的方向角（弧度，画面；换处有回滞，见 {@link pickHintAngle}）；null = 还没摆过 */
  hintAngle: number | null;
  /** 越线触发的武装位：触发一次后要回到线上方一截才再武装（防在线附近来回抖着连发） */
  emberArmed: boolean;
  outArmed: boolean;
  /** 上一帧宿主接地点的世界位置（与锚点同一个空间；null = 还没解出来过）。粒子带不带、带多少按它拆 */
  lastHostAnchor: Vec3 | null;
  /** 低通后的水平相对气流（M-world wu/s）；null = 从下一个样本重新起 */
  air: Vec3 | null;
  /** 推给视图的帧动画火苗上一次是不是"有"（从有到无要推一次 null） */
  flamePushed: boolean;
}

/** 运行时灯的 id 前缀：`__` 开头，与作者灯 id 天然不撞（校验器不许作者用 `__`） */
const DYNAMIC_LIGHT_PREFIX = '__prop';

/** 位置死区（wu）：1 wu ≈ 角色身高的 1/150，屏幕上远小于一个像素 */
const POS_EPS_WU = 1e-4; // 仅滤浮点噪声；动画的细小挂点位移同样要在本帧推送。

/**
 * 闪烁的**推送频率上限**（Hz）。不是表现参数，是性能闸：灯每推一次就重烘一次整张
 * 光照缓存。7 Hz 的明灭按 20 Hz 采样人眼看不出台阶（每个周期约 3 个样本），
 * 而稳态重算从"几乎每帧"降到三分之一。要更顺滑就把它调高，代价直接写在帧时上。
 */
const FLICKER_PUSH_HZ = 20;
const FLICKER_PUSH_INTERVAL_MS = 1000 / FLICKER_PUSH_HZ;

/**
 * 推送率的**观感代价**（2026-09-12 实测 + 盒式滤波响应推算，两者对得上，误差 < 2%）：
 * 窗口均值把高谐波滤掉，于是灯的摆幅小于作者写的 `amp`。
 *
 * | Hz | 振幅保留率 | 60 fps 下重算帧占比 |
 * |---|---|---|
 * | 20（缺省） | 0.65（实测） | 1/3 |
 * | 30 | ~0.79 | 1/2 |
 * | 40 | ~0.85 | 2/3 |
 * | ≥73 | ~1.0（无滤波） | 几乎每帧，省下的全吐回去 |
 *
 * 这是**观感 × 帧时**的取舍，没有正确答案 —— 所以它可以在 F2 里当场换着看
 * （`setFlickerPushHz`，调试态、不落盘）。
 */
export const FLICKER_PUSH_HZ_CHOICES = [20, 30, 40, 60] as const;

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function vitalityBucketOf(v: number): number {
  return Math.floor(v / VITALITY_NOTIFY_STEP + 1e-9);
}

export class HeldPropSystem implements IGameSystem {
  private entries = new Map<string, HeldEntry>();
  /** 这一帧玩家按键受理没有（演出 / 对话 / 面板里不受理 ⇒ 不出提示符号） */
  private playerInputAccepted = false;
  /**
   * 挂件的等级（挂件 id → 第几级，1 起；没记 = 1）。**按挂件 id 记、不按这次挂载记**：
   * 随身那根火把收进包里、换场景、读档都还是那一级（玩法清单 A3.7「火把养成」）。入档。
   */
  private levels = new Map<string, number>();
  /**
   * 烧了一半的燃料（挂件 id → 还剩几秒）。**按挂件 id 记**：临时火把收进包里再拿出来接着烧那一根，
   * 不是白送一根新的；烧完（`stepFuel` 扣到 0）就忘掉——包里下一根是满的。入档。
   */
  private fuels = new Map<string, number>();
  /** 上一帧推过提示（没有可操作的挂件了要补推一次 null） */
  private hintPushed = false;
  /** 世代号：读档 / 拆除让在途的异步挂载自杀（律 4「旧时间线不写新状态」） */
  private generation = 0;
  /** 上一帧推出去的灯数，用于"从有到无"也要推一次空表 */
  private pushedCount = 0;
  /** 距上次推灯过了多少毫秒（闪烁限速用） */
  private sincePushMs = FLICKER_PUSH_INTERVAL_MS;
  /** 当前推送间隔（毫秒）。F2 可临时换档看观感，见 {@link setFlickerPushHz} */
  private pushIntervalMs = FLICKER_PUSH_INTERVAL_MS;
  /** 本场景里配了 `follow` 的作者灯（进场景时由组装层给） */
  private followLights: LightDef[] = [];
  /** 跟随灯的死区基准（灯 id → 上一次推出去的位置与强度） */
  private followLastPos = new Map<string, { pos: Vec3; intensity: number }>();
  /** 作者灯的强度倍率（落定值）与在途过渡。见 {@link fadeLight} */
  private scales = new Map<string, number>();
  private fades = new Map<string, { from: number; to: number; ms: number; elapsed: number }>();

  constructor(private readonly deps: HeldPropDeps) {}

  init(_ctx: GameContext): void {
    // 无外部状态；重 init 与首次一致（清空即可）
    this.clearAll(false);
  }

  private key(target: string, socket: string): string {
    return `${target}::${socket}`;
  }

  // ------------------------------------------------------------------ 对外（动作 / 组装层）

  /**
   * 挂一支（或换一支）。`stateName` 不给时走预设的 `defaultState`。
   *
   * 贴图的实际挂载由组装层的回调做（它管资源），本系统只管"这个挂点上现在是哪支、
   * 什么状态"以及灯与效果。同名挂点重复挂 = 先把旧的收干净。
   *
   * `opts.enterActions`：挂上时执行初始状态的进入动作。**只有动作入口（`attachToSocket`）给 true**；
   * 读档重挂、切场景自动重挂走缺省 false——那是派生表现，不是"进入"，
   * 否则一读档"点火"的声音与后续信号就再来一遍。
   */
  async attach(
    targetId: string, socket: string, propId: string,
    stateName?: string, overrides: HeldPropOverrides = {},
    opts: { enterActions?: boolean; lock?: PropLockMode; vitality?: number; fuel?: number } = {},
  ): Promise<void> {
    const target = targetId.trim();
    const sock = socket.trim();
    const prop = propId.trim();
    if (!target || !sock || !prop) return;
    const preset = this.deps.getPreset(prop);
    /**
     * 预设根本不在表里 ⇒ **不登记**（组装层已经报过警）。
     * 登记会留一条幽灵：占着这个挂点的 key、在调试面板里显示一个不存在的挂件，
     * 而它连图都没有、永远挂不出东西（2026-09-12 无头实测抓到）。
     */
    if (!preset) {
      this.deps.log(`attachToSocket: 挂件预设「${prop}」不在 prop_presets.json 里，未登记`);
      return;
    }
    const state = resolvePropStateName(preset, stateName);
    if (stateName && preset.states && !state) {
      this.deps.log(`attachToSocket: 挂件「${prop}」没有状态「${stateName}」`);
    }
    /**
     * 挂点名拼错是内容侧最容易犯的错，而它的表现是**完全静默**：每帧 `getSocketLocalPose`
     * 返回 null ⇒ 不发光、不起效果，看起来像"预设配错了"。这里查一次并报出可选名单。
     * 只报不拒 —— 实体可能还没进场（读档时序），拒了会让合法的手持物挂不上。
     */
    const known = this.deps.listSockets(target);
    if (known && !known.includes(sock)) {
      this.deps.log(
        `attachToSocket: ${target} 的动画包没有挂点「${sock}」`
        + `（本包有：${known.length ? known.join('、') : '一个都没标'}）—— 灯与效果不会出现`,
      );
    }
    this.detach(target, sock);
    const effects = this.effectsOf(preset, this.getPropLevel(prop));
    const resolved = this.resolveWith(preset, overrides, state, effects, this.getPropLevel(prop));
    // 火势跟着玩法事实走（切场景重挂、读档）；新挂上的是满的
    const startVitality = Number.isFinite(opts.vitality) ? Math.min(1, Math.max(0, opts.vitality!)) : 1;
    // 燃料同理：没有耐久的挂件恒 null（烧不完）
    const fuelSeconds = preset.fuel?.seconds ?? null;
    const remembered = this.fuels.get(prop);
    const startFuel = fuelSeconds === null
      ? null
      : Math.min(fuelSeconds, Math.max(0, Number.isFinite(opts.fuel) ? opts.fuel! : remembered ?? fuelSeconds));
    const entry: HeldEntry = {
      target, socket: sock, propId: prop, overrides, state,
      persistent: preset?.persistent === true,
      resolved,
      time: 0,
      seed: hashSeed(`${target}/${sock}/${prop}`),
      fadeFrom: resolved.light?.intensity ?? 0,
      fadeTo: resolved.light?.intensity ?? 0,
      fadeMs: 0,
      fadeElapsedMs: 0,
      lightDef: resolved.light,
      mounts: [],
      oneShots: [],
      iSum: 0,
      iCount: 0,
      lastLight: null,
      burnFrom: resolved.burn,
      burnTo: resolved.burn,
      flameL: 1,
      transitionsThisFrame: 0,
      lastHostWorld: null,
      flameHeat: null,
      flicker: null,
      flickerKey: '',
      flameLLight: null,
      vitality: startVitality,
      lastLiveOutput: null,
      fadeFromOutput: null,
      regrowSec: 0,
      gutter: new GutterProcess(hashSeed(`${target}/${sock}/${prop}/gutter`)),
      gutterOn: true,
      lock: opts.lock ?? 'none',
      playerGuarding: false,
      extraShelter: 0,
      ignitionWindMps: 0,
      falling: false,
      vitalityBucket: vitalityBucketOf(startVitality),
      hintAnchor: null,
      hintAngle: null,
      igniting: null,
      igniteFailSec: 0,
      lastContact: null,
      hostSpeedMps: 0,
      fuelLeft: startFuel,
      spentDetachPending: false,
      spentActionsDone: false,
      effects,
      fieldHandles: [],
      emberArmed: true,
      outArmed: true,
      lastHostAnchor: null,
      air: null,
      flamePushed: false,
    };
    this.entries.set(this.key(target, sock), entry);
    this.deps.onHeldChanged();
    this.startParticles(entry);
    const entered = opts.enterActions ? this.runEnterActions(entry) : null;
    await this.applyView(entry);
    if (entered) await entered;
  }

  /**
   * 把当前状态的贴图挂上去。**跨 await 拍世代号**：贴图是异步加载的，回来时世界可能已经
   * 换了（读档 / 切场景 / 这个挂点已被卸下），此时刚挂上的就是个孤儿 —— 当场收掉并中止，
   * 不留残影（teardown-ordering 卡里的"世代号自杀"形状）。
   */
  private async applyView(entry: HeldEntry): Promise<void> {
    const gen = this.generation;
    const resolved = entry.resolved;
    await this.deps.attachView(entry.target, entry.socket, resolved);
    if (gen === this.generation && this.entries.get(this.key(entry.target, entry.socket)) === entry) return;
    this.deps.detachView(entry.target, entry.socket);
  }

  /**
   * 切状态。`fadeMs` 只作用于**灯的强度**（贴图与效果是离散的，纹理没法淡入淡出——
   * 想要"渐变的火焰"就多配一个中间状态）。
   *
   * 挂点上没有挂件时安静返回 false，调用方据此报警。
   *
   * 真的切换了（不是原地踏步）⇒ 执行新状态的进入动作，**不等**它跑完；要等的调用方
   * （`setPropState` 动作）走 {@link setStateAwait}。
   */
  setState(targetId: string, socket: string, stateName: string, fadeMs = 0): boolean {
    const r = this.transition(targetId, socket, stateName, fadeMs);
    if (r.entered) {
      void r.entered.catch((e) => this.deps.log(`setPropState: 进入动作失败 ${String(e)}`));
    }
    return r.ok;
  }

  /** 同 {@link setState}，但返回的 Promise 覆盖进入动作的真实完成时间（顺序动作批要等它）。 */
  async setStateAwait(targetId: string, socket: string, stateName: string, fadeMs = 0): Promise<boolean> {
    const r = this.transition(targetId, socket, stateName, fadeMs);
    if (r.entered) await r.entered;
    return r.ok;
  }

  private transition(
    targetId: string, socket: string, stateName: string, fadeMs: number, byWind = false,
  ): { ok: boolean; entered: Promise<void> | null } {
    const entry = this.entries.get(this.key(targetId.trim(), socket.trim()));
    if (!entry) return { ok: false, entered: null };
    const preset = this.deps.getPreset(entry.propId);
    const want = stateName.trim();
    if (!preset?.states?.[want]) {
      this.deps.log(`setPropState: 挂件「${entry.propId}」没有状态「${want}」`);
      return { ok: false, entered: null };
    }
    if (entry.state === want) return { ok: true, entered: null };
    if (entry.transitionsThisFrame >= MAX_TRANSITIONS_PER_FRAME) {
      this.deps.log(
        `setPropState: ${entry.target}.${entry.socket}（${entry.propId}）一帧内已切 ${entry.transitionsThisFrame} 次状态，`
        + `拒绝切到「${want}」——多半是状态的进入动作互相切来切去`,
      );
      return { ok: false, entered: null };
    }
    entry.transitionsThisFrame++;
    // 动作把火从残炭 / 灭里切出来 = 点火：火势回满、越线重新武装（风吹出来的切换不算点火）
    const prevBlowout = entry.resolved.blowout;
    const prevState = entry.state;
    const prevIntensity = this.currentBaseIntensity(entry);
    entry.fadeFromOutput = entry.lastLiveOutput;
    const prevBurn = this.currentBurn(entry);
    const prevLight = entry.lightDef;
    entry.state = want;
    entry.resolved = this.resolveWith(preset, entry.overrides, want, entry.effects, this.getPropLevel(entry.propId));
    this.deps.onHeldChanged();
    if (!byWind) {
      const b = prevBlowout ?? entry.resolved.blowout;
      const dead = b ? [b.emberState ?? 'ember', b.outState ?? 'out'] : [];
      if (dead.includes(prevState) && !dead.includes(want)) {
        entry.vitality = 1;
        entry.vitalityBucket = vitalityBucketOf(1);
        entry.emberArmed = true;
        entry.outArmed = true;
      }
    }
    entry.fadeFrom = prevIntensity;
    entry.fadeTo = entry.resolved.light?.intensity ?? 0;
    entry.burnFrom = prevBurn;
    entry.burnTo = entry.resolved.burn;
    entry.fadeMs = Math.max(0, fadeMs);
    entry.fadeElapsedMs = 0;
    /**
     * 新状态没有灯（`light: null`，灭了的火把）而又要渐灭 ⇒ **留着上一盏的形状**把强度
     * 送到 0，过渡跑完才真的撤灯。直接换成 null 的话 update 那边整段跳过，`fadeMs`
     * 白算、画面第一帧就黑（2026-09-12 实测：内部 0.6→0 走得好好的，画面啪一下）。
     */
    entry.lightDef = entry.resolved.light
      ?? (entry.fadeMs > 0 && prevIntensity > 0 ? prevLight : null);
    this.swapParticles(entry);
    void this.applyView(entry);
    return { ok: true, entered: this.runEnterActions(entry) };
  }

  /** 执行当前状态的进入动作；没有就是 null。失败只记一行，不让挂件本身的状态回滚（状态已经切过去了）。 */
  private runEnterActions(entry: HeldEntry): Promise<void> | null {
    const raw = entry.resolved.onEnterActions;
    if (raw.length === 0) return null;
    const actions = this.selfTargeted(entry, raw);
    return this.deps.runStateActions(actions).catch((e) => {
      this.deps.log(`挂件「${entry.propId}」状态「${entry.state}」的进入动作失败：${String(e)}`);
    });
  }

  /** 「在这件挂件上播」：顶层的 playPropVfx 没写 target / socket ⇒ 就是这件挂件（嵌套在控制流里的不注入，要写全） */
  private selfTargeted(entry: HeldEntry, raw: readonly ActionDef[]): ActionDef[] {
    return raw.map((a) => {
      if (a.type !== 'playPropVfx') return a;
      const p = a.params ?? {};
      const target = typeof p.target === 'string' && p.target.trim() ? p.target : entry.target;
      const socket = typeof p.socket === 'string' && p.socket.trim() ? p.socket : entry.socket;
      return { ...a, params: { ...p, target, socket } };
    });
  }

  /**
   * `lockPropState`：`lit` 锁定不灭（风压不掉火势——照样闪、照样被吹歪——玩家也熄不了）/ `unlit` 点不燃（玩家点不着）/
   * `none` 解锁。`setPropState` 不受锁。挂点上没有挂件 ⇒ false。锁入档（手持物），切场景重挂带着。
   */
  setLock(targetId: string, socket: string, lock: PropLockMode): boolean {
    const entry = this.entries.get(this.key(targetId.trim(), socket.trim()));
    if (!entry) return false;
    if (entry.lock !== lock) {
      entry.lock = lock;
      this.deps.onHeldChanged();
    }
    return true;
  }

  /** 某人身上挂着的东西此刻的玩法事实（`heldProp` 条件叶与别的系统查这个）；没挂 ⇒ 空数组 */
  /** DEV 燃烧工作台推了模板工作态：可燃挂件按新模板（图 / 握点 / 尺寸）重挂视图（玩法事实不动） */
  reapplyBurnableViews(): void {
    for (const e of this.entries.values()) if (e.resolved.burnable) void this.applyView(e);
  }

  /** 此刻挂着的可燃挂件（所有人；燃烧系统每帧问） */
  listBurnable(): { target: string; socket: string; prop: string; burnable: BurnableHostDef }[] {
    const out: { target: string; socket: string; prop: string; burnable: BurnableHostDef }[] = [];
    for (const e of this.entries.values()) {
      if (e.resolved.burnable) out.push({ target: e.target, socket: e.socket, prop: e.propId, burnable: e.resolved.burnable });
    }
    return out;
  }

  statusOf(targetId: string): HeldPropStatus[] {
    const target = targetId.trim();
    const out: HeldPropStatus[] = [];
    for (const e of this.entries.values()) {
      if (e.target !== target) continue;
      out.push({
        target: e.target, socket: e.socket, prop: e.propId, state: e.state,
        burning: this.isBurning(e),
        vitality: e.vitality, fuel: this.fuelFraction(e),
        effects: [...new Set(e.effects.flatMap((x) => [x.id, ...(x.tags ?? [])]))],
        level: this.getPropLevel(e.propId),
        lock: e.lock,
      });
    }
    return out;
  }

  /**
   * 这一件此刻**真的在烧**（制作人 2026-09-16：「要检测的是火，不是火头」）：
   * 这个状态有灯（灭了的状态 `light: null`）**且**燃烧强度 > 0（供着燃料）**且**火势 > 0
   * **且**这一帧没处在时断时续的断档里——火把看着没火却能点着东西，是 bug。
   */
  private isBurning(e: HeldEntry): boolean {
    if (e.resolved.burnable) return this.deps.burnablePropBurning?.(e.target, e.socket) ?? false;
    if (!(e.resolved.light && e.resolved.light.intensity > 0)) return false;
    if (!(this.currentBurn(e) > 0)) return false;
    if (!(e.vitality > 0)) return false;
    return e.gutterOn;
  }

  /**
   * 某人手上**燃着且能点火**的那件（燃烧系统的点火表演用；预设写了 `igniter`、当前状态没写 `igniter: null`、此刻燃着）。
   * 优先右手。返回挂点、起火点（贴图上的归一化点；没写起火点 = 支点，即挂点本身）与火头火焰长度（厘米）。
   */
  igniterOf(targetId: string): { socket: string; u: number; v: number; flameLengthCm: number } | null {
    const target = targetId.trim();
    let pick: HeldEntry | null = null;
    for (const e of this.entries.values()) {
      if (e.target !== target || !e.resolved.igniter) continue;
      if (!this.isBurning(e)) continue;
      if (!pick || e.socket === 'right_hand') pick = e;
      if (e.socket === 'right_hand') break;
    }
    if (!pick) return null;
    const fp = pick.resolved.firePoint;
    return {
      socket: pick.socket,
      u: fp ? fp[0] : (pick.resolved.anchorX ?? 0.5),
      v: fp ? fp[1] : (pick.resolved.anchorY ?? 0.5),
      flameLengthCm: pick.resolved.igniter!.flameLength ?? PROP_IGNITER_DEFAULT_FLAME_CM,
    };
  }

  /**
   * 燃着且能点火的挂件的火头 = 一段火焰（M-world wu）：从起火点沿"浮力 √(gL) + 火头处相对气流"的方向伸出火焰长度，
   * 粗 = 燃烧面半径（物理闪烁的直径；没写按 10 cm）。组装层每帧交给粒子系统——可燃纸钱碰到会着。
   * 挂点这一帧没标注 / 解不出位置 ⇒ 这一件不出。
   */
  igniterFireSegments(out: VfxFireSegment[]): void {
    for (const e of this.entries.values()) {
      const ig = e.resolved.igniter;
      if (!ig || !this.isBurning(e)) continue;
      const anchor = this.resolveAnchor(e);
      const w = anchor?.vfxWorld;
      if (!w) continue;
      const lenCm = ig.flameLength ?? PROP_IGNITER_DEFAULT_FLAME_CM;
      const uRef = Math.sqrt(9.81 * lenCm / 100);
      const air = e.air;
      const ax = air ? air[0] / FLAME_WU_PER_M : 0;
      const az = air ? air[2] / FLAME_WU_PER_M : 0;
      const len = Math.hypot(ax, uRef, az) || 1;
      const flicker = e.resolved.light?.flicker;
      const diameterM = flicker && 'diameter' in flicker && typeof flicker.diameter === 'number' ? flicker.diameter : 0.1;
      out.push({
        x: w[0], y: w[1], z: w[2],
        ax: ax / len, ay: uRef / len, az: az / len,
        len: lenCm * FLAME_WU_PER_M / 100,
        r: (diameterM / 2) * FLAME_WU_PER_M,
      });
    }
  }

  /**
   * 玩家此刻是不是"护着火"因而只能走不能跑（`playerControl.guardBlocksRun`，缺省 true）。
   * 组装层每帧问它，喂给玩家移动修饰。
   */
  playerGuardBlocksRun(): boolean {
    const pc = this.playerControlled();
    return !!pc && pc.control.guardBlocksRun && pc.entry.state === pc.control.guardState;
  }

  /** 玩家身上有没有能按键操作的挂件（触屏按钮据此显隐） */
  hasPlayerControl(): boolean {
    return this.playerControlled() !== null;
  }

  /** 玩家身上能按键操作的那件：优先右手，其次挂得最早的那件 */
  private playerControlled(): { entry: HeldEntry; control: Required<PropPlayerControlDef> } | null {
    let pick: HeldEntry | null = null;
    for (const e of this.entries.values()) {
      if (e.target !== 'player' || !this.deps.getPreset(e.propId)?.playerControl) continue;
      if (!pick || e.socket === 'right_hand') pick = e;
      if (e.socket === 'right_hand') break;
    }
    if (!pick) return null;
    const c = this.deps.getPreset(pick.propId)!.playerControl!;
    return {
      entry: pick,
      control: {
        litState: c.litState ?? PROP_CONTROL_DEFAULTS.litState,
        guardState: c.guardState ?? PROP_CONTROL_DEFAULTS.guardState,
        outState: c.outState ?? PROP_CONTROL_DEFAULTS.outState,
        extinguishFadeMs: c.extinguishFadeMs ?? PROP_CONTROL_DEFAULTS.extinguishFadeMs,
        igniteFadeMs: c.igniteFadeMs ?? PROP_CONTROL_DEFAULTS.igniteFadeMs,
        hintBelow: c.hintBelow ?? PROP_CONTROL_DEFAULTS.hintBelow,
        guardBlocksRun: c.guardBlocksRun ?? PROP_CONTROL_DEFAULTS.guardBlocksRun,
      },
    };
  }

  /**
   * 玩家按键一帧（`update` 开头调；输入为 null = 这一刻不受理，护火照常松开）。
   * 熄灭 / 点火走与 `setPropState` 同一条切状态的路（进入动作照跑：熄灭照样冒烟），只是多一道锁。
   */
  private stepPlayerControl(): void {
    const pc = this.playerControlled();
    if (!pc) return;
    const { entry, control } = pc;
    const input = this.deps.readPlayerPropInput();
    this.playerInputAccepted = input !== null;
    const preset = this.deps.getPreset(entry.propId);
    const has = (name: string) => !!preset?.states?.[name];
    // 残炭也算还燃着（炭里有火，挡住风就复燃）：T 是把它捂灭，不是点火——点火只对灭了的
    const emberState = preset?.blowout?.emberState ?? 'ember';
    const burning = entry.state === control.litState || entry.state === control.guardState || entry.state === emberState;
    if (entry.playerGuarding && entry.state !== control.guardState) entry.playerGuarding = false;
    const guardHeld = !!input?.guardHeld;
    /**
     * 反向同步（2026-09-23）：跨场景 / 读档重挂挂件时状态跟着走、`playerGuarding` 不跟着走
     * （`attach` 建的新 entry 恒 false），于是"按住 Q 走进下一张图"之后火把永远钉在护火态：
     * 松手不回 lit（下面那条要求 playerGuarding 为真）、再按 Q 也不动（上面那条要求当前是 lit），
     * 而 `guardBlocksRun` 还一直挡着跑步（实测：过了崖墓入口再也跑不起来）。
     *
     * 判据是**此刻还按着 Q**：那就是玩家自己护着的，认领回来，松手照常回 lit。
     * 动作摆出来的护火态（`setPropState guarding`）不按 Q，因此不受影响——
     * "动作切的护火，松键不动它"那条契约原样成立。
     */
    if (!entry.playerGuarding && guardHeld && entry.state === control.guardState) entry.playerGuarding = true;
    // 本帧先收下挡风输入，Q 与 T 同时按下也必须在点火首帧生效。
    entry.extraShelter = guardHeld && entry.state !== control.litState && entry.state !== control.guardState
      ? (preset?.states?.[control.guardState]?.windShelter ?? 0)
      : 0;
    if (input?.togglePressed) {
      if (burning) {
        if (entry.lock === 'lit') {
          this.deps.log(`玩家熄灭：${entry.propId} 锁定不灭，没熄`);
        } else if (has(control.outState)) {
          entry.playerGuarding = false;
          this.transition(entry.target, entry.socket, control.outState, control.extinguishFadeMs);
        }
      } else if (entry.igniting) {
        // 点到一半再按 T = 停手，那一次已经用掉了
        this.failIgnite(entry, 'failCancel');
      } else if (entry.lock === 'unlit') {
        this.deps.log(`玩家点火：${entry.propId} 点不燃，没点着`);
        this.deps.onIgniteResult?.('locked', '');
      } else if (has(control.litState)) {
        this.beginIgnite(entry, control);
      }
      return;
    }
    // 点着的时候不再算点火（动作 / 引火把它点着了）；不受理输入（对话 / 演出 / 面板）= 没点着
    if (entry.igniting && burning) entry.igniting = null;
    if (entry.igniting && !input) this.failIgnite(entry, 'failInterrupted');
    if (guardHeld && entry.state === control.litState && has(control.guardState)) {
      if (this.transition(entry.target, entry.socket, control.guardState, PLAYER_GUARD_FADE_MS).ok) entry.playerGuarding = true;
    } else if (!guardHeld && entry.playerGuarding && entry.state === control.guardState) {
      entry.playerGuarding = false;
      this.transition(entry.target, entry.socket, control.litState, PLAYER_GUARD_FADE_MS);
    }
  }

  /**
   * 按 T 点火（手上的火灭着 / 没点）：宿主给了火种 dep ⇒ 用当前火种开始点（先扣一次）；没给 ⇒ 直接点着（火种落地前的行为，
   * 测试与无背包宿主用）。没设火种 / 用完了 ⇒ 不开始，报结果。
   */
  private beginIgnite(entry: HeldEntry, control: Required<PropPlayerControlDef>): void {
    if (!this.deps.igniterStatus || !this.deps.consumeIgniterUse) {
      if (!this.hasFuelToBurn(entry)) { this.deps.onIgniteResult?.('spent', ''); return; }
      this.transition(entry.target, entry.socket, control.litState, control.igniteFadeMs);
      return;
    }
    if (!this.hasFuelToBurn(entry)) { this.deps.onIgniteResult?.('spent', ''); return; }
    const st = this.deps.igniterStatus();
    if (!st) { this.deps.onIgniteResult?.('noneSet', ''); return; }
    if (!(st.available > 0)) { this.deps.onIgniteResult?.('empty', st.name); return; }
    // 边走边按 T：不开始、不扣（按下去那一刻就判"动了"白扣一份太冤）
    if (entry.hostSpeedMps > IGNITE_MOVE_LIMIT_MPS) { this.deps.onIgniteResult?.('moving', st.name); return; }
    const used = this.deps.consumeIgniterUse();
    if (!used) { this.deps.onIgniteResult?.('empty', st.name); return; }
    entry.igniting = { name: used.name, seconds: Math.max(0.05, used.seconds), windLimit: used.windLimit, elapsed: 0 };
    entry.igniteFailSec = 0;
    this.deps.onIgniteResult?.('started', used.name);
  }

  private failIgnite(entry: HeldEntry, why: HeldIgniteResult): void {
    const name = entry.igniting?.name ?? '';
    entry.igniting = null;
    entry.igniteFailSec = IGNITE_FAIL_SHOW_SEC;
    this.deps.onIgniteResult?.(why, name);
  }

  /**
   * 用火种点火一帧（`stepAirflow` 之后：气流已经算过护火挡风）。火把头的风超过这种火种能扛的 ⇒ 没点着；人走动了 ⇒ 没点着；
   * 点满 ⇒ 切到点着（与按键点火同一条切状态的路：火势回满）。
   */
  private stepIgnite(entry: HeldEntry, dt: number): void {
    const ig = entry.igniting;
    if (!ig) return;
    if (entry.ignitionWindMps > ig.windLimit) { this.failIgnite(entry, 'failWind'); return; }
    if (entry.hostSpeedMps > IGNITE_MOVE_LIMIT_MPS) { this.failIgnite(entry, 'failMove'); return; }
    ig.elapsed += dt;
    if (ig.elapsed < ig.seconds) return;
    const pc = this.playerControlled();
    entry.igniting = null;
    if (pc?.entry === entry) this.transition(entry.target, entry.socket, pc.control.litState, pc.control.igniteFadeMs);
    this.deps.onIgniteResult?.('success', ig.name);
  }

  /**
   * 玩家手上**灭着 / 没点、能被引火**的那件的火头（燃烧系统"从燃着的东西上引火"的表演用）：玩家可操作、此刻不燃着、
   * 没锁点不燃、预设有点着的状态。返回挂点与起火点（贴图归一化；没写起火点 = 支点）。没有 ⇒ null
   */
  relightTipOf(targetId: string): { socket: string; u: number; v: number } | null {
    if (targetId.trim() !== 'player') return null;
    const pc = this.playerControlled();
    if (!pc) return null;
    const { entry, control } = pc;
    const preset = this.deps.getPreset(entry.propId);
    const emberState = preset?.blowout?.emberState ?? 'ember';
    if ([control.litState, control.guardState, emberState].includes(entry.state)) return null;
    if (entry.lock === 'unlit' || !preset?.states?.[control.litState]) return null;
    if (!this.hasFuelToBurn(entry)) return null;              // 烧完的火把引不着
    const fp = entry.resolved.firePoint;
    return {
      socket: entry.socket,
      u: fp ? fp[0] : (entry.resolved.anchorX ?? 0.5),
      v: fp ? fp[1] : (entry.resolved.anchorY ?? 0.5),
    };
  }

  /** 从燃着的东西上引火点着玩家手上的火（不耗火种）。不能引 ⇒ false */
  relightPlayerTorch(): boolean {
    if (!this.relightTipOf('player')) return false;
    const pc = this.playerControlled()!;
    pc.entry.igniting = null;
    return this.transition(pc.entry.target, pc.entry.socket, pc.control.litState, pc.control.igniteFadeMs).ok;
  }

  /**
   * 「快灭了」提示一帧（玩家可操作的那件）。出的条件：按键受理中、有 blowout、没锁定不灭、没灭、起火点解得出来，
   * 且火势低于 `playerControl.hintBelow`（残炭时一直出）。危险程度：提示线处 0 → 火势见底 1，残炭恒 1。
   */
  private pushFireHint(): void {
    const pc = this.playerControlled();
    if (!pc) {
      if (this.hintPushed) {
        this.hintPushed = false;
        this.deps.setFireHint(null);
      }
      return;
    }
    this.hintPushed = true;
    this.deps.setFireHint(this.fireHintOf(pc.entry, pc.control.hintBelow));
  }

  /**
   * 提示符号摆哪个方向（画面单位向量）。障碍（都是从起火点看出去的方向）：
   * - 火舌：往上、按画面横向相对气流往下风歪（`atan(u / HINT_FLAME_LEAN_MPS)`）；
   * - 杆子：起火点 → 挂点（手）；没有起火点（挂点就是火）当竖直向下；
   * - 身体那一侧：水平指向人身中轴（躯干、另一只手、头都在这边）。
   * 交给 {@link pickHintAngle} 选离它们都最远、且不乱跳的方向。
   */
  private hintDirOf(entry: HeldEntry, at: NonNullable<HeldEntry['hintAnchor']>): [number, number] {
    const firePose = { x: at.x - at.contactX, y: at.y - at.contactY };
    const sock = entry.resolved.firePoint ? this.deps.getSocketLocalPose(entry.target, entry.socket) : null;
    const sx = sock ? sock.x - firePose.x : 0;
    const sy = sock ? sock.y - firePose.y : 1;
    let lean = 0;
    const base = at.lightWorld;
    const air = entry.air;
    if (base && air) {
      const s0 = this.deps.worldToScene(base);
      const s1 = this.deps.worldToScene([base[0] + air[0] * HINT_PROBE_S, base[1], base[2] + air[2] * HINT_PROBE_S]);
      if (s0 && s1) lean = Math.atan((s1.x - s0.x) / HINT_PROBE_S / FLAME_WU_PER_M / HINT_FLAME_LEAN_MPS);
    }
    const flame = Math.atan2(-Math.cos(lean), Math.sin(lean));
    const stick = Math.hypot(sx, sy) > 1e-6 ? Math.atan2(sy, sx) : Math.PI / 2;
    // 人身中轴在起火点哪边：起火点在脚点右边（outer = 1）⇒ 身体在左（π）
    const body = at.outer > 0 ? Math.PI : 0;
    const angle = pickHintAngle(
      [
        { angle: flame, half: HINT_FLAME_HALF_RAD },
        { angle: stick, half: HINT_STICK_HALF_RAD },
        { angle: body, half: HINT_BODY_HALF_RAD },
      ],
      entry.hintAngle,
    );
    entry.hintAngle = angle;
    return [Math.cos(angle), Math.sin(angle)];
  }

  private fireHintOf(entry: HeldEntry, below: number): HeldFireHint | null {
    const b = entry.resolved.blowout;
    const at = entry.hintAnchor;
    // 正在用火种点 / 刚才没点着：同一个符号，装的是点了几成
    if (at && this.playerInputAccepted && (entry.igniting || entry.igniteFailSec > 0)) {
      const [dirX, dirY] = this.hintDirOf(entry, at);
      const ig = entry.igniting;
      return {
        targetId: entry.target, sceneX: at.x, sceneY: at.y, dirX, dirY,
        fill: ig ? Math.min(1, ig.elapsed / ig.seconds) : 0,
        danger: ig ? 0 : 1,
        falling: false,
        ember: false,
        mode: ig ? 'igniting' : 'failed',
      };
    }
    if (!this.playerInputAccepted || !at || entry.lock === 'lit') return null;
    // 这里用"当前状态有灯"，不用 isBurning：时断时续断着的那一下 isBurning 是假的，符号会跟着一闪一闪地消失
    if (!(entry.resolved.light && entry.resolved.light.intensity > 0)) return null;
    /**
     * 两件事共用这一个符号：**火要被吹灭了**（装的是火势）与**快烧完了**（装的是剩下的燃料）。
     * 两样都到线时取**更急的那一件**——同一时间只说一件事，玩家才读得出来。
     */
    let fill = 0;
    let danger = -1;
    let ember = false;
    let falling = false;
    if (b && below > 0 && entry.state !== (b.outState ?? 'out')) {
      const isEmber = entry.state === (b.emberState ?? 'ember');
      const v = entry.vitality;
      if (isEmber || v < below) {
        fill = v;
        danger = isEmber ? 1 : Math.min(1, Math.max(0, 1 - v / below));
        ember = isEmber;
        falling = entry.falling;
      }
    }
    const low = this.fuelLow(entry);
    if (low < 1) {
      const fuelDanger = Math.min(1, Math.max(0, 1 - low));
      if (fuelDanger > danger) {
        fill = this.fuelFraction(entry);
        danger = fuelDanger;
        ember = false;
        falling = true;        // 燃料只会越烧越少
      }
    }
    if (danger < 0) return null;
    const [dirX, dirY] = this.hintDirOf(entry, at);
    return { targetId: entry.target, sceneX: at.x, sceneY: at.y, dirX, dirY, fill, danger, falling, ember };
  }

  /**
   * 燃料一帧（玩法清单 A3.7「火把养成」的耐久）：只有燃着的时候烧；残炭慢烧；风大烧得快（气流是挡过风的那一份，
   * 所以护火每秒省燃料——代价是护着火只能走不能跑）。烧完切到灭的状态（与风吹灭同一条路，不算点火），再执行烧完动作。
   */
  private stepFuel(entry: HeldEntry, dt: number): void {
    const fuel = this.deps.getPreset(entry.propId)?.fuel;
    if (entry.fuelLeft === null || !fuel || !(dt > 0) || entry.fuelLeft <= 0) return;
    if (!this.isBurning(entry)) return;
    const b = entry.resolved.blowout;
    const ember = !!b && entry.state === (b.emberState ?? 'ember');
    const u = entry.air ? Math.hypot(entry.air[0], entry.air[2]) / FLAME_WU_PER_M : 0;
    const rate = (1 + (fuel.windFactor ?? PROP_FUEL_WIND_FACTOR) * u)
      * (ember ? PROP_FUEL_EMBER_RATE : 1)
      * propEffectFuelRate(entry.effects);
    const left = entry.fuelLeft - rate * dt;
    if (left > 0) {
      entry.fuelLeft = left;
      return;
    }
    entry.fuelLeft = 0;
    this.fuels.delete(entry.propId);
    // 烧完那口烟是「灭」状态的进入动作播的一次性效果，挂在这件挂件上；
    // 手上这根要等烟散完再拿掉（同帧卸下 = 把烟掐了，2026-09-16 真跑抓到）
    entry.spentDetachPending = !fuel.keepInHandWhenSpent;
    entry.spentActionsDone = false;
    const out = fuel.outState ?? b?.outState ?? 'out';
    const fade = b?.fadeMs ?? PROP_BLOWOUT_DEFAULT_FADE_MS;
    this.deps.onHeldChanged();
    // 烧完与风吹灭同一条路：byWind = true（不是"点火"，火势不回满）
    const waits: Promise<unknown>[] = [];
    if (this.deps.getPreset(entry.propId)?.states?.[out]) {
      const r = this.transition(entry.target, entry.socket, out, fade, true);
      if (r.entered) waits.push(r.entered);
    }
    const actions = fuel.onSpentActions ?? [];
    if (actions.length > 0) {
      waits.push(this.deps.runStateActions(this.selfTargeted(entry, actions)).catch((e) => {
        this.deps.log(`挂件「${entry.propId}」烧完的动作失败：${String(e)}`);
      }));
    }
    // 两串动作都跑完（那口烟开起来了）才轮到"从手上拿掉"去看烟散没散
    void Promise.all(waits).then(() => { entry.spentActionsDone = true; });
  }

  /** 这件挂件现在第几级（1 起）；预设没有等级表 ⇒ 恒 1 */
  getPropLevel(propId: string): number {
    const preset = this.deps.getPreset(propId.trim());
    const max = preset?.levels?.length ?? 0;
    if (max <= 0) return 1;
    return Math.min(max, Math.max(1, this.levels.get(propId.trim()) ?? 1));
  }

  /**
   * 设等级（动作 `setPropLevel`；找人 + 材料升级就是调它）。没有等级表 / 超出范围 ⇒ false，不动。
   * 拿在手上的当场换外观与效果（不重挂、不打断状态）。
   */
  setPropLevel(propId: string, level: number): boolean {
    const id = propId.trim();
    const preset = this.deps.getPreset(id);
    const max = preset?.levels?.length ?? 0;
    if (!preset || max <= 0) {
      this.deps.log(`setPropLevel: 挂件「${id}」没有等级表`);
      return false;
    }
    const want = Math.trunc(level);
    if (!(want >= 1 && want <= max)) {
      this.deps.log(`setPropLevel: 挂件「${id}」没有第 ${level} 级（一共 ${max} 级）`);
      return false;
    }
    if (this.getPropLevel(id) === want) return true;
    this.levels.set(id, want);
    for (const entry of this.entries.values()) {
      if (entry.propId !== id) continue;
      entry.effects = this.effectsOf(preset, want);
      entry.resolved = this.resolveWith(preset, entry.overrides, entry.state, entry.effects, want);
      // 只改"要去哪"，不动"从哪来"与已走的时间：升级正赶上切状态的渐变时接着走，不跳一下
      entry.lightDef = entry.resolved.light;
      entry.fadeTo = entry.resolved.light?.intensity ?? 0;
      void this.applyView(entry);
    }
    this.deps.onHeldChanged();
    return true;
  }

  /** 解一次挂载：等级的外观 → 基础解析 → 效果块倍率。三处（挂上 / 切状态 / 升级）共用，口径不许分叉 */
  private resolveWith(
    preset: PropPresetDef, overrides: HeldPropOverrides, state: string, effects: PropEffectDef[], level: number,
  ): ResolvedPropAttach {
    const lv = preset.levels?.[level - 1];
    const base = lv?.image ? { ...preset, image: lv.image, images: undefined } : preset;
    return applyPropEffects(resolvePropAttach(base, overrides, state), effects);
  }

  /**
   * 这根火把挂了哪几块效果：等级带的 + 预设自己的，查库、跳过查不到的，
   * 至多 {@link PROP_EFFECTS_MAX} 块（多写的只认前两块并记一行）。
   */
  private effectsOf(preset: PropPresetDef, level = 1): PropEffectDef[] {
    const ids = [...(preset.levels?.[level - 1]?.effects ?? []), ...(preset.effects ?? [])];
    if (ids.length === 0 || !this.deps.getEffect) return [];
    const out: PropEffectDef[] = [];
    for (const id of ids) {
      const e = this.deps.getEffect(id);
      if (!e) { this.deps.log(`挂件效果块「${id}」不在 prop_effects.json 里，跳过`); continue; }
      if (out.length >= PROP_EFFECTS_MAX) {
        this.deps.log(`挂件效果块最多 ${PROP_EFFECTS_MAX} 块，「${id}」之后的没算`);
        break;
      }
      out.push(e);
    }
    return out;
  }

  /**
   * 效果块的场（驱虫 / 招东西）一帧：**燃着**才放，放在火头上；不燃 / 挂点解不出来 / 卸下 ⇒ 撤掉。
   * 场的 handle 带上是谁的哪个挂点哪一块，两支火把、两块效果互不覆盖。
   */
  private stepEffectFields(entry: HeldEntry, anchor: { vfxWorld: Vec3 | null } | null): void {
    if (!this.deps.setPropField) return;
    const at = anchor?.vfxWorld ?? null;
    // 这里不用 isBurning：时断时续断着的那一下它是假的，场会跟着一闪一闪（虫子一秒跑一秒回）
    const on = !!at && !!(entry.resolved.light && entry.resolved.light.intensity > 0)
      && entry.vitality > 0 && this.hasFuelToBurn(entry);
    const want: string[] = [];
    if (on) {
      for (const e of entry.effects) {
        for (const [i, f] of (e.fields ?? []).entries()) {
          const handle = `heldProp:${entry.target}:${entry.socket}:${e.id}:${i}`;
          want.push(handle);
          this.deps.setPropField(handle, f, at);
        }
      }
    }
    for (const h of entry.fieldHandles) {
      if (!want.includes(h)) this.deps.setPropField(h, null, null);
    }
    entry.fieldHandles = want;
  }

  /** 撤掉这件挂件放的所有场（卸下 / 拆除 / 切场景） */
  private clearEffectFields(entry: HeldEntry): void {
    if (!this.deps.setPropField) return;
    for (const h of entry.fieldHandles) this.deps.setPropField(h, null, null);
    entry.fieldHandles = [];
  }

  /** 还烧得起来没有：没有耐久的恒真；烧完了（燃料 0）点不着也引不着 */
  private hasFuelToBurn(entry: HeldEntry): boolean {
    return entry.fuelLeft === null || entry.fuelLeft > 0;
  }

  /** 收起来 / 换场景时记住这根还剩多少燃料（烧完的不记：包里下一根是满的） */
  private rememberFuel(entry: HeldEntry): void {
    if (entry.fuelLeft === null) return;
    if (entry.fuelLeft > 0) this.fuels.set(entry.propId, entry.fuelLeft);
    else this.fuels.delete(entry.propId);
  }

  /** 还剩几成燃料（0..1）；没有耐久的恒 1 */
  private fuelFraction(entry: HeldEntry): number {
    const seconds = this.deps.getPreset(entry.propId)?.fuel?.seconds;
    if (entry.fuelLeft === null || !seconds || !(seconds > 0)) return 1;
    return Math.min(1, Math.max(0, entry.fuelLeft / seconds));
  }

  /**
   * 「快烧完了」那一段走了几成：> 1 = 还没到那一段；1 → 0 = 正在烧完的路上；没有耐久的恒 Infinity。
   * 火苗 / 灯的收小与火边的符号**读同一个数**，两处口径不许分叉。
   */
  private fuelLow(entry: HeldEntry): number {
    const seconds = this.deps.getPreset(entry.propId)?.fuel?.seconds;
    if (entry.fuelLeft === null || !seconds || !(seconds > 0)) return Infinity;
    const window = propFuelLowSeconds(seconds);
    return window > 0 ? entry.fuelLeft / window : Infinity;
  }

  /**
   * 燃料乘到火苗与灯上的那个数：还没到「快烧完了」那一段是 1（烧得好好的看不出少），
   * 那一段里线性收到 0——最后那点燃料火苗变小、灯变暗。
   */
  private fuelFactor(entry: HeldEntry): number {
    const low = this.fuelLow(entry);
    return low >= 1 ? 1 : Math.max(0, low);
  }

  /**
   * 火势一帧（见 `PropBlowoutDef`）：气流取 `entry.air`（已算挡风与人走动；没有真 3D 几何 ⇒ 当无风，只回不掉）。
   * 越线按 `auto` 切状态，再执行越线动作；已经在灭的状态里不再算。
   */
  private stepBlowout(entry: HeldEntry, dt: number): void {
    const b = entry.resolved.blowout;
    if (!b || !(dt > 0)) return;
    const outState = b.outState ?? 'out';
    const emberState = b.emberState ?? 'ember';
    if (entry.state === outState) {
      entry.falling = false;
      return;
    }
    const air = entry.air;
    const u = air ? Math.hypot(air[0], air[2]) / FLAME_WU_PER_M : 0;
    const ws = b.windSpeed;
    let v = entry.vitality;
    if (u > ws) {
      if (entry.lock !== 'lit') v -= ((u - ws) / ws / b.drainSeconds) * dt;
    } else {
      v += ((1 - u / ws) / b.recoverSeconds) * dt;
    }
    v = v < 0 ? 0 : v > 1 ? 1 : v;
    entry.falling = v < entry.vitality;
    entry.vitality = v;
    const bucket = vitalityBucketOf(v);
    if (bucket !== entry.vitalityBucket) {
      entry.vitalityBucket = bucket;
      this.deps.onHeldChanged();
    }
    const fade = b.fadeMs ?? PROP_BLOWOUT_DEFAULT_FADE_MS;
    // 残炭里挡住风（护火 / 风停）火势回到线上方一截 ⇒ 复燃（风切的，不算点火：火势不回满，照火势本身往上走）
    if (b.emberBelow !== undefined && entry.state === emberState && b.auto !== false
      && v >= Math.min(1, b.emberBelow + BLOWOUT_REARM_MARGIN)) {
      const back = b.recoverState ?? 'lit';
      if (this.deps.getPreset(entry.propId)?.states?.[back]) {
        this.transition(entry.target, entry.socket, back, fade, true);
        entry.emberArmed = true;
      }
      return;
    }
    if (b.emberBelow !== undefined && entry.state !== emberState) {
      if (v < b.emberBelow && entry.emberArmed) {
        entry.emberArmed = false;
        this.crossLine(entry, b.auto !== false ? emberState : '', fade, b.onEmberActions ?? []);
      } else if (v >= Math.min(1, b.emberBelow + BLOWOUT_REARM_MARGIN)) {
        entry.emberArmed = true;
      }
    }
    if (v <= 0 && entry.outArmed) {
      entry.outArmed = false;
      this.crossLine(entry, b.auto !== false ? outState : '', fade, b.onOutActions ?? []);
    } else if (v >= BLOWOUT_REARM_MARGIN) {
      entry.outArmed = true;
    }
  }

  /** 越线：（auto 时）先切状态（风吹出来的，不算点火），再执行越线动作。都不等，失败只记一行 */
  private crossLine(entry: HeldEntry, toState: string, fadeMs: number, actions: readonly ActionDef[]): void {
    if (toState) {
      const preset = this.deps.getPreset(entry.propId);
      if (preset?.states?.[toState]) {
        const r = this.transition(entry.target, entry.socket, toState, fadeMs, true);
        if (r.entered) void r.entered;
      } else {
        this.deps.log(`挂件「${entry.propId}」被风吹到「${toState}」，但预设里没有这个状态——只执行越线动作`);
      }
    }
    if (actions.length > 0) {
      void this.deps.runStateActions(this.selfTargeted(entry, actions)).catch((e) => {
        this.deps.log(`挂件「${entry.propId}」越线动作失败：${String(e)}`);
      });
    }
  }

  /**
   * 在挂着的挂件上播一个一次性效果（`playPropVfx` 动作）。`point` = 贴图上的点，null = 起火点 → 挂点。
   * 挂点上没有挂件 ⇒ false（调用方报警）。锚点这一刻解不出来就等 update 解出来再开。
   */
  playOneShot(targetId: string, socket: string, effect: string, point: [number, number] | null): boolean {
    const entry = this.entries.get(this.key(targetId.trim(), socket.trim()));
    const id = effect.trim();
    if (!entry || !id) return false;
    const m: HeldParticleMount = { effect: id, point, id: null };
    entry.oneShots.push(m);
    const at = this.mountWorld(entry, m, point ? null : this.resolveAnchor(entry));
    if (at) m.id = this.deps.playVfx(m.effect, at, { targetId: entry.target, socket: entry.socket }, true);
    return true;
  }

  /** 卸下：贴图、灯、效果一起收走。 */
  detach(targetId: string, socket: string): void {
    const k = this.key(targetId.trim(), socket.trim());
    const entry = this.entries.get(k);
    if (!entry) return;
    this.entries.delete(k);
    this.rememberFuel(entry);
    this.clearEffectFields(entry);
    this.stopParticles(entry);
    this.stopOneShots(entry);
    this.deps.detachView(entry.target, entry.socket);
    if (entry.resolved.burnable) this.deps.onBurnablePropRemoved?.(entry.target, entry.socket, entry.propId);
    this.deps.onHeldChanged();
    // 卸下的正是提示着的那件：当场收（手上没东西了 update 会整段跳过，等不到下一帧推 null）
    if (this.hintPushed && !this.playerControlled()) {
      this.hintPushed = false;
      this.deps.setFireHint(null);
    }
  }

  /**
   * 第三件事：**作者灯的渐灭 / 渐亮**（`fadeLight` 动作）。
   *
   * 存的是**强度倍率**而不是绝对强度：作者在编辑器里把那盏灯调亮调暗，运行时这条覆盖
   * 仍然成立（绝对值会把作者的调整整个盖掉）。倍率到 0 = 熄灭（那盏灯连灯槽都不占）。
   *
   * 演出态：不落盘、切场景清空。
   */
  fadeLight(lightId: string, toScale: number, fadeMs = 0): void {
    const id = lightId.trim();
    if (!id) return;
    const to = Number.isFinite(toScale) ? Math.max(0, toScale) : 0;
    const from = this.scaleOf(id);
    if (!(fadeMs > 0)) {
      this.fades.delete(id);
      this.scales.set(id, to);
      this.pushScales();
      return;
    }
    this.fades.set(id, { from, to, ms: fadeMs, elapsed: 0 });
  }

  /** 当前倍率：有在途过渡取插值，否则取落定值，都没有 ⇒ 1（没被碰过的灯） */
  private scaleOf(lightId: string): number {
    const f = this.fades.get(lightId);
    if (f) return f.from + (f.to - f.from) * transitionProgress(f.elapsed, f.ms);
    return this.scales.get(lightId) ?? 1;
  }

  /** 推进在途的灯光过渡；有变化就整批推一次倍率表 */
  private advanceFades(dtMs: number): void {
    if (this.fades.size === 0) return;
    for (const [id, f] of [...this.fades]) {
      f.elapsed += dtMs;
      const p = transitionProgress(f.elapsed, f.ms);
      this.scales.set(id, f.from + (f.to - f.from) * p);
      if (p >= 1) this.fades.delete(id);
    }
    this.pushScales();
  }

  private pushScales(): void {
    this.deps.setLightIntensityScales(new Map(this.scales));
  }

  /**
   * 调试态：临时换闪烁的推送率（不落盘、切场景不重置——就是要能前后对比）。
   * 定下来要改缺省的话改 `FLICKER_PUSH_HZ` 那个常量，不要把调试值写进数据。
   */
  setFlickerPushHz(hz: number): void {
    const v = Number.isFinite(hz) && hz > 0 ? hz : FLICKER_PUSH_HZ;
    this.pushIntervalMs = 1000 / v;
  }

  get flickerPushHz(): number {
    return Math.round(1000 / this.pushIntervalMs);
  }

  /** 当前挂着什么（调试快照 / 编辑器实时面板）。 */
  debugSnapshot(): {
    target: string; socket: string; prop: string; state: string; lightIntensity: number; vitality: number;
    fuel: number; level: number; lock: PropLockMode;
  }[] {
    return [...this.entries.values()].map((e) => ({
      target: e.target, socket: e.socket, prop: e.propId, state: e.state,
      lightIntensity: this.currentBaseIntensity(e), vitality: e.vitality, fuel: this.fuelFraction(e),
      level: this.getPropLevel(e.propId), lock: e.lock,
    }));
  }

  /**
   * 换场景：演出挂件散掉，手持物按玩法事实重挂（实体是新建出来的，视图必须重贴）。
   * 与位面对账器同一个形状 —— 每个边界重派生一次。
   *
   * `followLights` = 新场景里配了 `follow` 的作者灯（组装层从场景数据挑出来给）。
   */
  onSceneChanged(followLights: readonly LightDef[] = []): void {
    /**
     * 留下谁：手持物（入档的）**以及玩家身上的演出挂件**。
     *
     * 后半条是**既有语义**，不是新规则：玩家跨场景长活，组装层的 `destroySceneSocketViews`
     * 刻意只收 NPC 的挂件、留着玩家的（"重挂由内容侧决定"）。NPC 的不留——它们连实体
     * 本身都换了一批，同名 NPC 在新场景重新长出来时手上凭空多把剑才是错的。
     */
    const keep = [...this.entries.values()].filter((e) => e.persistent || e.target === 'player');
    this.clearAll(true);
    this.followLights = followLights.map((l) => ({ ...l }));
    this.followLastPos.clear();
    // 灯的渐灭覆盖是演出态：新场景的灯表是另一套 id，留着只会误伤同名灯
    if (this.scales.size > 0 || this.fades.size > 0) {
      this.scales.clear();
      this.fades.clear();
      this.pushScales();
    }
    for (const e of keep) {
      void this.attach(e.target, e.socket, e.propId, e.state || undefined, e.overrides, {
        lock: e.lock, vitality: e.vitality, fuel: e.fuelLeft ?? undefined,
      });
    }
  }

  /**
   * 场景里配了 `follow` 的作者灯：每帧解成运行时灯。
   *
   * 解不出来（目标不在场 / 挂点这帧没标注 / 没有几何载荷）⇒ **这一帧这盏灯不发光**，
   * 不回落到作者写的 `pos`（回落 = 一盏灯莫名钉在半空，比不亮更难查）。
   */
  private resolveFollowLight(l: LightDef): LightDef | null {
    const f = l.follow;
    if (!f) return null;
    const contact = this.deps.getEntityContact(f.target);
    if (!contact) return null;
    const sock = f.socket?.trim();
    let w: Vec3 | null;
    if (sock) {
      const pose = this.deps.getSocketLocalPose(f.target, sock);
      if (!pose) return null;
      w = this.deps.socketToLightWorld(contact, pose);
      if (w) w = [w[0], w[1] + (f.heightWu ?? 0), w[2]];
    } else {
      w = this.deps.sceneToLightWorld(contact.x, contact.y, f.heightWu ?? 0);
    }
    if (!w) return null;
    const off = f.offset;
    const pos: [number, number, number] = off
      ? [w[0] + off[0], w[1] + off[1], w[2] + off[2]]
      : [w[0], w[1], w[2]];
    // 强度倍率（fadeLight）在光照系统那一层作用于作者灯，而跟随灯走的是运行时灯这条路
    // （原件已被那边跳过），所以要在这里自己乘一次 —— 两条路都吹得灭，语义才一致。
    const intensity = l.intensity * this.scaleOf(l.id);
    if (!(intensity > 0)) return null;
    const out: LightDef = { ...l, pos, intensity, enabled: true };
    delete out.follow;
    return out;
  }

  // ------------------------------------------------------------------ 逐帧

  update(dt: number): void {
    this.advanceFades(dt * 1000);
    if (this.entries.size === 0 && this.followLights.length === 0) {
      if (this.pushedCount > 0) {
        this.pushedCount = 0;
        this.deps.setDynamicLights([]);
      }
      return;
    }
    this.sincePushMs += dt * 1000;
    const lights: LightDef[] = [];
    /** 这一帧烧完、等着烟散完再卸下的（在遍历之外处理，见下） */
    const spentDone: HeldEntry[] = [];
    /** 位置动了 / 灯的增减 ⇒ 立刻推；只有强度在变（闪烁）⇒ 限速推（见 FLICKER_PUSH_HZ） */
    let moved = false;
    let flickered = false;
    // ① 场景里配了 follow 的作者灯
    for (const src of this.followLights) {
      const resolved = this.resolveFollowLight(src);
      const prev = this.followLastPos.get(src.id) ?? null;
      if (!resolved) {
        if (prev) { moved = true; this.followLastPos.delete(src.id); }
        continue;
      }
      lights.push(resolved);
      const now = { pos: resolved.pos as Vec3, intensity: resolved.intensity };
      if (lightChangedEnough(prev, now, POS_EPS_WU, Infinity)) moved = true;
      else if (lightChangedEnough(prev, now)) flickered = true;
    }
    // ② 挂件自带的灯（与火苗）
    this.stepPlayerControl();
    for (const entry of this.entries.values()) {
      entry.transitionsThisFrame = 0;
      entry.time += dt;
      entry.fadeElapsedMs += dt * 1000;
      entry.flameL = 1;
      const anchor = this.resolveAnchor(entry);
      // 渐灭到"没有灯"的状态时这里仍是上一盏的形状，强度到 0 之后才撤（见 lightDef 注释）
      if (entry.lightDef && !entry.resolved.light
        && transitionProgress(entry.fadeElapsedMs, entry.fadeMs) >= 1) {
        entry.lightDef = null;
      }
      let light = entry.lightDef;
      // 火把处的相对气流（场景风 − 人走动，护火挡掉一部分）：火苗倾斜与物理闪烁读同一股风，每帧只算一次
      this.stepAirflow(entry, anchor, dt);
      this.stepHostSpeed(entry, dt);
      this.stepFuel(entry, dt);
      if (entry.igniting) this.stepIgnite(entry, dt);
      if (entry.igniteFailSec > 0) entry.igniteFailSec = Math.max(0, entry.igniteFailSec - dt);
      entry.hintAnchor = anchor
        ? {
          x: anchor.sceneX, y: anchor.sceneY, contactX: anchor.sceneX - anchor.poseX, contactY: anchor.sceneY - anchor.poseY,
          lightWorld: anchor.lightWorld, outer: anchor.side,
        }
        : null;
      entry.regrowSec = anchor ? entry.regrowSec + dt : 0;
      if (!light?.flicker?.kind) entry.flameLLight = null;
      if (light?.flicker?.kind) {
        const air = entry.air;
        const airMps = air ? Math.hypot(air[0], air[2]) / FLAME_WU_PER_M : 0;
        entry.flameL = this.physicalFlicker(entry, light.flicker).step(dt, airMps);
      }
      // 火势（风吹灭火）：越线可能切状态 ⇒ 之后重读灯的形状
      this.stepBlowout(entry, dt);
      light = entry.lightDef;
      // 快被吹灭时的时断时续：断着时灯暗到两成（进低通之前乘，暗下去 / 窜起来都是 25 ms 的一下，不是硬切）
      entry.gutterOn = entry.gutter.step(dt, this.currentGutterDuty(entry));
      if (light?.flicker?.kind) {
        const flick = entry.gutterOn ? entry.flameL : entry.flameL * GUTTER_OFF_LIGHT;
        entry.flameLLight = smoothScalar(entry.flameLLight, flick, dt, this.pushIntervalMs / 1000 / 2);
      }
      // 挂点这一帧没标注（挂件隐着）或场景没有真 3D 几何 ⇒ 这一帧不发光
      if (anchor?.lightWorld && light) {
        // 逐帧算真值（火的大小吃这一个），累进区间均值（灯吃均值，见 iSum 注释）
        const instant = this.liveIntensity(entry, anchor.lightWorld, anchor.heightWu, light);
        let intensity: number;
        if (light.flicker?.kind) {
          // 物理闪烁：liveIntensity 读的已经是按推送率低通过的一份，不再叠区间均值（否则站着双重平滑、走路没平滑）
          intensity = instant;
        } else {
          entry.iSum += instant;
          entry.iCount++;
          intensity = entry.iSum / entry.iCount;
        }
        if (intensity > 0) {
          const def = this.buildLightDef(entry, light, anchor.lightWorld, intensity);
          lights.push(def);
          // 与 commitPushed 记录的最终灯同一把尺（含作者偏移）。
          const now = { pos: def.pos as Vec3, intensity: def.intensity };
          if (lightChangedEnough(entry.lastLight, now, POS_EPS_WU, Infinity)) moved = true;
          else if (lightChangedEnough(entry.lastLight, now)) flickered = true;
        } else if (entry.lastLight) {
          moved = true;
        }
      } else {
        entry.lastLiveOutput = 0;
        if (entry.lastLight) moved = true;
      }
      // 粒子挂载跟着各自的点走；挂上时锚点还没解出来（还没进场景 / 挂点那帧没标注）的这里补开
      this.stepFlameHeat(entry, anchor, light, dt);
      this.stepEffectFields(entry, anchor);
      this.syncParticles(entry, anchor);
      if (entry.spentDetachPending) spentDone.push(entry);
      this.updateVfxScales(entry);
      this.updateFlame(entry, anchor, dt);
    }
    // 烧完的那几根：烟散完了才真的从手上拿掉（在遍历之外做，别在迭代里改 entries）
    for (const entry of spentDone) {
      if (entry.spentActionsDone && entry.oneShots.length === 0) this.detach(entry.target, entry.socket);
    }
    this.pushFireHint();
    /**
     * 推不推：
     * - 位置动了 / 灯的数量变了（从有到无、从无到有）⇒ 立刻推，不走任何限速；
     * - **只有强度在变（闪烁）⇒ 限速**到 `FLICKER_PUSH_HZ`。
     *
     * 为什么要限速:灯每推一次,`SceneLightingPass` 就重烘一次整张光照缓存(全屏 RGBA16F
     * 一遍)。实测(2026-09-12,雾津街头夜)举着 amp 0.2 / 7 Hz 的火把**站着不动**时
     * 73/80 帧都在重算 —— 位置死区帮不上忙,因为强度每帧都越过 1% 的阈值。
     * 而 7 Hz 的明灭在 20 Hz 采样下人眼已经看不出台阶,于是这一条把稳态重算砍掉约 2/3。
     */
    const due = this.sincePushMs >= this.pushIntervalMs;
    if (moved || lights.length !== this.pushedCount || (flickered && due)) {
      this.pushedCount = lights.length;
      this.sincePushMs = 0;
      this.commitPushed(lights);
      this.deps.setDynamicLights(lights);
    }
  }

  /** 推出去之后才更新死区基准 —— 限速跳过的那些帧必须留着"还欠一次推"的账 */
  private commitPushed(lights: readonly LightDef[]): void {
    const byId = new Map(lights.map((l) => [l.id, l]));
    for (const src of this.followLights) {
      const l = byId.get(src.id);
      if (l && l.pos) this.followLastPos.set(src.id, { pos: [l.pos[0], l.pos[1], l.pos[2]], intensity: l.intensity });
      else this.followLastPos.delete(src.id);
    }
    for (const entry of this.entries.values()) {
      const l = byId.get(`${DYNAMIC_LIGHT_PREFIX}_${entry.target}_${entry.socket}`);
      entry.lastLight = l && l.pos
        ? { pos: [l.pos[0], l.pos[1], l.pos[2]], intensity: l.intensity }
        : null;
      // 均值窗口跟着推送重开——不重开的话窗口越来越长，闪烁会被平均成一条直线
      entry.iSum = 0;
      entry.iCount = 0;
    }
  }

  /** 状态基准强度（过渡期间是插值出来的那一档，不含闪烁） */
  private currentBaseIntensity(entry: HeldEntry): number {
    const p = transitionProgress(entry.fadeElapsedMs, entry.fadeMs);
    return entry.fadeFrom + (entry.fadeTo - entry.fadeFrom) * p;
  }

  /** 燃烧强度（过渡期间是插值出来的那一档） */
  private currentBurn(entry: HeldEntry): number {
    const p = transitionProgress(entry.fadeElapsedMs, entry.fadeMs);
    return entry.burnFrom + (entry.burnTo - entry.burnFrom) * p;
  }

  /** 这一帧真正要用的强度 = 基准 × 火焰输出（风把波动幅度推高） */
  private liveIntensity(entry: HeldEntry, anchor: Vec3, heightWu: number, light: PropLightDef): number {
    const f = light.flicker;
    if (f?.kind) return this.physicalLightOutput(entry);
    const base = this.currentBaseIntensity(entry);
    if (!(base > 0)) return 0;
    // 火势（风吹灭火）与燃料乘在灯上；两样都没有的挂件恒 1，原样返回（灯笼逐 tick 数值不许变）
    const vit = this.vitalityFactor(entry) * this.fuelFactor(entry);
    if (!f) return vit === 1 ? base : base * vit;
    const amp = flickerAmpWithWind(f.amp, this.deps.windSpeedAt(anchor, heightWu), f.windAmp);
    const L = flameOutput(entry.time, amp, f.hz, entry.seed);
    // 同一个 L 也喂给火的大小（stepFlameHeat：L^0.4 低通）：光一跳火苗跟着一胀（一个信号，不两处摇随机）
    entry.flameL = L;
    return vit === 1 ? base * L : base * L * vit;
  }

  /**
   * 物理闪烁灯这一帧的亮度：目标 = 新状态强度 × 闪烁（按推送率低通过）× 火势；切状态期间从切换那一刻真实推出去的亮度
   * 线性过到目标（`fadeFromOutput`）；挂点刚回来的一茬火苗寿命内按长回来的比例亮起。
   */
  private physicalLightOutput(entry: HeldEntry): number {
    const target = entry.fadeTo * (entry.flameLLight ?? entry.flameL) * this.vitalityFactor(entry) * this.fuelFactor(entry);
    const p = transitionProgress(entry.fadeElapsedMs, entry.fadeMs);
    let out = entry.fadeFromOutput !== null && p < 1
      ? entry.fadeFromOutput + (target - entry.fadeFromOutput) * p
      : target;
    out *= Math.min(1, entry.regrowSec / FLAME_REGROW_SECONDS);
    out = out > 0 ? out : 0;
    entry.lastLiveOutput = out;
    return out;
  }

  /**
   * 这一帧时断时续的燃着占比：有 `blowout`、还在明火状态（不是残炭 / 灭）、没锁定不灭 ⇒ `gutterDuty(火势)`；否则 1（不断）。
   * 锁定不灭不断：演出要一支稳的火。
   */
  private currentGutterDuty(entry: HeldEntry): number {
    const b = entry.resolved.blowout;
    if (!b || entry.lock === 'lit') return 1;
    if (entry.state === (b.outState ?? 'out') || entry.state === (b.emberState ?? 'ember')) return 1;
    return gutterDuty(entry.vitality);
  }

  /** 火苗这一帧乘的数：火势因子 × 燃料因子 × （断着时）剩下的那一小团 */
  private flameFactor(entry: HeldEntry): number {
    return this.vitalityFactor(entry) * this.fuelFactor(entry) * (entry.gutterOn ? 1 : GUTTER_OFF_FLAME);
  }

  /**
   * 火势乘到燃烧强度与灯上的那个数：一般就是火势；**残炭状态里按残炭线归一**（进残炭那一刻炭火是满的，
   * 火势从残炭线掉到 0 的过程里慢慢暗到没）——原来直接乘 ≤0.35 的火势，风里的残炭几乎一颗炭火都发不出来。
   */
  private vitalityFactor(entry: HeldEntry): number {
    const b = entry.resolved.blowout;
    const v = entry.vitality;
    if (b && b.emberBelow !== undefined && b.emberBelow > 0 && entry.state === (b.emberState ?? 'ember')) {
      return Math.min(1, v / b.emberBelow);
    }
    return v;
  }

  /**
   * 闪烁 → 火焰的"热"：`L^(2/5)` 过 50 ms 低通（Heskestad：火焰长度 ∝ 放热率^0.4；火焰对放热变化有响应时间）。
   * 帧动画火苗的高度与粒子挂载的新生大小**同读这一个数**，每帧只算一次。
   *
   * L：灯那一路算过就用它的逐帧真值 `flameL`（同一个信号）；物理闪烁每帧在灯之前就走过一步，也是 `flameL`。
   * 正弦闪烁灯这一帧没算（状态没有灯 / 没有真 3D 几何解不出灯位），而灯的形状还配着 flicker ⇒ 按**不吃风**的幅度补算——
   * 无几何时连风都取不到，火照样要跳。
   */
  private stepFlameHeat(
    entry: HeldEntry,
    anchor: { lightWorld: Vec3 | null } | null,
    light: PropLightDef | null,
    dt: number,
  ): void {
    let L = entry.flameL;
    const drewLight = !!(anchor?.lightWorld && light && this.currentBaseIntensity(entry) > 0 && light.flicker);
    if (!drewLight && light?.flicker && !light.flicker.kind) {
      L = flameOutput(entry.time, light.flicker.amp, light.flicker.hz, entry.seed);
    }
    entry.flameHeat = smoothScalar(
      entry.flameHeat, Math.pow(Math.max(0, L), BURN_SIZE_EXPONENT), dt, FLAME_HEIGHT_TAU_S,
    );
  }

  /**
   * 该状态粒子挂载的实例倍率，逐帧推（所有挂载同一组）：
   * - 发射率 = 燃烧强度（供了多少燃料）。**闪烁不进发射率**：闪烁幅度在风里会被推到 ±70%，
   *   发射量跟着五六倍地涨落，举着走时火舌断成一串珠子（2026-09-15 真跑抓到）；
   * - 新生粒子大小 = {@link burnSizeScale}（燃烧强度的 2/5 次方）× 火焰的热（闪烁 L^0.4 低通，见 stepFlameHeat）——
   *   闪烁表现为火舌一胀一缩，与帧动画火苗的高度同一个关系、同一个数；
   * - 吃场景风 = 1 − 挡风比例。
   * 没有粒子挂载（灯笼的大多数状态）整段不碰任何东西。
   */
  private updateVfxScales(entry: HeldEntry): void {
    if (!entry.mounts.some((m) => m.id)) return;
    const burn = this.currentBurn(entry) * this.flameFactor(entry);
    const rate = burn;
    const size = burnSizeScale(burn) * (entry.flameHeat ?? 1);
    const wind = 1 - entry.resolved.windShelter;
    // 火焰长度（粒子 `life.maxDistance` 的倍率）：放热率的 2/5 次方（Heskestad）× 横风里被吹短（Thomas u^−0.21，
    // 只有灯配了物理闪烁、知道燃烧面直径时才算）。断着的那一下火焰缩成一小团也在这里
    const f = entry.lightDef?.flicker;
    const air = entry.air;
    const windLen = f?.kind && air ? flameWindFactor(Math.hypot(air[0], air[2]) / FLAME_WU_PER_M, f.diameter) : 1;
    const distance = Math.max(0.05, burnSizeScale(burn) * windLen);
    for (const m of entry.mounts) {
      if (!m.id) continue;
      this.deps.setVfxRate(m.id, rate);
      this.deps.setVfxSizeScale(m.id, size);
      this.deps.setVfxWindScale(m.id, wind);
      this.deps.setVfxDistanceScale(m.id, distance);
    }
  }

  /**
   * 帧动画火苗逐帧：大小 / 倾角 / 帧号 → 视图。没有 `flame` 块的挂件（火把、灯笼）整段不碰任何东西。
   *
   * 闪烁：灯那一路算过就直接用它的逐帧真值 `flameL`（同一个 L）；灯这一帧没算
   * （状态没有灯 / 没有真 3D 几何解不出灯位），而灯的形状还配着 flicker ⇒ 在这里按**不吃风**的幅度补算——
   * 无几何时连风都取不到，火苗照样要跳。
   */
  private updateFlame(
    entry: HeldEntry,
    anchor: { lightWorld: Vec3 | null; heightWu: number } | null,
    dt: number,
  ): void {
    const flame = entry.resolved.flame;
    if (!flame) {
      if (entry.flamePushed) {
        entry.flamePushed = false;
        this.deps.setFlameView(entry.target, entry.socket, null);
      }
      return;
    }
    const burn = this.currentBurn(entry) * this.flameFactor(entry);
    // 高度：热（闪烁 L^0.4 低通，见 stepFlameHeat）——与粒子挂载的新生大小同一个数
    const heat = entry.flameHeat ?? 1;
    const meanHeightWu = flame.height * burn;
    const heightWu = meanHeightWu * heat;
    if (!anchor || !(burn * heat > FLAME_MIN_VISIBLE_RATIO)) {
      entry.flamePushed = true;
      this.deps.setFlameView(entry.target, entry.socket, { visible: false, frame: 0, heightWu: 0, angleRad: 0 });
      return;
    }
    let angleRad = 0;
    let lengthRatio = 1;
    const base = anchor.lightWorld;
    if (base && entry.air) {
      const sb = this.deps.worldToScene(base);
      const sx = this.deps.worldToScene([base[0] + SCREEN_AXIS_PROBE_WU, base[1], base[2]]);
      const sz = this.deps.worldToScene([base[0], base[1], base[2] + SCREEN_AXIS_PROBE_WU]);
      if (sb && sx && sz) {
        // 倾角吃**平均**高度：跟着闪烁的高度走，倾角就跟着闪烁抽搐
        const pose = flameBillboardPose(entry.air, meanHeightWu, screenRightHorizontal(sb, sx, sz));
        angleRad = pose.angleRad;
        lengthRatio = pose.lengthRatio;
      }
    }
    entry.flamePushed = true;
    this.deps.setFlameView(entry.target, entry.socket, {
      visible: true,
      frame: flameFrameIndex(entry.time, flame.fps, flame.frames, entry.seed),
      heightWu: heightWu * lengthRatio,
      angleRad,
    });
  }


  /**
   * 火把处的相对气流（M-world wu/s，只留水平）：场景风 − 宿主速度（宿主接地点求速度，不取跟着手逐帧跳的起火点，
   * 见 FLAME_TELEPORT_WU_PER_S），× (1 − 挡风)，过 80 ms 一阶低通（火焰对气流变化有响应时间；
   * 护火切过来经它过渡，不是一下立直）。帧动画火苗倾斜与物理闪烁都读 `entry.air`。没有真 3D 几何 ⇒ null。
   */
  /** 宿主走多快（场景平面，m/s）：脚点逐帧差分过一道 0.1 s 低通（点火判"人动了"，站着的逐帧抖动不算） */
  private stepHostSpeed(entry: HeldEntry, dt: number): void {
    const c = this.deps.getEntityContact(entry.target);
    if (!c || !(dt > 0)) { entry.lastContact = c ? { x: c.x, y: c.y } : null; entry.hostSpeedMps = 0; return; }
    const prev = entry.lastContact;
    entry.lastContact = { x: c.x, y: c.y };
    if (!prev) return;
    const v = Math.hypot(c.x - prev.x, c.y - prev.y) / dt / FLAME_WU_PER_M;
    // 一帧跳太远 = 切场景 / 瞬移，不算走
    if (v > 50) return;
    entry.hostSpeedMps = smoothScalar(entry.hostSpeedMps, v, dt, 0.1);
  }

  private stepAirflow(entry: HeldEntry, anchor: { lightWorld: Vec3 | null; heightWu: number } | null, dt: number): void {
    const base = anchor?.lightWorld;
    if (!anchor || !base) {
      entry.lastHostWorld = null;
      entry.air = null;
      entry.ignitionWindMps = 0;
      return;
    }
    const contact = this.deps.getEntityContact(entry.target);
    const host = contact ? this.deps.sceneToLightWorld(contact.x, contact.y, 0) : null;
    const velocity: Vec3 | null = host && entry.lastHostWorld && dt > 0
      ? [
        (host[0] - entry.lastHostWorld[0]) / dt,
        (host[1] - entry.lastHostWorld[1]) / dt,
        (host[2] - entry.lastHostWorld[2]) / dt,
      ]
      : null;
    entry.lastHostWorld = host ? [host[0], host[1], host[2]] : null;
    const rel = relativeHorizontalAirflow(this.deps.windVectorAt(base, anchor.heightWu), velocity);
    const open = 1 - Math.max(entry.resolved.windShelter, entry.extraShelter);
    entry.ignitionWindMps = Math.hypot(rel[0], rel[2]) * open / FLAME_WU_PER_M;
    entry.air = smoothAirflow(entry.air, [rel[0] * open, 0, rel[2] * open], dt);
  }

  /** 这盏灯的物理闪烁运行态；定义变了（切状态换了直径 / 种类）就重建，相位从种子重新起 */
  private physicalFlicker(entry: HeldEntry, f: PropFlickerPhysicalDef): PhysicalFlicker {
    const puff = f.puffAmp ?? FLAME_PUFF_AMP_DEFAULT;
    const key = `${f.kind}|${f.diameter}|${puff}`;
    if (!entry.flicker || entry.flickerKey !== key) {
      entry.flicker = new PhysicalFlicker(f.kind, f.diameter, puff, entry.seed);
      entry.flickerKey = key;
      // 换了一种火（明火 ↔ 炭火）：低通从新的火重新起，不带着上一种火的倍率
      entry.flameLLight = null;
    }
    return entry.flicker;
  }

  private buildLightDef(entry: HeldEntry, light: PropLightDef, anchor: Vec3, intensity: number): LightDef {
    const off = light.offset;
    const pos: [number, number, number] = off
      ? [anchor[0] + off[0], anchor[1] + off[1], anchor[2] + off[2]]
      : [anchor[0], anchor[1], anchor[2]];
    const def: LightDef = {
      id: `${DYNAMIC_LIGHT_PREFIX}_${entry.target}_${entry.socket}`,
      kind: 'point',
      pos,
      intensity, // 与普通场景点光同义；此处不另设强度标尺或补偿倍率。
      enabled: true,
    };
    if (light.color) def.color = light.color;
    else if (light.kelvin !== undefined) def.kelvin = light.kelvin;
    if (light.range !== undefined) def.range = light.range;
    if (light.softeningRadius !== undefined) def.softeningRadius = light.softeningRadius;
    if (light.castShadow) def.castShadow = true;
    return def;
  }

  /**
   * 挂点 → 灯位与效果锚点；真 3D 时共享 M-world 点，粒子仍保留平面降级。
   *
   * 宿主脚点锚定直立面，按挂点实际前后关系外推到身体之外；保持投影对准挂点。
   * **铁律 0**：换算一次到底交给组装层注入的 `socketToLightWorld`（内部走
   * `utils/sceneSpace`，朝向过 R、尺度过 wuPerQUnit），本系统不自己拼矩阵。
   *
   * ⚠ 没有照明载荷时效果退到平面近似，那份坐标绝不能当灯位；真 3D 时二者同源。
   * 挂点这一帧没标注 / 实体不在场 ⇒ 整个 null；只是某一边的空间解不出来 ⇒ 那一边 null。
   */
  private resolveAnchor(
    entry: HeldEntry,
  ): {
    lightWorld: Vec3 | null; vfxWorld: Vec3 | null; heightWu: number; front: boolean;
    sceneX: number; sceneY: number; poseX: number; poseY: number; side: -1 | 1;
  } | null {
    const contact = this.deps.getEntityContact(entry.target);
    if (!contact) return null;
    /**
     * 从哪一点出：灯显式点了挂点（`light.socket`，标在人物动画上的火头）→ 那个挂点；
     * 否则挂件有起火点 → 贴图上的起火点（跟着燃烧物的支点 / 自转 / 缩放走）；
     * 都没有 → 挂这件东西的挂点本身（老灯笼：与改造前逐位相同）。
     */
    const lightSocket = entry.resolved.light?.socket?.trim() || '';
    const fire = entry.resolved.firePoint;
    const pose = lightSocket
      ? this.deps.getSocketLocalPose(entry.target, lightSocket)
      : fire
        ? this.deps.getPropPointLocalPose(entry.target, entry.socket, fire)
        : this.deps.getSocketLocalPose(entry.target, entry.socket);
    if (!pose) return null;
    // pose.y 向上为负：离地高度 = −y
    const heightWu = -pose.y;
    const sx = contact.x + pose.x;
    const lightWorld = this.deps.socketToLightWorld(contact, pose);
    return {
      lightWorld,
      // 真 3D 空间里灯与火焰是同一个挂点；没有几何时效果才走既有平面降级。
      vfxWorld: lightWorld ?? this.deps.sceneToVfxWorld(sx, contact.y, heightWu),
      heightWu,
      front: pose.front,
      sceneX: sx,
      sceneY: contact.y + pose.y,
      poseX: pose.x,
      poseY: pose.y,
      side: pose.x < 0 ? -1 : 1,
    };
  }

  /**
   * 一条粒子挂载此刻的世界锚点。写了点 ⇒ 贴图上那一点（穿过挂件自己的支点 / 自转 / 缩放 / 镜像，
   * 再走与灯同一套"挂点 → 身体外侧 M-world"换算，没有真 3D 几何时退到粒子的平面近似）；
   * 没写 ⇒ 灯 / 起火点那个锚点。解不出来 ⇒ null（这一帧不开 / 不挪）。
   */
  private mountWorld(
    entry: HeldEntry, mount: HeldParticleMount, fire: { vfxWorld: Vec3 | null } | null,
  ): Vec3 | null {
    if (!mount.point) return fire?.vfxWorld ?? null;
    const contact = this.deps.getEntityContact(entry.target);
    if (!contact) return null;
    const pose = this.deps.getPropPointLocalPose(entry.target, entry.socket, mount.point);
    if (!pose) return null;
    return this.deps.socketToLightWorld(contact, pose)
      ?? this.deps.sceneToVfxWorld(contact.x + pose.x, contact.y, -pose.y);
  }

  /**
   * 开这一状态的粒子挂载（逐条一个效果实例）。
   *
   * ⚠ **锚点还解不出来的那条不开**（挂点这一帧没标注 / 贴图还没到 / 照明载荷还没到），id 记 null 等 update：
   * 硬拿一个 [0,0,0] 顶上会在世界原点喷一团烟，而世界原点通常在画面外某处 ——
   * 现象是"火把点着的瞬间别处冒了一下"，查起来完全不着边。
   */
  private startParticles(entry: HeldEntry): void {
    entry.mounts = entry.resolved.particles.map((m) => ({ effect: m.effect, point: m.point, id: null }));
    if (entry.mounts.length === 0) return;
    const fire = this.resolveAnchor(entry);
    for (const m of entry.mounts) {
      const at = this.mountWorld(entry, m, fire);
      if (at) m.id = this.deps.playVfx(m.effect, at, { targetId: entry.target, socket: entry.socket }, false);
    }
    // 倍率当场套上：等到下一个 update 才推，新实例头一帧按满燃烧强度发——弱火状态切过来也要先喷一口
    this.updateVfxScales(entry);
  }

  /**
   * 切状态换挂载：新旧两串里**同一效果挂在同一点**的那条沿用原实例（点着 → 护火是同一团火，
   * 重开会让火舌断一拍、起始爆发再喷一次）；旧串里剩下的**软停**（不再发射、在飞的自己老化完——
   * 火舌停了、空中那几点火星该飞完再灭，瞬间清空是假的）；新串里剩下的新开。
   */
  private swapParticles(entry: HeldEntry): void {
    const old = entry.mounts;
    const sameMount = (a: { effect: string; point: [number, number] | null }, b: typeof a) =>
      a.effect === b.effect
      && (a.point === b.point || (!!a.point && !!b.point && a.point[0] === b.point[0] && a.point[1] === b.point[1]));
    const next: HeldParticleMount[] = entry.resolved.particles.map((m) => {
      const k = old.findIndex((o) => sameMount(o, m));
      if (k < 0) return { effect: m.effect, point: m.point, id: null };
      const [kept] = old.splice(k, 1);
      return kept!;
    });
    entry.mounts = old;
    this.stopParticles(entry, true);
    entry.mounts = next;
    const fire = next.some((m) => !m.id) ? this.resolveAnchor(entry) : null;
    for (const m of next) {
      if (m.id) continue;
      const at = this.mountWorld(entry, m, fire);
      if (at) { m.id = this.deps.playVfx(m.effect, at, { targetId: entry.target, socket: entry.socket }, false); m.last = at; }
    }
    if (next.length > 0) this.updateVfxScales(entry);
  }

  /**
   * 一次性效果逐帧：挪到自己的点（转身带粒子，与挂载同一判据）；锚点刚解出来的补开；
   * 实例已经不在了（放完被收 / 切场景散了，`moveVfx` 返回 false）就摘掉——**不重开**，一次性就是一次。
   * 已经开着、这一帧锚点没了（挂点这帧没标注：蹲下）⇒ 当场散、摘掉，与挂件贴图 / 灯同生同灭。
   */
  private syncOneShots(entry: HeldEntry, fire: { vfxWorld: Vec3 | null } | null, hostDelta: Vec3 | null): void {
    if (entry.oneShots.length === 0) return;
    entry.oneShots = entry.oneShots.filter((m) => {
      const at = this.mountWorld(entry, m, fire);
      if (!m.id) {
        if (at) {
          m.id = this.deps.playVfx(m.effect, at, { targetId: entry.target, socket: entry.socket }, true);
          m.last = at;
        }
        return true;
      }
      if (!at) {
        this.deps.stopVfx(m.id);
        return false;
      }
      const carry = rigCarry(m.last ?? null, at, hostDelta);
      m.last = at;
      return this.deps.moveVfx(m.id, at, carry);
    });
  }

  /** 卸下 / 拆除：一次性效果当场散（火把离手，空中挂着一口没有来源的烟就是 bug） */
  private stopOneShots(entry: HeldEntry): void {
    for (const m of entry.oneShots) if (m.id) this.deps.stopVfx(m.id);
    entry.oneShots = [];
  }

  /**
   * @param soft true = 不再发射、在飞的飞完（切状态用）；false = 当场散（卸下 / 拆除用）。
   * 卸下时**不能**软停：火把离手了，空中还挂着一串没有来源的火星，看起来就是个 bug。
   */
  private stopParticles(entry: HeldEntry, soft = false): void {
    for (const m of entry.mounts) {
      if (!m.id) continue;
      if (soft) this.deps.softStopVfx(m.id);
      else this.deps.stopVfx(m.id);
    }
    entry.mounts = [];
  }

  /**
   * 逐帧：每条挂载挪到自己的点；还没开的（锚点刚解出来）补开；实例被切场景散掉了的重开。
   *
   * **挂点这一帧没了**（动画这帧没标注：蹲下）⇒ 挂件贴图与灯当场没了，粒子也当场散（硬停、不软停），挂点回来再从新位置开。
   * 原来是 `continue`：实例留在最后那个锚点接着发，人蹲下火把没了、火还在半空烧（2026-09-15 制作人抓到）。
   *
   * **在飞的粒子带多少**：锚点这一帧的位移拆成两份——宿主在世界里的平移（人走路）+ 锚点相对宿主的位移
   * （动画带出来的：转身翻面、走 / 站换姿势、逐帧动画换帧那一跳）。前者不带：粒子留在空气里，拖尾就是这么来的；
   * 后者整团带上：动画是一帧一帧跳的（手的位置 4 tick 一跳 7–15 wu、走停切姿势一跳几十 wu），真的火把是连续动的，
   * 不带的话火舌断成一串珠子、换姿势时火团挂在杆子半腰上（2026-09-15 真跑抓到）。
   */
  private syncParticles(entry: HeldEntry, fire: { vfxWorld: Vec3 | null } | null): void {
    const contact = this.deps.getEntityContact(entry.target);
    // 与锚点同一个空间：有真 3D 几何时锚点在 M-world，没有时在粒子的平面近似里
    const host = contact
      ? (this.deps.sceneToLightWorld(contact.x, contact.y, 0) ?? this.deps.sceneToVfxWorld(contact.x, contact.y, 0))
      : null;
    const prev = entry.lastHostAnchor;
    const hostDelta: Vec3 | null = host && prev ? [host[0] - prev[0], host[1] - prev[1], host[2] - prev[2]] : null;
    entry.lastHostAnchor = host ? [host[0], host[1], host[2]] : null;
    this.syncOneShots(entry, fire, hostDelta);
    if (entry.mounts.length === 0) return;
    let started = false;
    for (const m of entry.mounts) {
      const at = this.mountWorld(entry, m, fire);
      if (!at) {
        if (m.id) this.deps.stopVfx(m.id);
        m.id = null;
        m.last = null;
        continue;
      }
      const carry = rigCarry(m.last ?? null, at, hostDelta);
      m.last = at;
      // 粒子是表演态：实例被散掉（moveVfx 返回 false）就重开一个，别让火把从此没有火
      if (m.id && this.deps.moveVfx(m.id, at, carry)) continue;
      m.id = this.deps.playVfx(m.effect, at, { targetId: entry.target, socket: entry.socket }, false);
      started = started || !!m.id;
    }
    if (started) this.updateVfxScales(entry);
  }

  // ------------------------------------------------------------------ 存档 / 拆除

  serialize(): object {
    const held = [...this.entries.values()]
      .filter((e) => e.persistent)
      .map((e) => ({
        target: e.target, socket: e.socket, prop: e.propId, state: e.state,
        ...(e.lock !== 'none' ? { lock: e.lock } : {}),
        // 火势是玩法事实（快灭的火读档回来还是快灭的）；满的不写
        ...(e.vitality < 1 ? { vitality: Math.round(e.vitality * 1000) / 1000 } : {}),
        // 燃料是玩法事实（烧了一半的火把读档回来还是烧了一半）；没有耐久的不写
        ...(e.fuelLeft !== null ? { fuel: Math.round(e.fuelLeft * 100) / 100 } : {}),
      }));
    const levels: Record<string, number> = {};
    for (const [id, lv] of this.levels) if (lv > 1) levels[id] = lv;
    // 收在包里那几根烧了一半的（拿在手上的那根的燃料写在 held 里）
    const fuels: Record<string, number> = {};
    for (const [id, left] of this.fuels) {
      if (left > 0 && ![...this.entries.values()].some((e) => e.propId === id)) fuels[id] = Math.round(left * 100) / 100;
    }
    const hasLevels = Object.keys(levels).length > 0;
    const hasFuels = Object.keys(fuels).length > 0;
    if (held.length === 0 && !hasLevels && !hasFuels) return {};
    return {
      ...(held.length > 0 ? { held } : {}),
      ...(hasLevels ? { levels } : {}),
      ...(hasFuels ? { fuels } : {}),
    };
  }

  deserialize(data: object): void {
    // 读档 = 换时间线：在途挂载作废，当前挂的全收走，再按档里的事实重挂
    this.clearAll(true);
    // 等级与"烧了一半的"先恢复：重挂时要按等级解外观、按剩余燃料接着烧
    this.levels.clear();
    this.fuels.clear();
    const fu = (data as { fuels?: unknown }).fuels;
    if (fu && typeof fu === 'object' && !Array.isArray(fu)) {
      for (const [id, n] of Object.entries(fu as Record<string, unknown>)) {
        if (typeof n === 'number' && Number.isFinite(n) && n > 0) this.fuels.set(id, n);
      }
    }
    const lv = (data as { levels?: unknown }).levels;
    if (lv && typeof lv === 'object' && !Array.isArray(lv)) {
      for (const [id, n] of Object.entries(lv as Record<string, unknown>)) {
        if (typeof n === 'number' && Number.isFinite(n) && n >= 1) this.levels.set(id, Math.trunc(n));
      }
    }
    const raw = (data as { held?: unknown }).held;
    if (!Array.isArray(raw)) return;
    for (const it of raw) {
      if (!it || typeof it !== 'object') continue;
      const r = it as Record<string, unknown>;
      const target = typeof r.target === 'string' ? r.target : '';
      const socket = typeof r.socket === 'string' ? r.socket : '';
      const prop = typeof r.prop === 'string' ? r.prop : '';
      const state = typeof r.state === 'string' ? r.state : '';
      if (!target || !socket || !prop) continue;
      const vitality = typeof r.vitality === 'number' && Number.isFinite(r.vitality) ? r.vitality : undefined;
      const fuel = typeof r.fuel === 'number' && Number.isFinite(r.fuel) ? r.fuel : undefined;
      void this.attach(target, socket, prop, state || undefined, {}, {
        lock: parsePropLockMode(r.lock) ?? 'none', vitality, fuel,
      });
    }
  }

  destroy(): void {
    this.clearAll(true);
    this.followLights = [];
    this.scales.clear();
    this.fades.clear();
  }

  /** `bumpGeneration` = 让在途的异步挂载作废（读档 / 拆除 / 切场景都要） */
  private clearAll(bumpGeneration: boolean): void {
    if (bumpGeneration) this.generation++;
    if (this.entries.size > 0) this.deps.onHeldChanged();
    if (this.hintPushed) {
      this.hintPushed = false;
      this.deps.setFireHint(null);
    }
    for (const entry of this.entries.values()) {
      this.rememberFuel(entry);
      this.clearEffectFields(entry);
      this.stopParticles(entry);
      this.stopOneShots(entry);
      this.deps.detachView(entry.target, entry.socket);
    }
    this.entries.clear();
    this.followLastPos.clear();
    if (this.pushedCount > 0) {
      this.pushedCount = 0;
      this.deps.setDynamicLights([]);
    }
  }
}
