import type { EventBus } from '../core/EventBus';
import type { FlagStore } from '../core/FlagStore';
import type { ActionExecutor } from '../core/ActionExecutor';
import type { ZoneDef, ZoneRuleSlot, IGameSystem, GameContext, IZoneDataProvider } from '../data/types';

export class ZoneSystem implements IGameSystem, IZoneDataProvider {
  private eventBus: EventBus;
  private flagStore: FlagStore;
  private actionExecutor: ActionExecutor;

  private zones: ZoneDef[] = [];
  private activeZoneIds: Set<string> = new Set();
  private playerPosGetter: (() => { x: number; y: number }) | null = null;

  constructor(eventBus: EventBus, flagStore: FlagStore, actionExecutor: ActionExecutor) {
    this.eventBus = eventBus;
    this.flagStore = flagStore;
    this.actionExecutor = actionExecutor;
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
    this.zones = zones;
    this.activeZoneIds.clear();
  }

  clearZones(): void {
    for (const id of this.activeZoneIds) {
      const zone = this.zones.find(z => z.id === id);
      if (zone) this.exitZone(zone);
    }
    this.zones = [];
    this.activeZoneIds.clear();
  }

  update(_dt: number): void {
    if (!this.playerPosGetter) return;
    const { x: playerX, y: playerY } = this.playerPosGetter();
    this.checkZones(playerX, playerY);
  }

  private checkZones(playerX: number, playerY: number): void {
    for (const zone of this.zones) {
      if (zone.conditions && zone.conditions.length > 0 && !this.flagStore.checkConditions(zone.conditions)) {
        if (this.activeZoneIds.has(zone.id)) this.exitZone(zone);
        continue;
      }
      const inside = playerX >= zone.x && playerX <= zone.x + zone.width
                  && playerY >= zone.y && playerY <= zone.y + zone.height;
      if (inside && !this.activeZoneIds.has(zone.id)) this.enterZone(zone);
      if (!inside && this.activeZoneIds.has(zone.id)) this.exitZone(zone);
    }
  }

  private enterZone(zone: ZoneDef): void {
    this.activeZoneIds.add(zone.id);
    if (zone.onEnter && zone.onEnter.length > 0) {
      this.actionExecutor.executeBatch(zone.onEnter);
    }
    this.eventBus.emit('zone:enter', { zoneId: zone.id, zone });
    this.emitRuleAvailability();
  }

  private exitZone(zone: ZoneDef): void {
    this.activeZoneIds.delete(zone.id);
    if (zone.onExit && zone.onExit.length > 0) {
      this.actionExecutor.executeBatch(zone.onExit);
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
    const slots: ZoneRuleSlot[] = [];
    for (const zone of this.zones) {
      if (!this.activeZoneIds.has(zone.id)) continue;
      if (zone.ruleSlots) {
        for (const slot of zone.ruleSlots) {
          slots.push(slot);
        }
      }
    }
    return slots;
  }

  isInAnyZone(): boolean {
    return this.activeZoneIds.size > 0;
  }

  getActiveZoneIds(): Set<string> {
    return this.activeZoneIds;
  }

  destroy(): void {
    this.zones = [];
    this.activeZoneIds.clear();
  }
}
