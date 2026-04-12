import type { EventBus } from '../core/EventBus';
import type { IGameSystem, GameContext, DialogueLine } from '../data/types';

/**
 * 预置台词队列（如过场 `playScriptedDialogue`）。图对话由 {@link GraphDialogueManager} 处理。
 */
export class DialogueManager implements IGameSystem {
  private eventBus: EventBus;
  private scriptedRemaining: DialogueLine[] | null = null;
  private active = false;
  private currentNpcName = '';

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
   */
  startScriptedDialogue(lines: DialogueLine[]): void {
    if (!lines.length) return;
    this.scriptedRemaining = lines.slice(1);
    this.active = true;
    this.currentNpcName = String(lines[0].speaker ?? '').trim();
    this.eventBus.emit('dialogue:start', { npcName: this.currentNpcName });
    this.eventBus.emit('dialogue:line', {
      speaker: lines[0].speaker,
      text: lines[0].text,
      tags: lines[0].tags ?? [],
    });
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
    this.active = false;
    this.scriptedRemaining = null;
    this.currentNpcName = '';
    this.eventBus.emit('dialogue:end', {});
  }

  get isActive(): boolean {
    return this.active;
  }

  destroy(): void {
    this.scriptedRemaining = null;
    this.active = false;
    this.currentNpcName = '';
  }
}
