import type {
  CompositionElementDef,
  NarrativeCategoriesFileDef,
  NarrativeCompositionDef,
  NarrativeGraphsFileDef,
} from '../types';

/**
 * 「整理分组」纯函数：编辑器专用分组标签的读/写/分组/清理。
 *
 * 这套标签只活在旁挂文件 narrative_categories.json 里，运行时永不加载，**绝不进
 * narrative_graphs.json**——与 NarrativeGraphDef.category「分类备注」（进 JSON、驱动运行时
 * 校验）毫无关系。全部函数无副作用、返回新对象，方便单测。
 */

export const UNCATEGORIZED_KEY = '';
export const UNCATEGORIZED_LABEL = '未分类';

export interface CategoryGroup<T> {
  /** 分组稳定 key：分类名；未分类为 ''。用于折叠状态记忆。 */
  key: string;
  /** 展示名：未分类显示「未分类」。 */
  label: string;
  isUncategorized: boolean;
  items: T[];
}

function cleanStr(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanAssign(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const k = cleanStr(key);
      const n = cleanStr(value);
      if (k && n) out[k] = n;
    }
  }
  return out;
}

/** 容错归一为标准形状（缺失/损坏 → 空注册表；strip、丢空值/空内层）。 */
export function normalizeCategoriesFile(raw: unknown): Required<NarrativeCategoriesFileDef> {
  const src = (raw && typeof raw === 'object' ? raw : {}) as NarrativeCategoriesFileDef;
  const compositions = cleanAssign(src.compositions);
  const subgraphs: Record<string, Record<string, string>> = {};
  if (src.subgraphs && typeof src.subgraphs === 'object') {
    for (const [compId, assign] of Object.entries(src.subgraphs)) {
      const cid = cleanStr(compId);
      if (!cid) continue;
      const inner = cleanAssign(assign);
      if (Object.keys(inner).length > 0) subgraphs[cid] = inner;
    }
  }
  return { schemaVersion: 1, compositions, subgraphs };
}

// --------------------------------------------------------------------------- //
// 读 / 写（不可变，返回新 file）
// --------------------------------------------------------------------------- //
export function getCompositionCategory(file: NarrativeCategoriesFileDef, compId: string): string {
  return cleanStr(file.compositions?.[compId]);
}

export function getSubgraphCategory(
  file: NarrativeCategoriesFileDef,
  compId: string,
  elementId: string,
): string {
  return cleanStr(file.subgraphs?.[compId]?.[elementId]);
}

export function setCompositionCategory(
  file: NarrativeCategoriesFileDef,
  compId: string,
  category: string,
): Required<NarrativeCategoriesFileDef> {
  const next = normalizeCategoriesFile(file);
  const name = cleanStr(category);
  if (name) next.compositions[compId] = name;
  else delete next.compositions[compId];
  return next;
}

export function setSubgraphCategory(
  file: NarrativeCategoriesFileDef,
  compId: string,
  elementId: string,
  category: string,
): Required<NarrativeCategoriesFileDef> {
  const next = normalizeCategoriesFile(file);
  const name = cleanStr(category);
  const inner = { ...(next.subgraphs[compId] ?? {}) };
  if (name) inner[elementId] = name;
  else delete inner[elementId];
  if (Object.keys(inner).length > 0) next.subgraphs[compId] = inner;
  else delete next.subgraphs[compId];
  return next;
}

// --------------------------------------------------------------------------- //
// 已有分类名建议（datalist 候选）
// --------------------------------------------------------------------------- //
function sortedUnique(names: Iterable<string>): string[] {
  return Array.from(new Set(Array.from(names, cleanStr).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b, 'zh-Hans-CN'),
  );
}

export function distinctCompositionCategories(file: NarrativeCategoriesFileDef): string[] {
  return sortedUnique(Object.values(file.compositions ?? {}));
}

/** 某 compose 内子图已用过的分类名（datalist 候选取本 compose 作用域）。 */
export function distinctSubgraphCategories(
  file: NarrativeCategoriesFileDef,
  compId: string,
): string[] {
  return sortedUnique(Object.values(file.subgraphs?.[compId] ?? {}));
}

// --------------------------------------------------------------------------- //
// 分组（命名分类按名排序在前，未分类殿后；组内保持原顺序）
// --------------------------------------------------------------------------- //
function groupBy<T>(items: T[], categoryOf: (item: T) => string): CategoryGroup<T>[] {
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const key = cleanStr(categoryOf(item));
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }
  const named = Array.from(buckets.keys())
    .filter((k) => k !== UNCATEGORIZED_KEY)
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  const groups: CategoryGroup<T>[] = named.map((key) => ({
    key,
    label: key,
    isUncategorized: false,
    items: buckets.get(key)!,
  }));
  const uncategorized = buckets.get(UNCATEGORIZED_KEY);
  if (uncategorized && uncategorized.length > 0) {
    groups.push({
      key: UNCATEGORIZED_KEY,
      label: UNCATEGORIZED_LABEL,
      isUncategorized: true,
      items: uncategorized,
    });
  }
  return groups;
}

export function groupCompositions(
  compositions: NarrativeCompositionDef[],
  file: NarrativeCategoriesFileDef,
): CategoryGroup<NarrativeCompositionDef>[] {
  return groupBy(compositions, (comp) => getCompositionCategory(file, comp.id));
}

export function groupSubgraphElements(
  elements: CompositionElementDef[],
  file: NarrativeCategoriesFileDef,
  compId: string,
): CategoryGroup<CompositionElementDef>[] {
  return groupBy(elements, (el) => getSubgraphCategory(file, compId, el.id));
}

// --------------------------------------------------------------------------- //
// 清理悬垂条目（对 web 内存里的实时数据 prune；保存前调，避开保存时序陷阱）
// --------------------------------------------------------------------------- //
export function pruneOrphans(
  file: NarrativeCategoriesFileDef,
  data: NarrativeGraphsFileDef,
): Required<NarrativeCategoriesFileDef> {
  const normalized = normalizeCategoriesFile(file);
  const compositions = data.compositions ?? [];
  const validCompIds = new Set(compositions.map((c) => c.id));
  const elementIdsByComp = new Map<string, Set<string>>();
  for (const comp of compositions) {
    elementIdsByComp.set(comp.id, new Set((comp.elements ?? []).map((el) => el.id)));
  }

  const outCompositions: Record<string, string> = {};
  for (const [compId, name] of Object.entries(normalized.compositions)) {
    if (validCompIds.has(compId)) outCompositions[compId] = name;
  }

  const outSubgraphs: Record<string, Record<string, string>> = {};
  for (const [compId, assign] of Object.entries(normalized.subgraphs)) {
    const validElementIds = elementIdsByComp.get(compId);
    if (!validElementIds) continue;
    const inner: Record<string, string> = {};
    for (const [elementId, name] of Object.entries(assign)) {
      if (validElementIds.has(elementId)) inner[elementId] = name;
    }
    if (Object.keys(inner).length > 0) outSubgraphs[compId] = inner;
  }

  return { schemaVersion: 1, compositions: outCompositions, subgraphs: outSubgraphs };
}
