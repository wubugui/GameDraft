import type { EventBus } from '../core/EventBus';
import type { FlagStore } from '../core/FlagStore';
import type { ActionExecutor } from '../core/ActionExecutor';
import type { RuleOfferRegistry } from '../core/RuleOfferRegistry';
import type { Condition, ConditionExpr, ZoneDef, ZoneRuleSlot, IGameSystem, GameContext, IZoneDataProvider } from '../data/types';
import { isPointInPolygon, isValidZonePolygon } from '../utils/zoneGeometry';
import type { ConditionEvalContext } from './graphDialogue/evaluateGraphCondition';
import { evaluateConditionExprList } from './graphDialogue/conditionEvalBridge';

export class ZoneSystem implements IGameSystem, IZoneDataProvider {
  private eventBus: EventBus;
  private flagStore: FlagStore;
  private actionExecutor: ActionExecutor;
  private ruleOfferRegistry: RuleOfferRegistry;
  private conditionCtxFactory: (() => ConditionEvalContext) | null = null;

  private zones: ZoneDef[] = [];
  private activeZoneIds: Set<string> = new Set();
  private playerPosGetter: (() => { x: number; y: number }) | null = null;
  /** onStay 最小间隔（秒），避免每帧执行重逻辑 */
  private zoneStayNextAt: Map<string, number> = new Map();
  private static readonly STAY_INTERVAL_SEC = 0.25;
  /** 每个 zone 的 onEnter/onExit/onStay 串行（进出快速抖动时批不重叠）；
   *  zone 上下文已按参数显式线程化（executeBatchInZoneContext），跨 zone 并发不再共享栈。 */
  private zoneActionTail: Map<string, Promise<void>> = new Map();

  constructor(
    eventBus: EventBus,
    flagStore: FlagStore,
    actionExecutor: ActionExecutor,
    ruleOfferRegistry: RuleOfferRegistry,
  ) {
    this.eventBus = eventBus;
    this.flagStore = flagStore;
    this.actionExecutor = actionExecutor;
    this.ruleOfferRegistry = ruleOfferRegistry;
  }

  init(_ctx: GameContext): void {}

  setConditionEvalContextFactory(factory: (() => ConditionEvalContext) | null): void {
    this.conditionCtxFactory = factory;
  }

  private evalZoneConditions(conds: ConditionExpr[] | undefined, ctx: ConditionEvalContext | null): boolean {
    if (!conds?.length) return true;
    if (ctx) return evaluateConditionExprList(conds, ctx);
    return this.flagStore.checkConditions(conds as Condition[]);
  }

  setPlayerPositionGetter(getter: () => { x: number; y: number }): void {
    this.playerPosGetter = getter;
  }

  serialize(): object { return {}; }
  deserialize(_data: object): void {}

  /**
   * 差分更新：仍存在的活跃 zone 原样保留（换用新 def 引用，不强制 exit/enter 重放
   * onExit/onEnter 的一次性动作——setZoneEnabled 针对无关 zone 时玩家所在 zone 不受扰动）；
   * 只对从列表中消失（被移除/禁用）的 zone 走 exitZone。
   * 两条调用路径语义都成立：切场景全清（unloadScene 传 []）= 全部活跃 zone 正常退出 + 供给清空；
   * 运行期开关（refreshZonesAfterRuntimeChange）= 纯差分。
   */
  setZones(zones: ZoneDef[]): void {
    const nextIds = new Set<string>();
    for (const z of zones) nextIds.add(z.id);

    for (const id of [...this.activeZoneIds]) {
      if (nextIds.has(id)) continue;
      const zone = this.zones.find(z => z.id === id);
      if (zone) {
        this.exitZone(zone);
      } else {
        this.activeZoneIds.delete(id);
      }
    }
    // 已消失 zone 的规矩供给一并撤下（onExit 里的 disableRuleOffers 再跑一次是幂等）；
    // 也兜住「进过 zone 但 onExit 忘写 disableRuleOffers」的内容缺口，与旧全量 clear 覆盖面一致。
    const slotsBefore = this.ruleOfferRegistry.getAggregatedSlots().length;
    for (const z of this.zones) {
      if (!nextIds.has(z.id)) this.ruleOfferRegistry.unregister(z.id);
    }
    const slotsAfter = this.ruleOfferRegistry.getAggregatedSlots().length;
    if ((slotsBefore > 0) !== (slotsAfter > 0)) this.emitRuleAvailability();

    this.zones = zones;
    // 消失 zone 的 stay 节流表清理；zoneActionTail 保留——被移除 zone 的 onExit 批可能仍在途，
    // 同 id 之后重新注册时新批必须仍串行排在其后。
    for (const id of [...this.zoneStayNextAt.keys()]) {
      if (!nextIds.has(id)) this.zoneStayNextAt.delete(id);
    }
  }

  /** F2 调试用：当前玩家所在的活跃 zone 定义（只读引用，不要改写）。 */
  getActiveZones(): ZoneDef[] {
    return this.zones.filter((z) => this.activeZoneIds.has(z.id));
  }

  /**
   * 读档专用：静默撤销全部 zone 的"活跃"身份——不跑 onExit 动作批、不发 zone:exit 事件。
   * 读档流程先 distribute（全系统状态已覆盖为存档时间线）后卸载旧场景；若照常经
   * setZones([]) 走 exitZone，旧时间线的 onExit 写入（fire-and-forget 异步批）会落在
   * 刚恢复的 FlagStore 上，且 flag 抖动发生在 setRestoring 抑制窗之外，可能误触
   * 任务/叙事重评。旧时间线既被整体丢弃，其退出副作用一并丢弃。
   * 只清活跃集与 stay 节流表：随后的 setZones([]) 因无活跃 zone 而零副作用地完成
   * 规矩供给撤销与 zones 置换；zoneActionTail 不动（同 id 在途批仍需串行语义）。
   * 必须在 unloadScene **之前**调用（SaveManager 的 sceneReloader 包装负责时序）。
   */
  clearActiveZonesForRestore(): void {
    this.activeZoneIds.clear();
    this.zoneStayNextAt.clear();
  }

  clearZones(): void {
    for (const id of this.activeZoneIds) {
      const zone = this.zones.find(z => z.id === id);
      if (zone) this.exitZone(zone);
    }
    this.ruleOfferRegistry.clear();
    this.zones = [];
    this.activeZoneIds.clear();
    this.zoneStayNextAt.clear();
    this.zoneActionTail.clear();
  }

  /**
   * 单次遍历完成进出判定与 onStay：每 zone 每帧只做一次条件求值与一次 point-in-polygon，
   * stay 阶段直接复用本次结果（旧实现 checkZones 与 runStayActions 各算一遍）。
   */
  update(_dt: number): void {
    if (!this.playerPosGetter) return;
    const { x: playerX, y: playerY } = this.playerPosGetter();
    // 条件上下文本帧共用一份，避免逐 zone 重复构建
    const ctx = this.conditionCtxFactory?.() ?? null;
    const now = performance.now() / 1000;

    for (const zone of this.zones) {
      if (zone.zoneKind === 'depth_floor') {
        continue;
      }
      if (zone.conditions && zone.conditions.length > 0 && !this.evalZoneConditions(zone.conditions, ctx)) {
        if (this.activeZoneIds.has(zone.id)) this.exitZone(zone);
        continue;
      }
      const inside =
        isValidZonePolygon(zone.polygon) &&
        isPointInPolygon(zone.polygon, playerX, playerY);
      if (inside && !this.activeZoneIds.has(zone.id)) this.enterZone(zone);
      if (!inside && this.activeZoneIds.has(zone.id)) this.exitZone(zone);

      // onStay：进入当帧即可跑第一拍（enterZone 清了节流表），之后按 STAY_INTERVAL 节流
      if (inside && this.activeZoneIds.has(zone.id)) {
        const stay = zone.onStay;
        if (stay && stay.length > 0) {
          const next = this.zoneStayNextAt.get(zone.id) ?? 0;
          if (now >= next) {
            this.zoneStayNextAt.set(zone.id, now + ZoneSystem.STAY_INTERVAL_SEC);
            this.enqueueZoneActions(zone.id, () =>
              this.actionExecutor.executeBatchInZoneContext(stay, { zoneId: zone.id }),
            );
          }
        }
      }
    }
  }

  private enqueueZoneActions(zoneId: string, task: () => Promise<void>): void {
    const prev = this.zoneActionTail.get(zoneId) ?? Promise.resolve();
    const next = prev.then(task, task).catch((e) => {
      console.warn(`ZoneSystem: zone "${zoneId}" actions failed`, e);
    });
    this.zoneActionTail.set(zoneId, next);
  }

  private enterZone(zone: ZoneDef): void {
    this.activeZoneIds.add(zone.id);
    this.zoneStayNextAt.delete(zone.id);
    const enter = zone.onEnter;
    if (enter && enter.length > 0) {
      this.enqueueZoneActions(zone.id, () =>
        this.actionExecutor.executeBatchInZoneContext(enter, { zoneId: zone.id }),
      );
    }
    this.eventBus.emit('zone:enter', { zoneId: zone.id, zone });
    this.emitRuleAvailability();
  }

  private exitZone(zone: ZoneDef): void {
    this.activeZoneIds.delete(zone.id);
    this.zoneStayNextAt.delete(zone.id);
    const exit = zone.onExit;
    if (exit && exit.length > 0) {
      this.enqueueZoneActions(zone.id, () =>
        this.actionExecutor.executeBatchInZoneContext(exit, { zoneId: zone.id }),
      );
    }
    this.eventBus.emit('zone:exit', { zoneId: zone.id, zone });
    this.emitRuleAvailability();
  }

  private emitRuleAvailability(): void {
    const slots = this.getCurrentRuleSlots();
    if (slots.length > 0) {
      this.eventBus.emit('zone:ruleAvailable', {});
    } else {
      this.eventBus.emit('zone:ruleUnavailable', {});
    }
  }

  getCurrentRuleSlots(): ZoneRuleSlot[] {
    return this.ruleOfferRegistry.getAggregatedSlots();
  }

  isInAnyZone(): boolean {
    return this.activeZoneIds.size > 0;
  }

  getActiveZoneIds(): Set<string> {
    return this.activeZoneIds;
  }

  destroy(): void {
    this.ruleOfferRegistry.clear();
    this.zones = [];
    this.activeZoneIds.clear();
    this.zoneStayNextAt.clear();
    this.zoneActionTail.clear();
  }
}
