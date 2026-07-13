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
  /** endDay 串行尾链：连发 endDay 时后一次排队等前一次（延迟事件+day:start）完整落地，
   *  防止交错期间 day:start 读到已再次自增的日期。prev.then(run, run) 与
   *  ZoneSystem.zoneActionTail 同惯例——前一次失败不毒化链。 */
  private endDayTail: Promise<void> = Promise.resolve();

  constructor(eventBus: EventBus, flagStore: FlagStore, actionExecutor: ActionExecutor) {
    this.eventBus = eventBus;
    this.flagStore = flagStore;
    this.actionExecutor = actionExecutor;
  }

  init(_ctx: GameContext): void {
    // 律8：重 init 行为与首次一致——运行态回到初始天（读档由 deserialize 覆盖，不受影响）
    this._currentDay = 1;
    this.delayedEvents = [];
    this.endDayTail = Promise.resolve();
    this.syncFlag();
  }
  update(_dt: number): void {}

  get currentDay(): number {
    return this._currentDay;
  }

  /**
   * 结束当天：day:end → 天数自增 → 到期延迟事件 → day:start。
   * 返回整段流程的 Promise（endDay action 的严格顺序依赖它）；day:start 的日期在
   * 自增当拍捕获为局部值——延迟事件执行期间若再次 endDay，不会把后一次的日期串进来。
   */
  endDay(): Promise<void> {
    const run = () => {
      this.eventBus.emit('day:end', { dayNumber: this._currentDay });
      this._currentDay++;
      const startedDay = this._currentDay;
      this.syncFlag();
      return this.finishEndDayAfterDelayed(startedDay);
    };
    this.endDayTail = this.endDayTail.then(run, run);
    return this.endDayTail;
  }

  private async finishEndDayAfterDelayed(dayNumber: number): Promise<void> {
    await this.processDelayedEvents();
    this.eventBus.emit('day:start', { dayNumber });
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
    this._currentDay = 1;
    this.delayedEvents = [];
    this.endDayTail = Promise.resolve();
  }
}
