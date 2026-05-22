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
