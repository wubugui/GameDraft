import { Container, Graphics, Text } from 'pixi.js';
import type { Renderer } from '../rendering/Renderer';
import type { EventBus } from '../core/EventBus';
import type { IInventoryDataProvider, ShopDef } from '../data/types';
import { resolveAssetPath } from '../core/assetPath';

const PANEL_W = 500;
const PADDING = 20;
const ITEM_H = 36;

export class ShopUI {
  private renderer: Renderer;
  private eventBus: EventBus;
  private inventoryData: IInventoryDataProvider;
  private container: Container | null = null;
  private _isOpen = false;
  private currentShop: ShopDef | null = null;
  private shopDefs: Map<string, ShopDef> = new Map();

  constructor(renderer: Renderer, eventBus: EventBus, inventoryData: IInventoryDataProvider) {
    this.renderer = renderer;
    this.eventBus = eventBus;
    this.inventoryData = inventoryData;
  }

  async loadDefs(): Promise<void> {
    try {
      const resp = await fetch(resolveAssetPath('/assets/data/shops.json'));
      const list: ShopDef[] = await resp.json();
      for (const s of list) this.shopDefs.set(s.id, s);
    } catch { /* no shops yet */ }
  }

  get isOpen(): boolean { return this._isOpen; }

  open(): void { /* ShopUI requires openShop(shopId) */ }

  openShop(shopId: string): void {
    const def = this.shopDefs.get(shopId);
    if (!def) {
      console.warn(`ShopUI: unknown shop "${shopId}"`);
      return;
    }
    this.currentShop = def;
    this._isOpen = true;
    this.build();
  }

  close(): void {
    if (!this._isOpen) return;
    this._isOpen = false;
    this.currentShop = null;
    this.destroyUI();
    this.eventBus.emit('shop:closed', {});
  }

  private build(): void {
    this.destroyUI();
    if (!this.currentShop) return;

    this.container = new Container();
    const sw = this.renderer.screenWidth;
    const sh = this.renderer.screenHeight;

    const items = this.currentShop.items;
    const panelH = 80 + items.length * ITEM_H + 40;
    const px = (sw - PANEL_W) / 2;
    const py = (sh - panelH) / 2;

    const overlay = new Graphics();
    overlay.rect(0, 0, sw, sh);
    overlay.fill({ color: 0x000000, alpha: 0.4 });
    this.container.addChild(overlay);

    const bg = new Graphics();
    bg.roundRect(px, py, PANEL_W, panelH, 8);
    bg.fill({ color: 0x111122, alpha: 0.95 });
    bg.roundRect(px, py, PANEL_W, panelH, 8);
    bg.stroke({ color: 0x444466, width: 1 });
    this.container.addChild(bg);

    const title = new Text({
      text: this.currentShop.name,
      style: { fontSize: 18, fill: 0xffcc88, fontFamily: 'sans-serif', fontWeight: 'bold' },
    });
    title.x = px + PADDING;
    title.y = py + 12;
    this.container.addChild(title);

    const coins = this.inventoryData.getCoins();
    const coinText = new Text({
      text: `铜钱: ${coins}`,
      style: { fontSize: 13, fill: 0xccaa66, fontFamily: 'sans-serif' },
    });
    coinText.x = px + PANEL_W - 100;
    coinText.y = py + 16;
    this.container.addChild(coinText);

    let cy = 50;
    for (const item of items) {
      const itemDef = this.inventoryData.getItemDef(item.itemId);
      const name = itemDef?.name ?? item.itemId;
      const price = item.price ?? itemDef?.buyPrice ?? 0;
      const canBuy = coins >= price;

      const row = new Graphics();
      row.roundRect(px + PADDING, py + cy, PANEL_W - PADDING * 2, ITEM_H - 4, 4);
      row.fill({ color: 0x222233, alpha: 0.6 });
      this.container.addChild(row);

      const nameT = new Text({
        text: name,
        style: { fontSize: 13, fill: canBuy ? 0xcccccc : 0x666666, fontFamily: 'sans-serif' },
      });
      nameT.x = px + PADDING + 10;
      nameT.y = py + cy + 8;
      this.container.addChild(nameT);

      const priceT = new Text({
        text: `${price} 文`,
        style: { fontSize: 13, fill: canBuy ? 0xccaa66 : 0x666655, fontFamily: 'sans-serif' },
      });
      priceT.x = px + PANEL_W - PADDING - 120;
      priceT.y = py + cy + 8;
      this.container.addChild(priceT);

      const buyBtn = new Text({
        text: canBuy ? '[购买]' : '[不足]',
        style: { fontSize: 13, fill: canBuy ? 0x88cc88 : 0x555555, fontFamily: 'sans-serif' },
      });
      buyBtn.x = px + PANEL_W - PADDING - 50;
      buyBtn.y = py + cy + 8;
      if (canBuy) {
        buyBtn.eventMode = 'static';
        buyBtn.cursor = 'pointer';
        buyBtn.on('pointerdown', () => {
          this.doPurchase(item.itemId, price);
        });
      }
      this.container.addChild(buyBtn);

      cy += ITEM_H;
    }

    const closeBtn = new Text({
      text: '[离开]',
      style: { fontSize: 14, fill: 0x8888aa, fontFamily: 'sans-serif' },
    });
    closeBtn.x = px + (PANEL_W - closeBtn.width) / 2;
    closeBtn.y = py + panelH - 30;
    closeBtn.eventMode = 'static';
    closeBtn.cursor = 'pointer';
    closeBtn.on('pointerdown', () => this.close());
    this.container.addChild(closeBtn);

    this.renderer.uiLayer.addChild(this.container);
  }

  private doPurchase(itemId: string, price: number): void {
    this.eventBus.emit('shop:purchase', { itemId, price });
    setTimeout(() => this.build(), 50);
  }

  private destroyUI(): void {
    if (this.container) {
      if (this.container.parent) this.container.parent.removeChild(this.container);
      this.container.destroy({ children: true });
      this.container = null;
    }
  }

  destroy(): void {
    this.destroyUI();
    this.shopDefs.clear();
  }
}
