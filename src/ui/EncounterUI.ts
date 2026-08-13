import { Container, Graphics, Text } from 'pixi.js';
import { UITheme } from './UITheme';
import { createPanel, drawPanelBase, SKINS } from './PanelSkin';
import { ContinueIndicator, CONTINUE_MARK_SIZE } from './components/ContinueIndicator';
import { drawSelectedRow } from './components/UIDecor';
import { isEventOnGameCanvas, isPointerConsumed, markPointerConsumed } from './uiPointerCoords';
import { UIScrollView } from './components/UIScrollView';
import { UIFocus, type FocusItem } from './components/UIFocus';
import type { Renderer } from '../rendering/Renderer';
import type { EventBus } from '../core/EventBus';
import type { StringsProvider } from '../core/StringsProvider';
import type { ResolvedOption, ITextDisplaySettingsProvider } from '../data/types';
import { createStyledText, setStyledReveal, setStyledText } from '../core/styledText';
import { plainTextLength } from '../core/textStyle';

/**
 * 遭遇面板：贴屏幕下沿的一块「叙述 → 选项 → 结果」暗红木框牌，不是弹窗。
 *
 * 观感（对齐 tmp/ui_mockups_2026-08-03/10_ingame_encounter_choices.png）：
 * 暗红纸纹底 + 偏红做旧木框（`SKINS.encounter` 自带 woodTint）+ 内金细线；
 * 「遭遇」小木牌骑在面板上沿左侧（与对话框说话人名牌同一做法，走 `SKINS.nameplate`）；
 * 正文块居中、纸灰白；选项是竖排近方正按钮，普通项纸灰白、带门槛的项转琥珀，
 * 悬停整条按 `drawSelectedRow` 点亮一档 + 金描边。
 *
 * **刻意不走 UIWindow**（与 {@link ActionChoiceUI} 同三条理由，硬塞会改变玩法语义）：
 * 1. 它贴下沿、与对白框同一带位置，UIWindow 恒居中——遭遇正在场上发生，
 *    居中弹窗会把当事的人 / 物盖掉；
 * 2. 它**不铺遮罩**（旧实现无 overlay），遮罩会把"场景里发生的事"降格成"弹出的窗"；
 * 3. UIWindow 的 ✕ 是固有件，而选项相**必须选一个**——`EncounterManager` 只等
 *    `encounter:choiceSelected`，没有取消通道（选项被过滤空时它自己收束，不靠 UI）；
 *    叙述 / 结果相的推进也走点击 / Space，不是"关闭"。
 * 本面板未注册进 `GameStateController`（由 `EventBridge` 按 encounter 事件驱动），
 * 因此不需要 `setCloseRequester` 那套弹栈通道。
 *
 * 两条必须守住的旧修复：
 * - 正文与选项列表走 {@link UIScrollView}。旧实现拿 mask 把超出盒高的正文直接裁掉，
 *   选项则按 `screenHeight - 总高` 直接定位，选项一多整条会被推出屏幕上沿、点都点不到。
 *   这里**选项相只建一块面板、只挂一个滚动区**（叙述与选项同处一份 content），
 *   两个滚动区叠在同一块面板上会重复吃滚轮。
 * - 尺寸 / 字号一律取 {@link UITheme} 令牌，不再写散落的绝对数字。
 *
 * ⚠ 本类是全站 window 级"推进"监听方（{@link onClick}）：行内 `pointerdown` 必须
 * `markPointerConsumed`，否则同一次原生事件在这里会被当成"点击推进"再吃一遍。
 */

/** 面板与屏幕边缘的留白 */
const MARGIN = UITheme.spacing.xxl;
/** 面板内边距（要盖过 15px 木条 + 9px 内金线才不压字） */
const PAD = UITheme.spacing.xxl;
/**
 * 面板宽度：设计稿里遭遇牌只占屏宽六成上下，不是通栏。
 * 按屏宽取比例再夹上限——只写死一个像素数的话，4:3 窗口下会胖到近乎通栏。
 */
const PANEL_MAX_W = 760;
const PANEL_WIDTH_RATIO = 0.66;
/**
 * 给滚动条留出的宽度（正文/选项行让出这一截，否则字压在条下面）。
 * 选项行有自己的边框，md(12) 匀到两边只剩 6px，条几乎贴着行边框；给到 xl 才分得开。
 */
const SCROLL_GUTTER = UITheme.spacing.xl;
/** 内容相对视口左沿的位移：把 SCROLL_GUTTER 均摊到两侧，内容仍居中 */
const CONTENT_X = Math.round(SCROLL_GUTTER / 2);
/**
 * 骑边名牌的高与探出量：**与对话框说话人名牌取齐**（`DialogueUI` 的
 * PLATE_HEIGHT 56 / PLATE_RISE 34）。两块牌子在同一带位置轮流出现，
 * 一高一矮会立刻露馅；牌高按 title 档字（30）加木条厚度反推，写死更稳。
 */
const PLATE_H = 56;
const PLATE_RISE = 34;
/**
 * 选项行体的**兜底**下限。行体实际高按各行文字量出来（bodyLarge 的一行就要 37，
 * 加上下留白自然到 61），这里只防退化文案（空串）把行压成一条缝。
 * 旧实现是反过来的：48px 固定步进（行体 40）比一行字还矮，长选项换行后直接压出行外。
 */
const ROW_MIN_H = 48;
/** 行体内上下留白 */
const ROW_PAD_Y = UITheme.spacing.md;
/** 两行选项之间的缝 */
const ROW_GAP = UITheme.spacing.md;
/** 行内左右各让开的宽度：左沿要放序号，右沿留同样的空，正文才仍是居中的 */
const ROW_INSET_X = UITheme.spacing.xxl;
/** 类型标签行与其下选项正文之间的缝 */
const TAG_GAP = UITheme.spacing.xs;
/** 选项主文字与其下禁用原因括注之间的缝 */
const REASON_GAP = UITheme.spacing.xs;
/** 叙述块与选项列表之间的缝（一段正文与一摞按钮，得分得开） */
const NARRATIVE_GAP = UITheme.spacing.xxl;
/** 正文行距：bodyLarge 的宋体中文按 1.3 倍排会糊成一坨，给到 ~1.5 倍 */
const LINE_H = UITheme.fontSize.bodyLarge + UITheme.spacing.md;
/** 叙述 / 结果盒的最小正文高度：一句话的遭遇也不该缩成一条缝 */
const MIN_TEXT_H = LINE_H * 2;
/**
 * 打字机**基准**速度（字/秒）。玩家在设置页调的是倍率（见 `ITextDisplaySettingsProvider`），
 * 实际速度 = 这个数 × 倍率；关掉逐字显示时整段瞬间出全。
 * 比对白框（30）快半档是本面板自己的手感，别为了"统一"拉平。
 */
const TYPEWRITER_BASE_CPS = 35;

/** 一行选项量好的排版件（三档字号各自成 Text，行高由它们反推）。 */
interface RowPlan {
  opt: ResolvedOption;
  /** `[规矩]` / `[特殊]` 分类戳子；general 没有 */
  tag: Text | null;
  /** 标签行占的高（含它与正文之间的缝）；没有标签时为 0 */
  tagH: number;
  label: Text;
  /** 置灰原因括注；能选的行没有 */
  reason: Text | null;
  /** 文字块（标签 + 正文 + 括注）净高 */
  blockH: number;
  /** 行体高 = 文字块 + 上下留白，且不低于 ROW_MIN_H */
  height: number;
}

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
  /** 逐字显示开关 / 速度（玩家在设置页调，每帧现读） */
  private textSettings: ITextDisplaySettingsProvider;
  private container: Container | null = null;
  private phase: EncounterPhase = EncounterPhase.Inactive;

  private narrativeText: Text | null = null;
  private narrativeBox: Container | null = null;
  private narrativeView: UIScrollView | null = null;
  private optionsContainer: Container | null = null;
  private optionsView: UIScrollView | null = null;
  private resultText: Text | null = null;
  /** 「继续」点捺：叙述相/结果相打完字、等玩家推进时浮现（与对话框同一个件） */
  private continueMark: ContinueIndicator | null = null;
  private resultBox: Container | null = null;
  private resultView: UIScrollView | null = null;
  private currentOptions: ResolvedOption[] = [];
  /** 最近一条叙述原文：选项相把它与选项画在同一块面板里（设计稿就是一整块） */
  private lastNarrative = '';
  /** 选项一旦被点选即上锁，避免快速双击/点击+按键造成 encounter:choiceSelected 重复派发。 */
  private choiceLocked = false;
  /**
   * 键盘 / 手柄焦点。**只在选项相有项**：叙述相与结果相没有可交互元素
   * （推进走点击 / Space），`handleKey` 因此恒返回 false，把按键让回给原有的推进通道。
   * 高亮沿用行自己的悬停画法（`drawSelectedRow` 那层 hoverBg），不另画焦点框。
   */
  private focus = new UIFocus();

  /** 当前正文的**带标记原串**；打字机进度按可见字数走 fullTextVisible */
  private fullText: string = '';
  /** fullText 的可见字数（剥掉 `[c:…]` 后的长度） */
  private fullTextVisible: number = 0;
  private displayedChars: number = 0;
  /**
   * 打字机进度（**已累计字数**，含小数）。不存"已过秒数×速度"：玩家可以在正文播到一半时
   * 去设置页改速度／关逐字，按秒数重算会让已出的字数跳变。
   */
  private typewriterChars: number = 0;
  private textComplete: boolean = false;

  private onClickBound: (e: PointerEvent) => void;
  private onKeyBound: (e: KeyboardEvent) => void;

  private narrativeCb: (payload: { text: string }) => void;
  private optionsCb: (payload: { options: ResolvedOption[] }) => void;
  private resultCb: (payload: { text: string }) => void;
  private endCb: () => void;

  constructor(
    renderer: Renderer,
    eventBus: EventBus,
    strings: StringsProvider,
    textSettings: ITextDisplaySettingsProvider,
  ) {
    this.renderer = renderer;
    this.eventBus = eventBus;
    this.strings = strings;
    this.textSettings = textSettings;

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

  /** 当前相的滚动区（方向键 / 翻页键路由到它）。 */
  private activeView(): UIScrollView | null {
    if (this.phase === EncounterPhase.Narrative) return this.narrativeView;
    if (this.phase === EncounterPhase.Options) return this.optionsView;
    if (this.phase === EncounterPhase.Result) return this.resultView;
    return null;
  }

  // -- 面板外形 ---------------------------------------------------------------

  private panelWidth(): number {
    const sw = this.renderer.screenWidth;
    return Math.min(sw - MARGIN * 2, PANEL_MAX_W, Math.round(sw * PANEL_WIDTH_RATIO));
  }

  /** 视口可用的最大高度：面板顶留出名牌探头的位置，绝不越过屏幕上沿。 */
  private maxViewHeight(): number {
    return Math.max(LINE_H, this.renderer.screenHeight - MARGIN * 2 - PAD * 2 - PLATE_RISE);
  }

  /**
   * 名牌文案。strings.json 的 `encounter.panelTitle` 若未配置，`get` 会回吐 key 本身，
   * 此时用内置兜底——名牌是面板固有件，缺一条 strings 不该让它显示成 "panelTitle"。
   */
  private panelTitle(): string {
    const s = this.strings.get('encounter', 'panelTitle');
    return s === 'panelTitle' ? '遭遇' : s;
  }

  /** 骑在面板上沿左侧的小木牌（与对话框说话人名牌同一做法）。 */
  private buildNameplate(panelX: number, panelY: number): Container {
    const label = createStyledText({
      text: this.panelTitle(),
      style: {
        fontSize: UITheme.fontSize.title,
        fill: UITheme.colors.title,
        fontFamily: UITheme.fonts.display,
        fontWeight: 'bold',
        letterSpacing: UITheme.letterSpacing.title,
      },
    });
    label.eventMode = 'none';

    // 牌宽随字走、牌高写死：高度跟着字高算的话，换一档字号牌子就变形，
    // 与对话框那块同带位置的名牌一比高低立刻露馅。
    const w = Math.round(label.width + UITheme.spacing.lg * 2);
    const x = panelX + UITheme.spacing.xxl;
    const y = panelY - PLATE_RISE;

    const c = createPanel(x, y, w, PLATE_H, SKINS.nameplate);
    label.position.set(x + UITheme.spacing.lg, y + Math.round((PLATE_H - label.height) / 2));
    c.addChild(label);
    return c;
  }

  /** 一块完整的遭遇牌：暗红纸纹底 + 偏红木框 + 内金线 + 骑边名牌。 */
  private buildShell(panelX: number, panelY: number, panelW: number, panelH: number): Container {
    const shell = new Container();
    shell.addChild(createPanel(panelX, panelY, panelW, panelH, SKINS.encounter));
    shell.addChild(this.buildNameplate(panelX, panelY));

    // 「继续」点捺压右下角，让开木条与内金线
    this.continueMark = new ContinueIndicator();
    this.continueMark.setPosition(
      panelX + panelW - PAD - CONTINUE_MARK_SIZE.width,
      panelY + panelH - PAD - CONTINUE_MARK_SIZE.height - CONTINUE_MARK_SIZE.float,
    );
    shell.addChild(this.continueMark.container);
    return shell;
  }

  /**
   * 正文 Text。设计稿里正文是「整块居中、块内逐行左对齐」——所以块的 x 按**全文**
   * 量一次定死，打字机推进时不再重算，否则每出一个字整块都会左右抖。
   */
  private buildBodyText(fullText: string, contentW: number): Text {
    const t = createStyledText({
      text: fullText,
      style: {
        fontSize: UITheme.fontSize.bodyLarge,
        fill: UITheme.colors.body,
        fontFamily: UITheme.fonts.ui,
        wordWrap: true, breakWords: true,
        wordWrapWidth: contentW,
        lineHeight: LINE_H,
      },
    });
    t.eventMode = 'none';
    t.x = CONTENT_X + Math.max(0, Math.round((contentW - t.width) / 2));
    return t;
  }

  /**
   * 量一行选项：主文字、类型标签、禁用原因**各自一个 Text**，字号分三档。
   *
   * 拼成一个 Text 的话三样只能同用一档字号（旧实现就是 `[规矩] 撒米镇邪（碎片不足 2/5）`
   * 整串 bodyLarge）——括注和标签是配角，跟着正文一起放大只会把「这一条是干什么的」
   * 淹掉，行也被撑得没法看。
   */
  private planRow(opt: ResolvedOption, rowW: number): RowPlan {
    const typeColors: Record<string, number> = {
      general: UITheme.colors.body,
      // 有门槛的选项一律转琥珀（设计稿里「撒米镇邪（需道学 3 及以上）」就是这一档），
      // 旧实现的冷绿是暖木配色里唯一一处冷调，一眼跳出来
      rule: UITheme.colors.title,
      special: UITheme.colors.encounterSpecial,
    };
    const typeLabel: Record<string, string> = {
      general: '',
      rule: this.strings.get('encounter', 'ruleTag'),
      special: this.strings.get('encounter', 'specialTag'),
    };

    const color = opt.enabled ? (typeColors[opt.type] ?? UITheme.colors.body) : UITheme.colors.disabled;
    const wrapBase = Math.max(LINE_H, rowW - ROW_INSET_X * 2);

    /**
     * 类型标签：一枚分类戳子，small，**另起一行压在选项正上方**。
     *
     * 挂在正文左边试过，不行：正文按行中轴居中、又几乎占满换行宽，左边根本不剩位置——
     * 标签必然骑到左沿那个数字键序号上（两者还都是 small 暗色，糊成一团）。
     * 抬成上一行则与正文宽度无关，任何长度的选项都不会打架。
     */
    const tagStr = typeLabel[opt.type] ?? '';
    const tag = tagStr
      ? createStyledText({
          text: tagStr,
          style: { fontSize: UITheme.fontSize.small, fill: color, fontFamily: UITheme.fonts.ui },
        })
      : null;
    if (tag) tag.eventMode = 'none';

    // 选项本身：玩家真正在读、要拿它做决定的那句话，bodyLarge
    const label = createStyledText({
      text: opt.text,
      style: {
        fontSize: UITheme.fontSize.bodyLarge,
        fill: color,
        fontFamily: UITheme.fonts.ui,
        align: 'center',
        wordWrap: true, breakWords: true,
        wordWrapWidth: wrapBase,
        lineHeight: LINE_H,
      },
    });
    label.eventMode = 'none';

    // 禁用原因：另起一行的括注说明。
    // - 字号 small：它解释的是上面那句，自己不该被读成第二个选项；
    // - 颜色比置灰的选项名**再暗一档**：同为灰、它却更亮的话，主次就反了；
    // - 不再自己包一层「（）」：字号与颜色已经说明这是旁注，而原因文案本身
    //   常自带括号（「规矩要义不足（需要：…）」），再包一层就成了套娃。
    const reason = !opt.enabled && opt.disableReason
      ? createStyledText({
          text: opt.disableReason,
          style: {
            fontSize: UITheme.fontSize.small,
            fill: UITheme.colors.hint,
            fontFamily: UITheme.fonts.ui,
            align: 'center',
            wordWrap: true, breakWords: true,
            wordWrapWidth: wrapBase,
            lineHeight: UITheme.fontSize.small + UITheme.spacing.sm,
          },
        })
      : null;
    if (reason) reason.eventMode = 'none';

    const tagH = tag ? Math.ceil(tag.height) + TAG_GAP : 0;
    const blockH = tagH + Math.ceil(label.height) + (reason ? REASON_GAP + Math.ceil(reason.height) : 0);
    return { opt, tag, tagH, label, reason, blockH, height: Math.max(ROW_MIN_H, blockH + ROW_PAD_Y * 2) };
  }

  // -- 三个相 -----------------------------------------------------------------

  /**
   * 叙述盒与结果盒同一套外形（只差文案），收口成一处。
   * 正文挂进 UIScrollView.content，超出盒高的部分可滚可见，不再被 mask 生吞。
   */
  private buildTextBox(fullText: string): { box: Container; text: Text; view: UIScrollView } {
    const sw = this.renderer.screenWidth;
    const sh = this.renderer.screenHeight;
    const panelW = this.panelWidth();
    const panelX = Math.round((sw - panelW) / 2);
    const viewW = panelW - PAD * 2;
    const contentW = viewW - SCROLL_GUTTER;

    // 先按全文量高定盒子，打字机推进时面板不会一格一格长高
    const text = this.buildBodyText(fullText, contentW);
    const textH = Math.ceil(text.height);
    const viewH = Math.min(Math.max(textH, MIN_TEXT_H), this.maxViewHeight());
    // 短到撑不满 MIN_TEXT_H 的一句话（「你合上了箱盖。」这种）在盒里垂直居中，
    // 否则它顶在盒子上沿、底下空半格。位置按**全文**量一次定死，与 x 同理：
    // 打字机推进时行数在变，跟着重算整块就会上下跳。
    const panelH = viewH + PAD * 2;
    text.y = Math.max(0, Math.round((viewH - textH) / 2));
    const panelY = sh - panelH - MARGIN;

    const box = this.buildShell(panelX, panelY, panelW, panelH);
    this.container!.addChild(box);

    const view = new UIScrollView(this.renderer, {
      width: viewW,
      height: viewH,
      // 本条不铺遮罩，屏幕其余部分仍是场景：只吃落在盒子上的滚轮
      hitTest: (hx, hy) => hx >= panelX && hx <= panelX + panelW && hy >= panelY && hy <= panelY + panelH,
    });
    view.container.position.set(panelX + PAD, panelY + PAD);
    this.container!.addChild(view.container);

    view.content.addChild(text);
    view.refresh();

    return { box, text, view };
  }

  private resetTypewriter(text: string): void {
    this.fullText = text;
    this.fullTextVisible = plainTextLength(text);
    this.displayedChars = 0;
    this.typewriterChars = 0;
    this.textComplete = false;
    // 逐字显示关掉：整段当场出全——否则玩家得先点一次"跳过打字"再点一次才推进
    if (!this.textSettings.isTypewriterEnabled()) this.completeText();
  }

  /**
   * 当前相的正文直接出全（关掉逐字 / 点击跳过共用这一条出路）。
   * 正文对象取不到时也要落 `textComplete`：否则这一相点什么都不动，玩家被卡在这块面板上。
   */
  private completeText(): void {
    const textObj = this.phase === EncounterPhase.Narrative ? this.narrativeText : this.resultText;
    this.displayedChars = this.fullTextVisible;
    if (textObj) {
      setStyledReveal(textObj, this.displayedChars);
      // 正文变长要重算可滚高度，否则滚动条停在"不用滚"
      this.activeView()?.refresh();
    }
    this.textComplete = true;
  }

  private showNarrative(text: string): void {
    this.ensureContainer();
    this.clearAll();
    this.phase = EncounterPhase.Narrative;
    this.lastNarrative = text;

    const { box, text: textObj, view } = this.buildTextBox(text);
    this.narrativeBox = box;
    this.narrativeText = textObj;
    this.narrativeView = view;

    setStyledText(textObj, text, 0);
    this.resetTypewriter(text);
  }

  private showOptions(options: ResolvedOption[]): void {
    this.ensureContainer();
    this.clearNarrative();
    // 旧实现不清旧选项，重复派发 encounter:options 会叠两层（且叠上去的那层还在吃滚轮）
    this.clearOptions();
    this.phase = EncounterPhase.Options;
    this.currentOptions = options;
    this.choiceLocked = false;

    const sw = this.renderer.screenWidth;
    const sh = this.renderer.screenHeight;
    const panelW = this.panelWidth();
    const panelX = Math.round((sw - panelW) / 2);
    const viewW = panelW - PAD * 2;
    const contentW = viewW - SCROLL_GUTTER;

    // 叙述与选项同处一块面板、同一份滚动内容（设计稿就是一整块，且只能有一个滚动区）
    const narrative = this.lastNarrative ? this.buildBodyText(this.lastNarrative, contentW) : null;
    const narrativeH = narrative ? Math.ceil(narrative.height) + NARRATIVE_GAP : 0;

    // 先量后画：行高由各行自己的文字量出来（长选项会换行），面板高再由行高之和反推。
    // 固定行高在 bodyLarge 档下必然压字。
    const rowW = contentW;
    const plans = options.map((opt) => this.planRow(opt, rowW));
    const rowsH = Math.max(0, plans.reduce((sum, p) => sum + p.height + ROW_GAP, 0) - ROW_GAP);
    const viewH = Math.max(LINE_H, Math.min(narrativeH + rowsH, this.maxViewHeight()));
    const panelH = viewH + PAD * 2;
    const panelY = sh - panelH - MARGIN;

    this.optionsContainer = new Container();
    this.container!.addChild(this.optionsContainer);
    this.optionsContainer.addChild(this.buildShell(panelX, panelY, panelW, panelH));

    const list = new UIScrollView(this.renderer, {
      width: viewW,
      height: viewH,
      hitTest: (hx, hy) => hx >= panelX && hx <= panelX + panelW && hy >= panelY && hy <= panelY + panelH,
    });
    list.container.position.set(panelX + PAD, panelY + PAD);
    this.optionsContainer.addChild(list.container);
    this.optionsView = list;

    if (narrative) list.content.addChild(narrative);

    // 焦点项与行同批攒出来：矩形取内容坐标系（与 list.content 同系），
    // 空间导航才能按"上/下最近的一行"走。
    const focusItems: FocusItem[] = [];

    let ry = narrativeH;
    for (let i = 0; i < plans.length; i++) {
      const { opt, tag, tagH, label, reason, blockH, height: rowBodyH } = plans[i];

      const rowBg = new Graphics();
      drawPanelBase(rowBg, CONTENT_X, ry, rowW, rowBodyH, SKINS.row, {
        fill: UITheme.colors.encounterRow,
        fillAlpha: UITheme.alpha.rowBg,
        border: UITheme.colors.encounterBorder,
      });
      list.content.addChild(rowBg);

      // 悬停 = 整条点亮一档琥珀 + 金描边（不是"换个深色"）
      const hoverBg = new Graphics();
      drawSelectedRow(hoverBg, CONTENT_X, ry, rowW, rowBodyH);
      hoverBg.visible = false;
      list.content.addChild(hoverBg);

      // 数字键 1~9 仍然能选：留一个极暗的序号压在左沿，正文该居中还是居中。
      // 序号是「扫一眼就走」的配角，钉在 small——跟着选项字一起长到 bodyLarge
      // 就成了每行左边一排大数字，比选项本身还抢眼。
      const index = createStyledText({
        text: String(i + 1),
        style: {
          fontSize: UITheme.fontSize.small,
          fill: UITheme.colors.hintLight,
          fontFamily: UITheme.fonts.ui,
        },
      });
      index.eventMode = 'none';
      index.x = CONTENT_X + UITheme.spacing.lg;
      index.y = ry + Math.round((rowBodyH - index.height) / 2);
      list.content.addChild(index);

      // 文字块（标签行 + 正文 + 括注）整体在行体里垂直居中，三者各自按行中轴水平居中
      const blockY = ry + Math.round((rowBodyH - blockH) / 2);
      if (tag) {
        tag.x = CONTENT_X + Math.round((rowW - tag.width) / 2);
        tag.y = blockY;
        list.content.addChild(tag);
      }
      label.x = CONTENT_X + Math.round((rowW - label.width) / 2);
      label.y = blockY + tagH;
      list.content.addChild(label);
      if (reason) {
        reason.x = CONTENT_X + Math.round((rowW - reason.width) / 2);
        reason.y = blockY + tagH + Math.ceil(label.height) + REASON_GAP;
        list.content.addChild(reason);
      }

      const rowTop = ry;
      ry += rowBodyH + ROW_GAP;

      // 焦点项：**每一行都登记**（含禁用行，传 disabled 让 UIFocus 自己过滤），
      // 免得"这一行到底算不算数"的判断散到两处。禁用行不吃焦点，但它的原因括注
      // 本来就常驻画在行里（`plans[i].reason`），不靠焦点也读得到。
      focusItems.push({
        id: `opt-${i}`,
        x: CONTENT_X, y: rowTop, w: rowW, h: rowBodyH,
        group: 'options',
        disabled: !opt.enabled,
        onFocus: (on) => { hoverBg.visible = on; rowBg.visible = !on; },
        onActivate: () => this.selectOption(opt),
      });

      // 无条件禁用且没给理由的行：与旧实现一致，完全不接指针（点了本来就没有任何反馈）
      if (!opt.enabled && !opt.disableReason) continue;

      // 整行命中：命中区自己是一块 Graphics，不拿会被 hover 隐藏的 rowBg 当靶子，
      // 也不靠 Text 本身（Pixi 逐子元素命中，只给 Text 会让行内空白成死区）
      const hit = new Graphics();
      hit.rect(CONTENT_X, rowTop, rowW, rowBodyH);
      hit.fill({ color: 0xffffff, alpha: UITheme.alpha.hitArea });
      hit.eventMode = 'static';
      hit.cursor = opt.enabled ? 'pointer' : 'default';
      if (opt.enabled) {
        // 悬停即移焦：鼠标与手柄共用同一个"当前项"，高亮由 onFocus 一处画
        // （所以这里不再自己开关 hoverBg，也不再在 pointerout 里关掉它——
        //  指针挪开后焦点仍在这一行上，屏幕上必须始终看得见焦点在哪）。
        hit.on('pointerover', () => {
          this.focus.syncHover(`opt-${i}`);
          this.eventBus.emit('ui:hover', {});
        });
      }
      hit.on('pointerdown', (ev) => {
        // 本类自己就是 window 级推进监听方：不标记已消费，这一下点完选项还会被
        // onClick 当成"点击推进"再吃一遍
        markPointerConsumed(ev.nativeEvent);
        if (opt.enabled) {
          this.selectOption(opt);
        } else {
          // 置灰选项点击时给出原因反馈，与 DialogueUI 的禁用提示一致，避免"点了没反应"
          this.eventBus.emit('notification:show', { text: opt.disableReason!, type: 'warning' });
        }
      });
      list.content.addChild(hit);
    }

    list.refresh();

    // 默认焦点落在**第一个可选项**上（不是第一行——首行常是被门槛卡住的规矩选项，
    // 焦点落在按了没用的地方等于要玩家先按一下才开始）。
    this.focus.setItems(focusItems);
    const firstEnabled = focusItems.find((it) => !it.disabled);
    if (firstEnabled) this.focus.focusDefault(firstEnabled.id);
    // 默认焦点也可能一开就在视口外：叙述块长、或前几条全是被门槛卡住的规矩选项时，
    // 第一个可选项就落在折线以下——不滚一下，面板一打开玩家根本看不见焦点在哪。
    this.scrollFocusIntoView();
  }

  /**
   * 把焦点行滚进视口。选项一多列表就要滚，焦点走到视口外而列表不动的话，
   * 玩家看到的是"高亮消失了"。
   */
  private scrollFocusIntoView(): void {
    const view = this.optionsView;
    const cur = this.focus.current;
    if (!view || !cur) return;
    const top = cur.y;
    const bottom = cur.y + cur.h;
    const off = view.scrollOffset;
    if (top < off) view.scrollOffset = top;
    else if (bottom > off + view.viewportHeight) view.scrollOffset = bottom - view.viewportHeight;
  }

  private showResult(text: string): void {
    this.ensureContainer();
    this.clearOptions();
    this.clearResult();
    this.phase = EncounterPhase.Result;

    const { box, text: textObj, view } = this.buildTextBox(text);
    this.resultBox = box;
    this.resultText = textObj;
    this.resultView = view;

    setStyledText(textObj, text, 0);
    this.resetTypewriter(text);
  }

  update(dt: number): void {
    // 点捺**先于早退判断**：正是"打完字了(textComplete)、且不在选项相"这一刻要浮现，
    // 放在下面的 return 之后就永远不会被驱动。
    if (this.continueMark) {
      this.continueMark.setVisible(
        this.textComplete
        && this.phase !== EncounterPhase.Inactive
        && this.phase !== EncounterPhase.Options,
      );
      this.continueMark.update(dt);
    }
    if (this.phase === EncounterPhase.Inactive || this.phase === EncounterPhase.Options) return;
    if (this.textComplete) return;

    // 正文播到一半时玩家可以进暂停菜单把逐字关掉：这一帧直接补完
    if (!this.textSettings.isTypewriterEnabled()) {
      this.completeText();
      return;
    }

    const textObj = this.phase === EncounterPhase.Narrative ? this.narrativeText : this.resultText;
    if (!textObj) return;

    this.typewriterChars += dt * TYPEWRITER_BASE_CPS * this.textSettings.getTypewriterSpeedScale();
    const charsToShow = Math.floor(this.typewriterChars);
    if (charsToShow > this.displayedChars) {
      this.displayedChars = Math.min(charsToShow, this.fullTextVisible);
      // 不能 substring：带 `[c:…]` 标记的原串会被切碎
      setStyledReveal(textObj, this.displayedChars);
      // 正文变长要重算可滚高度，否则滚动条永远停在"不用滚"
      this.activeView()?.refresh();
    }
    if (this.displayedChars >= this.fullTextVisible) {
      this.textComplete = true;
    }
  }

  private onClick(e: PointerEvent): void {
    if (!isEventOnGameCanvas(this.renderer, e)) return;
    if (isPointerConsumed(e)) return;
    this.handleAdvance();
  }

  private onKey(e: KeyboardEvent): void {
    if (e.repeat) return;
    // 焦点优先、滚动兜底：选项相的方向键是"挪焦点"，走到视口外再把那一行滚进来；
    // 叙述 / 结果相没有焦点项（handleKey 恒 false），方向键仍旧是滚正文。
    if (this.focus.handleKey(e.code)) {
      e.preventDefault();
      this.scrollFocusIntoView();
      return;
    }
    // 方向键 / 翻页键滚正文或选项列表（不与 Space/Enter、数字键冲突）
    if (this.activeView()?.handleKey(e.code)) {
      e.preventDefault();
      return;
    }
    if (e.code === 'Space' || e.code === 'Enter') {
      this.handleAdvance();
    }
    if (this.phase === EncounterPhase.Options && e.code >= 'Digit1' && e.code <= 'Digit9') {
      const idx = parseInt(e.code.replace('Digit', ''), 10) - 1;
      const opt = this.currentOptions[idx];
      if (opt && opt.enabled) {
        this.selectOption(opt);
      }
    }
  }

  /** 统一的选项派发入口：上锁后只派发一次，防止双击 / 点击+按键重复触发结算。 */
  private selectOption(opt: ResolvedOption): void {
    if (this.choiceLocked) return;
    this.choiceLocked = true;
    this.eventBus.emit('encounter:choiceSelected', { index: opt.index });
  }

  private handleAdvance(): void {
    if (this.phase === EncounterPhase.Options) return;

    if (!this.textComplete) {
      this.completeText();
      return;
    }

    if (this.phase === EncounterPhase.Narrative) {
      this.eventBus.emit('encounter:narrativeDone', {});
    } else if (this.phase === EncounterPhase.Result) {
      this.eventBus.emit('encounter:resultDone', {});
    }
  }

  private clearNarrative(): void {
    // 先拆滚动区：它自己在 window 上挂了 wheel 监听，只销毁父容器会留残留；
    // 正文 Text 挂在 view.content 上，随 view 一并销毁，不能再单独 destroy 一次
    this.narrativeView?.destroy();
    this.narrativeView = null;
    this.narrativeText = null;
    // 点捺挂在 shell 里，随 box 的 destroy({children:true}) 一并回收；这里只断引用
    this.continueMark = null;
    if (this.narrativeBox) {
      if (this.narrativeBox.parent) this.narrativeBox.parent.removeChild(this.narrativeBox);
      this.narrativeBox.destroy({ children: true });
      this.narrativeBox = null;
    }
  }

  private clearResult(): void {
    this.resultView?.destroy();
    this.resultView = null;
    this.resultText = null;
    this.continueMark = null;
    if (this.resultBox) {
      if (this.resultBox.parent) this.resultBox.parent.removeChild(this.resultBox);
      this.resultBox.destroy({ children: true });
      this.resultBox = null;
    }
  }

  private clearOptions(): void {
    // 焦点项持有行 Graphics 的回调，必须与选项容器同生共死；顺带把 currentId 清掉，
    // 下一批选项才会重新落到"第一个可选项"而不是被上一轮的 opt-N 拽回去
    this.focus.destroy();
    this.optionsView?.destroy();
    this.optionsView = null;
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
    // 三个 clearXxx 必须先跑：滚动区的 window 级 wheel 监听只能由它自己摘
    this.clearNarrative();
    this.clearResult();
    this.clearOptions();
    if (this.container) {
      const children = [...this.container.children];
      for (const child of children) {
        this.container.removeChild(child);
        child.destroy({ children: true });
      }
    }
  }

  hide(): void {
    this.phase = EncounterPhase.Inactive;
    this.clearAll();
    this.focus.destroy();
    if (this.container) {
      if (this.container.parent) {
        this.container.parent.removeChild(this.container);
      }
      this.container.destroy({ children: true });
      this.container = null;
    }
    this.fullText = '';
    this.fullTextVisible = 0;
    this.lastNarrative = '';
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
