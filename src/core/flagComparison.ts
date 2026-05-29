import type { FlagValue } from './FlagStore';

/**
 * Flag 叶子比较的单一真相。
 *
 * 运行时（{@link FlagStore.evalPureFlagConjunction}）与工具侧模拟器
 * （tools/content_pipeline/explain_runtime.ts）共用这组纯函数，避免两处实现漂移。
 * 行为定义：数值可比较时按数值比较（boolean 视作 0/1），否则按字符串字典序。
 */

export type FlagCompareOp = '>' | '<' | '>=' | '<=';

/** boolean→0/1，number 原样，其余尝试 Number()，不可解析返回 NaN。 */
export function toFlagNum(v: FlagValue): number {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/** 宽松相等：任一为字符串则按字符串比，否则按数值比。 */
export function looseEqualFlag(a: FlagValue, b: FlagValue): boolean {
  if (a === b) return true;
  if (typeof a === 'string' || typeof b === 'string') {
    return String(a) === String(b);
  }
  return toFlagNum(a) === toFlagNum(b);
}

/** 数值可比较时按数值比，否则按字符串字典序。 */
export function compareFlagOrder(a: FlagValue, b: FlagValue, op: FlagCompareOp): boolean {
  const na = toFlagNum(a);
  const nb = toFlagNum(b);
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
