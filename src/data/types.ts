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
  interactionRange: number;
  conditions?: Condition[];
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

export interface InspectData {
  text: string;
  actions?: ActionDef[];
}

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

export interface NpcDef {
  id: string;
  name: string;
  x: number;
  y: number;
  /** 未配置时按 E 不会进入对话 */
  dialogueFile?: string;
  dialogueKnot?: string;
  /**
   * 进入该 NPC 对话时镜头渐变缩放到该值（与场景 `camera.zoom` 同语义）；缺省为 1.0。
   * 对话结束（含异常中断）时由系统渐变恢复为当前场景配置的 zoom。
   */
  dialogueCameraZoom?: number;
  /**
   * @deprecated 站立/表情动画请在 Ink 中用 `# action:playNpcAnimation:...`；保留字段仅为兼容旧场景数据。
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
  conditions: Condition[];
  bypassPreconditions?: boolean;
}

export interface QuestDef {
  id: string;
  group: string;
  type: 'main' | 'side';
  sideType?: 'errand' | 'inquiry' | 'investigation' | 'commission';
  title: string;
  description: string;
  preconditions: Condition[];
  completionConditions: Condition[];
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

export interface RuleDef {
  id: string;
  name: string;
  incompleteName?: string;
  category: 'ward' | 'taboo' | 'jargon' | 'streetwise';
  description: string;
  source: string;
  sourceType: 'npc' | 'fragment' | 'experience';
  verified: 'unverified' | 'effective' | 'questionable';
  fragmentCount?: number;
}

export interface RuleFragmentDef {
  id: string;
  text: string;
  ruleId: string;
  index: number;
  source?: string;
}

// ============================================================
// 物件数据
// ============================================================

export interface ItemDef {
  id: string;
  name: string;
  type: 'consumable' | 'key';
  description: string;
  dynamicDescriptions?: { conditions: Condition[]; text: string }[];
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
  conditions: Condition[];
  requiredRuleId?: string;
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

export interface ICutsceneActor {
  readonly entityId: string;
  x: number;
  y: number;
  moveTo(targetX: number, targetY: number, speed: number, moveAnimState?: string): Promise<void>;
  playAnimation(name: string): void;
  setFacing(dx: number, dy: number): void;
  setVisible(visible: boolean): void;
  getDisplayObject(): unknown;
  cutsceneUpdate(dt: number): void;
  /**
   * 表情气泡锚点：在 getDisplayObject() 局部坐标中，气泡**底边**应对齐的 Y（脚点在 0，向上为负）。
   * EmoteBubbleManager 会把气泡顶边放在该 Y 上方 `bubbleHeight` 处。
   */
  getEmoteBubbleAnchorLocalY(): number;
}

/** 演出气泡提供者接口，用于 CutsceneManager 解耦对 EmoteBubbleManager 的直接依赖 */
export interface IEmoteBubbleProvider {
  showAndWait(actor: ICutsceneActor, emote: string, durationMs?: number): Promise<void>;
  cleanup(): void;
}

export interface CutsceneDef {
  id: string;
  commands: CutsceneCommand[];
  targetScene?: string;
  targetSpawnPoint?: string;
  targetX?: number;
  targetY?: number;
  restoreState?: boolean;
}

export interface CutsceneCommand {
  type: string;
  parallel?: boolean;
  [key: string]: unknown;
}

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
  impressions: { text: string; conditions: Condition[] }[];
  knownInfo: { text: string; conditions: Condition[] }[];
  unlockConditions: Condition[];
  /** 玩家第一次在档案中点开该人物时执行（仅一次，记入存档） */
  firstViewActions?: ActionDef[];
}

export interface LoreEntry {
  id: string;
  title: string;
  content: string;
  source: string;
  category: 'legend' | 'geography' | 'folklore' | 'affairs';
  unlockConditions: Condition[];
  /** 玩家第一次在档案中点开该条目时执行（仅一次） */
  firstViewActions?: ActionDef[];
}

export interface DocumentEntry {
  id: string;
  name: string;
  content: string;
  annotation?: string;
  discoverConditions: Condition[];
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
  /** 满足时自动解锁；与 Ink/Action 写入的 archive_book_entry_<id> 等价 */
  discoverConditions?: Condition[];
  /** 已解锁且玩家第一次翻到包含该条目的书页时执行（仅一次） */
  firstViewActions?: ActionDef[];
}

export interface BookPage {
  pageNum: number;
  title?: string;
  content: string;
  illustration?: string;
  unlockConditions?: Condition[];
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
  unlockConditions: Condition[];
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
  conditions?: Condition[];
  onEnter?: ActionDef[];
  /** 玩家在区域内时每帧执行的 Action（慎用非幂等 action）。 */
  onStay?: ActionDef[];
  onExit?: ActionDef[];
}

export interface ZoneRuleSlot {
  ruleId: string;
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
}

export interface IArchiveDataProvider {
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
