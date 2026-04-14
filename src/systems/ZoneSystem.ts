import type { EventBus } from '../core/EventBus';
import type { FlagStore } from '../core/FlagStore';
import type { ActionExecutor } from '../core/ActionExecutor';
import type { RuleOfferRegistry } from '../core/RuleOfferRegistry';
import type { ZoneDef, ZoneRuleSlot, IGameSystem, GameContext, IZoneDataProvider } from '../data/types';
import { isPointInPolygon, isValidZonePolygon } from '../utils/zoneGeometry';

export class ZoneSystem implements IGameSystem, IZoneDataProvider {
  private eventBus: EventBus;
  private flagStore: FlagStore;
  private actionExecutor: ActionExecutor;
  private ruleOfferRegistry: RuleOfferRegistry;

  private zones: ZoneDef[] = [];
  private activeZoneIds: Set<string> = new Set();
  private playerPosGetter: (() => { x: number; y: number }) | null = null;
  /** onStay 最小间隔（秒），避免每帧执行重逻辑 */
  private zoneStayNextAt: Map<string, number> = new Map();
  private static readonly STAY_INTERVAL_SEC = 0.25;

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

  setPlayerPositionGetter(getter: () => { x: number; y: number }): void {
    this.playerPosGetter = getter;
  }

  serialize(): object { return {}; }
  deserialize(_data: object): void {}

  setZones(zones: ZoneDef[]): void {
    for (const id of this.activeZoneIds) {
      const zone = this.zones.find(z => z.id === id);
      if (zone) this.exitZone(zone);
    }
    this.ruleOfferRegistry.clear();
    this.zones = zones;
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
  }

  update(_dt: number): void {
    if (!this.playerPosGetter) return;
    const { x: playerX, y: playerY } = this.playerPosGetter();
    this.checkZones(playerX, playerY);
    this.runStayActions(playerX, playerY);
  }

  private checkZones(playerX: number, playerY: number): void {
    for (const zone of this.zones) {
      if (zone.zoneKind === 'depth_floor') {
        continue;
      }
      if (zone.conditions && zone.conditions.length > 0 && !this.flagStore.checkConditions(zone.conditions)) {
        if (this.activeZoneIds.has(zone.id)) this.exitZone(zone);
        continue;
      }
      const inside =
        isValidZonePolygon(zone.polygon) &&
        isPointInPolygon(zone.polygon, playerX, playerY);
      if (inside && !this.activeZoneIds.has(zone.id)) this.enterZone(zone);
      if (!inside && this.activeZoneIds.has(zone.id)) this.exitZone(zone);
    }
  }

  private enterZone(zone: ZoneDef): void {
    this.activeZoneIds.add(zone.id);
    this.zoneStayNextAt.delete(zone.id);
    const enter = zone.onEnter;
    if (enter && enter.length > 0) {
      void this.actionExecutor.executeBatchInZoneContext(enter, { zoneId: zone.id }).catch((e) => {
        console.warn('ZoneSystem: onEnter actions failed', e);
      });
    }
    this.eventBus.emit('zone:enter', { zoneId: zone.id, zone });
    this.emitRuleAvailability();
  }

  private exitZone(zone: ZoneDef): void {
    this.activeZoneIds.delete(zone.id);
    this.zoneStayNextAt.delete(zone.id);
    const exit = zone.onExit;
    if (exit && exit.length > 0) {
      void this.actionExecutor.executeBatchInZoneContext(exit, { zoneId: zone.id }).catch((e) => {
        console.warn('ZoneSystem: onExit actions failed', e);
      });
    }
    this.eventBus.emit('zone:exit', { zoneId: zone.id, zone });
    this.emitRuleAvailability();
  }

  /** 已在激活集中的区域，每帧执行 onStay。 */
  private runStayActions(playerX: number, playerY: number): void {
    for (const zone of this.zones) {
      if (zone.zoneKind === 'depth_floor') {
        continue;
      }
      if (!this.activeZoneIds.has(zone.id)) continue;
      if (zone.conditions && zone.conditions.length > 0 && !this.flagStore.checkConditions(zone.conditions)) {
        continue;
      }
      const inside =
        isValidZonePolygon(zone.polygon) &&
        isPointInPolygon(zone.polygon, playerX, playerY);
      if (!inside) continue;
      const stay = zone.onStay;
      if (stay && stay.length > 0) {
        const now = performance.now() / 1000;
        const next = this.zoneStayNextAt.get(zone.id) ?? 0;
        if (now < next) continue;
        this.zoneStayNextAt.set(zone.id, now + ZoneSystem.STAY_INTERVAL_SEC);
        void this.actionExecutor.executeBatchInZoneContext(stay, { zoneId: zone.id }).catch((e) => {
          console.warn('ZoneSystem: onStay actions failed', e);
        });
      }
    }
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
  }
}
