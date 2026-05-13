import { Container, Graphics, Text } from 'pixi.js';
import { UITheme } from './UITheme';
import type { Renderer } from '../rendering/Renderer';
import type { EventBus } from '../core/EventBus';

interface NotificationEntry {
  container: Container;
  createdAt: number;
  fadingOut: boolean;
}

const DISPLAY_DURATION = 4000;
const FADE_DURATION = 800;
const SLOT_HEIGHT = 34;
const MAX_VISIBLE = 5;
const STAGGER_DELAY = 400;

export class NotificationUI {
  private renderer: Renderer;
  private eventBus: EventBus;
  private listContainer: Container;
  private entries: NotificationEntry[] = [];

  private showCb: (p: { text: string; type?: string }) => void;
  private queue: { text: string; type?: string }[] = [];
  private lastAddTime: number = 0;

  constructor(renderer: Renderer, eventBus: EventBus) {
    this.renderer = renderer;
    this.eventBus = eventBus;

    this.listContainer = new Container();
    this.renderer.uiLayer.addChild(this.listContainer);

    this.showCb = (p) => this.enqueue(p.text, p.type);
    this.eventBus.on('notification:show', this.showCb);
  }

  private enqueue(text: string, type?: string): void {
    this.queue.push({ text, type });
  }

  private addNotification(text: string, type?: string): void {
    const typeColors: Record<string, number> = {
      quest: UITheme.colors.notifQuest,
      rule: UITheme.colors.notifRule,
      item: UITheme.colors.notifItem,
      warning: UITheme.colors.notifWarning,
      error: UITheme.colors.notifError,
      info: UITheme.colors.notifInfo,
    };
    const color = typeColors[type ?? 'info'] ?? UITheme.colors.notifInfo;

    const entry = new Container();

    const bg = new Graphics();
    bg.roundRect(0, 0, 240, SLOT_HEIGHT - 4, UITheme.panel.borderRadiusSmall);
    bg.fill({ color: UITheme.colors.dialogueBg, alpha: UITheme.alpha.notifBg });
    entry.addChild(bg);

    const label = new Text({
      text,
      style: { fontSize: 12, fill: color, fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true, wordWrapWidth: 220 },
    });
    label.x = 10;
    label.y = 8;
    entry.addChild(label);

    entry.x = (this.renderer.screenWidth - 240) / 2;
    entry.y = 0;

    const record: NotificationEntry = {
      container: entry,
      createdAt: performance.now(),
      fadingOut: false,
    };

    this.entries.push(record);
    this.listContainer.addChild(entry);

    if (this.entries.length > MAX_VISIBLE) {
      const oldest = this.entries.shift();
      if (oldest) {
        this.listContainer.removeChild(oldest.container);
        oldest.container.destroy({ children: true });
      }
    }

    this.layoutEntries();
  }

  private layoutEntries(): void {
    const baseY = 50;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const offset = this.entries.length - 1 - i;
      this.entries[i].container.y = baseY + offset * SLOT_HEIGHT;
    }
  }

  update(_dt: number): void {
    const now = performance.now();

    if (this.queue.length > 0 && now - this.lastAddTime >= STAGGER_DELAY) {
      const item = this.queue.shift()!;
      this.addNotification(item.text, item.type);
      this.lastAddTime = now;
    }

    const toRemove: number[] = [];

    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];
      const elapsed = now - entry.createdAt;

      if (elapsed > DISPLAY_DURATION && !entry.fadingOut) {
        entry.fadingOut = true;
      }

      if (entry.fadingOut) {
        const fadeElapsed = elapsed - DISPLAY_DURATION;
        entry.container.alpha = Math.max(0, 1 - fadeElapsed / FADE_DURATION);
        if (fadeElapsed >= FADE_DURATION) {
          toRemove.push(i);
        }
      }
    }

    for (let i = toRemove.length - 1; i >= 0; i--) {
      const idx = toRemove[i];
      const entry = this.entries[idx];
      this.listContainer.removeChild(entry.container);
      entry.container.destroy({ children: true });
      this.entries.splice(idx, 1);
    }

    if (toRemove.length > 0) {
      this.layoutEntries();
    }
  }

  destroy(): void {
    this.eventBus.off('notification:show', this.showCb);
    for (const entry of this.entries) {
      entry.container.destroy({ children: true });
    }
    this.entries = [];
    if (this.listContainer.parent) {
      this.listContainer.parent.removeChild(this.listContainer);
    }
    this.listContainer.destroy({ children: true });
  }
}
