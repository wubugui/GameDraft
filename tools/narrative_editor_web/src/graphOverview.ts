/**
 * 「编排全貌」的纯逻辑：把宿主扫描出的一张图的卡片（GraphXrefCardDef）翻成四组**可跳转的行**，
 * 再按状态 / 转移分桶给画布小标用。
 *
 * 只列它与游戏里真实存在的东西之间的关联：
 * - 推它的（push）：发信号让它的转移走起来的区域 / 热点 / 对话图 / 小游戏 / 另一张图；
 * - 它管的（gate）：条件里读它状态的场景实体 / 任务 / 地图节点 / 档案 / 对话分支…；
 * - 它调的（call）：它的状态动作会去动的过场 / 对话图 / 物品 / 说明卡 / 位面 / 区域…；
 * - 接它往下走（next）：监听它末态广播的别的叙事图。
 *
 * 信号名、状态名、标签**不单列**——它们是机制，不是策划要跳过去看的东西。渲染与这里分开，
 * 是为了能测："同一条转移的进入时 / 停留时被算成两行""自推排到了前面""同一份档案两条
 * 一字不差"这类问题纯函数一秒验出来。
 */
import { listenerFocusTarget, readerEffect, readerFocusTarget } from './signalXref';
import type {
  GraphXrefCardDef,
  ValidationTargetDef,
  XrefListenerDef,
  XrefPusherDef,
  XrefStateReadDef,
  XrefTargetDef,
} from './types';

export type RefJump =
  | { kind: 'reveal'; file: string; pointer: string; anchors: string[][] }
  | { kind: 'navigate'; navKind: string; id: string }
  | { kind: 'focus'; target: ValidationTargetDef }
  | { kind: 'none'; reason: string };

export type RefGroup = 'push' | 'gate' | 'call' | 'next';

export const REF_GROUP_LABELS: Record<RefGroup, string> = {
  push: '推它的',
  gate: '它管的',
  call: '它调的',
  next: '接它往下走的图',
};

export const REF_GROUP_HINTS: Record<RefGroup, string> = {
  push: '谁发的信号让这张图走起来：场景里的区域 / 热点、对话图、小游戏、别的叙事图',
  gate: '谁的条件读这张图的状态：场景实体显隐、任务、地图节点、档案、对话分支、章节包',
  call: '这张图的状态动作会去动谁：过场、对话图、物品、说明卡、位面、区域、NPC…',
  next: '监听这张图末态广播、接着往下走的别的叙事图',
};

/** 「整个编排」视图的图 id 占位（不是真图 id） */
export const WHOLE_COMPOSITION_ID = '__all__';

export interface RefRow {
  key: string;
  group: RefGroup;
  /** 人话类别：区域 / 热点 / NPC / 对话图 / 过场 / 物品 / 任务… */
  kindLabel: string;
  /** 那个东西的名字（中文名优先，取不到退 id） */
  title: string;
  /** 那个东西的 id（跳转回执里名字后面括号那个；与名字一样时不显示） */
  refId: string;
  /** 它与这张图的关系：让「护好 → 阵风」走 / 出不出现 / 状态「引路」进入时 */
  subtitle: string;
  /** 位置补充：场景名、进入时/停留时、第几个动作 */
  detail: string;
  /** 这一行长在哪张图 */
  graphId: string;
  graphLabel: string;
  /** 这一行挂在本图的哪一拍 / 哪条转移（画布小标按它分桶；push 的 stateId 是转移起点） */
  stateId: string;
  stateLabel: string;
  /** push 行：转移终点（"只看这一拍"时进入这一拍的路也要算） */
  toStateId: string;
  transitionId: string;
  jump: RefJump;
  /** 在本图画布上定位这一行挂着的状态 / 转移 */
  canvasFocus: ValidationTargetDef | null;
  /** 来源是本图自己的状态动作（不是世界里的东西） */
  selfGraph: boolean;
  searchText: string;
}

export interface GraphOverviewModel {
  graphId: string;
  graphLabel: string;
  ownerLine: string;
  compositionLabel: string;
  exists: boolean;
  /** 整个编排视图：行来自多张图 */
  wholeComposition: boolean;
  push: RefRow[];
  gate: RefRow[];
  call: RefRow[];
  next: RefRow[];
  chipsByState: Record<string, { gate: RefRow[]; call: RefRow[] }>;
  chipsByTransition: Record<string, RefRow[]>;
}

function stateFocus(card: GraphXrefCardDef, stateId: string): ValidationTargetDef | null {
  if (!card.compositionId || !card.graphId || !stateId) return null;
  return {
    kind: 'state',
    compositionId: card.compositionId,
    graphId: card.graphId,
    stateId,
    ...(card.elementId ? { elementId: card.elementId } : {}),
  };
}

function transitionFocus(card: GraphXrefCardDef, transitionId: string): ValidationTargetDef | null {
  if (!card.compositionId || !card.graphId || !transitionId) return null;
  return {
    kind: 'transition',
    compositionId: card.compositionId,
    graphId: card.graphId,
    transitionId,
    ...(card.elementId ? { elementId: card.elementId } : {}),
  };
}

function revealJump(row: { file: string; pointer: string; anchors?: string[][] }): RefJump {
  return { kind: 'reveal', file: row.file, pointer: row.pointer, anchors: row.anchors ?? [] };
}

/** 推它的：来源是另一张图的状态 → 画布定位；本图自推 → 定位那一拍；否则交宿主跳转引擎 */
export function pusherJump(p: XrefPusherDef): RefJump {
  if (p.selfGraph && p.compositionId && p.graphId && p.stateId) {
    return {
      kind: 'focus',
      target: {
        kind: 'state', compositionId: p.compositionId, graphId: p.graphId, stateId: p.stateId,
        ...(p.elementId ? { elementId: p.elementId } : {}),
      },
    };
  }
  if (p.refGraphId && p.compositionId) {
    return {
      kind: 'focus',
      target: {
        kind: 'state', compositionId: p.compositionId, graphId: p.refGraphId, stateId: p.refStateId,
        ...(p.elementId ? { elementId: p.elementId } : {}),
      },
    };
  }
  if (p.readonly) return { kind: 'none', reason: '这份数据主编辑器只读，跳不过去' };
  if (p.file) return revealJump(p);
  return { kind: 'none', reason: '这条来源没有文件定位' };
}

export function readerJump(r: XrefStateReadDef): RefJump {
  const focus = readerFocusTarget(r);
  if (focus) return { kind: 'focus', target: focus };
  if (r.readonly) return { kind: 'none', reason: '这份数据主编辑器只读，跳不过去；用「查引用(JSON 语言)」或直接开这个文件' };
  if (r.file) return revealJump(r);
  return { kind: 'none', reason: '这条引用没有文件定位' };
}

export function targetJump(t: XrefTargetDef): RefJump {
  if (t.refGraphId) {
    if (!t.refCompositionId) return { kind: 'none', reason: `目录里没有叙事图「${t.refGraphId}」` };
    return {
      kind: 'focus',
      target: {
        kind: 'graph', compositionId: t.refCompositionId, graphId: t.refGraphId,
        ...(t.refElementId ? { elementId: t.refElementId } : {}),
      },
    };
  }
  if (t.navKind) return { kind: 'navigate', navKind: t.navKind, id: t.targetId };
  if (t.readonly) return { kind: 'none', reason: t.note || '主编辑器只读，跳不过去' };
  if (t.file) return revealJump(t);
  return { kind: 'none', reason: t.note || '这类目标没有编辑页' };
}

export function listenerJump(l: XrefListenerDef): RefJump {
  const focus = listenerFocusTarget(l);
  if (focus) return { kind: 'focus', target: focus };
  return { kind: 'none', reason: '这条转移没有画布坐标' };
}

/** 人话：这个跳转会去哪（技术口径：文件 / 页；给测试与兜底用） */
export function describeJump(jump: RefJump): string {
  if (jump.kind === 'reveal') {
    const anchor = jump.anchors.length ? `「${jump.anchors[jump.anchors.length - 1]![1]}」` : '';
    return `打开 ${jump.file}${anchor ? ` 里的 ${anchor}` : jump.pointer ? ` 的 ${jump.pointer}` : ''}`;
  }
  if (jump.kind === 'navigate') return `切到「${jump.navKind}」页：${jump.id}`;
  if (jump.kind === 'focus') return '在画布上定位';
  return jump.reason;
}

/**
 * 人话：这一行点下去会去哪——先名字后 id，不甩文件路径。
 * 「会打开对话图「跑马梁·纸钱引路」（主线_初上跑马梁）」，人一眼就知道是行里那个东西。
 */
export function describeRowJump(row: RefRow): string {
  const idSuffix = row.refId && row.refId !== row.title ? `（${row.refId}）` : '';
  const what = `${row.kindLabel}「${row.title}」${idSuffix}`;
  if (row.jump.kind === 'reveal') return `打开${what}`;
  if (row.jump.kind === 'navigate') return `切到${what}`;
  if (row.jump.kind === 'focus') return `在画布上定位到${what}`;
  return row.jump.reason;
}

function pushGroupKey(p: XrefPusherDef): string {
  return [p.transitionId, p.selfGraph ? 'self' : '', p.subjectKindLabel, p.subjectId, p.sceneId].join('␞');
}

function buildPushRows(card: GraphXrefCardDef): RefRow[] {
  // 同一条转移 × 同一个东西的多个时刻（区域的进入时 / 停留时）并成一行：分成两行是把
  // "一个区域"说成"两个东西"。
  const order: string[] = [];
  const buckets = new Map<string, { sample: XrefPusherDef; moments: string[] }>();
  // 自推的排最后（稳定）：宿主已经这么排了，这里再保一道——两侧口径漂了也不会把自推顶到最前
  const pushers = [...card.pushers.filter((p) => !p.selfGraph), ...card.pushers.filter((p) => p.selfGraph)];
  for (const p of pushers) {
    const key = pushGroupKey(p);
    const bucket = buckets.get(key);
    if (bucket) {
      if (p.moment && !bucket.moments.includes(p.moment)) bucket.moments.push(p.moment);
    } else {
      order.push(key);
      buckets.set(key, { sample: p, moments: p.moment ? [p.moment] : [] });
    }
  }
  const graphLabel = card.graphLabel || card.graphId;
  return order.map((key) => {
    const { sample: p, moments } = buckets.get(key)!;
    const title = p.subjectName || p.subjectId || p.containerLabel || p.containerId;
    const how = p.selfGraph
      ? `本图状态「${p.subjectName || p.subjectId}」的动作发「${p.signal}」`
      : p.signal
        ? `发「${p.signal}」，让「${p.fromLabel} → ${p.toLabel}」走`
        : `条件读到它的「${p.refStateLabel || p.refStateId}」时，「${p.fromLabel} → ${p.toLabel}」自动走`;
    const detailBits: string[] = [];
    if (p.sceneLabel && p.subjectKindLabel !== '场景') detailBits.push(p.sceneLabel);
    if (moments.length && !p.selfGraph) detailBits.push(moments.join(' / '));
    if (p.refStateLabel && p.signal) detailBits.push(`状态「${p.refStateLabel}」`);
    return {
      key: `push:${card.graphId}:${key}`,
      group: 'push',
      kindLabel: p.subjectKindLabel || p.kindLabel || '来源',
      title,
      refId: p.subjectId || p.containerId,
      subtitle: how,
      detail: detailBits.join(' · '),
      graphId: card.graphId,
      graphLabel,
      stateId: p.fromState,
      stateLabel: p.fromLabel || p.fromState,
      toStateId: p.toState,
      transitionId: p.transitionId,
      jump: pusherJump(p),
      canvasFocus: transitionFocus(card, p.transitionId),
      selfGraph: p.selfGraph,
      searchText: [p.subjectKindLabel, title, p.subjectId, p.signal, p.fromLabel, p.toLabel, p.sceneLabel, moments.join(' '), graphLabel].join(' ').toLowerCase(),
    };
  });
}

function stateOrder(card: GraphXrefCardDef, stateId: string): number {
  const idx = card.stateIds.indexOf(stateId);
  return idx < 0 ? 999 : idx;
}

function buildGateRows(card: GraphXrefCardDef): RefRow[] {
  const graphLabel = card.graphLabel || card.graphId;
  const rows = card.readers.map((r, i): RefRow => {
    const stateLabel = card.stateLabels[r.stateId] ?? r.stateId;
    const title = r.subjectDisplay || r.containerId || r.kindLabel;
    return {
      key: `gate:${card.graphId}:${r.file}#${r.pointer}#${i}`,
      group: 'gate',
      kindLabel: r.subjectKindLabel || r.kindLabel || '引用',
      title,
      refId: r.subjectId || r.containerId,
      subtitle: `${readerEffect(r)} · 看「${stateLabel}」`,
      detail: r.subjectScene || '',
      graphId: card.graphId,
      graphLabel,
      stateId: r.stateId,
      stateLabel,
      toStateId: '',
      transitionId: '',
      jump: readerJump(r),
      canvasFocus: stateFocus(card, r.stateId),
      selfGraph: false,
      searchText: [r.subjectKindLabel, title, r.subjectId, r.subjectScene, r.subjectEffect, stateLabel, r.kindLabel, r.containerId, graphLabel].join(' ').toLowerCase(),
    };
  });
  rows.sort((a, b) => stateOrder(card, a.stateId) - stateOrder(card, b.stateId) || a.kindLabel.localeCompare(b.kindLabel, 'zh') || a.title.localeCompare(b.title, 'zh'));
  return rows;
}

function buildCallRows(card: GraphXrefCardDef): RefRow[] {
  const graphLabel = card.graphLabel || card.graphId;
  const rows = card.targets.map((t, i): RefRow => {
    const stateLabel = card.stateLabels[t.stateId] ?? t.stateId;
    const scene = t.sceneLabel && t.universe !== 'scenes' ? `${t.sceneLabel} 的 ` : '';
    return {
      key: `call:${card.graphId}:${t.hostPointer}#${t.universe}#${t.targetId}#${i}`,
      group: 'call',
      kindLabel: t.kindLabel,
      title: `${scene}${t.display}`,
      refId: t.targetId,
      subtitle: `状态「${stateLabel}」${t.where ? ` · ${t.where}` : ''}`,
      detail: t.readonly ? '只读' : '',
      graphId: card.graphId,
      graphLabel,
      stateId: t.stateId,
      stateLabel,
      toStateId: '',
      transitionId: '',
      jump: targetJump(t),
      canvasFocus: stateFocus(card, t.stateId),
      selfGraph: false,
      searchText: [t.kindLabel, t.display, t.targetId, t.sceneLabel, t.actionType, stateLabel, t.where, graphLabel].join(' ').toLowerCase(),
    };
  });
  rows.sort((a, b) => stateOrder(card, a.stateId) - stateOrder(card, b.stateId));
  return rows;
}

function buildNextRows(card: GraphXrefCardDef): RefRow[] {
  const graphLabel = card.graphLabel || card.graphId;
  return card.downstream.map((l, i): RefRow => ({
    key: `next:${card.graphId}:${l.graphId}#${l.transitionId}#${i}`,
    group: 'next',
    kindLabel: '叙事图',
    title: l.graphLabel || l.graphId,
    refId: l.graphId,
    subtitle: `听「${l.signal}」，走「${l.fromLabel} → ${l.toLabel}」`,
    detail: l.compositionLabel || '',
    graphId: card.graphId,
    graphLabel,
    stateId: '',
    stateLabel: '',
    toStateId: '',
    transitionId: '',
    jump: listenerJump(l),
    canvasFocus: null,
    selfGraph: false,
    searchText: [l.graphLabel, l.graphId, l.signal, l.fromLabel, l.toLabel, graphLabel].join(' ').toLowerCase(),
  }));
}

/**
 * 同一个东西、同一句关系、同一拍的行只留一条：一份档案的两条解锁条件都读同一拍时，
 * 列两行一字不差等于把"一件事"说成"两件事"（验收实测：档案「克拉拉」连着两条）。
 */
export function dedupeRows(rows: RefRow[]): RefRow[] {
  const seen = new Set<string>();
  const out: RefRow[] = [];
  for (const row of rows) {
    const key = [row.group, row.graphId, row.stateId, row.kindLabel, row.title, row.subtitle, row.detail].join('␞');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

export function buildGraphOverview(card: GraphXrefCardDef): GraphOverviewModel {
  const push = buildPushRows(card);
  const gate = dedupeRows(buildGateRows(card));
  const call = dedupeRows(buildCallRows(card));
  const next = buildNextRows(card);
  const chipsByState: Record<string, { gate: RefRow[]; call: RefRow[] }> = {};
  for (const sid of card.stateIds) chipsByState[sid] = { gate: [], call: [] };
  for (const row of gate) (chipsByState[row.stateId] ??= { gate: [], call: [] }).gate.push(row);
  for (const row of call) (chipsByState[row.stateId] ??= { gate: [], call: [] }).call.push(row);
  const chipsByTransition: Record<string, RefRow[]> = {};
  for (const row of push) {
    if (row.selfGraph) continue;
    (chipsByTransition[row.transitionId] ??= []).push(row);
  }
  const ownerLine = card.ownerId ? `${card.ownerType}:${card.ownerId}` : '';
  return {
    graphId: card.graphId,
    graphLabel: card.graphLabel || card.graphId,
    ownerLine,
    compositionLabel: card.compositionLabel,
    exists: card.exists,
    wholeComposition: false,
    push, gate, call, next,
    chipsByState,
    chipsByTransition,
  };
}

/**
 * 整个编排（主图 + 全部子图）的全貌：把各图的行合起来，每行标出长在哪张图。
 * 为什么要有它：子图的任务门常挂在主图上（跑马梁那张图「它管的」里一条任务都没有，任务
 * 「备上山的家伙」读的是主图的「初到跑马梁」），只看子图会误判"这段没接任务"。
 */
export function buildCompositionOverview(cards: GraphXrefCardDef[], compositionLabel: string): GraphOverviewModel {
  const models = cards.map(buildGraphOverview);
  const tag = (row: RefRow): RefRow => ({
    ...row,
    detail: [`图「${row.graphLabel}」`, row.detail].filter(Boolean).join(' · '),
  });
  return {
    graphId: WHOLE_COMPOSITION_ID,
    graphLabel: `整个编排 · ${compositionLabel}`,
    ownerLine: `${cards.length} 张图`,
    compositionLabel,
    exists: cards.length > 0,
    wholeComposition: true,
    push: models.flatMap((m) => m.push.map(tag)),
    gate: models.flatMap((m) => m.gate.map(tag)),
    call: models.flatMap((m) => m.call.map(tag)),
    next: models.flatMap((m) => m.next.map(tag)),
    chipsByState: {},
    chipsByTransition: {},
  };
}

export type RowFilter = {
  query?: string;
  /** 只看这一拍：挂在这一拍的行 + 进入这一拍的路（push 的终点） */
  stateId?: string;
  graphId?: string;
  /** 只看这些类别（空 = 全部） */
  kinds?: ReadonlySet<string>;
};

export function filterRows(rows: RefRow[], filter: RowFilter | string, legacyStateId = ''): RefRow[] {
  const f: RowFilter = typeof filter === 'string' ? { query: filter, stateId: legacyStateId } : filter;
  const q = (f.query ?? '').trim().toLowerCase();
  return rows.filter((row) => {
    if (f.stateId && row.stateId !== f.stateId && row.toStateId !== f.stateId) return false;
    if (f.graphId && row.graphId !== f.graphId) return false;
    if (f.kinds && f.kinds.size && !f.kinds.has(row.kindLabel)) return false;
    if (!q) return true;
    return row.searchText.includes(q);
  });
}

/** 出现过的类别与各自行数（类别筛选按钮用），按行数降序 */
export function kindCounts(model: GraphOverviewModel): Array<{ kind: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of [...model.push, ...model.gate, ...model.call, ...model.next]) {
    counts.set(row.kindLabel, (counts.get(row.kindLabel) ?? 0) + 1);
  }
  return [...counts.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind, 'zh'));
}

/** 按「哪张图 · 哪一拍」分段（保持行序），长清单折起来看 */
export function groupRowsByState(rows: RefRow[]): Array<{ key: string; label: string; rows: RefRow[] }> {
  const order: string[] = [];
  const buckets = new Map<string, { label: string; rows: RefRow[] }>();
  for (const row of rows) {
    const key = `${row.graphId}␞${row.stateId}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      const stateBit = row.stateLabel ? `状态「${row.stateLabel}」` : '（不挂在某一拍）';
      bucket = { label: stateBit, rows: [] };
      buckets.set(key, bucket);
      order.push(key);
    }
    bucket.rows.push(row);
  }
  return order.map((key) => ({ key, ...buckets.get(key)! }));
}

/** 画布小标的文字：类别·名字。名字太长由 CSS 截，这里不截——截了就搜不到了。 */
export function chipText(row: RefRow): string {
  return `${row.kindLabel}·${row.title}`;
}

/** 一张图的三组计数一句话（面板抬头 / 子图导航用）；与各组组头的数字对得上 */
export function overviewSummary(model: GraphOverviewModel): string {
  const external = model.push.filter((r) => !r.selfGraph).length;
  const self = model.push.length - external;
  const bits = [
    `推它的 ${external}${self ? `（另有本图自己发的 ${self}）` : ''}`,
    `它管的 ${model.gate.length}`,
    `它调的 ${model.call.length}`,
  ];
  if (model.next.length) bits.push(`接它往下走 ${model.next.length}`);
  return bits.join(' · ');
}
