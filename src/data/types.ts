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

// ============================================================
// 游戏状态枚举
// ============================================================

export enum GameState {
  MainMenu = 'MainMenu',
  Exploring = 'Exploring',
  Dialogue = 'Dialogue',
  Encounter = 'Encounter',
  Cutscene = 'Cutscene',
  UIOverlay = 'UIOverlay',
}

// ============================================================
// FlagStore 条件格式
// ============================================================

export interface Condition {
  flag: string;
  op?: '==' | '!=' | '>' | '<' | '>=' | '<=';
  value?: boolean | number;
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
  /** 相机配置 */
  camera?: SceneCameraConfig;
  /** 世界整体缩放（用于背景图分辨率不够时整体缩小），默认1 */
  worldScale?: number;
  /** 本场景玩家行走速度（世界单位/秒），未写则使用默认值 */
  playerWalkSpeed?: number;
  /** 本场景玩家奔跑速度（世界单位/秒），未写则使用默认值 */
  playerRunSpeed?: number;
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
  /** 资源路径，如 `/assets/images/...` */
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
   * 若设置：该热点仅在其过场播放窗口内显示/可交互；优先级高于 Save 的 enabled 覆盖。
   * 非所属过场或未在过场中时始终视为隐藏（与场景编辑器「过场编辑上下文」一致）。
   */
  cutsceneId?: string;
  interactionRange: number;
  /** 组内 AND；可为 flag / quest / scenario 等 `ConditionExpr` 叶子或组合 */
  conditions?: ConditionExpr[];
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
}

/** 旧版 inspect：纯文本 + 可选 actions */
export interface InspectDataTextMode {
  text: string;
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

/** 图对话原子条件（无逻辑组合） */
export type GraphConditionLeaf = Condition | QuestConditionLeaf | ScenarioConditionLeaf;

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

export interface NpcDef {
  id: string;
  name: string;
  x: number;
  y: number;
  /**
   * 若设置：该 NPC 仅在其过场播放窗口内可见/可交互；优先级高于 persistNpcEntityEnabled 与 Save 覆盖。
   * 探索态未播放所属过场时始终隐藏。
   */
  cutsceneId?: string;
  /**
   * 图对话：资源 id（不含路径），对应 `public/assets/dialogues/graphs/<id>.json`。
   * 未配置时按 E 不会进入对话。
   */
  dialogueGraphId?: string;
  /** 覆盖图 JSON 的 `entry`；缺省用图内 `entry` */
  dialogueGraphEntry?: string;
  /**
   * 进入该 NPC 对话时镜头渐变缩放到该值（与场景 `camera.zoom` 同语义）；缺省为 1.0。
   * 对话结束（含异常中断）时由系统渐变恢复为当前场景配置的 zoom。
   */
  dialogueCameraZoom?: number;
  /**
   * @deprecated 站立/表情动画请用图对话 `runActions` 的 playNpcAnimation；保留字段仅为兼容旧场景数据。
   */
  dialogueStandAnimState?: string;
  interactionRange: number;
  /** 动画包清单路径，如 `/assets/animation/<包目录名>/anim.json`；图集由清单内 spritesheet 相对该目录解析 */
  animFile?: string;
  /** 进入场景时播放的状态名；缺省时优先 idle，否则取 states 中第一个 */
  initialAnimState?: string;
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
}

export interface HotspotRuntimeOverride {
  enabled?: boolean;
  x?: number;
  y?: number;
  displayImage?: HotspotDisplayImage | null;
}

export interface SceneEntityRuntimeOverrides {
  npcs: Record<string, NpcRuntimeOverride>;
  hotspots: Record<string, HotspotRuntimeOverride>;
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
  type: 'main' | 'side';
  sideType?: 'errand' | 'inquiry' | 'investigation' | 'commission';
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
}

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
  moveTo(targetX: number, targetY: number, speed: number, moveAnimState?: string): Promise<void>;
  playAnimation(name: string): void;
  setFacing(dx: number, dy: number): void;
  setVisible(visible: boolean): void;
  cutsceneUpdate(dt: number): void;
}

/** 可选：`showEmote` / `showEmoteAndWait` 气泡相对默认锚点的额外像素偏移（局部坐标）。 */
export type EmoteBubbleOffsetOpts = {
  anchorOffsetX?: number;
  anchorOffsetY?: number;
};

/** 演出气泡提供者接口，用于 CutsceneManager 解耦对 EmoteBubbleManager 的直接依赖 */
export interface IEmoteBubbleProvider {
  showAndWait(
    anchor: IEmoteBubbleAnchor,
    emote: string,
    durationMs?: number,
    opts?: EmoteBubbleOffsetOpts,
  ): Promise<void>;
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
 */
export interface PresentStep {
  kind: 'present';
  type: string;
  [key: string]: unknown;
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
 */
export const CUTSCENE_ACTION_WHITELIST: ReadonlySet<string> = new Set([
  'moveEntityTo',
  'faceEntity',
  'cutsceneSpawnActor',
  'cutsceneRemoveActor',
  'showEmoteAndWait',
  'playNpcAnimation',
  'setEntityEnabled',
  'persistNpcEntityEnabled',
  'persistHotspotEnabled',
  'tempSetHotspotDisplayFacing',
  'playSfx',
  'playBgm',
  'stopBgm',
]);

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
  unlockConditions: ConditionExpr[];
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

export interface ZoneDef {
  id: string;
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
  /** anim.json 的 URL，默认 /assets/animation/player_anim/anim.json */
  animManifest?: string;
  /**
   * 逻辑状态名 -> anim.json 里 states 的键。未写的键视为「与逻辑名同名」。
   * 游戏内 Player 固定使用 idle / walk / run 三种逻辑名。
   */
  stateMap?: Record<string, string>;
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
}

// ============================================================
// UI 只读数据提供接口 — UI 层依赖这些接口而非具体系统类
// ============================================================

export interface IQuestDataProvider {
  getCurrentMainQuest(): QuestDef | null;
  getActiveQuests(): { def: QuestDef; status: QuestStatus }[];
  getCompletedQuests(): { def: QuestDef }[];
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

export interface ISaveDataProvider {
  save(slot: number): void;
  load(slot: number): Promise<boolean>;
  getSlotMeta(slot: number): SaveSlotMeta | null;
  hasSave(slot: number): boolean;
  hasAnySave(): boolean;
}
