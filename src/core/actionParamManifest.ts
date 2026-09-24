/**
 * 动作参数清单 —— TS 侧动作必填/可选参数的**唯一权威源**。
 *
 * 三方同步契约（同一动作的三份登记必须一致，改任一处必须同步另两处）：
 * 1. 运行时注册：`src/core/ActionRegistry.ts` 与 `src/core/ActionExecutor.ts`（内建 4 个）
 *    的 `executor.register(type, handler, paramNames)` —— 行为语义以 handler 实现为准。
 * 2. 编辑器登记：`tools/editor/shared/action_editor.py` 的 `ACTION_TYPES` / `_PARAM_SCHEMAS`
 *    （或专用表单分支）—— 决定策划能在 GUI 里编辑哪些参数。
 * 3. 本 manifest —— `narrativeGraphValidation.ts`（运行时 dev 校验 + 嵌入式叙事编辑器）据此
 *    判定「未知动作类型」与「缺参」。
 *
 * 必填判定口径（与运行时 handler 行为对齐，不照抄 register 的 paramNames 全量表）：
 * - `required`：缺失（undefined / null）时 handler 会告警并跳过核心效果、且无默认值的参数。
 * - `nonEmpty`：`required` 的子集——运行时对其做 `String(...).trim()` 后拒绝空串的参数
 *   （值为字符串且 trim 后为空同样视为缺参；非字符串值不做此检查）。
 * - `optional`：有默认值 / 别名 / 允许缺省的参数，仅供工具比对与文档，不参与缺参校验。
 *
 * 已知运行时别名（校验按主名 required，别名列入 optional）：
 * - sugarWheelResetPointer: `angleDeg`（主）/ `angle`（legacy 别名）
 * - showSpeechBubble / showSpeechBubbleAndWait: `text`（主）/ `emote`（从 showEmote 复制参数的兼容键）
 * - fadingZoom / fadingRestoreSceneCameraZoom / fadeWorldToBlack / fadeWorldFromBlack:
 *   `durationMs`（主）/ `duration`（别名）
 *
 * 特例：`setNarrativeState` **不收录**——它未在 ActionExecutor 注册任何 handler（仅调试通道
 * debugSetNarrativeState 可用），编辑器把它列为 DEBUG_ONLY 类型；内容里出现时校验器按
 * 「未知类型」+`stateCommand.unsafeInContent` 双 error 拦截（嵌入式叙事编辑器测试锁定此行为）。
 */

export interface ActionParamManifestEntry {
  /** 必填参数：undefined / null 视为缺参 */
  required: readonly string[];
  /** required 的子集：字符串值 trim 后为空也视为缺参 */
  nonEmpty?: readonly string[];
  /** 可选参数（含默认值 / 别名），供文档与工具比对 */
  optional?: readonly string[];
}

export const ACTION_PARAM_MANIFEST: Readonly<Record<string, ActionParamManifestEntry>> = {
  // ---- ActionExecutor 内建 ----
  setFlag: { required: ['key', 'value'], nonEmpty: ['key'] },
  appendFlag: { required: ['key', 'text'], nonEmpty: ['key'] },
  addFlagValue: { required: ['key', 'delta'], nonEmpty: ['key'] },
  showNotification: { required: ['text'], optional: ['type'] },

  // ---- 组合 / 分支 ----
  runActions: { required: ['actions'] },
  runActionsDetached: { required: ['actions'], optional: ['id'] },
  // layout = 版式档（与对白同一套；firstPerson = 屏底横排、不要木框）；不写 = 现行选项条
  chooseAction: { required: ['options'], optional: ['prompt', 'allowCancel', 'layout'] },
  randomBranch: { required: [], optional: ['probability', 'aboveActions', 'belowActions'] },
  // condition 是统一条件表达式（与热区/zone 的 conditions 同一套叶子）；不写 = 恒真。
  // elseActions 为空时不写键（往返保真）。
  runActionsIf: { required: ['condition'], optional: ['actions', 'elseActions'] },

  // ---- 叙事 / scenario ----
  emitNarrativeSignal: { required: ['signal'], nonEmpty: ['signal'], optional: ['sourceType', 'sourceId', 'ownerType', 'ownerId'] },
  // 叙事活计生命周期（S1）：graphId=活计图引用；activateNarrativeRun 的 graphId 允许空串（清激活槽）
  startNarrativeRun: { required: ['graphId'], nonEmpty: ['graphId'] },
  resetNarrativeRun: { required: ['graphId'], nonEmpty: ['graphId'] },
  revertNarrativeRun: { required: ['graphId', 'stateId'], nonEmpty: ['graphId', 'stateId'] },
  activateNarrativeRun: { required: ['graphId'] },
  // 叙事章节包（C2）：packageId=章节包引用（编排 package 标的并集）
  loadNarrativePackage: { required: ['packageId'], nonEmpty: ['packageId'] },
  unloadNarrativePackage: { required: ['packageId'], nonEmpty: ['packageId'] },
  setScenarioPhase: {
    required: ['scenarioId', 'phase', 'status'],
    nonEmpty: ['scenarioId', 'phase', 'status'],
    optional: ['outcome'],
  },
  startScenario: { required: ['scenarioId'], nonEmpty: ['scenarioId'] },
  activateScenario: { required: ['scenarioId'], nonEmpty: ['scenarioId'] },
  completeScenario: { required: ['scenarioId'], nonEmpty: ['scenarioId'] },
  revealDocument: { required: ['documentId'], nonEmpty: ['documentId'], optional: ['force'] },
  hideDocument: { required: ['documentId'], nonEmpty: ['documentId'] },

  // ---- 背包 / 货币 / 规矩 / 任务 ----
  giveItem: { required: ['id'], nonEmpty: ['id'], optional: ['count', 'critical'] },
  removeItem: { required: ['id'], nonEmpty: ['id'], optional: ['count'] },
  setActiveIgniter: { required: ['item'], nonEmpty: ['item'] },
  setPropLevel: { required: ['prop', 'level'], nonEmpty: ['prop'] },
  giveCurrency: { required: ['amount'] },
  removeCurrency: { required: ['amount'], nonEmpty: ['amount'] },
  giveRule: { required: ['id'], nonEmpty: ['id'] },
  grantRuleLayer: { required: ['ruleId', 'layer'], nonEmpty: ['ruleId', 'layer'] },
  giveFragment: { required: ['id'], nonEmpty: ['id'] },
  updateQuest: { required: ['id'], nonEmpty: ['id'] },
  // 当前任务槽（D6）：id 允许空串（= 清空当前任务），故不进 nonEmpty；announce 为可选勾选
  setFocusedQuest: { required: ['id'], optional: ['announce'] },
  pickup: { required: ['itemName', 'count'], nonEmpty: ['itemName'], optional: ['itemId', 'isCurrency'] },
  shopPurchase: { required: ['itemId', 'price'], nonEmpty: ['itemId'] },
  inventoryDiscard: { required: ['itemId'], nonEmpty: ['itemId'] },
  openShop: { required: ['shopId'], nonEmpty: ['shopId'] },

  // ---- 遭遇 / 音频 / 日程 ----
  startEncounter: { required: ['id'], nonEmpty: ['id'] },
  playBgm: { required: ['id'], nonEmpty: ['id'], optional: ['fadeMs', 'volume'] },
  stopBgm: { required: [], optional: ['fadeMs'] },
  playSfx: { required: ['id'], nonEmpty: ['id'], optional: ['volume', 'loop'] },
  stopSceneAmbient: { required: [], optional: ['id', 'fadeMs'] },
  playSceneAmbient: { required: ['id'], nonEmpty: ['id'], optional: ['volume'] },
  endDay: { required: [] },
  addDelayedEvent: { required: ['targetDay', 'actions'] },
  advanceTime: { required: ['minutes'], optional: ['transition'] },
  advanceTimeTo: { required: ['phase'], nonEmpty: ['phase'], optional: ['transition'] },
  setNpcScheduleOverride: {
    required: ['characterId'],
    nonEmpty: ['characterId'],
    optional: ['scene', 'x', 'y', 'activity', 'clear'],
  },

  // ---- 档案 / 线索 / 过场 / 小游戏 ----
  addArchiveEntry: { required: ['bookType', 'entryId'], nonEmpty: ['bookType', 'entryId'] },
  // 线索采集（K7）：clueId=clues.json 词条引用；幂等/回执由 ClueManager.collect 统一处理
  collectClue: { required: ['clueId'], nonEmpty: ['clueId'] },
  // 三把火 HUD 读数显隐（G.5）：纯开关；style=flare|fade|instant，缺省显=flare / 隐=fade
  setThreeFiresVisible: { required: ['visible'], optional: ['style'] },
  // 系统说明卡（K4）：noteId=system_notes.json 引用；force 缺省 false（每档一次）
  showSystemNote: { required: ['noteId'], nonEmpty: ['noteId'], optional: ['force'] },
  startCutscene: { required: ['id'], nonEmpty: ['id'] },
  startWaterMinigame: { required: ['id'], nonEmpty: ['id'] },
  startSugarWheelMinigame: { required: ['id'], nonEmpty: ['id'] },
  startPaperCraftMinigame: { required: ['id'], nonEmpty: ['id'] },
  startObjectExamine: { required: ['id'], nonEmpty: ['id'] },
  startPressureHold: { required: ['id'], nonEmpty: ['id'] },
  playSignalCue: { required: ['id'], nonEmpty: ['id'] },
  setBubbleLineSet: { required: ['target', 'lineSetId'], nonEmpty: ['target', 'lineSetId'] },
  clearBubbleLineSet: { required: ['target'], nonEmpty: ['target'], optional: ['silence'] },
  sugarWheelShowSpeech: { required: ['role', 'text'], nonEmpty: ['role', 'text'], optional: ['durationMs'] },
  sugarWheelDismissSpeech: { required: ['role'], nonEmpty: ['role'] },
  sugarWheelDismissAllSpeech: { required: [] },
  sugarWheelResetPointer: { required: ['angleDeg'], optional: ['angle'] },
  debugAlertActionParams: { required: [], optional: ['title'] },

  // ---- 血量 / 气味 ----
  damagePlayer: { required: ['amount'] },
  healPlayer: { required: ['amount'] },
  resetHealth: { required: [] },
  setHealth: { required: ['amount'] },
  setMaxHealth: { required: ['amount'] },
  setRetryCheckpoint: { required: ['id'], nonEmpty: ['id'], optional: ['label'] },
  sceneWindGust: { required: ['speedMultiplier', 'durationMs'], optional: ['attackMs', 'releaseMs', 'id', 'volume', 'wait'] },
  lockHealth: { required: ['id'], nonEmpty: ['id'], optional: ['min', 'max', 'scope'] },
  unlockHealth: { required: ['id'], nonEmpty: ['id'] },
  inflictHealthDamage: { required: ['amount', 'kind', 'sourceId'], nonEmpty: ['kind', 'sourceId'], optional: ['deathNoteId'] },
  applyHealthProtection: { required: ['id', 'seconds'], nonEmpty: ['id'], optional: ['reduction', 'maxHealthBonus', 'kind', 'threatId'] },
  removeHealthProtection: { required: ['id'], nonEmpty: ['id'] },
  incHealth: { required: ['amount'] },
  decHealth: { required: ['amount'] },
  triggerDeathTether: { required: [] },
  setSmell: { required: ['scent'], nonEmpty: ['scent'], optional: ['intensity', 'dir', 'flicker'] },
  clearSmell: { required: [] },
  // 气味指示器显隐（G.6）：与三把火同一套 style 词汇 flare|fade|instant|debut（显缺省 flare=聚拢浮现 / 隐缺省 fade=散开）
  setSmellVisible: { required: ['visible'], optional: ['style'] },
  // 气味源 / 飘向追踪（G.6）：气缕飘向的方向 = 源；scene 缺省当前场景；追踪可随时开关，缺省开
  setSmellSource: { required: ['x', 'y'], optional: ['scene', 'at'] },
  clearSmellSource: { required: [] },
  setSmellTracking: { required: ['enabled'] },
  sniff: { required: [] },

  // ---- 跟脚声（玩家落脚事件的延迟重放；只管声音，扣血在 healthThreat 那边）----
  // 参数全可选：延迟按**步间隔的百分比**给（50 = 半步，正好踏在你两步中间），
  // 距离不用配——它等于你在这段延迟里走过的路。
  setFollowerFootsteps: {
    required: ['enabled'],
    optional: ['id', 'delayPercent', 'minDelayMs', 'footstepSet', 'gainDb', 'fireStops', 'abrupt'],
  },

  // ---- 位面 ----
  activatePlane: { required: ['id'], nonEmpty: ['id'] },
  deactivatePlane: { required: [] },

  // ---- 气泡 / 动画 / 实体显隐 ----
  // voice：气泡台词配音（与字幕 / 对话框同一套 VoiceSpec）。非阻塞的两个只吃 voice——
  // 它们没有"本拍结束"这个时刻，配音一律留声；autoAdvance 只对 AndWait 两个有意义。
  showEmote: {
    required: ['target', 'emote'],
    nonEmpty: ['target', 'emote'],
    optional: ['duration', 'anchorOffsetX', 'anchorOffsetY', 'bubbleAnchorY', 'bubbleScale', 'voice'],
  },
  showSpeechBubble: {
    required: ['target', 'text'],
    nonEmpty: ['target', 'text'],
    optional: ['emote', 'duration', 'anchorOffsetX', 'anchorOffsetY', 'bubbleAnchorY', 'bubbleScale', 'voice'],
  },
  showEmoteAndWait: {
    required: ['target', 'emote'],
    nonEmpty: ['target', 'emote'],
    optional: ['duration', 'anchorOffsetX', 'anchorOffsetY', 'bubbleAnchorY', 'bubbleScale',
      'voice', 'autoAdvance'],
  },
  showSpeechBubbleAndWait: {
    required: ['target', 'text'],
    nonEmpty: ['target', 'text'],
    optional: ['emote', 'duration', 'anchorOffsetX', 'anchorOffsetY', 'bubbleAnchorY', 'bubbleScale',
      'voice', 'autoAdvance'],
  },
  playNpcAnimation: {
    required: ['target', 'state'],
    nonEmpty: ['target', 'state'],
    // speed 倍率 / reverse 倒放 / loop 循环覆盖 / holdFrame 定格帧 / thenState 非循环播完自动切换
    optional: ['speed', 'reverse', 'loop', 'holdFrame', 'thenState'],
  },
  setEntityEnabled: { required: ['target', 'enabled'], nonEmpty: ['target'] },

  // ---- 场景切换 / 相机 / 深度 ----
  switchScene: { required: ['targetScene'], nonEmpty: ['targetScene'], optional: ['targetSpawnPoint'] },
  changeScene: {
    required: ['targetScene'],
    nonEmpty: ['targetScene'],
    optional: ['targetSpawnPoint', 'cameraX', 'cameraY'],
  },
  setPlayerAvatar: { required: [], optional: ['animManifest', 'bundleId', 'stateMap', 'portraitSlug'] },
  resetPlayerAvatar: { required: [] },
  attachToSocket: {
    required: ['target', 'socket'],
    optional: [
      'prop', 'image', 'images', 'scale', 'mirror',
      'anchorX', 'anchorY', 'rotation', 'lit',
      // state 只在给了 prop 时有意义（状态表住在挂件预设里）
      'state',
    ],
  },
  // 挂件状态机（火把：点着 / 护火 / 残炭 / 灭）。fadeMs 只作用于灯的强度
  setPropState: {
    required: ['target', 'socket', 'state'],
    nonEmpty: ['target', 'socket', 'state'],
    optional: ['fadeMs'],
  },
  // 场景灯的运行时强度倍率（0 = 吹灭）。手持火把不走这条，走 setPropState
  fadeLight: {
    required: ['lightId', 'scale'],
    nonEmpty: ['lightId'],
    optional: ['fadeMs'],
  },
  // 满屏闪一下（雷 / 爆闪）。全可选：什么都不填 = 220ms 惨白
  screenFlash: { required: [], optional: ['durationMs', 'color', 'alpha', 'wait'] },
  // 震屏。amplitude 是屏幕像素，必填（0 也要显式写，免得"忘了填"看起来像"没震"）
  cameraShake: { required: ['amplitude'], optional: ['durationMs', 'frequency'] },
  // 环境压暗（背景 + 角色 + 粒子同值）。scale 必填：1 = 恢复
  setSceneDim: { required: ['scale'], optional: ['fadeMs', 'wait'] },
  // 压音随脱手会话托管；holdMs 仅是无会话普通批的墙钟兜底（缺省 20 秒）。
  duckAudio: { required: [], optional: ['id', 'bgm', 'ambient', 'sfx', 'voice', 'fadeMs', 'holdMs'] },
  // 同会话内按 id 还原；会话结束不截断已经开始的还原渐变，打断则立即还原。
  restoreAudio: { required: [], optional: ['id', 'fadeMs', 'stopSfx'] },
  // 落雷：选靶 → 雷 → 靶消失。全可选——最小形态 `{}` 就是"照缺省挑最凶的劈了"
  strikeThreat: {
    required: [],
    optional: ['rank', 'maxDistance', 'fallback', 'fallbackRadius', 'effect', 'effects', 'effectHeight', 'effectSeed',
      'lightIntensity', 'lightHeight', 'lightRange', 'lightKelvin', 'lightMs', 'removeTarget', 'seed',
      'sfx', 'sfxVolume', 'strikes', 'extraChance', 'gapMs', 'gapJitterMs',
      'visualStrikes', 'visualExtraChance', 'visualGapMs', 'visualGapJitterMs',
      'fallbackMargin', 'fallbackMinDistance', 'fallbackSeparation', 'fallbackStrictSeparation', 'fallbackSurfaceZone', 'fallbackGroundOnly', 'fallbackMaxSlopeDeg', 'sfxVoices', 'vfxVoices',
      'flashAlpha', 'flashMs', 'shakeAmplitude', 'shakeMs'],
  },
  detachFromSocket: { required: ['target', 'socket'] },
  setSceneDepthFloorOffset: { required: ['floor_offset'] },
  resetSceneDepthFloorOffset: { required: [] },
  setCameraZoom: { required: ['zoom'] },
  restoreSceneCameraZoom: { required: [] },
  fadingZoom: { required: ['zoom'], optional: ['durationMs', 'duration'] },
  fadingRestoreSceneCameraZoom: { required: [], optional: ['durationMs', 'duration'] },
  fadeWorldToBlack: { required: [], optional: ['durationMs', 'duration'] },
  fadeWorldFromBlack: { required: [], optional: ['durationMs', 'duration'] },
  showBlackout: { required: [], optional: ['durationMs', 'duration'] },
  hideBlackout: { required: [], optional: ['durationMs', 'duration'] },
  // 相机跟随实体（仅过场态生效，过场结束自动复位回玩家）：smooth 缺省=硬锁居中（逐帧
  // snapTo），true=平滑跟随（camera.follow 插值）。target 为实体引用，登记 ENTITY_REF_PARAMS。
  // 跟谁二选一（运行时校验至少一个）：target = 实体 id（老语义）/ at = 位置引用（每帧求值，可以是曲线此刻播到的点）。
  cameraFollowActor: { required: [], optional: ['target', 'at', 'smooth'] },
  cameraStopFollow: { required: [] },
  openMap: { required: [] },

  // ---- NPC 巡逻 / 持久化 override ----
  stopNpcPatrol: { required: ['npcId'], nonEmpty: ['npcId'] },
  persistNpcDisablePatrol: { required: ['npcId'], nonEmpty: ['npcId'] },
  persistNpcEnablePatrol: { required: ['npcId'], nonEmpty: ['npcId'] },
  persistNpcEntityEnabled: { required: ['target', 'enabled'], nonEmpty: ['target'] },
  persistHotspotEnabled: {
    required: ['sceneId', 'hotspotId', 'enabled'],
    nonEmpty: ['sceneId', 'hotspotId'],
  },
  setZoneEnabled: { required: ['sceneId', 'zoneId', 'enabled'], nonEmpty: ['sceneId', 'zoneId'] },
  persistZoneEnabled: { required: ['sceneId', 'zoneId', 'enabled'], nonEmpty: ['sceneId', 'zoneId'] },
  // entityKind 缺省按 npc 处理（运行时容忍），故列入 optional。
  setSceneEntityPosition: {
    required: ['sceneId', 'entityId', 'x', 'y'],
    nonEmpty: ['sceneId', 'entityId'],
    optional: ['entityKind', 'at'],
  },
  persistNpcAt: { required: ['target', 'x', 'y'], nonEmpty: ['target'], optional: ['at'] },
  persistNpcAnimState: { required: ['target', 'state'], nonEmpty: ['target', 'state'] },
  persistPlayNpcAnimation: { required: ['target', 'state'], nonEmpty: ['target', 'state'] },

  // ---- 叠图 / 热点展示 / 实体字段 ----
  showOverlayImage: {
    required: ['id', 'image', 'xPercent', 'yPercent', 'widthPercent'],
    nonEmpty: ['id', 'image'],
    // order = 在画布上的绘制顺序（与文档揭示 / 实体 / 特效共用一个顺序空间）
    // fill = 铺满窗口（true 时 x/y/width 不参与布局；编辑器照样写着，关掉即回到百分比布局）
    optional: ['order', 'fill'],
  },
  hideOverlayImage: { required: ['id'], nonEmpty: ['id'] },

  // ---- 呼吸图(叠图同一层、同一套 id 句柄;hideOverlayImage 收掉它)----
  // breathing = assets/data/breathing/<id>.json 的 id;布局口径同 showOverlayImage
  showBreathingOverlay: {
    required: ['id', 'breathing', 'xPercent', 'yPercent', 'widthPercent'],
    nonEmpty: ['id', 'breathing'],
    optional: ['order'],
  },
  // act = breathe | fadeOut | gasp | stopNow | restart;wait = 渐弱等停住走完 / 猛吸等猛吸结束才往下走
  breathingPerform: { required: ['id', 'act'], nonEmpty: ['id', 'act'], optional: ['wait'] },
  // params = 参数名 → 数值(键见 src/data/breathingParams.json);durationMs > 0 时平滑过渡
  setBreathingParams: { required: ['id', 'params'], nonEmpty: ['id'], optional: ['durationMs'] },

  // ---- 画布（场景之外那张屏幕空间的面）----
  // character / animFile 是"二选一"，两个都不是 required（运行时自己判至少给一个）；
  // 位置 / 大小 / 顺序全有缺省，所以只有句柄 name 是必填的。
  showCanvasEntity: {
    required: ['name'],
    nonEmpty: ['name'],
    optional: [
      'character', 'animFile', 'state',
      'xPercent', 'yPercent', 'heightPercent', 'widthPercent',
      'order', 'facing', 'alpha',
    ],
  },
  hideCanvasEntity: { required: ['name'], nonEmpty: ['name'] },
  playCanvasEntityAnimation: {
    required: ['name', 'state'],
    nonEmpty: ['name', 'state'],
    optional: ['speed', 'reverse', 'loop', 'holdFrame', 'thenState'],
  },
  setCanvasEntityTransform: {
    required: ['name'],
    nonEmpty: ['name'],
    optional: ['xPercent', 'yPercent', 'heightPercent', 'widthPercent', 'facing', 'alpha'],
  },
  setCanvasOrder: {
    required: ['kind', 'name', 'order'],
    nonEmpty: ['kind', 'name'],
  },
  playCanvasVfx: {
    required: ['name', 'effect'],
    nonEmpty: ['name', 'effect'],
    optional: ['xPercent', 'yPercent', 'scale', 'order'],
  },
  stopCanvasVfx: { required: ['name'], nonEmpty: ['name'] },
  clearCanvas: { required: [] },
  blendOverlayImage: {
    required: ['id', 'fromImage', 'toImage', 'xPercent', 'yPercent', 'widthPercent'],
    nonEmpty: ['id', 'fromImage', 'toImage'],
    optional: ['durationMs', 'delayMs', 'order'],
  },
  setHotspotDisplayImage: {
    required: ['sceneId', 'hotspotId', 'image'],
    nonEmpty: ['sceneId', 'hotspotId', 'image'],
    optional: ['worldWidth', 'worldHeight', 'facing'],
  },
  tempSetHotspotDisplayFacing: {
    required: ['sceneId', 'hotspotId', 'facing'],
    nonEmpty: ['sceneId', 'hotspotId', 'facing'],
  },
  setEntityField: {
    required: ['sceneId', 'entityKind', 'entityId', 'fieldName', 'value'],
    nonEmpty: ['sceneId', 'entityKind', 'entityId', 'fieldName'],
  },
  // 角色阴影绑定（手动指定光源，禁止自动 resolve）。
  // target 命中面同 showEmote：player / NPC id / **裸**热区 id。
  // source: 'light:<灯id>' | 'virtual' | 'none'。后五个只有 virtual 用得全，
  // 绑真实灯时 darkness/softness 可选覆盖、其余忽略 —— 所以一律 optional。
  setEntityShadow: {
    required: ['target', 'source'],
    nonEmpty: ['target', 'source'],
    optional: ['azimuthDeg', 'elevationDeg', 'darkness', 'softness', 'length'],
  },

  // ---- 对话 / 演出 ----
  startDialogueGraph: {
    required: ['graphId'],
    nonEmpty: ['graphId'],
    optional: ['entry', 'npcId', 'ownerType', 'ownerId', 'dimBackground'],
  },
  waitClickContinue: { required: [], optional: ['text'] },
  // layout = 动作级版式档（各行默认；行内 layout 覆盖之）——运行时一直认、编辑器一直写，此前漏登这里
  playScriptedDialogue: { required: ['lines'], optional: ['scriptedNpcId', 'dimBackground', 'layout'] },
  waitMs: { required: [], optional: ['durationMs'] },
  moveEntityTo: {
    required: ['target', 'x', 'y'],
    nonEmpty: ['target'],
    // sceneId 仅编辑器复现地图用，运行时忽略。arriveAnimState 只作用于终点段末
    //（缺省=回 rest/idle 旧语义；途经点段末一律不切动画）。
    optional: ['speed', 'waypoints', 'moveAnimState', 'arriveAnimState', 'faceTowardMovement', 'sceneId', 'at'],
  },
  jumpEntityTo: {
    required: ['target', 'x', 'y'],
    nonEmpty: ['target'],
    // 脚点沿抛物线弧线落到 x/y；durationMs 缺省 600、arcHeight 缺省 120（世界 px 峰高）。
    // jumpAnimState 只播一次且帧游标按移动进度插值；landAnimState 缺省回 rest/idle。
    // sceneId 仅编辑器复现地图用，运行时忽略。
    optional: ['durationMs', 'arcHeight', 'jumpAnimState', 'landAnimState', 'faceTowardMovement', 'sceneId', 'at'],
  },
  teleportEntityTo: {
    required: ['target', 'x', 'y'],
    nonEmpty: ['target'],
    // 一帧到位：无时长、无动画、不碰朝向（要转身接 faceEntity）。
    // sceneId 仅编辑器复现地图用，运行时忽略（同 moveEntityTo / jumpEntityTo）。
    optional: ['sceneId', 'at'],
  },
  playTrajectory: {
    // trajectoryId = 独立资产 assets/data/trajectories/<id>.json。运动对象二选一（运行时校验至少一个）：
    // target = 'player' / NPC id（场景里的实体），或 spawn = 播放时临时生成（图片 / 角色模板，可不在场景里；keep = 播完留在终点）。
    required: ['trajectoryId'],
    nonEmpty: ['trajectoryId'],
    // at = 播放位置引用（数字 / 实体此刻位置 / 场景曲线插槽）；场景曲线不给就原地播，相对曲线不给退到目标此刻位置并 warn。
    // anchorX/anchorY 是 2026-09-11 前的成对写法（= at point）。flipX 缺省 false；wait 缺省 **true**；animState 开播时切目标动画状态。
    optional: ['target', 'spawn', 'at', 'anchorX', 'anchorY', 'flipX', 'wait', 'animState'],
  },
  // toEnd / reset 运行时缺省均为 false（就停在当前姿态、不还原叠加量）。
  stopTrajectory: { required: ['target'], nonEmpty: ['target'], optional: ['toEnd', 'reset'] },

  // ---- 世界空间粒子 / 群体（VfxSystem）----
  // playVfx：instanceId（场景实例）或 effect + 位置（临时实例）二选一，运行时校验至少一个。
  // 位置 = at（'player' / NPC id / {x,y,h}）或 x/y/h；surface 缺省 ground；seed / countScale 可选。
  playVfx: { required: [], optional: ['instanceId', 'effect', 'at', 'x', 'y', 'h', 'surface', 'seed', 'countScale', 'restart', 'oneShot', 'followCamera', 'handle'] },
  stopVfx: { required: [], optional: ['instanceId', 'handle', 'soft', 'fadeMs'] },
  // playPropVfx：在手持挂件上播一个效果（跟着挂件走、效果自己放完就收）。target / socket 在挂件预设状态的
  // onEnterActions 里可以不写 = 这件挂件自己；别处必填（运行时缺了 warn 跳过，校验器按所在位置判）。
  // point = 贴图上的点 [u, v]（0..1），不写 = 起火点，再没有 = 挂点本身。
  playPropVfx: { required: ['effect'], nonEmpty: ['effect'], optional: ['target', 'socket', 'point'] },
  // 锁挂件：lock = lit 锁定不灭（风吹不灭、玩家熄不了）/ unlit 点不燃（玩家点不着）/ none 解锁。入档（手持物）
  lockPropState: { required: ['target', 'socket', 'lock'], nonEmpty: ['target', 'socket', 'lock'] },
  // 燃烧系统（A3.8 模板 + 实例）：socket 没写 = target 是当前场景的可燃实体 id（热点 / NPC / 演出生成留下的对象）；
  // 写了 = target 是拿东西的人（player / NPC），烧他这个挂点上的可燃挂件。point = 模板着火点 id（缺省：有点取第一个、没有整体点）
  igniteBurnable: { required: ['target'], nonEmpty: ['target'], optional: ['socket', 'point'] },
  extinguishBurnable: { required: ['target'], nonEmpty: ['target'], optional: ['socket'] },
  resetBurnable: { required: ['target'], nonEmpty: ['target'], optional: ['socket'] },
  // state ∈ roosting / airborne / fleeing / returning
  setVfxState: { required: ['instanceId', 'state'], nonEmpty: ['instanceId', 'state'] },
  // kind 缺省 fear；duration 缺省 0 = 瞬时脉冲；direction 只给 wind
  emitVfxField: { required: ['tag', 'radius'], nonEmpty: ['tag'], optional: ['kind', 'strength', 'duration', 'at', 'x', 'y', 'h', 'direction'] },
  // at / faceTarget / direction 三选一（运行时校验至少一个），条件必填不在缺参检查建模。
  // at = 朝向一个位置引用所在的一侧（执行那一刻求值），解析不出来退回 faceTarget / direction。
  faceEntity: { required: ['target'], nonEmpty: ['target'], optional: ['direction', 'faceTarget', 'at'] },
  cutsceneSpawnActor: { required: ['id', 'x', 'y'], nonEmpty: ['id'], optional: ['name', 'at'] },
  cutsceneRemoveActor: { required: ['id'], nonEmpty: ['id'] },

  // ---- 规矩供给（zone 上下文动作）----
  enableRuleOffers: { required: ['slots'] },
  disableRuleOffers: { required: [] },

  // ---- 分组批量（group 纯标签寻址，当前场景内生效）----
  setGroupEnabled: { required: ['group', 'enabled'], nonEmpty: ['group'] },
  moveGroupBy: { required: ['group', 'dx', 'dy'], nonEmpty: ['group'], optional: ['speed'] },
};

/** manifest 是否收录该动作类型（未收录 = 校验器报未知类型）。 */
export function isKnownActionType(type: string): boolean {
  return Object.prototype.hasOwnProperty.call(ACTION_PARAM_MANIFEST, type);
}

export function getActionParamManifest(type: string): ActionParamManifestEntry | undefined {
  return isKnownActionType(type) ? ACTION_PARAM_MANIFEST[type] : undefined;
}

/** 新增演出参数的构建期契约；不收紧旧雷链的结算参数。Python 兜底与此同口径。 */
export function presentationActionErrors(type: string, params: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const number = (key: string, min: number, max = Infinity, integer = false): void => {
    const value = params[key];
    if (value === undefined || value === null) return;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
      errors.push(`${key} must be ${integer ? 'an integer' : 'a finite number'} in ${min}..${max}`);
    }
  };
  const bool = (key: string): void => {
    if (params[key] !== undefined && params[key] !== null && typeof params[key] !== 'boolean') errors.push(`${key} must be a boolean`);
  };
  if (type === 'strikeThreat') {
    number('visualStrikes', 0, Infinity, true);
    number('visualExtraChance', 0, 1);
    number('visualGapMs', 0);
    number('visualGapJitterMs', 0);
    number('fallbackMargin', 0, 0.45);
    number('fallbackMinDistance', 0);
    number('fallbackSeparation', 0);
    number('fallbackMaxSlopeDeg', 0, 90);
    number('sfxVoices', 0, 16, true);
    number('vfxVoices', 0, 32, true);
    number('effectSeed', -Infinity, Infinity, true);
    bool('fallbackGroundOnly');
    bool('fallbackStrictSeparation');
    const zone = params.fallbackSurfaceZone;
    if (zone !== undefined && zone !== null && (typeof zone !== 'string' || !zone.trim())) errors.push('fallbackSurfaceZone must be a non-empty string');
  }
  if (type === 'playSfx') bool('loop');
  if (type === 'playVfx' || type === 'stopVfx') {
    const handle = params.handle;
    if (handle !== undefined && handle !== null && (typeof handle !== 'string' || !handle.trim())) errors.push('handle must be a non-empty string');
    const hasHandle = typeof handle === 'string' && !!handle.trim();
    const hasInstance = String(params.instanceId ?? '').trim() !== '';
    if (hasHandle && hasInstance) errors.push('instanceId and handle are mutually exclusive');
    if (type === 'playVfx' && hasHandle && !String(params.effect ?? '').trim()) errors.push('handle requires a temporary effect');
    if (type === 'stopVfx') {
      if (!hasHandle && !hasInstance) errors.push('instanceId or handle is required');
      bool('soft');
      number('fadeMs', 0);
    }
  }
  return errors;
}

// =========================================================================== //
// 脱手演出（runActionsDetached）的两张分类表
//
// 会话被打断时走的是**快进**而不是砍断：剩下的动作照跑，只有纯演出那些整条跳过。
// 这两张表是那条规则的唯一权威源（运行时与编辑器/校验器都读它，Python 侧有 parity 测试对账）。
// 机制全貌见 `src/systems/performanceSession.ts`。
// =========================================================================== //

/**
 * **纯演出动作**：快进时整条跳过。
 *
 * 判据只有一条——**跳过它不会少掉任何玩家事后还能观察到的后果**。
 * 于是这张表里一个写存档 / 推状态 / 动背包的动作都不许有（Python 侧 parity 测试按编辑器的
 * `ACTION_PERSISTENCE` 钉死："save" 档的动作永远不许进这张表）。
 *
 * ⚠ **缺省是「跑」而不是「跳」**。漏登记一条演出动作，最坏是它在过场上面闪了一下；
 * 漏登记反了（把结算当演出跳掉）就是玩家放了技能什么都没发生——后者坏得多，
 * 所以默认值站在"宁可多演，不可少算"这一边。
 *
 * `waitMs` 在表内，所以"打断时等待归零"是这条规则的副产物，不用另写一套时长改写。
 */
export const PRESENTATION_ONLY_ACTIONS: ReadonlySet<string> = new Set([
  // 时间本身
  'waitMs',
  // 画面演出
  'screenFlash', 'cameraShake', 'setSceneDim', 'fadeLight',
  'fadeWorldToBlack', 'fadeWorldFromBlack', 'showBlackout', 'hideBlackout',
  'setCameraZoom', 'restoreSceneCameraZoom', 'fadingZoom', 'fadingRestoreSceneCameraZoom',
  'cameraFollowActor', 'cameraStopFollow',
  'showOverlayImage', 'hideOverlayImage', 'blendOverlayImage',
  // 呼吸图:纯表演(不写存档),跳过时跟叠图同一待遇
  'showBreathingOverlay', 'breathingPerform', 'setBreathingParams',
  // 画布：纯表演（不写存档），跳过过场时跟叠图同一待遇
  'showCanvasEntity', 'hideCanvasEntity', 'playCanvasEntityAnimation',
  'setCanvasEntityTransform', 'setCanvasOrder',
  'playCanvasVfx', 'stopCanvasVfx', 'clearCanvas',
  // 声音
  'playSfx', 'playBgm', 'stopBgm', 'playSceneAmbient', 'stopSceneAmbient',
  'duckAudio', 'restoreAudio',
  // 粒子与风
  'playVfx', 'stopVfx', 'playPropVfx', 'setVfxState', 'emitVfxField', 'sceneWindGust',
  // 头顶气泡 / 表情（信息量在别处，跳掉不丢后果）
  'showEmote', 'showSpeechBubble', 'showEmoteAndWait', 'showSpeechBubbleAndWait',
  // 提示条：跳掉只是少弹一条 toast，弹在过场上面反而是事故
  'showNotification',
  // 实体演出走位（持久版是 persistNpcAt / persistPlayNpcAnimation，那些照跑）
  'moveEntityTo', 'jumpEntityTo', 'faceEntity', 'playNpcAnimation', 'stopNpcPatrol',
  'playTrajectory', 'stopTrajectory',
]);

/**
 * **脱手演出里禁止出现的动作**：抢控制权、换世界、推时间。
 *
 * 脱手演出的全部意义就是"跑在玩家背后、玩家全程能动"。里面一旦出现这些，
 * 技能就会在任意时刻把玩家从他正在做的事里拽走——那正是这套东西要根治的毛病。
 * 校验器按这张表**报 error**（不是 warning：配出来就是随机时刻抢控制，没有合理用法）。
 */
export const DETACHED_FORBIDDEN_ACTIONS: ReadonlySet<string> = new Set([
  // 接管态入口
  'startCutscene', 'startEncounter', 'startDialogueGraph', 'playScriptedDialogue',
  'chooseAction', 'waitClickContinue', 'openShop', 'openMap',
  'startWaterMinigame', 'startSugarWheelMinigame', 'startPaperCraftMinigame',
  'startObjectExamine', 'startPressureHold',
  'revealDocument', 'showSystemNote',
  'triggerDeathTether',
  // 换世界 / 推时间
  'switchScene', 'changeScene', 'endDay', 'advanceTime', 'advanceTimeTo',
]);

/** 快进时这条动作该不该整条跳过。表外一律「跑」（见 PRESENTATION_ONLY_ACTIONS 的缺省取向）。 */
export function isPresentationOnlyAction(actionType: string): boolean {
  return PRESENTATION_ONLY_ACTIONS.has(String(actionType ?? '').trim());
}
