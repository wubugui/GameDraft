import { Container, Graphics, Text } from 'pixi.js';
import type { Renderer } from './Renderer';
import type { Camera } from './Camera';

export class CutsceneRenderer {
  private renderer: Renderer;
  private camera: Camera;

  private fadeOverlay: Graphics | null = null;
  private titleContainer: Container | null = null;
  private activeEmotes: Container[] = [];

  constructor(renderer: Renderer, camera: Camera) {
    this.renderer = renderer;
    this.camera = camera;
  }

  get screenWidth(): number { return this.renderer.screenWidth; }
  get screenHeight(): number { return this.renderer.screenHeight; }

  addToEntityLayer(child: Container): void {
    this.renderer.entityLayer.addChild(child);
  }

  private ensureFadeOverlay(): Graphics {
    if (!this.fadeOverlay) {
      this.fadeOverlay = new Graphics();
      this.fadeOverlay.rect(0, 0, this.screenWidth + 200, this.screenHeight + 200);
      this.fadeOverlay.fill(0x000000);
      this.fadeOverlay.x = -100;
      this.fadeOverlay.y = -100;
      this.fadeOverlay.alpha = 0;
      this.renderer.uiLayer.addChild(this.fadeOverlay);
    }
    return this.fadeOverlay;
  }

  fadeToBlack(duration: number): Promise<void> {
    const overlay = this.ensureFadeOverlay();
    return this.animateAlpha(overlay, overlay.alpha, 1, duration);
  }

  fadeFromBlack(duration: number): Promise<void> {
    const overlay = this.ensureFadeOverlay();
    return this.animateAlpha(overlay, overlay.alpha, 0, duration);
  }

  async flashWhite(duration: number): Promise<void> {
    const flash = new Graphics();
    flash.rect(0, 0, this.screenWidth + 200, this.screenHeight + 200);
    flash.fill(0xffffff);
    flash.x = -100;
    flash.y = -100;
    flash.alpha = 1;
    this.renderer.uiLayer.addChild(flash);

    await this.animateAlpha(flash, 1, 0, duration);
    if (flash.parent) flash.parent.removeChild(flash);
    flash.destroy();
  }

  async showTitle(text: string, duration: number): Promise<void> {
    const sw = this.screenWidth;
    const sh = this.screenHeight;

    this.titleContainer = new Container();
    const bg = new Graphics();
    bg.rect(0, 0, sw, sh);
    bg.fill({ color: 0x000000, alpha: 0.8 });
    this.titleContainer.addChild(bg);

    const t = new Text({
      text,
      style: { fontSize: 36, fill: 0xffeecc, fontFamily: 'serif', fontWeight: 'bold', align: 'center' },
    });
    t.x = (sw - t.width) / 2;
    t.y = (sh - t.height) / 2;
    this.titleContainer.addChild(t);

    this.titleContainer.alpha = 0;
    this.renderer.uiLayer.addChild(this.titleContainer);

    const fadeTime = Math.min(300, duration / 4);
    await this.animateAlpha(this.titleContainer, 0, 1, fadeTime);
    await this.wait(duration - fadeTime * 2);
    await this.animateAlpha(this.titleContainer, 1, 0, fadeTime);

    if (this.titleContainer.parent) this.titleContainer.parent.removeChild(this.titleContainer);
    this.titleContainer.destroy({ children: true });
    this.titleContainer = null;
  }

  showDialogueBox(text: string, speaker?: string): Container {
    const sw = this.screenWidth;
    const sh = this.screenHeight;

    const box = new Container();
    const bg = new Graphics();
    const boxH = 120;
    bg.rect(0, sh - boxH - 20, sw, boxH + 20);
    bg.fill({ color: 0x111122, alpha: 0.9 });
    box.addChild(bg);

    if (speaker) {
      const sp = new Text({
        text: speaker,
        style: { fontSize: 16, fill: 0xffcc88, fontFamily: 'sans-serif', fontWeight: 'bold' },
      });
      sp.x = 30;
      sp.y = sh - boxH - 5;
      box.addChild(sp);
    }

    const t = new Text({
      text,
      style: { fontSize: 14, fill: 0xdddddd, fontFamily: 'sans-serif', wordWrap: true, wordWrapWidth: sw - 60 },
    });
    t.x = 30;
    t.y = sh - boxH + 20;
    box.addChild(t);

    this.renderer.uiLayer.addChild(box);
    return box;
  }

  dismissDialogueBox(box: Container): void {
    if (box.parent) box.parent.removeChild(box);
    box.destroy({ children: true });
  }

  async showEmoteBubble(displayObj: Container, emote: string, duration: number): Promise<void> {
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
    this.activeEmotes.push(bubble);

    await this.wait(duration);

    if (bubble.parent) bubble.parent.removeChild(bubble);
    bubble.destroy({ children: true });
    const idx = this.activeEmotes.indexOf(bubble);
    if (idx >= 0) this.activeEmotes.splice(idx, 1);
  }

  async cameraMove(x: number, y: number, duration: number): Promise<void> {
    const startX = this.camera.getX();
    const startY = this.camera.getY();
    const startTime = performance.now();

    return new Promise(resolve => {
      const tick = () => {
        const t = Math.min((performance.now() - startTime) / duration, 1);
        const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        this.camera.snapTo(
          startX + (x - startX) * ease,
          startY + (y - startY) * ease,
        );
        if (t < 1) requestAnimationFrame(tick); else resolve();
      };
      requestAnimationFrame(tick);
    });
  }

  async cameraZoom(scale: number, duration: number): Promise<void> {
    const startScale = this.camera.getZoom();
    const startTime = performance.now();

    return new Promise(resolve => {
      const tick = () => {
        const t = Math.min((performance.now() - startTime) / duration, 1);
        this.camera.setZoom(startScale + (scale - startScale) * t);
        if (t < 1) requestAnimationFrame(tick); else resolve();
      };
      requestAnimationFrame(tick);
    });
  }

  wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  animateAlpha(target: { alpha: number }, from: number, to: number, duration: number): Promise<void> {
    return new Promise(resolve => {
      const startTime = performance.now();
      target.alpha = from;
      const tick = () => {
        const t = Math.min((performance.now() - startTime) / duration, 1);
        target.alpha = from + (to - from) * t;
        if (t < 1) requestAnimationFrame(tick); else resolve();
      };
      requestAnimationFrame(tick);
    });
  }

  cleanup(): void {
    if (this.fadeOverlay) {
      if (this.fadeOverlay.parent) this.fadeOverlay.parent.removeChild(this.fadeOverlay);
      this.fadeOverlay.destroy();
      this.fadeOverlay = null;
    }
    if (this.titleContainer) {
      if (this.titleContainer.parent) this.titleContainer.parent.removeChild(this.titleContainer);
      this.titleContainer.destroy({ children: true });
      this.titleContainer = null;
    }
    for (const emote of this.activeEmotes) {
      if (emote.parent) emote.parent.removeChild(emote);
      emote.destroy({ children: true });
    }
    this.activeEmotes.length = 0;
  }
}
