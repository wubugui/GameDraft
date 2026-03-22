import { Container, Graphics, Text } from 'pixi.js';
import type { Renderer } from '../rendering/Renderer';
import type { BookDef, IArchiveDataProvider } from '../data/types';
import type { StringsProvider } from '../core/StringsProvider';

const PANEL_W = 600;
const PANEL_H = 480;
const PADDING = 24;

export class BookReaderUI {
  private renderer: Renderer;
  private archiveData: IArchiveDataProvider;
  private container: Container | null = null;
  private currentBook: BookDef | null = null;
  private currentPage = 0;
  private onCloseCb: (() => void) | null = null;
  private onKeyBound: (e: KeyboardEvent) => void;
  private strings: StringsProvider;

  constructor(renderer: Renderer, archiveData: IArchiveDataProvider, strings: StringsProvider) {
    this.renderer = renderer;
    this.archiveData = archiveData;
    this.onKeyBound = this.onKey.bind(this);
    this.strings = strings;
  }

  openBook(book: BookDef, onClose: () => void): void {
    this.currentBook = book;
    this.currentPage = 0;
    this.onCloseCb = onClose;
    window.addEventListener('keydown', this.onKeyBound);
    this.build();
  }

  close(): void {
    window.removeEventListener('keydown', this.onKeyBound);
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

    this.container = new Container();
    const sw = this.renderer.screenWidth;
    const sh = this.renderer.screenHeight;
    const px = (sw - PANEL_W) / 2;
    const py = (sh - PANEL_H) / 2;

    const bg = new Graphics();
    bg.roundRect(px, py, PANEL_W, PANEL_H, 8);
    bg.fill({ color: 0x1a1a1a, alpha: 0.95 });
    bg.roundRect(px, py, PANEL_W, PANEL_H, 8);
    bg.stroke({ color: 0x444466, width: 1 });
    this.container.addChild(bg);

    const title = new Text({
      text: this.currentBook.title,
      style: { fontSize: 18, fill: 0xffcc88, fontFamily: 'serif', fontWeight: 'bold' },
    });
    title.x = px + PADDING;
    title.y = py + 14;
    this.container.addChild(title);

    const backBtn = new Text({
      text: this.strings.get('bookReader', 'back'),
      style: { fontSize: 13, fill: 0x8888aa, fontFamily: 'sans-serif' },
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
        if (page.title) {
          const pt = new Text({
            text: page.title,
            style: { fontSize: 15, fill: 0xddccaa, fontFamily: 'serif', fontWeight: 'bold' },
          });
          pt.x = px + PADDING;
          pt.y = py + 50;
          this.container.addChild(pt);
        }

        const content = new Text({
          text: page.content,
          style: {
            fontSize: 13,
            fill: 0xbbbbcc,
            fontFamily: 'serif',
            wordWrap: true,
            wordWrapWidth: PANEL_W - PADDING * 2,
            lineHeight: 22,
          },
        });
        content.x = px + PADDING;
        content.y = py + (page.title ? 80 : 50);
        this.container.addChild(content);
      } else {
        const missing = new Text({
          text: this.strings.get('bookReader', 'pageMissing'),
          style: { fontSize: 16, fill: 0x555555, fontFamily: 'serif', fontStyle: 'italic' },
        });
        missing.x = px + (PANEL_W - missing.width) / 2;
        missing.y = py + PANEL_H / 2 - 20;
        this.container.addChild(missing);
      }
    }

    const pageInfo = new Text({
      text: `${this.currentPage + 1} / ${pages.length}    ${this.strings.get('bookReader', 'pageHint')}`,
      style: { fontSize: 11, fill: 0x666677, fontFamily: 'sans-serif' },
    });
    pageInfo.x = px + (PANEL_W - pageInfo.width) / 2;
    pageInfo.y = py + PANEL_H - 28;
    this.container.addChild(pageInfo);

    if (this.currentPage > 0) {
      const prev = new Text({
        text: '<',
        style: { fontSize: 20, fill: 0x8888aa, fontFamily: 'sans-serif' },
      });
      prev.x = px + 10;
      prev.y = py + PANEL_H / 2 - 10;
      prev.eventMode = 'static';
      prev.cursor = 'pointer';
      prev.on('pointerdown', () => { this.currentPage--; this.build(); });
      this.container.addChild(prev);
    }

    if (this.currentPage < pages.length - 1) {
      const next = new Text({
        text: '>',
        style: { fontSize: 20, fill: 0x8888aa, fontFamily: 'sans-serif' },
      });
      next.x = px + PANEL_W - 20;
      next.y = py + PANEL_H / 2 - 10;
      next.eventMode = 'static';
      next.cursor = 'pointer';
      next.on('pointerdown', () => { this.currentPage++; this.build(); });
      this.container.addChild(next);
    }

    this.renderer.uiLayer.addChild(this.container);
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
    if (this.container) {
      if (this.container.parent) this.container.parent.removeChild(this.container);
      this.container.destroy({ children: true });
      this.container = null;
    }
  }
}
