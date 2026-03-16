import type { ActionDef } from '../data/types';
import type { EventBus } from './EventBus';
import type { FlagStore } from './FlagStore';

type ActionHandler = (params: Record<string, unknown>) => void;

export class ActionExecutor {
  private handlers: Map<string, ActionHandler> = new Map();
  private eventBus: EventBus;
  private flagStore: FlagStore;

  constructor(eventBus: EventBus, flagStore: FlagStore) {
    this.eventBus = eventBus;
    this.flagStore = flagStore;
    this.registerBuiltinHandlers();
  }

  private registerBuiltinHandlers(): void {
    this.register('setFlag', (params) => {
      this.flagStore.set(params.key as string, params.value as boolean | number);
    });

    this.register('showNotification', (params) => {
      this.eventBus.emit('notification:show', { text: params.text as string, type: params.type as string });
    });
  }

  register(type: string, handler: ActionHandler): void {
    this.handlers.set(type, handler);
  }

  execute(action: ActionDef): void {
    const handler = this.handlers.get(action.type);
    if (handler) {
      handler(action.params);
    } else {
      console.warn(`ActionExecutor: unknown action type "${action.type}"`);
    }
  }

  executeBatch(actions: ActionDef[]): void {
    for (const action of actions) {
      this.execute(action);
    }
  }

  destroy(): void {
    this.handlers.clear();
  }
}
