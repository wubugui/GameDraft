import { Container, Graphics, Text } from 'pixi.js';
import { UITheme } from './UITheme';
import { createPanel, SKINS } from './PanelSkin';
import { createRule, drawSelectedRow } from './components/UIDecor';
import { markPointerConsumed } from './uiPointerCoords';
import { UIScrollView } from './components/UIScrollView';
import { UIFocus, type FocusItem } from './components/UIFocus';
import type { Renderer } from '../rendering/Renderer';
import type { StringsProvider } from '../core/StringsProvider';
import { createStyledText } from '../core/styledText';

export interface ActionChoiceOption {
  text: string;
}

/**
 * 动作选择条：贴屏幕下沿的一条选项条，不是弹窗。
 *
 * **刻意不走 UIWindow**（三处对不上，硬塞会改变玩法语义）：
 * 1. 它贴下沿、与对白框同一带位置，UIWindow 恒居中；
 * 2. 它**不铺遮罩**——选择期间场景仍要看得见（旧实现也没有 overlay）；
 * 3. UIWindow 的 ✕ 是固有件，而 `allowCancel:false` 时本条**不允许取消**
 *    （chooseAction 拿到 null 就一条动作都不执行），多一个 ✕ 等于给必选项开了后门。
 * 列表改走 {@link UIScrollView}：选项多到超屏时旧实现会把整条推到屏幕上方之外（点不到）。
 */

const BOX_MAX_W = 720;
/**
 * 一行的步进（行体 = ROW_H - ROW_GAP）；行体要装得下木条 5px×2 + 一行字。
 * 原来 52 是配小字号定的：行体 44 装 bodyLarge（实测字高 ~31）只剩 6.5px/边，
 * 扣掉 5px 木条 → 字几乎贴在木条上。64 → 行体 56，每边净空 7px 在木条内侧。
 */
const ROW_H = 64;
const ROW_GAP = UITheme.spacing.sm;
/** 有提示语时给标题行留的高度（下限；长提示按实测撑高） */
const PROMPT_H = 44;
/** 「Esc 取消」那行的高度（装 small 一行字 + 一档呼吸） */
const HINT_H = 28;
/** 选项按钮的木条厚度（= SKINS.nameplate 的 wood）：选中琥珀铺光按此内缩，正好落在木框里侧 */
const ROW_FRAME = 5;
/** 序号列与正文之间的最小净空（正文按「列宽 + 这一档」左右对称收边） */
const PREFIX_GAP = UITheme.spacing.md;

export class ActionChoiceUI {
  private renderer: Renderer;
  private strings: StringsProvider;
  private container: Container | null = null;
  private list: UIScrollView | null = null;
  private resolveChoice: ((index: number | null) => void) | null = null;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;
  /** 键盘/手柄焦点（与鼠标共用同一个"当前项"）；随本条一同装卸 */
  private focus: UIFocus | null = null;

  constructor(renderer: Renderer, strings: StringsProvider) {
    this.renderer = renderer;
    this.strings = strings;
  }

  choose(prompt: string, options: ActionChoiceOption[], allowCancel: boolean): Promise<number | null> {
    this.close(null);
    const cleanOptions = options
      .map((o) => ({ text: String(o.text ?? '').trim() }))
      .filter((o) => o.text.length > 0);
    if (cleanOptions.length === 0) return Promise.resolve(null);

    return new Promise((resolve) => {
      this.resolveChoice = resolve;
      this.container = new Container();
      this.renderer.uiLayer.addChild(this.container);

      const margin = UITheme.spacing.xl;
      // 内边距要越过 15px 的木条才不会让内容压在框料上
      const pad = UITheme.spacing.xxl;
      const sw = this.renderer.screenWidth;
      const sh = this.renderer.screenHeight;

      const boxWidth = Math.min(sw - margin * 2, BOX_MAX_W);
      const x = (sw - boxWidth) / 2;
      const promptText = String(prompt ?? '').trim();
      // 先把提示语量出来再排版：写死一行高的话，长提示会压到第一行选项上
      const title = promptText
        ? createStyledText({
          text: promptText,
          style: {
            fontSize: UITheme.fontSize.title,
            fill: UITheme.colors.title,
            fontFamily: UITheme.fonts.display,
            fontWeight: 'bold',
            // 设计稿里中文标题一律拉字距；居中 + 下方一条渐隐横线
            letterSpacing: UITheme.letterSpacing.title,
            align: 'center',
            wordWrap: true,
            breakWords: true,
            wordWrapWidth: boxWidth - pad * 2,
          },
        })
        : null;
      const promptHeight = title ? Math.max(PROMPT_H, Math.ceil(title.height) + pad) : 0;
      const hintHeight = allowCancel ? HINT_H : 0;
      // 选项再多也不越过屏幕上沿——超出部分交给滚动
      const maxListH = Math.max(ROW_H, sh - margin * 2 - promptHeight - hintHeight - pad * 2);
      const listH = Math.min(cleanOptions.length * ROW_H, maxListH);
      const boxHeight = promptHeight + listH + hintHeight + pad * 2;
      const y = sh - boxHeight - margin;

      // 纸纹底 + 做旧木框 + 内金线：面板级一律走 createPanel（drawPanelBase 画不出木框）
      this.container.addChild(createPanel(x, y, boxWidth, boxHeight, SKINS.panel));

      if (title) {
        title.x = x + Math.round((boxWidth - title.width) / 2);
        title.y = y + pad;
        this.container.addChild(title);
        const rule = createRule(boxWidth - pad * 2);
        rule.position.set(x + pad, y + pad + Math.ceil(title.height) + UITheme.spacing.sm);
        this.container.addChild(rule);
      }

      const listX = x + pad;
      const listY = y + pad + promptHeight;
      const rowW = boxWidth - pad * 2;
      const list = new UIScrollView(this.renderer, {
        width: rowW,
        height: listH,
        // 只吃落在本条上的滚轮，别把整屏滚轮都吞了（这条不铺遮罩，屏幕其余部分仍是场景）
        hitTest: (hx, hy) => hx >= x && hx <= x + boxWidth && hy >= y && hy <= y + boxHeight,
      });
      list.container.position.set(listX, listY);
      this.container.addChild(list.container);
      this.list = list;

      const rowBodyH = ROW_H - ROW_GAP;
      /**
       * 序号是**键位提示**（玩家按 1/2/3 选），不是选项内容：拆成独立一小列走 small，
       * 别再和 bodyLarge 的正文拼进同一个 Text 一起放大。列宽取最宽者，各行对齐同一列；
       * 正文两侧按同宽对称收边，居中之后也压不到序号上。
       */
      const prefixTexts = cleanOptions.map((_opt, idx) => createStyledText({
        text: `${idx + 1}.`,
        style: {
          fontSize: UITheme.fontSize.small,
          // subtle 而非 hintMid：序号压在点亮的琥珀行底上，hintMid 那一档灰在这块底上读不出来
          fill: UITheme.colors.descText,
          fontFamily: UITheme.fonts.ui,
        },
      }));
      const prefixCol = Math.ceil(Math.max(0, ...prefixTexts.map((t) => t.width)));
      const labelWrapW = Math.max(80, rowW - (UITheme.spacing.xl + prefixCol + PREFIX_GAP) * 2);
      const focusItems: FocusItem[] = [];
      cleanOptions.forEach((opt, idx) => {
        const ry = idx * ROW_H;

        // 近方正的木边按钮（设计稿 2.「选择按钮」）：暗底 + 做旧木条 + 内金线
        list.content.addChild(createPanel(0, ry, rowW, rowBodyH, SKINS.nameplate, {
          fill: UITheme.colors.rowBg,
        }));

        // 悬停 = 点亮一档琥珀 + 金描边（不是换个深色），按木条厚度内缩落在框里侧
        const hoverBg = new Graphics();
        drawSelectedRow(hoverBg, ROW_FRAME, ry + ROW_FRAME, rowW - ROW_FRAME * 2, rowBodyH - ROW_FRAME * 2);
        hoverBg.visible = false;
        hoverBg.eventMode = 'none';
        list.content.addChild(hoverBg);

        const label = createStyledText({
          text: opt.text,
          style: {
            fontSize: UITheme.fontSize.bodyLarge,
            fill: UITheme.colors.choiceEnabled,
            fontFamily: UITheme.fonts.ui,
            align: 'center',
            wordWrap: true,
            breakWords: true,
            wordWrapWidth: labelWrapW,
          },
        });
        label.x = Math.round((rowW - label.width) / 2);
        label.y = ry + Math.round((rowBodyH - label.height) / 2);
        list.content.addChild(label);

        const prefix = prefixTexts[idx];
        prefix.x = UITheme.spacing.xl;
        prefix.y = ry + Math.round((rowBodyH - prefix.height) / 2);
        list.content.addChild(prefix);

        /**
         * 高亮**只有这一处画法**：木框留着不动，只把内里点亮成琥珀、文字转金。
         * 鼠标悬停与键盘焦点共用它——焦点框不另发明一种，否则同一条上会出现两套选中语汇。
         */
        const setHighlight = (on: boolean): void => {
          hoverBg.visible = on;
          label.style.fill = on ? UITheme.colors.title : UITheme.colors.choiceEnabled;
          prefix.style.fill = on ? UITheme.colors.title : UITheme.colors.descText;
        };

        // 整行命中：命中区自己是一块 Graphics，压在按钮面板之上整条接管，
        // 不靠 Text 本身（Pixi 逐子元素命中，只给 Text 会让行内空白成死区）
        const hit = new Graphics();
        hit.rect(0, ry, rowW, rowBodyH);
        hit.fill({ color: 0xffffff, alpha: UITheme.alpha.hitArea });
        hit.eventMode = 'static';
        hit.cursor = 'pointer';
        // 悬停即移焦（不直接画高亮）：鼠标和手柄共用同一个"当前项"，指针挪开后
        // 焦点仍留在这一条上，接着按方向键是从这里继续走，而不是跳回原处。
        hit.on('pointerover', () => { this.focus?.syncHover(`opt-${idx}`); });
        hit.on('pointerout', () => { this.focus?.clearHover(`opt-${idx}`); });
        hit.on('pointerdown', (e) => {
          // 不标记已消费的话，同一个原生事件还会被 DialogueUI/EncounterUI 挂在 window 上的
          // 推进监听再吃一次（选完选项顺手把下一段对白跳满）
          markPointerConsumed((e as { nativeEvent?: unknown }).nativeEvent);
          this.close(idx);
        });
        list.content.addChild(hit);

        focusItems.push({
          id: `opt-${idx}`,
          x: 0, y: ry, w: rowW, h: rowBodyH,
          group: 'options',
          onFocus: setHighlight,
          onActivate: () => this.close(idx),
        });
      });
      list.refresh();

      // 默认焦点 = 第一项（本条的选项全都可选，没有禁用态）；setItems 已把它点亮
      const focus = new UIFocus();
      focus.setItems(focusItems);
      this.focus = focus;

      if (allowCancel) {
        const hint = createStyledText({
          text: this.strings.get('actionChoice', 'cancelHint'),
          style: {
            // 键位提示走 small：micro 是角标/计数档，一句「Esc 取消」在 720 宽的条上会缩成灰渣
            fontSize: UITheme.fontSize.small,
            fill: UITheme.colors.hintMid,
            fontFamily: UITheme.fonts.ui,
          },
        });
        hint.x = x + boxWidth - pad - hint.width;
        // 贴在列表下方**自己那一格**里，而不是按框底倒推——倒推会把它顶到 15px 木条上
        hint.y = listY + listH + Math.round((HINT_H - hint.height) / 2);
        this.container.addChild(hint);
      }

      /**
       * 被本条吃掉的**导航/激活键**必须就地截断，不能再往下漏。
       *
       * 这是三行开外那个 `markPointerConsumed` 的键盘孪生：`DialogueUI` 在 window 上挂着
       * 推进监听，对白框还在屏上时按回车会**一键双吃**——既选中本条的动作，又把底下那句
       * 台词推过去。指针侧早就用「标记已消费」堵掉了同一个洞，键盘侧没有对应设施
       * （见报告里的地基缺口），所以这里退回 DOM 自己的截断：监听登记在**捕获阶段**，
       * 真实按键（target 是 body/canvas）会先经过 window 捕获，早于任何 window 冒泡监听。
       *
       * ⚠ 只截断本轮新加的那几个键（方向/WASD/回车/空格/翻页）。Esc 与数字直选**照旧放行**，
       * 它们的既有传播关系不在这次改动的范围里。
       */
      this.keyHandler = (e: KeyboardEvent) => {
        if (allowCancel && e.code === 'Escape') {
          e.preventDefault();
          this.close(null);
          return;
        }
        // 方向键先给焦点：**焦点优先、滚动兜底**（PageUp/PageDown 这类焦点不认的键才落到滚动区）。
        // 焦点挪出视口时把它滚进来，否则长清单里按方向键会"高亮跑到看不见的地方"。
        if (this.focus?.handleKey(e.code)) {
          e.preventDefault();
          e.stopImmediatePropagation();
          this.scrollFocusIntoView();
          return;
        }
        // 选项超屏时翻页键滚列表（不与数字键、Esc 冲突）
        if (this.list?.handleKey(e.code)) {
          e.preventDefault();
          e.stopImmediatePropagation();
          return;
        }
        if (e.code.startsWith('Digit') || e.code.startsWith('Numpad')) {
          const raw = e.code.startsWith('Digit')
            ? e.code.slice('Digit'.length)
            : e.code.slice('Numpad'.length);
          const n = Number(raw);
          if (Number.isInteger(n) && n >= 1 && n <= cleanOptions.length) {
            e.preventDefault();
            this.close(n - 1);
          }
        }
      };
      window.addEventListener('keydown', this.keyHandler, true);
    });
  }

  /** 焦点落在视口外的那一行时把它滚进来（列表本身没有"跟随选中"的概念，得由这里推）。 */
  private scrollFocusIntoView(): void {
    const cur = this.focus?.current;
    const list = this.list;
    if (!cur || !list) return;
    const view = list.viewportHeight;
    const offset = list.scrollOffset;
    if (cur.y < offset) list.scrollOffset = cur.y;
    else if (cur.y + cur.h > offset + view) list.scrollOffset = cur.y + cur.h - view;
  }

  close(result: number | null = null): void {
    if (this.keyHandler) {
      // ⚠ 摘监听必须带上与登记时相同的 capture 标志，否则摘不掉、每开一次条就积一个死监听
      window.removeEventListener('keydown', this.keyHandler, true);
      this.keyHandler = null;
    }
    // 先断焦点：它的 onFocus 回调抓着下面就要销毁的显示对象
    this.focus?.destroy();
    this.focus = null;
    // 先拆滚动区：它自己在 window 上挂了 wheel 监听，只销毁父容器会留残留
    this.list?.destroy();
    this.list = null;
    if (this.container) {
      if (this.container.parent) this.container.parent.removeChild(this.container);
      this.container.destroy({ children: true });
      this.container = null;
    }
    const resolve = this.resolveChoice;
    this.resolveChoice = null;
    resolve?.(result);
  }

  destroy(): void {
    this.close(null);
  }
}
