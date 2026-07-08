import type { AssetRef } from '../../core/AssetManager';
import type { ActionExecutor } from '../../core/ActionExecutor';
import type { FlagStore } from '../../core/FlagStore';
import type { InputManager } from '../../core/InputManager';
import type { GameStateController } from '../../core/GameStateController';
import type { DayManager } from '../DayManager';
import type { Renderer } from '../../rendering/Renderer';
import type { GameContext } from '../../data/types';
import { FlagKeys } from '../../core/FlagKeys';
import { TEXT_URLS } from '../../core/projectPaths';
import { MinigameSessionManagerBase } from '../minigameSession';
import type { WaterMinigameInstance } from './types';
import { WaterMinigameScene } from './WaterMinigameScene';

/** 同日同 spot 累计开局超过此次数则剔除非 premium 实体 */
const DAILY_SOFT_CAP = 3;

export class WaterMinigameManager extends MinigameSessionManagerBase<
  WaterMinigameInstance,
  WaterMinigameScene,
  void
> {
  protected readonly indexUrl = TEXT_URLS.waterMinigamesIndex;
  protected readonly dataSubdir = 'water_minigames';
  protected readonly scopePrefix = 'minigame:water';
  protected readonly systemLabel = 'WaterMinigameManager';

  private flagStore!: FlagStore;
  private actionExecutor: ActionExecutor | null = null;
  private dayManager: DayManager | null = null;
  private resolveTextFn: ((s: string) => string) | null = null;

  /** 当前局计数键（场景成功加载后写入，结束时 +1；加载失败不计配额） */
  private pendingUseKey: string | null = null;
  /** prepareInstance 计算、loadSceneContent 消费的本局降级标记 */
  private sessionDegraded = false;
  private sessionUseKey: string | null = null;

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
    super.init(ctx);
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

  protected runtimeReady(): boolean {
    return super.runtimeReady() && !!this.actionExecutor && !!this.resolveTextFn;
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
    // 整机拆除（HMR 等）不算「完成一局」：清掉配额待记键再走通用拆除
    this.pendingUseKey = null;
    this.detachSessionPullSpaceBridge();
    super.destroy();
  }

  /** 已消费实体在开局时剔除；顺带计算当日配额降级。 */
  protected prepareInstance(inst0: WaterMinigameInstance): WaterMinigameInstance {
    const inst: WaterMinigameInstance = {
      ...inst0,
      entities: inst0.entities.filter((e) => {
        if (!e.consumeOnSuccess) return true;
        return !this.consumedPullEntities.has(`${inst0.id}::${e.id}`);
      }),
    };

    const spot = inst.spotId ?? inst.id;
    const dayRaw = this.dayManager?.currentDay ?? this.flagStore.get(FlagKeys.currentDay);
    const day = typeof dayRaw === 'number' && Number.isFinite(dayRaw) ? dayRaw : 1;
    const key = `${spot}|${day}`;
    this.sessionUseKey = key;
    this.sessionDegraded = (this.usesBySpotDay.get(key) ?? 0) >= DAILY_SOFT_CAP;
    return inst;
  }

  protected onSessionActive(_inst: WaterMinigameInstance): void {
    this.attachSessionPullSpaceBridge();
  }

  protected createScene(inst: WaterMinigameInstance): WaterMinigameScene {
    return new WaterMinigameScene(
      this.renderer!,
      this.assetManager,
      this.actionExecutor!,
      this.resolveTextFn!,
      () =>
        this.sessionPullSpaceHeld
        || !!(this.inputManager?.isMouseDown()),
      () => this.teardownSession(),
      (_iid, eid) => this.markConsumed(inst.id, eid),
      () => this.restoreMinigameStateAfterAction(),
    );
  }

  protected loadSceneContent(scene: WaterMinigameScene, inst: WaterMinigameInstance): Promise<void> {
    return scene.load(inst, { degraded: this.sessionDegraded });
  }

  /** 每日配额只在场景成功加载后登记，加载失败的一局不占次数。 */
  protected onSceneLoaded(_inst: WaterMinigameInstance): void {
    this.pendingUseKey = this.sessionUseKey;
  }

  protected tickScene(scene: WaterMinigameScene, dt: number): void {
    if (!this.inputManager) return;
    scene.update(dt, this.inputManager.getMousePos());
  }

  protected onTeardown(): void {
    this.detachSessionPullSpaceBridge();
    if (this.pendingUseKey) {
      const k = this.pendingUseKey;
      this.pendingUseKey = null;
      this.usesBySpotDay.set(k, (this.usesBySpotDay.get(k) ?? 0) + 1);
    }
  }

  protected buildInstanceManifestRefs(inst: WaterMinigameInstance): AssetRef[] {
    const refs: AssetRef[] = [];
    const addTexture = (path: string | undefined, label: string): void => {
      if (path?.trim()) refs.push({ type: 'texture', path, label });
    };
    addTexture(inst.waterBottom?.texture, `水域底图: ${inst.id}`);
    for (const bank of inst.shoreForeground?.banks ?? []) {
      addTexture(bank.sprite, `水域岸边: ${inst.id}`);
    }
    for (const ent of inst.entities) {
      addTexture(ent.sprite, `水域实体: ${ent.id}`);
    }
    return refs;
  }

  private markConsumed(instanceId: string, entityId: string): void {
    this.consumedPullEntities.add(`${instanceId}::${entityId}`);
  }

  private attachSessionPullSpaceBridge(): void {
    this.detachSessionPullSpaceBridge();
    // 注意：不要在此释放资源 scope。本方法只负责（重）绑定空格/鼠标的拉拽监听；
    // scope 的钉住贯穿整局，统一在 teardownSession/destroy 释放。
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
}
