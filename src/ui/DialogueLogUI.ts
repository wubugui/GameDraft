import { Container, Graphics, Text } from 'pixi.js';
import type { Renderer } from '../rendering/Renderer';
import type { EventBus } from '../core/EventBus';
import type { DialogueLogEntry } from '../data/types';
import type { DialogueLine } from '../systems/DialogueManager';

const MAX_ENTRIES = 200;
const PANEL_W_MAX = 700;
const PADDING = 20;
const LINE_HEIGHT = 20;
const VISIBLE_LINES = 20;

export class DialogueLogUI {
  private renderer: Renderer;
  private eventBus: EventBus;
  private container: Container | null = null;
  private _isOpen = false;
  private entries: DialogueLogEntry[] = [];
  private scrollOffset = 0;

  private lineCb: (line: DialogueLine) => void;
  private choiceCb: (payload: { index: number; text?: string }) => void;
  private onKeyBound: (e: KeyboardEvent) => void;
  private onWheelBound: (e: WheelEvent) => void;

  constructor(renderer: Renderer, eventBus: EventBus) {
    this.renderer = renderer;
    this.eventBus = eventBus;

    this.lineCb = (line) => {
      this.addEntry({ type: 'line', speaker: line.speaker, text: line.text });
    };
    this.choiceCb = (payload) => {
      if (payload.text) {
        this.addEntry({ type: 'choice', text: payload.text });
      }
    };
    this.onKeyBound = this.onKey.bind(this);
    this.onWheelBound = this.onWheel.bind(this);

    this.eventBus.on('dialogue:line', this.lineCb);
    this.eventBus.on('dialogue:choiceSelected:log', this.choiceCb);
  }

  get isOpen(): boolean {
    return this._isOpen;
  }

  private addEntry(entry: DialogueLogEntry): void {
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.shift();
    }
  }

  open(): void {
    if (this._isOpen) return;
    this._isOpen = true;
    this.scrollOffset = Math.max(0, this.entries.length - VISIBLE_LINES);
    this.build();
    window.addEventListener('keydown', this.onKeyBound);
    window.addEventListener('wheel', this.onWheelBound, { passive: false });
  }

  close(): void {
    if (!this._isOpen) return;
    this._isOpen = false;
    window.removeEventListener('keydown', this.onKeyBound);
    window.removeEventListener('wheel', this.onWheelBound);
    if (this.container) {
      if (this.container.parent) this.container.parent.removeChild(this.container);
      this.container.destroy({ children: true });
      this.container = null;
    }
  }

  private build(): void {
    if (this.container) {
      if (this.container.parent) this.container.parent.removeChild(this.container);
      this.container.destroy({ children: true });
    }

    this.container = new Container();
    const sw = this.renderer.screenWidth;
    const sh = this.renderer.screenHeight;
    const panelW = Math.min(PANEL_W_MAX, sw - 40);
    const panelH = VISIBLE_LINES * LINE_HEIGHT + 80;
    const px = (sw - panelW) / 2;
    const py = (sh - panelH) / 2;

    const overlay = new Graphics();
    overlay.rect(0, 0, sw, sh);
    overlay.fill({ color: 0x000000, alpha: 0.5 });
    this.container.addChild(overlay);

    const panel = new Graphics();
    panel.roundRect(px, py, panelW, panelH, 8);
    panel.fill({ color: 0x111122, alpha: 0.95 });
    panel.roundRect(px, py, panelW, panelH, 8);
    panel.stroke({ color: 0x444466, width: 1 });
    this.container.addChild(panel);

    const title = new Text({
      text: '对话记录',
      style: { fontSize: 18, fill: 0xffcc88, fontFamily: 'sans-serif', fontWeight: 'bold' },
    });
    title.x = px + PADDING;
    title.y = py + 14;
    this.container.addChild(title);

    const content = new Container();
    content.x = px + PADDING;
    content.y = py + 46;

    const endIdx = Math.min(this.scrollOffset + VISIBLE_LINES, this.entries.length);
    const startIdx = this.scrollOffset;

    let cy = 0;
    for (let i = startIdx; i < endIdx; i++) {
      const entry = this.entries[i];
      const isChoice = entry.type === 'choice';
      const prefix = isChoice ? '> ' : (entry.speaker ? `${entry.speaker}: ` : '');
      const color = isChoice ? 0x88bbdd : 0xcccccc;

      const t = new Text({
        text: prefix + entry.text,
        style: {
          fontSize: 13,
          fill: color,
          fontFamily: 'sans-serif',
          wordWrap: true,
          wordWrapWidth: panelW - PADDING * 2 - 10,
        },
      });
      t.y = cy;
      content.addChild(t);
      cy += Math.max(LINE_HEIGHT, t.height + 2);
    }

    const contentMask = new Graphics();
    contentMask.rect(px + PADDING, py + 46, panelW - PADDING * 2, panelH - 80);
    contentMask.fill({ color: 0xffffff });
    this.container.addChild(contentMask);
    content.mask = contentMask;
    this.container.addChild(content);

    if (this.entries.length === 0) {
      const empty = new Text({
        text: '(暂无对话记录)',
        style: { fontSize: 12, fill: 0x555566, fontFamily: 'sans-serif' },
      });
      empty.x = px + PADDING + 10;
      empty.y = py + 60;
      this.container.addChild(empty);
    }

    const scrollInfo = this.entries.length > VISIBLE_LINES
      ? `${this.scrollOffset + 1}-${endIdx} / ${this.entries.length}`
      : '';
    const hint = new Text({
      text: `${scrollInfo}  按 L 关闭`,
      style: { fontSize: 11, fill: 0x555566, fontFamily: 'sans-serif' },
    });
    hint.x = px + panelW - hint.width - 16;
    hint.y = py + panelH - 24;
    this.container.addChild(hint);

    this.renderer.uiLayer.addChild(this.container);
  }

  private onKey(e: KeyboardEvent): void {
    if (e.code === 'ArrowUp') {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.build();
    } else if (e.code === 'ArrowDown') {
      this.scrollOffset = Math.min(Math.max(0, this.entries.length - VISIBLE_LINES), this.scrollOffset + 1);
      this.build();
    }
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 3 : -3;
    this.scrollOffset = Math.max(0, Math.min(Math.max(0, this.entries.length - VISIBLE_LINES), this.scrollOffset + delta));
    this.build();
  }

  serialize(): object {
    return { entries: this.entries };
  }

  deserialize(data: { entries?: DialogueLogEntry[] }): void {
    this.entries = data.entries ?? [];
  }

  destroy(): void {
    this.close();
    this.eventBus.off('dialogue:line', this.lineCb);
    this.eventBus.off('dialogue:choiceSelected:log', this.choiceCb);
  }
}
