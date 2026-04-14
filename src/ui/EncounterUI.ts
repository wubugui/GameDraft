import { Container, Graphics, Text } from 'pixi.js';
import { UITheme } from './UITheme';
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
  private narrativeBg: Graphics | null = null;
  private optionsContainer: Container | null = null;
  private resultText: Text | null = null;
  private currentOptions: ResolvedOption[] = [];

  private fullText: string = '';
  private displayedChars: number = 0;
  private typewriterTimer: number = 0;
  private textComplete: boolean = false;

  private onClickBound: (e: PointerEvent) => void;
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

    window.addEventListener('pointerdown', this.onClickBound);
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
    bg.roundRect(BOX_MARGIN, boxY, boxWidth, boxHeight, UITheme.panel.borderRadiusMed);
    bg.fill({ color: UITheme.colors.encounterBg, alpha: UITheme.alpha.encounterBg });
    bg.roundRect(BOX_MARGIN, boxY, boxWidth, boxHeight, UITheme.panel.borderRadiusMed);
    bg.stroke({ color: UITheme.colors.encounterBorder, width: 1 });
    this.container!.addChild(bg);
    this.narrativeBg = bg;

    this.narrativeText = new Text({
      text: '',
      style: {
        fontSize: 15,
        fill: UITheme.colors.bodyMuted,
        fontFamily: UITheme.fonts.ui,
        wordWrap: true, breakWords: true,
        wordWrapWidth: boxWidth - TEXT_PADDING * 2,
        lineHeight: 22,
        fontStyle: 'italic',
      },
    });
    this.narrativeText.x = BOX_MARGIN + TEXT_PADDING;
    this.narrativeText.y = boxY + TEXT_PADDING;
    this.container!.addChild(this.narrativeText);

    const narrativeMask = new Graphics();
    narrativeMask.rect(BOX_MARGIN + TEXT_PADDING, boxY + TEXT_PADDING, boxWidth - TEXT_PADDING * 2, boxHeight - TEXT_PADDING * 2);
    narrativeMask.fill({ color: 0xffffff });
    this.container!.addChild(narrativeMask);
    this.narrativeText.mask = narrativeMask;

    this.fullText = text;
    this.displayedChars = 0;
    this.typewriterTimer = 0;
    this.textComplete = false;
  }

  private showOptions(options: ResolvedOption[]): void {
    this.ensureContainer();
    this.clearNarrative();
    this.phase = EncounterPhase.Options;
    this.currentOptions = options;

    const boxWidth = this.renderer.screenWidth - BOX_MARGIN * 2;

    this.optionsContainer = new Container();
    const totalHeight = options.length * 40 + 20;
    const startY = this.renderer.screenHeight - totalHeight - BOX_MARGIN;
    this.optionsContainer.y = startY;

    const bg = new Graphics();
    bg.roundRect(BOX_MARGIN, 0, boxWidth, totalHeight, UITheme.panel.borderRadiusMed);
    bg.fill({ color: UITheme.colors.encounterBg, alpha: UITheme.alpha.encounterBg });
    bg.roundRect(BOX_MARGIN, 0, boxWidth, totalHeight, UITheme.panel.borderRadiusMed);
    bg.stroke({ color: UITheme.colors.encounterBorder, width: 1 });
    this.optionsContainer.addChild(bg);

    for (let i = 0; i < options.length; i++) {
      const opt = options[i];
      const row = new Container();
      row.y = 10 + i * 40;
      row.x = BOX_MARGIN + 10;

      const typeColors: Record<string, number> = {
        general: UITheme.colors.body,
        rule: UITheme.colors.greenBright,
        special: UITheme.colors.encounterSpecial,
      };
      const typeLabel: Record<string, string> = {
        general: '',
        rule: `${this.strings.get('encounter', 'ruleTag')} `,
        special: `${this.strings.get('encounter', 'specialTag')} `,
      };

      const color = opt.enabled ? (typeColors[opt.type] ?? UITheme.colors.body) : UITheme.colors.disabled;

      const rowBg = new Graphics();
      rowBg.roundRect(0, 0, boxWidth - 20, 34, UITheme.panel.borderRadiusSmall);
      rowBg.fill({ color: UITheme.colors.encounterRow, alpha: UITheme.alpha.rowBgLight });
      row.addChild(rowBg);

      const label = `${i + 1}. ${typeLabel[opt.type] ?? ''}${opt.text}`;
      const suffix = !opt.enabled && opt.disableReason ? ` (${opt.disableReason})` : '';

      const text = new Text({
        text: label + suffix,
        style: { fontSize: 14, fill: color, fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true, wordWrapWidth: boxWidth - 80 },
      });
      text.x = 12;
      text.y = 8;
      row.addChild(text);

      if (opt.enabled) {
        row.eventMode = 'static';
        row.cursor = 'pointer';

        const hoverBg = new Graphics();
        hoverBg.roundRect(0, 0, boxWidth - 20, 34, UITheme.panel.borderRadiusSmall);
        hoverBg.fill({ color: UITheme.colors.encounterHover, alpha: UITheme.alpha.rowBg });
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
    bg.roundRect(BOX_MARGIN, boxY, boxWidth, boxHeight, UITheme.panel.borderRadiusMed);
    bg.fill({ color: UITheme.colors.encounterBg, alpha: UITheme.alpha.encounterBg });
    this.container!.addChild(bg);

    this.resultText = new Text({
      text: '',
      style: {
        fontSize: 15,
        fill: UITheme.colors.bodyMuted,
        fontFamily: UITheme.fonts.ui,
        wordWrap: true, breakWords: true,
        wordWrapWidth: boxWidth - TEXT_PADDING * 2,
        lineHeight: 22,
      },
    });
    this.resultText.x = BOX_MARGIN + TEXT_PADDING;
    this.resultText.y = boxY + TEXT_PADDING;
    this.container!.addChild(this.resultText);

    const resultMask = new Graphics();
    resultMask.rect(BOX_MARGIN + TEXT_PADDING, boxY + TEXT_PADDING, boxWidth - TEXT_PADDING * 2, boxHeight - TEXT_PADDING * 2);
    resultMask.fill({ color: 0xffffff });
    this.container!.addChild(resultMask);
    this.resultText.mask = resultMask;

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

  private onClick(_e: PointerEvent): void {
    this.handleAdvance();
  }

  private onKey(e: KeyboardEvent): void {
    if (e.code === 'Space' || e.code === 'Enter') {
      this.handleAdvance();
    }
    if (this.phase === EncounterPhase.Options && e.code >= 'Digit1' && e.code <= 'Digit9') {
      const idx = parseInt(e.code.replace('Digit', ''), 10) - 1;
      const opt = this.currentOptions[idx];
      if (opt && opt.enabled) {
        this.eventBus.emit('encounter:choiceSelected', { index: opt.index });
      }
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
    if (this.narrativeBg) {
      if (this.narrativeBg.parent) this.narrativeBg.parent.removeChild(this.narrativeBg);
      this.narrativeBg.destroy();
      this.narrativeBg = null;
    }
    if (this.narrativeText) {
      if (this.narrativeText.parent) this.narrativeText.parent.removeChild(this.narrativeText);
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
    this.currentOptions = [];
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
    this.narrativeBg = null;
    this.optionsContainer = null;
    this.resultText = null;
    this.currentOptions = [];
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
    window.removeEventListener('pointerdown', this.onClickBound);
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
