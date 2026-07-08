import { Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import { UITheme, fadeIn } from './UITheme';
import { drawPanelBase, SKINS } from './PanelSkin';
import { isEventOnGameCanvas, isPointerConsumed, markPointerConsumed } from './uiPointerCoords';
import type { Renderer } from '../rendering/Renderer';
import type { EventBus } from '../core/EventBus';
import type { StringsProvider } from '../core/StringsProvider';
import type { AssetManager } from '../core/AssetManager';
import type { DialogueLine, DialogueChoice, DialoguePortraitRef } from '../data/types';

const BOX_HEIGHT = 140;
const BOX_MARGIN = 20;
const TEXT_PADDING = 20;
const TYPEWRITER_SPEED = 30;

/** VN 式半身像：方形立绘显示边长；出现时正文/名牌/选项向右让出的横向宽度。
 * 立绘压在面板前景、底边伸出画面底边之外（裁切边永不可见）；脸部允许覆在面板上（前景不遮挡）。 */
const PORTRAIT_SIZE = 240;
const PORTRAIT_INSET = 248;

/** 头像文件路径（编辑器可视化选择器写入 slug/emotion，运行时直接拼路径加载）。 */
function portraitPath(ref: DialoguePortraitRef): string {
  return `resources/runtime/images/dialogue_portraits/${ref.slug}/${ref.slug}_${ref.emotion}.png`;
}


export class DialogueUI {
  private renderer: Renderer;
  private eventBus: EventBus;
  private strings: StringsProvider;
  private assetManager: AssetManager;
  private container: Container | null = null;

  private speakerText: Text | null = null;
  private speakerPlate: Graphics | null = null;
  private bodyText: Text | null = null;
  private bodyMask: Graphics | null = null;
  private choicesContainer: Container | null = null;
  private continueArrow: Graphics | null = null;
  private arrowTimer: number = 0;

  private portraitSprite: Sprite | null = null;
  private sceneDim: Graphics | null = null;
  /** 每次换行自增；异步头像加载完成时比对，防止快速翻页把上一句的脸贴到当前行 */
  private portraitToken: number = 0;
  /** 当前行是否让出头像横向空间（有头像=PORTRAIT_INSET，无=0） */
  private currentInset: number = 0;

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

  constructor(renderer: Renderer, eventBus: EventBus, strings: StringsProvider, assetManager: AssetManager) {
    this.renderer = renderer;
    this.eventBus = eventBus;
    this.strings = strings;
    this.assetManager = assetManager;

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
    this.layoutSpeaker();
    if (this.continueArrow) this.continueArrow.visible = false;
    this.bodyText.text = '';
    this.fullText = '';
    this.displayedChars = 0;
    this.typewriterTimer = 0;
    this.isShowingFullText = false;
    this.waitingForAdvance = false;
    this.waitingForChoice = false;
  }

  /** 按当前说话人名字给名牌定尺寸/定位；无说话人（旁白）时隐藏名牌。名牌随头像 inset 右移。 */
  private layoutSpeaker(): void {
    if (!this.speakerPlate || !this.speakerText) return;
    const boxY = this.renderer.screenHeight - BOX_HEIGHT - BOX_MARGIN;
    this.speakerPlate.clear();
    if (!this.speakerText.text) {
      this.speakerPlate.visible = false;
      this.speakerText.visible = false;
      return;
    }
    this.speakerPlate.visible = true;
    this.speakerText.visible = true;
    const plateX = BOX_MARGIN + 12 + this.currentInset;
    const plateY = boxY + 8;
    const plateH = 26;
    const maxW = this.renderer.screenWidth - BOX_MARGIN * 2 - 24 - this.currentInset;
    const plateW = Math.min(this.speakerText.width + 24, maxW);
    drawPanelBase(this.speakerPlate, plateX, plateY, plateW, plateH, SKINS.panelAlt);
    this.speakerText.x = plateX + 12;
    this.speakerText.y = plateY + 5;
  }

  /** 正文区（正文位置/换行宽度/裁剪遮罩）随头像 inset 重排。 */
  private relayout(): void {
    if (!this.container || !this.bodyText || !this.bodyMask) return;
    const boxWidth = this.renderer.screenWidth - BOX_MARGIN * 2;
    const boxY = this.renderer.screenHeight - BOX_HEIGHT - BOX_MARGIN;
    const left = BOX_MARGIN + TEXT_PADDING + this.currentInset;
    const wrapW = Math.max(80, boxWidth - TEXT_PADDING * 2 - this.currentInset);
    this.bodyText.x = left;
    this.bodyText.y = boxY + 46;
    this.bodyText.style.wordWrapWidth = wrapW;
    this.bodyMask.clear();
    this.bodyMask.rect(left, boxY + 44, wrapW, BOX_HEIGHT - 58);
    this.bodyMask.fill({ color: 0xffffff });
  }

  /**
   * 显示/切换当前行头像（VN 式半身像，压在框顶边、向上延伸）。
   * 同步命中缓存立即贴图；未命中先让出空间并异步加载，用 token 防翻页贴错脸；无头像则收起并归零 inset。
   */
  private showPortrait(ref?: DialoguePortraitRef): void {
    const token = ++this.portraitToken;
    if (!ref || !ref.slug || !ref.emotion) {
      this.currentInset = 0;
      if (this.portraitSprite) this.portraitSprite.visible = false;
      return;
    }
    this.currentInset = PORTRAIT_INSET;
    const path = portraitPath(ref);
    const cached = this.assetManager.getTexture(path);
    if (cached && cached !== Texture.EMPTY) {
      this.applyPortrait(cached);
      return;
    }
    // 未命中：先收起（避免露上一张），异步加载后若仍是本行再贴
    if (this.portraitSprite) this.portraitSprite.visible = false;
    void this.assetManager
      .loadTexture(path)
      .then((tex) => {
        if (token !== this.portraitToken || !this.container) return;
        this.applyPortrait(tex);
      })
      .catch(() => { /* 缺图：保持收起，正文空间已让出 */ });
  }

  private applyPortrait(tex: Texture): void {
    if (!this.portraitSprite || !this.container) return;
    const s = this.portraitSprite;
    s.texture = tex;
    s.anchor.set(0.5, 1);
    s.width = PORTRAIT_SIZE;
    s.height = PORTRAIT_SIZE;
    s.x = BOX_MARGIN + PORTRAIT_SIZE / 2; // 与面板左缘对齐站位
    s.y = this.renderer.screenHeight + 4; // 底边伸出画面底边之外：人物立足屏底，裁切边永不可见
    s.visible = true;
  }

  private ensureContainer(): void {
    if (this.container) return;

    this.container = new Container();

    const boxWidth = this.renderer.screenWidth - BOX_MARGIN * 2;
    const boxY = this.renderer.screenHeight - BOX_HEIGHT - BOX_MARGIN;

    // 压暗背景（可选项）：startDialogueGraph 动作带 dimBackground=true 的对话才压，默认不压
    this.sceneDim = new Graphics();
    this.sceneDim.rect(0, 0, this.renderer.screenWidth, this.renderer.screenHeight);
    this.sceneDim.fill({ color: 0x000000, alpha: 0.25 });
    this.sceneDim.eventMode = 'none';
    this.sceneDim.visible = false;
    this.container.addChild(this.sceneDim);

    const bg = new Graphics();
    drawPanelBase(bg, BOX_MARGIN, boxY, boxWidth, BOX_HEIGHT, SKINS.dialogue);
    this.container.addChild(bg);

    // 立绘层压在面板之上（前景）：底边伸出画面底边之外，人物从屏底「长」出来——
    // 脸部任何表情都完整可见、绝不被对话框遮挡；文字经 PORTRAIT_INSET 让位不与立绘相压。
    this.portraitSprite = new Sprite();
    this.portraitSprite.eventMode = 'none';
    this.portraitSprite.visible = false;
    this.container.addChild(this.portraitSprite);

    // 说话人名牌：左上角一个独立小牌，区别于正文，一眼是「对话框」而非普通面板（尺寸随名字在 layoutSpeaker 里定）
    this.speakerPlate = new Graphics();
    this.container.addChild(this.speakerPlate);

    this.speakerText = new Text({
      text: '',
      style: { fontSize: 15, fill: UITheme.colors.title, fontFamily: UITheme.fonts.ui, fontWeight: 'bold' },
    });
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
    this.bodyText.y = boxY + 46;
    this.container.addChild(this.bodyText);

    this.bodyMask = new Graphics();
    this.bodyMask.rect(BOX_MARGIN + TEXT_PADDING, boxY + 44, boxWidth - TEXT_PADDING * 2, BOX_HEIGHT - 58);
    this.bodyMask.fill({ color: 0xffffff });
    this.container.addChild(this.bodyMask);
    this.bodyText.mask = this.bodyMask;

    // 「继续」小三角：台词显示完、等待推进时在右下角脉动提示（功能性提示，非装饰）
    this.continueArrow = new Graphics();
    const ax = BOX_MARGIN + boxWidth - 34;
    const ay = boxY + BOX_HEIGHT - 26;
    this.continueArrow.poly([ax, ay, ax + 15, ay, ax + 7.5, ay + 10]).fill({ color: UITheme.colors.gold });
    this.continueArrow.visible = false;
    this.container.addChild(this.continueArrow);

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
    if (this.sceneDim) this.sceneDim.visible = line.dim === true;
    this.showPortrait(line.portrait);
    this.layoutSpeaker();
    this.relayout();
    this.fullText = line.text;
    this.displayedChars = 0;
    this.typewriterTimer = 0;
    this.isShowingFullText = false;
    this.waitingForAdvance = false;
    this.waitingForChoice = false;
    this.bodyText!.text = '';

    // 空文本台词打字机循环走不到完成分支，视为已显示完整、直接进入待推进态，避免卡死
    if (this.fullText.length === 0) {
      this.isShowingFullText = true;
      this.waitingForAdvance = true;
    }
  }

  private showChoices(choices: DialogueChoice[]): void {
    this.ensureContainer();
    this.clearChoices();
    this.waitingForChoice = true;
    this.waitingForAdvance = false;
    this.currentChoices = choices;

    const boxWidth = this.renderer.screenWidth - BOX_MARGIN * 2;
    const boxY = this.renderer.screenHeight - BOX_HEIGHT - BOX_MARGIN;
    const rowWidth = boxWidth - this.currentInset;

    this.choicesContainer = new Container();
    this.choicesContainer.x = BOX_MARGIN + this.currentInset;
    this.choicesContainer.y = boxY - choices.length * 36 - 10;

    for (let i = 0; i < choices.length; i++) {
      const choice = choices[i];
      const row = new Container();
      row.y = i * 36;

      const bg = new Graphics();
      drawPanelBase(bg, 0, 0, rowWidth, 32, SKINS.row, {
        border: choice.enabled ? UITheme.colors.borderActive : UITheme.colors.borderSubtle,
      });
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
          wordWrapWidth: rowWidth - 40,
        },
      });
      text.x = 14;
      text.y = 7;
      row.addChild(text);

      row.eventMode = 'static';
      if (choice.enabled) {
        row.cursor = 'pointer';

        const hoverBg = new Graphics();
        hoverBg.roundRect(0, 0, rowWidth, 32, UITheme.panel.borderRadiusSmall);
        hoverBg.fill({ color: UITheme.colors.rowHover, alpha: UITheme.alpha.rowHover });
        hoverBg.visible = false;
        row.addChildAt(hoverBg, 0);

        row.on('pointerover', () => {
          hoverBg.visible = true;
          bg.visible = false;
          this.eventBus.emit('ui:hover', {});
        });
        row.on('pointerout', () => { hoverBg.visible = false; bg.visible = true; });
        row.on('pointerdown', (ev) => {
          markPointerConsumed(ev.nativeEvent);
          this.waitingForChoice = false;
          this.eventBus.emit('dialogue:choiceSelected', { index: choice.index });
        });
      } else {
        row.cursor = 'default';
        row.on('pointerdown', (ev) => {
          markPointerConsumed(ev.nativeEvent);
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
    if (!this.container) return;

    // 「继续」小三角：台词显示完、等待推进（非选项）时显示并脉动
    if (this.continueArrow) {
      const showArrow = this.waitingForAdvance && !this.waitingForChoice;
      this.continueArrow.visible = showArrow;
      if (showArrow) {
        this.arrowTimer += dt;
        this.continueArrow.alpha = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(this.arrowTimer * 4));
      } else {
        this.arrowTimer = 0;
      }
    }

    if (this.isShowingFullText || this.waitingForAdvance || this.waitingForChoice) return;

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

  private onClick(e: PointerEvent): void {
    if (!isEventOnGameCanvas(this.renderer, e)) return;
    if (isPointerConsumed(e)) return;
    this.handleAdvance();
  }

  private onKey(e: KeyboardEvent): void {
    if (e.repeat) return;
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
      this.eventBus.emit('dialogue:advanceInput', {});
      this.displayedChars = this.fullText.length;
      this.bodyText!.text = this.fullText;
      this.isShowingFullText = true;
      this.waitingForAdvance = true;
      return;
    }

    if (this.waitingForAdvance) {
      this.eventBus.emit('dialogue:advanceInput', {});
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
    this.portraitToken++; // 使任何在途头像加载作废
    if (this.container) {
      if (this.container.parent) {
        this.container.parent.removeChild(this.container);
      }
      this.container.destroy({ children: true });
      this.container = null;
      this.speakerText = null;
      this.speakerPlate = null;
      this.bodyText = null;
      this.bodyMask = null;
      this.portraitSprite = null;
      this.sceneDim = null;
      this.continueArrow = null;
    }
    this.currentInset = 0;
    this.arrowTimer = 0;
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
