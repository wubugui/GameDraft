import { Container, Graphics, Text } from 'pixi.js';
import { UITheme } from './UITheme';
import { SKINS } from './PanelSkin';
import { buildRichDoc, parseRichMarkup, RICH_DARK, type RichBlock } from './RichContent';
import { markPointerConsumed } from './uiPointerCoords';
import { createRule } from './components/UIDecor';
import { UIListRow } from './components/UIListRow';
import { PAGE_PAD } from './components/ArchiveBookView';
import { getClueAccess } from './clueAccess';
import { UIFocus, type FocusItem } from './components/UIFocus';
import { UIWindow, WINDOW_SIZES } from './components/UIWindow';
import { UIScrollView } from './components/UIScrollView';
import type { Renderer } from '../rendering/Renderer';
import type { BookDef, BookReaderSlice, BookTocChapter, IArchiveDataProvider } from '../data/types';
import type { StringsProvider } from '../core/StringsProvider';
import type { AssetManager } from '../core/AssetManager';
import { createStyledText } from '../core/styledText';

/**
 * 翻页式书本阅读器：左目录 + 右正文，由书架当**子面板**拉起。
 *
 * 与四本档案册（走 {@link ArchiveBookView}）的差别在于：目录是两级（章 → 轶闻）、
 * 正文是章节切片（含插图 `[img:…]` 与按语），且未解锁的章/条要占位而不是藏起来——
 * 所以没并进那套通用视图，但外壳（遮罩/底框/标题/✕/滚动/滚动条）一律走组件层。
 */

/** 目录列宽上限；窄画布下再按内容区比例收一道 */
const TOC_W = 232;
const TOC_W_RATIO = 0.34;
/**
 * 目录两级各自的字号与行距。
 *
 * 目录是**扫的**不是读的，但两级得分得出来：章名是这本书的骨架（body 档），
 * 轶闻是挂在章下的条目（small 档 + `·`/`○` 前缀 + 缩进）。
 * 旧实现两级同为 small、行距写死 18（比字面还矮），于是既没层级也没呼吸。
 */
const TOC_CHAPTER = { size: UITheme.fontSize.body, lineH: 26, minH: 32 } as const;
const TOC_ENTRY = { size: UITheme.fontSize.small, lineH: 21, minH: 26 } as const;
/** 正文行距：整章正文是拿来读的，1.6 倍才有呼吸（20px 配 22 会连成一堵墙） */
const BODY_LINE_H = 32;
/** 按语行距：small 档的短段落，1.6 倍 */
const ANNOTATION_LINE_H = 26;
/** 目录列与正文列的最小可用高度（画布被压扁时兜底，沿用旧实现的下限） */
const MIN_COL_H = 80;

export class BookReaderUI {
  private renderer: Renderer;
  private archiveData: IArchiveDataProvider;
  private assetManager: AssetManager;
  private strings: StringsProvider;
  private currentBook: BookDef | null = null;
  /** 当前选中的章节页码 */
  private navPageNum = 1;
  /** null 表示阅读该章正文；非 null 表示该章下某条 entry */
  private navEntryId: string | null = null;
  private onCloseCb: (() => void) | null = null;
  private win: UIWindow | null = null;
  private toc: UIScrollView | null = null;
  private content: UIScrollView | null = null;
  /** 目录滚动位置跨重绘保留（点目录重建面板不该把目录跳回顶部） */
  private tocScrollKeep = 0;
  /** 插图到位触发的整页重画要停在读者读到的位置，不弹回顶（审查 P2）；navigate 归零 */
  private pendingContentScroll = 0;
  /**
   * 键盘/手柄焦点。两组：左栏目录（章 + 轶闻）一组，右栏「返回本章正文」一组——
   * 不分组的话上下键会在目录与右栏那条链接之间乱跳。
   * 窗体的 ✕ / 关闭提示归 `UIWindow` 自己（见文件末注）。
   */
  private focus = new UIFocus();
  private focusItems: FocusItem[] = [];
  /** 默认焦点只在开一本书时指定；翻章引起的重建靠 setItems 按 id 复位 */
  private focusInit = false;
  /** 目录列在内容区里的纵向起点：焦点矩形按内容区坐标登记，滚动换算要减掉它 */
  private tocTop = 0;
  private onKeyBound: (e: KeyboardEvent) => void;

  constructor(renderer: Renderer, archiveData: IArchiveDataProvider, strings: StringsProvider, assetManager: AssetManager) {
    this.renderer = renderer;
    this.archiveData = archiveData;
    this.assetManager = assetManager;
    this.strings = strings;
    this.onKeyBound = (e) => this.onKey(e);
  }

  openBook(book: BookDef, onClose: () => void): void {
    this.currentBook = book;
    const toc = this.archiveData.getBookTocChapters(book);
    const first = toc[0];
    this.navPageNum = first?.pageNum ?? 1;
    this.navEntryId = null;
    this.onCloseCb = onClose;
    this.tocScrollKeep = 0;
    this.focusInit = false;
    window.addEventListener('keydown', this.onKeyBound);
    this.fireSliceFirstView();
    this.build(true);
  }

  /** 目录/返回章节导航统一入口：更新定位、触发首见、重渲染。 */
  private navigate(pageNum: number, entryId: string | null): void {
    this.navPageNum = pageNum;
    this.navEntryId = entryId;
    this.pendingContentScroll = 0;
    this.fireSliceFirstView();
    this.build(false);
  }

  /**
   * Esc = **退一层**（经 BookshelfUI 的子面板钩子转进来）：
   * 正在读轶闻 → 退回本章正文；已在章正文/占位页 → 交回书架（退到书架层）。
   */
  handleEscapeStep(): boolean {
    if (this.navEntryId !== null) {
      this.navigate(this.navPageNum, null);
      return true;
    }
    return false;
  }

  /**
   * 切片真正对玩家可见的时机（打开书 / 目录跳转）触发一次首见动作。
   * 不放在 build 里：build 是纯渲染，会被各种重绘路径调用，副作用放渲染里会重复触发。
   */
  private fireSliceFirstView(): void {
    if (!this.currentBook) return;
    const { slice } = this.resolveSlice(this.currentBook);
    if (slice?.unlocked) {
      this.archiveData.triggerBookSliceFirstView(this.currentBook.id, slice);
    }
  }

  close(): void {
    window.removeEventListener('keydown', this.onKeyBound);
    // 关场淡出：先摘输入面（滚动区 wheel/拖动 + 上面的 keydown），再让窗体淡出自毁。
    // 翻页/目录跳转的重建路径（build → teardown）保持瞬时 destroy，不走这里。
    this.toc?.detachInput();
    this.content?.detachInput();
    const win = this.win;
    this.toc = null;
    this.content = null;
    this.win = null;
    win?.fadeOutAndDestroy();
    this.currentBook = null;
    this.onCloseCb = null;
    this.tocScrollKeep = 0;
    this.focus.destroy();
    this.focusItems = [];
    this.focusInit = false;
  }

  /** 真销毁（游戏退出）：瞬时路径，不播关场动画 */
  destroy(): void {
    window.removeEventListener('keydown', this.onKeyBound);
    this.teardown();
    this.currentBook = null;
    this.onCloseCb = null;
    this.tocScrollKeep = 0;
    this.focus.destroy();
    this.focusItems = [];
    this.focusInit = false;
  }

  /**
   * ✕ /「[返回书架]」的关闭入口。
   *
   * 本面板**不是** `GameStateController` 的注册面板，而是书架（`BookshelfUI`）用
   * `onOpenBook(book, onClose)` 拉起的子面板句柄——所以关闭不能走 `closePanel`，
   * 必须回调书架给的 `onClose`（它负责 `closeSubPanel()` + 重建书架）。
   * 直接 `this.close()` 会把书本关掉却留下空白的 UIOverlay，玩家回不到书架。
   */
  private requestBack(): void {
    this.onCloseCb?.();
  }

  private teardown(): void {
    this.toc?.destroy();
    this.content?.destroy();
    this.win?.destroy();
    this.toc = null;
    this.content = null;
    this.win = null;
  }

  /**
   * 方向键挪焦点、回车/空格跳章；**焦点优先、滚动兜底**——
   * 目录走到底时 `focus.handleKey` 让回按键，才轮到 `UIScrollView` 滚正文
   * （PageUp/PageDown 焦点从不接管，长正文照旧整页翻）。滚不动时不吞按键，避免抢全局快捷键。
   */
  private onKey(e: KeyboardEvent): void {
    if (this.focus.handleKey(e.code)) {
      this.scrollFocusIntoView();
      e.preventDefault();
      return;
    }
    const sv = this.content ?? this.toc;
    if (!sv) return;
    const before = sv.scrollOffset;
    if (!sv.handleKey(e.code)) return;
    if (sv.scrollOffset !== before) e.preventDefault();
  }

  /**
   * 焦点挪到目录视口外时把它滚进来。焦点矩形按**内容区坐标**登记
   * （目录与右栏链接要在同一坐标系里才谈得上空间导航），换算回目录内容坐标要减 `tocTop`。
   * 右栏那条链接不在滚动区里，跳过。
   */
  private scrollFocusIntoView(): void {
    const toc = this.toc;
    const cur = this.focus.current;
    if (!toc || !cur || cur.group !== 'toc') return;
    const top = cur.y - this.tocTop;
    const bottom = top + cur.h;
    if (top < toc.scrollOffset) toc.scrollOffset = top;
    else if (bottom > toc.scrollOffset + toc.viewportHeight) {
      toc.scrollOffset = bottom - toc.viewportHeight;
    }
  }

  /** 预设 xl（820×560）在小画布（调试侧栏挤压 #game-mount）下要收边 */
  private windowSize(): { width: number; height: number } {
    const margin = UITheme.spacing.xl * 2;
    return {
      width: Math.min(WINDOW_SIZES.xl.width, this.renderer.screenWidth - margin),
      height: Math.min(WINDOW_SIZES.xl.height, this.renderer.screenHeight - margin),
    };
  }

  private resolveSlice(book: BookDef): {
    slice: BookReaderSlice | null;
    entryLocked: boolean;
  } {
    if (this.navEntryId) {
      const slice = this.archiveData.getBookEntrySlice(book, this.navPageNum, this.navEntryId);
      if (slice) return { slice, entryLocked: false };
      const toc = this.archiveData.getBookTocChapters(book);
      const ch = toc.find((c) => c.pageNum === this.navPageNum);
      const ent = ch?.entries.find((e) => e.id === this.navEntryId);
      return { slice: null, entryLocked: !!ent && !ent.unlocked };
    }
    const slice = this.archiveData.getBookPageSlice(book, this.navPageNum);
    return { slice, entryLocked: false };
  }

  /**
   * @param animateOpen 仅首次打开书本时为 true。目录切换的重绘必须走 `win.attach()`——
   * 走 `open()` 会让每次翻页都重放一遍开场淡入上浮；而**忘了挂载**会让整本书从画面消失。
   */
  private build(animateOpen = false): void {
    this.tocScrollKeep = animateOpen ? 0 : (this.toc?.scrollOffset ?? this.tocScrollKeep);
    this.teardown();
    const book = this.currentBook;
    if (!book) return;

    const win = new UIWindow(this.renderer, {
      size: this.windowSize(),
      title: this.archiveData.resolveLine(book.title),
      skin: SKINS.book,
      closeHint: this.strings.get('bookReader', 'back'),
      onClose: () => this.requestBack(),
    });
    this.win = win;

    const chapters = this.archiveData.getBookTocChapters(book);

    // 底栏面包屑：先量高，两列的可用高按它扣
    const pageInfo = createStyledText({
      text: this.breadcrumbText(chapters),
      style: {
        fontSize: UITheme.fontSize.micro,
        fill: UITheme.colors.hintMid,
        fontFamily: UITheme.fonts.ui,
        wordWrap: true,
        breakWords: true,
        wordWrapWidth: win.bodyWidth,
      },
    });
    pageInfo.y = Math.max(0, win.bodyHeight - pageInfo.height);
    win.body.addChild(pageInfo);

    const tocTitle = createStyledText({
      text: this.strings.get('bookReader', 'tocTitle'),
      style: {
        fontSize: UITheme.fontSize.small,
        fill: UITheme.colors.hintMid,
        fontFamily: UITheme.fonts.display,
        fontWeight: 'bold',
        letterSpacing: UITheme.letterSpacing.title,
      },
    });
    win.body.addChild(tocTitle);

    const tocW = Math.min(TOC_W, Math.round(win.bodyWidth * TOC_W_RATIO));
    const listTop = tocTitle.height + UITheme.spacing.xs;
    const colH = Math.max(MIN_COL_H, win.bodyHeight - pageInfo.height - UITheme.spacing.sm - listTop);
    // 两栏＝摊开的一本书的两页，中间一条极淡竖线；右栏没有自己的底
    // （批3a 的米白纸页已撤，理由见 ArchiveBookView 顶部注释：这游戏没有亮面板）。
    // 内白仍走同一个 PAGE_PAD：中缝位置 / 视口宽 / 换行宽三处同出一源。
    const dividerX = tocW + UITheme.spacing.lg;
    const contentX = dividerX + PAGE_PAD;
    const contentW = Math.max(1, win.bodyWidth - contentX - UITheme.spacing.sm);
    const divider = new Graphics();
    divider.rect(dividerX, listTop, 1, colH);
    divider.fill({ color: UITheme.colors.hairline, alpha: UITheme.alpha.hairline });
    divider.eventMode = 'none';
    win.body.addChild(divider);

    // 滚轮分栏：鼠标在左栏滚目录、在右栏滚正文。
    // 边界**每次现读** win.body.x —— 窗口 resize 会重算居中位移，捕获成常量会让判据错位。
    const splitX = (): number => (this.win?.body.x ?? 0) + tocW;

    const toc = new UIScrollView(this.renderer, {
      width: tocW,
      height: colH,
      hitTest: (x) => x < splitX(),
    });
    toc.container.position.set(0, listTop);
    win.body.addChild(toc.container);
    this.toc = toc;
    this.tocTop = listTop;
    this.focusItems = [];
    this.fillToc(chapters, tocW);
    toc.refresh();
    toc.scrollOffset = this.tocScrollKeep;

    this.buildContentColumn(book, chapters, contentX, listTop, contentW, colH, splitX);

    // 目录在前、右栏链接在后（setItems 无历史焦点时落到第一项，先排目录就不会开在链接上）
    this.focus.setItems(this.focusItems);
    if (!this.focusInit) {
      // 默认焦点落**当前正在读的那一条**，不是目录第一行
      this.focus.focusDefault(this.tocLineId(this.navPageNum, this.navEntryId));
      this.focusInit = true;
    }
    // setItems 按同 id 复位时不会重放 onFocus（currentId 没变），新一批行牌拿不到高亮 → 补一次
    this.focus.repaint();
    this.scrollFocusIntoView();

    if (animateOpen) win.open();
    else win.attach();
  }

  /** 目录行的稳定焦点键：翻章重建后靠它把焦点放回原处。 */
  private tocLineId(pageNum: number, entryId: string | null): string {
    return `toc:${pageNum}:${entryId ?? ''}`;
  }

  /** 两级目录：章（可点）→ 轶闻（可点，未解锁以 ○ 占位且置灰但仍可点开看提示）。 */
  private fillToc(chapters: BookTocChapter[], tocW: number): void {
    const toc = this.toc;
    if (!toc) return;
    const lineW = Math.max(1, tocW - UITheme.spacing.sm);
    let cy = 0;

    const makeLine = (
      label: string,
      pageNum: number,
      entryId: string | null,
      indent: number,
      opts: { muted: boolean; selected: boolean; level: typeof TOC_CHAPTER | typeof TOC_ENTRY },
    ): void => {
      const fill = opts.selected
        ? UITheme.colors.title
        : opts.muted
          ? UITheme.colors.disabled
          : UITheme.colors.bodyMuted;
      const t = createStyledText({
        text: label,
        style: {
          fontSize: opts.level.size,
          fill,
          fontFamily: UITheme.fonts.ui,
          wordWrap: true,
          breakWords: true,
          wordWrapWidth: Math.max(1, lineW - indent - UITheme.spacing.sm),
          lineHeight: opts.level.lineH,
        },
      });
      const rowH = Math.max(opts.level.minH, t.height + UITheme.spacing.sm);
      const focusId = this.tocLineId(pageNum, entryId);

      // 行原语（UIListRow）：tap 激活 + 拖滚让路 + 消费标记 + 焦点铺光全内建。
      // 未解锁的章/条**不作 disabled**：它们点得开（给一句「尚未解锁」占位），按键到不了才是死角。
      const listRow = new UIListRow({
        width: lineW,
        height: rowH,
        selected: opts.selected,
        baseOverrides: opts.muted ? { fillAlpha: UITheme.alpha.rowBgLight } : undefined,
        onTap: () => this.navigate(pageNum, entryId),
        // 悬停即移焦：鼠标与手柄共用同一个"当前项"
        onHover: () => this.focus.syncHover(focusId),
        onHoverEnd: () => this.focus.clearHover(focusId),
      });
      listRow.container.y = cy;
      toc.content.addChild(listRow.container);

      t.x = indent + UITheme.spacing.xs;
      t.y = Math.round((rowH - t.height) / 2);
      t.eventMode = 'none';
      listRow.container.addChild(t);

      // 焦点矩形按内容区坐标登记，好与右栏链接同台比位置。
      this.focusItems.push({
        id: focusId,
        x: 0, y: this.tocTop + cy, w: lineW, h: rowH,
        group: 'toc',
        onFocus: (on, via) => {
          listRow.setFocused(on, via);
          // 字色只跟**导航光标**走，不跟鼠标走（理由见 ArchiveBookView 同处）
          if (!t.destroyed && !opts.selected) t.style.fill = on && via === 'key' ? UITheme.colors.title : fill;
        },
        onActivate: () => this.navigate(pageNum, entryId),
      });

      cy += rowH + UITheme.spacing.xs;
    };

    for (const ch of chapters) {
      const chLabel = ch.title?.trim()
        || this.strings.get('bookReader', 'chapterFallback', { n: String(ch.pageNum) });
      const chSel = this.navPageNum === ch.pageNum && this.navEntryId === null;
      makeLine(chLabel, ch.pageNum, null, 0, {
        muted: !ch.unlocked,
        selected: chSel,
        level: TOC_CHAPTER,
      });
      for (const ent of ch.entries) {
        const entSel = this.navPageNum === ch.pageNum && this.navEntryId === ent.id;
        const prefix = ent.unlocked ? '· ' : '○ ';
        makeLine(prefix + ent.title, ch.pageNum, ent.id, UITheme.spacing.md, {
          muted: !ent.unlocked,
          selected: entSel,
          level: TOC_ENTRY,
        });
      }
    }
  }

  /**
   * 右栏：固定的标题块（页题 / 出处 + 轶闻名 + 返回本章）+ 可滚的正文块。
   * 标题块**刻意留在滚动区外**——旧实现即如此，滚正文时定位信息不该跟着滚掉。
   */
  private buildContentColumn(
    book: BookDef,
    chapters: BookTocChapter[],
    x: number,
    top: number,
    w: number,
    h: number,
    splitX: () => number,
  ): void {
    const win = this.win;
    if (!win) return;
    const { slice, entryLocked } = this.resolveSlice(book);

    const head = new Container();
    head.position.set(x, top);
    win.body.addChild(head);
    let hy = 0;

    if (entryLocked) {
      head.addChild(this.placeholderText(this.strings.get('bookReader', 'entryLocked'), w));
      return;
    }
    if (!slice) return;

    if (!slice.unlocked) {
      const missing = this.placeholderText(this.strings.get('bookReader', 'pageMissing'), w);
      missing.x = Math.max(0, (w - missing.width) / 2);
      missing.y = Math.max(0, (h - missing.height) / 2);
      head.addChild(missing);
      return;
    }

    if (slice.kind === 'page') {
      if (slice.title) {
        const pt = this.headingText(slice.title, w);
        pt.y = hy;
        head.addChild(pt);
        hy += pt.height + UITheme.spacing.sm;
      }
    } else {
      const chapter = slice.chapterTitle?.trim();
      if (chapter) {
        const ch = createStyledText({
          text: this.strings.get('bookReader', 'entryFromChapter', { chapter }),
          style: {
            fontSize: UITheme.fontSize.small,
            fill: UITheme.colors.hintMid,
            fontFamily: UITheme.fonts.ui,
            wordWrap: true,
            breakWords: true,
            wordWrapWidth: w,
          },
        });
        ch.y = hy;
        head.addChild(ch);
        hy += ch.height + UITheme.spacing.xs;
      }

      const et = this.headingText(slice.title, w);
      et.y = hy;
      head.addChild(et);
      hy += et.height + UITheme.spacing.sm;

      // 「返回本章正文」：与 UIWindow 的关闭提示同一种链接式写法（文字本身即命中区，
      // 带 hover 变色）；短链接不适用「整行 Graphics 靶子」那条——那是给整行条目用的。
      // 这是一条**可点的导航链接**，不是页码角标：micro 档点它都得瞄准。
      // 说明/键位一档（small）足够克制，又不至于比它上面那句「出自…」还小。
      const backCh = createStyledText({
        text: this.strings.get('bookReader', 'backToChapter'),
        style: {
          fontSize: UITheme.fontSize.small,
          // 纸页上的链接：墨系弱化色，焦点/悬停提到墨题色（暗底的 link 色在纸上会发灰蓝）
          fill: UITheme.colors.hintMid,
          fontFamily: UITheme.fonts.ui,
          wordWrap: true,
          breakWords: true,
          wordWrapWidth: w,
        },
      });
      backCh.y = hy;
      backCh.eventMode = 'static';
      backCh.cursor = 'pointer';
      // 悬停即移焦：变色统一由 onFocus 画（就是原来的悬停画法）。
      // 原先的 pointerout 复位去掉了——移开鼠标不该把唯一的焦点擦掉，焦点恒有一个可见。
      backCh.on('pointerover', () => this.focus.syncHover('backToChapter'));
      backCh.on('pointerout', () => this.focus.clearHover('backToChapter'));
      backCh.on('pointerdown', (e) => {
        markPointerConsumed((e as { nativeEvent?: unknown }).nativeEvent);
        this.navigate(this.navPageNum, null);
      });
      head.addChild(backCh);
      // 右栏唯一的可交互件，自成一组：与目录同组的话上下键会在两栏之间乱跳
      this.focusItems.push({
        id: 'backToChapter',
        x: x, y: top + hy, w: backCh.width, h: backCh.height,
        group: 'content',
        onFocus: (on) => {
          if (!backCh.destroyed) backCh.style.fill = on ? UITheme.colors.title : UITheme.colors.hintMid;
        },
        onActivate: () => this.navigate(this.navPageNum, null),
      });
      // 固定标题块与可滚正文之间留 md：正文行距 32，隔 sm(8) 的话首行会像是标题块的一部分
      hy += backCh.height + UITheme.spacing.md;
    }

    // 底部章导航行占位：翻页式阅读器没有上一章/下一章是审查 P1（自称翻页却章间只能回目录）
    const navH = slice.kind === 'page' ? this.chapterNavHeight(chapters) : 0;

    const scroll = new UIScrollView(this.renderer, {
      width: w,
      height: Math.max(MIN_COL_H, h - hy - navH),
      hitTest: (px) => px >= splitX(),
    });
    scroll.container.position.set(x, top + hy);
    win.body.addChild(scroll.container);
    this.content = scroll;

    // 正文块：整页插画（wide 档居中，`[img:…]` 数据侧声明的仍按标记档位）→ 正文标记解析
    // → 轶闻按语（分隔线 + 引文声部；旧版是同色 small + 伪斜体，审查 P1/P2 双点名）。
    const blocks: RichBlock[] = [];
    if (slice.illustration?.trim()) {
      blocks.push({ kind: 'image', path: slice.illustration.trim(), size: 'wide' });
    }
    blocks.push(...parseRichMarkup(slice.content));
    if (slice.kind === 'entry' && slice.annotation?.trim()) {
      blocks.push({ kind: 'divider' });
      blocks.push({ kind: 'quote', text: `${this.strings.get('bookReader', 'annotationHeading')}：${slice.annotation.trim()}` });
    }

    // 插图是现装的（书里的 `[img:…]` 不在任何预载清单里），到位后整页重画。
    // 守卫：书可能已经关了、也可能已经翻到别页——那就别把旧页画回去。
    // 重画停在读者读到的位置（pendingContentScroll），不弹回顶。
    const atPage = this.navPageNum;
    const atEntry = this.navEntryId;
    const { container: rc } = buildRichDoc(blocks, {
      width: w,
      fontSize: UITheme.fontSize.body,
      fontFamily: UITheme.fonts.display,
      lineHeight: BODY_LINE_H,
      palette: RICH_DARK,
      onImageLoaded: () => {
        if (!this.win || !this.currentBook) return;
        if (this.navPageNum !== atPage || this.navEntryId !== atEntry) return;
        this.pendingContentScroll = this.content?.scrollOffset ?? 0;
        this.build(false);
      },
      // K7 线索词条（书页里同样能圈线索）：状态色 + 采集后延迟重画（保住闪金动画）
      linkStateResolver: (link) =>
        (link.kind === 'clue' && getClueAccess()?.isCollected(link.id) ? 'collected' : 'fresh'),
      onLinkTap: (link) => {
        const clues = getClueAccess();
        if (link.kind !== 'clue' || !clues) return;
        clues.collect(link.id);
        window.setTimeout(() => {
          if (!this.win || this.navPageNum !== atPage || this.navEntryId !== atEntry) return;
          this.pendingContentScroll = this.content?.scrollOffset ?? 0;
          this.build(false);
        }, 320);
      },
    }, this.assetManager);
    scroll.content.addChild(rc);

    scroll.refresh();
    scroll.scrollOffset = this.pendingContentScroll;
    this.pendingContentScroll = 0;

    if (navH > 0) {
      this.buildChapterNav(chapters, x, top + h - navH + UITheme.spacing.sm, w);
    }
  }

  /** 章导航行高：有上一章或下一章可去才占位 */
  private chapterNavHeight(chapters: BookTocChapter[]): number {
    const idx = chapters.findIndex((c) => c.pageNum === this.navPageNum);
    if (idx < 0) return 0;
    return (idx > 0 || idx < chapters.length - 1) ? UITheme.fontSize.small + UITheme.spacing.md : 0;
  }

  /**
   * 章正文页底部的「← 上一章 / 下一章 →」：纸页页脚的一对导航链接，
   * 键盘归 content 组（左右键即可在两枚间横跳）。未解锁的章照样能翻过去看占位提示。
   */
  private buildChapterNav(chapters: BookTocChapter[], x: number, y: number, w: number): void {
    const win = this.win;
    if (!win) return;
    const idx = chapters.findIndex((c) => c.pageNum === this.navPageNum);
    if (idx < 0) return;

    const mk = (label: string, target: BookTocChapter, id: string, alignRight: boolean): void => {
      const t = createStyledText({
        text: label,
        style: { fontSize: UITheme.fontSize.small, fill: UITheme.colors.hintMid, fontFamily: UITheme.fonts.ui },
      });
      t.position.set(alignRight ? x + w - t.width : x, y);
      t.eventMode = 'static';
      t.cursor = 'pointer';
      t.on('pointerover', () => this.focus.syncHover(id));
      t.on('pointerout', () => this.focus.clearHover(id));
      t.on('pointerdown', (e) => {
        markPointerConsumed((e as { nativeEvent?: unknown }).nativeEvent);
        this.navigate(target.pageNum, null);
      });
      win.body.addChild(t);
      this.focusItems.push({
        id,
        x: t.x, y: t.y, w: t.width, h: t.height,
        group: 'content',
        onFocus: (on) => {
          if (!t.destroyed) t.style.fill = on ? UITheme.colors.title : UITheme.colors.hintMid;
        },
        onActivate: () => this.navigate(target.pageNum, null),
      });
    };

    if (idx > 0) {
      mk(this.strings.get('bookReader', 'prevChapter'), chapters[idx - 1], 'prevChapter', false);
    }
    if (idx < chapters.length - 1) {
      mk(this.strings.get('bookReader', 'nextChapter'), chapters[idx + 1], 'nextChapter', true);
    }
  }

  /** 页题 / 轶闻名：墨题大字 + 一条纸色横线（纸页上的开头两笔）。 */
  private headingText(text: string, w: number): Container {
    const c = new Container();
    const t = createStyledText({
      text,
      style: {
        fontSize: UITheme.fontSize.title,
        fill: UITheme.colors.title,
        fontFamily: UITheme.fonts.display,
        fontWeight: 'bold',
        letterSpacing: UITheme.letterSpacing.title,
        wordWrap: true,
        breakWords: true,
        wordWrapWidth: w,
      },
    });
    t.eventMode = 'none';
    c.addChild(t);
    const rule = createRule(w);
    rule.y = t.height + UITheme.spacing.xs;
    c.addChild(rule);
    return c;
  }

  /** 未解锁 / 缺页的占位话（伪斜体已去——中文斜体是横向剪切，观感廉价，审查 P2） */
  private placeholderText(text: string, w: number): Text {
    return createStyledText({
      text,
      style: {
        fontSize: UITheme.fontSize.bodyLarge,
        fill: UITheme.colors.hintMid,
        fontFamily: UITheme.fonts.display,
        wordWrap: true,
        breakWords: true,
        wordWrapWidth: w,
      },
    });
  }

  private breadcrumbText(tocChapters: BookTocChapter[]): string {
    const ch = tocChapters.find((c) => c.pageNum === this.navPageNum);
    const chName = ch?.title?.trim()
      || this.strings.get('bookReader', 'chapterFallback', { n: String(this.navPageNum) });
    if (!this.navEntryId) {
      return `${chName}  ·  ${this.strings.get('bookReader', 'pageHint')}`;
    }
    const ent = ch?.entries.find((e) => e.id === this.navEntryId);
    const entTitle = ent?.title ?? '';
    return `${chName} / ${entTitle}  ·  ${this.strings.get('bookReader', 'pageHint')}`;
  }
}
