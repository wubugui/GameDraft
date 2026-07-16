import type { EventBus } from '../core/EventBus';
import type {
  IGameSystem,
  GameContext,
  DialogueLine,
  DialogueStartPayload,
  DialogueEndPayload,
} from '../data/types';

/**
 * 预置台词队列（如过场 `playScriptedDialogue`）。图对话由 {@link GraphDialogueManager} 处理。
 */
export class DialogueManager implements IGameSystem {
  private eventBus: EventBus;
  private scriptedRemaining: DialogueLine[] | null = null;
  private active = false;
  private currentNpcName = '';
  /** 本段脚本台词是否嵌套在活跃图对话的 runActions 内（由调用方在 start 时判定传入），
   *  随 `dialogue:end` 负载发出，供消费者区分「嵌套段结束」与「最外层对话结束」（R5 根因） */
  private nestedInGraph = false;

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  init(_ctx: GameContext): void {}

  update(_dt: number): void {}

  serialize(): object {
    if (!this.active) return { active: false };
    return { active: true, npcName: this.currentNpcName, scripted: true };
  }

  deserialize(_data: unknown): void {
    if (this.active) {
      this.endDialogue();
    }
    this.active = false;
    this.scriptedRemaining = null;
    this.currentNpcName = '';
  }

  /**
   * 按顺序播放 `lines`（每条点击继续）；与对话 UI / EventBridge 流程一致。
   * `nestedInGraph`：调用方（Game 的 playScriptedDialogue 依赖）在图对话活跃时传 true。
   */
  startScriptedDialogue(lines: DialogueLine[], nestedInGraph = false): void {
    if (!lines.length) return;
    this.scriptedRemaining = lines.slice(1);
    this.active = true;
    this.nestedInGraph = nestedInGraph;
    this.currentNpcName = String(lines[0].speaker ?? '').trim();
    this.eventBus.emit('dialogue:start', {
      npcName: this.currentNpcName,
      source: 'scripted',
    } satisfies DialogueStartPayload);
    /** 首句必须整行下发（含 portrait / speakerEntity / dim）；仅补 tags 兜底，勿再摘字段（后续句经 advance 已整行） */
    this.eventBus.emit('dialogue:line', { ...lines[0], tags: lines[0].tags ?? [] });
    if (lines.length === 1) {
      this.scheduleEnd();
    }
  }

  async advance(): Promise<void> {
    if (!this.active) return;

    this.eventBus.emit('dialogue:prepareBeat', {});

    if (this.scriptedRemaining === null) {
      this.endDialogue();
      return;
    }
    if (this.scriptedRemaining.length === 0) {
      this.scriptedRemaining = null;
      this.endDialogue();
      return;
    }
    const line = this.scriptedRemaining.shift()!;
    this.eventBus.emit('dialogue:line', line);
    if (this.scriptedRemaining.length === 0) {
      this.scheduleEnd();
    }
  }

  async chooseOption(_index: number): Promise<void> {
    // 预置台词无选项；选项仅出现在 GraphDialogueManager。
  }

  private scheduleEnd(): void {
    this.eventBus.emit('dialogue:willEnd', {});
  }

  endDialogue(): void {
    if (!this.active) return;
    const nested = this.nestedInGraph;
    this.active = false;
    this.scriptedRemaining = null;
    this.currentNpcName = '';
    this.nestedInGraph = false;
    this.eventBus.emit('dialogue:end', {
      source: 'scripted',
      nestedInGraph: nested,
    } satisfies DialogueEndPayload);
  }

  get isActive(): boolean {
    return this.active;
  }

  destroy(): void {
    this.scriptedRemaining = null;
    this.active = false;
    this.currentNpcName = '';
    this.nestedInGraph = false;
  }
}
