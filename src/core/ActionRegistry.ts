/**
 * 游戏内 Action 注册表。
 *
 * 约定：凡在此处 executor.register 的新类型，必须同步到
 * `tools/editor/shared/action_editor.py` 的 ACTION_TYPES，并配置 _PARAM_SCHEMAS
 * 或 setPlayerAvatar / enableRuleOffers 等专用表单，否则主编辑器无法添加该 Action，
 * 且 `tools/editor/validator.py` 会对数据中的未知 type 报错。
 * 主编辑器中 Action 的 type 下拉为「仅选清单」模式，与 ACTION_TYPES 一致，不可手写未登记 type。
 *
 * 图对话节点 `runActions` 与热区共用本文件中的 `register` handler；若 handler 返回 Promise，
 * 对话里会顺序 await。仅当热区必须无效果而对话要等待时，再使用 `registerDialogueSequential`（如 waitMs）。
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
import type { DocumentRevealManager } from '../systems/DocumentRevealManager';
import type { ActionDef, DialogueLine, ICutsceneActor, ZoneRuleSlot, RuleLayerKey } from '../data/types';
import { GameState } from '../data/types';

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
  fadingRestoreSceneCameraZoom: (durationMs: number) => void;
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
  startDialogueGraph: (graphId: string, entry?: string, npcId?: string) => Promise<void>;
  /** 按序播放预置台词（至 dialogue:end） */
  playScriptedDialogue: (lines: DialogueLine[]) => Promise<void>;
  /** 显示「点击继续」类提示并阻塞直至任意键或鼠标 */
  waitClickContinue: (hintOverride?: string) => Promise<void>;
  /** 统一解析 JSON 字符串中的 [tag:…] */
  resolveDisplayText: (raw: string) => string;
  scenarioStateManager: ScenarioStateManager;
  documentRevealManager: DocumentRevealManager;
  /** 在 CutsceneManager 临时表中 spawn 一个临时实体并挂载到显示层 */
  spawnCutsceneActor: (id: string, name: string, x: number, y: number) => void;
  /** 从 CutsceneManager 临时表中移除一个临时实体并销毁 */
  removeCutsceneActor: (id: string) => void;
  /** 将当前场景内指定热点的展示图换为已存在的贴图路径（与 scene JSON displayImage 同语义） */
  setHotspotDisplayImage: (hotspotId: string, imagePath: string) => Promise<void>;
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

  executor.register('giveItem', (p) => { void d.inventoryManager.addItem(p.id as string, (p.count as number) ?? 1); }, ['id', 'count']);
  executor.register('removeItem', (p) => { void d.inventoryManager.removeItem(p.id as string, (p.count as number) ?? 1); }, ['id', 'count']);
  executor.register('giveCurrency', (p) => { void d.inventoryManager.addCoins(p.amount as number); }, ['amount']);
  executor.register('removeCurrency', (p) => { void d.inventoryManager.removeCoins(p.amount as number); }, ['amount']);
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
    d.stateController.setState(GameState.Cutscene);
    return d.cutsceneManager.startCutscene(p.id as string)
      .then(() => { d.stateController.setState(GameState.Exploring); })
      .catch((e) => {
        console.warn('ActionRegistry: startCutscene failed', e);
        d.stateController.setState(GameState.Exploring);
      });
  }, ['id']);

  executor.register('showEmote', (p) => {
    const actor = d.resolveActor(p.target as string);
    if (actor) d.emoteBubbleManager.show(actor, p.emote as string, (p.duration as number) ?? 1500);
  }, ['target', 'emote', 'duration']);

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
    d.stateController.setState(GameState.Cutscene);
    prepareSceneSwitch();
    return d.sceneManager.switchScene(p.targetScene as string, p.targetSpawnPoint as string | undefined)
      .then(() => { d.stateController.setState(GameState.Exploring); })
      .catch((e) => {
        console.warn('ActionRegistry: switchScene failed', e);
        d.stateController.setState(GameState.Exploring);
      });
  }, ['targetScene', 'targetSpawnPoint']);

  executor.register('changeScene', (p) => {
    d.stateController.setState(GameState.Cutscene);
    prepareSceneSwitch();
    const cam = typeof p.cameraX === 'number' && typeof p.cameraY === 'number'
      ? { x: p.cameraX as number, y: p.cameraY as number } : undefined;
    return d.sceneManager.switchScene(p.targetScene as string, p.targetSpawnPoint as string | undefined, cam)
      .then(() => { d.stateController.setState(GameState.Exploring); })
      .catch((e) => {
        console.warn('ActionRegistry: changeScene failed', e);
        d.stateController.setState(GameState.Exploring);
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
      if (bid) path = `/assets/animation/${bid}/anim.json`;
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

  executor.register('fadingZoom', (p) => {
    const zoom = typeof p.zoom === 'number' ? p.zoom : Number(p.zoom);
    const durRaw = p.durationMs ?? p.duration ?? 600;
    const durationMs = typeof durRaw === 'number' ? durRaw : Number(durRaw);
    if (!Number.isFinite(zoom) || zoom <= 0) {
      console.warn('fadingZoom: params.zoom 需为有限正数');
      return;
    }
    const ms = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 600;
    d.cutsceneManager.fadingCameraZoom(zoom, ms);
  }, ['zoom', 'durationMs']);

  executor.register('fadingRestoreSceneCameraZoom', (p) => {
    const durRaw = p.durationMs ?? p.duration ?? 600;
    const durationMs = typeof durRaw === 'number' ? durRaw : Number(durRaw);
    const ms = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 600;
    d.fadingRestoreSceneCameraZoom(ms);
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
    const hid = String(p.hotspotId ?? '').trim();
    const image = String(p.image ?? '').trim();
    if (!hid || !image) {
      console.warn('setHotspotDisplayImage: 需要 hotspotId 与 image');
      return;
    }
    return d.setHotspotDisplayImage(hid, image).catch((e) => {
      console.warn('ActionRegistry: setHotspotDisplayImage failed', e);
    });
  }, ['hotspotId', 'image']);

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
    return d.startDialogueGraph(graphId, entry || undefined, npcId || undefined);
  }, ['graphId', 'entry', 'npcId']);

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
    const lines: DialogueLine[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const o = item as Record<string, unknown>;
      const speakerRaw = String(o.speaker ?? '').trim();
      const speakerResolved = speakerRaw ? d.resolveScriptedSpeaker(speakerRaw, scriptedNpcId) : '';
      const text = String(o.text ?? '').trim();
      if (!text) continue;
      lines.push({
        speaker: d.resolveDisplayText(speakerResolved || narratorFallback),
        text: d.resolveDisplayText(text),
        tags: [],
      });
    }
    if (lines.length === 0) {
      console.warn('playScriptedDialogue: 无有效台词（需要 text）');
      return;
    }
    return d.playScriptedDialogue(lines);
  }, ['lines']);

  /** 热区/任务等非对话路径无延时效果；图对话 runActions 中走 registerDialogueSequential。 */
  executor.register('waitMs', () => {}, ['durationMs']);

  executor.registerDialogueSequential('waitMs', async (p) => {
    const durRaw = p.durationMs ?? 600;
    const durationMs = typeof durRaw === 'number' ? durRaw : Number(durRaw);
    const ms = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;
    if (ms > 0) await new Promise<void>(resolve => setTimeout(resolve, ms));
  });

  // ----------------------------------------------------------------
  // Cutscene 白名单 Action（无副作用，可出现在 A 类表演中）
  // ----------------------------------------------------------------

  executor.register('moveEntityTo', async (p) => {
    const target = String(p.target ?? '').trim();
    const x = typeof p.x === 'number' ? p.x : Number(p.x);
    const y = typeof p.y === 'number' ? p.y : Number(p.y);
    const speedRaw = p.speed;
    const speed = typeof speedRaw === 'number' ? speedRaw : (speedRaw !== undefined ? Number(speedRaw) : 80);
    if (!target || !Number.isFinite(x) || !Number.isFinite(y)) {
      console.warn('moveEntityTo: 需要 target、有限数值 x/y');
      return;
    }
    const actor = d.resolveActor(target);
    if (!actor) {
      console.warn(`moveEntityTo: 找不到实体 "${target}"`);
      return;
    }
    await actor.moveTo(x, y, Number.isFinite(speed) && speed > 0 ? speed : 80);
  }, ['target', 'x', 'y', 'speed']);

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
    if (!target || !emote) {
      console.warn('showEmoteAndWait: 需要 target 与 emote');
      return;
    }
    const actor = d.resolveActor(target);
    if (!actor) {
      console.warn(`showEmoteAndWait: 找不到实体 "${target}"`);
      return;
    }
    await d.emoteBubbleManager.showAndWait(actor, emote, Number.isFinite(duration) && duration > 0 ? duration : 1500);
  }, ['target', 'emote', 'duration']);

  executor.registerDialogueSequential('revealDocument', async (p) => {
    await d.documentRevealManager.checkAndReveal(String(p.documentId ?? ''));
  });
}
