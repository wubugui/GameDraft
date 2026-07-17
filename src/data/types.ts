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
  shader: { depth_per_sy: number; floor_depth_A: number; floor_depth_B: number };
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
  bgm?: string;
  ambientSounds?: string[];
  /** 氛围滤镜 ID，对应 assets/data/filters/{filterId}.json，未写则不应用滤镜 */
  filterId?: string;
  depthConfig?: SceneDepthConfig;
  /** 光照环境（逐 entity 阴影/色调/AO）；缺省回落到全局默认 */
  lightEnv?: SceneLightEnv;
  /** 光照环境曲线：玩家位置投影到折线后插值切换光照关键帧；缺省=用静态 lightEnv（现状不变） */
  lightEnvCurve?: LightEnvCurveDef;
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

export type HotspotType = 'inspect' | 'pickup' | 'transition' | 'npc' | 'encounter';

/** 有展示图时强制与 Player/NPC 的叠放档位；缺省字段则与其它实体一样仅按 Y 排序 */
export type HotspotDisplaySpriteSort = 'back' | 'front';

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
  spriteSort?: HotspotDisplaySpriteSort;
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
  data: InspectData | PickupData | TransitionData | NpcHotspotData | EncounterTriggerData;
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
  /** 分组标签（纯标签、非 id 引用）：供组动作（setGroupEnabled/moveGroupBy）批量寻址。 */
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

/** 图对话原子条件（无逻辑组合） */
export type GraphConditionLeaf =
  | Condition
  | QuestConditionLeaf
  | ScenarioConditionLeaf
  | ScenarioLineConditionLeaf
  | NarrativeStateConditionLeaf
  | NarrativeRunCountConditionLeaf
  | PlaneConditionLeaf;

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
   * 实例级等比缩放（quad 级真变换，绕脚底锚点）：渲染/碰撞多边形/交互半径/
   * 阴影尺寸/气泡/深度接地线随动；缺省 1。可经 setEntityField 运行时改并入档。
   */
  scale?: number;
  /** 实例级旋转（度，绕脚底锚点）；quad 级真变换同上；缺省 0。 */
  rotation?: number;
  /** 分组标签（纯标签、非 id 引用）：供组动作（setGroupEnabled/moveGroupBy）批量寻址。 */
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
  /** 说话人对应的世界实体（说话中「…」气泡定位用）；旁白/literal 无 */
  speakerEntity?: { kind: 'npc'; npcId: string } | { kind: 'player' };
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
   */
  moveTo(
    targetX: number,
    targetY: number,
    speed: number,
    moveAnimState?: string,
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
};

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
 * Action 步骤——通过 ActionExecutor.executeAwait 执行。
 * Cutscene 中仅允许无副作用的 Action 子集（白名单）。
 */
export interface ActionStep {
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
export interface PresentStep {
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
export interface ParallelGroup {
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

/** ActionExecutor 在 zone 内执行 batch 时注入的上下文。 */
export interface ZoneActionContext {
  zoneId: string;
}

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
  /** 分组标签（纯标签、非 id 引用）：编辑器可指派；组动作首期不消费 zone（预留）。 */
  group?: string;
  /**
   * 位面归属（见 `systems/plane/types.ts` PlaneDef）：缺省 = zone 存在于**所有**位面；
   * 有值时仅当激活位面包含于该列表时才注册进 ZoneSystem（切位面后由刷新入口重注册）。
   */
  planes?: string[];
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
   * 游戏内 Player 固定使用 idle / walk / run 三种逻辑名。
   */
  stateMap?: Record<string, string>;
  /**
   * 主角对话头像立绘集（与 NpcDef.portraitSlug 同语义）：头像跟随「当前生效的装扮配置」走。
   * 缺省按 animManifest 的动画包目录名同名推导（如 player_carry_corpse_anim）。
   * setPlayerAvatar 切装扮时可用同名参数携带新配置的立绘集。
   */
  portraitSlug?: string;
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
  /** 玩家化身：动画资源与状态映射（见 PlayerAvatarConfig） */
  playerAvatar?: PlayerAvatarConfig;
  /** 为 true 时按背景像素密度对实体展示做自动低通（纯渲染，默认开启；可在 game_config 设为 false 关闭） */
  entityPixelDensityMatch?: boolean;
  /**
   * 低通强度倍率，缺省 0.25。仅当 entityPixelDensityMatch 生效时读取；建议约 0.25～2。
   */
  entityPixelDensityMatchBlurScale?: number;
  /** 逐 entity 光照（阴影 + 色调融入 + AO）配置，关闭时完全走旧渲染管线 */
  entityLighting?: EntityLightingConfig;
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

export interface IQuestDataProvider {
  getCurrentMainQuest(): QuestDef | null;
  getActiveQuests(): { def: QuestDef; status: QuestStatus }[];
  getCompletedQuests(): { def: QuestDef }[];
  /** repeatable 任务条目（含运行信息）；无实例且无结算历史的不返回 */
  getRepeatableQuestEntries(): { def: QuestDef; run: NarrativeRunPanelInfo }[];
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
  hasUnread(bookType: 'character' | 'lore' | 'document' | 'book'): boolean;
  getUnlockedCharacters(): CharacterEntry[];
  getCharacterVisibleImpressions(entry: CharacterEntry): string[];
  getCharacterVisibleInfo(entry: CharacterEntry): string[];
  getUnlockedLore(): LoreEntry[];
  getUnlockedDocuments(): DocumentEntry[];
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
