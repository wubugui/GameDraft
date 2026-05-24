import type { AssetManager } from '../../core/AssetManager';
import type { AssetRef } from '../../core/AssetManager';
import type { EventBus } from '../../core/EventBus';
import type { ActionExecutor } from '../../core/ActionExecutor';
import type { InputManager } from '../../core/InputManager';
import type { GameStateController } from '../../core/GameStateController';
import type { Renderer } from '../../rendering/Renderer';
import type { GameContext, IGameSystem } from '../../data/types';
import { GameState } from '../../data/types';
import type { ConditionExpr } from '../../data/types';
import type { SugarWheelIndexEntry, SugarWheelInstance, SugarWheelResult } from './types';
import { SugarWheelMinigameScene } from './SugarWheelMinigameScene';

const INDEX_PATH = '/assets/data/sugar_wheel/index.json';

export class SugarWheelMinigameManager implements IGameSystem {
  private eventBus!: EventBus;
  private assetManager!: AssetManager;
  private renderer: Renderer | null = null;
  private inputManager: InputManager | null = null;
  private stateController: GameStateController | null = null;
  private resolveTextFn: ((s: string) => string) | null = null;
  private actionExecutor: ActionExecutor | null = null;
  private playSfx: ((id: string) => void) | null = null;
  private debugSugarLog: ((message: string) => void) | null = null;
  private evaluateBeforeChargeCondition:
    | ((expr: ConditionExpr | undefined) => boolean)
    | null = null;

  private index: SugarWheelIndexEntry[] = [];
  private instanceCache = new Map<string, SugarWheelInstance>();
  private scene: SugarWheelMinigameScene | null = null;
  private activeScopeId: string | null = null;
  private active = false;
  private prevState = GameState.Exploring;
  private unsubKey: (() => void) | null = null;
  private sessionResolve: ((result: SugarWheelResult | null) => void) | null = null;
  private lastResult: SugarWheelResult | null = null;
  private onSessionEnd: (() => void) | null = null;

  init(ctx: GameContext): void {
    this.eventBus = ctx.eventBus;
    this.assetManager = ctx.assetManager;
  }

  bindRuntime(deps: {
    renderer: Renderer;
    inputManager: InputManager;
    stateController: GameStateController;
    actionExecutor: ActionExecutor;
    playSfx?: (id: string) => void;
    resolveDisplayText: (s: string) => string;
    /** F2 调试面板，与 ActionRegistry `debugPanelLog` 同源。 */
    debugPanelLog?: (message: string) => void;
    /** 转盘实例 `beforeChargeCondition`；`expr` 缺省视为 true。 */
    evaluateBeforeChargeCondition?: (expr: ConditionExpr | undefined) => boolean;
  }): void {
    this.renderer = deps.renderer;
    this.inputManager = deps.inputManager;
    this.stateController = deps.stateController;
    this.actionExecutor = deps.actionExecutor;
    this.playSfx = deps.playSfx ?? null;
    this.resolveTextFn = deps.resolveDisplayText;
    this.debugSugarLog = deps.debugPanelLog ?? null;
    this.evaluateBeforeChargeCondition = deps.evaluateBeforeChargeCondition ?? null;
  }

  update(dt: number): void {
    if (!this.scene || !this.active) return;
    this.scene.update(dt);
  }

  serialize(): object {
    return {};
  }

  deserialize(_data: object): void {
    /* no persistent state */
  }

  destroy(): void {
    this.unsubKey?.();
    this.unsubKey = null;
    this.inputManager?.setGameKeyboardBlocked(false);
    this.releaseActiveScope();
    this.removeScene();
    this.active = false;
    const rs = this.sessionResolve;
    this.sessionResolve = null;
    rs?.(this.lastResult);
    this.instanceCache.clear();
    this.index = [];
  }

  setOnSessionEnd(fn: (() => void) | null): void {
    this.onSessionEnd = fn;
  }

  private sugarMgrDbg(msg: string): void {
    this.debugSugarLog?.(`[糖画转盘] ${msg}`);
  }

  async loadIndex(): Promise<void> {
    try {
      const raw = await this.assetManager.loadJson<SugarWheelIndexEntry[]>(INDEX_PATH);
      this.index = Array.isArray(raw) ? raw : [];
    } catch (e) {
      this.sugarMgrDbg(`加载 index 失败: ${String(e)}`);
      this.index = [];
    }
  }

  getInstanceList(): { id: string; label: string }[] {
    return this.index.map((e) => ({ id: e.id, label: e.label }));
  }

  runUntilDone(id: string): Promise<SugarWheelResult | null> {
    return new Promise<SugarWheelResult | null>((resolve) => {
      this.sessionResolve = resolve;
      void this.start(id);
    });
  }

  async start(id: string): Promise<void> {
    if (!this.renderer || !this.inputManager || !this.stateController || !this.resolveTextFn || !this.actionExecutor) {
      this.sugarMgrDbg('runtime 未 bind，无法启动转盘');
      this.resolveSession();
      return;
    }
    if (this.active) return;

    const inst = await this.loadInstance(id);
    if (!inst) {
      this.sugarMgrDbg(`未知转盘实例 "${id}"`);
      this.resolveSession();
      return;
    }
    if (!Array.isArray(inst.sectors) || inst.sectors.length === 0) {
      this.sugarMgrDbg(`实例 "${id}" 无扇区`);
      this.resolveSession();
      return;
    }

    const scopeId = `minigame:sugarWheel:${inst.id}`;
    await this.assetManager.preloadManifest(
      { scopeId, refs: this.buildInstanceManifestRefs(inst) },
      { mode: 'stage', tolerateErrors: true },
    );
    this.activeScopeId = scopeId;

    this.prevState = this.stateController.currentState;
    this.stateController.setState(GameState.Minigame);
    this.inputManager.setGameKeyboardBlocked(true);
    this.active = true;
    this.lastResult = null;

    this.unsubKey = this.inputManager.subscribeKeyDown((e) => {
      if (!this.active) return;
      if (e.repeat) return;
      if (this.scene?.isActionsPlaybackLocked()) return;
      if (e.code === 'Escape') {
        e.preventDefault();
        this.scene?.abort();
        return;
      }
      if (e.code === 'KeyD') {
        e.preventDefault();
        this.scene?.toggleGeomDebugOverlay();
      }
    });

    this.scene = new SugarWheelMinigameScene(
      this.renderer,
      this.assetManager,
      this.actionExecutor,
      this.resolveTextFn,
      (result) => this.publishResult(result),
      () => this.teardownSession(),
      this.debugSugarLog ?? undefined,
      this.evaluateBeforeChargeCondition ?? undefined,
      this.playSfx ?? undefined,
      () => this.restoreMinigameStateAfterAction(),
    );

    try {
      await this.scene.load(inst);
    } catch (e) {
      this.sugarMgrDbg(`场景加载失败: ${String(e)}`);
      this.teardownSession();
      return;
    }

    this.renderer.cutsceneOverlay.addChild(this.scene.root);
  }

  private publishResult(result: SugarWheelResult): void {
    this.lastResult = result;
    this.eventBus.emit('minigame:sugarWheelResult', result);
  }

  private buildInstanceManifestRefs(inst: SugarWheelInstance): AssetRef[] {
    const refs: AssetRef[] = [];
    const addTexture = (path: string | undefined, label: string): void => {
      if (path?.trim()) refs.push({ type: 'texture', path, label });
    };
    addTexture(inst.backgroundImage, `糖画背景: ${inst.id}`);
    addTexture(inst.foregroundImage, `糖画前景: ${inst.id}`);
    addTexture(inst.wheelImage, `糖画转盘: ${inst.id}`);
    addTexture(inst.pointerImage, `糖画指针: ${inst.id}`);
    return refs;
  }

  private releaseActiveScope(): void {
    if (!this.activeScopeId) return;
    this.assetManager.releaseScope(this.activeScopeId);
    this.activeScopeId = null;
  }

  private async loadInstance(id: string): Promise<SugarWheelInstance | null> {
    const cached = this.instanceCache.get(id);
    if (cached) return cached;
    const entry = this.index.find((x) => x.id === id);
    if (!entry) return null;
    try {
      const path = entry.file.startsWith('/') ? entry.file : `/assets/data/sugar_wheel/${entry.file}`;
      const data = await this.assetManager.loadJson<SugarWheelInstance>(path);
      this.instanceCache.set(id, data);
      return data;
    } catch (e) {
      this.sugarMgrDbg(`加载实例 JSON 失败 (${id}): ${String(e)}`);
      return null;
    }
  }

  private teardownSession(): void {
    if (!this.active) return;

    this.unsubKey?.();
    this.unsubKey = null;
    this.inputManager?.setGameKeyboardBlocked(false);
    this.releaseActiveScope();
    this.removeScene();
    this.active = false;
    this.stateController?.setState(this.prevState);
    this.resolveSession();
    this.onSessionEnd?.();
  }

  private restoreMinigameStateAfterAction(): void {
    if (!this.active) return;
    if (!this.stateController) return;
    if (this.stateController.currentState !== GameState.Minigame) {
      this.stateController.setState(GameState.Minigame);
    }
  }

  private removeScene(): void {
    if (!this.scene) return;
    if (this.scene.root.parent) {
      this.scene.root.parent.removeChild(this.scene.root);
    }
    this.scene.destroy();
    this.scene = null;
  }

  /** 小游戏进行中：外部让某角色弹出对白气泡（需与 JSON speechAnchors 中 role 一致或可走运行时默认）。 */
  showSpeech(role: string, text: string, durationMs?: number): void {
    this.scene?.showSpeech(role, text, durationMs);
  }

  dismissSpeech(role: string): void {
    this.scene?.dismissSpeech(role);
  }

  dismissAllSpeech(): void {
    this.scene?.dismissAllSpeech();
  }

  /** 将转盘指针置于指定几何角度（度，正上为 0、顺时针为正）；仅在非旋转/非蓄力时生效。 */
  resetPointerGeomAngleDeg(angleDeg: number): void {
    this.scene?.resetPointerGeomAngleDeg(angleDeg);
  }

  private resolveSession(): void {
    const rs = this.sessionResolve;
    this.sessionResolve = null;
    rs?.(this.lastResult);
  }
}
