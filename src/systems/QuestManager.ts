import type { EventBus } from '../core/EventBus';
import type { FlagStore } from '../core/FlagStore';
import type { ActionExecutor } from '../core/ActionExecutor';
import type { QuestDef, IGameSystem, GameContext, IQuestDataProvider } from '../data/types';
import { QuestStatus } from '../data/types';
import { resolveAssetPath } from '../core/assetPath';

export class QuestManager implements IGameSystem, IQuestDataProvider {
  private eventBus: EventBus;
  private flagStore: FlagStore;
  private actionExecutor: ActionExecutor;

  private questDefs: Map<string, QuestDef> = new Map();
  private questStatus: Map<string, QuestStatus> = new Map();
  private evaluating: boolean = false;
  private pendingEvaluate: boolean = false;
  private strings: { get(cat: string, key: string, vars?: Record<string, string | number>): string } = { get: (_c, k) => k };
  private onFlagChanged: (payload: { key: string; value: boolean | number }) => void;

  constructor(eventBus: EventBus, flagStore: FlagStore, actionExecutor: ActionExecutor) {
    this.eventBus = eventBus;
    this.flagStore = flagStore;
    this.actionExecutor = actionExecutor;

    this.onFlagChanged = () => this.evaluate();
  }

  init(ctx: GameContext): void {
    this.strings = ctx.strings;
    this.eventBus.on('flag:changed', this.onFlagChanged);
  }

  update(_dt: number): void {}

  async loadDefs(): Promise<void> {
    try {
      const resp = await fetch(resolveAssetPath('/assets/data/quests.json'));
      const defs: QuestDef[] = await resp.json();
      for (const def of defs) {
        this.questDefs.set(def.id, def);
        if (!this.questStatus.has(def.id)) {
          this.questStatus.set(def.id, QuestStatus.Inactive);
        }
      }
    } catch {
      console.warn('QuestManager: quests.json not found, running without quest definitions');
    }
  }

  acceptQuest(questId: string): void {
    const status = this.questStatus.get(questId);
    if (status !== undefined && status !== QuestStatus.Inactive) return;

    this.questStatus.set(questId, QuestStatus.Active);
    this.syncFlag(questId);

    const def = this.questDefs.get(questId);
    this.eventBus.emit('quest:accepted', { questId, title: def?.title ?? questId });
    this.eventBus.emit('notification:show', {
      text: this.strings.get('notifications', 'questAccepted', { title: def?.title ?? questId }),
      type: 'quest',
    });
  }

  private completeQuest(questId: string): void {
    this.questStatus.set(questId, QuestStatus.Completed);
    this.syncFlag(questId);

    const def = this.questDefs.get(questId);
    if (!def) return;

    if (def.rewards.length > 0) {
      this.actionExecutor.executeBatch(def.rewards);
    }

    this.eventBus.emit('quest:completed', { questId, title: def.title });
    this.eventBus.emit('notification:show', {
      text: this.strings.get('notifications', 'questCompleted', { title: def.title }),
      type: 'quest',
    });

    if (def.nextQuestId) {
      this.acceptQuest(def.nextQuestId);
    }
  }

  private evaluate(): void {
    if (this.evaluating) {
      this.pendingEvaluate = true;
      return;
    }
    this.evaluating = true;

    this.questDefs.forEach((def, id) => {
      const status = this.questStatus.get(id) ?? QuestStatus.Inactive;

      if (status === QuestStatus.Active) {
        if (def.completionConditions.length > 0 &&
            this.flagStore.checkConditions(def.completionConditions)) {
          this.completeQuest(id);
        }
      }

      if (status === QuestStatus.Inactive) {
        if (def.preconditions.length > 0 &&
            this.flagStore.checkConditions(def.preconditions)) {
          this.acceptQuest(id);
        }
      }
    });

    this.evaluating = false;
    if (this.pendingEvaluate) {
      this.pendingEvaluate = false;
      this.evaluate();
    }
  }

  getStatus(questId: string): QuestStatus {
    return this.questStatus.get(questId) ?? QuestStatus.Inactive;
  }

  getActiveQuests(): { def: QuestDef; status: QuestStatus }[] {
    const result: { def: QuestDef; status: QuestStatus }[] = [];
    this.questDefs.forEach((def, id) => {
      const s = this.questStatus.get(id);
      if (s === QuestStatus.Active) {
        result.push({ def, status: s });
      }
    });
    return result;
  }

  getCompletedQuests(): { def: QuestDef }[] {
    const result: { def: QuestDef }[] = [];
    this.questDefs.forEach((def, id) => {
      if (this.questStatus.get(id) === QuestStatus.Completed) {
        result.push({ def });
      }
    });
    return result;
  }

  getCurrentMainQuest(): QuestDef | null {
    for (const [id, def] of this.questDefs) {
      if (def.type === 'main' && this.questStatus.get(id) === QuestStatus.Active) {
        return def;
      }
    }
    return null;
  }

  private syncFlag(questId: string): void {
    const status = this.questStatus.get(questId) ?? QuestStatus.Inactive;
    this.flagStore.set(`quest_${questId}_status`, status);
  }

  serialize(): object {
    const data: Record<string, number> = {};
    this.questStatus.forEach((s, id) => { data[id] = s; });
    return data;
  }

  deserialize(data: Record<string, number>): void {
    this.questStatus.clear();
    for (const [id, s] of Object.entries(data)) {
      this.questStatus.set(id, s as QuestStatus);
      this.syncFlag(id);
    }
  }

  destroy(): void {
    this.eventBus.off('flag:changed', this.onFlagChanged);
    this.questDefs.clear();
    this.questStatus.clear();
  }
}
