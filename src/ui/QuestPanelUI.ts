import { Container, Graphics, Text } from 'pixi.js';
import { UITheme, fadeIn } from './UITheme';
import type { Renderer } from '../rendering/Renderer';
import type { StringsProvider } from '../core/StringsProvider';
import type { IQuestDataProvider } from '../data/types';

const PANEL_W_MAX = 600;
const PADDING = 20;
const SECTION_GAP = 16;
const ITEM_GAP = 4;

export class QuestPanelUI {
  private renderer: Renderer;
  private questData: IQuestDataProvider;
  private strings: StringsProvider;
  private container: Container | null = null;
  private _isOpen: boolean = false;
  private scrollOffset = 0;
  private contentH = 0;
  private content: Container | null = null;
  private panelInnerH = 0;
  private onWheelBound: (e: WheelEvent) => void;
  private onScrollKeyBound: (e: KeyboardEvent) => void;
  private resolveDisplay: ((s: string) => string) | null = null;

  constructor(renderer: Renderer, questData: IQuestDataProvider, strings: StringsProvider) {
    this.renderer = renderer;
    this.questData = questData;
    this.strings = strings;
    this.onWheelBound = this.onWheel.bind(this);
    this.onScrollKeyBound = this.onScrollKey.bind(this);
  }

  setResolveDisplay(fn: ((s: string) => string) | null): void {
    this.resolveDisplay = fn;
  }

  private r(s: string): string {
    return this.resolveDisplay ? this.resolveDisplay(s) : s;
  }

  get isOpen(): boolean {
    return this._isOpen;
  }

  open(): void {
    if (this._isOpen) return;
    this._isOpen = true;
    this.build();
    window.addEventListener('wheel', this.onWheelBound, { passive: false });
    window.addEventListener('keydown', this.onScrollKeyBound);
  }

  close(): void {
    if (!this._isOpen) return;
    this._isOpen = false;
    window.removeEventListener('wheel', this.onWheelBound);
    window.removeEventListener('keydown', this.onScrollKeyBound);
    if (this.container) {
      if (this.container.parent) {
        this.container.parent.removeChild(this.container);
      }
      this.container.destroy({ children: true });
      this.container = null;
    }
  }

  private build(): void {
    this.container = new Container();
    const content = new Container();

    const sw = this.renderer.screenWidth;
    const sh = this.renderer.screenHeight;
    const panelW = Math.min(PANEL_W_MAX, sw - 40);
    const wrapWidth = panelW - PADDING * 2 - 20;

    let cy = 0;

    const addSectionLabel = (text: string) => {
      const label = new Text({
        text,
        style: { fontSize: 13, fill: UITheme.colors.section, fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true, wordWrapWidth: 540 },
      });
      label.x = 0;
      label.y = cy;
      content.addChild(label);
      cy += 22;
    };

    const addQuestEntry = (title: string, desc: string, titleColor: number, descColor: number, prefix: string = '') => {
      const rt = this.r(title);
      const rd = this.r(desc);
      const displayTitle = prefix ? `${prefix} ${rt}` : rt;
      const qt = new Text({
        text: displayTitle,
        style: { fontSize: 13, fill: titleColor, fontFamily: UITheme.fonts.ui, fontWeight: 'bold', wordWrap: true, breakWords: true, wordWrapWidth: 520 },
      });
      qt.x = 10;
      qt.y = cy;
      content.addChild(qt);
      cy += 20;

      if (desc) {
        const qd = new Text({
          text: rd,
          style: { fontSize: 11, fill: descColor, fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true, wordWrapWidth: wrapWidth },
        });
        qd.x = 10;
        qd.y = cy;
        content.addChild(qd);
        cy += qd.height + ITEM_GAP;
      }
      cy += ITEM_GAP;
    };

    const addEmpty = (text: string) => {
      const t = new Text({
        text,
        style: { fontSize: 12, fill: UITheme.colors.hint, fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true, wordWrapWidth: 540 },
      });
      t.x = 10;
      t.y = cy;
      content.addChild(t);
      cy += 20;
    };

    // -- Main quest --
    addSectionLabel(this.strings.get('quest', 'mainline'));
    const mainQuest = this.questData.getCurrentMainQuest();
    if (mainQuest) {
      addQuestEntry(mainQuest.title, mainQuest.description ?? '', UITheme.colors.questMain, UITheme.colors.descText);
    } else {
      addEmpty(this.strings.get('quest', 'empty'));
    }
    cy += SECTION_GAP;

    // -- Active side quests --
    const sideQuests = this.questData.getActiveQuests().filter(q => q.def.type === 'side');
    addSectionLabel(this.strings.get('quest', 'sideline', { count: sideQuests.length }));
    if (sideQuests.length === 0) {
      addEmpty(this.strings.get('quest', 'empty'));
    } else {
      for (const q of sideQuests) {
        addQuestEntry(q.def.title, q.def.description, UITheme.colors.questSide, UITheme.colors.descTextDim);
      }
    }
    cy += SECTION_GAP;

    // -- Completed quests --
    const completedQuests = this.questData.getCompletedQuests();
    addSectionLabel(this.strings.get('quest', 'completed', { count: completedQuests.length }));
    if (completedQuests.length === 0) {
      addEmpty(this.strings.get('quest', 'empty'));
    } else {
      for (const q of completedQuests) {
        addQuestEntry(q.def.title, q.def.description, UITheme.colors.questCompleted, UITheme.colors.hint, this.strings.get('quest', 'done'));
      }
    }

    this.contentH = cy;
    const panelH = Math.min(this.contentH + 80, sh - 40);
    this.panelInnerH = panelH - 80;
    this.scrollOffset = 0;
    const px = (sw - panelW) / 2;
    const py = (sh - panelH) / 2;

    const overlay = new Graphics();
    overlay.rect(0, 0, sw, sh);
    overlay.fill({ color: UITheme.colors.overlay, alpha: UITheme.alpha.overlay });
    this.container.addChild(overlay);

    const panel = new Graphics();
    panel.roundRect(px, py, panelW, panelH, UITheme.panel.borderRadius);
    panel.fill({ color: UITheme.colors.panelBg, alpha: UITheme.alpha.panelBg });
    panel.roundRect(px, py, panelW, panelH, UITheme.panel.borderRadius);
    panel.stroke({ color: UITheme.colors.panelBorder, width: 1 });
    this.container.addChild(panel);

    const title = new Text({
      text: this.strings.get('quest', 'title'),
      style: { fontSize: 18, fill: UITheme.colors.title, fontFamily: UITheme.fonts.ui, fontWeight: 'bold', wordWrap: true, breakWords: true, wordWrapWidth: 560 },
    });
    title.x = px + PADDING;
    title.y = py + 14;
    this.container.addChild(title);

    content.x = px + PADDING;
    content.y = py + 46;

    // Mask content to panel area if it overflows
    const contentMask = new Graphics();
    contentMask.rect(px + PADDING, py + 46, panelW - PADDING * 2, panelH - 80);
    contentMask.fill({ color: 0xffffff });
    this.container.addChild(contentMask);
    content.mask = contentMask;

    this.container.addChild(content);
    this.content = content;

    const hint = new Text({
      text: this.strings.get('quest', 'closeHint'),
      style: { fontSize: 11, fill: UITheme.colors.hint, fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true, wordWrapWidth: 540 },
    });
    hint.x = px + panelW - 80;
    hint.y = py + panelH - 24;
    this.container.addChild(hint);

    this.renderer.uiLayer.addChild(this.container);
    fadeIn(this.container);
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const maxScroll = Math.max(0, this.contentH - this.panelInnerH);
    this.scrollOffset = Math.max(0, Math.min(maxScroll, this.scrollOffset + (e.deltaY > 0 ? 30 : -30)));
    if (this.content) {
      const sh = this.renderer.screenHeight;
      const panelH = Math.min(this.contentH + 80, sh - 40);
      const py = (sh - panelH) / 2;
      this.content.y = py + 46 - this.scrollOffset;
    }
  }

  private onScrollKey(e: KeyboardEvent): void {
    if (e.code === 'ArrowUp') { this.scrollOffset = Math.max(0, this.scrollOffset - 30); }
    else if (e.code === 'ArrowDown') {
      const maxScroll = Math.max(0, this.contentH - this.panelInnerH);
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 30);
    } else return;
    if (this.content) {
      const sh = this.renderer.screenHeight;
      const panelH = Math.min(this.contentH + 80, sh - 40);
      const py = (sh - panelH) / 2;
      this.content.y = py + 46 - this.scrollOffset;
    }
  }

  destroy(): void {
    if (this._isOpen) {
      window.removeEventListener('wheel', this.onWheelBound);
      window.removeEventListener('keydown', this.onScrollKeyBound);
    }
    this.close();
  }
}
