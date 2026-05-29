export type RuntimeTraceType = 'dialogue' | 'action' | 'flag' | 'quest' | 'signal' | 'narrative' | 'scenario' | 'scene' | 'system';
export type RuntimeTracePhase = 'start' | 'end' | 'fail' | 'change' | 'emit' | 'match' | 'block' | 'info';

export interface RuntimeTraceEvent {
  id: number;
  timeMs: number;
  type: RuntimeTraceType;
  phase?: RuntimeTracePhase;
  label: string;
  causeId?: number;
  payload?: Record<string, unknown>;
}

function runtimeTraceEnabled(): boolean {
  try {
    const w = window as unknown as { __GAME_ENABLE_RUNTIME_TRACE__?: boolean };
    return import.meta.env.DEV === true || w.__GAME_ENABLE_RUNTIME_TRACE__ === true;
  } catch {
    return false;
  }
}

function payloadRecord(payload: unknown): Record<string, unknown> | undefined {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) return payload as Record<string, unknown>;
  if (payload === undefined) return undefined;
  return { value: payload };
}

function shortPayload(payload: unknown): string {
  if (payload === undefined || payload === null) return '';
  try {
    const text = JSON.stringify(payload);
    return text.length > 180 ? `${text.slice(0, 177)}...` : text;
  } catch {
    return String(payload);
  }
}

export class RuntimeTraceStore {
  private events: RuntimeTraceEvent[] = [];
  private nextId = 1;
  private readonly maxEvents: number;
  private readonly enabled: boolean;

  constructor(maxEvents = 800) {
    this.maxEvents = Math.max(50, maxEvents);
    this.enabled = runtimeTraceEnabled();
    this.add({ type: 'system', phase: 'start', label: 'runtime trace installed' });
  }

  add(event: Omit<RuntimeTraceEvent, 'id' | 'timeMs'>): number {
    if (!this.enabled) return 0;
    const id = this.nextId++;
    this.events.push({ ...event, id, timeMs: performance.now() });
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
    return id;
  }

  getRecent(limit = 200): RuntimeTraceEvent[] {
    return this.events.slice(-Math.max(1, limit));
  }

  clear(): void {
    this.events = [];
  }

  formatRecent(limit = 120): string {
    const rows = this.getRecent(limit);
    if (rows.length === 0) return '(empty)';
    return rows.map((e) => {
      const t = `${Math.round(e.timeMs).toString().padStart(6, ' ')}`;
      const phase = e.phase ? `:${e.phase}` : '';
      const extra = e.payload ? ` ${shortPayload(e.payload)}` : '';
      const cause = e.causeId ? ` <=#${e.causeId}` : '';
      return `#${e.id.toString().padStart(4, '0')} ${t}ms [${e.type}${phase}] ${e.label}${cause}${extra}`;
    }).join('\n');
  }

  exportRecentJson(limit = 400): string {
    return JSON.stringify({ events: this.getRecent(limit) }, null, 2);
  }
}

export const runtimeTrace = new RuntimeTraceStore(800);

try {
  if (runtimeTraceEnabled()) (window as any).__GAME_RUNTIME_TRACE__ = runtimeTrace;
} catch {
  // non-browser execution
}

export function traceEventBusEmit(event: string, payload?: unknown): void {
  if (!runtimeTraceEnabled()) return;
  if (event === 'action:start' || event === 'action:end' || event === 'action:fail') {
    const p = payloadRecord(payload);
    const phase = event === 'action:start' ? 'start' : event === 'action:end' ? 'end' : 'fail';
    runtimeTrace.add({ type: 'action', phase, label: String(p?.type ?? 'unknown'), payload: p });
    if (event === 'action:start' && p?.type === 'emitNarrativeSignal') {
      const params = p.params as Record<string, unknown> | undefined;
      runtimeTrace.add({ type: 'signal', phase: 'emit', label: String(params?.signal ?? 'unknown'), payload: p });
    }
    return;
  }
  if (event === 'flag:changed') {
    const p = payloadRecord(payload);
    runtimeTrace.add({ type: 'flag', phase: 'change', label: String(p?.key ?? 'unknown'), payload: p });
    return;
  }
  if (event === 'quest:accepted' || event === 'quest:completed') {
    const p = payloadRecord(payload);
    runtimeTrace.add({ type: 'quest', phase: event === 'quest:accepted' ? 'start' : 'end', label: String(p?.questId ?? 'unknown'), payload: p });
    return;
  }
  if (event === 'quest:evaluate') {
    const p = payloadRecord(payload);
    runtimeTrace.add({ type: 'quest', phase: String(p?.phase ?? 'info') === 'match' ? 'match' : 'block', label: `${String(p?.questId ?? 'unknown')} ${String(p?.check ?? '')}`, payload: p });
    return;
  }
  if (event === 'narrative:stateChanged') {
    const p = payloadRecord(payload);
    runtimeTrace.add({ type: 'narrative', phase: 'change', label: `${String(p?.graphId ?? 'unknown')}: ${String(p?.from ?? '?')} -> ${String(p?.to ?? '?')}`, payload: p });
    return;
  }
  if (event === 'narrative:transitionCandidate') {
    const p = payloadRecord(payload);
    runtimeTrace.add({ type: 'narrative', phase: String(p?.phase ?? 'block') === 'match' ? 'match' : 'block', label: `${String(p?.graphId ?? 'unknown')}.${String(p?.transitionId ?? 'unknown')}`, payload: p });
    return;
  }
  if (event === 'dialogue:start') {
    const p = payloadRecord(payload);
    runtimeTrace.add({ type: 'dialogue', phase: 'start', label: String(p?.graphId ?? p?.npcName ?? 'unknown'), payload: p });
    return;
  }
  if (event === 'dialogue:node') {
    const p = payloadRecord(payload);
    runtimeTrace.add({ type: 'dialogue', phase: 'info', label: `${String(p?.graphId ?? 'unknown')}.${String(p?.nodeId ?? 'unknown')}`, payload: p });
    return;
  }
  if (event === 'dialogue:line') {
    const p = payloadRecord(payload);
    const where = p?.graphId && p?.nodeId ? `${String(p.graphId)}.${String(p.nodeId)}` : 'line';
    runtimeTrace.add({ type: 'dialogue', phase: 'info', label: where, payload: p });
    return;
  }
  if (event === 'dialogue:choices') {
    runtimeTrace.add({ type: 'dialogue', phase: 'block', label: `choices ${Array.isArray(payload) ? payload.length : '?'}`, payload: { choices: payload } });
    return;
  }
  if (event === 'dialogue:choiceSelected:log') {
    const p = payloadRecord(payload);
    runtimeTrace.add({ type: 'dialogue', phase: 'match', label: `choice ${String(p?.index ?? '?')}`, payload: p });
    return;
  }
  if (event === 'dialogue:end') {
    runtimeTrace.add({ type: 'dialogue', phase: 'end', label: 'dialogue ended', payload: payloadRecord(payload) });
  }
}
