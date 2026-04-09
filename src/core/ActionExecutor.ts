import type { ActionDef, ZoneActionContext } from '../data/types';
import type { EventBus } from './EventBus';
import type { FlagStore } from './FlagStore';

export type ActionHandler = (
  params: Record<string, unknown>,
  zoneContext: ZoneActionContext | null,
) => void;

export class ActionExecutor {
  private handlers: Map<string, ActionHandler> = new Map();
  private paramNamesMap: Map<string, string[]> = new Map();
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
      this.flagStore.set(params.key as string, params.value as boolean | number);
    }, ['key', 'value']);

    this.register('showNotification', (params) => {
      this.eventBus.emit('notification:show', { text: params.text as string, type: params.type as string });
    }, ['text', 'type']);
  }

  register(type: string, handler: ActionHandler, paramNames?: string[]): void {
    this.handlers.set(type, handler);
    if (paramNames) this.paramNamesMap.set(type, paramNames);
  }

  getParamNames(type: string): string[] | undefined {
    return this.paramNamesMap.get(type);
  }

  /** 当前是否在 zone batch 内（供 handler 读取，一般通过第二参数即可）。 */
  getZoneContext(): ZoneActionContext | null {
    if (this.zoneContextStack.length === 0) return null;
    return this.zoneContextStack[this.zoneContextStack.length - 1]!;
  }

  execute(action: ActionDef): void {
    const handler = this.handlers.get(action.type);
    const zctx = this.getZoneContext();
    if (handler) {
      handler(action.params, zctx);
    } else {
      console.warn(`ActionExecutor: unknown action type "${action.type}"`);
    }
  }

  executeBatch(actions: ActionDef[]): void {
    for (const action of actions) {
      this.execute(action);
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
    this.zoneContextStack = [];
  }
}
