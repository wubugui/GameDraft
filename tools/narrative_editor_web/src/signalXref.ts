/**
 * 「信号关系」面板的纯逻辑：筛选、分组、行文案。
 *
 * 与渲染分开是为了能测——面板本身要靠 QWebEngine 才跑得起来，而"筛选筛错了""发射方
 * 跟上游因果混在一起"这类问题，恰恰是纯函数能一秒验出来的。
 */
import type {
  SignalXrefCardDef,
  ValidationTargetDef,
  XrefDeclarationDef,
  XrefEmitterDef,
  XrefListenerDef,
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
