import type { EventBus } from '../core/EventBus';
import type { FlagStore } from '../core/FlagStore';
import type { ActionExecutor } from '../core/ActionExecutor';
import type { Condition, ConditionExpr, QuestDef, IGameSystem, GameContext, IQuestDataProvider, NarrativeRunPanelInfo } from '../data/types';
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
  /** repeatable 任务按活计图 id 索引（runArchetype → def），生命周期事件镜像用 */
  private repeatableByArchetype: Map<string, QuestDef> = new Map();
  /** 活计运行信息只读口（Game 组装层注入 NarrativeStateManager.getRunPanelInfo） */
  private runInfoProvider: ((graphId: string) => NarrativeRunPanelInfo | null) | null = null;
  private evaluating: boolean = false;
  private pendingEvaluate: boolean = false;
  private strings: { get(cat: string, key: string, vars?: Record<string, string | number>): string } = { get: (_c, k) => k };
  private assetManager!: AssetManager;
  private onFlagChanged: () => void;
  private onRunStarted: (p: { archetypeId: string; ordinal: number }) => void;
  private onRunSettled: (p: { archetypeId: string; exitStateId: string }) => void;
  private onRunActivated: (p: { archetypeId: string | null; previous: string | null }) => void;
  private onRunDiscarded: (p: { graphId: string; to?: string; cause?: string }) => void;
  /** 任务奖励 / 接取动作串行，避免与 evaluate 或它处异步交错 */
  private questActionTail: Promise<void> = Promise.resolve();
  /** 读档期间为 true：抑制 flag:changed 触发的 evaluate，避免在 scenario/narrative 等尚未恢复时按半态误判任务完成/激活 */
  private restoring: boolean = false;

  constructor(eventBus: EventBus, flagStore: FlagStore, actionExecutor: ActionExecutor) {
    this.eventBus = eventBus;
    this.flagStore = flagStore;
    this.actionExecutor = actionExecutor;

    this.onFlagChanged = () => { if (!this.restoring) this.evaluate(); };
    // repeatable 镜像：活计生命周期 → 通知/HUD 追踪事件。任务定义零条件，全部由这里派生。
    this.onRunStarted = (p) => this.handleRunStarted(p.archetypeId);
    this.onRunSettled = (p) => this.handleRunSettled(p.archetypeId);
    this.onRunActivated = (p) => this.handleRunActivated(p.archetypeId, p.previous);
    this.onRunDiscarded = (p) => {
      if (p.cause !== 'discard' || p.to !== '') return;
      const def = this.repeatableByArchetype.get(p.graphId);
      if (def && !this.restoring) {
        this.eventBus.emit('notification:show', {
          text: this.strings.get('notifications', 'jobDiscarded', { title: def.title }),
          type: 'quest',
        });
      }
    };
  }

  /** 由 Game 在分发存档前后调用，包裹整个 deserialize 过程。 */
  setRestoring(v: boolean): void {
    this.restoring = v;
    // 恢复完成点：此刻叙事已整体还原（无论系统 deserialize 顺序），重建 repeatable 的 HUD 追踪。
    // 激活槽 restore 是静默赋值不发 runActivated，只能在这里补发。
    if (!v) this.reemitRepeatableTracking();
  }

  /** 注入活计运行信息只读口（组装层接线，勿在系统间直连） */
  setRunInfoProvider(fn: ((graphId: string) => NarrativeRunPanelInfo | null) | null): void {
    this.runInfoProvider = fn;
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
    this.eventBus.on('narrative:runStarted', this.onRunStarted);
    this.eventBus.on('narrative:runSettled', this.onRunSettled);
    this.eventBus.on('narrative:runActivated', this.onRunActivated);
    this.eventBus.on('narrative:stateChanged', this.onRunDiscarded);
  }

  update(_dt: number): void {}

  async loadDefs(): Promise<void> {
    try {
      const defs = await this.assetManager.loadJson<QuestDef[]>(TEXT_URLS.quests);
      for (const def of defs) {
        this.questDefs.set(def.id, def);
        if (def.type === 'repeatable') {
          // repeatable 不进 Inactive/Active/Completed 状态机：条目全部由活计生命周期派生
          if (def.runArchetype) this.repeatableByArchetype.set(def.runArchetype, def);
          else console.warn(`QuestManager: repeatable 任务 ${def.id} 缺 runArchetype，条目将不可见`);
          continue;
        }
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
    // repeatable 无状态机：updateQuest/接取动作误指向时按无效目标忽略（validator 已在数据侧拦）
    if (this.questDefs.get(questId)?.type === 'repeatable') {
      console.warn(`QuestManager: repeatable 任务 ${questId} 不可 accept（由活计生命周期驱动）`);
      return;
    }
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
    if (this.questDefs.get(questId)?.type === 'repeatable') {
      console.warn(`QuestManager: repeatable 任务 ${questId} 不可 complete（由活计结算驱动）`);
      return;
    }
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
      if (def.type === 'repeatable') return;
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
    if (this.questDefs.get(id)?.type === 'repeatable') {
      console.warn(`QuestManager: repeatable 任务 ${id} 无状态机可设（活计用 start/reset/revertNarrativeRun 驱动）`);
      return;
    }
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

  getRepeatableQuestEntries(): { def: QuestDef; run: NarrativeRunPanelInfo }[] {
    const result: { def: QuestDef; run: NarrativeRunPanelInfo }[] = [];
    if (!this.runInfoProvider) return result;
    for (const def of this.questDefs.values()) {
      if (def.type !== 'repeatable' || !def.runArchetype) continue;
      const run = this.runInfoProvider(def.runArchetype);
      if (!run) continue;
      // 无实例且无结算历史 = 从没接过这活，不上面板
      if (run.active === undefined && run.settled.length === 0) continue;
      result.push({ def, run });
    }
    return result;
  }

  // ---- repeatable 镜像：活计生命周期 → HUD/通知（任务定义零条件，全部派生） ----

  private handleRunStarted(archetypeId: string): void {
    const def = this.repeatableByArchetype.get(archetypeId);
    if (!def || this.restoring) return;
    this.eventBus.emit('quest:accepted', { questId: def.id, title: def.title, repeatable: true });
    this.eventBus.emit('notification:show', {
      text: this.strings.get('notifications', 'questAccepted', { title: def.title }),
      type: 'quest',
    });
  }

  private handleRunSettled(archetypeId: string): void {
    const def = this.repeatableByArchetype.get(archetypeId);
    if (!def || this.restoring) return;
    // 不落 QuestStatus.Completed：repeatable 的"完成"是单次结算，归档汇总由计数派生
    this.eventBus.emit('quest:completed', { questId: def.id, title: def.title, repeatable: true });
    this.eventBus.emit('notification:show', {
      text: this.strings.get('notifications', 'questCompleted', { title: def.title }),
      type: 'quest',
    });
  }

  private handleRunActivated(archetypeId: string | null, previous: string | null): void {
    if (this.restoring) return;
    // 切走的一律先取消追踪（挂起或弃置都不该占 HUD 焦点；结算路径 quest:completed 已摘除，重复摘无害）
    const prevDef = previous ? this.repeatableByArchetype.get(previous) : undefined;
    if (prevDef) this.eventBus.emit('quest:untracked', { questId: prevDef.id });
    // 新激活的接管追踪；restored:true = 只重建 HUD 显示，不触发音效/通知副作用
    const def = archetypeId ? this.repeatableByArchetype.get(archetypeId) : undefined;
    if (def) this.eventBus.emit('quest:accepted', { questId: def.id, title: def.title, repeatable: true, restored: true });
  }

  /** 读档完成点补发：激活槽 restore 是静默赋值，HUD 追踪只能由此重建 */
  private reemitRepeatableTracking(): void {
    if (!this.runInfoProvider) return;
    for (const [archetypeId, def] of this.repeatableByArchetype) {
      const run = this.runInfoProvider(archetypeId);
      if (run?.activated) {
        this.eventBus.emit('quest:accepted', { questId: def.id, title: def.title, repeatable: true, restored: true });
      }
    }
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
      // 旧档遗留：已迁移为 repeatable 的任务不再有状态机，丢弃陈旧状态（活计运行态由叙事档负责）
      if (this.questDefs.get(id)?.type === 'repeatable') continue;
      this.questStatus.set(id, s as QuestStatus);
      this.syncFlag(id);
    }
    // 读档后重建 HUD 任务追踪：对活跃任务补发 quest:accepted。接取顺序未随档存储
    // （questStatus 在 loadDefs 时按 quests.json 数据序播种，序列化即该序），故按数据序补发，
    // HUD 以最后一条为当前追踪。payload.restored=true 供副作用消费者（音效等）识别忽略；
    // 不补发 notification:show，读档瞬间不弹假任务通知。
    for (const [id, s] of this.questStatus) {
      if (s !== QuestStatus.Active) continue;
      const title = this.questDefs.get(id)?.title ?? id;
      this.eventBus.emit('quest:accepted', { questId: id, title, restored: true });
    }
  }

  destroy(): void {
    this.eventBus.off('flag:changed', this.onFlagChanged);
    this.eventBus.off('narrative:stateChanged', this.onFlagChanged);
    this.eventBus.off('narrative:runStarted', this.onRunStarted);
    this.eventBus.off('narrative:runSettled', this.onRunSettled);
    this.eventBus.off('narrative:runActivated', this.onRunActivated);
    this.eventBus.off('narrative:stateChanged', this.onRunDiscarded);
    this.questDefs.clear();
    this.questStatus.clear();
    this.repeatableByArchetype.clear();
    this.questActionTail = Promise.resolve();
  }
}
