import { Container, Graphics, Text } from 'pixi.js';
import { UITheme } from './UITheme';
import { createPanel, SKINS } from './PanelSkin';
import { createIcon } from './components/UIDecor';
import type { Renderer } from '../rendering/Renderer';
import type { StringsProvider } from '../core/StringsProvider';
import { createStyledText } from '../core/styledText';

// ---------------------------------------------------------------------------
// 时序常量：**语义不可改**（2s 后移除，1.5s 起淡出）。
// ---------------------------------------------------------------------------
const DISPLAY_DURATION = 2000;
const FADE_START = 1500;
/** 进场淡入：motion 的「提示进出」档，配 easeOut */
const FADE_IN_DURATION = UITheme.motion.normal;

const PAD_X = UITheme.spacing.md;
/** 行高自带上下各半档留白，所以竖向内边距收到 xs，单行条高仍是 {@link MIN_BOX_H} */
const PAD_Y = UITheme.spacing.xs;
/**
 * 正文行高 1.3 倍：物品名长到换行时两行之间要有缝。
 * ⚠ 用 `lineHeight` 不用 `leading`——Pixi v8 的 leading 量高比实际绘制矮半档，末行会被裁掉。
 */
const LINE_H = Math.round(UITheme.fontSize.body * 1.3);
/** 屏幕右上角内缩 */
const SCREEN_MARGIN = UITheme.spacing.xl;
/**
 * 堆叠时两条之间的缝。
 * ⚠ 旧实现是**固定步距 40**，而条高是按正文现算的（`max(36, 文字高 + 上下内边距)`）——
 * 字号一超过 24 或者物品名换行，条高就大于步距，后一条直接压在前一条身上。
 * 现在改成按各条真高累加，步距只剩这条缝。
 */
const ROW_GAP = UITheme.spacing.xs;
/** 正文换行宽度：按 body 档一行装得下「获得了 + 十来字物品名 + xN」，免得为一个 xN 换行 */
const MAX_TEXT_WIDTH = 300;
/** 条高下限：木边 5px + 圆形图标徽章（直径 20）留得下 */
const MIN_BOX_H = UITheme.spacing.xxl + UITheme.spacing.xs;
/** 左侧圆形图标徽章，与 NotificationUI 的提示条同一枚 */
const BADGE_R = 10;
const BADGE_ICON = 12;

export class PickupNotification {
  private static readonly MAX_VISIBLE = 5;
  private renderer: Renderer;
  private strings: StringsProvider;
  private activeNotifications: Container[] = [];
  private unsubscribeResize: () => void;

  constructor(renderer: Renderer, strings: StringsProvider) {
    this.renderer = renderer;
    this.strings = strings;
    // 右上角贴边：画布尺寸变化后必须重算 x（侧栏挤压 #game-mount 走 Renderer 的
    // ResizeObserver，根本不发 window resize；真窗口 resize 也被 Pixi 推到 rAF 之后）
    this.unsubscribeResize = this.renderer.subscribeAfterResize(() => this.relayout());
  }

  show(itemName: string, count: number): void {
    const container = new Container();

    const label = this.strings.get('pickup', 'acquired', { name: itemName, count });

    const text = createStyledText({
      text: label,
      style: {
        // 「获得了 纸钱 x5」是**扫一眼就过**的入袋回执，不是要读的正文：
        // bodyLarge 是台词/按钮的档，挂在屏幕右上角比场景里任何东西都抢眼。收回 body。
        fontSize: UITheme.fontSize.body,
        fill: UITheme.colors.pickupText,
        fontFamily: UITheme.fonts.ui,
        wordWrap: true,
        breakWords: true,
        lineHeight: LINE_H,
        wordWrapWidth: MAX_TEXT_WIDTH,
      },
    });

    // 与提示条同一套语汇：小木框条 + 左边一枚圆形图标徽章（布袋）+ 右边一行短字。
    // 图标素材没到位（createIcon → null）时圆章整枚省掉，文字左移贴回内边距。
    // ⚠ tint 走赋值不走入参：`createIcon` 的默认参数把 tint 推断成了字面量类型，传变量不过编译
    const icon = createIcon('pouch', BADGE_ICON);
    if (icon) icon.tint = UITheme.colors.pickupText;
    const textX = icon ? PAD_X + BADGE_R * 2 + UITheme.spacing.sm : PAD_X;
    const boxW = Math.ceil(textX + text.width + PAD_X);
    const boxH = Math.max(MIN_BOX_H, Math.ceil(text.height + PAD_Y * 2));

    container.addChild(createPanel(0, 0, boxW, boxH, SKINS.toast));

    if (icon) {
      const cx = PAD_X + BADGE_R;
      const cy = Math.round(boxH / 2);
      const badge = new Graphics();
      badge.circle(cx, cy, BADGE_R);
      badge.fill({ color: UITheme.colors.rowBgInactive, alpha: 0.9 });
      badge.circle(cx, cy, BADGE_R);
      badge.stroke({ color: UITheme.colors.hairline, width: 1, alpha: UITheme.alpha.hairline * 2 });
      badge.eventMode = 'none';
      container.addChild(badge);

      icon.position.set(cx - BADGE_ICON / 2, cy - BADGE_ICON / 2);
      container.addChild(icon);
    }

    text.x = textX;
    text.y = Math.round((boxH - text.height) / 2);
    container.addChild(text);

    container.y = SCREEN_MARGIN;
    // 进场从全透明起，由 tick 按 easeOut 推到 1
    container.alpha = 0;

    this.renderer.uiLayer.addChild(container);
    // 拾取提示与 toast 同层级，恒压在之后打开的面板之上（Pixi v8 写 zIndex 会自动
    // 打开父容器 sortableChildren；其余 uiLayer 子节点 zIndex 为 0，相对顺序不变）
    container.zIndex = UITheme.z.toast;
    this.activeNotifications.push(container);
    this.relayout();

    if (this.activeNotifications.length > PickupNotification.MAX_VISIBLE) {
      this.removeNotification(this.activeNotifications[0]);
    }

    const startTime = performance.now();

    const tick = () => {
      if (!this.activeNotifications.includes(container)) return;
      const elapsed = performance.now() - startTime;
      if (elapsed >= DISPLAY_DURATION) {
        this.removeNotification(container);
        return;
      }
      if (elapsed > FADE_START) {
        // 出场与进场同一条 easeOut；起止时刻仍是 FADE_START → DISPLAY_DURATION
        const t = (elapsed - FADE_START) / (DISPLAY_DURATION - FADE_START);
        container.alpha = 1 - UITheme.motion.easeOut(Math.min(1, Math.max(0, t)));
      } else if (elapsed < FADE_IN_DURATION) {
        container.alpha = UITheme.motion.easeOut(Math.min(1, Math.max(0, elapsed / FADE_IN_DURATION)));
      } else {
        container.alpha = 1;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /** 右上角贴边 + 纵向堆叠：位置全在这里算，show/移除/画布 resize 都复用 */
  private relayout(): void {
    let y = SCREEN_MARGIN;
    for (let i = 0; i < this.activeNotifications.length; i++) {
      const c = this.activeNotifications[i];
      c.x = Math.round(this.renderer.screenWidth - c.width - SCREEN_MARGIN);
      c.y = y;
      // 按各条真高累加，换行撑高的条不会被下一条压住
      y += Math.round(c.height) + ROW_GAP;
    }
  }

  private removeNotification(container: Container): void {
    const idx = this.activeNotifications.indexOf(container);
    if (idx !== -1) {
      this.activeNotifications.splice(idx, 1);
    }
    if (container.parent) {
      container.parent.removeChild(container);
    }
    container.destroy({ children: true });
    this.relayout();
  }

  forceCleanup(): void {
    for (const c of this.activeNotifications) {
      if (c.parent) {
        c.parent.removeChild(c);
      }
      c.destroy({ children: true });
    }
    this.activeNotifications = [];
  }

  destroy(): void {
    this.forceCleanup();
    this.unsubscribeResize();
  }
}
