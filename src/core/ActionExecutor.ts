import type { ActionDef, ZoneActionContext } from '../data/types';
import { GameState } from '../data/types';
import type { EventBus } from './EventBus';
import type { FlagStore, FlagValue } from './FlagStore';
import type { GameStateController } from './GameStateController';

/**
 * 所有 action 统一走 executeAwait：顺序 await handler 返回的 Promise。
 * 无论调用来源（zone onEnter、图对话 runActions、热区 inspect、任务奖励等）语义一致。
 */
export type ActionHandler = (
  params: Record<string, unknown>,
  zoneContext: ZoneActionContext | null,
) => void | Promise<void>;

export class ActionExecutor {
  private handlers: Map<string, ActionHandler> = new Map();
  private paramNamesMap: Map<string, string[]> = new Map();
  private eventBus: EventBus;
  private flagStore: FlagStore;
  private gameStateController: GameStateController | undefined;
  private zoneContextStack: ZoneActionContext[] = [];
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

    /** 数值标记自增：当前值非数字（含未设置）按 0 处理；delta 非有限数字时跳过并告警。 */
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
      const cur = this.flagStore.get(key);
      const base = typeof cur === 'number' && Number.isFinite(cur) ? cur : 0;
      this.flagStore.set(key, base + delta);
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

  hasHandler(type: string): boolean {
    const k = ActionExecutor.normalizeActionTypeKey(type);
    return k !== '' && this.handlers.has(k);
  }

  getZoneContext(): ZoneActionContext | null {
    if (this.zoneContextStack.length === 0) return null;
    return this.zoneContextStack[this.zoneContextStack.length - 1]!;
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

  /** 单条动作：await handler 返回的 Promise。所有需要顺序执行的路径共用此入口。 */
  async executeAwait(action: ActionDef): Promise<void> {
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
    await this.runWithExploreActionLock(async () => {
      const handler = this.handlers.get(typeKey);
      if (!handler) {
        console.warn(`ActionExecutor: unknown action type "${typeKey}"`);
        return;
      }
      const zctx = this.getZoneContext();
      await Promise.resolve(handler(action.params, zctx));
    });
  }

  /** 顺序执行批量动作并 await 每一条。 */
  async executeBatchAwait(actions: ActionDef[]): Promise<void> {
    for (const action of actions) {
      await this.executeAwait(action);
    }
  }

  /** ZoneSystem 专用：执行期间 handler 第二参数为非空 zone 上下文。 */
  async executeBatchInZoneContext(actions: ActionDef[], context: ZoneActionContext): Promise<void> {
    this.zoneContextStack.push(context);
    try {
      await this.executeBatchAwait(actions);
    } finally {
      this.zoneContextStack.pop();
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.handlers.clear();
    this.paramNamesMap.clear();
    this.zoneContextStack = [];
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
