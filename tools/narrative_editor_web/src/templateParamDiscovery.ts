/**
 * 抽取参数自动发现：扫一张现成作曲，找出「可参数化的值」并推导类型，
 * 让「从作曲创建模板」不必手抄样值 / 手选类型。
 *
 * 两层候选：
 * - ref  整值候选：出处即类型（dialogueBlackbox.refId → dialogueRef、state.activePlane → planeRef…），
 *   动作参数里的字符串再拿 catalog 的 id 清单反查兜底。
 * - token 公共 token 候选：图 id / ownerId / 信号名按分隔符切词，出现在 ≥2 个不同命名串里的
 *   token 就是「实例 id」形状（wrap_藏钱点A + 藏钱点A__已取 → 藏钱点A）——这正是模板
 *   {{taskId}} 前缀模式的逆向。
 *
 * 纯函数、无 DOM；样值替换语义与 Python extract_template 一致（整棵 JSON 子串替换），
 * 所以 occurrences 用整份序列化文本数出现次数 = 抽取真实会挖的洞数。
 */
import type {
  AuthoringCatalogDef,
  NarrativeAuthorSignalDef,
  NarrativeCompositionDef,
  NarrativeGraphDef,
  TemplateParamType,
} from './types';

export interface ParamCandidate {
  /** 建议参数名（表单里可改）。 */
  suggestedName: string;
  type: TemplateParamType;
  /** 样值 = 作曲里的真值，抽取时被替换成 {{name}}。 */
  sample: string;
  /** 整份作曲序列化文本里的出现次数（= 抽取会挖的洞数）。 */
  occurrences: number;
  /** 人读出处说明。 */
  provenance: string;
  /** 建议的批量盖章来源绑定（entity.id / entity.kind …）。 */
  suggestedFrom?: string;
  /** token = 实例 id 形状；ref = 整值引用。 */
  kind: 'token' | 'ref';
  /** 误伤名单：图里出现、且**严格包含**本样值的其它已登记 id（箱子1 之于 箱子11）。
   * 抽取是整树子串替换，这些 id 会被一并挖洞、盖章时替换成别的实体名 = 静默改坏引用。 */
  overMatches?: string[];
}

/** 目录里所有「已登记 id」清单——判样值误伤用（在别的资源 id 里嵌着 = 会被连带替换）。 */
const CATALOG_ID_KEYS: Array<keyof AuthoringCatalogDef> = [
  'dialogueGraphIds', 'scenarioIds', 'questIds', 'sceneIds', 'sceneEntityRefs',
  'sceneNpcRefs', 'sceneHotspotRefs', 'zoneRefs', 'minigameIds', 'cutsceneIds', 'planeIds',
];

/**
 * 剔掉误伤名单里的假阳性：抽取按**样值长度降序**依次替换，所以某个更长的样值只要
 * 是这条 id 的子串，这条 id 在轮到本样值之前就已经被挖成洞了，伤不到。
 *
 * 例：样值 `藏钱`（显示名）看似会伤 `主线s1藏钱点A`，但 ownerId 样值就是后者、且更长，
 * 先替换即整条变 `{{ownerId}}` —— 假阳性。而 `主线_藏钱`（对话图 id）没有更长样值罩着，
 * 是真会被改坏的那种。
 */
export function effectiveOverMatches(
  sample: string,
  hits: readonly string[],
  allSamples: readonly string[],
): string[] {
  const longer = allSamples.filter((s) => s && s !== sample && s.length > sample.length);
  return hits.filter((hit) => !longer.some((s) => hit.includes(s)));
}

/**
 * 本样值会连带改坏哪些**共享命名**：严格包含它、且确实出现在这张图里的那些。
 *
 * 两类共享命名：
 * - 目录里登记的 id（对话图 / 实体 / 场景 / 位面…）——被改坏 = 引用断了；
 * - 图里用到的**信号名**（`extraCorpus`）——被改坏 = 监听方等一个没人发的名字，那一跳永远不走，
 *   而且比断引用更隐蔽（校验器不查这种"改了名的新信号"）。
 *
 * 信号只对**非 entity.id** 的样值算误伤：作者本来就常把实例 id 写进信号名
 * （`藏钱点A__已取` 这种逐实例命名是正当模式），拿 ownerId 去挖它是**对的**；
 * 而拿显示名/类型去挖信号名一定是意外（`藏钱_取走` → `{{label}}_取走`）。
 */
function findOverMatches(
  sample: string,
  catalog: AuthoringCatalogDef,
  blob: string,
  signalCorpus: readonly string[] = [],
  signalsNeedBoundary = false,
): string[] {
  if (!sample) return [];
  const hits = new Set<string>();
  const consider = (raw: string, boundaryOnly: boolean) => {
    const id = String(raw ?? '').trim();
    if (!id || id === sample || !id.includes(sample) || !blob.includes(id)) return;
    if (boundaryOnly && !hasInteriorMatch(id, sample)) return;
    hits.add(id);
  };
  for (const key of CATALOG_ID_KEYS) {
    const list = catalog[key];
    if (!Array.isArray(list)) continue;
    for (const raw of list as string[]) consider(raw, false);
  }
  for (const raw of signalCorpus) consider(raw, signalsNeedBoundary);
  return [...hits].sort();
}

/** 名字里的分隔符：id 落在它们（或串首尾）之间 = 一个完整词，而不是撞进别人字中间。 */
const NAME_SEPARATORS = new Set(['_', '-', ':', '.', ' ', '/', '|']);

/**
 * `sample` 在 `text` 里有没有「撞进字中间」的出现。
 *
 * 逐实例信号名是正当模式：`藏钱点A__已取`（串首 + 后接分隔符）、`wrap_藏钱点A`
 * （前接分隔符 + 串尾）都是作者故意把实例 id 编进名字，拿 ownerId 去挖它**是对的**。
 * 而 `开门_完成` 里的「门」左边贴着「开」——那是撞的，挖了会造出没人发的幽灵信号。
 * 判据：两侧都得是串边界或分隔符，只要有一次出现不满足就算撞。
 */
function hasInteriorMatch(text: string, sample: string): boolean {
  let idx = text.indexOf(sample);
  while (idx !== -1) {
    const before = idx === 0 ? '' : text[idx - 1];
    const afterIdx = idx + sample.length;
    const after = afterIdx >= text.length ? '' : text[afterIdx];
    const leftOk = before === '' || NAME_SEPARATORS.has(before);
    const rightOk = after === '' || NAME_SEPARATORS.has(after);
    if (!leftOk || !rightOk) return true;
    idx = text.indexOf(sample, afterIdx);
  }
  return false;
}

/** 这张作曲里用到的全部信号名（含内嵌子图；reactive 占位与 __draft__ 不算）。 */
function collectSignalNames(composition: NarrativeCompositionDef): string[] {
  const out = new Set<string>();
  const eat = (g: NarrativeGraphDef | undefined) => {
    for (const tr of g?.transitions ?? []) {
      const trigger = tr.trigger ?? 'signal';
      if (trigger === 'signal' && tr.signal && tr.signal !== '__draft__') out.add(tr.signal);
    }
  };
  eat(composition.mainGraph);
  for (const el of composition.elements ?? []) {
    eat(el.graph);
    for (const emit of el.meta?.emits ?? []) {
      const id = String(emit ?? '').trim();
      if (id) out.add(id);
    }
  }
  return [...out];
}

/** 与批量盖章 BATCH_ENTITY_KINDS / 私有信号监听白名单同口径的实体 ownerType。 */
const ENTITY_OWNER_TYPES = new Set(['npc', 'hotspot', 'zone']);

/** 黑盒元素 kind → refId 的参数类型。 */
const ELEMENT_REF_TYPES: Record<string, TemplateParamType> = {
  dialogueBlackbox: 'dialogueRef',
  minigameBlackbox: 'minigameRef',
  cutsceneBlackbox: 'cutsceneRef',
  zoneBlackbox: 'zoneRef',
  scenarioSubgraph: 'scenarioRef',
};

/** catalog id 清单 → 参数类型（动作参数字符串反查兜底）。顺序即反查优先级。 */
const CATALOG_TYPE_LOOKUP: Array<[keyof AuthoringCatalogDef, TemplateParamType]> = [
  ['dialogueGraphIds', 'dialogueRef'],
  ['minigameIds', 'minigameRef'],
  ['cutsceneIds', 'cutsceneRef'],
  ['questIds', 'questRef'],
  ['sceneIds', 'sceneRef'],
  ['planeIds', 'planeRef'],
];

/** 实体 ownerType → 盖章表单该用哪种引用选择器（裸 id 也在候选清单里，选中写裸 id）。 */
const ENTITY_REF_PARAM_TYPES: Record<string, TemplateParamType> = {
  npc: 'npcRef',
  hotspot: 'hotspotRef',
  zone: 'zoneRef',
};

/** ownerId 这类值给出「带类型的选择器」而不是裸输入框：先按 ownerType 定，
 * 再拿实体目录反查兜底（目录里查无此人就退回 identifier，保值不硬套）。 */
function entityRefParamType(
  ownerType: string,
  value: string,
  catalog: AuthoringCatalogDef,
): TemplateParamType {
  const byOwner = ENTITY_REF_PARAM_TYPES[ownerType];
  if (byOwner) return byOwner;
  const listed: Array<[keyof AuthoringCatalogDef, TemplateParamType]> = [
    ['sceneHotspotRefs', 'hotspotRef'],
    ['sceneNpcRefs', 'npcRef'],
    ['zoneRefs', 'zoneRef'],
  ];
  for (const [key, type] of listed) {
    const list = catalog[key];
    if (Array.isArray(list) && (list as string[]).includes(value)) return type;
  }
  return 'identifier';
}

/** token 切词分隔符（`__` 先于 `_` 天然由正则交替覆盖）。 */
const TOKEN_SPLIT_RE = /[_\-:.\s]+/;

/** 泛用词不当实例 id（画布自动命名 wrapper_graph_N / composition_N 的碎片都在内）。 */
const TOKEN_STOPWORDS = new Set([
  'wrap', 'wrapper', 'flow', 'graph', 'state', 'main', 'signal', 'quest', 'dlg', 'mg',
  'npc', 'hotspot', 'zone', 'scene', 'initial', 'active', 'inactive', 'taken',
  'composition', 'element', 'scenario', 'dialogue', 'cutscene', 'minigame',
]);

/** 子串出现次数 = 抽取时真实会挖的洞数（替换语义与 Python extract_template 同为整树子串替换）。 */
export function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

function dedupName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let i = 2;
  while (used.has(`${base}${i}`)) i += 1;
  used.add(`${base}${i}`);
  return `${base}${i}`;
}

/** 实体推导绑定 → 建议参数名（优先于按类型取词干；盖章表单上显示的就是这个名字）。 */
const SOURCE_NAME_STEMS: Record<string, string> = {
  'entity.id': 'ownerId',
  'entity.kind': 'ownerType',
  'entity.label': 'label',
  'scene.id': 'sceneId',
};

/** ref 类型 → 建议参数名词干。 */
const REF_NAME_STEMS: Partial<Record<TemplateParamType, string>> = {
  dialogueRef: 'dialogue',
  minigameRef: 'minigame',
  cutsceneRef: 'cutscene',
  zoneRef: 'zone',
  scenarioRef: 'scenario',
  questRef: 'quest',
  sceneRef: 'scene',
  planeRef: 'plane',
};

/** 浅收集动作数组里的字符串参数值（只看 params 第一层，够住 warp/give 一类）。 */
function collectActionStrings(actions: unknown, into: Map<string, string>): void {
  if (!Array.isArray(actions)) return;
  for (const action of actions) {
    if (!action || typeof action !== 'object') continue;
    const params = (action as { params?: unknown }).params;
    if (!params || typeof params !== 'object') continue;
    for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
      if (typeof value === 'string' && value.trim()) into.set(value, key);
    }
  }
}

export function discoverParamCandidates(
  composition: NarrativeCompositionDef,
  catalog: AuthoringCatalogDef,
  authorSignals?: NarrativeAuthorSignalDef[],
): ParamCandidate[] {
  const blob = JSON.stringify(composition);
  const usedNames = new Set<string>();
  const refCandidates: ParamCandidate[] = [];
  const seenRefValues = new Set<string>();
  const graph = composition.mainGraph;

  const privateSignalIds = new Set(
    (authorSignals ?? []).filter((s) => s.scope === 'private').map((s) => s.id),
  );
  // 信号名对所有样值都算误伤，但 entity.id 只算「撞进字中间」那种：
  // 作者本来就常把实例 id 编进信号名（`藏钱点A__已取`），那是正当模式、该挖；
  // 而短 id 撞进无关信号（`门` 之于 `开门_完成`）会造出没人发的幽灵信号。
  const signalNames = collectSignalNames(composition);
  const boundaryOnlyFor = (suggestedFrom?: string) => suggestedFrom === 'entity.id';

  const pushRef = (
    sample: string,
    type: TemplateParamType,
    provenance: string,
    suggestedFrom?: string,
  ) => {
    const value = (sample ?? '').trim();
    if (!value || seenRefValues.has(value)) return;
    seenRefValues.add(value);
    const stem = (suggestedFrom && SOURCE_NAME_STEMS[suggestedFrom]) || REF_NAME_STEMS[type] || 'param';
    const overMatches = findOverMatches(
      value, catalog, blob, signalNames, boundaryOnlyFor(suggestedFrom),
    );
    refCandidates.push({
      suggestedName: dedupName(stem, usedNames),
      type,
      sample: value,
      occurrences: countOccurrences(blob, value),
      provenance,
      suggestedFrom,
      kind: 'ref',
      ...(overMatches.length ? { overMatches } : {}),
    });
  };

  // ---- ref 整值候选：出处即类型 ----
  for (const el of composition.elements ?? []) {
    const type = ELEMENT_REF_TYPES[el.kind];
    if (type && el.refId) pushRef(el.refId, type, `${el.label || el.kind} 的 refId`);
  }
  const scanGraphStates = (g: NarrativeGraphDef | undefined, where: string) => {
    for (const state of Object.values(g?.states ?? {})) {
      if (state.activePlane) pushRef(state.activePlane, 'planeRef', `${where}状态「${state.label || state.id}」的 activePlane`);
      const actionStrings = new Map<string, string>();
      collectActionStrings(state.onEnterActions, actionStrings);
      collectActionStrings(state.onExitActions, actionStrings);
      for (const [value, paramKey] of actionStrings) {
        for (const [listKey, type] of CATALOG_TYPE_LOOKUP) {
          const list = catalog[listKey];
          if (Array.isArray(list) && (list as string[]).includes(value)) {
            pushRef(value, type, `${where}状态「${state.label || state.id}」动作参数 ${paramKey}`);
            break;
          }
        }
      }
    }
  };
  scanGraphStates(graph, '');
  for (const el of composition.elements ?? []) {
    if (el.graph) scanGraphStates(el.graph, `子图「${el.label || el.id}」`);
  }
  // ownerType 是实体类时，ownerType 与显示名都能由实体推导（盖到 npc/zone 上才不会
  // 把字面 'hotspot' 焊进产物 → 运行时 owner 索引对不上、私有信号投不到；策划验收 B-4）。
  if (graph?.ownerType && ENTITY_OWNER_TYPES.has(graph.ownerType)) {
    pushRef(graph.ownerType, 'text', 'mainGraph.ownerType（宿主实体类型）', 'entity.kind');
    const displayName = String(graph.label ?? composition.label ?? '').trim();
    // 显示名恰好就是 ownerId 时不另立参数——否则它会先把这个值认领成 entity.label，
    // ownerId 的 entity.id 绑定就没了（批量盖章全盖到同一个实体上）。
    if (displayName && displayName !== String(graph.ownerId ?? '').trim() && displayName !== graph.ownerType) {
      pushRef(displayName, 'text', '图显示名（否则 N 个实例在画布上全同名）', 'entity.label');
    }
  }

  // ---- token 公共 token 候选：实例 id 形状 ----
  const namingSources = new Map<string, string>(); // 串 → 出处标签
  const addSource = (value: string | undefined, label: string) => {
    const v = (value ?? '').trim();
    if (v) namingSources.set(v, label);
  };
  addSource(composition.id, '作曲 id');
  addSource(graph?.id, '图 id');
  addSource(graph?.ownerId, 'ownerId');
  for (const tr of graph?.transitions ?? []) {
    // reactive* 转移不读 signal 字段（合法占位），不当命名源。
    const trigger = tr.trigger ?? 'signal';
    if (trigger === 'signal' && tr.signal && tr.signal !== '__draft__') addSource(tr.signal, `转移信号 ${tr.signal}`);
  }
  for (const el of composition.elements ?? []) {
    for (const emit of el.meta?.emits ?? []) addSource(String(emit), `元素 emit ${emit}`);
    const inner = el.graph;
    if (!inner) continue;
    addSource(inner.id, `子图 id ${inner.id}`);
    addSource(String(el.ownerId ?? inner.ownerId ?? ''), `子图「${el.label || el.id}」ownerId`);
    for (const tr of inner.transitions ?? []) {
      const trigger = tr.trigger ?? 'signal';
      if (trigger === 'signal' && tr.signal && tr.signal !== '__draft__') addSource(tr.signal, `子图转移信号 ${tr.signal}`);
    }
  }
  // 共用私有信号名刻意不参数化（N 个实例共用同一名字是机制本体），从命名源剔除。
  for (const id of privateSignalIds) namingSources.delete(id);

  const tokenSources = new Map<string, Set<string>>();
  for (const [source, label] of namingSources) {
    for (const raw of source.split(TOKEN_SPLIT_RE)) {
      const token = raw.trim();
      if (token.length < 2 || TOKEN_STOPWORDS.has(token.toLowerCase())) continue;
      if (seenRefValues.has(token)) continue; // 已是整值候选
      if (!tokenSources.has(token)) tokenSources.set(token, new Set());
      tokenSources.get(token)!.add(label);
    }
  }

  const tokenCandidates: ParamCandidate[] = [];
  const ownerIsEntity = Boolean(graph?.ownerId) && ENTITY_OWNER_TYPES.has(graph?.ownerType ?? '');
  for (const [token, sources] of tokenSources) {
    if (sources.size < 2) continue;
    const isOwnerId = ownerIsEntity && token === graph!.ownerId;
    const overMatches = findOverMatches(
      token, catalog, blob, signalNames, boundaryOnlyFor(isOwnerId ? 'entity.id' : undefined),
    );
    tokenCandidates.push({
      suggestedName: '', // 排序后再定名
      type: isOwnerId ? entityRefParamType(graph!.ownerType, token, catalog) : 'identifier',
      sample: token,
      occurrences: countOccurrences(blob, token),
      provenance: [...sources].join('、'),
      suggestedFrom: isOwnerId ? 'entity.id' : undefined,
      kind: 'token',
      ...(overMatches.length ? { overMatches } : {}),
    });
  }
  const sourceCount = (c: ParamCandidate) => c.provenance.split('、').length;
  tokenCandidates.sort((a, b) => sourceCount(b) - sourceCount(a) || b.occurrences - a.occurrences);
  const topTokens = tokenCandidates.slice(0, 3);

  // 实体图的 ownerId 恒出候选：哪怕只出现一处（画布自动名的图 id 里没有它、凑不满
  // ≥2 命名源），它也是批量盖章必需的那个洞（from: entity.id）——主图与内嵌 wrapper 都算。
  const entityOwnerIds = new Map<string, { provenance: string; ownerType: string }>();
  if (ownerIsEntity && graph?.ownerId) {
    entityOwnerIds.set(graph.ownerId.trim(), {
      provenance: 'ownerId（宿主实体，批量盖章必需）',
      ownerType: graph.ownerType,
    });
  }
  for (const el of composition.elements ?? []) {
    const innerOwnerType = String(el.ownerType ?? el.graph?.ownerType ?? '');
    const innerOwnerId = String(el.ownerId ?? el.graph?.ownerId ?? '').trim();
    if (el.graph && innerOwnerId && ENTITY_OWNER_TYPES.has(innerOwnerType)) {
      entityOwnerIds.set(innerOwnerId, {
        provenance: `子图「${el.label || el.id}」的 ownerId（宿主实体）`,
        ownerType: innerOwnerType,
      });
    }
  }
  for (const [ownerIdValue, meta] of entityOwnerIds) {
    if (!ownerIdValue || seenRefValues.has(ownerIdValue)) continue;
    const existing = topTokens.find((c) => c.sample === ownerIdValue);
    if (existing) {
      if (!existing.suggestedFrom) existing.suggestedFrom = 'entity.id';
      if (existing.type === 'identifier') {
        existing.type = entityRefParamType(meta.ownerType, ownerIdValue, catalog);
      }
      continue;
    }
    const ownerOverMatches = findOverMatches(ownerIdValue, catalog, blob, signalNames, true);
    topTokens.unshift({
      suggestedName: '',
      type: entityRefParamType(meta.ownerType, ownerIdValue, catalog),
      sample: ownerIdValue,
      occurrences: countOccurrences(blob, ownerIdValue),
      provenance: meta.provenance,
      suggestedFrom: 'entity.id',
      kind: 'token',
      ...(ownerOverMatches.length ? { overMatches: ownerOverMatches } : {}),
    });
  }

  for (const cand of topTokens) {
    const stem = (cand.suggestedFrom && SOURCE_NAME_STEMS[cand.suggestedFrom]) || 'taskId';
    cand.suggestedName = dedupName(stem, usedNames);
  }

  return [...topTokens, ...refCandidates];
}
