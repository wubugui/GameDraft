/**
 * 「信号关系」面板的纯逻辑：筛选、分组、行文案。
 *
 * 与渲染分开是为了能测——面板本身要靠 QWebEngine 才跑得起来，而"筛选筛错了""发射方
 * 跟上游因果混在一起"这类问题，恰恰是纯函数能一秒验出来的。
 */
import { graphTopologyFingerprint } from './canvas/wrapperAutoGroups';
import type {
  NarrativeGraphDef,
  NarrativeGraphsFileDef,
  SignalXrefCardDef,
  ValidationTargetDef,
  XrefDeclarationDef,
  StateXrefCardDef,
  XrefEmitterDef,
  XrefListenerDef,
  XrefStateReadDef,
} from './types';

export type XrefFilterKind = 'all' | 'problems' | 'author' | 'derived' | 'unregistered';

export const XREF_FILTERS: Array<{ id: XrefFilterKind; label: string; hint: string }> = [
  { id: 'all', label: '全部', hint: '工程里出现过的所有信号' },
  { id: 'problems', label: '有问题', hint: '两侧对不齐的：没人发 / 没人听 / 没登记 / 广播没开' },
  { id: 'author', label: '作者信号', hint: '在信号注册表里登记过的' },
  { id: 'derived', label: '派生信号', hint: '状态进入时自动广播的 state:图:态' },
  { id: 'unregistered', label: '未登记', hint: '用到了却没在注册表登记的' },
];

/** 这条信号两侧对不齐吗（info 级不算问题：草稿占位是合法的） */
export function hasProblem(card: SignalXrefCardDef): boolean {
  return card.diagnostics.some((d) => d.severity === 'error' || d.severity === 'warning');
}

export function worstSeverity(card: SignalXrefCardDef): 'error' | 'warning' | 'info' | '' {
  if (card.diagnostics.some((d) => d.severity === 'error')) return 'error';
  if (card.diagnostics.some((d) => d.severity === 'warning')) return 'warning';
  if (card.diagnostics.length) return 'info';
  return '';
}

/**
 * 搜索面：id / 中文名 / 注释 / 两侧涉及的容器与图。
 * 把两侧也纳入搜索，是因为策划记得住的是"婆子那段戏发的那个信号"，记不住 id。
 */
export function searchHaystack(card: SignalXrefCardDef): string {
  return [
    card.signal,
    card.label,
    card.notes,
    card.sourceGraphId,
    card.sourceStateLabel,
    ...card.emitters.map((e) => `${e.kindLabel} ${e.containerLabel} ${e.containerId} ${e.where} ${e.context}`),
    ...card.listeners.map((l) => `${l.compositionLabel} ${l.graphLabel} ${l.transitionId} ${l.fromLabel} ${l.toLabel}`),
    ...card.declarations.map((d) => `${d.compositionLabel} ${d.elementLabel} ${d.refId}`),
  ].join(' ').toLowerCase();
}

export function filterSignals(
  cards: SignalXrefCardDef[],
  kind: XrefFilterKind,
  query: string,
): SignalXrefCardDef[] {
  const q = query.trim().toLowerCase();
  return cards.filter((card) => {
    if (kind === 'problems' && !hasProblem(card)) return false;
    if (kind === 'author' && card.kind !== 'author') return false;
    if (kind === 'derived' && card.kind !== 'derived') return false;
    if (kind === 'unregistered' && card.kind !== 'unknown') return false;
    if (!q) return true;
    return searchHaystack(card).includes(q);
  });
}

/**
 * 发送方要拆两堆：**真发射** 和 **上游因果**（派生信号才有）。
 * 混在一起数，"这条信号有 3 个发射点"就是假的——其中两个只是"能让那一拍发生的路"。
 */
export function splitEmitters(card: SignalXrefCardDef): {
  real: XrefEmitterDef[];
  upstream: XrefEmitterDef[];
} {
  return {
    real: card.emitters.filter((e) => e.channel !== 'upstream'),
    upstream: card.emitters.filter((e) => e.channel === 'upstream'),
  };
}

export function signalDisplayName(card: SignalXrefCardDef): string {
  return card.label && card.label !== card.signal ? `${card.signal}（${card.label}）` : card.signal;
}

/**
 * 这条「留痕来源」值不值得占一行？
 *
 * `emitNarrativeSignal` 带的 sourceType/sourceId 只是运行时留痕参数。它跟所在容器一致时
 * （绝大多数情况）等于把容器名再抄一遍，纯噪声；**对不上**时才是线索——那说明这条发射
 * 被登记成了另一个来源，查"谁发的"会被带偏。
 */
export function noteWorthShowing(e: XrefEmitterDef): boolean {
  if (!e.note) return false;
  const id = (e.containerId || e.containerLabel || '').trim();
  if (!id) return true;
  return !e.note.includes(id);
}

export function emitterHeadline(e: XrefEmitterDef): string {
  const who = e.containerLabel || e.containerId;
  if (!who) return e.kindLabel || '未知来源';
  return e.kindLabel ? `${e.kindLabel}「${who}」` : who;
}

export function listenerHeadline(l: XrefListenerDef): string {
  return `${l.graphLabel} · ${l.fromLabel} → ${l.toLabel}`;
}

export function listenerSubline(l: XrefListenerDef): string {
  const bits = [l.compositionLabel, `转移「${l.transitionId}」`];
  if (l.priority) bits.push(`优先级 ${l.priority}`);
  if (l.conditions.length) bits.push(`还要满足：${l.conditions.join(' 且 ')}`);
  return bits.filter(Boolean).join(' · ');
}

export function declarationHeadline(d: XrefDeclarationDef): string {
  return `${d.compositionLabel} · 元素「${d.elementLabel}」`;
}

/** 跳转载荷：把行上的定位原样交给宿主既有的跳转引擎 */
export function refOf(row: { file: string; pointer: string; anchors?: string[][] }): {
  file: string;
  pointer: string;
  anchors: string[][];
} {
  return { file: row.file, pointer: row.pointer, anchors: row.anchors ?? [] };
}

/**
 * 这一行能不能点。两种点不动：
 * - 压根没有文件定位；
 * - 只读数据面（物件检视）——主编辑器不管理这份文件，跳过去只会得到一句"没有对应编辑页"。
 *   与其让人白点一次，不如把按钮灰掉并写清楚为什么。
 */
export function canReveal(row: { file?: string; pointer?: string; readonly?: boolean }): boolean {
  return Boolean(row.file) && !row.readonly;
}

/** 点不动时给人一句为什么（写给策划，不甩术语） */
export function revealBlockedReason(row: { file?: string; readonly?: boolean }): string {
  if (row.readonly) return '这份数据主编辑器只读，跳不过去；用「查引用(JSON 语言)」或直接开这个文件';
  if (!row.file) return '这条定位没有文件，跳不过去';
  return '';
}

/** 一句话总结两侧，给列表行用 */
export function countSummary(card: SignalXrefCardDef): string {
  const bits = [`发 ${card.emitterCount}`, `听 ${card.listenerCount}`];
  if (card.declarationCount) bits.push(`另有 ${card.declarationCount} 处只是标注`);
  return bits.join(' · ');
}

/**
 * 这条校验问题指的是一条信号吗？是就返回信号 id。
 *
 * 信号类问题（重复 id / 保留名）在画布上**没有落点**，focus 解析对它们恒返回 null，
 * 于是点了完全没反应。改成落到「信号关系」——那里正好是这条信号的全貌。
 */
export function signalFocusIdOf(issue: { target?: { kind: string; signalId?: string } }): string | null {
  if (issue.target?.kind !== 'signal') return null;
  const id = String(issue.target.signalId ?? '').trim();
  return id || null;
}

/**
 * 叙事图内的行（广播状态 / 状态动作 / 上游转移）走**画布定位**，不走文件跳转。
 *
 * 为什么不能走文件跳转：`navigate_to_search_hit` 对 narrative_graphs.json 只认
 * `…/states/<id>`，转移那种指针落不到点，会退化成"打开了叙事状态机页"——而你本来
 * 就在那一页，画面纹丝不动，看起来就是按钮坏了。
 */
export function focusTargetOfEmitter(e: XrefEmitterDef): ValidationTargetDef | null {
  if (!e.compositionId || !e.graphId) return null;
  const scope = e.elementId ? { elementId: e.elementId } : {};
  if (e.transitionId) {
    return { kind: 'transition', compositionId: e.compositionId, graphId: e.graphId, transitionId: e.transitionId, ...scope };
  }
  if (e.stateId) {
    return { kind: 'state', compositionId: e.compositionId, graphId: e.graphId, stateId: e.stateId, ...scope };
  }
  return null;
}

/** 黑盒声明写在元素身上，定位到那个元素——那正是要改它的地方 */
export function focusTargetOfDeclaration(d: XrefDeclarationDef): ValidationTargetDef | null {
  if (!d.compositionId || !d.elementId) return null;
  return { kind: 'element', compositionId: d.compositionId, elementId: d.elementId };
}

/** 列表行的显示名：有中文名就一起显示（真有中文名的那几条最难靠 id 认出来） */
export function rowLabel(card: SignalXrefCardDef): string {
  return card.label && card.label !== card.signal ? `${card.signal}（${card.label}）` : card.signal;
}

/* ------------------------------------------------------- 私有信号的「一条模式」
 * 私有信号的监听面天生是 N 份同一件事：100 个箱子各有一张 wrapper 图，各自听同一条
 * 信号名、各推各的状态。逐条列出来是 100 行**没有信息量**的重复——真正要说的只有一句：
 * 「所有绑此类 wrapper 的实体，都会在收到它时走这一跳」。
 *
 * 聚合按**转移在图里的结构位置**（状态插入序下标 + 触发方式 + 条件）+ 图的拓扑指纹，
 * 而不是按 from/to 的 id 或中文名——盖章产物的 id 各不相同（`箱子07_opened`），
 * 按名字聚合等于聚不上。同一张图里长得不一样的两跳仍然分成两条模式，不会被合并。
 */

export interface PrivateListenerPattern {
  /** 代表行（第一条）：详情、跳转、条件文案全用它 */
  sample: XrefListenerDef;
  /** 这一模式覆盖多少张 wrapper 图 */
  count: number;
  /** 涉及的图 id（出现序、去重），tooltip 里列前几个 */
  graphIds: string[];
}

function graphIndexOf(data: NarrativeGraphsFileDef): Map<string, NarrativeGraphDef> {
  const out = new Map<string, NarrativeGraphDef>();
  for (const comp of data.compositions ?? []) {
    if (comp.mainGraph?.id) out.set(comp.mainGraph.id, comp.mainGraph);
    for (const el of comp.elements ?? []) {
      if (el.graph?.id) out.set(el.graph.id, el.graph);
    }
  }
  return out;
}

/**
 * 把私有信号的监听行收成若干「模式」。全局信号不该调它——全局信号的监听方各是各的，
 * 合并会把「谁听」这个问题答错。
 */
export function aggregatePrivateListeners(
  listeners: readonly XrefListenerDef[],
  data: NarrativeGraphsFileDef,
): PrivateListenerPattern[] {
  const graphs = graphIndexOf(data);
  const order: string[] = [];
  const buckets = new Map<string, PrivateListenerPattern>();
  for (const l of listeners) {
    const graph = graphs.get(l.graphId);
    const stateIds = Object.keys(graph?.states ?? {});
    const fromIdx = stateIds.indexOf(l.from);
    const toIdx = stateIds.indexOf(l.to);
    // 图不在当前文档里（宿主扫描面比画布文档宽）：退回按 id 分组，宁可多分几条也不合错
    const positional = graph && fromIdx >= 0 && toIdx >= 0 ? `${fromIdx}>${toIdx}` : `${l.from}>${l.to}`;
    const key = [
      // 与画布自动分组同口径：两处判「同款」必须是同一把尺子
      graph ? graphTopologyFingerprint(graph) : '',
      positional,
      l.trigger ?? '',
      String(l.priority ?? 0),
      l.conditions.join('&&'),
    ].join('␞');
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.count += 1;
      if (!bucket.graphIds.includes(l.graphId)) bucket.graphIds.push(l.graphId);
    } else {
      order.push(key);
      buckets.set(key, { sample: l, count: 1, graphIds: [l.graphId] });
    }
  }
  return order.map((key) => buckets.get(key)!).filter(Boolean);
}

/** 模式行的抬头：说的是一类实体，不是某一张图。 */
export function privatePatternHeadline(pattern: PrivateListenerPattern): string {
  const { sample } = pattern;
  const jump = `${sample.fromLabel} → ${sample.toLabel}`;
  return pattern.count > 1
    ? `所有绑此类 wrapper 的实体（${pattern.count} 张图）· ${jump}`
    : `${sample.graphLabel} · ${jump}`;
}

/** 模式行的 tooltip：把被折叠掉的图列出来，别让人以为少扫了。 */
export function privatePatternTitle(pattern: PrivateListenerPattern): string {
  if (pattern.count <= 1) return listenerSubline(pattern.sample);
  const shown = pattern.graphIds.slice(0, 8).join('、');
  const rest = pattern.graphIds.length > 8 ? ` 等 ${pattern.graphIds.length} 张` : '';
  return `这一跳在 ${pattern.count} 张同款 wrapper 图上各有一份：${shown}${rest}\n`
    + '（私有信号只投给发射方 owner 的那一张，不会一次推动全部；点「画布定位」落到第一张）';
}

/** 目标转移的聚焦目标（复用校验面板那套 focus）；缺 compositionId 时不给，免得跳空 */
export function listenerFocusTarget(l: XrefListenerDef):
  | { kind: 'transition'; compositionId: string; graphId: string; transitionId: string; elementId?: string }
  | null {
  if (!l.compositionId || !l.graphId || !l.transitionId) return null;
  return {
    kind: 'transition',
    compositionId: l.compositionId,
    graphId: l.graphId,
    transitionId: l.transitionId,
    ...(l.elementId ? { elementId: l.elementId } : {}),
  };
}


/**
 * 「关系指纹」：只认会改变两侧关系的内容，**忽略画布坐标**。
 *
 * 整份 narrative 的哈希不行：节点坐标就存在 `states.<id>.meta.editor.x/y`，而挪节点是
 * 画布上最高频的手势——面板会因此长期挂着"关系可能过期"，等真的改了接线时那条警告
 * 已经没人看了（狼来了）。
 */
export function relationFingerprint(data: NarrativeGraphsFileDef): string {
  return JSON.stringify(data, (key, value) => (key === 'editor' ? undefined : value));
}

/* ------------------------------------------------------------------ 状态维度
 * 「这一拍怎么进来、去哪、**谁在看着**」。与信号维度共用同一份扫描，界面上是同一块
 * 面板的两个页签——问的是同一件事的两面，分成两个面板只会让人两处找。
 */

export type StateFilterKind = 'all' | 'problems' | 'watched' | 'broadcast';

export const STATE_FILTERS: Array<{ id: StateFilterKind; label: string; hint: string }> = [
  { id: 'all', label: '全部', hint: '工程里出现过的所有状态（含被引用但不存在的）' },
  { id: 'problems', label: '有问题', hint: '进不来 / 图里没有这个状态 / 路全没接线' },
  { id: 'watched', label: '有人看着', hint: '被条件、对话分支、场景显隐…引用过的' },
  { id: 'broadcast', label: '会广播', hint: '勾了「进入时广播」的' },
];

export function stateKey(card: { graphId: string; stateId: string }): string {
  return `${card.graphId}.${card.stateId}`;
}

export function stateHeadline(card: StateXrefCardDef): string {
  return `${card.graphLabel} · ${card.stateLabel}`;
}

/** 列表副行：一眼看出这一拍的牵连有多大 */
export function stateCountSummary(card: StateXrefCardDef): string {
  const bits = [`进 ${card.wayInCount}`, `出 ${card.wayOutCount}`, `${card.readerCount} 处看着`];
  if (card.broadcasts) bits.push('会广播');
  return bits.join(' · ');
}

export function stateWorstSeverity(card: StateXrefCardDef): 'error' | 'warning' | 'info' | '' {
  if (card.diagnostics.some((d) => d.severity === 'error')) return 'error';
  if (card.diagnostics.some((d) => d.severity === 'warning')) return 'warning';
  if (card.diagnostics.length) return 'info';
  return '';
}

export function stateHasProblem(card: StateXrefCardDef): boolean {
  return card.diagnostics.some((d) => d.severity === 'error' || d.severity === 'warning');
}

export function stateSearchHaystack(card: StateXrefCardDef): string {
  return [
    stateKey(card), card.graphLabel, card.stateLabel, card.compositionLabel,
    // 主体名必须进搜索面：placeholder 写着"谁在看着它"，而抬头显示的正是 subjectDisplay
    // ——不收它的话，照着屏幕上的名字搜会零结果（审查坐实 98/120 个主体名搜不到）。
    ...card.readers.map((r) => `${r.subjectKindLabel} ${r.subjectDisplay} ${r.subjectScene} ${r.subjectEffect} ${r.kindLabel} ${r.containerId} ${r.where}`),
    ...card.waysIn.map((e) => `${e.containerLabel} ${e.where} ${e.context}`),
    ...card.waysOut.map((l) => `${l.signal} ${l.toLabel}`),
  ].join(' ').toLowerCase();
}

export function filterStates(
  cards: StateXrefCardDef[],
  kind: StateFilterKind,
  query: string,
): StateXrefCardDef[] {
  const q = query.trim().toLowerCase();
  return cards.filter((card) => {
    if (kind === 'problems' && !stateHasProblem(card)) return false;
    if (kind === 'watched' && card.readerCount === 0) return false;
    if (kind === 'broadcast' && !card.broadcasts) return false;
    if (!q) return true;
    return stateSearchHaystack(card).includes(q);
  });
}

/** 定位到这一拍本身（画布上选中那个状态节点） */
export function stateFocusTarget(card: StateXrefCardDef): ValidationTargetDef | null {
  if (!card.compositionId || !card.graphId || !card.exists) return null;
  return {
    kind: 'state',
    compositionId: card.compositionId,
    graphId: card.graphId,
    stateId: card.stateId,
    ...(card.elementId ? { elementId: card.elementId } : {}),
  };
}

/**
 * 读状态那一行**长在哪**——它自带 `graphId`（被读的那张图），不能拿它当"这行在哪"，
 * 否则会定位到被读的图上去（而不是写着这条条件的那张图）。
 */
export function readerFocusTarget(r: XrefStateReadDef): ValidationTargetDef | null {
  if (!r.compositionId || !r.hostGraphId) return null;
  const scope = r.elementId ? { elementId: r.elementId } : {};
  if (r.hostTransitionId) {
    return { kind: 'transition', compositionId: r.compositionId, graphId: r.hostGraphId, transitionId: r.hostTransitionId, ...scope };
  }
  return { kind: 'graph', compositionId: r.compositionId, graphId: r.hostGraphId, ...scope };
}

/**
 * 一行读状态说的是**世界里的那个东西**：雾津街头的 NPC「庄家来人」，
 * 而不是 `npcs[3].conditions[0]`。策划盯的是实体与流程，技术路径退到副行。
 */
export function readerHeadline(r: XrefStateReadDef): string {
  const who = r.subjectDisplay || r.containerId || r.kindLabel;
  const kind = r.subjectKindLabel || r.kindLabel;
  const where = r.subjectScene ? `${r.subjectScene}的` : '';
  return kind && who ? `${where}${kind}「${who}」` : (who || kind);
}

/** 这一拍决定它什么（出不出现 / 算不算完成 / 开不开…）＋要求"到过"还是"正停在" */
export function readerEffect(r: XrefStateReadDef): string {
  const bits: string[] = [];
  if (r.subjectEffect) bits.push(r.subjectEffect);
  bits.push(r.reached ? '要求到过这一拍' : '要求正停在这一拍');
  if (r.negated) bits.push('取反');
  return bits.join(' · ');
}
