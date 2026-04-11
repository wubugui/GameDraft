import { Container, Graphics, Text } from 'pixi.js';
import { UITheme, fadeIn } from './UITheme';
import { buildRichContent } from './RichContent';
import type { Renderer } from '../rendering/Renderer';
import type { IArchiveDataProvider } from '../data/types';
import type { StringsProvider } from '../core/StringsProvider';
import type { AssetManager } from '../core/AssetManager';

const PANEL_W = 650;
const PANEL_H = 500;
const PADDING = 20;
const ENTRY_H = 28;
const CONTENT_X_OFFSET = 200;
const CONTENT_AREA_W = PANEL_W - CONTENT_X_OFFSET - PADDING;
const CONTENT_AREA_H = PANEL_H - 70;

export class LoreBookUI {
  private renderer: Renderer;
  private archiveData: IArchiveDataProvider;
  private assetManager: AssetManager;
  private container: Container | null = null;
  private onClose: () => void;
  private strings: StringsProvider;
  private contentContainer: Container | null = null;
  private contentMask: Graphics | null = null;
  private contentScrollOffset = 0;
  private contentTotalH = 0;
  private listScrollOffset = 0;
  private listContentH = 0;
  private listContainer: Container | null = null;
  private onWheelBound: (e: WheelEvent) => void;
  private panelX = 0;

  constructor(renderer: Renderer, archiveData: IArchiveDataProvider, onClose: () => void, strings: StringsProvider, assetManager: AssetManager) {
    this.renderer = renderer;
    this.archiveData = archiveData;
    this.assetManager = assetManager;
    this.onClose = onClose;
    this.strings = strings;
    this.onWheelBound = (e) => this.onWheel(e);
  }

  destroy(): void {
    this.close();
  }

  open(): void {
    this.listScrollOffset = 0;
    this.contentScrollOffset = 0;
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
    this.panelX = px;

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
      style: { fontSize: 18, fill: UITheme.colors.title, fontFamily: UITheme.fonts.ui, fontWeight: 'bold', wordWrap: true, breakWords: true, wordWrapWidth: PANEL_W - 40 },
    });
    title.x = px + PADDING;
    title.y = py + 12;
    this.container.addChild(title);

    const backBtn = new Text({
      text: this.strings.get('loreBook', 'back'),
      style: { fontSize: 13, fill: UITheme.colors.link, fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true, wordWrapWidth: 100 },
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
        style: { fontSize: 12, fill: UITheme.colors.hint, fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true, wordWrapWidth: 160 },
      });
      empty.x = px + PADDING;
      empty.y = py + cy;
      listContainer.addChild(empty);
    } else {
      for (const entry of lore) {
        const isNew = !this.archiveData.isRead(`lore_${entry.id}`);
        const label = new Text({
          text: (isNew ? '* ' : '') + `[${this.categoryLabel(entry.category)}] ${entry.title}`,
          style: { fontSize: 13, fill: isNew ? UITheme.colors.title : UITheme.colors.subtle, fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true, wordWrapWidth: 160 },
        });
        label.x = px + PADDING;
        label.y = py + cy;
        label.eventMode = 'static';
        label.cursor = 'pointer';
        label.on('pointerdown', () => {
          this.archiveData.triggerFirstViewIfNeeded(`lore_${entry.id}`, entry.firstViewActions);
          this.archiveData.markRead(`lore_${entry.id}`);
          this.showContent(entry.content, entry.source, px + CONTENT_X_OFFSET, py + 50);
        });
        listContainer.addChild(label);
        cy += ENTRY_H;
      }
    }

    this.listContentH = cy;
    const listMask = new Graphics();
    listMask.rect(px, py + 50, 180, CONTENT_AREA_H);
    listMask.fill({ color: 0xffffff });
    this.container.addChild(listMask);
    listContainer.mask = listMask;
    this.container.addChild(listContainer);

    this.renderer.uiLayer.addChild(this.container);
    fadeIn(this.container);
  }

  private showContent(content: string, source: string, x: number, y: number): void {
    if (this.contentContainer) {
      if (this.contentContainer.parent) this.contentContainer.parent.removeChild(this.contentContainer);
      this.contentContainer.destroy({ children: true });
      this.contentContainer = null;
    }
    if (this.contentMask) {
      if (this.contentMask.parent) this.contentMask.parent.removeChild(this.contentMask);
      this.contentMask.destroy();
      this.contentMask = null;
    }
    this.contentScrollOffset = 0;

    const fullText = content + `\n\n${this.strings.get('loreBook', 'source')} ${source}`;
    const { container: rc, totalHeight } = buildRichContent(fullText, {
      width: CONTENT_AREA_W,
      fontSize: 12,
      fill: UITheme.colors.subtle,
      fontFamily: UITheme.fonts.ui,
    }, this.assetManager);

    rc.x = x;
    rc.y = y;
    this.contentContainer = rc;
    this.contentTotalH = totalHeight;

    const sh = this.renderer.screenHeight;
    const py = (sh - PANEL_H) / 2;
    const mask = new Graphics();
    mask.rect(x, py + 50, CONTENT_AREA_W, CONTENT_AREA_H);
    mask.fill({ color: 0xffffff });
    this.contentMask = mask;
    this.container?.addChild(mask);
    rc.mask = mask;
    this.container?.addChild(rc);
  }

  private categoryLabel(cat: string): string {
    return this.archiveData.getLoreCategoryName(cat);
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const sw = this.renderer.screenWidth;
    const mouseInContentArea = e.clientX > this.panelX + CONTENT_X_OFFSET;

    if (mouseInContentArea && this.contentContainer) {
      const maxScroll = Math.max(0, this.contentTotalH - CONTENT_AREA_H);
      if (maxScroll <= 0) return;
      this.contentScrollOffset = Math.max(0, Math.min(this.contentScrollOffset + e.deltaY, maxScroll));
      const sh = this.renderer.screenHeight;
      const py = (sh - PANEL_H) / 2;
      this.contentContainer.y = py + 50 - this.contentScrollOffset;
    } else if (this.listContainer) {
      const maxScroll = Math.max(0, this.listContentH - CONTENT_AREA_H);
      if (maxScroll <= 0) return;
      this.listScrollOffset = Math.max(0, Math.min(this.listScrollOffset + e.deltaY, maxScroll));
      this.listContainer.y = -this.listScrollOffset;
    }
  }

  private destroyUI(): void {
    this.contentContainer = null;
    this.listContainer = null;
    if (this.container) {
      if (this.container.parent) this.container.parent.removeChild(this.container);
      this.container.destroy({ children: true });
      this.container = null;
    }
  }
}
