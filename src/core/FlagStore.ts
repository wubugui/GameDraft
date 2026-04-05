import type { Condition } from '../data/types';
import type { EventBus } from './EventBus';

/** One static flag key + value kind (tools / documentation; runtime only needs key set). */
export type FlagRegistryStaticEntry = { key: string; valueType: 'bool' | 'float' };

/** Shape of public/assets/data/flag_registry.json. */
export interface FlagRegistryJson {
  /** Unified list: each entry has key + valueType (legacy string[] is normalized on editor load). */
  static?: Array<string | FlagRegistryStaticEntry>;
  patterns?: {
    prefix: string;
    suffix?: string;
    valueType?: 'bool' | 'float';
    [k: string]: unknown;
  }[];
  migrations?: Record<string, string>;
  runtime?: {
    warnUnknownInDev?: boolean;
    stripUnknown?: boolean;
  };
}

type RegistryRuntime = {
  staticKeys: Set<string>;
  patterns: { prefix: string; suffix?: string }[];
  migrations: Record<string, string>;
  stripUnknown: boolean;
  warnUnknown: boolean;
};

export class FlagStore {
  private flags: Map<string, boolean | number> = new Map();
  private eventBus: EventBus;
  private registryRuntime: RegistryRuntime | null = null;

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  /** Optional: enables save-time migrations / dev warnings / stripUnknown for deserialized keys. */
  configureRegistry(data: FlagRegistryJson | null): void {
    if (!data) {
      this.registryRuntime = null;
      return;
    }
    const rt = data.runtime ?? {};
    const staticList = data.static ?? [];
    const staticKeys: string[] = [];
    for (const e of staticList) {
      if (typeof e === 'string') {
        if (e) staticKeys.push(e);
      } else if (e && typeof e === 'object' && typeof e.key === 'string' && e.key) {
        staticKeys.push(e.key);
      }
    }
    this.registryRuntime = {
      staticKeys: new Set(staticKeys),
      patterns: (data.patterns ?? []).map(p => ({ prefix: p.prefix, suffix: p.suffix })),
      migrations: data.migrations ?? {},
      stripUnknown: !!rt.stripUnknown,
      warnUnknown: rt.warnUnknownInDev !== false,
    };
  }

  private isKeyAllowed(key: string, r: RegistryRuntime): boolean {
    if (r.staticKeys.has(key)) return true;
    for (const p of r.patterns) {
      if (p.suffix) {
        if (
          key.startsWith(p.prefix) &&
          key.endsWith(p.suffix) &&
          key.length > p.prefix.length + p.suffix.length
        ) {
          return true;
        }
      } else if (key.startsWith(p.prefix) && key.length > p.prefix.length) {
        return true;
      }
    }
    return false;
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
    const r = this.registryRuntime;
    const isDev = typeof import.meta !== 'undefined' && import.meta.env?.DEV === true;
    this.flags.clear();
    for (const [rawKey, v] of Object.entries(data)) {
      let k = rawKey;
      if (r?.migrations?.[k]) {
        k = r.migrations[k];
      }
      if (r && !this.isKeyAllowed(k, r)) {
        if (r.stripUnknown) continue;
        if (r.warnUnknown && isDev) {
          console.warn(`[FlagStore] unknown flag key in save: ${k}`);
        }
      }
      this.flags.set(k, v);
    }
  }

  destroy(): void {
    this.flags.clear();
  }
}
