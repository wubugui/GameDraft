import { Container, Graphics, Rectangle } from '../../engine2d';
import { UITheme, fadeIn } from '../UITheme';
import { createPanel, drawPanelBase, SKINS } from '../PanelSkin';
import { createTitleRow } from './UIDecor';
import { UIButton } from './UIButton';
import { markPointerConsumed } from '../uiPointerCoords';
import { createStyledText } from '../../core/styledText';
import type { Renderer } from '../../rendering/Renderer';

/**
 * 文字输入框：玩家要打字的唯一通道（第一个用户是「给存档起名字」，2026-09-23）。
 *
 * ## 为什么输入本身是一个真 DOM `<input>`
 *
 * 名字多半是中文，**中文要输入法**（拼音候选窗、组字中的未上屏字、选词回车）。
 * 在 Pixi 里自己画一个文本框就得自己接 `compositionstart/update/end`、自己画光标与选区、
 * 自己处理粘贴与方向键——而且输入法候选窗的位置跟着的是**浏览器认为的焦点元素**，
 * 画出来的框它根本不知道在哪。所以框体（木框、标题、按钮）照旧是 Pixi 画的，
 * 输入这一格是一个透明底的真 `<input>`，按画布此刻的显示矩形盖在那一格上。
 *
 * ## 键盘纪律（与确认框相反，这里是**不许**在捕获阶段吞键）
 *
 * 确认框在 window 捕获阶段 `stopImmediatePropagation` 吞掉全部按键——那样事件根本到不了
 * 输入框，一个字都打不进去。这里改成在 **输入框自己身上** `stopPropagation`：按键照常
 * 落到输入框（打字 / 输入法都正常），但不再冒泡到挂在 window 冒泡阶段的
 * `InputManager` / `MenuUI.onKey` / 各面板快捷键（否则打个 `L` 会开对话记录、打 `w a s d`
 * 会在底下的菜单里挪焦点、打空格会激活槽位）。另有 {@link isTextPromptOpen} 给
 * GameStateController 的按键压制钩子兜底。
 *
 * **组字中的回车 / Esc 属于输入法**（选词、取消组字），不许当成「确定 / 取消」。
 *
 * ## 生命周期
 *
 * 同屏只许一个；Promise 必然 resolve（确定 = 输入框里的原文，取消 = null），关闭路径唯一收口
 * `finish`：摘 DOM、摘监听、摘 Pixi 根，不留任何残留。
 */
export interface TextPromptOptions {
  title: string;
  message?: string;
  /** 预填内容（改名时 = 原名） */
  initial?: string;
  /** 占位提示（空着时显示的灰字） */
  placeholder?: string;
  /** 最多几个字（按 Unicode 字符数；输入框的 maxLength 按 UTF-16 码元，只作第一道闸） */
  maxLength: number;
  confirmLabel: string;
  cancelLabel: string;
  onSound?: (name: 'hover' | 'press') => void;
}

let promptActive = false;

/** 模态在场判据（给 GameStateController 的按键压制钩子用，与 isConfirmDialogOpen 同一用途）。 */
export function isTextPromptOpen(): boolean {
  return promptActive;
}

/** 输入框里的文字高（逻辑像素）。与槽位行主行同一档，看着就是"这一格会变成那一行"。 */
const FIELD_FONT_SIZE = UITheme.fontSize.bodyLarge;
const FIELD_H = 52;
const FIELD_PAD_X = UITheme.spacing.md;

function cssColor(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`;
}

export function openTextPrompt(renderer: Renderer, opts: TextPromptOptions): Promise<string | null> {
  if (promptActive) return Promise.resolve(null);
  promptActive = true;

  return new Promise<string | null>((resolve) => {
    const sw = renderer.screenWidth;
    const sh = renderer.screenHeight;
    const root = new Container();
    root.zIndex = UITheme.z.tooltip;

    const input = document.createElement('input');
    let finished = false;
    let unsubscribeResize: (() => void) | null = null;
    const finish = (result: string | null): void => {
      if (finished) return;
      finished = true;
      window.removeEventListener('resize', place);
      unsubscribeResize?.();
      unsubscribeResize = null;
      input.blur();
      input.remove();
      if (root.parent) root.parent.removeChild(root);
      root.destroy({ children: true });
      promptActive = false;
      resolve(result);
    };

    // 罩层：压暗全屏 + 吞掉点击（点罩层 = 取消，与确认框同一口径）
    const scrim = new Graphics();
    scrim.rect(0, 0, sw, sh);
    scrim.fill({ color: UITheme.colors.overlay, alpha: UITheme.alpha.overlayDark });
    scrim.eventMode = 'static';
    scrim.hitArea = new Rectangle(0, 0, sw, sh);
    scrim.on('pointerdown', (e) => {
      markPointerConsumed((e as { nativeEvent?: unknown }).nativeEvent);
      finish(null);
    });
    root.addChild(scrim);

    const pad = UITheme.spacing.xl;
    const panelW = Math.max(420, Math.min(Math.round(sw * 0.5), 560));
    const innerW = panelW - pad * 2;
    const btnGap = UITheme.spacing.md;
    const btnW = Math.round((innerW - btnGap) / 2);
    const btnH = 56;

    const title = createTitleRow(opts.title, { width: innerW, fontSize: UITheme.fontSize.title });
    const message = opts.message
      ? createStyledText({
          text: opts.message,
          style: {
            fontSize: UITheme.fontSize.body,
            fill: UITheme.colors.bodyMuted,
            fontFamily: UITheme.fonts.ui,
            wordWrap: true, breakWords: true, wordWrapWidth: innerW,
            lineHeight: Math.round(UITheme.fontSize.body * 1.5),
          },
        })
      : null;

    let cy = pad + title.rowHeight + UITheme.spacing.lg;
    const msgY = cy;
    if (message) cy += message.height + UITheme.spacing.md;
    const fieldY = cy;
    cy += FIELD_H + UITheme.spacing.lg;
    const btnY = cy;
    const panelH = btnY + btnH + pad;

    const panel = new Container();
    panel.addChild(createPanel(0, 0, panelW, panelH, SKINS.dialogue));
    title.position.set(pad, pad);
    panel.addChild(title);
    if (message) {
      message.position.set(pad, msgY);
      panel.addChild(message);
    }
    // 输入格的底：暗底 + 木色细边（与存档槽位行同一套皮），真正的字由盖在上面的 <input> 画
    const field = new Graphics();
    drawPanelBase(field, 0, 0, innerW, FIELD_H, SKINS.row, {
      fill: UITheme.colors.rowBgDark,
      border: UITheme.colors.borderSelected,
    });
    field.position.set(pad, fieldY);
    // 点在输入格的描边上（输入框之外那一圈）也要把焦点还给输入框，不能穿到罩层上算"取消"
    field.eventMode = 'static';
    field.on('pointerdown', (e) => {
      markPointerConsumed((e as { nativeEvent?: unknown }).nativeEvent);
      input.focus();
    });
    panel.addChild(field);

    const cancelBtn = new UIButton({
      label: opts.cancelLabel, width: btnW, height: btnH, variant: 'secondary',
      onPress: () => finish(null), onSound: opts.onSound,
    });
    cancelBtn.container.position.set(pad, btnY);
    panel.addChild(cancelBtn.container);
    const confirmBtn = new UIButton({
      label: opts.confirmLabel, width: btnW, height: btnH, variant: 'primary',
      onPress: () => finish(input.value), onSound: opts.onSound,
    });
    confirmBtn.container.position.set(pad + btnW + btnGap, btnY);
    panel.addChild(confirmBtn.container);

    const panelX = Math.round((sw - panelW) / 2);
    const panelY = Math.round((sh - panelH) / 2);
    panel.position.set(panelX, panelY);
    root.addChild(panel);

    // ── DOM 输入框 ──
    input.type = 'text';
    input.value = opts.initial ?? '';
    input.placeholder = opts.placeholder ?? '';
    input.maxLength = opts.maxLength * 2; // 码元上限只作第一道闸（一个生僻字可能占两个码元），真上限在确定时按字符截
    input.spellcheck = false;
    input.autocomplete = 'off';
    input.setAttribute('aria-label', opts.title);
    Object.assign(input.style, {
      position: 'fixed',
      margin: '0',
      padding: '0',
      border: 'none',
      outline: 'none',
      background: 'transparent',
      color: cssColor(UITheme.colors.bookLabel),
      caretColor: cssColor(UITheme.colors.title),
      fontFamily: UITheme.fonts.ui,
      zIndex: '2147483000',
      boxSizing: 'border-box',
    } satisfies Partial<CSSStyleDeclaration>);

    /**
     * 按画布**此刻**的显示矩形摆输入框：画布会被等比信箱缩放（display-viewport-and-window），
     * F2 调试坞也会挤它，逻辑坐标 × 显示比例才是它在屏幕上的位置。字号一并按比例缩。
     */
    function place(): void {
      if (finished) return;
      const canvas = renderer.app.canvas as HTMLCanvasElement;
      const rect = canvas.getBoundingClientRect();
      const k = rect.width / Math.max(1, sw);
      const x = panelX + pad + FIELD_PAD_X;
      const y = panelY + fieldY;
      input.style.left = `${rect.left + x * k}px`;
      input.style.top = `${rect.top + y * k}px`;
      input.style.width = `${(innerW - FIELD_PAD_X * 2) * k}px`;
      input.style.height = `${FIELD_H * k}px`;
      input.style.fontSize = `${FIELD_FONT_SIZE * k}px`;
      input.style.lineHeight = `${FIELD_H * k}px`;
    }

    input.addEventListener('keydown', (e) => {
      // 不冒泡到 window：底下的菜单导航 / 面板快捷键 / 移动键一个都不许收到
      e.stopPropagation();
      // 组字中（拼音还没上屏）的回车 / Esc 归输入法
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(input.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(null);
      }
    });
    input.addEventListener('keyup', (e) => e.stopPropagation());
    // 输入框吃掉的指针不许再被 window 级推进监听当成"点了一下画面"
    input.addEventListener('pointerdown', (e) => e.stopPropagation());

    renderer.uiLayer.addChild(root);
    fadeIn(panel);
    document.body.appendChild(input);
    place();
    window.addEventListener('resize', place);
    unsubscribeResize = renderer.subscribeAfterResize(place);
    input.focus();
    input.select();
  });
}
