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
    this.listeners.get(event)?.forEach(cb => cb(payload));
  }

  clear(): void {
    this.listeners.clear();
  }
}
