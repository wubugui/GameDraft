import type { ActionDef, ZoneActionContext } from '../data/types';
import { GameState } from '../data/types';
import type { EventBus } from './EventBus';
import type { FlagStore, FlagValue } from './FlagStore';
import type { GameStateController } from './GameStateController';
import { reportDevError } from './devErrorOverlay';

/**
 * 所有 action 统一走 executeAwait：顺序 await handler 返回的 Promise。
 * 无论调用来源（zone onEnter、图对话 runActions、热区 inspect、任务奖励等）语义一致。
 */
export type ActionHandler = (
  params: Record<string, unknown>,
  zoneContext: ZoneActionContext | null,
) => void | Promise<void>;

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
   * zoneContext 按参数显式线程化（executeBatchInZoneContext 为唯一注入起点）——
   * 不用共享栈：不同 zone 的批可在微任务粒度交错（同帧进/出多个重叠 zone），
   * 栈顶现取会把 A 批的动作配上 B 批的上下文、finally 弹栈也会弹到别人的。
   * 嵌套容器动作（runActions / chooseAction / randomBranch）由各自 handler 转发
   * 上下文；signal cue / 延迟事件等独立子系统的批不属于任何 zone，天然为 null。
   */
  async executeAwait(action: ActionDef, zoneContext: ZoneActionContext | null = null): Promise<void> {
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
    await this.runWithExploreActionLock(async () => {
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
      await Promise.resolve(handler(action.params, zoneContext));
    });
  }

  /** 顺序执行批量动作并 await 每一条；zoneContext 原样传给批内每条动作。 */
  async executeBatchAwait(actions: ActionDef[], zoneContext: ZoneActionContext | null = null): Promise<void> {
    for (const action of actions) {
      await this.executeAwait(action, zoneContext);
    }
  }

  /** ZoneSystem 专用：批内 handler 第二参数为非空 zone 上下文（显式线程化，见 executeAwait 注释）。 */
  async executeBatchInZoneContext(actions: ActionDef[], context: ZoneActionContext): Promise<void> {
    await this.executeBatchAwait(actions, context);
  }

  destroy(): void {
    this.destroyed = true;
    this.handlers.clear();
    this.paramNamesMap.clear();
    this.actionPolicyStack = [];
  }

  /**
   * 仅在当前为 Exploring 时切入 ActionSequence（对话/遭遇/演出等不参与，避免与子状态抢占）。
   * 若在动作内部切到 Dialogue 等后再回到 Exploring，下一条 executeAwait 会再次加锁。
   */
  private async runWithExploreActionLock<T>(work: () => Promise<T>): Promise<T> {
    const sc = this.gameStateController;
    if (!sc) return work();
    let appliedExploreLock = false;
    if (sc.currentState === GameState.Exploring) {
      sc.setState(GameState.ActionSequence);
      appliedExploreLock = true;
    }
    try {
      return await work();
    } finally {
      if (appliedExploreLock && sc.currentState === GameState.ActionSequence) {
        sc.setState(GameState.Exploring);
      }
    }
  }
}
