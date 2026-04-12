import type { EventBus } from '../core/EventBus';
import type { FlagStore } from '../core/FlagStore';
import type { ActionExecutor } from '../core/ActionExecutor';
import type { AssetManager } from '../core/AssetManager';
import type { InputManager } from '../core/InputManager';
import type { CutsceneRenderer } from '../rendering/CutsceneRenderer';
import type { Camera } from '../rendering/Camera';
import type { CutsceneDef, CutsceneCommand, ICutsceneActor, IEmoteBubbleProvider, NpcDef, IGameSystem, GameContext } from '../data/types';
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

  private cutsceneDefs: Map<string, CutsceneDef> = new Map();
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

  getCutsceneDef(id: string): CutsceneDef | undefined {
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
      const list = await this.assetManager.loadJson<CutsceneDef[]>('/assets/data/cutscenes/index.json');
      const imagePaths = new Set<string>();
      for (const def of list) {
        this.cutsceneDefs.set(def.id, def);
        for (const cmd of def.commands || []) {
          if (cmd.type === 'show_img' && typeof cmd.image === 'string') {
            imagePaths.add(cmd.image);
          }
        }
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

  async startCutscene(id: string): Promise<void> {
    const def = this.cutsceneDefs.get(id);
    if (!def) {
      console.warn(`CutsceneManager: unknown cutscene "${id}"`);
      return;
    }

    if (this.playing) return;
    this.playing = true;
    this.eventBus.emit('cutscene:start', { id });
    this.unsubInput = this.inputManager?.subscribeAnyInput(this.onClickBound) ?? null;

    try {
      const needsPositioning = !!def.targetScene || typeof def.targetX === 'number';
      if (needsPositioning) {
        await this.saveAndTransition(def);
      }

      await this.executeCommands(def.commands);

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
      this.cleanup();
      this.playing = false;
      this.eventBus.emit('cutscene:end', { id });
    }
  }

  private async saveAndTransition(def: CutsceneDef): Promise<void> {
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

  get isPlaying(): boolean {
    return this.playing;
  }

  getTempActors(): Map<string, Npc> {
    return this.tempActors;
  }

  private resolveEntity(id: string): ICutsceneActor | null {
    const temp = this.tempActors.get(id);
    if (temp) return temp;
    return this.entityResolver?.(id) ?? null;
  }

  private async executeCommands(commands: CutsceneCommand[]): Promise<void> {
    let i = 0;
    while (i < commands.length) {
      if (this.destroyed) return;

      const parallelGroup: CutsceneCommand[] = [commands[i]];
      while (i + 1 < commands.length && commands[i + 1].parallel) {
        i++;
        parallelGroup.push(commands[i]);
      }

      if (parallelGroup.length === 1) {
        await this.executeOne(parallelGroup[0]);
      } else {
        await Promise.all(parallelGroup.map(c => this.executeOne(c)));
      }
      i++;
    }
  }

  private async executeOne(cmd: CutsceneCommand): Promise<void> {
    switch (cmd.type) {
      case 'fade_black':
        await this.cutsceneRenderer.fadeToBlack(cmd.duration as number ?? 1000);
        break;
      case 'fade_in':
        await this.cutsceneRenderer.fadeFromBlack(cmd.duration as number ?? 1000);
        break;
      case 'flash_white':
        await this.cutsceneRenderer.flashWhite(cmd.duration as number ?? 200);
        break;
      case 'wait_time':
        await this.cutsceneRenderer.wait(cmd.duration as number ?? 1000);
        break;
      case 'wait_click':
        await this.waitForClick();
        break;
      case 'set_flag':
        this.actionExecutor.execute({ type: 'setFlag', params: { key: cmd.key as string, value: cmd.value as boolean | number } });
        break;
      case 'show_title':
        await this.cutsceneRenderer.showTitle(cmd.text as string, cmd.duration as number ?? 2000);
        break;
      case 'show_dialogue':
        await this.showDialogueText(cmd.text as string, cmd.speaker as string | undefined);
        break;
      case 'play_bgm':
        this.actionExecutor.execute({ type: 'playBgm', params: { id: cmd.id as string, fadeMs: cmd.fadeMs as number } });
        break;
      case 'stop_bgm':
        this.actionExecutor.execute({ type: 'stopBgm', params: { fadeMs: cmd.fadeMs as number } });
        break;
      case 'play_sfx':
        this.actionExecutor.execute({ type: 'playSfx', params: { id: cmd.id as string } });
        break;
      case 'camera_move':
        await this.cutsceneRenderer.cameraMove(cmd.x as number, cmd.y as number, cmd.duration as number ?? 1000);
        break;
      case 'camera_zoom':
        await this.cutsceneRenderer.cameraZoom(cmd.scale as number, cmd.duration as number ?? 500);
        break;
      case 'switch_scene':
        this.actionExecutor.execute({ type: 'switchScene', params: { targetScene: cmd.sceneId as string, targetSpawnPoint: cmd.spawnPoint as string | undefined } });
        break;
      case 'change_scene': {
        const params: ChangeSceneParams = {
          targetScene: cmd.sceneId as string,
          targetSpawnPoint: cmd.spawnPoint as string | undefined,
          cameraX: cmd.cameraX as number | undefined,
          cameraY: cmd.cameraY as number | undefined,
        };
        if (this.sceneSwitcher) {
          await this.sceneSwitcher(params);
        } else {
          this.actionExecutor.execute({ type: 'changeScene', params });
        }
        break;
      }
      case 'show_character':
        this.entitySetVisible('player', cmd.visible as boolean ?? true);
        break;
      case 'show_img':
        await this.cutsceneRenderer.showImg(cmd.image as string, cmd.id as string);
        break;
      case 'hide_img':
        this.cutsceneRenderer.hideImg(cmd.id as string);
        break;
      case 'show_movie_bar':
        this.cutsceneRenderer.showMovieBar((cmd.heightPercent as number) ?? 0.1);
        break;
      case 'hide_movie_bar':
        this.cutsceneRenderer.hideMovieBar();
        break;
      case 'show_subtitle':
        await this.showSubtitleText(cmd.text as string, cmd.position as string | number | undefined);
        break;
      case 'execute_action':
        this.actionExecutor.execute({ type: cmd.actionType as string, params: (cmd.params as Record<string, unknown>) ?? {} });
        break;
      case 'entity_move':
        await this.entityMove(cmd.target as string, cmd.x as number, cmd.y as number, cmd.speed as number | undefined);
        break;
      case 'entity_anim':
        this.entityAnim(cmd.target as string, cmd.animation as string);
        break;
      case 'entity_face':
        this.entityFace(cmd.target as string, cmd.direction as string | undefined, cmd.faceTarget as string | undefined);
        break;
      case 'entity_spawn':
        this.entitySpawn(cmd.id as string, cmd.name as string, cmd.x as number, cmd.y as number);
        break;
      case 'entity_remove':
        this.entityRemove(cmd.id as string);
        break;
      case 'entity_emote':
        await this.entityEmote(cmd.target as string, cmd.emote as string, cmd.duration as number | undefined);
        break;
      case 'entity_visible':
        this.entitySetVisible(cmd.target as string, cmd.visible as boolean);
        break;
      default:
        console.warn(`CutsceneManager: unknown command "${cmd.type}"`);
    }
  }

  private async entityMove(targetId: string, x: number, y: number, speed?: number): Promise<void> {
    const actor = this.resolveEntity(targetId);
    if (!actor) {
      console.warn(`CutsceneManager entity_move: entity "${targetId}" not found`);
      return;
    }
    await actor.moveTo(x, y, speed ?? 80);
  }

  private entityAnim(targetId: string, animation: string): void {
    const actor = this.resolveEntity(targetId);
    if (!actor) {
      console.warn(`CutsceneManager entity_anim: entity "${targetId}" not found`);
      return;
    }
    actor.playAnimation(animation);
  }

  private entityFace(targetId: string, direction?: string, faceTargetId?: string): void {
    const actor = this.resolveEntity(targetId);
    if (!actor) {
      console.warn(`CutsceneManager entity_face: entity "${targetId}" not found`);
      return;
    }

    if (faceTargetId) {
      const other = this.resolveEntity(faceTargetId);
      if (other) {
        actor.setFacing(other.x - actor.x, other.y - actor.y);
      }
    } else if (direction) {
      const dirMap: Record<string, [number, number]> = {
        left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1],
      };
      const d = dirMap[direction];
      if (d) actor.setFacing(d[0], d[1]);
    }
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

  private async entityEmote(targetId: string, emote: string, duration?: number): Promise<void> {
    const actor = this.resolveEntity(targetId);
    if (!actor) {
      console.warn(`CutsceneManager entity_emote: entity "${targetId}" not found`);
      return;
    }
    if (this.emoteBubbleProvider) {
      await this.emoteBubbleProvider.showAndWait(actor, emote, duration ?? 1500);
    }
  }

  private entitySetVisible(targetId: string, visible: boolean): void {
    const actor = this.resolveEntity(targetId);
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
    this.snapshot = null;
    this.dialogueAdvanceNotBefore = 0;
    this.waitClickNotBefore = 0;
  }

  destroy(): void {
    this.destroyed = true;
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
