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
  chooseAction: { required: ['options'], optional: ['prompt', 'allowCancel'] },
  randomBranch: { required: [], optional: ['probability', 'aboveActions', 'belowActions'] },

  // ---- 叙事 / scenario ----
  emitNarrativeSignal: { required: ['signal'], nonEmpty: ['signal'], optional: ['sourceType', 'sourceId'] },
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
  revealDocument: { required: ['documentId'], nonEmpty: ['documentId'] },

  // ---- 背包 / 货币 / 规矩 / 任务 ----
  giveItem: { required: ['id'], nonEmpty: ['id'], optional: ['count', 'critical'] },
  removeItem: { required: ['id'], nonEmpty: ['id'], optional: ['count'] },
  giveCurrency: { required: ['amount'] },
  removeCurrency: { required: ['amount'], nonEmpty: ['amount'] },
  giveRule: { required: ['id'], nonEmpty: ['id'] },
  grantRuleLayer: { required: ['ruleId', 'layer'], nonEmpty: ['ruleId', 'layer'] },
  giveFragment: { required: ['id'], nonEmpty: ['id'] },
  updateQuest: { required: ['id'], nonEmpty: ['id'] },
  pickup: { required: ['itemName', 'count'], nonEmpty: ['itemName'], optional: ['itemId', 'isCurrency'] },
  shopPurchase: { required: ['itemId', 'price'], nonEmpty: ['itemId'] },
  inventoryDiscard: { required: ['itemId'], nonEmpty: ['itemId'] },
  openShop: { required: ['shopId'], nonEmpty: ['shopId'] },

  // ---- 遭遇 / 音频 / 日程 ----
  startEncounter: { required: ['id'], nonEmpty: ['id'] },
  playBgm: { required: ['id'], nonEmpty: ['id'], optional: ['fadeMs'] },
  stopBgm: { required: [], optional: ['fadeMs'] },
  playSfx: { required: ['id'], nonEmpty: ['id'], optional: ['volume'] },
  stopSceneAmbient: { required: [], optional: ['id', 'fadeMs'] },
  endDay: { required: [] },
  addDelayedEvent: { required: ['targetDay', 'actions'] },

  // ---- 档案 / 过场 / 小游戏 ----
  addArchiveEntry: { required: ['bookType', 'entryId'], nonEmpty: ['bookType', 'entryId'] },
  startCutscene: { required: ['id'], nonEmpty: ['id'] },
  startWaterMinigame: { required: ['id'], nonEmpty: ['id'] },
  startSugarWheelMinigame: { required: ['id'], nonEmpty: ['id'] },
  startPaperCraftMinigame: { required: ['id'], nonEmpty: ['id'] },
  startPressureHold: { required: ['id'], nonEmpty: ['id'] },
  playSignalCue: { required: ['id'], nonEmpty: ['id'] },
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
  incHealth: { required: ['amount'] },
  decHealth: { required: ['amount'] },
  triggerDeathTether: { required: [] },
  setSmell: { required: ['scent'], nonEmpty: ['scent'], optional: ['intensity', 'dir', 'flicker'] },
  clearSmell: { required: [] },
  sniff: { required: [] },

  // ---- 位面 ----
  activatePlane: { required: ['id'], nonEmpty: ['id'] },
  deactivatePlane: { required: [] },

  // ---- 气泡 / 动画 / 实体显隐 ----
  showEmote: {
    required: ['target', 'emote'],
    nonEmpty: ['target', 'emote'],
    optional: ['duration', 'anchorOffsetX', 'anchorOffsetY'],
  },
  showSpeechBubble: {
    required: ['target', 'text'],
    nonEmpty: ['target', 'text'],
    optional: ['emote', 'duration', 'anchorOffsetX', 'anchorOffsetY'],
  },
  showEmoteAndWait: {
    required: ['target', 'emote'],
    nonEmpty: ['target', 'emote'],
    optional: ['duration', 'anchorOffsetX', 'anchorOffsetY'],
  },
  showSpeechBubbleAndWait: {
    required: ['target', 'text'],
    nonEmpty: ['target', 'text'],
    optional: ['emote', 'duration', 'anchorOffsetX', 'anchorOffsetY'],
  },
  playNpcAnimation: {
    required: ['target', 'state'],
    nonEmpty: ['target', 'state'],
    // speed 倍率 / reverse 倒放 / holdFrame 定格帧 / thenState 非循环播完自动切换
    optional: ['speed', 'reverse', 'holdFrame', 'thenState'],
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
  setSceneDepthFloorOffset: { required: ['floor_offset'] },
  resetSceneDepthFloorOffset: { required: [] },
  setCameraZoom: { required: ['zoom'] },
  restoreSceneCameraZoom: { required: [] },
  fadingZoom: { required: ['zoom'], optional: ['durationMs', 'duration'] },
  fadingRestoreSceneCameraZoom: { required: [], optional: ['durationMs', 'duration'] },
  fadeWorldToBlack: { required: [], optional: ['durationMs', 'duration'] },
  fadeWorldFromBlack: { required: [], optional: ['durationMs', 'duration'] },

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
    optional: ['entityKind'],
  },
  persistNpcAt: { required: ['target', 'x', 'y'], nonEmpty: ['target'] },
  persistNpcAnimState: { required: ['target', 'state'], nonEmpty: ['target', 'state'] },
  persistPlayNpcAnimation: { required: ['target', 'state'], nonEmpty: ['target', 'state'] },

  // ---- 叠图 / 热点展示 / 实体字段 ----
  showOverlayImage: {
    required: ['id', 'image', 'xPercent', 'yPercent', 'widthPercent'],
    nonEmpty: ['id', 'image'],
  },
  hideOverlayImage: { required: ['id'], nonEmpty: ['id'] },
  blendOverlayImage: {
    required: ['id', 'fromImage', 'toImage', 'xPercent', 'yPercent', 'widthPercent'],
    nonEmpty: ['id', 'fromImage', 'toImage'],
    optional: ['durationMs', 'delayMs'],
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

  // ---- 对话 / 演出 ----
  startDialogueGraph: {
    required: ['graphId'],
    nonEmpty: ['graphId'],
    optional: ['entry', 'npcId', 'ownerType', 'ownerId', 'dimBackground'],
  },
  waitClickContinue: { required: [], optional: ['text'] },
  playScriptedDialogue: { required: ['lines'], optional: ['scriptedNpcId', 'dimBackground'] },
  waitMs: { required: [], optional: ['durationMs'] },
  moveEntityTo: {
    required: ['target', 'x', 'y'],
    nonEmpty: ['target'],
    // sceneId 仅编辑器复现地图用，运行时忽略。
    optional: ['speed', 'waypoints', 'moveAnimState', 'faceTowardMovement', 'sceneId'],
  },
  // direction / faceTarget 二选一（运行时校验至少一个），条件必填不在缺参检查建模。
  faceEntity: { required: ['target'], nonEmpty: ['target'], optional: ['direction', 'faceTarget'] },
  cutsceneSpawnActor: { required: ['id', 'x', 'y'], nonEmpty: ['id'], optional: ['name'] },
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
