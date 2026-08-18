import type { EventBus } from '../core/EventBus';
import type { DialogueLine } from '../data/types';
import {
  parseVoiceSpec,
  parseVoiceAdvanceSpec,
  type VoiceAdvanceSpec,
  type VoiceBeatTicket,
  type VoiceChannel,
} from './VoiceChannel';

/**
 * 世界对话（`DialogueManager` 脚本台词 + `GraphDialogueManager` 图对话）的配音导演。
 *
 * 为什么是一个单独的监听者而不是各管理器自己播：两个管理器都只发 `dialogue:line`，
 * UI 也只认这一个事件——配音挂在同一个事件上，两条对话通道就自动等价，且不必让任一
 * 管理器持有音频系统引用（分层：同层系统只经事件总线通信）。
 *
 * 收尾语义与过场字幕完全一致（见 {@link VoiceChannel}）：
 * - 默认配音跟本行一起结束（换行 / 对话结束即停）；
 * - `voice.hold = true` 的配音跨行留声，直到被后面某行接管或自然播完；
 * - `autoAdvance: "voice"` 的行没写自己的配音时，接管前面留声的那条，
 *   跟它一起结束——即"一条长配音配几句短台词"。
 *
 * 自动推进不直接调管理器：发 `dialogue:autoAdvance` 让 `DialogueUI` 走与点击等价的推进
 * 路径（打字机未完则先补完），避免绕开 UI 状态机造成"文字没显示完就翻页"或重复推进。
 */
export class DialogueVoiceDirector {
  private eventBus: EventBus;
  private channel: VoiceChannel;
  private ticket: VoiceBeatTicket | null = null;
  private timerId: ReturnType<typeof setTimeout> | null = null;
  private unsubVoiceEnd: (() => void) | null = null;
  private bound: { event: string; fn: (payload?: any) => void }[] = [];

  constructor(eventBus: EventBus, channel: VoiceChannel) {
    this.eventBus = eventBus;
    this.channel = channel;
  }

  init(): void {
    this.listen('dialogue:line', (line: DialogueLine) => this.onLine(line));
    /** 对话收束：本行按自身 hold 语义收尾（留声的继续播到自然结束） */
    this.listen('dialogue:end', () => this.endCurrentBeat());
    /** 读档：整局状态换人，任何在播人声都必须闭嘴（留声也不例外） */
    this.listen('save:restoring', () => this.stopAll());
  }

  private listen(event: string, fn: (payload?: any) => void): void {
    this.eventBus.on(event, fn);
    this.bound.push({ event, fn });
  }

  private onLine(line: DialogueLine): void {
    /** 换行 = 上一拍结束：先按上一行的 hold 语义收尾，再决定这一行播什么 */
    this.endCurrentBeat();
    const voice = parseVoiceSpec(line?.voice);
    const advance = parseVoiceAdvanceSpec(line?.autoAdvance);
    this.ticket = voice
      ? this.channel.play(voice)
      : advance?.mode === 'voice'
        ? this.channel.takeSustained()
        : null;
    this.armAutoAdvance(advance);
  }

  private armAutoAdvance(advance: VoiceAdvanceSpec | null): void {
    if (!advance) return;
    if (advance.mode === 'timer') {
      this.timerId = setTimeout(() => {
        this.timerId = null;
        this.eventBus.emit('dialogue:autoAdvance', {});
      }, advance.ms);
      return;
    }
    /** 配音没起来（没配 / 未知 id / 没有留声可接管）→ 退化为等玩家点击，绝不闪切 */
    if (!this.ticket) return;
    this.unsubVoiceEnd = this.ticket.onEnd(() => {
      this.unsubVoiceEnd = null;
      this.eventBus.emit('dialogue:autoAdvance', {});
    });
  }

  /** 结束当前行的配音记账（定时器 / 订阅一律撤，配音本身按 hold 决定停还是留声）。 */
  private endCurrentBeat(): void {
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
    this.unsubVoiceEnd?.();
    this.unsubVoiceEnd = null;
    this.ticket?.endBeat();
    this.ticket = null;
  }

  private stopAll(): void {
    this.endCurrentBeat();
    this.channel.stopAll();
  }

  destroy(): void {
    this.endCurrentBeat();
    for (const b of this.bound) this.eventBus.off(b.event, b.fn);
    this.bound = [];
  }
}
