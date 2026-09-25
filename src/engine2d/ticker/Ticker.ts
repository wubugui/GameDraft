/**
 * 帧驱动(照 Pixi `Ticker`,算法逐行对应):按优先级排队的回调链,requestAnimationFrame 驱动。
 * `deltaTime` 以 60fps 为 1;`deltaMS` 受 `speed` 与 `minFPS`(最大间隔)夹取。
 */
export enum UPDATE_PRIORITY {
  INTERACTION = 50,
  HIGH = 25,
  NORMAL = 0,
  LOW = -25,
  UTILITY = -50,
}

export type TickerCallback<T> = (this: T, ticker: Ticker) => unknown;

class TickerListener<T = unknown> {
  next: TickerListener | null = null;
  previous: TickerListener | null = null;
  private _destroyed = false;
  private _fn: TickerCallback<T> | null;
  private _context: T | null;
  readonly priority: number;
  private readonly _once: boolean;

  constructor(fn: TickerCallback<T> | null, context: T | null = null, priority = 0, once = false) {
    this._fn = fn;
    this._context = context;
    this.priority = priority;
    this._once = once;
  }

  match(fn: TickerCallback<T>, context: T | null = null): boolean {
    return this._fn === fn && this._context === context;
  }

  emit(ticker: Ticker): TickerListener | null {
    if (this._fn) {
      if (this._context) this._fn.call(this._context, ticker);
      else (this._fn as (t: Ticker) => unknown)(ticker);
    }
    const redirect = this.next;
    if (this._once) this.destroy(true);
    if (this._destroyed) this.next = null;
    return redirect;
  }

  connect(previous: TickerListener): void {
    this.previous = previous;
    if (previous.next) previous.next.previous = this as TickerListener;
    this.next = previous.next;
    previous.next = this as TickerListener;
  }

  destroy(hard = false): TickerListener | null {
    this._destroyed = true;
    this._fn = null;
    this._context = null;
    if (this.previous) this.previous.next = this.next;
    if (this.next) this.next.previous = this.previous;
    const redirect = this.next;
    this.next = hard ? null : redirect;
    this.previous = null;
    return redirect;
  }
}

export class Ticker {
  static targetFPMS = 0.06;
  private static _shared?: Ticker;
  private static _system?: Ticker;

  autoStart = false;
  deltaTime = 1;
  deltaMS: number;
  elapsedMS: number;
  lastTime = -1;
  speed = 1;
  started = false;
  private _requestId: number | null = null;
  private _maxElapsedMS = 100;
  private _minElapsedMS = 0;
  private _protected = false;
  private _lastFrame = -1;
  private _head: TickerListener | null = new TickerListener<unknown>(null, null, Infinity);
  private readonly _tick: (time: number) => void;

  constructor() {
    this.deltaMS = 1 / Ticker.targetFPMS;
    this.elapsedMS = 1 / Ticker.targetFPMS;
    this._tick = (time: number) => {
      this._requestId = null;
      if (this.started) {
        this.update(time);
        if (this.started && this._requestId === null && this._head?.next) {
          this._requestId = requestAnimationFrame(this._tick);
        }
      }
    };
  }

  private _requestIfNeeded(): void {
    if (this._requestId === null && this._head?.next) {
      this.lastTime = performance.now();
      this._lastFrame = this.lastTime;
      this._requestId = requestAnimationFrame(this._tick);
    }
  }

  private _cancelIfNeeded(): void {
    if (this._requestId !== null) {
      cancelAnimationFrame(this._requestId);
      this._requestId = null;
    }
  }

  private _startIfPossible(): void {
    if (this.started) this._requestIfNeeded();
    else if (this.autoStart) this.start();
  }

  add<T = unknown>(fn: TickerCallback<T>, context?: T, priority: number = UPDATE_PRIORITY.NORMAL): this {
    return this._addListener(new TickerListener(fn, context ?? null, priority) as TickerListener);
  }

  addOnce<T = unknown>(fn: TickerCallback<T>, context?: T, priority: number = UPDATE_PRIORITY.NORMAL): this {
    return this._addListener(new TickerListener(fn, context ?? null, priority, true) as TickerListener);
  }

  private _addListener(listener: TickerListener): this {
    let current = this._head!.next;
    let previous = this._head!;
    if (!current) listener.connect(previous);
    else {
      while (current) {
        if (listener.priority > current.priority) {
          listener.connect(previous);
          break;
        }
        previous = current;
        current = current.next;
      }
      if (!listener.previous) listener.connect(previous);
    }
    this._startIfPossible();
    return this;
  }

  remove<T = unknown>(fn: TickerCallback<T>, context?: T): this {
    let listener = this._head!.next;
    while (listener) {
      if (listener.match(fn as TickerCallback<unknown>, context ?? null)) listener = listener.destroy();
      else listener = listener.next;
    }
    if (!this._head!.next) this._cancelIfNeeded();
    return this;
  }

  get count(): number {
    if (!this._head) return 0;
    let count = 0;
    let current: TickerListener | null = this._head;
    while ((current = current.next)) count++;
    return count;
  }

  start(): void {
    if (!this.started) {
      this.started = true;
      this._requestIfNeeded();
    }
  }

  stop(): void {
    if (this.started) {
      this.started = false;
      this._cancelIfNeeded();
    }
  }

  destroy(): void {
    if (this._protected) return;
    this.stop();
    let listener = this._head!.next;
    while (listener) listener = listener.destroy(true);
    this._head!.destroy();
    this._head = null;
  }

  update(currentTime: number = performance.now()): void {
    let elapsedMS: number;
    if (currentTime > this.lastTime) {
      elapsedMS = this.elapsedMS = currentTime - this.lastTime;
      if (elapsedMS > this._maxElapsedMS) elapsedMS = this._maxElapsedMS;
      elapsedMS *= this.speed;
      if (this._minElapsedMS) {
        const delta = (currentTime - this._lastFrame) | 0;
        if (delta < this._minElapsedMS) return;
        this._lastFrame = currentTime - (delta % this._minElapsedMS);
      }
      this.deltaMS = elapsedMS;
      this.deltaTime = this.deltaMS * Ticker.targetFPMS;
      const head = this._head!;
      let listener = head.next;
      while (listener) listener = listener.emit(this);
      if (!head.next) this._cancelIfNeeded();
    } else {
      this.deltaTime = this.deltaMS = this.elapsedMS = 0;
    }
    this.lastTime = currentTime;
  }

  get FPS(): number {
    return 1000 / this.elapsedMS;
  }

  get minFPS(): number {
    return 1000 / this._maxElapsedMS;
  }
  set minFPS(fps: number) {
    const minFPMS = Math.min(Math.max(0, fps) / 1000, Ticker.targetFPMS);
    this._maxElapsedMS = 1 / minFPMS;
    if (this._minElapsedMS && fps > this.maxFPS) this.maxFPS = fps;
  }

  get maxFPS(): number {
    return this._minElapsedMS ? Math.round(1000 / this._minElapsedMS) : 0;
  }
  set maxFPS(fps: number) {
    if (fps === 0) this._minElapsedMS = 0;
    else {
      if (fps < this.minFPS) this.minFPS = fps;
      this._minElapsedMS = 1 / (fps / 1000);
    }
  }

  static get shared(): Ticker {
    if (!Ticker._shared) {
      const t = (Ticker._shared = new Ticker());
      t.autoStart = true;
      t._protected = true;
    }
    return Ticker._shared;
  }

  static get system(): Ticker {
    if (!Ticker._system) {
      const t = (Ticker._system = new Ticker());
      t.autoStart = true;
      t._protected = true;
    }
    return Ticker._system;
  }
}
