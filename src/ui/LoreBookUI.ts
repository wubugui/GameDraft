import { Container, Graphics, Text } from 'pixi.js';
import type { Renderer } from '../rendering/Renderer';
import type { IArchiveDataProvider } from '../data/types';

const PANEL_W = 650;
const PANEL_H = 500;
const PADDING = 20;
const ENTRY_H = 28;

export class LoreBookUI {
  private renderer: Renderer;
  private archiveData: IArchiveDataProvider;
  private container: Container | null = null;
  private onClose: () => void;

  constructor(renderer: Renderer, archiveData: IArchiveDataProvider, onClose: () => void) {
    this.renderer = renderer;
    this.archiveData = archiveData;
    this.onClose = onClose;
  }

  open(): void { this.build(); }
  close(): void { this.destroyUI(); }

  private build(): void {
    this.destroyUI();
    this.container = new Container();
    const sw = this.renderer.screenWidth;
    const sh = this.renderer.screenHeight;
    const px = (sw - PANEL_W) / 2;
    const py = (sh - PANEL_H) / 2;

    const bg = new Graphics();
    bg.roundRect(px, py, PANEL_W, PANEL_H, 8);
    bg.fill({ color: 0x111122, alpha: 0.95 });
    bg.roundRect(px, py, PANEL_W, PANEL_H, 8);
    bg.stroke({ color: 0x444466, width: 1 });
    this.container.addChild(bg);

    const title = new Text({
      text: '见闻录',
      style: { fontSize: 18, fill: 0xffcc88, fontFamily: 'sans-serif', fontWeight: 'bold' },
    });
    title.x = px + PADDING;
    title.y = py + 12;
    this.container.addChild(title);

    const backBtn = new Text({
      text: '[返回书架]',
      style: { fontSize: 13, fill: 0x8888aa, fontFamily: 'sans-serif' },
    });
    backBtn.x = px + PANEL_W - 100;
    backBtn.y = py + 14;
    backBtn.eventMode = 'static';
    backBtn.cursor = 'pointer';
    backBtn.on('pointerdown', () => this.onClose());
    this.container.addChild(backBtn);

    const lore = this.archiveData.getUnlockedLore();
    let cy = 50;

    if (lore.length === 0) {
      const empty = new Text({
        text: '(暂无见闻)',
        style: { fontSize: 12, fill: 0x555566, fontFamily: 'sans-serif' },
      });
      empty.x = px + PADDING;
      empty.y = py + cy;
      this.container.addChild(empty);
    } else {
      for (const entry of lore) {
        const isNew = !this.archiveData.isRead(`lore_${entry.id}`);
        const label = new Text({
          text: (isNew ? '* ' : '') + `[${this.categoryLabel(entry.category)}] ${entry.title}`,
          style: { fontSize: 13, fill: isNew ? 0xffcc88 : 0xaaaacc, fontFamily: 'sans-serif' },
        });
        label.x = px + PADDING;
        label.y = py + cy;
        label.eventMode = 'static';
        label.cursor = 'pointer';
        label.on('pointerdown', () => {
          this.archiveData.markRead(`lore_${entry.id}`);
          this.showContent(entry.content, entry.source, px + PADDING, py + 50 + lore.length * ENTRY_H + 10);
        });
        this.container.addChild(label);
        cy += ENTRY_H;
      }
    }

    this.renderer.uiLayer.addChild(this.container);
  }

  private showContent(content: string, source: string, x: number, y: number): void {
    const ct = new Text({
      text: content + `\n\n-- 来源: ${source}`,
      style: { fontSize: 12, fill: 0xaaaacc, fontFamily: 'sans-serif', wordWrap: true, wordWrapWidth: PANEL_W - PADDING * 2 },
    });
    ct.x = x;
    ct.y = y;
    this.container?.addChild(ct);
  }

  private categoryLabel(cat: string): string {
    return this.archiveData.getLoreCategoryName(cat);
  }

  private destroyUI(): void {
    if (this.container) {
      if (this.container.parent) this.container.parent.removeChild(this.container);
      this.container.destroy({ children: true });
      this.container = null;
    }
  }
}
