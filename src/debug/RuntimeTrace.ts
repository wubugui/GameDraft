import type { EventBus } from '../core/EventBus';

export type RuntimeTraceType =
  | 'dialogue'
  | 'action'
  | 'flag'
  | 'quest'
  | 'signal'
  | 'narrative'
  | 'scenario'
  | 'scene'
  | 'system';

export type RuntimeTracePhase =
  | 'start'
  | 'end'
  | 'fail'
  | 'change'
  | 'emit'
  | 'match'
  | 'block'
  | 'info';

export interface RuntimeTraceEvent {
  id: number;
  timeMs: number;
  type: RuntimeTraceType;
  phase?: RuntimeTracePhase;
  label: string;
  causeId?: number;
  payload?: Record<string, unknown>;
}

export interface RuntimeTraceHandle {
  add(event: Omit<RuntimeTraceEvent, 'id' | 'timeMs'>): number;
  getRecent(limit?: number): RuntimeTraceEvent[];
  clear(): void;
  formatRecent(limit?: number): string;
  destroy(): void;
}

type Listener = { event: string; fn: (payload?: any) => void };

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function payloadRecord(payload: unknown): Record<string, unknown> | undefined {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  if (payload === undefined) return undefined;
  return { value: payload };
}

function shortPayload(payload: unknown): string {
  if (payload === undefined || payload === null) return '';
  const text = safeJson(payload);
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

export class RuntimeTraceStore implements RuntimeTraceHandle {
  private events: RuntimeTraceEvent[] = [];
  private nextId = 1;
  private readonly maxEvents: number;
  private readonly listeners: Listener[] = [];
  private readonly eventBus?: EventBus;

  constructor(maxEvents = 500, eventBus?: EventBus) {
    this.maxEvents = Math.max(50, maxEvents);
    this.eventBus = eventBus;
  }

  add(event: Omit<RuntimeTraceEvent, 'id' | 'timeMs'>): number {
    const id = this.nextId++;
    this.events.push({ ...event, id, timeMs: performance.now() });
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
    return id;
  }

  getRecent(limit = 200): RuntimeTraceEvent[] {
    return this.events.slice(-Math.max(1, limit));
  }

  clear(): void {
    this.events = [];
  }

  listen(event: string, fn: (payload?: any) => void): void {
    if (!this.eventBus) return;
    this.eventBus.on(event, fn);
    this.listeners.push({ event, fn });
  }

  destroy(): void {
    if (this.eventBus) {
      for (const l of this.listeners) this.eventBus.off(l.event, l.fn);
    }
    this.listeners.length = 0;
    this.clear();
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
}

export function installRuntimeTraceEventBridge(eventBus: EventBus): RuntimeTraceStore {
  const trace = new RuntimeTraceStore(600, eventBus);

  trace.add({ type: 'system', phase: 'start', label: 'runtime trace installed' });

  trace.listen('action:start', (p) => trace.add({
    type: 'action', phase: 'start', label: String(p?.type ?? 'unknown'), payload: payloadRecord(p),
  }));
  trace.listen('action:end', (p) => trace.add({
    type: 'action', phase: 'end', label: String(p?.type ?? 'unknown'), payload: payloadRecord(p),
  }));
  trace.listen('action:fail', (p) => trace.add({
    type: 'action', phase: 'fail', label: String(p?.type ?? 'unknown'), payload: payloadRecord(p),
  }));

  trace.listen('flag:changed', (p) => trace.add({
    type: 'flag', phase: 'change', label: String(p?.key ?? 'unknown'), payload: payloadRecord(p),
  }));

  trace.listen('quest:accepted', (p) => trace.add({
    type: 'quest', phase: 'start', label: String(p?.questId ?? 'unknown'), payload: payloadRecord(p),
  }));
  trace.listen('quest:completed', (p) => trace.add({
    type: 'quest', phase: 'end', label: String(p?.questId ?? 'unknown'), payload: payloadRecord(p),
  }));

  trace.listen('narrative:signal', (p) => trace.add({
    type: 'signal', phase: 'emit', label: String(p?.signal ?? p?.key ?? 'unknown'), payload: payloadRecord(p),
  }));
  trace.listen('narrative:stateChanged', (p) => trace.add({
    type: 'narrative', phase: 'change',
    label: `${String(p?.graphId ?? 'unknown')}: ${String(p?.from ?? '?')} -> ${String(p?.to ?? '?')}`,
    payload: payloadRecord(p),
  }));

  trace.listen('dialogue:start', (p) => trace.add({
    type: 'dialogue', phase: 'start', label: String(p?.graphId ?? p?.npcName ?? 'unknown'), payload: payloadRecord(p),
  }));
  trace.listen('dialogue:line', (p) => trace.add({
    type: 'dialogue', phase: 'info', label: `line ${String(p?.speaker ?? '')}`, payload: payloadRecord(p),
  }));
  trace.listen('dialogue:choices', (p) => trace.add({
    type: 'dialogue', phase: 'block', label: `choices ${Array.isArray(p) ? p.length : '?'}`, payload: { choices: p },
  }));
  trace.listen('dialogue:choiceSelected:log', (p) => trace.add({
    type: 'dialogue', phase: 'match', label: `choice ${String(p?.index ?? '?')}`, payload: payloadRecord(p),
  }));
  trace.listen('dialogue:end', (p) => trace.add({
    type: 'dialogue', phase: 'end', label: 'dialogue ended', payload: payloadRecord(p),
  }));

  trace.listen('scene:changed', (p) => trace.add({
    type: 'scene', phase: 'change', label: String(p?.sceneId ?? p?.id ?? 'unknown'), payload: payloadRecord(p),
  }));
  trace.listen('scenario:stateChanged', (p) => trace.add({
    type: 'scenario', phase: 'change', label: String(p?.scenarioId ?? p?.id ?? 'unknown'), payload: payloadRecord(p),
  }));

  try {
    (window as any).__GAME_RUNTIME_TRACE__ = trace;
  } catch {
    // ignore non-browser execution
  }

  return trace;
}
