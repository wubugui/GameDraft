import { Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import { UITheme, fadeIn } from './UITheme';
import { createPanel, SKINS } from './PanelSkin';
import { ContinueIndicator } from './components/ContinueIndicator';
import { drawSelectedRow } from './components/UIDecor';
import { UIFocus, type FocusItem } from './components/UIFocus';
import { isEventOnGameCanvas, isPointerConsumed, markPointerConsumed } from './uiPointerCoords';
import type { Renderer } from '../rendering/Renderer';
import type { EventBus } from '../core/EventBus';
import type { StringsProvider } from '../core/StringsProvider';
import type { AssetManager } from '../core/AssetManager';
import type { DialogueLine, DialogueChoice, DialoguePortraitRef } from '../data/types';
import { DEFAULT_SPEAKER_SIDE, resolveSpeakerSide, type SpeakerSide } from '../utils/dialogueSpeakerSide';
import { createStyledText, setStyledReveal, setStyledText } from '../core/styledText';
import { plainTextLength } from '../core/textStyle';

const BOX_MARGIN = UITheme.spacing.xl;
/** 正文左右内缩：木框本身占 15px，缩进必须明显越过木条才有设计稿那种阔气的留白 */
const TEXT_PADDING = UITheme.spacing.xxl;
const TYPEWRITER_SPEED = 30;

/** 压暗强度：远轻于 UITheme.alpha.overlay（0.5，弹窗遮罩）——对白期间场景仍要看得清 */
const DIM_ALPHA = 0.25;

/**
 * 说话人名牌：**骑在对话框上沿**的一块独立小木牌（设计稿 03/07 的定稿形态）——
 * 牌子上半截凸出到框顶之上，下半截压在木条上，左端靠框左内缩一档。
 * 名牌不再是「框内部的一个小色块」，那样一眼看去只是块深色补丁、读不出木牌。
 */
const PLATE_HEIGHT = 56;
/** 牌子凸出到框顶边之上的高度（余下 38-24=14 压在 15px 的木条上，正好齐木条内沿） */
const PLATE_RISE = 34;
const PLATE_PAD_X = UITheme.spacing.lg;
/** 名牌左端相对框左边的内缩 */
const PLATE_INSET_X = UITheme.spacing.xl;

/** 正文首行顶：名牌已骑到框外，正文只需让开 15px 木条 + 一档呼吸；遮罩比首行高 2px 免削字顶 */
const BODY_TOP = 28;
const BODY_MASK_TOP = BODY_TOP - 2;
const BODY_MASK_BOTTOM_INSET = UITheme.spacing.xl;
/** 正文行距 = 1.6 × 字号（原来 44 配 30 号 = 1.47，中文宋体在这一档偏紧）。 */
const BODY_LINE_HEIGHT = 40;
/**
 * 正文容量（行）。**取「最坏行数 + 1」**：现存最长台词 61 字，带立绘时每行实测 26 字
 * （无立绘 36 字）→ 最坏 3 行，故留 4 行、恰好一行余量。
 *
 * ⚠ 收到 3（框高 166）整条底栏会明显更轻、单行旁白也不再空一大片——但那样容量就是
 * 「带立绘 78 字」且**零余量**，写超了台词被遮罩静默吃掉。要不要拿这条余量换观感，
 * 是内容侧的取舍，别在排版层单方面定。
 */
const BODY_MAX_LINES = 4;
/**
 * 对话框高度。**不是随手定的数**：它就是上面那条容量的算术结果——
 * 遮罩顶 + 容量行数 × 行距 + 下留白。原来 230 是按 30 号字 / 44 行距凑的同一个 4 行容量；
 * 正文降到 bodyLarge 之后按同式重算得 206，整条底栏少占 24px（30% 屏高 → 27%）。
 * ⚠ 改正文字号或行距必须让这条式子重新成立，否则第 4 行被遮罩吃掉、台词静默丢字。
 * ⚠ CutsceneRenderer 的过场对白框刻意复刻同一套几何，改这里要同步那边。
 */
const BOX_HEIGHT = BODY_MASK_TOP + BODY_LINE_HEIGHT * BODY_MAX_LINES + BODY_MASK_BOTTOM_INSET;

const ARROW_INSET_X = 44;
const ARROW_INSET_Y = 30;

/**
 * 选项：设计稿里是一摞近方正的木边按钮，浮在对话框上方、文字居中；
 * 不是贴着框宽铺满的列表行。行高按文字实测（长选项会折行），故只给下限。
 */
const CHOICE_MAX_W = 620;
/** 行高下限：bodyLarge 一行字实测 ~31px，58 上下各留 13px，扣掉 5px 木条仍有 8px 净空 */
const CHOICE_ROW_MIN_H = 58;
const CHOICE_GAP = UITheme.spacing.md;
const CHOICE_PAD_X = UITheme.spacing.xl;
const CHOICE_PAD_Y = UITheme.spacing.md;
/** 序号列与正文之间的最小净空（正文按「列宽 + 这一档」左右对称收边，短选项也不会贴上序号） */
const CHOICE_PREFIX_GAP = UITheme.spacing.md;
/** 选项按钮的木条厚度（= SKINS.nameplate 的 wood）：选中琥珀铺光按此内缩，正好落在木框里侧 */
const CHOICE_FRAME = 5;

/** VN 式半身像：方形立绘显示边长；出现时正文/名牌/选项向右让出的横向宽度。
 * 立绘压在面板前景、底边伸出画面底边之外（裁切边永不可见）；脸部允许覆在面板上（前景不遮挡）。 */
const PORTRAIT_SIZE = 360;
const PORTRAIT_INSET = 248;
/** 立绘底边伸出画面底边的量 */
const PORTRAIT_BOTTOM_OVERHANG = 4;
/** 立绘整体上移量（y 方向）。调这一个数就能上下挪立绘。 */
const PORTRAIT_LIFT = 0;

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
  /** 名牌宿主层：木框是 Sprite，塞不进 Graphics，故每次重排都整层重建（每句一次，量级可忽略） */
  private speakerPlate: Container | null = null;
  /** 对话框宿主层：同上，`createPanel` 返回容器（纸纹底 + 木框 + 内金线 + 暗角） */
  private boxBg: Container | null = null;
  private bodyText: Text | null = null;
  private bodyMask: Graphics | null = null;
  private choicesContainer: Container | null = null;
  /** 「继续」点捺：等待推进时浮现并轻微上下浮动（全站共用件） */
  private continueMark: ContinueIndicator | null = null;
  /** 画布尺寸变化订阅（侧栏挤压/真 resize）；随容器一同装卸 */
  private unsubResize: (() => void) | null = null;

  private portraitSprite: Sprite | null = null;
  private sceneDim: Graphics | null = null;
  /** 每次换行自增；异步头像加载完成时比对，防止快速翻页把上一句的脸贴到当前行 */
  private portraitToken: number = 0;
  /** 当前行是否让出头像横向空间（有头像=PORTRAIT_INSET，无=0） */
  private currentInset: number = 0;
  /** 当前行立绘/名牌所在边（主角在右、其余在左；见 utils/dialogueSpeakerSide） */
  private currentSide: SpeakerSide = DEFAULT_SPEAKER_SIDE;
  /**
   * 当前行是不是主角说的。与 currentSide 刻意分开：side 可被数据覆盖（两个 NPC 各占一边），
   * 而「这是你说的」这个标记只认说话实体，不能被站位带偏。
   */
  private currentIsSelf: boolean = false;

  /** 当前行的**带标记原串**（`[c:…]` 未展开）；打字机进度按可见字数走 fullTextVisible */
  private fullText: string = '';
  /** fullText 的可见字数（= 剥掉样式标记后的长度） */
  private fullTextVisible: number = 0;
  private displayedChars: number = 0;
  private typewriterTimer: number = 0;
  private isShowingFullText: boolean = false;
  private waitingForAdvance: boolean = false;
  private waitingForChoice: boolean = false;
  private willEndAfterAdvance: boolean = false;
  private currentChoices: DialogueChoice[] = [];
  /**
   * 选项的键盘/手柄焦点。**只在有选项时装着东西**：没有选项时 `setItems([])`，
   * 于是 `handleKey` 一律返回 false，Space/Enter 照旧落到打字机推进上（既有交互不动）。
   */
  private choiceFocus = new UIFocus();

  private onClickBound: (e: PointerEvent) => void;
  private onKeyBound: (e: KeyboardEvent) => void;
  private dialogueLineCb: (line: DialogueLine) => void;
  private dialogueChoicesCb: (choices: DialogueChoice[]) => void;
  private dialogueWillEndCb: () => void;
  private dialogueEndCb: () => void;
  private dialoguePrepareBeatCb: () => void;
  private dialogueHidePanelCb: () => void;

  /** 对白框此刻是否在屏上（屏底那一条被占着）。供屏底提示语让位，避免横穿它的木框。 */
  get isVisible(): boolean {
    return this.container !== null;
  }

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
    setStyledText(this.speakerText, '');
    this.layoutSpeaker();
    this.continueMark?.setVisible(false);
    this.bodyText.text = '';
    this.fullText = '';
    this.fullTextVisible = 0;
    this.displayedChars = 0;
    this.typewriterTimer = 0;
    this.isShowingFullText = false;
    this.waitingForAdvance = false;
    this.waitingForChoice = false;
  }

  /** 立绘让出的横向空间：只压在立绘所在的那一侧，另一侧为 0。 */
  private insetLeft(): number {
    return this.currentSide === 'left' ? this.currentInset : 0;
  }

  /** 清空宿主层（木框/纸纹这类由 createPanel 造出来的整包节点），供原地重建。 */
  private static resetLayer(layer: Container): void {
    for (const child of layer.removeChildren()) child.destroy({ children: true });
  }

  /**
   * 按当前说话人名字给名牌定尺寸/定位；无说话人（旁白）时隐藏名牌。
   * 名牌**恒定贴左**（只让开左侧立绘的 inset）——跟着说话人左右跳会让底栏读起来发飘；
   * 「这句是你说的」由名牌配色 + 立绘站位表达，位置保持稳定的阅读锚点。
   */
  private layoutSpeaker(): void {
    if (!this.speakerPlate || !this.speakerText) return;
    const boxY = this.renderer.screenHeight - BOX_HEIGHT - BOX_MARGIN;
    DialogueUI.resetLayer(this.speakerPlate);
    if (!this.speakerText.text) {
      this.speakerPlate.visible = false;
      this.speakerText.visible = false;
      return;
    }
    this.speakerPlate.visible = true;
    this.speakerText.visible = true;
    // 骑边：牌子上沿抬到框顶之上 PLATE_RISE，下沿压在木条里侧
    const plateY = boxY - PLATE_RISE;
    const maxW = this.renderer.screenWidth - BOX_MARGIN * 2 - PLATE_INSET_X * 2 - this.currentInset;
    const plateW = Math.min(this.speakerText.width + PLATE_PAD_X * 2, maxW);
    const plateX = BOX_MARGIN + PLATE_INSET_X + this.insetLeft();
    // 主角行：名牌与名字色一起提亮，与右侧站位互为冗余（无立绘时分边信号太弱）
    this.speakerPlate.addChild(createPanel(
      plateX, plateY, plateW, PLATE_HEIGHT,
      this.currentIsSelf ? SKINS.speakerSelf : SKINS.nameplate,
    ));
    this.speakerText.style.fill = this.currentIsSelf
      ? UITheme.colors.speakerSelf
      : UITheme.colors.title;
    this.speakerText.x = plateX + PLATE_PAD_X;
    this.speakerText.y = plateY + Math.round((PLATE_HEIGHT - this.speakerText.height) / 2);
  }

  /** 正文区（正文位置/换行宽度/裁剪遮罩）随头像 inset 重排；立绘在右时正文不左移、只收窄。 */
  private relayout(): void {
    if (!this.container || !this.bodyText || !this.bodyMask) return;
    const boxWidth = this.renderer.screenWidth - BOX_MARGIN * 2;
    const boxY = this.renderer.screenHeight - BOX_HEIGHT - BOX_MARGIN;
    const left = BOX_MARGIN + TEXT_PADDING + this.insetLeft();
    const wrapW = Math.max(80, boxWidth - TEXT_PADDING * 2 - this.currentInset);
    this.bodyText.x = left;
    this.bodyText.y = boxY + BODY_TOP;
    this.bodyText.style.wordWrapWidth = wrapW;
    this.bodyMask.clear();
    this.bodyMask.rect(
      left, boxY + BODY_MASK_TOP, wrapW,
      BOX_HEIGHT - BODY_MASK_TOP - BODY_MASK_BOTTOM_INSET,
    );
    this.bodyMask.fill({ color: 0xffffff });
  }

  /**
   * 随画面尺寸重画整框（压暗层 / 面板底 / 「继续」三角）。
   * 这三样此前在 ensureContainer 里按当时的屏幕尺寸画死，改窗口/开合 F2 侧栏后对话框会歪。
   */
  private layoutFrame(): void {
    if (!this.sceneDim || !this.boxBg || !this.continueMark) return;
    const sw = this.renderer.screenWidth;
    const sh = this.renderer.screenHeight;
    const boxWidth = sw - BOX_MARGIN * 2;
    const boxY = sh - BOX_HEIGHT - BOX_MARGIN;

    this.sceneDim.clear();
    this.sceneDim.rect(0, 0, sw, sh);
    this.sceneDim.fill({ color: UITheme.colors.overlay, alpha: DIM_ALPHA });

    // 木框 + 内金线 + 暗角是 Sprite/渐变，画不进 Graphics：整层重建
    DialogueUI.resetLayer(this.boxBg);
    this.boxBg.addChild(createPanel(BOX_MARGIN, boxY, boxWidth, BOX_HEIGHT, SKINS.dialogue));

    // 只重画几何：visible / alpha 由 update() 的脉动逻辑持有，clear() 不动它们
    // 「继续」点捺**居中**，不靠右下角：立绘左右两边都可能站人（resolveSpeakerSide 决定），
    // 钉在右下角必然被右侧立绘压住（真机实拍过：点捺正好落在人物胸口）。
    // 居中是唯一两侧都不撞的位置。
    const ax = BOX_MARGIN + boxWidth / 2;
    const ay = boxY + BOX_HEIGHT - ARROW_INSET_Y;
    this.continueMark.setPosition(ax, ay);
  }

  /**
   * 立绘站位：与面板同侧缘对齐（主角在右、其余在左），底边伸出画面底边之外。
   * ⚠ 构图参数（240px、锚点 (0.5,1)、出画 4px）是定稿值，勿"顺手优化"。
   */
  private positionPortrait(): void {
    const s = this.portraitSprite;
    if (!s) return;
    s.x = this.currentSide === 'right'
      ? this.renderer.screenWidth - BOX_MARGIN - PORTRAIT_SIZE / 2
      : BOX_MARGIN + PORTRAIT_SIZE / 2;
    s.y = this.renderer.screenHeight + PORTRAIT_BOTTOM_OVERHANG - PORTRAIT_LIFT;
  }

  /** 画布尺寸变化：整框 + 名牌 + 正文 + 立绘 + 选项全部按新尺寸重排。 */
  private onResize(): void {
    if (!this.container) return;
    this.layoutFrame();
    this.layoutSpeaker();
    this.relayout();
    this.positionPortrait();
    // 选项行宽度/纵向起点都按旧屏宽算死，必须重建；重建只动视图，不碰推进状态
    if (this.choicesContainer) {
      const choices = this.currentChoices;
      // 焦点不许因为一次 resize 就甩回第一条：按 id 复位（id 没了才退回默认）
      const keepFocusId = this.choiceFocus.current?.id ?? null;
      this.clearChoices();
      this.buildChoices(choices, keepFocusId);
    }
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
    this.positionPortrait();
    s.visible = true;
  }

  private ensureContainer(): void {
    if (this.container) return;

    this.container = new Container();

    const boxWidth = this.renderer.screenWidth - BOX_MARGIN * 2;
    const boxY = this.renderer.screenHeight - BOX_HEIGHT - BOX_MARGIN;

    // 压暗背景（可选项）：startDialogueGraph 动作带 dimBackground=true 的对话才压，默认不压
    this.sceneDim = new Graphics();
    this.sceneDim.eventMode = 'none';
    this.sceneDim.visible = false;
    this.container.addChild(this.sceneDim);

    this.boxBg = new Container();
    this.container.addChild(this.boxBg);

    // 立绘层压在面板**之上**（前景）：人物从屏底「长」出来、底边出画所以永远没有裁切边。
    // ⚠ 别再试着把它挪到框下面——那样身子会被框整个吃掉，只剩一颗头浮在框上。
    this.portraitSprite = new Sprite();
    this.portraitSprite.eventMode = 'none';
    this.portraitSprite.visible = false;
    this.container.addChild(this.portraitSprite);

    // 说话人名牌：骑在框上沿的一块独立小木牌（尺寸随名字在 layoutSpeaker 里定）
    this.speakerPlate = new Container();
    this.container.addChild(this.speakerPlate);

    this.speakerText = createStyledText({
      text: '',
      style: {
        fontSize: UITheme.fontSize.title,
        fill: UITheme.colors.title,
        fontFamily: UITheme.fonts.display,
        fontWeight: 'bold',
        letterSpacing: UITheme.letterSpacing.title,
      },
    });
    this.container.addChild(this.speakerText);

    this.bodyText = createStyledText({
      text: '',
      style: {
        // 台词是全游戏读得最久的一段字，但**说话人名同为 title 时整框没有层次**：
        // 名字是一眼扫过的标签（还占着金牌 + 楷体 + 字距三重强调），台词才是要读几秒的正文。
        // 正文退到 bodyLarge、名字留在 title，一框之内主次才立得住；
        // 25 号在 1024 宽下每行 36 字，比 30 号的 30 字更接近成段阅读的舒适行长。
        fontSize: UITheme.fontSize.bodyLarge,
        fill: UITheme.colors.body,
        fontFamily: UITheme.fonts.ui,
        wordWrap: true, breakWords: true,
        wordWrapWidth: boxWidth - TEXT_PADDING * 2,
        lineHeight: BODY_LINE_HEIGHT,
      },
    });
    this.bodyText.x = BOX_MARGIN + TEXT_PADDING;
    this.bodyText.y = boxY + BODY_TOP;
    this.container.addChild(this.bodyText);

    this.bodyMask = new Graphics();
    this.container.addChild(this.bodyMask);
    this.bodyText.mask = this.bodyMask;

    // 「继续」小三角：台词显示完、等待推进时在右下角脉动提示（功能性提示，非装饰）
    this.continueMark = new ContinueIndicator();
    this.container.addChild(this.continueMark.container);

    // 压暗层 / 面板底 / 三角几何 / 正文遮罩统一由这两处按当前屏幕尺寸画出
    this.layoutFrame();
    this.relayout();

    this.renderer.uiLayer.addChild(this.container);
    fadeIn(this.container, UITheme.motion.normal);

    window.addEventListener('pointerdown', this.onClickBound);
    window.addEventListener('keydown', this.onKeyBound);
    // ⚠ 必须订 renderer.subscribeAfterResize：F2 侧栏挤压 #game-mount 走 ResizeObserver
    // 不发 window resize；真 resize 又被 Pixi 推到 rAF 之后，window 监听同步读到的是旧尺寸。
    this.unsubResize = this.renderer.subscribeAfterResize(() => this.onResize());
  }

  private showLine(line: DialogueLine): void {
    this.ensureContainer();
    this.clearChoices();
    /** 新一句必须清掉上一句的「点按结束」标记，否则连续多段 playScriptedDialogue 时首句会误走 advanceEnd 直接关对话 */
    this.willEndAfterAdvance = false;

    setStyledText(this.speakerText!, line.speaker);
    if (this.sceneDim) this.sceneDim.visible = line.dim === true;
    // 分边与「是不是你说的」必须先于立绘/名牌/正文布局定下——三者都读它
    this.currentSide = resolveSpeakerSide(line.speakerEntity, line.speakerSide);
    this.currentIsSelf = line.speakerEntity?.kind === 'player';
    this.showPortrait(line.portrait);
    this.layoutSpeaker();
    this.relayout();
    this.fullText = line.text;
    this.fullTextVisible = plainTextLength(this.fullText);
    this.displayedChars = 0;
    this.typewriterTimer = 0;
    this.isShowingFullText = false;
    this.waitingForAdvance = false;
    this.waitingForChoice = false;
    setStyledText(this.bodyText!, this.fullText, 0);

    // 空文本台词打字机循环走不到完成分支，视为已显示完整、直接进入待推进态，避免卡死
    if (this.fullTextVisible === 0) {
      this.isShowingFullText = true;
      this.waitingForAdvance = true;
    }
  }

  private showChoices(choices: DialogueChoice[]): void {
    this.ensureContainer();
    this.clearChoices();
    this.waitingForChoice = true;
    this.waitingForAdvance = false;
    this.buildChoices(choices);
  }

  /**
   * 只建选项视图（不动推进状态），供首次显示与 resize 重建共用。
   *
   * 版式对齐设计稿：一摞近方正的木边按钮、文字居中、浮在对话框上沿之上，
   * 在「让开立绘之后剩下的那段横向区间」里居中（立绘在右时整体偏左，正是稿子里的样子）。
   */
  private buildChoices(choices: DialogueChoice[], keepFocusId: string | null = null): void {
    this.currentChoices = choices;
    const focusItems: FocusItem[] = [];

    const boxWidth = this.renderer.screenWidth - BOX_MARGIN * 2;
    const boxY = this.renderer.screenHeight - BOX_HEIGHT - BOX_MARGIN;
    const availX = BOX_MARGIN + this.insetLeft();
    const availW = Math.max(120, boxWidth - this.currentInset);
    const rowWidth = Math.min(availW, CHOICE_MAX_W);

    this.choicesContainer = new Container();

    // 选项配色：规矩选项走琥珀（这是玩法信号，不靠字号表达），其余走常规正文色
    const fillOf = (c: DialogueChoice): number => (c.ruleHintId
      ? (c.enabled ? UITheme.colors.choiceRule : UITheme.colors.choiceRuleDisabled)
      : (c.enabled ? UITheme.colors.choiceEnabled : UITheme.colors.choiceDisabled));

    /**
     * 序号 / 规矩标记：**键位提示级的配角，不许与选项正文同号**。
     * 原来它们与正文拼在同一个 Text 里一起吃 title 30 号——「[规] 3.」四个字符
     * 和整句选项一样响，一摹选项扫过去先看见的是一列数字。这里拆成独立一小列：
     * 字号退到 small、左对齐钉在按钮内缩处，正文照旧居中。先整摹量一次取最宽者作列宽，
     * 各行按同一列对齐，短前缀不会把某一行的正文推歪。
     * （拆开之后也不再需要靠不换行空格防「2.」被折行甩单。）
     */
    const ruleTag = this.strings.get('dialogue', 'ruleTag');
    const prefixTexts = choices.map((c, i) => createStyledText({
      text: c.ruleHintId ? `${ruleTag}\u00a0${i + 1}.` : `${i + 1}.`,
      style: {
        fontSize: UITheme.fontSize.small,
        fill: fillOf(c),
        fontFamily: UITheme.fonts.ui,
      },
    }));
    const prefixCol = Math.ceil(Math.max(0, ...prefixTexts.map((t) => t.width)));
    // 正文左右**对称**收边（两侧都让出序号列）：居中的正文才不会压到左边那一列
    const textWrapW = Math.max(80, rowWidth - (CHOICE_PAD_X + prefixCol + CHOICE_PREFIX_GAP) * 2);

    let cursorY = 0;
    for (let i = 0; i < choices.length; i++) {
      const choice = choices[i];
      const row = new Container();
      row.y = cursorY;

      const fillColor = fillOf(choice);
      const prefixText = prefixTexts[i];
      const text = createStyledText({
        text: choice.text,
        style: {
          fontSize: UITheme.fontSize.bodyLarge,
          fill: fillColor,
          fontFamily: UITheme.fonts.ui,
          align: 'center',
          wordWrap: true, breakWords: true,
          wordWrapWidth: textWrapW,
        },
      });
      // 行高按实测文字定：长选项折行后按钮跟着长高，不会像定高行那样把字漏到框外
      const rowHeight = Math.max(CHOICE_ROW_MIN_H, Math.ceil(text.height) + CHOICE_PAD_Y * 2);

      const panel = createPanel(0, 0, rowWidth, rowHeight, SKINS.nameplate, {
        fill: choice.enabled ? UITheme.colors.rowBg : UITheme.colors.rowBgInactive,
      });
      row.addChild(panel);

      // 选中/悬停：整条点亮一档琥珀 + 金描边（drawSelectedRow），按木条厚度内缩，铺在木框里侧
      const selected = new Graphics();
      drawSelectedRow(selected, CHOICE_FRAME, CHOICE_FRAME, rowWidth - CHOICE_FRAME * 2, rowHeight - CHOICE_FRAME * 2);
      selected.visible = false;
      selected.eventMode = 'none';
      row.addChild(selected);

      text.x = Math.round((rowWidth - text.width) / 2);
      text.y = Math.round((rowHeight - text.height) / 2);
      row.addChild(text);

      // 序号列：钉在按钮左内缩处、与正文各自垂直居中（正文折行时它仍居中，不跟着跑到第一行）
      prefixText.x = CHOICE_PAD_X;
      prefixText.y = Math.round((rowHeight - prefixText.height) / 2);
      row.addChild(prefixText);

      /**
       * 选中态**只有这一处画法**（整条点亮琥珀 + 文字转金），鼠标悬停与键盘焦点共用它。
       * 焦点框不另发明一种：一条选项上出现两套选中语汇比没有导航更糟。
       */
      const setHighlight = (on: boolean): void => {
        selected.visible = on;
        const fill = on ? UITheme.colors.title : fillColor;
        text.style.fill = fill;
        prefixText.style.fill = fill;
      };

      row.eventMode = 'static';
      if (choice.enabled) {
        row.cursor = 'pointer';

        // 悬停即移焦（不直接画高亮）：鼠标和手柄共用同一个"当前项"。
        // 指针挪开后不再清高亮——屏幕上恒有一个可见的焦点，接着按方向键从这条继续走。
        row.on('pointerover', () => {
          this.choiceFocus.syncHover(`c${choice.index}`);
          this.eventBus.emit('ui:hover', {});
        });
        row.on('pointerdown', (ev) => {
          markPointerConsumed(ev.nativeEvent);
          this.waitingForChoice = false;
          this.eventBus.emit('dialogue:choiceSelected', { index: choice.index });
        });

        focusItems.push({
          id: `c${choice.index}`,
          x: 0, y: row.y, w: rowWidth, h: rowHeight,
          group: 'choices',
          onFocus: setHighlight,
          onActivate: () => {
            this.waitingForChoice = false;
            this.eventBus.emit('dialogue:choiceSelected', { index: choice.index });
          },
        });
      } else {
        // 禁用项登记成 disabled：方向键直接跳过它（`disableHint` 仍留给鼠标点）
        focusItems.push({
          id: `c${choice.index}`,
          x: 0, y: row.y, w: rowWidth, h: rowHeight,
          group: 'choices',
          disabled: true,
          onFocus: setHighlight,
        });
        row.cursor = 'default';
        row.on('pointerdown', (ev) => {
          markPointerConsumed(ev.nativeEvent);
          if (choice.disableHint) {
            this.eventBus.emit('notification:show', { text: choice.disableHint, type: 'warning' });
          }
        });
      }

      this.choicesContainer.addChild(row);
      cursorY += rowHeight + CHOICE_GAP;
    }

    const stackHeight = Math.max(0, cursorY - CHOICE_GAP);
    this.choicesContainer.x = Math.round(availX + (availW - rowWidth) / 2);
    // 底沿让开骑边名牌凸出的那一截，免得长名字的牌子顶到最后一个按钮
    this.choicesContainer.y = boxY - PLATE_RISE - UITheme.spacing.sm - stackHeight;

    this.container!.addChild(this.choicesContainer);

    /**
     * 登记焦点。`setItems` 会滤掉禁用项，所以「首个可选项」天然就是默认落点
     * （主机 UI 的惯例：默认焦点不放最上面那个不可用的，放玩家真正要按的那一项）。
     * resize 重建时用 `keepFocusId` 复位——`clearChoices` 已把旧表清空，
     * 这里必须显式 focusDefault，否则新建的那条不会被点亮。
     */
    this.choiceFocus.setItems(focusItems);
    const wanted = keepFocusId
      ?? focusItems.find((i) => !i.disabled)?.id
      ?? null;
    if (wanted) this.choiceFocus.focusDefault(wanted);
  }

  private clearChoices(): void {
    // 必须先断焦点：它的 onFocus 回调抓着下面就要销毁的那批行
    this.choiceFocus.setItems([]);
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

    // 「继续」点捺：台词打完、等待推进（且不在选项里）时才浮现
    if (this.continueMark) {
      this.continueMark.setVisible(this.waitingForAdvance && !this.waitingForChoice);
      this.continueMark.update(dt);
    }

    if (this.isShowingFullText || this.waitingForAdvance || this.waitingForChoice) return;

    if (this.displayedChars < this.fullTextVisible) {
      this.typewriterTimer += dt;
      const charsToShow = Math.floor(this.typewriterTimer * TYPEWRITER_SPEED);
      if (charsToShow > this.displayedChars) {
        this.displayedChars = Math.min(charsToShow, this.fullTextVisible);
        // 不能对 fullText 直接 substring：`[c:…]` 标记会被切碎（半个标记 = 满屏裸标记）
        setStyledReveal(this.bodyText!, this.displayedChars);
      }

      if (this.displayedChars >= this.fullTextVisible) {
        this.isShowingFullText = true;
        this.waitingForAdvance = true;
      }
    }
  }

  /** 自动视觉 golden 专用：只补完当前打字机，不向管理器发“下一句”推进。 */
  debugCompleteText(): void {
    if (!this.container || this.waitingForChoice || this.isShowingFullText) return;
    this.handleAdvance();
  }

  private onClick(e: PointerEvent): void {
    if (!isEventOnGameCanvas(this.renderer, e)) return;
    if (isPointerConsumed(e)) return;
    this.handleAdvance();
  }

  private onKey(e: KeyboardEvent): void {
    if (e.repeat) return;
    /**
     * 选项期先给焦点：方向键挪焦点、回车/空格选中当前项。
     * 没有选项时焦点表是空的，`handleKey` 一律 false，Space/Enter 照旧走推进（既有交互不动）；
     * 数字键 1~9 直选也仍留在下面，两条路并存。
     */
    if (this.waitingForChoice && this.choiceFocus.handleKey(e.code)) {
      e.preventDefault();
      return;
    }
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
      this.displayedChars = this.fullTextVisible;
      setStyledReveal(this.bodyText!, this.displayedChars);
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
      this.boxBg = null;
      this.bodyText = null;
      this.bodyMask = null;
      this.portraitSprite = null;
      this.sceneDim = null;
      this.continueMark = null;
    }
    this.currentInset = 0;
    this.fullText = '';
    this.fullTextVisible = 0;
    this.displayedChars = 0;
    this.isShowingFullText = false;
    this.waitingForAdvance = false;
    this.waitingForChoice = false;
    this.willEndAfterAdvance = false;

    window.removeEventListener('pointerdown', this.onClickBound);
    window.removeEventListener('keydown', this.onKeyBound);
    this.unsubResize?.();
    this.unsubResize = null;
  }

  destroy(): void {
    this.hide();
    this.choiceFocus.destroy();
    this.eventBus.off('dialogue:line', this.dialogueLineCb);
    this.eventBus.off('dialogue:choices', this.dialogueChoicesCb);
    this.eventBus.off('dialogue:willEnd', this.dialogueWillEndCb);
    this.eventBus.off('dialogue:end', this.dialogueEndCb);
    this.eventBus.off('dialogue:prepareBeat', this.dialoguePrepareBeatCb);
    this.eventBus.off('dialogue:hidePanel', this.dialogueHidePanelCb);
  }
}
