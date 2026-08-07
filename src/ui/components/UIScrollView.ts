import { Container, Graphics, Rectangle } from 'pixi.js';
import type { FederatedPointerEvent } from 'pixi.js';
import { UITheme } from '../UITheme';
import { canvasPointFromEvent, clientToCanvas, markPointerConsumed } from '../uiPointerCoords';
import type { Renderer } from '../../rendering/Renderer';

/**
 * 可滚动区域：遮罩裁切 + 滚轮 + **滚动条** + 键盘上下。
 *
 * 此前 8 个面板各自手写同一套 `listScrollOffset` / `mask` / `onWheel`
 * （LoreBook、SlangBook、CharacterBook、DocumentBox、QuestPanel、RulesPanel、
 * DialogueLog、BookReader），且**全项目没有任何滚动条渲染**——列表再长也没有
 * 「下面还有」的信号。这里收口成一处。
 *
 * 用法：把内容加进 `content`，改完内容调 `refresh()` 重算可滚动高度。
 */

const BAR_W = 4;
const BAR_MIN_H = 24;
/** 4px 宽的条用鼠标抓不住：thumb 的命中区左右各放宽到这个宽度（只放宽命中，不放宽视觉） */
const GRAB_W = 16;

export interface UIScrollViewOptions {
  /** 视口宽高（裁切范围） */
  width: number;
  height: number;
  /** 滚轮命中判定：返回 true 才响应本次滚轮（多栏面板用来分栏） */
  hitTest?: (x: number, y: number) => boolean;
  /** 每次滚轮/按键的步长，缺省 30 */
  step?: number;
  /**
   * 视口底部留白。各面板 `fill()` 里累加的**尾部间距不产生子元素**，量不进
   * `getLocalBounds()`——滚到底时最后一行会贴着视口下沿。给了这个值就补回来。
   */
  bottomPadding?: number;
  /** 滚动位置变化回调。虚拟化列表据此增量补/回收视口附近的条目。 */
  onScroll?: (offset: number) => void;
}

export class UIScrollView {
  /** 挂到父容器上的根；位置由调用方设置 */
  readonly container: Container;
  /** 内容容器：调用方往这里加东西，坐标以内容顶部为原点 */
  readonly content: Container;

  private renderer: Renderer;
  private opts: UIScrollViewOptions;
  private maskG: Graphics;
  private bar: Graphics;
  /** thumb 与 track 分开画：thumb 要单独接指针、单独定位，混在一个 Graphics 里没法拖 */
  private thumb: Graphics;
  private offset = 0;
  private contentH = 0;
  /** 虚拟化列表给的内容总高（见 setContentHeight）；null = 自动量高 */
  private contentHeightOverride: number | null = null;
  private dragging = false;
  private dragStartY = 0;
  private dragStartOffset = 0;
  private onWheelBound: (e: WheelEvent) => void;
  private onDragMoveBound: (e: PointerEvent) => void;
  private onDragEndBound: () => void;
  private destroyed = false;

  constructor(renderer: Renderer, opts: UIScrollViewOptions) {
    this.renderer = renderer;
    this.opts = opts;
    this.container = new Container();
    this.content = new Container();
    this.maskG = new Graphics();
    this.bar = new Graphics();
    this.thumb = new Graphics();

    this.maskG.rect(0, 0, opts.width, opts.height);
    this.maskG.fill({ color: 0xffffff });
    this.container.addChild(this.maskG);
    this.content.mask = this.maskG;
    this.container.addChild(this.content);
    this.container.addChild(this.bar);
    this.container.addChild(this.thumb);

    // 滚动条此前只画不接指针——玩家看见一根条就会去拖，拖不动是纯粹的观感退步。
    this.thumb.eventMode = 'static';
    this.thumb.cursor = 'pointer';
    this.thumb.visible = false;
    this.thumb.on('pointerdown', (e: FederatedPointerEvent) => this.onThumbDown(e));

    // 轨道也要接指针：此前只有 thumb 接，点轨道空白处会**穿透**到 window 级监听
    // （检视框因此被关掉、遭遇框因此把打字机推完）。接住 = 翻一页 + 标记消费。
    this.bar.eventMode = 'static';
    this.bar.cursor = 'pointer';
    this.bar.on('pointerdown', (e: FederatedPointerEvent) => this.onTrackDown(e));

    this.onWheelBound = (e) => this.onWheel(e);
    this.onDragMoveBound = (e) => this.onDragMove(e);
    this.onDragEndBound = () => this.endDrag();
    window.addEventListener('wheel', this.onWheelBound, { passive: false });
  }

  /**
   * 可滚距离。**亚像素一律当作不可滚**：调用方常用
   * `盒高 = 内容高 + 上下留白` 反推、再 `视口 = 盒高 - 上下留白` 算回来，
   * IEEE754 下这一来一回会差出 ~1e-14，足以让「根本没溢出」的内容
   * 冒出一条满高滚动条、并让方向键被 handleKey 吞掉（检视框「按任意键关闭」因此失灵）。
   */
  private get maxScroll(): number {
    const d = this.contentH - this.opts.height;
    return d > 0.5 ? d : 0;
  }

  /**
   * 虚拟化列表专用：内容总高由调用方给出。
   *
   * 只构造视口附近条目时 `getLocalBounds()` 只量得到"已构造的那几条"，滚动条比例会
   * 缩水成假的（拖到底其实还有一大截没走完）。传 null 恢复自动量高。
   */
  setContentHeight(h: number | null): void {
    this.contentHeightOverride = h === null ? null : Math.max(0, h);
    this.refresh();
  }

  /** 内容变更后调用：重算高度、夹紧偏移、重画滚动条。 */
  refresh(): void {
    if (this.destroyed) return;
    if (this.contentHeightOverride !== null) {
      this.contentH = this.contentHeightOverride;
    } else {
      // ⚠ 量高之前必须先摘 mask：Pixi v8 的 getLocalBounds 会把 target 自身的 mask
      // 走 addMaskLocalBounds 求**交集**，量出来的高恒被夹到视口高 → maxScroll 恒为 0，
      // 滚轮 / 滚动条 / 方向键全部失效（而且 mask 是 content 的兄弟节点，还会刷
      // "Mask bounds, renderable is not inside the root container" 警告）。
      const mask = this.content.mask;
      this.content.mask = null;
      this.contentH = Math.max(0, this.content.getLocalBounds().height);
      this.content.mask = mask;
    }
    this.contentH += this.opts.bottomPadding ?? 0;

    this.offset = Math.min(this.offset, this.maxScroll);
    this.apply();
  }

  private apply(): void {
    this.content.y = -this.offset;
    this.drawBar();
    this.opts.onScroll?.(this.offset);
  }

  /** thumb 高度：与 drawBar 同一口径，拖动换算也要用它（travel = 视口高 - thumb 高） */
  private thumbHeight(): number {
    return Math.max(BAR_MIN_H, (this.opts.height / Math.max(1, this.contentH)) * this.opts.height);
  }

  /**
   * 滚动条：只有内容溢出时才画。这是此前全项目缺失的「还有更多」信号。
   */
  private drawBar(): void {
    this.bar.clear();
    this.thumb.clear();
    const max = this.maxScroll;
    if (max <= 0) {
      // 滚不动时连命中区一起收掉，否则右边缘会有一条抢指针的隐形带
      this.thumb.visible = false;
      return;
    }
    const { width: w, height: h } = this.opts;
    const trackX = w - BAR_W;
    this.bar.rect(trackX, 0, BAR_W, h);
    this.bar.fill({ color: UITheme.colors.sliderTrack, alpha: 0.7 });
    // 命中区比 4px 的视觉宽度放宽，否则轨道点击等于点不到
    this.bar.hitArea = new Rectangle(trackX - (GRAB_W - BAR_W) / 2, 0, GRAB_W, h);

    const thumbH = this.thumbHeight();
    const thumbY = (this.offset / max) * (h - thumbH);
    this.thumb.rect(0, 0, BAR_W, thumbH);
    this.thumb.fill({ color: UITheme.colors.sliderHandle, alpha: this.dragging ? 1 : 0.75 });
    this.thumb.position.set(trackX, thumbY);
    this.thumb.hitArea = new Rectangle(-(GRAB_W - BAR_W) / 2, 0, GRAB_W, thumbH);
    this.thumb.visible = true;
  }

  // -- thumb 拖动 ------------------------------------------------------------

  /** clientY → 画布逻辑 y（canvas 可能被 CSS 缩放，clientY 不能直接用）。 */
  private pointerY(e: unknown): number | null {
    const cy = (e as { clientY?: number } | null | undefined)?.clientY;
    if (typeof cy !== 'number') return null;
    return clientToCanvas(this.renderer, 0, cy).y;
  }

  private onThumbDown(e: FederatedPointerEvent): void {
    if (this.destroyed || this.maxScroll <= 0) return;
    // 同一次原生事件随后还会到达 window 级监听（对话推进等），不标记就会"点一下滚动条顺便推进剧情"
    markPointerConsumed(e.nativeEvent);
    const y = this.pointerY(e.nativeEvent);
    if (y === null) return;
    this.dragging = true;
    this.dragStartY = y;
    this.dragStartOffset = this.offset;
    // 挂 window 而不是挂 thumb：指针一旦拖出条外（甚至拖出画布）仍要跟随，
    // 这也是 destroy() 里必须无条件摘干净的原因。
    window.addEventListener('pointermove', this.onDragMoveBound);
    window.addEventListener('pointerup', this.onDragEndBound);
    window.addEventListener('pointercancel', this.onDragEndBound);
    this.drawBar();
  }

  /** 点轨道空白处：朝那个方向翻一页。**必须标记消费**，否则同一次原生事件还会推进对话/关掉检视框。 */
  private onTrackDown(e: FederatedPointerEvent): void {
    if (this.destroyed || this.maxScroll <= 0) return;
    markPointerConsumed(e.nativeEvent);
    const y = this.pointerY(e.nativeEvent);
    if (y === null) return;
    const localY = y - this.container.getGlobalPosition().y;
    this.scrollBy(localY < this.thumb.y ? -this.opts.height : this.opts.height);
  }

  private onDragMove(e: PointerEvent): void {
    if (this.destroyed || !this.dragging) return;
    const max = this.maxScroll;
    const travel = this.opts.height - this.thumbHeight();
    if (max <= 0 || travel <= 0) return;
    const y = this.pointerY(e);
    if (y === null) return;
    // thumb 走完整条轨道（travel）= 内容走完 maxScroll
    const next = this.dragStartOffset + ((y - this.dragStartY) / travel) * max;
    this.offset = Math.max(0, Math.min(next, max));
    this.apply();
  }

  private endDrag(): void {
    window.removeEventListener('pointermove', this.onDragMoveBound);
    window.removeEventListener('pointerup', this.onDragEndBound);
    window.removeEventListener('pointercancel', this.onDragEndBound);
    if (!this.dragging) return;
    this.dragging = false;
    if (!this.destroyed) this.drawBar();
  }

  private onWheel(e: WheelEvent): void {
    if (this.destroyed) return;
    const pt = canvasPointFromEvent(this.renderer, e);
    if (!pt) return;
    if (this.opts.hitTest && !this.opts.hitTest(pt.x, pt.y)) return;
    // 面板开着就吞掉滚轮，**哪怕当前滚不动**——否则事件落到页面或其它 window 级监听
    // （旧四个面板都是无条件 preventDefault）。
    e.preventDefault();
    if (this.maxScroll <= 0) return;
    this.scrollBy(this.normalizedDelta(e));
  }

  /**
   * 滚轮增量归一。**必须看 `deltaMode`**：Firefox 一类环境用行模式（deltaMode=1），
   * 一格滚轮只给 deltaY=3——直接当像素用就是"一格滚 3 像素"，观感等同滚不动。
   * 旧的各面板手写实现是 `deltaY > 0 ? 30 : -30`，与 deltaMode 无关，所以没这个问题；
   * 收进组件后必须把这条补回来，否则是跨浏览器的功能性退化。
   */
  private normalizedDelta(e: WheelEvent): number {
    const step = this.opts.step ?? 30;
    if (e.deltaMode === 1) return Math.sign(e.deltaY) * step;              // 行
    if (e.deltaMode === 2) return Math.sign(e.deltaY) * this.opts.height;  // 页
    return e.deltaY;                                                       // 像素
  }

  scrollBy(delta: number): void {
    this.offset = Math.max(0, Math.min(this.offset + delta, this.maxScroll));
    this.apply();
  }

  /**
   * 供面板把方向键接进来（此前方向键在各面板里各写各的）。
   *
   * **滚不动就返回 false**，把按键让回给调用方——检视框那类「按任意键关闭」的面板
   * 靠这个才不会被一个滚不动的滚动区把关闭键吃掉。
   */
  handleKey(code: string): boolean {
    if (this.maxScroll <= 0) return false;
    const step = this.opts.step ?? 30;
    if (code === 'ArrowUp') { this.scrollBy(-step); return true; }
    if (code === 'ArrowDown') { this.scrollBy(step); return true; }
    if (code === 'PageUp') { this.scrollBy(-this.opts.height); return true; }
    if (code === 'PageDown') { this.scrollBy(this.opts.height); return true; }
    return false;
  }

  /** 视口高度（虚拟化列表算"哪些条目该存在"时要用，别去问窗体——窗体 resize 后两者会岔开） */
  get viewportHeight(): number { return this.opts.height; }

  /** 保留滚动位置重建内容时用（点条目后重绘列表不该跳回顶部） */
  get scrollOffset(): number { return this.offset; }
  set scrollOffset(v: number) { this.offset = Math.max(0, Math.min(v, this.maxScroll)); this.apply(); }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.endDrag();
    window.removeEventListener('wheel', this.onWheelBound);
    this.content.mask = null;
    if (this.container.parent) this.container.parent.removeChild(this.container);
    this.container.destroy({ children: true });
  }
}
