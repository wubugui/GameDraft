import { Container } from 'pixi.js';
import { UITheme } from './UITheme';
import { buildToastChip } from './components/UIToast';
import type { Renderer } from '../rendering/Renderer';
import type { StringsProvider } from '../core/StringsProvider';
import type { EventBus } from '../core/EventBus';

// ---------------------------------------------------------------------------
// 时序常量：**语义不可改**（2s 后移除，1.5s 起淡出）。与顶中事件 toast 的 4s 是
// 语义差异不是漂移——入袋回执扫一眼就走；**视觉**已收敛到 components/UIToast 一份。
// ---------------------------------------------------------------------------
const DISPLAY_DURATION = 2000;
const FADE_START = 1500;
/** 进场淡入：motion 的「提示进出」档，配 easeOut */
const FADE_IN_DURATION = UITheme.motion.normal;

/** 屏幕右上角内缩 */
const SCREEN_MARGIN = UITheme.spacing.xl;
/**
 * 堆叠时两条之间的缝。
 * ⚠ 旧实现是**固定步距 40**，而条高是按正文现算的——物品名换行时后一条直接压在前一条身上。
 * 现在按各条真高累加，步距只剩这条缝。
 */
const ROW_GAP = UITheme.spacing.xs;
/** 条宽上限：按 body 档一行装得下「获得了 + 十来字物品名 + xN」 */
const MAX_BOX_W = 340;

export class PickupNotification {
  private static readonly MAX_VISIBLE = 5;
  private renderer: Renderer;
  private strings: StringsProvider;
  private activeNotifications: Container[] = [];
  private unsubscribeResize: () => void;
  /**
   * 电影化静默（审查 P1：本类原是全桶唯一零压制通道，过场里回执照样砸脸）：
   * 过场期间入队不上屏，cutscene:end 一次性补冒。监听自订自摘（生命周期对称）。
   */
  private suppressed = false;
  private pending: { itemName: string; count: number }[] = [];
  private eventBus: EventBus | null;
  private cutsceneStartCb = (): void => { this.suppressed = true; };
  private cutsceneEndCb = (): void => {
    this.suppressed = false;
    const queued = this.pending;
    this.pending = [];
    for (const q of queued) this.show(q.itemName, q.count);
  };

  constructor(renderer: Renderer, strings: StringsProvider, eventBus?: EventBus) {
    this.renderer = renderer;
    this.strings = strings;
    this.eventBus = eventBus ?? null;
    // 右上角贴边：画布尺寸变化后必须重算 x（侧栏挤压 #game-mount 走 Renderer 的
    // ResizeObserver，根本不发 window resize；真窗口 resize 也被 Pixi 推到 rAF 之后）
    this.unsubscribeResize = this.renderer.subscribeAfterResize(() => this.relayout());
    this.eventBus?.on('cutscene:start', this.cutsceneStartCb);
    this.eventBus?.on('cutscene:end', this.cutsceneEndCb);
  }

  show(itemName: string, count: number): void {
    if (this.suppressed) {
      this.pending.push({ itemName, count });
      return;
    }
    const label = this.strings.get('pickup', 'acquired', { name: itemName, count });

    // 视觉件与顶中事件 toast 同一份实现（components/UIToast）；回执贴边摆、宽度全贴内容
    const chip = buildToastChip({
      text: label,
      color: UITheme.colors.pickupText,
      icon: 'pouch',
      maxWidth: MAX_BOX_W,
    });
    const container = chip.container;

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
    this.eventBus?.off('cutscene:start', this.cutsceneStartCb);
    this.eventBus?.off('cutscene:end', this.cutsceneEndCb);
    this.pending = [];
  }
}
