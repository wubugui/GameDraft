import { Container, Graphics, Text } from 'pixi.js';
import type { Renderer } from '../rendering/Renderer';

export class InspectBox {
  private renderer: Renderer;
  private container: Container | null = null;
  private resolveClose: (() => void) | null = null;
  private onKeyHandler: ((e: KeyboardEvent) => void) | null = null;
  private onClickHandler: ((e: MouseEvent) => void) | null = null;

  constructor(renderer: Renderer) {
    this.renderer = renderer;
  }

  show(text: string): Promise<void> {
    return new Promise(resolve => {
      this.resolveClose = resolve;

      this.container = new Container();

      const boxWidth = Math.min(this.renderer.screenWidth - 40, 600);
      const boxHeight = 100;
      const boxX = (this.renderer.screenWidth - boxWidth) / 2;
      const boxY = this.renderer.screenHeight - boxHeight - 30;

      const bg = new Graphics();
      bg.roundRect(boxX, boxY, boxWidth, boxHeight, 8);
      bg.fill({ color: 0x1a1a2e, alpha: 0.92 });
      bg.roundRect(boxX, boxY, boxWidth, boxHeight, 8);
      bg.stroke({ color: 0x555577, width: 1 });
      this.container.addChild(bg);

      const textObj = new Text({
        text,
        style: {
          fontSize: 16,
          fill: 0xdddddd,
          fontFamily: 'sans-serif',
          wordWrap: true,
          wordWrapWidth: boxWidth - 40,
        },
      });
      textObj.x = boxX + 20;
      textObj.y = boxY + 16;
      this.container.addChild(textObj);

      const hint = new Text({
        text: '[ 点击或按任意键关闭 ]',
        style: { fontSize: 11, fill: 0x888888, fontFamily: 'sans-serif' },
      });
      hint.anchor.set(0.5, 1);
      hint.x = this.renderer.screenWidth / 2;
      hint.y = boxY + boxHeight - 8;
      this.container.addChild(hint);

      this.renderer.uiLayer.addChild(this.container);

      setTimeout(() => {
        this.onKeyHandler = () => this.close();
        this.onClickHandler = () => this.close();
        window.addEventListener('keydown', this.onKeyHandler, { once: true });
        window.addEventListener('mousedown', this.onClickHandler, { once: true });
      }, 100);
    });
  }

  close(): void {
    if (this.onKeyHandler) {
      window.removeEventListener('keydown', this.onKeyHandler);
      this.onKeyHandler = null;
    }
    if (this.onClickHandler) {
      window.removeEventListener('mousedown', this.onClickHandler);
      this.onClickHandler = null;
    }
    if (this.container) {
      if (this.container.parent) {
        this.container.parent.removeChild(this.container);
      }
      this.container.destroy({ children: true });
      this.container = null;
    }
    this.resolveClose?.();
    this.resolveClose = null;
  }

  get isOpen(): boolean {
    return this.container !== null;
  }

  destroy(): void {
    this.close();
  }
}
