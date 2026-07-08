/**
 * 模板占位符填充工具。
 *
 * String.prototype.replace 的第二个参数若是字符串，`$` 会被当作特殊替换模式
 * 解释（`$&` = 匹配串、`$1` = 捕获组、`` $` `` = 匹配前文本、`$'` = 匹配后文本、
 * `$$` = 字面 `$`）。当替换值来自动态/玩家可见文本（可能含 `$`）时，直接传字符串
 * 会导致输出错乱。
 *
 * 这里改用「函数式替换串」：replace 的第二参为函数时，其返回值被逐字面插入，
 * `$` 不再触发任何特殊化，因此对不含 `$` 的普通中文文本行为与原来完全一致，
 * 只是消除了 `$` 被特殊解释的陷阱。
 */

/** 用字面值 value 替换 str 中首个 token（`$` 按字面处理，不做特殊替换）。 */
export function fillToken(str: string, token: string, value: string): string {
  // 函数式替换串：返回值被逐字面插入，`$` 不触发特殊替换模式。
  return str.replace(token, () => value);
}

/** 用 map 中的每个 token→value 依次做字面替换（各 token 首次出现，`$` 按字面处理）。 */
export function fillTemplate(str: string, map: Record<string, string>): string {
  let out = str;
  for (const [token, value] of Object.entries(map)) {
    out = fillToken(out, token, value);
  }
  return out;
}
