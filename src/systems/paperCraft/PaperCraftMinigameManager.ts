import type { AssetManager } from '../../core/AssetManager';
import type { AssetRef } from '../../core/AssetManager';
import type { EventBus } from '../../core/EventBus';
import type { ActionExecutor } from '../../core/ActionExecutor';
import type { InputManager } from '../../core/InputManager';
import type { GameStateController } from '../../core/GameStateController';
import type { Renderer } from '../../rendering/Renderer';
import type { GameContext, IGameSystem } from '../../data/types';
import { GameState } from '../../data/types';
import type { PaperCraftIndexEntry, PaperCraftInstance, PaperCraftResult } from './types';
import { PaperCraftMinigameScene } from './PaperCraftMinigameScene';

const INDEX_PATH = '/assets/data/paper_craft/index.json';

export class PaperCraftMinigameManager implements IGameSystem {
  private eventBus!: EventBus;
  private assetManager!: AssetManager;
  private renderer: Renderer | null = null;
  private inputManager: InputManager | null = null;
  private stateController: GameStateController | null = null;
  private actionExecutor: ActionExecutor | null = null;
  private resolveTextFn: ((s: string) => string) | null = null;

  private index: PaperCraftIndexEntry[] = [];
  private instanceCache = new Map<string, PaperCraftInstance>();
  private scene: PaperCraftMinigameScene | null = null;
  private activeScopeId: string | null = null;
  private active = false;
  private prevState = GameState.Exploring;
  private unsubKey: (() => void) | null = null;
  private sessionResolve: ((result: PaperCraftResult | null) => void) | null = null;
  private lastResult: PaperCraftResult | null = null;
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
    resolveDisplayText: (s: string) => string;
  }): void {
    this.renderer = deps.renderer;
    this.inputManager = deps.inputManager;
    this.stateController = deps.stateController;
    this.actionExecutor = deps.actionExecutor;
    this.resolveTextFn = deps.resolveDisplayText;
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

  async loadIndex(): Promise<void> {
    try {
      const raw = await this.assetManager.loadJson<PaperCraftIndexEntry[]>(INDEX_PATH);
      this.index = Array.isArray(raw) ? raw : [];
    } catch (e) {
      console.warn('PaperCraftMinigameManager: failed to load index', e);
      this.index = [];
    }
  }

  getInstanceList(): { id: string; label: string }[] {
    return this.index.map((e) => ({ id: e.id, label: e.label }));
  }

  runUntilDone(id: string): Promise<PaperCraftResult | null> {
    return new Promise<PaperCraftResult | null>((resolve) => {
      this.sessionResolve = resolve;
      void this.start(id);
    });
  }

  async start(id: string): Promise<void> {
    if (!this.renderer || !this.inputManager || !this.stateController || !this.resolveTextFn || !this.actionExecutor) {
      console.warn('PaperCraftMinigameManager: runtime not bound');
      this.resolveSession();
      return;
    }
    if (this.active) return;

    const inst = await this.loadInstance(id);
    if (!inst) {
      console.warn(`PaperCraftMinigameManager: unknown instance "${id}"`);
      this.resolveSession();
      return;
    }

    const scopeId = `minigame:paperCraft:${inst.id}`;
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
      if (!this.active || e.repeat) return;
      if (e.code === 'Escape') {
        e.preventDefault();
        this.scene?.abort();
      }
    });

    this.scene = new PaperCraftMinigameScene(
      this.renderer,
      this.assetManager,
      this.actionExecutor,
      this.resolveTextFn,
      (result) => this.publishResult(result),
      () => this.teardownSession(),
    );

    try {
      await this.scene.load(inst);
    } catch (e) {
      console.warn('PaperCraftMinigameManager: scene load failed', e);
      this.teardownSession();
      return;
    }

    this.renderer.cutsceneOverlay.addChild(this.scene.root);
  }

  private publishResult(result: PaperCraftResult): void {
    this.lastResult = result;
    this.eventBus.emit('minigame:paperCraftResult', result);
  }

  private buildInstanceManifestRefs(inst: PaperCraftInstance): AssetRef[] {
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

  private releaseActiveScope(): void {
    if (!this.activeScopeId) return;
    this.assetManager.releaseScope(this.activeScopeId);
    this.activeScopeId = null;
  }

  private async loadInstance(id: string): Promise<PaperCraftInstance | null> {
    const cached = this.instanceCache.get(id);
    if (cached) return cached;
    const entry = this.index.find((x) => x.id === id);
    if (!entry) return null;
    try {
      const path = entry.file.startsWith('/') ? entry.file : `/assets/data/paper_craft/${entry.file}`;
      const data = await this.assetManager.loadJson<PaperCraftInstance>(path);
      this.instanceCache.set(id, data);
      return data;
    } catch (e) {
      console.warn('PaperCraftMinigameManager: load instance failed', id, e);
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

  private removeScene(): void {
    if (!this.scene) return;
    if (this.scene.root.parent) {
      this.scene.root.parent.removeChild(this.scene.root);
    }
    this.scene.destroy();
    this.scene = null;
  }

  private resolveSession(): void {
    const rs = this.sessionResolve;
    this.sessionResolve = null;
    rs?.(this.lastResult);
  }
}
