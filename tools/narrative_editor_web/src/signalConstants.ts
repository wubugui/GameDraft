/** Reserved transition signal for unassigned draft edges. Never auto-emitted at runtime. */
export const DEFAULT_DRAFT_SIGNAL = '__draft__';

/** Prefix for derived state-enter broadcast signals. */
export const DERIVED_STATE_SIGNAL_PREFIX = 'state:';

export const NARRATIVE_SCHEMA_VERSION = 3;

export function stateEnteredSignalKey(graphId: string, stateId: string): string {
  const g = String(graphId ?? '').trim();
  const s = String(stateId ?? '').trim();
  return `${DERIVED_STATE_SIGNAL_PREFIX}${g}:${s}`;
}

export function isDerivedStateSignal(id: string): boolean {
  return String(id ?? '').trim().startsWith(DERIVED_STATE_SIGNAL_PREFIX);
}

export function parseDerivedStateSignal(id: string): { graphId: string; stateId: string } | null {
  const raw = String(id ?? '').trim();
  if (!raw.startsWith(DERIVED_STATE_SIGNAL_PREFIX)) return null;
  const rest = raw.slice(DERIVED_STATE_SIGNAL_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) return null;
  const graphId = rest.slice(0, sep).trim();
  const stateId = rest.slice(sep + 1).trim();
  return graphId && stateId ? { graphId, stateId } : null;
}

export function stateBroadcastOnEnter(state: { broadcastOnEnter?: boolean } | null | undefined): boolean {
  return state?.broadcastOnEnter === true;
}

export function isReservedAuthorSignalId(id: string): boolean {
  const raw = String(id ?? '').trim();
  return !raw || raw === DEFAULT_DRAFT_SIGNAL || isDerivedStateSignal(raw);
}
