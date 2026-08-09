/**
 * 校验面板的「同构图重复告警聚合」。
 *
 * 为什么必须有：模板盖章 100 个箱子 = 100 张同构 wrapper 图，任何一条图级毛病
 * （草稿信号、私有信号监听没绑 owner、悬空引用……）都会**逐图各报一遍**。
 * 100 行一模一样的话把面板冲垮，真正独一份的那条问题反而被埋掉——
 * 面板读不了，等于没有面板。
 *
 * 聚合判据（取严，宁可不合并也不合错）：
 * 1. 同一个 `code`；
 * 2. 归属图的**完整形状指纹**相同（含信号名与动作类型，见 graphShapeFingerprint）；
 * 3. 把消息/路径里的图 id、状态 id、转移 id 换成位置记号之后**逐字相同**。
 *
 * 第 3 条是关键：盖章产物的 id 各不相同（`箱子07_opened`），不做记号替换就永远合不到一起；
 * 而只做替换不比形状，又会把两张碰巧同 code 的无关图合并。两条都要。
 *
 * 代表行取**第一条**（列表序 = 校验器产出序，稳定），点它仍然定位到那一个具体实例——
 * 聚合只改「显示成几行」，不改「点了去哪」。
 */
import { compileGraphs } from '../editorModel';
import { graphShapeFingerprint } from '../canvas/wrapperAutoGroups';
import type { NarrativeGraphDef, NarrativeGraphsFileDef, ValidationIssueDef } from '../types';

export interface AggregatedIssue {
  /** 代表行：原封不动的第一条，点击定位仍落到这一个真实实例 */
  issue: ValidationIssueDef;
  /** 同款总条数（含代表行）。1 = 没有被聚合，照常单行显示 */
  count: number;
  /** 被折叠掉的其余条目（代表行除外），供 tooltip 列出「还有谁」 */
  duplicates: ValidationIssueDef[];
  /** 涉及的图 id（去重、保持出现序），tooltip 用 */
  graphIds: string[];
}

/** 一张图的 id 记号表：图 id → `<G>`，状态/转移 id → `<S0>`/`<T0>`（按插入序）。 */
function tokenMapForGraph(graph: NarrativeGraphDef): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  const gid = String(graph.id ?? '').trim();
  if (gid) pairs.push([gid, '␟G']);
  Object.keys(graph.states ?? {}).forEach((sid, i) => {
    const trimmed = String(sid ?? '').trim();
    if (trimmed) pairs.push([trimmed, `␟S${i}`]);
  });
  (graph.transitions ?? []).forEach((t, i) => {
    const tid = String(t?.id ?? '').trim();
    if (tid) pairs.push([tid, `␟T${i}`]);
  });
  // 长的先替换：状态 id 常是图 id 的后缀/前缀，短的先换会把长的切碎，
  // 于是两个本该相同的消息替换后反而不同（聚合静默失效，最难查的那种）。
  return pairs.sort((a, b) => b[0].length - a[0].length);
}

function escapeRegExp(raw: string): string {
  return raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 标识符字符（ASCII 词字符 + CJK）。id 只在**两侧都不是标识符字符**时才替换。
 *
 * 不加这道边界会真的出事：状态 id 只有一个字母（`a`）时，裸子串替换会把路径里的
 * `states` 切成 `st␟S1tes`——两条本该合并的告警从此永远合不上，而且没有任何报错，
 * 只表现为"聚合好像没生效"。取 CJK 也算标识符字符是**宁紧勿松**：
 * 紧了顶多不合并（面板多几行），松了会把两个不同的问题合成一条（说错话）。
 */
const ID_CHAR = '0-9A-Za-z_\\u3400-\\u4DBF\\u4E00-\\u9FFF\\uF900-\\uFAFF';

function applyTokens(text: string, tokens: Array<[string, string]>): string {
  let out = text;
  for (const [from, to] of tokens) {
    const pattern = new RegExp(`(?<![${ID_CHAR}])${escapeRegExp(from)}(?![${ID_CHAR}])`, 'g');
    out = out.replace(pattern, to);
  }
  return out;
}

/** 这条问题长在哪张图上（`target.graphId` 最准；退而求其次从 path 的首段取）。 */
function graphIdOfIssue(issue: ValidationIssueDef, knownGraphIds: ReadonlySet<string>): string {
  const fromTarget = issue.target && 'graphId' in issue.target
    ? String((issue.target as { graphId?: unknown }).graphId ?? '').trim()
    : '';
  if (fromTarget) return fromTarget;
  const head = String(issue.path ?? '').split('.')[0]?.trim() ?? '';
  return knownGraphIds.has(head) ? head : '';
}

/**
 * 把同构图上的同款重复告警合并成一条。
 * 不归属任何图的问题（signals 级、composition 级）原样单行返回——它们本来就只有一条。
 */
export function aggregateIsomorphicIssues(
  issues: readonly ValidationIssueDef[],
  data: NarrativeGraphsFileDef,
): AggregatedIssue[] {
  const graphById = new Map<string, NarrativeGraphDef>();
  for (const { graph } of compileGraphs(data)) {
    const gid = String(graph.id ?? '').trim();
    if (gid) graphById.set(gid, graph);
  }
  const tokenCache = new Map<string, Array<[string, string]>>();
  const shapeCache = new Map<string, string>();

  const order: string[] = [];
  const buckets = new Map<string, AggregatedIssue>();

  for (const issue of issues) {
    const graphId = graphIdOfIssue(issue, new Set(graphById.keys()));
    const graph = graphId ? graphById.get(graphId) : undefined;
    if (!graph) {
      // 不归图的问题：给一个必不撞车的 key，原样单行
      const key = `solo:${order.length}`;
      order.push(key);
      buckets.set(key, { issue, count: 1, duplicates: [], graphIds: [] });
      continue;
    }
    let tokens = tokenCache.get(graphId);
    if (!tokens) {
      tokens = tokenMapForGraph(graph);
      tokenCache.set(graphId, tokens);
    }
    let shape = shapeCache.get(graphId);
    if (shape === undefined) {
      shape = graphShapeFingerprint(graph);
      shapeCache.set(graphId, shape);
    }
    const key = [
      issue.severity,
      issue.code,
      shape,
      applyTokens(String(issue.message ?? ''), tokens),
      applyTokens(String(issue.path ?? ''), tokens),
    ].join('␞');
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.count += 1;
      bucket.duplicates.push(issue);
      if (!bucket.graphIds.includes(graphId)) bucket.graphIds.push(graphId);
    } else {
      order.push(key);
      buckets.set(key, { issue, count: 1, duplicates: [], graphIds: [graphId] });
    }
  }

  return order.map((key) => buckets.get(key)!).filter(Boolean);
}

/** 聚合行的 tooltip：说清合并了哪些图，别让人以为剩下的 99 条被吞了。 */
export function aggregatedIssueTitle(row: AggregatedIssue, fallback: string): string {
  if (row.count <= 1) return fallback;
  const shown = row.graphIds.slice(0, 8).join('、');
  const rest = row.graphIds.length > 8 ? ` 等 ${row.graphIds.length} 张图` : '';
  return `${row.count} 张同构图报了同一条问题：${shown}${rest}\n（点击定位到第一张；聚合只影响显示，不改校验结果）`;
}
