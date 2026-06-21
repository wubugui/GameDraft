/**
 * 游戏内 Action 注册表。
 *
 * 约定：凡在此处 executor.register 的新类型，必须同步到
 * `tools/editor/shared/action_editor.py` 的 ACTION_TYPES，并配置 _PARAM_SCHEMAS
 * 或 setPlayerAvatar / enableRuleOffers 等专用表单，否则主编辑器无法添加该 Action，
 * 且 `tools/editor/validator.py` 会对数据中的未知 type 报错。
 * 主编辑器中 Action 的 type 下拉为「仅选清单」模式，与 ACTION_TYPES 一致，不可手写未登记 type。
 *
 * 所有调用方（zone onEnter、图对话 runActions、热区 inspect、任务奖励等）共用同一条解算链路：
 * `ActionExecutor.executeAwait`，顺序 await handler 返回的 Promise。
 */
import type { ActionExecutor } from './ActionExecutor';
import type { RuleOfferRegistry } from './RuleOfferRegistry';
import type { EventBus } from './EventBus';
import type { StringsProvider } from './StringsProvider';
import type { GameStateController } from './GameStateController';
import type { InventoryManager } from '../systems/InventoryManager';
import type { RulesManager } from '../systems/RulesManager';
import type { QuestManager } from '../systems/QuestManager';
import type { EncounterManager } from '../systems/EncounterManager';
import type { AudioManager } from '../systems/AudioManager';
import type { DayManager } from '../systems/DayManager';
import type { ArchiveManager } from '../systems/ArchiveManager';
import type { CutsceneManager } from '../systems/CutsceneManager';
import type { SceneManager } from '../systems/SceneManager';
import type { EmoteBubbleManager } from '../systems/EmoteBubbleManager';
import type { ScenarioStateManager } from './ScenarioStateManager';
import type { NarrativeStateManager } from './NarrativeStateManager';
import type { DocumentRevealManager } from '../systems/DocumentRevealManager';
import type { WaterMinigameManager } from '../systems/waterMinigame/WaterMinigameManager';
import type { SugarWheelMinigameManager } from '../systems/sugarWheel/SugarWheelMinigameManager';
import type { PaperCraftMinigameManager } from '../systems/paperCraft/PaperCraftMinigameManager';
import type { PressureHoldManager } from '../systems/pressureHold/PressureHoldManager';
import type { SignalCueManager } from '../systems/SignalCueManager';
import type { ActionDef, DialogueLine, ICutsceneActor, IEmoteBubbleAnchor, ZoneRuleSlot, RuleLayerKey } from '../data/types';
import { GameState } from '../data/types';
import type { SceneEntityKind, RuntimeFieldValue } from '../data/EntityRuntimeFieldSchema';
import { applyDialogueColonSpeakerFromResolvedText } from './resolveText';

/**
 * `removeCurrency.params.amount`：可为数字或字符串（含 `[tag:…]`）；
 * 经 `resolveDisplayText` 后应为有限数字，向下取整；空、非数、负数为无效（打日志并跳过）。
 */
function resolveCurrencyAmountParam(
  raw: unknown,
  resolveDisplayText: (s: string) => string,
): number | null {
  const s0 = raw === undefined || raw === null ? '' : String(raw);
  const resolved = resolveDisplayText(s0).trim();
  if (!resolved) {
    console.warn('removeCurrency: amount 为空，已跳过');
    return null;
  }
  const n = Number(resolved);
  if (!Number.isFinite(n)) {
    console.warn(`removeCurrency: 无法将解析结果当作数字: ${JSON.stringify(resolved)}`);
    return null;
  }
  const k = Math.trunc(n);
  if (k < 0) {
    console.warn(`removeCurrency: amount 为负 (${k})，已跳过`);
    return null;
  }
  return k;
}

export interface ActionRegistryDeps {
  /** playScriptedDialogue speaker 中的 {{player}} / {{npc}} 等占位解析；scriptedNpcId 为 params.scriptedNpcId */
  resolveScriptedSpeaker: (raw: string, scriptedNpcId?: string) => string;
  ruleOfferRegistry: RuleOfferRegistry;
  inventoryManager: InventoryManager;
  rulesManager: RulesManager;
  questManager: QuestManager;
  encounterManager: EncounterManager;
  audioManager: AudioManager;
  dayManager: DayManager;
  archiveManager: ArchiveManager;
  cutsceneManager: CutsceneManager;
  sceneManager: SceneManager;
  emoteBubbleManager: EmoteBubbleManager;
  stateController: GameStateController;
  stringsProvider: StringsProvider;
  eventBus: EventBus;
  resolveActor: (id: string) => ICutsceneActor | null;
  /**
   * showEmote / showSpeechBubble：`target` 可为 NPC / `player` / 过场 `_cut_*` / **当前场景热点 id**；
   * 热点仅作气泡挂载点（无朝向/动画），锚点见 `Hotspot.getEmoteBubbleAnchorLocalY()`。
   */
  resolveEmoteTarget: (id: string) => IEmoteBubbleAnchor | null;
  pickupNotification: { show(name: string, count: number): void; forceCleanup(): void };
  inspectBox: { readonly isOpen: boolean; close(): void };
  shopUI: { openShop(shopId: string): void };
  /** 运行时切换玩家动画包与 idle/walk/run clip映射（失败则保持当前化身） */
  applyPlayerAvatar: (manifestPath: string, stateMap?: Record<string, string> | null) => Promise<void>;
  /** 按 game_config.playerAvatar 恢复玩家化身 */
  resetPlayerAvatar: () => Promise<void>;
  /** 运行时覆盖场景深度遮挡的 floor_offset（脚底衬底偏移，与 depthConfig 同语义） */
  setSceneDepthFloorOffset: (floorOffset: number) => void;
  /** 恢复为当前场景已加载的 depthConfig.floor_offset */
  resetSceneDepthFloorOffset: () => void;
  /** 对话等临时拉近：直接设置 Camera.zoom（与场景 JSON camera.zoom 同语义） */
  setCameraZoom: (zoom: number) => void;
  /** 恢复为当前场景数据中的 camera.zoom（无配置则 1） */
  restoreSceneCameraZoom: () => void;
  /** 渐变拉远/还原到当前场景 JSON 中的 camera.zoom（durationMs 毫秒） */
  fadingRestoreSceneCameraZoom: (durationMs: number) => Promise<void>;
  /** 停止指定 NPC 的巡逻协程（打断位移 + 失效该次巡逻 token） */
  stopNpcPatrol: (npcId: string) => void;
  /** 在当前场景为该 NPC 重新启动巡逻（会先 stop再跑，避免重复协程） */
  startNpcPatrol: (npcId: string) => void;
  /** 屏幕叠加图（百分比布局，与 hideOverlayImage 成对） */
  showOverlayImage: (
    id: string,
    imagePath: string,
    xPercent: number,
    yPercent: number,
    widthPercent: number,
  ) => Promise<void>;
  /**
   * 将 overlay_images.json 中的短 id 解析为 /assets/... 路径；
   * 若以 / 开头则视为已是完整路径，不查表。
   */
  resolveOverlayImagePath: (image: string) => string;
  hideOverlayImage: (id: string) => void;
  /** 双图叠化（与 showOverlayImage 同布局与 id，durationMs 结束后保留目标图） */
  blendOverlayImage: (
    id: string,
    fromImagePath: string,
    toImagePath: string,
    xPercent: number,
    yPercent: number,
    widthPercent: number,
    durationMs: number,
    delayMs: number,
  ) => Promise<void>;
  /** 图对话（参数 graphId 对应 `graphs/<graphId>.json`） */
  startDialogueGraph: (
    graphId: string,
    entry?: string,
    npcId?: string,
    ownerType?: string,
    ownerId?: string,
  ) => Promise<void>;
  /** 按序播放预置台词（至 dialogue:end） */
  playScriptedDialogue: (lines: DialogueLine[]) => Promise<void>;
  /** 显示「点击继续」类提示并阻塞直至任意键或鼠标 */
  waitClickContinue: (hintOverride?: string) => Promise<void>;
  /** 统一解析 JSON 字符串中的 [tag:…] */
  resolveDisplayText: (raw: string) => string;
  /** Action 专用选项 UI：返回所选 options 下标；取消返回 null。 */
  chooseAction: (
    prompt: string,
    options: { text: string }[],
    allowCancel: boolean,
  ) => Promise<number | null>;
  /**
   * `playScriptedDialogue`：`[tag:npc:@context]` 在无图对白时用 scriptedNpcId 补全上下文。
   */
  resolveDisplayTextForPlayScripted: (raw: string | undefined, scriptedNpcId?: string) => string;
  scenarioStateManager: ScenarioStateManager;
  narrativeStateManager: NarrativeStateManager;
  documentRevealManager: DocumentRevealManager;
  /** 在 CutsceneManager 临时表中 spawn 一个临时实体并挂载到显示层 */
  spawnCutsceneActor: (id: string, name: string, x: number, y: number) => void;
  /** 从 CutsceneManager 临时表中移除一个临时实体并销毁 */
  removeCutsceneActor: (id: string) => void;
  /** 写入 sceneId/entityKind/entityId/fieldName 的可存档字段，并在已加载时即时应用 */
  setSceneEntityField: (
    sceneId: string,
    kind: SceneEntityKind,
    entityId: string,
    fieldName: string,
    value: RuntimeFieldValue,
  ) => Promise<void>;
  /**
   * 将指定热点的展示图换为已存在的贴图路径（与 scene JSON displayImage 同语义）。
   * worldWidth / worldHeight / facing 可选：见 Game.setHotspotDisplayImageFromAction。
   */
  setHotspotDisplayImage: (
    sceneId: string,
    hotspotId: string,
    imagePath: string,
    worldWidth?: number,
    worldHeight?: number,
    facing?: 'left' | 'right',
  ) => Promise<void>;
  /**
   * 仅当前已加载场景实例：临时覆盖热点展示图朝向，不写 Save/场景 JSON。
   * facing 为 restore 时清除覆盖，回到 displayImage.facing。
   */
  tempSetHotspotDisplayFacing: (
    sceneId: string,
    hotspotId: string,
    facing: 'left' | 'right' | 'restore',
  ) => void;
  /** F2 调试面板「日志」(与 Console 并行，供 showEmote 等运行时诊断)。 */
  debugPanelLog?: (message: string) => void;
  waterMinigameManager: WaterMinigameManager;
  sugarWheelMinigameManager: SugarWheelMinigameManager;
  paperCraftMinigameManager: PaperCraftMinigameManager;
  pressureHoldManager: PressureHoldManager;
  signalCueManager: SignalCueManager;
}

function parseEmoteOffsetParams(params: Record<string, unknown>): { anchorOffsetX: number; anchorOffsetY: number } {
  const ox = Number(params.anchorOffsetX);
  const oy = Number(params.anchorOffsetY);
  return {
    anchorOffsetX: Number.isFinite(ox) ? ox : 0,
    anchorOffsetY: Number.isFinite(oy) ? oy : 0,
  };
}

/** moveEntityTo.params.waypoints：世界坐标折线途经点（终点由 x/y 给出，须单独 append）。 */
function parseMoveEntityWaypointList(raw: unknown): Array<{ x: number; y: number }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ x: number; y: number }> = [];
  for (const it of raw) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    const xv = typeof o.x === 'number' ? o.x : Number(o.x);
    const yv = typeof o.y === 'number' ? o.y : Number(o.y);
    if (Number.isFinite(xv) && Number.isFinite(yv)) {
      out.push({ x: xv, y: yv });
    }
  }
  return out;
}

/** moveEntityTo.params.faceTowardMovement：true 时沿路持续更新朝向；缺省/假为旧行为。 */
function parseFaceTowardMovementParam(raw: unknown): boolean {
  if (raw === true) return true;
  if (raw === false || raw === undefined || raw === null) return false;
  if (typeof raw === 'number') return raw !== 0;
  const s = String(raw).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}

/** showSpeechBubble*：对白用 `text`；兼容沿用 `emote` 键以便从 showEmote 复制参数。 */
function speechBubbleRawText(params: Record<string, unknown>): string {
  const t = String(params.text ?? '').trim();
  if (t) return t;
  return String(params.emote ?? '').trim();
}

function isParamObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function actionListFromParam(raw: unknown): ActionDef[] {
  if (!Array.isArray(raw)) return [];
  const out: ActionDef[] = [];
  for (const x of raw) {
    if (!isParamObject(x) || typeof x.type !== 'string') continue;
    out.push({
      type: x.type,
      params: isParamObject(x.params) ? x.params : {},
    });
  }
  return out;
}

/** 写入 F2 调试面板日志（ deps 可选时 no-op）。 */
function dbg(deps: ActionRegistryDeps, line: string): void {
  deps.debugPanelLog?.(`[showEmote] ${line}`);
}

export function registerActionHandlers(executor: ActionExecutor, d: ActionRegistryDeps): void {
  executor.register('enableRuleOffers', (p, zctx) => {
    if (!zctx?.zoneId) {
      console.warn('enableRuleOffers: missing zone context (must run from ZoneSystem batch)');
      return;
    }
    const slots = p.slots as ZoneRuleSlot[] | undefined;
    if (!slots || !Array.isArray(slots)) return;
    d.ruleOfferRegistry.register(zctx.zoneId, slots);
  }, ['slots']);

  executor.register('disableRuleOffers', (_p, zctx) => {
    if (!zctx?.zoneId) {
      console.warn('disableRuleOffers: missing zone context (must run from ZoneSystem batch)');
      return;
    }
    d.ruleOfferRegistry.unregister(zctx.zoneId);
  }, []);

  executor.register('runActions', async (p) => {
    await executor.executeBatchAwait(actionListFromParam(p.actions));
  }, ['actions']);

  executor.register('chooseAction', async (p) => {
    const rawOptions = Array.isArray(p.options) ? p.options : [];
    const options = rawOptions
      .filter((x): x is Record<string, unknown> => isParamObject(x))
      .map((x) => ({
        text: d.resolveDisplayText(String(x.text ?? '')).trim(),
        actions: actionListFromParam(x.actions),
      }))
      .filter((x) => x.text.length > 0);
    if (options.length === 0) {
      console.warn('chooseAction: options 为空');
      return;
    }
    const prevState = d.stateController.currentState;
    d.stateController.setState(GameState.UIOverlay);
    let picked: number | null = null;
    try {
      picked = await d.chooseAction(
        d.resolveDisplayText(String(p.prompt ?? '')),
        options.map((x) => ({ text: x.text })),
        p.allowCancel === true,
      );
    } finally {
      if (d.stateController.currentState === GameState.UIOverlay) {
        d.stateController.setState(prevState);
      }
    }
    if (picked === null || picked < 0 || picked >= options.length) return;
    await executor.executeBatchAwait(options[picked].actions);
  }, ['prompt', 'options', 'allowCancel']);

  /** r ∈ [0,1) 均匀采样；r > probability → aboveActions，否则 belowActions。probability 夹到 [0,1]。 */
  executor.register('randomBranch', async (p) => {
    const raw = p.probability;
    let threshold = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(threshold)) threshold = 0.5;
    threshold = Math.min(1, Math.max(0, threshold));
    const r = Math.random();
    const above = r > threshold;
    const key = above ? 'aboveActions' : 'belowActions';
    const actions = actionListFromParam(p[key]);
    await executor.executeBatchAwait(actions);
  }, ['probability', 'aboveActions', 'belowActions']);

  executor.register('setScenarioPhase', (p) => {
    const scenarioId = String(p.scenarioId ?? '').trim();
    const phase = String(p.phase ?? '').trim();
    const status = String(p.status ?? '').trim();
    if (!scenarioId || !phase || !status) return;
    const outcome = p.outcome;
    d.scenarioStateManager.setScenarioPhase(scenarioId, phase, {
      status,
      outcome:
        outcome === undefined || outcome === null
          ? undefined
          : (outcome as string | number | boolean),
    });
  }, ['scenarioId', 'phase', 'status']);

  /** 显式进线：校验进线 `requires`（不写入状态）；未满足时抛出 `ScenarioLineEntryRequiresError`（与首次 `setScenarioPhase` 一致）。 */
  executor.register('startScenario', (p) => {
    const scenarioId = String(p.scenarioId ?? '').trim();
    if (!scenarioId) return;
    d.scenarioStateManager.assertScenarioLineEntryForAction(scenarioId);
  }, ['scenarioId']);

  executor.register('activateScenario', (p) => {
    const scenarioId = String(p.scenarioId ?? '').trim();
    if (!scenarioId) return;
    d.scenarioStateManager.activateScenarioLine(scenarioId);
  }, ['scenarioId']);

  executor.register('completeScenario', (p) => {
    const scenarioId = String(p.scenarioId ?? '').trim();
    if (!scenarioId) return;
    d.scenarioStateManager.completeScenarioLine(scenarioId);
  }, ['scenarioId']);

  executor.register('emitNarrativeSignal', (p) => {
    const signal = String(p.signal ?? '').trim();
    if (!signal) {
      console.warn('emitNarrativeSignal: missing signal (event id)', p);
      return;
    }
    const sourceType = String(p.sourceType ?? '').trim();
    const sourceId = String(p.sourceId ?? '').trim();
    return d.narrativeStateManager.emitNarrativeSignal({
      signal,
      ...(sourceType && sourceId ? { sourceType: sourceType as any, sourceId } : {}),
    });
  }, ['signal']);

  executor.register('giveItem', (p) => { void d.inventoryManager.addItem(p.id as string, (p.count as number) ?? 1); }, ['id', 'count']);
  executor.register('removeItem', (p) => { void d.inventoryManager.removeItem(p.id as string, (p.count as number) ?? 1); }, ['id', 'count']);
  executor.register('giveCurrency', (p) => { void d.inventoryManager.addCoins(p.amount as number); }, ['amount']);
  executor.register('removeCurrency', (p) => {
    const amt = resolveCurrencyAmountParam(p.amount, d.resolveDisplayText);
    if (amt === null) return;
    void d.inventoryManager.removeCoins(amt);
  }, ['amount']);
  executor.register('giveRule', (p) => { void d.rulesManager.giveRule(p.id as string); }, ['id']);
  executor.register('grantRuleLayer', (p) => {
    const ruleId = String(p.ruleId ?? '').trim();
    const layerRaw = String(p.layer ?? '').trim();
    if (!ruleId || !['xiang', 'li', 'shu'].includes(layerRaw)) {
      console.warn('grantRuleLayer: 需要 params.ruleId 与 params.layer（xiang|li|shu）');
      return;
    }
    d.rulesManager.grantLayer(ruleId, layerRaw as RuleLayerKey);
  }, ['ruleId', 'layer']);
  executor.register('giveFragment', (p) => { void d.rulesManager.giveFragment(p.id as string); }, ['id']);
  executor.register('updateQuest', (p) => { void d.questManager.acceptQuest(p.id as string); }, ['id']);

  executor.register('startEncounter', (p) => {
    d.stateController.setState(GameState.Encounter);
    d.encounterManager.startEncounter(p.id as string);
  }, ['id']);

  executor.register('playBgm', (p) => { void d.audioManager.playBgm(p.id as string, (p.fadeMs as number) ?? 1000); }, ['id', 'fadeMs']);
  executor.register('stopBgm', (p) => { void d.audioManager.stopBgm((p.fadeMs as number) ?? 1000); }, ['fadeMs']);
  executor.register('playSfx', (p) => { void d.audioManager.playSfx(p.id as string); }, ['id']);
  // 抽空场景环境音（如灵堂"阴风"骤停制造"太安静"的诡异一拍）：留空 id 清掉全部环境层，
  // 传 id 只停指定一层。复用 AudioManager 既有 clear/removeAmbient，不扩 ActionRegistryDeps。
  executor.register('stopSceneAmbient', (p) => {
    const fadeMs = (p.fadeMs as number) ?? 500;
    if (p.id) { d.audioManager.removeAmbient(p.id as string, fadeMs); }
    else { d.audioManager.clearAmbient(fadeMs); }
  }, ['id', 'fadeMs']);
  executor.register('endDay', () => { d.dayManager.endDay(); }, []);

  executor.register('addDelayedEvent', (p) => {
    const raw = p.actions;
    const actions = Array.isArray(raw)
      ? (raw as unknown[]).filter((a): a is ActionDef => {
          return !!a && typeof a === 'object' && typeof (a as { type?: unknown }).type === 'string';
        })
      : [];
    if (Array.isArray(raw) && raw.length > 0 && actions.length !== raw.length) {
      console.warn('addDelayedEvent: 已跳过无效的嵌套动作项');
    }
    d.dayManager.addDelayedEvent(p.targetDay as number, actions);
  }, ['targetDay', 'actions']);

  executor.register('addArchiveEntry', (p) => {
    d.archiveManager.addEntry(
      p.bookType as 'character' | 'lore' | 'document' | 'book' | 'bookEntry',
      p.entryId as string,
    );
  }, ['bookType', 'entryId']);

  executor.register('startCutscene', (p) => {
    // 进入前的状态可能是 Exploring 加锁后的 ActionSequence、或对话 runActions 里的 Dialogue。
    // 结束后恢复到该状态，而非硬切 Exploring（否则会顶掉仍在进行的对话）。
    const prev = d.stateController.currentState;
    const restore = () => {
      if (d.stateController.currentState === GameState.Cutscene) {
        d.stateController.setState(prev);
      }
    };
    d.stateController.setState(GameState.Cutscene);
    return d.cutsceneManager.startCutscene(p.id as string)
      .then(restore)
      .catch((e) => {
        console.warn('ActionRegistry: startCutscene failed', e);
        restore();
      });
  }, ['id']);

  executor.register('startWaterMinigame', async (p) => {
    const id = String(p.id ?? '').trim();
    if (!id) {
      console.warn('startWaterMinigame: 需要 params.id');
      return;
    }
    await d.waterMinigameManager.runUntilDone(id);
  }, ['id']);

  executor.register('startPressureHold', async (p) => {
    const id = String(p.id ?? '').trim();
    if (!id) {
      console.warn('startPressureHold: 需要 params.id');
      return;
    }
    await d.pressureHoldManager.runUntilDone(id);
  }, ['id']);

  executor.register('playSignalCue', async (p) => {
    const id = String(p.id ?? '').trim();
    if (!id) {
      console.warn('playSignalCue: 需要 params.id');
      return;
    }
    await d.signalCueManager.play(id);
  }, ['id']);

  executor.register('startSugarWheelMinigame', async (p) => {
    const id = String(p.id ?? '').trim();
    if (!id) {
      d.debugPanelLog?.('[糖画转盘] startSugarWheelMinigame: 需要 params.id');
      return;
    }
    await d.sugarWheelMinigameManager.runUntilDone(id);
  }, ['id']);

  executor.register('startPaperCraftMinigame', async (p) => {
    const id = String(p.id ?? '').trim();
    if (!id) {
      d.debugPanelLog?.('[扎纸小游戏] startPaperCraftMinigame: 需要 params.id');
      return;
    }
    await d.paperCraftMinigameManager.runUntilDone(id);
  }, ['id']);

  executor.register('sugarWheelShowSpeech', (p) => {
    const role = String(p.role ?? '').trim();
    const text = String(p.text ?? '').trim();
    if (!role || !text) {
      d.debugPanelLog?.('[糖画转盘] sugarWheelShowSpeech: 需要 role 与 text');
      return;
    }
    const dm = p.durationMs;
    const ms = typeof dm === 'number' && Number.isFinite(dm) ? dm : undefined;
    d.sugarWheelMinigameManager.showSpeech(role, text, ms);
  }, ['role', 'text']);

  executor.register('sugarWheelDismissSpeech', (p) => {
    const role = String(p.role ?? '').trim();
    if (!role) {
      d.debugPanelLog?.('[糖画转盘] sugarWheelDismissSpeech: 需要 role');
      return;
    }
    d.sugarWheelMinigameManager.dismissSpeech(role);
  }, ['role']);

  executor.register('sugarWheelDismissAllSpeech', () => {
    d.sugarWheelMinigameManager.dismissAllSpeech();
  }, []);

  executor.register('sugarWheelResetPointer', (p) => {
    const raw = (p.angleDeg ?? p.angle) as number | string | undefined;
    const deg = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(deg)) {
      d.debugPanelLog?.('[糖画转盘] sugarWheelResetPointer: params.angleDeg 须为数值（度）');
      return;
    }
    d.sugarWheelMinigameManager.resetPointerGeomAngleDeg(deg);
  }, ['angleDeg']);

  /** 测试：`alert(JSON.stringify(params))`；运行时糖画可走场景侧合并上下文字段（见 SugarWheelMinigameScene）。 */
  executor.register('debugAlertActionParams', (p) => {
    const title = typeof p.title === 'string' && p.title.trim() !== '' ? `${p.title.trim()}\n\n` : '';
    const body = `${title}${JSON.stringify(p, null, 2)}`;
    const gt = typeof globalThis !== 'undefined' ? globalThis : undefined;
    const a = gt && 'alert' in gt ? (gt.alert as unknown) : undefined;
    if (typeof a === 'function') {
      a.call(gt, body);
    } else {
      console.warn('debugAlertActionParams (no alert):', p);
    }
  }, []);

  executor.register('showEmote', (p) => {
    const target = String(p.target ?? '').trim();
    const emote = String(p.emote ?? '').trim();
    const sceneId = d.sceneManager.currentSceneData?.id ?? '';
    dbg(d, `开始 scene=${sceneId || '(?)'} target=${JSON.stringify(target)} emote=${JSON.stringify(emote)}`);
    if (!target || !emote) {
      dbg(d, '中止：缺少 target 或 emote');
      console.warn('showEmote: 需要 target 与 emote');
      return;
    }
    const subject = d.resolveEmoteTarget(target);
    const kind =
      subject && typeof (subject as ICutsceneActor).entityId === 'string'
        ? `ICutsceneActor(${(subject as ICutsceneActor).entityId})`
        : subject
          ? (subject.constructor?.name ?? 'unknown anchor')
          : 'null';
    dbg(d, `resolve 结果: ${kind}`);
    if (!subject) {
      dbg(d, '中止：resolveEmoteTarget 返回 null');
      console.warn(`showEmote: 找不到 NPC / player / 过场实体 / 当前场景热点 "${target}"`);
      return;
    }
    const durRaw = p.duration ?? 1500;
    const duration = typeof durRaw === 'number' ? durRaw : Number(durRaw);
    const off = parseEmoteOffsetParams(p);
    dbg(d, `调用 bubble.show durMs=${Number.isFinite(duration) && duration > 0 ? duration : 1500} off=(${off.anchorOffsetX},${off.anchorOffsetY})`);
    d.emoteBubbleManager.show(
      subject,
      emote,
      Number.isFinite(duration) && duration > 0 ? duration : 1500,
      off,
    );
    dbg(d, `bubble.show 已返回`);
  }, ['target', 'emote', 'duration', 'anchorOffsetX', 'anchorOffsetY']);

  /** 与 showEmote 相同锚点与白底气泡；params.text 为对白（经 resolveDisplayText，支持 `[tag:…]`）。 */
  executor.register('showSpeechBubble', (p) => {
    const target = String(p.target ?? '').trim();
    const raw = speechBubbleRawText(p);
    const sceneId = d.sceneManager.currentSceneData?.id ?? '';
    dbg(d, `[showSpeechBubble] scene=${sceneId || '(?)'} target=${JSON.stringify(target)} rawLen=${raw.length}`);
    if (!target || !raw) {
      console.warn('showSpeechBubble: 需要 target 与 text');
      return;
    }
    const text = d.resolveDisplayText(raw).trim();
    if (!text) {
      console.warn('showSpeechBubble: 解析后文案为空');
      return;
    }
    const subject = d.resolveEmoteTarget(target);
    if (!subject) {
      console.warn(`showSpeechBubble: 找不到 NPC / player / 过场实体 / 当前场景热点 "${target}"`);
      return;
    }
    const durRaw = p.duration ?? 1500;
    const duration = typeof durRaw === 'number' ? durRaw : Number(durRaw);
    const off = parseEmoteOffsetParams(p);
    d.emoteBubbleManager.show(
      subject,
      text,
      Number.isFinite(duration) && duration > 0 ? duration : 1500,
      off,
    );
  }, ['target', 'text', 'duration', 'anchorOffsetX', 'anchorOffsetY']);

  /** `target` 为 NPC id 或 `player`；`state` 为 anim.json 中的状态名（与 `npcAnim` 旧标签语义一致，统一走 Action）。 */
  executor.register('playNpcAnimation', (p) => {
    const target = String(p.target ?? '').trim();
    const state = String(p.state ?? '').trim();
    if (!target || !state) {
      console.warn('playNpcAnimation: 需要 target 与 state');
      return;
    }
    const actor = d.resolveActor(target);
    if (!actor) {
      console.warn(`playNpcAnimation: 找不到实体 "${target}"`);
      return;
    }
    actor.playAnimation(state);
  }, ['target', 'state']);

  /** `target` 为场景 NPC 的 `id` 或 `player`；`enabled` 为 false 时隐藏实体（不卸载，可再设为 true 显示）。 */
  executor.register('setEntityEnabled', (p) => {
    const target = String(p.target ?? '').trim();
    if (!target) {
      console.warn('setEntityEnabled: missing target');
      return;
    }
    const raw = p.enabled;
    if (raw === undefined || raw === null) {
      console.warn('setEntityEnabled: missing enabled');
      return;
    }
    let enabled: boolean;
    if (typeof raw === 'boolean') {
      enabled = raw;
    } else if (typeof raw === 'number') {
      enabled = raw !== 0;
    } else {
      const s = String(raw).trim().toLowerCase();
      if (s === 'true' || s === '1') enabled = true;
      else if (s === 'false' || s === '0') enabled = false;
      else {
        console.warn(`setEntityEnabled: invalid enabled ${String(raw)}`);
        return;
      }
    }
    const actor = d.resolveActor(target);
    if (!actor) {
      console.warn(`setEntityEnabled: no entity "${target}"`);
      return;
    }
    actor.setVisible(enabled);
  }, ['target', 'enabled']);

  executor.register('openShop', (p) => {
    d.stateController.setState(GameState.UIOverlay);
    d.shopUI.openShop(p.shopId as string);
  }, ['shopId']);

  executor.register('pickup', (p) => {
    if (p.isCurrency as boolean | undefined) {
      d.inventoryManager.addCoins(p.count as number);
    } else {
      d.inventoryManager.addItem(p.itemId as string, p.count as number);
    }
    d.pickupNotification.show(p.itemName as string, p.count as number);
  }, ['itemId', 'itemName', 'count', 'isCurrency']);

  const prepareSceneSwitch = () => {
    d.pickupNotification.forceCleanup();
    if (d.inspectBox.isOpen) d.inspectBox.close();
  };

  executor.register('switchScene', (p) => {
    const prev = d.stateController.currentState;
    const restore = () => {
      if (d.stateController.currentState === GameState.Cutscene) {
        d.stateController.setState(prev);
      }
    };
    d.stateController.setState(GameState.Cutscene);
    prepareSceneSwitch();
    return d.sceneManager.switchScene(p.targetScene as string, p.targetSpawnPoint as string | undefined)
      .then(restore)
      .catch((e) => {
        console.warn('ActionRegistry: switchScene failed', e);
        restore();
      });
  }, ['targetScene', 'targetSpawnPoint']);

  executor.register('changeScene', (p) => {
    const prev = d.stateController.currentState;
    const restore = () => {
      if (d.stateController.currentState === GameState.Cutscene) {
        d.stateController.setState(prev);
      }
    };
    d.stateController.setState(GameState.Cutscene);
    prepareSceneSwitch();
    const cam = typeof p.cameraX === 'number' && typeof p.cameraY === 'number'
      ? { x: p.cameraX as number, y: p.cameraY as number } : undefined;
    return d.sceneManager.switchScene(p.targetScene as string, p.targetSpawnPoint as string | undefined, cam)
      .then(restore)
      .catch((e) => {
        console.warn('ActionRegistry: changeScene failed', e);
        restore();
      });
  }, ['targetScene', 'targetSpawnPoint', 'cameraX', 'cameraY']);

  executor.register('shopPurchase', (p) => {
    const itemId = p.itemId as string;
    const price = p.price as number;
    if (!d.inventoryManager.removeCoins(price)) {
      d.eventBus.emit('notification:show', {
        text: d.stringsProvider.get('notifications', 'currencyInsufficient'),
        type: 'warning',
      });
      return;
    }
    if (!d.inventoryManager.addItem(itemId, 1)) {
      d.inventoryManager.addCoins(price);
      return;
    }
    const def = d.inventoryManager.getItemDef(itemId);
    d.eventBus.emit('notification:show', {
      text: d.stringsProvider.get('notifications', 'shopPurchased', { name: def?.name ?? itemId }),
      type: 'info',
    });
  }, ['itemId', 'price']);

  executor.register('inventoryDiscard', (p) => { void d.inventoryManager.discardItem(p.itemId as string); }, ['itemId']);

  executor.register('setPlayerAvatar', (p) => {
    let path = String(p.animManifest ?? '').trim();
    if (!path) {
      const bid = String(p.bundleId ?? '').trim();
      if (bid) path = `/resources/runtime/animation/${bid}/anim.json`;
    }
    if (!path) {
      console.warn('setPlayerAvatar: 需要 params.animManifest 或 params.bundleId');
      return;
    }
    const raw = p.stateMap;
    let stateMap: Record<string, string> | undefined;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof v === 'string' && v.trim()) out[k] = v.trim();
      }
      stateMap = Object.keys(out).length > 0 ? out : undefined;
    }
    return d.applyPlayerAvatar(path, stateMap).catch((e) => console.warn('setPlayerAvatar', e));
  }, ['animManifest', 'bundleId', 'stateMap']);

  executor.register('resetPlayerAvatar', (_p) => {
    return d.resetPlayerAvatar().catch((e) => console.warn('resetPlayerAvatar', e));
  }, []);

  executor.register('setSceneDepthFloorOffset', (p) => {
    const raw = p.floor_offset;
    const v = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(v)) {
      console.warn('setSceneDepthFloorOffset: params.floor_offset 需为有限数值');
      return;
    }
    d.setSceneDepthFloorOffset(v);
  }, ['floor_offset']);

  executor.register('resetSceneDepthFloorOffset', (_p) => {
    d.resetSceneDepthFloorOffset();
  }, []);

  executor.register('setCameraZoom', (p) => {
    const v = typeof p.zoom === 'number' ? p.zoom : Number(p.zoom);
    if (!Number.isFinite(v) || v <= 0) {
      console.warn('setCameraZoom: params.zoom 需为有限正数');
      return;
    }
    d.setCameraZoom(v);
  }, ['zoom']);

  executor.register('restoreSceneCameraZoom', (_p) => {
    d.restoreSceneCameraZoom();
  }, []);

  executor.register('fadingZoom', async (p) => {
    const zoom = typeof p.zoom === 'number' ? p.zoom : Number(p.zoom);
    const durRaw = p.durationMs ?? p.duration ?? 600;
    const durationMs = typeof durRaw === 'number' ? durRaw : Number(durRaw);
    if (!Number.isFinite(zoom) || zoom <= 0) {
      console.warn('fadingZoom: params.zoom 需为有限正数');
      return;
    }
    const ms = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 600;
    await d.cutsceneManager.fadingCameraZoom(zoom, ms);
  }, ['zoom', 'durationMs']);

  executor.register('fadingRestoreSceneCameraZoom', async (p) => {
    const durRaw = p.durationMs ?? p.duration ?? 600;
    const durationMs = typeof durRaw === 'number' ? durRaw : Number(durRaw);
    const ms = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 600;
    await d.fadingRestoreSceneCameraZoom(ms);
  }, ['durationMs']);

  executor.register('stopNpcPatrol', (p) => {
    const id = typeof p.npcId === 'string' ? p.npcId.trim() : '';
    if (!id) {
      console.warn('stopNpcPatrol: missing or empty npcId');
      return;
    }
    d.stopNpcPatrol(id);
  }, ['npcId']);

  /** 写入场景记忆并立即 stopNpcPatrol；重进场景不再启动巡逻 */
  executor.register('persistNpcDisablePatrol', (p) => {
    const id = typeof p.npcId === 'string' ? p.npcId.trim() : '';
    if (!id) {
      console.warn('persistNpcDisablePatrol: missing or empty npcId');
      return;
    }
    d.sceneManager.mergePersistentNpcState(id, { patrolDisabled: true });
    d.stopNpcPatrol(id);
  }, ['npcId']);

  /** 清除「持久停巡逻」并立即在本场景重启巡逻协程；重进场景会照常启动巡逻 */
  executor.register('persistNpcEnablePatrol', (p) => {
    const id = typeof p.npcId === 'string' ? p.npcId.trim() : '';
    if (!id) {
      console.warn('persistNpcEnablePatrol: missing or empty npcId');
      return;
    }
    d.sceneManager.mergePersistentNpcState(id, { patrolDisabled: false });
    d.startNpcPatrol(id);
  }, ['npcId']);

  /** 写入场景记忆并立即 setVisible；重进场景保持显隐 */
  executor.register('persistNpcEntityEnabled', (p) => {
    const target = String(p.target ?? '').trim();
    if (!target) {
      console.warn('persistNpcEntityEnabled: missing target');
      return;
    }
    const raw = p.enabled;
    if (raw === undefined || raw === null) {
      console.warn('persistNpcEntityEnabled: missing enabled');
      return;
    }
    let enabled: boolean;
    if (typeof raw === 'boolean') {
      enabled = raw;
    } else if (typeof raw === 'number') {
      enabled = raw !== 0;
    } else {
      const s = String(raw).trim().toLowerCase();
      if (s === 'true' || s === '1') enabled = true;
      else if (s === 'false' || s === '0') enabled = false;
      else {
        console.warn(`persistNpcEntityEnabled: invalid enabled ${String(raw)}`);
        return;
      }
    }
    d.sceneManager.mergePersistentNpcState(target, { enabled });
    const actor = d.resolveActor(target);
    if (actor) {
      actor.setVisible(enabled);
    } else {
      console.warn(`persistNpcEntityEnabled: no entity "${target}"`);
    }
  }, ['target', 'enabled']);

  /** 写入 Save 热点 enabled 覆盖并立即 setEnabled；与 setEntityField(hotspot, enabled) 等价 */
  executor.register('persistHotspotEnabled', (p) => {
    const sceneId = String(p.sceneId ?? '').trim();
    const hotspotId = String(p.hotspotId ?? '').trim();
    if (!sceneId || !hotspotId) {
      console.warn('persistHotspotEnabled: 需要 sceneId、hotspotId');
      return;
    }
    const raw = p.enabled;
    if (raw === undefined || raw === null) {
      console.warn('persistHotspotEnabled: missing enabled');
      return;
    }
    let enabled: boolean;
    if (typeof raw === 'boolean') {
      enabled = raw;
    } else if (typeof raw === 'number') {
      enabled = raw !== 0;
    } else {
      const s = String(raw).trim().toLowerCase();
      if (s === 'true' || s === '1') enabled = true;
      else if (s === 'false' || s === '0') enabled = false;
      else {
        console.warn(`persistHotspotEnabled: invalid enabled ${String(raw)}`);
        return;
      }
    }
    return d
      .setSceneEntityField(sceneId, 'hotspot', hotspotId, 'enabled', enabled)
      .catch((e) => {
        console.warn('ActionRegistry: persistHotspotEnabled failed', e);
      });
  }, ['sceneId', 'hotspotId', 'enabled']);

  const parseZoneEnabledParam = (raw: unknown): boolean | null => {
    if (raw === undefined || raw === null) return null;
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'number') return raw !== 0;
    const s = String(raw).trim().toLowerCase();
    if (s === 'true' || s === '1') return true;
    if (s === 'false' || s === '0') return false;
    return null;
  };

  /** 当前会话内启用/禁用 standard zone（不写档）；false 时该 zone 不进入 ZoneSystem */
  executor.register('setZoneEnabled', (p) => {
    const sceneId = String(p.sceneId ?? '').trim();
    const zoneId = String(p.zoneId ?? '').trim();
    if (!sceneId || !zoneId) {
      console.warn('setZoneEnabled: 需要 sceneId、zoneId');
      return;
    }
    const enabled = parseZoneEnabledParam(p.enabled);
    if (enabled === null) {
      console.warn('setZoneEnabled: missing or invalid enabled');
      return;
    }
    d.sceneManager.setZoneEnabledSession(sceneId, zoneId, enabled);
  }, ['sceneId', 'zoneId', 'enabled']);

  /** 将 standard zone 启用状态写入 sceneMemory 并刷新 ZoneSystem；depth_floor 无效果 */
  executor.register('persistZoneEnabled', (p) => {
    const sceneId = String(p.sceneId ?? '').trim();
    const zoneId = String(p.zoneId ?? '').trim();
    if (!sceneId || !zoneId) {
      console.warn('persistZoneEnabled: 需要 sceneId、zoneId');
      return;
    }
    const enabled = parseZoneEnabledParam(p.enabled);
    if (enabled === null) {
      console.warn('persistZoneEnabled: missing or invalid enabled');
      return;
    }
    d.sceneManager.mergePersistentZoneEnabled(sceneId, zoneId, enabled);
  }, ['sceneId', 'zoneId', 'enabled']);

  /**
   * 将场景内 NPC 或 Hotspot 的 **存档** x/y 写入 sceneMemory，并在当前已加载该场景时立即应用。
   * 与 persistNpcAt 不同：按 sceneId + entityKind + entityId 寻址，支持热点与任意场景。
   */
  executor.register('setSceneEntityPosition', async (p) => {
    const sceneId = String(p.sceneId ?? '').trim();
    const rawKind = String(p.entityKind ?? '').trim().toLowerCase();
    const entityKind: SceneEntityKind = rawKind === 'hotspot' ? 'hotspot' : 'npc';
    const entityId = String(p.entityId ?? '').trim();
    const x = typeof p.x === 'number' ? p.x : Number(p.x);
    const y = typeof p.y === 'number' ? p.y : Number(p.y);
    if (!sceneId || !entityId || !Number.isFinite(x) || !Number.isFinite(y)) {
      console.warn('setSceneEntityPosition: 需要 sceneId、entityId 与有限数值 x/y');
      return;
    }
    const rx = Math.round(x * 100) / 100;
    const ry = Math.round(y * 100) / 100;
    await d.setSceneEntityField(sceneId, entityKind, entityId, 'x', rx);
    await d.setSceneEntityField(sceneId, entityKind, entityId, 'y', ry);
  }, ['sceneId', 'entityKind', 'entityId', 'x', 'y']);

  /** 写入场景记忆并立即移动 NPC */
  executor.register('persistNpcAt', (p) => {
    const target = String(p.target ?? '').trim();
    const x = typeof p.x === 'number' ? p.x : Number(p.x);
    const y = typeof p.y === 'number' ? p.y : Number(p.y);
    if (!target || !Number.isFinite(x) || !Number.isFinite(y)) {
      console.warn('persistNpcAt: 需要 target、有限数值 x/y');
      return;
    }
    d.sceneManager.mergePersistentNpcState(target, { x, y });
    const npc = d.sceneManager.getNpcById(target);
    if (npc) {
      npc.x = x;
      npc.y = y;
    } else {
      console.warn(`persistNpcAt:当前场景无 NPC "${target}"`);
    }
  }, ['target', 'x', 'y']);

  /** 写入场景记忆并立即 playAnimation（进入场景时在 loadSprite 后也会套用） */
  const persistNpcAnimStateHandler = (p: Record<string, unknown>) => {
    const target = String(p.target ?? '').trim();
    const state = String(p.state ?? '').trim();
    if (!target || !state) {
      console.warn('persistNpcAnimState: 需要 target 与 state');
      return;
    }
    d.sceneManager.mergePersistentNpcState(target, { animState: state });
    const actor = d.resolveActor(target);
    if (actor) {
      actor.playAnimation(state);
    } else {
      console.warn(`persistNpcAnimState: 找不到实体 "${target}"`);
    }
  };
  executor.register('persistNpcAnimState', persistNpcAnimStateHandler, ['target', 'state']);
  /** 与 persistNpcAnimState 同义（勿与 playNpcAnimation 混淆：后者不存档） */
  executor.register('persistPlayNpcAnimation', persistNpcAnimStateHandler, ['target', 'state']);

  executor.register('fadeWorldToBlack', (p) => {
    const durRaw = p.durationMs ?? p.duration ?? 600;
    const durationMs = typeof durRaw === 'number' ? durRaw : Number(durRaw);
    const ms = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 600;
    return d.cutsceneManager.fadeWorldToBlack(ms).catch((e) => {
      console.warn('ActionRegistry: fadeWorldToBlack failed', e);
    });
  }, ['durationMs']);

  executor.register('fadeWorldFromBlack', (p) => {
    const durRaw = p.durationMs ?? p.duration ?? 600;
    const durationMs = typeof durRaw === 'number' ? durRaw : Number(durRaw);
    const ms = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 600;
    return d.cutsceneManager.fadeWorldFromBlack(ms).catch((e) => {
      console.warn('ActionRegistry: fadeWorldFromBlack failed', e);
    });
  }, ['durationMs']);

  executor.register('showOverlayImage', (p) => {
    const id = String(p.id ?? '').trim();
    const rawImage = String(p.image ?? '').trim();
    const image = d.resolveOverlayImagePath(rawImage);
    if (!id || !image) {
      console.warn('showOverlayImage: 需要 id 与 image');
      return;
    }
    const x = typeof p.xPercent === 'number' ? p.xPercent : Number(p.xPercent);
    const y = typeof p.yPercent === 'number' ? p.yPercent : Number(p.yPercent);
    const w = typeof p.widthPercent === 'number' ? p.widthPercent : Number(p.widthPercent);
    if (![x, y, w].every(n => Number.isFinite(n))) {
      console.warn('showOverlayImage: xPercent / yPercent / widthPercent 须为数值');
      return;
    }
    return d.showOverlayImage(id, image, x, y, w).catch((e) => {
      console.warn('ActionRegistry: showOverlayImage failed', e);
    });
  }, ['id', 'image', 'xPercent', 'yPercent', 'widthPercent']);

  executor.register('setHotspotDisplayImage', (p) => {
    const sceneId = String(p.sceneId ?? '').trim();
    const hid = String(p.hotspotId ?? '').trim();
    const image = String(p.image ?? '').trim();
    if (!sceneId || !hid || !image) {
      console.warn('setHotspotDisplayImage: 需要 sceneId、hotspotId 与 image');
      return;
    }
    const wRaw = p.worldWidth;
    const hRaw = p.worldHeight;
    const wNum = wRaw === undefined || wRaw === null || wRaw === '' ? NaN : Number(wRaw);
    const hNum = hRaw === undefined || hRaw === null || hRaw === '' ? NaN : Number(hRaw);
    const worldWidth = Number.isFinite(wNum) && wNum > 0 ? wNum : undefined;
    const worldHeight = Number.isFinite(hNum) && hNum > 0 ? hNum : undefined;
    const fRaw = String(p.facing ?? '').trim().toLowerCase();
    const facing: 'left' | 'right' | undefined =
      fRaw === 'left' || fRaw === 'right' ? fRaw : undefined;
    if (fRaw && fRaw !== 'left' && fRaw !== 'right') {
      console.warn('setHotspotDisplayImage: facing 须为 left 或 right，已忽略', p.facing);
    }
    return d
      .setHotspotDisplayImage(sceneId, hid, image, worldWidth, worldHeight, facing)
      .catch((e) => {
        console.warn('ActionRegistry: setHotspotDisplayImage failed', e);
      });
  }, ['sceneId', 'hotspotId', 'image', 'worldWidth', 'worldHeight', 'facing']);

  executor.register(
    'tempSetHotspotDisplayFacing',
    (p) => {
      const sceneId = String(p.sceneId ?? '').trim();
      const hid = String(p.hotspotId ?? '').trim();
      if (!sceneId || !hid) {
        console.warn('tempSetHotspotDisplayFacing: 需要 sceneId、hotspotId');
        return;
      }
      const fr = String(p.facing ?? '').trim().toLowerCase();
      let facing: 'left' | 'right' | 'restore';
      if (fr === 'left' || fr === 'right' || fr === 'restore') {
        facing = fr;
      } else {
        console.warn('tempSetHotspotDisplayFacing: facing 须为 left、right 或 restore', p.facing);
        return;
      }
      d.tempSetHotspotDisplayFacing(sceneId, hid, facing);
    },
    ['sceneId', 'hotspotId', 'facing'],
  );

  executor.register('setEntityField', (p) => {
    const sceneId = String(p.sceneId ?? '').trim();
    const entityKind = String(p.entityKind ?? '').trim();
    const entityId = String(p.entityId ?? '').trim();
    const fieldName = String(p.fieldName ?? '').trim();
    const value = p.value as RuntimeFieldValue;
    if (entityKind !== 'npc' && entityKind !== 'hotspot') {
      console.warn('setEntityField: entityKind 必须是 npc 或 hotspot');
      return;
    }
    if (!sceneId || !entityId || !fieldName) {
      console.warn('setEntityField: 需要 sceneId、entityId、fieldName');
      return;
    }
    return d.setSceneEntityField(sceneId, entityKind, entityId, fieldName, value).catch((e) => {
      console.warn('ActionRegistry: setEntityField failed', e);
    });
  }, ['sceneId', 'entityKind', 'entityId', 'fieldName', 'value']);

  executor.register('hideOverlayImage', (p) => {
    const id = String(p.id ?? '').trim();
    if (!id) {
      console.warn('hideOverlayImage: 需要 id');
      return;
    }
    d.hideOverlayImage(id);
  }, ['id']);

  executor.register('blendOverlayImage', (p) => {
    const id = String(p.id ?? '').trim();
    const rawFrom = String(p.fromImage ?? '').trim();
    const rawTo = String(p.toImage ?? '').trim();
    const fromImage = d.resolveOverlayImagePath(rawFrom);
    const toImage = d.resolveOverlayImagePath(rawTo);
    if (!id || !fromImage || !toImage) {
      console.warn('blendOverlayImage: 需要 id、fromImage、toImage');
      return;
    }
    const x = typeof p.xPercent === 'number' ? p.xPercent : Number(p.xPercent);
    const y = typeof p.yPercent === 'number' ? p.yPercent : Number(p.yPercent);
    const w = typeof p.widthPercent === 'number' ? p.widthPercent : Number(p.widthPercent);
    if (![x, y, w].every(n => Number.isFinite(n))) {
      console.warn('blendOverlayImage: xPercent / yPercent / widthPercent 须为数值');
      return;
    }
    const durRaw = p.durationMs ?? 600;
    const durationMs = typeof durRaw === 'number' ? durRaw : Number(durRaw);
    const ms = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 600;
    const delRaw = p.delayMs ?? 0;
    const delayParsed = typeof delRaw === 'number' ? delRaw : Number(delRaw);
    const delayMs = Number.isFinite(delayParsed) && delayParsed >= 0 ? delayParsed : 0;
    return d.blendOverlayImage(id, fromImage, toImage, x, y, w, ms, delayMs).catch((e) => {
      console.warn('ActionRegistry: blendOverlayImage failed', e);
    });
  }, ['id', 'fromImage', 'toImage', 'durationMs', 'delayMs', 'xPercent', 'yPercent', 'widthPercent']);

  executor.register('startDialogueGraph', (p) => {
    const graphId = String(p.graphId ?? '').trim();
    if (!graphId) {
      console.warn('startDialogueGraph: 需要 graphId');
      return;
    }
    const entryRaw = p.entry;
    const entry = entryRaw !== undefined && entryRaw !== null ? String(entryRaw).trim() : '';
    const npcIdRaw = p.npcId;
    const npcId = npcIdRaw !== undefined && npcIdRaw !== null ? String(npcIdRaw).trim() : '';
    const ownerTypeRaw = p.ownerType;
    const ownerType = ownerTypeRaw !== undefined && ownerTypeRaw !== null ? String(ownerTypeRaw).trim() : '';
    const ownerIdRaw = p.ownerId;
    const ownerId = ownerIdRaw !== undefined && ownerIdRaw !== null ? String(ownerIdRaw).trim() : '';
    return d.startDialogueGraph(
      graphId,
      entry || undefined,
      npcId || undefined,
      ownerType || undefined,
      ownerId || undefined,
    );
  }, ['graphId', 'entry', 'npcId', 'ownerType', 'ownerId']);

  executor.register('waitClickContinue', (p) => {
    const raw = p.text;
    const hint = raw !== undefined && raw !== null ? String(raw).trim() : '';
    return d.waitClickContinue(hint ? d.resolveDisplayText(hint) : undefined);
  }, ['text']);

  executor.register('playScriptedDialogue', (p) => {
    const raw = p.lines;
    if (!Array.isArray(raw) || raw.length === 0) {
      console.warn('playScriptedDialogue: params.lines 须为非空数组');
      return;
    }
    const scriptedNpcId = String(p.scriptedNpcId ?? '').trim();
    const narrKey = d.stringsProvider.get('dialogue', 'narratorLabel');
    const narratorFallback = narrKey && narrKey !== 'narratorLabel' ? narrKey : '旁白';
    const narratorBaselineResolved = d.resolveDisplayTextForPlayScripted(narratorFallback, scriptedNpcId);
    const lines: DialogueLine[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const o = item as Record<string, unknown>;
      const speakerRaw = String(o.speaker ?? '').trim();
      const speakerResolved = speakerRaw ? d.resolveScriptedSpeaker(speakerRaw, scriptedNpcId) : '';
      const text = String(o.text ?? '').trim();
      if (!text) continue;
      const speakerResolvedDisplay = d.resolveDisplayTextForPlayScripted(
        speakerResolved || narratorFallback,
        scriptedNpcId,
      );
      const textResolvedDisplay = d.resolveDisplayTextForPlayScripted(text, scriptedNpcId);
      const { speaker: lineSpeaker, text: lineText } = applyDialogueColonSpeakerFromResolvedText(
        speakerResolvedDisplay,
        textResolvedDisplay,
        narratorBaselineResolved,
      );
      lines.push({
        speaker: lineSpeaker,
        text: lineText,
        tags: [],
      });
    }
    if (lines.length === 0) {
      console.warn('playScriptedDialogue: 无有效台词（需要 text）');
      return;
    }
    return d.playScriptedDialogue(lines);
  }, ['lines']);

  executor.register('waitMs', async (p) => {
    const durRaw = p.durationMs ?? 600;
    const durationMs = typeof durRaw === 'number' ? durRaw : Number(durRaw);
    const ms = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;
    if (ms > 0) await new Promise<void>(resolve => setTimeout(resolve, ms));
  }, ['durationMs']);

  // ----------------------------------------------------------------
  // Cutscene 白名单 Action（无副作用，可出现在 A 类表演中）
  // ----------------------------------------------------------------

  executor.register('moveEntityTo', async (p) => {
    const target = String(p.target ?? '').trim();
    const x = typeof p.x === 'number' ? p.x : Number(p.x);
    const y = typeof p.y === 'number' ? p.y : Number(p.y);
    const speedRaw = p.speed;
    const speed = typeof speedRaw === 'number' ? speedRaw : (speedRaw !== undefined ? Number(speedRaw) : 80);
    const spd = Number.isFinite(speed) && speed > 0 ? speed : 80;
    const segments = [...parseMoveEntityWaypointList(p.waypoints), { x, y }];
    const moveAnimRaw = p.moveAnimState;
    const moveAnim =
      typeof moveAnimRaw === 'string' && moveAnimRaw.trim() ? moveAnimRaw.trim() : undefined;
    const faceTowardMovement = parseFaceTowardMovementParam(p.faceTowardMovement);
    if (!target || !Number.isFinite(x) || !Number.isFinite(y)) {
      console.warn('moveEntityTo: 需要 target、有限数值 x/y');
      return;
    }
    const actor = d.resolveActor(target);
    if (!actor) {
      console.warn(`moveEntityTo: 找不到实体 "${target}"`);
      return;
    }
    for (const pt of segments) {
      await actor.moveTo(pt.x, pt.y, spd, moveAnim, faceTowardMovement);
    }
    // runtime 不要求 sceneId；JSON 中带 sceneId 仅编辑器复现地图
  }, ['target', 'x', 'y', 'speed', 'waypoints', 'moveAnimState', 'faceTowardMovement']);

  executor.register('faceEntity', (p) => {
    const target = String(p.target ?? '').trim();
    if (!target) {
      console.warn('faceEntity: missing target');
      return;
    }
    const actor = d.resolveActor(target);
    if (!actor) {
      console.warn(`faceEntity: 找不到实体 "${target}"`);
      return;
    }
    const faceTarget = p.faceTarget !== undefined ? String(p.faceTarget).trim() : '';
    const direction = p.direction !== undefined ? String(p.direction).trim() : '';
    if (!faceTarget && !direction) {
      console.warn('faceEntity: 需要 direction 或 faceTarget（至少一个）');
      return;
    }
    if (faceTarget) {
      const other = d.resolveActor(faceTarget);
      if (other) {
        actor.setFacing(other.x - actor.x, other.y - actor.y);
      }
    } else if (direction) {
      const dirMap: Record<string, [number, number]> = {
        left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1],
      };
      const dd = dirMap[direction];
      if (dd) actor.setFacing(dd[0], dd[1]);
    }
  }, ['target', 'direction', 'faceTarget']);

  executor.register('cutsceneSpawnActor', (p) => {
    const id = String(p.id ?? '').trim();
    const name = String(p.name ?? id).trim();
    const x = typeof p.x === 'number' ? p.x : Number(p.x);
    const y = typeof p.y === 'number' ? p.y : Number(p.y);
    if (!id) {
      console.warn('cutsceneSpawnActor: missing id');
      return;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      console.warn('cutsceneSpawnActor: x/y must be finite numbers');
      return;
    }
    d.spawnCutsceneActor(id, name, x, y);
  }, ['id', 'name', 'x', 'y']);

  executor.register('cutsceneRemoveActor', (p) => {
    const id = String(p.id ?? '').trim();
    if (!id) {
      console.warn('cutsceneRemoveActor: missing id');
      return;
    }
    d.removeCutsceneActor(id);
  }, ['id']);

  executor.register('showEmoteAndWait', async (p) => {
    const target = String(p.target ?? '').trim();
    const emote = String(p.emote ?? '').trim();
    const durRaw = p.duration ?? 1500;
    const duration = typeof durRaw === 'number' ? durRaw : Number(durRaw);
    const sceneId = d.sceneManager.currentSceneData?.id ?? '';
    dbg(d, `AndWait 开始 scene=${sceneId || '(?)'} target=${JSON.stringify(target)} emote=${JSON.stringify(emote)}`);
    if (!target || !emote) {
      dbg(d, 'AndWait 中止：缺少 target 或 emote');
      console.warn('showEmoteAndWait: 需要 target 与 emote');
      return;
    }
    const subject = d.resolveEmoteTarget(target);
    const kindAw =
      subject && typeof (subject as ICutsceneActor).entityId === 'string'
        ? `ICutsceneActor(${(subject as ICutsceneActor).entityId})`
        : subject
          ? (subject.constructor?.name ?? 'anchor')
          : 'null';
    dbg(d, `AndWait resolve=${kindAw}`);
    if (!subject) {
      dbg(d, 'AndWait 中止：resolveEmoteTarget 返回 null');
      console.warn(`showEmoteAndWait: 找不到 NPC / player / 过场实体 / 当前场景热点 "${target}"`);
      return;
    }
    const off = parseEmoteOffsetParams(p);
    dbg(d, `AndWait await showAndWait durMs=${Number.isFinite(duration) && duration > 0 ? duration : 1500} off=(${off.anchorOffsetX},${off.anchorOffsetY})`);
    await d.emoteBubbleManager.showAndWait(
      subject,
      emote,
      Number.isFinite(duration) && duration > 0 ? duration : 1500,
      off,
    );
    dbg(d, 'AndWait showAndWait 结束');
  }, ['target', 'emote', 'duration', 'anchorOffsetX', 'anchorOffsetY']);

  executor.register('showSpeechBubbleAndWait', async (p) => {
    const target = String(p.target ?? '').trim();
    const raw = speechBubbleRawText(p);
    const durRaw = p.duration ?? 1500;
    const duration = typeof durRaw === 'number' ? durRaw : Number(durRaw);
    const sceneId = d.sceneManager.currentSceneData?.id ?? '';
    dbg(d, `[showSpeechBubbleAndWait] scene=${sceneId || '(?)'} target=${JSON.stringify(target)} rawLen=${raw.length}`);
    if (!target || !raw) {
      console.warn('showSpeechBubbleAndWait: 需要 target 与 text');
      return;
    }
    const text = d.resolveDisplayText(raw).trim();
    if (!text) {
      console.warn('showSpeechBubbleAndWait: 解析后文案为空');
      return;
    }
    const subject = d.resolveEmoteTarget(target);
    if (!subject) {
      console.warn(`showSpeechBubbleAndWait: 找不到 NPC / player / 过场实体 / 当前场景热点 "${target}"`);
      return;
    }
    const off = parseEmoteOffsetParams(p);
    dbg(
      d,
      `SpeechBubbleAndWait await durMs=${Number.isFinite(duration) && duration > 0 ? duration : 1500}`,
    );
    await d.emoteBubbleManager.showAndWait(
      subject,
      text,
      Number.isFinite(duration) && duration > 0 ? duration : 1500,
      off,
    );
    dbg(d, '[showSpeechBubbleAndWait] showAndWait 结束');
  }, ['target', 'text', 'duration', 'anchorOffsetX', 'anchorOffsetY']);

  executor.register('revealDocument', async (p) => {
    await d.documentRevealManager.checkAndReveal(String(p.documentId ?? ''));
  }, ['documentId']);
}
