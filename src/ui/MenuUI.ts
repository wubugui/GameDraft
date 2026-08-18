import { Assets, Container, FillGradient, Graphics, Sprite, Text, Texture } from 'pixi.js';
import type { FederatedPointerEvent } from 'pixi.js';
import { MEDIA_URLS } from '../core/projectPaths';
import { UITheme, fadeIn } from './UITheme';
import { createPanel, drawPanelBase, SKINS } from './PanelSkin';
import { UIButton } from './components/UIButton';
import { openConfirmDialog } from './components/UIConfirmDialog';
import { UIWindow, WINDOW_SIZES } from './components/UIWindow';
import { UIScrollView } from './components/UIScrollView';
import { ART_TEXT_SHADOW, createRule, createTitleRow, drawSelectedRow } from './components/UIDecor';
import { UIFocus, type FocusItem } from './components/UIFocus';
import { clientToCanvas, markPointerConsumed } from './uiPointerCoords';
import type { Renderer } from '../rendering/Renderer';
import type { EventBus } from '../core/EventBus';
import type {
  AudioChannel, ISaveDataProvider, IAudioSettingsProvider, ITextDisplaySettingsProvider, SaveSlotMeta,
} from '../data/types';
import type { StringsProvider } from '../core/StringsProvider';
import { createStyledText } from '../core/styledText';
import { sliderToTypewriterScale, typewriterScaleToSlider } from '../core/TextDisplaySettings';

type MenuMode = 'main' | 'pause' | 'save' | 'load' | 'settings';

/**
 * 菜单项的语义层级。沿用迁移期 UIButton 的三级语义（主操作 / 普通 / 破坏性），
 * 但设计稿里主菜单与暂停页的条目**长得完全一样**，层级只由「当前项那条琥珀光带」
 * 和条目次序表达——所以 tone 在这里只影响静息字色（很轻）与默认落在哪一项。
 */
type MenuTone = 'primary' | 'normal' | 'danger';

interface MenuItem {
  label: string;
  action: () => void;
  tone?: MenuTone;
}

/* ── 标题界面（现代式：背景图作主体，无面板） ──────────────────────────────
 *
 * 制作人 2026-08-04 定调：**标题界面不要一板一眼的面板**，主体是背景图，
 * 菜单直接排在画面合适的位置，简洁不失美感。这与其余面板（做旧木框那套）刻意不同——
 * 标题界面是"一张海报"，游戏内面板才是"钉在墙上的木牌"，两种语言各司其职。
 *
 * 版式取自现代标题界面的通行做法：全出血主视觉 + 无框文字菜单 +
 * 选中只靠「字亮 + 字下短记号」。
 *
 * **画面一点不压暗**（2026-08-05 制作人拍板）：底部渐变黑纱那套已废除——压暗等于把
 * 美术画的东西再抹掉一层。文字可读性全交给字自己的投影（`ART_TEXT_SHADOW`）。
 */
/**
 * 标题界面版式：**标题压左上、菜单左下竖排，全部左对齐**（2026-08-05 制作人从三版对照图里选定，
 * 另外两版是"居中收紧"与"右下右对齐"）。
 *
 * 要点是把画面正中那片水面和右侧吊脚楼整块让给美术——文字全部收在左侧一条竖带上，
 * 不再骑在主视觉正中央。改回居中式前先问过制作人。
 */
/** 文字距左屏边的留白（占屏宽比例）：标题、短线、副标题、菜单项共用这一条竖基准线 */
const TITLE_SIDE_INSET_PCT = 0.08;

/** 标题基线（占屏高比例）与字号（占屏高比例，四字标题的目标视高） */
const TITLE_Y_PCT = 0.14;
const TITLE_SIZE_PCT = 0.13;
/** 标题下那道琥珀短线：宽度取标题宽的几成 */
const TITLE_RULE_W_PCT = 0.34;
/**
 * 条目字号的上下限。
 * ⚠ **上限就是 34，别再往上调**：试过 46，制作人的判词是「太几把大了」——
 * 标题界面的主角是主视觉和标题，菜单是让人一眼扫过去就按的，不是视觉重心。
 * 下限守住五项时（有存档会多出读档/退出）也别缩成蚂蚁。
 */
const TITLE_MENU_FONT_MAX = 34;
const TITLE_MENU_FONT_MIN = 26;
/** 行步进 = 字号 × 这个比（行距一并跟着字号走，字大了不至于挤成一坨） */
const TITLE_MENU_STEP_RATIO = 1.95;
/** 菜单块底沿至少离屏底这么远——**要大但不许撑满**，底下这口气是这套版式的一部分 */
const TITLE_MENU_BOTTOM_PCT = 0.09;
/** 选中记号：文字正下方那道短线（宽度取文字实宽的几成、离字底多远、线多粗） */
const TITLE_UNDERLINE_W_PCT = 0.46;
const TITLE_UNDERLINE_GAP = 8;
const TITLE_UNDERLINE_H = 2;

/** 菜单钮的最小/最大高度：条目少时按钮拉高把牌子填满（设计稿的牌子几乎是满的） */
const BTN_H = 52;
const BTN_H_MAX = 64;
const BTN_GAP = UITheme.spacing.sm;

/**
 * 主菜单背景图：雾锁码头夜景（吊脚楼 / 乌篷船 / 几点昏黄油灯），照设计稿 02 出的专用底图。
 *
 * **构图上是为菜单牌服务的**：画面正中偏上刻意是一片空雾，木牌压上去不会撞到高对比细节。
 * 换图时要保住这条，否则标题区会糊成一团。
 *
 * 这是**带透视的氛围立绘**，与「可行走场景背景」那套 45° 无透视等距规格无关，别拿去当场景用。
 * 加载失败一律退回纯色底（{@link UITheme.colors.mainMenuBg}），绝不能因为一张图没到就白屏。
 */
const MAIN_MENU_BG_URL = `${MEDIA_URLS.backgroundsDir}/menu_wujin_dock.png`;

/**
 * 背景相对下层暖近黑底的不透明度＝唯一的压暗手段（不叠黑遮罩，见 {@link MenuUI.fillBackdrop}）。
 * 判据是肉眼：**街巷、灯笼、石板要看得清**，同时仍明显暗于中间那块木牌。
 */
const MAIN_MENU_BG_ALPHA = 1;

/** 背景贴图全进程只取一次；失败就记下别再重试（每次开菜单都重试等于每次都卡一拍） */
let mainMenuBgTexture: Texture | null = null;
let mainMenuBgFailed = false;
let mainMenuBgPending: Promise<void> | null = null;

/** 存档槽位数。真值在 SaveManager，这里只是渲染多少行——本文件不定义规则。 */
const SLOT_COUNT = 3;
/**
 * 一个槽位按钮的高度与行间距。
 *
 * 两行版式（审查 P1：场景名/天数/日期/时长同字号同色挤一行，玩家没法扫）：
 * 主行 = 场景名(bodyLarge) + 右侧「第 N 天」，副行 = 保存时间 + 游玩时长(small)。
 * 行高要容得下 bodyLarge(~33px 实测字框) + xs 行缝 + small(~21px) 再留上下呼吸。
 */
const SLOT_H = 76;
const SLOT_GAP = UITheme.spacing.sm;
/** 槽位右侧「JSON ↓ / JSON ↑」列宽 */
const JSON_COL_W = 64;

/** 底部「返回」按钮尺寸与它占用的行高 */
const BACK_BTN_W = 140;
const BACK_BTN_H = 44;
const FOOTER_H = BACK_BTN_H + UITheme.spacing.md;

/**
 * UIWindow 的标题栏高 + 底部内边距，用于「按内容条数反推窗高」。
 * 真正排版一律回读 `win.bodyWidth/bodyHeight`，故此常量只影响窗体总高、不会让内容错位。
 * 口径与 ShopUI / QuestPanelUI 一致。
 */
const WINDOW_CHROME_H = 44 + UITheme.spacing.xl;

/**
 * 主菜单 / 暂停页的「竖长木牌」几何（比例取自设计稿 02 / 11）。
 *
 * 设计稿里这两页都不是"按钮浮在整屏上"，而是一块**竖长方形的做旧木牌**居中钉在画面上：
 * 主菜单牌约占屏高 3/4、宽高比 0.6；暂停牌更窄更短（0.68 / 屏高 2/3）。
 * 这几个数是版式比例（不是间距/字号），故留具名常量而非取 spacing 档。
 */
const BOARD_MAIN_RATIO = 0.55;
const BOARD_MAIN_H_PCT = 0.86;
const BOARD_PAUSE_RATIO = 0.68;
const BOARD_PAUSE_H_PCT = 0.75;
/**
 * 牌子最多比"内容紧排高度"拉长多少。**这个数只能小**：拉到 1.45 时三个按钮的主菜单
 * 会在标题与按钮之间空出一大片，牌子看着像没做完；1.18 才是"留白够、但不空"。
 */
const BOARD_STRETCH_MAX = 1.18;
/**
 * 宽高比兜底最多能把牌子拉到"紧排高"的几倍。
 * 只有这一道闸拦得住"标题一长把牌子撑宽 → 宽高比又把牌子顶高 → 两个按钮吊在一块大空板中间"。
 */
const BOARD_ASPECT_FLOOR_MAX = 1.22;
/** 牌子四边的内容留白（木框 15px + 内金线 10px 之外还要再留一圈） */
const BOARD_PAD = UITheme.spacing.xxl;

/** 暂停页条目：无框，只有当前项铺一条横贯的琥珀光带；光带比按钮更贴边（"横贯"就靠这个） */
const PAUSE_ROW_H = 50;
const PAUSE_ROW_H_MAX = 56;
const PAUSE_ROW_GAP = UITheme.spacing.xs;
const PAUSE_BAND_INSET = UITheme.spacing.lg;

/**
 * 条目组中线压在牌高的几成处。
 * 设计稿 02 的按钮组中线约在 64%、稿 11 的条目组约在 56%——都不是"剩余空间里居中"，
 * 而是明显偏下，好让标题上方那片留白站得住。
 */
const MAIN_ROWS_CENTER_PCT = 0.58;
const PAUSE_ROWS_CENTER_PCT = 0.56;

/** 设置页：项目名列宽 / 数值列宽 / 每行步进 */
const CHANNEL_LABEL_W = 96;
const PCT_COL_W = 52;
const SETTING_ROW_H = 48;
/** 设置页开关行的「开 / 关」小按钮尺寸（与滑条同起点，占一行的左半） */
const TOGGLE_BTN_W = 72;
const TOGGLE_BTN_H = 32;
/** 音量滑条几何。组件层没有滑条件，这两个是控件自身的形状（非间距/字号），保留具名常量。 */
const TRACK_H = 6;
const HANDLE_R = 8;
/** 键盘步进一格 = 滑条量程的 1/10（焦点停在滑条上时左右键调值） */
const SLIDER_KEY_STEP = 0.1;
/**
 * 键盘连按后判定"手停了"的静默时长。
 * 短于这个值，按住方向键会连放一串试听声；长了又会让人以为没生效。
 * 250ms ≈ 一次有意的松手，且比键盘自动重复的间隔（~30–50ms）宽出一个数量级。
 */
const SLIDER_SETTLE_MS = 250;

/** {@link MenuUI.makeMenuRow} 的返回值：容器交给调用方摆位，setActive 交给"当前项"这套状态。 */
interface MenuRowHandle {
  container: Container;
  setActive(active: boolean): void;
}

/**
 * dev 外壳挂在标题界面右下角的小开关（prod 不传，整行连建都不建）。
 *
 * 为什么非要在标题界面上：进游戏之前是唯一"还来得及决定这一局要不要调试"的时刻，
 * 而从标题点「新游戏」是整页重启——进去以后再开就得再重启一次、这一局又没了。
 */
export interface MenuDevHooks {
  isNarrativeDebugOn(): boolean;
  setNarrativeDebugOn(on: boolean): void;
}

export class MenuUI {
  private renderer: Renderer;
  private eventBus: EventBus;
  private saveData: ISaveDataProvider;
  private audioSettings: IAudioSettingsProvider;
  /** 文字呈现偏好（逐字显示开关 / 速度），设置页里那两行 */
  private textSettings: ITextDisplaySettingsProvider;
  private strings: StringsProvider;
  /** 全屏页（主菜单 / 暂停）的根容器；窗体页用 {@link win}，两者互斥 */
  private container: Container | null = null;
  /** 标题界面的常驻底图层（跨页存活，见 ensureTitleBackdrop） */
  private titleBackdrop: Container | null = null;
  private titleBackdropSize: { w: number; h: number } | null = null;
  /** 窗体页（存档 / 读档 / 设置）的窗体外壳 */
  private win: UIWindow | null = null;
  /** 存档槽位列表的滚动区（小画布下槽位放不下时才真滚） */
  private list: UIScrollView | null = null;
  private _isOpen = false;
  private mode: MenuMode = 'main';
  private previousMode: MenuMode = 'main';
  /** 滑条拖拽期间挂在 window 上的 pointermove/up 摘除器；面板关闭/销毁时必须清，否则监听泄漏且回调摸已销毁对象 */
  private sliderDragCleanups: Set<() => void> = new Set();
  private unsubscribeResize: (() => void) | null = null;
  /** dev 外壳注入的小开关（prod 为 null，标题界面上什么都不多出来） */
  private devHooks: MenuDevHooks | null = null;
  /** 标题界面那行 dev 小开关的重画钩子（页面重建即失效，destroyUI 里清） */
  private devToggleRepaint: (() => void) | null = null;
  /**
   * 键盘/手柄焦点。五个页共用这一个实例：每次 build() 把当页的焦点项整批重喂，
   * 页内重建（存完档刷新槽位 / 切逐字显示开关）靠 setItems 按 id 复位，
   * **换页**才重落该页的默认焦点（focusMode 判定）。
   */
  private focus = new UIFocus();
  /** 当前 build 攒出来的焦点项；各页 builder 往里推，build() 收尾统一喂给 UIFocus */
  private focusItems: FocusItem[] = [];
  /** 当页默认焦点（各页 builder 自报）：标题=新游戏、暂停=继续、存读=第一个可用槽位、设置=第一条滑条 */
  private focusDefaultId: string | null = null;
  /** 上一次喂过焦点项的页；与 mode 不同才算换页（页内重建不重落默认焦点） */
  private focusMode: MenuMode | null = null;
  /** 焦点停在滑条上时左右键改走步进（UIFocus 会把左右键当"挪焦点"吃掉，必须先拦） */
  private sliderSteps = new Map<string, (dir: -1 | 1) => void>();
  private onKeyBound: (e: KeyboardEvent) => void;

  constructor(
    renderer: Renderer,
    eventBus: EventBus,
    saveData: ISaveDataProvider,
    audioSettings: IAudioSettingsProvider,
    textSettings: ITextDisplaySettingsProvider,
    strings: StringsProvider,
    devHooks?: MenuDevHooks | null,
  ) {
    this.renderer = renderer;
    this.eventBus = eventBus;
    this.saveData = saveData;
    this.audioSettings = audioSettings;
    this.textSettings = textSettings;
    this.strings = strings;
    this.devHooks = devHooks ?? null;
    this.onKeyBound = (e) => this.onKey(e);
    // 主菜单是全屏页（不走 UIWindow），窗口尺寸变了得自己重排——满屏底色是按 build 时的
    // sw/sh 画死的，不重排就露边。子页的 resize 响应由 UIWindow 自带。
    //
    // ⚠ 订阅只在构造期建立、只在 destroy() 摘除：若改成"每次 build 重订"，回调里重建会在
    //   Renderer 遍历回调 Set 的同一轮里插入新回调 → 同轮被再次访问 → 死循环。
    this.unsubscribeResize = renderer.subscribeAfterResize(() => {
      if (!this._isOpen) return;
      if (this.mode === 'main') { this.build(); return; }
      // 停在标题界面的子页（设置 / 读档）时也要把底图按新屏幕重铺，
      // 否则改窗口大小会露出底图铺不到的黑边。
      if (this.titleBackdrop) {
        this.ensureTitleBackdrop(renderer.screenWidth, renderer.screenHeight);
      }
    });
  }

  get isOpen(): boolean { return this._isOpen; }

  open(): void { this.openPauseMenu(); }

  openMainMenu(): void {
    this._isOpen = true;
    this.mode = 'main';
    // 两条打开路径（标题直开 / 暂停）都要挂键盘导航；同 ref 重复 addEventListener 是 no-op，重开安全
    window.addEventListener('keydown', this.onKeyBound);
    this.build(true);
  }

  openPauseMenu(): void {
    this._isOpen = true;
    this.mode = 'pause';
    window.addEventListener('keydown', this.onKeyBound);
    this.build(true);
  }

  close(): void {
    if (!this._isOpen) return;
    this._isOpen = false;
    window.removeEventListener('keydown', this.onKeyBound);
    this.destroyUI();
    this.focus.destroy();
    this.focusMode = null;
    // 底图跨页存活但**不跨"菜单关闭"**：否则回到游戏里整块主视觉还盖在画面上
    this.dropTitleBackdrop();
  }

  /**
   * 方向键挪焦点、回车/空格激活；焦点停在**滑条**上时左右键改走步进——必须先于
   * `UIFocus.handleKey`（它会把左右键当"挪焦点"消费掉）。
   *
   * 确认框（openConfirmDialog）打开期间在 window capture 阶段吞掉全部键盘事件，
   * 这里天然收不到，无需配合。两级都没吃下的按键**一律不吞**（Esc 归 GameStateController）。
   */
  private onKey(e: KeyboardEvent): void {
    if (!this._isOpen) return;
    const cur = this.focus.current;
    const step = cur ? this.sliderSteps.get(cur.id) : undefined;
    if (step) {
      const dir = e.code === 'ArrowLeft' || e.code === 'KeyA' ? -1
        : e.code === 'ArrowRight' || e.code === 'KeyD' ? 1 : 0;
      if (dir !== 0) {
        step(dir);
        e.preventDefault();
        return;
      }
    }
    if (this.focus.handleKey(e.code)) {
      e.preventDefault();
      return;
    }
    // 存/读页在小画布上列表真的会滚：焦点挪不动的方向键让给滚动区兜底
    const list = this.list;
    if (!list) return;
    const before = list.scrollOffset;
    if (!list.handleKey(e.code)) return;
    if (list.scrollOffset !== before) e.preventDefault();
  }

  /**
   * @param animate 仅"菜单首次打开"为 true。**页间切换（pause↔save↔load↔settings）与
   * 页内重绘（存完档刷新槽位）一律 false**：那些路径同样走 build() 重建窗体，走 `win.open()`
   * 会让每翻一页、每存一次档都重放一遍开场淡入上浮；而漏掉 `attach()` 则整个面板从画面消失。
   */
  private build(animate = false): void {
    this.destroyUI();
    this.focusItems = [];
    this.focusDefaultId = null;
    switch (this.mode) {
      // 全屏页（主菜单/暂停）也吃 animate：`goBack()` 从子页退回暂停页走的是 build()，
      // 无条件淡入会让「暂停→设置→返回」每来回一次就重放一遍暂停页开场。
      case 'main': this.buildMainMenu(animate); break;
      case 'pause': this.buildPauseMenu(animate); break;
      case 'save': this.buildSaveLoadPanel('save', animate); break;
      case 'load': this.buildSaveLoadPanel('load', animate); break;
      case 'settings': this.buildSettings(animate); break;
    }
    // 焦点项整批重喂：页内重建按 id 复位（UIFocus 自己保），换页才重落该页默认焦点
    this.focus.setItems(this.focusItems);
    if (this.focusMode !== this.mode) {
      if (this.focusDefaultId) this.focus.focusDefault(this.focusDefaultId);
      this.focusMode = this.mode;
    }
    // setItems 按同 id 复位时不重放 onFocus（currentId 没变），新一批显示对象拿不到高亮 → 补一次
    this.focus.repaint();
  }

  /**
   * 子页返回：**回到进来时那一页**（主菜单进设置 → 回主菜单；暂停进存档 → 回暂停），
   * 不是恒回暂停页。子页的 ✕ 与「返回」按钮共用这一个出口。
   *
   * ✕ **不能直接 close()**：菜单是 `stateController.registerPanel('menu')` 的成员，
   * 由 escapeFallback 的 `togglePanel('menu')` 压栈打开；在子页自关会把 GameState 与
   * overlayReturnStack 留在不平衡的状态（R11/D3 软锁根因）。真正的退出口只有暂停页的
   * 「继续」（close + `menu:resume` 让 EventBridge 弹栈）与「返回主菜单」，与迁移前一致。
   */
  private goBack(): void {
    this.mode = this.previousMode;
    this.build();
  }

  /**
   * Esc = **退一层**（GameStateController.handleEscape 的面板钩子）：
   * 子页（存/读/设置）退回进来那页；暂停根层交回控制器关面板；
   * 标题根层返回 false 后控制器也无处可关（MainMenu 态不弹栈），Esc 即无操作——正确。
   */
  handleEscapeStep(): boolean {
    if (this.mode === 'save' || this.mode === 'load' || this.mode === 'settings') {
      this.goBack();
      return true;
    }
    return false;
  }

  /** @param animate 保留形参与其它页对齐；主菜单本就无进场动画（冷启即全屏底色），故未使用。 */
  private buildMainMenu(_animate = false): void {
    this.container = new Container();
    const sw = this.renderer.screenWidth;
    const sh = this.renderer.screenHeight;

    // 底图挂**独立常驻层**（不在 this.container 里），见 ensureTitleBackdrop
    this.ensureTitleBackdrop(sw, sh);
    // ⚠ 标题界面**一点不压暗**：主体就是这张主视觉，任何满屏暗角/黑纱都是把美术画的东西
    // 又抹掉一层。文字可读性改由字自己的投影承担（ART_TEXT_SHADOW），画面本身不动。

    // 「新游戏」是主操作，与其余项拉开层级（与暂停页「继续」同一套三级语义）
    const items: MenuItem[] = [
      { label: this.strings.get('menu', 'newGame'), tone: 'primary', action: () => this.eventBus.emit('menu:newGame', {}) },
    ];
    if (this.saveData.hasAnySave()) {
      items.push({ label: this.strings.get('menu', 'continueGame'), action: () => { this.previousMode = this.mode; this.mode = 'load'; this.build(); } });
    }
    items.push({ label: this.strings.get('menu', 'settings'), action: () => { this.previousMode = this.mode; this.mode = 'settings'; this.build(); } });

    const titleText = this.strings.get('menu', 'gameTitle');
    const subtitleText = this.optionalString('gameSubtitle');
    const footerText = this.optionalString('copyright');

    /** 左侧竖基准线：标题、短线、副标题、菜单项四样全部对齐到它 */
    const sideInset = Math.round(sw * TITLE_SIDE_INSET_PCT);

    // ── 标题组：字号按**屏高**定（不是按面板宽倒推），宽了就自己缩，短了就大大方方占位
    const titleLS = UITheme.letterSpacing.display;
    const titleSize = this.fitTitleSize(
      titleText, Math.round(sh * TITLE_SIZE_PCT), titleLS, sw * 0.62,
    );
    const titleW = this.measureTitle(titleText, titleSize, titleLS);
    const titleY = Math.round(sh * TITLE_Y_PCT);
    // `addCenteredTitle` 收的是中心点，这里由「左沿 + 半宽」倒推。
    // ⚠ 半宽要用**可见宽**（减掉末位字距那一格 ls），否则整块标题会比基准线偏右半格。
    const titleH = this.addCenteredTitle(
      this.container, titleText, sideInset + (titleW - titleLS) / 2, titleY, titleSize, titleLS, true,
    );

    // 标题下一道琥珀短线：整屏唯一的装饰，也是「标题」与「副标题」的分界
    const ruleW = Math.round(titleW * TITLE_RULE_W_PCT);
    const rule = new Graphics();
    rule.rect(0, 0, ruleW, 2);
    rule.fill({ color: UITheme.colors.title, alpha: 0.75 });
    rule.position.set(sideInset, titleY + titleH + UITheme.spacing.lg);
    this.container.addChild(rule);

    if (subtitleText) {
      const sub = createStyledText({
        text: subtitleText,
        style: {
          fontSize: UITheme.fontSize.bodyLarge, fill: UITheme.colors.bodyMuted,
          fontFamily: UITheme.fonts.display, letterSpacing: UITheme.letterSpacing.display,
          dropShadow: { ...ART_TEXT_SHADOW },
        },
      });
      sub.x = sideInset;
      sub.y = titleY + titleH + UITheme.spacing.lg + UITheme.spacing.lg;
      this.container.addChild(sub);
    }

    // ── 菜单：无框文字列。**块在"带"里自适应**——带 = 副标题下方到屏底留白之上。
    // 条目少就把字放大占住画面，条目多就自动收，两头都不会顶穿。
    const bandTop = titleY + titleH + UITheme.spacing.xxl * 2;
    const bandBottom = sh - Math.round(sh * TITLE_MENU_BOTTOM_PCT);
    const { font: menuFont, step: menuStep, rowH: menuRowH } =
      this.fitMenuBlock(items.length, Math.max(120, bandBottom - bandTop));

    const blockH = (items.length - 1) * menuStep + menuRowH;
    // 菜单块**从屏底往上码**（"压在左下角"就是这个意思），再夹回带内——
    // 标题很高时带会变窄，夹一下免得块顶到副标题上。
    const rowsY = Math.min(Math.max(bandBottom - blockH, bandTop), bandBottom - blockH);
    // 行宽跟着字号走：命中区要罩得住最长的一条，又不能宽到把左右都占满
    const rowW = Math.round(Math.min(sw * 0.34, menuFont * 9));
    // 左对齐的行在行内自带 xl 内缩，摆位时先把它减回去，文字才正好落在基准线上
    this.buildMenuColumn(
      items, sideInset - UITheme.spacing.xl, rowsY, rowW,
      menuRowH, menuStep - menuRowH, 'bare',
      // 标题界面的条目比面板菜单大一档、也亮一档：它压在主视觉上，得站得住
      { fontSize: menuFont, restColor: UITheme.colors.bodyMuted, shadow: true, align: 'left' },
    );

    // 版权/版本：压右下角，小到不抢戏——现代标题界面这行都在角上
    let footTop = sh - UITheme.spacing.xl;
    if (footerText) {
      const foot = createStyledText({
        text: footerText,
        style: {
          fontSize: UITheme.fontSize.micro, fill: UITheme.colors.hintMid, fontFamily: UITheme.fonts.ui,
          dropShadow: { ...ART_TEXT_SHADOW },
        },
      });
      foot.x = sw - foot.width - UITheme.spacing.xxl;
      foot.y = sh - foot.height - UITheme.spacing.xl;
      footTop = foot.y;
      this.container.addChild(foot);
    }

    // dev 外壳：版权行上面那一小行「[叙事调试：开/关]」。prod 传不进 devHooks，整行不存在。
    this.addNarrativeDebugToggle(sw, footTop);

    this.renderer.uiLayer.addChild(this.container);
  }

  /**
   * 标题界面的常驻底图层。
   *
   * **必须活在 `this.container` 之外**：`build()` 每翻一页（主菜单 → 设置 / 读档）都会
   * `destroyUI()` 重建 container，底图挂在里面就会跟着一起没——于是点「设置」时整张主视觉
   * 消失、半透明遮罩底下透出还在跑的游戏场景（用户报的"点设置会漏出场景"）。
   * 这一层只在**离开标题界面**时才拆（回游戏的暂停页 / 菜单整体关闭），见 dropTitleBackdrop。
   *
   * 层序：底图先挂 uiLayer，各页的 container 之后再挂，天然压在它上面。
   */
  private ensureTitleBackdrop(sw: number, sh: number): void {
    if (this.titleBackdrop && !this.titleBackdrop.destroyed) {
      // 换分辨率/改窗口大小后要重铺（底图是按屏幕尺寸盖满的）
      if (this.titleBackdropSize?.w === sw && this.titleBackdropSize.h === sh) return;
      this.dropTitleBackdrop();
    }
    const layer = new Container();
    layer.eventMode = 'none';
    // 纯色兜底那层永远在：图没到 / 加载失败时它就是背景，绝不白屏
    const bg = new Graphics();
    bg.rect(0, 0, sw, sh);
    bg.fill(UITheme.colors.mainMenuBg);
    layer.addChild(bg);
    const slot = new Container();
    layer.addChild(slot);
    this.loadMainMenuBackdrop(slot, sw, sh);
    this.titleBackdrop = layer;
    this.titleBackdropSize = { w: sw, h: sh };
    // **压到 uiLayer 最底**，不是 addChild：子页停留期间重铺（改窗口大小）时，
    // 当前页的 container 已经在层里了，追加到末尾会把整页盖住。
    this.renderer.uiLayer.addChildAt(layer, 0);
  }

  private dropTitleBackdrop(): void {
    if (this.titleBackdrop && !this.titleBackdrop.destroyed) {
      this.titleBackdrop.destroy({ children: true });
    }
    this.titleBackdrop = null;
    this.titleBackdropSize = null;
  }

  private buildPauseMenu(animate = false): void {
    // 暂停页是**游戏里**的页：标题底图必须撤掉，否则它会把还在跑的世界整个盖住
    this.dropTitleBackdrop();
    this.container = new Container();
    const sw = this.renderer.screenWidth;
    const sh = this.renderer.screenHeight;

    const items: MenuItem[] = [
      { label: this.strings.get('menu', 'resume'), tone: 'primary', action: () => { this.close(); this.eventBus.emit('menu:resume', {}); } },
      { label: this.strings.get('menu', 'save'), action: () => { this.previousMode = this.mode; this.mode = 'save'; this.build(); } },
      { label: this.strings.get('menu', 'load'), action: () => { this.previousMode = this.mode; this.mode = 'load'; this.build(); } },
      { label: this.strings.get('menu', 'settings'), action: () => { this.previousMode = this.mode; this.mode = 'settings'; this.build(); } },
      // 会丢进度的破坏性操作，与「继续」拉开层级——此前五个按钮同宽同色，一模一样。
      // 返回主菜单 = 整页重启丢未存进度（审查 P1 零确认路径之一）：过确认框再走。
      {
        label: this.strings.get('menu', 'returnToMain'), tone: 'danger', action: () => {
          void openConfirmDialog(this.renderer, {
            title: this.strings.get('confirm', 'returnTitle'),
            message: this.strings.get('confirm', 'returnBody'),
            confirmLabel: this.strings.get('confirm', 'ok'),
            cancelLabel: this.strings.get('confirm', 'cancel'),
          }).then((ok) => {
            if (!ok) return;
            this.close();
            this.eventBus.emit('menu:returnToMain', {});
          });
        },
      },
    ];

    const titleText = this.strings.get('menu', 'pause');
    const titleLS = UITheme.letterSpacing.display;
    const titleW = this.measureTitle(titleText, UITheme.fontSize.display, titleLS);
    const titleH = Math.round(UITheme.fontSize.display * 1.3);
    const rowsH = items.length * (PAUSE_ROW_H + PAUSE_ROW_GAP) - PAUSE_ROW_GAP;

    // 标题下方一条渐隐横线（设计稿 11：标题两侧空、只有下面这一条），再往下才是条目
    const topBlockH = BOARD_PAD + titleH + UITheme.spacing.md + 1;
    const naturalH = topBlockH + UITheme.spacing.xxl + rowsH + BOARD_PAD;

    const { w: boardW, h: boardH } = this.boardSize(
      sw, sh, naturalH, BOARD_PAUSE_RATIO, BOARD_PAUSE_H_PCT,
      Math.max(titleW, this.widestLabel(items)) + BOARD_PAD * 2,
    );
    const px = Math.round((sw - boardW) / 2);
    const py = Math.round((sh - boardH) / 2);

    const overlay = new Graphics();
    overlay.rect(0, 0, sw, sh);
    overlay.fill({ color: UITheme.colors.overlay, alpha: UITheme.alpha.overlayDark });
    this.container.addChild(overlay);

    // 暂停菜单此前**没有窗体**，五个按钮直接浮在半透明世界上（存档/读档/设置子页却有窗体，
    // 同一文件内不自洽）。这里补上，与其余面板同一套皮肤——木框 + 内金线走 createPanel。
    this.container.addChild(createPanel(px, py, boardW, boardH, SKINS.menu));

    this.addCenteredTitle(this.container, titleText, px + boardW / 2, py + BOARD_PAD, UITheme.fontSize.display, titleLS);
    const rule = createRule(boardW - BOARD_PAD * 2);
    rule.position.set(px + BOARD_PAD, py + BOARD_PAD + titleH + UITheme.spacing.md);
    this.container.addChild(rule);

    const rowH = this.stretchRowHeight(boardH, topBlockH, BOARD_PAD, items.length, PAUSE_ROW_GAP, PAUSE_ROW_H, PAUSE_ROW_H_MAX);
    const laidRowsH = items.length * (rowH + PAUSE_ROW_GAP) - PAUSE_ROW_GAP;
    const rowsY = this.blockYAt(py, boardH, PAUSE_ROWS_CENTER_PCT, laidRowsH, topBlockH, BOARD_PAD);
    this.buildMenuColumn(items, px + PAUSE_BAND_INSET, rowsY, boardW - PAUSE_BAND_INSET * 2, rowH, PAUSE_ROW_GAP, 'band');

    this.renderer.uiLayer.addChild(this.container);
    if (animate) fadeIn(this.container);
  }

  /**
   * 存档 / 读档页。改走 {@link UIWindow}（遮罩+底框+标题栏+✕+分隔线+居中+resize 响应）
   * ＋每个槽位一行列表行——迁移前槽位是"裸 Graphics 挂 pointerdown"，
   * 没有 hover、没有按下反馈、读档时的空槽只是"点了没反应"（没有灰态）。
   */
  private buildSaveLoadPanel(action: 'save' | 'load', animate: boolean): void {
    const metas: (SaveSlotMeta | null)[] = [];
    for (let i = 0; i < SLOT_COUNT; i++) metas.push(this.saveData.getSlotMeta(i));

    const win = new UIWindow(this.renderer, {
      size: { width: this.saveLoadWidth(metas), height: this.saveLoadHeight() },
      title: action === 'save' ? this.strings.get('menu', 'save') : this.strings.get('menu', 'load'),
      // 迁移前这两页自己铺的是 overlayDark，比 UIWindow 缺省的 overlay 浓一档，照旧
      dimAlpha: UITheme.alpha.overlayDark,
      onClose: () => this.goBack(),
    });
    this.win = win;

    // 槽位数固定为 3、窗高按内容反推，正常分辨率下滚不动；小画布（F2 调试坞挤压
    // #game-mount）时窗体被夹到屏幕高，这里才真的滚起来——迁移前是直接溢出屏幕。
    const list = new UIScrollView(this.renderer, {
      width: win.bodyWidth,
      height: Math.max(SLOT_H, win.bodyHeight - FOOTER_H),
      // 不能给底部留白：`listH` 已经扣掉了尾隙（`n*(SLOT_H+GAP) - GAP`），
      // 再加一份就等于把 SLOT_GAP 算了两次 → 内容高比视口高出约 8px，
      // 三个槽位明明放得下却常驻一根几乎占满轨道的滚动条、列表还能抖 8px。
      bottomPadding: 0,
    });
    list.container.position.set(0, 0);
    win.body.addChild(list.container);
    this.list = list;

    const rowW = win.bodyWidth - UITheme.spacing.sm;   // 右侧留出滚动条的道
    const jsonX = rowW - JSON_COL_W;
    const slotW = jsonX - UITheme.spacing.sm;

    metas.forEach((meta, i) => {
      const ry = i * (SLOT_H + SLOT_GAP);
      const disabled = action === 'load' && meta === null;
      const slot = this.makeMenuRow({
        // 两级层级：主行场景名（暖白，选中提到琥珀）+ 右侧「第 N 天」，副行时间·时长。
        // 空槽仍是单行「槽位 N: (空)」灰态（不给 sub 就走单行版式）。
        label: meta ? meta.sceneName : this.strings.get('menu', 'slotEmpty', { slot: i + 1 }),
        trailing: meta ? this.strings.get('menu', 'slotDay', { day: meta.dayNumber }) : undefined,
        sub: meta ? this.slotSubLabel(meta) : undefined,
        width: slotW,
        height: SLOT_H,
        style: 'box',
        align: 'left',
        font: 'ui',
        fontSize: UITheme.fontSize.bodyLarge,
        textColor: meta ? UITheme.colors.bookLabel : UITheme.colors.descText,
        // 读档页的空槽不可点：迁移前是"不挂 pointerdown"，语义相同，多了灰态
        disabled,
        onHover: () => this.focus.syncHover(`slot:${i}`),
        onPress: () => this.commitSlot(action, i),
      });
      slot.container.position.set(0, ry);
      list.content.addChild(slot.container);

      // 槽位行自成一组（JSON 链另一组）：上下键在槽位间走，左右键才跨到本行的文字链，
      // 不会出现"下键从槽位 1 跳进槽位 1 的导出链"这种乱序
      this.focusItems.push({
        id: `slot:${i}`,
        x: 0, y: ry, w: slotW, h: SLOT_H,
        group: 'slots',
        disabled,
        // 焦点高亮 = 行原有的选中重绘通道；小画布上列表真的会滚，焦点行要滚进视口
        onFocus: (on, via) => { slot.setActive(on && via === 'key'); if (on && via === 'key') this.revealSlot(ry); },
        onActivate: () => this.commitSlot(action, i),
      });

      // JSON 导入/导出仍是文字链（不是主操作，做成按钮会与槽位抢视觉），但两行必须错开摆
      const mid = ry + SLOT_H / 2;
      if (meta) {
        this.addJsonLink(list.content, 'JSON ↓', jsonX, mid - UITheme.spacing.md, () => this.exportSaveFile(i), `json:down:${i}`);
        this.addJsonLink(list.content, 'JSON ↑', jsonX, mid + UITheme.spacing.md, () => this.importSaveFile(i), `json:up:${i}`);
      } else {
        // 空槽没得导出，导入链居中——迁移前空槽也照画两行位，上面那行是空的
        this.addJsonLink(list.content, 'JSON ↑', jsonX, mid, () => this.importSaveFile(i), `json:up:${i}`);
      }
    });
    list.refresh();

    // 默认焦点 = 第一个可用槽位：存档页全可用，读档页跳过空槽（disabled 的行不吃焦点）
    const firstUsable = metas.findIndex(m => action === 'save' || m !== null);
    if (firstUsable >= 0) this.focusDefaultId = `slot:${firstUsable}`;

    this.addBackButton(win);

    if (animate) win.open();
    else win.attach();
  }

  /** 焦点落到视口外的槽位行时滚进来（正常分辨率下滚不动，小画布被挤压时才起作用）。 */
  private revealSlot(top: number): void {
    const list = this.list;
    if (!list) return;
    const bottom = top + SLOT_H;
    if (top < list.scrollOffset) list.scrollOffset = top;
    else if (bottom > list.scrollOffset + list.viewportHeight) {
      list.scrollOffset = bottom - list.viewportHeight;
    }
  }

  /** 槽位副行：保存日期时间 + 游玩时长（模板在 strings，格式化留代码） */
  private slotSubLabel(meta: SaveSlotMeta): string {
    const d = new Date(meta.timestamp);
    const date = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return this.strings.get('menu', 'slotSub', { date, minutes: Math.floor(meta.playTimeMs / 60000) });
  }

  /** 量一行 ui 字族文案的宽（窗宽反推用；样式须与槽位行里实际那份一致） */
  private measureUiText(text: string, fontSize: number): number {
    const probe = createStyledText({ text, style: { fontSize, fontFamily: UITheme.fonts.ui } });
    const w = probe.width;
    probe.destroy();
    return w;
  }

  /**
   * 窗宽按最宽的一行槽位内容反推（与 ShopUI/QuestPanelUI 的"按内容反推尺寸"同一手法）。
   * 两行版式下取「主行（场景名 + 第 N 天）」与「副行（时间·时长）」里较宽的一条；
   * 空槽量它那句「(空)」。槽位行的文字不折行，写死 400 宽在场景名一长时必挤出按钮。
   */
  private saveLoadWidth(metas: (SaveSlotMeta | null)[]): number {
    let textW = 0;
    metas.forEach((meta, i) => {
      if (!meta) {
        textW = Math.max(textW, this.measureUiText(
          this.strings.get('menu', 'slotEmpty', { slot: i + 1 }), UITheme.fontSize.bodyLarge,
        ));
        return;
      }
      const mainW = this.measureUiText(meta.sceneName, UITheme.fontSize.bodyLarge)
        + UITheme.spacing.lg
        + this.measureUiText(this.strings.get('menu', 'slotDay', { day: meta.dayNumber }), UITheme.fontSize.small);
      const subW = this.measureUiText(this.slotSubLabel(meta), UITheme.fontSize.small);
      textW = Math.max(textW, mainW, subW);
    });
    const desired = textW
      + UITheme.spacing.xl * 2      // 槽位行左右留白
      + UITheme.spacing.sm * 2      // 滚动条道 + 槽位与 JSON 列的间隙
      + JSON_COL_W
      + UITheme.spacing.xl * 2;     // 窗体内边距
    const maxW = this.renderer.screenWidth - UITheme.spacing.xl * 2;
    return Math.round(Math.min(Math.max(WINDOW_SIZES.sm.width, desired), maxW));
  }

  private saveLoadHeight(): number {
    const listH = SLOT_COUNT * (SLOT_H + SLOT_GAP) - SLOT_GAP;
    const maxH = this.renderer.screenHeight - UITheme.spacing.xl * 2;
    return Math.round(Math.min(listH + FOOTER_H + WINDOW_CHROME_H, maxH));
  }

  /** @param centerY 链接文字的垂直中心（行高随字号变，按中心摆才不会两行黏一起） */
  /**
   * 标题界面右下角的 dev 小开关：勾上就带叙事调试进这一局。
   *
   * 刻意做成"版权行上面一行小字"而不是菜单项：菜单那一列是玩家的东西
   * （制作人定调标题界面是一张海报），这行只有 dev 外壳才看得见。
   *
   * 点了只改自己这行文案，**不重建整页**——重建会把主视觉、标题、菜单全部重画一遍。
   */
  private addNarrativeDebugToggle(sw: number, footTop: number): void {
    const hooks = this.devHooks;
    if (!hooks || !this.container) return;
    const label = (on: boolean): string => `[叙事调试：${on ? '开' : '关'}]`;
    const paint = (text: Text, on: boolean): void => {
      text.text = label(on);
      text.style.fill = on ? UITheme.colors.title : UITheme.colors.hintMid;
      text.x = sw - text.width - UITheme.spacing.xxl;
    };
    const link = createStyledText({
      text: label(hooks.isNarrativeDebugOn()),
      style: {
        fontSize: UITheme.fontSize.micro, fill: UITheme.colors.hintMid, fontFamily: UITheme.fonts.ui,
        dropShadow: { ...ART_TEXT_SHADOW },
      },
    });
    link.y = Math.round(footTop - link.height - UITheme.spacing.sm);
    paint(link, hooks.isNarrativeDebugOn());
    link.eventMode = 'static';
    link.cursor = 'pointer';
    link.on('pointerdown', (e) => {
      // 与 addJsonLink 同理：不标记的话这一下会顺着原生事件继续推进到别的监听
      markPointerConsumed((e as { nativeEvent?: unknown }).nativeEvent);
      const next = !hooks.isNarrativeDebugOn();
      hooks.setNarrativeDebugOn(next);
      // 以运行时真值回读（开不起来时不能显示成"开"）
      paint(link, hooks.isNarrativeDebugOn());
    });
    this.devToggleRepaint = () => {
      if (link.destroyed) return;
      paint(link, hooks.isNarrativeDebugOn());
    };
    this.container.addChild(link);
  }

  /**
   * 让标题界面那行 dev 小开关重新读一次真值。
   *
   * 用在"开关不是从这行点出来的"那几路：工程文件里的勾是异步读回来的、控制台
   * `__ndbg.on()` 也可能刚开过——不重画的话这行会一直写着「关」，而调试其实开着。
   */
  refreshDevToggle(): void {
    this.devToggleRepaint?.();
  }

  private addJsonLink(parent: Container, text: string, x: number, centerY: number, onPress: () => void, focusId: string): void {
    const link = createStyledText({
      text,
      // 迁移期沿用的旧 link 档是 0x8888aa 的冷蓝，在整屏暖木配色里是唯一一处蓝调；
      // 收进暗金，hover 才提到 title（批2a 已删 link 键，交互色归琥珀族 goldDim）。
      style: { fontSize: UITheme.fontSize.micro, fill: UITheme.colors.goldDim, fontFamily: UITheme.fonts.ui },
    });
    link.x = x;
    link.y = Math.round(centerY - link.height / 2);
    link.eventMode = 'static';
    link.cursor = 'pointer';
    link.on('pointerover', () => { link.style.fill = UITheme.colors.title; this.focus.syncHover(focusId); });
    link.on('pointerout', () => this.focus.clearHover(focusId));
    link.on('pointerout', () => this.focus.clearHover(focusId));
    // 移开时**只在焦点不在它身上**才复原：抹掉就等于屏幕上没有焦点了
    link.on('pointerout', () => { if (this.focus.current?.id !== focusId) link.style.fill = UITheme.colors.goldDim; });
    link.on('pointerdown', (e) => {
      // 同一次原生事件随后还会到达挂在 window 上的推进监听，不标记会"点导出顺便推进剧情"
      markPointerConsumed((e as { nativeEvent?: unknown }).nativeEvent);
      onPress();
    });
    parent.addChild(link);
    // 文字链自成一组：与槽位同组的话，上下键会在槽位与链之间乱跳（混排面板的通病）
    this.focusItems.push({
      id: focusId,
      x, y: link.y, w: link.width, h: link.height,
      group: 'json',
      // 焦点高亮 = 链自己的 hover 画法（goldDim 提到 title）
      onFocus: (on) => { if (!link.destroyed) link.style.fill = on ? UITheme.colors.title : UITheme.colors.goldDim; },
      onActivate: onPress,
    });
  }

  /** 子页底部的「[返回]」。与 ✕ 同一个出口（goBack），文案带方括号是本项目"可点"的视觉约定。 */
  private addBackButton(win: UIWindow): void {
    const back = new UIButton({
      label: this.strings.get('menu', 'back'),
      width: BACK_BTN_W,
      height: BACK_BTN_H,
      variant: 'secondary',
      onPress: () => this.goBack(),
    });
    const bx = Math.round((win.bodyWidth - BACK_BTN_W) / 2);
    const by = Math.round(win.bodyHeight - BACK_BTN_H);
    back.container.position.set(bx, by);
    back.container.on('pointerover', () => this.focus.syncHover('back'));
    back.container.on('pointerout', () => this.focus.clearHover('back'));
    win.body.addChild(back.container);
    // 返回自成一组（footer）：从槽位/设置列往下走到底才落到它，不与内容行抢上下键
    this.focusItems.push({
      id: 'back',
      x: bx, y: by, w: BACK_BTN_W, h: BACK_BTN_H,
      group: 'footer',
      // 焦点高亮 = UIButton 自己的常驻选中态
      onFocus: (on, via) => back.setSelected(on && via === 'key'),
      onActivate: () => this.goBack(),
    });
  }

  /** 点槽位：存档就地刷新槽位（走 build() → attach，不重放开场动画），读档成功才关菜单。
   *  覆盖已有存档 / 游戏中读档都是不可逆操作（审查 P1 零确认路径），先过确认框。 */
  private commitSlot(action: 'save' | 'load', slot: number): void {
    if (action === 'save') {
      const doSave = (): void => {
        const ok = this.saveData.save(slot);
        this.eventBus.emit('notification:show', {
          text: ok
            ? this.strings.get('menu', 'saveSlot', { slot: slot + 1 })
            : this.strings.get('menu', 'saveFailed'),
          type: ok ? 'info' : 'error',
        });
        this.build();
      };
      if (this.saveData.hasSave(slot)) {
        void openConfirmDialog(this.renderer, {
          title: this.strings.get('confirm', 'overwriteTitle'),
          message: this.strings.get('confirm', 'overwriteBody', { slot: String(slot + 1) }),
          confirmLabel: this.strings.get('confirm', 'ok'),
          cancelLabel: this.strings.get('confirm', 'cancel'),
        }).then((ok) => { if (ok) doSave(); });
      } else {
        doSave();
      }
      return;
    }
    const doLoad = (): void => {
      this.saveData.load(slot).then((ok) => {
        if (ok) {
          this.close();
          this.eventBus.emit('notification:show', {
            text: this.strings.get('menu', 'loadSlot', { slot: slot + 1 }),
            type: 'info',
          });
        } else {
          // 读档失败：SaveManager 已回滚到读档前状态，留在面板让玩家换槽位重试
          this.eventBus.emit('notification:show', {
            text: this.strings.get('menu', 'loadFailed'),
            type: 'error',
          });
        }
      });
    };
    // 标题页「继续」进来的读档没有会丢的进度，不拦；暂停页进来的读档会丢当前局，要确认
    if (this.previousMode === 'pause') {
      void openConfirmDialog(this.renderer, {
        title: this.strings.get('confirm', 'loadTitle'),
        message: this.strings.get('confirm', 'loadBody'),
        confirmLabel: this.strings.get('confirm', 'ok'),
        cancelLabel: this.strings.get('confirm', 'cancel'),
      }).then((ok) => { if (ok) doLoad(); });
    } else {
      doLoad();
    }
  }

  private exportSaveFile(slot: number): void {
    const raw = this.saveData.exportSlotPayload(slot);
    if (!raw) {
      this.eventBus.emit('notification:show', { text: this.strings.get('menu', 'saveFailed'), type: 'error' });
      return;
    }
    const blob = new Blob([raw.endsWith('\n') ? raw : raw + '\n'], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `gamedraft_save_${slot + 1}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  private importSaveFile(slot: number): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.style.display = 'none';
    input.onchange = async () => {
      const file = input.files?.[0];
      const ok = file ? this.saveData.importSlotPayload(slot, await file.text()) : false;
      input.remove();
      this.eventBus.emit('notification:show', {
        text: ok ? this.strings.get('menu', 'loadSlot', { slot: slot + 1 }) : this.strings.get('menu', 'loadFailed'),
        type: ok ? 'info' : 'error',
      });
      if (ok) this.build();
    };
    document.body.appendChild(input);
    input.click();
  }

  /** 设置页。窗体走 {@link UIWindow}；音量/速度滑条是组件层没有的件，保留手写（见 drawSlider）。 */
  private buildSettings(animate: boolean): void {
    const channels: { label: string; channel: AudioChannel }[] = [
      { label: this.strings.get('menu', 'bgm'), channel: 'bgm' },
      { label: this.strings.get('menu', 'sfx'), channel: 'sfx' },
      { label: this.strings.get('menu', 'ambient'), channel: 'ambient' },
      // 对白单独一条：玩家把音效压低时台词必须还听得见
      { label: this.strings.get('menu', 'voice'), channel: 'voice' },
    ];
    /** 行数 = 四条音量 + 「逐字显示」开关 + 「文字速度」滑条；窗高按它反推 */
    const rowCount = channels.length + 2;

    const win = new UIWindow(this.renderer, {
      size: {
        width: Math.round(Math.min(WINDOW_SIZES.sm.width, this.renderer.screenWidth - UITheme.spacing.xl * 2)),
        height: Math.round(Math.min(
          rowCount * SETTING_ROW_H + FOOTER_H + WINDOW_CHROME_H,
          this.renderer.screenHeight - UITheme.spacing.xl * 2,
        )),
      },
      title: this.strings.get('menu', 'settings'),
      dimAlpha: UITheme.alpha.overlayDark,
      onClose: () => this.goBack(),
    });
    this.win = win;

    const controlX = CHANNEL_LABEL_W;
    const sliderW = Math.max(
      HANDLE_R * 4,
      win.bodyWidth - CHANNEL_LABEL_W - PCT_COL_W - UITheme.spacing.md,
    );
    const rowCenterY = (idx: number): number => idx * SETTING_ROW_H + SETTING_ROW_H / 2;

    // 行与行之间一条两端渐隐的细线：设计稿里同栏多行都靠这条线断句，不靠间距硬撑
    const addSeparator = (idx: number): void => {
      if (idx === 0) return;
      const sep = createRule(win.bodyWidth);
      sep.position.set(0, Math.round(idx * SETTING_ROW_H));
      sep.alpha = 0.5;
      win.body.addChild(sep);
    };

    /** @param dim 该行整行不可用时压暗（现在只有"逐字显示关掉后的速度行"用得上） */
    const addLabel = (text: string, idx: number, dim = false): void => {
      const labelT = createStyledText({
        text,
        style: {
          // 迁移期这里是旧 subtle 档（0xaaaacc 冷蓝灰），整块设置页因此偏冷；改暖正文色
          fontSize: UITheme.fontSize.body,
          fill: dim ? UITheme.colors.hintMid : UITheme.colors.bodyMuted,
          fontFamily: UITheme.fonts.ui,
          wordWrap: true, breakWords: true, wordWrapWidth: CHANNEL_LABEL_W - UITheme.spacing.md,
        },
      });
      labelT.x = 0;
      // 迁移前标签顶对齐滑条的"行顶"，视觉上比滑条高半档；改成与滑条同一条中线
      labelT.y = Math.round(rowCenterY(idx) - labelT.height / 2);
      win.body.addChild(labelT);
    };

    channels.forEach(({ label, channel }, idx) => {
      addSeparator(idx);
      addLabel(label, idx);
      this.drawSlider(win.body, controlX, rowCenterY(idx), sliderW, this.audioSettings.getVolume(channel), (v) => {
        this.audioSettings.setVolume(channel, v);
      }, {
        focusId: `slider:${channel}`,
        // 松手试听：音效那条通道在设置页里本来是全哑的，不放一声玩家就是在盲调
        onSettle: () => this.audioSettings.previewVolume(channel),
      });
    });

    // ── 逐字显示（打字机）：一行开关 + 一行速度。
    // 关掉时速度那行**整行压暗且点不动**——留一个"拖了没反应"的活滑条比少一行更糟。
    const typewriterIdx = channels.length;
    const speedIdx = typewriterIdx + 1;
    const typewriterOn = this.textSettings.isTypewriterEnabled();

    addSeparator(typewriterIdx);
    addLabel(this.strings.get('menu', 'typewriter'), typewriterIdx);
    // 点按/回车共用同一个执行体。整页重建：按钮文案与速度行的压暗都跟着开关走。
    // build() 走 attach()，不会重放窗体开场动效（见 build 的 animate 注释）；
    // 焦点按 id（toggle:typewriter）复位，回车切开关后焦点仍停在开关上。
    const toggleTypewriter = (): void => {
      this.textSettings.setTypewriterEnabled(!typewriterOn);
      this.build();
    };
    const toggle = new UIButton({
      label: this.strings.get('menu', typewriterOn ? 'toggleOn' : 'toggleOff'),
      width: TOGGLE_BTN_W,
      height: TOGGLE_BTN_H,
      // 开着时按主操作那一档（亮），关掉退成次要——一眼看出当前是哪个态
      variant: typewriterOn ? 'primary' : 'secondary',
      onPress: toggleTypewriter,
    });
    const toggleY = Math.round(rowCenterY(typewriterIdx) - TOGGLE_BTN_H / 2);
    toggle.container.position.set(controlX, toggleY);
    toggle.container.on('pointerover', () => this.focus.syncHover('toggle:typewriter'));
    toggle.container.on('pointerout', () => this.focus.clearHover('toggle:typewriter'));
    win.body.addChild(toggle.container);
    this.focusItems.push({
      id: 'toggle:typewriter',
      x: controlX, y: toggleY, w: TOGGLE_BTN_W, h: TOGGLE_BTN_H,
      group: 'settings',
      // 焦点高亮 = UIButton 自己的常驻选中态
      onFocus: (on, via) => toggle.setSelected(on && via === 'key'),
      onActivate: toggleTypewriter,
    });

    addSeparator(speedIdx);
    addLabel(this.strings.get('menu', 'textSpeed'), speedIdx, !typewriterOn);
    this.drawSlider(
      win.body, controlX, rowCenterY(speedIdx), sliderW,
      typewriterScaleToSlider(this.textSettings.getTypewriterSpeedScale()),
      (v) => this.textSettings.setTypewriterSpeedScale(sliderToTypewriterScale(v)),
      {
        disabled: !typewriterOn,
        focusId: 'slider:speed',
        // 显示的是**速度倍率**（100% = 对白框/遭遇框各自的基准速度），不是滑条位置——
        // 两者之间是几何映射（1× 落在轨道正中），直接拿 v 当百分比会写出 50%
        format: (v) => `${Math.round(sliderToTypewriterScale(v) * 100)}%`,
      },
    );

    // 默认焦点落第一个控件（第一条音量滑条）
    this.focusDefaultId = `slider:${channels[0].channel}`;

    this.addBackButton(win);

    if (animate) win.open();
    else win.attach();
  }

  /**
   * 音量滑条：**保留手写**——组件层没有滑条件，而滑条是"拖拽 + window 级跟随 + 实时回写"
   * 的连续控件，不是离散点击件。配色/字号/间距改走令牌，行为一字未改。
   *
   * 观感上跟着设计稿收方：轨道与已填段都是**方正无圆角**（与 createProgressBar 同口径），
   * 只有滑块保留圆形——它是要被手指/光标抓的把手，方块反而不好认。
   *
   * @param parent 挂载容器（现在是 `win.body`，原点 = 内容区左上角）
   * @param x      滑条左端（parent 局部坐标）
   * @param centerY 滑条中线（parent 局部坐标）
   * @param opts.format 右侧数值列的文案（缺省按百分比读滑条位置）。滑条位置与真实取值
   *   不是同一个量时（如速度倍率走几何映射）必须给，否则数值列会写出另一套数。
   * @param opts.disabled 整条压暗且不挂任何交互（本行的前置开关关着时用）
   * @param opts.focusId 给了就进键盘焦点环：焦点在滑条上时左右键按量程 1/10 步进
   *   （onKey 在 UIFocus 之前拦，否则左右键被当"挪焦点"吃掉）。滑条没有 hover 视觉，
   *   焦点视觉与 JSON 文字链同一套语言——滑块/数值点亮到 title，不另发明高亮。
   */
  private drawSlider(
    parent: Container,
    x: number,
    centerY: number,
    width: number,
    value: number,
    onChange: (v: number) => void,
    opts?: {
      format?: (v: number) => string;
      disabled?: boolean;
      focusId?: string;
      /**
       * 值**停下来**时回调一次（松开拖拽 / 点一下轨道 / 键盘步进停手 250ms 后）。
       * 与 `onChange` 的分工：onChange 是"正在变"（每一像素都要回写，否则拖着没反应），
       * onSettle 是"调完了"——试听声只能挂在这一头，挂 onChange 上会拖出一串机关枪。
       */
      onSettle?: (v: number) => void;
    },
  ): void {
    const trackY = centerY - TRACK_H / 2;
    const disabled = opts?.disabled === true;
    const format = opts?.format ?? ((v: number) => `${Math.round(v * 100)}%`);
    // 当前值/焦点态：拖拽与键盘步进共用一份，重绘三件套（fill/handle/pct）都从这读
    let current = Math.max(0, Math.min(1, value));
    let focused = false;

    const track = new Graphics();
    track.rect(x, trackY, width, TRACK_H);
    track.fill(UITheme.colors.sliderTrack);
    track.rect(x, trackY, width, TRACK_H);
    track.stroke({ color: UITheme.colors.borderSubtle, width: 1 });
    parent.addChild(track);

    const fill = new Graphics();
    const drawFill = (v: number) => {
      fill.clear();
      if (v <= 0) return;
      fill.rect(x, trackY, width * v, TRACK_H);
      fill.fill(disabled ? UITheme.colors.borderSubtle : UITheme.colors.sliderFill);
    };
    drawFill(current);
    parent.addChild(fill);

    const handle = new Graphics();
    const drawHandle = (v: number) => {
      handle.clear();
      handle.circle(x + width * v, centerY, HANDLE_R);
      handle.fill(disabled ? UITheme.colors.hintMid : focused ? UITheme.colors.title : UITheme.colors.sliderHandle);
      handle.circle(x + width * v, centerY, HANDLE_R);
      handle.stroke({ color: disabled ? UITheme.colors.borderSubtle : UITheme.colors.borderSelected, width: 1 });
    };
    drawHandle(current);
    parent.addChild(handle);

    const pct = createStyledText({
      text: format(current),
      style: {
        // 数值跟着滑块走暖金，别再用旧 section 档的冷灰（该档已并入 hintMid）
        fontSize: UITheme.fontSize.small,
        fill: disabled ? UITheme.colors.hintMid : UITheme.colors.goldDim,
        fontFamily: UITheme.fonts.ui,
        wordWrap: true, breakWords: true, wordWrapWidth: PCT_COL_W,
      },
    });
    pct.x = x + width + UITheme.spacing.md;
    pct.y = Math.round(centerY - pct.height / 2);
    parent.addChild(pct);

    // 拖拽 / 键盘步进共同的收口：夹值 → 回写 setter → 重绘三件套
    const applyValue = (v: number) => {
      current = Math.max(0, Math.min(1, v));
      onChange(current);
      drawFill(current);
      drawHandle(current);
      pct.text = format(current);
    };

    /**
     * 「停下了」的收口。键盘步进要防抖：按住方向键是一串连发的 keydown，
     * 每一下都试听就成了机关枪；等手停 250ms 再放一声。拖拽路径由 pointerup 直接触发。
     */
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    const cancelSettle = (): void => {
      if (settleTimer === null) return;
      clearTimeout(settleTimer);
      settleTimer = null;
    };
    const settleNow = (): void => {
      cancelSettle();
      opts?.onSettle?.(current);
    };
    const settleSoon = (): void => {
      cancelSettle();
      settleTimer = setTimeout(() => { settleTimer = null; opts?.onSettle?.(current); }, SLIDER_SETTLE_MS);
    };
    // 面板拆除时把在途的防抖表一并停掉（与拖拽的 window 监听同一个清理集合）：
    // 尸体面板绝不许在关掉之后再冒出一声
    if (opts?.onSettle) this.sliderDragCleanups.add(cancelSettle);

    if (opts?.focusId !== undefined && !disabled) {
      const id = opts.focusId;
      // 左右键步进注册表（onKey 里先于 UIFocus 查它）；量程固定 [0,1]，步进 1/10
      this.sliderSteps.set(id, (dir) => { applyValue(current + dir * SLIDER_KEY_STEP); settleSoon(); });
      track.on('pointerover', () => this.focus.syncHover(id));
      track.on('pointerout', () => this.focus.clearHover(id));
      handle.on('pointerover', () => this.focus.syncHover(id));
      handle.on('pointerout', () => this.focus.clearHover(id));
      this.focusItems.push({
        id,
        x, y: Math.round(centerY - SETTING_ROW_H / 2), w: width, h: SETTING_ROW_H,
        group: 'settings',
        onFocus: (on) => {
          focused = on;
          if (!handle.destroyed) drawHandle(current);
          if (!pct.destroyed) pct.style.fill = on ? UITheme.colors.title : UITheme.colors.goldDim;
        },
        // 滑条没有"激活"这回事：回车在它身上不吃键（onActivate 缺省即让键）
      });
    }

    // 压暗态到此为止：不挂 eventMode / 不挂 window 级拖拽，点它、拖它都不动（焦点也不注册）
    if (disabled) return;

    let dragging = false;
    /**
     * 指针位置是画布全局坐标，而滑条现在挂在 `win.body` 里（原点被窗体挪到内容区左上角）。
     * 必须 `toLocal` 换算回父容器坐标系——直接拿全局 x 减 `x` 会整条偏掉一个面板边距。
     */
    const updateValue = (globalX: number) => {
      const localX = parent.toLocal({ x: globalX, y: 0 }).x;
      applyValue((localX - x) / width);
    };

    // 拖拽跟随的是 window 级 PointerEvent，clientX 在画布被 CSS 缩放时与逻辑坐标不同系，须换算
    const onMove = (e: PointerEvent) => { if (dragging) updateValue(clientToCanvas(this.renderer, e.clientX, e.clientY).x); };
    const onUp = () => {
      const wasDragging = dragging;
      dragging = false;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      this.sliderDragCleanups.delete(onUp);
      // 松手 = 调完了，按新音量放一声。**只在真的拖过时响**：
      // 这个 onUp 也会被 sliderDragCleanups 在拆面板时调用，那条路径不该出声。
      if (wasDragging) settleNow();
    };

    track.eventMode = 'static';
    track.cursor = 'pointer';
    handle.eventMode = 'static';
    handle.cursor = 'pointer';

    const startDrag = (e: FederatedPointerEvent) => {
      // 与其它行内控件同规矩：标记本次原生事件已消费，免得 window 级监听再吃一次
      markPointerConsumed(e.nativeEvent);
      dragging = true;
      updateValue(e.global.x);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      this.sliderDragCleanups.add(onUp);
    };
    track.on('pointerdown', startDrag);
    handle.on('pointerdown', startDrag);
  }

  /**
   * 竖排菜单列。**设计稿里恒有一个"当前项"整条铺着琥珀暖光**（主菜单 02、暂停 11 都是），
   * 没有它这套观感就只剩一块暗板；所以这里维护一个当前项下标：默认落在主操作那一项，
   * 指针划过哪一项就移到哪一项（移出不熄灭，与手柄/键盘式菜单的手感一致）。
   *
   * 这只是"当前高亮在谁身上"的视觉状态：点击仍然只由 pointerup 触发，
   * 高亮不参与任何跳转/确认逻辑。
   */
  private buildMenuColumn(
    items: MenuItem[],
    x: number,
    y: number,
    width: number,
    rowH: number,
    gap: number,
    style: 'box' | 'band' | 'bare',
    /** 覆盖字号/静息字色。标题界面的条目比面板里的菜单项更大更亮（它是海报，不是列表） */
    override?: { fontSize?: number; restColor?: number; shadow?: boolean; align?: 'center' | 'left' },
  ): void {
    const rows: MenuRowHandle[] = [];
    const setActive = (i: number): void => rows.forEach((r, k) => r.setActive(k === i));

    items.forEach((item, i) => {
      const row = this.makeMenuRow({
        label: item.label,
        width,
        height: rowH,
        style,
        fontSize: override?.fontSize ?? UITheme.fontSize.title,
        letterSpacing: UITheme.letterSpacing.title,
        textColor: override?.restColor ?? this.toneColor(item.tone),
        shadow: override?.shadow,
        align: override?.align,
        // 悬停即移焦：鼠标与键盘共用同一个"当前项"，高亮统一由 onFocus 驱动 setActive
        onHover: () => this.focus.syncHover(`row:${i}`),
        onPress: item.action,
      });
      row.container.position.set(x, y + i * (rowH + gap));
      this.container!.addChild(row.container);
      rows.push(row);
      this.focusItems.push({
        id: `row:${i}`,
        x, y: y + i * (rowH + gap), w: width, h: rowH,
        group: 'menu',
        // 焦点高亮 = 行原有的"当前项"通道（setActive 互斥点亮），不另发明第三种高亮；
        // 失焦不用管——本页只有这一列，下一项的 setActive 会把这行熄掉
        onFocus: (on) => { if (on) setActive(i); },
        onActivate: item.action,
      });
    });

    const primary = items.findIndex((it) => it.tone === 'primary');
    setActive(primary >= 0 ? primary : 0);
    // 默认焦点落主操作那一项：标题页=新游戏、暂停页=继续（都是 tone: primary，即第一项）
    this.focusDefaultId = `row:${primary >= 0 ? primary : 0}`;
  }

  /**
   * 静息态字色。设计稿里条目**基本同色**（层级靠"当前项"那条琥珀光带表达），所以这里
   * 只拉开很小的一档：主操作亮半档、破坏性操作偏一点暖红。
   * ⚠ 不要换成 colors.red / ruleQuestionable：那两档在暗牌上比标题还跳，
   * 一进暂停页眼睛先被「返回主菜单」拽走，正好反了。
   */
  private toneColor(tone: MenuTone | undefined): number {
    if (tone === 'primary') return UITheme.colors.body;
    if (tone === 'danger') return UITheme.colors.descText;
    return UITheme.colors.bodyMuted;
  }

  /**
   * 竖长木牌的尺寸。设计稿里这块牌子**是竖的**（宽高比 0.6 / 0.68），而条目数是数据决定的：
   * 主菜单没存档时只有两项，纯按内容定高会把牌子压成一块近正方形的板子，木牌那股竖幡味全没了。
   * 所以先按内容定高（带一档有限拉伸），再用宽高比给高度兜底。
   */
  private boardSize(
    sw: number, sh: number, naturalH: number, ratio: number, heightPct: number, minW: number,
  ): { w: number; h: number } {
    const maxW = sw - UITheme.spacing.xl * 2;
    const maxH = sh - UITheme.spacing.xl * 2;
    const contentH = Math.min(
      Math.max(naturalH, Math.min(sh * heightPct, naturalH * BOARD_STRETCH_MAX)),
      maxH,
    );
    const w = Math.round(Math.min(Math.max(contentH * ratio, minW), maxW));
    const h = Math.min(Math.max(contentH, w / ratio), naturalH * BOARD_ASPECT_FLOOR_MAX, maxH);
    return { w, h: Math.round(h) };
  }

  /**
   * 条目按余量拉高。设计稿的牌子几乎是满的，而条目数是数据说了算（主菜单没存档时只有两项）：
   * 固定钮高会让牌子空一大半，所以在 [min,max] 之间按余量拉伸。
   */
  private stretchRowHeight(
    boardH: number, topBlockH: number, bottomBlockH: number,
    count: number, gap: number, min: number, max: number,
  ): number {
    if (count <= 0) return min;
    // 上下各留一档呼吸，剩下的才是条目组能占的高
    const avail = boardH - topBlockH - bottomBlockH - UITheme.spacing.xxl;
    const fit = Math.floor((avail - gap * (count - 1)) / count);
    return Math.max(min, Math.min(max, fit));
  }

  /** 把一块内容摆到"牌高 pct 处为中线"，并夹在上下两个固定块之间。 */
  private blockYAt(
    py: number, boardH: number, pct: number, blockH: number, topBlockH: number, bottomBlockH: number,
  ): number {
    const minY = py + topBlockH + UITheme.spacing.lg;
    const maxY = py + boardH - bottomBlockH - blockH;
    const want = py + boardH * pct - blockH / 2;
    return Math.round(Math.min(Math.max(want, minY), Math.max(minY, maxY)));
  }

  /**
   * 主菜单背景图。异步取，取到再塞进 backdrop——**同步路径上不能等图**，
   * 否则一张没到位的图就把整块主菜单卡成白屏。失败只留纯色底，不重试。
   */
  private loadMainMenuBackdrop(slot: Container, sw: number, sh: number): void {
    if (mainMenuBgFailed) return;
    if (mainMenuBgTexture) {
      this.fillBackdrop(slot, mainMenuBgTexture, sw, sh);
      return;
    }
    mainMenuBgPending ??= Assets.load<Texture>(MAIN_MENU_BG_URL)
      .then((tex) => { mainMenuBgTexture = tex; })
      .catch(() => { mainMenuBgFailed = true; });
    void mainMenuBgPending.then(() => {
      // 图到位时菜单可能已经关了/重建过：slot 跟着 container 一起销毁，这里认它的死活
      if (slot.destroyed || !mainMenuBgTexture) return;
      this.fillBackdrop(slot, mainMenuBgTexture, sw, sh);
    });
  }

  /**
   * cover 铺满 + 压一档暗。
   *
   * ⚠ **别再往上叠黑遮罩**：这里已经拿 sprite 自身的 alpha 往下面那层暖近黑底色里融
   * （压暗方向因此是"往暖黑里沉"，而不是盖一层中性黑），外面还有一层暗角。
   * 早先是 sprite 满不透明 + 0.6 黑遮罩 + 0.7 暗角，三层叠完背景只剩一点轮廓，
   * 等于白读了一张图——设计稿里码头、水面、灯笼都是看得清的。
   */
  private fillBackdrop(slot: Container, tex: Texture, sw: number, sh: number): void {
    const k = Math.max(sw / tex.width, sh / tex.height);
    const sprite = new Sprite(tex);
    sprite.width = Math.ceil(tex.width * k);
    sprite.height = Math.ceil(tex.height * k);
    sprite.x = Math.round((sw - sprite.width) / 2);
    sprite.y = Math.round((sh - sprite.height) / 2);
    sprite.alpha = MAIN_MENU_BG_ALPHA;
    sprite.eventMode = 'none';
    slot.addChild(sprite);
  }

  /**
   * 一行可选中的菜单行 / 列表行。两种皮相：
   *  - `box`：暗底 + 木色细边的近方正钮（主菜单、存档槽位）——设计稿组件表第 2 项。
   *  - `band`：平时**没有任何框**，只有当前项铺一条横贯的琥珀渐变光带 + 上下两条渐隐金线（暂停页）。
   *
   * 事件协议与 {@link UIButton} 逐条对齐（pointerdown 标记消费、pointerup 才触发、
   * 移出即撤销按下），只是配色多了"选中 = 点亮一档琥珀"这一态——那是 UIButton 没有的。
   */
  private makeMenuRow(opts: {
    label: string;
    width: number;
    height: number;
    style: 'box' | 'band' | 'bare';
    align?: 'center' | 'left';
    font?: 'display' | 'ui';
    fontSize?: number;
    letterSpacing?: number;
    textColor?: number;
    disabled?: boolean;
    /** 压在主视觉上（标题界面）时开字影，替代给整张画铺黑纱 */
    shadow?: boolean;
    /** 主行右端的短标（存档槽位的「第 N 天」）：small 档暖金，选中跟主行一起提到琥珀 */
    trailing?: string;
    /** 副行（存档槽位的「时间 · 时长」）：给了就走两行版式，small 档弱化色，恒不换色 */
    sub?: string;
    onHover?: () => void;
    onPress: () => void;
  }): MenuRowHandle {
    const { width: w, height: h } = opts;
    const disabled = !!opts.disabled;
    const align = opts.align ?? 'center';
    const ls = opts.letterSpacing ?? 0;
    const restColor = disabled ? UITheme.colors.disabled : (opts.textColor ?? UITheme.colors.bodyMuted);

    const c = new Container();
    const bg = new Graphics();
    c.addChild(bg);

    const label = createStyledText({
      text: opts.label,
      style: {
        fontSize: opts.fontSize ?? UITheme.fontSize.bodyLarge,
        fill: restColor,
        fontFamily: opts.font === 'ui' ? UITheme.fonts.ui : UITheme.fonts.display,
        letterSpacing: ls,
        ...(opts.shadow ? { dropShadow: { ...ART_TEXT_SHADOW } } : {}),
      },
    });
    label.eventMode = 'none';
    c.addChild(label);

    // 两级层级的另外两件（都不吃事件，命中恒是整行）：主行右端短标 + 副行
    const trailing = opts.trailing
      ? createStyledText({
        text: opts.trailing,
        style: { fontSize: UITheme.fontSize.small, fill: UITheme.colors.goldDim, fontFamily: UITheme.fonts.ui },
      })
      : null;
    if (trailing) {
      trailing.eventMode = 'none';
      c.addChild(trailing);
    }
    const sub = opts.sub
      ? createStyledText({
        text: opts.sub,
        style: { fontSize: UITheme.fontSize.small, fill: UITheme.colors.hintMid, fontFamily: UITheme.fonts.ui },
      })
      : null;
    if (sub) {
      sub.eventMode = 'none';
      c.addChild(sub);
    }

    let active = false;
    let hovered = false;
    let pressed = false;

    const redraw = (): void => {
      const lit = !disabled && (active || hovered);
      bg.clear();
      // ⚠ bare 必须**排在 lit 之前**判：写成 `if (lit) drawSelectedRow(...)` 打头的话，
      // 无框菜单一选中就先被铺上琥珀色块，"无框"就白设计了（踩过一次）。
      // bare 的选中记号在下面按**文字实际宽度**画（居中构图里靠左的竖条会飘在半空，
      // 离文字上百像素——记号必须贴着字走）。
      if (opts.style === 'bare') {
        // 下面统一处理
      } else if (lit) {
        drawSelectedRow(bg, 0, 0, w, h);
      } else if (opts.style === 'box') {
        drawPanelBase(bg, 0, 0, w, h, SKINS.row, {
          fill: disabled ? UITheme.colors.rowBgInactive : UITheme.colors.rowBg,
          // 设计稿组件表：按钮边框就是做旧木条色（#6b5a3e），不是列表行那道极淡的墨边
          border: disabled ? UITheme.colors.borderSubtle : UITheme.colors.bookBorder,
        });
      }
      if (opts.style === 'band' || opts.style === 'bare') {
        // 静息时也要有命中面积，否则容器没有 bounds、指针根本进不来
        bg.rect(0, 0, w, h);
        bg.fill({ color: UITheme.colors.overlay, alpha: UITheme.alpha.hitArea });
      }
      label.style.fill = lit ? UITheme.colors.title : restColor;
      const press = pressed ? 1 : 0;
      if (sub) {
        // 两行版式（存档槽位）：主行 + 副行整块在行内垂直居中，副行色不随选中变——
        // 层级靠「主行亮、副行弱」表达，选中只点亮主行与右端短标
        const gap = UITheme.spacing.xs;
        const top = Math.round((h - label.height - gap - sub.height) / 2) + press;
        label.x = UITheme.spacing.xl;
        label.y = top;
        sub.x = UITheme.spacing.xl;
        sub.y = top + label.height + gap;
        if (trailing) {
          trailing.style.fill = lit ? UITheme.colors.title : UITheme.colors.goldDim;
          trailing.x = w - UITheme.spacing.xl - trailing.width;
          trailing.y = top + Math.round((label.height - trailing.height) / 2);
        }
      } else {
        // 带字距时 Pixi 量到的宽含末位那一格空隙，直接居中会整体左偏半格
        label.x = align === 'left'
          ? UITheme.spacing.xl
          : Math.round((w - label.width + ls) / 2);
        label.y = Math.round((h - label.height) / 2) + press;
        if (trailing) {
          trailing.style.fill = lit ? UITheme.colors.title : UITheme.colors.goldDim;
          trailing.x = w - UITheme.spacing.xl - trailing.width;
          trailing.y = Math.round((h - trailing.height) / 2) + press;
        }
      }

      // bare 选中记号：文字正下方一道短琥珀线，宽度取文字实宽的一半，**呼应标题下那道线**。
      // 居中排版里这是唯一自洽的选中标记——竖条/色块都会破掉"无框"这件事。
      if (opts.style === 'bare' && lit) {
        const textW = label.width - ls;
        const uw = Math.round(textW * TITLE_UNDERLINE_W_PCT);
        bg.rect(
          Math.round(label.x + (textW - uw) / 2),
          Math.round(label.y + label.height + TITLE_UNDERLINE_GAP),
          uw, TITLE_UNDERLINE_H,
        );
        bg.fill({ color: UITheme.colors.title, alpha: 0.85 });
      }
    };
    redraw();

    c.eventMode = disabled ? 'none' : 'static';
    c.cursor = disabled ? 'default' : 'pointer';
    c.on('pointerover', () => { hovered = true; opts.onHover?.(); redraw(); });
    c.on('pointerout', () => { hovered = false; pressed = false; redraw(); });
    c.on('pointerdown', (e) => {
      // 必须标记已消费：否则同一原生事件会被挂在 window 上的推进监听再吃一次
      markPointerConsumed((e as { nativeEvent?: unknown }).nativeEvent);
      pressed = true;
      redraw();
    });
    c.on('pointerup', () => {
      const wasPressed = pressed;
      pressed = false;
      redraw();
      if (wasPressed && !disabled) opts.onPress();
    });

    return {
      container: c,
      setActive: (v: boolean) => { active = v; redraw(); },
    };
  }

  /**
   * 居中、**两侧不带横线**的标题行。
   *
   * `createTitleRow` 居中时会在标题两翼各挂一条渐隐横线（行囊/规矩本那种窗体标题），
   * 但设计稿 02/11 的主菜单与暂停标题两侧是空的——把可用宽收到标题自身宽度，
   * 两翼算出来是负值就不画了，其余（字距/字族/色）仍旧由公共件说了算。
   *
   * @returns 这一行的高度
   */
  private addCenteredTitle(
    parent: Container,
    text: string,
    centerX: number,
    y: number,
    fontSize: number,
    letterSpacing: number,
    /** 标题界面压在主视觉上时开投影；暂停页标题在木牌上，不需要 */
    shadow = false,
  ): number {
    const w = this.measureTitle(text, fontSize, letterSpacing);
    const row = createTitleRow(text, { width: w, fontSize, letterSpacing, shadow });
    // 量到的宽含末位字距那一格，按可见宽居中才不会整体左偏
    row.position.set(Math.round(centerX - (w - letterSpacing) / 2), y);
    parent.addChild(row);
    return row.rowHeight;
  }

  /**
   * 标题界面菜单块的自适应：从最大字号往下试，直到整块塞进可用带高。
   * 返回字号、行步进与单行高（行高只包住文字，选中下划线画在行外，不参与）。
   */
  private fitMenuBlock(count: number, bandH: number): { font: number; step: number; rowH: number } {
    for (let font = TITLE_MENU_FONT_MAX; font > TITLE_MENU_FONT_MIN; font -= 2) {
      const step = Math.round(font * TITLE_MENU_STEP_RATIO);
      const rowH = Math.round(font * 1.5);
      if ((count - 1) * step + rowH <= bandH) return { font, step, rowH };
    }
    const font = TITLE_MENU_FONT_MIN;
    return { font, step: Math.round(font * TITLE_MENU_STEP_RATIO), rowH: Math.round(font * 1.5) };
  }

  /** 把标题字号缩到「整行 ≤ maxW」为止（下限 display 档——比这还塞不下就该由牌宽让步了）。 */
  private fitTitleSize(text: string, startSize: number, letterSpacing: number, maxW: number): number {
    let size = startSize;
    while (size > UITheme.fontSize.display && this.measureTitle(text, size, letterSpacing) > maxW) {
      size -= 4;
    }
    return size;
  }

  /** 量一行标题的实际宽度（样式须与 createTitleRow 内部一致，否则收不住两翼横线）。 */
  private measureTitle(text: string, fontSize: number, letterSpacing: number): number {
    const probe = createStyledText({
      text,
      style: { fontSize, fontFamily: UITheme.fonts.display, fontWeight: 'bold', letterSpacing },
    });
    const w = probe.width;
    probe.destroy();
    return w;
  }

  /** 最长一条菜单文案的宽度，供牌子宽度反推（文案是数据，字一多牌子得跟着变宽）。 */
  private widestLabel(items: MenuItem[]): number {
    let max = 0;
    for (const item of items) {
      const probe = createStyledText({
        text: item.label,
        style: {
          fontSize: UITheme.fontSize.title, fontFamily: UITheme.fonts.display,
          letterSpacing: UITheme.letterSpacing.title,
        },
      });
      max = Math.max(max, probe.width);
      probe.destroy();
    }
    return max;
  }

  /**
   * strings 里可有可无的文案。`StringsProvider.get` 查不到时把 key 原样吐回来，
   * 拿它直接画就会在主菜单上出现一行「copyright」——所以先用 getRaw 探一下。
   */
  private optionalString(key: string): string | null {
    const raw = this.strings.getRaw('menu', key).trim();
    if (!raw || raw === key) return null;
    return this.strings.get('menu', key);
  }

  /** 全屏底的暗角：中间稍亮、四周压下去，与 createPanel 给面板做的是同一手法。 */
  private buildVignette(sw: number, sh: number): Graphics {
    const c = UITheme.colors.overlay;
    const rgb = `${(c >> 16) & 0xff},${(c >> 8) & 0xff},${c & 0xff}`;
    const g = new Graphics();
    g.rect(0, 0, sw, sh);
    g.fill(new FillGradient({
      type: 'radial',
      center: { x: 0.5, y: 0.45 }, innerRadius: 0,
      outerCenter: { x: 0.5, y: 0.45 }, outerRadius: 0.78,
      colorStops: [
        { offset: 0, color: `rgba(${rgb},0)` },
        { offset: 0.55, color: `rgba(${rgb},0.06)` },
        { offset: 1, color: `rgba(${rgb},0.42)` },
      ],
      textureSpace: 'local',
    }));
    g.eventMode = 'none';
    return g;
  }

  private destroyUI(): void {
    for (const cleanup of [...this.sliderDragCleanups]) cleanup();
    this.sliderDragCleanups.clear();
    // 步进注册表跟着页面走：滑条随 container/win 销毁，留着条目就会去摸已销毁的 Graphics
    this.sliderSteps.clear();
    // 那行 dev 小开关随 container 一起没：留着钩子就会去摸已销毁的 Text
    this.devToggleRepaint = null;
    // 顺序要紧：滚动区先摘（它自己挂着 window 级 wheel/pointermove），再拆窗体
    this.list?.destroy();
    this.list = null;
    this.win?.destroy();
    this.win = null;
    if (this.container) {
      if (this.container.parent) this.container.parent.removeChild(this.container);
      this.container.destroy({ children: true });
      this.container = null;
    }
  }

  destroy(): void {
    this.unsubscribeResize?.();
    this.unsubscribeResize = null;
    // 键盘监听/焦点兜底再摘一次（close() 只在 _isOpen 时走），destroy 后重建与首次一致
    window.removeEventListener('keydown', this.onKeyBound);
    this.focus.destroy();
    this.focusMode = null;
    this.destroyUI();
    this.dropTitleBackdrop();
  }
}
