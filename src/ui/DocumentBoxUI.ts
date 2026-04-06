import { Container, Graphics, Text } from 'pixi.js';
import { UITheme, fadeIn } from './UITheme';
import type { Renderer } from '../rendering/Renderer';
import type { IArchiveDataProvider } from '../data/types';
import type { StringsProvider } from '../core/StringsProvider';

const PANEL_W = 650;
const PANEL_H = 500;
const PADDING = 20;
const ENTRY_H = 28;

export class DocumentBoxUI {
  private renderer: Renderer;
  private archiveData: IArchiveDataProvider;
  private container: Container | null = null;
  private contentText: Text | null = null;
  private scrollOffset = 0;
  private listContentH = 0;
  private listContainer: Container | null = null;
  private onWheelBound: (e: WheelEvent) => void;
  private onClose: () => void;
  private strings: StringsProvider;

  constructor(renderer: Renderer, archiveData: IArchiveDataProvider, onClose: () => void, strings: StringsProvider) {
    this.renderer = renderer;
    this.archiveData = archiveData;
    this.onClose = onClose;
    this.strings = strings;
    this.onWheelBound = (e) => this.onWheel(e);
  }

  destroy(): void {
    this.close();
  }

  open(): void {
    this.scrollOffset = 0;
    this.build();
    window.addEventListener('wheel', this.onWheelBound, { passive: false });
  }

  close(): void {
    window.removeEventListener('wheel', this.onWheelBound);
    this.destroyUI();
  }

  private build(): void {
    this.destroyUI();
    this.scrollOffset = 0;
    this.container = new Container();
    const sw = this.renderer.screenWidth;
    const sh = this.renderer.screenHeight;
    const px = (sw - PANEL_W) / 2;
    const py = (sh - PANEL_H) / 2;

    const overlay = new Graphics();
    overlay.rect(0, 0, sw, sh);
    overlay.fill({ color: UITheme.colors.overlay, alpha: UITheme.alpha.overlay });
    this.container.addChild(overlay);

    const bg = new Graphics();
    bg.roundRect(px, py, PANEL_W, PANEL_H, UITheme.panel.borderRadius);
    bg.fill({ color: UITheme.colors.panelBg, alpha: UITheme.alpha.panelBg });
    bg.roundRect(px, py, PANEL_W, PANEL_H, UITheme.panel.borderRadius);
    bg.stroke({ color: UITheme.colors.panelBorder, width: 1 });
    this.container.addChild(bg);

    const title = new Text({
      text: this.strings.get('documentBox', 'title'),
      style: { fontSize: 18, fill: UITheme.colors.title, fontFamily: UITheme.fonts.ui, fontWeight: 'bold', wordWrap: true, breakWords: true, wordWrapWidth: PANEL_W - 40 },
    });
    title.x = px + PADDING;
    title.y = py + 12;
    this.container.addChild(title);

    const backBtn = new Text({
      text: this.strings.get('documentBox', 'back'),
      style: { fontSize: 13, fill: UITheme.colors.link, fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true, wordWrapWidth: 100 },
    });
    backBtn.x = px + PANEL_W - 100;
    backBtn.y = py + 14;
    backBtn.eventMode = 'static';
    backBtn.cursor = 'pointer';
    backBtn.on('pointerdown', () => this.onClose());
    this.container.addChild(backBtn);

    const docs = this.archiveData.getUnlockedDocuments();
    const listH = PANEL_H - 80;
    const listY = py + 50;

    this.listContainer = new Container();

    const listMask = new Graphics();
    listMask.rect(px, listY, 180, listH);
    listMask.fill({ color: 0xffffff });
    this.container.addChild(listMask);
    this.listContainer.mask = listMask;

    if (docs.length === 0) {
      const empty = new Text({
        text: this.strings.get('documentBox', 'empty'),
        style: { fontSize: 12, fill: UITheme.colors.hint, fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true, wordWrapWidth: 160 },
      });
      empty.x = px + PADDING;
      empty.y = listY;
      this.listContainer.addChild(empty);
    } else {
      let cy = 0;
      for (const doc of docs) {
        const isNew = !this.archiveData.isRead(`doc_${doc.id}`);
        const label = new Text({
          text: (isNew ? '* ' : '') + doc.name,
          style: { fontSize: 13, fill: isNew ? UITheme.colors.title : UITheme.colors.subtle, fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true, wordWrapWidth: 160 },
        });
        label.x = px + PADDING;
        label.y = listY + cy;
        label.eventMode = 'static';
        label.cursor = 'pointer';
        label.on('pointerdown', () => {
          this.archiveData.markRead(`doc_${doc.id}`);
          this.showContent(doc.content, doc.annotation, px + 200, py + 50);
        });
        this.listContainer.addChild(label);
        cy += ENTRY_H;
      }
      this.listContentH = cy;
    }
    this.container.addChild(this.listContainer);

    this.renderer.uiLayer.addChild(this.container);
    fadeIn(this.container);
  }

  private showContent(content: string, annotation: string | undefined, x: number, y: number): void {
    if (this.contentText) {
      if (this.contentText.parent) this.contentText.parent.removeChild(this.contentText);
      this.contentText.destroy();
      this.contentText = null;
    }
    const fullText = annotation ? `${content}\n\n${this.strings.get('documentBox', 'note')} ${annotation}` : content;
    const ct = new Text({
      text: fullText,
      style: { fontSize: 12, fill: UITheme.colors.subtle, fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true, wordWrapWidth: PANEL_W - 240 },
    });
    ct.x = x;
    ct.y = y;
    this.container?.addChild(ct);
    this.contentText = ct;
  }

  private onWheel(e: WheelEvent): void {
    if (!this.listContainer) return;
    const listH = PANEL_H - 80;
    const maxScroll = Math.max(0, this.listContentH - listH);
    this.scrollOffset = Math.max(-maxScroll, Math.min(0, this.scrollOffset - e.deltaY));
    this.listContainer.y = this.scrollOffset;
    e.preventDefault();
  }

  private destroyUI(): void {
    this.contentText = null;
    this.listContainer = null;
    if (this.container) {
      if (this.container.parent) this.container.parent.removeChild(this.container);
      this.container.destroy({ children: true });
      this.container = null;
    }
  }
}
