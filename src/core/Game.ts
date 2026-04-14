import { EventBus } from './EventBus';
import { FlagStore, type FlagRegistryJson } from './FlagStore';
import { InputManager } from './InputManager';
import { AssetManager } from './AssetManager';
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
import type { ActionDef, IGameSystem, AnimationSetDef, GameConfig, SceneDataRaw } from '../data/types';
import { DEFAULT_ENTITY_PIXEL_DENSITY_BLUR_SCALE } from '../rendering/EntityPixelDensityMatch';
import type { AnimationSetDefInput } from '../data/resolveAnimationSet';
import { normalizeAnimationSetDef } from '../data/resolveAnimationSet';
import { resolvePathRelativeToAnimManifest } from './assetPath';
import { createPlaceholderPlayerTextures } from '../rendering/PlaceholderFactory';
import type { Npc } from '../entities/Npc';
import { registerActionHandlers } from './ActionRegistry';
import { RuleOfferRegistry } from './RuleOfferRegistry';
import { InteractionCoordinator } from './InteractionCoordinator';
import { EventBridge } from './EventBridge';
import { DebugTools } from './DebugTools';
import { SceneDepthSystem } from './SceneDepthSystem';
import { DepthDebugVisualizer } from '../debug/DepthDebugVisualizer';
import type { DepthOcclusionFilter } from '../rendering/DepthOcclusionFilter';
import { resolveDepthFloorOffsetBoost } from '../utils/depthFloorZones';
import { isPointInPolygon, isValidZonePolygon } from '../utils/zoneGeometry';
import { hotspotCollisionPolygonToWorld } from '../utils/hotspotCollision';
import { depthLog, depthError } from './depthLog';
import { DevModeUI } from '../ui/DevModeUI';
import { waitClickContinueWithHint } from '../ui/ClickContinuePrompt';
import { TouchMobileControls } from '../ui/TouchMobileControls';

export interface GameStartOptions {
  devMode?: boolean;
  playCutscene?: string;
}

declare global {
  interface Window {
    __gameDevAPI?: {
      playCutscene(id: string): void;
      reload(): void;
      isReady(): boolean;
      /** 重新打开 Dev Mode 面板（从场景列表跳转后不会自动再开） */
      openDevPanel(): void;
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
  private questManager: QuestManager;
  private rulesManager: RulesManager;
  private inventoryManager: InventoryManager;
  private encounterManager: EncounterManager;
  private audioManager: AudioManager;
  private dayManager: DayManager;
  private cutsceneManager!: CutsceneManager;
  private archiveManager: ArchiveManager;
  private emoteBubbleManager: EmoteBubbleManager;
  private ruleOfferRegistry: RuleOfferRegistry;
  private zoneSystem: ZoneSystem;
  private saveManager!: SaveManager;
  private inspectBox!: InspectBox;
  private pickupNotification!: PickupNotification;
  private dialogueUI!: DialogueUI;
  private encounterUI!: EncounterUI;
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

  private stateController: GameStateController;
  private lastTime: number = 0;
  private lastFps: number = 0;
  private playTimeMs: number = 0;
  private playerAnimDef: AnimationSetDef | null = null;

  private interactionCoordinator!: InteractionCoordinator;
  private eventBridge!: EventBridge;
  private debugTools!: DebugTools;
  private sceneDepthSystem: SceneDepthSystem;
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
      animManifest: '/assets/animation/player_anim/anim.json',
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
    this.stateController = new GameStateController(this.inputManager);
    this.actionExecutor = new ActionExecutor(this.eventBus, this.flagStore);
    this.ruleOfferRegistry = new RuleOfferRegistry();
    this.renderer = new Renderer();
    this.camera = new Camera(this.renderer.worldContainer);
    this.player = new Player(this.inputManager);
    this.interactionSystem = new InteractionSystem(this.eventBus, this.flagStore, this.inputManager);
    this.sceneManager = new SceneManager(this.assetManager, this.eventBus, this.renderer);
    this.inventoryManager = new InventoryManager(this.eventBus, this.flagStore);
    this.rulesManager = new RulesManager(this.eventBus, this.flagStore);
    this.dialogueManager = new DialogueManager(this.eventBus);
    this.questManager = new QuestManager(this.eventBus, this.flagStore, this.actionExecutor);
    this.graphDialogueManager = new GraphDialogueManager(
      this.eventBus,
      this.flagStore,
      this.actionExecutor,
      this.assetManager,
      this.sceneManager,
      this.rulesManager,
      this.questManager,
      this.inventoryManager,
    );
    this.encounterManager = new EncounterManager(this.eventBus, this.flagStore, this.actionExecutor);
    this.audioManager = new AudioManager(this.eventBus);
    this.dayManager = new DayManager(this.eventBus, this.flagStore, this.actionExecutor);
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
      { name: 'encounterManager', system: this.encounterManager },
      { name: 'audioManager', system: this.audioManager },
      { name: 'dayManager', system: this.dayManager },
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

  async start(options: GameStartOptions = {}): Promise<void> {
    this.isDevMode = !!options.devMode;
    await this.renderer.init();
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
    this.shopUI = new ShopUI(this.renderer, this.eventBus, this.inventoryManager, this.stringsProvider);
    this.mapUI = new MapUI(this.renderer, this.eventBus, this.flagStore, this.stringsProvider);

    const cutsceneRenderer = new CutsceneRenderer(this.renderer, this.camera);
    cutsceneRenderer.setZoomRestoreProvider(() => this.sceneManager.currentSceneData?.camera?.zoom ?? 1);
    this.cutsceneManager = new CutsceneManager(
      this.eventBus, this.flagStore, this.actionExecutor,
      cutsceneRenderer,
    );
    this.cutsceneManager.init({ eventBus: this.eventBus, flagStore: this.flagStore, strings: this.stringsProvider, assetManager: this.assetManager });
    this.cutsceneManager.setInputManager(this.inputManager);
    const cmEntry = this.registeredSystems.find(e => e.name === 'cutsceneManager');
    if (cmEntry) cmEntry.system = this.cutsceneManager;
    this.cutsceneManager.setEntityResolver((id: string) => {
      if (id === 'player') return this.player;
      return this.sceneManager.getNpcById(id);
    });
    this.cutsceneManager.setEmoteBubbleProvider(this.emoteBubbleManager);
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
    this.cutsceneManager.setSpawnPointResolver((spawnKey: string) => {
      const scene = this.sceneManager.currentSceneData;
      if (!scene) return null;
      if (!spawnKey) return scene.spawnPoint ?? null;
      return scene.spawnPoints?.[spawnKey] ?? null;
    });
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

    registerActionHandlers(this.actionExecutor, {
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
      resolveActor: (id) => id === 'player' ? this.player : this.sceneManager.getNpcById(id),
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
        this.cutsceneManager.fadingCameraZoom(target, durationMs);
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
      blendOverlayImage: (id, fromPath, toPath, xPct, yPct, wPct, durationMs) =>
        this.cutsceneManager.blendOverlayImage(id, fromPath, toPath, xPct, yPct, wPct, durationMs),
      startDialogueGraph: async (graphId, entry, npcId) => {
        this.stateController.setState(GameState.Dialogue);
        try {
          let npcName = '';
          if (npcId?.trim()) {
            const npc = this.sceneManager.getNpcById(npcId.trim());
            if (npc) npcName = npc.def.name;
          }
          await this.graphDialogueManager.startDialogueGraph({
            graphId,
            entry,
            npcName,
            npcId: npcId?.trim() || undefined,
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
    });

    this.interactionCoordinator = new InteractionCoordinator(this.eventBus, {
      stateController: this.stateController,
      sceneManager: this.sceneManager,
      dialogueManager: this.dialogueManager,
      graphDialogueManager: this.graphDialogueManager,
      actionExecutor: this.actionExecutor,
      inspectBox: this.inspectBox,
      eventBus: this.eventBus,
      getPlayerWorldPos: () => ({ x: this.player.x, y: this.player.y }),
      preparePlayerForNpcDialogue: (npc) => {
        this.player.setFacing(npc.x - this.player.x, npc.y - this.player.y);
        this.player.playAnimation(ANIM_IDLE);
      },
      fadingDialogueCameraZoom: (targetZoom, durationMs) => {
        this.cutsceneManager.fadingCameraZoom(targetZoom, durationMs);
      },
      fadingRestoreSceneCameraZoom: (durationMs) => {
        const z = this.sceneManager.currentSceneData?.camera?.zoom;
        const target = z !== undefined && Number.isFinite(z) && z > 0 ? z : 1;
        this.cutsceneManager.fadingCameraZoom(target, durationMs);
      },
    });
    this.interactionCoordinator.init();

    this.listenEvent('archive:firstView', (p: { actions: ActionDef[] }) => {
      void (async () => {
        for (const a of p.actions) {
          try {
            await this.actionExecutor.executeAwait(a);
          } catch (e) {
            console.warn('Game: archive:firstView action failed', a.type, e);
          }
        }
      })();
    });

    this.eventBridge = new EventBridge(this.eventBus, {
      dialogueManager: this.dialogueManager,
      graphDialogueManager: this.graphDialogueManager,
      encounterManager: this.encounterManager,
      stateController: this.stateController,
      actionExecutor: this.actionExecutor,
      sceneManager: this.sceneManager,
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

    this.debugPanelUI.attachFlagDebug(this.flagStore, this.eventBus);

    if (!this.gameConfig.initialScene) {
      console.error('Game: initialScene not configured in game_config.json');
    }
    this.saveManager.setFallbackScene(this.gameConfig.fallbackScene || this.gameConfig.initialScene);

    await this.setupPlayer();

    if (this.isDevMode) {
      await this.startDevMode(options.playCutscene);
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
  }

  private async loadFlagRegistry(): Promise<void> {
    try {
      const reg = await this.assetManager.loadJson<FlagRegistryJson>('/assets/data/flag_registry.json');
      this.flagStore.configureRegistry(reg);
    } catch {
      this.flagStore.configureRegistry(null);
    }
  }

  private async loadGameConfig(): Promise<void> {
    try {
      const cfg = await this.assetManager.loadJson<Partial<GameConfig>>('/assets/data/game_config.json');
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
      const ov = await this.assetManager.loadJson<Record<string, string>>('/assets/data/overlay_images.json');
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
    const defaultManifest = '/assets/animation/player_anim/anim.json';
    const path = (avatar?.animManifest?.trim() || defaultManifest);
    await this.applyPlayerAvatarFromAction(path, avatar?.stateMap ?? null);
  }

  private async setupPlayer(): Promise<void> {
    const avatar = this.gameConfig.playerAvatar;
    const defaultManifest = '/assets/animation/player_anim/anim.json';
    const playerAnimPath = (avatar?.animManifest?.trim() || defaultManifest);
    const loaded = await this.loadPlayerAvatarResources(playerAnimPath);
    if (loaded) {
      this.mountPlayerAvatar(loaded.texture, loaded.animDef, avatar?.stateMap, playerAnimPath, true);
    } else {
      const { texture, animDef } = this.placeholderPlayerAvatar();
      this.mountPlayerAvatar(texture, animDef, undefined, playerAnimPath, false);
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
    const moveAnim =
      npc.def.id === 'npc_ringboy' && this.flagStore.get('ringboy_patrol_walk_anim') === true
        ? 'boy_walk'
        : patrol.moveAnimState;
    this.runNpcPatrol(npc, patrol.route, patrol.speed ?? 60, moveAnim);
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
        const moveAnim =
          npc.def.id === 'npc_ringboy' && this.flagStore.get('ringboy_patrol_walk_anim') === true
            ? 'boy_walk'
            : moveAnimState;
        await npc.moveTo(route[i].x, route[i].y, speed, moveAnim);
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
        await this.sceneDepthSystem.load(
          sceneId, dc, this.assetManager,
          sceneData.worldWidth, sceneData.worldHeight,
          worldToPixelX, worldToPixelY,
        );
      } else {
        this.sceneDepthSystem.loadDefault();
      }
      this.refreshPlayerWorldCollision();
    });

    this.sceneManager.setDepthUnloader(() => {
      this.sceneDepthSystem.unload();
      this.refreshPlayerWorldCollision();
      this.playerDepthFilter = null;
    });
  }

  /** 深度图碰撞与热区多边形碰撞合并（已拾取/失效的热区不参与） */
  private refreshPlayerWorldCollision(): void {
    this.player.setDepthCollision((wx, wy) => {
      if (this.sceneDepthSystem.isCollision(wx, wy)) return true;
      for (const h of this.sceneManager.getCurrentHotspots()) {
        if (!h.active) continue;
        const worldPoly = hotspotCollisionPolygonToWorld(h.def);
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
      const dTex = this.sceneDepthSystem.currentDepthTexture;
      const dCfg = this.sceneDepthSystem.currentConfig;
      if (dTex && dCfg) {
        const sd = this.sceneManager.currentSceneData!;
        this.depthDebugVisualizer.onSceneLoaded(
          this.sceneDepthSystem.currentSceneId,
          dTex,
          dTex.width,
          dTex.height,
          sd.worldWidth,
          sd.worldHeight,
          dCfg,
        );
      }
    });
  }

  private async startDevMode(playCutscene?: string): Promise<void> {
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
    });
    this.devModeUI.open();

    window.__gameDevAPI = {
      playCutscene: (id: string) => this.devPlayCutscene(id),
      reload: () => this.devReload(),
      isReady: () => true,
      openDevPanel: () => this.devModeUI?.open(),
    };

    if (playCutscene) {
      setTimeout(() => this.devPlayCutscene(playCutscene), 300);
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
          const raw = await this.assetManager.loadJson<SceneDataRaw>(`assets/scenes/${id}.json`);
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

  private async reloadScene(sceneId: string): Promise<void> {
    this.sceneManager.unloadScene();
    await this.sceneManager.loadScene(sceneId);
    this.stateController.setState(GameState.Exploring);
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

    for (const { event, fn } of this.boundCallbacks) {
      this.eventBus.off(event, fn);
    }
    this.boundCallbacks = [];

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
      this.player.sprite.update(dt);
      for (const npc of this.sceneManager.getCurrentNpcs()) {
        npc.cutsceneUpdate(dt);
      }
    }

    if (this.stateController.currentState === GameState.Encounter) {
      this.encounterUI.update(dt);
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
              const ex = resolveDepthFloorOffsetBoost(zones, c.x, c.y, this.flagStore);
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
        const ex = resolveDepthFloorOffsetBoost(zones, h.container.x, footY, this.flagStore);
        this.sceneDepthSystem.updateEntityDepthOcclusion(hf, h.container.x, footY, ex);
      }
    }

    this.renderer.sortEntityLayer();
    this.touchMobileControls?.update();
    this.inputManager.endFrame();
  }
}
