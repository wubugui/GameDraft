/** 每个角色独占的动画 AO 浓度；只吃游戏 dt，不持有计时器或场景资源。 */
export class ContactAoTransition {
  private initialized = false;
  private value = 0;
  private target = 0;
  private from = 0;
  private elapsedMs = 0;

  get active(): boolean { return this.value !== this.target; }

  /** 出生、隐藏后重现、作者关闭 AO 时直接采用当前状态，不继承旧过渡。 */
  reset(enabled: boolean): number {
    this.initialized = true;
    this.value = this.target = this.from = enabled ? 1 : 0;
    this.elapsedMs = 0;
    return this.value;
  }

  update(enabled: boolean, dtMs: number, fadeInMs: number, fadeOutMs: number): number {
    if (!this.initialized) return this.reset(enabled);
    const target = enabled ? 1 : 0;
    if (target !== this.target) {
      // 反转从上一帧真实浓度接着走；同为开启的动画互切不重启渐入。
      this.from = this.value;
      this.target = target;
      this.elapsedMs = 0;
    }
    if (!this.active) return this.value;
    const duration = enabled ? fadeInMs : fadeOutMs;
    if (duration <= 0) return this.reset(enabled);
    this.elapsedMs += Number.isFinite(dtMs) ? Math.max(0, dtMs) : 0;
    const t = Math.min(1, this.elapsedMs / duration);
    const eased = t * t * (3 - 2 * t);
    this.value = t === 1 ? target : this.from + (target - this.from) * eased;
    return this.value;
  }
}
