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
}

export interface NpcDef {
  id: string;
  name: string;
  x: number;
  y: number;
  dialogueFile: string;
  dialogueKnot?: string;
  interactionRange: number;
  animFile?: string;
  patrol?: PatrolDef;
}

// ============================================================
// 场景运行时状态（用于场景记忆）
// ============================================================

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

export interface AnimationSetDef {
  spritesheet: string;
  cols: number;
  rows: number;
  /** 世界单位：精灵在世界中的宽度 */
  worldWidth: number;
  /** 世界单位：精灵在世界中的高度（可从 worldWidth 和图集帧比例推导） */
  worldHeight: number;
  states: Record<string, AnimationStateDef>;
}

export interface AnimationStateDef {
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
  moveTo(targetX: number, targetY: number, speed: number): Promise<void>;
  playAnimation(name: string): void;
  setFacing(dx: number, dy: number): void;
  setVisible(visible: boolean): void;
  getDisplayObject(): unknown;
  cutsceneUpdate(dt: number): void;
}

/** 演出气泡提供者接口，用于 CutsceneManager 解耦对 EmoteBubbleManager 的直接依赖 */
export interface IEmoteBubbleProvider {
  showAndWait(actor: ICutsceneActor, emote: string, durationMs?: number): Promise<void>;
  cleanup(): void;
}

export interface CutsceneDef {
  id: string;
  commands: CutsceneCommand[];
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
}

export interface LoreEntry {
  id: string;
  title: string;
  content: string;
  source: string;
  category: 'legend' | 'geography' | 'folklore' | 'affairs';
  unlockConditions: Condition[];
}

export interface DocumentEntry {
  id: string;
  name: string;
  content: string;
  annotation?: string;
  discoverConditions: Condition[];
}

export interface BookDef {
  id: string;
  title: string;
  totalPages: number;
  pages: BookPage[];
}

export interface BookPage {
  pageNum: number;
  title?: string;
  content: string;
  illustration?: string;
  unlockConditions: Condition[];
}

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

export interface ZoneDef {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  conditions?: Condition[];
  onEnter?: ActionDef[];
  onExit?: ActionDef[];
  ruleSlots?: ZoneRuleSlot[];
}

export interface ZoneRuleSlot {
  ruleId: string;
  resultActions: ActionDef[];
  resultText?: string;
}

// ============================================================
// 全局游戏配置
// ============================================================

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
  getBookVisiblePages(book: BookDef): { pageNum: number; title?: string; content: string; illustration?: string; unlocked: boolean }[];
  markRead(key: string): void;
  isRead(key: string): boolean;
  getLoreCategoryName(key: string): string;
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
