import type {
  ConditionExpr,
  GameContext,
  IEmoteBubbleAnchor,
  IGameSystem,
  PlayerIdleConfig,
  PlayerIdleEntry,
} from '../data/types';
import type { EmoteBubbleManager } from './EmoteBubbleManager';
import type { ConditionEvalContext } from './graphDialogue/evaluateGraphCondition';
import { evaluateConditionExpr } from './graphDialogue/evaluateGraphCondition';
import type { DeterministicRandom } from '../utils/deterministicRandom';

/**
 * 主角待机节目（长时间不操作 → 演个小动作 / 自言自语）。
 *
 * 只做主角，NPC 不吃这套（NPC 的头顶念叨归 {@link BubbleChatterSystem}）。
 *
 * 三条铁律：
 * 1. **任何输入立刻打断**，并且**把动画所有权还回去**。这是这个系统唯一会把游戏搞坏的地方——
 *    所有权没还＝ `Player.update` 不再自己切 idle/walk/run，表现是「待机完站不起来」。
 * 2. **只在自己确实持有所有权时才归还**。`animationOwnedByAction` 是与 PlayerActionSystem
 *    共用的一个布尔——待机期间玩家按了 C 蹲下，所有权已经归动作系统，这时候我们再写 false
 *    就会把人家的姿态动画掀掉。所以取之前先确认动作系统空闲，还之前先确认还是自己在占。
 * 3. **看门狗兜底**。动画状态在当前装扮里不存在时 `playAnimation` 直接 return、没有播完回调，
 *    没有看门狗所有权就永远交不回来。
 */

export interface PlayerIdleDeps {
  emoteBubbleManager: EmoteBubbleManager;
  /** 主角的气泡锚点 */
  playerAnchor: () => IEmoteBubbleAnchor;
  /** 同屏气泡上限（与头顶闲聊共用一个口径；缺省 2） */
  maxConcurrentBubbles: () => number;
  /**
   * 播一段一次性动画；`onDone` 在播完时回调。
   * 返回**该片段的时长（秒）**——看门狗按它推算，而不是用一个固定上限：
   * 固定 6 秒会把策划补的 8 秒躺姿拦腰砍断（砍完还刷一条误导性 warn）。
   * 拿不到时长（状态不存在 / 单帧片段没有播完回调）返回 0，由 `animWatchdogMs` 兜底。
   */
  playPlayerAnimation: (state: string, onDone: () => void) => number;
  /**
   * 当前装扮里有没有这个动画状态。**换装扮后必须靠它过滤**——背尸包里没有「打哈欠」，
   * 不过滤的话每到待机点就白跑一次看门狗（6 秒动画所有权被占着、还刷一条 warn）。
   */
  hasPlayerAnimationState: (state: string) => boolean;
  /** 交出/收回主角动画所有权 */
  setPlayerAnimationOwned: (owned: boolean) => void;
  /** 是否处于玩家自由探索态 */
  isExploring: () => boolean;
  /**
   * 玩家此刻是不是「正被别人开着」：有移动输入 / 导航目标 / 演出位移 /
   * 身体姿态或一次性动作在跑。任何一项为真都不算待机。
   */
  isPlayerBusy: () => boolean;
  /** 订阅任意输入（键盘/指针）；返回退订函数 */
  subscribeAnyInput: (cb: () => void) => () => void;
  /** 保留 `[c:…]` 样式标记的解析 */
  resolveRichText: (raw: string) => string;
  random: DeterministicRandom;
}

const DEFAULT_FIRST_DELAY_MS = 12000;
const DEFAULT_REPEAT_INTERVAL_MS = 18000;
const DEFAULT_JITTER_MS = 6000;
const DEFAULT_ANIM_WATCHDOG_MS = 6000;
const DEFAULT_BUBBLE_MS = 2600;
/** 待机气泡的归属标记；离开探索态时按它整批撤掉（与闲聊同一处理） */
const IDLE_OWNER = 'playerIdle';

export class PlayerIdleBehaviorSystem implements IGameSystem {
  private deps: PlayerIdleDeps;
  private conditionCtxFactory: (() => ConditionEvalContext) | null = null;
  private config: PlayerIdleConfig = {};
  private unsubInput: (() => void) | null = null;

  /** 已连续待机多少毫秒（有任何操作即归零） */
  private idleMs = 0;
  /** 下一次演节目的待机时长门槛 */
  private nextAtMs = DEFAULT_FIRST_DELAY_MS;
  /** 正在演的节目：占着动画所有权，等播完或看门狗 */
  private running: { watchdogMs: number; byDuration?: boolean } | null = null;
  /** 条目冷却：下标 → 还要等多少毫秒 */
  private cooldownMs: Map<number, number> = new Map();
  /** 上一帧是否在探索态——用来抓「刚离开探索态」这条边 */
  private wasExploring = false;
  private destroyed = false;

  constructor(deps: PlayerIdleDeps) {
    this.deps = deps;
  }

  init(_ctx: GameContext): void {
    this.destroyed = false;
    this.reset();
    // 重 init 与首次一致：先退订旧的，避免注册两份（IGameSystem 生命周期对称）
    this.unsubInput?.();
    this.unsubInput = this.deps.subscribeAnyInput(() => this.onPlayerActed());
  }

  setConditionEvalContextFactory(fn: () => ConditionEvalContext): void {
    this.conditionCtxFactory = fn;
  }

  /**
   * 由 Game 在读到 game_config 后注入一次。
   * **换装扮不重新注入**——节目单是全局一份，换装扮后哪些条目还能演由每次挑选时的
   * `hasPlayerAnimationState` 现取现判（背尸包里没有「打哈欠」就自动跳过那条）。
   */
  setConfig(config: PlayerIdleConfig | undefined): void {
    this.config = config && typeof config === 'object' ? config : {};
    this.reset();
  }

  private get enabled(): boolean {
    return this.config.enabled !== false && (this.config.entries?.length ?? 0) > 0;
  }

  private firstDelay(): number {
    return numOr(this.config.firstDelayMs, DEFAULT_FIRST_DELAY_MS);
  }

  private reset(): void {
    this.wasExploring = false;
    this.idleMs = 0;
    this.nextAtMs = this.firstDelay();
    this.cooldownMs.clear();
    this.stopRunning();
  }

  /** 玩家动手了：打断当前节目并把待机计时归零。 */
  private onPlayerActed(): void {
    this.idleMs = 0;
    this.nextAtMs = this.firstDelay();
    this.stopRunning();
  }

  /** 结束当前节目并归还所有权（只在自己确实占着时才还）。 */
  private stopRunning(): void {
    if (!this.running) return;
    this.running = null;
    this.deps.setPlayerAnimationOwned(false);
  }

  update(dt: number): void {
    if (this.destroyed) return;
    const ms = Math.max(0, dt) * 1000;

    /**
     * 刚离开探索态：把在飞的待机气泡撤掉。不撤的话它会和对白的「……」气泡在同一个
     * 头上像素级重叠（与闲聊气泡同型的坑）。**只在这条边撤**，不在"玩家按了个键"时撤——
     * 那种情况下让它自然过期更自然。
     */
    const exploringNow = this.deps.isExploring();
    if (this.wasExploring && !exploringNow) {
      this.deps.emoteBubbleManager.cleanupByOwner(IDLE_OWNER);
    }
    this.wasExploring = exploringNow;

    // 演出中：只走看门狗与打断判断，不累计待机时长
    if (this.running) {
      // 离开探索态 / 玩家动起来了 → 立刻收摊（走 stopRunning 归还所有权）
      if (!exploringNow || this.deps.isPlayerBusy()) {
        this.onPlayerActed();
        return;
      }
      this.running.watchdogMs -= ms;
      if (this.running.watchdogMs <= 0) {
        // 按时长算出来的窗口到点＝正常收尾（单帧姿势本来就没有播完回调），不该当异常刷屏；
        // 只有走配置兜底那条才是真的"回调没来"，值得说一声。
        if (!this.running.byDuration) {
          console.warn('PlayerIdleBehaviorSystem: 待机动画的播完回调一直没来，已按看门狗归还动画所有权');
        }
        this.stopRunning();
      }
      return;
    }

    for (const [i, left] of [...this.cooldownMs]) {
      const next = left - ms;
      if (next <= 0) this.cooldownMs.delete(i);
      else this.cooldownMs.set(i, next);
    }

    if (!this.enabled) return;
    if (!exploringNow || this.deps.isPlayerBusy()) {
      // 不算待机：计时归零，免得"读了半天面板回来立刻打哈欠"
      this.idleMs = 0;
      this.nextAtMs = this.firstDelay();
      return;
    }

    this.idleMs += ms;
    if (this.idleMs < this.nextAtMs) return;

    const picked = this.pickEntry();
    // 挑不出（条件都不满足 / 都在冷却）也要把下一次门槛推后，否则每帧重试
    this.scheduleNext();
    if (picked) this.perform(picked.entry, picked.index);
  }

  private scheduleNext(): void {
    const interval = numOr(this.config.repeatIntervalMs, DEFAULT_REPEAT_INTERVAL_MS);
    const jitter = numOr(this.config.jitterMs, DEFAULT_JITTER_MS);
    this.idleMs = 0;
    this.nextAtMs = interval + (jitter > 0 ? this.deps.random.next() * jitter : 0);
  }

  private pickEntry(): { entry: PlayerIdleEntry; index: number } | null {
    const entries = this.config.entries ?? [];
    const usable: { entry: PlayerIdleEntry; index: number; weight: number }[] = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (!e || typeof e !== 'object') continue;
      const hasAnim = !!String(e.animState ?? '').trim();
      const hasText = !!String(e.bubbleText ?? '').trim();
      if (!hasAnim && !hasText) continue;          // 空条目：既不动也不说，跳过
      // 动画在当前装扮里不存在：还有台词就只说不动，纯动画条目直接跳过
      if (hasAnim && !hasText && !this.deps.hasPlayerAnimationState(String(e.animState).trim())) continue;
      if (this.cooldownMs.has(i)) continue;
      if (!this.conditionPasses(e.when)) continue;
      usable.push({ entry: e, index: i, weight: Math.max(0.0001, e.weight ?? 1) });
    }
    if (usable.length === 0) return null;
    const total = usable.reduce((s, u) => s + u.weight, 0);
    let roll = this.deps.random.next() * total;
    for (const u of usable) {
      roll -= u.weight;
      if (roll <= 0) return { entry: u.entry, index: u.index };
    }
    const last = usable[usable.length - 1];
    return { entry: last.entry, index: last.index };
  }

  /**
   * 现在能不能往主角头上放气泡。
   * 主角头上可能已经挂着**闲聊**（`bubble_lines` 里 speaker 配成主角）或**导演式**气泡——
   * 不判的话两个气泡锚点完全相同，像素级重叠。并发上限也要吃，否则待机会顶掉闲聊的名额。
   */
  private canShowBubble(): boolean {
    const mgr = this.deps.emoteBubbleManager;
    if (mgr.hasBubbleFor(this.deps.playerAnchor())) return false;
    return mgr.activeBubbleCount() < Math.max(1, this.deps.maxConcurrentBubbles());
  }

  private conditionPasses(when: ConditionExpr | undefined): boolean {
    if (when === undefined || when === null) return true;
    const factory = this.conditionCtxFactory;
    if (!factory) return false;   // fail-safe：条件求值接不上就不演
    try {
      return evaluateConditionExpr(when, factory());
    } catch (e) {
      console.warn('PlayerIdleBehaviorSystem: 待机条件求值异常，本条跳过', e);
      return false;
    }
  }

  private perform(entry: PlayerIdleEntry, index: number): void {
    const cd = numOr(entry.cooldownMs, 0);
    if (cd > 0) this.cooldownMs.set(index, cd);

    const text = String(entry.bubbleText ?? '').trim();
    if (text && this.canShowBubble()) {
      const resolved = this.deps.resolveRichText(text).trim();
      if (resolved) {
        this.deps.emoteBubbleManager.show(
          this.deps.playerAnchor(),
          resolved,
          numOr(entry.bubbleDurationMs, DEFAULT_BUBBLE_MS),
          undefined,
          IDLE_OWNER,
        );
      }
    }

    const state = String(entry.animState ?? '').trim();
    if (!state || !this.deps.hasPlayerAnimationState(state)) return;
    // 只有动作系统确实空闲时才敢接管动画（铁律 2）
    if (this.deps.isPlayerBusy()) return;
    this.running = { watchdogMs: numOr(this.config.animWatchdogMs, DEFAULT_ANIM_WATCHDOG_MS) };
    this.deps.setPlayerAnimationOwned(true);
    const durationSec = this.deps.playPlayerAnimation(state, () => {
      // 播完回调可能晚于打断/销毁到达：只有还在演同一场才收
      if (this.destroyed || !this.running) return;
      this.stopRunning();
    });
    /**
     * 看门狗只是"回调没来"的兜底，**不该当成动画时长上限**。
     *
     * - 拿得到片段时长 → 按 `时长×1.5 + 1s` 算：8 秒的躺姿能演完；而**单帧姿势**
     *   （策划补一张叉腰/挠头的静帧）`SpriteEntity` 结构上不会触发播完回调，
     *   这时窗口自然收到 ~1.2 秒——姿势停一下就还回去，不会白占 6 秒还刷一条误导性 warn。
     * - 拿不到时长（0）→ 退回配置值兜底。
     */
    if (this.running && durationSec > 0) {
      this.running.watchdogMs = durationSec * 1500 + 1000;
      this.running.byDuration = true;
    }
  }

  serialize(): object {
    return {};   // 待机是纯表现，不进存档
  }

  deserialize(_data: object): void {
    this.reset();
  }

  destroy(): void {
    this.destroyed = true;
    // 销毁也必须归还所有权：否则重开一局后主角站着不动（生命周期对称）
    this.stopRunning();
    this.unsubInput?.();
    this.unsubInput = null;
    this.conditionCtxFactory = null;
    this.config = {};
    this.cooldownMs.clear();
  }

  /** 调试快照（F2 / 运行时命令通道读） */
  getDebugState(): object {
    return {
      enabled: this.enabled,
      entries: this.config.entries?.length ?? 0,
      idleMs: Math.round(this.idleMs),
      nextAtMs: Math.round(this.nextAtMs),
      running: this.running !== null,
      cooling: [...this.cooldownMs.keys()],
    };
  }
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
}
