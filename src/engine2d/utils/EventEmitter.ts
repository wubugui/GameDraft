/**
 * 与 eventemitter3 同语义的最小事件发射器(Pixi 的显示对象 / 纹理都继承它,调用方会用到 `on(evt, fn, ctx)`
 * 的第三个参数、`once`、`off(evt, fn, ctx)`、`removeAllListeners`、`listenerCount`)。
 * 发射时先拷一份监听表再逐个调:回调里增删监听不影响本次发射(与 eventemitter3 相同)。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fn = (...args: any[]) => void;

interface Listener {
  fn: Fn;
  ctx: unknown;
  once: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type EventMap = Record<string | symbol, any>;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export class EventEmitter<_Events extends EventMap = EventMap> {
  private _events: Map<string | symbol, Listener[]> | null = null;

  on(event: string | symbol, fn: Fn, context?: unknown): this {
    return this._add(event, fn as Fn, context, false);
  }

  addListener(event: string | symbol, fn: Fn, context?: unknown): this {
    return this._add(event, fn as Fn, context, false);
  }

  once(event: string | symbol, fn: Fn, context?: unknown): this {
    return this._add(event, fn as Fn, context, true);
  }

  off(event: string | symbol, fn?: Fn, context?: unknown, once?: boolean): this {
    return this.removeListener(event, fn, context, once);
  }

  removeListener(event: string | symbol, fn?: Fn, context?: unknown, once?: boolean): this {
    const list = this._events?.get(event);
    if (!list) return this;
    if (!fn) {
      this._events!.delete(event);
      return this;
    }
    // 照 eventemitter3:context 为假值(undefined / null / 0 / '')时不比上下文
    const kept = list.filter((l) => l.fn !== fn || (once && !l.once) || (context && l.ctx !== context));
    if (kept.length) this._events!.set(event, kept);
    else this._events!.delete(event);
    return this;
  }

  removeAllListeners(event?: string | symbol): this {
    if (!this._events) return this;
    if (event === undefined) this._events = null;
    else this._events.delete(event);
    return this;
  }

  emit(event: string | symbol, ...args: any[]): boolean {
    const list = this._events?.get(event);
    if (!list || list.length === 0) return false;
    const snapshot = list.slice();
    for (const l of snapshot) {
      if (l.once) this.removeListener(event, l.fn, l.ctx, true);
      l.fn.apply(l.ctx, args);
    }
    return true;
  }

  listenerCount(event: string | symbol): number {
    return this._events?.get(event)?.length ?? 0;
  }

  listeners(event: string | symbol): Fn[] {
    return (this._events?.get(event) ?? []).map((l) => l.fn);
  }

  eventNames(): Array<string | symbol> {
    return this._events ? [...this._events.keys()] : [];
  }

  private _add(event: string | symbol, fn: Fn, ctx: unknown, once: boolean): this {
    if (typeof fn !== 'function') throw new TypeError('The listener must be a function');
    this._events ??= new Map();
    let list = this._events.get(event);
    if (!list) this._events.set(event, (list = []));
    list.push({ fn, ctx: ctx || this, once }); // 照 eventemitter3 的 `context || emitter`
    return this;
  }
}
