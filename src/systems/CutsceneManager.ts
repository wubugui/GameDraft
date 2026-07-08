import type { EventBus } from '../core/EventBus';
import type { FlagStore } from '../core/FlagStore';
import type { ActionExecutor } from '../core/ActionExecutor';
import type { AssetManager } from '../core/AssetManager';
import type { InputManager } from '../core/InputManager';
import type { CutsceneRenderer, ShowSubtitleLayout } from '../rendering/CutsceneRenderer';
import type { Camera } from '../rendering/Camera';
import type { ICutsceneActor, IEmoteBubbleAnchor, IEmoteBubbleProvider, EmoteBubbleOffsetOpts, NpcDef, IGameSystem, GameContext, NewCutsceneDef, CutsceneStep, CutsceneKenBurns, ICutsceneAudioPlayer, AudioPlaybackHandle, ParallaxSceneDef } from '../data/types';
import { CUTSCENE_ACTION_WHITELIST, CUTSCENE_ANON_SHOT_ID } from '../data/types';
import { Npc } from '../entities/Npc';
import { splitSpeakerBodyAfterResolve } from '../core/resolveText';
import { TEXT_URLS } from '../core/projectPaths';

export type EntityResolver = (id: string) => ICutsceneActor | null;

const CUTSCENE_GLOBAL_SAVE_ACTION_BLOCKLIST: ReadonlySet<string> = new Set([
  'setFlag',
  'appendFlag',
  'setScenarioPhase',
  'startScenario',
  'activateScenario',
  'completeScenario',
  'giveItem',
  'removeItem',
  'giveCurrency',
  'removeCurrency',
  'giveRule',
  'grantRuleLayer',
  'giveFragment',
  'updateQuest',
  'startEncounter',
  'endDay',
  'addDelayedEvent',
  'addArchiveEntry',
  'openShop',
  'pickup',
  'shopPurchase',
  'inventoryDiscard',
  'revealDocument',
]);

export type ChangeSceneParams = {
  targetScene: string;
  targetSpawnPoint?: string;
  cameraX?: number;
  cameraY?: number;
};

export type SceneSwitcher = (params: ChangeSceneParams) => Promise<void>;

/** 过场发出的表情气泡归属标记：cleanup 定向清理用（EmoteBubbleManager.cleanupByOwner） */
const CUTSCENE_EMOTE_OWNER = 'cutscene';

/**
 * showImg.id / parallaxScene.handle / hideImg.id 的句柄解析：
 * 显式非空 → 手动管理；缺省/空白 → 匿名镜头位（CUTSCENE_ANON_SHOT_ID，自动托管）。
 */
function resolveCutsceneImageHandle(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  return s || CUTSCENE_ANON_SHOT_ID;
}

/** 与 playScriptedDialogue 一致：解析 speaker 中的 {{player}} / {{npc}} 等 */
export type ScriptedSpeakerResolver = (raw: string, scriptedNpcId?: string) => string;

export interface SceneManagerCutsceneAPI {
  beginCutsceneStaging(cutsceneId: string, sceneId: string): void;
  endCutsceneStaging(): void;
  enterCutsceneInstancesForCurrent(cutsceneId: string): Promise<void>;
  exitCutsceneInstancesForCurrent(cutsceneId: string): Promise<void>;
}

interface CutsceneSnapshot {
  sceneId: string;
  playerX: number;
  playerY: number;
  cameraX: number;
  cameraY: number;
  cameraZoom: number;
  /** 过场前音频基线：当前 BGM id（无则 null）与活跃环境层 id 列表，供同场景过场结束后还原。 */
  bgmId: string | null;
  ambientIds: string[];
}

export class CutsceneManager implements IGameSystem {
  private eventBus: EventBus;
  private flagStore: FlagStore;
  private actionExecutor: ActionExecutor;
  private cutsceneRenderer: CutsceneRenderer;

  private cutsceneDefs: Map<string, NewCutsceneDef> = new Map();
  /** parallax_scenes.json 惰性加载缓存（present:parallaxScene 按 id 检索） */
  private parallaxScenes: Record<string, ParallaxSceneDef> | null = null;
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
  private emoteTargetResolver: ((raw: string) => IEmoteBubbleAnchor | null) | null = null;
  private inputManager: InputManager | null = null;
  private audioManager: ICutsceneAudioPlayer | null = null;
  private assetManager!: AssetManager;
  private unsubPointer: (() => void) | null = null;
  private unsubKey: (() => void) | null = null;
  private destroyed = false;
  private skipping = false;
  /** R9：中止在途 steps 的代际——skip / deserialize / destroy 推进。`skipping` 标志会在 finally
   *  复位，被 parallel race 放弃的轨道靠此代际在其当前 await 归来时终止，不再执行后续步。 */
  private stepEpoch = 0;
  /** R10：「世界已被替换」代际——deserialize / destroy 推进。在飞 startCutscene 的 finally
   *  见过期即不得用过场前快照覆盖刚读入的存档状态，也不重复 cleanup。 */
  private worldEpoch = 0;

  private snapshot: CutsceneSnapshot | null = null;
  /** 当前播放的过场 id（供调试 HUD / cutscene:step 事件） */
  private playbackCutsceneId: string | null = null;
  private playbackPathLast: string | null = null;
  private playbackLabelLast: string | null = null;
  private sceneIdGetter: (() => string | null) | null = null;
  private playerPositionGetter: (() => { x: number; y: number }) | null = null;
  private playerPositionSetter: ((x: number, y: number) => void) | null = null;
  private cameraAccessor: Camera | null = null;
  private spawnPointResolver: ((spawnKey: string) => { x: number; y: number } | null) | null = null;
  private scriptedSpeakerResolver: ScriptedSpeakerResolver | null = null;
  /**
   * 与 playScriptedDialogue 一致：解引用后的 narratorLabel 展示串。
   * 仅当 present.showDialogue 的显式 speaker（解引用后）与此串相等时，才允许从正文首冒号剥皮。
   */
  private colonSpeakerNarratorBaselineResolved: string | null = null;
  /** 与 Game.resolveDisplayText 同源；过场字幕在此解析后再交给 CutsceneRenderer（避免绕开统一解析链）。 */
  private displayTextResolver: ((s: string) => string) | null = null;
  private sceneManagerAPI: SceneManagerCutsceneAPI | null = null;
  private activeSubtitleVoiceStops = new Set<() => void>();

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
    /** 律8：destroy 后重 init 行为须与首次一致——瞬态会话状态全部复位
     *  （destroy 已落地挂起 resolve / 解绑输入，这里只清标志与句柄） */
    this.destroyed = false;
    this.playing = false;
    this.skipping = false;
    this.waitClickResolve = null;
    this.dialogueResolve = null;
    this.dialogueAdvanceNotBefore = 0;
    this.waitClickNotBefore = 0;
    this.snapshot = null;
    this.playbackCutsceneId = null;
    this.playbackPathLast = null;
    this.playbackLabelLast = null;
  }
  update(_dt: number): void {}

  setInputManager(im: InputManager): void {
    this.inputManager = im;
  }

  setAudioManager(audioManager: ICutsceneAudioPlayer): void {
    this.audioManager = audioManager;
  }

  setEntityResolver(resolver: EntityResolver): void {
    this.entityResolver = resolver;
  }

  setEmoteBubbleProvider(provider: IEmoteBubbleProvider): void {
    this.emoteBubbleProvider = provider;
  }

  setEmoteTargetResolver(resolver: ((raw: string) => IEmoteBubbleAnchor | null) | null): void {
    this.emoteTargetResolver = resolver;
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

  /** present:showDialogue 的 speaker 与 playScriptedDialogue 共用占位解析 */
  setScriptedSpeakerResolver(fn: ScriptedSpeakerResolver | null): void {
    this.scriptedSpeakerResolver = fn;
  }

  /** present 字幕等：走与 UI 相同的 [tag:…] / resolveText */
  setDisplayTextResolver(fn: ((s: string) => string) | null): void {
    this.displayTextResolver = fn;
  }

  /** 已由 Game.resolveDisplayText 处理的 narratorLabel，供过场对白与剧本台词规则对齐 */
  setColonSpeakerNarratorBaselineResolved(s: string | null): void {
    this.colonSpeakerNarratorBaselineResolved = s;
  }

  setSceneManager(api: SceneManagerCutsceneAPI): void {
    this.sceneManagerAPI = api;
  }

  getCutsceneIds(): string[] {
    return Array.from(this.cutsceneDefs.keys());
  }

  getCutsceneDef(id: string): NewCutsceneDef | undefined {
    return this.cutsceneDefs.get(id);
  }

  /** 供 Debug 面板等读取：当前 step 路径与摘要（非播放时 path/label 为 null） */
  getPlaybackHudSnapshot(): { cutsceneId: string | null; path: string | null; label: string | null } {
    return {
      cutsceneId: this.playbackCutsceneId,
      path: this.playbackPathLast,
      label: this.playbackLabelLast,
    };
  }

  /**
   * 渐变改变相机 zoom（与演出 camera_zoom 同源，供 Action fadingZoom 等使用）。
   */
  fadingCameraZoom(targetZoom: number, durationMs: number): Promise<void> {
    const d = Math.max(0, durationMs);
    return this.cutsceneRenderer.cameraZoom(targetZoom, d <= 0 ? 1 : d).catch((e) => {
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
      const list = await this.assetManager.loadJson<NewCutsceneDef[]>(TEXT_URLS.cutscenesIndex);
      for (const def of list) {
        this.cutsceneDefs.set(def.id, def);
      }
    } catch {
      // no cutscene data yet
    }
  }

  /** 惰性加载 parallax_scenes.json（数组）并按 id 建索引；供 present:parallaxScene 检索。 */
  private async getParallaxScene(id: string): Promise<ParallaxSceneDef | null> {
    if (!this.parallaxScenes) {
      try {
        const arr = await this.assetManager.loadJson<ParallaxSceneDef[]>(TEXT_URLS.parallaxScenes);
        const map: Record<string, ParallaxSceneDef> = {};
        for (const s of Array.isArray(arr) ? arr : []) {
          if (s && typeof s.id === 'string') map[s.id] = s;
        }
        this.parallaxScenes = map;
      } catch {
        this.parallaxScenes = {};
      }
    }
    return this.parallaxScenes[id] ?? null;
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
    /** 本次会话的代际快照：steps 执行与 finally 收尾据此判断是否已被 skip / 读档 / 拆除作废 */
    const stepEpochAtStart = this.stepEpoch;
    const worldEpochAtStart = this.worldEpoch;
    this.playbackCutsceneId = id;
    this.eventBus.emit('cutscene:start', { id });

    // 预热本过场用到的全部图片，避免首次切图时按需加载造成停顿/不流畅。
    // loadTexture 自带缓存，重复调用安全；以 fire-and-forget 并行预热，showImg 自身仍会兜底加载。
    if ('steps' in def && Array.isArray((def as NewCutsceneDef).steps)) {
      const imgPaths = new Set<string>();
      this.collectImagePathsFromSteps((def as NewCutsceneDef).steps, imgPaths);
      for (const p of imgPaths) {
        void this.assetManager.loadTexture(p).catch(() => { /* 预热失败留给 showImg 兜底 */ });
      }
    }
    this.unsubPointer = this.inputManager?.subscribePointerDown(this.onClickBound) ?? null;
    this.unsubKey = this.inputManager?.subscribeKeyDown((e) => {
      if (!this.playing) return;
      if (e.repeat) return;
      if (e.code === 'Escape') {
        e.preventDefault();
        this.skip();
        return;
      }
      if (
        e.code === 'Space'
        || e.code === 'Enter'
        || e.code === 'NumpadEnter'
        || e.code === 'KeyE'
      ) {
        this.onClickBound();
      }
    }) ?? null;

    let wasCrossScene = false;
    try {
      this.captureSnapshot();
      /** 开启一次性音效捕获：其后 action(playSfx/playSignalCue) 起的 SFX 由 AudioManager 登记。
       *  cleanup 时 endCutsceneSfxCapture 收尾——中断路径（Esc 跳过/读档/拆除）停尾音、自然播完让末拍收尾。
       *  置于 cutscene:start 之后：不误捕开场 cutsceneStart 系统提示音（其在 cleanup 前已自然收束）。 */
      this.audioManager?.beginCutsceneSfxCapture();

      const targetSceneId = (def.targetScene || '').trim();
      const currentSceneId = this.sceneIdGetter?.()?.trim() ?? '';
      const sid = targetSceneId || currentSceneId;

      // Begin staging BEFORE switchScene so loadScene can pick up cutscene context
      if (this.sceneManagerAPI && sid) {
        this.sceneManagerAPI.beginCutsceneStaging(id, sid);
      }

      wasCrossScene = await this.saveAndTransitionReturningCrossScene(def);

      if (!wasCrossScene && this.sceneManagerAPI) {
        await this.sceneManagerAPI.enterCutsceneInstancesForCurrent(id);
      }

      if (!('steps' in def) || !Array.isArray((def as NewCutsceneDef).steps)) {
        console.warn(`CutsceneManager: cutscene "${id}" has no steps array (old commands format is no longer supported)`);
      } else {
        /** L1 根因修复：黑名单在 ActionExecutor 唯一执行入口强制（含 randomBranch /
         *  playSignalCue 嵌套批次）；executeOneStep 的顶层 step 过滤保留作纵深防御。 */
        this.actionExecutor.pushActionPolicy(CUTSCENE_GLOBAL_SAVE_ACTION_BLOCKLIST, `cutscene:${id}`);
        try {
          await this.executeSteps((def as NewCutsceneDef).steps, stepEpochAtStart);
        } finally {
          this.actionExecutor.popActionPolicy();
        }
      }

      if (this.destroyed) return;

    } catch (e) {
      console.warn(`CutsceneManager: startCutscene "${id}" failed`, e);
      throw e;
    } finally {
      if (this.worldEpoch !== worldEpochAtStart) {
        /** R10：过场中读档 / 整机拆除已接管收尾（deserialize/destroy 已 cleanup + 解绑输入 +
         *  复位 playing 等），世界随后会整场景重载。这里**不得**用过场前快照覆盖新状态、
         *  不重复 cleanup、不触碰可能已属新会话的 playing/playback 字段；
         *  只兜底清 staging 上下文（幂等）并补发恰好一次 cutscene:end，
         *  保证 await 本次过场的动作链不悬死。 */
        this.sceneManagerAPI?.endCutsceneStaging();
        this.eventBus.emit('cutscene:end', { id });
      } else {
      const wasSkipping = this.skipping;
      this.unsubPointer?.();
      this.unsubPointer = null;
      this.unsubKey?.();
      this.unsubKey = null;
      this.skipping = false;
      try {
        if (!this.destroyed && !wasSkipping) {
          await this.cutsceneRenderer.settleFadeOverlaysBeforeCleanup(500);
        }
      } catch {
        // 淡出失败时仍继续 cleanup，避免卡住过场结束
      }
      try {
        if (wasCrossScene) {
          if (!this.destroyed && def.restoreState !== false) {
            await this.restoreSnapshot();
          }
          this.sceneManagerAPI?.endCutsceneStaging();
        } else {
          if (this.sceneManagerAPI) {
            await this.sceneManagerAPI.exitCutsceneInstancesForCurrent(id);
          }
          this.sceneManagerAPI?.endCutsceneStaging();
          // 同场景过场也恢复快照（玩家位置/相机/缩放），与跨场景分支一致；
          // restoreState:false 时跳过。否则同场景过场里的 cameraZoom / 移动玩家会在结束后残留。
          if (!this.destroyed && def.restoreState !== false) {
            await this.restoreSnapshot();
          }
        }
      } catch (e) {
        console.warn('CutsceneManager: restore cutscene scene session failed', e);
      }
      this.snapshot = null;
      // wasSkipping=true 是 Esc 跳过（中断，停尾音）；false 是自然播完（让末拍音效收尾）。
      this.cleanup(wasSkipping);
      this.playing = false;
      this.playbackCutsceneId = null;
      this.playbackPathLast = null;
      this.playbackLabelLast = null;
      this.eventBus.emit('cutscene:step', { cutsceneId: null, path: null, label: null });
      this.eventBus.emit('cutscene:end', { id });
      }
    }
  }

  /** 跳过当前演出：结束进行中的画面插值/等待，跳过后续 steps，finally 中 cleanup + 恢复快照。 */
  skip(): void {
    if (!this.playing) return;
    this.skipping = true;
    /** R9：推进 step 代际——被 parallel race 放弃的在途轨道在 `skipping` 于 finally 复位后
     *  仍会从当前 await 归来，靠代际不再执行后续步（残留 tween / 加回图片 / 对已销毁演员操作） */
    this.stepEpoch++;
    this.stopActiveSubtitleVoices();
    this.cutsceneRenderer.abortCutsceneOps();
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

  /**
   * Returns true if cross-scene switch happened.
   */
  private async saveAndTransitionReturningCrossScene(def: NewCutsceneDef): Promise<boolean> {
    const currentSceneId = this.sceneIdGetter?.()?.trim() ?? '';
    const targetSceneId = typeof def.targetScene === 'string' ? def.targetScene.trim() : '';
    let wasCrossScene = false;

    if (targetSceneId && targetSceneId !== currentSceneId && this.sceneSwitcher) {
      await this.sceneSwitcher({
        targetScene: targetSceneId,
        targetSpawnPoint: def.targetSpawnPoint,
      });
      wasCrossScene = true;
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

    return wasCrossScene;
  }

  private captureSnapshot(): void {
    const currentSceneId = this.sceneIdGetter?.() ?? '';
    const pos = this.playerPositionGetter?.() ?? { x: 0, y: 0 };
    this.snapshot = {
      sceneId: currentSceneId,
      playerX: pos.x,
      playerY: pos.y,
      cameraX: this.cameraAccessor?.getX() ?? 0,
      cameraY: this.cameraAccessor?.getY() ?? 0,
      cameraZoom: this.cameraAccessor?.getZoom() ?? 1,
      bgmId: this.audioManager?.getCurrentBgmId() ?? null,
      ambientIds: this.audioManager?.getActiveAmbientIds() ?? [],
    };
  }

  private async restoreSnapshot(): Promise<void> {
    if (!this.snapshot) return;
    const currentSceneId = this.sceneIdGetter?.()?.trim() ?? '';
    if (this.snapshot.sceneId.trim() === currentSceneId) {
      // same-scene: just restore player + camera position/zoom, no scene reload
      this.playerPositionSetter?.(this.snapshot.playerX, this.snapshot.playerY);
      this.cameraAccessor?.snapTo(this.snapshot.cameraX, this.snapshot.cameraY);
      this.cameraAccessor?.setZoom(this.snapshot.cameraZoom);
      // 同场景过场结束：把被过场 action 改动的音频（playBgm/stopBgm/playSignalCue→stopSceneAmbient）
      // 还原到过场前基线。跨场景分支下方 sceneSwitcher→loadScene→applySceneAudio 会重建目标场景音频，
      // 故只在同场景分支处理（幂等：基线未被改动时全为 no-op）。
      this.audioManager?.restoreAudioBaseline(this.snapshot.bgmId, this.snapshot.ambientIds);
      return;
    }
    if (this.snapshot.sceneId && this.sceneSwitcher) {
      await this.sceneSwitcher({ targetScene: this.snapshot.sceneId });
    }
    this.playerPositionSetter?.(this.snapshot.playerX, this.snapshot.playerY);
    this.cameraAccessor?.snapTo(this.snapshot.cameraX, this.snapshot.cameraY);
    this.cameraAccessor?.setZoom(this.snapshot.cameraZoom);
  }

  // ================================================================
  // 新 schema step 执行（阶段 3）
  // ================================================================

  /**
   * 步进路径「本次会话已作废」判据。skip() 是唯一置 `skipping=true` 处，且在同一同步调用里
   * 立即 `stepEpoch++`（deserialize / destroy 亦推进 stepEpoch），故 `skipping` 已被 epoch 失配蕴含，
   * 此处不再冗余检查——只要 stepEpoch 偏离启动时快照或已 destroyed，在途步即放弃。
   */
  private isStepStale(epoch: number): boolean {
    return this.destroyed || this.stepEpoch !== epoch;
  }

  /**
   * arming 路径「此刻可武装等待」判据（点击/对白/字幕的双 rAF 窗口末尾）。此处保留 `skipping`：
   * skip 在 finally 复位 skipping 后被 race 放弃的轨道不经此路径，而 arming 是新武装动作，
   * 须在 skip / 拆除 / 非播放态时拒绝武装，避免留下无人认领的 resolve 令演出通道悬死。
   */
  private canArmWait(): boolean {
    return !this.skipping && !this.destroyed && this.playing;
  }

  private async executeSteps(steps: CutsceneStep[], epoch: number): Promise<void> {
    for (let i = 0; i < steps.length; i++) {
      if (this.isStepStale(epoch)) return;
      await this.executeOneStep(steps[i], String(i), epoch);
    }
  }

  /** 人类可读的当前 step 摘要（调试用） */
  private formatPlaybackStepLabel(step: CutsceneStep): string {
    if (step.kind === 'action') {
      const raw = step.params && Object.keys(step.params).length > 0
        ? JSON.stringify(step.params)
        : '';
      const ps = raw.length > 72 ? `${raw.slice(0, 69)}…` : raw;
      return ps ? `action:${step.type} ${ps}` : `action:${step.type}`;
    }
    if (step.kind === 'present') {
      const t = step.type;
      if (t === 'showDialogue') {
        const tx = String((step as { text?: string }).text ?? '').replace(/\n/g, ' ');
        return tx.length > 36 ? `present:showDialogue "${tx.slice(0, 33)}…"` : `present:showDialogue "${tx}"`;
      }
      if (t === 'showTitle') {
        const tx = String((step as { text?: string }).text ?? '');
        return tx.length > 28 ? `present:showTitle "${tx.slice(0, 25)}…"` : `present:showTitle "${tx}"`;
      }
      if (t === 'waitTime' || t === 'fadeToBlack' || t === 'fadeIn' || t === 'flashWhite' || t === 'cameraMove' || t === 'cameraZoom') {
        const d = (step as { duration?: number }).duration;
        return `present:${t}${d != null ? ` ${d}ms` : ''}`;
      }
      if (t === 'showImg') {
        return `present:showImg id=${String((step as { id?: string }).id ?? '')}`;
      }
      if (t === 'showSubtitle') {
        const st = step as { subtitleEmote?: unknown };
        const se = st.subtitleEmote;
        let em = '';
        if (se && typeof se === 'object') {
          const o = se as Record<string, unknown>;
          const tg = typeof o.target === 'string' ? o.target.trim() : '';
          const emt = typeof o.emote === 'string' ? o.emote.trim() : '';
          if (tg && emt) em = ` emote=${JSON.stringify(emt)}@${tg}`;
        }
        return `present:showSubtitle${em}`;
      }
      return `present:${t}`;
    }
    if (step.kind === 'parallel') {
      return `parallel (${step.tracks.length} tracks)`;
    }
    return String((step as { kind?: string }).kind ?? '?');
  }

  private emitPlaybackStep(path: string, step: CutsceneStep): void {
    if (!this.playbackCutsceneId) return;
    const label = this.formatPlaybackStepLabel(step);
    this.playbackPathLast = path;
    this.playbackLabelLast = label;
    this.eventBus.emit('cutscene:step', {
      cutsceneId: this.playbackCutsceneId,
      path,
      label,
    });
  }

  private async executeOneStep(step: CutsceneStep, path: string, epoch: number): Promise<void> {
    if (this.isStepStale(epoch)) return;
    this.emitPlaybackStep(path, step);
    switch (step.kind) {
      case 'action':
        if (CUTSCENE_GLOBAL_SAVE_ACTION_BLOCKLIST.has(step.type)) {
          console.warn(`CutsceneManager: Action type "${step.type}" modifies global save state and is ignored inside cutscenes`);
          break;
        }
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
        let skipRafId = 0;
        let resolveSkip: (() => void) | null = null;
        const raceSkip = new Promise<void>(resolve => {
          resolveSkip = resolve;
          const check = () => {
            if (this.isStepStale(epoch)) { resolve(); return; }
            skipRafId = requestAnimationFrame(check);
          };
          check();
        });
        await Promise.race([
          Promise.all(step.tracks.map((s, j) => this.executeOneStep(s, `${path}.p${j}`, epoch))).then(() => {
            cancelAnimationFrame(skipRafId);
            resolveSkip?.();
          }),
          raceSkip,
        ]);
        cancelAnimationFrame(skipRafId);
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
      case 'showDialogue': {
        const rawSpeaker = step.speaker !== undefined && step.speaker !== null
          ? String(step.speaker).trim()
          : '';
        const scriptedNpcId = String((step as { scriptedNpcId?: unknown }).scriptedNpcId ?? '').trim();
        let speakerOut: string | undefined;
        if (rawSpeaker && this.scriptedSpeakerResolver) {
          speakerOut = this.scriptedSpeakerResolver(rawSpeaker, scriptedNpcId || undefined);
        } else if (rawSpeaker) {
          speakerOut = rawSpeaker;
        } else {
          speakerOut = undefined;
        }
        const merged = this.mergePresentShowDialogueLine(step.text as string, speakerOut);
        await this.showDialogueText(merged.text, merged.speaker);
        break;
      }
      case 'showImg': {
        const kb = step.kenBurns;
        const rawZ = step.zIndex;
        const z = typeof rawZ === 'number' ? rawZ : Number(rawZ);
        await this.cutsceneRenderer.showImg(
          step.image as string,
          resolveCutsceneImageHandle(step.id),
          kb && typeof kb === 'object' && !Array.isArray(kb) ? (kb as CutsceneKenBurns) : undefined,
          Number.isFinite(z) ? z : undefined,
        );
        break;
      }
      case 'animLayer': {
        const numOrU = (v: unknown): number | undefined => {
          const n = typeof v === 'number' ? v : Number(v);
          return Number.isFinite(n) ? n : undefined;
        };
        await this.cutsceneRenderer.showAnimLayer(
          step.animFile as string,
          step.id as string ?? 'anim',
          {
            state: typeof step.state === 'string' ? step.state : undefined,
            xPercent: numOrU(step.xPercent),
            yPercent: numOrU(step.yPercent),
            widthPercent: numOrU(step.widthPercent),
            alpha: numOrU(step.alpha),
            zIndex: numOrU(step.zIndex),
          },
        );
        break;
      }
      case 'parallaxScene': {
        const inline = step.scene && typeof step.scene === 'object' && !Array.isArray(step.scene)
          ? (step.scene as ParallaxSceneDef)
          : null;
        const sid = String(step.id ?? '').trim();
        const def = inline ?? (sid ? await this.getParallaxScene(sid) : null);
        if (def && Array.isArray(def.layers)) {
          await this.cutsceneRenderer.showParallaxScene(def, resolveCutsceneImageHandle(step.handle));
        } else {
          console.warn(`CutsceneManager: parallaxScene 未找到场景 "${sid}"`);
        }
        break;
      }
      case 'hideImg':
        this.cutsceneRenderer.hideImg(resolveCutsceneImageHandle(step.id));
        break;
      case 'showMovieBar':
        this.cutsceneRenderer.showMovieBar((step.heightPercent as number) ?? 0.1);
        break;
      case 'hideMovieBar':
        this.cutsceneRenderer.hideMovieBar();
        break;
      case 'showSubtitle':
        await this.showSubtitleText(
          step.text as string,
          this.resolveShowSubtitleLayout(step as Record<string, unknown>),
          this.parseSubtitleEmoteSpec(step as Record<string, unknown>),
          this.parseSubtitleVoiceSpec(step as Record<string, unknown>),
          this.parseSubtitleAutoAdvanceSpec(step as Record<string, unknown>),
        );
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
        /** 双 rAF arming 窗口内已 skip / 读档 / 拆除：立即落地，不再武装等待
         *  （否则 Esc 卡一拍；读档后新武装的 resolve 无人认领 → 演出通道悬死） */
        if (!this.canArmWait()) {
          resolve();
          return;
        }
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

  private mergePresentShowDialogueLine(
    rawText: string,
    speakerOut: string | undefined,
  ): { text: string; speaker?: string } {
    const resolve = this.displayTextResolver ?? ((s: string) => s);
    const textR = resolve(String(rawText ?? ''));
    const split = splitSpeakerBodyAfterResolve(textR);
    const rawSp =
      speakerOut !== undefined && speakerOut !== null ? String(speakerOut).trim() : '';

    if (!rawSp) {
      if (split) {
        return { speaker: split.speaker, text: split.body };
      }
      return { text: textR };
    }

    const speakerR = resolve(rawSp);
    const baseline = this.colonSpeakerNarratorBaselineResolved;
    if (split && baseline !== null && speakerR === baseline) {
      return { speaker: split.speaker, text: split.body };
    }
    return { speaker: speakerR, text: textR };
  }

  private async showDialogueText(text: string, speaker?: string): Promise<void> {
    const box = this.cutsceneRenderer.showDialogueBox(text, speaker);
    await new Promise<void>(resolve => {
      const arm = () => {
        /** 同 waitForClick：arming 窗口内已 skip / 读档 / 拆除则立即落地 */
        if (!this.canArmWait()) {
          resolve();
          return;
        }
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

  /** showSubtitle：`subtitleBand`+`subtitleAlign` 同时为白名单值时走黑边槽位，否则走经典 `position`。 */
  private resolveShowSubtitleLayout(step: Record<string, unknown>): ShowSubtitleLayout {
    const rawBand = step.subtitleBand;
    const rawAlign = step.subtitleAlign;
    const band = typeof rawBand === 'string' ? rawBand.trim() : '';
    const align = typeof rawAlign === 'string' ? rawAlign.trim() : '';
    const bandOk = band === 'movieTop' || band === 'movieBottom';
    const alignOk = align === 'left' || align === 'center' || align === 'right';
    if (bandOk && alignOk) {
      return {
        subtitleBand: band,
        subtitleAlign: align,
      };
    }
    const pos = step.position;
    if (pos === 'top' || pos === 'center' || pos === 'bottom' || typeof pos === 'number') {
      return pos;
    }
    return 'bottom';
  }

  /** `subtitleEmote`：target/emote/偏移同 showEmote；**展示时长随字幕**，`duration` 仅兼容数据字段不驱动消失。 */
  private parseSubtitleEmoteSpec(step: Record<string, unknown>): {
    target: string;
    emote: string;
    durationMs: number;
    opts: EmoteBubbleOffsetOpts;
  } | null {
    const raw = step.subtitleEmote;
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    const target = typeof o.target === 'string' ? o.target.trim() : '';
    const emote = typeof o.emote === 'string' ? o.emote.trim() : '';
    if (!target || !emote) return null;
    const durRaw = o.duration;
    const durationParsed = typeof durRaw === 'number' ? durRaw : Number(durRaw);
    const durationMs = Number.isFinite(durationParsed) && durationParsed > 0 ? durationParsed : 1500;
    const ox = Number(o.anchorOffsetX);
    const oy = Number(o.anchorOffsetY);
    return {
      target,
      emote,
      durationMs,
      opts: {
        anchorOffsetX: Number.isFinite(ox) ? ox : 0,
        anchorOffsetY: Number.isFinite(oy) ? oy : 0,
      },
    };
  }

  /**
   * 字幕配音。`subtitleVoice` 字符串表示 audio_config.sfx id；
   * 对象形态可写 `{ "id": "...", "volume": 0.8 }`。
   */
  private parseSubtitleVoiceSpec(step: Record<string, unknown>): { id: string; volume?: number } | null {
    const raw = step.subtitleVoice;
    if (typeof raw === 'string') {
      const id = raw.trim();
      return id ? { id } : null;
    }
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    const id = typeof o.id === 'string'
      ? o.id.trim()
      : typeof o.sfxId === 'string'
        ? o.sfxId.trim()
        : '';
    if (!id) return null;
    const rawVolume = o.volume;
    const volume = typeof rawVolume === 'number' ? rawVolume : Number(rawVolume);
    return Number.isFinite(volume) ? { id, volume } : { id };
  }

  /**
   * `subtitleAutoAdvance`：`"voice"`=配音自然播完后自动推进；正数=展示该毫秒数后自动推进。
   * 缺省 / 非法值 = 现状（等待点击）。两种模式下玩家点击仍可提前推进。
   */
  private parseSubtitleAutoAdvanceSpec(
    step: Record<string, unknown>,
  ): { mode: 'voice' } | { mode: 'timer'; ms: number } | null {
    const raw = step.subtitleAutoAdvance;
    if (raw === 'voice') return { mode: 'voice' };
    const ms = typeof raw === 'number' ? raw : NaN;
    if (Number.isFinite(ms) && ms > 0) return { mode: 'timer', ms };
    return null;
  }

  private async showSubtitleText(
    text: string,
    layout: ShowSubtitleLayout,
    subtitleEmote: ReturnType<CutsceneManager['parseSubtitleEmoteSpec']>,
    subtitleVoice: ReturnType<CutsceneManager['parseSubtitleVoiceSpec']>,
    autoAdvance: ReturnType<CutsceneManager['parseSubtitleAutoAdvanceSpec']> = null,
  ): Promise<void> {
    const raw = String(text ?? '');
    const resolved = this.displayTextResolver ? this.displayTextResolver(raw) : raw;
    const split = splitSpeakerBodyAfterResolve(resolved);
    const subtitleContent = split
      ? { speaker: split.speaker, separator: split.separator, body: split.body }
      : resolved;
    const container = this.cutsceneRenderer.showSubtitle(subtitleContent, layout);
    let dismissSubtitleEmote: (() => void) | null = null;
    let voiceHandle: AudioPlaybackHandle | null = null;
    let stopVoice: (() => void) | null = null;
    /** voice 模式：配音自然播完 → 触发与点击等价的推进；等待尚未武装时先记账，武装时补发 */
    let autoAdvanceFire: (() => void) | null = null;
    let voiceEndedBeforeArm = false;
    const onVoiceEnd = autoAdvance?.mode === 'voice'
      ? () => {
        if (autoAdvanceFire) autoAdvanceFire();
        else voiceEndedBeforeArm = true;
      }
      : undefined;
    if (subtitleVoice) {
      voiceHandle = this.audioManager?.playTransientSfx(
        subtitleVoice.id,
        { volume: subtitleVoice.volume, onEnd: onVoiceEnd },
      ) ?? null;
      if (voiceHandle) {
        stopVoice = () => {
          voiceHandle?.stop();
          voiceHandle = null;
        };
        this.activeSubtitleVoiceStops.add(stopVoice);
      }
    }
    if (subtitleEmote && this.emoteBubbleProvider) {
      const anchor = this.emoteTargetResolver?.(subtitleEmote.target) ?? null;
      if (anchor) {
        const emoteText = this.displayTextResolver
          ? this.displayTextResolver(subtitleEmote.emote)
          : subtitleEmote.emote;
        dismissSubtitleEmote = this.emoteBubbleProvider.showSticky(
          anchor,
          emoteText,
          subtitleEmote.opts,
          CUTSCENE_EMOTE_OWNER,
        );
      } else {
        console.warn(`CutsceneManager showSubtitle: subtitleEmote 目标未解析 "${subtitleEmote.target}"`);
      }
    }
    try {
      await new Promise<void>(resolve => {
        let settled = false;
        let autoTimerId: ReturnType<typeof setTimeout> | null = null;
        /** 点击 / skip / 定时 / 配音结束共用的收束：幂等，负责清理定时器与共享 resolver */
        const finish = () => {
          if (settled) return;
          settled = true;
          if (autoTimerId !== null) {
            clearTimeout(autoTimerId);
            autoTimerId = null;
          }
          autoAdvanceFire = null;
          if (this.dialogueResolve === wrappedFinish) this.dialogueResolve = null;
          this.dialogueAdvanceNotBefore = 0;
          resolve();
        };
        /** onClickBound / skip 会先把 dialogueResolve 置 null 再调用；直调 finish 亦安全 */
        const wrappedFinish = () => finish();
        const arm = () => {
          /** 同 waitForClick：arming 窗口内已 skip / 读档 / 拆除则立即落地 */
          if (!this.canArmWait()) {
            finish();
            return;
          }
          if (voiceEndedBeforeArm) {
            finish();
            return;
          }
          this.dialogueAdvanceNotBefore = performance.now() + 120;
          this.dialogueResolve = wrappedFinish;
          autoAdvanceFire = finish;
          if (autoAdvance?.mode === 'timer') {
            autoTimerId = setTimeout(finish, autoAdvance.ms);
          }
        };
        requestAnimationFrame(() => {
          requestAnimationFrame(arm);
        });
      });
    } finally {
      if (stopVoice) {
        stopVoice();
        this.activeSubtitleVoiceStops.delete(stopVoice);
      }
      dismissSubtitleEmote?.();
      this.cutsceneRenderer.dismissSubtitle(container);
    }
  }

  private stopActiveSubtitleVoices(): void {
    for (const stop of Array.from(this.activeSubtitleVoiceStops)) {
      stop();
    }
    this.activeSubtitleVoiceStops.clear();
  }

  /**
   * @param stopCutsceneSfx 中断路径（Esc 跳过 / 读档 / 拆除）传 true——停掉本过场尚在播放的一次性音效；
   *   自然播完传 false——只关闭捕获作用域、让末拍音效按编排收尾。所有退出路径都经 cleanup，是音频收尾唯一收口。
   */
  private cleanup(stopCutsceneSfx: boolean): void {
    this.stopActiveSubtitleVoices();
    this.audioManager?.endCutsceneSfxCapture(stopCutsceneSfx);
    this.cutsceneRenderer.cleanup();
    /** 只清过场自己发的气泡（owner='cutscene'）：全量 cleanup 会误杀世界侧仍在倒计时的气泡 */
    this.emoteBubbleProvider?.cleanupByOwner(CUTSCENE_EMOTE_OWNER);
    for (const [, npc] of this.tempActors) {
      /** Npc.destroy 会落地其在途 moveTo promise，避免等待该移动的动作链悬死 */
      npc.destroy();
    }
    this.tempActors.clear();
  }

  serialize(): object {
    return { playing: this.playing };
  }

  deserialize(_data: any): void {
    /** R10：过场中读档必须真正中止在途演出——
     *  (a) 推进 stepEpoch：在途 steps（含被 parallel 放弃的轨道）从当前 await 归来即弃；
     *  (b) 立即落地挂起的 waitClick / 对白 resolve：否则监听已 unsub、promise 永不 resolve，
     *      cutscene:end 不发、演出通道悬死；
     *  (c) 推进 worldEpoch：在飞 startCutscene 的 finally 不得用过场前快照覆盖刚读入的存档
     *      （staging / cutscene:end 由该 finally 的过期分支兜底、只发一次）。
     *  cleanup 内 cutsceneRenderer.cleanup 会 abortCutsceneOps（渲染侧代际，Wave1）。 */
    this.stepEpoch++;
    this.worldEpoch++;
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
    if (this.playing) {
      this.unsubPointer?.();
      this.unsubPointer = null;
      this.unsubKey?.();
      this.unsubKey = null;
      // 读档中断在途过场：停掉尾音（applySceneAudio 只重建 BGM/环境，不管一次性 SFX）。
      this.cleanup(true);
      /** 调试 HUD 的 step 读数靠事件驱动：会话在此终止，补发一次清空（幂等，仅 UI 读数） */
      this.eventBus.emit('cutscene:step', { cutsceneId: null, path: null, label: null });
    }
    this.playing = false;
    this.skipping = false;
    this.snapshot = null;
    this.playbackCutsceneId = null;
    this.playbackPathLast = null;
    this.playbackLabelLast = null;
    this.dialogueAdvanceNotBefore = 0;
    this.waitClickNotBefore = 0;
  }

  destroy(): void {
    this.destroyed = true;
    /** 与 deserialize 同因：在途 steps / 在飞 finally 归来即弃（finally 走过期分支收尾） */
    this.stepEpoch++;
    this.worldEpoch++;
    this.skipping = false;
    this.snapshot = null;
    this.playbackCutsceneId = null;
    this.playbackPathLast = null;
    this.playbackLabelLast = null;
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
    this.unsubPointer?.();
    this.unsubPointer = null;
    this.unsubKey?.();
    this.unsubKey = null;
    // 拆除中断在途过场：停掉尾音（AudioManager.destroy 亦会全停 sfxCache，双保险）。
    this.cleanup(true);
    this.cutsceneDefs.clear();
  }
}
