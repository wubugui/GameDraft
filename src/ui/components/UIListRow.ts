import { Container, Graphics, Rectangle, type FederatedPointerEvent } from 'pixi.js';
import { drawPanelBase, SKINS, type PanelDrawOverrides } from '../PanelSkin';
import { drawFocusRing, drawHoverRow, drawSelectedRow } from './UIDecor';
import { isPointerDragScrolling, markPointerConsumed } from '../uiPointerCoords';
import type { FocusVia } from './UIFocus';

/**
 * 可交互列表行原语（审查批3b）。此前全站行类交互各自手搭：裸 hit rect、
 * `markPointerConsumed` 靠人肉记（同一条"否则点列表推进剧情"的警告注释在 4 个组件重复）、
 * 焦点高亮各画各的。本件**默认安全**：
 *
 * - 激活语义 = **tap（pointerup）**，不是 pointerdown——拖动滚动（UIScrollView 内容区拖滚）
 *   经过的行不被误选：拖滚在 move 阶段置全局标志，行的 up 查同一标志即知道让路。
 * - down/up 一律 `markPointerConsumed`（否则同一原生事件穿透到 window 级推进监听）。
 * - **三态三画法**（见 UIFocus 类注释的三态表）：选中 = 琥珀铺光 + 金描边（恒在）；
 *   导航光标 = 空心金框（只在按键模式）；悬停 = 极淡暖底（只在指针模式，移开即消）。
 *   改造前这三样共用同一张铺光，于是"选中的那条"和"鼠标划过的那条"长得一模一样。
 *
 * 行内容（文字/圆点/徽章）仍由调用方摆——本件只管底板、命中与激活协议。
 */
export interface UIListRowOptions {
  width: number;
  height: number;
  /** 常驻选中态：整条铺琥珀 + 金描边 */
  selected?: boolean;
  /** 灰行（怪话册未收集槽）：占位、可见，但不吃指针不给焦点高亮 */
  disabled?: boolean;
  /** 底板覆盖（如按状态染行底）；selected 时忽略 */
  baseOverrides?: PanelDrawOverrides;
  /** tap 激活（pointerup 且非拖滚） */
  onTap?: () => void;
  /** 悬停上报（调用方接 focus.syncHover） */
  onHover?: () => void;
  /** 指针离开上报（调用方接 focus.clearHover）——**不接这个 hover 就不会消失** */
  onHoverEnd?: () => void;
}

export class UIListRow {
  readonly container: Container;
  private base: Graphics;
  private hoverLayer: Graphics | null;
  private ringLayer: Graphics;
  private hoverRaf = 0;
  private ringRaf = 0;
  private opts: UIListRowOptions;

  constructor(opts: UIListRowOptions) {
    this.opts = opts;
    this.container = new Container();

    this.base = new Graphics();
    this.drawBase();
    this.base.eventMode = 'none';
    this.container.addChild(this.base);

    // 悬停层（极淡暖底）与光标层（空心金框）各一张，按 via 只亮其中一张。
    // **选中行也要有光标层**：手柄把光标移回已选中那条时，得看得出"光标在这儿"；
    // 但选中行不叠悬停层——它本来就铺着琥珀，再垫一层暖底只会白白亮一档。
    this.hoverLayer = opts.selected ? null : new Graphics();
    if (this.hoverLayer) {
      drawHoverRow(this.hoverLayer, 0, 0, opts.width, opts.height);
      this.hoverLayer.alpha = 0;
      this.hoverLayer.eventMode = 'none';
      this.container.addChild(this.hoverLayer);
    }
    this.ringLayer = new Graphics();
    drawFocusRing(this.ringLayer, 0, 0, opts.width, opts.height);
    this.ringLayer.alpha = 0;
    this.ringLayer.eventMode = 'none';
    this.container.addChild(this.ringLayer);

    if (!opts.disabled && (opts.onTap || opts.onHover)) {
      // 整行命中：Pixi 普通 Container 无 hitArea 恒不命中（pixi-v8-traps）
      this.container.eventMode = 'static';
      this.container.cursor = opts.onTap ? 'pointer' : 'default';
      this.container.hitArea = new Rectangle(0, 0, opts.width, opts.height);
      this.container.on('pointerover', () => this.opts.onHover?.());
      // 没有这一条 hover 就赖着不走（改造前全站都缺它）
      this.container.on('pointerout', () => this.opts.onHoverEnd?.());
      this.container.on('pointerdown', (e: FederatedPointerEvent) => {
        markPointerConsumed(e.nativeEvent);
      });
      this.container.on('pointerup', (e: FederatedPointerEvent) => {
        markPointerConsumed(e.nativeEvent);
        // 拖滚让路：这一下是玩家在拖列表，不是点这一行
        if (isPointerDragScrolling()) return;
        this.opts.onTap?.();
      });
    }
  }

  private drawBase(): void {
    this.base.clear();
    if (this.opts.selected) {
      drawSelectedRow(this.base, 0, 0, this.opts.width, this.opts.height);
    } else {
      drawPanelBase(this.base, 0, 0, this.opts.width, this.opts.height, SKINS.row, this.opts.baseOverrides);
    }
  }

  /**
   * 当前项高亮开关（UIFocus 的 onFocus 接这里）。
   * `via` 决定亮哪一层：按键模式亮光标框、指针模式亮悬停底；两层互斥，切模式时另一层归零。
   *
   * 淡入淡出按 motion.fast（90ms）——瞬跳的高亮是"表格软件手感"（审查批5：
   * motion.fast 定义后全站零调用，hover/press 全站瞬时跳变）。
   */
  setFocused(on: boolean, via: FocusVia = 'key'): void {
    this.fade('ring', on && via === 'key' ? 1 : 0);
    this.fade('hover', on && via === 'pointer' ? 0.85 : 0);
  }

  private fade(which: 'ring' | 'hover', to: number): void {
    const layer = which === 'ring' ? this.ringLayer : this.hoverLayer;
    if (!layer || layer.destroyed) return;
    const raf = which === 'ring' ? this.ringRaf : this.hoverRaf;
    if (raf) cancelAnimationFrame(raf);
    const from = layer.alpha;
    if (from === to) return;
    const start = performance.now();
    const dur = 90; // UITheme.motion.fast——常量内联避免仅为一个数字引整个主题
    const tick = (): void => {
      if (layer.destroyed) { this.setRaf(which, 0); return; }
      const t = Math.min(1, (performance.now() - start) / dur);
      layer.alpha = from + (to - from) * t;
      if (t < 1) this.setRaf(which, requestAnimationFrame(tick));
      else this.setRaf(which, 0);
    };
    this.setRaf(which, requestAnimationFrame(tick));
  }

  private setRaf(which: 'ring' | 'hover', id: number): void {
    if (which === 'ring') this.ringRaf = id;
    else this.hoverRaf = id;
  }

  destroy(): void {
    if (this.container.parent) this.container.parent.removeChild(this.container);
    this.container.destroy({ children: true });
  }
}
