import { Container, Graphics, Text } from 'pixi.js';
import type { Renderer } from '../rendering/Renderer';
import type { EventBus } from '../core/EventBus';
import type { StringsProvider } from '../core/StringsProvider';
import type { DialogueLine, DialogueChoice } from '../data/types';

const BOX_HEIGHT = 140;
const BOX_MARGIN = 20;
const TEXT_PADDING = 20;
const TYPEWRITER_SPEED = 30;

export class DialogueUI {
  private renderer: Renderer;
  private eventBus: EventBus;
  private strings: StringsProvider;
  private container: Container | null = null;

  private speakerText: Text | null = null;
  private bodyText: Text | null = null;
  private choicesContainer: Container | null = null;

  private fullText: string = '';
  private displayedChars: number = 0;
  private typewriterTimer: number = 0;
  private isShowingFullText: boolean = false;
  private waitingForAdvance: boolean = false;
  private waitingForChoice: boolean = false;
  private willEndAfterAdvance: boolean = false;

  private onClickBound: (e: MouseEvent) => void;
  private onKeyBound: (e: KeyboardEvent) => void;
  private dialogueLineCb: (line: DialogueLine) => void;
  private dialogueChoicesCb: (choices: DialogueChoice[]) => void;
  private dialogueWillEndCb: () => void;
  private dialogueEndCb: () => void;

  constructor(renderer: Renderer, eventBus: EventBus, strings: StringsProvider) {
    this.renderer = renderer;
    this.eventBus = eventBus;
    this.strings = strings;

    this.onClickBound = this.onClick.bind(this);
    this.onKeyBound = this.onKey.bind(this);

    this.dialogueLineCb = (line) => this.showLine(line);
    this.dialogueChoicesCb = (choices) => this.showChoices(choices);
    this.dialogueWillEndCb = () => { this.willEndAfterAdvance = true; };
    this.dialogueEndCb = () => this.hide();

    this.eventBus.on('dialogue:line', this.dialogueLineCb);
    this.eventBus.on('dialogue:choices', this.dialogueChoicesCb);
    this.eventBus.on('dialogue:willEnd', this.dialogueWillEndCb);
    this.eventBus.on('dialogue:end', this.dialogueEndCb);
  }

  private ensureContainer(): void {
    if (this.container) return;

    this.container = new Container();

    const boxWidth = this.renderer.screenWidth - BOX_MARGIN * 2;
    const boxY = this.renderer.screenHeight - BOX_HEIGHT - BOX_MARGIN;

    const bg = new Graphics();
    bg.roundRect(BOX_MARGIN, boxY, boxWidth, BOX_HEIGHT, 6);
    bg.fill({ color: 0x0e0e1a, alpha: 0.92 });
    bg.roundRect(BOX_MARGIN, boxY, boxWidth, BOX_HEIGHT, 6);
    bg.stroke({ color: 0x444466, width: 1 });
    this.container.addChild(bg);

    this.speakerText = new Text({
      text: '',
      style: { fontSize: 15, fill: 0xffcc88, fontFamily: 'sans-serif', fontWeight: 'bold' },
    });
    this.speakerText.x = BOX_MARGIN + TEXT_PADDING;
    this.speakerText.y = boxY + 12;
    this.container.addChild(this.speakerText);

    this.bodyText = new Text({
      text: '',
      style: {
        fontSize: 15,
        fill: 0xdddddd,
        fontFamily: 'sans-serif',
        wordWrap: true,
        wordWrapWidth: boxWidth - TEXT_PADDING * 2,
        lineHeight: 22,
      },
    });
    this.bodyText.x = BOX_MARGIN + TEXT_PADDING;
    this.bodyText.y = boxY + 36;
    this.container.addChild(this.bodyText);

    this.renderer.uiLayer.addChild(this.container);

    window.addEventListener('mousedown', this.onClickBound);
    window.addEventListener('keydown', this.onKeyBound);
  }

  private showLine(line: DialogueLine): void {
    this.ensureContainer();
    this.clearChoices();

    this.speakerText!.text = line.speaker;
    this.fullText = line.text;
    this.displayedChars = 0;
    this.typewriterTimer = 0;
    this.isShowingFullText = false;
    this.waitingForAdvance = false;
    this.waitingForChoice = false;
    this.bodyText!.text = '';
  }

  private showChoices(choices: DialogueChoice[]): void {
    this.ensureContainer();
    this.clearChoices();
    this.waitingForChoice = true;

    const boxWidth = this.renderer.screenWidth - BOX_MARGIN * 2;
    const boxY = this.renderer.screenHeight - BOX_HEIGHT - BOX_MARGIN;

    this.choicesContainer = new Container();
    this.choicesContainer.x = BOX_MARGIN;
    this.choicesContainer.y = boxY - choices.length * 36 - 10;

    for (let i = 0; i < choices.length; i++) {
      const choice = choices[i];
      const row = new Container();
      row.y = i * 36;

      const bg = new Graphics();
      bg.roundRect(0, 0, boxWidth, 32, 4);
      bg.fill({ color: 0x1a1a2e, alpha: 0.9 });
      bg.roundRect(0, 0, boxWidth, 32, 4);
      bg.stroke({ color: choice.enabled ? 0x555577 : 0x333344, width: 1 });
      row.addChild(bg);

      const prefix = choice.ruleHintId ? `${this.strings.get('dialogue', 'ruleTag')} ${i + 1}. ` : `${i + 1}. `;
      const fillColor = choice.ruleHintId
        ? (choice.enabled ? 0xffaa44 : 0x886633)
        : (choice.enabled ? 0xdddddd : 0x666666);
      const text = new Text({
        text: `${prefix}${choice.text}`,
        style: {
          fontSize: 14,
          fill: fillColor,
          fontFamily: 'sans-serif',
        },
      });
      text.x = 14;
      text.y = 7;
      row.addChild(text);

      if (choice.enabled) {
        row.eventMode = 'static';
        row.cursor = 'pointer';

        const hoverBg = new Graphics();
        hoverBg.roundRect(0, 0, boxWidth, 32, 4);
        hoverBg.fill({ color: 0x2a2a4e, alpha: 0.9 });
        hoverBg.visible = false;
        row.addChildAt(hoverBg, 0);

        row.on('pointerover', () => { hoverBg.visible = true; bg.visible = false; });
        row.on('pointerout', () => { hoverBg.visible = false; bg.visible = true; });
        row.on('pointerdown', () => {
          this.waitingForChoice = false;
          this.eventBus.emit('dialogue:choiceSelected', { index: choice.index });
        });
      }

      this.choicesContainer.addChild(row);
    }

    this.container!.addChild(this.choicesContainer);
  }

  private clearChoices(): void {
    if (this.choicesContainer) {
      if (this.choicesContainer.parent) {
        this.choicesContainer.parent.removeChild(this.choicesContainer);
      }
      this.choicesContainer.destroy({ children: true });
      this.choicesContainer = null;
    }
  }

  update(dt: number): void {
    if (!this.container || this.isShowingFullText || this.waitingForAdvance || this.waitingForChoice) return;

    if (this.displayedChars < this.fullText.length) {
      this.typewriterTimer += dt;
      const charsToShow = Math.floor(this.typewriterTimer * TYPEWRITER_SPEED);
      if (charsToShow > this.displayedChars) {
        this.displayedChars = Math.min(charsToShow, this.fullText.length);
        this.bodyText!.text = this.fullText.substring(0, this.displayedChars);
      }

      if (this.displayedChars >= this.fullText.length) {
        this.isShowingFullText = true;
        this.waitingForAdvance = true;
      }
    }
  }

  private onClick(_e: MouseEvent): void {
    this.handleAdvance();
  }

  private onKey(e: KeyboardEvent): void {
    if (e.code === 'Space' || e.code === 'Enter') {
      this.handleAdvance();
    }
    if (this.waitingForChoice && e.code >= 'Digit1' && e.code <= 'Digit9') {
      const idx = parseInt(e.code.replace('Digit', ''), 10) - 1;
      this.eventBus.emit('dialogue:choiceSelected', { index: idx });
      this.waitingForChoice = false;
    }
  }

  private handleAdvance(): void {
    if (this.waitingForChoice) return;

    if (!this.isShowingFullText) {
      this.displayedChars = this.fullText.length;
      this.bodyText!.text = this.fullText;
      this.isShowingFullText = true;
      this.waitingForAdvance = true;
      return;
    }

    if (this.waitingForAdvance) {
      this.waitingForAdvance = false;
      if (this.willEndAfterAdvance) {
        this.willEndAfterAdvance = false;
        this.eventBus.emit('dialogue:advanceEnd', {});
      } else {
        this.eventBus.emit('dialogue:advance', {});
      }
    }
  }

  hide(): void {
    this.clearChoices();
    if (this.container) {
      if (this.container.parent) {
        this.container.parent.removeChild(this.container);
      }
      this.container.destroy({ children: true });
      this.container = null;
      this.speakerText = null;
      this.bodyText = null;
    }
    this.fullText = '';
    this.displayedChars = 0;
    this.isShowingFullText = false;
    this.waitingForAdvance = false;
    this.waitingForChoice = false;
    this.willEndAfterAdvance = false;

    window.removeEventListener('mousedown', this.onClickBound);
    window.removeEventListener('keydown', this.onKeyBound);
  }

  destroy(): void {
    this.hide();
    this.eventBus.off('dialogue:line', this.dialogueLineCb);
    this.eventBus.off('dialogue:choices', this.dialogueChoicesCb);
    this.eventBus.off('dialogue:willEnd', this.dialogueWillEndCb);
    this.eventBus.off('dialogue:end', this.dialogueEndCb);
  }
}
