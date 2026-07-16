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

/** 事件 payload 若把自身投影成轻量、可序列化的 trace 数据，实现本接口。
 *  根治手段：canonicalizer 遇到活对象**只走这个接口 / 退化成标签**，绝不深拷贝其对象图。 */
export interface TraceProjectable {
  toTraceJSON(): unknown;
}

/** 单条 trace 条目 canonical 形态的字符预算上限（兜底安全阀，防超大**纯数据**数组/字符串）。
 *  真正的根治是下面「拒绝深拷贝活对象」——某些事件（如 `hotspot:triggered`）把运行时实体
 *  活对象塞进 payload，旧逻辑顺 `container.parent → 场景舞台 → 全部子实体` 摊开整棵对象树，
 *  单条就吐出上兆字节，撑爆 runtime-debug-snapshot 的 2MB 上限被服务端 413 拒收 + 主线程卡顿。 */
const TRACE_ENTRY_MAX_CHARS = 4000;

/** 纯数据对象（POJO / Object.create(null)）才允许逐键序列化；类实例一律不深挖。 */
function isPlainDataObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function canonicalizeTraceValue(
  value: unknown,
  depth = 8,
  seen = new WeakSet<object>(),
  budget: { left: number } = { left: TRACE_ENTRY_MAX_CHARS },
): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    if (value.length > budget.left) {
      const slice = value.slice(0, Math.max(0, budget.left));
      budget.left = 0;
      return `${slice}…<truncated ${value.length} chars>`;
    }
    budget.left -= value.length;
    return value;
  }
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return null;
  if (depth <= 0) return '<max-depth>';
  if (budget.left <= 0) return '<truncated>';
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      if (budget.left <= 0) {
        out.push('<truncated>');
        break;
      }
      out.push(canonicalizeTraceValue(item, depth - 1, seen, budget));
    }
    return out;
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return '<circular>';
    if (value instanceof Date) return value.toISOString();
    // 类实例（Hotspot / PIXI Container / Map / Set …）不是“数据”：禁止深拷贝其对象图。
    // 走它声明的 toTraceJSON() 接口拿到该吐的数据；没有就退化成 {__class, id?} 紧凑标签。
    // 这才是根治——从源头不去抄活对象，而非抄了再截断。
    if (!isPlainDataObject(value)) {
      const obj = value as Partial<TraceProjectable> & { id?: unknown; size?: unknown };
      if (typeof obj.toTraceJSON === 'function') {
        seen.add(value);
        const projected = canonicalizeTraceValue(obj.toTraceJSON(), depth - 1, seen, budget);
        seen.delete(value);
        return projected;
      }
      const ctor = (value as { constructor?: { name?: string } }).constructor;
      const tag: Record<string, unknown> = { __class: ctor?.name || 'Object' };
      if (typeof obj.id === 'string' || typeof obj.id === 'number') tag.id = obj.id;
      if ((value instanceof Map || value instanceof Set) && typeof obj.size === 'number') {
        tag.size = obj.size;
      }
      return tag;
    }
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (budget.left <= 0) {
        result['<truncated>'] = true;
        break;
      }
      const child = (value as Record<string, unknown>)[key];
      if (typeof child === 'function' || typeof child === 'symbol' || child === undefined) continue;
      budget.left -= key.length;
      result[key] = canonicalizeTraceValue(child, depth - 1, seen, budget);
    }
    seen.delete(value);
    return result;
  }
  return String(value);
}

function cloneTraceValue(value: unknown): unknown {
  return canonicalizeTraceValue(value);
}
