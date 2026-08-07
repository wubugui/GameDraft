import { Container, Text } from 'pixi.js';
import { UITheme } from './UITheme';
import { createPanel, SKINS } from './PanelSkin';
import { createRule } from './components/UIDecor';
import { isPointerConsumed } from './uiPointerCoords';
import { UIScrollView } from './components/UIScrollView';
import type { Renderer } from '../rendering/Renderer';
import type { StringsProvider } from '../core/StringsProvider';
import { createStyledText } from '../core/styledText';

/**
 * 检视框：贴屏幕下沿、高度随正文伸缩的一块「看一眼」正文框，点任意处 / 按任意键即关。
 *
 * **刻意不走 UIWindow**（三处对不上，硬塞会改掉它的形态语义）：
 * 1. 它的高度是**随正文长短伸缩**的（下限 {@link MIN_BOX_H}、上限满屏）并贴下沿，
 *    而 UIWindow 是四档固定尺寸、恒居中的窗体；
 * 2. 它**不铺遮罩**——检视的对象就在场上，盖住场景等于把"看一眼"变成"读一份文书"
 *    （旧实现也没有 overlay，档案 / 书这类才该是窗）；
 * 3. 关闭通道是"点任意处 / 按任意键"，标题栏与 ✕ 都是多余件；UIWindow 的 ✕ 与关闭提示
 *    自带 pointerdown，还会跟本框挂在 window 上的"任意点击即关"监听抢同一次事件。
 * 本框未注册进 `GameStateController`（由 `InteractionCoordinator` / `EventBridge` await
 * 它的 Promise 驱动），因此不需要 `setCloseRequester` 那套弹栈通道。
 *
 * 迁进组件层的部分：正文改走 {@link UIScrollView}。旧实现拿一块 mask 把超出盒高的正文
 * 直接裁掉——长描述的后半段既读不到、也没有任何"还有更多"的信号；尺寸 / 字号一律取
 * {@link UITheme} 令牌。
 *
 * **键盘/手柄导航（`UIFocus`）刻意没接**（与 `DialogueLogUI` 同一判断）：本框**一个可登记的
 * 焦点项都没有**——正文是纯文本、底部只有一行关闭提示，没有 ✕、没有按钮、没有可选中的行；
 * 整框唯一带 pointer 监听的件是 `UIScrollView` 自己的滚动条（轨道 + 滑块），而它早就有键盘
 * 通道（↑↓ / PageUp / PageDown 走 `view.handleKey`）。塞一个恒空的 UIFocus 只是死代码。
 * 键盘玩家当前已能全程操作：正文溢出时 ↑↓/翻页滚动、其余任意键关闭；不溢出时**任意键**
 * （含方向键）直接关。哪天这框长出按钮/可选行，再按「focus 优先、滚动兜底」插到
 * `view.handleKey` 之前即可。
 */

/** 盒宽上限（正文再宽也不横跨整个大屏，行长会失控） */
const MAX_BOX_W = 600;
/** 盒子与屏幕上下沿的留白 */
const V_MARGIN = UITheme.spacing.xxl;
/** 盒子与屏幕左右沿的留白 */
const H_MARGIN = UITheme.spacing.xl;
/** 盒内左右内边距：必须大于木条边宽（15px），否则正文压在木纹上 */
const PAD = UITheme.spacing.xxl;
/**
 * 正文顶部内边距：要让开上沿木条（15）+ 内侧金细线（inset 10）。
 * 视觉上的净空还要加上 {@link BODY_LINE_H} 的半档行距（首行在自己的行框里居中），
 * 24 + 6 ≈ 左右的 {@link PAD}，四边看着才是一圈匀的。
 */
const TEXT_TOP = UITheme.spacing.xl + UITheme.spacing.xs;
/**
 * 底部「点击或按任意键关闭」提示带高度。
 * 里面按顺序排：正文底 → 8px → 渐隐横线 → 8px → 提示文字（16 高）→ 20px 到盒底
 * （盒底还有 15px 的木条，20 的净空正好在木条里侧留 5px）。改高度记得连这四段一起算。
 */
const HINT_BAND = UITheme.spacing.xxl + UITheme.spacing.xl;
/**
 * 正文行高：中文长段落要约 1.6 倍字号才读得动，而 Pixi 默认「行高 = 字号」——
 * 旧实现三行正文行与行几乎贴住，是这块框最扎眼的一处。
 *
 * ⚠ 必须用 `lineHeight` 调，**不能用 `leading`**：Pixi v8 量高是
 * `字高 + (行数-1)×(行高+leading)`，绘制却把每行在 `行高+leading` 的行框里居中
 * （`CanvasTextGenerator` 的 linePositionYShift），于是末行会比量出来的高度多探出
 * 半个 leading——文字贴图当场被裁掉半行，`scrollable` 也判成 false（滚都滚不出来）。
 * 走 `lineHeight` 时 leading=0，量高与绘制对得上。
 */
const BODY_LINE_H = Math.round(UITheme.fontSize.body * 1.6);
/**
 * 盒高下限 = 顶部内边距 + 一整行正文 + 底部提示带，**正好装下一行**。
 * 原来写死 120，比一行所需高出十几像素——「一口空棺。」这种短句下面就空出一条死带。
 * 盒高本来就随正文伸缩，下限只要保证不缩成一条即可，多出来的空白没有意义。
 */
const MIN_BOX_H = TEXT_TOP + BODY_LINE_H + HINT_BAND;
/** 给滚动条留出的右侧宽度（正文换行宽度要让出这一截，否则字压在条下面） */
const SCROLL_GUTTER = UITheme.spacing.md;
/**
 * 挂上"任意键 / 任意点击即关"监听前的延迟：吃掉"打开这一下"的余波，
 * 否则触发检视的那次点击/按键会立刻把框关掉。
 */
const ARM_DELAY = 100;

export class InspectBox {
  private renderer: Renderer;
  private strings: StringsProvider;
  private resolveDisplay: ((s: string) => string) | null = null;
  private container: Container | null = null;
  private view: UIScrollView | null = null;
  /** 正文是否溢出视口：只有溢出时方向键才归滚动，否则仍是"任意键关闭" */
  private scrollable = false;
  private resolveClose: (() => void) | null = null;
  private onKeyHandler: ((e: KeyboardEvent) => void) | null = null;
  private onClickHandler: ((e: PointerEvent) => void) | null = null;
  private showTimerId: ReturnType<typeof setTimeout> | null = null;

  constructor(renderer: Renderer, strings: StringsProvider) {
    this.renderer = renderer;
    this.strings = strings;
  }

  setResolveDisplay(fn: ((s: string) => string) | null): void {
    this.resolveDisplay = fn;
  }

  show(text: string): Promise<void> {
    // 二次 show 时先正常收尾旧会话（resolve 旧 Promise、拆监听、销毁旧容器），
    // 否则旧 Promise 永不 resolve、等待它的动作链悬挂。
    if (this.container || this.resolveClose) this.close();
    return new Promise(resolve => {
      this.resolveClose = resolve;

      this.container = new Container();

      const sw = this.renderer.screenWidth;
      const sh = this.renderer.screenHeight;
      const boxWidth = Math.min(sw - H_MARGIN * 2, MAX_BOX_W);
      const displayText = this.resolveDisplay ? this.resolveDisplay(text) : text;

      const textObj = createStyledText({
        text: displayText,
        style: {
          // 这块框里正文就是主角（玩家要读几秒），但它是**描述**不是台词：
          // bodyLarge 在 600px 宽的盒子里一行只剩 24 字，读起来像被人贴脸念；
          // body 一行 26 字、配上面那档行距，才是「看一眼物件」该有的呼吸。
          fontSize: UITheme.fontSize.body,
          fill: UITheme.colors.body,
          fontFamily: UITheme.fonts.ui,
          wordWrap: true, breakWords: true,
          lineHeight: BODY_LINE_H,
          wordWrapWidth: boxWidth - PAD * 2 - SCROLL_GUTTER,
        },
      });

      // 先量正文再定盒高：短句不撑空盒，长文封顶到满屏后交给滚动
      const boxHeight = Math.min(
        Math.max(MIN_BOX_H, textObj.height + TEXT_TOP + HINT_BAND),
        sh - V_MARGIN * 2,
      );
      const boxX = (sw - boxWidth) / 2;
      const boxY = sh - boxHeight - V_MARGIN;

      // 与面板同一套语汇：纸纹底 + 做旧木框 + 内侧暗金细线（createPanel 一并给齐）
      this.container.addChild(createPanel(boxX, boxY, boxWidth, boxHeight, SKINS.panelAlt, {
        fillAlpha: UITheme.alpha.dialogueBg,
        border: UITheme.colors.borderActive,
      }));

      const viewH = boxHeight - TEXT_TOP - HINT_BAND;
      const view = new UIScrollView(this.renderer, {
        width: boxWidth - PAD * 2,
        height: viewH,
        // 本框不铺遮罩，屏幕其余部分仍是场景：只吃落在盒子上的滚轮
        hitTest: (hx, hy) => hx >= boxX && hx <= boxX + boxWidth && hy >= boxY && hy <= boxY + boxHeight,
      });
      view.container.position.set(boxX + PAD, boxY + TEXT_TOP);
      view.content.addChild(textObj);
      this.container.addChild(view.container);
      view.refresh();
      this.view = view;
      this.scrollable = textObj.height > viewH;

      // 正文与关闭提示之间一条两端渐隐的细线：设计稿里页脚都是这么分出来的
      const rule = createRule(boxWidth - PAD * 2);
      rule.position.set(boxX + PAD, boxY + boxHeight - HINT_BAND + UITheme.spacing.sm);
      this.container.addChild(rule);

      const hint = createStyledText({
        text: this.strings.get('inspectBox', 'closeHint'),
        style: {
          // 键位说明的档是 small；micro 是留给角标/页码/计数的。
          // 它比正文小一档 + 压暗 + 拉字距，层级已经说得很清楚，不必再缩成蚊子字。
          fontSize: UITheme.fontSize.small,
          fill: UITheme.colors.hintMid,
          fontFamily: UITheme.fonts.ui,
          letterSpacing: UITheme.letterSpacing.title / 2,
          wordWrap: true, breakWords: true,
          wordWrapWidth: boxWidth - PAD * 2,
        },
      });
      hint.anchor.set(0.5, 1);
      hint.x = boxX + boxWidth / 2;
      hint.y = boxY + boxHeight - UITheme.spacing.xl;
      this.container.addChild(hint);

      this.renderer.uiLayer.addChild(this.container);

      this.showTimerId = setTimeout(() => {
        this.showTimerId = null;
        this.onKeyHandler = (e: KeyboardEvent) => {
          // 正文溢出时方向键 / 翻页键归滚动，其余任意键仍是关闭
          if (this.scrollable && this.view?.handleKey(e.code)) {
            e.preventDefault();
            return;
          }
          this.close();
        };
        this.onClickHandler = (e: PointerEvent) => {
          // 拖滚动条那一下会被标记为"已消费"：不放过它就等于"想滚一下结果把框关了"
          if (isPointerConsumed(e)) return;
          this.close();
        };
        // ⚠ 不能用 { once: true }：被消费的那一次点击会白白把监听摘掉，之后再点就关不掉了
        window.addEventListener('keydown', this.onKeyHandler);
        window.addEventListener('pointerdown', this.onClickHandler);
      }, ARM_DELAY);
    });
  }

  close(): void {
    if (this.showTimerId !== null) {
      clearTimeout(this.showTimerId);
      this.showTimerId = null;
    }
    if (this.onKeyHandler) {
      window.removeEventListener('keydown', this.onKeyHandler);
      this.onKeyHandler = null;
    }
    if (this.onClickHandler) {
      window.removeEventListener('pointerdown', this.onClickHandler);
      this.onClickHandler = null;
    }
    // 先拆滚动区：它自己在 window 上挂了 wheel 监听，只销毁父容器会留残留
    this.view?.destroy();
    this.view = null;
    this.scrollable = false;
    if (this.container) {
      if (this.container.parent) {
        this.container.parent.removeChild(this.container);
      }
      this.container.destroy({ children: true });
      this.container = null;
    }
    this.resolveClose?.();
    this.resolveClose = null;
  }

  get isOpen(): boolean {
    return this.container !== null;
  }

  destroy(): void {
    this.close();
  }
}
