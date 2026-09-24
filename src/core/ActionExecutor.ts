import type { ActionDef, ActionOriginContext } from '../data/types';
import type { PerformanceSession } from '../systems/performanceSession';
import { isPresentationOnlyAction } from './actionParamManifest';
import { GameState } from '../data/types';
import type { EventBus } from './EventBus';
import type { FlagStore, FlagValue } from './FlagStore';
import type { GameStateController } from './GameStateController';
import { reportDevError } from './devErrorOverlay';
import { makeOwnerOrigin } from './actionOrigin';
import { ActionRun, initiatorFromOrigin } from './actionRun';
import type { ActionRunEnd, ActionRunInfo, ActionRunInitiator } from './actionRun';

/**
 * 所有 action 统一走 executeAwait：顺序 await handler 返回的 Promise。
 * 无论调用来源（zone onEnter、图对话 runActions、热区 inspect、任务奖励等）语义一致。
 */
export type ActionHandler = (
  params: Record<string, unknown>,
  originContext: ActionOriginContext | null,
  scope: ActionExecScope,
) => void | Promise<void>;

/**
 * 执行作用域。与 originContext 同一个理由**显式线程化**（不用共享栈/计数器）：不同来源的批
 * 在微任务粒度交错，共享状态会把 A 批的作用域套到 B 批头上。
 *
 * `detached` = **脱手执行**：本批不把 Exploring 切进 ActionSequence。
 * 缺省（不脱手）的语义是「动作跑着的时候玩家不能动」——热区检视、对话前摇、演出都靠它；
 * 脱手是给**背景演出**用的：一段几秒到十几秒的天气/光影/音画，玩家该照常走动。
 * 作用域随容器动作往下传（见 ActionRegistry 里 runActions / randomBranch 等的转发）。
 */
export interface ActionExecScope {
  detached: boolean;
  /**
   * 这一批属于哪段脱手演出会话。
   * 有会话才谈得上"被打断"与"归位账本"——演出 handler 据此登记自己动过的旋钮
   * （见 `systems/performanceSession.ts`）。普通批恒为 undefined，一切照旧。
   */
  session?: PerformanceSession;
  /**
   * 这一批属于哪一串（见 `core/actionRun.ts`）。顶层批 / 单条动作进门时没有就现开一串，
   * 嵌套容器原样往下传，于是同一件事引出的动作共用一个串 id。**只给旁听者用**，执行语义不看它。
   */
  run?: ActionRun;
  /** 顶层调用方声明"这一串是谁起的头"；只在现开一串时读，缺省按来源上下文推 */
  initiator?: ActionRunInitiator;
}

/** 旁听者拿到的执行上下文：这是哪一串、谁起的头、从哪来、是不是脱手演出里的。 */
export interface ActionListenContext {
  readonly run: ActionRunInfo;
  readonly origin: ActionOriginContext | null;
  /** 所属脱手演出会话的名字（`runActionsDetached` 的 id）；不在脱手演出里为 undefined */
  readonly session?: string;
  readonly detached: boolean;
}

export type ActionListener = (type: string, params: Record<string, unknown>, ctx: ActionListenContext) => void;

/** 缺省作用域：锁住玩家。冻结导出，免得任何一处就地改写殃及全局。 */
export const SCOPE_ATTACHED: ActionExecScope = Object.freeze({ detached: false });
/** 脱手作用域：演出在背景跑，玩家照常走。 */
export const SCOPE_DETACHED: ActionExecScope = Object.freeze({ detached: true });

/**
 * 执行策略（L1 根因修复）：过场等宿主在执行窗口内压入黑名单，`executeAwait` 对**每个**
 * 动作（含 randomBranch / playSignalCue 等嵌套 executeBatchAwait 的）检查，命中即跳过。
 * 顶层 step 过滤仍保留在 CutsceneManager 作纵深防御。
 */
export interface ActionExecutionPolicy {
  blockedTypes: ReadonlySet<string>;
  /** 诊断标签（如 `cutscene:<id>`），告警时输出 */
  label: string;
}

export class ActionExecutor {
  private handlers: Map<string, ActionHandler> = new Map();
  private paramNamesMap: Map<string, string[]> = new Map();
  private eventBus: EventBus;
  private flagStore: FlagStore;
  private gameStateController: GameStateController | undefined;
  private actionPolicyStack: ActionExecutionPolicy[] = [];
  private resolveNotificationText: ((s: string) => string) | null = null;
  /** destroy() 后置 true；ZoneSystem 等 Promise 链仍可能异步回调，需在入口短路避免误报 unknown */
  private destroyed = false;
  private warnedAfterDestroy = false;
  private generation = 0;

  /** 死亡/读档使旧批的后续动作失效；已进入的异步系统由各自生命周期闸门收尾。 */
  cancelPending(): void { this.generation++; }
  getGeneration(): number { return this.generation; }
  /**
   * dev 叙事调试器的动作挂点（见 src/dev/narrativeDebugBridge.ts）。
   * 默认 null——生产环境无任何设置方，行为与从前一致。
   */
  static actionObserver: ((type: string, params: Record<string, unknown>) => void) | null = null;
  /**
   * 旁听每一条真正要执行的动作（世界脑靠它"看见"世界里发生的事，不必逐个技能接线）。
   * 纯旁听：拿不到返回值、改不了参数、抛了也吞掉；没人订阅时就是一次空集合判断。
   */
  private actionListeners = new Set<ActionListener>();

  addActionListener(fn: ActionListener): () => void {
    this.actionListeners.add(fn);
    return () => { this.actionListeners.delete(fn); };
  }

  /**
   * 旁听"这一串结束了"：串里最后一处占用放掉时发一次（见 `core/actionRun.ts`）。
   * 与动作旁听同一口径：纯旁听、抛了也吞掉，没人订阅时是一次空集合判断。
   */
  private runEndListeners = new Set<(end: ActionRunEnd) => void>();
  private runSeq = 0;

  addRunEndListener(fn: (end: ActionRunEnd) => void): () => void {
    this.runEndListeners.add(fn);
    return () => { this.runEndListeners.delete(fn); };
  }

  private readonly notifyRunEnd = (end: ActionRunEnd): void => {
    if (this.runEndListeners.size === 0) return;
    for (const fn of this.runEndListeners) {
      try {
        fn(end);
      } catch {
        /* 旁听方故障绝不影响动作执行 */
      }
    }
  };

  private newRun(initiator: ActionRunInitiator | undefined): ActionRun {
    return new ActionRun(++this.runSeq, initiator, this.notifyRunEnd);
  }

  /** 作用域里没有串就现开一串（发起方：调用方声明的 → 来源上下文推的 → unknown） */
  private withRun(scope: ActionExecScope, originContext: ActionOriginContext | null): ActionExecScope {
    if (scope.run) return scope;
    return { ...scope, run: this.newRun(scope.initiator ?? initiatorFromOrigin(originContext)) };
  }

  /**
   * 手动开一串：给"一件事要跨很多次 `executeAwait`"的宿主用（过场逐步执行）。
   * 每一步都传回 `scope`；整件事完了调 `end()`（幂等），`interrupted` 标它是被收掉的。
   */
  openRun(
    initiator: ActionRunInitiator,
    base: ActionExecScope = SCOPE_ATTACHED,
  ): { scope: ActionExecScope; end(interrupted?: boolean): void } {
    const run = this.newRun(initiator);
    const release = run.hold();
    let ended = false;
    return {
      scope: { ...base, run },
      end: (interrupted = false) => {
        if (ended) return;
        ended = true;
        if (interrupted) run.markInterrupted();
        release();
      },
    };
  }

  private static normalizeActionTypeKey(raw: unknown): string {
    if (raw === null || raw === undefined) return '';
    const s = typeof raw === 'string' ? raw : String(raw);
    return s.replace(/^\uFEFF/, '').trim();
  }

  constructor(
    eventBus: EventBus,
    flagStore: FlagStore,
    gameStateController?: GameStateController,
  ) {
    this.eventBus = eventBus;
    this.flagStore = flagStore;
    this.gameStateController = gameStateController;
    this.registerBuiltinHandlers();
  }

  setResolveNotificationText(fn: ((s: string) => string) | null): void {
    this.resolveNotificationText = fn;
  }

  private registerBuiltinHandlers(): void {
    this.register('setFlag', (params) => {
      this.flagStore.set(params.key as string, params.value as FlagValue);
    }, ['key', 'value']);

    this.register('appendFlag', (params) => {
      this.flagStore.appendStringFlag(params.key as string, String(params.text ?? ''));
    }, ['key', 'text']);

    /**
     * 数值标记自增：委托 FlagStore.addNumericFlag——登记表 valueType 必须为 float，
     * 否则拒绝写入（与 appendFlag 的 string 校验口径一致）。当前值非数字按 0 处理。
     */
    this.register('addFlagValue', (params) => {
      const key = String(params.key ?? '').trim();
      if (!key) {
        console.warn('addFlagValue: 需要 params.key');
        return;
      }
      const deltaRaw = params.delta;
      const delta = typeof deltaRaw === 'number' ? deltaRaw : Number(deltaRaw);
      if (!Number.isFinite(delta)) {
        console.warn(`addFlagValue: delta 须为有限数字: ${String(deltaRaw)}`);
        return;
      }
      this.flagStore.addNumericFlag(key, delta);
    }, ['key', 'delta']);

    this.register('showNotification', (params) => {
      let text = String(params.text ?? '');
      if (this.resolveNotificationText) text = this.resolveNotificationText(text);
      this.eventBus.emit('notification:show', { text, type: params.type as string });
    }, ['text', 'type']);
  }

  register(type: string, handler: ActionHandler, paramNames?: string[]): void {
    this.handlers.set(type, handler);
    if (paramNames) this.paramNamesMap.set(type, paramNames);
  }

  getParamNames(type: string): string[] | undefined {
    const k = ActionExecutor.normalizeActionTypeKey(type);
    return k === '' ? undefined : this.paramNamesMap.get(k);
  }

  /** 已注册动作类型（DEV 下与 actionParamManifest 互查用，防三方表漂移）。 */
  getRegisteredActionTypes(): string[] {
    return [...this.handlers.keys()];
  }

  getPolicyDepth(): number {
    return this.actionPolicyStack.length;
  }

  /** 宿主（如过场）在执行窗口内压入黑名单策略；必须与 popActionPolicy 成对（finally 弹出）。 */
  pushActionPolicy(blockedTypes: ReadonlySet<string>, label: string): void {
    this.actionPolicyStack.push({ blockedTypes, label });
  }

  popActionPolicy(): void {
    this.actionPolicyStack.pop();
  }

  private findBlockingPolicy(typeKey: string): ActionExecutionPolicy | null {
    for (let i = this.actionPolicyStack.length - 1; i >= 0; i--) {
      const p = this.actionPolicyStack[i]!;
      if (p.blockedTypes.has(typeKey)) return p;
    }
    return null;
  }

  hasHandler(type: string): boolean {
    const k = ActionExecutor.normalizeActionTypeKey(type);
    return k !== '' && this.handlers.has(k);
  }

  /**
   * 单次触发、不保证顺序（如商店单次购买）。
   * 若需与批内其它动作严格顺序，请用 executeBatchAwait。
   */
  execute(action: ActionDef): void {
    if (this.destroyed) return;
    void this.executeAwait(action).catch((e) => {
      const t = ActionExecutor.normalizeActionTypeKey(action.type);
      console.warn(`ActionExecutor: async action "${t}" failed`, e);
    });
  }

  /**
   * 单条动作：await handler 返回的 Promise。所有需要顺序执行的路径共用此入口。
   * originContext 按参数显式线程化（executeBatchInZoneContext / executeBatchFromOwner
   * 是注入起点）——不用共享栈：不同来源的批可在微任务粒度交错（同帧进/出多个重叠 zone、
   * 对话里再开对话），栈顶现取会把 A 批的动作配上 B 批的上下文、finally 弹栈也会弹到别人的。
   * 嵌套容器动作（runActions / chooseAction / randomBranch）由各自 handler 转发
   * 上下文；signal cue / 延迟事件等独立子系统的批不属于任何来源，天然为 null。
   */
  async executeAwait(
    action: ActionDef,
    originContext: ActionOriginContext | null = null,
    scope: ActionExecScope = SCOPE_ATTACHED,
  ): Promise<void> {
    if (this.destroyed) {
      if (!this.warnedAfterDestroy) {
        this.warnedAfterDestroy = true;
        console.warn(
          'ActionExecutor: 实例已销毁，仍收到动作请求（已忽略）。常见于关预览/HMR/destroy 时 zone 动作链尚未结束。',
        );
      }
      return;
    }
    const typeKey = ActionExecutor.normalizeActionTypeKey(action.type);
    if (!typeKey) {
      console.warn('ActionExecutor: action.type 无效，已跳过', action);
      return;
    }
    /** L1：唯一执行入口强制黑名单——嵌套批次（randomBranch / playSignalCue 等）同样经过这里 */
    const blocking = this.findBlockingPolicy(typeKey);
    if (blocking) {
      console.warn(
        `ActionExecutor: 动作 "${typeKey}" 命中执行策略「${blocking.label}」黑名单（过场内禁改存档），已跳过`,
      );
      return;
    }
    // dev 叙事调试器的唯一动作挂点：未接调试器时是一次静态属性读，不分配、不抛。
    // 有了它，"按住那个条""进了小游戏"这些没有专属事件的玩家动作才在调试器上可见。
    const observer = ActionExecutor.actionObserver;
    if (observer) {
      try {
        observer(typeKey, action.params);
      } catch {
        /* 调试通道故障绝不影响动作执行 */
      }
    }
    // 串：进门时没有就现开（顶层单条动作自成一串），占到本条动作跑完。这一段全同步、不插 await——
    // 脱手演出的同步补跑靠"handler 在第一个 await 之前就被调掉"（见 Game.buildPerformanceSessions）。
    const runScope = this.withRun(scope, originContext);
    const run = runScope.run as ActionRun;
    const release = run.hold();
    try {
      if (this.actionListeners.size > 0) {
        const ctx: ActionListenContext = {
          run,
          origin: originContext,
          session: runScope.session?.id,
          detached: runScope.detached,
        };
        for (const fn of this.actionListeners) {
          try {
            fn(typeKey, action.params ?? {}, ctx);
          } catch {
            /* 旁听方故障绝不影响动作执行 */
          }
        }
      }
      await this.runWithExploreActionLock(runScope, async () => {
        const handler = this.handlers.get(typeKey);
        if (!handler) {
          console.warn(`ActionExecutor: unknown action type "${typeKey}"`);
          // dev 必须打到屏上（authoring 期错误要响）：编辑器/validator 拦不住绕过编辑器手改的
          // JSON 与数据漂移；prod 保持 warn+跳过的容错取向（reportDevError 在 prod 是 no-op）。
          reportDevError(
            `ActionExecutor: 数据引用了未注册的动作类型 "${typeKey}"（已跳过）——检查拼写，或按 add-game-action 三件套补注册`,
          );
          return;
        }
        await Promise.resolve(handler(action.params, originContext, runScope));
      });
    } finally {
      release();
    }
  }

  /** 顺序执行批量动作并 await 每一条；originContext 与 scope 原样传给批内每条动作。 */
  async executeBatchAwait(
    actions: ActionDef[],
    originContext: ActionOriginContext | null = null,
    scope: ActionExecScope = SCOPE_ATTACHED,
  ): Promise<void> {
    const gen = this.generation;
    // 整批共用一串（嵌套容器传进来的已经带着，原样用），占到整批跑完
    const runScope = this.withRun(scope, originContext);
    const run = runScope.run as ActionRun;
    const release = run.hold();
    try {
      await this.runBatch(actions, originContext, runScope, gen, run);
    } finally {
      release();
    }
  }

  private async runBatch(
    actions: ActionDef[],
    originContext: ActionOriginContext | null,
    scope: ActionExecScope,
    gen: number,
    run: ActionRun,
  ): Promise<void> {
    for (const action of actions) {
      if (gen !== this.generation || this.destroyed) {
        // 死亡 / 读档把剩下的动作作废了：这一串是被收掉的，不是走完的
        run.markInterrupted();
        return;
      }
      /**
       * 所属会话已被打断 ⇒ 本批剩下的按**快进**跑：纯演出整条跳过，结算照做。
       *
       * 顶层时间线由会话自己同步补跑（切场景这类同步收尾路径等不起一个微任务）；
       * 这里管的是**嵌套容器**里的剩余动作——少了这一段，脱手批里套一层 `runActions`
       * 就会在打断之后接着把整套演出播完，正好播在过场上面。
       */
      if (scope.session?.hurried && isPresentationOnlyAction(String(action?.type ?? ''))) continue;
      await this.executeAwait(action, originContext, scope);
    }
  }

  /** ZoneSystem 专用：批内 handler 第二参数为非空 zone 上下文（显式线程化，见 executeAwait 注释）。 */
  async executeBatchInZoneContext(actions: ActionDef[], context: ActionOriginContext): Promise<void> {
    await this.executeBatchAwait(actions, context);
  }

  /**
   * 归属实体持有的动作批（热区 inspect actions、叙事图状态动作、任务奖励、过场步骤、
   * 对话 runActions…）：把该实体的叙事 owner 线程化下去，批里的 `startDialogueGraph`
   * 未显式给 owner 时即以此为准，被开的图里 ownerState 节点才读得到状态机。
   * ownerType/ownerId 任一为空即视为无来源（传 null），不制造半个 owner。
   */
  async executeBatchFromOwner(
    actions: ActionDef[],
    ownerType: string | undefined,
    ownerId: string | undefined,
  ): Promise<void> {
    await this.executeBatchAwait(actions, makeOwnerOrigin(ownerType, ownerId));
  }

  destroy(): void {
    this.cancelPending();
    this.destroyed = true;
    this.handlers.clear();
    this.paramNamesMap.clear();
    this.actionPolicyStack = [];
    this.actionListeners.clear();
    this.runEndListeners.clear();
  }

  /**
   * 仅在当前为 Exploring 时切入 ActionSequence（对话/遭遇/演出等不参与，避免与子状态抢占）。
   * 若在动作内部切到 Dialogue 等后再回到 Exploring，下一条 executeAwait 会再次加锁。
   *
   * **脱手作用域整条跳过加锁**：那一批是背景演出，玩家全程该能走。跳过的是「加锁」本身，
   * 不是「判断」——脱手批里若有动作自己切了状态（对话、小游戏），那是它自己的事，与此无关。
   */
  private async runWithExploreActionLock<T>(scope: ActionExecScope, work: () => Promise<T>): Promise<T> {
    const gen = this.generation;
    const sc = this.gameStateController;
    if (!sc || scope.detached) return work();
    let appliedExploreLock = false;
    if (sc.currentState === GameState.Exploring) {
      sc.setState(GameState.ActionSequence);
      appliedExploreLock = true;
    }
    try {
      return await work();
    } finally {
      if (gen === this.generation && appliedExploreLock && sc.currentState === GameState.ActionSequence) {
        sc.setState(GameState.Exploring);
      }
    }
  }
}
