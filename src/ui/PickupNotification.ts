import { Container, Graphics, Text } from 'pixi.js';
import type { Renderer } from '../rendering/Renderer';

export class PickupNotification {
  private renderer: Renderer;
  private activeNotifications: Container[] = [];

  constructor(renderer: Renderer) {
    this.renderer = renderer;
  }

  show(itemName: string, count: number): void {
    const container = new Container();

    const label = count > 1 ? `获得了 ${itemName} x${count}` : `获得了 ${itemName}`;

    const text = new Text({
      text: label,
      style: { fontSize: 14, fill: 0xffcc44, fontFamily: 'sans-serif' },
    });

    const padding = 12;
    const bg = new Graphics();
    bg.roundRect(0, 0, text.width + padding * 2, text.height + padding, 4);
    bg.fill({ color: 0x000000, alpha: 0.7 });
    container.addChild(bg);

    text.x = padding;
    text.y = padding / 2;
    container.addChild(text);

    container.x = this.renderer.screenWidth - container.width - 20;
    container.y = 20 + this.activeNotifications.length * 40;

    this.renderer.uiLayer.addChild(container);
    this.activeNotifications.push(container);

    const startTime = performance.now();
    const duration = 2000;
    const fadeStart = 1500;

    const tick = () => {
      const elapsed = performance.now() - startTime;
      if (elapsed >= duration) {
        this.removeNotification(container);
        return;
      }
      if (elapsed > fadeStart) {
        container.alpha = 1 - (elapsed - fadeStart) / (duration - fadeStart);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  private removeNotification(container: Container): void {
    const idx = this.activeNotifications.indexOf(container);
    if (idx !== -1) {
      this.activeNotifications.splice(idx, 1);
    }
    if (container.parent) {
      container.parent.removeChild(container);
    }
    container.destroy({ children: true });
  }

  forceCleanup(): void {
    for (const c of this.activeNotifications) {
      if (c.parent) {
        c.parent.removeChild(c);
      }
      c.destroy({ children: true });
    }
    this.activeNotifications = [];
  }

  destroy(): void {
    this.forceCleanup();
  }
}
