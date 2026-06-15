import type { EventBus } from '../core/EventBus';
import type { FlagStore } from '../core/FlagStore';
import type { ActionExecutor } from '../core/ActionExecutor';
import type { Condition, ConditionExpr, QuestDef, IGameSystem, GameContext, IQuestDataProvider } from '../data/types';
import { QuestStatus } from '../data/types';
import type { AssetManager } from '../core/AssetManager';
import type { ConditionEvalContext } from './graphDialogue/evaluateGraphCondition';
import { evaluateConditionExprList } from './graphDialogue/conditionEvalBridge';
import { TEXT_URLS } from '../core/projectPaths';

export class QuestManager implements IGameSystem, IQuestDataProvider {
  private eventBus: EventBus;
  private flagStore: FlagStore;
  private actionExecutor: ActionExecutor;
  private conditionCtxFactory: (() => ConditionEvalContext) | null = null;

  private questDefs: Map<string, QuestDef> = new Map();
  private questStatus: Map<string, QuestStatus> = new Map();
  private evaluating: boolean = false;
  private pendingEvaluate: boolean = false;
  private strings: { get(cat: string, key: string, vars?: Record<string, string | number>): string } = { get: (_c, k) => k };
  private assetManager!: AssetManager;
  private onFlagChanged: () => void;
  /** 任务奖励 / 接取动作串行，避免与 evaluate 或它处异步交错 */
  private questActionTail: Promise<void> = Promise.resolve();

  constructor(eventBus: EventBus, flagStore: FlagStore, actionExecutor: ActionExecutor) {
    this.eventBus = eventBus;
    this.flagStore = flagStore;
    this.actionExecutor = actionExecutor;

    this.onFlagChanged = () => this.evaluate();
  }

  /** 与图对话共用 `evaluateConditionExpr`；未注入时退化为纯 flag AND。 */
  setConditionEvalContextFactory(factory: (() => ConditionEvalContext) | null): void {
    this.conditionCtxFactory = factory;
  }

  private evalConditions(conds: ConditionExpr[]): boolean {
    if (!conds.length) return true;
    const ctx = this.conditionCtxFactory?.();
    if (ctx) return evaluateConditionExprList(conds, ctx);
    return this.flagStore.checkConditions(conds as Condition[]);
  }

  init(ctx: GameContext): void {
    this.strings = ctx.strings;
    this.assetManager = ctx.assetManager;
    this.eventBus.on('flag:changed', this.onFlagChanged);
    // 完成条件可为叙事状态叶子（{narrative, state, reached}）：状态迁移后须重评
    this.eventBus.on('narrative:stateChanged', this.onFlagChanged);
  }

  update(_dt: number): void {}

  async loadDefs(): Promise<void> {
    try {
      const defs = await this.assetManager.loadJson<QuestDef[]>(TEXT_URLS.quests);
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

  private enqueueQuestActions(task: () => Promise<void>): void {
    this.questActionTail = this.questActionTail.then(task, task).catch((e) => {
      console.warn('QuestManager: queued quest actions failed', e);
    });
  }

  acceptQuest(questId: string): void {
    const status = this.questStatus.get(questId);
    if (status !== undefined && status !== QuestStatus.Inactive) return;

    this.questStatus.set(questId, QuestStatus.Active);
    this.syncFlag(questId);

    const def = this.questDefs.get(questId);
    const onAccept = def?.acceptActions ?? [];
    const title = def?.title ?? questId;

    if (onAccept.length > 0) {
      this.enqueueQuestActions(async () => {
        try {
          await this.actionExecutor.executeBatchAwait(onAccept);
        } catch (e) {
          console.warn('QuestManager: acceptActions failed', e);
        }
        this.eventBus.emit('quest:accepted', { questId, title });
        this.eventBus.emit('notification:show', {
          text: this.strings.get('notifications', 'questAccepted', { title }),
          type: 'quest',
        });
      });
    } else {
      this.eventBus.emit('quest:accepted', { questId, title });
      this.eventBus.emit('notification:show', {
        text: this.strings.get('notifications', 'questAccepted', { title }),
        type: 'quest',
      });
    }
  }

  private completeQuest(questId: string): void {
    this.questStatus.set(questId, QuestStatus.Completed);
    this.syncFlag(questId);

    const def = this.questDefs.get(questId);
    if (!def) return;

    const title = def.title;
    const emitCompletedAndChain = (): void => {
      this.eventBus.emit('quest:completed', { questId, title });
      this.eventBus.emit('notification:show', {
        text: this.strings.get('notifications', 'questCompleted', { title }),
        type: 'quest',
      });

      if (def.nextQuests && def.nextQuests.length > 0) {
        for (const edge of def.nextQuests) {
          if (edge.conditions.length > 0 && !this.evalConditions(edge.conditions)) {
            continue;
          }
          if (!edge.bypassPreconditions) {
            const targetDef = this.questDefs.get(edge.questId);
            if (targetDef && targetDef.preconditions.length > 0 &&
                !this.evalConditions(targetDef.preconditions)) {
              continue;
            }
          }
          this.acceptQuest(edge.questId);
        }
      } else if (def.nextQuestId) {
        this.acceptQuest(def.nextQuestId);
      }
    };

    if (def.rewards.length > 0) {
      this.enqueueQuestActions(async () => {
        try {
          await this.actionExecutor.executeBatchAwait(def.rewards);
        } catch (e) {
          console.warn('QuestManager: rewards failed', e);
        }
        emitCompletedAndChain();
      });
    } else {
      emitCompletedAndChain();
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
            this.evalConditions(def.completionConditions)) {
          this.completeQuest(id);
        }
      }

      if (status === QuestStatus.Inactive) {
        const preconditionsOk = def.preconditions.length === 0 ||
          this.evalConditions(def.preconditions);
        if (preconditionsOk && def.completionConditions.length > 0 &&
            this.evalConditions(def.completionConditions)) {
          // 状态跳变（dev 跳转 / 读档不一致）时，从当前叙事/标记态把任务链「追平」：
          // 可达且完成条件已满足的非活跃任务直接判完成，并经 nextQuests 链式激活后续。
          // 正常顺序游玩不受影响——完成条件只会在任务激活后随流程满足，不会先于激活成立。
          this.completeQuest(id);
        } else if (def.preconditions.length > 0 &&
            this.evalConditions(def.preconditions)) {
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

  debugSetQuestStatus(questId: string, status: QuestStatus | number | string): void {
    const id = questId.trim();
    if (!id) return;
    const normalized = this.normalizeQuestStatus(status);
    this.questStatus.set(id, normalized);
    this.syncFlag(id);
  }

  getQuestTitle(questId: string): string | undefined {
    return this.questDefs.get(questId)?.title;
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

  private normalizeQuestStatus(status: QuestStatus | number | string): QuestStatus {
    if (status === QuestStatus.Completed || status === 2 || String(status).toLowerCase() === 'completed') {
      return QuestStatus.Completed;
    }
    const text = String(status).trim().toLowerCase();
    if (status === QuestStatus.Active || status === 1 || text === 'active' || text === 'accepted') {
      return QuestStatus.Active;
    }
    return QuestStatus.Inactive;
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
    this.eventBus.off('narrative:stateChanged', this.onFlagChanged);
    this.questDefs.clear();
    this.questStatus.clear();
    this.questActionTail = Promise.resolve();
  }
}
