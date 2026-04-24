import { Container, Graphics, Text } from 'pixi.js';
import { UITheme, fadeIn } from './UITheme';
import type { Renderer } from '../rendering/Renderer';
import type { EventBus } from '../core/EventBus';
import type { StringsProvider } from '../core/StringsProvider';
import type { IInventoryDataProvider } from '../data/types';

const GRID_COLS = 4;
const CELL_SIZE = 64;
const CELL_GAP = 6;
const MAX_SLOTS = 12;

export class InventoryUI {
  private renderer: Renderer;
  private eventBus: EventBus;
  private strings: StringsProvider;
  private inventoryData: IInventoryDataProvider;
  private container: Container | null = null;
  private detailContainer: Container | null = null;
  private _isOpen: boolean = false;
  private resolveDisplay: ((s: string) => string) | null = null;

  constructor(renderer: Renderer, eventBus: EventBus, inventoryData: IInventoryDataProvider, strings: StringsProvider) {
    this.renderer = renderer;
    this.eventBus = eventBus;
    this.inventoryData = inventoryData;
    this.strings = strings;
  }

  setResolveDisplay(fn: ((s: string) => string) | null): void {
    this.resolveDisplay = fn;
  }

  private r(s: string): string {
    return this.resolveDisplay ? this.resolveDisplay(s) : s;
  }

  get isOpen(): boolean {
    return this._isOpen;
  }

  open(): void {
    if (this._isOpen) return;
    this._isOpen = true;
    this.build();
  }

  close(): void {
    if (!this._isOpen) return;
    this._isOpen = false;
    this.clearDetail();
    if (this.container) {
      if (this.container.parent) {
        this.container.parent.removeChild(this.container);
      }
      this.container.destroy({ children: true });
      this.container = null;
    }
  }

  private build(): void {
    this.container = new Container();

    const w = this.renderer.screenWidth;
    const h = this.renderer.screenHeight;
    const rows = Math.ceil(MAX_SLOTS / GRID_COLS);
    const gridW = GRID_COLS * (CELL_SIZE + CELL_GAP) + CELL_GAP;
    const gridH = rows * (CELL_SIZE + CELL_GAP) + CELL_GAP;
    const panelW = gridW + 220;
    const panelH = gridH + 80;
    const px = (w - panelW) / 2;
    const py = (h - panelH) / 2;

    const overlay = new Graphics();
    overlay.rect(0, 0, w, h);
    overlay.fill({ color: UITheme.colors.overlay, alpha: UITheme.alpha.overlay });
    this.container.addChild(overlay);

    const panel = new Graphics();
    panel.roundRect(px, py, panelW, panelH, UITheme.panel.borderRadius);
    panel.fill({ color: UITheme.colors.panelBg, alpha: UITheme.alpha.panelBg });
    panel.roundRect(px, py, panelW, panelH, UITheme.panel.borderRadius);
    panel.stroke({ color: UITheme.colors.panelBorder, width: 1 });
    this.container.addChild(panel);

    const title = new Text({
      text: this.strings.get('inventory', 'title'),
      style: { fontSize: 18, fill: UITheme.colors.title, fontFamily: UITheme.fonts.ui, fontWeight: 'bold', wordWrap: true, breakWords: true, wordWrapWidth: 80 },
    });
    title.x = px + 20;
    title.y = py + 14;
    this.container.addChild(title);

    const coinLabel = new Text({
      text: `${this.strings.get('inventory', 'coins')} ${this.inventoryData.getCoins()}`,
      style: { fontSize: 13, fill: UITheme.colors.gold, fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true, wordWrapWidth: 120 },
    });
    coinLabel.x = px + 100;
    coinLabel.y = py + 17;
    this.container.addChild(coinLabel);

    const items = this.inventoryData.getAllItems();
    const gridStartX = px + CELL_GAP + 10;
    const gridStartY = py + 50;

    for (let i = 0; i < MAX_SLOTS; i++) {
      const col = i % GRID_COLS;
      const row = Math.floor(i / GRID_COLS);
      const cx = gridStartX + col * (CELL_SIZE + CELL_GAP);
      const cy = gridStartY + row * (CELL_SIZE + CELL_GAP);

      const cell = new Graphics();
      cell.roundRect(cx, cy, CELL_SIZE, CELL_SIZE, UITheme.panel.borderRadiusSmall);
      cell.fill({ color: UITheme.colors.rowBgDark, alpha: UITheme.alpha.rowBg });
      cell.roundRect(cx, cy, CELL_SIZE, CELL_SIZE, UITheme.panel.borderRadiusSmall);
      cell.stroke({ color: UITheme.colors.borderMid, width: 1 });
      this.container.addChild(cell);

      if (i < items.length) {
        const item = items[i];
        const nameStr = this.r(item.def?.name ?? item.id);

        const nameText = new Text({
          text: nameStr,
          style: {
            fontSize: 11,
            fill: item.def?.type === 'key' ? UITheme.colors.title : UITheme.colors.body,
            fontFamily: UITheme.fonts.ui,
            wordWrap: true, breakWords: true,
            wordWrapWidth: CELL_SIZE - 12,
          },
        });
        nameText.x = cx + 6;
        nameText.y = cy + 6;
        this.container.addChild(nameText);

        const nameMask = new Graphics();
        nameMask.rect(cx, cy, CELL_SIZE, CELL_SIZE);
        nameMask.fill({ color: 0xffffff });
        this.container.addChild(nameMask);
        nameText.mask = nameMask;

        if (item.def?.type !== 'key' && item.count > 1) {
          const countText = new Text({
            text: `x${item.count}`,
            style: { fontSize: 10, fill: UITheme.colors.descText, fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true, wordWrapWidth: 30 },
          });
          countText.x = cx + CELL_SIZE - 24;
          countText.y = cy + CELL_SIZE - 16;
          this.container.addChild(countText);
        }

        const hitArea = new Graphics();
        hitArea.roundRect(cx, cy, CELL_SIZE, CELL_SIZE, UITheme.panel.borderRadiusSmall);
        hitArea.fill({ color: 0xffffff, alpha: UITheme.alpha.hitArea });
        hitArea.eventMode = 'static';
        hitArea.cursor = 'pointer';
        hitArea.on('pointerdown', () => this.showDetail(item.id, px + gridW + 30, gridStartY));
        this.container.addChild(hitArea);
      }
    }

    const hint = new Text({
      text: this.strings.get('inventory', 'closeHint'),
      style: { fontSize: 11, fill: UITheme.colors.hint, fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true, wordWrapWidth: 120 },
    });
    hint.x = px + panelW - 70;
    hint.y = py + panelH - 24;
    this.container.addChild(hint);

    this.renderer.uiLayer.addChild(this.container);
    fadeIn(this.container);
  }

  private showDetail(itemId: string, x: number, y: number): void {
    this.clearDetail();
    if (!this.container) return;

    this.detailContainer = new Container();

    const def = this.inventoryData.getItemDef(itemId);
    const desc = this.inventoryData.getItemDescription(itemId);
    const name = this.r(def?.name ?? itemId);
    const count = this.inventoryData.getItemCount(itemId);

    const nameText = new Text({
      text: name + (def?.type === 'key' ? ` ${this.strings.get('inventory', 'keyItem')}` : ` x${count}`),
      style: { fontSize: 14, fill: def?.type === 'key' ? UITheme.colors.title : UITheme.colors.body, fontFamily: UITheme.fonts.ui, fontWeight: 'bold', wordWrap: true, breakWords: true, wordWrapWidth: 176 },
    });
    nameText.x = x + 12;
    nameText.y = y + 12;

    const descText = new Text({
      text: this.r(desc || this.strings.get('inventory', 'noDesc')),
      style: { fontSize: 12, fill: UITheme.colors.descTextDim, fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true, wordWrapWidth: 176, lineHeight: 18 },
    });
    descText.x = x + 12;
    descText.y = y + 36;

    const detailH = Math.max(160, descText.y - y + descText.height + 50);

    const bg = new Graphics();
    bg.roundRect(x, y, 200, detailH, UITheme.panel.borderRadiusMed);
    bg.fill({ color: UITheme.colors.detailBg, alpha: UITheme.alpha.panelBg });
    bg.roundRect(x, y, 200, detailH, UITheme.panel.borderRadiusMed);
    bg.stroke({ color: UITheme.colors.panelBorder, width: 1 });
    this.detailContainer.addChild(bg);

    this.detailContainer.addChild(nameText);
    this.detailContainer.addChild(descText);

    const detailMask = new Graphics();
    detailMask.rect(x, y, 200, detailH);
    detailMask.fill({ color: 0xffffff });
    this.detailContainer.addChild(detailMask);
    descText.mask = detailMask;

    if (this.inventoryData.canDiscard(itemId)) {
      const btnBg = new Graphics();
      btnBg.roundRect(x + 12, y + detailH - 32, 70, 24, UITheme.panel.borderRadiusSmall);
      btnBg.fill({ color: UITheme.colors.dangerBg, alpha: UITheme.alpha.rowHover });
      btnBg.roundRect(x + 12, y + detailH - 32, 70, 24, UITheme.panel.borderRadiusSmall);
      btnBg.stroke({ color: UITheme.colors.dangerBorder, width: 1 });
      btnBg.eventMode = 'static';
      btnBg.cursor = 'pointer';
      btnBg.on('pointerdown', () => {
        this.eventBus.emit('inventory:discard', { itemId });
        this.close();
        this.open();
      });
      this.detailContainer.addChild(btnBg);

      const btnText = new Text({
        text: this.strings.get('inventory', 'discard'),
        style: { fontSize: 12, fill: UITheme.colors.red, fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true, wordWrapWidth: 60 },
      });
      btnText.x = x + 30;
      btnText.y = y + detailH - 28;
      this.detailContainer.addChild(btnText);
    }

    this.container.addChild(this.detailContainer);
  }

  private clearDetail(): void {
    if (this.detailContainer) {
      if (this.detailContainer.parent) {
        this.detailContainer.parent.removeChild(this.detailContainer);
      }
      this.detailContainer.destroy({ children: true });
      this.detailContainer = null;
    }
  }

  destroy(): void {
    this.close();
  }
}
