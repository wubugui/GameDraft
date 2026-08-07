import { CanvasTextMetrics, Container, Text, TextStyle } from 'pixi.js';
import { UITheme } from './UITheme';
import { createRule } from './components/UIDecor';
import { UIWindow, WINDOW_SIZES } from './components/UIWindow';
import { UIScrollView } from './components/UIScrollView';
import type { Renderer } from '../rendering/Renderer';
import type { EventBus } from '../core/EventBus';
import type { StringsProvider } from '../core/StringsProvider';
import type { DialogueLogEntry } from '../data/types';
import type { DialogueLine } from '../data/types';
import { createStyledText } from '../core/styledText';
import { hasStyleMarkup, paletteTagStyles, toPixiTagged } from '../core/textStyle';

const MAX_ENTRIES = 200;
/**
 * 一行日志的最小步进，同时是滚轮/方向键的一格。
 * 原来取 spacing.xl（20）是照小字号定的：body 20 号一行实测就有 ~26px，这个下限从来没生效过，
 * 而滚一格只走半行、快滚时缓冲带（6 格）只够 120px。取 40 = 一条单行日志的实际行高，
 * 「一格 = 一条」才对得上手感，缓冲带也跟着回到 6 条的量。
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
 * 每条日志的上下内边距。原来只在**下方**加了一档（`h = 文字高 + sm`），文字紧贴上一条的
 * 分隔线、下面却空着 8px，整叠行读起来是往下掉的。上下各给一档，行与行之间才是均等呼吸。
 */
const ROW_PAD_Y = UITheme.spacing.sm;
/**
 * 说话人列宽。设计稿的列表语汇是「左边一列身份、右边一栏正文」，
 * 把名字和台词混在一行里（旧的 `名: 台词`）读起来是一堵墙。
 */
const SPEAKER_W = 108;
/** 玩家选项在说话人列的记号（选项没有说话人，但列不能空着——空列会让整叠行失去左边界） */
const CHOICE_MARK = '›';


export class DialogueLogUI {
  private renderer: Renderer;
  private closeRequester: (() => void) | null = null;
  private eventBus: EventBus;
  private strings: StringsProvider;
  private win: UIWindow | null = null;
  private list: UIScrollView | null = null;
  private _isOpen = false;
  private entries: DialogueLogEntry[] = [];

  /** 每条日志的纵向占位（只量不建，见 measureLayout）；索引与 entries 一一对应 */
  private rowLayout: { y: number; h: number }[] = [];
  private totalH = 0;
  /** 当前**真正构造出来**的行：索引 → 行容器。虚拟化后同时存在的只有视口附近十几条 */
  private rows = new Map<number, Container>();
  /** 三种行样式各一份，**只用于量高**；真正建行时 clone（见 syncRows 里的说明） */
  private lineStyle: TextStyle | null = null;
  private choiceStyle: TextStyle | null = null;
  private speakerStyle: TextStyle | null = null;
  private lineStylePlain: TextStyle | null = null;
  private choiceStylePlain: TextStyle | null = null;
  private speakerStylePlain: TextStyle | null = null;
  /** 正文列宽（量高与建行同一口径），build 时按窗体宽算定 */
  private bodyColW = 0;
  /** build 中途暂停补行：先定位到底部再一次性补，省掉"先补顶部再全扔"的空转 */
  private rowsSuspended = false;

  private lineCb: (line: DialogueLine) => void;
  private choiceCb: (payload: { index: number; text?: string }) => void;
  private onKeyBound: (e: KeyboardEvent) => void;

  constructor(renderer: Renderer, eventBus: EventBus, strings: StringsProvider) {
    this.renderer = renderer;
    this.eventBus = eventBus;
    this.strings = strings;

    this.lineCb = (line) => {
      this.addEntry({ type: 'line', speaker: line.speaker, text: line.text });
    };
    this.choiceCb = (payload) => {
      if (payload.text) {
        this.addEntry({ type: 'choice', text: payload.text });
      }
    };
    this.onKeyBound = (e) => this.onKey(e);

    this.eventBus.on('dialogue:line', this.lineCb);
    this.eventBus.on('dialogue:choiceSelected:log', this.choiceCb);
  }

  get isOpen(): boolean {
    return this._isOpen;
  }

  private addEntry(entry: DialogueLogEntry): void {
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.shift();
    }
  }

  open(): void {
    if (this._isOpen) return;
    this._isOpen = true;
    this.build();
    window.addEventListener('keydown', this.onKeyBound);
  }

  close(): void {
    if (!this._isOpen) return;
    this._isOpen = false;
    window.removeEventListener('keydown', this.onKeyBound);
    this.teardown();
  }

  private teardown(): void {
    // list.destroy() 会连带销毁 content 下的行 Text（纹理归还 Pixi 文本纹理池）
    this.rows.clear();
    this.rowLayout = [];
    this.totalH = 0;
    this.list?.destroy();
    this.win?.destroy();
    this.list = null;
    this.win = null;
    this.lineStyle?.destroy();
    this.choiceStyle?.destroy();
    this.speakerStyle?.destroy();
    this.lineStyle = null;
    this.choiceStyle = null;
    this.speakerStyle = null;
  }

  /**
   * ✕ / 关闭提示的点击**不能直接 close()**：面板关闭必须经 GameStateController 的统一通道，
   * 否则 GameState 滞留 UIOverlay、overlayReturnStack 不平衡（R11/D3 软锁根因）。
   * 本面板与控制器之间没有接线（构造签名不改），故补发一次与玩家按关闭键完全相同的
   * 键盘事件，由控制器 togglePanel 关面板 + 弹栈。
   *
   * 用**本面板快捷键**而不是 Esc：Esc 分支只在 `currentState === UIOverlay` 时找覆盖层面板，
   * 面板开着期间被别的子系统改写过状态（如过场把状态置为 Cutscene）就会点了没反应；
   * 快捷键分支只看 `panel.isOpen`，与关闭提示文案承诺的行为逐字一致。
   */
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
  private windowSize(): { width: number; height: number } {
    const margin = UITheme.spacing.xl * 2;
    return {
      width: Math.min(WINDOW_SIZES.lg.width, this.renderer.screenWidth - margin),
      height: Math.min(WINDOW_SIZES.lg.height, this.renderer.screenHeight - margin),
    };
  }

  private build(): void {
    this.teardown();

    const count = this.entries.length;
    const win = new UIWindow(this.renderer, {
      size: this.windowSize(),
      title: this.strings.get('dialogueLog', 'title'),
      // 滚动条只表达"位置/比例"，表达不了"一共几条"——旧实现右下角的 `1-20 / 200`
      // 里那半条信息在这里补回来（文案走 strings.json，不在代码里硬写）。
      subtitle: count > 0 ? this.strings.get('dialogueLog', 'total', { count }) : undefined,
      closeHint: this.strings.get('dialogueLog', 'closeHint'),
      onClose: () => this.requestClose(),
    });
    this.win = win;

    const list = new UIScrollView(this.renderer, {
      width: win.bodyWidth,
      height: win.bodyHeight,
      step: LINE_HEIGHT,
      bottomPadding: BOTTOM_PAD,
      onScroll: (offset) => this.syncRows(offset),
    });
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
      // 打开时停在最新一条（旧实现是把首行索引推到末页，这里等价于滚到底）
      list.scrollOffset = Number.MAX_SAFE_INTEGER;
      this.rowsSuspended = false;
      this.syncRows(list.scrollOffset);
    }

    win.open();
  }

  private fillEmpty(bodyWidth: number): void {
    const list = this.list;
    if (!list) return;
    const empty = createStyledText({
      text: this.strings.get('dialogueLog', 'empty'),
      style: {
        // 空态是这块 850×630 面板上**唯一**一行字，不是角落里的说明：
        // small 在这么大一片空里读起来像没加载完，抬到与正文同档（颜色仍压成 hint 灰）
        fontSize: UITheme.fontSize.body, fill: UITheme.colors.hint,
        fontFamily: UITheme.fonts.ui, wordWrap: true, breakWords: true,
        wordWrapWidth: bodyWidth - UITheme.spacing.md,
      },
    });
    empty.x = UITheme.spacing.sm;
    empty.y = ROW_PAD_Y;
    list.content.addChild(empty);
  }

  /** 左列：说话人（旁白留空、玩家选项一个记号） */
  private speakerText(entry: DialogueLogEntry): string {
    if (entry.type === 'choice') return CHOICE_MARK;
    return entry.speaker ?? '';
  }

  /** 右列：台词本身。分栏之后不再往正文里塞「名: 」前缀 */
  private rowText(entry: DialogueLogEntry): string {
    return entry.text;
  }

  /**
   * 排版：**只量不建**。
   *
   * 迁移后这里是一次性 `createStyledText()` 全部 200 条——200 个显示对象 + 200 张各自的
   * 画布纹理上传，而 mask 是模板裁切**不做剔除**，屏幕外的一百八十条照样提交 draw call。
   * 改成先用 `CanvasTextMetrics` 量出每条占位（Text.updateBounds 内部走的就是它，
   * 同一 text+style 还会命中 Pixi 的全局 measurement cache，随后真建那十几条不二次测量），
   * 只有 syncRows 圈进视口的条目才真的构造。
   */
  /** 量高用哪份样式：与渲染端 needsTagStyles 完全同口径（挂错就会量歪）。 */
  private measureStyle(tagged: TextStyle, raw: string): TextStyle {
    if (hasStyleMarkup(raw) && !raw.includes('<')) return tagged;
    if (tagged === this.speakerStyle) return this.speakerStylePlain ?? tagged;
    if (tagged === this.choiceStyle) return this.choiceStylePlain ?? tagged;
    return this.lineStylePlain ?? tagged;
  }

  private measureLayout(bodyWidth: number): void {
    this.bodyColW = Math.max(1, bodyWidth - SPEAKER_W - UITheme.spacing.md - UITheme.spacing.sm);
    /**
     * ⚠ 量高用的样式必须带 `tagStyles`、量的串必须是 `toPixiTagged` 之后的形态——
     * 否则 `[c:danger]`/`[/c]` 这些字符会被当可见字一起量（实测同一句量 65 字、实渲 39 字），
     * 窄栏下多折一行，`rowLayout[i].y` 是累加的，后面每一行跟着错位、滚到底还留空白。
     */
    const base = {
      fontSize: UITheme.fontSize.body,
      fontFamily: UITheme.fonts.ui,
      wordWrap: true, breakWords: true,
      wordWrapWidth: this.bodyColW,
      tagStyles: paletteTagStyles(),
    };
    this.lineStyle = new TextStyle({ ...base, fill: UITheme.colors.body });
    this.choiceStyle = new TextStyle({ ...base, fill: UITheme.colors.choiceLog });
    // 说话人：琥珀 + 报隶，与对话框上沿那块名牌同一副嗓子
    this.speakerStyle = new TextStyle({
      fontSize: UITheme.fontSize.body,
      fontFamily: UITheme.fonts.display,
      fill: UITheme.colors.title,
      wordWrap: true, breakWords: true,
      wordWrapWidth: SPEAKER_W,
      tagStyles: paletteTagStyles(),
    });

    // 无标记版：与 createStyledText 的 needsTagStyles 同口径——正文里字面写着 `<dim>`
    // 的行渲染时**不挂**色板，量高也必须不挂，否则量出来少一截、后面每行跟着错位。
    this.lineStylePlain = new TextStyle({ ...base, tagStyles: undefined, fill: UITheme.colors.body });
    this.choiceStylePlain = new TextStyle({ ...base, tagStyles: undefined, fill: UITheme.colors.choiceLog });
    this.speakerStylePlain = new TextStyle({
      fontSize: UITheme.fontSize.body,
      fontFamily: UITheme.fonts.display,
      fill: UITheme.colors.title,
      wordWrap: true, breakWords: true,
      wordWrapWidth: SPEAKER_W,
    });

    this.rowLayout = [];
    let cy = 0;
    for (const entry of this.entries) {
      const style = entry.type === 'choice' ? this.choiceStyle : this.lineStyle;
      const measured = CanvasTextMetrics.measureText(
        toPixiTagged(this.rowText(entry)), this.measureStyle(style, this.rowText(entry))).height;
      const speaker = this.speakerText(entry);
      const speakerH = speaker
        ? CanvasTextMetrics.measureText(
            toPixiTagged(speaker), this.measureStyle(this.speakerStyle, speaker)).height
        : 0;
      const h = Math.max(LINE_HEIGHT, Math.max(measured, speakerH) + ROW_PAD_Y * 2);
      this.rowLayout.push({ y: cy, h });
      cy += h;
    }
    this.totalH = cy;
  }

  /** 视口（含上下缓冲）之外的行回收、之内的行补齐；滚动时增量走这里。 */
  private syncRows(offset: number): void {
    const list = this.list;
    const lineStyle = this.lineStyle;
    const choiceStyle = this.choiceStyle;
    const speakerStyle = this.speakerStyle;
    if (!list || !lineStyle || !choiceStyle || !speakerStyle) return;
    if (this.rowsSuspended || this.rowLayout.length === 0) return;
    const viewH = list.viewportHeight;
    const top = offset - ROW_BUFFER;
    const bottom = offset + viewH + ROW_BUFFER;

    let start = this.rowLayout.length;
    let end = 0;
    for (let i = 0; i < this.rowLayout.length; i++) {
      const r = this.rowLayout[i];
      if (r.y + r.h < top) continue;
      if (r.y > bottom) break;
      if (i < start) start = i;
      end = i + 1;
    }

    for (const [i, row] of this.rows) {
      if (i < start || i >= end) {
        // 画布纹理还回 Pixi 的文本纹理池（复用不重新分配）；style:true 顺手摘掉本行自己那份
        // 克隆样式上的监听（不碰纹理——TextStyle.destroy 只在 options.texture 时才动纹理）
        row.destroy({ children: true, style: true });
        this.rows.delete(i);
      }
    }
    for (let i = start; i < end; i++) {
      if (this.rows.has(i)) continue;
      const entry = this.entries[i];
      const { y, h } = this.rowLayout[i];
      const row = new Container();
      row.y = y;

      const speaker = this.speakerText(entry);
      if (speaker) {
        // ⚠ 必须 clone，不能把量高用的那份 TextStyle 直接共享给行：Pixi v8 的
        // `Text.destroy()` 只把 `_style` 置 null，**不摘**构造时挂上的 style 'update' 监听——
        // 共享一份的话，每回收一行就在这份 style 上留一个指向已销毁 Text 的死监听。
        // clone 出来的样式值相同，styleKey 也相同，量高缓存与文本纹理缓存照样命中。
        const s = createStyledText({ text: speaker, style: speakerStyle.clone() });
        // 右对齐到分栏线：名字长短不一时左边参差，右边贴着正文才有"一栏"的样子
        s.x = Math.max(0, SPEAKER_W - s.width);
        s.y = ROW_PAD_Y;
        row.addChild(s);
      }

      const t = createStyledText({
        text: this.rowText(entry),
        style: (entry.type === 'choice' ? choiceStyle : lineStyle).clone(),
      });
      t.x = SPEAKER_W + UITheme.spacing.md;
      t.y = ROW_PAD_Y;
      row.addChild(t);

      // 行间一条极淡分隔：不是描边，是"翻过去还有"的呼吸
      const sep = createRule(SPEAKER_W + UITheme.spacing.md + this.bodyColW);
      // 压到"极淡"：createRule 的 color/alpha 形参被 `as const` 的默认值锁成字面量类型，
      // 传不进别的值，只能在容器层压 alpha（视觉等价）。
      sep.alpha = 0.3;
      sep.y = h - 1;
      row.addChild(sep);

      list.content.addChild(row);
      this.rows.set(i, row);
    }
  }

  /**
   * 方向键交给滚动区；**滚不动时不吞按键**，否则会抢走全局快捷键。
   *
   * 键盘/手柄导航（`UIFocus`）在这里**刻意没有接**：本面板自己一个可交互元素都没有——
   * 日志行是纯文本（无选中态、无激活语义），唯一的两个出口 ✕ 与底部键帽由 `UIWindow`
   * 造在它的 `overlay` 私有层里，没有对外暴露成可登记的焦点项。等窗体那层把它们
   * 暴露出来（或改成自己吃焦点），这里再按「focus 优先、滚动兜底」的顺序插到
   * `list.handleKey` 之前即可；在那之前塞一个恒空的 UIFocus 只是死代码。
   * 键盘玩家当前仍能全程操作：↑↓/PageUp/PageDown 滚动、L 或 Esc 关闭（走状态机通道）。
   */
  private onKey(e: KeyboardEvent): void {
    const list = this.list;
    if (!list) return;
    const before = list.scrollOffset;
    if (!list.handleKey(e.code)) return;
    if (list.scrollOffset !== before) e.preventDefault();
  }

  serialize(): object {
    return { entries: this.entries };
  }

  deserialize(data: { entries?: DialogueLogEntry[] }): void {
    this.entries = data.entries ?? [];
  }

  destroy(): void {
    this.close();
    this.eventBus.off('dialogue:line', this.lineCb);
    this.eventBus.off('dialogue:choiceSelected:log', this.choiceCb);
  }
}
