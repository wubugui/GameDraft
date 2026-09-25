/**
 * 指针静止时的移动重发(移植自 PixiJS v8.17(MIT)`events/EventTicker.ts`,逐行对应)。
 *
 * 指针不动而场景在动时,挂在 `Ticker.system` 上每 `interactionFrequency`(以 60fps 帧计)向 document
 * 补发一次 pointermove,让 over/out 跟得上移动的物体。只有命中测试路过 `eventMode: 'dynamic'`
 * 的节点时才解除暂停(EventBoundary 里置 `pauseUpdate = false`)。
 */
import { Ticker, UPDATE_PRIORITY } from '../ticker/Ticker';
import type { EventSystem } from './EventSystem';

class EventsTickerClass {
  /** 事件系统 */
  events!: EventSystem;
  /** 监听事件的 DOM 元素 */
  domElement!: HTMLElement;
  /** 补发的频率(帧) */
  interactionFrequency = 10;

  private _deltaTime = 0;
  private _didMove = false;
  private _tickerAdded = false;
  private _pauseUpdate = true;

  /**
   * 初始化。
   * @param events - 事件系统
   */
  init(events: EventSystem): void {
    this.removeTickerListener();
    this.events = events;
    this.interactionFrequency = 10;
    this._deltaTime = 0;
    this._didMove = false;
    this._tickerAdded = false;
    this._pauseUpdate = true;
  }

  /** 是否暂停补发检查 */
  get pauseUpdate(): boolean {
    return this._pauseUpdate;
  }

  set pauseUpdate(paused: boolean) {
    this._pauseUpdate = paused;
  }

  /** 挂上 ticker 回调 */
  addTickerListener(): void {
    if (this._tickerAdded || !this.domElement) {
      return;
    }

    Ticker.system.add(this._tickerUpdate, this, UPDATE_PRIORITY.INTERACTION);

    this._tickerAdded = true;
  }

  /** 摘掉 ticker 回调 */
  removeTickerListener(): void {
    if (!this._tickerAdded) {
      return;
    }

    Ticker.system.remove(this._tickerUpdate, this);

    this._tickerAdded = false;
  }

  /** 用户刚移动过指针,本轮不必补发 */
  pointerMoved(): void {
    this._didMove = true;
  }

  /** 补发一次 pointermove */
  private _update(): void {
    if (!this.domElement || this._pauseUpdate) {
      return;
    }

    // 用户移动过指针,命中检查已经随那次移动做过了
    if (this._didMove) {
      this._didMove = false;

      return;
    }

    // eslint-disable-next-line dot-notation
    const rootPointerEvent = this.events['_rootPointerEvent'];

    if (this.events.supportsTouchEvents && (rootPointerEvent as PointerEvent).pointerType === 'touch') {
      return;
    }

    globalThis.document.dispatchEvent(
      this.events.supportsPointerEvents
        ? new PointerEvent('pointermove', {
          clientX: rootPointerEvent.clientX,
          clientY: rootPointerEvent.clientY,
          pointerType: rootPointerEvent.pointerType,
          pointerId: rootPointerEvent.pointerId,
        })
        : new MouseEvent('mousemove', {
          clientX: rootPointerEvent.clientX,
          clientY: rootPointerEvent.clientY,
        }),
    );
  }

  /**
   * 距上次至少 `interactionFrequency` 帧才补发。由 `Ticker.system` 调用。
   * @param ticker - system ticker
   */
  private _tickerUpdate(ticker: Ticker): void {
    this._deltaTime += ticker.deltaTime;

    if (this._deltaTime < this.interactionFrequency) {
      return;
    }

    this._deltaTime = 0;

    this._update();
  }

  /** 销毁 */
  destroy(): void {
    this.removeTickerListener();
    this.events = null!;
    this.domElement = null!;
    this._deltaTime = 0;
    this._didMove = false;
    this._tickerAdded = false;
    this._pauseUpdate = true;
  }
}

/** 指针静止过久时自动补发 PointerEvent,保证移动中的物体仍被命中测试(单例,照 Pixi) */
export const EventsTicker = new EventsTickerClass();
