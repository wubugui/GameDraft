import type { FlagStore, FlagValue } from './FlagStore';

const TAG_STRING = /\[tag:string:([a-zA-Z0-9_.-]+):([a-zA-Z0-9_.-]+)\]/g;
const TAG_FLAG = /\[tag:flag:([^\]]+)\]/g;
const TAG_ITEM = /\[tag:item:([^\]]+)\]/g;

/** 与 StringsProvider.get 兼容 */
export type StringLookup = (
  category: string,
  key: string,
  vars?: Record<string, string | number>,
) => string;

export interface ExpandGameTagsOptions {
  strings: StringLookup;
  flagStore: FlagStore;
  /** 道具 id -> 显示名；缺省则 item 类 tag 保留原文 */
  itemNames?: ReadonlyMap<string, string>;
}

function formatFlagValue(
  v: FlagValue | undefined,
  strings: StringLookup,
): string {
  if (v === undefined) return strings('gameTags', 'flagUnset');
  if (typeof v === 'boolean') {
    return v ? strings('gameTags', 'flagTrue') : strings('gameTags', 'flagFalse');
  }
  if (typeof v === 'string') return v;
  return String(v);
}

/**
 * 将档案/书籍文本中的游戏 tag 展开为当前运行时文案。
 *
 * - `[tag:string:category:key]` → strings.json 对应条目（无变量插值）
 * - `[tag:flag:flagStoreKey]` → 当前 Flag 的布尔/数值可读形式
 * - `[tag:item:itemId]` → 道具显示名（需在 opts 中提供 itemNames）
 */
export function expandGameTags(raw: string, opts: ExpandGameTagsOptions): string {
  let out = raw.replace(TAG_STRING, (_m, cat: string, key: string) => {
    return opts.strings(String(cat), String(key));
  });
  out = out.replace(TAG_FLAG, (_m, flagKey: string) => {
    const k = String(flagKey).trim();
    return formatFlagValue(opts.flagStore.get(k), opts.strings);
  });
  out = out.replace(TAG_ITEM, (_m, itemId: string) => {
    const id = String(itemId).trim();
    const name = opts.itemNames?.get(id);
    if (name !== undefined && name !== '') return name;
    return opts.strings('gameTags', 'unknownItem', { id });
  });
  return out;
}
