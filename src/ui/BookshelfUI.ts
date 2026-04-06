import { Container, Graphics, Text } from 'pixi.js';
import { UITheme, fadeIn } from './UITheme';
import type { Renderer } from '../rendering/Renderer';
import type { IArchiveDataProvider, BookDef } from '../data/types';
import type { StringsProvider } from '../core/StringsProvider';

const PANEL_W = 700;
const PANEL_H = 520;
const PADDING = 20;
const BOOK_W = 100;
const BOOK_H = 140;
const BOOK_GAP = 16;

interface BookSlot {
  id: string;
  label: string;
  color: number;
  hasUnread: boolean;
}

/** 打开子面板的回调类型，返回带 close 的句柄 */
export type OnOpenSubPanel = (onClose: () => void) => { close(): void };
/** 打开独立书籍时的回调，返回带 close 的句柄供书架在关闭子面板时使用 */
export type OnOpenBook = (book: BookDef, onClose: () => void) => { close(): void };

export class BookshelfUI {
  private renderer: Renderer;
  private archiveData: IArchiveDataProvider;
  private container: Container | null = null;
  private _isOpen = false;
  private activeSubPanel: { close(): void } | null = null;
  private onOpenRules: () => void;
  private onOpenBook: OnOpenBook;
  private onOpenCharacters: OnOpenSubPanel;
  private onOpenLore: OnOpenSubPanel;
  private onOpenDocuments: OnOpenSubPanel;
  private strings: StringsProvider;

  constructor(
    renderer: Renderer,
    archiveData: IArchiveDataProvider,
    onOpenRules: () => void,
    onOpenBook: OnOpenBook,
    onOpenCharacters: OnOpenSubPanel,
    onOpenLore: OnOpenSubPanel,
    onOpenDocuments: OnOpenSubPanel,
    strings: StringsProvider,
  ) {
    this.renderer = renderer;
    this.archiveData = archiveData;
    this.onOpenRules = onOpenRules;
    this.onOpenBook = onOpenBook;
    this.onOpenCharacters = onOpenCharacters;
    this.onOpenLore = onOpenLore;
    this.onOpenDocuments = onOpenDocuments;
    this.strings = strings;
  }

  get isOpen(): boolean { return this._isOpen; }

  open(): void {
    if (this._isOpen) return;
    this._isOpen = true;
    this.buildShelf();
  }

  close(): void {
    if (!this._isOpen) return;
    this._isOpen = false;
    this.closeSubPanel();
    this.destroyUI();
  }

  private buildShelf(): void {
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
    bg.fill({ color: UITheme.colors.panelBgAlt, alpha: UITheme.alpha.panelBg });
    bg.roundRect(px, py, PANEL_W, PANEL_H, UITheme.panel.borderRadius);
    bg.stroke({ color: UITheme.colors.panelBorder, width: 1 });
    this.container.addChild(bg);

    const title = new Text({
      text: this.strings.get('bookshelf', 'title'),
      style: { fontSize: 20, fill: UITheme.colors.title, fontFamily: UITheme.fonts.display, fontWeight: 'bold', wordWrap: true, breakWords: true, wordWrapWidth: PANEL_W - 40 },
    });
    title.x = px + PADDING;
    title.y = py + 14;
    this.container.addChild(title);

    const hint = new Text({
      text: this.strings.get('bookshelf', 'closeHint'),
      style: { fontSize: 11, fill: UITheme.colors.hint, fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true, wordWrapWidth: PANEL_W - 40 },
    });
    hint.x = px + PANEL_W - 80;
    hint.y = py + PANEL_H - 24;
    this.container.addChild(hint);

    const fixedBooks: BookSlot[] = [
      { id: 'rules', label: this.strings.get('bookshelf', 'rules'), color: 0x8b4513, hasUnread: false },
      { id: 'character', label: this.strings.get('bookshelf', 'characters'), color: 0x2e4057, hasUnread: this.archiveData.hasUnread('character') },
      { id: 'lore', label: this.strings.get('bookshelf', 'lore'), color: 0x3e5641, hasUnread: this.archiveData.hasUnread('lore') },
      { id: 'document', label: this.strings.get('bookshelf', 'documents'), color: 0x5c4033, hasUnread: this.archiveData.hasUnread('document') },
    ];

    const dynamicBooks = this.archiveData.getUnlockedBooks();

    const startX = px + PADDING + 20;
    const startY = py + 70;

    fixedBooks.forEach((slot, i) => {
      this.drawBookSlot(slot, startX + i * (BOOK_W + BOOK_GAP), startY);
    });

    dynamicBooks.forEach((book, i) => {
      const idx = fixedBooks.length + i;
      const col = idx % 5;
      const row = Math.floor(idx / 5);
      this.drawBookSlot(
        { id: `book_${book.id}`, label: book.title, color: 0x4a3728, hasUnread: false },
        startX + col * (BOOK_W + BOOK_GAP),
        startY + row * (BOOK_H + 30),
      );
    });

    this.renderer.uiLayer.addChild(this.container);
    fadeIn(this.container);
  }

  private drawBookSlot(slot: BookSlot, x: number, y: number): void {
    const bookGfx = new Graphics();
    bookGfx.roundRect(x, y, BOOK_W, BOOK_H, UITheme.panel.borderRadiusSmall);
    bookGfx.fill({ color: slot.color, alpha: UITheme.alpha.bookSpine });
    bookGfx.roundRect(x, y, BOOK_W, BOOK_H, UITheme.panel.borderRadiusSmall);
    bookGfx.stroke({ color: UITheme.colors.bookBorder, width: 1 });

    bookGfx.eventMode = 'static';
    bookGfx.cursor = 'pointer';
    bookGfx.on('pointerdown', () => this.onBookClick(slot.id));
    bookGfx.on('pointerover', () => { bookGfx.alpha = 0.8; });
    bookGfx.on('pointerout', () => { bookGfx.alpha = 1; });
    this.container?.addChild(bookGfx);

    const label = new Text({
      text: slot.label,
      style: { fontSize: 12, fill: UITheme.colors.bookLabel, fontFamily: UITheme.fonts.display, align: 'center', wordWrap: true, breakWords: true, wordWrapWidth: BOOK_W - 10 },
    });
    label.x = x + (BOOK_W - label.width) / 2;
    label.y = y + BOOK_H / 2 - label.height / 2;
    label.eventMode = 'none';
    this.container?.addChild(label);

    if (slot.hasUnread) {
      const dot = new Graphics();
      dot.circle(x + BOOK_W - 8, y + 8, 5);
      dot.fill(UITheme.colors.redDot);
      this.container?.addChild(dot);
    }
  }

  private onBookClick(bookId: string): void {
    this.closeSubPanel();

    if (bookId === 'rules') {
      this.close();
      this.onOpenRules();
      return;
    }

    if (bookId === 'character') {
      this.activeSubPanel = this.onOpenCharacters(() => {
        this.closeSubPanel();
        this.buildShelf();
      });
      this.destroyShelfOnly();
      return;
    }

    if (bookId === 'lore') {
      this.activeSubPanel = this.onOpenLore(() => {
        this.closeSubPanel();
        this.buildShelf();
      });
      this.destroyShelfOnly();
      return;
    }

    if (bookId === 'document') {
      this.activeSubPanel = this.onOpenDocuments(() => {
        this.closeSubPanel();
        this.buildShelf();
      });
      this.destroyShelfOnly();
      return;
    }

    if (bookId.startsWith('book_')) {
      const realId = bookId.substring(5);
      const books = this.archiveData.getBooks();
      const book = books.find(b => b.id === realId);
      if (book) {
        this.activeSubPanel = this.onOpenBook(book, () => {
          this.closeSubPanel();
          this.buildShelf();
        });
        this.destroyShelfOnly();
      }
    }
  }

  private closeSubPanel(): void {
    if (this.activeSubPanel) {
      this.activeSubPanel.close();
      this.activeSubPanel = null;
    }
  }

  private destroyShelfOnly(): void {
    if (this.container) {
      if (this.container.parent) this.container.parent.removeChild(this.container);
      this.container.destroy({ children: true });
      this.container = null;
    }
  }

  private destroyUI(): void {
    this.destroyShelfOnly();
  }

  destroy(): void {
    this.close();
  }
}
