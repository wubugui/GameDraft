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
import { HUD } from '../ui/HUD';
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
  GameConfig,
  MapNodeDef,
  SceneDataRaw,
  ScenarioCatalogFile,
  ICutsceneActor,
  HotspotDisplayImage,
  IEmoteBubbleAnchor,
} from '../data/types';
import { DEFAULT_ENTITY_PIXEL_DENSITY_BLUR_SCALE } from '../rendering/EntityPixelDensityMatch';
import type { AnimationSetDefInput } from '../data/resolveAnimationSet';
import { normalizeAnimationSetDef } from '../data/resolveAnimationSet';
import { resolvePathRelativeToAnimManifest } from './assetPath';
import { createPlaceholderPlayerTextures } from '../rendering/PlaceholderFactory';
import type { Npc } from '../entities/Npc';
import { registerActionHandlers } from './ActionRegistry';
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
import type { DepthOcclusionFilter } from '../rendering/DepthOcclusionFilter';
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
import { resolveScriptedSpeakerDisplay } from '../utils/scriptedDialogueSpeaker';
import { Texture, UPDATE_PRIORITY } from 'pixi.js';
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
  /** 开发模式下直接进入指定水域小游戏实例（由编辑器预览 URL `waterPreview=` 传入） */
  waterPreview?: string;
  /** 开发模式下直接进入指定转盘小游戏实例（URL `sugarWheelPreview=`） */
  sugarWheelPreview?: string;
  /** 开发模式下直接进入指定扎纸小游戏实例（URL `paperCraftPreview=`） */
  paperCraftPreview?: string;
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
    };
  }
}

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
  private playerAnimDef: AnimationSetDef | null = null;

  private interactionCoordinator!: InteractionCoordinator;
  private eventBridge!: EventBridge;
  private debugTools!: DebugTools;
  private sceneDepthSystem: SceneDepthSystem;
  private waterMinigameManager: WaterMinigameManager;
  private sugarWheelMinigameManager: SugarWheelMinigameManager;
  private paperCraftMinigameManager: PaperCraftMinigameManager;
  private depthDebugVisualizer!: DepthDebugVisualizer;
  private playerDepthFilter: DepthOcclusionFilter | null = null;

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
  private runtimeDebugSnapshotErrorLogged = false;
  private runtimeCommandPollErrorLogged = false;
  private lastRuntimeCommandResults: { id: string; type: string; ok: boolean; message: string }[] = [];

  private registeredSystems: { name: string; system: IGameSystem }[] = [];
  private boundCallbacks: { event: string; fn: (...args: any[]) => void }[] = [];
  private boundWindowListeners: { event: string; fn: EventListener }[] = [];
  private unsubRendererResize: (() => void) | null = null;
  /** 避免 beforeunload 与 pagehide 接连触发时重复销毁（第二次会踩已 teardown 的 Pixi Application） */
  private tearDownComplete = false;
  private isDevMode = false;
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
      { name: 'documentRevealManager', system: this.documentRevealManager },
      { name: 'encounterManager', system: this.encounterManager },
      { name: 'audioManager', system: this.audioManager },
      { name: 'dayManager', system: this.dayManager },
      { name: 'waterMinigameManager', system: this.waterMinigameManager },
      { name: 'sugarWheelMinigameManager', system: this.sugarWheelMinigameManager },
      { name: 'paperCraftMinigameManager', system: this.paperCraftMinigameManager },
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
      const nodes = await this.assetManager.loadJson<MapNodeDef[]>(TEXT_URLS.mapConfig);
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
    await this.renderer.init();
    this.emoteBubbleManager.setEntityAttachLayer(this.renderer.entityLayer);

    await this.stringsProvider.load(this.assetManager);

    await this.loadGameConfig();
    if (this.gameConfig.windowSize) {
      this.renderer.setWindowSize(this.gameConfig.windowSize.width, this.gameConfig.windowSize.height);
    }
    if (this.gameConfig.viewport) {
      this.renderer.setViewportSize(this.gameConfig.viewport.width, this.gameConfig.viewport.height);
    }

    this.inspectBox = new InspectBox(this.renderer, this.stringsProvider);
    this.pickupNotification = new PickupNotification(this.renderer, this.stringsProvider);
    this.dialogueUI = new DialogueUI(this.renderer, this.eventBus, this.stringsProvider);
    this.encounterUI = new EncounterUI(this.renderer, this.eventBus, this.stringsProvider);
    this.actionChoiceUI = new ActionChoiceUI(this.renderer);
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
      (sceneId) => this.reloadScene(sceneId),
      this.stringsProvider,
      this.gameConfig.fallbackScene,
    );
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

    const mkCondCtx = (): ConditionEvalContext => ({
      flagStore: this.flagStore,
      questManager: this.questManager,
      scenarioState: this.scenarioStateManager,
      narrativeState: this.narrativeStateManager,
      resolveConditionLiteral: (raw) => this.resolveDisplayText(raw),
    });
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

    registerActionHandlers(this.actionExecutor, {
      resolveScriptedSpeaker: (raw, scriptedNpcId) =>
        resolveScriptedSpeakerDisplay(raw, {
          strings: this.stringsProvider,
          flagStore: this.flagStore,
          sceneManager: this.sceneManager,
          graphDialogueNpcId: this.graphDialogueManager.getContextNpcId(),
          fallbackNpcId: scriptedNpcId ?? '',
        }),
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
      applyPlayerAvatar: (path, sm) => this.applyPlayerAvatarFromAction(path, sm),
      resetPlayerAvatar: () => this.resetPlayerAvatarFromAction(),
      setSceneDepthFloorOffset: (v) => { this.sceneDepthSystem.floorOffset = v; },
      resetSceneDepthFloorOffset: () => {
        const cfg = this.sceneDepthSystem.currentConfig;
        this.sceneDepthSystem.floorOffset = cfg?.floor_offset ?? 0;
      },
      setCameraZoom: (z) => { this.camera.setZoom(z); },
      restoreSceneCameraZoom: () => {
        const z = this.sceneManager.currentSceneData?.camera?.zoom;
        this.camera.setZoom(z !== undefined && Number.isFinite(z) && z > 0 ? z : 1);
      },
      fadingRestoreSceneCameraZoom: (durationMs) => {
        const z = this.sceneManager.currentSceneData?.camera?.zoom;
        const target = z !== undefined && Number.isFinite(z) && z > 0 ? z : 1;
        return this.cutsceneManager.fadingCameraZoom(target, durationMs);
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
      startDialogueGraph: async (graphId, entry, npcId, ownerType, ownerId) => {
        this.stateController.setState(GameState.Dialogue);
        try {
          let npcName = '';
          const npcIdTrim = npcId?.trim() || '';
          if (npcIdTrim) {
            const npc = this.sceneManager.getNpcById(npcIdTrim);
            if (npc) npcName = npc.def.name;
          }
          const ownerTypeTrim = ownerType?.trim() || (npcIdTrim ? 'npc' : '');
          const ownerIdTrim = ownerId?.trim() || npcIdTrim || '';
          await this.graphDialogueManager.startDialogueGraph({
            graphId,
            entry,
            npcName,
            npcId: npcIdTrim || undefined,
            ownerType: ownerTypeTrim || undefined,
            ownerId: ownerIdTrim || undefined,
          });
          if (!this.graphDialogueManager.isActive) {
            this.stateController.setState(GameState.Exploring);
          }
        } catch (e) {
          console.warn('Game: startDialogueGraph failed', e);
          this.stateController.setState(GameState.Exploring);
        }
      },
      playScriptedDialogue: (lines) => {
        this.stateController.setState(GameState.Dialogue);
        return new Promise<void>((resolve) => {
          const onEnd = () => {
            this.eventBus.off('dialogue:end', onEnd);
            resolve();
          };
          this.eventBus.on('dialogue:end', onEnd);
          this.dialogueManager.startScriptedDialogue(lines);
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
        const ctx: ConditionEvalContext = {
          flagStore: this.flagStore,
          questManager: this.questManager,
          scenarioState: this.scenarioStateManager,
          narrativeState: this.narrativeStateManager,
          resolveConditionLiteral: (raw) => this.resolveDisplayText(raw),
        };
        return evaluateConditionExpr(expr, ctx);
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
        const z = this.sceneManager.currentSceneData?.camera?.zoom;
        const target = z !== undefined && Number.isFinite(z) && z > 0 ? z : 1;
        return this.cutsceneManager.fadingCameraZoom(target, durationMs);
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

    this.debugTools = new DebugTools({
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
    });
    this.debugTools.init();

    await Promise.all([
      this.loadFlagRegistry(),
      this.inventoryManager.loadDefs(),
      this.rulesManager.loadDefs(),
      this.questManager.loadDefs(),
      this.encounterManager.loadDefs(),
      this.audioManager.loadConfig(),
      this.cutsceneManager.loadDefs(),
      this.archiveManager.loadDefs(),
      this.shopUI.loadDefs(),
      this.mapUI.loadConfig(),
    ]);

    await this.refreshTextResolveLookups();
    this.wireTextResolve();

    this.debugPanelUI.attachFlagDebug(this.flagStore, this.eventBus);
    this.setupCutsceneStepHud();

    if (!this.gameConfig.initialScene) {
      console.error('Game: initialScene not configured in game_config.json');
    }
    this.saveManager.setFallbackScene(this.gameConfig.fallbackScene || this.gameConfig.initialScene);

    await this.setupPlayer({ deferAvatar: this.isDevMode });
    this.setupRuntimeDebugSnapshotPublishing();
    this.setupRuntimeCommandPolling();

    if (this.isDevMode) {
      await this.startDevMode(
        options.playCutscene,
        options.waterPreview,
        options.sugarWheelPreview,
        options.paperCraftPreview,
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
      this.tick(dt);
    };
    ticker.add(this.mainTick);
    this.setupWebGlPanelDiagnostics();
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

  private async loadFlagRegistry(): Promise<void> {
    try {
      const reg = await this.assetManager.loadJson<FlagRegistryJson>(TEXT_URLS.flagRegistry);
      this.flagStore.configureRegistry(reg);
    } catch {
      this.flagStore.configureRegistry(null);
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

  private mountPlayerAvatar(
    texture: any,
    animDef: AnimationSetDef,
    stateMap: Record<string, string> | undefined,
    sourcePathForLog: string,
    applyStateMap: boolean,
  ): void {
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
    this.mountPlayerAvatar(loaded.texture, loaded.animDef, sm, path, true);
  }

  /** 按 game_config.playerAvatar 恢复（与开局 setupPlayer 数据源一致）。 */
  async resetPlayerAvatarFromAction(): Promise<void> {
    const avatar = this.gameConfig.playerAvatar;
    const defaultManifest = '/resources/runtime/animation/player_anim/anim.json';
    const path = (avatar?.animManifest?.trim() || defaultManifest);
    await this.applyPlayerAvatarFromAction(path, avatar?.stateMap ?? null);
  }

  private async setupPlayer(options: { deferAvatar?: boolean } = {}): Promise<void> {
    const avatar = this.gameConfig.playerAvatar;
    const defaultManifest = '/resources/runtime/animation/player_anim/anim.json';
    const playerAnimPath = (avatar?.animManifest?.trim() || defaultManifest);

    if (options.deferAvatar) {
      const { texture, animDef } = this.placeholderPlayerAvatar();
      this.mountPlayerAvatar(texture, animDef, undefined, playerAnimPath, false);
      void (async () => {
        await this.assetManager.preloadManifest({
          scopeId: 'startup:player',
          refs: await this.buildAnimationManifestRefs(playerAnimPath, '玩家动画'),
        }, { mode: 'runtime', tolerateErrors: true });
        const loaded = await this.loadPlayerAvatarResources(playerAnimPath);
        if (!loaded || this.tearDownComplete || !this.renderer.isInitialized()) return;
        this.mountPlayerAvatar(loaded.texture, loaded.animDef, avatar?.stateMap, playerAnimPath, true);
      })();
    } else {
      await this.assetManager.preloadManifest({
        scopeId: 'startup:player',
        refs: await this.buildAnimationManifestRefs(playerAnimPath, '玩家动画'),
      }, { mode: 'stage', tolerateErrors: true });
      const loaded = await this.loadPlayerAvatarResources(playerAnimPath);
      if (loaded) {
        this.mountPlayerAvatar(loaded.texture, loaded.animDef, avatar?.stateMap, playerAnimPath, true);
      } else {
        const { texture, animDef } = this.placeholderPlayerAvatar();
        this.mountPlayerAvatar(texture, animDef, undefined, playerAnimPath, false);
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
        await npc.moveTo(route[i].x, route[i].y, speed, moveAnimState);
        if (this.patrolGeneration !== gen || !this.sceneManager.getCurrentNpcs().includes(npc)) {
          break;
        }
        if (!npc.consumePatrolSkipWaypointAdvance()) {
          i += step;
          if (i >= route.length) {
            i = Math.max(0, route.length - 1);
            step = -1;
          } else if (i < 0) {
            i = 0;
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
      this.refreshPlayerWorldCollision();
    });

    this.sceneManager.setDepthUnloader(() => {
      this.sceneDepthSystem.unload();
      this.refreshPlayerWorldCollision();
      this.playerDepthFilter = null;
    });

    this.sceneManager.setSceneEnterRunner((actions) => this.actionExecutor.executeBatchAwait(actions));
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

  private registerUIPanels(): void {
    this.stateController.registerPanel('quest', this.questPanelUI, 'Tab');
    this.stateController.registerPanel('inventory', this.inventoryUI, 'KeyI');
    this.stateController.registerPanel('rules', this.rulesPanelUI, 'KeyR');
    this.stateController.registerPanel('dialogueLog', this.dialogueLogUI, 'KeyL');
    this.stateController.registerPanel('bookshelf', this.bookshelfUI, 'KeyB');
    this.stateController.registerPanel('map', this.mapUI, 'KeyM');
    this.stateController.registerPanel('ruleUse', this.ruleUseUI, 'KeyF');
    this.stateController.registerPanel('shop', this.shopUI);
    this.stateController.registerPanel('menu', this.menuUI);
    this.stateController.registerPanel('debug', this.debugPanelUI, 'F2', {
      alwaysOpenable: true,
      overlaysGameState: false,
    });

    this.stateController.setEscapeFallback(() => {
      this.stateController.setState(GameState.UIOverlay);
      this.menuUI.openPauseMenu();
    });

    const touchMount = document.getElementById('game-mount');
    if (touchMount) {
      this.touchMobileControls = new TouchMobileControls(
        this.inputManager,
        this.stateController,
        () => this.stateController.currentState,
        touchMount,
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

      try {
        this.playerDepthFilter = this.sceneDepthSystem.createFilterForEntity();
        if (this.playerDepthFilter) {
          depthLog('Game', 'attaching depth filter to player');
          this.player.sprite.container.filters = [this.playerDepthFilter];
        } else {
          depthLog('Game', 'no depth filter for player (disabled or no data)');
          this.player.sprite.container.filters = [];
        }
      } catch (e) {
        depthError('Game', 'player filter FAILED', e);
        this.playerDepthFilter = null;
        this.player.sprite.container.filters = [];
      }

      for (const npc of this.sceneManager.getCurrentNpcs()) {
        try {
          const npcFilter = this.sceneDepthSystem.createFilterForEntity();
          if (npcFilter) {
            depthLog('Game', 'attaching depth filter to NPC:', npc.id);
            npc.container.filters = [npcFilter];
          }
        } catch (e) {
          depthError('Game', 'NPC filter FAILED', npc.id, e);
        }
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

      for (const h of this.sceneManager.getCurrentHotspots()) {
        if (!h.hasDepthDisplayImage()) continue;
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
  }

  private async startDevMode(
    playCutscene?: string,
    waterPreview?: string,
    sugarWheelPreview?: string,
    paperCraftPreview?: string,
  ): Promise<void> {
    const DEV_SCENE = 'dev_room';
    await this.sceneManager.loadScene(DEV_SCENE);

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
    });
    this.devModeUI.open();

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
    };
    if (playCutscene) {
      setTimeout(() => this.devPlayCutscene(playCutscene), 300);
    }

    const wp = (waterPreview ?? '').trim();
    if (wp) {
      setTimeout(() => {
        this.devModeUI?.close();
        void this.waterMinigameManager.start(wp);
      }, playCutscene ? 900 : 450);
    }

    const swp = (sugarWheelPreview ?? '').trim();
    if (swp) {
      setTimeout(() => {
        this.devModeUI?.close();
        void this.sugarWheelMinigameManager.start(swp);
      }, playCutscene || wp ? 900 : 450);
    }

    const pcp = (paperCraftPreview ?? '').trim();
    if (pcp) {
      setTimeout(() => {
        this.devModeUI?.close();
        void this.paperCraftMinigameManager.start(pcp);
      }, playCutscene || wp || swp ? 900 : 450);
    }
  }

  private async devPlayCutscene(id: string): Promise<void> {
    if (this.cutsceneManager.isPlaying) return;
    this.devModeUI?.close();
    this.stateController.setState(GameState.Cutscene);
    await this.cutsceneManager.startCutscene(id);
    this.stateController.setState(GameState.Exploring);
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
    await this.cutsceneManager.startCutscene(cutsceneId);
    this.stateController.setState(GameState.Exploring);
  }

  private collectSaveData(): Record<string, object> {
    const data: Record<string, object> = {
      flagStore: this.flagStore.serialize(),
    };
    for (const entry of this.registeredSystems) {
      if (entry.system) data[entry.name] = entry.system.serialize();
    }
    data.dialogueLog = this.dialogueLogUI.serialize();
    data.game = { playTimeMs: this.playTimeMs };
    return data;
  }

  private distributeSaveData(data: Record<string, object>): void {
    if (data['flagStore']) this.flagStore.deserialize(data['flagStore'] as Record<string, boolean | number>);
    for (const entry of this.registeredSystems) {
      if (entry.system && data[entry.name]) entry.system.deserialize(data[entry.name]);
    }
    if (data['dialogueLog']) this.dialogueLogUI.deserialize(data['dialogueLog'] as any);
    if (data['game']) this.playTimeMs = (data['game'] as any).playTimeMs ?? 0;
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
      npc.applyEntityPixelDensityMatch(on, dBg, strengthScale);
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
    this.stateController.setState(GameState.Exploring);
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
      dialogue: this.graphDialogueManager.serialize(),
      runtimeCommands: {
        lastResults: this.lastRuntimeCommandResults.slice(-20),
      },
    };
  }

  private setupRuntimeDebugSnapshotPublishing(): void {
    if (!import.meta.env.DEV) return;
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
    this.scheduleRuntimeDebugSnapshotPublish('runtime-ready');
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
      const commands = Array.isArray(payload?.commands) ? payload.commands : [];
      if (commands.length === 0) return;
      const results = [];
      for (const command of commands.slice(0, 50)) {
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
      await fetch('/__gamedraft-api/runtime-command', { method: 'DELETE' });
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
    });
  }

  private async debugWait(durationMs: number): Promise<void> {
    const ms = Math.max(1, Math.min(60_000, Math.trunc(durationMs)));
    await new Promise<void>((resolve) => window.setTimeout(resolve, ms));
  }

  private debugSetPlayerPosition(x: number, y: number, snapCamera: boolean): void {
    this.player.x = x;
    this.player.y = y;
    if (snapCamera) {
      this.camera.snapTo(x, y);
    } else {
      this.camera.follow(x, y);
    }
  }

  private async debugMovePlayerTo(x: number, y: number, speed: number, snapCamera: boolean): Promise<void> {
    const safeSpeed = Math.max(1, Math.min(5000, speed));
    const dx = x - this.player.x;
    const dy = y - this.player.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance < 0.5) {
      this.debugSetPlayerPosition(x, y, snapCamera);
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
    this.debugSetPlayerPosition(x, y, snapCamera);
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

    this.eventBus.clear();

    this.stateController.closeAllPanels();

    this.inspectBox?.destroy();
    this.pickupNotification?.destroy();
    this.dialogueUI?.destroy();
    this.encounterUI?.destroy();
    this.actionChoiceUI?.destroy();
    this.hud?.destroy();
    this.notificationUI?.destroy();
    this.bookReaderUI?.destroy();
    this.questPanelUI?.destroy();
    this.inventoryUI?.destroy();
    this.rulesPanelUI?.destroy();
    this.dialogueLogUI?.destroy();
    this.bookshelfUI?.destroy();
    this.shopUI?.destroy();
    this.mapUI?.destroy();
    this.menuUI?.destroy();
    this.ruleUseUI?.destroy();
    this.debugPanelUI?.destroy();
    this.devModeUI?.destroy();
    this.devModeUI = null;
    delete window.__gameDevAPI;

    this.interactionCoordinator?.destroy();
    this.eventBridge?.destroy();
    this.debugTools?.destroy();
    this.depthDebugVisualizer?.destroy();

    this.stateController.destroy();

    this.touchMobileControls?.destroy();
    this.touchMobileControls = null;

    for (const entry of this.registeredSystems) {
      if (entry.system) entry.system.destroy();
    }

    this.actionExecutor.destroy();
    this.flagStore.destroy();
    this.inputManager.destroy();
    this.renderer.destroy();
  }

  private tick(dt: number): void {
    this.lastFps = dt > 0 ? 1 / dt : 0;
    this.playTimeMs += dt * 1000;

    this.camera.setPixelSnapTranslation(this.isEntityPixelDensityMatchRenderingOn());

    if (this.stateController.currentState === GameState.Exploring) {
      this.player.update(dt);
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

    if (this.sceneDepthSystem.isEnabled) {
      const S = this.camera.getProjectionScale();
      this.sceneDepthSystem.updatePerFrame(
        this.renderer.worldContainer.x,
        this.renderer.worldContainer.y,
        S,
      );
      const zones = this.sceneManager.currentSceneData?.zones;
      if (this.playerDepthFilter) {
        const ex = resolveDepthFloorOffsetBoost(
          zones,
          this.player.x,
          this.player.y,
          this.flagStore,
          {
            flagStore: this.flagStore,
            questManager: this.questManager,
            scenarioState: this.scenarioStateManager,
            narrativeState: this.narrativeStateManager,
          },
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
              const ex = resolveDepthFloorOffsetBoost(zones, c.x, c.y, this.flagStore, {
                flagStore: this.flagStore,
                questManager: this.questManager,
                scenarioState: this.scenarioStateManager,
                narrativeState: this.narrativeStateManager,
              });
              this.sceneDepthSystem.updateEntityDepthOcclusion(
                f as unknown as DepthOcclusionFilter,
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
        const ex = resolveDepthFloorOffsetBoost(zones, h.container.x, footY, this.flagStore, {
          flagStore: this.flagStore,
          questManager: this.questManager,
          scenarioState: this.scenarioStateManager,
          narrativeState: this.narrativeStateManager,
        });
        this.sceneDepthSystem.updateEntityDepthOcclusion(hf, h.container.x, footY, ex);
      }
    }

    this.renderer.sortEntityLayer(this.player.x, this.player.y);
    this.touchMobileControls?.update();
    this.inputManager.endFrame();
  }
}
