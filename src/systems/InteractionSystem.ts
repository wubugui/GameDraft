import type { Hotspot } from '../entities/Hotspot';
import type { Npc } from '../entities/Npc';
import type { EventBus } from '../core/EventBus';
import type { FlagStore } from '../core/FlagStore';
import type { InputManager } from '../core/InputManager';
import type {
  ActSpotData,
  Condition,
  ConditionExpr,
  HotspotDef,
  IGameSystem,
  GameContext,
  InspectData,
  PlayerVerb,
} from '../data/types';
import type { ConditionEvalContext } from './graphDialogue/evaluateGraphCondition';
import { evaluateConditionExprList } from './graphDialogue/conditionEvalBridge';
import { hotspotOffersPlayerInteraction } from '../utils/hotspotInteraction';

interface InteractableTarget {
  kind: 'hotspot' | 'npc';
  hotspot?: Hotspot;
  npc?: Npc;
}

/** 成员条件与整体分组条件的唯一合成口径（供运行时与语义级测试共用）。 */
export function composeSceneEntityConditionState(
  memberConditionOk: boolean,
  memberConditionHidesEntity: boolean,
  groupConditionOk: boolean,
): { visibleByConditions: boolean; interactableByConditions: boolean } {
  return {
    visibleByConditions:
      groupConditionOk && (memberConditionHidesEntity ? memberConditionOk : true),
    interactableByConditions: groupConditionOk && memberConditionOk,
  };
}

/**
 * 位面交互门闸（由 PlaneReconciler 注入 getter，见 setPlaneInteractionPolicy）：
 * false 的通道对应目标不出提示、不可触发（选目标循环直接跳过）。
 * canPickup 仅额外约束 pickup 型热点（canInteractHotspots 为总闸）。
 */
export interface PlaneInteractionPolicy {
  canInteractHotspots: boolean;
  canTalkNpcs: boolean;
  canPickup: boolean;
  /** 允许的身体动词白名单；null = 不限制（缺省行为）。由 PlayerActionSystem 消费。 */
  allowedVerbs: string[] | null;
}

/**
 * 区域级 E 交互接线（由组装层给闭包，InteractionSystem 不持有 ZoneSystem 引用）。
 * `peek` 只报「当前活跃区里有没有配 onInteract 的」，优先级判定留在本系统。
 */
export interface ZoneInteractBinding {
  peek: () => { zoneId: string; label: string } | null;
  dispatch: (zoneId: string) => boolean;
}

export class InteractionSystem implements IGameSystem {
  private hotspots: Hotspot[] = [];
  private npcs: Npc[] = [];
  private nearestTarget: InteractableTarget | null = null;
  /**
   * 已在触发范围内且触发过一次的 autoTrigger 热点集合。
   * 按「玩家是否仍在该热点触发范围内」维护：进入触发一次，离开范围才移除——
   * 不随最近目标切换重置（NPC 路过抢走 nearest 不会导致重触发）；同帧 E 触发也入集防双发。
   */
  private autoTriggeredInRange: Set<Hotspot> = new Set();
  private eventBus: EventBus;
  private flagStore: FlagStore;
  private inputManager: InputManager;
  private conditionCtxFactory: (() => ConditionEvalContext) | null = null;
  private playerPosGetter: (() => { x: number; y: number }) | null = null;
  /** 与 SceneManager.refreshCutsceneBoundEntityVisibility 一致的基础显隐，不含触发条件图层 */
  private hotspotBaseEnabled: ((h: Hotspot) => boolean) | null = null;
  private npcBaseVisible: ((n: Npc) => boolean) | null = null;
  /** 当前场景分组 conditions 只读口；旧 group 标签没有定义时返回 undefined=无额外条件。 */
  private groupConditions: ((groupId: string) => ConditionExpr[] | undefined) | null = null;
  /** 位面交互门闸 getter；null = 不限制（现状行为） */
  private planePolicy: (() => PlaneInteractionPolicy) | null = null;
  /** 图入口探针：某图有没有叫这个名字的节点（Game 用已缓存的图 JSON 同步作答）。 */
  private graphHasEntry: ((graphId: string, entry: string) => boolean) | null = null;
  /** 区域级 E 交互（ZoneDef.onInteract）；null = 未接线，行为与旧版完全一致。 */
  private zoneInteract: ZoneInteractBinding | null = null;
  /** 当前正出「按 E」提示的 zone id；null = 没出。只在变化时发事件，不每帧刷 UI。 */
  private promptedZoneId: string | null = null;
  private promptedZoneLabel = '';

  constructor(eventBus: EventBus, flagStore: FlagStore, inputManager: InputManager) {
    this.eventBus = eventBus;
    this.flagStore = flagStore;
    this.inputManager = inputManager;
  }

  init(_ctx: GameContext): void {}
  serialize(): object {
    return {};
  }
  deserialize(_data: object): void {}

  setConditionEvalContextFactory(factory: (() => ConditionEvalContext) | null): void {
    this.conditionCtxFactory = factory;
  }

  /**
   * 由 Game 注入，与过场/sceneMemory 基底一致；未注入时条件隐藏仍生效，基底按 true。
   */
  setEntityBaseVisibilityReaders(
    hotspotBase: ((h: Hotspot) => boolean) | null,
    npcBase: ((n: Npc) => boolean) | null,
  ): void {
    this.hotspotBaseEnabled = hotspotBase;
    this.npcBaseVisible = npcBase;
  }

  setEntityGroupConditionReader(
    reader: ((groupId: string) => ConditionExpr[] | undefined) | null,
  ): void {
    this.groupConditions = reader;
  }

  private evalEntityGroupConditions(groupId: string | undefined, ctx: ConditionEvalContext | null): boolean {
    const gid = groupId?.trim() ?? '';
    if (!gid) return true;
    return this.evalWith(this.groupConditions?.(gid), ctx);
  }

  private evalConditionsList(conds: ConditionExpr[] | undefined): boolean {
    if (!conds?.length) return true;
    return this.evalWith(conds, this.conditionCtxFactory?.() ?? null);
  }

  /** 用调用方预先构建的 ctx 求值，避免在同一帧内为同一实体重复 new 上下文。 */
  private evalWith(conds: ConditionExpr[] | undefined, ctx: ConditionEvalContext | null): boolean {
    if (!conds?.length) return true;
    if (ctx) return evaluateConditionExprList(conds, ctx);
    return this.flagStore.checkConditions(conds as Condition[]);
  }

  setPlayerPositionGetter(getter: () => { x: number; y: number }): void {
    this.playerPosGetter = getter;
  }

  /** 注入/清除位面交互门闸（由 PlaneReconciler 按激活位面设/清）。 */
  setPlaneInteractionPolicy(fn: (() => PlaneInteractionPolicy) | null): void {
    this.planePolicy = fn;
  }

  /** 注入图入口探针（Game 用 AssetManager 已缓存的图 JSON 同步作答）。 */
  setGraphEntryProbe(fn: ((graphId: string, entry: string) => boolean) | null): void {
    this.graphHasEntry = fn;
  }

  /** 注入/清除区域级 E 交互接线（组装层给 ZoneSystem 的闭包）。清除时收起在显提示。 */
  setZoneInteractBinding(binding: ZoneInteractBinding | null): void {
    this.zoneInteract = binding;
    if (!binding) this.setPromptedZone(null);
  }

  /** 实体身上「按 E 会开哪张图」——动词路由与它共用同一张图。 */
  private graphIdOfHotspot(def: HotspotDef): string {
    if (def.type !== 'inspect') return '';
    const d = def.data as InspectData;
    return typeof d.graphId === 'string' ? d.graphId.trim() : '';
  }

  setHotspots(hotspots: Hotspot[]): void {
    this.clearHotspots();
    this.hotspots = hotspots;
  }

  clearHotspots(): void {
    this.hotspots = [];
    this.clearNearestIfKind('hotspot');
    this.autoTriggeredInRange.clear();
  }

  setNpcs(npcs: Npc[]): void {
    this.clearNpcs();
    this.npcs = npcs;
  }

  clearNpcs(): void {
    this.npcs = [];
    this.clearNearestIfKind('npc');
  }

  private clearNearestIfKind(kind: 'hotspot' | 'npc'): void {
    if (this.nearestTarget?.kind === kind) {
      if (kind === 'hotspot') this.nearestTarget.hotspot?.hidePrompt();
      if (kind === 'npc') this.nearestTarget.npc?.hidePrompt();
      this.nearestTarget = null;
    }
  }

  /**
   * 返回该热点的条件是否满足（供同帧的交互判定复用，避免二次求值）。
   * 每帧只写实体的「派生基底/条件」通道；拾取位与会话覆盖由实体自行合成，不在此被冲掉。
   */
  private applyHotspotVisibilityAndBase(hotspot: Hotspot, ctx: ConditionEvalContext | null): boolean {
    const conds = hotspot.def.conditions;
    const condOk = this.evalWith(conds, ctx);
    const groupOk = this.evalEntityGroupConditions(hotspot.def.group, ctx);
    const base = this.hotspotBaseEnabled?.(hotspot) ?? true;
    const hideWhenFail = hotspot.def.conditionHidesEntity === true && !!conds?.length;
    hotspot.setDerivedBaseEnabled(base);
    const state = composeSceneEntityConditionState(condOk, hideWhenFail, groupOk);
    // 分组是整体显影实体：组条件失败始终隐藏；成员条件仍保留 conditionHidesEntity 契约。
    hotspot.setConditionEnabled(state.visibleByConditions);
    return state.interactableByConditions;
  }

  /** 返回该 NPC 的条件是否满足（供同帧的交互判定复用，避免二次求值）。写通道语义同上。 */
  private applyNpcVisibilityAndBase(npc: Npc, ctx: ConditionEvalContext | null): boolean {
    const conds = npc.def.conditions;
    const condOk = this.evalWith(conds, ctx);
    const groupOk = this.evalEntityGroupConditions(npc.def.group, ctx);
    const base = this.npcBaseVisible?.(npc) ?? true;
    const hideWhenFail = npc.def.conditionHidesEntity === true && !!conds?.length;
    npc.setDerivedBaseVisible(base);
    const state = composeSceneEntityConditionState(condOk, hideWhenFail, groupOk);
    npc.setConditionVisible(state.visibleByConditions);
    return state.interactableByConditions;
  }

  update(_dt: number): void {
    if (!this.playerPosGetter) return;
    // 场景里一个可交互实体都没有时仍要跑区域级 E 那条（zone 不是实体，不在这两个数组里）。
    if (this.hotspots.length === 0 && this.npcs.length === 0 && !this.zoneInteract) return;

    const pos = this.playerPosGetter();
    let closestTarget: InteractableTarget | null = null;
    let closestDist = Infinity;

    // 每帧仅构建一次条件上下文，供本帧所有实体复用（避免 per-entity 分配 + 二次求值）。
    const ctx = this.conditionCtxFactory?.() ?? null;
    // 位面交互门闸本帧取一次；被禁目标仍照常写显隐通道，只是不参与选目标（无提示、不可触发）。
    const policy = this.planePolicy?.() ?? null;

    for (const hotspot of this.hotspots) {
      const condOk = this.applyHotspotVisibilityAndBase(hotspot, ctx);

      // autoTrigger「离开范围才重置」：无论热点当前是否 active 都做范围判定，
      // 玩家在范围内经历 禁用→启用 不应重触发，离开范围期间被禁用也要正确移除。
      if (hotspot.def.autoTrigger && this.autoTriggeredInRange.has(hotspot)) {
        const dxA = pos.x - hotspot.centerX;
        const dyA = pos.y - hotspot.centerY;
        if (Math.sqrt(dxA * dxA + dyA * dyA) > hotspot.effectiveInteractionRange) {
          this.autoTriggeredInRange.delete(hotspot);
        }
      }

      if (!hotspot.active) continue;
      if (!hotspotOffersPlayerInteraction(hotspot.def)) continue;
      if (policy && !policy.canInteractHotspots) continue;
      if (policy && !policy.canPickup && hotspot.def.type === 'pickup') continue;
      if (hotspot.def.conditions && hotspot.def.conditions.length > 0 && !condOk) continue;

      const dx = pos.x - hotspot.centerX;
      const dy = pos.y - hotspot.centerY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= hotspot.effectiveInteractionRange && dist < closestDist) {
        closestTarget = { kind: 'hotspot', hotspot };
        closestDist = dist;
      }
    }

    for (const npc of this.npcs) {
      const condOk = this.applyNpcVisibilityAndBase(npc, ctx);
      if (!npc.container.visible) continue;
      if (policy && !policy.canTalkNpcs) continue;
      if (npc.def.conditions && npc.def.conditions.length > 0 && !condOk) continue;
      const dx = pos.x - npc.x;
      const dy = pos.y - npc.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist <= npc.effectiveInteractionRange && dist < closestDist) {
        closestTarget = { kind: 'npc', npc };
        closestDist = dist;
      }
    }

    if (!this.isSameTarget(this.nearestTarget, closestTarget)) {
      this.hideCurrentPrompt();
      this.nearestTarget = closestTarget;
      this.showCurrentPrompt();
    }

    // 区域级 E：目标级优先——有实体接住 E 时本区不出提示也不触发（与身体动词同一套优先级）。
    // 位面总闸 canInteractHotspots 关掉时区域交互一并关（否则「这个位面不许碰东西」被绕过）。
    const zoneCandidate =
      closestTarget || (policy && !policy.canInteractHotspots) || !this.zoneInteract
        ? null
        : this.zoneInteract.peek();
    this.setPromptedZone(zoneCandidate);

    if (closestTarget && this.inputManager.wasKeyJustPressed('KeyE')) {
      // 同帧 E 触发 autoTrigger 热点也写入已触发标记，防止下一帧 auto 路径双发
      if (closestTarget.kind === 'hotspot' && closestTarget.hotspot?.def.autoTrigger) {
        this.autoTriggeredInRange.add(closestTarget.hotspot);
      }
      this.triggerTarget(closestTarget);
    } else if (this.promptedZoneId && this.inputManager.wasKeyJustPressed('KeyE')) {
      this.zoneInteract?.dispatch(this.promptedZoneId);
    } else if (closestTarget?.kind === 'hotspot' && closestTarget.hotspot?.def.autoTrigger) {
      const h = closestTarget.hotspot;
      if (!this.autoTriggeredInRange.has(h)) {
        this.autoTriggeredInRange.add(h);
        this.triggerTarget(closestTarget);
      }
    }
  }

  /**
   * 找当前最近的、**图里有以该动词命名的 entry** 的目标（供动词按下时路由）。
   *
   * 判定口径与按 E 完全一致：同一套目标集、同一个 interactionRange、同一个位面闸、
   * 同一份 conditions——唯一的差别是"这个目标吃不吃这个动词"由**它自己那张图有没有
   * 这个入口**回答，而不是靠实体上另开一张响应表。图里没有 `kick` 入口＝踢不动它。
   */
  findNearestVerbGraphTarget(verb: PlayerVerb): {
    kind: 'hotspot' | 'npc';
    id: string;
    name: string;
    graphId: string;
    x: number;
    y: number;
  } | null {
    if (!this.playerPosGetter || !this.graphHasEntry) return null;
    const pos = this.playerPosGetter();
    const policy = this.planePolicy?.() ?? null;
    let best: { kind: 'hotspot' | 'npc'; id: string; name: string; graphId: string; x: number; y: number } | null = null;
    let bestDist = Infinity;

    const consider = (
      kind: 'hotspot' | 'npc',
      id: string,
      name: string,
      graphId: string,
      x: number,
      y: number,
      range: number,
    ): void => {
      if (!graphId || !this.graphHasEntry?.(graphId, verb)) return;
      const dx = pos.x - x;
      const dy = pos.y - y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > range || dist >= bestDist) return;
      best = { kind, id, name, graphId, x, y };
      bestDist = dist;
    };

    for (const hotspot of this.hotspots) {
      if (!hotspot.active) continue;
      if (policy && !policy.canInteractHotspots) continue;
      if (hotspot.def.conditions?.length && !this.evalConditionsList(hotspot.def.conditions)) continue;
      consider(
        'hotspot',
        hotspot.def.id,
        hotspot.def.label || hotspot.def.id,
        this.graphIdOfHotspot(hotspot.def),
        hotspot.centerX,
        hotspot.centerY,
        hotspot.effectiveInteractionRange,
      );
    }
    for (const npc of this.npcs) {
      if (!npc.container.visible) continue;
      if (policy && !policy.canTalkNpcs) continue;
      if (npc.def.conditions?.length && !this.evalConditionsList(npc.def.conditions)) continue;
      consider(
        'npc',
        npc.entityId,
        npc.def.name,
        (npc.def.dialogueGraphId || '').trim(),
        npc.x,
        npc.y,
        npc.effectiveInteractionRange,
      );
    }
    return best;
  }

  /**
   * 找当前最近的、支持该动词的 `act_spot`（躺点 / 跨点）。
   * act_spot 不出 E 提示（`hotspotOffersPlayerInteraction` 对它返回 false），只出动词提示。
   */
  findNearestActSpot(verb: PlayerVerb): { id: string; data: ActSpotData; label: string } | null {
    if (!this.playerPosGetter) return null;
    const pos = this.playerPosGetter();
    const policy = this.planePolicy?.() ?? null;
    if (policy && !policy.canInteractHotspots) return null;
    let best: { id: string; data: ActSpotData; label: string } | null = null;
    let bestDist = Infinity;
    for (const hotspot of this.hotspots) {
      if (hotspot.def.type !== 'act_spot' || !hotspot.active) continue;
      const data = hotspot.def.data as ActSpotData | undefined;
      if (!data || !Array.isArray(data.verbs) || !data.verbs.includes(verb)) continue;
      if (hotspot.def.conditions?.length && !this.evalConditionsList(hotspot.def.conditions)) continue;
      const dx = pos.x - hotspot.centerX;
      const dy = pos.y - hotspot.centerY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > hotspot.effectiveInteractionRange || dist >= bestDist) continue;
      best = { id: hotspot.def.id, data, label: hotspot.def.label || hotspot.def.id };
      bestDist = dist;
    }
    return best;
  }

  /** 玩家视角：当前能看到的实体（可见 NPC、active 热区/出口），只含玩家可感知字段。 */
  getPlayerVisibleEntities(): Array<{
    kind: 'npc' | 'hotspot' | 'exit'; label: string; x: number; y: number; image?: string; leadsTo?: string;
  }> {
    const out: Array<{ kind: 'npc' | 'hotspot' | 'exit'; label: string; x: number; y: number; image?: string; leadsTo?: string }> = [];
    for (const h of this.hotspots) {
      if (!h.active) continue;
      if (h.def.type === 'transition') {
        const data = h.def.data as { targetScene?: string } | undefined;
        out.push({ kind: 'exit', label: h.def.label || '出口', x: h.centerX, y: h.centerY, leadsTo: data?.targetScene });
      } else {
        out.push({ kind: 'hotspot', label: h.def.label || h.def.id, x: h.centerX, y: h.centerY, image: h.def.displayImage?.image });
      }
    }
    for (const n of this.npcs) {
      if (!n.container.visible) continue;
      out.push({ kind: 'npc', label: n.def.name, x: n.x, y: n.y });
    }
    return out;
  }

  /** 玩家视角：当前"按 E 可交互"提示指向的目标（玩家走到范围内时屏上那行），否则 null。 */
  getNearestPrompt(): { kind: 'npc' | 'hotspot'; label: string; x: number; y: number } | null {
    const t = this.nearestTarget;
    if (!t) return null;
    if (t.kind === 'hotspot' && t.hotspot) {
      return { kind: 'hotspot', label: t.hotspot.def.label || t.hotspot.def.id, x: t.hotspot.centerX, y: t.hotspot.centerY };
    }
    if (t.kind === 'npc' && t.npc) {
      return { kind: 'npc', label: t.npc.def.name, x: t.npc.x, y: t.npc.y };
    }
    return null;
  }

  /** 只读：列出当前场景的可交互对象（id/坐标/范围/是否可用/是否在范围内），供调试快照做数据驱动决策。
   *  判定门槛与 update() 中的真实交互一致；不产生副作用。 */
  debugListInteractables(px: number, py: number): Array<{
    kind: 'hotspot' | 'npc';
    id: string;
    type?: string;
    x: number;
    y: number;
    interactionRange: number;
    available: boolean;
    inRange: boolean;
    distance: number;
  }> {
    const out: Array<{
      kind: 'hotspot' | 'npc'; id: string; type?: string; x: number; y: number;
      interactionRange: number; available: boolean; inRange: boolean; distance: number;
    }> = [];
    // 与 update() 选目标同口径：位面交互门闸计入 available，防调试快照与玩家实际可交互漂移。
    const planePolicy = this.planePolicy?.() ?? null;
    for (const hotspot of this.hotspots) {
      const available =
        hotspot.active &&
        hotspotOffersPlayerInteraction(hotspot.def) &&
        (!planePolicy || (planePolicy.canInteractHotspots &&
          (planePolicy.canPickup || hotspot.def.type !== 'pickup'))) &&
        (!hotspot.def.conditions?.length || this.evalConditionsList(hotspot.def.conditions));
      const dx = px - hotspot.centerX;
      const dy = py - hotspot.centerY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      out.push({
        kind: 'hotspot', id: hotspot.def.id, type: hotspot.def.type,
        x: hotspot.centerX, y: hotspot.centerY,
        interactionRange: hotspot.effectiveInteractionRange,
        available, inRange: available && dist <= hotspot.effectiveInteractionRange,
        distance: Math.round(dist * 10) / 10,
      });
    }
    for (const npc of this.npcs) {
      const available =
        npc.container.visible &&
        (!planePolicy || planePolicy.canTalkNpcs) &&
        (!npc.def.conditions?.length || this.evalConditionsList(npc.def.conditions));
      const dx = px - npc.x;
      const dy = py - npc.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      out.push({
        kind: 'npc', id: npc.entityId, x: npc.x, y: npc.y,
        interactionRange: npc.effectiveInteractionRange,
        available, inRange: available && dist <= npc.effectiveInteractionRange,
        distance: Math.round(dist * 10) / 10,
      });
    }
    return out;
  }

  private isSameTarget(a: InteractableTarget | null, b: InteractableTarget | null): boolean {
    if (a === null && b === null) return true;
    if (a === null || b === null) return false;
    if (a.kind !== b.kind) return false;
    if (a.kind === 'hotspot') return a.hotspot === b.hotspot;
    return a.npc === b.npc;
  }

  /**
   * 区域级 E 提示的唯一写入口：只在「哪个 zone 在出提示」真的变了时发事件。
   * 文案变化也算变（同 zone 换了 interactLabel 要重排提示条）。
   */
  private setPromptedZone(next: { zoneId: string; label: string } | null): void {
    if (next === null) {
      if (this.promptedZoneId === null) return;
      this.promptedZoneId = null;
      this.promptedZoneLabel = '';
      this.eventBus.emit('zone:interactUnavailable', {});
      return;
    }
    if (this.promptedZoneId === next.zoneId && this.promptedZoneLabel === next.label) return;
    this.promptedZoneId = next.zoneId;
    this.promptedZoneLabel = next.label;
    this.eventBus.emit('zone:interactAvailable', { zoneId: next.zoneId, label: next.label });
  }

  /** 只读：当前出「按 E」提示的 zone id（调试快照 / 无头验证用）。 */
  getPromptedZoneId(): string | null {
    return this.promptedZoneId;
  }

  private hideCurrentPrompt(): void {
    if (!this.nearestTarget) return;
    if (this.nearestTarget.kind === 'hotspot') this.nearestTarget.hotspot?.hidePrompt();
    if (this.nearestTarget.kind === 'npc') this.nearestTarget.npc?.hidePrompt();
  }

  private showCurrentPrompt(): void {
    if (!this.nearestTarget) return;
    if (this.nearestTarget.kind === 'hotspot' && !this.nearestTarget.hotspot?.def.autoTrigger) {
      this.nearestTarget.hotspot?.showPrompt();
    }
    if (this.nearestTarget.kind === 'npc') {
      this.nearestTarget.npc?.showPrompt();
    }
  }

  private triggerTarget(target: InteractableTarget): void {
    if (target.kind === 'hotspot') {
      this.eventBus.emit('hotspot:triggered', { hotspot: target.hotspot!, def: target.hotspot!.def });
    } else if (target.kind === 'npc') {
      this.eventBus.emit('npc:interact', { npc: target.npc! });
    }
  }

  destroy(): void {
    this.clearHotspots();
    this.clearNpcs();
    this.nearestTarget = null;
    this.autoTriggeredInRange.clear();
    // 提示条挂在 HUD 上，本系统销毁不会自动带走它：先收提示再断接线。
    this.setPromptedZone(null);
    this.zoneInteract = null;
    this.playerPosGetter = null;
    this.hotspotBaseEnabled = null;
    this.npcBaseVisible = null;
    this.planePolicy = null;
    this.graphHasEntry = null;
  }
}
