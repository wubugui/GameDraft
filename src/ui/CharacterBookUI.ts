import { Container, Graphics, Text } from 'pixi.js';
import { UITheme, fadeIn } from './UITheme';
import type { Renderer } from '../rendering/Renderer';
import type { IArchiveDataProvider } from '../data/types';
import type { StringsProvider } from '../core/StringsProvider';

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
  private strings: StringsProvider;
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
      text: this.strings.get('characterBook', 'title'),
      style: { fontSize: 18, fill: UITheme.colors.title, fontFamily: UITheme.fonts.ui, fontWeight: 'bold', wordWrap: true, wordWrapWidth: PANEL_W - 40 },
    });
    title.x = px + PADDING;
    title.y = py + 12;
    this.container.addChild(title);

    const backBtn = new Text({
      text: this.strings.get('characterBook', 'back'),
      style: { fontSize: 13, fill: UITheme.colors.link, fontFamily: UITheme.fonts.ui, wordWrap: true, wordWrapWidth: 100 },
    });
    backBtn.x = px + PANEL_W - 100;
    backBtn.y = py + 14;
    backBtn.eventMode = 'static';
    backBtn.cursor = 'pointer';
    backBtn.on('pointerdown', () => this.onClose());
    this.container.addChild(backBtn);

    const characters = this.archiveData.getUnlockedCharacters();
    const listWidth = 180;
    const listContainer = new Container();
    this.listContainer = listContainer;

    if (characters.length === 0) {
      const empty = new Text({
        text: this.strings.get('characterBook', 'empty'),
        style: { fontSize: 12, fill: UITheme.colors.hint, fontFamily: UITheme.fonts.ui, wordWrap: true, wordWrapWidth: 160 },
      });
      empty.x = px + PADDING;
      empty.y = py + 50;
      listContainer.addChild(empty);
    }

    characters.forEach((ch, i) => {
      const isNew = !this.archiveData.isRead(`char_${ch.id}`);
      const label = new Text({
        text: (isNew ? '* ' : '') + ch.name,
        style: { fontSize: 13, fill: isNew ? UITheme.colors.title : UITheme.colors.subtle, fontFamily: UITheme.fonts.ui, wordWrap: true, wordWrapWidth: 160 },
      });
      label.x = px + PADDING;
      label.y = py + 50 + i * ENTRY_H;
      label.eventMode = 'static';
      label.cursor = 'pointer';
      label.on('pointerdown', () => {
        this.archiveData.markRead(`char_${ch.id}`);
        this.showDetail(ch.id, px + PADDING + listWidth, py + 50);
      });
      listContainer.addChild(label);
    });

    this.listContentH = 50 + characters.length * ENTRY_H;
    const listMask = new Graphics();
    listMask.rect(px, py + 50, listWidth, PANEL_H - 70);
    listMask.fill({ color: 0xffffff });
    this.container.addChild(listMask);
    listContainer.mask = listMask;
    this.container.addChild(listContainer);

    this.renderer.uiLayer.addChild(this.container);
    fadeIn(this.container);
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
      style: { fontSize: 15, fill: UITheme.colors.title, fontFamily: UITheme.fonts.ui, fontWeight: 'bold', wordWrap: true, wordWrapWidth: PANEL_W - 240 },
    });
    nameT.y = cy;
    this.detailContainer.addChild(nameT);
    cy += 30;

    const impressions = this.archiveData.getCharacterVisibleImpressions(ch);
    if (impressions.length > 0) {
      const hdr = new Text({ text: this.strings.get('characterBook', 'impression'), style: { fontSize: 12, fill: UITheme.colors.section, fontFamily: UITheme.fonts.ui, wordWrap: true, wordWrapWidth: PANEL_W - 240 } });
      hdr.y = cy; cy += 18;
      this.detailContainer.addChild(hdr);
      for (const imp of impressions) {
        const t = new Text({
          text: `  ${imp}`,
          style: { fontSize: 12, fill: UITheme.colors.subtle, fontFamily: UITheme.fonts.ui, wordWrap: true, wordWrapWidth: 380 },
        });
        t.y = cy; cy += t.height + 4;
        this.detailContainer.addChild(t);
      }
      cy += 8;
    }

    const infos = this.archiveData.getCharacterVisibleInfo(ch);
    if (infos.length > 0) {
      const hdr = new Text({ text: this.strings.get('characterBook', 'knownIntel'), style: { fontSize: 12, fill: UITheme.colors.section, fontFamily: UITheme.fonts.ui, wordWrap: true, wordWrapWidth: PANEL_W - 240 } });
      hdr.y = cy; cy += 18;
      this.detailContainer.addChild(hdr);
      for (const info of infos) {
        const t = new Text({
          text: `  ${info}`,
          style: { fontSize: 12, fill: UITheme.colors.subtle, fontFamily: UITheme.fonts.ui, wordWrap: true, wordWrapWidth: 380 },
        });
        t.y = cy; cy += t.height + 4;
        this.detailContainer.addChild(t);
      }
    }

    this.detailContainer.x = dx;
    this.detailContainer.y = dy;
    this.container?.addChild(this.detailContainer);
  }

  private onWheel(e: WheelEvent): void {
    if (!this.listContainer) return;
    e.preventDefault();
    const maxScroll = Math.max(0, this.listContentH - (PANEL_H - 70));
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset + e.deltaY, maxScroll));
    this.listContainer.y = -this.scrollOffset;
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
