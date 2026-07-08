import type { EventBus } from '../core/EventBus';
import type { FlagStore } from '../core/FlagStore';
import type { ActionExecutor } from '../core/ActionExecutor';
import type { AssetManager } from '../core/AssetManager';
import type { SceneManager } from './SceneManager';
import type { RulesManager } from './RulesManager';
import type { QuestManager } from './QuestManager';
import type { InventoryManager } from './InventoryManager';
import type { StringsProvider } from '../core/StringsProvider';
import type { ScenarioStateManager } from '../core/ScenarioStateManager';
import { dialogueGraphJsonUrl } from '../core/projectPaths';
import type {
  ActionDef,
  DialogueChoice,
  DialogueEndPayload,
  DialogueGraphFile,
  DialogueGraphNodeDef,
  DialogueGraphSpeaker,
  DialogueLine,
  DialogueLinePayload,
  DialogueStartPayload,
  IGameSystem,
  GameContext,
} from '../data/types';
import {
  evaluateConditionExpr,
  evaluateConditionExprWithTrace,
  evaluatePreconditionsWithTrace,
  formatConditionTrace,
  resolveNarrativeGraphRef,
  type ConditionEvalContext,
  type ConditionTrace,
} from './graphDialogue/evaluateGraphCondition';

/** 最近一次图 preconditions 解算（调试用） */
export interface NarrativePreconditionDebug {
  graphId: string;
  satisfied: boolean;
  traceText: string;
}

/** 最近一次 switch 节点分支尝试顺序与条件树（调试用） */
export interface NarrativeSwitchDebug {
  graphSourceId: string;
  nodeId: string;
  defaultNext: string;
  chosenNext: string;
  casesTried: Array<{
    index: number;
    next: string;
    matched: boolean;
    traceText: string;
  }>;
}

/**
 * 图对话运行时：语义上**严格串行**（上一拍结束再进下一拍）。使用 Promise/async 是因为加载资源、
 * 部分 Action（如 waitClickContinue）在 JS 中只能异步完成，**并非**多段剧情并行。
 *
 * **防乱**：凡 `advance` / `chooseOption` / `startDialogueGraph` 一律经 `runExclusive` 排队，同一时刻最多
 * 一条执行链；`drainUntilBlocking` 内 `while` 顺序前进，仅在 `await executeAwait` / `await loadJson` 处让出线程。
 */
export class GraphDialogueManager implements IGameSystem {
  /** R8：drainUntilBlocking 单次最多推进的节点步数——纯路由环（switch/ownerState/contextState/
   *  runActions 的 next 连成环）会同步 while 死循环冻死主线程，数据校验抓不到图内连边成环，
   *  此上限是最后防线（超限强制收束，软失败优于冻死页面）。 */
  private static readonly MAX_DRAIN_STEPS_PER_RUN = 1000;

  private eventBus: EventBus;
  private flagStore: FlagStore;
  private actionExecutor: ActionExecutor;
  private assetManager: AssetManager;
  private sceneManager: SceneManager;
  private rulesManager: RulesManager;
  private questManager: QuestManager;
  private inventoryManager: InventoryManager;
  private scenarioState: ScenarioStateManager;
  private strings: StringsProvider | null = null;
  private resolveDisplay: ((s: string) => string) | null = null;
  private conditionCtxFactory: (() => ConditionEvalContext) | null = null;

  private graph: DialogueGraphFile | null = null;
  /** 加载时使用的 graphId（文件名），与 JSON 内 `id` 可能不一致时仍以路径为准 */
  private graphSourceId: string = '';
  private currentNodeId: string = '';
  private active = false;
  private npcName: string = '';
  private npcId: string = '';
  /** 本会话是否压暗场景背景（随行下发 DialogueUI）；默认不压 */
  private dimBackground: boolean = false;
  private ownerType: string = '';
  private ownerId: string = '';
  /** 串行化 advance / chooseOption / start，避免异步 drain 期间丢弃重复点击或重入 */
  private opChain: Promise<void> = Promise.resolve();

  /** choice：`prompt` 已展示 prompt 行，等待 advance 出选项；`options` 已展示选项 */
  private choicePhase: null | { nodeId: string; stage: 'prompt' | 'options' } = null;
  /** 已展示 `line` 节点台词，等待玩家点击后再 `prepareBeat` 并进入 `next` */
  private awaitingLineDismiss = false;
  /** `line` 节点多拍时当前拍索引（单拍 legacy 恒为 0） */
  private lineBeatIndex = 0;
  /** `drainUntilBlocking` 在 await 中仍 >0，供 advance/choose 重入，避免与 opChain 死锁 */
  private drainDepth = 0;
  /** `endDialogue` 后应跳过的已排队 op 代际 */
  private opDrainGeneration = 0;
  /** 在 drain 内通过 Action 请求嵌套开图时，于当前图 `dialogue:end` 之后按序启动（立即 resolve，避免阻塞 runActions） */
  private deferredGraphQueue: Array<{
    graphId: string;
    entry?: string;
    npcName: string;
    npcId?: string;
    ownerType?: string;
    ownerId?: string;
    /** true 时加载图后优先使用 `meta.title` 作为对话显示名（Inspect 看板等） */
    preferGraphMetaTitle?: boolean;
    dimBackground?: boolean;
  }> = [];
  /** deferred 链式接续 runner 是否在跑（同一时刻至多一个，避免双循环并发消费队列） */
  private chainRunnerActive = false;
  /** endDialogue 已发 willContinue=true、下一张图尚未 active 的空窗期：
   *  供发起方（InteractionCoordinator / Game）判断「会话链尚未真正终结」，不得提前收尾/恢复 Exploring */
  private chainContinuationPending = false;
  /** 最近一次发出的 graph `dialogue:end` 是否带 willContinue=true——链条全部接续失败时据此补发
   *  恰好一次 willContinue=false 的最终 end，保证状态恢复不悬空也不重复 */
  private lastGraphEndWasContinuing = false;

  private lastPreconditionDebug: NarrativePreconditionDebug | null = null;
  private lastSwitchDebug: NarrativeSwitchDebug | null = null;
  /** F2 叙事调试：从本次开图的入口节点到当前节点经过的节点 id（含入口与当前） */
  private narrativeRouteNodeIds: string[] = [];

  constructor(
    eventBus: EventBus,
    flagStore: FlagStore,
    actionExecutor: ActionExecutor,
    assetManager: AssetManager,
    sceneManager: SceneManager,
    rulesManager: RulesManager,
    questManager: QuestManager,
    inventoryManager: InventoryManager,
    scenarioState: ScenarioStateManager,
  ) {
    this.eventBus = eventBus;
    this.flagStore = flagStore;
    this.actionExecutor = actionExecutor;
    this.assetManager = assetManager;
    this.sceneManager = sceneManager;
    this.rulesManager = rulesManager;
    this.questManager = questManager;
    this.inventoryManager = inventoryManager;
    this.scenarioState = scenarioState;
  }

  setConditionEvalContextFactory(factory: (() => ConditionEvalContext) | null): void {
    this.conditionCtxFactory = factory;
  }

  /** F2 叙事调试：最近一次 preconditions / switch 的解算路径与当前图节点 */
  getNarrativeEvalDebug(): {
    active: boolean;
    graphSourceId: string;
    currentNodeId: string;
    lastPrecondition: NarrativePreconditionDebug | null;
    lastSwitch: NarrativeSwitchDebug | null;
    summaryText: string;
  } {
    const parts: string[] = [];
    if (this.narrativeRouteNodeIds.length > 0) {
      parts.push(`【节点路由】${this.narrativeRouteNodeIds.join(' -> ')}`);
    } else {
      parts.push('【节点路由】（尚无记录，或未在对话中）');
    }
    parts.push(`对话进行中: ${this.active ? '是' : '否'}`);
    parts.push(`图(graphSourceId): ${this.graphSourceId || '—'}`);
    parts.push(`当前节点: ${this.currentNodeId || '—'}`);
    parts.push('');
    if (this.lastPreconditionDebug) {
      parts.push('【最近·图 preconditions】');
      parts.push(`图: ${this.lastPreconditionDebug.graphId}`);
      parts.push(`满足: ${this.lastPreconditionDebug.satisfied}`);
      parts.push(this.lastPreconditionDebug.traceText);
      parts.push('');
    } else {
      parts.push('【最近·图 preconditions】（尚无记录）');
      parts.push('');
    }
    if (this.lastSwitchDebug) {
      parts.push('【最近·switch】');
      parts.push(`节点: ${this.lastSwitchDebug.nodeId}`);
      parts.push(`选中 next: ${this.lastSwitchDebug.chosenNext}（defaultNext=${this.lastSwitchDebug.defaultNext}）`);
      for (const c of this.lastSwitchDebug.casesTried) {
        parts.push(`— case[${c.index}] -> ${c.next}命中=${c.matched}`);
        parts.push(c.traceText.split('\n').map((ln) => `    ${ln}`).join('\n'));
      }
    } else {
      parts.push('【最近·switch】（尚无记录）');
    }
    return {
      active: this.active,
      graphSourceId: this.graphSourceId,
      currentNodeId: this.currentNodeId,
      lastPrecondition: this.lastPreconditionDebug,
      lastSwitch: this.lastSwitchDebug,
      summaryText: parts.join('\n'),
    };
  }

  private conditionCtx(): ConditionEvalContext {
    const injected = this.conditionCtxFactory?.();
    // 对话内的 `@owner` 应指当前对话 owner（NPC/热区/场景），覆盖注入 ctx 里的场景级 currentOwner。
    const ownerType = this.ownerType.trim();
    const ownerId = this.ownerId.trim();
    const currentOwner = ownerType && ownerId ? { ownerType, ownerId } : undefined;
    if (injected) {
      return currentOwner ? { ...injected, currentOwner } : injected;
    }
    return {
      flagStore: this.flagStore,
      questManager: this.questManager,
      scenarioState: this.scenarioState,
      resolveConditionLiteral: (raw) => this.r(raw),
      currentOwner,
    };
  }

  private pushNarrativeRouteStep(nodeId: string): void {
    if (!nodeId) return;
    this.narrativeRouteNodeIds.push(nodeId);
  }

  private runExclusive(fn: () => Promise<void>): Promise<void> {
    const prev = this.opChain;
    const genAtSchedule = this.opDrainGeneration;
    let release!: () => void;
    const next = new Promise<void>((res) => { release = res; });
    this.opChain = next;
    return prev
      .then(async () => {
        if (genAtSchedule !== this.opDrainGeneration) return;
        await fn();
      })
      .catch((e) => console.warn('GraphDialogueManager: op failed', e))
      .finally(() => { release(); });
  }

  /** advance / choose：在 drain 的 await 间隙可立即执行，避免与外层 opChain 死锁 */
  private runUserOp(fn: () => Promise<void>): Promise<void> {
    if (this.drainDepth > 0) {
      return Promise.resolve()
        .then(fn)
        .catch((e) => console.warn('GraphDialogueManager: op failed', e));
    }
    return this.runExclusive(fn);
  }

  init(ctx: GameContext): void {
    this.strings = ctx.strings;
  }

  setResolveDisplay(fn: ((s: string) => string) | null): void {
    this.resolveDisplay = fn;
  }

  private r(s: string): string {
    return this.resolveDisplay ? this.resolveDisplay(s) : s;
  }

  update(_dt: number): void {}

  serialize(): object {
    /** 存读档收敛（serialize/deserialize 对称）：进行中的图对话是 transient 会话，不入档——
     *  存档在 Dialogue 态本被 canSave 禁止，正常玩家路径存档时无活跃会话；
     *  本系统亦无其它需持久化的静态数据。 */
    return { active: false };
  }

  deserialize(_data: object): void {
    /** 静默收束任何活跃会话：**不发 dialogue:end**——避免读档瞬间触发 EventBridge 状态切换
     *  与结束音效。Dialogue 态不可开菜单存读档，dev 命令路径读档时静默丢弃会话即可。 */
    this.deferredGraphQueue.length = 0;
    this.chainContinuationPending = false;
    this.lastGraphEndWasContinuing = false;
    this.resetSessionFields();
  }

  get isActive(): boolean {
    return this.active;
  }

  /** endDialogue 已排定 deferred 链式接续、但下一张图尚未 active 的空窗期。
   *  发起方在 startDialogueGraph 返回后若见 `!isActive && hasPendingChainContinuation`，
   *  说明会话链仍在接续中，不得按「启动失败」提前恢复 Exploring / 收尾。 */
  get hasPendingChainContinuation(): boolean {
    return this.chainContinuationPending;
  }

  getDebugInteractionState(): {
    active: boolean;
    graphSourceId: string;
    currentNodeId: string;
    choiceStage: 'none' | 'prompt' | 'options';
    awaitingLineDismiss: boolean;
  } {
    return {
      active: this.active,
      graphSourceId: this.graphSourceId,
      currentNodeId: this.currentNodeId,
      choiceStage: this.choicePhase?.stage ?? 'none',
      awaitingLineDismiss: this.awaitingLineDismiss,
    };
  }

  /** 玩家视角：当前对话的可感知内容（说话人/正文/可见选项），不含 node id 等幕后信息。
   *  text 直接从当前 line 节点解析；choices 复用 buildChoicesForNode（selectable=玩家看到的置灰与否）。 */
  getPlayerDialogue(): {
    active: boolean;
    speaker: string;
    text: string;
    awaitingAdvance: boolean;
    choices: Array<{ index: number; text: string; selectable: boolean }>;
  } {
    if (!this.active || !this.graph) {
      return { active: false, speaker: '', text: '', awaitingAdvance: false, choices: [] };
    }
    let choices: Array<{ index: number; text: string; selectable: boolean }> = [];
    if (this.choicePhase?.stage === 'options') {
      const cnode = this.graph.nodes[this.choicePhase.nodeId];
      if (cnode && cnode.type === 'choice') {
        choices = this.buildChoicesForNode(cnode).map((c) => ({
          index: c.index, text: c.text, selectable: c.enabled,
        }));
      }
    }
    let text = '';
    const cur = this.graph.nodes[this.currentNodeId];
    if (cur && cur.type === 'line') {
      const beats = this.lineBeatsFor(cur);
      const beat = beats[Math.min(this.lineBeatIndex, beats.length - 1)];
      if (beat) text = this.linePayloadToDialogueLine(beat).text ?? '';
    }
    return {
      active: true,
      speaker: this.npcName,
      text,
      awaitingAdvance: this.awaitingLineDismiss,
      choices,
    };
  }

  /** 只读：当前对话视图（活跃图/节点/选项列表），供调试快照做数据驱动的"盲操作"。
   *  choices 复用 buildChoicesForNode，其 index/text/enabled 与 debugChooseOption 完全一致。 */
  getDialogueViewDebug(): {
    active: boolean;
    graphId: string;
    npcName: string;
    nodeId: string;
    nodeType: string | null;
    choiceStage: 'none' | 'prompt' | 'options';
    choices: Array<{ index: number; text: string; enabled: boolean }>;
  } {
    if (!this.active || !this.graph) {
      return {
        active: false, graphId: '', npcName: '', nodeId: '',
        nodeType: null, choiceStage: 'none', choices: [],
      };
    }
    let choices: Array<{ index: number; text: string; enabled: boolean }> = [];
    if (this.choicePhase?.stage === 'options') {
      const cnode = this.graph.nodes[this.choicePhase.nodeId];
      if (cnode && cnode.type === 'choice') {
        choices = this.buildChoicesForNode(cnode).map((c) => ({
          index: c.index, text: c.text, enabled: c.enabled,
        }));
      }
    }
    const node = this.graph.nodes[this.currentNodeId];
    return {
      active: true,
      graphId: this.graphSourceId || this.graph.id,
      npcName: this.npcName,
      nodeId: this.currentNodeId,
      nodeType: node?.type ?? null,
      choiceStage: this.choicePhase?.stage ?? 'none',
      choices,
    };
  }

  /** startDialogueGraph 传入的 npcId（trim）；未开图对话时为空串。供 playScriptedDialogue 的 {{npc}} 解析。 */
  getContextNpcId(): string {
    return this.npcId.trim();
  }

  destroy(): void {
    this.deferredGraphQueue.length = 0;
    this.chainContinuationPending = false;
    this.lastGraphEndWasContinuing = false;
    if (this.active) {
      this.endDialogue();
    } else {
      /** B18：非活跃但可能有在途 startDialogueGraph（图 JSON 加载中）——
       *  推进代际使其归来即弃（不发 dialogue:start、不 drain） */
      this.opDrainGeneration++;
      this.opChain = Promise.resolve();
    }
    this.strings = null;
  }

  async startDialogueGraph(params: {
    graphId: string;
    entry?: string;
    npcName: string;
    npcId?: string;
    ownerType?: string;
    ownerId?: string;
    preferGraphMetaTitle?: boolean;
    /** 本次对话压暗场景背景（startDialogueGraph 动作可选项）；默认不压 */
    dimBackground?: boolean;
  }): Promise<void> {
    const gid = params.graphId?.trim();
    if (!gid) return Promise.resolve();

    if (this.drainDepth > 0 && this.active) {
      this.deferredGraphQueue.push({
        graphId: gid,
        entry: params.entry?.trim() || undefined,
        npcName: params.npcName,
        npcId: params.npcId?.trim() || undefined,
        ownerType: params.ownerType?.trim() || undefined,
        ownerId: params.ownerId?.trim() || params.npcId?.trim() || undefined,
        preferGraphMetaTitle: params.preferGraphMetaTitle === true,
        dimBackground: params.dimBackground === true,
      });
      return Promise.resolve();
    }

    return this.runExclusive(async () => {
      if (this.active) {
        console.warn('GraphDialogueManager: 已有对话进行中，忽略重复 start');
        return;
      }

      const genAtStart = this.opDrainGeneration;
      const path = dialogueGraphJsonUrl(gid);
      let raw: DialogueGraphFile;
      try {
        raw = await this.assetManager.loadJson<DialogueGraphFile>(path);
      } catch (e) {
        console.warn(`GraphDialogueManager: 无法加载 ${path}`, e);
        return;
      }

      /** B18：加载期间 destroy / deserialize / endDialogue 已推进代际——
       *  本次开图归来即弃，不发 dialogue:start、不 drain */
      if (genAtStart !== this.opDrainGeneration) return;

      if (!raw.nodes || typeof raw.entry !== 'string' || !raw.nodes[raw.entry]) {
        console.warn(`GraphDialogueManager: 图 ${gid} 缺少 entry 或 nodes`);
        return;
      }

      const rid = typeof raw.id === 'string' ? raw.id.trim() : '';
      if (rid && rid !== gid) {
        console.warn(`GraphDialogueManager: 图 JSON id "${rid}" 与路径 graphId "${gid}" 不一致，以路径为准继续`);
      }

      this.lastSwitchDebug = null;

      const preCtx = this.conditionCtx();
      const preTrace = evaluatePreconditionsWithTrace(raw.preconditions, preCtx);
      this.lastPreconditionDebug = {
        graphId: gid,
        satisfied: preTrace.result,
        traceText: formatConditionTrace(preTrace.trace),
      };
      if (!preTrace.result) {
        console.warn(`GraphDialogueManager: 图 ${gid} preconditions 不满足`);
        return;
      }

      this.graph = raw;
      this.graphSourceId = gid;
      const metaTitle =
        raw.meta && typeof raw.meta === 'object' && typeof raw.meta.title === 'string'
          ? raw.meta.title.trim()
          : '';
      const useMeta = params.preferGraphMetaTitle === true && metaTitle.length > 0;
      this.npcName = useMeta ? metaTitle : params.npcName;
      this.npcId = params.npcId?.trim() ?? '';
      this.ownerType = params.ownerType?.trim() || (this.npcId ? 'npc' : '');
      this.ownerId = params.ownerId?.trim() || this.npcId;
      this.dimBackground = params.dimBackground === true;
      this.currentNodeId = (params.entry?.trim() && raw.nodes[params.entry.trim()])
        ? params.entry.trim()
        : raw.entry;
      this.narrativeRouteNodeIds = this.currentNodeId ? [this.currentNodeId] : [];
      this.active = true;
      this.choicePhase = null;
      this.awaitingLineDismiss = false;
      this.lineBeatIndex = 0;

      this.eventBus.emit('dialogue:start', {
        npcName: this.npcName,
        graphId: gid,
        source: 'graph',
      } satisfies DialogueStartPayload);
      await this.drainUntilBlocking();
    });
  }

  async advance(): Promise<void> {
    return this.runUserOp(async () => {
      /** 显式「可接受用户推进」检查：仅「台词待点击确认」与「choice prompt 待展开」两态接受。
       *  runActions await 间隙（drain 进行中）、选项已展示等状态下注入的 advance（正常输入不可达，
       *  调试/脚本通道可达）一律忽略，杜绝与在途 drain 并发重跑 runActions。 */
      if (!this.active || !this.graph) return;
      if (!this.awaitingLineDismiss && this.choicePhase?.stage !== 'prompt') return;
      await this.advanceCore();
    });
  }

  private async advanceCore(): Promise<void> {
    if (!this.active || !this.graph) return;

    if (this.choicePhase?.stage === 'prompt') {
      this.showChoiceOptionsFromPrompt();
      return;
    }

    if (this.awaitingLineDismiss) {
      this.awaitingLineDismiss = false;
      const cur = this.graph.nodes[this.currentNodeId];
      if (cur?.type === 'line') {
        const beats = this.lineBeatsFor(cur);
        if (this.lineBeatIndex + 1 < beats.length) {
          this.lineBeatIndex += 1;
          const line = this.linePayloadToDialogueLine(beats[this.lineBeatIndex]!);
          this.eventBus.emit('dialogue:line', line);
          this.awaitingLineDismiss = true;
          const nextAfterLine = this.graph.nodes[cur.next];
          if (this.lineBeatIndex === beats.length - 1 && nextAfterLine?.type === 'end') {
            this.eventBus.emit('dialogue:willEnd', {});
          }
          return;
        }
        this.lineBeatIndex = 0;
        const nextAfterLine = this.graph.nodes[cur.next];
        if (nextAfterLine?.type !== 'runActions') {
          this.eventBus.emit('dialogue:prepareBeat', {});
        }
        this.currentNodeId = cur.next;
        this.pushNarrativeRouteStep(this.currentNodeId);
        await this.drainUntilBlocking();
      } else if (cur?.type === 'end') {
        /** 兼容：若仍停留在 end 节点上收到 advance（旧行为曾发占位行），直接收束 */
        this.endDialogue();
      }
      return;
    }

    const head = this.graph.nodes[this.currentNodeId];
    if (head?.type !== 'runActions') {
      this.eventBus.emit('dialogue:prepareBeat', {});
    }
    await this.drainUntilBlocking();
  }

  async chooseOption(index: number): Promise<void> {
    return this.runUserOp(async () => {
      if (!this.active || !this.graph || this.choicePhase?.stage !== 'options') return;

      const node = this.graph.nodes[this.choicePhase.nodeId];
      if (!node || node.type !== 'choice') return;

      const opt = node.options[index];
      if (!opt) return;

      const built = this.buildChoicesForNode(node);
      const bc = built[index];
      if (!bc?.enabled) return;

      // 扣除该选项标注的铜钱花费。buildChoicesForNode 仅据此置灰门槛，真正扣减在此处，
      // 否则 costCoins 选项实为“免费”。与背包铜钱一致，走 InventoryManager。
      const cost = opt.costCoins;
      if (typeof cost === 'number' && cost > 0) {
        this.inventoryManager.removeCoins(cost);
      }

      this.eventBus.emit('dialogue:choiceSelected:log', { index, text: bc.text });
      this.choicePhase = null;
      this.currentNodeId = opt.next;
      this.pushNarrativeRouteStep(this.currentNodeId);
      await this.advanceCore();
    });
  }

  async debugAdvanceUntilBlocking(maxSteps: number = 24): Promise<{
    steps: number;
    active: boolean;
    currentNodeId: string;
    choiceStage: 'none' | 'prompt' | 'options';
  }> {
    const limit = Math.max(1, Math.min(200, Math.trunc(maxSteps || 24)));
    let steps = 0;
    for (let i = 0; i < limit; i++) {
      const before = this.getDebugInteractionState();
      if (!before.active || before.choiceStage === 'options') break;
      await this.advance();
      steps += 1;
      const after = this.getDebugInteractionState();
      if (!after.active || after.choiceStage === 'options') break;
      if (
        after.currentNodeId === before.currentNodeId &&
        after.choiceStage === before.choiceStage &&
        after.awaitingLineDismiss === before.awaitingLineDismiss
      ) {
        break;
      }
    }
    const finalState = this.getDebugInteractionState();
    return {
      steps,
      active: finalState.active,
      currentNodeId: finalState.currentNodeId,
      choiceStage: finalState.choiceStage,
    };
  }

  async debugChooseOption(params: { index?: number; text?: string }): Promise<boolean> {
    if (!this.active || !this.graph) return false;
    if (this.choicePhase?.stage === 'prompt') {
      await this.advance();
    }
    if (!this.active || !this.graph || this.choicePhase?.stage !== 'options') return false;
    const node = this.graph.nodes[this.choicePhase.nodeId];
    if (!node || node.type !== 'choice') return false;
    const choices = this.buildChoicesForNode(node);
    let index = Number.isFinite(params.index) ? Math.trunc(params.index as number) : -1;
    if (index < 0 && params.text?.trim()) {
      const needle = this.normalizeChoiceText(params.text);
      const exact = choices.find((choice) => this.normalizeChoiceText(choice.text) === needle && choice.enabled);
      const partial = exact ?? choices.find((choice) => this.normalizeChoiceText(choice.text).includes(needle) && choice.enabled);
      index = partial?.index ?? -1;
    }
    if (index < 0 || index >= choices.length || !choices[index]?.enabled) return false;
    await this.chooseOption(index);
    return true;
  }

  endDialogue(): void {
    if (!this.active) return;
    this.resetSessionFields();
    /** R5/R6 根因：dialogue:end 带来源与接续标记。willContinue=true 表示 deferred 链上还有图
     *  将立即接续（此 end 非最外层结束）——EventBridge 不恢复 Exploring、InteractionCoordinator
     *  不收尾、AudioManager 不播结束音效，接续图全程保持 Dialogue 态播放。 */
    const willContinue = this.deferredGraphQueue.length > 0;
    this.lastGraphEndWasContinuing = willContinue;
    this.eventBus.emit('dialogue:end', {
      source: 'graph',
      willContinue,
    } satisfies DialogueEndPayload);
    if (!willContinue) return;
    /** runner 内同步完结的图触发的 endDialogue 不再另起 runner（由在跑的 runner 继续消费队列）；
     *  亦不可包 runExclusive：否则与 startDialogueGraph 内部的 runExclusive 互相等待死锁 */
    if (this.chainRunnerActive) return;
    this.chainContinuationPending = true;
    void this.runDeferredChainContinuation();
  }

  /** 会话字段复位（不发事件、不动 deferred 队列与链式标记）：endDialogue 与 deserialize 静默收束共用 */
  private resetSessionFields(): void {
    this.active = false;
    this.graph = null;
    this.graphSourceId = '';
    this.currentNodeId = '';
    this.npcName = '';
    this.npcId = '';
    this.ownerType = '';
    this.ownerId = '';
    this.dimBackground = false;
    this.choicePhase = null;
    this.lastPreconditionDebug = null;
    this.lastSwitchDebug = null;
    this.narrativeRouteNodeIds = [];
    this.awaitingLineDismiss = false;
    this.lineBeatIndex = 0;
    this.opDrainGeneration++;
    this.opChain = Promise.resolve();
  }

  /** deferred 链式接续：按序尝试启动排队图。全部接续项都未能启动（加载失败 / preconditions
   *  不满足）时，链条实际已终结，补发**恰好一次** willContinue=false 的最终 dialogue:end，
   *  避免 willContinue=true 之后无人恢复状态、卡死在 Dialogue（R6 的失败分支兜底）。 */
  private async runDeferredChainContinuation(): Promise<void> {
    this.chainRunnerActive = true;
    try {
      while (!this.active && this.deferredGraphQueue.length > 0) {
        const item = this.deferredGraphQueue.shift()!;
        await this.startDialogueGraph(item);
      }
    } catch (e) {
      console.warn('GraphDialogueManager: 衔接嵌套图失败', e);
    } finally {
      this.chainRunnerActive = false;
      this.chainContinuationPending = false;
    }
    if (!this.active && this.lastGraphEndWasContinuing) {
      this.lastGraphEndWasContinuing = false;
      this.eventBus.emit('dialogue:end', {
        source: 'graph',
        willContinue: false,
      } satisfies DialogueEndPayload);
    }
  }

  private async drainUntilBlocking(): Promise<void> {
    if (!this.active || !this.graph) return;
    this.drainDepth++;
    let steps = 0;
    try {
      while (this.active && this.graph) {
      /** R8：纯路由环护栏（见 MAX_DRAIN_STEPS_PER_RUN 注释）——超限记 error 并强制收束 */
      if (++steps > GraphDialogueManager.MAX_DRAIN_STEPS_PER_RUN) {
        console.error(
          `GraphDialogueManager: 图 ${this.graphSourceId} 单次推进超过 ${GraphDialogueManager.MAX_DRAIN_STEPS_PER_RUN} 步，` +
            `疑似路由成环（当前节点 ${this.currentNodeId}，近路由 ${this.narrativeRouteNodeIds.slice(-8).join(' -> ')}），强制结束对话`,
        );
        this.endDialogue();
        return;
      }
      const node = this.graph.nodes[this.currentNodeId];
      if (!node) {
        console.warn(`GraphDialogueManager: 缺失节点 ${this.currentNodeId}`);
        this.endDialogue();
        return;
      }

      if (node.type === 'switch') {
        this.currentNodeId = this.evalSwitch(node);
        this.pushNarrativeRouteStep(this.currentNodeId);
        continue;
      }

      if (node.type === 'ownerState') {
        this.currentNodeId = this.evalOwnerState(node);
        this.pushNarrativeRouteStep(this.currentNodeId);
        continue;
      }

      if (node.type === 'contextState') {
        this.currentNodeId = this.evalContextState(node);
        this.pushNarrativeRouteStep(this.currentNodeId);
        continue;
      }

      if (node.type === 'runActions') {
        this.eventBus.emit('dialogue:hidePanel', {});
        try {
          for (const a of node.actions) {
            await this.actionExecutor.executeAwait(a as ActionDef);
          }
        } catch (e) {
          console.warn('GraphDialogueManager: runActions 执行失败，结束对话', e);
          this.endDialogue();
          return;
        }
        this.currentNodeId = node.next;
        this.pushNarrativeRouteStep(this.currentNodeId);
        continue;
      }

      if (node.type === 'line') {
        this.lineBeatIndex = 0;
        const beats = this.lineBeatsFor(node);
        const first = beats[0];
        if (!first) {
          console.warn(`GraphDialogueManager: line 节点无可用台词 ${this.currentNodeId}`);
          this.endDialogue();
          return;
        }
        const line = this.linePayloadToDialogueLine(first);
        this.eventBus.emit('dialogue:line', line);
        this.awaitingLineDismiss = true;
        const next = this.graph.nodes[node.next];
        if (beats.length === 1 && next?.type === 'end') {
          this.eventBus.emit('dialogue:willEnd', {});
        }
        if (beats.length > 1 && next?.type === 'end') {
          /** 多拍时仅在最后一拍展示后结束；willEnd 在点到最后一拍时再发（见 advanceCore） */
        }
        return;
      }

      if (node.type === 'choice') {
        if (node.promptLine) {
          this.choicePhase = { nodeId: this.currentNodeId, stage: 'prompt' };
          const line = this.linePayloadToDialogueLine(node.promptLine);
          this.eventBus.emit('dialogue:line', line);
          this.awaitingLineDismiss = true;
          return;
        }
        /** 无 prompt 的选项：直出前先清底栏（与有上一句 line 时的 prepareBeat 语义对齐） */
        this.eventBus.emit('dialogue:prepareBeat', {});
        this.choicePhase = { nodeId: this.currentNodeId, stage: 'options' };
        this.emitChoicesForNode(node);
        return;
      }

      if (node.type === 'end') {
        /** 收束标记：不播占位台词，直接结束（避免多一次「旁白+空白」点击） */
        this.endDialogue();
        return;
      }

      console.warn('GraphDialogueManager: 未知节点类型，结束对话', this.currentNodeId, node);
      this.endDialogue();
      return;
    }
    } finally {
      this.drainDepth--;
    }
  }

  private showChoiceOptionsFromPrompt(): void {
    if (!this.graph || !this.choicePhase || this.choicePhase.stage !== 'prompt') return;
    const node = this.graph.nodes[this.choicePhase.nodeId];
    if (!node || node.type !== 'choice') return;
    this.awaitingLineDismiss = false;
    this.choicePhase = { nodeId: this.choicePhase.nodeId, stage: 'options' };
    this.emitChoicesForNode(node);
  }

  private inventoryCoinsForChoice(): number {
    return this.inventoryManager.getCoins();
  }

  private emitChoicesForNode(node: Extract<DialogueGraphNodeDef, { type: 'choice' }>): void {
    const choices = this.buildChoicesForNode(node);
    /** D6 坏数据兜底：选项为空或全部被条件/花费置灰时，玩家在选项界面无任何可推进入口（软锁）。
     *  记 error 并优雅收束对话——软失败优于冻死；正确修法是数据侧保证至少一个无条件出口。 */
    if (choices.length === 0 || choices.every((c) => !c.enabled)) {
      console.error(
        `GraphDialogueManager: choice 节点 ${this.currentNodeId}（图 ${this.graphSourceId}）无可选选项，强制结束对话`,
      );
      this.endDialogue();
      return;
    }
    this.eventBus.emit('dialogue:choices', choices);
  }

  private buildChoicesForNode(node: Extract<DialogueGraphNodeDef, { type: 'choice' }>): DialogueChoice[] {
    const s = this.strings;
    const ctx = this.conditionCtx();
    return node.options.map((opt, i) => {
      const requireKey = opt.requireFlag?.trim() || undefined;
      let reqExprOk = true;
      if (opt.requireCondition !== undefined && opt.requireCondition !== null) {
        reqExprOk = evaluateConditionExpr(opt.requireCondition, ctx);
      }
      const reqOk =
        reqExprOk &&
        (requireKey === undefined ||
          this.flagStore.checkConditions([{ flag: requireKey, op: '!=', value: false }]));
      const costAmount = opt.costCoins;
      const coins = this.inventoryCoinsForChoice();
      const costOk = costAmount === undefined || coins >= costAmount;
      const enabled = reqOk && costOk;
      const customHint = !enabled && opt.disabledClickHint?.trim() ? opt.disabledClickHint.trim() : undefined;
      const autoHint = enabled
        ? undefined
        : this.buildChoiceDisableHint(
            {
              requireKey,
              reqOk,
              reqExprOk,
              costAmount,
              costOk,
              ruleHintId: opt.ruleHintId,
            },
            s,
          );
      const disableHint = customHint ?? autoHint;

      return {
        index: i,
        text: this.r(opt.text),
        tags: [],
        enabled,
        ruleHintId: opt.ruleHintId,
        disableHint: disableHint ? this.r(disableHint) : undefined,
      };
    });
  }

  private buildChoiceDisableHint(
    args: {
      requireKey: string | undefined;
      reqOk: boolean;
      reqExprOk: boolean;
      costAmount: number | undefined;
      costOk: boolean;
      ruleHintId: string | undefined;
    },
    s: StringsProvider | null,
  ): string | undefined {
    if (!s) return undefined;
    if (!args.reqExprOk) {
      return s.get('dialogue', 'choiceFlagLocked');
    }
    if (!args.reqOk && args.requireKey) {
      if (args.ruleHintId) {
        const def = this.rulesManager.getRuleDef(args.ruleHintId);
        const name = def?.name ?? args.ruleHintId;
        return s.get('dialogue', 'choiceNeedRule', { name });
      }
      return s.get('dialogue', 'choiceFlagLocked');
    }
    if (!args.costOk && args.costAmount !== undefined) {
      return s.get('dialogue', 'choiceNeedCoins', { amount: args.costAmount });
    }
    return undefined;
  }

  private normalizeChoiceText(text: string): string {
    return this.r(text).replace(/\s+/g, '').trim().toLowerCase();
  }

  private evalSwitch(node: Extract<DialogueGraphNodeDef, { type: 'switch' }>): string {
    const ctx = this.conditionCtx();
    const casesTried: NarrativeSwitchDebug['casesTried'] = [];
    let chosen = node.defaultNext;
    for (let i = 0; i < node.cases.length; i++) {
      const c = node.cases[i]!;
      let trace: ConditionTrace;
      let ok: boolean;
      /** JSON 中 `condition: null` 须视为未写，否则 null !== undefined 会误判并忽略 conditions */
      if (c.condition != null) {
        const r = evaluateConditionExprWithTrace(c.condition, ctx);
        ok = r.result;
        trace = r.trace;
      } else {
        const conds = c.conditions ?? [];
        const r = evaluateConditionExprWithTrace(
          conds.length <= 1 ? (conds[0] ?? { all: [] }) : { all: conds },
          ctx,
        );
        ok = r.result;
        trace = r.trace;
      }
      casesTried.push({
        index: i,
        next: c.next,
        matched: ok,
        traceText: formatConditionTrace(trace),
      });
      if (ok) {
        chosen = c.next;
        break;
      }
    }
    this.lastSwitchDebug = {
      graphSourceId: this.graphSourceId,
      nodeId: this.currentNodeId,
      defaultNext: node.defaultNext,
      chosenNext: chosen,
      casesTried,
    };
    return chosen;
  }

  private evalOwnerState(node: Extract<DialogueGraphNodeDef, { type: 'ownerState' }>): string {
    const fallback = node.missingWrapperNext?.trim() || node.defaultNext;
    const ownerType = this.ownerType.trim();
    const ownerId = this.ownerId.trim();
    const ctx = this.conditionCtx();
    // wrapperGraphId 支持 `@owner` / `@scene` 相对 token（解析失败回退到下方按 owner 解算）。
    const wrapperGraphId = resolveNarrativeGraphRef(node.wrapperGraphId?.trim() ?? '', ctx);
    if (!ownerType || !ownerId) {
      console.warn(`GraphDialogueManager: ownerState ${this.currentNodeId} has no dialogue owner context`);
      return fallback;
    }
    const narrative = ctx.narrativeState;
    let active: string | undefined;
    if (wrapperGraphId) {
      const graph = narrative?.getGraph?.(wrapperGraphId);
      if (!graph) {
        console.warn(`GraphDialogueManager: ownerState ${this.currentNodeId} references missing wrapperGraphId ${wrapperGraphId}`);
        return fallback;
      }
      if (ownerType && ownerId) {
        const graphOwnerType = String(graph.ownerType ?? '').trim();
        const graphOwnerId = String(graph.ownerId ?? '').trim();
        if (graphOwnerType && graphOwnerId && (graphOwnerType !== ownerType || graphOwnerId !== ownerId)) {
          console.warn(
            `GraphDialogueManager: ownerState ${this.currentNodeId} wrapperGraphId ${wrapperGraphId} belongs to ${graphOwnerType}:${graphOwnerId}, current dialogue owner is ${ownerType}:${ownerId}`,
          );
        }
      }
      active = narrative?.getActiveState?.(wrapperGraphId);
      if (!active) {
        console.warn(`GraphDialogueManager: ownerState ${this.currentNodeId} cannot read active state for wrapperGraphId ${wrapperGraphId}`);
        return fallback;
      }
    } else {
      const ownerGraphIds = narrative?.getGraphIdsByOwner?.(ownerType, ownerId) ?? [];
      if (ownerGraphIds.length > 1) {
        console.warn(
          `GraphDialogueManager: ownerState ${this.currentNodeId} is ambiguous for ${ownerType}:${ownerId}; set wrapperGraphId to one of [${ownerGraphIds.join(', ')}]`,
        );
        return fallback;
      }
      active = narrative?.getPrimaryActiveStateByOwner?.(ownerType, ownerId);
    }
    if (!active) {
      console.warn(`GraphDialogueManager: ownerState ${this.currentNodeId} cannot resolve wrapper for ${ownerType}:${ownerId}`);
      return fallback;
    }
    const hit = node.cases.find((c) => c.state === active);
    return hit?.next || node.defaultNext;
  }

  private evalContextState(node: Extract<DialogueGraphNodeDef, { type: 'contextState' }>): string {
    const ctx = this.conditionCtx();
    // graphId 支持 `@owner` / `@scene` 相对 token。
    const graphId = resolveNarrativeGraphRef(node.graphId?.trim() ?? '', ctx);
    if (!graphId) {
      console.warn(`GraphDialogueManager: contextState ${this.currentNodeId} missing graphId`);
      return node.defaultNext;
    }
    const active = ctx.narrativeState?.getActiveState?.(graphId);
    if (!active) {
      console.warn(`GraphDialogueManager: contextState ${this.currentNodeId} cannot read active state for ${graphId}`);
      return node.defaultNext;
    }
    const hit = node.cases.find((c) => c.state === active);
    return hit?.next || node.defaultNext;
  }

  private lineBeatsFor(
    node: Extract<DialogueGraphNodeDef, { type: 'line' }>,
  ): DialogueLinePayload[] {
    const lines = node.lines;
    if (Array.isArray(lines) && lines.length > 0) {
      // 节点级 portrait 作为各拍默认，拍内自带的覆盖之（编辑器只在节点级出选择器）
      if (node.portrait === undefined) return lines;
      return lines.map((p) => (p.portrait === undefined ? { ...p, portrait: node.portrait } : p));
    }
    return [{ speaker: node.speaker, text: node.text, textKey: node.textKey, portrait: node.portrait }];
  }

  private linePayloadToDialogueLine(p: DialogueLinePayload): DialogueLine {
    const speaker = this.r(this.resolveSpeaker(p.speaker));
    let text = '';
    if (p.textKey?.trim()) {
      const k = p.textKey.trim();
      const resolved = this.strings?.get('dialogue', k);
      text = resolved && resolved !== k ? resolved : (p.text ?? k);
    } else {
      text = p.text ?? '';
    }
    return {
      speaker,
      text: this.r(text),
      tags: [],
      portrait: this.resolvePortrait(p),
      speakerEntity: this.speakerEntityOf(p.speaker),
      dim: this.dimBackground || undefined,
    };
  }

  /** 说话人对应的世界实体（「…」气泡定位）；旁白/literal 返回 undefined。 */
  private speakerEntityOf(s: DialogueGraphSpeaker): DialogueLine['speakerEntity'] {
    if (s.kind === 'player') return { kind: 'player' };
    const id = this.speakerNpcId(s);
    return id ? { kind: 'npc', npcId: id } : undefined;
  }

  /**
   * 头像解析：显式 slug 原样用；slug 缺省 =「跟随说话人」——
   * npc/sceneNpc → 场景 NPC 的 portraitSlug（共享图挂谁显谁）；
   * player → 当前生效装扮配置的立绘集（Game 经 setPlayerPortraitSlugProvider 注入）；
   * 解析不到（literal 说话人、未配置）则本行不显头像。UI 收到的 portrait 恒带 slug。
   */
  private resolvePortrait(p: DialogueLinePayload): DialogueLine['portrait'] {
    const ref = p.portrait;
    if (!ref || !ref.emotion) return undefined;
    if (ref.slug?.trim()) return ref;
    if (p.speaker.kind === 'player') {
      const slug = this.playerPortraitSlugProvider?.()?.trim();
      return slug ? { slug, emotion: ref.emotion } : undefined;
    }
    const id = this.speakerNpcId(p.speaker);
    if (!id) return undefined;
    const slug = this.sceneManager.getNpcById(id)?.currentPortraitSlug;
    return slug ? { slug, emotion: ref.emotion } : undefined;
  }

  /** 主角当前装扮配置的立绘集提供者（Game 装配期注入；缺省 null=主角行不显头像）。 */
  private playerPortraitSlugProvider: (() => string | null) | null = null;

  setPlayerPortraitSlugProvider(fn: () => string | null): void {
    this.playerPortraitSlugProvider = fn;
  }

  /** 说话人对应的场景 NPC id；player/literal 无 id 返回 null。 */
  private speakerNpcId(s: DialogueGraphSpeaker): string | null {
    if (s.kind === 'npc') return this.npcId.trim() || null;
    if (s.kind === 'sceneNpc') {
      const raw = s.npcId?.trim() ?? '';
      const id = raw === '@contextNpc' ? this.npcId.trim() : raw;
      return id || null;
    }
    return null;
  }

  private resolveSpeaker(s: DialogueGraphSpeaker): string {
    if (s.kind === 'player') {
      const v = this.flagStore.get('player_display_name');
      if (typeof v === 'string' && v.trim()) return v.trim();
      const fb = this.strings?.get('dialogue', 'defaultProtagonistName');
      return fb && fb !== 'defaultProtagonistName' ? fb : '你';
    }
    if (s.kind === 'npc') return this.npcName;
    if (s.kind === 'literal') return s.name;
    /** 与图对话编辑器约定：promptLine / line 的 sceneNpc 可写此占位，等价于 startDialogueGraph 传入的 npcId */
    const contextNpcToken = '@contextNpc';
    const raw = s.npcId?.trim() ?? '';
    const id = raw === contextNpcToken ? this.npcId.trim() : raw;
    if (!id) return this.npcName || raw || '…';
    const npc = this.sceneManager.getNpcById(id);
    return npc?.def.name ?? id;
  }
}
