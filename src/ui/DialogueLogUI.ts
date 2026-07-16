import { Container, Graphics, Text } from 'pixi.js';
import { UITheme, fadeIn } from './UITheme';
import { drawPanelBase, SKINS } from './PanelSkin';
import { canvasPointFromEvent } from './uiPointerCoords';
import type { Renderer } from '../rendering/Renderer';
import type { EventBus } from '../core/EventBus';
import type { StringsProvider } from '../core/StringsProvider';
import type { DialogueLogEntry } from '../data/types';
import type { DialogueLine } from '../data/types';

const MAX_ENTRIES = 200;
const PANEL_W_MAX = 700;
const PADDING = 20;
const LINE_HEIGHT = 20;
const VISIBLE_LINES = 20;

export class DialogueLogUI {
  private renderer: Renderer;
  private eventBus: EventBus;
  private strings: StringsProvider;
  private container: Container | null = null;
  private _isOpen = false;
  private entries: DialogueLogEntry[] = [];
  private scrollOffset = 0;
  /** 面板骨架（overlay/底板/标题/遮罩）只在 open 时建一次；滚动只重建列表区 */
  private listContent: Container | null = null;
  private scrollHint: Text | null = null;
  private shellGeom: { px: number; py: number; panelW: number; panelH: number } | null = null;

  private lineCb: (line: DialogueLine) => void;
  private choiceCb: (payload: { index: number; text?: string }) => void;
  private onKeyBound: (e: KeyboardEvent) => void;
  private onWheelBound: (e: WheelEvent) => void;

  constructor(renderer: Renderer, eventBus: EventBus, strings: StringsProvider) {
    this.renderer = renderer;
    this.eventBus = eventBus;
    this.strings = strings;

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
    this.buildShell();
    this.renderList();
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
    this.listContent = null;
    this.scrollHint = null;
    this.shellGeom = null;
  }

  private buildShell(): void {
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
    overlay.fill({ color: UITheme.colors.overlay, alpha: UITheme.alpha.overlay });
    this.container.addChild(overlay);

    const panel = new Graphics();
    drawPanelBase(panel, px, py, panelW, panelH, SKINS.panel);
    this.container.addChild(panel);

    const title = new Text({
      text: this.strings.get('dialogueLog', 'title'),
      style: { fontSize: 18, fill: UITheme.colors.title, fontFamily: UITheme.fonts.ui, fontWeight: 'bold', wordWrap: true, breakWords: true, wordWrapWidth: panelW - PADDING * 2 },
    });
    title.x = px + PADDING;
    title.y = py + 14;
    this.container.addChild(title);

    const content = new Container();
    content.x = px + PADDING;
    content.y = py + 46;

    const contentMask = new Graphics();
    contentMask.rect(px + PADDING, py + 46, panelW - PADDING * 2, panelH - 80);
    contentMask.fill({ color: 0xffffff });
    this.container.addChild(contentMask);
    content.mask = contentMask;
    this.container.addChild(content);
    this.listContent = content;

    if (this.entries.length === 0) {
      const empty = new Text({
        text: this.strings.get('dialogueLog', 'empty'),
        style: { fontSize: 12, fill: UITheme.colors.hint, fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true, wordWrapWidth: panelW - PADDING * 2 },
      });
      empty.x = px + PADDING + 10;
      empty.y = py + 60;
      this.container.addChild(empty);
    }

    this.scrollHint = new Text({
      text: '',
      style: { fontSize: 11, fill: UITheme.colors.hint, fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true, wordWrapWidth: panelW - PADDING * 2 },
    });
    this.container.addChild(this.scrollHint);

    this.shellGeom = { px, py, panelW, panelH };

    this.renderer.uiLayer.addChild(this.container);
    fadeIn(this.container);
  }

  /** 只重建列表区行与页码提示；骨架不动（曾经每格滚轮整面板重建，长日志时明显卡顿/闪烁）。 */
  private renderList(): void {
    if (!this.listContent || !this.shellGeom || !this.scrollHint) return;
    const { px, py, panelW, panelH } = this.shellGeom;

    const removed = this.listContent.removeChildren();
    for (const child of removed) child.destroy({ children: true });

    const endIdx = Math.min(this.scrollOffset + VISIBLE_LINES, this.entries.length);
    const startIdx = this.scrollOffset;

    let cy = 0;
    for (let i = startIdx; i < endIdx; i++) {
      const entry = this.entries[i];
      const isChoice = entry.type === 'choice';
      const prefix = isChoice ? '> ' : (entry.speaker ? `${entry.speaker}: ` : '');
      const color = isChoice ? UITheme.colors.choiceLog : UITheme.colors.bodyLight;

      const t = new Text({
        text: prefix + entry.text,
        style: {
          fontSize: 13,
          fill: color,
          fontFamily: UITheme.fonts.ui,
          wordWrap: true, breakWords: true,
          wordWrapWidth: panelW - PADDING * 2 - 10,
        },
      });
      t.y = cy;
      this.listContent.addChild(t);
      cy += Math.max(LINE_HEIGHT, t.height + 2);
    }

    const scrollInfo = this.entries.length > VISIBLE_LINES
      ? `${this.scrollOffset + 1}-${endIdx} / ${this.entries.length}`
      : '';
    this.scrollHint.text = `${scrollInfo}  ${this.strings.get('dialogueLog', 'closeHint')}`;
    this.scrollHint.x = px + panelW - this.scrollHint.width - 16;
    this.scrollHint.y = py + panelH - 24;
  }

  private setScrollOffset(next: number): void {
    const clamped = Math.max(0, Math.min(Math.max(0, this.entries.length - VISIBLE_LINES), next));
    if (clamped === this.scrollOffset) return;
    this.scrollOffset = clamped;
    this.renderList();
  }

  private onKey(e: KeyboardEvent): void {
    if (e.code === 'ArrowUp') {
      this.setScrollOffset(this.scrollOffset - 1);
    } else if (e.code === 'ArrowDown') {
      this.setScrollOffset(this.scrollOffset + 1);
    }
  }

  private onWheel(e: WheelEvent): void {
    // 事件来自 DOM 面板（调试侧栏等）时放行，不劫持其滚动
    if (!canvasPointFromEvent(this.renderer, e)) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? 3 : -3;
    this.setScrollOffset(this.scrollOffset + delta);
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
