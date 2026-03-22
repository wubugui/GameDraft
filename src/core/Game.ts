import { EventBus } from './EventBus';
import { FlagStore } from './FlagStore';
import { InputManager } from './InputManager';
import { AssetManager } from './AssetManager';
import { ActionExecutor } from './ActionExecutor';
import { SaveManager } from './SaveManager';
import { Renderer } from '../rendering/Renderer';
import { Camera } from '../rendering/Camera';
import { Player } from '../entities/Player';
import { InteractionSystem } from '../systems/InteractionSystem';
import { SceneManager } from '../systems/SceneManager';
import { DialogueManager } from '../systems/DialogueManager';
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
import type { IGameSystem, AnimationSetDef, GameConfig } from '../data/types';
import { createPlaceholderPlayerTextures } from '../rendering/PlaceholderFactory';
import { resolveAssetPath } from './assetPath';
import type { Npc } from '../entities/Npc';
import { registerActionHandlers } from './ActionRegistry';
import { InteractionCoordinator } from './InteractionCoordinator';
import { EventBridge } from './EventBridge';
import { DebugTools } from './DebugTools';

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
  private questManager: QuestManager;
  private rulesManager: RulesManager;
  private inventoryManager: InventoryManager;
  private encounterManager: EncounterManager;
  private audioManager: AudioManager;
  private dayManager: DayManager;
  private cutsceneManager!: CutsceneManager;
  private archiveManager: ArchiveManager;
  private emoteBubbleManager: EmoteBubbleManager;
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

  private registeredSystems: { name: string; system: IGameSystem }[] = [];
  private boundCallbacks: { event: string; fn: (...args: any[]) => void }[] = [];
  private boundWindowListeners: { event: string; fn: EventListener }[] = [];
  private gameConfig: GameConfig = {
    initialScene: 'test_room_a',
    initialQuest: 'main_01',
    fallbackScene: 'test_room_a',
  };

  constructor() {
    this.stateController = new GameStateController();
    this.eventBus = new EventBus();
    this.flagStore = new FlagStore(this.eventBus);
    this.stringsProvider = new StringsProvider();
    this.inputManager = new InputManager();
    this.assetManager = new AssetManager();
    this.actionExecutor = new ActionExecutor(this.eventBus, this.flagStore);
    this.renderer = new Renderer();
    this.camera = new Camera(this.renderer.worldContainer);
    this.player = new Player(this.inputManager);
    this.interactionSystem = new InteractionSystem(this.eventBus, this.flagStore, this.inputManager);
    this.sceneManager = new SceneManager(this.assetManager, this.eventBus, this.renderer);
    this.dialogueManager = new DialogueManager(this.eventBus, this.flagStore, this.actionExecutor, this.assetManager);
    this.inventoryManager = new InventoryManager(this.eventBus, this.flagStore);
    this.rulesManager = new RulesManager(this.eventBus, this.flagStore);
    this.questManager = new QuestManager(this.eventBus, this.flagStore, this.actionExecutor);
    this.encounterManager = new EncounterManager(this.eventBus, this.flagStore, this.actionExecutor);
    this.audioManager = new AudioManager(this.eventBus);
    this.dayManager = new DayManager(this.eventBus, this.flagStore, this.actionExecutor);
    this.archiveManager = new ArchiveManager(this.eventBus, this.flagStore);
    this.emoteBubbleManager = new EmoteBubbleManager();
    this.zoneSystem = new ZoneSystem(this.eventBus, this.flagStore, this.actionExecutor);

    const ctx = { eventBus: this.eventBus, flagStore: this.flagStore, strings: this.stringsProvider };
    this.registeredSystems = [
      { name: 'sceneManager', system: this.sceneManager },
      { name: 'interactionSystem', system: this.interactionSystem },
      { name: 'dialogueManager', system: this.dialogueManager },
      { name: 'inventoryManager', system: this.inventoryManager },
      { name: 'rulesManager', system: this.rulesManager },
      { name: 'questManager', system: this.questManager },
      { name: 'encounterManager', system: this.encounterManager },
      { name: 'audioManager', system: this.audioManager },
      { name: 'dayManager', system: this.dayManager },
      { name: 'cutsceneManager', system: null as any },
      { name: 'archiveManager', system: this.archiveManager },
      { name: 'zoneSystem', system: this.zoneSystem },
    ];
    for (const entry of this.registeredSystems) {
      if (entry.system) entry.system.init(ctx);
    }
  }

  async start(): Promise<void> {
    await this.renderer.init();
    await this.stringsProvider.load();

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
    this.bookReaderUI = new BookReaderUI(this.renderer, this.archiveManager, this.stringsProvider);
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
      (onClose) => { const s = new CharacterBookUI(this.renderer, this.archiveManager, onClose, this.stringsProvider); s.open(); return s; },
      (onClose) => { const s = new LoreBookUI(this.renderer, this.archiveManager, onClose, this.stringsProvider); s.open(); return s; },
      (onClose) => { const s = new DocumentBoxUI(this.renderer, this.archiveManager, onClose, this.stringsProvider); s.open(); return s; },
      this.stringsProvider,
    );
    this.shopUI = new ShopUI(this.renderer, this.eventBus, this.inventoryManager, this.stringsProvider);
    this.mapUI = new MapUI(this.renderer, this.eventBus, this.flagStore, this.stringsProvider);

    const cutsceneRenderer = new CutsceneRenderer(this.renderer, this.camera);
    this.cutsceneManager = new CutsceneManager(
      this.eventBus, this.flagStore, this.actionExecutor,
      cutsceneRenderer,
    );
    this.cutsceneManager.init({ eventBus: this.eventBus, flagStore: this.flagStore, strings: this.stringsProvider });
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

    this.saveManager = new SaveManager(
      () => this.collectSaveData(),
      (data) => this.distributeSaveData(data),
      (sceneId) => this.reloadScene(sceneId),
      this.stringsProvider,
      this.gameConfig.fallbackScene,
    );
    this.menuUI = new MenuUI(this.renderer, this.eventBus, this.saveManager, this.audioManager, this.stringsProvider);
    this.ruleUseUI = new RuleUseUI(this.renderer, this.eventBus, this.zoneSystem, this.rulesManager, this.stringsProvider);
    this.debugPanelUI = new DebugPanelUI(this.renderer, () => ({
      fps: this.lastFps,
      sceneId: this.sceneManager.currentSceneData?.id ?? undefined,
      state: this.stateController.currentState,
    }));

    this.camera.setScreenSize(this.renderer.screenWidth, this.renderer.screenHeight);
    this.addWindowListener('resize', () => {
      this.camera.setScreenSize(this.renderer.screenWidth, this.renderer.screenHeight);
    });

    this.setupSceneManager();
    this.registerUIPanels();

    registerActionHandlers(this.actionExecutor, {
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
    });

    this.interactionCoordinator = new InteractionCoordinator(this.eventBus, {
      stateController: this.stateController,
      sceneManager: this.sceneManager,
      dialogueManager: this.dialogueManager,
      actionExecutor: this.actionExecutor,
      inspectBox: this.inspectBox,
      eventBus: this.eventBus,
    });
    this.interactionCoordinator.init();

    this.eventBridge = new EventBridge(this.eventBus, {
      dialogueManager: this.dialogueManager,
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

    this.debugTools = new DebugTools({
      renderer: this.renderer,
      eventBus: this.eventBus,
      player: this.player,
      inventoryManager: this.inventoryManager,
      debugPanelUI: this.debugPanelUI,
      getCurrentSceneId: () => this.sceneManager.currentSceneData?.id,
      fallbackScene: this.gameConfig.fallbackScene,
      reloadScene: (id) => this.reloadScene(id),
    });
    this.debugTools.init();

    await Promise.all([
      this.loadGameConfig(),
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

    await this.setupPlayer();
    this.questManager.acceptQuest(this.gameConfig.initialQuest);

    await this.sceneManager.loadScene(this.gameConfig.initialScene);
    await this.tryStartInitialPrologue();

    this.lastTime = performance.now();
    this.renderer.app.ticker.add(() => {
      const now = performance.now();
      const dt = Math.min((now - this.lastTime) / 1000, 0.1);
      this.lastTime = now;
      this.tick(dt);
    });
  }

  private async loadGameConfig(): Promise<void> {
    try {
      const resp = await fetch(resolveAssetPath('/assets/data/game_config.json'));
      const cfg = await resp.json() as Partial<GameConfig>;
      if (cfg.initialScene) this.gameConfig.initialScene = cfg.initialScene;
      if (cfg.initialQuest) this.gameConfig.initialQuest = cfg.initialQuest;
      if (cfg.fallbackScene) this.gameConfig.fallbackScene = cfg.fallbackScene;
      if (cfg.initialCutscene !== undefined) this.gameConfig.initialCutscene = cfg.initialCutscene;
    } catch {
      console.warn('Game: game_config.json not found, using defaults');
    }
  }

  private async setupPlayer(): Promise<void> {
    let animDef: AnimationSetDef;
    let texture: any;

    try {
      const resp = await fetch(resolveAssetPath('/assets/data/player_anim.json'));
      animDef = await resp.json() as AnimationSetDef;

      if (animDef.spritesheet) {
        texture = await this.assetManager.loadTexture(animDef.spritesheet);
      } else {
        const placeholder = createPlaceholderPlayerTextures(this.renderer.app);
        texture = placeholder.texture;
      }
    } catch {
      const placeholder = createPlaceholderPlayerTextures(this.renderer.app);
      texture = placeholder.texture;
      animDef = {
        spritesheet: '',
        frameWidth: placeholder.frameWidth,
        frameHeight: placeholder.frameHeight,
        states: {
          idle: { frames: [0, 1], frameRate: 2, loop: true },
          walk: { frames: [2, 3, 4, 5], frameRate: 8, loop: true },
          run:  { frames: [2, 3, 4, 5], frameRate: 12, loop: true },
        },
      };
    }

    this.playerAnimDef = animDef;
    this.player.sprite.loadFromDef(texture, animDef);
    this.player.sprite.playAnimation('idle');
    this.applyPlayerSceneScale();
    this.renderer.entityLayer.addChild(this.player.sprite.container);

    const playerPosGetter = () => ({ x: this.player.x, y: this.player.y });
    this.interactionSystem.setPlayerPositionGetter(playerPosGetter);
    this.zoneSystem.setPlayerPositionGetter(playerPosGetter);
  }

  private applyPlayerSceneScale(): void {
    if (!this.playerAnimDef) return;
    const sceneData = this.sceneManager.currentSceneData;
    const spriteScaleFactor = sceneData?.spriteScaleFactor ?? 1;
    const overrideSceneScale = this.playerAnimDef.overrideSceneScale ?? false;
    const baseScale = this.playerAnimDef.scale ?? 1;
    const effectiveScale = overrideSceneScale ? baseScale : baseScale * spriteScaleFactor;
    this.player.sprite.setScale(effectiveScale);
  }

  private runNpcPatrol(
    npc: Npc,
    route: { x: number; y: number }[],
    speed: number,
  ): void {
    const run = async () => {
      let i = 0;
      let step = 1;
      while (this.sceneManager.getCurrentNpcs().includes(npc)) {
        await npc.moveTo(route[i].x, route[i].y, speed);
        if (!this.sceneManager.getCurrentNpcs().includes(npc)) break;
        i += step;
        if (i >= route.length) {
          i = Math.max(0, route.length - 1);
          step = -1;
        } else if (i < 0) {
          i = 0;
          step = 1;
        }
      }
    };
    run();
  }

  private setupSceneManager(): void {
    this.sceneManager.setCollisionSetter((collisions) => {
      this.player.setCollisions(collisions);
    });

    this.sceneManager.setPlayerPositionSetter((x, y) => {
      this.player.x = x;
      this.player.y = y;
    });

    this.sceneManager.setCameraSetter((boundsW, boundsH, snapX, snapY) => {
      this.camera.setBounds(boundsW, boundsH);
      this.camera.snapTo(snapX, snapY);
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
      additionalKeys: ['Backquote'],
    });

    this.stateController.setEscapeFallback(() => {
      this.stateController.setState(GameState.UIOverlay);
      this.menuUI.openPauseMenu();
    });
  }

  private setupSceneReadyHandler(): void {
    this.listenEvent('scene:ready', () => {
      this.applyPlayerSceneScale();
      this.interactionSystem.update(0);
      for (const npc of this.sceneManager.getCurrentNpcs()) {
        const patrol = npc.def.patrol;
        if (patrol?.route && patrol.route.length > 0) {
          this.runNpcPatrol(npc, patrol.route, patrol.speed ?? 60);
        }
      }
    });
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
    for (const { event, fn } of this.boundCallbacks) {
      this.eventBus.off(event, fn);
    }
    this.boundCallbacks = [];

    for (const { event, fn } of this.boundWindowListeners) {
      window.removeEventListener(event, fn);
    }
    this.boundWindowListeners = [];

    this.stateController.closeAllPanels();

    this.inspectBox?.destroy();
    this.pickupNotification?.destroy();
    this.dialogueUI?.destroy();
    this.encounterUI?.destroy();
    this.hud?.destroy();
    this.notificationUI?.destroy();
    this.bookReaderUI?.destroy();
    this.emoteBubbleManager?.destroy();

    this.interactionCoordinator?.destroy();
    this.eventBridge?.destroy();
    this.debugTools?.destroy();

    this.stateController.destroy();

    for (const entry of this.registeredSystems) {
      if (entry.system) entry.system.destroy();
    }

    this.actionExecutor.destroy();
    this.flagStore.destroy();
    this.eventBus.clear();
    this.inputManager.destroy();
    this.renderer.destroy();
  }

  private tick(dt: number): void {
    this.lastFps = dt > 0 ? 1 / dt : 0;
    this.playTimeMs += dt * 1000;

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
    }

    if (this.stateController.currentState === GameState.Encounter) {
      this.encounterUI.update(dt);
    }

    this.emoteBubbleManager.update(dt);
    this.notificationUI.update(dt);
    this.camera.update(dt);
    this.debugTools?.update(dt);
    this.renderer.sortEntityLayer();
    this.inputManager.endFrame();
  }
}
