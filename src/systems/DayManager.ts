import type { EventBus } from '../core/EventBus';
import type { FlagStore } from '../core/FlagStore';
import type { ActionExecutor } from '../core/ActionExecutor';
import type { ActionDef, DelayedEvent, IGameSystem, GameContext } from '../data/types';
import { FlagKeys } from '../core/FlagKeys';

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
    void this.finishEndDayAfterDelayed();
  }

  private async finishEndDayAfterDelayed(): Promise<void> {
    await this.processDelayedEvents();
    this.eventBus.emit('day:start', { dayNumber: this._currentDay });
  }

  addDelayedEvent(targetDay: number, actions: ActionDef[]): void {
    this.delayedEvents.push({ targetDay, actions });
  }

  private async processDelayedEvents(): Promise<void> {
    const due: DelayedEvent[] = [];
    const remaining: DelayedEvent[] = [];
    for (const evt of this.delayedEvents) {
      if (evt.targetDay <= this._currentDay) due.push(evt);
      else remaining.push(evt);
    }
    // 先摘除到期事件（处理期间若有动作再注册延迟事件，保留进 remaining，不被覆盖）。
    this.delayedEvents = remaining;
    // 同一 endDay 内多条到期事件按 targetDay 升序执行（早到期的先生效），相同 targetDay 保持注册顺序（稳定排序）。
    due.sort((a, b) => a.targetDay - b.targetDay);
    for (const evt of due) {
      try {
        await this.actionExecutor.executeBatchAwait(evt.actions);
      } catch (e) {
        console.warn('DayManager: delayed actions failed', e);
      }
    }
  }

  private syncFlag(): void {
    this.flagStore.set(FlagKeys.currentDay, this._currentDay);
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
