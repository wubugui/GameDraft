import { EventBus } from './EventBus';
import { FlagStore, type FlagRegistryJson } from './FlagStore';
import { applyDevRuntimeCommand } from './devRuntimeCommands';
import { InputManager } from './InputManager';
import { AssetManager, type AssetRef } from './AssetManager';
import { ActionExecutor } from './ActionExecutor';
import { SaveManager } from './SaveManager';
import { Renderer } from '../rendering/Renderer';
import { Camera } from '../rendering/Camera';
import { Player, ANIM_IDLE, ANIM_WALK, ANIM_RUN } from '../entities/Player';
import { InteractionSystem } from '../systems/InteractionSystem';
import { SceneManager } from '../systems/SceneManager';
import { DialogueManager } from '../systems/DialogueManager';
import { GraphDialogueManager } from '../systems/GraphDialogueManager';
import { QuestManager } from '../systems/QuestManager';
import { RulesManager } from '../systems/RulesManager';
import { InventoryManager } from '../systems/InventoryManager';
import { EncounterManager } from '../systems/EncounterManager';
import { AudioManager } from '../systems/AudioManager';
import { DayManager } from '../systems/DayManager';
import { CutsceneManager } from '../systems/CutsceneManager';
import { CutsceneRenderer } from '../rendering/CutsceneRenderer';
import { ArchiveManager } from '../systems/ArchiveManager';
import { EmoteBubbleManager } from '../systems/EmoteBubbleManager';
import { ZoneSystem } from '../systems/ZoneSystem';
import { InspectBox } from '../ui/InspectBox';
import { PickupNotification } from '../ui/PickupNotification';
import { DialogueUI } from '../ui/DialogueUI';
import { EncounterUI } from '../ui/EncounterUI';
import { ActionChoiceUI } from '../ui/ActionChoiceUI';
import { PressureHoldUI } from '../ui/PressureHoldUI';
import { PressureHoldManager } from '../systems/pressureHold/PressureHoldManager';
import { SignalCueManager } from '../systems/SignalCueManager';
import { HealthSystem } from '../systems/HealthSystem';
import { SmellSystem } from '../systems/SmellSystem';
import { PlaneReconciler } from '../systems/PlaneReconciler';
import { HUD } from '../ui/HUD';
import type { SmellProfilesRaw } from '../ui/smell/SmellIndicatorRenderer';
import { NotificationUI } from '../ui/NotificationUI';
import { QuestPanelUI } from '../ui/QuestPanelUI';
import { InventoryUI } from '../ui/InventoryUI';
import { RulesPanelUI } from '../ui/RulesPanelUI';
import { DialogueLogUI } from '../ui/DialogueLogUI';
import { BookshelfUI } from '../ui/BookshelfUI';
import { BookReaderUI } from '../ui/BookReaderUI';
import { CharacterBookUI } from '../ui/CharacterBookUI';
import { LoreBookUI } from '../ui/LoreBookUI';
import { DocumentBoxUI } from '../ui/DocumentBoxUI';
import { ShopUI } from '../ui/ShopUI';
import { MapUI } from '../ui/MapUI';
import { MenuUI } from '../ui/MenuUI';
import { RuleUseUI } from '../ui/RuleUseUI';
import { DebugPanelUI } from '../ui/DebugPanelUI';
import { GameStateController } from './GameStateController';
import { StringsProvider } from './StringsProvider';
import { GameState } from '../data/types';
import type {
  ActionDef,
  IGameSystem,
  AnimationSetDef,
  DialogueEndPayload,
  DialogueLine,
  DialoguePortraitRef,
  GameConfig,
  MapConfigFile,
  MapNodeDef,
  SceneData,
  SceneDataRaw,
  ScenarioCatalogFile,
  SceneLightEnv,
  ICutsceneActor,
  HotspotDisplayImage,
  IEmoteBubbleAnchor,
  CharacterRegistryFile,
} from '../data/types';
import { buildCharacterRegistry } from '../data/characterRegistry';
import { DEFAULT_ENTITY_PIXEL_DENSITY_BLUR_SCALE } from '../rendering/EntityPixelDensityMatch';
import type { AnimationSetDefInput } from '../data/resolveAnimationSet';
import { normalizeAnimationSetDef } from '../data/resolveAnimationSet';
import { resolvePathRelativeToAnimManifest } from './assetPath';
import { createPlaceholderPlayerTextures } from '../rendering/PlaceholderFactory';
import type { Npc } from '../entities/Npc';
import type { Hotspot } from '../entities/Hotspot';
import { registerActionHandlers, auditActionRegistrationsAgainstManifest } from './ActionRegistry';
import { collectRecentPageErrors, installPageErrorTrap } from './pageErrorTrap';
import { DeterministicRandom } from '../utils/deterministicRandom';
import { ScenarioStateManager } from './ScenarioStateManager';
import { NarrativeStateManager, type NarrativeSignal } from './NarrativeStateManager';
import { DocumentRevealManager } from '../systems/DocumentRevealManager';
import { RuleOfferRegistry } from './RuleOfferRegistry';
import { InteractionCoordinator } from './InteractionCoordinator';
import { EventBridge } from './EventBridge';
import { DebugTools, type ScenarioDebugPanelRow } from './DebugTools';
import { SceneDepthSystem } from './SceneDepthSystem';
import { WaterMinigameManager } from '../systems/waterMinigame/WaterMinigameManager';
import { SugarWheelMinigameManager } from '../systems/sugarWheel/SugarWheelMinigameManager';
import { PaperCraftMinigameManager } from '../systems/paperCraft/PaperCraftMinigameManager';
import { DepthDebugVisualizer } from '../debug/DepthDebugVisualizer';
import type { IEntityShadingFilter } from '../rendering/EntityLightingFilter';
import { resolveLightEnv, type ResolvedLightEnv } from '../rendering/lightEnv';
import {
  prepareLightCurve,
  projectToCurveT,
  interpolateLightEnv,
  copyResolvedInto,
  type PreparedLightCurve,
} from '../rendering/lightEnvCurve';
import { buildIrradianceProbe } from '../rendering/irradianceProbe';
import { PlanarEntityShadow } from '../rendering/EntityShadow';
import { DeferredEntityShadow } from '../rendering/DeferredEntityShadow';
import type { ShadowSource, IEntityShadow } from '../rendering/entityShadowTypes';
import { UniformShadowField, type ShadowProjectionField } from '../rendering/shadowField';
import { resolveDepthFloorOffsetBoost } from '../utils/depthFloorZones';
import type { ConditionEvalContext } from '../systems/graphDialogue/evaluateGraphCondition';
import { evaluateConditionExpr } from '../systems/graphDialogue/evaluateGraphCondition';
import { isPointInPolygon, isValidZonePolygon } from '../utils/zoneGeometry';
import { hotspotCollisionPolygonToWorld, npcCollisionPolygonToWorld } from '../utils/hotspotCollision';
import { depthLog, depthError } from './depthLog';
import { DevModeUI } from '../ui/DevModeUI';
import { resolveText, type ResolveContext } from './resolveText';
import { waitClickContinueWithHint } from '../ui/ClickContinuePrompt';
import { TouchMobileControls } from '../ui/TouchMobileControls';
import {
  resolveScriptedSpeakerDisplay,
  resolveScriptedSpeakerEntity,
  type ScriptedSpeakerEntity,
} from '../utils/scriptedDialogueSpeaker';
import { RenderTexture, Texture, UPDATE_PRIORITY } from 'pixi.js';
import { sceneJsonUrl, TEXT_URLS } from './projectPaths';
import {
  coerceRuntimeFieldValue,
  isHotspotDisplayImage,
  type RuntimeFieldValue,
  type SceneEntityKind,
} from '../data/EntityRuntimeFieldSchema';
import { installRuntimeErrorsToDebugPanel } from '../debug/debugPanelRuntimeLog';
import {
  drainWebGLErrorsToPanel,
  logDepthTextureGpuStatus,
  pixiInitTextureSourceForGpu,
  tryGetWebGlFromApplication,
} from '../debug/webglPanelDiagnostics';
import { warmUpBackgroundDebugGlProgramForDiagnostics } from '../rendering/BackgroundDebugFilter';
import { warmUpDepthOcclusionGlProgramForDiagnostics } from '../rendering/DepthOcclusionFilter';

export interface GameStartOptions {
  devMode?: boolean;
  playCutscene?: string;
  /** 开发模式下直接进入指定场景（URL `devScene=` / `dev_scene=`） */
  devScene?: string;
  /** 开发模式下直接进入指定叙事跳转（URL `narrativeWarp=` / `narrative_warp=`） */
  narrativeWarp?: string;
  /** 开发模式下直接进入指定水域小游戏实例（由编辑器预览 URL `waterPreview=` 传入） */
  waterPreview?: string;
  /** 开发模式下直接进入指定转盘小游戏实例（URL `sugarWheelPreview=`） */
  sugarWheelPreview?: string;
  /** 开发模式下直接进入指定扎纸小游戏实例（URL `paperCraftPreview=`） */
  paperCraftPreview?: string;
  /** 自动视觉基准模式：保留 dev 直达能力，但不打开 DevMode 遮罩。 */
  visualCapture?: boolean;
}

declare global {
  interface Window {
    __gameDevAPI?: {
      playCutscene(id: string): void;
      reload(): void;
      isReady(): boolean;
      /** 重新打开 Dev Mode 面板（从场景列表跳转后不会自动再开） */
      openDevPanel(): void;
      getNarrativeDebugSnapshot(): Record<string, unknown>;
      clearNarrativeDebugTrace(): void;
      emitNarrativeSignal(signal: { sourceType: string; sourceId: string; signal: string }): Promise<void>;
      debugSetNarrativeState(graphId: string, stateId: string): Promise<void>;
      setNarrativeState(graphId: string, stateId: string): Promise<void>;
      setDepthDebug(enabled: boolean): void;
      clearWorldFilter(): void;
      setWorldFadeAlpha(alpha: number): void;
      completeDialogueText(): void;
      startMinigame(kind: 'water' | 'sugarWheel' | 'paperCraft' | 'pressureHold', id: string): Promise<boolean>;
      stepFixedTicks(ticks: number, dtMs: number): Promise<void>;
      getMinigameDebugState(): Record<string, unknown>;
      playAudioProbe(id: string, fadeMs: number): void;
      getAudioDebugState(): Record<string, unknown>;
      suppressSceneEnterForVisualCapture(): void;
    };
  }
}

/** dev 菜单「叙事」跳转配置（public/assets/data/dev_narrative_warps.json）。 */
type DevNarrativeWarp = {
  id: string;
  label: string;
  scene: string;
  flowGraph?: string;
  flowState?: string;
  set?: Array<{ graph: string; state: string }>;
};

export class Game {
  private eventBus: EventBus;
  private flagStore: FlagStore;
  private stringsProvider: StringsProvider;
  private inputManager: InputManager;
  private assetManager: AssetManager;
  private actionExecutor: ActionExecutor;
  private renderer: Renderer;
  private camera: Camera;
  private player: Player;
  private interactionSystem: InteractionSystem;
  private sceneManager: SceneManager;
  private dialogueManager: DialogueManager;
  private graphDialogueManager: GraphDialogueManager;
  private scenarioStateManager: ScenarioStateManager;
  private narrativeStateManager: NarrativeStateManager;
  private documentRevealManager: DocumentRevealManager;
  private questManager: QuestManager;
  private rulesManager: RulesManager;
  private inventoryManager: InventoryManager;
  private encounterManager: EncounterManager;
  private audioManager: AudioManager;
  private dayManager: DayManager;
  private cutsceneManager!: CutsceneManager;
  private cutsceneRenderer!: CutsceneRenderer;
  private resolveActorFn!: (id: string) => ICutsceneActor | null;
  /** 地图节点 sceneId -> 显示名；供 [tag:scene:…] 与 NPC 全局名缓存扫描 */
  private sceneDisplayNameById = new Map<string, string>();
  private npcDisplayNameById = new Map<string, string>();
  private archiveManager: ArchiveManager;
  private emoteBubbleManager: EmoteBubbleManager;
  private ruleOfferRegistry: RuleOfferRegistry;
  private zoneSystem: ZoneSystem;
  private saveManager!: SaveManager;
  private inspectBox!: InspectBox;
  private pickupNotification!: PickupNotification;
  private dialogueUI!: DialogueUI;
  private encounterUI!: EncounterUI;
  private actionChoiceUI!: ActionChoiceUI;
  private hud!: HUD;
  private notificationUI!: NotificationUI;
  private questPanelUI!: QuestPanelUI;
  private inventoryUI!: InventoryUI;
  private rulesPanelUI!: RulesPanelUI;
  private dialogueLogUI!: DialogueLogUI;
  private bookshelfUI!: BookshelfUI;
  private bookReaderUI!: BookReaderUI;
  private shopUI!: ShopUI;
  private mapUI!: MapUI;
  private menuUI!: MenuUI;
  private ruleUseUI!: RuleUseUI;
  private debugPanelUI!: DebugPanelUI;
  /** 过场当前 step 调试浮层（dev / ?cutsceneDebug） */
  private cutsceneStepHudEl: HTMLElement | null = null;

  private stateController: GameStateController;
  private lastTime: number = 0;
  private lastFps: number = 0;
  private playTimeMs: number = 0;
  private readonly runtimeRandom = new DeterministicRandom('gamedraft-runtime-v1');
  private playerAnimDef: AnimationSetDef | null = null;

  private interactionCoordinator!: InteractionCoordinator;
  private eventBridge!: EventBridge;
  /** T1：仅 DEV 装配（F10 坐标、中键缩放、F2 调试区块等纯开发设施），生产为 null */
  private debugTools: DebugTools | null = null;
  private sceneDepthSystem: SceneDepthSystem;
  private waterMinigameManager: WaterMinigameManager;
  private sugarWheelMinigameManager: SugarWheelMinigameManager;
  private paperCraftMinigameManager: PaperCraftMinigameManager;
  private pressureHoldManager: PressureHoldManager;
  private signalCueManager: SignalCueManager;
  private healthSystem: HealthSystem;
  private smellSystem: SmellSystem;
  private planeReconciler: PlaneReconciler;
  private smellProfilesData: SmellProfilesRaw | null = null;
  private pressureHoldUI!: PressureHoldUI;
  private depthDebugVisualizer!: DepthDebugVisualizer;
  private playerDepthFilter: IEntityShadingFilter | null = null;

  /** 当前场景辐照度探针 RT（逐 entity 色调融入），场景卸载时销毁 */
  private currentProbe: RenderTexture | null = null;
  /** 当前场景解析后的光照环境（驱动阴影） */
  private currentLightEnv: ResolvedLightEnv | null = null;
  /** 当前场景的光照环境曲线（预处理累计弧长）；null=无曲线，按静态 lightEnv 走（零影响） */
  private currentLightCurve: PreparedLightCurve | null = null;
  /** 位面光照档覆盖（PlaneReconciler 经 applyPlaneLightEnvOverride 设/清）；激活期 lightEnvCurve 挂起 */
  private planeLightEnvOverride: SceneLightEnv | null = null;
  /** 阴影方向/长度来源（今天=全局 LightEnv 均匀场；将来可换成场景灯光方向场） */
  private currentShadowField: ShadowProjectionField | null = null;
  /**
   * 玩家/NPC/热点的投影阴影（key: 'player' / npc.id / `hotspot:<id>`）。
   * F2 性能：ShadowSource 按实体缓存（owner 记录实例身份，实例被过场重建时按需换源），
   * updateEntityShadows 不再逐帧新建闭包包。
   */
  private entityShadows = new Map<string, { shadow: IEntityShadow; src: ShadowSource; owner: unknown }>();
  /**
   * 场景 onEnter 执行期间的隐式叙事 owner（`scene:<场景id>`）。
   * 供 onEnter 里未显式指定 owner 的 startDialogueGraph 与条件 `@owner` 继承当前场景。
   * 仅在 sceneEnterRunner 执行窗口内非空。
   */
  private ambientNarrativeOwner: { ownerType: string; ownerId: string } | null = null;

  /** null = 跟随 game_config.entityPixelDensityMatch；非 null 为调试强制开/关 */
  private entityPixelDensityMatchDebugOverride: boolean | null = null;

  /** null = 使用 game_config.entityPixelDensityMatchBlurScale；非 null 为调试倍率（仍会被夹到 0.05～5） */
  private entityPixelDensityMatchBlurScaleDebug: number | null = null;

  /** 场景卸载时递增，使旧场景的 NPC 巡逻异步循环立即失效 */
  private patrolGeneration = 0;
  /**
   * 按 NPC 递增的巡逻代；`stopNpcPatrol` Action 与对话顺序 bump，协程在 sleep/move 前后检查，无需 FlagStore。
   * 场景卸载时清空，避免与旧场景残留 token 纠缠。
   */
  private npcPatrolEpoch = new Map<string, number>();
  private mainTick: (() => void) | null = null;
  /** Pixi 渲染之后 drain gl.getError（优先级 UTILITY，低于内置 render） */
  private glPostRenderDrain: (() => void) | null = null;
  private webglContextLostHandler: ((ev: Event) => void) | null = null;
  private webglContextRestoredHandler: (() => void) | null = null;
  private runtimeDebugLogCleanup: (() => void) | null = null;
  private runtimeDebugSnapshotTimer: number | null = null;
  private runtimeCommandPollTimer: number | null = null;
  private runtimeCommandPollInFlight = false;
  /** 本次页面会话的实例 id；快照携带，命令可用 targetBootId 指向特定实例（多开页签时避免互抢） */
  private readonly runtimeBootId = Math.random().toString(36).slice(2, 10);
  private runtimeDebugSnapshotErrorLogged = false;
  private fixedTickMode = false;
  /** 主 ticker 与启动直达路由均已落地后才开放自动化命令，防启动场景覆盖测试场景。 */
  private runtimeReady = false;
  private runtimeCommandPollErrorLogged = false;
  private lastRuntimeCommandResults: { id: string; type: string; ok: boolean; message: string }[] = [];

  private registeredSystems: { name: string; system: IGameSystem }[] = [];
  private boundCallbacks: { event: string; fn: (...args: any[]) => void }[] = [];
  private boundWindowListeners: { event: string; fn: EventListener }[] = [];
  private unsubRendererResize: (() => void) | null = null;
  /** 避免 beforeunload 与 pagehide 接连触发时重复销毁（第二次会踩已 teardown 的 Pixi Application） */
  private tearDownComplete = false;
  private isDevMode = false;
  /** ?smellDebug 安装的 window 全局键（destroy 时清除，见 start 内安装处） */
  private smellDebugGlobalKeys: string[] = [];
  private devModeUI: DevModeUI | null = null;
  private touchMobileControls: TouchMobileControls | null = null;
  /** `overlay_images.json`：可写短 id，避免 action 参数里塞长路径 */
  private overlayImageRegistry: Record<string, string> = {};

  private gameConfig: GameConfig = {
    initialScene: '',
    initialQuest: '',
    fallbackScene: '',
    playerAvatar: {
      animManifest: '/resources/runtime/animation/player_anim/anim.json',
      stateMap: {},
    },
    entityPixelDensityMatch: true,
    entityPixelDensityMatchBlurScale: DEFAULT_ENTITY_PIXEL_DENSITY_BLUR_SCALE,
  };

  constructor() {
    this.eventBus = new EventBus();
    if (import.meta.env.DEV) this.eventBus.enableDebugTrace();
    this.flagStore = new FlagStore(this.eventBus);
    this.stringsProvider = new StringsProvider();
    this.inputManager = new InputManager();
    this.assetManager = new AssetManager();
    this.stateController = new GameStateController(this.inputManager, this.eventBus);
    this.actionExecutor = new ActionExecutor(this.eventBus, this.flagStore, this.stateController);
    this.ruleOfferRegistry = new RuleOfferRegistry();
    this.renderer = new Renderer();
    this.renderer.setAssetManager(this.assetManager);
    this.camera = new Camera(this.renderer.worldContainer);
    this.player = new Player(this.inputManager);
    this.interactionSystem = new InteractionSystem(this.eventBus, this.flagStore, this.inputManager);
    this.sceneManager = new SceneManager(this.assetManager, this.eventBus, this.renderer);
    this.inventoryManager = new InventoryManager(this.eventBus, this.flagStore);
    this.rulesManager = new RulesManager(this.eventBus, this.flagStore);
    this.dialogueManager = new DialogueManager(this.eventBus);
    this.questManager = new QuestManager(this.eventBus, this.flagStore, this.actionExecutor);
    this.scenarioStateManager = new ScenarioStateManager();
    this.narrativeStateManager = new NarrativeStateManager(this.eventBus, this.flagStore, this.actionExecutor);
    this.graphDialogueManager = new GraphDialogueManager(
      this.eventBus,
      this.flagStore,
      this.actionExecutor,
      this.assetManager,
      this.sceneManager,
      this.rulesManager,
      this.questManager,
      this.inventoryManager,
      this.scenarioStateManager,
    );
    // 主角头像跟「当前生效装扮配置」走（与 NPC 的 currentPortraitSlug 同构）
    this.graphDialogueManager.setPlayerPortraitSlugProvider(() => this.currentPlayerPortraitSlug);
    this.documentRevealManager = new DocumentRevealManager(
      this.assetManager,
      this.eventBus,
      this.flagStore,
      this.questManager,
      this.scenarioStateManager,
    );
    this.encounterManager = new EncounterManager(this.eventBus, this.flagStore, this.actionExecutor);
    this.audioManager = new AudioManager(this.eventBus);
    this.dayManager = new DayManager(this.eventBus, this.flagStore, this.actionExecutor);
    this.waterMinigameManager = new WaterMinigameManager();
    this.sugarWheelMinigameManager = new SugarWheelMinigameManager();
    this.paperCraftMinigameManager = new PaperCraftMinigameManager();
    this.pressureHoldManager = new PressureHoldManager(this.actionExecutor);
    this.signalCueManager = new SignalCueManager(this.actionExecutor);
    this.healthSystem = new HealthSystem(this.eventBus, this.flagStore, this.actionExecutor);
    this.smellSystem = new SmellSystem(this.eventBus, this.flagStore);
    this.planeReconciler = new PlaneReconciler(this.eventBus);
    this.archiveManager = new ArchiveManager(this.eventBus, this.flagStore);
    this.emoteBubbleManager = new EmoteBubbleManager();
    this.zoneSystem = new ZoneSystem(this.eventBus, this.flagStore, this.actionExecutor, this.ruleOfferRegistry);
    this.sceneDepthSystem = new SceneDepthSystem();

    const ctx = { eventBus: this.eventBus, flagStore: this.flagStore, strings: this.stringsProvider, assetManager: this.assetManager };
    this.registeredSystems = [
      { name: 'sceneManager', system: this.sceneManager },
      { name: 'interactionSystem', system: this.interactionSystem },
      { name: 'dialogueManager', system: this.dialogueManager },
      { name: 'graphDialogueManager', system: this.graphDialogueManager },
      { name: 'inventoryManager', system: this.inventoryManager },
      { name: 'rulesManager', system: this.rulesManager },
      { name: 'questManager', system: this.questManager },
      { name: 'scenarioStateManager', system: this.scenarioStateManager },
      { name: 'narrativeStateManager', system: this.narrativeStateManager },
      // 位面对账器排在叙事之后：deserialize 时叙事激活态已恢复，可立即重派生激活位面。
      { name: 'planeReconciler', system: this.planeReconciler },
      { name: 'documentRevealManager', system: this.documentRevealManager },
      { name: 'encounterManager', system: this.encounterManager },
      { name: 'audioManager', system: this.audioManager },
      { name: 'dayManager', system: this.dayManager },
      { name: 'waterMinigameManager', system: this.waterMinigameManager },
      { name: 'sugarWheelMinigameManager', system: this.sugarWheelMinigameManager },
      { name: 'paperCraftMinigameManager', system: this.paperCraftMinigameManager },
      { name: 'pressureHoldManager', system: this.pressureHoldManager },
      { name: 'signalCueManager', system: this.signalCueManager },
      { name: 'healthSystem', system: this.healthSystem },
      { name: 'smellSystem', system: this.smellSystem },
      { name: 'cutsceneManager', system: null as any },
      { name: 'archiveManager', system: this.archiveManager },
      { name: 'zoneSystem', system: this.zoneSystem },
      { name: 'emoteBubbleManager', system: this.emoteBubbleManager },
      { name: 'sceneDepthSystem', system: this.sceneDepthSystem },
    ];
    for (const entry of this.registeredSystems) {
      if (entry.system) entry.system.init(ctx);
    }
  }

  private buildResolveContext(): ResolveContext {
    const strings = this.stringsProvider;
    return {
      stringsRaw: (c, k) => strings.getRaw(c, k),
      flagStore: this.flagStore,
      itemNames: this.archiveManager.getItemDisplayNames(),
      npcName: (id) => {
        const t = id.trim();
        if (!t) return undefined;
        const live = this.sceneManager.getNpcById(t);
        if (live) return live.def.name;
        return this.npcDisplayNameById.get(t);
      },
      contextNpcId: this.graphDialogueManager.getContextNpcId(),
      playerDisplayName: () => {
        const v = this.flagStore.get('player_display_name');
        if (typeof v === 'string' && v.trim()) return v.trim();
        const fb = strings.getRaw('dialogue', 'defaultProtagonistName');
        return fb && fb !== 'defaultProtagonistName' ? fb : '你';
      },
      questTitle: (id) => this.questManager.getQuestTitle(id),
      ruleName: (id) => this.rulesManager.getRuleDef(id)?.name,
      sceneDisplayName: (sid) => {
        const t = sid.trim();
        return this.sceneDisplayNameById.get(t) ?? t;
      },
    };
  }

  /** 统一解析 JSON / strings 模板中的 [tag:…]（供 Action、UI、档案等共用） */
  resolveDisplayText(raw: string | undefined): string {
    return resolveText(raw, this.buildResolveContext());
  }

  /**
   * `playScriptedDialogue` 专用：`[tag:npc:@context]` 在无图对白上下文时使用 `params.scriptedNpcId`，
   * 若在图对话 `runActions` 内则仍优先当前图的 npcId。
   */
  resolveDisplayTextForPlayScripted(raw: string | undefined, scriptedNpcId?: string): string {
    const base = this.buildResolveContext();
    const graphNpc = base.contextNpcId?.trim();
    const scripted = scriptedNpcId?.trim();
    const ctx: ResolveContext = {
      ...base,
      contextNpcId: graphNpc || scripted || undefined,
    };
    return resolveText(raw ?? '', ctx);
  }

  /**
   * `playScriptedDialogue` 逐行的头像 + 说话实体解析（与图对话 {@link GraphDialogueManager.resolvePortrait} 同语义）：
   * - speakerEntity：由 speaker 字段占位（`{{player}}` / `{{npc[:id]}}`）推导，供「…」气泡定位与头像跟随；
   * - portrait：显式 slug 原样用；仅带 emotion 时跟随 speakerEntity（player→当前装扮立绘集、npc→场景 NPC 的 portraitSlug），解析不到则本行不显头像。
   */
  private resolveScriptedLineExtras(
    rawSpeaker: string,
    portraitRef: DialoguePortraitRef | undefined,
    scriptedNpcId: string,
  ): { portrait?: DialoguePortraitRef; speakerEntity?: DialogueLine['speakerEntity'] } {
    const entity = resolveScriptedSpeakerEntity(rawSpeaker, {
      graphDialogueNpcId: this.graphDialogueManager.getContextNpcId(),
      fallbackNpcId: scriptedNpcId,
    });
    return { portrait: this.resolveScriptedPortrait(portraitRef, entity), speakerEntity: entity };
  }

  private resolveScriptedPortrait(
    ref: DialoguePortraitRef | undefined,
    entity: ScriptedSpeakerEntity | undefined,
  ): DialoguePortraitRef | undefined {
    if (!ref || !ref.emotion) return undefined;
    const slug = ref.slug?.trim();
    if (slug) return { slug, emotion: ref.emotion };
    if (!entity) return undefined;
    if (entity.kind === 'player') {
      const p = this.currentPlayerPortraitSlug?.trim();
      return p ? { slug: p, emotion: ref.emotion } : undefined;
    }
    const npcSlug = this.sceneManager.getNpcById(entity.npcId)?.currentPortraitSlug;
    return npcSlug ? { slug: npcSlug, emotion: ref.emotion } : undefined;
  }

  /**
   * showEmote / showSpeechBubble / showEmoteAndWait / showSpeechBubbleAndWait / showSubtitle.subtitleEmote 共用：resolveActor 未命中时再匹配当前场景热点 id。
   */
  private resolveEmoteTarget(raw: string): IEmoteBubbleAnchor | null {
    const id = String(raw ?? '').trim();
    const log = (m: string) => this.debugPanelUI?.log(`[emote/target] ${m}`);
    if (!id) {
      log('目标 id 为空');
      return null;
    }
    const actor = this.resolveActorFn(id);
    if (actor) {
      log(`命中 resolveActor entityId=${JSON.stringify(actor.entityId)}`);
      return actor;
    }
    const scene = this.sceneManager.currentSceneData?.id ?? '';
    const hs = this.sceneManager.getCurrentHotspots();
    const enumerate = hs
      .slice(0, 40)
      .map((h) => {
        const hid = h.def.id;
        const key = `${JSON.stringify(hid)}`;
        return String(hid ?? '').trim() === id ? `${key}⇐match` : key;
      })
      .join(', ');
    log(
      `resolveActor 未命中 scene=${scene || '(?)'} ` +
      `热点数=${hs.length}${hs.length > 40 ? `（以下仅列前40个 id）` : ''}：[${enumerate}]`,
    );
    const h = hs.find((x) => String(x.def.id ?? '').trim() === id);
    if (!h) {
      log(`仍未匹配 query=${JSON.stringify(id)}`);
      return null;
    }
    log(
      `命中热点: def.id=${JSON.stringify(h.def.id)} active=${h.active} ` +
      `container.visible=${h.container.visible} ` +
      `parent=${h.container.parent ? 'yes' : 'no'} y=${Math.round(h.container.y)}`,
    );
    return h;
  }

  private async refreshTextResolveLookups(): Promise<void> {
    this.sceneDisplayNameById.clear();
    try {
      const mapConfig = await this.assetManager.loadJson<MapNodeDef[] | MapConfigFile>(TEXT_URLS.mapConfig);
      const nodes = Array.isArray(mapConfig) ? mapConfig : (Array.isArray(mapConfig.nodes) ? mapConfig.nodes : []);
      for (const n of nodes) {
        if (n.sceneId) this.sceneDisplayNameById.set(n.sceneId, n.name);
      }
    } catch {
      /* no map */
    }

    this.npcDisplayNameById.clear();
    const sceneIds = new Set<string>();
    for (const sid of this.sceneDisplayNameById.keys()) sceneIds.add(sid);
    if (this.gameConfig.initialScene) sceneIds.add(this.gameConfig.initialScene);
    if (this.gameConfig.fallbackScene) sceneIds.add(this.gameConfig.fallbackScene);

    await Promise.all(
      [...sceneIds].map(async (sid) => {
        try {
          const raw = await this.assetManager.loadJson<{ npcs?: { id: string; name: string }[] }>(
            sceneJsonUrl(sid),
          );
          for (const npc of raw.npcs ?? []) {
            if (npc?.id) this.npcDisplayNameById.set(npc.id, npc.name ?? npc.id);
          }
        } catch {
          /* missing scene */
        }
      }),
    );
  }

  private wireTextResolve(): void {
    const fn = (s: string) => this.resolveDisplayText(s);
    this.stringsProvider.setResolveDisplay(fn);
    this.actionExecutor.setResolveNotificationText(fn);
    this.graphDialogueManager.setResolveDisplay(fn);
    this.documentRevealManager.setResolveConditionLiteral(fn);
    this.encounterManager.setResolveDisplay(fn);
    this.archiveManager.setResolveForDisplay((raw) => this.resolveDisplayText(raw));
    this.inspectBox.setResolveDisplay(fn);
    this.shopUI.setResolveDisplay(fn);
    this.mapUI.setResolveDisplay(fn);
    this.questPanelUI.setResolveDisplay(fn);
    this.rulesPanelUI.setResolveDisplay(fn);
    this.inventoryUI.setResolveDisplay(fn);
    this.cutsceneRenderer.setResolveDisplay(fn);
    const narrKey = this.stringsProvider.get('dialogue', 'narratorLabel');
    const narratorFallback = narrKey && narrKey !== 'narratorLabel' ? narrKey : '旁白';
    this.cutsceneManager.setColonSpeakerNarratorBaselineResolved(this.resolveDisplayText(narratorFallback));
    this.cutsceneManager.setDisplayTextResolver(fn);
    this.hud.setResolveDisplay(fn);
    this.ruleUseUI.setResolveDisplay(fn);
  }

  async start(options: GameStartOptions = {}): Promise<void> {
    this.isDevMode = !!options.devMode;
    await this.renderer.init(options.visualCapture ? { resolution: 1 } : undefined);
    /** P3：start 期间被 destroy（HMR / 秒关页）后不再继续装配，各主要 await 后同样早退 */
    if (this.tearDownComplete) return;
    this.emoteBubbleManager.setEntityAttachLayer(this.renderer.entityLayer);

    await this.stringsProvider.load(this.assetManager);

    await this.loadGameConfig();
    if (this.tearDownComplete) return;
    if (this.gameConfig.windowSize) {
      this.renderer.setWindowSize(this.gameConfig.windowSize.width, this.gameConfig.windowSize.height);
    }
    if (this.gameConfig.viewport) {
      this.renderer.setViewportSize(this.gameConfig.viewport.width, this.gameConfig.viewport.height);
    }
    /** game_config.health → HealthSystem：构造期 init 已按默认配置执行；configure 后按
     *  IGameSystem「重 init 与首次一致」契约重跑 init 套用上限/阈值（此时尚无伤害与存档写入）。 */
    if (this.gameConfig.health) {
      this.healthSystem.configure(this.gameConfig.health);
      this.healthSystem.init({
        eventBus: this.eventBus,
        flagStore: this.flagStore,
        strings: this.stringsProvider,
        assetManager: this.assetManager,
      });
    }

    this.inspectBox = new InspectBox(this.renderer, this.stringsProvider);
    this.pickupNotification = new PickupNotification(this.renderer, this.stringsProvider);
    this.dialogueUI = new DialogueUI(this.renderer, this.eventBus, this.stringsProvider, this.assetManager);
    // 说话中「…」气泡：当前行说话实体头顶挂常驻气泡（与对话大头像并存指示说话对象），
    // 换行随说话人移动、旁白无实体则收起、对话结束即撤。
    const SPEAKING_BUBBLE_OWNER = 'dialogue-speaking';
    this.eventBus.on('dialogue:line', (line: DialogueLine) => {
      this.emoteBubbleManager.cleanupByOwner(SPEAKING_BUBBLE_OWNER);
      const se = line.speakerEntity;
      if (!se) return;
      const anchor = se.kind === 'player' ? this.player : this.sceneManager.getNpcById(se.npcId);
      if (!anchor) return;
      this.emoteBubbleManager.showSticky(anchor, '……', undefined, SPEAKING_BUBBLE_OWNER);
    });
    const clearSpeakingBubble = () => this.emoteBubbleManager.cleanupByOwner(SPEAKING_BUBBLE_OWNER);
    this.eventBus.on('dialogue:end', clearSpeakingBubble);
    this.eventBus.on('dialogue:hidePanel', clearSpeakingBubble);
    this.encounterUI = new EncounterUI(this.renderer, this.eventBus, this.stringsProvider);
    this.actionChoiceUI = new ActionChoiceUI(this.renderer, this.stringsProvider);
    this.pressureHoldUI = new PressureHoldUI(this.renderer, this.stringsProvider);
    this.hud = new HUD(this.renderer, this.eventBus, this.stringsProvider);
    this.notificationUI = new NotificationUI(this.renderer, this.eventBus);
    this.questPanelUI = new QuestPanelUI(this.renderer, this.questManager, this.stringsProvider);
    this.inventoryUI = new InventoryUI(this.renderer, this.eventBus, this.inventoryManager, this.stringsProvider);
    this.rulesPanelUI = new RulesPanelUI(this.renderer, this.rulesManager, this.stringsProvider);
    this.dialogueLogUI = new DialogueLogUI(this.renderer, this.eventBus, this.stringsProvider);
    this.bookReaderUI = new BookReaderUI(this.renderer, this.archiveManager, this.stringsProvider, this.assetManager);
    this.bookshelfUI = new BookshelfUI(
      this.renderer,
      this.archiveManager,
      () => {
        this.stateController.restorePreviousState();
        this.stateController.togglePanel('rules');
      },
      (book, onClose) => {
        this.bookReaderUI.openBook(book, onClose);
        return this.bookReaderUI;
      },
      (onClose) => { const s = new CharacterBookUI(this.renderer, this.archiveManager, onClose, this.stringsProvider, this.assetManager); s.open(); return s; },
      (onClose) => { const s = new LoreBookUI(this.renderer, this.archiveManager, onClose, this.stringsProvider, this.assetManager); s.open(); return s; },
      (onClose) => { const s = new DocumentBoxUI(this.renderer, this.archiveManager, onClose, this.stringsProvider, this.assetManager); s.open(); return s; },
      this.stringsProvider,
    );
    this.shopUI = new ShopUI(this.renderer, this.eventBus, this.inventoryManager, this.stringsProvider, this.assetManager);
    this.mapUI = new MapUI(this.renderer, this.eventBus, this.flagStore, this.stringsProvider, this.assetManager);

    this.cutsceneRenderer = new CutsceneRenderer(this.renderer, this.camera, this.assetManager);
    this.cutsceneManager = new CutsceneManager(
      this.eventBus, this.flagStore, this.actionExecutor,
      this.cutsceneRenderer,
    );
    this.cutsceneManager.init({ eventBus: this.eventBus, flagStore: this.flagStore, strings: this.stringsProvider, assetManager: this.assetManager });
    this.cutsceneManager.setInputManager(this.inputManager);
    this.cutsceneManager.setAudioManager(this.audioManager);
    const cmEntry = this.registeredSystems.find(e => e.name === 'cutsceneManager');
    if (cmEntry) cmEntry.system = this.cutsceneManager;
    /**
     * 唯一 resolveActor 入口。查询顺序：
     *   1. CutsceneManager 临时表（_cut_ 前缀）
     *   2. 场景 NPC（sceneManager.getNpcById）
     *   3. player（id === 'player'）
     * 对话、热区、过场、Timeline、移动/朝向等共用此实例。
     * showEmote 另见 resolveEmoteTarget：在以上结果之外可解析当前场景热点 id。
     */
    this.resolveActorFn = (id: string) => {
      const temp = this.cutsceneManager.getTempActors().get(id);
      if (temp) return temp;
      const npc = this.sceneManager.getNpcById(id);
      if (npc) return npc;
      if (id === 'player') return this.player;
      return null;
    };
    this.cutsceneManager.setEntityResolver(this.resolveActorFn);
    this.cutsceneManager.setEmoteBubbleProvider(this.emoteBubbleManager);
    this.cutsceneManager.setEmoteTargetResolver((raw) => this.resolveEmoteTarget(raw));
    this.cutsceneManager.setSceneSwitcher(async (params) => {
      this.pickupNotification.forceCleanup();
      if (this.inspectBox.isOpen) this.inspectBox.close();
      const cameraPos = typeof params.cameraX === 'number' && typeof params.cameraY === 'number'
        ? { x: params.cameraX, y: params.cameraY }
        : undefined;
      await this.sceneManager.switchScene(
        params.targetScene,
        params.targetSpawnPoint,
        cameraPos,
      );
    });
    this.cutsceneManager.setSceneIdGetter(() => this.sceneManager.currentSceneData?.id ?? null);
    this.cutsceneManager.setPlayerPositionGetter(() => ({ x: this.player.x, y: this.player.y }));
    this.cutsceneManager.setPlayerPositionSetter((x, y) => { this.player.x = x; this.player.y = y; });
    this.cutsceneManager.setCameraAccessor(this.camera);
    this.cutsceneManager.setSceneManager(this.sceneManager);
    this.cutsceneManager.setSpawnPointResolver((spawnKey: string) => {
      const scene = this.sceneManager.currentSceneData;
      if (!scene) return null;
      if (!spawnKey) return scene.spawnPoint ?? null;
      return scene.spawnPoints?.[spawnKey] ?? null;
    });
    this.cutsceneManager.setScriptedSpeakerResolver((raw, scriptedNpcId) =>
      resolveScriptedSpeakerDisplay(raw, {
        strings: this.stringsProvider,
        flagStore: this.flagStore,
        sceneManager: this.sceneManager,
        graphDialogueNpcId: this.graphDialogueManager.getContextNpcId(),
        fallbackNpcId: scriptedNpcId ?? '',
      }),
    );
    this.saveManager = new SaveManager(
      () => this.collectSaveData(),
      (data) => this.distributeSaveData(data),
      // 读档专用重载（含失败回滚路径）：先静默撤下旧场景活跃 zone——distribute 已把全系统
      // 覆盖为存档时间线，旧时间线 zone 的 onExit 异步批不得再污染恢复后的状态。
      // 只挂在 SaveManager 这条线上：F2 调试重载与其它 reloadScene 调用方语义不变。
      (sceneId) => {
        this.zoneSystem.clearActiveZonesForRestore();
        return this.reloadScene(sceneId);
      },
      this.stringsProvider,
      this.gameConfig.fallbackScene,
    );
    // 仅在探索 / UI 覆盖层（暂停菜单打开）可存档；对话/遭遇/演出/小游戏等在途态拒绝存档，
    // 避免半态存档（这些系统不持久化在途状态，读档会丢失或半执行）。
    this.saveManager.setCanSavePredicate(() => {
      const s = this.stateController.currentState;
      return s === GameState.Exploring || s === GameState.UIOverlay;
    });
    this.menuUI = new MenuUI(this.renderer, this.eventBus, this.saveManager, this.audioManager, this.stringsProvider);
    this.ruleUseUI = new RuleUseUI(this.renderer, this.eventBus, this.zoneSystem, this.rulesManager, this.stringsProvider);
    this.debugPanelUI = new DebugPanelUI(
      () => ({
        fps: this.lastFps,
        sceneId: this.sceneManager.currentSceneData?.id ?? undefined,
        state: this.stateController.currentState,
        worldWidth: this.sceneManager.currentSceneData?.worldWidth,
        worldHeight: this.sceneManager.currentSceneData?.worldHeight,
        depthOcclusionEnabled: this.sceneDepthSystem.isEnabled,
        floorOffsetRuntime: this.sceneDepthSystem.isEnabled
          ? this.sceneDepthSystem.floorOffset
          : undefined,
        floorOffsetFromScene: this.sceneDepthSystem.currentConfig?.floor_offset,
        smell: (() => {
          const ds = this.smellSystem.getDebugState();
          return {
            source: ds.source,
            actionScent: ds.action.scent,
            actionIntensity: ds.action.intensity,
            zoneScent: ds.zone.scent,
            zoneIntensity: ds.zone.intensity,
            effectiveScent: ds.effective.scent,
          };
        })(),
      }),
      this.inputManager,
    );
    this.emoteBubbleManager.setDebugPanelLog((msg) => {
      this.debugPanelUI?.log(msg);
    });

    this.camera.setScreenSize(this.renderer.screenWidth, this.renderer.screenHeight);
    this.unsubRendererResize = this.renderer.subscribeAfterResize(() => {
      if (this.tearDownComplete) return;
      this.camera.setScreenSize(this.renderer.screenWidth, this.renderer.screenHeight);
    });
    this.addWindowListener('resize', () => {
      if (this.tearDownComplete) return;
      this.camera.setScreenSize(this.renderer.screenWidth, this.renderer.screenHeight);
    });

    this.setupSceneManager();
    this.registerUIPanels();

    this.encounterManager.setRuleNameResolver((ruleId) => {
      const def = this.rulesManager.getRuleDef(ruleId);
      if (!def) return undefined;
      return { name: def.name, incompleteName: def.incompleteName };
    });

    /** B8：条件上下文工厂必须先于 narrativeStateManager.loadFromAsset 注入——
     *  加载即触发 reactive 求值，晚注入会导致开机首轮全部 missing-ctx 判 false。 */
    const mkCondCtx = (): ConditionEvalContext => this.buildConditionEvalContext();
    this.flagStore.setConditionEvalContextFactory(mkCondCtx);
    this.questManager.setConditionEvalContextFactory(mkCondCtx);
    this.zoneSystem.setConditionEvalContextFactory(mkCondCtx);
    this.interactionSystem.setConditionEvalContextFactory(mkCondCtx);
    this.interactionSystem.setEntityBaseVisibilityReaders(
      (h) => this.sceneManager.getHotspotBaseEnabledForInteraction(h),
      (n) => this.sceneManager.getNpcBaseVisibleForInteraction(n),
    );
    this.encounterManager.setConditionEvalContextFactory(mkCondCtx);
    this.mapUI.setConditionEvalContextFactory(mkCondCtx);
    this.archiveManager.setConditionEvalContextFactory(mkCondCtx);
    this.inventoryManager.setConditionEvalContextFactory(mkCondCtx);
    this.graphDialogueManager.setConditionEvalContextFactory(mkCondCtx);
    this.documentRevealManager.setConditionEvalContextFactory(mkCondCtx);
    this.narrativeStateManager.setConditionEvalContextFactory(mkCondCtx);

    // 位面对账器接线须先于 narrativeStateManager.loadFromAsset——注册图时的 reactive
    // 迁移会立即发 narrative:stateChanged，晚接线会漏掉首轮点名（scene:ready 虽兜底，
    // 但装载期 zone 过滤已按激活位面取值）。
    this.planeReconciler.bindRuntime({
      narrative: {
        getGraphs: () => this.narrativeStateManager.getGraphs(),
        getActiveState: (graphId) => this.narrativeStateManager.getActiveState(graphId),
      },
      setPlayerMovementModifier: (fn) => this.player.setMovementModifier(fn),
      setPlaneInteractionPolicy: (fn) => this.interactionSystem.setPlaneInteractionPolicy(fn),
      refreshEntitiesForPlaneChange: () => {
        const sid = this.sceneManager.currentSceneData?.id;
        if (sid) this.sceneManager.refreshEntitiesForPlaneChange(sid);
      },
      refreshZonesForPlaneChange: () => {
        const sid = this.sceneManager.currentSceneData?.id;
        if (sid) this.sceneManager.refreshZonesForPlaneChange(sid);
      },
      setCameraZoom: (z) => this.camera.setZoom(z),
      restoreSceneCameraZoom: () => {
        // 对账器在"离开位面"时调，此刻激活位面已切走 → 基线即场景 zoom；用统一基线口保持一致。
        this.camera.setZoom(this.getCameraBaselineZoom());
      },
      applyPlaneLightEnvOverride: (partial) => this.applyPlaneLightEnvOverride(partial),
      damagePlayer: (amount) => this.healthSystem.damage(amount),
      getGameState: () => this.stateController.currentState,
    });
    this.sceneManager.setActivePlaneGetter(() => ({
      id: this.planeReconciler.getActivePlaneId(),
      membership: this.planeReconciler.getActivePlaneMembership(),
    }));

    this.documentRevealManager.setBlendExecutor((id, from, to, x, y, w, dur, delay) =>
      this.cutsceneManager.blendOverlayImage(id, from, to, x, y, w, dur, delay));
    await this.documentRevealManager.loadDefinitions();
    try {
      const scenarioCat = await this.assetManager.loadJson<ScenarioCatalogFile>(TEXT_URLS.scenarios);
      this.scenarioStateManager.configureRuntime(this.flagStore, scenarioCat, this.eventBus);
    } catch {
      this.scenarioStateManager.configureRuntime(this.flagStore, null, this.eventBus);
    }
    await this.narrativeStateManager.loadFromAsset(this.assetManager);
    if (this.tearDownComplete) return;

    registerActionHandlers(this.actionExecutor, {
      randomValue: () => this.runtimeRandom.next(),
      resolveScriptedSpeaker: (raw, scriptedNpcId) =>
        resolveScriptedSpeakerDisplay(raw, {
          strings: this.stringsProvider,
          flagStore: this.flagStore,
          sceneManager: this.sceneManager,
          graphDialogueNpcId: this.graphDialogueManager.getContextNpcId(),
          fallbackNpcId: scriptedNpcId ?? '',
        }),
      resolveScriptedLineExtras: (rawSpeaker, portraitRef, scriptedNpcId) =>
        this.resolveScriptedLineExtras(rawSpeaker, portraitRef, scriptedNpcId ?? ''),
      ruleOfferRegistry: this.ruleOfferRegistry,
      inventoryManager: this.inventoryManager,
      rulesManager: this.rulesManager,
      questManager: this.questManager,
      encounterManager: this.encounterManager,
      audioManager: this.audioManager,
      dayManager: this.dayManager,
      archiveManager: this.archiveManager,
      cutsceneManager: this.cutsceneManager,
      sceneManager: this.sceneManager,
      emoteBubbleManager: this.emoteBubbleManager,
      stateController: this.stateController,
      stringsProvider: this.stringsProvider,
      eventBus: this.eventBus,
      resolveActor: this.resolveActorFn,
      resolveEmoteTarget: (raw: string) => this.resolveEmoteTarget(raw),
      debugPanelLog: (msg) => this.debugPanelUI?.log(msg),
      pickupNotification: this.pickupNotification,
      inspectBox: this.inspectBox,
      shopUI: this.shopUI,
      applyPlayerAvatar: (path, sm, ps) => this.applyPlayerAvatarFromAction(path, sm, ps),
      resetPlayerAvatar: () => this.resetPlayerAvatarFromAction(),
      setSceneDepthFloorOffset: (v) => { this.sceneDepthSystem.floorOffset = v; },
      resetSceneDepthFloorOffset: () => {
        const cfg = this.sceneDepthSystem.currentConfig;
        this.sceneDepthSystem.floorOffset = cfg?.floor_offset ?? 0;
      },
      setCameraZoom: (z) => { this.camera.setZoom(z); },
      restoreSceneCameraZoom: () => {
        // 基线=位面相机档(激活时) ?? 场景 zoom：对话/演出收尾恢复到位面态该有的值，不盖掉位面档。
        this.camera.setZoom(this.getCameraBaselineZoom());
      },
      fadingRestoreSceneCameraZoom: (durationMs) => {
        return this.cutsceneManager.fadingCameraZoom(this.getCameraBaselineZoom(), durationMs);
      },
      stopNpcPatrol: (npcId) => {
        this.stopNpcPatrol(npcId);
      },
      startNpcPatrol: (npcId) => {
        this.startNpcPatrolForNpc(npcId);
      },
      showOverlayImage: (id, image, xPct, yPct, wPct) =>
        this.cutsceneManager.showOverlayImage(id, image, xPct, yPct, wPct),
      resolveOverlayImagePath: (img) => this.resolveOverlayImageIdToPath(img),
      hideOverlayImage: (id) => {
        this.cutsceneManager.hideOverlayImage(id);
      },
      blendOverlayImage: (id, fromPath, toPath, xPct, yPct, wPct, durationMs, delayMs) =>
        this.cutsceneManager.blendOverlayImage(id, fromPath, toPath, xPct, yPct, wPct, durationMs, delayMs),
      startDialogueGraph: async (graphId, entry, npcId, ownerType, ownerId, dimBackground) => {
        this.stateController.setState(GameState.Dialogue);
        try {
          let npcName = '';
          const npcIdTrim = npcId?.trim() || '';
          if (npcIdTrim) {
            const npc = this.sceneManager.getNpcById(npcIdTrim);
            if (npc) npcName = npc.def.name;
          }
          // owner 优先级：显式参数 > npcId（NPC 上下文）> onEnter 期间的隐式场景 owner。
          const ambient = this.ambientNarrativeOwner;
          const ownerTypeTrim =
            ownerType?.trim() || (npcIdTrim ? 'npc' : '') || (ambient?.ownerType ?? '');
          const ownerIdTrim = ownerId?.trim() || npcIdTrim || (ambient?.ownerId ?? '');
          await this.graphDialogueManager.startDialogueGraph({
            graphId,
            entry,
            npcName,
            npcId: npcIdTrim || undefined,
            ownerType: ownerTypeTrim || undefined,
            ownerId: ownerIdTrim || undefined,
            dimBackground: dimBackground === true,
          });
          /** R6：图同步完结但 deferred 链式接续图正在启动时（hasPendingChainContinuation）
           *  会话未终结，不得提前恢复 Exploring——状态恢复交给最终 dialogue:end / EventBridge */
          if (
            !this.graphDialogueManager.isActive &&
            !this.graphDialogueManager.hasPendingChainContinuation
          ) {
            this.stateController.setState(GameState.Exploring);
          }
        } catch (e) {
          console.warn('Game: startDialogueGraph failed', e);
          this.stateController.setState(GameState.Exploring);
        }
      },
      playScriptedDialogue: (lines) => {
        /** P3 协议死锁兜底：空 lines 时 DialogueManager 不发任何事件，挂起等待即永久悬死 */
        if (!lines.length) {
          console.warn('Game: playScriptedDialogue 收到空 lines，跳过');
          return Promise.resolve();
        }
        /** 嵌套判定在 start 前采样：图对话活跃时本段脚本台词属嵌套段（R5，见 DialogueEndPayload） */
        const nestedInGraph = this.graphDialogueManager.isActive;
        this.stateController.setState(GameState.Dialogue);
        return new Promise<void>((resolve) => {
          const onEnd = (p?: DialogueEndPayload) => {
            /** R5：只认脚本台词自身的结束；嵌套于图对话时，图的 dialogue:end 不得提前解锁本动作 */
            if (p?.source !== 'scripted') return;
            this.eventBus.off('dialogue:end', onEnd);
            resolve();
          };
          this.eventBus.on('dialogue:end', onEnd);
          this.dialogueManager.startScriptedDialogue(lines, nestedInGraph);
        });
      },
      waitClickContinue: (hintOverride) => {
        const label = hintOverride?.trim()
          ? hintOverride.trim()
          : this.stringsProvider.get('actions', 'clickToContinue');
        return waitClickContinueWithHint(this.renderer, this.inputManager, label);
      },
      scenarioStateManager: this.scenarioStateManager,
      narrativeStateManager: this.narrativeStateManager,
      documentRevealManager: this.documentRevealManager,
      spawnCutsceneActor: (id, name, x, y) => {
        this.cutsceneManager.spawnTempActor(id, name, x, y);
      },
      removeCutsceneActor: (id) => {
        this.cutsceneManager.removeTempActor(id);
      },
      setSceneEntityField: (sceneId, kind, entityId, fieldName, value) =>
        this.setSceneEntityFieldFromAction(sceneId, kind, entityId, fieldName, value),
      setHotspotDisplayImage: (sceneId, hotspotId, imagePath, worldWidth, worldHeight, facing) =>
        this.setHotspotDisplayImageFromAction(
          sceneId,
          hotspotId,
          imagePath,
          worldWidth,
          worldHeight,
          facing,
        ),
      tempSetHotspotDisplayFacing: (sceneId, hotspotId, facing) =>
        this.tempSetHotspotDisplayFacingFromAction(sceneId, hotspotId, facing),
      resolveDisplayText: (raw) => this.resolveDisplayText(raw),
      chooseAction: (prompt, options, allowCancel) =>
        this.actionChoiceUI.choose(prompt, options, allowCancel),
      resolveDisplayTextForPlayScripted: (raw, sid) =>
        this.resolveDisplayTextForPlayScripted(raw, sid),
      waterMinigameManager: this.waterMinigameManager,
      sugarWheelMinigameManager: this.sugarWheelMinigameManager,
      paperCraftMinigameManager: this.paperCraftMinigameManager,
      pressureHoldManager: this.pressureHoldManager,
      signalCueManager: this.signalCueManager,
      healthSystem: this.healthSystem,
      smellSystem: this.smellSystem,
      planeReconciler: this.planeReconciler,
    });

    /** D1：DEV 下对照 actionParamManifest 与 executor 实际注册互查，防三方参数表再漂移 */
    if (import.meta.env.DEV) {
      for (const msg of auditActionRegistrationsAgainstManifest(this.actionExecutor)) {
        console.warn(`[actionParamManifest 漂移] ${msg}`);
      }
    }

    this.pressureHoldManager.bindRuntime({
      resolveDisplayText: (s) => this.resolveDisplayText(s),
      runSegment: async (req) => {
        const prevState = this.stateController.currentState;
        this.stateController.setState(GameState.UIOverlay);
        try {
          return await this.pressureHoldUI.runSegment(req);
        } finally {
          if (this.stateController.currentState === GameState.UIOverlay) {
            this.stateController.setState(prevState);
          }
        }
      },
    });

    this.waterMinigameManager.bindRuntime({
      renderer: this.renderer,
      inputManager: this.inputManager,
      stateController: this.stateController,
      actionExecutor: this.actionExecutor,
      dayManager: this.dayManager,
      resolveDisplayText: (s) => this.resolveDisplayText(s),
    });
    await this.waterMinigameManager.loadIndex();

    this.sugarWheelMinigameManager.bindRuntime({
      renderer: this.renderer,
      inputManager: this.inputManager,
      stateController: this.stateController,
      actionExecutor: this.actionExecutor,
      playSfx: (id) => this.audioManager.playSfx(id),
      resolveDisplayText: (s) => this.resolveDisplayText(s),
      debugPanelLog: (msg) => this.debugPanelUI?.log(msg),
      evaluateBeforeChargeCondition: (expr) => {
        if (expr === undefined || expr === null) return true;
        // 统一走中央工厂（律5 统一条件源）：手工缩水上下文缺 @scene/@owner/plane 叶子，
        // 同一条件在此入口与对话/zone/热点入口会得出不同结果。
        return evaluateConditionExpr(expr, this.buildConditionEvalContext());
      },
    });
    await this.sugarWheelMinigameManager.loadIndex();

    this.paperCraftMinigameManager.bindRuntime({
      renderer: this.renderer,
      inputManager: this.inputManager,
      stateController: this.stateController,
      actionExecutor: this.actionExecutor,
      resolveDisplayText: (s) => this.resolveDisplayText(s),
    });
    await this.paperCraftMinigameManager.loadIndex();
    if (this.tearDownComplete) return;

    this.interactionCoordinator = new InteractionCoordinator(this.eventBus, {
      stateController: this.stateController,
      sceneManager: this.sceneManager,
      dialogueManager: this.dialogueManager,
      graphDialogueManager: this.graphDialogueManager,
      actionExecutor: this.actionExecutor,
      inspectBox: this.inspectBox,
      eventBus: this.eventBus,
      getPlayerWorldPos: () => ({ x: this.player.x, y: this.player.y }),
      getCameraZoom: () => this.camera.getZoom(),
      preparePlayerForNpcDialogue: (npc) => {
        this.player.setFacing(npc.x - this.player.x, npc.y - this.player.y);
        this.player.playAnimation(ANIM_IDLE);
      },
      fadingDialogueCameraZoom: (targetZoom, durationMs) => {
        return this.cutsceneManager.fadingCameraZoom(targetZoom, durationMs);
      },
      fadingRestoreSceneCameraZoom: (durationMs) => {
        // NPC 对话收尾的 550ms 渐变必须以"位面基线"为目标——按场景 zoom 渐变会把
        // 对账器在 Dialogue→Exploring 边沿重贴的位面相机档静默盖掉。
        return this.cutsceneManager.fadingCameraZoom(this.getCameraBaselineZoom(), durationMs);
      },
    });
    this.interactionCoordinator.init();

    this.listenEvent('archive:firstView', (p: { actions: ActionDef[] }) => {
      void (async () => {
        try {
          await this.actionExecutor.executeBatchAwait(p.actions);
        } catch (e) {
          console.warn('Game: archive:firstView actions failed', e);
        }
      })();
    });

    this.eventBridge = new EventBridge(this.eventBus, {
      dialogueManager: this.dialogueManager,
      graphDialogueManager: this.graphDialogueManager,
      encounterManager: this.encounterManager,
      stateController: this.stateController,
      actionExecutor: this.actionExecutor,
      mapUI: this.mapUI,
      menuUI: this.menuUI,
      inspectBox: this.inspectBox,
      guardMapTravel: () => this.guardMapTravel(),
    });
    this.eventBridge.init();

    this.setupSceneReadyHandler();

    this.depthDebugVisualizer = new DepthDebugVisualizer(
      this.sceneDepthSystem,
      this.camera,
      this.renderer,
      this.assetManager,
      (msg) => this.logDepthDiag(msg),
    );

    /** T1：调试工具与 F2 面板注册统一按 import.meta.env.DEV 门控（判据与
     *  TouchMobileControls 的「调试」chip 一致），生产玩家无任何调试入口。 */
    if (import.meta.env.DEV) this.debugTools = new DebugTools({
      renderer: this.renderer,
      camera: this.camera,
      eventBus: this.eventBus,
      player: this.player,
      inventoryManager: this.inventoryManager,
      debugPanelUI: this.debugPanelUI,
      depthDebugVisualizer: this.depthDebugVisualizer,
      getCurrentSceneId: () => this.sceneManager.currentSceneData?.id,
      fallbackScene: this.gameConfig.fallbackScene,
      reloadScene: (id) => this.reloadScene(id),
      isExploring: () => this.stateController.currentState === GameState.Exploring,
      getDebugSceneWorldSize: () => {
        const s = this.sceneManager.currentSceneData;
        if (!s) return undefined;
        return { width: s.worldWidth, height: s.worldHeight };
      },
      applyDebugSceneWorldSize: (w, h) => this.applyDebugSceneWorldSize(w, h),
      isDevMode: () => this.isDevMode,
      goToDevScene: () => {
        void this.devLoadScene('dev_room');
      },
      getEntityPixelDensityMatchConfig: () => this.gameConfig.entityPixelDensityMatch === true,
      getEntityPixelDensityMatchEffective: () => this.getEntityPixelDensityMatchEffective(),
      getEntityPixelDensityMatchDebugOverride: () => this.entityPixelDensityMatchDebugOverride,
      cycleEntityPixelDensityMatchDebugOverride: () => {
        const cur = this.entityPixelDensityMatchDebugOverride;
        this.entityPixelDensityMatchDebugOverride = cur === null ? true : cur === true ? false : null;
        this.syncEntityPixelDensityMatch();
      },
      getEntityPixelDensityMatchBlurScaleFromConfig: () => this.getEntityPixelDensityMatchBlurScaleFromConfig(),
      getEntityPixelDensityMatchBlurScaleEffective: () => this.getEntityPixelDensityMatchBlurScale(),
      getEntityPixelDensityMatchBlurScaleDebug: () => this.entityPixelDensityMatchBlurScaleDebug,
      nudgeEntityPixelDensityMatchBlurScaleDebug: (delta: number) => {
        this.nudgeEntityPixelDensityMatchBlurScaleDebug(delta);
      },
      clearEntityPixelDensityMatchBlurScaleDebug: () => {
        this.clearEntityPixelDensityMatchBlurScaleDebug();
      },
      getNarrativeDebugSnapshot: () => this.buildRuntimeDebugSnapshot('debug-panel'),
      getScenarioDebugPanelRows: (): ScenarioDebugPanelRow[] => this.listScenarioDebugPanelRows(),
      scenarioDebugActivate: (scenarioId) => {
        const id = scenarioId.trim();
        if (!id) return;
        try {
          this.scenarioStateManager.activateScenarioLine(id);
          this.debugPanelUI.log(`[scenario] activateScenarioLine("${id}") 已调用`);
        } catch (e) {
          console.warn('[scenario] activateScenarioLine failed', e);
          this.debugPanelUI.log(`[scenario] 激活失败: ${id} — ${String(e)}`);
        }
      },
      scenarioDebugComplete: (scenarioId) => {
        const id = scenarioId.trim();
        if (!id) return;
        try {
          this.scenarioStateManager.completeScenarioLine(id);
          this.debugPanelUI.log(`[scenario] completeScenarioLine("${id}") 已调用`);
        } catch (e) {
          console.warn('[scenario] completeScenarioLine failed', e);
          this.debugPanelUI.log(`[scenario] 完成失败: ${id} — ${String(e)}`);
        }
      },
      scenarioDebugResetIncomplete: (scenarioId) => {
        const id = scenarioId.trim();
        if (!id) return;
        this.scenarioStateManager.resetScenarioProgressForDebug(id);
        this.debugPanelUI.log(
          `[scenario] resetScenarioProgressForDebug("${id}")：线已视为未完成（已清 phase 桶与 manual 生命周期；exposes 写入的 flag 未回滚）`,
        );
      },
      getDepthOcclusionBlendFactor: () => this.sceneDepthSystem.occlusionBlendFactor,
      setDepthOcclusionBlendFactor: (factor) => {
        this.sceneDepthSystem.occlusionBlendFactor = factor;
      },
      depthOcclusionActive: () => this.sceneDepthSystem.isEnabled,
      entityShadowActive: () => this.entityShadowDebugActive(),
      getEntityShadowDebug: () => this.getEntityShadowDebug(),
      cycleShadowMode: () => this.cycleShadowModeDebug(),
      toggleEntityTone: () => this.toggleEntityToneDebug(),
      toggleEntityShadowBillboard: () => this.toggleEntityShadowBillboardDebug(),
      setEntityShadowAzimuth: (deg) => this.setEntityShadowAzimuthDebug(deg),
      nudgeEntityShadowElevation: (d) => this.nudgeEntityShadowElevationDebug(d),
      nudgeEntityShadowLength: (d) => this.nudgeEntityShadowLengthDebug(d),
      nudgeEntityShadowDarkness: (d) => this.nudgeEntityShadowDarknessDebug(d),
      nudgeEntityShadowContact: (d) => this.nudgeEntityShadowContactDebug(d),
      nudgeEntityShadowContactSize: (d) => this.nudgeEntityShadowContactSizeDebug(d),
      nudgeEntityShadowSoftSamples: (d) => this.nudgeEntityShadowSoftSamplesDebug(d),
      toggleEntityShadowEnabled: () => this.toggleEntityShadowEnabledDebug(),
      smellDebug: {
        listProfiles: () =>
          Object.entries(this.smellProfilesData?.profiles ?? {}).map(([id, p]) => ({ id, name: p.name || id })),
        set: (scent, intensity, dir, flicker) => this.smellSystem.setSmell(scent, intensity, dir, flicker),
        clear: () => this.smellSystem.clearSmell(),
        setZone: (scent, intensity, dir, flicker) => this.smellSystem.setZoneSmell(scent, intensity, dir, flicker),
        clearZone: () => this.smellSystem.clearZoneSmell(),
        sniff: () => this.smellSystem.sniff(),
        getForm: () => this.hud?.getSmellForm() ?? null,
        setFormParam: (key, value) => this.hud?.setSmellFormParam(key, value),
      },
    });
    this.debugTools?.init();

    await Promise.all([
      this.loadFlagRegistry(),
      this.loadCharacterRegistry(),
      this.loadSmellProfiles(),
      this.inventoryManager.loadDefs(),
      this.rulesManager.loadDefs(),
      this.questManager.loadDefs(),
      this.encounterManager.loadDefs(),
      this.pressureHoldManager.loadDefs(),
      this.planeReconciler.loadDefs(),
      this.signalCueManager.loadDefs(),
      this.audioManager.loadConfig(),
      this.cutsceneManager.loadDefs(),
      this.archiveManager.loadDefs(),
      this.shopUI.loadDefs(),
      this.mapUI.loadConfig(),
    ]);
    if (this.tearDownComplete) return;

    await this.refreshTextResolveLookups();
    if (this.tearDownComplete) return;
    this.wireTextResolve();

    this.debugPanelUI.attachFlagDebug(this.flagStore, this.eventBus);
    this.setupCutsceneStepHud();
    this.setupPlaneDebugSection();

    if (!this.gameConfig.initialScene) {
      console.error('Game: initialScene not configured in game_config.json');
    }
    this.saveManager.setFallbackScene(this.gameConfig.fallbackScene || this.gameConfig.initialScene);

    await this.setupPlayer({ deferAvatar: this.isDevMode });
    if (this.tearDownComplete) return;
    this.setupRuntimeDebugSnapshotPublishing();
    // 气味调试 hook（平时关；URL 加 ?smellDebug 开启）：console 里 __smell(scent,intensity,dir,flicker) /
    // __smellSniff() / __smellStep(n) 驱动 HUD 气味指示器看效果。隐藏页 rAF 被节流时 __smell 会强制步进给截图用。
    if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('smellDebug')) {
      const w = window as unknown as Record<string, unknown>;
      this.smellDebugGlobalKeys = [
        '__smell', '__smellSniff', '__smellStep', '__smellInfo',
        '__smellZoneEnter', '__smellZoneExit', '__smellSource',
      ];
      const stepHud = (n: number) => {
        if (!document.hidden) return; // 可见页：让 HUD 自带 rAF 自然播动画（flash/coil/fade）；只在隐藏页强制步进给截图用
        const r = (this.hud as unknown as { smellRenderer?: { update: (dt: number) => void } }).smellRenderer;
        if (r) for (let i = 0; i < (n || 30); i++) r.update(0.05);
        try { (this.renderer as unknown as { app?: { render?: () => void } }).app?.render?.(); } catch { /* 隐藏页强制重绘 canvas */ }
      };
      w.__smell = (scent: string, intensity?: number, dir?: number, flicker?: boolean, steps?: number) => {
        this.smellSystem.setSmell(scent, intensity, dir, flicker);
        stepHud(steps ?? 30);
      };
      w.__smellSniff = (steps?: number) => { this.smellSystem.sniff(); stepHud(steps ?? 16); };
      w.__smellStep = (n: number) => stepHud(n);
      w.__smellInfo = () => {
        const r = this.hud as unknown as {
          smellRenderer?: { layer?: { x: number; y: number; visible: boolean; children: { length: number } };
            wispSprites?: { visible: boolean; alpha: number }[]; baseSprites?: { visible: boolean }[];
            renderScent?: string; fade?: number };
        };
        const sr = r.smellRenderer;
        if (!sr) return { renderer: null };
        return {
          layerX: sr.layer?.x, layerY: sr.layer?.y, layerVisible: sr.layer?.visible,
          children: sr.layer?.children?.length,
          wispVisible: (sr.wispSprites || []).filter((s) => s.visible && s.alpha > 0.003).length,
          baseVisible: (sr.baseSprites || []).filter((s) => s.visible).length,
          renderScent: sr.renderScent, fade: sr.fade,
        };
      };
      // 验证 zone:enter/zone:exit → SmellSystem zone 层（不需真走进区域）。
      w.__smellZoneEnter = (scent: string, intensity?: number, dir?: number, flicker?: boolean, steps?: number) => {
        this.eventBus.emit('zone:enter', { zoneId: '__debugzone__', zone: { id: '__debugzone__', smell: { scent, intensity, dir, flicker } } });
        stepHud(steps ?? 30);
      };
      w.__smellZoneExit = (steps?: number) => {
        this.eventBus.emit('zone:exit', { zoneId: '__debugzone__' });
        stepHud(steps ?? 30);
      };
      w.__smellSource = () => this.smellSystem.getDebugState();
    }

    if (this.isDevMode) {
      await this.startDevMode(
        options.playCutscene,
        options.waterPreview,
        options.sugarWheelPreview,
        options.paperCraftPreview,
        options.devScene,
        options.narrativeWarp,
        options.visualCapture === true,
      );
    } else {
      if (this.gameConfig.initialQuest) {
        this.questManager.acceptQuest(this.gameConfig.initialQuest);
      }
      await this.sceneManager.loadScene(this.gameConfig.initialScene);
      await this.tryStartInitialPrologue();
    }

    if (this.tearDownComplete || !this.renderer.isInitialized()) {
      return;
    }
    const ticker = this.renderer.app.ticker;
    if (!ticker) {
      return;
    }
    this.lastTime = performance.now();
    this.mainTick = () => {
      const now = performance.now();
      const dt = Math.min((now - this.lastTime) / 1000, 0.1);
      this.lastTime = now;
      if (!this.fixedTickMode) this.tick(dt);
    };
    ticker.add(this.mainTick);
    this.setupWebGlPanelDiagnostics();

    // dev 启动直达路由：主 tick 已挂载（过场位移/小游戏 update 有驱动），此刻才安全执行
    if (this.devStartupRoute) {
      const route = this.devStartupRoute;
      this.devStartupRoute = null;
      try {
        await route();
      } catch (e) {
        console.warn('Game: dev 启动直达路由失败', e);
      }
    }
    if (this.tearDownComplete || !this.renderer.isInitialized()) return;
    this.runtimeReady = true;
    this.setupRuntimeCommandPolling();
    await this.publishRuntimeDebugSnapshot('runtime-ready');
  }

  /** F2「日志」页：WebGL getError、深度 GPU 纹理、shader 预热与上下文丢失；JS/Pixi 运行时错误镜像 */
  private setupWebGlPanelDiagnostics(): void {
    this.runtimeDebugLogCleanup?.();
    this.runtimeDebugLogCleanup = installRuntimeErrorsToDebugPanel((m) => this.debugPanelUI?.log(m));

    const canvas = this.renderer.app.canvas as HTMLCanvasElement | undefined;
    if (!canvas) return;

    this.webglContextLostHandler = (e: Event) => {
      const msg = (e as WebGLContextEvent).statusMessage || '';
      this.debugPanelUI?.log(`[GL诊断] webglcontextlost: ${msg || '(no message)'}`);
    };
    canvas.addEventListener('webglcontextlost', this.webglContextLostHandler);

    this.webglContextRestoredHandler = () => {
      this.debugPanelUI?.log('[GL诊断] webglcontextrestored');
    };
    canvas.addEventListener('webglcontextrestored', this.webglContextRestoredHandler);

    this.glPostRenderDrain = () => {
      const gl = tryGetWebGlFromApplication(this.renderer.app);
      if (!gl) return;
      drainWebGLErrorsToPanel(gl, (m) => this.debugPanelUI?.log(m), '每帧(Pixi渲染后)');
    };
    this.renderer.app.ticker.add(this.glPostRenderDrain, undefined, UPDATE_PRIORITY.UTILITY);
  }

  /** 开发模式或 URL 带 `cutsceneDebug` 时显示左上角过场 step 预览 */
  private cutsceneStepHudWanted(): boolean {
    if (this.isDevMode) return true;
    try {
      return typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('cutsceneDebug');
    } catch {
      return false;
    }
  }

  private setupCutsceneStepHud(): void {
    this.debugPanelUI.addSection('cutscene-step', () => {
      const s = this.cutsceneManager.getPlaybackHudSnapshot();
      if (!s.cutsceneId) {
        return '过场步骤：未在播放';
      }
      return `过场步骤\ncutsceneId: ${s.cutsceneId}\npath: ${s.path ?? '—'}\n${s.label ?? ''}`;
    });

    if (!this.cutsceneStepHudWanted()) return;
    const el = document.createElement('div');
    el.id = 'cutscene-step-hud';
    el.setAttribute('aria-live', 'polite');
    el.style.cssText = [
      'position:fixed', 'left:8px', 'top:8px', 'z-index:10050', 'max-width:min(560px,92vw)',
      'padding:8px 12px', 'font:12px/1.45 ui-monospace,monospace',
      'background:rgba(15,18,24,.88)', 'color:#b8f6c6', 'border:1px solid rgba(120,200,140,.35)',
      'border-radius:6px', 'pointer-events:none', 'white-space:pre-wrap', 'display:none',
      'box-shadow:0 2px 12px rgba(0,0,0,.4)',
    ].join(';');
    document.body.appendChild(el);
    this.cutsceneStepHudEl = el;
    const onStep = (p: { cutsceneId?: string | null; path?: string | null; label?: string | null }) => {
      if (!this.cutsceneStepHudEl) return;
      if (p.path == null && p.label == null) {
        this.cutsceneStepHudEl.style.display = 'none';
        return;
      }
      const id = p.cutsceneId ?? '';
      const path = p.path ?? '';
      const lab = p.label ?? '';
      this.cutsceneStepHudEl.textContent = `[过场 step] ${id}\npath: ${path}\n${lab}`;
      this.cutsceneStepHudEl.style.display = 'block';
    };
    this.listenEvent('cutscene:step', onStep);
  }

  /** F2「位面」区块：当前激活位面 / 来源（manual|narrative|default）/ 各槽生效值。 */
  private setupPlaneDebugSection(): void {
    this.debugPanelUI.addSection('位面', () => {
      const s = this.planeReconciler.getDebugState();
      const lines: string[] = [];
      lines.push(`激活位面: ${s.activePlaneId}${s.def?.label ? `（${s.def.label}）` : ''}`);
      lines.push(`来源: ${s.source === 'manual' ? 'manual（activatePlane 覆盖）' : s.source === 'narrative' ? 'narrative（叙事点名）' : 'default（normal 兜底）'}`);
      if (s.namedBy.length > 0) {
        lines.push(`点名: ${s.namedBy.map((n) => `${n.graphId}→${n.planeId}`).join(', ')}`);
      }
      const d = s.def;
      if (d) {
        if (d.movement) {
          const m = d.movement;
          lines.push(
            `移动: drift=(${m.driftX ?? 0},${m.driftY ?? 0}) speed×${m.speedScale ?? 1} 跑=${m.allowRun !== false ? '允许' : '禁止'}`,
          );
        }
        if (d.interaction) {
          const i = d.interaction;
          lines.push(
            `交互: 热点=${i.canInteractHotspots !== false ? '可' : '禁'} 拾取=${i.canPickup !== false ? '可' : '禁'} 对话=${i.canTalkNpcs !== false ? '可' : '禁'}`,
          );
        }
        if (d.camera?.zoom !== undefined) lines.push(`相机 zoom: ${d.camera.zoom}`);
        if (d.lighting) lines.push('光照: 位面档生效（lightEnvCurve 挂起）');
        if (d.membership === 'exclusive') lines.push('世界模型: exclusive（独立世界，缺省实体不存在）');
        if (d.travel?.allowMapTravel === false) lines.push('旅行: 地图快速旅行禁用');
      } else if (s.activePlaneId !== 'normal') {
        lines.push('（该位面未在 planes.json 注册，各槽按无配置处理）');
      }
      // 掉阳气合成视图（D5 对账可见性）：位面 drain 基线 + 活跃 zone 的 damagePlayer 数额，
      // 两条通道都走 HealthSystem.damage，同一血条上叠加。
      const drainParts: string[] = [];
      if (d?.healthDrainPerSec !== undefined) drainParts.push(`位面 ${d.healthDrainPerSec}/s（仅 Exploring 计费）`);
      for (const z of this.zoneSystem.getActiveZones()) {
        for (const [hook, label] of [['onEnter', '进入'], ['onStay', '停留']] as const) {
          for (const a of (z[hook] ?? [])) {
            if (a?.type === 'damagePlayer') {
              const amount = (a.params as { amount?: number } | undefined)?.amount;
              drainParts.push(`zone ${z.id} ${label} -${amount ?? '?'}`);
            }
          }
        }
      }
      if (drainParts.length > 0) lines.push(`掉阳气: ${drainParts.join('；')}`);
      return `位面\n${lines.join('\n')}`;
    });
  }

  private async loadFlagRegistry(): Promise<void> {
    try {
      const reg = await this.assetManager.loadJson<FlagRegistryJson>(TEXT_URLS.flagRegistry);
      this.flagStore.configureRegistry(reg);
    } catch {
      this.flagStore.configureRegistry(null);
    }
  }

  /** 角色注册表 → SceneManager（NPC 实例化时合并 name/animFile/portraitSlug 默认）。缺文件则空表、退化为纯 NpcDef 内联。 */
  private async loadCharacterRegistry(): Promise<void> {
    try {
      const raw = await this.assetManager.loadJson<CharacterRegistryFile>(TEXT_URLS.characterRegistry);
      this.sceneManager.setCharacterRegistry(buildCharacterRegistry(raw?.characters));
    } catch {
      this.sceneManager.setCharacterRegistry({});
    }
  }

  /** 气味 profiles（方案 E·气味指示器的数据源）→ 交给 HUD 建渲染器。失败则降级无气味指示器。 */
  private async loadSmellProfiles(): Promise<void> {
    try {
      const data = await this.assetManager.loadJson<SmellProfilesRaw>(TEXT_URLS.smellProfiles);
      this.smellProfilesData = data;
      this.hud?.setSmellProfiles(data);
    } catch {
      /* 无 profiles：HUD 气味指示器不显示，不影响其它 */
    }
  }

  private async loadGameConfig(): Promise<void> {
    try {
      const cfg = await this.assetManager.loadJson<Partial<GameConfig>>(TEXT_URLS.gameConfig);
      if (cfg.initialScene) this.gameConfig.initialScene = cfg.initialScene;
      if (cfg.initialQuest) this.gameConfig.initialQuest = cfg.initialQuest;
      if (cfg.fallbackScene) this.gameConfig.fallbackScene = cfg.fallbackScene;
      if (cfg.initialCutscene !== undefined) this.gameConfig.initialCutscene = cfg.initialCutscene;
      if (cfg.initialCutsceneDoneFlag !== undefined) {
        this.gameConfig.initialCutsceneDoneFlag = cfg.initialCutsceneDoneFlag;
      }
      if (cfg.startupFlags) {
        for (const [k, v] of Object.entries(cfg.startupFlags)) {
          this.flagStore.set(k, v as boolean | number);
        }
      }
      if (cfg.viewport) this.gameConfig.viewport = cfg.viewport;
      if (cfg.windowSize) this.gameConfig.windowSize = cfg.windowSize;
      if (cfg.playerAvatar !== undefined) {
        const pa = cfg.playerAvatar;
        this.gameConfig.playerAvatar = {
          animManifest: pa.animManifest ?? this.gameConfig.playerAvatar?.animManifest,
          stateMap: pa.stateMap ? { ...pa.stateMap } : this.gameConfig.playerAvatar?.stateMap,
        };
      }
      if (typeof cfg.entityPixelDensityMatch === 'boolean') {
        this.gameConfig.entityPixelDensityMatch = cfg.entityPixelDensityMatch;
      }
      if (
        typeof cfg.entityPixelDensityMatchBlurScale === 'number' &&
        Number.isFinite(cfg.entityPixelDensityMatchBlurScale) &&
        cfg.entityPixelDensityMatchBlurScale > 0
      ) {
        this.gameConfig.entityPixelDensityMatchBlurScale = cfg.entityPixelDensityMatchBlurScale;
      }
      if (cfg.entityLighting && typeof cfg.entityLighting === 'object') {
        this.gameConfig.entityLighting = cfg.entityLighting;
      }
      if (cfg.health && typeof cfg.health === 'object') {
        this.gameConfig.health = { ...cfg.health };
      }
    } catch {
      console.warn('Game: game_config.json not found, using defaults');
    }
    try {
      const ov = await this.assetManager.loadJson<Record<string, string>>(TEXT_URLS.overlayImages);
      this.overlayImageRegistry = ov && typeof ov === 'object' ? { ...ov } : {};
    } catch {
      this.overlayImageRegistry = {};
    }
  }

  /**
   * showOverlayImage 的 image 参数：短 id 查 overlay_images.json；以 / 开头则当作完整路径。
   */
  private resolveOverlayImageIdToPath(image: string): string {
    const raw = image.trim();
    if (!raw) return raw;
    if (raw.startsWith('/')) return raw;
    const path = this.overlayImageRegistry[raw];
    if (path) return path;
    console.warn(`Game: overlay 图 id「${raw}」未在 overlay_images.json 中登记，将按原文字符串当路径`);
    return raw;
  }

  /** 从磁盘加载玩家动画资源；失败返回 null（由调用方决定占位图集）。 */
  private async buildAnimationManifestRefs(animPath: string, labelPrefix: string): Promise<AssetRef[]> {
    const refs: AssetRef[] = [{ type: 'json', path: animPath, label: `${labelPrefix}清单` }];
    try {
      const animRaw = await this.assetManager.loadJson<AnimationSetDefInput>(animPath);
      if (animRaw.spritesheet) {
        refs.push({
          type: 'texture',
          path: resolvePathRelativeToAnimManifest(animPath, animRaw.spritesheet),
          label: `${labelPrefix}图集`,
        });
      }
    } catch {
      // 实际加载会走占位图；startup manifest 只做尽力预热。
    }
    return refs;
  }

  private async loadPlayerAvatarResources(
    playerAnimPath: string,
  ): Promise<{ texture: any; animDef: AnimationSetDef } | null> {
    try {
      const animRaw = await this.assetManager.loadJson<AnimationSetDefInput>(playerAnimPath);
      if (animRaw.spritesheet) {
        const sheetPath = resolvePathRelativeToAnimManifest(playerAnimPath, animRaw.spritesheet);
        const texture = await this.assetManager.loadTexture(sheetPath);
        const animDef = normalizeAnimationSetDef(animRaw, texture.width, texture.height);
        return { texture, animDef };
      }
      const placeholder = createPlaceholderPlayerTextures(this.renderer.app);
      const texture = placeholder.texture;
      const animDef = normalizeAnimationSetDef(animRaw, texture.width, texture.height);
      return { texture, animDef };
    } catch {
      return null;
    }
  }

  private placeholderPlayerAvatar(): { texture: any; animDef: AnimationSetDef } {
    const placeholder = createPlaceholderPlayerTextures(this.renderer.app);
    return {
      texture: placeholder.texture,
      animDef: {
        spritesheet: '',
        cols: 6,
        rows: 1,
        worldWidth: placeholder.frameWidth,
        worldHeight: placeholder.frameHeight,
        states: {
          [ANIM_IDLE]: { frames: [0, 1], frameRate: 2, loop: true },
          [ANIM_WALK]: { frames: [2, 3, 4, 5], frameRate: 8, loop: true },
          [ANIM_RUN]:  { frames: [2, 3, 4, 5], frameRate: 12, loop: true },
        },
      },
    };
  }

  /** 主角当前生效装扮配置的对话头像立绘集（装扮配置解耦：头像跟配置走，切装扮即切头像） */
  private currentPlayerPortraitSlug: string | null = null;

  /** 装扮配置缺省立绘集：按动画包目录名同名推导，如 …/player_anim/anim.json → player_anim */
  private static portraitSlugFromManifest(path: string): string | null {
    const m = /\/animation\/([^/]+)\/anim\.json/.exec(path);
    return m ? m[1] : null;
  }

  private mountPlayerAvatar(
    texture: any,
    animDef: AnimationSetDef,
    stateMap: Record<string, string> | undefined,
    sourcePathForLog: string,
    applyStateMap: boolean,
    portraitSlug?: string | null,
  ): void {
    this.currentPlayerPortraitSlug =
      portraitSlug?.trim() || Game.portraitSlugFromManifest(sourcePathForLog);
    this.playerAnimDef = animDef;
    this.player.sprite.loadFromDef(texture, animDef);
    const sm = applyStateMap ? stateMap : undefined;
    this.player.sprite.setLogicalStateMap(sm);
    if (sm && animDef.states) {
      for (const [logical, clip] of Object.entries(sm)) {
        if (clip && !animDef.states[clip]) {
          console.warn(
            `Game: playerAvatar.stateMap["${logical}"] -> "${clip}" is not a state in ${sourcePathForLog}`,
          );
        }
      }
    }
    this.player.sprite.playAnimation(ANIM_IDLE);
  }

  /** 事件 / Action：切换动画包与映射；加载失败则不打断当前化身。 */
  async applyPlayerAvatarFromAction(
    manifestPath: string,
    stateMap?: Record<string, string> | null,
    portraitSlug?: string | null,
  ): Promise<void> {
    const path = manifestPath.trim();
    if (!path) return;
    const loaded = await this.loadPlayerAvatarResources(path);
    if (!loaded) {
      console.warn('applyPlayerAvatar: 无法加载', path);
      return;
    }
    const sm =
      stateMap && Object.keys(stateMap).length > 0 ? stateMap : undefined;
    this.mountPlayerAvatar(loaded.texture, loaded.animDef, sm, path, true, portraitSlug);
  }

  /** 按 game_config.playerAvatar 恢复（与开局 setupPlayer 数据源一致）。 */
  async resetPlayerAvatarFromAction(): Promise<void> {
    const avatar = this.gameConfig.playerAvatar;
    const defaultManifest = '/resources/runtime/animation/player_anim/anim.json';
    const path = (avatar?.animManifest?.trim() || defaultManifest);
    await this.applyPlayerAvatarFromAction(path, avatar?.stateMap ?? null, avatar?.portraitSlug ?? null);
  }

  private async setupPlayer(options: { deferAvatar?: boolean } = {}): Promise<void> {
    const avatar = this.gameConfig.playerAvatar;
    const defaultManifest = '/resources/runtime/animation/player_anim/anim.json';
    const playerAnimPath = (avatar?.animManifest?.trim() || defaultManifest);

    if (options.deferAvatar) {
      const { texture, animDef } = this.placeholderPlayerAvatar();
      this.mountPlayerAvatar(texture, animDef, undefined, playerAnimPath, false, avatar?.portraitSlug);
      void (async () => {
        await this.assetManager.preloadManifest({
          scopeId: 'startup:player',
          refs: await this.buildAnimationManifestRefs(playerAnimPath, '玩家动画'),
        }, { mode: 'runtime', tolerateErrors: true });
        const loaded = await this.loadPlayerAvatarResources(playerAnimPath);
        if (!loaded || this.tearDownComplete || !this.renderer.isInitialized()) return;
        this.mountPlayerAvatar(loaded.texture, loaded.animDef, avatar?.stateMap, playerAnimPath, true, avatar?.portraitSlug);
      })();
    } else {
      await this.assetManager.preloadManifest({
        scopeId: 'startup:player',
        refs: await this.buildAnimationManifestRefs(playerAnimPath, '玩家动画'),
      }, { mode: 'stage', tolerateErrors: true });
      const loaded = await this.loadPlayerAvatarResources(playerAnimPath);
      if (loaded) {
        this.mountPlayerAvatar(loaded.texture, loaded.animDef, avatar?.stateMap, playerAnimPath, true, avatar?.portraitSlug);
      } else {
        const { texture, animDef } = this.placeholderPlayerAvatar();
        this.mountPlayerAvatar(texture, animDef, undefined, playerAnimPath, false, avatar?.portraitSlug);
      }
    }
    this.renderer.entityLayer.addChild(this.player.sprite.container);

    const playerPosGetter = () => ({ x: this.player.x, y: this.player.y });
    this.interactionSystem.setPlayerPositionGetter(playerPosGetter);
    this.zoneSystem.setPlayerPositionGetter(playerPosGetter);
  }

  /**
   * 热区 / 图对话 Action：停止指定 NPC 的巡逻（打断当前位移 +递增巡逻代，语义与对话里其它 action 顺序一致）。
   */
  stopNpcPatrol(npcId: string): void {
    const id = npcId?.trim();
    if (!id) return;
    const npc = this.sceneManager.getNpcById(id);
    npc?.cancelActiveMove();
    const cur = this.npcPatrolEpoch.get(id) ?? 0;
    this.npcPatrolEpoch.set(id, cur + 1);
  }

  /** 当前场景内重启巡逻：先 bump token 结束旧协程，再开新协程（与 scene:ready 规则一致） */
  private startNpcPatrolForNpc(npcId: string): void {
    const id = npcId?.trim();
    if (!id) return;
    const npc = this.sceneManager.getNpcById(id);
    if (!npc) {
      console.warn('startNpcPatrolForNpc: 当前场景无该 NPC', id);
      return;
    }
    const patrol = npc.def.patrol;
    if (!patrol?.route || patrol.route.length === 0) return;
    this.stopNpcPatrol(id);
    this.runNpcPatrol(npc, patrol.route, patrol.speed ?? 60, patrol.moveAnimState);
  }

  private async sleepWhileNpcPatrolPaused(npc: Npc, gen: number): Promise<void> {
    while (
      npc.isPatrolPausedForDialogue &&
      this.patrolGeneration === gen &&
      this.sceneManager.getCurrentNpcs().includes(npc)
    ) {
      await new Promise<void>(r => setTimeout(r, 40));
    }
  }

  private runNpcPatrol(
    npc: Npc,
    route: { x: number; y: number }[],
    speed: number,
    moveAnimState?: string,
  ): void {
    const gen = this.patrolGeneration;
    const npcId = npc.def.id;
    const tokenAtStart = this.npcPatrolEpoch.get(npcId) ?? 0;
    const patrolStoppedByAction = (): boolean =>
      (this.npcPatrolEpoch.get(npcId) ?? 0) !== tokenAtStart;

    // 相邻重复路点会产生零长度段：moveTo 立即返回 → 协程热转空耗（单路点 route 尤甚）。
    // 先去重（含 ping-pong 端点），只剩一个点则走到位后驻停，不进循环。
    const pts: { x: number; y: number }[] = [];
    for (const p of route) {
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 0.001) pts.push(p);
    }
    if (pts.length <= 1) {
      if (pts.length === 1) {
        void npc.moveTo(pts[0].x, pts[0].y, speed, moveAnimState);
      }
      return;
    }

    const run = async () => {
      let i = 0;
      let step = 1;
      while (
        this.patrolGeneration === gen &&
        this.sceneManager.getCurrentNpcs().includes(npc)
      ) {
        if (patrolStoppedByAction()) break;
        await this.sleepWhileNpcPatrolPaused(npc, gen);
        if (this.patrolGeneration !== gen || !this.sceneManager.getCurrentNpcs().includes(npc)) {
          break;
        }
        if (patrolStoppedByAction()) break;
        await npc.moveTo(pts[i].x, pts[i].y, speed, moveAnimState);
        if (this.patrolGeneration !== gen || !this.sceneManager.getCurrentNpcs().includes(npc)) {
          break;
        }
        if (!npc.consumePatrolSkipWaypointAdvance()) {
          i += step;
          // ping-pong 掉头：跳过端点自身（pts.length ≥ 2），避免端点零长度 move 抖帧
          if (i >= pts.length) {
            i = pts.length - 2;
            step = -1;
          } else if (i < 0) {
            i = 1;
            step = 1;
          }
        }
      }
    };
    void run();
  }

  private setupSceneManager(): void {
    this.sceneManager.setPlayerPositionSetter((x, y) => {
      this.player.x = x;
      this.player.y = y;
    });

    this.sceneManager.setCameraSetter((boundsW, boundsH, snapX, snapY, cameraConfig, worldScale) => {
      this.camera.setBounds(boundsW, boundsH);
      if (cameraConfig?.pixelsPerUnit) {
        this.camera.setPixelsPerUnit(cameraConfig.pixelsPerUnit);
      }
      if (cameraConfig?.zoom) {
        this.camera.setZoom(cameraConfig.zoom);
      }
      if (worldScale !== undefined) {
        this.camera.setWorldScale(worldScale);
      }
      this.camera.snapTo(snapX, snapY);
    });
    this.sceneManager.setBoundsOnlySetter((boundsW, boundsH) => {
      this.camera.setBounds(boundsW, boundsH);
    });

    this.sceneManager.setAudioApplier((bgm, ambient) => {
      this.audioManager.applySceneAudio(bgm, ambient);
    });
    this.sceneManager.setAudioManifestResolver((bgm, ambient) => this.audioManager.getSceneAudioRefs(bgm, ambient));

    this.sceneManager.setZoneSetter((zones) => {
      this.zoneSystem.setZones(zones);
    });

    this.sceneManager.setInteractionSetter((hotspots, npcs) => {
      this.interactionSystem.setHotspots(hotspots);
      this.interactionSystem.setNpcs(npcs);
    });

    // 过场重建 / 卸载实体时，先把其滤镜从深度系统的每帧驱动列表摘除再销毁，
    // 否则已 destroy 的滤镜仍被 updatePerFrame 引用（且热点滤镜此前根本不销毁，造成 GPU 泄漏）。
    this.sceneManager.setEntityFilterReleaser((filters) => {
      for (const f of filters) {
        this.sceneDepthSystem.removeFilter(f as Parameters<typeof this.sceneDepthSystem.removeFilter>[0]);
        f.destroy();
      }
    });

    this.sceneManager.setDepthLoader(async (sceneId, sceneData, worldToPixelX, worldToPixelY) => {
      if (sceneData.depthConfig) {
        const dc = sceneData.depthConfig;
        const mapPath = `resources/runtime/scenes/${sceneId}/${dc.depth_map}`;
        await this.sceneDepthSystem.load(
          sceneId, dc, this.assetManager,
          sceneData.worldWidth, sceneData.worldHeight,
          worldToPixelX, worldToPixelY,
        );
        const en = this.sceneDepthSystem.isEnabled;
        const dt = this.sceneDepthSystem.currentDepthTexture;
        this.logDepthDiag(
          `depthLoader ${sceneId}: enabled=${en} path=${mapPath} ` +
            `tex=${dt ? `${dt.width}x${dt.height} uid=${dt.uid} WHITE=${dt === Texture.WHITE}` : 'null'}`,
        );
        if (!en) {
          this.logDepthDiag(
            `depthLoader ${sceneId}: 深度纹理未加载成功时 F2 深度调试仍为占位白图，遮挡滤镜不会创建`,
          );
        }
        this.runDepthAndShaderGlDiagnostics(sceneId, dt, en);
      } else {
        this.sceneDepthSystem.loadDefault();
        this.logDepthDiag(`depthLoader ${sceneId}: 无 depthConfig，深度系统关闭`);
        const gl = tryGetWebGlFromApplication(this.renderer.app);
        if (!gl) {
          this.debugPanelUI?.log('[GL诊断] 无 WebGL 上下文（可能 WebGPU），跳过 getError');
        } else {
          drainWebGLErrorsToPanel(gl, (m) => this.debugPanelUI?.log(m), `${sceneId} 无depthConfig`);
        }
      }
      this.setupSceneLighting(sceneData, worldToPixelX, worldToPixelY);
      this.refreshPlayerWorldCollision();
    });

    this.sceneManager.setDepthUnloader(() => {
      this.sceneDepthSystem.unload();
      this.refreshPlayerWorldCollision();
      // NPC/热区滤镜已在场景卸载更早处销毁；此处先经 unload() 清空系统滤镜表，
      // 再断开玩家滤镜，最后销毁探针 RT，确保无残留引用采样已销毁的纹理。
      this.player.sprite.container.filters = [];
      this.playerDepthFilter = null;
      this.clearEntityShadows();
      if (this.currentProbe) {
        this.currentProbe.destroy(true);
        this.currentProbe = null;
      }
      this.currentLightEnv = null;
      this.currentLightCurve = null;
      this.currentShadowField = null;
    });

    this.sceneManager.setSceneEnterRunner(async (actions) => {
      const sceneId = this.sceneManager.currentSceneData?.id ?? '';
      this.ambientNarrativeOwner = sceneId ? { ownerType: 'scene', ownerId: sceneId } : null;
      try {
        await this.actionExecutor.executeBatchAwait(actions);
      } finally {
        this.ambientNarrativeOwner = null;
      }
    });
  }

  /** 深度图、热区与 NPC 多边形碰撞合并（已拾取/失效的热区不参与；不可见 NPC 不参与） */
  private refreshPlayerWorldCollision(): void {
    this.player.setDepthCollision((wx, wy) => {
      if (this.sceneDepthSystem.isCollision(wx, wy)) return true;
      for (const h of this.sceneManager.getCurrentHotspots()) {
        if (!h.active) continue;
        const worldPoly = hotspotCollisionPolygonToWorld(h.def);
        if (worldPoly && isValidZonePolygon(worldPoly) && isPointInPolygon(worldPoly, wx, wy)) return true;
      }
      for (const n of this.sceneManager.getCurrentNpcs()) {
        if (!n.container.visible) continue;
        const worldPoly = npcCollisionPolygonToWorld(n);
        if (worldPoly && isValidZonePolygon(worldPoly) && isPointInPolygon(worldPoly, wx, wy)) return true;
      }
      return false;
    });
  }

  /**
   * 场景加载时配置逐 entity 光照：解析光照环境、按背景建辐照度探针、启用光照系统。
   * 总开关关闭或上一探针存在时先清理。需在 depth load/loadDefault 之后调用（共享 sceneW/worldToPixel）。
   */
  private setupSceneLighting(
    sceneData: SceneData,
    worldToPixelX: number,
    worldToPixelY: number,
  ): void {
    if (this.currentProbe) {
      this.currentProbe.destroy(true);
      this.currentProbe = null;
    }
    this.currentLightEnv = null;
    this.currentLightCurve = null;
    this.currentShadowField = null;

    const cfg = this.gameConfig.entityLighting;
    if (!cfg?.enabled) {
      this.sceneDepthSystem.disableLighting();
      return;
    }

    const env = resolveLightEnv(sceneData.lightEnv, cfg);
    this.currentLightEnv = env;
    // 光照环境曲线：有(≥2点)则预处理累计弧长,并用 spawn 处投影值初始化 env(首帧滤镜烘焙正确;逐帧再覆盖)
    this.currentLightCurve = prepareLightCurve(sceneData.lightEnvCurve);
    if (this.currentLightCurve) this.resolveLightCurveInto(this.player.x, this.player.y, env);
    this.currentShadowField = new UniformShadowField(env);

    let probeSource = null;
    const bgTex = this.sceneManager.getPrimaryBackgroundTexture();
    if (bgTex) {
      this.currentProbe = buildIrradianceProbe(this.renderer.app, bgTex);
      probeSource = this.currentProbe ? this.currentProbe.source : null;
    }

    this.sceneDepthSystem.enableLighting(
      probeSource,
      env,
      sceneData.worldWidth,
      sceneData.worldHeight,
      worldToPixelX,
      worldToPixelY,
    );
  }

  /** 为玩家与各 NPC 重建投影阴影（按 shadowMode 选实现；off 不建）。 */
  private rebuildEntityShadows(): void {
    this.clearEntityShadows();
    const env = this.currentLightEnv;
    if (!env || env.shadow.mode === 'off' || !this.sceneDepthSystem.isLightingEnabled) return;

    this.entityShadows.set('player', {
      shadow: this.createShadowImpl(env.shadow.mode),
      src: this.makePlayerShadowSource(),
      owner: this.player,
    });
    for (const npc of this.sceneManager.getCurrentNpcs()) {
      this.buildNpcShadowEntry(npc);
    }
    for (const h of this.sceneManager.getCurrentHotspots()) {
      this.buildHotspotShadowEntry(h);
    }
  }

  /**
   * 定向重建：仅对 payload 里给定 id 的 npc/hotspot 换新阴影实例（过场进出重建实体时用），
   * 不动玩家与未列出的实体，避免全场阴影整体销毁重建（与 entityShadows owner-swap 缓存自相矛盾）。
   * enter/exit 时序下某 id 若在当前场景已无实例，只销毁旧 entry、不新建。
   */
  private rebuildEntityShadowsForIds(npcIds: string[], hotspotIds: string[]): void {
    const env = this.currentLightEnv;
    const shadowsOn = !!env && env.shadow.mode !== 'off' && this.sceneDepthSystem.isLightingEnabled;

    for (const id of npcIds) {
      this.destroyEntityShadowEntry(id);
      if (!shadowsOn) continue;
      const npc = this.sceneManager.getNpcById(id);
      if (npc) this.buildNpcShadowEntry(npc);
    }
    for (const id of hotspotIds) {
      this.destroyEntityShadowEntry(`hotspot:${id}`);
      if (!shadowsOn) continue;
      const h = this.sceneManager.getCurrentHotspots().find((x) => x.def.id === id);
      if (h) this.buildHotspotShadowEntry(h);
    }
  }

  /** 销毁并从 map 移除单个实体阴影 entry（若存在）：unregister + destroy + delete，键规则同 rebuild。 */
  private destroyEntityShadowEntry(key: string): void {
    const entry = this.entityShadows.get(key);
    if (!entry) return;
    this.sceneDepthSystem.unregisterShadow(entry.shadow);
    entry.shadow.destroy();
    this.entityShadows.delete(key);
  }

  /** 为单个 NPC 建阴影 entry（castShadow!==false 才建）；rebuildEntityShadows 与定向重建共用，避免逻辑漂移。 */
  private buildNpcShadowEntry(npc: Npc): void {
    const env = this.currentLightEnv;
    if (!env || npc.def.castShadow === false) return;
    this.entityShadows.set(npc.id, {
      shadow: this.createShadowImpl(env.shadow.mode),
      src: this.makeNpcShadowSource(npc),
      owner: npc,
    });
  }

  /** 为单个 hotspot 建阴影 entry（仅有展示图且 castShadow!==false 才建；键加前缀避免与 npc.id 撞）。共用以避免漂移。 */
  private buildHotspotShadowEntry(h: Hotspot): void {
    const env = this.currentLightEnv;
    if (!env || h.def.castShadow === false || !h.def.displayImage?.image) return;
    this.entityShadows.set(`hotspot:${h.def.id}`, {
      shadow: this.createShadowImpl(env.shadow.mode),
      src: this.makeHotspotShadowSource(h),
      owner: h,
    });
  }

  /** 按模式建阴影实现：real+有深度→deferred；否则→planar（real 无深度时退化为纯平面）。
   *  实例注册进 SceneDepthSystem 调参广播列表（F2 改 tolerance/floorOffset 实时传播）。 */
  private createShadowImpl(mode: 'real' | 'planar' | 'off'): IEntityShadow {
    const layer = this.renderer.shadowLayer;
    const ctx = this.sceneDepthSystem.getShadowSceneContext();
    const sh = mode === 'real' && ctx
      ? new DeferredEntityShadow(layer, ctx)
      : new PlanarEntityShadow(layer, ctx);
    this.sceneDepthSystem.registerShadow(sh);
    return sh;
  }

  /** 按 toneEnabled / mode 设置所有光照滤镜的 tone 与 sprite-AO（接触斑唯一归地面侧，避免双压：
   *  阴影开启时接触斑由阴影实现绘制，滤镜侧 aoContact 归零；阴影 off 时才走滤镜侧 ao.contact）。 */
  private applyShadowAndAO(): void {
    const env = this.currentLightEnv;
    if (!env) return;
    const tone = env.toneEnabled ? env.toneStrength : 0;
    const aoForm = env.shadow.mode === 'off' ? 0 : env.ao.form;
    this.sceneDepthSystem.applyShadowFilterToneAO(
      tone,
      env.shadow.mode === 'off' ? env.ao.contact : 0,
      aoForm,
    );
  }

  /** F2 切换 shadowMode/tone/billboard 后重建阴影实例并重设滤镜 tone/AO。 */
  private applyShadowModeChange(): void {
    this.rebuildEntityShadows();
    this.applyShadowAndAO();
  }

  /** 把光照环境曲线在世界点 (px,py) 处的插值结果原地写入 env（保持对象身份，供持引用者逐帧读取）。 */
  private resolveLightCurveInto(px: number, py: number, env: ResolvedLightEnv): void {
    const curve = this.currentLightCurve;
    if (!curve) return;
    const t = projectToCurveT(curve, px, py);
    const partial = interpolateLightEnv(curve, t);
    const resolved = resolveLightEnv(partial, this.gameConfig.entityLighting);
    copyResolvedInto(env, resolved);
  }

  /**
   * 相机基线 zoom：激活位面配置了 camera.zoom 时以位面档为基线，否则场景 JSON zoom（缺省 1）。
   * 所有"恢复场景 zoom"路径（restoreSceneCameraZoom / fadingRestoreSceneCameraZoom，
   * 对话与演出收尾走它）必须恢复到该基线——按裸场景 zoom 恢复会把位面相机档静默盖掉。
   */
  private getCameraBaselineZoom(): number {
    const planeZoom = this.planeReconciler.getActiveCameraZoom();
    if (planeZoom !== null) return planeZoom;
    const z = this.sceneManager.currentSceneData?.camera?.zoom;
    return z !== undefined && Number.isFinite(z) && z > 0 ? z : 1;
  }

  /**
   * 位面光照档钩子（PlaneReconciler 经 bindRuntime 调用）：
   * - partial 非空：把该档经 resolveLightEnv 补全后按 updateLightEnvFromCurve 的推送序列
   *   写进光照管线，并挂起 lightEnvCurve（同 F2 打开时的让位规则，见 updateLightEnvFromCurve）。
   * - null：清除覆盖并恢复场景默认光照（有曲线的场景下一帧由曲线自然接管）。
   * 幂等：重复以同一档调用只是重推同值；override 已空时传 null 为 no-op。
   * 场景光照未启用（无 currentLightEnv）时仅记录覆盖，切场景后由 scene:ready 对账重贴。
   */
  applyPlaneLightEnvOverride(partial: SceneLightEnv | null): void {
    if (!partial && !this.planeLightEnvOverride) return;
    this.planeLightEnvOverride = partial;
    const env = this.currentLightEnv;
    if (!env) return;
    const prevMode = env.shadow.mode;
    const resolved = resolveLightEnv(
      partial ?? this.sceneManager.currentSceneData?.lightEnv,
      this.gameConfig.entityLighting,
    );
    copyResolvedInto(env, resolved);
    this.sceneDepthSystem.applyKeyAmbient(
      env.key.color, env.key.intensity, env.ambient.color, env.ambient.intensity,
    );
    this.applyShadowAndAO();
    if (env.shadow.mode !== prevMode) this.rebuildEntityShadows();
  }

  /**
   * 每帧：若有光照环境曲线，按玩家投影位置插值并把新环境推给阴影/滤镜。
   * 无曲线时单次 null 检查即返回 —— 对现有场景零影响。
   */
  private updateLightEnvFromCurve(): void {
    const env = this.currentLightEnv;
    if (!this.currentLightCurve || !env) return;          // 无曲线/无环境=零影响
    if (this.planeLightEnvOverride) return;               // 位面光照档激活期间曲线挂起（同 F2 让位）
    if (this.debugPanelUI?.isOpen) return;                // F2 光照调试期间让出控制权（避免被逐帧覆盖）
    const prevMode = env.shadow.mode;
    this.resolveLightCurveInto(this.player.x, this.player.y, env);
    // key/ambient 颜色强度、tone/AO 走滤镜 setter 广播（覆盖构造时烘焙值）；
    // 阴影方向/长度/暗度等由 updateEntityShadows 逐帧从 env 读取，无需额外推送。
    this.sceneDepthSystem.applyKeyAmbient(
      env.key.color, env.key.intensity, env.ambient.color, env.ambient.intensity,
    );
    this.applyShadowAndAO();
    // 仅当 shadow.mode 真正变化（跨关键帧切 real/planar/off）才重建阴影实例（罕见）
    if (env.shadow.mode !== prevMode) this.rebuildEntityShadows();
  }

  /** 每帧更新投影阴影（位置/剪影/朝向跟随实体）。ShadowSource 复用缓存（F2 性能）；
   *  仍按当前实体列表寻址——实例被过场重建（owner 变化）时就地换源，不更新已不在场的实体。 */
  private updateEntityShadows(): void {
    const env = this.currentLightEnv;
    if (!env || this.entityShadows.size === 0) return;

    const field = this.currentShadowField;
    const playerEntry = this.entityShadows.get('player');
    if (playerEntry) {
      playerEntry.shadow.update(playerEntry.src, env, field);
    }
    for (const npc of this.sceneManager.getCurrentNpcs()) {
      const entry = this.entityShadows.get(npc.id);
      if (!entry) continue;
      if (entry.owner !== npc) {
        entry.owner = npc;
        entry.src = this.makeNpcShadowSource(npc);
      }
      entry.shadow.update(entry.src, env, field);
    }
    for (const h of this.sceneManager.getCurrentHotspots()) {
      const entry = this.entityShadows.get(`hotspot:${h.def.id}`);
      if (!entry) continue;
      if (entry.owner !== h) {
        entry.owner = h;
        entry.src = this.makeHotspotShadowSource(h);
      }
      entry.shadow.update(entry.src, env, field);
    }
  }

  private makePlayerShadowSource(): ShadowSource {
    const p = this.player;
    return {
      getFootX: () => p.x,
      getFootY: () => p.y,
      getWorldWidth: () => p.sprite.getWorldSize().width,
      getWorldHeight: () => p.sprite.getWorldSize().height,
      getTexture: () => p.sprite.getDisplayTexture(),
      getFacing: () => (p.facingDirection === 'left' ? -1 : 1),
      isVisible: () => p.sprite.container.visible,
    };
  }

  private makeNpcShadowSource(npc: Npc): ShadowSource {
    return {
      getFootX: () => npc.x,
      getFootY: () => npc.y,
      getWorldWidth: () => npc.getWorldSize().width,
      getWorldHeight: () => npc.getWorldSize().height,
      getTexture: () => npc.getDisplayTexture(),
      getFacing: () => npc.getFacing(),
      isVisible: () => npc.container.visible,
    };
  }

  private makeHotspotShadowSource(h: Hotspot): ShadowSource {
    return {
      getFootX: () => h.container.x,
      getFootY: () => h.depthOcclusionFootWorldY(),
      getWorldWidth: () => h.getWorldSize().width,
      getWorldHeight: () => h.getWorldSize().height,
      getTexture: () => h.getDisplayTexture(),
      getFacing: () => h.getFacing(),
      isVisible: () => h.container.visible,
    };
  }

  private clearEntityShadows(): void {
    for (const entry of this.entityShadows.values()) {
      this.sceneDepthSystem.unregisterShadow(entry.shadow);
      entry.shadow.destroy();
    }
    this.entityShadows.clear();
  }

  // ---- F2 投影阴影实时调试：直接改当前解析的 LightEnv（逐帧被阴影读取），仅影响渲染 ----
  private entityShadowDebugActive(): boolean {
    return this.sceneDepthSystem.isLightingEnabled && this.currentLightEnv !== null;
  }

  private getEntityShadowDebug(): { mode: string; toneEnabled: boolean; billboard: string; enabled: boolean; azimuthDeg: number; elevationDeg: number; lengthFactor: number; darkness: number; contact: number; contactSize: number; softSamples: number } | null {
    const e = this.currentLightEnv;
    if (!e) return null;
    return {
      mode: e.shadow.mode,
      toneEnabled: e.toneEnabled,
      billboard: e.shadow.billboard,
      enabled: e.shadow.enabled,
      azimuthDeg: e.key.azimuthDeg,
      elevationDeg: e.key.elevationDeg,
      lengthFactor: e.shadow.length,
      darkness: e.shadow.darkness,
      contact: e.shadow.contact,
      contactSize: e.shadow.contactSize,
      softSamples: e.shadow.softSamples,
    };
  }

  private cycleShadowModeDebug(): void {
    const e = this.currentLightEnv;
    if (!e) return;
    e.shadow.mode = e.shadow.mode === 'real' ? 'planar' : e.shadow.mode === 'planar' ? 'off' : 'real';
    this.applyShadowModeChange();
  }

  private toggleEntityToneDebug(): void {
    const e = this.currentLightEnv;
    if (!e) return;
    e.toneEnabled = !e.toneEnabled;
    this.applyShadowAndAO();
  }

  private toggleEntityShadowBillboardDebug(): void {
    const e = this.currentLightEnv;
    if (!e) return;
    e.shadow.billboard = e.shadow.billboard === 'light' ? 'camera' : 'light';
  }

  private nudgeEntityShadowElevationDebug(delta: number): void {
    const e = this.currentLightEnv;
    if (!e) return;
    e.key.elevationDeg = Math.max(5, Math.min(85, e.key.elevationDeg + delta));
  }

  private nudgeEntityShadowSoftSamplesDebug(delta: number): void {
    const e = this.currentLightEnv;
    if (!e) return;
    e.shadow.softSamples = Math.max(1, Math.min(8, Math.round(e.shadow.softSamples + delta)));
  }

  private setEntityShadowAzimuthDebug(deg: number): void {
    const e = this.currentLightEnv;
    if (!e || !Number.isFinite(deg)) return;
    e.key.azimuthDeg = ((deg % 360) + 360) % 360;
  }

  private nudgeEntityShadowLengthDebug(delta: number): void {
    const e = this.currentLightEnv;
    if (!e) return;
    e.shadow.length = Math.max(0.05, Math.min(3, e.shadow.length + delta));
  }

  private nudgeEntityShadowDarknessDebug(delta: number): void {
    const e = this.currentLightEnv;
    if (!e) return;
    e.shadow.darkness = Math.max(0, Math.min(1, e.shadow.darkness + delta));
  }

  private nudgeEntityShadowContactDebug(delta: number): void {
    const e = this.currentLightEnv;
    if (!e) return;
    e.shadow.contact = Math.max(0, Math.min(1, e.shadow.contact + delta));
  }

  private nudgeEntityShadowContactSizeDebug(delta: number): void {
    const e = this.currentLightEnv;
    if (!e) return;
    e.shadow.contactSize = Math.max(0.1, Math.min(3, e.shadow.contactSize + delta));
  }

  private toggleEntityShadowEnabledDebug(): void {
    const e = this.currentLightEnv;
    if (!e) return;
    e.shadow.enabled = !e.shadow.enabled;
  }

  /**
   * travel 槽门闸：当前位面禁止地图快速旅行时拒绝并 toast 提示。
   * 面板 openGuard 与 EventBridge 的 map:travel 双闸共用（后者兜脚本/竞态路径）。
   */
  /**
   * 条件求值上下文唯一工厂（律5 统一条件源）：所有条件消费方——包括 Game 内部的手工求值点
   * （糖转盘 beforeCharge、depth_floor 每帧偏移）——一律经此构造。手工拼缩水上下文会缺
   * plane/@scene/@owner 叶子，同一条件在不同入口得出不同结果（plane 叶子缺 getter 时
   * 静默按 'normal' 求值）。
   */
  private buildConditionEvalContext(): ConditionEvalContext {
    return {
      flagStore: this.flagStore,
      questManager: this.questManager,
      scenarioState: this.scenarioStateManager,
      narrativeState: this.narrativeStateManager,
      resolveConditionLiteral: (raw) => this.resolveDisplayText(raw),
      // `@scene` 解析为当前场景 wrapper；`@owner` 在 onEnter 期间继承场景 owner
      // （对话内由 GraphDialogueManager.conditionCtx 覆盖为对话 owner）。
      currentSceneId: this.sceneManager.currentSceneData?.id ?? undefined,
      currentOwner: this.ambientNarrativeOwner ?? undefined,
      // plane 叶子：当前激活位面（含 manual override）；全部条件消费方经此工厂自动可用
      getActivePlaneId: () => this.planeReconciler.getActivePlaneId(),
    };
  }

  private guardMapTravel(): boolean {
    if (this.planeReconciler.isMapTravelAllowed()) return true;
    this.eventBus.emit('notification:show', {
      text: this.stringsProvider.get('notifications', 'mapTravelBlocked'),
      type: 'warning',
    });
    return false;
  }

  private registerUIPanels(): void {
    this.stateController.registerPanel('quest', this.questPanelUI, 'Tab');
    this.stateController.registerPanel('inventory', this.inventoryUI, 'KeyI');
    this.stateController.registerPanel('rules', this.rulesPanelUI, 'KeyR');
    this.stateController.registerPanel('dialogueLog', this.dialogueLogUI, 'KeyL');
    this.stateController.registerPanel('bookshelf', this.bookshelfUI, 'KeyB');
    this.stateController.registerPanel('map', this.mapUI, 'KeyM', {
      openGuard: () => this.guardMapTravel(),
    });
    this.stateController.registerPanel('ruleUse', this.ruleUseUI, 'KeyF');
    this.stateController.registerPanel('shop', this.shopUI);
    this.stateController.registerPanel('menu', this.menuUI);
    /** T1：F2 调试坞仅 DEV 注册（门控判据与 TouchMobileControls 的「调试」chip 一致）；
     *  生产构建下 F2 与触屏调试入口都不存在。 */
    if (import.meta.env.DEV) {
      this.stateController.registerPanel('debug', this.debugPanelUI, 'F2', {
        alwaysOpenable: true,
        overlaysGameState: false,
      });
    }

    this.stateController.setEscapeFallback(() => {
      /** η2a 交接收敛：统一走 togglePanel（压栈进 UIOverlay、开暂停菜单；Esc/closePanel
       *  按栈恢复），不再手工 setState+openPauseMenu 造成压栈不平衡。 */
      this.stateController.togglePanel('menu');
    });

    const touchMount = document.getElementById('game-mount');
    if (touchMount) {
      this.touchMobileControls = new TouchMobileControls(
        this.inputManager,
        this.stateController,
        () => this.stateController.currentState,
        touchMount,
        this.stringsProvider,
      );
    }
  }

  /** F2「日志」页：深度加载与背景调试绑定验证（便于真机排查） */
  private logDepthDiag(message: string): void {
    this.debugPanelUI?.log(`[深度诊断] ${message}`);
  }

  /**
   * 深度图 GPU 侧 isTexture、两个自定义 GlProgram 预热，并在每步后 drain gl.getError 到调试面板。
   */
  private runDepthAndShaderGlDiagnostics(sceneId: string, dt: Texture | null, depthEnabled: boolean): void {
    const gl = tryGetWebGlFromApplication(this.renderer.app);
    if (!gl) {
      this.debugPanelUI?.log('[GL诊断] 当前渲染器无 gl（可能为 WebGPU），跳过 getError / isTexture');
      return;
    }
    if (depthEnabled && dt) {
      pixiInitTextureSourceForGpu(this.renderer.app.renderer, dt.source);
      drainWebGLErrorsToPanel(gl, (m) => this.debugPanelUI?.log(m), `${sceneId} 深度 initSource 后`);
      logDepthTextureGpuStatus(
        `${sceneId} 深度贴图(GPU)`,
        dt,
        this.renderer.app.renderer,
        gl,
        (m) => this.debugPanelUI?.log(m),
      );
    } else if (!depthEnabled) {
      this.debugPanelUI?.log(`[GL诊断] ${sceneId}: depthEnabled=false，跳过深度 GPU 探测`);
    }

    try {
      warmUpDepthOcclusionGlProgramForDiagnostics();
      this.debugPanelUI?.log('[GL诊断] DepthOcclusion GlProgram 已创建/命中缓存');
    } catch (e) {
      this.debugPanelUI?.log(`[GL诊断] DepthOcclusion GlProgram 失败: ${String(e)}`);
    }
    drainWebGLErrorsToPanel(gl, (m) => this.debugPanelUI?.log(m), `${sceneId} DepthOcclusion shader 后`);

    try {
      warmUpBackgroundDebugGlProgramForDiagnostics();
      this.debugPanelUI?.log('[GL诊断] BackgroundDebug GlProgram 已创建/命中缓存');
    } catch (e) {
      this.debugPanelUI?.log(`[GL诊断] BackgroundDebug GlProgram 失败: ${String(e)}`);
    }
    drainWebGLErrorsToPanel(gl, (m) => this.debugPanelUI?.log(m), `${sceneId} BackgroundDebug shader 后`);

    drainWebGLErrorsToPanel(gl, (m) => this.debugPanelUI?.log(m), `${sceneId} depthLoader 收尾`);
  }

  private setupSceneReadyHandler(): void {
    this.listenEvent('scene:beforeUnload', () => {
      this.patrolGeneration++;
      this.npcPatrolEpoch.clear();
      for (const h of this.sceneManager.getCurrentHotspots()) {
        const f = h.detachDepthOcclusionFilter();
        if (f) {
          this.sceneDepthSystem.removeFilter(f);
          f.destroy();
        }
      }
    });
    this.listenEvent('scene:ready', () => {
      this.player.syncMovementFromScene(this.sceneManager.currentSceneData);
      this.interactionSystem.update(0);

      const lightingOn = this.sceneDepthSystem.isLightingEnabled;
      try {
        const playerLift = 0.4 * this.player.sprite.getWorldSize().height;
        this.playerDepthFilter = lightingOn
          ? this.sceneDepthSystem.createLightingFilterForEntity(playerLift)
          : this.sceneDepthSystem.createFilterForEntity();
        if (this.playerDepthFilter) {
          depthLog('Game', 'attaching entity filter to player, lighting=', lightingOn);
          this.player.sprite.container.filters = [this.playerDepthFilter];
        } else {
          depthLog('Game', 'no entity filter for player (disabled or no data)');
          this.player.sprite.container.filters = [];
        }
      } catch (e) {
        depthError('Game', 'player filter FAILED', e);
        this.playerDepthFilter = null;
        this.player.sprite.container.filters = [];
      }

      for (const npc of this.sceneManager.getCurrentNpcs()) {
        this.attachNpcSceneFilters(npc);
        this.startNpcPatrolIfEligible(npc);
      }

      for (const h of this.sceneManager.getCurrentHotspots()) {
        this.attachHotspotDepthFilter(h);
      }

      this.rebuildEntityShadows();
      this.applyShadowAndAO();
      this.syncEntityPixelDensityMatch();

      // 背景调试可视化：传递当前场景的深度纹理和配置
      const sd = this.sceneManager.currentSceneData!;
      const dTex = this.sceneDepthSystem.currentDepthTexture;
      const dCfg = this.sceneDepthSystem.currentConfig;
      if (sd.depthConfig && (!dTex || !dCfg)) {
        this.logDepthDiag(
          `scene:ready ${sd.id}: JSON 含 depthConfig 但运行期无 depthTexture/config，F2 深度仍为占位`,
        );
      }
      if (dTex && dCfg) {
        this.depthDebugVisualizer.onSceneLoaded(
          this.sceneDepthSystem.currentSceneId,
          dTex,
          dTex.width,
          dTex.height,
          sd.worldWidth,
          sd.worldHeight,
          dCfg,
        );
        this.logDepthDiag(
          `scene:ready: 背景调试已绑定 uid=${dTex.uid} ${dTex.width}x${dTex.height} WHITE=${dTex === Texture.WHITE}`,
        );
        const glR = tryGetWebGlFromApplication(this.renderer.app);
        if (glR) {
          pixiInitTextureSourceForGpu(this.renderer.app.renderer, dTex.source);
          logDepthTextureGpuStatus(
            `scene:ready ${sd.id} 深度贴图(GPU)`,
            dTex,
            this.renderer.app.renderer,
            glR,
            (m) => this.debugPanelUI?.log(m),
          );
          drainWebGLErrorsToPanel(glR, (m) => this.debugPanelUI?.log(m), `scene:ready ${sd.id}`);
        }
      }
    });

    /** B11：过场进入/退出重建的实体是全新实例，scene:ready 附加的滤镜/巡逻/阴影随旧实例
     *  销毁——此处对重建实体复用 scene:ready 的附加逻辑。巡逻仅在 exit 阶段重启：
     *  enter 阶段过场拥有实体动线（自动巡逻会与 moveEntityTo 抢），与重建前行为一致。 */
    this.listenEvent(
      'scene:entitiesRebuilt',
      (p: { cutsceneId: string; phase: 'enter' | 'exit'; hotspotIds: string[]; npcIds: string[] }) => {
        for (const id of p.npcIds ?? []) {
          const npc = this.sceneManager.getNpcById(id);
          if (!npc) continue;
          // 防双协程：旧实例协程按 npcPatrolEpoch 立即失效，再按条件评估重启
          this.stopNpcPatrol(id);
          this.attachNpcSceneFilters(npc);
          if (p.phase === 'exit') this.startNpcPatrolIfEligible(npc);
        }
        for (const id of p.hotspotIds ?? []) {
          const h = this.sceneManager.getCurrentHotspots().find((x) => x.def.id === id);
          if (!h) continue;
          this.attachHotspotDepthFilter(h);
        }
        // 只对本次重建的实体换阴影实例（不整体销毁重建全场），与 owner-swap 缓存一致。
        this.rebuildEntityShadowsForIds(p.npcIds ?? [], p.hotspotIds ?? []);
        this.applyShadowAndAO();
        this.syncEntityPixelDensityMatch();
      },
    );
  }

  /** scene:ready 与 scene:entitiesRebuilt 共用：为 NPC 附加光照/深度遮挡滤镜。 */
  private attachNpcSceneFilters(npc: Npc): void {
    if (npc.def.renderRaw) { npc.container.filters = []; return; }
    const lightingOn = this.sceneDepthSystem.isLightingEnabled;
    try {
      const npcLift = 0.4 * npc.getWorldSize().height;
      const npcFilter = lightingOn
        ? this.sceneDepthSystem.createLightingFilterForEntity(npcLift)
        : this.sceneDepthSystem.createFilterForEntity();
      if (npcFilter) {
        depthLog('Game', 'attaching entity filter to NPC:', npc.id, 'lighting=', lightingOn);
        npc.container.filters = [npcFilter];
      }
    } catch (e) {
      depthError('Game', 'NPC filter FAILED', npc.id, e);
    }
  }

  /** scene:ready 与 scene:entitiesRebuilt（exit 阶段）共用：条件满足则启动巡逻协程。 */
  private startNpcPatrolIfEligible(npc: Npc): void {
    const patrol = npc.def.patrol;
    if (
      npc.container.visible &&
      patrol?.route &&
      patrol.route.length > 0 &&
      !this.sceneManager.isNpcPatrolPersistentlyDisabled(npc.id)
    ) {
      this.runNpcPatrol(npc, patrol.route, patrol.speed ?? 60, patrol.moveAnimState);
    }
  }

  /** scene:ready 与 scene:entitiesRebuilt 共用：带展示图的热点附加深度遮挡滤镜。 */
  private attachHotspotDepthFilter(h: Hotspot): void {
    if (!h.hasDepthDisplayImage()) return;
    try {
      const hf = this.sceneDepthSystem.createFilterForEntity();
      if (hf) {
        depthLog('Game', 'attaching depth filter to hotspot display:', h.def.id);
        h.attachDepthOcclusionFilter(hf);
      }
    } catch (e) {
      depthError('Game', 'hotspot depth filter FAILED', h.def.id, e);
    }
  }

  private narrativeWarps: DevNarrativeWarp[] = [];

  /** dev 启动直达路由：startDevMode 组装、start() 在 ticker 挂载后执行（见 startDevMode 注释） */
  private devStartupRoute: (() => Promise<void>) | null = null;

  private async loadNarrativeWarps(): Promise<void> {
    try {
      const data = await this.assetManager.loadJson<{ warps?: DevNarrativeWarp[] }>(
        '/assets/data/dev_narrative_warps.json',
      );
      this.narrativeWarps = Array.isArray(data?.warps) ? data.warps : [];
    } catch {
      this.narrativeWarps = [];
    }
  }

  /** dev 跳转：把主流程图推进到 flowState（逐个 setState 使前置 reached、任务链推进），
   *  再按 set 设各状态，最后进入对应场景。BFS 求 initial→flowState 迁移路径——
   *  分支图取最短路径，线性图与旧实现一致；不可达时明确报错并跳过主线推进。 */
  private async enterNarrativeWarp(id: string): Promise<void> {
    const warp = this.narrativeWarps.find((w) => w.id === id);
    if (!warp) return;
    if (warp.flowGraph && warp.flowState) {
      const graph = this.narrativeStateManager.getGraph(warp.flowGraph);
      if (!graph) {
        console.warn(`enterNarrativeWarp: 找不到流程图 "${warp.flowGraph}"`);
      } else {
        const adjacency = new Map<string, string[]>();
        for (const t of graph.transitions ?? []) {
          const arr = adjacency.get(t.from);
          if (arr) arr.push(t.to);
          else adjacency.set(t.from, [t.to]);
        }
        const start = graph.initialState;
        const cameFrom = new Map<string, string>();
        const seen = new Set<string>([start]);
        const queue: string[] = [start];
        while (queue.length > 0) {
          const cur = queue.shift()!;
          if (cur === warp.flowState) break;
          for (const next of adjacency.get(cur) ?? []) {
            if (seen.has(next)) continue;
            seen.add(next);
            cameFrom.set(next, cur);
            queue.push(next);
          }
        }
        if (!seen.has(warp.flowState)) {
          console.warn(
            `enterNarrativeWarp: 流程图 "${warp.flowGraph}" 从 "${start}" 无迁移路径可达 "${warp.flowState}"，已跳过主线推进`,
          );
        } else {
          const path: string[] = [];
          for (let s: string | undefined = warp.flowState; s !== undefined; s = cameFrom.get(s)) {
            path.unshift(s);
            if (s === start) break;
          }
          for (const s of path) {
            await this.narrativeStateManager.debugSetNarrativeState(warp.flowGraph, s);
          }
        }
      }
    }
    for (const st of warp.set ?? []) {
      await this.narrativeStateManager.debugSetNarrativeState(st.graph, st.state);
    }
    await this.devLoadScene(warp.scene);
  }

  private async startDevMode(
    playCutscene?: string,
    waterPreview?: string,
    sugarWheelPreview?: string,
    paperCraftPreview?: string,
    devScene?: string,
    narrativeWarp?: string,
    visualCapture: boolean = false,
  ): Promise<void> {
    const DEV_SCENE = 'dev_room';
    await this.sceneManager.loadScene(DEV_SCENE);

    await this.loadNarrativeWarps();
    this.devModeUI = new DevModeUI(this.renderer, {
      getCutsceneIds: () => this.cutsceneManager.getCutsceneIds(),
      playCutscene: (id: string) => this.devPlayCutscene(id),
      getScenes: () => this.getDevSceneEntries(),
      loadScene: (id: string) => {
        void this.devLoadScene(id);
      },
      reload: () => this.devReload(),
      getMinigameEntries: () => [
        ...this.waterMinigameManager.getInstanceList().map((e) => ({
          ...e,
          kind: 'water' as const,
        })),
        ...this.sugarWheelMinigameManager.getInstanceList().map((e) => ({
          ...e,
          kind: 'sugarWheel' as const,
        })),
        ...this.paperCraftMinigameManager.getInstanceList().map((e) => ({
          ...e,
          kind: 'paperCraft' as const,
        })),
      ],
      launchMinigame: (entry) => {
        this.devModeUI?.close();
        if (entry.kind === 'sugarWheel') {
          void this.sugarWheelMinigameManager.start(entry.id);
        } else if (entry.kind === 'paperCraft') {
          void this.paperCraftMinigameManager.start(entry.id);
        } else {
          void this.waterMinigameManager.start(entry.id);
        }
      },
      getNarrativeWarps: () => this.narrativeWarps.map((w) => ({ id: w.id, label: w.label })),
      enterNarrativeWarp: (id: string) => { void this.enterNarrativeWarp(id); },
    });
    if (!visualCapture) this.devModeUI.open();

    this.waterMinigameManager.setOnSessionEnd(() => {
      if (!this.isDevMode) return;
      const sid = this.sceneManager.currentSceneData?.id;
      if (sid === 'dev_room') this.devModeUI?.open();
    });
    this.sugarWheelMinigameManager.setOnSessionEnd(() => {
      if (!this.isDevMode) return;
      const sid = this.sceneManager.currentSceneData?.id;
      if (sid === 'dev_room') this.devModeUI?.open();
    });
    this.paperCraftMinigameManager.setOnSessionEnd(() => {
      if (!this.isDevMode) return;
      const sid = this.sceneManager.currentSceneData?.id;
      if (sid === 'dev_room') this.devModeUI?.open();
    });

    window.__gameDevAPI = {
      playCutscene: (id: string) => this.devPlayCutscene(id),
      reload: () => this.devReload(),
      isReady: () => true,
      openDevPanel: () => this.devModeUI?.open(),
      getNarrativeDebugSnapshot: () => this.buildRuntimeDebugSnapshot('dev-api'),
      clearNarrativeDebugTrace: () => this.narrativeStateManager.clearDebugTrace(),
      emitNarrativeSignal: (signal) => this.narrativeStateManager.emitNarrativeSignal({
        sourceType: String(signal?.sourceType ?? '').trim() as any,
        sourceId: String(signal?.sourceId ?? '').trim(),
        signal: String(signal?.signal ?? '').trim(),
      }),
      debugSetNarrativeState: (graphId, stateId) =>
        this.narrativeStateManager.debugSetNarrativeState(String(graphId ?? '').trim(), String(stateId ?? '').trim()),
      setNarrativeState: (graphId, stateId) =>
        this.narrativeStateManager.debugSetNarrativeState(String(graphId ?? '').trim(), String(stateId ?? '').trim()),
      setDepthDebug: (enabled) => this.sceneDepthSystem.setDebugOnFilters(enabled),
      clearWorldFilter: () => this.renderer.clearWorldFilter(),
      setWorldFadeAlpha: (alpha) => this.cutsceneRenderer.setDebugWorldFadeAlpha(alpha),
      completeDialogueText: () => this.dialogueUI.debugCompleteText(),
      startMinigame: async (kind, id) => {
        this.devModeUI?.close();
        if (kind === 'water') await this.waterMinigameManager.start(id);
        else if (kind === 'sugarWheel') await this.sugarWheelMinigameManager.start(id);
        else if (kind === 'paperCraft') await this.paperCraftMinigameManager.start(id);
        else {
          const request = this.pressureHoldManager.getDebugPreviewRequest(id);
          if (!request) return false;
          this.pressureHoldUI.showDebugPreview(request, 0.42);
        }
        return kind === 'water'
          ? this.waterMinigameManager.isActive
          : kind === 'sugarWheel'
            ? this.sugarWheelMinigameManager.isActive
            : kind === 'paperCraft'
              ? this.paperCraftMinigameManager.isActive
              : this.pressureHoldUI.isActive();
      },
      stepFixedTicks: (ticks, dtMs) => this.debugStepTicks(ticks, dtMs),
      getMinigameDebugState: () => ({
        water: this.waterMinigameManager.getDebugVisualState(),
        sugarWheel: this.sugarWheelMinigameManager.getDebugVisualState(),
        paperCraft: this.paperCraftMinigameManager.getDebugVisualState(),
        pressureHold: this.pressureHoldUI.getDebugVisualState(),
      }),
      playAudioProbe: (id, fadeMs) => this.audioManager.playBgm(id, fadeMs),
      getAudioDebugState: () => this.audioManager.getDebugOutputState(),
      suppressSceneEnterForVisualCapture: () => this.sceneManager.setSceneEnterRunner(null),
    };
    /** 启动直达路由（过场直启 / 场景直达 / 各小游戏预览）需要主 tick 驱动位移与小游戏
     *  update——存起来由 start() 在 `ticker.add(mainTick)` 之后调用（真实就绪信号，
     *  替代旧 300/900/450ms 魔数延时）；顺序 await 保证过场播完才进下一站。 */
    this.devStartupRoute = async () => {
      if (playCutscene) await this.devPlayCutscene(playCutscene);
      const nw = (narrativeWarp ?? '').trim();
      if (nw) {
        await this.enterNarrativeWarp(nw);
        return;
      }
      const ds = (devScene ?? '').trim();
      if (ds) {
        if (ds !== DEV_SCENE) await this.devLoadScene(ds);
        return;
      }
      const wp = (waterPreview ?? '').trim();
      if (wp) {
        this.devModeUI?.close();
        await this.waterMinigameManager.start(wp);
        return;
      }
      const swp = (sugarWheelPreview ?? '').trim();
      if (swp) {
        this.devModeUI?.close();
        await this.sugarWheelMinigameManager.start(swp);
        return;
      }
      const pcp = (paperCraftPreview ?? '').trim();
      if (pcp) {
        this.devModeUI?.close();
        await this.paperCraftMinigameManager.start(pcp);
      }
    };
  }

  private async devPlayCutscene(id: string): Promise<void> {
    if (this.cutsceneManager.isPlaying) return;
    this.devModeUI?.close();
    this.stateController.setState(GameState.Cutscene);
    /** 过场抛错时也必须复位状态机（对齐 tryStartInitialPrologue），否则 GameState 卡在 Cutscene、
     *  输入被门控。startCutscene 自身 finally 已回收其资源，这里只兜 Game 层状态。 */
    try {
      await this.cutsceneManager.startCutscene(id);
    } catch (e) {
      console.warn('DevMode: 过场播放失败', id, e);
    } finally {
      this.stateController.setState(GameState.Exploring);
    }
    if (this.isDevMode) {
      const currentScene = this.sceneManager.currentSceneData?.id;
      if (currentScene !== 'dev_room') {
        await this.sceneManager.switchScene('dev_room');
      }
      this.devModeUI?.open();
    }
  }

  private devReload(): void {
    window.location.reload();
  }

  /** 开发模式场景列表：地图节点 + game_config 入口/回退 + dev_room，去重排序 */
  private getDevSceneIds(): string[] {
    const ids = new Set<string>();
    for (const sid of this.mapUI.getConfiguredSceneIds()) ids.add(sid);
    ids.add('dev_room');
    if (this.gameConfig.initialScene) ids.add(this.gameConfig.initialScene);
    if (this.gameConfig.fallbackScene) ids.add(this.gameConfig.fallbackScene);
    return Array.from(ids).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  }

  /** 开发模式列表展示名取自各场景 JSON 的 name，缺省或加载失败时用 id */
  private async getDevSceneEntries(): Promise<Array<{ id: string; name: string }>> {
    const ids = this.getDevSceneIds();
    return Promise.all(
      ids.map(async (id) => {
        try {
          const raw = await this.assetManager.loadJson<SceneDataRaw>(sceneJsonUrl(id));
          const n = raw.name;
          const name = typeof n === 'string' && n.trim() ? n.trim() : id;
          return { id, name };
        } catch {
          return { id, name: id };
        }
      }),
    );
  }

  private async devLoadScene(sceneId: string): Promise<void> {
    if (!sceneId || this.sceneManager.switching) return;
    this.devModeUI?.close();
    try {
      await this.sceneManager.switchScene(sceneId);
      this.mapUI.setCurrentScene(sceneId);
      // dev_room 是开发模式枢纽：回到此处时再打开 Dev 面板；其它场景保持关闭以免挡画面
      if (this.isDevMode && sceneId === 'dev_room') {
        this.devModeUI?.open();
      }
    } catch (e) {
      console.warn('DevMode: failed to load scene', sceneId, e);
    }
  }

  private async tryStartInitialPrologue(): Promise<void> {
    const cutsceneId = this.gameConfig.initialCutscene;
    if (!cutsceneId) return;
    const doneFlag = this.gameConfig.initialCutsceneDoneFlag;
    if (doneFlag && this.flagStore.get(doneFlag)) return;

    this.stateController.setState(GameState.Cutscene);
    try {
      await this.cutsceneManager.startCutscene(cutsceneId);
      /** B17：过场内 setFlag 被全局黑名单拦截，「播过不再播」的标记由 Game 侧在
       *  播完后写入；失败不写（下次启动重试），并对齐 startCutscene 失败即恢复模式。 */
      if (doneFlag) this.flagStore.set(doneFlag, true);
    } catch (e) {
      console.warn('Game: 序章过场播放失败', cutsceneId, e);
    } finally {
      this.stateController.setState(GameState.Exploring);
    }
  }

  private collectSaveData(): Record<string, object> {
    const data: Record<string, object> = {
      flagStore: this.flagStore.serialize(),
    };
    for (const entry of this.registeredSystems) {
      if (entry.system) data[entry.name] = entry.system.serialize();
    }
    data.dialogueLog = this.dialogueLogUI.serialize();
    data.game = { playTimeMs: this.playTimeMs, randomState: this.runtimeRandom.getState() };
    return data;
  }

  private distributeSaveData(data: Record<string, object>): void {
    /** 读档开始信号：HUD 等纯事件驱动的展示层先清上一局残留（任务追踪等），
     *  随后各系统 deserialize 补发的事件（quest:accepted{restored} 等）重建显示。 */
    this.eventBus.emit('save:restoring', {});
    // 读档期间抑制 QuestManager / ArchiveManager 对 flag:changed 的反应：
    // 各系统 deserialize 会逐个 syncFlag → emit flag:changed，但此刻 scenario/narrative/档案集合
    // 可能尚未恢复，按半态重评会导致任务误判完成/激活、以及虚假“档案更新”通知。
    // 全部恢复后再放开；恢复出的状态本身自洽，无需强制重评。
    this.questManager.setRestoring(true);
    this.archiveManager.setRestoring(true);
    try {
      if (data['flagStore']) this.flagStore.deserialize(data['flagStore'] as Record<string, boolean | number>);
      for (const entry of this.registeredSystems) {
        if (entry.system && data[entry.name]) entry.system.deserialize(data[entry.name]);
      }
      if (data['dialogueLog']) this.dialogueLogUI.deserialize(data['dialogueLog'] as any);
      if (data['game']) {
        this.playTimeMs = (data['game'] as any).playTimeMs ?? 0;
        this.runtimeRandom.setState((data['game'] as any).randomState);
      }
    } finally {
      this.questManager.setRestoring(false);
      this.archiveManager.setRestoring(false);
    }
  }

  private getEntityPixelDensityMatchEffective(): boolean {
    if (this.entityPixelDensityMatchDebugOverride !== null) {
      return this.entityPixelDensityMatchDebugOverride;
    }
    return this.gameConfig.entityPixelDensityMatch === true;
  }

  /** 配置开启且能读到背景密度时，才做低通与整像素对齐（与 syncEntityPixelDensityMatch 一致） */
  private isEntityPixelDensityMatchRenderingOn(): boolean {
    const dBg = this.sceneManager.getBackgroundTexelsPerWorld();
    return dBg != null && this.getEntityPixelDensityMatchEffective();
  }

  private getEntityPixelDensityMatchBlurScaleFromConfig(): number {
    const v = this.gameConfig.entityPixelDensityMatchBlurScale;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      return DEFAULT_ENTITY_PIXEL_DENSITY_BLUR_SCALE;
    }
    return v;
  }

  /** 配置与调试覆盖合成后的强度倍率（0.05～5） */
  private getEntityPixelDensityMatchBlurScale(): number {
    const cfg = this.getEntityPixelDensityMatchBlurScaleFromConfig();
    const raw =
      this.entityPixelDensityMatchBlurScaleDebug !== null
        ? this.entityPixelDensityMatchBlurScaleDebug
        : cfg;
    return Math.min(5, Math.max(0.05, raw));
  }

  private nudgeEntityPixelDensityMatchBlurScaleDebug(delta: number): void {
    const cfg = this.getEntityPixelDensityMatchBlurScaleFromConfig();
    const cur = this.entityPixelDensityMatchBlurScaleDebug ?? cfg;
    this.entityPixelDensityMatchBlurScaleDebug = Math.min(5, Math.max(0.05, cur + delta));
    this.syncEntityPixelDensityMatch();
  }

  private clearEntityPixelDensityMatchBlurScaleDebug(): void {
    this.entityPixelDensityMatchBlurScaleDebug = null;
    this.syncEntityPixelDensityMatch();
  }

  private async setSceneEntityFieldFromAction(
    sceneId: string,
    kind: SceneEntityKind,
    entityId: string,
    fieldName: string,
    value: RuntimeFieldValue,
  ): Promise<void> {
    const currentSceneId = this.sceneManager.currentSceneData?.id ?? '';
    if (this.sceneManager.isCutsceneStagingActive() && sceneId !== currentSceneId) {
      console.warn(
        `setEntityField: 过场中忽略跨场景写入 "${sceneId}"（当前场景 "${currentSceneId || '(无)'}"）`,
      );
      return;
    }
    const checked = coerceRuntimeFieldValue(kind, fieldName, value);
    if (!checked.ok) {
      console.warn('setEntityField:', checked.error);
      return;
    }
    const stored = this.sceneManager.setEntityRuntimeField(sceneId, kind, entityId, fieldName, checked.value);
    if (!stored.ok) {
      console.warn('setEntityField:', stored.error);
      return;
    }
    if (this.sceneManager.currentSceneData?.id !== sceneId) {
      if (fieldName === 'displayImage' && kind === 'hotspot') {
        console.info(
          'setEntityField: displayImage 已写入运行态，但当前显式场景 id 为',
          this.sceneManager.currentSceneData?.id ?? '(无)',
          '与动作中的 sceneId',
          sceneId,
          '不一致；进入该场景时会合并显示。',
        );
      }
      return;
    }
    if (kind === 'npc') {
      await this.applyNpcRuntimeFieldNow(entityId, fieldName, checked.value);
    } else {
      await this.applyHotspotRuntimeFieldNow(entityId, fieldName, checked.value);
    }
  }

  private async setHotspotDisplayImageFromAction(
    sceneId: string,
    hotspotId: string,
    imagePath: string,
    worldWidthIn?: number,
    worldHeightIn?: number,
    facingIn?: 'left' | 'right',
  ): Promise<void> {
    const sid = sceneId.trim();
    const hid = hotspotId.trim();
    const path = imagePath.trim();
    if (!sid || !hid || !path) {
      console.warn('setHotspotDisplayImage: 需要 sceneId、hotspotId 与 image');
      return;
    }
    const currentSceneId = this.sceneManager.currentSceneData?.id ?? '';
    if (this.sceneManager.isCutsceneStagingActive() && sid !== currentSceneId) {
      console.warn(
        `setHotspotDisplayImage: 过场中忽略跨场景写入 "${sid}"（当前场景 "${currentSceneId || '(无)'}"）`,
      );
      return;
    }
    const pathResolved =
      path.startsWith('/') ||
      path.startsWith('http://') ||
      path.startsWith('https://') ||
      path.startsWith('assets/')
        ? path
        : this.assetManager.resolveSceneAssetPath(sid, path);
    let tex: Texture;
    try {
      tex = await this.assetManager.loadTexture(pathResolved);
    } catch (e) {
      console.warn('setHotspotDisplayImage: 贴图加载失败', pathResolved, e);
      return;
    }
    const current = this.sceneManager.currentSceneData?.id === sid
      ? this.sceneManager.getCurrentHotspots().find((x) => x.def.id === hid)
      : null;
    const sceneData = this.sceneManager.currentSceneData?.id === sid
      ? this.sceneManager.currentSceneData
      : await this.assetManager.loadSceneData(sid);
    const base = sceneData.hotspots?.find((h) => h.id === hid);
    const override = this.sceneManager.getEntityRuntimeOverride(sid, 'hotspot', hid);
    const overrideDisplay = override && 'displayImage' in override ? override.displayImage : undefined;
    const prev = current?.def.displayImage ?? overrideDisplay ?? base?.displayImage;
    const tw = Math.max(1, tex.width);
    const th = Math.max(1, tex.height);
    const hFromW = (w: number) => Math.max(0.1, Math.round((w * th) / tw * 10) / 10);
    const wFromH = (h: number) => Math.max(0.1, Math.round((h * tw) / th * 10) / 10);
    const pW =
      worldWidthIn !== undefined && Number.isFinite(worldWidthIn) && worldWidthIn > 0
        ? worldWidthIn
        : undefined;
    const pH =
      worldHeightIn !== undefined && Number.isFinite(worldHeightIn) && worldHeightIn > 0
        ? worldHeightIn
        : undefined;
    const hasW =
      typeof prev?.worldWidth === 'number' && Number.isFinite(prev.worldWidth) && prev.worldWidth > 0;
    const hasH =
      typeof prev?.worldHeight === 'number' &&
      Number.isFinite(prev.worldHeight) &&
      prev.worldHeight > 0;
    let ww: number;
    let hh: number;
    if (pW !== undefined && pH !== undefined) {
      ww = pW;
      hh = pH;
    } else if (pW !== undefined) {
      ww = pW;
      hh = hFromW(ww);
    } else if (pH !== undefined) {
      hh = pH;
      ww = wFromH(hh);
    } else if (hasW && hasH) {
      ww = prev.worldWidth;
      hh = prev.worldHeight;
    } else if (hasW) {
      ww = prev.worldWidth;
      hh = hFromW(ww);
    } else if (hasH) {
      hh = prev.worldHeight;
      ww = wFromH(hh);
    } else {
      ww = 100;
      hh = hFromW(100);
    }
    const displayImage: HotspotDisplayImage = {
      image: pathResolved,
      worldWidth: ww,
      worldHeight: hh,
    };
    if (facingIn === 'left' || facingIn === 'right') {
      displayImage.facing = facingIn;
    } else if (prev?.facing !== undefined) {
      displayImage.facing = prev.facing;
    }
    if (prev?.spriteSort !== undefined) {
      displayImage.spriteSort = prev.spriteSort;
    }
    await this.setSceneEntityFieldFromAction(sid, 'hotspot', hid, 'displayImage', displayImage);
  }

  /**
   * 仅当前会话、当前已加载场景：运行时翻转热点展示朝向，不写 Save 与 hotspot def。
   */
  private tempSetHotspotDisplayFacingFromAction(
    sceneId: string,
    hotspotId: string,
    facing: 'left' | 'right' | 'restore',
  ): void {
    const sid = sceneId.trim();
    const hid = hotspotId.trim();
    if (!sid || !hid) {
      console.warn('tempSetHotspotDisplayFacing: 需要 sceneId、hotspotId');
      return;
    }
    if (this.sceneManager.currentSceneData?.id !== sid) {
      console.warn(
        'tempSetHotspotDisplayFacing: 仅在目标场景已加载时生效（不写档，无法在离屏场景施加）。当前场景:',
        this.sceneManager.currentSceneData?.id ?? '(无)',
        '请求:',
        sid,
      );
      return;
    }
    const h = this.sceneManager.getCurrentHotspots().find((x) => x.def.id === hid);
    if (!h) {
      console.warn('tempSetHotspotDisplayFacing: 当前场景找不到热点', hid);
      return;
    }
    if (facing === 'restore') {
      h.setRuntimeDisplayFacing(null);
    } else {
      h.setRuntimeDisplayFacing(facing);
    }
  }

  private async applyNpcRuntimeFieldNow(
    npcId: string,
    fieldName: string,
    value: RuntimeFieldValue,
  ): Promise<void> {
    const npc = this.sceneManager.getNpcById(npcId);
    if (!npc) return;
    const def = npc.def as unknown as Record<string, unknown>;
    if (value === null) delete def[fieldName];
    else def[fieldName] = value;
    if (fieldName === 'x' && typeof value === 'number') npc.x = value;
    else if (fieldName === 'y' && typeof value === 'number') npc.y = value;
    else if (fieldName === 'enabled' && typeof value === 'boolean') npc.setVisible(value);
    else if (fieldName === 'animState' && typeof value === 'string') npc.playAnimation(value);
    else if (fieldName === 'patrolDisabled' && typeof value === 'boolean') {
      if (value) this.stopNpcPatrol(npcId);
      else this.startNpcPatrolForNpc(npcId);
    } else if (fieldName === 'animFile' || fieldName === 'initialAnimState') {
      await this.reloadNpcSpriteFromDef(npc);
    }
    this.syncEntityPixelDensityMatch();
  }

  private async reloadNpcSpriteFromDef(npc: Npc): Promise<void> {
    const animFile = npc.def.animFile?.trim();
    if (!animFile) return;
    try {
      const animRaw = await this.assetManager.loadJson<AnimationSetDefInput>(animFile);
      const sheetPath = resolvePathRelativeToAnimManifest(animFile, animRaw.spritesheet);
      const tex = await this.assetManager.loadTexture(sheetPath);
      const animDef = normalizeAnimationSetDef(animRaw, tex.width, tex.height);
      npc.loadSprite(tex, animDef, npc.def.initialAnimState);
    } catch (e) {
      console.warn('setEntityField: reload NPC animation failed', npc.id, animFile, e);
    }
  }

  private async applyHotspotRuntimeFieldNow(
    hotspotId: string,
    fieldName: string,
    value: RuntimeFieldValue,
  ): Promise<void> {
    const h = this.sceneManager.getCurrentHotspots().find((x) => x.def.id === hotspotId);
    if (!h) {
      if (fieldName === 'displayImage') {
        const ids = this.sceneManager
          .getCurrentHotspots()
          .map((x) => x.def.id)
          .join(', ');
        console.warn(
          'setHotspotDisplayImage: 当前场景找不到同 id 热点，无法立刻换图（运行态已记录）。' +
            ` 请求的 hotspotId=${JSON.stringify(hotspotId)}；` +
            ` 当前场景内热点 id: [${ids || '无'}]。` +
            ' 请与场景 JSON 里 hotspots[].id 一字不差；下拉框只把不带括注的 id 写入参数。',
        );
      }
      return;
    }
    if (fieldName === 'x' && typeof value === 'number') h.setPosition(value, h.def.y);
    else if (fieldName === 'y' && typeof value === 'number') h.setPosition(h.def.x, value);
    else if (fieldName === 'enabled' && typeof value === 'boolean') h.setEnabled(value);
    else if (fieldName === 'displayImage') {
      if (value === null) {
        delete h.def.displayImage;
        const oldF = h.detachDepthOcclusionFilter();
        if (oldF) {
          this.sceneDepthSystem.removeFilter(oldF);
          oldF.destroy();
        }
        h.setDisplayTexture(Texture.EMPTY, 0, 0);
      } else if (isHotspotDisplayImage(value)) {
        await this.applyHotspotDisplayImageNow(h, value);
      }
    }
    this.syncEntityPixelDensityMatch();
  }

  private async applyHotspotDisplayImageNow(
    h: ReturnType<SceneManager['getCurrentHotspots']>[number],
    displayImage: HotspotDisplayImage,
  ): Promise<void> {
    let tex: Texture;
    try {
      tex = await this.assetManager.loadTexture(displayImage.image);
    } catch (e) {
      console.warn('setEntityField: hotspot displayImage 加载失败', displayImage.image, e);
      return;
    }
    const oldF = h.detachDepthOcclusionFilter();
    if (oldF) {
      this.sceneDepthSystem.removeFilter(oldF);
      oldF.destroy();
    }
    h.def.displayImage = displayImage;
    h.setDisplayTexture(tex, displayImage.worldWidth, displayImage.worldHeight);
    if (h.hasDepthDisplayImage()) {
      try {
        const hf = this.sceneDepthSystem.createFilterForEntity();
        if (hf) {
          depthLog('Game', 'setEntityField: reattach depth to hotspot display:', h.def.id);
          h.attachDepthOcclusionFilter(hf);
        }
      } catch (e) {
        depthError('Game', 'setEntityField: hotspot depth filter FAILED', h.def.id, e);
      }
    }
  }

  /**
   * 按配置与背景密度同步玩家 / NPC / 热点展示的低通（仅 Pixi filters，不影响深度与碰撞）。
   */

  private syncEntityPixelDensityMatch(): void {
    const dBg = this.sceneManager.getBackgroundTexelsPerWorld();
    const on = dBg != null && this.getEntityPixelDensityMatchEffective();
    const strengthScale = this.getEntityPixelDensityMatchBlurScale();
    this.player.sprite.setPixelDensityMatchActive(on);
    this.player.sprite.applyPixelDensityMatch(dBg, strengthScale);
    for (const npc of this.sceneManager.getCurrentNpcs()) {
      npc.applyEntityPixelDensityMatch(npc.def.renderRaw ? false : on, dBg, strengthScale);
    }
    for (const h of this.sceneManager.getCurrentHotspots()) {
      h.applyEntityPixelDensityMatch(on, dBg, strengthScale);
    }
  }

  /**
   * 调试：只改内存中的当前场景 worldWidth / worldHeight；不写 JSON。「重载场景」可恢复数据文件数值。
   */
  private applyDebugSceneWorldSize(width: number, height: number): void {
    const r = this.sceneManager.applyDebugWorldSize(width, height);
    if (!r.ok) return;
    const sd = this.sceneManager.currentSceneData;
    if (!sd) return;
    this.player.syncMovementFromScene(sd);
    this.sceneDepthSystem.applyRuntimeSceneSize(
      sd.worldWidth,
      sd.worldHeight,
      r.worldToPixelX,
      r.worldToPixelY,
    );
    if (this.sceneDepthSystem.currentDepthTexture && this.sceneDepthSystem.currentConfig) {
      this.depthDebugVisualizer.updateSceneWorldSize(sd.worldWidth, sd.worldHeight);
    }
    this.syncEntityPixelDensityMatch();
  }

  /** F2 叙事调试：逐条 scenario（与 catalog 顺序一致） */
  private listScenarioDebugPanelRows(): ScenarioDebugPanelRow[] {
    const m = this.scenarioStateManager;
    const ids = m.getCatalogScenarioIds();
    const ser = m.serialize() as {
      scenarios?: Record<string, Record<string, { status: string; outcome?: unknown }>>;
      lineLifecycle?: Record<string, string>;
    };
    if (ids.length === 0) {
      return [];
    }
    const out: ScenarioDebugPanelRow[] = [];
    for (const sid of ids) {
      const life = m.getLineLifecycleState(sid);
      const manual = m.hasManualLineLifecycle(sid);
      const phases = ser.scenarios?.[sid];
      let phaseBrief = '(无 phase 存档桶)';
      if (phases && Object.keys(phases).length > 0) {
        const entries = Object.entries(phases);
        const slice = entries.slice(0, 14);
        phaseBrief = slice.map(([k, v]) => `${k}=${v.status}`).join('; ');
        if (entries.length > 14) phaseBrief += ` …(+${entries.length - 14})`;
      }
      out.push({
        id: sid,
        lifecycle: life,
        manual,
        phaseBrief,
      });
    }
    return out;
  }

  private async reloadScene(sceneId: string): Promise<void> {
    this.sceneManager.unloadScene();
    await this.sceneManager.loadScene(sceneId);
    /** η2a 交接：读档后 onEnter 可能已自动开演（对话/过场/遭遇/小游戏）——
     *  仅在没有进行中的子状态时才盖写回 Exploring，避免顶掉刚开播的演出。 */
    const s = this.stateController.currentState;
    if (
      s !== GameState.Dialogue &&
      s !== GameState.Cutscene &&
      s !== GameState.Encounter &&
      s !== GameState.Minigame
    ) {
      this.stateController.setState(GameState.Exploring);
    }
  }

  private playerNavTarget: { x: number; y: number } | null = null;
  private playerNavFrames = 0;
  private playerNavPrev: { x: number; y: number } | null = null;
  private playerNavStuck = 0;

  private setPlayerNavTarget(x: number, y: number): void {
    this.playerNavTarget = { x, y };
    this.playerNavFrames = 0;
    this.playerNavPrev = null;
    this.playerNavStuck = 0;
  }

  /** 每帧把玩家朝导航目标推进（用与触屏一致的移动轴，走真实移动/碰撞），到达或超时即停。非阻塞。
   *  卡住时改为只沿单轴走、并在 x/y 间交替，以滑动绕过简单障碍（非完整寻路）。 */
  private updatePlayerNav(): void {
    const t = this.playerNavTarget;
    if (!t) return;
    const dx = t.x - this.player.x;
    const dy = t.y - this.player.y;
    if (Math.hypot(dx, dy) < 14 || this.playerNavFrames > 1200) {
      this.playerNavTarget = null;
      this.playerNavPrev = null;
      this.inputManager.setTouchMoveAxes(0, 0);
      return;
    }
    if (this.playerNavPrev) {
      const moved = Math.hypot(this.player.x - this.playerNavPrev.x, this.player.y - this.playerNavPrev.y);
      this.playerNavStuck = moved < 0.6 ? this.playerNavStuck + 1 : 0;
    }
    this.playerNavPrev = { x: this.player.x, y: this.player.y };
    this.playerNavFrames += 1;
    let ax: -1 | 0 | 1 = dx > 6 ? 1 : dx < -6 ? -1 : 0;
    let ay: -1 | 0 | 1 = dy > 6 ? 1 : dy < -6 ? -1 : 0;
    if (this.playerNavStuck > 6) {
      // 卡住：交替只走 x 或只走 y，沿墙滑动绕障
      const useX = Math.floor(this.playerNavFrames / 26) % 2 === 0;
      if (useX && ax !== 0) ay = 0;
      else if (!useX && ay !== 0) ax = 0;
      else if (ax === 0) ay = this.playerNavFrames % 52 < 26 ? 1 : -1;
      else ax = this.playerNavFrames % 52 < 26 ? 1 : -1;
    }
    this.inputManager.setTouchMoveAxes(ax, ay);
  }

  /** 玩家视角观测：只含玩家可感知信息（位置/可见实体/交互提示/对话/HUD/模式），
   *  不含 flag/任务状态码/scenario/narrative 等幕后状态。供数据驱动的玩家同构测试。 */
  private getPlayerView(): Record<string, unknown> {
    const gs = String(this.stateController.currentState);
    const modeMap: Record<string, string> = {
      MainMenu: 'menu', Exploring: 'exploring', ActionSequence: 'busy',
      Dialogue: 'dialogue', Encounter: 'encounter', Cutscene: 'cutscene',
      UIOverlay: 'menu', Minigame: 'minigame',
    };
    return {
      mode: modeMap[gs] ?? gs,
      scene: this.sceneManager.currentSceneData?.name ?? this.sceneManager.currentSceneData?.id ?? null,
      player: { x: this.player.x, y: this.player.y, facing: this.player.facingDirection },
      entities: this.interactionSystem.getPlayerVisibleEntities(),
      interactionPrompt: this.interactionSystem.getNearestPrompt(),
      dialogue: this.graphDialogueManager.getPlayerDialogue(),
      hud: {
        coins: this.inventoryManager.getCoins(),
        questTracker: this.hud.getQuestHintText(),
      },
      navTargetActive: this.playerNavTarget !== null,
    };
  }

  private buildRuntimeDebugSnapshot(reason: string): Record<string, unknown> {
    return {
      reason,
      capturedAt: new Date().toISOString(),
      currentSceneId: this.sceneManager.currentSceneData?.id ?? null,
      gameState: this.stateController.currentState,
      previousGameState: this.stateController.previousState,
      flags: this.flagStore.serialize(),
      questState: this.questManager.serialize(),
      scenarioState: this.scenarioStateManager.serialize(),
      narrativeEval: this.graphDialogueManager.getNarrativeEvalDebug(),
      narrativeState: this.narrativeStateManager.debugSnapshot(),
      documentReveals: this.documentRevealManager.debugSnapshot(),
      eventTrace: this.eventBus.getDebugTrace(),
      saveData: this.collectSaveData(),
      runtimeRandomState: this.runtimeRandom.getState(),
      activeZones: [...this.zoneSystem.getActiveZoneIds()].sort(),
      uiState: this.stateController.getDebugState(),
      hudVisualState: this.fixedTickMode ? this.hud.getDebugVisualState() : null,
      renderState: {
        ...this.renderer.getDebugRenderState(),
        ...this.sceneManager.getDebugRenderState(),
      },
      entityVisualState: this.fixedTickMode ? {
        player: {
          x: this.player.x,
          y: this.player.y,
          visible: this.player.sprite.container.visible,
          animation: this.player.sprite.getDebugVisualState(),
        },
        npcs: this.sceneManager.getDebugEntityVisualState(),
      } : null,
      audioState: {
        currentBgmId: this.audioManager.getRequestedBgmId(),
        ambientIds: this.audioManager.getRequestedAmbientIds().sort(),
        volumes: this.audioManager.serialize(),
      },
      inFlight: {
        runtimeReady: this.runtimeReady,
        fixedTickMode: this.fixedTickMode,
        sceneSwitching: this.sceneManager.switching,
        actionPolicyDepth: this.actionExecutor.getPolicyDepth(),
        cutscene: this.cutsceneManager.isPlaying,
        graphDialogue: this.graphDialogueManager.isActive,
        scriptedDialogue: this.dialogueManager.isActive,
        encounter: this.encounterManager.isActive,
        waterMinigame: this.waterMinigameManager.isActive,
        sugarWheelMinigame: this.sugarWheelMinigameManager.isActive,
        paperCraftMinigame: this.paperCraftMinigameManager.isActive,
        pressureHold: this.pressureHoldUI.isActive(),
      },
      // serialize() 已收敛为恒 {active:false}（对话不入档），快照改用只读调试 getter
      dialogue: this.graphDialogueManager.getDebugInteractionState(),
      dialogueView: this.graphDialogueManager.getDialogueViewDebug(),
      minigameDebug: {
        water: this.waterMinigameManager.getDebugVisualState(),
        sugarWheel: this.sugarWheelMinigameManager.getDebugVisualState(),
        paperCraft: this.paperCraftMinigameManager.getDebugVisualState(),
        pressureHold: this.pressureHoldUI.getDebugVisualState(),
      },
      player: { x: this.player.x, y: this.player.y, facing: this.player.facingDirection },
      planes: this.planeReconciler.getDebugState(),
      inventory: this.inventoryManager.serialize(),
      interactables: this.interactionSystem.debugListInteractables(this.player.x, this.player.y),
      playerView: this.getPlayerView(),
      runtimeCommands: {
        lastResults: this.lastRuntimeCommandResults.slice(-20),
      },
      recentPageErrors: collectRecentPageErrors(),
      bootId: this.runtimeBootId,
    };
  }

  private setupRuntimeDebugSnapshotPublishing(): void {
    if (!import.meta.env.DEV) return;
    installPageErrorTrap();
    const events = [
      'narrative:stateChanged',
      'flag:changed',
      'quest:accepted',
      'quest:completed',
      'dialogue:start',
      'dialogue:line',
      'dialogue:choices',
      'dialogue:end',
      'scene:enter',
    ];
    for (const event of events) {
      this.listenEvent(event, () => this.scheduleRuntimeDebugSnapshotPublish(event));
    }
  }

  private scheduleRuntimeDebugSnapshotPublish(reason: string): void {
    if (!import.meta.env.DEV) return;
    if (this.runtimeDebugSnapshotTimer !== null) {
      window.clearTimeout(this.runtimeDebugSnapshotTimer);
    }
    this.runtimeDebugSnapshotTimer = window.setTimeout(() => {
      this.runtimeDebugSnapshotTimer = null;
      void this.publishRuntimeDebugSnapshot(reason);
    }, 120);
  }

  private async publishRuntimeDebugSnapshot(reason: string): Promise<void> {
    if (!import.meta.env.DEV) return;
    try {
      await fetch('/__gamedraft-api/runtime-debug-snapshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.buildRuntimeDebugSnapshot(reason)),
      });
    } catch (error) {
      if (!this.runtimeDebugSnapshotErrorLogged) {
        this.runtimeDebugSnapshotErrorLogged = true;
        console.warn('[GameDraft runtime-debug] snapshot publish failed', error);
      }
    }
  }

  private setupRuntimeCommandPolling(): void {
    if (!import.meta.env.DEV) return;
    if (this.runtimeCommandPollTimer !== null) {
      window.clearInterval(this.runtimeCommandPollTimer);
    }
    this.runtimeCommandPollTimer = window.setInterval(() => {
      void this.pollRuntimeCommands();
    }, 600);
    void this.pollRuntimeCommands();
  }

  private async pollRuntimeCommands(): Promise<void> {
    if (!import.meta.env.DEV || this.runtimeCommandPollInFlight) return;
    this.runtimeCommandPollInFlight = true;
    try {
      const response = await fetch('/__gamedraft-api/runtime-command', { method: 'GET' });
      if (!response.ok) {
        if (!this.runtimeCommandPollErrorLogged) {
          this.runtimeCommandPollErrorLogged = true;
          console.warn('[GameDraft runtime-command] poll failed', response.status, response.statusText);
        }
        return;
      }
      const payload = await response.json();
      const rawCommands = Array.isArray(payload?.commands) ? payload.commands : [];
      if (rawCommands.length === 0) return;
      // 多开页签时的指向性消费：命令可带 targetBootId；与本实例不符的命令留在队列里
      // 等目标实例取走。无 targetBootId 的命令保持旧行为（任意实例可执行）。
      const commands = rawCommands.filter((c: unknown) => {
        const t = (c as { targetBootId?: unknown })?.targetBootId;
        return t === undefined || t === null || String(t) === this.runtimeBootId;
      });
      if (commands.length === 0) return;
      // 分批：每轮最多 50 条，剩余留在队列由下一轮轮询继续取——不再静默丢尾
      const batch = commands.slice(0, 50);
      const results = [];
      const consumedIds: string[] = [];
      let allBatchHaveIds = true;
      for (const command of batch) {
        const rawId = (command as { id?: unknown })?.id;
        const cid = rawId === undefined || rawId === null ? '' : String(rawId).trim();
        if (cid) consumedIds.push(cid);
        else allBatchHaveIds = false;
        try {
          results.push(await this.applyRuntimeCommand(command));
        } catch (error) {
          results.push({
            id: '',
            type: 'unknown',
            ok: false,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      this.lastRuntimeCommandResults = results;
      // 按命令 id 定向删除本实例已执行的命令：targetBootId 不符/未进本批的命令留队列。
      // 队列里混有无 id 的旧格式命令时退回整清（否则会重复执行）——服务端 POST 已补发 id，
      // 此退路仅兜历史残留文件。
      if (allBatchHaveIds && consumedIds.length > 0) {
        await fetch(
          `/__gamedraft-api/runtime-command?ids=${encodeURIComponent(consumedIds.join(','))}`,
          { method: 'DELETE' },
        );
      } else {
        await fetch('/__gamedraft-api/runtime-command', { method: 'DELETE' });
      }
      await this.publishRuntimeDebugSnapshot(
        results.every((r) => r.ok) ? 'runtime-command:complete' : 'runtime-command:failed',
      );
      if (results.some((r) => !r.ok)) {
        console.warn('[GameDraft runtime-command] command failed', results);
      }
    } catch (error) {
      if (!this.runtimeCommandPollErrorLogged) {
        this.runtimeCommandPollErrorLogged = true;
        console.warn('[GameDraft runtime-command] poll failed', error);
      }
    } finally {
      this.runtimeCommandPollInFlight = false;
    }
  }

  private applyRuntimeCommand(command: unknown): Promise<{ id: string; type: string; ok: boolean; message: string }> {
    return applyDevRuntimeCommand(command, {
      captureSnapshot: (reason) => this.publishRuntimeDebugSnapshot(reason),
      clearEventTrace: () => this.eventBus.clearDebugTrace(),
      debugExecuteAction: (action) => this.actionExecutor.executeAwait(action),
      debugSetFixedTickMode: (enabled) => {
        this.fixedTickMode = enabled;
        this.hud.setFixedTickMode(enabled);
        if (enabled) {
          this.player.sprite.resetAnimationClock();
          this.sceneManager.resetEntityAnimationClocks();
        }
      },
      debugStepTicks: (ticks, dtMs) => this.debugStepTicks(ticks, dtMs),
      clearNarrativeTrace: () => this.narrativeStateManager.clearDebugTrace(),
      emitNarrativeSignal: (signal) => this.narrativeStateManager.emitNarrativeSignal(signal as NarrativeSignal),
      debugSetNarrativeState: (graphId, stateId) => this.narrativeStateManager.debugSetNarrativeState(graphId, stateId),
      setFlag: (key, value) => this.flagStore.set(key, value),
      isFlagAllowed: (key) => this.flagStore.isKeyAllowedByRegistry(key),
      getFlagValueKind: (key) => this.flagStore.getDebugValueKind(key),
      debugSetQuestStatus: (questId, status) => this.questManager.debugSetQuestStatus(questId, status),
      debugSetScenarioPhase: (scenarioId, phase, payload) =>
        this.scenarioStateManager.debugSetScenarioPhase(scenarioId, phase, payload),
      debugSetScenarioLineLifecycle: (scenarioId, state) =>
        this.scenarioStateManager.debugSetScenarioLineLifecycle(scenarioId, state),
      debugResetScenarioProgress: (scenarioId) => this.scenarioStateManager.resetScenarioProgressForDebug(scenarioId),
      debugStartDialogueGraph: (params) => this.graphDialogueManager.startDialogueGraph(params),
      debugAdvanceDialogue: async (maxSteps) => {
        await this.graphDialogueManager.debugAdvanceUntilBlocking(maxSteps);
      },
      debugChooseDialogueOption: (params) => this.graphDialogueManager.debugChooseOption(params),
      debugSwitchScene: async (sceneId, spawnPoint) => {
        await this.actionExecutor.executeAwait({
          type: 'switchScene',
          params: { targetScene: sceneId, targetSpawnPoint: spawnPoint },
        });
        this.interactionSystem.update(0);
        this.zoneSystem.update(0);
        await this.debugWait(1);
      },
      debugTriggerHotspot: (hotspotId) => this.interactionCoordinator.debugTriggerHotspotById(hotspotId),
      debugInteractNpc: (npcId) => this.interactionCoordinator.debugInteractNpcById(npcId),
      debugWait: (durationMs) => this.debugWait(durationMs),
      debugSetPlayerPosition: (x, y, snapCamera) => this.debugSetPlayerPosition(x, y, snapCamera),
      debugMovePlayerTo: (x, y, speed, snapCamera) => this.debugMovePlayerTo(x, y, speed, snapCamera),
      debugClick: (x, y) => this.debugClick(x, y),
      debugDrag: (fromX, fromY, toX, toY, durationMs) => this.debugDrag(fromX, fromY, toX, toY, durationMs),
      debugSaveGame: (slot) => this.saveManager.save(slot),
      debugLoadGame: (slot) => this.saveManager.load(slot),
      debugReloadScene: (sceneId) => this.reloadScene(
        sceneId || this.sceneManager.currentSceneData?.id || this.gameConfig.fallbackScene,
      ),
      // 玩家输入：注入真实输入路径、即发即走（不 await 游戏逻辑，故不会卡死通道）
      playerInteract: () => this.inputManager.injectKeyJustPressed('KeyE'),
      playerAdvance: () => this.eventBus.emit('dialogue:advance', {}),
      playerChoose: (index) => this.eventBus.emit('dialogue:choiceSelected', { index }),
      playerMoveTo: (x, y) => this.setPlayerNavTarget(x, y),
      playerTap: () => this.inputManager.injectPointerDown(),
      setPlayerCollisions: (enabled) => this.player.setCollisionsEnabled(enabled),
      activatePlane: (planeId) => this.planeReconciler.activatePlaneManually(planeId),
      deactivatePlane: () => this.planeReconciler.deactivateManualPlane(),
    });
  }

  private async debugWait(durationMs: number): Promise<void> {
    const ms = Math.max(1, Math.min(60_000, Math.trunc(durationMs)));
    await new Promise<void>((resolve) => window.setTimeout(resolve, ms));
  }

  private async debugStepTicks(ticks: number, dtMs: number): Promise<void> {
    const count = Math.max(1, Math.min(200, Math.trunc(ticks)));
    const dt = Math.max(0.001, Math.min(0.1, dtMs / 1000));
    for (let index = 0; index < count; index++) {
      this.tick(dt);
      this.hud.stepFixedTick(dt);
      // 真实 Ticker 的每帧之间会回到事件循环并清空整条微任务链；单次
      // Promise.resolve 只让出一层，巡逻 moveTo→sleepWhilePaused 的第二层 continuation
      // 仍会落到下一固定帧之后。MessageChannel 让出一个完整 task，且不推进墙钟。
      await this.debugYieldEventLoopTurn();
    }
    // 固定步调试不经过 Pixi Ticker；显式提交一帧，保证截图读取的是本次逻辑状态而非已清 backbuffer。
    this.renderer.app.render();
  }

  private debugYieldEventLoopTurn(): Promise<void> {
    return new Promise<void>((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        channel.port2.close();
        resolve();
      };
      channel.port2.postMessage(null);
    });
  }

  private async debugSetPlayerPosition(x: number, y: number, snapCamera: boolean): Promise<void> {
    this.player.x = x;
    this.player.y = y;
    if (snapCamera) {
      this.camera.snapTo(x, y);
    } else {
      this.camera.follow(x, y);
    }
    this.interactionSystem.update(0);
    this.zoneSystem.update(0);
    await this.debugWait(1);
  }

  private async debugMovePlayerTo(x: number, y: number, speed: number, snapCamera: boolean): Promise<void> {
    const safeSpeed = Math.max(1, Math.min(5000, speed));
    const dx = x - this.player.x;
    const dy = y - this.player.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance < 0.5) {
      await this.debugSetPlayerPosition(x, y, snapCamera);
      return;
    }

    const timeoutMs = Math.min(15_000, Math.max(500, Math.ceil((distance / safeSpeed) * 1000) + 1000));
    let timeoutHandle: number | null = null;
    const timeout = new Promise<void>((resolve) => {
      timeoutHandle = window.setTimeout(resolve, timeoutMs);
    });
    await Promise.race([this.player.moveTo(x, y, safeSpeed, ANIM_WALK, true), timeout]);
    if (timeoutHandle !== null) {
      window.clearTimeout(timeoutHandle);
    }
    await this.debugSetPlayerPosition(x, y, snapCamera);
  }

  private async debugClick(x: number, y: number): Promise<void> {
    const target = this.renderer?.app?.canvas as HTMLCanvasElement | undefined;
    if (!target) return;
    this.dispatchPointerLike(target, 'pointerdown', x, y);
    this.dispatchPointerLike(target, 'pointerup', x, y);
    this.dispatchPointerLike(target, 'click', x, y);
    await this.debugWait(50);
  }

  private async debugDrag(fromX: number, fromY: number, toX: number, toY: number, durationMs: number): Promise<void> {
    const target = this.renderer?.app?.canvas as HTMLCanvasElement | undefined;
    if (!target) return;
    this.dispatchPointerLike(target, 'pointerdown', fromX, fromY);
    const steps = Math.max(2, Math.min(20, Math.ceil(durationMs / 50)));
    for (let idx = 1; idx <= steps; idx += 1) {
      const t = idx / steps;
      this.dispatchPointerLike(
        target,
        'pointermove',
        fromX + (toX - fromX) * t,
        fromY + (toY - fromY) * t,
      );
      await this.debugWait(Math.max(1, Math.floor(durationMs / steps)));
    }
    this.dispatchPointerLike(target, 'pointerup', toX, toY);
  }

  private dispatchPointerLike(target: HTMLCanvasElement, type: string, x: number, y: number): void {
    const init = {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      buttons: type === 'pointerup' || type === 'click' ? 0 : 1,
    };
    try {
      target.dispatchEvent(new PointerEvent(type, init));
    } catch {
      target.dispatchEvent(new MouseEvent(type === 'pointermove' ? 'mousemove' : type === 'pointerup' ? 'mouseup' : 'mousedown', init));
    }
  }

  private listenEvent(event: string, fn: (...args: any[]) => void): void {
    this.eventBus.on(event, fn);
    this.boundCallbacks.push({ event, fn });
  }

  private addWindowListener(event: string, fn: EventListener): void {
    window.addEventListener(event, fn);
    this.boundWindowListeners.push({ event, fn });
  }

  getSaveManager(): SaveManager { return this.saveManager; }
  getAudioManager(): AudioManager { return this.audioManager; }

  getDebugPanel(): DebugPanelUI {
    return this.debugPanelUI;
  }

  destroy(): void {
    if (this.tearDownComplete) return;
    this.tearDownComplete = true;

    /** P3：先推进巡逻代数/epoch——NPC 巡逻协程在下一个检查点立刻退出，
     *  不会在系统逐个销毁期间继续 moveTo 已销毁的实体（HMR 悬挂根因）。 */
    this.patrolGeneration++;
    this.npcPatrolEpoch.clear();

    if (this.mainTick && this.renderer?.app?.ticker) {
      try {
        this.renderer.app.ticker.remove(this.mainTick);
      } catch {
        /* ignore */
      }
      this.mainTick = null;
    }
    if (this.glPostRenderDrain && this.renderer?.app?.ticker) {
      try {
        this.renderer.app.ticker.remove(this.glPostRenderDrain);
      } catch {
        /* ignore */
      }
      this.glPostRenderDrain = null;
    }
    const canvas = this.renderer?.app?.canvas as HTMLCanvasElement | undefined;
    if (canvas) {
      if (this.webglContextLostHandler) {
        canvas.removeEventListener('webglcontextlost', this.webglContextLostHandler);
      }
      if (this.webglContextRestoredHandler) {
        canvas.removeEventListener('webglcontextrestored', this.webglContextRestoredHandler);
      }
    }
    this.webglContextLostHandler = null;
    this.webglContextRestoredHandler = null;
    this.runtimeDebugLogCleanup?.();
    this.runtimeDebugLogCleanup = null;
    if (this.runtimeDebugSnapshotTimer !== null) {
      window.clearTimeout(this.runtimeDebugSnapshotTimer);
      this.runtimeDebugSnapshotTimer = null;
    }
    if (this.runtimeCommandPollTimer !== null) {
      window.clearInterval(this.runtimeCommandPollTimer);
      this.runtimeCommandPollTimer = null;
    }
    this.runtimeReady = false;
    this.runtimeCommandPollInFlight = false;

    for (const { event, fn } of this.boundCallbacks) {
      this.eventBus.off(event, fn);
    }
    this.boundCallbacks = [];

    this.cutsceneStepHudEl?.remove();
    this.cutsceneStepHudEl = null;

    for (const { event, fn } of this.boundWindowListeners) {
      window.removeEventListener(event, fn);
    }
    this.boundWindowListeners = [];

    this.unsubRendererResize?.();
    this.unsubRendererResize = null;

    /**
     * 面板属主契约（P3 双重 destroy 收敛）：凡 registerPanel 进 stateController 的面板
     * （quest/inventory/rules/dialogueLog/bookshelf/map/ruleUse/shop/menu/debug）由
     * stateController.destroy() 统一 close+destroy，Game 只销毁未注册的 UI。
     * debug 面板仅 DEV 注册（T1），生产下由 Game 兜底销毁。
     */
    this.inspectBox?.destroy();
    this.pickupNotification?.destroy();
    this.dialogueUI?.destroy();
    this.encounterUI?.destroy();
    this.actionChoiceUI?.destroy();
    this.pressureHoldUI?.destroy();
    this.hud?.destroy();
    this.notificationUI?.destroy();
    this.bookReaderUI?.destroy();
    if (!import.meta.env.DEV) this.debugPanelUI?.destroy();
    this.devModeUI?.destroy();
    this.devModeUI = null;
    delete window.__gameDevAPI;

    /** P3：清 ?smellDebug 安装的 window 全局（共 7 个，见 start 内安装处） */
    if (this.smellDebugGlobalKeys.length > 0) {
      const w = window as unknown as Record<string, unknown>;
      for (const k of this.smellDebugGlobalKeys) delete w[k];
      this.smellDebugGlobalKeys = [];
    }

    this.interactionCoordinator?.destroy();
    this.eventBridge?.destroy();
    this.debugTools?.destroy();
    this.debugTools = null;
    this.depthDebugVisualizer?.destroy();

    this.stateController.destroy();

    this.touchMobileControls?.destroy();
    this.touchMobileControls = null;

    for (const entry of this.registeredSystems) {
      if (entry.system) entry.system.destroy();
    }

    // 各系统/UI/桥接均已各自 off 监听后，再清空总线作为兜底；
    // 早于各 destroy() 清空会使各模块的 off() 作用在空总线上，掩盖其监听泄漏。
    this.eventBus.clear();

    // CutsceneRenderer 不在 registeredSystems 里（渲染层），显式释放 resize 订阅与演出内容
    this.cutsceneRenderer?.destroy();

    this.actionExecutor.destroy();
    this.flagStore.destroy();
    this.inputManager.destroy();
    this.renderer.destroy();
    // 资产缓存收尾必须放最后（各系统 destroy 可能仍触碰贴图/音频引用）：
    // 不 dispose 则 Howl 常驻 Howler 全局注册表、纹理跨实例存活，跨 HMR/编辑器预览泄漏。
    this.assetManager.dispose();
  }

  private tick(dt: number): void {
    this.lastFps = dt > 0 ? 1 / dt : 0;
    this.playTimeMs += dt * 1000;

    this.camera.setPixelSnapTranslation(this.isEntityPixelDensityMatchRenderingOn());

    // 位面对账先于 Exploring 分支：回 Exploring 边沿挂起的 zone 重注册（pendingZoneRefresh）
    // 必须在本帧 zoneSystem.update 之前补刷，否则旧位面 zone 会以过期集合多跑一帧 enter/stay。
    this.planeReconciler.update(dt);

    if (this.stateController.currentState === GameState.Exploring) {
      this.updatePlayerNav();
      this.player.update(dt);
      // 「嗅」键（KeyQ）：主动闻一下当前气味，HUD 气缕短暂拔高变清。
      if (this.inputManager.wasKeyJustPressed('KeyQ')) this.smellSystem.sniff();
      this.interactionSystem.update(dt);
      this.zoneSystem.update(dt);
      for (const npc of this.sceneManager.getCurrentNpcs()) {
        npc.cutsceneUpdate(dt);
      }
      this.camera.follow(this.player.x, this.player.y);
    }

    if (this.stateController.currentState === GameState.Cutscene) {
      this.player.cutsceneUpdate(dt);
      for (const npc of this.sceneManager.getCurrentNpcs()) {
        npc.cutsceneUpdate(dt);
      }
      for (const [, npc] of this.cutsceneManager.getTempActors()) {
        npc.cutsceneUpdate(dt);
      }
    }

    if (this.stateController.currentState === GameState.Dialogue) {
      this.dialogueUI.update(dt);
      this.player.cutsceneUpdate(dt);
      for (const npc of this.sceneManager.getCurrentNpcs()) {
        npc.cutsceneUpdate(dt);
      }
    }

    if (this.stateController.currentState === GameState.Encounter) {
      this.encounterUI.update(dt);
      this.player.cutsceneUpdate(dt);
      for (const npc of this.sceneManager.getCurrentNpcs()) {
        npc.cutsceneUpdate(dt);
      }
    }

    if (this.stateController.currentState === GameState.Minigame) {
      this.waterMinigameManager.update(dt);
      this.sugarWheelMinigameManager.update(dt);
      this.paperCraftMinigameManager.update(dt);
      this.player.cutsceneUpdate(dt);
      for (const npc of this.sceneManager.getCurrentNpcs()) {
        npc.cutsceneUpdate(dt);
      }
    }

    if (this.stateController.currentState === GameState.UIOverlay) {
      this.player.cutsceneUpdate(dt);
      for (const npc of this.sceneManager.getCurrentNpcs()) {
        npc.cutsceneUpdate(dt);
      }
    }

    if (this.stateController.currentState === GameState.ActionSequence) {
      this.player.cutsceneUpdate(dt);
      for (const npc of this.sceneManager.getCurrentNpcs()) {
        npc.cutsceneUpdate(dt);
      }
      // 探索触发的动作链（zone / 热区等）会短暂进入此状态；镜头仍需以玩家为锚点，
      // 否则 fadingZoom 与 moveEntityTo 等组合下会出现「缩放中心漂移、走动不跟镜」。
      this.camera.follow(this.player.x, this.player.y);
    }

    this.emoteBubbleManager.update(dt);
    this.notificationUI.update(dt);
    this.camera.update(dt);
    this.debugTools?.update(dt);
    this.depthDebugVisualizer?.update();

    this.syncEntityPixelDensityMatch();

    if (this.sceneDepthSystem.isActive) {
      const S = this.camera.getProjectionScale();
      this.sceneDepthSystem.updatePerFrame(
        this.renderer.worldContainer.x,
        this.renderer.worldContainer.y,
        S,
      );
      // depth_floor 直读场景 zones、不经 ZoneSystem——位面归属在此消费点单独过滤
      //（standard zone 的位面过滤在 shouldRegisterZoneWithZoneSystem）。
      // exclusive（独立世界型）激活时缺省 zone 也不存在，须无条件走过滤。
      const zonesRaw = this.sceneManager.currentSceneData?.zones;
      const zones = zonesRaw?.some((z) => z.planes?.length)
          || this.planeReconciler.getActivePlaneMembership() === 'exclusive'
        ? zonesRaw?.filter((z) => this.sceneManager.isEntityInActivePlane(z))
        : zonesRaw;
      /** F2 性能：深度 floor 偏移的条件上下文每帧建一次，玩家/NPC/热点三处循环共享；
       *  统一走中央工厂（律5），plane/@scene/@owner 叶子与其它条件入口口径一致。 */
      const floorCondCtx = this.buildConditionEvalContext();
      if (this.playerDepthFilter) {
        const ex = resolveDepthFloorOffsetBoost(
          zones,
          this.player.x,
          this.player.y,
          this.flagStore,
          floorCondCtx,
        );
        this.sceneDepthSystem.updateEntityDepthOcclusion(
          this.playerDepthFilter,
          this.player.x,
          this.player.y,
          ex,
        );
      }
      for (const child of this.renderer.entityLayer.children) {
        const c = child as unknown as {
          filters?: readonly { _isDepthOcclusion?: boolean }[];
          x: number;
          y: number;
        };
        if (c.filters) {
          for (const f of c.filters) {
            if (f._isDepthOcclusion && f !== this.playerDepthFilter) {
              const ex = resolveDepthFloorOffsetBoost(zones, c.x, c.y, this.flagStore, floorCondCtx);
              this.sceneDepthSystem.updateEntityDepthOcclusion(
                f as unknown as IEntityShadingFilter,
                c.x,
                c.y,
                ex,
              );
            }
          }
        }
      }
      for (const h of this.sceneManager.getCurrentHotspots()) {
        const hf = h.getDepthOcclusionFilter();
        if (!hf) continue;
        const footY = h.depthOcclusionFootWorldY();
        const ex = resolveDepthFloorOffsetBoost(zones, h.container.x, footY, this.flagStore, floorCondCtx);
        this.sceneDepthSystem.updateEntityDepthOcclusion(hf, h.container.x, footY, ex);
      }
    }

    this.updateLightEnvFromCurve();
    this.updateEntityShadows();

    this.renderer.sortEntityLayer(this.player.x, this.player.y);
    this.touchMobileControls?.update();
    this.inputManager.endFrame();
  }
}
