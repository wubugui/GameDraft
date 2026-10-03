import { Container, Graphics, Sprite, Text, type Texture } from '../engine2d';
import type { AssetManager, AssetManifest, AssetRef } from '../core/AssetManager';
import type { EventBus } from '../core/EventBus';
import type { Renderer } from '../rendering/Renderer';
import { Hotspot } from '../entities/Hotspot';
import { Npc } from '../entities/Npc';
import { createPlaceholderBackground } from '../rendering/PlaceholderFactory';
import { UI_LAYER_Z } from '../rendering/uiLayerOrder';
import type {
  ActionDef,
  SceneData,
  SceneRuntimeState,
  Position,
  GameContext,
  SceneCameraConfig,
  NpcPersistentSnapshot,
  HotspotDisplayImage,
  SceneEntityRuntimeOverrides,
  SceneEntityRuntimeValue,
  NpcRuntimeOverride,
  HotspotRuntimeOverride,
  ZoneDef,
  CutsceneBindableEntityDef,
  HotspotDef,
  NpcDef,
  ConditionExpr,
  SceneEntityGroupDef,
  AudioCueRef,
} from '../data/types';
import { isCutsceneOnlyEntity, isEntityBoundToCutscene } from '../data/types';
import { burnableWorldSize, resolveBurnableHost, type ResolvedBurnable } from '../data/burnables';
import { applyCharacterDefaults, type CharacterRegistry } from '../data/characterRegistry';
import type { AnimationSetDefInput } from '../data/resolveAnimationSet';
import { loadSocketsForAnim } from '../data/animationSockets';
import { normalizeAnimationSetDef } from '../data/resolveAnimationSet';
import { normalAtlasUrlFor } from '../rendering/spriteNormalAtlas';
import { resolvePathRelativeToAnimManifest } from '../core/assetPath';
import type { IGameSystem } from '../data/types';
import {
  applyHotspotRuntimeOverride,
  applyNpcRuntimeOverride,
  coerceRuntimeFieldValue,
  type SceneEntityKind,
} from '../data/EntityRuntimeFieldSchema';
import type { ActivePlaneSnapshot } from './plane/types';
import { createStyledText } from '../core/styledText';
import { isEntityInPhaseWithGroup } from '../utils/dayTime';
import {
  applySceneAppearance, resolveSceneAppearance, sameAppearance,
  type ResolvedSceneAppearance,
} from '../utils/sceneAppearance';

/**
 * 静态贴图实体（没有动画包的道具）：把 `NpcDef.displayImage` 合成**一份单帧动画集**，
 * 喂给与普通 NPC 逐字相同的 `SpriteEntity` 路径。
 *
 * 这是本特性唯一的实现手段 —— **不新开实体族、不新开渲染分支**。合成之后，阴影 /
 * 透视 / 深度遮挡 / 内容层排序 / 逐 entity 光照 / 位面 / 分组 / cameraFollowActor /
 * attachToSocket 全都走 NPC 那一条，一处也不需要写"如果是静态贴图就……"。
 *
 * `worldWidth` / `worldHeight` 原样透传给 `normalizeAnimationSetDef`：它对 `undefined`
 * 与非正数一视同仁（见 `resolveAnimationWorldSize`），只填一维时按单格像素长宽比推另一维，
 * 两维都缺时回落 `DEFAULT_WORLD_WIDTH`。`resolvedSheetUrl` 由调用方传 `di.image`，
 * 于是法线图集按 `<图名>.normal.png` 的同一套约定寻址（烘过就用、没烘就平面法线）。
 */
export function buildStaticDisplayAnimationSet(di: HotspotDisplayImage): AnimationSetDefInput {
  return {
    spritesheet: di.image,
    cols: 1,
    rows: 1,
    worldWidth: di.worldWidth,
    worldHeight: di.worldHeight,
    states: { idle: { frames: [0], frameRate: 1, loop: true } },
  };
}

/**
 * 静态贴图实体是否成立：只看图路径。尺寸交给 `normalizeAnimationSetDef` 兜底推导，
 * 这里不再复述一遍"多大才算有效"（复述就是第二处真相）。
 */
function staticDisplayImageOf(def: NpcDef): HotspotDisplayImage | null {
  if (def.animFile) return null; // 两者都写时以动画包为准（types.ts NpcDef.displayImage 契约）
  const di = def.displayImage;
  return di && typeof di.image === 'string' && di.image.trim() ? di : null;
}

/**
 * 开了可燃的实体（A3.8：可燃物是模板，渲染由实例接管）的展示图：模板的图、按模板真实尺寸；
 * 朝向 / 叠放档沿用实体自己 `displayImage` 里写的。`undefined` = 没开可燃；`null` = 开了但模板装不到（画不出来）。
 */
type BurnableDisplay = HotspotDisplayImage | null | undefined;

/** dev 下 spriteSort 错位提示只响一次/实体，避免每次切场景刷屏。 */
const staticDisplaySpriteSortWarned = new Set<string>();

/** applyDebugWorldSize 成功时的返回值，供深度系统与碰撞比例同步 */
export type ApplyDebugWorldSizeResult =
  | { ok: true; worldToPixelX: number; worldToPixelY: number }
  | { ok: false };

interface SceneMemory {
  inspectedHotspots: string[];
  pickedUpHotspots: string[];
  entityOverrides: SceneEntityRuntimeOverrides;
  /**
   * 演出里临时生成、播完**留在场景**的对象（`playTrajectory.spawn.keep`）：完整的 NpcDef，
   * 随场景实例化与存档走——留在终点就意味着场景变了，它必须是真正的场景实体（2026-09-11 制作人定）。
   */
  spawnedNpcs: Record<string, NpcDef>;
}

interface CutsceneStaging {
  cutsceneId: string;
  sceneId: string;
  memory: SceneMemory;
}

/**
 * 运行时生成 / 移除 NPC 的生命周期钩子（Game 装配期注入，见 {@link SceneManager.setRuntimeNpcHooks}）。
 * 两侧**必须成对**：生成侧建的东西（滤镜之外还有阴影 entry）移除侧不拆，就是残留。
 */
export interface RuntimeNpcHooks {
  /** 实体已进 `currentNpcs`、贴图已就绪之后调用：补挂场景滤镜 / 透视 / 阴影 / 像素密度。 */
  onSpawned?: (npc: Npc) => void;
  /** 实体被移除之前调用（此时它还在实体表里）：拆掉生成侧建的、不随实体自毁的东西。 */
  onRemoved?: (id: string) => void;
}

/** One owner and one cancellation scope for every foreground scene load. */
export interface LoadingRequestContext {
  readonly id: string;
  readonly sceneId: string;
  readonly signal: AbortSignal;
  readonly kind: 'initial' | 'switch' | 'reload';
  hasOnEnter: boolean;
  continuesLoading?: boolean;
}

export interface LoadingOutcome {
  status: 'success' | 'recovered' | 'failed' | 'cancelled';
  error?: unknown;
  recovered?: boolean;
  replacement?: boolean;
  continuesLoading?: boolean;
  /** Re-enqueue the original request, never the recovery scene or its suppressed onEnter. */
  retry?: () => Promise<void>;
}

/** Presentation and game-state ownership are injected by the assembly layer. */
export interface LoadingLifecycle {
  /** A surrounding restore may still own Loading after scene preparation has finished. */
  needsHandoff?(): boolean;
  begin(context: LoadingRequestContext): Promise<void>;
  progress(context: LoadingRequestContext, ratio: number, label: string): void;
  reveal(context: LoadingRequestContext): Promise<void>;
  end(context: LoadingRequestContext, outcome: LoadingOutcome): void | Promise<void>;
  runOnEnter?(context: LoadingRequestContext, run: () => Promise<void>): Promise<void>;
}

export interface SceneLoadOptions {
  interrupt?: boolean;
  suppressOnEnter?: boolean;
  timeoutMs?: number;
  scopeId?: string;
}

export interface SafeSceneSnapshot {
  readonly sceneId: string;
  readonly position?: Position;
  readonly camera?: unknown;
  readonly sceneData: SceneData;
}

interface SceneLoadRequest {
  context: LoadingRequestContext;
  controller: AbortController;
  spawnPointId?: string;
  cameraPosition?: Position;
  fromSceneId?: string | null;
  progress?: (ratio: number, label: string) => void;
  onReveal?: () => Promise<void>;
  options: SceneLoadOptions;
  queuedGeneration: number;
  managerEpoch: number;
  ratio: number;
  replacement?: boolean;
}

export class SceneManager implements IGameSystem {
  private assetManager: AssetManager;
  private eventBus: EventBus;
  private renderer: Renderer;

  private currentScene: SceneData | null = null;
  private currentHotspots: Hotspot[] = [];
  private currentNpcs: Npc[] = [];
  /** 可燃物模板（燃烧系统的缓存：工作台工作态覆盖也在那里）；Game 装配期注入 */
  private burnTemplateResolver: ((id: string) => Promise<ResolvedBurnable | null>) | null = null;
  /**
   * 编辑期标记（NPC 名字标签/朝向块、热点占位圆点）是否可见。**默认关**——玩家侧不做任何
   * "这个能交互"的标注（沉浸优先，2026-08-03 拍板）；策划摆位时经 F2 调试面板打开。
   * 与实体四通道显隐正交：那套写 container.visible，这里只压标记子节点的 alpha。
   */
  private authoringMarkersVisible = false;
  private sceneContainerBg: Container | null = null;
  private sceneMemory: Map<string, SceneMemory> = new Map();
  private cutsceneStaging: CutsceneStaging | null = null;

  /** 角色注册表（character_registry.json）：instantiateNpc 合并 name/animFile/portraitSlug 默认。由 Game 装配期注入。 */
  private characterRegistry: CharacterRegistry = {};
  setCharacterRegistry(reg: CharacterRegistry): void {
    this.characterRegistry = reg;
  }

  /**
   * 角色 id → 动画包 URL（`character_registry.json` 的 `animFile`）。
   * 画布实体（{@link CanvasStageSystem}）用它把作者填的角色 id 解成动画包——它不摆在任何场景里，
   * 走不到 `instantiateNpc` 那条合并路，所以要一个只读的窄出口，而不是把整张注册表交出去。
   */
  getCharacterAnimFile(characterId: string): string | undefined {
    return this.characterRegistry[characterId?.trim()]?.animFile;
  }

  /** 当前游戏会话内禁用的 standard zone id（按 sceneId 分桶，不写档）；depth_floor 不可在此关闭 */
  private zoneSessionDisabled: Map<string, Set<string>> = new Map();

  /**
   * 会话级隐藏的实体 id（按 sceneId 分桶，不写档）。与实体实例上的 override 通道成对：
   * 桶保证过场重建 / 重进场景（同会话）时覆盖不丢，实例重建时从桶恢复。
   * 持久显隐仍走 sceneMemory.entityOverrides.enabled（persist* Action），语义不变。
   */
  private entitySessionOverrides: Map<string, { npcs: Set<string>; hotspots: Set<string> }> = new Map();

  /** 场景分组的会话级禁用桶（按 sceneId 分桶，不写档）；与成员自己的覆盖通道正交。 */
  private groupSessionDisabled: Map<string, Set<string>> = new Map();

  /**
   * 非探索态跨时段时挂起的 zone 重注册（存 sceneId；null = 没挂起）。
   * 见 {@link refreshForTimeChange} / {@link flushPendingTimeZoneRefresh}。
   */
  private pendingTimeZoneRefresh: string | null = null;

  /** 场景世代号：unloadScene 自增。跨 await 持有实体/场景引用的流程以此判废，防并发卸载竞态产生孤儿容器 */
  private sceneEpoch = 0;

  /** 切场景淡入淡出根节点（黑底 + 可选加载进度条） */
  private transitionOverlay: Container | null = null;
  /** 切场进度条配色（缺省 = UITheme 同色号的一份拷贝，见 setTransitionPalette） */
  private transitionPalette = { track: 0x2a2118, trackBorder: 0x342a1c, fill: 0xccaa44 };
  private transitionBarFill: Graphics | null = null;
  private transitionBarTrack: Graphics | null = null;
  private transitionBarW = 0;
  private transitionBarH = 8;
  private transitionDebugLabel: Text | null = null;
  private isSwitching: boolean = false;
  /** 切场景请求串行队列，避免并发 switch 静默丢弃或交错 isSwitching */
  private sceneSwitchTail: Promise<void> = Promise.resolve();
  private loadingLifecycle: LoadingLifecycle | null = null;
  private loadingHandoffPending = false;
  private activeLoad: SceneLoadRequest | null = null;
  private loadSequence = 0;
  private loadQueueGeneration = 0;
  private managerEpoch = 0;
  private loadingTimeoutMs = 120_000;
  private destroyed = false;
  private sceneReady = false;
  private committedScene: SceneData | null = null;
  private lastSafeScene: SafeSceneSnapshot | null = null;
  private loadingScopeId: string | null = null;
  private loadingScopeDepth = 0;
  private deferredLoads: Array<{ run: () => Promise<void>; resolve: () => void; reject: (error: unknown) => void }> = [];
  private queuedLoads = new Set<SceneLoadRequest>();
  private playerPositionGetter: (() => Position) | null = null;
  private cameraSnapshotGetter: (() => unknown) | null = null;
  private cameraSnapshotRestorer: ((snapshot: unknown) => void) | null = null;
  private animRafId: number = 0;
  private transitionAnimResolve: (() => void) | null = null;
  private capturePauseDepth = 0;
  private capturePauseStartedAt = 0;
  private capturePausedMs = 0;
  private captureSteppedMs = 0;
  private captureTransitionTick: (() => void) | null = null;
  private captureBlackoutTick: (() => void) | null = null;
  /**
   * 持久黑幕：独立于切场遮幕 transitionOverlay，只被显式 showBlackout / hideBlackout 控制，
   * 不随过场 cleanup、也不随切场景自动销毁——供把长演出拆成多段时「跨段保留黑屏」，
   * 遮住段与段之间的准备动作（同场景摆位 / 换立绘等），避免穿帮。
   * 纯表现层，不入档（重载后天然无幕）；用独立 rafId，不与切场淡入淡出抢占 animRafId。
   */
  private blackoutOverlay: Graphics | null = null;
  private blackoutRafId: number = 0;
  /** 在途黑幕动画的 resolve 句柄：被新动画打断或销毁时调用它封口，避免 await 悬挂。 */
  private blackoutAnimResolve: (() => void) | null = null;

  /** 当前播放或过场预览绑定的 cutscene id；用于筛选 cutsceneOnly 实体。 */
  private activeCutsceneBindingId: string | null = null;

  /** 由 Game 注入：当前激活位面快照（PlaneReconciler 派生）；未注入时按 normal/shared。 */
  private activePlaneGetter: (() => ActivePlaneSnapshot) | null = null;
  /** 由 Game 注入：NPC 日程在场性（含离场/入场宽限）；未注入时全部在场。 */
  private npcSchedulePresence: ((def: NpcDef) => boolean) | null = null;
  /** 由 Game 注入：当前时段 id（实体 phases 归属判定用）；未注入时不施加限制。 */
  private currentPhaseGetter: (() => string) | null = null;
  /**
   * 本场景**未经时段覆盖**的外观基底 + 时段表。
   *
   * `applySceneAppearance` 是就地改 `sceneData` 的，改完再解析一次会拿夜的背景当基底
   * （越切越偏）。所以进场时先把基底留一份，时段变化时永远从它出发算。
   */
  private appearanceBase: { scene: SceneData; applied: ResolvedSceneAppearance } | null = null;
  /**
   * 由 Game 注入：NPC 未写 `phases` 时的缺省归属（DayManager 从 `phases[].daylight` 派生）。
   * 未注入时不施加限制——本层**刻意不预设任何时段 id**，那正是 2026-08-18
   * 「整条街空无一人」的成因（详见 `dayTime.daylightPhaseIds`）。
   */
  private npcDefaultPhasesGetter: (() => readonly string[]) | null = null;

  private playerPositionSetter: ((x: number, y: number) => void) | null = null;
  private cameraSetter: ((boundsW: number, boundsH: number, snapX: number, snapY: number, cameraConfig?: SceneCameraConfig, worldScale?: number) => void) | null = null;
  private boundsOnlySetter: ((boundsW: number, boundsH: number) => void) | null = null;
  private audioApplier: ((bgm?: AudioCueRef, ambient?: AudioCueRef[], acousticSpace?: string) => void) | null = null;
  private audioManifestResolver: ((bgm?: AudioCueRef, ambient?: AudioCueRef[]) => AssetRef[]) | null = null;
  private zoneSetter: ((zones: import('../data/types').ZoneDef[]) => void) | null = null;
  private interactionSetter: ((hotspots: Hotspot[], npcs: Npc[]) => void) | null = null;
  /** 由 Game 注入：从深度系统摘除并销毁实体滤镜（Game 持有 SceneDepthSystem）。
   *  实体在过场重建 / 卸载时若不摘除，已 destroy 的滤镜仍留在每帧驱动列表里。 */
  private entityFilterReleaser: ((filters: Array<{ destroy(): void }>) => void) | null = null;
  /**
   * 由 Game 注入：运行时生成 / 移除 NPC 的生命周期钩子。
   *
   * 为什么非要这一钩：`instantiateNpc` 只做到 `addChild` 为止，**逐实体光照 / 深度遮挡 /
   * 透视缩放 / 投影阴影 / 像素密度低通全挂在 Game 的 `scene:ready` 循环里**——演出中途
   * 生成的实体不经过那一趟。漏了不报错，只是画面不对：2026-09-12 实测 `playTrajectory`
   * spawn 的铜钱 `filters` 为空、按贴图原像素画、不被木桶挡，而同一枚铜钱 `keep` 下来
   * 重进场景反而正常（装载循环把它塞进 `currentNpcs`，`scene:ready` 顺手就给挂上了）。
   */
  private runtimeNpcHooks: RuntimeNpcHooks | null = null;
  private depthLoader: ((sceneId: string, sceneData: SceneData, worldToPixelX: number, worldToPixelY: number, context?: LoadingRequestContext) => Promise<void>) | null = null;
  /**
   * 统一光影的装载钩子。在 `depthLoader` **之后**调用（那时深度纹理才就绪），
   * 返回一个替代主背景的 mesh；返回 null = 该场景不启用，背景照旧走 Sprite。
   */
  private lightingLoader:
    | ((sceneId: string, sceneData: SceneData, primary: Texture, context?: LoadingRequestContext) => Promise<Container | null>)
    | null = null;
  private lightingUnloader: (() => void) | null = null;
  /** 揭幕前闸，见 {@link setRevealGate} */
  private revealGate: ((sceneId: string, context?: LoadingRequestContext) => Promise<void>) | null = null;
  /**
   * 背景草木摆动的装载钩子（场景风 + 摆动图，见 `rendering/backgroundSway`）。在统一光影**之后**调用：
   * 背景仍是平铺 Sprite 时返回一个替代它的 mesh；点亮的背景自己在 shader 里摆，这里返回 null。
   */
  private swayLoader:
    | ((sceneId: string, sceneData: SceneData, primary: Texture, context?: LoadingRequestContext) => Promise<Container | null>)
    | null = null;
  private swayUnloader: (() => void) | null = null;
  /** 主背景 Sprite 与其纹理（统一光影启用时要把它换掉）。 */
  private primaryBgSprite: Sprite | null = null;
  private primaryBgTexture: Texture | null = null;
  private depthUnloader: (() => void) | null = null;
  /** 场景根 `onEnter` 动作：由 Game 注入 ActionExecutor.executeBatchAwait */
  private sceneEnterRunner: ((actions: ActionDef[]) => Promise<void>) | null = null;
  private currentSceneScopeId: string | null = null;

  private onHotspotPickup: (payload: { hotspotId: string }) => void;
  private onHotspotInspected: (payload: { hotspotId: string }) => void;

  constructor(
    assetManager: AssetManager,
    eventBus: EventBus,
    renderer: Renderer,
  ) {
    this.assetManager = assetManager;
    this.eventBus = eventBus;
    this.renderer = renderer;

    this.onHotspotPickup = (payload) => this.markHotspotPickedUp(payload.hotspotId);
    this.onHotspotInspected = (payload) => this.markHotspotInspected(payload.hotspotId);
  }

  /**
   * 切场进度条的配色。**由 Game 注入而不是直接 import UITheme**——systems 层不能反向依赖
   * ui 层（架构铁律一），但这条进度条又是玩家每次换场都看得见的界面元素，必须跟全站一套色。
   * 不注入就用这里的保守缺省（与主题同色号，只是拷了一份），观感不会退回蓝调 debug 样式。
   */
  setTransitionPalette(p: { track: number; trackBorder: number; fill: number }): void {
    this.transitionPalette = p;
  }

  init(_ctx: GameContext): void {
    this.destroyed = false;
    this.eventBus.on('hotspot:pickup:done', this.onHotspotPickup);
    this.eventBus.on('hotspot:inspected', this.onHotspotInspected);
  }

  update(_dt: number): void {}

  setPlayerPositionSetter(fn: (x: number, y: number) => void): void {
    this.playerPositionSetter = fn;
  }

  setPlayerPositionGetter(fn: (() => Position) | null): void {
    this.playerPositionGetter = fn;
  }

  setCameraSnapshotHooks(getter: (() => unknown) | null, restorer: ((snapshot: unknown) => void) | null): void {
    this.cameraSnapshotGetter = getter;
    this.cameraSnapshotRestorer = restorer;
  }

  setLoadingLifecycle(lifecycle: LoadingLifecycle | null, options?: { timeoutMs?: number }): void {
    this.loadingLifecycle = lifecycle;
    this.configureLoading(options);
  }

  configureLoading(options?: { timeoutMs?: number }): void {
    if (Number.isFinite(options?.timeoutMs) && options!.timeoutMs! > 0) {
      this.loadingTimeoutMs = options!.timeoutMs!;
    }
  }

  waitForLoadingIdle(): Promise<void> { return this.sceneSwitchTail; }

  get isLoading(): boolean { return this.activeLoad !== null || this.loadingScopeId !== null || this.hasQueuedLoads(); }
  get isSceneReady(): boolean { return this.sceneReady && this.activeLoad === null; }
  get hasPendingLoads(): boolean { return this.hasQueuedLoads() || this.deferredLoads.length > 0; }
  get committedSceneData(): SceneData | null { return this.committedScene; }
  get lastSafeSceneSnapshot(): SafeSceneSnapshot | null { return this.lastSafeScene; }

  /** A multi-step restore owns the queue as one operation, without deadlocking its own reloads. */
  acquireLoadingScope(id: string): () => void {
    const owner = id.trim();
    if (!owner) throw new Error('Loading scope requires an owner id');
    if (this.destroyed) throw new Error('SceneManager is destroyed');
    if (this.loadingScopeId && this.loadingScopeId !== owner) throw new Error('Another loading scope already owns the scene queue');
    if (!this.loadingScopeId && this.sceneReady && this.currentScene) {
      this.recordSafeScene(this.currentScene, this.playerPositionGetter?.(), this.cameraSnapshotGetter?.());
    }
    this.loadingScopeId = owner;
    this.loadingScopeDepth++;
    const epoch = this.managerEpoch;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (epoch !== this.managerEpoch || this.loadingScopeId !== owner) return;
      if (--this.loadingScopeDepth > 0) return;
      this.loadingScopeId = null;
      if (this.sceneReady && this.currentScene && this.committedScene === this.currentScene) {
        this.recordSafeScene(this.currentScene, this.playerPositionGetter?.(), this.cameraSnapshotGetter?.());
      }
      const deferred = this.deferredLoads;
      this.deferredLoads = [];
      for (const item of deferred) void item.run().then(item.resolve, item.reject);
    };
  }

  /** Cancels both running work and, by default, requests from the previous timeline. */
  cancelLoading(reason: unknown = new DOMException('Scene loading cancelled', 'AbortError'), cancelQueued = true, replacement = false): void {
    if (cancelQueued) {
      this.loadQueueGeneration++;
      const deferred = this.deferredLoads;
      this.deferredLoads = [];
      for (const item of deferred) item.reject(reason);
    }
    if (this.activeLoad && replacement) this.activeLoad.replacement = true;
    this.activeLoad?.controller.abort(reason);
    this.cancelTransitionAnimation();
  }

  setCameraSetter(fn: (boundsW: number, boundsH: number, snapX: number, snapY: number, cameraConfig?: SceneCameraConfig, worldScale?: number) => void): void {
    this.cameraSetter = fn;
  }

  /** 仅更新相机边界（不 snap），供调试改 world 尺寸时用 */
  setBoundsOnlySetter(fn: (boundsW: number, boundsH: number) => void): void {
    this.boundsOnlySetter = fn;
  }

  setAudioApplier(fn: (bgm?: AudioCueRef, ambient?: AudioCueRef[], acousticSpace?: string) => void): void {
    this.audioApplier = fn;
  }

  setAudioManifestResolver(fn: ((bgm?: AudioCueRef, ambient?: AudioCueRef[]) => AssetRef[]) | null): void {
    this.audioManifestResolver = fn;
  }

  setZoneSetter(fn: (zones: import('../data/types').ZoneDef[]) => void): void {
    this.zoneSetter = fn;
  }

  setInteractionSetter(fn: (hotspots: Hotspot[], npcs: Npc[]) => void): void {
    this.interactionSetter = fn;
  }

  setEntityFilterReleaser(fn: (filters: Array<{ destroy(): void }>) => void): void {
    this.entityFilterReleaser = fn;
  }

  /** 见 {@link runtimeNpcHooks}。 */
  setRuntimeNpcHooks(hooks: RuntimeNpcHooks): void {
    this.runtimeNpcHooks = hooks;
  }

  /** 摘除并销毁热点的深度滤镜（先从深度系统列表移除，再销毁 GPU 资源）。重复调用安全（detach 返回 null）。 */
  private releaseHotspotFilters(h: Hotspot): void {
    const f = h.detachDepthOcclusionFilter();
    if (!f) return;
    if (this.entityFilterReleaser) this.entityFilterReleaser([f]);
    else f.destroy();
  }

  /** 摘除并销毁 NPC 容器上的滤镜，并清空 container.filters。 */
  private releaseNpcFilters(n: Npc): void {
    const filters = n.container.filters as readonly { destroy(): void }[] | null | undefined;
    if (filters && filters.length > 0) {
      if (this.entityFilterReleaser) this.entityFilterReleaser([...filters]);
      else for (const f of filters) f.destroy();
    }
    n.container.filters = [];
  }

  setDepthLoader(fn: (sceneId: string, sceneData: SceneData, worldToPixelX: number, worldToPixelY: number, context?: LoadingRequestContext) => Promise<void>): void {
    this.depthLoader = fn;
  }

  setDepthUnloader(fn: () => void): void {
    this.depthUnloader = fn;
  }

  /**
   * 揭幕前闸：`scene:ready` 之后、`onReveal`（撤遮罩）之前 await。给"必须在遮罩下做完、否则就停在
   * 可见画面上"的活用——粒子 shader、挂件、完整首帧。失败进入事务恢复，整体 watchdog 保证封口。
   */
  setRevealGate(fn: ((sceneId: string, context?: LoadingRequestContext) => Promise<void>) | null): void {
    this.revealGate = fn;
  }

  /** 见 {@link lightingLoader}。 */
  setLightingLoader(
    fn: (sceneId: string, sceneData: SceneData, primary: Texture, context?: LoadingRequestContext) => Promise<Container | null>,
  ): void {
    this.lightingLoader = fn;
  }

  /** 见 {@link swayLoader}。 */
  setSwayLoader(
    fn: (sceneId: string, sceneData: SceneData, primary: Texture, context?: LoadingRequestContext) => Promise<Container | null>,
  ): void {
    this.swayLoader = fn;
  }

  /** 卸载场景时与光影同一拍拆摆动 mesh（先于背景容器与纹理）。 */
  setSwayUnloader(fn: () => void): void {
    this.swayUnloader = fn;
  }

  /** 卸载场景时先拆光影（顺序见 unloadScene 的注释）。 */
  setLightingUnloader(fn: () => void): void {
    this.lightingUnloader = fn;
  }

  setSceneEnterRunner(fn: ((actions: ActionDef[]) => Promise<void>) | null): void {
    this.sceneEnterRunner = fn;
  }

  get currentSceneData() { return this.currentScene; }

  getNpcById(id: string): Npc | null {
    return this.currentNpcs.find(n => n.id === id) ?? null;
  }

  getCurrentNpcs(): readonly Npc[] {
    return this.currentNpcs;
  }

  getCurrentHotspots(): readonly Hotspot[] {
    return this.currentHotspots;
  }

  /** 编辑期标记是否可见（F2 调试面板读它显示当前状态）。 */
  getAuthoringMarkersVisible(): boolean {
    return this.authoringMarkersVisible;
  }

  /**
   * 切换编辑期标记可见性：立即作用于场上实体，并记住状态供后续实例化的实体继承
   * （切场景后仍保持）。仅调试用途，不入存档。
   */
  setAuthoringMarkersVisible(visible: boolean): void {
    this.authoringMarkersVisible = visible;
    for (const npc of this.currentNpcs) npc.setAuthoringMarkersVisible(visible);
    for (const hotspot of this.currentHotspots) hotspot.setAuthoringMarkersVisible(visible);
  }

  /** 当前场景显式分组定义；旧数据仅有成员 group 标签时返回 undefined（按无条件组兼容）。 */
  getCurrentSceneGroup(groupId: string): SceneEntityGroupDef | undefined {
    const gid = groupId.trim();
    if (!gid) return undefined;
    const groups = this.currentScene?.entityGroups;
    if (!Array.isArray(groups)) return undefined;
    return groups.find((g) => g && typeof g.id === 'string' && g.id.trim() === gid);
  }

  /** 供 InteractionSystem / ZoneSystem 读取分组条件；返回定义本身的只读视图，不改写场景。 */
  getCurrentSceneGroupConditions(groupId: string): ConditionExpr[] | undefined {
    return this.getCurrentSceneGroup(groupId)?.conditions;
  }

  /** 分组会话覆盖的统一读取口；空/旧标签缺定义均视为启用。 */
  isCurrentSceneGroupEnabled(groupId: string | undefined): boolean {
    const gid = groupId?.trim() ?? '';
    const sid = this.currentScene?.id?.trim() ?? '';
    return !gid || !sid || !this.groupSessionDisabled.get(sid)?.has(gid);
  }

  /**
   * 未播放过场时为 null；由 Game 在 cutscene:start / cutscene:end 调用。
   */
  setActiveCutsceneBindingId(id: string | null): void {
    const t = id?.trim() || null;
    this.activeCutsceneBindingId = t;
  }

  getActiveCutsceneBindingId(): string | null {
    return this.activeCutsceneBindingId;
  }

  setActivePlaneGetter(fn: (() => ActivePlaneSnapshot) | null): void {
    this.activePlaneGetter = fn;
  }

  /**
   * 由 Game 注入：NPC 此刻是否该在本场景（NpcScheduleSystem 派生，含离场/入场宽限）。
   * 未注入 = 全部在场（无日夜的工程行为逐帧不变）。
   *
   * 刻意**只作用于 NPC**、不并进 `entityInPlane`——后者被 hotspot/zone 共用，
   * 而日程是角色的行踪，热点和区域不该跟着 NPC 走。
   */
  setNpcSchedulePresenceGetter(fn: ((def: NpcDef) => boolean) | null): void {
    this.npcSchedulePresence = fn;
  }

  /**
   * 时段推进后重贴显隐。实体侧纯显隐、无副作用，任何 GameState 都能刷；
   * zone 侧的差分注销会跑 onExit 动作批，故与切位面同规矩——**只在 Exploring 时刷**
   * （`canRefreshZones` 由调用方给出），非探索态挂起、回到探索态由
   * {@link flushPendingTimeZoneRefresh} 补刷。
   *
   * ⚠ 这里必须有自己的挂起位：位面那条路的 `pendingZoneRefresh` 是 `PlaneReconciler`
   * 私有的，只有位面对账会置位。2026-08-26 前本函数的注释声称"留给回到探索态后的下一次
   * 刷新兜底"，而时刻这条路径上**没有任何人置位**——于是过场里跨时段时 zone 的重注册
   * 直接丢失（该消失的区域仍会触发 enter/stay，该出现的区域压根不存在），
   * 一直要等到下一次切位面或重进场景才纠正。
   */
  refreshForTimeChange(sceneId: string, canRefreshZones: boolean): void {
    this.refreshEntitiesForPlaneChange(sceneId);
    if (canRefreshZones) {
      this.pendingTimeZoneRefresh = null;
      this.refreshZonesForPlaneChange(sceneId);
    } else {
      this.pendingTimeZoneRefresh = sceneId;
    }
  }

  /**
   * 补刷非探索态期间挂起的 zone 重注册。由组装层在**探索态、且在 `ZoneSystem.update` 之前**
   * 每帧调一次——晚于它就会让过期集合多跑一帧 enter/stay（与位面那条补刷的排序理由相同）。
   * 没挂起时只是一次判空，零成本。
   */
  flushPendingTimeZoneRefresh(): void {
    const sid = this.pendingTimeZoneRefresh;
    if (!sid) return;
    this.pendingTimeZoneRefresh = null;
    // 场景已经换过了：挂起的那一次针对的是旧场景，新场景进场时已按当前时刻整体建过集合。
    if (this.currentScene?.id !== sid) return;
    this.refreshZonesForPlaneChange(sid);
  }

  /**
   * 实体/zone 是否归属当前激活位面。缺省（无 planes 字段/空数组）由激活位面的世界模型决定：
   * shared（共享世界型）= 存在；exclusive（独立世界型）= 不存在，只有显式归属实体在。
   * 显式 planes 为白名单：须包含激活位面 id。
   */
  private entityInPlane(def: { planes?: string[] }): boolean {
    const planes = def.planes;
    const active = this.activePlaneGetter?.() ?? { id: 'normal', membership: 'shared' as const };
    if (!Array.isArray(planes) || planes.length === 0) return active.membership === 'shared';
    return planes.includes(active.id);
  }

  /**
   * 位面归属判定公开口（与内部 entityInPlane 同口径）。给绕过 ZoneSystem 的
   * zone 消费者用——如 Game.tick 的 depth_floor 偏移直读 sceneData.zones，
   * 不经 shouldRegisterZoneWithZoneSystem 的位面过滤。
   */
  isEntityInActivePlane(def: { planes?: string[] }): boolean {
    return this.entityInPlane(def);
  }

  /**
   * 实体/zone 是否存在于当前时段。与 `planes` 完全同构的**白名单**语义：
   * 缺省（无 phases 字段/空数组）= 所有时段都在（旧数据零影响）。
   *
   * **三级就近取用**（玩法定调见 `docs/玩法功能需求清单.md` H4，2026-08-26 补）：
   * 实体自己写的 → 所属分组写的 → 种类缺省（NPC 传 daylight 清单，热点/zone 不传）。
   * 成员显式写了时再与分组取**交集**（分组是整体限制，与它的 `conditions` 同方向）。
   *
   * 分组这一层是补上来的：在此之前分组只能靠 `conditions` 里的 `{timePhase:…}` 表达时间，
   * 而那条路在条件层、不吃下面那道场景总闸、刷新时机也不同——雾津送葬队伍 13 个 NPC
   * 因此与 NPC 的 daylight 缺省纯 AND 对撞，全天不可见且校验全绿。
   *
   * 与 NPC 日程的分工：日程管「这个**角色**此刻该在哪个场景」（有作息的具名角色），
   * phases 管「这个**实体**在哪些时段存在」（整条街的群演、夜里收走的摊子热点）。
   * 群演用日程表要给每个路人造 characterId + 一张表，那是拿错工具。
   *
   * 注意本判定**没有**离场宽限：它是瞬时的存在性开关，配合有遮挡的推进用。
   * 要让 NPC 走出去再消失，那是日程的活。
   */
  private entityInPhase(
    def: { phases?: string[]; group?: string },
    fallback?: readonly string[],
  ): boolean {
    // 场景没开日夜 = 时段归属整套不生效（否则旧场景一到夜里就空了）
    if (this.currentScene?.dayNight?.enabled !== true) return true;
    // 三级就近取用（自己 → 组 → 种类缺省）+ 组是整体限制。公式是纯函数，编辑器镜像同一份。
    return isEntityInPhaseWithGroup(
      def.phases,
      this.currentSceneGroupPhases(def.group),
      this.currentPhaseGetter?.() ?? '',
      fallback,
    );
  }

  /**
   * 所属分组的时段归属；无组 / 组无定义 / 空数组一律 `undefined`（= 不施加限制）。
   *
   * 分组**没有** NPC 那条「只在 daylight 段」的缺省：它是异构容器，可能同时装着人和门，
   * 借用 NPC 的缺省会让一个装着门和路牌的组夜里整组消失。
   */
  private currentSceneGroupPhases(groupId: string | undefined): string[] | undefined {
    const raw = this.getCurrentSceneGroup(groupId ?? '')?.phases;
    return Array.isArray(raw) && raw.length > 0 ? raw : undefined;
  }

  /** 由 Game 注入当前时段 id（DayManager 派生）；未注入时 phases 归属不生效。 */
  setCurrentPhaseGetter(fn: (() => string) | null): void {
    this.currentPhaseGetter = fn;
  }

  /**
   * 切到 `nextPhase` 后，本场景的外观**会不会真的变**。
   *
   * 用来决定要不要为一次时段推进付一次场景重载。两个时段配了同一张图、同一份环境时
   * 返回 false —— 不为「时段名变了」白白重载一次背景纹理与烘焙载荷。
   * 没开日夜 / 没进过场景一律 false。
   */
  appearanceChangesWithPhase(nextPhase: string): boolean {
    const b = this.appearanceBase;
    if (!b) return false;
    return !sameAppearance(b.applied, resolveSceneAppearance(b.scene, nextPhase));
  }

  /**
   * 本场景**不带时段覆盖**的外观（顶层白天基底）。场景加载一开始就留好，所以加载链上的
   * 各个装载器（深度 / 光照 / 摆动）都能拿它比"这个时段到底换了哪几样"。没进过场景 null。
   */
  get baseAppearance(): ResolvedSceneAppearance | null {
    const b = this.appearanceBase;
    return b ? resolveSceneAppearance(b.scene, '') : null;
  }

  /**
   * 本场景在 `phase` 时段用**哪套外观**：`timeVariants` 的键，空串 = 顶层基底。没进过场景 null。
   *
   * 粒子布置按它取份（`VfxPlacementLibrary`）。刻意按**时段现算**而不是读 `appearanceBase.applied.phase`：
   * 两个时段配了等价外观时换装不重载，`applied` 就停在前一个时段名上，布置会取错那一份。
   */
  appearancePhaseFor(phase: string): string | null {
    const b = this.appearanceBase;
    return b ? resolveSceneAppearance(b.scene, phase).phase : null;
  }

  /**
   * 由 Game 注入「NPC 未写 `phases` 时算在哪几段」（DayManager 从 `daylight` 标记派生）。
   * 未注入 / 返回空数组时不施加限制（全时段都在）——宁可街上多几个人，绝不静默清空。
   */
  setNpcDefaultPhasesGetter(fn: (() => readonly string[]) | null): void {
    this.npcDefaultPhasesGetter = fn;
  }

  /**
   * 根据 cutsceneOnly/shared/普通实体 + 位面归属语义刷新当前已加载实体显隐。
   * 判定委托 getHotspotBaseEnabledForInteraction / getNpcBaseVisibleForInteraction
   * （派生基底的唯一真源），保证与 InteractionSystem 每帧回写口径一致、不漂移。
   */
  private refreshCutsceneBoundEntityVisibility(): void {
    for (const h of this.currentHotspots) {
      h.setDerivedBaseEnabled(this.getHotspotBaseEnabledForInteraction(h));
    }

    for (const n of this.currentNpcs) {
      n.setDerivedBaseVisible(this.getNpcBaseVisibleForInteraction(n));
    }
  }

  /** 切位面后的统一刷新（实体+zone）。zone 侧有动作副作用约束，见 refreshZonesForPlaneChange。 */
  refreshForPlaneChange(sceneId: string): void {
    this.refreshEntitiesForPlaneChange(sceneId);
    this.refreshZonesForPlaneChange(sceneId);
  }

  /** 切位面·实体侧：批量重贴派生基底显隐。纯显隐无动作副作用，任何 GameState 下可调。 */
  refreshEntitiesForPlaneChange(sceneId: string): void {
    const sid = sceneId.trim();
    if (!sid || this.currentScene?.id !== sid) return;
    this.refreshCutsceneBoundEntityVisibility();
  }

  /**
   * 切位面·zone 侧：按位面归属重注册 zones（ZoneSystem.setZones 差分更新，因位面消失的
   * zone 正常走 exitZone/onExit）。调用方（PlaneReconciler）保证仅在 Exploring 态调用——
   * 过场策略栈会吞掉 onExit 里的改存档动作且不补发。仅对当前已加载场景生效。
   */
  refreshZonesForPlaneChange(sceneId: string): void {
    const sid = sceneId.trim();
    if (!sid || this.currentScene?.id !== sid) return;
    this.refreshZonesAfterRuntimeChange(sid);
  }

  /**
   * 供 Action（setEntityEnabled）接线：会话级实体显隐（不写档）。
   * enabled=false 写 override 通道并即时应用到活实例；enabled=true 清除覆盖，
   * 显隐回落到派生基底（sceneMemory / 过场绑定 / 条件）决定。
   */
  setEntitySessionEnabled(kind: SceneEntityKind, entityId: string, enabled: boolean): boolean {
    const sceneId = this.currentScene?.id;
    const id = entityId.trim();
    if (!sceneId || !id) {
      console.warn('SceneManager.setEntitySessionEnabled: 无当前场景或空 entityId');
      return false;
    }
    let bucket = this.entitySessionOverrides.get(sceneId);
    if (enabled) {
      if (bucket) {
        bucket[kind === 'npc' ? 'npcs' : 'hotspots'].delete(id);
        if (bucket.npcs.size === 0 && bucket.hotspots.size === 0) {
          this.entitySessionOverrides.delete(sceneId);
        }
      }
    } else {
      if (!bucket) {
        bucket = { npcs: new Set(), hotspots: new Set() };
        this.entitySessionOverrides.set(sceneId, bucket);
      }
      bucket[kind === 'npc' ? 'npcs' : 'hotspots'].add(id);
    }
    const override = enabled ? null : false;
    if (kind === 'npc') {
      this.currentNpcs.find((n) => n.def.id === id)?.setSessionEnabledOverride(override);
    } else {
      this.currentHotspots.find((h) => h.def.id === id)?.setSessionEnabledOverride(override);
    }
    return true;
  }

  /** 实体实例化时从会话桶恢复运行态覆盖（不入档；重进场景/过场重建同会话内保持）。 */
  private applySessionOverrideOnInstantiate(kind: SceneEntityKind, entity: Hotspot | Npc): void {
    const sceneId = this.currentScene?.id;
    if (!sceneId) return;
    const bucket = this.entitySessionOverrides.get(sceneId);
    if (!bucket) return;
    const hidden = kind === 'npc' ? bucket.npcs : bucket.hotspots;
    if (hidden.has(entity.def.id)) {
      entity.setSessionEnabledOverride(false);
    }
  }

  /**
   * InteractionSystem 中与位面归属、过场绑定、sceneMemory.enabled 一致的基础显隐（不含触发条件图层）。
   */
  getHotspotBaseEnabledForInteraction(hotspot: Hotspot): boolean {
    if (!this.entityInPlane(hotspot.def)) return false;
    if (!this.entityInPhase(hotspot.def)) return false;
    if (!this.isCurrentSceneGroupEnabled(hotspot.def.group)) return false;
    const active = this.activeCutsceneBindingId?.trim() || null;
    const sceneId = this.currentScene?.id ?? '';
    if (isCutsceneOnlyEntity(hotspot.def)) {
      return isEntityBoundToCutscene(hotspot.def, active);
    }
    const snap = sceneId
      ? this.getEntityRuntimeOverrideForDef(sceneId, 'hotspot', hotspot.def.id, hotspot.def)
      : undefined;
    if (typeof snap?.enabled === 'boolean') return snap.enabled;
    return true;
  }

  /** 与 {@link getHotspotBaseEnabledForInteraction} 对偶，用于 NPC container.visible 基底。 */
  getNpcBaseVisibleForInteraction(npc: Npc): boolean {
    if (!this.entityInPlane(npc.def)) return false;
    // NPC 未写 phases = 只在标了 daylight 的那几段出没（内容定调）；热点/zone 不吃这个缺省。
    // 缺省清单由内容侧的时段表派生，本层不认任何时段 id——写死 id 会在内容换词表时恒假。
    if (!this.entityInPhase(npc.def, this.npcDefaultPhasesGetter?.())) return false;
    // 日程：不在这个时段/这个场景就不在场。正在走向出口的 NPC 由宽限集判为在场，
    // 故这条不会在它走到一半时把它抹掉（见 NpcScheduleSystem 的两条路径说明）。
    if (this.npcSchedulePresence && !this.npcSchedulePresence(npc.def)) return false;
    if (!this.isCurrentSceneGroupEnabled(npc.def.group)) return false;
    const active = this.activeCutsceneBindingId?.trim() || null;
    const sceneId = this.currentScene?.id ?? '';
    if (isCutsceneOnlyEntity(npc.def)) {
      return isEntityBoundToCutscene(npc.def, active);
    }
    const snap = sceneId
      ? this.getEntityRuntimeOverrideForDef(sceneId, 'npc', npc.def.id, npc.def)
      : undefined;
    if (snap && typeof snap.enabled === 'boolean') return snap.enabled;
    return true;
  }

  /** 供 Action：会话级开关 standard zone（不写档）。`enabled === false` 时从 ZoneSystem Unregister 该 id。 */
  setZoneEnabledSession(sceneId: string, zoneId: string, enabled: boolean): void {
    const sid = sceneId.trim();
    const zid = zoneId.trim();
    if (!sid || !zid) {
      console.warn('setZoneEnabledSession: sceneId 与 zoneId 不能为空');
      return;
    }
    if (this.resolveZoneKind(sid, zid) === 'depth_floor') {
      console.warn(`setZoneEnabledSession: zone "${zid}" 为 depth_floor，忽略`);
      return;
    }
    if (enabled) {
      const s = this.zoneSessionDisabled.get(sid);
      s?.delete(zid);
      if (s && s.size === 0) this.zoneSessionDisabled.delete(sid);
    } else {
      let bucket = this.zoneSessionDisabled.get(sid);
      if (!bucket) {
        bucket = new Set();
        this.zoneSessionDisabled.set(sid, bucket);
      }
      bucket.add(zid);
    }
    this.refreshZonesAfterRuntimeChange(sid);
  }

  /**
   * 场景分组会话开关：统一作用于 NPC / Hotspot 的派生基底与 Zone 的注册通道。
   * 返回当前场景中命中的成员数，供 Action 在空组时给出诊断。
   */
  setGroupSessionEnabled(groupId: string, enabled: boolean): number {
    const sid = this.currentScene?.id?.trim() ?? '';
    const gid = groupId.trim();
    if (!sid || !gid) return 0;
    let bucket = this.groupSessionDisabled.get(sid);
    if (enabled) {
      bucket?.delete(gid);
      if (bucket && bucket.size === 0) this.groupSessionDisabled.delete(sid);
    } else {
      if (!bucket) {
        bucket = new Set();
        this.groupSessionDisabled.set(sid, bucket);
      }
      bucket.add(gid);
    }
    this.refreshCutsceneBoundEntityVisibility();
    this.refreshZonesAfterRuntimeChange(sid);
    return this.countCurrentSceneGroupMembers(gid);
  }

  /**
   * 场景组位移统一入口。NPC 可按 speed 异步移动；Hotspot 与 Zone 多边形即时平移。
   * 与既有动作一致属于会话内演出位移，不写 sceneMemory。
   */
  async moveCurrentSceneGroupBy(groupId: string, dx: number, dy: number, speed: number): Promise<number> {
    const gid = groupId.trim();
    if (!gid) return 0;
    const moves: Promise<void>[] = [];
    let hit = 0;
    for (const npc of this.currentNpcs) {
      if (String(npc.def.group ?? '').trim() !== gid) continue;
      hit++;
      if (Number.isFinite(speed) && speed > 0) {
        // 组位移沿用"走向哪就朝哪"：显式 faceTowardMovement（moveTo 不勾选＝完全不碰朝向）
        moves.push(npc.moveTo(npc.x + dx, npc.y + dy, speed, undefined, true));
      } else {
        npc.x += dx;
        npc.y += dy;
      }
    }
    for (const hotspot of this.currentHotspots) {
      if (String(hotspot.def.group ?? '').trim() !== gid) continue;
      hit++;
      hotspot.setPosition(hotspot.centerX + dx, hotspot.centerY + dy);
    }
    for (const zone of this.currentScene?.zones ?? []) {
      if (String(zone.group ?? '').trim() !== gid) continue;
      hit++;
      zone.polygon = zone.polygon.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    }
    if (moves.length > 0) await Promise.all(moves);
    return hit;
  }

  private countCurrentSceneGroupMembers(groupId: string): number {
    const gid = groupId.trim();
    if (!gid) return 0;
    let hit = 0;
    for (const npc of this.currentNpcs) {
      if (String(npc.def.group ?? '').trim() === gid) hit++;
    }
    for (const hotspot of this.currentHotspots) {
      if (String(hotspot.def.group ?? '').trim() === gid) hit++;
    }
    for (const zone of this.currentScene?.zones ?? []) {
      if (String(zone.group ?? '').trim() === gid) hit++;
    }
    return hit;
  }

  /**
   * 供 Action：将 standard zone 的启用状态写入 sceneMemory（随存档）。
   * `enabled === true` 时移除该 zone 的存档覆盖；`false` 时写入 enabled false。
   */
  mergePersistentZoneEnabled(sceneId: string, zoneId: string, enabled: boolean): void {
    const sid = sceneId.trim();
    const zid = zoneId.trim();
    if (!sid || !zid) {
      console.warn('mergePersistentZoneEnabled: sceneId 与 zoneId 不能为空');
      return;
    }
    if (this.resolveZoneKind(sid, zid) === 'depth_floor') {
      console.warn(`mergePersistentZoneEnabled: zone "${zid}" 为 depth_floor，忽略`);
      return;
    }
    const mem = this.getWritableMemory(sid);
    if (!mem) {
      console.warn(`mergePersistentZoneEnabled: 无法写入 sceneMemory (${sid})`);
      return;
    }
    if (!mem.entityOverrides.zones) mem.entityOverrides.zones = {};
    if (enabled) {
      delete mem.entityOverrides.zones[zid];
    } else {
      mem.entityOverrides.zones[zid] = { enabled: false };
    }
    this.refreshZonesAfterRuntimeChange(sid);
  }

  private resolveZoneKind(sceneId: string, zoneId: string): 'standard' | 'depth_floor' | undefined {
    const z = this.findZoneDefInScene(sceneId, zoneId);
    if (!z) return undefined;
    return z.zoneKind === 'depth_floor' ? 'depth_floor' : 'standard';
  }

  private findZoneDefInScene(sceneId: string, zoneId: string): ZoneDef | undefined {
    const sid = sceneId.trim();
    const zid = zoneId.trim();
    if (!sid || !zid) return undefined;
    const sc = this.currentScene?.id === sid ? this.currentScene : null;
    return sc?.zones?.find((z) => z.id.trim() === zid);
  }

  private getMergedZoneOverride(sceneId: string, zoneId: string): { enabled?: boolean } | undefined {
    const sid = sceneId.trim();
    const zid = zoneId.trim();
    const committed = this.getCommittedMemory(sid)?.entityOverrides?.zones?.[zid];
    const staging =
      this.cutsceneStaging?.sceneId === sid
        ? this.cutsceneStaging.memory.entityOverrides?.zones?.[zid]
        : undefined;
    if (!committed && !staging) return undefined;
    return { ...(committed as object | undefined), ...(staging as object | undefined) } as {
      enabled?: boolean;
    };
  }

  private computeEffectiveZones(sceneId: string, raw: ZoneDef[] | undefined): ZoneDef[] {
    const list = raw ?? [];
    return list.filter((z) => this.shouldRegisterZoneWithZoneSystem(sceneId, z));
  }

  private shouldRegisterZoneWithZoneSystem(sceneId: string, z: ZoneDef): boolean {
    if (!this.entityInPlane(z)) return false;
    if (!this.entityInPhase(z)) return false;
    if (!this.isCurrentSceneGroupEnabled(z.group)) return false;
    if (z.zoneKind === 'depth_floor') return true;
    const sid = sceneId.trim();
    const zid = z.id.trim();
    if (!zid) return false;
    if (this.zoneSessionDisabled.get(sid)?.has(zid)) return false;
    const snap = this.getMergedZoneOverride(sid, zid);
    if (snap?.enabled === false) return false;
    return true;
  }

  private refreshZonesAfterRuntimeChange(sceneId: string): void {
    const sid = sceneId.trim();
    if (!this.zoneSetter || this.currentScene?.id !== sid) return;
    this.zoneSetter(this.computeEffectiveZones(sid, this.currentScene.zones));
  }

  get switching(): boolean {
    return this.isSwitching;
  }

  /** Initial and subsequent scene loads must settle before acquiring a capture freeze. */
  get captureSceneReady(): boolean {
    return this.isSceneReady && !this.isLoading && !this.isSwitching && this.transitionOverlay === null;
  }

  /**
   * 画面此刻是否被系统级遮蔽（切场/加载过渡遮罩、显式持久黑幕任一在场）。
   * 给「玩家自由可控」判据用（2026-08-18 拍板：Esc 菜单只在自由可控时能出——
   * 加载遮罩下 state 仍是 Exploring，光看状态机会漏掉这扇窗）。
   * 初始进场与 switchScene 都走 transitionOverlay，揭幕收尾销毁它；黑幕独立显隐。
   */
  get viewObscured(): boolean {
    return this.isLoading || this.transitionOverlay !== null || this.blackoutOverlay !== null;
  }

  private emptyEntityOverrides(): SceneEntityRuntimeOverrides {
    return { npcs: {}, hotspots: {}, zones: {} };
  }

  private createEmptyMemory(): SceneMemory {
    return {
      inspectedHotspots: [],
      pickedUpHotspots: [],
      entityOverrides: this.emptyEntityOverrides(),
      spawnedNpcs: {},
    };
  }

  private normalizeMemory(mem: SceneMemory): SceneMemory {
    if (!mem.entityOverrides) mem.entityOverrides = this.emptyEntityOverrides();
    if (!mem.entityOverrides.npcs) mem.entityOverrides.npcs = {};
    if (!mem.entityOverrides.hotspots) mem.entityOverrides.hotspots = {};
    if (!mem.entityOverrides.zones) mem.entityOverrides.zones = {};
    if (!mem.inspectedHotspots) mem.inspectedHotspots = [];
    if (!mem.pickedUpHotspots) mem.pickedUpHotspots = [];
    if (!mem.spawnedNpcs) mem.spawnedNpcs = {};
    return mem;
  }

  private ensureSceneMemory(sceneId: string): SceneMemory {
    let mem = this.sceneMemory.get(sceneId);
    if (!mem) {
      mem = this.createEmptyMemory();
      this.sceneMemory.set(sceneId, mem);
    }
    return this.normalizeMemory(mem);
  }

  beginCutsceneStaging(cutsceneId: string, sceneId: string): void {
    const cid = cutsceneId.trim();
    const sid = sceneId.trim();
    if (!cid || !sid) {
      console.warn('SceneManager.beginCutsceneStaging: cutsceneId/sceneId 不能为空');
      return;
    }
    this.cutsceneStaging = {
      cutsceneId: cid,
      sceneId: sid,
      memory: this.createEmptyMemory(),
    };
    this.setActiveCutsceneBindingId(cid);
  }

  endCutsceneStaging(): void {
    this.cutsceneStaging = null;
    this.setActiveCutsceneBindingId(null);
  }

  async enterCutsceneInstancesForCurrent(cutsceneId: string): Promise<void> {
    const scene = this.currentScene;
    if (!scene) return;
    const sceneId = scene.id;
    // instantiate 的 await 间隙可能与并发卸载/切场竞态：世代号变化即中止并销毁刚建的孤儿实例
    const epoch = this.sceneEpoch;
    const rebuiltHotspotIds: string[] = [];
    const rebuiltNpcIds: string[] = [];

    if (scene.hotspots) {
      for (const def of scene.hotspots) {
        if (!isEntityBoundToCutscene(def, cutsceneId)) continue;
        // destroy existing outer instance
        const idx = this.currentHotspots.findIndex(h => h.def.id === def.id);
        if (idx >= 0) {
          const h = this.currentHotspots[idx];
          this.releaseHotspotFilters(h);
          this.renderer.entityLayer.removeChild(h.container);
          h.destroy();
          this.currentHotspots.splice(idx, 1);
        }
        // re-instantiate with cutscene context
        const ovr = this.getRuntimeOverrideForContext(sceneId, 'hotspot', def.id, def, 'cutscene');
        const hotspot = await this.instantiateHotspot(def, ovr as HotspotRuntimeOverride | undefined);
        if (this.commitRebuiltEntityOrDiscard(hotspot, epoch, this.currentHotspots, rebuiltHotspotIds, def.id)) {
          return;
        }
      }
    }
    if (scene.npcs) {
      for (const npcDef of scene.npcs) {
        if (!isEntityBoundToCutscene(npcDef, cutsceneId)) continue;
        // destroy existing outer instance
        const idx = this.currentNpcs.findIndex(n => n.def.id === npcDef.id);
        if (idx >= 0) {
          const n = this.currentNpcs[idx];
          this.releaseNpcFilters(n);
          this.renderer.entityLayer.removeChild(n.container);
          n.destroy();
          this.currentNpcs.splice(idx, 1);
        }
        // re-instantiate with cutscene context
        const snap = this.getRuntimeOverrideForContext(sceneId, 'npc', npcDef.id, npcDef, 'cutscene') as NpcRuntimeOverride | undefined;
        const npc = await this.instantiateNpc(npcDef, snap);
        if (this.commitRebuiltEntityOrDiscard(npc, epoch, this.currentNpcs, rebuiltNpcIds, npcDef.id)) {
          return;
        }
      }
    }
    this.interactionSetter?.(this.currentHotspots, this.currentNpcs);
    this.emitEntitiesRebuilt(cutsceneId, 'enter', rebuiltHotspotIds, rebuiltNpcIds);
  }

  async exitCutsceneInstancesForCurrent(cutsceneId: string): Promise<void> {
    const scene = this.currentScene;
    if (!scene) return;
    const sceneId = scene.id;
    const committedMemory = this.getCommittedMemory(sceneId);
    const epoch = this.sceneEpoch;
    const rebuiltHotspotIds: string[] = [];
    const rebuiltNpcIds: string[] = [];

    if (scene.hotspots) {
      for (const def of scene.hotspots) {
        if (!isEntityBoundToCutscene(def, cutsceneId)) continue;
        // destroy cutscene instance
        const idx = this.currentHotspots.findIndex(h => h.def.id === def.id);
        if (idx >= 0) {
          const h = this.currentHotspots[idx];
          this.releaseHotspotFilters(h);
          this.renderer.entityLayer.removeChild(h.container);
          h.destroy();
          this.currentHotspots.splice(idx, 1);
        }
        // B-type (cutsceneOnly:false): rebuild outer instance
        if (!isCutsceneOnlyEntity(def)) {
          if (committedMemory?.pickedUpHotspots.includes(def.id)) continue;
          const ovr = this.getRuntimeOverrideForContext(sceneId, 'hotspot', def.id, def, 'outer');
          if (ovr?.enabled === false) continue;
          const hotspot = await this.instantiateHotspot(def, ovr as HotspotRuntimeOverride | undefined);
          if (this.commitRebuiltEntityOrDiscard(hotspot, epoch, this.currentHotspots, rebuiltHotspotIds, def.id)) {
            return;
          }
        }
      }
    }
    if (scene.npcs) {
      for (const npcDef of scene.npcs) {
        if (!isEntityBoundToCutscene(npcDef, cutsceneId)) continue;
        // destroy cutscene instance
        const idx = this.currentNpcs.findIndex(n => n.def.id === npcDef.id);
        if (idx >= 0) {
          const n = this.currentNpcs[idx];
          this.releaseNpcFilters(n);
          this.renderer.entityLayer.removeChild(n.container);
          n.destroy();
          this.currentNpcs.splice(idx, 1);
        }
        // B-type (cutsceneOnly:false): rebuild outer instance
        if (!isCutsceneOnlyEntity(npcDef)) {
          const snap = this.getRuntimeOverrideForContext(sceneId, 'npc', npcDef.id, npcDef, 'outer') as NpcRuntimeOverride | undefined;
          const npc = await this.instantiateNpc(npcDef, snap);
          if (this.commitRebuiltEntityOrDiscard(npc, epoch, this.currentNpcs, rebuiltNpcIds, npcDef.id)) {
            return;
          }
        }
      }
    }
    this.interactionSetter?.(this.currentHotspots, this.currentNpcs);
    this.emitEntitiesRebuilt(cutsceneId, 'exit', rebuiltHotspotIds, rebuiltNpcIds);
  }

  /**
   * 实例化 await 后统一的世代守卫：若 sceneEpoch 已变（并发卸载/切场），
   * 销毁刚建的孤儿实例并返回 true（调用方据此 return 中止整个重建）；
   * 否则将实例登记进 sink + idSink 并返回 false（继续重建）。
   * 收拢四处（hotspot/npc × enter/exit）逐字复制的守卫，语义完全一致。
   */
  private commitRebuiltEntityOrDiscard<T extends { destroy(): void }>(
    entity: T,
    epoch: number,
    sink: T[],
    idSink: string[],
    id: string,
  ): boolean {
    if (this.sceneEpoch !== epoch) {
      entity.destroy();
      return true;
    }
    sink.push(entity);
    idSink.push(id);
    return false;
  }

  /**
   * 过场进入/退出重建实体后广播，供 Game 重挂深度滤镜/像素密度/巡逻
   * （重建的是全新实例，scene:ready 时附加的滤镜与巡逻协程都随旧实例销毁了）。
   */
  private emitEntitiesRebuilt(
    cutsceneId: string,
    phase: 'enter' | 'exit',
    hotspotIds: string[],
    npcIds: string[],
  ): void {
    if (hotspotIds.length === 0 && npcIds.length === 0) return;
    this.eventBus.emit('scene:entitiesRebuilt', { cutsceneId, phase, hotspotIds, npcIds });
  }

  isCutsceneStagingActive(): boolean {
    return this.cutsceneStaging !== null;
  }

  getActiveCutsceneStagingSceneId(): string | null {
    return this.cutsceneStaging?.sceneId ?? null;
  }

  getActiveCutsceneStagingId(): string | null {
    return this.cutsceneStaging?.cutsceneId ?? null;
  }

  private getCommittedMemory(sceneId: string): SceneMemory | undefined {
    const mem = this.sceneMemory.get(sceneId);
    return mem ? this.normalizeMemory(mem) : undefined;
  }

  private getWritableMemory(sceneId: string): SceneMemory | null {
    if (this.cutsceneStaging) {
      if (sceneId !== this.cutsceneStaging.sceneId) {
        console.warn(
          `SceneManager: 过场中忽略跨场景 sceneMemory 写入 "${sceneId}"（当前过场场景 "${this.cutsceneStaging.sceneId}"）`,
        );
        return null;
      }
      return this.normalizeMemory(this.cutsceneStaging.memory);
    }
    return this.ensureSceneMemory(sceneId);
  }

  private findEntityDef(
    sceneId: string,
    kind: SceneEntityKind,
    entityId: string,
  ): CutsceneBindableEntityDef | undefined {
    if (this.currentScene?.id !== sceneId) return undefined;
    return kind === 'npc'
      ? this.currentScene.npcs?.find(n => n.id === entityId)
      : this.currentScene.hotspots?.find(h => h.id === entityId);
  }

  private isCurrentCutsceneOnlyEntity(sceneId: string, kind: SceneEntityKind, entityId: string): boolean {
    const def = this.findEntityDef(sceneId, kind, entityId);
    return !!def && isCutsceneOnlyEntity(def);
  }

  private getEntityRuntimeOverrideForDef(
    sceneId: string,
    kind: SceneEntityKind,
    entityId: string,
    def: CutsceneBindableEntityDef,
  ): NpcRuntimeOverride | HotspotRuntimeOverride | undefined {
    const committed = isCutsceneOnlyEntity(def)
      ? undefined
      : this.getCommittedMemory(sceneId)?.entityOverrides?.[kind === 'npc' ? 'npcs' : 'hotspots']?.[entityId];
    const staging = this.cutsceneStaging?.sceneId === sceneId
      ? this.cutsceneStaging.memory.entityOverrides?.[kind === 'npc' ? 'npcs' : 'hotspots']?.[entityId]
      : undefined;
    if (!committed && !staging) return undefined;
    return { ...(committed as object | undefined), ...(staging as object | undefined) } as NpcRuntimeOverride | HotspotRuntimeOverride;
  }

  private getRuntimeOverrideForContext(
    sceneId: string,
    kind: SceneEntityKind,
    entityId: string,
    _def: CutsceneBindableEntityDef,
    context: 'outer' | 'cutscene',
  ): NpcRuntimeOverride | HotspotRuntimeOverride | undefined {
    const bucket = kind === 'npc' ? 'npcs' : 'hotspots';
    if (context === 'outer') {
      return this.getCommittedMemory(sceneId)?.entityOverrides?.[bucket]?.[entityId] as
        NpcRuntimeOverride | HotspotRuntimeOverride | undefined;
    }
    // cutscene context: only staging memory
    if (this.cutsceneStaging?.sceneId === sceneId) {
      return this.cutsceneStaging.memory.entityOverrides?.[bucket]?.[entityId] as
        NpcRuntimeOverride | HotspotRuntimeOverride | undefined;
    }
    return undefined;
  }

  /**
   * 记录某场景某热点展示图运行态（供非当前图 setHotspotDisplayImage 或进图时合并）。
   */
  mergeHotspotDisplayImageOverride(
    sceneId: string,
    hotspotId: string,
    di: HotspotDisplayImage,
  ): void {
    this.setEntityRuntimeField(sceneId, 'hotspot', hotspotId, 'displayImage', di);
  }

  setEntityRuntimeField(
    sceneId: string,
    kind: SceneEntityKind,
    entityId: string,
    fieldName: string,
    rawValue: unknown,
  ): { ok: true; value: SceneEntityRuntimeValue } | { ok: false; error: string } {
    const sid = sceneId.trim();
    const id = entityId.trim();
    const field = fieldName.trim();
    if (!sid || !id || !field) {
      return { ok: false, error: 'setEntityRuntimeField: sceneId/entityId/fieldName 不能为空' };
    }
    const coerced = coerceRuntimeFieldValue(kind, field, rawValue);
    if (!coerced.ok) return coerced;
    if (!this.cutsceneStaging && this.isCurrentCutsceneOnlyEntity(sid, kind, id)) {
      return { ok: false, error: `setEntityRuntimeField: ${kind}.${id} 是仅过场实体，普通上下文不写 committed sceneMemory` };
    }
    const mem = this.getWritableMemory(sid);
    if (!mem) return { ok: false, error: `setEntityRuntimeField: 过场中忽略跨场景写入 ${sid}` };
    const bucket = kind === 'npc' ? mem.entityOverrides.npcs : mem.entityOverrides.hotspots;
    const prev = bucket[id] ?? {};
    bucket[id] = { ...prev, [field]: coerced.value };
    return { ok: true, value: coerced.value };
  }

  getEntityRuntimeOverride(
    sceneId: string,
    kind: SceneEntityKind,
    entityId: string,
  ): NpcRuntimeOverride | HotspotRuntimeOverride | undefined {
    const def = this.findEntityDef(sceneId, kind, entityId);
    if (def) return this.getEntityRuntimeOverrideForDef(sceneId, kind, entityId, def);
    const mem = this.getCommittedMemory(sceneId);
    const staging = this.cutsceneStaging?.sceneId === sceneId ? this.cutsceneStaging.memory : undefined;
    const committed = kind === 'npc' ? mem?.entityOverrides.npcs?.[entityId] : mem?.entityOverrides.hotspots?.[entityId];
    const staged = kind === 'npc' ? staging?.entityOverrides.npcs?.[entityId] : staging?.entityOverrides.hotspots?.[entityId];
    if (!committed && !staged) return undefined;
    return { ...(committed as object | undefined), ...(staged as object | undefined) } as NpcRuntimeOverride | HotspotRuntimeOverride;
  }

  /**
   * 合并当前场景内某 NPC 的持久快照（仅 `persistNpc*` Action 应调用）。
   * 不写场景 JSON；随 `sceneMemory` 进存档。
   */
  mergePersistentNpcState(npcId: string, patch: Partial<NpcPersistentSnapshot>): void {
    const sceneId = this.currentScene?.id;
    if (!sceneId) {
      console.warn('SceneManager.mergePersistentNpcState: 无当前场景');
      return;
    }
    const id = npcId.trim();
    if (!id) {
      console.warn('SceneManager.mergePersistentNpcState: 空 npcId');
      return;
    }
    if (!this.cutsceneStaging && this.isCurrentCutsceneOnlyEntity(sceneId, 'npc', id)) {
      console.warn(`SceneManager.mergePersistentNpcState: "${id}" 是仅过场 NPC，普通上下文不写 committed sceneMemory`);
      return;
    }
    const mem = this.getWritableMemory(sceneId);
    if (!mem) return;
    const prev = mem.entityOverrides.npcs[id] ?? {};
    mem.entityOverrides.npcs[id] = { ...prev, ...patch };
  }

  /** 再次进入场景时是否不应启动该 NPC 的巡逻 */
  isNpcPatrolPersistentlyDisabled(npcId: string): boolean {
    const sid = this.currentScene?.id;
    if (!sid) return false;
    const mem = this.getCommittedMemory(sid);
    return mem?.entityOverrides?.npcs?.[npcId]?.patrolDisabled === true;
  }

  /**
   * 调试：在内存中修改当前场景的 worldWidth / worldHeight（不写 JSON）。
   * 重算背景精灵缩放与相机边界；热点/NPC 世界坐标不变。
   */
  applyDebugWorldSize(width: number, height: number): ApplyDebugWorldSizeResult {
    const scene = this.currentScene;
    const bg = this.sceneContainerBg;
    if (!scene || !bg || !Number.isFinite(width) || !Number.isFinite(height)) return { ok: false };

    const minSz = 50;
    const maxSz = 10_000_000;
    const w = Math.max(minSz, Math.min(maxSz, width));
    const h = Math.max(minSz, Math.min(maxSz, height));

    const oldW = scene.worldWidth;
    const oldH = scene.worldHeight;
    if (oldW <= 0 || oldH <= 0) return { ok: false };

    scene.worldWidth = w;
    scene.worldHeight = h;

    let worldToPixelX = 1;
    let worldToPixelY = 1;

    let foundSprite = false;
    for (const child of bg.children) {
      if (child instanceof Sprite && child.texture?.width > 0 && child.texture?.height > 0) {
        foundSprite = true;
        child.scale.set(w / child.texture.width, h / child.texture.height);
      }
    }
    if (!foundSprite && oldW > 0 && oldH > 0) {
      bg.scale.x *= w / oldW;
      bg.scale.y *= h / oldH;
    }

    if (foundSprite) {
      const first = bg.children.find(
        (c): c is Sprite => c instanceof Sprite && c.texture?.width > 0 && c.texture?.height > 0,
      );
      if (first) {
        worldToPixelX = first.texture.width / w;
        worldToPixelY = first.texture.height / h;
      }
    }

    this.boundsOnlySetter?.(w, h);

    return { ok: true, worldToPixelX, worldToPixelY };
  }

  /**
   * 第一层背景贴图在 X/Y 方向的「每世界单位像素数」（与 loadScene / applyDebugWorldSize 中 worldToPixel 一致）。
   * 无有效背景精灵时返回 null。
   */
  getBackgroundTexelsPerWorld(): { x: number; y: number } | null {
    const scene = this.currentScene;
    const bg = this.sceneContainerBg;
    if (!scene || !bg || scene.worldWidth <= 0 || scene.worldHeight <= 0) return null;
    const first = bg.children.find(
      (c): c is Sprite => c instanceof Sprite && c.texture?.width > 0 && c.texture?.height > 0,
    );
    if (!first) return null;
    return {
      x: first.texture.width / scene.worldWidth,
      y: first.texture.height / scene.worldHeight,
    };
  }

  getDebugRenderState(): Record<string, unknown> {
    const backgrounds = this.sceneContainerBg?.children
      .filter((child): child is Sprite => child instanceof Sprite)
      .map((sprite) => ({
        x: sprite.x,
        y: sprite.y,
        scaleX: sprite.scale.x,
        scaleY: sprite.scale.y,
        textureWidth: sprite.texture.width,
        textureHeight: sprite.texture.height,
      })) ?? [];
    return {
      filterId: this.currentScene?.filterId ?? null,
      backgrounds,
    };
  }

  getDebugEntityVisualState(): Record<string, unknown>[] {
    return this.currentNpcs
      .map((npc) => npc.getDebugVisualState())
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  }

  resetEntityAnimationClocks(): void {
    for (const npc of this.currentNpcs) npc.resetAnimationClock();
  }

  /** 第一层背景的纹理（用于构建辐照度探针）；无有效背景精灵时返回 null。 */
  getPrimaryBackgroundTexture(): Texture | null {
    const bg = this.sceneContainerBg;
    if (!bg) return null;
    const first = bg.children.find(
      (c): c is Sprite => c instanceof Sprite && c.texture?.width > 0 && c.texture?.height > 0,
    );
    return first ? first.texture : null;
  }

  /** 燃烧系统的模板入口（开了可燃的实体按模板画）。不注入 = 开了可燃的实体画不出来 */
  setBurnTemplateResolver(fn: ((id: string) => Promise<ResolvedBurnable | null>) | null): void {
    this.burnTemplateResolver = fn;
  }

  /** 见 {@link BurnableDisplay} */
  private async burnableDisplayOf(raw: unknown, own: HotspotDisplayImage | undefined, entityId: string, request?: SceneLoadRequest): Promise<BurnableDisplay> {
    const host = resolveBurnableHost(raw);
    if (!host) return undefined;
    const t = this.burnTemplateResolver ? await this.burnTemplateResolver(host.template).catch(() => null) : null;
    if (request) this.assertLoadCurrent(request);
    if (!t) {
      if (request) throw new Error(`Required burnable template could not load: ${host.template}`);
      console.warn(`SceneManager: 实体 "${entityId}" 开了可燃，模板「${host.template}」装不到——它画不出来`);
      return null;
    }
    const size = burnableWorldSize(t);
    return {
      image: t.image, worldWidth: size.width, worldHeight: size.height,
      ...(own?.facing ? { facing: own.facing } : {}),
      ...(own?.spriteSort ? { spriteSort: own.spriteSort } : {}),
    };
  }

  private async instantiateHotspot(def: HotspotDef, overrides: HotspotRuntimeOverride | undefined, request?: SceneLoadRequest): Promise<Hotspot> {
    let defToUse = applyHotspotRuntimeOverride(def, overrides as Record<string, SceneEntityRuntimeValue> | undefined);
    // 开了可燃：展示图换成模板的（渲染由可燃物实例接管；模板装不到 = 不画图）
    const burnDi = await this.burnableDisplayOf(defToUse.burnable, defToUse.displayImage, defToUse.id, request);
    if (request) this.assertLoadCurrent(request);
    if (burnDi !== undefined) {
      defToUse = { ...defToUse };
      if (burnDi) defToUse.displayImage = burnDi;
      else delete defToUse.displayImage;
    }
    const hotspot = new Hotspot(defToUse);
    hotspot.setAuthoringMarkersVisible(this.authoringMarkersVisible);
    this.applySessionOverrideOnInstantiate('hotspot', hotspot);
    const di = defToUse.displayImage;
    if (di?.image && di.worldWidth > 0 && di.worldHeight > 0) {
      try {
        const tex = await this.assetManager.loadTexture(di.image, { signal: request?.context.signal });
        if (request) this.assertLoadCurrent(request);
        hotspot.setDisplayTexture(tex, di.worldWidth, di.worldHeight);
      } catch (_e) {
        if (request) { hotspot.destroy(); throw _e; }
        console.warn(`SceneManager: hotspot "${def.id}" displayImage failed`, di.image);
      }
    }
    if (request) this.assertLoadCurrent(request);
    this.renderer.entityLayer.addChild(hotspot.container);
    return hotspot;
  }

  private async instantiateNpc(npcDef: NpcDef, overrides: NpcRuntimeOverride | undefined, request?: SceneLoadRequest): Promise<Npc> {
    // 合并顺序：角色注册表默认（base）→ 运行时字段覆盖（session/sceneMemory，最高优先）
    const withChar = applyCharacterDefaults(npcDef, this.characterRegistry);
    let defToUse = applyNpcRuntimeOverride(withChar, overrides as Record<string, SceneEntityRuntimeValue> | undefined);
    // 开了可燃：动画包 / 角色模板的动画 / 自己的展示图一律不画，按模板的图合成单帧（不再播动画）
    const burnDi = await this.burnableDisplayOf(defToUse.burnable, defToUse.displayImage, defToUse.id, request);
    if (request) this.assertLoadCurrent(request);
    if (burnDi !== undefined) {
      defToUse = { ...defToUse };
      delete defToUse.animFile;
      if (burnDi) defToUse.displayImage = burnDi;
      else delete defToUse.displayImage;
    }
    const npc = new Npc(defToUse);
    npc.setAuthoringMarkersVisible(this.authoringMarkersVisible);
    this.applySessionOverrideOnInstantiate('npc', npc);
    if (defToUse.animFile) {
      try {
        const animRaw = await this.assetManager.loadJson<AnimationSetDefInput>(defToUse.animFile, { signal: request?.context.signal });
        if (request) this.assertLoadCurrent(request);
        const sheetPath = resolvePathRelativeToAnimManifest(defToUse.animFile, animRaw.spritesheet);
        const tex = await this.assetManager.loadTexture(sheetPath, { signal: request?.context.signal });
        if (request) this.assertLoadCurrent(request);
        const animDef = normalizeAnimationSetDef(animRaw, tex.width, tex.height, sheetPath);
        const sockets = await loadSocketsForAnim(this.assetManager, defToUse.animFile, animDef);
        if (request) this.assertLoadCurrent(request);
        npc.loadSprite(tex, animDef, defToUse.initialAnimState, sockets);
      } catch (_e) {
        if (request) { npc.destroy(); throw _e; }
        // 加载失败时保留占位外观
      }
    } else {
      const di = staticDisplayImageOf(defToUse);
      if (di) {
        // 叠放档位的唯一真相是 NpcDef.spriteSort（applyCharacterDefaults/override 都走它）。
        // displayImage 里那一份是热点的字段，NPC 侧**不读**——读了就是两处真相。
        if (
          import.meta.env.DEV
          && di.spriteSort
          && !defToUse.spriteSort
          && !staticDisplaySpriteSortWarned.has(defToUse.id)
        ) {
          staticDisplaySpriteSortWarned.add(defToUse.id);
          console.warn(
            `SceneManager: NPC "${defToUse.id}" 的 displayImage.spriteSort 被忽略；`
            + 'NPC 的叠放档位请写在 NpcDef.spriteSort 上。',
          );
        }
        try {
          const tex = await this.assetManager.loadTexture(di.image, { signal: request?.context.signal });
          if (request) this.assertLoadCurrent(request);
          const animDef = normalizeAnimationSetDef(
            buildStaticDisplayAnimationSet(di), tex.width, tex.height, di.image,
          );
          // 与 animFile 分支同一个入口：之后阴影/透视/排序/光照一律走普通 NPC 那条
          npc.loadSprite(tex, animDef, 'idle', null);
          // loadSprite 末尾会按 initialFacing 摆朝向；只有 NPC 自己没表态时才让展示图的
          // facing 说了算（与 spriteSort 同一条取舍：NpcDef 开口就以 NpcDef 为准）。
          if (!defToUse.initialFacing && di.facing === 'left') {
            npc.setFacing(-1, 0);
          }
        } catch (_e) {
          if (request) { npc.destroy(); throw _e; }
          // 加载失败时保留占位外观（与 animFile 分支同口径）
        }
      }
    }
    if (request) this.assertLoadCurrent(request);
    if (overrides && burnDi === undefined) {
      const anim = (overrides as NpcRuntimeOverride).animState?.trim();
      if (anim) {
        npc.playAnimation(anim);
      }
    }
    this.renderer.entityLayer.addChild(npc.container);
    return npc;
  }

  /**
   * 与 loadScene 中实例化逻辑一致，用于切场景进度条总步数估算。
   */
  private countSceneInstantiateWork(
    sceneData: SceneData,
    sceneId: string,
    committedMemory: SceneMemory | undefined,
    activeCutsceneId: string | null,
  ): { bgLayers: number; hotspots: number; npcs: number } {
    const bgLayers = sceneData.backgrounds?.length ?? 0;
    let hotspots = 0;
    for (const def of sceneData.hotspots ?? []) {
      const boundToActive = !!(activeCutsceneId && isEntityBoundToCutscene(def, activeCutsceneId));
      if (boundToActive) {
        hotspots++;
      } else {
        if (isCutsceneOnlyEntity(def)) continue;
        if (committedMemory?.pickedUpHotspots.includes(def.id)) continue;
        const ovr = this.getRuntimeOverrideForContext(sceneId, 'hotspot', def.id, def, 'outer');
        if (ovr?.enabled === false) continue;
        hotspots++;
      }
    }
    let npcs = 0;
    // 每个入场 NPC 恰好一步，**与 animFile 有没有无关**：静态贴图实体（displayImage
    // 合成单帧动画集）也走同一次 instantiateNpc，故已被这里算进去。别在这儿补
    // "有没有动画包"的分支——补了就与下面那个装载循环对不上，进度条会走过头。
    for (const npcDef of sceneData.npcs ?? []) {
      const boundToActive = !!(activeCutsceneId && isEntityBoundToCutscene(npcDef, activeCutsceneId));
      if (boundToActive) {
        npcs++;
      } else {
        if (isCutsceneOnlyEntity(npcDef)) continue;
        npcs++;
      }
    }
    return { bgLayers, hotspots, npcs };
  }

  private async buildSceneResourceManifest(sceneId: string, sceneData: SceneData, request?: SceneLoadRequest): Promise<AssetManifest> {
    const refs: AssetRef[] = [];
    const add = (ref: AssetRef | null | undefined): void => {
      if (!ref?.path?.trim()) return;
      refs.push(ref);
    };

    for (const layer of sceneData.backgrounds ?? []) {
      add({ type: 'texture', path: layer.image, label: `背景: ${layer.image}` });
    }

    const committedMemory = this.getCommittedMemory(sceneId);
    const activeCutsceneId = this.cutsceneStaging?.sceneId === sceneId ? this.cutsceneStaging.cutsceneId : null;
    await Promise.all((sceneData.hotspots ?? []).map(async (def) => {
      const boundToActive = !!(activeCutsceneId && isEntityBoundToCutscene(def, activeCutsceneId));
      if (!boundToActive) {
        if (isCutsceneOnlyEntity(def)) return;
        if (committedMemory?.pickedUpHotspots.includes(def.id)) return;
        const ovr = this.getRuntimeOverrideForContext(sceneId, 'hotspot', def.id, def, 'outer');
        if (ovr?.enabled === false) return;
      }
      const defToUse = applyHotspotRuntimeOverride(
        def,
        this.getRuntimeOverrideForContext(
          sceneId,
          'hotspot',
          def.id,
          def,
          boundToActive ? 'cutscene' : 'outer',
        ) as Record<string, SceneEntityRuntimeValue> | undefined,
      );
      const hsBurn = await this.burnableDisplayOf(defToUse.burnable, defToUse.displayImage, def.id, request);
      const hsImage = hsBurn !== undefined ? hsBurn?.image : defToUse.displayImage?.image;
      if (hsImage) {
        add({ type: 'texture', path: hsImage, label: `Hotspot: ${def.id}` });
        // 法线图与展示图同批预载（离线烘焙产物），挂滤镜时只做同步缓存读
        const normalPath = normalAtlasUrlFor(hsImage);
        if (normalPath) {
          add({ type: 'texture', path: normalPath, label: `Hotspot 法线: ${def.id}`, optional: true });
        }
      }
    }));

    const savedNpcs = Object.values(committedMemory?.spawnedNpcs ?? {}).filter(n =>
      !(sceneData.npcs ?? []).some(def => def.id === n.id));
    await Promise.all([...(sceneData.npcs ?? []), ...savedNpcs].map(async (npcDef) => {
      const boundToActive = !!(activeCutsceneId && isEntityBoundToCutscene(npcDef, activeCutsceneId));
      if (!boundToActive && isCutsceneOnlyEntity(npcDef)) return;
      const snap = this.getRuntimeOverrideForContext(
        sceneId,
        'npc',
        npcDef.id,
        npcDef,
        boundToActive ? 'cutscene' : 'outer',
      ) as NpcRuntimeOverride | undefined;
      const defToUse = applyNpcRuntimeOverride(
        applyCharacterDefaults(npcDef, this.characterRegistry),
        snap as Record<string, SceneEntityRuntimeValue> | undefined,
      );
      const npcBurn = await this.burnableDisplayOf(defToUse.burnable, defToUse.displayImage, npcDef.id, request);
      if (npcBurn !== undefined) {
        // 开了可燃：只预载模板的图（+ 法线），动画包不装
        if (npcBurn) {
          add({ type: 'texture', path: npcBurn.image, label: `NPC 可燃模板图: ${npcDef.id}` });
          const bn = normalAtlasUrlFor(npcBurn.image);
          if (bn) add({ type: 'texture', path: bn, label: `NPC 可燃模板图法线: ${npcDef.id}`, optional: true });
        }
        return;
      }
      if (!defToUse.animFile) {
        // 静态贴图实体：预载展示图 + 同批预载法线图（挂滤镜时只做同步缓存读）。
        // 照热点展示图那两行写——没烘法线是合法的，getNormalAtlasSource 取不到即平面法线。
        const sdi = staticDisplayImageOf(defToUse);
        if (sdi) {
          add({ type: 'texture', path: sdi.image, label: `NPC 静态贴图: ${npcDef.id}` });
          const staticNormalPath = normalAtlasUrlFor(sdi.image);
          if (staticNormalPath) {
            add({ type: 'texture', path: staticNormalPath, label: `NPC 静态贴图法线: ${npcDef.id}`, optional: true });
          }
        }
        return;
      }
      add({ type: 'json', path: defToUse.animFile, label: `NPC 动画清单: ${npcDef.id}` });
      try {
        const animRaw = await this.assetManager.loadJson<AnimationSetDefInput>(defToUse.animFile, { signal: request?.context.signal });
        if (request) this.assertLoadCurrent(request);
        if (animRaw.spritesheet) {
          const sheetPath = resolvePathRelativeToAnimManifest(defToUse.animFile, animRaw.spritesheet);
          add({ type: 'texture', path: sheetPath, label: `NPC 图集: ${npcDef.id}` });
          const normalPath = normalAtlasUrlFor(sheetPath);
          if (normalPath) {
            add({ type: 'texture', path: normalPath, label: `NPC 法线图集: ${npcDef.id}`, optional: true });
          }
        }
      } catch (error) {
        if (request) throw error;
      }
    }));

    if (sceneData.depthConfig) {
      const basePath = `resources/runtime/scenes/${sceneId}/`;
      if (sceneData.depthConfig.depth_map) {
        add({ type: 'texture', path: basePath + sceneData.depthConfig.depth_map, label: `深度图: ${sceneId}` });
      }
      if (sceneData.depthConfig.collision_map) {
        add({ type: 'bitmap', path: basePath + sceneData.depthConfig.collision_map, label: `碰撞图: ${sceneId}` });
      }
    }

    if (sceneData.filterId) {
      add({ type: 'filter', path: sceneData.filterId, label: `滤镜: ${sceneData.filterId}` });
    }

    for (const ref of this.audioManifestResolver?.(sceneData.bgm, sceneData.ambientSounds) ?? []) {
      add({ ...ref, optional: true });
    }

    return { scopeId: `scene:${sceneId}`, refs };
  }

  loadScene(
    sceneId: string,
    spawnPointId?: string,
    cameraPosition?: { x: number; y: number },
    fromSceneId?: string | null,
    onLoadProgress?: (ratio01: number, debugLabel: string) => void,
    onReveal?: () => Promise<void>,
  ): Promise<void> {
    return this.enqueueSceneLoad('reload', sceneId, spawnPointId, cameraPosition, {}, fromSceneId, onLoadProgress, onReveal);
  }

  private async prepareScene(request: SceneLoadRequest, suppliedScene?: SceneData): Promise<SceneData> {
    const { context, spawnPointId, cameraPosition, fromSceneId } = request;
    const sceneId = context.sceneId;
    const onLoadProgress = (ratio: number, label: string): void => this.reportLoadProgress(request, ratio, label);
    onLoadProgress?.(0, `场景 JSON · ${sceneId}`);
    const sceneData = suppliedScene ?? await this.awaitLoad(request, this.assetManager.loadSceneData(sceneId, { signal: context.signal }));
    this.assertLoadCurrent(request);
    // ---- 时段外观：**在装任何资源之前**就把该时段的那一份定下来 ----
    //
    // 必须在这儿而不是装完再换：读档回到夜、或切场景时已经是夜，都要**一步落到正确
    // 那份**。先装白天再换等于多一次背景纹理 + 烘焙载荷的白加载，而且揭幕那一帧会闪
    // 一下白天的画面。
    //
    // ⚠ 直接改 sceneData 上的字段：`loadSceneData` 返回的是 JSON 深拷贝（见其实现），
    //   改它不会污染 AssetManager 的 JSON 缓存；这样下游（manifest / 背景 / 深度 /
    //   光照四个消费点）不必各自再解析一遍时段，也就不会有第二个真相源。
    const phase0 = this.currentPhaseGetter?.() ?? '';
    // 基底留档要在**改之前**：只留外观相关的几个字段 + 时段表，够重算就行。
    const baseSnapshot = {
      backgrounds: JSON.parse(JSON.stringify(sceneData.backgrounds ?? [])),
      lighting: sceneData.lighting ? JSON.parse(JSON.stringify(sceneData.lighting)) : undefined,
      depthConfig: sceneData.depthConfig
        ? JSON.parse(JSON.stringify(sceneData.depthConfig)) : undefined,
      ambientSounds: sceneData.ambientSounds ? [...sceneData.ambientSounds] : undefined,
      filterId: sceneData.filterId,
      dayNight: sceneData.dayNight,
      timeVariants: sceneData.timeVariants,
    } as unknown as SceneData;
    applySceneAppearance(sceneData, phase0);
    this.appearanceBase = {
      scene: baseSnapshot,
      applied: resolveSceneAppearance(baseSnapshot, phase0),
    };
    this.currentScene = sceneData;
    const manifest = await this.awaitLoad(request, this.buildSceneResourceManifest(sceneId, sceneData, request));

    const committedMemory = this.getCommittedMemory(sceneId);
    const activeCutsceneId = this.cutsceneStaging?.sceneId === sceneId ? this.cutsceneStaging.cutsceneId : null;

    let doneSteps = 0;
    let totalSteps = 1;
    const report = (label: string) => {
      if (totalSteps < 1) return;
      onLoadProgress(Math.min(1, doneSteps / totalSteps), label);
    };
    const advance = (label: string) => {
      doneSteps++;
      onLoadProgress(Math.min(1, doneSteps / totalSteps), label);
    };

    {
      const { bgLayers, hotspots: hsN, npcs: npcN } = this.countSceneInstantiateWork(
        sceneData,
        sceneId,
        committedMemory,
        activeCutsceneId,
      );
      const depthBonus = this.depthLoader ? 1 : 0;
      const lightingBonus = this.lightingLoader && sceneData.backgrounds?.length ? 1 : 0;
      const swayBonus = this.swayLoader && sceneData.backgrounds?.length ? 1 : 0;
      const filterBonus = sceneData.filterId ? 1 : 0;
      const spawnedBonus = Object.values(committedMemory?.spawnedNpcs ?? {}).filter(n =>
        !(sceneData.npcs ?? []).some(def => def.id === n.id)).length;
      // Manifest resolution is indeterminate; once known, one immutable work list owns the progress.
      // Presentation/GPU/first-frame readiness is the final step, never an early 100%.
      totalSteps = 1 + manifest.refs.length + bgLayers + hsN + npcN + spawnedBonus
        + depthBonus + lightingBonus + swayBonus + filterBonus + 1;
      if (totalSteps < 1) totalSteps = 1;
      advance(`JSON ✓ · ${sceneData.name ?? sceneId}`);
    }

    this.currentSceneScopeId = manifest.scopeId;
    await this.awaitLoad(request, this.assetManager.preloadManifest(manifest, {
      mode: 'stage',
      tolerateErrors: false,
      signal: context.signal,
      onProgress: (r, label) => {
        doneSteps = 1 + Math.round(r * manifest.refs.length);
        onLoadProgress(Math.min(1, doneSteps / totalSteps), label);
      },
    }));
    doneSteps = 1 + manifest.refs.length;

    // 计算世界→像素的转换比例（用于碰撞检测）
    let worldToPixelX = 1;
    let worldToPixelY = 1;

    if (sceneData.backgrounds.length > 0) {
      this.sceneContainerBg = new Container();
      const layers = [...sceneData.backgrounds].sort((a, b) => (a.z ?? 0) - (b.z ?? 0));

      let firstTexWidth = 0;
      let firstTexHeight = 0;

      for (let i = 0; i < layers.length; i++) {
        const layer = layers[i];
        report(`背景 ${i + 1}/${layers.length}: ${layer.image}`);
        try {
          const texture = await this.awaitLoad(request, this.assetManager.loadTexture(layer.image, { signal: context.signal }));
          if (i === 0) {
            firstTexWidth = texture.width;
            firstTexHeight = texture.height;
            worldToPixelX = texture.width / sceneData.worldWidth;
            worldToPixelY = texture.height / sceneData.worldHeight;
          }
          const sprite = new Sprite(texture);
          sprite.x = layer.x ?? 0;
          sprite.y = layer.y ?? 0;
          sprite.scale.set(
            sceneData.worldWidth / texture.width,
            sceneData.worldHeight / texture.height,
          );
          this.sceneContainerBg.addChild(sprite);
          if (i === 0) {
            // 统一光影启用时要拿它的纹理当原画、并把这个 Sprite 换成点亮的 mesh
            this.primaryBgSprite = sprite;
            this.primaryBgTexture = texture;
          }
        } catch (error) {
          // Authored backgrounds are required; showing a partial world is not a successful load.
          throw error;
        }
        advance(`背景层 ${i + 1}/${layers.length} ✓`);
      }
    } else {
      this.sceneContainerBg = createPlaceholderBackground(
        this.renderer.app,
        sceneData.worldWidth,
        sceneData.worldHeight,
      );
    }
    this.renderer.backgroundLayer.addChild(this.sceneContainerBg);

    if (sceneData.hotspots) {
      for (const def of sceneData.hotspots) {
        const boundToActive = activeCutsceneId && isEntityBoundToCutscene(def, activeCutsceneId);
        if (boundToActive) {
          // cutscene context: skip pickedUpHotspots filter, skip committed enabled filter
          const ovr = this.getRuntimeOverrideForContext(sceneId, 'hotspot', def.id, def, 'cutscene');
          report(`Hotspot ${def.id} · cutscene`);
          const hotspot = await this.awaitLoad(request, this.instantiateHotspot(def, ovr as HotspotRuntimeOverride | undefined, request), h => h.destroy());
          this.currentHotspots.push(hotspot);
          advance(`Hotspot ${def.id} ✓`);
        } else {
          // outer context
          if (isCutsceneOnlyEntity(def)) continue;
          if (committedMemory?.pickedUpHotspots.includes(def.id)) continue;
          const ovr = this.getRuntimeOverrideForContext(sceneId, 'hotspot', def.id, def, 'outer');
          if (ovr?.enabled === false) continue;
          report(`Hotspot ${def.id}`);
          const hotspot = await this.awaitLoad(request, this.instantiateHotspot(def, ovr as HotspotRuntimeOverride | undefined, request), h => h.destroy());
          this.currentHotspots.push(hotspot);
          advance(`Hotspot ${def.id} ✓`);
        }
      }
    }

    if (sceneData.npcs) {
      for (const npcDef of sceneData.npcs) {
        const boundToActive = activeCutsceneId && isEntityBoundToCutscene(npcDef, activeCutsceneId);
        if (boundToActive) {
          // cutscene context
          const snap = this.getRuntimeOverrideForContext(sceneId, 'npc', npcDef.id, npcDef, 'cutscene') as NpcRuntimeOverride | undefined;
          report(`NPC ${npcDef.id} · cutscene`);
          const npc = await this.awaitLoad(request, this.instantiateNpc(npcDef, snap, request), n => n.destroy());
          this.currentNpcs.push(npc);
          advance(`NPC ${npcDef.id} ✓`);
        } else {
          // outer context
          if (isCutsceneOnlyEntity(npcDef)) continue;
          const snap = this.getRuntimeOverrideForContext(sceneId, 'npc', npcDef.id, npcDef, 'outer') as NpcRuntimeOverride | undefined;
          report(`NPC ${npcDef.id}`);
          const npc = await this.awaitLoad(request, this.instantiateNpc(npcDef, snap, request), n => n.destroy());
          this.currentNpcs.push(npc);
          advance(`NPC ${npcDef.id} ✓`);
        }
      }
    }
    // 演出里临时生成、播完留在场景的对象（sceneMemory.spawnedNpcs）：与场景 JSON 里的 NPC 同一条实例化管线
    for (const npcDef of Object.values(this.getCommittedMemory(sceneId)?.spawnedNpcs ?? {})) {
      if (this.currentNpcs.some((n) => n.def.id === npcDef.id)) continue;
      const snap = this.getRuntimeOverrideForContext(sceneId, 'npc', npcDef.id, npcDef, 'outer') as NpcRuntimeOverride | undefined;
      report(`NPC ${npcDef.id} · 演出留下`);
      const npc = await this.awaitLoad(request, this.instantiateNpc(npcDef, snap, request), n => n.destroy());
      this.currentNpcs.push(npc);
      advance(`NPC ${npcDef.id} ✓`);
    }
    this.interactionSetter?.(this.currentHotspots, this.currentNpcs);

    this.applyPlayerSpawnAndCamera(sceneData, spawnPointId, cameraPosition);

    this.audioApplier?.(sceneData.bgm, sceneData.ambientSounds, sceneData.acousticSpace);
    this.zoneSetter?.(this.computeEffectiveZones(sceneId, sceneData.zones));

    if (this.depthLoader) {
      report(`深度图 · ${sceneId}`);
      await this.awaitLoad(request, this.depthLoader(sceneId, sceneData, worldToPixelX, worldToPixelY, context));
      advance(`深度图 ✓`);
    }

    // 统一光影：必须在 depthLoader 之后（深度纹理那时才就绪）。
    // 启用则把主背景 Sprite 换成点亮的 mesh；不启用则背景照旧（旧场景零影响）。
    if (this.lightingLoader && this.primaryBgTexture && this.sceneContainerBg) {
      report(`统一光影 · ${sceneId}`);
      try {
        const litMesh = await this.awaitLoad(request, this.lightingLoader(sceneId, sceneData, this.primaryBgTexture, context), mesh => mesh?.destroy({ children: true }));
        if (litMesh && this.primaryBgSprite) {
          const idx = this.sceneContainerBg.getChildIndex(this.primaryBgSprite);
          this.sceneContainerBg.addChildAt(litMesh, idx);
          this.primaryBgSprite.renderable = false;
        }
      } catch (e) {
        throw e;
      }
      advance('统一光影 ✓');
    }

    // 背景草木摆动：只有背景还是平铺 Sprite（没点亮）时由这里换成摆动 mesh
    if (this.swayLoader && this.primaryBgTexture && this.primaryBgSprite?.renderable && this.sceneContainerBg) {
      try {
        const swayMesh = await this.awaitLoad(request, this.swayLoader(sceneId, sceneData, this.primaryBgTexture, context), mesh => mesh?.destroy({ children: true }));
        if (swayMesh && this.primaryBgSprite?.renderable && this.sceneContainerBg) {
          const idx = this.sceneContainerBg.getChildIndex(this.primaryBgSprite);
          this.sceneContainerBg.addChildAt(swayMesh, idx);
          this.primaryBgSprite.renderable = false;
        }
      } catch (e) {
        throw e;
      }
    }
    if (this.swayLoader && sceneData.backgrounds?.length) advance('背景摆动 ✓');

    if (sceneData.filterId) {
      report(`世界滤镜 · ${sceneData.filterId}`);
      try {
        await this.awaitLoad(request, this.renderer.loadAndSetWorldFilter(sceneData.filterId));
      } catch (_e) {
        this.renderer.clearWorldFilter();
        throw _e;
      }
      advance(`世界滤镜 ✓`);
    } else {
      this.renderer.clearWorldFilter();
    }

    // scene:ready 会给玩家/NPC/热点挂上深度遮挡与光照滤镜、启动巡逻——必须在**揭幕之前**完成，
    // 揭出来的场景才是完整表现。scene:enter 供 HUD/地图等复位。二者与 onEnter 解耦、先于 onEnter。
    this.eventBus.emit('scene:enter', { sceneId, fromSceneId: fromSceneId ?? null, sceneName: sceneData.name });
    this.eventBus.emit('scene:ready');
    this.assertLoadCurrent(request);

    // 揭幕前闸：scene:ready 的监听都跑完了（实体、载荷几何已就绪），趁遮罩还在把会卡帧的准备做完
    // （粒子 shader、挂件、完整首帧）。失败必须交给事务恢复，不能揭开一个半准备的世界。
    if (this.revealGate) {
      report(`画面准备 · ${sceneId}`);
      await this.awaitLoad(request, this.revealGate(sceneId, context));
    }
    advance(`完整首帧 ✓ · ${sceneId}`);
    context.hasOnEnter = !request.options.suppressOnEnter && !!sceneData.onEnter?.length
      && !!this.sceneEnterRunner && this.cutsceneStaging?.sceneId !== sceneId;
    return sceneData;
  }

  /**
   * 初始进场（游戏启动首场景）：与 switchScene 一致地**在过渡遮罩下**装载首场景，装载完成
   * （scene:ready、实体就绪）后再揭幕。否则首场景在可见画布上逐个刷出背景/NPC，玩家看着实体
   * 弹出来（尤其首启贴图未命中缓存时更明显），且后续 onEnter 开场演出接在这堆刷屏之后。
   *
   * 与 switchScene 的差异：无前场景可淡出，直接把遮罩 instant 置为全黑起手（省去启动淡出延迟）；
   * 揭幕仍走 loadScene 的 onReveal（scene:ready 之后、onEnter 之前），使 onEnter 里的开场演出
   * 落在"已就绪且完整揭幕"的场景上——契约与 switchScene 完全一致（见 scene-onenter-reveal-timing）。
   */
  loadInitialScene(sceneId: string, spawnPointId?: string): Promise<void> {
    return this.enqueueSceneLoad('initial', sceneId, spawnPointId);
  }

  reloadScene(sceneId: string, spawnPointId?: string, cameraPosition?: Position, options: SceneLoadOptions = {}): Promise<void> {
    return this.enqueueSceneLoad('reload', sceneId, spawnPointId, cameraPosition, { suppressOnEnter: true, ...options });
  }

  /**
   * 对 **已加载** 的 sceneData 应用 spawn / spawnPoints / cameraPosition（语义与 loadScene 末尾一致）。
   * ⚠ `cameraPosition` 不只管镜头：它同时是**玩家落点覆盖**（给了就顶掉 spawnPoint）——
   * changeScene 的 cameraX/cameraY 与读档恢复玩家站位都吃这一条。
   */
  private applyPlayerSpawnAndCamera(
    sceneData: SceneData,
    spawnPointId?: string,
    cameraPosition?: { x: number; y: number },
  ): void {
    let spawn: Position = sceneData.spawnPoint;
    const spKey = spawnPointId?.trim();
    if (spKey && sceneData.spawnPoints?.[spKey]) {
      spawn = sceneData.spawnPoints[spKey];
    }
    const posX = cameraPosition?.x ?? spawn.x;
    const posY = cameraPosition?.y ?? spawn.y;
    this.playerPositionSetter?.(posX, posY);
    this.cameraSetter?.(sceneData.worldWidth, sceneData.worldHeight, posX, posY, sceneData.camera, sceneData.worldScale);
  }

  unloadScene(cancelPending = true): void {
    if (cancelPending) this.cancelLoading();
    this.sceneReady = false;
    this.committedScene = null;
    this.sceneEpoch++;
    this.eventBus.emit('scene:beforeUnload');
    this.interactionSetter?.([], []);

    for (const hotspot of this.currentHotspots) {
      // scene:beforeUnload 通常已摘除热点深度滤镜；此处再摘一次是幂等兜底（detach 返回 null 即跳过）。
      this.releaseHotspotFilters(hotspot);
      hotspot.destroy();
    }
    this.currentHotspots = [];

    for (const npc of this.currentNpcs) {
      this.releaseNpcFilters(npc);
      npc.destroy();
    }
    this.currentNpcs = [];

    // ⚠ 顺序:先让光影系统拆掉它的 mesh 与 RT,再销毁背景容器。
    //   反了会命中 Pixi 坑②——绑着按场景销毁纹理的对象若在纹理之后才解绑,
    //   BindGroup 见资源已 destroyed 就自作废,那个 shader 从此永久烧毁(不是泄漏,是坏掉)。
    this.lightingUnloader?.();
    this.swayUnloader?.();
    this.primaryBgSprite = null;
    this.primaryBgTexture = null;

    if (this.sceneContainerBg) {
      this.renderer.backgroundLayer.removeChild(this.sceneContainerBg);
      this.sceneContainerBg.destroy({ children: true });
      this.sceneContainerBg = null;
    }

    this.depthUnloader?.();
    this.zoneSetter?.([]);
    this.currentScene = null;
    // Resource eviction may destroy GPU views: all consumers must be gone before releasing the scope.
    if (this.currentSceneScopeId) {
      this.assetManager.releaseScope(this.currentSceneScopeId);
      this.currentSceneScopeId = null;
    }
  }

  switchScene(targetSceneId: string, spawnPointId?: string, cameraPosition?: Position): Promise<void> {
    return this.enqueueSceneLoad('switch', targetSceneId, spawnPointId, cameraPosition);
  }

  private enqueueSceneLoad(
    kind: LoadingRequestContext['kind'],
    sceneId: string,
    spawnPointId?: string,
    cameraPosition?: Position,
    options: SceneLoadOptions = {},
    fromSceneId?: string | null,
    progress?: (ratio: number, label: string) => void,
    onReveal?: () => Promise<void>,
  ): Promise<void> {
    const target = sceneId?.trim();
    if (!target) return Promise.reject(new Error('Scene load requires a scene id'));
    if (this.destroyed) return Promise.reject(new Error('SceneManager is destroyed'));
    // Requests can wait behind other work; callers must not mutate their future target pose/options.
    cameraPosition = cameraPosition ? { ...cameraPosition } : undefined;
    options = { ...options };
    if (this.loadingScopeId && options.scopeId !== this.loadingScopeId) {
      return new Promise<void>((resolve, reject) => {
        this.deferredLoads.push({
          run: () => this.enqueueSceneLoad(kind, target, spawnPointId, cameraPosition, options, fromSceneId, progress, onReveal),
          resolve,
          reject,
        });
      });
    }
    if (options.interrupt) {
      if (this.activeLoad) this.activeLoad.replacement = true;
      this.cancelLoading();
    }
    const controller = new AbortController();
    const request: SceneLoadRequest = {
      context: { id: `load:${++this.loadSequence}`, sceneId: target, signal: controller.signal, kind, hasOnEnter: false },
      controller, spawnPointId, cameraPosition, fromSceneId, progress, onReveal, options,
      queuedGeneration: this.loadQueueGeneration, ratio: 0,
      managerEpoch: this.managerEpoch,
    };
    this.queuedLoads.add(request);
    let deferred: Promise<void> | null = null;
    const job = (): Promise<SceneData | null> => {
      this.queuedLoads.delete(request);
      if (!this.destroyed && request.managerEpoch === this.managerEpoch
        && request.queuedGeneration === this.loadQueueGeneration
        && this.loadingScopeId && request.options.scopeId !== this.loadingScopeId) {
        // A scope acquired after registration must not let this old external job block its own reloads.
        deferred = this.enqueueSceneLoad(kind, target, spawnPointId, cameraPosition, options, fromSceneId, progress, onReveal);
        return Promise.resolve(null);
      }
      return this.runSceneLoad(request);
    };
    const loaded = this.sceneSwitchTail.then(job, job);
    // The queue owns resource/scene/presentation work, never a game-clock-driven onEnter batch.
    // Reentrant changeScene can consequently await its own transaction instead of returning early.
    this.sceneSwitchTail = loaded.then(() => undefined, () => undefined);
    return loaded.then(async scene => {
      if (deferred) return await deferred;
      if (!scene || !request.context.hasOnEnter || request.context.signal.aborted) return;
      const epoch = this.sceneEpoch;
      const run = async (): Promise<void> => {
        if (this.destroyed || this.sceneEpoch !== epoch || this.currentScene !== scene) return;
        await this.sceneEnterRunner!(scene.onEnter!);
      };
      if (this.loadingLifecycle?.runOnEnter) {
        await this.loadingLifecycle.runOnEnter(request.context, run);
      } else {
        await run();
      }
    });
  }

  private hasQueuedLoads(): boolean {
    return [...this.queuedLoads].some(request => request.managerEpoch === this.managerEpoch
      && request.queuedGeneration === this.loadQueueGeneration);
  }

  private assertLoadCurrent(request: SceneLoadRequest): void {
    if (this.destroyed || request.managerEpoch !== this.managerEpoch || this.activeLoad !== request || request.context.signal.aborted) {
      throw request.context.signal.reason ?? new DOMException('Stale scene load', 'AbortError');
    }
  }

  /** Abort races settle the consumer; late results are discarded before they can attach. */
  private async awaitLoad<T>(request: SceneLoadRequest, work: Promise<T>, disposeLate?: (value: T) => void): Promise<T> {
    const signal = request.context.signal;
    if (signal.aborted) {
      void work.then(value => disposeLate?.(value), () => undefined);
      this.assertLoadCurrent(request);
    }
    let abort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason ?? new DOMException('Scene load cancelled', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
    });
    try {
      const value = await Promise.race([work, aborted]);
      this.assertLoadCurrent(request);
      return value;
    } catch (error) {
      if (signal.aborted) void work.then(value => disposeLate?.(value), () => undefined);
      throw error;
    } finally {
      if (abort) signal.removeEventListener('abort', abort);
    }
  }

  private reportLoadProgress(request: SceneLoadRequest, ratio: number, label: string): void {
    this.assertLoadCurrent(request);
    request.ratio = Math.max(request.ratio, Math.max(0, Math.min(1, ratio)));
    request.progress?.(request.ratio, label);
    if (this.loadingLifecycle) this.loadingLifecycle.progress(request.context, request.ratio, label);
    else this.setTransitionOverlayProgress(request.ratio, label);
  }

  private renewLoadScope(request: SceneLoadRequest, sceneId = request.context.sceneId): SceneLoadRequest {
    const controller = new AbortController();
    const renewed: SceneLoadRequest = {
      ...request,
      controller,
      context: { ...request.context, sceneId, signal: controller.signal, hasOnEnter: false, continuesLoading: false },
      options: { ...request.options },
    };
    // Identity, not a mutable signal field, invalidates all late writes from the failed request.
    this.activeLoad = renewed;
    return renewed;
  }

  private recordSafeScene(sceneData: SceneData, position?: Position, camera?: unknown): void {
    if (this.loadingScopeId) return;
    this.lastSafeScene = {
      sceneId: sceneData.id,
      sceneData: JSON.parse(JSON.stringify(sceneData)) as SceneData,
      position: position ? { ...position } : undefined,
      camera,
    };
  }

  private async runSceneLoad(request: SceneLoadRequest): Promise<SceneData | null> {
    if (this.destroyed || request.managerEpoch !== this.managerEpoch || request.queuedGeneration !== this.loadQueueGeneration) {
      throw new DOMException('Queued scene load cancelled', 'AbortError');
    }
    const reusePreparedScene = request.context.kind === 'switch' && this.sceneReady
      && this.currentScene?.id === request.context.sceneId && !request.spawnPointId && !request.cameraPosition;
    const needsHandoff = this.loadingLifecycle?.needsHandoff?.()
      ?? (this.loadingHandoffPending || this.transitionOverlay !== null);
    if (reusePreparedScene && !needsHandoff) return null;
    // Recovery replaces request/context and its pose. Keep retry intent independent of that object.
    const original = {
      kind: request.context.kind,
      sceneId: request.context.sceneId,
      spawnPointId: request.spawnPointId,
      cameraPosition: request.cameraPosition ? { ...request.cameraPosition } : undefined,
      fromSceneId: request.fromSceneId,
      options: { ...request.options },
      progress: request.progress,
      onReveal: request.onReveal,
      managerEpoch: request.managerEpoch,
    };
    const retry = (): Promise<void> => {
      if (this.destroyed || this.managerEpoch !== original.managerEpoch) {
        return Promise.reject(new DOMException('Stale scene retry', 'AbortError'));
      }
      return this.enqueueSceneLoad(original.kind, original.sceneId, original.spawnPointId,
        original.cameraPosition, {
          ...original.options,
          interrupt: true,
          // A completed restore no longer owns the queue when its failure UI is retried.
          scopeId: this.loadingScopeId === original.options.scopeId ? original.options.scopeId : undefined,
        }, original.fromSceneId, original.progress, original.onReveal);
    };
    const requestedTarget = request.context.sceneId;
    const previousScene = this.currentScene;
    const previousAppearance = this.appearanceBase;
    const previousReady = this.sceneReady;
    const previousPosition = this.playerPositionGetter?.();
    const previousCamera = this.cameraSnapshotGetter?.();
    const previousId = previousScene?.id ?? null;
    if (previousScene && previousReady) this.recordSafeScene(previousScene, previousPosition, previousCamera);
    if (request.fromSceneId === undefined) request.fromSceneId = previousId;
    if (request.context.kind === 'switch' && previousId === request.context.sceneId) {
      request.options.suppressOnEnter = true;
    }
    this.activeLoad = request;
    this.isSwitching = true;
    this.sceneReady = false;
    let tornDown = false;
    let prepared: SceneData | null = null;
    let outcome: LoadingOutcome = { status: 'failed' };
    const timeoutMs = Number.isFinite(request.options.timeoutMs) && request.options.timeoutMs! > 0
      ? request.options.timeoutMs! : this.loadingTimeoutMs;
    let watchdog = setTimeout(() => request.controller.abort(new Error(`Scene loading exceeded ${timeoutMs} ms`)), timeoutMs);
    try {
      this.eventBus.emit('scene:transition', { fromSceneId: previousId, toSceneId: request.context.sceneId, requestId: request.context.id });
      if (this.loadingLifecycle) {
        await this.awaitLoad(request, this.loadingLifecycle.begin(request.context));
      } else if (request.context.kind === 'initial' || !previousScene) {
        this.ensureTransitionOverlay();
        this.transitionOverlay!.alpha = 1;
      } else {
        await this.awaitLoad(request, this.fadeOut(300));
      }
      this.assertLoadCurrent(request);
      if (reusePreparedScene) {
        // The prior request/scope left a fully prepared world covered. Finish its presentation only.
        prepared = previousScene!;
        this.reportLoadProgress(request, 1, '场景已就绪');
      } else {
        this.saveCurrentSceneMemory();
        this.unloadScene(false);
        tornDown = true;
        prepared = await this.prepareScene(request);
      }
      request.context.continuesLoading = !request.context.hasOnEnter && this.hasQueuedLoads();
      if (request.onReveal && !request.context.continuesLoading) await this.awaitLoad(request, request.onReveal());
      if (this.loadingLifecycle && !request.context.continuesLoading) await this.awaitLoad(request, this.loadingLifecycle.reveal(request.context));
      else if (request.context.continuesLoading) { /* Keep the same opaque loading surface for the next job. */ }
      else if (request.onReveal) this.removeTransitionOverlay();
      else await this.awaitLoad(request, this.fadeIn(request.context.kind === 'initial' ? 400 : 300));
      this.assertLoadCurrent(request);
      this.committedScene = prepared;
      this.sceneReady = true;
      outcome = { status: 'success', continuesLoading: request.context.continuesLoading };
      // State handoff precedes observers/onEnter; no observer may release an unfinished load.
      if (this.loadingLifecycle) await this.awaitLoad(request, Promise.resolve(this.loadingLifecycle.end(request.context, outcome)));
      this.loadingHandoffPending = !!request.context.continuesLoading;
      this.recordSafeScene(prepared, this.playerPositionGetter?.(), this.cameraSnapshotGetter?.());
      if (!request.context.continuesLoading) {
        this.eventBus.emit('scene:revealed', { sceneId: prepared.id, fromSceneId: request.fromSceneId ?? null, requestId: request.context.id });
      }
      return prepared;
    } catch (error) {
      clearTimeout(watchdog);
      const wasCancelled = request.context.signal.aborted;
      // Stop every still-running task even on an ordinary resource/gate failure.
      request.controller.abort(error);
      if (request.managerEpoch === this.managerEpoch) this.cancelTransitionAnimation();
      let recovered = !this.destroyed && request.managerEpoch === this.managerEpoch
        && !tornDown && previousReady && previousScene != null;
      if (tornDown && !this.destroyed && request.managerEpoch === this.managerEpoch) {
        this.unloadScene(false);
        if (previousScene && previousReady && !request.replacement) {
          // A recovery has its own cancellation scope but keeps the same Loading owner.
          request = this.renewLoadScope(request, previousScene.id);
          request.spawnPointId = undefined;
          request.cameraPosition = previousPosition;
          request.options = { ...request.options, suppressOnEnter: true };
          watchdog = setTimeout(() => request.controller.abort(new Error('Scene recovery timed out')), this.loadingTimeoutMs);
          try {
            if (this.loadingLifecycle) await this.awaitLoad(request, this.loadingLifecycle.begin(request.context));
            this.reportLoadProgress(request, request.ratio, '恢复原场景');
            const restoreData = JSON.parse(JSON.stringify({
              ...previousScene,
              ...(previousAppearance?.scene ?? {}),
            })) as SceneData;
            // Avoid fetching a failed timeline's JSON and never replay root onEnter on recovery.
            await this.prepareScene(request, restoreData);
            if (previousCamera !== undefined) this.cameraSnapshotRestorer?.(previousCamera);
            if (previousCamera !== undefined && this.revealGate) {
              await this.awaitLoad(request, this.revealGate(previousScene.id, request.context));
            }
            request.context.continuesLoading = this.hasQueuedLoads();
            if (!request.context.continuesLoading) {
              if (this.loadingLifecycle) await this.awaitLoad(request, this.loadingLifecycle.reveal(request.context));
              else await this.awaitLoad(request, this.fadeIn(300));
            }
            this.committedScene = this.currentScene;
            this.sceneReady = true;
            recovered = true;
          } catch (recoveryError) {
            request.controller.abort(recoveryError);
            this.unloadScene(false);
            console.error('SceneManager: recovery failed', recoveryError);
          }
        }
      } else if (recovered) {
        this.currentScene = previousScene;
        this.committedScene = previousScene;
        this.sceneReady = true;
        if (this.loadingLifecycle && !this.destroyed && request.managerEpoch === this.managerEpoch) {
          // The world was never dismantled: reveal it through an independent recovery signal.
          request = this.renewLoadScope(request, previousScene!.id);
          watchdog = setTimeout(() => request.controller.abort(new Error('Scene recovery timed out')), this.loadingTimeoutMs);
          try {
            await this.awaitLoad(request, this.loadingLifecycle.begin(request.context));
            request.context.continuesLoading = this.hasQueuedLoads();
            if (!request.context.continuesLoading) await this.awaitLoad(request, this.loadingLifecycle.reveal(request.context));
          } catch (recoveryError) {
            request.controller.abort(recoveryError);
            recovered = false;
            console.error('SceneManager: recovery presentation failed', recoveryError);
          }
        } else this.removeTransitionOverlay();
      }
      request.context.continuesLoading = this.hasQueuedLoads();
      outcome = { status: wasCancelled ? 'cancelled' : recovered ? 'recovered' : 'failed', error, recovered,
        replacement: request.replacement, continuesLoading: request.context.continuesLoading, retry };
      request.context.hasOnEnter = false;
      if (!this.destroyed && request.managerEpoch === this.managerEpoch && this.loadingLifecycle) {
        // End hooks should normally be synchronous; give even a faulty injected hook a hard limit.
        request = this.renewLoadScope(request);
        clearTimeout(watchdog);
        watchdog = setTimeout(() => request.controller.abort(new Error('Loading state handoff timed out')), this.loadingTimeoutMs);
        await this.awaitLoad(request, Promise.resolve(this.loadingLifecycle.end(request.context, outcome)));
      }
      this.loadingHandoffPending = !!outcome.continuesLoading;
      if (request.managerEpoch === this.managerEpoch && !this.loadingLifecycle) this.removeTransitionOverlay();
      // Recovery restores operability; the original request still failed and must reject.
      throw error;
    } finally {
      clearTimeout(watchdog);
      if (this.activeLoad === request) this.activeLoad = null;
      if (request.managerEpoch === this.managerEpoch) {
        this.isSwitching = false;
        this.eventBus.emit('scene:transitionEnd', { toSceneId: requestedTarget, requestId: request.context.id, outcome });
      }
    }
  }


  /**
   * 当前场景运行态（拾取/巡查/实体覆盖）都在发生时即写入 sceneMemory（见
   * markHotspotPickedUp / markHotspotInspected / setEntityRuntimeField），本方法只确保
   * 内存桶存在——可随时安全调用（切场景、存档 serialize 前都会调）。
   * 不再从实体 `!active` 反推拾取：那会把条件隐藏 / 会话隐藏的 pickup 误记为已拾取。
   */
  private saveCurrentSceneMemory(): void {
    if (!this.currentScene) return;
    if (this.cutsceneStaging) return;
    this.ensureSceneMemory(this.currentScene.id);
  }

  private markHotspotPickedUp(hotspotId: string): void {
    const hotspot = this.currentHotspots.find(h => h.def.id === hotspotId);
    hotspot?.markPickedUp();
    // 拾取立刻入 sceneMemory（不等切场景反推）。与旧推断口径一致：只有 pickup 型入档；
    // encounter 型热点的 `hotspot:pickup:done` 自消费仅置实例运行态位——当次场景访问内
    // 失活，重进场景（或过场重建）后可再次触发，且不进存档。
    const def = hotspot?.def ?? this.currentScene?.hotspots?.find(h => h.id === hotspotId);
    if (def?.type !== 'pickup') return;
    if (!this.currentScene) return;
    const mem = this.getWritableMemory(this.currentScene.id);
    if (mem && !mem.pickedUpHotspots.includes(hotspotId)) {
      mem.pickedUpHotspots.push(hotspotId);
    }
  }

  private markHotspotInspected(hotspotId: string): void {
    if (!this.currentScene) return;
    const mem = this.getWritableMemory(this.currentScene.id);
    if (mem && !mem.inspectedHotspots.includes(hotspotId)) {
      mem.inspectedHotspots.push(hotspotId);
    }
  }

  private async fadeOut(durationMs: number): Promise<void> {
    this.ensureTransitionOverlay();
    this.transitionOverlay!.alpha = 0;
    await this.animateAlpha(this.transitionOverlay!, 0, 1, durationMs);
  }

  private async fadeIn(durationMs: number): Promise<void> {
    this.ensureTransitionOverlay();
    this.transitionOverlay!.alpha = 1;
    if (this.transitionBarFill) this.transitionBarFill.visible = false;
    if (this.transitionBarTrack) this.transitionBarTrack.visible = false;
    if (this.transitionDebugLabel) this.transitionDebugLabel.visible = false;
    await this.animateAlpha(this.transitionOverlay!, 1, 0, durationMs);
    this.removeTransitionOverlay();
  }

  private ensureTransitionOverlay(): void {
    if (this.transitionOverlay) return;

    const sw = this.renderer.screenWidth;
    const sh = this.renderer.screenHeight;

    const root = new Container();
    root.x = -100;
    root.y = -100;
    /**
     * 遮幕必须压过面板（层序表见 `rendering/uiLayerOrder`）：暂停菜单点「读档」是
     * **读完才关菜单**的（`MenuUI.commitSlot`），标题页「继续」同理，加载全程菜单都还挂着。
     * 以前靠"遮幕是最后挂上去的"这条插入序盖住它，面板拿到 z 之后插入序就不管用了。
     */
    root.zIndex = UI_LAYER_Z.curtain;

    const bg = new Graphics();
    bg.rect(0, 0, sw + 200, sh + 200).fill(0x000000);
    root.addChild(bg);

    const barW = Math.min(480, Math.max(200, Math.round(sw * 0.72)));
    const barH = Math.max(6, Math.round(sh * 0.014));
    const bx = 100 + (sw - barW) / 2;
    const by = 100 + Math.round(sh * 0.88);

    // 切场进度上的资源级调试文案只在 DEV 构建可见（T4）；生产不建该 Text，
    // setTransitionOverlayProgress 对 null 标签自然跳过
    if (import.meta.env.DEV) {
      const debugLabel = createStyledText({
        text: '',
        style: {
          fontFamily: 'system-ui, Segoe UI, sans-serif',
          fontSize: 10,
          fill: 0x8a7a5c,
          wordWrap: true,
          wordWrapWidth: barW,
          lineHeight: 12,
        },
      });
      debugLabel.anchor.set(0, 1);
      debugLabel.x = bx;
      debugLabel.y = by - 8;
      root.addChild(debugLabel);
      this.transitionDebugLabel = debugLabel;
    }

    const rad = Math.min(5, barH / 2);
    // 切场进度条是**玩家每次换场都看得见**的东西，配色必须跟 UI 一套：
    // 原本是一整条亮蓝（0x38bdf8/0x1e293b/0x64748b），在暖木黑底的游戏里格外扎眼。
    const track = new Graphics();
    track.rect(bx, by, barW, barH);
    track.fill({ color: this.transitionPalette.track, alpha: 0.92 });
    track.stroke({ color: this.transitionPalette.trackBorder, width: 1, alpha: 0.7 });
    root.addChild(track);
    this.transitionBarTrack = track;

    const fill = new Graphics();
    fill.x = bx;
    fill.y = by;
    root.addChild(fill);

    this.transitionOverlay = root;
    this.transitionBarFill = fill;
    this.transitionBarW = barW;
    this.transitionBarH = barH;

    this.renderer.uiLayer.addChild(root);
    this.setTransitionOverlayProgress(0, '');
  }

  private setTransitionOverlayProgress(ratio01: number, debugLabel: string): void {
    const fill = this.transitionBarFill;
    if (fill) {
      const r = Math.max(0, Math.min(1, ratio01));
      const pw = Math.max(0, r * this.transitionBarW);
      const h = this.transitionBarH;
      const rad = Math.min(5, h / 2);
      fill.clear();
      if (pw >= 0.5) {
        fill.rect(0, 0, pw, h);
        fill.fill(this.transitionPalette.fill);
      }
    }
    const lbl = this.transitionDebugLabel;
    if (lbl) {
      const pct = Math.round(Math.max(0, Math.min(1, ratio01)) * 100);
      lbl.text = `[${pct}%] ${debugLabel}`;
    }
  }

  private removeTransitionOverlay(): void {
    if (this.transitionOverlay) {
      if (this.transitionOverlay.parent) {
        this.transitionOverlay.parent.removeChild(this.transitionOverlay);
      }
      this.transitionOverlay.destroy({ children: true });
      this.transitionOverlay = null;
      this.transitionBarFill = null;
      this.transitionBarTrack = null;
      this.transitionDebugLabel = null;
    }
  }

  private animateAlpha(target: { alpha: number }, from: number, to: number, durationMs: number): Promise<void> {
    this.cancelTransitionAnimation();
    return new Promise(resolve => {
      this.transitionAnimResolve = resolve;
      const startTime = this.captureClockNow();
      target.alpha = from;

      const tick = () => {
        const elapsed = this.captureClockNow() - startTime;
        const t = Math.min(elapsed / durationMs, 1);
        target.alpha = from + (to - from) * t;
        if (t < 1) {
          if (this.capturePauseDepth === 0) this.animRafId = requestAnimationFrame(tick);
        } else {
          this.animRafId = 0;
          this.captureTransitionTick = null;
          this.transitionAnimResolve = null;
          resolve();
        }
      };
      this.captureTransitionTick = tick;
      if (this.capturePauseDepth === 0) this.animRafId = requestAnimationFrame(tick);
    });
  }

  private cancelTransitionAnimation(): void {
    if (this.animRafId) cancelAnimationFrame(this.animRafId);
    this.animRafId = 0;
    this.captureTransitionTick = null;
    const finish = this.transitionAnimResolve;
    this.transitionAnimResolve = null;
    finish?.();
  }

  private ensureBlackoutOverlay(): Graphics {
    if (!this.blackoutOverlay) {
      const g = new Graphics();
      g.rect(0, 0, this.renderer.screenWidth + 200, this.renderer.screenHeight + 200).fill(0x000000);
      g.x = -100;
      g.y = -100;
      g.alpha = 0;
      // 与切场遮幕同带（见 uiLayerOrder）：同值之间仍按插入序，showBlackout 里那句
      // 「移到 uiLayer 末尾」的语义不变，只是现在连面板一起盖住。
      g.zIndex = UI_LAYER_Z.curtain;
      this.renderer.uiLayer.addChild(g);
      this.blackoutOverlay = g;
    }
    return this.blackoutOverlay;
  }

  /**
   * 盖上持久黑幕：durationMs<=0 瞬间全黑，>0 淡入。盖上时移到 uiLayer 末尾（渲染最上），
   * 确保盖住世界层 / 过场层 / 切场遮幕之上的一切。跨段演出通常在第一段末尾（画面已黑时）
   * 以 durationMs=0 无感接管，随后第一段过场 cleanup 拆掉自己的 fadeOverlay，黑屏由本遮罩延续。
   */
  async showBlackout(durationMs: number): Promise<void> {
    const g = this.ensureBlackoutOverlay();
    if (g.parent) g.parent.addChild(g);
    await this.animateBlackoutAlpha(g, g.alpha, 1, durationMs);
  }

  /** 揭开持久黑幕：durationMs<=0 瞬间，>0 淡出；完成后销毁遮罩。当前无黑幕时安全空转。 */
  async hideBlackout(durationMs: number): Promise<void> {
    if (!this.blackoutOverlay) return;
    await this.animateBlackoutAlpha(this.blackoutOverlay, this.blackoutOverlay.alpha, 0, durationMs);
    this.removeBlackoutOverlay();
  }

  private removeBlackoutOverlay(): void {
    this.cancelBlackoutAnim();
    if (this.blackoutOverlay) {
      if (this.blackoutOverlay.parent) this.blackoutOverlay.parent.removeChild(this.blackoutOverlay);
      this.blackoutOverlay.destroy();
      this.blackoutOverlay = null;
    }
  }

  /** 取消在途黑幕动画并封口其 Promise（打断/销毁路径共用），保证不留悬挂 await 与残留 RAF。 */
  private cancelBlackoutAnim(): void {
    this.captureBlackoutTick = null;
    if (this.blackoutRafId) cancelAnimationFrame(this.blackoutRafId);
    this.blackoutRafId = 0;
    const resolve = this.blackoutAnimResolve;
    this.blackoutAnimResolve = null;
    if (resolve) resolve();
  }

  /** 与 animateAlpha 同款缓动，但用独立 blackoutRafId + 封口句柄，避免与切场淡入淡出互相 cancel。 */
  private animateBlackoutAlpha(target: { alpha: number }, from: number, to: number, durationMs: number): Promise<void> {
    this.cancelBlackoutAnim();
    return new Promise(resolve => {
      if (!(durationMs > 0)) {
        target.alpha = to;
        resolve();
        return;
      }
      this.blackoutAnimResolve = resolve;
      const startTime = this.captureClockNow();
      target.alpha = from;
      const tick = () => {
        const t = Math.min((this.captureClockNow() - startTime) / durationMs, 1);
        target.alpha = from + (to - from) * t;
        if (t < 1) {
          if (this.capturePauseDepth === 0) this.blackoutRafId = requestAnimationFrame(tick);
        } else {
          this.blackoutRafId = 0;
          this.captureBlackoutTick = null;
          this.blackoutAnimResolve = null;
          resolve();
        }
      };
      this.captureBlackoutTick = tick;
      if (this.capturePauseDepth === 0) this.blackoutRafId = requestAnimationFrame(tick);
    });
  }

  /**
   * 某场景里开了可燃的实体（燃烧系统离场重建 / 问别的场景的条件叶用）：场景 JSON 的热点 / NPC，
   * 加上这个场景记着的、演出生成留下的对象（`sceneMemory.spawnedNpcs`）。块原样给，燃烧系统清洗。
   */
  sceneBurnableEntities(sceneId: string, scene: SceneData): { id: string; burnable: unknown }[] {
    const out: { id: string; burnable: unknown }[] = [];
    for (const h of scene.hotspots ?? []) if (h.burnable) out.push({ id: h.id, burnable: h.burnable });
    for (const n of scene.npcs ?? []) if (n.burnable) out.push({ id: n.id, burnable: n.burnable });
    for (const n of Object.values(this.getCommittedMemory(sceneId)?.spawnedNpcs ?? {})) {
      if (n.burnable) out.push({ id: n.id, burnable: n.burnable });
    }
    return out;
  }

  private captureClockNow(): number {
    return (this.capturePauseDepth > 0 ? this.capturePauseStartedAt : performance.now())
      - this.capturePausedMs + this.captureSteppedMs;
  }

  suspendForCapture(): () => void {
    if (this.capturePauseDepth++ === 0) {
      this.capturePauseStartedAt = performance.now();
      cancelAnimationFrame(this.animRafId);
      cancelAnimationFrame(this.blackoutRafId);
      this.animRafId = this.blackoutRafId = 0;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.capturePauseDepth > 0) return;
      this.capturePausedMs += performance.now() - this.capturePauseStartedAt;
      if (this.captureTransitionTick) this.animRafId = requestAnimationFrame(this.captureTransitionTick);
      if (this.captureBlackoutTick) this.blackoutRafId = requestAnimationFrame(this.captureBlackoutTick);
    };
  }

  stepCaptureFrame(dt: number): void {
    if (this.capturePauseDepth === 0) return;
    this.captureSteppedMs += dt * 1000;
    this.captureTransitionTick?.();
    this.captureBlackoutTick?.();
  }

  /**
   * DEV 燃烧工作台推了模板工作态：开了可燃的热点 / NPC 按新模板重画（图 / 真实尺寸可能变了）。
   * 返回换了精灵的 NPC（组装层给它们补透视 / 光照 mesh，与生成对象同一步）。
   */
  async refreshBurnableDisplays(): Promise<Npc[]> {
    const epoch = this.sceneEpoch;
    const same = (a: HotspotDisplayImage | undefined, b: HotspotDisplayImage): boolean =>
      !!a && a.image === b.image && a.worldWidth === b.worldWidth && a.worldHeight === b.worldHeight;
    for (const h of [...this.currentHotspots]) {
      if (!h.def.burnable) continue;
      const di = await this.burnableDisplayOf(h.def.burnable, h.def.displayImage, h.def.id);
      if (epoch !== this.sceneEpoch) return [];
      if (!di || same(h.def.displayImage, di)) continue;
      h.def.displayImage = di;
      try {
        const tex = await this.assetManager.loadTexture(di.image);
        if (epoch !== this.sceneEpoch) return [];
        h.setDisplayTexture(tex, di.worldWidth, di.worldHeight);
      } catch (_e) {
        console.warn(`SceneManager: 可燃热点 "${h.def.id}" 按新模板重画失败`, di.image);
      }
    }
    const changed: Npc[] = [];
    for (const npc of [...this.currentNpcs]) {
      if (!npc.def.burnable) continue;
      const di = await this.burnableDisplayOf(npc.def.burnable, npc.def.displayImage, npc.def.id);
      if (epoch !== this.sceneEpoch) return [];
      if (!di || same(npc.def.displayImage, di)) continue;
      npc.def.displayImage = di;
      try {
        const tex = await this.assetManager.loadTexture(di.image);
        if (epoch !== this.sceneEpoch) return [];
        const animDef = normalizeAnimationSetDef(buildStaticDisplayAnimationSet(di), tex.width, tex.height, di.image);
        npc.loadSprite(tex, animDef, 'idle', null);
        changed.push(npc);
      } catch (_e) {
        console.warn(`SceneManager: 可燃 NPC "${npc.def.id}" 按新模板重画失败`, di.image);
      }
    }
    return changed;
  }

  /**
   * 演出临时生成一个 NPC（图片道具 / 角色模板），走与场景 JSON 同一条实例化管线。
   * 「同一条」= `instantiateNpc`（合角色注册表默认 / 装贴图 / 进实体层）**加上** `runtimeNpcHooks.onSpawned`
   * 补的那一半（逐实体光照 / 深度遮挡 / 透视缩放 / 投影阴影 / 像素密度）——后一半住在 Game 的
   * `scene:ready` 循环里，不经钩子就一样都没有（2026-09-12 之前正是如此，见 {@link runtimeNpcHooks}）。
   * `persistent` = 播完留在场景：进 `sceneMemory.spawnedNpcs`，随存档与之后每次实例化走。
   * 生成期间切了场景：销毁半成品、返回 null（孤儿容器不许进层）。图片没给世界尺寸就按贴图像素尺寸。
   */
  async spawnRuntimeNpc(def: NpcDef, opts: { persistent: boolean }): Promise<Npc | null> {
    const scene = this.currentScene;
    if (!scene) return null;
    const sceneId = scene.id;
    const epoch = this.sceneEpoch;
    if (def.displayImage && !(def.displayImage.worldWidth > 0 && def.displayImage.worldHeight > 0)) {
      try {
        const tex = await this.assetManager.loadTexture(def.displayImage.image);
        def.displayImage = {
          ...def.displayImage,
          worldWidth: def.displayImage.worldWidth > 0 ? def.displayImage.worldWidth : tex.width,
          worldHeight: def.displayImage.worldHeight > 0 ? def.displayImage.worldHeight : tex.height,
        };
      } catch (_e) {
        // 图装不上：instantiateNpc 会再试一次并退到占位外观
      }
      if (epoch !== this.sceneEpoch) return null;
    }
    const snap = this.getRuntimeOverrideForContext(sceneId, 'npc', def.id, def, 'outer') as NpcRuntimeOverride | undefined;
    const npc = await this.instantiateNpc(def, snap);
    if (epoch !== this.sceneEpoch || this.currentScene?.id !== sceneId) {
      npc.destroy();
      return null;
    }
    this.currentNpcs.push(npc);
    if (opts.persistent) {
      const mem = this.getWritableMemory(sceneId);
      if (mem) mem.spawnedNpcs[def.id] = { ...def };
    }
    // 必须在 push 之后：钩子那侧按实体表寻址（阴影定向重建走 getNpcById，像素密度遍历全表）
    this.runtimeNpcHooks?.onSpawned?.(npc);
    this.interactionSetter?.(this.currentHotspots, this.currentNpcs);
    return npc;
  }

  /** 移除一个运行时生成的 NPC（连同 spawnedNpcs 里的定义）；不在当前场景返回 false。 */
  removeRuntimeNpc(id: string): boolean {
    const idx = this.currentNpcs.findIndex((n) => n.id === id);
    if (idx < 0) return false;
    const npc = this.currentNpcs[idx]!;
    // 先于 destroy：生成侧建的阴影 entry 不随实体自毁，留着就是地上一坨冻住的鬼影
    this.runtimeNpcHooks?.onRemoved?.(id);
    this.releaseNpcFilters(npc);
    npc.destroy();
    this.currentNpcs.splice(idx, 1);
    const sid = this.currentScene?.id;
    if (sid) {
      const mem = this.getWritableMemory(sid);
      if (mem) delete mem.spawnedNpcs[id];
    }
    this.interactionSetter?.(this.currentHotspots, this.currentNpcs);
    return true;
  }

  /** 留在场景的临时对象：把它此刻的位置写回 spawnedNpcs 的定义（下次实例化就在终点） */
  commitSpawnedNpcPosition(id: string): void {
    const sid = this.currentScene?.id;
    if (!sid) return;
    const mem = this.getWritableMemory(sid);
    const def = mem?.spawnedNpcs[id];
    const npc = this.getNpcById(id);
    if (!mem || !def || !npc) return;
    def.x = Math.round(npc.x * 100) / 100;
    def.y = Math.round(npc.y * 100) / 100;
  }

  serialize(): object {
    // 存档前 flush 当前场景运行态（幂等；运行态本身已即时入 memory，此处兜底建桶）
    this.saveCurrentSceneMemory();
    const data: Record<
      string,
      {
        inspected: string[];
        pickedUp: string[];
        entityOverrides: SceneEntityRuntimeOverrides;
        spawned?: Record<string, NpcDef>;
      }
    > = {};
    this.sceneMemory.forEach((mem, sceneId) => {
      const row: {
        inspected: string[];
        pickedUp: string[];
        entityOverrides: SceneEntityRuntimeOverrides;
        spawned?: Record<string, NpcDef>;
      } = {
        inspected: mem.inspectedHotspots,
        pickedUp: mem.pickedUpHotspots,
        entityOverrides: mem.entityOverrides ?? this.emptyEntityOverrides(),
      };
      if (mem.spawnedNpcs && Object.keys(mem.spawnedNpcs).length) row.spawned = mem.spawnedNpcs;
      data[sceneId] = row;
    });
    return { currentSceneId: this.isLoading ? this.lastSafeScene?.sceneId ?? null : this.currentScene?.id ?? null, memory: data };
  }

  deserialize(data: {
    currentSceneId: string | null;
    memory: Record<
      string,
      {
        inspected: string[];
        pickedUp: string[];
        entityOverrides?: SceneEntityRuntimeOverrides;
        npcSnapshots?: Record<string, NpcPersistentSnapshot>;
        hotspotDisplayImageOverrides?: Record<string, HotspotDisplayImage>;
        spawned?: Record<string, NpcDef>;
      }
    >;
  }): void {
    this.sceneMemory.clear();
    // 读档=新时间线：会话级（不入档）的 zone 禁用与实体隐藏覆盖全部作废
    this.zoneSessionDisabled.clear();
    this.entitySessionOverrides.clear();
    this.groupSessionDisabled.clear();
    this.pendingTimeZoneRefresh = null;
    for (const [sceneId, mem] of Object.entries(data.memory)) {
      const base = mem.entityOverrides ?? this.emptyEntityOverrides();
      const entityOverrides: SceneEntityRuntimeOverrides = {
        npcs: { ...base.npcs },
        hotspots: { ...base.hotspots },
        zones: { ...(base.zones ?? {}) },
      };
      if (mem.npcSnapshots) {
        entityOverrides.npcs = { ...entityOverrides.npcs, ...mem.npcSnapshots };
      }
      if (mem.hotspotDisplayImageOverrides) {
        for (const [hotspotId, displayImage] of Object.entries(mem.hotspotDisplayImageOverrides)) {
          entityOverrides.hotspots[hotspotId] = {
            ...(entityOverrides.hotspots[hotspotId] ?? {}),
            displayImage,
          };
        }
      }
      this.sceneMemory.set(sceneId, {
        inspectedHotspots: mem.inspected,
        pickedUpHotspots: mem.pickedUp,
        entityOverrides,
        spawnedNpcs: { ...(mem.spawned ?? {}) },
      });
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.managerEpoch++;
    this.cancelLoading();
    this.loadingScopeId = null;
    this.loadingScopeDepth = 0;
    this.queuedLoads.clear();
    this.activeLoad = null;
    this.loadingHandoffPending = false;
    this.isSwitching = false;
    this.zoneSessionDisabled.clear();
    this.entitySessionOverrides.clear();
    this.groupSessionDisabled.clear();
    this.pendingTimeZoneRefresh = null;
    // 铁律 8：重 init() 行为须与首次一致——调试开关不得跨销毁残留
    this.authoringMarkersVisible = false;
    this.eventBus.off('hotspot:pickup:done', this.onHotspotPickup);
    this.eventBus.off('hotspot:inspected', this.onHotspotInspected);
    this.unloadScene();
    this.removeTransitionOverlay();
    this.removeBlackoutOverlay();
    this.sceneMemory.clear();
    this.lastSafeScene = null;
    this.cutsceneStaging = null;
    this.playerPositionSetter = null;
    this.playerPositionGetter = null;
    this.cameraSnapshotGetter = null;
    this.cameraSnapshotRestorer = null;
    this.loadingLifecycle = null;
    this.revealGate = null;
    this.cameraSetter = null;
    this.boundsOnlySetter = null;
    this.audioApplier = null;
    this.zoneSetter = null;
    this.interactionSetter = null;
    this.depthLoader = null;
    this.depthUnloader = null;
  }
}
