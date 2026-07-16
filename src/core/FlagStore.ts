import type { Condition, ConditionExpr } from '../data/types';
import type { EventBus } from './EventBus';
import type { ConditionEvalContext } from '../systems/graphDialogue/evaluateGraphCondition';
import { evaluateConditionExprList } from '../systems/graphDialogue/conditionEvalBridge';

/** 运行时 Flag 取值 */
export type FlagValue = boolean | number | string;

/** One static flag key + value kind (tools / documentation; runtime only needs key set). */
export type FlagRegistryStaticEntry = { key: string; valueType: 'bool' | 'float' | 'string' };

/** Shape of public/assets/data/flag_registry.json. */
export interface FlagRegistryJson {
  /** Unified list: each entry has key + valueType (legacy string[] is normalized on editor load). */
  static?: Array<string | FlagRegistryStaticEntry>;
  patterns?: {
    prefix: string;
    suffix?: string;
    valueType?: 'bool' | 'float' | 'string';
    [k: string]: unknown;
  }[];
  migrations?: Record<string, string>;
  runtime?: {
    warnUnknownInDev?: boolean;
    stripUnknown?: boolean;
  };
}

type PatternDef = { prefix: string; suffix?: string; valueType: 'bool' | 'float' | 'string' };

type RegistryRuntime = {
  staticKeys: Set<string>;
  /** 登记表静态条目的值类型 */
  staticTypes: Map<string, 'bool' | 'float' | 'string'>;
  patterns: PatternDef[];
  migrations: Record<string, string>;
  stripUnknown: boolean;
  warnUnknown: boolean;
};

function normStaticVt(raw: unknown): 'bool' | 'float' | 'string' {
  if (raw === 'float' || raw === 'int') return 'float';
  if (raw === 'string' || raw === 'str') return 'string';
  return 'bool';
}

export class FlagStore {
  private flags: Map<string, FlagValue> = new Map();
  private eventBus: EventBus;
  private registryRuntime: RegistryRuntime | null = null;
  private conditionCtxFactory: (() => ConditionEvalContext) | null = null;
  /** 已告警过的非法条件运算符（去重，防每帧刷屏） */
  private warnedInvalidOps: Set<string> = new Set();

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  /**
   * 与 QuestManager / InteractionSystem 等一致：注入后 {@link checkConditions} 对 ConditionExpr[] 走统一求值。
   */
  setConditionEvalContextFactory(factory: (() => ConditionEvalContext) | null): void {
    this.conditionCtxFactory = factory;
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
    const staticTypes = new Map<string, 'bool' | 'float' | 'string'>();
    for (const e of staticList) {
      if (typeof e === 'string') {
        if (e) {
          staticKeys.push(e);
          staticTypes.set(e, 'bool');
        }
      } else if (e && typeof e === 'object' && typeof e.key === 'string' && e.key) {
        staticKeys.push(e.key);
        staticTypes.set(e.key, normStaticVt(e.valueType));
      }
    }
    this.registryRuntime = {
      staticKeys: new Set(staticKeys),
      staticTypes,
      patterns: (data.patterns ?? []).map(p => ({
        prefix: p.prefix,
        suffix: p.suffix,
        valueType: normStaticVt(p.valueType),
      })),
      migrations: data.migrations ?? {},
      stripUnknown: !!rt.stripUnknown,
      warnUnknown: rt.warnUnknownInDev !== false,
    };
  }

  private patternDefinesKey(key: string, p: { prefix: string; suffix?: string }): boolean {
    if (p.suffix) {
      return (
        key.startsWith(p.prefix) &&
        key.endsWith(p.suffix) &&
        key.length > p.prefix.length + p.suffix.length
      );
    }
    return key.startsWith(p.prefix) && key.length > p.prefix.length;
  }

  private isKeyAllowed(key: string, r: RegistryRuntime): boolean {
    if (r.staticKeys.has(key)) return true;
    for (const p of r.patterns) {
      if (this.patternDefinesKey(key, p)) return true;
    }
    return false;
  }

  /**
   * 是否命中登记表 static 或 patterns（形状匹配，不校验 pattern 内 id 是否存在）。
   * 未配置登记表时返回 true（无法校验）。
   */
  isKeyAllowedByRegistry(key: string): boolean {
    const r = this.registryRuntime;
    if (!r) return true;
    return this.isKeyAllowed(key.trim(), r);
  }

  /**
   * 调试面板：登记表静态键 + 当前内存中已存在的键（含动态 pattern键）。
   */
  getDebugPickableKeys(): string[] {
    const s = new Set<string>();
    if (this.registryRuntime) {
      for (const k of this.registryRuntime.staticKeys) s.add(k);
    }
    for (const k of this.flags.keys()) s.add(k);
    return [...s].sort((a, b) => a.localeCompare(b));
  }

  /** 调试写入时判断控件类型 */
  getDebugValueKind(key: string): 'bool' | 'float' | 'string' {
    const r = this.registryRuntime;
    if (r?.staticTypes.has(key)) return r.staticTypes.get(key)!;
    if (r) {
      for (const p of r.patterns) {
        if (this.patternDefinesKey(key, p)) return p.valueType;
      }
    }
    const v = this.flags.get(key);
    if (typeof v === 'number') return 'float';
    if (typeof v === 'string') return 'string';
    return 'bool';
  }

  /**
   * 仅依据登记表（static + patterns）解析键的类型；未命中则 null。
   */
  getRegistryValueType(key: string): 'bool' | 'float' | 'string' | null {
    const r = this.registryRuntime;
    if (!r) return null;
    if (r.staticTypes.has(key)) return r.staticTypes.get(key)!;
    for (const p of r.patterns) {
      if (this.patternDefinesKey(key, p)) return p.valueType;
    }
    return null;
  }

  /**
   * 在登记表中 valueType 为 string 的 flag 末尾追加文本；否则拒绝（console.warn）。
   * 当前值非 string 时先 String再拼（仅在校验已通过后用于容错）。
   */
  appendStringFlag(key: string, fragment: string): void {
    const vt = this.getRegistryValueType(key);
    if (vt !== 'string') {
      if (this.registryRuntime) {
        console.warn(
          `[appendFlag] key ${JSON.stringify(key)} 在登记表中不是 string 类型（${vt ?? '未登记'}），已跳过`,
        );
      } else {
        console.warn('[appendFlag] 未配置 flag 登记表，无法校验 string 类型，已跳过');
      }
      return;
    }
    const add = String(fragment ?? '');
    const cur = this.get(key);
    const base = typeof cur === 'string' ? cur : cur === undefined ? '' : String(cur);
    this.set(key, base + add);
  }

  /**
   * 在登记表中 valueType 为 float 的 flag 上做数值累加；非数值登记类型（或未登记 / 未配置登记表）
   * 时拒绝写入（console.warn），与 {@link appendStringFlag} 的校验口径一致。
   * 当前值非有限数字（含未设置）按 0 处理。供 ActionExecutor.addFlagValue 接线使用。
   */
  addNumericFlag(key: string, delta: number): void {
    const vt = this.getRegistryValueType(key);
    if (vt !== 'float') {
      if (this.registryRuntime) {
        console.warn(
          `[addFlagValue] key ${JSON.stringify(key)} 在登记表中不是数值类型（${vt ?? '未登记'}），已跳过`,
        );
      } else {
        console.warn('[addFlagValue] 未配置 flag 登记表，无法校验数值类型，已跳过');
      }
      return;
    }
    if (typeof delta !== 'number' || !Number.isFinite(delta)) {
      console.warn(`[addFlagValue] delta 须为有限数字: ${String(delta)}`);
      return;
    }
    const cur = this.get(key);
    const base = typeof cur === 'number' && Number.isFinite(cur) ? cur : 0;
    this.set(key, base + delta);
  }

  set(key: string, value: FlagValue): void {
    // 空/纯空白键拒写（与 addFlagValue/appendStringFlag 的入口校验口径对齐）：
    // 空键一旦写入会随存档序列化扩散，且任何条件都读不到它——只会是数据笔误。
    if (typeof key !== 'string' || !key.trim()) {
      console.warn(`FlagStore.set: 忽略空 flag 键（value=${JSON.stringify(value)}）`);
      return;
    }
    const prev = this.flags.get(key);
    this.flags.set(key, value);
    // 仅在值真正变化时广播：避免无意义的 flag:changed 触发各系统重评（读档时尤甚）。
    // 新建键（prev === undefined）视为变化。
    if (prev !== value) {
      this.eventBus.emit('flag:changed', { key, value });
    }
  }

  get(key: string): FlagValue | undefined {
    return this.flags.get(key);
  }

  /**
   * 若干 flag 条件逐项 AND（仅叶子，不经过 ConditionExpr 组合子）。
   * 供 {@link evaluateConditionExpr} 的 flag 叶子使用，避免 checkConditions 与求值器相互递归。
   */
  evalPureFlagConjunction(conditions: Condition[]): boolean {
    for (const cond of conditions) {
      const raw = this.flags.get(cond.flag);
      const op = cond.op ?? '==';
      const hasExplicit = cond.value !== undefined && cond.value !== null;
      const expected: FlagValue = hasExplicit ? (cond.value as FlagValue) : true;

      const defaultActual = (): FlagValue => {
        if (typeof expected === 'boolean') return false;
        if (typeof expected === 'number') return 0;
        if (typeof expected === 'string') return '';
        return false;
      };
      const actual: FlagValue = raw !== undefined ? raw : defaultActual();

      switch (op) {
        case '==':
          if (!this.looseEqual(actual, expected)) return false;
          break;
        case '!=':
          if (this.looseEqual(actual, expected)) return false;
          break;
        case '>':
          if (!this.compareOrder(actual, expected, '>')) return false;
          break;
        case '<':
          if (!this.compareOrder(actual, expected, '<')) return false;
          break;
        case '>=':
          if (!this.compareOrder(actual, expected, '>=')) return false;
          break;
        case '<=':
          if (!this.compareOrder(actual, expected, '<=')) return false;
          break;
        default: {
          // fail-closed：未知运算符（如 '===' 笔误）判整组不满足，而非静默跳过恒真。
          const opKey = String(op);
          if (!this.warnedInvalidOps.has(opKey)) {
            this.warnedInvalidOps.add(opKey);
            console.warn(`[FlagStore] 条件包含未知运算符 ${JSON.stringify(opKey)}（flag=${cond.flag}），该条件按不满足处理`);
          }
          return false;
        }
      }
    }
    return true;
  }

  private isFlagOnlyAtom(c: ConditionExpr): c is Condition {
    if (!c || typeof c !== 'object') return false;
    const o = c as Record<string, unknown>;
    if (typeof o.flag !== 'string') return false;
    const keys = Object.keys(o);
    return keys.every((k) => k === 'flag' || k === 'op' || k === 'value');
  }

  /**
   * 对条件列表做组内 AND，语义与热区/任务等一致。
   * 已注入 {@link setConditionEvalContextFactory} 时与图对话共用 `evaluateConditionExpr`；
   * 否则仅在每项均为纯 flag 叶子时可求值，否则 dev 下告警并视为不满足。
   */
  checkConditions(conditions: ConditionExpr[] | Condition[]): boolean {
    if (!conditions.length) return true;
    const ctx = this.conditionCtxFactory?.();
    if (ctx) {
      return evaluateConditionExprList(conditions as ConditionExpr[], ctx);
    }
    const isDev = typeof import.meta !== 'undefined' && import.meta.env?.DEV === true;
    for (const c of conditions) {
      if (!this.isFlagOnlyAtom(c as ConditionExpr)) {
        if (isDev) {
          console.warn(
            '[FlagStore.checkConditions] 缺少 ConditionEvalContext，无法对非 flag 条件求值',
            c,
          );
        }
        return false;
      }
    }
    return this.evalPureFlagConjunction(conditions as Condition[]);
  }

  private looseEqual(a: FlagValue, b: FlagValue): boolean {
    if (a === b) return true;
    if (typeof a === 'string' || typeof b === 'string') {
      return String(a) === String(b);
    }
    return this.toNum(a as boolean | number) === this.toNum(b as boolean | number);
  }

  private toNum(v: FlagValue): number {
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'number') return v;
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  }

  /** 数值可比较时按数值比，否则按字符串字典序 */
  private compareOrder(a: FlagValue, b: FlagValue, op: '>' | '<' | '>=' | '<='): boolean {
    const na = this.toNum(a);
    const nb = this.toNum(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) {
      switch (op) {
        case '>': return na > nb;
        case '<': return na < nb;
        case '>=': return na >= nb;
        case '<=': return na <= nb;
      }
    }
    const sa = String(a);
    const sb = String(b);
    const c = sa < sb ? -1 : sa > sb ? 1 : 0;
    switch (op) {
      case '>': return c > 0;
      case '<': return c < 0;
      case '>=': return c >= 0;
      case '<=': return c <= 0;
    }
  }

  serialize(): Record<string, FlagValue> {
    const data: Record<string, FlagValue> = {};
    this.flags.forEach((v, k) => { data[k] = v; });
    return data;
  }

  deserialize(data: Record<string, FlagValue>): void {
    const r = this.registryRuntime;
    const isDev = typeof import.meta !== 'undefined' && import.meta.env?.DEV === true;
    this.flags.clear();
    for (const [rawKey, v] of Object.entries(data)) {
      let k = rawKey;
      // 历史存档可能残留空键（旧版 set 未拒写）：任何条件都读不到空键，直接丢弃洗档
      if (!k.trim()) {
        console.warn('[FlagStore] 存档含空 flag 键，已丢弃');
        continue;
      }
      if (r && r.migrations && k in r.migrations) {
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
    // eventBus 为构造注入依赖，生命周期由装配层（Game）管理，此处只清本实例持有的状态/缓存。
    this.flags.clear();
    this.warnedInvalidOps.clear();
    this.registryRuntime = null;
    this.conditionCtxFactory = null;
  }
}
