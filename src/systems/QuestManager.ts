import type { EventBus } from '../core/EventBus';
import type { FlagStore } from '../core/FlagStore';
import type { ActionExecutor } from '../core/ActionExecutor';
import type {
  Condition, ConditionExpr, QuestDef, IGameSystem, GameContext, IQuestDataProvider,
  NarrativeRunPanelInfo, QuestAnnounceStyle, QuestGuidanceDef, QuestObjectiveDef, QuestObjectiveView,
} from '../data/types';
import { QuestStatus } from '../data/types';
import type { AssetManager } from '../core/AssetManager';
import type { ConditionEvalContext } from './graphDialogue/evaluateGraphCondition';
import { evaluateConditionExprList } from './graphDialogue/conditionEvalBridge';
import { TEXT_URLS } from '../core/projectPaths';

/**
 * 当前任务槽的**自动**改选优先级（玩法文档 D6）。玩家/动作显式指定时不看这张表。
 * repeatable 排最后，且自动改选永不去激活一张没在跑的活计（见 pickAutoFocusCandidate）。
 */
const FOCUS_TYPE_PRIORITY: Record<QuestDef['type'], number> = { main: 0, side: 1, repeatable: 2 };

/** 存档形状 v2（旧档是扁平的 `Record<questId, status>`，deserialize 两种都吃） */
interface QuestSaveV2 {
  statuses: Record<string, number>;
  focusedQuestId: string | null;
  selectedObjectives?: Record<string, string>;
}

/** 本批攒下的提示候选（同批合流规则见玩法文档 D9） */
interface AnnounceCandidate {
  questId: string;
  /** accept=刚接取的新任务；focus=动作显式把注意力拉到某条任务 */
  mode: 'accept' | 'focus';
  style: QuestAnnounceStyle;
  /** 数据序（quests.json 位置）：同优先级时取靠前的走横幅 */
  order: number;
  priority: number;
}

export class QuestManager implements IGameSystem, IQuestDataProvider {
  private eventBus: EventBus;
  private flagStore: FlagStore;
  private actionExecutor: ActionExecutor;
  private conditionCtxFactory: (() => ConditionEvalContext) | null = null;

  private questDefs: Map<string, QuestDef> = new Map();
  private questStatus: Map<string, QuestStatus> = new Map();
  /** 数据序（quests.json 里的位置）：同批提示合流按它定序 */
  private questOrder: Map<string, number> = new Map();
  /** repeatable 任务按活计图 id 索引（runArchetype → def），生命周期事件镜像用 */
  private repeatableByArchetype: Map<string, QuestDef> = new Map();
  /** 活计运行信息只读口（Game 组装层注入 NarrativeStateManager.getRunPanelInfo） */
  private runInfoProvider: ((graphId: string) => NarrativeRunPanelInfo | null) | null = null;
  /** 活计激活通道（Game 注入 NarrativeStateManager.activateNarrativeRun）：把活计设为当前任务时用 */
  private activateRunHandler: ((graphId: string) => Promise<void>) | null = null;
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

  /**
   * 当前任务（玩法文档 D6）：**全局唯一一条**，跨主线/支线/活计共用同一个槽。
   * 它决定 HUD 显示哪条、引导指向哪里；进存档。
   */
  private focusedQuestId: string | null = null;
  /** 只记玩家的跟踪偏好；目标完成与开放状态仍由叙事条件派生。 */
  private selectedObjectives = new Map<string, string>();
  private trackingRevision = 0;
  /** 接取先后（自动改选取「最近接取」）；不入档，读档按数据序重建 */
  private acceptOrder: string[] = [];
  /** 当前任务的目标完成签名：变了才广播，避免每次 flag 变动都让 HUD/面板重建 */
  private lastObjectiveSig: string = '';
  /** 同批接取的提示候选，微任务末尾统一决策（一批至多一条横幅） */
  private announceBatch: AnnounceCandidate[] = [];
  private announceFlushScheduled: boolean = false;

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
        // 被弃置的活计若正占着当前任务槽，交给自动改选（不留一条指向已消失实例的当前任务）
        this.reselectFocusIfStale();
        this.emitChanged('discarded');
      }
    };
  }

  /** 由 Game 在分发存档前后调用，包裹整个 deserialize 过程。 */
  setRestoring(v: boolean): void {
    this.restoring = v;
    // 恢复完成点：此刻叙事已整体还原（无论系统 deserialize 顺序），重建 repeatable 的 HUD 追踪。
    // 激活槽 restore 是静默赋值不发 runActivated，只能在这里补发。
    if (!v) {
      this.reemitRepeatableTracking();
      this.reselectFocusIfStale();
      this.lastObjectiveSig = this.computeObjectiveSignature();
      this.emitChanged('restored');
    }
  }

  /** 注入活计运行信息只读口（组装层接线，勿在系统间直连） */
  setRunInfoProvider(fn: ((graphId: string) => NarrativeRunPanelInfo | null) | null): void {
    this.runInfoProvider = fn;
  }

  /** 注入活计激活通道（组装层接线）：把一条活计设为当前任务时经它走叙事队列 */
  setActivateRunHandler(fn: ((graphId: string) => Promise<void>) | null): void {
    this.activateRunHandler = fn;
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
    this.eventBus.on('time:changed', this.onFlagChanged);
    this.eventBus.on('player:posture', this.onFlagChanged);
    this.eventBus.on('narrative:runStarted', this.onRunStarted);
    this.eventBus.on('narrative:runSettled', this.onRunSettled);
    this.eventBus.on('narrative:runActivated', this.onRunActivated);
    this.eventBus.on('narrative:stateChanged', this.onRunDiscarded);
  }

  update(_dt: number): void {}

  async loadDefs(): Promise<void> {
    try {
      const defs = await this.assetManager.loadJson<QuestDef[]>(TEXT_URLS.quests);
      defs.forEach((def, index) => {
        this.questDefs.set(def.id, def);
        this.questOrder.set(def.id, index);
        if (def.type === 'repeatable') {
          // repeatable 不进 Inactive/Active/Completed 状态机：条目全部由活计生命周期派生
          if (def.runArchetype) this.repeatableByArchetype.set(def.runArchetype, def);
          else console.warn(`QuestManager: repeatable 任务 ${def.id} 缺 runArchetype，条目将不可见`);
          return;
        }
        if (!this.questStatus.has(def.id)) {
          this.questStatus.set(def.id, QuestStatus.Inactive);
        }
      });
    } catch {
      console.warn('QuestManager: quests.json not found, running without quest definitions');
    }
  }

  private enqueueQuestActions(task: () => Promise<void>): void {
    this.questActionTail = this.questActionTail.then(task, task).catch((e) => {
      console.warn('QuestManager: queued quest actions failed', e);
    });
  }

  /**
   * 「任务态变了」的唯一广播口（玩法文档 D2）。
   *
   * **事件只说"变了"，不携带真相**：面板 / HUD / 引导收到后一律回头查 provider 重建。
   * 这样自动接取、动作主动接取、读档恢复、目标勾掉走的是同一条显示路径——
   * 历史上 HUD 靠累积 `quest:accepted` 事件推「当前任务」，与面板查询出的状态各说各话。
   */
  private emitChanged(reason: string): void {
    this.eventBus.emit('quest:changed', { reason });
  }

  /**
   * @param opts.inheritFocus 由**链式接取**传入：上一条任务完成时正占着当前任务槽，
   *   槽应当顺着 `nextQuests` 交到链上的下一条，而不是被别的支线截胡（见 completeQuest）。
   */
  acceptQuest(questId: string, opts?: { inheritFocus?: boolean }): void {
    // repeatable 无状态机：updateQuest/接取动作误指向时按无效目标忽略（validator 已在数据侧拦）
    if (this.questDefs.get(questId)?.type === 'repeatable') {
      console.warn(`QuestManager: repeatable 任务 ${questId} 不可 accept（由活计生命周期驱动）`);
      return;
    }
    const status = this.questStatus.get(questId);
    if (status !== undefined && status !== QuestStatus.Inactive) return;

    this.questStatus.set(questId, QuestStatus.Active);
    this.syncFlag(questId);
    this.noteAccepted(questId);

    const def = this.questDefs.get(questId);
    const onAccept = def?.acceptActions ?? [];
    const title = def?.title ?? questId;

    // ⚠ 状态一翻转就广播 + 排提示，**不等 acceptActions 跑完**。
    // 旧实现把 quest:accepted 与通知一起塞在 `await executeBatchFromOwner` 之后，
    // 接取动作里挂一段对话就会让「面板已变、HUD 没变、提示没响」持续整段对话——
    // 这正是「自动接取 / 主动接取表现不一致」的根因。提示自身的压制交给提示层
    // （NotificationUI.isSuppressed / QuestBannerUI 的探索态判据）。
    if (def) this.maybeAutoFocus(def, opts?.inheritFocus === true);
    this.queueAnnounce(questId, 'accept');
    this.emitChanged('accepted');

    if (onAccept.length > 0) {
      this.enqueueQuestActions(async () => {
        try {
          // 任务自己持有的动作批：owner 记在任务上（`quest` 是合法 wrapper owner 类型），
          // 接任务时开的对话即归属该任务的状态机。
          await this.actionExecutor.executeBatchFromOwner(onAccept, 'quest', questId);
        } catch (e) {
          console.warn('QuestManager: acceptActions failed', e);
        }
        this.eventBus.emit('quest:accepted', { questId, title });
      });
    } else {
      this.eventBus.emit('quest:accepted', { questId, title });
    }
  }

  private completeQuest(questId: string): void {
    if (this.questDefs.get(questId)?.type === 'repeatable') {
      console.warn(`QuestManager: repeatable 任务 ${questId} 不可 complete（由活计结算驱动）`);
      return;
    }
    // 完成的那条如果正占着当前任务槽，槽要**顺着 nextQuests 链交下去**，
    // 不能在这里就改选——改选会挑走"此刻分数最高的另一条 Active 任务"，
    // 而现网主线整条是零奖励的 nextQuests 链：手上随便挂一条支线，
    // 主线推进一步当前任务就跳到那条支线上去了（确定性复现，不是竞态）。
    const handedOver = this.focusedQuestId === questId;
    this.questStatus.set(questId, QuestStatus.Completed);
    this.syncFlag(questId);
    if (handedOver) {
      // 槽**清空**而不是留在这条上：奖励批是异步的（可能挂着一整段对话），
      // 留着的话 HUD 会在整段对话里挂着「当前：<一条刚了的任务>」——那是错的信息。
      // 链上的下一条随后经 inheritFocus 接手；链断了在 emitCompletedAndChain 末尾兜底改选。
      this.setFocusedQuest(null, 'completed');
    } else {
      this.reselectFocusIfStale();
    }
    this.emitChanged('completed');

    const def = this.questDefs.get(questId);
    if (!def) {
      if (handedOver) this.reselectFocusIfStale();
      return;
    }

    const title = def.title;
    const emitCompletedAndChain = (): void => {
      this.eventBus.emit('quest:completed', { questId, title });
      this.eventBus.emit('notification:show', {
        text: this.strings.get('notifications', 'questCompleted', { title }),
        type: 'quest',
      });

      // 槽只交给链上**第一条真接上的**任务；后面的边不再抢。
      // ⚠ 这里按**此刻**的槽重算，不能沿用入口那次判断：奖励批是异步的，
      // 等待期间玩家完全可能在面板上显式挑了另一条任务当当前任务——
      // 那时槽已经不空了，链就不该把它硬拽回来（玩家的显式选择压过一次自动交接）。
      let handoff = handedOver && this.focusedQuestId === null;
      const chainAccept = (targetId: string): void => {
        const before = this.focusedQuestId;
        this.acceptQuest(targetId, { inheritFocus: handoff });
        if (handoff && this.focusedQuestId !== before) handoff = false;
      };

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
          chainAccept(edge.questId);
        }
      } else if (def.nextQuestId) {
        chainAccept(def.nextQuestId);
      }
      // 链没接上（末章 / 条件全不满足）时才轮到自动改选兜底
      if (handoff) this.reselectFocusIfStale();
    };

    if (def.rewards.length > 0) {
      this.enqueueQuestActions(async () => {
        try {
          await this.actionExecutor.executeBatchFromOwner(def.rewards, 'quest', def.id);
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
      return;
    }
    // 目标勾选是条件派生的：同一批 flag/叙事变化里可能只动了目标而没动任务状态，
    // 那样上面一条 emitChanged 都不会发，HUD 的目标行与引导就停在旧值上。
    this.syncObjectiveSignature();
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
    if (normalized === QuestStatus.Active) this.noteAccepted(id);
    this.syncFlag(id);
    this.reselectFocusIfStale();
    this.emitChanged('debug');
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

  /**
   * @deprecated 只给出第一条进行中的主线。**面板列表不要用它**——多条主线并行是常态
   * （主线链推进 + 条件自动接取），用它当列表源会静默吞掉第二条以后的主线。
   */
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

  // ---- 当前任务槽（玩法文档 D6）------------------------------------------------

  getFocusedQuestId(): string | null {
    return this.focusedQuestId;
  }

  getFocusedQuestView(): { questId: string; title: string; objective: string } | null {
    const id = this.focusedQuestId;
    if (!id) return null;
    const def = this.questDefs.get(id);
    if (!def) return null;
    return { questId: id, title: def.title, objective: this.getCurrentObjective(id)?.text ?? '' };
  }

  /**
   * 能否设为当前任务：一次性任务须进行中；活计须有在途实例。
   * 已完成 / 未接取 / 蛰伏的活计都不行。
   */
  canFocusQuest(questId: string): boolean {
    const def = this.questDefs.get(questId);
    if (!def) return false;
    if (def.type === 'repeatable') {
      if (!def.runArchetype) return false;
      const run = this.runInfoProvider?.(def.runArchetype);
      return !!run && run.active !== undefined;
    }
    return this.questStatus.get(questId) === QuestStatus.Active;
  }

  /**
   * 设为当前任务（玩家在面板点、或动作 setFocusedQuest）。传 null 清空。
   *
   * 与活计激活槽的桥接（只单向，故意的）：
   * - 目标是**活计** → 经叙事队列 `activateNarrativeRun`，激活成功后 `narrative:runActivated`
   *   会把槽同步过来（这就是 D5 一直以来的「切换激活对象」手势）。
   * - 目标是**一次性任务** → **不动**活计激活槽。反向清槽会让非 resumable 的在途活计被
   *   直接作废（`suspendOrDiscardActivated` 对不可恢复的活计是丢实例 + aborted++），
   *   而玩家只是想追踪主线而已——追踪一条主线不该销毁手上的活。
   */
  async requestFocusQuest(questId: string | null, opts?: { announce?: boolean; objectiveId?: string }): Promise<void> {
    const revision = ++this.trackingRevision;
    if (questId === null || questId === '') {
      this.setFocusedQuest(null, 'clear');
      return;
    }
    const def = this.questDefs.get(questId);
    if (!def) {
      console.warn(`QuestManager: setFocusedQuest 目标任务不存在: ${questId}`);
      return;
    }
    if (!this.canFocusQuest(questId)) {
      console.warn(`QuestManager: 任务 ${questId} 此刻不可设为当前任务（未接取 / 已完成 / 活计无在途实例）`);
      return;
    }
    if (def.type === 'repeatable' && def.runArchetype) {
      const run = this.runInfoProvider?.(def.runArchetype);
      if (run && !run.activated) {
        if (!this.activateRunHandler) {
          console.warn('QuestManager: 未注入 activateRunHandler，无法激活活计');
          return;
        }
        await this.activateRunHandler(def.runArchetype);
        if (revision !== this.trackingRevision || this.restoring) return;
        // runActivated 事件已把槽同步过来；下面补一次幂等赋值，防注入方吞掉事件。
        // ⚠ 激活是走叙事队列的异步操作，可能失败（图不存在 / 实例已没了）：
        // 只有真激活上了才认，否则会留下"当前任务指着一张没在跑的活计"。
        const after = this.runInfoProvider?.(def.runArchetype);
        if (!after?.activated) {
          console.warn(`QuestManager: 活计 ${def.runArchetype} 激活未生效，当前任务槽不变`);
          return;
        }
      }
    }
    const objectiveId = opts?.objectiveId?.trim();
    if (objectiveId && this.canFocusObjective(questId, objectiveId)) {
      this.selectedObjectives.set(questId, objectiveId);
    }
    this.setFocusedQuest(questId, 'focus');
    // 同一任务换办法也要刷新箭头；不可见/已完成目标交给既有自动回落。
    this.syncObjectiveSignature();
    if (opts?.announce === true) this.queueAnnounce(questId, 'focus');
  }

  canFocusObjective(questId: string, objectiveId: string): boolean {
    if (this.restoring || !this.canFocusQuest(questId)) return false;
    const def = this.questDefs.get(questId)!;
    if (def.type === 'repeatable' && !this.runInfoProvider?.(def.runArchetype!)?.activated) return false;
    return this.getQuestObjectives(questId).some(o => o.def.id === objectiveId && !o.done);
  }

  async requestFocusObjective(questId: string, objectiveId: string): Promise<boolean> {
    if (!this.canFocusObjective(questId, objectiveId)) return false;
    this.trackingRevision++;
    this.selectedObjectives.set(questId, objectiveId);
    this.setFocusedQuest(questId, 'objectiveFocus');
    this.syncObjectiveSignature();
    return true;
  }

  /** 槽的唯一写入口：去重 + 重置目标签名 + 广播 */
  private setFocusedQuest(questId: string | null, reason: string): void {
    if (this.focusedQuestId === questId) return;
    this.focusedQuestId = questId;
    this.lastObjectiveSig = this.computeObjectiveSignature();
    this.emitChanged(reason);
  }

  /** 接取时的落焦策略（三态 autoFocus，见 QuestDef.autoFocus） */
  private maybeAutoFocus(def: QuestDef, inheritFocus = false): void {
    if (def.autoFocus === false) return;
    if (def.autoFocus === true || inheritFocus) {
      this.setFocusedQuest(def.id, inheritFocus ? 'chainHandoff' : 'autoFocus');
      return;
    }
    if (this.focusedQuestId === null || !this.canFocusQuest(this.focusedQuestId)) {
      this.setFocusedQuest(def.id, 'autoFocus');
    }
  }

  /** 当前任务已不可追踪（完成 / 活计结算或被弃）时自动改选 */
  private reselectFocusIfStale(): void {
    if (this.focusedQuestId !== null && this.canFocusQuest(this.focusedQuestId)) return;
    this.setFocusedQuest(this.pickAutoFocusCandidate(), 'reselect');
  }

  /**
   * 自动改选候选。
   *
   * ⚠ **自动改选绝不改变叙事状态**：若此刻有一张活计占着叙事激活槽，就选它对应的任务
   * （纯镜像，零副作用）；否则只在一次性任务里挑（主线 > 支线，同级取最近接取）。
   * 反过来「自动去激活一张挂起的活计」会凭空推进叙事，不做。
   */
  private pickAutoFocusCandidate(): string | null {
    for (const [archetypeId, def] of this.repeatableByArchetype) {
      const run = this.runInfoProvider?.(archetypeId);
      if (run?.activated) return def.id;
    }
    let bestId: string | null = null;
    let bestPriority = Number.MAX_SAFE_INTEGER;
    let bestRecency = -1;
    this.questDefs.forEach((def, id) => {
      if (def.type === 'repeatable') return;
      if (this.questStatus.get(id) !== QuestStatus.Active) return;
      const priority = FOCUS_TYPE_PRIORITY[def.type] ?? 99;
      const recency = this.acceptOrder.indexOf(id);
      if (priority < bestPriority || (priority === bestPriority && recency > bestRecency)) {
        bestId = id;
        bestPriority = priority;
        bestRecency = recency;
      }
    });
    return bestId;
  }

  private noteAccepted(questId: string): void {
    const at = this.acceptOrder.indexOf(questId);
    if (at >= 0) this.acceptOrder.splice(at, 1);
    this.acceptOrder.push(questId);
  }

  // ---- 目标与引导（玩法文档 D7 / D8）-------------------------------------------

  getQuestObjectives(questId: string): QuestObjectiveView[] {
    const def = this.questDefs.get(questId);
    if (!def?.objectives?.length) return [];
    // 已完成的任务：目标一律视为勾掉（避免"任务已了、目标还空着"的自相矛盾）
    const questDone = def.type !== 'repeatable' && this.questStatus.get(questId) === QuestStatus.Completed;
    return def.objectives.filter(o => this.evalConditions(o.availableWhen ?? [])).map((o) => ({
      def: o,
      done: questDone || (!!o.completeWhen?.length && this.evalConditions(o.completeWhen)),
    }));
  }

  getCurrentObjective(questId: string): QuestObjectiveDef | null {
    const views = this.getQuestObjectives(questId);
    const selected = this.selectedObjectives.get(questId);
    const chosen = views.find(o => o.def.id === selected && !o.done);
    if (chosen) return chosen.def;
    for (const view of views) {
      if (view.def.optional === true) continue;
      if (!view.done) return view.def;
    }
    return null;
  }

  getQuestGuidance(questId: string): QuestGuidanceDef[] {
    const def = this.questDefs.get(questId);
    if (!def) return [];
    const objective = this.getCurrentObjective(questId);
    const guidance = objective?.guidance?.length ? objective.guidance : (def.guidance ?? []);
    return guidance.filter(g => this.evalConditions(g.conditions ?? []));
  }

  getActiveGuidance(): QuestGuidanceDef[] {
    const id = this.focusedQuestId;
    return id ? this.getQuestGuidance(id) : [];
  }

  private computeObjectiveSignature(): string {
    // 面板也展示未跟踪的任务；它们开放新线索时同样必须刷新。
    const objectives = Array.from(this.questDefs.keys()).filter(id => this.canFocusQuest(id))
      .map(id => [id, this.getCurrentObjective(id)?.id,
        this.getQuestObjectives(id).map(o => [o.def.id, o.done])]);
    return JSON.stringify([this.focusedQuestId, objectives, this.getActiveGuidance()]);
  }

  private syncObjectiveSignature(): void {
    for (const [questId, objectiveId] of this.selectedObjectives) {
      if (!this.canFocusQuest(questId) || !this.getQuestObjectives(questId)
        .some(o => o.def.id === objectiveId && !o.done)) this.selectedObjectives.delete(questId);
    }
    const sig = this.computeObjectiveSignature();
    if (sig === this.lastObjectiveSig) return;
    this.lastObjectiveSig = sig;
    this.emitChanged('objective');
  }

  // ---- 接取提示（玩法文档 D9）---------------------------------------------------

  /** 缺省档位：主线醒目横幅、其余木条（不配也有合理表现，零数据改动即生效） */
  private announceStyleOf(def: QuestDef): QuestAnnounceStyle {
    if (def.announce === 'none' || def.announce === 'toast' || def.announce === 'banner') {
      return def.announce;
    }
    return def.type === 'main' ? 'banner' : 'toast';
  }

  /**
   * 排一条接取提示。同一批（同一次 evaluate / 同一动作批）里可能进来好几条，
   * 攒到微任务末尾统一决策：至多一条走横幅，其余降级木条（玩法文档 D9 规则 2）。
   */
  private queueAnnounce(questId: string, mode: 'accept' | 'focus'): void {
    if (this.restoring) return;
    const def = this.questDefs.get(questId);
    if (!def) return;
    // focus 模式 = 动作里显式勾了「同时给醒目提示」，无条件走横幅档（策划的显式意图压过任务缺省档位）
    const style = mode === 'focus' ? 'banner' : this.announceStyleOf(def);
    if (style === 'none') return;
    const dup = this.announceBatch.findIndex((c) => c.questId === questId);
    // 同一条任务在一批里只留一条；focus 覆盖 accept（显式意图优先）。
    // ⚠ style 必须跟着一起升级：只改 mode 的话，「接取后立刻 setFocusedQuest{announce:true}」
    // 这条常见写法会保留第一次算出的 toast 档，横幅永远选不中它。
    if (dup >= 0) {
      if (mode === 'focus') {
        this.announceBatch[dup].mode = 'focus';
        this.announceBatch[dup].style = 'banner';
      }
      return;
    }
    this.announceBatch.push({
      questId,
      mode,
      style,
      order: this.questOrder.get(questId) ?? Number.MAX_SAFE_INTEGER,
      priority: FOCUS_TYPE_PRIORITY[def.type] ?? 99,
    });
    if (this.announceFlushScheduled) return;
    this.announceFlushScheduled = true;
    queueMicrotask(() => this.flushAnnounce());
  }

  private flushAnnounce(): void {
    this.announceFlushScheduled = false;
    const batch = this.announceBatch;
    this.announceBatch = [];
    if (!batch.length || this.restoring) return;

    // 想要横幅的里挑一条（主线 > 支线 > 活计，同级取数据序靠前的）；其余降级木条
    let banner: AnnounceCandidate | null = null;
    for (const c of batch) {
      if (c.style !== 'banner') continue;
      if (banner === null || c.priority < banner.priority ||
          (c.priority === banner.priority && c.order < banner.order)) {
        banner = c;
      }
    }
    for (const c of batch) {
      const def = this.questDefs.get(c.questId);
      if (!def) continue;
      const title = def.title;
      if (banner !== null && c.questId === banner.questId) {
        this.eventBus.emit('quest:announce', {
          questId: c.questId,
          title,
          mode: c.mode,
          kind: def.type === 'repeatable' ? 'job' : 'quest',
          objective: this.getCurrentObjective(c.questId)?.text ?? '',
        });
        continue;
      }
      // 降级档：走木条提示（与拾取物件同一条队列，自带压制与堆叠）
      this.eventBus.emit('notification:show', {
        text: this.strings.get(
          'notifications',
          c.mode === 'focus' ? 'questFocused' : 'questAccepted',
          { title },
        ),
        type: 'quest',
      });
    }
  }

  // ---- repeatable 镜像：活计生命周期 → HUD/通知（任务定义零条件，全部派生） ----

  private handleRunStarted(archetypeId: string): void {
    const def = this.repeatableByArchetype.get(archetypeId);
    if (!def || this.restoring) return;
    this.eventBus.emit('quest:accepted', { questId: def.id, title: def.title, repeatable: true });
    this.queueAnnounce(def.id, 'accept');
    // 槽不在这里动：applyStartRun 先发 runStarted、随后必发 runActivated，
    // 由 handleRunActivated 一处赋值（在这儿抢一次会先落到别的任务上、再被顶掉，白发一轮广播）
    this.emitChanged('runStarted');
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
    this.reselectFocusIfStale();
    this.emitChanged('runSettled');
  }

  private handleRunActivated(archetypeId: string | null, previous: string | null): void {
    if (this.restoring) return;
    // 切走的一律先取消追踪（挂起或弃置都不该占 HUD 焦点；结算路径 quest:completed 已摘除，重复摘无害）
    const prevDef = previous ? this.repeatableByArchetype.get(previous) : undefined;
    if (prevDef) this.eventBus.emit('quest:untracked', { questId: prevDef.id });
    const def = archetypeId ? this.repeatableByArchetype.get(archetypeId) : undefined;
    if (def) {
      // 活计被激活 = 玩家/剧情刚接单或切单，是很强的追踪意图：当前任务槽跟随。
      // 除非该活计被显式配了 autoFocus:false（那就只在槽空/失效时补位）。
      if (def.autoFocus === false) {
        if (this.focusedQuestId === null || !this.canFocusQuest(this.focusedQuestId)) {
          this.setFocusedQuest(def.id, 'runActivated');
        }
      } else {
        this.setFocusedQuest(def.id, 'runActivated');
      }
    } else if (prevDef && this.focusedQuestId === prevDef.id) {
      this.reselectFocusIfStale();
    }
    this.emitChanged('runActivated');
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
    const statuses: Record<string, number> = {};
    this.questStatus.forEach((s, id) => { statuses[id] = s; });
    return { statuses, focusedQuestId: this.focusedQuestId,
      ...(this.selectedObjectives.size ? { selectedObjectives: Object.fromEntries(this.selectedObjectives) } : {})
    } satisfies QuestSaveV2;
  }

  deserialize(data: Record<string, number> | QuestSaveV2): void {
    this.trackingRevision++;
    this.selectedObjectives.clear();
    // v1 是扁平的 {questId: status}，v2 包了一层并带当前任务槽。旧档照吃。
    const wrapped = data as Partial<QuestSaveV2>;
    const isV2 = !!data && typeof data === 'object' &&
      (typeof wrapped.statuses === 'object' && wrapped.statuses !== null);
    const statuses = (isV2 ? wrapped.statuses : data) as Record<string, number>;
    const savedFocus = isV2 ? (wrapped.focusedQuestId ?? null) : null;

    this.questStatus.clear();
    this.acceptOrder = [];
    for (const [id, s] of Object.entries(statuses ?? {})) {
      // 旧档遗留：已迁移为 repeatable 的任务不再有状态机，丢弃陈旧状态（活计运行态由叙事档负责）
      if (this.questDefs.get(id)?.type === 'repeatable') continue;
      this.questStatus.set(id, s as QuestStatus);
      if ((s as QuestStatus) === QuestStatus.Active) this.acceptOrder.push(id);
      this.syncFlag(id);
    }
    // 接取顺序未随档存储（questStatus 在 loadDefs 时按 quests.json 数据序播种，序列化即该序），
    // 故 acceptOrder 按数据序重建——"最近接取"在读档后退化为"数据序最后一条"，可接受。
    this.focusedQuestId = savedFocus && this.questDefs.has(savedFocus) ? savedFocus : null;
    if (isV2 && wrapped.selectedObjectives && typeof wrapped.selectedObjectives === 'object') {
      for (const [id, objectiveId] of Object.entries(wrapped.selectedObjectives)) {
        if (typeof objectiveId === 'string' && this.questDefs.get(id)?.objectives?.some(o => o.id === objectiveId)) {
          this.selectedObjectives.set(id, objectiveId);
        }
      }
    }
    // 读档后不逐条补发 quest:accepted：展示层已改为查询式，setRestoring(false) 那一条
    // quest:changed 就够重建全部显示（HUD 当前任务、面板、引导）。
  }

  destroy(): void {
    this.eventBus.off('flag:changed', this.onFlagChanged);
    this.eventBus.off('narrative:stateChanged', this.onFlagChanged);
    this.eventBus.off('time:changed', this.onFlagChanged);
    this.eventBus.off('player:posture', this.onFlagChanged);
    this.eventBus.off('narrative:runStarted', this.onRunStarted);
    this.eventBus.off('narrative:runSettled', this.onRunSettled);
    this.eventBus.off('narrative:runActivated', this.onRunActivated);
    this.eventBus.off('narrative:stateChanged', this.onRunDiscarded);
    this.questDefs.clear();
    this.questStatus.clear();
    this.questOrder.clear();
    this.repeatableByArchetype.clear();
    this.questActionTail = Promise.resolve();
    this.focusedQuestId = null;
    this.selectedObjectives.clear();
    this.trackingRevision++;
    this.acceptOrder = [];
    this.lastObjectiveSig = '';
    this.announceBatch = [];
    // 已排的 flush 微任务醒来时 batch 已空、restoring 未变，走空转即返回；
    // 但标志必须清，否则 destroy→init 后第一条提示会因为"以为还排着"而永不 flush。
    this.announceFlushScheduled = false;
    // ⚠ 刻意**不清** runInfoProvider / activateRunHandler / conditionCtxFactory：
    // 它们是组装层在 init 之外一次性接的线，不是本系统持有的资源。清掉的话
    // 「destroy 后再 init」会变成一个哑掉的实例（norms 不变量 5 要求两者行为一致）。
  }
}
