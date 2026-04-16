import type { EventBus } from '../core/EventBus';
import type { FlagStore } from '../core/FlagStore';
import type { ActionExecutor } from '../core/ActionExecutor';
import type { AssetManager } from '../core/AssetManager';
import type { InputManager } from '../core/InputManager';
import type { CutsceneRenderer } from '../rendering/CutsceneRenderer';
import type { Camera } from '../rendering/Camera';
import type { ICutsceneActor, IEmoteBubbleProvider, NpcDef, IGameSystem, GameContext, NewCutsceneDef, CutsceneStep } from '../data/types';
import { CUTSCENE_ACTION_WHITELIST } from '../data/types';
import { Npc } from '../entities/Npc';

export type EntityResolver = (id: string) => ICutsceneActor | null;

export type ChangeSceneParams = {
  targetScene: string;
  targetSpawnPoint?: string;
  cameraX?: number;
  cameraY?: number;
};

export type SceneSwitcher = (params: ChangeSceneParams) => Promise<void>;

interface CutsceneSnapshot {
  sceneId: string;
  playerX: number;
  playerY: number;
  cameraX: number;
  cameraY: number;
  cameraZoom: number;
}

export class CutsceneManager implements IGameSystem {
  private eventBus: EventBus;
  private flagStore: FlagStore;
  private actionExecutor: ActionExecutor;
  private cutsceneRenderer: CutsceneRenderer;

  private cutsceneDefs: Map<string, NewCutsceneDef> = new Map();
  private playing: boolean = false;
  private waitClickResolve: (() => void) | null = null;
  private dialogueResolve: (() => void) | null = null;
  /** performance.now() 之前忽略对白/字幕的点击推进（避免 WebView/同帧伪输入立刻 resolve） */
  private dialogueAdvanceNotBefore = 0;
  /** 同上，用于 wait_click */
  private waitClickNotBefore = 0;
  private onClickBound: () => void;

  private entityResolver: EntityResolver | null = null;
  private sceneSwitcher: SceneSwitcher | null = null;
  private tempActors: Map<string, Npc> = new Map();
  private emoteBubbleProvider: IEmoteBubbleProvider | null = null;
  private inputManager: InputManager | null = null;
  private assetManager!: AssetManager;
  private unsubInput: (() => void) | null = null;
  private destroyed = false;
  private skipping = false;
  private _skipCheckRafIds = new Set<number>();

  private snapshot: CutsceneSnapshot | null = null;
  private sceneIdGetter: (() => string | null) | null = null;
  private playerPositionGetter: (() => { x: number; y: number }) | null = null;
  private playerPositionSetter: ((x: number, y: number) => void) | null = null;
  private cameraAccessor: Camera | null = null;
  private spawnPointResolver: ((spawnKey: string) => { x: number; y: number } | null) | null = null;

  constructor(
    eventBus: EventBus,
    flagStore: FlagStore,
    actionExecutor: ActionExecutor,
    cutsceneRenderer: CutsceneRenderer,
  ) {
    this.eventBus = eventBus;
    this.flagStore = flagStore;
    this.actionExecutor = actionExecutor;
    this.cutsceneRenderer = cutsceneRenderer;

    this.onClickBound = () => {
      const now = performance.now();
      if (this.waitClickResolve) {
        if (now < this.waitClickNotBefore) return;
        const r = this.waitClickResolve;
        this.waitClickResolve = null;
        this.waitClickNotBefore = 0;
        r();
      }
      if (this.dialogueResolve) {
        if (now < this.dialogueAdvanceNotBefore) return;
        const r = this.dialogueResolve;
        this.dialogueResolve = null;
        this.dialogueAdvanceNotBefore = 0;
        r();
      }
    };
  }

  init(ctx: GameContext): void {
    this.assetManager = ctx.assetManager;
  }
  update(_dt: number): void {}

  setInputManager(im: InputManager): void {
    this.inputManager = im;
  }

  setEntityResolver(resolver: EntityResolver): void {
    this.entityResolver = resolver;
  }

  setEmoteBubbleProvider(provider: IEmoteBubbleProvider): void {
    this.emoteBubbleProvider = provider;
  }

  setSceneSwitcher(switcher: SceneSwitcher): void {
    this.sceneSwitcher = switcher;
  }

  setSceneIdGetter(fn: () => string | null): void {
    this.sceneIdGetter = fn;
  }

  setPlayerPositionGetter(fn: () => { x: number; y: number }): void {
    this.playerPositionGetter = fn;
  }

  setPlayerPositionSetter(fn: (x: number, y: number) => void): void {
    this.playerPositionSetter = fn;
  }

  setCameraAccessor(camera: Camera): void {
    this.cameraAccessor = camera;
  }

  setSpawnPointResolver(fn: (spawnKey: string) => { x: number; y: number } | null): void {
    this.spawnPointResolver = fn;
  }

  getCutsceneIds(): string[] {
    return Array.from(this.cutsceneDefs.keys());
  }

  getCutsceneDef(id: string): NewCutsceneDef | undefined {
    return this.cutsceneDefs.get(id);
  }

  /**
   * 渐变改变相机 zoom（与演出 camera_zoom 同源，供 Action fadingZoom 等使用）。
   */
  fadingCameraZoom(targetZoom: number, durationMs: number): void {
    const d = Math.max(0, durationMs);
    void this.cutsceneRenderer.cameraZoom(targetZoom, d <= 0 ? 1 : d).catch((e) => {
      console.warn('CutsceneManager: fadingCameraZoom failed', e);
    });
  }

  /** Action「showOverlayImage」：与过场 `show_img` 共用 cutsceneOverlay 与 `hideImg` 句柄。 */
  showOverlayImage(
    overlayId: string,
    imagePath: string,
    xPercent: number,
    yPercent: number,
    widthPercent: number,
  ): Promise<void> {
    return this.cutsceneRenderer.showPercentImg(imagePath, overlayId, xPercent, yPercent, widthPercent);
  }

  hideOverlayImage(overlayId: string): void {
    this.cutsceneRenderer.hideImg(overlayId);
  }

  /** Action「blendOverlayImage」：同 showOverlayImage 百分比布局；片元 mix(from,to,t)，delayMs 后 t 在 durationMs 内 0→1。 */
  blendOverlayImage(
    overlayId: string,
    fromPath: string,
    toPath: string,
    xPercent: number,
    yPercent: number,
    widthPercent: number,
    durationMs: number,
    delayMs: number,
  ): Promise<void> {
    return this.cutsceneRenderer.blendPercentImg(
      fromPath,
      toPath,
      overlayId,
      xPercent,
      yPercent,
      widthPercent,
      durationMs,
      delayMs,
    );
  }

  /**
   * 仅遮住场景画面（uiLayer 上的对话框仍可见），与过场 `fade_black` 全屏遮罩不同。
   * 返回在渐隐结束（或失败已记录）时 settled 的 Promise，供对话等需要顺序衔接的流程 await。
   */
  fadeWorldToBlack(durationMs: number): Promise<void> {
    const d = Math.max(0, durationMs);
    return this.cutsceneRenderer.fadeWorldToBlack(d <= 0 ? 1 : d).catch((e) => {
      console.warn('CutsceneManager: fadeWorldToBlack failed', e);
    });
  }

  fadeWorldFromBlack(durationMs: number): Promise<void> {
    const d = Math.max(0, durationMs);
    return this.cutsceneRenderer.fadeWorldFromBlack(d <= 0 ? 1 : d).catch((e) => {
      console.warn('CutsceneManager: fadeWorldFromBlack failed', e);
    });
  }

  async loadDefs(): Promise<void> {
    try {
      const list = await this.assetManager.loadJson<NewCutsceneDef[]>('/assets/data/cutscenes/index.json');
      const imagePaths = new Set<string>();
      for (const def of list) {
        this.cutsceneDefs.set(def.id, def);
        this.collectImagePathsFromSteps(def.steps ?? [], imagePaths);
      }
      for (const path of imagePaths) {
        try {
          await this.assetManager.loadTexture(path);
        } catch (err) {
          console.warn(`[CutsceneManager] 预加载失败: ${path}`, err);
        }
      }
    } catch {
      // no cutscene data yet
    }
  }

  private collectImagePathsFromSteps(steps: CutsceneStep[], out: Set<string>): void {
    for (const step of steps) {
      if (step.kind === 'present' && step.type === 'showImg' && typeof step.image === 'string') {
        out.add(step.image);
      }
      if (step.kind === 'parallel') {
        this.collectImagePathsFromSteps(step.tracks, out);
      }
    }
  }

  async startCutscene(id: string): Promise<void> {
    const def = this.cutsceneDefs.get(id);
    if (!def) {
      console.warn(`CutsceneManager: unknown cutscene "${id}"`);
      return;
    }

    if (this.playing) return;
    this.playing = true;
    this.skipping = false;
    this.eventBus.emit('cutscene:start', { id });
    this.unsubInput = this.inputManager?.subscribeAnyInput(this.onClickBound) ?? null;

    try {
      const needsPositioning = !!def.targetScene || typeof def.targetX === 'number';
      if (needsPositioning) {
        await this.saveAndTransition(def);
      }

      if (!('steps' in def) || !Array.isArray((def as NewCutsceneDef).steps)) {
        console.warn(`CutsceneManager: cutscene "${id}" has no steps array (old commands format is no longer supported)`);
      } else {
        await this.executeSteps((def as NewCutsceneDef).steps);
      }

      if (this.destroyed) return;

      if (needsPositioning && def.restoreState !== false) {
        await this.restoreSnapshot();
      }
      this.snapshot = null;
    } catch (e) {
      console.warn(`CutsceneManager: startCutscene "${id}" failed`, e);
      throw e;
    } finally {
      this.unsubInput?.();
      this.unsubInput = null;
      this.skipping = false;
      this.cleanup();
      this.playing = false;
      this.eventBus.emit('cutscene:end', { id });
    }
  }

  /** 跳过当前演出。无副作用的 A 类表演直接中断 + cleanup。 */
  skip(): void {
    if (!this.playing) return;
    this.skipping = true;
    if (this.waitClickResolve) {
      const r = this.waitClickResolve;
      this.waitClickResolve = null;
      this.waitClickNotBefore = 0;
      r();
    }
    if (this.dialogueResolve) {
      const r = this.dialogueResolve;
      this.dialogueResolve = null;
      this.dialogueAdvanceNotBefore = 0;
      r();
    }
  }

  private async saveAndTransition(def: NewCutsceneDef): Promise<void> {
    const currentSceneId = this.sceneIdGetter?.() ?? '';
    const pos = this.playerPositionGetter?.() ?? { x: 0, y: 0 };
    this.snapshot = {
      sceneId: currentSceneId,
      playerX: pos.x,
      playerY: pos.y,
      cameraX: this.cameraAccessor?.getX() ?? 0,
      cameraY: this.cameraAccessor?.getY() ?? 0,
      cameraZoom: this.cameraAccessor?.getZoom() ?? 1,
    };

    if (def.targetScene && def.targetScene !== currentSceneId && this.sceneSwitcher) {
      await this.sceneSwitcher({
        targetScene: def.targetScene,
        targetSpawnPoint: def.targetSpawnPoint,
      });
    } else if (def.targetSpawnPoint) {
      const spawnPos = this.spawnPointResolver?.(def.targetSpawnPoint);
      if (spawnPos) {
        this.playerPositionSetter?.(spawnPos.x, spawnPos.y);
        this.cameraAccessor?.snapTo(spawnPos.x, spawnPos.y);
      }
    }

    if (typeof def.targetX === 'number' && typeof def.targetY === 'number') {
      this.playerPositionSetter?.(def.targetX, def.targetY);
      this.cameraAccessor?.snapTo(def.targetX, def.targetY);
    }
  }

  private async restoreSnapshot(): Promise<void> {
    if (!this.snapshot) return;
    const currentSceneId = this.sceneIdGetter?.() ?? '';
    if (this.snapshot.sceneId && this.snapshot.sceneId !== currentSceneId && this.sceneSwitcher) {
      await this.sceneSwitcher({ targetScene: this.snapshot.sceneId });
    }
    this.playerPositionSetter?.(this.snapshot.playerX, this.snapshot.playerY);
    this.cameraAccessor?.snapTo(this.snapshot.cameraX, this.snapshot.cameraY);
    this.cameraAccessor?.setZoom(this.snapshot.cameraZoom);
  }

  // ================================================================
  // 新 schema step 执行（阶段 3）
  // ================================================================

  private async executeSteps(steps: CutsceneStep[]): Promise<void> {
    for (const step of steps) {
      if (this.destroyed || this.skipping) return;
      await this.executeOneStep(step);
    }
  }

  private async executeOneStep(step: CutsceneStep): Promise<void> {
    if (this.destroyed || this.skipping) return;
    switch (step.kind) {
      case 'action':
        if (!CUTSCENE_ACTION_WHITELIST.has(step.type)) {
          console.warn(`CutsceneManager: Action type "${step.type}" is not in the Cutscene whitelist — skipped`);
          break;
        }
        await this.actionExecutor.executeAwait({ type: step.type, params: step.params });
        break;
      case 'present':
        await this.executePresent(step);
        break;
      case 'parallel': {
        const raceSkip = new Promise<void>(resolve => {
          const check = () => {
            if (this.skipping || this.destroyed) { resolve(); return; }
            const id = requestAnimationFrame(check);
            this._skipCheckRafIds.add(id);
          };
          check();
        });
        await Promise.race([
          Promise.all(step.tracks.map(s => this.executeOneStep(s))),
          raceSkip,
        ]);
        for (const id of this._skipCheckRafIds) cancelAnimationFrame(id);
        this._skipCheckRafIds.clear();
        break;
      }
      default:
        console.warn(`CutsceneManager: unknown step kind "${(step as { kind: string }).kind}"`);
    }
  }

  private async executePresent(step: { kind: 'present'; type: string; [key: string]: unknown }): Promise<void> {
    if (this.skipping || this.destroyed) return;
    switch (step.type) {
      case 'fadeToBlack':
        await this.cutsceneRenderer.fadeToBlack(step.duration as number ?? 1000);
        break;
      case 'fadeIn':
        await this.cutsceneRenderer.fadeFromBlack(step.duration as number ?? 1000);
        break;
      case 'flashWhite':
        await this.cutsceneRenderer.flashWhite(step.duration as number ?? 200);
        break;
      case 'waitTime':
        await this.cutsceneRenderer.wait(step.duration as number ?? 1000);
        break;
      case 'waitClick':
        await this.waitForClick();
        break;
      case 'showTitle':
        await this.cutsceneRenderer.showTitle(step.text as string, step.duration as number ?? 2000);
        break;
      case 'showDialogue':
        await this.showDialogueText(step.text as string, step.speaker as string | undefined);
        break;
      case 'showImg':
        await this.cutsceneRenderer.showImg(step.image as string, step.id as string ?? 'default');
        break;
      case 'hideImg':
        this.cutsceneRenderer.hideImg(step.id as string ?? 'default');
        break;
      case 'showMovieBar':
        this.cutsceneRenderer.showMovieBar((step.heightPercent as number) ?? 0.1);
        break;
      case 'hideMovieBar':
        this.cutsceneRenderer.hideMovieBar();
        break;
      case 'showSubtitle':
        await this.showSubtitleText(step.text as string, step.position as string | number | undefined);
        break;
      case 'cameraMove':
        await this.cutsceneRenderer.cameraMove(step.x as number, step.y as number, step.duration as number ?? 1000);
        break;
      case 'cameraZoom':
        await this.cutsceneRenderer.cameraZoom(step.scale as number, step.duration as number ?? 500);
        break;
      case 'showCharacter':
        this.entitySetVisible('player', step.visible as boolean ?? true);
        break;
      default:
        console.warn(`CutsceneManager: unknown present type "${step.type}"`);
    }
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  getTempActors(): Map<string, Npc> {
    return this.tempActors;
  }

  /** 供 cutsceneSpawnActor Action 通过 ActionRegistryDeps 代理调用。 */
  spawnTempActor(id: string, name: string, x: number, y: number): void {
    this.entitySpawn(id, name, x, y);
  }

  /** 供 cutsceneRemoveActor Action 通过 ActionRegistryDeps 代理调用。 */
  removeTempActor(id: string): void {
    this.entityRemove(id);
  }

  private entitySpawn(id: string, name: string, x: number, y: number): void {
    if (this.tempActors.has(id)) {
      console.warn(`CutsceneManager entity_spawn: "${id}" already exists`);
      return;
    }
    const def: NpcDef = {
      id, name: name ?? id, x, y, interactionRange: 0,
    };
    const npc = new Npc(def);
    this.tempActors.set(id, npc);
    this.cutsceneRenderer.addToEntityLayer(npc.container);
  }

  private entityRemove(id: string): void {
    const npc = this.tempActors.get(id);
    if (!npc) {
      console.warn(`CutsceneManager entity_remove: "${id}" not found in temp actors`);
      return;
    }
    npc.destroy();
    this.tempActors.delete(id);
  }

  private entitySetVisible(targetId: string, visible: boolean): void {
    const actor = this.entityResolver?.(targetId) ?? null;
    if (!actor) {
      console.warn(`CutsceneManager entity_visible: entity "${targetId}" not found`);
      return;
    }
    actor.setVisible(visible);
  }

  private waitForClick(): Promise<void> {
    return new Promise(resolve => {
      const arm = () => {
        this.waitClickNotBefore = performance.now() + 120;
        this.waitClickResolve = () => {
          this.waitClickResolve = null;
          this.waitClickNotBefore = 0;
          resolve();
        };
      };
      requestAnimationFrame(() => {
        requestAnimationFrame(arm);
      });
    });
  }

  private async showDialogueText(text: string, speaker?: string): Promise<void> {
    const box = this.cutsceneRenderer.showDialogueBox(text, speaker);
    await new Promise<void>(resolve => {
      const arm = () => {
        this.dialogueAdvanceNotBefore = performance.now() + 120;
        this.dialogueResolve = () => {
          this.dialogueResolve = null;
          this.dialogueAdvanceNotBefore = 0;
          resolve();
        };
      };
      requestAnimationFrame(() => {
        requestAnimationFrame(arm);
      });
    });
    this.cutsceneRenderer.dismissDialogueBox(box);
  }

  private async showSubtitleText(text: string, position?: string | number): Promise<void> {
    const pos = position === 'top' || position === 'center' || position === 'bottom' || typeof position === 'number'
      ? position
      : 'bottom';
    const container = this.cutsceneRenderer.showSubtitle(text, pos);
    await new Promise<void>(resolve => {
      const arm = () => {
        this.dialogueAdvanceNotBefore = performance.now() + 120;
        this.dialogueResolve = () => {
          this.dialogueResolve = null;
          this.dialogueAdvanceNotBefore = 0;
          resolve();
        };
      };
      requestAnimationFrame(() => {
        requestAnimationFrame(arm);
      });
    });
    this.cutsceneRenderer.dismissSubtitle(container);
  }

  private cleanup(): void {
    this.cutsceneRenderer.cleanup();
    this.emoteBubbleProvider?.cleanup();
    for (const [, npc] of this.tempActors) {
      npc.destroy();
    }
    this.tempActors.clear();
  }

  serialize(): object {
    return { playing: this.playing };
  }

  deserialize(_data: any): void {
    if (this.playing) {
      this.unsubInput?.();
      this.unsubInput = null;
      this.cleanup();
    }
    this.playing = false;
    this.skipping = false;
    this.snapshot = null;
    this.dialogueAdvanceNotBefore = 0;
    this.waitClickNotBefore = 0;
  }

  destroy(): void {
    this.destroyed = true;
    this.skipping = false;
    this.snapshot = null;
    if (this.waitClickResolve) {
      const r = this.waitClickResolve;
      this.waitClickResolve = null;
      r();
    }
    if (this.dialogueResolve) {
      const r = this.dialogueResolve;
      this.dialogueResolve = null;
      r();
    }
    this.dialogueAdvanceNotBefore = 0;
    this.waitClickNotBefore = 0;
    this.unsubInput?.();
    this.unsubInput = null;
    this.cleanup();
    this.cutsceneDefs.clear();
  }
}
