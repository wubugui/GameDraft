import { EventBus } from './EventBus';
import { earHeightWu, type AcousticTap } from '../audio/acousticSpace';
import { RuntimeAcousticsSync } from '../dev/runtimeAcousticsSync';
import { RuntimeVfxSync, phaseRequestNeedsAdvance } from '../dev/runtimeVfxSync';
import { RuntimeBurnSync } from '../dev/runtimeBurnSync';
import { RuntimeBreathingSync } from '../dev/runtimeBreathingSync';
import { BreathingOverlaySystem } from '../systems/breathing/BreathingOverlaySystem';
import { fetchPayloadBytes } from './lightingPayloadFiles';
import type { SceneSpaceGeometry, Vec3 } from '../utils/sceneSpace';
import { FlagStore, type FlagRegistryJson } from './FlagStore';
import { applyDevRuntimeCommand } from './devRuntimeCommands';
import { fetchSceneIndex } from '../dev/sceneIndex';
import { InputManager } from './InputManager';
import { AssetManager, type AssetRef } from './AssetManager';
import { ActionExecutor } from './ActionExecutor';
import { SaveManager } from './SaveManager';
import { Renderer } from '../rendering/Renderer';
import { Camera } from '../rendering/Camera';
import { Player, ANIM_IDLE, ANIM_WALK, ANIM_RUN } from '../entities/Player';
import { InteractionSystem } from '../systems/InteractionSystem';
import { PlayerActionSystem, VERB_KEYS } from '../systems/PlayerActionSystem';
import { SceneManager } from '../systems/SceneManager';
import { DialogueManager } from '../systems/DialogueManager';
import { GraphDialogueManager } from '../systems/GraphDialogueManager';
import { QuestManager } from '../systems/QuestManager';
import { NarrativePackageDirector } from '../systems/NarrativePackageDirector';
import { RulesManager } from '../systems/RulesManager';
import { InventoryManager } from '../systems/InventoryManager';
import { EncounterManager } from '../systems/EncounterManager';
import { AudioManager } from '../systems/AudioManager';
import { buildStrikeSurfaceCandidates, pickBoltVariant, sampleStrikeFallback, type StrikeSurfacePoint } from '../systems/strikePresentation';
import { VoiceChannel } from '../systems/VoiceChannel';
import { DialogueVoiceDirector } from '../systems/DialogueVoiceDirector';
import { DayManager } from '../systems/DayManager';
import { CutsceneManager } from '../systems/CutsceneManager';
import { CutsceneRenderer } from '../rendering/CutsceneRenderer';
import { ArchiveManager } from '../systems/ArchiveManager';
import { ClueManager } from '../systems/ClueManager';
import { SystemNoteManager } from '../systems/SystemNoteManager';
import { openSystemNote, isSystemNoteOpen } from '../ui/SystemNoteUI';
import { FlagKeys } from './FlagKeys';
import { GameLogManager } from '../systems/GameLogManager';
import { EmoteBubbleManager } from '../systems/EmoteBubbleManager';
import { ZoneSystem } from '../systems/ZoneSystem';
import { InspectBox } from '../ui/InspectBox';
import { PickupNotification } from '../ui/PickupNotification';
import { DialogueUI } from '../ui/DialogueUI';
import { createPanel, drawPanelBase, SKINS } from '../ui/PanelSkin';
import { UITheme } from '../ui/UITheme';
import { preloadUITextures } from '../ui/UITextures';
import { preloadUIIcons } from '../ui/UIIcons';
import { ContinueIndicator } from '../ui/components/ContinueIndicator';
import { EncounterUI } from '../ui/EncounterUI';
import { ActionChoiceUI } from '../ui/ActionChoiceUI';
import { PressureHoldUI } from '../ui/PressureHoldUI';
import { PressureHoldManager } from '../systems/pressureHold/PressureHoldManager';
import { SignalCueManager } from '../systems/SignalCueManager';
import { HealthSystem } from '../systems/HealthSystem';
import { RetrySystem } from '../systems/RetrySystem';
import { HealthThreatSystem, type HealthThreatSource } from '../systems/HealthThreatSystem';
import { STRIKE_BRANCH_LIGHTS, STRIKE_CHANNEL_LIGHT_SEGMENTS, StrikeLightRig, seededUnitPair, type StrikeLightSpec } from '../systems/strikeLight';
import { boltInstanceSeed, boltLightPolylines, createBolt } from '../systems/vfx/vfxBolt';
import type { VfxInstanceStartInfo } from '../systems/vfx/VfxSystem';
import { GameClock } from '../systems/gameClock';
import type { ActionExecScope } from './ActionExecutor';
import type { PerformanceSession } from '../systems/performanceSession';
import { PerformanceSessionManager } from '../systems/performanceSession';
import { isPresentationOnlyAction } from './actionParamManifest';
import { FireProtectionSystem, type ProtectionFireSource } from '../systems/FireProtectionSystem';
import type { ConditionExpr } from '../data/types';
import type { ContactAoDef } from '../data/types';
import { SmellSystem } from '../systems/SmellSystem';
import { FootstepSystem, type FootstepEmitter, type FootstepSpatialContext } from '../systems/FootstepSystem';
import { FollowerFootstepSystem } from '../systems/FollowerFootstepSystem';
import {
  DEFAULT_LISTENER_BACK_AT_BASE_ZOOM_WU,
  DEFAULT_PLANAR_DEPTH_SCALE,
  cameraBackWu,
  cameraListener,
  isSuspectWuPerQUnit,
  planarResolver,
  resolveSurfaceWorld,
  resolveWorld,
  type AudioListenerSnapshot,
  type AudioPerspective,
  type AudioSpaceResolver,
} from '../utils/audioSpace';
import { PlaneReconciler } from '../systems/PlaneReconciler';
import { NpcScheduleSystem } from '../systems/NpcScheduleSystem';
import { TrajectorySystem } from '../systems/TrajectorySystem';
import { HUD } from '../ui/HUD';
import type { SmellProfilesRaw } from '../ui/smell/SmellIndicatorRenderer';
import type {
  AudioListenerConfig,
  CollisionSidecar,
  FootstepConfig as FootstepConfigData,
  LightDef,
  NpcDef,
  PositionRef,
  VfxFieldDef,
  VfxFlockState,
  TrajectoryPlayOptions,
  TrajectorySpawnSpec,
} from '../data/types';
import { NotificationUI } from '../ui/NotificationUI';
import { QuestPanelUI } from '../ui/QuestPanelUI';
import { QuestBannerUI } from '../ui/QuestBannerUI';
import { GuidanceLayerUI } from '../ui/GuidanceLayerUI';
import { InventoryUI } from '../ui/InventoryUI';
import { RulesPanelUI } from '../ui/RulesPanelUI';
import { DialogueLogUI } from '../ui/DialogueLogUI';
import { BookshelfUI } from '../ui/BookshelfUI';
import { BookReaderUI } from '../ui/BookReaderUI';
import { CharacterBookUI } from '../ui/CharacterBookUI';
import { LoreBookUI } from '../ui/LoreBookUI';
import { SlangBookUI } from '../ui/SlangBookUI';
import { RhymeBookUI } from '../ui/RhymeBookUI';
import { ClueBookUI } from '../ui/ClueBookUI';
import { setClueAccess } from '../ui/clueAccess';
import { setFocusChangeSound } from '../ui/components/UIFocus';
import { isConfirmDialogOpen } from '../ui/components/UIConfirmDialog';
import { isTextPromptOpen } from '../ui/components/UITextPromptDialog';
import { DocumentBoxUI } from '../ui/DocumentBoxUI';
import { ShopUI } from '../ui/ShopUI';
import { MapUI } from '../ui/MapUI';
import { MenuUI } from '../ui/MenuUI';
import { RuleUseUI } from '../ui/RuleUseUI';
import { DebugPanelUI } from '../ui/DebugPanelUI';
import { GameStateController } from './GameStateController';
import { StringsProvider } from './StringsProvider';
import { TextDisplaySettings } from './TextDisplaySettings';
import { SmellDisplaySettings } from './SmellDisplaySettings';
import { GameState, normalizeEmoteBubbleScale } from '../data/types';
import type {
  ActionDef,
  IGameSystem,
  AnimationSetDef,
  DialogueEndPayload,
  DialogueLine,
  DialoguePortraitRef,
  GameConfig,
  MapConfigFile,
  MapNodeDef,
  EntityShadowBinding,
  SceneData,
  SceneDataRaw,
  SceneLightingDef,
  ScenarioCatalogFile,
  SceneLightEnv,
  ICutsceneActor,
  ITrajectoryTarget,
  TrajectoryTargetRef,
  HotspotDisplayImage,
  IEmoteBubbleAnchor,
  CharacterRegistryFile,
  PlayerVerb,
  ISaveDataProvider,
  TimeTransition,
  DialogueLogEntry,
  GameLogLink,
} from '../data/types';
import { buildCharacterRegistry } from '../data/characterRegistry';
import { DEFAULT_ENTITY_PIXEL_DENSITY_BLUR_SCALE } from '../rendering/EntityPixelDensityMatch';
import type { AnimationSetDefInput } from '../data/resolveAnimationSet';
import { loadSocketsForAnim, type ResolvedSockets } from '../data/animationSockets';
import { normalizeAudioCue } from '../data/audioCue';
import {
  DEFAULT_OVERLAY_SFX_CUE,
  overlayImagePath,
  overlayImageSfxCue,
  parseOverlayImages,
  type OverlayImageTable,
  type OverlaySfxCue,
} from '../data/overlayImages';
import {
  parsePropPresets,
  resolvePropAttach,
  type PropFlameDef,
  type PropPresetTable,
  type ResolvedPropAttach, parsePropEffects, type PropEffectTable } from '../data/propPresets';
import { normalizeAnimationSetDef } from '../data/resolveAnimationSet';
import { resolveAssetPath, resolvePathRelativeToAnimManifest } from './assetPath';
import { createPlaceholderPlayerTextures } from '../rendering/PlaceholderFactory';
import type { Npc } from '../entities/Npc';
import type { Hotspot } from '../entities/Hotspot';
import { registerActionHandlers, auditActionRegistrationsAgainstManifest, cancelSceneDimRamps,
  type StrikeThreatOptions, type StrikeThreatResult } from './ActionRegistry';
import { collectRecentPageErrors, installPageErrorTrap } from './pageErrorTrap';
import { DeterministicRandom } from '../utils/deterministicRandom';
import { ScenarioStateManager } from './ScenarioStateManager';
import { NarrativeStateManager, type NarrativeSignal } from './NarrativeStateManager';
import {
  fetchNarrativeDebugPref,
  installNarrativeDebugBridge,
  resolveNarrativeDebugStartup,
  saveNarrativeDebugPref,
  type NarrativeDebugBridgeHandle,
} from '../dev/narrativeDebugBridge';
import { DocumentRevealManager } from '../systems/DocumentRevealManager';
import { RuleOfferRegistry } from './RuleOfferRegistry';
import { InteractionCoordinator } from './InteractionCoordinator';
import { EventBridge } from './EventBridge';
import { DebugTools, type ScenarioDebugPanelRow, type LightingSyncHooks } from './DebugTools';
// 运行时编辑模式（DEV 专用，在真实画面里摆灯）。与 DebugTools 同款门控：
// 静态 import，但只在 `import.meta.env.DEV` 分支里实例化，prod build 整块剔除。
import { AuthoringMode } from '../authoring/AuthoringMode';
import { RuntimeLightingSync } from '../dev/runtimeLightingSync';
import type { LightSpaceGeometry } from '../authoring/lightSpace';
import { reportDevError } from './devErrorOverlay';
import { SceneDepthSystem } from './SceneDepthSystem';
import {
  CharacterLightingSystem,
  type CharShadingEntityInfo,
} from './CharacterLightingSystem';
import { resolveSurfaceDefaults } from '../rendering/lighting/surfaceMask';
import { SceneLightingSystem } from './SceneLightingSystem';
import { UnifiedCharacterLighting } from './UnifiedCharacterLighting';
import {
  lightDirFromShadowScreenAngle, resolveBindingLightDir, resolveBoundShadow,
  type ShadowBindingContext,
} from '../rendering/entityShadowBinding';
import { ALL_SHADOWS_ON, npcShadowFlags, playerShadowFlags, type EntityShadowFlags } from '../rendering/entityShadowFlags';
import { resolveContactAo } from '../rendering/contactAo';
import {
  indirectUpperMoment, lightGroundSources, resolveContactAoSources, type ContactAoSource,
} from '../rendering/contactAoSources';
import { CharacterShadingFilter } from '../rendering/CharacterShadingFilter';
import { getNormalAtlasSource, normalAtlasUrlFor } from '../rendering/spriteNormalAtlas';
import type { LitShaderProvider, SpriteEntity } from '../rendering/SpriteEntity';
import { WaterMinigameManager } from '../systems/waterMinigame/WaterMinigameManager';
import { SugarWheelMinigameManager } from '../systems/sugarWheel/SugarWheelMinigameManager';
import { PaperCraftMinigameManager } from '../systems/paperCraft/PaperCraftMinigameManager';
import { ObjectExamineManager } from '../systems/objectExamine/ObjectExamineManager';
import { DepthDebugVisualizer } from '../debug/DepthDebugVisualizer';
import type { IEntityShadingFilter } from '../rendering/EntityLightingFilter';
import { resolveLightEnv, type ResolvedLightEnv } from '../rendering/lightEnv';
import {
  prepareLightCurve,
  projectToCurveT,
  interpolateLightEnv,
  copyResolvedInto,
  type PreparedLightCurve,
} from '../rendering/lightEnvCurve';
import { buildIrradianceProbe } from '../rendering/irradianceProbe';
import { PlanarEntityShadow } from '../rendering/EntityShadow';
import type { ContactAoParams, ShadowSource, IEntityShadow } from '../rendering/entityShadowTypes';
import { UniformShadowField, type ShadowProjectionField } from '../rendering/shadowField';
import { resolveDepthFloorOffsetBoost } from '../utils/depthFloorZones';
import { transitionIsCovered } from '../utils/sceneAppearance';
import {
  createPerspectiveScaleResolver,
  createPerspectiveCameraFollowResolver,
  type PerspectiveCameraFollowResolver,
  type PerspectiveScaleResolver as ScenePerspectiveScaleResolver,
} from '../utils/perspectiveScale';
import type { ConditionEvalContext } from '../systems/graphDialogue/evaluateGraphCondition';
import { evaluateConditionExpr } from '../systems/graphDialogue/evaluateGraphCondition';
import { isPointInPolygon, isValidZonePolygon } from '../utils/zoneGeometry';
import { hotspotCollisionPolygonToWorld, npcCollisionPolygonToWorld } from '../utils/hotspotCollision';
import { depthLog, depthError } from './depthLog';
import { DevModeUI } from '../ui/DevModeUI';
import { resolveText, type ResolveContext } from './resolveText';
import { VfxSystem } from '../systems/vfx/VfxSystem';
import { CanvasStageSystem } from '../systems/canvas/CanvasStageSystem';
import { BurnSystem, type BurnEntityHost, type BurnHeldHost } from '../systems/burn/BurnSystem';
import { burnEntityPlacement, burnFrameFromCorners, burnPlacementFrame } from '../systems/burn/burnGeometry';
import { burnableWorldSize, type ResolvedBurnable } from '../data/burnables';
import { IgnitePerformer } from '../systems/burn/ignitePerformer';
import { BurnRenderer } from '../rendering/burn/BurnRenderer';
import { loadBurnImageData } from '../rendering/burn/burnImageData';
import type { VfxFireSegment } from '../data/types';
import { FLICKER_PUSH_HZ_CHOICES, HeldPropSystem, PROP_CONTROL_KEYS, type HeldIgniteResult } from '../systems/heldProp/HeldPropSystem';
import { createFieldVfxSpace, createPlanarVfxSpace, type VfxSpace } from '../systems/vfx/vfxSpace';
import { RuntimeSwaySync, swayPreviewDirUrl } from '../dev/runtimeSwaySync';
import { RuntimeTerrainSync, terrainPreviewDirUrl } from '../dev/runtimeTerrainSync';
import { SceneWindState, sampleSceneWind } from '../utils/sceneWind';
import { SwayBackground, findSwayHostSprite, loadBackgroundSwayInput, swayInsertIndex } from '../rendering/backgroundSway';
import { normalizeForegroundLayerDefs, resolveForegroundLayers } from '../rendering/foreground/foregroundLayerDefs';
import { SceneForegroundLayers } from '../rendering/foreground/SceneForegroundLayers';
import { VfxRenderer, vfxGlPrograms, type VfxSortHost } from '../rendering/vfx/VfxRenderer';
import { VfxConfineOverlay } from '../rendering/vfx/VfxConfineOverlay';
import { GlProgramWarmup, glWarmupTargetOf } from '../rendering/glProgramWarmup';
import { socketLightWorld, viewDirWorld, worldToScene } from '../utils/sceneSpace';
import { FireHintMarker } from '../rendering/FireHintMarker';

/**
 * 揭幕前闸的限时（毫秒）。过了就先揭幕：没交给 Pixi 的 shader 第一次用到时自己编（会卡），
 * 没跑完的粒子预热按帧接着跑。shader 那头放得宽——等在遮罩下总比停在可见画面上强。
 */
const REVEAL_GATE_SHADER_TIMEOUT_MS = 15000;
const REVEAL_GATE_VFX_TIMEOUT_MS = 8000;

/** 「嗅」键。不能与 `PROP_CONTROL_KEYS` 撞（护火占 Q、点火占 T） */
const SNIFF_KEY = 'KeyV';

/** 演出里动态生成的可燃物（`spawn.burnable`）玩家能按 E 点时的交互范围（wu；与样例可燃热点同尺度） */
const SPAWNED_BURNABLE_INTERACTION_RANGE = 60;
import { mergeGameConfig } from './gameConfigMerge';
import { BubbleChatterSystem, type BubbleSpeakerRef } from '../systems/BubbleChatterSystem';
import { PlayerIdleBehaviorSystem } from '../systems/PlayerIdleBehaviorSystem';
import { setTextPalette, stripStyleMarkup } from './textStyle';
import { waitClickContinueWithHint } from '../ui/ClickContinuePrompt';

/**
 * 屏底对白框占掉的高度（BOX_MARGIN 20 + BOX_HEIGHT 230）。
 * 供「点击继续」这类贴屏底的提示语让开——不让就会横穿对白框的底部木框。
 * ⚠ DialogueUI / CutsceneRenderer 的框高改了，这里要跟。
 */
const DIALOGUE_BOX_BOTTOM_BAND = 250;
import { TouchMobileControls } from '../ui/TouchMobileControls';
import {
  resolveScriptedSpeakerDisplay,
  resolveScriptedSpeakerEntity,
  scriptedSpeakerEntityFromId,
  type ScriptedSpeakerEntity,
} from '../utils/scriptedDialogueSpeaker';
import { resolveSpeakerSide } from '../utils/dialogueSpeakerSide';
import { Container, Culler, Graphics, Rectangle, RenderTexture, Sprite, Texture, UPDATE_PRIORITY } from 'pixi.js';
import { bakeKeyFromBackground, breathingJsonUrl, dialogueGraphJsonUrl, sceneBakeDirUrl, sceneJsonUrl, sceneRuntimeAssetUrl, TEXT_URLS, trajectoryJsonUrl } from './projectPaths';
import type { TrajectoryAsset, TrajectoryKeyframe } from '../data/types';
import type { TrajectoryEndReason } from '../systems/TrajectorySystem';
import {
  basisRowsFromDepthConfigR,
  flipTrajectoryKeyframes,
  projectWorldKeyframes,
} from '../utils/trajectoryProjection';
import {
  evaluatePositionRefNow, parsePositionRef, positionRefAssetProblem,
  resolvePositionRef as resolvePositionRefPure, trajectoryBinding, trajectoryOrigin,
  type PositionRefNowLookups,
} from '../utils/positionRef';
import { makeOwnerOrigin, resolveDialogueOwner } from './actionOrigin';
import {
  coerceRuntimeFieldValue,
  getRuntimeFieldDescriptor,
  isHotspotDisplayImage,
  type RuntimeFieldValue,
  type SceneEntityKind,
} from '../data/EntityRuntimeFieldSchema';
import { installRuntimeErrorsToDebugPanel } from '../debug/debugPanelRuntimeLog';
import {
  drainWebGLErrorsToPanel,
  logDepthTextureGpuStatus,
  pixiInitTextureSourceForGpu,
  tryGetWebGlFromApplication,
} from '../debug/webglPanelDiagnostics';
import { warmUpBackgroundDebugGlProgramForDiagnostics } from '../rendering/BackgroundDebugFilter';
import { warmUpDepthOcclusionGlProgramForDiagnostics } from '../rendering/DepthOcclusionFilter';

export interface GameStartOptions {
  devMode?: boolean;
  playCutscene?: string;
  /** 配合 playCutscene：顶层步下标，之前的步瞬时快进后从该步起常速（URL `play_cutscene_from=`） */
  playCutsceneFrom?: string;
  /** 开发模式下直接进入指定场景（URL `devScene=` / `dev_scene=`） */
  devScene?: string;
  /** 开发模式下直接进入指定叙事跳转（URL `narrativeWarp=` / `narrative_warp=`） */
  narrativeWarp?: string;
  /** 开发模式下直接进入指定水域小游戏实例（由编辑器预览 URL `waterPreview=` 传入） */
  waterPreview?: string;
  /** 开发模式下直接进入指定转盘小游戏实例（URL `sugarWheelPreview=`） */
  sugarWheelPreview?: string;
  /** 开发模式下直接进入指定扎纸小游戏实例（URL `paperCraftPreview=`） */
  paperCraftPreview?: string;
  /** 自动视觉基准模式：保留 dev 直达能力，但不打开 DevMode 遮罩。 */
  visualCapture?: boolean;
  /**
   * 停在标题界面启动，**不装载世界**（URL `screen_title`，由「返回主菜单」整页重启带入）。
   * 标题界面因此是真正的"已退出这一局"：没有场景在跑、没有 HUD、子面板底下也没有东西可漏。
   */
  startAtTitle?: boolean;
  /** 启动即读这个存档槽（URL `load_slot`，标题界面点「继续」走的路） */
  loadSlot?: number;
}

declare global {
  interface Window {
    __gameDevAPI?: {
      /**
       * 当前场景的统一光影参数，供编辑器「从运行时拉取灯位」。
       * 只读、不碰磁盘；没进场景 / 没配 lighting 时返回 null。
       */
      getSceneLightingForEditor(): { sceneId: string; lighting: unknown } | null;
      /** @param fromStep 顶层步下标：之前的步瞬时快进建立画面状态，从该步起常速排演 */
      playCutscene(id: string, fromStep?: number): void;
      /** 编辑器缩略条播放头轮询用：当前播到哪段过场的哪一步（未播放时 path 为 null） */
      getCutscenePlayback(): { cutsceneId: string | null; path: string | null; label: string | null };
      reload(): void;
      isReady(): boolean;
      /** 重新打开 Dev Mode 面板（从场景列表跳转后不会自动再开） */
      openDevPanel(): void;
      getNarrativeDebugSnapshot(): Record<string, unknown>;
      clearNarrativeDebugTrace(): void;
      emitNarrativeSignal(signal: { sourceType: string; sourceId: string; signal: string; ownerType?: string; ownerId?: string }): Promise<void>;
      debugSetNarrativeState(graphId: string, stateId: string): Promise<void>;
      setNarrativeState(graphId: string, stateId: string): Promise<void>;
      setDepthDebug(enabled: boolean): void;
      /** skyao（天穹遮蔽，乘在角色 GI 上）与全白的 blend：0=不遮蔽 1=完整。 */
      setSkyaoBlend(v: number): void;
      getSkyaoBlend(): number | null;
      /** skyao 载荷实况:没载上时 on=false,此时 blend 拨到哪都没效果。 */
      getSkyaoInfo(): { on: boolean; n?: number[]; tiles?: number[]; blend: number } | null;
      /** 角色调试视图:0=正常 1=法线 2=skyao 的 V(灰度)。 */
      setCharDebugView(mode: number): void;
      clearWorldFilter(): void;
      setWorldFadeAlpha(alpha: number): void;
      completeDialogueText(): void;
      completeCutsceneText(): boolean;
      startMinigame(kind: 'water' | 'sugarWheel' | 'paperCraft' | 'pressureHold' | 'objectExamine', id: string): Promise<boolean>;
      stepFixedTicks(ticks: number, dtMs: number): Promise<void>;
      getMinigameDebugState(): Record<string, unknown>;
      playAudioProbe(id: string, fadeMs: number): void;
      getAudioDebugState(): Record<string, unknown>;
      /**
       * 脚步与空间化音频的可判定状态。**脚步靠听没法做回归**——
       * 「走过木栈道那段响的是不是栈道音」「有没有连续两次同一变体」
       * 「镜头拉远是不是变轻了」「这个场景是 field 还是 planar」全靠这份。
       */
      getFootstepDebugState(): Record<string, unknown>;
      /** 改听者（`{mode:'camera'|'player'|'npc'|'fixed', ...}`）；null 回到配置缺省。 */
      setAudioListener(cfg: AudioListenerConfig | null): void;
      suppressSceneEnterForVisualCapture(): void;
      /**
       * 编辑器气泡锚控件的「同步到游戏」：在真场景真透视里把气泡摆到 anchorY 看一眼。
       * anchorY 省略 = 用实体自算档（看默认落点）。返回是否找到了 target。
       */
      previewBubbleAnchor(req: { target: string; anchorY?: number; emote?: string; scale?: number }): boolean;
      clearBubbleAnchorPreview(): void;
    };
  }
}

/** 编辑器气泡锚预览气泡的归属标记：只清自己这一路，不误伤对话/过场的气泡。 */
const BUBBLE_ANCHOR_PREVIEW_OWNER = 'editor-bubble-anchor-preview';

/**
 * 统一角色光影路径的总闸。**2026-08-30 起常关。**
 *
 * 制作人定调「原画就是最终的光照」，场景侧已去掉整体重打光；统一角色 shader 的环境项
 * 是合成天光 × 天穹可见性，那是给"被重打光的场景"配套的，原画不再重打光之后它不对应
 * 任何东西。角色一律走 probe（同一张原画烘出来的 GI 底光）+ 实体灯加性叠加。
 *
 * 代码不删：统一光影的几何半（3D 天穹网格 / GI 反弹）后面可能还要用。
 */
const UNIFIED_CHAR_PATH_ENABLED = false;


/** dev 菜单「叙事」跳转配置（public/assets/data/dev_narrative_warps.json）。 */
type DevNarrativeWarp = {
  id: string;
  label: string;
  scene: string;
  /** 落地出生点（场景 spawnPoints 的键）；不写 = 场景缺省出生点 */
  spawn?: string;
  flowGraph?: string;
  flowState?: string;
  set?: Array<{ graph: string; state: string }>;
};

/** runtime-debug-snapshot 客户端兜底字节上限。服务端硬限 2_000_000（vite.config.ts），
 *  此处留边界余量，超限即丢弃最重的 eventTrace 后再上报，防 413 与主线程卡顿。 */
const RUNTIME_DEBUG_SNAPSHOT_MAX_BYTES = 1_900_000;

/** 热区展示图的接触 AO：简单 AO（没有作者面，方向 AO 缺省开只针对角色，见 buildHotspotShadowEntry）。 */
const HOTSPOT_CONTACT_AO: ContactAoDef = Object.freeze({ directional: false });

/**
 * 每实体阴影 entry。
 *
 * `shadow` = 没配绑定时的手调单影（兼 deferred 实现）；
 * `extra` = 配了绑定时的 planar 剪影，与 `EntityShadowBinding[]` **逐条对位**。
 *
 * 2026-08-20 起没有"槽位分配"这回事了：作者列表里的第 i 条就是第 i 个实例，
 * 不投影的那条把浓度压到 0。旧的按光源身份绑槽 + 时间低通已随自动 resolve 一起删除。
 */
type EntityShadowEntry = {
  /** entityShadows map 里的键（'player' / npcId / 'hotspot:<id>'）。绑定按它查。 */
  key: string;
  shadow: IEntityShadow;
  src: ShadowSource;
  owner: unknown;
  /** 与绑定列表逐条对位的 planar 剪影（剪影形状=用户红线，不许逐像素求交） */
  extra?: IEntityShadow[];
  /** 每条 env 覆盖对象(缓存复用,避免逐帧分配) */
  envSlots?: ResolvedLightEnv[];
  /**
   * 投影 / 接触阴影各自的开关（制作人 2026-09-23：两者分开，接触阴影缺省开）。
   * 关了投影的实体照样建实例，只为画脚底接触斑；绑定的剪影也一并不画。
   */
  flags: EntityShadowFlags;
  /** 这个实体的接触 AO 作者配置（NPC `contactAo` / 场景 `playerContactAo`；热区无，恒缺省）。 */
  aoDef: ContactAoDef | null;
  /** 主实例按 flags 熄掉某一样时用的 env 覆盖对象（缓存复用） */
  mainEnv?: ResolvedLightEnv;
};

/**
 * 冻主 tick 的原因。两个来源互相独立、可以同时成立，见 `logicFreezeReasons`。
 * · `narrative` = 叙事断点命中，等调试器发「继续」
 * · `authoring` = 进了运行时编辑模式（`src/authoring`），DEV 专用
 */
type LogicFreezeReason = 'narrative' | 'authoring';

/**
 * 运行时灯的来源。`SceneLightingSystem.setDynamicLights` 是**整表覆盖**，
 * 各来源各推各的会互相冲掉，所以在 {@link Game.setDynamicLightsFrom} 里按来源存、合成后整份推。
 * 次序即优先级（灯槽满了按数组次序截断）：落雷 > 手上举着的 > 烧着的。
 */
type DynamicLightOwner = 'prop' | 'burn' | 'strike';

/** `AudioListenerConfig`（脚步配置 / 动作 / 调试命令那套）→ 统一听者绑定。 */
/** 正数才算数：0 / 负数 / NaN 一律当"没给"，回落到下一层——否则一个手写的 0 会把视距钉在耳朵上。 */
function positiveOrUndefined(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

function mapListenerConfig(c: AudioListenerConfig): {
  mode: 'player' | 'camera' | 'entity' | 'fixed'; entityId?: string; heightWu?: number;
  at?: { x: number; y: number };
} {
  if (c.mode === 'npc') return { mode: 'entity', entityId: c.targetId, heightWu: c.heightWu };
  if (c.mode === 'fixed') {
    return typeof c.x === 'number' && typeof c.y === 'number'
      ? { mode: 'fixed', at: { x: c.x, y: c.y }, heightWu: c.heightWu }
      : { mode: 'camera', heightWu: c.heightWu };
  }
  return { mode: c.mode, heightWu: c.heightWu };
}

export class Game {
  private eventBus: EventBus;
  private flagStore: FlagStore;
  private stringsProvider: StringsProvider;
  private inputManager: InputManager;
  private assetManager: AssetManager;
  private actionExecutor: ActionExecutor;
  private renderer: Renderer;
  private camera: Camera;
  private player: Player;
  private interactionSystem: InteractionSystem;
  private playerActionSystem: PlayerActionSystem;
  private sceneManager: SceneManager;
  private dialogueManager: DialogueManager;
  private graphDialogueManager: GraphDialogueManager;
  private scenarioStateManager: ScenarioStateManager;
  private narrativeStateManager: NarrativeStateManager;
  private documentRevealManager: DocumentRevealManager;
  private questManager: QuestManager;
  private narrativePackageDirector!: NarrativePackageDirector;
  private rulesManager: RulesManager;
  private inventoryManager: InventoryManager;
  private encounterManager: EncounterManager;
  private audioManager: AudioManager;
  /** 台词配音通道（过场 / 世界对话 / 气泡共用一条，见 systems/VoiceChannel） */
  private voiceChannel: VoiceChannel;
  /** 世界对话的配音导演：把 dialogue:line 翻成配音通道调用（不进 registeredSystems，无存档态） */
  private dialogueVoiceDirector: DialogueVoiceDirector;
  /** 玩家的文字呈现偏好（逐字显示开关 / 速度）：设置页写、对白框与遭遇框读 */
  private textDisplaySettings: TextDisplaySettings;
  private smellDisplaySettings: SmellDisplaySettings;
  private dayManager: DayManager;
  private cutsceneManager!: CutsceneManager;
  private cutsceneRenderer!: CutsceneRenderer;
  private resolveActorFn!: (id: string) => ICutsceneActor | null;
  /** pollEmoteTarget 上次记日志时的结果：`轮询方\0目标 id` → `场景\0hit|miss`（只存串，不攥实体引用） */
  private emoteTargetPollOutcomes = new Map<string, string>();
  /** 相机跟随目标实体 id（cameraFollowActor 设、cameraStopFollow 清）：过场 / 动作链 / 对话态每帧锚到该
   *  实体实时坐标；null=默认锚点（探索/动作链跟玩家）。回到自由探索由主循环自动解除，不入存档。 */
  private cameraFollowTargetId: string | null = null;
  /**
   * 相机跟随一个**位置引用**（cameraFollowActor 的 `at`，2026-09-12）：每帧求值，与 `cameraFollowTargetId`
   * 二选一（设一个就清另一个）。求不出（曲线还没开播 / 实体暂不在）= 镜头原地不动、**不解除**——
   * 引用点还没产生，没东西可跟；播完了播放头停在终点，镜头也就停在终点。解除时机同实体跟随。
   */
  private cameraFollowRef: PositionRef | null = null;
  /** 每帧求值用的查找（一次建好复用，不每帧分配） */
  private positionRefNowLookups: PositionRefNowLookups | null = null;
  /** 跟随模式：true=硬锁居中（每帧 snapTo，逐帧锁定），false=平滑跟随（camera.follow 插值）。 */
  private cameraFollowSnap = true;
  /** 地图节点 sceneId -> 显示名；供 [tag:scene:…] 与 NPC 全局名缓存扫描 */
  private sceneDisplayNameById = new Map<string, string>();
  private npcDisplayNameById = new Map<string, string>();
  private archiveManager: ArchiveManager;
  private clueManager!: ClueManager;
  private systemNoteManager!: SystemNoteManager;
  private gameLogManager!: GameLogManager;
  private emoteBubbleManager: EmoteBubbleManager;
  private ruleOfferRegistry: RuleOfferRegistry;
  private zoneSystem: ZoneSystem;
  private saveManager!: SaveManager;
  private inspectBox!: InspectBox;
  private pickupNotification!: PickupNotification;
  private dialogueUI!: DialogueUI;
  private encounterUI!: EncounterUI;
  private actionChoiceUI!: ActionChoiceUI;
  private hud!: HUD;
  private notificationUI!: NotificationUI;
  private questPanelUI!: QuestPanelUI;
  /** 新任务醒目横幅（D9）；常驻展示件，不进面板栈 */
  private questBannerUI!: QuestBannerUI;
  /** 任务引导层（D8）：场景内浮标 / 出屏箭头 / 场景提示 */
  private guidanceLayerUI!: GuidanceLayerUI;
  private inventoryUI!: InventoryUI;
  private rulesPanelUI!: RulesPanelUI;
  private dialogueLogUI!: DialogueLogUI;
  private bookshelfUI!: BookshelfUI;
  private bookReaderUI!: BookReaderUI;
  private shopUI!: ShopUI;
  private mapUI!: MapUI;
  private menuUI!: MenuUI;
  private ruleUseUI!: RuleUseUI;
  private debugPanelUI!: DebugPanelUI;
  /** 叙事调试器桥（dev 才装；开关见 setupNarrativeDebugBridge，可现场开关） */
  private narrativeDebugBridge: NarrativeDebugBridgeHandle | null = null;
  /** `window.__ndbg` 是这一局挂的（destroy 要删，否则指着已销毁的实例） */
  private narrativeDebugConsoleApiInstalled = false;
  /** 人已经自己扳过叙事调试开关：工程文件那次异步读回来后不许再覆盖 */
  private narrativeDebugUserDecided = false;
  private narrativeDebugListeners: [string, (payload: unknown) => void][] = [];
  /** 过场当前 step 调试浮层（dev / ?cutsceneDebug） */
  private cutsceneStepHudEl: HTMLElement | null = null;

  private stateController: GameStateController;
  private lastTime: number = 0;
  private lastFps: number = 0;
  private playTimeMs: number = 0;
  private readonly runtimeRandom = new DeterministicRandom('gamedraft-runtime-v1');
  /**
   * 纯表现系统（头顶闲聊 / 主角待机）专用随机。**不能共用 runtimeRandom**——那条的
   * state 进存档、且 randomBranch 从同一条取值，让表现层去消耗它会使"玩家有没有从
   * NPC 旁边走过"改变后续 randomBranch 的结果（实测掷到的数确实不同）。
   */
  private readonly presentationRandom = new DeterministicRandom('gamedraft-presentation-v1');
  private playerAnimDef: AnimationSetDef | null = null;

  private interactionCoordinator!: InteractionCoordinator;
  private eventBridge!: EventBridge;
  /** T1：仅 DEV 装配（F10 坐标、中键缩放、F2 调试区块等纯开发设施），生产为 null */
  private debugTools: DebugTools | null = null;
  /**
   * F2「光影」页交出来的独奏钩子（装配光影页时注入；prod 不装配）。
   * 独奏是临时视图态：同步在独奏期间**只发不收**，且发出去的那份要先还原。
   */
  private lightingSyncHooks: LightingSyncHooks | null = null;
  /** 场景光照的双向实时同步（DEV 专用，走 dev server 的同步槽） */
  private lightingSync: RuntimeLightingSync | null = null;
  /** 声学工作台 ↔ 游戏的实时联动（游戏只是预览器）。DEV 专用。 */
  private acousticsSync: RuntimeAcousticsSync | null = null;
  private vfxSync: RuntimeVfxSync | null = null;
  private burnSync: RuntimeBurnSync | null = null;
  /** 呼吸工作台 ↔ 游戏的实时联动(游戏只是预览器)。DEV 专用。 */
  private breathingSync: RuntimeBreathingSync | null = null;
  /** 呼吸图(盖脸纸那类「一张静帧实时在呼吸」的叠图)的实例持有者 */
  private breathingOverlaySystem!: BreathingOverlaySystem;
  /** 运行时编辑模式（DEV 专用）。null = 生产构建，或还没装配到。 */
  private authoringMode: AuthoringMode | null = null;
  private unsubAuthoringHotkey: (() => void) | null = null;
  private sceneDepthSystem: SceneDepthSystem;
  private readonly strikeGroundAllowed = (x: number, y: number): boolean => this.sceneDepthSystem.collisionAt(x, y) === false;
  /** 角色照明(烘焙 probe 消费端);载荷缺失/过期时 inactive,回落旧色调管线 */
  private characterLighting: CharacterLightingSystem;
  /** 统一光影系统（lighting-rebuild）。场景未配 `lighting` 块时整体不启用。 */
  private sceneLighting: SceneLightingSystem;
  /** 角色并入统一光影的那一路。未启用时实体回落 `characterLighting` 的 probe 路径。 */
  private readonly unifiedCharLighting = new UnifiedCharacterLighting();
  /**
   * 时段变了、外观还没换。**不在 phaseChanged 那一拍换**：advanceTimeTo 多半是从
   * 对话/过场里发出的，当场拆场景等于拆掉正在播的那场演出（连同发出这条命令的它自己）。
   * 由 tick 在探索态且没有切场在途时消费，见 `drainPendingPhaseSwap`。
   */
  private pendingPhaseSwap = false;
  /** 上条 `phaseChanged` 声明的表现档；决定换装那一拍遮不遮幕（见 `TimeTransition`）。 */
  private pendingPhaseSwapTransition: TimeTransition = 'timelapse';
  /** 换装重载（含遮幕淡入淡出）在途；期间不受理第二次，见 `drainPendingPhaseSwap` 第 ④ 闸。 */
  private phaseSwapInFlight = false;
  private waterMinigameManager: WaterMinigameManager;
  private sugarWheelMinigameManager: SugarWheelMinigameManager;
  private paperCraftMinigameManager: PaperCraftMinigameManager;
  private objectExamineManager: ObjectExamineManager;
  private pressureHoldManager: PressureHoldManager;
  private signalCueManager: SignalCueManager;
  private bubbleChatterSystem: BubbleChatterSystem;
  private playerIdleBehaviorSystem: PlayerIdleBehaviorSystem;
  private healthSystem: HealthSystem;
  private retrySystem: RetrySystem;
  private healthThreatSystem = new HealthThreatSystem();
  private fireProtectionSystem = new FireProtectionSystem();
  private yinThreatsVisible = false;
  private systemNotePauseDepth = 0;
  /**
   * 游戏时钟：**演出时间的唯一来源**（`waitMs` / 天色渐变 / 连劈间隔 / 雷柱软停）。
   * 只在世界没暂停时前进——见 {@link isWorldPaused}。
   */
  private readonly gameClock = new GameClock();
  private smellSystem: SmellSystem;
  private planeReconciler: PlaneReconciler;
  private npcScheduleSystem: NpcScheduleSystem;
  /** 烘焙式实体轨迹动画的播放系统（表演态，不入档；切场景/读档由本类显式 cancelAll） */
  private trajectorySystem: TrajectorySystem;
  /**
   * 轨迹资产缓存（id → 资产 / null=缺失）。资产是全局文件，与场景无关，整个会话有效；
   * 缺失也缓存，免得每次播放都去探一次 HEAD 并刷一遍 warn。
   */
  private trajectoryAssets = new Map<string, TrajectoryAsset | null>();
  private smellProfilesData: SmellProfilesRaw | null = null;
  private footstepSystem: FootstepSystem;
  /**
   * 跟脚声：玩家落脚事件的延迟重放（「你走他才走」）。开关是 `setFollowerFootsteps` 动作，
   * 与阴间威胁的扣血**正交**——声音在这儿，伤害仍在 `healthThreatSystem`。
   */
  private followerFootsteps: FollowerFootstepSystem;
  /** `footstep_sets.json`；缺文件 = 全局无脚步声（不是错误，只是没配）。 */
  private footstepConfig: FootstepConfigData | null = null;
  /**
   * 运行时对听者绑定的**覆盖**（动作 `setAudioListener` / 调试命令）；null = 没覆盖，按
   * 场景 → 空间 → 脚步配置 → 相机 的顺序取。**不入存档**（它是表现设置不是玩法状态）。
   */
  private audioListenerOverride: AudioListenerConfig | null = null;
  /** 上一帧解出的听者与精度级别，只供调试输出（不参与任何计算）。 */
  private audioSpaceDebug: {
    mode: 'field' | 'planar';
    listenerMode: string;
    listenerFallback: boolean;
    backWu: number;
    /** 脚步走没走空间化（`footstep_sets.json` 的 `defaults.spatialized`） */
    footstepSpatialized: boolean;
  } | null = null;
  private pressureHoldUI!: PressureHoldUI;
  private depthDebugVisualizer!: DepthDebugVisualizer;
  private playerDepthFilter: IEntityShadingFilter | null = null;
  /** 视锥剔除:屏外 NPC/热点不进 GPU 渲染。写 Pixi 原生 culled 位(localDisplayStatus 第 3 bit),
   *  与实体显隐四通道的 visible 完全正交——绝不碰实体 visible 合成(见 entity-visibility-channels)。
   *  默认开(生产也跑),F2 可切;玩家容器恒不剔。 */
  private frustumCullingEnabled = true;
  /** 剔除上一帧是否活跃:关闭时据此一次性清 culled,避免残留实体隐身 */
  private frustumCullingWasActive = false;
  /** F2 probe 点云调试覆盖层(世界坐标系,随相机;场景卸载即销毁) */
  private probeVizGfx: Graphics | null = null;
  /** F2 角色照明切档(体素卷/probe 图集)正在拉取中,期间重复切档去重(见 applyCharMode) */
  private charModeSwitching = false;
  /** 场景透视缩放（近大远小）句柄：scene:ready 从场景数据构建、beforeUnload 清空；实体注入共享同一实例 */
  private perspectiveScaleResolver: ScenePerspectiveScaleResolver | null = null;
  /**
   * 相机跟随透视（需求清单 A3.5，2026-09-20）：场景写了 `perspectiveScale.cameraFollow` 才有；
   * **null 时全流程一次 zoom 都不多写**，效果与开此功能之前严格一致。与上面那个句柄同生同死。
   */
  private perspectiveCameraFollow: PerspectiveCameraFollowResolver | null = null;
  /**
   * 这一帧镜头锚在哪（世界坐标）——`applyCameraFollow` 与探索态的 `camera.follow` 各自记一笔。
   * 透视跟随按它求 f：镜头跟谁就按谁的纵深定景别（缺省玩家脚底，过场里是被跟的实体 / 曲线点）。
   */
  private cameraAnchorX = 0;
  private cameraAnchorY = 0;
  /** 世界空间粒子 / 群体（蝙蝠、滴水、香火烟、萤火）：模拟在系统层，画在实体层的批网格里 */
  private vfxSystem: VfxSystem;
  /**
   * 画布（场景之外那张屏幕空间的面）上的**实体**与**绘制顺序**。
   * 画布容器与顺序表在 `Renderer.canvasStage`；叠图 / 文档揭示仍由 `CutsceneRenderer` 放上去，
   * 四类 item 共用同一个 `order` 空间。
   */
  private canvasStageSystem: CanvasStageSystem;
  /**
   * 手持挂件（火把 / 灯笼）与运行时灯。手持物入档（玩法事实），表现全是派生的：
   * 灯与效果每帧跟着挂点走，切场景 / 读档各重派生一次。
   */
  private heldPropSystem: HeldPropSystem;
  /**
   * 燃烧系统（A3.8）：可燃物（热点）烧的状态进存档、离场照推；表现（燃烧滤镜 / 火苗 / 火光 / 火焰段）只在当前场景。
   * 点火表演（`ignitePerformer`）在 ActionSequence 里走位 + 播点火动作，接触帧点着。
   */
  private burnSystem: BurnSystem;
  private readonly burnRenderer = new BurnRenderer();
  private ignitePerformer: IgnitePerformer;
  /** 燃烧系统读的"这个场景的几何定了"：scene:ready 之后置当前场景 id，beforeUnload 清 */
  private burnSceneReadyId: string | null = null;
  private readonly heldFireScratch: VfxFireSegment[] = [];
  /** 玩家手上那支火「快灭了」的符号（火边、entityLayer 最前档；表现归组装层，数据由挂件系统逐帧推） */
  private readonly fireHintMarker = new FireHintMarker(() => this.renderer?.entityLayer ?? null);
  /**
   * 场景风：一份参数 + 一个钟。粒子（经 `VfxSystem.getWind`）与背景草木摆动（`swayBackground`）
   * 读的是同一个，所以一阵风两边同一拍（见 [[scene-wind]]）。组装层持有，逐帧推钟。
   */
  private readonly sceneWind = new SceneWindState((id, volume, weight) =>
    this.audioManager?.setAmbientPulse(id, volume, weight));
  /** 风采样的复用缓冲（热路径零分配，与粒子侧同一习惯） */
  private readonly windSampleTmp = new Float32Array(3);
  /** "这个场景没有光照、手持灯不会亮"只报一次的场景 id（见 applySceneDynamicLights） */
  private dynamicLightMuteWarnedFor = '';
  /** 没点亮的背景上的草木摆动 mesh（场景级；卸载钩子里先于纹理销毁） */
  private swayBackground: SwayBackground | null = null;
  /** 当前这份草木是不是接在打光的背景上（只产位移图、由 LitBackground 读；卸载 / 重装前要先解绑） */
  private swayLit = false;
  /** 当前场景的主背景纹理（工作台重烘后原地重装要用它重建拆层） */
  private swayPrimary: Texture | null = null;
  /** DEV：草木工作台 → 游戏的实时联动（重烘完原地重装，不切场景） */
  private swaySync: RuntimeSwaySync | null = null;
  /**
   * DEV：装完（`scene:ready` 之后）的场景 id；装载中 / 卸载后为 null。草木联动只按它轮询与心跳——
   * `currentSceneData` 在装载一开始就换成新场景，那时推来的预览会在 `buildSway` 还没装完时原地重装，把草木层弄坏；
   * 工作台看心跳"游戏进了这个场景"补发推送，正好撞在这段里。
   */
  private swayReadySceneId: string | null = null;
  /** DEV：地形工作台 → 游戏的单向槽（推给游戏 / 导出到游戏后原地换碰撞与行走面；答运行时对齐探测） */
  private terrainSync: RuntimeTerrainSync | null = null;
  /** 当前这份拆层装了哪几个纹理 URL（热重载时按它把上一份丢掉，否则每推一次漏一套显存） */
  private swayTexUrls: string[] = [];
  /**
   * 场景前景图层（[[scene-foreground-layers]]）：一张覆盖图（蒙版 + 按接地线立起来的前景面深度），
   * 交给遮挡的使用方（实体滤镜、粒子）在蒙版里顶替深度图。
   * 依附于这一份草木拆层（swayPlant 的实例按它解析、蒙版经它的位移图），所以**与 `swayBackground` 同拆同建**：
   * 每一处销毁 / 换掉 `swayBackground`、拆光照之前都先 `teardownForegroundLayers()`。
   */
  private foregroundLayers: SceneForegroundLayers | null = null;
  /** F2：前景层整体开关 / 覆盖图叠加（调试态，不入档、切场景保留勾选） */
  private foregroundEnabled = true;
  private foregroundCoverageView = false;
  private vfxRenderer: VfxRenderer | null = null;
  /** 粒子 shader 预编译：开局后台编、切场景遮罩下交给 Pixi（见 `rendering/glProgramWarmup`） */
  private glProgramWarmup: GlProgramWarmup | null = null;
  /** F2「粒子」页勾上才建：粒子区域的框线 + 边带内沿（调试叠加，不入档、不持久） */
  private vfxConfineOverlay: VfxConfineOverlay | null = null;

  /** 当前场景辐照度探针 RT（逐 entity 色调融入），场景卸载时销毁 */
  private currentProbe: RenderTexture | null = null;
  /** 当前场景解析后的光照环境（驱动阴影） */
  private currentLightEnv: ResolvedLightEnv | null = null;
  /** 当前场景的光照环境曲线（预处理累计弧长）；null=无曲线，按静态 lightEnv 走（零影响） */
  private currentLightCurve: PreparedLightCurve | null = null;
  /** 位面光照档覆盖（PlaneReconciler 经 applyPlaneLightEnvOverride 设/清）；激活期 lightEnvCurve 挂起 */
  private planeLightEnvOverride: SceneLightEnv | null = null;
  /** 阴影方向/长度来源（今天=全局 LightEnv 均匀场；将来可换成场景灯光方向场） */
  private currentShadowField: ShadowProjectionField | null = null;
  /** 光源驱动阴影:时间低通的上帧时间戳(ms) */
  private shadowDriveLastMs = 0;
  /**
   * 玩家/NPC/热点的投影阴影（key: 'player' / npc.id / `hotspot:<id>`）。
   * F2 性能：ShadowSource 按实体缓存（owner 记录实例身份，实例被过场重建时按需换源），
   * updateEntityShadows 不再逐帧新建闭包包。
   */
  private entityShadows = new Map<string, EntityShadowEntry>();
  /**
   * 实体阴影绑定表。键同 `entityShadows`（'player' / npcId / 'hotspot:<id>'）。
   *
   * **手动指定，系统不猜**（制作人 2026-08-20 定死）。进场景时从场景数据播种，
   * 之后由 `setEntityShadow` Action 改。**不入存档**——它是演出态，
   * 跟着场景数据走；存档里存一份会让"改了场景 JSON 但老档还是旧影子"。
   */
  private entityShadowBindings = new Map<string, EntityShadowBinding[]>();
  /**
   * 场景 onEnter 执行期间的隐式叙事 owner（`scene:<场景id>`）。
   * 供 onEnter 里未显式指定 owner 的 startDialogueGraph 与条件 `@owner` 继承当前场景。
   * 仅在 sceneEnterRunner 执行窗口内非空。
   */
  private ambientNarrativeOwner: { ownerType: string; ownerId: string } | null = null;

  /** null = 跟随 game_config.entityPixelDensityMatch；非 null 为调试强制开/关 */
  private entityPixelDensityMatchDebugOverride: boolean | null = null;

  /** null = 使用 game_config.entityPixelDensityMatchBlurScale；非 null 为调试倍率（仍会被夹到 0.05～5） */
  private entityPixelDensityMatchBlurScaleDebug: number | null = null;

  /** 场景卸载时递增，使旧场景的 NPC 巡逻异步循环立即失效 */
  private patrolGeneration = 0;
  /**
   * 按 NPC 递增的巡逻代；`stopNpcPatrol` Action 与对话顺序 bump，协程在 sleep/move 前后检查，无需 FlagStore。
   * 场景卸载时清空，避免与旧场景残留 token 纠缠。
   */
  private npcPatrolEpoch = new Map<string, number>();
  private mainTick: (() => void) | null = null;
  /** sprite 网格着色的共享帧组同步(挂 Pixi ticker,不经游戏状态分支;destroy 时摘除) */
  private charLitFrameSync: (() => void) | null = null;
  /**
   * 网格着色 shader 供给方:实体只管几何,shader 建/换/收归照明系统 + 法线图集寻址在这。
   *
   * **两条路径在这里分流**(2026-08-20):
   * · 场景配了 `lighting` 且烘好载荷 → 走统一光影(角色与背景同一份光、同一条显示变换)
   * · 否则 → 回落旧的 probe/体素路径
   *
   * 回收时按 `owns` 判归属,**不能按当前 active 判** —— 场景切换时新场景可能已经
   * 切到另一条路径,而待回收的 shader 还是上一条路径建的,按 active 判会销毁到错的那边。
   */
  private readonly litShaderProvider: LitShaderProvider = {
    create: (colorTex, sheetUrl) => {
      const nrm = getNormalAtlasSource(this.assetManager, sheetUrl);
      return this.unifiedCharLighting.createShader(colorTex, nrm)
        ?? this.characterLighting.createEntityLitShader(colorTex, nrm);
    },
    swapTextures: (sh, colorTex, sheetUrl) => {
      const nrm = getNormalAtlasSource(this.assetManager, sheetUrl);
      if (this.unifiedCharLighting.owns(sh)) this.unifiedCharLighting.swapTextures(sh, colorTex, nrm);
      else this.characterLighting.swapEntityLitTextures(sh, colorTex, nrm);
    },
    release: (sh) => {
      if (this.unifiedCharLighting.owns(sh)) this.unifiedCharLighting.release(sh);
      else this.characterLighting.releaseEntityLitShader(sh);
    },
  };
  /** Pixi 渲染之后 drain gl.getError（优先级 UTILITY，低于内置 render） */
  private glPostRenderDrain: (() => void) | null = null;
  private webglContextLostHandler: ((ev: Event) => void) | null = null;
  private webglContextRestoredHandler: (() => void) | null = null;
  private runtimeDebugLogCleanup: (() => void) | null = null;
  private runtimeDebugSnapshotTimer: number | null = null;
  /** 当前场景绑定的声学空间 id；每帧把解出来的听者喂给 AudioManager。 */
  private acousticSpaceId: string | null = null;
  /** 最近一次解出来的听者（脚步 / 试听 / 回音共用这一个）；实时联动把它回传给工作台画在 3D 里 */
  private acousticListenerLast: AudioListenerSnapshot | null = null;

  private runtimeCommandPollTimer: number | null = null;
  private runtimeCommandPollInFlight = false;
  /** 本次页面会话的实例 id；快照携带，命令可用 targetBootId 指向特定实例（多开页签时避免互抢） */
  private readonly runtimeBootId = Math.random().toString(36).slice(2, 10);
  private runtimeDebugSnapshotErrorLogged = false;
  private runtimeDebugSnapshotOversizeLogged = false;
  /** 「GI体」调试视图(场景光照 uDebug==5)当前是否开着,及进入前的角色太阳开关。 */
  private giVolumeDebugOn = false;
  private giVolumeDebugSunWas = false;

  /**
   * GI体档诊断参数落地:定法线(两侧同喂)+ 主角 quad 放大(把角色变成一扇
   * "探进 probe 场的窗户"——container.scale 只影响显示与 lit mesh 的世界变换,
   * 脚点/碰撞/游戏逻辑不吃它;lit mesh 的 q 由世界变换现推,放大 = 真放大采样窗口)。
   */
  private setGiDiagnostics(fixedN: number, quadScale: number): void {
    const n = Math.max(0, Math.min(2, fixedN | 0));
    this.characterLighting.giDiagFixedN = n;
    this.sceneLighting.setGiFixedN(n);
    const s = Math.max(1, Math.min(6, Number.isFinite(quadScale) ? quadScale : 1));
    this.player?.sprite.container.scale.set(s, s);
  }
  private fixedTickMode = false;
  /**
   * 冻主 tick 的**原因集合**（叙事断点命中 / 运行时编辑模式）。非空即冻：
   * 主 tick 整个跳过，画面停在那一帧，玩家动不了。
   *
   * ⚠ 为什么是集合不是布尔：两个冻结源可能同时成立（断点断下来之后再进编辑模式）。
   * 裸布尔的话先退出的那一方会把另一方的冻结也一起解掉，玩家在"断点还断着"的时候
   * 突然又能动了。
   */
  private readonly logicFreezeReasons = new Set<LogicFreezeReason>();
  /** 冻结前 stage 的交互模式；全部解冻时原样还回去（不是写死 'static'）。 */
  private stageEventModeBeforeFreeze: import('pixi.js').EventMode | null = null;
  /** 主 ticker 与启动直达路由均已落地后才开放自动化命令，防启动场景覆盖测试场景。 */
  private runtimeReady = false;
  private runtimeCommandPollErrorLogged = false;
  private lastRuntimeCommandResults: { id: string; type: string; ok: boolean; message: string }[] = [];

  private registeredSystems: { name: string; system: IGameSystem }[] = [];
  private boundCallbacks: { event: string; fn: (...args: any[]) => void }[] = [];
  private boundWindowListeners: { event: string; fn: EventListener }[] = [];
  private unsubRendererResize: (() => void) | null = null;
  /** 避免 beforeunload 与 pagehide 接连触发时重复销毁（第二次会踩已 teardown 的 Pixi Application） */
  private tearDownComplete = false;
  private isDevMode = false;
  /** ?smellDebug 安装的 window 全局键（destroy 时清除，见 start 内安装处） */
  private smellDebugGlobalKeys: string[] = [];
  private devModeUI: DevModeUI | null = null;
  private touchMobileControls: TouchMobileControls | null = null;
  /** `overlay_images.json`：可写短 id，避免 action 参数里塞长路径；一条还可带自己的叠图音配置 */
  private overlayImageRegistry: OverlayImageTable = {};
  /** `prop_presets.json`：挂件的支点/自转/缩放登记一次，attachToSocket 用 prop 引用 */
  private propPresetRegistry: PropPresetTable = {};
  /** 挂件效果块库（`prop_effects.json`，临时火把的脾气）；缺文件 = 空表 */
  private propEffectRegistry: PropEffectTable = {};

  private gameConfig: GameConfig = {
    initialScene: '',
    initialQuest: '',
    fallbackScene: '',
    playerAvatar: {
      animManifest: '/resources/runtime/animation/player_anim/anim.json',
      stateMap: {},
    },
    entityPixelDensityMatch: true,
    entityPixelDensityMatchBlurScale: DEFAULT_ENTITY_PIXEL_DENSITY_BLUR_SCALE,
  };

  constructor() {
    this.eventBus = new EventBus();
    if (import.meta.env.DEV) this.eventBus.enableDebugTrace();
    this.flagStore = new FlagStore(this.eventBus);
    this.stringsProvider = new StringsProvider();
    this.inputManager = new InputManager();
    this.assetManager = new AssetManager();
    this.stateController = new GameStateController(this.inputManager, this.eventBus);
    this.actionExecutor = new ActionExecutor(this.eventBus, this.flagStore, this.stateController);
    this.ruleOfferRegistry = new RuleOfferRegistry();
    this.renderer = new Renderer();
    this.renderer.setAssetManager(this.assetManager);
    this.camera = new Camera(this.renderer.worldContainer);
    this.player = new Player(this.inputManager);
    this.interactionSystem = new InteractionSystem(this.eventBus, this.flagStore, this.inputManager);
    this.playerActionSystem = new PlayerActionSystem(
      this.eventBus,
      this.inputManager,
      this.actionExecutor,
      this.player,
    );
    this.sceneManager = new SceneManager(this.assetManager, this.eventBus, this.renderer);
    // 切场进度条要跟全站 UI 一套色；systems 层不能反向 import ui，所以由装配层灌进去
    this.sceneManager.setTransitionPalette({
      track: UITheme.colors.sliderTrack,
      trackBorder: UITheme.colors.borderSubtle,
      fill: UITheme.colors.progressFill,
    });
    this.inventoryManager = new InventoryManager(this.eventBus, this.flagStore);
    this.rulesManager = new RulesManager(this.eventBus, this.flagStore);
    this.dialogueManager = new DialogueManager(this.eventBus);
    this.questManager = new QuestManager(this.eventBus, this.flagStore, this.actionExecutor);
    this.scenarioStateManager = new ScenarioStateManager();
    this.narrativeStateManager = new NarrativeStateManager(this.eventBus, this.flagStore, this.actionExecutor);
    this.graphDialogueManager = new GraphDialogueManager(
      this.eventBus,
      this.flagStore,
      this.actionExecutor,
      this.assetManager,
      this.sceneManager,
      this.rulesManager,
      this.questManager,
      this.inventoryManager,
      this.scenarioStateManager,
    );
    // 主角头像跟「当前生效装扮配置」走（与 NPC 的 currentPortraitSlug 同构）
    this.graphDialogueManager.setPlayerPortraitSlugProvider(() => this.currentPlayerPortraitSlug);
    this.documentRevealManager = new DocumentRevealManager(
      this.assetManager,
      this.eventBus,
      this.flagStore,
      this.questManager,
      this.scenarioStateManager,
      this.actionExecutor,
    );
    this.encounterManager = new EncounterManager(this.eventBus, this.flagStore, this.actionExecutor);
    this.audioManager = new AudioManager(this.eventBus);
    /** 配音通道：全部台词面（过场字幕 / 过场对话框 / 脚本台词 / 图对话 / 头顶气泡）共用一条，
     *  "一条长配音跨几拍"的留声记账在它那里。导演只负责把对话事件翻译成通道调用。 */
    this.voiceChannel = new VoiceChannel();
    this.voiceChannel.setAudioPlayer(this.audioManager);
    this.dialogueVoiceDirector = new DialogueVoiceDirector(this.eventBus, this.voiceChannel);
    this.dialogueVoiceDirector.init();
    // 构造期只立起缺省值；真正的偏好在 start() 里 hydrate（文件读盘是异步的），
    // 落点早于任何一次开菜单与首句台词。
    this.textDisplaySettings = new TextDisplaySettings();
    this.smellDisplaySettings = new SmellDisplaySettings();
    this.dayManager = new DayManager(this.eventBus, this.flagStore, this.actionExecutor);
    this.waterMinigameManager = new WaterMinigameManager();
    this.sugarWheelMinigameManager = new SugarWheelMinigameManager();
    this.paperCraftMinigameManager = new PaperCraftMinigameManager();
    this.objectExamineManager = new ObjectExamineManager();
    this.pressureHoldManager = new PressureHoldManager(this.actionExecutor);
    this.signalCueManager = new SignalCueManager(this.actionExecutor);
    this.healthSystem = new HealthSystem(this.eventBus, this.flagStore, this.actionExecutor);
    this.retrySystem = new RetrySystem();
    this.smellSystem = new SmellSystem(this.eventBus, this.flagStore);
    this.planeReconciler = new PlaneReconciler(this.eventBus);
    this.npcScheduleSystem = new NpcScheduleSystem(this.eventBus);
    this.archiveManager = new ArchiveManager(this.eventBus, this.flagStore);
    // 线索系统（K7）：真相在 flag（clue_<id>），本体只管注册表/采集口/查询口
    this.clueManager = new ClueManager(this.eventBus, this.flagStore);
    // 系统说明卡（K4）：真相在 flag（sysnote_<id>），本体只管注册表/每档一次/关卡落 flag；卡由 UI 层画
    this.systemNoteManager = new SystemNoteManager(this.eventBus, this.flagStore);
    // 事件日志（K3）：监听领域事件攒时间线；面板（DialogueLogUI）只是它的只读视图
    this.gameLogManager = new GameLogManager(this.eventBus);
    this.emoteBubbleManager = new EmoteBubbleManager();
    this.bubbleChatterSystem = new BubbleChatterSystem({
      emoteBubbleManager: this.emoteBubbleManager,
      // 选人每帧都解析（在判条件之前）：走轮询入口，结果变了才记日志
      resolveEmoteTarget: (id) => this.pollEmoteTarget('头顶闲聊', id),
      resolveCharacterEntityId: (cid) => this.resolveCharacterEntityId(cid),
      // 与 resolveEmoteTarget 同一条解析路：先演员（含 player），再当前场景热点
      resolveSpeakerPosition: (targetId) => {
        const actor = this.resolveActorFn(targetId);
        if (actor) return { x: actor.x, y: actor.y };
        const hs = this.sceneManager.getCurrentHotspots().find((h) => h.def.id === targetId);
        return hs ? { x: hs.def.x, y: hs.def.y } : null;
      },
      playerPosition: () => ({ x: this.player.x, y: this.player.y }),
      currentSceneId: () => this.sceneManager.currentSceneData?.id ?? '',
      isExploring: () => this.stateController.currentState === GameState.Exploring,
      resolveRichText: (raw) => this.resolveRichText(raw),
      random: this.presentationRandom,
    });
    this.playerIdleBehaviorSystem = new PlayerIdleBehaviorSystem({
      emoteBubbleManager: this.emoteBubbleManager,
      playerAnchor: () => this.player,
      playPlayerAnimation: (state, onDone) => {
        this.player.playAnimation(state, { loop: false }, onDone);
        // 片段真实时长交给待机系统推算看门狗（固定上限会把长动画砍断）
        return this.player.getCurrentClipTiming().durationSec;
      },
      maxConcurrentBubbles: () => this.bubbleChatterSystem.getMaxConcurrent(),
      hasPlayerAnimationState: (state) => this.player.hasAnimationState(state),
      setPlayerAnimationOwned: (owned) => this.player.setAnimationOwnedByIdle(owned),
      isExploring: () => this.stateController.currentState === GameState.Exploring,
      /**
       * 「玩家正被别人开着」的单一口径：有移动输入 / 点地导航在途 / 演出位移 /
       * 身体姿态或一次性动作在跑。任何一项为真都不算待机，也不许抢动画所有权。
       */
      isPlayerBusy: () => {
        const dir = this.inputManager.getMovementDirection();
        if (dir.x !== 0 || dir.y !== 0) return true;
        if (this.playerNavTarget !== null) return true;
        if (this.player.hasActiveMotion()) return true;
        // ⚠ 不用 getDebugState()：那是**调试快照**用的 getter，每次新建对象 + 跑一遍
        // 五个动词的可用性判定；这里是每帧热路径，用两个精准 getter。
        return this.playerActionSystem.getPosture() !== null
          || this.playerActionSystem.hasPendingAct();
      },
      subscribeAnyInput: (cb) => this.inputManager.subscribeAnyInput(cb),
      resolveRichText: (raw) => this.resolveRichText(raw),
      random: this.presentationRandom,
    });
    this.zoneSystem = new ZoneSystem(this.eventBus, this.flagStore, this.actionExecutor, this.ruleOfferRegistry);
    /**
     * 脚步声。依赖一律走构造函数窄回调注入（分层律 11：禁全局单例与跨模块直接 import 其它系统实例）。
     * 回调都是惰性的，所以这里可以早于 player / camera 的创建。
     */
    this.footstepSystem = new FootstepSystem({
      // 脚步是有物理位置的声源：脚点世界坐标进空间音总线，距离 / 声像 / 回音按听者与脚点的几何算
      playAt: (id, world, options) => this.audioManager.playSfxAt(id, { x: world[0], y: world[1], z: world[2] }, options),
      // 音频没解锁时不发声：发了只会排队，解锁那一刻按过时的位置一齐放出来（只管声音，落脚事件照发）
      getSpatialContext: () => (this.footstepConfig && this.audioManager.isAudioUnlocked()
        ? { resolver: this.buildAudioSpaceResolver() } : null),
      // 脚步落地也是群体的刺激源（`sfx:footstep` 标签，物种档案决定怕不怕）。
      // 🔴 脚点必须经粒子自己的空间换算：playAt 拿到的是音频坐标（透视场景做过纵深重整），
      //   借来当刺激点时，茶馆实测说书人第一步离脚边虫群 600 wu 以上（半径才 220）；也不许跟着音频解锁门控。
      onContact: (c) => {
        const w = this.vfxSystem?.sceneToWorld(c.contactX, c.contactY, 0);
        if (w) this.vfxSystem.emitField({ kind: 'fear', tag: 'sfx:footstep', radius: 220, strength: 0.6, duration: 0.25 }, w);
        // 跟脚声接的是**落脚事件**，不是出声：音频没解锁 / 这块地没配集时照样记账，
        // 于是步间隔与错拍不会因为"这一步没响"而漂掉。只跟玩家的脚。
        if (c.emitterId === 'player') this.followerFootsteps.onSourceContact(c);
      },
      resolveSetAt: (x, y) => this.resolveFootstepSetAt(x, y),
      getConfig: () => this.footstepConfig,
    });
    /**
     * 跟脚声。依赖同样全走窄回调：时间取游戏时钟（开面板世界停，后头那位也停）、
     * 出声回到脚步系统那一条（脚步集 / 两级增益 / 空间化 / 句柄回收一份实现）、
     * 火源状态取护火系统（"举着火他就不跟"是作者可选的一条，不是硬编码）。
     */
    this.followerFootsteps = new FollowerFootstepSystem({
      nowMs: () => this.gameClock.now,
      after: (ms, fire) => this.gameClock.after(ms, fire),
      playStep: (args) => this.footstepSystem.playExternalStep(args),
      hasFireProtection: () => this.fireProtectionSystem.protected,
    });
    this.sceneDepthSystem = new SceneDepthSystem();
    this.characterLighting = new CharacterLightingSystem();
    this.sceneLighting = new SceneLightingSystem();
    /**
     * 画布（场景之外那张屏幕空间的面）：实体 + 特效 + 四类 item 的顺序。
     * 排在 characterLighting 之后：画布特效要拿它那组**显示变换**（整幅画面的调色）。
     * 注意画布特效**不**吃场景光照（无光路），只共用调色——见 CanvasVfxHost 的说明。
     */
    this.canvasStageSystem = new CanvasStageSystem({
      assetManager: this.assetManager,
      canvasStage: this.renderer.canvasStage,
      getScreenSize: () => ({ width: this.renderer.screenWidth, height: this.renderer.screenHeight }),
      resolveCharacterAnimFile: (id) => this.sceneManager.getCharacterAnimFile(id),
      displayUniforms: this.characterLighting.displayUniforms,
      conditionContext: () => this.buildConditionEvalContext(),
      log: (m) => { if (import.meta.env.DEV) console.warn(`[canvas] ${m}`); this.debugPanelUI?.log(`[canvas] ${m}`); },
    });
    /**
     * 世界空间粒子 / 群体。依赖全部走窄回调：空间（行走面 + 壳 + 基）由照明载荷与深度系统给，
     * 载荷异步到达时 onReady 里再让它重建；玩家脚点 / 时段 / 灯表 / 条件工厂 / 空间音各取一口。
     */
    this.vfxSystem = new VfxSystem({
      assetManager: this.assetManager,
      getSceneData: () => this.sceneManager.currentSceneData ?? null,
      buildSpace: () => this.buildVfxSpace(),
      // 便宜的自愈判据：载荷到了没（不建高度场）。真 3D 与平面近似的差别不是"精度"，
      // 是平面近似下**所有几何判据都空成立**（没有地面高低、没有墙）。
      hasFieldGeometry: () => this.buildAudioSceneGeometry() !== null,
      getPlayerContact: () => (this.player ? { x: this.player.contactX, y: this.player.contactY } : null),
      getViewAnchor: () => this.camera.screenToWorld(
        this.renderer.app.screen.width * 0.5, this.renderer.app.screen.height * 0.65,
      ),
      getViewRect: () => {
        const tl = this.camera.screenToWorld(0, 0);
        return { minX: tl.x, minY: tl.y, maxX: tl.x + this.camera.getViewWidth(), maxY: tl.y + this.camera.getViewHeight() };
      },
      // 布置按「场景 × 时段外观」各配一份：与背景 / 光照换装同一个判据（没单列外观的时段 = 基底）
      getAppearancePhase: () => this.sceneManager.appearancePhaseFor(this.dayManager.currentPhase),
      getActiveLights: () => this.activeSceneLightsForVfx(),
      conditionContext: () => this.buildConditionEvalContext(),
      playSfxAt: (id, at) => { this.audioManager.playSfxAt(id, { x: at[0], y: at[1], z: at[2] }); },
      log: (m) => { if (import.meta.env.DEV) console.warn(`[vfx] ${m}`); this.debugPanelUI?.log(`[vfx] ${m}`); },
      getWind: () => ({ params: this.sceneWind.params, time: this.sceneWind.time, blasts: this.sceneWind.blasts, blastTime: this.sceneWind.blastTime }),
      // 可燃薄片（纸钱）烧没了哪几张：燃烧系统进档、建模拟时恢复（燃烧系统在下面构造，闭包里晚绑定）
      burntPlatesOf: (instanceId) => this.burnSystem?.burntPlatesOf(instanceId) ?? null,
      onPlatesBurnt: (instanceId, emitterIndex, slots) => this.burnSystem?.onPlatesBurnt(instanceId, emitterIndex, slots),
      // 表面材质：全局缺省材质（没画区域的地方）+ 本场景的表面材质区（水面 / 湿地）→ 场景照明的反光遮罩，
      // 落雷的灯在任何地方都照出反光（雷是随机落点，不靠逐个场景圈区域）
      onSurfacesChanged: (regions, defaults) => {
        const sd = this.sceneManager.currentSceneData;
        this.sceneLighting.setSurfaceRegions(regions, sd?.worldWidth ?? 1, sd?.worldHeight ?? 1, resolveSurfaceDefaults(defaults));
      },
    });
    /**
     * 手持挂件与运行时灯。依赖同样全走窄回调：
     * - 挂点经 utils/sceneSpace 按宿主直立面与前后关系解到身体外侧；无挂点的跟随灯仍按地面抬高。
     *   灯位只在真 3D 空间里解，平面近似时为 null（见下面 `sceneToLightWorld`）；
     * - 灯不写作者数据，经 `sceneLighting.setDynamicLights`（另一层）加进去；
     * - 风取场景风的同一份参数与同一个钟（火焰的波动幅度吃它）。
     */
    this.heldPropSystem = new HeldPropSystem({
      getPreset: (id) => this.propPresetRegistry[id],
      getEffect: (id) => this.propEffectRegistry[id],
      // 效果块的场（驱虫 / 招东西）：与 emitVfxField 同一套场，handle 认一份、喂 null 撤掉
      setPropField: (handle, field, world) => {
        if (!field || !world) { this.vfxSystem.removeField(handle); return; }
        this.vfxSystem.emitField(
          { kind: field.kind, tag: field.tag, radius: field.radius, strength: field.strength },
          [world[0], world[1], world[2]],
          handle,
        );
      },
      // 相对接地点、已穿过外层实体变换：NPC 转身只翻外层容器，用本容器局部位姿的话朝左时灯落在另一侧
      getSocketLocalPose: (targetId, socket) =>
        this.spriteEntityOf(targetId)?.getSocketOffsetFromContact(socket) ?? null,
      getEntityContact: (targetId) => this.entityContactOf(targetId),
      listSockets: (targetId) => this.spriteEntityOf(targetId)?.listSocketNames() ?? null,
      socketToLightWorld: (contact, pose) => {
        const geo = this.buildLightSpaceGeometry();
        return geo ? socketLightWorld(geo, contact, pose, this.characterLighting.shapeParams.bulge) : null;
      },
      // 灯位只认真 3D 空间：粒子没载荷时退到平面近似，那份 sceneToWorld 返回的是画面坐标，
      // 当 M-world 灯位用不报错、只是灯静默落到别处（铁律 0）。平面近似仅供效果降级。
      sceneToLightWorld: (x, y, h) => (this.vfxSystem.currentSpace?.kind === 'field'
        ? this.vfxSystem.sceneToWorld(x, y, h) : null),
      sceneToVfxWorld: (x, y, h) => this.vfxSystem.sceneToWorld(x, y, h),
      windSpeedAt: (world, heightWu) => {
        const p = this.sceneWind.params;
        if (!p) return 0;
        sampleSceneWind(p, this.sceneWind.time, world[0], world[2], heightWu, this.windSampleTmp);
        return Math.hypot(this.windSampleTmp[0], this.windSampleTmp[2]);
      },
      // 同一份风参数、同一个钟、同一个采样点——帧动画火苗往哪倒与它闪得多凶读的是同一阵风
      windVectorAt: (world, heightWu) => {
        const p = this.sceneWind.params;
        if (!p) return [0, 0, 0];
        sampleSceneWind(p, this.sceneWind.time, world[0], world[2], heightWu, this.windSampleTmp);
        return [this.windSampleTmp[0], this.windSampleTmp[1], this.windSampleTmp[2]];
      },
      // 与灯位同一份光照几何（铁律 0：世界 → 画面只走 utils/sceneSpace 这一处）
      worldToScene: (world) => {
        const geo = this.buildLightSpaceGeometry();
        return geo ? worldToScene(geo, world) : null;
      },
      setFlameView: (targetId, socket, params) => this.spriteEntityOf(targetId)?.setAttachmentFlame(socket, params),
      // 起火点 / 粒子挂点：贴图上的点穿过挂件自己的变换，再走与挂点同一套外层换算
      getPropPointLocalPose: (targetId, socket, point) =>
        this.spriteEntityOf(targetId)?.getAttachmentPointOffsetFromContact(socket, point[0], point[1]) ?? null,
      // 玩家操作手上的火：只在探索态受理（演出 / 对话 / 面板里给 null，护火照常松开）。点火键用"消费"读——
      // 固定步长下一帧可能走好几个 tick，普通读会让一次按键在同一帧里熄了又点
      // 「快灭了」符号：挂 entityLayer 最前档，大小按宿主身高
      setFireHint: (hint) => {
        if (!hint) { this.fireHintMarker.setTarget(null); return; }
        const body = this.spriteEntityOf(hint.targetId)?.getWorldSize().height ?? 0;
        this.fireHintMarker.setTarget({ ...hint, bodyHeightWu: body });
      },
      // 挂件的玩法事实变了 ⇒ 叙事 reactive 条件重评（heldProp 叶子；接收方微任务合批）
      onHeldChanged: () => this.eventBus.emit('heldProp:changed', {}),
      // 可燃挂件（A3.8）：收起来 = 熄灭 + 记成包里那根；"在不在烧"问燃烧系统
      onBurnablePropRemoved: (targetId, socket, propId) => this.burnSystem?.onHeldRemoved(targetId, socket, propId),
      burnablePropBurning: (targetId, socket) => this.burnSystem?.statusOf(targetId, undefined, socket) === 'burning',
      // 火种（A3.7）：当前火种住在背包里，挂件系统只问"还能不能点、点一次用掉一次"
      igniterStatus: () => {
        const st = this.inventoryManager.getActiveIgniter();
        return st ? { name: this.resolveDisplayText(st.name), seconds: st.seconds, windLimit: st.windLimit, available: st.available } : null;
      },
      consumeIgniterUse: () => {
        const st = this.inventoryManager.consumeIgniterUse();
        return st ? { name: this.resolveDisplayText(st.name), seconds: st.seconds, windLimit: st.windLimit } : null;
      },
      onIgniteResult: (result, name) => this.onPlayerIgniteResult(result, name),
      readPlayerPropInput: () => {
        if (this.stateController.currentState !== GameState.Exploring) return null;
        return {
          togglePressed: this.inputManager.consumeKeyJustPressed(PROP_CONTROL_KEYS.toggle),
          guardHeld: this.inputManager.isKeyDown(PROP_CONTROL_KEYS.guard),
        };
      },
      runStateActions: (actions) => this.actionExecutor.executeBatchAwait(actions),
      attachView: (targetId, socket, resolved) => this.attachSocketView(targetId, socket, resolved),
      detachView: (targetId, socket) => this.detachSocketView(targetId, socket),
      setDynamicLights: (lights) => this.setDynamicLightsFrom('prop', lights),
      setLightIntensityScales: (scales) => this.applySceneLightIntensityScales(scales),
      playVfx: (effect, world, host, oneShot) => {
        const id = this.vfxSystem.playVfx({ effect, followWorld: world, oneShot });
        if (id) this.vfxSystem.setInstanceSortHost(id, () => this.vfxSortHostOf(host.targetId, host.socket));
        return id;
      },
      moveVfx: (id, world, carry) => this.vfxSystem.moveInstanceAnchor(id, world, carry),
      stopVfx: (id) => this.vfxSystem.stopVfx(id),
      softStopVfx: (id) => this.vfxSystem.stopVfxSoft(id),
      setVfxRate: (id, k) => this.vfxSystem.setInstanceRateScale(id, k),
      setVfxSizeScale: (id, k) => this.vfxSystem.setInstanceSizeScale(id, k),
      setVfxWindScale: (id, k) => this.vfxSystem.setInstanceWindScale(id, k),
      setVfxDistanceScale: (id, k) => this.vfxSystem.setInstanceDistanceScale(id, k),
      log: (m) => { if (import.meta.env.DEV) console.warn(`[heldProp] ${m}`); this.debugPanelUI?.log(`[heldProp] ${m}`); },
    });
    /**
     * 燃烧系统（A3.8）。依赖全走窄回调（系统之间不互持实例）：粒子能力、热点实体、空间、风钟、灯、信号。
     * 格点世界位置用粒子空间（真 3D 场或平面近似，与火苗粒子同一个世界）；火光只在真 3D 场里有（铁律 0）。
     */
    this.burnSystem = new BurnSystem({
      loadJson: (url) => this.assetManager.loadJson(url),
      dropJson: (url) => { this.assetManager.dropJson(url); },
      loadImageData: (url) => loadBurnImageData(url),
      getSceneData: () => this.sceneManager.currentSceneData ?? null,
      loadSceneData: (sceneId) => this.assetManager.loadSceneData(sceneId),
      sceneBurnables: (sceneId, scene) => this.sceneManager.sceneBurnableEntities(sceneId, scene),
      liveEntities: () => this.burnEntityHosts(),
      liveHeld: () => this.burnHeldHosts(),
      getSpace: () => this.vfxSystem.currentSpace,
      // 几何定了：场景就绪之后，且粒子空间不是"真 3D 场已到、自己还没升级"的平面近似
      isSpaceFinal: () => {
        const sid = this.sceneManager.currentSceneData?.id ?? null;
        if (!sid || this.burnSceneReadyId !== sid) return false;
        const space = this.vfxSystem.currentSpace;
        if (!space) return false;
        return !(space.kind === 'planar' && this.buildAudioSceneGeometry() !== null);
      },
      windClock: () => this.sceneWind.time,
      conditionContext: () => this.buildConditionEvalContext(),
      vfx: {
        playVfx: (opts) => this.vfxSystem.playVfx(opts),
        stopVfxSoft: (id) => this.vfxSystem.stopVfxSoft(id),
        moveInstanceAnchor: (id, world) => this.vfxSystem.moveInstanceAnchor(id, world),
        setInstanceSpawnPoints: (id, pts, count) => this.vfxSystem.setInstanceSpawnPoints(id, pts, count),
        setInstanceRateScale: (id, k) => this.vfxSystem.setInstanceRateScale(id, k),
        setInstanceSortHost: (id, host) => this.vfxSystem.setInstanceSortHost(id, host),
        setFireSources: (owner, segs) => this.vfxSystem.setFireSources(owner, segs),
        burningPlates: () => this.vfxSystem.burningPlates(),
        burningPlateSlots: () => this.vfxSystem.burningPlateSlots(),
      },
      setDynamicLights: (lights) => this.setDynamicLightsFrom('burn', lights),
      // 实例配的信号走 emitNarrativeSignal 动作（owner = 场景实体 / 拿着挂件的人；私有信号定向与实体动作批同一条）
      emitSignal: (signal, ownerId) => {
        const ownerType = ownerId === 'player' ? 'player' : this.sceneManager.getNpcById(ownerId) ? 'npc' : 'hotspot';
        void this.actionExecutor.executeBatchFromOwner(
          [{ type: 'emitNarrativeSignal', params: { signal } }], ownerType, ownerId,
        ).catch((e) => console.warn('[burn] 发信号失败', signal, e));
      },
      log: (m) => { if (import.meta.env.DEV) console.warn(`[burn] ${m}`); this.debugPanelUI?.log(`[burn] ${m}`); },
    });
    this.burnSystem.setRenderer(this.burnRenderer);
    this.burnRenderer.setPixiRenderer(() => this.renderer.app?.renderer);
    // 开了可燃的热点 / NPC 按模板画：模板从燃烧系统取（工作台推来的工作态也在那里）
    this.sceneManager.setBurnTemplateResolver((id) => this.burnSystem.loadTemplate(id));
    // 护着火只能走不能跑（玩法清单 A3.7「火把养成」）：挂件系统只说"此刻护着火没有"，走不走得动归玩家自己
    this.player.setHeldPropMovement(() => ({ allowRun: !this.heldPropSystem.playerGuardBlocksRun() }));
    this.ignitePerformer = new IgnitePerformer({
      getState: () => this.stateController.currentState,
      setState: (s) => this.stateController.setState(s),
      switching: () => this.sceneManager.switching,
      player: {
        pos: () => ({ x: this.player.contactX, y: this.player.contactY }),
        facing: () => (this.player.facingDirection === 'left' ? -1 : 1),
        setFacing: (dir) => this.player.setFacing(dir, 0),
        moveTo: (x, y, speed) => this.player.moveTo(x, y, speed, 'walk', true),
        cancelMotion: () => this.player.cancelMotion(),
        walkSpeed: () => this.player.currentWalkSpeed,
        hasLogicalState: (logical) => this.player.hasAnimationState(logical),
        playOnce: (logical, thenLogical) => this.player.playAnimation(logical, { loop: false, thenState: thenLogical }),
        currentFrame: () => ({
          state: this.player.sprite.getCurrentState(),
          frame: this.player.sprite.getFrameIndex(),
          frameCount: this.player.sprite.getFrameCount(),
          clipSeconds: this.player.sprite.getCurrentClipDurationSec(),
        }),
        resolveClip: (logical) => this.player.sprite.resolveLogicalClip(logical),
        igniteContactFrame: (logical) => this.player.sprite.igniteContactFrame(logical),
        predictTip: (socket, u, v, logical, frame, facing, depthScale) =>
          this.player.sprite.predictAttachmentPointOffset(socket, u, v, { logicalState: logical, frameIndex: frame, facing, depthScale }),
      },
      perspectiveAt: (x, y) => this.perspectiveScaleResolver?.scaleAt(x, y) ?? 1,
      isWalkable: (x, y) => {
        const sd = this.sceneManager.currentSceneData;
        if (sd && (x < 0 || y < 0 || x > sd.worldWidth || y > sd.worldHeight)) return false;
        return !this.sceneDepthSystem.isCollision(x, y);
      },
      // 手上的火：火把优先，其次燃着的可燃挂件（香 / 蜡烛，A3.8）
      igniter: () => this.heldPropSystem.igniterOf('player') ?? this.burnSystem.heldIgniterOf('player'),
      relightTip: () => this.heldPropSystem.relightTipOf('player') ?? this.burnSystem.heldRelightTipOf('player'),
      relight: () => (this.heldPropSystem.relightTipOf('player')
        ? this.heldPropSystem.relightPlayerTorch()
        : this.burnSystem.relightHeld('player')),
      burn: {
        canPlayerIgnite: (id) => this.burnSystem.canPlayerIgnite(id),
        playerIgniteTarget: (id, tip) => this.burnSystem.playerIgniteTarget(id, tip),
        igniteAt: (id, target) => this.burnSystem.igniteAt(id, target),
        canRelightFrom: (id) => this.burnSystem.canRelightFrom(id),
        relightTarget: (id, tip) => this.burnSystem.relightTarget(id, tip),
      },
      config: () => ({
        animation: this.gameConfig.playerActs?.ignite?.animation?.trim() || 'ignite',
        walkSpeed: this.gameConfig.playerActs?.ignite?.walkSpeed,
      }),
      log: (m) => { if (import.meta.env.DEV) console.warn(`[burn] ${m}`); this.debugPanelUI?.log(`[burn] ${m}`); },
    });
    // 载荷就绪(depthLoader 内已 await,先于 scene:ready):把行走面深度场交给深度系统——
    // 遮挡脚点/碰撞反投影/影子落地面从此以它为真值,不再用 floor_depth_A/B 全图拟合直线
    // (见 entity-lighting「脚点锚必须同源」)。滤镜由随后的 scene:ready 权威挂载(此时
    // shadingResources 已就绪),故此处不再 reattach——避免抢在实体建好前挂、且泄漏重复滤镜。
    this.characterLighting.onReady = () => {
      this.sceneDepthSystem.setGroundDepthField(
        this.characterLighting.groundDepthField,
        this.characterLighting.groundDepthTexture,
      );
      // 前景层的接地深度取自行走面场：场换了按新的重取（进场时前景层还没建，这一句是空转）
      this.foregroundLayers?.refreshBase(this.sceneDepthSystem.foregroundDepthModel());
      this.refreshPlayerWorldCollision();
      // 载荷刚落地：听者立刻按**这个场景**的行走面重算。进场时 setAudioApplier 那次强制重算跑在载荷之前，
      // 拿的是上一个场景的场与基（grounded 照样 true），不在这里重来一次就得等玩家走出阈值
      this.updateAcousticListener(true);
      // 粒子空间同理：载荷落地前 scene:ready 只建得出 planar 近似，这里换成真行走面 + 壳
      this.vfxSystem.onSpaceMaybeChanged();
      // 调试可视化排最后 + 单独兜错：本回调跑在 load() 的 try 里，从这里抛出去会被
      // load() 的 catch 当成"载荷坏了"整包丢弃（连带销毁纹理，深度系统随即采到已销毁
      // 的源而崩）。**F2 调试链路失手绝不能连坐玩法照明。**
      try {
        this.depthDebugVisualizer?.setGroundTexture(this.characterLighting.groundDepthTexture);
      } catch (e) {
        console.warn('[Game] 深度调试可视化注入行走面场失败（不影响玩法照明）', e);
      }
      // DEV：这一局里地形工作台推过 / 导出过这个场景 ⇒ 载荷落地后按缓存戳再原地换一次。
      // 进场景那一步装的是 AssetManager 按 URL 缓存的旧碰撞图 / 旧行走面（导出后走出去再进来就还是旧的）。
      if (import.meta.env.DEV) {
        const sid = this.sceneManager.currentSceneData?.id ?? null;
        const bust = sid ? this.terrainSync?.bustFor(sid) : undefined;
        if (sid && bust) {
          void this.reloadTerrainInPlace(bust).then((ok) => {
            if (ok) this.terrainSync?.noteApplied(sid, Number(bust));
          }).catch((e) => console.warn('[terrain] 进场景后按缓存戳重装地形失败', e));
        }
      }
    };
    // 章节导演（C2）：按清单在 scene:revealed / narrative:stateChanged 上评估开拍/收工；
    // 自身无状态（live 集在叙事档），控制口与条件工厂在下方统一接线。
    this.narrativePackageDirector = new NarrativePackageDirector(this.eventBus);
    // 烘焙式轨迹播放。两件依赖：NPC 目标开播时要停巡逻，否则巡逻协程会把实体抢回去
    // （同一个理由见 setupSceneReadyHandler 里 NPC 重建后的 stopNpcPatrol）；
    // 播放头扫过音效关键点时发声——**不带位置**（制作人 2026-09-12 定），
    // 走与 `playSfx` 动作同一条口（未知 id 静默不响、本处音量覆盖素材级，见 data/audioCue.ts）。
    this.trajectorySystem = new TrajectorySystem({
      suspendPatrol: (npcId) => this.stopNpcPatrol(npcId),
      playCue: (cue, trajectoryId) => {
        const sfx = normalizeAudioCue(cue?.sound);
        if (!sfx) {
          console.warn(`[trajectory] 轨迹 "${trajectoryId}" 的音效关键点 "${cue?.id ?? ''}" 没有音效 id，跳过`);
          return;
        }
        this.audioManager.playSfx(sfx.id, sfx.volume);
      },
    });

    const ctx = { eventBus: this.eventBus, flagStore: this.flagStore, strings: this.stringsProvider, assetManager: this.assetManager };
    this.registeredSystems = [
      { name: 'sceneManager', system: this.sceneManager },
      { name: 'interactionSystem', system: this.interactionSystem },
      { name: 'playerActionSystem', system: this.playerActionSystem },
      { name: 'dialogueManager', system: this.dialogueManager },
      { name: 'graphDialogueManager', system: this.graphDialogueManager },
      { name: 'inventoryManager', system: this.inventoryManager },
      { name: 'rulesManager', system: this.rulesManager },
      { name: 'questManager', system: this.questManager },
      { name: 'scenarioStateManager', system: this.scenarioStateManager },
      { name: 'narrativeStateManager', system: this.narrativeStateManager },
      // 位面对账器排在叙事之后：deserialize 时叙事激活态已恢复，可立即重派生激活位面。
      { name: 'planeReconciler', system: this.planeReconciler },
      // 日程排在 dayManager（时刻）之后无所谓：它自身只存剧情覆盖，位置由时刻现算。
      { name: 'npcScheduleSystem', system: this.npcScheduleSystem },
      { name: 'narrativePackageDirector', system: this.narrativePackageDirector },
      { name: 'documentRevealManager', system: this.documentRevealManager },
      { name: 'encounterManager', system: this.encounterManager },
      { name: 'audioManager', system: this.audioManager },
      { name: 'dayManager', system: this.dayManager },
      { name: 'waterMinigameManager', system: this.waterMinigameManager },
      { name: 'sugarWheelMinigameManager', system: this.sugarWheelMinigameManager },
      { name: 'paperCraftMinigameManager', system: this.paperCraftMinigameManager },
      { name: 'objectExamineManager', system: this.objectExamineManager },
      { name: 'pressureHoldManager', system: this.pressureHoldManager },
      { name: 'signalCueManager', system: this.signalCueManager },
      { name: 'healthSystem', system: this.healthSystem },
      { name: 'retrySystem', system: this.retrySystem },
      { name: 'healthThreatSystem', system: this.healthThreatSystem },
      { name: 'fireProtectionSystem', system: this.fireProtectionSystem },
      { name: 'smellSystem', system: this.smellSystem },
      { name: 'cutsceneManager', system: null as any },
      { name: 'archiveManager', system: this.archiveManager },
      { name: 'clueManager', system: this.clueManager },
      { name: 'systemNoteManager', system: this.systemNoteManager },
      { name: 'gameLogManager', system: this.gameLogManager },
      { name: 'zoneSystem', system: this.zoneSystem },
      // 脚步是表现态：serialize 恒为空桶，deserialize = 作废在途尾音（旧时间线不写新状态）
      { name: 'footstepSystem', system: this.footstepSystem },
      // 跟脚声：**开关与参数是世界事实**（有个东西在跟着你），进档；在途那一步是表现态，不进。
      // 不进档的话，这一段的重试检查点一读回来跟脚声就没了，而且没有任何报错。
      { name: 'followerFootstepSystem', system: this.followerFootsteps },
      { name: 'emoteBubbleManager', system: this.emoteBubbleManager },
      { name: 'bubbleChatterSystem', system: this.bubbleChatterSystem },
      { name: 'playerIdleBehaviorSystem', system: this.playerIdleBehaviorSystem },
      { name: 'sceneDepthSystem', system: this.sceneDepthSystem },
      // 轨迹是表演态：serialize 恒为空桶，deserialize = 作废在途表演（旧时间线不写新状态）
      { name: 'trajectorySystem', system: this.trajectorySystem },
      // 画布实体同样是表演态：serialize 恒为空桶，deserialize = 整批收掉
      { name: 'canvasStageSystem', system: this.canvasStageSystem },
      // 粒子 / 群体是表演态：serialize 恒为空桶，deserialize = 整批散掉
      { name: 'vfxSystem', system: this.vfxSystem },
      // 燃烧：可燃物烧的状态是世界事实（进档、离场照推）。排在粒子之后：读档时粒子先散（散的时候报的纸钱是旧时间线的，
      // 燃烧系统在 save:restoring 之后一律不收），燃烧再按存档重建
      { name: 'burnSystem', system: this.burnSystem },
      // 手持挂件：**只有手持物（persistent 预设）入档**，存的是玩法事实，表现全派生
      { name: 'heldPropSystem', system: this.heldPropSystem },
    ];
    for (const entry of this.registeredSystems) {
      if (entry.system) entry.system.init(ctx);
    }
  }

  private buildResolveContext(): ResolveContext {
    const strings = this.stringsProvider;
    return {
      stringsRaw: (c, k) => strings.getRaw(c, k),
      flagStore: this.flagStore,
      itemNames: this.archiveManager.getItemDisplayNames(),
      npcName: (id) => {
        const t = id.trim();
        if (!t) return undefined;
        const live = this.sceneManager.getNpcById(t);
        if (live) return live.def.name;
        return this.npcDisplayNameById.get(t);
      },
      contextNpcId: this.graphDialogueManager.getContextNpcId(),
      playerDisplayName: () => {
        const v = this.flagStore.get('player_display_name');
        if (typeof v === 'string' && v.trim()) return v.trim();
        const fb = strings.getRaw('dialogue', 'defaultProtagonistName');
        return fb && fb !== 'defaultProtagonistName' ? fb : '你';
      },
      questTitle: (id) => this.questManager.getQuestTitle(id),
      ruleName: (id) => this.rulesManager.getRuleDef(id)?.name,
      sceneDisplayName: (sid) => {
        const t = sid.trim();
        return this.sceneDisplayNameById.get(t) ?? t;
      },
    };
  }

  /**
   * 统一解析 JSON / strings 模板中的 [tag:…]（供 Action、UI、档案等共用）。
   *
   * **默认去掉 `[c:…]` 样式标记**：这是全项目唯一的兜底——任何没走 `createStyledText`
   * 的显示点、以及把文本当数据用的地方（数量解析、存档、日志、比较）都经过这里，
   * 于是"内容里写了色标记但那个面板还没迁移"最多是没颜色，绝不会把标记原样糊到玩家脸上。
   * 需要上色的显示点走 {@link resolveRichText}，并且**必须**配 `createStyledText` 渲染。
   */
  resolveDisplayText(raw: string | undefined): string {
    return stripStyleMarkup(resolveText(raw, this.buildResolveContext()));
  }

  /**
   * 与 {@link resolveDisplayText} 同解析，但**保留** `[c:…]` 样式标记。
   * 只给用 `createStyledText` / `setStyledText` 渲染的显示点用；配错了会让玩家看见裸标记。
   */
  resolveRichText(raw: string | undefined): string {
    return resolveText(raw, this.buildResolveContext());
  }

  /**
   * `playScriptedDialogue` 专用：`[tag:npc:@context]` 在无图对白上下文时使用 `params.scriptedNpcId`，
   * 若在图对话 `runActions` 内则仍优先当前图的 npcId。
   */
  resolveRichTextForPlayScripted(raw: string | undefined, scriptedNpcId?: string): string {
    const base = this.buildResolveContext();
    const graphNpc = base.contextNpcId?.trim();
    const scripted = scriptedNpcId?.trim();
    const ctx: ResolveContext = {
      ...base,
      contextNpcId: graphNpc || scripted || undefined,
    };
    return resolveText(raw ?? '', ctx);
  }

  /**
   * `playScriptedDialogue` / 过场 `present:showDialogue` 逐行的头像 + 说话实体解析
   * （与图对话 {@link GraphDialogueManager.resolvePortrait} 同语义）：
   * - speakerEntity：见 {@link resolveScriptedSpeakerEntityForLine}，供「…」气泡定位与头像跟随；
   * - portrait：显式 slug 原样用；仅带 emotion 时跟随 speakerEntity（player→当前装扮立绘集、npc→场景 NPC 的 portraitSlug），解析不到则本行不显头像。
   */
  private resolveScriptedLineExtras(
    rawSpeaker: string,
    portraitRef: DialoguePortraitRef | undefined,
    scriptedNpcId: string,
  ): { portrait?: DialoguePortraitRef; speakerEntity?: DialogueLine['speakerEntity'] } {
    const entity = this.resolveScriptedSpeakerEntityForLine(rawSpeaker, scriptedNpcId);
    return { portrait: this.resolveScriptedPortrait(portraitRef, entity), speakerEntity: entity };
  }

  /**
   * 脚本台词行的「说话人实体」唯一口径（头像跟随说话人 + 「…」气泡锚点共用）：
   * 1. speaker 里的占位 `{{player}}` / `{{npc[:id]}}` 优先（与图对话 speakerEntity 同源）；
   * 2. 没写占位时认「说话 NPC」下拉填的 `scriptedNpcId`——策划把显示名写成字面（"关二狗"）
   *    是常规写法，此前这类行解析不出实体，「跟随说话人」的立绘一律不显；
   * 3. **显示名留空 = 跟「说话 NPC」走**（不是旁白）：只填下拉、不打名字是最省的写法，
   *    此时实体即该下拉，显示名由 {@link scriptedSpeakerDisplayFallback} 取该实体的名字；
   * 4. 只有 speaker 与 scriptedNpcId **都**没设、或显示名被显式写成旁白标签，才是旁白
   *    （undefined：不显头像、不冒气泡、不分边）。
   */
  private resolveScriptedSpeakerEntityForLine(
    rawSpeaker: string,
    scriptedNpcId: string,
  ): ScriptedSpeakerEntity | undefined {
    const byPlaceholder = resolveScriptedSpeakerEntity(rawSpeaker, {
      graphDialogueNpcId: this.graphDialogueManager.getContextNpcId(),
      fallbackNpcId: scriptedNpcId,
    });
    if (byPlaceholder) return byPlaceholder;
    const snpc = (scriptedNpcId ?? '').trim();
    if (!snpc) return undefined;
    const speakerDisplay = this.resolveDisplayText(rawSpeaker ?? '').trim();
    // 显示名留空：跟下拉选中的实体走（此前这里当旁白，等于把选好的说话人丢掉）
    if (!speakerDisplay) return scriptedSpeakerEntityFromId(snpc);
    const narrKey = this.stringsProvider.get('dialogue', 'narratorLabel');
    const narrator = this.resolveDisplayText(narrKey && narrKey !== 'narratorLabel' ? narrKey : '旁白').trim();
    if (speakerDisplay === narrator) return undefined;
    return scriptedSpeakerEntityFromId(snpc);
  }

  /**
   * 显示名留空时的名字回落：取「说话 NPC」下拉所指实体的名字
   * （主角=当前主角显示名，NPC=场景 NPC 的 name）。两者都没设 → 空串 = 旁白。
   */
  scriptedSpeakerDisplayFallback(scriptedNpcId: string): string {
    const id = (scriptedNpcId ?? '').trim();
    if (!id) return '';
    // {{npc:<id>}} 已覆盖两种情形：保留 id `player` 出主角显示名，其余出场景 NPC 的 name。
    return resolveScriptedSpeakerDisplay(`{{npc:${id}}}`, {
      strings: this.stringsProvider,
      flagStore: this.flagStore,
      sceneManager: this.sceneManager,
      graphDialogueNpcId: this.graphDialogueManager.getContextNpcId(),
      fallbackNpcId: id,
    });
  }

  private resolveScriptedPortrait(
    ref: DialoguePortraitRef | undefined,
    entity: ScriptedSpeakerEntity | undefined,
  ): DialoguePortraitRef | undefined {
    if (!ref || !ref.emotion) return undefined;
    const slug = ref.slug?.trim();
    if (slug) return { slug, emotion: ref.emotion };
    // 「跟随说话人」：按说话人实体的**当前装扮配置**取立绘集 id
    // （NPC=就地 portraitSlug / 角色注册表继承 / animFile 包名推导；玩家=当前装扮）。
    if (!entity) {
      console.warn('[portrait] 「跟随说话人」解析不出说话人实体：speaker 无 {{…}} 占位且未填 scriptedNpcId（或说话人是旁白），本行不显头像');
      return undefined;
    }
    if (entity.kind === 'player') {
      const p = this.currentPlayerPortraitSlug?.trim();
      if (!p) console.warn('[portrait] 「跟随说话人」= 主角，但当前装扮未提供立绘集，本行不显头像');
      return p ? { slug: p, emotion: ref.emotion } : undefined;
    }
    const npcSlug = this.sceneManager.getNpcById(entity.npcId)?.currentPortraitSlug;
    if (!npcSlug) {
      console.warn(
        `[portrait] 「跟随说话人」取不到立绘集：NPC ${JSON.stringify(entity.npcId)} `
        + '不在当前场景，或其 portraitSlug/animFile 都推不出立绘集，本行不显头像',
      );
    }
    return npcSlug ? { slug: npcSlug, emotion: ref.emotion } : undefined;
  }

  /**
   * showEmote / showSpeechBubble / showEmoteAndWait / showSpeechBubbleAndWait / showSubtitle.subtitleEmote 共用：resolveActor 未命中时再匹配当前场景热点 id。
   *
   * 这是给**一次性**调用方（动作 / 过场一拍 / dev 预览）的入口：命中、未命中每次都记进 F2 日志——一次动作一组行，
   * 正是排查要看的。**每帧**都要解析的调用方一律走 {@link pollEmoteTarget}，别接这里：F2 日志只留 50 行，
   * 每帧一条命中 50 帧就把别的诊断全冲掉（2026-09-14 实测：跑马梁闲逛时头顶闲聊每帧解析一次 player）。
   */
  private resolveEmoteTarget(raw: string): IEmoteBubbleAnchor | null {
    return this.lookupEmoteTarget(raw, (m) => this.debugPanelUI?.log(`[emote/target] ${m}`));
  }

  /**
   * 每帧轮询的调用方（头顶闲聊选人、气泡档对白跟人）用的 {@link resolveEmoteTarget}：解析口径同一份，
   * 但只在「这个调用方问这个 id」的结果**变了**（命中↔未命中、换了场景）时记一次——未命中照样带热点枚举，
   * 只是不逐帧重刷；结果没变的帧连诊断串都不拼。
   */
  private pollEmoteTarget(source: string, raw: string): IEmoteBubbleAnchor | null {
    const anchor = this.lookupEmoteTarget(raw, null);
    const panel = this.debugPanelUI;
    if (!panel) return anchor;
    const key = `${source}\u0000${String(raw ?? '').trim()}`;
    const outcome = `${this.sceneManager.currentSceneData?.id ?? ''}\u0000${anchor ? 'hit' : 'miss'}`;
    if (this.emoteTargetPollOutcomes.get(key) === outcome) return anchor;
    this.emoteTargetPollOutcomes.set(key, outcome);
    // 变了才带日志再走一遍：纯读，与上面同一帧同一结果
    this.lookupEmoteTarget(raw, (m) => panel.log(`[emote/target] ${source}(变了才记): ${m}`));
    return anchor;
  }

  /** 解析本体（上面两个入口共用）。`log` 为 null 时整条诊断都不拼，含未命中时的热点枚举。 */
  private lookupEmoteTarget(raw: string, log: ((m: string) => void) | null): IEmoteBubbleAnchor | null {
    const id = String(raw ?? '').trim();
    if (!id) {
      log?.('目标 id 为空');
      return null;
    }
    const actor = this.resolveActorFn(id);
    if (actor) {
      log?.(`命中 resolveActor entityId=${JSON.stringify(actor.entityId)}`);
      return actor;
    }
    const hs = this.sceneManager.getCurrentHotspots();
    if (log) {
      const scene = this.sceneManager.currentSceneData?.id ?? '';
      const enumerate = hs
        .slice(0, 40)
        .map((h) => {
          const hid = h.def.id;
          const key = `${JSON.stringify(hid)}`;
          return String(hid ?? '').trim() === id ? `${key}⇐match` : key;
        })
        .join(', ');
      log(
        `resolveActor 未命中 scene=${scene || '(?)'} ` +
        `热点数=${hs.length}${hs.length > 40 ? `（以下仅列前40个 id）` : ''}：[${enumerate}]`,
      );
    }
    const h = hs.find((x) => String(x.def.id ?? '').trim() === id);
    if (!h) {
      log?.(`仍未匹配 query=${JSON.stringify(id)}`);
      return null;
    }
    log?.(
      `命中热点: def.id=${JSON.stringify(h.def.id)} active=${h.active} ` +
      `container.visible=${h.container.visible} ` +
      `parent=${h.container.parent ? 'yes' : 'no'} y=${Math.round(h.container.y)}`,
    );
    return h;
  }

  /**
   * 轨迹目标解析：`TrajectoryTargetRef`（或裸 id 字符串）→ 能被轨迹驱动的对象。
   *
   * 一律走既有的唯一演员入口 `resolveActorFn`（临时演员 → 场景 NPC → player），
   * 返回的 `Npc` / `Player` **自身就是** `ITrajectoryTarget`（直接 implements，无包装类）。
   * 轨迹不驱动相机：运镜走 `cameraFollowActor` / `cameraMove` 那一族。
   *
   * 这里必须做一次运行时窄化：`resolveActorFn` 的静态类型是 `ICutsceneActor`，而热点等
   * 别的可锚定物**不是**轨迹目标。鸭子判 `trajectoryKey` + 三个方法，缺一个就当解析失败
   * ——宁可返回 null 让调用方报"目标解析失败"，也不要半个接口的对象进播放系统。
   */
  resolveTrajectoryTarget(ref: TrajectoryTargetRef | string): ITrajectoryTarget | null {
    const kind = typeof ref === 'string'
      ? (ref.trim() === 'player' ? 'player' : 'npc')
      : ref?.kind;
    const id = kind === 'player'
      ? 'player'
      : (typeof ref === 'string' ? ref.trim() : String(ref?.id ?? '').trim());
    if (!id) return null;
    const actor = this.resolveActorFn(id) as unknown;
    if (!actor || typeof actor !== 'object') return null;
    const cand = actor as Partial<ITrajectoryTarget>;
    if (typeof cand.trajectoryKey !== 'string'
      || typeof cand.beginTrajectory !== 'function'
      || typeof cand.applyTrajectoryPose !== 'function'
      || typeof cand.endTrajectory !== 'function') {
      return null;
    }
    return cand as ITrajectoryTarget;
  }

  /**
   * 轨迹资产装载：`assets/data/trajectories/<id>.json`，按 id 惰性、整会话缓存（缺失也缓存）。
   * 文件不存在是**内容错**（构建期由校验器拦），运行时只 warn 一次、播放以 `'cancelled'` 封口。
   * 走 `loadOptionalJson`：dev server 对缺失路径回 200+HTML，只看状态码会把 HTML 当 JSON 解析爆红条。
   */
  async loadTrajectoryAsset(trajectoryId: string): Promise<TrajectoryAsset | null> {
    const id = String(trajectoryId ?? '').trim();
    if (!id) return null;
    const cached = this.trajectoryAssets.get(id);
    if (cached !== undefined) return cached;
    let asset: TrajectoryAsset | null = null;
    try {
      const raw = await this.assetManager.loadOptionalJson<TrajectoryAsset>(trajectoryJsonUrl(id));
      if (raw && typeof raw === 'object' && Array.isArray(raw.keyframes)) asset = raw;
    } catch {
      asset = null;
    }
    if (!asset) {
      console.warn(`[trajectory] 轨迹资产缺失或形状不对："${id}"（${trajectoryJsonUrl(id)}）`);
    }
    this.trajectoryAssets.set(id, asset);
    return asset;
  }

  /**
   * 资产 → 当前场景可播的 2D 相对帧。
   * 世界空间资产按当前场景 `depthConfig.M.R` 投影（只要 R，不要光照载荷，见 `utils/trajectoryProjection`）；
   * 没有 depthConfig（或 R 不是 det=+1）的场景回落到烘焙场景投好的 `keyframes`。
   */
  resolveTrajectoryFrames(asset: TrajectoryAsset, flipX = false): TrajectoryKeyframe[] {
    let frames: TrajectoryKeyframe[] = Array.isArray(asset.keyframes) ? asset.keyframes : [];
    if (asset.space === 'world' && Array.isArray(asset.worldKeyframes) && asset.worldKeyframes.length > 0) {
      const rows = basisRowsFromDepthConfigR(this.sceneManager.currentSceneData?.depthConfig?.M?.R);
      if (rows) frames = projectWorldKeyframes(asset.worldKeyframes, rows);
    }
    return flipX ? flipTrajectoryKeyframes(frames) : frames;
  }

  /**
   * `playTrajectory` 的运行时入口：装资产 → 解析目标 → 投影/翻转 → 交给播放系统。
   * **必然封口**（律 3）：资产缺失 / 目标解析失败 / 装载期被拆除都返回 `'cancelled'`。
   * 目标位置（缺省锚点）在播放系统里、装载之后才读——读的是开播那一刻的位置。
   */
  async playTrajectoryAsset(
    trajectoryId: string,
    ref: TrajectoryTargetRef | string,
    opts: TrajectoryPlayOptions = {},
  ): Promise<TrajectoryEndReason> {
    const asset = await this.loadTrajectoryAsset(trajectoryId);
    if (!asset || this.tearDownComplete) return 'cancelled';
    const binding = trajectoryBinding(asset);
    const curScene = this.sceneManager.currentSceneData?.id ?? '';
    if (binding === 'scene' && asset.authoring?.sceneId && curScene && asset.authoring.sceneId !== curScene) {
      console.warn(`[trajectory] 场景曲线 "${trajectoryId}" 绑定的是 "${asset.authoring.sceneId}"，当前是 "${curScene}"：位置按作者场景给`);
    }
    // 播放位置：at（位置引用）→ 老写法 anchor → 场景曲线原地（origin）→ 相对曲线退到目标此刻位置（warn）
    let anchor: { x: number; y: number } | undefined = opts.anchor;
    if (opts.at) {
      const p = await this.resolvePositionRef(opts.at);
      if (this.tearDownComplete) return 'cancelled';
      if (p) anchor = p;
      else console.warn(`[trajectory] 轨迹 "${trajectoryId}" 的播放位置解析不出来，按曲线类型缺省处理`);
    }
    const origin = trajectoryOrigin(asset);
    if (!anchor) {
      if (binding === 'scene' && origin) anchor = origin;
      else if (binding === 'free') console.warn(`[trajectory] 相对曲线 "${trajectoryId}" 没给播放位置（at），退到目标此刻位置`);
    }
    let target: ITrajectoryTarget | null = null;
    let spawnedId: string | null = null;
    if (opts.spawn) {
      const at = anchor ?? origin;
      if (!at) {
        console.warn(`[trajectory] 轨迹 "${trajectoryId}" 要临时生成运动对象，但既没给播放位置也没有曲线原点`);
        return 'cancelled';
      }
      const npc = await this.spawnTrajectoryActor(opts.spawn, at);
      if (!npc || this.tearDownComplete) return 'cancelled';
      spawnedId = npc.id;
      anchor = anchor ?? at;
      if (opts.animState) npc.playAnimation(opts.animState);
      target = npc;
    } else {
      target = this.resolveTrajectoryTarget(ref);
      if (!target) {
        console.warn(`[trajectory] 目标解析失败："${typeof ref === 'string' ? ref : JSON.stringify(ref)}"（轨迹 "${trajectoryId}"）`);
        return 'cancelled';
      }
    }
    const frames = this.resolveTrajectoryFrames(asset, opts.flipX === true);
    const reason = await this.trajectorySystem.play(
      // 音效关键点是时间轴上的事，与投影 / flipX / 播放位置全无关：整份透传，播放系统按时间触发
      { id: asset.id || trajectoryId, keyframes: frames, cues: asset.cues },
      target,
      { anchor },
    );
    if (spawnedId && !this.tearDownComplete) {
      // 临时生成的对象：播完缺省移除；keep = 留在终点，成为这个场景真正的实体（随存档 / 实例化走）
      if (opts.spawn?.keep) this.sceneManager.commitSpawnedNpcPosition(spawnedId);
      else this.sceneManager.removeRuntimeNpc(spawnedId);
    }
    return reason;
  }

  /**
   * 位置引用求值（数字 / 实体此刻位置 / 场景曲线插槽）。实体按 `resolveActorFn`（临时演员 → 场景 NPC → player），
   * 再退到当前场景热点——与气泡说话人定位同一条解析路。解析不出来 warn + null。
   */
  async resolvePositionRef(raw: unknown): Promise<{ x: number; y: number } | null> {
    const ref = parsePositionRef(raw);
    if (!ref) return null;
    return resolvePositionRefPure(ref, {
      entityPosition: (id) => this.positionRefEntityPosition(id),
      loadTrajectory: (id) => this.loadTrajectoryAsset(id),
      currentSceneId: () => this.sceneManager.currentSceneData?.id ?? '',
      // "曲线上的点"的实时档：那条轨迹正在播就按**这次**播放算（见 TrajectorySystem.livePlay）
      liveTrajectoryPlay: (id) => this.trajectorySystem.livePlay(id),
      // 播放头（point:'current'）不播的时候停在本场景最近一次结束的那一点
      endedTrajectoryPlay: (id) => this.trajectorySystem.endedPlay(id),
    });
  }

  /** 位置引用的实体档：演员（临时演员 → 场景 NPC → player）→ 当前场景热点。一次性 / 每帧两条求值共用。 */
  private positionRefEntityPosition(id: string): { x: number; y: number } | null {
    const actor = this.resolveActorFn(id);
    if (actor) return { x: actor.x, y: actor.y };
    const hs = this.sceneManager.getCurrentHotspots().find((h) => h.def.id === id);
    return hs ? { x: hs.def.x, y: hs.def.y } : null;
  }

  /**
   * 位置引用**每帧**求值（镜头跟随用）：同步、不出声，求不出返回 null（见 `evaluatePositionRefNow`）。
   * 资产只从缓存拿——绑定时（`bindCameraFollowRef`）已经装好；万一没装完，这一帧就当没有这个点。
   */
  private evaluatePositionRefNow(ref: PositionRef): { x: number; y: number } | null {
    if (!this.positionRefNowLookups) {
      this.positionRefNowLookups = {
        entityPosition: (id) => this.positionRefEntityPosition(id),
        trajectory: (id) => this.trajectoryAssets.get(String(id ?? '').trim()),
        currentSceneId: () => this.sceneManager.currentSceneData?.id ?? '',
        liveTrajectoryPlay: (id) => this.trajectorySystem.livePlay(id),
        endedTrajectoryPlay: (id) => this.trajectorySystem.endedPlay(id),
      };
    }
    return evaluatePositionRefNow(ref, this.positionRefNowLookups);
  }

  /**
   * 镜头跟随一个位置引用（cameraFollowActor 的 `at`）。绑定这一刻装好资产、查资产层的错
   * （相对曲线不许引用 / 缺插槽 / 资产缺失）：有错 warn 一次、返回 false（跟随不生效，调用方可退回 target）。
   * 绑定成功后每帧求值，求不出就镜头不动（曲线还没开播时引用点还没产生）。
   */
  private async bindCameraFollowRef(ref: PositionRef, snap: boolean): Promise<boolean> {
    if (ref.kind === 'slot' || ref.kind === 'curve') {
      const asset = await this.loadTrajectoryAsset(ref.trajectoryId);
      if (this.tearDownComplete) return false;
      const problem = positionRefAssetProblem(ref, asset);
      if (problem) {
        console.warn(`cameraFollowActor: ${problem}——跟随没有生效`);
        return false;
      }
    }
    this.cameraFollowTargetId = null;
    this.cameraFollowRef = ref;
    this.cameraFollowSnap = snap;
    return true;
  }

  private trajectorySpawnCounter = 0;
  /**
   * `playTrajectory.spawn`：临时生成运动对象。图片 = "道具 = 没有动画包的普通 NPC"（`displayImage` 合成单帧动画包），
   * 角色模板 = `characterId`（动画包从角色注册表继承）。与场景 JSON 里的 NPC 走同一条实例化管线。
   * id 已存在于场景时直接用现有实体（不重复生成）。
   */
  private async spawnTrajectoryActor(spec: TrajectorySpawnSpec, at: { x: number; y: number }): Promise<Npc | null> {
    const id = spec.id || `_traj_${++this.trajectorySpawnCounter}`;
    const existing = this.sceneManager.getNpcById(id);
    if (existing) {
      console.warn(`[trajectory] 临时生成的 id "${id}" 已在场景里，直接用它`);
      return existing;
    }
    const def: NpcDef = { id, name: spec.name ?? id, x: at.x, y: at.y, interactionRange: 0 };
    if (spec.burnable) {
      // 动态创建的可燃物（A3.8）：渲染由模板实例接管；玩家能按 E 点的给一个与样例热点同尺度的交互范围
      def.burnable = spec.burnable;
      if (spec.burnable.playerIgnite !== false) def.interactionRange = SPAWNED_BURNABLE_INTERACTION_RANGE;
    }
    if (spec.kind === 'image' && spec.src) {
      def.displayImage = { image: spec.src, worldWidth: spec.worldWidth ?? 0, worldHeight: spec.worldHeight ?? 0 };
    } else if (spec.kind === 'character' && spec.characterId) {
      def.characterId = spec.characterId;
    }
    if (spec.anchor) def.anchor = { x: spec.anchor.x, y: spec.anchor.y };
    // 自发光 / 贴图已烤好光的道具：原样传给 NpcDef 那一个开关，不新造语义
    if (spec.renderRaw) def.renderRaw = true;
    return this.sceneManager.spawnRuntimeNpc(def, { persistent: spec.keep === true });
  }

  /**
   * 过场里引用到的轨迹资产开机预载（不阻塞启动，失败只 warn）。
   * 为什么要预载：`playTrajectory` 第一次播某资产要 fetch 一次，过场若恰在那一瞬被跳过，
   * `finishAll` 先于开播发生，轨迹会在过场结束后才起步。预载把这个窗口关掉。
   * 热区 / 对话里的引用仍是惰性装载（那些路径没有"跳过"语义）。
   */
  private preloadCutsceneTrajectoryAssets(): void {
    const ids = new Set<string>();
    const walk = (steps: unknown): void => {
      if (!Array.isArray(steps)) return;
      for (const s of steps) {
        if (!s || typeof s !== 'object') continue;
        const step = s as { kind?: string; type?: string; params?: Record<string, unknown>; tracks?: unknown };
        if (step.kind === 'parallel') {
          walk(step.tracks);
          continue;
        }
        if (step.kind === 'action' && step.type === 'playTrajectory') {
          const id = String(step.params?.trajectoryId ?? '').trim();
          if (id) ids.add(id);
        }
      }
    };
    for (const cid of this.cutsceneManager.getCutsceneIds()) {
      walk(this.cutsceneManager.getCutsceneDef(cid)?.steps);
    }
    for (const id of ids) void this.loadTrajectoryAsset(id);
  }

  /**
   * 角色（`character_registry.json` 的 id）→ 当前场景里引用了它的那个摆放的实体 id。
   *
   * 头顶闲聊的「角色档」说话人用：角色是跨场景的身份，具体由哪个摆放来说，只有站到
   * 当前场景才知道。**只认当前场景的 NPC**——与 `resolveEmoteTarget` 的场景相对口径一致。
   *
   * 同一角色在本场有多个摆放时的取法：**优先可见的那个**，一个可见的都没有才回落到
   * 第一个（都按场景声明序，确定性可复现；校验器对多摆放另报 warning）。
   *
   * ⚠ 可见性只当**平手时的拉票**，不当准入门槛：实体档走 `resolveEmoteTarget`，它压根
   * 不看可见性；角色档要是把"不可见＝不在场"升成硬条件，同一个被条件藏起来的 NPC
   * 就会"配成角色档闭嘴、配成实体档照说"——两档口径分裂比气泡飘在隐身人头上更难查。
   */
  private resolveCharacterEntityId(characterId: string): string | null {
    const want = String(characterId ?? '').trim();
    if (!want) return null;
    let fallback: string | null = null;
    for (const npc of this.sceneManager.getCurrentNpcs()) {
      if (String(npc.def.characterId ?? '').trim() !== want) continue;
      if (npc.container.visible) return npc.def.id;
      if (fallback === null) fallback = npc.def.id;
    }
    return fallback;
  }

  private async refreshTextResolveLookups(): Promise<void> {
    this.sceneDisplayNameById.clear();
    try {
      const mapConfig = await this.assetManager.loadJson<MapNodeDef[] | MapConfigFile>(TEXT_URLS.mapConfig);
      const nodes = Array.isArray(mapConfig) ? mapConfig : (Array.isArray(mapConfig.nodes) ? mapConfig.nodes : []);
      for (const n of nodes) {
        if (n.sceneId) this.sceneDisplayNameById.set(n.sceneId, n.name);
      }
    } catch {
      /* no map */
    }

    this.npcDisplayNameById.clear();
    const sceneIds = new Set<string>();
    for (const sid of this.sceneDisplayNameById.keys()) sceneIds.add(sid);
    if (this.gameConfig.initialScene) sceneIds.add(this.gameConfig.initialScene);
    if (this.gameConfig.fallbackScene) sceneIds.add(this.gameConfig.fallbackScene);

    await Promise.all(
      [...sceneIds].map(async (sid) => {
        try {
          const raw = await this.assetManager.loadJson<{ npcs?: { id: string; name: string }[] }>(
            sceneJsonUrl(sid),
          );
          for (const npc of raw.npcs ?? []) {
            if (npc?.id) this.npcDisplayNameById.set(npc.id, npc.name ?? npc.id);
          }
        } catch {
          /* missing scene */
        }
      }),
    );
  }

  private wireTextResolve(): void {
    /**
     * 展示通道一律**保留** `[c:…]` 样式标记：全部展示点已走 `createStyledText`（Pixi tagged text），
     * 标记在那里变成颜色。**唯一例外**是下面 `setResolveConditionLiteral`——那是拿来比较的字面量，
     * 不是给人看的，必须走剥标记的 `resolveDisplayText`，否则「档案条件字面量」会被色标记带偏。
     */
    const fn = (s: string) => this.resolveRichText(s);
    this.stringsProvider.setResolveDisplay(fn);
    this.actionExecutor.setResolveNotificationText(fn);
    this.graphDialogueManager.setResolveDisplay(fn);
    this.documentRevealManager.setResolveConditionLiteral((s) => this.resolveDisplayText(s));
    this.encounterManager.setResolveDisplay(fn);
    this.archiveManager.setResolveForDisplay((raw) => this.resolveRichText(raw));
    this.inspectBox.setResolveDisplay(fn);
    this.shopUI.setResolveDisplay(fn);
    this.mapUI.setResolveDisplay(fn);
    this.questPanelUI.setResolveDisplay(fn);
    this.questBannerUI.setResolveDisplay(fn);
    this.guidanceLayerUI.setResolveDisplay(fn);
    this.rulesPanelUI.setResolveDisplay(fn);
    this.inventoryUI.setResolveDisplay(fn);
    this.cutsceneRenderer.setResolveDisplay(fn);
    const narrKey = this.stringsProvider.get('dialogue', 'narratorLabel');
    const narratorFallback = narrKey && narrKey !== 'narratorLabel' ? narrKey : '旁白';
    this.cutsceneManager.setColonSpeakerNarratorBaselineResolved(this.resolveRichText(narratorFallback));
    this.cutsceneManager.setDisplayTextResolver(fn);
    this.hud.setResolveDisplay(fn);
    this.ruleUseUI.setResolveDisplay(fn);
    // 事件日志存的是 raw（`[tag:…]` 原样入档），显示时才解析——与全站同一注入范式
    this.dialogueLogUI.setResolveDisplay(fn);
  }

  /**
   * 事件日志（K3）的三条接线：数据口、时刻戳、跳转路由。
   *
   * 跳转的统一形状是「`switchToPanel` 换过去 → 目标面板 `focusEntry` 定位」：
   * 前半截保证走状态机的唯一通道（关旧开新、压栈平衡，与 HUD 入口条同一条路），
   * 后半截是各面板自己的定位入口。**路由只认 id，不认各面板的行 key 格式**——
   * key 的构造留在各面板内部，复制到这里就会漂。
   */
  private wireGameLog(): void {
    this.dialogueLogUI.setDataProvider(this.gameLogManager);
    this.gameLogManager.setStampProvider(() => ({
      day: this.dayManager.currentDay,
      phase: this.dayManager.currentPhaseLabel,
    }));
    this.dialogueLogUI.setJumpHandler((link) => this.jumpFromLog(link));
    // HUD 的日志入口红点。提示条一闪而过是**有意保留**的手感（2026-08-17 拍板），
    // 所以必须有个东西告诉玩家「刚才那几条还在，L 键可查」——否则日志没人去开。
    this.hud.setPanelUnreadProvider((panel) =>
      panel === 'dialogueLog' && this.gameLogManager.unreadCount() > 0);
  }

  /**
   * 日志条目 → 目标面板。
   *
   * 定位失败（东西已经用掉/丢掉、条目还没解锁）**不静默**：面板照样换过去，
   * 另冒一条木条说明"那件东西已经不在了"——玩家点了总得有回音（拒绝路径也要有反馈）。
   */
  private jumpFromLog(link: GameLogLink): void {
    const missing = (): void => {
      this.eventBus.emit('notification:show', {
        text: this.stringsProvider.get('notifications', 'logTargetGone'),
        type: 'info',
      });
    };
    switch (link.kind) {
      case 'quest': {
        this.stateController.switchToPanel('quest');
        if (!this.questPanelUI.focusEntry(link.id)) missing();
        return;
      }
      case 'item': {
        this.stateController.switchToPanel('inventory');
        if (!this.inventoryUI.focusEntry(link.id)) missing();
        return;
      }
      case 'rule': {
        this.stateController.switchToPanel('rules');
        if (!this.rulesPanelUI.focusEntry(link.id)) missing();
        return;
      }
      case 'clue': {
        this.stateController.switchToPanel('bookshelf');
        this.bookshelfUI.openAt('clues', link.id);
        return;
      }
      case 'archive': {
        // 册子 id 与书架槽 id 的对应表**只在这里一份**：它是路由知识（哪本册子装哪类条目），
        // 不是册子的内部知识，放在册子里反而要每本都知道自己在架上叫什么。
        const shelfSlot: Record<string, string> = {
          character: 'character',
          lore: 'lore',
          document: 'document',
          slang: 'slang',
          rhyme: 'rhyme',
        };
        const slot = shelfSlot[link.bookType];
        this.stateController.switchToPanel('bookshelf');
        if (slot) {
          this.bookshelfUI.openAt(slot, link.id);
          return;
        }
        // `book` 通道：id 可能是一本书，也可能是某本书里的一条轶闻。
        // 是书就直接翻开那本；是轶闻则找它所在的书翻开（定位到条一级由阅读器自理，
        // 这里不越过它的目录模型去指页）。
        if (link.bookType === 'book') {
          const books = this.archiveManager.getBooks();
          const direct = books.find(b => b.id === link.id);
          const owner = direct ?? books.find(b =>
            b.pages.some(p => (p.entries ?? []).some(e => e.id === link.id)));
          if (owner) {
            this.bookshelfUI.openAt(`book_${owner.id}`);
            return;
          }
        }
        missing();
        return;
      }
    }
  }

  async start(options: GameStartOptions = {}): Promise<void> {
    this.isDevMode = !!options.devMode;
    /** DEV 构建暴露实例句柄供页内诊断直读（运行时命令通道配方：严肃断言直读 __game 私有字段，
     *  不经共享快照通道）。prod 构建不挂。 */
    if (import.meta.env.DEV && typeof window !== 'undefined') {
      (window as unknown as Record<string, unknown>).__game = this;
      // UI 取景台（__uiPose / __uiShot / __uiShotAll）：观感改造的审查循环靠它出全分辨率对照图
      void import('../dev/uiShotHarness').then(m => m.installUIShotHarness(this));
    }
    await this.renderer.init(options.visualCapture ? { resolution: 1 } : undefined);
    /** P3：start 期间被 destroy（HMR / 秒关页）后不再继续装配，各主要 await 后同样早退 */
    if (this.tearDownComplete) return;
    this.emoteBubbleManager.setEntityAttachLayer(this.renderer.entityLayer);
    // 实体层就是 worldContainer 的直接子节点（同一坐标），屏幕左上角换成世界点 + 视野宽高 = 看得见的那块
    this.emoteBubbleManager.setViewRectProvider(() => {
      const tl = this.camera.screenToWorld(0, 0);
      return { minX: tl.x, minY: tl.y, maxX: tl.x + this.camera.getViewWidth(), maxY: tl.y + this.camera.getViewHeight() };
    });
    this.vfxRenderer = new VfxRenderer({
      entityLayer: this.renderer.entityLayer,
      createLitShader: (program, colorTex, extra) => this.characterLighting.createCustomLitShader(program, colorTex, extra),
      releaseLitShader: (sh) => this.characterLighting.releaseEntityLitShader(sh),
      canLight: () => this.characterLighting.canCreateCustomLitShader,
      getLightFactors: () => this.characterLighting.getLightFactors('particles'),
      displayUniforms: this.characterLighting.displayUniforms,
      // 没有照明载荷时 NPC 走 EntityLightingFilter 的色调融入：同一张辐照 probe、同一份光照环境
      // （光环境曲线逐帧原地改 env，这里每帧现取）。toneEnabled 关 ⇒ 强度 0，与 applyShadowAndAO 同口径。
      getToneEnv: () => {
        const env = this.currentLightEnv;
        const probe = this.currentProbe;
        if (!env || !probe) return null;
        return {
          probe: probe.source,
          strength: env.toneEnabled ? env.toneStrength : 0,
          key: env.key,
          ambient: env.ambient,
        };
      },
      getDepth: () => {
        const tex = this.sceneDepthSystem.currentDepthTexture;
        const cfg = this.sceneDepthSystem.currentConfig;
        return tex && cfg ? { tex, cfg } : null;
      },
      getSceneSize: () => {
        const sd = this.sceneManager.currentSceneData;
        return { w: sd?.worldWidth ?? 1, h: sd?.worldHeight ?? 1 };
      },
      perspective: (fx, fy) => this.perspectiveScaleResolver?.scaleAt(fx, fy) ?? 1,
      // 躺在草木上的纸钱跟着背景摆动走（同一份风、同一个钟）
      swayAt: (sx, sy, wx, wz, out) =>
        this.swayBackground?.offsetAt(this.sceneWind.params, this.sceneWind.time, sx, sy, wx, wz, out) ?? false,
      // 视口剔除：常驻效果铺满整张场景图，屏外的粒子不必逐顶点投影
      getScreen: () => ({ w: this.renderer.app.screen.width, h: this.renderer.app.screen.height }),
    });
    this.vfxSystem.setRenderer(this.vfxRenderer);
    /**
     * 粒子 shader 第一次用到时 Pixi 同步编译：受光粒子秒级（2026-09-16 实测进茶馆第一帧 11 s、第一次点火把同样）。
     * 开局就在后台线程编（不阻塞），每次装场景在揭幕前闸里（遮罩下）等它编完并交给 Pixi；
     * 同一个闸里把本场景的粒子预热也跑完（原来挤在揭幕后第一帧）。两件都限时、永不悬挂。
     */
    this.glProgramWarmup = new GlProgramWarmup(
      () => glWarmupTargetOf(this.renderer.app.renderer),
      (m) => { if (import.meta.env.DEV) console.warn(m); this.debugPanelUI?.log(m); },
    );
    this.glProgramWarmup.request(vfxGlPrograms());
    this.sceneManager.setRevealGate(async () => {
      await Promise.all([
        this.glProgramWarmup?.whenReady(REVEAL_GATE_SHADER_TIMEOUT_MS),
        this.vfxSystem.prepareForReveal(REVEAL_GATE_VFX_TIMEOUT_MS),
      ]);
      // Static sampling geometry belongs to loading, never to the first visible bolt.
      const space = this.vfxSystem.currentSpace;
      const shell = this.sceneDepthSystem.depthShellField;
      const rows = basisRowsFromDepthConfigR(this.sceneDepthSystem.currentConfig?.M?.R);
      if (!this.tearDownComplete && space?.kind === 'field' && shell && rows) {
        buildStrikeSurfaceCandidates({ space, shell, basis: { basisRows: rows, wuPerQUnit: space.wuPerQ },
          groundAllowed: this.strikeGroundAllowed, groundOnly: false, maxSlopeDeg: 90 });
      }
    });

    // UI 皮肤素材（做旧木框九宫格 + 纸纹）必须赶在任何面板首次构建之前到位，
    // 否则那一次会画成纯色降级版、且不会自动重画。单张失败只降级该张，不阻断启动。
    await preloadUITextures();
    // 图标晚到一帧只是这一帧没图标，不卡启动，所以不 await
    void preloadUIIcons();

    await this.stringsProvider.load(this.assetManager);

    await this.loadGameConfig();
    if (this.tearDownComplete) return;
    if (this.gameConfig.windowSize) {
      this.renderer.setWindowSize(this.gameConfig.windowSize.width, this.gameConfig.windowSize.height);
    }
    if (this.gameConfig.viewport) {
      this.renderer.setViewportSize(this.gameConfig.viewport.width, this.gameConfig.viewport.height);
    }
    // 文本语义色板（缺省回落到内置档位）。必须排在任何 UI 建 Text 之前——
    // tagStyles 是建 Text 时快照进样式的，色板晚到的话先建出来的文字永远不上色。
    setTextPalette(this.gameConfig.textPalette);
    this.playerIdleBehaviorSystem.setConfig(this.gameConfig.playerAvatar?.idle);
    // 头顶气泡全局缩放（缺省 1）；单处仍可用 action / 对话行的 bubbleScale 覆盖
    this.emoteBubbleManager.setDefaultScale(
      normalizeEmoteBubbleScale(this.gameConfig.emoteBubbleScale, 1),
    );
    /** game_config.health → HealthSystem：构造期 init 已按默认配置执行；configure 后按
     *  IGameSystem「重 init 与首次一致」契约重跑 init 套用上限/阈值（此时尚无伤害与存档写入）。 */
    if (this.gameConfig.health) {
      this.healthSystem.configure(this.gameConfig.health);
      this.healthSystem.init({
        eventBus: this.eventBus,
        flagStore: this.flagStore,
        strings: this.stringsProvider,
        assetManager: this.assetManager,
      });
    }
    /** game_config.dayNight → DayManager：无条件调用（缺省段也要落到时段表上）。
     *  configure 只在时刻尚未被动过时同步开局时刻，故不必像 health 那样重跑 init。 */
    this.dayManager.configure(this.gameConfig.dayNight);

    this.inspectBox = new InspectBox(this.renderer, this.stringsProvider);
    // eventBus 给到回执条做电影化静默（过场里入队、cutscene:end 补冒）
    this.pickupNotification = new PickupNotification(this.renderer, this.stringsProvider, this.eventBus);
    // 新任务醒目横幅（玩法文档 D9）与任务引导层（D8）：两者都是常驻展示件，
    // 不进 stateController 的面板栈（没有可交互元素，也不该抢返回栈）。
    this.questBannerUI = new QuestBannerUI(this.renderer, this.eventBus, this.stringsProvider);
    // 只在探索态弹横幅：对话/过场/小游戏/全屏面板里压住，回到探索再出（D9 规则 3）
    this.questBannerUI.setSuppressed(() => this.stateController?.currentState !== 'Exploring');
    this.guidanceLayerUI = new GuidanceLayerUI(this.renderer, this.camera, this.eventBus);
    this.guidanceLayerUI.setQuestDataProvider(this.questManager);
    // 过场与全屏面板期间收起引导：它是给"在场景里走"的玩家看的
    this.guidanceLayerUI.setHidden(() => {
      const s = this.stateController?.currentState;
      return s !== undefined && s !== 'Exploring';
    });
    this.guidanceLayerUI.setPointResolver((sceneId, kind, entityId) =>
      this.resolveGuidanceWorldPoint(sceneId, kind, entityId));
    this.guidanceLayerUI.setPlayerPointProvider(() =>
      this.player ? { x: this.player.x, y: this.player.y } : null);
    this.dialogueUI = new DialogueUI(
      this.renderer, this.eventBus, this.stringsProvider, this.assetManager, this.textDisplaySettings,
    );
    /**
     * `layout: 'bubble'` 档的跟随源：说话实体 → **屏幕坐标**（气泡底边应落的那个点）。
     * 世界→屏幕的换算要相机，那是这一层的知识，不下放给 UI。
     *
     * 锚点世界点的口径与 EmoteBubbleManager 的跟随**逐字一致**
     * （`displayObj.x` / `displayObj.y + anchorLocalY`）——两套气泡指向同一个头顶，
     * 否则同一句话的「…」小气泡与对白气泡会各指一处。
     * 解析不出（旁白 / 不在场）→ null，UI 侧落屏幕正中。
     */
    this.dialogueUI.setSpeakerScreenAnchorResolver((entity) => {
      if (!entity) return null;
      // 气泡档每帧都来问：走轮询入口，结果变了才记日志
      const anchor = this.pollEmoteTarget('对白气泡跟人', entity.kind === 'player' ? 'player' : entity.npcId);
      if (!anchor) return null;
      const displayObj = anchor.getDisplayObject() as { x?: number; y?: number } | null;
      if (!displayObj || typeof displayObj.x !== 'number' || typeof displayObj.y !== 'number') return null;
      return this.camera.worldToScreen(
        displayObj.x,
        displayObj.y + anchor.getEmoteBubbleAnchorLocalY(),
      );
    });
    // 说话中「…」气泡：当前行说话实体头顶挂常驻气泡（与对话大头像并存指示说话对象），
    // 换行随说话人移动、旁白无实体则收起、对话结束即撤。
    const SPEAKING_BUBBLE_OWNER = 'dialogue-speaking';
    this.eventBus.on('dialogue:line', (line: DialogueLine) => {
      this.emoteBubbleManager.cleanupByOwner(SPEAKING_BUBBLE_OWNER);
      const se = line.speakerEntity;
      if (!se) return;
      const anchor = se.kind === 'player' ? this.player : this.sceneManager.getNpcById(se.npcId);
      if (!anchor) return;
      // 本行授权了绝对头顶锚就用它（图对话行级/节点级可编排），否则实体按当前帧内容自算
      const hasAnchor = typeof line.bubbleAnchorY === 'number' && Number.isFinite(line.bubbleAnchorY);
      const hasScale = typeof line.bubbleScale === 'number' && Number.isFinite(line.bubbleScale)
        && line.bubbleScale > 0;
      const opts = hasAnchor || hasScale
        ? {
            ...(hasAnchor ? { anchorY: line.bubbleAnchorY } : {}),
            ...(hasScale ? { scale: line.bubbleScale } : {}),
          }
        : undefined;
      this.emoteBubbleManager.showSticky(anchor, '……', opts, SPEAKING_BUBBLE_OWNER);
    });
    const clearSpeakingBubble = () => this.emoteBubbleManager.cleanupByOwner(SPEAKING_BUBBLE_OWNER);
    this.eventBus.on('dialogue:end', clearSpeakingBubble);
    this.eventBus.on('dialogue:hidePanel', clearSpeakingBubble);
    this.encounterUI = new EncounterUI(
      this.renderer, this.eventBus, this.stringsProvider, this.textDisplaySettings,
    );
    this.actionChoiceUI = new ActionChoiceUI(this.renderer, this.stringsProvider);
    this.pressureHoldUI = new PressureHoldUI(this.renderer, this.stringsProvider);
    this.hud = new HUD(this.renderer, this.eventBus, this.stringsProvider);
    // 气缕指向偏好（G.6）：HUD 每帧现读，所以赶在 hydrate 之前注入也不要紧——
    // 偏好读回来的下一帧就会按新值重画
    this.hud.setSmellDisplaySettings(this.smellDisplaySettings);
    // HUD 的当前任务芯片是**查询式**的：quest:changed 只喊"该查了"，真相在 QuestManager
    this.hud.setQuestDataProvider(this.questManager);
    // 系统说明卡的开卡函数（UI 归 ui 层，系统层不 import 它）：压暗全屏但给被说明的读数留口子。
    // 卡开着 = UI 覆盖态（与压力小游戏 runSegment 同一把锁）：探索输入整体停住，关卡恢复原状态。
    this.systemNoteManager.setOpener(async (def, signal) => {
      this.systemNotePauseDepth++;
      try {
        await this.runInGameState(GameState.UIOverlay, () =>
          openSystemNote(this.renderer, this.assetManager,
            { ...def, title: this.resolveDisplayText(def.title), body: this.resolveRichText(def.body) }, {
          signal,
          strings: this.stringsProvider,
          spotlight: def.hudAnchor === 'threeFires'
            ? this.hud.getThreeFiresScreenRect()
            : def.hudAnchor === 'smell'
              ? this.hud.getSmellScreenRect()
              : null,
          }),
        );
      } finally { this.systemNotePauseDepth = Math.max(0, this.systemNotePauseDepth - 1); }
    });
    this.notificationUI = new NotificationUI(this.renderer, this.eventBus);
    // **只有过场与切场加载**压住提示条出队（电影化静默；priority='system' 的过场跳过确认
    // 仍越过静默）。面板开着时提示必须**立即、最顶层**弹出——玩家在册子里点词条采集，
    // 回执推迟到关面板之后等于没回执（2026-08-18 制作人拍板，推翻早前「UIOverlay 也压」
    // 的做法；toast 的 z 恒在面板之上，遮挡由车道位承担）。SceneTransition 沿袭旧「切场
    // 假 Cutscene 锁」时代的行为：加载遮罩下入队、揭幕补冒，不弹在黑幕上。
    this.notificationUI.setSuppressed(() => {
      const s = this.stateController?.currentState;
      return s === 'Cutscene' || s === 'SceneTransition';
    });
    this.questPanelUI = new QuestPanelUI(
      this.renderer, this.questManager, this.stringsProvider, this.eventBus,
    );
    this.inventoryUI = new InventoryUI(this.renderer, this.eventBus, this.inventoryManager, this.stringsProvider);
    this.rulesPanelUI = new RulesPanelUI(this.renderer, this.rulesManager, this.stringsProvider);
    this.dialogueLogUI = new DialogueLogUI(this.renderer, this.eventBus, this.stringsProvider);
    this.bookReaderUI = new BookReaderUI(this.renderer, this.archiveManager, this.stringsProvider, this.assetManager);
    this.bookshelfUI = new BookshelfUI(
      this.renderer,
      this.archiveManager,
      // 规矩本：**另建一份实例**当书架子面板，与其余六本同形（能「返回书架」）。
      // 不复用 R 键那一份——同一实例走两条打开路径时，`closePanel('rules')` 会去弹
      // 书架压进 overlayReturnStack 的那一层，状态与栈直接叠歪。
      (onClose, entryId) => {
        const s = new RulesPanelUI(this.renderer, this.rulesManager, this.stringsProvider);
        s.setResolveDisplay((raw) => this.resolveRichText(raw));
        s.openAsSubPanel(onClose);
        if (entryId) s.focusEntry(entryId);
        return s;
      },
      (book, onClose) => {
        this.bookReaderUI.openBook(book, onClose);
        return this.bookReaderUI;
      },
      // 各本册子的 `entryId` 是事件日志「进册」条目跳过来的定位目标（可选，缺省即普通打开）。
      // 行 key 的构造归各册自己（`char_…`/`lore_…`…），这里只把 id 递过去。
      (onClose, entryId) => { const s = new CharacterBookUI(this.renderer, this.archiveManager, onClose, this.stringsProvider, this.assetManager); s.open(); if (entryId) s.focusEntry(entryId); return s; },
      (onClose, entryId) => { const s = new LoreBookUI(this.renderer, this.archiveManager, onClose, this.stringsProvider, this.assetManager); s.open(); if (entryId) s.focusEntry(entryId); return s; },
      (onClose, entryId) => { const s = new DocumentBoxUI(this.renderer, this.archiveManager, onClose, this.stringsProvider, this.assetManager); s.open(); if (entryId) s.focusEntry(entryId); return s; },
      (onClose, entryId) => { const s = new SlangBookUI(this.renderer, this.archiveManager, onClose, this.stringsProvider, this.assetManager); s.open(); if (entryId) s.focusEntry(entryId); return s; },
      (onClose, entryId) => { const s = new RhymeBookUI(this.renderer, this.archiveManager, onClose, this.stringsProvider, this.assetManager); s.open(); if (entryId) s.focusEntry(entryId); return s; },
      (onClose, entryId) => { const s = new ClueBookUI(this.renderer, this.archiveManager, this.clueManager, onClose, this.stringsProvider, this.assetManager); s.open(); if (entryId) s.focusEntry(entryId); return s; },
      // 线索簿未读 = 有已采集但没在册子里点开过的词条（读集是档案通用泛键 cluebook_<id>）
      () => this.clueManager.getCollectedClues().some((c) => !this.archiveManager.isRead(`cluebook_${c.id}`)),
      this.stringsProvider,
    );
    this.shopUI = new ShopUI(this.renderer, this.eventBus, this.inventoryManager, this.stringsProvider, this.assetManager);
    this.mapUI = new MapUI(this.renderer, this.eventBus, this.flagStore, this.stringsProvider, this.assetManager);
    this.mapUI.setQuestDataProvider(this.questManager);

    this.cutsceneRenderer = new CutsceneRenderer(this.renderer, this.camera, this.assetManager, () => this.gameClock.now);
    // 呼吸图挂在叠图同一层(同一套 id 句柄,hideOverlayImage / 过场 cleanup 都收得掉);推进走 tick 里的暂停闸
    this.breathingOverlaySystem = new BreathingOverlaySystem({
      loadDefJson: (id) => this.assetManager.loadJson(breathingJsonUrl(id)),
      loadTexture: (path) => this.assetManager.loadTexture(path),
      fetchBytes: (path) => fetchPayloadBytes(resolveAssetPath(path)),
      showLayer: (id, w, h, x, y, wp, order, prepare) => this.cutsceneRenderer.showBreathingLayer(id, w, h, x, y, wp, order, prepare),
      hideLayer: (id) => this.cutsceneManager.hideOverlayImage(id),
      startBreathSound: () => this.audioManager.startProceduralBreath(),
    });
    // 过场对白框复用全站面板皮肤 + 主题色，与常规对话框(DialogueUI)对齐观感。
    // 皮肤/主题属 UI 层，渲染层不反向依赖——在组装层绑好绘制器与颜色再注入。
    const strings = this.stringsProvider;
    this.cutsceneRenderer.setDialoguePanelStyle({
      // 走 createPanel（返回容器）而不是 drawPanelBase：皮肤里的做旧木框是九宫格 Sprite，
      // 画不进 Graphics——用旧钩子的话过场对白框只有平底，跟同一段戏里的常规对话框材质对不上。
      buildBox: (x, y, w, h) => createPanel(x, y, w, h, SKINS.dialogue),
      buildSpeakerPlate: (x, y, w, h) => createPanel(x, y, w, h, SKINS.nameplate),
      buildSelfSpeakerPlate: (x, y, w, h) => createPanel(x, y, w, h, SKINS.speakerSelf),
      speakerColor: UITheme.colors.title,
      selfSpeakerColor: UITheme.colors.speakerSelf,
      bodyColor: UITheme.colors.body,
      fontFamily: UITheme.fonts.ui,
      displayFontFamily: UITheme.fonts.display,
      // 第一人称档句首不给旁白写名字：旁白的显示名在字符串表里，现读（装配时表可能还没载完）
      get narratorLabel(): string {
        const v = strings.get('dialogue', 'narratorLabel');
        return v && v !== 'narratorLabel' ? v : '';
      },
      // 「继续」点捺与常规对话框同一个件；渲染层不 import ui，故走注入
      buildContinueMark: (x, y) => {
        const mark = new ContinueIndicator();
        mark.setPosition(x, y);
        mark.setVisible(true);
        return {
          view: mark.container,
          update: (dt: number) => mark.update(dt),
          setVisible: (v: boolean) => mark.setVisible(v),
        };
      },
    });
    // 逐字显示是玩家偏好，过场台词（对白框/字幕）与 DialogueUI / EncounterUI 吃同一份设置
    this.cutsceneRenderer.setTextDisplaySettings(this.textDisplaySettings);
    this.cutsceneManager = new CutsceneManager(
      this.eventBus, this.flagStore, this.actionExecutor,
      this.cutsceneRenderer,
    );
    this.cutsceneManager.init({ eventBus: this.eventBus, flagStore: this.flagStore, strings: this.stringsProvider, assetManager: this.assetManager });
    this.cutsceneManager.setInputManager(this.inputManager);
    this.cutsceneManager.setAudioManager(this.audioManager);
    this.cutsceneManager.setVoiceChannel(this.voiceChannel);
    this.cutsceneManager.setSkipConfirmTextProvider(() => this.stringsProvider.get('cutscene', 'skipConfirm'));
    // K7 线索：采集回执文案 + 册面/成书/对话框的词条通道（模块级单点注入，见 ui/clueAccess）
    this.clueManager.setCollectTextProvider((def) =>
      this.stringsProvider.get('notifications', 'clueCollected', { title: def.title }));
    setClueAccess({
      isCollected: (id) => this.clueManager.isCollected(id),
      collect: (id) => { this.clueManager.collect(id); },
      isKnown: (id) => this.clueManager.isKnownClue(id),
    });
    // 面板条目切换音：与对话选项切换用同一枚（ui:hover → systemSfx.uiHover）。
    // 接在 UIFocus 那一处，全站面板一次到位——见 UIFocus.setFocusChangeSound。
    // 连发/同帧双响由 AudioManager 在消费端节流，这里只管"换项了"这件事实。
    setFocusChangeSound(() => this.eventBus.emit('ui:hover', {}));
    const cmEntry = this.registeredSystems.find(e => e.name === 'cutsceneManager');
    if (cmEntry) cmEntry.system = this.cutsceneManager;
    /**
     * 唯一 resolveActor 入口。查询顺序：
     *   1. CutsceneManager 临时表（_cut_ 前缀）
     *   2. 场景 NPC（sceneManager.getNpcById）
     *   3. player（id === 'player'）
     * 对话、热区、过场、Timeline、移动/朝向等共用此实例。
     * showEmote 另见 resolveEmoteTarget：在以上结果之外可解析当前场景热点 id。
     */
    this.resolveActorFn = (id: string) => {
      const temp = this.cutsceneManager.getTempActors().get(id);
      if (temp) return temp;
      const npc = this.sceneManager.getNpcById(id);
      if (npc) return npc;
      if (id === 'player') return this.player;
      return null;
    };
    this.cutsceneManager.setEntityResolver(this.resolveActorFn);
    this.cutsceneManager.setEmoteBubbleProvider(this.emoteBubbleManager);
    // 轨迹：只给过场两件能力，不把 TrajectorySystem 实例交出去（分层律 11）。
    this.cutsceneManager.setTrajectoryController({
      finishAll: () => this.trajectorySystem.finishAll(),
      setFastForward: (on) => this.trajectorySystem.setFastForward(on),
    });
    this.cutsceneManager.setEmoteTargetResolver((raw) => this.resolveEmoteTarget(raw));
    // cameraMove 的可选 `at`：与动作侧同一份位置引用求值（一次性摆位，不是跟随）
    this.cutsceneManager.setPositionRefResolver((raw) => this.resolvePositionRef(raw));
    this.cutsceneManager.setSceneSwitcher(async (params) => {
      this.pickupNotification.forceCleanup();
      if (this.inspectBox.isOpen) this.inspectBox.close();
      const cameraPos = typeof params.cameraX === 'number' && typeof params.cameraY === 'number'
        ? { x: params.cameraX, y: params.cameraY }
        : undefined;
      await this.sceneManager.switchScene(
        params.targetScene,
        params.targetSpawnPoint,
        cameraPos,
      );
    });
    this.cutsceneManager.setSceneIdGetter(() => this.sceneManager.currentSceneData?.id ?? null);
    this.cutsceneManager.setPlayerPositionGetter(() => ({ x: this.player.x, y: this.player.y }));
    // 气味飘向按玩家相对气味源现算（G.6）：同一套 getter 注入，系统不持有玩家/场景管理器引用
    this.smellSystem.setSceneIdGetter(() => this.sceneManager.currentSceneData?.id ?? null);
    this.smellSystem.setPlayerPositionGetter(() => ({ x: this.player.x, y: this.player.y }));
    // 气味源是位置引用（实体此刻位置 / 曲线插槽 / 曲线上的点）：每帧同步求值；曲线资产没装过就先装，
    // 装完之前这几帧当"求不出"（气缕直的），不出声。
    this.smellSystem.setSourceEvaluator((ref) => {
      if ((ref.kind === 'slot' || ref.kind === 'curve') && !this.trajectoryAssets.has(ref.trajectoryId)) {
        void this.loadTrajectoryAsset(ref.trajectoryId);
        return null;
      }
      return this.evaluatePositionRefNow(ref);
    });
    this.cutsceneManager.setPlayerPositionSetter((x, y) => { this.player.x = x; this.player.y = y; });
    this.cutsceneManager.setCameraAccessor(this.camera);
    this.cutsceneManager.setSceneManager(this.sceneManager);
    this.cutsceneManager.setSpawnPointResolver((spawnKey: string) => {
      const scene = this.sceneManager.currentSceneData;
      if (!scene) return null;
      if (!spawnKey) return scene.spawnPoint ?? null;
      return scene.spawnPoints?.[spawnKey] ?? null;
    });
    this.cutsceneManager.setScriptedSpeakerResolver((raw, scriptedNpcId) =>
      resolveScriptedSpeakerDisplay(raw, {
        strings: this.stringsProvider,
        flagStore: this.flagStore,
        sceneManager: this.sceneManager,
        graphDialogueNpcId: this.graphDialogueManager.getContextNpcId(),
        fallbackNpcId: scriptedNpcId ?? '',
      }),
    );
    // present:showDialogue 的立绘解析：复用 playScriptedDialogue 同一条逐行头像解析
    // （resolveScriptedLineExtras 只读、不改其自身路径），令过场对白与常规对话头像语义一致。
    this.cutsceneManager.setScriptedPortraitResolver((ref, rawSpeaker, scriptedNpcId) =>
      this.resolveScriptedLineExtras(rawSpeaker, ref, scriptedNpcId ?? '').portrait,
    );
    // present:showDialogue 显示名留空时跟「说话 NPC」走（两者都空才是旁白）。
    this.cutsceneManager.setScriptedSpeakerDisplayFallback((scriptedNpcId) =>
      this.scriptedSpeakerDisplayFallback(scriptedNpcId),
    );
    // present:showDialogue 立绘/名牌分边：与常规对话同一口径（只认说话实体是不是当前受控主角）。
    this.cutsceneManager.setScriptedSpeakerSideResolver((rawSpeaker, scriptedNpcId, override) =>
      resolveSpeakerSide(
        this.resolveScriptedSpeakerEntityForLine(rawSpeaker, scriptedNpcId ?? ''),
        override,
      ),
    );
    // present:showDialogue 的「这句是你说的」标记：只认说话实体是不是当前受控主角。
    this.cutsceneManager.setScriptedSpeakerIsSelfResolver((rawSpeaker, scriptedNpcId) =>
      this.resolveScriptedSpeakerEntityForLine(rawSpeaker, scriptedNpcId ?? '')?.kind === 'player',
    );
    // present:showDialogue 说话人头顶「……」气泡的锚点。旁白/未在场 → null → 不冒。
    // 说话人实体与头像跟随同一口径（占位优先，其次「说话NPC」下拉，旁白不认）。
    this.cutsceneManager.setSpeakingBubbleAnchorResolver((rawSpeaker, scriptedNpcId) => {
      const entity = this.resolveScriptedSpeakerEntityForLine(rawSpeaker, scriptedNpcId ?? '');
      if (!entity) return null;
      return this.resolveEmoteTarget(entity.kind === 'player' ? 'player' : entity.npcId);
    });
    this.saveManager = new SaveManager(
      () => this.collectSaveData(),
      (data) => this.distributeSaveData(data),
      // 读档专用重载（含失败回滚路径）：先静默撤下旧场景活跃 zone——distribute 已把全系统
      // 覆盖为存档时间线，旧时间线 zone 的 onExit 异步批不得再污染恢复后的状态。
      // 只挂在 SaveManager 这条线上：F2 调试重载与其它 reloadScene 调用方语义不变。
      (sceneId) => {
        this.zoneSystem.clearActiveZonesForRestore();
        return this.reloadScene(sceneId);
      },
      this.stringsProvider,
      this.gameConfig.fallbackScene,
    );
    // 存档现在落在文件里（见 storage/persistentStore.ts），读盘是异步的，而
    // `hasAnySave()` / `getSlotMeta()` 被紧接着构造的 MenuUI 在**同步渲染路径**里调用
    // ——标题页要靠它决定「继续」按不按得亮。所以必须在 MenuUI 之前把三个槽水化进内存镜像。
    // hydrate 自己不抛：后端不可用时降级成"无档"，游戏照常起得来。
    await this.saveManager.hydrate();
    // 玩家偏好同一个存放面，同样要赶在 UI 与首句台词之前落位。
    await this.textDisplaySettings.hydrate();
    await this.smellDisplaySettings.hydrate();
    // 音量（总音量 + 四条通道）同是玩家偏好：settings/audio.json，赶在开场第一声之前生效
    await this.audioManager.hydrateMixPreferences();
    // 仅在探索 / UI 覆盖层（暂停菜单打开）可存档；对话/遭遇/演出/小游戏等在途态拒绝存档，
    // 避免半态存档（这些系统不持久化在途状态，读档会丢失或半执行）。
    // 叙事编排排空在飞时同样拒绝：队列/在飞广播不入档，级联中途的档读回后
    // signal 型迁移无法补发（子图到末态、主图停旧里程碑=该档永久卡死，审查 R3）。
    // 该窗口只在长时生命周期动作（waitMs/waitClickContinue/moveEntityTo 等）期间存在，瞬时即逝。
    this.saveManager.setCanSavePredicate(() => {
      const s = this.stateController.currentState;
      if (this.healthSystem.isDepleted() || this.systemNotePauseDepth > 0) return false;
      if (s !== GameState.Exploring && s !== GameState.UIOverlay) return false;
      return this.narrativeStateManager.isIdle();
    });
    this.retrySystem.configure(this.gameConfig.health?.retry);
    this.retrySystem.connect({
      canCapture: () => this.stateController.currentState === GameState.Exploring
        && !!this.sceneManager.currentSceneData && this.saveManager.canSaveNow(),
      capture: () => this.saveManager.capturePayload(),
      load: (raw) => this.saveManager.loadPayload(raw),
      isDepleted: () => this.healthSystem.isDepleted(),
      enterDeath: () => {
        /**
         * ⚠ 顺序：**先收脱手演出，再 cancelPending**。
         * 反过来的话，`cancelPending` 只是把批停在两条动作之间——剩下的结算与归位一条都不跑，
         * 世界就停在"天是黑的、背景音是哑的、闷雷还在响"那一帧上（2026-09-19 的原始故障）。
         */
        this.performanceSessions?.interruptAll('death');
        this.actionExecutor.cancelPending();
        // 在途的游戏时间等待一并兑现：否则被作废的批还攥着一个永远不返回的 await
        this.gameClock.cancelAll();
        this.sceneWind.clearGust();
        this.cutsceneManager.deserialize({});
        this.graphDialogueManager.deserialize({});
        this.dialogueManager.deserialize({});
        this.dialogueUI.hide();
        this.stateController.closeAllPanels();
        this.actionChoiceUI.close();
        this.stateController.setState(GameState.Dead);
        this.playerNavTarget = null;
      },
      closeChoice: () => this.actionChoiceUI.close(),
      showNote: (id) => this.systemNoteManager.show(id),
      choose: (title, options) => this.actionChoiceUI.choose(this.resolveRichText(title),
        options.map((option) => ({ text: this.resolveRichText(option.text) })), false),
      returnToMenu: () => this.eventBus.emit('menu:returnToMain'),
      shownNoteFlags: () => Object.fromEntries(Object.entries(this.flagStore.serialize())
        .filter(([key, value]) => key.startsWith('sysnote_') && value === true)) as Record<string, boolean>,
    });
    this.healthSystem.setDepletionHandler((cause) => this.retrySystem.deplete(cause));
    this.stateController.setDepletionGuard(() => this.healthSystem.isDepleted());
    this.menuUI = new MenuUI(
      this.renderer, this.eventBus, this.saveDataForMenu(options), this.audioManager,
      this.textDisplaySettings, this.smellDisplaySettings, this.stringsProvider,
      // 标题界面右下角那个 dev 小勾（prod build 里这个三元的另一支被静态剔除）
      import.meta.env.DEV
        ? {
          isNarrativeDebugOn: () => this.getNarrativeDebugStatus().installed,
          setNarrativeDebugOn: (on) => {
            if (on) this.enableNarrativeDebugBridge({ persist: true });
            else this.disableNarrativeDebugBridge({ persist: true });
          },
        }
        : null,
    );
    this.ruleUseUI = new RuleUseUI(this.renderer, this.eventBus, this.zoneSystem, this.rulesManager, this.stringsProvider);
    this.debugPanelUI = new DebugPanelUI(
      () => ({
        fps: this.lastFps,
        sceneId: this.sceneManager.currentSceneData?.id ?? undefined,
        state: this.stateController.currentState,
        worldWidth: this.sceneManager.currentSceneData?.worldWidth,
        worldHeight: this.sceneManager.currentSceneData?.worldHeight,
        depthOcclusionEnabled: this.sceneDepthSystem.isEnabled,
        floorOffsetRuntime: this.sceneDepthSystem.isEnabled
          ? this.sceneDepthSystem.floorOffset
          : undefined,
        floorOffsetFromScene: this.sceneDepthSystem.currentConfig?.floor_offset,
        smell: (() => {
          const ds = this.smellSystem.getDebugState();
          return {
            source: ds.source,
            actionScent: ds.action.scent,
            actionIntensity: ds.action.intensity,
            zoneScent: ds.zone.scent,
            zoneIntensity: ds.zone.intensity,
            effectiveScent: ds.effective.scent,
          };
        })(),
      }),
      this.inputManager,
    );
    this.emoteBubbleManager.setDebugPanelLog((msg) => {
      this.debugPanelUI?.log(msg);
    });

    this.camera.setScreenSize(this.renderer.screenWidth, this.renderer.screenHeight);
    this.unsubRendererResize = this.renderer.subscribeAfterResize(() => {
      if (this.tearDownComplete) return;
      this.camera.setScreenSize(this.renderer.screenWidth, this.renderer.screenHeight);
    });
    this.addWindowListener('resize', () => {
      if (this.tearDownComplete) return;
      this.camera.setScreenSize(this.renderer.screenWidth, this.renderer.screenHeight);
    });

    this.setupSceneManager();
    this.registerUIPanels();

    this.encounterManager.setRuleNameResolver((ruleId) => {
      const def = this.rulesManager.getRuleDef(ruleId);
      if (!def) return undefined;
      return { name: def.name, incompleteName: def.incompleteName };
    });

    /** B8：条件上下文工厂必须先于 narrativeStateManager.loadFromAsset 注入——
     *  加载即触发 reactive 求值，晚注入会导致开机首轮全部 missing-ctx 判 false。 */
    const mkCondCtx = (): ConditionEvalContext => this.buildConditionEvalContext();
    this.flagStore.setConditionEvalContextFactory(mkCondCtx);
    this.questManager.setConditionEvalContextFactory(mkCondCtx);
    // repeatable 任务镜像：活计运行信息只读口 + 面板"追踪"点击→激活槽（同一真相源双向）
    this.questManager.setRunInfoProvider((gid) => this.narrativeStateManager.getRunPanelInfo(gid));
    // 章节导演接线：条件工厂（when/done 查任何图状态）+ 包 live/dormant 控制口
    this.narrativePackageDirector.setConditionEvalContextFactory(mkCondCtx);
    this.narrativePackageDirector.setControl({
      setNarrativePackageLive: (pkg, live) => this.narrativeStateManager.setNarrativePackageLive(pkg, live),
      isNarrativePackageLive: (pkg) => this.narrativeStateManager.isNarrativePackageLive(pkg),
    });
    // 「设为当前任务」若指向活计，QuestManager 经这条通道去激活活计图（走叙事队列）。
    // 面板不再自己持有激活口——当前任务槽是全局唯一的一个，只允许一个写入者。
    this.questManager.setActivateRunHandler(async (gid: string) => {
      await this.narrativeStateManager.activateNarrativeRun(gid);
    });
    this.zoneSystem.setConditionEvalContextFactory(mkCondCtx);
    this.bubbleChatterSystem.setConditionEvalContextFactory(mkCondCtx);
    this.playerIdleBehaviorSystem.setConditionEvalContextFactory(mkCondCtx);
    this.zoneSystem.setEntityGroupConditionReader(
      (groupId) => this.sceneManager.getCurrentSceneGroupConditions(groupId),
    );
    this.interactionSystem.setConditionEvalContextFactory(mkCondCtx);
    this.interactionSystem.setEntityBaseVisibilityReaders(
      (h) => this.sceneManager.getHotspotBaseEnabledForInteraction(h),
      (n) => this.sceneManager.getNpcBaseVisibleForInteraction(n),
    );
    this.interactionSystem.setEntityGroupConditionReader(
      (groupId) => this.sceneManager.getCurrentSceneGroupConditions(groupId),
    );
    // 身体动词：目标/zone 派发/受理闸一律由组装层给闭包，PlayerActionSystem 不持任何同层 system
    this.interactionSystem.setGraphEntryProbe((gid, entry) => this.graphHasEntry(gid, entry));
    // 点火（A3.8）：手上燃着能点火的东西 + 燃烧系统说这个可燃物此刻能点 ⇒ 这个热点能按 E 点火（优先于它自己的交互）；
    // 反过来手上的火把灭着 + 这个可燃物正在烧 ⇒ 按 E 从它身上引火（同一套表演，见 IgnitePerformer.modeFor）
    this.interactionSystem.setIgniteProbe((id) =>
      this.gameConfig.playerActs?.ignite?.enabled !== false
      && !this.ignitePerformer.busy
      && this.ignitePerformer.modeFor(id) !== null);
    // 区域级 E 交互（ZoneDef.onInteract）：优先级判定留在 InteractionSystem（目标级 → 区域级），
    // 这里只把 ZoneSystem 的两个只读/派发口以闭包递过去——两个同层 system 仍不互持引用。
    this.interactionSystem.setZoneInteractBinding({
      peek: () => this.zoneSystem.getInteractableZone(),
      dispatch: (zoneId) => this.zoneSystem.dispatchZoneInteract(zoneId),
    });
    this.playerActionSystem.setConfig(this.gameConfig.playerActs);
    this.playerActionSystem.setBinding({
      findVerbGraphTarget: (verb) => this.interactionSystem.findNearestVerbGraphTarget(verb),
      startGraphAtEntry: (target, entry) => {
        void this.graphDialogueManager.startDialogueGraph({
          graphId: target.graphId,
          entry,
          npcName: target.name,
          npcId: target.kind === 'npc' ? target.id : undefined,
        }).catch((e: unknown) => console.warn('动词开图失败', e));
      },
      findActSpot: (verb) => this.interactionSystem.findNearestActSpot(verb),
      dispatchZoneAct: (verb) => this.zoneSystem.dispatchPlayerAct(verb),
      canAcceptInput: () => this.stateController.currentState === GameState.Exploring,
      setActSpotPrompt: (hotspotId, keyLabel) => this.applyActSpotPrompt(hotspotId, keyLabel),
    });
    this.encounterManager.setConditionEvalContextFactory(mkCondCtx);
    this.mapUI.setConditionEvalContextFactory(mkCondCtx);
    this.archiveManager.setConditionEvalContextFactory(mkCondCtx);
    this.inventoryManager.setConditionEvalContextFactory(mkCondCtx);
    this.healthSystem.setTetherAllowed(() => !!this.gameConfig.health?.tetherCondition
      && evaluateConditionExpr(this.gameConfig.health.tetherCondition, mkCondCtx()));
    // 数值系统只消费防护来源，不反向依赖背包。背包先于 HealthSystem 恢复存档。
    this.healthSystem.setProtectionProvider(() => this.inventoryManager.getAllItems().flatMap((item) =>
      item.count > 0 && item.def?.healthProtection
        ? [{ ...item.def.healthProtection, id: `item:${item.id}` }] : []));
    this.listenEvent('item:acquired', () => this.healthSystem.refreshProtection());
    this.listenEvent('item:consumed', () => this.healthSystem.refreshProtection());
    const canUpdatePresentationSurvival = () => this.systemNotePauseDepth === 0 && !this.healthSystem.isDepleted()
      && [GameState.Exploring, GameState.Cutscene, GameState.ActionSequence, GameState.Dialogue].includes(this.stateController.currentState);
    const conditionsPass = (conditions?: ConditionExpr[]) => !conditions?.length
      || conditions.every((condition) => evaluateConditionExpr(condition, mkCondCtx()));
    this.fireProtectionSystem.configure(this.gameConfig.health?.fireProtection);
    this.fireProtectionSystem.connect({
      canUpdate: canUpdatePresentationSurvival,
      changed: (protectedByFire) => this.flagStore.set(FlagKeys.fireProtected, protectedByFire),
      playerPosition: () => ({ x: this.player.x, y: this.player.y }),
      sources: () => {
        const designatedProps = this.gameConfig.health?.fireProtection?.heldPropIds ?? [];
        const sources: ProtectionFireSource[] = this.heldPropSystem.statusOf('player')
          .filter((held) => designatedProps.includes(held.prop))
          .map((held) => ({ id: `held:${held.socket}:${held.prop}`, active: held.vitality > 0 && held.fuel > 0,
            burning: held.burning, x: this.player.x, y: this.player.y, radius: 0 }));
        for (const hotspot of this.sceneManager.getCurrentHotspots()) {
          const fire = hotspot.def.fireProtection;
          if (!fire) continue;
          sources.push({ id: `hotspot:${hotspot.def.id}`, x: hotspot.container.x, y: hotspot.container.y,
            radius: fire.radius, active: hotspot.active && this.sceneManager.getHotspotBaseEnabledForInteraction(hotspot)
              && conditionsPass(fire.conditions),
            burning: fire.requiresBurning === false || this.burnSystem.canRelightFrom(hotspot.def.id) });
        }
        return sources;
      },
    });
    this.healthThreatSystem.connect({
      canUpdate: canUpdatePresentationSurvival,
      isPresentation: () => this.stateController.currentState !== GameState.Exploring,
      isNight: () => !this.dayManager.daylightPhases.includes(this.dayManager.currentPhase),
      playerPosition: () => ({ x: this.player.x, y: this.player.y }),
      hasFireProtection: () => this.fireProtectionSystem.protected,
      playSound: (id, at, volume) => {
        const world = this.vfxSystem.sceneToWorld(at.x, at.y, 0);
        if (world) this.audioManager.playSfxAt(id, { x: world[0], y: world[1], z: world[2] }, { volume });
      },
      damage: (value) => { this.healthSystem.applyDamage(value); },
      setYinSources: (ids) => {
        this.yinThreatsVisible = ids.length > 0;
        // 已有作者请求时不重发显隐，尤其不能中途打断首次 debut 仪式。
        if (this.flagStore.get(FlagKeys.threeFiresVisible) !== true)
          this.hud?.setThreeFiresVisible(this.yinThreatsVisible, 'fade');
      },
      signal: (signal, sourceId) => {
        const scene = this.sceneManager.currentSceneData;
        const npc = scene?.npcs?.find((entity) => entity.healthThreat?.id === sourceId);
        const hotspot = scene?.hotspots?.find((entity) => entity.healthThreat?.id === sourceId);
        void this.narrativeStateManager.emitNarrativeSignal({ signal, sourceType: 'entity', sourceId,
          ...(npc ? { owner: { ownerType: 'npc', ownerId: npc.id } }
            : hotspot ? { owner: { ownerType: 'hotspot', ownerId: hotspot.id } } : {}) });
      },
    });
    this.listenEvent('scene:beforeUnload', () => {
      this.healthThreatSystem.clear();
      this.fireProtectionSystem.clear();
      this.sceneWind.clearGust();
      // 跟脚者本人跟着你走进下一张图（开关不清），但在途那一步的脚点属于上一张图，作废。
      this.followerFootsteps.onSceneChanged();
      // 演出态一律不跨场景：雷放到一半换场景，新场景不该接着亮 / 接着抖 / 接着压暗。
      // （压暗在 SceneLightingSystem 那边也会随场景重置，这里把角色侧那一半一起归位。）
      this.strikeLightRig.clear();
      this.strikeLightEpoch++;
      this.dynamicLightsByOwner.delete('strike');
      this.camera.clearShake();
      this.characterLighting.setEnvDim(1);
      // 演出把背景音压下去了、人却走出了这张场景：新场景该按新场景的响度来。
      this.audioManager.clearAudioDucks();
      /**
       * 脱手演出：兜底再打断一次。
       * 主路是状态旁听席上的 `SceneTransition`，但不是每条换场景都经过它
       * （过场内部的换场景沿用 Cutscene 锁，位面切换也自己走）。这一刀是幂等的：
       * 已经收过的会话再来一次是安静 no-op。
       */
      this.performanceSessions?.interruptAll('scene');
    });
    this.listenEvent('cutscene:end', () => this.sceneWind.clearGust());
    this.listenEvent('scene:ready', () => {
      this.healthSystem.enterScene(this.sceneManager.currentSceneData?.id ?? '');
      this.healthSystem.refreshProtection();
      const sources: HealthThreatSource[] = [];
      const scene = this.sceneManager.currentSceneData;
      for (const def of scene?.npcs ?? []) {
        const threat = def.healthThreat;
        if (!threat) continue;
        const entity = () => this.sceneManager.getNpcById(def.id);
        sources.push({ def: threat, position: () => { const n = entity(); return n ? { x: n.x, y: n.y } : null; },
          active: () => { const n = entity(); return !!n && this.sceneManager.getNpcBaseVisibleForInteraction(n)
            && conditionsPass(def.conditions)
            && (threat.affectsWhenHidden === true || n.container.visible) && conditionsPass(threat.conditions); } });
      }
      for (const def of scene?.hotspots ?? []) {
        const threat = def.healthThreat;
        if (!threat) continue;
        const entity = () => this.sceneManager.getCurrentHotspots().find((h) => h.def.id === def.id);
        sources.push({ def: threat, position: () => { const h = entity(); return h ? { x: h.container.x, y: h.container.y } : null; },
          active: () => { const h = entity(); return !!h && this.sceneManager.getHotspotBaseEnabledForInteraction(h)
            && conditionsPass(def.conditions)
            && !h.pickedUp && (threat.affectsWhenHidden === true || h.active) && conditionsPass(threat.conditions); } });
      }
      this.healthThreatSystem.setSources(sources);
      this.fireProtectionSystem.refresh();
    });
    this.graphDialogueManager.setConditionEvalContextFactory(mkCondCtx);
    this.documentRevealManager.setConditionEvalContextFactory(mkCondCtx);
    this.narrativeStateManager.setConditionEvalContextFactory(mkCondCtx);

    /**
     * 叙事状态一变就补刷实体的条件通道（2026-09-23）。
     *
     * `InteractionSystem.update` 只挂在 tick 的 Exploring 分支上，而叙事状态多半是在
     * 动作链 / 对话 / 过场里推进的：某个状态的 onEnter 里只要有一条 `waitMs`，整段就在
     * ActionSequence 态里跑完，条件刚变真的实体**直到回探索态才现身**——真机抓到过
     * 跑马梁「有人喊」那一拍：气泡已经在喊了，喊话的人还没出现（两张说明卡读完才冒出来）。
     * 与时刻推进那一处（refreshEntityVisibility）同一个补刀，只是触发源换成叙事状态。
     * 这里不选目标、不触发 autoTrigger（refreshVisibilityChannels 刻意不带那一段）。
     */
    this.listenEvent('narrative:stateChanged', () => this.interactionSystem.refreshVisibilityChannels());

    // 位面对账器接线须先于 narrativeStateManager.loadFromAsset——注册图时的 reactive
    // 迁移会立即发 narrative:stateChanged，晚接线会漏掉首轮点名（scene:ready 虽兜底，
    // 但装载期 zone 过滤已按激活位面取值）。
    this.planeReconciler.bindRuntime({
      narrative: {
        getGraphs: () => this.narrativeStateManager.getGraphs(),
        getActiveState: (graphId) => this.narrativeStateManager.getActiveState(graphId),
      },
      setPlayerMovementModifier: (fn) => this.player.setMovementModifier(fn),
      setPlaneInteractionPolicy: (fn) => {
        this.interactionSystem.setPlaneInteractionPolicy(fn);
        // 同一份策略同时喂给动词系统（allowedVerbs 槽）：被禁的姿态会当场复位
        this.playerActionSystem.setPlaneInteractionPolicy(fn);
      },
      refreshEntitiesForPlaneChange: () => {
        const sid = this.sceneManager.currentSceneData?.id;
        if (sid) this.sceneManager.refreshEntitiesForPlaneChange(sid);
      },
      refreshZonesForPlaneChange: () => {
        const sid = this.sceneManager.currentSceneData?.id;
        if (sid) this.sceneManager.refreshZonesForPlaneChange(sid);
      },
      setCameraZoom: (z) => this.camera.setZoom(z),
      restoreSceneCameraZoom: () => {
        // 对账器在"离开位面"时调，此刻激活位面已切走 → 基线即场景 zoom；用统一基线口保持一致。
        // 配了相机跟随透视的场景恢复到**此刻位置该有的** zoom，并把 zoom 交回连续通道。
        this.camera.setZoom(this.currentPerspectiveZoom());
        this.camera.releaseZoomOverride();
      },
      applyPlaneLightEnvOverride: (partial) => this.applyPlaneLightEnvOverride(partial),
      damagePlayer: (amount) => this.healthSystem.damage(amount),
      getGameState: () => this.stateController.currentState,
    });
    this.sceneManager.setActivePlaneGetter(() => ({
      id: this.planeReconciler.getActivePlaneId(),
      membership: this.planeReconciler.getActivePlaneMembership(),
    }));

    this.npcScheduleSystem.bindRuntime({
      getMinutesOfDay: () => this.dayManager.minutesOfDay,
      getCurrentSceneId: () => this.sceneManager.currentSceneData?.id ?? null,
      getCurrentSceneData: () => this.sceneManager.currentSceneData ?? null,
      getCurrentNpcs: () => [...this.sceneManager.getCurrentNpcs()],
      isExploring: () => this.stateController.currentState === GameState.Exploring,
      // 条件一律走唯一上下文工厂（律5）：日程条件因此能读 flag/quest/narrative/plane/timePhase 全套
      evalConditions: (conds) => {
        if (!conds || conds.length === 0) return true;
        const ctx = this.buildConditionEvalContext();
        return conds.every((c) => evaluateConditionExpr(c, ctx));
      },
      speak: (npc, text) => {
        // 日程自语与巡场碎嘴同性质，走 chatter 弱一档皮肤
        this.emoteBubbleManager.show(npc, this.resolveDisplayText(text), undefined, { variant: 'chatter' });
      },
      refreshEntityVisibility: () => {
        const sid = this.sceneManager.currentSceneData?.id;
        if (!sid) return;
        this.sceneManager.refreshForTimeChange(
          sid,
          this.stateController.currentState === GameState.Exploring,
        );
        // 派生基底那一半上面刷完了，条件那一半（成员条件 + 分组整体显影条件）由
        // InteractionSystem 持有。它的 update 只在探索态跑，而时刻多半是在过场/对话里推进的，
        // 不在这儿补一刀就会跨时段时半条街按新时辰走、另半条停在旧时辰。
        this.interactionSystem.refreshVisibilityChannels();
      },
    });
    this.sceneManager.setNpcSchedulePresenceGetter((def) =>
      this.npcScheduleSystem.isNpcPresentNow(def),
    );
    // 实体级时段归属（phases）：与日程正交，判定挂在同一批派生基底口上
    this.sceneManager.setCurrentPhaseGetter(() => this.dayManager.currentPhase);
    // 灯也按时段过滤（「灯就是实体」）——与实体归属同一个时刻来源
    this.sceneLighting.setPhaseGetter(() => this.dayManager.currentPhase);
    // NPC 未写 phases 时的缺省归属，由内容侧时段表的 daylight 标记派生（代码不认时段 id）
    this.sceneManager.setNpcDefaultPhasesGetter(() => this.dayManager.daylightPhases);

    // ---- 时段换装（2026-08-30）：背景/环境/烘焙随时段整套换 ----
    //
    // 走**整场景重载**而不是手搓局部替换：换装要同时动背景纹理、深度/碰撞、角色烘焙
    // 载荷、环境音四处，各自都有生命周期与在途保护（epoch）。分头替换等于把那四套
    // 保证各重写一遍，而重载把它们原样复用。时段推进是作者驱动的低频事件（advanceTime
    // 系列），且按 transition 语义**遮挡由作者给**，重载的代价可以接受。
    //
    // ⚠ 只在外观**真的会变**时才重载：两个时段配了同一张图、同一份环境时，
    //   为「时段名变了」白白重载一次是纯浪费（还会打断玩家）。
    this.eventBus.on('time:phaseChanged', (e) => {
      // ⚠ **只登记，不当场换**。`advanceTimeTo` 常常正是从对话/过场里发出的
      //（赌坊那一拍就是），当场 unloadScene 会把**正在播的那场演出连同自己**一起拆掉。
      // 真正的换装挂在 tick 的安全窗口（见 drainPendingPhaseSwap）。
      this.pendingPhaseSwap = true;
      // 作者声明的表现档要带到换装那一拍 —— 它决定遮不遮幕。事件对象在那时已经没了。
      this.pendingPhaseSwapTransition = (e as { transition?: TimeTransition })?.transition ?? 'timelapse';
    });

    // 文档揭示的显示层走自己那套（键 documentId），不与叠图动作的句柄表共用——
    // 作者不需要知道任何句柄，`hideOverlayImage` 也碰不到它。
    this.documentRevealManager.setLayerPresenter({
      show: (docId, path, x, y, w, order) =>
        this.cutsceneManager.showDocumentImage(docId, path, x, y, w, order),
      blend: (docId, from, to, x, y, w, dur, delay, order) =>
        this.cutsceneManager.blendDocumentImage(docId, from, to, x, y, w, dur, delay, order),
      hide: (docId) => this.cutsceneManager.hideDocumentImage(docId),
    });
    await this.documentRevealManager.loadDefinitions();
    try {
      const scenarioCat = await this.assetManager.loadJson<ScenarioCatalogFile>(TEXT_URLS.scenarios);
      this.scenarioStateManager.configureRuntime(this.flagStore, scenarioCat, this.eventBus);
    } catch {
      this.scenarioStateManager.configureRuntime(this.flagStore, null, this.eventBus);
    }
    await this.narrativeStateManager.loadFromAsset(this.assetManager);
    if (this.tearDownComplete) return;

    this.buildPerformanceSessions();

    registerActionHandlers(this.actionExecutor, {
      randomValue: () => this.runtimeRandom.next(),
      performanceSessions: this.performanceSessions,
      gameClock: this.gameClock,
      // `runActionsIf` 的判据。统一走中央工厂（律5 统一条件源）：手工缩水上下文缺
      // @scene/@owner/plane/timePhase 叶，同一条件在此入口与对话/zone/热点入口会得出不同结果。
      evaluateCondition: (expr) =>
        (expr === undefined || expr === null
          ? true
          : evaluateConditionExpr(expr, this.buildConditionEvalContext())),
      resolveScriptedSpeaker: (raw, scriptedNpcId) =>
        resolveScriptedSpeakerDisplay(raw, {
          strings: this.stringsProvider,
          flagStore: this.flagStore,
          sceneManager: this.sceneManager,
          graphDialogueNpcId: this.graphDialogueManager.getContextNpcId(),
          fallbackNpcId: scriptedNpcId ?? '',
        }),
      scriptedSpeakerDisplayFallback: (scriptedNpcId) =>
        this.scriptedSpeakerDisplayFallback(scriptedNpcId ?? ''),
      resolveScriptedLineExtras: (rawSpeaker, portraitRef, scriptedNpcId) =>
        this.resolveScriptedLineExtras(rawSpeaker, portraitRef, scriptedNpcId ?? ''),
      setEntityShadowBindings: (target, bindings) => {
        // target 的命中面与 showEmote 一致（player / NPC id / **裸**热区 id）——
        // 内部键给热区加了 `hotspot:` 前缀防与 npc.id 撞，这里补上。
        // 让作者写裸 id 是为了实体重构（改名/迁移）能扫到它，前缀形式会对重构隐形。
        let key = target;
        if (target !== 'player' && !this.sceneManager.getNpcById(target)) {
          const isHotspot = this.sceneManager.getCurrentHotspots()
            .some((h) => h.def.id === target);
          if (isHotspot) key = `hotspot:${target}`;
        }
        // 空数组 = 回到手调单影（删表项而不是存个空表，免得"配了但是空的"与"没配"
        // 在下游变成两种行为）
        if (bindings.length === 0) this.entityShadowBindings.delete(key);
        else this.entityShadowBindings.set(key, bindings);
      },
      vfx: {
        play: (opts) => this.vfxSystem.playVfx(opts) ?? null,
        stop: (id, opts) => this.vfxSystem.stopVfx(id, opts),
        setState: (id, state) => this.vfxSystem.setVfxState(id, state),
        emitField: (def, sceneX, sceneY, h) => {
          const w = this.vfxSystem.sceneToWorld(sceneX, sceneY, h);
          if (w) this.vfxSystem.emitField(def, w);
        },
        prepare: (ids) => this.vfxSystem.prepareEffects(ids),
      },
      ruleOfferRegistry: this.ruleOfferRegistry,
      inventoryManager: this.inventoryManager,
      rulesManager: this.rulesManager,
      questManager: this.questManager,
      encounterManager: this.encounterManager,
      audioManager: this.audioManager,
      dayManager: this.dayManager,
      npcScheduleSystem: this.npcScheduleSystem,
      archiveManager: this.archiveManager,
      clueManager: this.clueManager,
      systemNoteManager: this.systemNoteManager,
      setThreeFiresVisible: (visible, style) => this.applyThreeFiresVisible(visible, style),
      setSmellVisible: (visible, style) => this.applySmellVisible(visible, style),
      cutsceneManager: this.cutsceneManager,
      sceneManager: this.sceneManager,
      emoteBubbleManager: this.emoteBubbleManager,
      stateController: this.stateController,
      stringsProvider: this.stringsProvider,
      eventBus: this.eventBus,
      resolveActor: this.resolveActorFn,
      resolveEmoteTarget: (raw: string) => this.resolveEmoteTarget(raw),
      debugPanelLog: (msg) => this.debugPanelUI?.log(msg),
      pickupNotification: this.pickupNotification,
      inspectBox: this.inspectBox,
      shopUI: this.shopUI,
      applyPlayerAvatar: (path, sm, ps) => this.applyPlayerAvatarFromAction(path, sm, ps),
      resetPlayerAvatar: () => this.resetPlayerAvatarFromAction(),
      attachToSocket: (targetId, socket, images, opts) =>
        this.attachToSocketFromAction(targetId, socket, images, opts),
      detachFromSocket: (targetId, socket) => this.detachFromSocketFromAction(targetId, socket),
      setPropState: (targetId, socket, state, fadeMs, onlyIfBurning) =>
        this.heldPropSystem.setStateAwait(targetId, socket, state, fadeMs, onlyIfBurning),
      playPropVfx: (targetId, socket, effect, point) => this.heldPropSystem.playOneShot(targetId, socket, effect, point),
      lockPropState: (targetId, socket, lock) => this.heldPropSystem.setLock(targetId, socket, lock),
      setPropLevel: (propId, level) => this.heldPropSystem.setPropLevel(propId, level),
      igniteBurnable: (target, socket, pointId) => this.burnSystem.igniteBurnable(target, socket, pointId),
      extinguishBurnable: (target, socket) => this.burnSystem.extinguishBurnable(target, socket),
      resetBurnable: (target, socket) => this.burnSystem.resetBurnable(target, socket),
      fadeLight: (lightId, toScale, fadeMs) => this.heldPropSystem.fadeLight(lightId, toScale, fadeMs),
      screenFlash: (durationMs, color, alpha) => this.cutsceneManager.screenFlash(durationMs, color, alpha),
      cameraShake: (amplitude, durationMs, frequency) => this.camera.shake(amplitude, durationMs, frequency),
      setEnvDim: (scale) => this.applyEnvDim(scale),
      getEnvDim: () => this.sceneLighting.getEnvDim(),
      strikeThreat: (opts) => this.strikeThreat(opts),
      setSceneDepthFloorOffset: (v) => { this.sceneDepthSystem.floorOffset = v; },
      resetSceneDepthFloorOffset: () => {
        const cfg = this.sceneDepthSystem.currentConfig;
        this.sceneDepthSystem.floorOffset = cfg?.floor_offset ?? 0;
      },
      setCameraZoom: (z) => { this.camera.setZoom(z); },
      restoreSceneCameraZoom: () => {
        // 基线=位面相机档(激活时) ?? 场景 zoom：对话/演出收尾恢复到位面态该有的值，不盖掉位面档。
        // 配了相机跟随透视的场景再乘上此刻位置的透视倍数，并把 zoom 交回连续通道。
        this.camera.setZoom(this.currentPerspectiveZoom());
        this.camera.releaseZoomOverride();
      },
      fadingRestoreSceneCameraZoom: (durationMs) => {
        return this.fadingRestoreCameraZoom(durationMs);
      },
      setCameraFollowTarget: (targetId, snap) => {
        this.cameraFollowTargetId = targetId;
        this.cameraFollowRef = null;
        this.cameraFollowSnap = snap;
      },
      setCameraFollowRef: (ref, snap) => this.bindCameraFollowRef(ref, snap),
      clearCameraFollowTarget: () => {
        this.cameraFollowTargetId = null;
        this.cameraFollowRef = null;
      },
      snapCameraToActorIfFollowed: (entityId) => this.snapCameraToActorIfFollowed(entityId),
      stopNpcPatrol: (npcId) => {
        this.stopNpcPatrol(npcId);
      },
      startNpcPatrol: (npcId) => {
        this.startNpcPatrolForNpc(npcId);
      },
      // 轨迹：注入**能力**而不是系统实例（分层律 11）。装资产 / 投影 / 目标解析都在 Game 侧。
      playTrajectory: (trajectoryId, ref, opts) => this.playTrajectoryAsset(trajectoryId, ref, opts),
      resolvePositionRef: (raw) => this.resolvePositionRef(raw),
      stopTrajectory: (ref, opts) => {
        const t = this.resolveTrajectoryTarget(ref);
        return t ? this.trajectorySystem.stopFor(t.trajectoryKey, 'stopped', opts) : false;
      },
      showOverlayImage: (id, image, xPct, yPct, wPct, order, fill) =>
        this.cutsceneManager.showOverlayImage(id, image, xPct, yPct, wPct, order, fill),
      resolveOverlayImagePath: (img) => this.resolveOverlayImageIdToPath(img),
      resolveOverlayImageSfx: (img) => this.resolveOverlayImageSfxCue(img),
      hideOverlayImage: (id) => {
        this.cutsceneManager.hideOverlayImage(id);
      },
      blendOverlayImage: (id, fromPath, toPath, xPct, yPct, wPct, durationMs, delayMs, order) =>
        this.cutsceneManager.blendOverlayImage(id, fromPath, toPath, xPct, yPct, wPct, durationMs, delayMs, order),
      showBreathingOverlay: (id, breathing, xPct, yPct, wPct, order) =>
        this.breathingOverlaySystem.show(id, breathing, xPct, yPct, wPct, order),
      performBreathing: (id, act, wait) => this.breathingOverlaySystem.perform(id, act, wait),
      setBreathingParams: (id, params, durationMs) => { this.breathingOverlaySystem.setParams(id, params, durationMs); },

      // 画布（场景之外那张屏幕空间的面）：实体与顺序都经 CanvasStageSystem。
      // 叠图 / 文档揭示 仍走各自的动作（它们只是换了宿主），四类共用一个 order 空间。
      showCanvasEntity: (name, opts) => this.canvasStageSystem.showEntity(name, opts),
      hideCanvasEntity: (name) => { this.canvasStageSystem.hideEntity(name); },
      playCanvasEntityAnimation: (name, state, playback) => {
        this.canvasStageSystem.playEntityAnimation(name, state, playback);
      },
      setCanvasEntityTransform: (name, patch) => { this.canvasStageSystem.setEntityTransform(name, patch); },
      setCanvasOrder: (kind, name, order) => this.canvasStageSystem.setOrder(kind, name, order),
      playCanvasVfx: (name, opts) => this.canvasStageSystem.playVfx(name, opts),
      stopCanvasVfx: (name) => { this.canvasStageSystem.stopVfx(name); },
      clearCanvas: () => { this.canvasStageSystem.clearAll(); },
      startDialogueGraph: async (graphId, entry, npcId, ownerType, ownerId, dimBackground, origin) => {
        this.stateController.setState(GameState.Dialogue);
        try {
          let npcName = '';
          const npcIdTrim = npcId?.trim() || '';
          if (npcIdTrim) {
            const npc = this.sceneManager.getNpcById(npcIdTrim);
            if (npc) npcName = npc.def.name;
          }
          /**
           * owner 四档优先级（唯一判定源见 core/actionOrigin.ts，编辑器静态解算镜像同一套）：
           * 显式参数 > npcId > 动作来源实体（热区/zone/叙事图/任务/过场/上一张图） > 场景 onEnter 隐式 owner。
           */
          const ambient = this.ambientNarrativeOwner;
          const resolved = resolveDialogueOwner({
            paramOwnerType: ownerType,
            paramOwnerId: ownerId,
            paramNpcId: npcIdTrim,
            originOwnerType: origin?.ownerType,
            originOwnerId: origin?.ownerId,
            ambientOwnerType: ambient?.ownerType,
            ambientOwnerId: ambient?.ownerId,
          });
          await this.graphDialogueManager.startDialogueGraph({
            graphId,
            entry,
            npcName,
            npcId: npcIdTrim || undefined,
            ownerType: resolved.ownerType || undefined,
            ownerId: resolved.ownerId || undefined,
            dimBackground: dimBackground === true,
          });
          /** R6：图同步完结但 deferred 链式接续图正在启动时（hasPendingChainContinuation）
           *  会话未终结，不得提前恢复 Exploring——状态恢复交给最终 dialogue:end / EventBridge */
          if (
            !this.graphDialogueManager.isActive &&
            !this.graphDialogueManager.hasPendingChainContinuation &&
            // 图末尾的动作已把状态切走（开铺子 / 小游戏 / 切场景）：收尾归那一边，同 EventBridge 的 dialogue:end
            this.stateController.currentState === GameState.Dialogue
          ) {
            this.stateController.setState(GameState.Exploring);
          }
        } catch (e) {
          console.warn('Game: startDialogueGraph failed', e);
          if (this.stateController.currentState === GameState.Dialogue) this.stateController.setState(GameState.Exploring);
        }
      },
      playScriptedDialogue: (lines) => {
        /** P3 协议死锁兜底：空 lines 时 DialogueManager 不发任何事件，挂起等待即永久悬死 */
        if (!lines.length) {
          console.warn('Game: playScriptedDialogue 收到空 lines，跳过');
          return Promise.resolve();
        }
        /** 嵌套判定在 start 前采样：图对话活跃时本段脚本台词属嵌套段（R5，见 DialogueEndPayload） */
        const nestedInGraph = this.graphDialogueManager.isActive;
        this.stateController.setState(GameState.Dialogue);
        return new Promise<void>((resolve) => {
          const onEnd = (p?: DialogueEndPayload) => {
            /** R5：只认脚本台词自身的结束；嵌套于图对话时，图的 dialogue:end 不得提前解锁本动作 */
            if (p?.source !== 'scripted') return;
            this.eventBus.off('dialogue:end', onEnd);
            resolve();
          };
          this.eventBus.on('dialogue:end', onEnd);
          this.dialogueManager.startScriptedDialogue(lines, nestedInGraph);
        });
      },
      waitClickContinue: (hintOverride) => {
        const label = hintOverride?.trim()
          ? hintOverride.trim()
          : this.stringsProvider.get('actions', 'clickToContinue');
        // 屏底若正被对白框占着（过场 showDialogue / 常规对话框），提示语要让开那一条，
        // 否则会横穿它的底部木框。两种框同尺（BOX_MARGIN 20 + BOX_HEIGHT 230）。
        const boxOccupied = this.cutsceneRenderer.hasDialogueBox() || this.dialogueUI.isVisible;
        return waitClickContinueWithHint(
          this.renderer, this.inputManager, label,
          boxOccupied ? DIALOGUE_BOX_BOTTOM_BAND : 0,
        );
      },
      scenarioStateManager: this.scenarioStateManager,
      narrativeStateManager: this.narrativeStateManager,
      documentRevealManager: this.documentRevealManager,
      spawnCutsceneActor: (id, name, x, y) => {
        this.cutsceneManager.spawnTempActor(id, name, x, y);
      },
      removeCutsceneActor: (id) => {
        this.cutsceneManager.removeTempActor(id);
      },
      setSceneEntityField: (sceneId, kind, entityId, fieldName, value) =>
        this.setSceneEntityFieldFromAction(sceneId, kind, entityId, fieldName, value),
      setHotspotDisplayImage: (sceneId, hotspotId, imagePath, worldWidth, worldHeight, facing) =>
        this.setHotspotDisplayImageFromAction(
          sceneId,
          hotspotId,
          imagePath,
          worldWidth,
          worldHeight,
          facing,
        ),
      tempSetHotspotDisplayFacing: (sceneId, hotspotId, facing) =>
        this.tempSetHotspotDisplayFacingFromAction(sceneId, hotspotId, facing),
      resolveDisplayText: (raw) => this.resolveDisplayText(raw),
      resolveRichText: (raw) => this.resolveRichText(raw),
      chooseAction: async (prompt, options, allowCancel, layout) => {
        // 第一人称档要 HUD 收起屏底那几样（三把火与气味照留）；与对白框走同一个事件
        const firstPerson = layout === 'firstPerson';
        if (firstPerson) this.eventBus.emit('ui:firstPerson', { source: 'actionChoice', active: true });
        try {
          return await this.actionChoiceUI.choose(prompt, options, allowCancel, layout);
        } finally {
          if (firstPerson) this.eventBus.emit('ui:firstPerson', { source: 'actionChoice', active: false });
        }
      },
      resolveRichTextForPlayScripted: (raw, sid) =>
        this.resolveRichTextForPlayScripted(raw, sid),
      waterMinigameManager: this.waterMinigameManager,
      sugarWheelMinigameManager: this.sugarWheelMinigameManager,
      paperCraftMinigameManager: this.paperCraftMinigameManager,
      objectExamineManager: this.objectExamineManager,
      pressureHoldManager: this.pressureHoldManager,
      signalCueManager: this.signalCueManager,
      bubbleChatterSystem: this.bubbleChatterSystem,
      healthSystem: this.healthSystem,
      retrySystem: this.retrySystem,
      sceneWind: this.sceneWind,
      smellSystem: this.smellSystem,
      followerFootsteps: this.followerFootsteps,
      planeReconciler: this.planeReconciler,
      voiceChannel: this.voiceChannel,
    });

    /** D1：DEV 下对照 actionParamManifest 与 executor 实际注册互查，防三方参数表再漂移 */
    if (import.meta.env.DEV) {
      for (const msg of auditActionRegistrationsAgainstManifest(this.actionExecutor)) {
        console.warn(`[actionParamManifest 漂移] ${msg}`);
      }
    }

    this.pressureHoldManager.bindRuntime({
      // 小游戏/压力条面板的文案也是策划写的内容，一样吃语义色板（面板文字已走 createStyledText）
      resolveDisplayText: (s) => this.resolveRichText(s),
      runSegment: async (req) => {
        const prevState = this.stateController.currentState;
        this.stateController.setState(GameState.UIOverlay);
        try {
          return await this.pressureHoldUI.runSegment(req);
        } finally {
          if (this.stateController.currentState === GameState.UIOverlay) {
            this.stateController.setState(prevState);
          }
        }
      },
    });

    this.waterMinigameManager.bindRuntime({
      renderer: this.renderer,
      inputManager: this.inputManager,
      stateController: this.stateController,
      actionExecutor: this.actionExecutor,
      dayManager: this.dayManager,
      // 小游戏/压力条面板的文案也是策划写的内容，一样吃语义色板（面板文字已走 createStyledText）
      resolveDisplayText: (s) => this.resolveRichText(s),
    });
    await this.waterMinigameManager.loadIndex();

    this.sugarWheelMinigameManager.bindRuntime({
      renderer: this.renderer,
      inputManager: this.inputManager,
      stateController: this.stateController,
      actionExecutor: this.actionExecutor,
      playSfx: (id) => this.audioManager.playSfx(id),
      // 小游戏/压力条面板的文案也是策划写的内容，一样吃语义色板（面板文字已走 createStyledText）
      resolveDisplayText: (s) => this.resolveRichText(s),
      debugPanelLog: (msg) => this.debugPanelUI?.log(msg),
      evaluateBeforeChargeCondition: (expr) => {
        if (expr === undefined || expr === null) return true;
        // 统一走中央工厂（律5 统一条件源）：手工缩水上下文缺 @scene/@owner/plane 叶子，
        // 同一条件在此入口与对话/zone/热点入口会得出不同结果。
        return evaluateConditionExpr(expr, this.buildConditionEvalContext());
      },
    });
    await this.sugarWheelMinigameManager.loadIndex();

    this.paperCraftMinigameManager.bindRuntime({
      renderer: this.renderer,
      inputManager: this.inputManager,
      stateController: this.stateController,
      actionExecutor: this.actionExecutor,
      // 小游戏/压力条面板的文案也是策划写的内容，一样吃语义色板（面板文字已走 createStyledText）
      resolveDisplayText: (s) => this.resolveRichText(s),
    });
    await this.paperCraftMinigameManager.loadIndex();

    this.objectExamineManager.bindRuntime({
      renderer: this.renderer,
      inputManager: this.inputManager,
      stateController: this.stateController,
      actionExecutor: this.actionExecutor,
      // 小游戏/压力条面板的文案也是策划写的内容，一样吃语义色板（面板文字已走 createStyledText）
      resolveDisplayText: (s) => this.resolveRichText(s),
      getString: (ns, key) => this.stringsProvider.get(ns, key),
      audio: {
        playSfx: (id, volume) => this.audioManager.playSfx(id, volume),
        addAmbient: (id) => this.audioManager.addAmbient(id),
        removeAmbient: (id) => this.audioManager.removeAmbient(id),
      },
      smell: {
        setSmell: (scent, intensity, dir, flicker) =>
          this.smellSystem.setSmell(scent, intensity, dir, flicker),
        clearSmell: () => this.smellSystem.clearSmell(),
      },
      inventory: {
        hasItem: (itemId) => this.inventoryManager.hasItem(itemId),
        listBagItems: () =>
          this.inventoryManager.getAllItems().map((it) => ({
            id: it.id,
            name: it.def?.name ?? it.id,
            count: it.count,
          })),
      },
    });
    await this.objectExamineManager.loadIndex();
    if (this.tearDownComplete) return;

    this.interactionCoordinator = new InteractionCoordinator(this.eventBus, {
      stateController: this.stateController,
      sceneManager: this.sceneManager,
      dialogueManager: this.dialogueManager,
      graphDialogueManager: this.graphDialogueManager,
      actionExecutor: this.actionExecutor,
      inspectBox: this.inspectBox,
      eventBus: this.eventBus,
      getPlayerWorldPos: () => ({ x: this.player.x, y: this.player.y }),
      getCameraZoom: () => this.camera.getZoom(),
      preparePlayerForNpcDialogue: (npc) => {
        this.player.setFacing(npc.x - this.player.x, npc.y - this.player.y);
        this.player.playAnimation(ANIM_IDLE);
      },
      fadingDialogueCameraZoom: (targetZoom, durationMs) => {
        return this.cutsceneManager.fadingCameraZoom(targetZoom, durationMs);
      },
      fadingRestoreSceneCameraZoom: (durationMs) => {
        // NPC 对话收尾的 550ms 渐变必须以"位面基线"为目标——按场景 zoom 渐变会把
        // 对账器在 Dialogue→Exploring 边沿重贴的位面相机档静默盖掉。
        return this.fadingRestoreCameraZoom(durationMs);
      },
    });
    this.interactionCoordinator.init();

    this.listenEvent('archive:firstView', (p: { actions: ActionDef[] }) => {
      void (async () => {
        try {
          await this.actionExecutor.executeBatchAwait(p.actions);
        } catch (e) {
          console.warn('Game: archive:firstView actions failed', e);
        }
      })();
    });

    // 切场/加载 = 独立状态 SceneTransition（2026-08-18 制作人拍板：加载中绝不能是
    // Exploring——移动/交互/嗅探等探索输入在遮罩下全活着，乱按有实害）。
    // 只从 Exploring 进：过场/对话驱动的跨场景切换由各自状态锁住，这里不抢；
    // 揭幕即还权（onEnter 开场演出从 Exploring 正常起跳）；switch job 的必达收尾事件
    // 兜双失败路径——绝不把 SceneTransition 留成永久状态（输入锁死是审批红线）。
    this.listenEvent('scene:transition', () => {
      if (this.stateController.currentState === GameState.Exploring) {
        this.stateController.setState(GameState.SceneTransition);
      }
    });
    const endSceneTransition = (): void => {
      if (this.stateController.currentState === GameState.SceneTransition) {
        this.stateController.setState(GameState.Exploring);
      }
    };
    this.listenEvent('scene:revealed', endSceneTransition);
    this.listenEvent('scene:transitionEnd', endSceneTransition);

    // K7 线索采集动作批（与 archive:firstView 同一范式）：采集=内容事件，
    // collectActions 经统一执行器跑——解锁文书/推 flag/起对话都行，入册只是默认呈现之一。
    this.listenEvent('clue:collectActions', (p: { id: string; actions: ActionDef[] }) => {
      void (async () => {
        try {
          await this.actionExecutor.executeBatchAwait(p.actions);
        } catch (e) {
          console.warn(`Game: clue:collectActions(${p.id}) failed`, e);
        }
      })();
    });

    this.eventBridge = new EventBridge(this.eventBus, {
      dialogueManager: this.dialogueManager,
      graphDialogueManager: this.graphDialogueManager,
      encounterManager: this.encounterManager,
      stateController: this.stateController,
      actionExecutor: this.actionExecutor,
      mapUI: this.mapUI,
      menuUI: this.menuUI,
      inspectBox: this.inspectBox,
      guardMapTravel: () => this.guardMapTravel(),
      consumeItem: (itemId, count) => this.inventoryManager.removeItem(itemId, count),
    });
    this.eventBridge.init();

    this.setupSceneReadyHandler();

    this.depthDebugVisualizer = new DepthDebugVisualizer(
      this.sceneDepthSystem,
      this.camera,
      this.renderer,
      this.assetManager,
      (msg) => this.logDepthDiag(msg),
    );

    /**
     * 运行时编辑模式（在真实画面里摆灯）。与 F2 同门控、同一份 `sceneLighting.params`、
     * 同一条存回通道——它只多提供"画面上直接拖"这一种输入方式。
     *
     * 隔离靠三样：DEV 门控（代码）、冻主 tick 且不碰 sceneMemory（状态）、
     * 退出时从磁盘重载场景（数据）。详见 `src/authoring/AuthoringMode.ts`。
     */
    if (import.meta.env.DEV) {
      this.authoringMode = new AuthoringMode({
        renderer: this.renderer,
        camera: this.camera,
        setFrozen: (frozen) => this.setLogicFrozen('authoring', frozen),
        getSceneId: () => this.sceneManager.currentSceneData?.id ?? null,
        reloadScene: (id) => this.reloadScene(id),
        getLightSpaceGeometry: () => this.buildLightSpaceGeometry(),
        getParams: () => this.sceneLighting.params,
        applyParams: (part) => {
          const cur = this.sceneLighting.params;
          if (!cur) return;
          this.applySceneLightingParams({ ...cur, ...part });
        },
        // 主 tick 冻着 ⇒ tick 尾巴上的这两句不会跑。不自己驱动的话拖灯毫无反应
        // （光照缓存不重算）、影子也停在旧方向上。
        pumpFrame: () => {
          this.sceneLighting.update(this.renderer.app.renderer);
          this.updateEntityShadows();
        },
        refreshDebugPanel: () => this.debugPanelUI?.refresh(),
        getSyncStatus: () => this.lightingSync?.statusLine() ?? '',
        onSceneChanged: (cb) => {
          this.eventBus.on('scene:enter', cb);
          return () => this.eventBus.off('scene:enter', cb);
        },
        log: (m) => this.debugPanelUI?.log(m),
      });
      /**
       * 光照的**双向实时同步**：游戏这边（F3 摆灯 / F2 滑条）与桌面编辑器场景页的灯表
       * 改的是同一份 `lighting`，任一边动了另一边就跟上，不用按按钮。
       *
       * 走 dev server 的同步槽而不是编辑器的 WebEngine 桥——游戏开在外部浏览器时
       * 桥是断的，而那正是最常见的用法。
       */
      this.lightingSync = new RuntimeLightingSync({
        getSceneId: () => this.sceneManager.currentSceneData?.id ?? null,
        getParams: () => this.sceneLighting.params,
        applyParams: (def) => this.applySceneLightingParams(def),
        // 拖灯中 / 独奏中只发不收：收会把手上的动作或视图当场冲掉
        isBusy: () => (this.authoringMode?.isDragging ?? false)
          || (this.lightingSyncHooks?.isSoloActive() ?? false),
        exportFixup: (def) => this.lightingSyncHooks?.exportFixup(def) ?? def,
        // 选中态过同步：编辑器选哪盏，画面就高亮哪盏，反之亦然
        getSelectedId: () => this.lightingSyncHooks?.getSelectedId() ?? null,
        setSelectedId: (id) => this.lightingSyncHooks?.setSelectedId(id),
        // 时段一起发：非空 = 这份 lighting 是「基底 ⊕ 该时段覆盖」的合并结果，
        // 编辑器据此拒绝把它写回场景顶层（否则夜的值会污染白天基底）。
        getPhase: () => this.dayManager.currentPhase,
        log: (m) => this.debugPanelUI?.log(m),
      }, `game:${this.runtimeBootId}`);
      this.lightingSync.start();

      /**
       * 声学的实时联动：工作台（`tools/acoustic_workbench`）是唯一作者面，
       * 这里只是预览器——工作台每动一下下一拍就重算 IR，按试听键这里播干声；
       * 反向把场景 / 听者 / 抽头 / 耗时回传给工作台画在 3D 里。同样走 dev server 的槽。
       */
      this.acousticsSync = new RuntimeAcousticsSync({
        getSceneId: () => this.sceneManager.currentSceneData?.id ?? null,
        getBoundSpaceId: () => this.acousticSpaceId,
        getActiveSpaceId: () => this.audioManager.getAcousticSpaceId(),
        applyDef: (spaceId, def) => {
          this.audioManager.applyAcousticSpaceDef(spaceId, def);
          // 听者立刻按新空间重算一次：工作台改了距离缩放，阈值也跟着变了
          this.updateAcousticListener(true);
        },
        playProbe: (sfxId, at, onStarted) => {
          if (!this.audioManager.isAudioUnlocked()) return false;
          // 试听也是有位置的声源：工作台给了发声点就从那里播，没给就是听者自己喊
          return this.audioManager.playSfxAt(sfxId, at ?? null, { onStart: onStarted }) !== null;
        },
        getListenerMode: () => this.acousticListenerLast?.mode ?? 'player',
        getListener: () => this.acousticListenerLast,
        getOutputPeakDb: () => this.audioManager.getRecentOutputPeakDb(),
        getTaps: () => this.audioManager.getAcousticTaps() as AcousticTap[],
        getPerf: () => ({
          costMs: this.audioManager.getAcousticBuildCostMs(),
          thresholdM: this.audioManager.getAcousticMoveThresholdM(),
        }),
        isAudioUnlocked: () => this.audioManager.isAudioUnlocked(),
        hasPendingSpace: () => this.audioManager.hasPendingAcoustic(),
        // 多开页签时工作台只指挥这一页（命令队列的 targetBootId），并据此判断这页是不是免手势的预览窗
        getBootId: () => this.runtimeBootId,
        isAutoplayAllowed: () => this.audioManager.isAudioAutoUnlocked(),
        log: (m) => this.debugPanelUI?.log(m),
      }, `game:${this.runtimeBootId}`);
      this.acousticsSync.start();

      /**
       * 粒子 / 群体的实时联动：粒子工作台（`tools/vfx_workbench`）是效果资产唯一的作者面，
       * 这里只是预览器——工作台改一个参数下一拍就用工作态定义重建引用它的实例，按「发一个刺激」
       * 就在那个画面点发一个场；反向把场景 / 实例状态 / stats / 玩家脚点回传给工作台画在 3D 里。
       * 同样走 dev server 的两个单向槽（`vite.config.ts` 的 `runtimeVfxApi`）。
       */
      this.vfxSync = new RuntimeVfxSync({
        getSceneId: () => this.sceneManager.currentSceneData?.id ?? null,
        applyPreview: (effectId, def) => this.vfxSystem.applyPreviewEffect(effectId, def),
        clearPreview: (effectId) => this.vfxSystem.applyPreviewEffect(effectId, null),
        // 工作台给的是画面点 + 离地高（它那边不知道本场景的基与尺）；解成 M-world 的是 VfxSystem
        emitField: (def, at) => {
          const w = this.vfxSystem.sceneToWorld(at.x, at.y, at.h ?? 0);
          if (!w) return false;
          this.vfxSystem.emitField(def, w);
          return true;
        },
        applyPlacements: (library) => this.vfxSystem.applyPreviewPlacementLibrary(library),
        // 走正常的时段推进（'cut'）：外观真变了才换装重载，布置表跟着外观键换
        requestTimePhase: (timePhase) => {
          if (!this.dayManager.phaseList.some((p) => p.id === timePhase)) return false;
          // 已经是那套外观就不推进：工作台要的是外观不是时刻，往回的时段只能跨午夜推（整整一天、天数加一、延迟事件触发）
          const cur = this.dayManager.currentPhase;
          if (!phaseRequestNeedsAdvance(
            this.sceneManager.appearancePhaseFor(cur), this.sceneManager.appearancePhaseFor(timePhase),
          )) {
            this.debugPanelUI?.log(`[粒子] 游戏已经是「${timePhase}」那套外观（此刻时段「${cur}」），不推进`);
            return true;
          }
          void this.dayManager.advanceTimeTo(timePhase, 'cut');
          return true;
        },
        getStatus: (effectId) => {
          const snap = this.vfxSystem.debugSnapshot();
          const pc = this.player ? { x: this.player.contactX, y: this.player.contactY } : null;
          const st = this.vfxSystem.stats;
          return {
            sceneId: this.sceneManager.currentSceneData?.id ?? null,
            instances: snap.filter((x) => x.effect === effectId)
              .map((x) => ({ id: x.id, state: x.state, live: x.live, eligible: x.eligible })),
            allInstances: snap.length,
            // simMs 取整到 0.1：不然每一拍都算「内容变了」，状态槽被写爆
            stats: { ...st, simMs: Math.round(st.simMs * 10) / 10 },
            playerScene: pc,
            playerWorld: pc ? this.vfxSystem.sceneToWorld(pc.x, pc.y, 0) : null,
            // 真 3D 还是平面近似：与 VfxSystem 的 hasFieldGeometry 同一条判据
            spaceKind: this.vfxSystem.currentSpace?.kind ?? 'planar',
            timePhase: this.dayManager.currentPhase,
            appearancePhase: this.sceneManager.appearancePhaseFor(this.dayManager.currentPhase),
            placementsApplied: this.vfxSystem.currentPlacement,
            bootId: this.runtimeBootId,
          };
        },
        log: (m) => this.debugPanelUI?.log(m),
      }, `game:${this.runtimeBootId}`);
      this.vfxSync.start();
      /**
       * 燃烧的实时联动：燃烧工作台（`tools/burn_workbench`）是可燃物模板唯一的作者面，这里只是预览器——
       * 工作台推来的模板工作态（存没存都算）顶替盘上那份、用到它的实例按它重建（场景实体重画、手上的重挂、纸钱重建）；
       * 「在游戏里点着 / 熄灭 / 复原」直接对实例做。走 dev server 的两个槽（`src/dev/runtimeBurnApiPlugin.ts`）。
       */
      this.burnSync = new RuntimeBurnSync({
        applyPreview: (burnables) => this.applyBurnTemplatePreview(burnables),
        probe: (action, target, socket, point) => (action === 'ignite'
          ? this.burnSystem.igniteBurnable(target, socket, point)
          : action === 'extinguish' ? this.burnSystem.extinguishBurnable(target, socket) : this.burnSystem.resetBurnable(target, socket)),
        getSceneId: () => this.sceneManager.currentSceneData?.id ?? null,
        // 与点火表演判站位同一条（场景边界 + 游戏自己的 isCollision）
        walkable: (x, y) => {
          const sd = this.sceneManager.currentSceneData;
          if (sd && (x < 0 || y < 0 || x > sd.worldWidth || y > sd.worldHeight)) return false;
          return !this.sceneDepthSystem.isCollision(x, y);
        },
        getStatus: () => {
          const st = this.burnSystem.debugStats;
          const sid = this.sceneManager.currentSceneData?.id ?? null;
          return {
            bootId: this.runtimeBootId,
            sceneId: sid,
            items: this.burnSystem.debugSnapshot().filter((x) => x.kind === 'held' || x.sceneId === sid)
              .map((x) => ({
                kind: x.kind, ...(x.sceneId ? { sceneId: x.sceneId } : {}), target: x.target, ...(x.socket ? { socket: x.socket } : {}),
                template: x.template, state: x.state, events: x.events, ready: x.ready,
              })),
            // simMs / clock 取整：不然每一拍都算「内容变了」，状态槽被写爆
            stats: { ...st, simMs: Math.round(st.simMs * 10) / 10, clock: Math.round(st.clock) },
          };
        },
        log: (m) => this.debugPanelUI?.log(m),
      }, `game:${this.runtimeBootId}`);
      this.burnSync.start();
      /**
       * 呼吸图的实时联动:呼吸工作台(`tools/breathing_workbench`)是呼吸图资产唯一的作者面,这里只是预览器——
       * 工作台推来的工作态(存没存都算)顶替盘上那份,正在显示的同一张图立刻换上新参数;
       * 「在游戏里显示 / 收起 / 从头来 / 渐弱 / 猛吸」直接对实例做。走 dev server 的两个槽(`src/dev/runtimeBreathingApiPlugin.ts`)。
       */
      this.breathingSync = new RuntimeBreathingSync({
        applyPreview: (docs) => this.applyBreathingPreview(docs),
        probe: (action, target) => this.breathingOverlaySystem.probe(action, target),
        getStatus: () => ({
          bootId: this.runtimeBootId,
          sceneId: this.sceneManager.currentSceneData?.id ?? null,
          instances: this.breathingOverlaySystem.debugSnapshot(),
        }),
        log: (m) => this.debugPanelUI?.log(m),
      }, `game:${this.runtimeBootId}`);
      this.breathingSync.start();
      /**
       * 草木拆层的实时联动：草木工作台「推给游戏」（预览，资源不动）/「导出到游戏」（写进资源）烘完往槽里写一行，
       * 游戏原地把拆层换掉——不切场景、玩家不动。推的是"那几张 PNG 变了",所以重装时 URL 带 `?v=rev`
       * 绕开按 URL 的纹理缓存；预览从 dev server 的预览口装，见 `buildSway`。
       */
      this.swaySync = new RuntimeSwaySync({
        currentSceneId: () => this.swayReadySceneId,
        reload: (bust) => this.reloadSwayInPlace(bust),
        log: (m) => this.debugPanelUI?.log(m),
      });
      this.swaySync.start();
      this.listenEvent('scene:ready', () => { this.swayReadySceneId = this.sceneManager.currentSceneData?.id ?? null; });
      /**
       * 地形的实时联动：地形工作台「推给游戏」（预览，资源不动）/「导出到游戏」（写进资源）合成完往槽里写一行，
       * 游戏原地把碰撞 + 行走面换掉——不切场景、玩家不动。与草木同一套形状；另答工作台的运行时对齐探测
       * （用**这里的** `isCollision` 判一批画面点，工作台据此说「运行时对齐 ✓」——真判据，不是页面里抄公式）。
       */
      this.terrainSync = new RuntimeTerrainSync({
        currentSceneId: () => this.swayReadySceneId,
        reload: (bust) => this.reloadTerrainInPlace(bust),
        probe: (pts) => this.probeTerrainCollision(pts),
        log: (m) => this.debugPanelUI?.log(m),
      });
      this.terrainSync.start();

      this.unsubAuthoringHotkey = this.inputManager.subscribeKeyDown((e) => {
        // F3 进/出。**刻意不走 registerPanel**：它不是面板——退出要问存盘、要重载场景，
        // 塞进面板的 open/close 语义里会把那些副作用藏起来。
        if (e.code === 'F3') this.authoringMode?.toggle();
      });
    }

    /** T1：调试工具与 F2 面板注册统一按 import.meta.env.DEV 门控（判据与
     *  TouchMobileControls 的「调试」chip 一致），生产玩家无任何调试入口。 */
    if (import.meta.env.DEV) this.debugTools = new DebugTools({
      renderer: this.renderer,
      assetManager: this.assetManager,
      getPropPresets: () => this.propPresetRegistry,
      heldProp: {
        attach: (t, s, p, st) => this.heldPropSystem.attach(t, s, p, st),
        setState: (t, s, st, ms) => this.heldPropSystem.setState(t, s, st, ms),
        detach: (t, s) => this.heldPropSystem.detach(t, s),
        snapshot: () => this.heldPropSystem.debugSnapshot(),
        getFlickerPushHz: () => this.heldPropSystem.flickerPushHz,
        setFlickerPushHz: (hz) => this.heldPropSystem.setFlickerPushHz(hz),
        flickerPushHzChoices: FLICKER_PUSH_HZ_CHOICES,
      },
      camera: this.camera,
      eventBus: this.eventBus,
      player: this.player,
      inventoryManager: this.inventoryManager,
      debugPanelUI: this.debugPanelUI,
      depthDebugVisualizer: this.depthDebugVisualizer,
      getCurrentSceneId: () => this.sceneManager.currentSceneData?.id,
      fallbackScene: this.gameConfig.fallbackScene,
      reloadScene: (id) => this.reloadScene(id),
      isExploring: () => this.stateController.currentState === GameState.Exploring,
      getDebugSceneWorldSize: () => {
        const s = this.sceneManager.currentSceneData;
        if (!s) return undefined;
        return { width: s.worldWidth, height: s.worldHeight };
      },
      applyDebugSceneWorldSize: (w, h) => this.applyDebugSceneWorldSize(w, h),
      isDevMode: () => this.isDevMode,
      getNarrativeDebugStatus: () => this.getNarrativeDebugStatus(),
      setNarrativeDebugEnabled: (on, port) => {
        if (on) this.enableNarrativeDebugBridge({ port, persist: true });
        else this.disableNarrativeDebugBridge({ persist: true });
      },
      getFrustumCulling: () => this.frustumCullingEnabled,
      toggleFrustumCulling: () => { this.frustumCullingEnabled = !this.frustumCullingEnabled; },
      getAuthoringMarkersVisible: () => this.sceneManager.getAuthoringMarkersVisible(),
      setAuthoringMarkersVisible: (v) => this.sceneManager.setAuthoringMarkersVisible(v),
      // F2「光影」页的编辑模式入口（进/出、可用性、与画布互选）
      authoring: {
        isActive: () => this.authoringMode?.isActive ?? false,
        availability: () => this.authoringMode?.availability()
          ?? { ok: false, reason: '编辑模式未装配' },
        toggle: () => this.authoringMode?.toggle(),
        selectedId: () => this.authoringMode?.selectedLightId ?? null,
        select: (id) => this.authoringMode?.selectLight(id),
      },
      goToDevScene: () => {
        void this.devLoadScene('dev_room');
      },
      getEntityPixelDensityMatchConfig: () => this.gameConfig.entityPixelDensityMatch === true,
      getEntityPixelDensityMatchEffective: () => this.getEntityPixelDensityMatchEffective(),
      getEntityPixelDensityMatchDebugOverride: () => this.entityPixelDensityMatchDebugOverride,
      cycleEntityPixelDensityMatchDebugOverride: () => {
        const cur = this.entityPixelDensityMatchDebugOverride;
        this.entityPixelDensityMatchDebugOverride = cur === null ? true : cur === true ? false : null;
        this.syncEntityPixelDensityMatch();
      },
      getEntityPixelDensityMatchBlurScaleFromConfig: () => this.getEntityPixelDensityMatchBlurScaleFromConfig(),
      getEntityPixelDensityMatchBlurScaleEffective: () => this.getEntityPixelDensityMatchBlurScale(),
      getEntityPixelDensityMatchBlurScaleDebug: () => this.entityPixelDensityMatchBlurScaleDebug,
      nudgeEntityPixelDensityMatchBlurScaleDebug: (delta: number) => {
        this.nudgeEntityPixelDensityMatchBlurScaleDebug(delta);
      },
      clearEntityPixelDensityMatchBlurScaleDebug: () => {
        this.clearEntityPixelDensityMatchBlurScaleDebug();
      },
      getNarrativeDebugSnapshot: () => this.buildRuntimeDebugSnapshot('debug-panel'),
      getScenarioDebugPanelRows: (): ScenarioDebugPanelRow[] => this.listScenarioDebugPanelRows(),
      scenarioDebugActivate: (scenarioId) => {
        const id = scenarioId.trim();
        if (!id) return;
        try {
          this.scenarioStateManager.activateScenarioLine(id);
          this.debugPanelUI.log(`[scenario] activateScenarioLine("${id}") 已调用`);
        } catch (e) {
          console.warn('[scenario] activateScenarioLine failed', e);
          this.debugPanelUI.log(`[scenario] 激活失败: ${id} — ${String(e)}`);
        }
      },
      scenarioDebugComplete: (scenarioId) => {
        const id = scenarioId.trim();
        if (!id) return;
        try {
          this.scenarioStateManager.completeScenarioLine(id);
          this.debugPanelUI.log(`[scenario] completeScenarioLine("${id}") 已调用`);
        } catch (e) {
          console.warn('[scenario] completeScenarioLine failed', e);
          this.debugPanelUI.log(`[scenario] 完成失败: ${id} — ${String(e)}`);
        }
      },
      scenarioDebugResetIncomplete: (scenarioId) => {
        const id = scenarioId.trim();
        if (!id) return;
        this.scenarioStateManager.resetScenarioProgressForDebug(id);
        this.debugPanelUI.log(
          `[scenario] resetScenarioProgressForDebug("${id}")：线已视为未完成（已清 phase 桶与 manual 生命周期；exposes 写入的 flag 未回滚）`,
        );
      },
      getDepthOcclusionBlendFactor: () => this.sceneDepthSystem.occlusionBlendFactor,
      setDepthOcclusionBlendFactor: (factor) => {
        this.sceneDepthSystem.occlusionBlendFactor = factor;
      },
      depthOcclusionActive: () => this.sceneDepthSystem.isEnabled,
      getDepthFootModel: () => ({
        groundField: this.sceneDepthSystem.hasGroundDepthField,
        footBias: this.sceneDepthSystem.footBias,
      }),
      setDepthFootBias: (v) => { this.sceneDepthSystem.footBias = v; },
      getCharLightingDebug: () => {
        const cl = this.characterLighting;
        const info = cl.loadedInfo;
        if (!info) return null;
        return {
          active: cl.active, enabled: cl.enabled,
          probes: info.probes, lights: info.lights,
          hasVolumes: cl.hasVolumes,
          params: { ...cl.params, sunColor: [...cl.params.sunColor] as [number, number, number] },
          shadowStyle: { gain: cl.shadowStyle.gain },
        };
      },
      setCharLighting: (patch) => {
        const cl = this.characterLighting;
        if (patch.enabled !== undefined && patch.enabled !== cl.enabled) {
          cl.enabled = patch.enabled;
          this.reattachBakedEntityFilters();   // 开关切换 = 新旧滤镜互换
        }
        if (patch.params) {
          const prevMode = cl.params.mode;
          Object.assign(cl.params, patch.params);
          const nextMode = cl.params.mode;
          // 任意切档都要按需换资源(RT↔体素卷 / cache↔对应 probe 图集,进场景只载当前 mode)
          if (nextMode !== prevMode) {
            cl.params.mode = prevMode;               // 先留原档,资源到位后才真正切
            void this.applyCharMode(nextMode);
          }
        }
        if (patch.shadowStyle) Object.assign(cl.shadowStyle, patch.shadowStyle);
        // GI体视图开着时,β/mode/ambStrength 的改动要**同步刷给场景侧**——
        // 角色侧 syncFrame 每帧活读 params,场景侧只在开档那一刻喂过一次,
        // 不刷的话拖曝光滑块只有人变亮、地面纹丝不动,像 bug 又查不出错。
        if (this.giVolumeDebugOn && patch.params) {
          const r = cl.shadingResources;
          if (r) {
            this.sceneLighting.setProbeResources({
              atlasL1: r.atlasL1, atlasL2: r.atlasL2, atlasBin: r.atlasBin, valid: r.valid,
              mCol: r.mCol, wMin: r.wMin, wScale: r.wScale, pn: r.pn, probeT: r.probeT, shK: r.shK, binOb: r.binOb, ambSH: r.ambSH,
              skyao: r.skyao ?? null,
              mode: cl.params.mode, ambStrength: cl.params.ambStrength, beta: cl.params.beta, fold: cl.params.fold ? 1 : 0,
            });
          }
        }
      },
      // ---- 统一光影（lighting-rebuild）。与上面的角色照明是两代系统，刻意分开 ----
      getSceneLighting: () => {
        const p = this.sceneLighting.params;
        if (!this.sceneLighting.active || !p) return null;
        const lights = p.lights.filter((l) => l.enabled ?? true);
        return {
          active: true,
          params: p,
          backgroundWu: this.sceneLighting.backgroundWu,
          lightCount: lights.length,
          shadowLightCount: lights.filter((l) => l.castShadow).length,
          radianceScale: this.sceneLighting.radianceScale,
          giReady: this.sceneLighting.giBounceTexture !== null,
        };
      },
      setSceneLighting: (part) => {
        const cur = this.sceneLighting.params;
        if (!cur) return;
        this.applySceneLightingParams({ ...cur, ...part });
      },
      setSceneLightingDebug: (mode) => {
        this.sceneLighting.setDebug(mode);
        // 角色的调试视图与场景共用一个旋钮：只有「法线」两边都成立（场景 1 ↔ 统一角色
        // 那条路自己的 2），其余档角色回正常显示。
        // ⚠ 2026-09-07 重编号：场景的「天穹可见性」与「S_day」两档随 skyvis 退出运行时
        //   一起删了，所以这里也不再有它们的对应项。（统一角色路径本身早已整条关死。）
        this.unifiedCharLighting.setDebug(mode === 1 ? 2 : 0);
        // ---- 5=「GI体」:场景与角色同吃 probe 体,肉眼对账 GI 数据 ----
        //
        // 场景侧要角色的 probe 图集(按需加载、可热替换),所以**开启那一刻现取现喂**,
        // 关闭即退回占位——不做常驻绑定,免得跟角色纹理生命周期耦合。
        // 角色侧掐掉实体灯与太阳(纯 probe E),场景侧本来就只画 albedo×probeE:
        // 两边只剩同一份体的光,哪里对不上哪里就是体数据的问题。
        // 5=albedo×E 6=纯E(albedo≡1) 7=纯E×probe棋盘 8=最近邻原始值 —— 四档同一套
        // probe 装配,只是 shader 端展示不同;6/7/8 额外让角色也 albedo≡1(uEOnly)。
        const wantGiVol = mode >= 5 && mode <= 9;
        // 9=「skyao体」:场景直采 skyao probe 只算 AO;角色同步切 V 灰度档 ——
        // 人与场景同一份数据同一个式子,灰度无缝续接才算 AO 数据对。
        this.characterLighting.setCharDebugView(mode === 9 ? 2 : 0);
        this.characterLighting.eOnlyDebug = mode >= 6 && mode <= 8;
        // 棋盘档角色同画(诊断判据:格边穿脚连续/走动同帧翻转/竖向格高与邻墙一致)
        this.characterLighting.eCheckerDebug = mode === 7;
        // 离开 GI体档:诊断参数(定法线/quad放大)必须自动复位——它们只该在诊断时活着
        if (!wantGiVol) this.setGiDiagnostics(0, 1);
        if (wantGiVol !== this.giVolumeDebugOn) {
          this.giVolumeDebugOn = wantGiVol;
          const cl = this.characterLighting;
          if (wantGiVol) {
            const r = cl.shadingResources;
            if (r) {
              this.sceneLighting.setProbeResources({
                atlasL1: r.atlasL1, atlasL2: r.atlasL2, atlasBin: r.atlasBin, valid: r.valid,
                mCol: r.mCol, wMin: r.wMin, wScale: r.wScale, pn: r.pn, probeT: r.probeT, shK: r.shK, binOb: r.binOb, ambSH: r.ambSH,
                skyao: r.skyao ?? null,
              mode: cl.params.mode, ambStrength: cl.params.ambStrength, beta: cl.params.beta, fold: cl.params.fold ? 1 : 0,
              });
            } else {
              this.debugPanelUI?.log('GI体视图:本场景没有角色 probe 载荷,场景侧只会是黑的');
            }
            this.giVolumeDebugSunWas = cl.params.sunEnabled;
            cl.params.sunEnabled = false;
            cl.applyLights(null);
          } else {
            this.sceneLighting.setProbeResources(null);
            cl.params.sunEnabled = this.giVolumeDebugSunWas;
            cl.applyLights(this.sceneLighting.packedLights ?? null, this.sceneLighting.wuPerQUnit);
          }
        }
      },
      // GI体档的诊断参数(F2 诊断组,只在 5-8 档显示):定法线 + 主角 quad 放大
      setGiDiagnostics: (fixedN, quadScale) => this.setGiDiagnostics(fixedN, quadScale),
      setLightingSyncHooks: (hooks) => { this.lightingSyncHooks = hooks; },
      // 同步连接状态：断了必须在界面上看得见，不能只在 console 里
      getLightingSyncStatus: () => this.lightingSync?.statusLine() ?? '',
      /**
       * 角色的世界坐标(**wu**)。走与影子绑定同一条链:脚点 → 胸口 q → M-world → ×wuPerQUnit。
       * 复用 `shadowBasisRows`(det=+1 的游戏约定 R),别自己再拼一遍矩阵。
       */
      getPlayerLightWorld: () => {
        const rows = this.characterLighting.shadowBasisRows;
        if (!rows || !this.sceneLighting.active) return null;
        const q = this.characterLighting.chestQAt(
          this.player.x, this.player.y, this.player.sprite.getWorldSize().height);
        if (!q) return null;
        const k = this.sceneLighting.wuPerQUnit;
        return [
          (rows[0] * q[0] + rows[1] * q[1] + rows[2] * q[2]) * k,
          (rows[3] * q[0] + rows[4] * q[1] + rows[5] * q[2]) * k,
          (rows[6] * q[0] + rows[7] * q[1] + rows[8] * q[2]) * k,
        ] as [number, number, number];
      },
      getEntityLightResponse: (kind) => this.characterLighting.getLightFactors(kind),
      toggleCharProbeViz: () => this.toggleCharProbeViz(),
      charProbeVizActive: () => this.probeVizGfx !== null,
      entityShadowActive: () => this.entityShadowDebugActive(),
      getEntityShadowDebug: () => this.getEntityShadowDebug(),
      cycleShadowMode: () => this.cycleShadowModeDebug(),
      toggleEntityTone: () => this.toggleEntityToneDebug(),
      toggleEntityShadowBillboard: () => this.toggleEntityShadowBillboardDebug(),
      setEntityShadowAzimuth: (deg) => this.setEntityShadowAzimuthDebug(deg),
      nudgeEntityShadowElevation: (d) => this.nudgeEntityShadowElevationDebug(d),
      nudgeEntityShadowLength: (d) => this.nudgeEntityShadowLengthDebug(d),
      nudgeEntityShadowDarkness: (d) => this.nudgeEntityShadowDarknessDebug(d),
      nudgeEntityShadowContact: (d) => this.nudgeEntityShadowContactDebug(d),
      nudgeEntityShadowContactSize: (d) => this.nudgeEntityShadowContactSizeDebug(d),
      nudgeEntityShadowSoftSamples: (d) => this.nudgeEntityShadowSoftSamplesDebug(d),
      toggleEntityShadowEnabled: () => this.toggleEntityShadowEnabledDebug(),
      smellDebug: {
        listProfiles: () =>
          Object.entries(this.smellProfilesData?.profiles ?? {}).map(([id, p]) => ({ id, name: p.name || id })),
        set: (scent, intensity, dir, flicker) => this.smellSystem.setSmell(scent, intensity, dir, flicker),
        clear: () => this.smellSystem.clearSmell(),
        setZone: (scent, intensity, dir, flicker) => this.smellSystem.setZoneSmell(scent, intensity, dir, flicker),
        clearZone: () => this.smellSystem.clearZoneSmell(),
        sniff: () => this.smellSystem.sniff(),
        getForm: () => this.hud?.getSmellForm() ?? null,
        setFormParam: (key, value) => this.hud?.setSmellFormParam(key, value),
        setSourceAtPlayerOffset: (dx) => this.smellSystem.setSource(this.player.x + dx, this.player.y),
        clearSource: () => this.smellSystem.clearSource(),
        setTracking: (enabled) => this.smellSystem.setTracking(enabled),
        isTracking: () => this.smellSystem.isTracking(),
      },
      objectExamineDebug: {
        getStatusText: () => this.objectExamineManager.getDebugStatusText(),
        getInstanceList: () => this.objectExamineManager.getInstanceList(),
        start: (id) => { void this.objectExamineManager.start(id); },
        abort: () => this.objectExamineManager.abortActiveSession(),
        isActive: () => this.objectExamineManager.isActive,
        getOverrides: () => {
          const o = this.objectExamineManager.getDebugOverrides();
          return {
            backgroundPreset: o.backgroundPreset,
            upright: o.upright,
            showHotspotDebug: o.showHotspotDebug,
          };
        },
        setBackgroundPreset: (preset) => this.objectExamineManager.setDebugBackgroundPreset(preset),
        setUpright: (upright) => this.objectExamineManager.setDebugUpright(upright),
        resetPresentationOverrides: () => this.objectExamineManager.resetDebugPresentationOverrides(),
        setShowHotspotDebug: (show) => this.objectExamineManager.setDebugShowHotspotDebug(show),
        setDistanceIndex: (index) => this.objectExamineManager.setDebugDistanceIndex(index),
        getLiveDistanceIndex: () => {
          const s = this.objectExamineManager.getDebugVisualState();
          return typeof s?.distanceIndex === 'number' ? s.distanceIndex : null;
        },
        getLiveBackgroundBrightness: () => {
          const s = this.objectExamineManager.getDebugVisualState();
          return typeof s?.backgroundBrightness === 'number' ? s.backgroundBrightness : 1;
        },
        getLiveBackgroundScale: () => {
          const s = this.objectExamineManager.getDebugVisualState();
          return typeof s?.backgroundScale === 'number' ? s.backgroundScale : 1;
        },
        setBackgroundBrightness: (v) => this.objectExamineManager.setDebugBackgroundBrightness(v),
        setBackgroundScale: (v) => this.objectExamineManager.setDebugBackgroundScale(v),
        getLiveContactAoIntensity: () => {
          const s = this.objectExamineManager.getDebugVisualState();
          return typeof s?.contactAoIntensity === 'number' ? s.contactAoIntensity : 1;
        },
        getLiveContactAoRadiusCm: () => {
          const s = this.objectExamineManager.getDebugVisualState();
          return typeof s?.contactAoRadiusCm === 'number' ? s.contactAoRadiusCm : 0;
        },
        getLivePixelsPerCm: () => {
          const s = this.objectExamineManager.getDebugVisualState();
          return typeof s?.pixelsPerCm === 'number' ? s.pixelsPerCm : 1;
        },
        setContactAoIntensity: (v) => this.objectExamineManager.setDebugContactAoIntensity(v),
        setContactAoRadiusCm: (v) => this.objectExamineManager.setDebugContactAoRadiusCm(v),
        getResolvedAmbience: () => this.objectExamineManager.getResolvedAmbience(),
        setAmbiencePatch: (patch) => this.objectExamineManager.setDebugAmbiencePatch(patch),
        resetAmbienceOverrides: () => this.objectExamineManager.resetDebugAmbienceOverrides(),
      },
    });
    this.debugTools?.init();

    await Promise.all([
      this.loadFlagRegistry(),
      this.loadCharacterRegistry(),
      this.loadSmellProfiles(),
      this.loadFootstepSets(),
      this.inventoryManager.loadDefs(),
      this.rulesManager.loadDefs(),
      this.questManager.loadDefs(),
      this.narrativePackageDirector.loadDefs(),
      this.encounterManager.loadDefs(),
      this.pressureHoldManager.loadDefs(),
      this.planeReconciler.loadDefs(),
      this.npcScheduleSystem.loadDefs(),
      this.signalCueManager.loadDefs(),
      this.bubbleChatterSystem.loadDefs(),
      this.audioManager.loadConfig(),
      this.cutsceneManager.loadDefs().then(() => {
        if (!this.tearDownComplete) this.preloadCutsceneTrajectoryAssets();
      }),
      this.archiveManager.loadDefs(),
      this.clueManager.loadDefs(),
      this.systemNoteManager.loadDefs(),
      this.shopUI.loadDefs(),
      this.mapUI.loadConfig(),
    ]);
    if (this.tearDownComplete) return;

    await this.refreshTextResolveLookups();
    if (this.tearDownComplete) return;
    this.wireTextResolve();
    this.wireGameLog();

    this.debugPanelUI.attachFlagDebug(this.flagStore, this.eventBus);
    /** F2「场景」页：与 DebugTools 同一条 DEV 门控——生产玩家没有任意跳场景的入口。 */
    if (import.meta.env.DEV) {
      this.debugPanelUI.attachSceneDebug({
        getCurrentSceneId: () => this.sceneManager.currentSceneData?.id,
        jump: (sceneId, spawnPoint) => {
          void this.devLoadScene(sceneId, spawnPoint);
        },
        listFallback: () => this.getDerivedDevSceneEntries(),
        onSceneChanged: (cb) => {
          this.eventBus.on('scene:enter', cb);
          return () => this.eventBus.off('scene:enter', cb);
        },
        log: (m) => this.debugPanelUI.log(m),
      });
      /** F2「声学」页：只看状态、按试听；编辑与保存在声学工作台。 */
      /** F2「粒子」页：只看状态、按刺激；效果在粒子工作台调、实例在主编辑器场景页摆。 */
      this.debugPanelUI.attachVfxDebug({
        getSceneId: () => this.sceneManager.currentSceneData?.id,
        getSpaceInfo: () => {
          const sp = this.vfxSystem.currentSpace;
          return sp ? { kind: sp.kind, hasShell: sp.hasShell, wuPerQ: sp.wuPerQ } : null;
        },
        getSnapshot: () => this.vfxSystem.debugSnapshot(),
        getStats: () => this.vfxSystem.stats,
        setConfineOverlay: (on: boolean) => {
          if (on && !this.vfxConfineOverlay) this.vfxConfineOverlay = new VfxConfineOverlay(this.renderer.uiLayer);
          else if (!on && this.vfxConfineOverlay) { this.vfxConfineOverlay.destroy(); this.vfxConfineOverlay = null; }
        },
        getConfineOverlay: () => this.vfxConfineOverlay !== null,
        emitAtPlayer: (def: VfxFieldDef, h: number) => {
          const w = this.vfxSystem.sceneToWorld(this.player.contactX, this.player.contactY, h);
          if (w) this.vfxSystem.emitField(def, w);
        },
        setState: (id: string, st: VfxFlockState) => this.vfxSystem.setVfxState(id, st),
        log: (m: string) => this.debugPanelUI.log(m),
        getWind: () => ({
          authored: this.sceneWind.authored, overrides: this.sceneWind.overrides, time: this.sceneWind.time,
        }),
        setWindOverride: (o) => this.sceneWind.setOverride(o),
        getSwayStats: () => {
          const sb = this.swayBackground;
          return sb ? { ms: sb.updateMs, verts: sb.vertexCount, insts: sb.instanceCount } : null;
        },
        getForegroundStats: () => {
          const fg = this.foregroundLayers;
          return fg ? {
            layers: fg.layers.map((l) => l.label), coverageMs: fg.coverageMs,
            enabled: fg.isEnabled, coverageLive: this.sceneDepthSystem.hasForegroundCoverage,
          } : null;
        },
        getForegroundToggles: () => ({ enabled: this.foregroundEnabled, coverageView: this.foregroundCoverageView }),
        setForegroundEnabled: (on: boolean) => {
          this.foregroundEnabled = on;
          this.foregroundLayers?.setEnabled(on);
        },
        setForegroundCoverageView: (on: boolean) => {
          this.foregroundCoverageView = on;
          const sd = this.sceneManager.currentSceneData;
          this.foregroundLayers?.setCoverageView(on, this.renderer.worldContainer,
            [sd?.worldWidth ?? 1, sd?.worldHeight ?? 1]);
        },
      });
      /** F2「燃烧」页：只看状态、按探针；可燃物模板在燃烧工作台里改。 */
      this.debugPanelUI.attachBurnDebug({
        getSceneId: () => this.sceneManager.currentSceneData?.id,
        getStats: () => this.burnSystem.debugStats,
        getSnapshot: () => this.burnSystem.debugSnapshot(),
        getIgniter: () => this.heldPropSystem.igniterOf('player') ?? this.burnSystem.heldIgniterOf('player'),
        getPerformer: () => this.ignitePerformer.debugState,
        canPlayerIgnite: (id) => this.burnSystem.canPlayerIgnite(id),
        ignite: (id, socket) => this.burnSystem.igniteBurnable(id, socket),
        extinguish: (id, socket) => this.burnSystem.extinguishBurnable(id, socket),
        reset: (id, socket) => this.burnSystem.resetBurnable(id, socket),
        log: (m: string) => this.debugPanelUI.log(m),
      });
      this.debugPanelUI.attachAcousticDebug({
        getCurrentSceneId: () => this.sceneManager.currentSceneData?.id,
        getSpaceId: () => this.audioManager.getAcousticSpaceId(),
        getBoundSpaceId: () => this.acousticSpaceId,
        getSpaceDef: (id) => this.audioManager.getAcousticSpaceDef(id),
        getTaps: () => this.audioManager.getAcousticTaps() as AcousticTap[],
        playProbe: (sfxId) => { this.audioManager.playSfxAt(sfxId, null); },
        getRuntimeListener: () => this.acousticListenerLast,
        getOutputPeakDb: () => this.audioManager.getRecentOutputPeakDb(),
        getPerf: () => ({
          costMs: this.audioManager.getAcousticBuildCostMs(),
          thresholdM: this.audioManager.getAcousticMoveThresholdM(),
        }),
        getSyncStatus: () => this.acousticsSync?.statusLine() ?? '',
        hasPendingSpace: () => this.audioManager.hasPendingAcoustic(),
        log: (m) => this.debugPanelUI.log(m),
      });
    }
    this.setupCutsceneStepHud();
    this.setupPlaneDebugSection();

    if (!this.gameConfig.initialScene) {
      console.error('Game: initialScene not configured in game_config.json');
    }
    this.saveManager.setFallbackScene(this.gameConfig.fallbackScene || this.gameConfig.initialScene);

    await this.setupPlayer({ deferAvatar: this.isDevMode });
    if (this.tearDownComplete) return;
    this.setupRuntimeDebugSnapshotPublishing();
    // 气味调试 hook（平时关；URL 加 ?smellDebug 开启）：console 里 __smell(scent,intensity,dir,flicker) /
    // __smellSniff() / __smellStep(n) 驱动 HUD 气味指示器看效果。隐藏页 rAF 被节流时 __smell 会强制步进给截图用。
    if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('smellDebug')) {
      const w = window as unknown as Record<string, unknown>;
      this.smellDebugGlobalKeys = [
        '__smell', '__smellSniff', '__smellStep', '__smellInfo',
        '__smellZoneEnter', '__smellZoneExit', '__smellSource',
      ];
      const stepHud = (n: number) => {
        if (!document.hidden) return; // 可见页：让 HUD 自带 rAF 自然播动画（flash/coil/fade）；只在隐藏页强制步进给截图用
        const r = (this.hud as unknown as { smellRenderer?: { update: (dt: number) => void } }).smellRenderer;
        if (r) for (let i = 0; i < (n || 30); i++) r.update(0.05);
        try { (this.renderer as unknown as { app?: { render?: () => void } }).app?.render?.(); } catch { /* 隐藏页强制重绘 canvas */ }
      };
      w.__smell = (scent: string, intensity?: number, dir?: number, flicker?: boolean, steps?: number) => {
        this.smellSystem.setSmell(scent, intensity, dir, flicker);
        stepHud(steps ?? 30);
      };
      w.__smellSniff = (steps?: number) => { this.smellSystem.sniff(); stepHud(steps ?? 16); };
      w.__smellStep = (n: number) => stepHud(n);
      w.__smellInfo = () => {
        const r = this.hud as unknown as {
          smellRenderer?: { layer?: { x: number; y: number; visible: boolean; children: { length: number } };
            wispSprites?: { visible: boolean; alpha: number }[]; baseSprites?: { visible: boolean }[];
            renderScent?: string; fade?: number };
        };
        const sr = r.smellRenderer;
        if (!sr) return { renderer: null };
        return {
          layerX: sr.layer?.x, layerY: sr.layer?.y, layerVisible: sr.layer?.visible,
          children: sr.layer?.children?.length,
          wispVisible: (sr.wispSprites || []).filter((s) => s.visible && s.alpha > 0.003).length,
          baseVisible: (sr.baseSprites || []).filter((s) => s.visible).length,
          renderScent: sr.renderScent, fade: sr.fade,
        };
      };
      // 验证 zone:enter/zone:exit → SmellSystem zone 层（不需真走进区域）。
      w.__smellZoneEnter = (scent: string, intensity?: number, dir?: number, flicker?: boolean, steps?: number) => {
        this.eventBus.emit('zone:enter', { zoneId: '__debugzone__', zone: { id: '__debugzone__', smell: { scent, intensity, dir, flicker } } });
        stepHud(steps ?? 30);
      };
      w.__smellZoneExit = (steps?: number) => {
        this.eventBus.emit('zone:exit', { zoneId: '__debugzone__' });
        stepHud(steps ?? 30);
      };
      w.__smellSource = () => this.smellSystem.getDebugState();
    }

    /** 主 tick 必须在任何场景装载**之前**挂载：场景根 onEnter 可能直接起长演出
     *  （图对话→startCutscene 一路 await 到播完），演出期间世界侧实体全靠 tick 驱动
     *  （玩家容器坐标同步、NPC 动画帧推进）。晚挂 = 开场演出期间世界冻结：玩家滞留
     *  世界原点(0,0)、NPC 定格实例化首帧。与下方 dev 直达路由「主 tick 已挂载才安全
     *  执行」同一原则。tick 各分支对"场景未装载"均安全（空实体表 / currentSceneData?.）。 */
    if (this.tearDownComplete || !this.renderer.isInitialized()) {
      return;
    }
    const ticker = this.renderer.app.ticker;
    if (!ticker) {
      return;
    }
    this.lastTime = performance.now();
    this.mainTick = () => {
      const now = performance.now();
      const dt = Math.min((now - this.lastTime) / 1000, 0.1);
      this.lastTime = now;
      if (this.logicFreezeReasons.size > 0) {
        /**
         * 断点冻结期间仍要**每帧清一次输入沿**。`endFrame()` 原本是 tick 的最后一句，
         * tick 被整个跳过的话 `keyJustPressed` / `mouseJustClicked` 会一直攒着——
         * 策划以为游戏卡了，按了 Q、E、空格，「继续」之后这些会在同一帧全部判定成
         * "刚按下"同时生效（闻一下 + 触发身边热点 + 换姿势）。
         */
        this.inputManager.endFrame();
        return;
      }
      if (!this.fixedTickMode) this.tick(dt);
    };
    ticker.add(this.mainTick);
    // sprite 网格着色的共享帧组:挂在 **Pixi ticker** 上、渲染前必跑 —— 刻意不放进 tick 的
    // 任何状态分支(filter 路径的"Cutscene 态驱动被跳过 → uniform 冻死"正是这么来的)。
    this.charLitFrameSync = () => {
      const wc = this.renderer.worldContainer;
      const scale = this.camera.getProjectionScale();
      this.characterLighting.syncFrame(wc.x, wc.y, scale);
      // 统一光影那一路吃**同一个** worldContainer 位姿与同一组形体参数，
      // 挂在同一个回调里 —— 两条路径不可能出现"一条同步了另一条没有"。
      if (this.unifiedCharLighting.active) {
        // ⚠ 只借 AO 两项。形体参数（bulge/flatten）**不**从这里拿——
        //   `shapeParams` 里的值来自旧 probe 载荷、是给旧着色模型调的，
        //   含义与新模型不同（见 SceneLightingDef.characterShape）。
        const { aoContact, aoForm } = this.characterLighting.shapeParams;
        this.unifiedCharLighting.syncFrame(wc.x, wc.y, scale, { aoContact, aoForm });
      }
    };
    ticker.add(this.charLitFrameSync, undefined, UPDATE_PRIORITY.LOW + 1);

    // ⚠ 分支顺序有讲究：**标题态 / 按槽启动排在 dev 之前**。
    // 这两条是"玩家在菜单里刚刚做出的选择"经整页重启带回来的，`mode=dev` 只是开发外壳；
    // 反过来判的话，开发模式下点「返回主菜单」会被 dev 直达路由抢走，标题永远出不来。
    if (options.startAtTitle) {
      // 标题态启动：**世界一律不装**（没有场景、没有玩家落地、没有开场演出）。
      // 这是「返回主菜单＝彻底退出这一局」的兑现处——标题界面底下真的什么都没有，
      // 所以子面板的遮罩不可能再漏出游戏画面。
      // 之后点「新游戏 / 继续」都会再整页重启一次，由那一次走正常引导（见 EventBridge）。
      this.eventBridge.markSessionStarted();
      this.hud.setHidden(true);
      this.stateController.setState(GameState.MainMenu);
      this.menuUI.openMainMenu();
    } else if (await this.tryBootFromSaveSlot(options.loadSlot)) {
      /* 存档已读进来（场景也由 SaveManager 装好），不再走任何开局引导 */
    } else if (import.meta.env.DEV && this.isDevMode) {
      // `import.meta.env.DEV &&` 不是多余的：main.ts 在 prod 下已把 devMode 折叠成 false，
      // 但这里若只判运行时字段，startDevMode 连同 DevModeUI 整棵会原样留在发行包里
      // （验收门曾按类名断言"已剥净"，而类名早被压缩器改掉——恒真的假安全网）。
      // 加上编译期常量后这一支被静态剔除，verify_build.mjs 才能按 DevModeUI 的文案真判。
      /** 走字段而非再加一个位置参数：startDevMode 的形参已过长，且此值只在直达路由用一次。 */
      const rawFrom = Number(options.playCutsceneFrom);
      this.devPlayCutsceneFromStep = Number.isFinite(rawFrom) && rawFrom > 0 ? Math.floor(rawFrom) : 0;
      await this.startDevMode(
        options.playCutscene,
        options.waterPreview,
        options.sugarWheelPreview,
        options.paperCraftPreview,
        options.devScene,
        options.narrativeWarp,
        options.visualCapture === true,
      );
    } else {
      if (this.gameConfig.initialQuest) {
        this.questManager.acceptQuest(this.gameConfig.initialQuest);
      }
      // 首场景在过渡遮罩下装载、就绪后再揭幕：避免玩家看着背景/NPC 逐个刷出，
      // 也让 onEnter 开场演出落在"已完整揭幕"的场景上（见 scene-onenter-reveal-timing）。
      await this.sceneManager.loadInitialScene(this.gameConfig.initialScene);
      await this.tryStartInitialPrologue();
    }

    if (this.tearDownComplete || !this.renderer.isInitialized()) {
      return;
    }
    this.setupWebGlPanelDiagnostics();

    // 调试器桥要抢在直达路由**之前**装：warp 直达会 await 一长串状态推进与演出，
    // 装在后面的话，策划用 ?narrative_warp= 直奔某一拍时调试器根本连不上
    // （实测过），而且 warp 推了哪些状态本身就是他想看的。
    this.setupNarrativeDebugBridge();

    // dev 启动直达路由：主 tick 已挂载（过场位移/小游戏 update 有驱动），此刻才安全执行
    if (this.devStartupRoute) {
      const route = this.devStartupRoute;
      this.devStartupRoute = null;
      try {
        await route();
      } catch (e) {
        console.warn('Game: dev 启动直达路由失败', e);
      }
    }
    if (this.tearDownComplete || !this.renderer.isInitialized()) return;
    this.runtimeReady = true;
    this.setupRuntimeCommandPolling();
    await this.publishRuntimeDebugSnapshot('runtime-ready');
  }

  /**
   * 叙事调试器桥（dev-only，默认关）。开它有三个入口，走的是同一个开关：
   *
   * 1. 地址栏 `?ndbg=1`（`?ndbg=0` 是显式关，压过下面那个勾——排干扰用）；
   * 2. 标题界面右下角那个勾 / F2「叙事调试器」区块里那个勾（记进工程文件，跨端口跨重启都在）；
   * 3. 控制台 `__ndbg.on()`（临时开一次，不改那个勾）。
   *
   * `import.meta.env.DEV` 让整块在 prod build 里被静态剔除；没开启时连挂点都不装。
   */
  private setupNarrativeDebugBridge(): void {
    if (!import.meta.env.DEV) return;
    this.installNarrativeDebugConsoleApi();
    const startup = resolveNarrativeDebugStartup();
    // 地址栏明写了 ?ndbg=0：这一页就是不要，连工程文件都不去问
    if (startup.mode === 'off') return;
    if (startup.mode === 'on') {
      this.enableNarrativeDebugBridge({ port: startup.port, persist: false });
      return;
    }
    /**
     * 地址栏没说话 → 问工程文件里那个勾（异步，期间游戏照常跑）。
     * ⚠ 回来时这一局可能已经拆了（HMR / 整页重启前的 destroy）：必须再判一次，
     * 否则会往已销毁的实例上装探针，观察者与 socket 都无人回收。
     */
    void fetchNarrativeDebugPref().then((pref) => {
      if (!pref?.enabled || this.tearDownComplete || this.narrativeDebugBridge) return;
      // 人在这几毫秒里已经自己扳过开关了（标题界面那行/控制台）：以人为准。
      // 读回来的是**发起 fetch 那一刻**的旧值，拿它去覆盖等于把刚关掉的又打开。
      if (this.narrativeDebugUserDecided) return;
      this.enableNarrativeDebugBridge({ port: pref.port, persist: false });
    });
  }

  /** 桥装上了没 + 连上调试器没（F2 面板、标题界面那个勾、控制台三处共用这一份读数）。 */
  getNarrativeDebugStatus(): {
    installed: boolean;
    connected: boolean;
    port: number;
    queued: number;
  } {
    const bridge = this.narrativeDebugBridge;
    return {
      installed: bridge !== null,
      connected: bridge?.isConnected() === true,
      port: bridge?.port ?? resolveNarrativeDebugStartup().port,
      queued: bridge?.queued() ?? 0,
    };
  }

  /**
   * 现场开：装探针并去连调试器。已经装着就只是换端口重装（端口被占时策划会换）。
   *
   * @param options.persist 默认 true＝把这次的勾记进工程文件，下次进游戏自动带上。
   *   地址栏来的那次传 false：URL 是一次性的意思，不该把人永久留在调试态。
   */
  enableNarrativeDebugBridge(options?: { port?: number; persist?: boolean }): boolean {
    if (!import.meta.env.DEV) return false;
    if (this.tearDownComplete) return false;
    if (options?.persist !== false) this.narrativeDebugUserDecided = true;
    const port = options?.port && options.port > 0
      ? Math.floor(options.port)
      : this.getNarrativeDebugStatus().port;
    if (this.narrativeDebugBridge) {
      if (this.narrativeDebugBridge.port === port) {
        if (options?.persist !== false) saveNarrativeDebugPref({ enabled: true, port });
        return true;
      }
      // 换端口＝换一个调试器进程，旧连接必须先干净拆掉（断点闸/观察者都是单槽）
      this.teardownNarrativeDebugBridge();
    }
    console.log(`[叙事调试器] 已装载探针，正在找调试器（端口 ${port}；没开就 ./dev.sh narrative-debugger）…`);
    this.attachNarrativeDebugBridge(port);
    if (options?.persist !== false) saveNarrativeDebugPref({ enabled: true, port });
    // 开关可能是从别处扳的（控制台 / 工程文件异步读回）：标题界面那行要跟着改字
    this.menuUI?.refreshDevToggle();
    return true;
  }

  /** 现场关：拆探针、断连接。默认同时把工程文件里那个勾取消。 */
  disableNarrativeDebugBridge(options?: { persist?: boolean }): void {
    if (!import.meta.env.DEV) return;
    const port = this.getNarrativeDebugStatus().port;
    this.teardownNarrativeDebugBridge();
    if (options?.persist !== false) saveNarrativeDebugPref({ enabled: false, port });
    this.menuUI?.refreshDevToggle();
  }

  /**
   * 控制台入口：`__ndbg.on()` / `__ndbg.off()` / `__ndbg.status()`。
   *
   * **不管桥装没装都挂**——接不上的时候最需要的正是"一句话看出是没装还是装了连不上"，
   * 那时候如果连 `__ndbg` 都没有，人只能去翻 URL 参数。
   */
  private installNarrativeDebugConsoleApi(): void {
    if (!import.meta.env.DEV || typeof window === 'undefined') return;
    const api = {
      /** 开（可指定端口）：`__ndbg.on()` / `__ndbg.on(5212)` */
      on: (port?: number) => {
        const ok = this.enableNarrativeDebugBridge({ port, persist: true });
        console.log(ok ? '[叙事调试器] 开了' : '[叙事调试器] 开不了（这一局已经拆了）');
        return this.getNarrativeDebugStatus();
      },
      /** 关：`__ndbg.off()` */
      off: () => {
        this.disableNarrativeDebugBridge({ persist: true });
        console.log('[叙事调试器] 关了');
        return this.getNarrativeDebugStatus();
      },
      toggle: () => (this.narrativeDebugBridge ? api.off() : api.on()),
      /** 只开这一次，不改工程文件里那个勾 */
      once: (port?: number) => {
        this.enableNarrativeDebugBridge({ port, persist: false });
        return this.getNarrativeDebugStatus();
      },
      status: () => {
        const s = this.getNarrativeDebugStatus();
        console.log(
          s.connected
            ? `[叙事调试器] 接上了（端口 ${s.port}，待发 ${s.queued}）`
            : s.installed
              ? `[叙事调试器] 探针装了，但没找到调试器（端口 ${s.port}）——./dev.sh narrative-debugger`
              : '[叙事调试器] 没装（__ndbg.on() 现在就能开）',
        );
        return s;
      },
      help: '__ndbg.on() 开 / .off() 关 / .once(5212) 只开这次 / .status() 看状态',
    };
    (window as unknown as Record<string, unknown>).__ndbg = api;
    this.narrativeDebugConsoleApiInstalled = true;
  }

  /**
   * 冻/解冻游戏逻辑（主 tick）。**按原因记账**：任一原因还在就继续冻。
   *
   * 只冻游戏逻辑：Pixi 照渲、WebSocket 照收、DOM 面板照点——所以叙事调试器的「继续」
   * 送得进来，编辑模式的鼠标也还能用。
   *
   * ⚠ 除了主 tick 还要挡 **Pixi 事件**：UI 层的点击走 Pixi 的 DOM 事件，与主 tick 无关。
   * 不挡的话断在"对话选项还亮着"那一拍时，鼠标点选项照样执行动作、照样发信号，
   * "断下来是干净现场"就不成立了。世界热点/NPC 交互是 tick 里轮询按键的，本来就冻住了。
   */
  private setLogicFrozen(reason: LogicFreezeReason, frozen: boolean): void {
    const before = this.logicFreezeReasons.size;
    if (frozen) this.logicFreezeReasons.add(reason);
    else this.logicFreezeReasons.delete(reason);
    const after = this.logicFreezeReasons.size;
    if ((before > 0) === (after > 0)) return;

    const stage = this.renderer?.app?.stage;
    if (!stage) return;
    if (after > 0) {
      // ⚠ 记住原值再改：stage 的缺省是 'passive'（只有子节点可交互），
      // 解冻时写死 'static' 会把它改成"容器自己也可交互"——那是另一种行为。
      if (this.stageEventModeBeforeFreeze === null) {
        this.stageEventModeBeforeFreeze = stage.eventMode ?? 'passive';
      }
      stage.eventMode = 'none';
    } else if (this.stageEventModeBeforeFreeze !== null) {
      stage.eventMode = this.stageEventModeBeforeFreeze;
      this.stageEventModeBeforeFreeze = null;
    }
  }

  /** 真正把探针挂上去（连接、观察者、五个玩家动作事件）。只由 enable 路径调用。 */
  private attachNarrativeDebugBridge(port: number): void {
    const bridge = installNarrativeDebugBridge({
      getSnapshot: () => this.buildRuntimeDebugSnapshot('narrative-debugger'),
      getSceneId: () => this.sceneManager.currentSceneData?.id ?? '',
      canSave: () => this.saveManager.canSaveNow(),
      exportSave: () => this.saveManager.capturePayload(),
      importSave: (payload) => this.saveManager.loadPayload(payload),
      emitSignal: (signal) => this.narrativeStateManager.emitNarrativeSignal({
        sourceType: signal.sourceType as NarrativeSignal['sourceType'],
        sourceId: signal.sourceId,
        signal: signal.signal,
        // 私有信号的定向依据。调试器没挑实体时不带，行为与从前一字不差。
        ...(signal.owner ? { owner: signal.owner } : {}),
      }),
      setState: (graphId, stateId) => this.narrativeStateManager.debugSetNarrativeState(graphId, stateId),
      reloadScene: (sceneId) => this.devLoadScene(sceneId || (this.sceneManager.currentSceneData?.id ?? '')),
      /** 断点期间冻主 tick（只冻游戏逻辑；Pixi 照渲、WebSocket 照收，所以「继续」送得进来） */
      setLogicFrozen: (frozen) => this.setLogicFrozen('narrative', frozen),
    }, { port });
    this.narrativeDebugBridge = bridge;
    NarrativeStateManager.traceObserver = bridge.onTrace;
    ActionExecutor.actionObserver = bridge.noteAction;

    // 玩家动手的三个入口，只订阅既有事件，不碰发事件的那几个系统。
    // 这样"我点了但什么都没发生"在调试器上有痕迹，而不是一片空白。
    const listeners: [string, (payload: unknown) => void][] = [
      ['hotspot:triggered', (payload) => {
        const def = (payload as { def?: { label?: string; id?: string } })?.def;
        bridge.notePlayerAction('hotspot', String(def?.label || def?.id || '一个物件'));
      }],
      ['npc:interact', (payload) => {
        const def = (payload as { npc?: { def?: { name?: string; id?: string } } })?.npc?.def;
        bridge.notePlayerAction('npc', String(def?.name || def?.id || '一个人'));
      }],
      ['dialogue:start', (payload) => {
        const p = payload as { graphId?: string; npcName?: string } | undefined;
        bridge.notePlayerAction('dialogue', String(p?.graphId || p?.npcName || ''));
      }],
      // 走位也是策划的主力操作：进区域没反应时，时间线不能是空的
      ['zone:enter', (payload) => {
        const zoneId = (payload as { zoneId?: string })?.zoneId;
        bridge.notePlayerAction('zone', String(zoneId || ''));
      }],
      // 换场景不产生叙事 trace，不推快照的话调试器顶栏会一直报上一个场景
      ['scene:enter', () => bridge.noteWorldChanged('scene.enter')],
    ];
    for (const [event, callback] of listeners) this.eventBus.on(event, callback);
    this.narrativeDebugListeners = listeners;
  }

  /**
   * 拆桥：摘事件、摘观察者、断连接。**destroy 与"现场关掉"走同一条路**——
   * 两份拆法迟早会漂，而漏摘的那一份就是 HMR 之后"点一下上报两条"的根因。
   *
   * 幂等：没装过时是空操作。
   */
  private teardownNarrativeDebugBridge(): void {
    for (const [event, callback] of this.narrativeDebugListeners) {
      this.eventBus.off(event, callback);
    }
    this.narrativeDebugListeners = [];
    const bridge = this.narrativeDebugBridge;
    if (!bridge) return;
    if (NarrativeStateManager.traceObserver === bridge.onTrace) {
      NarrativeStateManager.traceObserver = null;
    }
    if (ActionExecutor.actionObserver === bridge.noteAction) {
      ActionExecutor.actionObserver = null;
    }
    // dispose 内部会先放行断点闸再断线：断在某一拍时关掉调试，玩家必须能继续动
    bridge.dispose();
    this.narrativeDebugBridge = null;
  }

  /** F2「日志」页：WebGL getError、深度 GPU 纹理、shader 预热与上下文丢失；JS/Pixi 运行时错误镜像 */
  private setupWebGlPanelDiagnostics(): void {
    this.runtimeDebugLogCleanup?.();
    this.runtimeDebugLogCleanup = installRuntimeErrorsToDebugPanel((m) => this.debugPanelUI?.log(m));

    const canvas = this.renderer.app.canvas as HTMLCanvasElement | undefined;
    if (!canvas) return;

    this.webglContextLostHandler = (e: Event) => {
      const msg = (e as WebGLContextEvent).statusMessage || '';
      this.debugPanelUI?.log(`[GL诊断] webglcontextlost: ${msg || '(no message)'}`);
    };
    canvas.addEventListener('webglcontextlost', this.webglContextLostHandler);

    this.webglContextRestoredHandler = () => {
      this.debugPanelUI?.log('[GL诊断] webglcontextrestored');
    };
    canvas.addEventListener('webglcontextrestored', this.webglContextRestoredHandler);

    this.glPostRenderDrain = () => {
      const gl = tryGetWebGlFromApplication(this.renderer.app);
      if (!gl) return;
      drainWebGLErrorsToPanel(gl, (m) => this.debugPanelUI?.log(m), '每帧(Pixi渲染后)');
    };
    this.renderer.app.ticker.add(this.glPostRenderDrain, undefined, UPDATE_PRIORITY.UTILITY);
  }

  /** 开发模式或 URL 带 `cutsceneDebug` 时显示左上角过场 step 预览 */
  private cutsceneStepHudWanted(): boolean {
    if (this.isDevMode) return true;
    try {
      return typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('cutsceneDebug');
    } catch {
      return false;
    }
  }

  private setupCutsceneStepHud(): void {
    this.debugPanelUI.addSection('cutscene-step', () => {
      const s = this.cutsceneManager.getPlaybackHudSnapshot();
      if (!s.cutsceneId) {
        return '过场步骤：未在播放';
      }
      return `过场步骤\ncutsceneId: ${s.cutsceneId}\npath: ${s.path ?? '—'}\n${s.label ?? ''}`;
    });

    if (!this.cutsceneStepHudWanted()) return;
    const el = document.createElement('div');
    el.id = 'cutscene-step-hud';
    el.setAttribute('aria-live', 'polite');
    el.style.cssText = [
      'position:fixed', 'left:8px', 'top:8px', 'z-index:10050', 'max-width:min(560px,92vw)',
      'padding:8px 12px', 'font:12px/1.45 ui-monospace,monospace',
      'background:rgba(15,18,24,.88)', 'color:#b8f6c6', 'border:1px solid rgba(120,200,140,.35)',
      'border-radius:6px', 'pointer-events:none', 'white-space:pre-wrap', 'display:none',
      'box-shadow:0 2px 12px rgba(0,0,0,.4)',
    ].join(';');
    document.body.appendChild(el);
    this.cutsceneStepHudEl = el;
    const onStep = (p: { cutsceneId?: string | null; path?: string | null; label?: string | null }) => {
      if (!this.cutsceneStepHudEl) return;
      if (p.path == null && p.label == null) {
        this.cutsceneStepHudEl.style.display = 'none';
        return;
      }
      const id = p.cutsceneId ?? '';
      const path = p.path ?? '';
      const lab = p.label ?? '';
      this.cutsceneStepHudEl.textContent = `[过场 step] ${id}\npath: ${path}\n${lab}`;
      this.cutsceneStepHudEl.style.display = 'block';
    };
    this.listenEvent('cutscene:step', onStep);
  }

  /** F2「位面」区块：当前激活位面 / 来源（manual|narrative|default）/ 各槽生效值。 */
  private setupPlaneDebugSection(): void {
    this.debugPanelUI.addSection('位面', () => {
      const s = this.planeReconciler.getDebugState();
      const lines: string[] = [];
      lines.push(`激活位面: ${s.activePlaneId}${s.def?.label ? `（${s.def.label}）` : ''}`);
      lines.push(`来源: ${s.source === 'manual' ? 'manual（activatePlane 覆盖）' : s.source === 'narrative' ? 'narrative（叙事点名）' : 'default（normal 兜底）'}`);
      if (s.namedBy.length > 0) {
        lines.push(`点名: ${s.namedBy.map((n) => `${n.graphId}→${n.planeId}`).join(', ')}`);
      }
      const d = s.def;
      if (d) {
        if (d.movement) {
          const m = d.movement;
          lines.push(
            `移动: drift=(${m.driftX ?? 0},${m.driftY ?? 0}) speed×${m.speedScale ?? 1} 跑=${m.allowRun !== false ? '允许' : '禁止'}`,
          );
        }
        if (d.interaction) {
          const i = d.interaction;
          lines.push(
            `交互: 热点=${i.canInteractHotspots !== false ? '可' : '禁'} 拾取=${i.canPickup !== false ? '可' : '禁'} 对话=${i.canTalkNpcs !== false ? '可' : '禁'}`,
          );
        }
        if (d.camera?.zoom !== undefined) lines.push(`相机 zoom: ${d.camera.zoom}`);
        if (d.lighting) lines.push('光照: 位面档生效（lightEnvCurve 挂起）');
        if (d.membership === 'exclusive') lines.push('世界模型: exclusive（独立世界，缺省实体不存在）');
        if (d.travel?.allowMapTravel === false) lines.push('旅行: 地图快速旅行禁用');
      } else if (s.activePlaneId !== 'normal') {
        lines.push('（该位面未在 planes.json 注册，各槽按无配置处理）');
      }
      // 掉阳气合成视图（D5 对账可见性）：位面 drain 基线 + 活跃 zone 的 damagePlayer 数额，
      // 两条通道都走 HealthSystem.damage，同一血条上叠加。
      const drainParts: string[] = [];
      if (d?.healthDrainPerSec !== undefined) drainParts.push(`位面 ${d.healthDrainPerSec}/s（仅 Exploring 计费）`);
      for (const z of this.zoneSystem.getActiveZones()) {
        for (const [hook, label] of [['onEnter', '进入'], ['onStay', '停留']] as const) {
          for (const a of (z[hook] ?? [])) {
            if (a?.type === 'damagePlayer') {
              const amount = (a.params as { amount?: number } | undefined)?.amount;
              drainParts.push(`zone ${z.id} ${label} -${amount ?? '?'}`);
            }
          }
        }
      }
      if (drainParts.length > 0) lines.push(`掉阳气: ${drainParts.join('；')}`);
      return `位面\n${lines.join('\n')}`;
    });
  }

  private async loadFlagRegistry(): Promise<void> {
    try {
      const reg = await this.assetManager.loadJson<FlagRegistryJson>(TEXT_URLS.flagRegistry);
      this.flagStore.configureRegistry(reg);
    } catch {
      this.flagStore.configureRegistry(null);
    }
  }

  /** 角色注册表 → SceneManager（NPC 实例化时合并 name/animFile/portraitSlug 默认）。缺文件则空表、退化为纯 NpcDef 内联。 */
  private async loadCharacterRegistry(): Promise<void> {
    try {
      const raw = await this.assetManager.loadJson<CharacterRegistryFile>(TEXT_URLS.characterRegistry);
      this.sceneManager.setCharacterRegistry(buildCharacterRegistry(raw?.characters));
    } catch {
      this.sceneManager.setCharacterRegistry({});
    }
  }

  /** 气味 profiles（方案 E·气味指示器的数据源）→ 交给 HUD 建渲染器。失败则降级无气味指示器。 */
  private async loadSmellProfiles(): Promise<void> {
    try {
      const data = await this.assetManager.loadJson<SmellProfilesRaw>(TEXT_URLS.smellProfiles);
      this.smellProfilesData = data;
      this.hud?.setSmellProfiles(data);
    } catch {
      /* 无 profiles：HUD 气味指示器不显示，不影响其它 */
    }
  }

  // =========================================================================
  // 脚步声与空间化音频
  // =========================================================================

  /** `footstep_sets.json`。缺文件 = 全局无脚步声，不是错误。 */
  private async loadFootstepSets(): Promise<void> {
    try {
      const data = await this.assetManager.loadJson<FootstepConfigData>(TEXT_URLS.footstepSets);
      this.footstepConfig = { ...data, sets: data.sets ?? {} };
    } catch {
      this.footstepConfig = null;
    }
  }

  /**
   * 空间解算器：**每帧现建，不缓存**。
   *
   * 不缓存是刻意的：光照载荷是异步到达的（`characterLighting.onReady` 可能晚于场景 id 落定），
   * 按场景 id 缓存会把「载荷到达前解出的 planar」一直用到下一次换场景——那是典型的静默陈旧，
   * 表现为「这个场景的脚步永远是近似的」，而没有任何报错。每帧多建一个小对象，代价可忽略。
   *
   * `wuPerQUnit === 1` 一律当**可疑值**拒绝：真值逐场景 154–880，
   * `SceneLightingSystem` 在没有载荷时 `?? 1` 静默回落。拿 1 去算，坐标会缩在 ±2 的 q 尺度上，
   * 任何按 wu 定的参考距离都会让整场声音要么全满幅要么全静音。同族事故在光照侧已发生过两次。
   */
  private buildAudioSpaceResolver(): AudioSpaceResolver {
    const persp = this.buildAudioPerspective();
    const geo = this.buildAudioSceneGeometry();
    if (geo) return { mode: 'field', geo, persp };
    return {
      ...planarResolver(this.footstepConfig?.spatial?.planarDepthScale ?? DEFAULT_PLANAR_DEPTH_SCALE),
      persp,
    };
  }

  /**
   * 场景的透视纵深标定（喂给音频解算器）。**没配 `perspectiveScale` 的场景返回 undefined**，
   * 音频完全走正交老路、逐位零变化——全仓 36 个场景里只有 6 个配了透视线。
   *
   * 基准视距与相机听者共用同一个数（`f=1` 处 = `backAtBaseZoomWu`），两者必须同源：
   * 分开取的话「玩家在画面中心时离相机 D0/f」这条自洽性就断了，而断了不报错，
   * 只是声音的远近与画面的缩放对不上（正是 2026-09-08 抓到的那类视听脱节）。
   */
  private buildAudioPerspective(): AudioPerspective | undefined {
    const ps = this.perspectiveScaleResolver;
    if (!ps) return undefined;
    return {
      scaleAt: (x, y) => ps.scaleAt(x, y),
      baseDepthWu: this.listenerBackAtBaseZoomWu(),
    };
  }

  /**
   * 基准视距（wu），**全局唯一来源**：运行时覆盖 > 场景 `acousticListener.backAtBaseZoomWu` >
   * `footstep_sets.json` 的 `spatial.listenerBackAtBaseZoomWu` > 600。
   *
   * 相机听者的视距与透视标定的 `baseDepthWu` 都读它——两处必须同源，见 `buildAudioPerspective`。
   */
  private listenerBackAtBaseZoomWu(): number {
    return positiveOrUndefined(this.audioListenerOverride?.backAtBaseZoomWu)
      ?? positiveOrUndefined(this.sceneManager.currentSceneData?.acousticListener?.backAtBaseZoomWu)
      ?? positiveOrUndefined(this.footstepConfig?.spatial?.listenerBackAtBaseZoomWu)
      ?? DEFAULT_LISTENER_BACK_AT_BASE_ZOOM_WU;
  }


  /**
   * 脚点处该用哪个脚步集：**zone 覆盖 → 场景默认 → 无**。
   *
   * ⚠ 按位置直接查多边形，**不吃 `zone:enter/exit` 事件**：`ZoneSystem.update` 只对玩家做
   * point-in-polygon，那两个事件天生只描述玩家；而脚步要支持任意实体。
   *
   * 多个 zone 重叠时**后声明者赢**（与 SmellSystem「取最后进入者」同向），
   * 这样内容侧可以先铺一块大区、再在上面叠小区。
   */
  private resolveFootstepSetAt(x: number, y: number): string | null {
    let hit: string | null = null;
    for (const z of this.zoneSystem.getZones()) {
      if (z.zoneKind === 'depth_floor') continue;
      const set = z.footstepSet?.trim();
      if (!set) continue;
      if (isValidZonePolygon(z.polygon) && isPointInPolygon(z.polygon, x, y)) hit = set;
    }
    if (hit) return hit;
    return this.sceneManager.currentSceneData?.footstepSet?.trim() || null;
  }

  /** 玩家与 NPC 走**同一个**适配器工厂：玩家不是特例，这一条是架构约束不是风格。 */
  private makeFootstepEmitter(
    id: string,
    contact: () => { x: number; y: number },
    sprite: () => SpriteEntity | null,
    visible: () => boolean,
  ): FootstepEmitter {
    return {
      id,
      getContactX: () => contact().x,
      getContactY: () => contact().y,
      getClip: () => sprite()?.getCurrentState() ?? '',
      getFrameIndex: () => sprite()?.getFrameIndex() ?? 0,
      getFrameCount: () => sprite()?.getFrameCount() ?? 0,
      // 触地与否由精灵自己按「这一帧画的是图集哪一格」回答（sockets.json 的 contactSlots）
      isContactFrame: (frame) => sprite()?.isContactFrameAt(frame) ?? false,
      isVisible: visible,
    };
  }

  /** 实体表换了就重挂发声体（场景装载、过场重建实体都会走到）。 */
  private refreshFootstepEmitters(): void {
    this.footstepSystem.clearEmitters();
    const p = this.player;
    this.footstepSystem.registerEmitter(this.makeFootstepEmitter(
      'player',
      () => ({ x: p.contactX, y: p.contactY }),
      () => p.sprite,
      () => p.sprite.container.visible,
    ));
    for (const npc of this.sceneManager.getCurrentNpcs()) {
      this.footstepSystem.registerEmitter(this.makeFootstepEmitter(
        npc.id,
        () => ({ x: npc.contactX, y: npc.contactY }),
        () => npc.spriteEntity,
        () => npc.container.visible,
      ));
    }
  }

  /** 无头验证入口：空间化的全部可判定量。听感判不了，这份能判。 */
  private getFootstepDebugState(): Record<string, unknown> {
    return {
      configLoaded: this.footstepConfig !== null,
      setCount: Object.keys(this.footstepConfig?.sets ?? {}).length,
      sceneDefaultSet: this.sceneManager.currentSceneData?.footstepSet ?? null,
      space: this.audioSpaceDebug,
      wuPerQUnit: this.sceneLighting.wuPerQUnit,
      camera: { zoom: this.camera.getZoom(), sceneBaseZoom: this.camera.getSceneBaseZoom() },
      ...this.footstepSystem.getDebugOutputState(),
      // 跟脚声：错拍对不对、排没排上、响没响，听感判不了，这份能判
      ...this.followerFootsteps.getDebugOutputState(),
    };
  }

  /** 调试/内容侧改听者（覆盖场景 / 空间 / 配置里的绑定）。传 null 撤掉覆盖。 */
  setAudioListenerConfig(cfg: AudioListenerConfig | null): void {
    this.audioListenerOverride = cfg;
  }

  /**
   * 菜单拿到的存档数据源。
   *
   * 平时就是 `SaveManager` 本体；**标题态启动时只把 `load` 换成"整页重启去读这个槽"**——
   * 那会儿世界压根没装载（没有场景、没有玩家），就地 `SaveManager.load` 等于往空世界里灌状态。
   * 其余方法（列槽位/存/导入导出）照常直通，不做多余包装。
   */
  private saveDataForMenu(options: GameStartOptions): ISaveDataProvider {
    if (!options.startAtTitle) return this.saveManager;
    const sm = this.saveManager;
    return {
      save: (slot, opts) => sm.save(slot, opts),
      renameSlot: (slot, name) => sm.renameSlot(slot, name),
      slotCount: () => sm.slotCount(),
      // 重启后不会再回到这个 Promise，故恒 pending：resolve(false) 会让菜单弹一条"读档失败"
      load: (slot) => {
        this.eventBridge.restartPageToLoadSlot(slot);
        return new Promise<boolean>(() => { /* 页面正在重启，不会有结果 */ });
      },
      getSlotMeta: (slot) => sm.getSlotMeta(slot),
      hasSave: (slot) => sm.hasSave(slot),
      hasAnySave: () => sm.hasAnySave(),
      isPersistent: () => sm.isPersistent(),
      exportSlotPayload: (slot) => sm.exportSlotPayload(slot),
      importSlotPayload: (slot, raw) => sm.importSlotPayload(slot, raw),
    };
  }

  /**
   * 按存档槽启动（标题界面点「继续」经整页重启带回来的 `load_slot`）。
   *
   * **跳过首场景直接读档**：存档里带着 `sceneManager.currentSceneId`，SaveManager 自己会把
   * 对的场景装上，先装一遍首场景纯属白装一次（还会白跑一遍开场演出）。
   * 读失败（没传槽位/槽空/档坏）返回 false，由调用方退回正常引导。
   */
  private async tryBootFromSaveSlot(slot: number | undefined): Promise<boolean> {
    if (typeof slot !== 'number') return false;
    // 内存里已经是别人的一局了：此后点「新游戏」必须整页重启（R20）
    this.eventBridge.markSessionStarted();
    let loaded = false;
    try {
      loaded = await this.saveManager.load(slot);
    } catch (e) {
      console.warn('Game: 启动读档抛错，退回正常开局', e);
    }
    if (!loaded) {
      console.warn(`Game: 存档槽 ${slot} 读取失败，按正常开局启动`);
      return false;
    }
    this.stateController.setState(GameState.Exploring);
    return true;
  }

  private async loadGameConfig(): Promise<void> {
    try {
      const cfg = await this.assetManager.loadJson<Partial<GameConfig>>(TEXT_URLS.gameConfig);
      /**
       * **整包合并**，不是逐键白名单——见 `gameConfigMerge.ts` 的长注释。
       *
       * 白名单那个形状把正确性押在"有人记得来这里加一行"上，而漏掉是完全静默的：
       * 类型有、编辑器有、校验器有、消费端也有，唯独值没被搬进来，作者配了半天
       * 一点反应都没有。记录在案漏过四次（dayNight / playerAvatar.portraitSlug /
       * playerActs / emoteBubbleScale），换成合并后新字段自动生效。
       */
      const { rejected } = mergeGameConfig(this.gameConfig, cfg);
      if (rejected.length > 0) {
        // "配了但形状不对"以前是静默忽略的，和"没配"长得一模一样
        console.warn(
          `[Game] game_config.json 里这些键的值形状不对，已忽略（保持缺省）：${rejected.join(', ')}`,
        );
      }
      // startupFlags = **发行版新开一局**的初始世界状态，只喂正式开局。
      // dev 外壳（mode=dev / 直达场景 / warp / 各预览）刻意不吃：开发时要能从"一张白纸"
      // 起步验某条 flag 到底是谁点亮的，config 预置进来会把这类验证全污染掉。
      // 需要某条 flag 时用调试面板现场写，或去掉 mode=dev 正常开局。
      if (cfg.startupFlags) {
        const entries = Object.entries(cfg.startupFlags);
        if (this.isDevMode) {
          if (entries.length > 0) {
            console.info(
              `[Game] dev 模式：跳过 startupFlags（${entries.length} 条：${entries.map(([k]) => k).join(', ')}），如需请用调试面板写入`,
            );
          }
        } else {
          for (const [k, v] of entries) {
            this.flagStore.set(k, v as boolean | number);
          }
        }
      }
    } catch {
      console.warn('Game: game_config.json not found, using defaults');
    }
    try {
      const ov = await this.assetManager.loadJson<unknown>(TEXT_URLS.overlayImages);
      this.overlayImageRegistry = parseOverlayImages(ov);
    } catch {
      this.overlayImageRegistry = {};
    }
    // 挂件预设是可选表：整个项目可以一条都没有，缺文件不该刷错
    try {
      const raw = await this.assetManager.loadOptionalJson<unknown>(TEXT_URLS.propPresets);
      this.propPresetRegistry = parsePropPresets(raw);
    } catch {
      this.propPresetRegistry = {};
    }
    // 效果块库同样可选（没有临时火把的项目就没有这张表）
    try {
      const raw = await this.assetManager.loadOptionalJson<unknown>(TEXT_URLS.propEffects);
      this.propEffectRegistry = parsePropEffects(raw);
    } catch {
      this.propEffectRegistry = {};
    }
  }

  /**
   * showOverlayImage 的 image 参数：短 id 查 overlay_images.json；以 / 开头则当作完整路径。
   */
  private resolveOverlayImageIdToPath(image: string): string {
    const raw = image.trim();
    if (!raw) return raw;
    if (raw.startsWith('/')) return raw;
    const path = overlayImagePath(this.overlayImageRegistry[raw]);
    if (path) return path;
    console.warn(`Game: overlay 图 id「${raw}」未在 overlay_images.json 中登记，将按原文字符串当路径`);
    return raw;
  }

  /**
   * 这张叠图叠上来时该怎么发声：短 id 查 overlay_images.json 的逐条配置。
   *
   * 直接给完整路径（以 / 开头）的调用点没有登记条目可查，一律走全局默认叠图音。
   * 这里**只解析意图、不播**——发声统一由音频管理器那张系统音效事件表负责
   * （分散播放会做出双响，见 system-sfx-event-table 机制卡）。
   */
  private resolveOverlayImageSfxCue(image: string): OverlaySfxCue {
    const raw = image.trim();
    if (!raw || raw.startsWith('/')) return DEFAULT_OVERLAY_SFX_CUE;
    return overlayImageSfxCue(this.overlayImageRegistry[raw]);
  }

  /** 从磁盘加载玩家动画资源；失败返回 null（由调用方决定占位图集）。 */
  private async buildAnimationManifestRefs(animPath: string, labelPrefix: string): Promise<AssetRef[]> {
    const refs: AssetRef[] = [{ type: 'json', path: animPath, label: `${labelPrefix}清单` }];
    try {
      const animRaw = await this.assetManager.loadJson<AnimationSetDefInput>(animPath);
      if (animRaw.spritesheet) {
        const sheetPath = resolvePathRelativeToAnimManifest(animPath, animRaw.spritesheet);
        refs.push({ type: 'texture', path: sheetPath, label: `${labelPrefix}图集` });
        // 法线图集与图集同批预载：挂滤镜时只做同步缓存读，取不到即走平面法线兜底
        const normalPath = normalAtlasUrlFor(sheetPath);
        if (normalPath) {
          refs.push({ type: 'texture', path: normalPath, label: `${labelPrefix}法线图集` });
        }
      }
    } catch {
      // 实际加载会走占位图；startup manifest 只做尽力预热。
    }
    return refs;
  }

  private async loadPlayerAvatarResources(
    playerAnimPath: string,
  ): Promise<{ texture: any; animDef: AnimationSetDef; sockets: ResolvedSockets | null } | null> {
    try {
      const animRaw = await this.assetManager.loadJson<AnimationSetDefInput>(playerAnimPath);
      if (animRaw.spritesheet) {
        const sheetPath = resolvePathRelativeToAnimManifest(playerAnimPath, animRaw.spritesheet);
        const texture = await this.assetManager.loadTexture(sheetPath);
        const animDef = normalizeAnimationSetDef(animRaw, texture.width, texture.height, sheetPath);
        const sockets = await loadSocketsForAnim(this.assetManager, playerAnimPath, animDef);
        return { texture, animDef, sockets };
      }
      const placeholder = createPlaceholderPlayerTextures(this.renderer.app);
      const texture = placeholder.texture;
      const animDef = normalizeAnimationSetDef(animRaw, texture.width, texture.height);
      return { texture, animDef, sockets: null };
    } catch {
      return null;
    }
  }

  private placeholderPlayerAvatar(): { texture: any; animDef: AnimationSetDef } {
    const placeholder = createPlaceholderPlayerTextures(this.renderer.app);
    return {
      texture: placeholder.texture,
      animDef: {
        spritesheet: '',
        cols: 6,
        rows: 1,
        worldWidth: placeholder.frameWidth,
        worldHeight: placeholder.frameHeight,
        states: {
          [ANIM_IDLE]: { frames: [0, 1], frameRate: 2, loop: true },
          [ANIM_WALK]: { frames: [2, 3, 4, 5], frameRate: 8, loop: true },
          [ANIM_RUN]:  { frames: [2, 3, 4, 5], frameRate: 12, loop: true },
        },
      },
    };
  }

  /** 主角当前生效装扮配置的对话头像立绘集（装扮配置解耦：头像跟配置走，切装扮即切头像） */
  private currentPlayerPortraitSlug: string | null = null;

  /** 装扮配置缺省立绘集：按动画包目录名同名推导，如 …/player_anim/anim.json → player_anim */
  private static portraitSlugFromManifest(path: string): string | null {
    const m = /\/animation\/([^/]+)\/anim\.json/.exec(path);
    return m ? m[1] : null;
  }

  private mountPlayerAvatar(
    texture: any,
    animDef: AnimationSetDef,
    stateMap: Record<string, string> | undefined,
    sourcePathForLog: string,
    applyStateMap: boolean,
    portraitSlug?: string | null,
    sockets?: ResolvedSockets | null,
  ): void {
    this.currentPlayerPortraitSlug =
      portraitSlug?.trim() || Game.portraitSlugFromManifest(sourcePathForLog);
    this.playerAnimDef = animDef;
    this.player.sprite.loadFromDef(texture, animDef, sockets ?? null);
    const sm = applyStateMap ? stateMap : undefined;
    this.player.sprite.setLogicalStateMap(sm);
    if (sm && animDef.states) {
      for (const [logical, clip] of Object.entries(sm)) {
        if (clip && !animDef.states[clip]) {
          console.warn(
            `Game: playerAvatar.stateMap["${logical}"] -> "${clip}" is not a state in ${sourcePathForLog}`,
          );
        }
      }
    }
    this.player.sprite.playAnimation(ANIM_IDLE);
  }

  /** 目标 id → 它的 SpriteEntity（挂点住在精灵上）；找不到返回 null。 */
  /**
   * 实体的脚点（场景坐标 wu）。`player` 或 NPC id；不在场 ⇒ null。
   * 与 `spriteEntityOf` 同一条命中面 —— 手持挂件的灯位与效果锚点从这里起算。
   */
  private entityContactOf(targetId: string): { x: number; y: number } | null {
    const id = targetId.trim();
    if (!id) return null;
    if (id === 'player') return this.player ? { x: this.player.contactX, y: this.player.contactY } : null;
    const npc = this.sceneManager.getNpcById(id);
    return npc ? { x: npc.contactX, y: npc.contactY } : null;
  }

  /**
   * 运行时灯（挂件自带的跟随灯 / 场景里配了 `follow` 的灯）整批落地。
   *
   * 走的是与 `applySceneLightingParams` **同一个口径**：场景侧打包完，把**同一份**
   * packed 推给角色侧 —— 否则会出现"地上那圈光跟着走、人身上的暖光没跟上"。
   * 作者数据（`sceneLighting.params`）一个字节不动，编辑器实时同步看不见这些灯。
   */
  /**
   * 运行时灯**按来源**整份替换，再合成一份交给光照（2026-09-16 燃烧系统加入后才有第二个来源）。
   *
   * `SceneLightingSystem.setDynamicLights` 是整表覆盖：两个来源各推各的会互相冲掉（火把一推，燃烧的火光没了）。
   * 合成次序 = 优先级：**手上举着的在前**（离玩家最近、最该生效，灯槽满了按数组次序截断），燃烧的火光在后。
   */
  private setDynamicLightsFrom(owner: DynamicLightOwner, lights: LightDef[]): void {
    this.dynamicLightsByOwner.set(owner, lights);
    const prop = this.dynamicLightsByOwner.get('prop') ?? [];
    const burn = this.dynamicLightsByOwner.get('burn') ?? [];
    // 落雷排在最前：灯槽满了按数组次序截断，而雷是这一刻画面上唯一重要的光源——
    // 被挤掉就是"雷劈下来画面没亮"，而且只有一行告警。
    const strike = this.dynamicLightsByOwner.get('strike') ?? [];
    const merged = [...strike, ...prop, ...burn];
    this.applySceneDynamicLights(merged);
  }

  private readonly dynamicLightsByOwner = new Map<DynamicLightOwner, LightDef[]>();

  /** 落雷的那一盏运行时灯（限速推送见 {@link StrikeLightRig}）。 */
  private readonly strikeLightRig = new StrikeLightRig();
  /**
   * 撤灯的代数：灯要等雷的效果装到、雷真出现那一拍才点（`playVfx` 的 onStart），在这之间演出被收摊 / 换了场景，
   * 迟到的那一拍不许再把灯点起来。每次撤灯 +1，点灯时比一下。
   */
  private strikeLightEpoch = 0;

  /**
   * 脱手演出会话（`runActionsDetached` 的宿主）。机制全貌见 systems/performanceSession.ts。
   * `null` 直到 `buildPerformanceSessions()` 立起来——它要用到 actionExecutor 与各演出系统。
   */
  private performanceSessions!: PerformanceSessionManager;

  /**
   * 立起脱手演出会话管理器，并把**所有打断源**接上。
   *
   * 打断源的取舍（制作人 2026-09-19 拍板）：
   * - **打断**：过场开演、进小游戏、切场景（含读条）、死亡、回主菜单、读档、拆除。
   * - **不打断**：对话、遭遇、面板。雷在背景劈着、NPC 在旁边说话是**好演出**；
   *   只有全屏接管的东西才必须清场。
   *
   * 状态那一路走 `GameStateController` 的同步旁听席而不是事件总线：要的是"状态一写完就收摊"，
   * 晚一个微任务，演出就会闪在过场的第一拍上面。
   */
  private buildPerformanceSessions(): void {
    /** 每个会话一份 scope（认的是同一个对象，handler 靠它拿到会话记账） */
    const scopes = new WeakMap<PerformanceSession, ActionExecScope>();
    const scopeOf = (session: PerformanceSession): ActionExecScope => {
      let scope = scopes.get(session);
      if (!scope) {
        scope = { detached: true, session };
        scopes.set(session, scope);
      }
      return scope;
    };

    this.performanceSessions = new PerformanceSessionManager({
      runAction: (action, session) =>
        this.actionExecutor.executeAwait(action, session.originContext, scopeOf(session)),
      /**
       * ⚠ 故意不 await：`executeAwait` 的函数体在**第一个 await 之前**就把 handler 同步调掉了，
       * 所以同步结算（写存档、收鬼、给物品）当场落地——这正是切场景/死亡这类同步收尾路径要的。
       * 剩下那点异步尾巴由各系统自己的生命周期闸门收。
       */
      runActionSync: (action, session) => {
        void this.actionExecutor
          .executeAwait(action, session.originContext, scopeOf(session))
          .catch((e) => { console.warn('脱手演出打断补跑失败', e); });
      },
      isPresentationOnly: (type) => isPresentationOnlyAction(type),
      release: {
        setEnvDimNow: (scale) => {
          // 先作废在跑的渐变，再写终值：反过来的话下一档就把归位盖回去了
          cancelSceneDimRamps();
          this.applyEnvDim(scale);
        },
        releaseDuck: (name) => { this.audioManager.releaseAudioDuck(name); },
        clearShake: () => { this.camera.clearShake(); },
        clearStrikeLight: () => {
          this.strikeLightRig.clear();
          this.strikeLightEpoch++;
          this.dynamicLightsByOwner.delete('strike');
        },
        clearGust: () => { this.sceneWind.clearGust(); },
        stopSfx: (id) => { this.audioManager.stopSfxById(id); },
        stopVfxSoft: (id) => { this.vfxSystem.stopVfxSoft(id); },
        stopVfxNow: (id) => { this.vfxSystem.stopVfx(id); },
      },
    });

    this.stateController.setStateChangeObserver((next, previous) => {
      // 控制权从玩家手上收走的那一刻，腿也要收住：不然走路动画在非探索态里继续循环，
      // 人不动、脚步声（与跟脚声）照响（见 Player.settleLocomotion）。
      if (previous === GameState.Exploring && next !== GameState.Exploring) this.player.settleLocomotion();
      // 全屏接管 / 换世界 / 没命了：背景里的演出必须当场收摊（结算补齐、归位做满）
      if (next === GameState.Cutscene) this.performanceSessions.interruptAll('cutscene');
      else if (next === GameState.Minigame) this.performanceSessions.interruptAll('minigame');
      else if (next === GameState.SceneTransition) this.performanceSessions.interruptAll('scene');
      else if (next === GameState.Dead) this.performanceSessions.interruptAll('death');
      else if (next === GameState.MainMenu) this.performanceSessions.interruptAll('teardown');
    });
  }

  /**
   * 环境压暗（雷雨压天色）。**背景与角色/粒子必须同值**——只压一边就是人浮在背景上，
   * 两边的实现完全不同（背景走显示曝光，角色/粒子走总受光倍率），所以这里是唯一入口。
   * 不落盘、切场景归 1。
   */
  private applyEnvDim(scale: number): void {
    const s = Number.isFinite(scale) ? Math.max(0, Math.min(1, scale)) : 1;
    this.sceneLighting.setEnvDim(s);
    this.characterLighting.setEnvDim(s);
    // 背景那一侧改的是 display，灯没变；但角色侧读的是同一份 packed，稳妥起见一并重推。
    this.pushPackedLightsToCharacters();
  }

  /** 每帧推进落雷灯；`null` = 限速没轮到，不推。 */
  /**
   * 雷自带的灯（效果 `bolts[].light`）→ 这一道雷的三盏灯。形状与画出来的那道雷**同一个**
   * （同一个 `boltInstanceSeed`）：线光从落点沿雷身走向摆到 `channel.heightWu` 高。效果没写灯 ⇒ null（调用方用旧的单灯）。
   * `strikeThreat` 的 `lightIntensity` 是总亮度，三盏的 gain 乘在它上面；`lightKelvin` 给了就盖过效果里的色温。
   */
  private boltLightSpec(
    info: VfxInstanceStartInfo, intensity: number, durationMs: number, opts: StrikeThreatOptions,
  ): StrikeLightSpec | null {
    const bolt = info.effect.bolts?.find((b) => b.kind === 'sky' && b.sky && b.light);
    const L = bolt?.light;
    const space = this.vfxSystem.currentSpace;
    if (!bolt || !L || !space) return null;
    const foot = info.anchorWorld;
    const contact = L.contact ?? { gain: 1, heightWu: 40, rangeWu: 1400 };
    const spec: StrikeLightSpec = {
      pos: [foot[0], foot[1] + contact.heightWu, foot[2]],
      intensity: intensity * contact.gain,
      range: contact.rangeWu,
      durationMs,
      kelvin: opts.lightKelvin ?? L.kelvin ?? 9000,
      reflect: true,
    };
    const channel = L.channel;
    if (channel && channel.gain > 0 && channel.heightWu > 0) {
      // 雷身的灯：沿画出来的那道雷（同一个 boltInstanceSeed）的折线摆，一段一条线光。
      // 雷在落点那一处的直立面上（与画雷同一个换算：局部 (x, y) → 场景 (落点 + x·透视, 落点 − y·透视) → 直立面上的世界点）
      const g = createBolt(bolt, boltInstanceSeed(info.seed, foot));
      const fs = { x: 0, y: 0 };
      space.toScene(foot, fs);
      const persp = this.perspectiveScaleResolver?.scaleAt(fs.x, fs.y) ?? 1;
      const toWorld = (x: number, y: number): [number, number, number] => {
        const w = space.uprightWorldAtScene
          ? space.uprightWorldAtScene(fs.x, fs.y, fs.x + x * persp, fs.y - y * persp)
          : [foot[0] + x, foot[1] + y, foot[2]];
        return [w[0], w[1], w[2]];
      };
      spec.lines = boltLightPolylines(g, channel.heightWu, STRIKE_CHANNEL_LIGHT_SEGMENTS, STRIKE_BRANCH_LIGHTS)
        .map((s) => ({
          from: toWorld(s.x0, s.y0), to: toWorld(s.x1, s.y1),
          intensity: intensity * channel.gain * s.share, range: channel.rangeWu,
        }));
    }
    if (L.sky && L.sky.gain > 0) {
      // 云被照亮的那一记从雷那边的天上打下来：方位取玩家 → 落点（水平方向）
      const from = space.groundWorldAtScene(this.player.x, this.player.y);
      const dx = foot[0] - from[0], dz = foot[2] - from[2];
      const az = Math.hypot(dx, dz) > 1e-3 ? (Math.atan2(dx, dz) * 180) / Math.PI : 180;
      spec.sky = { intensity: intensity * L.sky.gain, elevationDeg: L.sky.elevationDeg, azimuthDeg: az };
    }
    return spec;
  }

  /**
   * 雷落地那一下（效果 `bolts[].impact`，与灯同一拍）：落点一阵冲击风 + 点着周围开了「雷劈能点着」的可燃物。
   * 冲击风只进表现（吃场景风的粒子、草木摇曳；见 `SceneWindState.addBlast`）；点火走燃烧系统 / 粒子薄片各自的入口，
   * 只点模板开了开关的（09-24 制作人定：不开的雷劈在旁边也不着）。
   */
  private boltImpact(info: VfxInstanceStartInfo): void {
    const im = info.effect.bolts?.find((b) => b.kind === 'sky' && b.impact)?.impact;
    if (!im) return;
    const foot = info.anchorWorld;
    if (im.blast) {
      this.sceneWind.addBlast({
        x: foot[0], z: foot[2], strength: im.blast.strengthWu, radius: im.blast.radiusWu, duration: im.blast.seconds,
      });
    }
    const r = im.igniteRadiusWu ?? 0;
    if (r > 0) {
      this.burnSystem.igniteByLightning(foot, r, r);
      this.vfxSystem.igniteByLightning(foot, r, r);
    }
  }

  private updateStrikeLight(dt: number): void {
    const lights = this.strikeLightRig.update(dt * 1000);
    if (lights) this.setDynamicLightsFrom('strike', lights);
  }

  /**
   * 落雷：挑一个靶（最凶 / 最近的鬼）→ 在它头上放一记雷（粒子 + 一盏运行时强光）→ 让它消失。
   *
   * 挑不到靶时按 `fallback` 处理：`'random'`（缺省）在玩家周围随机找个地方照劈（雷该多响多响，
   * 只是没打着东西）；`'none'` 则整件事不发生。
   *
   * ⚠ **会写存档**（靶子的消失是持久的），所以这条动作**不进过场白名单**——
   * 过场里的动作禁改存档（见 [[action-registration-registry-surfaces]]）。
   *
   * 闪白与震屏**不在这里**：它们是独立动作，由作者在编排里自己排时机（雷光先亮、
   * 半拍后才到震和声音，是"远近"的表达）。这条只管"选谁、劈哪、谁没了"。
   */
  private async strikeThreat(opts: StrikeThreatOptions): Promise<StrikeThreatResult> {
    const sceneAtStart = this.sceneManager.currentSceneData;
    // 这道雷亮多久：灯与粒子共用一个时长，作者只有一个旋钮。
    const strikeMs = Number.isFinite(opts.lightMs) && (opts.lightMs as number) > 0 ? opts.lightMs as number : 420;

    /**
     * 一次落雷可能是**好几道连着劈**。真雷本来就这样（回击 return stroke），
     * 而且"偶尔多劈两下"比每次都一模一样有威慑。
     *
     * ⚠ **每一道雷都独立走一遍完整规则**：现取玩家位置 → 挑周围威胁最高的鬼 → 没鬼就随机落点。
     * 所以几道雷落在**不同**地方（2026-09-20 制作人报"几道雷都打在同一个地方"——那一版是
     * 开头选一次靶、整条链复用，等于连劈只是把同一记雷播三遍）。
     * 本链里已经劈过的靶子进 `struck`，下一道跳过它：劈中就收的那条路靠 `active()` 自然排除，
     * 但 `removeTarget: false`「只演不收」那条不会，不显式排除就又全砸在同一个鬼头上。
     *
     * - `strikes` = 最多几道（缺省 1）。
     * - `extraChance` = 第 2 道起**每一道**真的落下来的概率（缺省 1 = 配几道就劈几道）。
     *   掷不中就**整条链到此为止**——不是跳过这一道继续下一道。于是道数是个几何分布：
     *   多数时候一道、偶尔两道、三道很少见，正是"偶尔来一串"的手感。
     * - `gapMs` ± `gapJitterMs` = 两道之间的间隔（缺省 220 ± 0）。间隔不抖的话，
     *   连劈三道会听成机枪点射而不是雷。
     */
    const numOr0 = (v: unknown, dflt: number): number => {
      const n = typeof v === 'number' ? v : Number(v);
      return v === undefined || v === null || !Number.isFinite(n) ? dflt : n;
    };
    const maxStrikes = Math.max(1, Math.round(numOr0(opts.strikes, 1)));
    const extraChance = Math.max(0, Math.min(1, numOr0(opts.extraChance, 1)));
    const gapMs = Math.max(0, numOr0(opts.gapMs, 220));
    const gapJitterMs = Math.max(0, numOr0(opts.gapJitterMs, 0));
    const visualStrikes = Math.max(0, Math.round(numOr0(opts.visualStrikes, 0)));
    const visualChance = Math.max(0, Math.min(1, numOr0(opts.visualExtraChance, 1)));
    const visualGapMs = Math.max(0, numOr0(opts.visualGapMs, gapMs));
    const visualJitterMs = Math.max(0, numOr0(opts.visualGapJitterMs, gapJitterMs));
    const previousSpots: Vec3[] = [];
    /** 本条雷链已经用过的雷形变体：权威链与装饰补雷共用一份，整条链不重样（见 fireOneBolt） */
    const usedEffects = new Set<string>();
    let surfaceCandidates: StrikeSurfacePoint[] | null = null;
    let surfaceSpace: typeof this.vfxSystem.currentSpace = null;
    let surfaceShell: typeof this.sceneDepthSystem.depthShellField = null;
    let surfaceWarning = false;
    const warnSurface = (reason: string): null => {
      if (!surfaceWarning) {
        surfaceWarning = true;
        const message = `strikeThreat: 跳过装饰落雷，${reason}（${sceneAtStart?.id ?? '无场景'}）`;
        console.warn(message);
        this.debugPanelUI?.log(message);
      }
      return null;
    };
    const pool = (opts.effects ?? []).map((e) => String(e).trim()).filter(Boolean);
    const fallbackEffect = (opts.effect ?? '').trim();
    const seeded = opts.seed !== undefined && Number.isFinite(opts.seed);
    /**
     * 给了 seed 就连"劈几道、挑哪张图、隔多久、随机落在哪"都是确定的（无头复现 / 回放逐帧一致）。
     *
     * 每道雷要**五个互不相干**的数，三组 pair 取出来。一个数兼两职会把两件事绑死——
     * 比如拿间隔抖动当"挑哪张贴图"，间隔偏短的那几道就总是同一张图。
     */
    const roll = (i: number): {
      chance: number; jitter: number; angle: number; radius: number; variant: number;
    } => {
      if (!seeded) {
        return {
          chance: Math.random(), jitter: Math.random(), angle: Math.random(),
          radius: Math.random(), variant: Math.random(),
        };
      }
      const s = opts.seed as number;
      const a = seededUnitPair(s + i * 7919);
      const b = seededUnitPair(s + i * 7919 + 104729);
      const c = seededUnitPair(s + i * 7919 + 15485863);
      return { chance: a.a, jitter: a.b, angle: b.a, radius: b.b, variant: c.a };
    };

    /**
     * 一道雷的落点：**完整规则走一遍**。返回 null = 这一道不该发生（`fallback: 'none'` 且没靶子）。
     * 玩家位置每道现取——连劈之间他还在走，雷该跟着他周围的局面走。
     */
    const pickFallback = (r: { angle: number; radius: number }): (StrikeSurfacePoint & { threatId: null }) | null => {
      if (opts.fallback === 'none') return null;
      const space = this.vfxSystem.currentSpace;
      const shell = this.sceneDepthSystem.depthShellField;
      // Use the shell's own calibration basis (the GPU mirror is Float32-rounded).
      const rows = basisRowsFromDepthConfigR(this.sceneDepthSystem.currentConfig?.M?.R);
      const sd = this.sceneManager.currentSceneData;
      if (sd !== sceneAtStart || !space || space.kind !== 'field' || !shell || !rows) {
        return warnSurface('缺少真实场景几何或场景已切换');
      }
      if (surfaceCandidates === null || surfaceSpace !== space || surfaceShell !== shell) {
        const zoneId = opts.fallbackSurfaceZone;
        const region = zoneId === undefined ? undefined : sd?.zones?.find(z => z.id === zoneId)?.polygon;
        if (zoneId !== undefined && (!region || region.length < 3)) return warnSurface(`表面范围区无效：${zoneId}`);
        surfaceCandidates = buildStrikeSurfaceCandidates({
          space, shell, basis: { basisRows: rows, wuPerQUnit: space.wuPerQ },
          groundAllowed: this.strikeGroundAllowed,
          ...(region ? { surfaceRegion: region.map(p => [p.x, p.y] as [number, number]) } : {}),
          groundOnly: opts.fallbackGroundOnly === true,
          maxSlopeDeg: numOr0(opts.fallbackMaxSlopeDeg, 90),
        });
        surfaceSpace = space;
        surfaceShell = shell;
      }
      const from = space.groundWorldAtScene(this.player.x, this.player.y);
      const radius = Number.isFinite(opts.fallbackRadius) && (opts.fallbackRadius as number) > 0
        ? opts.fallbackRadius as number : 320;
      const margin = Math.max(0, Math.min(0.45, numOr0(opts.fallbackMargin, 0)));
      const screen = this.renderer.app.screen;
      // The current view can already be shaking. Reserve the full old-to-new displacement.
      const shakePad = Math.max(0, numOr0(opts.shakeAmplitude, 0)) * 2;
      const a = this.camera.screenToWorld(screen.width * margin + shakePad, screen.height * margin + shakePad);
      const b = this.camera.screenToWorld(screen.width * (1 - margin) - shakePad, screen.height * (1 - margin) - shakePad);
      const point = sampleStrikeFallback({
        from, radius, random: r,
        minDistance: Math.max(0, numOr0(opts.fallbackMinDistance, radius * 0.45)),
        separation: Math.max(0, numOr0(opts.fallbackSeparation, 0)),
        previous: previousSpots,
        candidates: surfaceCandidates,
        strictSeparation: opts.fallbackStrictSeparation === true,
        bounds: { left: Math.max(0, a.x), right: Math.min(sd?.worldWidth ?? b.x, b.x),
          top: Math.max(0, a.y), bottom: Math.min(sd?.worldHeight ?? b.y, b.y) },
      });
      return point ? { ...point, threatId: null } : warnSurface('世界距离、表面或间距条件内没有可用落点');
    };
    const pickSpot = (
      r: { angle: number; radius: number }, struck: ReadonlySet<string>,
    ): { x: number; y: number; threatId: string | null } | null => {
      const from = { x: this.player.x, y: this.player.y };
      const hit = this.healthThreatSystem.pickTarget(from, {
        ...(opts.maxDistance !== undefined ? { maxDistance: opts.maxDistance } : {}),
        ...(opts.rank !== undefined ? { rank: opts.rank } : {}),
        exclude: struck,
      });
      if (hit) return { x: hit.x, y: hit.y, threatId: hit.id };
      if (opts.fallback === 'none') return null;
      const radius = Number.isFinite(opts.fallbackRadius) && (opts.fallbackRadius as number) > 0
        ? (opts.fallbackRadius as number) : 320;
      const angle = r.angle * Math.PI * 2;
      const dist = radius * (0.45 + 0.55 * Math.sqrt(r.radius));
      return { x: from.x + Math.cos(angle) * dist, y: from.y + Math.sin(angle) * dist, threatId: null };
    };

    /**
     * 静默档（脱手演出被打断）：**结算照做、一道雷都不放**。
     * "打断＝跳过演出，不是取消技能"——鬼照样没，但那会儿多半已经切进过场，没人看得到雷。
     * 静默时不等间隔，于是整条链在**同一个同步块**里走完（打断的同步补跑等不起微任务）。
     */
    const took = {
      vfxIds: [] as string[], sfxIds: [] as string[], lit: false,
      liveVfx: [] as string[], liveAudio: [] as { stop(): void }[],
    };
    const clearFlash = () => this.cutsceneManager.clearScreenFlash();
    if (!opts.silent) opts.onPresentation?.({ cleanup: clearFlash });
    const struck = new Set<string>();
    const threatIds: string[] = [];
    let firstSpot: { x: number; y: number } | null = null;
    let bolts = 0;
    let visualBolts = 0;

    for (let i = 0; i < maxStrikes; i++) {
      const r = roll(i);
      if (i > 0) {
        if (r.chance >= extraChance) break;
        if (!opts.silent) {
          const jitter = gapJitterMs > 0 ? (r.jitter * 2 - 1) * gapJitterMs : 0;
          // 游戏时钟而不是墙钟：玩家在两道雷之间开了背包，第三道该等他出来再劈
          await this.gameClock.wait(Math.max(0, gapMs + jitter));
          // 等待期间换了场景 / 这段演出被打断：后面的雷不该再落下来
          if (!this.vfxSystem.currentSpace) break;
          if (opts.abort?.() === true) break;
        }
      }
      const spot = pickSpot(r, struck);
      if (!spot) break;
      if (spot.threatId) {
        struck.add(spot.threatId);
        threatIds.push(spot.threatId);
        if (opts.removeTarget !== false) this.removeThreatEntity(spot.threatId);
      }
      if (!firstSpot) firstSpot = { x: spot.x, y: spot.y };
      if (!opts.silent) {
        // A real target is absolute: no surface, range, viewport or spacing filter.
        const visibleSpot: { x: number; y: number; world?: Vec3 } | null = spot.threatId ? spot : pickFallback(r);
        if (visibleSpot) {
          const world = visibleSpot.world ?? this.vfxSystem.currentSpace?.groundWorldAtScene(visibleSpot.x, visibleSpot.y);
          if (world) previousSpots.push(world);
          this.fireOneBolt(visibleSpot, { pool, fallbackEffect, strikeMs, opts, variantPick: r.variant, usedEffects, took });
          visualBolts++;
        }
      }
      bolts++;
    }

    // Complete the requested presentation with harmless ground bolts. This loop never
    // selects/removes a threat, consumes an item, or draws from the authoritative chain's RNG.
    const visualSeed = visualStrikes > visualBolts && !opts.silent
      ? (seeded ? (opts.seed as number) ^ 0x6a09e667 : Math.floor(Math.random() * 0x100000000)) : 0;
    for (let i = visualBolts; !opts.silent && i < visualStrikes; i++) {
      if (opts.abort?.() || this.sceneManager.currentSceneData !== sceneAtStart) break;
      const a = seededUnitPair(visualSeed + i * 7919);
      if (a.a >= visualChance) break;
      if (bolts > 0) {
        await this.gameClock.wait(Math.max(0, visualGapMs + (a.b * 2 - 1) * visualJitterMs));
        if (opts.abort?.() || this.sceneManager.currentSceneData !== sceneAtStart) break;
      }
      const b = seededUnitPair(visualSeed + i * 7919 + 104729);
      const spot = pickFallback({ angle: b.a, radius: b.b });
      if (!spot) break;
      if (!firstSpot) firstSpot = { x: spot.x, y: spot.y };
      previousSpots.push(spot.world);
      const variant = seededUnitPair(visualSeed + i * 7919 + 15485863).a;
      this.fireOneBolt(spot, { pool, fallbackEffect, strikeMs, opts, variantPick: variant, usedEffects, took });
      bolts++;
      visualBolts++;
    }

    const at = firstSpot ?? { x: this.player.x, y: this.player.y };
    return {
      hit: threatIds.length > 0,
      threatId: threatIds[0] ?? null,
      threatIds,
      x: at.x, y: at.y, bolts,
      vfxIds: took.vfxIds, sfxIds: took.sfxIds, lit: took.lit,
    };
  }

  /**
   * 放**一道**雷：贴图 + 雷光 + 雷声 + 闪白 + 震屏，在同一句里一起发车。
   *
   * 雷声由这里放、而且用 `playSfxAt` 放在**落点**上（不是 `playSfx` 那种没有位置的一声）：
   * 一道雷的画面和声音是同一件事——分成两条动作各排各的时机，连劈几道时必然错位，
   * 而且远处劈的和脸上劈的会一样响。绑在落点上，方位、距离衰减、空气低通、场景回音
   * 全都自动跟着这道雷走。
   */
  private fireOneBolt(
    at: { x: number; y: number; world?: Vec3; normal?: Vec3 },
    ctx: {
      pool: string[]; fallbackEffect: string; strikeMs: number;
      opts: StrikeThreatOptions; variantPick: number;
      /** 本条雷链已经用过的变体（同一条链里不重样，池用完才允许重复） */
      usedEffects: Set<string>;
      /** 本次落雷取用的演出资源，回填给调用方记进脱手演出的归位账本 */
      took: { vfxIds: string[]; sfxIds: string[]; lit: boolean; liveVfx: string[]; liveAudio: { stop(): void }[] };
    },
  ): void {
    const { pool, fallbackEffect, strikeMs, opts } = ctx;
    const numOr0 = (v: unknown, dflt: number): number => {
      const n = typeof v === 'number' ? v : Number(v);
      return v === undefined || v === null || !Number.isFinite(n) ? dflt : n;
    };
    /**
     * `effects` 提供非空效果池时，每道按池抽样；只提供 `effect` 时，每道使用同一个效果。
     * 是否使用变体由作者配置决定。
     *
     * **同一条雷链里不重样**（见 `pickBoltVariant`）。
     */
    const effect = pickBoltVariant(pool, ctx.variantPick, ctx.usedEffects) ?? fallbackEffect;
    // Particle repeatability is independent of the authoritative chain's random draws.
    const effectSeed = Number.isFinite(opts.effectSeed) ? opts.effectSeed : opts.seed;
    // A sampled shell point is already resolved. Never project it back onto ground.
    // Effect clearance follows the surface normal; light/audio retain world-up height.
    const space = this.vfxSystem.currentSpace;
    const worldAt = (height: number, normalOffset = false): Vec3 | null => {
      if (!at.world) return space?.anchorToWorld({ x: at.x, y: at.y, h: height, surface: 'ground' }) ?? null;
      const n = normalOffset && at.normal ? at.normal : [0, 1, 0];
      return [at.world[0] + n[0] * height, at.world[1] + n[1] * height, at.world[2] + n[2] * height];
    };
    // ---- 灯：与雷**同一拍**点亮（雷的效果装到、雷真出现的那一刻，见 playVfx 的 onStart）----
    // 效果里的雷写了灯（`bolts[].light`）⇒ 落点贴地一盏 + 雷身一条线光 + 天上一记平行光，三盏都在
    // 表面材质区的水面 / 湿地上照出反光；没写 ⇒ 旧的单灯（lightHeight 高处一盏点光）。
    // 灯与声音都不看画面：雷劈在画外照样亮、照样响（09-24 制作人：不能 cull 掉）。
    const intensity = Number.isFinite(opts.lightIntensity) ? Math.max(0, opts.lightIntensity as number) : 0;
    const legacyWorld = intensity > 0 ? worldAt(opts.lightHeight ?? 260) : null;
    const epoch = this.strikeLightEpoch;
    const startLights = (info: VfxInstanceStartInfo | null): void => {
      if (epoch !== this.strikeLightEpoch || !legacyWorld) return;
      const spec = info ? this.boltLightSpec(info, intensity, strikeMs, opts) : null;
      this.strikeLightRig.start(spec ?? {
        pos: [legacyWorld[0], legacyWorld[1], legacyWorld[2]],
        intensity,
        durationMs: strikeMs,
        ...(opts.lightRange !== undefined ? { range: opts.lightRange } : {}),
        ...(opts.lightKelvin !== undefined ? { kelvin: opts.lightKelvin } : {}),
      });
    };
    // 雷真出现的那一拍：落地那一下（冲击风 + 点火）与灯一起
    const onBoltStart = (info: VfxInstanceStartInfo): void => {
      if (epoch !== this.strikeLightEpoch) return;
      this.boltImpact(info);
      startLights(info);
    };
    let lightDeferred = false;
    if (effect) {
      const effectWorld = at.world ? worldAt(opts.effectHeight ?? 0, true) : null;
      const vid = this.vfxSystem.playVfx({
        effect,
        anchor: { x: at.x, y: at.y, h: opts.effectHeight ?? 0, surface: at.world ? 'shell' : 'ground' },
        ...(effectWorld ? { followWorld: effectWorld } : {}),
        ...(effectSeed !== undefined && Number.isFinite(effectSeed) ? { seed: effectSeed } : {}),
        oneShot: true,
        onStart: onBoltStart,
      });
      lightDeferred = !!vid && !!legacyWorld;
      /**
       * 雷柱是**光柱**（`beams`），而光柱没有寿命——只有开关。`oneShot` 的自动收尸要求
       * "粒子放完 **且** 光柱已暗"，光柱不关就永远不满足，那道柱子会一直戳在场上。
       * 所以放完这道雷必须显式软停一次：软停让光柱按自己的 fadeOut 淡掉、在飞的火星飞完再收。
       * （硬 `stopVfx` 对临时实例是当场删除，整道雷凭空消失，演出上是假的。）
       *
       * 换场景不用管：实例随场景清空，`stopVfxSoft` 找不到实例安静返回。
       */
      if (vid) {
        ctx.took.vfxIds.push(vid);
        ctx.took.liveVfx.push(vid);
        opts.onPresentation?.({ vfxId: vid });
        const voices = Math.max(0, Math.min(32, Math.round(numOr0(opts.vfxVoices, 0))));
        // Zero preserves every instance's authored lifetime; a positive budget opts into stealing.
        while (voices > 0 && ctx.took.liveVfx.length > voices) this.vfxSystem.stopVfx(ctx.took.liveVfx.shift()!);
        // 同上：暂停期间雷柱该定在屏上，不该在背包盖着的时候自己淡掉
        this.gameClock.after(strikeMs, () => { this.vfxSystem.stopVfxSoft(vid); });
      }
    }

    // 灯位沿用 VFX 的 M-world；声音单独按听者的透视音频空间换算。
    if (intensity > 0) {
      if (legacyWorld) {
        // 效果没放出来（没有效果 / 放不了）⇒ 没有"雷出现的那一拍"可等，当场点
        if (!lightDeferred) startLights(null);
        ctx.took.lit = true;
        opts.onPresentation?.({ lit: true });
      } else {
        // 没几何场 = 整套光照禁用，这在本项目里是"作者还没烘这张图"的常见状态，必须出声。
        console.warn('strikeThreat: 当前场景没有粒子/光照空间，雷光这一层不出（粒子与消失照旧）');
      }
    }

    const sfx = (opts.sfx ?? '').trim();
    if (sfx) {
      // 声源摆在落点、约人耳高度：不用 lightHeight（那是给灯用的，在半空）。
      const groundWorld = at.world ? space?.groundWorldAtScene(at.x, at.y) : null;
      const world = resolveSurfaceWorld(
        this.buildAudioSpaceResolver(),
        { contactX: at.x, contactY: at.y, heightWu: 60 },
        at.world && groundWorld ? { world: at.world, groundWorld } : undefined,
      );
      const voices = Math.max(0, Math.min(16, Math.round(numOr0(opts.sfxVoices, 0))));
      while (voices > 0 && ctx.took.liveAudio.length >= voices) ctx.took.liveAudio.shift()!.stop();
      const handle = this.audioManager.playSfxAt(
        sfx,
        world ? { x: world[0], y: world[1], z: world[2] } : null,
        {
          ...(opts.sfxVolume !== undefined ? { volume: opts.sfxVolume } : {}),
          ...(opts.mixOwner ? { mixOwner: opts.mixOwner } : {}),
        },
      );
      if (handle) {
        ctx.took.liveAudio.push(handle);
        opts.onPresentation?.({ cleanup: () => handle.stop() });
      }
      if (!ctx.took.sfxIds.includes(sfx)) ctx.took.sfxIds.push(sfx);
    }

    const flashAlpha = numOr0(opts.flashAlpha, 0);
    if (flashAlpha > 0) {
      void this.cutsceneManager.screenFlash(
        Math.max(1, numOr0(opts.flashMs, 150)), 0xffffff, Math.min(1, flashAlpha),
      ).catch(() => {});
    }
    const shakeAmplitude = numOr0(opts.shakeAmplitude, 0);
    if (shakeAmplitude > 0) {
      this.camera.shake(shakeAmplitude, Math.max(1, numOr0(opts.shakeMs, 700)), 20);
      opts.onPresentation?.({ shaken: true });
    }
  }

  /**
   * 让某个威胁背后的实体永久消失。走的是与 `persistNpcEntityEnabled` / `persistHotspotEnabled`
   * **完全相同**的通道（派生基底 + 存档覆盖），不另开一条"杀死"语义——
   * 实体显隐是四通道单点合成的，绕过去就会被下一次刷新覆盖回来（见 [[entity-visibility-channels]]）。
   *
   * 威胁源的 `active()` 本来就绑在这两个判据上，所以实体一关，伤害自动停，不必另发"解除威胁"。
   */
  private removeThreatEntity(threatId: string): void {
    const scene = this.sceneManager.currentSceneData;
    if (!scene) return;
    const npc = scene.npcs?.find((e) => e.healthThreat?.id === threatId);
    if (npc) {
      this.sceneManager.mergePersistentNpcState(npc.id, { enabled: false });
      this.resolveActorFn(npc.id)?.setVisible(false);
      return;
    }
    const hotspot = scene.hotspots?.find((e) => e.healthThreat?.id === threatId);
    if (hotspot) {
      void this.setSceneEntityFieldFromAction(scene.id, 'hotspot', hotspot.id, 'enabled', false)
        .catch((e) => { console.warn('strikeThreat: 收掉热点失败', e); });
      return;
    }
    console.warn(`strikeThreat: 威胁「${threatId}」找不到对应实体，没东西可收`);
  }

  private applySceneDynamicLights(lights: LightDef[]): void {
    if (!this.sceneLighting.active) {
      /**
       * **降级必须出声**（scene-lighting 卡的硬契约）：当前这张原画没烘几何场载荷
       * （`lighting/<背景基名>/geometry.json` + normal + albedo）⇒ 整套光照禁用，
       * 于是手上举着火把也**一点光都没有**，而作者只会以为预设配错了。一个场景只说一次。
       * （2026-09-14 前"没写 lighting 块"也会走到这里，那条已改成按缺省块启用。）
       */
      if (lights.length > 0) {
        const sceneId = this.sceneManager.currentSceneData?.id ?? '(无场景)';
        if (this.dynamicLightMuteWarnedFor !== sceneId) {
          this.dynamicLightMuteWarnedFor = sceneId;
          const bg = this.sceneManager.currentSceneData?.backgrounds?.[0]?.image ?? 'background.png';
          const msg = `[heldProp/burn] ${sceneId}：场景光照未启用（${bg} 没烘几何场，或没有 depthConfig），`
            + `手持光源 / 燃烧火光的 ${lights.length} 盏灯不会出现——贴图与粒子照旧。`
            + `烘：sh scripts/py.sh -m tools.character_lighting_lab.scene_fields --scene ${sceneId}`;
          console.warn(msg);
          this.debugPanelUI?.log(msg);
        }
      }
      return;
    }
    this.sceneLighting.setDynamicLights(lights);
    this.pushPackedLightsToCharacters();
  }

  /** `fadeLight` 的强度倍率整批落地（同上：推完场景再推角色）。 */
  private applySceneLightIntensityScales(scales: Map<string, number>): void {
    if (!this.sceneLighting.active) return;
    this.sceneLighting.setLightIntensityScales(scales);
    this.pushPackedLightsToCharacters();
  }

  /** 把场景刚打包好的灯推给角色侧（"一视同仁"靠的就是共用这一份 packed）。 */
  private pushPackedLightsToCharacters(): void {
    const packed = this.sceneLighting.packedLights;
    this.characterLighting.applyLights(packed ?? null, this.sceneLighting.wuPerQUnit);
    const def = this.sceneLighting.params;
    if (packed && def) {
      this.unifiedCharLighting.applyParams(
        def, packed, this.sceneLighting.wuPerQUnit, this.sceneLighting.radianceScale);
    }
  }

  /**
   * 挂件效果的排序宿主：宿主在实体层里的节点（玩家 = 精灵容器；NPC = 外层容器，转身翻的是它）
   * + 挂件此刻画在身前还是身后。宿主不在 / 挂点这一帧没标注 ⇒ null（照常逐颗分桶）。
   */
  private vfxSortHostOf(targetId: string, socket: string): VfxSortHost | null {
    const id = targetId.trim();
    const sprite = this.spriteEntityOf(id);
    const pose = sprite?.getSocketPose(socket);
    if (!sprite || !pose) return null;
    const node = id === 'player' ? sprite.container : this.sceneManager.getNpcById(id)?.container;
    return node ? { node, front: pose.front } : null;
  }

  /** 燃烧系统的宿主对象（每个实体一份，身份稳定：渲染侧按宿主身份判"还是不是同一个"） */
  private readonly burnHostCache = new WeakMap<object, BurnEntityHost>();
  private readonly burnHeldHostCache = new Map<string, BurnHeldHost>();

  /** 当前场景开了可燃的实体（A3.8）：热点挂两道燃烧滤镜、NPC 在图像空间里换纹理 */
  private burnEntityHosts(): BurnEntityHost[] {
    const out: BurnEntityHost[] = [];
    const layer = this.renderer.entityLayer;
    for (const h of this.sceneManager.getCurrentHotspots()) {
      if (!h.def.burnable) continue;
      let host = this.burnHostCache.get(h);
      if (!host) {
        host = {
          id: h.def.id, kind: 'hotspot',
          get burnable() { return h.def.burnable; },
          frame: (size) => burnPlacementFrame(burnEntityPlacement(h.def, size, { depthScale: h.depthScaleFactor, flipX: h.getFacing() < 0 })),
          get active() { return h.active; },
          render: { kind: 'filters', host: h },
          container: h.container,
        };
        this.burnHostCache.set(h, host);
      }
      out.push(host);
    }
    for (const npc of this.sceneManager.getCurrentNpcs()) {
      if (!npc.def.burnable) continue;
      let host = this.burnHostCache.get(npc);
      if (!host) {
        host = {
          id: npc.def.id, kind: 'npc',
          get burnable() { return npc.def.burnable; },
          // 量本体精灵画出来的样子（实例缩放 / 旋转 / 镜像 / 透视 / 轨迹叠加都在里面），立面过接地点
          frame: () => {
            const se = npc.spriteEntity;
            const tl = se?.bodyUvToLayer(layer, 0, 0);
            const tr = se?.bodyUvToLayer(layer, 1, 0);
            const bl = se?.bodyUvToLayer(layer, 0, 1);
            return tl && tr && bl ? burnFrameFromCorners(tl, tr, bl, { x: npc.contactX, y: npc.contactY }) : null;
          },
          get active() { return npc.container.visible; },
          render: {
            kind: 'texture',
            host: {
              burnBaseTexture: () => npc.spriteEntity?.bodyBurnBaseTexture() ?? null,
              setBurnTextures: (albedo, emissive) => npc.spriteEntity?.setBodyBurnTextures(albedo, emissive),
            },
          },
          container: npc.container,
        };
        this.burnHostCache.set(npc, host);
      }
      out.push(host);
    }
    return out;
  }

  /** 此刻挂着的可燃挂件（A3.8）：图像空间里换纹理；摆放量挂件贴图画出来的样子，立面过拿着它的人的接地点 */
  private burnHeldHosts(): BurnHeldHost[] {
    const out: BurnHeldHost[] = [];
    const seen = new Set<string>();
    const layer = this.renderer.entityLayer;
    for (const x of this.heldPropSystem.listBurnable()) {
      const key = `${x.target}::${x.socket}`;
      seen.add(key);
      let host = this.burnHeldHostCache.get(key);
      if (!host || host.prop !== x.prop) {
        const { target, socket } = x;
        // eslint-disable-next-line @typescript-eslint/no-this-alias -- 宿主对象的 getter 要读组装层此刻的实体
        const self = this;
        host = {
          target, socket, prop: x.prop, burnable: x.burnable,
          frame: () => {
            const se = this.spriteEntityOf(target);
            const foot = this.entityContactOf(target);
            const tl = se?.attachmentUvToLayer(socket, layer, 0, 0);
            const tr = se?.attachmentUvToLayer(socket, layer, 1, 0);
            const bl = se?.attachmentUvToLayer(socket, layer, 0, 1);
            return tl && tr && bl && foot ? burnFrameFromCorners(tl, tr, bl, foot) : null;
          },
          render: {
            kind: 'texture',
            host: {
              burnBaseTexture: () => this.spriteEntityOf(target)?.attachmentBurnBaseTexture(socket) ?? null,
              setBurnTextures: (albedo, emissive) => this.spriteEntityOf(target)?.setAttachmentBurnTextures(socket, albedo, emissive),
            },
          },
          get container() {
            return target === 'player'
              ? self.player.sprite.container
              : self.sceneManager.getNpcById(target)?.container ?? self.player.sprite.container;
          },
        };
        this.burnHeldHostCache.set(key, host);
      }
      out.push(host);
    }
    for (const key of [...this.burnHeldHostCache.keys()]) if (!seen.has(key)) this.burnHeldHostCache.delete(key);
    return out;
  }

  /** 上一次呼吸工作台推来过的呼吸图 id(撤销覆盖时让它们下次从盘上重读) */
  private breathingPreviewIds = new Set<string>();

  /**
   * DEV 呼吸工作台推来工作态(`null` 撤销):之后新显示的呼吸图用它,正在显示的同一张图立刻换上新参数。
   * 撤销时丢掉 JSON 缓存,下次显示从盘上重读(工作台「导出到游戏」写盘后不必重开游戏)。
   */
  private applyBreathingPreview(docs: Record<string, unknown> | null): void {
    const ids = new Set([...this.breathingPreviewIds, ...Object.keys(docs ?? {})]);
    for (const id of ids) this.assetManager.dropJson(breathingJsonUrl(id));
    this.breathingPreviewIds = new Set(Object.keys(docs ?? {}));
    this.breathingOverlaySystem.applyPreview(docs);
  }

  /**
   * DEV 燃烧工作台推来模板工作态（`null` 撤销）：燃烧系统换模板、纸钱按新模板重建、开了可燃的热点 / NPC 按新模板重画、
   * 手上的可燃挂件按新模板（图 / 握点 / 尺寸）重挂。
   */
  private applyBurnTemplatePreview(burnables: Record<string, unknown> | null): void {
    this.burnSystem.applyPreview(burnables);
    this.vfxSystem.applyPreviewBurnTemplates(burnables);
    void this.sceneManager.refreshBurnableDisplays().then((npcs) => {
      const baked = this.characterLighting.shadingResources;
      for (const npc of npcs) {
        npc.setPerspectiveScale(this.perspectiveScaleResolver);
        if (baked) npc.enableBakedShading(this.litShaderProvider);
      }
    });
    this.heldPropSystem.reapplyBurnableViews();
  }

  private spriteEntityOf(targetId: string): SpriteEntity | null {
    const id = targetId.trim();
    if (!id) return null;
    if (id === 'player') return this.player.sprite;
    const npc = this.sceneManager.getNpcById(id);
    return npc?.spriteEntity ?? null;
  }

  /** 已挂上去的挂件：`<实体id>::<挂点>` → Sprite（卸载时要 destroy，纹理归 AssetManager 缓存管） */
  private socketAttachViews = new Map<string, Sprite>();
  /** 挂件上的帧动画火苗（同键；与 socketAttachViews 同生同灭） */
  private socketFlameViews = new Map<string, Sprite>();
  /** 帧动画火苗图集切出来的帧包装：`图集|列|帧数` → Texture[]（源归 AssetManager，包装归这里） */
  private flameFrameCache = new Map<string, Texture[]>();

  /**
   * 用火种点火的结果 → 玩家看得见的反馈（A3.7「火种」）：开始点不出字（火边的符号在装）；点着了放点火声；
   * 没点着 / 点不了出一行字说为什么。文案在 strings.json `igniter` 类。
   */
  private onPlayerIgniteResult(result: HeldIgniteResult, name: string): void {
    if (result === 'started') return;
    if (result === 'success') {
      this.audioManager.playSfx('sfx_lamp_oil_flame');
      return;
    }
    // 进了对话 / 演出 / 面板时没点着：那边正在说别的事，不插一行字
    if (result === 'failInterrupted') return;
    const text = this.stringsProvider.get('igniter', result, { name });
    if (text && text !== result) this.eventBus.emit('notification:show', { text, type: result === 'moving' ? 'info' : 'warning' });
  }

  /**
   * Action 入口：往挂点挂一张（或一列）图。
   * 多张 = 挂点驱动帧号——用标注里的 `frame` 选第几张，**不引入第二个时钟**。
   * 挂件的显隐由挂点标注决定（该帧没标注就自动隐藏），不需要另外的动作去藏它。
   */
  private async attachToSocketFromAction(
    targetId: string,
    socket: string,
    images: string[],
    opts: {
      prop?: string;
      scale?: number; mirror?: boolean;
      anchorX?: number; anchorY?: number; rotation?: number; lit?: boolean;
      state?: string;
    },
  ): Promise<void> {
    const propId = (opts.prop ?? '').trim();
    if (propId) {
      const preset = this.propPresetRegistry[propId];
      if (!preset) {
        console.warn(`attachToSocket: 挂件预设「${propId}」未在 prop_presets.json 中登记`);
      }
      /**
       * 引了预设就走手持挂件系统：它认状态表、自带灯与自带效果，也管卸下时一起收走。
       * 只给图不给 prop 的老写法仍走下面那条直路（无状态、无灯，与既有行为逐字一致）。
       */
      // 动作入口挂上 = 进入初始状态，执行它的进入动作（读档 / 切场景的自动重挂不走这里）
      await this.heldPropSystem.attach(targetId, socket, propId, opts.state, { ...opts, images }, { enterActions: true });
      return;
    }
    if (opts.state) {
      console.warn('attachToSocket: 给了 state 却没给 prop —— 状态住在挂件预设里，没有预设就没有状态');
    }
    const resolved = resolvePropAttach(undefined, { ...opts, images });
    await this.attachSocketView(targetId, socket, resolved);
  }

  /**
   * 真正把贴图挂上去（资源加载 + 建 Sprite + 交给 SpriteEntity 摆位）。
   * 手持挂件系统把"挂哪张图"算完之后调这里 —— 它不碰资源，资源归组装层。
   */
  private async attachSocketView(
    targetId: string,
    socket: string,
    resolved: ResolvedPropAttach,
  ): Promise<void> {
    const sprite = this.spriteEntityOf(targetId);
    if (!sprite) {
      console.warn(`attachToSocket: 找不到实体 "${targetId}"`);
      return;
    }
    const textures: Texture[] = [];
    // 可燃挂件（A3.8）：贴图取模板、挂点对准模板握点、大小 = 模板真实宽 × 预设 scale（挂件是等比的，按宽算）
    let burnTemplate: ResolvedBurnable | null = null;
    if (resolved.burnable) {
      burnTemplate = await this.burnSystem.loadTemplate(resolved.burnable.template);
      if (!burnTemplate) {
        console.warn(`attachToSocket: 可燃挂件的模板「${resolved.burnable.template}」装不到，挂不上`);
        return;
      }
    }
    for (const url of burnTemplate ? [burnTemplate.image] : resolved.images) {
      try {
        textures.push(await this.assetManager.loadTexture(url));
      } catch (e) {
        console.warn(`attachToSocket: 贴图加载失败 ${url}`, e);
      }
    }
    if (textures.length === 0) return;
    const flameFrames = resolved.flame ? await this.loadFlameFrames(resolved.flame) : null;
    // 加载是异步的：期间可能已切场景/卸实体，落地前再确认一次目标还在
    if (this.spriteEntityOf(targetId) !== sprite) return;

    const key = `${targetId}::${socket}`;
    this.destroySocketView(key);
    const view = new Sprite(textures[0]);
    // 支点缺省图心，由 anchorX/anchorY 覆盖（刀剑给刀柄）——每帧由 syncAttachments 施加
    view.anchor.set(0.5, 0.5);
    this.socketAttachViews.set(key, view);
    let flame: { view: Sprite; frames: Texture[]; params: null } | undefined;
    if (flameFrames && flameFrames.length > 0) {
      // 帧动画火苗：格底中点当锚（火从起火点往上长），不吃光（自发光）；参数由挂件系统逐帧推
      const fv = new Sprite(flameFrames[0]);
      fv.anchor.set(0.5, 1);
      this.socketFlameViews.set(key, fv);
      flame = { view: fv, frames: flameFrames, params: null };
    }
    const texW = textures[0].frame.width;
    sprite.attachToSocket(socket, {
      view,
      frameTextures: textures.length > 1 ? textures : undefined,
      scale: burnTemplate && texW > 0
        ? (burnableWorldSize(burnTemplate).width / texW) * (resolved.scale ?? 1)
        : resolved.scale,
      mirrorWithHost: resolved.mirror,
      anchorX: burnTemplate ? burnTemplate.grip.u : resolved.anchorX,
      anchorY: burnTemplate ? burnTemplate.grip.v : resolved.anchorY,
      rotationOffsetDeg: resolved.rotation,
      lit: resolved.lit,
      firePoint: resolved.firePoint ?? undefined,
      flame,
    });
  }

  /**
   * 帧动画火苗图集切帧（行优先；格尺寸由贴图推，见 `PropFlameDef`）。同一张图集同一种切法只切一次：
   * 切状态会整个重挂视图，不缓存就是每切一次状态造一批 Texture 包装。
   * 纹理源归 AssetManager；这里只持有切出来的包装，Game 销毁时一并收。失败只 warn、这件挂件没有火苗。
   */
  private async loadFlameFrames(flame: PropFlameDef): Promise<Texture[] | null> {
    const cacheKey = `${flame.image}|${flame.cols}|${flame.frames}`;
    const hit = this.flameFrameCache.get(cacheKey);
    if (hit) return hit;
    let tex: Texture;
    try {
      tex = await this.assetManager.loadTexture(flame.image);
    } catch (e) {
      console.warn(`attachToSocket: 火苗图集加载失败 ${flame.image}`, e);
      return null;
    }
    const cols = Math.max(1, flame.cols);
    const rows = Math.max(1, Math.ceil(flame.frames / cols));
    const fw = Math.floor(tex.width / cols);
    const fh = Math.floor(tex.height / rows);
    if (!(fw > 0) || !(fh > 0)) {
      console.warn(`attachToSocket: 火苗图集 ${flame.image} 按 ${cols} 列 × ${rows} 行切不出格子（贴图 ${tex.width}×${tex.height}）`);
      return null;
    }
    const again = this.flameFrameCache.get(cacheKey);
    if (again) return again;
    const frames: Texture[] = [];
    for (let k = 0; k < flame.frames; k++) {
      frames.push(new Texture({
        source: tex.source,
        frame: new Rectangle((k % cols) * fw, Math.floor(k / cols) * fh, fw, fh),
      }));
    }
    this.flameFrameCache.set(cacheKey, frames);
    return frames;
  }

  /**
   * Action 入口：卸下挂件。手持挂件（引了预设的）连它的灯与效果一起收，
   * 纯贴图那条路只拆视图。两句都调是**有意的**：`detach` 对没登记的挂点是空操作，
   * 而视图拆除本身幂等 —— 少调任何一句都会留下半个挂件（有灯没图 / 有图没灯）。
   */
  private detachFromSocketFromAction(targetId: string, socket: string): void {
    this.heldPropSystem.detach(targetId, socket);
    this.detachSocketView(targetId, socket);
  }

  /** 只拆视图（挂件系统的回调走这条，不要回头再调 `detach`，那是死循环）。 */
  private detachSocketView(targetId: string, socket: string): void {
    this.spriteEntityOf(targetId)?.detachFromSocket(socket);
    this.destroySocketView(`${targetId}::${socket}`);
  }

  private destroySocketView(key: string): void {
    const flame = this.socketFlameViews.get(key);
    if (flame) {
      this.socketFlameViews.delete(key);
      // 帧纹理是缓存里共用的包装，只毁 Sprite 本身
      flame.destroy({ children: true });
    }
    const old = this.socketAttachViews.get(key);
    if (!old) return;
    this.socketAttachViews.delete(key);
    old.destroy({ children: true });
  }

  /** 切场景/销毁：挂件的显示对象归 Game 所有，必须自己收（SpriteEntity 只摘不毁）。 */
  private destroyAllSocketViews(): void {
    for (const key of [...this.socketAttachViews.keys()]) this.destroySocketView(key);
  }

  /** 切场景：只收场景实体（NPC）身上的挂件；玩家跨场景存活，它的挂件留着。 */
  private destroySceneSocketViews(): void {
    for (const key of [...this.socketAttachViews.keys()]) {
      if (key.startsWith('player::')) continue;
      this.destroySocketView(key);
    }
  }

  /** 事件 / Action：切换动画包与映射；加载失败则不打断当前化身。 */
  async applyPlayerAvatarFromAction(
    manifestPath: string,
    stateMap?: Record<string, string> | null,
    portraitSlug?: string | null,
  ): Promise<void> {
    const path = manifestPath.trim();
    if (!path) return;
    const loaded = await this.loadPlayerAvatarResources(path);
    if (!loaded) {
      console.warn('applyPlayerAvatar: 无法加载', path);
      return;
    }
    const sm =
      stateMap && Object.keys(stateMap).length > 0 ? stateMap : undefined;
    this.mountPlayerAvatar(loaded.texture, loaded.animDef, sm, path, true, portraitSlug, loaded.sockets);
  }

  /** 按 game_config.playerAvatar 恢复（与开局 setupPlayer 数据源一致）。 */
  async resetPlayerAvatarFromAction(): Promise<void> {
    const avatar = this.gameConfig.playerAvatar;
    const defaultManifest = '/resources/runtime/animation/player_anim/anim.json';
    const path = (avatar?.animManifest?.trim() || defaultManifest);
    await this.applyPlayerAvatarFromAction(path, avatar?.stateMap ?? null, avatar?.portraitSlug ?? null);
  }

  private async setupPlayer(options: { deferAvatar?: boolean } = {}): Promise<void> {
    const avatar = this.gameConfig.playerAvatar;
    const defaultManifest = '/resources/runtime/animation/player_anim/anim.json';
    const playerAnimPath = (avatar?.animManifest?.trim() || defaultManifest);

    if (options.deferAvatar) {
      const { texture, animDef } = this.placeholderPlayerAvatar();
      this.mountPlayerAvatar(texture, animDef, undefined, playerAnimPath, false, avatar?.portraitSlug);
      void (async () => {
        await this.assetManager.preloadManifest({
          scopeId: 'startup:player',
          refs: await this.buildAnimationManifestRefs(playerAnimPath, '玩家动画'),
        }, { mode: 'runtime', tolerateErrors: true });
        const loaded = await this.loadPlayerAvatarResources(playerAnimPath);
        if (!loaded || this.tearDownComplete || !this.renderer.isInitialized()) return;
        this.mountPlayerAvatar(
          loaded.texture, loaded.animDef, avatar?.stateMap, playerAnimPath, true,
          avatar?.portraitSlug, loaded.sockets,
        );
      })();
    } else {
      await this.assetManager.preloadManifest({
        scopeId: 'startup:player',
        refs: await this.buildAnimationManifestRefs(playerAnimPath, '玩家动画'),
      }, { mode: 'stage', tolerateErrors: true });
      const loaded = await this.loadPlayerAvatarResources(playerAnimPath);
      if (loaded) {
        this.mountPlayerAvatar(
          loaded.texture, loaded.animDef, avatar?.stateMap, playerAnimPath, true,
          avatar?.portraitSlug, loaded.sockets,
        );
      } else {
        const { texture, animDef } = this.placeholderPlayerAvatar();
        this.mountPlayerAvatar(texture, animDef, undefined, playerAnimPath, false, avatar?.portraitSlug);
      }
    }
    this.renderer.entityLayer.addChild(this.player.sprite.container);

    const playerPosGetter = () => ({ x: this.player.x, y: this.player.y });
    this.interactionSystem.setPlayerPositionGetter(playerPosGetter);
    this.zoneSystem.setPlayerPositionGetter(playerPosGetter);
  }

  /**
   * 热区 / 图对话 Action：停止指定 NPC 的巡逻（打断当前位移 +递增巡逻代，语义与对话里其它 action 顺序一致）。
   */
  stopNpcPatrol(npcId: string): void {
    const id = npcId?.trim();
    if (!id) return;
    const npc = this.sceneManager.getNpcById(id);
    npc?.cancelActiveMove();
    const cur = this.npcPatrolEpoch.get(id) ?? 0;
    this.npcPatrolEpoch.set(id, cur + 1);
  }

  /** 当前场景内重启巡逻：先 bump token 结束旧协程，再开新协程（与 scene:ready 规则一致） */
  private startNpcPatrolForNpc(npcId: string): void {
    const id = npcId?.trim();
    if (!id) return;
    const npc = this.sceneManager.getNpcById(id);
    if (!npc) {
      console.warn('startNpcPatrolForNpc: 当前场景无该 NPC', id);
      return;
    }
    const patrol = npc.def.patrol;
    if (!patrol?.route || patrol.route.length === 0) return;
    this.stopNpcPatrol(id);
    this.runNpcPatrol(npc, patrol.route, patrol.speed ?? 60, patrol.moveAnimState);
  }

  private async sleepWhileNpcPatrolPaused(npc: Npc, gen: number): Promise<void> {
    while (
      npc.isPatrolPausedForDialogue &&
      this.patrolGeneration === gen &&
      this.sceneManager.getCurrentNpcs().includes(npc)
    ) {
      await new Promise<void>(r => setTimeout(r, 40));
    }
  }

  private runNpcPatrol(
    npc: Npc,
    route: { x: number; y: number }[],
    speed: number,
    moveAnimState?: string,
  ): void {
    const gen = this.patrolGeneration;
    const npcId = npc.def.id;
    const tokenAtStart = this.npcPatrolEpoch.get(npcId) ?? 0;
    const patrolStoppedByAction = (): boolean =>
      (this.npcPatrolEpoch.get(npcId) ?? 0) !== tokenAtStart;

    // 相邻重复路点会产生零长度段：moveTo 立即返回 → 协程热转空耗（单路点 route 尤甚）。
    // 先去重（含 ping-pong 端点），只剩一个点则走到位后驻停，不进循环。
    const pts: { x: number; y: number }[] = [];
    for (const p of route) {
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 0.001) pts.push(p);
    }
    if (pts.length <= 1) {
      if (pts.length === 1) {
        // 巡逻要转身走：显式 faceTowardMovement（moveTo 不勾选＝完全不碰朝向）
        void npc.moveTo(pts[0].x, pts[0].y, speed, moveAnimState, true);
      }
      return;
    }

    const run = async () => {
      let i = 0;
      let step = 1;
      while (
        this.patrolGeneration === gen &&
        this.sceneManager.getCurrentNpcs().includes(npc)
      ) {
        if (patrolStoppedByAction()) break;
        await this.sleepWhileNpcPatrolPaused(npc, gen);
        if (this.patrolGeneration !== gen || !this.sceneManager.getCurrentNpcs().includes(npc)) {
          break;
        }
        if (patrolStoppedByAction()) break;
        await npc.moveTo(pts[i].x, pts[i].y, speed, moveAnimState, true);
        if (this.patrolGeneration !== gen || !this.sceneManager.getCurrentNpcs().includes(npc)) {
          break;
        }
        if (!npc.consumePatrolSkipWaypointAdvance()) {
          i += step;
          // ping-pong 掉头：跳过端点自身（pts.length ≥ 2），避免端点零长度 move 抖帧
          if (i >= pts.length) {
            i = pts.length - 2;
            step = -1;
          } else if (i < 0) {
            i = 1;
            step = 1;
          }
        }
      }
    };
    void run();
  }

  private setupSceneManager(): void {
    this.sceneManager.setPlayerPositionSetter((x, y) => {
      this.player.x = x;
      this.player.y = y;
    });

    this.sceneManager.setCameraSetter((boundsW, boundsH, snapX, snapY, cameraConfig, worldScale) => {
      this.camera.setBounds(boundsW, boundsH);
      if (cameraConfig?.pixelsPerUnit) {
        this.camera.setPixelsPerUnit(cameraConfig.pixelsPerUnit);
      }
      if (cameraConfig?.zoom) {
        this.camera.setZoom(cameraConfig.zoom);
      }
      // 场景基线缩放：过场 cameraZoom「恢复场景缩放」语义（scale 缺省/≤0）的回读源
      this.camera.setSceneBaseZoom(cameraConfig?.zoom ?? 1);
      // 进场景 = zoom 交回连续通道：上一行的 setZoom 会把它标成「显式占用」，不放开的话
      // 这个场景的相机跟随透视永远不生效（没配跟随的场景这句是纯 no-op）。
      this.camera.releaseZoomOverride();
      if (worldScale !== undefined) {
        this.camera.setWorldScale(worldScale);
      }
      this.setCameraAnchor(snapX, snapY);
      this.camera.snapTo(snapX, snapY);
    });
    this.sceneManager.setBoundsOnlySetter((boundsW, boundsH) => {
      this.camera.setBounds(boundsW, boundsH);
    });

    this.sceneManager.setAudioApplier((bgm, ambient, acousticSpace) => {
      this.audioManager.applySceneAudio(bgm, ambient);
      // 场景声学：换 IR。缺省/未知 id = 无空间，空间音退化为干声。
      this.audioManager.setAcousticSpace(acousticSpace);
      this.acousticSpaceId = acousticSpace ?? null;
      this.acousticListenerLast = null;
      this.updateAcousticListener(true);
      // 总线刚被换成场景绑定：工作台那份工作态若仍新鲜，下一拍重新套上
      this.acousticsSync?.onSceneChanged();
      // 换场景 = 实例整批重建：工作台那份工作态若仍新鲜，下一拍重新套上
      this.vfxSync?.onSceneChanged();
    });
    this.sceneManager.setAudioManifestResolver((bgm, ambient) => this.audioManager.getSceneAudioRefs(bgm, ambient));

    this.sceneManager.setZoneSetter((zones) => {
      this.zoneSystem.setZones(zones);
    });

    this.sceneManager.setInteractionSetter((hotspots, npcs) => {
      this.interactionSystem.setHotspots(hotspots);
      this.interactionSystem.setNpcs(npcs);
      /**
       * 脚步发声体跟着实体表一起换。
       *
       * 挂在这里而不是 `rebuildEntityShadows`：那条被 `isLightingEnabled` 门控，
       * 而背尸上山那六个场景根本没有光照载荷——挂错地方就是「在最需要它的关卡里静默没有」。
       * 本钩子既在场景装载时触发，也在过场重建实体时触发，与实体表的生命周期严格同步。
       */
      this.refreshFootstepEmitters();
    });

    // 过场重建 / 卸载实体时，先把其滤镜从深度系统的每帧驱动列表摘除再销毁，
    // 否则已 destroy 的滤镜仍被 updatePerFrame 引用（且热点滤镜此前根本不销毁，造成 GPU 泄漏）。
    this.sceneManager.setEntityFilterReleaser((filters) => {
      for (const f of filters) {
        this.sceneDepthSystem.removeFilter(f as Parameters<typeof this.sceneDepthSystem.removeFilter>[0]);
        f.destroy();
      }
    });

    /**
     * 演出中途生成 / 移除的实体（`playTrajectory.spawn`、`spawnRuntimeNpc`）：补上 `scene:ready`
     * 那一趟给场景 NPC 挂的**全部**东西。实例化本身只到"进实体层"为止，这四样一样都不在里面。
     *
     * 漏了不报错，只是画面不对：2026-09-12 实测铜钱轨迹 spawn 出来的 `curve_coin` filters 为空，
     * 按贴图原像素画（亮度 ~79，同位置受光的场景 NPC 只有 ~6），且该被木桶挡住的地方不被挡。
     * 移除侧**必须对称**销毁阴影 entry：`updateEntityShadows` 只驱动还在实体表里的实体，
     * 留下的 entry 会在地上冻成一坨鬼影，直到下次切场景才消失（见 [[teardown-ordering]]）。
     */
    this.sceneManager.setRuntimeNpcHooks({
      onSpawned: (npc) => {
        this.attachNpcSceneBits(npc);
        this.rebuildEntityShadowsForIds([npc.id], []);
        this.applyShadowAndAO();              // AO 广播补到刚建的滤镜上
        this.syncEntityPixelDensityMatch();   // 低通叠在 filters 之上，必须排在挂滤镜之后
      },
      onRemoved: (id) => {
        this.destroyEntityShadowEntry(id);
      },
    });

    this.sceneManager.setDepthLoader(async (sceneId, sceneData, worldToPixelX, worldToPixelY) => {
      if (sceneData.depthConfig) {
        const dc = sceneData.depthConfig;
        const mapPath = `resources/runtime/scenes/${sceneId}/${dc.depth_map}`;
        await this.sceneDepthSystem.load(
          sceneId, dc, this.assetManager,
          sceneData.worldWidth, sceneData.worldHeight,
          worldToPixelX, worldToPixelY,
        );
        const en = this.sceneDepthSystem.isEnabled;
        const dt = this.sceneDepthSystem.currentDepthTexture;
        this.logDepthDiag(
          `depthLoader ${sceneId}: enabled=${en} path=${mapPath} ` +
            `tex=${dt ? `${dt.width}x${dt.height} uid=${dt.uid} WHITE=${dt === Texture.WHITE}` : 'null'}`,
        );
        if (!en) {
          this.logDepthDiag(
            `depthLoader ${sceneId}: 深度纹理未加载成功时 F2 深度调试仍为占位白图，遮挡滤镜不会创建`,
          );
        }
        this.runDepthAndShaderGlDiagnostics(sceneId, dt, en);
      } else {
        this.sceneDepthSystem.loadDefault();
        this.logDepthDiag(`depthLoader ${sceneId}: 无 depthConfig，深度系统关闭`);
        const gl = tryGetWebGlFromApplication(this.renderer.app);
        if (!gl) {
          this.debugPanelUI?.log('[GL诊断] 无 WebGL 上下文（可能 WebGPU），跳过 getError');
        } else {
          drainWebGLErrorsToPanel(gl, (m) => this.debugPanelUI?.log(m), `${sceneId} 无depthConfig`);
        }
      }
      this.setupSceneLighting(sceneData, worldToPixelX, worldToPixelY);
      // 角色照明烘焙载荷:**必须 await 纳入加载门**——否则进度条/黑屏已撤,这批图集
      // 还在后台 fetch+解码,进场景后卡顿(哈希门失配自动禁用,内部 epoch 防旧时间线写回)。
      // 体素卷(RT gather 用,20–27MB/场景)不在此列:进场景恒不加载,F2 开 RT 时才现拉。
      // 烘焙按**当前生效的第一层背景**索引（背景与烘焙绑死）。缺 backgrounds 时
      // 退回 background.png，与旧数据同口径。
      const primaryBg = sceneData.backgrounds?.[0]?.image ?? 'background.png';
      await this.characterLighting.load(
        sceneId, sceneData.worldWidth, sceneData.worldHeight, primaryBg,
        this.geometryFallbackBackground(sceneData, primaryBg),
      );
      this.refreshPlayerWorldCollision();
    });

    // 统一光影（lighting-rebuild）。装载在 depthLoader **之后**——它要用深度纹理。
    // 场景没配 lighting 块、或没烘几何场载荷时安静地不启用，背景照旧走 Sprite。
    this.sceneManager.setLightingLoader(async (sceneId, sceneData, primary) => {
      const ok = await this.sceneLighting.load(sceneId, sceneData, this.assetManager, primary);
      if (!ok) return null;
      // ⚠ 顺序即正确性：先渲一次缓存（顺带建出 GI 反弹 RT），再接角色。
      //   反过来的话角色拿到的 `giBounceTexture` 是 null（RT 是懒建的），
      //   于是 GI 增益被压成 0 —— 表现为"这个场景没有反弹光"，而且不报错。
      //   这一次渲染本来也必须做：免得揭幕那一帧背景是空的。
      this.sceneLighting.update(this.renderer.app.renderer);
      // 角色侧的实体灯：与场景吃**同一次** packLights（2026-08-30「原画 + 加性灯」）。
      // 必须挂在这儿而不是 setupUnifiedCharacterLighting 里 —— 那个函数在统一角色路径
      // 停用后整体早退，放进去就是死代码（本次就踩过：日志一条不出）。
      this.characterLighting.applyDisplay(this.sceneLighting.params?.display ?? null);
      this.characterLighting.applyLightFactors(this.sceneLighting.params?.lightFactors);
      this.characterLighting.applyLights(
        this.sceneLighting.packedLights ?? null, this.sceneLighting.wuPerQUnit);
      this.setupUnifiedCharacterLighting();
      // 草木摆动（打光场景）：背景已换成点亮的网格，SceneManager 那一步会跳过；在这里接。
      // ⚠ 风也要在这里重设——原先只有不打光那条路重设风，打了光的场景粒子会接着吃上一个场景的风。
      this.sceneWind.reset(sceneData.wind);
      this.swayPrimary = primary;
      this.swayReadySceneId = null;                 // 装完（scene:ready）之前不收草木推送
      this.swaySync?.resetSeen();
      try {
        await this.buildSway(sceneId, sceneData, primary, undefined, 'lit');
      } catch (e) {
        console.warn('[sway] 打光场景的草木装载失败，草木不动', e);
      }
      if (!this.swayBackground) this.reportForegroundWithoutSway(sceneId, sceneData);
      return this.sceneLighting.backgroundMesh;
    });
    this.sceneManager.setLightingUnloader(() => {
      // 前景层最先拆：它的前景片借着点亮背景的纹理与参数组、覆盖图绑在遮挡滤镜上
      this.teardownForegroundLayers();
      // 换场景 = 同步基线作废（新场景的第一份内容不是"已对齐"）
      this.lightingSync?.resetBaseline();
      // 角色 / 粒子那组实体灯与显示变换退回恒等。上面的装载器只在场景**有** lighting 块时才重写它，
      // 不清的话下一个没配 lighting 的场景（崖墓 / 跑马梁）会接着用上一个场景的灯与 wuPerQUnit——
      // 2026-09-12 实测：义庄 → 崖墓前段后仍是义庄那 1 盏烛火、220 wu/q（崖墓前段是 309）。
      this.characterLighting.applyDisplay(null);
      this.characterLighting.applyLightFactors(undefined);
      this.characterLighting.applyLights(null);
      // 顺序：先拆角色（它的 shader 绑着场景的深度/网格纹理），再卸场景
      this.unifiedCharLighting.teardown();
      this.sceneLighting.unload();
    });

    // 背景草木摆动（场景风 + 摆动图）：背景没点亮时由这里换成摆动 mesh；缺风 / 缺图就不摆。
    // 风在这里就按新场景重设——装载期间摆动 mesh 已经在画，别让它吃上一个场景的风。
    this.sceneManager.setSwayLoader(async (sceneId, sceneData, primary) => {
      this.swayReadySceneId = null;                 // 装完（scene:ready）之前不收草木推送
      this.sceneWind.reset(sceneData.wind);
      this.swayPrimary = primary;
      this.swaySync?.resetSeen();
      const root = await this.buildSway(sceneId, sceneData, primary);
      if (!root) this.reportForegroundWithoutSway(sceneId, sceneData);
      return root;
    });
    // 与光影同一拍：先于背景容器与纹理拆（绑着原画 / 深度 / 摆动图三张按场景走的纹理）
    this.sceneManager.setSwayUnloader(() => {
      // 前景层先拆（绑着位移图与 id / matte，覆盖图绑在遮挡滤镜上）
      this.teardownForegroundLayers();
      // ⚠ 先解绑再销毁：打光的背景读着位移图（BindGroup 见死即自毁，pixi-v8-traps）
      if (this.swayLit) this.sceneLighting.detachSway();
      this.swayLit = false;
      this.swayBackground?.destroy();
      this.swayBackground = null;
      for (const u of this.swayTexUrls) this.assetManager.dropTexture(u);
      this.swayTexUrls = [];
      this.swayPrimary = null;
      this.swayReadySceneId = null;
      this.swaySync?.resetSeen();
      this.sceneWind.reset(null);
    });

    this.sceneManager.setDepthUnloader(() => {
      if (this.probeVizGfx) { this.probeVizGfx.destroy(); this.probeVizGfx = null; }
      // 顺序即正确性：**先拆掉所有引用照明载荷纹理的东西，最后才销毁载荷**。
      // 影子现在也持有行走面场纹理(逐像素取地面)，若沿用旧顺序先 destroy 载荷，
      // 残留影子会在下一次绑定时拿到已销毁的 TextureSource → style 为 null 直接崩。
      // NPC/热区滤镜已在场景卸载更早处销毁；此处经 unload() 清空系统滤镜表。
      this.sceneDepthSystem.unload();
      this.player.sprite.container.filters = [];
      this.playerDepthFilter = null;
      this.clearEntityShadows();
      // 调试可视化滤镜是**跨场景长活**的，不在上面几行的清扫范围内，却绑着按场景销毁的
      // 载荷纹理。Pixi 的 BindGroup 见到所绑资源 destroyed 会把自己作废，之后读写即抛——
      // 抛点正好在下一张场景的 onReady 里，会把整份照明载荷带走。故销毁载荷前必须解绑。
      this.depthDebugVisualizer?.unbindSceneTextures();
      this.characterLighting.destroy();   // 清载荷+涨 epoch,拦截在途加载写回(律4)
      this.refreshPlayerWorldCollision();
      if (this.currentProbe) {
        this.currentProbe.destroy(true);
        this.currentProbe = null;
      }
      this.currentLightEnv = null;
      this.currentLightCurve = null;
      this.currentShadowField = null;
    });

    this.sceneManager.setSceneEnterRunner(async (actions) => {
      const sceneId = this.sceneManager.currentSceneData?.id ?? '';
      // 线程化的 scene owner 是权威通道（批内动作按参数拿到，不受交错影响）；
      // ambientNarrativeOwner 只留给 onEnter 期间条件里的 `@owner`/`@scene` token
      // ——条件上下文工厂是零参共享的，够不到线程化上下文。两者取值刻意保持一致。
      this.ambientNarrativeOwner = sceneId ? { ownerType: 'scene', ownerId: sceneId } : null;
      try {
        await this.actionExecutor.executeBatchAwait(actions, makeOwnerOrigin('scene', sceneId));
      } finally {
        this.ambientNarrativeOwner = null;
      }
    });
  }

  /** 深度图、热区与 NPC 多边形碰撞合并（已拾取/失效的热区不参与；不可见 NPC 不参与） */
  private refreshPlayerWorldCollision(): void {
    this.player.setDepthCollision((wx, wy) => {
      if (this.sceneDepthSystem.isCollision(wx, wy)) return true;
      for (const h of this.sceneManager.getCurrentHotspots()) {
        if (!h.active) continue;
        const worldPoly = hotspotCollisionPolygonToWorld(h.def, h.depthScaleFactor);
        if (worldPoly && isValidZonePolygon(worldPoly) && isPointInPolygon(worldPoly, wx, wy)) return true;
      }
      for (const n of this.sceneManager.getCurrentNpcs()) {
        if (!n.container.visible) continue;
        const worldPoly = npcCollisionPolygonToWorld(n);
        if (worldPoly && isValidZonePolygon(worldPoly) && isPointInPolygon(worldPoly, wx, wy)) return true;
      }
      return false;
    });
  }

  /**
   * 场景加载时配置逐 entity 光照：解析光照环境、按背景建辐照度探针、启用光照系统。
   * 总开关关闭或上一探针存在时先清理。需在 depth load/loadDefault 之后调用（共享 sceneW/worldToPixel）。
   */
  /**
   * 把角色接进统一光影。两半几何各有各的真相源，在这里合成：
   * · 场景那一半（深度场标定 / M / 3D 网格边界 / 深度纹理）← SceneLightingSystem
   * · 角色那一半（work px 标定 / ground 深度场）           ← CharacterLightingSystem
   *
   * 任一半缺料就不启用，实体回落 probe 路径。**必须在 sceneLighting.load 成功之后调**。
   */
  private setupUnifiedCharacterLighting(): void {
    // ⛔ 2026-08-30 起**整条统一角色路径停用**，所有场景一律走 probe + 加性灯。
    //
    // 理由：制作人定调「原画就是最终的光照」，场景侧已去掉整体重打光。统一角色 shader
    // 的环境项是**合成天光 × 天穹可见性**——那是给"重打光后的场景"配套的，原画不再被
    // 重打光之后它不对应任何东西。角色的底光只能来自 probe（同一张原画烘出来的 GI），
    // 灯在其上加性叠加（见 CharacterLitSprite 的实体灯段）。
    //
    // 保留这个函数与 UnifiedCharacterLighting 的代码不删：统一光影那套的几何半
    // （3D 天穹网格、GI 反弹）后面可能还要用，等日夜整条线跑通再决定去留。
    if (!UNIFIED_CHAR_PATH_ENABLED) {
      this.unifiedCharLighting.teardown();
      this.rebuildEntityLitShaders();
      return;
    }
    if (this.sceneLighting.params?.placeholder) {
      this.unifiedCharLighting.teardown();
      this.rebuildEntityLitShaders();
      return;
    }
    const half = this.sceneLighting.characterGeometryHalf;
    const charGeo = this.characterLighting.unifiedGeometry;
    const skyGrid = this.sceneLighting.skyVisibilityTexture;
    if (!half || !charGeo || !skyGrid) {
      this.unifiedCharLighting.teardown();
      return;
    }
    this.unifiedCharLighting.setup({
      worldToWork: charGeo.worldToWork,
      cal: charGeo.cal,
      groundRange: charGeo.groundRange,
      sceneWorld: charGeo.sceneWorld,
      depthSize: half.depthSize,
      depthCal: half.depthCal,
      depthMapping: half.depthMapping,
      mRows: half.mRows,
      // 铁律 0：光照的长度一律 wu ⇒ shader 里 P = R·q × wuPerQUnit
      wuPerQUnit: this.sceneLighting.wuPerQUnit,
      grid: half.grid,
    }, {
      ground: charGeo.ground,
      skyGrid,
      giBounce: this.sceneLighting.giBounceTexture,
      depth: half.depth,
    });

    const def = this.sceneLighting.params;
    const packed = this.sceneLighting.packedLights;
    this.characterLighting.applyLights(packed ?? null, this.sceneLighting.wuPerQUnit);
    if (def && packed) {
      this.unifiedCharLighting.applyParams(
        def, packed, this.sceneLighting.wuPerQUnit, this.sceneLighting.radianceScale);
    }
    // 已经在场上的实体（玩家/NPC）是在 lighting 装载**之前**建的 shader，
    // 那时统一光影还没启用，它们拿到的是旧路径的 shader —— 必须重建一遍，
    // 否则「场景变了角色没变」正是制作人最不能接受的那种不一致。
    this.rebuildEntityLitShaders();
  }

  /**
   * 改场景光照参数的**唯一入口**。场景与角色在同一次调用里一起更新——
   * 分两处调就迟早有一处漏掉，那时角色与背景会在某些参数上分家。
   */
  /**
   * 交给编辑器的当前场景光照。**只读，不碰磁盘**。
   *
   * 落盘这件事 2026-08-21 起整个收回桌面编辑器：游戏侧不再有任何写场景 JSON 的通道，
   * 由编辑器在场景页点「从运行时拉取灯位」把这份拿走、入脏，人再按 Save All 落盘
   * （`save_all` 是工程唯一写盘出口）。这样"编辑器开着 + 游戏也在写"的互相覆盖从根上没了。
   *
   * ⚠ 先退独奏再交：独奏（只亮一盏）是**临时视图状态**，不退就等于把"其余灯全关"
   * 当成作者意图交出去。这与从前存回按钮的做法一致（那时也是先 `applySolo(null)`）。
   */
  private getSceneLightingForEditor(): { sceneId: string; lighting: SceneLightingDef } | null {
    const sceneId = this.sceneManager.currentSceneData?.id;
    const raw = this.sceneLighting.params;
    if (!sceneId || !raw) return null;
    const lighting = this.lightingSyncHooks?.exportFixup(raw) ?? raw;
    // 结构化克隆经 QWebEngine 回到 Python 侧；直接交内部对象等于把运行时状态借出去
    return { sceneId, lighting: JSON.parse(JSON.stringify(lighting)) as SceneLightingDef };
  }

  /**
   * 运行时摆灯要的坐标换算几何。凑不齐（没配 lighting / 没烘载荷 / 没有行走面场）返回 null，
   * 调用方据此把入口灰掉并说明原因——不做"猜一个深度"的降级。
   *
   * ⚠ 全部取 **work** 栅格（照明载荷的 `cal` 与地面场），不是 `depthConfig.M` 那套 native。
   * 两套栅格的比例逐场景不同（实测 1.95–4.0），混用不报错、只是位置差一截。
   */
  /**
   * 声音用的场景几何：**只要照明载荷在**（行走面场 + det=+1 基 + work 标定）就有，
   * 不要求统一光影启用——六个崖墓场景 / 跑马梁没配 `lighting` 块，脚步与回音照样要落到真地面
   * （2026-09-08 实测：按 `sceneLighting.active` 门控会把这些场景全打回平面近似，听者 z 差 800 wu）。
   * 1 q = 多少 wu 用 `worldWidth × ppu_work / work.w`，与工作台同一条式子（逐点 Δ0）。
   */
  private buildAudioSceneGeometry(): SceneSpaceGeometry | null {
    const ground = this.characterLighting.groundDepthField;
    const rows = this.characterLighting.shadowBasisRows;
    const uni = this.characterLighting.unifiedGeometry;
    if (!ground || !rows || !uni) return null;
    const wuPerQUnit = (uni.sceneWorld[0] * uni.cal.ppu) / Math.max(ground.w, 1);
    if (isSuspectWuPerQUnit(wuPerQUnit)) return null;
    return {
      work: { w: ground.w, h: ground.h },
      cal: { ppu: uni.cal.ppu, cx: uni.cal.cx, cy: uni.cal.cy },
      sceneWorld: { w: uni.sceneWorld[0], h: uni.sceneWorld[1] },
      basisRows: rows,
      wuPerQUnit,
      ground,
    };
  }

  /**
   * 时段原画没有自己的烘焙目录时，几何项（行走面 / 标定）能不能借主背景那份——**只看深度图换没换**：
   * 行走面与深度图是同一次烘焙的成对产物；时段变体只换了原画、深度沿用白天那张（崖墓 / 跑马梁的夜
   * 都是这样），几何就没变。深度图换了（变体自带 depthConfig）就不借，返回 undefined。
   * 光照项不在这里讨论：`CharacterLightingSystem.loadGeometryOnly` 一概不借。
   */
  private geometryFallbackBackground(sceneData: SceneData, primaryBg: string): string | undefined {
    const base = this.sceneManager.baseAppearance;
    if (!base || base.primaryBackgroundImage === primaryBg) return undefined;
    if (JSON.stringify(base.depthConfig ?? null) !== JSON.stringify(sceneData.depthConfig ?? null)) return undefined;
    return base.primaryBackgroundImage;
  }

  /**
   * 粒子 / 群体的模拟空间。有照明载荷（行走面场 + det=+1 基 + work 标定）就是真 3D：
   * 地面 = 行走面反投影的高度场，墙 = 深度壳的 CPU 副本；没有就退到平面近似（不遮挡、不受光、没墙）。
   * 与音频侧同一份 `SceneSpaceGeometry`，不另立换算。
   */
  /** 装一次拆层（进场景、以及工作台重烘后的原地重装走同一条） */
  private async buildSway(
    sceneId: string, sceneData: SceneData, primary: Texture, cacheBust?: string,
    mode: 'composite' | 'lit' = 'composite',
  ): Promise<Container | null> {
    const dc = sceneData.depthConfig;
    if (!this.sceneWind.params || !dc) return null;
    const bg = sceneData.backgrounds?.[0]?.image ?? 'background.png';
    // DEV：草木工作台「推给游戏」推来的预览（页面上此刻那份，烘在本机，资源没动）——这一局里没导出之前一直用它
    const preview = import.meta.env.DEV ? this.swaySync?.previewFor(sceneId) ?? null : null;
    if (preview) this.debugPanelUI?.log(`[sway] ${sceneId} 用的是草木工作台推来的预览（第 ${preview.rev} 次，还没导出到资源）`);
    // 缓存戳：原地重装给的那个；否则这一局里推过（预览或导出）这个场景就带最近那次 rev。
    // ⚠ 导出之后不带戳的话，走出场景再进来 JSON 桶按旧 URL 还回导出之前的 sway.json、配上新读的 id 图（#28）
    const bust = cacheBust
      ?? (preview ? String(preview.rev) : (import.meta.env.DEV ? this.swaySync?.bustFor(sceneId) : undefined));
    const inp = await loadBackgroundSwayInput(this.assetManager, sceneData, {
      bakeDir: preview ? swayPreviewDirUrl(sceneId, bakeKeyFromBackground(bg)) : sceneBakeDirUrl(sceneId, bg),
      depth: sceneRuntimeAssetUrl(sceneId, dc.depth_map),
      cacheBust: bust,
    }, (m) => { if (import.meta.env.DEV) console.warn(`[sway] ${sceneId}: ${m}`); this.debugPanelUI?.log(`[sway] ${m}`); });
    if (!inp) return null;
    if (mode === 'lit' && !inp.litPlate) {
      const msg = '打光场景缺补图（sway_plate_normal / albedo / depth），草木不接——重跑 sway_field';
      if (import.meta.env.DEV) console.warn(`[sway] ${sceneId}: ${msg}`);
      this.debugPanelUI?.log(`[sway] ${msg}`);
      return null;
    }
    // ⚠ 换之前先解绑：前景层与打光的背景都读着旧的位移图
    this.teardownForegroundLayers();
    if (this.swayLit) this.sceneLighting.detachSway();
    this.swayBackground?.destroy();
    this.swayBackground = new SwayBackground(primary, inp, { composite: mode === 'composite' });
    this.swayLit = mode === 'lit';
    if (mode === 'lit' && inp.litPlate) {
      const ok = this.sceneLighting.attachSway({
        uvMap: this.swayBackground.uvMap, plate: inp.plateTex,
        normal: inp.litPlate.normal, albedo: inp.litPlate.albedo, depth: inp.litPlate.depth,
      });
      if (!ok) {
        this.teardownForegroundLayers();
        this.swayBackground.destroy();
        this.swayBackground = null;
        this.swayLit = false;
        return null;
      }
    }
    this.swayBackground.update(this.sceneWind.params, this.sceneWind.time, this.sceneWind.blasts, this.sceneWind.blastTime);
    // 上一份（`?v=` 不同的同几张图）连同显存丢掉：不丢的话推一次漏一套，几十张 4 MB 的底板能把缓存挤爆
    const stale = this.swayTexUrls.filter((u) => !inp.urls.includes(u));
    for (const u of stale) this.assetManager.dropTexture(u);
    this.swayTexUrls = inp.urls.slice();
    // 进场景时按推送的缓存戳装上的也算"游戏换上了"（原地重装那条由 RuntimeSwaySync 自己记）
    if (import.meta.env.DEV && bust && cacheBust === undefined) this.swaySync?.noteApplied(sceneId, Number(bust));
    // 前景层按这一份拆层解析（草木工作台推来的预览 id 图会换，所以每次装拆层都重建）
    this.buildForegroundLayers(sceneId, sceneData);
    return this.swayBackground.root;
  }

  /**
   * 建本场景的前景图层（[[scene-foreground-layers]]）。要求草木拆层已装上（swayPlant 按它的 id 图解析实例、
   * 覆盖图网格由它出）与行走面深度场（接地深度从它取）。解析不了的层逐条说出来、跳过；一层都没有就不建。
   */
  private buildForegroundLayers(sceneId: string, sceneData: SceneData): void {
    this.teardownForegroundLayers();
    const sb = this.swayBackground;
    if (!sb || !sceneData.foregroundLayers?.length) return;
    const say = (m: string) => {
      if (import.meta.env.DEV) console.warn(`[foreground] ${sceneId}: ${m}`);
      this.debugPanelUI?.log(`[foreground] ${m}`);
    };
    const defs = normalizeForegroundLayerDefs(sceneData.foregroundLayers, say);
    const src = sb.foregroundSource;
    const layers = resolveForegroundLayers(defs, src, say);
    if (layers.length === 0) return;
    const fg = new SceneForegroundLayers({
      layers,
      maskHost: sb,
      paintSize: src.paintSize,
      sceneSize: src.sceneSize,
      displacementOf: (id) => sb.instanceDisplacement(id),
      depthModel: this.sceneDepthSystem.foregroundDepthModel(),
      // 覆盖图交给 / 收回：实体滤镜与粒子**同一拍**换绑（收回时两边都先绑回占位，前景层才销毁 RT）
      onCoverage: (tex) => {
        this.sceneDepthSystem.setForegroundCoverage(tex);
        this.vfxRenderer?.setForegroundCoverage(tex?.source ?? null);
      },
      log: say,
    });
    if (fg.layerCount === 0) { fg.destroy(); return; }
    this.foregroundLayers = fg;
    if (!this.foregroundEnabled) fg.setEnabled(false);
    if (this.foregroundCoverageView) {
      fg.setCoverageView(true, this.renderer.worldContainer, [sceneData.worldWidth, sceneData.worldHeight]);
    }
    this.debugPanelUI?.log(`[foreground] ${sceneId}：前景层 ${fg.layers.map((l) => `${l.label}（株 ${l.instId}，接地 ${l.baseLine ? `折线 ${l.baseLine.length} 点` : `(${l.baseX.toFixed(0)}, ${l.baseY.toFixed(0)})`}）`).join('、')}`);
  }

  /** 拆前景层：先让遮挡的使用方绑回占位（持有者自己在 destroy 里先广播 null），再销毁覆盖图 */
  private teardownForegroundLayers(): void {
    this.foregroundLayers?.destroy();
    this.foregroundLayers = null;
  }

  /** 场景配了前景层、却没接上草木拆层（没风 / 没拆层 / 版本旧）：swayPlant 解析不了，说一次 */
  private reportForegroundWithoutSway(sceneId: string, sceneData: SceneData): void {
    const n = sceneData.foregroundLayers?.length ?? 0;
    if (!n) return;
    const msg = `${sceneId} 配了 ${n} 层前景，但本场景没接上草木拆层（没配风 / 没烘 sway / 版本旧）——swayPlant 前景层全部跳过`;
    if (import.meta.env.DEV) console.warn(`[foreground] ${msg}`);
    this.debugPanelUI?.log(`[foreground] ${msg}`);
  }

  /**
   * DEV：地形工作台推给游戏 / 导出到游戏之后 → 原地换碰撞（位图 + 旁挂 + 影子裁切纹理）与行走面（ground_d + 区间），
   * 不切场景、玩家不动。预览从 dev server 的预览口装（`terrainPreviewDirUrl`），导出从资源装；两种都带 `?v=<rev>`。
   * 行走面换上之后把依赖它的都拨一遍：深度系统的地面场、玩家碰撞闭包、听者、粒子空间、F2 可视化——与载荷落地时那一段同序。
   */
  private async reloadTerrainInPlace(cacheBust: string): Promise<boolean> {
    const sceneData = this.sceneManager.currentSceneData;
    const sceneId = sceneData?.id;
    const dc = sceneData?.depthConfig;
    if (!sceneId || !dc || !this.sceneDepthSystem.isEnabled) return false;
    const preview = this.terrainSync?.previewFor(sceneId) ?? null;
    const v = `?v=${encodeURIComponent(cacheBust)}`;
    const colDir = preview ? terrainPreviewDirUrl(sceneId) : sceneRuntimeAssetUrl(sceneId, 'collision.json').replace(/\/collision\.json$/, '');
    const say = (m: string) => { if (import.meta.env.DEV) console.warn(`[terrain] ${sceneId}: ${m}`); this.debugPanelUI?.log(`[terrain] ${m}`); };
    const getJson = async (url: string): Promise<Record<string, unknown> | null> => {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok || !(r.headers.get('content-type') ?? '').toLowerCase().includes('json')) return null;
      return await r.json() as Record<string, unknown>;
    };
    const sidecar = await getJson(`${colDir}/collision.json${v}`) as (CollisionSidecar | null);
    if (!sidecar || typeof sidecar.grid_width !== 'number') { say(`${preview ? '预览目录' : '资源'}里没有 collision.json，换不上`); return false; }
    const pngUrl = `${colDir}/${sidecar.collision_map || dc.collision_map || 'collision.png'}${v}`;
    const resp = await fetch(pngUrl, { cache: 'no-store' });
    if (!resp.ok) { say(`碰撞图取不到：${pngUrl}（HTTP ${resp.status}）`); return false; }
    const bmp = await createImageBitmap(await resp.blob());
    let tex: Texture | null = null;
    try { tex = await this.assetManager.loadTexture(pngUrl); } catch { tex = null; }
    if (this.sceneManager.currentSceneData?.id !== sceneId) return false;     // 等图的时候换了场景
    this.sceneDepthSystem.replaceCollision(bmp, sidecar, tex);
    this.refreshPlayerWorldCollision();
    if (preview) say(`碰撞用的是地形工作台推来的预览（第 ${preview.rev} 次，还没导出到资源）`);
    // 行走面：按当前装着的烘焙目录（时段原画各一份）取同名目录里的 ground_d
    const bakeBase = this.characterLighting.currentBakeBase;
    if (bakeBase) {
      const key = bakeBase.split('/').filter(Boolean).pop() ?? '';
      const gdir = preview ? `${terrainPreviewDirUrl(sceneId)}/ground/${encodeURIComponent(key)}` : bakeBase;
      let range: { min: number; max: number } | null = null;
      try {
        if (preview) {
          const m = await getJson(`${gdir}/ground_d.json${v}`);
          if (m && typeof m.min === 'number' && typeof m.max === 'number') range = { min: m.min, max: m.max };
        } else {
          const m = await getJson(`${gdir}/lighting.json${v}`);
          const gd = m?.ground_d as { min?: number; max?: number } | undefined;
          if (gd && typeof gd.min === 'number' && typeof gd.max === 'number') range = { min: gd.min, max: gd.max };
        }
      } catch (e) { say(`行走面区间读不到：${String((e as Error)?.message ?? e)}`); }
      if (range) {
        const ok = await this.characterLighting.replaceGround(`${gdir}/ground_d.png${v}`, range);
        if (ok && this.sceneManager.currentSceneData?.id === sceneId) {
          this.sceneDepthSystem.setGroundDepthField(this.characterLighting.groundDepthField, this.characterLighting.groundDepthTexture);
          this.foregroundLayers?.refreshBase(this.sceneDepthSystem.foregroundDepthModel());
          this.refreshPlayerWorldCollision();
          this.updateAcousticListener(true);
          this.vfxSystem.onSpaceMaybeChanged();
          try { this.depthDebugVisualizer?.setGroundTexture(this.characterLighting.groundDepthTexture); } catch { /* 调试链路失手不连坐 */ }
        } else if (!ok) say('行走面没换上（尺寸不对或取不到），碰撞已换');
      } else say(`${preview ? '预览' : '资源'}里没有 ${key} 的行走面区间，只换了碰撞`);
    }
    return true;
  }

  /** 地形工作台的运行时对齐探测：用游戏自己的 isCollision 判一批画面点，回 0/1 串 + 当前网格声明 */
  private probeTerrainCollision(points: Array<[number, number]>): { blocked: string; grid: unknown } | null {
    if (!this.sceneDepthSystem.isEnabled) return null;
    const grid = this.sceneDepthSystem.collisionGrid;
    if (!grid) return null;
    let s = '';
    for (const p of points) s += this.sceneDepthSystem.isCollision(Number(p[0]), Number(p[1])) ? '1' : '0';
    return { blocked: s, grid };
  }

  /**
   * DEV：草木工作台推给游戏 / 导出到游戏之后 → 原地把拆层换掉（不切场景、玩家不动）。
   * 新的 root 要插回**旧 root 原来的位置**，否则草木会跑到实体层前面 / 后面去。
   */
  private async reloadSwayInPlace(cacheBust: string): Promise<boolean> {
    const sceneId = this.sceneManager.currentSceneData?.id;
    const sceneData = this.sceneManager.currentSceneData;
    const primary = this.swayPrimary;
    if (!sceneId || !sceneData || !primary) return false;
    if (!this.sceneWind.params) {
      // 没配风：buildSway 静默返回 null（进场景时不报是对的），原来推送这条路游戏日志只剩"装不上（看上面的原因）"、上面一个字没有
      const msg = `${sceneId} 没配风（场景 JSON 的 wind），推来的草木不会动`;
      if (import.meta.env.DEV) console.warn(`[sway] ${msg}`);
      this.debugPanelUI?.log(`[sway] ${msg}`);
      return false;
    }
    if (this.swayLit) {
      // 打光场景：位移图由点亮的背景读，场景树里没有草木的节点可插
      if (await this.buildSway(sceneId, sceneData, primary, cacheBust, 'lit')) return true;
      return this.dropSwayIfResourcesHaveNone(sceneId, primary);
    }
    const old = this.swayBackground?.root ?? null;
    const parent = old?.parent ?? null;
    if (!parent) return this.attachFirstSwayInPlace(sceneId, sceneData, primary, cacheBust);
    const index = parent.getChildIndex(old!);
    const root = await this.buildSway(sceneId, sceneData, primary, cacheBust);
    if (!root) return this.dropSwayIfResourcesHaveNone(sceneId, primary);
    parent.addChildAt(root, swayInsertIndex(index, parent.children.length));
    return true;
  }

  /**
   * 原地重装没装上、而这次是按**资源**装的（这个场景没有推送的预览）⇒ 资源里就是没有可用的草木层
   * （没导出过 / 版本旧 / 一株都没有 / 打光缺补图；纹理读失败会抛、不走这里）。游戏要与资源一致：拆掉挂着的层，合成模式把主背景露回来。
   * 否则：新场景推给游戏（预览挂上）→ 工作台里「不保存」放弃 → 撤回预览发导出行 → 旧层留着接着摆，工作台却说撤掉了。
   * 按预览装不上（预览目录缺料）⇒ 旧层留着、照旧报装不上。
   */
  private dropSwayIfResourcesHaveNone(sceneId: string, primary: Texture): boolean {
    if (import.meta.env.DEV && this.swaySync?.previewFor(sceneId)) return false;
    if (this.sceneManager.currentSceneData?.id !== sceneId || this.swayPrimary !== primary || !this.swayBackground) return false;
    const wasLit = this.swayLit;
    // ⚠ 先解绑再销毁（与装载钩子的拆法同序）：前景层 → 点亮的背景 → 拆层
    this.teardownForegroundLayers();
    if (wasLit) this.sceneLighting.detachSway();
    this.swayLit = false;
    this.swayBackground.destroy();
    this.swayBackground = null;
    for (const u of this.swayTexUrls) this.assetManager.dropTexture(u);
    this.swayTexUrls = [];
    // 打光场景的主背景本来就由点亮的网格顶替着，不动它；合成模式装载时藏起了主背景，还回去
    if (!wasLit) {
      const host = findSwayHostSprite(this.renderer.backgroundLayer, primary);
      if (host) host.renderable = true;
    }
    this.debugPanelUI?.log(`[sway] ${sceneId}：资源里没有可用的草木层，挂着的那层已拆掉（与资源一致）`);
    return true;
  }

  /**
   * 原地重装、但场景树里**没有旧草木层**：进场景那次没装上（资源里还没导出过 / `sway.json` 版本旧 ⇒ `buildSway` 返回 null，
   * 装载钩子什么都没插）。原来照走"替换旧层"那条：新层建好了挂不到树上、主背景 Sprite 照样露着，
   * 却返回 true——游戏日志「已原地换上」、工作台「✔ 游戏里已换上」，画面一株不动，每推一次都一样，直到走出去再进来；
   * 打光场景还建成了合成模式的层。现在按装载时的规矩接：
   * - 背景已经点亮（光照网格在树上）⇒ 按打光模式建（位移图交给点亮的背景读，树里不插节点）；
   * - 否则找到主背景那张 Sprite，插在它的位置上并藏起它（与 `SceneManager` 装载那步同一个做法）；
   * - 两样都做不到 ⇒ 不建（免得留一个看不见、却还在给纸钱喂 `offsetAt` 的层），返回 false 如实报装不上。
   */
  private async attachFirstSwayInPlace(
    sceneId: string, sceneData: SceneData, primary: Texture, cacheBust: string,
  ): Promise<boolean> {
    const litMesh = this.sceneLighting.backgroundMesh;
    if (litMesh?.parent) {
      return !!(await this.buildSway(sceneId, sceneData, primary, cacheBust, 'lit'));
    }
    if (!findSwayHostSprite(this.renderer.backgroundLayer, primary)) {
      this.debugPanelUI?.log(`[sway] ${sceneId}：场景树里找不到主背景，推来的草木层没处接`);
      return false;
    }
    const root = await this.buildSway(sceneId, sceneData, primary, cacheBust);
    if (!root) return false;
    // 建的这一拍里场景可能已经换了 / 背景被拆了：插之前再找一次
    const host = findSwayHostSprite(this.renderer.backgroundLayer, primary);
    const hostParent = host?.parent ?? null;
    if (!host || !hostParent || this.sceneManager.currentSceneData?.id !== sceneId) {
      // 只拆自己刚建的这份（这期间新场景的装载可能已经换上了它自己的）
      if (this.swayBackground?.root === root) {
        this.teardownForegroundLayers();
        this.swayBackground.destroy();
        this.swayBackground = null;
      }
      return false;
    }
    hostParent.addChildAt(root, hostParent.getChildIndex(host));
    host.renderable = false;
    return true;
  }

  private buildVfxSpace(): VfxSpace {
    const geo = this.buildAudioSceneGeometry();
    // 透视度量按用时取（句柄在 scene:ready 才建，空间可能先建）：与实体同一根透视轴
    const perspective = (x: number, y: number) => this.perspectiveScaleResolver?.scaleAt(x, y) ?? 1;
    if (!geo) return createPlanarVfxSpace(this.footstepConfig?.spatial?.planarDepthScale ?? DEFAULT_PLANAR_DEPTH_SCALE, perspective);
    return createFieldVfxSpace({ geo, shell: this.sceneDepthSystem.depthShellField, viewDir: viewDirWorld(geo), perspective });
  }

  /** 当前时段亮着的、有位置的实体灯（群体拿它们当恐惧源） */
  private activeSceneLightsForVfx(): readonly LightDef[] {
    const sd = this.sceneManager.currentSceneData;
    /**
     * 取**生效**的灯而不是作者写的那份：手上举着的火把会把蝙蝠赶开、被吹灭的灯笼
     * 立刻不再是恐惧源 —— 两者都只存在于运行时那一层（`effectiveLights`）。
     * 光照没启用（没烘载荷）时退回作者数据，与旧行为一致。
     */
    const lights = this.sceneLighting.active
      ? this.sceneLighting.effectiveLights()
      : (sd?.lighting?.lights ?? []);
    if (!sd?.dayNight?.enabled) return lights;
    const phase = this.dayManager.currentPhase;
    return lights.filter((l) => !l.phases?.length || l.phases.includes(phase));
  }

  private buildLightSpaceGeometry(): LightSpaceGeometry | null {
    const ground = this.characterLighting.groundDepthField;
    const rows = this.characterLighting.shadowBasisRows;
    const uni = this.characterLighting.unifiedGeometry;
    if (!ground || !rows || !uni || !this.sceneLighting.active) return null;
    return {
      work: { w: ground.w, h: ground.h },
      cal: { ppu: uni.cal.ppu, cx: uni.cal.cx, cy: uni.cal.cy },
      sceneWorld: { w: uni.sceneWorld[0], h: uni.sceneWorld[1] },
      basisRows: rows,
      wuPerQUnit: this.sceneLighting.wuPerQUnit,
      ground,
    };
  }

  private applySceneLightingParams(def: SceneLightingDef): void {
    this.sceneLighting.applyParams(def);
    const packed = this.sceneLighting.packedLights;
    // ⚠ 下面这几行与 `pushPackedLightsToCharacters` 是同一件事（推同一份 packed 给角色）。
    //   没合并是因为这里还要推 display —— 改其中一处时**两处一起看**，别让两条路分叉。
    // 角色侧吃**同一份**打包（2026-08-30「原画 + 加性灯」）：灯在 probe 的 GI 底光上
    // 直接加。与场景共用一次 packLights 是「一视同仁」的构造性保证。
    this.characterLighting.applyDisplay(def.display ?? null);
    this.characterLighting.applyLightFactors(def.lightFactors);
    this.characterLighting.applyLights(packed ?? null, this.sceneLighting.wuPerQUnit);
    if (packed) {
      this.unifiedCharLighting.applyParams(
        def, packed, this.sceneLighting.wuPerQUnit, this.sceneLighting.radianceScale);
    }
  }

  /** 让场上所有开了网格着色的实体重新向供给方要一次 shader（路径切换时用）。 */
  private rebuildEntityLitShaders(): void {
    this.player?.sprite.refreshBakedShading();
    for (const npc of this.sceneManager.getCurrentNpcs()) npc.refreshBakedShading();
  }

  private setupSceneLighting(
    sceneData: SceneData,
    worldToPixelX: number,
    worldToPixelY: number,
  ): void {
    if (this.currentProbe) {
      this.currentProbe.destroy(true);
      this.currentProbe = null;
    }
    this.currentLightEnv = null;
    this.currentLightCurve = null;
    this.currentShadowField = null;

    const cfg = this.gameConfig.entityLighting;
    if (!cfg?.enabled) {
      this.sceneDepthSystem.disableLighting();
      return;
    }

    const env = resolveLightEnv(sceneData.lightEnv, cfg);
    this.currentLightEnv = env;
    // 光照环境曲线：有(≥2点)则预处理累计弧长,并用 spawn 处投影值初始化 env(首帧滤镜烘焙正确;逐帧再覆盖)
    this.currentLightCurve = prepareLightCurve(sceneData.lightEnvCurve);
    if (this.currentLightCurve) this.resolveLightCurveInto(this.player.x, this.player.y, env);
    this.currentShadowField = new UniformShadowField(env);

    let probeSource = null;
    const bgTex = this.sceneManager.getPrimaryBackgroundTexture();
    if (bgTex) {
      this.currentProbe = buildIrradianceProbe(this.renderer.app, bgTex);
      probeSource = this.currentProbe ? this.currentProbe.source : null;
    }

    this.sceneDepthSystem.enableLighting(
      probeSource,
      env,
      sceneData.worldWidth,
      sceneData.worldHeight,
      worldToPixelX,
      worldToPixelY,
    );
  }

  /** 为玩家与各 NPC 重建投影阴影（按 shadowMode 选实现；off 不建）。 */
  private rebuildEntityShadows(): void {
    this.clearEntityShadows();
    const env = this.currentLightEnv;
    // 光源驱动阴影的 q→M-world 基(depthConfig R);无深度上下文 → auto 不可用
    const sctx = this.sceneDepthSystem.getShadowSceneContext();
    this.characterLighting.setShadowBasis(sctx
      ? [sctx.r00, sctx.r01, sctx.r02, sctx.r10, sctx.r11, sctx.r12, sctx.r20, sctx.r21, sctx.r22]
      : null);
    if (!env || env.shadow.mode === 'off' || !this.sceneDepthSystem.isLightingEnabled) return;

    // 绑定表整表重建：**运行时覆盖跟着场景走**。留到下一个场景等于"上一场演出的影子
    // 跟着角色进了新场景"，那种残留极难查（画面上只是影子方向莫名其妙）。
    this.entityShadowBindings.clear();
    const sceneData = this.sceneManager.currentSceneData;
    if (sceneData?.playerShadowBindings?.length) {
      this.entityShadowBindings.set('player', sceneData.playerShadowBindings);
    }

    this.entityShadows.set('player', {
      key: 'player',
      shadow: this.createShadowImpl(env.shadow.mode),
      src: this.makePlayerShadowSource(),
      owner: this.player,
      flags: playerShadowFlags(sceneData?.playerContactAo),
      aoDef: sceneData?.playerContactAo ?? null,
    });
    for (const npc of this.sceneManager.getCurrentNpcs()) {
      this.buildNpcShadowEntry(npc);
    }
    for (const h of this.sceneManager.getCurrentHotspots()) {
      this.buildHotspotShadowEntry(h);
    }
  }

  /**
   * 定向重建：仅对 payload 里给定 id 的 npc/hotspot 换新阴影实例（过场进出重建实体时用），
   * 不动玩家与未列出的实体，避免全场阴影整体销毁重建（与 entityShadows owner-swap 缓存自相矛盾）。
   * enter/exit 时序下某 id 若在当前场景已无实例，只销毁旧 entry、不新建。
   */
  private rebuildEntityShadowsForIds(npcIds: string[], hotspotIds: string[]): void {
    const env = this.currentLightEnv;
    const shadowsOn = !!env && env.shadow.mode !== 'off' && this.sceneDepthSystem.isLightingEnabled;

    for (const id of npcIds) {
      this.destroyEntityShadowEntry(id);
      if (!shadowsOn) continue;
      const npc = this.sceneManager.getNpcById(id);
      if (npc) this.buildNpcShadowEntry(npc);
    }
    for (const id of hotspotIds) {
      this.destroyEntityShadowEntry(`hotspot:${id}`);
      if (!shadowsOn) continue;
      const h = this.sceneManager.getCurrentHotspots().find((x) => x.def.id === id);
      if (h) this.buildHotspotShadowEntry(h);
    }
  }

  /** 销毁并从 map 移除单个实体阴影 entry（若存在）：unregister + destroy + delete，键规则同 rebuild。 */
  private destroyEntityShadowEntry(key: string): void {
    const entry = this.entityShadows.get(key);
    if (!entry) return;
    this.sceneDepthSystem.unregisterShadow(entry.shadow);
    entry.shadow.destroy();
    for (const ex of entry.extra ?? []) {
      this.sceneDepthSystem.unregisterShadow(ex);
      ex.destroy();
    }
    this.entityShadows.delete(key);
  }

  /**
   * 为单个 NPC 建阴影 entry；rebuildEntityShadows 与定向重建共用，避免逻辑漂移。
   * 投影与接触阴影**分开判**（制作人 2026-09-23）：`castShadow:false` 只关投影，
   * 接触阴影缺省开，所以两样都关才不建。
   */
  private buildNpcShadowEntry(npc: Npc): void {
    const env = this.currentLightEnv;
    if (!env) return;
    const flags = npcShadowFlags(npc.def);
    if (!flags.cast && !flags.contact) return;
    if (npc.def.shadowBindings?.length) {
      this.entityShadowBindings.set(npc.id, npc.def.shadowBindings);
    }
    this.entityShadows.set(npc.id, {
      key: npc.id,
      shadow: this.createShadowImpl(env.shadow.mode),
      src: this.makeNpcShadowSource(npc),
      owner: npc,
      flags,
      aoDef: npc.def.contactAo ?? null,
    });
  }

  /** 为单个 hotspot 建阴影 entry（仅有展示图且 castShadow!==false 才建；键加前缀避免与 npc.id 撞）。共用以避免漂移。 */
  private buildHotspotShadowEntry(h: Hotspot): void {
    const env = this.currentLightEnv;
    if (!env || h.def.castShadow === false || !h.def.displayImage?.image) return;
    if (h.def.shadowBindings?.length) {
      this.entityShadowBindings.set(`hotspot:${h.def.id}`, h.def.shadowBindings);
    }
    this.entityShadows.set(`hotspot:${h.def.id}`, {
      key: `hotspot:${h.def.id}`,
      shadow: this.createShadowImpl(env.shadow.mode),
      src: this.makeHotspotShadowSource(h),
      owner: h,
      flags: ALL_SHADOWS_ON,
      // 热区展示图（道具）不是角色、也没有接触 AO 的作者面：保持简单 AO。
      // 「所有 NPC 默认都开方向 AO，包括主角」（制作人 2026-09-24）说的是角色。
      aoDef: HOTSPOT_CONTACT_AO,
    });
  }

  /** 建阴影实现:一律 planar 剪影(用户拍板 2026-07-22:影子=角色 mask 剪切剪影,
   *  模糊在剪影上做;deferred 逐像素与重建面求交会啃烂形状,已彻底弃用)。
   *  实例注册进 SceneDepthSystem 调参广播列表（F2 改 tolerance/floorOffset 实时传播）。 */
  private createShadowImpl(_mode: 'real' | 'planar' | 'off'): IEntityShadow {
    const layer = this.renderer.shadowLayer;
    const ctx = this.sceneDepthSystem.getShadowSceneContext();
    const sh = new PlanarEntityShadow(layer, ctx);
    this.sceneDepthSystem.registerShadow(sh);
    return sh;
  }

  /** F2:probe 点云可视化开关(实验室查看器点云的游戏侧对应物,调试用)。 */
  private toggleCharProbeViz(): boolean {
    if (this.probeVizGfx) {
      this.probeVizGfx.destroy();
      this.probeVizGfx = null;
      return false;
    }
    const pts = this.characterLighting.getProbeViz();
    if (!pts) return false;
    const gfx = new Graphics();
    for (const p of pts) {
      if (p.valid) gfx.circle(p.x, p.y, 1.6).fill({ color: p.color });
      else gfx.circle(p.x, p.y, 1.0).fill({ color: 0x555555, alpha: 0.5 });
    }
    this.renderer.worldContainer.addChild(gfx);
    this.probeVizGfx = gfx;
    return true;
  }

  /** 逐帧驱动烘焙着色滤镜:脚点/quad 尺寸/当前帧法线 rect + F2 参数全量同步。 */
  /** 视口边距系数:实体全离开「屏幕×(1+2×margin)」框才剔,留余量吃滤镜边缘/防慢速平移 pop */
  private static readonly FRUSTUM_CULL_MARGIN = 0.2;

  setFrustumCullingEnabled(on: boolean): void {
    this.frustumCullingEnabled = on;
  }
  isFrustumCullingEnabled(): boolean {
    return this.frustumCullingEnabled;
  }

  /**
   * 视锥剔除:给 entityLayer 里的 NPC/热点容器打 Pixi cullable,按带边距的屏幕框算 culled,
   * 屏外实体整棵跳过渲染。写的是 localDisplayStatus 的 culled 位,与显隐四通道的 visible
   * 正交(见 entity-visibility-channels),不影响玩法可见性;玩家容器不剔(恒在镜头中心)。
   * 关闭时一次性清 culled 复原。必须在 depth 驱动块**之前**调用:同帧内屏外实体既跳渲染、
   * 也跳着色驱动,而重回画面当帧已被 uncull → 当帧即驱动,零残帧。
   */
  private updateFrustumCulling(): void {
    const layer = this.renderer.entityLayer;
    if (!this.frustumCullingEnabled) {
      if (this.frustumCullingWasActive) {
        for (const child of layer.children) {
          child.cullable = false;
          child.culled = false;
        }
        this.frustumCullingWasActive = false;
      }
      return;
    }
    this.frustumCullingWasActive = true;
    const playerContainer = this.player.sprite.container;
    for (const child of layer.children) {
      child.cullable = child !== playerContainer;
    }
    const m = Game.FRUSTUM_CULL_MARGIN;
    const screen = this.renderer.app.screen;
    const view = screen.clone().pad(screen.width * m, screen.height * m);
    Culler.shared.cull(layer, view);
  }

  private driveBakedShading(
    filter: IEntityShadingFilter,
    worldX: number,
    worldY: number,
    ent: CharShadingEntityInfo | null,
  ): void {
    if (filter instanceof CharacterShadingFilter) {
      // 法线图集**逐帧跟随当前图集**。原来只在 attach*SceneFilter 里绑一次,实体一换图集
      // (玩家常态/背尸/道士,或 NPC 经 setEntityField 重载动画)就变成"新坐标查旧图" ——
      // 采样落到无关区域:角色变暗 + 随帧闪烁 + 无规律。setNormalTexture 内部对同源短路,
      // 逐帧调用零开销。
      if (ent && ent.sheetUrl !== undefined) {
        filter.setNormalTexture(getNormalAtlasSource(this.assetManager, ent.sheetUrl));
      }
      this.characterLighting.driveFilter(filter, worldX, worldY, ent);
    }
  }

  private applyShadowAndAO(): void {
    const env = this.currentLightEnv;
    if (!env) return;
    const tone = env.toneEnabled ? env.toneStrength : 0;
    const aoForm = env.shadow.mode === 'off' ? 0 : env.ao.form;
    this.sceneDepthSystem.applyShadowFilterToneAO(
      tone,
      env.shadow.mode === 'off' ? env.ao.contact : 0,
      aoForm,
    );
    // sprite 网格着色的 AO 同源同值(经共享帧组下发,syncFrame 每帧带出)
    this.characterLighting.setSharedAO(env.shadow.mode === 'off' ? env.ao.contact : 0, aoForm);
  }

  /** F2 切换 shadowMode/tone/billboard 后重建阴影实例并重设滤镜 tone/AO。 */
  private applyShadowModeChange(): void {
    this.rebuildEntityShadows();
    this.applyShadowAndAO();
  }

  /** 把光照环境曲线在世界点 (px,py) 处的插值结果原地写入 env（保持对象身份，供持引用者逐帧读取）。 */
  private resolveLightCurveInto(px: number, py: number, env: ResolvedLightEnv): void {
    const curve = this.currentLightCurve;
    if (!curve) return;
    const t = projectToCurveT(curve, px, py);
    const partial = interpolateLightEnv(curve, t);
    const resolved = resolveLightEnv(partial, this.gameConfig.entityLighting);
    copyResolvedInto(env, resolved);
  }

  /**
   * 相机基线 zoom：激活位面配置了 camera.zoom 时以位面档为基线，否则场景 JSON zoom（缺省 1）。
   * 所有"恢复场景 zoom"路径（restoreSceneCameraZoom / fadingRestoreSceneCameraZoom，
   * 对话与演出收尾走它）必须恢复到该基线——按裸场景 zoom 恢复会把位面相机档静默盖掉。
   */
  private getCameraBaselineZoom(): number {
    const planeZoom = this.planeReconciler.getActiveCameraZoom();
    if (planeZoom !== null) return planeZoom;
    const z = this.sceneManager.currentSceneData?.camera?.zoom;
    return z !== undefined && Number.isFinite(z) && z > 0 ? z : 1;
  }

  /**
   * 位面光照档钩子（PlaneReconciler 经 bindRuntime 调用）：
   * - partial 非空：把该档经 resolveLightEnv 补全后按 updateLightEnvFromCurve 的推送序列
   *   写进光照管线，并挂起 lightEnvCurve（同 F2 打开时的让位规则，见 updateLightEnvFromCurve）。
   * - null：清除覆盖并恢复场景默认光照（有曲线的场景下一帧由曲线自然接管）。
   * 幂等：重复以同一档调用只是重推同值；override 已空时传 null 为 no-op。
   * 场景光照未启用（无 currentLightEnv）时仅记录覆盖，切场景后由 scene:ready 对账重贴。
   */
  applyPlaneLightEnvOverride(partial: SceneLightEnv | null): void {
    if (!partial && !this.planeLightEnvOverride) return;
    this.planeLightEnvOverride = partial;
    const env = this.currentLightEnv;
    if (!env) return;
    const prevMode = env.shadow.mode;
    const resolved = resolveLightEnv(
      partial ?? this.sceneManager.currentSceneData?.lightEnv,
      this.gameConfig.entityLighting,
    );
    copyResolvedInto(env, resolved);
    this.sceneDepthSystem.applyKeyAmbient(
      env.key.color, env.key.intensity, env.ambient.color, env.ambient.intensity,
    );
    this.applyShadowAndAO();
    if (env.shadow.mode !== prevMode) this.rebuildEntityShadows();
  }

  /**
   * 每帧：若有光照环境曲线，按玩家投影位置插值并把新环境推给阴影/滤镜。
   * 无曲线时单次 null 检查即返回 —— 对现有场景零影响。
   */
  private updateLightEnvFromCurve(): void {
    const env = this.currentLightEnv;
    if (!this.currentLightCurve || !env) return;          // 无曲线/无环境=零影响
    if (this.planeLightEnvOverride) return;               // 位面光照档激活期间曲线挂起（同 F2 让位）
    if (this.debugPanelUI?.isOpen) return;                // F2 光照调试期间让出控制权（避免被逐帧覆盖）
    const prevMode = env.shadow.mode;
    this.resolveLightCurveInto(this.player.x, this.player.y, env);
    // key/ambient 颜色强度、tone/AO 走滤镜 setter 广播（覆盖构造时烘焙值）；
    // 阴影方向/长度/暗度等由 updateEntityShadows 逐帧从 env 读取，无需额外推送。
    this.sceneDepthSystem.applyKeyAmbient(
      env.key.color, env.key.intensity, env.ambient.color, env.ambient.intensity,
    );
    this.applyShadowAndAO();
    // 仅当 shadow.mode 真正变化（跨关键帧切 real/planar/off）才重建阴影实例（罕见）
    if (env.shadow.mode !== prevMode) this.rebuildEntityShadows();
  }

  /** 每帧更新投影阴影（位置/剪影/朝向跟随实体）。ShadowSource 复用缓存（F2 性能）；
   *  仍按当前实体列表寻址——实例被过场重建（owner 变化）时就地换源，不更新已不在场的实体。
   *  光源驱动模式(shadowAutoReady)下逐实体走多槽驱动:方向/浓度/软度由光源表解析。 */
  private updateEntityShadows(): void {
    const env = this.currentLightEnv;
    if (!env || this.entityShadows.size === 0) return;

    const now = performance.now();
    const dtMs = this.shadowDriveLastMs > 0 ? Math.min(now - this.shadowDriveLastMs, 100) : 16;
    this.shadowDriveLastMs = now;

    const field = this.currentShadowField;
    const playerEntry = this.entityShadows.get('player');
    if (playerEntry) {
      this.driveEntryShadows(playerEntry, env, field, dtMs);
    }
    for (const npc of this.sceneManager.getCurrentNpcs()) {
      const entry = this.entityShadows.get(npc.id);
      if (!entry) continue;
      if (entry.owner !== npc) {
        entry.owner = npc;
        entry.src = this.makeNpcShadowSource(npc);
      }
      this.driveEntryShadows(entry, env, field, dtMs);
    }
    for (const h of this.sceneManager.getCurrentHotspots()) {
      const entry = this.entityShadows.get(`hotspot:${h.def.id}`);
      if (!entry) continue;
      if (entry.owner !== h) {
        entry.owner = h;
        entry.src = this.makeHotspotShadowSource(h);
      }
      this.driveEntryShadows(entry, env, field, dtMs);
    }
  }

  /**
   * 单实体阴影驱动。
   *
   * 配了 `EntityShadowBinding[]` → 逐条解出一个 **planar 剪影**（作者摆什么就是什么）；
   * 没配 → 走原来的手调单影路径（旧场景零影响）。
   *
   * ## 为什么没有"自动"这一档
   *
   * 制作人 2026-08-20 明确要求删掉：「角色阴影的控制，要能够手动指定绑定灯光和
   * 虚拟灯光，**不能自动 resolve**」。旧的能流模型会算出一组光、按身份绑槽、
   * 再做时间低通——作者既看不懂也改不动，换盏灯就全变，演出上完全没有抓手。
   *
   * 现在这里**逐帧幂等**：同样的绑定 + 同样的位置永远解出同样的影子。
   * 没有槽位继承、没有低通、没有隐藏状态。
   *
   * 影子形状只能是**剪影**（角色 mask 经光向剪切，脚边钉住、头边偏移）——
   * 角色本身是一个片，deferred 逐像素与重建面求交会把形状啃烂，这条是用户红线。
   *
   * ## 接触斑与灯无关（制作人 2026-09-02 定死）
   *
   * 脚底接触斑是"角色坐进地面"的常驻效果，强度只认 `env.shadow.contact`
   * （场景 / 全局 lightEnv，缺省 0.75；实体 contactAo.darkness 可覆盖），**不看有没有绑灯、绑的灯多远多亮**。
   * 它永远由主 planar 实例（`entry.shadow`）画；绑定只接管**投影剪影**（extra 槽），
   * extra 槽的接触斑恒 0。
   *
   * 2026-08-22 手动绑灯改版曾把它耦合成「绑定灯照度份额 × 0.5」：配了绑定的实体
   * 主实例整个熄灭（含接触斑），接触斑改由绑定解算给。后果是玩家离绑定灯超过
   * 灯的射程就整颗消失（雾津街头 lamp_2 射程 200 wu，出生点 1332 wu 外，份额 1e-21），
   * 而且画面上只表现为"脚下没东西"，没有任何报错。
   *
   * ## 投影与接触阴影各自一个开关（制作人 2026-09-23）
   *
   * `entry.flags`：`cast` 关 = 手调单影与绑定剪影都不画；`contact` 关 = 不画接触斑。
   * 接触阴影**缺省开**，`castShadow:false` 不再连带关掉它——送葬队为了不投错方向的影子
   * 关了投影，结果脚下什么都没有，站在灯前的亮地上像飘着。
   */
  private driveEntryShadows(
    entry: EntityShadowEntry,
    env: ResolvedLightEnv,
    field: ShadowProjectionField | null,
    _dtMs: number,
  ): void {
    // 关了投影的实体（castShadow:false）连绑定的剪影也不画，只剩接触阴影。
    const bindings = entry.flags.cast ? this.resolveEntityShadowBindings(entry) : null;
    const ao = this.contactAoParams(entry, env);
    const offSlot = (i: number): ResolvedLightEnv => {
      const off = this.getSlotEnv(entry, i, env);
      off.shadow.darkness = 0; off.shadow.contact = 0;
      return off;
    };

    if (!bindings || bindings.length === 0) {
      // 没配绑定：原手调单影。**不是**回落到某种自动行为——没配就是没配。
      entry.shadow.update(entry.src, this.mainShadowEnv(entry, env, entry.flags.cast), field, null, ao);
      if (entry.extra?.length) {
        for (let i = 0; i < entry.extra.length; i++) {
          entry.extra[i].update(entry.src, offSlot(i), null);
        }
      }
      return;
    }

    // 配了绑定：手调单影只熄灭**投影**（darkness=0），接触斑照旧由它按 env 常驻画；
    // 逐条 planar 剪影由 extra 槽接管。
    entry.shadow.update(entry.src, this.mainShadowEnv(entry, env, false), field, null, ao);

    const ctx = this.shadowBindingContext(entry);
    entry.extra ??= [];
    while (entry.extra.length < bindings.length) entry.extra.push(this.createShadowImpl('planar'));

    const style = this.characterLighting.shadowStyle;
    for (let i = 0; i < entry.extra.length; i++) {
      const impl = entry.extra[i] as IEntityShadow & {
        setShadowColor?: (c: [number, number, number]) => void;
      };
      const sol = i < bindings.length && ctx ? resolveBoundShadow(bindings[i], ctx) : null;
      if (!sol) { impl.update(entry.src, offSlot(i), null); continue; }
      const se = this.getSlotEnv(entry, i, env);
      // planar 取向:angleRad = (key.azimuthDeg+180);解出来的已是屏幕影子方向
      se.key.azimuthDeg = sol.screenAngleDeg - 180;
      se.key.elevationDeg = sol.elevationDeg;
      // 全局强度只是**最后乘上去的调制**：绝对可见度靠它（暗场景 alpha 摊在黑地上看不见）
      se.shadow.darkness = Math.min(1, style.gain * sol.darkness);
      se.shadow.length = sol.length;
      se.shadow.softness = sol.softness;
      // 接触斑不归绑定管：主实例已按 env.shadow.contact 画了，这里恒 0（否则脚下糊成一团）
      se.shadow.contact = 0;
      impl.setShadowColor?.(style.color);
      // field 会覆盖 key 方向，绑定解出来的方向必须传 null 才不被冲掉
      impl.update(entry.src, se, null, { spread: sol.spread, widthScale: sol.widthScale });
    }
  }

  /**
   * 胶囊 AO（脚底接触 AO）这一帧的参数。作者面（制作人 2026-09-24）：`contactAo` 缺省开、方向 AO 缺省也开；
   * 明暗 / 大小不写跟随场景光环境。
   *
   * 方向来源是作者选项 `dirSource`：
   * - `'lighting'`（缺省，制作人 2026-09-24「ao 方向本来就和间接光强度要一致」）跟角色身上的光一致：
   *   间接光一路（probe 上半球来光，与角色间接光同一份数据）+ 每盏实体灯一路，各投各的影、
   *   按各自照到脚下地面的量加权（`contactAoSources.ts`）。角色没走 probe 受光（没有载荷 / 只借几何）时
   *   它也不吃实体灯，退场景主光——与它那时的受光（光环境色调）一致；
   * - `'binding'` 跟阴影绑定：取第一条解得出方向的（绑灯朝灯、虚拟灯朝它），全是 `'none'` → 只画无方向部分，
   *   没配绑定 → 场景主光。绑定按实体取、不看 `castShadow`；
   * - `'scene'` 场景光环境主方向（`env.key`，影朝 az+180，与手调单影同向）。
   * 浓度上限只认解出来的明暗（`dirStrength`）；缺省档里各路按照度分这份浓度，照不到的灯自然没份。
   * 这是投影剪影"不自动挑灯"（2026-08-20）之外的有意例外：只给接触 AO 用，作者随时能换档。
   */
  private contactAoParams(entry: EntityShadowEntry, env: ResolvedLightEnv): ContactAoParams {
    const wuPerQUnit = this.sceneLighting.wuPerQUnit;
    const ao = resolveContactAo(entry.aoDef, env.shadow);
    // 接触开关只有一个：entry.flags.contact（由 contactAo.enabled 派生，运行时也可单独关）。
    // 主实例画接触 AO 只看这里解出的 ao，不再看 env.shadow.contact——所以关必须关在这里
    // （2026-09-24 真机：只关 flags.contact 时接触 AO 照画）。
    if (!entry.flags.contact) ao.enabled = false;
    const rows = this.characterLighting.shadowBasisRows;
    // 看不见的实体影子本来就不画（PlanarEntityShadow.update 首行就藏），不必逐帧查探针、算灯
    if (!ao.enabled || !ao.directional || !rows || !entry.src.isVisible()) return { ao, sources: [], wuPerQUnit };
    // 只有一路的两档：方向型、权重 1
    const one = (dir: readonly [number, number, number] | null): ContactAoSource[] =>
      dir ? [{ point: false, x: dir[0], y: dir[1], z: dir[2], footDir: dir, weight: 1 }] : [];
    const sceneDir = (): [number, number, number] | null =>
      lightDirFromShadowScreenAngle(env.key.azimuthDeg + 180, env.key.elevationDeg, rows);

    if (ao.dirSource === 'scene') return { ao, sources: one(sceneDir()), wuPerQUnit };

    if (ao.dirSource === 'binding') {
      const bindings = this.resolveEntityShadowBindings(entry);
      if (!bindings || bindings.length === 0) return { ao, sources: one(sceneDir()), wuPerQUnit };
      const ctx = this.shadowBindingContext(entry);
      for (const b of bindings) {
        const dir = ctx
          ? resolveBindingLightDir(b, ctx)
          : (b.source === 'virtual' && b.virtual
            ? lightDirFromShadowScreenAngle(b.virtual.azimuthDeg, b.virtual.elevationDeg, rows)
            : null);
        if (dir) return { ao, sources: one(dir), wuPerQUnit };
      }
      return { ao, sources: [], wuPerQUnit };
    }

    // 'lighting'
    const cl = this.characterLighting;
    const fx = entry.src.getFootX(), fy = entry.src.getFootY();
    const chest = cl.active && !cl.isGeometryOnly ? cl.chestQAt(fx, fy, entry.src.getWorldHeight()) : null;
    const foot = chest ? cl.chestQAt(fx, fy, 0) : null;
    if (!chest || !foot) return { ao, sources: one(sceneDir()), wuPerQUnit };
    const probe = cl.indirectProbeData();
    const packed = cl.characterPackedLights;
    // 脚点 → M-world wu（与角色 shader 的 P = R·q × wuPerQUnit 同式，铁律 0）
    const P: [number, number, number] = [
      (rows[0] * foot[0] + rows[1] * foot[1] + rows[2] * foot[2]) * wuPerQUnit,
      (rows[3] * foot[0] + rows[4] * foot[1] + rows[5] * foot[2]) * wuPerQUnit,
      (rows[6] * foot[0] + rows[7] * foot[1] + rows[8] * foot[2]) * wuPerQUnit,
    ];
    const mix = cl.characterLightMix;
    const sources = resolveContactAoSources(
      probe ? indirectUpperMoment(probe, chest, rows) : null, mix.indirect,
      packed ? lightGroundSources(packed, P) : [], mix.direct,
    );
    return { ao, sources, wuPerQUnit };
  }

  /**
   * 取实体的阴影绑定。运行时覆盖（`setEntityShadow` Action）优先于场景数据里的缺省。
   * 返回 null = 没配，走手调单影。
   */
  private resolveEntityShadowBindings(entry: EntityShadowEntry): EntityShadowBinding[] | null {
    return this.entityShadowBindings.get(entry.key) ?? null;
  }

  /** 解算绑定要用的场景上下文。缺深度基（无深度场景）返回 null → 不投影。 */
  private shadowBindingContext(entry: EntityShadowEntry): ShadowBindingContext | null {
    const rows = this.characterLighting.shadowBasisRows;
    const lighting = this.sceneLighting.params;
    if (!rows || !lighting) return null;
    // 参考点取胸口（脚点抬半个身高）——影子方向该由角色所在处的光决定，
    // 而脚点贴着地面时与灯的方向关系会被地面高差放大。
    const worldH = entry.src.getWorldHeight();
    const q = this.characterLighting.chestQAt(entry.src.getFootX(), entry.src.getFootY(), worldH);
    if (!q) return null;
    const charHeightQ = this.characterLighting.heightQ(worldH);
    if (charHeightQ === null) return null;
    return {
      charWorld: [
        rows[0] * q[0] + rows[1] * q[1] + rows[2] * q[2],
        rows[3] * q[0] + rows[4] * q[1] + rows[5] * q[2],
        rows[6] * q[0] + rows[7] * q[1] + rows[8] * q[2],
      ],
      wuPerQUnit: this.sceneLighting.wuPerQUnit,
      mRows: rows,
      lights: lighting.lights,
      skyIntensity: lighting.sky.intensity,
      charHeightQ,
    };
  }

  /**
   * 主实例（手调单影 + 接触斑）这一帧用的 env。
   *
   * 投影与接触阴影各按开关熄灭：`castOn=false` 压投影浓度，`entry.flags.contact=false` 压接触斑。
   * 两样都要画时**直接返回活 env**——没配绑定、两个开关都开的存量实体逐字走老路。
   * 覆盖对象整份从活 env 刷新（含 key 方向），不留上一帧的值。
   */
  private mainShadowEnv(entry: EntityShadowEntry, env: ResolvedLightEnv, castOn: boolean): ResolvedLightEnv {
    if (castOn && entry.flags.contact) return env;
    let me = entry.mainEnv;
    if (!me) {
      me = {
        key: { ...env.key },
        ambient: env.ambient,
        shadow: { ...env.shadow },
        toneStrength: env.toneStrength,
        toneEnabled: env.toneEnabled,
        ao: env.ao,
      };
      entry.mainEnv = me;
    }
    Object.assign(me.key, env.key);
    me.ambient = env.ambient;
    Object.assign(me.shadow, env.shadow);
    me.toneStrength = env.toneStrength;
    me.toneEnabled = env.toneEnabled;
    me.ao = env.ao;
    if (!castOn) me.shadow.darkness = 0;
    if (!entry.flags.contact) me.shadow.contact = 0;
    return me;
  }

  /** 槽 env 覆盖对象:缓存复用,每帧从活 env 刷新标量再由调用方覆写方向/浓度/软度。 */
  private getSlotEnv(entry: EntityShadowEntry, i: number, env: ResolvedLightEnv): ResolvedLightEnv {
    entry.envSlots ??= [];
    let se = entry.envSlots[i];
    if (!se) {
      se = {
        key: { ...env.key },
        ambient: env.ambient,
        shadow: { ...env.shadow },
        toneStrength: env.toneStrength,
        toneEnabled: env.toneEnabled,
        ao: env.ao,
      };
      entry.envSlots[i] = se;
    }
    se.key.color = env.key.color;
    se.key.intensity = env.key.intensity;
    se.ambient = env.ambient;
    se.ao = env.ao;
    Object.assign(se.shadow, env.shadow);
    return se;
  }

  private makePlayerShadowSource(): ShadowSource {
    const p = this.player;
    return {
      // 接地点（不是位置）：锚点可配之后两者只有缺省锚才相等，见 NpcDef.anchor
      getFootX: () => p.contactX,
      getFootY: () => p.contactY,
      getWorldWidth: () => p.sprite.getWorldSize().width,
      getWorldHeight: () => p.sprite.getWorldSize().height,
      getTexture: () => p.sprite.getDisplayTexture(),
      getBodyReferenceFrames: () => p.sprite.getBodyReferenceFrames(),
      getFacing: () => (p.facingDirection === 'left' ? -1 : 1),
      isVisible: () => p.sprite.container.visible,
    };
  }

  private makeNpcShadowSource(npc: Npc): ShadowSource {
    return {
      // 接地点（不是位置）：锚点在圆心的物件，脚点在它下方半个身高，见 NpcDef.anchor
      getFootX: () => npc.contactX,
      getFootY: () => npc.contactY,
      getWorldWidth: () => npc.getWorldSize().width,
      getWorldHeight: () => npc.getWorldSize().height,
      getTexture: () => npc.getDisplayTexture(),
      getBodyReferenceFrames: () => npc.getBodyReferenceFrames(),
      getFacing: () => npc.getFacing(),
      isVisible: () => npc.container.visible,
    };
  }

  private makeHotspotShadowSource(h: Hotspot): ShadowSource {
    return {
      getFootX: () => h.container.x,
      getFootY: () => h.depthOcclusionFootWorldY(),
      getWorldWidth: () => h.getWorldSize().width,
      getWorldHeight: () => h.getWorldSize().height,
      getTexture: () => h.getDisplayTexture(),
      getFacing: () => h.getFacing(),
      isVisible: () => h.container.visible,
    };
  }

  private clearEntityShadows(): void {
    for (const entry of this.entityShadows.values()) {
      this.sceneDepthSystem.unregisterShadow(entry.shadow);
      entry.shadow.destroy();
      for (const ex of entry.extra ?? []) {
        this.sceneDepthSystem.unregisterShadow(ex);
        ex.destroy();
      }
    }
    this.entityShadows.clear();
  }

  // ---- F2 投影阴影实时调试：直接改当前解析的 LightEnv（逐帧被阴影读取），仅影响渲染 ----
  private entityShadowDebugActive(): boolean {
    return this.sceneDepthSystem.isLightingEnabled && this.currentLightEnv !== null;
  }

  private getEntityShadowDebug(): { mode: string; toneEnabled: boolean; billboard: string; enabled: boolean; azimuthDeg: number; elevationDeg: number; lengthFactor: number; darkness: number; contact: number; contactSize: number; softSamples: number } | null {
    const e = this.currentLightEnv;
    if (!e) return null;
    return {
      mode: e.shadow.mode,
      toneEnabled: e.toneEnabled,
      billboard: e.shadow.billboard,
      enabled: e.shadow.enabled,
      azimuthDeg: e.key.azimuthDeg,
      elevationDeg: e.key.elevationDeg,
      lengthFactor: e.shadow.length,
      darkness: e.shadow.darkness,
      contact: e.shadow.contact,
      contactSize: e.shadow.contactSize,
      softSamples: e.shadow.softSamples,
    };
  }

  private cycleShadowModeDebug(): void {
    const e = this.currentLightEnv;
    if (!e) return;
    e.shadow.mode = e.shadow.mode === 'real' ? 'planar' : e.shadow.mode === 'planar' ? 'off' : 'real';
    this.applyShadowModeChange();
  }

  private toggleEntityToneDebug(): void {
    const e = this.currentLightEnv;
    if (!e) return;
    e.toneEnabled = !e.toneEnabled;
    this.applyShadowAndAO();
  }

  private toggleEntityShadowBillboardDebug(): void {
    const e = this.currentLightEnv;
    if (!e) return;
    e.shadow.billboard = e.shadow.billboard === 'light' ? 'camera' : 'light';
  }

  private nudgeEntityShadowElevationDebug(delta: number): void {
    const e = this.currentLightEnv;
    if (!e) return;
    e.key.elevationDeg = Math.max(5, Math.min(85, e.key.elevationDeg + delta));
  }

  private nudgeEntityShadowSoftSamplesDebug(delta: number): void {
    const e = this.currentLightEnv;
    if (!e) return;
    e.shadow.softSamples = Math.max(1, Math.min(8, Math.round(e.shadow.softSamples + delta)));
  }

  private setEntityShadowAzimuthDebug(deg: number): void {
    const e = this.currentLightEnv;
    if (!e || !Number.isFinite(deg)) return;
    e.key.azimuthDeg = ((deg % 360) + 360) % 360;
  }

  private nudgeEntityShadowLengthDebug(delta: number): void {
    const e = this.currentLightEnv;
    if (!e) return;
    e.shadow.length = Math.max(0.05, Math.min(3, e.shadow.length + delta));
  }

  private nudgeEntityShadowDarknessDebug(delta: number): void {
    const e = this.currentLightEnv;
    if (!e) return;
    e.shadow.darkness = Math.max(0, Math.min(1, e.shadow.darkness + delta));
  }

  private nudgeEntityShadowContactDebug(delta: number): void {
    const e = this.currentLightEnv;
    if (!e) return;
    e.shadow.contact = Math.max(0, Math.min(1, e.shadow.contact + delta));
  }

  private nudgeEntityShadowContactSizeDebug(delta: number): void {
    const e = this.currentLightEnv;
    if (!e) return;
    e.shadow.contactSize = Math.max(0.1, Math.min(3, e.shadow.contactSize + delta));
  }

  private toggleEntityShadowEnabledDebug(): void {
    const e = this.currentLightEnv;
    if (!e) return;
    e.shadow.enabled = !e.shadow.enabled;
  }

  /**
   * travel 槽门闸：当前位面禁止地图快速旅行时拒绝并 toast 提示。
   * 面板 openGuard 与 EventBridge 的 map:travel 双闸共用（后者兜脚本/竞态路径）。
   */
  /**
   * 条件求值上下文唯一工厂（律5 统一条件源）：所有条件消费方——包括 Game 内部的手工求值点
   * （糖转盘 beforeCharge、depth_floor 每帧偏移）——一律经此构造。手工拼缩水上下文会缺
   * plane/@scene/@owner 叶子，同一条件在不同入口得出不同结果（plane 叶子缺 getter 时
   * 静默按 'normal' 求值）。
   */
  private buildConditionEvalContext(): ConditionEvalContext {
    return {
      flagStore: this.flagStore,
      questManager: this.questManager,
      scenarioState: this.scenarioStateManager,
      narrativeState: this.narrativeStateManager,
      resolveConditionLiteral: (raw) => this.resolveDisplayText(raw),
      // `@scene` 解析为当前场景 wrapper；`@owner` 在 onEnter 期间继承场景 owner
      // （对话内由 GraphDialogueManager.conditionCtx 覆盖为对话 owner）。
      currentSceneId: this.sceneManager.currentSceneData?.id ?? undefined,
      currentOwner: this.ambientNarrativeOwner ?? undefined,
      // plane 叶子：当前激活位面（含 manual override）；全部条件消费方经此工厂自动可用
      getActivePlaneId: () => this.planeReconciler.getActivePlaneId(),
      // 身体姿态与位面同构：都是「世界此刻的样子」，走同一条条件通道
      getPlayerPosture: () => this.playerActionSystem.getPosture(),
      // 时段同理（由 DayManager 的时刻派生，不是独立状态）
      getTimePhase: () => this.dayManager.currentPhase,
      // 粒子 / 群体实例状态（roosting / airborne / fleeing …）：不在场 → null → 叶子恒假
      getVfxState: (id) => this.vfxSystem?.getInstanceState(id) ?? null,
      // 手持挂件（火把点着没有、火势、锁）：全局玩法状态，不镜像成 flag
      getHeldProps: (target) => this.heldPropSystem?.statusOf(target) ?? [],
      // 挂件等级（随身那根火把升到第几级）：拿在手上还是收在包里都算数
      getPropLevel: (propId) => this.heldPropSystem?.getPropLevel(propId) ?? 1,
      getBurnState: (target, sceneId, socket) => this.burnSystem?.statusOf(target, sceneId, socket) ?? null,
    };
  }

  /**
   * 玩家**自由可控**判据（2026-08-18 拍板：Esc 菜单只有这时能出，其余一律不出）：
   * 探索态 + 世界已装载 + 画面没被系统遮蔽（切场/加载过渡遮罩、显式持久黑幕）。
   * 过场/对话/遭遇/小游戏/动作链由状态机天然排除；加载窗是状态机的盲区，靠遮蔽判据补。
   */
  private isPlayerFreeControl(): boolean {
    if (this.stateController.currentState !== GameState.Exploring) return false;
    if (this.sceneManager.switching) return false;
    if (this.sceneManager.viewObscured) return false;
    if (!this.sceneManager.currentSceneData) return false;
    return true;
  }

  private guardMapTravel(): boolean {
    if (this.planeReconciler.isMapTravelAllowed()) return true;
    this.eventBus.emit('notification:show', {
      text: this.stringsProvider.get('notifications', 'mapTravelBlocked'),
      type: 'warning',
    });
    return false;
  }

  /**
   * 把「关闭本面板」的通道注入给带 ✕ 的注册面板。
   *
   * 组件层的 `UIWindow` 恒画 ✕，但面板自己 `close()` 会绕过 `GameStateController` 的弹栈恢复，
   * 状态滞留 UIOverlay = 不可恢复软锁。面板拿不到 stateController（构造签名不改），
   * 故与 `setResolveDisplay` 同一范式注入。
   *
   * ⚠ 早期两版都靠「在 window 上补发按键」绕过，**均已被审查证伪**，勿回退：
   * 补发 Esc → F2 调试坞开着时会去关调试坞；状态漂到 Exploring 时会弹出暂停菜单压在面板上。
   * 补发面板自己的快捷键 → 调试坞开着时 handleKeyDown 吞掉所有其它按键，✕ 变死按钮；
   * 且要求每个面板把快捷键码抄一份，是会漂移的手工镜像。
   */
  private injectPanelCloseRequesters(): void {
    this.questPanelUI.setCloseRequester(() => this.stateController.closePanel('quest'));
    this.inventoryUI.setCloseRequester(() => this.stateController.closePanel('inventory'));
    this.rulesPanelUI.setCloseRequester(() => this.stateController.closePanel('rules'));
    this.dialogueLogUI.setCloseRequester(() => this.stateController.closePanel('dialogueLog'));
    this.ruleUseUI.setCloseRequester(() => this.stateController.closePanel('ruleUse'));
    this.bookshelfUI.setCloseRequester(() => this.stateController.closePanel('bookshelf'));
    this.mapUI.setCloseRequester(() => this.stateController.closePanel('map'));
  }

  private registerUIPanels(): void {
    this.injectPanelCloseRequesters();
    // HUD 右下入口条 / 芯片点击 → 面板开关（关旧开新的「换过去」语义，见 switchToPanel）
    this.hud.setPanelOpener((name) => this.stateController.switchToPanel(name));
    // 确认框在场时控制器整帧不吃键盘（Esc 双消费修复，见 UIConfirmDialog.isConfirmDialogOpen）
    // 说明卡是模态：与确认框同款整帧让路（面板快捷键不许在卡上叠开）。仪式/卡的"世界停住"走状态机
    // （runInGameState：仪式 Cutscene、卡 UIOverlay），不靠这里。
    // 文字输入框（存档起名）同理：按键落在输入框上、不冒泡，这里再兜一道，打字不许触发面板快捷键
    this.stateController.setKeySuppressor(() => isConfirmDialogOpen() || isSystemNoteOpen() || isTextPromptOpen());
    // 全部探索面板共用「玩家自由可控」闸（2026-08-18 拍板）：切场/加载遮罩下 state
    // 仍是 Exploring，不加闸的话面板会被按到加载画面上。
    const freeControl = (): boolean => this.isPlayerFreeControl();
    this.stateController.registerPanel('quest', this.questPanelUI, 'Tab', { openGuard: freeControl });
    this.stateController.registerPanel('inventory', this.inventoryUI, 'KeyI', { openGuard: freeControl });
    this.stateController.registerPanel('rules', this.rulesPanelUI, 'KeyR', { openGuard: freeControl });
    // 对话/遭遇里最需要回看上一句（审查 P1：那时 KeyL 恰恰是死键），放行到叙事态；
    // 过场/小游戏/标题仍不可开（guard），另一面板开着时允许叠开（UIOverlay）；
    // 探索态下同样吃「自由可控」闸（加载遮罩下不许开）。
    this.stateController.registerPanel('dialogueLog', this.dialogueLogUI, 'KeyL', {
      alwaysOpenable: true,
      openGuard: () => {
        const s = this.stateController.currentState;
        if (s === GameState.Dialogue || s === GameState.Encounter || s === GameState.UIOverlay) return true;
        return s === GameState.Exploring && this.isPlayerFreeControl();
      },
    });
    this.stateController.registerPanel('bookshelf', this.bookshelfUI, 'KeyB', { openGuard: freeControl });
    this.stateController.registerPanel('map', this.mapUI, 'KeyM', {
      openGuard: () => this.isPlayerFreeControl() && this.guardMapTravel(),
    });
    // 「用规矩」面板键位 F→G（2026-08-03）：F 让给身体动词「上脚」，面板键与
    // Tab/I/R/L/B/M 一族归位。改此处须同步 TouchMobileControls 与 strings 的按键说明。
    // openGuard：区里没有可用规矩槽时按 G 不再静默（审查 P1「亮 [G] 按了没反应」），
    // 拒绝提示按 RegisterPanelOptions 的约定由注册方在守卫内自行发。
    this.stateController.registerPanel('ruleUse', this.ruleUseUI, 'KeyG', {
      openGuard: () => {
        if (!this.isPlayerFreeControl()) return false;
        if (this.ruleUseUI.hasUsableSlots()) return true;
        this.eventBus.emit('notification:show', {
          text: this.stringsProvider.get('ruleUse', 'noneUsable'),
          type: 'info',
        });
        return false;
      },
    });
    this.stateController.registerPanel('shop', this.shopUI);
    // 暂停菜单只在**玩家自由可控**时可呼出（2026-08-18 制作人拍板：过场/对话图/加载
    // 一律禁止——正向判据，不是排除法）。canOpen 缺省已限 Exploring；openGuard 再补上
    // 状态机看不见的窗：切场/加载遮罩、持久黑幕下 state 仍是 Exploring。
    // Esc fallback 与 HUD 齿轮入口都经 togglePanel 同一闸门，单点收口。
    this.stateController.registerPanel('menu', this.menuUI, undefined, {
      openGuard: () => this.isPlayerFreeControl(),
    });
    /** T1：F2 调试坞仅 DEV 注册（门控判据与 TouchMobileControls 的「调试」chip 一致）；
     *  生产构建下 F2 与触屏调试入口都不存在。 */
    if (import.meta.env.DEV) {
      this.stateController.registerPanel('debug', this.debugPanelUI, 'F2', {
        alwaysOpenable: true,
        overlaysGameState: false,
      });
    }

    this.stateController.setEscapeFallback(() => {
      /** η2a 交接收敛：统一走 togglePanel（压栈进 UIOverlay、开暂停菜单；Esc/closePanel
       *  按栈恢复），不再手工 setState+openPauseMenu 造成压栈不平衡。 */
      this.stateController.togglePanel('menu');
    });

    const touchMount = document.getElementById('game-mount');
    if (touchMount) {
      this.touchMobileControls = new TouchMobileControls(
        this.inputManager,
        this.stateController,
        () => this.stateController.currentState,
        touchMount,
        this.stringsProvider,
      );
      // 动词按钮按真实可用性隐藏（缺片段 / 被位面禁 / 全局关）——不给玩家死按钮
      this.touchMobileControls.setVerbAvailabilityReader(
        (verb) => (verb === 'torch' || verb === 'torchGuard'
          ? this.heldPropSystem.hasPlayerControl()
          : this.playerActionSystem.isVerbUsable(verb as PlayerVerb)),
      );
      // 未读点与桌面入口条同一判据（K3）：触屏玩家一样要知道「刚才那几条还在」
      this.touchMobileControls.setPanelUnreadProvider((panel) =>
        panel === 'dialogueLog' && this.gameLogManager.unreadCount() > 0);
    }
  }

  /** F2「日志」页：深度加载与背景调试绑定验证（便于真机排查） */
  private logDepthDiag(message: string): void {
    this.debugPanelUI?.log(`[深度诊断] ${message}`);
  }

  /**
   * 深度图 GPU 侧 isTexture、两个自定义 GlProgram 预热，并在每步后 drain gl.getError 到调试面板。
   */
  private runDepthAndShaderGlDiagnostics(sceneId: string, dt: Texture | null, depthEnabled: boolean): void {
    const gl = tryGetWebGlFromApplication(this.renderer.app);
    if (!gl) {
      this.debugPanelUI?.log('[GL诊断] 当前渲染器无 gl（可能为 WebGPU），跳过 getError / isTexture');
      return;
    }
    if (depthEnabled && dt) {
      pixiInitTextureSourceForGpu(this.renderer.app.renderer, dt.source);
      drainWebGLErrorsToPanel(gl, (m) => this.debugPanelUI?.log(m), `${sceneId} 深度 initSource 后`);
      logDepthTextureGpuStatus(
        `${sceneId} 深度贴图(GPU)`,
        dt,
        this.renderer.app.renderer,
        gl,
        (m) => this.debugPanelUI?.log(m),
      );
    } else if (!depthEnabled) {
      this.debugPanelUI?.log(`[GL诊断] ${sceneId}: depthEnabled=false，跳过深度 GPU 探测`);
    }

    try {
      warmUpDepthOcclusionGlProgramForDiagnostics();
      this.debugPanelUI?.log('[GL诊断] DepthOcclusion GlProgram 已创建/命中缓存');
    } catch (e) {
      this.debugPanelUI?.log(`[GL诊断] DepthOcclusion GlProgram 失败: ${String(e)}`);
    }
    drainWebGLErrorsToPanel(gl, (m) => this.debugPanelUI?.log(m), `${sceneId} DepthOcclusion shader 后`);

    try {
      warmUpBackgroundDebugGlProgramForDiagnostics();
      this.debugPanelUI?.log('[GL诊断] BackgroundDebug GlProgram 已创建/命中缓存');
    } catch (e) {
      this.debugPanelUI?.log(`[GL诊断] BackgroundDebug GlProgram 失败: ${String(e)}`);
    }
    drainWebGLErrorsToPanel(gl, (m) => this.debugPanelUI?.log(m), `${sceneId} BackgroundDebug shader 后`);

    drainWebGLErrorsToPanel(gl, (m) => this.debugPanelUI?.log(m), `${sceneId} depthLoader 收尾`);
  }

  private setupSceneReadyHandler(): void {
    // 点火表演（A3.8）：交互系统在可燃物上按 E 时发；表演自己判条件，拒绝时什么都不动
    this.listenEvent('burn:igniteRequested', (p: { targetId?: string }) => {
      if (this.gameConfig.playerActs?.ignite?.enabled === false) return;
      const id = typeof p?.targetId === 'string' ? p.targetId : '';
      if (id) this.ignitePerformer.start(id);
    });
    // 读档 = 换时间线：在途的点火表演作废（状态由读档流程恢复，不在这里还）
    this.listenEvent('save:restoring', () => { this.ignitePerformer.abort(false); });
    this.listenEvent('scene:beforeUnload', () => {
      this.burnSceneReadyId = null;
      this.ignitePerformer.abort();
      this.patrolGeneration++;
      this.npcPatrolEpoch.clear();
      /**
       * 在途轨迹整批作废（不落姿、还原叠加量）。必须在这一步做，不能指望实体自拆通知：
       * NPC 销毁会触发抢占回调，但**玩家跨场景长活、不在任何卸载名单里**，相机同理——
       * 漏掉就是下一场顶着上一场的叠加旋转/缩放/透明度（见 [[teardown-ordering]]）。
       */
      this.trajectorySystem.cancelAll();
      // 透视缩放随场景走：先清句柄防旧场景系数漂到新场景（NPC/热点随实例销毁）
      this.perspectiveScaleResolver = null;
      this.perspectiveCameraFollow = null;
      this.player.setPerspectiveScale(null);
      for (const h of this.sceneManager.getCurrentHotspots()) {
        const f = h.detachDepthOcclusionFilter();
        if (f) {
          this.sceneDepthSystem.removeFilter(f);
          f.destroy();
        }
      }
    });
    this.listenEvent('scene:ready', () => {
      this.burnSceneReadyId = this.sceneManager.currentSceneData?.id ?? null;
      this.player.syncMovementFromScene(this.sceneManager.currentSceneData);
      // 换场景 = 姿态复位（姿态不跨场景、不入存档）
      this.playerActionSystem.onSceneChanged();
      // 旧场景的 NPC 连同它们身上的挂件一起没了：挂件显示对象归 Game 所有，自己收。
      // 玩家身上的挂件例外——玩家跨场景存活，重挂由内容侧决定。
      this.destroySceneSocketViews();
      /**
       * 手持挂件重派生：演出挂件散掉，手持物（persistent 预设）按玩法事实重挂 ——
       * 实体是新建出来的，视图、灯、效果都要重贴。同时换上本场景配了 `follow` 的作者灯。
       * 与位面对账器同一个形状：每个边界重派生一次，系统自己零表现态持久化。
       */
      this.heldPropSystem.onSceneChanged(
        (this.sceneManager.currentSceneData?.lighting?.lights ?? []).filter((l) => l.follow),
      );
      // 动词提示要同步答"这张图有没有 kick 入口"，先把本场景的图拉进缓存
      this.preloadSceneDialogueGraphs();
      // 透视缩放注入须在光照滤镜/阴影创建之前：probe 采样高度按**有效**尺寸烘焙
      this.perspectiveScaleResolver = createPerspectiveScaleResolver(
        this.sceneManager.currentSceneData?.perspectiveScale,
      );
      // 相机跟随透视：没写 cameraFollow 键就恒 null，下面每帧那一步整条不跑
      this.perspectiveCameraFollow = createPerspectiveCameraFollowResolver(
        this.sceneManager.currentSceneData?.perspectiveScale,
      );
      // 进场景第一帧就该是对的景别（不是先按基线画一帧再跳）：锚点此刻就是玩家落点
      if (this.perspectiveCameraFollow) {
        this.setCameraAnchor(this.player.x, this.player.y);
        this.applyPerspectiveCameraZoom();
      }
      this.player.setPerspectiveScale(this.perspectiveScaleResolver);
      // 场景风：点亮的场景不走摆动装载钩子，这里保证每个场景都按自己的 wind 重设（没有 = 无风）
      if (!this.swayBackground) this.sceneWind.reset(this.sceneManager.currentSceneData?.wind);
      this.interactionSystem.update(0);

      this.attachPlayerSceneFilter();

      for (const npc of this.sceneManager.getCurrentNpcs()) {
        this.attachNpcSceneBits(npc);
        this.startNpcPatrolIfEligible(npc);
      }

      for (const h of this.sceneManager.getCurrentHotspots()) {
        h.setPerspectiveScale(this.perspectiveScaleResolver);
        this.attachHotspotDepthFilter(h);
      }

      this.rebuildEntityShadows();
      this.applyShadowAndAO();
      this.syncEntityPixelDensityMatch();

      // 背景调试可视化：传递当前场景的深度纹理和配置
      const sd = this.sceneManager.currentSceneData!;
      const dTex = this.sceneDepthSystem.currentDepthTexture;
      const dCfg = this.sceneDepthSystem.currentConfig;
      if (sd.depthConfig && (!dTex || !dCfg)) {
        this.logDepthDiag(
          `scene:ready ${sd.id}: JSON 含 depthConfig 但运行期无 depthTexture/config，F2 深度仍为占位`,
        );
      }
      if (dTex && dCfg) {
        this.depthDebugVisualizer.onSceneLoaded(
          this.sceneDepthSystem.currentSceneId,
          dTex,
          dTex.width,
          dTex.height,
          sd.worldWidth,
          sd.worldHeight,
          dCfg,
        );
        this.logDepthDiag(
          `scene:ready: 背景调试已绑定 uid=${dTex.uid} ${dTex.width}x${dTex.height} WHITE=${dTex === Texture.WHITE}`,
        );
        const glR = tryGetWebGlFromApplication(this.renderer.app);
        if (glR) {
          pixiInitTextureSourceForGpu(this.renderer.app.renderer, dTex.source);
          logDepthTextureGpuStatus(
            `scene:ready ${sd.id} 深度贴图(GPU)`,
            dTex,
            this.renderer.app.renderer,
            glR,
            (m) => this.debugPanelUI?.log(m),
          );
          drainWebGLErrorsToPanel(glR, (m) => this.debugPanelUI?.log(m), `scene:ready ${sd.id}`);
        }
      }
    });

    /** B11：过场进入/退出重建的实体是全新实例，scene:ready 附加的滤镜/巡逻/阴影随旧实例
     *  销毁——此处对重建实体复用 scene:ready 的附加逻辑。巡逻仅在 exit 阶段重启：
     *  enter 阶段过场拥有实体动线（自动巡逻会与 moveEntityTo 抢），与重建前行为一致。 */
    this.listenEvent(
      'scene:entitiesRebuilt',
      (p: { cutsceneId: string; phase: 'enter' | 'exit'; hotspotIds: string[]; npcIds: string[] }) => {
        for (const id of p.npcIds ?? []) {
          const npc = this.sceneManager.getNpcById(id);
          if (!npc) continue;
          // 防双协程：旧实例协程按 npcPatrolEpoch 立即失效，再按条件评估重启
          this.stopNpcPatrol(id);
          this.attachNpcSceneBits(npc);
          if (p.phase === 'exit') this.startNpcPatrolIfEligible(npc);
        }
        for (const id of p.hotspotIds ?? []) {
          const h = this.sceneManager.getCurrentHotspots().find((x) => x.def.id === id);
          if (!h) continue;
          h.setPerspectiveScale(this.perspectiveScaleResolver);
          this.attachHotspotDepthFilter(h);
        }
        // 只对本次重建的实体换阴影实例（不整体销毁重建全场），与 owner-swap 缓存一致。
        this.rebuildEntityShadowsForIds(p.npcIds ?? [], p.hotspotIds ?? []);
        this.applyShadowAndAO();
        this.syncEntityPixelDensityMatch();
      },
    );
  }

  /** scene:ready 与 scene:entitiesRebuilt 共用：为 NPC 附加光照/深度遮挡滤镜。 */
  /** 玩家场景滤镜:有烘焙载荷 → CHAR_FS 物理着色;否则旧管线(曲线/纯遮挡)。 */
  private attachPlayerSceneFilter(): void {
    const lightingOn = this.sceneDepthSystem.isLightingEnabled;
    const baked = this.characterLighting.shadingResources;
    try {
      if (baked) {
        // 烘焙场景(2026-07-25 起):着色走 sprite 网格(同 UV 采 color+normal,零逐帧驱动),
        // 遮挡走纯 DepthOcclusionFilter —— filter 只干它真擅长的屏幕空间活。
        this.player.sprite.enableBakedShading(this.litShaderProvider);
        this.playerDepthFilter = this.sceneDepthSystem.createFilterForEntity();
      } else {
        this.player.sprite.disableBakedShading();
        const playerLift = 0.4 * this.player.sprite.getWorldSize().height;
        this.playerDepthFilter = lightingOn
          ? this.sceneDepthSystem.createLightingFilterForEntity(playerLift)
          : this.sceneDepthSystem.createFilterForEntity();
      }
      if (this.playerDepthFilter) {
        depthLog('Game', 'attaching entity filter to player, lighting=', lightingOn, 'baked=', !!baked);
        this.player.sprite.container.filters = [this.playerDepthFilter];
      } else {
        depthLog('Game', 'no entity filter for player (disabled or no data)');
        this.player.sprite.container.filters = [];
      }
    } catch (e) {
      depthError('Game', 'player filter FAILED', e);
      this.playerDepthFilter = null;
      this.player.sprite.container.filters = [];
    }
  }

  /**
   * F2 切角色照明档(RT / L1 / L2 / BIN)时按需拉/卸对应资源。进场景只加载当前 mode 的资源:
   *   RT(mode 0)  → RT-gather 体素卷(20–27MB,ensureVolumes/releaseVolumes)
   *   cache(1/2/3)→ 对应 probe 图集(固化后 L2 仅 ~0.12MB,ensureProbeAtlas 只留当前 mode)
   * 时序硬约束:**必须先重挂滤镜(绑上新资源),再销毁旧纹理**——Pixi v8 的 BindGroup 见到
   * 所绑资源已 destroyed 会把自己作废,顺序反了永久烧毁滤镜。拉取失败不切档(留原档,避免采空得黑)。
   */
  private async applyCharMode(nextMode: number): Promise<void> {
    const cl = this.characterLighting;
    if (this.charModeSwitching) return;   // 加载期间重复点击去重
    this.charModeSwitching = true;
    try {
      if (nextMode < 1) {
        this.debugPanelUI?.log('[照明] 拉取 RT 体素卷…');
        if (!await cl.ensureVolumes()) {
          this.debugPanelUI?.log('[照明] 体素卷加载失败,保持原档');
          return;
        }
      } else {
        cl.releaseVolumes();                       // 从 RT 切回 cache:卸体素卷
        if (!await cl.ensureProbeAtlas(nextMode)) {
          this.debugPanelUI?.log('[照明] probe 图集加载失败,保持原档');
          return;
        }
      }
      cl.params.mode = nextMode;                   // 资源到位才真正切档
      this.reattachBakedEntityFilters();           // 先重挂(绑新资源)
      cl.disposeStaleVolumeTextures();             // 再销毁旧纹理(顺序不可反)
      cl.disposeStaleProbeTextures();
      this.debugPanelUI?.log(`[照明] 已切至 mode ${nextMode}`);
    } catch (e) {
      console.warn('Game: 角色照明切档失败', e);
    } finally {
      this.charModeSwitching = false;
    }
  }

  /** 烘焙载荷异步就绪(或 F2 开关切换)后重挂角色滤镜:scene:ready 时载荷往往还在途。 */
  private reattachBakedEntityFilters(): void {
    if (!this.sceneManager.currentSceneData) return;
    const old = this.playerDepthFilter;
    if (old) this.sceneDepthSystem.removeFilter(old);
    this.attachPlayerSceneFilter();
    for (const npc of this.sceneManager.getCurrentNpcs()) {
      const prev = npc.container.filters?.[0] as unknown as IEntityShadingFilter | undefined;
      if (prev?._isDepthOcclusion) this.sceneDepthSystem.removeFilter(prev);
      this.attachNpcSceneFilters(npc);
    }
    // 热点也随烘焙载荷/F2 开关切换在 CHAR_FS ↔ 旧遮挡间互换,与玩家/NPC 同步。
    for (const h of this.sceneManager.getCurrentHotspots()) {
      const prev = h.detachDepthOcclusionFilter();
      if (prev) { this.sceneDepthSystem.removeFilter(prev); prev.destroy(); }
      this.attachHotspotDepthFilter(h);
    }
    this.applyShadowAndAO();   // AO 广播补到新滤镜
  }

  /**
   * 单个 NPC 的「场景挂件」：透视缩放 → 逐实体光照 / 深度遮挡滤镜。
   * **顺序不能反**：透视缩放注入须在光照滤镜创建之前（probe 采样高度按**有效**尺寸烘）。
   * scene:ready / scene:entitiesRebuilt / spawnRuntimeNpc 三处共用，避免漂移。
   */
  private attachNpcSceneBits(npc: Npc): void {
    npc.setPerspectiveScale(this.perspectiveScaleResolver);
    this.attachNpcSceneFilters(npc);
  }

  private attachNpcSceneFilters(npc: Npc): void {
    if (npc.def.renderRaw) { npc.container.filters = []; return; }
    const lightingOn = this.sceneDepthSystem.isLightingEnabled;
    const baked = this.characterLighting.shadingResources;
    try {
      const npcBlend = npc.def.occlusionBlendFactor;
      let npcFilter: IEntityShadingFilter | null;
      if (baked) {
        // 同玩家:着色=sprite 网格(几何自带 UV/镜像/脚点),遮挡=纯 DepthOcclusionFilter
        npc.enableBakedShading(this.litShaderProvider);
        npcFilter = this.sceneDepthSystem.createFilterForEntity(npcBlend);
      } else {
        npc.disableBakedShading();
        const npcLift = 0.4 * npc.getWorldSize().height;
        npcFilter = lightingOn
          ? this.sceneDepthSystem.createLightingFilterForEntity(npcLift, npcBlend)
          : this.sceneDepthSystem.createFilterForEntity(npcBlend);
      }
      if (npcFilter) {
        depthLog('Game', 'attaching entity filter to NPC:', npc.id, 'lighting=', lightingOn, 'baked=', !!baked);
        npc.container.filters = [npcFilter];
      }
    } catch (e) {
      depthError('Game', 'NPC filter FAILED', npc.id, e);
    }
  }

  /** scene:ready 与 scene:entitiesRebuilt（exit 阶段）共用：条件满足则启动巡逻协程。 */
  private startNpcPatrolIfEligible(npc: Npc): void {
    const patrol = npc.def.patrol;
    if (
      npc.container.visible &&
      patrol?.route &&
      patrol.route.length > 0 &&
      !this.sceneManager.isNpcPatrolPersistentlyDisabled(npc.id)
    ) {
      this.runNpcPatrol(npc, patrol.route, patrol.speed ?? 60, patrol.moveAnimState);
    }
  }

  /**
   * 热点展示图的场景滤镜:有烘焙载荷 → CHAR_FS 物理着色(与玩家/NPC 同一 albedo×E 管线);
   * 否则旧遮挡滤镜(fallback)。热点展示图是单张静图 → 法线图按 1×1 格离线烘,与展示图同目录。
   * scene:ready / scene:entitiesRebuilt / 运行时换展示图三处共用,避免漂移。
   */
  private makeHotspotSceneFilter(h: Hotspot): IEntityShadingFilter | null {
    const baked = this.characterLighting.shadingResources;
    if (baked) {
      const f = this.sceneDepthSystem.createBakedFilterForEntity(baked, h.def.occlusionBlendFactor);
      if (f) {
        f.setNormalTexture(getNormalAtlasSource(this.assetManager, h.def.displayImage?.image));
      }
      return f;
    }
    return this.sceneDepthSystem.createFilterForEntity(h.def.occlusionBlendFactor);
  }

  /** scene:ready 与 scene:entitiesRebuilt 共用：带展示图的热点附加场景滤镜(CHAR_FS 或旧遮挡)。 */
  private attachHotspotDepthFilter(h: Hotspot): void {
    if (!h.hasDepthDisplayImage()) return;
    try {
      const hf = this.makeHotspotSceneFilter(h);
      if (hf) {
        depthLog('Game', 'attaching scene filter to hotspot display:', h.def.id,
          'baked=', !!this.characterLighting.shadingResources);
        h.attachDepthOcclusionFilter(hf);
      }
    } catch (e) {
      depthError('Game', 'hotspot depth filter FAILED', h.def.id, e);
    }
  }

  private narrativeWarps: DevNarrativeWarp[] = [];

  /** dev 启动直达路由：startDevMode 组装、start() 在 ticker 挂载后执行（见 startDevMode 注释） */
  private devStartupRoute: (() => Promise<void>) | null = null;

  /** 启动直达过场的快进起点（URL `play_cutscene_from=`）；0 = 整段常速播放 */
  private devPlayCutsceneFromStep = 0;

  private async loadNarrativeWarps(): Promise<void> {
    try {
      const data = await this.assetManager.loadJson<{ warps?: DevNarrativeWarp[] }>(
        '/assets/data/dev_narrative_warps.json',
      );
      this.narrativeWarps = Array.isArray(data?.warps) ? data.warps : [];
    } catch {
      this.narrativeWarps = [];
    }
  }

  /**
   * dev 跳转：把主流程图与各 beat 子图补到目标进度，再进对应场景。
   *
   * 主线图与 scenario 子图**走同一条路**——都用 {@link NarrativeStateManager.planRemoteAdvance}
   * 求逐跳合法路径再一跳跳推进，沿路 onEnterActions（发钱/发物/演出/派生信号）全部照常执行。
   * 一发跳到中段是错的：既跳过前序铺垫，也会被 scenario 边界守卫挡下。
   * 活计图无实例时先 startNarrativeRun 开一轮再沿链走。
   *
   * 每步都做落地复核，任何一项没到位都在收尾汇总里点名——warp 只做了半截却装作成功，
   * 是这套工具最贵的失败模式（数据漂移能潜伏到没人敢信这个菜单为止）。
   */
  private async enterNarrativeWarp(id: string): Promise<void> {
    const warp = this.narrativeWarps.find((w) => w.id === id);
    if (!warp) {
      console.warn(`enterNarrativeWarp: 找不到跳转点 "${id}"`);
      return;
    }
    const issues: string[] = [];
    if (warp.flowGraph && warp.flowState) {
      await this.advanceNarrativeForWarp(warp.flowGraph, warp.flowState, issues);
    }
    for (const st of warp.set ?? []) {
      await this.advanceNarrativeForWarp(st.graph, st.state, issues);
    }
    if (issues.length > 0) {
      // dev 下问题必须"响"在画面上（runtime 不变量七）：只写 console 的失败等于没报。
      reportDevError(
        `叙事跳转「${warp.label}」铺垫未完全到位（${issues.length} 项，场景仍会进入）：\n`
          + issues.map((s) => `  · ${s}`).join('\n'),
        '[narrative-warp]',
      );
    } else {
      console.info(`enterNarrativeWarp「${warp.label}」铺垫全部到位`);
    }
    await this.devLoadScene(warp.scene, warp.spawn);
  }

  /** warp 单张图的推进 + 落地复核；失败/降级写进 issues 供收尾汇总。 */
  private async advanceNarrativeForWarp(graphId: string, stateId: string, issues: string[]): Promise<void> {
    const plan = this.narrativeStateManager.planRemoteAdvance(graphId, stateId);
    if (!plan.ok) {
      issues.push(`${graphId}.${stateId} —— ${plan.reason}`);
      return;
    }
    if (plan.needsRun) {
      await this.narrativeStateManager.startNarrativeRun(graphId);
    }
    // 途经跳按"已经过去的历史"处理：只落结果，不重播过场/对话/等点击，否则一次跳转要手点几十下。
    // 最后一跳 = 策划要测的那一拍，完整执行（开场演出该看还得看）。
    for (let i = 0; i < plan.path.length; i += 1) {
      await this.narrativeStateManager.debugSetNarrativeState(graphId, plan.path[i], {
        silencePerformance: i < plan.path.length - 1,
      });
    }
    if (plan.direct) {
      issues.push(`${graphId}.${stateId} —— 无迁移路径，按 entry/exit 接口一发直达，中间状态的 onEnter 未执行`);
    }
    // 落地复核：置态走队列串行，守卫拒绝/代际失效都只留日志不抛，必须回读确认。
    // 停在别处但目标已 reached = 沿路 reactive 继续推进（正常语义），不算问题。
    const landed = this.narrativeStateManager.getActiveState(graphId);
    if (landed !== stateId && !this.narrativeStateManager.hasReachedState(graphId, stateId)) {
      issues.push(`${graphId}.${stateId} —— 推进后实际停在 "${landed ?? '(无实例)'}"`);
    }
  }

  /**
   * 菜单预检：按**冷启动起点**（各图 initialState）推演每条 warp 能不能把铺垫做全。
   * 纯查询不改状态，让坏掉的跳转点在菜单里就显形，而不是等策划点进去发现戏没铺到。
   */
  private inspectNarrativeWarp(warp: DevNarrativeWarp): string[] {
    const problems: string[] = [];
    const check = (graphId: string, stateId: string): void => {
      const graph = this.narrativeStateManager.getGraph(graphId);
      const plan = this.narrativeStateManager.planRemoteAdvance(graphId, stateId, {
        from: graph?.initialState,
      });
      if (!plan.ok) problems.push(`${graphId}.${stateId} —— ${plan.reason}`);
      else if (plan.direct) problems.push(`${graphId}.${stateId} —— 只能一发直达，中间 onEnter 不跑`);
    };
    if (warp.flowGraph && warp.flowState) check(warp.flowGraph, warp.flowState);
    for (const st of warp.set ?? []) check(st.graph, st.state);
    return problems;
  }

  private async startDevMode(
    playCutscene?: string,
    waterPreview?: string,
    sugarWheelPreview?: string,
    paperCraftPreview?: string,
    devScene?: string,
    narrativeWarp?: string,
    visualCapture: boolean = false,
  ): Promise<void> {
    // 编译期常量在**方法体内**再挡一次：类方法不会因为没人调用就被摇掉，只在 start() 的
    // 调用点加门的话，这个方法连同它 new 的 DevModeUI 仍原样留在发行包里
    // （2026-09-06 实测：发行 bundle 里 DevModeUI 的文案还在）。常量 return 之后的死代码
    // 压缩器会整段删掉，DevModeUI 的引用才真正消失。
    if (!import.meta.env.DEV) return;
    const DEV_SCENE = 'dev_room';
    await this.sceneManager.loadScene(DEV_SCENE);

    await this.loadNarrativeWarps();
    this.devModeUI = new DevModeUI(this.renderer, {
      getCutsceneIds: () => this.cutsceneManager.getCutsceneIds(),
      playCutscene: (id: string) => this.devPlayCutscene(id),
      getScenes: () => this.getDevSceneEntries(),
      loadScene: (id: string) => {
        void this.devLoadScene(id);
      },
      reload: () => this.devReload(),
      getMinigameEntries: () => [
        ...this.waterMinigameManager.getInstanceList().map((e) => ({
          ...e,
          kind: 'water' as const,
        })),
        ...this.sugarWheelMinigameManager.getInstanceList().map((e) => ({
          ...e,
          kind: 'sugarWheel' as const,
        })),
        ...this.paperCraftMinigameManager.getInstanceList().map((e) => ({
          ...e,
          kind: 'paperCraft' as const,
        })),
        ...this.objectExamineManager.getInstanceList().map((e) => ({
          ...e,
          kind: 'objectExamine' as const,
        })),
      ],
      launchMinigame: (entry) => {
        this.devModeUI?.close();
        if (entry.kind === 'sugarWheel') {
          void this.sugarWheelMinigameManager.start(entry.id);
        } else if (entry.kind === 'paperCraft') {
          void this.paperCraftMinigameManager.start(entry.id);
        } else if (entry.kind === 'objectExamine') {
          void this.objectExamineManager.start(entry.id);
        } else {
          void this.waterMinigameManager.start(entry.id);
        }
      },
      getNarrativeWarps: () => this.narrativeWarps.map((w) => ({
        id: w.id,
        label: w.label,
        issues: this.inspectNarrativeWarp(w),
      })),
      enterNarrativeWarp: (id: string) => {
        // 同实例连续跳转会残留上一次的 reached/flag/任务/背包（叙事层能复位，其它系统不能），
        // 残留的 reached 会让门闸条件恒真、演出走错。按存档硬契约「新游戏 = 净化 URL 整页
        // reload、不做进程内软重置」，点击一律走冷启动直达，起点绝对干净。
        const url = new URL(window.location.href);
        url.search = '';
        url.searchParams.set('mode', 'dev');
        url.searchParams.set('narrativeWarp', id);
        window.location.assign(url.toString());
      },
      getDayNightState: () => {
        const sched = this.npcScheduleSystem.getDebugState();
        const minutes = this.dayManager.minutesOfDay;
        const sceneEnabled =
          this.sceneManager.currentSceneData?.dayNight?.enabled === true;
        const managed: Array<{ id: string; present: boolean }> = [];
        for (const npc of this.sceneManager.getCurrentNpcs()) {
          const cid = String(npc.def.characterId ?? '').trim();
          if (!cid) continue;
          // 受管 = 这个角色此刻能解析出日程落点（没配表/表条件不满足的不列）
          if (!this.npcScheduleSystem.resolvePlacement(cid, minutes)) continue;
          managed.push({ id: npc.id, present: this.npcScheduleSystem.isNpcPresentNow(npc.def) });
        }
        return {
          minutes,
          phase: this.dayManager.currentPhase,
          day: this.dayManager.currentDay,
          phases: this.dayManager.phaseList.map((p) => ({ id: p.id, label: p.label ?? p.id })),
          sceneEnabled,
          leaving: sched.leaving,
          arriving: sched.arriving,
          managed,
        };
      },
      devAdvanceTime: (minutes, transition) => {
        void this.dayManager.advanceTime(minutes, transition as TimeTransition);
      },
      devAdvanceTimeToPhase: (phase, transition) => {
        void this.dayManager.advanceTimeTo(phase, transition as TimeTransition);
      },
    });
    if (!visualCapture) this.devModeUI.open();

    this.waterMinigameManager.setOnSessionEnd(() => {
      if (!this.isDevMode) return;
      const sid = this.sceneManager.currentSceneData?.id;
      if (sid === 'dev_room') this.devModeUI?.open();
    });
    this.sugarWheelMinigameManager.setOnSessionEnd(() => {
      if (!this.isDevMode) return;
      const sid = this.sceneManager.currentSceneData?.id;
      if (sid === 'dev_room') this.devModeUI?.open();
    });
    this.paperCraftMinigameManager.setOnSessionEnd(() => {
      if (!this.isDevMode) return;
      const sid = this.sceneManager.currentSceneData?.id;
      if (sid === 'dev_room') this.devModeUI?.open();
    });
    this.objectExamineManager.setOnSessionEnd(() => {
      if (!this.isDevMode) return;
      const sid = this.sceneManager.currentSceneData?.id;
      if (sid === 'dev_room') this.devModeUI?.open();
    });

    window.__gameDevAPI = {
      // 编辑器「从运行时拉取灯位」的取数口（只读）。落盘在编辑器那边，游戏不写盘。
      getSceneLightingForEditor: () => this.getSceneLightingForEditor(),
      playCutscene: (id: string, fromStep?: number) => this.devPlayCutscene(id, fromStep),
      getCutscenePlayback: () => this.cutsceneManager.getPlaybackHudSnapshot(),
      reload: () => this.devReload(),
      isReady: () => true,
      openDevPanel: () => this.devModeUI?.open(),
      getNarrativeDebugSnapshot: () => this.buildRuntimeDebugSnapshot('dev-api'),
      clearNarrativeDebugTrace: () => this.narrativeStateManager.clearDebugTrace(),
      emitNarrativeSignal: (signal) => {
        // 私有信号需要 owner 才投得出去；控制台调试者可以带上（缺省不带＝行为不变）
        const ot = String(signal?.ownerType ?? '').trim();
        const oid = String(signal?.ownerId ?? '').trim();
        return this.narrativeStateManager.emitNarrativeSignal({
          sourceType: String(signal?.sourceType ?? '').trim() as any,
          sourceId: String(signal?.sourceId ?? '').trim(),
          signal: String(signal?.signal ?? '').trim(),
          ...(ot && oid ? { owner: { ownerType: ot, ownerId: oid } } : {}),
        });
      },
      debugSetNarrativeState: (graphId, stateId) =>
        this.narrativeStateManager.debugSetNarrativeState(String(graphId ?? '').trim(), String(stateId ?? '').trim()),
      setNarrativeState: (graphId, stateId) =>
        this.narrativeStateManager.debugSetNarrativeState(String(graphId ?? '').trim(), String(stateId ?? '').trim()),
      setDepthDebug: (enabled) => this.sceneDepthSystem.setDebugOnFilters(enabled),
      /** skyao(天穹遮蔽,乘在角色 GI 上)与全白的 blend:0=不遮蔽 1=完整。 */
      setSkyaoBlend: (v: number) => { this.characterLighting?.setSkyaoBlend(v); },
      getSkyaoBlend: () => this.characterLighting?.skyaoBlendValue ?? null,
      getSkyaoInfo: () => this.characterLighting?.skyaoInfo ?? null,
      setCharDebugView: (m: number) => { this.characterLighting?.setCharDebugView(m); },
      clearWorldFilter: () => this.renderer.clearWorldFilter(),
      setWorldFadeAlpha: (alpha) => this.cutsceneRenderer.setDebugWorldFadeAlpha(alpha),
      completeDialogueText: () => this.dialogueUI.debugCompleteText(),
      /** 过场台词的打字机一次补完（视觉 golden / 无头验证用：别截到打了一半的那一帧）。
       *  返回"刚才是否真有没打完的"，与玩家点击那一下走同一个出口。 */
      completeCutsceneText: () => this.cutsceneRenderer.completeTypewriters(),
      startMinigame: async (kind, id) => {
        this.devModeUI?.close();
        if (kind === 'water') await this.waterMinigameManager.start(id);
        else if (kind === 'sugarWheel') await this.sugarWheelMinigameManager.start(id);
        else if (kind === 'paperCraft') await this.paperCraftMinigameManager.start(id);
        else if (kind === 'objectExamine') await this.objectExamineManager.start(id);
        else {
          const request = this.pressureHoldManager.getDebugPreviewRequest(id);
          if (!request) return false;
          this.pressureHoldUI.showDebugPreview(request, 0.42);
        }
        return kind === 'water'
          ? this.waterMinigameManager.isActive
          : kind === 'sugarWheel'
            ? this.sugarWheelMinigameManager.isActive
            : kind === 'paperCraft'
              ? this.paperCraftMinigameManager.isActive
              : kind === 'objectExamine'
                ? this.objectExamineManager.isActive
                : this.pressureHoldUI.isActive();
      },
      stepFixedTicks: (ticks, dtMs) => this.debugStepTicks(ticks, dtMs),
      getMinigameDebugState: () => ({
        water: this.waterMinigameManager.getDebugVisualState(),
        sugarWheel: this.sugarWheelMinigameManager.getDebugVisualState(),
        paperCraft: this.paperCraftMinigameManager.getDebugVisualState(),
        objectExamine: this.objectExamineManager.getDebugVisualState(),
        pressureHold: this.pressureHoldUI.getDebugVisualState(),
      }),
      playAudioProbe: (id, fadeMs) => this.audioManager.playBgm(id, fadeMs),
      getAudioDebugState: () => this.audioManager.getDebugOutputState(),
      getFootstepDebugState: () => this.getFootstepDebugState(),
      setAudioListener: (cfg) => this.setAudioListenerConfig(cfg),
      suppressSceneEnterForVisualCapture: () => this.sceneManager.setSceneEnterRunner(null),
      previewBubbleAnchor: (req) => {
        const target = String(req?.target ?? '').trim();
        const subject = target ? this.resolveEmoteTarget(target) : null;
        if (!subject) return false;
        this.emoteBubbleManager.cleanupByOwner(BUBBLE_ANCHOR_PREVIEW_OWNER);
        const anchorY = Number(req?.anchorY);
        const scale = Number(req?.scale);
        this.emoteBubbleManager.showSticky(
          subject,
          String(req?.emote ?? '').trim() || '……',
          {
            ...(Number.isFinite(anchorY) ? { anchorY } : {}),
            ...(Number.isFinite(scale) && scale > 0 ? { scale } : {}),
          },
          BUBBLE_ANCHOR_PREVIEW_OWNER,
        );
        return true;
      },
      clearBubbleAnchorPreview: () => {
        this.emoteBubbleManager.cleanupByOwner(BUBBLE_ANCHOR_PREVIEW_OWNER);
      },
    };
    /** 启动直达路由（过场直启 / 场景直达 / 各小游戏预览）需要主 tick 驱动位移与小游戏
     *  update——存起来由 start() 在 `ticker.add(mainTick)` 之后调用（真实就绪信号，
     *  替代旧 300/900/450ms 魔数延时）；顺序 await 保证过场播完才进下一站。 */
    this.devStartupRoute = async () => {
      if (playCutscene) await this.devPlayCutscene(playCutscene, this.devPlayCutsceneFromStep);
      const nw = (narrativeWarp ?? '').trim();
      if (nw) {
        await this.enterNarrativeWarp(nw);
        return;
      }
      const ds = (devScene ?? '').trim();
      if (ds) {
        if (ds !== DEV_SCENE) await this.devLoadScene(ds);
        return;
      }
      const wp = (waterPreview ?? '').trim();
      if (wp) {
        this.devModeUI?.close();
        await this.waterMinigameManager.start(wp);
        return;
      }
      const swp = (sugarWheelPreview ?? '').trim();
      if (swp) {
        this.devModeUI?.close();
        await this.sugarWheelMinigameManager.start(swp);
        return;
      }
      const pcp = (paperCraftPreview ?? '').trim();
      if (pcp) {
        this.devModeUI?.close();
        await this.paperCraftMinigameManager.start(pcp);
      }
    };
  }

  /**
   * @param fromStep 顶层步下标：之前的步瞬时快进（建立底图/图层/黑边/相机/演员站位）后
   *   从该步起常速播放，供编辑器「从这一步开始播」反复调参数用。
   */
  private async devPlayCutscene(id: string, fromStep?: number): Promise<void> {
    if (this.cutsceneManager.isPlaying) return;
    this.devModeUI?.close();
    this.stateController.setState(GameState.Cutscene);
    const rawFrom = Number(fromStep);
    const ff = Number.isFinite(rawFrom) && rawFrom > 0 ? Math.floor(rawFrom) : 0;
    /** 过场抛错时也必须复位状态机（对齐 tryStartInitialPrologue），否则 GameState 卡在 Cutscene、
     *  输入被门控。startCutscene 自身 finally 已回收其资源，这里只兜 Game 层状态。 */
    try {
      await this.cutsceneManager.startCutscene(id, ff > 0 ? { fastForwardTo: ff } : undefined);
    } catch (e) {
      console.warn('DevMode: 过场播放失败', id, e);
    } finally {
      this.stateController.setState(GameState.Exploring);
    }
    if (this.isDevMode) {
      const currentScene = this.sceneManager.currentSceneData?.id;
      if (currentScene !== 'dev_room') {
        await this.sceneManager.switchScene('dev_room');
      }
      this.devModeUI?.open();
    }
  }

  private devReload(): void {
    window.location.reload();
  }

  /**
   * 开发模式场景清单：优先全量索引（`/assets/scene_index.json`，从 public/assets/scenes
   * 派生——开发服现算、打包时生成），拿不到才退回下面那份"地图节点 + game_config"派生清单。
   * 派生清单只覆盖玩家可走的节点，新建的梦境/演出/测试场景在里面永远看不见。
   */
  private async getDevSceneEntries(): Promise<
    Array<{ id: string; name: string; spawnPoints: string[] }>
  > {
    const indexed = await fetchSceneIndex();
    if (indexed.length > 0) return indexed;
    return this.getDerivedDevSceneEntries();
  }

  /** 兜底清单的 id 集：地图节点 + game_config 入口/回退 + dev_room，去重排序 */
  private getDevSceneIds(): string[] {
    const ids = new Set<string>();
    for (const sid of this.mapUI.getConfiguredSceneIds()) ids.add(sid);
    ids.add('dev_room');
    if (this.gameConfig.initialScene) ids.add(this.gameConfig.initialScene);
    if (this.gameConfig.fallbackScene) ids.add(this.gameConfig.fallbackScene);
    return Array.from(ids).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  }

  /**
   * 兜底清单（索引不可用时）：展示名取自各场景 JSON 的 name，缺省或加载失败时用 id；
   * 同时带出 spawnPoints 键（F2「场景」页的出生点下拉用；Dev 面板忽略该字段）。
   */
  private async getDerivedDevSceneEntries(): Promise<
    Array<{ id: string; name: string; spawnPoints: string[] }>
  > {
    const ids = this.getDevSceneIds();
    return Promise.all(
      ids.map(async (id) => {
        try {
          const raw = await this.assetManager.loadJson<SceneDataRaw>(sceneJsonUrl(id));
          const n = raw.name;
          const name = typeof n === 'string' && n.trim() ? n.trim() : id;
          return { id, name, spawnPoints: Object.keys(raw.spawnPoints ?? {}) };
        } catch {
          return { id, name: id, spawnPoints: [] };
        }
      }),
    );
  }

  private async devLoadScene(sceneId: string, spawnPoint?: string): Promise<void> {
    if (!sceneId || this.sceneManager.switching) return;
    this.devModeUI?.close();
    try {
      await this.sceneManager.switchScene(sceneId, spawnPoint);
      this.mapUI.setCurrentScene(sceneId);
      // dev_room 是开发模式枢纽：回到此处时再打开 Dev 面板；其它场景保持关闭以免挡画面
      if (this.isDevMode && sceneId === 'dev_room') {
        this.devModeUI?.open();
      }
    } catch (e) {
      console.warn('DevMode: failed to load scene', sceneId, e);
    }
  }

  private async tryStartInitialPrologue(): Promise<void> {
    const cutsceneId = this.gameConfig.initialCutscene;
    if (!cutsceneId) return;
    const doneFlag = this.gameConfig.initialCutsceneDoneFlag;
    if (doneFlag && this.flagStore.get(doneFlag)) return;

    this.stateController.setState(GameState.Cutscene);
    try {
      await this.cutsceneManager.startCutscene(cutsceneId);
      /** B17：过场内 setFlag 被全局黑名单拦截，「播过不再播」的标记由 Game 侧在
       *  播完后写入；失败不写（下次启动重试），并对齐 startCutscene 失败即恢复模式。 */
      if (doneFlag) this.flagStore.set(doneFlag, true);
    } catch (e) {
      console.warn('Game: 序章过场播放失败', cutsceneId, e);
    } finally {
      this.stateController.setState(GameState.Exploring);
    }
  }

  private collectSaveData(): Record<string, object> {
    const data: Record<string, object> = {
      flagStore: this.flagStore.serialize(),
    };
    for (const entry of this.registeredSystems) {
      if (entry.system) data[entry.name] = entry.system.serialize();
    }
    // 事件日志走 registeredSystems 的统一序列化通道（桶名 `gameLogManager`）——
    // 升级前它是"UI 自持状态 + 这里手工挂一桶"，那是 UI 持真相的形状，已随 K3 下沉。
    data.game = { playTimeMs: this.playTimeMs, randomState: this.runtimeRandom.getState() };
    /** 玩家站位：不进 sceneManager 的 sceneMemory（那是场景实体的覆盖桶，玩家不是场景实体），
     *  单列一桶。缺该键的旧档读回时回落到出生点（见 distributeSaveData）。 */
    data.player = { x: this.player.x, y: this.player.y, facing: this.player.facingDirection };
    return data;
  }

  private distributeSaveData(data: Record<string, object>): void {
    // 同 enterDeath：先收演出（补结算 + 归位），再作废动作批。反过来就是收尾永不执行。
    this.performanceSessions?.interruptAll('load');
    this.sceneWind.clearGust();
    this.actionExecutor.cancelPending();
    this.gameClock.cancelAll();
    // 旧档可能没有说明卡桶，但仍须取消当前这张卡。
    this.systemNoteManager.deserialize({});
    /** 读档开始信号：HUD 等纯事件驱动的展示层先清上一局残留（任务追踪等），
     *  随后各系统 deserialize 补发的事件（quest:accepted{restored} 等）重建显示。 */
    this.eventBus.emit('save:restoring', {});
    // 读档 = 换了一条时间线：在途轨迹当场作废。TrajectorySystem 自己的 deserialize 也会做，
    // 但只在存档里有 `trajectorySystem` 桶时才会被调到（旧档没有），这里补一刀兜住旧档。
    this.trajectorySystem.cancelAll();
    // 读档期间抑制 QuestManager / ArchiveManager 对 flag:changed 的反应：
    // 各系统 deserialize 会逐个 syncFlag → emit flag:changed，但此刻 scenario/narrative/档案集合
    // 可能尚未恢复，按半态重评会导致任务误判完成/激活、以及虚假“档案更新”通知。
    // 全部恢复后再放开；恢复出的状态本身自洽，无需强制重评。
    this.questManager.setRestoring(true);
    this.archiveManager.setRestoring(true);
    this.narrativePackageDirector.setRestoring(true);
    // 事件日志同样闸住：各系统 deserialize 会补发 quest:accepted{restored} / 档案重评等
    // 一大堆事件，不挡的话读一次档日志里就多出一屏假记录（K3 红线一）。
    this.gameLogManager.setRestoring(true);
    try {
      if (data['flagStore']) this.flagStore.deserialize(data['flagStore'] as Record<string, boolean | number>);
      for (const entry of this.registeredSystems) {
        if (entry.system && data[entry.name]) entry.system.deserialize(data[entry.name]);
      }
      if (!data.retrySystem) this.retrySystem.deserialize({});
      // 旧档兼容：K3 之前日志是 UI 自持的 `dialogueLog` 桶（只有对话、无序号无通道）。
      // 新桶缺席时把它迁进来——开了新版本不该把老档的记录清空。
      if (!data['gameLogManager'] && data['dialogueLog']) {
        this.gameLogManager.migrateLegacyDialogueLog(data['dialogueLog'] as { entries?: DialogueLogEntry[] });
      }
      if (data['game']) {
        this.playTimeMs = (data['game'] as any).playTimeMs ?? 0;
        this.runtimeRandom.setState((data['game'] as any).randomState);
      }
      this.restorePlayerPose(data['player']);
    } finally {
      this.questManager.setRestoring(false);
      this.archiveManager.setRestoring(false);
      this.narrativePackageDirector.setRestoring(false);
      this.gameLogManager.setRestoring(false);
    }
    // 三把火 / 气味指示器显隐是 flag 的投影：读档后按 flag 直接钉回来（不走出场动画）
    this.syncThreeFiresFromFlags();
    this.syncSmellVisibleFromFlags();
  }

  /**
   * 气味指示器显隐（玩法清单 G.6）：与三把火同款——flag 是真相（入存档），HUD 只是投影。
   * 纯开关——不碰气味系统两层状态、不自动触发，谁要它出现谁写动作。
   */
  private applySmellVisible(visible: boolean, style?: 'flare' | 'fade' | 'instant' | 'debut'): Promise<void> | void {
    this.flagStore.set(FlagKeys.smellHudVisible, visible);
    if (style === 'debut' && visible) {
      // 首次出场仪式 = 一段演出：整段切到 Cutscene 态，演完恢复原状态（同三把火）
      return this.runInGameState(GameState.Cutscene, () => Promise.resolve(this.hud.setSmellVisible(visible, style)));
    }
    return this.hud.setSmellVisible(visible, style);
  }

  private syncSmellVisibleFromFlags(): void {
    this.hud.setSmellVisible(this.flagStore.get(FlagKeys.smellHudVisible) === true, 'instant');
  }

  /**
   * 三把火 HUD 读数显隐（玩法清单 G.5）：flag 是真相（入存档），HUD 只是投影。
   * 纯开关——不碰血量、不自动触发，谁要它出现谁写动作。
   */
  private applyThreeFiresVisible(visible: boolean, style?: 'flare' | 'fade' | 'instant' | 'debut'): Promise<void> | void {
    this.flagStore.set(FlagKeys.threeFiresVisible, visible);
    if (style === 'debut' && visible) {
      // 首次出场仪式 = 一段演出：整段切到 Cutscene 态（与 startCutscene 同一把锁），演完恢复原状态
      return this.runInGameState(GameState.Cutscene, () => Promise.resolve(this.hud.setThreeFiresVisible(visible, style)));
    }
    return this.hud.setThreeFiresVisible(visible || this.yinThreatsVisible, style);
  }

  /**
   * 把一段异步的 UI/演出跑在指定游戏状态里：进入前记住原状态，结束（含抛错）恢复。
   * 与 startCutscene 动作、压力小游戏 runSegment 同一套纪律——中途别人已把状态切走则不抢回。
   */
  private async runInGameState<T>(state: GameState, run: () => Promise<T>): Promise<T> {
    const generation = this.actionExecutor.getGeneration();
    const prev = this.stateController.currentState;
    this.stateController.setState(state);
    try {
      return await run();
    } finally {
      if (generation === this.actionExecutor.getGeneration() && this.stateController.currentState === state) {
        this.stateController.setState(prev);
      }
    }
  }

  private syncThreeFiresFromFlags(): void {
    this.hud.setThreeFiresVisible(this.yinThreatsVisible || this.flagStore.get(FlagKeys.threeFiresVisible) === true, 'instant');
  }

  /** 读档待落位的玩家坐标：由 distribute 收下、由紧随其后的场景重载消费（见 restorePlayerPose）。 */
  private pendingRestorePlayerPosition: { x: number; y: number } | null = null;

  /**
   * 读档恢复玩家站位与朝向。
   * x/y **不能在这里直接写**：紧随 distribute 之后的场景重载会把玩家摆到出生点，就地写必被盖掉；
   * 故只登记待落位坐标，交给 reloadScene 透传进 loadScene 覆盖出生点。
   * 朝向不受场景装载影响，就地设即可。
   * 旧档没有 player 桶 → 待落位保持 null = 一切照旧走出生点（向后兼容，不需要升存档版本）。
   */
  private restorePlayerPose(raw: unknown): void {
    this.pendingRestorePlayerPosition = null;
    if (!raw || typeof raw !== 'object') return;
    const pose = raw as { x?: unknown; y?: unknown; facing?: unknown };
    const x = typeof pose.x === 'number' ? pose.x : Number(pose.x);
    const y = typeof pose.y === 'number' ? pose.y : Number(pose.y);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      this.pendingRestorePlayerPosition = { x, y };
    }
    if (pose.facing === 'left' || pose.facing === 'right') {
      this.player.setFacing(pose.facing === 'left' ? -1 : 1, 0);
    }
  }

  private getEntityPixelDensityMatchEffective(): boolean {
    if (this.entityPixelDensityMatchDebugOverride !== null) {
      return this.entityPixelDensityMatchDebugOverride;
    }
    return this.gameConfig.entityPixelDensityMatch === true;
  }

  /** 配置开启且能读到背景密度时，才做低通与整像素对齐（与 syncEntityPixelDensityMatch 一致） */
  private isEntityPixelDensityMatchRenderingOn(): boolean {
    const dBg = this.sceneManager.getBackgroundTexelsPerWorld();
    return dBg != null && this.getEntityPixelDensityMatchEffective();
  }

  private getEntityPixelDensityMatchBlurScaleFromConfig(): number {
    const v = this.gameConfig.entityPixelDensityMatchBlurScale;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      return DEFAULT_ENTITY_PIXEL_DENSITY_BLUR_SCALE;
    }
    return v;
  }

  /** 配置与调试覆盖合成后的强度倍率（0.05～5） */
  private getEntityPixelDensityMatchBlurScale(): number {
    const cfg = this.getEntityPixelDensityMatchBlurScaleFromConfig();
    const raw =
      this.entityPixelDensityMatchBlurScaleDebug !== null
        ? this.entityPixelDensityMatchBlurScaleDebug
        : cfg;
    return Math.min(5, Math.max(0.05, raw));
  }

  private nudgeEntityPixelDensityMatchBlurScaleDebug(delta: number): void {
    const cfg = this.getEntityPixelDensityMatchBlurScaleFromConfig();
    const cur = this.entityPixelDensityMatchBlurScaleDebug ?? cfg;
    this.entityPixelDensityMatchBlurScaleDebug = Math.min(5, Math.max(0.05, cur + delta));
    this.syncEntityPixelDensityMatch();
  }

  private clearEntityPixelDensityMatchBlurScaleDebug(): void {
    this.entityPixelDensityMatchBlurScaleDebug = null;
    this.syncEntityPixelDensityMatch();
  }

  private async setSceneEntityFieldFromAction(
    sceneId: string,
    kind: SceneEntityKind,
    entityId: string,
    fieldName: string,
    value: RuntimeFieldValue,
  ): Promise<void> {
    const currentSceneId = this.sceneManager.currentSceneData?.id ?? '';
    if (this.sceneManager.isCutsceneStagingActive() && sceneId !== currentSceneId) {
      console.warn(
        `setEntityField: 过场中忽略跨场景写入 "${sceneId}"（当前场景 "${currentSceneId || '(无)'}"）`,
      );
      return;
    }
    const checked = coerceRuntimeFieldValue(kind, fieldName, value);
    if (!checked.ok) {
      console.warn('setEntityField:', checked.error);
      return;
    }
    const stored = this.sceneManager.setEntityRuntimeField(sceneId, kind, entityId, fieldName, checked.value);
    if (!stored.ok) {
      console.warn('setEntityField:', stored.error);
      return;
    }
    if (this.sceneManager.currentSceneData?.id !== sceneId) {
      if (fieldName === 'displayImage' && kind === 'hotspot') {
        console.info(
          'setEntityField: displayImage 已写入运行态，但当前显式场景 id 为',
          this.sceneManager.currentSceneData?.id ?? '(无)',
          '与动作中的 sceneId',
          sceneId,
          '不一致；进入该场景时会合并显示。',
        );
      }
      return;
    }
    if (kind === 'npc') {
      await this.applyNpcRuntimeFieldNow(entityId, fieldName, checked.value);
    } else {
      await this.applyHotspotRuntimeFieldNow(entityId, fieldName, checked.value);
    }
  }

  private async setHotspotDisplayImageFromAction(
    sceneId: string,
    hotspotId: string,
    imagePath: string,
    worldWidthIn?: number,
    worldHeightIn?: number,
    facingIn?: 'left' | 'right',
  ): Promise<void> {
    const sid = sceneId.trim();
    const hid = hotspotId.trim();
    const path = imagePath.trim();
    if (!sid || !hid || !path) {
      console.warn('setHotspotDisplayImage: 需要 sceneId、hotspotId 与 image');
      return;
    }
    const currentSceneId = this.sceneManager.currentSceneData?.id ?? '';
    if (this.sceneManager.isCutsceneStagingActive() && sid !== currentSceneId) {
      console.warn(
        `setHotspotDisplayImage: 过场中忽略跨场景写入 "${sid}"（当前场景 "${currentSceneId || '(无)'}"）`,
      );
      return;
    }
    const pathResolved =
      path.startsWith('/') ||
      path.startsWith('http://') ||
      path.startsWith('https://') ||
      path.startsWith('assets/')
        ? path
        : this.assetManager.resolveSceneAssetPath(sid, path);
    let tex: Texture;
    try {
      tex = await this.assetManager.loadTexture(pathResolved);
    } catch (e) {
      console.warn('setHotspotDisplayImage: 贴图加载失败', pathResolved, e);
      return;
    }
    const current = this.sceneManager.currentSceneData?.id === sid
      ? this.sceneManager.getCurrentHotspots().find((x) => x.def.id === hid)
      : null;
    const sceneData = this.sceneManager.currentSceneData?.id === sid
      ? this.sceneManager.currentSceneData
      : await this.assetManager.loadSceneData(sid);
    const base = sceneData.hotspots?.find((h) => h.id === hid);
    const override = this.sceneManager.getEntityRuntimeOverride(sid, 'hotspot', hid);
    const overrideDisplay = override && 'displayImage' in override ? override.displayImage : undefined;
    const prev = current?.def.displayImage ?? overrideDisplay ?? base?.displayImage;
    const tw = Math.max(1, tex.width);
    const th = Math.max(1, tex.height);
    const hFromW = (w: number) => Math.max(0.1, Math.round((w * th) / tw * 10) / 10);
    const wFromH = (h: number) => Math.max(0.1, Math.round((h * tw) / th * 10) / 10);
    const pW =
      worldWidthIn !== undefined && Number.isFinite(worldWidthIn) && worldWidthIn > 0
        ? worldWidthIn
        : undefined;
    const pH =
      worldHeightIn !== undefined && Number.isFinite(worldHeightIn) && worldHeightIn > 0
        ? worldHeightIn
        : undefined;
    const hasW =
      typeof prev?.worldWidth === 'number' && Number.isFinite(prev.worldWidth) && prev.worldWidth > 0;
    const hasH =
      typeof prev?.worldHeight === 'number' &&
      Number.isFinite(prev.worldHeight) &&
      prev.worldHeight > 0;
    let ww: number;
    let hh: number;
    if (pW !== undefined && pH !== undefined) {
      ww = pW;
      hh = pH;
    } else if (pW !== undefined) {
      ww = pW;
      hh = hFromW(ww);
    } else if (pH !== undefined) {
      hh = pH;
      ww = wFromH(hh);
    } else if (hasW && hasH) {
      ww = prev.worldWidth;
      hh = prev.worldHeight;
    } else if (hasW) {
      ww = prev.worldWidth;
      hh = hFromW(ww);
    } else if (hasH) {
      hh = prev.worldHeight;
      ww = wFromH(hh);
    } else {
      ww = 100;
      hh = hFromW(100);
    }
    const displayImage: HotspotDisplayImage = {
      image: pathResolved,
      worldWidth: ww,
      worldHeight: hh,
    };
    if (facingIn === 'left' || facingIn === 'right') {
      displayImage.facing = facingIn;
    } else if (prev?.facing !== undefined) {
      displayImage.facing = prev.facing;
    }
    if (prev?.spriteSort !== undefined) {
      displayImage.spriteSort = prev.spriteSort;
    }
    await this.setSceneEntityFieldFromAction(sid, 'hotspot', hid, 'displayImage', displayImage);
  }

  /**
   * 仅当前会话、当前已加载场景：运行时翻转热点展示朝向，不写 Save 与 hotspot def。
   */
  private tempSetHotspotDisplayFacingFromAction(
    sceneId: string,
    hotspotId: string,
    facing: 'left' | 'right' | 'restore',
  ): void {
    const sid = sceneId.trim();
    const hid = hotspotId.trim();
    if (!sid || !hid) {
      console.warn('tempSetHotspotDisplayFacing: 需要 sceneId、hotspotId');
      return;
    }
    if (this.sceneManager.currentSceneData?.id !== sid) {
      console.warn(
        'tempSetHotspotDisplayFacing: 仅在目标场景已加载时生效（不写档，无法在离屏场景施加）。当前场景:',
        this.sceneManager.currentSceneData?.id ?? '(无)',
        '请求:',
        sid,
      );
      return;
    }
    const h = this.sceneManager.getCurrentHotspots().find((x) => x.def.id === hid);
    if (!h) {
      console.warn('tempSetHotspotDisplayFacing: 当前场景找不到热点', hid);
      return;
    }
    if (facing === 'restore') {
      h.setRuntimeDisplayFacing(null);
    } else {
      h.setRuntimeDisplayFacing(facing);
    }
  }

  private async applyNpcRuntimeFieldNow(
    npcId: string,
    fieldName: string,
    value: RuntimeFieldValue,
  ): Promise<void> {
    const npc = this.sceneManager.getNpcById(npcId);
    if (!npc) return;
    const def = npc.def as unknown as Record<string, unknown>;
    if (value === null) delete def[fieldName];
    else def[fieldName] = value;
    if (fieldName === 'x' && typeof value === 'number') npc.x = value;
    else if (fieldName === 'y' && typeof value === 'number') npc.y = value;
    else if (getRuntimeFieldDescriptor('npc', fieldName)?.apply === 'transform') {
      // apply 派发读 schema（而非再手抄一份字段名清单）：新 transform 类字段登记
      // runtime_field_schema.json 后此处自动生效（审查 P3-6）
      npc.applyInstanceTransform();
    }
    else if (fieldName === 'enabled' && typeof value === 'boolean') npc.setVisible(value);
    else if (fieldName === 'animState' && typeof value === 'string') npc.playAnimation(value);
    else if (fieldName === 'patrolDisabled' && typeof value === 'boolean') {
      if (value) this.stopNpcPatrol(npcId);
      else this.startNpcPatrolForNpc(npcId);
    } else if (fieldName === 'animFile' || fieldName === 'initialAnimState') {
      await this.reloadNpcSpriteFromDef(npc);
    }
    this.syncEntityPixelDensityMatch();
  }

  private async reloadNpcSpriteFromDef(npc: Npc): Promise<void> {
    const animFile = npc.def.animFile?.trim();
    if (!animFile) return;
    try {
      const animRaw = await this.assetManager.loadJson<AnimationSetDefInput>(animFile);
      const sheetPath = resolvePathRelativeToAnimManifest(animFile, animRaw.spritesheet);
      const tex = await this.assetManager.loadTexture(sheetPath);
      const animDef = normalizeAnimationSetDef(animRaw, tex.width, tex.height, sheetPath);
      const sockets = await loadSocketsForAnim(this.assetManager, animFile, animDef);
      npc.loadSprite(tex, animDef, npc.def.initialAnimState, sockets);
    } catch (e) {
      console.warn('setEntityField: reload NPC animation failed', npc.id, animFile, e);
    }
  }

  private async applyHotspotRuntimeFieldNow(
    hotspotId: string,
    fieldName: string,
    value: RuntimeFieldValue,
  ): Promise<void> {
    const h = this.sceneManager.getCurrentHotspots().find((x) => x.def.id === hotspotId);
    if (!h) {
      if (fieldName === 'displayImage') {
        const ids = this.sceneManager
          .getCurrentHotspots()
          .map((x) => x.def.id)
          .join(', ');
        console.warn(
          'setHotspotDisplayImage: 当前场景找不到同 id 热点，无法立刻换图（运行态已记录）。' +
            ` 请求的 hotspotId=${JSON.stringify(hotspotId)}；` +
            ` 当前场景内热点 id: [${ids || '无'}]。` +
            ' 请与场景 JSON 里 hotspots[].id 一字不差；下拉框只把不带括注的 id 写入参数。',
        );
      }
      return;
    }
    if (fieldName === 'x' && typeof value === 'number') h.setPosition(value, h.def.y);
    else if (fieldName === 'y' && typeof value === 'number') h.setPosition(h.def.x, value);
    else if (getRuntimeFieldDescriptor('hotspot', fieldName)?.apply === 'transform') {
      // 热点路径没有 NPC 那样的通用 def 写入（逐字段特化），transform 需先落 def 再应用；
      // 派发读 schema（审查 P3-6）
      const defRec = h.def as unknown as Record<string, unknown>;
      if (value === null) delete defRec[fieldName];
      else if (typeof value === 'number') defRec[fieldName] = value;
      h.applyInstanceTransform();
    } else if (fieldName === 'enabled' && typeof value === 'boolean') h.setEnabled(value);
    else if (fieldName === 'displayImage') {
      if (value === null) {
        delete h.def.displayImage;
        const oldF = h.detachDepthOcclusionFilter();
        if (oldF) {
          this.sceneDepthSystem.removeFilter(oldF);
          oldF.destroy();
        }
        h.setDisplayTexture(Texture.EMPTY, 0, 0);
      } else if (isHotspotDisplayImage(value)) {
        await this.applyHotspotDisplayImageNow(h, value);
      }
    }
    this.syncEntityPixelDensityMatch();
  }

  private async applyHotspotDisplayImageNow(
    h: ReturnType<SceneManager['getCurrentHotspots']>[number],
    displayImage: HotspotDisplayImage,
  ): Promise<void> {
    let tex: Texture;
    try {
      tex = await this.assetManager.loadTexture(displayImage.image);
    } catch (e) {
      console.warn('setEntityField: hotspot displayImage 加载失败', displayImage.image, e);
      return;
    }
    const oldF = h.detachDepthOcclusionFilter();
    if (oldF) {
      this.sceneDepthSystem.removeFilter(oldF);
      oldF.destroy();
    }
    h.def.displayImage = displayImage;
    h.setDisplayTexture(tex, displayImage.worldWidth, displayImage.worldHeight);
    if (h.hasDepthDisplayImage()) {
      try {
        const hf = this.makeHotspotSceneFilter(h);
        if (hf) {
          depthLog('Game', 'setEntityField: reattach scene filter to hotspot display:', h.def.id);
          h.attachDepthOcclusionFilter(hf);
        }
      } catch (e) {
        depthError('Game', 'setEntityField: hotspot depth filter FAILED', h.def.id, e);
      }
    }
  }

  /**
   * 按配置与背景密度同步玩家 / NPC / 热点展示的低通（仅 Pixi filters，不影响深度与碰撞）。
   */

  private syncEntityPixelDensityMatch(): void {
    const dBg = this.sceneManager.getBackgroundTexelsPerWorld();
    const on = dBg != null && this.getEntityPixelDensityMatchEffective();
    const strengthScale = this.getEntityPixelDensityMatchBlurScale();
    this.player.sprite.setPixelDensityMatchActive(on);
    this.player.sprite.applyPixelDensityMatch(dBg, strengthScale);
    for (const npc of this.sceneManager.getCurrentNpcs()) {
      npc.applyEntityPixelDensityMatch(npc.def.renderRaw ? false : on, dBg, strengthScale);
    }
    for (const h of this.sceneManager.getCurrentHotspots()) {
      h.applyEntityPixelDensityMatch(on, dBg, strengthScale);
    }
  }

  /**
   * 调试：只改内存中的当前场景 worldWidth / worldHeight；不写 JSON。「重载场景」可恢复数据文件数值。
   */
  private applyDebugSceneWorldSize(width: number, height: number): void {
    const r = this.sceneManager.applyDebugWorldSize(width, height);
    if (!r.ok) return;
    const sd = this.sceneManager.currentSceneData;
    if (!sd) return;
    this.player.syncMovementFromScene(sd);
    this.sceneDepthSystem.applyRuntimeSceneSize(
      sd.worldWidth,
      sd.worldHeight,
      r.worldToPixelX,
      r.worldToPixelY,
    );
    if (this.sceneDepthSystem.currentDepthTexture && this.sceneDepthSystem.currentConfig) {
      this.depthDebugVisualizer.updateSceneWorldSize(sd.worldWidth, sd.worldHeight);
    }
    this.syncEntityPixelDensityMatch();
  }

  /** F2 叙事调试：逐条 scenario（与 catalog 顺序一致） */
  private listScenarioDebugPanelRows(): ScenarioDebugPanelRow[] {
    const m = this.scenarioStateManager;
    const ids = m.getCatalogScenarioIds();
    const ser = m.serialize() as {
      scenarios?: Record<string, Record<string, { status: string; outcome?: unknown }>>;
      lineLifecycle?: Record<string, string>;
    };
    if (ids.length === 0) {
      return [];
    }
    const out: ScenarioDebugPanelRow[] = [];
    for (const sid of ids) {
      const life = m.getLineLifecycleState(sid);
      const manual = m.hasManualLineLifecycle(sid);
      const phases = ser.scenarios?.[sid];
      let phaseBrief = '(无 phase 存档桶)';
      if (phases && Object.keys(phases).length > 0) {
        const entries = Object.entries(phases);
        const slice = entries.slice(0, 14);
        phaseBrief = slice.map(([k, v]) => `${k}=${v.status}`).join('; ');
        if (entries.length > 14) phaseBrief += ` …(+${entries.length - 14})`;
      }
      out.push({
        id: sid,
        lifecycle: life,
        manual,
        phaseBrief,
      });
    }
    return out;
  }

  /**
   * 消费挂起的时段换装。**三道闸缺一不可**：
   * ① 探索态才换 —— 对话/过场/遭遇/小游戏进行中拆场景 = 拆掉正在播的演出；
   * ② 切场在途不换 —— 与 switchScene 并发会让两条加载互相踩（旧时间线写新状态）；
   * ③ 外观真的会变才换 —— 两个时段同图同环境时白重载一次是纯浪费还打断玩家。
   *
   * 判定放在 tick：本项目的状态控制器没有变更事件，等安全窗口只能逐帧看。
   */
  private drainPendingPhaseSwap(): void {
    if (!this.pendingPhaseSwap) return;
    if (this.stateController.currentState !== GameState.Exploring) return;
    if (this.sceneManager.switching) return;
    // ④ 上一次换装还在途不换。遮幕淡入那 500ms 里 tick 照跑、状态仍是探索态，
    //    此时再来一次时段推进会起第二条重载 —— 两条加载互相踩，且黑幕会被先完成
    //    的那条揭掉，露出还没换完的场景。`switching` 盖不住这一条：换装走的是
    //    unloadScene + loadScene，不是 switchScene。
    if (this.phaseSwapInFlight) return;
    const to = this.dayManager.currentPhase;
    const sceneId = this.sceneManager.currentSceneData?.id;
    // 无论换不换，这一拍都算消费掉：不然没配夜的场景会每帧重试。
    this.pendingPhaseSwap = false;
    if (!to || !sceneId) return;
    if (!this.sceneManager.appearanceChangesWithPhase(to)) {
      // 外观不变**不等于灯不变**（2026-08-30 审查抓到）：灯走 LightDef.phases，
      // 刻意不进时段变体（进了就有两个真相源），所以 appearanceChangesWithPhase 看不见它。
      // 「只换灯不换背景」是最常见的配法（同一张画，白天灭灯、夜里点灯），
      // 漏了这条就是「时段变了灯永远不换」——而且画面上完全看不出为什么。
      //
      // 这一路不必重载场景：重新 applyParams 即可，灯的时段过滤在 packLights 里。
      const def = this.sceneLighting.params;
      if (def) this.applySceneLightingParams(def);
      return;
    }
    // 保住站位：换的是"这个场景此刻长什么样"，不是把人送去别处。
    const pl = this.player;
    this.pendingRestorePlayerPosition = pl ? { x: pl.x, y: pl.y } : null;
    void this.reloadSceneForPhase(sceneId, this.pendingPhaseSwapTransition);
  }

  /** `timelapse`/`fade` 声明「有遮挡」时，黑幕淡入淡出的时长。 */
  private static readonly PHASE_SWAP_FADE_MS = 500;

  /**
   * 时段换装的重载 + **按作者声明的表现档遮幕**。
   *
   * `TimeTransition` 早就写着 `timelapse`/`fade` = 「有画面遮挡」，但那句话此前只被
   * NPC 日程读去决定要不要演离场 —— 黑幕谁都没盖。于是白天的街会**硬切**成夜里的街。
   * 换装是这条链上唯一知道"遮挡该盖多久"的一环，所以由它兑现。
   *
   * **画面已经被遮住时不再盖第二层**（`viewObscured`）：赌坊那一拍就是这个形状 ——
   * 过场末尾自己 `showBlackout` 交接一块黑幕，换装接手、重载完再揭幕，于是玩家
   * 从黑场里睁眼直接就是夜里的街，中间一帧白天都看不到。
   *
   * 揭幕放在 `finally`：重载失败也必须揭，否则玩家卡在纯黑屏里，比看到硬切糟得多。
   */
  private async reloadSceneForPhase(sceneId: string, transition: TimeTransition): Promise<void> {
    const covered = transitionIsCovered(transition);
    const ms = Game.PHASE_SWAP_FADE_MS;
    this.phaseSwapInFlight = true;
    try {
      if (covered && !this.sceneManager.viewObscured) {
        await this.sceneManager.showBlackout(ms);
      }
      try {
        await this.reloadScene(sceneId);
      } catch (e) {
        // 失败必须响，且不能把待落位留给下一次真正的读档（会把人送回旧坐标）。
        this.pendingRestorePlayerPosition = null;
        console.error('[Game] 时段换装失败', e);
      } finally {
        if (covered) await this.sceneManager.hideBlackout(ms);
      }
    } finally {
      this.phaseSwapInFlight = false;
    }
  }

  private async reloadScene(sceneId: string): Promise<void> {
    this.sceneManager.unloadScene();
    /** 读档落位：存档里的玩家坐标覆盖出生点。走 loadScene 的位置覆盖参数（与 changeScene 的
     *  cameraX/cameraY 同一条），落点在 onEnter **之前**，开场演出看到的就已经是存档站位。
     *  非读档路径（F2 重载、dev 跳场景）待落位恒为 null，语义不变。 */
    const restorePos = this.pendingRestorePlayerPosition;
    this.pendingRestorePlayerPosition = null;
    await this.sceneManager.loadScene(sceneId, undefined, restorePos ?? undefined);
    /** η2a 交接：读档后 onEnter 可能已自动开演（对话/过场/遭遇/小游戏）——
     *  仅在没有进行中的子状态时才盖写回 Exploring，避免顶掉刚开播的演出。 */
    const s = this.stateController.currentState;
    if (
      s !== GameState.Dialogue &&
      s !== GameState.Cutscene &&
      s !== GameState.Encounter &&
      s !== GameState.Minigame
    ) {
      this.stateController.setState(GameState.Exploring);
    }
  }

  private playerNavTarget: { x: number; y: number } | null = null;
  private playerNavFrames = 0;
  private playerNavPrev: { x: number; y: number } | null = null;
  private playerNavStuck = 0;

  private setPlayerNavTarget(x: number, y: number): void {
    this.playerNavTarget = { x, y };
    this.playerNavFrames = 0;
    this.playerNavPrev = null;
    this.playerNavStuck = 0;
  }

  /** 每帧把玩家朝导航目标推进（用与触屏一致的移动轴，走真实移动/碰撞），到达或超时即停。非阻塞。
   *  卡住时改为只沿单轴走、并在 x/y 间交替，以滑动绕过简单障碍（非完整寻路）。 */
  /**
   * act_spot 的动词提示：act_spot 不出 E 提示（hotspotOffersPlayerInteraction 对它返 false），
   * 玩家全靠这行键名知道「这儿能躺/能跳过去」。只在 PlayerActionSystem 判定变化时调。
   */
  private actSpotPromptId: string | null = null;

  private applyActSpotPrompt(hotspotId: string | null, keyLabel: string): void {
    if (this.actSpotPromptId && this.actSpotPromptId !== hotspotId) {
      const prev = this.sceneManager
        .getCurrentHotspots()
        .find((h) => h.def.id === this.actSpotPromptId);
      prev?.hidePrompt();
    }
    this.actSpotPromptId = hotspotId;
    if (!hotspotId) return;
    const hs = this.sceneManager.getCurrentHotspots().find((h) => h.def.id === hotspotId);
    // 提示词是玩家可见文本，可能含 [tag:…]（编辑器给 promptKey 用的就是 RichTextLineEdit）
    hs?.showPrompt(this.resolveDisplayText(keyLabel) || 'C');
  }

  /**
   * 图入口探针（同步）：该图有没有叫这个名字的节点。
   * 只查 AssetManager 已缓存的 JSON——`preloadSceneDialogueGraphs` 在 scene:ready
   * 把本场景实体引用的图拉进缓存，所以提示不必等异步。没缓存到就当"没这个入口"，
   * 顶多是这一帧不出提示，不会误开图。
   */
  private graphHasEntry(graphId: string, entry: string): boolean {
    const gid = graphId.trim();
    const key = entry.trim();
    if (!gid || !key) return false;
    const raw = this.assetManager.getJson<{ nodes?: Record<string, unknown> }>(
      dialogueGraphJsonUrl(gid),
    );
    return !!raw?.nodes && Object.prototype.hasOwnProperty.call(raw.nodes, key);
  }

  /**
   * 把本场景实体引用到的对话图拉进 JSON 缓存，供 graphHasEntry 同步作答。
   * 容错：单张图加载失败只是它不出动词提示，不影响场景。
   */
  private preloadSceneDialogueGraphs(): void {
    const ids = new Set<string>();
    for (const npc of this.sceneManager.getCurrentNpcs()) {
      const gid = (npc.def.dialogueGraphId || '').trim();
      if (gid) ids.add(gid);
    }
    for (const h of this.sceneManager.getCurrentHotspots()) {
      if (h.def.type !== 'inspect') continue;
      const d = h.def.data as { graphId?: unknown };
      const gid = typeof d.graphId === 'string' ? d.graphId.trim() : '';
      if (gid) ids.add(gid);
    }
    for (const gid of ids) {
      void this.assetManager
        .loadJson(dialogueGraphJsonUrl(gid))
        .catch(() => { /* 该图不出动词提示即可，不打断场景 */ });
    }
  }

  private updatePlayerNav(): void {
    const t = this.playerNavTarget;
    if (!t) return;
    const dx = t.x - this.player.x;
    const dy = t.y - this.player.y;
    if (Math.hypot(dx, dy) < 14 || this.playerNavFrames > 1200) {
      this.playerNavTarget = null;
      this.playerNavPrev = null;
      this.inputManager.setTouchMoveAxes(0, 0);
      return;
    }
    if (this.playerNavPrev) {
      const moved = Math.hypot(this.player.x - this.playerNavPrev.x, this.player.y - this.playerNavPrev.y);
      this.playerNavStuck = moved < 0.6 ? this.playerNavStuck + 1 : 0;
    }
    this.playerNavPrev = { x: this.player.x, y: this.player.y };
    this.playerNavFrames += 1;
    let ax: -1 | 0 | 1 = dx > 6 ? 1 : dx < -6 ? -1 : 0;
    let ay: -1 | 0 | 1 = dy > 6 ? 1 : dy < -6 ? -1 : 0;
    if (this.playerNavStuck > 6) {
      // 卡住：交替只走 x 或只走 y，沿墙滑动绕障
      const useX = Math.floor(this.playerNavFrames / 26) % 2 === 0;
      if (useX && ax !== 0) ay = 0;
      else if (!useX && ay !== 0) ax = 0;
      else if (ax === 0) ay = this.playerNavFrames % 52 < 26 ? 1 : -1;
      else ax = this.playerNavFrames % 52 < 26 ? 1 : -1;
    }
    this.inputManager.setTouchMoveAxes(ax, ay);
  }

  /** 玩家视角观测：只含玩家可感知信息（位置/可见实体/交互提示/对话/HUD/模式），
   *  不含 flag/任务状态码/scenario/narrative 等幕后状态。供数据驱动的玩家同构测试。 */
  private getPlayerView(): Record<string, unknown> {
    const gs = String(this.stateController.currentState);
    const modeMap: Record<string, string> = {
      MainMenu: 'menu', Exploring: 'exploring', ActionSequence: 'busy',
      Dialogue: 'dialogue', Encounter: 'encounter', Cutscene: 'cutscene',
      UIOverlay: 'menu', Minigame: 'minigame', Dead: 'dead',
    };
    return {
      mode: modeMap[gs] ?? gs,
      scene: this.sceneManager.currentSceneData?.name ?? this.sceneManager.currentSceneData?.id ?? null,
      player: {
        x: this.player.x,
        y: this.player.y,
        facing: this.player.facingDirection,
        // 姿态是玩家自己看得见的身体状态，属 playerView 合法内容（不是 flag/节点 id）
        posture: this.playerActionSystem.getPosture(),
      },
      entities: this.interactionSystem.getPlayerVisibleEntities(),
      interactionPrompt: this.interactionSystem.getNearestPrompt(),
      dialogue: this.graphDialogueManager.getPlayerDialogue(),
      hud: {
        coins: this.inventoryManager.getCoins(),
        questTracker: this.hud.getQuestHintText(),
      },
      navTargetActive: this.playerNavTarget !== null,
    };
  }

  private buildRuntimeDebugSnapshot(reason: string): Record<string, unknown> {
    return {
      reason,
      capturedAt: new Date().toISOString(),
      currentSceneId: this.sceneManager.currentSceneData?.id ?? null,
      gameState: this.stateController.currentState,
      previousGameState: this.stateController.previousState,
      flags: this.flagStore.serialize(),
      questState: this.questManager.serialize(),
      scenarioState: this.scenarioStateManager.serialize(),
      narrativeEval: this.graphDialogueManager.getNarrativeEvalDebug(),
      narrativeState: this.narrativeStateManager.debugSnapshot(),
      documentReveals: this.documentRevealManager.debugSnapshot(),
      eventTrace: this.eventBus.getDebugTrace(),
      health: this.healthSystem.snapshot(),
      retry: this.retrySystem.snapshot(),
      healthThreats: this.healthThreatSystem.snapshot(),
      fireProtection: this.fireProtectionSystem.snapshot(),
      windGust: this.sceneWind.gustSnapshot,
      saveData: this.collectSaveData(),
      runtimeRandomState: this.runtimeRandom.getState(),
      activeZones: [...this.zoneSystem.getActiveZoneIds()].sort(),
      /** 当前出「按 E」提示的 zone（ZoneDef.onInteract）；null = 没有。无头验证据此断言。 */
      zoneInteractPrompt: this.interactionSystem.getPromptedZoneId(),
      uiState: this.stateController.getDebugState(),
      hudVisualState: this.fixedTickMode ? this.hud.getDebugVisualState() : null,
      renderState: {
        ...this.renderer.getDebugRenderState(),
        ...this.sceneManager.getDebugRenderState(),
      },
      entityVisualState: this.fixedTickMode ? {
        player: {
          x: this.player.x,
          y: this.player.y,
          visible: this.player.sprite.container.visible,
          animation: this.player.sprite.getDebugVisualState(),
        },
        npcs: this.sceneManager.getDebugEntityVisualState(),
      } : null,
      audioState: {
        currentBgmId: this.audioManager.getRequestedBgmId(),
        ambientIds: this.audioManager.getRequestedAmbientIds().sort(),
        volumes: this.audioManager.serialize(),
      },
      inFlight: {
        runtimeReady: this.runtimeReady,
        fixedTickMode: this.fixedTickMode,
        sceneSwitching: this.sceneManager.switching,
        actionPolicyDepth: this.actionExecutor.getPolicyDepth(),
        cutscene: this.cutsceneManager.isPlaying,
        graphDialogue: this.graphDialogueManager.isActive,
        scriptedDialogue: this.dialogueManager.isActive,
        encounter: this.encounterManager.isActive,
        waterMinigame: this.waterMinigameManager.isActive,
        sugarWheelMinigame: this.sugarWheelMinigameManager.isActive,
        paperCraftMinigame: this.paperCraftMinigameManager.isActive,
        objectExamine: this.objectExamineManager.isActive,
        pressureHold: this.pressureHoldUI.isActive(),
      },
      // serialize() 已收敛为恒 {active:false}（对话不入档），快照改用只读调试 getter
      dialogue: this.graphDialogueManager.getDebugInteractionState(),
      dialogueView: this.graphDialogueManager.getDialogueViewDebug(),
      minigameDebug: {
        water: this.waterMinigameManager.getDebugVisualState(),
        sugarWheel: this.sugarWheelMinigameManager.getDebugVisualState(),
        paperCraft: this.paperCraftMinigameManager.getDebugVisualState(),
        objectExamine: this.objectExamineManager.getDebugVisualState(),
        pressureHold: this.pressureHoldUI.getDebugVisualState(),
      },
      player: { x: this.player.x, y: this.player.y, facing: this.player.facingDirection },
      playerActs: this.playerActionSystem.getDebugState(),
      planes: this.planeReconciler.getDebugState(),
      inventory: this.inventoryManager.serialize(),
      interactables: this.interactionSystem.debugListInteractables(this.player.x, this.player.y),
      playerView: this.getPlayerView(),
      runtimeCommands: {
        lastResults: this.lastRuntimeCommandResults.slice(-20),
      },
      recentPageErrors: collectRecentPageErrors(),
      bootId: this.runtimeBootId,
    };
  }

  private setupRuntimeDebugSnapshotPublishing(): void {
    if (!import.meta.env.DEV) return;
    installPageErrorTrap();
    const events = [
      'narrative:stateChanged',
      'flag:changed',
      'quest:accepted',
      'quest:completed',
      'dialogue:start',
      'dialogue:line',
      'dialogue:choices',
      'dialogue:end',
      'scene:enter',
    ];
    for (const event of events) {
      this.listenEvent(event, () => this.scheduleRuntimeDebugSnapshotPublish(event));
    }
  }

  private scheduleRuntimeDebugSnapshotPublish(reason: string): void {
    if (!import.meta.env.DEV) return;
    if (this.runtimeDebugSnapshotTimer !== null) {
      window.clearTimeout(this.runtimeDebugSnapshotTimer);
    }
    this.runtimeDebugSnapshotTimer = window.setTimeout(() => {
      this.runtimeDebugSnapshotTimer = null;
      void this.publishRuntimeDebugSnapshot(reason);
    }, 120);
  }

  private async publishRuntimeDebugSnapshot(reason: string): Promise<void> {
    if (!import.meta.env.DEV) return;
    try {
      const snapshot = this.buildRuntimeDebugSnapshot(reason);
      let body = JSON.stringify(snapshot);
      // 服务端硬上限 2MB：单条 trace 已在 EventBus 侧限幅，此处兜底防任何调试字段（活对象泄漏
      // 等）撑爆 payload 导致 413 + 主线程卡顿。失败可观测：丢掉最重的 eventTrace 并留痕，
      // 不静默重复上报大包。body.length 是 UTF-16 近似，仅在可疑时才精确测字节。
      let bytes = body.length;
      if (bytes > 500_000) bytes = new TextEncoder().encode(body).length;
      if (bytes > RUNTIME_DEBUG_SNAPSHOT_MAX_BYTES) {
        snapshot.eventTrace = `<omitted: snapshot ${bytes} bytes exceeded ${RUNTIME_DEBUG_SNAPSHOT_MAX_BYTES} cap>`;
        body = JSON.stringify(snapshot);
        if (!this.runtimeDebugSnapshotOversizeLogged) {
          this.runtimeDebugSnapshotOversizeLogged = true;
          console.warn(
            `[GameDraft runtime-debug] snapshot ${bytes} bytes exceeded cap; dropped eventTrace to avoid 413`,
          );
        }
      }
      await fetch('/__gamedraft-api/runtime-debug-snapshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
    } catch (error) {
      if (!this.runtimeDebugSnapshotErrorLogged) {
        this.runtimeDebugSnapshotErrorLogged = true;
        console.warn('[GameDraft runtime-debug] snapshot publish failed', error);
      }
    }
  }

  private setupRuntimeCommandPolling(): void {
    if (!import.meta.env.DEV) return;
    if (this.runtimeCommandPollTimer !== null) {
      window.clearInterval(this.runtimeCommandPollTimer);
    }
    this.runtimeCommandPollTimer = window.setInterval(() => {
      void this.pollRuntimeCommands();
    }, 600);
    void this.pollRuntimeCommands();
  }

  private async pollRuntimeCommands(): Promise<void> {
    if (!import.meta.env.DEV || this.runtimeCommandPollInFlight) return;
    this.runtimeCommandPollInFlight = true;
    try {
      const response = await fetch('/__gamedraft-api/runtime-command', { method: 'GET' });
      if (!response.ok) {
        if (!this.runtimeCommandPollErrorLogged) {
          this.runtimeCommandPollErrorLogged = true;
          console.warn('[GameDraft runtime-command] poll failed', response.status, response.statusText);
        }
        return;
      }
      const payload = await response.json();
      const rawCommands = Array.isArray(payload?.commands) ? payload.commands : [];
      if (rawCommands.length === 0) return;
      // 多开页签时的指向性消费：命令可带 targetBootId；与本实例不符的命令留在队列里
      // 等目标实例取走。无 targetBootId 的命令保持旧行为（任意实例可执行）。
      const commands = rawCommands.filter((c: unknown) => {
        const t = (c as { targetBootId?: unknown })?.targetBootId;
        return t === undefined || t === null || String(t) === this.runtimeBootId;
      });
      if (commands.length === 0) return;
      // 分批：每轮最多 50 条，剩余留在队列由下一轮轮询继续取——不再静默丢尾
      const batch = commands.slice(0, 50);
      const results = [];
      const consumedIds: string[] = [];
      let allBatchHaveIds = true;
      for (const command of batch) {
        const rawId = (command as { id?: unknown })?.id;
        const cid = rawId === undefined || rawId === null ? '' : String(rawId).trim();
        if (cid) consumedIds.push(cid);
        else allBatchHaveIds = false;
        try {
          results.push(await this.applyRuntimeCommand(command));
        } catch (error) {
          results.push({
            id: '',
            type: 'unknown',
            ok: false,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      this.lastRuntimeCommandResults = results;
      // 按命令 id 定向删除本实例已执行的命令：targetBootId 不符/未进本批的命令留队列。
      // 队列里混有无 id 的旧格式命令时退回整清（否则会重复执行）——服务端 POST 已补发 id，
      // 此退路仅兜历史残留文件。
      if (allBatchHaveIds && consumedIds.length > 0) {
        await fetch(
          `/__gamedraft-api/runtime-command?ids=${encodeURIComponent(consumedIds.join(','))}`,
          { method: 'DELETE' },
        );
      } else {
        await fetch('/__gamedraft-api/runtime-command', { method: 'DELETE' });
      }
      await this.publishRuntimeDebugSnapshot(
        results.every((r) => r.ok) ? 'runtime-command:complete' : 'runtime-command:failed',
      );
      if (results.some((r) => !r.ok)) {
        console.warn('[GameDraft runtime-command] command failed', results);
      }
    } catch (error) {
      if (!this.runtimeCommandPollErrorLogged) {
        this.runtimeCommandPollErrorLogged = true;
        console.warn('[GameDraft runtime-command] poll failed', error);
      }
    } finally {
      this.runtimeCommandPollInFlight = false;
    }
  }

  private applyRuntimeCommand(command: unknown): Promise<{ id: string; type: string; ok: boolean; message: string }> {
    return applyDevRuntimeCommand(command, {
      captureSnapshot: (reason) => this.publishRuntimeDebugSnapshot(reason),
      clearEventTrace: () => this.eventBus.clearDebugTrace(),
      debugExecuteAction: (action) => this.actionExecutor.executeAwait(action),
      debugSetFixedTickMode: (enabled) => {
        this.fixedTickMode = enabled;
        this.hud.setFixedTickMode(enabled);
        if (enabled) {
          this.player.sprite.resetAnimationClock();
          this.sceneManager.resetEntityAnimationClocks();
        }
      },
      debugStepTicks: (ticks, dtMs) => this.debugStepTicks(ticks, dtMs),
      clearNarrativeTrace: () => this.narrativeStateManager.clearDebugTrace(),
      emitNarrativeSignal: (signal) => this.narrativeStateManager.emitNarrativeSignal(signal as NarrativeSignal),
      debugSetNarrativeState: (graphId, stateId) => this.narrativeStateManager.debugSetNarrativeState(graphId, stateId),
      setFlag: (key, value) => this.flagStore.set(key, value),
      isFlagAllowed: (key) => this.flagStore.isKeyAllowedByRegistry(key),
      getFlagValueKind: (key) => this.flagStore.getDebugValueKind(key),
      debugSetQuestStatus: (questId, status) => this.questManager.debugSetQuestStatus(questId, status),
      debugSetScenarioPhase: (scenarioId, phase, payload) =>
        this.scenarioStateManager.debugSetScenarioPhase(scenarioId, phase, payload),
      debugSetScenarioLineLifecycle: (scenarioId, state) =>
        this.scenarioStateManager.debugSetScenarioLineLifecycle(scenarioId, state),
      debugResetScenarioProgress: (scenarioId) => this.scenarioStateManager.resetScenarioProgressForDebug(scenarioId),
      debugStartDialogueGraph: (params) => this.graphDialogueManager.startDialogueGraph(params),
      debugAdvanceDialogue: async (maxSteps) => {
        await this.graphDialogueManager.debugAdvanceUntilBlocking(maxSteps);
      },
      debugChooseDialogueOption: (params) => this.graphDialogueManager.debugChooseOption(params),
      debugSwitchScene: async (sceneId, spawnPoint) => {
        await this.actionExecutor.executeAwait({
          type: 'switchScene',
          params: { targetScene: sceneId, targetSpawnPoint: spawnPoint },
        });
        this.interactionSystem.update(0);
        this.zoneSystem.update(0);
        await this.debugWait(1);
      },
      debugTriggerHotspot: (hotspotId) => this.interactionCoordinator.debugTriggerHotspotById(hotspotId),
      debugInteractNpc: (npcId) => this.interactionCoordinator.debugInteractNpcById(npcId),
      debugWait: (durationMs) => this.debugWait(durationMs),
      debugSetPlayerPosition: (x, y, snapCamera) => this.debugSetPlayerPosition(x, y, snapCamera),
      debugSetEntityField: (kind, entityId, fieldName, value) =>
        this.setSceneEntityFieldFromAction(
          this.sceneManager.currentSceneData?.id ?? '',
          kind,
          entityId,
          fieldName,
          value as RuntimeFieldValue,
        ),
      debugMovePlayerTo: (x, y, speed, snapCamera) => this.debugMovePlayerTo(x, y, speed, snapCamera),
      debugClick: (x, y) => this.debugClick(x, y),
      debugDrag: (fromX, fromY, toX, toY, durationMs) => this.debugDrag(fromX, fromY, toX, toY, durationMs),
      debugSaveGame: (slot) => this.saveManager.save(slot),
      debugLoadGame: (slot) => this.saveManager.load(slot),
      debugReloadScene: (sceneId) => this.reloadScene(
        sceneId || this.sceneManager.currentSceneData?.id || this.gameConfig.fallbackScene,
      ),
      // 玩家输入：注入真实输入路径、即发即走（不 await 游戏逻辑，故不会卡死通道）
      playerInteract: () => this.inputManager.injectKeyJustPressed('KeyE'),
      playerAdvance: () => this.eventBus.emit('dialogue:advance', {}),
      playerChoose: (index) => this.eventBus.emit('dialogue:choiceSelected', { index }),
      playerMoveTo: (x, y) => this.setPlayerNavTarget(x, y),
      playerTap: () => this.inputManager.injectPointerDown(),
      // 身体动词：一次性动作按键注入（走真实输入路径）；姿态用 playerPosture 按住/松开
      playerAct: (verb) => {
        const key = VERB_KEYS[verb as PlayerVerb];
        if (key) this.inputManager.injectKeyJustPressed(key);
      },
      playerPosture: (posture, held) => {
        const key = posture === 'gaze' ? VERB_KEYS.gaze : VERB_KEYS.crouch;
        this.inputManager.setTouchKeyHeld(key, held !== false);
      },
      setPlayerCollisions: (enabled) => this.player.setCollisionsEnabled(enabled),
      activatePlane: (planeId) => this.planeReconciler.activatePlaneManually(planeId),
      deactivatePlane: () => this.planeReconciler.deactivateManualPlane(),
    });
  }

  private async debugWait(durationMs: number): Promise<void> {
    const ms = Math.max(1, Math.min(60_000, Math.trunc(durationMs)));
    await new Promise<void>((resolve) => window.setTimeout(resolve, ms));
  }

  private async debugStepTicks(ticks: number, dtMs?: number): Promise<void> {
    // 参数一律先夹成有限值再用：命令通道那头有兜底，但 `__gameDevAPI.stepFixedTicks` 是**裸暴露**的，
    // 少传一个 dtMs 就是 undefined/1000 = NaN → dt=NaN → 步长 `0*NaN=NaN` → 玩家世界坐标被写成 NaN。
    // 这个坏法极其阴：位移分支靠 `stepX !== 0` 放行，NaN 恰好过闸；越界/碰撞判据遇 NaN 又全是 false，
    // 于是 NaN 一路写进 sprite.x/y，相机跟着 NaN，整个世界渲染不出来且不可逆——还不报任何错。
    const count = Number.isFinite(ticks) ? Math.max(1, Math.min(200, Math.trunc(ticks))) : 1;
    const ms = Number.isFinite(dtMs) ? (dtMs as number) : 1000 / 60;
    const dt = Math.max(0.001, Math.min(0.1, ms / 1000));
    for (let index = 0; index < count; index++) {
      this.tick(dt);
      this.hud.stepFixedTick(dt);
      // 真实 Ticker 的每帧之间会回到事件循环并清空整条微任务链；单次
      // Promise.resolve 只让出一层，巡逻 moveTo→sleepWhilePaused 的第二层 continuation
      // 仍会落到下一固定帧之后。MessageChannel 让出一个完整 task，且不推进墙钟。
      await this.debugYieldEventLoopTurn();
    }
    // 固定步调试不经过 Pixi Ticker；显式提交一帧，保证截图读取的是本次逻辑状态而非已清 backbuffer。
    this.renderer.app.render();
  }

  private debugYieldEventLoopTurn(): Promise<void> {
    return new Promise<void>((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        channel.port2.close();
        resolve();
      };
      channel.port2.postMessage(null);
    });
  }

  /**
   * 过场 / 动作链 / 对话态每帧的相机锚点决策（cameraFollowActor / cameraStopFollow 驱动）：
   * 跟的是位置引用（`at`）→ 每帧求值，求不出就原地不动（不解除、不回落玩家）；
   * 有跟随目标且可解析 → 每帧锚到该实体（NPC/临时演员/玩家）实时坐标，snap=硬锁居中、
   * 否则平滑跟随（靠 camera.update 插值）；目标失效（销毁/换场景解析不到）则自动解除。
   * 无跟随目标时：fallbackToPlayer=true 锚玩家（动作链态镜头默认跟玩家），false 不动镜头
   * （过场态交由 cameraMove 摆布）。回到 Exploring 态的自动解除在主循环清除守卫处。
   */
  /**
   * 任务引导浮标的目标世界坐标（玩法文档 D8）。
   *
   * NPC 取**实时**坐标（会走动，读 def 会把箭头钉在出生点上）；热点/区域没有运行时位移，
   * 读场景定义即可（区域取多边形顶点的包围盒中心）。
   * 目标不在当前场景、或实体已被删/改名时返回 null——引导层会整枚收起，
   * 绝不画一个指向 (0,0) 的箭头（校验器另有 error 在构建期拦这类悬垂引用）。
   */
  private resolveGuidanceWorldPoint(
    sceneId: string, kind: 'npc' | 'hotspot' | 'zone', entityId: string,
  ): { x: number; y: number } | null {
    const scene = this.sceneManager.currentSceneData;
    if (!scene || scene.id !== sceneId) return null;
    if (kind === 'npc') {
      const npc = this.sceneManager.getNpcById(entityId);
      return npc ? { x: npc.x, y: npc.y } : null;
    }
    if (kind === 'hotspot') {
      // 取**活实例**而不是场景 JSON：热点可被 setSceneEntityPosition 移动，
      // 且移动持久化后重进场景拿到的是克隆对象，读原始 def 会指向搬家前的老位置
      const live = this.sceneManager.getCurrentHotspots().find((h) => h.def.id === entityId);
      return live ? { x: live.def.x, y: live.def.y } : null;
    }
    const zone = (scene.zones ?? []).find((z) => z.id === entityId);
    const poly = zone?.polygon ?? [];
    if (poly.length === 0) return null;
    let minX = poly[0].x, maxX = poly[0].x, minY = poly[0].y, maxY = poly[0].y;
    for (const p of poly) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  }

  private applyCameraFollow(fallbackToPlayer: boolean): void {
    if (this.cameraFollowRef !== null) {
      // 跟一个位置引用：这一帧求不出（曲线还没开播 / 实体暂不在）就原地不动，也不回落跟玩家——
      // 引用点还没产生，没东西可跟（2026-09-12 制作人定）。
      const p = this.evaluatePositionRefNow(this.cameraFollowRef);
      if (p) {
        this.setCameraAnchor(p.x, p.y);
        if (this.cameraFollowSnap) this.camera.snapTo(p.x, p.y);
        else this.camera.follow(p.x, p.y);
      }
      return;
    }
    if (this.cameraFollowTargetId !== null) {
      const followed = this.resolveActorFn(this.cameraFollowTargetId);
      if (followed) {
        this.setCameraAnchor(followed.x, followed.y);
        if (this.cameraFollowSnap) this.camera.snapTo(followed.x, followed.y);
        else this.camera.follow(followed.x, followed.y);
        return;
      }
      this.cameraFollowTargetId = null;
    }
    if (fallbackToPlayer) {
      this.setCameraAnchor(this.player.x, this.player.y);
      this.camera.follow(this.player.x, this.player.y);
    }
  }

  /**
   * 「渐变恢复场景 zoom」的唯一实现（对话收尾 550ms、演出收尾都走它）。
   *
   * 目标是 {@link currentPerspectiveZoom}——配了相机跟随透视的场景要回到**此刻位置该有的**
   * 景别，不是静态场景 zoom。渐变期间 zoom 仍归显式通道所有（否则连续通道会和渐变打架，
   * 每帧把它拽回目标值、550ms 的淡出变成瞬切）；渐变收尾才交回去。
   */
  private fadingRestoreCameraZoom(durationMs: number): Promise<void> {
    const p = this.cutsceneManager.fadingCameraZoom(this.currentPerspectiveZoom(), durationMs);
    return p.finally(() => { this.camera.releaseZoomOverride(); });
  }

  /** 记下这一帧镜头锚在哪（透视跟随按它求 f）。与真正摆镜头的那一句成对，不单独调。 */
  private setCameraAnchor(x: number, y: number): void {
    this.cameraAnchorX = x;
    this.cameraAnchorY = y;
  }

  /**
   * 「此刻位置该有的那个 zoom」：相机基线 zoom × 跟随点处的透视倍数。
   *
   * **没配相机跟随透视的场景恒等于 `getCameraBaselineZoom()`**——所有恢复路径照旧，
   * 一个字节的行为都不变（需求清单 A3.5）。
   */
  private currentPerspectiveZoom(): number {
    const base = this.getCameraBaselineZoom();
    const follow = this.perspectiveCameraFollow;
    if (!follow) return base;
    return base * follow.zoomRatioAt(this.cameraAnchorX, this.cameraAnchorY);
  }

  /**
   * 相机跟随透视：把 zoom 写进连续通道。显式占用期间（过场 cameraZoom / setCameraZoom /
   * 对话拉近 / 调试滚轮）Camera 自己让位，这里不必判。没配跟随的场景整条不跑。
   */
  private applyPerspectiveCameraZoom(): void {
    if (!this.perspectiveCameraFollow) return;
    this.camera.setDrivenZoom(this.currentPerspectiveZoom());
  }

  /**
   * 瞬移（teleportEntityTo）后的镜头补正：**只有镜头此刻真锚在该实体上才 snap**。
   * - 有显式 cameraFollowActor 目标：只认它本人；
   * - 无显式目标时只有玩家是默认锚点，且只在探索/动作链态成立——过场态无目标时
   *   镜头归 cameraMove 摆布（见 applyCameraFollow(false)），抢过来会打乱运镜。
   */
  private snapCameraToActorIfFollowed(entityId: string): void {
    const state = this.stateController.currentState;
    const ref = this.cameraFollowRef;
    const anchored =
      ref !== null
        ? ref.kind === 'entity' && ref.id === entityId
        : this.cameraFollowTargetId !== null
          ? this.cameraFollowTargetId === entityId
          : entityId === 'player'
            && (state === GameState.Exploring || state === GameState.ActionSequence);
    if (!anchored) return;
    const actor = this.resolveActorFn(entityId);
    if (actor) {
      this.setCameraAnchor(actor.x, actor.y);
      this.camera.snapTo(actor.x, actor.y);
      // 瞬移跨了纵深就得当场换景别，不能等下一帧——否则跳的那一帧人物大小是错的
      this.applyPerspectiveCameraZoom();
    }
  }

  private async debugSetPlayerPosition(x: number, y: number, snapCamera: boolean): Promise<void> {
    this.player.x = x;
    this.player.y = y;
    if (snapCamera) {
      this.camera.snapTo(x, y);
    } else {
      this.camera.follow(x, y);
    }
    this.interactionSystem.update(0);
    this.zoneSystem.update(0);
    await this.debugWait(1);
  }

  private async debugMovePlayerTo(x: number, y: number, speed: number, snapCamera: boolean): Promise<void> {
    /**
     * ⚠ 三个数都要挡住"没传 / NaN"：`Math.max(1, Math.min(5000, undefined))` 是 NaN，
     * 夹值夹不住"没传"，NaN 一路写进玩家坐标 ⇒ **这一局不可逆且零报错**
     * （2026-09-12 无头验证踩到:调用方漏了 speed，人当场消失）。
     * 这是 agent 与编辑器都会调的入口,失手的代价不该是重开一局。
     */
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      console.warn(`debugMovePlayerTo: 坐标不是有限数 (x=${x}, y=${y})，忽略`);
      return;
    }
    const safeSpeed = Number.isFinite(speed) ? Math.max(1, Math.min(5000, speed)) : 200;
    const dx = x - this.player.x;
    const dy = y - this.player.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance < 0.5) {
      await this.debugSetPlayerPosition(x, y, snapCamera);
      return;
    }

    const timeoutMs = Math.min(15_000, Math.max(500, Math.ceil((distance / safeSpeed) * 1000) + 1000));
    let timeoutHandle: number | null = null;
    const timeout = new Promise<void>((resolve) => {
      timeoutHandle = window.setTimeout(resolve, timeoutMs);
    });
    await Promise.race([this.player.moveTo(x, y, safeSpeed, ANIM_WALK, true), timeout]);
    if (timeoutHandle !== null) {
      window.clearTimeout(timeoutHandle);
    }
    await this.debugSetPlayerPosition(x, y, snapCamera);
  }

  private async debugClick(x: number, y: number): Promise<void> {
    const target = this.renderer?.app?.canvas as HTMLCanvasElement | undefined;
    if (!target) return;
    this.dispatchPointerLike(target, 'pointerdown', x, y);
    this.dispatchPointerLike(target, 'pointerup', x, y);
    this.dispatchPointerLike(target, 'click', x, y);
    await this.debugWait(50);
  }

  private async debugDrag(fromX: number, fromY: number, toX: number, toY: number, durationMs: number): Promise<void> {
    const target = this.renderer?.app?.canvas as HTMLCanvasElement | undefined;
    if (!target) return;
    this.dispatchPointerLike(target, 'pointerdown', fromX, fromY);
    const steps = Math.max(2, Math.min(20, Math.ceil(durationMs / 50)));
    for (let idx = 1; idx <= steps; idx += 1) {
      const t = idx / steps;
      this.dispatchPointerLike(
        target,
        'pointermove',
        fromX + (toX - fromX) * t,
        fromY + (toY - fromY) * t,
      );
      await this.debugWait(Math.max(1, Math.floor(durationMs / steps)));
    }
    this.dispatchPointerLike(target, 'pointerup', toX, toY);
  }

  private dispatchPointerLike(target: HTMLCanvasElement, type: string, x: number, y: number): void {
    const init = {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      buttons: type === 'pointerup' || type === 'click' ? 0 : 1,
    };
    try {
      target.dispatchEvent(new PointerEvent(type, init));
    } catch {
      target.dispatchEvent(new MouseEvent(type === 'pointermove' ? 'mousemove' : type === 'pointerup' ? 'mouseup' : 'mousedown', init));
    }
  }

  private listenEvent(event: string, fn: (...args: any[]) => void): void {
    this.eventBus.on(event, fn);
    this.boundCallbacks.push({ event, fn });
  }

  private addWindowListener(event: string, fn: EventListener): void {
    window.addEventListener(event, fn);
    this.boundWindowListeners.push({ event, fn });
  }

  getSaveManager(): SaveManager { return this.saveManager; }
  getAudioManager(): AudioManager { return this.audioManager; }

  getDebugPanel(): DebugPanelUI {
    return this.debugPanelUI;
  }

  destroy(): void {
    if (this.tearDownComplete) return;
    this.tearDownComplete = true;

    /**
     * 脱手演出最先收：它是唯一一条**在玩家背后自己跑**的时间线，各系统一个个销毁的过程中
     * 它还会继续往已销毁的系统上发指令。按打断走（结算补齐 + 归位做满），不是一刀砍掉。
     */
    this.performanceSessions?.destroy();
    this.gameClock.cancelAll();

    /** P3：先推进巡逻代数/epoch——NPC 巡逻协程在下一个检查点立刻退出，
     *  不会在系统逐个销毁期间继续 moveTo 已销毁的实体（HMR 悬挂根因）。 */
    this.patrolGeneration++;
    this.npcPatrolEpoch.clear();
    // 同一个理由：轨迹的世代号也先推进。这里各系统尚未逐个销毁、实体都还活着，
    // 还原叠加量是安全的；等排到 registeredSystems 里的 trajectorySystem.destroy()
    // 时场景实体已被 sceneManager 拆完（那时也不会漏，只是还原动作打在空气上）。
    this.trajectorySystem.cancelAll();
    this.characterLighting.destroy();

    // 生命周期对称：先摘挂点再关连接，HMR 重建时不留悬挂 observer/socket。
    this.teardownNarrativeDebugBridge();
    if (this.narrativeDebugConsoleApiInstalled) {
      // 控制台入口指着这一局的 this：不删的话，HMR 之后 `__ndbg.on()` 会往已销毁的
      // 实例上装探针（看着"开了"，其实一条都上报不了）。
      try {
        delete (window as unknown as Record<string, unknown>).__ndbg;
      } catch {
        /* ignore */
      }
      this.narrativeDebugConsoleApiInstalled = false;
    }

    if (this.mainTick && this.renderer?.app?.ticker) {
      try {
        this.renderer.app.ticker.remove(this.mainTick);
      } catch {
        /* ignore */
      }
      this.mainTick = null;
    }
    if (this.glPostRenderDrain && this.renderer?.app?.ticker) {
      try {
        this.renderer.app.ticker.remove(this.glPostRenderDrain);
      } catch {
        /* ignore */
      }
      this.glPostRenderDrain = null;
    }
    if (this.charLitFrameSync && this.renderer?.app?.ticker) {
      try {
        this.renderer.app.ticker.remove(this.charLitFrameSync);
      } catch {
        /* ignore */
      }
      this.charLitFrameSync = null;
    }
    const canvas = this.renderer?.app?.canvas as HTMLCanvasElement | undefined;
    if (canvas) {
      if (this.webglContextLostHandler) {
        canvas.removeEventListener('webglcontextlost', this.webglContextLostHandler);
      }
      if (this.webglContextRestoredHandler) {
        canvas.removeEventListener('webglcontextrestored', this.webglContextRestoredHandler);
      }
    }
    this.webglContextLostHandler = null;
    this.webglContextRestoredHandler = null;
    this.runtimeDebugLogCleanup?.();
    this.runtimeDebugLogCleanup = null;
    if (this.runtimeDebugSnapshotTimer !== null) {
      window.clearTimeout(this.runtimeDebugSnapshotTimer);
      this.runtimeDebugSnapshotTimer = null;
    }
    if (this.runtimeCommandPollTimer !== null) {
      window.clearInterval(this.runtimeCommandPollTimer);
      this.runtimeCommandPollTimer = null;
    }
    this.runtimeReady = false;
    this.runtimeCommandPollInFlight = false;

    for (const { event, fn } of this.boundCallbacks) {
      this.eventBus.off(event, fn);
    }
    this.boundCallbacks = [];

    this.cutsceneStepHudEl?.remove();
    this.cutsceneStepHudEl = null;

    for (const { event, fn } of this.boundWindowListeners) {
      window.removeEventListener(event, fn);
    }
    this.boundWindowListeners = [];

    this.unsubRendererResize?.();
    this.unsubRendererResize = null;

    // 运行时编辑模式：destroy 期不走 exit()（那条要问存盘、还要重载场景），
    // 直接拆监听/ticker/DOM 并解冻——生命周期对称，不留残留。
    this.lightingSync?.stop();
    this.lightingSync = null;
    this.acousticsSync?.stop();
    this.acousticsSync = null;
    this.vfxSync?.stop();
    this.burnSync?.stop();
    this.burnSync = null;
    this.breathingSync?.stop();
    this.breathingSync = null;
    this.breathingOverlaySystem?.destroy();
    this.swaySync?.stop();
    this.swaySync = null;
    this.terrainSync?.stop();
    this.terrainSync = null;
    this.swayPrimary = null;
    this.vfxSync = null;
    this.unsubAuthoringHotkey?.();
    this.unsubAuthoringHotkey = null;
    this.authoringMode?.destroy();
    this.authoringMode = null;

    /**
     * 面板属主契约（P3 双重 destroy 收敛）：凡 registerPanel 进 stateController 的面板
     * （quest/inventory/rules/dialogueLog/bookshelf/map/ruleUse/shop/menu/debug）由
     * stateController.destroy() 统一 close+destroy，Game 只销毁未注册的 UI。
     * debug 面板仅 DEV 注册（T1），生产下由 Game 兜底销毁。
     */
    this.inspectBox?.destroy();
    this.pickupNotification?.destroy();
    this.dialogueUI?.destroy();
    this.encounterUI?.destroy();
    this.actionChoiceUI?.destroy();
    this.pressureHoldUI?.destroy();
    this.hud?.destroy();
    this.notificationUI?.destroy();
    this.questBannerUI?.destroy();
    this.guidanceLayerUI?.destroy();
    this.bookReaderUI?.destroy();
    if (!import.meta.env.DEV) this.debugPanelUI?.destroy();
    this.devModeUI?.destroy();
    this.devModeUI = null;
    delete window.__gameDevAPI;

    /** P3：清 ?smellDebug 安装的 window 全局（共 7 个，见 start 内安装处） */
    if (this.smellDebugGlobalKeys.length > 0) {
      const w = window as unknown as Record<string, unknown>;
      for (const k of this.smellDebugGlobalKeys) delete w[k];
      this.smellDebugGlobalKeys = [];
    }

    this.interactionCoordinator?.destroy();
    this.sceneWind.clearGust();
    this.eventBridge?.destroy();
    /** 配音导演不在 registeredSystems 里（无存档态），显式摘监听 + 停在播人声 */
    this.dialogueVoiceDirector?.destroy();
    this.voiceChannel?.stopAll();
    this.debugTools?.destroy();
    this.debugTools = null;
    this.depthDebugVisualizer?.destroy();
    this.vfxConfineOverlay?.destroy();
    this.vfxConfineOverlay = null;

    this.stateController.destroy();

    this.touchMobileControls?.destroy();
    this.touchMobileControls = null;

    for (const entry of this.registeredSystems) {
      if (entry.system) entry.system.destroy();
    }
    // 摆动 mesh 通常已随场景卸载拆掉；这里兜一次（幂等），必须早于下面的资产收尾。前景层依附于它，先拆
    this.teardownForegroundLayers();
    this.swayBackground?.destroy();
    this.swayBackground = null;
    // 揭幕前闸摘掉；预编译器放行在途等待、删掉后台编译的 GL 对象（早于渲染器销毁）
    this.sceneManager.setRevealGate(null);
    this.glProgramWarmup?.destroy();
    this.glProgramWarmup = null;
    // 模块级注入复位（生命周期对称：destroy 后再 init 与首启一致；
    // 切换音的钩子还捏着已销毁那局的 eventBus，不摘就是一条跨局的死引用）
    setClueAccess(null);
    setFocusChangeSound(null);

    // 各系统/UI/桥接均已各自 off 监听后，再清空总线作为兜底；
    // 早于各 destroy() 清空会使各模块的 off() 作用在空总线上，掩盖其监听泄漏。
    this.eventBus.clear();

    // CutsceneRenderer 不在 registeredSystems 里（渲染层），显式释放 resize 订阅与演出内容
    this.cutsceneRenderer?.destroy();

    this.destroyAllSocketViews();
    this.fireHintMarker.destroy();
    // 帧动画火苗帧包装：源归 AssetManager（不毁源），包装归这里
    for (const frames of this.flameFrameCache.values()) for (const t of frames) t.destroy(false);
    this.flameFrameCache.clear();
    this.actionExecutor.destroy();
    this.flagStore.destroy();
    this.inputManager.destroy();
    this.renderer.destroy();
    // 资产缓存收尾必须放最后（各系统 destroy 可能仍触碰贴图/音频引用）：
    // 不 dispose 则 Howl 常驻 Howler 全局注册表、纹理跨实例存活，跨 HMR/编辑器预览泄漏。
    this.assetManager.dispose();
  }

  /**
   * 听者绑定**只有一条链**（脚步 / 试听 / 回音全用同一个听者）：
   * 运行时覆盖 > 场景 JSON `acousticListener` > 声学空间 `listenerBinding` > `footstep_sets.json` 的 `listener` > 相机。
   */
  private effectiveListenerBinding(): {
    mode: 'player' | 'camera' | 'entity' | 'fixed';
    entityId?: string;
    heightWu?: number;
    at?: { x: number; y: number };
    from: AudioListenerSnapshot['from'];
  } {
    const rt = this.audioListenerOverride;
    if (rt) return { ...mapListenerConfig(rt), from: 'runtime' };
    const sc = this.sceneManager.currentSceneData?.acousticListener;
    if (sc) return { mode: sc.mode, entityId: sc.entityId, from: 'scene' };
    const space = this.audioManager.getActiveAcousticSpaceDef();
    if (space) {
      // 有声学空间就按空间的绑定；空间没写 = 空间级缺省「跟玩家」（作者摆的是玩家站的地方的回音）
      const sp = space.listenerBinding;
      return sp ? { mode: sp.mode, entityId: sp.entityId, from: 'space' } : { mode: 'player', from: 'space' };
    }
    const fc = this.footstepConfig?.listener;
    if (fc) return { ...mapListenerConfig(fc), from: 'footstep' };
    return { mode: 'camera', from: 'default' };
  }

  /**
   * 解出这一帧的听者：耳点 + 朝向 + 它落在哪。
   *
   * - `player` / `entity`：脚点（**contactX/Y**，不是 x/y——NPC 可配锚点）落到行走面，抬耳高。
   * - `camera`：**镜头本身**——画面中心地面点沿视线反方向退 `backAtBaseZoomWu × (基准 zoom / 当前 zoom)`，
   *   推拉镜头因此有远近感，而改窗口大小没有。视距按 场景 `acousticListener.backAtBaseZoomWu` >
   *   `footstep_sets.json` 的 `spatial.listenerBackAtBaseZoomWu` > 600 取。
   *   ⚠ **相机听者不叠耳高**（镜头不是人），数学全在 `audioSpace.cameraListener` 一处，这里不许重算。
   * - `fixed`：钉在覆盖 / 配置给的场景点上；空间绑定的 `fixed` = 钉在作者摆的听者上。
   *
   * 耳高一律取**空间的 `earHeight`**（工作台里那一个数），绑定自带 `heightWu` 时才用它。
   *
   * 配了 `perspectiveScale` 的场景里 `world` / `ear` 已经**按透视重整过**（见 `AudioPerspective`），
   * 与作者摆的反射面不在同一个空间。所以额外回一份没重整的 `worldOrtho` 给作者面画图用——
   * 不回的话声学工作台会把听者画到坑里且不报错。
   */
  private resolveAudioListener(): AudioListenerSnapshot | null {
    if (!this.sceneManager.currentSceneData) return null;
    const resolver = this.buildAudioSpaceResolver();
    const grounded = resolver.mode === 'field';
    const space = this.audioManager.getActiveAcousticSpaceDef();
    const b = this.effectiveListenerBinding();
    const earH = b.heightWu ?? earHeightWu(space ?? {});
    const forward = cameraListener(resolver, 0, 0, 0).forward;
    const groundAt = (x: number, y: number): Vec3 => resolveWorld(resolver, { contactX: x, contactY: y, heightWu: 0 });
    // 作者面画图用的正交地面点：同一条解算链，只拔掉透视重整。
    const orthoResolver: AudioSpaceResolver = resolver.persp ? { ...resolver, persp: undefined } : resolver;
    const orthoGroundAt = (x: number, y: number): Vec3 =>
      resolveWorld(orthoResolver, { contactX: x, contactY: y, heightWu: 0 });
    const raise = (g: Vec3, h: number): Vec3 => [g[0], g[1] + h, g[2]];
    let scene: { x: number; y: number } | null = null;
    let world: Vec3;
    let ear: Vec3;
    let targetMissing = false;
    let backWu: number | undefined;
    if (b.mode === 'camera') {
      scene = { x: this.camera.getX(), y: this.camera.getY() };
      const zoom = this.camera.getZoom();
      const baseZoom = this.camera.getSceneBaseZoom();
      // 视距 = 基准 × zoom 比 ÷ f(画面中心)：zoom 是运行时推拉镜头，f 是这张画本身的透视纵深，
      // 两者相乘不相干。没配 perspectiveScale 的场景 f 恒 1，退化成原来的纯 zoom 比。
      backWu = cameraBackWu(
        resolver, scene.x, scene.y, this.listenerBackAtBaseZoomWu(),
        zoom > 1e-6 && baseZoom > 1e-6 ? baseZoom / zoom : 1,
      );
      world = groundAt(scene.x, scene.y);
      // 听者 = 镜头本身，**不叠耳高**：`ear` 到 `world` 的距离恰好是 backWu（单测锁着）。
      // 数学只有 `audioSpace.cameraListener` 一份——这里曾经自己抄过一遍并多加了耳高，
      // 结果作者旋钮写 600 而实际视距 707 wu，旋钮读数与几何对不上。
      ear = cameraListener(resolver, scene.x, scene.y, backWu, forward).pos;
    } else if (b.mode === 'fixed' && !b.at) {
      // 空间作者摆的听者：本来就是 M-world 地面点
      const L = space?.listener;
      if (!L) {
        scene = { x: this.player.contactX, y: this.player.contactY };
        world = groundAt(scene.x, scene.y);
      } else {
        world = [L.x, L.y ?? 0, L.z];
      }
      ear = raise(world, earH);
    } else {
      let x = this.player.contactX;
      let y = this.player.contactY;
      if (b.mode === 'entity') {
        const npc = b.entityId ? this.sceneManager.getNpcById(b.entityId) : null;
        if (npc) { x = npc.contactX; y = npc.contactY; } else targetMissing = true;   // 不在场：回落玩家，别静默变哑
      } else if (b.mode === 'fixed' && b.at) {
        x = b.at.x; y = b.at.y;
      }
      scene = { x, y };
      world = groundAt(x, y);
      ear = raise(world, earH);
    }
    const persp = resolver.persp;
    return {
      scene, world, ear, forward, grounded, mode: b.mode, from: b.from,
      entityId: b.entityId, targetMissing, backWu,
      // 钉在作者点上的 fixed 听者本来就没过解算链（scene === null），不存在重整一说
      worldOrtho: persp && scene ? orthoGroundAt(scene.x, scene.y) : undefined,
      perspF: persp && scene ? persp.scaleAt(scene.x, scene.y) : undefined,
    };
  }

  /** 实时联动回传用：最近一次喂给声学的听者。 */
  getAcousticListenerSnapshot(): AudioListenerSnapshot | null {
    return this.acousticListenerLast;
  }

  /**
   * 每帧把解出来的听者喂给 AudioManager（内部按尺度节流重算 IR；直达声逐声音现算不受节流）。
   *
   * 没有这一步，听者永远钉在作者摆的那个点上，玩家走到崖边和站在路中间是同一个
   * 回音 —— 那实时就没有意义了。**不看有没有空间**：没空间也有直达声要按听者算。
   */
  private updateAcousticListener(force: boolean): void {
    // 音频要用户手势才有上下文：进场景时挂不上的空间在这里补挂（每帧一次极便宜的检查）
    if (this.audioManager.flushPendingAcoustic()) force = true;
    const L = this.resolveAudioListener();
    if (!L) return;
    this.acousticListenerLast = L;
    this.audioSpaceDebug = {
      mode: L.grounded ? 'field' : 'planar',
      listenerMode: L.mode + (L.targetMissing ? '→player' : ''),
      listenerFallback: !!L.targetMissing,
      backWu: L.backWu ?? 0,
      footstepSpatialized: this.footstepConfig?.defaults?.spatialized !== false,
    };
    this.audioManager.setAcousticListener(
      { x: L.ear[0], y: L.ear[1], z: L.ear[2] }, L.forward, force,
    );
  }

  /**
   * 世界是否**暂停**。一个判据供所有"该跟着游戏时钟走"的东西共用：
   * 轨迹、阵风、草木、挂件、燃烧、粒子、角色动画、镜头、落雷的灯，以及**演出时钟**
   * （`waitMs` / 天色渐变 / 连劈间隔 / 雷柱软停）。
   *
   * ⚠ **UI 自己的东西不吃这个闸**：提示条在面板开着时照常弹（2026-08-18 制作人拍板）。
   *
   * 从前这套判据在 tick 里散着写了两份（轨迹那一闸列了三个状态、说明卡与死亡另走早返回），
   * 加一个暂停源就得记得改两处——2026-09-19 收成这一处。
   */
  private isWorldPaused(): boolean {
    if (this.systemNotePauseDepth > 0) return true;
    const s = this.stateController.currentState;
    return s === GameState.SceneTransition
      || s === GameState.MainMenu
      || s === GameState.UIOverlay
      || s === GameState.Dead;
  }

  private tick(dt: number): void {
    /**
     * 引导浮标的「收起来」判据必须每帧现算，且**排在下面所有 early-return 之前**：
     * 它是写在容器上的可见性状态，停一帧就把上一帧的可见性冻住——说明卡 / 死亡这条
     * 第一行就 return，于是浮标会挂在说明卡与死亡画面上不走。
     * （位置重算跟着世界暂停停没关系：暂停时镜头也不动。）
     */
    this.guidanceLayerUI?.applyVisibility();
    // 说明卡阅读与死亡期间冻结世界时钟（火把、阵风、侵袭、主动防护），UI 仍可点击。
    if (this.systemNotePauseDepth > 0 || this.stateController.currentState === GameState.Dead) {
      this.inputManager.endFrame();
      return;
    }
    this.lastFps = dt > 0 ? 1 / dt : 0;
    this.playTimeMs += dt * 1000;
    const worldPaused = this.isWorldPaused();
    // 演出时间只在世界没暂停时前进：翻背包出来，雷该停在原处而不是已经劈完了
    if (!worldPaused) this.gameClock.advance(dt);

    this.camera.setPixelSnapTranslation(this.isEntityPixelDensityMatchRenderingOn());

    // 位面对账先于 Exploring 分支：回 Exploring 边沿挂起的 zone 重注册（pendingZoneRefresh）
    // 必须在本帧 zoneSystem.update 之前补刷，否则旧位面 zone 会以过期集合多跑一帧 enter/stay。
    this.planeReconciler.update(dt);
    // 气缕飘向按玩家相对气味源每帧现算（G.6）：不分探索/演出态——演出里走位也该跟着歪
    this.smellSystem.update(dt);
    // 画布实体的动画：**不分探索 / 演出态**（画布本就是演出面，对话与过场里照样要动），
    // 但**吃暂停闸**——暂停一览表里「角色动画」是停的那一列（world-pause-and-game-clock），
    // 画布实体也是角色，同一条待遇。
    if (!worldPaused) this.canvasStageSystem.update(dt);
    // 呼吸图:同吃暂停闸(暂停时胸口、纸都停住,呼吸声靠看门狗自己落下去);演出面,不分探索 / 演出态
    if (!worldPaused) this.breathingOverlaySystem.update(dt);
    // 时段换装：等一个"没人在演、也没在切场"的安全窗口再动场景（见 pendingPhaseSwap）。
    this.drainPendingPhaseSwap();
    // 日程演出（离场/入场走位）：内部自判探索态，非探索态原地挂起。
    this.npcScheduleSystem.update(dt);

    // 相机跟随（cameraFollowActor）是"演出期间"的临时行为：Cutscene / ActionSequence（锁玩家的
    // 动作链）/ Dialogue（对话图）态才消费；一旦回到玩家自由探索态（Exploring）——无论过场、
    // 动作链还是对话播完——立即解除跟随、复位回跟玩家，不必显式 cameraStopFollow。
    // （读档/切场景也会经 Exploring 归零。）
    if ((this.cameraFollowTargetId !== null || this.cameraFollowRef !== null) &&
        this.stateController.currentState === GameState.Exploring) {
      this.cameraFollowTargetId = null;
      this.cameraFollowRef = null;
    }

    // 身体动词每帧都跑（不只 Exploring）：它自己按 canAcceptInput 门控，
    // 非探索态负责把姿态复位——否则进对话时蹲着不起来、动画所有权还卡在它手里。
    // 位置在 Exploring 分支之前：本帧设的锁腿/姿态要赶在 player.update 之前生效。
    this.playerActionSystem.update(dt);
    // ⚠ 下面两个必须**无条件**跑（不能只挂 Exploring 分支）：
    //  - 待机：演到一半切进对话时要靠这一帧归还动画所有权，否则主角站着不动；
    //  - 闲聊：进对话的那一下要靠这一帧把在飞的气泡撤掉，否则和对白的「……」气泡重叠。
    this.playerIdleBehaviorSystem.update(dt);
    this.bubbleChatterSystem.update(dt);

    if (this.stateController.currentState === GameState.Exploring) {
      this.retrySystem.update(dt);
      this.updatePlayerNav();
      this.healthSystem.update(dt);
      this.player.update(dt);
      this.fireProtectionSystem.update(dt);
      this.healthThreatSystem.update(dt);
      // 伤害可能打开死亡卡或叙事信号开始过场；同帧余下的探索输入作废。
      if (this.stateController.currentState !== GameState.Exploring) { this.inputManager.endFrame(); return; }
      // 「嗅」键（KeyV；2026-09-15 起 Q 让给按住护火）：主动闻一下当前气味，HUD 气缕短暂拔高变清。
      if (this.inputManager.wasKeyJustPressed(SNIFF_KEY)) this.smellSystem.sniff();
      this.interactionSystem.update(dt);
      // 非探索态跨时段时挂起的 zone 重注册在此补刷，且必须赶在 zoneSystem.update 之前——
      // 晚于它，过期的 zone 集合会以旧集合多跑一帧 enter/stay（与位面那条补刷同一个理由，
      // 见 planeReconciler.update 的排序注释）。没挂起时只是一次判空。
      this.sceneManager.flushPendingTimeZoneRefresh();
      this.zoneSystem.update(dt);
      for (const npc of this.sceneManager.getCurrentNpcs()) {
        npc.cutsceneUpdate(dt);
      }
      this.setCameraAnchor(this.player.x, this.player.y);
      this.camera.follow(this.player.x, this.player.y);
    }

    if (this.stateController.currentState === GameState.Cutscene) {
      this.player.cutsceneUpdate(dt);
      for (const npc of this.sceneManager.getCurrentNpcs()) {
        npc.cutsceneUpdate(dt);
      }
      for (const [, npc] of this.cutsceneManager.getTempActors()) {
        npc.cutsceneUpdate(dt);
      }
      // 过场态相机跟随（cameraFollowActor）：无跟随目标时不动镜头，交由 cameraMove 摆布。
      this.applyCameraFollow(false);
    }

    if ([GameState.Cutscene, GameState.ActionSequence, GameState.Dialogue].includes(this.stateController.currentState)) {
      this.fireProtectionSystem.update(dt);
      this.healthThreatSystem.update(dt);
      if (this.healthSystem.isDepleted()) { this.inputManager.endFrame(); return; }
    }

    // 过场对白框上的「继续」点捺：**不能挂在任何状态分支里**——过场态、对话态、
    // 甚至状态刚切换的那一帧它都可能在屏上，挂进分支就会时动时停。
    this.cutsceneRenderer.tickDialogueMarks(dt);
    // 过场台词的逐字显示，同理不挂状态分支
    this.cutsceneRenderer.tickTypewriters(dt);
    // 气泡档过场对白框跟随说话人（与 tickTypewriters 并列，恒每帧跑）
    this.cutsceneRenderer.tickDialogueBubbles();

    if (this.stateController.currentState === GameState.Dialogue) {
      this.dialogueUI.update(dt);
      this.player.cutsceneUpdate(dt);
      for (const npc of this.sceneManager.getCurrentNpcs()) {
        npc.cutsceneUpdate(dt);
      }
      // 对话态也能动镜头（2026-09-12 制作人定）：对话图里配的 cameraFollowActor 照常每帧生效；
      // 没设跟随时不动镜头（同过场态，不回落跟玩家——普通对话的镜头行为不变）。
      // 复位不用另写：对话完回到 Exploring，上面的清除守卫解除跟随，镜头平滑回到玩家。
      this.applyCameraFollow(false);
    }

    if (this.stateController.currentState === GameState.Encounter) {
      this.encounterUI.update(dt);
      this.player.cutsceneUpdate(dt);
      for (const npc of this.sceneManager.getCurrentNpcs()) {
        npc.cutsceneUpdate(dt);
      }
    }

    if (this.stateController.currentState === GameState.Minigame) {
      this.waterMinigameManager.update(dt);
      this.sugarWheelMinigameManager.update(dt);
      this.paperCraftMinigameManager.update(dt);
      this.objectExamineManager.update(dt);
      this.player.cutsceneUpdate(dt);
      for (const npc of this.sceneManager.getCurrentNpcs()) {
        npc.cutsceneUpdate(dt);
      }
    }

    // ⚠ UIOverlay（面板 / 菜单 / 说明卡）**不推角色动画**：暂停就是暂停，画面定住。
    // 2026-09-19 之前这里推 cutsceneUpdate，于是玩家开着背包时 NPC 还在原地走动画。

    if (this.stateController.currentState === GameState.ActionSequence) {
      this.player.cutsceneUpdate(dt);
      // 点火表演：玩家这一帧的位移与换帧已写完，盯接触帧 / 播完
      this.ignitePerformer.update(dt);
      for (const npc of this.sceneManager.getCurrentNpcs()) {
        npc.cutsceneUpdate(dt);
      }
      // 探索触发的动作链（zone / 热区等）会短暂进入此状态。默认镜头以玩家为锚点（否则
      // fadingZoom 与 moveEntityTo 组合会「缩放中心漂移、走动不跟镜」）；动作链里若用
      // cameraFollowActor 指定了跟随目标则改跟该 NPC，播完回 Exploring 自动复位跟玩家。
      this.applyCameraFollow(true);
    }

    /**
     * 相机跟随透视（需求清单 A3.5）：**在所有摆镜头的分支之后**，按这一帧镜头真正锚住的
     * 那个点求 zoom。放在这里而不是各分支里，是因为它对每个状态都成立——没在跟人的状态
     * （遭遇 / 小游戏 / 面板）锚点不动，zoom 自然也不动。
     * 没配 `perspectiveScale.cameraFollow` 的场景整条不跑，一次 zoom 都不多写。
     */
    this.applyPerspectiveCameraZoom();

    this.emoteBubbleManager.update(dt);
    this.notificationUI.update(dt);
    // 横幅与引导层跟着游戏时钟走（不自转 rAF）：暂停/开面板时它们也该停，
    // 否则关掉面板会发现横幅已经在背后播完了。
    // （2026-09-19：这段注释一直在，但 dt 是无条件喂的——真停下来是从这一版起。）
    if (!worldPaused) {
      this.questBannerUI.update(dt);
    }
    /**
     * 引导层**不吃世界暂停**：它没有任何动画（`update` 里 dt 根本没用），只做
     * 「收不收起来 + 浮标跟镜头」两件事。2026-09-19 把它和横幅一起收进这道闸之后，
     * 一开面板它就停在最后一帧的可见性上 = 浮标画在面板上（存档页 / 设置页截图）。
     * 横幅是真有时间线的，留在闸里。
     */
    this.guidanceLayerUI.update(dt);
    /**
     * 烘焙轨迹回放。位置有两个硬约束，别挪：
     * - **在所有状态分支之后**：过场/动作链分支里的 `applyCameraFollow` 会写相机目标点，
     *   轨迹运镜必须压得过它（同帧后写者赢），否则 `cameraFollowActor` 一开轨迹就失效；
     * - **在 `camera.update` / `sortEntityLayer` 之前**：`snapTo` 写的是 current+target，
     *   随后的 `camera.update` 平滑一步即原地；姿态里的 `entitySortFootY` 也要赶在排序前落定。
     *
     * 切场景遮罩期、标题页、覆盖面板期间不跑：实体可能正在拆建，或玩家已暂停。
     * 火把、燃料、阵风与粒子共用这一闸，不能在玩家翻背包时把火吹灭。
     * （不是"暂停"——tMs 不前进，回到正常态从原处接着播。）
     */
    if (!worldPaused) {
      this.trajectorySystem.update(dt);
      // 场景风的钟与粒子同处推进（同暂停语义）；背景摆动读同一个钟
      this.sceneWind.advance(dt);
      this.swayBackground?.update(this.sceneWind.params, this.sceneWind.time, this.sceneWind.blasts, this.sceneWind.blastTime);
      /**
       * 手持挂件 **必须排在粒子之前**：它这一帧才把火焰的锚点挪到手上、把灯推给光照系统。
       * 反过来的话粒子会拿上一帧的锚点发这一帧的火星（走得快时火焰拖在身后）。
       * 同样要求实体位置已写完 —— 所以和粒子在同一个守卫里。
       */
      this.heldPropSystem.update(dt);
      this.fireHintMarker.tick(dt);
      // 手上燃着能点火的火头 = 火焰段（可燃纸钱碰到会着）：挂点位置这一帧才定，所以排在挂件之后、粒子之前
      this.heldFireScratch.length = 0;
      this.heldPropSystem.igniterFireSegments(this.heldFireScratch);
      this.vfxSystem.setFireSources('heldProp', this.heldFireScratch);
      // 燃烧：推模拟、推火苗出生点 / 火光 / 火线火焰段——同样要赶在粒子之前（粒子这一帧就用上）
      this.burnSystem.update(dt);
      // 粒子 / 群体：同一约束——实体位置已全部写完、排序与相机之前（它写桶网格的 entitySortFootY）
      this.vfxSystem.update(dt);
      // 群体已走完本帧实际位移/惊飞判定；暂停、演出及死亡期间不侵扰玩家。
      if (this.stateController.currentState === GameState.Exploring && !this.healthSystem.isDepleted()) {
        for (const source of this.vfxSystem.playerHarassment()) {
          void this.healthSystem.applyDamage({ amount: source.attackPerSecond * dt, kind: 'fright', sourceId: source.sourceId });
          if (this.healthSystem.isDepleted()) return;
        }
      }
    }
    // 落雷的灯：与玩法**状态**无关（雷放到一半进对话也得放完），但吃**暂停**闸——
    // 开着背包时雷光一闪一闪是"世界没停"，正是这一版要治的。
    if (!worldPaused) this.updateStrikeLight(dt);
    // 暂停时喂 0：平滑不动、震屏不推进，`applyTransform` 照旧（画面该定住，不是不画）。
    this.camera.update(worldPaused ? 0 : dt);
    /**
     * 听者与脚步 **必须排在 `camera.update` 之后**：听者是本帧定稿的相机位姿，
     * 而实体位置在上面（`player.update` / NPC `cutsceneUpdate` / `trajectorySystem.update`）
     * 已全部写完。排在前面就是拿上一帧的相机配这一帧的实体，快速平移镜头时声像会拖尾。
     * 听者跟随（玩家/相机/指定实体）：走动就改变回音；内部按尺度节流，不是每帧都重算 IR。
     */
    this.updateAcousticListener(false);
    this.footstepSystem.update(dt);
    this.debugTools?.update(dt);
    this.depthDebugVisualizer?.update();
    // 粒子区域叠加层（调试）：相机本帧已定稿。调试链路的异常不许穿进玩法链路——画失败就关掉它
    if (this.vfxConfineOverlay) {
      try {
        this.vfxConfineOverlay.update(this.camera, this.vfxSystem.confineFields());
      } catch (e) {
        console.warn('[vfx] 粒子区域叠加层画失败，已关掉', e);
        this.vfxConfineOverlay.destroy();
        this.vfxConfineOverlay = null;
      }
    }

    // 视锥剔除:先于下方 depth 驱动块——同帧内屏外实体既跳 GPU 渲染,也跳着色驱动。
    this.updateFrustumCulling();

    // 燃烧滤镜的相机 uniform：相机本帧已定稿（早于这里推，镜头一动烧痕就滑一帧）；限速上传燃烧场纹理
    this.burnRenderer.update(performance.now(), {
      x: this.renderer.worldContainer.x,
      y: this.renderer.worldContainer.y,
      scale: this.camera.getProjectionScale(),
    });

    this.syncEntityPixelDensityMatch();

    if (this.sceneDepthSystem.isActive) {
      const S = this.camera.getProjectionScale();
      this.sceneDepthSystem.updatePerFrame(
        this.renderer.worldContainer.x,
        this.renderer.worldContainer.y,
        S,
      );
      // depth_floor 直读场景 zones、不经 ZoneSystem——位面归属在此消费点单独过滤
      //（standard zone 的位面过滤在 shouldRegisterZoneWithZoneSystem）。
      // exclusive（独立世界型）激活时缺省 zone 也不存在，须无条件走过滤。
      const zonesRaw = this.sceneManager.currentSceneData?.zones;
      const zonesInPlane = zonesRaw?.some((z) => z.planes?.length)
          || this.planeReconciler.getActivePlaneMembership() === 'exclusive'
        ? zonesRaw?.filter((z) => this.sceneManager.isEntityInActivePlane(z))
        : zonesRaw;
      const zones = zonesInPlane?.filter(
        (z) => this.sceneManager.isCurrentSceneGroupEnabled(z.group),
      );
      /** F2 性能：深度 floor 偏移的条件上下文每帧建一次，玩家/NPC/热点三处循环共享；
       *  统一走中央工厂（律5），plane/@scene/@owner 叶子与其它条件入口口径一致。 */
      const floorCondCtx = this.buildConditionEvalContext();
      const floorGroupConditions = (groupId: string) =>
        this.sceneManager.getCurrentSceneGroupConditions(groupId);
      if (this.playerDepthFilter) {
        // 深度遮挡 / 逐像素着色的"脚点"一律取**接地点**（缺省锚点时 = 位置，见 NpcDef.anchor）
        const pFootX = this.player.contactX;
        const pFootY = this.player.contactY;
        const ex = resolveDepthFloorOffsetBoost(
          zones,
          pFootX,
          pFootY,
          this.flagStore,
          floorCondCtx,
          floorGroupConditions,
        );
        this.sceneDepthSystem.updateEntityDepthOcclusion(
          this.playerDepthFilter,
          pFootX,
          pFootY,
          ex,
        );
        const ps = this.player.sprite;
        const pSize = ps.getWorldSize();
        const pInfo = ps.getShadingFrameInfo();
        this.driveBakedShading(this.playerDepthFilter, pFootX, pFootY, {
          worldW: pSize.width,
          worldH: pSize.height,
          flipX: (pInfo?.flipX ?? false) !== (ps.container.scale.x < 0),
          nrmRect: pInfo?.rect ?? null,
          sheetUrl: pInfo?.sheetUrl ?? null,      // 换图集(背尸/道士)时法线跟着换
        });
      }
      const npcByContainer = new Map<unknown, Npc>();
      for (const npc of this.sceneManager.getCurrentNpcs()) npcByContainer.set(npc.container, npc);
      for (const child of this.renderer.entityLayer.children) {
        if (child.culled) continue;   // 剔除:屏外实体跳过着色驱动(重回画面当帧已 uncull)
        const c = child as unknown as {
          filters?: readonly { _isDepthOcclusion?: boolean }[];
          x: number;
          y: number;
        };
        if (c.filters) {
          const npc = npcByContainer.get(child);
          // 脚点取**接地点**：锚点在圆心的物件（铜钱一族）按锚点采深度会差半个身高，
          // 表现是"影子/遮挡对不上、而画面上物件位置是对的"。非 NPC 容器无锚点概念，
          // 回落容器坐标（= 改造前的行为）。
          const fx = npc ? npc.contactX : c.x;
          const fy = npc ? npc.contactY : c.y;
          for (const f of c.filters) {
            if (f._isDepthOcclusion && f !== this.playerDepthFilter) {
              const ex = resolveDepthFloorOffsetBoost(
                zones, fx, fy, this.flagStore, floorCondCtx, floorGroupConditions,
              );
              this.sceneDepthSystem.updateEntityDepthOcclusion(
                f as unknown as IEntityShadingFilter,
                fx,
                fy,
                ex,
              );
              const size = npc?.getWorldSize();
              const info = npc?.getShadingFrameInfo() ?? null;
              this.driveBakedShading(f as unknown as IEntityShadingFilter, fx, fy, npc ? {
                worldW: size!.width,
                worldH: size!.height,
                flipX: info?.flipX ?? false,
                nrmRect: info?.rect ?? null,
                sheetUrl: info?.sheetUrl ?? null,   // NPC 经 setEntityField 换动画时同上
                // NPC 容器还挂着名字标签,包围盒比 sprite 高一截 → 必须换算
                spriteRect: npc.normalUvSpriteRect() ?? undefined,
              } : null);
            }
          }
        }
      }
      for (const h of this.sceneManager.getCurrentHotspots()) {
        if (h.container.culled) continue;   // 剔除:屏外热点跳过着色驱动
        const hf = h.getDepthOcclusionFilter();
        if (!hf) continue;
        const footY = h.depthOcclusionFootWorldY();
        const ex = resolveDepthFloorOffsetBoost(
          zones, h.container.x, footY, this.flagStore, floorCondCtx, floorGroupConditions,
        );
        this.sceneDepthSystem.updateEntityDepthOcclusion(hf, h.container.x, footY, ex);
        // 烘焙场景:热点也走 CHAR_FS,逐帧喂脚点/尺寸/法线(单张静图 → 整帧 rect)。
        // 展示图翻转经 sprite.scale.x(滤镜外),法线图集为未翻转原图 → flipX 传当前朝向。
        const size = h.getWorldSize();
        this.driveBakedShading(hf, h.container.x, footY, {
          worldW: size.width,
          worldH: size.height,
          flipX: h.getFacing() < 0,
          nrmRect: [0, 0, 1, 1],
          sheetUrl: h.def.displayImage?.image ?? null,   // 热点换图同理
        });
      }
    }

    this.updateLightEnvFromCurve();
    // 草木位移图：这一帧的网格渲进离屏 uv 图（不打光的合成面与打光的背景都读它）。
    // 必须在主画面渲染之前、与光照缓存同一拍——放进场景树里渲染离屏目标会串台（pixi-v8-traps）。
    if (this.swayBackground?.renderUv(this.renderer.app.renderer)) this.foregroundLayers?.markCoverageDirty();
    // 前景网格跟着这株此刻的真实最大位移扩 / 缩（按档量化，不变档是一次比较）
    this.foregroundLayers?.updateDisplacement();
    // 前景层覆盖图（蒙版 + 前景面深度，遮挡在蒙版里拿它顶替深度图）：读这一帧的位移图，所以紧跟在它后面、主画面之前
    this.foregroundLayers?.renderCoverage(this.renderer.app.renderer);
    // 水面细波纹的钟（只在落雷的灯亮着、本来就重烘的那几帧起作用）
    this.sceneLighting.setSurfaceTime(this.gameClock.now / 1000);
    // 统一光影：脏才重算场景辐射缓存，稳态是一次布尔判断（零光照计算）。
    this.sceneLighting.update(this.renderer.app.renderer);
    this.updateEntityShadows();

    this.renderer.sortEntityLayer(this.player.x, this.player.y);
    this.touchMobileControls?.update();
    this.inputManager.endFrame();
  }
}
