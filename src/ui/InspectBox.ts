import { Container, Graphics, Text } from 'pixi.js';
import { UITheme } from './UITheme';
import type { Renderer } from '../rendering/Renderer';
import type { StringsProvider } from '../core/StringsProvider';

export class InspectBox {
  private renderer: Renderer;
  private strings: StringsProvider;
  private container: Container | null = null;
  private resolveClose: (() => void) | null = null;
  private onKeyHandler: ((e: KeyboardEvent) => void) | null = null;
  private onClickHandler: ((e: MouseEvent) => void) | null = null;
  private showTimerId: ReturnType<typeof setTimeout> | null = null;

  constructor(renderer: Renderer, strings: StringsProvider) {
    this.renderer = renderer;
    this.strings = strings;
  }

  show(text: string): Promise<void> {
    return new Promise(resolve => {
      this.resolveClose = resolve;

      this.container = new Container();

      const boxWidth = Math.min(this.renderer.screenWidth - 40, 600);

      const textObj = new Text({
        text,
        style: {
          fontSize: 16,
          fill: UITheme.colors.body,
          fontFamily: UITheme.fonts.ui,
          wordWrap: true, breakWords: true,
          wordWrapWidth: boxWidth - 40,
        },
      });

      const boxHeight = Math.min(Math.max(100, textObj.height + 60), this.renderer.screenHeight - 80);
      const boxX = (this.renderer.screenWidth - boxWidth) / 2;
      const boxY = this.renderer.screenHeight - boxHeight - 30;

      const bg = new Graphics();
      bg.roundRect(boxX, boxY, boxWidth, boxHeight, UITheme.panel.borderRadius);
      bg.fill({ color: UITheme.colors.panelBgAlt, alpha: UITheme.alpha.dialogueBg });
      bg.roundRect(boxX, boxY, boxWidth, boxHeight, UITheme.panel.borderRadius);
      bg.stroke({ color: UITheme.colors.borderActive, width: 1 });
      this.container.addChild(bg);

      textObj.x = boxX + 20;
      textObj.y = boxY + 16;
      this.container.addChild(textObj);

      const boxMask = new Graphics();
      boxMask.rect(boxX, boxY, boxWidth, boxHeight);
      boxMask.fill({ color: 0xffffff });
      this.container.addChild(boxMask);
      textObj.mask = boxMask;

      const hint = new Text({
        text: this.strings.get('inspectBox', 'closeHint'),
        style: { fontSize: 11, fill: UITheme.colors.hintMid, fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true, wordWrapWidth: 200 },
      });
      hint.anchor.set(0.5, 1);
      hint.x = this.renderer.screenWidth / 2;
      hint.y = boxY + boxHeight - 8;
      this.container.addChild(hint);

      this.renderer.uiLayer.addChild(this.container);

      this.showTimerId = setTimeout(() => {
        this.showTimerId = null;
        this.onKeyHandler = () => this.close();
        this.onClickHandler = () => this.close();
        window.addEventListener('keydown', this.onKeyHandler, { once: true });
        window.addEventListener('mousedown', this.onClickHandler, { once: true });
      }, 100);
    });
  }

  close(): void {
    if (this.showTimerId !== null) {
      clearTimeout(this.showTimerId);
      this.showTimerId = null;
    }
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
