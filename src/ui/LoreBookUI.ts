import { Container, Graphics, Text } from 'pixi.js';
import { UITheme, fadeIn } from './UITheme';
import type { Renderer } from '../rendering/Renderer';
import type { IArchiveDataProvider } from '../data/types';
import type { StringsProvider } from '../core/StringsProvider';

const PANEL_W = 650;
const PANEL_H = 500;
const PADDING = 20;
const ENTRY_H = 28;

export class LoreBookUI {
  private renderer: Renderer;
  private archiveData: IArchiveDataProvider;
  private container: Container | null = null;
  private onClose: () => void;
  private strings: StringsProvider;
  private contentText: Text | null = null;
  private scrollOffset = 0;
  private listContentH = 0;
  private listContainer: Container | null = null;
  private onWheelBound: (e: WheelEvent) => void;

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
    window.addEventListener('wheel', this.onWheelBound, { passive: false });
    this.build();
  }

  close(): void {
    window.removeEventListener('wheel', this.onWheelBound);
    this.destroyUI();
  }

  private build(): void {
    this.destroyUI();
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
      text: this.strings.get('loreBook', 'title'),
      style: { fontSize: 18, fill: UITheme.colors.title, fontFamily: UITheme.fonts.ui, fontWeight: 'bold', wordWrap: true, wordWrapWidth: PANEL_W - 40 },
    });
    title.x = px + PADDING;
    title.y = py + 12;
    this.container.addChild(title);

    const backBtn = new Text({
      text: this.strings.get('loreBook', 'back'),
      style: { fontSize: 13, fill: UITheme.colors.link, fontFamily: UITheme.fonts.ui, wordWrap: true, wordWrapWidth: 100 },
    });
    backBtn.x = px + PANEL_W - 100;
    backBtn.y = py + 14;
    backBtn.eventMode = 'static';
    backBtn.cursor = 'pointer';
    backBtn.on('pointerdown', () => this.onClose());
    this.container.addChild(backBtn);

    const lore = this.archiveData.getUnlockedLore();
    const listContainer = new Container();
    this.listContainer = listContainer;
    let cy = 50;

    if (lore.length === 0) {
      const empty = new Text({
        text: this.strings.get('loreBook', 'empty'),
        style: { fontSize: 12, fill: UITheme.colors.hint, fontFamily: UITheme.fonts.ui, wordWrap: true, wordWrapWidth: 160 },
      });
      empty.x = px + PADDING;
      empty.y = py + cy;
      listContainer.addChild(empty);
    } else {
      for (const entry of lore) {
        const isNew = !this.archiveData.isRead(`lore_${entry.id}`);
        const label = new Text({
          text: (isNew ? '* ' : '') + `[${this.categoryLabel(entry.category)}] ${entry.title}`,
          style: { fontSize: 13, fill: isNew ? UITheme.colors.title : UITheme.colors.subtle, fontFamily: UITheme.fonts.ui, wordWrap: true, wordWrapWidth: 160 },
        });
        label.x = px + PADDING;
        label.y = py + cy;
        label.eventMode = 'static';
        label.cursor = 'pointer';
        label.on('pointerdown', () => {
          this.archiveData.markRead(`lore_${entry.id}`);
          this.showContent(entry.content, entry.source, px + 200, py + 50);
        });
        listContainer.addChild(label);
        cy += ENTRY_H;
      }
    }

    this.listContentH = cy;
    const listMask = new Graphics();
    listMask.rect(px, py + 50, 180, PANEL_H - 70);
    listMask.fill({ color: 0xffffff });
    this.container.addChild(listMask);
    listContainer.mask = listMask;
    this.container.addChild(listContainer);

    this.renderer.uiLayer.addChild(this.container);
    fadeIn(this.container);
  }

  private showContent(content: string, source: string, x: number, y: number): void {
    if (this.contentText) {
      if (this.contentText.parent) this.contentText.parent.removeChild(this.contentText);
      this.contentText.destroy();
      this.contentText = null;
    }
    const ct = new Text({
      text: content + `\n\n${this.strings.get('loreBook', 'source')} ${source}`,
      style: { fontSize: 12, fill: UITheme.colors.subtle, fontFamily: UITheme.fonts.ui, wordWrap: true, wordWrapWidth: PANEL_W - 240 },
    });
    ct.x = x;
    ct.y = y;
    this.container?.addChild(ct);
    this.contentText = ct;
  }

  private categoryLabel(cat: string): string {
    return this.archiveData.getLoreCategoryName(cat);
  }

  private onWheel(e: WheelEvent): void {
    if (!this.listContainer) return;
    e.preventDefault();
    const maxScroll = Math.max(0, this.listContentH - (PANEL_H - 70));
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset + e.deltaY, maxScroll));
    this.listContainer.y = -this.scrollOffset;
  }

  private destroyUI(): void {
    if (this.container) {
      if (this.container.parent) this.container.parent.removeChild(this.container);
      this.container.destroy({ children: true });
      this.container = null;
    }
  }
}
