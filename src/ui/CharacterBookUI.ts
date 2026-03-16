import { Container, Graphics, Text } from 'pixi.js';
import type { Renderer } from '../rendering/Renderer';
import type { IArchiveDataProvider } from '../data/types';

const PANEL_W = 650;
const PANEL_H = 500;
const PADDING = 20;
const ENTRY_H = 30;

export class CharacterBookUI {
  private renderer: Renderer;
  private archiveData: IArchiveDataProvider;
  private container: Container | null = null;
  private detailContainer: Container | null = null;
  private onClose: () => void;

  constructor(renderer: Renderer, archiveData: IArchiveDataProvider, onClose: () => void) {
    this.renderer = renderer;
    this.archiveData = archiveData;
    this.onClose = onClose;
  }

  open(): void {
    this.build();
  }

  close(): void {
    this.destroyUI();
  }

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
      text: '人物簿',
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

    const characters = this.archiveData.getUnlockedCharacters();
    const listWidth = 180;

    if (characters.length === 0) {
      const empty = new Text({
        text: '(暂无人物记录)',
        style: { fontSize: 12, fill: 0x555566, fontFamily: 'sans-serif' },
      });
      empty.x = px + PADDING;
      empty.y = py + 50;
      this.container.addChild(empty);
    }

    characters.forEach((ch, i) => {
      const isNew = !this.archiveData.isRead(`char_${ch.id}`);
      const label = new Text({
        text: (isNew ? '* ' : '') + ch.name,
        style: { fontSize: 13, fill: isNew ? 0xffcc88 : 0xaaaacc, fontFamily: 'sans-serif' },
      });
      label.x = px + PADDING;
      label.y = py + 50 + i * ENTRY_H;
      label.eventMode = 'static';
      label.cursor = 'pointer';
      label.on('pointerdown', () => {
        this.archiveData.markRead(`char_${ch.id}`);
        this.showDetail(ch.id, px + PADDING + listWidth, py + 50);
      });
      this.container!.addChild(label);
    });

    this.renderer.uiLayer.addChild(this.container!);
  }

  private showDetail(charId: string, dx: number, dy: number): void {
    if (this.detailContainer) {
      if (this.detailContainer.parent) this.detailContainer.parent.removeChild(this.detailContainer);
      this.detailContainer.destroy({ children: true });
    }
    this.detailContainer = new Container();

    const chars = this.archiveData.getUnlockedCharacters();
    const ch = chars.find(c => c.id === charId);
    if (!ch) return;

    let cy = 0;
    const nameT = new Text({
      text: `${ch.name} - ${ch.title}`,
      style: { fontSize: 15, fill: 0xffcc88, fontFamily: 'sans-serif', fontWeight: 'bold' },
    });
    nameT.y = cy;
    this.detailContainer.addChild(nameT);
    cy += 30;

    const impressions = this.archiveData.getCharacterVisibleImpressions(ch);
    if (impressions.length > 0) {
      const hdr = new Text({ text: '印象:', style: { fontSize: 12, fill: 0x888899, fontFamily: 'sans-serif' } });
      hdr.y = cy; cy += 18;
      this.detailContainer.addChild(hdr);
      for (const imp of impressions) {
        const t = new Text({
          text: `  ${imp}`,
          style: { fontSize: 12, fill: 0xaaaacc, fontFamily: 'sans-serif', wordWrap: true, wordWrapWidth: 380 },
        });
        t.y = cy; cy += t.height + 4;
        this.detailContainer.addChild(t);
      }
      cy += 8;
    }

    const infos = this.archiveData.getCharacterVisibleInfo(ch);
    if (infos.length > 0) {
      const hdr = new Text({ text: '已知情报:', style: { fontSize: 12, fill: 0x888899, fontFamily: 'sans-serif' } });
      hdr.y = cy; cy += 18;
      this.detailContainer.addChild(hdr);
      for (const info of infos) {
        const t = new Text({
          text: `  ${info}`,
          style: { fontSize: 12, fill: 0xaaaacc, fontFamily: 'sans-serif', wordWrap: true, wordWrapWidth: 380 },
        });
        t.y = cy; cy += t.height + 4;
        this.detailContainer.addChild(t);
      }
    }

    this.detailContainer.x = dx;
    this.detailContainer.y = dy;
    this.container?.addChild(this.detailContainer);
  }

  private destroyUI(): void {
    if (this.detailContainer) {
      this.detailContainer.destroy({ children: true });
      this.detailContainer = null;
    }
    if (this.container) {
      if (this.container.parent) this.container.parent.removeChild(this.container);
      this.container.destroy({ children: true });
      this.container = null;
    }
  }
}
