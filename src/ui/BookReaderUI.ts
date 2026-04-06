import { Container, Graphics, Text } from 'pixi.js';
import { UITheme, fadeIn } from './UITheme';
import { buildRichContent } from './RichContent';
import type { Renderer } from '../rendering/Renderer';
import type { BookDef, IArchiveDataProvider } from '../data/types';
import type { StringsProvider } from '../core/StringsProvider';
import type { AssetManager } from '../core/AssetManager';

const PANEL_W = 600;
const PANEL_H = 480;
const PADDING = 24;
const CONTENT_TOP = 46;
const CONTENT_H = PANEL_H - 80;

export class BookReaderUI {
  private renderer: Renderer;
  private archiveData: IArchiveDataProvider;
  private assetManager: AssetManager;
  private container: Container | null = null;
  private currentBook: BookDef | null = null;
  private currentPage = 0;
  private onCloseCb: (() => void) | null = null;
  private onKeyBound: (e: KeyboardEvent) => void;
  private onWheelBound: (e: WheelEvent) => void;
  private strings: StringsProvider;
  private contentContainer: Container | null = null;
  private contentScrollOffset = 0;
  private contentTotalH = 0;

  constructor(renderer: Renderer, archiveData: IArchiveDataProvider, strings: StringsProvider, assetManager: AssetManager) {
    this.renderer = renderer;
    this.archiveData = archiveData;
    this.assetManager = assetManager;
    this.onKeyBound = this.onKey.bind(this);
    this.onWheelBound = this.onWheel.bind(this);
    this.strings = strings;
  }

  openBook(book: BookDef, onClose: () => void): void {
    this.currentBook = book;
    this.currentPage = 0;
    this.onCloseCb = onClose;
    window.addEventListener('keydown', this.onKeyBound);
    window.addEventListener('wheel', this.onWheelBound, { passive: false });
    this.build();
  }

  close(): void {
    window.removeEventListener('keydown', this.onKeyBound);
    window.removeEventListener('wheel', this.onWheelBound);
    this.destroyUI();
    this.currentBook = null;
    this.onCloseCb = null;
  }

  destroy(): void {
    this.close();
  }

  private build(): void {
    this.destroyUI();
    if (!this.currentBook) return;

    this.contentScrollOffset = 0;
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
    bg.fill({ color: UITheme.colors.bookBg, alpha: UITheme.alpha.panelBg });
    bg.roundRect(px, py, PANEL_W, PANEL_H, UITheme.panel.borderRadius);
    bg.stroke({ color: UITheme.colors.panelBorder, width: 1 });
    this.container.addChild(bg);

    const title = new Text({
      text: this.currentBook.title,
      style: { fontSize: 18, fill: UITheme.colors.title, fontFamily: UITheme.fonts.display, fontWeight: 'bold', wordWrap: true, breakWords: true, wordWrapWidth: PANEL_W - PADDING * 2 },
    });
    title.x = px + PADDING;
    title.y = py + 14;
    this.container.addChild(title);

    const backBtn = new Text({
      text: this.strings.get('bookReader', 'back'),
      style: { fontSize: 13, fill: UITheme.colors.link, fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true, wordWrapWidth: 100 },
    });
    backBtn.x = px + PANEL_W - 100;
    backBtn.y = py + 14;
    backBtn.eventMode = 'static';
    backBtn.cursor = 'pointer';
    backBtn.on('pointerdown', () => { if (this.onCloseCb) this.onCloseCb(); });
    this.container.addChild(backBtn);

    const pages = this.archiveData.getBookVisiblePages(this.currentBook);
    const page = pages[this.currentPage];

    if (page) {
      if (page.unlocked) {
        let contentY = py + CONTENT_TOP;

        if (page.title) {
          const pt = new Text({
            text: page.title,
            style: { fontSize: 15, fill: UITheme.colors.ruleName, fontFamily: UITheme.fonts.display, fontWeight: 'bold', wordWrap: true, breakWords: true, wordWrapWidth: PANEL_W - PADDING * 2 },
          });
          pt.x = px + PADDING;
          pt.y = py + 50;
          this.container.addChild(pt);
          contentY = py + 80;
        }

        let raw = page.content;
        if (page.illustration) {
          raw = `[img:${page.illustration}]\n${raw}`;
        }

        const { container: rc, totalHeight } = buildRichContent(raw, {
          width: PANEL_W - PADDING * 2,
          fontSize: 13,
          fill: UITheme.colors.bodyDim,
          fontFamily: UITheme.fonts.display,
          lineHeight: 22,
        }, this.assetManager);

        rc.x = px + PADDING;
        rc.y = contentY;
        this.contentContainer = rc;
        this.contentTotalH = totalHeight;
        this.container.addChild(rc);

        const contentMask = new Graphics();
        contentMask.rect(px + PADDING, py + CONTENT_TOP, PANEL_W - PADDING * 2, CONTENT_H);
        contentMask.fill({ color: 0xffffff });
        this.container.addChild(contentMask);
        rc.mask = contentMask;
      } else {
        const missing = new Text({
          text: this.strings.get('bookReader', 'pageMissing'),
          style: { fontSize: 16, fill: UITheme.colors.disabledDark, fontFamily: UITheme.fonts.display, fontStyle: 'italic', wordWrap: true, breakWords: true, wordWrapWidth: PANEL_W - PADDING * 2 },
        });
        missing.x = px + (PANEL_W - missing.width) / 2;
        missing.y = py + PANEL_H / 2 - 20;
        this.container.addChild(missing);
      }
    }

    const pageInfo = new Text({
      text: `${this.currentPage + 1} / ${pages.length}    ${this.strings.get('bookReader', 'pageHint')}`,
      style: { fontSize: 11, fill: UITheme.colors.pageInfo, fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true, wordWrapWidth: 200 },
    });
    pageInfo.x = px + (PANEL_W - pageInfo.width) / 2;
    pageInfo.y = py + PANEL_H - 28;
    this.container.addChild(pageInfo);

    if (this.currentPage > 0) {
      const prevBg = new Graphics();
      prevBg.roundRect(px + 6, py + PANEL_H / 2 - 20, 30, 40, UITheme.panel.borderRadiusSmall);
      prevBg.fill({ color: UITheme.colors.rowBg, alpha: UITheme.alpha.rowBg });
      prevBg.eventMode = 'static';
      prevBg.cursor = 'pointer';
      prevBg.on('pointerdown', () => { this.currentPage--; this.build(); });
      this.container.addChild(prevBg);
      const prevText = new Text({ text: '<', style: { fontSize: 20, fill: UITheme.colors.link, fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true, wordWrapWidth: 100 } });
      prevText.x = px + 14;
      prevText.y = py + PANEL_H / 2 - 12;
      prevText.eventMode = 'none';
      this.container.addChild(prevText);
    }

    if (this.currentPage < pages.length - 1) {
      const nextBg = new Graphics();
      nextBg.roundRect(px + PANEL_W - 36, py + PANEL_H / 2 - 20, 30, 40, UITheme.panel.borderRadiusSmall);
      nextBg.fill({ color: UITheme.colors.rowBg, alpha: UITheme.alpha.rowBg });
      nextBg.eventMode = 'static';
      nextBg.cursor = 'pointer';
      nextBg.on('pointerdown', () => { this.currentPage++; this.build(); });
      this.container.addChild(nextBg);
      const nextText = new Text({ text: '>', style: { fontSize: 20, fill: UITheme.colors.link, fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true, wordWrapWidth: 100 } });
      nextText.x = px + PANEL_W - 28;
      nextText.y = py + PANEL_H / 2 - 12;
      nextText.eventMode = 'none';
      this.container.addChild(nextText);
    }

    this.renderer.uiLayer.addChild(this.container);
    fadeIn(this.container);
  }

  private onWheel(e: WheelEvent): void {
    if (!this.contentContainer) return;
    const maxScroll = Math.max(0, this.contentTotalH - CONTENT_H);
    if (maxScroll <= 0) return;
    e.preventDefault();
    this.contentScrollOffset = Math.max(0, Math.min(this.contentScrollOffset + e.deltaY, maxScroll));

    const sw = this.renderer.screenWidth;
    const sh = this.renderer.screenHeight;
    const py = (sh - PANEL_H) / 2;
    const baseY = py + CONTENT_TOP;
    const pages = this.currentBook ? this.archiveData.getBookVisiblePages(this.currentBook) : [];
    const page = pages[this.currentPage];
    const offset = page?.title ? 34 : 0;
    this.contentContainer.y = baseY + offset - this.contentScrollOffset;
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.currentBook) return;
    const pages = this.archiveData.getBookVisiblePages(this.currentBook);
    if (e.code === 'ArrowLeft' && this.currentPage > 0) {
      this.currentPage--;
      this.build();
    } else if (e.code === 'ArrowRight' && this.currentPage < pages.length - 1) {
      this.currentPage++;
      this.build();
    }
  }

  private destroyUI(): void {
    this.contentContainer = null;
    if (this.container) {
      if (this.container.parent) this.container.parent.removeChild(this.container);
      this.container.destroy({ children: true });
      this.container = null;
    }
  }
}
