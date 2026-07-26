/**
 * 规矩层图的命名约定（运行时侧唯一真相源）。
 *
 * 一条规矩的每一层各是一张叙事小图，id 约定为 `<ruleId>__<layer>`，全部收在
 * composition `rule_ledger` 下，由 rules.json 幂等生成（`./dev.sh sync-rule-graphs`）。
 *
 * 两条读法一次性覆盖全部语义：
 * - **`reached(入口版本)` = 掌握了这一层**（reached 单调只增，正好等于「知识学到了就不会忘」）
 * - **`active` = 现在信的是哪一版**（可来回改，正好等于「验证状态会变」）
 *
 * Python 侧同一份约定在 `tools/editor/shared/rule_graph_naming.py`，两边必须一致。
 */

/** 规矩的三层键。三层互相独立、无先后依赖——可以先会术后懂理。 */
export const RULE_LAYER_KEYS = ['xiang', 'li', 'shu'] as const;

/** 规矩层图所在的 composition id。 */
export const RULE_LEDGER_COMPOSITION_ID = 'rule_ledger';

/** 层图初态：没听说过这一层。 */
export const RULE_LAYER_INITIAL_STATE = '未闻';

/** 层图入口版本：刚学到、还没验证。`reached` 它 ≡ 掌握了这一层。 */
export const RULE_LAYER_ENTRY_STATE = '未验';

const LAYER_SEP = '__';

export function ruleLayerGraphId(ruleId: string, layer: string): string {
  return `${String(ruleId ?? '').trim()}${LAYER_SEP}${String(layer ?? '').trim()}`;
}

export function parseRuleLayerGraphId(graphId: string): { ruleId: string; layer: string } | null {
  const text = String(graphId ?? '').trim();
  for (const layer of RULE_LAYER_KEYS) {
    const suffix = `${LAYER_SEP}${layer}`;
    if (text.endsWith(suffix) && text.length > suffix.length) {
      return { ruleId: text.slice(0, -suffix.length), layer };
    }
  }
  return null;
}

export function isRuleLayerGraphId(graphId: string): boolean {
  return parseRuleLayerGraphId(graphId) !== null;
}

/**
 * 推进某层到某个版本的规范信号。
 * 按**目标版本**命名（不是按边）——所以一条 `→验成` 能从「未验」「存疑」等多个前驱同时收，
 * 生成器据此从所有合法前驱各连一条边，`advanceRule` 因而永远不会因为"当前不在预期前驱"而静默失效。
 */
export function ruleAdvanceSignal(ruleId: string, layer: string, to: string): string {
  return `rule:${String(ruleId ?? '').trim()}:${String(layer ?? '').trim()}:${String(to ?? '').trim()}`;
}
