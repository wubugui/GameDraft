import type { EventBus } from '../core/EventBus';
import type { FlagStore } from '../core/FlagStore';
import type { ActionExecutor } from '../core/ActionExecutor';
import type { ActionDef, DelayedEvent, IGameSystem, GameContext } from '../data/types';

export class DayManager implements IGameSystem {
  private eventBus: EventBus;
  private flagStore: FlagStore;
  private actionExecutor: ActionExecutor;

  private _currentDay: number = 1;
  private delayedEvents: DelayedEvent[] = [];

  constructor(eventBus: EventBus, flagStore: FlagStore, actionExecutor: ActionExecutor) {
    this.eventBus = eventBus;
    this.flagStore = flagStore;
    this.actionExecutor = actionExecutor;
  }

  init(_ctx: GameContext): void {
    this.syncFlag();
  }
  update(_dt: number): void {}

  get currentDay(): number {
    return this._currentDay;
  }

  endDay(): void {
    this.eventBus.emit('day:end', { dayNumber: this._currentDay });
    this._currentDay++;
    this.syncFlag();
    this.processDelayedEvents();
    this.eventBus.emit('day:start', { dayNumber: this._currentDay });
  }

  addDelayedEvent(targetDay: number, actions: ActionDef[]): void {
    this.delayedEvents.push({ targetDay, actions });
  }

  private processDelayedEvents(): void {
    const remaining: DelayedEvent[] = [];
    for (const evt of this.delayedEvents) {
      if (evt.targetDay <= this._currentDay) {
        this.actionExecutor.executeBatch(evt.actions);
      } else {
        remaining.push(evt);
      }
    }
    this.delayedEvents = remaining;
  }

  private syncFlag(): void {
    this.flagStore.set('current_day', this._currentDay);
  }

  serialize(): object {
    return {
      currentDay: this._currentDay,
      delayedEvents: this.delayedEvents,
    };
  }

  deserialize(data: { currentDay?: number; delayedEvents?: DelayedEvent[] }): void {
    this._currentDay = data.currentDay ?? 1;
    this.delayedEvents = data.delayedEvents ?? [];
    this.syncFlag();
  }

  destroy(): void {
    this.delayedEvents = [];
  }
}
