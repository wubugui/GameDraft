/**
 * 玩家循环(照 Unity 的 PlayerLoop):每次 `tick(dt)` 依次跑 Start(本 tick 之前新启用、还没 start 过的组件)→
 * 全部 Update → 全部 LateUpdate。只有 isActiveAndEnabled 的组件在表里(onEnable 进、onDisable 出),
 * 所以不遍历场景树,代价只与活着的组件数成正比。
 *
 * 谁来 tick:engine2d 的 Application 在 init 时把 `PlayerLoop.shared` 挂到自己的 ticker 上(LOW 之前、渲染之前);
 * 不用 Application 的场合(测试、自己驱动主循环)直接调 `tick`。`timeScale` 缩放传给 update 的 dt(0 = 世界暂停),
 * `unscaledDeltaTime` 是未缩放的那份(UI 这类不该随世界暂停的组件用它)。
 *
 * 顺序:同一阶段内按组件进表(启用)的先后;tick 中途启用的组件本 tick 不跑 update,下个 tick 先 start 再 update
 * (与 Unity 一致:Start 在该组件第一次 Update 之前)。
 */
import type { Component } from './Component';

export class PlayerLoop {
  static readonly shared = new PlayerLoop();

  /** 传给 update / lateUpdate 的 dt 乘它(0 = 暂停世界组件) */
  timeScale = 1;
  /** 本 tick 未缩放的 dt(秒) */
  unscaledDeltaTime = 0;
  /** 本 tick 缩放后的 dt(秒) */
  deltaTime = 0;
  /** 已 tick 的次数 */
  frameCount = 0;

  private readonly live: Component[] = [];
  private readonly liveIndex = new Map<Component, number>();
  private pendingStart: Component[] = [];
  private ticking = false;
  private removedDuringTick = false;

  /** 当前活着(isActiveAndEnabled)的组件数 */
  get liveCount(): number {
    return this.liveIndex.size;
  }

  /** @internal onEnable 时进表 */
  _register(c: Component): void {
    if (this.liveIndex.has(c)) return;
    this.liveIndex.set(c, this.live.length);
    this.live.push(c);
    if (!c._started) this.pendingStart.push(c);
  }

  /** @internal onDisable 时出表 */
  _unregister(c: Component): void {
    const i = this.liveIndex.get(c);
    if (i === undefined) return;
    this.liveIndex.delete(c);
    if (this.ticking) {
      // tick 里不挪数组(正在遍历),先占空位,tick 末尾压实
      (this.live as (Component | null)[])[i] = null;
      this.removedDuringTick = true;
      return;
    }
    this.removeAt(i);
  }

  private removeAt(i: number): void {
    // 保持顺序(组件数不大,顺序比 O(1) 删除更要紧)
    this.live.splice(i, 1);
    this.reindex(i);
  }

  private reindex(from: number): void {
    for (let k = from; k < this.live.length; k++) this.liveIndex.set(this.live[k], k);
  }

  private compact(): void {
    let w = 0;
    const arr = this.live as (Component | null)[];
    for (let r = 0; r < arr.length; r++) {
      const c = arr[r];
      if (c) arr[w++] = c;
    }
    arr.length = w;
    this.reindex(0);
    this.removedDuringTick = false;
  }

  /** 跑一帧:Start → Update → LateUpdate。dt 单位秒 */
  tick(dtSeconds: number): void {
    if (this.ticking) return; // 钩子里再 tick:忽略(不允许重入)
    this.ticking = true;
    this.unscaledDeltaTime = dtSeconds;
    this.deltaTime = dtSeconds * this.timeScale;
    const dt = this.deltaTime;
    try {
      // Start:只处理本 tick 开始时已在队列里的;start 里新启用的留到下一 tick
      if (this.pendingStart.length) {
        const starting = this.pendingStart;
        this.pendingStart = [];
        for (const c of starting) {
          if (c._started || !c._live) continue;
          c._started = true;
          if (c.start) {
            try {
              c.start();
            } catch (e) {
              console.error(`[engine2d] 组件 ${c.constructor.name}.start 抛错(已截住):`, e);
            }
          }
        }
      }
      const n = this.live.length;
      const arr = this.live as (Component | null)[];
      for (let i = 0; i < n; i++) {
        const c = arr[i];
        if (!c || !c._started || !c.update) continue;
        try {
          c.update(dt);
        } catch (e) {
          console.error(`[engine2d] 组件 ${c.constructor.name}.update 抛错(已截住):`, e);
        }
      }
      for (let i = 0; i < n; i++) {
        const c = arr[i];
        if (!c || !c._started || !c.lateUpdate) continue;
        try {
          c.lateUpdate(dt);
        } catch (e) {
          console.error(`[engine2d] 组件 ${c.constructor.name}.lateUpdate 抛错(已截住):`, e);
        }
      }
    } finally {
      this.ticking = false;
      if (this.removedDuringTick) this.compact();
      this.frameCount++;
    }
  }

  /** 测试 / 重开用:清空(不调任何钩子) */
  reset(): void {
    this.live.length = 0;
    this.liveIndex.clear();
    this.pendingStart = [];
    this.timeScale = 1;
    this.frameCount = 0;
  }
}
