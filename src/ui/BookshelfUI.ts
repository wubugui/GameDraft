import { Container, Graphics, Text } from 'pixi.js';
import type { Renderer } from '../rendering/Renderer';
import type { IArchiveDataProvider } from '../data/types';
import { CharacterBookUI } from './CharacterBookUI';
import { LoreBookUI } from './LoreBookUI';
import { DocumentBoxUI } from './DocumentBoxUI';
import type { BookReaderUI } from './BookReaderUI';

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

export class BookshelfUI {
  private renderer: Renderer;
  private archiveData: IArchiveDataProvider;
  private container: Container | null = null;
  private _isOpen = false;
  private activeSubPanel: { close(): void } | null = null;
  private bookReaderUI: BookReaderUI | null = null;
  private onOpenRules: () => void;

  constructor(
    renderer: Renderer,
    archiveData: IArchiveDataProvider,
    onOpenRules: () => void,
  ) {
    this.renderer = renderer;
    this.archiveData = archiveData;
    this.onOpenRules = onOpenRules;
  }

  setBookReaderUI(ui: BookReaderUI): void {
    this.bookReaderUI = ui;
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
    overlay.fill({ color: 0x000000, alpha: 0.5 });
    this.container.addChild(overlay);

    const bg = new Graphics();
    bg.roundRect(px, py, PANEL_W, PANEL_H, 8);
    bg.fill({ color: 0x1a1a2e, alpha: 0.95 });
    bg.roundRect(px, py, PANEL_W, PANEL_H, 8);
    bg.stroke({ color: 0x444466, width: 1 });
    this.container.addChild(bg);

    const title = new Text({
      text: '书架',
      style: { fontSize: 20, fill: 0xffcc88, fontFamily: 'serif', fontWeight: 'bold' },
    });
    title.x = px + PADDING;
    title.y = py + 14;
    this.container.addChild(title);

    const hint = new Text({
      text: '按 B 关闭',
      style: { fontSize: 11, fill: 0x555566, fontFamily: 'sans-serif' },
    });
    hint.x = px + PANEL_W - 80;
    hint.y = py + PANEL_H - 24;
    this.container.addChild(hint);

    const fixedBooks: BookSlot[] = [
      { id: 'rules', label: '规矩本', color: 0x8b4513, hasUnread: false },
      { id: 'character', label: '人物簿', color: 0x2e4057, hasUnread: this.archiveData.hasUnread('character') },
      { id: 'lore', label: '见闻录', color: 0x3e5641, hasUnread: this.archiveData.hasUnread('lore') },
      { id: 'document', label: '杂书匣', color: 0x5c4033, hasUnread: this.archiveData.hasUnread('document') },
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
  }

  private drawBookSlot(slot: BookSlot, x: number, y: number): void {
    const bookGfx = new Graphics();
    bookGfx.roundRect(x, y, BOOK_W, BOOK_H, 4);
    bookGfx.fill({ color: slot.color, alpha: 0.9 });
    bookGfx.roundRect(x, y, BOOK_W, BOOK_H, 4);
    bookGfx.stroke({ color: 0x666666, width: 1 });

    bookGfx.eventMode = 'static';
    bookGfx.cursor = 'pointer';
    bookGfx.on('pointerdown', () => this.onBookClick(slot.id));
    this.container?.addChild(bookGfx);

    const label = new Text({
      text: slot.label,
      style: { fontSize: 12, fill: 0xeeddcc, fontFamily: 'serif', align: 'center', wordWrap: true, wordWrapWidth: BOOK_W - 10 },
    });
    label.x = x + (BOOK_W - label.width) / 2;
    label.y = y + BOOK_H / 2 - label.height / 2;
    label.eventMode = 'none';
    this.container?.addChild(label);

    if (slot.hasUnread) {
      const dot = new Graphics();
      dot.circle(x + BOOK_W - 8, y + 8, 5);
      dot.fill(0xff6644);
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
      const sub = new CharacterBookUI(this.renderer, this.archiveData, () => {
        this.closeSubPanel();
        this.buildShelf();
      });
      sub.open();
      this.activeSubPanel = sub;
      this.destroyShelfOnly();
      return;
    }

    if (bookId === 'lore') {
      const sub = new LoreBookUI(this.renderer, this.archiveData, () => {
        this.closeSubPanel();
        this.buildShelf();
      });
      sub.open();
      this.activeSubPanel = sub;
      this.destroyShelfOnly();
      return;
    }

    if (bookId === 'document') {
      const sub = new DocumentBoxUI(this.renderer, this.archiveData, () => {
        this.closeSubPanel();
        this.buildShelf();
      });
      sub.open();
      this.activeSubPanel = sub;
      this.destroyShelfOnly();
      return;
    }

    if (bookId.startsWith('book_') && this.bookReaderUI) {
      const realId = bookId.substring(5);
      const books = this.archiveData.getBooks();
      const book = books.find(b => b.id === realId);
      if (book) {
        this.bookReaderUI.openBook(book, () => {
          this.closeSubPanel();
          this.buildShelf();
        });
        this.activeSubPanel = this.bookReaderUI;
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
}
