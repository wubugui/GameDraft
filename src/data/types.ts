// ============================================================
// IGameSystem - 所有系统的统一接口约定
// ============================================================

export interface GameContext {
  eventBus: EventBus;
  flagStore: FlagStore;
  strings: StringsProvider;
  assetManager: AssetManager;
}

export interface IGameSystem {
  init(ctx: GameContext): void;
  update(dt: number): void;
  serialize(): object;
  deserialize(data: object): void;
  destroy(): void;
}

// 这里只声明类型形状，实际类由各自模块导出
// 用 import type 引用避免循环依赖
import type { EventBus } from '../core/EventBus';
import type { StringsProvider } from '../core/StringsProvider';
import type { FlagStore } from '../core/FlagStore';
import type { AssetManager } from '../core/AssetManager';
import type { SpeakerSide } from '../utils/dialogueSpeakerSide';

import cutsceneActionAllowlist from './cutscene_action_allowlist.json';

// ============================================================
// 游戏状态枚举
// ============================================================

export enum GameState {
  MainMenu = 'MainMenu',
  Exploring = 'Exploring',
  /** 探索中下发的同步/异步指令链在执行中（不接收移动与场景交互），执行完或未占用则回到 Exploring */
  ActionSequence = 'ActionSequence',
  Dialogue = 'Dialogue',
  Encounter = 'Encounter',
  Cutscene = 'Cutscene',
  UIOverlay = 'UIOverlay',
  Minigame = 'Minigame',
}

// ============================================================
// FlagStore 条件格式
// ============================================================

export interface Condition {
  flag: string;
  op?: '==' | '!=' | '>' | '<' | '>=' | '<=';
  /** 与 FlagStore 一致；字符串可在运行时经 ConditionEvalContext.resolveConditionLiteral 解析 [tag:…] 后再比较 */
  value?: boolean | number | string;
}

// ============================================================
// ActionExecutor 动作格式
// ============================================================

export interface ActionDef {
  type: string;
  params: Record<string, unknown>;
}

// ============================================================
// 场景数据
// ============================================================

/** 场景 JSON 原始格式，worldWidth/worldHeight 可缺省一个（按背景图比例推导） */
export type SceneDataRaw = Omit<SceneData, 'worldWidth' | 'worldHeight'> & {
  worldWidth?: number;
  worldHeight?: number;
};

export interface SceneDepthConfig {
  depth_map: string;
  collision_map: string;
  M: { R: number[][]; ppu: number; cx: number; cy: number };
  depth_mapping: { invert: boolean; scale: number; offset: number };
  shader: {
    /** 直立 quad 的深度梯度 = tanθ/ppu（往上越靠近相机）。遮挡唯一还用的 shader 参数 */
    depth_per_sy: number;
  };
  collision?: {
    x_min: number; z_min: number; cell_size: number;
    grid_width: number; grid_height: number; height_offset: number;
  };
  depth_tolerance: number;
  floor_offset: number;
}

/** RGB 颜色，分量 0..1 */
export type RgbColor = [number, number, number];

/** 主光（key light），定义阴影投射方向与色温 */
export interface SceneKeyLight {
  /** 光来向方位角（度，屏幕平面，0=右、逆时针）；阴影朝其反方向投 */
  azimuthDeg?: number;
  /** 仰角（度）：越低阴影越长 */
  elevationDeg?: number;
  /** 主光颜色 0..1，缺省暖白 */
  color?: RgbColor;
  /** 主光强度，缺省 1 */
  intensity?: number;
}

/** 环境光（ambient），决定 sprite 整体被染上的底色 */
export interface SceneAmbientLight {
  color?: RgbColor;
  intensity?: number;
}

/** 阴影/AO 模式:real=深度重建的真实阴影;planar=早期平面投影+碰撞裁切+遮挡 blend;off=关闭 */
export type ShadowMode = 'real' | 'planar' | 'off';

/** 投影阴影参数（per-scene 可覆盖由 key light 推导出的默认值） */
export interface SceneShadowParams {
  enabled?: boolean;
  /** 阴影/AO 模式（场景级覆盖全局 entityLighting.shadowMode） */
  mode?: ShadowMode;
  /** real 模式软阴影采样数（1=硬，默认 1） */
  softSamples?: number;
  /** real 模式软阴影锥半径（默认 0.05） */
  softRadius?: number;
  /** real 模式遮挡 billboard 朝向：light=垂直于光(默认)，camera=朝相机 */
  billboard?: 'light' | 'camera';
  /** 阴影不透明度 0..1 */
  darkness?: number;
  /** 柔和度（模糊强度倍率），1=默认 */
  softness?: number;
  /** 阴影长度相对角色高度的倍率，缺省由仰角推导 */
  length?: number;
  /** 脚底接触阴影（地面 omni 暗斑）强度 0..1，让角色"坐进"地面；0=关闭 */
  contact?: number;
  /** 接触暗斑大小倍率，默认 1 */
  contactSize?: number;
}

/** Ambient Occlusion（shader 内逐像素）参数 */
export interface SceneAoParams {
  /** 脚底接触暗化 0..1 */
  contact?: number;
  /** 体积/自遮挡暗化 0..1 */
  form?: number;
}

/**
 * 单场景光照环境：驱动「逐 entity 色调融入 + AO + 投影阴影」。
 * 全部字段可缺省，缺省时回落到 game_config.entityLighting.defaultLightEnv 再到内置基线。
 */
export interface SceneLightEnv {
  key?: SceneKeyLight;
  ambient?: SceneAmbientLight;
  shadow?: SceneShadowParams;
  /** 色调融入强度 0..1：sprite 向脚底 probe 采样到的环境色做保亮度白平衡 */
  toneStrength?: number;
  /** 色调融入开关（场景级覆盖全局 entityLighting.toneEnabled），与阴影模式解耦 */
  toneEnabled?: boolean;
  ao?: SceneAoParams;
}

/**
 * 光照环境曲线控制点：世界坐标 (x,y) + 一份「部分」光照关键帧。
 * env 各字段全部可缺省；缺省字段在插值后由 resolveLightEnv 回落到全局默认/内置基线。
 */
export interface LightEnvCurvePoint {
  /** 世界坐标 X */
  x: number;
  /** 世界坐标 Y（与 Player/NPC 的 y 同义，脚底锚点） */
  y: number;
  /** 该控制点处的光照关键帧（与 SceneLightEnv 同构，所有字段可缺省） */
  env: SceneLightEnv;
}

/**
 * 逐场景「光照环境曲线」：一条世界空间折线，运行时把玩家位置投影到折线上得弧长参数 t，
 * 再按 t 在相邻关键帧之间插值出当前 SceneLightEnv，喂给 resolveLightEnv。
 * 至少 2 个点才生效；缺省或 <2 点时整条曲线被忽略，回落到 scene.lightEnv（现状不变）。
 */
export interface LightEnvCurveDef {
  points: LightEnvCurvePoint[];
}

/** 透视深度轴端点：世界坐标 + 该端缩放系数（>0） */
export interface PerspectivePoint {
  x: number;
  y: number;
  scale: number;
}

/** 深度轴中途缩放停靠点：pos 为沿 near→far 的归一化位置（0..1，端点独占 0/1，中途取开区间） */
export interface PerspectiveMidStop {
  pos: number;
  scale: number;
}

/**
 * 场景透视缩放（近大远小）：作者画一根「深度轴」箭头（near=近端大 → far=远端小，可任意方向，
 * 贴合斜街/斜纵深），实体按**脚底点在该轴上的投影**分段线性插值出系数 f。轴外投影钳到端点。
 * 最终缩放 = 实例 scale（手动基准）× f；系数为纯派生态不入档。等值线（等缩放）自动垂直于轴。
 * 缺省（不写键）= 不缩放，存量场景零变化。玩家/NPC 默认参与；热点默认不参与
 * （多为 WYSIWYG 贴背景绘制），可经 HotspotDef.perspectiveScaleEnabled 逐热点开启。
 */
export interface PerspectiveScaleConfig {
  /** 近端（大）：轴起点 + 该端缩放 */
  near: PerspectivePoint;
  /** 远端（小）：轴终点 + 该端缩放 */
  far: PerspectivePoint;
  /** 可选中途停靠点（非线性纵深，如台阶）；pos∈(0,1)，求值前按 pos 排序 */
  midStops?: PerspectiveMidStop[];
  /** 移动步长是否同步 × f（防远处滑步）；缺省 true */
  affectsSpeed?: boolean;
}

export interface SceneData {
  id: string;
  name: string;
  /** 世界单位：场景宽度 */
  worldWidth: number;
  /** 世界单位：场景高度（可从 worldWidth 和背景图比例推导） */
  worldHeight: number;
  backgrounds: BackgroundLayer[];
  spawnPoint: Position;
  spawnPoints?: Record<string, Position>;
  hotspots?: HotspotDef[];
  npcs?: NpcDef[];
  zones?: ZoneDef[];
  /**
   * 场景内一等实体分组。成员仍以 npc/hotspot/zone.group 引用本表 id；省略本表时，
   * 旧场景里的 group 字符串继续按无条件分组工作（读取兼容，不要求运行时迁移）。
   */
  entityGroups?: SceneEntityGroupDef[];
  bgm?: string;
  ambientSounds?: string[];
  /** 氛围滤镜 ID，对应 assets/data/filters/{filterId}.json，未写则不应用滤镜 */
  filterId?: string;
  depthConfig?: SceneDepthConfig;
  /** 透视缩放（近大远小）；缺省 = 不缩放。与 depthConfig 相互独立（正交模型不含透视信息） */
  perspectiveScale?: PerspectiveScaleConfig;
  /** 光照环境（逐 entity 阴影/色调/AO）；缺省回落到全局默认 */
  lightEnv?: SceneLightEnv;
  /** 光照环境曲线：玩家位置投影到折线后插值切换光照关键帧；缺省=用静态 lightEnv（现状不变） */
  lightEnvCurve?: LightEnvCurveDef;
  /**
   * 日夜循环开关。**缺省（不写键）= 本场景不参与日夜**——旧场景零影响。
   * 开启后本场景的 NPC 才受日程/`phases` 管，时段变化才会发出外观切换的事件。
   *
   * 注意本开关**不规定外观怎么变**：换图、实时算光、什么都不做，都是合法选择。
   */
  dayNight?: SceneDayNightConfig;
  /**
   * NPC 离场/入场用的**语义出口**（门、街口）。缺省可不配：不配时按场景边界推导
   * （见 `NpcScheduleSystem.resolveExitPoint`），保证任何场景都不会出现"当面消失"。
   */
  exitAnchors?: SceneExitAnchor[];
  /**
   * 逐时段的外观覆盖（键 = 时段 id），**纯可选的其中一条路**。
   *
   * 夜景怎么来由渲染侧自己定，本字段只服务于「这个时段换一套素材」那一种做法：
   * - 另画一张夜景图 / 换滤镜 / 换环境音 → 用本字段列出覆盖项；
   * - 同一张图按时刻**实时算**（光照曲线、色调滤镜）→ **完全不必写本字段**，
   *   渲染侧直接听 `time:changed` / `time:phaseChanged` 或读 `minutesOfDay` 自行推算。
   *
   * 不写 ≠ 没有日夜外观。校验器刻意不对"开了 dayNight 却没写 timeVariants"报任何问题。
   * 未列出的时段沿用场景顶层的对应字段。
   */
  timeVariants?: Record<string, SceneTimeVariant>;
  /** 相机配置 */
  camera?: SceneCameraConfig;
  /** 世界整体缩放（用于背景图分辨率不够时整体缩小），默认1 */
  worldScale?: number;
  /** 本场景玩家行走速度（世界单位/秒），未写则使用默认值 */
  playerWalkSpeed?: number;
  /** 本场景玩家奔跑速度（世界单位/秒），未写则使用默认值 */
  playerRunSpeed?: number;
  /**
   * 每次成功加载本场景时顺序执行一次（与 Zone 的 onEnter 无关）。
   * 时机：场景资源装载、实体滤镜/光照就绪（`scene:ready`）并揭幕（切场过渡遮罩淡出）**之后**触发。
   * 因此这里发起的成段演出（过场/对话）落在**可见**场景之上，不会被加载遮罩盖住，长演出也不阻塞揭幕。
   */
  onEnter?: ActionDef[];
}

/** 场景内实体分组；conditions 与成员自身条件按 AND 合成。 */
export interface SceneEntityGroupDef {
  id: string;
  label?: string;
  conditions?: ConditionExpr[];
  /**
   * 编辑器工作态：**运行时完全忽略**（与 parallaxScene 的 camera/depth 同语义）。
   * 分组本身没有坐标——整组位移由编辑器把偏移烘进每个成员自己的坐标，
   * 这里只保存"怎么在编辑器里摆弄这个组"的作者态偏好。
   */
  editor?: SceneEntityGroupEditorState;
}

/** 分组的编辑器工作态（运行时不消费；缺省即默认行为，不写键 = 零存量影响）。 */
export interface SceneEntityGroupEditorState {
  /** 画布上组把手的世界坐标；不写 = 按成员包围盒中心派生。 */
  anchor?: Position;
  /** 整组位移是否连 NPC 的 patrol.route 一起挪；不写 = 挪（true）。 */
  movePatrol?: boolean;
}

/** 场景相机配置 */
export interface SceneCameraConfig {
  /** 相机缩放，默认1 */
  zoom?: number;
  /** 1世界单位对应多少像素，默认1 */
  pixelsPerUnit?: number;
}

// ============================================================
// 热区数据
// ============================================================

export type HotspotType = 'inspect' | 'pickup' | 'transition' | 'npc' | 'encounter' | 'act_spot';

// ============================================================
// 玩家身体动词（姿态 + 一次性动作）
// ============================================================

/**
 * 玩家身体动词。两类语义：
 * - 姿态（`crouch` / `gaze` / `lie`）：持续态，单槽互斥，进/出各一次回调，**不入存档**。
 * - 一次性动作（`kick` / `jump`）：播一段动画 → 到 `callbackFrame` 触发回调 → 回 idle。
 *   **没有命中判定、没有前后摇分段、没有冷却**（本作是冒险解谜，不是 ARPG）。
 */
export const PLAYER_VERBS = ['crouch', 'gaze', 'kick', 'jump', 'lie'] as const;
export type PlayerVerb = (typeof PLAYER_VERBS)[number];

/** 姿态槽（`stand` 为无姿态的缺省态，不属于动词） */
export const PLAYER_POSTURES = ['crouch', 'gaze', 'lie'] as const;
export type PlayerPosture = (typeof PLAYER_POSTURES)[number];

/**
 * 动词 -> 必需的**逻辑**状态名（经 `playerAvatar.stateMap` 解析到实际片段）。
 * 解析不到 = 该动词在当前装扮下禁用，无隐式回落（显式优于隐式：想让注视复用站姿，
 * 就在 stateMap 里写 `"gaze": "stand"`）。
 */
export const PLAYER_VERB_LOGICAL_STATES: Record<PlayerVerb, string> = {
  crouch: 'crouch',
  gaze: 'gaze',
  lie: 'lie',
  kick: 'kick',
  jump: 'jump',
};

/** 蹲行专用可选逻辑名：缺失时蹲着移动沿用 `crouch` 片段（不影响蹲的可用性）。 */
export const PLAYER_CROUCH_WALK_LOGICAL_STATE = 'crouchWalk';

export function isPlayerVerb(v: unknown): v is PlayerVerb {
  return typeof v === 'string' && (PLAYER_VERBS as readonly string[]).includes(v);
}

export function isPlayerPosture(v: unknown): v is PlayerPosture {
  return typeof v === 'string' && (PLAYER_POSTURES as readonly string[]).includes(v);
}

/**
 * zone 的动词响应表（与 onEnter/onStay/onExit 同级、同执行口）。
 *
 * **实体级没有对应字段**：某个具体目标要对动词有反应，走它**已有的对话图**——
 * 动词名即图的 entry（踢狗 = 打开狗的图、entry 走 `kick`）。图里没有该 entry
 * 就等于这个目标不吃这个动词。这样实体上零新增字段，分支逻辑留在唯一能分支的地方
 * （图的 switch），策划也不必学新面板。
 */
export type ZoneActMap = Partial<Record<PlayerVerb, ActionDef[]>>;

/** 姿态动词的全局参数 */
export interface PlayerPostureConfig {
  enabled?: boolean;
  /** 姿态期间移速系数（乘在场景速度上）；缺省 1 */
  speedScale?: number;
  /** false 时姿态期间屏蔽奔跑；缺省沿用姿态默认 */
  allowRun?: boolean;
  /** 进入姿态的动画时长（毫秒，仅用于锁输入窗口）；缺省 250 */
  enterMs?: number;
  /** 退出姿态（起身）的动画时长（毫秒），期间不可打断；缺省 300 */
  exitMs?: number;
  /** gaze 专用：按住多久才触发目标 acts.gaze；缺省 0 = 进入注视即触发 */
  holdMsToTrigger?: number;
  /** lie 专用：为 true 时允许在任意地面躺下（缺省 false，只允许在 act_spot 躺点） */
  freeAnywhere?: boolean;
}

/** 一次性动作动词的全局参数 */
export interface PlayerActConfig {
  enabled?: boolean;
  /** 回调落在动画第几帧（0 基，越界取模）；缺省片段中点。仅为表演对齐，不影响成败 */
  callbackFrame?: number;
  /** 锁移动时长（毫秒）；缺省 = 片段自己播完一遍。jump 由 durationMs 接管 */
  lockMs?: number;
  /** kick 专用：无目标时的空挥回调（可不配，此时按下只播动画） */
  missActions?: ActionDef[];
  /** jump 专用：抛物线时长（毫秒）；缺省 480 */
  durationMs?: number;
  /** jump 专用：抛物线视觉抬升高度；缺省 46 */
  arcHeight?: number;
}

/** `game_config.playerActs`：整块缺省 = 五个动词全按缺省开启 */
export interface PlayerActsConfig {
  crouch?: PlayerPostureConfig;
  gaze?: PlayerPostureConfig;
  lie?: PlayerPostureConfig;
  kick?: PlayerActConfig;
  jump?: PlayerActConfig;
}

/**
 * 强制与其它实体的叠放档位；缺省字段则与众人一样仅按 Y 排序。
 * 热区展示图与 NPC 共用同一套语义（Renderer 认的是容器上的 `entitySortBand`，与实体种类无关）。
 */
export type EntitySpriteSort = 'back' | 'front';

/** @deprecated 用 {@link EntitySpriteSort}；保留别名仅为不打断既有 import。 */
export type HotspotDisplaySpriteSort = EntitySpriteSort;

/** 热区展示图：底边中点对齐热区 (x,y)，向上延伸 worldHeight、水平居中 worldWidth（与角色脚底锚点一致） */
export interface HotspotDisplayImage {
  /** 资源路径，如 `/resources/runtime/images/...` */
  image: string;
  worldWidth: number;
  worldHeight: number;
  /**
   * 展示图左右朝向（水平镜像 scale.x）。缺省为 right，与 NpcDef.initialFacing 语义一致。
   */
  facing?: 'left' | 'right';
  /** 有图时与角色/NPC 的叠放层级；不设则与众人同规则按 Y */
  spriteSort?: EntitySpriteSort;
}

export interface HotspotDef {
  id: string;
  type: HotspotType;
  x: number;
  y: number;
  /**
   * 位面归属（见 `systems/plane/types.ts` PlaneDef）：缺省 = 实体存在于**所有**位面；
   * 有值时仅当激活位面包含于该列表时实体启用（由 PlaneReconciler 经派生基底通道驱动）。
   */
  planes?: string[];
  /**
   * 时段归属（与 `planes` 同构的白名单）。**缺省 = 只在白日（`day`）出没**——
   * 这个世界的人白天做事、天一擦黑就归家，「街上有人」是特例不是常态。
   * 要让他在拂晓/黄昏也在，显式写 `["dawn","day","dusk"]`；要昼夜常驻就四段全写。
   * 用于「整条街的群演」这类批量表达——有作息的具名角色请用 NPC 日程表
   * （npc_schedules.json），两者正交。值须是 `game_config.dayNight.phases` 里的 id。
   *
   * ⚠ 只在场景 `dayNight.enabled` 时生效；没开日夜的场景完全不走时段过滤。
   * ⚠ 热点与 zone 的同名字段**不吃这个缺省**（它们缺省仍是全时段都在）。
   */
  phases?: string[];
  /** 关联一个或多个过场；有值时默认作为仅过场实体，除非 cutsceneOnly 显式为 false。 */
  cutsceneIds?: string[];
  /**
   * 有过场关联时默认 true：普通场景不生成，仅在关联过场中从场景文件初始化。
   * 显式 false 时是普通场景/过场共享实体，普通场景从 sceneMemory 初始化。
   */
  cutsceneOnly?: boolean;
  interactionRange: number;
  /** 组内 AND；可为 flag / quest / scenario 等 `ConditionExpr` 叶子或组合 */
  conditions?: ConditionExpr[];
  /**
   * 为 true 且配置了非空 conditions 时：条件不满足则热区不渲染、不参与交互（与过场绑定、sceneMemory.enabled 叠加：二者任一为 false 则仍不可见）。
   */
  conditionHidesEntity?: boolean;
  label?: string;
  autoTrigger?: boolean;
  data: InspectData | PickupData | TransitionData | NpcHotspotData | EncounterTriggerData | ActSpotData;
  /** 可选：展示用贴图，底中锚点对齐 (x,y) */
  displayImage?: HotspotDisplayImage;
  /**
   * 可选：相对热区锚点 (x,y) 的局部多边形（与 `collisionPolygonLocal` 配合）。
   * 旧场景未写 `collisionPolygonLocal` 时按世界坐标兼容。
   */
  collisionPolygon?: { x: number; y: number }[];
  /** 为 true 时 `collisionPolygon` 为局部坐标；缺省视为旧版世界坐标 */
  collisionPolygonLocal?: boolean;
  /** 投射阴影 + 接触 AO 开关（合并）；缺省视为 true。false 时该实体不投影也无接触 AO。仅对有 displayImage 的热区有意义。 */
  castShadow?: boolean;
  /**
   * 实例级等比缩放（quad 级真变换，绕脚底锚点）：渲染/碰撞多边形/交互半径/
   * 阴影尺寸/气泡/遮挡随动；缺省 1。可经 setEntityField 运行时改并入档。
   */
  scale?: number;
  /** 实例级旋转（度，绕脚底锚点）；quad 级真变换同上；缺省 0。 */
  rotation?: number;
  /**
   * 深度遮挡半透明混合系数 [0,1]：被场景深度遮挡的精灵像素 alpha 乘此系数
   * （0=硬裁切完全隐藏，1=完全不裁）。缺省时用场景默认（SceneDepthSystem 当前 0.28）。
   * 显式给值的实体不再随 F2 全局遮挡混合滑块变化。
   */
  occlusionBlendFactor?: number;
  /**
   * 参与场景透视缩放（SceneData.perspectiveScale）：热点缺省 **false**（多为 WYSIWYG
   * 贴背景绘制，缩放反而破坏对位）；地面道具（displayImage、可能被移动）可显式开启。
   */
  perspectiveScaleEnabled?: boolean;
  /** 场景内实体分组 id；旧数据的纯字符串标签继续兼容。 */
  group?: string;
}

/** 无 graphId 的 inspect：可选正文浮层 + 可选 actions（可与 actions 单独存在） */
export interface InspectDataTextMode {
  text?: string;
  actions?: ActionDef[];
  graphId?: undefined;
  entry?: undefined;
}

/** 新版 inspect：图对话（看板等） */
export interface InspectDataGraphMode {
  graphId: string;
  entry?: string;
  actions?: ActionDef[];
  text?: undefined;
}

export type InspectData = InspectDataTextMode | InspectDataGraphMode;

export interface PickupData {
  itemId: string;
  itemName: string;
  count: number;
  isCurrency?: boolean;
}

export interface TransitionData {
  targetScene: string;
  targetSpawnPoint?: string;
}

export interface NpcHotspotData {
  npcId: string;
}

/**
 * `act_spot` 热点：身体动词的语境点（躺点 / 跨点）。**不出 E 提示**，出的是动词提示。
 * - `verbs: ['lie']` = 躺点：玩家在范围内按蹲键改为躺下。
 * - `verbs: ['jump']` = 跨点：玩家在范围内按跳键跳到 `landing`（无视沿途阻挡）。
 */
export interface ActSpotData {
  verbs: PlayerVerb[];
  /** 起手前先走到的对齐点（缺省 = 不对齐，就地做） */
  align?: { x: number; y: number };
  /** 起手朝向（缺省 = 保持当前朝向） */
  facing?: 'left' | 'right';
  /** jump 必填：落点世界坐标 */
  landing?: { x: number; y: number };
  /** 玩家可见提示词（可含 `[tag:…]`）；缺省用热点 label */
  promptKey?: string;
  /** 动词生效时执行 */
  actions?: ActionDef[];
  /** 姿态型动词（lie）退出时执行 */
  exitActions?: ActionDef[];
  /** jump 专用覆盖：抛物线时长/弧高（缺省用 game_config.playerActs.jump） */
  durationMs?: number;
  arcHeight?: number;
}

// ============================================================
// NPC 数据
// ============================================================

export interface PatrolDef {
  route: { x: number; y: number }[];
  speed?: number;
  /** 沿路径移动时播放的状态名（须存在于 npc.animFile）；不设则移动时不切换动画 */
  moveAnimState?: string;
}

/** 图对话 JSON 中的说话人（与 `public/assets/dialogues/graphs/*.json` 一致） */
export type DialogueGraphSpeaker =
  | { kind: 'player' }
  | { kind: 'npc' }
  | { kind: 'literal'; name: string }
  | { kind: 'sceneNpc'; npcId: string };

/**
 * 对话行头像引用（可选）：由编辑器可视化选择器写入，运行时按
 * `resources/runtime/images/dialogue_portraits/<slug>/<slug>_<emotion>.png` 直接加载。
 * `slug` = 立绘集目录（多数等于 NPC 的 animFile bundle id），`emotion` = 9 表情之一
 * （calm/angry/fear/cry/sad/empty_eyes/smirk/laugh/zombified）。不设 portrait 则该行不显头像。
 *
 * `slug` 可缺省 =「跟随说话 NPC」：运行时按说话人（kind:'npc'/'sceneNpc'）解析到场景 NPC 的
 * `NpcDef.portraitSlug`；说话人不是 NPC 或该 NPC 未配置 portraitSlug 时该行不显头像。
 * 共享图（同一图挂不同 NPC）用此写法自动跟人换脸。
 */
export interface DialoguePortraitRef {
  slug?: string;
  emotion: string;
}

/** 任务状态叶子（与 JSON 中 questStatus / status 兼容） */
export type QuestConditionLeaf = {
  quest: string;
  questStatus: 'Inactive' | 'Active' | 'Completed';
};

/** Scenario 阶段叶子（与 scenarios.json 清单一致）；outcome 可选，与 ScenarioStateManager 存的一致才为真 */
export type ScenarioConditionLeaf = {
  scenario: string;
  phase: string;
  status: string;
  outcome?: string | number | boolean | null;
};

/** Scenario 整条线生命周期（与 manualLineLifecycle + activateScenario 一致，读存档 lineLifecycle） */
export type ScenarioLineConditionLeaf = {
  scenarioLine: string;
  lineStatus: 'inactive' | 'active' | 'completed';
};

/**
 * NarrativeStateManager 状态叶子。
 * - 缺省（`reached` 不填）：判断该图 **当前** activeState 是否等于 `state`。
 * - `reached: true`：判断该图是否 **到达过** `state`（含当前；initialState 视为到达过）。
 *   线性流程里的「X 之后可见/可去」类门控应使用 reached 语义。
 */
export type NarrativeStateConditionLeaf = {
  narrative: string;
  state: string;
  reached?: boolean;
};

/**
 * 结算计数叶（叙事运行实例化 v2，设计稿 artifact/Design/叙事运行实例化-技术设计-2026-07-17.md §3.5）：
 * 活计原型累计结算次数比较（跨轮持久历史的一等表达；「首次接单」= { op: '==', value: 0 }）。
 * exitState 缺省 = 全部出口合计。活计当前状态用普通 NarrativeStateConditionLeaf（单活模型下直接读）。
 */
export type NarrativeRunCountConditionLeaf = {
  narrativeCount: string;
  exitState?: string;
  op?: '==' | '!=' | '>' | '>=' | '<' | '<=';
  value: number;
};

/**
 * 位面叶子：当前**激活位面** === 该 id（含 manual override 压过叙事点名后的结果）。
 * 组合语义用 all/any/not（如「非 normal」= { not: { plane: 'normal' } }）。
 */
export type PlaneConditionLeaf = {
  plane: string;
};

/**
 * 玩家身体姿态条件叶：`{ posture: 'crouch' }`。
 * 姿态是**瞬时表现态**（不入存档），但它和位面一样是"世界此刻的样子"的一部分，
 * 所以走同一条条件通道：热点/NPC 的 `conditions`（默认只锁交互不隐藏，正好是
 * 「蹲下才翻得动柴堆」要的语义）、图对话 switch、zone、叙事图都能读。
 * 值须为 PLAYER_POSTURES 之一；`{not:{posture:…}}` 表示"不在该姿态"。
 */
export type PostureConditionLeaf = {
  posture: string;
};

/**
 * 时段条件叶：`{ timePhase: 'night' }`。与 posture / plane 同一条通道——
 * 时段也是"世界此刻的样子"，且它由时刻**派生**（不是独立状态），故不镜像成 flag。
 * 值须是 `game_config.dayNight.phases` 里的某个 id；`{not:{timePhase:…}}` 表示"不在该时段"。
 */
export type TimePhaseConditionLeaf = {
  timePhase: string;
};

/** 图对话原子条件（无逻辑组合） */
export type GraphConditionLeaf =
  | Condition
  | QuestConditionLeaf
  | ScenarioConditionLeaf
  | ScenarioLineConditionLeaf
  | NarrativeStateConditionLeaf
  | NarrativeRunCountConditionLeaf
  | PlaneConditionLeaf
  | PostureConditionLeaf
  | TimePhaseConditionLeaf;

/**
 * 递归条件：叶子或 all / any / not（与叙事文档 ConditionExpr 一致）。
 * 图对话 preconditions、switch、文档揭示等共用同一求值器。
 */
export type ConditionExpr =
  | GraphConditionLeaf
  | { all: ConditionExpr[] }
  | { any: ConditionExpr[] }
  | { not: ConditionExpr };

/** @deprecated 请用 ConditionExpr；保留别名以减小 diff */
export type GraphCondition = ConditionExpr;

export interface DialogueLinePayload {
  speaker: DialogueGraphSpeaker;
  text?: string;
  textKey?: string;
  /** 可选头像（编辑器可视化选择器写入）；不设则该拍不显头像 */
  portrait?: DialoguePortraitRef;
  /**
   * 可选：说话中「…」气泡的**绝对**头顶锚（说话实体局部 y，脚点 0、向上为负）。
   * 不设 = 继承实体按当前帧内容自算（绝大多数情况）；设了就固定在这个高度。
   * 与 portrait 同范式：节点级作各拍默认，拍内自带的覆盖之。
   */
  bubbleAnchorY?: number;
  /** 可选：本行气泡缩放；不设 = 用全局 `game_config.emoteBubbleScale`。同样节点级作各拍默认。 */
  bubbleScale?: number;
  /**
   * 可选：本拍立绘/名牌所在边，覆盖「主角在右、其余在左」的默认推导。
   * 用于两个 NPC 对谈也想各占一边的场合；与 portrait 同范式。
   */
  speakerSide?: SpeakerSide;
}

export interface GraphChoiceOptionDef {
  id: string;
  text: string;
  next: string;
  requireFlag?: string;
  /** 与图 switch共用 ConditionExpr；若与 requireFlag 同时存在则两者均须满足。 */
  requireCondition?: ConditionExpr;
  costCoins?: number;
  /** 与 UI「规矩」标签、灰色样式相关；锁定时可与 strings 中 choiceNeedRule 组合成提示 */
  ruleHintId?: string;
  /**
   * 选项不可选时，玩家点击该条后弹出的说明文案。
   * 不填则运行时按 requireFlag / costCoins / ruleHintId 自动生成（规矩名、铜钱数等）。
   */
  disabledClickHint?: string;
}

export type DialogueGraphNodeDef =
  | {
      type: 'line';
      speaker: DialogueGraphSpeaker;
      text?: string;
      textKey?: string;
      /** 可选头像（首拍/单拍用；多拍各拍在 lines[].portrait 上） */
      portrait?: DialoguePortraitRef;
      /** 可选：说话气泡绝对头顶锚，作各拍默认（拍内自带的覆盖之）；见 DialogueLinePayload.bubbleAnchorY */
      bubbleAnchorY?: number;
      /** 可选：说话气泡缩放，作各拍默认；见 DialogueLinePayload.bubbleScale */
      bubbleScale?: number;
      /** 多拍连续对白（每拍仍需点击继续）；若存在则按顺序播放，且首拍应与 speaker/text/textKey 一致（可由编辑器镜像） */
      lines?: DialogueLinePayload[];
      next: string;
    }
  | {
      type: 'runActions';
      actions: ActionDef[];
      next: string;
    }
  | {
      type: 'choice';
      promptLine?: DialogueLinePayload;
      options: GraphChoiceOptionDef[];
    }
  | {
      type: 'switch';
      cases: {
        /** 单条 ConditionExpr（优先于 conditions） */
        condition?: ConditionExpr;
        /** legacy：组内 AND，等价于 all(conditions) */
        conditions?: ConditionExpr[];
        next: string;
      }[];
      defaultNext: string;
    }
  | {
      type: 'ownerState';
      wrapperGraphId?: string;
      cases: {
        state: string;
        next: string;
      }[];
      defaultNext: string;
      missingWrapperNext?: string;
    }
  | {
      type: 'contextState';
      graphId: string;
      cases: {
        state: string;
        next: string;
      }[];
      defaultNext: string;
    }
  | { type: 'end' };

/** 图对话资源根结构（JSON 文件） */
export interface DialogueGraphFile {
  schemaVersion: number;
  id: string;
  entry: string;
  /** 每条为独立条件，组间 AND（与旧版一致） */
  preconditions?: ConditionExpr[];
  nodes: Record<string, DialogueGraphNodeDef>;
  meta?: { title?: string; scenarioId?: string };
}

/** 文档揭示配置（document_reveals.json） */
export interface DocumentRevealDef {
  id: string;
  blurredImagePath: string;
  clearImagePath: string;
  revealCondition: ConditionExpr;
  animation: { durationMs: number; delayMs: number };
  revealedFlag?: string;
  /**与 blendOverlayImage 共用 overlay id，缺省为 docReveal_{id} */
  overlayId?: string;
  xPercent?: number;
  yPercent?: number;
  widthPercent?: number;
  /**
   * 揭示音效：`audio_config.sfx` 的 id，与叠化同时起播（即等过 `animation.delayMs` 之后），
   * 经统一动作通道 `playSfx` 播放；留空＝无声。
   */
  revealSfx?: string;
  /** 揭示音效音量倍数 0..1（覆盖 audio_config 里该条目的基础音量）；未填＝用条目自身音量 */
  revealSfxVolume?: number;
}

/**
 * scenarios.json 中 requires 的布尔式：叶子为 phase 名，语义为该 phase 当前 status === `done`。
 * - `string[]`（旧）：等价于逐项与（须全部为 done）。
 * -对象：`all` 与、`any` 或、`not` 非；可嵌套。
 */
export type ScenarioRequiresExpr =
  | string
  | { all: ScenarioRequiresExpr[] }
  | { any: ScenarioRequiresExpr[] }
  | { not: ScenarioRequiresExpr };

/** scenarios.json 中单个 phase 的清单模板（默认 status、依赖、默认 outcome 等） */
export interface ScenarioCatalogPhaseEntry {
  status?: string;
  outcome?: string | number | boolean | null;
  /** 推进本 phase 前应满足的 phase 完成条件（同一条 scenario 内） */
  requires?: string[] | ScenarioRequiresExpr;
}

/** scenarios.json 根（编辑器与 exposes 运行时） */
export interface ScenarioCatalogEntry {
  id: string;
  /**
   * 为 true 时本条线在运行时须先执行 `activateScenario` 才可 `setScenarioPhase`；
   * `completeScenario` 后禁止再改 phase。存档中单独持久化线状态。
   */
  manualLineLifecycle?: boolean;
  description?: string;
  /**
   * 进线门槛：开始本条 scenario 前应满足的 phase 完成条件。
   * 与 `phases[name].requires`（单 phase 前置）语义不同。
   */
  requires?: string[] | ScenarioRequiresExpr;
  /** 当该 phase 被设为 status done 时，写入 exposes 中的 flag（须同时配置 exposes） */
  exposeAfterPhase?: string;
  /** 键须为登记表中的 flag；值为 bool / number / string，与登记表 valueType 一致 */
  exposes?: Record<string, boolean | number | string>;
  phases?: Record<string, ScenarioCatalogPhaseEntry>;
  /**
   * 归属本 scenario 的图对话资源 id（与 `dialogues/graphs/<id>.json` 及图根字段 `id` 一致）。
   * 由图 `meta.scenarioId` 与工程加载时扫描维护，写入 scenarios.json。
   */
  dialogueGraphIds?: string[];
}

export interface ScenarioCatalogFile {
  scenarios: ScenarioCatalogEntry[];
}

/**
 * 角色注册表条目（`assets/data/character_registry.json`）：把「同一角色跨场景重复配置」
 * 的身份数据（名字 / 动画包 / 对话头像）收敛到一处，场景 NpcDef 用 `characterId` 引用。
 * NpcDef 仍可就地覆盖任一字段（按摆放特例）。运行时在 SceneManager.instantiateNpc 合并：
 * 优先级 = NpcDef 自带字段 > 本注册表默认 >（portraitSlug 缺省再按 animFile 包名推导）。
 */
export interface CharacterDef {
  /** 稳定角色 id（NpcDef.characterId 引用它） */
  id: string;
  /** 显示名 */
  name?: string;
  /** 动画包 anim.json URL */
  animFile?: string;
  /** 对话头像立绘集目录名；缺省按 animFile 包名同名推导 */
  portraitSlug?: string;
  /**
   * 这个角色**默认**的图对话（`public/assets/dialogues/graphs/<id>.json` 的资源 id）：
   * 「跟这个人说话走哪张图」。摆放侧 `NpcDef.dialogueGraphId` 就地写即覆盖本默认
   * （同一个人在不同场次演不同的戏是常态，如克拉拉在城门/街头是两张图）。
   *
   * ⚠ 与 `dialogueGraphEntry` **成对继承**：摆放一旦自带 `dialogueGraphId`，
   * 本角色的 entry 也不再继承——理由见 `applyCharacterDefaults`。
   */
  dialogueGraphId?: string;
  /**
   * 配合 `dialogueGraphId` 的图内入口（覆盖图 JSON 自带的 `entry`）；
   * 用于多个角色共用一张图、各走各入口的写法。单独写本字段而不写
   * `dialogueGraphId` 无意义，校验器会报。
   */
  dialogueGraphEntry?: string;
  /**
   * 化身配置：**有这段 = 该角色可被玩家接管**（受控），缺省 = 只能当 NPC。
   *
   * 与 `game_config.playerAvatar` 是同一套语义（移动三态映射 + 身体动词 + 待机节目单），
   * 差别只在 `animFile` / `portraitSlug` 不在这里重复——它们是 CharacterDef 自己的字段。
   */
  avatar?: CharacterAvatarConfig;
}

/**
 * 可接管角色的化身配置。字段语义与 {@link PlayerAvatarConfig} 逐条一致，
 * 唯一区别是不含 `animManifest` / `portraitSlug`（由所属 CharacterDef 的
 * `animFile` / `portraitSlug` 承担），避免同一事实两处可写。
 */
export interface CharacterAvatarConfig {
  /**
   * 逻辑状态名 -> anim.json 里 states 的键。未写的键视为「与逻辑名同名」。
   * 移动三态固定 idle / walk / run；身体动词见 `PLAYER_VERB_LOGICAL_STATES`。
   * **某逻辑名在本角色下解析不到实际片段 = 该动词在本角色下自动禁用**——
   * 配角不需要补齐六个动词的片段才能上场。
   */
  stateMap?: Record<string, string>;
  /** 长时间不操作时该角色自己演的小节目；整块缺省=不演。语义同 PlayerAvatarConfig.idle */
  idle?: PlayerIdleConfig;
  /**
   * 命名装扮：一次换装要改的东西（动画包 + 状态映射）在此登记一份，
   * 动作侧只填 `outfit` 名即可，不必每个调用点重抄整份 stateMap。
   */
  outfits?: Record<string, CharacterOutfitDef>;
}

/**
 * `resolveAvatar` 的输出：某角色在某装扮下**实际生效**的化身。
 * 消费侧（挂载精灵 / 解析立绘 / 判断动词可用）一律读这个，不要各自去合并 outfit。
 */
export interface ResolvedAvatar {
  /**
   * 实际要加载的 anim.json URL。
   * **可能为 undefined**（角色漏填 animFile 且装扮也没给）——刻意不兜底到玩家默认包，
   * 否则漏填会静默套上主角的动画与立绘。构建期由 validator 拦，运行时消费侧告警。
   */
  animFile?: string;
  /** 实际生效的逻辑状态映射；undefined = 全部逻辑名与片段名同名 */
  stateMap?: Record<string, string>;
  /**
   * 实际生效的立绘集；**undefined = 由消费侧按动画包目录名推导**（不是"没有立绘"）。
   * 装扮换了动画包又没显式指定 slug 时必然为 undefined——立绘要跟着装扮走。
   */
  portraitSlug?: string;
  /** 待机节目单（跟角色走，不随装扮变） */
  idle?: PlayerIdleConfig;
}

/** 一套命名装扮：换上它 = 换动画包 + 换状态映射。 */
export interface CharacterOutfitDef {
  /** anim.json 的 URL；缺省=沿用角色本体的 animFile（只换 stateMap 的纯状态换装） */
  animFile?: string;
  /** 该装扮下的逻辑状态映射；语义同 CharacterAvatarConfig.stateMap */
  stateMap?: Record<string, string>;
  /** 该装扮的对话立绘集；缺省=沿用角色本体的 portraitSlug */
  portraitSlug?: string;
}

export interface CharacterRegistryFile {
  characters: CharacterDef[];
}

export interface NpcDef {
  id: string;
  /**
   * 引用 character_registry.json 的角色 id：名字/动画包/头像从该角色继承，
   * 本 NpcDef 就地写的同名字段覆盖之。缺省=独立 NPC（名字/动画等全部就地定义，旧数据不变）。
   */
  characterId?: string;
  name: string;
  x: number;
  y: number;
  /**
   * 位面归属（见 `systems/plane/types.ts` PlaneDef）：缺省 = 实体存在于**所有**位面；
   * 有值时仅当激活位面包含于该列表时实体可见（由 PlaneReconciler 经派生基底通道驱动）。
   */
  planes?: string[];
  /**
   * 时段归属（与 `planes` 同构的白名单）：缺省 = 所有时段都在（旧数据零影响）；
   * 有值时仅当前时段被列出才存在。用于「整条街的群演白天在、夜里没」这类批量表达——
   * 有作息的具名角色请用 NPC 日程表（npc_schedules.json），两者正交。
   * 值须是 `game_config.dayNight.phases` 里的 id。
   */
  phases?: string[];
  /** 关联一个或多个过场；有值时默认作为仅过场实体，除非 cutsceneOnly 显式为 false。 */
  cutsceneIds?: string[];
  /**
   * 有过场关联时默认 true：普通场景不生成，仅在关联过场中从场景文件初始化。
   * 显式 false 时是普通场景/过场共享实体，普通场景从 sceneMemory 初始化。
   */
  cutsceneOnly?: boolean;
  /**
   * 图对话：资源 id（不含路径），对应 `public/assets/dialogues/graphs/<id>.json`。
   * 未配置时按 E 不会进入对话。
   */
  dialogueGraphId?: string;
  /** 覆盖图 JSON 的 `entry`；缺省用图内 `entry` */
  dialogueGraphEntry?: string;
  /**
   * 进入该 NPC 对话时镜头渐变缩放到该值（与场景 `camera.zoom` 同语义；zoom 越大越“近”）。
   * 未配置时候选为 1；实际目标为 max(当前相机 zoom, 候选值, 场景 camera.zoom 基线)，避免广角开场拉不近、也不宜把已很近的场景再拉远。
   * 对话结束（含异常中断）时由系统渐变恢复为当前场景配置的 zoom。
   */
  dialogueCameraZoom?: number;
  /**
   * @deprecated 站立/表情动画请用图对话 `runActions` 的 playNpcAnimation；保留字段仅为兼容旧场景数据。
   */
  dialogueStandAnimState?: string;
  interactionRange: number;
  /** 组内 AND；可为 flag / quest / scenarioLine 等 `ConditionExpr`，与 HotspotDef.conditions 一致 */
  conditions?: ConditionExpr[];
  /**
   * 为 true 且配置了非空 conditions 时：条件不满足则 NPC 不渲染、不参与交互（与过场绑定、sceneMemory.enabled 叠加）。
   */
  conditionHidesEntity?: boolean;
  /** 动画包清单路径，如 `/resources/runtime/animation/<包目录名>/anim.json`；图集由清单内 spritesheet 相对该目录解析 */
  animFile?: string;
  /**
   * 对话头像立绘集目录名（`resources/runtime/images/dialogue_portraits/<slug>/`）。
   * 图对话行 portrait 省略 slug（「跟随说话 NPC」）时按此解析；未配置则该行不显头像。
   */
  portraitSlug?: string;
  /** 进入场景时播放的状态名；缺省时优先 idle，否则取 states 中第一个 */
  initialAnimState?: string;
  /** 初始状态的播放参数（调速/倒放/定格/起播帧错相）；语义见 NpcInitialAnimPlayback */
  initialAnimPlayback?: NpcInitialAnimPlayback;
  /**
   * 进入场景时的左右朝向（脚底为锚点，镜像 container.scale.x）。
   * 缺省为 right。对话/巡逻中仍可由逻辑改写朝向。
   */
  initialFacing?: 'left' | 'right';
  patrol?: PatrolDef;
  /**
   * 可选：相对场景 JSON 中 NPC 锚点 (x,y) 的局部多边形；与 `collisionPolygonLocal` 配合。
   * 与 Hotspot 一致；未写 `collisionPolygonLocal` 时按世界坐标兼容旧数据。
   * 运行时用当前 NPC 世界坐标作锚点（含巡逻中位移）。
   */
  collisionPolygon?: { x: number; y: number }[];
  /** 为 true 时 `collisionPolygon` 为相对 (x,y) 的局部坐标；缺省视为旧版世界坐标 */
  collisionPolygonLocal?: boolean;
  /** 投射阴影 + 接触 AO 开关（合并）；缺省视为 true。false 时该 NPC 不投影也无接触 AO。 */
  castShadow?: boolean;
  /**
   * 为 true 时该 NPC 不附加逐 entity 光照 / 深度遮挡滤镜，渲染原始贴图像素（仍受全局场景色彩滤镜影响）。
   * 用于「从背景抠出、贴回原位做循环动画」的装饰实体：这类贴图本就取自已烤好光照的背景，
   * 再叠一层逐 entity 光照会与背景色调不符、露出方框接缝。缺省视为 false（正常受光）。
   */
  renderRaw?: boolean;
  /**
   * 强制叠放档位（与 `HotspotDisplayImage.spriteSort` 同语义、同实现）：`back` 恒在众人之后、
   * `front` 恒在众人之前；缺省=与众人一样只按脚底 Y 排序。
   * 给「贴背景的群像/前景路人」这类摆位用——它们与背景的前后关系是画出来的，按 Y 排会穿帮。
   */
  spriteSort?: EntitySpriteSort;
  /**
   * 实例级等比缩放（quad 级真变换，绕脚底锚点）：渲染/碰撞多边形/交互半径/
   * 阴影尺寸/气泡/深度接地线随动；缺省 1。可经 setEntityField 运行时改并入档。
   */
  scale?: number;
  /** 实例级旋转（度，绕脚底锚点）；quad 级真变换同上；缺省 0。 */
  rotation?: number;
  /**
   * 深度遮挡半透明混合系数 [0,1]：被场景深度遮挡的精灵像素 alpha 乘此系数
   * （0=硬裁切完全隐藏，1=完全不裁）。缺省时用场景默认（SceneDepthSystem 当前 0.28）。
   * 显式给值的实体不再随 F2 全局遮挡混合滑块变化。
   */
  occlusionBlendFactor?: number;
  /**
   * 参与场景透视缩放（SceneData.perspectiveScale）：NPC 缺省 **true**（站位/巡逻都在
   * 地面，脚底 y 即深度）；贴墙/悬空装饰实体可显式关闭。
   */
  perspectiveScaleEnabled?: boolean;
  /** 场景内实体分组 id；旧数据的纯字符串标签继续兼容。 */
  group?: string;
}

export type CutsceneBindableEntityDef = Pick<NpcDef | HotspotDef, 'cutsceneIds' | 'cutsceneOnly'>;

export function entityCutsceneIds(def: CutsceneBindableEntityDef): string[] {
  const out: string[] = [];
  const add = (raw: unknown) => {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (id && !out.includes(id)) out.push(id);
  };
  if (Array.isArray(def.cutsceneIds)) {
    for (const id of def.cutsceneIds) add(id);
  }
  return out;
}

export function isEntityBoundToCutscene(def: CutsceneBindableEntityDef, activeId: string | null | undefined): boolean {
  const id = activeId?.trim();
  return !!id && entityCutsceneIds(def).includes(id);
}

export function hasCutsceneBinding(def: CutsceneBindableEntityDef): boolean {
  return entityCutsceneIds(def).length > 0;
}

export function isCutsceneOnlyEntity(def: CutsceneBindableEntityDef): boolean {
  return hasCutsceneBinding(def) && def.cutsceneOnly !== false;
}

export function isSharedCutsceneEntity(def: CutsceneBindableEntityDef): boolean {
  return hasCutsceneBinding(def) && def.cutsceneOnly === false;
}

// ============================================================
// 场景运行时状态（用于场景记忆）
// ============================================================

/** 仅由 `persistNpc*` Action 写入 sceneMemory；再次进入场景时套在 NpcDef 之上 */
export interface NpcPersistentSnapshot {
  /** true 时本场景不再为该 NPC 启动巡逻协程 */
  patrolDisabled?: boolean;
  /** false 时持久隐藏（与 setEntityEnabled 一致） */
  enabled?: boolean;
  /** 持久世界坐标 */
  x?: number;
  y?: number;
  /** 进入场景并 loadSprite 后播放的状态名 */
  animState?: string;
}

export type SceneEntityRuntimeValue = string | number | boolean | HotspotDisplayImage | null;

export interface NpcRuntimeOverride {
  patrolDisabled?: boolean;
  enabled?: boolean;
  x?: number;
  y?: number;
  animFile?: string | null;
  initialAnimState?: string | null;
  animState?: string | null;
  /** 实例 transform 运行时覆盖（setEntityField 通道；null=清除回落 def/缺省） */
  scale?: number | null;
  rotation?: number | null;
}

export interface HotspotRuntimeOverride {
  enabled?: boolean;
  x?: number;
  y?: number;
  displayImage?: HotspotDisplayImage | null;
  /** 实例 transform 运行时覆盖（setEntityField 通道；null=清除回落 def/缺省） */
  scale?: number | null;
  rotation?: number | null;
}

/** 普通 Zone 的可存档覆盖（depth_floor 不参与） */
export interface ZoneRuntimeOverride {
  enabled?: boolean;
}

export interface SceneEntityRuntimeOverrides {
  npcs: Record<string, NpcRuntimeOverride>;
  hotspots: Record<string, HotspotRuntimeOverride>;
  /** standard zone：`enabled === false` 时不注册到 ZoneSystem；depth_floor 始终注册 */
  zones: Record<string, ZoneRuntimeOverride>;
}

export interface SceneRuntimeState {
  inspectedHotspots: Set<string>;
  pickedUpHotspots: Set<string>;
}

export interface BackgroundLayer {
  image: string;
  x?: number;
  y?: number;
  z?: number;
}

export interface Position {
  x: number;
  y: number;
}

// ============================================================
// 任务数据
// ============================================================

export interface QuestGroupDef {
  id: string;
  name: string;
  type: 'main' | 'side';
  parentGroup?: string;
}

export interface QuestEdge {
  questId: string;
  conditions: ConditionExpr[];
  bypassPreconditions?: boolean;
}

/** 引导通道种类（玩法文档 D8）。新增通道 = 加一个 kind + 一个渲染实现，配置面不动。 */
export type QuestGuidanceKind = 'mapMarker' | 'worldMarker' | 'sceneHint';

/**
 * 一条引导。**通道之间互不排斥**：同一个目标可以同时挂地图标记 + 场景浮标 + 场景提示，
 * 由策划在任务编辑器里逐条配，运行时全部并行生效（只对「当前任务」生效，见 D6）。
 *
 * ⚠ `worldMarker` 的实体引用一律用**场景限定三件套**（`sceneId` + `entityKind` + `entityId`）：
 * 这与 `setEntityField` 等动作的限定引用同形，重构引擎（`DATA_REF_PARAMS`）据此跟随
 * 实体改名/迁场景。写成裸 id 会在实体改名后静默指空，这条踩过。
 */
export interface QuestGuidanceDef {
  kind: QuestGuidanceKind;
  /** 目标所在场景 id（三条通道都必填：地图标记标它、浮标只在同场景显示、提示只在进入它时出） */
  sceneId: string;
  /** worldMarker：指向实体时填（与 x/y 二选一，实体优先） */
  entityKind?: 'npc' | 'hotspot' | 'zone';
  entityId?: string;
  /** worldMarker：指向固定坐标时填（实体没配才用） */
  x?: number;
  y?: number;
  /** sceneHint 必填：进入该场景时 HUD 出的一行提示 */
  text?: string;
  /** 地图标记 / 浮标上的短标签；缺省用目标文字 */
  label?: string;
  /** worldMarker：目标不在视野内时是否贴屏幕边缘画指向箭头（缺省 true） */
  offscreenArrow?: boolean;
  /** worldMarker：是否在浮标下显示到目标的距离（缺省 false） */
  showDistance?: boolean;
}

/**
 * 任务目标（玩法文档 D7）。勾选状态**从条件派生、不入档**——与「任务清单是叙事状态的镜像」
 * 同一口径（见 agent_docs `narrative-signal-spine` 第 5 层）。
 */
export interface QuestObjectiveDef {
  id: string;
  text: string;
  /** 完成条件（与任务完成条件同一套表达式）；留空 = 不会自动勾掉，只随任务整体完成 */
  completeWhen?: ConditionExpr[];
  /** 本目标专属引导；不配则回落到任务级 `guidance` */
  guidance?: QuestGuidanceDef[];
  /** 可选目标：不参与「当前目标」选取，也不阻塞后面的目标 */
  optional?: boolean;
}

/** 接取/设为当前任务时的提示档位（玩法文档 D9）。缺省按类型派生：main=banner，其余=toast。 */
export type QuestAnnounceStyle = 'none' | 'toast' | 'banner';

export interface QuestDef {
  id: string;
  group: string;
  /** repeatable：可重复活计的面板镜像，硬绑一张活计图（runArchetype），
   *  不走 preconditions/completionConditions/rewards/nextQuests 状态机——
   *  条目/完成/归档全部由活计生命周期（start/settle/discard）派生。 */
  type: 'main' | 'side' | 'repeatable';
  sideType?: 'errand' | 'inquiry' | 'investigation' | 'commission';
  /** type='repeatable' 必填：绑定的活计图 id（声明了 run 的叙事图），1:1 */
  runArchetype?: string;
  title: string;
  description: string;
  preconditions: ConditionExpr[];
  completionConditions: ConditionExpr[];
  /** 任务变为 Active（接取）时执行，语义与 rewards 相同，仅触发时机不同 */
  acceptActions?: ActionDef[];
  rewards: ActionDef[];
  nextQuests?: QuestEdge[];
  /** @deprecated use nextQuests */
  nextQuestId?: string;
  /** 目标清单（D7）；不配 = 面板只显示描述，与旧行为一致 */
  objectives?: QuestObjectiveDef[];
  /** 任务级引导（D8）：当前目标没配自己的 guidance 时用这份 */
  guidance?: QuestGuidanceDef[];
  /** 接取提示档位（D9）；不配按类型派生 */
  announce?: QuestAnnounceStyle;
  /**
   * 接取时是否抢占「当前任务」槽（D6/D9）。三态：
   * - 不配：槽空才自动占位（缺省，也是活计一直以来的语义）
   * - `true`：接取即抢过来
   * - `false`：从不自动占位（连空槽也不占，玩家/动作显式设才当前）
   */
  autoFocus?: boolean;
}

export enum QuestStatus {
  Inactive = 0,
  Active = 1,
  Completed = 2,
}

// ============================================================
// 规矩数据
// ============================================================

export type RuleLayerKey = 'xiang' | 'li' | 'shu';

export type RuleVerified = 'unverified' | 'effective' | 'questionable';

export interface RuleLayerDef {
  text: string;
  lockedHint?: string;
  /** 该层的验证状态；未填时默认 unverified */
  verified?: RuleVerified;
}

export interface RuleDef {
  id: string;
  name: string;
  incompleteName?: string;
  category: 'ward' | 'taboo' | 'jargon' | 'streetwise';
  /** 象 / 理 / 术；至少一层须有内容（由数据与编辑器校验保证） */
  layers: Partial<Record<RuleLayerKey, RuleLayerDef>>;
  /** @deprecated 规矩级验证状态已迁移到各层 RuleLayerDef.verified；仍可读用于旧存档兼容 */
  verified?: RuleVerified;
}

export interface RuleFragmentDef {
  id: string;
  text: string;
  ruleId: string;
  layer: RuleLayerKey;
  source: string;
}

// ============================================================
// 物件数据
// ============================================================

export interface ItemDef {
  id: string;
  name: string;
  type: 'consumable' | 'key';
  /**
   * 背包格子图标。走 `mediaUrlFromShortPath` 解析：既接受
   * `/resources/runtime/images/icons/x.png` 完整媒体 URL（编辑器 Browse 写出的形态），
   * 也接受 `images/icons/x.png` 这类短名。**留空是合法的**——运行时退回物品名文字显示。
   */
  icon?: string;
  description: string;
  dynamicDescriptions?: { conditions: ConditionExpr[]; text: string }[];
  buyPrice?: number;
  maxStack: number;
}

// ============================================================
// 遭遇数据
// ============================================================

export interface EncounterDef {
  id: string;
  narrative: string;
  options: EncounterOptionDef[];
}

export interface EncounterOptionDef {
  text: string;
  type: 'general' | 'rule' | 'special';
  conditions: ConditionExpr[];
  requiredRuleId?: string;
  /** 已填时：要求所列层均已解锁（读 FlagStore `rule_<id>_<layer>_done`）；未填时仍要求完整 `rule_<id>_acquired` */
  requiredRuleLayers?: RuleLayerKey[];
  consumeItems?: { id: string; count: number }[];
  resultActions: ActionDef[];
  resultText?: string;
}

// ============================================================
// 热区扩展：遭遇触发
// ============================================================

export interface EncounterTriggerData {
  encounterId: string;
}

// ============================================================
// 动画数据
// ============================================================

/** 图集中单个槽位（与 cols×rows 网格中一格对齐）的像素尺寸与内容包围盒 */
export interface AtlasFrameBoxDef {
  /** 图集格宽（像素），通常全表一致 */
  width: number;
  /** 图集格高（像素） */
  height: number;
  /** 精灵可见内容宽（alpha 裁切后，不含格内对称留白） */
  contentWidth: number;
  /** 精灵可见内容高 */
  contentHeight: number;
}

export interface AnimationSetDef {
  spritesheet: string;
  /**
   * `spritesheet` 相对 anim.json 解析后的完整 URL（仅运行时装配，不入 JSON）。
   * 供离线法线图集按 `<图集名>.normal.png` 约定寻址（见 rendering/spriteNormalAtlas）。
   */
  resolvedSheetUrl?: string;
  cols: number;
  rows: number;
  /** 单格像素尺寸；与 texture.width/cols、texture.height/rows 一致时可省略 */
  cellWidth?: number;
  cellHeight?: number;
  /**
   * 按图集线性索引 0…排列的帧框目录，长度等于本图集实际占用的槽位数。
   * `states[*].frames` 中的每个数为指向本数组的下标（与 SpriteEntity 中 col=idx%cols 一致）。
   */
  atlasFrames?: AtlasFrameBoxDef[];
  /** 世界单位：精灵在世界中的宽度（JSON 可与 worldHeight 二选一，由加载时归一化） */
  worldWidth: number;
  /** 世界单位：精灵在世界中的高度（JSON 可与 worldWidth 二选一） */
  worldHeight: number;
  states: Record<string, AnimationStateDef>;
}

/**
 * 一个挂点在**某个图集槽位**上的位姿（人工逐帧标注，存 sockets.json sidecar）。
 *
 * 坐标是**格内归一化**：`x` 0=格左边、1=格右边；`y` 0=格顶边、1=格底边（＝脚线）。
 * 与 `states[*].bubbleAnchor` 同一套归一化口径，运行时按 worldWidth/worldHeight
 * 与透视系数换算成容器局部坐标。
 */
export interface SocketFramePose {
  x: number;
  y: number;
  /** 角度（度，顺时针为正，屏幕坐标系）；角色朝左时运行时取反 */
  angle?: number;
  /** true = 挂件画在角色**身前**；缺省 false = 身后 */
  front?: boolean;
  /**
   * 挂点驱动的帧号（第二档）：挂件自己是一张小序列图时，用这个数选它的第几帧。
   * **不引入第二个时钟**——帧号完全由角色当前这一帧的标注给定。
   */
  frame?: number;
}

/** 一个命名挂点：逐图集槽位的位姿表（键为槽位索引的十进制字符串） */
export interface SocketDef {
  /** 人可读名（编辑器列表显示用）；缺省用挂点 id */
  label?: string;
  poses: Record<string, SocketFramePose>;
}

/**
 * 图集指纹：sockets.json 是按**图集槽位**索引的，重导出后槽位会漂移。
 * 加载时与 anim.json 对不上就把整份挂点判为失效（stale），拒绝使用并提示重标——
 * 盲用漂移后的槽位号会静默挂错位置，比不挂更坏。
 *
 * ⚠ 只是几何指纹：重抠图但网格没变（同 cols/rows/cell/槽位数）**检测不出来**。
 * 那种情况得靠人重看一遍，这是本机制已知且刻意的边界。
 */
export interface SocketAtlasFingerprint {
  cols: number;
  rows: number;
  /** atlasFrames 的长度（＝本图集实际占用的槽位数） */
  slotCount: number;
}

/** `<动画包目录>/sockets.json` 的整体形状 */
export interface SocketSetDef {
  schemaVersion: number;
  atlas: SocketAtlasFingerprint;
  sockets: Record<string, SocketDef>;
}

export interface AnimationStateDef {
  /**
   * 本状态按播放顺序引用的图集槽位索引（与 atlasFrames[i]、网格 col=idx%cols、row=floor(idx/cols) 一致）。
   */
  frames: number[];
  frameRate: number;
  loop: boolean;
  /**
   * 步速匹配基准（世界单位/秒）：该循环在此移动速度下步频与位移吻合（不滑步）。
   * 仅对移动类状态有意义；配置后移动驱动方按 实际速度/referenceSpeed 缩放播放倍率（夹取见
   * SpriteEntity.LOCOMOTION_RATE_*）。缺省 = 不参与匹配，恒 1 倍速播放。
   */
  referenceSpeed?: number;
  /**
   * 可选：本状态的**授权头顶锚**——格高归一化比例（0=脚点，1=格子顶边），气泡底边贴在此高度。
   *
   * 缺省 = 按每帧可见内容自动求（`SpriteEntity.getContentBoxLocal`），绝大多数状态用自动就对。
   * 什么时候需要手填：**内容顶 ≠ 头顶**的状态——举枪、扛尸、打伞，自动锚会挂到道具尖上。
   * 注意它是 per-state 常量，状态内每帧同一高度（不随内容起伏），这正是"钉死在头顶"的用意。
   */
  bubbleAnchor?: number;
}

/**
 * 动画播放参数（playNpcAnimation 等动作可选携带；全部缺省时播放行为与旧调用完全一致）。
 * holdFrame 与其余参数互斥生效：定格后不推进、不触发完成、thenState 不会发生。
 */
export interface AnimationPlaybackParams {
  /** 播放速度倍率（>0，乘在状态 frameRate 上）；缺省 1 */
  speed?: number;
  /** true = 反向播放（末帧起步进向首帧；非循环片段在首帧完成） */
  reverse?: boolean;
  /** 循环覆盖：显式 true/false 覆盖状态定义的 loop 标志；缺省（不写）沿用状态定义 */
  loop?: boolean;
  /**
   * 定格帧：切到该状态并停在此帧（0 基，越界按帧数取模），用于把片段任意一帧当 pose。
   * 动作层（playNpcAnimation）负值视为未设（编辑器以 -1 为「不定格」哨兵）。
   */
  holdFrame?: number;
  /** 非循环片段播完后自动切换到的状态（按默认参数播放）；循环片段忽略 */
  thenState?: string;
  /**
   * 起播帧（0 基，越界按帧数取模）：正/反向都从此帧开始步进；holdFrame 存在时忽略。
   * 主要供场景实体去同步（同包多拷贝错开相位）；playNpcAnimation 动作层暂不暴露此参数。
   */
  startFrame?: number;
}

/**
 * 场景实体（NpcDef）的初始播放参数：仅在进场起播 `initialAnimState` 那一次生效
 * （loadSprite；运行时换 animFile 重载精灵时同理）。之后任何 playAnimation（动作/
 * 巡逻/对话）按既有语义重置参数——这是「初始值」不是常驻覆盖。
 * 数值负值/非法视为未设（与动作层口径一致；编辑器以 -1 为「未设」哨兵且缺省不写键）。
 */
export type NpcInitialAnimPlayback = Pick<
  AnimationPlaybackParams,
  'speed' | 'reverse' | 'holdFrame' | 'startFrame'
>;

// ============================================================
// 对话记录
// ============================================================

export interface DialogueLogEntry {
  type: 'line' | 'choice';
  speaker?: string;
  text: string;
}

export interface DialogueLine {
  speaker: string;
  text: string;
  tags: string[];
  /** 可选头像（运行时随行下发给 DialogueUI）；不设则不显头像 */
  portrait?: DialoguePortraitRef;
  /** 说话人对应的世界实体（说话中「…」气泡定位 + 立绘分边用）；旁白/literal 无 */
  speakerEntity?: { kind: 'npc'; npcId: string } | { kind: 'player' };
  /**
   * 可选：本行立绘/名牌所在边（覆盖按 speakerEntity 的推导）。
   * 不设 = 主角在右、其余在左；见 utils/dialogueSpeakerSide。
   */
  speakerSide?: SpeakerSide;
  /** 本行「…」气泡的绝对头顶锚（可选覆盖）；不设则由实体按当前帧内容自算 */
  bubbleAnchorY?: number;
  /** 本行「…」气泡的缩放（可选覆盖）；不设则用全局 game_config.emoteBubbleScale */
  bubbleScale?: number;
  /** 本行所属对话是否压暗场景（startDialogueGraph 动作可选项 dimBackground；默认不压） */
  dim?: boolean;
}

/** `dialogue:start` / `dialogue:end` 事件来源：脚本台词（DialogueManager）或图对话（GraphDialogueManager） */
export type DialogueSessionSource = 'scripted' | 'graph';

/** `dialogue:start` 事件负载 */
export interface DialogueStartPayload {
  npcName: string;
  source: DialogueSessionSource;
  /** 仅 graph：本次开图的 graphId（路径名） */
  graphId?: string;
}

/**
 * `dialogue:end` 事件负载。R5/R6 根因收敛：`dialogue:end` 曾同时承担
 * 「脚本台词结束 / 图对话结束 / 状态恢复」三义，嵌套与链式场景必然误判。
 * 消费者据 `source` + 下列标记判断是否为**最外层**会话结束：
 * - `willContinue`（仅 graph）：deferred 链上还有图将立即接续，此 end 非最外层；
 * - `nestedInGraph`（仅 scripted）：本段脚本台词嵌套在仍活跃的图对话 runActions 内。
 */
export interface DialogueEndPayload {
  source: DialogueSessionSource;
  willContinue?: boolean;
  nestedInGraph?: boolean;
}

export interface DialogueChoice {
  index: number;
  text: string;
  tags: string[];
  enabled: boolean;
  ruleHintId?: string;
  /** 选项不可用时，点击/快捷键可显示的说明（规矩未收录、铜钱不足等） */
  disableHint?: string;
}

export interface ResolvedOption {
  index: number;
  text: string;
  type: 'general' | 'rule' | 'special';
  enabled: boolean;
  disableReason?: string;
  consumeItems?: { id: string; count: number }[];
  resultActions: EncounterOptionDef['resultActions'];
  resultText?: string;
}

// ============================================================
// 延迟事件
// ============================================================

export interface DelayedEvent {
  targetDay: number;
  actions: ActionDef[];
}

// ============================================================
// 演出数据
// ============================================================

/** showEmote 挂载点：父节点局部坐标下的气泡锚点（与 NPC/Player/Hotspot 展示图语义一致时可混用）。 */
export interface IEmoteBubbleAnchor {
  getDisplayObject(): unknown;
  /**
   * 表情气泡锚点：在 `getDisplayObject()` 局部坐标中，气泡**底边**应对齐的 Y（脚点在 0，向上为负）。
   * EmoteBubbleManager 会将气泡顶端置于 `anchorY - bubbleHeight`。
   */
  getEmoteBubbleAnchorLocalY(): number;
}

export interface ICutsceneActor extends IEmoteBubbleAnchor {
  readonly entityId: string;
  x: number;
  y: number;
  /**
   * moveAnimState 省略则移动段末不强制切 idle（见 Player/Npc 实现）。
   * faceTowardMovement 为 true 时沿路径每帧根据运动方向更新朝向（含斜向）；默认 false 保持旧语义。
   * arriveAnimState：段末收尾动画。undefined=缺省行为（Npc 回 rest、Player 带 moveAnimState 时回
   * idle）；字符串=播该状态；null=不切动画（折线中途点用，保证移动动画跨段连续不重置）。
   */
  moveTo(
    targetX: number,
    targetY: number,
    speed: number,
    moveAnimState?: string,
    faceTowardMovement?: boolean,
    arriveAnimState?: string | null,
  ): Promise<void>;
  /**
   * 沿抛物线弧线在 `durationMs` 内跳到 (targetX,targetY)：脚点(x/y)按进度线性位移驱动
   * 深度/排序/阴影，画面精灵按弧线抬起（峰高 `arcHeight` 世界 px，t=0.5 达峰），落地复位。
   * `jumpAnimState`：起跳动画只播一次，**帧游标按移动进度 0→1 插值**（非自走时钟）；缺省=不切动画。
   * `landAnimState`：落地后切到的状态——undefined=回各自 rest/idle；字符串=播该状态；null=不切动画。
   * `faceTowardMovement`：true=沿运动方向持续更新左右朝向；缺省只在起跳时朝向落点一次。
   */
  jumpTo(
    targetX: number,
    targetY: number,
    durationMs: number,
    arcHeight: number,
    jumpAnimState?: string,
    landAnimState?: string | null,
    faceTowardMovement?: boolean,
  ): Promise<void>;
  /** `playback` 缺省时行为与旧签名完全一致；参见 AnimationPlaybackParams。 */
  playAnimation(name: string, playback?: AnimationPlaybackParams): void;
  setFacing(dx: number, dy: number): void;
  setVisible(visible: boolean): void;
  cutsceneUpdate(dt: number): void;
}

/** 可选：`showEmote` / `showEmoteAndWait` / `showSpeechBubble` / `showSpeechBubbleAndWait` 气泡相对默认锚点的额外像素偏移（局部坐标）。 */
export type EmoteBubbleOffsetOpts = {
  anchorOffsetX?: number;
  anchorOffsetY?: number;
  /**
   * **绝对**头顶锚（实体局部 y，脚点为 0、向上为负）：给了就顶掉实体按当前帧内容自算的那一档，
   * `anchorOffsetY` 仍叠加其上。缺省（不给）= 继承实体自算，这是绝大多数情况。
   *
   * 为什么是绝对值而不是又一个偏移：编辑器要能"展开就显示当前生效的锚点值、直接微调"，
   * 偏移量的基准是随角色与动画状态变的活值，只给偏移等于让人对着 0 盲调。
   */
  anchorY?: number;
  /** 本次气泡的缩放覆盖；缺省 = 用全局 `game_config.emoteBubbleScale`。 */
  scale?: number;
};

/** 气泡缩放夹取范围：小于下限看不清，大于上限一句话糊住半个屏幕 */
export const EMOTE_BUBBLE_SCALE_MIN = 0.3;
export const EMOTE_BUBBLE_SCALE_MAX = 4;

/** 夹取气泡缩放；非法/缺省回落 `fallback`（全局默认恒为 1 起步）。 */
export function normalizeEmoteBubbleScale(raw: unknown, fallback = 1): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(EMOTE_BUBBLE_SCALE_MAX, Math.max(EMOTE_BUBBLE_SCALE_MIN, n));
}

/** 演出气泡提供者接口，用于 CutsceneManager 解耦对 EmoteBubbleManager 的直接依赖 */
export interface IEmoteBubbleProvider {
  /** owner：归属方标记（如 'cutscene'），供 cleanupByOwner 定向清理，不误伤世界侧气泡 */
  showAndWait(
    anchor: IEmoteBubbleAnchor,
    emote: string,
    durationMs?: number,
    opts?: EmoteBubbleOffsetOpts,
    owner?: string,
  ): Promise<void>;
  /**
   * 不按时长自动消失（与 showAndWait 不同）；返回的函数在适当时机调用以移除气泡，
   * 用于 showSubtitle.subtitleEmote 等与另一条演出同生命周期。
   */
  showSticky(
    anchor: IEmoteBubbleAnchor,
    emote: string,
    opts?: EmoteBubbleOffsetOpts,
    owner?: string,
  ): () => void;
  /** 只清指定归属方（show/showSticky 传入的 owner）的气泡；过场收尾不得误杀世界侧气泡 */
  cleanupByOwner(owner: string): void;
  cleanup(): void;
}

// ------------------------------------------------------------
// Cutscene schema
// ------------------------------------------------------------

/**
 * 步骤级「禁用」标记（三种 kind 通用）——`true` = 数据保留但**运行时整步跳过**，
 * 等于把这一步临时注释掉（编辑器可一键切换，不必删了再重写）。
 * 缺省 / `false` = 正常播放；`parallel` 上写 `disabled` 则整组连同子轨全跳。
 * 语义只在**播放**层：预热图片、跳过终姿计算等一并按「不存在」处理。
 */
export interface CutsceneStepDisableFlag {
  disabled?: boolean;
}

/**
 * Action 步骤——通过 ActionExecutor.executeAwait 执行。
 * Cutscene 中仅允许无副作用的 Action 子集（白名单）。
 */
export interface ActionStep extends CutsceneStepDisableFlag {
  kind: 'action';
  type: string;
  params: Record<string, unknown>;
}

/**
 * Present 步骤——CutsceneManager / CutsceneRenderer 直接处理的演出指令。
 * 如 fadeToBlack / showTitle / showDialogue / showImg / cameraMove 等。
 * `showSubtitle` 可选用 `subtitleBand`（movieTop|movieBottom）与 `subtitleAlign`（left|center|right）相对当前 movie bar，
 * 二者齐备时优先于 `position`；否则沿用 `position`（top/center/bottom 或 0–1 比例）。
 * 另可选用 `subtitleEmote`：`{ target, emote, duration?, anchorOffsetX?, anchorOffsetY? }`（target/emote/偏移解析同 showEmoteAndWait / showSpeechBubbleAndWait），
 * `target`+`emote` 均非空时在字幕展示期间显示头顶表情气泡；**气泡随字幕存在至玩家点击关闭字幕**（`duration` 仅作数据兼容，不参与结束时机）。
 * 另可选用 `subtitleVoice`：`"sfx_id"` 或 `{ id: "sfx_id", volume?: 0..1 }`，id 来自 `audio_config.sfx`；
 * 声音随字幕存在，玩家点击推进或跳过过场时会立即停止并释放该条字幕的播放实例。
 * 另可选用 `subtitleAutoAdvance`：`"voice"`=配音**自然播完**后自动推进（配音缺失 / 加载失败 / 手动停止
 * 不触发，退化为等待点击）；正数=展示该毫秒数后自动推进。两种模式下玩家点击仍可提前推进；缺省=等待点击。
 * 单独 Action `showEmoteAndWait` / `showSpeechBubbleAndWait` 仍完全由 `duration` 控制消失与 await。
 * `showImg` 另可选用 `kenBurns`（见 CutsceneKenBurns）：全屏插画缓推缓移，不阻塞后续步骤；
 * 另可选用 `zIndex`（数值，越大越靠前，缺省 0）：多层视差合成时决定叠层顺序，电影黑边恒 10000 之下。
 * `showImg` 的 `id` 可选：写了 → 手动管理（hideImg / 同 id 替换）；不写 → 挂到匿名镜头位
 * （CUTSCENE_ANON_SHOT_ID），被下一个 parallaxScene / 匿名 showImg 自动顶掉，过场结束兜底销毁。
 * `animLayer`：把 fx_build 网格图集（anim.json + atlas）当一层【循环动画】叠层，用于飘雾/余烬/尘埃/辉光丰富画面。
 * 字段：`animFile`（anim.json 路径）、`id`（句柄，与 hideImg 共用）、可选 `state`（缺省 idle）、`xPercent`/`yPercent`/`widthPercent`
 * （给 widthPercent 走百分比定位，否则 cover 铺满）、`alpha`、`zIndex`。fire-and-forget，不阻塞后续步骤。
 * `parallaxScene`：播放一个多层多关键帧 parallax 场景（见 ParallaxSceneDef）。字段：`id`（从 parallax_scenes.json 检索）
 * 或内联 `scene`；可选 `handle`：写了 → 手动管理（hideImg(handle) / 同 handle 换场景）；不写 → 匿名镜头位
 * 自动托管（同 showImg 缺省 id 语义）。fire-and-forget，不阻塞后续步骤。
 * `cameraMove` / `cameraZoom` 可选 `easing`（linear|easeIn|easeOut|easeInOut，cubic 家族）；
 * 缺省沿用历史默认曲线（move=ease-in-out cubic，zoom=ease-in-out quad）。
 */
export interface PresentStep extends CutsceneStepDisableFlag {
  kind: 'present';
  type: string;
  [key: string]: unknown;
}

/**
 * showImg 的 Ken Burns 缓推缓移参数——图片显示后立即开始匀速漂移，
 * fire-and-forget（不阻塞步骤推进），到 durationMs 停在终点；hideImg / 同 id 换图 / 跳过即停。
 * - fromScale/toScale：在「cover 铺满」基础上的额外缩放倍数，运行时下夹到 1（保证始终盖满屏幕）；
 * - fromX/fromY/toX/toY：图片中心相对屏幕中心的偏移，单位为屏幕宽/高的百分比（常用 -5..5），
 *   每帧按当前缩放余量夹紧，永不露出底层；
 * - durationMs：漂移时长，缺省 12000。
 */
export interface CutsceneKenBurns {
  fromScale?: number;
  toScale?: number;
  fromX?: number;
  fromY?: number;
  toX?: number;
  toY?: number;
  durationMs?: number;
}

/**
 * Parallax 场景（present:parallaxScene）——多层图片各自独立按多关键帧运动，做视差/演出。
 * 坐标系：授权画布 `widthRef × heightRef` 像素；运行时把整块画布按 cover 映射到屏幕
 * （k = max(sw/widthRef, sh/heightRef)，居中，多余裁掉），保证与编辑器所见一致。
 * 数据存 `assets/data/parallax_scenes.json`（数组，按 id 检索），或 present 步内联 `scene`。
 */
export interface ParallaxKeyframe {
  /** 距场景开始的毫秒数（同层内按此升序） */
  atMs: number;
  /** 图层中心 X（授权画布 px） */
  x: number;
  /** 图层中心 Y（授权画布 px） */
  y: number;
  /** 相对图片原始像素尺寸的缩放，缺省 1 */
  scale?: number;
  /** 旋转角度（度，顺时针），缺省 0 */
  rotation?: number;
  /** 不透明度 0..1，缺省 1 */
  alpha?: number;
}

export interface ParallaxLayerDef {
  /** 图层句柄（场景内唯一） */
  id: string;
  /** 图片资源路径（可为透明 PNG 抠像层） */
  image: string;
  /** 叠层顺序，越大越靠前，缺省 0 */
  zIndex?: number;
  /** ≥1 个关键帧（按 atMs 升序）；仅 1 帧 = 静止 */
  keyframes: ParallaxKeyframe[];
  /** 关键帧间插值缓动，缺省 linear */
  easing?: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';
  /** 是否循环关键帧时间轴，缺省 false（停在末帧） */
  loop?: boolean;
  /** 编辑器「推摄像机」元数据：该层视差强度。运行时忽略（只播 keyframes）。 */
  depth?: number;
  /**
   * 编辑器「推摄像机」元数据：该层「自身运动」原始关键帧。相机开启时 keyframes 是
   * 「相机 × 自身运动」烘焙结果（运行时播这个），sourceKeyframes 保留自身运动供编辑器再编辑。
   * **运行时忽略。**
   */
  sourceKeyframes?: ParallaxKeyframe[];
  /** 编辑器「推摄像机」元数据：自身运动的缓动。运行时忽略。 */
  sourceEasing?: 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';
}

/** 「推摄像机」编辑器专用元数据：镜头运动关键帧。运行时完全忽略——保存时已烘焙进各层 keyframes。 */
export interface ParallaxCameraKey {
  atMs: number;
  panX: number;
  panY: number;
  zoom: number;
  roll: number;
}

export interface ParallaxSceneDef {
  id: string;
  /** 授权画布宽（px），如 1672 */
  widthRef: number;
  /** 授权画布高（px），如 941 */
  heightRef: number;
  layers: ParallaxLayerDef[];
  /**
   * 编辑器「推摄像机」元数据（可选）：配置期的虚拟镜头运动，保存时按每层 depth 烘焙成
   * 各层 keyframes。**运行时完全忽略此字段**，只播 layers[].keyframes。仅供 parallax
   * 编辑器把镜头读回来再编辑。
   */
  camera?: {
    enabled: boolean;
    keyframes: ParallaxCameraKey[];
  };
}

/**
 * 并行组——组内所有 step 同时启动，全部完成后继续主干。
 */
export interface ParallelGroup extends CutsceneStepDisableFlag {
  kind: 'parallel';
  tracks: CutsceneStep[];
}

export type CutsceneStep = ActionStep | PresentStep | ParallelGroup;

export interface NewCutsceneDef {
  id: string;
  steps: CutsceneStep[];
  targetScene?: string;
  targetSpawnPoint?: string;
  targetX?: number;
  targetY?: number;
  /** 默认 true——演出结束后恢复快照（场景、玩家位置、镜头）。 */
  restoreState?: boolean;
}

/**
 * Cutscene Timeline 内允许的 action.type（与安全、策划审阅相关）。
 * 含瞬时演出类动作与明示的存档类 persist*（写入 sceneMemory，随存档）。
 * 唯一清单：src/data/cutscene_action_allowlist.json（Python 工具同读该文件）。
 */
export const CUTSCENE_ACTION_WHITELIST: ReadonlySet<string> = new Set(cutsceneActionAllowlist);

/**
 * 过场匿名镜头位句柄：`showImg` 不写 `id`、`parallaxScene` 不写 `handle` 时共用此内部槽位，
 * 由系统自动托管——任何新 `parallaxScene`（含具名）或新的匿名 `showImg` 挂载时自动顶掉，
 * 过场 cleanup 兜底销毁；显式写了 id/handle 的图层则完全手动管理（hideImg / 同名替换）。
 * `hideImg` 不写 `id` 时同样指向此槽位（可手动清匿名镜头）。
 */
export const CUTSCENE_ANON_SHOT_ID = '__anonShot';

// ============================================================
// 存档数据
// ============================================================

export interface SaveSlotMeta {
  slot: number;
  timestamp: number;
  sceneId: string;
  sceneName: string;
  dayNumber: number;
  playTimeMs: number;
}

// ============================================================
// 档案系统
// ============================================================

export interface CharacterEntry {
  id: string;
  name: string;
  title: string;
  impressions: { text: string; conditions: ConditionExpr[] }[];
  knownInfo: { text: string; conditions: ConditionExpr[] }[];
  /** 玩家第一次在档案中点开该人物时执行（仅一次，记入存档） */
  firstViewActions?: ActionDef[];
}

export interface LoreEntry {
  id: string;
  title: string;
  content: string;
  source: string;
  category: 'legend' | 'geography' | 'folklore' | 'affairs';
  unlockConditions: ConditionExpr[];
  /** 玩家第一次在档案中点开该条目时执行（仅一次） */
  firstViewActions?: ActionDef[];
}

/**
 * 怪话册词条。成就式搜集册，纯 flavor：只能被读、不能被用（不解锁能力、不作任何检定前置）。
 * 正文走考据体、note 负责把它砸掉——「系统越正经，内容越不成器」是这本册子的笑点引擎。
 */
export interface SlangEntry {
  id: string;
  /** 词条本身，如「锤子」 */
  title: string;
  /** 考据体释义（语源 / 市井用法 / 成渝分野） */
  content: string;
  /** 关二狗声口的实际用法示范 */
  example: string;
  /** 跟谁学的 */
  source: string;
  /** 末尾那句拆台备注（笑点落点，可空） */
  note?: string;
  category: string;
  unlockConditions: ConditionExpr[];
  /** 玩家第一次在档案中点开该条目时执行（仅一次） */
  firstViewActions?: ActionDef[];
}

/** 怪话册单个分类的展示视图：含未解锁灰槽与集齐状态（空槽是本册的驱动力，刻意不隐藏） */
export interface SlangCategoryView {
  key: string;
  name: string;
  total: number;
  collected: number;
  complete: boolean;
  /** 该分类集齐时显示的嘲讽评语（未集齐为空串） */
  completeText: string;
  entries: { entry: SlangEntry; unlocked: boolean }[];
}

/** 怪话册总进度 */
export interface SlangProgress {
  collected: number;
  total: number;
  allComplete: boolean;
  /** 全册集齐时显示的评语（未集齐为空串） */
  allCompleteText: string;
}

/**
 * 歪歌册条目。与怪话册同为「系统替文盲记账」的成就式搜集册，纯 flavor：只能被读、不能被用。
 * 收民间连锁调式歪童谣；内容口径（宁冷勿俗、注释不提历史人物）见玩法功能需求清单 K5 书六。
 */
export interface RhymeEntry {
  id: string;
  /** 标题，如「张打铁」 */
  title: string;
  /** 顺口溜完整原文，多行用 \n */
  content: string;
  /** 在哪听来的（采风口径） */
  source: string;
  /** 末尾那句拆台备注（可空） */
  note?: string;
  unlockConditions: ConditionExpr[];
  /** 玩家第一次在档案中点开该条目时执行（仅一次） */
  firstViewActions?: ActionDef[];
}

/** 歪歌册总进度（暂无分类，全册一个进度） */
export interface RhymeProgress {
  collected: number;
  total: number;
  allComplete: boolean;
  /** 全册集齐时显示的评语（未集齐为空串） */
  allCompleteText: string;
}

export interface DocumentEntry {
  id: string;
  name: string;
  content: string;
  annotation?: string;
  discoverConditions: ConditionExpr[];
  /** 玩家第一次在档案中点开该文档时执行（仅一次） */
  firstViewActions?: ActionDef[];
}

export interface BookDef {
  id: string;
  title: string;
  totalPages: number;
  pages: BookPage[];
}

/** 书籍某一页内可单独解锁的子条目（如《风物志》下的小记） */
export interface BookPageEntry {
  id: string;
  title: string;
  content: string;
  /**
   * 按语；可嵌入游戏 tag（运行时展开）：
   * `[tag:string:category:key]`、`[tag:flag:flagKey]`、`[tag:item:itemId]`
   */
  annotation?: string;
  illustration?: string;
  /** 满足时自动解锁；与 Action 写入的 archive_book_entry_<id> 等价 */
  discoverConditions?: ConditionExpr[];
  /** 已解锁且玩家第一次翻到包含该条目的书页时执行（仅一次） */
  firstViewActions?: ActionDef[];
}

export interface BookPage {
  pageNum: number;
  title?: string;
  content: string;
  illustration?: string;
  unlockConditions?: ConditionExpr[];
  entries?: BookPageEntry[];
  /** 玩家第一次翻到该页（且页已解锁）时执行（仅一次） */
  firstViewActions?: ActionDef[];
}

/** 成书左侧目录：章节与其下的 entry 子节点 */
export interface BookTocEntry {
  id: string;
  title: string;
  unlocked: boolean;
}

export interface BookTocChapter {
  pageNum: number;
  title?: string;
  unlocked: boolean;
  entries: BookTocEntry[];
}

/** 成书阅读器一屏：章节正文页，或某章下独立一篇（含按语） */
export type BookReaderSlice =
  | {
      kind: 'page';
      pageNum: number;
      title?: string;
      content: string;
      illustration?: string;
      unlocked: boolean;
    }
  | {
      kind: 'entry';
      pageNum: number;
      chapterTitle?: string;
      entryId: string;
      title: string;
      content: string;
      /** 已展开 [tag:…] 的按语纯文本 */
      annotation?: string;
      illustration?: string;
      unlocked: boolean;
    };

// ============================================================
// 商店数据
// ============================================================

export interface ShopDef {
  id: string;
  name: string;
  items: { itemId: string; price?: number }[];
}

// ============================================================
// 地图数据
// ============================================================

export interface MapNodeDef {
  sceneId: string;
  name: string;
  x: number;
  y: number;
  unlockConditions: ConditionExpr[];
  /** Hide this node from the player map without removing it from editor/dev scene lists. */
  runtimeVisible?: boolean;
  /** Editor/dev-only map node. Runtime map rendering skips it unless it is the current scene. */
  devOnly?: boolean;
  /** Locked runtime display policy. Defaults to hidden to avoid a screen full of "???". */
  lockedDisplay?: 'hidden' | 'hint' | 'secret';
  category?: string;
  importance?: number;
}

export interface MapConfigFile {
  backgroundImage?: string;
  nodes: MapNodeDef[];
}

// ============================================================
// 区域数据
// ============================================================

/**
 * 动作批的**来源上下文**：谁在放这批动作。按参数显式线程化（禁全局"当前 X"栈——
 * 见 agent_docs/runtime/mechanisms/zone-lifecycle-contracts.md；同帧交错的批会互相串味）。
 *
 * - `zoneId`：zone 触发批才有，规矩 offers 等按 zone 注册的动作依赖它。
 * - `ownerType`/`ownerId`：这批动作的**叙事归属实体**，与 wrapperGraph 的 owner 同命名空间
 *   （见 VALID_NARRATIVE_WRAPPER_OWNER_TYPES）。`startDialogueGraph` 未显式给 owner 时由它兜底，
 *   于是"热区动作里开的对话""zone 里开的对话""叙事图状态里开的对话"都能解出 owner，
 *   图里的 ownerState 节点才有得读。两者必须成对，缺一即视为无 owner。
 */
export interface ActionOriginContext {
  zoneId?: string;
  ownerType?: string;
  ownerId?: string;
}

/** @deprecated 历史名；zone 只是来源之一，新代码用 {@link ActionOriginContext}。 */
export type ZoneActionContext = ActionOriginContext;

/** standard：进出停留与规矩等；depth_floor：仅参与深度遮挡，脚底在区内时叠加 floorOffsetBoost */
export type ZoneKind = 'standard' | 'depth_floor';

/**
 * 区域气味：玩家进入该 zone 时自动让 SmellSystem 的 **zone 层**呈现此气味，离开自动撤回。
 * 仅声明数据，由 SmellSystem 监听 zone:enter/zone:exit 驱动（zone 层优先级低于 action 层）。
 * scent = smell_profiles.json 的 profile id；intensity 0–100（省略默认 60）；dir -1..1；flicker 波动。
 */
export interface ZoneSmellConfig {
  scent: string;
  intensity?: number;
  dir?: number;
  flicker?: boolean;
}

export interface ZoneDef {
  id: string;
  /** 场景内实体分组 id；旧数据的纯字符串标签继续兼容。 */
  group?: string;
  /**
   * 位面归属（见 `systems/plane/types.ts` PlaneDef）：缺省 = zone 存在于**所有**位面；
   * 有值时仅当激活位面包含于该列表时才注册进 ZoneSystem（切位面后由刷新入口重注册）。
   */
  planes?: string[];
  /**
   * 时段归属（与 `planes` 同构的白名单）：缺省 = 所有时段都在（旧数据零影响）；
   * 有值时仅当前时段被列出才存在。用于「整条街的群演白天在、夜里没」这类批量表达——
   * 有作息的具名角色请用 NPC 日程表（npc_schedules.json），两者正交。
   * 值须是 `game_config.dayNight.phases` 里的 id。
   */
  phases?: string[];
  /** 缺省为 standard（与未写字段的老数据兼容） */
  zoneKind?: ZoneKind;
  /**
   * zoneKind === 'depth_floor' 时使用：叠加到深度遮挡公式中 floor 项的偏移（与场景 depthConfig.floor_offset 同语义）。
   * 多区重叠时取 |floorOffsetBoost| 最大者（并列保留先出现的）。
   */
  floorOffsetBoost?: number;
  /** 世界坐标闭合多边形顶点（顺序连接，首尾不重复同一点），至少 3 个。 */
  polygon: Array<{ x: number; y: number }>;
  conditions?: ConditionExpr[];
  onEnter?: ActionDef[];
  /** 玩家在区域内时每帧执行的 Action（慎用非幂等 action）。 */
  onStay?: ActionDef[];
  onExit?: ActionDef[];
  /**
   * 玩家在本区内做某身体动词时执行（事件驱动，不受 onStay 的 0.25s 节流影响）。
   * 只有当动词没被目标级 `acts` 接住时才轮到本表（派发优先级：目标级 → 区域级 → 全局兜底）。
   */
  onPlayerAct?: ZoneActMap;
  /**
   * 玩家在本区内**按 E 才执行**（走进来什么都不发生，与 onEnter 相反）。
   * 有值即在 HUD 底部出提示条，提示文案取 {@link ZoneDef.interactLabel}。
   * 派发优先级同身体动词：目标级（hotspot / NPC 的 E）→ 区域级——被更近的可交互目标
   * 接住时本区既不出提示也不触发；位面禁交互（canInteractHotspots=false）时一并禁。
   */
  onInteract?: ActionDef[];
  /**
   * `onInteract` 提示条的文案，形如 `[E] 察看`（方括号里是键帽）。
   * 留空取 strings 的 `hud.zoneInteractHint` 默认值；仅在 `onInteract` 非空时有意义。
   */
  interactLabel?: string;
  /** 进入本区自动呈现的环境气味（zone 层；离开自动撤回；被 action 层 setSmell 压过）。 */
  smell?: ZoneSmellConfig;
}

export interface ZoneRuleSlot {
  ruleId: string;
  /** 未填时等价于完整掌握该规矩；已填时要求每层均已解锁才可用 */
  requiredLayers?: RuleLayerKey[];
  resultActions: ActionDef[];
  resultText?: string;
}

// ============================================================
// 全局游戏配置
// ============================================================

/** 玩家精灵：动画包与逻辑状态（idle/walk/run）到 anim.json 中 states 键的映射 */
export interface PlayerAvatarConfig {
  /** anim.json 的 URL，默认 /resources/runtime/animation/player_anim/anim.json */
  animManifest?: string;
  /**
   * 逻辑状态名 -> anim.json 里 states 的键。未写的键视为「与逻辑名同名」。
   * 移动三态固定使用 idle / walk / run；身体动词另用
   * crouch / crouchWalk / gaze / kick / jump / lie（见 PLAYER_VERB_LOGICAL_STATES）。
   * **某逻辑名在本装扮下解析不到实际片段 = 该动词在本装扮下自动禁用**
   *（如背尸包没有 kick，扛着尸体就踢不了；不需要额外开关）。
   */
  stateMap?: Record<string, string>;
  /**
   * 主角对话头像立绘集（与 NpcDef.portraitSlug 同语义）：头像跟随「当前生效的装扮配置」走。
   * 缺省按 animManifest 的动画包目录名同名推导（如 player_carry_corpse_anim）。
   * setPlayerAvatar 切装扮时可用同名参数携带新配置的立绘集。
   */
  portraitSlug?: string;
  /** 长时间不操作时主角自己演的小节目（待机动画 / 头顶自言自语）。整块缺省=不演。 */
  idle?: PlayerIdleConfig;
}

/** 主角待机节目单。间隔与内容全部在编辑器里配，代码不硬编码任何一条。 */
export interface PlayerIdleConfig {
  /** 总开关，缺省 true（但 entries 为空时本来就不会演） */
  enabled?: boolean;
  /** 停手多久后演第一个节目（ms），缺省 12000 */
  firstDelayMs?: number;
  /** 之后每隔多久再演一个（ms），缺省 18000 */
  repeatIntervalMs?: number;
  /** 间隔随机抖动上限（ms），缺省 6000——固定间隔会让待机看起来像机器 */
  jitterMs?: number;
  /**
   * 看门狗兜底（ms），缺省 6000。
   *
   * ⚠ **正常路径用不到它**：待机系统按片段真实时长算窗口（时长×1.5+1s），
   * 所以 8 秒的躺姿能演完、单帧姿势约 1.2 秒就收。只有"拿不到片段时长"这种
   * 不该发生的情况才回落到这个值——它是最后一道防线，不是动画时长上限。
   */
  animWatchdogMs?: number;
  entries?: PlayerIdleEntry[];
}

/** 一个待机节目：动画、气泡，或两者一起。两者都空的条目会被跳过。 */
export interface PlayerIdleEntry {
  /** 随机权重，缺省 1 */
  weight?: number;
  /**
   * anim.json 里 states 的键（**不是** stateMap 的逻辑名）——策划往角色动画包里补一个
   * 新状态，编辑器下拉现场扫 manifest 就能选到，不需要改代码。
   */
  animState?: string;
  /** 头顶自言自语；支持 `[tag:…]` 引用与 `[c:…]` 语义色板 */
  bubbleText?: string;
  /** 气泡停留（ms），缺省 2600 */
  bubbleDurationMs?: number;
  /** 本条目自身冷却（ms），缺省 0＝不限 */
  cooldownMs?: number;
  /** 演这条的前置条件；留空＝不限 */
  when?: ConditionExpr;
}

export interface GameConfig {
  initialScene: string;
  initialQuest: string;
  fallbackScene: string;
  /** 首次进入 initialScene 时播放的演出 ID，未配置则不播放 */
  initialCutscene?: string;
  /** 判断 initialCutscene 是否已播放的 FlagStore key，未配置则每次启动都播放 */
  initialCutsceneDoneFlag?: string;
  /** 开局写入 FlagStore，用于跳过开场演出时补齐地图等依赖的标记 */
  startupFlags?: Record<string, boolean | number>;
  /** 逻辑视口大小，所有游戏元素限制在此分辨率内，渲染结果缩放铺满窗口 */
  viewport?: { width: number; height: number };
  /** 游戏窗口大小（容器 CSS 尺寸），不影响视口逻辑分辨率 */
  windowSize?: { width: number; height: number };
  /**
   * 玩家化身：动画资源与状态映射（见 PlayerAvatarConfig）。
   *
   * **兼容读法**：`initialControlledCharacter` 缺省时，由本字段就地合成一条匿名角色
   * （id 固定 `LEGACY_PLAYER_CHARACTER_ID`），行为与多角色出现之前逐帧一致。
   * 迁移到角色注册表不是硬门槛，两种写法长期并存。
   */
  playerAvatar?: PlayerAvatarConfig;
  /**
   * 开局受控角色的 `characterId`（须在 character_registry.json 中且带 `avatar` 段）。
   * 缺省=走 `playerAvatar` 兼容路径。
   */
  initialControlledCharacter?: string;
  /**
   * 开局队伍成员（有序，characterId 列表）。缺省=只有受控者一人。
   * 不含 `initialControlledCharacter` 时受控者会被自动补进队首——队伍恒包含受控者。
   */
  initialParty?: string[];
  /** 玩家身体动词参数（蹲/踢/驻足注视/跳/躺）；整块缺省 = 全部按缺省开启 */
  playerActs?: PlayerActsConfig;
  /** 为 true 时按背景像素密度对实体展示做自动低通（纯渲染，默认开启；可在 game_config 设为 false 关闭） */
  entityPixelDensityMatch?: boolean;
  /**
   * 低通强度倍率，缺省 0.25。仅当 entityPixelDensityMatch 生效时读取；建议约 0.25～2。
   */
  entityPixelDensityMatchBlurScale?: number;
  /** 逐 entity 光照（阴影 + 色调融入 + AO）配置，关闭时完全走旧渲染管线 */
  entityLighting?: EntityLightingConfig;
  /**
   * 头顶气泡（说话「…」/ showEmote / showSpeechBubble）的**全局默认缩放**，缺省 1。
   * 字号、内边距、圆角、描边一起等比放大——不是把 20px 的字拉大，是按新字号重排，文字保持清晰。
   * 夹取范围见 `EMOTE_BUBBLE_SCALE_MIN/MAX`；单处可用 action/对话行的 `bubbleScale` 覆盖。
   */
  emoteBubbleScale?: number;
  /**
   * 血量/死亡系绳配置覆盖。字段与 `systems/HealthSystem.HealthConfig` 一致——
   * data 层不得反向 import systems（律1），此处为结构复制；两处字段改动必须同步。
   */
  health?: {
    maxHealth?: number;
    deathThreshold?: number;
    restoreFloor?: number;
    tetherCueId?: string;
    tetherSuppressFlagKey?: string;
  };
  /**
   * 玩家可见文本的**语义色板**：内容里写 `[c:<id>]…[/c]` 给某几个字上色。
   * 刻意只给具名档位、不给自由 hex——这套暖木/纸纹观感下，逐处填色号一定会走形，
   * 且改一次全局生效。缺省（不写此键）时用 `textStyle.DEFAULT_TEXT_PALETTE`。
   */
  textPalette?: TextPaletteEntry[];
  /** 日夜循环：时段分段点与开局时刻。缺省=用 DayManager 的内置四段（拂晓/白日/黄昏/入夜）。 */
  dayNight?: DayNightConfig;
}

// ============================================================
// 日夜循环（时刻 / 时段 / 过渡）
// ============================================================

/**
 * 推进时刻时的表现档，决定 **NPC 换班走不走离场演出**（见 `NpcScheduleSystem`）：
 * - `seamless`：画面不遮挡，NPC 必须走到出口才隐去（「无缝切换」主力，也是唯一会演离场的档）
 * - `timelapse` / `fade`：有画面遮挡（延时演出 / 黑场），遮挡期间直接重贴，不演离场
 * - `cut`：无过渡，仅调试与演出内部使用
 */
export type TimeTransition = 'seamless' | 'timelapse' | 'fade' | 'cut';

/** 一个时段的起点。`from` 为 `HH:MM`（24 小时制）；最后一段自动跨零点回绕到次日第一段。 */
export interface DayPhaseDef {
  id: string;
  from: string;
  /** 只给编辑器/调试看的中文名（如「入夜」）；不参与任何判定。 */
  label?: string;
}

export interface DayNightConfig {
  /** 时段分段点（至少 1 段）；缺省=DayManager 的内置四段。 */
  phases?: DayPhaseDef[];
  /** 开局与 `init()` 重置后的时刻（`HH:MM`）；缺省 `07:00`。 */
  startAt?: string;
  /** 过渡表现的缺省时长（毫秒），供渲染侧消费；缺省 1500。 */
  defaultTransitionMs?: number;
}

/** 场景级日夜开关。 */
export interface SceneDayNightConfig {
  /** true 时本场景参与日夜（NPC 受日程管、时段变化触发外观切换）。缺省 false。 */
  enabled?: boolean;
}

/**
 * 场景出口锚点：NPC **走到这里才隐去**（反过来入场从这里走进来）。
 * `kind` 只给编辑器分类与调试用，运行时不据此改行为。
 */
export interface SceneExitAnchor {
  id: string;
  x: number;
  y: number;
  kind?: 'door' | 'street' | 'other';
}

/**
 * 某时段的场景外观覆盖（渲染侧消费；未写的字段沿用场景顶层同名字段）。
 *
 * 这只是「换一套素材」那种做法的载体，**不是**日夜外观的必经之路：
 * 同一张图靠光照/滤镜实时算出夜色的方案根本不需要本结构。整块可以永远不用。
 */
export interface SceneTimeVariant {
  filterId?: string;
  lightEnv?: SceneLightEnv;
  backgrounds?: BackgroundLayer[];
  ambientSounds?: string[];
  bgm?: string;
}

// ============================================================
// NPC 日程（npc_schedules.json）
// ============================================================

/**
 * 一条日程条目：**几点到几点、在哪个场景、在哪个位置**。
 * 刻意不声明"怎么走过去"——走法由 `NpcScheduleSystem` 用 `Npc.moveTo` 决定。
 */
export interface NpcScheduleEntry {
  /** 起始时刻 `HH:MM`（含）。 */
  from: string;
  /** 结束时刻 `HH:MM`（不含）。允许 `to < from` 表示**跨零点**（如 19:00→06:00）。 */
  to: string;
  /**
   * 该时段所在场景 id。`null`（或不写）= **不在任何场景**（离场回家、下工）。
   * 玩家在场时会先走到出口再隐去，不会凭空消失。
   */
  scene?: string | null;
  /** 该时段的驻留坐标；缺省=用场景 JSON 里这个 NPC 自己的原始坐标（故绝大多数条目不必写）。 */
  spot?: Position;
  /** 到位后播放的动画状态名；缺省=不改动画。 */
  activity?: string;
  /** 本条目的额外生效条件（多条条目覆盖同一时段时，取**第一条**条件满足的）。 */
  conditions?: ConditionExpr[];
}

/** 一个角色的日程表。按 `characterId` 挂——一张表管这个角色在全世界的行踪。 */
export interface NpcScheduleDef {
  /** 对应 `character_registry.json` 的角色 id；场景里 `NpcDef.characterId` 引用它的实例受此表管。 */
  characterId: string;
  entries: NpcScheduleEntry[];
  /** 整张表的生效条件；不满足时该角色**完全不受日程管**（回落成普通常驻 NPC）。 */
  conditions?: ConditionExpr[];
  /** 离场时说的一句话（走之前播气泡）；不写则默默走。 */
  exitLine?: string;
  /** 优先使用的出口锚点 id；不写则取离 NPC 最近的出口。 */
  preferredExit?: string;
}

/** `npc_schedules.json` 的文件形状。 */
export interface NpcScheduleFile {
  schedules: NpcScheduleDef[];
}

/** 语义色板一档：`id` 是内容里写的标记名，`label` 只给编辑器/人看，`color` 为 `#RRGGBB` */
export interface TextPaletteEntry {
  id: string;
  label: string;
  color: string;
}

/** 逐 entity 光照全局配置 */
export interface EntityLightingConfig {
  /** 总开关；关闭（或缺省）时不创建光照滤镜/阴影，渲染与旧版一致 */
  enabled?: boolean;
  /** 全局阴影/AO 模式（场景 lightEnv.shadow.mode 可覆盖），默认 real */
  shadowMode?: ShadowMode;
  /** 全局色调融入开关（与阴影模式解耦；场景 lightEnv.toneEnabled 可覆盖），默认 true */
  toneEnabled?: boolean;
  /** 场景未配 lightEnv 时使用的全局默认光照环境 */
  defaultLightEnv?: SceneLightEnv;
}

// ============================================================
// UI 只读数据提供接口 — UI 层依赖这些接口而非具体系统类
// ============================================================

/** 活计图运行面板信息（NarrativeStateManager 只读派生，供任务面板/HUD 镜像用） */
export interface NarrativeRunPanelInfo {
  graphId: string;
  /** 当前实例所在状态 id；undefined = 无实例（蛰伏） */
  active?: string;
  /** 当前状态的显示 label（缺省回退状态 id） */
  activeLabel?: string;
  /** 第几单（= 累计 started 计数，reset 不增；无历史为 0） */
  ordinal: number;
  /** 是否占据全局激活槽（=追踪中） */
  activated: boolean;
  /** 是否挂起（有实例但未激活） */
  suspended: boolean;
  /** 各出口累计结算（label 取出口状态 label，缺省回退 id；只含 count>0 项） */
  settled: { exitId: string; label: string; count: number }[];
}

/** 一条目标的运行时投影：定义 + 是否已完成（勾选态由条件派生，不入档） */
export interface QuestObjectiveView {
  def: QuestObjectiveDef;
  done: boolean;
}

export interface IQuestDataProvider {
  /** @deprecated 只返回第一条进行中的主线；面板列表一律用 {@link getActiveQuests}（多条主线并行是常态） */
  getCurrentMainQuest(): QuestDef | null;
  getActiveQuests(): { def: QuestDef; status: QuestStatus }[];
  getCompletedQuests(): { def: QuestDef }[];
  /** repeatable 任务条目（含运行信息）；无实例且无结算历史的不返回 */
  getRepeatableQuestEntries(): { def: QuestDef; run: NarrativeRunPanelInfo }[];

  // ---- 当前任务槽（D6）：全局唯一，跨主线/支线/活计共用 ----

  /** 当前任务 id；无当前任务返回 null */
  getFocusedQuestId(): string | null;
  /** HUD 要的那一份：当前任务标题 + 当前目标一行（没有当前任务返回 null） */
  getFocusedQuestView(): { questId: string; title: string; objective: string } | null;
  /** 该任务此刻能否被设为当前任务（进行中的一次性任务 / 有在途实例的活计） */
  canFocusQuest(questId: string): boolean;
  /** 设为当前任务（活计会同步激活其活计图）；传 null 清空。announce=true 时顺带给一次醒目提示 */
  requestFocusQuest(questId: string | null, opts?: { announce?: boolean }): Promise<void>;

  // ---- 目标与引导（D7 / D8）----

  /** 目标清单投影；没配目标返回空数组 */
  getQuestObjectives(questId: string): QuestObjectiveView[];
  /** 当前目标 = 第一条未完成的必做目标；没有返回 null */
  getCurrentObjective(questId: string): QuestObjectiveDef | null;
  /** 该任务此刻生效的引导（当前目标的 guidance，回落任务级）；不是当前任务也照查，由调用方决定用不用 */
  getQuestGuidance(questId: string): QuestGuidanceDef[];
  /** 此刻真正该出的引导 = 当前任务的引导；没有当前任务返回空数组（引导只跟当前任务走） */
  getActiveGuidance(): QuestGuidanceDef[];
}

export interface IInventoryDataProvider {
  getCoins(): number;
  getAllItems(): { id: string; count: number; def?: ItemDef }[];
  getItemDef(id: string): ItemDef | undefined;
  getItemDescription(id: string): string;
  getItemCount(id: string): number;
  canDiscard(id: string): boolean;
}

export interface IRulesDataProvider {
  getAcquiredRules(): { def: RuleDef; acquired: boolean }[];
  getDiscoveredRules(): { def: RuleDef; collected: number; total: number }[];
  getFragmentProgress(ruleId: string): { collected: number; total: number; fragments: RuleFragmentDef[] };
  hasFragment(fragmentId: string): boolean;
  hasRule(ruleId: string): boolean;
  getRuleDef(ruleId: string): RuleDef | undefined;
  isDiscovered(ruleId: string): boolean;
  getCategoryName(key: string): string;
  getVerifiedLabel(key: string): string;
  getRuleDepth(ruleId: string): { unlocked: number; total: number };
  hasLayer(ruleId: string, layer: RuleLayerKey): boolean;
  getUnlockedLayerTexts(ruleId: string): Partial<Record<RuleLayerKey, string>>;
  getLayerFragmentProgress(ruleId: string): Partial<
    Record<RuleLayerKey, { collected: number; total: number; fragments: RuleFragmentDef[] }>
  >;
}

export interface IArchiveDataProvider {
  /** 将档案/书籍等 JSON 正文中的 [tag:…] 展开为当前展示文案 */
  resolveLine(raw: string | undefined): string;
  hasUnread(bookType: 'character' | 'lore' | 'document' | 'book' | 'slang' | 'rhyme'): boolean;
  getUnlockedCharacters(): CharacterEntry[];
  getCharacterVisibleImpressions(entry: CharacterEntry): string[];
  getCharacterVisibleInfo(entry: CharacterEntry): string[];
  getUnlockedLore(): LoreEntry[];
  getUnlockedDocuments(): DocumentEntry[];
  /** 怪话册：按分类分组，含未解锁灰槽（刻意返回全部条目，不做已解锁过滤） */
  getSlangCategories(): SlangCategoryView[];
  getSlangProgress(): SlangProgress;
  /** 歪歌册：flat 列表，含未解锁灰槽（刻意返回全部条目，不做已解锁过滤） */
  getRhymeList(): { entry: RhymeEntry; unlocked: boolean }[];
  getRhymeProgress(): RhymeProgress;
  getBooks(): BookDef[];
  getUnlockedBooks(): BookDef[];
  /** 左侧树：章节 → 子条目（含解锁状态） */
  getBookTocChapters(book: BookDef): BookTocChapter[];
  getBookPageSlice(book: BookDef, pageNum: number): BookReaderSlice | null;
  getBookEntrySlice(book: BookDef, pageNum: number, entryId: string): BookReaderSlice | null;
  markRead(key: string): void;
  isRead(key: string): boolean;
  getLoreCategoryName(key: string): string;
  /**
   * 档案实体首次被阅览时执行配置的 Action（每个 qualifiedKey 仅一次，与「已读」星标无关，单独持久化）。
   */
  triggerFirstViewIfNeeded(qualifiedKey: string, actions: ActionDef[] | undefined): void;
  /** 当前阅读屏首次展示时：仅触发该屏对应的页级或条目级 firstViewActions */
  triggerBookSliceFirstView(bookId: string, slice: BookReaderSlice): void;
}

export interface IZoneDataProvider {
  getCurrentRuleSlots(): ZoneRuleSlot[];
}

export interface IAudioSettingsProvider {
  getVolume(channel: 'bgm' | 'sfx' | 'ambient'): number;
  setVolume(channel: 'bgm' | 'sfx' | 'ambient', vol: number): void;
}

/**
 * 文字呈现偏好（玩家在设置页里调的那几项）。
 *
 * 与 {@link IAudioSettingsProvider} 同一个位置：设置页只认接口，实现在
 * `src/core/TextDisplaySettings.ts`（含落盘）。**逐字速度是倍率不是字/秒**——
 * 对白框与遭遇框各有自己调好的基准速度（30 / 35 字/秒），玩家调的是它们共同的快慢档。
 */
export interface ITextDisplaySettingsProvider {
  /** 逐字显示总开关；关掉＝整段文字瞬间出全（点一下就直接推进下一句） */
  isTypewriterEnabled(): boolean;
  setTypewriterEnabled(on: boolean): void;
  /** 逐字速度倍率（1 = 各 UI 的基准速度） */
  getTypewriterSpeedScale(): number;
  setTypewriterSpeedScale(scale: number): void;
}

/** 一次性短音频的调用方句柄：stop() 停止当前实例（不 unload 共享缓存 Howl）。 */
export interface AudioPlaybackHandle {
  stop(): void;
}

export interface TransientSfxOptions {
  volume?: number;
  /**
   * 仅在音频**自然播完**时回调一次；手动 stop / 加载失败 / 未知 id 均不触发
   * （调用方据此把"跟随配音结束"安全退化为等待点击，而非闪切）。
   */
  onEnd?: () => void;
}

/**
 * 过场字幕配音所需的窄能力接口：CutsceneManager 只依赖此接口而非整个 AudioManager，
 * 保持同层 system 解耦（不互持具体实例引用）。AudioManager 结构上满足此接口。
 */
export interface ICutsceneAudioPlayer {
  playTransientSfx(id: string, options?: TransientSfxOptions): AudioPlaybackHandle | null;
  /**
   * 过场开始时开启「一次性音效捕获」：其后经 action(playSfx/playSignalCue) 起的 SFX 会被登记。
   * 过场收尾（cleanup）调 endCutsceneSfxCapture：中断路径 stopPlaying=true 停掉尚在响的尾音，
   * 自然播完 stopPlaying=false 让末拍音效按编排收尾。
   */
  beginCutsceneSfxCapture(): void;
  endCutsceneSfxCapture(stopPlaying: boolean): void;
  /** 过场前音频基线快照：当前 BGM id（无则 null）与活跃环境层 id 列表，供同场景过场结束后还原。 */
  getCurrentBgmId(): string | null;
  getActiveAmbientIds(): string[];
  /** 把音频还原到过场前基线：BGM 切回 bgmId（null=停），并补回 ambientIds（幂等，未变即 no-op）。 */
  restoreAudioBaseline(bgmId: string | null, ambientIds: string[]): void;
}

export interface ISaveDataProvider {
  /** 返回是否成功写入（localStorage 失败 / canSave 拒绝时 false），UI 按成败分支提示 */
  save(slot: number): boolean;
  load(slot: number): Promise<boolean>;
  getSlotMeta(slot: number): SaveSlotMeta | null;
  hasSave(slot: number): boolean;
  hasAnySave(): boolean;
  /** 跨运行壳互通：导出/导入原始 v1 JSON 信封；不改变 systems 桶。 */
  exportSlotPayload(slot: number): string | null;
  importSlotPayload(slot: number, raw: string): boolean;
}
