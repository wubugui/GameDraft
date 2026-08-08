import { Container, Graphics, Text } from 'pixi.js';
import { UITheme } from './UITheme';
import { drawPanelBase, SKINS } from './PanelSkin';
import { createBadge, createChip, createKeyCap, createRule, createTitleRow, drawSelectedRow } from './components/UIDecor';
import { markPointerConsumed } from './uiPointerCoords';
import { UIWindow, WINDOW_SIZES } from './components/UIWindow';
import { UIScrollView } from './components/UIScrollView';
import { UIFocus, rectOf, type FocusItem } from './components/UIFocus';
import type { Renderer } from '../rendering/Renderer';
import type { EventBus } from '../core/EventBus';
import type { StringsProvider } from '../core/StringsProvider';
import type { IQuestDataProvider } from '../data/types';
import { createStyledText, getStyledRaw, setStyledText } from '../core/styledText';
import { stripStyleMarkup } from '../core/textStyle';
import { plainTextLength, sliceStyledMarkup } from '../core/textStyle';

/**
 * 活计面板（对齐 tmp/ui_mockups_2026-08-03/05_quest_jobs_ui_design.png）。
 *
 * 版式：压左上角的大标题 → 一排页签 → 左栏「徽章 + 名 + 右侧灰简述」的列表
 * → 一条极淡竖线 → 右栏详情（名 / 说明 / 复选框式目标 / 正文）。底部键帽由 UIWindow 出。
 *
 * **数据面一个字没动**：主线/支线/零活/已完成四组仍旧是 `IQuestDataProvider` 那四个查询，
 * 追踪激活仍旧走 `activateRunHandler`（叙事队列）。页签只是把这四组换成「一次看一组」的
 * 视图选择（与 InventoryUI 的 selectedId 同一档次的面板内视图态），选中行由 selectedKey 决定。
 *
 * ⚠ 页签文案与徽章字**全部从 strings 反推**（`-- 支线 (2) --` → 「支线」→ 徽章「支」），
 * 面板里不写死任何中文；设计稿上的「可接」在数据面没有对应概念，故不造这一页。
 */

/**
 * 页签条高度；当前页签上凸 TAB_LIFT 像素并一直连到内容区。
 *
 * 页签字是 `body`（20）——它是**导航配角**，不跟着条目名一起长。但 28 的条高是按更小的
 * 字定的，20px 的中文在里头上下各只剩 1~2px，读起来是"卡在盒子里"。条高跟着字走。
 */
const TAB_H = 36;
const TAB_LIFT = 5;
/**
 * 列表行高：容得下圆徽章 + `bodyLarge`(25) 的任务名 + 上下呼吸位。
 *
 * ⚠ 原来是 40（rowBodyH=36），而 25px 的宋体中文实测字框约 33px——名字几乎顶满整行，
 * 上下贴边。行高必须跟着字号走，否则字一大就成了"挤在一坨"。
 */
const ROW_H = 48;
const ROW_GAP = 5;
/** 圆徽章半径与它在行内的左边距（行高抬起来后半径同步抬，否则徽章缩成一个点） */
const BADGE_R = 13;
const BADGE_X = 24;
/** 左栏占内容区的比例（设计稿约 6:4） */
const LIST_RATIO = 0.6;
/** 复选框边长：与 `body`(20) 的目标文字齐高，小一圈就成了脏点 */
const CHECK_SIZE = 18;
/**
 * 行内简述的**保底列宽**，按「徽章之后的可用宽」取比例。
 *
 * 任务名一长，按旧写法剩给简述的宽度就会塌到两三个字，一行灰字被截成「面生的雇…」
 * 什么也没说。保底列保证它至少还能说一句话；标题短时富余照样让回去。
 */
const BRIEF_RATIO = 0.36;
/** 底部键帽行占的高度（在内容区里留出来，键帽自己压这一条的居中位） */
const FOOTER_H = 34;

type TabKey = 'active' | 'repeatable' | 'completed';

/** 列表行的焦点 id（与 `selectedKey` 同源，重建后靠它把焦点放回原来那一条） */
function rowFocusId(key: string): string {
  return `row:${key}`;
}

interface Objective {
  text: string;
  done: boolean;
}

/** 一条列表行 = 一个任务/活计的展示投影（不持有 def，重建时整份重算） */
interface QuestRow {
  key: string;
  /** 任务 id：设为当前任务、查目标都按它走（key 带前缀，不能直接当 id 用） */
  questId: string;
  badge: string;
  badgeColor: number;
  title: string;
  titleColor: number;
  /** 行右侧那行灰色简述 */
  brief: string;
  /** 右栏正文 */
  body: string;
  objectives: Objective[];
  /** 是不是当前任务（全局唯一那条） */
  focused: boolean;
  /** 此刻能否被设为当前任务（已完成的不行、蛰伏的活计不行） */
  canFocus: boolean;
  /** 活计专有：第几单 / 追踪中 / 搁置 的状态行 */
  runMark?: string;
}

export class QuestPanelUI {
  private renderer: Renderer;
  private closeRequester: (() => void) | null = null;
  private questData: IQuestDataProvider;
  private eventBus: EventBus;
  /** 任务态变了就地重建（面板开着的时候）——面板是**状态镜像**，不是打开那一刻的快照 */
  private questChangedCb: () => void;
  private strings: StringsProvider;
  private win: UIWindow | null = null;
  private list: UIScrollView | null = null;
  private detail: UIScrollView | null = null;
  private _isOpen: boolean = false;
  private onKeyBound: (e: KeyboardEvent) => void;
  private resolveDisplay: ((s: string) => string) | null = null;
  /** 「设为当前任务」正在走叙事队列（活计激活是异步的）：期间不重复发请求 */
  private focusPending = false;
  /** 已排了一次重建（同一批任务态变化只重建一次） */
  private rebuildScheduled = false;
  /** 视图态：当前页签 / 当前选中行（都不入档，与任务数据无关） */
  private tab: TabKey = 'active';
  private selectedKey: string | null = null;
  /**
   * 键盘 / 手柄焦点。**三组**：`tabs` 页签条 / `body` 面板主体（左栏列表 + 右栏可点项）/
   * `footer` 底部关闭键帽。方向键先在组内找，找不到才跨组。
   *
   * ⚠ **左右两栏必须同组**，看着反直觉，但换成「左栏一组、右栏一组」左右键就跨不过去：
   * `UIFocus.pick` 判方向只看"主轴分量 > 1"，而页签条正好压在列表正上方、中心 x 与
   * 行中心只差 3px（实测 row cx=254 / tab cx=257）——于是**页签也算"在行的右边"**，
   * 打分 `主轴 + 2×副轴` 下它 107 分、真正在右栏的「点击追踪」842 分，右键必被页签劫走。
   * 同组优先能在跨组回退**之前**就把右栏那项选出来，绕开这个判据。
   * （根因在地基：方向判据应要求主轴压过副轴，见交付报告。）
   * 上下键仍在同一栏里逐行走——同栏行的横向偏移是 0，永远打得过跨栏那项。
   *
   * 高亮一律**复用元素自己已有的画法**：行与页签走 `drawSelectedRow` 那层琥珀铺光、
   * 键帽走它自己的 hover 变淡，不另发明一种焦点框。
   */
  private focus = new UIFocus();
  /** 左栏列表 + 右栏可点项共用的组名（见上：左右键跨栏靠"同组优先"才走得通） */
  private static readonly GROUP_BODY = 'body';

  constructor(
    renderer: Renderer,
    questData: IQuestDataProvider,
    strings: StringsProvider,
    eventBus: EventBus,
  ) {
    this.renderer = renderer;
    this.questData = questData;
    this.strings = strings;
    this.eventBus = eventBus;
    this.onKeyBound = (e) => this.onKey(e);
    // 面板关着时不重建（省下整份 Pixi 树），打开时的 build() 自己会读到最新状态
    this.questChangedCb = () => { if (this._isOpen) this.scheduleRebuild(); };
    this.eventBus.on('quest:changed', this.questChangedCb);
  }

  /**
   * 攒一个微任务再重建，**不在事件回调里同步 teardown**。
   *
   * 两个理由，缺一条都会咬人：
   * - 「设为当前任务」是行内 `pointerdown` 打进来的，而 `requestFocusQuest` 对一次性任务
   *   是同步落槽 → 同步广播 → 若同步 `build()`，就等于**在 Pixi 正分发这枚 Graphics 的
   *   指针事件时把它 destroy 掉**。
   * - 一条动作批里连接几条任务会广播好几次，逐条重建整棵面板纯属白烧。
   */
  private scheduleRebuild(): void {
    if (this.rebuildScheduled) return;
    this.rebuildScheduled = true;
    queueMicrotask(() => {
      this.rebuildScheduled = false;
      if (this._isOpen) this.build();
    });
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

  close(): void {
    if (!this._isOpen) return;
    this._isOpen = false;
    window.removeEventListener('keydown', this.onKeyBound);
    this.teardown();
    // 焦点只在**关面板**时清；build() 里的重建要靠它按 id 把焦点放回原处
    this.focus.destroy();
  }

  destroy(): void {
    this.close();
    this.eventBus.off('quest:changed', this.questChangedCb);
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
    this.closeRequester?.();
  }

  /** 由 Game 注入关闭通道（构造签名不变；与 setResolveDisplay 同一注入范式）。 */
  setCloseRequester(fn: (() => void) | null): void {
    this.closeRequester = fn;
  }

  /** 预设尺寸在小画布（调试侧栏挤压 #game-mount）下要收边，与旧实现的 `min(…, sw-40)` 一致 */
  private panelWidth(): number {
    return Math.min(WINDOW_SIZES.xl.width, this.renderer.screenWidth - UITheme.spacing.xl * 2);
  }

  private panelHeight(): number {
    return Math.min(WINDOW_SIZES.lg.height, this.renderer.screenHeight - UITheme.spacing.xl * 2);
  }

  // -- 文案 ------------------------------------------------------------------

  /**
   * 分区标题去装饰：`-- 支线 (2) --` → `支线`。
   * 页签名与徽章字都从这里来，面板不自带任何中文。
   */
  private plainLabel(key: string): string {
    // 先剥色标记：这里的产物会被 badgeChar 做**字符级**取首字，带标记的话徽章会显示成 "["
    return stripStyleMarkup(this.strings.get('quest', key, { count: 0, n: 0 }))
      .replace(/\([^)]*\)/g, '')
      .replace(/^[-=\s]+|[-=\s]+$/g, '')
      .trim();
  }

  /** 徽章只取一个字（主线→主 / 支线→支 / 零活→零 / 已完成→已） */
  private badgeChar(key: string): string {
    return this.plainLabel(key).charAt(0);
  }

  private tabLabels(): { key: TabKey; label: string }[] {
    return [
      // 「进行中」不再写成「主线·支线」：主线可以同时有好几条，两类混列才是这一页的真实内容
      { key: 'active', label: this.plainLabel('inProgress') },
      { key: 'repeatable', label: this.plainLabel('repeatable') },
      { key: 'completed', label: this.plainLabel('completed') },
    ];
  }

  // -- 行数据 ----------------------------------------------------------------

  /** 当前页签下的行。四组查询与旧实现逐字一致，只是分给了不同页签。 */
  private rowsOf(tab: TabKey): QuestRow[] {
    if (tab === 'active') return this.activeRows();
    if (tab === 'repeatable') return this.repeatableRows();
    return this.completedRows();
  }

  /** 该任务配了目标就用真目标，没配就退回旧样子（不造假条目） */
  private objectivesOf(questId: string): Objective[] {
    return this.questData.getQuestObjectives(questId).map(o => ({
      text: this.r(o.def.text),
      done: o.done,
    }));
  }

  /**
   * 进行中：**全部** Active 任务，主线支线混列（主线在前）。
   *
   * ⚠ 旧实现是「getCurrentMainQuest() 取一条主线 + 过滤出 side」——主线链推进与条件自动
   * 接取会让多条主线同时进行中，那样写第二条以后的主线在面板上**根本不存在**。
   */
  private activeRows(): QuestRow[] {
    const focusedId = this.questData.getFocusedQuestId();
    const entries = this.questData.getActiveQuests();
    const ordered = [
      ...entries.filter(q => q.def.type === 'main'),
      ...entries.filter(q => q.def.type !== 'main'),
    ];
    return ordered.map(q => {
      const isMain = q.def.type === 'main';
      return {
        key: `${isMain ? 'main' : 'side'}:${q.def.id}`,
        questId: q.def.id,
        badge: this.badgeChar(isMain ? 'mainline' : 'sideline'),
        badgeColor: isMain ? UITheme.colors.questMain : UITheme.colors.questSide,
        title: this.r(q.def.title),
        titleColor: isMain ? UITheme.colors.title : UITheme.colors.bodyMuted,
        brief: this.r(q.def.description ?? ''),
        body: this.r(q.def.description ?? ''),
        objectives: this.objectivesOf(q.def.id),
        focused: q.def.id === focusedId,
        canFocus: this.questData.canFocusQuest(q.def.id),
      };
    });
  }

  /** 零活：条目/完成/归档全由活计生命周期派生，settled 天然就是「已勾掉的目标」 */
  private repeatableRows(): QuestRow[] {
    const rows: QuestRow[] = [];
    const focusedId = this.questData.getFocusedQuestId();
    for (const { def, run } of this.questData.getRepeatableQuestEntries()) {
      // 活计的"目标"有两个来源：配了 objectives 就用它，否则退回「按出口汇总的归档行」
      const authored = this.objectivesOf(def.id);
      const objectives: Objective[] = authored.length > 0 ? authored : run.settled.map(s => ({
        text: this.strings.get('quest', 'runArchive', { label: this.r(s.label), count: s.count }),
        done: true,
      }));
      let brief = '';
      if (run.active !== undefined) {
        brief = this.strings.get('quest', 'runCurrent', { state: this.r(run.activeLabel ?? '') });
        if (authored.length === 0) objectives.push({ text: brief, done: false });
      }
      rows.push({
        key: `run:${def.id}`,
        questId: def.id,
        badge: this.badgeChar('repeatable'),
        badgeColor: run.activated ? UITheme.colors.questMain : UITheme.colors.questCompleted,
        title: run.active !== undefined
          ? `${this.r(def.title)}（${this.strings.get('quest', 'runOrdinal', { n: run.ordinal })}）`
          : this.r(def.title),
        titleColor: run.activated ? UITheme.colors.title : UITheme.colors.bodyMuted,
        brief,
        body: this.r(def.description),
        objectives,
        focused: def.id === focusedId,
        canFocus: this.questData.canFocusQuest(def.id),
        runMark: run.active === undefined
          ? undefined
          : this.strings.get('quest', run.activated ? 'runTracked' : 'runSuspended').trim(),
      });
    }
    return rows;
  }

  private completedRows(): QuestRow[] {
    return this.questData.getCompletedQuests().map(q => ({
      key: `done:${q.def.id}`,
      questId: q.def.id,
      badge: this.badgeChar('completed'),
      badgeColor: UITheme.colors.questCompleted,
      title: this.r(q.def.title),
      titleColor: UITheme.colors.questCompleted,
      brief: this.r(q.def.description),
      body: this.r(q.def.description),
      objectives: (() => {
        const authored = this.objectivesOf(q.def.id);
        return authored.length > 0
          ? authored
          : [{ text: this.strings.get('quest', 'done'), done: true }];
      })(),
      focused: false,
      canFocus: false,
    }));
  }

  // -- 组装 ------------------------------------------------------------------

  /**
   * @param animate 仅首次打开为 true。点页签/点行/点追踪后的重建必须走 `win.attach()`，
   * 否则每点一次都重放一遍开场动画；而忘了挂载会让整个面板从画面消失。
   */
  private build(animate = false): void {
    const keep = this.list?.scrollOffset ?? 0;
    // 右栏的滚动位也要留：面板现在会因为**别的**任务变了而重建，
    // 玩家正读到长描述/目标清单的中段时被弹回顶部，纯属被无关变化打断。
    //
    // ⚠ 但**只在还是同一条**时还给它：`selectRow`/`switchTab` 都是先改 selectedKey 再 build()，
    // 对这段代码而言三种重建路径没有区别——无条件还原会把上一条的滚动位带到新选中的
    // 那条上（换行后右栏不从顶部开始读，超出新内容时还会被钳到底部）。
    const keptForKey = this.selectedKey;
    const keepDetail = this.detail?.scrollOffset ?? 0;
    this.teardown();

    const rows = this.rowsOf(this.tab);
    // 恒有选中项：右栏不再出现「选中前一片虚无」（与 InventoryUI 同一口径）
    if (!this.selectedKey || !rows.some(r => r.key === this.selectedKey)) {
      this.selectedKey = rows.length > 0 ? rows[0].key : null;
    }

    const win = new UIWindow(this.renderer, {
      // 标题自己摆（压左上角、与页签连成一个头部），故不给 UIWindow 标题栏。
      // 关闭提示也自己摆：UIWindow 那行把「按 Tab 关闭」拆成了「T」+「ab 关闭」
      // （它的键名分组是懒惰匹配，只吃得下单字母键），本面板的快捷键正好是多字母的 Tab。
      size: { width: this.panelWidth(), height: this.panelHeight() },
      onClose: () => this.requestClose(),
    });
    this.win = win;

    const bodyW = win.bodyWidth;
    const bodyH = win.bodyHeight - FOOTER_H;
    // 焦点项与画面同批攒出来：矩形一律取**面板内容坐标系**（win.body 原点），
    // 左栏行、右栏可点项、页签、键帽因此在同一套坐标里比距离，左右键才跨得过去。
    const focusItems: FocusItem[] = [];
    const hadFocus = this.focus.current !== null;
    this.buildCloseHint(win, bodyW, win.bodyHeight, focusItems);
    const listW = Math.round(bodyW * LIST_RATIO);
    const detailX = listW + UITheme.spacing.xl;
    const detailW = bodyW - detailX;
    // 滚轮分栏：鼠标在列表上滚列表、在右栏上滚正文。
    // 边界**每次现读** win.body.x —— 窗口 resize 会重算居中位移，捕获成常量会让判据错位。
    const splitX = (): number => (this.win?.body.x ?? 0) + listW + UITheme.spacing.md;

    const titleRow = createTitleRow(this.strings.get('quest', 'title'), {
      width: listW,
      align: 'left',
      fontSize: UITheme.fontSize.display,
      letterSpacing: UITheme.letterSpacing.title,
    });
    titleRow.position.set(0, 0);
    win.body.addChild(titleRow);

    const tabsY = titleRow.rowHeight + UITheme.spacing.md;
    this.buildTabs(win.body, listW, tabsY, focusItems);

    const listY = tabsY + TAB_H + UITheme.spacing.md;
    const listH = Math.max(ROW_H, bodyH - listY);

    // 两栏之间那条极淡竖线
    const divider = new Graphics();
    divider.rect(listW + UITheme.spacing.md, tabsY, 1, bodyH - tabsY);
    divider.fill({ color: UITheme.colors.hairline, alpha: UITheme.alpha.hairline });
    divider.eventMode = 'none';
    win.body.addChild(divider);

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

    const selected = rows.find(r => r.key === this.selectedKey) ?? null;
    if (selected) {
      this.buildDetail(win, selected, detailX, detailW, tabsY, bodyH - tabsY, splitX, focusItems);
      if (this.detail && this.selectedKey === keptForKey) this.detail.scrollOffset = keepDetail;
    }

    // 内容整份重建，焦点按 id 复位（`setItems` 自己保；id 没了就落到几何上最近的一项）。
    this.focus.setItems(focusItems);
    // **默认焦点不放左上角**：落在当前选中的那一条（列表空时退到当前页签）。
    // 只在刚打开面板时指定——点行 / 切页签后的重建必须留在玩家手上的那一项。
    if (!hadFocus) {
      this.focus.focusDefault(this.selectedKey ? rowFocusId(this.selectedKey) : `tab:${this.tab}`);
    }
    // ⚠ `setItems` 在焦点 id 不变时会**早退**，不会回调新元素的 onFocus——
    // 重建后的高亮得在这里补画一次，否则每点一次面板焦点就"看不见了"。
    this.focus.current?.onFocus(true);

    if (animate) win.open();
    else win.attach();
  }

  /** 切页签（页签点击与回车激活共用一条路径） */
  private switchTab(key: TabKey): void {
    if (this.tab === key) return;
    this.tab = key;
    this.selectedKey = null;
    if (this.list) this.list.scrollOffset = 0;
    this.build();
  }

  /** 选中某一行（行点击与回车激活共用一条路径） */
  private selectRow(key: string): void {
    if (this.selectedKey === key) return;
    this.selectedKey = key;
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

  /** 右栏同理：焦点落到正文视口外的可点项时把它滚进来 */
  private revealDetail(top: number, h: number): void {
    const view = this.detail;
    if (!view) return;
    if (top < view.scrollOffset) view.scrollOffset = top;
    else if (top + h > view.scrollOffset + view.viewportHeight) {
      view.scrollOffset = top + h - view.viewportHeight;
    }
  }

  /**
   * 底部居中的方框键帽（设计稿的「[Tab] 关闭」）。
   *
   * **必须真的可点**——它是与 ✕ 并列的关闭出口，点它走的仍是 `requestClose()`
   * （= Game 注入的 `stateController.closePanel`），不是自关。
   */
  private buildCloseHint(win: UIWindow, bodyW: number, bodyH: number, focusItems: FocusItem[]): void {
    const raw = this.strings.get('quest', 'closeHint');
    // 「按 Tab 关闭」→ 键名 Tab + 说明 关闭；拆不出来就整句当说明，不因文案没按套路就漏掉出口
    const m = /^按\s*(\S+)\s+(.*)$/.exec(raw);
    const row = m && m[2] ? createKeyCap(m[1], m[2]) : createKeyCap(raw.replace(/[[\]]/g, ''));
    row.position.set(Math.round((bodyW - row.totalWidth) / 2), bodyH - FOOTER_H + UITheme.spacing.xs);
    row.eventMode = 'static';
    row.cursor = 'pointer';
    row.on('pointerover', () => { row.alpha = 0.75; this.focus.syncHover('close'); });
    // 指针移开时**只在焦点不在它身上**才复原：鼠标与手柄共用同一个"当前项"，
    // 移开鼠标不该把焦点高亮一起抹掉（抹掉就等于屏幕上没有焦点了）。
    row.on('pointerout', () => { if (this.focus.current?.id !== 'close') row.alpha = 1; });
    row.on('pointerdown', (e: { nativeEvent?: unknown }) => {
      markPointerConsumed(e.nativeEvent);
      this.requestClose();
    });
    win.body.addChild(row);

    // 焦点高亮复用它自己的 hover 画法（整枚键帽变淡一档），不另画框
    focusItems.push({
      id: 'close',
      ...rectOf(row),
      group: 'footer',
      onFocus: (on) => { row.alpha = on ? 0.75 : 1; },
      onActivate: () => this.requestClose(),
    });
  }

  /** 页签：当前那枚上凸、铺琥珀，并让下沿的细线在它底下断开——「连着内容区」就是这么来的 */
  private buildTabs(parent: Container, listW: number, y: number, focusItems: FocusItem[]): void {
    const tabs = this.tabLabels();
    const gap = UITheme.spacing.sm;
    const tabW = Math.floor((listW - gap * (tabs.length - 1)) / tabs.length);

    tabs.forEach((t, i) => {
      const x = i * (tabW + gap);
      const active = t.key === this.tab;

      const g = new Graphics();
      if (active) drawSelectedRow(g, x, y, tabW, TAB_H);
      else drawPanelBase(g, x, y + TAB_LIFT, tabW, TAB_H - TAB_LIFT, SKINS.row);
      parent.addChild(g);

      // 焦点高亮 = 页签自己那块「铺琥珀」的画法，盖在它自己那个框上
      // （当前页签是通高的 TAB_H，其余页签下沉了 TAB_LIFT）。
      // **必须紧跟 g 加进去**：它是不透明铺光，排在标签文字之后会把字盖掉。
      const focusG = new Graphics();
      if (active) drawSelectedRow(focusG, x, y, tabW, TAB_H);
      else drawSelectedRow(focusG, x, y + TAB_LIFT, tabW, TAB_H - TAB_LIFT);
      focusG.visible = false;
      focusG.eventMode = 'none';
      parent.addChild(focusG);

      focusItems.push({
        id: `tab:${t.key}`,
        x, y, w: tabW, h: TAB_H,
        group: 'tabs',
        onFocus: (on) => { focusG.visible = on; },
        // 当前页签没有"再切一次"这回事，不给激活回调（回车让回给下一层处理）
        onActivate: active ? undefined : () => this.switchTab(t.key),
      });

      const label = createStyledText({
        text: t.label,
        style: {
          // 页签 = 导航配角，停在 `body`：它抬到 bodyLarge 会和下面的任务名齐平，
          // 一眼看不出"哪个是内容、哪个是开关"。
          fontSize: UITheme.fontSize.body,
          fill: active ? UITheme.colors.title : UITheme.colors.hintMid,
          fontFamily: UITheme.fonts.ui,
          fontWeight: active ? 'bold' : 'normal',
          letterSpacing: 1,
        },
      });
      label.position.set(
        x + Math.round((tabW - label.width) / 2),
        y + TAB_LIFT + Math.round((TAB_H - TAB_LIFT - label.height) / 2),
      );
      label.eventMode = 'none';
      parent.addChild(label);

      if (active) return;
      const hit = new Graphics();
      hit.rect(x, y, tabW, TAB_H);
      hit.fill({ color: 0xffffff, alpha: UITheme.alpha.hitArea });
      hit.eventMode = 'static';
      hit.cursor = 'pointer';
      hit.on('pointerdown', (e) => {
        markPointerConsumed((e as { nativeEvent?: unknown }).nativeEvent);
        this.switchTab(t.key);
      });
      // 指针悬停即移焦：鼠标与手柄共用同一个"当前项"，移开鼠标再按方向键要从这里接着走
      hit.on('pointerover', () => this.focus.syncHover(`tab:${t.key}`));
      parent.addChild(hit);
    });

    // 页签条下沿：只在非当前页签底下画，当前页签因此与下面的列表连成一体
    const activeIdx = tabs.findIndex(t => t.key === this.tab);
    const baseY = y + TAB_H;
    const line = new Graphics();
    const segs: [number, number][] = [];
    const ax = activeIdx * (tabW + gap);
    if (ax > 0) segs.push([0, ax]);
    if (ax + tabW < listW) segs.push([ax + tabW, listW - ax - tabW]);
    for (const [sx, sw] of segs) line.rect(sx, baseY, sw, 1);
    line.fill({ color: UITheme.colors.borderSelected, alpha: UITheme.alpha.hairline });
    line.eventMode = 'none';
    parent.addChild(line);
  }

  private fillList(
    rows: QuestRow[],
    listW: number,
    /** 列表在内容区里的 y 偏移：焦点矩形要用面板坐标，行本身的 y 是滚动区内坐标 */
    listY: number,
    /** 收集焦点项，由 build 统一交给 UIFocus */
    focusItems: FocusItem[],
  ): void {
    const list = this.list;
    if (!list) return;

    if (rows.length === 0) {
      const t = createStyledText({
        text: this.strings.get('quest', 'empty'),
        style: {
          fontSize: UITheme.fontSize.small, fill: UITheme.colors.hint,
          fontFamily: UITheme.fonts.ui,
        },
      });
      t.position.set(UITheme.spacing.md, UITheme.spacing.md);
      list.content.addChild(t);
      list.refresh();
      return;
    }

    // 右侧留出滚动条的道
    const rowW = listW - UITheme.spacing.sm;
    const rowBodyH = ROW_H - ROW_GAP;

    rows.forEach((row, i) => {
      const y = i * ROW_H;
      const selected = row.key === this.selectedKey;

      const bg = new Graphics();
      if (selected) drawSelectedRow(bg, 0, y, rowW, rowBodyH);
      else drawPanelBase(bg, 0, y, rowW, rowBodyH, SKINS.row);
      list.content.addChild(bg);

      // 焦点高亮 = 行**自己那层选中画法**（琥珀铺光 + 金描边），不另发明一种焦点框。
      // 只给未选中的行备：`drawSelectedRow` 是半透明铺光，叠在已选中的行上会亮成两倍。
      // **必须紧跟 bg 加进去**：它排在徽章/文字之后会把它们盖掉。
      let focusG: Graphics | null = null;
      if (!selected) {
        focusG = new Graphics();
        drawSelectedRow(focusG, 0, y, rowW, rowBodyH);
        focusG.visible = false;
        focusG.eventMode = 'none';
        list.content.addChild(focusG);
      }

      const badge = createBadge(row.badge, row.badgeColor, BADGE_R);
      badge.position.set(BADGE_X, y + rowBodyH / 2);
      list.content.addChild(badge);

      // 行内两列：任务名是主角、简述是配角，但**配角不能被主角挤没**——
      // 旧写法是"标题吃剩多少给简述"，长标题一来简述就只剩两三个字。
      // 现在给简述留一条保底列（BRIEF_RATIO），标题只能占到"剩下的那截"为止；
      // 标题没占满时富余仍旧还给简述，短标题的行照样能多显几个字。
      // 当前任务那条挂一枚「当前」小牌，压在行的最右端；它占的宽从两列里先扣掉，
      // 否则简述会从它底下穿过去（两段字叠在一起，比不显示还糟）。
      let currentChip: (Container & { totalWidth: number }) | null = null;
      if (row.focused) {
        currentChip = createChip(this.strings.get('quest', 'currentMark'), UITheme.colors.questMain);
        currentChip.position.set(
          rowW - UITheme.spacing.md - currentChip.totalWidth,
          y + Math.round((rowBodyH - currentChip.height) / 2),
        );
        currentChip.eventMode = 'none';
        list.content.addChild(currentChip);
      }
      const chipW = currentChip ? currentChip.totalWidth + UITheme.spacing.sm : 0;

      const titleX = BADGE_X + BADGE_R + UITheme.spacing.md;
      const colW = rowW - titleX - UITheme.spacing.md - chipW;
      const briefFloor = row.brief ? Math.round(colW * BRIEF_RATIO) : 0;
      const titleW = row.brief ? colW - briefFloor - UITheme.spacing.lg : colW;

      const title = createStyledText({
        text: row.title,
        style: {
          // 条目名：面板里玩家真正在找的东西，稳在 `bodyLarge`。
          // 再抬到 title(30) 就与右栏的详情大名同级，两边同时喊，反倒没了主次。
          fontSize: UITheme.fontSize.bodyLarge,
          fill: selected ? UITheme.colors.title : row.titleColor,
          fontFamily: UITheme.fonts.ui, fontWeight: 'bold',
          letterSpacing: 1,
        },
      });
      title.position.set(titleX, y + Math.round((rowBodyH - title.height) / 2));
      title.eventMode = 'none';
      this.ellipsize(title, titleW);
      list.content.addChild(title);

      if (row.brief) {
        const brief = createStyledText({
          text: row.brief.replace(/\s+/g, ' '),
          style: {
            // 简述是"扫一眼"的配角：全文就在右栏，这里只需要一句提示。停在 `small`。
            fontSize: UITheme.fontSize.small,
            fill: selected ? UITheme.colors.bodyMuted : UITheme.colors.descTextDim,
            fontFamily: UITheme.fonts.ui,
          },
        });
        this.ellipsize(brief, Math.max(briefFloor, colW - title.width - UITheme.spacing.lg));
        brief.position.set(
          rowW - UITheme.spacing.md - chipW - brief.width,
          y + Math.round((rowBodyH - brief.height) / 2),
        );
        brief.eventMode = 'none';
        list.content.addChild(brief);
      }

      // 整行命中：Pixi 是逐子元素命中测试，行内空白会成死区
      const hit = new Graphics();
      hit.rect(0, y, rowW, rowBodyH);
      hit.fill({ color: 0xffffff, alpha: UITheme.alpha.hitArea });
      hit.eventMode = 'static';
      hit.cursor = 'pointer';
      const select = (): void => this.selectRow(row.key);
      hit.on('pointerdown', (e) => {
        markPointerConsumed((e as { nativeEvent?: unknown }).nativeEvent);
        select();
      });
      // 指针悬停即移焦：鼠标与手柄共用同一个"当前项"，不各走各的
      hit.on('pointerover', () => this.focus.syncHover(rowFocusId(row.key)));
      list.content.addChild(hit);

      focusItems.push({
        id: rowFocusId(row.key),
        // 焦点矩形取**面板坐标**（列表偏移 + 行在滚动区内的 y），空间导航才能与右栏比位置
        x: 0, y: listY + y, w: rowW, h: rowBodyH,
        group: QuestPanelUI.GROUP_BODY,
        onFocus: (f) => {
          if (focusG) focusG.visible = f;
          // 焦点走到视口外的行要把它滚进来（只动 scrollOffset，不碰选中态）
          if (f) this.revealRow(i);
        },
        onActivate: select,
      });
    });

    list.refresh();
  }

  private buildDetail(
    win: UIWindow,
    row: QuestRow,
    x: number,
    w: number,
    y: number,
    h: number,
    splitX: () => number,
    /** 收集焦点项（右栏的可点项与列表分属两组，方向键先在组内找） */
    focusItems: FocusItem[],
  ): void {
    const view = new UIScrollView(this.renderer, {
      width: w,
      height: h,
      bottomPadding: UITheme.spacing.md,
      hitTest: (px) => px >= splitX(),
    });
    view.container.position.set(x, y);
    win.body.addChild(view.container);
    this.detail = view;

    const wrapW = w - UITheme.spacing.sm;
    let cy = 0;

    const name = createStyledText({
      text: row.title,
      style: {
        fontSize: UITheme.fontSize.title, fill: UITheme.colors.title,
        fontFamily: UITheme.fonts.display, fontWeight: 'bold',
        letterSpacing: UITheme.letterSpacing.title,
        wordWrap: true, breakWords: true, wordWrapWidth: wrapW,
      },
    });
    name.position.set(0, cy);
    view.content.addChild(name);
    // title(30) + 字距 4 的大名下面留 sm(8) 会贴着正文；跟着字号抬一档间距
    cy += name.height + UITheme.spacing.md;

    if (row.body) {
      const body = createStyledText({
        text: row.body,
        style: {
          // 右栏正文是这一栏的**主角**：玩家要停下来读几秒的就是它。
          // 原来是 small(16)/行距 20——那是列表次要文字的档位，读长句会累。
          fontSize: UITheme.fontSize.body,
          fill: UITheme.colors.descText,
          fontFamily: UITheme.fonts.ui, lineHeight: 30,
          wordWrap: true, breakWords: true, wordWrapWidth: wrapW,
        },
      });
      body.position.set(0, cy);
      view.content.addChild(body);
      cy += body.height + UITheme.spacing.md;
    }

    if (row.objectives.length > 0) {
      const rule = createRule(wrapW);
      rule.position.set(0, cy);
      view.content.addChild(rule);
      cy += UITheme.spacing.md;

      const head = createStyledText({
        text: this.strings.get('quest', 'objectives'),
        style: {
          fontSize: UITheme.fontSize.small,
          fill: UITheme.colors.hintMid,
          fontFamily: UITheme.fonts.ui,
          letterSpacing: UITheme.letterSpacing.title,
        },
      });
      head.position.set(0, cy);
      head.eventMode = 'none';
      view.content.addChild(head);
      cy += head.height + UITheme.spacing.sm;

      for (const obj of row.objectives) {
        const box = this.checkbox(obj.done);
        // 方框与 body(20) 的首行视觉中线对齐（字框比方框高，往下让 3px）
        box.position.set(0, cy + 3);
        view.content.addChild(box);

        const t = createStyledText({
          text: obj.text,
          style: {
            // 目标条目是玩家逐条核对的内容行，与正文同档；配角是它前面那个方框。
            fontSize: UITheme.fontSize.body,
            fill: obj.done ? UITheme.colors.bodyMuted : UITheme.colors.descText,
            fontFamily: UITheme.fonts.ui, lineHeight: 28,
            wordWrap: true, breakWords: true,
            wordWrapWidth: wrapW - CHECK_SIZE - UITheme.spacing.md,
          },
        });
        t.position.set(CHECK_SIZE + UITheme.spacing.md, cy);
        view.content.addChild(t);
        cy += Math.max(CHECK_SIZE, t.height) + UITheme.spacing.sm;
      }
      cy += UITheme.spacing.xs;
    }

    // 活计的运行状态行（第几单 / 追踪中 / 搁置）：**只是状态词，不再是按钮**——
    // 「设为当前任务」已经收敛成下面那一个入口，两处都能改同一个槽只会让人不知道点哪个。
    if (row.runMark) {
      const mark = createStyledText({
        text: row.runMark,
        style: {
          // 状态词停在 small：跟着正文一起放大就会比正文还抢眼，可它只是一行标记。
          fontSize: UITheme.fontSize.small,
          fill: UITheme.colors.questMain,
          fontFamily: UITheme.fonts.ui,
          wordWrap: true, breakWords: true, wordWrapWidth: wrapW,
        },
      });
      mark.position.set(0, cy);
      mark.eventMode = 'none';
      view.content.addChild(mark);
      cy += mark.height + UITheme.spacing.sm;
    }

    // 「设为当前任务」：右栏唯一的可点项（当前任务槽全局唯一，见玩法文档 D6）。
    // 已经是当前任务的显示成不可点的状态词，不给"再设一次"这种空操作。
    const focusLabel = row.focused
      ? this.strings.get('quest', 'isCurrent')
      : (row.canFocus ? this.strings.get('quest', 'setCurrent') : '');
    if (focusLabel) {
      const clickable = !row.focused && row.canFocus;
      const btnY = cy;
      const label = createStyledText({
        text: focusLabel,
        style: {
          fontSize: UITheme.fontSize.body,
          fill: clickable ? UITheme.colors.title : UITheme.colors.questMain,
          fontFamily: UITheme.fonts.ui,
          wordWrap: true, breakWords: true, wordWrapWidth: wrapW,
        },
      });
      const btnH = label.height + UITheme.spacing.sm;

      // 焦点高亮 = 全站那层「当前项」的琥珀铺光（`drawSelectedRow`），与列表行、页签同一种画法。
      // **必须在文字之前加进去**：它是半透明铺光，排在文字之后会把字盖住。
      let btnFocusG: Graphics | null = null;
      if (clickable) {
        btnFocusG = new Graphics();
        drawSelectedRow(btnFocusG, 0, btnY, wrapW, btnH);
        btnFocusG.visible = false;
        btnFocusG.eventMode = 'none';
        view.content.addChild(btnFocusG);
      }
      label.position.set(UITheme.spacing.sm, btnY + Math.round((btnH - label.height) / 2));
      label.eventMode = 'none';
      view.content.addChild(label);

      if (clickable) {
        const qid = row.questId;
        const act = (): void => { void this.onSetCurrent(qid); };
        const hit = new Graphics();
        hit.rect(0, btnY, wrapW, btnH);
        hit.fill({ color: 0xffffff, alpha: UITheme.alpha.hitArea });
        hit.eventMode = 'static';
        hit.cursor = 'pointer';
        hit.on('pointerdown', (e) => {
          markPointerConsumed((e as { nativeEvent?: unknown }).nativeEvent);
          act();
        });
        hit.on('pointerover', () => this.focus.syncHover('detail:focus'));
        view.content.addChild(hit);

        // 右栏唯一的可点项。**与左栏列表同组**（GROUP_BODY）——左右键要跨得过去
        // 就得靠"同组优先"抢在跨组回退之前，否则会被正上方的页签条劫走（见 focus 字段注释）。
        // 上下键不会因此乱跳：同栏行的横向偏移是 0，打分永远赢过跨栏这一项。
        focusItems.push({
          id: 'detail:focus',
          x, y: y + btnY, w: wrapW, h: btnH,
          group: QuestPanelUI.GROUP_BODY,
          onFocus: (f) => {
            if (btnFocusG) btnFocusG.visible = f;
            // 正文长的时候这行会被滚出视口，焦点落上来得把它滚回来
            if (f) this.revealDetail(btnY, btnH);
          },
          onActivate: act,
        });
      }
      cy += btnH + UITheme.spacing.sm;
    }

    view.refresh();
  }

  /** 复选框：方框 + 两段线的勾。已完成走金描边 + 琥珀勾，未完成只有一圈暗木边。 */
  private checkbox(done: boolean): Graphics {
    const g = new Graphics();
    g.rect(0, 0, CHECK_SIZE, CHECK_SIZE);
    g.stroke({
      color: done ? UITheme.colors.borderSelected : UITheme.colors.borderActive,
      width: 1,
    });
    if (done) {
      g.moveTo(CHECK_SIZE * 0.22, CHECK_SIZE * 0.52);
      g.lineTo(CHECK_SIZE * 0.44, CHECK_SIZE * 0.75);
      g.lineTo(CHECK_SIZE * 0.80, CHECK_SIZE * 0.26);
      g.stroke({ color: UITheme.colors.title, width: 1.5 });
    }
    g.eventMode = 'none';
    return g;
  }

  /** 一行放不下就截到能放下为止（省略号是标点，不是文案） */
  private ellipsize(t: Text, maxW: number): void {
    if (t.width <= maxW || maxW <= 0) return;
    // 按**可见字数**退，且用 sliceStyledMarkup 保住色标记成对——
    // 直接对带标记原串 slice 会切出半个 `[c:emph`，剥不掉、原样露给玩家。
    const raw = getStyledRaw(t);
    for (let n = plainTextLength(raw) - 1; n > 0; n--) {
      setStyledText(t, `${sliceStyledMarkup(raw, n)}…`);
      if (t.width <= maxW) return;
    }
  }

  /**
   * 「设为当前任务」：交给 QuestManager（活计会顺带经叙事队列激活），成功与否都以它的状态为准。
   *
   * 重建由 `quest:changed` 触发，这里不自己 build()——否则槽真变了会重建两次。
   * 但焦点得自己收：设完之后「设为当前任务」那一项就不存在了（已经是当前任务了），
   * `setItems` 的兜底是"落到几何上最近的一项"——那正好是底部的关闭键帽，
   * 等于把手柄玩家一脚踢到出口上。明确收回到刚操作的那条行上。
   */
  private async onSetCurrent(questId: string): Promise<void> {
    if (this.focusPending) return;
    this.focusPending = true;
    try {
      await this.questData.requestFocusQuest(questId);
    } catch (e) {
      console.warn('QuestPanelUI: 设为当前任务失败', e);
    } finally {
      this.focusPending = false;
    }
    if (!this._isOpen) return;
    // 槽真的变了的话，`quest:changed` 已经排了一次重建（微任务，排在本延续之前入队、
    // 因此已经跑完）。这里只负责把焦点从"刚消失的那一项"收回到操作过的行上：
    // `setItems` 的兜底是"落到几何上最近的一项"——那正好是底部的关闭键帽，
    // 等于把手柄玩家一脚踢到出口上。
    if (this.selectedKey) this.focus.focusDefault(rowFocusId(this.selectedKey));
  }

  /**
   * 键盘 / 手柄：**焦点优先，滚动兜底**。
   *
   * 方向键先交给 `UIFocus`——它把焦点朝那个方向挪到最近的可交互元素（页签/行/右栏可点项/
   * 底部键帽都在同一套坐标里比距离），挪不动才把按键让回给滚动区当纯滚动用；回车/空格
   * 激活当前焦点项。两级都没吃下的按键**一律不吞**，否则会抢走全局快捷键（Tab 关面板等）。
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
