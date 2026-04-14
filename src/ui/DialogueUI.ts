import { Container, Graphics, Text } from 'pixi.js';
import { UITheme, fadeIn } from './UITheme';
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
  private currentChoices: DialogueChoice[] = [];

  private onClickBound: (e: PointerEvent) => void;
  private onKeyBound: (e: KeyboardEvent) => void;
  private dialogueLineCb: (line: DialogueLine) => void;
  private dialogueChoicesCb: (choices: DialogueChoice[]) => void;
  private dialogueWillEndCb: () => void;
  private dialogueEndCb: () => void;
  private dialoguePrepareBeatCb: () => void;
  private dialogueHidePanelCb: () => void;

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
    this.dialoguePrepareBeatCb = () => this.onPrepareBeat();
    this.dialogueHidePanelCb = () => this.hide();

    this.eventBus.on('dialogue:line', this.dialogueLineCb);
    this.eventBus.on('dialogue:choices', this.dialogueChoicesCb);
    this.eventBus.on('dialogue:willEnd', this.dialogueWillEndCb);
    this.eventBus.on('dialogue:end', this.dialogueEndCb);
    this.eventBus.on('dialogue:prepareBeat', this.dialoguePrepareBeatCb);
    this.eventBus.on('dialogue:hidePanel', this.dialogueHidePanelCb);
  }

  /** 推进到下一拍之前清空当前台词区（与推迟 action、下一句台词顺序配合）。 */
  private onPrepareBeat(): void {
    if (!this.container || !this.speakerText || !this.bodyText) return;
    this.clearChoices();
    this.speakerText.text = '';
    this.bodyText.text = '';
    this.fullText = '';
    this.displayedChars = 0;
    this.typewriterTimer = 0;
    this.isShowingFullText = false;
    this.waitingForAdvance = false;
    this.waitingForChoice = false;
  }

  private ensureContainer(): void {
    if (this.container) return;

    this.container = new Container();

    const boxWidth = this.renderer.screenWidth - BOX_MARGIN * 2;
    const boxY = this.renderer.screenHeight - BOX_HEIGHT - BOX_MARGIN;

    const bg = new Graphics();
    bg.roundRect(BOX_MARGIN, boxY, boxWidth, BOX_HEIGHT, UITheme.panel.borderRadiusMed);
    bg.fill({ color: UITheme.colors.dialogueBg, alpha: UITheme.alpha.dialogueBg });
    bg.roundRect(BOX_MARGIN, boxY, boxWidth, BOX_HEIGHT, UITheme.panel.borderRadiusMed);
    bg.stroke({ color: UITheme.colors.panelBorder, width: 1 });
    this.container.addChild(bg);

    this.speakerText = new Text({
      text: '',
      style: { fontSize: 15, fill: UITheme.colors.title, fontFamily: UITheme.fonts.ui, fontWeight: 'bold', wordWrap: true, breakWords: true, wordWrapWidth: boxWidth - TEXT_PADDING * 2 },
    });
    this.speakerText.x = BOX_MARGIN + TEXT_PADDING;
    this.speakerText.y = boxY + 12;
    this.container.addChild(this.speakerText);

    this.bodyText = new Text({
      text: '',
      style: {
        fontSize: 15,
        fill: UITheme.colors.body,
        fontFamily: UITheme.fonts.ui,
        wordWrap: true, breakWords: true,
        wordWrapWidth: boxWidth - TEXT_PADDING * 2,
        lineHeight: 22,
      },
    });
    this.bodyText.x = BOX_MARGIN + TEXT_PADDING;
    this.bodyText.y = boxY + 36;
    this.container.addChild(this.bodyText);

    const textMask = new Graphics();
    textMask.rect(BOX_MARGIN + TEXT_PADDING, boxY + 36, boxWidth - TEXT_PADDING * 2, BOX_HEIGHT - 48);
    textMask.fill({ color: 0xffffff });
    this.container.addChild(textMask);
    this.bodyText.mask = textMask;

    this.renderer.uiLayer.addChild(this.container);
    fadeIn(this.container);

    window.addEventListener('pointerdown', this.onClickBound);
    window.addEventListener('keydown', this.onKeyBound);
  }

  private showLine(line: DialogueLine): void {
    this.ensureContainer();
    this.clearChoices();
    /** 新一句必须清掉上一句的「点按结束」标记，否则连续多段 playScriptedDialogue 时首句会误走 advanceEnd 直接关对话 */
    this.willEndAfterAdvance = false;

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
    this.waitingForAdvance = false;
    this.currentChoices = choices;

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
      bg.roundRect(0, 0, boxWidth, 32, UITheme.panel.borderRadiusSmall);
      bg.fill({ color: UITheme.colors.rowBgDark, alpha: UITheme.alpha.rowHover });
      bg.roundRect(0, 0, boxWidth, 32, UITheme.panel.borderRadiusSmall);
      bg.stroke({ color: choice.enabled ? UITheme.colors.borderActive : UITheme.colors.borderSubtle, width: 1 });
      row.addChild(bg);

      const prefix = choice.ruleHintId ? `${this.strings.get('dialogue', 'ruleTag')} ${i + 1}. ` : `${i + 1}. `;
      const fillColor = choice.ruleHintId
        ? (choice.enabled ? UITheme.colors.choiceRule : UITheme.colors.choiceRuleDisabled)
        : (choice.enabled ? UITheme.colors.choiceEnabled : UITheme.colors.choiceDisabled);
      const text = new Text({
        text: `${prefix}${choice.text}`,
        style: {
          fontSize: 14,
          fill: fillColor,
          fontFamily: UITheme.fonts.ui,
          wordWrap: true, breakWords: true,
          wordWrapWidth: boxWidth - 80,
        },
      });
      text.x = 14;
      text.y = 7;
      row.addChild(text);

      row.eventMode = 'static';
      if (choice.enabled) {
        row.cursor = 'pointer';

        const hoverBg = new Graphics();
        hoverBg.roundRect(0, 0, boxWidth, 32, UITheme.panel.borderRadiusSmall);
        hoverBg.fill({ color: UITheme.colors.rowHover, alpha: UITheme.alpha.rowHover });
        hoverBg.visible = false;
        row.addChildAt(hoverBg, 0);

        row.on('pointerover', () => { hoverBg.visible = true; bg.visible = false; });
        row.on('pointerout', () => { hoverBg.visible = false; bg.visible = true; });
        row.on('pointerdown', () => {
          this.waitingForChoice = false;
          this.eventBus.emit('dialogue:choiceSelected', { index: choice.index });
        });
      } else {
        row.cursor = 'default';
        row.on('pointerdown', () => {
          if (choice.disableHint) {
            this.eventBus.emit('notification:show', { text: choice.disableHint, type: 'warning' });
          }
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
    this.currentChoices = [];
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

  private onClick(_e: PointerEvent): void {
    this.handleAdvance();
  }

  private onKey(e: KeyboardEvent): void {
    if (e.code === 'Space' || e.code === 'Enter') {
      this.handleAdvance();
    }
    if (this.waitingForChoice && e.code >= 'Digit1' && e.code <= 'Digit9') {
      const idx = parseInt(e.code.replace('Digit', ''), 10) - 1;
      const choice = this.currentChoices[idx];
      if (!choice) return;
      if (choice.enabled) {
        this.eventBus.emit('dialogue:choiceSelected', { index: choice.index });
        this.waitingForChoice = false;
      } else if (choice.disableHint) {
        this.eventBus.emit('notification:show', { text: choice.disableHint, type: 'warning' });
      }
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

    window.removeEventListener('pointerdown', this.onClickBound);
    window.removeEventListener('keydown', this.onKeyBound);
  }

  destroy(): void {
    this.hide();
    this.eventBus.off('dialogue:line', this.dialogueLineCb);
    this.eventBus.off('dialogue:choices', this.dialogueChoicesCb);
    this.eventBus.off('dialogue:willEnd', this.dialogueWillEndCb);
    this.eventBus.off('dialogue:end', this.dialogueEndCb);
    this.eventBus.off('dialogue:prepareBeat', this.dialoguePrepareBeatCb);
    this.eventBus.off('dialogue:hidePanel', this.dialogueHidePanelCb);
  }
}
