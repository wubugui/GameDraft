import type { AssetManager } from '../../core/AssetManager';
import type { EventBus } from '../../core/EventBus';
import type { InputManager } from '../../core/InputManager';
import type { GameStateController } from '../../core/GameStateController';
import type { Renderer } from '../../rendering/Renderer';
import type { GameContext, IGameSystem } from '../../data/types';
import { GameState } from '../../data/types';
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

  private index: SugarWheelIndexEntry[] = [];
  private instanceCache = new Map<string, SugarWheelInstance>();
  private scene: SugarWheelMinigameScene | null = null;
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
    resolveDisplayText: (s: string) => string;
  }): void {
    this.renderer = deps.renderer;
    this.inputManager = deps.inputManager;
    this.stateController = deps.stateController;
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
      const raw = await this.assetManager.loadJson<SugarWheelIndexEntry[]>(INDEX_PATH);
      this.index = Array.isArray(raw) ? raw : [];
    } catch (e) {
      console.warn('SugarWheelMinigameManager: failed to load index', e);
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
    if (!this.renderer || !this.inputManager || !this.stateController || !this.resolveTextFn) {
      console.warn('SugarWheelMinigameManager: runtime not bound');
      this.resolveSession();
      return;
    }
    if (this.active) return;

    const inst = await this.loadInstance(id);
    if (!inst) {
      console.warn(`SugarWheelMinigameManager: unknown instance "${id}"`);
      this.resolveSession();
      return;
    }
    if (!Array.isArray(inst.sectors) || inst.sectors.length === 0) {
      console.warn(`SugarWheelMinigameManager: instance "${id}" has no sectors`);
      this.resolveSession();
      return;
    }

    this.prevState = this.stateController.currentState;
    this.stateController.setState(GameState.Minigame);
    this.inputManager.setGameKeyboardBlocked(true);
    this.active = true;
    this.lastResult = null;

    this.unsubKey = this.inputManager.subscribeKeyDown((e) => {
      if (!this.active) return;
      if (e.repeat) return;
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
      this.resolveTextFn,
      (result) => this.publishResult(result),
      () => this.teardownSession(),
    );

    try {
      await this.scene.load(inst);
    } catch (e) {
      console.warn('SugarWheelMinigameManager: scene load failed', e);
      this.teardownSession();
      return;
    }

    this.renderer.cutsceneOverlay.addChild(this.scene.root);
  }

  private publishResult(result: SugarWheelResult): void {
    this.lastResult = result;
    this.eventBus.emit('minigame:sugarWheelResult', result);
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
      console.warn('SugarWheelMinigameManager: load instance failed', id, e);
      return null;
    }
  }

  private teardownSession(): void {
    if (!this.active) return;

    this.unsubKey?.();
    this.unsubKey = null;
    this.inputManager?.setGameKeyboardBlocked(false);
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

  private resolveSession(): void {
    const rs = this.sessionResolve;
    this.sessionResolve = null;
    rs?.(this.lastResult);
  }
}
