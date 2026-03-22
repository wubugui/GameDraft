import { Container, Graphics, Text } from 'pixi.js';
import type { Renderer } from '../rendering/Renderer';
import type { EventBus } from '../core/EventBus';
import type { StringsProvider } from '../core/StringsProvider';
import type { ResolvedOption } from '../data/types';

const BOX_MARGIN = 20;
const TEXT_PADDING = 20;
const TYPEWRITER_SPEED = 35;

enum EncounterPhase {
  Inactive,
  Narrative,
  Options,
  Result,
}

export class EncounterUI {
  private renderer: Renderer;
  private eventBus: EventBus;
  private strings: StringsProvider;
  private container: Container | null = null;
  private phase: EncounterPhase = EncounterPhase.Inactive;

  private narrativeText: Text | null = null;
  private optionsContainer: Container | null = null;
  private resultText: Text | null = null;

  private fullText: string = '';
  private displayedChars: number = 0;
  private typewriterTimer: number = 0;
  private textComplete: boolean = false;

  private onClickBound: (e: MouseEvent) => void;
  private onKeyBound: (e: KeyboardEvent) => void;

  private narrativeCb: (payload: { text: string }) => void;
  private optionsCb: (payload: { options: ResolvedOption[] }) => void;
  private resultCb: (payload: { text: string }) => void;
  private endCb: () => void;

  constructor(renderer: Renderer, eventBus: EventBus, strings: StringsProvider) {
    this.renderer = renderer;
    this.eventBus = eventBus;
    this.strings = strings;

    this.onClickBound = this.onClick.bind(this);
    this.onKeyBound = this.onKey.bind(this);

    this.narrativeCb = (p) => this.showNarrative(p.text);
    this.optionsCb = (p) => this.showOptions(p.options);
    this.resultCb = (p) => this.showResult(p.text);
    this.endCb = () => this.hide();

    this.eventBus.on('encounter:narrative', this.narrativeCb);
    this.eventBus.on('encounter:options', this.optionsCb);
    this.eventBus.on('encounter:result', this.resultCb);
    this.eventBus.on('encounter:end', this.endCb);
  }

  private ensureContainer(): void {
    if (this.container) return;

    this.container = new Container();
    this.renderer.uiLayer.addChild(this.container);

    window.addEventListener('mousedown', this.onClickBound);
    window.addEventListener('keydown', this.onKeyBound);
  }

  private showNarrative(text: string): void {
    this.ensureContainer();
    this.clearAll();
    this.phase = EncounterPhase.Narrative;

    const boxWidth = this.renderer.screenWidth - BOX_MARGIN * 2;
    const boxHeight = 120;
    const boxY = this.renderer.screenHeight - boxHeight - BOX_MARGIN;

    const bg = new Graphics();
    bg.roundRect(BOX_MARGIN, boxY, boxWidth, boxHeight, 6);
    bg.fill({ color: 0x1a0a0a, alpha: 0.92 });
    bg.roundRect(BOX_MARGIN, boxY, boxWidth, boxHeight, 6);
    bg.stroke({ color: 0x664444, width: 1 });
    this.container!.addChild(bg);

    this.narrativeText = new Text({
      text: '',
      style: {
        fontSize: 15,
        fill: 0xccbbaa,
        fontFamily: 'sans-serif',
        wordWrap: true,
        wordWrapWidth: boxWidth - TEXT_PADDING * 2,
        lineHeight: 22,
        fontStyle: 'italic',
      },
    });
    this.narrativeText.x = BOX_MARGIN + TEXT_PADDING;
    this.narrativeText.y = boxY + TEXT_PADDING;
    this.container!.addChild(this.narrativeText);

    this.fullText = text;
    this.displayedChars = 0;
    this.typewriterTimer = 0;
    this.textComplete = false;
  }

  private showOptions(options: ResolvedOption[]): void {
    this.ensureContainer();
    this.clearNarrative();
    this.phase = EncounterPhase.Options;

    const boxWidth = this.renderer.screenWidth - BOX_MARGIN * 2;

    this.optionsContainer = new Container();
    const totalHeight = options.length * 40 + 20;
    const startY = this.renderer.screenHeight - totalHeight - BOX_MARGIN;
    this.optionsContainer.y = startY;

    const bg = new Graphics();
    bg.roundRect(BOX_MARGIN, 0, boxWidth, totalHeight, 6);
    bg.fill({ color: 0x1a0a0a, alpha: 0.92 });
    bg.roundRect(BOX_MARGIN, 0, boxWidth, totalHeight, 6);
    bg.stroke({ color: 0x664444, width: 1 });
    this.optionsContainer.addChild(bg);

    for (let i = 0; i < options.length; i++) {
      const opt = options[i];
      const row = new Container();
      row.y = 10 + i * 40;
      row.x = BOX_MARGIN + 10;

      const typeColors: Record<string, number> = {
        general: 0xdddddd,
        rule: 0x88ddaa,
        special: 0xddaa88,
      };
      const typeLabel: Record<string, string> = {
        general: '',
        rule: `${this.strings.get('encounter', 'ruleTag')} `,
        special: `${this.strings.get('encounter', 'specialTag')} `,
      };

      const color = opt.enabled ? (typeColors[opt.type] ?? 0xdddddd) : 0x666666;

      const rowBg = new Graphics();
      rowBg.roundRect(0, 0, boxWidth - 20, 34, 4);
      rowBg.fill({ color: 0x221111, alpha: 0.6 });
      row.addChild(rowBg);

      const label = `${i + 1}. ${typeLabel[opt.type] ?? ''}${opt.text}`;
      const suffix = !opt.enabled && opt.disableReason ? ` (${opt.disableReason})` : '';

      const text = new Text({
        text: label + suffix,
        style: { fontSize: 14, fill: color, fontFamily: 'sans-serif' },
      });
      text.x = 12;
      text.y = 8;
      row.addChild(text);

      if (opt.enabled) {
        row.eventMode = 'static';
        row.cursor = 'pointer';

        const hoverBg = new Graphics();
        hoverBg.roundRect(0, 0, boxWidth - 20, 34, 4);
        hoverBg.fill({ color: 0x332222, alpha: 0.8 });
        hoverBg.visible = false;
        row.addChildAt(hoverBg, 0);

        row.on('pointerover', () => { hoverBg.visible = true; rowBg.visible = false; });
        row.on('pointerout', () => { hoverBg.visible = false; rowBg.visible = true; });
        row.on('pointerdown', () => {
          this.eventBus.emit('encounter:choiceSelected', { index: opt.index });
        });
      }

      this.optionsContainer.addChild(row);
    }

    this.container!.addChild(this.optionsContainer);
  }

  private showResult(text: string): void {
    this.ensureContainer();
    this.clearOptions();
    this.phase = EncounterPhase.Result;

    const boxWidth = this.renderer.screenWidth - BOX_MARGIN * 2;
    const boxHeight = 100;
    const boxY = this.renderer.screenHeight - boxHeight - BOX_MARGIN;

    const bg = new Graphics();
    bg.roundRect(BOX_MARGIN, boxY, boxWidth, boxHeight, 6);
    bg.fill({ color: 0x1a0a0a, alpha: 0.92 });
    this.container!.addChild(bg);

    this.resultText = new Text({
      text: '',
      style: {
        fontSize: 15,
        fill: 0xccbbaa,
        fontFamily: 'sans-serif',
        wordWrap: true,
        wordWrapWidth: boxWidth - TEXT_PADDING * 2,
        lineHeight: 22,
      },
    });
    this.resultText.x = BOX_MARGIN + TEXT_PADDING;
    this.resultText.y = boxY + TEXT_PADDING;
    this.container!.addChild(this.resultText);

    this.fullText = text;
    this.displayedChars = 0;
    this.typewriterTimer = 0;
    this.textComplete = false;
  }

  update(dt: number): void {
    if (this.phase === EncounterPhase.Inactive || this.phase === EncounterPhase.Options) return;
    if (this.textComplete) return;

    const textObj = this.phase === EncounterPhase.Narrative ? this.narrativeText : this.resultText;
    if (!textObj) return;

    this.typewriterTimer += dt;
    const charsToShow = Math.floor(this.typewriterTimer * TYPEWRITER_SPEED);
    if (charsToShow > this.displayedChars) {
      this.displayedChars = Math.min(charsToShow, this.fullText.length);
      textObj.text = this.fullText.substring(0, this.displayedChars);
    }
    if (this.displayedChars >= this.fullText.length) {
      this.textComplete = true;
    }
  }

  private onClick(_e: MouseEvent): void {
    this.handleAdvance();
  }

  private onKey(e: KeyboardEvent): void {
    if (e.code === 'Space' || e.code === 'Enter') {
      this.handleAdvance();
    }
    if (this.phase === EncounterPhase.Options && e.code >= 'Digit1' && e.code <= 'Digit9') {
      const idx = parseInt(e.code.replace('Digit', ''), 10) - 1;
      this.eventBus.emit('encounter:choiceSelected', { index: idx });
    }
  }

  private handleAdvance(): void {
    if (this.phase === EncounterPhase.Options) return;

    if (!this.textComplete) {
      const textObj = this.phase === EncounterPhase.Narrative ? this.narrativeText : this.resultText;
      if (textObj) {
        this.displayedChars = this.fullText.length;
        textObj.text = this.fullText;
        this.textComplete = true;
      }
      return;
    }

    if (this.phase === EncounterPhase.Narrative) {
      this.eventBus.emit('encounter:narrativeDone', {});
    } else if (this.phase === EncounterPhase.Result) {
      this.eventBus.emit('encounter:resultDone', {});
    }
  }

  private clearNarrative(): void {
    if (this.narrativeText) {
      this.narrativeText.destroy();
      this.narrativeText = null;
    }
  }

  private clearOptions(): void {
    if (this.optionsContainer) {
      if (this.optionsContainer.parent) {
        this.optionsContainer.parent.removeChild(this.optionsContainer);
      }
      this.optionsContainer.destroy({ children: true });
      this.optionsContainer = null;
    }
  }

  private clearAll(): void {
    if (this.container) {
      const children = [...this.container.children];
      for (const child of children) {
        this.container.removeChild(child);
        child.destroy({ children: true });
      }
    }
    this.narrativeText = null;
    this.optionsContainer = null;
    this.resultText = null;
  }

  hide(): void {
    this.phase = EncounterPhase.Inactive;
    this.clearAll();
    if (this.container) {
      if (this.container.parent) {
        this.container.parent.removeChild(this.container);
      }
      this.container.destroy({ children: true });
      this.container = null;
    }
    this.fullText = '';
    this.displayedChars = 0;
    this.textComplete = false;
    window.removeEventListener('mousedown', this.onClickBound);
    window.removeEventListener('keydown', this.onKeyBound);
  }

  destroy(): void {
    this.hide();
    this.eventBus.off('encounter:narrative', this.narrativeCb);
    this.eventBus.off('encounter:options', this.optionsCb);
    this.eventBus.off('encounter:result', this.resultCb);
    this.eventBus.off('encounter:end', this.endCb);
  }
}
