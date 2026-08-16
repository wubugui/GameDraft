import { Container, Graphics, Text } from 'pixi.js';
import { UITheme, fadeIn } from './UITheme';
import { createPanel, SKINS } from './PanelSkin';
import { createIcon, createKeyCap, createRule, createTitleRow, drawSelectedRow } from './components/UIDecor';
import { UIFocus, type FocusItem } from './components/UIFocus';
import { markPointerConsumed } from './uiPointerCoords';
import type { UIIconName } from './UIIcons';
import type { Renderer } from '../rendering/Renderer';
import type { IArchiveDataProvider, BookDef } from '../data/types';
import type { StringsProvider } from '../core/StringsProvider';
import { createStyledText } from '../core/styledText';

/**
 * 书架：一排**竖立的木牌**（木框 + 暗底 + 竖排书名），压在厚木框面板里。
 *
 * 设计稿口径（tmp/ui_mockups_2026-08-03）：面板走 `createPanel`（纸纹 + 木框 + 内金线），
 * 标题居中拉字距带两翼横线，底部一枚方框键帽。书脊不是彩色色块——那是引擎默认调色板的
 * 味道；这里是挂在架子上的木牌，选中/悬停时**整块点亮一档琥珀**而不是换个深色。
 */

/** 木牌尺寸与栅格。一行五块，多出来的动态书本换行。 */
const COLS = 5;
const PLAQUE_W = 96;
/**
 * 木牌高度。**由竖排书名的容量倒推**：三字书名（见闻录/杂书匣/人物簿/怪话册/规矩本）
 * 要能用第一档字号排下并留出图标与上下呼吸，四字才降档——178 是按旧的小字号定的，
 * 字号抬起来后三字就顶到牌底了。
 */
const PLAQUE_H = 196;
const PLAQUE_GAP = UITheme.spacing.lg;
const ROW_GAP = UITheme.spacing.xl;
/** 面板左右留白：木框本身 15px，再留一档才不会让木牌压在木纹上 */
const SIDE_INSET = 36;
const PANEL_W = SIDE_INSET * 2 + COLS * PLAQUE_W + (COLS - 1) * PLAQUE_GAP;
/** 底部键帽区高度 */
const FOOTER_H = 52;
/** 木牌内的琥珀铺光离木框的距离 */
const GLOW_INSET = 7;
/** 牌顶那枚木刻图标。它是书名的陪衬，**刻意小于书名一档**，不跟着书名一起放大 */
const ICON_SIZE = 20;
/**
 * 竖排书名的字号阶梯：一个字一行，**行距必须跟着字号走**。
 *
 * 旧实现是「字号 bodyLarge + 行距写死 22」——22 比字面还矮，竖排下每个字都咬着上一个字，
 * 一列书名糊成一条。这里把可用的三档连同各自的行距一起摆出来，由 `pickSpineStyle`
 * 按牌面剩余高度从大到小挑第一个排得下的。
 */
const SPINE_STEPS = [
  { size: UITheme.fontSize.bodyLarge, lineH: 30 },
  { size: UITheme.fontSize.body, lineH: 24 },
  { size: UITheme.fontSize.small, lineH: 19 },
] as const;

interface BookSlot {
  id: string;
  label: string;
  icon: UIIconName;
  hasUnread: boolean;
}

/** 打开子面板的回调类型，返回带 close 的句柄 */
export type OnOpenSubPanel = (onClose: () => void) => { close(): void };
/** 打开独立书籍时的回调，返回带 close 的句柄供书架在关闭子面板时使用 */
export type OnOpenBook = (book: BookDef, onClose: () => void) => { close(): void };

/** 中文竖排：Pixi 没有 writing-mode，逐字换行即竖排（代理对安全地按码点拆）。 */
function verticalize(label: string): string {
  return Array.from(label.trim()).join('\n');
}

/**
 * 按牌面剩余高度挑一档竖排字号 + 行距。
 * 三档都排不下（《雾津县风物志》这类长书名）就用最小一档并把行距压到刚好塞满——
 * **不许溢出牌面**，木牌外面就是面板边沿。
 */
function pickSpineStyle(glyphs: number, room: number): { size: number; lineH: number } {
  for (const step of SPINE_STEPS) {
    if (glyphs * step.lineH <= room) return { size: step.size, lineH: step.lineH };
  }
  const last = SPINE_STEPS[SPINE_STEPS.length - 1];
  return { size: last.size, lineH: Math.max(12, Math.floor(room / glyphs)) };
}

export class BookshelfUI {
  private renderer: Renderer;
  private archiveData: IArchiveDataProvider;
  private container: Container | null = null;
  private _isOpen = false;
  private activeSubPanel: { close(): void } | null = null;
  private closeRequester: (() => void) | null = null;
  private onOpenRules: () => void;
  private onOpenBook: OnOpenBook;
  private onOpenCharacters: OnOpenSubPanel;
  private onOpenLore: OnOpenSubPanel;
  private onOpenDocuments: OnOpenSubPanel;
  private onOpenSlang: OnOpenSubPanel;
  private onOpenRhymes: OnOpenSubPanel;
  private strings: StringsProvider;
  /**
   * 键盘/手柄焦点。书脊是一排二维可导航木牌，✕ 与底部键帽各自成组——
   * 不分组的话上下键会在木牌与出口之间乱跳。
   */
  private focus = new UIFocus();
  /** 木牌（一组）与窗体件（✕ / 键帽）分开攒：木牌必须排在前面，好让首帧默认焦点落在书上 */
  private focusPlaques: FocusItem[] = [];
  private focusChrome: FocusItem[] = [];
  /** 默认焦点只在首次打开时指定；返回书架的重建靠 setItems 按 id 复位 */
  private focusInit = false;
  private onKeyBound: (e: KeyboardEvent) => void;

  constructor(
    renderer: Renderer,
    archiveData: IArchiveDataProvider,
    onOpenRules: () => void,
    onOpenBook: OnOpenBook,
    onOpenCharacters: OnOpenSubPanel,
    onOpenLore: OnOpenSubPanel,
    onOpenDocuments: OnOpenSubPanel,
    onOpenSlang: OnOpenSubPanel,
    onOpenRhymes: OnOpenSubPanel,
    strings: StringsProvider,
  ) {
    this.renderer = renderer;
    this.archiveData = archiveData;
    this.onOpenRules = onOpenRules;
    this.onOpenBook = onOpenBook;
    this.onOpenCharacters = onOpenCharacters;
    this.onOpenLore = onOpenLore;
    this.onOpenDocuments = onOpenDocuments;
    this.onOpenSlang = onOpenSlang;
    this.onOpenRhymes = onOpenRhymes;
    this.strings = strings;
    this.onKeyBound = (e) => this.onKey(e);
  }

  get isOpen(): boolean { return this._isOpen; }

  open(): void {
    if (this._isOpen) return;
    this._isOpen = true;
    window.addEventListener('keydown', this.onKeyBound);
    this.buildShelf();
  }

  close(): void {
    if (!this._isOpen) return;
    this._isOpen = false;
    window.removeEventListener('keydown', this.onKeyBound);
    this.closeSubPanel();
    this.destroyUI();
    this.focus.destroy();
    this.focusInit = false;
  }

  /**
   * 方向键挪焦点、回车/空格激活。
   *
   * **子面板（册子/阅读器）拉起时书架本体已拆**（`destroyShelfOnly`），此时按键归子面板，
   * 这里必须让开——否则一个方向键会同时挪书架的焦点和册子的焦点。
   */
  private onKey(e: KeyboardEvent): void {
    if (!this.container) return;
    if (this.focus.handleKey(e.code)) e.preventDefault();
  }

  private buildShelf(): void {
    this.destroyUI();
    this.focusPlaques = [];
    this.focusChrome = [];
    this.container = new Container();
    const sw = this.renderer.screenWidth;
    const sh = this.renderer.screenHeight;

    const fixedBooks: BookSlot[] = [
      { id: 'rules', label: this.strings.get('bookshelf', 'rules'), icon: 'talisman', hasUnread: false },
      { id: 'character', label: this.strings.get('bookshelf', 'characters'), icon: 'hat', hasUnread: this.archiveData.hasUnread('character') },
      { id: 'lore', label: this.strings.get('bookshelf', 'lore'), icon: 'book', hasUnread: this.archiveData.hasUnread('lore') },
      { id: 'document', label: this.strings.get('bookshelf', 'documents'), icon: 'scroll', hasUnread: this.archiveData.hasUnread('document') },
      { id: 'slang', label: this.strings.get('bookshelf', 'slang'), icon: 'bowl', hasUnread: this.archiveData.hasUnread('slang') },
      { id: 'rhyme', label: this.strings.get('bookshelf', 'rhymes'), icon: 'lantern', hasUnread: this.archiveData.hasUnread('rhyme') },
    ];
    const dynamicBooks = this.archiveData.getUnlockedBooks();

    // 面板高度跟着木牌行数走：只有一行时不留一大片空架子，多出一行也不会把木牌切掉
    const gridRows = Math.max(1, Math.ceil((fixedBooks.length + dynamicBooks.length) / COLS));
    const gridH = gridRows * PLAQUE_H + (gridRows - 1) * ROW_GAP;

    const title = createTitleRow(this.strings.get('bookshelf', 'title'), {
      width: PANEL_W - SIDE_INSET * 2,
      align: 'center',
      fontSize: UITheme.fontSize.display,
      letterSpacing: UITheme.letterSpacing.display,
    });
    const panelH = UITheme.spacing.md + title.rowHeight + UITheme.spacing.xl + gridH + FOOTER_H;

    const px = Math.round((sw - PANEL_W) / 2);
    const py = Math.round((sh - panelH) / 2);

    const overlay = new Graphics();
    overlay.rect(0, 0, sw, sh);
    overlay.fill({ color: UITheme.colors.overlay, alpha: UITheme.alpha.overlay });
    this.container.addChild(overlay);

    this.container.addChild(createPanel(px, py, PANEL_W, panelH, SKINS.panel));

    title.position.set(px + SIDE_INSET, py + UITheme.spacing.md);
    this.container.addChild(title);

    // 书架自己不走 UIWindow（木牌布局是手搓的），但**关闭通道必须与其余面板一致**：
    // 集成验证抓到过——这里此前既没有 ✕、关闭提示又是 passive 不可点，
    // 于是五本子册各自都有 ✕ 和可点的「[返回书架]」，唯独退回书架这一层纯鼠标玩家没有出口。
    this.container.addChild(this.buildCloseButton(px + PANEL_W - SIDE_INSET, py + UITheme.spacing.xl));

    this.container.addChild(this.buildCloseHint(px, py, panelH));

    const gridW = COLS * PLAQUE_W + (COLS - 1) * PLAQUE_GAP;
    const startX = px + Math.round((PANEL_W - gridW) / 2);
    const startY = py + UITheme.spacing.md + title.rowHeight + UITheme.spacing.xl;

    // 每排木牌底下一条渐隐横线＝搁板。少了它这里就只是「五张卡片浮在黑底上」，
    // 不是一排书立在架子上——面板名叫书架，架子总得有。
    for (let r = 0; r < gridRows; r++) {
      const plank = createRule(gridW);
      plank.position.set(startX, startY + r * (PLAQUE_H + ROW_GAP) + PLAQUE_H + UITheme.spacing.xs);
      this.container.addChild(plank);
    }

    // 固定书册六本起超过一行，与动态书籍走同一套折行：第六本落第二行首格
    fixedBooks.forEach((slot, i) => {
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      this.drawBookSlot(slot, startX + col * (PLAQUE_W + PLAQUE_GAP), startY + row * (PLAQUE_H + ROW_GAP));
    });

    dynamicBooks.forEach((book, i) => {
      const idx = fixedBooks.length + i;
      const col = idx % COLS;
      const row = Math.floor(idx / COLS);
      this.drawBookSlot(
        { id: `book_${book.id}`, label: this.archiveData.resolveLine(book.title), icon: 'book', hasUnread: false },
        startX + col * (PLAQUE_W + PLAQUE_GAP),
        startY + row * (PLAQUE_H + ROW_GAP),
      );
    });

    // 焦点项：木牌在前、窗体件在后（setItems 无历史焦点时落到第一项，先排木牌就不会开在 ✕ 上）。
    // 返回书架的重建走同一条路，`setItems` 按 id 把焦点放回刚看完的那本书。
    this.focus.setItems([...this.focusPlaques, ...this.focusChrome]);
    if (!this.focusInit) {
      // 默认焦点落第一本（书架的"最常用那一项"），不是左上角的 ✕
      const first = this.focusPlaques[0];
      if (first) this.focus.focusDefault(first.id);
      this.focusInit = true;
    }
    // setItems 按同 id 复位时不会重放 onFocus（currentId 没变），新一批显示对象拿不到高亮 → 补一次
    this.focus.current?.onFocus(true);

    this.renderer.uiLayer.addChild(this.container);
    fadeIn(this.container);
  }

  /**
   * 一块竖立木牌：木框 + 暗底 + 顶端木刻图标 + 竖排书名，右上角未读红点。
   * 悬停时整块铺一层琥珀（`drawSelectedRow`），书名同步转 `colors.title`——
   * 设计稿里"选中"是点亮一档，不是换个深色。
   */
  private drawBookSlot(slot: BookSlot, x: number, y: number): void {
    const plaque = new Container();
    plaque.position.set(x, y);

    // 牌面压到书本底色：nameplate 原本的 panelBgAlt 在近黑面板上会浮成一块浅卡片，
    // 木框反而被牌面盖过去——木牌要的是"框亮、面暗"。
    plaque.addChild(createPanel(0, 0, PLAQUE_W, PLAQUE_H, SKINS.nameplate, {
      fill: UITheme.colors.bookBg,
      fillAlpha: UITheme.alpha.panelBg,
    }));

    const glow = new Graphics();
    drawSelectedRow(glow, GLOW_INSET, GLOW_INSET, PLAQUE_W - GLOW_INSET * 2, PLAQUE_H - GLOW_INSET * 2);
    glow.alpha = 0;
    glow.eventMode = 'none';
    plaque.addChild(glow);

    // 图标压暗一档：它是书名的陪衬，跟书名同亮度会把牌面看花
    const icon = createIcon(slot.icon, ICON_SIZE, UITheme.colors.goldDim);
    const iconBlock = icon ? ICON_SIZE + UITheme.spacing.sm : 0;

    // 竖排书名要吃得下长书名（《雾津县风物志》九个字）：按 SPINE_STEPS 从大到小挑
    // 第一档排得下的字号 + 配套行距。书名是这块牌子上唯一的主角，能大就别降档。
    const glyphs = Array.from(slot.label.trim()).length || 1;
    const room = PLAQUE_H - UITheme.spacing.md * 2 - iconBlock;
    const { size: spineSize, lineH } = pickSpineStyle(glyphs, room);

    // **整块（图标 + 书名）竖向居中**，不是从顶端往下排。
    // 三字书名按顶排会吊在牌子上半截、下面空掉四成——牌面越高越难看；
    // 长书名则照旧几乎铺满，居中对它是零影响。
    const blockH = iconBlock + glyphs * lineH;
    const blockTop = Math.max(UITheme.spacing.md, Math.round((PLAQUE_H - blockH) / 2));

    if (icon) {
      icon.position.set(Math.round((PLAQUE_W - ICON_SIZE) / 2), blockTop);
      plaque.addChild(icon);
    }

    const label = createStyledText({
      text: verticalize(slot.label),
      style: {
        fontSize: spineSize,
        fill: UITheme.colors.bookLabel,
        fontFamily: UITheme.fonts.display,
        fontWeight: 'bold',
        align: 'center',
        lineHeight: lineH,
      },
    });
    label.x = Math.round((PLAQUE_W - label.width) / 2);
    label.y = blockTop + iconBlock;
    label.eventMode = 'none';
    plaque.addChild(label);

    if (slot.hasUnread) {
      const dot = new Graphics();
      dot.circle(PLAQUE_W - UITheme.spacing.lg, UITheme.spacing.lg, 4);
      dot.fill(UITheme.colors.redDot);
      dot.eventMode = 'none';
      plaque.addChild(dot);
    }

    // 整块命中：Pixi 是逐子元素命中测试，靠木框/文字接指针会在留白处留死区
    const hit = new Graphics();
    hit.rect(0, 0, PLAQUE_W, PLAQUE_H);
    hit.fill({ color: 0xffffff, alpha: UITheme.alpha.hitArea });
    hit.eventMode = 'static';
    hit.cursor = 'pointer';
    hit.on('pointerdown', () => this.onBookClick(slot.id));
    // 悬停即移焦：鼠标与手柄共用同一个"当前项"，高亮统一由 onFocus 画（就是原来的悬停画法）。
    // 原先的 pointerout 复位去掉了——移开鼠标不该把唯一的焦点擦掉，焦点恒有一个可见。
    hit.on('pointerover', () => this.focus.syncHover(slot.id));
    plaque.addChild(hit);

    this.focusPlaques.push({
      id: slot.id,
      x, y, w: PLAQUE_W, h: PLAQUE_H,
      group: 'plaques',
      // 焦点高亮 = 这块牌子原本的悬停画法（琥珀铺光 + 书名转 title），不另发明焦点框
      onFocus: (on) => {
        if (glow.destroyed || label.destroyed) return;
        glow.alpha = on ? 0.85 : 0;
        label.style.fill = on ? UITheme.colors.title : UITheme.colors.bookLabel;
      },
      onActivate: () => this.onBookClick(slot.id),
    });

    this.container?.addChild(plaque);
  }

  /**
   * 底部居中的方框键帽（设计稿的「[B] 关闭」）。**必须真的可点**——
   * 旧实现是贴右下角的一行小灰字，纯鼠标玩家全靠它退出书架。
   */
  private buildCloseHint(px: number, py: number, panelH: number): Container {
    const raw = this.strings.get('bookshelf', 'closeHint');
    const m = /^按\s*(\S+?)\s*(.*)$/.exec(raw);
    const row = m && m[2] ? createKeyCap(m[1], m[2]) : createKeyCap(raw.replace(/[[\]]/g, ''));
    const rx = px + Math.round((PANEL_W - row.totalWidth) / 2);
    const ry = py + panelH - FOOTER_H + UITheme.spacing.lg;
    row.position.set(rx, ry);
    row.eventMode = 'static';
    row.cursor = 'pointer';
    row.on('pointerover', () => this.focus.syncHover('closeHint'));
    row.on('pointerdown', (e: { nativeEvent?: unknown }) => {
      markPointerConsumed(e.nativeEvent);
      this.requestClose();
    });
    this.focusChrome.push({
      id: 'closeHint',
      x: rx, y: ry, w: row.totalWidth, h: row.height,
      // 键帽自己一组：与 ✕ 同组的话，从 ✕ 按下会直接跳到面板底部、把整架书跳过去
      group: 'closeHint',
      onFocus: (on) => { if (!row.destroyed) row.alpha = on ? 0.75 : 1; },
      onActivate: () => this.requestClose(),
    });
    return row;
  }

  /** ✕ 纯程序化绘制，与 UIWindow 的那枚同形（无图标素材，且合「民俗草根·极简」方向）。 */
  private buildCloseButton(cx: number, cy: number): Container {
    const c = new Container();
    const hit = new Graphics();
    hit.rect(-14, -14, 28, 28);
    hit.fill({ color: 0xffffff, alpha: UITheme.alpha.hitArea });
    c.addChild(hit);
    const glyph = new Graphics();
    glyph.moveTo(-5, -5); glyph.lineTo(5, 5);
    glyph.moveTo(5, -5); glyph.lineTo(-5, 5);
    // 收进暖色系：亮白粗 ✕ 会是整块面板上唯一的纯白，抢眼且不合调性
    glyph.stroke({ color: UITheme.colors.hairline, width: 1.2 });
    glyph.alpha = 0.7;
    c.addChild(glyph);
    c.position.set(cx, cy);
    c.eventMode = 'static';
    c.cursor = 'pointer';
    c.on('pointerover', () => this.focus.syncHover('close'));
    c.on('pointerdown', (e) => {
      markPointerConsumed((e as { nativeEvent?: unknown }).nativeEvent);
      this.requestClose();
    });
    this.focusChrome.push({
      id: 'close',
      x: cx - 14, y: cy - 14, w: 28, h: 28,
      group: 'close',
      // 焦点高亮 = ✕ 原本的悬停画法（转 title 色 + 提亮）
      onFocus: (on) => {
        if (glyph.destroyed) return;
        glyph.tint = on ? UITheme.colors.title : 0xffffff;
        glyph.alpha = on ? 1 : 0.7;
      },
      onActivate: () => this.requestClose(),
    });
    return c;
  }

  /**
   * ✕ /「按 B 关闭」的关闭入口。由 Game 注入 `stateController.closePanel('bookshelf')`——
   * 精确寻址、弹栈、恢复状态。**不能直接 close()**（绕过弹栈 → 状态滞留 UIOverlay → 软锁）。
   */
  private requestClose(): void {
    this.closeRequester?.();
  }

  /** 由 Game 注入关闭通道（构造签名不变；与 setResolveDisplay 同一注入范式）。 */
  setCloseRequester(fn: (() => void) | null): void {
    this.closeRequester = fn;
  }

  private onBookClick(bookId: string): void {
    this.closeSubPanel();

    if (bookId === 'rules') {
      this.close();
      this.onOpenRules();
      return;
    }

    if (bookId === 'character') {
      this.activeSubPanel = this.onOpenCharacters(() => {
        this.closeSubPanel();
        this.buildShelf();
      });
      this.destroyShelfOnly();
      return;
    }

    if (bookId === 'lore') {
      this.activeSubPanel = this.onOpenLore(() => {
        this.closeSubPanel();
        this.buildShelf();
      });
      this.destroyShelfOnly();
      return;
    }

    if (bookId === 'document') {
      this.activeSubPanel = this.onOpenDocuments(() => {
        this.closeSubPanel();
        this.buildShelf();
      });
      this.destroyShelfOnly();
      return;
    }

    if (bookId === 'slang') {
      this.activeSubPanel = this.onOpenSlang(() => {
        this.closeSubPanel();
        this.buildShelf();
      });
      this.destroyShelfOnly();
      return;
    }

    if (bookId === 'rhyme') {
      this.activeSubPanel = this.onOpenRhymes(() => {
        this.closeSubPanel();
        this.buildShelf();
      });
      this.destroyShelfOnly();
      return;
    }

    if (bookId.startsWith('book_')) {
      const realId = bookId.substring(5);
      const books = this.archiveData.getBooks();
      const book = books.find(b => b.id === realId);
      if (book) {
        this.activeSubPanel = this.onOpenBook(book, () => {
          this.closeSubPanel();
          this.buildShelf();
        });
        this.destroyShelfOnly();
      }
    }
  }

  private closeSubPanel(): void {
    if (this.activeSubPanel) {
      this.activeSubPanel.close();
      this.activeSubPanel = null;
    }
  }

  private destroyShelfOnly(): void {
    if (this.container) {
      if (this.container.parent) this.container.parent.removeChild(this.container);
      this.container.destroy({ children: true });
      this.container = null;
    }
  }

  private destroyUI(): void {
    this.destroyShelfOnly();
  }

  destroy(): void {
    this.close();
    // close() 对已关闭的书架是 no-op，焦点/监听在这里再兜一次，重 open 与首次一致
    window.removeEventListener('keydown', this.onKeyBound);
    this.focus.destroy();
    this.focusPlaques = [];
    this.focusChrome = [];
    this.focusInit = false;
  }
}
