import { Container, Graphics, Text } from 'pixi.js';
import type { Renderer } from '../rendering/Renderer';
import { UITheme } from './UITheme';

export interface DevModeCallbacks {
  getCutsceneIds(): string[];
  playCutscene(id: string): void;
  reload(): void;
}

const CATEGORY_WIDTH = 160;
const HEADER_HEIGHT = 48;
const ITEM_HEIGHT = 36;
const SCROLL_SPEED = 30;

export class DevModeUI {
  private renderer: Renderer;
  private callbacks: DevModeCallbacks;
  private container: Container;
  private _isOpen = false;
  private scrollY = 0;
  private maxScrollY = 0;
  private contentMask: Graphics | null = null;
  private contentContainer: Container | null = null;
  private boundWheel: ((e: WheelEvent) => void) | null = null;

  constructor(renderer: Renderer, callbacks: DevModeCallbacks) {
    this.renderer = renderer;
    this.callbacks = callbacks;
    this.container = new Container();
    this.container.visible = false;
    this.renderer.uiLayer.addChild(this.container);
  }

  get isOpen(): boolean {
    return this._isOpen;
  }

  open(): void {
    if (this._isOpen) return;
    this._isOpen = true;
    this.scrollY = 0;
    this.rebuild();
    this.container.visible = true;
    this.boundWheel = (e: WheelEvent) => this.onWheel(e);
    window.addEventListener('wheel', this.boundWheel, { passive: false });
  }

  close(): void {
    if (!this._isOpen) return;
    this._isOpen = false;
    this.container.visible = false;
    this.clearChildren();
    if (this.boundWheel) {
      window.removeEventListener('wheel', this.boundWheel);
      this.boundWheel = null;
    }
  }

  destroy(): void {
    this.close();
    if (this.container.parent) this.container.parent.removeChild(this.container);
    this.container.destroy({ children: true });
  }

  private clearChildren(): void {
    if (this.contentMask) {
      this.contentMask.destroy();
      this.contentMask = null;
    }
    this.contentContainer = null;
    const removed = this.container.removeChildren();
    for (const child of removed) {
      child.destroy({ children: true });
    }
  }

  private rebuild(): void {
    this.clearChildren();
    const sw = this.renderer.screenWidth;
    const sh = this.renderer.screenHeight;
    const pad = 40;
    const panelW = Math.min(sw - pad * 2, 800);
    const panelH = Math.min(sh - pad * 2, 600);
    const panelX = (sw - panelW) / 2;
    const panelY = (sh - panelH) / 2;

    const overlay = new Graphics();
    overlay.rect(0, 0, sw, sh);
    overlay.fill({ color: UITheme.colors.overlay, alpha: UITheme.alpha.overlayDark });
    overlay.eventMode = 'static';
    this.container.addChild(overlay);

    const panel = new Graphics();
    panel.roundRect(panelX, panelY, panelW, panelH, UITheme.panel.borderRadius);
    panel.fill({ color: UITheme.colors.panelBg, alpha: UITheme.alpha.panelBg });
    panel.stroke({ color: UITheme.colors.panelBorder, width: UITheme.panel.borderWidth });
    this.container.addChild(panel);

    const title = new Text({
      text: 'Dev Mode',
      style: {
        fontSize: 20,
        fill: UITheme.colors.title,
        fontFamily: UITheme.fonts.display,
        fontWeight: 'bold',
      },
    });
    title.x = panelX + 16;
    title.y = panelY + (HEADER_HEIGHT - title.height) / 2;
    this.container.addChild(title);

    const refreshBtn = this.makeButton('Reload', panelX + panelW - 100, panelY + 8, 84, 32, () => {
      this.callbacks.reload();
    });
    this.container.addChild(refreshBtn);

    const divider = new Graphics();
    divider.rect(panelX, panelY + HEADER_HEIGHT, panelW, 1);
    divider.fill(UITheme.colors.panelBorder);
    this.container.addChild(divider);

    const bodyY = panelY + HEADER_HEIGHT + 1;
    const bodyH = panelH - HEADER_HEIGHT - 1;

    const catBg = new Graphics();
    catBg.rect(panelX, bodyY, CATEGORY_WIDTH, bodyH);
    catBg.fill({ color: UITheme.colors.panelBgAlt, alpha: 0.8 });
    this.container.addChild(catBg);

    const catLabel = this.makeCategoryLabel('Cutscene', panelX, bodyY, true);
    this.container.addChild(catLabel);

    const catDivider = new Graphics();
    catDivider.rect(panelX + CATEGORY_WIDTH, bodyY, 1, bodyH);
    catDivider.fill(UITheme.colors.panelBorder);
    this.container.addChild(catDivider);

    const contentX = panelX + CATEGORY_WIDTH + 1;
    const contentW = panelW - CATEGORY_WIDTH - 1;
    this.buildCutsceneList(contentX, bodyY, contentW, bodyH);
  }

  private buildCutsceneList(x: number, y: number, w: number, h: number): void {
    const ids = this.callbacks.getCutsceneIds();

    this.contentMask = new Graphics();
    this.contentMask.rect(x, y, w, h);
    this.contentMask.fill(0xffffff);
    this.container.addChild(this.contentMask);

    this.contentContainer = new Container();
    this.contentContainer.mask = this.contentMask;
    this.container.addChild(this.contentContainer);

    const pad = 8;
    let cy = 0;

    if (ids.length === 0) {
      const empty = new Text({
        text: 'No cutscenes defined.',
        style: { fontSize: 14, fill: UITheme.colors.hint, fontFamily: UITheme.fonts.ui },
      });
      empty.x = x + pad;
      empty.y = y + pad;
      this.contentContainer.addChild(empty);
      this.maxScrollY = 0;
      return;
    }

    for (const id of ids) {
      const row = this.makeListItem(id, x + pad, y + cy, w - pad * 2, ITEM_HEIGHT, () => {
        this.callbacks.playCutscene(id);
      });
      this.contentContainer.addChild(row);
      cy += ITEM_HEIGHT + 2;
    }

    const totalH = cy;
    this.maxScrollY = Math.max(0, totalH - h);
    this.applyScroll();
  }

  private makeListItem(
    text: string, x: number, y: number, w: number, h: number, onClick: () => void,
  ): Container {
    const item = new Container();

    const bg = new Graphics();
    bg.roundRect(0, 0, w, h, UITheme.panel.borderRadiusSmall);
    bg.fill({ color: UITheme.colors.rowBg, alpha: UITheme.alpha.rowBgLight });
    item.addChild(bg);

    const label = new Text({
      text,
      style: { fontSize: 14, fill: UITheme.colors.body, fontFamily: UITheme.fonts.ui },
    });
    label.x = 12;
    label.y = (h - label.height) / 2;
    item.addChild(label);

    const playIcon = new Text({
      text: '>>',
      style: { fontSize: 12, fill: UITheme.colors.subtle, fontFamily: UITheme.fonts.ui },
    });
    playIcon.x = w - playIcon.width - 12;
    playIcon.y = (h - playIcon.height) / 2;
    item.addChild(playIcon);

    item.x = x;
    item.y = y;
    item.eventMode = 'static';
    item.cursor = 'pointer';

    item.on('pointerover', () => {
      bg.clear();
      bg.roundRect(0, 0, w, h, UITheme.panel.borderRadiusSmall);
      bg.fill({ color: UITheme.colors.rowHover, alpha: UITheme.alpha.rowHover });
    });
    item.on('pointerout', () => {
      bg.clear();
      bg.roundRect(0, 0, w, h, UITheme.panel.borderRadiusSmall);
      bg.fill({ color: UITheme.colors.rowBg, alpha: UITheme.alpha.rowBgLight });
    });
    item.on('pointertap', onClick);

    const hitArea = new Graphics();
    hitArea.rect(0, 0, w, h);
    hitArea.fill({ color: 0xffffff, alpha: UITheme.alpha.hitArea });
    item.addChildAt(hitArea, 0);

    return item;
  }

  private makeButton(
    text: string, x: number, y: number, w: number, h: number, onClick: () => void,
  ): Container {
    const btn = new Container();
    btn.x = x;
    btn.y = y;

    const bg = new Graphics();
    bg.roundRect(0, 0, w, h, UITheme.panel.borderRadiusSmall);
    bg.fill({ color: UITheme.colors.borderMid, alpha: 0.8 });
    btn.addChild(bg);

    const label = new Text({
      text,
      style: { fontSize: 13, fill: UITheme.colors.buttonText, fontFamily: UITheme.fonts.ui },
    });
    label.x = (w - label.width) / 2;
    label.y = (h - label.height) / 2;
    btn.addChild(label);

    btn.eventMode = 'static';
    btn.cursor = 'pointer';
    btn.on('pointerover', () => {
      bg.clear();
      bg.roundRect(0, 0, w, h, UITheme.panel.borderRadiusSmall);
      bg.fill({ color: UITheme.colors.borderActive, alpha: 0.9 });
    });
    btn.on('pointerout', () => {
      bg.clear();
      bg.roundRect(0, 0, w, h, UITheme.panel.borderRadiusSmall);
      bg.fill({ color: UITheme.colors.borderMid, alpha: 0.8 });
    });
    btn.on('pointertap', onClick);

    return btn;
  }

  private makeCategoryLabel(text: string, panelX: number, bodyY: number, active: boolean): Container {
    const c = new Container();
    const h = 36;
    const w = CATEGORY_WIDTH;

    const bg = new Graphics();
    bg.rect(0, 0, w, h);
    bg.fill({ color: active ? UITheme.colors.panelBg : UITheme.colors.panelBgAlt, alpha: active ? 1 : 0.5 });
    c.addChild(bg);

    const label = new Text({
      text,
      style: {
        fontSize: 14,
        fill: active ? UITheme.colors.title : UITheme.colors.subtle,
        fontFamily: UITheme.fonts.ui,
        fontWeight: active ? 'bold' : 'normal',
      },
    });
    label.x = 16;
    label.y = (h - label.height) / 2;
    c.addChild(label);

    c.x = panelX;
    c.y = bodyY;
    return c;
  }

  private onWheel(e: WheelEvent): void {
    if (!this._isOpen || !this.contentContainer) return;
    e.preventDefault();
    this.scrollY = Math.max(0, Math.min(this.maxScrollY, this.scrollY + (e.deltaY > 0 ? SCROLL_SPEED : -SCROLL_SPEED)));
    this.applyScroll();
  }

  private applyScroll(): void {
    if (!this.contentContainer) return;
    const items = this.contentContainer.children;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const baseY = (item as any).__baseY;
      if (baseY !== undefined) {
        item.y = baseY - this.scrollY;
      } else {
        (item as any).__baseY = item.y;
        item.y -= this.scrollY;
      }
    }
  }
}
