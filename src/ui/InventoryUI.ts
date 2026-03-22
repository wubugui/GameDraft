import { Container, Graphics, Text } from 'pixi.js';
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

  constructor(renderer: Renderer, eventBus: EventBus, inventoryData: IInventoryDataProvider, strings: StringsProvider) {
    this.renderer = renderer;
    this.eventBus = eventBus;
    this.inventoryData = inventoryData;
    this.strings = strings;
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
    overlay.fill({ color: 0x000000, alpha: 0.5 });
    this.container.addChild(overlay);

    const panel = new Graphics();
    panel.roundRect(px, py, panelW, panelH, 8);
    panel.fill({ color: 0x111122, alpha: 0.95 });
    panel.roundRect(px, py, panelW, panelH, 8);
    panel.stroke({ color: 0x444466, width: 1 });
    this.container.addChild(panel);

    const title = new Text({
      text: this.strings.get('inventory', 'title'),
      style: { fontSize: 18, fill: 0xffcc88, fontFamily: 'sans-serif', fontWeight: 'bold' },
    });
    title.x = px + 20;
    title.y = py + 14;
    this.container.addChild(title);

    const coinLabel = new Text({
      text: `${this.strings.get('inventory', 'coins')} ${this.inventoryData.getCoins()}`,
      style: { fontSize: 13, fill: 0xffcc66, fontFamily: 'sans-serif' },
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
      cell.roundRect(cx, cy, CELL_SIZE, CELL_SIZE, 4);
      cell.fill({ color: 0x1a1a2e, alpha: 0.8 });
      cell.roundRect(cx, cy, CELL_SIZE, CELL_SIZE, 4);
      cell.stroke({ color: 0x333355, width: 1 });
      this.container.addChild(cell);

      if (i < items.length) {
        const item = items[i];
        const nameStr = item.def?.name ?? item.id;
        const shortName = nameStr.length > 4 ? nameStr.substring(0, 4) : nameStr;

        const nameText = new Text({
          text: shortName,
          style: {
            fontSize: 11,
            fill: item.def?.type === 'key' ? 0xffcc88 : 0xdddddd,
            fontFamily: 'sans-serif',
          },
        });
        nameText.x = cx + 6;
        nameText.y = cy + 20;
        this.container.addChild(nameText);

        if (item.def?.type !== 'key' && item.count > 1) {
          const countText = new Text({
            text: `x${item.count}`,
            style: { fontSize: 10, fill: 0xaaaaaa, fontFamily: 'sans-serif' },
          });
          countText.x = cx + CELL_SIZE - 24;
          countText.y = cy + CELL_SIZE - 16;
          this.container.addChild(countText);
        }

        const hitArea = new Graphics();
        hitArea.roundRect(cx, cy, CELL_SIZE, CELL_SIZE, 4);
        hitArea.fill({ color: 0xffffff, alpha: 0.001 });
        hitArea.eventMode = 'static';
        hitArea.cursor = 'pointer';
        hitArea.on('pointerdown', () => this.showDetail(item.id, px + gridW + 30, gridStartY));
        this.container.addChild(hitArea);
      }
    }

    const hint = new Text({
      text: this.strings.get('inventory', 'closeHint'),
      style: { fontSize: 11, fill: 0x555566, fontFamily: 'sans-serif' },
    });
    hint.x = px + panelW - 70;
    hint.y = py + panelH - 24;
    this.container.addChild(hint);

    this.renderer.uiLayer.addChild(this.container);
  }

  private showDetail(itemId: string, x: number, y: number): void {
    this.clearDetail();
    if (!this.container) return;

    this.detailContainer = new Container();

    const def = this.inventoryData.getItemDef(itemId);
    const desc = this.inventoryData.getItemDescription(itemId);
    const name = def?.name ?? itemId;
    const count = this.inventoryData.getItemCount(itemId);

    const bg = new Graphics();
    bg.roundRect(x, y, 200, 160, 6);
    bg.fill({ color: 0x181830, alpha: 0.95 });
    bg.roundRect(x, y, 200, 160, 6);
    bg.stroke({ color: 0x444466, width: 1 });
    this.detailContainer.addChild(bg);

    const nameText = new Text({
      text: name + (def?.type === 'key' ? ` ${this.strings.get('inventory', 'keyItem')}` : ` x${count}`),
      style: { fontSize: 14, fill: def?.type === 'key' ? 0xffcc88 : 0xdddddd, fontFamily: 'sans-serif', fontWeight: 'bold' },
    });
    nameText.x = x + 12;
    nameText.y = y + 12;
    this.detailContainer.addChild(nameText);

    const descText = new Text({
      text: desc || this.strings.get('inventory', 'noDesc'),
      style: { fontSize: 12, fill: 0x999999, fontFamily: 'sans-serif', wordWrap: true, wordWrapWidth: 176, lineHeight: 18 },
    });
    descText.x = x + 12;
    descText.y = y + 36;
    this.detailContainer.addChild(descText);

    if (this.inventoryData.canDiscard(itemId)) {
      const btnBg = new Graphics();
      btnBg.roundRect(x + 12, y + 128, 70, 24, 4);
      btnBg.fill({ color: 0x442222, alpha: 0.9 });
      btnBg.roundRect(x + 12, y + 128, 70, 24, 4);
      btnBg.stroke({ color: 0x665544, width: 1 });
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
        style: { fontSize: 12, fill: 0xff8866, fontFamily: 'sans-serif' },
      });
      btnText.x = x + 30;
      btnText.y = y + 132;
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
