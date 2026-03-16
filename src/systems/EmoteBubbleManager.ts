import { Container, Graphics, Text } from 'pixi.js';
import type { ICutsceneActor } from '../data/types';

interface ActiveBubble {
  bubble: Container;
  parent: Container;
  remainingMs: number;
}

export class EmoteBubbleManager {
  private activeBubbles: ActiveBubble[] = [];

  show(actor: ICutsceneActor, emote: string, durationMs: number = 1500): void {
    const displayObj = actor.getDisplayObject() as Container;

    const bubble = new Container();

    const txt = new Text({
      text: emote,
      style: { fontSize: 20, fill: 0x222222, fontFamily: 'sans-serif', fontWeight: 'bold' },
    });

    const padX = 8;
    const padY = 4;
    const bw = txt.width + padX * 2;
    const bh = txt.height + padY * 2;

    const bg = new Graphics();
    bg.roundRect(0, 0, bw, bh, 6);
    bg.fill({ color: 0xffffff, alpha: 0.95 });
    bg.stroke({ color: 0x888888, width: 1 });
    bubble.addChild(bg);

    txt.x = padX;
    txt.y = padY;
    bubble.addChild(txt);

    bubble.x = -bw / 2;
    bubble.y = -(bh + 50);

    displayObj.addChild(bubble);
    this.activeBubbles.push({ bubble, parent: displayObj, remainingMs: durationMs });
  }

  showAndWait(actor: ICutsceneActor, emote: string, durationMs: number = 1500): Promise<void> {
    this.show(actor, emote, durationMs);
    return new Promise(resolve => setTimeout(resolve, durationMs));
  }

  update(dt: number): void {
    for (let i = this.activeBubbles.length - 1; i >= 0; i--) {
      const entry = this.activeBubbles[i];
      entry.remainingMs -= dt * 1000;
      if (entry.remainingMs <= 0) {
        this.removeBubble(entry);
        this.activeBubbles.splice(i, 1);
      }
    }
  }

  private removeBubble(entry: ActiveBubble): void {
    if (entry.bubble.parent) {
      entry.bubble.parent.removeChild(entry.bubble);
    }
    entry.bubble.destroy({ children: true });
  }

  cleanup(): void {
    for (const entry of this.activeBubbles) {
      this.removeBubble(entry);
    }
    this.activeBubbles.length = 0;
  }

  destroy(): void {
    this.cleanup();
  }
}
