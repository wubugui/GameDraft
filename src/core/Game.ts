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
import { ShopUI } from '../ui/ShopUI';
import { MapUI } from '../ui/MapUI';
import { MenuUI } from '../ui/MenuUI';
import { RuleUseUI } from '../ui/RuleUseUI';
import { GameStateController } from './GameStateController';
import { StringsProvider } from './StringsProvider';
import { GameState } from '../data/types';
import type { HotspotDef, InspectData, PickupData, TransitionData, EncounterTriggerData, IGameSystem, AnimationSetDef, GameConfig } from '../data/types';
import { createPlaceholderPlayerTextures } from '../rendering/PlaceholderFactory';
import { resolveAssetPath } from './assetPath';
import type { Hotspot } from '../entities/Hotspot';
import type { Npc } from '../entities/Npc';

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

  private stateController: GameStateController;
  private lastTime: number = 0;
  private playTimeMs: number = 0;
  private positionDebugMode: boolean = false;
  private positionDebugKeyHandler: (e: KeyboardEvent) => void = () => {};
  private positionDebugPointerHandler: (e: PointerEvent) => void = () => {};

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

    this.inspectBox = new InspectBox(this.renderer);
    this.pickupNotification = new PickupNotification(this.renderer);
    this.dialogueUI = new DialogueUI(this.renderer, this.eventBus);
    this.encounterUI = new EncounterUI(this.renderer, this.eventBus);
    this.hud = new HUD(this.renderer, this.eventBus);
    this.notificationUI = new NotificationUI(this.renderer, this.eventBus);
    this.questPanelUI = new QuestPanelUI(this.renderer, this.questManager);
    this.inventoryUI = new InventoryUI(this.renderer, this.eventBus, this.inventoryManager);
    this.rulesPanelUI = new RulesPanelUI(this.renderer, this.rulesManager);
    this.dialogueLogUI = new DialogueLogUI(this.renderer, this.eventBus);
    this.bookReaderUI = new BookReaderUI(this.renderer, this.archiveManager);
    this.bookshelfUI = new BookshelfUI(
      this.renderer, this.archiveManager,
      () => {
        this.stateController.restorePreviousState();
        this.stateController.togglePanel('rules');
      },
    );
    this.bookshelfUI.setBookReaderUI(this.bookReaderUI);
    this.shopUI = new ShopUI(this.renderer, this.eventBus, this.inventoryManager);
    this.mapUI = new MapUI(this.renderer, this.eventBus, this.flagStore);
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
    this.cutsceneManager.setEmoteBubbleManager(this.emoteBubbleManager);
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
      this.gameConfig.fallbackScene,
    );
    this.menuUI = new MenuUI(this.renderer, this.eventBus, this.saveManager, this.audioManager);
    this.ruleUseUI = new RuleUseUI(this.renderer, this.eventBus, this.zoneSystem, this.rulesManager);

    this.camera.setScreenSize(this.renderer.screenWidth, this.renderer.screenHeight);
    this.addWindowListener('resize', () => {
      this.camera.setScreenSize(this.renderer.screenWidth, this.renderer.screenHeight);
    });

    this.setupPositionDebugTool();

    this.registerActionHandlers();
    this.setupSceneManager();
    this.setupInteractionHandlers();
    this.setupDialogueHandlers();
    this.setupEncounterHandlers();
    this.registerUIPanels();
    this.setupMenuHandlers();
    this.setupEventConsumers();

    await Promise.all([
      this.loadGameConfig(),
      this.stringsProvider.load(),
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

  private registerActionHandlers(): void {
    this.actionExecutor.register('giveItem', (params) => {
      const id = params.id as string;
      const count = (params.count as number) ?? 1;
      this.inventoryManager.addItem(id, count);
    });

    this.actionExecutor.register('removeItem', (params) => {
      const id = params.id as string;
      const count = (params.count as number) ?? 1;
      this.inventoryManager.removeItem(id, count);
    });

    this.actionExecutor.register('giveCurrency', (params) => {
      this.inventoryManager.addCoins(params.amount as number);
    });

    this.actionExecutor.register('removeCurrency', (params) => {
      this.inventoryManager.removeCoins(params.amount as number);
    });

    this.actionExecutor.register('giveRule', (params) => {
      this.rulesManager.giveRule(params.id as string);
    });

    this.actionExecutor.register('giveFragment', (params) => {
      this.rulesManager.giveFragment(params.id as string);
    });

    this.actionExecutor.register('updateQuest', (params) => {
      this.questManager.acceptQuest(params.id as string);
    });

    this.actionExecutor.register('startEncounter', (params) => {
      this.stateController.setState(GameState.Encounter);
      this.encounterManager.startEncounter(params.id as string);
    });

    this.actionExecutor.register('playBgm', (params) => {
      this.audioManager.playBgm(params.id as string, (params.fadeMs as number) ?? 1000);
    });

    this.actionExecutor.register('stopBgm', (params) => {
      this.audioManager.stopBgm((params.fadeMs as number) ?? 1000);
    });

    this.actionExecutor.register('playSfx', (params) => {
      this.audioManager.playSfx(params.id as string);
    });

    this.actionExecutor.register('endDay', () => {
      this.dayManager.endDay();
    });

    this.actionExecutor.register('addDelayedEvent', (params) => {
      this.dayManager.addDelayedEvent(
        params.targetDay as number,
        params.actions as any[],
      );
    });

    this.actionExecutor.register('addArchiveEntry', (params) => {
      this.archiveManager.addEntry(
        params.bookType as 'character' | 'lore' | 'document' | 'book',
        params.entryId as string,
      );
    });

    this.actionExecutor.register('startCutscene', (params) => {
      this.stateController.setState(GameState.Cutscene);
      this.cutsceneManager.startCutscene(params.id as string).then(() => {
        this.stateController.setState(GameState.Exploring);
      });
    });

    this.actionExecutor.register('showEmote', (params) => {
      const targetId = params.target as string;
      let actor: import('../data/types').ICutsceneActor | null = null;
      if (targetId === 'player') actor = this.player;
      else actor = this.sceneManager.getNpcById(targetId);
      if (actor) {
        this.emoteBubbleManager.show(actor, params.emote as string, (params.duration as number) ?? 1500);
      }
    });

    this.actionExecutor.register('openShop', (params) => {
      this.stateController.setState(GameState.UIOverlay);
      this.shopUI.openShop(params.shopId as string);
    });

    this.actionExecutor.register('pickup', (params) => {
      const isCurrency = params.isCurrency as boolean | undefined;
      if (isCurrency) {
        this.inventoryManager.addCoins(params.count as number);
      } else {
        this.inventoryManager.addItem(params.itemId as string, params.count as number);
      }
      this.pickupNotification.show(params.itemName as string, params.count as number);
    });

    this.actionExecutor.register('switchScene', (params) => {
      this.stateController.setState(GameState.Cutscene);
      this.pickupNotification.forceCleanup();
      if (this.inspectBox.isOpen) this.inspectBox.close();
      this.sceneManager.switchScene(
        params.targetScene as string,
        params.targetSpawnPoint as string | undefined,
      ).then(() => {
        this.stateController.setState(GameState.Exploring);
      });
    });

    this.actionExecutor.register('changeScene', (params) => {
      this.stateController.setState(GameState.Cutscene);
      this.pickupNotification.forceCleanup();
      if (this.inspectBox.isOpen) this.inspectBox.close();
      const cameraPos = typeof params.cameraX === 'number' && typeof params.cameraY === 'number'
        ? { x: params.cameraX as number, y: params.cameraY as number }
        : undefined;
      this.sceneManager.switchScene(
        params.targetScene as string,
        params.targetSpawnPoint as string | undefined,
        cameraPos,
      ).then(() => {
        this.stateController.setState(GameState.Exploring);
      });
    });
  }

  private async loadGameConfig(): Promise<void> {
    try {
      const resp = await fetch(resolveAssetPath('/assets/data/game_config.json'));
      const cfg = await resp.json() as Partial<GameConfig>;
      if (cfg.initialScene) this.gameConfig.initialScene = cfg.initialScene;
      if (cfg.initialQuest) this.gameConfig.initialQuest = cfg.initialQuest;
      if (cfg.fallbackScene) this.gameConfig.fallbackScene = cfg.fallbackScene;
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

    this.player.sprite.loadFromDef(texture, animDef);
    this.player.sprite.playAnimation('idle');
    this.player.sprite.setScale(animDef.scale ?? 1);
    this.renderer.entityLayer.addChild(this.player.sprite.container);

    const playerPosGetter = () => ({ x: this.player.x, y: this.player.y });
    this.interactionSystem.setPlayerPositionGetter(playerPosGetter);
    this.zoneSystem.setPlayerPositionGetter(playerPosGetter);
  }

  private setupPositionDebugTool(): void {
    const canvas = this.renderer.app.canvas as HTMLCanvasElement;
    if (!canvas) return;

    this.positionDebugKeyHandler = (e: KeyboardEvent) => {
      if (e.key === 'F10') {
        e.preventDefault();
        this.positionDebugMode = !this.positionDebugMode;
        const msg = this.positionDebugMode ? 'Position debug: ON (click to log world x,y)' : 'Position debug: OFF';
        console.log(msg);
        this.eventBus.emit('notification:show', { text: msg, type: 'info' });
      }
    };
    window.addEventListener('keydown', this.positionDebugKeyHandler);

    this.positionDebugPointerHandler = (e: PointerEvent) => {
      if (!this.positionDebugMode) return;
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const scaleX = this.renderer.app.screen.width / rect.width;
      const scaleY = this.renderer.app.screen.height / rect.height;
      const stageX = (e.clientX - rect.left) * scaleX;
      const stageY = (e.clientY - rect.top) * scaleY;
      const world = this.renderer.worldContainer.toLocal({ x: stageX, y: stageY });
      const x = Math.round(world.x);
      const y = Math.round(world.y);
      const text = `x: ${x}, y: ${y}`;
      console.log(text);
      this.eventBus.emit('notification:show', { text, type: 'info' });
    };
    canvas.addEventListener('pointerdown', this.positionDebugPointerHandler);
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

  private setupInteractionHandlers(): void {
    this.listenEvent('hotspot:triggered', (payload: { hotspot: Hotspot; def: HotspotDef }) => {
      this.handleHotspotInteraction(payload.hotspot, payload.def);
    });

    this.listenEvent('npc:interact', (payload: { npc: Npc }) => {
      this.handleNpcInteraction(payload.npc);
    });
  }

  private setupDialogueHandlers(): void {
    this.listenEvent('dialogue:advance', () => {
      this.dialogueManager.advance();
    });

    this.listenEvent('dialogue:advanceEnd', () => {
      this.dialogueManager.endDialogue();
    });

    this.listenEvent('dialogue:choiceSelected', (payload: { index: number }) => {
      this.dialogueManager.chooseOption(payload.index);
    });

    this.listenEvent('dialogue:end', () => {
      this.stateController.setState(GameState.Exploring);
    });
  }

  private setupEncounterHandlers(): void {
    this.listenEvent('encounter:narrativeDone', () => {
      this.encounterManager.generateOptions();
    });

    this.listenEvent('encounter:choiceSelected', (payload: { index: number }) => {
      this.encounterManager.chooseOption(payload.index);
    });

    this.listenEvent('encounter:resultDone', () => {
      this.encounterManager.endEncounter();
    });

    this.listenEvent('encounter:end', () => {
      this.stateController.setState(GameState.Exploring);
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

    this.stateController.setEscapeFallback(() => {
      this.stateController.setState(GameState.UIOverlay);
      this.menuUI.openPauseMenu();
    });
  }

  private setupMenuHandlers(): void {
    this.listenEvent('shop:purchase', (payload: { itemId: string; price: number }) => {
      if (!this.inventoryManager.removeCoins(payload.price)) {
        this.eventBus.emit('notification:show', { text: '铜钱不足!', type: 'warning' });
        return;
      }
      if (!this.inventoryManager.addItem(payload.itemId, 1)) {
        this.inventoryManager.addCoins(payload.price);
        return;
      }
      const def = this.inventoryManager.getItemDef(payload.itemId);
      this.eventBus.emit('notification:show', { text: `购买了 ${def?.name ?? payload.itemId}`, type: 'info' });
    });

    this.listenEvent('inventory:discard', (payload: { itemId: string }) => {
      this.inventoryManager.discardItem(payload.itemId);
    });

    this.listenEvent('shop:closed', () => {
      this.stateController.setState(GameState.Exploring);
    });

    this.listenEvent('map:travel', (payload: { sceneId: string }) => {
      this.stateController.setState(GameState.Cutscene);
      this.sceneManager.switchScene(payload.sceneId).then(() => {
        this.stateController.setState(GameState.Exploring);
      });
    });

    this.listenEvent('menu:newGame', () => {
      this.menuUI.close();
      this.stateController.setState(GameState.Exploring);
    });

    this.listenEvent('menu:returnToMain', () => {
      this.stateController.setState(GameState.MainMenu);
      this.menuUI.openMainMenu();
    });

    this.listenEvent('scene:enter', (payload: { sceneId: string }) => {
      this.mapUI.setCurrentScene(payload.sceneId);
    });

    this.listenEvent('ruleUse:apply', async (payload: { ruleId: string; actions: import('../data/types').ActionDef[]; resultText?: string }) => {
      this.actionExecutor.executeBatch(payload.actions);
      this.flagStore.set(`rule_used_${payload.ruleId}`, true);
      if (payload.resultText) {
        this.stateController.setState(GameState.UIOverlay);
        await this.inspectBox.show(payload.resultText);
        this.stateController.setState(GameState.Exploring);
      }
    });
  }

  private setupEventConsumers(): void {
    this.listenEvent('archive:updated', (payload: { bookType: string; entryId: string }) => {
      this.flagStore.set(`archive_${payload.bookType}_${payload.entryId}`, true);
    });

    this.listenEvent('scene:ready', () => {
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
    if (this.gameConfig.initialScene !== 'teahouse') return;
    if (this.flagStore.get('prologue_started')) return;

    this.stateController.setState(GameState.Cutscene);
    await this.cutsceneManager.startCutscene('prologue_opening');
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

  destroy(): void {
    for (const { event, fn } of this.boundCallbacks) {
      this.eventBus.off(event, fn);
    }
    this.boundCallbacks = [];

    for (const { event, fn } of this.boundWindowListeners) {
      window.removeEventListener(event, fn);
    }
    this.boundWindowListeners = [];

    window.removeEventListener('keydown', this.positionDebugKeyHandler);
    const canvas = this.renderer.app?.canvas as HTMLCanvasElement | undefined;
    if (canvas) canvas.removeEventListener('pointerdown', this.positionDebugPointerHandler);

    for (const entry of this.registeredSystems) {
      if (entry.system) entry.system.destroy();
    }

    this.stateController.destroy();
    this.actionExecutor.destroy();
    this.flagStore.destroy();
    this.eventBus.clear();
    this.inputManager.destroy();
    this.renderer.destroy();
  }

  private async handleHotspotInteraction(hotspot: Hotspot, def: HotspotDef): Promise<void> {
    if (this.stateController.currentState !== GameState.Exploring) return;
    if (this.sceneManager.switching) return;

    switch (def.type) {
      case 'inspect':
        await this.handleInspect(hotspot, def.data as InspectData);
        break;
      case 'pickup':
        this.handlePickup(hotspot, def.data as PickupData);
        break;
      case 'transition':
        this.handleTransition(def.data as TransitionData);
        break;
      case 'encounter':
        this.handleEncounterTrigger(hotspot, def.data as EncounterTriggerData);
        break;
    }
  }

  private async handleNpcInteraction(npc: Npc): Promise<void> {
    if (this.stateController.currentState !== GameState.Exploring) return;
    if (this.dialogueManager.isActive) return;

    this.stateController.setState(GameState.Dialogue);
    await this.dialogueManager.startDialogue(
      npc.def.dialogueFile,
      npc.def.name,
      npc.def.dialogueKnot,
    );
  }

  private async handleInspect(hotspot: Hotspot, data: InspectData): Promise<void> {
    this.stateController.setState(GameState.UIOverlay);
    await this.inspectBox.show(data.text);
    this.eventBus.emit('hotspot:inspected', { hotspotId: hotspot.def.id });
    if (data.actions) {
      this.actionExecutor.executeBatch(data.actions);
    }
    if (this.stateController.currentState === GameState.UIOverlay) {
      this.stateController.setState(GameState.Exploring);
    }
  }

  private handlePickup(hotspot: Hotspot, data: PickupData): void {
    this.actionExecutor.execute({
      type: 'pickup',
      params: {
        itemId: data.itemId,
        itemName: data.itemName,
        count: data.count,
        isCurrency: data.isCurrency,
      },
    });
    this.flagStore.set(`picked_up_${hotspot.def.id}`, true);
    this.eventBus.emit('hotspot:pickup:done', { hotspotId: hotspot.def.id });
  }

  private handleEncounterTrigger(hotspot: Hotspot, data: EncounterTriggerData): void {
    this.actionExecutor.execute({
      type: 'startEncounter',
      params: { id: data.encounterId },
    });
    this.eventBus.emit('hotspot:pickup:done', { hotspotId: hotspot.def.id });
  }

  private handleTransition(data: TransitionData): void {
    this.actionExecutor.execute({
      type: 'switchScene',
      params: {
        targetScene: data.targetScene,
        targetSpawnPoint: data.targetSpawnPoint,
      },
    });
  }

  private tick(dt: number): void {
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
    this.renderer.sortEntityLayer();
    this.inputManager.endFrame();
  }
}
