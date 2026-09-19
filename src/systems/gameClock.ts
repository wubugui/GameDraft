/**
 * 游戏时钟 —— **演出时间的唯一来源**。
 *
 * ## 为什么不能用 `setTimeout`
 *
 * 墙钟不认识"暂停"。玩家一开背包，世界该停：血量、威胁、燃烧、阵风、粒子、轨迹、角色动画
 * 在 `Game.tick` 里全都挂在暂停闸后面。但**演出时间**（`waitMs`、天色渐变、连劈的间隔、
 * 雷柱的软停）从前走的是 `setTimeout`——于是翻个背包出来，雷已经劈完了、天已经放晴了。
 * 制作人 2026-09-19 的原话是"进入 UI 状态弹出菜单，要直接冻结整个游戏的运行"。
 *
 * 所以：**凡是玩家看得见的等待，一律吃这个钟**。钟只在世界没暂停时前进，
 * 判据由宿主一处给出（`Game.isWorldPaused`），不在各处各写一份。
 *
 * ## 取消语义
 *
 * `cancelAll()` 把在途等待**立刻兑现**（而不是永远悬着）。
 * 悬着的话，调用方的 `await` 永远不返回：动作批的世代检查压根轮不到，脱手演出会话的
 * 循环也永远收不了尾。兑现之后，各调用方自己的世代/打断判据会在下一句拦住它——
 * 那才是它们本来的把关点。
 */

interface ClockTimer {
  /** 到期时刻（游戏时钟毫秒） */
  at: number;
  fire: () => void;
  cancelled: boolean;
}

export class GameClock {
  private nowMs = 0;
  private timers: ClockTimer[] = [];
  /** 遍历期间新排的定时器先攒着，免得边遍历边改数组 */
  private draining = false;
  private pending: ClockTimer[] = [];

  /** 当前游戏时刻（毫秒）。只在未暂停时前进。 */
  get now(): number { return this.nowMs; }

  /** 活跃定时器数（测试与 dev 面板用）。 */
  get pendingCount(): number { return this.timers.length + this.pending.length; }

  /**
   * 推进时钟。由 `Game.tick` 在**世界未暂停**时每帧调一次。
   * @param dtSec 本帧秒数（与 tick 的 dt 同单位）
   */
  advance(dtSec: number): void {
    if (!(dtSec > 0)) return;
    this.nowMs += dtSec * 1000;
    this.drain();
  }

  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      // 到期的可能不止一个（掉帧时一帧跨过好几拍）；按到期时刻顺序兑现，不打乱编排次序
      for (;;) {
        const due = this.timers.filter((t) => !t.cancelled && t.at <= this.nowMs);
        if (due.length === 0) break;
        due.sort((a, b) => a.at - b.at);
        this.timers = this.timers.filter((t) => !t.cancelled && t.at > this.nowMs);
        for (const t of due) t.fire();
        if (this.pending.length > 0) {
          this.timers.push(...this.pending);
          this.pending.length = 0;
        }
      }
      if (this.pending.length > 0) {
        this.timers.push(...this.pending);
        this.pending.length = 0;
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * 等 `ms` 毫秒**游戏时间**。世界暂停期间这个等待不前进。
   * `ms <= 0` 立刻兑现（但仍是一个微任务之后，与 `setTimeout(0)` 的时序取向一致）。
   */
  wait(ms: number): Promise<void> {
    return new Promise<void>((resolve) => { this.after(ms, resolve); });
  }

  /**
   * `ms` 毫秒游戏时间后回调。返回取消函数（幂等）。
   * 用于"到点收尾"这类不需要 await 的场合（雷柱软停）。
   */
  after(ms: number, fire: () => void): () => void {
    const delay = Number.isFinite(ms) && ms > 0 ? ms : 0;
    const timer: ClockTimer = { at: this.nowMs + delay, fire, cancelled: false };
    if (this.draining) this.pending.push(timer);
    else this.timers.push(timer);
    return () => { timer.cancelled = true; };
  }

  /**
   * 作废全部在途等待并**立刻兑现**（死亡 / 读档 / 拆除）。
   * 见文件头「取消语义」：悬着不兑现会让调用方的 await 永远不返回。
   */
  cancelAll(): void {
    const all = [...this.timers, ...this.pending];
    this.timers = [];
    this.pending = [];
    for (const t of all) {
      if (!t.cancelled) t.fire();
    }
  }
}
