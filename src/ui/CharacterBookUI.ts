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
const ENTRY_H = 30;
const LIST_WIDTH = 180;
const DETAIL_AREA_W = PANEL_W - LIST_WIDTH - PADDING * 2;
const DETAIL_AREA_H = PANEL_H - 70;

export class CharacterBookUI {
  private renderer: Renderer;
  private archiveData: IArchiveDataProvider;
  private assetManager: AssetManager;
  private container: Container | null = null;
  private detailContainer: Container | null = null;
  private detailMask: Graphics | null = null;
  private detailScrollOffset = 0;
  private detailTotalH = 0;
  private onClose: () => void;
  private strings: StringsProvider;
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
    this.detailScrollOffset = 0;
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
      text: this.strings.get('characterBook', 'title'),
      style: { fontSize: 18, fill: UITheme.colors.title, fontFamily: UITheme.fonts.ui, fontWeight: 'bold', wordWrap: true, breakWords: true, wordWrapWidth: PANEL_W - 40 },
    });
    title.x = px + PADDING;
    title.y = py + 12;
    this.container.addChild(title);

    const backBtn = new Text({
      text: this.strings.get('characterBook', 'back'),
      style: { fontSize: 13, fill: UITheme.colors.link, fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true, wordWrapWidth: 100 },
    });
    backBtn.x = px + PANEL_W - 100;
    backBtn.y = py + 14;
    backBtn.eventMode = 'static';
    backBtn.cursor = 'pointer';
    backBtn.on('pointerdown', () => this.onClose());
    this.container.addChild(backBtn);

    const characters = this.archiveData.getUnlockedCharacters();
    const listContainer = new Container();
    this.listContainer = listContainer;

    if (characters.length === 0) {
      const empty = new Text({
        text: this.strings.get('characterBook', 'empty'),
        style: { fontSize: 12, fill: UITheme.colors.hint, fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true, wordWrapWidth: 160 },
      });
      empty.x = px + PADDING;
      empty.y = py + 50;
      listContainer.addChild(empty);
    }

    characters.forEach((ch, i) => {
      const isNew = !this.archiveData.isRead(`char_${ch.id}`);
      const label = new Text({
        text: (isNew ? '* ' : '') + this.archiveData.resolveLine(ch.name),
        style: { fontSize: 13, fill: isNew ? UITheme.colors.title : UITheme.colors.subtle, fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true, wordWrapWidth: 160 },
      });
      label.x = px + PADDING;
      label.y = py + 50 + i * ENTRY_H;
      label.eventMode = 'static';
      label.cursor = 'pointer';
        label.on('pointerdown', () => {
          this.archiveData.triggerFirstViewIfNeeded(`char_${ch.id}`, ch.firstViewActions);
          this.archiveData.markRead(`char_${ch.id}`);
          this.showDetail(ch.id, px + PADDING + LIST_WIDTH, py + 50);
        });
      listContainer.addChild(label);
    });

    this.listContentH = 50 + characters.length * ENTRY_H;
    const listMask = new Graphics();
    listMask.rect(px, py + 50, LIST_WIDTH, DETAIL_AREA_H);
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
      this.detailContainer = null;
    }
    if (this.detailMask) {
      if (this.detailMask.parent) this.detailMask.parent.removeChild(this.detailMask);
      this.detailMask.destroy();
      this.detailMask = null;
    }
    this.detailScrollOffset = 0;

    const chars = this.archiveData.getUnlockedCharacters();
    const ch = chars.find(c => c.id === charId);
    if (!ch) return;

    const parts: string[] = [];
    parts.push(`${this.archiveData.resolveLine(ch.name)} - ${this.archiveData.resolveLine(ch.title)}`);

    const impressions = this.archiveData.getCharacterVisibleImpressions(ch);
    if (impressions.length > 0) {
      parts.push(`\n${this.strings.get('characterBook', 'impression')}`);
      for (const imp of impressions) parts.push(`  ${imp}`);
    }

    const infos = this.archiveData.getCharacterVisibleInfo(ch);
    if (infos.length > 0) {
      parts.push(`\n${this.strings.get('characterBook', 'knownIntel')}`);
      for (const info of infos) parts.push(`  ${info}`);
    }

    const { container: rc, totalHeight } = buildRichContent(parts.join('\n'), {
      width: DETAIL_AREA_W,
      fontSize: 12,
      fill: UITheme.colors.subtle,
      fontFamily: UITheme.fonts.ui,
    }, this.assetManager);

    rc.x = dx;
    rc.y = dy;
    this.detailContainer = rc;
    this.detailTotalH = totalHeight;

    const sh = this.renderer.screenHeight;
    const py = (sh - PANEL_H) / 2;
    const mask = new Graphics();
    mask.rect(dx, py + 50, DETAIL_AREA_W, DETAIL_AREA_H);
    mask.fill({ color: 0xffffff });
    this.detailMask = mask;
    this.container?.addChild(mask);
    rc.mask = mask;
    this.container?.addChild(rc);
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const mouseInDetailArea = e.clientX > this.panelX + PADDING + LIST_WIDTH;

    if (mouseInDetailArea && this.detailContainer) {
      const maxScroll = Math.max(0, this.detailTotalH - DETAIL_AREA_H);
      if (maxScroll <= 0) return;
      this.detailScrollOffset = Math.max(0, Math.min(this.detailScrollOffset + e.deltaY, maxScroll));
      const sh = this.renderer.screenHeight;
      const py = (sh - PANEL_H) / 2;
      this.detailContainer.y = py + 50 - this.detailScrollOffset;
    } else if (this.listContainer) {
      const maxScroll = Math.max(0, this.listContentH - DETAIL_AREA_H);
      if (maxScroll <= 0) return;
      this.listScrollOffset = Math.max(0, Math.min(this.listScrollOffset + e.deltaY, maxScroll));
      this.listContainer.y = -this.listScrollOffset;
    }
  }

  private destroyUI(): void {
    if (this.detailContainer) {
      this.detailContainer.destroy({ children: true });
      this.detailContainer = null;
    }
    this.detailMask = null;
    this.listContainer = null;
    if (this.container) {
      if (this.container.parent) this.container.parent.removeChild(this.container);
      this.container.destroy({ children: true });
      this.container = null;
    }
  }
}
