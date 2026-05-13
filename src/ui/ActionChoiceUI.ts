import { Container, Graphics, Text } from 'pixi.js';
import { UITheme } from './UITheme';
import type { Renderer } from '../rendering/Renderer';

export interface ActionChoiceOption {
  text: string;
}

const BOX_MARGIN = 24;
const ROW_HEIGHT = 42;

export class ActionChoiceUI {
  private renderer: Renderer;
  private container: Container | null = null;
  private resolveChoice: ((index: number | null) => void) | null = null;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor(renderer: Renderer) {
    this.renderer = renderer;
  }

  choose(prompt: string, options: ActionChoiceOption[], allowCancel: boolean): Promise<number | null> {
    this.close(null);
    const cleanOptions = options
      .map((o) => ({ text: String(o.text ?? '').trim() }))
      .filter((o) => o.text.length > 0);
    if (cleanOptions.length === 0) return Promise.resolve(null);

    return new Promise((resolve) => {
      this.resolveChoice = resolve;
      this.container = new Container();
      this.renderer.uiLayer.addChild(this.container);

      const boxWidth = Math.min(this.renderer.screenWidth - BOX_MARGIN * 2, 720);
      const x = (this.renderer.screenWidth - boxWidth) / 2;
      const promptText = String(prompt ?? '').trim();
      const promptHeight = promptText ? 44 : 0;
      const hintHeight = allowCancel ? 24 : 0;
      const boxHeight = promptHeight + cleanOptions.length * ROW_HEIGHT + hintHeight + 24;
      const y = this.renderer.screenHeight - boxHeight - BOX_MARGIN;

      const bg = new Graphics();
      bg.roundRect(x, y, boxWidth, boxHeight, UITheme.panel.borderRadiusMed);
      bg.fill({ color: UITheme.colors.panelBgAlt, alpha: UITheme.alpha.dialogueBg });
      bg.roundRect(x, y, boxWidth, boxHeight, UITheme.panel.borderRadiusMed);
      bg.stroke({ color: UITheme.colors.borderActive, width: 1 });
      this.container.addChild(bg);

      let cursorY = y + 14;
      if (promptText) {
        const title = new Text({
          text: promptText,
          style: {
            fontSize: 16,
            fill: UITheme.colors.title,
            fontFamily: UITheme.fonts.ui,
            wordWrap: true,
            breakWords: true,
            wordWrapWidth: boxWidth - 36,
          },
        });
        title.x = x + 18;
        title.y = cursorY;
        this.container.addChild(title);
        cursorY += promptHeight;
      }

      cleanOptions.forEach((opt, idx) => {
        const row = new Container();
        row.x = x + 12;
        row.y = cursorY + idx * ROW_HEIGHT;
        row.eventMode = 'static';
        row.cursor = 'pointer';

        const rowBg = new Graphics();
        rowBg.roundRect(0, 0, boxWidth - 24, ROW_HEIGHT - 8, UITheme.panel.borderRadiusSmall);
        rowBg.fill({ color: UITheme.colors.rowBg, alpha: UITheme.alpha.rowBgLight });
        row.addChild(rowBg);

        const hoverBg = new Graphics();
        hoverBg.roundRect(0, 0, boxWidth - 24, ROW_HEIGHT - 8, UITheme.panel.borderRadiusSmall);
        hoverBg.fill({ color: UITheme.colors.rowHover, alpha: UITheme.alpha.rowHover });
        hoverBg.visible = false;
        row.addChild(hoverBg);

        const label = new Text({
          text: `${idx + 1}. ${opt.text}`,
          style: {
            fontSize: 14,
            fill: UITheme.colors.choiceEnabled,
            fontFamily: UITheme.fonts.ui,
            wordWrap: true,
            breakWords: true,
            wordWrapWidth: boxWidth - 56,
          },
        });
        label.x = 12;
        label.y = 9;
        row.addChild(label);

        row.on('pointerover', () => {
          hoverBg.visible = true;
          rowBg.visible = false;
        });
        row.on('pointerout', () => {
          hoverBg.visible = false;
          rowBg.visible = true;
        });
        row.on('pointerdown', () => this.close(idx));
        this.container!.addChild(row);
      });

      if (allowCancel) {
        const hint = new Text({
          text: 'Esc 取消',
          style: { fontSize: 11, fill: UITheme.colors.hintMid, fontFamily: UITheme.fonts.ui },
        });
        hint.x = x + boxWidth - 72;
        hint.y = y + boxHeight - 22;
        this.container.addChild(hint);
      }

      this.keyHandler = (e: KeyboardEvent) => {
        if (allowCancel && e.code === 'Escape') {
          e.preventDefault();
          this.close(null);
          return;
        }
        if (e.code.startsWith('Digit') || e.code.startsWith('Numpad')) {
          const raw = e.code.startsWith('Digit')
            ? e.code.slice('Digit'.length)
            : e.code.slice('Numpad'.length);
          const n = Number(raw);
          if (Number.isInteger(n) && n >= 1 && n <= cleanOptions.length) {
            e.preventDefault();
            this.close(n - 1);
          }
        }
      };
      window.addEventListener('keydown', this.keyHandler);
    });
  }

  close(result: number | null = null): void {
    if (this.keyHandler) {
      window.removeEventListener('keydown', this.keyHandler);
      this.keyHandler = null;
    }
    if (this.container) {
      if (this.container.parent) this.container.parent.removeChild(this.container);
      this.container.destroy({ children: true });
      this.container = null;
    }
    const resolve = this.resolveChoice;
    this.resolveChoice = null;
    resolve?.(result);
  }

  destroy(): void {
    this.close(null);
  }
}
