import type { EventBus } from '../core/EventBus';
import type { FlagStore } from '../core/FlagStore';
import type { ActionExecutor } from '../core/ActionExecutor';
import type { AssetManager } from '../core/AssetManager';
import type { SceneManager } from './SceneManager';
import type { RulesManager } from './RulesManager';
import type { QuestManager } from './QuestManager';
import type { InventoryManager } from './InventoryManager';
import type { StringsProvider } from '../core/StringsProvider';
import type {
  ActionDef,
  DialogueChoice,
  DialogueGraphFile,
  DialogueGraphNodeDef,
  DialogueGraphSpeaker,
  DialogueLine,
  DialogueLinePayload,
  IGameSystem,
  GameContext,
} from '../data/types';
import { evaluateAllGraphConditions } from './graphDialogue/evaluateGraphCondition';
import { evaluateGraphCondition } from './graphDialogue/evaluateGraphCondition';

/**
 * 图对话运行时：语义上**严格串行**（上一拍结束再进下一拍）。使用 Promise/async 是因为加载资源、
 * 部分 Action（如 waitClickContinue）在 JS 中只能异步完成，**并非**多段剧情并行。
 *
 * **防乱**：凡 `advance` / `chooseOption` / `startDialogueGraph` 一律经 `runExclusive` 排队，同一时刻最多
 * 一条执行链；`drainUntilBlocking` 内 `while` 顺序前进，仅在 `await executeForDialogue` / `await loadJson` 处让出线程。
 */
export class GraphDialogueManager implements IGameSystem {
  private eventBus: EventBus;
  private flagStore: FlagStore;
  private actionExecutor: ActionExecutor;
  private assetManager: AssetManager;
  private sceneManager: SceneManager;
  private rulesManager: RulesManager;
  private questManager: QuestManager;
  private inventoryManager: InventoryManager;
  private strings: StringsProvider | null = null;

  private graph: DialogueGraphFile | null = null;
  /** 加载时使用的 graphId（文件名），与 JSON 内 `id` 可能不一致时仍以路径为准 */
  private graphSourceId: string = '';
  private currentNodeId: string = '';
  private active = false;
  private npcName: string = '';
  private npcId: string = '';
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
  }> = [];

  constructor(
    eventBus: EventBus,
    flagStore: FlagStore,
    actionExecutor: ActionExecutor,
    assetManager: AssetManager,
    sceneManager: SceneManager,
    rulesManager: RulesManager,
    questManager: QuestManager,
    inventoryManager: InventoryManager,
  ) {
    this.eventBus = eventBus;
    this.flagStore = flagStore;
    this.actionExecutor = actionExecutor;
    this.assetManager = assetManager;
    this.sceneManager = sceneManager;
    this.rulesManager = rulesManager;
    this.questManager = questManager;
    this.inventoryManager = inventoryManager;
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

  update(_dt: number): void {}

  serialize(): object {
    if (!this.active || !this.graph) return { active: false };
    return {
      active: true,
      graphId: this.graphSourceId || this.graph.id,
      npcName: this.npcName,
      nodeId: this.currentNodeId,
    };
  }

  deserialize(_data: object): void {
    this.deferredGraphQueue.length = 0;
    if (this.active) this.endDialogue();
    this.active = false;
    this.graph = null;
    this.graphSourceId = '';
    this.currentNodeId = '';
    this.npcName = '';
    this.npcId = '';
    this.choicePhase = null;
    this.awaitingLineDismiss = false;
    this.lineBeatIndex = 0;
    this.deferredGraphQueue = [];
    this.opChain = Promise.resolve();
  }

  get isActive(): boolean {
    return this.active;
  }

  destroy(): void {
    this.deferredGraphQueue.length = 0;
    this.endDialogue();
    this.strings = null;
  }

  async startDialogueGraph(params: {
    graphId: string;
    entry?: string;
    npcName: string;
    npcId?: string;
  }): Promise<void> {
    const gid = params.graphId?.trim();
    if (!gid) return Promise.resolve();

    if (this.drainDepth > 0 && this.active) {
      this.deferredGraphQueue.push({
        graphId: gid,
        entry: params.entry?.trim() || undefined,
        npcName: params.npcName,
        npcId: params.npcId?.trim() || undefined,
      });
      return Promise.resolve();
    }

    return this.runExclusive(async () => {
      if (this.active) {
        console.warn('GraphDialogueManager: 已有对话进行中，忽略重复 start');
        return;
      }

      const path = `/assets/dialogues/graphs/${gid}.json`;
      let raw: DialogueGraphFile;
      try {
        raw = await this.assetManager.loadJson<DialogueGraphFile>(path);
      } catch (e) {
        console.warn(`GraphDialogueManager: 无法加载 ${path}`, e);
        return;
      }

      if (!raw.nodes || typeof raw.entry !== 'string' || !raw.nodes[raw.entry]) {
        console.warn(`GraphDialogueManager: 图 ${gid} 缺少 entry 或 nodes`);
        return;
      }

      const rid = typeof raw.id === 'string' ? raw.id.trim() : '';
      if (rid && rid !== gid) {
        console.warn(`GraphDialogueManager: 图 JSON id "${rid}" 与路径 graphId "${gid}" 不一致，以路径为准继续`);
      }

      if (!evaluateAllGraphConditions(raw.preconditions, this.flagStore, this.questManager)) {
        console.warn(`GraphDialogueManager: 图 ${gid} preconditions 不满足`);
        return;
      }

      this.graph = raw;
      this.graphSourceId = gid;
      this.npcName = params.npcName;
      this.npcId = params.npcId?.trim() ?? '';
      this.currentNodeId = (params.entry?.trim() && raw.nodes[params.entry.trim()])
        ? params.entry.trim()
        : raw.entry;
      this.active = true;
      this.choicePhase = null;
      this.awaitingLineDismiss = false;
      this.lineBeatIndex = 0;

      this.eventBus.emit('dialogue:start', { npcName: this.npcName, graphId: gid });
      await this.drainUntilBlocking();
    });
  }

  async advance(): Promise<void> {
    return this.runUserOp(() => this.advanceCore());
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

      this.eventBus.emit('dialogue:choiceSelected:log', { index, text: opt.text });
      this.choicePhase = null;
      this.currentNodeId = opt.next;
      await this.advanceCore();
    });
  }

  endDialogue(): void {
    if (!this.active) return;
    this.active = false;
    this.graph = null;
    this.graphSourceId = '';
    this.currentNodeId = '';
    this.npcName = '';
    this.npcId = '';
    this.choicePhase = null;
    this.awaitingLineDismiss = false;
    this.lineBeatIndex = 0;
    this.opDrainGeneration++;
    this.opChain = Promise.resolve();
    this.eventBus.emit('dialogue:end', {});

    const q = this.deferredGraphQueue.splice(0);
    if (q.length === 0) return;
    /** 不可再包一层 runExclusive：否则与 startDialogueGraph 内部的 runExclusive 互相等待死锁 */
    void Promise.resolve()
      .then(async () => {
        for (const item of q) {
          await this.startDialogueGraph(item);
        }
      })
      .catch((e) => console.warn('GraphDialogueManager: 衔接嵌套图失败', e));
  }

  private async drainUntilBlocking(): Promise<void> {
    if (!this.active || !this.graph) return;
    this.drainDepth++;
    try {
      while (this.active && this.graph) {
      const node = this.graph.nodes[this.currentNodeId];
      if (!node) {
        console.warn(`GraphDialogueManager: 缺失节点 ${this.currentNodeId}`);
        this.endDialogue();
        return;
      }

      if (node.type === 'switch') {
        this.currentNodeId = this.evalSwitch(node);
        continue;
      }

      if (node.type === 'runActions') {
        this.eventBus.emit('dialogue:hidePanel', {});
        try {
          for (const a of node.actions) {
            await this.actionExecutor.executeForDialogue(a as ActionDef);
          }
        } catch (e) {
          console.warn('GraphDialogueManager: runActions 执行失败，结束对话', e);
          this.endDialogue();
          return;
        }
        this.currentNodeId = node.next;
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
    this.eventBus.emit('dialogue:choices', choices);
  }

  private buildChoicesForNode(node: Extract<DialogueGraphNodeDef, { type: 'choice' }>): DialogueChoice[] {
    const s = this.strings;
    return node.options.map((opt, i) => {
      const requireKey = opt.requireFlag?.trim() || undefined;
      const reqOk =
        requireKey === undefined ||
        this.flagStore.checkConditions([{ flag: requireKey, op: '!=', value: false }]);
      const costAmount = opt.costCoins;
      const coins = this.inventoryCoinsForChoice();
      const costOk = costAmount === undefined || coins >= costAmount;
      const enabled = reqOk && costOk;
      const customHint = !enabled && opt.disabledClickHint?.trim() ? opt.disabledClickHint.trim() : undefined;
      const autoHint = enabled
        ? undefined
        : this.buildChoiceDisableHint({ requireKey, reqOk, costAmount, costOk, ruleHintId: opt.ruleHintId }, s);
      const disableHint = customHint ?? autoHint;

      return {
        index: i,
        text: opt.text,
        tags: [],
        enabled,
        ruleHintId: opt.ruleHintId,
        disableHint,
      };
    });
  }

  private buildChoiceDisableHint(
    args: {
      requireKey: string | undefined;
      reqOk: boolean;
      costAmount: number | undefined;
      costOk: boolean;
      ruleHintId: string | undefined;
    },
    s: StringsProvider | null,
  ): string | undefined {
    if (!s) return undefined;
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

  private evalSwitch(node: Extract<DialogueGraphNodeDef, { type: 'switch' }>): string {
    for (const c of node.cases) {
      if (c.conditions.every(cond => evaluateGraphCondition(cond, this.flagStore, this.questManager))) {
        return c.next;
      }
    }
    return node.defaultNext;
  }

  private lineBeatsFor(
    node: Extract<DialogueGraphNodeDef, { type: 'line' }>,
  ): DialogueLinePayload[] {
    const lines = node.lines;
    if (Array.isArray(lines) && lines.length > 0) {
      return lines;
    }
    return [{ speaker: node.speaker, text: node.text, textKey: node.textKey }];
  }

  private linePayloadToDialogueLine(p: DialogueLinePayload): DialogueLine {
    const speaker = this.resolveSpeaker(p.speaker);
    let text = '';
    if (p.textKey?.trim()) {
      const k = p.textKey.trim();
      const resolved = this.strings?.get('dialogue', k);
      text = resolved && resolved !== k ? resolved : (p.text ?? k);
    } else {
      text = p.text ?? '';
    }
    return { speaker, text, tags: [] };
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
