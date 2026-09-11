/**
 * 实体轨迹动画的**播放系统** —— 按烘焙好的关键帧驱动 `ITrajectoryTarget`（NPC / 玩家）。
 *
 * 三条设计前提，改动前先认下来：
 *
 * 1. **运行时零物理、零求解**。轨迹的一切"怎么算出来的"（手绘路径、抛体、滚动、3D 还原）都是
 *    工作台的事，保存时已经烘成密帧写进资产。这里只做"给定 t 求姿态"，
 *    因此**任意时刻都能一步瞬间求值到终态**（过场跳过、快进都靠这条性质）。
 * 2. **确定性**：只吃调用方传进来的 `dt`，绝不读 `performance.now()` / `Date.now()`。
 *    同一份帧 + 同一串 dt ⇒ 逐位相同的姿态序列。
 * 3. **一目标一驱动**：按 `target.trajectoryKey` 索引，同键同时只有一条轨迹在跑。
 *
 * **帧是相对锚点的偏移**（见 `TrajectoryKeyframe`）：开播时定一次锚点（调用方显式给，
 * 或取目标此刻位置 `readTrajectoryAnchor()`），之后每帧姿态 = 采样值 + 锚点（x / y / sortY 三处）。
 * 世界空间资产的 3D → 2D 投影在**进来之前**由组装层做完（`Game.playTrajectoryAsset`），
 * 本系统只认 2D 帧。
 *
 * ⚠ **采样器是"哑"的**（见 `utils/keyframeSampler`）：它不知道 `sortY` 缺省 = `y`、
 * `scaleX/scaleY` 缺省 = `scale`。所以喂进去之前必须先把每帧**规范成七通道**
 * （`normalizeFrames`）。跳过这一步不会报错，只会让深度排序锚被当 0 插值 ——
 * 飞在空中的物件前后关系整条错，而且画面上看着"只是层级有点怪"。
 *
 * ## 责任边界（适配契约的另一半）
 *
 * - **轨迹 vs 轨迹的仲裁在这里**：`Npc/Player.beginTrajectory` 直接覆写抢占回调、不自我抢占，
 *   所以同键第二条开播前必须由本系统先把旧的收掉（`play` 里第一件事就是 `stopFor`）。
 * - **切场景 / 读档 / 系统销毁时停轨迹是本系统的责任**：玩家跨场景长活、不在任何卸载名单里，
 *   `cancelMotion()` 不会通知我们。漏掉就是一个永远转着 30° / 半透明的主角
 *   （见 [[teardown-ordering]] 的"玩家不在卸载名单里"）。
 * - **NPC 目标开播必须停巡逻**：巡逻协程是独立的 async 循环，不停它会和轨迹同帧对着写 x/y。
 *   停法走注入的 `suspendPatrol`（= `Game.stopNpcPatrol`：取消在途位移 + 巡逻代际自增）。
 * - `Npc.steerBy`（同伴跟随自走位）**不触发抢占**，会与轨迹同时写 x/y。当前运行时无调用方；
 *   将来接同伴跟随时，要么让它也走抢占，要么在跟随侧判 `isDriving(npc.trajectoryKey)` 回避。
 *
 * 依赖一律构造函数注入（律 11），不 import 任何系统实例。
 */
import type {
  GameContext,
  IGameSystem,
  ITrajectoryTarget,
  TrajectoryEasing,
  TrajectoryKeyframe,
  TrajectoryPose,
} from '../data/types';
import { sampleKeyframeTrack } from '../utils/keyframeSampler';

/**
 * 一次播放为什么结束。**每条播放最终必有且只有一个**（律 3：异步必须封口）：
 * - `completed` —— 正常播到末帧（`update` 里自然走完）；
 * - `finished`  —— 被一步求值到终态并落姿（`immediate` / 快进态 / 零时长 / `finishAll`）；
 * - `preempted` —— 被顶掉：同键新轨迹开播，或目标被 `moveTo`/`jumpTo`/`destroy` 抢走；
 * - `stopped`   —— 调用方显式 `stopFor`；
 * - `cancelled` —— 整体作废：切场景 / 读档 / 系统销毁（`cancelAll`）、资产缺失、目标解析失败，**不落姿**。
 */
export type TrajectoryEndReason = 'completed' | 'finished' | 'preempted' | 'stopped' | 'cancelled';

/** 播放系统认的"一条轨迹"：只有 id（日志用）和 2D 相对帧。资产的其它字段到不了这里。 */
export interface TrajectoryPlayDef {
  id: string;
  keyframes: readonly TrajectoryKeyframe[];
}

export interface TrajectoryPlayOptions {
  /**
   * 播放锚点（场景坐标 wu）：帧里的 x/y/sortY 都加上它。
   * 缺省 = 目标此刻位置（`readTrajectoryAnchor()`，读在同键旧轨迹被收掉**之后**，
   * 所以是上一条的终姿——正好"接着播"）。
   */
  anchor?: { x: number; y: number };
  /** 不走时间轴，直接一步落到终姿（等价于本次播放进快进态）。 */
  immediate?: boolean;
}

export interface TrajectoryStopOptions {
  /** 停之前先把姿态求值到末帧并落上去（"停在终点"而不是"停在半路"）。 */
  toEnd?: boolean;
  /** 交还目标时是否把被轨迹改过的量（叠加旋转/缩放/透明、排序锚）恢复到进入前。 */
  reset?: boolean;
}

/** 本系统需要外部提供的能力。只有一件事，但这件事漏了就是"轨迹与巡逻对着写"。 */
export interface TrajectorySystemDeps {
  /** 停掉某 NPC 的巡逻（取消在途位移 + 巡逻代际自增）。接 `Game.stopNpcPatrol`。 */
  suspendPatrol(npcId: string): void;
}

/** `Npc.trajectoryKey` 的前缀；靠它从 key 反推 NPC id（key 才是"我在驱动谁"的真相）。 */
const NPC_KEY_PREFIX = 'npc:';

/**
 * 规范化后的一帧：七个通道**全部**是有限数值，缺省已在此处展开。
 * 采样器只认这个形状——它不懂 `scale` 与 `scaleX/scaleY` 的关系，也不懂 `sortY` 缺省是 `y`。
 */
interface NormFrame {
  atMs: number;
  easing?: TrajectoryEasing;
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  alpha: number;
  sortY: number;
}

/**
 * 采样器的通道表。**键集 = 返回值键集**；因为每帧都已规范过，这里的缺省值实际不会被取到，
 * 只是接口要求。模块级常量共享安全：采样器只读不写。
 */
const CHANNEL_DEFAULTS: Record<string, number> = {
  x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, alpha: 1, sortY: 0,
};

/** 有限数守门：非有限值（NaN/Infinity/缺/字符串）一律回落缺省，绝不让它渗进插值。 */
function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * 把作者/烘焙帧摊平成七通道。**这是本文件最容易静默错的一步**：
 * - `sortY` 缺省 = 该帧的 `y`（**不是 0**）——写 0 的话空中物件的落点关系整条错；
 * - `scaleX`/`scaleY` 各自缺省 = `scale`（`scale` 再缺省 = 1）；
 * - `rotation` 缺省 0、`alpha` 缺省 1；
 * - `easing` 原样透传（烘焙产物恒不写 = linear；手写 def 仍可用）。
 */
export function normalizeFrames(kf: readonly TrajectoryKeyframe[] | undefined): NormFrame[] {
  if (!Array.isArray(kf)) return [];
  const out: NormFrame[] = [];
  for (const k of kf) {
    if (!k || typeof k !== 'object') continue;
    const y = num(k.y, 0);
    const scale = num(k.scale, 1);
    out.push({
      atMs: Math.max(0, num(k.atMs, 0)),
      easing: k.easing,
      x: num(k.x, 0),
      y,
      rotation: num(k.rotation, 0),
      scaleX: num(k.scaleX, scale),
      scaleY: num(k.scaleY, scale),
      alpha: num(k.alpha, 1),
      sortY: num(k.sortY, y),
    });
  }
  return out;
}

/** 一条在跑的播放。`epoch` 是世代号快照，用于"旧时间线不写新状态"（律 4）。 */
interface Play {
  def: TrajectoryPlayDef;
  target: ITrajectoryTarget;
  key: string;
  frames: NormFrame[];
  /** 已播毫秒，可以超过 `durationMs`（求值时才夹） */
  tMs: number;
  durationMs: number;
  /** 顺播游标：每个播放实例独占一个，给不给采样结果都一样，只影响复杂度 */
  cursor: { i: number };
  /** 播放锚点：帧的相对偏移加上它才是场景坐标 */
  anchorX: number;
  anchorY: number;
  /** 封口器：幂等，只有第一次调用真的 resolve */
  settle: (reason: TrajectoryEndReason) => void;
  epoch: number;
}

export class TrajectorySystem implements IGameSystem {
  private readonly deps: TrajectorySystemDeps;
  /** 按 `trajectoryKey` 索引的在途播放：一目标一驱动 */
  private readonly plays = new Map<string, Play>();
  /** 世代号；`cancelAll` 自增即"上一批全部作废"（见 [[teardown-ordering]]） */
  private epoch = 0;
  private fastForward = false;
  private destroyed = false;

  constructor(deps: TrajectorySystemDeps) {
    this.deps = deps;
  }

  // ———————————————————— IGameSystem ————————————————————

  /** 不订阅任何事件：切场景/读档的作废由 Game 在既有卸载/读档路径上显式调 `cancelAll`。 */
  init(_ctx: GameContext): void {
    this.cancelAll();
    this.fastForward = false;
    this.destroyed = false;
  }

  /**
   * 每帧推进。`dt` 秒，**唯一时间来源**——不读任何挂钟，快进/慢放/单步全靠调用方给 dt。
   *
   * 顺序：推时间 → 夹到 `[0, durationMs]` 采样 → 落姿 → 到末帧则收工。
   * 收工时 **从 map 摘除但不还原叠加量**（`endTrajectory(false)`）：终姿留着，
   * 与 `moveEntityTo` "停在终点"同一个语义。
   */
  update(dt: number): void {
    if (this.plays.size === 0) return;
    const stepMs = Number.isFinite(dt) && dt > 0 ? dt * 1000 : 0;
    for (const play of [...this.plays.values()]) {
      // 上一轮的收尾可能已经把它摘了（抢占回调是同步的）
      if (this.plays.get(play.key) !== play) continue;
      play.tMs += stepMs;
      this.applyPose(play, Math.min(play.tMs, play.durationMs));
      if (play.tMs >= play.durationMs) {
        this.plays.delete(play.key);
        play.target.endTrajectory(false);
        play.settle('completed');
      }
    }
  }

  /** 轨迹是**表演态**，不入档：存档里只留一个空桶占位。 */
  serialize(): object {
    return {};
  }

  /** 读档 = 换了一条时间线，在途表演全部作废（律 4）。 */
  deserialize(_data: object): void {
    this.cancelAll();
  }

  destroy(): void {
    this.cancelAll();
    this.destroyed = true;
  }

  // ———————————————————— 播放 API ————————————————————

  /**
   * 开播一条轨迹。返回的 Promise **必然**以某个 {@link TrajectoryEndReason} 封口。
   *
   * 开播序（顺序有意义，别调）：
   * 1. 同键在途先收掉（resolve `'preempted'`）——`beginTrajectory` 自己不做仲裁；
   * 2. 定锚点：显式给的用显式的，否则读目标此刻位置（此刻已是上一条轨迹的终姿，正好接上）；
   * 3. `beginTrajectory` 登记抢占回调（内部会掐断在途 `moveTo`/`jumpTo` 并 resolve 它们）；
   * 4. NPC 目标停巡逻——不停的话巡逻协程会把实体抢回去；
   * 5. 快进态 / `immediate` / 零时长 ⇒ 一步落终姿并 resolve `'finished'`；
   * 6. 否则登记进 map，并**当帧**落首帧姿态（不等下一次 `update`，免得错位一帧）。
   */
  play(
    def: TrajectoryPlayDef,
    target: ITrajectoryTarget | null | undefined,
    opts: TrajectoryPlayOptions = {},
  ): Promise<TrajectoryEndReason> {
    let resolveFn!: (reason: TrajectoryEndReason) => void;
    const promise = new Promise<TrajectoryEndReason>((res) => { resolveFn = res; });
    let settled = false;
    const settle = (reason: TrajectoryEndReason): void => {
      if (settled) return;
      settled = true;
      resolveFn(reason);
    };

    if (this.destroyed) {
      console.warn('[TrajectorySystem] 系统已销毁，忽略 play', def?.id);
      settle('cancelled');
      return promise;
    }
    if (!target) {
      console.warn('[TrajectorySystem] 轨迹目标解析失败，忽略 play', def?.id);
      settle('cancelled');
      return promise;
    }
    const frames = normalizeFrames(def?.keyframes);
    if (frames.length === 0) {
      console.warn('[TrajectorySystem] 轨迹没有关键帧，忽略 play', def?.id);
      settle('finished');
      return promise;
    }

    const key = target.trajectoryKey;
    // 1. 同键仲裁：旧的先封口，且**不还原**姿态（新轨迹马上会覆写）
    this.stopFor(key, 'preempted');

    // 2. 锚点：显式 > 目标此刻位置。读锚点必须在 stopFor 之后（要的是上一条的终姿）
    const anchor = opts.anchor ?? target.readTrajectoryAnchor();

    const play: Play = {
      def,
      target,
      key,
      frames,
      tMs: 0,
      durationMs: Math.max(0, frames[frames.length - 1].atMs),
      cursor: { i: 0 },
      anchorX: num(anchor?.x, 0),
      anchorY: num(anchor?.y, 0),
      settle,
      epoch: this.epoch,
    };

    // 3. 进入轨迹态（掐断在途位移并 resolve 其 Promise，登记抢占回调）
    target.beginTrajectory(() => this.onTargetPreempt(play));

    // 4. NPC：停巡逻。key 才是"我在驱动谁"的真相
    if (key.startsWith(NPC_KEY_PREFIX)) {
      const npcId = key.slice(NPC_KEY_PREFIX.length);
      if (npcId) this.deps.suspendPatrol(npcId);
    }

    // 5. 一步到终态
    if (opts.immediate || this.fastForward || play.durationMs <= 0) {
      this.applyPose(play, play.durationMs);
      target.endTrajectory(false);
      settle('finished');
      return promise;
    }

    // 6. 正常播：登记 + 当帧落首帧
    this.plays.set(key, play);
    this.applyPose(play, 0);
    return promise;
  }

  /**
   * 停掉某个键上的轨迹。没有在跑返回 `false`。
   * 缺省**不落终姿、不还原**（就停在当前姿态）——两件事各由 `opts.toEnd` / `opts.reset` 显式要。
   */
  stopFor(
    key: string,
    reason: TrajectoryEndReason = 'stopped',
    opts: TrajectoryStopOptions = {},
  ): boolean {
    const play = this.plays.get(key);
    if (!play) return false;
    this.plays.delete(key);
    if (opts.toEnd) this.applyPose(play, play.durationMs);
    play.target.endTrajectory(opts.reset ?? false);
    play.settle(reason);
    return true;
  }

  /**
   * 全部一步求值到末帧、落姿、封口 `'finished'`。**过场跳过就调这个**：
   * 轨迹是纯烘焙回放，跳过 = 直接落到终态，没有"补跑一遍"的成本。
   */
  finishAll(): void {
    for (const play of [...this.plays.values()]) {
      if (this.plays.get(play.key) !== play) continue;
      this.plays.delete(play.key);
      this.applyPose(play, play.durationMs);
      play.target.endTrajectory(false);
      play.settle('finished');
    }
  }

  /**
   * 整批作废：**不落姿**，把目标身上被轨迹改过的量还原，封口 `'cancelled'`。
   * 切场景 / 读档 / 系统销毁走这条 —— 尤其是玩家：他跨场景长活，不还原就会一直顶着
   * 上一场的叠加旋转/缩放/透明度（[[teardown-ordering]] 的经典坑）。
   *
   * `epoch` 先自增：此后所有旧 Play 的 `applyPose` 都是空转，哪怕有谁还攥着引用。
   */
  cancelAll(reset = true): void {
    this.epoch++;
    const pending = [...this.plays.values()];
    this.plays.clear();
    for (const play of pending) {
      try {
        play.target.endTrajectory(reset);
      } catch (e) {
        // 拆除路径上目标可能已经半死（实体销毁中）。一个目标抛错不许连坐整批作废。
        console.warn('[TrajectorySystem] endTrajectory 抛错，已忽略并继续作废', play.key, e);
      }
      play.settle('cancelled');
    }
  }

  /**
   * 快进态开关。开启时：在途的全部一步落终姿（`finishAll`），此后新 `play` 立即落终姿返回。
   * 关掉不会"倒带"，只是恢复正常按 dt 播放。
   */
  setFastForward(on: boolean): void {
    this.fastForward = !!on;
    if (this.fastForward) this.finishAll();
  }

  isFastForward(): boolean {
    return this.fastForward;
  }

  /** 该键上是否有轨迹在跑（一步落终姿的那种从不进 map，故恒 false）。 */
  isDriving(key: string): boolean {
    return this.plays.has(key);
  }

  /** 在跑的轨迹条数（调试/测试用）。 */
  get activeCount(): number {
    return this.plays.size;
  }

  /**
   * 这条**轨迹资产**此刻在跑的那次播放：这次用的 2D 相对帧 + 播放位置。没在跑返回 null。
   *
   * 给位置引用的"曲线上的点"用（`PositionRef` 的 `curve` 档）：铜钱还在飞的时候，
   * "它的落点"指的是**这次**播放会落的地方，而不是作者场景里那条曲线的落点；这次播放的帧
   * 还是按当前场景投影过的，跨场景也准。同一条资产同时挂在多个目标上时给**第一条**
   * （谁在前由 Map 的插入序定）——真要区分是哪一个，用 `kind:'entity'` 指名那个实体。
   */
  livePlay(trajectoryId: string): { keyframes: readonly TrajectoryKeyframe[]; anchor: { x: number; y: number } } | null {
    const id = String(trajectoryId || '').trim();
    if (!id) return null;
    for (const play of this.plays.values()) {
      if (play.def.id !== id) continue;
      return { keyframes: play.def.keyframes, anchor: { x: play.anchorX, y: play.anchorY } };
    }
    return null;
  }

  // ———————————————————— 内部 ————————————————————

  /**
   * 采样 + 落姿。世代号不符就整个跳过 —— 律 4「旧时间线不写新状态」的落点。
   * 目标被销毁时走的是抢占回调（已从 map 摘除），到不了这里。
   */
  private applyPose(play: Play, tMs: number): void {
    if (play.epoch !== this.epoch) return;
    play.target.applyTrajectoryPose(this.poseAt(play, tMs));
  }

  /** 给定时刻的姿态。锚点在这里叠上去（x / y / sortY 三处，别漏 sortY）。 */
  private poseAt(play: Play, tMs: number): TrajectoryPose {
    const s = sampleKeyframeTrack(play.frames, tMs, {
      channels: CHANNEL_DEFAULTS,
      cursor: play.cursor,
    });
    return {
      x: s.x + play.anchorX,
      y: s.y + play.anchorY,
      rotationDeg: s.rotation,
      scaleX: s.scaleX,
      scaleY: s.scaleY,
      alpha: s.alpha,
      // sortY 是"落点的 y"，跟着 y 一起平移
      sortY: s.sortY + play.anchorY,
    };
  }

  /**
   * 目标被别人抢走了（`moveTo` / `jumpTo` / `Npc.destroy`）。抢占方已经把回调摘掉了
   * （`_preemptTrajectory` 先注销再调用），这里只需摘登记、解掉排序锁、封口。
   * **不落姿**：现在的所有者是抢占方，我们再写一次就是两个驱动打架。
   */
  private onTargetPreempt(play: Play): void {
    if (this.plays.get(play.key) === play) {
      this.plays.delete(play.key);
      play.target.endTrajectory(false);
    }
    play.settle('preempted');
  }
}
