import type { ActionDef, ActionOriginContext } from '../data/types';
import type { ActionRun } from '../core/actionRun';

/**
 * 脱手演出会话（detached performance session）。
 *
 * ## 为什么需要它
 *
 * `runActionsDetached` 造出的是**第二条时间线**：它在玩家背后跑，玩家全程能动。
 * 没有这一层的话，那条线是个没人管的孤儿——没身份、没人能点名停它、停了也不收尾。
 * 2026-09-19 制作人定的形状是三层：
 *
 * | 层 | 被打断时 |
 * |---|---|
 * | **结算**（鬼没了、符消耗了、状态推进了） | **必须发生**——打断是"跳过演出"，不是"取消技能" |
 * | **演出**（压天、起风、闪白、震屏、音画） | **整段丢掉** |
 * | **归位**（天色、闪避、震屏、雷光、长音、粒子） | **跑满**，而且**瞬间**（渐变归零） |
 *
 * ## 两条硬机制
 *
 * 1. **打断 = 快进，不是砍断**。剩下的动作照跑，只是纯演出那些整条跳过（`waitMs` 也是纯演出，
 *    所以"等待归零"是这条规则的副产物，不用另写）。分类表见 `actionParamManifest` 的 `hurry`。
 * 2. **归位靠账本，不靠作者记得写**。演出期间动过的每个旋钮都记在本会话名下，会话一结束
 *    （播完或被打断）按账本释放。数据里写的那几拍收尾从此是**保险**，不是机制本身——
 *    作者写漏了也不会漏气。
 *
 * ## 同步补跑
 *
 * 打断常常发生在**同步的收尾路径**上（切场景、死亡、读档）。等一个微任务就晚了：那时场景已经
 * 卸掉，结算会落到新场景头上。所以打断走 `runActionSync`——发车不等车到。
 */

export type PerformanceEndReason = 'done' | 'interrupted';

/** 打断的来由。只进日志与调试面板，不参与判断（任何系统都能无条件打断）。 */
export type PerformanceInterruptReason =
  | 'superseded'   // 同名技能又放了一次（顶替）
  | 'cutscene'
  | 'minigame'
  | 'scene'
  | 'death'
  | 'load'
  | 'teardown';

/**
 * 本会话**取用过**的演出旋钮。只记"我动过"，不记"我动成了什么"——除了天色，
 * 因为天色是个连续量，归位要还回**进入前**那个值而不是某个写死的缺省。
 */
export interface PerformanceLedger {
  /** 第一次压暗前的天色（null = 本会话没碰过天色） */
  envDimBefore: number | null;
  /** 本会话**最后一次设定的目标**天色。与 envDimBefore 相等 ⇒ 作者自己已经还回去了，账本不插手 */
  envDimTarget: number | null;
  /** 本会话压过的闪避层名 */
  duckNames: string[];
  shaken: boolean;
  strikeLit: boolean;
  gusted: boolean;
  /** 本会话起过的一次性音效 id（只停自己起的，不碰玩家踩出来的脚步声） */
  sfxIds: Set<string>;
  /** 本会话放出的粒子实例 id */
  vfxIds: string[];
}

function emptyLedger(): PerformanceLedger {
  return {
    envDimBefore: null,
    envDimTarget: null,
    duckNames: [],
    shaken: false,
    strikeLit: false,
    gusted: false,
    sfxIds: new Set<string>(),
    vfxIds: [],
  };
}

/** 账本释放要用到的各系统出口。全部**瞬间生效**（不接受 fadeMs）——归位不排队。 */
export interface PerformanceRelease {
  setEnvDimNow(scale: number): void;
  releaseDuck(name: string): void;
  clearShake(): void;
  clearStrikeLight(): void;
  clearGust(): void;
  stopSfx(id: string): void;
  stopVfxSoft(id: string): void;
}

export class PerformanceSession {
  readonly id: string;
  readonly actions: ActionDef[];
  /** 开这一批的来源（zone / 图 owner…）。补跑时原样用同一份，不另造上下文 */
  readonly originContext: ActionOriginContext | null;
  readonly ledger: PerformanceLedger = emptyLedger();
  /** 已被打断：剩下的按快进补跑，异步循环醒来后立刻让位 */
  hurried = false;
  finished = false;
  endReason: PerformanceEndReason | null = null;
  /** 下一条要跑的动作下标。异步循环取走一条就 +1，所以打断时从这里往后补 */
  cursor = 0;
  /**
   * 开这段演出的那一串（见 `core/actionRun.ts`）：会话占着它直到播完 / 被打断，
   * 于是"掷出雷符"那一串要等雷劈完才算结束。只给旁听者用，演出本身不看它。
   */
  readonly run: ActionRun | undefined;
  private releaseRun: (() => void) | undefined;

  constructor(id: string, actions: ActionDef[], originContext: ActionOriginContext | null, run?: ActionRun) {
    this.id = id;
    this.actions = actions;
    this.originContext = originContext;
    this.run = run;
    this.releaseRun = run?.hold();
  }

  /** 会话收场时放掉占着的串（幂等） */
  releaseRunHold(interrupted: boolean): void {
    const release = this.releaseRun;
    if (!release) return;
    this.releaseRun = undefined;
    if (interrupted) this.run?.markInterrupted();
    release();
  }
}

export interface PerformanceSessionDeps {
  /** 正常跑一条动作（接到 `ActionExecutor.executeAwait`，带本会话的 scope） */
  runAction(action: ActionDef, session: PerformanceSession): Promise<void>;
  /**
   * 打断时同步补跑一条动作：**发车不等车到**。
   * 打断常发生在同步收尾路径上（切场景/死亡/读档），等微任务就晚了。
   */
  runActionSync(action: ActionDef, session: PerformanceSession): void;
  /** 快进时该不该整条跳过（纯演出） */
  isPresentationOnly(actionType: string): boolean;
  release: PerformanceRelease;
}

export class PerformanceSessionManager {
  private readonly deps: PerformanceSessionDeps;
  /** id → 唯一活会话。**顶替语义**：同名再开播，先把旧的按打断走完整流程 */
  private readonly sessions = new Map<string, PerformanceSession>();
  /** 防重入：补跑里的动作若又触发一次打断，不能递归进来 */
  private interrupting = false;

  constructor(deps: PerformanceSessionDeps) {
    this.deps = deps;
  }

  /** 当前活着的会话 id（dev 面板 / 测试用） */
  activeIds(): string[] {
    return [...this.sessions.keys()];
  }

  get(id: string): PerformanceSession | undefined {
    return this.sessions.get(id);
  }

  /**
   * 开一段脱手演出。同名的旧会话**当场按打断收掉**（制作人 2026-09-19 定：顶替，不叠加——
   * 两片雷云叠在一起没有表达价值，只会让人以为是 bug）。
   */
  start(
    id: string,
    actions: ActionDef[],
    originContext: ActionOriginContext | null = null,
    run?: ActionRun,
  ): PerformanceSession {
    this.interrupt(id, 'superseded');
    const session = new PerformanceSession(id, actions, originContext, run);
    this.sessions.set(id, session);
    void this.run(session).catch((e) => {
      console.warn(`PerformanceSession「${id}」执行失败`, e);
      this.finish(session, 'done');
    });
    return session;
  }

  private async run(session: PerformanceSession): Promise<void> {
    while (session.cursor < session.actions.length) {
      // 打断已经接管（它会同步把剩下的补完），异步循环立刻让位
      if (session.hurried || session.finished) return;
      const action = session.actions[session.cursor];
      session.cursor++;
      await this.deps.runAction(action, session);
    }
    if (!session.hurried && !session.finished) this.finish(session, 'done');
  }

  /** 打断一个具名会话。没有这个会话 = 安静返回。 */
  interrupt(id: string, reason: PerformanceInterruptReason): void {
    const session = this.sessions.get(id);
    if (session) this.interruptSession(session, reason);
  }

  /** 打断全部。切场景 / 过场开演 / 进小游戏 / 死亡 / 读档 / 拆除都走这里。 */
  interruptAll(reason: PerformanceInterruptReason): void {
    for (const session of [...this.sessions.values()]) {
      this.interruptSession(session, reason);
    }
  }

  private interruptSession(session: PerformanceSession, reason: PerformanceInterruptReason): void {
    if (session.finished || session.hurried) return;
    if (this.interrupting) {
      // 补跑里的动作又触发了一次打断：本会话已经在收了，再进来只会把游标搅乱
      return;
    }
    this.interrupting = true;
    session.hurried = true;
    try {
      /**
       * 剩下的**同步**补跑：纯演出整条跳过，结算照做。
       * ⚠ 从 `cursor` 开始——那条正在飞的动作（多半是 `waitMs`）已经被游标走过了，
       * 它自己会在 `hurried` 上让位。
       */
      for (let i = session.cursor; i < session.actions.length; i++) {
        const action = session.actions[i];
        const type = String(action?.type ?? '').trim();
        if (!type || this.deps.isPresentationOnly(type)) continue;
        try {
          this.deps.runActionSync(action, session);
        } catch (e) {
          console.warn(`PerformanceSession「${session.id}」打断补跑「${type}」失败`, e);
        }
      }
      session.cursor = session.actions.length;
    } finally {
      this.interrupting = false;
    }
    this.finish(session, 'interrupted');
    if (reason !== 'superseded') {
      console.info(`PerformanceSession「${session.id}」被「${reason}」打断：演出已跳过，结算与归位已补齐`);
    }
  }

  private finish(session: PerformanceSession, reason: PerformanceEndReason): void {
    if (session.finished) return;
    session.finished = true;
    session.endReason = reason;
    if (this.sessions.get(session.id) === session) this.sessions.delete(session.id);
    this.releaseLedger(session);
    // 归位做完再放串：旁听者收到"这一串结束"时，世界已经回到演出前
    session.releaseRunHold(reason === 'interrupted');
  }

  /**
   * 按账本归位。**倒着放**：后取的先还（与 RAII 同一个理由——先还底下那层会让上面那层
   * 写回一个已经作废的值）。
   */
  private releaseLedger(session: PerformanceSession): void {
    const L = session.ledger;
    const r = this.deps.release;

    for (let i = L.vfxIds.length - 1; i >= 0; i--) {
      try { r.stopVfxSoft(L.vfxIds[i]); } catch { /* 实例已随场景散掉 */ }
    }
    for (const id of L.sfxIds) {
      try { r.stopSfx(id); } catch { /* 已停 */ }
    }
    if (L.gusted) { try { r.clearGust(); } catch { /* 已清 */ } }
    if (L.strikeLit) { try { r.clearStrikeLight(); } catch { /* 已清 */ } }
    if (L.shaken) { try { r.clearShake(); } catch { /* 已清 */ } }
    for (let i = L.duckNames.length - 1; i >= 0; i--) {
      try { r.releaseDuck(L.duckNames[i]); } catch { /* 已抬 */ }
    }
    /**
     * 天色：比的是**目标值**不是当前值。
     * 作者自己写了「慢慢放晴」那一拍时，最后一条动作返回的那一刻渐变还在跑；
     * 拿当前值判断会看到 0.24，于是账本一巴掌把 2.6 秒的放晴拍成瞬间。
     * 比目标：作者还过了 ⇒ 目标 == 进入前 ⇒ 账本不插手。
     */
    if (L.envDimBefore !== null && L.envDimTarget !== null
      && Math.abs(L.envDimTarget - L.envDimBefore) > 1e-4) {
      try { r.setEnvDimNow(L.envDimBefore); } catch { /* 场景已卸 */ }
    }

    L.duckNames.length = 0;
    L.vfxIds.length = 0;
    L.sfxIds.clear();
    L.envDimBefore = null;
    L.envDimTarget = null;
    L.shaken = false;
    L.strikeLit = false;
    L.gusted = false;
  }

  /** 拆除：把所有会话按打断收掉（归位照做，不留残响）。 */
  destroy(): void {
    this.interruptAll('teardown');
    this.sessions.clear();
  }
}

// --------------------------------------------------------------------------- //
// 账本登记：给各演出 handler 用的小工具。会话为空（不在脱手批里）时全是 no-op，
// 于是同一条动作在普通批里与在脱手批里写法完全一样，不用各自分叉。
// --------------------------------------------------------------------------- //

export function ledgerTakeEnvDim(
  session: PerformanceSession | undefined,
  currentDim: number,
  target: number,
): void {
  if (!session) return;
  if (session.ledger.envDimBefore === null) session.ledger.envDimBefore = currentDim;
  session.ledger.envDimTarget = target;
}

export function ledgerTakeDuck(session: PerformanceSession | undefined, name: string): void {
  if (!session) return;
  session.ledger.duckNames.push(name);
}

export function ledgerTakeSfx(session: PerformanceSession | undefined, id: string): void {
  if (!session || !id) return;
  session.ledger.sfxIds.add(id);
}

export function ledgerTakeVfx(session: PerformanceSession | undefined, id: string | null | undefined): void {
  if (!session || !id) return;
  session.ledger.vfxIds.push(id);
}

export function ledgerTakeShake(session: PerformanceSession | undefined): void {
  if (session) session.ledger.shaken = true;
}

export function ledgerTakeStrikeLight(session: PerformanceSession | undefined): void {
  if (session) session.ledger.strikeLit = true;
}

export function ledgerTakeGust(session: PerformanceSession | undefined): void {
  if (session) session.ledger.gusted = true;
}
