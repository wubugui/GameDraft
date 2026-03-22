import { Container, Graphics, Text } from 'pixi.js';
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

  constructor(renderer: Renderer, questData: IQuestDataProvider, strings: StringsProvider) {
    this.renderer = renderer;
    this.questData = questData;
    this.strings = strings;
  }

  get isOpen(): boolean {
    return this._isOpen;
  }

  open(): void {
    if (this._isOpen) return;
    this._isOpen = true;
    this.build();
  }

  close(): void {
    if (!this._isOpen) return;
    this._isOpen = false;
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
        style: { fontSize: 13, fill: 0x888899, fontFamily: 'sans-serif' },
      });
      label.x = 0;
      label.y = cy;
      content.addChild(label);
      cy += 22;
    };

    const addQuestEntry = (title: string, desc: string, titleColor: number, descColor: number, prefix: string = '') => {
      const displayTitle = prefix ? `${prefix} ${title}` : title;
      const qt = new Text({
        text: displayTitle,
        style: { fontSize: 13, fill: titleColor, fontFamily: 'sans-serif', fontWeight: 'bold' },
      });
      qt.x = 10;
      qt.y = cy;
      content.addChild(qt);
      cy += 20;

      if (desc) {
        const qd = new Text({
          text: desc,
          style: { fontSize: 11, fill: descColor, fontFamily: 'sans-serif', wordWrap: true, wordWrapWidth: wrapWidth },
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
        style: { fontSize: 12, fill: 0x555566, fontFamily: 'sans-serif' },
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
      addQuestEntry(mainQuest.title, mainQuest.description, 0xffcc66, 0xaaaaaa);
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
        addQuestEntry(q.def.title, q.def.description, 0xaaddcc, 0x999999);
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
        addQuestEntry(q.def.title, q.def.description, 0x777788, 0x555566, this.strings.get('quest', 'done'));
      }
    }

    // Calculate panel height from content
    const contentH = cy;
    const panelH = Math.min(contentH + 80, sh - 40);
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
      text: this.strings.get('quest', 'title'),
      style: { fontSize: 18, fill: 0xffcc88, fontFamily: 'sans-serif', fontWeight: 'bold' },
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

    const hint = new Text({
      text: this.strings.get('quest', 'closeHint'),
      style: { fontSize: 11, fill: 0x555566, fontFamily: 'sans-serif' },
    });
    hint.x = px + panelW - 80;
    hint.y = py + panelH - 24;
    this.container.addChild(hint);

    this.renderer.uiLayer.addChild(this.container);
  }

  destroy(): void {
    this.close();
  }
}
