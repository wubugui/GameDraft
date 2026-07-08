import type { AssetRef } from '../../core/AssetManager';
import type { EventBus } from '../../core/EventBus';
import type { ActionExecutor } from '../../core/ActionExecutor';
import type { InputManager } from '../../core/InputManager';
import type { GameStateController } from '../../core/GameStateController';
import type { Renderer } from '../../rendering/Renderer';
import type { GameContext } from '../../data/types';
import type { ConditionExpr } from '../../data/types';
import { TEXT_URLS } from '../../core/projectPaths';
import { MinigameSessionManagerBase } from '../minigameSession';
import type { SugarWheelInstance, SugarWheelResult } from './types';
import { SugarWheelMinigameScene } from './SugarWheelMinigameScene';

export class SugarWheelMinigameManager extends MinigameSessionManagerBase<
  SugarWheelInstance,
  SugarWheelMinigameScene,
  SugarWheelResult
> {
  protected readonly indexUrl = TEXT_URLS.sugarWheelIndex;
  protected readonly dataSubdir = 'sugar_wheel';
  protected readonly scopePrefix = 'minigame:sugarWheel';
  protected readonly systemLabel = 'SugarWheelMinigameManager';

  private eventBus!: EventBus;
  private resolveTextFn: ((s: string) => string) | null = null;
  private actionExecutor: ActionExecutor | null = null;
  private playSfx: ((id: string) => void) | null = null;
  private debugSugarLog: ((message: string) => void) | null = null;
  private evaluateBeforeChargeCondition:
    | ((expr: ConditionExpr | undefined) => boolean)
    | null = null;

  init(ctx: GameContext): void {
    super.init(ctx);
    this.eventBus = ctx.eventBus;
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

  protected runtimeReady(): boolean {
    return super.runtimeReady() && !!this.actionExecutor && !!this.resolveTextFn;
  }

  /** 告警走 F2 调试面板而非 console（与既有行为一致）。 */
  protected warnSession(msg: string, detail?: unknown): void {
    const text = detail !== undefined ? `${msg}: ${String(detail)}` : msg;
    this.debugSugarLog?.(`[糖画转盘] ${text}`);
  }

  protected validateInstance(inst: SugarWheelInstance): boolean {
    if (!Array.isArray(inst.sectors) || inst.sectors.length === 0) {
      this.warnSession(`实例 "${inst.id}" 无扇区`);
      return false;
    }
    return true;
  }

  protected createScene(_inst: SugarWheelInstance): SugarWheelMinigameScene {
    return new SugarWheelMinigameScene(
      this.renderer!,
      this.assetManager,
      this.actionExecutor!,
      this.resolveTextFn!,
      (result) => this.publishResult(result),
      () => this.teardownSession(),
      this.debugSugarLog ?? undefined,
      this.evaluateBeforeChargeCondition ?? undefined,
      this.playSfx ?? undefined,
      () => this.restoreMinigameStateAfterAction(),
    );
  }

  protected loadSceneContent(scene: SugarWheelMinigameScene, inst: SugarWheelInstance): Promise<void> {
    return scene.load(inst);
  }

  protected tickScene(scene: SugarWheelMinigameScene, dt: number): void {
    scene.update(dt);
  }

  /** D 键几何/气泡调试面板：仅开发构建可用（T5）。 */
  protected onSessionKeyDown(e: KeyboardEvent): void {
    if (import.meta.env.DEV && e.code === 'KeyD') {
      e.preventDefault();
      this.scene?.toggleGeomDebugOverlay();
    }
  }

  protected buildInstanceManifestRefs(inst: SugarWheelInstance): AssetRef[] {
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

  private publishResult(result: SugarWheelResult): void {
    this.lastResult = result;
    this.eventBus.emit('minigame:sugarWheelResult', result);
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
}
