import {
  DEFAULT_DRAFT_SIGNAL,
  isDerivedStateSignal,
  isReservedAuthorSignalId,
  stateBroadcastOnEnter,
  stateEnteredSignalKey,
} from './signalConstants';
import type {
  NarrativeAuthorSignalDef,
  NarrativeGraphsFileDef,
  SignalCatalogEntryDef,
  SignalEmitterRefDef,
  SignalListenerRefDef,
  SignalScope,
} from './types';

function collectGraphs(data: NarrativeGraphsFileDef) {
  const graphs: Array<{ graph: import('./types').NarrativeGraphDef; compositionId: string }> = [];
  for (const comp of data.compositions ?? []) {
    if (comp.mainGraph?.id) graphs.push({ graph: comp.mainGraph, compositionId: comp.id });
    for (const el of comp.elements ?? []) {
      if (el.graph?.id) graphs.push({ graph: el.graph, compositionId: comp.id });
    }
  }
  return graphs;
}

export function collectListenerRefs(data: NarrativeGraphsFileDef): Map<string, SignalListenerRefDef[]> {
  const map = new Map<string, SignalListenerRefDef[]>();
  for (const { graph, compositionId } of collectGraphs(data)) {
    for (const t of graph.transitions ?? []) {
      const sig = String(t.signal ?? '').trim();
      if (!sig) continue;
      const list = map.get(sig) ?? [];
      list.push({
        compositionId,
        graphId: graph.id,
        transitionId: t.id,
        from: String(t.from),
        to: String(t.to),
      });
      map.set(sig, list);
    }
  }
  return map;
}

export function buildSignalCatalog(
  data: NarrativeGraphsFileDef,
  emitterRefsById?: Map<string, SignalEmitterRefDef[]>,
): SignalCatalogEntryDef[] {
  const listeners = collectListenerRefs(data);
  const entries = new Map<string, SignalCatalogEntryDef>();

  for (const s of data.signals ?? []) {
    const id = String(s.id ?? '').trim();
    if (!id) continue;
    entries.set(id, {
      id,
      kind: 'author',
      label: s.label,
      notes: s.notes,
      // 只在真是 private 时带这个字段：目录条目与磁盘行同口径，缺省一律不落 'global'
      ...(s.scope === 'private' ? { scope: 'private' as const } : {}),
      listeners: listeners.get(id)?.length ?? 0,
      emitters: emitterRefsById?.get(id)?.length ?? 0,
      editable: true,
      registered: true,
    });
  }

  for (const { graph } of collectGraphs(data)) {
    for (const [stateId, state] of Object.entries(graph.states ?? {})) {
      if (!stateBroadcastOnEnter(state)) continue;
      const id = stateEnteredSignalKey(graph.id, stateId);
      if (entries.has(id)) continue;
      entries.set(id, {
        id,
        kind: 'derived',
        label: `${graph.id}.${stateId}`,
        graphId: graph.id,
        stateId,
        listeners: listeners.get(id)?.length ?? 0,
        emitters: 0,
        editable: false,
        registered: true, // 派生广播由状态自动产生，本就不需要注册行
      });
    }
  }

  // blackbox 声明的 emits：element 只在 meta.emits 里"声明"它会发出某信号（真正发出发生在其
  // 引用的对话/资产内容里，目录构建阶段读不到）。目录必须收录这些声明，否则该信号既进不了信号选择
  // 弹窗、监听它的 transition 又会被判成悬空断链。未被注册为作者信号时补一条 editable:false 的条目
  // （无 data.signals 行可改名/删除）。放在监听推断之前，让"仅声明"的信号带上明确 label。
  for (const comp of data.compositions ?? []) {
    for (const el of comp.elements ?? []) {
      const emits = el.meta?.emits;
      if (!Array.isArray(emits)) continue;
      for (const raw of emits) {
        const id = String(raw ?? '').trim();
        if (!id || entries.has(id)) continue;
        const label = String(el.label ?? el.id ?? '').trim();
        entries.set(id, {
          id,
          kind: isDerivedStateSignal(id) ? 'derived' : 'author',
          label: label ? `来自 blackbox ${label} 声明` : '来自 blackbox 声明',
          listeners: listeners.get(id)?.length ?? 0,
          emitters: emitterRefsById?.get(id)?.length ?? 0,
          editable: false,
          registered: isDerivedStateSignal(id),
        });
      }
    }
  }

  for (const [id, refs] of listeners) {
    if (entries.has(id)) continue;
    entries.set(id, {
      id,
      kind: isDerivedStateSignal(id) ? 'derived' : 'author',
      listeners: refs.length,
      emitters: emitterRefsById?.get(id)?.length ?? 0,
      editable: !isDerivedStateSignal(id) && !isReservedAuthorSignalId(id),
      // 只被监听、没有注册行 = 影子条目。派生形态的 state:… 若指向已删状态则不算"作者未登记"，
      // 由 state.broadcast.missing 另行报，故这里按派生放行不标未登记。
      registered: isDerivedStateSignal(id),
    });
  }

  entries.set(DEFAULT_DRAFT_SIGNAL, {
    id: DEFAULT_DRAFT_SIGNAL,
    kind: 'draft',
    label: '未分配（草稿）',
    listeners: listeners.get(DEFAULT_DRAFT_SIGNAL)?.length ?? 0,
    emitters: 0,
    editable: false,
    registered: true, // 保留占位符，不需要也不允许注册行
  });

  return [...entries.values()].sort((a, b) => {
    const order = { draft: 0, author: 1, derived: 2 };
    const ka = order[a.kind] ?? 9;
    const kb = order[b.kind] ?? 9;
    if (ka !== kb) return ka - kb;
    return a.id.localeCompare(b.id);
  });
}

export function collectKnownSignals(data: NarrativeGraphsFileDef): string[] {
  return buildSignalCatalog(data)
    .filter((e) => e.kind !== 'draft')
    .map((e) => e.id);
}

/**
 * 「这条信号缺一行 signals 注册行、而且补得上」——目录弹窗的「补登记」按钮与迁移检查器的
 * 未登记提示**共用这一个判据**，别各写各的（两处镜像迟早漂移：曾经弹窗用 `entry.editable`
 * gate，于是 blackbox 声明来的信号在检查器里报警告、在弹窗里却没有补登记按钮）。
 *
 * 派生 `state:…`、草稿 `__draft__`、空 id 本来就不该有注册行，一律 false。
 */
export function isUnregisteredAuthorSignal(data: NarrativeGraphsFileDef, id: string): boolean {
  const target = String(id ?? '').trim();
  if (!target || isReservedAuthorSignalId(target)) return false;
  return !(data.signals ?? []).some((s) => s.id === target);
}

export function createAuthorSignal(
  data: NarrativeGraphsFileDef,
  id: string,
  label?: string,
  notes?: string,
  scope?: SignalScope,
): void {
  const trimmed = String(id ?? '').trim();
  if (isReservedAuthorSignalId(trimmed)) throw new Error(`Invalid signal id: ${trimmed}`);
  data.signals ??= [];
  if (data.signals.some((s) => s.id === trimmed)) throw new Error(`Signal already exists: ${trimmed}`);
  const entry: NarrativeAuthorSignalDef = { id: trimmed };
  if (label?.trim()) entry.label = label.trim();
  if (notes?.trim()) entry.notes = notes.trim();
  // 缺省 global **不写键**：往返要字节级幂等，默认值塞进 JSON 就是噪声（也会让既有 121 行全变脏）
  if (scope === 'private') entry.scope = 'private';
  data.signals.push(entry);
}

/**
 * 改一条作者信号的投递面。
 *
 * 写 private = 加 `scope: 'private'`；改回全局 = **删键**而不是写 `scope: 'global'`——
 * 缺省语义就是 global，写出来只会让 JSON 多一行噪声、并让"没动过的信号"在 diff 里变脏。
 * 派生/保留信号没有注册行，不接受 scope（与 setAuthorSignalNotes 同款守卫）。
 * 只被引用、还没注册行的信号：勾私有即顺手补一条注册行（勾选即注册，与"注释即注册"同理）。
 */
export function setAuthorSignalScope(data: NarrativeGraphsFileDef, id: string, isPrivate: boolean): void {
  const target = String(id ?? '').trim();
  if (!target || isReservedAuthorSignalId(target) || isDerivedStateSignal(target)) return;
  data.signals ??= [];
  const row = data.signals.find((s) => s.id === target);
  if (row) {
    if (isPrivate) row.scope = 'private';
    else delete row.scope;
    return;
  }
  if (isPrivate) data.signals.push({ id: target, scope: 'private' });
}

/** 这条信号是不是私有（唯一判据：注册行的 `scope === 'private'`）。 */
export function isPrivateAuthorSignal(data: NarrativeGraphsFileDef, id: string): boolean {
  const target = String(id ?? '').trim();
  if (!target) return false;
  return (data.signals ?? []).some((s) => s.id === target && s.scope === 'private');
}

/** 全部私有信号 id（面板/画布判"这条边听的是私有信号"用同一个集合，别各扫各的）。 */
export function collectPrivateSignalIds(data: NarrativeGraphsFileDef): Set<string> {
  return new Set(
    (data.signals ?? [])
      .filter((s) => s?.scope === 'private')
      .map((s) => String(s.id ?? '').trim())
      .filter(Boolean),
  );
}

/**
 * 给作者信号写/改注释。注释就是「注册那个地方」——若该信号已被引用但还没进 data.signals，
 * 写注释时顺手把它注册进去（注释即注册）。派生/保留信号不接受作者注释（它们由状态自动生成）。
 * 清空注释 = 删 notes 键；对本来就不存在、又被清空的信号不无谓创建空行。
 */
export function setAuthorSignalNotes(data: NarrativeGraphsFileDef, id: string, notes: string): void {
  const target = String(id ?? '').trim();
  if (!target || isReservedAuthorSignalId(target) || isDerivedStateSignal(target)) return;
  data.signals ??= [];
  const row = data.signals.find((s) => s.id === target);
  const trimmed = String(notes ?? '').trim();
  if (row) {
    if (trimmed) row.notes = trimmed;
    else delete row.notes;
  } else if (trimmed) {
    data.signals.push({ id: target, notes: trimmed });
  }
}

/** 递归更新 emitNarrativeSignal 动作里 params.signal 的引用（动作可嵌套，故递归）。 */
function replaceEmitSignalInActions(value: unknown, from: string, to: string): void {
  if (Array.isArray(value)) {
    for (const item of value) replaceEmitSignalInActions(item, from, to);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const obj = value as Record<string, unknown>;
  if (obj.type === 'emitNarrativeSignal' && obj.params && typeof obj.params === 'object' && !Array.isArray(obj.params)) {
    const params = obj.params as Record<string, unknown>;
    if (String(params.signal ?? '').trim() === from) params.signal = to;
  }
  for (const v of Object.values(obj)) replaceEmitSignalInActions(v, from, to);
}

export function renameAuthorSignal(data: NarrativeGraphsFileDef, oldId: string, newId: string): void {
  const from = String(oldId ?? '').trim();
  const to = String(newId ?? '').trim();
  if (!from || !to || from === to) return;
  if (isReservedAuthorSignalId(to)) throw new Error(`Invalid signal id: ${to}`);
  data.signals ??= [];
  const row = data.signals.find((s) => s.id === from);
  if (!row) throw new Error(`Unknown author signal: ${from}`);
  if (data.signals.some((s) => s.id === to)) throw new Error(`Signal already exists: ${to}`);
  row.id = to;
  for (const { graph } of collectGraphs(data)) {
    for (const t of graph.transitions ?? []) {
      if (t.signal === from) t.signal = to;
    }
    // 信号改名必须级联到 emitNarrativeSignal 动作参数，否则发射端仍用旧名 → 运行时永不触发
    // 该迁移（与 renameStateInGraph 级联条件/命令/信号引用同理，之前只漏了这一处）。
    for (const state of Object.values(graph.states ?? {})) {
      replaceEmitSignalInActions(state.onEnterActions, from, to);
      replaceEmitSignalInActions(state.onExitActions, from, to);
    }
  }
  for (const comp of data.compositions ?? []) {
    for (const el of comp.elements ?? []) {
      if (!Array.isArray(el.meta?.emits)) continue;
      el.meta.emits = el.meta.emits.map((s) => (String(s) === from ? to : s));
    }
  }
}

export function deleteAuthorSignal(data: NarrativeGraphsFileDef, id: string): void {
  const target = String(id ?? '').trim();
  data.signals = (data.signals ?? []).filter((s) => s.id !== target);
}
