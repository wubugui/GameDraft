import { Container, Graphics, Text } from 'pixi.js';
import { UITheme, fadeIn } from './UITheme';
import type { Renderer } from '../rendering/Renderer';
import type { EventBus } from '../core/EventBus';
import type { IInventoryDataProvider, ShopDef } from '../data/types';
import { resolveAssetPath } from '../core/assetPath';
import type { StringsProvider } from '../core/StringsProvider';

const PANEL_W = 500;
const PADDING = 20;
const ITEM_H = 36;

export class ShopUI {
  private renderer: Renderer;
  private eventBus: EventBus;
  private inventoryData: IInventoryDataProvider;
  private strings: StringsProvider;
  private container: Container | null = null;
  private _isOpen = false;
  private currentShop: ShopDef | null = null;
  private shopDefs: Map<string, ShopDef> = new Map();
  private rebuildTimerId: ReturnType<typeof setTimeout> | null = null;

  constructor(renderer: Renderer, eventBus: EventBus, inventoryData: IInventoryDataProvider, strings: StringsProvider) {
    this.renderer = renderer;
    this.eventBus = eventBus;
    this.inventoryData = inventoryData;
    this.strings = strings;
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
    overlay.fill({ color: UITheme.colors.overlay, alpha: UITheme.alpha.overlayLight });
    this.container.addChild(overlay);

    const bg = new Graphics();
    bg.roundRect(px, py, PANEL_W, panelH, UITheme.panel.borderRadius);
    bg.fill({ color: UITheme.colors.panelBg, alpha: UITheme.alpha.panelBg });
    bg.roundRect(px, py, PANEL_W, panelH, UITheme.panel.borderRadius);
    bg.stroke({ color: UITheme.colors.panelBorder, width: 1 });
    this.container.addChild(bg);

    const title = new Text({
      text: this.currentShop.name,
      style: { fontSize: 18, fill: UITheme.colors.title, fontFamily: UITheme.fonts.ui, fontWeight: 'bold', wordWrap: true, breakWords: true, wordWrapWidth: PANEL_W - PADDING * 2 - 120 },
    });
    title.x = px + PADDING;
    title.y = py + 12;
    this.container.addChild(title);

    const coins = this.inventoryData.getCoins();
    const coinText = new Text({
      text: `${this.strings.get('shop', 'coins')} ${coins}`,
      style: { fontSize: 13, fill: UITheme.colors.goldDim, fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true, wordWrapWidth: 90 },
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
      row.roundRect(px + PADDING, py + cy, PANEL_W - PADDING * 2, ITEM_H - 4, UITheme.panel.borderRadiusSmall);
      row.fill({ color: UITheme.colors.rowBg, alpha: UITheme.alpha.rowBgLight });
      this.container.addChild(row);

      const nameT = new Text({
        text: name,
        style: { fontSize: 13, fill: canBuy ? UITheme.colors.bodyLight : UITheme.colors.disabled, fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true, wordWrapWidth: PANEL_W - PADDING * 2 - 180 },
      });
      nameT.x = px + PADDING + 10;
      nameT.y = py + cy + 8;
      this.container.addChild(nameT);

      const priceT = new Text({
        text: `${price} ${this.strings.get('shop', 'unit')}`,
        style: { fontSize: 13, fill: canBuy ? UITheme.colors.goldDim : UITheme.colors.disabled, fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true, wordWrapWidth: 70 },
      });
      priceT.x = px + PANEL_W - PADDING - 120;
      priceT.y = py + cy + 8;
      this.container.addChild(priceT);

      const buyBtn = new Text({
        text: canBuy ? this.strings.get('shop', 'buy') : this.strings.get('shop', 'insufficient'),
        style: { fontSize: 13, fill: canBuy ? UITheme.colors.green : UITheme.colors.disabledDark, fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true, wordWrapWidth: 60 },
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
      text: this.strings.get('shop', 'leave'),
      style: { fontSize: 14, fill: UITheme.colors.link, fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true, wordWrapWidth: PANEL_W - PADDING * 2 },
    });
    closeBtn.x = px + (PANEL_W - closeBtn.width) / 2;
    closeBtn.y = py + panelH - 30;
    closeBtn.eventMode = 'static';
    closeBtn.cursor = 'pointer';
    closeBtn.on('pointerdown', () => this.close());
    this.container.addChild(closeBtn);

    this.renderer.uiLayer.addChild(this.container);
    fadeIn(this.container);
  }

  private doPurchase(itemId: string, price: number): void {
    this.eventBus.emit('shop:purchase', { itemId, price });
    if (this.rebuildTimerId !== null) clearTimeout(this.rebuildTimerId);
    this.rebuildTimerId = setTimeout(() => {
      this.rebuildTimerId = null;
      this.build();
    }, 50);
  }

  private destroyUI(): void {
    if (this.container) {
      if (this.container.parent) this.container.parent.removeChild(this.container);
      this.container.destroy({ children: true });
      this.container = null;
    }
  }

  destroy(): void {
    if (this.rebuildTimerId !== null) {
      clearTimeout(this.rebuildTimerId);
      this.rebuildTimerId = null;
    }
    this.destroyUI();
    this.shopDefs.clear();
  }
}
