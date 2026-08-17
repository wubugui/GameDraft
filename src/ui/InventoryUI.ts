import { Assets, Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import { UITheme } from './UITheme';
import { drawPanelBase, SKINS } from './PanelSkin';
import { markPointerConsumed } from './uiPointerCoords';
import { UIWindow, WINDOW_CHROME } from './components/UIWindow';
import { UIScrollView } from './components/UIScrollView';
import { UIButton } from './components/UIButton';
import { openConfirmDialog } from './components/UIConfirmDialog';
import { createIcon, createKeyCap, createRule, createSlot } from './components/UIDecor';
import { UIFocus, type FocusItem } from './components/UIFocus';
import { mediaUrlFromShortPath } from '../core/projectPaths';
import type { Renderer } from '../rendering/Renderer';
import type { EventBus } from '../core/EventBus';
import type { StringsProvider } from '../core/StringsProvider';
import type { IInventoryDataProvider, ItemDef, ResolvedItemUse } from '../data/types';
import { createStyledText } from '../core/styledText';

/**
 * 包袱面板。窗体/滚动/按钮三件套走组件层，观感对齐设计稿
 * （`tmp/ui_mockups_2026-08-03/04_inventory_ui_design.png` / `09_ingame_inventory_overlay.png`）：
 *
 *   横向大面板 · 居中大标题 + 两翼渐隐横线 · 右上角铜钱读数 · 左侧 4×3 圆角格网
 *   · 中间一条极淡竖分隔 · 右侧**无框**详情栏（名 → 细线 → 描述 → 小标签块）
 *   · 底部居中「[I] 关闭」键帽。
 *
 * 三处早先修过的行为一并保住：
 * 1. 格子图标走 `ItemDef.icon` → `Assets.load` 异步加载，**没图标退回物品名文字**（留空是合法数据）。
 * 2. 关键道具的金色角标**不分有图无图一律画**——只在文字分支里靠金字表达 key，会让有图的
 *    key 在网格里毫无标识，同一个网格两套语言。
 * 3. 恒有选中项（进面板自动选第一件、丢弃后顺延），空包袱则不画详情栏、网格居中占满。
 */

/**
 * 网格列数。**与 `InventoryManager.MAX_SLOTS`(12) 对齐成 4×3**（格数不变，只是换了排布）。
 *
 * 曾经是 6×2，问题出在面板高度不由内容定：`UIWindow` 有占屏下限（`MIN_H_PCT` 0.62），
 * 面板恒被拉到屏高的六成以上，而两排格子只有 ~130px 高——左栏格子底下白空 200 多，
 * 看着就是"格子画少了"。改成 4×3 后：单格由宽度反算能吃到上限 84（原来只有 ~61，
 * 图标更小），三排正好把左栏铺满。
 *
 * 改列数要同时想清楚容量：显示格数 = max(容量, 实际件数)，**别让显示格数超过真实容量**
 * （"显示 18 格实际只背得动 12 件"是误导）。
 */
const GRID_COLS = 4;
/**
 * 物品格边长的**上下限**。真实边长在 `build()` 里按面板可用宽反算（见 {@link InventoryUI.cell}）——
 * 面板尺寸现在是屏幕的函数（UIWindow 有占屏下限），格子写死就会在大面板里缩成一小撮、
 * 底下空出一大块。下限守住图标还看得清，上限防止四个格子胖成四块板。
 */
const CELL_MIN = 56;
const CELL_MAX = 84;
const CELL_GAP = 10;
/** 与 InventoryManager 的槽位上限一致：格子网格恒画满 12 格（少于 12 件时留空格） */
const MAX_SLOTS = 12;
/** 选中格的外圈柔光向外扩 2px：网格整体内缩同样的量，免得最左/最上一列的光被滚动遮罩切掉 */
const GRID_INSET = 2;
/** 网格视口：网格 + 柔光余量 + 右侧滚动条的道 */
/**
 * 设计稿是一块横向大面板（宽约高的 1.8 倍），不是竖着的小抽屉。
 *
 * 700 时右侧详情栏只剩 278px：20px 的正文一行**只放得下 13 个字**，长描述（旧帕子包）
 * 被排成一条细面条（取景图 inv2_inventory_v3_longdesc）。加宽的量全部落到详情栏
 * （网格宽度由格子尺寸定死，不随面板走），一行进到 16 字；760×420 也正好是稿子那个 1.8 的比例。
 */
const PANEL_W = 760;
/**
 * UIWindow 的标题栏高 + 底部内边距（用于按内容高反推窗高；排版仍回读 win.bodyWidth/bodyHeight）。
 *
 * ⚠ **必须从 `WINDOW_CHROME` 现取，不许再写死数字**：这里原本硬编码 64，是标题还是小字条
 * 那会儿的值；标题涨到 display 档后窗体件实际占 76+20=96，于是窗子比内容矮 32px——
 * 底部「[I] 关闭」键帽被挤到木框上、一半探到面板外（取景图 inv2_inventory_v0 里看得很清楚）。
 */
const WINDOW_CHROME_H = WINDOW_CHROME.titleBarHeight + UITheme.spacing.xl;
/** UIWindow 的标题栏高：铜钱读数要摆回标题那一行（body 的负 y），与 ✕/副标题同一基线 */
const TITLE_BAR_H = WINDOW_CHROME.titleBarHeight;
/** ✕ 的命中宽 + 呼吸位。铜钱读数右沿必须让开它，否则长数字会压到关闭键上 */
const CLOSE_RESERVE = WINDOW_CHROME.closeHit + UITheme.spacing.sm;
/** 网格区（不含底部关闭提示带）的高度上下限：太矮详情栏挤不下，太高又会把空格子拉成一片空地 */
const GRID_AREA_MIN = 260;
const GRID_AREA_MAX = 340;
/** 底部提示带：一条通栏细线 + 居中键帽（键帽本体约 28 高，留够上下呼吸） */
const FOOTER_H = 56;
/** 格子里图标的方框边长（四周留出边框呼吸位） */
/** 图标盒相对格子的内缩（格子边长运行期才知道，所以留比例不留绝对值） */
const CELL_ICON_INSET = UITheme.spacing.sm * 2;
/** 详情栏底部的小标签块（关键 / 数量）：small 档文字约 22 高，块高再加两侧呼吸 */
const TAG_H = 28;
/** 丢弃按钮：设计稿右栏本来只有文字，所以这枚破坏性操作按钮做成贴左下的小键，不铺满整栏 */
const DISCARD_BTN_H = 34;
const DISCARD_BTN_W = 104;
/** 使用按钮：与丢弃同尺寸，叠在它上方——两枚小键对齐成一列，不并排（右栏窄时并排会挤出栏外） */
const USE_BTN_H = 34;
const USE_BTN_W = 104;

/**
 * 描述正文的行距。**行距必须跟着字号走**：20px 的正文配原来那个 22 的行距等于没有行距，
 * 中文方块字会挤成一坨墨。1.5 倍是中文正文的常规下限。
 * 描述视口高也按它取整（见 buildDetail），两处必须同源。
 */
function descLineHeight(): number {
  return Math.round(UITheme.fontSize.body * 1.5);
}

export class InventoryUI {
  private renderer: Renderer;
  private closeRequester: (() => void) | null = null;
  private eventBus: EventBus;
  private strings: StringsProvider;
  private inventoryData: IInventoryDataProvider;
  private win: UIWindow | null = null;
  private grid: UIScrollView | null = null;
  private descView: UIScrollView | null = null;
  private _isOpen: boolean = false;
  private resolveDisplay: ((s: string) => string) | null = null;
  /** 当前选中的物品 id；build 时若已不在包里会自动顺延到第一件 */
  private selectedId: string | null = null;
  /** 物品格边长：`build()` 里按面板实际可用宽反算（见 CELL_MIN/CELL_MAX 的说明） */
  private cell = CELL_MIN;
  /**
   * 键盘/手柄焦点。三组：`grid` 物品格（4×3 二维空间导航）/ `actions` 右栏丢弃钮 /
   * `footer` 底部关闭键帽——不分组的话上下键会在格子与按钮之间乱跳。
   * 高亮一律复用元素已有画法：格子是悬停金描边、按钮是 setSelected、键帽是变淡。
   */
  private focus = new UIFocus();
  /** 当前 build 攒出来的焦点项；fillGrid/buildDetail/buildFooter 往里推，build() 收尾统一喂 */
  private focusItems: FocusItem[] = [];
  private onKeyBound: (e: KeyboardEvent) => void;

  /**
   * 图标纹理缓存。**本类拿不到 AssetManager**（构造签名与 Game.ts 接线不改），
   * 故就近用 Pixi 的 `Assets`（AssetManager 底层也是它，且自带全局纹理缓存）。
   * value 为 null 表示"加载失败，别再试"——否则每次重绘都会再发一次请求。
   */
  private iconTex: Map<string, Texture | null> = new Map();
  private iconLoading: Set<string> = new Set();
  private iconRefreshQueued = false;

  constructor(renderer: Renderer, eventBus: EventBus, inventoryData: IInventoryDataProvider, strings: StringsProvider) {
    this.renderer = renderer;
    this.eventBus = eventBus;
    this.inventoryData = inventoryData;
    this.strings = strings;
    this.onKeyBound = (e) => this.onKey(e);
  }

  setResolveDisplay(fn: ((s: string) => string) | null): void {
    this.resolveDisplay = fn;
  }

  private r(s: string): string {
    return this.resolveDisplay ? this.resolveDisplay(s) : s;
  }

  get isOpen(): boolean {
    return this._isOpen;
  }

  open(): void {
    if (this._isOpen) return;
    this._isOpen = true;
    this.build(true);
    // 方向键/回车走 UIFocus（网格二维导航），与书架/用规矩同一范式；Esc/I 归全局关闭通道
    window.addEventListener('keydown', this.onKeyBound);
  }

  close(): void {
    if (!this._isOpen) return;
    this._isOpen = false;
    window.removeEventListener('keydown', this.onKeyBound);
    // 关场淡出（绕开重建路径共用的瞬时 destroyUI）：先摘两块滚动区的输入面，
    // 再让窗体带视觉淡出自毁——逻辑态已同步落定，尸体窗只是视觉。
    this.descView?.detachInput();
    this.grid?.detachInput();
    const win = this.win;
    this.descView = null;
    this.grid = null;
    this.win = null;
    win?.fadeOutAndDestroy();
    this.focus.destroy();
  }

  /**
   * 键盘/手柄：**焦点优先，滚动兜底**。方向键先交给 UIFocus 在格子/丢弃/关闭之间挪焦点，
   * 挪不动才让给网格滚动区（critical 给予溢出 12 槽时网格真的会滚）；两级都没吃下的按键
   * **一律不吞**（Esc / I 关面板等全局快捷键）。确认框（丢弃）打开期间键盘事件在
   * window capture 阶段就被它吞掉，这里天然收不到，无需配合。
   */
  private onKey(e: KeyboardEvent): void {
    if (!this._isOpen) return;
    if (this.focus.handleKey(e.code)) {
      e.preventDefault();
      return;
    }
    const grid = this.grid;
    if (!grid) return;
    const before = grid.scrollOffset;
    if (!grid.handleKey(e.code)) return;
    if (grid.scrollOffset !== before) e.preventDefault();
  }

  private sound = (name: 'hover' | 'press' | 'cancel'): void => {
    if (name === 'hover') this.eventBus.emit('ui:hover', {});
  };

  /**
   * ✕ /「按 I 关闭」的关闭入口。
   *
   * **不能直接 this.close()**：本面板由 GameStateController 注册，自关会绕过弹栈恢复，
   * 状态滞留 UIOverlay = 不可恢复软锁（R11）。
   *
   * 由 `Game` 注入 `stateController.closePanel('inventory')`——精确寻址、弹栈、恢复状态。
   * 早期版本靠「补发一次 Escape」实现，已被审查证伪：F2 调试坞开着时 Escape 分支抢在
   * handleEscape 之前，点 ✕ 会**去关调试坞**；状态一旦漂离 UIOverlay，它要么变死按钮，
   * 要么在 Exploring 下**弹出暂停菜单压在本面板上**、把 overlayReturnStack 叠歪。
   */
  private requestClose(): void {
    this.closeRequester?.();
  }

  /** 由 Game 注入关闭通道（构造签名不变；与 setResolveDisplay 同一注入范式）。 */
  setCloseRequester(fn: (() => void) | null): void {
    this.closeRequester = fn;
  }

  /**
   * @param animate 仅首次打开为 true。点格子/丢弃触发的重建必须走 `win.attach()`，
   * 否则每点一格都重放一遍开场动画；而**忘了挂载**会让整个包袱从画面消失。
   */
  private build(animate = false): void {
    const keepScroll = this.grid?.scrollOffset ?? 0;
    // 重建前记一下"焦点是否已在手上"：点格子/丢弃/图标到位触发的重建要按 id 复位，
    // 只有首开（focus 还空着）才落默认焦点
    const hadFocus = this.focus.current !== null;
    this.destroyUI();
    this.focusItems = [];

    const items = this.inventoryData.getAllItems();
    // critical 给予（关键道具保底）可临时超过 12 槽——网格按实际物品数增行，溢出物品不隐身
    const slotCount = Math.max(MAX_SLOTS, items.length);
    const rows = Math.ceil(slotCount / GRID_COLS);
    // 先按最小格算一个"请求高度"给窗体；窗体自己还有占屏下限，真实可用区在建完之后回读。
    const reqGridH = Math.max(
      GRID_AREA_MIN,
      Math.min(rows * CELL_MIN + (rows - 1) * CELL_GAP + UITheme.spacing.xl, GRID_AREA_MAX),
    );

    // 恒有选中项：详情栏不再出现"选中前一片虚无"的状态
    if (!this.selectedId || !items.some(i => i.id === this.selectedId)) {
      this.selectedId = items.length > 0 ? items[0].id : null;
    }

    const win = new UIWindow(this.renderer, {
      size: { width: PANEL_W, height: reqGridH + FOOTER_H + WINDOW_CHROME_H },
      title: this.strings.get('inventory', 'title'),
      // 副标题与底部关闭提示都不走 UIWindow：设计稿里右上角是「铜钱图标 + 读数」、
      // 底部是面板**内**居中的键帽，两者都要自己摆（见 buildCoinRow / buildFooter）。
      onClose: () => this.requestClose(),
      onSound: this.sound,
    });
    this.win = win;

    this.buildCoinRow(win);

    // ── 内容按**窗体实际可用区**反算，不用建窗前那份请求值。
    // 窗体有占屏下限（分辨率自适应），实际给到的往往比请求的大；照请求值排就会
    // 在大面板里留出一块死区——面板变大反而更难看。
    const hasDetail = this.selectedId !== null;
    const gridAreaH = win.bodyHeight - FOOTER_H;
    // 网格列占内容区的宽度比：有详情栏时让出右半；空包袱时整块给网格
    const gridColW = hasDetail ? Math.round(win.bodyWidth * 0.52) : win.bodyWidth;
    // 格边长同时受**宽**与**高**约束：只按宽反算的话，矮面板上三排格子会顶穿网格区
    // （变成要滚动才看得全的一小片）；只按高也一样会溢出右栏。两头取小、再夹回上下限。
    const byWidth = Math.floor(
      (gridColW - GRID_INSET * 2 - UITheme.spacing.sm - (GRID_COLS - 1) * CELL_GAP) / GRID_COLS,
    );
    const byHeight = Math.floor((gridAreaH - GRID_INSET * 2 - (rows - 1) * CELL_GAP) / rows);
    const cell = Math.max(CELL_MIN, Math.min(CELL_MAX, byWidth, byHeight));
    this.cell = cell;
    const gridViewW = GRID_COLS * cell + (GRID_COLS - 1) * CELL_GAP + GRID_INSET * 2 + UITheme.spacing.sm;
    const gridContentH = rows * cell + (rows - 1) * CELL_GAP;

    const gridX = hasDetail ? 0 : Math.round((win.bodyWidth - gridViewW) / 2);
    const dividerX = gridViewW + UITheme.spacing.lg;
    const detailX = dividerX + UITheme.spacing.xl;
    const detailW = win.bodyWidth - detailX;
    // 滚轮分栏：鼠标在网格上滚格子、在详情栏上滚正文。
    // 边界**每次现读** win.body.x —— 窗口 resize 会重算居中位移，捕获成常量会让判据错位。
    const splitX = (): number => (this.win?.body.x ?? 0) + dividerX;

    // 网格**顶对齐**，与右栏物品名同一条起跑线。
    // （曾经是竖向居中——那是格子小、区域也矮时的权宜；现在面板有占屏下限、区域比网格高得多，
    //  再居中就变成上下各空一块，两块空白比一块更难看。）
    const gridViewH = Math.min(gridContentH + GRID_INSET * 2, gridAreaH);
    const gridY = 0;
    const grid = new UIScrollView(this.renderer, {
      width: gridViewW,
      height: gridViewH,
      hitTest: hasDetail ? (x) => x < splitX() : undefined,
    });
    grid.container.position.set(gridX, gridY);
    win.body.addChild(grid.container);
    this.grid = grid;

    this.fillGrid(items, slotCount);
    grid.scrollOffset = keepScroll;

    if (hasDetail) {
      // 两栏之间只有一条极淡的竖线（设计稿里没有第二个框）：横线旋转 90° 即得两端渐隐的竖线。
      // ⚠ `createRule` 的 color/alpha 形参被 `UITheme as const` 推成了**字面量类型**（见报告），
      //    传别的色号编译不过，这里只能用缺省的 titleRule——好在正是要的那条暗铜线。
      const divider = createRule(gridAreaH);
      divider.rotation = Math.PI / 2;
      divider.position.set(dividerX, 0);
      win.body.addChild(divider);

      this.buildDetail(win, detailX, detailW, gridAreaH, splitX);
    }

    this.buildFooter(win, gridAreaH);

    // 焦点项整批重喂：重建按 id 复位（id 没了落到几何最近一格，丢弃后正好是顺延的那件）。
    // 默认焦点 = 当前选中格（build 前面已保证 selectedId 非空时必在包里）；
    // 空包无格时 focusItems 只剩关闭键帽，setItems 落在它身上（UIFocus 空列表也安全）。
    this.focus.setItems(this.focusItems);
    if (!hadFocus && this.selectedId) this.focus.focusDefault(`item:${this.selectedId}`);
    // setItems 按同 id 复位时不重放 onFocus，新一批显示对象拿不到高亮 → 补一次
    this.focus.current?.onFocus(true);

    if (animate) win.open();
    else win.attach();
  }

  /**
   * 右上角的铜钱读数：木刻铜钱图标 + 「铜钱: N」。
   *
   * 摆在 `win.body` 的**负 y** 上 = 回到标题栏那一行（body 原点在标题栏之下），
   * 与 UIWindow 自己的副标题同一基线、同样给 ✕ 让出 CLOSE_RESERVE。
   * 走 body 而不是 chrome 是因为 chrome 每次 resize 会整体重建，外部塞的东西会被清掉。
   *
   * 图标素材没到位时 `createIcon` 返回 null——此时只画文字，位置照样成立。
   */
  private buildCoinRow(win: UIWindow): void {
    const row = new Container();

    const label = createStyledText({
      text: `${this.strings.get('inventory', 'coins')} ${this.inventoryData.getCoins()}`,
      style: {
        fontSize: UITheme.fontSize.body,
        fill: UITheme.colors.title,
        fontFamily: UITheme.fonts.ui,
      },
    });
    label.eventMode = 'none';

    // 图标与读数同取标题金：右上角这一处是面板上唯一的"数值"，与标题同色才不散。
    // ⚠ 尺寸跟着**它标的那行字**走（body 档 + 2），不是跟着 title 档：原来按 title-2=28 画，
    // 比它旁边 20px 的读数还大一圈，一个图标把整块读数的重心带跑了。
    const iconSize = UITheme.fontSize.body + 2;
    const icon = createIcon('coin', iconSize);
    let x = 0;
    if (icon) {
      icon.position.set(0, Math.round((label.height - iconSize) / 2));
      row.addChild(icon);
      x = iconSize + UITheme.spacing.sm;
    }
    label.x = x;
    row.addChild(label);

    row.eventMode = 'none';
    // 竖向与**标题顶沿**对齐（不是 UIWindow 副标题那个 +6 的基线）：居中标题两翼的渐隐横线
    // 挂在标题半高上，读数压在那个高度就会被一条线从数字中间穿过去（取景图 inv2_inventory_v1）。
    // 顶沿对齐后横线正好落在读数下方，读起来像给它加了条底线，也与 ✕ 同一水平。
    row.position.set(
      Math.round(win.bodyWidth - CLOSE_RESERVE - (x + label.width)),
      -TITLE_BAR_H + UITheme.spacing.md,
    );
    win.body.addChild(row);
  }

  /** 底部：一条通栏细线 + 居中的「[I] 关闭」键帽（**必须真的可点**，与 ✕ 同一关闭入口）。 */
  private buildFooter(win: UIWindow, top: number): void {
    const rule = createRule(win.bodyWidth);
    rule.position.set(0, top + UITheme.spacing.md);
    win.body.addChild(rule);

    // 文案沿用 strings 里配好的「按 I 关闭」，这里拆成键名 + 说明；拆不出来就整句当说明画，
    // 不因为一句没按套路的文案就漏掉出口（与 UIWindow.buildCloseHint 同一口径）。
    const raw = this.strings.get('inventory', 'closeHint');
    const m = /^按\s*(\S+?)\s*(.*)$/.exec(raw);
    const cap = m && m[2]
      ? createKeyCap(m[1], m[2])
      : createKeyCap(raw.replace(/[[\]]/g, ''), undefined);
    // 竖向**从内容区下沿夹一次**：窗高被 SCREEN_MARGIN 夹小时（矮屏 / 侧栏挤压）
    // 光按 top 往下量会把键帽推到木框上甚至推出面板，出口就此变成半截字。
    const capX = Math.round((win.bodyWidth - cap.totalWidth) / 2);
    const capY = Math.round(Math.min(top + UITheme.spacing.md * 2, win.bodyHeight - cap.height));
    cap.position.set(capX, capY);
    cap.eventMode = 'static';
    cap.cursor = 'pointer';
    cap.on('pointerover', () => { cap.alpha = 0.75; this.sound('hover'); this.focus.syncHover('close'); });
    // 移开时**只在焦点不在它身上**才复原：鼠标与手柄共用同一个"当前项"
    cap.on('pointerout', () => { if (this.focus.current?.id !== 'close') cap.alpha = 1; });
    cap.on('pointerdown', (e) => {
      markPointerConsumed((e as { nativeEvent?: unknown }).nativeEvent);
      this.sound('cancel');
      this.requestClose();
    });
    win.body.addChild(cap);
    // 键帽自成一组：与网格/丢弃同组的话，下键会从格子直接跳过丢弃钮落到面板底
    this.focusItems.push({
      id: 'close',
      x: capX, y: capY, w: cap.totalWidth, h: cap.height,
      group: 'footer',
      // 焦点高亮 = 键帽自己的 hover 画法（整枚变淡一档）
      onFocus: (on) => { if (!cap.destroyed) cap.alpha = on ? 0.75 : 1; },
      onActivate: () => { this.sound('cancel'); this.requestClose(); },
    });
  }

  private fillGrid(items: ReturnType<IInventoryDataProvider['getAllItems']>, slotCount: number): void {
    const grid = this.grid;
    if (!grid) return;

    for (let i = 0; i < slotCount; i++) {
      const col = i % GRID_COLS;
      const row = Math.floor(i / GRID_COLS);
      const cx = GRID_INSET + col * (this.cell + CELL_GAP);
      const cy = GRID_INSET + row * (this.cell + CELL_GAP);
      const item = i < items.length ? items[i] : null;
      const selected = !!item && item.id === this.selectedId;

      // 选中态 = 金描边 + 外圈柔光，**不换底色**：设计稿里空格与满格底色一致，全靠边框说话
      const cell = createSlot(this.cell, selected);
      cell.position.set(cx, cy);
      grid.content.addChild(cell);

      if (!item) continue;

      const icon = this.makeIconSprite(item.def, this.cell - CELL_ICON_INSET);
      if (icon) {
        icon.x = cx + Math.round((this.cell - icon.width) / 2);
        icon.y = cy + Math.round((this.cell - icon.height) / 2);
        grid.content.addChild(icon);
      } else {
        // 无图（或图还在路上）时的兜底：仍是物品名文字 + 逐格裁切，与旧实现一致
        const nameText = createStyledText({
          text: this.r(item.def?.name ?? item.id),
          style: {
            fontSize: UITheme.fontSize.micro,
            fill: item.def?.type === 'key' ? UITheme.colors.title : UITheme.colors.body,
            fontFamily: UITheme.fonts.ui,
            wordWrap: true, breakWords: true,
            wordWrapWidth: this.cell - UITheme.spacing.md,
          },
        });
        nameText.x = cx + UITheme.spacing.sm;
        nameText.y = cy + UITheme.spacing.sm;
        grid.content.addChild(nameText);

        const nameMask = new Graphics();
        nameMask.rect(cx, cy, this.cell, this.cell);
        nameMask.fill({ color: 0xffffff });
        grid.content.addChild(nameMask);
        nameText.mask = nameMask;
      }

      // 关键道具角标：**不分有图无图，一律画**。
      // 早期实现只在「无图退回文字」那条分支里靠金色字名表达 key，结果有图的 7 件 key
      // 在格子里完全没有任何标识——同一个网格两套语言。角标与图标/文字正交，两条路都成立。
      if (item.def?.type === 'key') {
        const mark = new Graphics();
        const m = UITheme.spacing.sm;
        // 直角边跟着格子走（约 1/8 边长）：写死 6px 时在 76px 的格上只是个几乎看不见的小豁口，
        // 「这是关键道具」这条信息传不到。它仍是角标，扫一眼级别，不该再大。
        const leg = Math.round(this.cell / 8);
        mark.moveTo(cx + this.cell - m - leg, cy + m);
        mark.lineTo(cx + this.cell - m, cy + m);
        mark.lineTo(cx + this.cell - m, cy + m + leg);
        mark.fill({ color: UITheme.colors.title });
        grid.content.addChild(mark);
      }

      // 数量压右下角（设计稿里就是一个贴角的小数字，不带 x）
      if (item.def?.type !== 'key' && item.count > 1) {
        const countText = createStyledText({
          text: `${item.count}`,
          style: {
            fontSize: UITheme.fontSize.micro, fill: UITheme.colors.bodyMuted,
            fontFamily: UITheme.fonts.ui,
          },
        });
        countText.x = cx + this.cell - countText.width - UITheme.spacing.sm;
        countText.y = cy + this.cell - countText.height - UITheme.spacing.xs;
        grid.content.addChild(countText);
      }

      // 悬停描边（不发悬停音：12 格密排的网格里，扫一下鼠标就是一串枪响）
      const hover = new Graphics();
      hover.roundRect(cx + 0.5, cy + 0.5, this.cell - 1, this.cell - 1, SKINS.slot.radius);
      hover.stroke({ color: UITheme.colors.gold, width: 1, alpha: 0.7 });
      hover.visible = false;
      grid.content.addChild(hover);

      // 命中区必须自己是一块 Graphics（Pixi 逐子元素命中测试，光给 Text 会漏点），
      // 且不能拿会被隐藏的图元当靶子
      const hit = new Graphics();
      hit.rect(cx, cy, this.cell, this.cell);
      hit.fill({ color: 0xffffff, alpha: UITheme.alpha.hitArea });
      hit.eventMode = 'static';
      hit.cursor = 'pointer';
      const fid = `item:${item.id}`;
      // 悬停即移焦：鼠标与手柄共用同一个"当前项"；移开时**只在焦点不在它身上**才熄描边
      // （抹掉就等于屏幕上没有焦点了）
      hit.on('pointerover', () => { hover.visible = true; this.focus.syncHover(fid); });
      hit.on('pointerout', () => { if (this.focus.current?.id !== fid) hover.visible = false; });
      hit.on('pointerdown', (e) => {
        markPointerConsumed((e as { nativeEvent?: unknown }).nativeEvent);
        if (this.selectedId === item.id) return;
        this.selectedId = item.id;
        this.build();
      });
      grid.content.addChild(hit);

      // 空格子不进焦点环（不可交互项不吃焦点），只登记有物品的格
      this.focusItems.push({
        id: fid,
        x: cx, y: cy, w: this.cell, h: this.cell,
        group: 'grid',
        // 焦点高亮 = 格子原有的悬停金描边；网格溢出滚动时焦点格要滚进视口
        onFocus: (on) => {
          if (!hover.destroyed) hover.visible = on;
          if (on) this.revealCell(cy);
        },
        // 回车/空格 = 选中该格（与 pointerdown 同一条路径：selectedId 换人 + build 重绘详情）
        onActivate: () => {
          if (this.selectedId === item.id) return;
          this.selectedId = item.id;
          this.build();
        },
      });
    }

    grid.refresh();
  }

  /** 焦点落到视口外的格子时滚进来（只在 critical 溢出 12 槽、网格真滚动时起作用）。 */
  private revealCell(cy: number): void {
    const grid = this.grid;
    if (!grid) return;
    const top = cy - GRID_INSET;
    const bottom = cy + this.cell + GRID_INSET;
    if (top < grid.scrollOffset) grid.scrollOffset = Math.max(0, top);
    else if (bottom > grid.scrollOffset + grid.viewportHeight) {
      grid.scrollOffset = bottom - grid.viewportHeight;
    }
  }

  /**
   * 右栏详情：**没有框**（设计稿里右栏只有文字与一条横线），自上而下
   * 物品名 → 名下细横线 → 可滚描述 → 底部小标签块 →（可丢弃时）丢弃按钮。
   */
  private buildDetail(
    win: UIWindow,
    detailX: number,
    detailW: number,
    areaH: number,
    splitX: () => number,
  ): void {
    const itemId = this.selectedId;
    if (!itemId) return;

    const box = new Container();
    box.position.set(detailX, 0);
    win.body.addChild(box);

    const def = this.inventoryData.getItemDef(itemId);
    const isKey = def?.type === 'key';
    const count = this.inventoryData.getItemCount(itemId);

    let y = UITheme.spacing.sm;

    const nameText = createStyledText({
      text: this.r(def?.name ?? itemId),
      style: {
        // 物品名是右栏的主角，但**是条目名不是面板标题**——它归 title 档。
        // 原来取 display（= 面板大标题「包袱」同一档），右栏一开口就和标题一样大，
        // 两个主角在一屏里互相抢戏，面板读起来没有主次；退一档后标题仍是全屏第一眼，
        // 物品名是"这一格是什么"的第二眼，正好。
        fontSize: UITheme.fontSize.title,
        // 暖白（关键道具转标题金）：设计稿里物品名是右栏唯一一处亮字
        fill: isKey ? UITheme.colors.title : UITheme.colors.speakerSelf,
        fontFamily: UITheme.fonts.display,
        letterSpacing: UITheme.letterSpacing.title,
        wordWrap: true, breakWords: true, wordWrapWidth: detailW,
      },
    });
    nameText.position.set(0, y);
    box.addChild(nameText);
    y += nameText.height + UITheme.spacing.sm;

    const nameRule = createRule(detailW);
    nameRule.position.set(0, y);
    box.addChild(nameRule);
    y += 1 + UITheme.spacing.md;

    // 底部几块（标签 / 使用 / 丢弃）自下而上占位，剩下的才是描述的可滚高度
    let bottom = areaH;
    const itemName = this.r(def?.name ?? itemId);
    const canDiscard = this.inventoryData.canDiscard(itemId);
    if (canDiscard) {
      bottom -= DISCARD_BTN_H;
      const discardW = Math.min(DISCARD_BTN_W, detailW);
      // 点按/回车共用同一个执行体。丢弃不可撤销（审查 P1 五条零确认路径之一）：过确认框再真丢
      const confirmDiscard = (): void => {
        void openConfirmDialog(this.renderer, {
          title: this.strings.get('confirm', 'discardTitle'),
          message: this.strings.get('confirm', 'discardBody', { name: itemName }),
          confirmLabel: this.strings.get('confirm', 'ok'),
          cancelLabel: this.strings.get('confirm', 'cancel'),
          onSound: this.sound,
        }).then((ok) => { if (ok) this.discard(itemId); });
      };
      const btn = new UIButton({
        label: this.strings.get('inventory', 'discard'),
        width: discardW,
        height: DISCARD_BTN_H,
        // 破坏性操作、贴在右栏左下的小键：按钮缺省的 bodyLarge 在 34 高的键里会顶满上下沿
        // （原来 26 高配 25px 字，字比键还高），退到 body 档才是"小键"的样子。
        fontSize: UITheme.fontSize.body,
        variant: 'danger',
        onPress: confirmDiscard,
        onSound: this.sound,
      });
      btn.container.position.set(0, bottom);
      btn.container.on('pointerover', () => this.focus.syncHover('discard'));
      box.addChild(btn.container);
      // 丢弃与网格分组：右键从网格末列跨过来（同组找不到才跨组），上下键不会在格子与按钮间乱跳。
      // 矩形取面板内容坐标系（box 挂在 detailX），与格子在同一套坐标里比距离。
      this.focusItems.push({
        id: 'discard',
        x: detailX, y: bottom, w: discardW, h: DISCARD_BTN_H,
        group: 'actions',
        // 焦点高亮 = UIButton 自己的常驻选中态
        onFocus: (on) => btn.setSelected(on),
        onActivate: confirmDiscard,
      });
      bottom -= UITheme.spacing.md;
    }

    /**
     * 使用键，叠在丢弃上方（主操作在上、破坏性操作在下）。
     *
     * 「能不能用」全读 `ResolvedItemUse`，**一条 action 都不跑**——跑一遍再看结果就成了
     * "点了才发现没反应"。不可用时按 ShopUI「买不起的行」同一范式：钮置灰 + 不进焦点环
     * （方向键跳过点不动的钮），另把理由摊成钮上方一行小字——**置灰的钮吞掉点击，
     * 理由若只挂在点击上就是彻底读不到的死信息**。
     */
    const use = this.inventoryData.resolveItemUse(itemId);
    if (use) {
      bottom -= USE_BTN_H;
      const useW = Math.min(USE_BTN_W, detailW);
      const useLabel = this.r(use.label);
      // 点按/回车共用同一个执行体（与丢弃同构）；使用同样会改变世界状态，过确认框再真用
      const confirmUse = (): void => {
        void openConfirmDialog(this.renderer, {
          title: this.strings.get('confirm', 'useTitle'),
          message: this.strings.get('confirm', 'useBody', { name: itemName, action: useLabel }),
          confirmLabel: this.strings.get('confirm', 'ok'),
          cancelLabel: this.strings.get('confirm', 'cancel'),
          onSound: this.sound,
        }).then((ok) => { if (ok) this.useItem(use); });
      };
      const useBtn = new UIButton({
        label: useLabel,
        width: useW,
        height: USE_BTN_H,
        // 与丢弃同档：34 高的小键配 bodyLarge 会顶满上下沿
        fontSize: UITheme.fontSize.body,
        variant: 'primary',
        disabled: !use.enabled,
        onPress: confirmUse,
        onSound: this.sound,
      });
      useBtn.container.position.set(0, bottom);
      box.addChild(useBtn.container);
      if (use.enabled) {
        useBtn.container.on('pointerover', () => this.focus.syncHover('use'));
        this.focusItems.push({
          id: 'use',
          x: detailX, y: bottom, w: useW, h: USE_BTN_H,
          group: 'actions',
          onFocus: (on) => useBtn.setSelected(on),
          onActivate: confirmUse,
        });
      }
      bottom -= UITheme.spacing.md;

      if (!use.enabled && use.disableReason) {
        const hint = createStyledText({
          text: this.r(use.disableReason),
          style: {
            fontSize: UITheme.fontSize.small,
            fill: UITheme.colors.disabled,
            fontFamily: UITheme.fonts.ui,
            wordWrap: true, breakWords: true, wordWrapWidth: detailW,
          },
        });
        // 先量后放：理由可能折成两行，写死一个高度会把它压进按钮里
        bottom -= Math.round(hint.height);
        hint.position.set(0, bottom);
        hint.eventMode = 'none';
        box.addChild(hint);
        bottom -= UITheme.spacing.sm;
      }
    }

    const tags = this.detailTags(isKey, count);
    if (tags.length > 0) {
      bottom -= TAG_H;
      box.addChild(this.buildTagRow(tags, bottom));
      bottom -= UITheme.spacing.md;
    }

    // 长描述（如旧帕子包）此前被遮罩硬切、后半段读不到；现在是可滚正文。
    // 视口高**取整到整行**：否则遮罩恒在半个字高处切一刀，末行永远是被横切一半的残字。
    // 余下的零头（< 一行）让给标签块上方的间距，不会浪费。
    const lineH = descLineHeight();
    const descH = Math.max(lineH, Math.floor(Math.max(lineH, bottom - y) / lineH) * lineH);
    const descView = new UIScrollView(this.renderer, {
      width: detailW,
      height: descH,
      hitTest: (x) => x >= splitX(),
    });
    descView.container.position.set(0, y);
    box.addChild(descView.container);
    this.descView = descView;

    const descText = createStyledText({
      text: this.r(this.inventoryData.getItemDescription(itemId) || this.strings.get('inventory', 'noDesc')),
      style: {
        fontSize: UITheme.fontSize.body, fill: UITheme.colors.descText,
        fontFamily: UITheme.fonts.ui,
        wordWrap: true, breakWords: true,
        wordWrapWidth: detailW - UITheme.spacing.md,
        lineHeight: descLineHeight(),
      },
    });
    descView.content.addChild(descText);
    descView.refresh();
  }

  /**
   * 详情栏底部的小标签块。
   *
   * **只用手上真有的事实**（关键道具 / 堆叠数），不编造分类词——物品数据里没有品类字段，
   * 硬凑「近战 / 法器」那类标签就是拿假数据充版面。文案取自 strings，方括号是列表里的
   * 可点约定、进方块就多余，故去掉。
   */
  private detailTags(isKey: boolean, count: number): { text: string; color: number }[] {
    const tags: { text: string; color: number }[] = [];
    if (isKey) {
      tags.push({
        text: this.strings.get('inventory', 'keyItem').replace(/^\[|\]$/g, ''),
        color: UITheme.colors.title,
      });
    }
    if (!isKey && count > 1) {
      tags.push({ text: `x${count}`, color: UITheme.colors.bodyMuted });
    }
    return tags;
  }

  private buildTagRow(tags: { text: string; color: number }[], y: number): Container {
    const row = new Container();
    const g = new Graphics();
    row.addChild(g);

    let x = 0;
    for (const tag of tags) {
      const t = createStyledText({
        text: tag.text,
        // 标签块是"状态词"（关键 / x99），归 small 档：micro 是给贴在格子角上的
        // 计数用的，搬到独立的方块里就小得像脚注、方块本身反而比字更抢眼。
        style: { fontSize: UITheme.fontSize.small, fill: tag.color, fontFamily: UITheme.fonts.ui },
      });
      const w = Math.round(t.width) + UITheme.spacing.md * 2;
      drawPanelBase(g, x, y, w, TAG_H, SKINS.row);
      t.position.set(x + Math.round((w - t.width) / 2), y + Math.round((TAG_H - t.height) / 2));
      t.eventMode = 'none';
      row.addChild(t);
      x += w + UITheme.spacing.sm;
    }
    row.eventMode = 'none';
    return row;
  }

  /**
   * 使用物件：把**已求值**的使用态原样递给 EventBridge，UI 侧不碰 actions、不做扣除。
   *
   * 发完就不要再碰 `this`——`item:use` 的处理方在第一个 await 之前就会
   * `closePanel('inventory')`，即同步地把本面板关掉销毁（与 RuleUseUI 同一条通道语义）。
   */
  private useItem(use: ResolvedItemUse): void {
    if (!use.enabled) return;
    this.eventBus.emit('item:use', {
      itemId: use.itemId,
      consume: use.consume,
      actions: use.actions,
      resultText: use.resultText,
    });
  }

  private discard(itemId: string): void {
    // 与旧实现同一时序：emit 后立即重绘（inventoryDiscard 的执行体是同步的）。
    const idx = this.inventoryData.getAllItems().findIndex(i => i.id === itemId);
    this.eventBus.emit('inventory:discard', { itemId });
    // 丢完选中位**就地顺延**到原位置的物品（整条丢光就是后一件），不要甩回第一件
    const rest = this.inventoryData.getAllItems();
    this.selectedId = rest.length === 0
      ? null
      : rest[Math.min(Math.max(idx, 0), rest.length - 1)].id;
    this.build();
  }

  // --- 图标 --------------------------------------------------------------

  /** `def.icon` 有图且已加载 → 等比缩进 box 见方的 Sprite；否则 null（调用方退回文字）。 */
  private makeIconSprite(def: ItemDef | undefined, box: number): Sprite | null {
    const ref = def?.icon?.trim();
    if (!ref) return null;
    let url: string;
    try {
      url = mediaUrlFromShortPath(ref);
    } catch (e) {
      console.warn(`InventoryUI: 物品 ${def?.id} 的 icon 无法解析`, e);
      return null;
    }
    const tex = this.iconTexture(url);
    if (!tex || tex === Texture.EMPTY) return null;
    const sprite = new Sprite(tex);
    const k = Math.min(box / tex.width, box / tex.height, 1);
    sprite.width = Math.round(tex.width * k);
    sprite.height = Math.round(tex.height * k);
    return sprite;
  }

  private iconTexture(url: string): Texture | null {
    const cached = this.iconTex.get(url);
    if (cached !== undefined) return cached;
    if (this.iconLoading.has(url)) return null;
    this.iconLoading.add(url);
    Assets.load<Texture>(url)
      .then((tex) => { this.iconTex.set(url, tex ?? null); })
      .catch((e) => {
        console.warn(`InventoryUI: 图标加载失败 ${url}`, e);
        this.iconTex.set(url, null); // 记失败，避免每次重绘都重试
      })
      .finally(() => {
        this.iconLoading.delete(url);
        this.scheduleIconRefresh();
      });
    return null;
  }

  /** 图标是异步到的：到齐后就地重绘一次，否则首开永远停在文字兜底。 */
  private scheduleIconRefresh(): void {
    if (this.iconRefreshQueued) return;
    this.iconRefreshQueued = true;
    requestAnimationFrame(() => {
      this.iconRefreshQueued = false;
      if (this._isOpen && this.iconLoading.size === 0) this.build();
    });
  }

  private destroyUI(): void {
    this.descView?.destroy();
    this.grid?.destroy();
    this.win?.destroy();
    this.descView = null;
    this.grid = null;
    this.win = null;
  }

  destroy(): void {
    // 真销毁走瞬时路径（不经 close 的关场淡出），destroy 后重 open 与首次一致
    this._isOpen = false;
    window.removeEventListener('keydown', this.onKeyBound);
    this.destroyUI();
    this.focus.destroy();
    this.iconTex.clear();
    this.iconLoading.clear();
  }
}
