import type { EventBus } from '../core/EventBus';
import type { FlagStore } from '../core/FlagStore';
import type { ActionExecutor } from '../core/ActionExecutor';
import type {
  ActionDef,
  DayNightConfig,
  DelayedEvent,
  IGameSystem,
  GameContext,
  TimeTransition,
} from '../data/types';
import { FlagKeys } from '../core/FlagKeys';
import {
  DEFAULT_START_AT,
  DEFAULT_TRANSITION_MS,
  MINUTES_PER_DAY,
  daylightPhaseIds,
  forwardDistance,
  parseClock,
  phaseAt,
  resolvePhases,
  type ResolvedPhase,
} from '../utils/dayTime';

/**
 * 世界时钟：**天**（H1）与**当日时刻/时段**（H3）的唯一真相源。
 *
 * 时刻**不自行流逝**——`update()` 里没有任何累加，推进只经 `advanceTime` / `advanceTimeTo`
 * 与 `endDay`。这是玩法定调（见 `docs/玩法功能需求清单.md` H1/H3）：叙事驱动的游戏里让
 * 时钟自由跑，玩家会在长对话中途莫名其妙天黑。
 *
 * 时刻与天放在同一个系统，是因为「推进 3 小时刚好跨零点」必须原子完成——拆成两个系统
 * 就得为跨日握手，而 `endDay` 的延迟事件队列与串行尾链都在这里。
 */
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

  // ---- 当日时刻 / 时段 ----
  private _minutesOfDay: number = 0;
  private phases: ResolvedPhase[] = resolvePhases(undefined);
  /** 「街上有人」的那几段（`phases[].daylight` 派生）。随 phases 一起重算，见 recomputeDaylight。 */
  private _daylightPhases: readonly string[] = daylightPhaseIds(resolvePhases(undefined));
  private startMinutes: number = parseClock(DEFAULT_START_AT) ?? 0;
  private _defaultTransitionMs: number = DEFAULT_TRANSITION_MS;
  /** 时刻是否已被 advanceTime / deserialize 动过；未动过时 configure 可安全改写开局时刻。 */
  private timeTouched = false;
  /** 推进中标志：用于识别重入（day:start / 延迟事件里再推时间），见 advanceTime。 */
  private advancing = false;
  /** 重入期间累积的待推进分钟数，由当前这一轮 runAdvance 消费。 */
  private pendingDelta = 0;

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
    this._minutesOfDay = this.startMinutes;
    this.timeTouched = false;
    this.advancing = false;
    this.pendingDelta = 0;
    this.syncFlag();
  }
  update(_dt: number): void {}

  /**
   * 应用 `game_config.dayNight`。与 `HealthSystem.configure` 同范式，由 Game 在
   * 配置加载完成后调用；调用时机可能在 `init()` 之后，故只在时刻尚未被动过时
   * 才把当前时刻同步到新的开局时刻（读档/已推进过的世界不被配置改写）。
   */
  configure(cfg: DayNightConfig | undefined): void {
    this.phases = resolvePhases(cfg?.phases);
    this.recomputeDaylight();
    const start = parseClock(cfg?.startAt ?? DEFAULT_START_AT);
    if (start === null) {
      console.warn(`DayManager.configure: startAt 非法（需 HH:MM），回落 ${DEFAULT_START_AT}`);
      this.startMinutes = parseClock(DEFAULT_START_AT) ?? 0;
    } else {
      this.startMinutes = start;
    }
    const ms = Number(cfg?.defaultTransitionMs);
    this._defaultTransitionMs = Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_TRANSITION_MS;
    if (!this.timeTouched) {
      this._minutesOfDay = this.startMinutes;
      this.syncFlag();
    }
  }

  get currentDay(): number {
    return this._currentDay;
  }

  /** 当日时刻（0–1439 分钟）。 */
  get minutesOfDay(): number {
    return this._minutesOfDay;
  }

  /** 当前时段 id（由时刻派生，非独立状态）。 */
  get currentPhase(): string {
    return phaseAt(this.phases, this._minutesOfDay);
  }

  /**
   * 当前时段的**展示名**（拂晓/白日/黄昏/入夜）。时段表没配 label 就退回 id——
   * 给玩家看的地方（事件日志的日/时段分组）用它，别在显示层拿 `currentPhase` 的裸 id。
   */
  get currentPhaseLabel(): string {
    const id = this.currentPhase;
    return this.phases.find((p) => p.id === id)?.label ?? id;
  }

  /** 时段表（只读副本，供调试面板/编辑器预览）。 */
  get phaseList(): ResolvedPhase[] {
    return this.phases.map((p) => ({ ...p }));
  }

  /**
   * 「人在外面做事」的那几段 id——**NPC 未写 `phases` 时的缺省归属**，
   * 由 `SceneManager` 经注入口消费（见 `setNpcDefaultPhasesGetter`）。
   *
   * 从时段表的 `daylight` 标记现算，故内容侧换词表（`辰/午/暮/夜`）时不会悬垂。
   * 空数组 = 一段都没标 = 缺省不施加限制（全时段都在），已在 configure 时告警过。
   */
  get daylightPhases(): readonly string[] {
    return this._daylightPhases;
  }

  /**
   * 随时段表重算「白天」。一段都没标时告警——**只在这里响一次**：
   * 判定点（`SceneManager.getNpcBaseVisibleForInteraction`）是每帧每实体调用的，
   * 告警放那儿会刷屏。
   */
  private recomputeDaylight(): void {
    this._daylightPhases = daylightPhaseIds(this.phases);
    if (this._daylightPhases.length === 0) {
      console.warn(
        `DayManager: 时段表 [${this.phases.map((p) => p.id).join(', ')}] 里一段都没标 daylight。` +
          '未写 phases 的 NPC（龙套/群演）暂按「全时段都在」处理——' +
          '请在 game_config.dayNight.phases 里给「街上有人」的那几段打上 daylight:true。',
      );
    }
  }

  get defaultTransitionMs(): number {
    return this._defaultTransitionMs;
  }

  /**
   * 推进时刻。返回的 Promise 覆盖「时钟推进 + 跨日流程」的真实完成时间，
   * **不**等待 NPC 离场演出——那是 `NpcScheduleSystem` 收到 `time:phaseChanged` 后
   * 在背景里跑的，等它会让一句"天黑了"的对话卡住好几秒。
   *
   * @param deltaMinutes 非负分钟数（负数被拒：时间倒流会让日程与延迟事件全部失序）
   * @param transition 表现档，随事件透传给渲染与日程系统；缺省 `seamless`
   */
  advanceTime(deltaMinutes: number, transition: TimeTransition = 'seamless'): Promise<void> {
    const delta = Math.round(Number(deltaMinutes));
    if (!Number.isFinite(delta) || delta < 0) {
      console.warn(`DayManager.advanceTime: 需要非负有限分钟数，收到 ${String(deltaMinutes)}`);
      return Promise.resolve();
    }
    if (delta === 0) return Promise.resolve();
    if (this.advancing) {
      /* 重入（day:start 监听方或到期延迟事件里再推时间）：并进当前这一轮，**不排队等待**。
       * 排队会与 endDay 的延迟事件批互等成死锁——那批动作正 await 本调用，而本调用要等
       * 那批跑完。返回已决 Promise 的语义是"已受理"，时刻一定会在本轮内落地。 */
      this.pendingDelta += delta;
      return Promise.resolve();
    }
    return this.runAdvance(delta, transition);
  }

  /**
   * 推进到指定时段的起点（玩家「等到天黑」用）。
   * 已经在该时段内时**不推进**——等一个已经到了的时段应该是空操作，而不是白等一整天。
   */
  advanceTimeTo(phaseId: string, transition: TimeTransition = 'timelapse'): Promise<void> {
    const want = String(phaseId ?? '').trim();
    const target = this.phases.find((p) => p.id === want);
    if (!target) {
      console.warn(`DayManager.advanceTimeTo: 未知时段 "${want}"`);
      return Promise.resolve();
    }
    if (this.currentPhase === want) return Promise.resolve();
    const delta = forwardDistance(this._minutesOfDay, target.fromMinutes);
    // currentPhase !== want 时 delta 必 > 0（恰好等于起点就已经在该时段里了）；兜底防御。
    return this.advanceTime(delta === 0 ? MINUTES_PER_DAY : delta, transition);
  }

  private async runAdvance(initialDelta: number, transition: TimeTransition): Promise<void> {
    const fromMinutes = this._minutesOfDay;
    const fromPhase = this.currentPhase;
    const fromDay = this._currentDay;
    this.advancing = true;
    try {
      let delta = initialDelta;
      while (delta > 0) {
        const total = this._minutesOfDay + delta;
        const rollovers = Math.floor(total / MINUTES_PER_DAY);
        this._minutesOfDay = total % MINUTES_PER_DAY;
        this.timeTouched = true;
        this.syncFlag();
        // 跨零点＝新的一天：复用 endDay 全流程（day:end → 自增 → 到期延迟事件 → day:start）。
        // 时刻先写后跑，使 day:start 的监听方读到的已是推进后的时刻。
        for (let i = 0; i < rollovers; i++) {
          await this.endDay();
        }
        delta = this.pendingDelta;
        this.pendingDelta = 0;
      }
    } finally {
      this.advancing = false;
      this.pendingDelta = 0;
    }

    const toPhase = this.currentPhase;
    this.eventBus.emit('time:changed', {
      fromMinutes,
      toMinutes: this._minutesOfDay,
      fromDay,
      dayNumber: this._currentDay,
      phase: toPhase,
      transition,
    });
    if (toPhase !== fromPhase) {
      this.eventBus.emit('time:phaseChanged', {
        from: fromPhase,
        to: toPhase,
        minutesOfDay: this._minutesOfDay,
        dayNumber: this._currentDay,
        transition,
      });
    }
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
    this.flagStore.set(FlagKeys.minutesOfDay, this._minutesOfDay);
  }

  serialize(): object {
    return {
      currentDay: this._currentDay,
      delayedEvents: this.delayedEvents,
      minutesOfDay: this._minutesOfDay,
    };
  }

  deserialize(data: {
    currentDay?: number;
    delayedEvents?: DelayedEvent[];
    minutesOfDay?: number;
  }): void {
    this._currentDay = data.currentDay ?? 1;
    this.delayedEvents = data.delayedEvents ?? [];
    // 旧档没有时刻字段：回落开局时刻，等价于"一直是白天"，不改变旧档的任何既有行为。
    const restored = Number(data.minutesOfDay);
    this._minutesOfDay = Number.isFinite(restored)
      ? ((Math.round(restored) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY
      : this.startMinutes;
    this.timeTouched = true;
    this.syncFlag();
  }

  destroy(): void {
    this._currentDay = 1;
    this.delayedEvents = [];
    this.endDayTail = Promise.resolve();
    this._minutesOfDay = this.startMinutes;
    this.timeTouched = false;
    this.advancing = false;
    this.pendingDelta = 0;
  }
}
