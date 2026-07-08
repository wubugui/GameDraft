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
      listeners: listeners.get(id)?.length ?? 0,
      emitters: emitterRefsById?.get(id)?.length ?? 0,
      editable: true,
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
    });
  }

  entries.set(DEFAULT_DRAFT_SIGNAL, {
    id: DEFAULT_DRAFT_SIGNAL,
    kind: 'draft',
    label: '未分配（草稿）',
    listeners: listeners.get(DEFAULT_DRAFT_SIGNAL)?.length ?? 0,
    emitters: 0,
    editable: false,
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

export function createAuthorSignal(data: NarrativeGraphsFileDef, id: string, label?: string): void {
  const trimmed = String(id ?? '').trim();
  if (isReservedAuthorSignalId(trimmed)) throw new Error(`Invalid signal id: ${trimmed}`);
  data.signals ??= [];
  if (data.signals.some((s) => s.id === trimmed)) throw new Error(`Signal already exists: ${trimmed}`);
  const entry: NarrativeAuthorSignalDef = { id: trimmed };
  if (label?.trim()) entry.label = label.trim();
  data.signals.push(entry);
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
