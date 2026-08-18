import { CanvasTextMetrics, Container, Graphics, Rectangle, Text, TextStyle } from 'pixi.js';
import { UITheme } from './UITheme';
import { createIcon, createRule, drawFocusRing, drawHoverRow } from './components/UIDecor';
import { UIWindow, WINDOW_SIZES } from './components/UIWindow';
import { UIScrollView } from './components/UIScrollView';
import { UIFocus, type FocusItem } from './components/UIFocus';
import { isPointerDragScrolling, markPointerConsumed } from './uiPointerCoords';
import { eventChannelColor, eventChannelIcon } from './eventChannelStyle';
import type { Renderer } from '../rendering/Renderer';
import type { EventBus } from '../core/EventBus';
import type { StringsProvider } from '../core/StringsProvider';
import type { GameLogEntry, GameLogLink, IGameLogDataProvider } from '../data/types';
import { createStyledText } from '../core/styledText';
import { hasStyleMarkup, paletteTagStyles, toPixiTagged } from '../core/textStyle';

/**
 * 事件日志面板（玩法文档 K3）——**这一局游戏的时间线**，不只是对话。
 *
 * 真相不在这里：条目全部由 {@link GameLogManager} 持有并入存档，本类是它的**只读视图**
 * （与 HUD / GuidanceLayer 同一范式）。升级前本类自持 entries + 手工挂存档桶，
 * 要往里加物品/任务/线索就得让 UI 反向依赖一堆系统——那是分层红线。
 *
 * ## 三样让"信息轰炸"变得可查的东西
 *
 * 1. **通道图标与提示条同一套语汇**（见 {@link eventChannelStyle}）：玩家把"刚才闪过去
 *    那条木条"和"日志里这条"一眼对上号，才谈得上"错过了能找回来"。
 * 2. **带目标的条目整行可点**：点它关掉日志、跳到那件东西所在的面板并选中它
 *    （路由在组装层，见 `setJumpHandler`）。
 * 3. **「只看事件」过滤**（Tab 切换）：一屏对白里捞"我刚才到底得了些什么"。
 *
 * ## 排版仍是"只量不建 + 视口建行"
 *
 * 200 条对话 + 100 条事件全建出来就是 300 个显示对象、300 张画布纹理，而 mask 是模板裁切
 * **不做剔除**，屏幕外的两百多条照样提交 draw call。所以 {@link measureLayout} 只用
 * `CanvasTextMetrics` 量占位，只有 {@link syncRows} 圈进视口的条目才真的构造。
 *
 * ⚠ 量高与建行**必须同口径**（同一份解析后文本、同一份样式变体、同一个换行宽）：
 * `rowLayout[i].y` 是累加的，量歪一条后面每一行跟着错位、滚到底还留空白。
 * 解析后的文本因此在 {@link measureLayout} 里算一次、存进 {@link texts}，两边共用。
 */

/** 单条最长字符数由系统侧（GameLogManager）夹，这里只管画 */

/**
 * 一行日志的最小步进，同时是滚轮/方向键的一格。
 * 40 = 一条单行日志的实际行高，「一格 = 一条」才对得上手感。
 */
const LINE_HEIGHT = 40;
/** 滚到底时最后一行不贴视口下沿 */
const BOTTOM_PAD = UITheme.spacing.md;
/**
 * 虚拟化的上下缓冲带。滚轮一格最多百来像素，留 6 行的余量就不会在快滚时看见空白，
 * 又不至于把常驻条目数抬回三位数。
 */
const ROW_BUFFER = LINE_HEIGHT * 6;
/**
 * 每条日志的上下内边距。上下各给一档，行与行之间才是均等呼吸
 * （只在下方加会让整叠行读起来往下掉）。
 */
const ROW_PAD_Y = UITheme.spacing.sm;
/**
 * 左列宽。设计稿的列表语汇是「左边一列身份、右边一栏正文」——
 * 把名字和台词混在一行里（`名: 台词`）读起来是一堵墙。
 * 对话行摆说话人，事件行摆通道图标，两者共用这一列宽度，整叠才有同一条左边界。
 */
const SPEAKER_W = 108;
/** 玩家选项在左列的记号（选项没有说话人，但列不能空着——空列会让整叠行失去左边界） */
const CHOICE_MARK = '›';
/** 事件行左列那枚木刻剪影的边长 */
const ICON_SIZE = 20;
/**
 * 右端"可去"记号的走道宽。
 *
 * **所有行都留**（不只可点的那些）：换行宽一旦按行分两种，量高与建行就有两套口径，
 * 那正是 `rowLayout` 错位的经典成因。16px 出自 ~600px 的正文栏，视觉上无感。
 */
const LINK_ARROW_W = 16;
/** 日/时段分隔带的高度（压在该条上方） */
const STAMP_H = 30;
/** 过滤条高度（在滚动区之上，属窗体内容区） */
const FILTER_H = 34;

type LogFilter = 'all' | 'events';

/** 该条上方要不要压一条「第N日 · 时段」分隔 */
function sameStamp(a: GameLogEntry['stamp'], b: GameLogEntry['stamp']): boolean {
  if (!a || !b) return !a && !b;
  return a.day === b.day && a.phase === b.phase;
}

export class DialogueLogUI {
  private renderer: Renderer;
  private eventBus: EventBus;
  private strings: StringsProvider;
  private closeRequester: (() => void) | null = null;
  private data: IGameLogDataProvider | null = null;
  private resolveDisplay: ((s: string) => string) | null = null;
  private jumpHandler: ((link: GameLogLink) => void) | null = null;

  private win: UIWindow | null = null;
  private list: UIScrollView | null = null;
  private _isOpen = false;

  /**
   * 过滤档位。**记在实例上、不落盘**：玩家这一趟切到「只看事件」，关掉再开还是那一档
   * （同一段游玩里反复切档最烦）；但它是视图偏好不是游戏状态，不进存档也不写工程文件。
   */
  private filter: LogFilter = 'all';

  /** 本次 build 参与显示的条目（已按 filter 筛过）；rowLayout / texts 与它同序等长 */
  private visible: GameLogEntry[] = [];
  /** 解析（`[tag:…]`）后的正文，量高与建行共用同一份——两边各解析一次必然漂 */
  private texts: string[] = [];
  /** 解析后的左列文字（对话行是说话人；事件行为空串，那一列画图标） */
  private lefts: string[] = [];
  /** 该条上方的日/时段分隔文案；null = 不画 */
  private stamps: (string | null)[] = [];
  /**
   * 量高时对每条**正文**做出的"挂不挂色板"决定；建行原样复用（见 {@link styleAt}）。
   * 左列（说话人）另存一份：同一行的两列可能一个带标记一个不带。
   */
  private tagged: boolean[] = [];
  private taggedLeft: boolean[] = [];
  /** 每条的纵向占位。`y` 含分隔带，`h` 是正文块高，`stampH` 是分隔带高 */
  private rowLayout: { y: number; h: number; stampH: number }[] = [];
  private totalH = 0;
  /** 当前**真正构造出来**的行：索引 → 行容器。虚拟化后同时存在的只有视口附近十几条 */
  private rows = new Map<number, Container>();
  /** 行内的高亮层（焦点/悬停），随行建随行毁 */
  private rowDecor = new Map<number, { hover: Graphics; ring: Graphics }>();

  /** 量高用的样式（**只量不建**；真正建行时 clone 并改 fill，见 syncRows） */
  private bodyStyle: TextStyle | null = null;
  private bodyStylePlain: TextStyle | null = null;
  private leftStyle: TextStyle | null = null;
  private leftStylePlain: TextStyle | null = null;
  /** 正文列宽（量高与建行同一口径），build 时按窗体宽算定 */
  private bodyColW = 0;
  /** build 中途暂停补行：先定位到底部再一次性补，省掉"先补顶部再全扔"的空转 */
  private rowsSuspended = false;

  /**
   * 键盘/手柄焦点：可点的行一组、过滤条一组。
   *
   * ⚠ **过滤条不绑快捷键**（第一版绑了 Tab，实测无效）：Tab 是任务面板注册的全局快捷键，
   * 面板开着时它先被 `GameStateController.handleKeyDown` 认走。全站面板切页签一律靠
   * 焦点导航（QuestPanelUI 的页签条就是这么走的），这里照办——键盘/手柄从列表顶端
   * 按「上」即到过滤条，鼠标直接点。
   *
   * 分组是必须的：过滤条压在列表正上方、与行同轴，`UIFocus.pick` 的方向判据
   * （主轴分量 > 1）在这种贴合布局下会让上下键乱跳；同组优先能在跨组回退**之前**
   * 就把同一列的上/下一项选出来（QuestPanelUI 踩过同一个坑，注释在那边）。
   */
  private focus = new UIFocus();
  /** 过滤条两枚 chip 的高亮层（随窗体重建；焦点回调按 id 找） */
  private chipDecor = new Map<LogFilter, { hover: Graphics; ring: Graphics }>();
  private static readonly GROUP_ROWS = 'rows';
  private static readonly GROUP_FILTER = 'filter';

  /** 面板开着期间跟新内容用；开时订、关时摘（生命周期对称） */
  private logChangedCb: () => void;
  private unsubLogChanged: (() => void) | null = null;
  /** 已排了一次重建（同一批变化只重建一次） */
  private rebuildScheduled = false;
  private onKeyBound: (e: KeyboardEvent) => void;

  constructor(renderer: Renderer, eventBus: EventBus, strings: StringsProvider) {
    this.renderer = renderer;
    this.eventBus = eventBus;
    this.strings = strings;
    this.onKeyBound = (e) => this.onKey(e);
    this.logChangedCb = () => this.onLogChanged();
  }

  get isOpen(): boolean {
    return this._isOpen;
  }

  /** 注入日志数据口（组装层给 GameLogManager；UI 不持系统实例） */
  setDataProvider(provider: IGameLogDataProvider | null): void {
    this.data = provider;
  }

  /** 注入 `[tag:…]` 解析（与全站面板同一注入范式）。日志存 raw，显示时才解析。 */
  setResolveDisplay(fn: ((s: string) => string) | null): void {
    this.resolveDisplay = fn;
  }

  /**
   * 注入"点了某条要去哪"的路由（组装层实现：关本面板 → 开目标面板 → 选中该条）。
   * 不注入 = 条目一律不可点（视觉上也不给记号），不会点了没反应。
   */
  setJumpHandler(fn: ((link: GameLogLink) => void) | null): void {
    this.jumpHandler = fn;
  }

  /** 由 Game 注入关闭通道（精确寻址、弹栈、恢复状态；不许面板自己 close） */
  setCloseRequester(fn: (() => void) | null): void {
    this.closeRequester = fn;
  }

  private requestClose(): void {
    this.closeRequester?.();
  }

  private r(s: string): string {
    return this.resolveDisplay ? this.resolveDisplay(s) : s;
  }

  open(): void {
    if (this._isOpen) return;
    this._isOpen = true;
    // 打开即已读：HUD 那个未读点的语义就是"有你没看过的事发生了"
    this.data?.markAllSeen();
    this.build(true);
    window.addEventListener('keydown', this.onKeyBound);
    // 面板开着期间跟新内容（本面板在对话/遭遇态也开得起来——「回看上一句」正是它的用处，
    // 那期间新台词还在往里落，停在打开那一刻的快照就是错的信息）
    this.eventBus.on('gameLog:changed', this.logChangedCb);
    this.unsubLogChanged = () => this.eventBus.off('gameLog:changed', this.logChangedCb);
  }

  close(): void {
    if (!this._isOpen) return;
    this._isOpen = false;
    window.removeEventListener('keydown', this.onKeyBound);
    this.unsubLogChanged?.();
    this.unsubLogChanged = null;
    // 关场淡出（绕开 build/destroy 共用的瞬时 teardown）：先摘滚动区输入面
    // （detachInput 后 onScroll 不再触发，syncRows 不会再动虚拟化行），
    // 行的视觉节点随窗体的 fadeOutAndDestroy 一起拆。
    this.forgetRows();
    this.focus.destroy();
    this.list?.detachInput();
    const win = this.win;
    this.list = null;
    this.win = null;
    win?.fadeOutAndDestroy();
    this.destroyStyles();
  }

  private teardown(): void {
    // list.destroy() 会连带销毁 content 下的行（纹理归还 Pixi 文本纹理池）
    this.forgetRows();
    this.focus.destroy();
    this.list?.destroy();
    this.win?.destroy();
    this.list = null;
    this.win = null;
    this.destroyStyles();
  }

  private forgetRows(): void {
    this.rows.clear();
    this.rowDecor.clear();
    this.chipDecor.clear();
    this.rowLayout = [];
    this.totalH = 0;
    // 解析后的文本/决定表与 rowLayout 是一套，一起丢——留着就是一份对不上号的旧快照
    this.visible = [];
    this.texts = [];
    this.lefts = [];
    this.stamps = [];
    this.tagged = [];
    this.taggedLeft = [];
  }

  private destroyStyles(): void {
    // 量高用的样式可同步销毁：行上挂的都是 clone（见 syncRows）
    this.bodyStyle?.destroy();
    this.bodyStylePlain?.destroy();
    this.leftStyle?.destroy();
    this.leftStylePlain?.destroy();
    this.bodyStyle = null;
    this.bodyStylePlain = null;
    this.leftStyle = null;
    this.leftStylePlain = null;
  }

  /** 预设尺寸在小画布（调试侧栏挤压 #game-mount）下要收边 */
  private windowSize(): { width: number; height: number } {
    const margin = UITheme.spacing.xl * 2;
    return {
      width: Math.min(WINDOW_SIZES.lg.width, this.renderer.screenWidth - margin),
      height: Math.min(WINDOW_SIZES.lg.height, this.renderer.screenHeight - margin),
    };
  }

  /** 当前档位下要显示哪些条（`events` 档滤掉整个对话通道，含段落抬头） */
  private collectVisible(): GameLogEntry[] {
    const all = this.data?.getEntries() ?? [];
    if (this.filter === 'all') return [...all];
    return all.filter((e) => e.channel !== 'dialogue');
  }

  /**
   * @param animate 仅首次打开为 true。切档位引起的重绘必须走 `attach()`，
   * 否则每切一次都重放一遍开场动效；而**忘了挂载**会让整个面板直接从画面消失。
   */
  private build(animate = false): void {
    const keepFocusId = this.focus.current?.id ?? null;
    this.teardown();

    this.visible = this.collectVisible();
    const count = this.visible.length;

    const win = new UIWindow(this.renderer, {
      size: this.windowSize(),
      title: this.strings.get('dialogueLog', 'title'),
      // 滚动条只表达"位置/比例"，表达不了"一共几条"——这半条信息在这里补回来
      subtitle: count > 0 ? this.strings.get('dialogueLog', 'total', { count }) : undefined,
      closeHint: this.strings.get('dialogueLog', 'closeHint'),
      onClose: () => this.requestClose(),
    });
    this.win = win;

    const filterItems = this.buildFilterRow(win);

    const listTop = FILTER_H;
    const list = new UIScrollView(this.renderer, {
      width: win.bodyWidth,
      height: Math.max(1, win.bodyHeight - listTop),
      step: LINE_HEIGHT,
      bottomPadding: BOTTOM_PAD,
      onScroll: (offset) => this.syncRows(offset),
    });
    list.container.y = listTop;
    win.body.addChild(list.container);
    this.list = list;

    if (count === 0) {
      this.fillEmpty(win.bodyWidth);
      list.refresh();
    } else {
      this.rowsSuspended = true;
      this.measureLayout(win.bodyWidth);
      // 总高显式告知：只建视口附近几条时 getLocalBounds 量不到全长，滚动条比例会作假
      list.setContentHeight(this.totalH);
      // 打开时停在最新一条
      list.scrollOffset = Number.MAX_SAFE_INTEGER;
      this.rowsSuspended = false;
      this.syncRows(list.scrollOffset);
    }
    // 空态也要登记：一屏「只看事件」空的时候，玩家总得能切回「全部」
    this.registerFocusItems(filterItems, keepFocusId);

    if (animate) win.open();
    else win.attach();
  }

  /**
   * 过滤条：「全部 / 只看事件」两枚小字按钮 + 一句 Tab 提示。
   * 走的是最轻的一档语汇（选中琥珀、未选中灰），不占一整条页签栏的分量——
   * 这块面板的主角是那叠行。
   */
  /**
   * 过滤条：「全部 / 只看事件」两枚小字 chip。
   * 走最轻的一档语汇（选中琥珀 + 下划、未选中灰），不占一整条页签栏的分量——
   * 这块面板的主角是那叠行。
   *
   * @returns 本行的焦点项（**y 取负**：它在列表内容原点之上，好让列表顶端按「上」够到它）
   */
  private buildFilterRow(win: UIWindow): FocusItem[] {
    const row = new Container();
    const items: FocusItem[] = [];
    this.chipDecor.clear();
    let x = 0;
    const chips: { key: LogFilter; label: string }[] = [
      { key: 'all', label: this.strings.get('dialogueLog', 'filterAll') },
      { key: 'events', label: this.strings.get('dialogueLog', 'filterEvents') },
    ];
    for (const chip of chips) {
      const active = this.filter === chip.key;
      const t = createStyledText({
        text: chip.label,
        style: {
          fontSize: UITheme.fontSize.small,
          fill: active ? UITheme.colors.title : UITheme.colors.hintMid,
          fontFamily: UITheme.fonts.ui,
        },
      });
      t.position.set(x, 4);
      t.eventMode = 'none';

      const boxX = x - UITheme.spacing.xs;
      const boxW = t.width + UITheme.spacing.xs * 2;
      const boxH = FILTER_H - 8;
      // 三态三画法（见 UIFocus 类注释）：悬停 = 极淡暖底，导航光标 = 空心金框，
      // 选中 = 文字转琥珀 + 下划线（下面那条 bar）。三张互不相同。
      const hover = new Graphics();
      drawHoverRow(hover, boxX, 0, boxW, boxH);
      hover.alpha = 0;
      hover.eventMode = 'none';
      row.addChild(hover);
      const ring = new Graphics();
      drawFocusRing(ring, boxX, 0, boxW, boxH);
      ring.alpha = 0;
      ring.eventMode = 'none';
      row.addChild(ring);
      this.chipDecor.set(chip.key, { hover, ring });

      row.addChild(t);

      if (active) {
        // 选中记号按**文字实际宽度**画（挂在行盒左沿的竖条会飘在半空——ui-component-layer 已知坑）
        const bar = new Graphics();
        bar.rect(x, 4 + t.height + 2, t.width, 1.5);
        bar.fill({ color: UITheme.colors.borderSelected, alpha: 0.9 });
        bar.eventMode = 'none';
        row.addChild(bar);
      }

      // 容器当按钮必须自带 hitArea（pixi-v8-traps：普通 Container 恒判不中）
      const id = `filter:${chip.key}`;
      const hit = new Container();
      hit.eventMode = 'static';
      hit.cursor = 'pointer';
      hit.hitArea = new Rectangle(boxX, 0, boxW, boxH);
      hit.on('pointerover', () => this.focus.syncHover(id));
      hit.on('pointerout', () => this.focus.clearHover(id));
      hit.on('pointerdown', (e: { nativeEvent?: unknown }) => {
        markPointerConsumed(e.nativeEvent);
      });
      hit.on('pointerup', (e: { nativeEvent?: unknown }) => {
        markPointerConsumed(e.nativeEvent);
        if (isPointerDragScrolling()) return;
        this.setFilter(chip.key);
      });
      row.addChild(hit);

      const key = chip.key;
      items.push({
        id,
        // y 取负：过滤条在滚动内容原点**之上**（行的 y 从 0 起），
        // 于是「列表最顶那行按上」正好落到它，而列表滚下去之后上键仍在行之间走。
        x: boxX, y: -FILTER_H, w: boxW, h: boxH,
        group: DialogueLogUI.GROUP_FILTER,
        onFocus: (on, via) => {
          const d = this.chipDecor.get(key);
          if (!d || d.hover.destroyed || d.ring.destroyed) return;
          d.hover.alpha = on && via === 'pointer' ? 0.85 : 0;
          d.ring.alpha = on && via === 'key' ? 1 : 0;
        },
        onActivate: () => this.setFilter(key),
      });

      x += t.width + UITheme.spacing.lg;
    }

    const rule = createRule(win.bodyWidth);
    rule.y = FILTER_H - 8;
    rule.alpha = 0.5;
    row.addChild(rule);

    win.body.addChild(row);
    return items;
  }

  private setFilter(next: LogFilter): void {
    if (this.filter === next) return;
    this.filter = next;
    this.eventBus.emit('ui:confirm', {});
    this.build();
  }

  /** 滚动位是不是已经贴着底（跟新内容的判据；亚像素与滚动条圆整留 2px 余量） */
  private isAtBottom(): boolean {
    const list = this.list;
    if (!list) return true;
    return list.scrollOffset >= Math.max(0, this.totalH - list.viewportHeight) - 2;
  }

  /**
   * 日志内容变了（面板开着期间）。
   *
   * **只在已经贴着底时跟**——玩家正翻上面某一段时把他甩到底部，比不更新更糟
   * （聊天记录类 UI 的通行做法：auto-follow only when already at bottom）。
   * 没跟上的那几条仍算未读，关掉面板红点会亮，玩家再开就看到。
   *
   * 重建**排进微任务**、不在事件回调里同步 teardown：这条事件可能是行内 pointerdown
   * 打进来的（点条目 → 跳转 → 目标系统发事件），同步 build 等于在 Pixi 正分发这枚
   * Graphics 的指针事件时把它 destroy 掉（QuestPanelUI 踩过同一脚）。
   */
  private onLogChanged(): void {
    if (!this._isOpen || this.rebuildScheduled) return;
    if (!this.isAtBottom()) return;
    this.rebuildScheduled = true;
    queueMicrotask(() => {
      this.rebuildScheduled = false;
      if (!this._isOpen) return;
      this.build();
      // 新落的这条已经在屏幕上了，就不该再算未读
      this.data?.markAllSeen();
    });
  }

  private fillEmpty(bodyWidth: number): void {
    const list = this.list;
    if (!list) return;
    const empty = createStyledText({
      text: this.strings.get('dialogueLog', this.filter === 'events' ? 'emptyEvents' : 'empty'),
      style: {
        // 空态是这块面板上**唯一**一行字，不是角落里的说明：
        // small 在这么大一片空里读起来像没加载完，抬到与正文同档（颜色仍压成 hint 灰）
        fontSize: UITheme.fontSize.body, fill: UITheme.colors.hintMid,
        fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true,
        wordWrapWidth: bodyWidth - UITheme.spacing.md,
      },
    });
    empty.x = UITheme.spacing.sm;
    empty.y = ROW_PAD_Y;
    list.content.addChild(empty);
  }

  /** 左列文字：对话行是说话人，选项一个记号，旁白/事件留空（事件那一列画图标） */
  private leftTextOf(entry: GameLogEntry): string {
    if (entry.type === 'choice') return CHOICE_MARK;
    if (entry.type === 'line') return entry.speaker ?? '';
    return '';
  }

  private isLinked(entry: GameLogEntry): boolean {
    return !!entry.link && !!this.jumpHandler;
  }

  /**
   * 这一串该不该挂语义色板。与 `styledText.needsTagStyles` 逐字同口径。
   *
   * ⚠ 挂了 tagStyles 之后，正文里**字面写着**的 `<dim>` 对 Pixi 就是真 tag——它会把整段吞掉、
   * 其后所有字被无声染色且永不闭合。所以只有"真带 `[c:…]` 且没有裸 `<`"时才挂。
   */
  private static usesTagStyles(raw: string): boolean {
    return hasStyleMarkup(raw) && !raw.includes('<');
  }

  /**
   * 按**量高时记下的那个决定**取样式。
   *
   * 不是在建行时重新判一次：量高与建行各判一次，就给了两边挑到不同变体的机会，
   * 而后果是静默的——那一行渲染时被吞掉 `<…>`、实际高度与量出来的不符，
   * `rowLayout[i].y` 是累加的，从这行起整叠错位、滚到底还留一截空白。
   * （第一版就是在这儿栽的：两个分支传了同一份 clone。）
   * 决定只在 {@link measureLayout} 做一次、存进 {@link tagged}，这里只读。
   */
  private styleAt(i: number, tagged: TextStyle | null, plain: TextStyle | null): TextStyle {
    return (this.tagged[i] ? tagged : plain) ?? tagged ?? plain!;
  }

  /** 同 {@link styleAt}，左列（说话人）那一份决定 */
  private styleAtLeft(i: number, tagged: TextStyle | null, plain: TextStyle | null): TextStyle {
    return (this.taggedLeft[i] ? tagged : plain) ?? tagged ?? plain!;
  }

  /**
   * 排版：**只量不建**。
   *
   * 顺带把解析后的文本、左列文字、日/时段分隔一次算齐存起来——建行时直接取，
   * 保证"量的那一串"和"画的那一串"逐字相同。
   */
  private measureLayout(bodyWidth: number): void {
    this.bodyColW = Math.max(
      1,
      bodyWidth - SPEAKER_W - UITheme.spacing.md - LINK_ARROW_W - UITheme.spacing.sm,
    );

    const base = {
      fontSize: UITheme.fontSize.body,
      fontFamily: UITheme.fonts.ui,
      wordWrap: true, breakWords: true,
      wordWrapWidth: this.bodyColW,
      fill: UITheme.colors.body,
    };
    // 量高与 fill 无关，两份变体的差别只在挂不挂色板（见 styleFor）
    this.bodyStyle = new TextStyle({ ...base, tagStyles: paletteTagStyles() });
    this.bodyStylePlain = new TextStyle({ ...base });
    const leftBase = {
      fontSize: UITheme.fontSize.body,
      fontFamily: UITheme.fonts.display,
      fill: UITheme.colors.title,
      wordWrap: true, breakWords: true,
      wordWrapWidth: SPEAKER_W,
    };
    this.leftStyle = new TextStyle({ ...leftBase, tagStyles: paletteTagStyles() });
    this.leftStylePlain = new TextStyle({ ...leftBase });

    this.texts = [];
    this.lefts = [];
    this.stamps = [];
    this.tagged = [];
    this.taggedLeft = [];
    this.rowLayout = [];
    let cy = 0;
    let prevStamp: GameLogEntry['stamp'] | undefined;
    let first = true;
    for (const entry of this.visible) {
      const text = this.r(entry.text);
      const left = this.r(this.leftTextOf(entry));
      this.texts.push(text);
      this.lefts.push(left);
      // 「挂不挂色板」这个决定在这里做一次，建行照抄——见 styleAt 的说明
      this.tagged.push(DialogueLogUI.usesTagStyles(text));
      this.taggedLeft.push(DialogueLogUI.usesTagStyles(left));

      // 日/时段换了就压一条分隔（第一条只要带时刻也压——那是这段时间线的起点）
      const needStamp = !!entry.stamp && (first || !sameStamp(prevStamp, entry.stamp));
      this.stamps.push(needStamp ? this.stampLabelOf(entry) : null);
      prevStamp = entry.stamp;
      first = false;
      const stampH = needStamp ? STAMP_H : 0;

      const i = this.texts.length - 1;
      const textH = CanvasTextMetrics.measureText(
        toPixiTagged(text), this.styleAt(i, this.bodyStyle, this.bodyStylePlain),
      ).height;
      const leftH = left
        ? CanvasTextMetrics.measureText(
            toPixiTagged(left), this.styleAtLeft(i, this.leftStyle, this.leftStylePlain),
          ).height
        : 0;
      const h = Math.max(LINE_HEIGHT, Math.max(textH, leftH) + ROW_PAD_Y * 2);
      this.rowLayout.push({ y: cy, h, stampH });
      cy += h + stampH;
    }
    this.totalH = cy;
  }

  private stampLabelOf(entry: GameLogEntry): string {
    const s = entry.stamp;
    if (!s) return '';
    return s.phase
      ? this.strings.get('dialogueLog', 'stampDayPhase', { day: s.day, phase: s.phase })
      : this.strings.get('dialogueLog', 'stampDay', { day: s.day });
  }

  /** 视口（含上下缓冲）之外的行回收、之内的行补齐；滚动时增量走这里。 */
  private syncRows(offset: number): void {
    const list = this.list;
    if (!list || this.rowsSuspended || this.rowLayout.length === 0) return;
    const viewH = list.viewportHeight;
    const top = offset - ROW_BUFFER;
    const bottom = offset + viewH + ROW_BUFFER;

    let start = this.rowLayout.length;
    let end = 0;
    for (let i = 0; i < this.rowLayout.length; i++) {
      const r = this.rowLayout[i];
      if (r.y + r.h + r.stampH < top) continue;
      if (r.y > bottom) break;
      if (i < start) start = i;
      end = i + 1;
    }

    let changed = false;
    for (const [i, row] of this.rows) {
      if (i < start || i >= end) {
        // 画布纹理还回 Pixi 的文本纹理池；style:true 顺手摘掉本行自己那份 clone 上的监听
        row.destroy({ children: true, style: true });
        this.rows.delete(i);
        this.rowDecor.delete(i);
        changed = true;
      }
    }
    for (let i = start; i < end; i++) {
      if (this.rows.has(i)) continue;
      const row = this.buildRow(i);
      list.content.addChild(row);
      this.rows.set(i, row);
      changed = true;
    }
    // 新建出来的行要立刻套上当前焦点态，否则焦点滚进视口时那一行是暗的。
    // **只在真的增删了行时补**：拖滚每帧都会进这里，而 repaint 要遍历全部焦点项
    // （最多 ~100 条可点行），逐帧空转纯属白烧。
    if (changed) this.focus.repaint();
  }

  private buildRow(i: number): Container {
    const entry = this.visible[i];
    const { y, h, stampH } = this.rowLayout[i];
    const fullW = SPEAKER_W + UITheme.spacing.md + this.bodyColW + LINK_ARROW_W;
    const row = new Container();
    row.y = y;

    if (stampH > 0) this.drawStampBand(row, i, fullW, stampH);

    if (entry.type === 'header') {
      this.drawHeaderRow(row, i, fullW, stampH, h);
      return row;
    }

    const linked = this.isLinked(entry);
    if (linked) this.attachRowInteraction(row, i, fullW, stampH, h);

    const contentY = stampH + ROW_PAD_Y;
    const left = this.lefts[i];
    if (entry.channel === 'dialogue') {
      if (left) {
        // ⚠ 两件事缺一不可：
        // ① **先按串选变体、再 clone**（不是 clone 完两个分支传同一份）——挑错变体时，
        //    带色板那份会让正文里字面写着的 `<…>` 被 Pixi 当真 tag 吞掉，而量高那边挑的是
        //    另一份，量的和画的不是一回事，`rowLayout` 从这一行起整叠错位；
        // ② **必须 clone**：Pixi v8 的 `Text.destroy()` 只把 `_style` 置 null、**不摘**构造时
        //    挂上的 style 'update' 监听——共享一份的话，每回收一行就在这份 style 上留一个
        //    指向已销毁 Text 的死监听。clone 的值相同、styleKey 相同，两级缓存照样命中。
        const s = this.styleAtLeft(i, this.leftStyle, this.leftStylePlain).clone();
        const t = createStyledText({ text: left, style: s });
        // 右对齐到分栏线：名字长短不一时左边参差，右边贴着正文才有"一栏"的样子
        t.x = Math.max(0, SPEAKER_W - t.width);
        t.y = contentY;
        t.eventMode = 'none';
        row.addChild(t);
      }
    } else {
      const icon = createIcon(eventChannelIcon(entry.channel), ICON_SIZE, eventChannelColor(entry.channel));
      if (icon) {
        icon.x = SPEAKER_W - ICON_SIZE;
        icon.y = contentY + 2;
        row.addChild(icon);
      }
    }

    const raw = this.texts[i];
    // 变体照量高时的决定取、再 clone、再改色——顺序不能反（同上）
    const style = this.styleAt(i, this.bodyStyle, this.bodyStylePlain).clone();
    style.fill = entry.channel === 'dialogue'
      ? (entry.type === 'choice' ? UITheme.colors.choiceLog : UITheme.colors.body)
      : eventChannelColor(entry.channel);
    const body: Text = createStyledText({ text: raw, style });
    body.x = SPEAKER_W + UITheme.spacing.md;
    body.y = contentY;
    body.eventMode = 'none';
    row.addChild(body);

    if (linked) {
      const arrow = createStyledText({
        text: CHOICE_MARK,
        style: {
          fontSize: UITheme.fontSize.body,
          fill: UITheme.colors.goldDim,
          fontFamily: UITheme.fonts.ui,
        },
      });
      arrow.eventMode = 'none';
      arrow.x = fullW - LINK_ARROW_W;
      arrow.y = contentY;
      row.addChild(arrow);
    }

    // 行间一条极淡分隔：不是描边，是"翻过去还有"的呼吸
    const sep = createRule(fullW);
    // createRule 的 color/alpha 形参被 `as const` 的默认值锁成字面量类型，传不进别的值，
    // 只能在容器层压 alpha（视觉等价）
    sep.alpha = 0.3;
    sep.y = stampH + h - 1;
    row.addChild(sep);

    return row;
  }

  /** 日/时段分隔带：左端一枚小字 + 右侧一条渐隐横线，与居中的对话抬头刻意不同形 */
  private drawStampBand(row: Container, i: number, fullW: number, stampH: number): void {
    const label = this.stamps[i];
    if (!label) return;
    const t = createStyledText({
      text: label,
      style: {
        fontSize: UITheme.fontSize.small,
        fill: UITheme.colors.goldDim,
        fontFamily: UITheme.fonts.display,
        letterSpacing: UITheme.letterSpacing.title,
      },
    });
    t.eventMode = 'none';
    t.x = 0;
    t.y = Math.round((stampH - t.height) / 2) + 2;
    row.addChild(t);

    const ruleX = t.x + t.width + UITheme.spacing.md;
    const ruleW = fullW - ruleX;
    if (ruleW > 24) {
      const rule = createRule(ruleW);
      rule.x = ruleX;
      rule.y = Math.round(stampH / 2) + 2;
      rule.alpha = 0.45;
      row.addChild(rule);
    }
  }

  /** 对话段落抬头：居中小字 + 两翼渐隐横线（「这里开始是一段对话」） */
  private drawHeaderRow(row: Container, i: number, fullW: number, stampH: number, h: number): void {
    const t = createStyledText({
      text: this.texts[i],
      style: {
        fontSize: UITheme.fontSize.small,
        fill: UITheme.colors.hintMid,
        fontFamily: UITheme.fonts.display,
        letterSpacing: UITheme.letterSpacing.title,
      },
    });
    t.eventMode = 'none';
    const cx = Math.round(fullW / 2);
    t.x = cx - Math.round(t.width / 2);
    t.y = stampH + Math.round((h - t.height) / 2);
    row.addChild(t);

    const gap = UITheme.spacing.md;
    const wingW = Math.max(0, t.x - gap);
    const cy = stampH + Math.round(h / 2);
    if (wingW > 16) {
      const l = createRule(wingW);
      l.x = 0; l.y = cy; l.alpha = 0.4;
      row.addChild(l);
      const rgt = createRule(wingW);
      rgt.x = t.x + t.width + gap; rgt.y = cy; rgt.alpha = 0.4;
      row.addChild(rgt);
    }
  }

  /**
   * 可点行的命中与高亮。
   *
   * **刻意不复用 `UIListRow`**：那件默认画一块行底板（`SKINS.row` 的凹槽 + 描边），
   * 而这里只有一部分行可点——给它们各铺一块板会把整条时间线切成断续的方块。
   * 激活协议照抄它那一套（tap = pointerup 且非拖滚 + 两端 markPointerConsumed），
   * 这是"拖动滚动经过的行不被误选"的唯一正确形状。
   */
  private attachRowInteraction(row: Container, i: number, fullW: number, stampH: number, h: number): void {
    const hover = new Graphics();
    drawHoverRow(hover, 0, stampH, fullW, h - 1);
    hover.alpha = 0;
    hover.eventMode = 'none';
    row.addChild(hover);

    const ring = new Graphics();
    drawFocusRing(ring, 0, stampH, fullW, h - 1);
    ring.alpha = 0;
    ring.eventMode = 'none';
    row.addChild(ring);
    this.rowDecor.set(i, { hover, ring });

    row.eventMode = 'static';
    row.cursor = 'pointer';
    // 普通 Container 无 hitArea 恒不命中（pixi-v8-traps）；命中区避开上方的分隔带
    row.hitArea = new Rectangle(0, stampH, fullW, h);
    const id = this.rowFocusId(i);
    row.on('pointerover', () => this.focus.syncHover(id));
    row.on('pointerout', () => this.focus.clearHover(id));
    row.on('pointerdown', (e: { nativeEvent?: unknown }) => markPointerConsumed(e.nativeEvent));
    row.on('pointerup', (e: { nativeEvent?: unknown }) => {
      markPointerConsumed(e.nativeEvent);
      // 拖滚让路：这一下是玩家在拖列表，不是点这一行
      if (isPointerDragScrolling()) return;
      this.activate(i);
    });
  }

  private rowFocusId(i: number): string {
    return `row:${this.visible[i]?.seq ?? i}`;
  }

  private activate(i: number): void {
    const link = this.visible[i]?.link;
    if (!link || !this.jumpHandler) return;
    this.eventBus.emit('ui:confirm', {});
    this.jumpHandler(link);
  }

  /**
   * 登记焦点项。**给全部可点行登记，不只视口里那几条**——`FocusItem` 只要几何与回调，
   * 不需要显示对象；焦点走到还没构造的行时，`scrollFocusIntoView` 把它滚进来，
   * `syncRows` 顺势建出来再 repaint 上色。虚拟化与焦点导航就这样对上。
   */
  private registerFocusItems(filterItems: FocusItem[], restoreId: string | null): void {
    const rows: FocusItem[] = [];
    for (let i = 0; i < this.visible.length; i++) {
      if (!this.isLinked(this.visible[i])) continue;
      const { y, h, stampH } = this.rowLayout[i];
      const idx = i;
      rows.push({
        id: this.rowFocusId(i),
        x: 0,
        y: y + stampH,
        w: SPEAKER_W + UITheme.spacing.md + this.bodyColW + LINK_ARROW_W,
        h,
        group: DialogueLogUI.GROUP_ROWS,
        onFocus: (on, via) => {
          const decor = this.rowDecor.get(idx);
          if (!decor) return;
          if (decor.ring.destroyed || decor.hover.destroyed) return;
          decor.ring.alpha = on && via === 'key' ? 1 : 0;
          decor.hover.alpha = on && via === 'pointer' ? 0.85 : 0;
        },
        onActivate: () => this.activate(idx),
      });
    }
    // 行排在前：`setItems` 无历史焦点时落到第一项，先排行就不会开在过滤条上
    this.focus.setItems([...rows, ...filterItems]);
    if (restoreId) {
      this.focus.focusDefault(restoreId);
    } else if (rows.length > 0) {
      // **默认焦点不放列表顶端**：面板打开时停在最新一条，焦点跟着落到最后一条可点的行，
      // 与"刚发生的事在最下面"这条阅读顺序对齐（主机 UI 惯例：落在最常用的那一项）。
      this.focus.focusDefault(rows[rows.length - 1].id);
    }
    this.focus.repaint();
  }

  /** 焦点落到视口外的行时把它滚进来。只动 `scrollOffset`，不碰选中态。 */
  private scrollFocusIntoView(): void {
    const list = this.list;
    const cur = this.focus.current;
    if (!list || !cur) return;
    if (cur.y < list.scrollOffset) list.scrollOffset = cur.y;
    else if (cur.y + cur.h > list.scrollOffset + list.viewportHeight) {
      list.scrollOffset = cur.y + cur.h - list.viewportHeight;
    }
  }

  /**
   * 键盘：**焦点优先、滚动兜底**，滚不动时不吞按键（否则会抢走全局快捷键）。
   * 切过滤档没有专用键（Tab 是任务面板的全局快捷键，见 {@link focus} 的说明），
   * 从列表顶端按「上」到过滤条、回车激活。
   */
  private onKey(e: KeyboardEvent): void {
    const list = this.list;
    if (!list) return;
    if (this.focus.handleKey(e.code)) {
      this.scrollFocusIntoView();
      this.focus.repaint();
      e.preventDefault();
      return;
    }
    const before = list.scrollOffset;
    if (!list.handleKey(e.code)) return;
    if (list.scrollOffset !== before) e.preventDefault();
  }

  destroy(): void {
    // 真销毁走瞬时路径（不经 close 的关场淡出）
    this._isOpen = false;
    window.removeEventListener('keydown', this.onKeyBound);
    this.unsubLogChanged?.();
    this.unsubLogChanged = null;
    this.teardown();
    this.data = null;
    this.resolveDisplay = null;
    this.jumpHandler = null;
    this.closeRequester = null;
  }
}
