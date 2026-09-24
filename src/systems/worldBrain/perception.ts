import type { WorldBrainEvent } from './types';

/**
 * 街面"看见了什么"：一条有上限的事件时间线 + 由它派生的"街上现在多紧张"。
 *
 * 时间一律用世界脑自己的钟（秒，只在探索态且没暂停时走）——翻背包出来，
 * 十秒前劈的雷还是十秒前，不会因为墙钟走了半分钟就被当成陈年旧事。
 *
 * 显著度（吓不吓人、值不值得看）**由 Jev 判**，写回事件上；本地不写死分数。
 */
export class WorldPerception {
  private events: WorldBrainEvent[] = [];

  constructor(private readonly capacity = 32) {}

  /** 记一件事；同一件事 1.5 秒内连报（连劈的雷、同一效果连放）只留一条。返回 false = 被合并掉了 */
  note(ev: WorldBrainEvent): boolean {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      if (ev.at - e.at >= 1.5) break;
      if (e.text === ev.text) return false;
    }
    this.events.push(ev);
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity);
    return true;
  }

  /** 还没问过显著度的事（新的在前），最多 n 件；取出即标记为已问 */
  takeUnscored(n: number): WorldBrainEvent[] {
    const out: WorldBrainEvent[] = [];
    for (let i = this.events.length - 1; i >= 0 && out.length < n; i--) {
      const e = this.events[i];
      if (e.salience === null && !e.asked) {
        e.asked = true;
        out.push(e);
      }
    }
    return out;
  }

  clear(): void {
    this.events = [];
  }

  /** 引擎说这一串结束了：这一簇（同一串的事）记下平息时刻；返回记了几件 */
  settleRun(runId: number, at: number): number {
    let n = 0;
    for (const e of this.events) {
      if (e.runId !== runId || e.settledAt !== undefined) continue;
      e.settledAt = at;
      n++;
    }
    return n;
  }

  /** 同一串的全部事（一簇），旧的在前 */
  cluster(runId: number): WorldBrainEvent[] {
    return this.events.filter((e) => e.runId === runId);
  }

  /** 最近 windowSec 秒内的事（新的在后） */
  recent(now: number, windowSec: number, max = 8): WorldBrainEvent[] {
    const out = this.events.filter((e) => now - e.at <= windowSec);
    return out.slice(-max);
  }

  /**
   * 最近一件"值得看"的带地点的事（看热闹 / 朝那边望 / 往反方向跑的目标）。
   *
   * 只认 `spectacle` 的事（"关二狗走到土狗跟前"不算——实测真 Jev 会因为它就让娃娃们围过去）；
   * Jev 已判过显著度的，低于 `minSalience` 的不算；还没判的先算（刚劈下来的雷不能等一轮才有人看）。
   */
  lastLocated(now: number, windowSec: number, minSalience = 0.3): WorldBrainEvent | null {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      if (now - e.at > windowSec) break;
      if (!e.spectacle || typeof e.x !== 'number' || typeof e.y !== 'number') continue;
      if (e.salience !== null && e.salience < minSalience) continue;
      // 街上某人自己的动作：判成值得看之前不算"出事地点"（平常走动不能让全街凑过去看）
      if (e.actor && e.salience === null) continue;
      return e;
    }
    return null;
  }

  /**
   * 最近一件值得拿来摆的事（被搭话时"摆刚才那件事 / 怀疑是你搞的"、台词的 `{event}` 槽位用）：
   * 世界里的事（`spectacle`）、有短名、Jev 没判成"平常事"的；Jev 判得越显著越优先，一样就取新的。
   * 还没判的按中档算（刚出的事不能因为显著度题还在路上就没得说）。
   * 一样显著时玩家自己搞出来的优先——搭话的就是他，"是不是你搞的"要问到点子上。
   */
  mostNotable(now: number, windowSec: number, minSalience = 0.3): WorldBrainEvent | null {
    let best: WorldBrainEvent | null = null;
    let bestScore = -1;
    for (const e of this.events) {
      if (now - e.at > windowSec || !e.spectacle) continue;
      if (!(e.lazyGist ? e.lazyGist() : e.gist)) continue;
      if (e.salience !== null && e.salience < minSalience) continue;
      const score = (e.salience ?? 0.5) + (e.byPlayer ? 0.05 : 0);
      if (score >= bestScore) {
        bestScore = score;
        best = e;
      }
    }
    return best;
  }

  /** 街上现在多紧张（0..1）：Jev 判过的显著度按 45 秒线性衰减取最大；只给调试面板看，不参与决策 */
  tension(now: number, decaySec = 45): number {
    let m = 0;
    for (const e of this.events) {
      const age = now - e.at;
      if (e.salience === null || age < 0 || age > decaySec) continue;
      m = Math.max(m, e.salience * (1 - age / decaySec));
    }
    return m;
  }

  get size(): number {
    return this.events.length;
  }

  all(): readonly WorldBrainEvent[] {
    return this.events;
  }
}

/** 相对时间 → 口语（Jev 不擅长比较数字，给它词） */
export function describeAgo(sec: number): string {
  if (sec < 4) return '刚刚';
  if (sec < 12) return '几秒前';
  if (sec < 25) return '十来秒前';
  if (sec < 45) return '半分钟前';
  if (sec < 90) return '一分钟前';
  return '好一阵之前';
}

/** 距离 → 口语 */
export function describeDistance(d: number, sightRange: number): string {
  if (d < 90) return '就在跟前';
  if (d < 220) return '几步远';
  if (d < 450) return '隔了一段';
  if (d < sightRange) return '隔得远，看得到';
  return '看不到';
}

/**
 * 方位 → 口语（从 (fromX, fromY) 看 (toX, toY) 在哪边）：地图 x 向右为东、y 向下为南（街名东街 / 南街跟原画一致）。
 * 两个轴差不多大时说"东北"这种；贴得很近（< 30 世界单位）不说方位。
 */
export function describeDirection(fromX: number, fromY: number, toX: number, toY: number): string | null {
  const dx = toX - fromX;
  const dy = toY - fromY;
  if (Math.hypot(dx, dy) < 30) return null;
  const ew = dx > 0 ? '东' : '西';
  const ns = dy > 0 ? '南' : '北';
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax > ay * 2) return `${ew}边`;
  if (ay > ax * 2) return `${ns}边`;
  return `${ew}${ns}边`;
}

/** 持续时长 → 口语 */
export function describeDuration(sec: number): string {
  if (sec < 5) return '刚开始';
  if (sec < 20) return '有一阵了';
  return '好一阵了';
}

/**
 * 玩家走 / 跑 / 站的推断：每 `sampleSec` 采一次位置，"动没动"只看位置变没变
 * （输入被锁、点地导航、演出位移都会让"按了键"和"在动"对不上）。
 *
 * "走还是跑"不按速度分档：透视步长补偿让远处每帧少走世界单位，同一个人跑在远处
 * 可能比走在近处还慢——所以跑不跑由调用方给"跑键按着"这一位，与"在动"取与。
 */
export class PlayerMotionSampler {
  private lastX: number | null = null;
  private lastY = 0;
  private acc = 0;
  private _speed = 0;
  private _stillFor = 0;
  private _runHeld = false;

  constructor(private readonly sampleSec = 0.25) {}

  reset(): void {
    this.lastX = null;
    this.acc = 0;
    this._speed = 0;
    this._stillFor = 0;
    this._runHeld = false;
  }

  update(dt: number, x: number, y: number, runHeld: boolean): void {
    this._runHeld = runHeld;
    if (this.lastX === null) {
      this.lastX = x;
      this.lastY = y;
      return;
    }
    this.acc += dt;
    if (this.acc < this.sampleSec) return;
    const d = Math.hypot(x - this.lastX, y - this.lastY);
    this._speed = d / this.acc;
    if (this._speed < 8) this._stillFor += this.acc;
    else this._stillFor = 0;
    this.acc = 0;
    this.lastX = x;
    this.lastY = y;
  }

  get gait(): 'still' | 'walking' | 'running' {
    if (this._speed < 8) return 'still';
    return this._runHeld ? 'running' : 'walking';
  }

  get speed(): number {
    return this._speed;
  }

  /** 连续站着不动了几秒 */
  get stillFor(): number {
    return this._stillFor;
  }
}
