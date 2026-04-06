import { Container, Graphics, Text } from 'pixi.js';
import { UITheme } from './UITheme';
import type { Renderer } from '../rendering/Renderer';
import type { StringsProvider } from '../core/StringsProvider';

export class PickupNotification {
  private static readonly MAX_VISIBLE = 5;
  private renderer: Renderer;
  private strings: StringsProvider;
  private activeNotifications: Container[] = [];

  constructor(renderer: Renderer, strings: StringsProvider) {
    this.renderer = renderer;
    this.strings = strings;
  }

  show(itemName: string, count: number): void {
    const container = new Container();

    const label = this.strings.get('pickup', 'acquired', { name: itemName, count });

    const text = new Text({
      text: label,
      style: { fontSize: 14, fill: UITheme.colors.pickupText, fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true, wordWrapWidth: 250 },
    });

    const padding = 12;
    const bg = new Graphics();
    bg.roundRect(0, 0, text.width + padding * 2, text.height + padding, UITheme.panel.borderRadiusSmall);
    bg.fill({ color: UITheme.colors.overlay, alpha: UITheme.alpha.pickupBg });
    container.addChild(bg);

    text.x = padding;
    text.y = padding / 2;
    container.addChild(text);

    container.x = this.renderer.screenWidth - container.width - 20;
    container.y = 20 + this.activeNotifications.length * 40;

    this.renderer.uiLayer.addChild(container);
    this.activeNotifications.push(container);

    if (this.activeNotifications.length > PickupNotification.MAX_VISIBLE) {
      this.removeNotification(this.activeNotifications[0]);
    }

    const startTime = performance.now();
    const duration = 2000;
    const fadeStart = 1500;

    const tick = () => {
      if (!this.activeNotifications.includes(container)) return;
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
    for (let i = 0; i < this.activeNotifications.length; i++) {
      this.activeNotifications[i].y = 20 + i * 40;
    }
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
