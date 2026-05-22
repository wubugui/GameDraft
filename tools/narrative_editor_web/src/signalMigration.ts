import {
  DEFAULT_DRAFT_SIGNAL,
  DERIVED_STATE_SIGNAL_PREFIX,
  NARRATIVE_SCHEMA_VERSION,
  stateEnteredSignalKey,
} from './signalConstants';
import type { NarrativeAuthorSignalDef, NarrativeGraphDef, NarrativeGraphsFileDef } from './types';

function collectGraphs(data: NarrativeGraphsFileDef): NarrativeGraphDef[] {
  const out: NarrativeGraphDef[] = [];
  for (const comp of data.compositions ?? []) {
    if (comp.mainGraph) out.push(comp.mainGraph);
    for (const el of comp.elements ?? []) {
      if (el.graph) out.push(el.graph);
    }
  }
  return out;
}

function decodeKeyPart(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Map legacy transition/meta signal keys to v3 semantic keys. */
export function migrateLegacySignalKey(raw: string): string {
  const key = String(raw ?? '').trim();
  if (!key) return DEFAULT_DRAFT_SIGNAL;
  if (key === DEFAULT_DRAFT_SIGNAL || key.startsWith(DERIVED_STATE_SIGNAL_PREFIX)) return key;

  if (key.startsWith('external:state:')) {
    const parts = key.split(':');
    if (parts.length >= 4) {
      const graphId = decodeKeyPart(parts[2] ?? '');
      const stateId = decodeKeyPart(parts.slice(3).join(':'));
      return stateEnteredSignalKey(graphId, stateId);
    }
  }

  if (key.startsWith('stateEntered:')) {
    const parts = key.split(':');
    if (parts.length >= 3) {
      return stateEnteredSignalKey(decodeKeyPart(parts[1] ?? ''), decodeKeyPart(parts.slice(2).join(':')));
    }
  }

  if (key.startsWith('external:') && key.split(':').length >= 4) {
    const parts = key.split(':');
    return decodeKeyPart(parts.slice(3).join(':'));
  }

  return key;
}

function ensureAuthorSignal(signals: NarrativeAuthorSignalDef[], id: string): void {
  if (!id || id === DEFAULT_DRAFT_SIGNAL || id.startsWith(DERIVED_STATE_SIGNAL_PREFIX)) return;
  if (signals.some((s) => s.id === id)) return;
  signals.push({ id, label: id });
}

export function migrateNarrativeSignalsV3(data: NarrativeGraphsFileDef): NarrativeGraphsFileDef {
  const next = structuredClone(data);
  next.schemaVersion = NARRATIVE_SCHEMA_VERSION;
  next.signals ??= [];

  for (const graph of collectGraphs(next)) {
    for (const t of graph.transitions ?? []) {
      const migrated = migrateLegacySignalKey(t.signal);
      if (migrated !== DEFAULT_DRAFT_SIGNAL && !migrated.startsWith(DERIVED_STATE_SIGNAL_PREFIX)) {
        ensureAuthorSignal(next.signals!, migrated);
      }
      t.signal = migrated;
    }
  }

  for (const comp of next.compositions ?? []) {
    for (const el of comp.elements ?? []) {
      if (!el.meta) continue;
      if (Array.isArray(el.meta.emits)) {
        el.meta.emits = el.meta.emits.map((s) => migrateLegacySignalKey(String(s)));
      }
    }
  }

  const seen = new Set<string>();
  next.signals = (next.signals ?? []).filter((s) => {
    const id = String(s.id ?? '').trim();
    if (!id || seen.has(id)) return false;
    seen.add(id);
    s.id = id;
    return true;
  });

  return next;
}
