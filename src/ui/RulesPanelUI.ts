import { Container, Graphics, Text } from 'pixi.js';
import { UITheme } from './UITheme';
import { drawPanelBase, SKINS } from './PanelSkin';
import { createProgressBar, createRule, createTitleRow, drawSelectedRow } from './components/UIDecor';
import { markPointerConsumed } from './uiPointerCoords';
import { UIWindow, WINDOW_SIZES } from './components/UIWindow';
import { UIScrollView } from './components/UIScrollView';
import { UIFocus, type FocusItem } from './components/UIFocus';
import type { Renderer } from '../rendering/Renderer';
import type { IRulesDataProvider, RuleLayerKey } from '../data/types';
import type { StringsProvider } from '../core/StringsProvider';
import { createStyledText, ellipsizeStyledText, getStyledRaw, setStyledText } from '../core/styledText';
import { plainTextLength, sliceStyledMarkup } from '../core/textStyle';

/**
 * 规矩本（对齐 tmp/ui_mockups_2026-08-03/06_rulebook_ui_design.png）。
 *
 * 版式：一块 `SKINS.book` 面板中间一条极淡竖线分成两栏——
 * 左栏「规矩本」居中标题 + 带菱形节点的渐隐横线 + 规矩列表（状态圆点 / 规矩名 / 右侧状态词，
 * 行底是该状态色的极暗同色系，当前行整条铺琥珀）；右栏是选中那条的详情
 * （规矩名 → 横线 → 象/理/术分层正文 → 来源 → 底部收集进度 + 方正琥珀进度条）。
 *
 * **数据面一个字没动**：已掌握/搜集中两组、各层 verified、碎片进度全部仍旧问
 * `IRulesDataProvider`。此前「点一行展开碎片」的折叠态被选中态取代——展开要看的东西
 * （分层小计 / 碎片正文 / 来源 / ???）现在恒在右栏，且不再把左栏挤成一根手风琴。
 */

/**
 * 列表行。
 *
 * ⚠ 原来是 34（rowBodyH=30），而规矩名是 `bodyLarge`(25)、宋体中文实测字框约 33px——
 * 名字比行还高，字直接压在行的上下边框上。行高必须跟着字号走。
 */
const ROW_H = 46;
const ROW_GAP = 5;
/** 行首状态圆点（行长高了，点也跟着长一档，否则在一行里缩成一粒灰） */
const DOT_R = 5;
const DOT_X = 20;
/** 左栏占内容区的比例（设计稿是对开的两页，各一半） */
const LIST_RATIO = 0.48;
/**
 * 右栏底部「收集进度 + 进度条」那一块的高度。
 * 读数与标签都是 `small` 的状态条（不是标题），所以这块比正文矮一档，靠进度条本身出分量。
 */
const FOOTER_H = 40;
const PROGRESS_BAR_H = 10;
/**
 * 底部「按 R 关闭」键帽此前在这里手工预留 34px——**已收回 UIWindow**
 * （`closeHintReserve`：窗体自己按键帽实际行高把 `bodyHeight` 扣掉）。
 * 本面板只管把内容铺满 `bodyHeight` 即可，再减一次就是双重预留、白留一条空带。
 */
/** 行底色 = 状态色压到这个亮度（同色系**极暗**，不是统一灰；再高一档就成了发光的绿条） */
const ROW_TINT = 0.1;

const LAYER_ORDER: RuleLayerKey[] = ['xiang', 'li', 'shu'];

const VERIFIED_COLORS: Record<string, number> = {
  unverified: UITheme.colors.ruleUnverified,
  effective: UITheme.colors.ruleEffective,
  questionable: UITheme.colors.ruleQuestionable,
};

/** 主题色压暗到 k 倍亮度。**不是新色号**——只是从 UITheme 的状态色派生行底。 */
function dimColor(color: number, k: number): number {
  const r = Math.round(((color >> 16) & 0xff) * k);
  const g = Math.round(((color >> 8) & 0xff) * k);
  const b = Math.round((color & 0xff) * k);
  return (r << 16) | (g << 8) | b;
}

/** 列表行的焦点 id（与 `selectedId` 同源，重建后靠它把焦点放回原来那一条） */
function rowFocusId(id: string): string {
  return `row:${id}`;
}

interface RuleRow {
  id: string;
  name: string;
  /** 已掌握 = 各层 verified 汇总；搜集中 = 「搜集中」 */
  statusLabel: string;
  statusColor: number;
  /** true = 已掌握（右栏出分层正文）；false = 搜集中（右栏出碎片） */
  acquired: boolean;
  categoryName: string;
}

export class RulesPanelUI {
  private renderer: Renderer;
  private closeRequester: (() => void) | null = null;
  /**
   * 书架子面板模式：由书架用 `openAsSubPanel(onBack)` 拉起的那一份实例（**另建一份，
   * 不是 Game 注册给 R 键的那一个**——同一个实例两条打开路径会让 `closePanel('rules')`
   * 去弹书架压的那层栈，状态直接叠歪）。
   *
   * 这一份的出口不是"关面板"而是"退回书架"：底部提示写「返回书架」，✕ 与提示都回调
   * 书架给的 `onClose`，Esc 由书架的 `handleEscapeStep` 统一退一层——与其余六本书同一形状。
   */
  private backToShelf: (() => void) | null = null;
  private rulesData: IRulesDataProvider;
  private strings: StringsProvider;
  private win: UIWindow | null = null;
  private list: UIScrollView | null = null;
  private detail: UIScrollView | null = null;
  private _isOpen: boolean = false;
  private onKeyBound: (e: KeyboardEvent) => void;
  private resolveDisplay: ((s: string) => string) | null = null;
  /** 视图态：当前选中的规矩（不入档，与规矩数据无关） */
  private selectedId: string | null = null;
  /**
   * 键盘 / 手柄焦点。本面板只有**左栏规矩列表**一组可交互项（右栏是纯正文 + 钉底的
   * 进度条，没有可点的东西；✕ 与底部「按 R 关闭」由 UIWindow 自己画，面板拿不到句柄）。
   *
   * 高亮**复用行自己的选中画法**（`drawSelectedRow` 那层琥珀铺光 + 金描边），
   * 不另发明一种焦点框——全站观感刚统一过。
   */
  private focus = new UIFocus();

  constructor(renderer: Renderer, rulesData: IRulesDataProvider, strings: StringsProvider) {
    this.renderer = renderer;
    this.rulesData = rulesData;
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
    window.addEventListener('keydown', this.onKeyBound);
  }

  /**
   * 从书架打开（子面板语义）。规矩本既是 R 键的独立面板、又摆在书架上，
   * 但此前从书架点进来是 `书架.close() + 打开 rules 面板`——**书架没了、回不去**，
   * 而其余六本都能「返回书架」。既然它在架上，就得和架上其它书一样能退回去。
   */
  openAsSubPanel(onBack: () => void): void {
    this.backToShelf = onBack;
    this.open();
  }

  close(): void {
    if (!this._isOpen) return;
    this._isOpen = false;
    window.removeEventListener('keydown', this.onKeyBound);
    // 关场淡出（绕开重建路径共用的瞬时 teardown）：先摘两块滚动区的输入面，
    // 再让窗体带视觉淡出自毁——逻辑态已同步落定，尸体窗只是视觉。
    this.detail?.detachInput();
    this.list?.detachInput();
    const win = this.win;
    this.detail = null;
    this.list = null;
    this.win = null;
    win?.fadeOutAndDestroy();
    // 焦点只在**关面板**时清；build() 里的重建要靠它按 id 把焦点放回原处
    this.focus.destroy();
  }

  /** 真销毁（游戏退出）：瞬时路径，不播关场动画 */
  destroy(): void {
    this._isOpen = false;
    window.removeEventListener('keydown', this.onKeyBound);
    this.teardown();
    this.focus.destroy();
  }

  private teardown(): void {
    this.detail?.destroy();
    this.list?.destroy();
    this.win?.destroy();
    this.detail = null;
    this.list = null;
    this.win = null;
  }

  /**
   * ✕ /「关闭」提示的关闭入口。
   *
   * 由 `Game` 注入 `stateController.closePanel(<本面板名>)`——**精确寻址、弹栈、恢复状态**。
   * 早期版本靠「在 window 上补发本面板快捷键（或 Esc）」绕过软锁，两条都被审查证伪：
   * F2 调试坞开着时 `handleKeyDown` 会吞掉所有其它按键（✕ 变死按钮），补发 Esc 更糟——
   * 它会去关调试坞，或在状态漂到 Exploring 时弹出暂停菜单压在本面板上、把栈叠歪。
   * 注入还顺带干掉了「快捷键码在面板里抄一份」这处会漂移的手工镜像。
   */
  private requestClose(): void {
    // 书架子面板模式下出口是「退回书架」，由书架负责收子面板 + 重建自己（勿走 closePanel）
    if (this.backToShelf) {
      this.backToShelf();
      return;
    }
    this.closeRequester?.();
  }

  /** 由 Game 注入关闭通道（构造签名不变；与 setResolveDisplay 同一注入范式）。 */
  setCloseRequester(fn: (() => void) | null): void {
    this.closeRequester = fn;
  }

  /** 预设尺寸在小画布（调试侧栏挤压 #game-mount）下要收边，与旧实现的 `min(…, sw-40)` 一致 */
  private panelWidth(): number {
    return Math.min(WINDOW_SIZES.lg.width, this.renderer.screenWidth - UITheme.spacing.xl * 2);
  }

  private panelHeight(): number {
    return Math.min(WINDOW_SIZES.lg.height, this.renderer.screenHeight - UITheme.spacing.xl * 2);
  }

  /** 分区标题去装饰：`== 搜集中 ==` → `搜集中`、`来源:` → `来源` */
  private plainLabel(key: string): string {
    return this.strings
      .get('rulesPanel', key)
      .replace(/^[-=\s]+|[-=\s:：]+$/g, '')
      .trim();
  }

  /** 「象」/「理」/「术」的分层表头文案 */
  private layerLabelOf(L: RuleLayerKey): string {
    return this.strings.get('rulesPanel', L === 'xiang' ? 'layerXiang' : L === 'li' ? 'layerLi' : 'layerShu');
  }

  /**
   * 行上那一个状态词/颜色。
   *
   * 规矩是分层验证的（每层各有 verified），行上只放得下一个词：**有存疑就报存疑**，
   * 其次有生效就报生效，全无则未验证。逐层的成色仍旧在右栏逐层标注，不靠这里表达。
   */
  private aggregateVerified(layers: { verified?: string; text?: string }[]): string {
    let hasEffective = false;
    for (const l of layers) {
      if (!l.text?.trim()) continue;
      const v = l.verified ?? 'unverified';
      if (v === 'questionable') return 'questionable';
      if (v === 'effective') hasEffective = true;
    }
    return hasEffective ? 'effective' : 'unverified';
  }

  private rows(): RuleRow[] {
    const out: RuleRow[] = [];
    for (const r of this.rulesData.getAcquiredRules()) {
      const vKey = this.aggregateVerified(LAYER_ORDER.map(L => r.def.layers[L] ?? {}));
      out.push({
        id: r.def.id,
        name: this.r(r.def.name),
        statusLabel: this.rulesData.getVerifiedLabel(vKey),
        statusColor: VERIFIED_COLORS[vKey] ?? VERIFIED_COLORS.unverified,
        acquired: true,
        categoryName: this.rulesData.getCategoryName(r.def.category),
      });
    }
    for (const e of this.rulesData.getDiscoveredRules()) {
      out.push({
        id: e.def.id,
        name: this.r(e.def.incompleteName ?? this.strings.get('rulesPanel', 'unknown')),
        statusLabel: this.plainLabel('collecting'),
        statusColor: UITheme.colors.ruleCollecting,
        acquired: false,
        categoryName: this.rulesData.getCategoryName(e.def.category),
      });
    }
    return out;
  }

  /**
   * @param animate 仅首次打开为 true。点条目触发的重建必须走 `win.attach()`，
   * 否则每点一次都重放一遍开场动画；而忘了挂载会让整个面板从画面消失。
   */
  private build(animate = false): void {
    const keep = this.list?.scrollOffset ?? 0;
    this.teardown();

    const rows = this.rows();
    // 恒有选中项：右栏不再出现「选中前一片虚无」（与 InventoryUI 同一口径）
    if (!this.selectedId || !rows.some(r => r.id === this.selectedId)) {
      this.selectedId = rows.length > 0 ? rows[0].id : null;
    }

    const win = new UIWindow(this.renderer, {
      // 标题自己摆（居中压在左栏那一页上，不是压在整块面板上），故不给 UIWindow 标题栏
      size: { width: this.panelWidth(), height: this.panelHeight() },
      skin: SKINS.book,
      closeHint: this.strings.get('rulesPanel', this.backToShelf ? 'backToShelf' : 'closeHint'),
      onClose: () => this.requestClose(),
    });
    this.win = win;

    const bodyW = win.bodyWidth;
    const bodyH = win.bodyHeight;
    // 焦点项与画面同批攒出来：矩形一律取**面板内容坐标系**（win.body 原点）
    const focusItems: FocusItem[] = [];
    const hadFocus = this.focus.current !== null;
    const listW = Math.round(bodyW * LIST_RATIO);
    const detailX = listW + UITheme.spacing.xxl;
    const detailW = bodyW - detailX;
    // 滚轮分栏：鼠标在列表上滚列表、在右栏上滚正文。
    // 边界**每次现读** win.body.x —— 窗口 resize 会重算居中位移，捕获成常量会让判据错位。
    const splitX = (): number => (this.win?.body.x ?? 0) + listW + UITheme.spacing.lg;

    // 两栏之间那条极淡竖线（书脊位）。空态不画：中央那段指路要横跨两页，书脊只会切在字上
    if (rows.length > 0) {
      const divider = new Graphics();
      divider.rect(listW + UITheme.spacing.lg, 0, 1, bodyH);
      divider.fill({ color: UITheme.colors.hairline, alpha: UITheme.alpha.hairline });
      divider.eventMode = 'none';
      win.body.addChild(divider);
    }

    const titleRow = createTitleRow(this.strings.get('rulesPanel', 'title'), {
      width: listW,
      fontSize: UITheme.fontSize.display,
      letterSpacing: UITheme.letterSpacing.title,
    });
    titleRow.position.set(0, 0);
    win.body.addChild(titleRow);

    // 标题下方那条带菱形节点的渐隐横线
    const ruleY = titleRow.rowHeight + UITheme.spacing.md;
    const rule = createRule(listW);
    rule.position.set(0, ruleY);
    win.body.addChild(rule);
    win.body.addChild(this.diamond(Math.round(listW / 2), ruleY));

    const listY = ruleY + UITheme.spacing.lg;
    const listH = Math.max(ROW_H, bodyH - listY);

    const list = new UIScrollView(this.renderer, {
      width: listW,
      height: listH,
      bottomPadding: UITheme.spacing.md,
      hitTest: (x) => x < splitX(),
    });
    list.container.position.set(0, listY);
    win.body.addChild(list.container);
    this.list = list;

    this.fillList(rows, listW, listY, focusItems);
    list.scrollOffset = keep;

    const selected = rows.find(r => r.id === this.selectedId) ?? null;
    if (selected) this.buildDetail(win, selected, detailX, detailW, bodyH, splitX);

    // 空态：面板中央一句现状 + 一句指路（审查 P2：大面板空时只剩角落一句暗灰，
    // 近乎白板还不告诉玩家怎么才会有内容）。底部让开键帽那一条。
    if (rows.length === 0) this.buildEmptyState(win.body, bodyW, listY, bodyH);

    // 内容整份重建，焦点按 id 复位（`setItems` 自己保；id 没了就落到几何上最近的一项）
    this.focus.setItems(focusItems);
    // **默认焦点不放左上角**：落在当前选中的那一条。只在刚打开面板时指定——
    // 点条目后的重建必须留在玩家手上的那一项。
    if (!hadFocus && this.selectedId) this.focus.focusDefault(rowFocusId(this.selectedId));
    // ⚠ `setItems` 在焦点 id 不变时会**早退**，不会回调新元素的 onFocus——
    // 重建后的高亮得在这里补画一次，否则每点一次面板焦点就"看不见了"。
    this.focus.current?.onFocus(true);

    if (animate) win.open();
    else win.attach();
  }

  /**
   * 空态块：一行主句（body 档）+ 一行指路副句（small 档），整块在内容区里居中。
   * 副句告诉玩家「怎么才会有内容」，文案在 strings 的 emptyTitle / emptyHint。
   */
  private buildEmptyState(parent: Container, bodyW: number, top: number, bottom: number): void {
    const main = createStyledText({
      text: this.strings.get('rulesPanel', 'emptyTitle'),
      style: {
        fontSize: UITheme.fontSize.body, fill: UITheme.colors.bodyMuted,
        fontFamily: UITheme.fonts.ui, letterSpacing: UITheme.letterSpacing.hint,
      },
    });
    const hint = createStyledText({
      text: this.strings.get('rulesPanel', 'emptyHint'),
      style: {
        fontSize: UITheme.fontSize.small, fill: UITheme.colors.hintMid,
        fontFamily: UITheme.fonts.ui,
        wordWrap: true, breakWords: true, wordWrapWidth: Math.round(bodyW * 0.7),
      },
    });
    const gap = UITheme.spacing.md;
    const blockTop = Math.round(top + (bottom - top - main.height - gap - hint.height) / 2);
    main.position.set(Math.round((bodyW - main.width) / 2), blockTop);
    hint.position.set(Math.round((bodyW - hint.width) / 2), blockTop + main.height + gap);
    main.eventMode = 'none';
    hint.eventMode = 'none';
    parent.addChild(main, hint);
  }

  /** 选中某一条规矩（行点击与回车激活共用一条路径） */
  private selectRule(id: string): void {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.build();
  }

  /** 焦点落到视口外的行时把它滚进来。只动 `scrollOffset`，不碰选中态。 */
  private revealRow(index: number): void {
    const list = this.list;
    if (!list) return;
    const top = index * ROW_H;
    const bottom = top + ROW_H - ROW_GAP;
    if (top < list.scrollOffset) list.scrollOffset = top;
    else if (bottom > list.scrollOffset + list.viewportHeight) {
      list.scrollOffset = bottom - list.viewportHeight;
    }
  }

  /** 横线中点上的小菱形节点（设计稿里那一枚） */
  private diamond(cx: number, cy: number): Graphics {
    const g = new Graphics();
    const s = 4;
    g.moveTo(cx, cy - s);
    g.lineTo(cx + s, cy);
    g.lineTo(cx, cy + s);
    g.lineTo(cx - s, cy);
    g.closePath();
    g.fill({ color: UITheme.colors.titleRule, alpha: UITheme.alpha.titleRule });
    g.eventMode = 'none';
    return g;
  }

  private fillList(
    rows: RuleRow[],
    listW: number,
    /** 列表在内容区里的 y 偏移：焦点矩形要用面板坐标，行本身的 y 是滚动区内坐标 */
    listY: number,
    /** 收集焦点项，由 build 统一交给 UIFocus */
    focusItems: FocusItem[],
  ): void {
    const list = this.list;
    if (!list) return;

    // 空态不在列表页里出字：整块面板的空态块由 build() 统一画在面板中央
    if (rows.length === 0) {
      list.refresh();
      return;
    }

    // 右侧留出滚动条的道
    const rowW = listW - UITheme.spacing.sm;
    const rowBodyH = ROW_H - ROW_GAP;

    rows.forEach((row, i) => {
      const y = i * ROW_H;
      const selected = row.id === this.selectedId;

      const bg = new Graphics();
      if (selected) {
        drawSelectedRow(bg, 0, y, rowW, rowBodyH);
      } else {
        // 行底是该状态色的极暗同色系——设计稿里四行底色各不相同，不是统一灰
        drawPanelBase(bg, 0, y, rowW, rowBodyH, SKINS.row, {
          fill: dimColor(row.statusColor, ROW_TINT),
          border: UITheme.colors.borderSubtle,
        });
      }
      list.content.addChild(bg);

      // 焦点高亮 = 行**自己那层选中画法**（琥珀铺光 + 金描边），不另发明一种焦点框。
      // 只给未选中的行备：`drawSelectedRow` 是半透明铺光，叠在已选中的行上会亮成两倍。
      // **必须紧跟 bg 加进去**：它排在圆点/文字之后会把它们盖掉。
      let focusG: Graphics | null = null;
      if (!selected) {
        focusG = new Graphics();
        drawSelectedRow(focusG, 0, y, rowW, rowBodyH);
        focusG.visible = false;
        focusG.eventMode = 'none';
        list.content.addChild(focusG);
      }

      const dot = new Graphics();
      dot.circle(DOT_X, y + rowBodyH / 2, DOT_R);
      dot.fill({ color: row.statusColor });
      dot.eventMode = 'none';
      list.content.addChild(dot);

      const status = createStyledText({
        text: row.statusLabel,
        style: {
          // 「未验证 / 有效 / 存疑 / 搜集中」是**状态词**：扫一眼就够，停在 small。
          // 它已经有自己的颜色 + 行底同色系，再放大只会跟规矩名抢行。
          fontSize: UITheme.fontSize.small, fill: row.statusColor,
          fontFamily: UITheme.fonts.ui, letterSpacing: UITheme.letterSpacing.hint,
        },
      });
      status.position.set(
        rowW - UITheme.spacing.md - status.width,
        y + Math.round((rowBodyH - status.height) / 2),
      );
      status.eventMode = 'none';
      list.content.addChild(status);

      const name = createStyledText({
        text: row.name,
        style: {
          fontSize: UITheme.fontSize.bodyLarge,
          fill: selected ? UITheme.colors.title : row.statusColor,
          fontFamily: UITheme.fonts.ui, fontWeight: 'bold',
          letterSpacing: UITheme.letterSpacing.hint,
        },
      });
      const nameX = DOT_X + DOT_R + UITheme.spacing.md;
      name.position.set(nameX, y + Math.round((rowBodyH - name.height) / 2));
      name.eventMode = 'none';
      this.ellipsize(name, rowW - nameX - status.width - UITheme.spacing.lg);
      list.content.addChild(name);

      // 整行命中：Pixi 是逐子元素命中测试，只给 Text 会让行内空白成死区
      const hit = new Graphics();
      hit.rect(0, y, rowW, rowBodyH);
      hit.fill({ color: 0xffffff, alpha: UITheme.alpha.hitArea });
      hit.eventMode = 'static';
      hit.cursor = 'pointer';
      hit.on('pointerdown', (e) => {
        markPointerConsumed((e as { nativeEvent?: unknown }).nativeEvent);
        this.selectRule(row.id);
      });
      // 指针悬停即移焦：鼠标与手柄共用同一个"当前项"，移开鼠标再按方向键要从这里接着走
      hit.on('pointerover', () => this.focus.syncHover(rowFocusId(row.id)));
      list.content.addChild(hit);

      focusItems.push({
        id: rowFocusId(row.id),
        // 焦点矩形取**面板坐标**（列表偏移 + 行在滚动区内的 y）
        x: 0, y: listY + y, w: rowW, h: rowBodyH,
        group: 'list',
        onFocus: (f) => {
          if (focusG) focusG.visible = f;
          // 焦点走到视口外的行要把它滚进来（只动 scrollOffset，不碰选中态）
          if (f) this.revealRow(i);
        },
        onActivate: () => this.selectRule(row.id),
      });
    });

    list.refresh();
  }

  private buildDetail(
    win: UIWindow,
    row: RuleRow,
    x: number,
    w: number,
    bodyH: number,
    splitX: () => number,
  ): void {
    const progress = this.rulesData.getFragmentProgress(row.id);
    const hasFooter = progress.total > 0;
    const viewH = Math.max(ROW_H, bodyH - (hasFooter ? FOOTER_H : 0));

    const view = new UIScrollView(this.renderer, {
      width: w,
      height: viewH,
      bottomPadding: UITheme.spacing.md,
      hitTest: (px) => px >= splitX(),
    });
    view.container.position.set(x, 0);
    win.body.addChild(view.container);
    this.detail = view;

    const wrapW = w - UITheme.spacing.sm;
    let cy = 0;

    const name = createStyledText({
      text: row.name,
      style: {
        // **条目名不是面板大标题**。原来跟左栏的「规矩本」一样吃 display(44)，
        // 于是「城隍庙后山三更勿去」这种九字规矩名折成两行、末字「去」单独占一行。
        // 收到 title：仍是这一栏当仁不让的头牌，但九个字能一行放下。
        fontSize: UITheme.fontSize.title, fill: UITheme.colors.title,
        fontFamily: UITheme.fonts.display, fontWeight: 'bold',
        letterSpacing: UITheme.letterSpacing.title,
        wordWrap: true, breakWords: true, wordWrapWidth: wrapW,
      },
    });
    name.position.set(0, cy);
    view.content.addChild(name);
    cy += name.height + UITheme.spacing.sm;

    const rule = createRule(wrapW);
    rule.position.set(0, cy);
    view.content.addChild(rule);
    cy += UITheme.spacing.md;

    const cat = createStyledText({
      text: row.categoryName,
      style: {
        // 分类（禁忌/避祸/行话/江湖）是**标签**。micro 是给角标与计数留的，
        // 一个要认字的分类掉到 14 就成了灰渣；抬到 small——仍明显小于正文。
        fontSize: UITheme.fontSize.small, fill: UITheme.colors.hintMid,
        fontFamily: UITheme.fonts.ui, letterSpacing: UITheme.letterSpacing.hint,
      },
    });
    cat.position.set(0, cy);
    view.content.addChild(cat);
    cy += cat.height + UITheme.spacing.md;

    cy = row.acquired
      ? this.fillAcquiredBody(view.content, row.id, wrapW, cy)
      : this.fillCollectingBody(view.content, row.id, wrapW, cy);

    // 来源：已收到的碎片各自的出处（去重后按序）
    const sources: string[] = [];
    for (const frag of progress.fragments) {
      if (!frag.source || !this.rulesData.hasFragment(frag.id)) continue;
      const s = this.r(frag.source);
      if (!sources.includes(s)) sources.push(s);
    }
    if (sources.length > 0) {
      cy += UITheme.spacing.xs;
      cy = this.addSectionHead(view.content, this.plainLabel('source'), wrapW, cy);
      for (const s of sources) {
        const t = createStyledText({
          text: s,
          style: {
            // 出处（「听茶馆说书人提起」）是**副信息**：说明这条规矩打哪儿来的，
            // 不是要读的正文。停在 small，行距略放开一点就够。
            fontSize: UITheme.fontSize.small, fill: UITheme.colors.hintMid,
            fontFamily: UITheme.fonts.ui, lineHeight: 24,
            wordWrap: true, breakWords: true, wordWrapWidth: wrapW,
          },
        });
        t.position.set(0, cy);
        view.content.addChild(t);
        cy += t.height + UITheme.spacing.xs;
      }
    }

    view.refresh();

    if (hasFooter) this.buildFooter(win, x, w, bodyH, progress.collected, progress.total);
  }

  /** 已掌握：象/理/术逐层出正文，各带自己的成色标注 */
  private fillAcquiredBody(target: Container, ruleId: string, wrapW: number, y: number): number {
    let cy = y;
    const def = this.rulesData.getRuleDef(ruleId);
    if (!def) return cy;

    for (const L of LAYER_ORDER) {
      const layerDef = def.layers[L];
      const t = layerDef?.text?.trim();
      if (!t) continue;
      const vKey = layerDef?.verified ?? 'unverified';

      const head = createStyledText({
        text: `「${this.layerLabelOf(L)}」`,
        style: {
          fontSize: UITheme.fontSize.body, fill: UITheme.colors.hintMid,
          fontFamily: UITheme.fonts.ui, fontWeight: 'bold', letterSpacing: UITheme.letterSpacing.hint,
        },
      });
      head.position.set(0, cy);
      target.addChild(head);

      const tag = createStyledText({
        text: this.rulesData.getVerifiedLabel(vKey),
        style: {
          // 逐层成色是**状态词**，与列表行上的那个词同一档（small）。
          // 原来 micro 比正文小两档，挂在表头旁边像个排版事故。
          fontSize: UITheme.fontSize.small,
          fill: VERIFIED_COLORS[vKey] ?? VERIFIED_COLORS.unverified,
          fontFamily: UITheme.fonts.ui,
        },
      });
      tag.position.set(head.width + UITheme.spacing.md, cy + 3);
      target.addChild(tag);
      cy += head.height + UITheme.spacing.xs;

      const body = createStyledText({
        text: this.r(t),
        style: {
          // 分层正文：这一栏真正要读的东西，抬到 body 就够——**不再往上抬**。
          // 规矩正文动辄三五行，抬到 bodyLarge 一屏只剩两层、右栏立刻变成滚动条。
          // 真正让它好读的是行距（20 → 30），不是字号。
          fontSize: UITheme.fontSize.body, fill: UITheme.colors.descText,
          fontFamily: UITheme.fonts.ui, lineHeight: 30,
          wordWrap: true, breakWords: true, wordWrapWidth: wrapW,
        },
      });
      body.position.set(0, cy);
      target.addChild(body);
      cy += body.height + UITheme.spacing.md;
    }
    return cy;
  }

  /** 搜集中：分层小计 + 已到手的碎片正文（没到手的仍是 ??? 占位） */
  private fillCollectingBody(target: Container, ruleId: string, wrapW: number, y: number): number {
    let cy = y;
    const perLayer = this.rulesData.getLayerFragmentProgress(ruleId);
    for (const L of LAYER_ORDER) {
      const lp = perLayer[L];
      if (!lp || lp.total === 0) continue;
      const cap = createStyledText({
        text: `「${this.layerLabelOf(L)}」 ${lp.collected}/${lp.total}`,
        style: {
          fontSize: UITheme.fontSize.body, fill: UITheme.colors.hintMid,
          fontFamily: UITheme.fonts.ui, fontWeight: 'bold', letterSpacing: UITheme.letterSpacing.hint,
        },
      });
      cap.position.set(0, cy);
      target.addChild(cap);
      cy += cap.height + UITheme.spacing.xs;
    }
    cy += UITheme.spacing.xs;

    const all = this.rulesData.getFragmentProgress(ruleId);
    for (const frag of all.fragments) {
      const got = this.rulesData.hasFragment(frag.id);
      const t = createStyledText({
        text: got ? `「${this.r(frag.text)}」` : this.strings.get('rulesPanel', 'hidden'),
        style: {
          // 碎片原文与分层正文同档：它就是「搜集中」那半本规矩的正文。
          fontSize: UITheme.fontSize.body,
          fill: got ? UITheme.colors.descText : UITheme.colors.disabled,
          fontFamily: UITheme.fonts.ui, lineHeight: 30,
          wordWrap: true, breakWords: true, wordWrapWidth: wrapW,
        },
      });
      t.position.set(0, cy);
      target.addChild(t);
      cy += t.height + UITheme.spacing.md;
    }
    return cy;
  }

  /** 小标题 + 一条渐隐横线（设计稿右栏的「规矩说明」「来源」那种） */
  private addSectionHead(target: Container, text: string, wrapW: number, y: number): number {
    const head = createStyledText({
      text,
      style: {
        fontSize: UITheme.fontSize.body, fill: UITheme.colors.hintMid,
        fontFamily: UITheme.fonts.ui, fontWeight: 'bold', letterSpacing: UITheme.letterSpacing.hint,
      },
    });
    head.position.set(0, y);
    target.addChild(head);

    const lineX = head.width + UITheme.spacing.sm;
    if (wrapW - lineX > UITheme.spacing.xxl) {
      const line = createRule(wrapW - lineX);
      line.position.set(lineX, y + Math.round(head.height / 2));
      target.addChild(line);
    }
    return y + head.height + UITheme.spacing.sm;
  }

  /** 右栏底部：收集进度读数 + 方正琥珀进度条（钉在栏底，不随正文滚走） */
  private buildFooter(win: UIWindow, x: number, w: number, bodyH: number, collected: number, total: number): void {
    const box = new Container();
    // 从「内容区下沿再减去键帽那一条」往上量：读数 + 进度条整块必须落在 FOOTER_H 之内，
    // 原来还额外 +sm 往下推，进度条因此整条越过内容区、压到木框上。
    box.position.set(x, bodyH - FOOTER_H);
    win.body.addChild(box);

    const label = createStyledText({
      text: this.plainLabel('fragments'),
      style: {
        // 「碎片」是进度条的**说明**、不是小标题：它与读数一起退到 small，
        // 让这一条钉在栏底的状态带整体轻于上面的正文，分量由那根琥珀进度条出。
        fontSize: UITheme.fontSize.small, fill: UITheme.colors.bodyMuted,
        fontFamily: UITheme.fonts.ui, letterSpacing: UITheme.letterSpacing.hint,
      },
    });
    box.addChild(label);

    const count = createStyledText({
      text: `${collected} / ${total}`,
      style: {
        // 读数是**计数**，与它的说明同档，不比说明大。
        fontSize: UITheme.fontSize.small, fill: UITheme.colors.hintMid,
        fontFamily: UITheme.fonts.ui,
      },
    });
    count.position.set(w - count.width, 0);
    box.addChild(count);

    const bar = createProgressBar(w, PROGRESS_BAR_H, total > 0 ? collected / total : 0);
    bar.position.set(0, label.height + UITheme.spacing.sm);
    box.addChild(bar);
  }

  /** 一行放不下就截到能放下为止；实现收编在 styledText.ellipsizeStyledText（审查 P2 双份同文） */
  private ellipsize(t: Text, maxW: number): void {
    ellipsizeStyledText(t, maxW);
  }

  /**
   * 键盘 / 手柄：**焦点优先，滚动兜底**。
   *
   * 方向键先交给 `UIFocus` 挪焦点（左栏规矩逐条走，焦点出视口自动滚进来），
   * 挪不动才把按键让回给滚动区当纯滚动用；回车/空格把焦点那条选进右栏。
   * 两级都没吃下的按键**一律不吞**，否则会抢走全局快捷键（R 关面板等）。
   */
  private onKey(e: KeyboardEvent): void {
    if (this.focus.handleKey(e.code)) {
      e.preventDefault();
      return;
    }
    const list = this.list;
    if (!list) return;
    const before = list.scrollOffset;
    if (!list.handleKey(e.code)) return;
    if (list.scrollOffset !== before) e.preventDefault();
  }
}
