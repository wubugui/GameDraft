import type { AssetManager } from '../../core/AssetManager';
import type { ActionExecutor } from '../../core/ActionExecutor';
import type { FlagStore } from '../../core/FlagStore';
import type { InputManager } from '../../core/InputManager';
import type { GameStateController } from '../../core/GameStateController';
import type { DayManager } from '../DayManager';
import type { Renderer } from '../../rendering/Renderer';
import type { GameContext, IGameSystem } from '../../data/types';
import { GameState } from '../../data/types';
import type { WaterMinigameIndexEntry, WaterMinigameInstance } from './types';
import { WaterMinigameScene } from './WaterMinigameScene';

const INDEX_PATH = '/assets/data/water_minigames/index.json';

/** 同日同 spot 累计开局超过此次数则剔除非 premium 实体 */
const DAILY_SOFT_CAP = 3;

export class WaterMinigameManager implements IGameSystem {
  private assetManager!: AssetManager;
  private flagStore!: FlagStore;
  private actionExecutor!: ActionExecutor;
  private renderer: Renderer | null = null;
  private inputManager: InputManager | null = null;
  private stateController: GameStateController | null = null;
  private dayManager: DayManager | null = null;

  private index: WaterMinigameIndexEntry[] = [];
  private instanceCache = new Map<string, WaterMinigameInstance>();

  private scene: WaterMinigameScene | null = null;
  private active = false;
  private unsubKey: (() => void) | null = null;
  private prevState = GameState.Exploring;
  private resolveTextFn: ((s: string) => string) | null = null;

  private sessionResolve: (() => void) | null = null;
  private onSessionEnd: (() => void) | null = null;
  /** 当前局计数键（结束时 +1） */
  private pendingUseKey: string | null = null;

  /** `${spotId}|${day}` -> 已完成局数 */
  private usesBySpotDay = new Map<string, number>();
  private consumedPullEntities = new Set<string>();

  /**
   * 水边小游戏局内「空格提拉」状态。
   * 局内会 `setGameKeyboardBlocked(true)`，InputManager 不记录按键；此处用本会话专属的 window 监听维护，
   * 不修改全局输入语义，与其它系统隔离。
   */
  private sessionPullSpaceHeld = false;
  private boundPullSpaceKeyDown: ((e: KeyboardEvent) => void) | null = null;
  private boundPullSpaceKeyUp: ((e: KeyboardEvent) => void) | null = null;
  private boundPullWindowBlur: (() => void) | null = null;

  init(ctx: GameContext): void {
    this.assetManager = ctx.assetManager;
    this.flagStore = ctx.flagStore;
  }

  bindRuntime(deps: {
    renderer: Renderer;
    inputManager: InputManager;
    stateController: GameStateController;
    actionExecutor: ActionExecutor;
    dayManager: DayManager;
    resolveDisplayText: (s: string) => string;
  }): void {
    this.renderer = deps.renderer;
    this.inputManager = deps.inputManager;
    this.stateController = deps.stateController;
    this.actionExecutor = deps.actionExecutor;
    this.dayManager = deps.dayManager;
    this.resolveTextFn = deps.resolveDisplayText;
  }

  update(dt: number): void {
    if (!this.scene || !this.active || !this.inputManager) return;
    const m = this.inputManager.getMousePos();
    this.scene.update(dt, m);
  }

  serialize(): object {
    return {
      usesBySpotDay: Object.fromEntries(this.usesBySpotDay),
      consumedPullEntities: [...this.consumedPullEntities],
    };
  }

  deserialize(data: object): void {
    const d = data as {
      usesBySpotDay?: Record<string, number>;
      consumedPullEntities?: string[];
    };
    this.usesBySpotDay = new Map(Object.entries(d.usesBySpotDay ?? {}));
    this.consumedPullEntities = new Set(d.consumedPullEntities ?? []);
  }

  destroy(): void {
    this.unsubKey?.();
    this.unsubKey = null;
    this.detachSessionPullSpaceBridge();
    this.inputManager?.setGameKeyboardBlocked(false);
    if (this.scene) {
      if (this.scene.root.parent) {
        this.scene.root.parent.removeChild(this.scene.root);
      }
      this.scene.destroy();
      this.scene = null;
    }
    this.active = false;
    this.pendingUseKey = null;
    const rs = this.sessionResolve;
    this.sessionResolve = null;
    rs?.();

    this.instanceCache.clear();
    this.index = [];
  }

  setOnSessionEnd(fn: (() => void) | null): void {
    this.onSessionEnd = fn;
  }

  async loadIndex(): Promise<void> {
    try {
      const raw = await this.assetManager.loadJson<WaterMinigameIndexEntry[]>(INDEX_PATH);
      this.index = Array.isArray(raw) ? raw : [];
    } catch (e) {
      console.warn('WaterMinigameManager: failed to load index', e);
      this.index = [];
    }
  }

  getInstanceList(): { id: string; label: string }[] {
    return this.index.map((e) => ({ id: e.id, label: e.label }));
  }

  /** 过场 await：Esc / WaterPull abort 退出后 resolve */
  runUntilDone(id: string): Promise<void> {
    return new Promise<void>((resolve) => {
      this.sessionResolve = resolve;
      void this.start(id);
    });
  }

  async start(id: string): Promise<void> {
    if (!this.renderer || !this.inputManager || !this.stateController || !this.resolveTextFn) {
      console.warn('WaterMinigameManager: runtime not bound');
      this.sessionResolve?.();
      this.sessionResolve = null;
      return;
    }
    if (this.active) return;

    const inst0 = await this.loadInstance(id);
    if (!inst0) {
      console.warn(`WaterMinigameManager: unknown instance "${id}"`);
      this.sessionResolve?.();
      this.sessionResolve = null;
      return;
    }

    const inst: WaterMinigameInstance = {
      ...inst0,
      entities: inst0.entities.filter((e) => {
        if (!e.consumeOnSuccess) return true;
        return !this.consumedPullEntities.has(`${inst0.id}::${e.id}`);
      }),
    };

    const spot = inst.spotId ?? inst.id;
    const dayRaw = this.dayManager?.currentDay ?? this.flagStore.get('current_day');
    const day = typeof dayRaw === 'number' && Number.isFinite(dayRaw) ? dayRaw : 1;
    const key = `${spot}|${day}`;
    const uses = this.usesBySpotDay.get(key) ?? 0;
    const degraded = uses >= DAILY_SOFT_CAP;

    this.pendingUseKey = key;

    this.prevState = this.stateController.currentState;
    this.stateController.setState(GameState.Minigame);
    this.inputManager.setGameKeyboardBlocked(true);

    this.active = true;
    this.attachSessionPullSpaceBridge();

    this.unsubKey = this.inputManager.subscribeKeyDown((e) => {
      if (!this.active) return;
      if (e.repeat) return;
      if (e.code === 'Escape') {
        e.preventDefault();
        this.scene?.abort();
      }
    });

    this.scene = new WaterMinigameScene(
      this.renderer,
      this.assetManager,
      this.actionExecutor,
      this.resolveTextFn,
      () =>
        this.sessionPullSpaceHeld
        || !!(this.inputManager?.isMouseDown()),
      () => this.teardownSession(),
      (_iid, eid) => this.markConsumed(inst.id, eid),
    );

    try {
      await this.scene.load(inst, { degraded });
    } catch (e) {
      console.warn('WaterMinigameManager: scene load failed', e);
      this.teardownSession();
      return;
    }

    this.renderer.cutsceneOverlay.addChild(this.scene.root);
  }

  private async loadInstance(id: string): Promise<WaterMinigameInstance | null> {
    const cached = this.instanceCache.get(id);
    if (cached) return cached;
    const entry = this.index.find((x) => x.id === id);
    if (!entry) return null;
    try {
      const path = entry.file.startsWith('/') ? entry.file : `/assets/data/water_minigames/${entry.file}`;
      const data = await this.assetManager.loadJson<WaterMinigameInstance>(path);
      this.instanceCache.set(id, data);
      return data;
    } catch (e) {
      console.warn('WaterMinigameManager: load instance failed', id, e);
      return null;
    }
  }

  private markConsumed(instanceId: string, entityId: string): void {
    this.consumedPullEntities.add(`${instanceId}::${entityId}`);
  }

  private attachSessionPullSpaceBridge(): void {
    this.detachSessionPullSpaceBridge();
    this.sessionPullSpaceHeld = false;

    this.boundPullSpaceKeyDown = (e: KeyboardEvent) => {
      if (!this.active || e.code !== 'Space') return;
      e.preventDefault();
      this.sessionPullSpaceHeld = true;
    };
    this.boundPullSpaceKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      this.sessionPullSpaceHeld = false;
    };
    this.boundPullWindowBlur = () => {
      this.sessionPullSpaceHeld = false;
    };

    window.addEventListener('keydown', this.boundPullSpaceKeyDown, true);
    window.addEventListener('keyup', this.boundPullSpaceKeyUp, true);
    window.addEventListener('blur', this.boundPullWindowBlur);
  }

  private detachSessionPullSpaceBridge(): void {
    if (this.boundPullSpaceKeyDown) {
      window.removeEventListener('keydown', this.boundPullSpaceKeyDown, true);
      this.boundPullSpaceKeyDown = null;
    }
    if (this.boundPullSpaceKeyUp) {
      window.removeEventListener('keyup', this.boundPullSpaceKeyUp, true);
      this.boundPullSpaceKeyUp = null;
    }
    if (this.boundPullWindowBlur) {
      window.removeEventListener('blur', this.boundPullWindowBlur);
      this.boundPullWindowBlur = null;
    }
    this.sessionPullSpaceHeld = false;
  }

  private teardownSession(): void {
    if (!this.active) return;

    this.detachSessionPullSpaceBridge();

    const hadScene = !!this.scene;

    this.unsubKey?.();
    this.unsubKey = null;
    this.inputManager?.setGameKeyboardBlocked(false);

    if (hadScene && this.pendingUseKey) {
      const k = this.pendingUseKey;
      this.pendingUseKey = null;
      this.usesBySpotDay.set(k, (this.usesBySpotDay.get(k) ?? 0) + 1);
    } else {
      this.pendingUseKey = null;
    }

    if (this.scene) {
      if (this.scene.root.parent) {
        this.scene.root.parent.removeChild(this.scene.root);
      }
      this.scene.destroy();
      this.scene = null;
    }

    this.active = false;
    if (this.stateController) {
      this.stateController.setState(this.prevState);
    }

    const rs = this.sessionResolve;
    this.sessionResolve = null;
    rs?.();

    this.onSessionEnd?.();
  }
}
