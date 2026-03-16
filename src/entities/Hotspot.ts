import { Container, Graphics, Text } from 'pixi.js';
import type { HotspotDef } from '../data/types';

const TYPE_COLORS: Record<string, number> = {
  inspect: 0x44aaff,
  pickup: 0xffcc44,
  transition: 0x44ff88,
};

export class Hotspot {
  public def: HotspotDef;
  public container: Container;
  public active: boolean = true;

  private marker: Graphics;
  private promptIcon: Container | null = null;
  private showingPrompt: boolean = false;

  constructor(def: HotspotDef) {
    this.def = def;
    this.container = new Container();

    const color = TYPE_COLORS[def.type] ?? 0xffffff;

    this.marker = new Graphics();
    this.marker.circle(0, 0, 8).fill({ color, alpha: 0.6 });
    this.marker.circle(0, 0, 12).stroke({ color, width: 1, alpha: 0.3 });
    this.container.addChild(this.marker);

    this.container.x = def.x + def.width / 2;
    this.container.y = def.y + def.height / 2;
  }

  get centerX(): number {
    return this.def.x + this.def.width / 2;
  }

  get centerY(): number {
    return this.def.y + this.def.height / 2;
  }

  showPrompt(): void {
    if (this.showingPrompt) return;
    this.showingPrompt = true;

    this.promptIcon = new Container();
    const bg = new Graphics();
    bg.roundRect(-14, -28, 28, 22, 4).fill({ color: 0x000000, alpha: 0.7 });
    this.promptIcon.addChild(bg);

    const text = new Text({
      text: 'E',
      style: { fontSize: 14, fill: 0xffffff, fontFamily: 'monospace' },
    });
    text.anchor.set(0.5, 0.5);
    text.y = -17;
    this.promptIcon.addChild(text);

    this.container.addChild(this.promptIcon);
  }

  hidePrompt(): void {
    if (!this.showingPrompt) return;
    this.showingPrompt = false;

    if (this.promptIcon) {
      this.container.removeChild(this.promptIcon);
      this.promptIcon.destroy({ children: true });
      this.promptIcon = null;
    }
  }

  setInactive(): void {
    this.active = false;
    this.hidePrompt();
    this.container.visible = false;
  }

  destroy(): void {
    this.hidePrompt();
    if (this.container.parent) {
      this.container.parent.removeChild(this.container);
    }
    this.container.destroy({ children: true });
  }
}
