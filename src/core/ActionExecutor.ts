import type { ActionDef, ZoneActionContext } from '../data/types';
import type { EventBus } from './EventBus';
import type { FlagStore, FlagValue } from './FlagStore';

/**
 * 热区/任务 `execute` 不等待；若返回 Promise，仅记录错误（不阻塞批处理）。
 * 对话 `executeForDialogue` 会 await handler 返回值，故可对同一 type 直接 `return cutsceneManager.xxx()`。
 */
export type ActionHandler = (
  params: Record<string, unknown>,
  zoneContext: ZoneActionContext | null,
) => void | Promise<void>;

/** 仅当「非对话路径必须无效果、对话路径要 await」时使用（如 waitMs）；一般让 register 的 handler 返回 Promise即可。 */
export type DialogueSequentialHandler = (params: Record<string, unknown>) => Promise<void>;

export class ActionExecutor {
  private handlers: Map<string, ActionHandler> = new Map();
  private paramNamesMap: Map<string, string[]> = new Map();
  private dialogueSequentialHandlers: Map<string, DialogueSequentialHandler> = new Map();
  private eventBus: EventBus;
  private flagStore: FlagStore;
  private zoneContextStack: ZoneActionContext[] = [];

  constructor(eventBus: EventBus, flagStore: FlagStore) {
    this.eventBus = eventBus;
    this.flagStore = flagStore;
    this.registerBuiltinHandlers();
  }

  private registerBuiltinHandlers(): void {
    this.register('setFlag', (params) => {
      this.flagStore.set(params.key as string, params.value as FlagValue);
    }, ['key', 'value']);

    this.register('appendFlag', (params) => {
      this.flagStore.appendStringFlag(params.key as string, String(params.text ?? ''));
    }, ['key', 'text']);

    this.register('showNotification', (params) => {
      this.eventBus.emit('notification:show', { text: params.text as string, type: params.type as string });
    }, ['text', 'type']);
  }

  register(type: string, handler: ActionHandler, paramNames?: string[]): void {
    this.handlers.set(type, handler);
    if (paramNames) this.paramNamesMap.set(type, paramNames);
  }

  /**
   * 对话专用顺序体（覆盖同名 `register` 在 executeForDialogue 中的行为）。
   * 典型：`waitMs` 在热区必须为无操作，在对话才延时。
   */
  registerDialogueSequential(type: string, handler: DialogueSequentialHandler): void {
    this.dialogueSequentialHandlers.set(type, handler);
  }

  getParamNames(type: string): string[] | undefined {
    return this.paramNamesMap.get(type);
  }

  /** 是否已在 Registry / 内置中登记（对话标签合法性以该接口为准，而非仅 paramNames）。 */
  hasHandler(type: string): boolean {
    return this.handlers.has(type);
  }

  /** 当前是否在 zone batch 内（供 handler 读取，一般通过第二参数即可）。 */
  getZoneContext(): ZoneActionContext | null {
    if (this.zoneContextStack.length === 0) return null;
    return this.zoneContextStack[this.zoneContextStack.length - 1]!;
  }

  execute(action: ActionDef): void {
    const handler = this.handlers.get(action.type);
    const zctx = this.getZoneContext();
    if (!handler) {
      console.warn(`ActionExecutor: unknown action type "${action.type}"`);
      return;
    }
    try {
      const r = handler(action.params, zctx);
      if (r !== undefined && r !== null && typeof (r as Promise<void>).then === 'function') {
        void (r as Promise<void>).catch((e) => {
          console.warn(`ActionExecutor: async action "${action.type}" rejected`, e);
        });
      }
    } catch (e) {
      console.warn(`ActionExecutor: action "${action.type}" threw`, e);
    }
  }

  /**
   * 图对话 runActions：与 `execute` 同一套 handler；优先 `registerDialogueSequential`（对话专用体），
   * 否则 await handler 返回值（含 Promise），实现与全游戏 Action 定义一致。
   */
  async executeForDialogue(action: ActionDef): Promise<void> {
    const seq = this.dialogueSequentialHandlers.get(action.type);
    if (seq) {
      await seq(action.params);
      return;
    }
    const handler = this.handlers.get(action.type);
    if (!handler) {
      console.warn(`ActionExecutor: unknown action type "${action.type}"`);
      return;
    }
    const zctx = this.getZoneContext();
    try {
      await Promise.resolve(handler(action.params, zctx));
    } catch (e) {
      console.warn(`ActionExecutor: dialogue action "${action.type}" failed`, e);
    }
  }

  executeBatch(actions: ActionDef[]): void {
    for (const action of actions) {
      this.execute(action);
    }
  }

  /**
   * 按顺序执行并 await handler 返回的 Promise（用于 inspect 等需「上图→对话→下图」的串联）。
   */
  async executeSequential(action: ActionDef): Promise<void> {
    const handler = this.handlers.get(action.type);
    const zctx = this.getZoneContext();
    if (!handler) {
      console.warn(`ActionExecutor: unknown action type "${action.type}"`);
      return;
    }
    try {
      await Promise.resolve(handler(action.params, zctx));
    } catch (e) {
      console.warn(`ActionExecutor: sequential action "${action.type}" failed`, e);
    }
  }

  async executeBatchSequential(actions: ActionDef[]): Promise<void> {
    for (const action of actions) {
      await this.executeSequential(action);
    }
  }

  /**
   * ZoneSystem 专用：执行期间 handler 第二参数为非空 zone 上下文（enableRuleOffers 等使用）。
   */
  executeBatchInZoneContext(actions: ActionDef[], context: ZoneActionContext): void {
    this.zoneContextStack.push(context);
    try {
      for (const action of actions) {
        this.execute(action);
      }
    } finally {
      this.zoneContextStack.pop();
    }
  }

  destroy(): void {
    this.handlers.clear();
    this.paramNamesMap.clear();
    this.dialogueSequentialHandlers.clear();
    this.zoneContextStack = [];
  }
}
