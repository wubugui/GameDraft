import type { GameContext, IGameSystem } from '../data/types';
import type { FootstepContact } from './FootstepSystem';

/**
 * 跟脚声 —— **玩家落脚事件的延迟重放**。
 *
 * 「后头好像有人跟着走」这件事，本质不是「一个每 0.8 秒响一次的音源」，而是
 * **你走他才走**：你迈一步，半拍之后身后也落一步；你停住，他最多再跟一步就没了。
 * 所以它不自己跑节奏，而是接 {@link FootstepSystem} 的落脚事件——那一条是**帧驱动**的
 * （动画真踩到落脚帧才发），于是步频天然跟着当前装扮与速度走。
 *
 * ## 为什么不是「定时器 + 固定身后距离」（2026-09-21 改掉的旧实现）
 *
 * 旧实现挂在 `healthThreat.presenceSfx` 上：`soundInterval: 0.8` 固定间隔 +
 * `soundBehindPlayer: 85` 固定距离。四个病，都是真实存在的：
 * 1. **与步频脱节**：常态 `walk` 循环 1.000 s、背尸 `carry_walk` 循环 2.000 s
 *    （实测，见 [[footstep-and-spatial-audio]] 硬契约 1），固定 0.8 s 必与至少一套错开，
 *    听着是节拍器不是人。
 * 2. **站着不动照响**：没写 `soundOnlyMoving`，只要在半径内就一直响。
 * 3. **不吃脚步集**：硬编码一条音效 key，换地面 / 过 zone 不换声。
 * 4. **借威胁的壳**：`boundaryRadius === damageRadius` 只是为了让「在范围内」恒真好让声音一直播，
 *    于是「有人跟着你」与「扣血」焊死，想只响不掉血、或只掉血不响都表达不出来。
 *
 * 现在两件事正交：扣血仍在 `HealthThreatSystem`，声音在这里，开关是一条动作
 * （`setFollowerFootsteps`），谁都能调（叙事状态 onEnter / zone / 对话图 / 热区）。
 *
 * ## 踩你的脚印（位置怎么来）
 *
 * 延迟到期时，声音放在**玩家当时那个脚点**，不是他现在的位置。这一个量同时决定了三件事，
 * 所以不需要再配「身后多远」：
 * - **错拍**：延迟 = 上一段步间隔 × `delayRatio`（缺省 0.5 ⇒ 正好踏在你两步中间，不与你的脚步重叠）；
 * - **距离**：玩家这 d 秒走过的路，就是他落在你身后多远——走得快离得远、走得慢贴得近，
 *   永远是「后面半步」，而固定距离在两种步速下必有一种不对；
 * - **方向**：沿着你**真实走过的轨迹**，拐弯、绕圈自动对，不需要知道朝向。
 *
 * 顺带白送一条：你停住之后，最后排队的那一声照样会响——**你停了，后头还响一下**。
 * 这是恐怖片的经典一拍，不是 bug；不想要就用 `abrupt` 关。
 *
 * ## 时间口径
 *
 * 排队走 `GameClock`（宿主注入 `after`），**不是 `setTimeout`**：开背包世界停，
 * 后头那位也得停（见 [[world-pause-and-game-clock]]）。
 *
 * ⚠ `GameClock.cancelAll()` 的语义是**立刻兑现**在途等待（死亡 / 读档 / 拆除三处会调），
 * 不是丢弃。所以排队回调有两道闸，缺一不可：
 * 1. **到点闸**：回调里比对 `nowMs() >= dueAt`——被强行兑现时时钟根本没走到，直接不响。
 *    这道闸是**自足**的：宿主将来在别处再加一个 `cancelAll()` 也不会凭空响出一串脚步。
 * 2. **世代闸**：换场景 / 读档 / 拆除各推一格，旧时间线的脚点不许响在新时间线里。
 *
 * ## 什么进存档
 *
 * **开关与参数进**（"有个东西在跟着你"是世界事实，跨读档/重试检查点必须还在——
 * 这一段恰恰有 `setRetryCheckpoint`，不进档就是"死一次跟脚声没了"且无任何报错）；
 * **在途那一步不进**（表现态，旧时间线的坐标不许响在新时间线里）。
 */

/** 一个跟脚者。参数全部有缺省，动作里不写的键一律不落盘。 */
export interface FollowerFootstepDef {
  /** 跟脚者 id（同时挂两个不同延迟的就是「后头不止一个人」）。 */
  id: string;
  /**
   * 延迟占**一段步间隔**的比例。0.5 = 正好踏在玩家两步中间（缺省）。
   * 不用固定毫秒：步间隔本身随装扮差一倍，固定值必与其中一套贴成回声。
   */
  delayRatio: number;
  /** 延迟下限（ms）：跑起来时步间隔很短，不设下限会贴成回声。 */
  minDelayMs: number;
  /** 指定脚步集；不写 = 用玩家落脚处那块地的集（过 zone 自动换）。 */
  footstepSet?: string;
  /** 相对增益（dB），叠在「集 + 全局缺省」之上。跟脚声通常给负值。 */
  gainDb: number;
  /** 玩家手上有有效火源时不响（旧数据里「护住火脚步就停」这条语义的去处）。 */
  fireStops: boolean;
}

export interface FollowerFootstepDeps {
  /** 游戏时钟当前时刻（ms）。暂停期间不前进。 */
  nowMs(): number;
  /** 游戏时钟定时器；返回取消函数。⚠ `cancelAll` 会**立刻兑现**，回调必须自带世代闸。 */
  after(ms: number, fire: () => void): () => void;
  /** 播一步「没有身体的脚步」（`FootstepSystem.playExternalStep`）。 */
  playStep(args: {
    emitterId: string;
    clip: string;
    sceneX: number;
    sceneY: number;
    setId?: string;
    gainDb?: number;
  }): boolean;
  /** 玩家此刻是否被有效火源护着。 */
  hasFireProtection(): boolean;
}

/** 缺省值（动作不写键时用这些；编辑器那侧的 seed 与这里同口径）。 */
export const FOLLOWER_DEFAULTS = {
  delayRatio: 0.5,
  minDelayMs: 180,
  gainDb: 0,
  fireStops: false,
} as const;

/**
 * 超过这个间隔就不算「上一步到这一步」，而是站住之后重新起步——那一段空白不能
 * 拿来当步频（会算出几秒的延迟）。取 3 s：最慢的装扮（背尸，循环 2.000 s）
 * 两个落脚帧之间约 1 s，留足三倍余量。
 */
const STEP_GAP_CEILING_MS = 3000;
/** 本局还没量到过步间隔时的种子（常态 walk 循环 1.000 s、两个落脚帧 ⇒ 约 0.5 s 一步）。 */
const DEFAULT_STEP_MS = 500;
/** 延迟上限：比例配大了也不至于把一步拖到听不出因果关系。 */
const MAX_DELAY_MS = 3000;
/** 调试环大小（与 FootstepSystem 的一致）。 */
const DEBUG_RING = 16;

interface PendingStep {
  followerId: string;
  /** 取消函数（幂等）。 */
  cancel: () => void;
}

export interface FollowerStepRecord {
  /**
   * 游戏时钟刻度（ms）。❗ **不能与 `FootstepDebugRecord.atMs` 直接相减**：
   * 那一份走 `FootstepSystem` 自己累加的墙钟式 `dt`（暂停期间照走），
   * 这一份走 `GameClock`（暂停时不走）——两个零点不同，相减出来是表面上
   * “跟脚声响在玩家落脚**之前**”这种不可能的结论（真机验证时踩过）。
   * 错拍对不对看本条自带的 {@link delayMs}。
   */
  atGameMs: number;
  followerId: string;
  /** 这一步是玩家哪一次落脚的回声（脚点场景坐标 wu） */
  contactX: number;
  contactY: number;
  clip: string;
  delayMs: number;
  /** 真的播出来了没有（音频没解锁 / 这块地没配脚步集都会是 false） */
  played: boolean;
}

export class FollowerFootstepSystem implements IGameSystem {
  private readonly deps: FollowerFootstepDeps;
  private readonly followers = new Map<string, FollowerFootstepDef>();
  private readonly pending: PendingStep[] = [];
  /** 上一次源落脚的时刻（游戏时钟 ms）。null = 本局还没走过。 */
  private lastContactMs: number | null = null;
  /** 最近一段合理的步间隔（ms）。站住再起步时沿用它，不拿空白重算。 */
  private lastStepIntervalMs = DEFAULT_STEP_MS;
  /**
   * 时间线世代。读档 / 换场景 / 拆除各推一格；排队回调只认自己那一格。
   * 必须有：`GameClock.cancelAll()` 是**立刻兑现**而不是丢弃。
   */
  private generation = 0;
  private readonly recent: FollowerStepRecord[] = [];

  constructor(deps: FollowerFootstepDeps) {
    this.deps = deps;
  }

  init(_ctx: GameContext): void {}

  /** 时钟自己在走，这里不需要每帧做事（排队走 GameClock.after）。 */
  update(_dt: number): void {}

  /** 开一个跟脚者（同 id 再开 = 换参数，不重复叠）。 */
  set(def: FollowerFootstepDef): void {
    this.followers.set(def.id, def);
  }

  /**
   * 关一个跟脚者。
   * @param abrupt true = 连**已排队的那一声**一起掐掉；缺省 false = 让它响完
   *   （"你停下/进屋了，后头还有一声"——这一下是要的）。
   */
  clear(id: string, abrupt = false): void {
    this.followers.delete(id);
    if (abrupt) this.cancelPending(id);
  }

  has(id: string): boolean {
    return this.followers.has(id);
  }

  /**
   * 源（玩家）真的落了一脚。**这是唯一的触发口**——没有任何定时器自己跑节奏。
   * 站着不动时压根不会有落脚事件，所以"玩家不走就没有跟脚声"是结构上成立的，不靠判断。
   */
  onSourceContact(contact: FootstepContact): void {
    const now = this.deps.nowMs();
    // 记账与有没有跟脚者无关：半路开的跟脚者也该有一个像样的步间隔可用
    if (this.lastContactMs !== null) {
      const gap = now - this.lastContactMs;
      if (gap > 0 && gap <= STEP_GAP_CEILING_MS) this.lastStepIntervalMs = gap;
    }
    this.lastContactMs = now;
    if (this.followers.size === 0) return;

    const gen = this.generation;
    for (const def of this.followers.values()) {
      // 排队时先看一次火：举着火的那一刻起就不该再排新的
      if (def.fireStops && this.deps.hasFireProtection()) continue;
      const delayMs = clampDelay(this.lastStepIntervalMs * def.delayRatio, def.minDelayMs);
      const dueAt = now + delayMs;
      const entry: PendingStep = { followerId: def.id, cancel: () => {} };
      this.pending.push(entry);
      entry.cancel = this.deps.after(delayMs, () => {
        const i = this.pending.indexOf(entry);
        if (i >= 0) this.pending.splice(i, 1);
        // 世代闸：旧时间线的脚点不许响在新时间线里
        if (gen !== this.generation) return;
        // 到点闸：`GameClock.cancelAll()` 是**立刻兑现**不是丢弃（死亡/读档/拆除三处会调），
        // 被它叫醒时时钟压根没走到点——不设这道闸，读档那一刻会凭空响一串脚步
        if (this.deps.nowMs() + 1 < dueAt) return;
        // 火是连续条件，排队期间点着了就不响了（与"关掉时让它响完"不是一回事）
        const live = this.followers.get(def.id) ?? def;
        if (live.fireStops && this.deps.hasFireProtection()) return;
        const played = this.deps.playStep({
          emitterId: `follower:${def.id}`,
          clip: contact.clip,
          sceneX: contact.contactX,
          sceneY: contact.contactY,
          setId: live.footstepSet,
          gainDb: live.gainDb,
        });
        this.pushRecent({
          atGameMs: this.deps.nowMs(),
          followerId: def.id,
          contactX: contact.contactX,
          contactY: contact.contactY,
          clip: contact.clip,
          delayMs,
          played,
        });
      });
    }
  }

  /**
   * 换场景：在途那一步的坐标属于上一张地图，一律作废（跟脚者本身留着，他跟着你过去）。
   * 步间隔记账也清掉——上一张图最后一步与这张图第一步之间不是"一步"。
   */
  onSceneChanged(): void {
    this.generation++;
    this.cancelPending();
    this.lastContactMs = null;
  }

  /** 取消在途的排队；给 id 就只取消那一个的。 */
  private cancelPending(followerId?: string): void {
    const keep: PendingStep[] = [];
    for (const p of this.pending) {
      if (followerId !== undefined && p.followerId !== followerId) {
        keep.push(p);
        continue;
      }
      p.cancel();
    }
    this.pending.length = 0;
    this.pending.push(...keep);
  }

  private pushRecent(r: FollowerStepRecord): void {
    this.recent.push(r);
    if (this.recent.length > DEBUG_RING) this.recent.shift();
  }

  /** 无头验证用：听感判不了「错拍对不对」，这份能判。 */
  getDebugOutputState(): Record<string, unknown> {
    return {
      followers: [...this.followers.values()]
        .map((d) => ({ ...d }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      lastStepIntervalMs: this.lastStepIntervalMs,
      pendingSteps: this.pending.length,
      recentFollowerSteps: this.recent.slice(),
    };
  }

  /** 开关与参数是世界事实，进档（在途那一步是表现态，不进）。 */
  serialize(): object {
    return { followers: [...this.followers.values()].map((d) => ({ ...d })) };
  }

  deserialize(data: object): void {
    // 读档 = 换时间线：在途一律作废（世代闸让已兑现的回调空转）
    this.generation++;
    this.cancelPending();
    this.lastContactMs = null;
    this.lastStepIntervalMs = DEFAULT_STEP_MS;
    this.followers.clear();
    const rows = (data as { followers?: unknown })?.followers;
    if (!Array.isArray(rows)) return;
    for (const raw of rows) {
      const def = coerceFollowerDef(raw);
      if (def) this.followers.set(def.id, def);
    }
  }

  destroy(): void {
    this.generation++;
    this.cancelPending();
    this.followers.clear();
    this.recent.length = 0;
    this.lastContactMs = null;
    this.lastStepIntervalMs = DEFAULT_STEP_MS;
  }
}

// ===========================================================================
// 纯函数（可单测，不碰运行时状态）
// ===========================================================================

/** 延迟夹取：下限防回声、上限防「一步拖到听不出因果」。 */
export function clampDelay(raw: number, minDelayMs: number): number {
  const floor = Number.isFinite(minDelayMs) && minDelayMs > 0 ? minDelayMs : 0;
  const v = Number.isFinite(raw) && raw > 0 ? raw : floor;
  return Math.min(MAX_DELAY_MS, Math.max(floor, v));
}

/** 存档行 → 定义。缺项按缺省补，坏行丢掉（旧档没有这个系统时 rows 本就为空）。 */
export function coerceFollowerDef(raw: unknown): FollowerFootstepDef | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id.trim() : '';
  if (!id) return null;
  const set = typeof o.footstepSet === 'string' ? o.footstepSet.trim() : '';
  return {
    id,
    delayRatio: num(o.delayRatio, FOLLOWER_DEFAULTS.delayRatio),
    minDelayMs: num(o.minDelayMs, FOLLOWER_DEFAULTS.minDelayMs),
    footstepSet: set || undefined,
    gainDb: num(o.gainDb, FOLLOWER_DEFAULTS.gainDb),
    fireStops: o.fireStops === true,
  };
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
