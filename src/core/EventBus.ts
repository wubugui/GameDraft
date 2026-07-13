type EventCallback = (payload?: any) => void;

export type EventTraceEntry = {
  seq: number;
  event: string;
  payload: unknown;
};

export class EventBus {
  private listeners: Map<string, Set<EventCallback>> = new Map();
  private debugTraceEnabled = false;
  private debugTraceLimit = 1000;
  private debugTraceSeq = 0;
  private debugTrace: EventTraceEntry[] = [];

  on(event: string, callback: EventCallback): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);
  }

  off(event: string, callback: EventCallback): void {
    this.listeners.get(event)?.delete(callback);
  }

  emit(event: string, payload?: any): void {
    this.recordDebugTrace(event, payload);
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;
    const cbs = [...set];
    for (const cb of cbs) {
      try {
        cb(payload);
      } catch (e) {
        console.warn(`EventBus: listener for "${event}" threw`, e);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }

  enableDebugTrace(limit = 1000): void {
    this.debugTraceEnabled = true;
    this.debugTraceLimit = Math.max(1, Math.min(10_000, Math.trunc(limit) || 1000));
    if (this.debugTrace.length > this.debugTraceLimit) {
      this.debugTrace.splice(0, this.debugTrace.length - this.debugTraceLimit);
    }
  }

  disableDebugTrace(): void {
    this.debugTraceEnabled = false;
  }

  clearDebugTrace(): void {
    this.debugTraceSeq = 0;
    this.debugTrace = [];
  }

  getDebugTrace(): EventTraceEntry[] {
    return this.debugTrace.map((entry) => ({
      seq: entry.seq,
      event: entry.event,
      payload: cloneTraceValue(entry.payload),
    }));
  }

  private recordDebugTrace(event: string, payload: unknown): void {
    if (!this.debugTraceEnabled) return;
    this.debugTraceSeq += 1;
    this.debugTrace.push({
      seq: this.debugTraceSeq,
      event,
      payload: canonicalizeTraceValue(payload),
    });
    if (this.debugTrace.length > this.debugTraceLimit) {
      this.debugTrace.splice(0, this.debugTrace.length - this.debugTraceLimit);
    }
  }
}

function canonicalizeTraceValue(value: unknown, depth = 8, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return null;
  if (depth <= 0) return '<max-depth>';
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeTraceValue(item, depth - 1, seen));
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return '<circular>';
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (typeof child === 'function' || typeof child === 'symbol' || child === undefined) continue;
      result[key] = canonicalizeTraceValue(child, depth - 1, seen);
    }
    seen.delete(value);
    return result;
  }
  return String(value);
}

function cloneTraceValue(value: unknown): unknown {
  return canonicalizeTraceValue(value);
}
