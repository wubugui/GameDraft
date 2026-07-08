import type { AssetRef } from '../../core/AssetManager';
import type { EventBus } from '../../core/EventBus';
import type { ActionExecutor } from '../../core/ActionExecutor';
import type { InputManager } from '../../core/InputManager';
import type { GameStateController } from '../../core/GameStateController';
import type { Renderer } from '../../rendering/Renderer';
import type { GameContext } from '../../data/types';
import { TEXT_URLS } from '../../core/projectPaths';
import { MinigameSessionManagerBase } from '../minigameSession';
import type { PaperCraftInstance, PaperCraftResult } from './types';
import { PaperCraftMinigameScene } from './PaperCraftMinigameScene';

export class PaperCraftMinigameManager extends MinigameSessionManagerBase<
  PaperCraftInstance,
  PaperCraftMinigameScene,
  PaperCraftResult
> {
  protected readonly indexUrl = TEXT_URLS.paperCraftIndex;
  protected readonly dataSubdir = 'paper_craft';
  protected readonly scopePrefix = 'minigame:paperCraft';
  protected readonly systemLabel = 'PaperCraftMinigameManager';

  private eventBus!: EventBus;
  private actionExecutor: ActionExecutor | null = null;
  private resolveTextFn: ((s: string) => string) | null = null;

  init(ctx: GameContext): void {
    super.init(ctx);
    this.eventBus = ctx.eventBus;
  }

  bindRuntime(deps: {
    renderer: Renderer;
    inputManager: InputManager;
    stateController: GameStateController;
    actionExecutor: ActionExecutor;
    resolveDisplayText: (s: string) => string;
  }): void {
    this.renderer = deps.renderer;
    this.inputManager = deps.inputManager;
    this.stateController = deps.stateController;
    this.actionExecutor = deps.actionExecutor;
    this.resolveTextFn = deps.resolveDisplayText;
  }

  protected runtimeReady(): boolean {
    return super.runtimeReady() && !!this.actionExecutor && !!this.resolveTextFn;
  }

  protected createScene(_inst: PaperCraftInstance): PaperCraftMinigameScene {
    return new PaperCraftMinigameScene(
      this.renderer!,
      this.assetManager,
      this.actionExecutor!,
      this.resolveTextFn!,
      (result) => this.publishResult(result),
      () => this.teardownSession(),
      () => this.restoreMinigameStateAfterAction(),
    );
  }

  protected loadSceneContent(scene: PaperCraftMinigameScene, inst: PaperCraftInstance): Promise<void> {
    return scene.load(inst);
  }

  protected tickScene(scene: PaperCraftMinigameScene, dt: number): void {
    scene.update(dt);
  }

  protected buildInstanceManifestRefs(inst: PaperCraftInstance): AssetRef[] {
    const refs: AssetRef[] = [];
    const addTexture = (path: string | undefined, label: string): void => {
      if (path?.trim()) refs.push({ type: 'texture', path, label });
    };
    addTexture(inst.backgroundImage, `扎纸背景: ${inst.id}`);
    for (const order of inst.orders) {
      for (const part of order.parts) {
        addTexture(part.image, `扎纸部件: ${part.id}`);
      }
    }
    return refs;
  }

  private publishResult(result: PaperCraftResult): void {
    this.lastResult = result;
    this.eventBus.emit('minigame:paperCraftResult', result);
  }
}
