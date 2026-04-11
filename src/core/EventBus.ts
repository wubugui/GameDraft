type EventCallback = (payload?: any) => void;

export class EventBus {
  private listeners: Map<string, Set<EventCallback>> = new Map();

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
}
