// 顶层大块划分规则。按顺序匹配,第一条命中为准;每个文件恰好落进一个块。
// 划分依据:目录 + 文件名(机械规则,可复查);块名取自 docs/游戏架构设计文档.md 与 agent_docs 的叫法
// (名字出处见 diagrams/docs.json)。边界块 boundary 不展开,只画它接进运行时的接口。
export const BLOCKS = [
  { id: 'boot', name: '入口与装配', layer: 'assembly', color: '#8c6d1f',
    rules: [/^src\/main\.ts$/, /^src\/smell_preview_entry\.ts$/, /^src\/vite-env\.d\.ts$/,
      /^src\/core\/(Game|EventBridge|InteractionCoordinator|bootParams|entryGuard|gameConfigMerge|pageErrorTrap|DebugTools|devErrorOverlay|devRuntimeCommands)\.ts$/] },
  { id: 'coreinfra', name: '核心基础设施', layer: 'core', color: '#5b6b8c',
    rules: [/^src\/core\/(EventBus|FlagStore|FlagKeys|GameStateController|InputManager|AssetManager|assetPath|projectPaths|SaveManager|StringsProvider|resolveText|richMarkup|textStyle|styledText|TextDisplaySettings|SmellDisplaySettings|RuleOfferRegistry)\.ts$/,
      /^src\/core\/storage\//] },
  { id: 'narrative', name: '动作·条件·叙事', layer: 'mixed', color: '#8c4f6b',
    rules: [/^src\/core\/(ActionExecutor|ActionRegistry|actionOrigin|actionParamManifest|NarrativeStateManager|narrativeGraphValidation|ScenarioStateManager)\.ts$/,
      /^src\/systems\/(NarrativePackageDirector|SignalCueManager)\.ts$/, /^src\/systems\/graphDialogue\//] },
  { id: 'world', name: '场景·世界·实体', layer: 'mixed', color: '#3f7a5a',
    rules: [/^src\/systems\/(SceneManager|ZoneSystem|InteractionSystem|PlaneReconciler|NpcScheduleSystem|DayManager|gameClock|TrajectorySystem|PlayerActionSystem|PlayerIdleBehaviorSystem)\.ts$/,
      /^src\/systems\/plane\//, /^src\/entities\//] },
  { id: 'gameplay', name: '玩法系统与小游戏', layer: 'systems', color: '#7a5a3f',
    rules: [/^src\/systems\/(QuestManager|InventoryManager|RulesManager|EncounterManager|ArchiveManager|ClueManager|SystemNoteManager|GameLogManager|HealthSystem|HealthThreatSystem|RetrySystem|FireProtectionSystem|SmellSystem|strikeLight|strikePresentation|minigameSession|minigameScript)\.ts$/,
      /^src\/systems\/(heldProp|burn|waterMinigame|sugarWheel|paperCraft|objectExamine|pressureHold)\//] },
  { id: 'story', name: '对话与演出', layer: 'systems', color: '#6b3f8c',
    rules: [/^src\/systems\/(DialogueManager|GraphDialogueManager|CutsceneManager|DocumentRevealManager|EmoteBubbleManager|BubbleChatterSystem|performanceSession)\.ts$/,
      /^src\/systems\/(canvas|breathing)\//] },
  { id: 'render', name: '渲染核心', layer: 'rendering', color: '#2f6f8f',
    rules: [/^src\/rendering\/(Renderer|Camera|SpriteEntity|CutsceneRenderer|CanvasStage|PlaceholderFactory|backgroundSway|breathingOverlayMesh|breathingUniforms|glProgramWarmup|viewportFit|uiLayerOrder|entitySortRule|footprintExtent|firstPersonDialogue|FireHintMarker|EntityPixelDensityMatch|BackgroundDebugFilter|overlayBlendShader)\.ts$/,
      /^src\/rendering\/filter\//] },
  { id: 'lighting', name: '光照·阴影·深度', layer: 'mixed', color: '#b0702a',
    rules: [/^src\/rendering\/lighting\//,
      /^src\/core\/(SceneLightingSystem|CharacterLightingSystem|UnifiedCharacterLighting|SceneDepthSystem|lightingPayloadFiles|depthLog)\.ts$/,
      /^src\/rendering\/(CharacterLitSprite|CharacterShadingFilter|EntityLightingFilter|DepthOcclusionFilter|EntityShadow|entityShadowBinding|entityShadowFlags|entityShadowTypes|contactAo|contactAoSources|irradianceProbe|lightEnv|lightEnvCurve|shadowField|spriteNormalAtlas)\.ts$/] },
  { id: 'vfx', name: '特效(粒子·燃烧渲染)', layer: 'mixed', color: '#a0403a',
    rules: [/^src\/systems\/vfx\//, /^src\/rendering\/vfx\//, /^src\/rendering\/burn\//] },
  { id: 'audio', name: '音频', layer: 'mixed', color: '#3a7f86',
    rules: [/^src\/audio\//, /^src\/systems\/(AudioManager|FootstepSystem|FollowerFootstepSystem|VoiceChannel|DialogueVoiceDirector)\.ts$/] },
  { id: 'ui', name: '界面 UI', layer: 'ui', color: '#4f5f2f',
    rules: [/^src\/ui\//] },
  { id: 'data', name: '数据定义与通用工具', layer: 'data', color: '#6f6f6f',
    rules: [/^src\/data\//, /^src\/utils\//] },
  // 边界:不展开
  { id: 'boundary', name: '开发·调试·编辑(边界,不展开)', layer: 'boundary', color: '#999999', boundary: true,
    rules: [/^src\/dev\//, /^src\/debug\//, /^src\/authoring\//] },
];

/** 核心层里的调试/开发文件(不在 dev/debug/authoring 目录,但名字就是调试设施)——按文件名规则归入所在块并打"调试"标 */
export const DEBUG_NAME_RULE = /(^|\/)(Debug[A-Z]\w*|debug[A-Z]\w*|DevMode\w*|dev[A-Z]\w*|DepthDebugVisualizer)\.ts$/;

/** 分层(以 agent_docs/runtime/norms.md 律 11 为准:UI→系统→渲染→核心→数据,组装层例外)。
 *  按**目录**定层;规范没点名的目录(entities / audio)不定层,单列。utils 见 norms 律 11 附注"通用工具层"。 */
export const LAYERS = [
  { id: 'ui', name: 'UI', rank: 5, dirs: [/^src\/ui\//] },
  { id: 'systems', name: '系统', rank: 4, dirs: [/^src\/systems\//] },
  { id: 'rendering', name: '渲染', rank: 3, dirs: [/^src\/rendering\//] },
  { id: 'core', name: '核心', rank: 2, dirs: [/^src\/core\//] },
  { id: 'data', name: '数据/通用工具', rank: 1, dirs: [/^src\/data\//, /^src\/utils\//] },
];
export const ASSEMBLY_FILES = [/^src\/core\/Game\.ts$/, /^src\/main\.ts$/];
export const UNLAYERED_DIRS = [/^src\/entities\//, /^src\/audio\//, /^src\/[^/]+\.ts$/];

export function blockOf(file) {
  for (const b of BLOCKS) if (b.rules.some((r) => r.test(file))) return b.id;
  return null;
}
export function layerOf(file) {
  for (const L of LAYERS) if (L.dirs.some((r) => r.test(file))) return L;
  return null;
}
