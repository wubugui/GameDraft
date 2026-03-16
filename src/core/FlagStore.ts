import type { Condition } from '../data/types';
import type { EventBus } from './EventBus';

export class FlagStore {
  private flags: Map<string, boolean | number> = new Map();
  private eventBus: EventBus;

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  set(key: string, value: boolean | number): void {
    this.flags.set(key, value);
    this.eventBus.emit('flag:changed', { key, value });
  }

  get(key: string): boolean | number | undefined {
    return this.flags.get(key);
  }

  checkConditions(conditions: Condition[]): boolean {
    for (const cond of conditions) {
      const raw = this.flags.get(cond.flag);
      const expected = cond.value ?? true;
      const op = cond.op ?? '==';

      const actual = raw ?? (typeof expected === 'boolean' ? false : 0);

      switch (op) {
        case '==':
          if (!this.looseEqual(actual, expected)) return false;
          break;
        case '!=':
          if (this.looseEqual(actual, expected)) return false;
          break;
        case '>':
          if (this.toNum(actual) <= this.toNum(expected)) return false;
          break;
        case '<':
          if (this.toNum(actual) >= this.toNum(expected)) return false;
          break;
        case '>=':
          if (this.toNum(actual) < this.toNum(expected)) return false;
          break;
        case '<=':
          if (this.toNum(actual) > this.toNum(expected)) return false;
          break;
      }
    }
    return true;
  }

  private looseEqual(a: boolean | number, b: boolean | number): boolean {
    if (a === b) return true;
    return this.toNum(a) === this.toNum(b);
  }

  private toNum(v: boolean | number): number {
    return typeof v === 'boolean' ? (v ? 1 : 0) : v;
  }

  serialize(): Record<string, boolean | number> {
    const data: Record<string, boolean | number> = {};
    this.flags.forEach((v, k) => { data[k] = v; });
    return data;
  }

  deserialize(data: Record<string, boolean | number>): void {
    this.flags.clear();
    for (const [k, v] of Object.entries(data)) {
      this.flags.set(k, v);
    }
  }

  destroy(): void {
    this.flags.clear();
  }
}
